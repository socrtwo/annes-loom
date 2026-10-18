/**
 * CSS commands (New Style, Attach Style Sheet, Manage/Apply Styles, design-time style sheets, media queries,
 * web fonts, custom properties, minify/format/prefix) and the helpers the Format commands and the style
 * panes share: the page's style sheets in cascade order, writing a sheet back, generated classes, and
 * applying a class or declarations to the selection in whichever view has focus.
 */
import { def, type MenuEntry } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog, promptDialog, setListOptions, toHex, alertDialog, type Field, type DialogControl } from '../ui/dialog';
import { escAttr, editHeadStyle, addStylesheet, removeStylesheet, setTagAttr, headInsert } from '../model/html';
import { resolveRef, relativeRef, isImagePath, extOf, baseName, normalizePath, isPagePath, stripExt } from '../model/paths';
import * as C from '../model/css';
import { isPage, isText, view, selectedEl, mutate, setStyleProp, styleOf, wrapTag } from '../editor/ops';
import { cacheFor } from '../editor/workspace';
import { pickFile } from '../ui/dom';
import '../ui/panesStyle';

// ------------------------------------------------------------------------------------------
// The application, for listeners that are not handed one (design-time style sheets).

let lastApp: App | null = null;
export const track = (app: App): App => { lastApp = app; return app; };
/** isEnabled for page commands (also remembers the app for frame listeners). */
export const pageOk = (app: App): boolean => { track(app); return isPage(app); };
export const textOk = (app: App): boolean => { track(app); return isText(app); };

// ------------------------------------------------------------------------------------------
// Style sheets of a page

export interface SheetRef {
  id: string;
  kind: 'page' | 'file';
  label: string;
  /** The page (for <style> blocks) or the .css file. */
  path: string;
  css: string;
  /** nth <style> block of the page (page sheets). */
  block: number;
  href?: string;
  /** The file that @imports this sheet. */
  via?: string;
}

/** The current text of a site file: the open tab's text when it is open. */
export function fileText(app: App, path: string): string {
  const t = app.docs.find((d) => d.path === path);
  return t ? t.source : app.site.read(path) ?? '';
}

const STYLE_SCAN = /<!--[\s\S]*?-->|<link\b[^>]*>|<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** Every style sheet that applies to a page, in cascade order (linked, @imported and <style> blocks). */
export function pageSheets(app: App, pagePath: string | undefined = app.active?.path, src?: string): SheetRef[] {
  if (!pagePath) return [];
  const text = src ?? fileText(app, pagePath);
  const out: SheetRef[] = [];
  const seen = new Set<string>();
  const addFile = (path: string, href: string, depth: number, via?: string) => {
    if (seen.has(path) || depth > 5) return;
    seen.add(path);
    const css = app.site.has(path) ? fileText(app, path) : null;
    if (css == null) return;
    for (const im of C.importsOf(css)) { const p = resolveRef(path, im.href); if (p) addFile(p, im.href, depth + 1, path); }
    out.push({ id: 'file:' + path, kind: 'file', label: path, path, css, block: -1, href, via });
  };
  let block = 0;
  for (const m of text.matchAll(STYLE_SCAN)) {
    const t = m[0];
    if (t.startsWith('<!--')) continue;
    if (/^<link/i.test(t)) {
      if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(t)) continue;
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(t)?.[1];
      const p = href ? resolveRef(pagePath, href) : null;
      if (p) addFile(p, href!, 0);
      continue;
    }
    const css = m[1] ?? '';
    for (const im of C.importsOf(css)) { const p = resolveRef(pagePath, im.href); if (p) addFile(p, im.href, 1, pagePath); }
    out.push({ id: `page:${block}`, kind: 'page', label: block ? `Current page (style block ${block + 1})` : 'Current page', path: pagePath, css, block });
    block++;
  }
  return out;
}

/** Replaces the CSS of the nth <style> block (counted as pageSheets counts them). */
export function replaceStyleBlock(src: string, index: number, css: string): string {
  let n = 0;
  for (const m of src.matchAll(STYLE_SCAN)) {
    if (!/^<style/i.test(m[0])) continue;
    if (n++ !== index) continue;
    const s = m.index! + m[0].indexOf('>') + 1;
    const e = m.index! + m[0].search(/<\/style\s*>$/i);
    return src.slice(0, s) + css + src.slice(e);
  }
  return editHeadStyle(src, () => css);
}

/** Edits a site file as one undoable step when it is open, else writes it directly. */
export function editFile(app: App, path: string, label: string, fn: (src: string) => string): boolean {
  const t = app.docs.find((d) => d.path === path);
  if (t) return app.editSource(label, fn, t);
  const src = app.site.read(path);
  if (src == null) return false;
  const out = fn(src);
  if (out === src) return false;
  app.site.write(path, out);
  return true;
}

export function writeFile(app: App, path: string, text: string, label: string): void {
  const t = app.docs.find((d) => d.path === path);
  if (t) app.commit(t, text, label);
  else app.site.write(path, text);
}

/** Path of indexes from <body> to an element, to find "the same" element after Design view reloads. */
function elPath(el: Element | null): number[] | null {
  const out: number[] = [];
  let n = el;
  while (n && n.parentElement && n.tagName !== 'BODY') {
    const kids = [...n.parentElement.children].filter((c) => !c.hasAttribute('data-ql-ui'));
    out.unshift(kids.indexOf(n));
    n = n.parentElement;
  }
  return n?.tagName === 'BODY' ? out : null;
}

/** Selects the element that was selected before Design view reloads, once it has. */
export function keepSelection(app: App): void {
  const d = app.active?.ui.design;
  if (!d?.doc) return;
  const before = d.doc;
  const path = elPath(d.selected);
  if (!path || !path.length) return;
  let tries = 0;
  const tick = () => {
    if (d.doc && d.doc !== before && d.doc.body) {
      let el: Element | null = d.doc.body;
      for (const i of path) { el = [...(el?.children || [])].filter((c) => !c.hasAttribute('data-ql-ui'))[i] || null; if (!el) break; }
      if (el) d.select(el);
      app.refresh();
      return;
    }
    if (++tries < 60) setTimeout(tick, 50);
  };
  setTimeout(tick, 30);
}

/** Shows style sheet changes in the active page's Design view. */
export function reloadDesign(app: App): void {
  const t = app.active;
  if (t?.kind !== 'page' || !t.ui) return;
  keepSelection(app);
  t.ui.invalidate();
  t.ui.layout();
}

/** Writes a changed sheet back: the page's <style> block, or the .css file (then Design view reloads). */
export function writeSheet(app: App, ref: SheetRef, css: string, label = 'Edit Style'): void {
  if (css === ref.css) return;
  if (ref.kind === 'page') {
    keepSelection(app);
    editFile(app, ref.path, label, (src) => replaceStyleBlock(src, ref.block, css));
    return;
  }
  app.active?.ui.flush();
  writeFile(app, ref.path, css, label);
  if (app.active?.path !== ref.path) reloadDesign(app);
}

/** Links a site style sheet to the active page when it is not linked yet. */
export function ensureLinked(app: App, cssPath: string, label = 'Attach Style Sheet'): boolean {
  const page = app.active?.path;
  if (!page || !isPagePath(page)) return false;
  if (pageSheets(app).some((s) => s.kind === 'file' && s.path === cssPath)) return false;
  keepSelection(app);
  return app.editSource(label, (src) => addStylesheet(src, relativeRef(page, cssPath)));
}

/** Changes CSS where the user chose to define it: 'page' (the head <style>) or a .css path (created if needed). */
export function writeToTarget(app: App, target: string, fn: (css: string) => string, label: string): void {
  if (target === 'page' || !target) {
    keepSelection(app);
    app.editSource(label, (src) => editHeadStyle(src, fn));
    return;
  }
  app.active?.ui.flush();
  const cur = app.site.has(target) ? fileText(app, target) : '';
  const out = fn(cur);
  if (out !== cur || !app.site.has(target)) writeFile(app, target, out, label);
  if (!ensureLinked(app, target)) reloadDesign(app);
}

export function cssFiles(app: App): string[] {
  return app.site.list((f) => extOf(f.path) === 'css').map((f) => f.path);
}

export function siteImages(app: App, from: string): string[] {
  return app.site.list((f) => isImagePath(f.path)).map((f) => `url("${relativeRef(from, f.path)}")`);
}

/** Classes defined by the page's sheets, with the first rule that defines each. */
export function definedClasses(app: App): { name: string; rule: C.CssRule; sheet: SheetRef }[] {
  const out: { name: string; rule: C.CssRule; sheet: SheetRef }[] = [];
  const seen = new Set<string>();
  for (const s of pageSheets(app)) {
    const sheet = C.parseCss(s.css);
    for (const r of sheet.rules) {
      for (const part of C.splitSelectors(r.selector)) {
        const m = /^(?:[a-z][\w-]*)?\.(-?[_a-zA-Z][\w-]*)$/.exec(part.trim());
        if (m && !seen.has(m[1])) { seen.add(m[1]); out.push({ name: m[1], rule: r, sheet: s }); }
      }
    }
    for (const c of C.classesIn(sheet)) if (!seen.has(c)) { const r = sheet.rules.find((x) => x.selector.includes('.' + c))!; seen.add(c); out.push({ name: c, rule: r, sheet: s }); }
  }
  return out;
}

/** Declarations that are safe to show in a preview swatch. */
export function previewStyle(rule: { decls: C.CssDecl[] } | null | undefined): string {
  if (!rule) return '';
  const ok = /^(color|background-color|background|font-family|font-weight|font-style|font-variant|text-decoration|text-transform|letter-spacing|border|border-(top|right|bottom|left|color|style|width|radius)|text-shadow|outline)$/;
  return rule.decls.filter((d) => ok.test(d.prop) && !/url\(/i.test(d.value)).map((d) => `${d.prop}:${d.value}`).join(';');
}

/** "style1", "style2"… the next generated class name unused in the page and its sheets. */
export function nextStyleName(app: App, base = 'style'): string {
  let max = 0;
  const re = new RegExp(`^${base}(\\d+)$`);
  for (const s of pageSheets(app)) for (const c of C.classesIn(s.css)) { const m = re.exec(c); if (m) max = Math.max(max, +m[1]); }
  const doc = view(app)?.design?.doc;
  doc?.querySelectorAll('[class]').forEach((e) => { for (const c of e.classList) { const m = re.exec(c); if (m) max = Math.max(max, +m[1]); } });
  for (const m of fileText(app, app.active?.path || '').matchAll(new RegExp(`class\\s*=\\s*["'][^"']*\\b${base}(\\d+)\\b`, 'g'))) max = Math.max(max, +m[1]);
  return `${base}${max + 1}`;
}

/** Sets one inline declaration, keeping values as written (colors stay as typed) and resource links in step. */
export function setInline(app: App, el: Element, prop: string, value: string | null): void {
  const cur = el.getAttribute('data-ql-o-style') ?? el.getAttribute('style') ?? '';
  const next = C.setStyleDecls(cur, { [prop]: value });
  if (next === cur.trim().replace(/;\s*$/, '') && el.hasAttribute('style')) return;
  if (/url\(/i.test(next) && app.active) { el.setAttribute('data-ql-o-style', next); el.setAttribute('style', cacheFor(app).css(next, app.active.path, 'blob')); return; }
  el.removeAttribute('data-ql-o-style');
  if (next) el.setAttribute('style', next); else el.removeAttribute('style');
}

export function addClass(el: Element, cls: string): void {
  const list = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  if (!list.includes(cls)) list.push(cls);
  el.setAttribute('class', list.join(' '));
}

export function removeClass(el: Element, cls: string): void {
  const list = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c && c !== cls);
  if (list.length) el.setAttribute('class', list.join(' ')); else el.removeAttribute('class');
}

/** True when a text selection covers the element's whole text (so formatting goes on the element). */
function coversElement(r: Range, el: Element): boolean {
  if (/^(IMG|HR|INPUT|VIDEO|AUDIO|IFRAME|OBJECT|EMBED|CANVAS|SELECT|TEXTAREA|BUTTON|TABLE)$/.test(el.tagName)) return true;
  return r.toString().replace(/\s+/g, ' ').trim() === (el.textContent || '').replace(/\s+/g, ' ').trim();
}

/** The selection as a part of one element (to wrap in a <span>), or null when formatting goes on the element. */
export function partialRange(app: App): Range | null {
  const d = view(app)?.design;
  const el = selectedEl(app);
  if (!d || !el) return null;
  const r = d.restoreRange();
  if (!r || r.collapsed || !d.doc!.body.contains(r.commonAncestorContainer)) return null;
  return coversElement(r, el) ? null : r;
}

/** Wraps a range in a new element (inside Design view) and selects it. */
function wrapRange(app: App, r: Range, tag = 'span'): HTMLElement {
  const doc = r.startContainer.ownerDocument!;
  const span = doc.createElement(tag);
  span.appendChild(r.extractContents());
  r.insertNode(span);
  view(app)?.design?.select(span, { contents: true });
  return span;
}

/** Applies declarations as a generated class rule in the page's <style> (cssMode "Classes"). */
export function applyAsClass(app: App, el: HTMLElement, props: Record<string, string | null>, label: string): void {
  const doc = el.ownerDocument;
  const sheets = pageSheets(app).filter((s) => s.kind === 'page');
  let cls = [...el.classList].find((c) => /^style\d+$/.test(c) && doc.querySelectorAll('.' + CSS.escape(c)).length === 1 && sheets.some((s) => C.findRules(s.css, '.' + c).length));
  const name = cls || nextStyleName(app);
  // The class carries the formatting, so the same properties leave the inline style (it would win).
  if (!mutate(app, () => { addClass(el, name); for (const p of Object.keys(props)) setInline(app, el, p, null); })) return;
  cls = name;
  keepSelection(app);
  app.editSource(label, (src) => editHeadStyle(src, (css) => C.setDeclarations(css, '.' + cls, props)));
}

/** Sets declarations on a Design view element: inline styles, or a generated class in "Classes" mode. */
export function applyProps(app: App, el: HTMLElement, props: Record<string, string | null>, label = 'Format'): void {
  if (app.prefs.cssMode === 'class') { applyAsClass(app, el, props, label); return; }
  mutate(app, () => { for (const [p, v] of Object.entries(props)) setInline(app, el, p, v); });
}

/**
 * Formats the selection: a partly selected element's text is wrapped in a <span>; otherwise the selected
 * element gets the declarations. In Code view the selection is wrapped in a <span>.
 */
export function styleSelection(app: App, props: Record<string, string | null>, label = 'Format'): void {
  const v = view(app);
  if (!v) return;
  const set = Object.fromEntries(Object.entries(props).filter(([, x]) => x != null && x !== '')) as Record<string, string>;
  if (v.target === 'code' || !v.design?.doc) {
    if (!Object.keys(set).length) { toast('Select formatted text in Design view to remove formatting.'); return; }
    if (app.prefs.cssMode === 'class') {
      const name = nextStyleName(app);
      wrapTag(app, 'span', { class: name });
      app.editSource(label, (src) => editHeadStyle(src, (css) => C.setDeclarations(css, '.' + name, set)));
    } else wrapTag(app, 'span', { style: C.objectToStyle(set) });
    return;
  }
  const r = partialRange(app);
  const el = selectedEl(app);
  if (!el) return;
  if (r) {
    if (!Object.keys(set).length) return;
    let span: HTMLElement | null = null;
    const ok = mutate(app, () => {
      span = wrapRange(app, r);
      for (const e of span.querySelectorAll<HTMLElement>('[style]')) for (const p of Object.keys(props)) setInline(app, e, p, null);
      if (app.prefs.cssMode !== 'class') for (const [p, x] of Object.entries(set)) setInline(app, span, p, x);
    });
    if (ok && span && app.prefs.cssMode === 'class') applyAsClass(app, span, set, label);
    return;
  }
  applyProps(app, el, props, label);
}

/** Toggles a class on the selection (Design view), or adds it to the selected tag (Code view). */
export function applyClass(app: App, cls: string | null, opts: { toggle?: boolean } = {}): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' || !v.design?.doc) {
    if (!cls || !v.code) return;
    const s = v.code.selection.text;
    const m = /^(\s*)(<[a-zA-Z][\w-]*\b(?:"[^"]*"|'[^']*'|[^'">])*>)/.exec(s);
    if (m) {
      const cur = /\bclass\s*=\s*["']([^"']*)["']/i.exec(m[2])?.[1] || '';
      const list = cur.split(/\s+/).filter(Boolean);
      if (!list.includes(cls)) list.push(cls);
      v.code.replaceSelection(m[1] + setTagAttr(m[2], 'class', list.join(' ')) + s.slice(m[0].length), true);
      v.flush();
    } else wrapTag(app, 'span', { class: cls });
    return;
  }
  const el = selectedEl(app);
  if (!el) return;
  const r = cls ? partialRange(app) : null;
  mutate(app, () => {
    if (!cls) { el.removeAttribute('class'); return; }
    if (r) { wrapRange(app, r).className = cls; return; }
    if (opts.toggle !== false && el.classList.contains(cls)) removeClass(el, cls); else addClass(el, cls);
  });
}

// ------------------------------------------------------------------------------------------
// Property fields shared by the style dialogs

export interface PropSpec { prop: string; label: string; type: 'combo' | 'select' | 'color' | 'text'; options?: string[]; cat?: string }

export const FONT_STACKS: string[] = [
  'Arial, Helvetica, sans-serif',
  '"Helvetica Neue", Helvetica, Arial, sans-serif',
  'Verdana, Geneva, sans-serif',
  'Tahoma, Geneva, sans-serif',
  '"Trebuchet MS", Helvetica, sans-serif',
  '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
  'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  'Georgia, "Times New Roman", Times, serif',
  '"Times New Roman", Times, serif',
  '"Palatino Linotype", "Book Antiqua", Palatino, serif',
  'Garamond, Baskerville, "Baskerville Old Face", serif',
  '"Courier New", Courier, monospace',
  '"Lucida Console", Monaco, monospace',
  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  '"Comic Sans MS", "Comic Sans", cursive',
  'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif',
];

const FONT_LIST_KEY = 'ql.fontList';
/** The font stacks offered in font menus: the user's list (Edit Font List) or the built-in web-safe stacks. */
export function fontList(): string[] {
  try { const raw = localStorage.getItem(FONT_LIST_KEY); const l = raw ? JSON.parse(raw) : null; if (Array.isArray(l) && l.length) return l.map(String); } catch { /* */ }
  return FONT_STACKS;
}
export function saveFontList(list: string[] | null): void {
  try { if (list && list.length) localStorage.setItem(FONT_LIST_KEY, JSON.stringify(list)); else localStorage.removeItem(FONT_LIST_KEY); } catch { /* */ }
}

export const FONT_SIZES = ['8px', '9px', '10px', '11px', '12px', '13px', '14px', '16px', '18px', '20px', '24px', '28px', '32px', '36px', '48px', '64px', '72px', '0.75em', '0.875em', '1em', '1.25em', '1.5em', '2em', '0.875rem', '1rem', '1.25rem', '1.5rem', '2rem', 'xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'smaller', 'larger'];
const LENGTHS = ['0', 'auto', '4px', '8px', '10px', '16px', '1em', '2em', '5%', '10%'];
const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'hidden'];

export const STYLE_CATEGORIES: Record<string, PropSpec[]> = {
  Font: [
    { prop: 'font-family', label: 'Font family', type: 'combo', options: FONT_STACKS },
    { prop: 'font-size', label: 'Font size', type: 'combo', options: FONT_SIZES },
    { prop: 'font-weight', label: 'Weight', type: 'select', options: ['normal', 'bold', 'bolder', 'lighter', '100', '200', '300', '400', '500', '600', '700', '800', '900'] },
    { prop: 'font-style', label: 'Style', type: 'select', options: ['normal', 'italic', 'oblique'] },
    { prop: 'font-variant', label: 'Variant', type: 'select', options: ['normal', 'small-caps'] },
    { prop: 'text-transform', label: 'Text transform', type: 'select', options: ['none', 'capitalize', 'uppercase', 'lowercase'] },
    { prop: 'color', label: 'Color', type: 'color' },
    { prop: 'text-decoration', label: 'Decoration', type: 'select', options: ['none', 'underline', 'overline', 'line-through', 'underline overline'] },
  ],
  Block: [
    { prop: 'line-height', label: 'Line height', type: 'combo', options: ['normal', '1', '1.2', '1.5', '1.75', '2'] },
    { prop: 'vertical-align', label: 'Vertical align', type: 'select', options: ['baseline', 'sub', 'super', 'top', 'text-top', 'middle', 'bottom', 'text-bottom'] },
    { prop: 'text-align', label: 'Text align', type: 'select', options: ['left', 'right', 'center', 'justify', 'start', 'end'] },
    { prop: 'text-indent', label: 'Text indent', type: 'combo', options: ['0', '1em', '2em', '20px'] },
    { prop: 'white-space', label: 'White space', type: 'select', options: ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'] },
    { prop: 'word-spacing', label: 'Word spacing', type: 'combo', options: ['normal', '0.1em', '0.25em', '2px'] },
    { prop: 'letter-spacing', label: 'Letter spacing', type: 'combo', options: ['normal', '0.05em', '0.1em', '1px', '2px'] },
  ],
  Background: [
    { prop: 'background-color', label: 'Background color', type: 'color' },
    { prop: 'background-image', label: 'Background image', type: 'combo', options: ['none'] },
    { prop: 'background-repeat', label: 'Repeat', type: 'select', options: ['repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round'] },
    { prop: 'background-attachment', label: 'Attachment', type: 'select', options: ['scroll', 'fixed', 'local'] },
    { prop: 'background-position', label: 'Position', type: 'combo', options: ['left top', 'center top', 'right top', 'center center', 'left bottom', 'right bottom', '50% 50%'] },
    { prop: 'background-size', label: 'Size', type: 'combo', options: ['auto', 'cover', 'contain', '100% auto'] },
  ],
  Border: [
    { prop: 'border-style', label: 'Border style', type: 'select', options: BORDER_STYLES },
    { prop: 'border-width', label: 'Border width', type: 'combo', options: ['thin', 'medium', 'thick', '1px', '2px', '3px', '4px'] },
    { prop: 'border-color', label: 'Border color', type: 'color' },
    { prop: 'border-radius', label: 'Corner radius', type: 'combo', options: ['0', '4px', '8px', '16px', '50%'] },
  ],
  Box: [
    { prop: 'margin', label: 'Margin', type: 'combo', options: ['0', 'auto', '0 auto', '1em 0', '10px'] },
    { prop: 'padding', label: 'Padding', type: 'combo', options: ['0', '4px', '8px', '1em', '10px 20px'] },
    { prop: 'box-sizing', label: 'Box sizing', type: 'select', options: ['content-box', 'border-box'] },
    { prop: 'box-shadow', label: 'Shadow', type: 'combo', options: ['none', '0 1px 3px rgba(0, 0, 0, 0.2)', '0 4px 12px rgba(0, 0, 0, 0.15)'] },
  ],
  Position: [
    { prop: 'position', label: 'Position', type: 'select', options: ['static', 'relative', 'absolute', 'fixed', 'sticky'] },
    { prop: 'top', label: 'Top', type: 'combo', options: LENGTHS },
    { prop: 'right', label: 'Right', type: 'combo', options: LENGTHS },
    { prop: 'bottom', label: 'Bottom', type: 'combo', options: LENGTHS },
    { prop: 'left', label: 'Left', type: 'combo', options: LENGTHS },
    { prop: 'width', label: 'Width', type: 'combo', options: ['auto', '100%', '50%', '200px', 'fit-content'] },
    { prop: 'height', label: 'Height', type: 'combo', options: ['auto', '100%', '200px'] },
    { prop: 'min-width', label: 'Min width', type: 'combo', options: ['0', '200px'] },
    { prop: 'max-width', label: 'Max width', type: 'combo', options: ['none', '100%', '960px', '1200px'] },
    { prop: 'z-index', label: 'Z-index', type: 'text' },
  ],
  Layout: [
    { prop: 'display', label: 'Display', type: 'select', options: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none', 'table', 'table-cell', 'list-item', 'contents'] },
    { prop: 'visibility', label: 'Visibility', type: 'select', options: ['visible', 'hidden', 'collapse'] },
    { prop: 'float', label: 'Float', type: 'select', options: ['none', 'left', 'right'] },
    { prop: 'clear', label: 'Clear', type: 'select', options: ['none', 'left', 'right', 'both'] },
    { prop: 'overflow', label: 'Overflow', type: 'select', options: ['visible', 'hidden', 'scroll', 'auto', 'clip'] },
    { prop: 'cursor', label: 'Cursor', type: 'select', options: ['auto', 'default', 'pointer', 'move', 'text', 'wait', 'help', 'not-allowed', 'crosshair'] },
    { prop: 'opacity', label: 'Opacity', type: 'combo', options: ['1', '0.75', '0.5', '0.25', '0'] },
  ],
  List: [
    { prop: 'list-style-type', label: 'Bullet type', type: 'select', options: ['disc', 'circle', 'square', 'decimal', 'decimal-leading-zero', 'lower-roman', 'upper-roman', 'lower-alpha', 'upper-alpha', 'lower-greek', 'none'] },
    { prop: 'list-style-image', label: 'Bullet image', type: 'combo', options: ['none'] },
    { prop: 'list-style-position', label: 'Bullet position', type: 'select', options: ['outside', 'inside'] },
  ],
  Table: [
    { prop: 'table-layout', label: 'Table layout', type: 'select', options: ['auto', 'fixed'] },
    { prop: 'border-collapse', label: 'Borders', type: 'select', options: ['separate', 'collapse'] },
    { prop: 'border-spacing', label: 'Border spacing', type: 'combo', options: ['0', '2px', '4px'] },
    { prop: 'empty-cells', label: 'Empty cells', type: 'select', options: ['show', 'hide'] },
    { prop: 'caption-side', label: 'Caption side', type: 'select', options: ['top', 'bottom'] },
  ],
};

/** Dialog fields for property specs. Colors get a text box and a picker; selects get "(not set)". */
export function propFields(specs: PropSpec[], values: Record<string, string>, opts: { visibleIf?: (spec: PropSpec) => ((v: Record<string, any>) => boolean) | undefined; images?: string[] } = {}): Field[] {
  const out: Field[] = [];
  for (const s of specs) {
    const vis = opts.visibleIf?.(s);
    const value = values[s.prop] ?? '';
    if (s.type === 'color') {
      out.push({ key: s.prop, label: s.label, type: 'text', value, placeholder: '#rrggbb, rgb() or a name', half: true, visibleIf: vis });
      out.push({ key: 'pick_' + s.prop, label: 'Pick', type: 'color', value: toHex(value) || '#000000', half: true, visibleIf: vis });
    } else if (s.type === 'select') {
      const o = [{ value: '', label: '(not set)' }, ...(s.options || []).map((x) => ({ value: x, label: x }))];
      if (value && !s.options?.includes(value)) o.push({ value, label: value });
      out.push({ key: s.prop, label: s.label, type: 'select', value, options: o, visibleIf: vis });
    } else {
      const options = /image$/.test(s.prop) && opts.images ? ['none', ...opts.images] : s.options;
      out.push({ key: s.prop, label: s.label, type: s.type === 'combo' ? 'combo' : 'text', value, options, visibleIf: vis });
    }
  }
  return out;
}

/** Copies a picked color into its text box. */
export function syncPicker(ctl: DialogControl, key: string, values: Record<string, any>): void {
  if (key.startsWith('pick_')) ctl.set(key.slice(5), values[key]);
}

export function collectProps(specs: PropSpec[], values: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of specs) { const v = String(values[s.prop] ?? '').trim(); if (v) out[s.prop] = v; }
  return out;
}

/** Declarations for a preview box (positioning left out so the sample stays in the box). */
export function previewHtml(props: Record<string, string>, text = 'AaBbYyGgLlJj 123'): string {
  const safe = Object.fromEntries(Object.entries(props).filter(([k]) => !/^(position|top|left|right|bottom|z-index|float|display|visibility|width|height|min-|max-)/.test(k)));
  const css = C.declText(safe);
  return `<div style="${escAttr(css)}">${text}</div>` + (Object.keys(props).length ? `<pre class="ql-help" style="white-space:pre-wrap;margin-top:8px">${C.declText(props, ';\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')};</pre>` : '');
}

/** The element's inline declarations as an object. */
export function inlineOf(el: Element | null): Record<string, string> {
  return el ? C.styleToObject(styleOf(el)) : {};
}

// ------------------------------------------------------------------------------------------
// New Style / Modify Style

export interface StyleDialogOpts {
  mode: 'new' | 'modify' | 'inline';
  title?: string;
  selector?: string;
  decls?: Record<string, string>;
  /** Modify: the sheet and the rule (index in that sheet's rules). */
  sheet?: SheetRef;
  ruleIndex?: number;
  media?: string;
  apply?: boolean;
  /** New Style from Selection: remove the element's inline style when the rule is written. */
  fromInline?: boolean;
  /** Category to show first. */
  category?: string;
}

const COMMON_SELECTORS = ['body', 'p', 'h1', 'h2', 'h3', 'a', 'a:link', 'a:visited', 'a:hover', 'a:active', 'ul', 'ol', 'li', 'table', 'td', 'th', 'img', 'blockquote', 'header', 'footer', 'nav', 'main', 'section', 'article', 'aside', '*', ':root'];

export const MEDIA_PRESETS = ['(max-width: 480px)', '(max-width: 767px)', '(max-width: 1023px)', '(min-width: 768px)', '(min-width: 1024px)', '(min-width: 1280px)', '(orientation: portrait)', '(orientation: landscape)', '(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)', 'print', 'screen'];

/** The Expression Web-style New Style / Modify Style dialog. Resolves true when something was written. */
export async function openStyleDialog(app: App, o: StyleDialogOpts): Promise<boolean> {
  const page = app.active?.path || '';
  const el = selectedEl(app);
  const sheets = pageSheets(app);
  const files = cssFiles(app);
  const linkedFile = sheets.find((s) => s.kind === 'file');
  const base = o.sheet?.kind === 'file' ? o.sheet.path : page;
  const images = siteImages(app, base);
  const initial = { ...(o.decls || {}) };
  const sugg = o.selector || (el && el.tagName !== 'BODY' && el.id ? `#${el.id}` : `.${nextStyleName(app, 'newStyle')}`);
  const selOptions = [...new Set([sugg, ...(el ? [el.tagName.toLowerCase(), ...[...el.classList].map((c) => '.' + c), ...(el.id ? ['#' + el.id] : [])] : []), ...sheets.flatMap((s) => C.listSelectors(s.css)), ...COMMON_SELECTORS])];
  const cats = Object.keys(STYLE_CATEGORIES);
  const firstCat = o.category || cats.find((c) => STYLE_CATEGORIES[c].some((s) => initial[s.prop])) || 'Font';
  const known = new Set(cats.flatMap((c) => STYLE_CATEGORIES[c].map((s) => s.prop)));
  const other = Object.entries(initial).filter(([k]) => !known.has(k)).map(([k, v]) => `${k}: ${v};`).join('\n');
  const fields: Field[] = [];
  if (o.mode !== 'inline') {
    fields.push({ key: 'selector', label: 'Selector', type: 'combo', value: sugg, options: selOptions, half: true, autofocus: true });
    if (o.mode === 'new') {
      fields.push({ key: 'defineIn', label: 'Define in', type: 'select', value: linkedFile ? 'existing' : 'page', options: [{ value: 'page', label: 'Current page' }, { value: 'existing', label: 'Existing style sheet' }, { value: 'new', label: 'New style sheet' }], half: true });
      fields.push({ key: 'sheet', label: 'Style sheet', type: 'select', value: linkedFile?.path || files[0] || '', options: files.length ? files : [{ value: '', label: '(no style sheets in the site)' }], visibleIf: (v) => v.defineIn === 'existing' });
      fields.push({ key: 'newSheet', label: 'New style sheet file', type: 'text', value: app.site.freeName('css', 'styles', 'css'), visibleIf: (v) => v.defineIn === 'new' });
      fields.push({ key: 'media', label: 'Only for media (optional)', type: 'combo', value: o.media || '', options: MEDIA_PRESETS, placeholder: 'All media' });
      fields.push({ key: 'apply', label: 'Apply new style to the selected element', type: 'checkbox', value: o.apply ?? !!(el && el.tagName !== 'BODY') });
      if (o.fromInline) fields.push({ key: 'removeInline', label: 'Remove the inline style from the element', type: 'checkbox', value: true });
    } else {
      fields.push({ key: 'info', type: 'info', label: `Defined in ${o.sheet?.label || 'the page'}${o.media ? ` (${o.media})` : ''}` });
    }
  }
  fields.push({ key: 'category', label: 'Category', type: 'select', value: firstCat, options: cats });
  for (const c of cats) fields.push(...propFields(STYLE_CATEGORIES[c], initial, { images, visibleIf: () => (v) => v.category === c }));
  fields.push({ key: 'other', label: 'Other properties (one per line)', type: 'textarea', rows: 3, value: other, placeholder: 'transition: color 0.2s;' });
  const allSpecs = cats.flatMap((c) => STYLE_CATEGORIES[c]);
  const gather = (v: Record<string, any>) => ({ ...collectProps(allSpecs, v), ...C.styleToObject(String(v.other || '').replace(/\n/g, ';')) });
  const v = await openDialog({
    title: o.title || (o.mode === 'new' ? 'New Style' : o.mode === 'inline' ? 'Modify Inline Style' : 'Modify Style'),
    fields, wide: true, preview: true,
    onChange: (vals, ctl, key) => { syncPicker(ctl, key, vals); ctl.setPreview(previewHtml(gather(ctl.values()))); },
    validate: (vals) => (o.mode !== 'inline' && !String(vals.selector || '').trim() ? 'Enter a selector.' : vals.defineIn === 'existing' && !vals.sheet ? 'There is no style sheet in the site; choose New style sheet.' : null),
  });
  if (!v) return false;
  const props = gather(v);
  // Properties that were set before and are now empty are removed.
  const changes: Record<string, string | null> = { ...props };
  for (const k of Object.keys(initial)) if (!(k in props)) changes[k] = null;
  const selector = String(v.selector || '').trim();
  if (o.mode === 'inline') {
    if (!el) return false;
    return mutate(app, () => { for (const [p, x] of Object.entries(changes)) setInline(app, el, p, x); });
  }
  if (o.mode === 'modify' && o.sheet && o.ruleIndex != null) {
    let css = o.sheet.css;
    for (const [p, x] of Object.entries(changes)) { const r = C.parseCss(css).rules[o.ruleIndex]; if (r) css = C.setDeclarationInRule(css, r, p, x); }
    const r = C.parseCss(css).rules[o.ruleIndex];
    if (r && !r.synthetic && C.normSelector(r.raw) !== C.normSelector(selector) && !r.nested) css = css.slice(0, r.selStart) + selector + css.slice(r.selEnd);
    writeSheet(app, o.sheet, css, 'Modify Style');
    return true;
  }
  // New style
  const target = v.defineIn === 'existing' ? String(v.sheet) : v.defineIn === 'new' ? normalizeCssPath(String(v.newSheet || 'styles.css')) : 'page';
  const media = String(v.media || '').trim() || null;
  if (v.apply && el && el.tagName !== 'BODY') {
    const m = /^(?:[a-z][\w-]*)?((?:\.-?[_a-zA-Z][\w-]*)+)$/i.exec(selector) || null;
    const id = /^(?:[a-z][\w-]*)?#(-?[_a-zA-Z][\w-]*)$/i.exec(selector)?.[1];
    if (m || id || v.removeInline) {
      mutate(app, () => {
        if (m) for (const c of m[1].split('.').filter(Boolean)) addClass(el, c);
        if (id) el.id = id;
        if (v.removeInline) for (const p of Object.keys(props)) setInline(app, el as HTMLElement, p, null);
      });
    }
  }
  const rebased = target === 'page' ? props : Object.fromEntries(Object.entries(props).map(([k, x]) => [k, C.rebaseCssUrls(x, page, target)]));
  writeToTarget(app, target, (css) => C.setDeclarations(css, selector, rebased, media), 'New Style');
  return true;
}

function normalizeCssPath(p: string): string {
  let s = normalizePath(p.trim());
  if (!/\.css$/i.test(s)) s += '.css';
  return s;
}

/** "New Style from Selection": the selected element's inline style becomes a new rule. */
export function newStyleFromSelection(app: App): Promise<boolean> | void {
  const el = selectedEl(app);
  if (!el) { toast('Select an element in Design view first.'); return; }
  const decls = inlineOf(el);
  const tag = el.tagName.toLowerCase();
  const selector = el.id ? `#${el.id}` : `.${nextStyleName(app, tag === 'span' || tag === 'div' ? 'style' : tag + '-style')}`;
  return openStyleDialog(app, { mode: 'new', title: 'New Style from Selection', selector, decls, apply: true, fromInline: Object.keys(decls).length > 0 });
}

/** The style dialog for the selected element's own (inline) style. */
export function elementStyleDialog(app: App): Promise<boolean> | void {
  const el = selectedEl(app);
  if (!el) { toast('Select an element in Design view first.'); return; }
  return openStyleDialog(app, { mode: 'inline', title: `Style: <${el.tagName.toLowerCase()}>`, decls: inlineOf(el) });
}

/** Modify Style for a rule of one of the page's sheets. */
export function modifyRule(app: App, sheet: SheetRef, ruleIndex: number): Promise<boolean> | void {
  const r = C.parseCss(sheet.css).rules[ruleIndex];
  if (!r) return;
  return openStyleDialog(app, { mode: 'modify', selector: r.selector, decls: C.declMap(r), sheet, ruleIndex, media: r.media.join(' ') });
}

// ------------------------------------------------------------------------------------------
// Pages and targets for multi-page commands

export function pickPages(app: App, scope: string, selected?: string[]): string[] {
  if (scope === 'all') return app.site.pages().map((f) => f.path).filter((p) => !/\.(lbi|dwt)$/i.test(p));
  if (scope === 'selected') return selected || [];
  return app.active?.path ? [app.active.path] : [];
}

const SCOPE_FIELD = (extra = true): Field => ({ key: 'scope', label: 'Apply to', type: 'radio', value: 'current', options: [{ value: 'current', label: 'Current page' }, { value: 'all', label: 'All pages' }, ...(extra ? [{ value: 'selected', label: 'Selected pages' }] : [])] });

// ------------------------------------------------------------------------------------------
// Transforms on the current style sheet or the page's <style> blocks

function transformStyles(app: App, label: string, fn: (css: string, path: string) => string): void {
  const t = app.active;
  if (!t) return;
  if (extOf(t.path) === 'css') { app.editSource(label, (src) => fn(src, t.path)); return; }
  if (t.kind !== 'page') { toast('Open a style sheet or a page with styles.'); return; }
  let n = 0;
  const changed = app.editSource(label, (src) => src.replace(STYLE_SCAN, (m, css) => { if (!/^<style/i.test(m)) return m; n++; const s = m.indexOf('>') + 1; const e = m.search(/<\/style\s*>$/i); return m.slice(0, s) + fn(css ?? '', t.path) + m.slice(e); }));
  if (!n) toast('This page has no <style> block. Open a .css file to work on a style sheet.');
  else if (!changed) toast('Nothing to change.');
}

/** Removes the common indentation of CSS taken out of an indented <style> block. */
export function dedent(css: string): string {
  const lines = css.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return lines.map((l) => l.slice(Math.min(ind, /^[ \t]*/.exec(l)![0].length))).join('\n');
}

function indentBlock(css: string, srcAround: string): string {
  const ind = /\n([ \t]*)<\/style/i.exec(srcAround)?.[1] ?? '  ';
  return '\n' + css.trim().split('\n').map((l) => (l ? ind + '  ' + l : l)).join('\n') + '\n' + ind;
}

// ------------------------------------------------------------------------------------------
// Design-time style sheets (shown only in Design view)

const DT_KEY = 'designTimeSheets';
function designTimeMap(app: App): Record<string, string[]> {
  try { return JSON.parse(app.site.data.meta[DT_KEY] || '{}') || {}; } catch { return {}; }
}
export function designTimeFor(app: App, page: string): string[] {
  const m = designTimeMap(app);
  return [...new Set([...(m['*'] || []), ...(m[page] || [])])].filter((p) => app.site.has(p));
}

export function injectDesignTime(app: App, doc: Document | null | undefined, page: string): void {
  if (!doc?.head) return;
  doc.querySelectorAll('link[data-ql-dt]').forEach((l) => l.remove());
  for (const p of designTimeFor(app, page)) {
    const url = cacheFor(app).url(p, 'blob');
    if (!url) continue;
    const l = doc.createElement('link');
    l.rel = 'stylesheet';
    l.href = url;
    l.setAttribute('data-ql-ui', '');
    l.setAttribute('data-ql-dt', p);
    doc.head.appendChild(l);
  }
}

if (typeof document !== 'undefined') {
  // Design view frames fire "load" when a page is shown; add the page's design-time sheets then.
  document.addEventListener('load', (e) => {
    const f = e.target as HTMLIFrameElement;
    const app = lastApp;
    if (!app || !(f instanceof HTMLIFrameElement) || !f.classList.contains('ql-design-frame')) return;
    const tab = app.docs.find((d) => d.ui?.design?.frame === f);
    if (tab && designTimeFor(app, tab.path).length) setTimeout(() => injectDesignTime(app, f.contentDocument, tab.path), 0);
  }, true);
}

// ------------------------------------------------------------------------------------------
// Rule editor (the Composer-family CSS editor)

async function ruleEditor(app: App): Promise<void> {
  const sheets = pageSheets(app);
  if (!sheets.length) { if (await confirmDialog('CSS Editor', 'This page has no styles yet. Create a style block in the page?', 'Create')) app.exec('css.newStyle'); return; }
  let sheetIdx = 0;
  const rulesOf = (i: number) => C.parseCss(sheets[i]?.css || '').rules;
  const opts = (i: number) => rulesOf(i).map((r, k) => ({ value: String(k), label: (r.media.length ? r.media.join(' ') + ' › ' : '') + r.selector }));
  const bodyOf = (i: number, k: number) => { const r = rulesOf(i)[k]; return r ? r.decls.map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''};`).join('\n') : ''; };
  await openDialog({
    title: 'CSS Editor', wide: true, ok: 'Close', cancel: false,
    fields: [
      { key: 'sheet', label: 'Style sheet', type: 'select', value: '0', options: sheets.map((s, i) => ({ value: String(i), label: s.label })) },
      { key: 'rule', label: 'Rules', type: 'list', rows: 10, options: opts(0), value: '0' },
      { key: 'body', label: 'Declarations', type: 'textarea', rows: 10, value: bodyOf(0, 0) },
      { key: 'apply', label: 'Apply Changes', type: 'button', onClick: (vals) => {
        const s = sheets[+vals.sheet];
        const r = C.parseCss(s.css).rules[+vals.rule];
        if (!s || !r) return;
        const css = C.replaceRuleBody(s.css, r, String(vals.body || '').replace(/\n/g, ' '));
        writeSheet(app, s, css, 'Edit Rule');
        s.css = css;
        toast(`Updated ${r.selector}`);
      } },
      { key: 'modify', label: 'Modify Style…', type: 'button', onClick: (vals, ctl) => { ctl.close(); void modifyRule(app, sheets[+vals.sheet], +vals.rule); } },
      { key: 'newRule', label: 'New Style…', type: 'button', onClick: (vals, ctl) => { ctl.close(); app.exec('css.newStyle'); } },
    ],
    onChange: (vals, ctl, key) => {
      if (key === 'sheet') { sheetIdx = +vals.sheet; setListOptions(ctl, 'rule', opts(sheetIdx), '0'); ctl.set('body', bodyOf(sheetIdx, 0)); }
      if (key === 'rule') ctl.set('body', bodyOf(+vals.sheet, +vals.rule));
    },
  });
}

// ------------------------------------------------------------------------------------------
// Commands

const sheetOptions = (sheets: SheetRef[]) => sheets.map((s, i) => ({ value: String(i), label: s.label }));

def([
  {
    id: 'css.newStyle', label: 'New Style…', icon: 'add_box', tab: 'Design', group: 'CSS', edits: true, popular: true,
    origin: 'Expression Web', keywords: 'css rule selector class define', tip: 'Create a CSS rule in the page or a style sheet',
    isEnabled: pageOk, run: (app) => openStyleDialog(app, { mode: 'new' }),
  },
  {
    id: 'css.newStyleFromSelection', label: 'New Style from Selection…', icon: 'library_add', tab: 'Design', group: 'CSS', edits: true,
    origin: 'Dreamweaver', keywords: 'css rule from inline style', isEnabled: pageOk, run: (app) => newStyleFromSelection(app),
  },
  {
    id: 'css.attachStyleSheet', label: 'Attach Style Sheet…', icon: 'attach_file', tab: 'Design', group: 'CSS', edits: true,
    origin: 'Expression Web, FrontPage, Dreamweaver', keywords: 'link css import stylesheet',
    isEnabled: pageOk,
    run: async (app, arg) => {
      const files = cssFiles(app);
      const pages = app.site.pages().map((f) => f.path);
      const v = arg && typeof arg === 'object' ? arg : await openDialog({
        title: 'Attach Style Sheet',
        fields: [
          { key: 'href', label: 'Style sheet', type: 'combo', value: files[0] || 'css/styles.css', options: files, help: 'A site path or a full address. A new site file is created when it does not exist.' },
          SCOPE_FIELD(),
          { key: 'pages', label: 'Pages', type: 'list', multiple: true, rows: 6, options: pages, value: app.active?.path ? [app.active.path] : [], visibleIf: (x) => x.scope === 'selected' },
          { key: 'method', label: 'Attach as', type: 'radio', value: 'link', options: [{ value: 'link', label: 'Link (<link>)' }, { value: 'import', label: 'Import (@import)' }] },
          { key: 'media', label: 'Media (optional)', type: 'combo', value: '', options: ['screen', 'print', '(max-width: 767px)'] },
        ],
      });
      if (!v || !String(v.href || '').trim()) return;
      const href = String(v.href).trim();
      const external = /^(https?:)?\/\//i.test(href);
      const path = external ? null : normalizeCssPath(href);
      if (path && !app.site.has(path)) app.site.write(path, `/* ${baseName(path)} */\n`);
      const targets = pickPages(app, v.scope || 'current', v.pages);
      let n = 0;
      for (const p of targets) {
        const ref = path ? relativeRef(p, path) : href;
        const ok = editFile(app, p, 'Attach Style Sheet', (src) => v.method === 'import'
          ? (pageSheets(app, p, src).some((s) => s.kind === 'file' && s.path === path) ? src : editHeadStyle(src, (css) => `\n@import url("${ref}")${v.media ? ' ' + v.media : ''};` + (css.startsWith('\n') ? css : '\n' + css)))
          : addStylesheet(src, ref, v.media || undefined));
        if (ok) n++;
      }
      toast(n ? `Attached ${href} to ${n} page${n === 1 ? '' : 's'}.` : 'The style sheet was already attached.');
    },
  },
  {
    id: 'css.detachStyleSheet', label: 'Detach Style Sheet…', icon: 'link_off', tab: 'Design', group: 'CSS', edits: true,
    origin: 'Expression Web, KompoZer', keywords: 'unlink remove css', isEnabled: pageOk,
    run: async (app) => {
      const src = fileText(app, app.active.path);
      const links = [...src.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /stylesheet/i.test(t)).map((t) => /href\s*=\s*["']([^"']+)["']/i.exec(t)?.[1] || '').filter(Boolean);
      const imports = C.importsOf((src.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) || []).join('\n').replace(/<\/?style[^>]*>/gi, '')).map((i) => i.href);
      const all = [...links.map((h) => ({ value: 'link:' + h, label: h })), ...imports.map((h) => ({ value: 'import:' + h, label: `${h} (@import)` }))];
      if (!all.length) { toast('No style sheet is attached to this page.'); return; }
      const v = await openDialog({ title: 'Detach Style Sheet', fields: [{ key: 'which', label: 'Style sheet', type: 'list', rows: 6, options: all, value: all[0].value }, SCOPE_FIELD(false)] });
      if (!v?.which) return;
      const [kind, href] = [v.which.slice(0, v.which.indexOf(':')), v.which.slice(v.which.indexOf(':') + 1)];
      const target = resolveRef(app.active.path, href);
      let n = 0;
      for (const p of pickPages(app, v.scope)) {
        const ref = target ? relativeRef(p, target) : href;
        const ok = editFile(app, p, 'Detach Style Sheet', (s) => {
          if (kind === 'link') return removeStylesheet(removeStylesheet(s, ref), href);
          return s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (blk) => blk.replace(new RegExp(`[ \\t]*@import\\s+(?:url\\(\\s*)?["']?${(p === app.active.path ? href : ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*\\)?[^;]*;[ \\t]*\\r?\\n?`, 'g'), ''));
        });
        if (ok) n++;
      }
      toast(n ? `Detached ${href} from ${n} page${n === 1 ? '' : 's'}.` : 'Nothing was detached.');
    },
  },
  { id: 'css.manageStyles', label: 'Manage Styles', icon: 'format_list_bulleted', tab: 'Design', group: 'CSS', noRecord: true, origin: 'Expression Web', keywords: 'rules sheets panel', run: (app) => { track(app); app.ui.togglePane('manageStyles'); } },
  { id: 'css.applyStyles', label: 'Apply Styles', icon: 'format_paint', tab: 'Design', group: 'CSS', noRecord: true, origin: 'Expression Web', keywords: 'classes panel', run: (app) => { track(app); app.ui.togglePane('applyStyles'); } },
  {
    id: 'css.classGallery', label: 'Classes', icon: 'style', tab: 'Home', group: 'Styles', kind: 'gallery', edits: true,
    origin: 'Expression Web (Style Application toolbar), Dreamweaver (Class menu)', keywords: 'apply class style gallery',
    isEnabled: pageOk,
    menu: (app) => {
      track(app);
      const el = selectedEl(app);
      const list = isPage(app) ? definedClasses(app) : [];
      const entries: MenuEntry[] = list.map((c) => ({ id: 'css.classGallery', arg: c.name, label: '.' + c.name, preview: previewStyle(c.rule), checked: !!el?.classList?.contains(c.name) }));
      if (!entries.length) entries.push({ heading: 'No classes yet: use New Style' });
      entries.push({ separator: true }, { id: 'css.classGallery', arg: null, label: 'Clear Classes', icon: 'format_clear' }, { id: 'css.newStyle', label: 'New Style…', icon: 'add_box' }, { id: 'css.applyStyles', label: 'Apply Styles Panel', icon: 'format_paint' });
      return entries;
    },
    run: (app, arg) => { if (arg === undefined) { app.ui.togglePane('applyStyles'); return; } applyClass(app, arg); },
  },
  {
    id: 'css.inlineToRule', label: 'Inline Style to Rule…', icon: 'move_up', tab: 'Design', group: 'CSS', edits: true,
    origin: 'Dreamweaver (Convert Inline CSS to Rule)', keywords: 'convert inline css class', isEnabled: pageOk,
    run: async (app) => {
      const el = selectedEl(app);
      const decls = inlineOf(el);
      if (!el || !Object.keys(decls).length) { toast('Select an element that has an inline style.'); return; }
      const files = cssFiles(app);
      const tag = el.tagName.toLowerCase();
      const v = await openDialog({
        title: 'Convert Inline Style to Rule',
        fields: [
          { key: 'selector', label: 'New rule', type: 'combo', value: el.id ? `#${el.id}` : `.${nextStyleName(app)}`, options: [`.${nextStyleName(app)}`, tag, ...(el.id ? ['#' + el.id] : [])] },
          { key: 'defineIn', label: 'Define in', type: 'select', value: 'page', options: [{ value: 'page', label: 'Current page' }, ...files.map((f) => ({ value: f, label: f }))] },
          { key: 'info', type: 'info', label: C.declText(decls) },
        ],
      });
      if (!v?.selector) return;
      const sel = String(v.selector).trim();
      const cls = /^\.(-?[_a-zA-Z][\w-]*)$/.exec(sel)?.[1];
      const id = /^#(-?[_a-zA-Z][\w-]*)$/.exec(sel)?.[1];
      mutate(app, () => { el.removeAttribute('style'); el.removeAttribute('data-ql-o-style'); if (cls) addClass(el, cls); if (id) el.id = id; });
      const target = String(v.defineIn);
      const vals = target === 'page' ? decls : Object.fromEntries(Object.entries(decls).map(([k, x]) => [k, C.rebaseCssUrls(x, app.active.path, target)]));
      writeToTarget(app, target, (css) => C.setDeclarations(css, sel, vals), 'Inline Style to Rule');
    },
  },
  {
    id: 'css.moveRules', label: 'Move CSS Rules…', icon: 'drive_file_move', tab: 'Design', group: 'CSS', edits: true,
    origin: 'Dreamweaver, Expression Web', keywords: 'move rules external style sheet', isEnabled: pageOk,
    run: async (app) => {
      const sheets = pageSheets(app);
      if (!sheets.length) { toast('This page has no styles to move.'); return; }
      const files = cssFiles(app);
      const ruleOpts = (i: number) => C.parseCss(sheets[i]?.css || '').rules.filter((r) => !r.nested).map((r) => ({ value: String(r.index), label: (r.media.length ? r.media.join(' ') + ' › ' : '') + r.selector }));
      const v = await openDialog({
        title: 'Move CSS Rules', wide: true,
        fields: [
          { key: 'from', label: 'From', type: 'select', value: '0', options: sheetOptions(sheets) },
          { key: 'rules', label: 'Rules (select one or more)', type: 'list', multiple: true, rows: 8, options: ruleOpts(0) },
          { key: 'to', label: 'To', type: 'select', value: sheets[0].kind === 'page' ? (files[0] || '__new') : 'page', options: [{ value: 'page', label: 'Current page' }, ...files.map((f) => ({ value: f, label: f })), { value: '__new', label: 'New style sheet…' }] },
          { key: 'newSheet', label: 'New style sheet file', type: 'text', value: app.site.freeName('css', 'styles', 'css'), visibleIf: (x) => x.to === '__new' },
        ],
        onChange: (vals, ctl, key) => { if (key === 'from') setListOptions(ctl, 'rules', ruleOpts(+vals.from)); },
      });
      if (!v || !v.rules?.length) return;
      const from = sheets[+v.from];
      const to = v.to === '__new' ? normalizeCssPath(v.newSheet) : String(v.to);
      if ((to === 'page' && from.kind === 'page') || to === from.path) { toast('Choose a different destination.'); return; }
      const sheet = C.parseCss(from.css);
      const picked = (v.rules as string[]).map((i) => sheet.rules[+i]).filter(Boolean);
      const fromFile = from.kind === 'page' ? from.path : from.path;
      const toFile = to === 'page' ? app.active.path : to;
      const text = picked.map((r) => C.rebaseCssUrls(C.ruleText(from.css, r), fromFile, toFile)).join('\n\n');
      let rest = from.css;
      for (const r of [...picked].sort((a, b) => b.start - a.start)) rest = C.removeRule(rest, r);
      writeToTarget(app, to, (css) => C.addRuleText(css, (ind) => text.split('\n').map((l) => (l ? ind + l : l)).join('\n')), 'Move CSS Rules');
      writeSheet(app, { ...from, css: pageSheets(app).find((s) => s.id === from.id)?.css ?? from.css }, C.removeEmptyBlocks(rest), 'Move CSS Rules');
      toast(`Moved ${picked.length} rule${picked.length === 1 ? '' : 's'}.`);
    },
  },
  {
    id: 'css.exportStyles', label: 'Export Page Styles…', icon: 'output', tab: 'Design', group: 'CSS', edits: true,
    origin: 'Dreamweaver (Export CSS Styles), Expression Web', keywords: 'external style sheet extract', isEnabled: pageOk,
    run: async (app) => {
      const page = app.active.path;
      const blocks = pageSheets(app).filter((s) => s.kind === 'page');
      if (!blocks.length || !blocks.some((b) => b.css.trim())) { toast('This page has no <style> block to export.'); return; }
      const path = await promptDialog('Export Page Styles', 'New style sheet file', app.site.freeName('css', stripExt(baseName(page)) || 'styles', 'css'));
      if (!path) return;
      const target = normalizeCssPath(path);
      const css = blocks.map((b) => C.rebaseCssUrls(dedent(b.css), page, target)).join('\n\n') + '\n';
      app.active.ui.flush();
      const existing = app.site.has(target) ? fileText(app, target) : '';
      writeFile(app, target, existing ? existing.replace(/\s*$/, '\n\n') + css : css, 'Export Page Styles');
      app.editSource('Export Page Styles', (src) => {
        const out = src.replace(/[ \t]*<style\b(?![^>]*\bmedia=)[^>]*>[\s\S]*?<\/style>[ \t]*\r?\n?/gi, (m) => (/<style/i.test(m) ? '' : m));
        return addStylesheet(out, relativeRef(page, target));
      });
      toast(`Styles moved to ${target}.`);
    },
  },
  {
    id: 'css.designTime', label: 'Design-Time Style Sheets…', icon: 'preview', tab: 'Design', group: 'CSS', edits: true,
    origin: 'Dreamweaver', keywords: 'design time stylesheet editing only', isEnabled: pageOk,
    run: async (app) => {
      const page = app.active.path;
      const map = designTimeMap(app);
      const files = cssFiles(app);
      if (!files.length) { toast('Add a .css file to the site first.'); return; }
      const v = await openDialog({
        title: 'Design-Time Style Sheets',
        help: 'These style sheets are shown only in Design view, to make editing easier. They are not linked to the page and are never published with it.',
        fields: [
          { key: 'sheets', label: 'Show during editing', type: 'list', multiple: true, rows: 8, options: files, value: [...(map[page] || []), ...(map['*'] || [])] },
          { key: 'scope', label: 'For', type: 'radio', value: map['*']?.length ? 'all' : 'current', options: [{ value: 'current', label: 'This page' }, { value: 'all', label: 'Every page' }] },
        ],
      });
      if (!v) return;
      const list = (v.sheets as string[]) || [];
      if (v.scope === 'all') { map['*'] = list; delete map[page]; } else { map[page] = list; if (map['*']) map['*'] = map['*'].filter((p) => !list.includes(p)); }
      for (const k of Object.keys(map)) if (!map[k]?.length) delete map[k];
      app.site.data.meta[DT_KEY] = JSON.stringify(map);
      app.site.touchMeta();
      for (const d of app.docs) if (d.ui?.design?.doc) injectDesignTime(app, d.ui.design.doc, d.path);
      toast(list.length ? `${list.length} design-time style sheet${list.length === 1 ? '' : 's'} on.` : 'Design-time style sheets off.');
    },
  },
  {
    id: 'css.mediaQueries', label: 'Media Queries…', icon: 'devices', tab: 'Design', group: 'Responsive', edits: true,
    origin: 'Dreamweaver', keywords: 'responsive breakpoint @media', isEnabled: pageOk,
    run: async (app) => {
      const sheets = pageSheets(app);
      const opts: { value: string; label: string }[] = [...sheetOptions(sheets), { value: 'page', label: sheets.some((s) => s.kind === 'page') ? 'Current page (first style block)' : 'Current page (new style block)' }];
      const mediaOf = (k: string) => (k === 'page' ? C.listMedia(sheets.find((s) => s.kind === 'page')?.css || '') : C.listMedia(sheets[+k]?.css || '')).filter((m) => m.startsWith('@media'));
      const first = sheets.findIndex((s) => s.kind === 'file');
      const start = first >= 0 ? String(first) : 'page';
      const existing = (k: string) => [{ value: '', label: '(new media query)' }, ...mediaOf(k).map((m) => ({ value: m, label: m }))];
      const v = await openDialog({
        title: 'Media Queries', wide: true,
        fields: [
          { key: 'sheet', label: 'Style sheet', type: 'select', value: start, options: opts },
          { key: 'existing', label: 'Media queries in this sheet', type: 'list', rows: 5, options: existing(start), value: '' },
          { key: 'condition', label: 'Condition', type: 'combo', value: '(max-width: 767px)', options: MEDIA_PRESETS, help: 'Change the condition of the chosen query, or enter one for a new query.' },
          { key: 'selector', label: 'Add a rule (selector, optional)', type: 'combo', value: '', options: COMMON_SELECTORS },
          { key: 'decls', label: 'Declarations', type: 'textarea', rows: 3, value: '', placeholder: 'font-size: 14px;' },
          { key: 'viewport', label: 'Add the viewport meta tag when missing', type: 'checkbox', value: true },
        ],
        onChange: (vals, ctl, key) => {
          if (key === 'sheet') setListOptions(ctl, 'existing', existing(vals.sheet), '');
          if (key === 'existing' && vals.existing) ctl.set('condition', String(vals.existing).replace(/^@media\s*/, ''));
        },
      });
      if (!v) return;
      const cond = String(v.condition || '').trim();
      if (!cond) return;
      const props = C.styleToObject(String(v.decls || '').replace(/\n/g, ';'));
      const sel = String(v.selector || '').trim();
      const apply = (css: string) => {
        let out = css;
        if (v.existing && C.normMedia(v.existing) !== C.normMedia(cond)) out = C.renameAtRule(out, v.existing, cond);
        if (sel && Object.keys(props).length) out = C.setDeclarations(out, sel, props, cond);
        else if (sel) out = C.addRuleText(out, (i) => `${i}${sel} {\n${i}}`, cond);
        else if (!C.listMedia(out).some((m) => C.normMedia(m) === C.normMedia(cond))) out = C.addRuleText(out, (i) => `${i}/* Rules for ${cond} */`, cond);
        return out;
      };
      if (v.sheet === 'page') writeToTarget(app, 'page', apply, 'Media Query');
      else writeSheet(app, sheets[+v.sheet], apply(sheets[+v.sheet].css), 'Media Query');
      if (v.viewport) editFile(app, app.active.path, 'Media Query', (src) => (/<meta[^>]+name\s*=\s*["']viewport/i.test(src) ? src : headInsert(src, '<meta name="viewport" content="width=device-width, initial-scale=1">')));
    },
  },
  {
    id: 'css.webFonts', label: 'Web Fonts…', icon: 'font_download', tab: 'Design', group: 'Typography', edits: true,
    origin: 'Dreamweaver (Manage Fonts)', keywords: '@font-face woff2 ttf upload font', isEnabled: pageOk,
    run: async (app) => {
      const files = await pickFile('.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf', true);
      if (!files.length) return;
      const guess = stripExt(files[0].name).replace(/[-_](regular|bold|italic|light|medium|semibold|black|thin|\d{3})+$/i, '').replace(/[-_]+/g, ' ').trim();
      const sheets = pageSheets(app);
      const v = await openDialog({
        title: 'Add Web Font',
        fields: [
          { key: 'family', label: 'Font family name', type: 'text', value: guess || 'My Font' },
          { key: 'weight', label: 'Weight', type: 'select', value: /bold/i.test(files[0].name) ? '700' : '400', options: ['100', '200', '300', '400', '500', '600', '700', '800', '900', '100 900'] },
          { key: 'style', label: 'Style', type: 'select', value: /italic/i.test(files[0].name) ? 'italic' : 'normal', options: ['normal', 'italic'] },
          { key: 'folder', label: 'Save fonts in folder', type: 'text', value: 'fonts' },
          { key: 'sheet', label: 'Add @font-face to', type: 'select', value: sheets.findIndex((s) => s.kind === 'file') >= 0 ? String(sheets.findIndex((s) => s.kind === 'file')) : 'page', options: [{ value: 'page', label: 'Current page' }, ...sheetOptions(sheets)] },
          { key: 'stack', label: 'Fallback fonts', type: 'combo', value: 'sans-serif', options: ['sans-serif', 'serif', 'monospace', 'system-ui, sans-serif', 'Georgia, serif'] },
          { key: 'addToList', label: 'Add to the font list', type: 'checkbox', value: true },
        ],
      });
      if (!v?.family) return;
      const fmt: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };
      const paths: string[] = [];
      for (const f of files) {
        const p = normalizePath(`${v.folder || 'fonts'}/${f.name.replace(/[^\w.-]+/g, '-')}`);
        app.site.write(p, new Uint8Array(await f.arrayBuffer()));
        paths.push(p);
      }
      const sheet = v.sheet === 'page' ? null : sheets[+v.sheet];
      const from = sheet ? sheet.path : app.active.path;
      const fam = String(v.family).replace(/"/g, '');
      paths.sort((a, b) => ['woff2', 'woff', 'ttf', 'otf'].indexOf(extOf(a)) - ['woff2', 'woff', 'ttf', 'otf'].indexOf(extOf(b)));
      const src = paths.map((p) => `url("${relativeRef(from, p)}") format("${fmt[extOf(p)] || extOf(p)}")`).join(',\n       ');
      const block = (ind: string) => `${ind}@font-face {\n${ind}  font-family: "${fam}";\n${ind}  src: ${src};\n${ind}  font-weight: ${v.weight};\n${ind}  font-style: ${v.style};\n${ind}  font-display: swap;\n${ind}}`;
      if (sheet) writeSheet(app, sheet, C.addRuleText(sheet.css, block), 'Add Web Font');
      else writeToTarget(app, 'page', (css) => C.addRuleText(css, block), 'Add Web Font');
      if (v.addToList) { const stack = `"${fam}", ${v.stack || 'sans-serif'}`; const l = fontList(); if (!l.includes(stack)) saveFontList([stack, ...l]); }
      toast(`Added ${fam}. Pick it from the font list.`);
    },
  },
  {
    id: 'css.variables', label: 'CSS Variables…', icon: 'data_object', tab: 'Design', group: 'CSS', edits: true,
    origin: 'Modern CSS (custom properties)', keywords: 'custom properties --var :root tokens', isEnabled: (app) => pageOk(app) || extOf(app.active?.path || '') === 'css',
    run: async (app) => {
      const isCss = extOf(app.active.path) === 'css';
      const sheets = isCss ? [{ id: 'self', kind: 'file' as const, label: app.active.path, path: app.active.path, css: app.active.source, block: -1 }] : pageSheets(app);
      const options = [...sheetOptions(sheets), ...(isCss ? [] : [{ value: 'page', label: 'Current page' }])];
      const varsOf = (k: string) => {
        const css = k === 'page' ? (sheets.find((s) => s.kind === 'page')?.css || '') : sheets[+k]?.css || '';
        return C.findRules(css, ':root', null).flatMap((r) => r.decls.filter((d) => d.prop.startsWith('--'))).map((d) => `${d.prop}: ${d.value}`).join('\n');
      };
      const start = sheets.length ? '0' : 'page';
      const v = await openDialog({
        title: 'CSS Variables', wide: true,
        help: 'Custom properties on :root, one per line ("--brand: #0063b1"). Use them anywhere as var(--brand). Remove a line to delete the variable.',
        fields: [
          { key: 'sheet', label: 'Style sheet', type: 'select', value: start, options },
          { key: 'vars', label: 'Variables', type: 'textarea', rows: 12, value: varsOf(start), placeholder: '--brand: #0063b1\n--space: 1rem' },
        ],
        onChange: (vals, ctl, key) => { if (key === 'sheet') ctl.set('vars', varsOf(vals.sheet)); },
      });
      if (!v) return;
      const before = C.styleToObject(varsOf(v.sheet).replace(/\n/g, ';'));
      const after: Record<string, string | null> = {};
      for (const line of String(v.vars || '').split('\n')) { const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*;?\s*$/.exec(line); if (m) after[m[1]] = m[2]; }
      for (const k of Object.keys(before)) if (!(k in after)) after[k] = null;
      const apply = (css: string) => C.setDeclarations(css, ':root', after, null);
      if (v.sheet === 'page') writeToTarget(app, 'page', apply, 'CSS Variables');
      else if (isCss) app.editSource('CSS Variables', apply);
      else writeSheet(app, sheets[+v.sheet], apply(sheets[+v.sheet].css), 'CSS Variables');
    },
  },
  { id: 'css.minify', label: 'Minify CSS', icon: 'compress', tab: 'Code', group: 'CSS', edits: true, origin: 'Modern build tools', keywords: 'compress css whitespace comments', isEnabled: textOk, run: (app) => transformStyles(app, 'Minify CSS', (css) => (app.active.kind === 'page' ? ` ${C.minify(css)} ` : C.minify(css) + '\n')) },
  {
    id: 'css.format', label: 'Format CSS', icon: 'format_align_left', tab: 'Code', group: 'CSS', edits: true, origin: 'Dreamweaver (Apply Source Formatting), KompoZer', keywords: 'pretty print indent css',
    isEnabled: textOk, run: (app) => transformStyles(app, 'Format CSS', (css) => (app.active.kind === 'page' ? indentBlock(C.formatCss(css), fileText(app, app.active.path)) : C.formatCss(css))),
  },
  {
    id: 'css.removeUnused', label: 'Remove Unused CSS…', icon: 'cleaning_services', tab: 'Code', group: 'CSS', edits: true, origin: 'Expression Web (CSS Reports), modern tools',
    keywords: 'unused selectors purge clean', isEnabled: textOk,
    run: async (app) => {
      const t = app.active;
      const isCss = extOf(t.path) === 'css';
      const pages = isCss ? app.site.pages().filter((f) => pageSheets(app, f.path).some((s) => s.path === t.path)).map((f) => fileText(app, f.path)) : [fileText(app, t.path)];
      if (isCss && !pages.length) { toast('No page uses this style sheet, so every rule would be removed. Nothing changed.'); return; }
      const css = isCss ? t.source : pageSheets(app).filter((s) => s.kind === 'page').map((s) => s.css).join('\n');
      const unused = C.unusedSelectors(css, pages);
      if (!unused.length) { toast('Every rule is used.'); return; }
      const ok = await confirmDialog('Remove Unused CSS', `${unused.length} selector${unused.length === 1 ? '' : 's'} match nothing in ${isCss ? `the ${pages.length} page${pages.length === 1 ? '' : 's'} that use this sheet` : 'this page'}:\n${unused.slice(0, 12).map((u) => u.selector).join(', ')}${unused.length > 12 ? '…' : ''}\n\nSelectors for states such as :hover count as used when their element exists. Remove them?`, 'Remove');
      if (ok) transformStyles(app, 'Remove Unused CSS', (c) => C.removeUnused(c, pages));
    },
  },
  { id: 'css.prefix', label: 'Add Vendor Prefixes', icon: 'add_link', tab: 'Code', group: 'CSS', edits: true, origin: 'Modern build tools (Autoprefixer)', keywords: 'webkit moz prefix compatibility', isEnabled: textOk, run: (app) => transformStyles(app, 'Add Vendor Prefixes', (css) => C.addVendorPrefixes(css)) },
  {
    id: 'css.editor', label: 'CSS Editor…', icon: 'edit_note', tab: 'Design', group: 'CSS', edits: true, origin: 'KompoZer (CaScadeS)', keywords: 'rule editor stylesheet',
    isEnabled: pageOk, run: (app) => { if (!app.ui.paneOpen('manageStyles')) app.ui.openPane('manageStyles'); return ruleEditor(app); },
  },
]);
