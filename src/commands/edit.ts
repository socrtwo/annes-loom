/**
 * Edit commands: undo/redo/repeat, clipboard (cut, copy, paste, paste text, paste special, the
 * clipboard ring), delete, select all, find and replace (one page, open pages or the whole site; in
 * the source or in the visible text), go to line / function, history and snapshots, format painter,
 * follow hyperlink, external editor and the tag libraries.
 */
import { def, type MenuEntry } from './registry';
import type { App, PageTab } from '../app';
import { openDialog, toast, promptDialog, confirmDialog } from '../ui/dialog';
import { h, download } from '../ui/dom';
import { view, isPage, isText, selectedEl, insertHtml, mutate, setAttr, getAttr, setStyleProp, styleOf, selectionText, selectionHtml } from '../editor/ops';
import { esc, regions } from '../model/html';
import { decodeEntities } from '../model/site';
import { isPagePath, resolveRef, extOf } from '../model/paths';
import { stripActiveContent } from '../util/sanitize';
import { TAG_LIBRARY, GLOBAL_ATTRS, parseSource, enclosingElement, parseStartTag, showCode } from './tag';
import { installViewHooks } from './view';
import { EditorSelection } from '@codemirror/state';
import '../ui/panesEdit';

// ==========================================================================================
// Search (pure)

export interface FindOptions { regex?: boolean; matchCase?: boolean; wholeWord?: boolean }
export interface Match { from: number; to: number; m: RegExpExecArray }

export function buildRegExp(query: string, o: FindOptions): RegExp {
  let src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, 'gu' + (o.matchCase ? '' : 'i') + (o.regex ? 'm' : ''));
}

/** Every match of the query in the text. Throws on a bad regular expression. */
export function findMatches(text: string, query: string, o: FindOptions = {}, limit = 10000): Match[] {
  if (!query) return [];
  const re = buildRegExp(query, o);
  const out: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < limit) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out.push({ from: m.index, to: m.index + m[0].length, m });
  }
  return out;
}

/** The replacement text for one match: $&, $1…$99, $<name> and $$ work in regular-expression mode. */
export function expandReplacement(m: RegExpExecArray, rep: string, regex: boolean): string {
  if (!regex) return rep;
  return rep.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (all, t: string, name?: string) => {
    if (t === '$') return '$';
    if (t === '&') return m[0];
    if (name != null) return m.groups?.[name] ?? '';
    const n = parseInt(t, 10);
    return n < m.length ? m[n] ?? '' : all;
  });
}

/**
 * The visible text of a page's body with a map back to source offsets: tags, comments, scripts and
 * styles are skipped, entities decoded and runs of white space shown as one space.
 */
export function visibleText(src: string): { text: string; starts: number[]; ends: number[] } {
  const r = regions(src);
  let i = r.bodyOpen ? r.bodyOpen[1] : r.headClose >= 0 ? src.indexOf('>', r.headClose) + 1 : 0;
  const end = r.bodyClose >= 0 ? r.bodyClose : src.length;
  let text = '';
  const starts: number[] = [], ends: number[] = [];
  const push = (ch: string, s: number, e: number) => {
    if (/\s/.test(ch)) { if (!text || text.endsWith(' ')) { if (text) ends[ends.length - 1] = e; return; } ch = ' '; }
    text += ch; starts.push(s); ends.push(e);
  };
  while (i < end) {
    const c = src[i];
    if (c === '<') {
      const rest = src.slice(i, i + 12).toLowerCase();
      let close: number;
      if (rest.startsWith('<!--')) close = src.indexOf('-->', i + 4) + 3;
      else if (/^<(script|style|noscript|template)\b/.test(rest)) { const n = /^<(\w+)/.exec(rest)![1]; const k = src.toLowerCase().indexOf(`</${n}`, i + 1); close = k < 0 ? end : src.indexOf('>', k) + 1; }
      else close = src.indexOf('>', i) + 1;
      if (close <= i) close = end;
      if (/^<\/?(p|div|br|li|h[1-6]|tr|td|th|section|article|header|footer|blockquote|pre|table|ul|ol|dt|dd|nav|main|aside|figure|figcaption|hr)\b/i.test(rest)) push(' ', i, close);
      i = close;
      continue;
    }
    if (c === '&') {
      const m = /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.exec(src.slice(i, i + 12));
      if (m) { const d = decodeEntities(m[0]); push(d === ' ' ? ' ' : d, i, i + m[0].length); i += m[0].length; continue; }
    }
    push(c, i, i + 1);
    i++;
  }
  return { text, starts, ends };
}

export interface FileHit { path: string; from: number; to: number; line: number; col: number; preview: string; pre: number; len: number }

/** Matches in one file's text, as source ranges (visible-text mode maps through visibleText). */
export function searchText(path: string, text: string, query: string, o: FindOptions & { mode?: 'source' | 'text' }, limit = 2000): FileHit[] {
  const hits: FileHit[] = [];
  const add = (from: number, to: number) => {
    const before = text.lastIndexOf('\n', from - 1) + 1;
    const lineEnd = text.indexOf('\n', from);
    const line = text.slice(0, from).split('\n').length;
    const rawLine = text.slice(before, lineEnd < 0 ? text.length : lineEnd);
    const col = from - before;
    const start = Math.max(0, col - 40);
    const preview = (start > 0 ? '…' : '') + rawLine.slice(start, col + (to - from) + 60).replace(/\t/g, ' ');
    hits.push({ path, from, to, line, col: col + 1, preview, pre: col - start + (start > 0 ? 1 : 0), len: Math.min(to - from, rawLine.length - col) });
  };
  if (o.mode === 'text' && isPagePath(path)) {
    const v = visibleText(text);
    for (const m of findMatches(v.text, query, o, limit)) add(v.starts[m.from], v.ends[m.to - 1]);
  } else for (const m of findMatches(text, query, o, limit)) add(m.from, m.to);
  return hits;
}

/** Replaces every match. In visible-text mode, matches that span tags are left alone and counted as skipped. */
export function replaceInText(path: string, text: string, query: string, rep: string, o: FindOptions & { mode?: 'source' | 'text' }): { text: string; count: number; skipped: number } {
  let count = 0, skipped = 0;
  const edits: [number, number, string][] = [];
  if (o.mode === 'text' && isPagePath(path)) {
    const v = visibleText(text);
    for (const m of findMatches(v.text, query, o)) {
      const a = v.starts[m.from], b = v.ends[m.to - 1];
      if (text.slice(a, b).includes('<')) { skipped++; continue; }
      edits.push([a, b, esc(expandReplacement(m.m, rep, !!o.regex)).replace(/&quot;/g, '"')]);
    }
  } else for (const m of findMatches(text, query, o)) edits.push([m.from, m.to, expandReplacement(m.m, rep, !!o.regex)]);
  let out = text;
  for (const [a, b, r] of edits.reverse()) { out = out.slice(0, a) + r + out.slice(b); count++; }
  return { text: out, count, skipped };
}

// ==========================================================================================
// Paste conversions (pure)

/** Removes Word/Office markup: conditional comments, o:p, mso styles and classes, empty spans, font tags. */
export function cleanWordHtml(html: string): string {
  let s = html.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?(o|w|v|m|st\d?):[^>]*>/gi, '').replace(/<xml[\s\S]*?<\/xml>/gi, '');
  const doc = new DOMParser().parseFromString(`<body>${s}</body>`, 'text/html');
  doc.querySelectorAll('style,meta,link,title,script').forEach((e) => e.remove());
  for (const e of [...doc.body.querySelectorAll('*')]) {
    const cls = (e.getAttribute('class') || '').split(/\s+/).filter((c) => c && !/^Mso/i.test(c));
    if (cls.length) e.setAttribute('class', cls.join(' ')); else e.removeAttribute('class');
    const st = (e.getAttribute('style') || '').split(';').map((d) => d.trim()).filter((d) => d && !/^(mso-|font-family|font-size|line-height|margin|text-indent|tab-stops|page-break|layout-grid|text-autospace|punctuation|color:\s*(black|windowtext))/i.test(d));
    if (st.length) e.setAttribute('style', st.join('; ')); else e.removeAttribute('style');
    for (const a of ['lang', 'align', 'valign', 'width', 'height', 'border', 'cellspacing', 'cellpadding']) if (e.tagName !== 'IMG' && e.tagName !== 'TD' && e.tagName !== 'TABLE') e.removeAttribute(a);
    if (/^(SPAN|FONT)$/.test(e.tagName) && !e.attributes.length) { const p = e.parentNode!; while (e.firstChild) p.insertBefore(e.firstChild, e); e.remove(); }
  }
  for (const p of [...doc.body.querySelectorAll('p')]) if (!p.textContent!.replace(/ /g, '').trim() && !p.querySelector('img')) p.remove();
  stripActiveContent(doc.body);
  return doc.body.innerHTML.replace(/ /g, '&nbsp;').trim();
}

/** Clipboard HTML without the page around it (StartFragment markers, html/head/body, scripts). */
export function cleanClipboardHtml(html: string): string {
  const frag = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(html);
  const s = frag ? frag[1] : html;
  const doc = new DOMParser().parseFromString(/<body/i.test(s) ? s : `<body>${s}</body>`, 'text/html');
  doc.querySelectorAll('meta,style,title,link').forEach((e) => e.remove());
  stripActiveContent(doc.body);
  return doc.body.innerHTML.trim();
}

export type PasteMode = 'html' | 'text' | 'breaks' | 'paragraphs' | 'pre' | 'word';

export function convertPaste(mode: PasteMode, html: string, text: string): string {
  const t = text || (html ? new DOMParser().parseFromString(html, 'text/html').body.textContent || '' : '');
  const lines = t.replace(/\r\n?/g, '\n');
  switch (mode) {
    case 'html': return html ? cleanClipboardHtml(html) : convertPaste('breaks', '', t);
    case 'word': return html ? cleanWordHtml(html) : convertPaste('paragraphs', '', t);
    case 'text': return esc(lines.replace(/\s*\n\s*/g, ' ').trim());
    case 'breaks': return lines.split('\n').map((l) => esc(l)).join('<br>\n');
    case 'pre': return `<pre>${esc(lines)}</pre>`;
    case 'paragraphs': return lines.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.split('\n').map((l) => esc(l.trim())).join('<br>\n')}</p>`).join('\n');
  }
}

// ==========================================================================================
// Symbols for Go to Function (pure)

export interface Sym { name: string; kind: 'function' | 'class' | 'selector' | 'at-rule' | 'id'; at: number }

const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try', 'new', 'typeof']);

export function jsSymbols(text: string, base = 0): Sym[] {
  const out: Sym[] = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
  for (const m of clean.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) out.push({ name: m[1] + '()', kind: 'function', at: base + m.index! });
  for (const m of clean.matchAll(/\b([A-Za-z_$][\w$.]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) out.push({ name: m[1] + '()', kind: 'function', at: base + m.index! });
  for (const m of clean.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) out.push({ name: m[1], kind: 'class', at: base + m.index! });
  for (const m of clean.matchAll(/(?:^|[{};])[ \t]*(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^()\n]*\)\s*\{/gm)) {
    if (JS_KEYWORDS.has(m[1])) continue;
    const at = base + m.index! + m[0].indexOf(m[1]);
    if (!out.some((s) => s.name === m[1] + '()' && Math.abs(s.at - at) < 40)) out.push({ name: m[1] + '()', kind: 'function', at });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function cssSymbols(text: string, base = 0): Sym[] {
  const out: Sym[] = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  for (const m of clean.matchAll(/([^{};]+)\{/g)) {
    const raw = m[1];
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    out.push({ name, kind: name.startsWith('@') ? 'at-rule' : 'selector', at: base + m.index! + raw.indexOf(raw.trim()) });
  }
  return out;
}

export function symbolsOf(path: string, text: string): Sym[] {
  const e = extOf(path);
  if (e === 'css' || e === 'scss' || e === 'less') return cssSymbols(text);
  if (e === 'js' || e === 'mjs' || e === 'ts') return jsSymbols(text);
  const out: Sym[] = [];
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) if (!/\bsrc\s*=/.test(m[1])) out.push(...jsSymbols(m[2], m.index! + m[0].indexOf('>') + 1));
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) out.push(...cssSymbols(m[1], m.index! + m[0].indexOf('>') + 1));
  for (const m of text.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*\sid\s*=\s*["']([^"']+)["']/g)) out.push({ name: `${m[1].toLowerCase()}#${m[2]}`, kind: 'id', at: m.index! });
  return out.sort((a, b) => a.at - b.at);
}

// ==========================================================================================
// Find state shared with the Find pane

export type FindScope = 'page' | 'open' | 'site' | 'selection';
export const findState = {
  query: '', replace: '', regex: false, matchCase: false, wholeWord: false,
  mode: 'source' as 'source' | 'text', scope: 'page' as FindScope,
  results: [] as FileHit[], index: -1, message: '', version: 0,
};
const findOpts = () => ({ regex: findState.regex, matchCase: findState.matchCase, wholeWord: findState.wholeWord, mode: findState.mode });

function scopeFiles(app: App, scope: FindScope): string[] {
  if (scope === 'page' || scope === 'selection') return app.active ? [app.active.path] : [];
  if (scope === 'open') return app.docs.filter((d) => d.kind === 'page' || d.kind === 'text').map((d) => d.path);
  return app.site.list((f) => f.text != null).map((f) => f.path);
}

function textOf(app: App, path: string): string {
  const tab = app.docs.find((d) => d.path === path);
  if (tab) tab.ui.flush();
  return app.site.read(path) ?? '';
}

/** Runs Find All and stores the results for the pane. */
export function findAll(app: App): FileHit[] {
  const q = findState.query;
  findState.results = []; findState.index = -1; findState.message = '';
  if (!q) { findState.message = 'Type something to find.'; findState.version++; return []; }
  try {
    let total = 0;
    for (const p of scopeFiles(app, findState.scope)) {
      let hits = searchText(p, textOf(app, p), q, findOpts());
      if (findState.scope === 'selection' && app.active?.ui.code) { const s = app.active.ui.code.selection; if (s.to > s.from) hits = hits.filter((x) => x.from >= s.from && x.to <= s.to); }
      findState.results.push(...hits);
      total += hits.length;
      if (total > 5000) { findState.message = 'More than 5,000 matches; showing the first ones.'; break; }
    }
    const files = new Set(findState.results.map((r) => r.path)).size;
    findState.message ||= findState.results.length ? `${findState.results.length} match${findState.results.length === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}` : 'No matches.';
  } catch (e) { findState.message = `The pattern is not valid: ${(e as Error).message}`; }
  findState.version++;
  app.refresh();
  return findState.results;
}

/** Opens the file and selects the range in Code view (switching a Design-only page to Split view). */
export function reveal(app: App, path: string, from: number, to: number): void {
  if (!app.site.has(path)) { toast(`${path} is no longer in the site.`); return; }
  const tab = app.openFile(path);
  if (tab.view === 'design' || tab.view === 'preview') app.setView(tab, tab.kind === 'page' ? 'split' : 'code');
  tab.ui.focusArea = 'code';
  setTimeout(() => {
    const c = tab.ui.code;
    if (!c) return;
    const len = c.view.state.doc.length;
    c.select(Math.min(from, len), Math.min(to, len));
  }, 30);
}

/** Find Next/Previous from the cursor in the active file, moving to other files in the scope. */
export function findNext(app: App, dir: 1 | -1 = 1): boolean {
  const q = findState.query;
  if (!q) { app.exec('edit.find'); return false; }
  const tab = app.active;
  if (!tab) return false;
  // Design view: the frame's own find keeps the user in Design view for plain visible-text searches.
  const v = tab.ui;
  if (v?.target === 'design' && v.design?.frame.contentWindow && !findState.regex && findState.mode === 'text' && typeof (v.design.frame.contentWindow as any).find === 'function') {
    const ok = (v.design.frame.contentWindow as any).find(q, findState.matchCase, dir < 0, true, findState.wholeWord, false, false);
    if (ok) { findState.message = ''; return true; }
  }
  const files = scopeFiles(app, findState.scope === 'selection' ? 'page' : findState.scope);
  const order = [tab.path, ...files.filter((p) => p !== tab.path)];
  if (dir < 0) order.splice(1, order.length, ...order.slice(1).reverse());
  const cur = tab.ui.code?.view.state.selection.main;
  try {
    for (let k = 0; k <= order.length; k++) {
      const p = order[k % order.length];
      const hits = searchText(p, textOf(app, p), q, findOpts());
      if (!hits.length) continue;
      let hit: FileHit | undefined;
      if (k === 0 && cur) hit = dir > 0 ? hits.find((x) => x.from >= cur.to && !(x.from === cur.from && x.to === cur.to)) : [...hits].reverse().find((x) => x.to <= cur.from);
      else if (k === order.length) hit = dir > 0 ? hits[0] : hits[hits.length - 1]; // wrapped around to the first file
      else if (k > 0) hit = dir > 0 ? hits[0] : hits[hits.length - 1];
      if (hit) { reveal(app, hit.path, hit.from, hit.to); findState.message = k === order.length ? 'Search wrapped around.' : ''; findState.version++; return true; }
    }
  } catch (e) { toast(`The pattern is not valid: ${(e as Error).message}`); return false; }
  findState.message = 'No matches.'; findState.version++;
  toast(`"${q}" was not found.`);
  return false;
}

/** Replaces the current match (if the selection is one) and finds the next. */
export function replaceOne(app: App): void {
  const tab = app.active;
  const c = tab?.ui.code;
  if (!tab || !c) { findNext(app); return; }
  const s = c.view.state.selection.main;
  const hits = searchText(tab.path, c.text, findState.query, findOpts());
  const hit = hits.find((x) => x.from === s.from && x.to === s.to);
  if (hit) {
    const all = findMatches(findState.mode === 'text' && isPagePath(tab.path) ? visibleText(c.text).text : c.text, findState.query, findState);
    const idx = hits.indexOf(hit);
    const rep = findState.mode === 'text' ? esc(expandReplacement(all[idx].m, findState.replace, findState.regex)) : expandReplacement(all[idx].m, findState.replace, findState.regex);
    c.view.dispatch({ changes: { from: hit.from, to: hit.to, insert: rep }, selection: EditorSelection.cursor(hit.from + rep.length) });
    tab.ui.flush();
  }
  findNext(app);
}

/** Replace All in the scope: open tabs get one undo step each; other files are written directly. */
export async function replaceAll(app: App): Promise<void> {
  const q = findState.query;
  if (!q) { toast('Type something to find.'); return; }
  const files = scopeFiles(app, findState.scope === 'selection' ? 'page' : findState.scope);
  const closed = files.filter((p) => !app.docs.some((d) => d.path === p));
  let total = 0, changedFiles = 0, skipped = 0;
  const plan: [string, string][] = [];
  try {
    for (const p of files) {
      const r = replaceInText(p, textOf(app, p), q, findState.replace, findOpts());
      skipped += r.skipped;
      if (r.count) { plan.push([p, r.text]); total += r.count; changedFiles++; }
    }
  } catch (e) { toast(`The pattern is not valid: ${(e as Error).message}`); return; }
  if (!total) { toast(skipped ? `${skipped} matches cross tags and were not replaced; replace them in source mode.` : `"${q}" was not found.`); return; }
  const closedChanged = plan.filter(([p]) => closed.includes(p)).length;
  if (closedChanged && !(await confirmDialog('Replace All', `Replace ${total} matches in ${changedFiles} files? ${closedChanged} of them are not open, so their changes cannot be undone with Undo.`, 'Replace All'))) return;
  for (const [p, text] of plan) {
    const tab = app.docs.find((d) => d.path === p);
    if (tab) app.editSource('Replace All', () => text, tab); else app.site.write(p, text);
  }
  findState.message = `Replaced ${total} match${total === 1 ? '' : 'es'} in ${changedFiles} file${changedFiles === 1 ? '' : 's'}${skipped ? `; ${skipped} crossing tags were left alone` : ''}.`;
  findState.version++;
  toast(findState.message);
  findAll(app);
}

function openFind(app: App, opts: { replace?: boolean; scope?: FindScope }): void {
  const sel = selectionText(app).trim();
  if (sel && !sel.includes('\n') && sel.length < 200) findState.query = sel;
  if (opts.scope) findState.scope = opts.scope;
  app.ui.openPane('find', { replace: !!opts.replace, focus: true });
}

// ==========================================================================================
// Clipboard ring (also used by the Clipboard pane)

export interface ClipItem { html: string; text: string; time: number; source: string }
export const clipRing: ClipItem[] = [];
export let clipVersion = 0;
export function remember(html: string, text: string, source: string): void {
  if (!text && !html) return;
  if (clipRing[0]?.text === text && clipRing[0]?.html === html) return;
  clipRing.unshift({ html, text, time: Date.now(), source });
  if (clipRing.length > 24) clipRing.pop();
  clipVersion++;
}

const hookedDocs = new WeakSet<Document>();
let ringInstalled: App | null = null;
function installRing(app: App): void {
  if (ringInstalled === app) return;
  ringInstalled = app;
  installViewHooks(app);
  const onCopy = () => setTimeout(() => {
    const t = app.active;
    if (!t) return;
    const v = t.ui;
    if (v.target === 'code' && v.code) { const s = v.code.selection.text; if (s) remember('', s, t.path); }
    else if (v.design) { const html = v.design.selectedHtml(); const text = v.design.selectedText(); if (text || html) remember(html, text, t.path); }
    app.refresh();
  }, 0);
  document.addEventListener('copy', onCopy, true);
  document.addEventListener('cut', onCopy, true);
  app.onRefresh(() => {
    for (const d of app.docs) {
      const doc = d.ui?.design?.doc;
      if (doc && !hookedDocs.has(doc)) { hookedDocs.add(doc); doc.addEventListener('copy', onCopy, true); doc.addEventListener('cut', onCopy, true); }
    }
  });
}
if (typeof window !== 'undefined') setTimeout(() => { const a = (window as any).ql; if (a?.onRefresh) installRing(a); }, 0);

async function writeClipboard(html: string, text: string): Promise<boolean> {
  try {
    const CI = (window as any).ClipboardItem;
    if (html && CI && navigator.clipboard?.write) {
      await navigator.clipboard.write([new CI({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      return true;
    }
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* not allowed here */ }
  return false;
}

async function readClipboard(): Promise<{ html: string; text: string } | null> {
  try {
    if ((navigator.clipboard as any)?.read) {
      const items = await (navigator.clipboard as any).read();
      let html = '', text = '';
      for (const it of items) {
        if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
        if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
      }
      return { html, text };
    }
    if (navigator.clipboard?.readText) return { html: '', text: await navigator.clipboard.readText() };
  } catch { /* permission refused */ }
  return null;
}

async function copyCmd(app: App, cut: boolean): Promise<void> {
  installRing(app);
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' && v.code) {
    const s = v.code.selection;
    if (s.from === s.to) { toast('Select some code first.'); return; }
    remember('', s.text, app.active.path);
    if (!(await writeClipboard('', s.text))) { v.code.focus(); try { document.execCommand(cut ? 'cut' : 'copy'); } catch { /* */ } }
    if (cut && !app.isReadOnly()) { v.code.replaceSelection(''); v.flush(); }
    return;
  }
  const d = v.design;
  if (!d) return;
  const html = d.selectedHtml(), text = d.selectedText();
  if (!html && !text) { toast('Select something first.'); return; }
  remember(html, text, app.active.path);
  const ok = d.exec(cut ? 'cut' : 'copy');
  if (!ok) { await writeClipboard(html, text); if (cut) { d.exec('delete'); } }
  v.flush();
}

/** Inserts clipboard content converted by `mode`. */
async function pasteCmd(app: App, mode?: PasteMode): Promise<void> {
  installRing(app);
  const v = view(app);
  if (!v) return;
  const clip = await readClipboard();
  if (!clip) {
    if (v.target === 'design' && v.design && v.design.exec(mode === 'text' ? 'insertText' : 'paste')) { v.flush(); return; }
    toast('This browser does not let QuillLoom read the clipboard from a button. Press Ctrl+V (⌘V) in the page instead, or use Paste Special after allowing clipboard access.', { ms: 7000 });
    return;
  }
  const { html, text } = clip;
  if (!html && !text) { toast('The clipboard is empty.'); return; }
  if (v.target === 'code' && v.code) {
    v.code.replaceSelection(mode === 'html' || mode === 'word' ? convertPaste(mode, html, text) : text);
    v.flush();
    return;
  }
  const m: PasteMode = mode || (html ? (/class="?Mso|urn:schemas-microsoft-com/i.test(html) ? 'word' : 'html') : 'breaks');
  insertHtml(app, convertPaste(m, html, text));
}

async function pasteSpecial(app: App, arg?: PasteMode): Promise<void> {
  if (arg) { await pasteCmd(app, arg); return; }
  const r = await openDialog({ title: 'Paste Special', fields: [
    { key: 'mode', label: 'Paste as', type: 'radio', value: 'html', options: [
      { value: 'html', label: 'Keep HTML formatting (scripts and event handlers removed)' },
      { value: 'word', label: 'Cleaned-up HTML (removes Word and Office markup)' },
      { value: 'text', label: 'Text only (one run of text)' },
      { value: 'breaks', label: 'Text with line breaks (<br>)' },
      { value: 'paragraphs', label: 'Text as paragraphs (<p> for each blank-line block)' },
      { value: 'pre', label: 'Preformatted text (<pre>)' },
    ] },
  ] });
  if (r) await pasteCmd(app, r.mode);
}

function deleteCmd(app: App): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' && v.code) {
    const s = v.code.selection;
    const to = s.from === s.to ? Math.min(v.code.view.state.doc.length, s.to + 1) : s.to;
    v.code.view.dispatch({ changes: { from: s.from, to, insert: '' } });
    v.flush();
    return;
  }
  const d = v.design;
  if (!d) return;
  const el = d.selected as HTMLElement | null;
  if (el && el !== d.doc?.body && (/^(IMG|HR|IFRAME|VIDEO|AUDIO|OBJECT|EMBED|CANVAS|INPUT|SELECT|TEXTAREA|BUTTON|TABLE)$/.test(el.tagName) || !d.selectedText())) {
    const sel = d.doc!.getSelection();
    const exact = sel && sel.rangeCount && !sel.isCollapsed;
    if (!exact || /^(IMG|HR|IFRAME|VIDEO|AUDIO|OBJECT|EMBED|CANVAS|INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) { mutate(app, () => { el.remove(); d.select(d.doc!.body); }); return; }
  }
  d.exec('delete');
  v.flush();
}

function selectAll(app: App): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' && v.code) { v.code.select(0, v.code.view.state.doc.length); return; }
  v.design?.exec('selectAll');
}

async function goToLine(app: App, arg?: number): Promise<void> {
  const c = showCode(app);
  if (!c) return;
  let n = typeof arg === 'number' ? arg : NaN;
  if (isNaN(n)) {
    const lines = c.view.state.doc.lines;
    const v = await promptDialog('Go To Line', `Line number (1–${lines})`, String(c.cursor().line), { type: 'number', min: 1, max: lines });
    if (v == null) return;
    n = parseInt(v, 10);
  }
  if (!isNaN(n)) setTimeout(() => c.goToLine(n), 0);
}

function goToFunctionMenu(app: App): MenuEntry[] {
  const t = app.active;
  if (!t || !(t.kind === 'page' || t.kind === 'text')) return [{ label: 'Open a page, style sheet or script' }];
  const syms = symbolsOf(t.path, t.source);
  if (!syms.length) return [{ label: 'No functions, selectors or ids in this file' }];
  const icon = { function: 'function', class: 'category', selector: 'css', 'at-rule': 'alternate_email', id: 'tag' } as const;
  return syms.slice(0, 80).map((s) => ({ id: 'edit.goToFunction', arg: s.at, label: s.name.length > 60 ? s.name.slice(0, 58) + '…' : s.name, icon: icon[s.kind] }));
}

async function goToFunction(app: App, arg?: number): Promise<void> {
  const t = app.active;
  if (!t) return;
  if (typeof arg === 'number') {
    const c = showCode(app);
    if (c) setTimeout(() => { const l = c.view.state.doc.lineAt(Math.min(arg, c.view.state.doc.length)); c.select(arg, l.to); }, 0);
    return;
  }
  const syms = symbolsOf(t.path, t.source);
  if (!syms.length) { toast('No functions, selectors or ids in this file.'); return; }
  const r = await openDialog({ title: 'Go To Function', fields: [{ key: 's', label: 'Functions, style rules and ids', type: 'list', rows: 14, value: String(syms[0].at), options: syms.map((s) => ({ value: String(s.at), label: `${s.kind === 'function' ? 'ƒ ' : s.kind === 'class' ? 'C ' : s.kind === 'id' ? '# ' : '{ } '}${s.name}` })) }] });
  if (r?.s != null) await goToFunction(app, +r.s);
}

// ------------------------------------------------------------------------------------------
// Format painter

interface Painted { cls: string; style: string; tag: string }
let painter: Painted | null = null;

const PAINT_PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'color', 'background-color', 'text-decoration-line', 'text-transform', 'letter-spacing'];

function copyFormat(app: App): Painted | null {
  const el = selectedEl(app);
  if (!el || el === el.ownerDocument.body) return null;
  let style = styleOf(el);
  const cls = el.getAttribute('class') || '';
  if (!style && !cls) {
    // No class or inline style: copy the computed text formatting that differs from the parent.
    const win = el.ownerDocument.defaultView!;
    const cs = win.getComputedStyle(el), ps = el.parentElement ? win.getComputedStyle(el.parentElement) : null;
    style = PAINT_PROPS.filter((p) => !ps || cs.getPropertyValue(p) !== ps.getPropertyValue(p)).map((p) => `${p === 'text-decoration-line' ? 'text-decoration' : p}: ${cs.getPropertyValue(p)}`).join('; ');
  }
  return { cls, style, tag: el.tagName.toLowerCase() };
}

function applyFormat(app: App, f: Painted): void {
  const d = view(app)?.design;
  if (!d?.doc) return;
  const html = d.selectedHtml();
  if (html) {
    const attrs = `${f.cls ? ` class="${esc(f.cls)}"` : ''}${f.style ? ` style="${esc(f.style)}"` : ''}`;
    if (attrs) insertHtml(app, `<span${attrs}>${html}</span>`);
    return;
  }
  const el = selectedEl(app);
  if (!el || el === d.doc.body) return;
  mutate(app, () => {
    if (f.cls) el.setAttribute('class', f.cls);
    for (const decl of f.style.split(';')) { const i = decl.indexOf(':'); if (i > 0) setStyleProp(app, el, decl.slice(0, i).trim(), decl.slice(i + 1).trim()); }
  });
}

function formatPainter(app: App): void {
  if (painter) { painter = null; toast('Format Painter off'); return; }
  const d = view(app)?.design;
  if (!d?.doc || view(app)!.target !== 'design') { toast('Format Painter works in Design view: select the formatted text or element first.'); return; }
  const f = copyFormat(app);
  if (!f || (!f.cls && !f.style)) { toast('The selection has no formatting to copy.'); return; }
  painter = f;
  toast('Formatting copied. Select the text or click the element to format.', { ms: 4000 });
  const doc = d.doc;
  const done = () => {
    doc.removeEventListener('mouseup', onUp, true);
    setTimeout(() => {
      if (!painter) return;
      const p = painter;
      painter = null;
      applyFormat(app, p);
      app.refresh();
    }, 30);
  };
  const onUp = () => done();
  doc.addEventListener('mouseup', onUp, true);
}

// ------------------------------------------------------------------------------------------
// Links, editors, libraries

function followLink(app: App): void {
  const v = view(app);
  if (!v) return;
  let href: string | null = null;
  if (v.target === 'code' && v.code) {
    const text = v.code.text, pos = v.code.selection.from;
    let el = enclosingElement(parseSource(text).root, pos);
    while (el && el.name !== 'a' && el.name !== 'link' && el.name !== 'img' && el.name !== 'script') el = el.parent && el.parent.name !== '#root' ? el.parent : null;
    const t = el && parseStartTag(text.slice(el.openStart, el.openEnd));
    href = t?.attrs.find(([k]) => k === 'href' || k === 'src')?.[1] ?? null;
  } else {
    const a = selectedEl(app)?.closest('a[href],img[src]');
    href = a ? getAttr(a, a.tagName === 'IMG' ? 'src' : 'href') : null;
  }
  if (!href) { toast('Put the cursor in a hyperlink first.'); return; }
  if (href.startsWith('#')) {
    const d = v.design?.doc;
    const target = d?.getElementById(href.slice(1)) || d?.querySelector(`a[name="${CSS.escape(href.slice(1))}"]`);
    if (target) { (target as HTMLElement).scrollIntoView({ block: 'start' }); v.design!.select(target); } else toast(`There is no bookmark "${href.slice(1)}" on this page.`);
    return;
  }
  const p = resolveRef(app.active.path, href);
  if (p && app.site.has(p)) { app.openFile(p); return; }
  if (/^(https?:|mailto:|tel:)/i.test(href)) { app.followLink(href); return; }
  toast(`${href} is not in the site.`);
}

function externalEditor(app: App): void {
  const t = app.active;
  if (!t) return;
  t.ui.flush();
  const f = app.site.get(t.path);
  if (!f) return;
  const bytes = app.site.bytes(t.path)!;
  download(new Blob([bytes as BlobPart], { type: f.mime }), t.path.split('/').pop() || 'file');
  toast('A web page cannot start other programs, so QuillLoom saved a copy of this file for you to open in another editor. Bring the edited file back with File ▸ Import (same name replaces it).', { ms: 9000 });
}

async function tagLibraries(app: App): Promise<void> {
  const list = h('div', { class: 'ql-taglib', style: 'max-height:52vh;overflow:auto' });
  const search = h('input', { type: 'search', placeholder: 'Filter elements or attributes…', 'aria-label': 'Filter', style: 'width:100%;margin-bottom:6px' }) as HTMLInputElement;
  let close: (() => void) | null = null;
  const draw = () => {
    list.textContent = '';
    const q = search.value.trim().toLowerCase();
    for (const [tag, desc, attrs] of TAG_LIBRARY) {
      if (q && !(`${tag} ${desc} ${attrs.join(' ')}`).toLowerCase().includes(q)) continue;
      const ins = h('button', { class: 'ql-btn ql-sm', type: 'button', title: `Insert <${tag}>`, onclick: () => { close?.(); const v = /^(br|hr|img|input|meta|link|wbr|col|source|track|area|embed|base)$/.test(tag) ? `<${tag}>` : `<${tag}></${tag}>`; if (isText(app)) insertHtml(app, v); } }, 'Insert');
      list.appendChild(h('div', { class: 'ql-taglib-row', style: 'display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid var(--border)' },
        h('code', { style: 'min-width:90px' }, `<${tag}>`),
        h('span', { style: 'flex:1' }, desc, attrs.length ? h('span', { class: 'ql-help', style: 'display:block' }, attrs.join(', ')) : null),
        ins));
    }
  };
  search.addEventListener('input', draw);
  draw();
  const content = h('div', null, search, list, h('p', { class: 'ql-help' }, `Global attributes on every element: ${GLOBAL_ATTRS.join(', ')}; plus event handlers (onclick, onload…).`));
  await openDialog({ title: 'Tag Libraries', wide: true, content, cancel: false, ok: 'Close', onOpen: (ctl) => { close = () => ctl.close(null); setTimeout(() => search.focus(), 30); } });
}

// ==========================================================================================
// Commands

const hasTab = (app: App) => !!app.active;
const codeFocused = (app: App) => { const v = view(app); return !!v?.code && v.target === 'code' && v.code.hasFocus; };

def([
  {
    id: 'edit.undo', label: 'Undo', icon: 'undo', tab: 'Home', group: 'Undo', keys: ['Mod-z'], popular: true, noRecord: true, kind: 'split', origin: 'every editor',
    menu: (app) => { const hs = app.active?.history; if (!hs) return []; const out: MenuEntry[] = []; for (let i = hs.index, n = 1; i > 0 && n <= 20; i--, n++) out.push({ id: 'edit.undo', arg: n, label: hs.labels[i] || 'Edit' }); return out.length ? out : [{ label: 'Nothing to undo' }]; },
    run: (app, n?: number) => {
      if (codeFocused(app) && !n) { view(app)!.code!.cmd('undo'); view(app)!.flush(); return; }
      if (!app.active) return;
      for (let i = 0; i < (typeof n === 'number' ? n : 1); i++) app.undo();
    },
  },
  {
    id: 'edit.redo', label: 'Redo', icon: 'redo', tab: 'Home', group: 'Undo', keys: ['Mod-y', 'Mod-Shift-z'], popular: true, noRecord: true, origin: 'every editor',
    run: (app) => { if (codeFocused(app)) { view(app)!.code!.cmd('redo'); view(app)!.flush(); return; } if (app.active) app.redo(); },
  },
  { id: 'edit.repeat', label: 'Repeat', icon: 'repeat', tab: 'Home', group: 'Undo', noRecord: true, origin: 'Microsoft Office', tip: 'Run the last command again', run: (app) => { const l = app.lastCommand; if (l) app.exec(l.id, l.arg); else toast('There is no command to repeat yet.'); } },

  { id: 'edit.cut', label: 'Cut', icon: 'content_cut', tab: 'Home', group: 'Clipboard', keys: ['Mod-x'], popular: true, edits: true, isEnabled: isText, origin: 'every editor', run: (app) => copyCmd(app, true) },
  { id: 'edit.copy', label: 'Copy', icon: 'content_copy', tab: 'Home', group: 'Clipboard', keys: ['Mod-c'], popular: true, noRecord: true, isEnabled: isText, origin: 'every editor', run: (app) => copyCmd(app, false) },
  {
    id: 'edit.paste', label: 'Paste', icon: 'content_paste', tab: 'Home', group: 'Clipboard', keys: ['Mod-v'], popular: true, edits: true, kind: 'split', isEnabled: isText, origin: 'every editor',
    menu: () => [
      { id: 'edit.paste', label: 'Paste', icon: 'content_paste' },
      { id: 'edit.pasteSpecial', arg: 'html', label: 'Keep HTML Formatting', icon: 'html' },
      { id: 'edit.pasteSpecial', arg: 'word', label: 'Cleaned-Up HTML', icon: 'cleaning_services' },
      { id: 'edit.pasteText', label: 'Keep Text Only', icon: 'text_fields' },
      { id: 'edit.pasteSpecial', arg: 'paragraphs', label: 'Text as Paragraphs', icon: 'format_paragraph' },
      { separator: true }, { id: 'edit.pasteSpecial', label: 'Paste Special…', icon: 'content_paste_go' },
      { id: 'edit.officeClipboard', label: 'Clipboard Pane', icon: 'content_paste_search' },
    ],
    run: (app) => pasteCmd(app),
  },
  { id: 'edit.pasteText', label: 'Paste Text', icon: 'content_paste_go', tab: 'Home', group: 'Clipboard', keys: ['Mod-Shift-v'], edits: true, isEnabled: isText, origin: 'FrontPage, Expression Web', tip: 'Paste as plain text with line breaks', run: (app) => pasteCmd(app, 'breaks') },
  { id: 'edit.pasteSpecial', label: 'Paste Special…', icon: 'content_paste_go', tab: 'Home', group: 'Clipboard', keys: ['Mod-Alt-v'], edits: true, isEnabled: isText, origin: 'Microsoft Office, Dreamweaver', run: (app, arg) => pasteSpecial(app, arg) },
  { id: 'edit.officeClipboard', label: 'Clipboard', icon: 'content_paste_search', tab: 'Home', group: 'Clipboard', noRecord: true, origin: 'Microsoft Office Clipboard', tip: 'The last 24 things you copied; click one to paste it', run: (app) => { installRing(app); app.ui.togglePane('clipboard'); } },
  { id: 'edit.formatPainter', label: 'Format Painter', icon: 'format_paint', tab: 'Home', group: 'Clipboard', kind: 'toggle', edits: true, isEnabled: isPage, origin: 'Microsoft Office, FrontPage', tip: 'Copy the formatting of the selection, then select text or click an element to apply it', isActive: () => !!painter, run: (app) => formatPainter(app) },

  { id: 'edit.delete', label: 'Delete', icon: 'delete', tab: 'Home', group: 'Editing', edits: true, isEnabled: isText, origin: 'every editor', run: (app) => deleteCmd(app) },
  { id: 'edit.selectAll', label: 'Select All', icon: 'select_all', tab: 'Home', group: 'Editing', keys: ['Mod-a'], noRecord: true, isEnabled: isText, origin: 'every editor', run: (app) => selectAll(app) },
  { id: 'edit.find', label: 'Find', icon: 'search', tab: 'Home', group: 'Editing', keys: ['Mod-f'], popular: true, noRecord: true, origin: 'every editor', tip: 'Find in this page, the open pages or the whole site', run: (app) => openFind(app, {}) },
  { id: 'edit.replace', label: 'Replace', icon: 'find_replace', tab: 'Home', group: 'Editing', keys: ['Mod-h'], noRecord: true, origin: 'every editor', run: (app) => openFind(app, { replace: true }) },
  { id: 'edit.findInSite', label: 'Find in Site', icon: 'travel_explore', tab: 'Home', group: 'Editing', keys: ['Mod-Shift-f'], noRecord: true, origin: 'FrontPage, Expression Web, Dreamweaver', run: (app) => openFind(app, { scope: 'site' }) },
  { id: 'edit.findSelection', label: 'Find Selection', icon: 'manage_search', tab: 'Home', group: 'Editing', keys: ['Mod-F3'], noRecord: true, isEnabled: hasTab, origin: 'Visual Studio, Dreamweaver', run: (app) => { const s = selectionText(app).trim(); if (!s) { toast('Select the text to find first.'); return; } findState.query = s; findState.regex = false; findState.version++; findNext(app, 1); } },
  { id: 'edit.findNext', label: 'Find Next', icon: 'arrow_downward', tab: 'Home', group: 'Editing', keys: ['F3'], noRecord: true, isEnabled: hasTab, origin: 'every editor', run: (app) => findNext(app, 1) },
  { id: 'edit.findPrevious', label: 'Find Previous', icon: 'arrow_upward', tab: 'Home', group: 'Editing', keys: ['Shift-F3'], noRecord: true, isEnabled: hasTab, origin: 'every editor', run: (app) => findNext(app, -1) },
  { id: 'edit.goToLine', label: 'Go To Line…', icon: 'format_list_numbered', tab: 'Code', group: 'Edit', keys: ['Mod-g'], noRecord: true, isEnabled: isText, origin: 'Expression Web, Dreamweaver', run: (app, arg) => goToLine(app, arg) },
  { id: 'edit.goToFunction', label: 'Go To Function', icon: 'function', tab: 'Code', group: 'Edit', kind: 'menu', noRecord: true, isEnabled: isText, origin: 'Expression Web, Dreamweaver', tip: 'Jump to a script function, style rule or element id', menu: (app) => goToFunctionMenu(app), run: (app, arg) => goToFunction(app, arg) },
  { id: 'edit.history', label: 'History', icon: 'history', tab: 'Check', group: 'Compare', noRecord: true, origin: 'Dreamweaver (History panel)', tip: 'Every change to this page; click one to go back to it. Save snapshots to keep a version.', run: (app) => app.ui.togglePane('history') },
  { id: 'edit.followLink', label: 'Follow Hyperlink', icon: 'open_in_new', tab: 'Insert', group: 'Links', noRecord: true, isEnabled: isText, origin: 'FrontPage, Expression Web', tip: 'Open the page the link points to (or Ctrl+click it in Design view)', run: (app) => followLink(app) },
  { id: 'edit.externalEditor', label: 'Edit with External Editor', icon: 'launch', tab: 'Code', group: 'Edit', noRecord: true, isEnabled: hasTab, origin: 'Dreamweaver, Expression Web', run: (app) => externalEditor(app) },
  { id: 'edit.tagLibraries', label: 'Tag Libraries…', icon: 'library_books', tab: 'Code', group: 'Assist', noRecord: true, origin: 'Dreamweaver (Tag Library Editor)', tip: 'HTML elements and their attributes', run: (app) => tagLibraries(app) },
  { id: 'edit.tasks', label: 'Tasks', icon: 'task_alt', tab: 'Home', group: 'Editing', noRecord: true, origin: 'FrontPage', run: (app) => app.exec('site.tasks') },
]);


