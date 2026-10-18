/**
 * Tag and code commands: select/edit/wrap/remove tags (Design view and Code view), the Quick Tag Editor,
 * tag properties and positioning; Code view comment, indent, folding, matching tags and braces,
 * balance, completion, abbreviations (editor/emmet.ts), bookmarks, source formatting and tag case.
 *
 * In Code view the tag commands work on the element around the cursor, found by scanning the text
 * (parseSource below), so they also work in pages Design view cannot show exactly as written.
 */
import { def } from './registry';
import type { App, PageTab } from '../app';
import { openDialog, toast, promptDialog, confirmDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { view, isPage, isText, selectedEl, insertHtml, mutate, setAttr, getAttr, setStyleProp, styleOf, unwrap, outerSource, replaceElement, selectionHtml } from '../editor/ops';
import type { CodeView } from '../editor/codeView';
import { formatHtml, changeTagCase } from '../model/html';
import { extOf, isPagePath } from '../model/paths';
import { expandAbbreviation, abbreviationStart, looksLikeAbbreviation, expandCss } from '../editor/emmet';
import { Compartment, StateEffect, StateField, RangeSet, RangeSetBuilder, Prec, EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, keymap, gutter, GutterMarker, Decoration, ViewPlugin, highlightWhitespace, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { matchBrackets, getIndentUnit } from '@codemirror/language';
import { startCompletion } from '@codemirror/autocomplete';

// ==========================================================================================
// Markup scanner (pure)

export interface SrcEl {
  name: string;
  openStart: number; openEnd: number;
  closeStart: number; closeEnd: number;
  /** False when the element was never closed (or was closed implicitly by another tag). */
  closed: boolean;
  implicit?: boolean;
  children: SrcEl[];
  parent: SrcEl | null;
}

export interface SrcTree { root: SrcEl; stray: [number, number][]; unclosed: SrcEl[] }

export const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'frame', 'isindex', 'keygen', 'command']);
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'plaintext']);
/** End tags HTML lets authors leave out. */
const OPTIONAL_END = new Set(['p', 'li', 'td', 'th', 'tr', 'thead', 'tbody', 'tfoot', 'option', 'optgroup', 'dt', 'dd', 'html', 'head', 'body', 'colgroup', 'caption', 'rt', 'rp']);
const P_CLOSERS = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
/** Opening `key` implicitly closes an open element named in the set (when it is the innermost one). */
const AUTO_CLOSE: Record<string, Set<string>> = {
  li: new Set(['li']), dt: new Set(['dt', 'dd']), dd: new Set(['dt', 'dd']), option: new Set(['option']), optgroup: new Set(['optgroup', 'option']),
  td: new Set(['td', 'th']), th: new Set(['td', 'th']), tr: new Set(['tr', 'td', 'th']), tbody: new Set(['tbody', 'thead', 'tr', 'td', 'th']), tfoot: new Set(['tbody', 'thead', 'tr', 'td', 'th']), thead: new Set(['tr', 'td', 'th']),
};

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>?|<\?[\s\S]*?(?:\?>|$)|<%[\s\S]*?(?:%>|$)|<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*)(>|$)/g;

/** Parses markup into an element tree with source offsets. Tolerant: never throws. */
export function parseSource(src: string): SrcTree {
  const root: SrcEl = { name: '#root', openStart: 0, openEnd: 0, closeStart: src.length, closeEnd: src.length, closed: true, children: [], parent: null };
  const stack: SrcEl[] = [root];
  const stray: [number, number][] = [];
  const unclosed: SrcEl[] = [];
  const re = new RegExp(TOKEN.source, 'g');
  let m: RegExpExecArray | null;
  const close = (el: SrcEl, at: number, implicit: boolean) => {
    el.closeStart = el.closeEnd = at;
    el.closed = false;
    el.implicit = implicit;
    if (!implicit && !OPTIONAL_END.has(el.name)) unclosed.push(el);
  };
  while ((m = re.exec(src))) {
    if (!m[2]) { if (m[0] === '') re.lastIndex++; continue; }
    const name = m[2].toLowerCase();
    const start = m.index, end = m.index + m[0].length;
    if (m[1]) {
      let i = stack.length - 1;
      while (i > 0 && stack[i].name !== name) i--;
      if (i === 0) { stray.push([start, end]); continue; }
      while (stack.length - 1 > i) close(stack.pop()!, start, false);
      const el = stack.pop()!;
      el.closeStart = start; el.closeEnd = end; el.closed = true;
      continue;
    }
    let top = stack[stack.length - 1];
    const auto = AUTO_CLOSE[name];
    if (auto) while (top !== root && auto.has(top.name)) { close(stack.pop()!, start, true); top = stack[stack.length - 1]; }
    if (P_CLOSERS.has(name) && top.name === 'p') { close(stack.pop()!, start, true); top = stack[stack.length - 1]; }
    const el: SrcEl = { name, openStart: start, openEnd: end, closeStart: end, closeEnd: end, closed: true, children: [], parent: top };
    top.children.push(el);
    if (VOID_TAGS.has(name) || /\/\s*$/.test(m[3] || '')) continue;
    if (RAW_TAGS.has(name)) {
      const endRe = new RegExp(`</${name}\\s*>`, 'ig');
      endRe.lastIndex = end;
      const em = endRe.exec(src);
      if (em) { el.closeStart = em.index; el.closeEnd = em.index + em[0].length; re.lastIndex = el.closeEnd; }
      else { close(el, src.length, false); re.lastIndex = src.length; }
      continue;
    }
    stack.push(el);
  }
  while (stack.length > 1) close(stack.pop()!, src.length, false);
  return { root, stray, unclosed };
}

/** The innermost element that contains the range (a caret on the edge of a tag counts as outside). */
export function enclosingElement(root: SrcEl, from: number, to = from): SrcEl | null {
  let best: SrcEl | null = null;
  let level = root.children;
  for (;;) {
    const c = level.find((e) => e.openStart <= from && to <= e.closeEnd && !(from === to && (from === e.openStart || from === e.closeEnd)));
    if (!c) return best;
    best = c;
    level = c.children;
  }
}

/** Emmet-style "balance outward": the next larger range (contents, then the whole element, then its parent). */
export function balanceOutward(root: SrcEl, from: number, to: number): [number, number] | null {
  let el = enclosingElement(root, from, to);
  while (el) {
    const inner: [number, number] = [el.openEnd, el.closeStart];
    const outer: [number, number] = [el.openStart, el.closeEnd];
    if (from >= inner[0] && to <= inner[1] && (from !== inner[0] || to !== inner[1]) && inner[1] > inner[0]) return inner;
    if (from !== outer[0] || to !== outer[1]) return outer;
    el = el.parent && el.parent.name !== '#root' ? el.parent : null;
  }
  return null;
}

/** The element reached by a Design view path ({tag, nth among same-tag siblings}) from <body>. */
export function elementForPath(root: SrcEl, path: { tag: string; nth: number }[]): SrcEl | null {
  const find = (n: SrcEl, name: string): SrcEl | null => { for (const c of n.children) { if (c.name === name) return c; const r = find(c, name); if (r) return r; } return null; };
  let cur: SrcEl | null = find(root, 'body') || root;
  for (const step of path) {
    if (!cur) return null;
    const same: SrcEl[] = cur.children.filter((c: SrcEl) => c.name === step.tag);
    if (!same.length && step.tag === 'tbody') continue; // the browser adds <tbody>
    const next: SrcEl | undefined = same[step.nth] || same[same.length - 1];
    if (!next) return cur === root ? null : cur;
    cur = next;
  }
  return cur;
}

export interface StartTag { name: string; attrs: [string, string | null][]; selfClose: boolean }

/** Parses a start tag such as <a href="x" hidden>. */
export function parseStartTag(tag: string): StartTag | null {
  const m = /^<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>?$/.exec(tag.trim());
  if (!m) return null;
  let body = m[2];
  const selfClose = /\/\s*$/.test(body);
  if (selfClose) body = body.replace(/\/\s*$/, '');
  const attrs: [string, string | null][] = [];
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(body))) attrs.push([a[1], a[2] ?? a[3] ?? a[4] ?? null]);
  return { name: m[1], attrs, selfClose };
}

export function buildStartTag(t: StartTag): string {
  const attrs = t.attrs.map(([k, v]) => (v == null ? ` ${k}` : ` ${k}="${v.replace(/&(?![a-zA-Z#][\w#]*;)/g, '&amp;').replace(/"/g, '&quot;')}"`)).join('');
  return `<${t.name}${attrs}${t.selfClose ? ' /' : ''}>`;
}

/** Replaces the attribute list from "name=value" lines or a start-tag fragment like ' class="a" id=b'. */
export function attrsFromText(text: string): [string, string | null][] {
  return parseStartTag(`<x ${text.replace(/\n/g, ' ')}>`)?.attrs || [];
}

// ------------------------------------------------------------------------------------------
// Simple formatters for style sheets and scripts

/** Re-indents CSS: one declaration per line, braces on the selector line, nested blocks indented. */
export function formatCss(css: string, indent = '  '): string {
  let out = '', depth = 0, line = '';
  const push = (s: string) => { const t = s.trim(); if (t) out += indent.repeat(depth) + t + '\n'; };
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); const end = e < 0 ? css.length : e + 2; if (line.trim()) { line += css.slice(i, end); } else push(css.slice(i, end)); i = end - 1; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < css.length && css[j] !== c) { if (css[j] === '\\') j++; j++; } line += css.slice(i, j + 1); i = j; continue; }
    if (c === '(') { let j = i, d = 0; for (; j < css.length; j++) { if (css[j] === '(') d++; else if (css[j] === ')' && --d === 0) break; } line += css.slice(i, j + 1); i = j; continue; }
    if (c === '{') { push(line.replace(/\s+/g, ' ').trim() + ' {'); line = ''; depth++; continue; }
    if (c === '}') { push(line.trim() ? tidyDecl(line) + (line.trim().endsWith(';') ? '' : ';') : ''); line = ''; depth = Math.max(0, depth - 1); push('}'); if (depth === 0) out += '\n'; continue; }
    if (c === ';') { if (depth === 0) { push(line.trim() + ';'); } else push(tidyDecl(line) + ';'); line = ''; continue; }
    line += c;
  }
  push(line);
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
function tidyDecl(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  const i = t.indexOf(':');
  return i > 0 && !/^@/.test(t) ? `${t.slice(0, i).trim()}: ${t.slice(i + 1).trim()}` : t;
}

/** Re-indents JavaScript by bracket depth, keeping the author's line breaks. Strings and comments are respected. */
export function formatJs(js: string, indent = '  '): string {
  const lines = js.replace(/\r\n?/g, '\n').split('\n');
  let depth = 0, inBlock = false, inTpl = false;
  const out: string[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (inTpl) { out.push(raw); }
    let lead = 0;
    if (!inBlock && !inTpl) { const m = /^[}\])]+/.exec(t); if (m) lead = m[0].length; }
    if (!inTpl) out.push(t ? (inBlock && !t.startsWith('*') ? raw : indent.repeat(Math.max(0, depth - lead)) + (inBlock ? ' ' : '') + t) : '');
    // Net depth change, skipping strings and comments.
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inBlock) { if (c === '*' && t[i + 1] === '/') { inBlock = false; i++; } continue; }
      if (inTpl) { if (c === '\\') i++; else if (c === '`') inTpl = false; continue; }
      if (c === '/' && t[i + 1] === '/') break;
      if (c === '/' && t[i + 1] === '*') { inBlock = true; i++; continue; }
      if (c === '`') { inTpl = true; continue; }
      if (c === '"' || c === "'") { i++; while (i < t.length && t[i] !== c) { if (t[i] === '\\') i++; i++; } continue; }
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth = Math.max(0, depth - 1);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

/** Formats a file's text by its kind. */
export function formatSource(path: string, text: string, opts: { indent: string; uppercase?: boolean }): string {
  const e = extOf(path);
  if (e === 'css' || e === 'scss' || e === 'less') return formatCss(text, opts.indent);
  if (e === 'js' || e === 'mjs' || e === 'ts' || e === 'json') return formatJs(text, opts.indent);
  if (isPagePath(path) || e === 'xml' || e === 'svg' || e === 'dwt' || e === 'lbi') return formatHtml(text, { indent: opts.indent, uppercase: opts.uppercase });
  return text;
}

// ==========================================================================================
// Code view helpers

interface CodeCtx { tab: PageTab; code: CodeView; text: string; from: number; to: number }

export function codeCtx(app: App): CodeCtx | null {
  const v = view(app);
  if (!v?.code || v.target !== 'code') return null;
  const s = v.code.selection;
  return { tab: app.active, code: v.code, text: v.code.text, from: s.from, to: s.to };
}

/** Ensures Code view is showing (Split for pages shown in Design only) and returns it. */
export function showCode(app: App): CodeView | null {
  const t = app.active;
  if (!t?.ui?.code) { toast('This file has no Code view.'); return null; }
  if (t.view === 'design' || t.view === 'preview') app.setView(t, t.kind === 'page' ? 'split' : 'code');
  t.ui.focusArea = 'code';
  return t.ui.code;
}

/** Replaces text in Code view as one undo step and selects the given range afterwards. */
export function codeReplace(app: App, from: number, to: number, insert: string, sel?: [number, number]): void {
  const v = view(app);
  if (!v?.code) return;
  const cv = v.code.view;
  cv.dispatch({ changes: { from, to, insert }, selection: sel ? EditorSelection.range(sel[0], sel[1]) : EditorSelection.cursor(from + insert.length), scrollIntoView: true });
  v.flush();
  cv.focus();
}

function codeEnclosing(app: App): { ctx: CodeCtx; el: SrcEl; tree: SrcTree } | null {
  const ctx = codeCtx(app);
  if (!ctx) return null;
  const tree = parseSource(ctx.text);
  const el = enclosingElement(tree.root, ctx.from, ctx.to);
  if (!el) { toast('The cursor is not inside a tag.'); return null; }
  return { ctx, el, tree };
}

const designOnlyEl = (app: App): HTMLElement | null => {
  const el = selectedEl(app);
  if (!el || el === el.ownerDocument.body) { toast('Select an element first (click it, or use the Quick Tag Selector).'); return null; }
  return el;
};

const design = (app: App) => view(app)?.design || null;

// ==========================================================================================
// Tag library (used by Tag Libraries and Tag Properties)

export const GLOBAL_ATTRS = ['id', 'class', 'style', 'title', 'lang', 'dir', 'hidden', 'tabindex', 'accesskey', 'contenteditable', 'draggable', 'spellcheck', 'translate', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'data-*'];

export const TAG_LIBRARY: [string, string, string[]][] = [
  ['a', 'Hyperlink', ['href', 'target', 'rel', 'download', 'hreflang', 'type', 'referrerpolicy']],
  ['abbr', 'Abbreviation', []], ['address', 'Contact information', []],
  ['area', 'Image map hotspot', ['shape', 'coords', 'href', 'alt', 'target', 'rel']],
  ['article', 'Self-contained article', []], ['aside', 'Side content', []],
  ['audio', 'Sound', ['src', 'controls', 'autoplay', 'loop', 'muted', 'preload']],
  ['b', 'Bold text (stylistic)', []], ['base', 'Base address for relative links', ['href', 'target']],
  ['blockquote', 'Quotation block', ['cite']], ['body', 'Page body', []], ['br', 'Line break', []],
  ['button', 'Button', ['type', 'name', 'value', 'disabled', 'form', 'formaction', 'autofocus']],
  ['canvas', 'Drawing surface for scripts', ['width', 'height']], ['caption', 'Table caption', []],
  ['cite', 'Title of a work', []], ['code', 'Code fragment', []], ['col', 'Table column', ['span']], ['colgroup', 'Table column group', ['span']],
  ['data', 'Machine-readable value', ['value']], ['datalist', 'Suggestions for an input', []],
  ['dd', 'Definition description', []], ['del', 'Deleted text', ['cite', 'datetime']],
  ['details', 'Disclosure widget', ['open', 'name']], ['dfn', 'Defined term', []], ['dialog', 'Dialog box', ['open']],
  ['div', 'Generic block container', []], ['dl', 'Description list', []], ['dt', 'Description term', []],
  ['em', 'Emphasis', []], ['embed', 'Embedded content', ['src', 'type', 'width', 'height']],
  ['fieldset', 'Group of form fields', ['disabled', 'form', 'name']], ['figcaption', 'Figure caption', []], ['figure', 'Figure with caption', []],
  ['footer', 'Footer', []], ['form', 'Form', ['action', 'method', 'enctype', 'target', 'name', 'autocomplete', 'novalidate', 'accept-charset']],
  ['h1', 'Heading 1', []], ['h2', 'Heading 2', []], ['h3', 'Heading 3', []], ['h4', 'Heading 4', []], ['h5', 'Heading 5', []], ['h6', 'Heading 6', []],
  ['head', 'Document head', []], ['header', 'Header', []], ['hgroup', 'Heading group', []], ['hr', 'Thematic break', []],
  ['html', 'Root element', ['lang', 'dir', 'xmlns']], ['i', 'Alternate voice (italic)', []],
  ['iframe', 'Inline frame', ['src', 'srcdoc', 'name', 'width', 'height', 'allow', 'allowfullscreen', 'loading', 'sandbox', 'referrerpolicy']],
  ['img', 'Picture', ['src', 'alt', 'width', 'height', 'srcset', 'sizes', 'loading', 'decoding', 'usemap', 'ismap', 'crossorigin']],
  ['input', 'Form field', ['type', 'name', 'value', 'placeholder', 'required', 'disabled', 'readonly', 'checked', 'min', 'max', 'step', 'pattern', 'maxlength', 'minlength', 'size', 'autocomplete', 'autofocus', 'list', 'multiple', 'accept', 'form']],
  ['ins', 'Inserted text', ['cite', 'datetime']], ['kbd', 'Keyboard input', []], ['label', 'Field label', ['for']], ['legend', 'Fieldset caption', []],
  ['li', 'List item', ['value']], ['link', 'Linked resource (style sheet, icon…)', ['rel', 'href', 'type', 'media', 'sizes', 'crossorigin', 'integrity', 'as']],
  ['main', 'Main content', []], ['map', 'Image map', ['name']], ['mark', 'Highlighted text', []], ['menu', 'Toolbar list', []],
  ['meta', 'Metadata', ['name', 'content', 'charset', 'http-equiv', 'property']], ['meter', 'Gauge', ['value', 'min', 'max', 'low', 'high', 'optimum']],
  ['nav', 'Navigation links', []], ['noscript', 'Content when scripts are off', []],
  ['object', 'External object', ['data', 'type', 'width', 'height', 'name', 'form']], ['ol', 'Numbered list', ['start', 'reversed', 'type']],
  ['optgroup', 'Option group', ['label', 'disabled']], ['option', 'Option', ['value', 'selected', 'disabled', 'label']],
  ['output', 'Calculation result', ['for', 'name', 'form']], ['p', 'Paragraph', []], ['picture', 'Responsive picture', []],
  ['pre', 'Preformatted text', []], ['progress', 'Progress bar', ['value', 'max']], ['q', 'Inline quotation', ['cite']],
  ['s', 'No longer accurate', []], ['samp', 'Sample output', []], ['script', 'Script', ['src', 'type', 'async', 'defer', 'crossorigin', 'integrity', 'nomodule']],
  ['search', 'Search section', []], ['section', 'Section', []], ['select', 'Drop-down list', ['name', 'multiple', 'size', 'required', 'disabled', 'form', 'autocomplete']],
  ['slot', 'Web component slot', ['name']], ['small', 'Side comment, fine print', []], ['source', 'Media source', ['src', 'srcset', 'type', 'media', 'sizes']],
  ['span', 'Generic inline container', []], ['strong', 'Strong importance', []], ['style', 'Style sheet', ['media']],
  ['sub', 'Subscript', []], ['summary', 'Details summary', []], ['sup', 'Superscript', []], ['svg', 'Vector graphics', ['width', 'height', 'viewBox', 'xmlns']],
  ['table', 'Table', ['border', 'cellpadding', 'cellspacing', 'width', 'summary']], ['tbody', 'Table body', []],
  ['td', 'Table cell', ['colspan', 'rowspan', 'headers']], ['template', 'Content template', []],
  ['textarea', 'Multiline text box', ['name', 'rows', 'cols', 'placeholder', 'required', 'disabled', 'readonly', 'maxlength', 'wrap', 'form']],
  ['tfoot', 'Table footer', []], ['th', 'Table header cell', ['colspan', 'rowspan', 'scope', 'abbr', 'headers']], ['thead', 'Table head', []],
  ['time', 'Date or time', ['datetime']], ['title', 'Page title', []], ['tr', 'Table row', []], ['track', 'Text track', ['src', 'kind', 'srclang', 'label', 'default']],
  ['u', 'Unarticulated annotation (underline)', []], ['ul', 'Bulleted list', []], ['var', 'Variable', []],
  ['video', 'Video', ['src', 'poster', 'controls', 'autoplay', 'loop', 'muted', 'playsinline', 'preload', 'width', 'height']], ['wbr', 'Line break opportunity', []],
  ['center', 'Centered block (obsolete; use CSS)', []], ['font', 'Font (obsolete; use CSS)', ['face', 'size', 'color']], ['marquee', 'Scrolling text (obsolete)', ['behavior', 'direction', 'scrollamount']],
  ['frameset', 'Frame set (obsolete)', ['rows', 'cols']], ['frame', 'Frame (obsolete)', ['src', 'name', 'scrolling', 'noresize']],
];

// ==========================================================================================
// Code view extras: bookmarks, abbreviation keys, hidden characters, invalid markup

const toggleBm = StateEffect.define<number>();
const clearBm = StateEffect.define<null>();
class BmMarker extends GutterMarker {
  toDOM(): Node { const s = document.createElement('span'); s.textContent = '◆'; s.className = 'cm-ql-bm'; return s; }
}
const bmMarker = new BmMarker();

export const bookmarkField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    if (tr.docChanged) {
      let whole = false;
      tr.changes.iterChangedRanges((fA, tA) => { if (fA === 0 && tA === tr.startState.doc.length) whole = true; });
      if (whole && tr.startState.doc.length) {
        // The text was replaced from outside (Design view): keep bookmarks on the same line numbers.
        const lines: number[] = [];
        set.between(0, tr.startState.doc.length, (f) => { lines.push(tr.startState.doc.lineAt(f).number); });
        const doc = tr.state.doc;
        set = RangeSet.of([...new Set(lines)].filter((n) => n <= doc.lines).sort((a, b) => a - b).map((n) => bmMarker.range(doc.line(n).from)));
      } else set = set.map(tr.changes);
    }
    for (const e of tr.effects) {
      if (e.is(clearBm)) set = RangeSet.empty;
      if (e.is(toggleBm)) {
        let has = false;
        set.between(e.value, e.value, (f) => { if (f === e.value) has = true; });
        set = has ? set.update({ filter: (f) => f !== e.value }) : set.update({ add: [bmMarker.range(e.value)], sort: true });
      }
    }
    return set;
  },
});

const bmLines = EditorView.decorations.compute([bookmarkField], (state) => {
  const b = new RangeSetBuilder<Decoration>();
  state.field(bookmarkField).between(0, state.doc.length, (from) => { b.add(from, from, Decoration.line({ class: 'cm-ql-bm-line' })); });
  return b.finish();
});

function bookmarks(cv: EditorView): number[] {
  const out: number[] = [];
  cv.state.field(bookmarkField, false)?.between(0, cv.state.doc.length, (f) => { out.push(f); });
  return out;
}

const invalidMark = Decoration.mark({ class: 'cm-ql-invalid', attributes: { title: 'Unmatched tag' } });
function invalidDecos(text: string): DecorationSet {
  if (text.length > 400000) return Decoration.none;
  const t = parseSource(text);
  const ranges = [...t.stray, ...t.unclosed.map((e) => [e.openStart, e.openEnd] as [number, number])].filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  return Decoration.set(ranges.map(([a, b]) => invalidMark.range(a, b)), true);
}
const invalidPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(v: EditorView) { this.decorations = invalidDecos(v.state.doc.toString()); }
  update(u: ViewUpdate) { if (u.docChanged) this.decorations = invalidDecos(u.state.doc.toString()); }
}, { decorations: (p) => p.decorations });

/** Expands the abbreviation before the cursor. Returns false when there is none (so Tab can indent). */
export function expandAtCursor(cv: EditorView, path: string, strict: boolean): boolean {
  const s = cv.state.selection.main;
  if (!s.empty) return false;
  const line = cv.state.doc.lineAt(s.head);
  const col = s.head - line.from;
  const start = abbreviationStart(line.text, col);
  if (start < 0) return false;
  const abbr = line.text.slice(start, col);
  const e = extOf(path);
  if (e === 'css' || e === 'scss' || e === 'less') {
    const css = expandCss(abbr);
    if (!css) return false;
    cv.dispatch({ changes: { from: line.from + start, to: s.head, insert: css }, selection: EditorSelection.cursor(line.from + start + css.length), scrollIntoView: true });
    return true;
  }
  if (strict && !looksLikeAbbreviation(abbr)) return false;
  let out: string;
  try { out = expandAbbreviation(abbr, { indent: getIndentUnit(cv.state) > 0 ? ' '.repeat(getIndentUnit(cv.state)) : '\t', caret: true }); }
  catch (err) { if (!strict) toast((err as Error).message); return false; }
  const lead = /^\s*/.exec(line.text)![0];
  out = out.replace(/\n/g, '\n' + lead);
  const caret = out.indexOf('\u0001');
  out = out.replace('\u0001', '');
  const at = line.from + start;
  cv.dispatch({ changes: { from: at, to: s.head, insert: out }, selection: EditorSelection.cursor(at + (caret >= 0 ? caret : out.length)), scrollIntoView: true });
  return true;
}

function jumpBookmark(cv: EditorView, dir: 1 | -1): boolean {
  const list = bookmarks(cv);
  if (!list.length) { toast('No bookmarks. Toggle one with Ctrl+F2.'); return true; }
  const here = cv.state.doc.lineAt(cv.state.selection.main.head).from;
  const target = dir > 0 ? list.find((p) => p > here) ?? list[0] : [...list].reverse().find((p) => p < here) ?? list[list.length - 1];
  cv.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true });
  return true;
}

export interface CodeExtrasOptions { hiddenChars: boolean; highlightInvalid: boolean }
const optionCompartments = new WeakMap<EditorView, Compartment>();

function optionExt(path: string, o: CodeExtrasOptions): Extension {
  return [o.hiddenChars ? highlightWhitespace() : [], o.highlightInvalid && (isPagePath(path) || /\.(xml|svg|dwt|lbi)$/i.test(path)) ? invalidPlugin : []];
}

/** Adds QuillLoom's Code view extensions to a tab's editor once; later calls update the options. */
export function ensureCodeExtras(tab: PageTab, o: CodeExtrasOptions): void {
  const code = tab.ui?.code;
  if (!code) return;
  const cv = code.view;
  let comp = optionCompartments.get(cv);
  if (!comp) {
    comp = new Compartment();
    optionCompartments.set(cv, comp);
    cv.dispatch({
      effects: StateEffect.appendConfig.of([
        bookmarkField, bmLines,
        gutter({ class: 'cm-ql-bm-gutter', markers: (v) => v.state.field(bookmarkField), initialSpacer: () => bmMarker, domEventHandlers: { mousedown(v, line) { v.dispatch({ effects: toggleBm.of(line.from) }); return true; } } }),
        Prec.high(keymap.of([
          { key: 'Tab', run: (v) => expandAtCursor(v, tab.path, true) },
          { key: 'Mod-e', run: (v) => { if (!expandAtCursor(v, tab.path, false)) toast('Type an abbreviation before the cursor, such as ul>li*3 or div.box>p{Hello}.'); return true; } },
          { key: 'Mod-F2', run: (v) => { v.dispatch({ effects: toggleBm.of(v.state.doc.lineAt(v.state.selection.main.head).from) }); return true; } },
          { key: 'F2', run: (v) => jumpBookmark(v, 1) },
          { key: 'Shift-F2', run: (v) => jumpBookmark(v, -1) },
        ])),
        EditorView.theme({
          '.cm-ql-bm-gutter': { width: '12px', cursor: 'pointer' },
          '.cm-ql-bm': { color: '#2b79d6', fontSize: '10px' },
          '.cm-ql-bm-line': { backgroundColor: 'rgba(43,121,214,.10)' },
          '.cm-ql-invalid': { textDecoration: 'underline wavy #d33', textUnderlineOffset: '3px', backgroundColor: 'rgba(220,50,50,.08)' },
        }),
        comp.of(optionExt(tab.path, o)),
      ]),
    });
    (cv as any)._qlOpts = JSON.stringify(o);
    return;
  }
  const sig = JSON.stringify(o);
  if ((cv as any)._qlOpts === sig) return;
  (cv as any)._qlOpts = sig;
  cv.dispatch({ effects: comp.reconfigure(optionExt(tab.path, o)) });
}

// ==========================================================================================
// Commands

const tagEnabled = (app: App) => isText(app);

/** Selects a Design view element; in Code view, the source range. */
function selectRange(app: App, el: SrcEl, contents: boolean): void {
  const c = view(app)!.code!;
  if (contents) c.select(el.openEnd, el.closeStart); else c.select(el.openStart, el.closeEnd);
}

/** Opens the Quick Tag Editor (Edit tag / Wrap tag / Insert HTML). */
async function quickTagEditor(app: App, mode?: 'edit' | 'wrap' | 'insert'): Promise<void> {
  const ctx = codeCtx(app);
  let startTag = '';
  if (ctx) {
    const el = enclosingElement(parseSource(ctx.text).root, ctx.from, ctx.to);
    if (el) startTag = ctx.text.slice(el.openStart, el.openEnd);
  } else {
    const el = selectedEl(app);
    if (el && el !== el.ownerDocument.body) { const o = outerSource(el); startTag = /^<[^>]*>/.exec(o)?.[0] || ''; }
  }
  const r = await openDialog({
    title: 'Quick Tag Editor',
    fields: [
      { key: 'mode', label: 'Mode', type: 'radio', value: mode || (startTag ? 'edit' : 'insert'), options: [{ value: 'edit', label: 'Edit tag' }, { value: 'wrap', label: 'Wrap tag' }, { value: 'insert', label: 'Insert HTML' }] },
      { key: 'text', label: 'Markup', type: 'textarea', rows: 4, value: startTag || '<div>', autofocus: true, help: 'Edit tag changes the start tag of the selected element (its end tag follows). Wrap tag puts a new element around the selection. Insert HTML inserts the markup at the cursor.' },
    ],
    onChange: (v, ctl, key) => { if (key === 'mode') ctl.set('text', v.mode === 'edit' ? startTag : v.mode === 'wrap' ? '<div>' : ''); },
  });
  if (!r) return;
  const text = String(r.text || '').trim();
  if (!text) return;
  if (r.mode === 'insert') { insertHtml(app, text); return; }
  const t = parseStartTag(/^<[^>]*>/.exec(text)?.[0] || text);
  if (!t) { toast('Type a start tag, such as <div class="box">.'); return; }
  if (r.mode === 'wrap') { wrapWith(app, t); return; }
  editStartTag(app, () => t);
}

/** Wraps the selection (or the selected element / element at the cursor) in a new element. */
function wrapWith(app: App, t: StartTag): void {
  const open = buildStartTag({ ...t, selfClose: false }), close = `</${t.name}>`;
  const ctx = codeCtx(app);
  if (ctx) {
    let [a, b] = [ctx.from, ctx.to];
    if (a === b) { const el = enclosingElement(parseSource(ctx.text).root, a); if (!el) { toast('Select something to wrap.'); return; } a = el.openStart; b = el.closeEnd; }
    const inner = ctx.text.slice(a, b);
    codeReplace(app, a, b, open + inner + close, [a, a + open.length + inner.length + close.length]);
    return;
  }
  if (selectionHtml(app)) { insertHtml(app, open + selectionHtml(app) + close); return; }
  const el = designOnlyEl(app);
  if (!el) return;
  mutate(app, (doc) => {
    const w = doc.createElement(t.name);
    for (const [k, v] of t.attrs) { if (v == null) w.setAttribute(k, ''); else setAttr(app, w, k, v); }
    el.replaceWith(w);
    w.appendChild(el);
    design(app)?.select(w);
  });
}

/** Changes the start tag of the selected element (Design view) or the element at the cursor (Code view). */
function editStartTag(app: App, fn: (t: StartTag) => StartTag | null): void {
  const ctx = codeCtx(app);
  if (ctx) {
    const el = enclosingElement(parseSource(ctx.text).root, ctx.from, ctx.to);
    if (!el) { toast('The cursor is not inside a tag.'); return; }
    const cur = parseStartTag(ctx.text.slice(el.openStart, el.openEnd));
    if (!cur) return;
    const nt = fn(cur);
    if (!nt) return;
    const newOpen = buildStartTag({ ...nt, selfClose: cur.selfClose && nt.name.toLowerCase() === cur.name.toLowerCase() });
    let text = ctx.text;
    // End tag first so the start offsets stay valid.
    if (el.closed && el.closeEnd > el.closeStart && nt.name.toLowerCase() !== cur.name.toLowerCase()) text = text.slice(0, el.closeStart) + `</${nt.name}>` + text.slice(el.closeEnd);
    text = text.slice(0, el.openStart) + newOpen + text.slice(el.openEnd);
    const v = view(app)!;
    v.code!.view.dispatch({ changes: { from: 0, to: ctx.text.length, insert: text }, selection: EditorSelection.range(el.openStart, el.openStart + newOpen.length), scrollIntoView: true });
    v.flush();
    return;
  }
  const el = designOnlyEl(app);
  if (!el) return;
  const cur: StartTag = { name: el.tagName.toLowerCase(), attrs: [...el.attributes].filter((a) => !a.name.startsWith('data-ql-') && !(a.name === 'contenteditable' && el === el.ownerDocument.body)).map((a) => [a.name, getAttr(el, a.name)]), selfClose: false };
  const nt = fn(cur);
  if (!nt) return;
  mutate(app, (doc) => {
    let target: HTMLElement = el;
    if (nt.name.toLowerCase() !== cur.name) {
      target = doc.createElement(nt.name);
      while (el.firstChild) target.appendChild(el.firstChild);
      el.replaceWith(target);
    } else {
      for (const a of [...el.attributes]) if (!nt.attrs.some(([k]) => k === a.name) && !a.name.startsWith('data-ql-o-')) el.removeAttribute(a.name);
      for (const a of [...el.attributes]) if (a.name.startsWith('data-ql-o-') && !nt.attrs.some(([k]) => `data-ql-o-${k}` === a.name)) el.removeAttribute(a.name);
    }
    for (const [k, v] of nt.attrs) {
      if (v == null) { target.setAttribute(k, ''); continue; }
      if (k === 'style') { target.removeAttribute('data-ql-o-style'); target.setAttribute('style', ''); for (const decl of v.split(';')) { const i = decl.indexOf(':'); if (i > 0) setStyleProp(app, target, decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } continue; }
      setAttr(app, target, k, v);
    }
    design(app)?.select(target);
  });
}

async function editWholeTag(app: App): Promise<void> {
  const ctx = codeCtx(app);
  if (ctx) {
    const el = enclosingElement(parseSource(ctx.text).root, ctx.from, ctx.to);
    if (!el) { toast('The cursor is not inside a tag.'); return; }
    const r = await openDialog({ title: `Edit Tag <${el.name}>`, wide: true, fields: [{ key: 'html', label: 'Markup', type: 'textarea', rows: 14, value: ctx.text.slice(el.openStart, el.closeEnd), autofocus: true }] });
    if (r) codeReplace(app, el.openStart, el.closeEnd, String(r.html), [el.openStart, el.openStart + String(r.html).length]);
    return;
  }
  const el = designOnlyEl(app);
  if (!el) return;
  const r = await openDialog({ title: `Edit Tag <${el.tagName.toLowerCase()}>`, wide: true, fields: [{ key: 'html', label: 'Markup', type: 'textarea', rows: 14, value: outerSource(el), autofocus: true, help: 'The element and everything in it, as source.' }] });
  if (!r) return;
  mutate(app, () => replaceElement(app, el, String(r.html)));
}

async function tagProperties(app: App): Promise<void> {
  let cur: StartTag | null = null;
  const ctx = codeCtx(app);
  if (ctx) {
    const el = enclosingElement(parseSource(ctx.text).root, ctx.from, ctx.to);
    if (el) cur = parseStartTag(ctx.text.slice(el.openStart, el.openEnd));
  } else {
    const el = selectedEl(app);
    if (el && el !== el.ownerDocument.body) cur = { name: el.tagName.toLowerCase(), attrs: [...el.attributes].filter((a) => !a.name.startsWith('data-ql-')).map((a) => [a.name, getAttr(el, a.name)]), selfClose: false };
  }
  if (!cur) { toast('Select an element first, or put the cursor inside a tag in Code view.'); return; }
  const lib = TAG_LIBRARY.find((t) => t[0] === cur!.name.toLowerCase());
  const known = [...(lib?.[2] || []), ...GLOBAL_ATTRS.filter((a) => a !== 'data-*')];
  const table = h('table', { class: 'ql-attr-table', style: 'width:100%;border-collapse:collapse' });
  const dl = h('datalist', { id: 'ql-attr-names' }, ...known.map((n) => h('option', { value: n })));
  const addRow = (k = '', v: string | null = '') => {
    const name = h('input', { type: 'text', value: k, list: 'ql-attr-names', 'aria-label': 'Attribute', style: 'width:100%' }) as HTMLInputElement;
    const val = h('input', { type: 'text', value: v ?? '', 'aria-label': 'Value', style: 'width:100%' }) as HTMLInputElement;
    const tr = h('tr', null, h('td', { style: 'width:38%;padding:2px' }, name), h('td', { style: 'padding:2px' }, val), h('td', null, h('button', { class: 'ql-iconbtn ql-sm', type: 'button', title: 'Remove', 'aria-label': 'Remove attribute', onclick: () => tr.remove() }, '✕')));
    (tr as any)._get = () => [name.value.trim(), v == null && val.value === '' ? null : val.value];
    table.appendChild(tr);
  };
  for (const [k, v] of cur.attrs) addRow(k, v);
  const content = h('div', null,
    h('p', { class: 'ql-help' }, lib ? `<${cur.name}>: ${lib[1]}.` : `<${cur.name}>`),
    table, dl,
    h('button', { class: 'ql-btn', type: 'button', onclick: () => addRow() }, 'Add Attribute'),
    h('p', { class: 'ql-help' }, `Common attributes: ${known.slice(0, 18).join(', ')}…`));
  const r = await openDialog({ title: `Tag Properties <${cur.name}>`, wide: true, content });
  if (!r) return;
  const attrs: [string, string | null][] = [...table.querySelectorAll('tr')].map((tr) => (tr as any)._get()).filter(([k]: [string]) => /^[^\s"'>/=]+$/.test(k));
  editStartTag(app, (t) => ({ ...t, attrs }));
}

async function positioning(app: App): Promise<void> {
  const ctx = codeCtx(app);
  let style = '';
  if (ctx) {
    const el = enclosingElement(parseSource(ctx.text).root, ctx.from, ctx.to);
    const t = el && parseStartTag(ctx.text.slice(el.openStart, el.openEnd));
    if (!t) { toast('Put the cursor inside a tag first.'); return; }
    style = t.attrs.find(([k]) => k === 'style')?.[1] || '';
  } else {
    const el = designOnlyEl(app);
    if (!el) return;
    style = styleOf(el);
  }
  const tmp = document.createElement('div');
  tmp.setAttribute('style', style);
  const s = tmp.style;
  const r = await openDialog({
    title: 'Positioning',
    fields: [
      { key: 'position', label: 'Position', type: 'select', value: s.position || '', options: [{ value: '', label: '(not set)' }, 'static', 'relative', 'absolute', 'fixed', 'sticky'] },
      { key: 'float', label: 'Wrapping (float)', type: 'select', value: s.cssFloat || '', options: [{ value: '', label: '(none)' }, 'left', 'right', 'none'] },
      { key: 'left', label: 'Left', type: 'text', value: s.left, half: true, placeholder: 'e.g. 20px' },
      { key: 'top', label: 'Top', type: 'text', value: s.top, half: true },
      { key: 'right', label: 'Right', type: 'text', value: s.right, half: true },
      { key: 'bottom', label: 'Bottom', type: 'text', value: s.bottom, half: true },
      { key: 'width', label: 'Width', type: 'text', value: s.width, half: true },
      { key: 'height', label: 'Height', type: 'text', value: s.height, half: true },
      { key: 'zIndex', label: 'Z-index', type: 'text', value: s.zIndex, half: true },
    ],
  });
  if (!r) return;
  const unit = (v: string) => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}px` : v.trim());
  const props: [string, string][] = [['position', r.position], ['float', r.float], ['left', unit(r.left || '')], ['top', unit(r.top || '')], ['right', unit(r.right || '')], ['bottom', unit(r.bottom || '')], ['width', unit(r.width || '')], ['height', unit(r.height || '')], ['z-index', String(r.zIndex || '').trim()]];
  if (ctx) {
    for (const [k, v] of props) { if (v) s.setProperty(k, v); else s.removeProperty(k); }
    const css = tmp.getAttribute('style') || '';
    editStartTag(app, (t) => {
      const attrs = t.attrs.filter(([k]) => k !== 'style');
      if (css) attrs.push(['style', css]);
      return { ...t, attrs };
    });
    return;
  }
  const el = selectedEl(app)!;
  mutate(app, () => { for (const [k, v] of props) setStyleProp(app, el, k, v || null); });
}

function selectTagCmd(app: App, contents: boolean): void {
  const ctx = codeCtx(app);
  if (ctx) { const r = codeEnclosing(app); if (r) selectRange(app, r.el, contents); return; }
  const el = designOnlyEl(app);
  if (el) design(app)?.select(el, { contents });
}

function selectParentCmd(app: App): void {
  const ctx = codeCtx(app);
  if (ctx) {
    const r = balanceOutward(parseSource(ctx.text).root, ctx.from, ctx.to);
    if (r) ctx.code.select(r[0], r[1]); else toast('There is no enclosing tag.');
    return;
  }
  const el = selectedEl(app);
  const d = design(app);
  if (!el || !d?.doc) return;
  const p = el === d.doc.body ? null : el.parentElement;
  if (!p || p === d.doc.documentElement) { toast('This is the outermost element.'); return; }
  d.select(p);
}

function selectChildCmd(app: App): void {
  const ctx = codeCtx(app);
  if (ctx) {
    const tree = parseSource(ctx.text);
    const el = enclosingElement(tree.root, ctx.from, ctx.to);
    const kids = el ? el.children : tree.root.children;
    const c = kids.find((k) => k.openStart >= ctx.from) || kids[0];
    if (c) ctx.code.select(c.openStart, c.closeEnd); else toast('This element has no child elements.');
    return;
  }
  const el = selectedEl(app);
  const c = el?.firstElementChild;
  if (!c || c.hasAttribute('data-ql-ui')) { toast('This element has no child elements.'); return; }
  design(app)?.select(c);
}

function removeTagCmd(app: App): void {
  const ctx = codeCtx(app);
  if (ctx) {
    const r = codeEnclosing(app);
    if (!r) return;
    const { el } = r;
    let text = ctx.text;
    if (el.closeEnd > el.closeStart) text = text.slice(0, el.closeStart) + text.slice(el.closeEnd);
    text = text.slice(0, el.openStart) + text.slice(el.openEnd);
    const v = view(app)!;
    v.code!.view.dispatch({ changes: { from: 0, to: ctx.text.length, insert: text }, selection: EditorSelection.range(el.openStart, el.openStart + Math.max(0, el.closeStart - el.openEnd)), scrollIntoView: true });
    v.flush();
    return;
  }
  const el = designOnlyEl(app);
  if (!el) return;
  mutate(app, () => unwrap(el));
}

async function insertHtmlCmd(app: App, arg?: string): Promise<void> {
  const markup = arg ?? (await openDialog({ title: 'Insert HTML', wide: true, fields: [{ key: 'html', label: 'Markup', type: 'textarea', rows: 10, value: '', autofocus: true }] }))?.html;
  if (markup) insertHtml(app, String(markup));
}

async function wrapCmd(app: App, arg?: string): Promise<void> {
  const tag = arg ?? (await promptDialog('Wrap Tag', 'Start tag (with attributes)', '<div class="">'));
  if (!tag) return;
  const t = parseStartTag(tag.startsWith('<') ? tag : `<${tag}>`);
  if (!t) { toast('Type a start tag, such as <div class="box"> or span.'); return; }
  wrapWith(app, t);
}

// ------------------------------------------------------------------------------------------
// Code commands

function needCode(app: App): CodeView | null {
  const ctx = codeCtx(app);
  if (ctx) return ctx.code;
  return showCode(app);
}

function codeCmd(app: App, name: Parameters<CodeView['cmd']>[0]): void {
  const c = needCode(app);
  if (!c) return;
  c.focus();
  c.cmd(name);
  view(app)?.flush();
}

function isCommented(text: string, path: string): boolean {
  const t = text.trim();
  const e = extOf(path);
  if (e === 'css') return /^\/\*[\s\S]*\*\/$/.test(t);
  if (e === 'js' || e === 'ts' || e === 'mjs') return /^\/\*[\s\S]*\*\/$/.test(t) || t.split('\n').every((l) => !l.trim() || /^\s*\/\//.test(l));
  return /^<!--[\s\S]*-->$/.test(t) || /^\/\*[\s\S]*\*\/$/.test(t) || t.split('\n').every((l) => !l.trim() || /^\s*\/\//.test(l));
}

function uncomment(app: App): void {
  const c = needCode(app);
  if (!c) return;
  const st = c.view.state;
  const s = st.selection.main;
  const from = st.doc.lineAt(s.from).from, to = st.doc.lineAt(s.to).to;
  const text = s.empty ? st.sliceDoc(from, to) : c.selection.text;
  if (!isCommented(text, app.active.path)) { toast('The selection is not a comment.'); return; }
  c.cmd('comment');
  view(app)?.flush();
}

function matchingTag(app: App): void {
  const c = needCode(app);
  if (!c) return;
  const pos = c.view.state.selection.main.head;
  const el = enclosingElement(parseSource(c.text).root, pos);
  if (!el) { toast('The cursor is not inside a tag.'); return; }
  const inOpen = pos >= el.openStart && pos <= el.openEnd;
  if (inOpen && el.closeEnd > el.closeStart) c.select(el.closeStart, el.closeStart);
  else c.select(el.openStart, el.openStart);
}

function matchingBrace(app: App): void {
  const c = needCode(app);
  if (!c) return;
  const st = c.view.state;
  const pos = st.selection.main.head;
  const m = matchBrackets(st, pos, -1) || matchBrackets(st, pos, 1);
  if (!m?.end) { toast(m ? 'This bracket has no match.' : 'Put the cursor next to a bracket: ( ) [ ] { }.'); return; }
  const target = m.end.from < m.start.from ? m.end.from : m.end.to;
  c.select(target, target);
}

function balanceTags(app: App): void {
  const c = needCode(app);
  if (!c) return;
  const s = c.view.state.selection.main;
  const r = balanceOutward(parseSource(c.text).root, s.from, s.to);
  if (r) c.select(r[0], r[1]); else toast('There is no enclosing tag.');
}

export const fmtPrefs = { uppercase: false };
try { fmtPrefs.uppercase = localStorage.getItem('quillloom.formatUpper') === '1'; } catch { /* */ }

const indentStr = (app: App) => ' '.repeat(Math.max(1, app.prefs.tabSize || 2));

function formatPage(app: App): void {
  const t = app.active;
  if (!t || !(t.kind === 'page' || t.kind === 'text')) return;
  const ok = app.editSource('Format Source', (src) => formatSource(t.path, src, { indent: indentStr(app), uppercase: fmtPrefs.uppercase }));
  toast(ok ? 'Source formatted' : 'The source was already formatted.');
}

function formatSelection(app: App): void {
  const ctx = codeCtx(app);
  if (!ctx || ctx.from === ctx.to) { formatPage(app); return; }
  const lead = /^[ \t]*/.exec(ctx.code.view.state.doc.lineAt(ctx.from).text)![0];
  const sel = ctx.text.slice(ctx.from, ctx.to);
  const out = formatSource(app.active.path.replace(/\.(dwt|lbi)$/i, '.html'), sel, { indent: indentStr(app), uppercase: fmtPrefs.uppercase }).replace(/\n$/, '').replace(/\n/g, '\n' + lead);
  codeReplace(app, ctx.from, ctx.to, out, [ctx.from, ctx.from + out.length]);
}

async function formatSite(app: App): Promise<void> {
  const files = app.site.list((f) => f.text != null && (isPagePath(f.path) || /\.(css|js)$/i.test(f.path)) && !/\.min\.(css|js)$/i.test(f.path));
  if (!files.length) { toast('The site has no pages, style sheets or scripts.'); return; }
  if (!(await confirmDialog('Format All Files', `Apply source formatting to ${files.length} pages, style sheets and scripts? Open files can be undone one by one; files that are not open are changed directly.`, 'Format'))) return;
  let n = 0;
  for (const f of files) {
    const tab = app.docs.find((d) => d.path === f.path);
    const out = formatSource(f.path, f.text!, { indent: indentStr(app), uppercase: fmtPrefs.uppercase });
    if (out === f.text) continue;
    if (tab) app.editSource('Format Source', () => out, tab); else app.site.write(f.path, out);
    n++;
  }
  toast(n ? `Formatted ${n} file${n === 1 ? '' : 's'}.` : 'Every file was already formatted.');
}

async function formatSettings(app: App): Promise<void> {
  const r = await openDialog({
    title: 'Source Formatting',
    fields: [
      { key: 'tab', label: 'Indent size (spaces)', type: 'number', value: app.prefs.tabSize, min: 1, max: 8 },
      { key: 'upper', label: 'Upper-case tag names when formatting', type: 'checkbox', value: fmtPrefs.uppercase },
      { key: 'onSave', label: 'Format pages when they are saved', type: 'checkbox', value: app.prefs.formatOnSave },
      { key: 'info', type: 'info', label: 'Formatting puts each block element on its own line, indents children, and leaves the contents of pre, script, style and textarea as written. Style sheets get one declaration per line; scripts are re-indented by bracket depth.' },
    ],
  });
  if (!r) return;
  app.prefs.tabSize = Math.max(1, Math.min(8, Math.round(+r.tab || 2)));
  app.prefs.formatOnSave = !!r.onSave;
  fmtPrefs.uppercase = !!r.upper;
  try { localStorage.setItem('quillloom.formatUpper', r.upper ? '1' : '0'); } catch { /* */ }
  app.savePrefs();
  app.ui.applyPrefs();
}

function toggleBookmark(app: App): void {
  const c = needCode(app);
  if (!c) return;
  if (!c.view.state.field(bookmarkField, false)) { toast('Bookmarks are not ready in this editor yet; try again.'); return; }
  c.view.dispatch({ effects: toggleBm.of(c.view.state.doc.lineAt(c.view.state.selection.main.head).from) });
}

function nextBookmark(app: App, dir: 1 | -1): void {
  const c = needCode(app);
  if (c) { jumpBookmark(c.view, dir); c.focus(); }
}

function emmetCmd(app: App): void {
  const c = needCode(app);
  if (!c) return;
  if (!expandAtCursor(c.view, app.active.path, false)) toast('Type an abbreviation before the cursor in Code view, such as ul>li*3 or div.box>p{Hello}, then run this (Ctrl+E or Tab).');
  c.focus();
  view(app)?.flush();
}

def([
  // --- tags
  { id: 'tag.select', label: 'Select Tag', icon: 'select_all', tab: 'Code', group: 'Tags', noRecord: true, isEnabled: tagEnabled, origin: 'Expression Web', run: (app) => selectTagCmd(app, false) },
  { id: 'tag.selectContents', label: 'Select Tag Contents', icon: 'text_select_start', tab: 'Code', group: 'Tags', noRecord: true, isEnabled: tagEnabled, origin: 'Expression Web', run: (app) => selectTagCmd(app, true) },
  { id: 'tag.selectParent', label: 'Select Parent Tag', icon: 'north_west', tab: 'Code', group: 'Tags', noRecord: true, isEnabled: tagEnabled, origin: 'Dreamweaver', run: (app) => selectParentCmd(app) },
  { id: 'tag.selectChild', label: 'Select Child Tag', icon: 'south_east', tab: 'Code', group: 'Tags', noRecord: true, isEnabled: tagEnabled, origin: 'Dreamweaver', run: (app) => selectChildCmd(app) },
  { id: 'tag.edit', label: 'Edit Tag…', icon: 'edit_note', tab: 'Code', group: 'Tags', edits: true, isEnabled: tagEnabled, origin: 'Expression Web, Dreamweaver', tip: 'Edit the whole selected element as markup', run: (app) => editWholeTag(app) },
  { id: 'tag.quickEdit', label: 'Quick Tag Editor…', icon: 'edit_square', tab: 'Code', group: 'Tags', keys: ['Mod-q'], edits: true, isEnabled: tagEnabled, origin: 'Expression Web, FrontPage', tip: 'Edit the start tag, wrap a tag, or insert HTML', run: (app, arg) => quickTagEditor(app, arg) },
  { id: 'tag.remove', label: 'Remove Tag', icon: 'backspace', tab: 'Code', group: 'Tags', edits: true, isEnabled: tagEnabled, origin: 'Expression Web, Dreamweaver', tip: 'Remove the tag and keep its contents', run: (app) => removeTagCmd(app) },
  { id: 'tag.wrap', label: 'Wrap Tag…', icon: 'wrap_text', tab: 'Code', group: 'Tags', edits: true, isEnabled: tagEnabled, origin: 'Expression Web, Dreamweaver', run: (app, arg) => wrapCmd(app, arg) },
  { id: 'tag.insertHtml', label: 'Insert HTML…', icon: 'html', tab: 'Code', group: 'Tags', edits: true, isEnabled: tagEnabled, origin: 'Expression Web', run: (app, arg) => insertHtmlCmd(app, arg) },
  { id: 'tag.properties', label: 'Tag Properties…', icon: 'tune', tab: 'Code', group: 'Tags', edits: true, isEnabled: tagEnabled, origin: 'Expression Web, FrontPage', tip: 'Every attribute of the selected element, as an editable list', run: (app) => tagProperties(app) },
  { id: 'tag.positioning', label: 'Positioning…', icon: 'open_with', tab: 'Layout', group: 'Position', edits: true, isEnabled: tagEnabled, origin: 'FrontPage, Expression Web', run: (app) => positioning(app) },

  // --- code
  { id: 'code.comment', label: 'Comment', icon: 'comment', tab: 'Code', group: 'Edit', edits: true, isEnabled: isText, origin: 'Dreamweaver', tip: 'Comment or uncomment the selected lines (Ctrl+/ in Code view)', run: (app) => codeCmd(app, 'comment') },
  { id: 'code.uncomment', label: 'Uncomment', icon: 'comments_disabled', tab: 'Code', group: 'Edit', edits: true, isEnabled: isText, origin: 'Dreamweaver', run: (app) => uncomment(app) },
  { id: 'code.indent', label: 'Indent Code', icon: 'format_indent_increase', tab: 'Code', group: 'Edit', edits: true, isEnabled: isText, origin: 'Dreamweaver', run: (app) => codeCmd(app, 'indent') },
  { id: 'code.outdent', label: 'Outdent Code', icon: 'format_indent_decrease', tab: 'Code', group: 'Edit', edits: true, isEnabled: isText, origin: 'Dreamweaver', run: (app) => codeCmd(app, 'outdent') },
  { id: 'code.fold', label: 'Collapse Selection', icon: 'unfold_less', tab: 'Code', group: 'Collapse', noRecord: true, isEnabled: isText, origin: 'Dreamweaver, Expression Web', run: (app) => codeCmd(app, 'fold') },
  { id: 'code.unfold', label: 'Expand Selection', icon: 'unfold_more', tab: 'Code', group: 'Collapse', noRecord: true, isEnabled: isText, origin: 'Dreamweaver, Expression Web', run: (app) => codeCmd(app, 'unfold') },
  { id: 'code.foldAll', label: 'Collapse All', icon: 'compress', tab: 'Code', group: 'Collapse', noRecord: true, isEnabled: isText, origin: 'Dreamweaver', run: (app) => codeCmd(app, 'foldAll') },
  { id: 'code.unfoldAll', label: 'Expand All', icon: 'expand', tab: 'Code', group: 'Collapse', noRecord: true, isEnabled: isText, origin: 'Dreamweaver', run: (app) => codeCmd(app, 'unfoldAll') },
  { id: 'code.matchingTag', label: 'Find Matching Tag', icon: 'data_array', tab: 'Code', group: 'Tags', noRecord: true, isEnabled: isText, origin: 'Expression Web', tip: 'Jump between the start and end tag', run: (app) => matchingTag(app) },
  { id: 'code.matchingBrace', label: 'Find Matching Brace', icon: 'data_object', tab: 'Code', group: 'Tags', noRecord: true, isEnabled: isText, origin: 'Expression Web, Visual Studio', run: (app) => matchingBrace(app) },
  { id: 'code.balanceTags', label: 'Balance Tags', icon: 'code_blocks', tab: 'Code', group: 'Tags', noRecord: true, isEnabled: isText, origin: 'Dreamweaver, Emmet', tip: 'Select the enclosing element; repeat to grow the selection', run: (app) => balanceTags(app) },
  { id: 'code.complete', label: 'Complete Word', icon: 'auto_awesome', tab: 'Code', group: 'Assist', noRecord: true, isEnabled: isText, origin: 'Expression Web IntelliSense', tip: 'Show completions at the cursor (Ctrl+Space in Code view)', run: (app) => { const c = needCode(app); if (!c) return; if (!app.prefs.codeComplete) { toast('Code completion is off. Turn it on with View ▸ Code View Options ▸ Code Completion.'); return; } c.focus(); startCompletion(c.view); } },
  { id: 'code.hints', label: 'Code Hints', icon: 'tips_and_updates', tab: 'Code', group: 'Assist', kind: 'toggle', noRecord: true, origin: 'Expression Web IntelliSense, Dreamweaver', tip: 'Show completion lists automatically while typing in Code view', isActive: (app) => app.prefs.codeComplete, run: (app) => { app.prefs.codeComplete = !app.prefs.codeComplete; app.savePrefs(); app.ui.applyPrefs(); } },
  { id: 'code.emmet', label: 'Expand Abbreviation', icon: 'bolt', tab: 'Code', group: 'Assist', edits: true, isEnabled: isText, origin: 'Emmet (Zen Coding)', keywords: 'emmet zen coding', tip: 'Expand an abbreviation such as ul>li*3 before the cursor (Tab or Ctrl+E in Code view)', run: (app) => emmetCmd(app) },
  { id: 'code.snippetsInsert', label: 'Insert Snippet', icon: 'integration_instructions', tab: 'Code', group: 'Assist', noRecord: true, origin: 'Dreamweaver, Expression Web', run: (app) => app.ui.togglePane('snippets') },
  { id: 'code.toggleBookmark', label: 'Toggle Bookmark', icon: 'bookmark_add', tab: 'Code', group: 'Bookmarks', noRecord: true, isEnabled: isText, origin: 'Expression Web, Visual Studio', tip: 'Ctrl+F2 in Code view; click the gutter to toggle too', run: (app) => toggleBookmark(app) },
  { id: 'code.nextBookmark', label: 'Next Bookmark', icon: 'bookmark', tab: 'Code', group: 'Bookmarks', keys: ['F2'], noRecord: true, isEnabled: isText, origin: 'Expression Web, Visual Studio', run: (app) => nextBookmark(app, 1) },
  { id: 'code.prevBookmark', label: 'Previous Bookmark', icon: 'bookmarks', tab: 'Code', group: 'Bookmarks', keys: ['Shift-F2'], noRecord: true, isEnabled: isText, origin: 'Expression Web, Visual Studio', run: (app) => nextBookmark(app, -1) },
  { id: 'code.clearBookmarks', label: 'Clear Bookmarks', icon: 'bookmark_remove', tab: 'Code', group: 'Bookmarks', noRecord: true, isEnabled: isText, origin: 'Visual Studio', run: (app) => { const c = app.active?.ui?.code; if (c?.view.state.field(bookmarkField, false)) c.view.dispatch({ effects: clearBm.of(null) }); } },
  { id: 'code.format', label: 'Apply Source Formatting', icon: 'format_align_left', tab: 'Code', group: 'Edit', edits: true, isEnabled: isText, origin: 'Expression Web, Dreamweaver', run: (app) => formatPage(app) },
  { id: 'code.formatSelection', label: 'Format Selection', icon: 'format_align_justify', tab: 'Code', group: 'Edit', edits: true, isEnabled: isText, origin: 'Expression Web', run: (app) => formatSelection(app) },
  { id: 'code.formatSite', label: 'Format All Files', icon: 'auto_fix_high', tab: 'Code', group: 'Edit', edits: true, origin: 'Dreamweaver', run: (app) => formatSite(app) },
  { id: 'code.formatSettings', label: 'Source Formatting Settings…', icon: 'settings', tab: 'Code', group: 'Edit', noRecord: true, origin: 'Dreamweaver, Expression Web', run: (app) => formatSettings(app) },
  { id: 'code.upperTags', label: 'Upper-Case Tags', icon: 'match_case', tab: 'Code', group: 'Case & Markup', edits: true, isEnabled: isText, origin: 'FrontPage, Dreamweaver', run: (app) => { app.editSource('Upper-Case Tags', (s) => changeTagCase(s, true)); } },
  { id: 'code.lowerTags', label: 'Lower-Case Tags', icon: 'text_fields', tab: 'Code', group: 'Case & Markup', edits: true, isEnabled: isText, origin: 'FrontPage, Dreamweaver', run: (app) => { app.editSource('Lower-Case Tags', (s) => changeTagCase(s, false)); } },
]);
