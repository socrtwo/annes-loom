/**
 * Page Templates (.dwt) with editable regions, and Library Items (.lbi).
 *
 * Builds on site/templates.ts (both marker dialects). This module adds what a full template workflow
 * needs on top of it:
 *   - template parameters: TemplateParam in the template, InstanceParam in pages, @@(name)@@ expressions
 *     (also used by editable attributes);
 *   - optional regions: TemplateBeginIf cond="…" … TemplateEndIf, shown or left out per page;
 *   - repeating regions: TemplateBeginRepeat name="…" … TemplateEndRepeat, with any number of entries per
 *     page (InstanceBeginRepeat / InstanceBeginRepeatEntry markers);
 *   - nested templates (instance dialect): a template attached to another template;
 * and the commands: attach, detach, update, manage and check regions, make templates, library items.
 *
 * Limitations: repeating regions cannot be nested in each other, and optional and repeating regions are
 * evaluated by QuillLoom (other editors that only know the "begin" dialect ignore those markers).
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog, alertDialog, promptDialog, setListOptions } from '../ui/dialog';
import { h, download } from '../ui/dom';
import { view, isPage, inCode, mutate, selectionHtml, selectionText, selectedEl } from '../editor/ops';
import { cacheFor } from '../editor/workspace';
import { rewriteDom } from '../editor/resources';
import {
  applyTemplate, detachTemplate, pagesUsing, attachedTemplate, isTemplatePath, templateRegions, pageRegions,
  dialectOf, makeRegionMarkup, pageToTemplate, libraryItemMarkup, updateLibraryItems, type Dialect,
} from '../site/templates';
import type { Site } from '../model/site';
import { rewriteRefs } from '../model/site';
import { relativeRef, slugify, baseName, stripExt, joinPath } from '../model/paths';
import { esc, escAttr, getTitle } from '../model/html';

// ------------------------------------------------------------------------------------------
// Template parameters

export interface TParam { name: string; type: string; value: string }

const attrsOf = (s: string): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) o[m[1].toLowerCase()] = m[2];
  return o;
};

function paramsBy(src: string, kind: 'TemplateParam' | 'InstanceParam'): TParam[] {
  const out: TParam[] = [];
  for (const m of src.matchAll(new RegExp(`<!--\\s*${kind}\\b([^>]*?)-->`, 'gi'))) {
    const a = attrsOf(m[1]);
    if (a.name) out.push({ name: a.name, type: a.type || 'text', value: a.value ?? '' });
  }
  return out;
}
export const templateParams = (src: string) => paramsBy(src, 'TemplateParam');
export const instanceParams = (src: string) => paramsBy(src, 'InstanceParam');

const paramMarkup = (kind: string, p: TParam) => `<!-- ${kind} name="${escAttr(p.name)}" type="${escAttr(p.type)}" value="${escAttr(p.value)}" -->`;

function putParams(src: string, kind: 'TemplateParam' | 'InstanceParam', params: TParam[]): string {
  let out = src.replace(new RegExp(`[ \\t]*<!--\\s*${kind}\\b[^>]*?-->[ \\t]*\\n?`, 'gi'), '');
  if (!params.length) return out;
  const block = params.map((p) => paramMarkup(kind, p)).join('\n');
  const hc = out.search(/<\/head\s*>/i);
  if (hc >= 0) return out.slice(0, hc) + block + '\n' + out.slice(hc);
  const ho = /<html[^>]*>/i.exec(out);
  if (ho) return out.slice(0, ho.index + ho[0].length) + block + out.slice(ho.index + ho[0].length);
  return block + '\n' + out;
}
export const setTemplateParams = (src: string, p: TParam[]) => putParams(src, 'TemplateParam', p);
export const setInstanceParams = (src: string, p: TParam[]) => putParams(src, 'InstanceParam', p);

/** Evaluates a template condition or expression against parameter values. */
export function evalExpr(expr: string, vals: Record<string, string>): string {
  expr = expr.trim();
  const tern = /^(.+?)\?\s*(["'])(.*?)\2\s*:\s*(["'])(.*?)\4\s*$/.exec(expr);
  if (tern) return truthy(evalExpr(tern[1], vals)) ? tern[3] : tern[5];
  if (expr.includes('||')) return String(expr.split('||').some((x) => truthy(evalExpr(x, vals))));
  if (expr.includes('&&')) return String(expr.split('&&').every((x) => truthy(evalExpr(x, vals))));
  const cmp = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(expr);
  if (cmp) { const eq = evalExpr(cmp[1], vals) === evalExpr(cmp[3], vals); return String(cmp[2] === '==' ? eq : !eq); }
  if (expr.startsWith('!')) return String(!truthy(evalExpr(expr.slice(1), vals)));
  if (expr.startsWith('(') && expr.endsWith(')')) return evalExpr(expr.slice(1, -1), vals);
  const q = /^(["'])(.*)\1$/.exec(expr);
  if (q) return q[2];
  const name = /^_document\[['"](.+)['"]\]$/.exec(expr)?.[1] || expr;
  return vals[name] ?? (/^-?\d+(\.\d+)?$/.test(name) || /^(true|false)$/.test(name) ? name : '');
}
const truthy = (v: string) => !!v && v !== 'false' && v !== '0';

// ------------------------------------------------------------------------------------------
// Optional and repeating regions, applied before the base applyTemplate

const IF_RE = /<!--\s*TemplateBeginIf\s+cond="([^"]*)"\s*-->((?:(?!<!--\s*TemplateBeginIf)[\s\S])*?)<!--\s*TemplateEndIf\s*-->/i;
const MULTI_IF_RE = /<!--\s*TemplateBeginMultipleIf\s*-->([\s\S]*?)<!--\s*TemplateEndMultipleIf\s*-->/i;
const T_REPEAT = /<!--\s*TemplateBeginRepeat\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndRepeat\s*-->/gi;
const I_REPEAT = /<!--\s*InstanceBeginRepeat\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*InstanceEndRepeat\s*-->/gi;
const I_ENTRY = /<!--\s*InstanceBeginRepeatEntry\s*-->([\s\S]*?)<!--\s*InstanceEndRepeatEntry\s*-->/gi;
const SEP = '\u0001';

/** Region markers in `s` get a per-entry suffix so applyTemplate sees unique names. */
function tagRegions(s: string, i: number): string {
  return s.replace(/(<!--\s*(?:#BeginEditable\s+"|(?:Template|Instance)BeginEditable\s+name="))([^"]+)"/gi, (m, a, n) => `${a}${n}${SEP}${i}"`);
}

function evaluateTemplate(tsrc: string, vals: Record<string, string>): string {
  let s = tsrc;
  for (let guard = 0; guard < 500; guard++) {
    const m = IF_RE.exec(s);
    if (!m) break;
    s = s.slice(0, m.index) + (truthy(evalExpr(m[1], vals)) ? m[2] : '') + s.slice(m.index + m[0].length);
  }
  for (let guard = 0; guard < 100; guard++) {
    const m = MULTI_IF_RE.exec(s);
    if (!m) break;
    let chosen = '';
    for (const c of m[1].matchAll(/<!--\s*TemplateBeginIfClause\s+cond="([^"]*)"\s*-->([\s\S]*?)<!--\s*TemplateEndIfClause\s*-->/gi)) {
      if (truthy(evalExpr(c[1], vals))) { chosen = c[2]; break; }
    }
    s = s.slice(0, m.index) + chosen + s.slice(m.index + m[0].length);
  }
  // Expressions: @@(name)@@ and the parameter syntax of attributes.
  return s.replace(/@@\(([\s\S]*?)\)@@/g, (m, e) => esc(evalExpr(e, vals)));
}

/**
 * Applies a template like applyTemplate() and, in addition, evaluates template parameters, optional
 * regions and repeating regions, and handles nested templates. Use this for every update.
 */
export function applyTemplateFull(site: Site, templatePath: string, pageSrc: string, pagePath: string, mapping: Record<string, string> = {}): string {
  let tsrc = site.read(templatePath);
  if (tsrc == null) throw new Error(`Template ${templatePath} is missing.`);
  // A nested template carries the markers of its own parent template; to its pages those are fixed text.
  if (attachedTemplate(tsrc, templatePath) && dialectOf(tsrc) === 'instance') {
    tsrc = tsrc.replace(/<!--\s*(?:InstanceBegin\s+template="[^"]*"[^>]*?|InstanceEnd|InstanceBeginEditable\s+name="[^"]*"|InstanceEndEditable|InstanceParam\b[^>]*?)\s*-->/gi, '');
  }
  const tparams = templateParams(tsrc);
  const pvals = new Map(instanceParams(pageSrc).map((p) => [p.name, p.value]));
  const params = tparams.map((p) => ({ ...p, value: pvals.get(p.name) ?? p.value }));
  const vals: Record<string, string> = Object.fromEntries(params.map((p) => [p.name, p.value]));
  let t = evaluateTemplate(tsrc, vals);

  // Repeating regions: one copy of the repeated markup per entry the page has (at least one).
  const pageRepeats = new Map<string, string[]>();
  for (const m of pageSrc.matchAll(I_REPEAT)) pageRepeats.set(m[1], [...m[2].matchAll(I_ENTRY)].map((e) => e[1]));
  let page = pageSrc;
  let hasRepeats = false;
  t = t.replace(T_REPEAT, (m, name: string, inner: string) => {
    hasRepeats = true;
    const n = Math.max(1, pageRepeats.get(name)?.length ?? 1);
    let out = `<!-- InstanceBeginRepeat name="${name}" -->`;
    for (let i = 0; i < n; i++) out += `<!-- InstanceBeginRepeatEntry -->${tagRegions(inner, i)}<!-- InstanceEndRepeatEntry -->`;
    return out + '<!-- InstanceEndRepeat -->';
  });
  if (hasRepeats) {
    page = page.replace(I_REPEAT, (m, name: string, inner: string) => {
      let i = 0;
      return `<!-- InstanceBeginRepeat name="${name}" -->${inner.replace(I_ENTRY, (e, body: string) => `<!-- InstanceBeginRepeatEntry -->${tagRegions(body, i++)}<!-- InstanceEndRepeatEntry -->`)}<!-- InstanceEndRepeat -->`;
    });
  }
  const proxy = { read: (p: string) => (p === templatePath ? t : site.read(p)) } as unknown as Site;
  let out = applyTemplate(proxy, templatePath, page, pagePath, mapping);
  if (hasRepeats) out = out.replace(new RegExp(`${SEP}\\d+"`, 'g'), '"');
  if (params.length) out = setInstanceParams(out, params);
  return out;
}

/** Pages of a template, then the pages of templates nested in it. Writes through `write`. */
export function updateTemplatePages(site: Site, templatePath: string, write: (path: string, text: string) => void = (p, t) => site.write(p, t), seen = new Set<string>()): string[] {
  if (seen.has(templatePath)) return [];
  seen.add(templatePath);
  const changed: string[] = [];
  for (const p of pagesUsing(site, templatePath)) {
    const src = site.read(p)!;
    const out = applyTemplateFull(site, templatePath, src, p);
    if (out !== src) { write(p, out); changed.push(p); }
    if (isTemplatePath(p)) changed.push(...updateTemplatePages(site, p, write, seen));
  }
  return changed;
}

// ------------------------------------------------------------------------------------------
// Region editing helpers

export function renameRegion(src: string, from: string, to: string): string {
  const f = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return src.replace(new RegExp(`(<!--\\s*(?:#BeginEditable\\s+"|(?:Template|Instance)BeginEditable\\s+name="))${f}(")`, 'g'), `$1${to.replace(/\$/g, '$$$$')}$2`);
}

/** Removes one editable region's markers (template or page), keeping its content. */
export function removeRegion(src: string, name: string, template = true): string {
  const r = (template ? templateRegions(src) : pageRegions(src)).find((x) => x.name === name);
  if (!r) return src;
  return src.slice(0, r.start) + r.content + src.slice(r.end);
}

/** Removes every template marker of a template file (the .dwt becomes an ordinary page). */
export function stripTemplateMarkup(src: string): string {
  const vals = Object.fromEntries(templateParams(src).map((p) => [p.name, p.value]));
  let s = evaluateTemplate(src, vals);
  s = s.replace(/<!--\s*(?:#BeginEditable\s+"[^"]*"|#EndEditable|TemplateBeginEditable\s+name="[^"]*"|TemplateEndEditable|TemplateBeginRepeat\s+name="[^"]*"|TemplateEndRepeat|TemplateParam\b[^>]*?|TemplateInfo\b[^>]*?|TemplateBeginIf\s+cond="[^"]*"|TemplateEndIf)\s*-->/gi, '');
  return s;
}

/** Removes every template, repeat, parameter and library item marker from a page, keeping the content. */
export function stripPageMarkup(src: string): string {
  return detachTemplate(src).replace(/<!--\s*(?:InstanceBeginRepeat\s+name="[^"]*"|InstanceEndRepeat|InstanceBeginRepeatEntry|InstanceEndRepeatEntry|#BeginLibraryItem\s+"[^"]*"|#EndLibraryItem)\s*-->/gi, '');
}

export interface SyntaxIssue { line: number; message: string; level: 'error' | 'warning' }

const lineAt = (src: string, i: number) => src.slice(0, i).split('\n').length;

/** Checks the region markers of a template or an attached page. */
export function checkTemplateSyntax(src: string, isTemplate: boolean): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  const re = isTemplate
    ? /<!--\s*(#BeginEditable\s+"([^"]*)"|TemplateBeginEditable\s+name="([^"]*)"|#EndEditable|TemplateEndEditable|TemplateBeginIf\s+cond="[^"]*"|TemplateEndIf|TemplateBeginRepeat\s+name="([^"]*)"|TemplateEndRepeat)\s*-->/gi
    : /<!--\s*(#BeginEditable\s+"([^"]*)"|InstanceBeginEditable\s+name="([^"]*)"|#EndEditable|InstanceEndEditable|InstanceBeginRepeat\s+name="([^"]*)"|InstanceEndRepeat)\s*-->/gi;
  const stack: { kind: 'edit' | 'if' | 'repeat'; name: string; line: number }[] = [];
  const names = new Map<string, number>();
  const repeatNames = new Set<string>();
  let begins = 0, beginStyle = 0, instStyle = 0;
  for (const m of src.matchAll(re)) {
    const tok = m[1];
    const line = lineAt(src, m.index!);
    const inRepeat = stack.some((s) => s.kind === 'repeat');
    if (/^(#BeginEditable|TemplateBeginEditable|InstanceBeginEditable)/i.test(tok)) {
      const name = m[2] ?? m[3] ?? '';
      begins++;
      if (/^#/.test(tok)) beginStyle++; else instStyle++;
      const open = stack.find((s) => s.kind === 'edit');
      if (open) issues.push({ line, level: 'error', message: `Editable region "${name}" starts inside editable region "${open.name}" (line ${open.line}). Regions cannot be nested.` });
      if (!name.trim()) issues.push({ line, level: 'error', message: 'An editable region has no name.' });
      else if (/["'&<>]/.test(name)) issues.push({ line, level: 'error', message: `The region name "${name}" contains a character that is not allowed (" ' & < >).` });
      if (!inRepeat && name) {
        if (names.has(name)) issues.push({ line, level: 'error', message: `Two editable regions are named "${name}" (lines ${names.get(name)} and ${line}).` });
        else names.set(name, line);
      }
      stack.push({ kind: 'edit', name, line });
    } else if (/^(#EndEditable|TemplateEndEditable|InstanceEndEditable)/i.test(tok)) {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'edit') {
        if (top) issues.push({ line, level: 'error', message: `The end of an editable region at line ${line} closes before the ${top.kind === 'if' ? 'optional' : 'repeating'} region opened at line ${top.line}.` });
        else issues.push({ line, level: 'error', message: `The end of an editable region at line ${line} has no matching beginning.` });
        const at = stack.map((s) => s.kind).lastIndexOf('edit');
        if (at >= 0) stack.splice(at, 1);
      } else stack.pop();
    } else if (/^TemplateBeginIf/i.test(tok)) {
      if (stack.some((s) => s.kind === 'edit')) issues.push({ line, level: 'error', message: 'An optional region starts inside an editable region; put the editable region inside the optional one.' });
      stack.push({ kind: 'if', name: '', line });
    } else if (/^TemplateEndIf/i.test(tok)) {
      const top = stack[stack.length - 1];
      if (top?.kind === 'if') stack.pop(); else issues.push({ line, level: 'error', message: `The end of an optional region at line ${line} does not match ${top ? `the region opened at line ${top.line}` : 'a beginning'}.` });
    } else if (/^(Template|Instance)BeginRepeat/i.test(tok)) {
      const name = m[4] ?? '';
      if (stack.some((s) => s.kind === 'edit')) issues.push({ line, level: 'error', message: `Repeating region "${name}" starts inside an editable region.` });
      if (inRepeat) issues.push({ line, level: 'warning', message: `Repeating region "${name}" is inside another repeating region; QuillLoom does not repeat nested regions.` });
      if (repeatNames.has(name)) issues.push({ line, level: 'error', message: `Two repeating regions are named "${name}".` });
      repeatNames.add(name);
      stack.push({ kind: 'repeat', name, line });
    } else if (/^(Template|Instance)EndRepeat/i.test(tok)) {
      const top = stack[stack.length - 1];
      if (top?.kind === 'repeat') stack.pop(); else issues.push({ line, level: 'error', message: `The end of a repeating region at line ${line} does not match ${top ? `the region opened at line ${top.line}` : 'a beginning'}.` });
    }
  }
  for (const s of stack) issues.push({ line: s.line, level: 'error', message: `${s.kind === 'edit' ? `Editable region "${s.name}"` : s.kind === 'if' ? 'An optional region' : `Repeating region "${s.name}"`} (line ${s.line}) is never closed.` });
  if (isTemplate && !begins) issues.push({ line: 1, level: 'warning', message: 'The template has no editable regions, so pages attached to it cannot be edited.' });
  if (isTemplate && beginStyle && instStyle) issues.push({ line: 1, level: 'warning', message: 'The template mixes the two marker styles (#BeginEditable and TemplateBeginEditable). Use one.' });
  // Region markers inside a tag break the page.
  for (const m of src.matchAll(/<[a-z][^<>]*<!--\s*(?:#BeginEditable|TemplateBeginEditable|InstanceBeginEditable)/gi)) issues.push({ line: lineAt(src, m.index!), level: 'error', message: 'A region marker is inside a tag. Put region markers between tags.' });
  if (!isTemplate) {
    for (const m of src.matchAll(/<!--\s*TemplateBeginEditable/gi)) issues.push({ line: lineAt(src, m.index!), level: 'warning', message: 'This page contains template markers (TemplateBeginEditable); only templates (.dwt) should.' });
  }
  return issues.sort((a, b) => a.line - b.line);
}

/** Free region name like "EditRegion3". */
function freeName(src: string, base: string): string {
  const used = new Set([...src.matchAll(/name="([^"]+)"|#BeginEditable\s+"([^"]+)"|cond="([^"]+)"/g)].map((m) => m[1] || m[2] || m[3]));
  for (let i = 1; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

const validName = (s: string) => /^[^"'&<>]+$/.test(s.trim());

/** The marker style for a new region: the file's own, else the style the site's templates use, else "begin". */
function dialectFor(app: App, src: string): Dialect {
  if (/#BeginEditable|TemplateBeginEditable|TemplateBeginRepeat|TemplateBeginIf/.test(src)) return dialectOf(src);
  const other = app.site.list((f) => isTemplatePath(f.path) && f.path !== app.active?.path).find((f) => templateRegions(f.text || '').length);
  return other ? dialectOf(other.text || '') : 'begin';
}

const beginM = (d: Dialect, name: string) => (d === 'begin' ? `<!-- #BeginEditable "${name}" -->` : `<!-- TemplateBeginEditable name="${name}" -->`);
const endM = (d: Dialect) => (d === 'begin' ? '<!-- #EndEditable -->' : '<!-- TemplateEndEditable -->');

function commentOf(doc: Document, marker: string): Comment {
  return doc.createComment(marker.replace(/^<!--/, '').replace(/-->$/, ''));
}

function designReady(app: App): boolean {
  const v = view(app);
  if (v?.design?.doc && (v.tab.view === 'design' || v.tab.view === 'split')) return true;
  mutate(app, () => undefined);
  return false;
}

/**
 * Wraps the selection in marker comments (outermost first) or, with nothing selected, inserts the markers
 * around `placeholder` at the cursor. In Code view this inserts text; in Design view comment nodes.
 */
function wrapInMarkers(app: App, begins: string[], ends: string[], placeholder: string): boolean {
  const v = view(app);
  if (!v) return false;
  if (inCode(app)) {
    const sel = v.code?.selection.text || '';
    v.code?.replaceSelection(begins.join('') + (sel || esc(placeholder)) + [...ends].reverse().join(''));
    v.flush();
    return true;
  }
  if (!designReady(app)) return false;
  return mutate(app, (doc) => {
    const d = v.design!;
    let r = d.restoreRange();
    if (!r || !doc.body.contains(r.commonAncestorContainer)) { r = doc.createRange(); r.selectNodeContents(doc.body); r.collapse(false); }
    const content: Node = r.collapsed ? doc.createTextNode(placeholder) : r.extractContents();
    const endNodes = [...ends].reverse().map((e) => commentOf(doc, e));
    for (const e of [...endNodes].reverse()) r.insertNode(e);
    r.insertNode(content);
    for (const b of [...begins].reverse()) r.insertNode(commentOf(doc, b));
  });
}

/** Inserts markup (with comments) at the cursor without the browser's insertHTML, which may drop comments. */
function insertFragment(app: App, html: string): boolean {
  const v = view(app);
  if (!v) return false;
  if (inCode(app)) { v.code?.replaceSelection(html); v.flush(); return true; }
  if (!designReady(app)) return false;
  return mutate(app, (doc) => {
    const tmp = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    rewriteDom(tmp, app.active.path, cacheFor(app), 'blob', true);
    const frag = doc.createDocumentFragment();
    for (const n of [...tmp.body.childNodes]) frag.appendChild(doc.importNode(n, true));
    let r = v.design!.restoreRange();
    if (!r || !doc.body.contains(r.commonAncestorContainer)) { r = doc.createRange(); r.selectNodeContents(doc.body); r.collapse(false); }
    r.deleteContents();
    r.insertNode(frag);
  });
}

// ------------------------------------------------------------------------------------------
// Site helpers

const templatesIn = (app: App) => app.site.list((f) => isTemplatePath(f.path)).map((f) => f.path);
const libraryItems = (app: App) => app.site.list((f) => /\.lbi$/i.test(f.path)).map((f) => f.path);
const ordinaryPages = (app: App) => app.site.pages().filter((f) => !/\.(dwt|lbi)$/i.test(f.path)).map((f) => f.path);

function flushAll(app: App): void { for (const d of app.docs) d.ui?.flush(); }

/** Writes a page: through its tab (one undo step there) when it is open, else directly to the site. */
function writePage(app: App, path: string, text: string, label: string): void {
  const tab = app.docs.find((d) => d.path === path);
  if (tab) app.editSource(label, () => text, tab);
  else app.site.write(path, text);
}

/** The template that the active file is, or that the active page is attached to. */
function contextTemplate(app: App): string | null {
  const t = app.active;
  if (!t) return null;
  if (isTemplatePath(t.path)) return t.path;
  const a = attachedTemplate(t.source, t.path);
  return a && app.site.has(a) ? a : null;
}

const attachedOf = (app: App) => { const t = app.active; return t && t.kind === 'page' ? attachedTemplate(t.source, t.path) : null; };
const isAttached = (app: App) => isPage(app) && !!attachedOf(app);
const isDwt = (app: App) => isPage(app) && isTemplatePath(app.active.path);

async function pickTemplate(app: App, title: string, current?: string | null): Promise<string | null> {
  const list = templatesIn(app);
  if (!list.length) { await alertDialog(title, 'This site has no page templates (.dwt files) yet.\nOpen a page and use Save as Page Template to make one.'); return null; }
  if (list.length === 1 && !current) return list[0];
  const v = await openDialog({ title, fields: [{ key: 't', label: 'Page template', type: 'list', rows: Math.min(10, list.length + 1), value: current && list.includes(current) ? current : list[0], options: list }] });
  return v?.t ?? null;
}

/** Updates a template's pages (and nested templates' pages) and reports. */
async function updateTemplate(app: App, tpl: string, quiet = false): Promise<string[]> {
  flushAll(app);
  const errors: string[] = [];
  const changed = updateTemplatePages(app.site, tpl, (p, text) => {
    try { writePage(app, p, text, 'Update from Template'); } catch (e) { errors.push(`${p}: ${(e as Error).message}`); }
  });
  if (!quiet) {
    const n = pagesUsing(app.site, tpl).length;
    if (errors.length) await alertDialog('Update Pages', `Some pages could not be updated:\n${errors.join('\n')}`);
    else toast(n ? `${tpl}: updated ${changed.length} of ${n} attached page${n > 1 ? 's' : ''}${changed.length ? '' : ' (all were up to date)'}.` : `No pages are attached to ${tpl}.`, { ms: 4500 });
  }
  return changed;
}

/** Asks how region names of pages map to the template's regions, when they differ. */
async function regionMapping(app: App, tpl: string, pages: string[]): Promise<Record<string, string> | null> {
  const tnames = templateRegions(app.site.read(tpl) || '').map((r) => r.name);
  const unmatched = new Set<string>();
  for (const p of pages) for (const r of pageRegions(app.site.read(p) || '')) if (!tnames.includes(r.name) && !r.name.includes(SEP)) unmatched.add(r.name);
  if (!unmatched.size) return {};
  const v = await openDialog({
    title: 'Match Editable Regions',
    help: `The page${pages.length > 1 ? 's have' : ' has'} regions that ${tpl} does not. Choose the template region that gets each one's content, or leave the content out.`,
    fields: [...unmatched].map((n) => ({ key: `m_${n}`, label: `Page region "${n}" goes to`, type: 'select' as const, value: tnames.find((t) => t.toLowerCase() === n.toLowerCase()) || (/body|content|main/i.test(n) ? tnames.find((t) => /body|content|main/i.test(t)) : '') || '', options: [{ value: '', label: '(leave the content out)' }, ...tnames.map((t) => ({ value: t, label: t }))] })),
  });
  if (!v) return null;
  const mapping: Record<string, string> = {};
  for (const n of unmatched) if (v[`m_${n}`]) mapping[n] = v[`m_${n}`];
  return mapping;
}

/** Library item pairs (as comment nodes) in a Design view document. */
function libraryComments(doc: Document): { begin: Comment; end: Comment; ref: string }[] {
  const out: { begin: Comment; end: Comment; ref: string }[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  let open: { begin: Comment; ref: string } | null = null;
  for (let n = walker.nextNode() as Comment | null; n; n = walker.nextNode() as Comment | null) {
    const m = /^\s*#BeginLibraryItem\s+"([^"]+)"\s*$/.exec(n.data);
    if (m) { open = { begin: n, ref: m[1] }; continue; }
    if (open && /^\s*#EndLibraryItem\s*$/.test(n.data)) { out.push({ ...open, end: n }); open = null; }
  }
  return out;
}

async function makeTemplateFrom(app: App, label: string, arg?: { name: string; dialect?: Dialect; attach?: boolean }): Promise<void> {
  const tab = app.active;
  tab.ui.flush();
  const src = tab.source;
  const title = getTitle(src) || stripExt(baseName(tab.path));
  const existingDialect = templatesIn(app).map((p) => app.site.read(p) || '').find((t) => templateRegions(t).length);
  const v = arg || await openDialog({
    title: label,
    help: 'The page title and body become editable regions. Everything else is fixed in pages made from the template.',
    fields: [
      { key: 'name', label: 'Template name', type: 'text', value: slugify(title) || 'main', suffix: '.dwt', autofocus: true },
      { key: 'dialect', label: 'Region markers', type: 'radio', value: existingDialect ? dialectOf(existingDialect) : 'begin', options: [{ value: 'begin', label: 'Expression Web / FrontPage style (#BeginEditable)' }, { value: 'instance', label: 'Dreamweaver style (TemplateBeginEditable; supports nested, optional and repeating regions)' }] },
      { key: 'attach', label: 'Attach this page to the new template', type: 'checkbox', value: false },
    ],
    validate: (x) => (slugify(x.name) ? null : 'Type a name.'),
  });
  if (!v) return;
  const path = joinPath('Templates', `${slugify(v.name)}.dwt`);
  if (app.site.has(path) && !await confirmDialog(label, `${path} already exists. Replace it? Pages attached to it keep their content and are updated.`, 'Replace')) return;
  const relinked = rewriteRefs(src, tab.path, (target) => relativeRef(path, target));
  const dwt = pageToTemplate(relinked, v.dialect || 'begin');
  const replacing = app.site.has(path);
  app.site.write(path, dwt);
  if (replacing) await updateTemplate(app, path, true);
  if (v.attach) {
    const out = applyTemplateFull(app.site, path, tab.source, tab.path);
    app.editSource('Attach Page Template', () => out, tab);
    app.site.data.templates[tab.path] = path;
  }
  app.openFile(path);
  toast(`Saved the page template ${path}.`);
}

// ------------------------------------------------------------------------------------------
// Commands

const tpl = { tab: 'Template', edits: true } as const;
const dsn = { tab: 'Design', group: 'Page Templates', edits: true } as const;
const lib = { tab: 'Design', group: 'Library Items', edits: true } as const;

def([
  {
    id: 'template.attach', label: 'Attach Page Template…', icon: 'dashboard', ...dsn, origin: 'Expression Web, Dreamweaver (Apply Template to Page)', isEnabled: isPage,
    tip: 'Attach the current page, every page or chosen pages to a page template.',
    run: async (app, arg?: { template: string; scope?: 'current' | 'all' | 'selected'; pages?: string[]; mapping?: Record<string, string> }) => {
      flushAll(app);
      let template = arg?.template, scope = arg?.scope || 'current', pages = arg?.pages;
      if (!template) {
        const list = templatesIn(app);
        if (!list.length) { await alertDialog('Attach Page Template', 'This site has no page templates (.dwt files) yet.\nOpen a page and use Save as Page Template to make one.'); return; }
        const cur = isTemplatePath(app.active.path) ? null : app.active.path;
        const v = await openDialog({
          title: 'Attach Page Template', wide: true,
          fields: [
            { key: 'template', label: 'Page template', type: 'list', rows: Math.min(8, list.length + 1), value: attachedOf(app) || list[0], options: list },
            { key: 'scope', label: 'Attach', type: 'radio', value: cur ? 'current' : 'selected', options: [...(cur ? [{ value: 'current', label: `The current page (${cur})` }] : []), { value: 'all', label: 'All pages of the site' }, { value: 'selected', label: 'Selected pages' }] },
            { key: 'pages', label: 'Pages (Ctrl+click or Shift+click to choose several)', type: 'list', multiple: true, rows: 10, value: cur ? [cur] : [], options: ordinaryPages(app), visibleIf: (x) => x.scope === 'selected' },
          ],
        });
        if (!v) return;
        template = v.template; scope = v.scope; pages = v.pages;
      }
      const targets = scope === 'current' ? [app.active.path] : scope === 'all' ? ordinaryPages(app) : (pages || []);
      if (!targets.length) { toast('Choose at least one page.'); return; }
      if (!app.site.has(template!)) { toast(`${template} is not in the site.`); return; }
      const mapping = arg?.mapping ?? await regionMapping(app, template!, targets);
      if (!mapping) return;
      let n = 0;
      for (const p of targets) {
        if (p === template) continue;
        const src = app.site.read(p);
        if (src == null) continue;
        const out = applyTemplateFull(app.site, template!, src, p, mapping);
        if (out !== src) { writePage(app, p, out, 'Attach Page Template'); n++; }
        app.site.data.templates[p] = template!;
      }
      app.site.touchMeta();
      toast(`Attached ${n} page${n === 1 ? '' : 's'} to ${template}.`);
    },
  },
  {
    id: 'template.detach', label: 'Detach from Page Template', icon: 'link_off', ...dsn, origin: 'Expression Web, Dreamweaver', isEnabled: isAttached,
    tip: 'Keep the page as it looks now, without the template link and region markers.',
    run: (app) => {
      const path = app.active.path;
      app.editSource('Detach from Page Template', (src) => detachTemplate(src).replace(/[ \t]*<!--\s*InstanceParam\b[^>]*?-->[ \t]*\n?/gi, ''));
      delete app.site.data.templates[path];
      app.site.touchMeta();
    },
  },
  {
    id: 'template.openAttached', label: 'Open Attached Page Template', icon: 'open_in_new', ...dsn, edits: false, noRecord: true, origin: 'Expression Web, Dreamweaver', isEnabled: isAttached,
    run: (app) => { const t = attachedOf(app); if (t && app.site.has(t)) app.openFile(t); else toast(`The template ${t} is not in the site.`); },
  },
  {
    id: 'template.updatePage', label: 'Update Current Page', icon: 'sync', ...dsn, origin: 'Dreamweaver, Expression Web', isEnabled: (app) => isAttached(app) || (isPage(app) && /#BeginLibraryItem/.test(app.active.source)),
    tip: 'Bring the page up to date with its page template and library items.',
    run: (app) => {
      const t = attachedOf(app);
      if (t && !app.site.has(t)) { toast(`The template ${t} is not in the site.`); return; }
      const changed = app.editSource('Update Current Page', (src) => {
        let out = t ? applyTemplateFull(app.site, t, src, app.active.path) : src;
        out = updateLibraryItems(app.site, app.active.path, out);
        return out;
      });
      toast(changed ? 'The page was updated.' : 'The page is up to date.');
    },
  },
  {
    id: 'template.updateAll', label: 'Update Attached Pages', icon: 'sync_alt', ...dsn, origin: 'Expression Web, Dreamweaver', isEnabled: (app) => templatesIn(app).length > 0,
    tip: 'Apply a template\'s changes to every page attached to it (nested templates and their pages too).',
    run: async (app, arg?: string) => {
      let t = typeof arg === 'string' ? arg : contextTemplate(app);
      if (!t) {
        const list = templatesIn(app);
        if (list.length > 1) {
          const v = await openDialog({ title: 'Update Attached Pages', fields: [{ key: 't', label: 'Update the pages of', type: 'list', rows: 8, value: '__all', options: [{ value: '__all', label: 'Every page template' }, ...list] }] });
          if (!v) return;
          t = v.t;
        } else t = list[0];
      }
      if (t === '__all') {
        let total = 0;
        for (const x of templatesIn(app)) total += (await updateTemplate(app, x, true)).length;
        toast(`Updated ${total} page${total === 1 ? '' : 's'}.`);
        return;
      }
      if (!t || !app.site.has(t)) { toast(`${t} is not in the site.`); return; }
      await updateTemplate(app, t);
    },
  },
  {
    id: 'template.updatePages', label: 'Update Pages…', icon: 'published_with_changes', ...dsn, origin: 'Dreamweaver', isEnabled: (app) => templatesIn(app).length > 0 || libraryItems(app).length > 0,
    tip: 'Choose attached pages to update from their templates and library items.',
    run: async (app, arg?: { pages: string[]; library?: boolean }) => {
      flushAll(app);
      const attached = app.site.pages().map((f) => ({ path: f.path, tpl: attachedTemplate(f.text || '', f.path) })).filter((x) => x.tpl || /#BeginLibraryItem/.test(app.site.read(x.path) || ''));
      if (!attached.length) { toast('No pages use page templates or library items.'); return; }
      const v = arg || await openDialog({
        title: 'Update Pages', wide: true,
        fields: [
          { key: 'pages', label: 'Pages', type: 'list', multiple: true, rows: 12, value: attached.map((x) => x.path), options: attached.map((x) => ({ value: x.path, label: x.tpl ? `${x.path}  —  ${x.tpl}` : `${x.path}  —  library items` })) },
          { key: 'library', label: 'Also update library items', type: 'checkbox', value: true },
        ],
      });
      if (!v) return;
      let n = 0;
      const missing: string[] = [];
      for (const p of v.pages as string[]) {
        const src = app.site.read(p);
        if (src == null) continue;
        const t = attachedTemplate(src, p);
        let out = src;
        if (t) { if (app.site.has(t)) out = applyTemplateFull(app.site, t, src, p); else missing.push(t); }
        if (v.library !== false) out = updateLibraryItems(app.site, p, out);
        if (out !== src) { writePage(app, p, out, 'Update Pages'); n++; }
      }
      toast(`Updated ${n} page${n === 1 ? '' : 's'}.${missing.length ? ` Missing templates: ${[...new Set(missing)].join(', ')}.` : ''}`, { ms: 5000 });
    },
  },
  {
    id: 'template.manageRegions', label: 'Manage Editable Regions…', icon: 'edit_square', ...tpl, group: 'Regions', origin: 'Expression Web', isEnabled: isDwt,
    run: async (app) => {
      const tab = app.active;
      tab.ui.flush();
      const opts = () => templateRegions(tab.source).map((r) => ({ value: r.name, label: `${r.name}  (line ${lineAt(tab.source, r.start)})` }));
      if (!opts().length && !await confirmDialog('Manage Editable Regions', 'This template has no editable regions yet. Add one at the cursor?', 'Add Region')) return;
      if (!opts().length) { await app.exec('template.editableRegion'); return; }
      let goto: string | null = null;
      let add = false;
      await openDialog({
        title: 'Manage Editable Regions', ok: 'Close', cancel: false,
        fields: [{ key: 'list', label: 'Editable regions', type: 'list', rows: 10, value: opts()[0]?.value, options: opts() }],
        buttons: [
          { label: 'Add…', onClick: (_v, ctl) => { add = true; ctl.close({}); } },
          {
            label: 'Rename…', onClick: async (v, ctl) => {
              if (!v.list) return;
              const to = await promptDialog('Rename Editable Region', 'New name', v.list);
              if (!to || to === v.list) return;
              if (!validName(to)) { toast('Region names cannot contain " \' & < or >.'); return; }
              if (templateRegions(tab.source).some((r) => r.name === to)) { toast(`There is already a region named "${to}".`); return; }
              app.editSource('Rename Editable Region', (s) => renameRegion(s, v.list, to), tab);
              // Attached pages keep their content under the new name.
              let n = 0;
              for (const p of pagesUsing(app.site, tab.path)) { const s = app.site.read(p)!; const out = renameRegion(s, v.list, to); if (out !== s) { writePage(app, p, out, 'Rename Editable Region'); n++; } }
              setListOptions(ctl, 'list', opts(), to);
              toast(`Renamed to "${to}"${n ? ` in the template and ${n} attached page${n > 1 ? 's' : ''}` : ''}.`);
            },
          },
          {
            label: 'Remove', onClick: async (v, ctl) => {
              if (!v.list) return;
              if (!await confirmDialog('Remove Editable Region', `Remove the region "${v.list}"? Its content stays in the template but becomes fixed. Attached pages lose their own content for it when they are updated.`, 'Remove')) return;
              app.editSource('Remove Editable Region', (s) => removeRegion(s, v.list), tab);
              setListOptions(ctl, 'list', opts(), opts()[0]?.value);
            },
          },
          { label: 'Go To', onClick: (v, ctl) => { goto = v.list; ctl.close({}); } },
        ],
      });
      if (add) { await app.exec('template.editableRegion'); return; }
      if (goto) {
        const r = templateRegions(tab.source).find((x) => x.name === goto);
        if (r && tab.ui.code) {
          if (tab.view === 'design' || tab.view === 'preview') app.setView(tab, 'split');
          tab.ui.focusArea = 'code';
          tab.ui.code.select(r.innerStart, r.innerEnd);
          tab.ui.code.focus();
        }
      }
    },
  },
  {
    id: 'template.checkSyntax', label: 'Check Template Syntax', icon: 'rule', ...tpl, group: 'Regions', edits: false, origin: 'Dreamweaver', isEnabled: (app) => isDwt(app) || isAttached(app),
    run: async (app) => {
      app.active.ui.flush();
      const issues = checkTemplateSyntax(app.active.source, isTemplatePath(app.active.path));
      const t = attachedOf(app);
      if (t && !app.site.has(t)) issues.unshift({ line: 1, level: 'error', message: `The attached template ${t} is not in the site.` });
      if (!issues.length) { toast('No problems found in the region markers.'); return; }
      const list = h('ul', { class: 'ql-msg' }, ...issues.map((i) => h('li', null, `${i.level === 'error' ? 'Error' : 'Warning'}, line ${i.line}: ${i.message}`)));
      await alertDialog('Check Template Syntax', list);
    },
  },
  {
    id: 'template.exportNoMarkup', label: 'Export Without Template Markup…', icon: 'archive', ...dsn, edits: false, origin: 'Dreamweaver (Export without markup)', isEnabled: (app) => app.site.files.size > 0,
    tip: 'Download a ZIP copy of the site with every template and library item marker removed (template and library files left out).',
    run: async (app) => {
      flushAll(app);
      const clone = app.site.clone();
      for (const f of clone.pages()) if (f.text != null && !/\.(dwt|lbi)$/i.test(f.path)) { const out = stripPageMarkup(f.text); if (out !== f.text) clone.write(f.path, out, { silent: true }); }
      const { zipSite } = await import('../site/io');
      const blob = await zipSite(clone, { filter: (p) => !/\.(dwt|lbi)$/i.test(p) && !/^(Templates|Library)\//.test(p) });
      download(blob, `${slugify(app.site.name)}-without-template-markup.zip`);
    },
  },
  {
    id: 'template.removeMarkup', label: 'Remove Template Markup', icon: 'code_off', ...dsn, origin: 'Dreamweaver', isEnabled: (app) => isPage(app) && /#BeginEditable|TemplateBeginEditable|InstanceBegin|#BeginTemplate|#BeginLibraryItem|TemplateParam|TemplateBegin(If|Repeat)/.test(app.active.source),
    tip: 'Remove every template and library item marker from this file, keeping its content.',
    run: async (app) => {
      const path = app.active.path;
      const dwt = isTemplatePath(path);
      if (dwt && pagesUsing(app.site, path).length && !await confirmDialog('Remove Template Markup', `${pagesUsing(app.site, path).length} pages are attached to this template. Without editable regions, updating them would replace their content. Remove the markup anyway?`, 'Remove')) return;
      app.editSource('Remove Template Markup', (src) => (dwt ? stripTemplateMarkup(src) : stripPageMarkup(src)));
      delete app.site.data.templates[path];
    },
  },
  {
    id: 'template.properties', label: 'Template Properties…', icon: 'tune', ...dsn, origin: 'Dreamweaver (Template Properties)', isEnabled: (app) => isDwt(app) || isAttached(app),
    tip: 'Template parameters: set their values for this page, or define them in a template.',
    run: async (app, arg?: Record<string, string>) => {
      const tab = app.active;
      tab.ui.flush();
      if (isTemplatePath(tab.path)) {
        let params = templateParams(tab.source);
        const build = () => [
          ...(params.length ? [] : [{ key: 'none', type: 'info' as const, label: 'This template has no parameters. Parameters set values that pages can change: for optional regions (boolean) and editable attributes.' }]),
          ...params.flatMap((p, i) => [
            p.type === 'boolean' ? { key: `v${i}`, label: `${p.name} (${p.type})`, type: 'checkbox' as const, value: p.value === 'true', half: true } : { key: `v${i}`, label: `${p.name} (${p.type})`, type: p.type === 'color' ? 'color' as const : p.type === 'number' ? 'number' as const : 'text' as const, value: p.value, half: true },
            { key: `x${i}`, label: 'Remove', type: 'checkbox' as const, value: false, half: true },
          ]),
        ];
        const v = arg || await openDialog({
          title: 'Template Parameters', wide: true, fields: build(),
          buttons: [{
            label: 'Add Parameter…', onClick: async (_vals, ctl) => {
              const r = await openDialog({
                title: 'Add Parameter',
                fields: [
                  { key: 'name', label: 'Name', type: 'text', value: freeName(tab.source, 'param'), autofocus: true },
                  { key: 'type', label: 'Type', type: 'select', value: 'text', options: ['text', 'boolean', 'number', 'color', 'URL'] },
                  { key: 'value', label: 'Default value', type: 'text', value: '' },
                ],
                validate: (x) => (/^[A-Za-z_][\w-]*$/.test(x.name) ? (params.some((p) => p.name === x.name) ? 'That name is taken.' : null) : 'Use letters, digits, - and _ (starting with a letter).'),
              });
              if (!r) return;
              params = [...params, { name: r.name, type: r.type, value: r.type === 'boolean' ? (/^(true|yes|1)$/i.test(r.value) ? 'true' : 'false') : r.value }];
              ctl.rebuild(build());
            },
          }],
        });
        if (!v) return;
        const next = params.map((p, i) => ({ ...p, value: v[`v${i}`] == null ? p.value : p.type === 'boolean' ? String(!!v[`v${i}`]) : String(v[`v${i}`]) })).filter((_, i) => !v[`x${i}`]);
        app.editSource('Template Parameters', (src) => setTemplateParams(src, next));
        if (pagesUsing(app.site, tab.path).length && await confirmDialog('Template Parameters', 'Update the attached pages now?', 'Update')) await updateTemplate(app, tab.path);
        return;
      }
      const t = attachedOf(app)!;
      if (!app.site.has(t)) { toast(`The template ${t} is not in the site.`); return; }
      const tparams = templateParams(app.site.read(t) || '');
      if (!tparams.length) { await alertDialog('Template Properties', `${t} has no template parameters.\nOpen the template and use Template Properties to add some.`); return; }
      const cur = new Map(instanceParams(tab.source).map((p) => [p.name, p.value]));
      const v = arg || await openDialog({
        title: 'Template Properties',
        help: `Values for this page. Defaults come from ${t}.`,
        fields: tparams.map((p) => {
          const val = cur.get(p.name) ?? p.value;
          return p.type === 'boolean'
            ? { key: p.name, label: `Show "${p.name}"`, type: 'checkbox' as const, value: val === 'true' }
            : { key: p.name, label: p.name, type: p.type === 'color' ? 'color' as const : p.type === 'number' ? 'number' as const : 'text' as const, value: val };
        }),
      });
      if (!v) return;
      const next = tparams.map((p) => ({ ...p, value: v[p.name] == null ? (cur.get(p.name) ?? p.value) : p.type === 'boolean' ? String(v[p.name] === true || v[p.name] === 'true') : String(v[p.name]) }));
      app.editSource('Template Properties', (src) => applyTemplateFull(app.site, t, setInstanceParams(src, next), tab.path));
    },
  },
  { id: 'template.newFromPage', label: 'New Template from Page…', icon: 'note_add', ...dsn, origin: 'Expression Web', isEnabled: (app) => isPage(app) && !isTemplatePath(app.active.path), run: (app, arg) => makeTemplateFrom(app, 'New Page Template from Page', arg) },
  { id: 'template.makeTemplate', label: 'Make Template…', icon: 'dashboard_customize', tab: 'Template', group: 'Template Objects', edits: true, origin: 'Dreamweaver', isEnabled: (app) => isPage(app) && !isTemplatePath(app.active.path), run: (app, arg) => makeTemplateFrom(app, 'Make Template', arg) },
  { id: 'template.saveAsTemplate', label: 'Save as Page Template…', icon: 'save_as', tab: 'Backstage', group: 'Save', edits: true, origin: 'Expression Web, Dreamweaver', isEnabled: (app) => isPage(app) && !isTemplatePath(app.active.path), run: (app, arg) => makeTemplateFrom(app, 'Save as Page Template', arg) },
  {
    id: 'template.makeNested', label: 'Make Nested Template…', icon: 'account_tree', tab: 'Template', group: 'Template Objects', edits: true, origin: 'Dreamweaver', isEnabled: isAttached,
    tip: 'Make a template from this page that is itself attached to the page\'s template.',
    run: async (app, arg?: { name: string }) => {
      const tab = app.active;
      tab.ui.flush();
      const parent = attachedOf(app)!;
      const psrc = app.site.read(parent) || '';
      if (dialectOf(psrc) !== 'instance') { await alertDialog('Make Nested Template', 'Nested templates need Dreamweaver-style markers (TemplateBeginEditable): in the Expression Web style, the markers of a template and of its pages look the same, so a nested template could not be told apart.\nMake the parent template with Dreamweaver-style markers to use nesting.'); return; }
      const name = arg?.name ?? await promptDialog('Make Nested Template', 'Template name', `${stripExt(baseName(parent))}-${slugify(stripExt(baseName(tab.path)))}`);
      if (!name || !slugify(name)) return;
      const path = joinPath('Templates', `${slugify(name)}.dwt`);
      if (app.site.has(path) && !await confirmDialog('Make Nested Template', `${path} already exists. Replace it?`, 'Replace')) return;
      let src = rewriteRefs(tab.source, tab.path, (target) => relativeRef(path, target));
      // Each region of the parent becomes an editable region of the nested template too.
      const regions = pageRegions(src);
      for (const r of [...regions].reverse()) src = src.slice(0, r.innerStart) + makeRegionMarkup(r.name, r.content, 'instance') + src.slice(r.innerEnd);
      app.site.write(path, src);
      app.site.data.templates[path] = parent;
      app.openFile(path);
      toast(`Saved the nested template ${path}. Remove the regions that pages of it should not change (Manage Editable Regions).`, { ms: 6000 });
    },
  },
  {
    id: 'template.editableRegion', label: 'New Editable Region…', icon: 'edit_note', ...tpl, group: 'Regions', origin: 'Expression Web, Dreamweaver', isEnabled: isPage,
    tip: 'Mark the selection (or a new placeholder at the cursor) as a region that pages can change.',
    run: async (app, arg?: string) => {
      const tab = app.active;
      tab.ui.flush();
      if (!isTemplatePath(tab.path) && !arg && !await confirmDialog('New Editable Region', 'Editable regions only take effect in page templates (.dwt files). Add the region to this page anyway?', 'Add')) return;
      const src = tab.source;
      const d = dialectFor(app, src);
      const name = arg ?? await promptDialog('New Editable Region', 'Region name', freeName(src, 'EditRegion'));
      if (!name) return;
      if (!validName(name)) { toast('Region names cannot contain " \' & < or >.'); return; }
      if (templateRegions(src).some((r) => r.name === name)) { toast(`There is already a region named "${name}".`); return; }
      wrapInMarkers(app, [beginM(d, name)], [endM(d)], name);
    },
  },
  {
    id: 'template.optionalRegion', label: 'New Optional Region…', icon: 'visibility', ...tpl, group: 'Regions', origin: 'Dreamweaver', isEnabled: isDwt,
    tip: 'Content that each page can show or hide (a boolean template parameter).',
    run: (app, arg?: { name: string; show?: boolean }) => optionalRegion(app, false, arg),
  },
  {
    id: 'template.editableOptional', label: 'New Editable Optional Region…', icon: 'edit_attributes', tab: 'Template', group: 'Template Objects', edits: true, origin: 'Dreamweaver', isEnabled: isDwt,
    run: (app, arg?: { name: string; show?: boolean }) => optionalRegion(app, true, arg),
  },
  {
    id: 'template.repeatingRegion', label: 'New Repeating Region…', icon: 'repeat', ...tpl, group: 'Regions', origin: 'Dreamweaver', isEnabled: isDwt,
    tip: 'Markup that pages can repeat any number of times (put editable regions inside it).',
    run: async (app, arg?: string) => {
      const src = app.active.source;
      const name = arg ?? await promptDialog('New Repeating Region', 'Region name', freeName(src, 'RepeatRegion'));
      if (!name) return;
      if (!validName(name)) { toast('Region names cannot contain " \' & < or >.'); return; }
      if (inCode(app) ? !(view(app)?.code?.selection.text) : !selectionHtml(app)) toast('Tip: put an editable region inside the repeating region so pages can change each entry.');
      wrapInMarkers(app, [`<!-- TemplateBeginRepeat name="${name}" -->`], ['<!-- TemplateEndRepeat -->'], `${name} content`);
    },
  },
  {
    id: 'template.repeatingTable', label: 'Repeating Table…', icon: 'table_rows', tab: 'Template', group: 'Template Objects', edits: true, origin: 'Dreamweaver', isEnabled: isDwt,
    tip: 'A table whose body row repeats; each cell is an editable region.',
    run: async (app, arg?: { cols: number; header?: boolean; name?: string }) => {
      const src = app.active.source;
      const v = arg || await openDialog({
        title: 'Repeating Table',
        fields: [
          { key: 'cols', label: 'Columns', type: 'number', value: 3, min: 1, max: 20, half: true },
          { key: 'header', label: 'Fixed header row', type: 'checkbox', value: true, half: true },
          { key: 'name', label: 'Repeating region name', type: 'text', value: freeName(src, 'RepeatRegion') },
        ],
        validate: (x) => (validName(x.name || '') ? null : 'Type a valid region name.'),
      });
      if (!v) return;
      const d = dialectFor(app, src);
      const cols = Math.max(1, Math.min(20, v.cols || 3));
      const used = new Set(templateRegions(src).map((r) => r.name));
      let k = 1;
      const next = () => { while (used.has(`EditRegion${k}`)) k++; used.add(`EditRegion${k}`); return `EditRegion${k}`; };
      const head = v.header !== false ? `  <thead>\n    <tr>${Array.from({ length: cols }, (_, i) => `<th scope="col">Heading ${i + 1}</th>`).join('')}</tr>\n  </thead>\n` : '';
      const row = `    <tr>${Array.from({ length: cols }, () => { const n = next(); return `<td>${beginM(d, n)}${n}${endM(d)}</td>`; }).join('')}</tr>`;
      const markup = `<table style="width: 100%; border-collapse: collapse">\n${head}  <tbody>\n    <!-- TemplateBeginRepeat name="${v.name || 'RepeatRegion1'}" -->\n${row}\n    <!-- TemplateEndRepeat -->\n  </tbody>\n</table>`;
      insertFragment(app, markup);
    },
  },
  {
    id: 'template.editableAttribute', label: 'Make Attribute Editable…', icon: 'data_object', tab: 'Template', group: 'Template Objects', edits: true, origin: 'Dreamweaver', isEnabled: isDwt,
    tip: 'Let pages set an attribute of the selected element (a template parameter).',
    run: async (app, arg?: { attr: string; param: string; type?: string; value?: string }) => {
      if (!designReady(app)) return;
      const el = selectedEl(app);
      const doc = view(app)?.design?.doc;
      if (!el || !doc || el === doc.body) { toast('Select an element in Design view first (click it, or use the Quick Tag Selector).'); return; }
      const names = [...el.attributes].map((a) => a.name).filter((n) => !n.startsWith('data-ql-'));
      const v = arg || await openDialog({
        title: 'Make Attribute Editable',
        help: `Element: <${el.tagName.toLowerCase()}>`,
        fields: [
          { key: 'attr', label: 'Attribute', type: 'combo', value: names[0] || 'class', options: [...new Set([...names, 'class', 'id', 'title', 'href', 'src', 'alt', 'style', 'bgcolor'])] },
          { key: 'param', label: 'Parameter name', type: 'text', value: '' },
          { key: 'type', label: 'Type', type: 'select', value: 'text', options: ['text', 'URL', 'color', 'number', 'boolean'] },
          { key: 'value', label: 'Default value', type: 'text', value: '' },
        ],
        onChange: (x, ctl, key) => {
          if (key === 'attr' || key === '') {
            ctl.set('value', el.getAttribute(`data-ql-o-${x.attr}`) ?? el.getAttribute(x.attr) ?? '');
            if (!x.param || key === 'attr') ctl.set('param', String(x.attr).replace(/[^\w-]/g, '') + 'Param');
          }
        },
        validate: (x) => (/^[A-Za-z_][\w-]*$/.test(x.attr || '') && /^[A-Za-z_][\w-]*$/.test(x.param || '') ? null : 'Type an attribute and a parameter name (letters, digits, - and _).'),
      });
      if (!v) return;
      mutate(app, () => { el.removeAttribute(`data-ql-o-${v.attr}`); el.setAttribute(v.attr, `@@(${v.param})@@`); });
      app.editSource('Make Attribute Editable', (src) => setTemplateParams(src, [...templateParams(src).filter((p) => p.name !== v.param), { name: v.param, type: v.type || 'text', value: v.value ?? '' }]));
    },
  },
  {
    id: 'template.listPages', label: 'Attached Pages…', icon: 'list_alt', ...tpl, group: 'Attached Pages', edits: false, noRecord: true, origin: 'Expression Web', isEnabled: (app) => templatesIn(app).length > 0,
    tip: 'The pages attached to a template; open one with a double-click.',
    run: async (app, arg?: string) => {
      const t = arg || contextTemplate(app) || await pickTemplate(app, 'Attached Pages');
      if (!t) return;
      const pages = pagesUsing(app.site, t);
      if (!pages.length) { toast(`No pages are attached to ${t}.`); return; }
      let update = false;
      const v = await openDialog({
        title: `Pages Attached to ${baseName(t)}`, ok: 'Open',
        fields: [{ key: 'p', label: `${pages.length} page${pages.length > 1 ? 's' : ''}`, type: 'list', rows: Math.min(14, pages.length + 1), value: pages[0], options: pages }],
        buttons: [{ label: 'Update All', onClick: (_x, ctl) => { update = true; ctl.close({}); } }],
      });
      if (update) { await updateTemplate(app, t); return; }
      if (v?.p) app.openFile(v.p);
    },
  },

  // Library items ---------------------------------------------------------------------------
  {
    id: 'template.addLibraryItem', label: 'Add to Library…', icon: 'library_add', ...lib, origin: 'Dreamweaver', isEnabled: isPage,
    tip: 'Save the selection as a library item (.lbi) that can be placed on many pages and updated in one go.',
    run: async (app, arg?: string) => {
      const html = inCode(app) ? selectionText(app) : selectionHtml(app);
      if (!html.trim()) { toast('Select the content to keep as a library item first.'); return; }
      const name = arg ?? await promptDialog('Add to Library', 'Library item name', 'item');
      if (!name || !slugify(name)) return;
      const path = joinPath('Library', `${slugify(name)}.lbi`);
      if (app.site.has(path) && !await confirmDialog('Add to Library', `${path} already exists. Replace it?`, 'Replace')) return;
      // Library item links are relative to the .lbi file.
      app.site.write(path, rewriteRefs(html, app.active.path, (target) => relativeRef(path, target)));
      const [b, e] = libraryItemMarkup(path, '\u0000').split('\u0000');
      wrapInMarkers(app, [b], [e], '');
      toast(`Saved ${path}.`);
    },
  },
  {
    id: 'template.insertLibraryItem', label: 'Insert Library Item…', icon: 'library_books', ...lib, origin: 'Dreamweaver', isEnabled: (app) => isPage(app) && libraryItems(app).length > 0,
    run: async (app, arg?: string) => {
      const items = libraryItems(app);
      let item = arg;
      if (!item) {
        const show = (p: string) => `<pre style="white-space:pre-wrap;max-height:180px;overflow:auto;margin:0">${esc((app.site.read(p) || '').slice(0, 3000))}</pre>`;
        const v = await openDialog({
          title: 'Insert Library Item', preview: show(items[0]),
          fields: [{ key: 'i', label: 'Library items', type: 'list', rows: Math.min(10, items.length + 1), value: items[0], options: items }],
          onChange: (x, ctl) => { if (x.i) ctl.setPreview(show(x.i)); },
        });
        if (!v?.i) return;
        item = v.i;
      }
      const text = app.site.read(item!);
      if (text == null) { toast(`${item} is not in the site.`); return; }
      const content = rewriteRefs(text, item!, (target) => relativeRef(app.active.path, target));
      insertFragment(app, libraryItemMarkup(item!, content));
    },
  },
  {
    id: 'template.updateLibraryPage', label: 'Update Library Items on Page', icon: 'sync', ...lib, origin: 'Dreamweaver', isEnabled: (app) => isPage(app) && /#BeginLibraryItem/.test(app.active.source),
    run: (app) => { const ok = app.editSource('Update Library Items', (src) => updateLibraryItems(app.site, app.active.path, src)); toast(ok ? 'Library items updated.' : 'The library items are up to date.'); },
  },
  {
    id: 'template.updateLibraryAll', label: 'Update Library Items in Site', icon: 'sync_alt', ...lib, origin: 'Dreamweaver', isEnabled: (app) => libraryItems(app).length > 0,
    run: (app, arg?: string) => {
      flushAll(app);
      let n = 0;
      for (const f of app.site.pages()) {
        if (f.text == null || !/#BeginLibraryItem/.test(f.text) || /\.lbi$/i.test(f.path)) continue;
        if (arg && !f.text.includes(baseName(arg))) continue;
        const out = updateLibraryItems(app.site, f.path, f.text);
        if (out !== f.text) { writePage(app, f.path, out, 'Update Library Items'); n++; }
      }
      toast(`Updated library items on ${n} page${n === 1 ? '' : 's'}.`);
    },
  },
  {
    id: 'template.detachLibraryItem', label: 'Detach from Library', icon: 'link_off', ...lib, origin: 'Dreamweaver', isEnabled: (app) => isPage(app) && /#BeginLibraryItem/.test(app.active.source),
    tip: 'Make the library item at the cursor ordinary content of this page (it no longer updates).',
    run: async (app) => {
      const v = view(app);
      if (!v) return;
      if (inCode(app) && v.code) {
        const pos = v.code.selection.from;
        const text = v.code.text;
        const items = [...text.matchAll(/<!--\s*#BeginLibraryItem\s+"[^"]+"\s*-->([\s\S]*?)<!--\s*#EndLibraryItem\s*-->/gi)];
        const hit = items.find((m) => m.index! <= pos && pos <= m.index! + m[0].length) || (items.length === 1 ? items[0] : null);
        if (!hit) { toast('Put the cursor inside a library item first.'); return; }
        app.editSource('Detach from Library', (src) => src.slice(0, hit.index!) + hit[1] + src.slice(hit.index! + hit[0].length));
        return;
      }
      if (!designReady(app)) return;
      const doc = v.design!.doc!;
      const pairs = libraryComments(doc);
      const sel = v.design!.restoreRange();
      let hit = pairs.find((p) => {
        if (!sel) return false;
        const r = doc.createRange();
        r.setStartAfter(p.begin); r.setEndBefore(p.end);
        return r.compareBoundaryPoints(Range.START_TO_START, sel) <= 0 && r.compareBoundaryPoints(Range.END_TO_END, sel) >= 0;
      });
      if (!hit && pairs.length === 1) hit = pairs[0];
      if (!hit && pairs.length > 1) {
        const c = await openDialog({ title: 'Detach from Library', fields: [{ key: 'i', label: 'Library item', type: 'list', rows: Math.min(8, pairs.length + 1), value: '0', options: pairs.map((p, i) => ({ value: String(i), label: `${i + 1}. ${p.ref}` })) }] });
        if (!c) return;
        hit = pairs[+c.i];
      }
      if (!hit) { toast('This page has no library items.'); return; }
      const found = hit;
      mutate(app, () => { found.begin.remove(); found.end.remove(); });
    },
  },
]);

async function optionalRegion(app: App, editable: boolean, arg?: { name: string; show?: boolean; region?: string }): Promise<void> {
  const tab = app.active;
  tab.ui.flush();
  const src = tab.source;
  const v = arg || await openDialog({
    title: editable ? 'New Editable Optional Region' : 'New Optional Region',
    help: 'Pages show or hide this content with Template Properties.',
    fields: [
      { key: 'name', label: 'Parameter name', type: 'text', value: freeName(src, 'OptionalRegion'), autofocus: true },
      { key: 'show', label: 'Show by default', type: 'checkbox', value: true },
      ...(editable ? [{ key: 'region', label: 'Editable region name', type: 'text' as const, value: freeName(src, 'EditRegion') }] : []),
    ],
    validate: (x) => (!/^[A-Za-z_][\w-]*$/.test(x.name || '') ? 'Use letters, digits, - and _ for the name (starting with a letter).' : templateParams(src).some((p) => p.name === x.name) ? 'A parameter with that name exists.' : editable && !validName(x.region || '') ? 'Type a valid region name.' : null),
  });
  if (!v) return;
  const d = dialectFor(app, src);
  const begins = [`<!-- TemplateBeginIf cond="${v.name}" -->`];
  const ends = ['<!-- TemplateEndIf -->'];
  if (editable) { const rn = v.region || freeName(src, 'EditRegion'); begins.push(beginM(d, rn)); ends.push(endM(d)); }
  if (!wrapInMarkers(app, begins, ends, editable ? v.region || 'Optional content' : 'Optional content')) return;
  app.editSource('New Optional Region', (s) => setTemplateParams(s, [...templateParams(s), { name: v.name, type: 'boolean', value: v.show === false ? 'false' : 'true' }]));
}
