/**
 * Source clean-up and conversion: the work behind Optimize HTML, Clean Up HTML, Clean Up Word HTML,
 * the markup cleaner, font-to-CSS, inline styles to classes, HTML5 and XHTML conversion, mojibake
 * repair, minification and the line comparison used by Compare Files.
 *
 * Everything here is a pure function of the source text. Changes are made by splicing the text at
 * positions the tokenizer reports, so the parts of a page that are not touched keep their exact
 * formatting, and nothing inside <script>, <style>, <pre> or comments is rewritten by accident.
 */
import { tokenize, parseHtml, findAll, attr, type Token, type Attr, type HNode } from './validate';
import { minifyHtml, toXhtml, setDoctype, getDoctype } from '../model/html';

export interface CleanResult { src: string; log: string[] }

// --------------------------------------------------------------------------------------------
// Splicing helpers

interface Edit { start: number; end: number; text: string }

/** Applies non-overlapping edits (any order). Overlapping later edits are dropped. */
export function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) continue;
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + src.slice(pos);
}

/** Widens a deletion to its whole line when nothing else is on that line. */
function lineRange(src: string, start: number, end: number): [number, number] {
  let a = start;
  while (a > 0 && (src[a - 1] === ' ' || src[a - 1] === '\t')) a--;
  let b = end;
  while (b < src.length && (src[b] === ' ' || src[b] === '\t')) b++;
  if ((a === 0 || src[a - 1] === '\n') && (b === src.length || src[b] === '\n' || src[b] === '\r')) {
    if (src[b] === '\r') b++;
    if (src[b] === '\n') b++;
    return [a, b];
  }
  return [start, end];
}

const attrText = (src: string, a: Attr) => src.slice(a.start, a.end);
const q = (v: string) => `"${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/&amp;(#?\w+;)/g, '&$1')}"`;

/** Writes a start tag from a token, with attributes removed, changed or added. Unchanged ones keep their text. */
export function rebuildTag(src: string, t: Token, opts: { name?: string; remove?: string[]; set?: Record<string, string | null>; selfClose?: boolean } = {}): string {
  const remove = new Set((opts.remove || []).map((x) => x.toLowerCase()));
  const set = opts.set || {};
  const parts: string[] = [];
  const done = new Set<string>();
  for (const a of t.attrs) {
    if (remove.has(a.name)) continue;
    if (a.name in set) { done.add(a.name); const v = set[a.name]; if (v != null) parts.push(`${a.name}=${q(v)}`); continue; }
    parts.push(attrText(src, a));
  }
  for (const [k, v] of Object.entries(set)) if (!done.has(k) && v != null) parts.push(`${k}=${q(v)}`);
  const name = opts.name ?? t.raw;
  const sc = opts.selfClose ?? t.selfClose;
  return `<${name}${parts.length ? ' ' + parts.join(' ') : ''}${sc ? ' /' : ''}>`;
}

/** Merges CSS declarations into a style string; existing properties win unless `override`. */
export function mergeStyle(style: string | null, add: Record<string, string>, override = false): string {
  const decl = new Map<string, string>();
  for (const part of (style || '').split(';')) { const i = part.indexOf(':'); if (i > 0) decl.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()); }
  for (const [k, v] of Object.entries(add)) if (override || !decl.has(k)) decl.set(k, v);
  return [...decl].map(([k, v]) => `${k}: ${v}`).join('; ');
}

// --------------------------------------------------------------------------------------------
// Comments

const TEMPLATE_COMMENT = /^\s*(#?(Begin|End)(Template|Editable|LibraryItem)|Instance(Begin|End)|Template(Begin|End|Info|Param|Expr)|#(include|echo|config|exec|set|if|elif|else|endif|fsize|flastmod)\b)/i;
const CONDITIONAL_COMMENT = /^\s*\[if\s|<!\[endif\]\s*$|^\s*<!\[endif\]/i;
const LAYOUT_COMMENT = /^\s*MS(Table|Cell|Row)Type\b|^\s*MSTable/i;

export interface CommentOptions { template?: boolean; conditional?: boolean; layout?: boolean; webbot?: boolean; other?: boolean }

/** Removes comments by kind. By default every comment except template markers, conditional comments and webbots. */
export function removeComments(src: string, opts: CommentOptions = { other: true, layout: true }): { src: string; count: number } {
  const edits: Edit[] = [];
  for (const t of tokenize(src)) {
    if (t.type !== 'comment') continue;
    const kind = TEMPLATE_COMMENT.test(t.text) ? 'template' : CONDITIONAL_COMMENT.test(t.text) ? 'conditional' : LAYOUT_COMMENT.test(t.text) ? 'layout' : /^\s*webbot\b/i.test(t.text) ? 'webbot' : 'other';
    if (!opts[kind as keyof CommentOptions]) continue;
    const [a, b] = lineRange(src, t.start, t.end);
    edits.push({ start: a, end: b, text: '' });
  }
  return { src: applyEdits(src, edits), count: edits.length };
}

/** Removes the "<!-- … //-->" wrappers old pages put around script code. */
export function removeScriptCommentWrappers(src: string): { src: string; count: number } {
  let count = 0;
  const out = src.replace(/(<script\b[^>]*>)(\s*)<!--[^\n]*\n([\s\S]*?)\n?[ \t]*(?:\/\/)?[ \t]*-->(\s*<\/script>)/gi, (m, open, ws, body, close) => { count++; return `${open}${ws}${body}\n${close.replace(/^\s*/, '')}`; });
  return { src: out, count };
}

// --------------------------------------------------------------------------------------------
// Empty and redundant tags

const EMPTY_REMOVABLE = new Set('a abbr b big blockquote center cite code dd del dfn div dl dt em font h1 h2 h3 h4 h5 h6 i ins kbd li mark ol p q s samp small span strike strong sub sup tt u ul var label section article aside header footer nav'.split(' '));
const HARMLESS_ATTRS = /^(style|align|face|size|color|lang|dir|title|xml:lang|valign|class)$/;

/**
 * Removes elements with nothing in them (or only white space). Elements that may be targets or hooks are
 * kept: anything with an id, name, role, data-* or aria-* attribute, and (with keepClassed) a class.
 */
export function removeEmptyTags(src: string, opts: { nbsp?: boolean; keepClassed?: boolean; tags?: string[] } = {}): { src: string; count: number } {
  const keepClassed = opts.keepClassed ?? true;
  const names = opts.tags ? new Set(opts.tags) : EMPTY_REMOVABLE;
  let count = 0;
  let s = src;
  for (let pass = 0; pass < 8; pass++) {
    const blank = opts.nbsp ? '(?:\\s|&nbsp;|&#160;| )*' : '\\s*';
    const re = new RegExp(`<([a-zA-Z][\\w]*)(\\s(?:"[^"]*"|'[^']*'|[^'">])*)?>${blank}</\\1\\s*>`, 'g');
    let changed = false;
    s = s.replace(re, (m, name: string, attrs: string | undefined) => {
      const n = name.toLowerCase();
      if (!names.has(n)) return m;
      const t = tokenize(`<x${attrs || ''}>`)[0];
      const keep = t?.attrs.some((a) => !HARMLESS_ATTRS.test(a.name) || (a.name === 'class' && keepClassed));
      if (keep) return m;
      if (n === 'a' && t?.attrs.length) return m;
      count++;
      changed = true;
      return '';
    });
    if (!changed) break;
  }
  return { src: s, count };
}

/** <b><b>x</b></b> → <b>x</b>, for tags without attributes. */
export function removeRedundantNested(src: string): { src: string; count: number } {
  let count = 0;
  let s = src;
  for (const tag of ['b', 'i', 'u', 's', 'em', 'strong', 'small', 'big', 'code', 'sub', 'sup', 'span', 'tt', 'strike', 'font', 'center']) {
    const re = new RegExp(`<${tag}>(\\s*)<${tag}>((?:(?!<\\/?${tag}\\b)[\\s\\S])*)<\\/${tag}>(\\s*)<\\/${tag}>`, 'gi');
    for (let k = 0; k < 6; k++) {
      const before = s;
      s = s.replace(re, (m, a, inner, b) => { count++; return `<${tag}>${a}${inner}${b}</${tag}>`; });
      if (s === before) break;
    }
  }
  return { src: s, count };
}

/** Removes the named tags but keeps their contents (script, style and xml are removed with their contents). */
export function removeTags(src: string, names: string[]): { src: string; count: number } {
  const want = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const edits: Edit[] = [];
  const toks = tokenize(src);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if ((t.type !== 'start' && t.type !== 'end') || !want.has(t.name)) continue;
    if (t.type === 'start' && /^(script|style|xml|noscript|iframe|object)$/.test(t.name)) {
      const end = toks.slice(i + 1).find((x) => x.type === 'end' && x.name === t.name);
      edits.push({ start: t.start, end: end ? end.end : t.end, text: '' });
      continue;
    }
    edits.push({ start: t.start, end: t.end, text: '' });
  }
  return { src: applyEdits(src, edits), count: edits.length };
}

/** Removes <font> tags, keeping their text. */
export function removeFontTags(src: string): { src: string; count: number } {
  const r = removeTags(src, ['font', 'basefont']);
  return { src: r.src, count: r.count };
}

// --------------------------------------------------------------------------------------------
// Font tags to CSS

const FONT_SIZES = ['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large'];

export function fontAttrsToCss(face: string | null, size: string | null, color: string | null): Record<string, string> {
  const css: Record<string, string> = {};
  if (face) css['font-family'] = face.split(',').map((f) => f.trim()).filter(Boolean).map((f) => (/\s/.test(f) && !/^["']/.test(f) ? `'${f}'` : f)).join(', ');
  if (size) {
    const s = size.trim();
    let n = /^[+-]/.test(s) ? 3 + parseInt(s, 10) : parseInt(s, 10);
    if (Number.isFinite(n)) { n = Math.max(1, Math.min(7, n)); css['font-size'] = FONT_SIZES[n - 1]; }
  }
  if (color) css.color = /^[0-9a-f]{6}$/i.test(color.trim()) ? '#' + color.trim() : color.trim();
  return css;
}

/** Converts <font face size color> to <span style="…">; font tags with nothing to say are removed. Nested spans that wrap the same text are combined. */
export function fontToCss(src: string): { src: string; count: number } {
  const toks = tokenize(src);
  const edits: Edit[] = [];
  const stack: boolean[] = [];
  let count = 0;
  for (const t of toks) {
    if (t.name !== 'font' || (t.type !== 'start' && t.type !== 'end')) continue;
    if (t.type === 'start') {
      const get = (n: string) => { const a = t.attrs.find((x) => x.name === n); return a ? a.value ?? '' : null; };
      const css = fontAttrsToCss(get('face'), get('size'), get('color'));
      const others = t.attrs.filter((a) => !/^(face|size|color|style)$/.test(a.name));
      const style = mergeStyle(get('style'), css, false);
      count++;
      if (!style && !others.length) { edits.push({ start: t.start, end: t.end, text: '' }); stack.push(false); continue; }
      edits.push({ start: t.start, end: t.end, text: rebuildTag(src, t, { name: 'span', remove: ['face', 'size', 'color'], set: { style: style || null } }) });
      stack.push(true);
    } else {
      const was = stack.pop();
      edits.push({ start: t.start, end: t.end, text: was ? '</span>' : '' });
    }
  }
  const out = combineNestedSpans(applyEdits(src, edits));
  return { src: out, count };
}

/** <span style="a"><span style="b">x</span></span> → <span style="a; b">x</span>. */
export function combineNestedSpans(src: string): string {
  const re = /<span style="([^"]*)">(\s*)<span style="([^"]*)">((?:(?!<\/?span\b)[\s\S])*)<\/span>(\s*)<\/span>/g;
  let s = src;
  for (let k = 0; k < 6; k++) {
    const before = s;
    s = s.replace(re, (m, a, w1, b, inner, w2) => `<span style="${mergeStyle(a, Object.fromEntries(b.split(';').map((d: string) => d.split(':')).filter((p: string[]) => p.length >= 2).map((p: string[]) => [p[0].trim().toLowerCase(), p.slice(1).join(':').trim()])), true)}">${w1}${inner}${w2}</span>`);
    if (s === before) break;
  }
  return s;
}

/** <font a><font b>x</font></font> → <font a b>x</font> (the inner attributes win). */
export function combineNestedFonts(src: string): { src: string; count: number } {
  const re = /<font(\s[^>]*)?>(\s*)<font(\s[^>]*)?>((?:(?!<\/?font\b)[\s\S])*)<\/font>(\s*)<\/font>/gi;
  let count = 0;
  let s = src;
  for (let k = 0; k < 6; k++) {
    const before = s;
    s = s.replace(re, (m, a, w1, b, inner, w2) => {
      const ta = tokenize(`<font${a || ''}>`)[0], tb = tokenize(`<font${b || ''}>`)[0];
      const merged = new Map<string, string | null>();
      for (const x of [...ta.attrs, ...tb.attrs]) merged.set(x.name, x.value);
      count++;
      return `<font${[...merged].map(([k2, v]) => (v == null ? ` ${k2}` : ` ${k2}=${q(v)}`)).join('')}>${w1}${inner}${w2}</font>`;
    });
    if (s === before) break;
  }
  return { src: s, count };
}

// --------------------------------------------------------------------------------------------
// Word HTML

export interface WordOptions {
  /** Remove Word's style sheets and mso- declarations (else only mso- declarations). */
  css?: boolean;
  /** Convert font tags to CSS (else remove them). */
  fonts?: 'css' | 'remove' | 'keep';
  /** Turn Word list paragraphs into ul and ol. */
  lists?: boolean;
  /** Remove paragraphs that hold only a non-breaking space. */
  emptyParagraphs?: boolean;
  /** Remove font-family declarations in style attributes. */
  fontFamilies?: boolean;
  /** Remove lang attributes. */
  lang?: boolean;
}

const WORD_DECL = /^(mso-|tab-stops|tab-interval|text-autospace|layout-grid|punctuation-wrap|text-justify|word-break|page-break|widows|orphans|font-kerning|text-underline|line-break)/i;

/** Thorough clean-up of HTML saved or pasted from a word processor. */
export function cleanupWordHtml(src: string, opts: WordOptions = {}): CleanResult {
  const o: Required<WordOptions> = { css: true, fonts: 'css', lists: true, emptyParagraphs: true, fontFamilies: false, lang: true, ...opts };
  const log: string[] = [];
  const n0 = src.length;
  let s = src;
  const count = (label: string, re: RegExp, rep: string | ((...a: any[]) => string) = '') => {
    let c = 0;
    s = s.replace(re, (...a: any[]) => { c++; return typeof rep === 'string' ? rep : rep(...a); });
    if (c) log.push(`${label}: ${c}`);
  };
  // Lists first: they need the bullet markers Word puts in downlevel conditional blocks.
  if (o.lists) { const r = convertWordLists(s); s = r.src; if (r.count) log.push(`Word lists converted: ${r.count}`); }
  count('Word conditional blocks removed', /<!--\[if [^\]]*(?:mso|vml|supportFields|gte)[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi);
  count('Word downlevel markers removed', /<!\[if [^\]]*\]>|<!\[endif\]>/gi);
  count('XML data islands removed', /<xml\b[^>]*>[\s\S]*?<\/xml>/gi);
  count('Office tags removed', /<\/?(?:o|w|v|m|st\d|x|dt):[^>]*>/gi);
  count('Word meta and link tags removed', /[ \t]*<(?:meta\s+(?:name|http-equiv)\s*=\s*["']?(?:ProgId|Generator|Originator)["']?[^>]*|link\s+rel\s*=\s*["']?(?:File-List|Edit-Time-Data|themeData|colorSchemeMapping|Preview|OLE-Object-Data|Main-File|aFile-List)["']?[^>]*)>[ \t]*\r?\n?/gi);
  count('Office namespaces removed', /\s+xmlns:\w+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi);
  count('Legacy HTML 4 namespace removed', /\s+xmlns\s*=\s*["']http:\/\/www\.w3\.org\/TR\/REC-html40["']/gi);
  if (o.css) {
    count('Word style sheets removed', /[ \t]*<style\b[^>]*>(?:(?!<\/style>)[\s\S])*?(?:Mso|mso-|WordSection|Section1)[\s\S]*?<\/style>[ \t]*\r?\n?/gi);
  }
  // Attributes, tag by tag.
  const toks = tokenize(s);
  const edits: Edit[] = [];
  let classes = 0, styles = 0, langs = 0, anchors = 0, sections = 0;
  const unwrapEnds = new Map<string, number>();
  const stack: { name: string; unwrap: boolean }[] = [];
  for (const t of toks) {
    if (t.type === 'start' && !t.name.includes(':')) {
      const cls = t.attrs.find((a) => a.name === 'class');
      const st = t.attrs.find((a) => a.name === 'style');
      const set: Record<string, string | null> = {};
      const remove: string[] = [];
      let unwrap = false;
      if (cls) {
        const kept = (cls.value || '').split(/\s+/).filter((c) => c && !/^Mso|^WordSection\d*$|^Section\d+$|^xl\d+$/i.test(c));
        if (/(^|\s)(WordSection\d*|Section\d+)(\s|$)/.test(cls.value || '') && t.name === 'div') { unwrap = true; sections++; }
        if (kept.join(' ') !== (cls.value || '').trim()) { classes++; set.class = kept.length ? kept.join(' ') : null; }
      }
      if (st) {
        const decls = (st.value || '').split(';').map((d) => d.trim()).filter(Boolean);
        const kept = decls.filter((d) => { const p = d.split(':')[0].trim(); return !WORD_DECL.test(p) && !(o.fontFamilies && /^font-family$/i.test(p)) && !/^font\s*:\s*7\.0pt/i.test(d); });
        if (kept.length !== decls.length) { styles++; set.style = kept.length ? kept.join('; ') : null; }
      }
      for (const a of t.attrs) if (a.name.includes(':') && a.name !== 'xml:lang' && a.name !== 'xmlns') remove.push(a.name);
      if (o.lang && t.attrs.some((a) => a.name === 'lang') && t.name !== 'html') { remove.push('lang'); langs++; }
      if (t.name === 'body') remove.push('link', 'vlink');
      if (t.name === 'a') {
        const nm = t.attrs.find((a) => a.name === 'name');
        if (nm && /^(_Toc|_Hlk|_Ref|OLE_LINK|_GoBack|_MON_|_Hlt)/.test(nm.value || '') && !t.attrs.some((a) => a.name === 'href')) { unwrap = true; anchors++; }
      }
      if (!VOID.has(t.name) && !t.selfClose) stack.push({ name: t.name, unwrap });
      if (unwrap) { edits.push({ start: t.start, end: t.end, text: '' }); continue; }
      if (remove.length || Object.keys(set).length) edits.push({ start: t.start, end: t.end, text: rebuildTag(s, t, { remove, set }) });
    } else if (t.type === 'end') {
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== t.name) k--;
      if (k >= 0) {
        const e = stack[k];
        stack.length = k;
        if (e.unwrap) edits.push({ start: t.start, end: t.end, text: '' });
      }
    }
  }
  void unwrapEnds;
  s = applyEdits(s, edits);
  if (classes) log.push(`Word class names removed: ${classes}`);
  if (styles) log.push(`Word style declarations cleaned: ${styles}`);
  if (langs) log.push(`lang attributes removed: ${langs}`);
  if (anchors) log.push(`Bookmark anchors removed: ${anchors}`);
  if (sections) log.push(`Word section wrappers removed: ${sections}`);
  // Spans that are left without attributes say nothing.
  const sp = unwrapBare(s, ['span']);
  s = sp.src;
  if (sp.count) log.push(`Empty spans removed: ${sp.count}`);
  if (o.fonts === 'css') { const r = fontToCss(s); s = r.src; if (r.count) log.push(`Font tags converted to CSS: ${r.count}`); }
  else if (o.fonts === 'remove') { const r = removeFontTags(s); s = r.src; if (r.count) log.push(`Font tags removed: ${r.count}`); }
  if (o.emptyParagraphs) count('Empty paragraphs removed', /[ \t]*<p\b[^>]*>(?:\s|&nbsp;|&#160;| )*<\/p>[ \t]*\r?\n?/gi);
  const em = removeEmptyTags(s);
  s = em.src;
  if (em.count) log.push(`Empty tags removed: ${em.count}`);
  // Word writes unquoted attribute values; quote the ones it leaves.
  s = s.replace(/<([a-zA-Z][\w]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g, (m, n, attrs: string, sc) => `<${n}${attrs.replace(/(\s[\w-]+)\s*=\s*([^\s"'>]+)/g, '$1="$2"').replace(/(\s[\w-]+)\s*=\s*'([^'"]*)'/g, '$1="$2"')}${sc ? ' /' : ''}>`);
  s = s.replace(/\n{3,}/g, '\n\n');
  log.push(`Size: ${n0.toLocaleString()} → ${s.length.toLocaleString()} characters`);
  return { src: s, log };
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param', 'basefont', 'frame']);

/** Removes start and end tags of the named elements when the start tag has no attributes. */
export function unwrapBare(src: string, names: string[]): { src: string; count: number } {
  const want = new Set(names);
  const edits: Edit[] = [];
  const stack: { name: string; bare: boolean }[] = [];
  let count = 0;
  for (const t of tokenize(src)) {
    if (t.type === 'start' && !VOID.has(t.name) && !t.selfClose) {
      const bare = want.has(t.name) && !t.attrs.length;
      stack.push({ name: t.name, bare });
      if (bare) { edits.push({ start: t.start, end: t.end, text: '' }); count++; }
    } else if (t.type === 'end') {
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== t.name) k--;
      if (k >= 0) { const e = stack[k]; stack.length = k; if (e.bare) edits.push({ start: t.start, end: t.end, text: '' }); }
    }
  }
  return { src: applyEdits(src, edits), count };
}

/** Word list paragraphs (mso-list: lN levelM) → nested ul/ol. */
export function convertWordLists(src: string): { src: string; count: number } {
  const re = /<p\b([^>]*mso-list:\s*l(\d+)\s+level(\d+)[^>]*)>([\s\S]*?)<\/p>/gi;
  const items: { start: number; end: number; list: string; level: number; ordered: boolean; type: string; html: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let body = m[4];
    let marker = '';
    body = body.replace(/<!\[if !supportLists\]>([\s\S]*?)<!\[endif\]>/i, (x, inner) => { marker = inner; return ''; });
    if (!marker) body = body.replace(/<span[^>]*mso-list:\s*Ignore[^>]*>([\s\S]*?)<\/span>(\s*<\/span>)*/i, (x, inner) => { marker = inner; return ''; });
    const mk = marker.replace(/<[^>]+>/g, '').replace(/&nbsp;| /g, ' ').trim();
    const ordered = /^(\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]/.test(mk);
    const type = /^[a-z][.)]/.test(mk) && !/^[ivx]+[.)]/.test(mk) ? 'a' : /^[A-Z][.)]/.test(mk) && !/^[IVX]+[.)]/.test(mk) ? 'A' : /^[ivx]+[.)]/.test(mk) ? 'i' : /^[IVX]+[.)]/.test(mk) ? 'I' : '1';
    body = body.replace(/<o:p>[\s\S]*?<\/o:p>/gi, '').trim();
    items.push({ start: m.index, end: m.index + m[0].length, list: m[2], level: +m[3], ordered, type, html: body });
  }
  if (!items.length) return { src, count: 0 };
  // Group consecutive items (only white space between) into lists.
  const groups: (typeof items)[] = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    if (g && /^\s*$/.test(src.slice(g[g.length - 1].end, it.start)) && g[g.length - 1].list === it.list) g.push(it); else groups.push([it]);
  }
  const edits: Edit[] = [];
  for (const g of groups) {
    let out = '';
    const open: { level: number; tag: string }[] = [];
    for (const it of g) {
      const tag = it.ordered ? 'ol' : 'ul';
      while (open.length && open[open.length - 1].level > it.level) { out += `</li></${open.pop()!.tag}>`; }
      if (!open.length || open[open.length - 1].level < it.level) {
        const attrs = it.ordered && it.type !== '1' ? ` type="${it.type}"` : '';
        out += `${open.length ? '\n' : ''}<${tag}${attrs}>\n<li>${it.html}`;
        open.push({ level: it.level, tag });
      } else out += `</li>\n<li>${it.html}`;
    }
    while (open.length) out += `</li>\n</${open.pop()!.tag}>`;
    edits.push({ start: g[0].start, end: g[g.length - 1].end, text: out });
  }
  return { src: applyEdits(src, edits), count: groups.length };
}

// --------------------------------------------------------------------------------------------
// Optimize HTML (Expression Web) and Clean Up HTML (Dreamweaver)

export interface OptimizeOptions {
  commentsAll?: boolean; commentsTemplate?: boolean; commentsLayout?: boolean; commentsScript?: boolean; commentsOther?: boolean;
  whitespaceLeading?: boolean; whitespaceAll?: boolean;
  wordHtml?: boolean; unusedStyles?: boolean; emptyTags?: boolean; generator?: boolean; frontpage?: boolean; tracing?: boolean; fontToCss?: boolean;
}

export function optimizeHtml(src: string, o: OptimizeOptions): CleanResult {
  const log: string[] = [];
  let s = src;
  const n0 = s.length;
  if (o.wordHtml) { const r = cleanupWordHtml(s, { fonts: 'keep', emptyParagraphs: false }); s = r.src; log.push(...r.log.filter((l) => !l.startsWith('Size'))); }
  if (o.frontpage) {
    let c = 0;
    s = s.replace(/[ \t]*<!--\s*webbot\b[^>]*?-->[ \t]*\r?\n?/gi, () => { c++; return ''; });
    s = s.replace(/[ \t]*<meta\s+name\s*=\s*["']Microsoft (Theme|Border)["'][^>]*>[ \t]*\r?\n?/gi, () => { c++; return ''; });
    if (c) log.push(`FrontPage markup removed: ${c}`);
  }
  if (o.tracing) {
    let c = 0;
    s = s.replace(/<[a-zA-Z][^<>]*>/g, (tag) => tag.replace(/\s+(fp-[\w-]+|tracingsrc|tracingopacity|x-claris-[\w-]+|u\d+:[\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => { c++; return ''; }));
    if (c) log.push(`Tracing image and interactive button attributes removed: ${c}`);
  }
  if (o.generator) {
    let c = 0;
    s = s.replace(/[ \t]*<meta\s+[^>]*name\s*=\s*["']?(generator|ProgId|Originator)["']?[^>]*>[ \t]*\r?\n?/gi, () => { c++; return ''; });
    if (c) log.push(`Generator and ProgID tags removed: ${c}`);
  }
  if (o.commentsAll || o.commentsTemplate || o.commentsLayout || o.commentsOther) {
    const r = removeComments(s, o.commentsAll ? { template: true, layout: true, other: true, webbot: true } : { template: o.commentsTemplate, layout: o.commentsLayout, other: o.commentsOther });
    s = r.src;
    if (r.count) log.push(`Comments removed: ${r.count}`);
  }
  if (o.commentsScript || o.commentsAll) { const r = removeScriptCommentWrappers(s); s = r.src; if (r.count) log.push(`Script comment wrappers removed: ${r.count}`); }
  if (o.fontToCss) { const r = fontToCss(s); s = r.src; if (r.count) log.push(`Font tags converted to CSS: ${r.count}`); }
  if (o.unusedStyles) { const r = removeUnusedStyles(s); s = r.src; if (r.count) log.push(`Unused style rules removed: ${r.count}`); }
  if (o.emptyTags) { const r = removeEmptyTags(s); s = r.src; if (r.count) log.push(`Empty tags removed: ${r.count}`); }
  if (o.whitespaceAll) { s = minifyHtml(s); log.push('All unneeded white space removed'); }
  else if (o.whitespaceLeading) { s = stripLeadingWhitespace(s); log.push('Leading white space removed'); }
  log.push(`Size: ${n0.toLocaleString()} → ${s.length.toLocaleString()} characters`);
  return { src: s, log };
}

/** Removes indentation outside pre, textarea, script and style. */
export function stripLeadingWhitespace(src: string): string {
  const keep: string[] = [];
  const s = src.replace(/<(pre|textarea|script|style)\b[\s\S]*?<\/\1>/gi, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
  return s.replace(/^[ \t]+/gm, '').replace(/\u0000(\d+)\u0000/g, (m, i) => keep[+i]);
}

/** Calls `keep(selector)` for each rule's selector list; drops rules it rejects. Handles @media and @supports. */
export function filterCssRules(css: string, keep: (selector: string) => boolean): { css: string; removed: number } {
  let removed = 0;
  const walk = (text: string): string => {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const open = findOutside(text, '{', i);
      if (open < 0) { out += text.slice(i); break; }
      const close = matchBrace(text, open);
      const prelude = text.slice(i, open);
      const body = text.slice(open + 1, close);
      const sel = prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (/^@(media|supports|layer|container|document)\b/i.test(sel)) out += prelude + '{' + walk(body) + '}';
      else if (sel.startsWith('@') || !sel) out += prelude + '{' + body + '}';
      else if (keep(sel)) out += prelude + '{' + body + '}';
      else { removed++; out += prelude.replace(/[^\n]*$/, '').replace(/\n$/, ''); }
      i = close + 1;
    }
    return out;
  };
  return { css: walk(css), removed };
}
function findOutside(s: string, ch: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { const e = s.indexOf(c, i + 1); i = e < 0 ? s.length : e; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; continue; }
    if (c === ch) return i;
  }
  return -1;
}
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { const e = s.indexOf(c, i + 1); i = e < 0 ? s.length : e; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return s.length - 1;
}

/** Removes rules of the page's <style> blocks whose class and id selectors match nothing in the page. */
export function removeUnusedStyles(src: string): { src: string; count: number } {
  const { root } = parseHtml(src);
  const classes = new Set<string>();
  const ids = new Set<string>();
  for (const e of findAll(root, () => true)) {
    for (const c of (attr(e, 'class') || '').split(/\s+/)) if (c) classes.add(c);
    const id = attr(e, 'id');
    if (id) ids.add(id);
  }
  const scripts = findAll(root, (e) => e.name === 'script').map((e) => e.children.map((c) => c.text).join('')).join('\n');
  const used = (sel: string) => sel.split(',').some((one) => {
    const names = [...one.matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g)];
    return names.every(([, k, n]) => (k === '.' ? classes.has(n) : ids.has(n)) || scripts.includes(n));
  });
  let count = 0;
  const out = src.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, b) => { const r = filterCssRules(css, used); count += r.removed; return a + r.css + b; });
  return { src: out, count };
}

export interface CleanupHtmlOptions { emptyTags?: boolean; redundantNested?: boolean; otherComments?: boolean; templateComments?: boolean; tags?: string; combineFonts?: boolean }

/** Dreamweaver-style Clean Up HTML. */
export function cleanupHtml(src: string, o: CleanupHtmlOptions): CleanResult {
  const log: string[] = [];
  let s = src;
  if (o.otherComments || o.templateComments) { const r = removeComments(s, { other: o.otherComments, layout: o.otherComments, template: o.templateComments }); s = r.src; if (r.count) log.push(`Comments removed: ${r.count}`); }
  if (o.tags?.trim()) { const r = removeTags(s, o.tags.split(/[\s,]+/)); s = r.src; if (r.count) log.push(`Tags removed (${o.tags.trim()}): ${r.count}`); }
  if (o.combineFonts) { const r = combineNestedFonts(s); s = r.src; if (r.count) log.push(`Nested font tags combined: ${r.count}`); }
  if (o.redundantNested) { const r = removeRedundantNested(s); s = r.src; if (r.count) log.push(`Redundant nested tags removed: ${r.count}`); }
  if (o.emptyTags) { const r = removeEmptyTags(s); s = r.src; if (r.count) log.push(`Empty container tags removed: ${r.count}`); }
  if (!log.length) log.push('Nothing to clean up.');
  return { src: s, log };
}

// --------------------------------------------------------------------------------------------
// Markup cleaner (Composer)

export function markupCleaner(src: string, o: { trailingBr?: boolean; emptyBlocks?: boolean; nestedLists?: boolean }): CleanResult {
  const log: string[] = [];
  let s = src;
  if (o.trailingBr) {
    let c = 0;
    s = s.replace(/(?:\s*<br\s*\/?>)+(\s*)<\/(p|div|li|h[1-6]|td|th|dd|dt|blockquote|address|caption)>/gi, (m, ws, tag) => { c++; return `${ws}</${tag}>`; });
    if (c) log.push(`Trailing line breaks removed: ${c}`);
  }
  if (o.emptyBlocks) { const r = removeEmptyTags(s, { tags: ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'address', 'li', 'ul', 'ol', 'dl'] }); s = r.src; if (r.count) log.push(`Empty blocks removed: ${r.count}`); }
  if (o.nestedLists) { const r = fixNestedLists(s); s = r.src; if (r.count) log.push(`Nested lists moved into list items: ${r.count}`); }
  if (!log.length) log.push('The markup was already clean.');
  return { src: s, log };
}

/** A list written directly inside another list (not in an li) moves into the item before it. */
export function fixNestedLists(src: string): { src: string; count: number } {
  const { root } = parseHtml(src);
  const edits: Edit[] = [];
  for (const l of findAll(root, (e) => (e.name === 'ul' || e.name === 'ol') && !!e.parent && (e.parent.name === 'ul' || e.parent.name === 'ol'))) {
    const sibs = l.parent!.children.filter((c) => c.type === 'el');
    const prev = sibs[sibs.indexOf(l) - 1];
    if (!prev || prev.name !== 'li' || prev.implied || prev.closeEnd <= prev.close) continue;
    edits.push({ start: prev.close, end: prev.closeEnd, text: '' });
    edits.push({ start: l.closeEnd, end: l.closeEnd, text: '</li>' });
  }
  return { src: applyEdits(src, edits), count: edits.length / 2 };
}

// --------------------------------------------------------------------------------------------
// Inline styles to classes; inline blocks

export interface InlineBlock { start: number; end: number; content: string; open: Token; contentStart: number }

/** <style> or <script> blocks written in the page (scripts with src, JSON and templates are skipped). */
export function inlineBlocks(src: string, tag: 'style' | 'script'): InlineBlock[] {
  const toks = tokenize(src);
  const out: InlineBlock[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'start' || t.name !== tag) continue;
    if (tag === 'script') {
      if (t.attrs.some((a) => a.name === 'src')) continue;
      const type = (t.attrs.find((a) => a.name === 'type')?.value || '').toLowerCase().trim();
      if (type && !/^(text\/javascript|application\/javascript|module|text\/ecmascript)$/.test(type)) continue;
    }
    const body = toks[i + 1]?.type === 'text' ? toks[i + 1] : null;
    const end = toks.slice(i + 1, i + 3).find((x) => x.type === 'end' && x.name === tag);
    if (!end) continue;
    const content = body ? body.text : '';
    if (/<\?|<%|\{\{/.test(content)) continue;
    out.push({ start: t.start, end: end.end, content, open: t, contentStart: body ? body.start : t.end });
  }
  return out;
}

const normDecls = (s: string) => s.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(':'); return i < 0 ? d : `${d.slice(0, i).trim().toLowerCase()}: ${d.slice(i + 1).trim()}`; }).join('; ');

/**
 * Gathers identical inline style attributes in the body into generated classes. Returns the new source
 * (style attributes replaced by class names) and the CSS rules to add.
 */
export function inlineToClasses(src: string, opts: { prefix?: string; min?: number } = {}): { src: string; css: string; classes: number; replaced: number } {
  const prefix = opts.prefix || 'style';
  const min = Math.max(1, opts.min ?? 2);
  const bodyAt = /<body\b[^>]*>/i.exec(src);
  const from = bodyAt ? bodyAt.index + bodyAt[0].length : 0;
  const toks = tokenize(src).filter((t) => t.type === 'start' && t.start >= from && t.attrs.some((a) => a.name === 'style' && (a.value || '').trim()));
  const groups = new Map<string, Token[]>();
  for (const t of toks) { const k = normDecls(t.attrs.find((a) => a.name === 'style')!.value || ''); if (k) groups.set(k, [...(groups.get(k) || []), t]); }
  let n = 1;
  const taken = new Set([...src.matchAll(new RegExp(`\\.${prefix}(\\d+)\\b|class\\s*=\\s*["'][^"']*\\b${prefix}(\\d+)\\b`, 'g'))].map((m) => +(m[1] || m[2])));
  const edits: Edit[] = [];
  let css = '';
  let classes = 0, replaced = 0;
  for (const [decls, list] of groups) {
    if (list.length < min) continue;
    while (taken.has(n)) n++;
    const name = `${prefix}${n++}`;
    classes++;
    css += `.${name} { ${decls}; }\n`;
    for (const t of list) {
      const cls = t.attrs.find((a) => a.name === 'class')?.value;
      edits.push({ start: t.start, end: t.end, text: rebuildTag(src, t, { remove: ['style'], set: { class: cls ? `${cls.trim()} ${name}` : name } }) });
      replaced++;
    }
  }
  return { src: applyEdits(src, edits), css, classes, replaced };
}

// --------------------------------------------------------------------------------------------
// HTML5 and XHTML conversion

const ALIGN_TEXT = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'tr', 'caption', 'legend', 'thead', 'tbody', 'tfoot', 'col', 'colgroup']);
const LIST_TYPES: Record<string, string> = { disc: 'disc', circle: 'circle', square: 'square', '1': 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' };
const px = (v: string) => (/^\d+$/.test(v.trim()) ? `${v.trim()}px` : v.trim());

/** Converts a page to HTML5: doctype, charset, script and style types, obsolete elements and presentational attributes to CSS. */
export function toHtml5(src: string): CleanResult {
  const log: string[] = [];
  let s = src.replace(/^\s*<\?xml[^>]*\?>\s*/i, () => { log.push('XML declaration removed'); return ''; });
  if (getDoctype(s) !== 'html5') { s = setDoctype(s, 'html5'); log.push('Doctype set to <!DOCTYPE html>'); }
  s = s.replace(/<meta\s+http-equiv\s*=\s*["']?content-type["']?\s+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)["']\s*\/?>/gi, (m, cs) => { log.push('Content-Type meta replaced by <meta charset>'); return `<meta charset="${cs.toLowerCase() === 'utf-8' ? 'utf-8' : cs}">`; });
  const toks = tokenize(s);
  const edits: Edit[] = [];
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) || 0) + 1);
  const linkRules: string[] = [];
  const allIds = new Set(toks.flatMap((t) => t.attrs.filter((a) => a.name === 'id').map((a) => a.value || '')));
  const RENAME: Record<string, [string, Record<string, string>]> = { center: ['div', { 'text-align': 'center' }], big: ['span', { 'font-size': 'larger' }], tt: ['span', { 'font-family': 'monospace' }], strike: ['s', {}], acronym: ['abbr', {}], dir: ['ul', {}], nobr: ['span', { 'white-space': 'nowrap' }], blink: ['span', {}] };
  const fontStack: boolean[] = [];
  for (const t of toks) {
    if (t.type === 'end') {
      if (RENAME[t.name]) edits.push({ start: t.start, end: t.end, text: `</${RENAME[t.name][0]}>` });
      if (t.name === 'font') { const was = fontStack.pop(); edits.push({ start: t.start, end: t.end, text: was === false ? '' : '</span>' }); }
      continue;
    }
    if (t.type !== 'start') continue;
    const n = t.name;
    const get = (a: string) => { const x = t.attrs.find((y) => y.name === a); return x ? x.value ?? '' : null; };
    const css: Record<string, string> = {};
    const remove: string[] = [];
    const set: Record<string, string | null> = {};
    let name: string | undefined;
    const take = (a: string, fn: (v: string) => void) => { const v = get(a); if (v != null) { fn(v); remove.push(a); bump(`${a} attributes converted`); } };
    if (RENAME[n]) { name = RENAME[n][0]; Object.assign(css, RENAME[n][1]); bump(`<${n}> converted`); }
    if (n === 'font') {
      const c = fontAttrsToCss(get('face'), get('size'), get('color'));
      const others = t.attrs.filter((a) => !/^(face|size|color)$/.test(a.name));
      bump('<font> converted');
      if (!Object.keys(c).length && !others.length) { edits.push({ start: t.start, end: t.end, text: '' }); fontStack.push(false); continue; }
      fontStack.push(true);
      name = 'span'; Object.assign(css, c); remove.push('face', 'size', 'color');
    }
    take('align', (v) => {
      const a = v.toLowerCase();
      if (ALIGN_TEXT.has(n)) css['text-align'] = a;
      else if (/^(img|iframe|object|embed|table)$/.test(n)) {
        if (a === 'left' || a === 'right') css.float = a;
        else if (a === 'center' && n === 'table') { css['margin-left'] = 'auto'; css['margin-right'] = 'auto'; }
        else if (/^(top|middle|bottom|baseline|texttop|absmiddle|absbottom)$/.test(a)) css['vertical-align'] = a === 'absmiddle' ? 'middle' : a === 'absbottom' ? 'bottom' : a === 'texttop' ? 'text-top' : a;
      } else if (n === 'hr') { if (a === 'left') css['margin-left'] = '0'; if (a === 'right') css['margin-right'] = '0'; }
      else css['text-align'] = a;
    });
    take('valign', (v) => { css['vertical-align'] = v.toLowerCase(); });
    take('bgcolor', (v) => { css['background-color'] = /^[0-9a-f]{6}$/i.test(v) ? '#' + v : v; });
    if (n !== 'img') take('background', (v) => { css['background-image'] = `url('${v}')`; });
    if (/^(table|td|th|col|colgroup|hr|pre)$/.test(n)) take('width', (v) => { css.width = px(v); });
    if (/^(table|td|th|tr)$/.test(n)) take('height', (v) => { css.height = px(v); });
    if (/^(td|th)$/.test(n)) take('nowrap', () => { css['white-space'] = 'nowrap'; });
    if (n === 'table') take('cellspacing', (v) => { if (v.trim() === '0') css['border-collapse'] = 'collapse'; else css['border-spacing'] = px(v); });
    if (/^(img|object|embed|iframe)$/.test(n)) {
      take('hspace', (v) => { css['margin-left'] = px(v); css['margin-right'] = px(v); });
      take('vspace', (v) => { css['margin-top'] = px(v); css['margin-bottom'] = px(v); });
    }
    if (n === 'img' || n === 'object') take('border', (v) => { if (v.trim() !== '0') css.border = `${px(v)} solid`; });
    if (n === 'br') take('clear', (v) => { css.clear = /all|both/i.test(v) ? 'both' : v.toLowerCase(); });
    if (n === 'hr') {
      take('size', (v) => { css.height = px(v); });
      take('noshade', () => { css['border-style'] = 'solid'; });
      take('color', (v) => { css['background-color'] = v; css['border-color'] = v; });
    }
    if (n === 'ul' || n === 'li') take('type', (v) => { css['list-style-type'] = LIST_TYPES[v] || LIST_TYPES[v.toLowerCase()] || v; });
    if (n === 'body') {
      take('text', (v) => { css.color = v; });
      for (const [a, sel] of [['link', 'a:link'], ['vlink', 'a:visited'], ['alink', 'a:active']] as const) take(a, (v) => { linkRules.push(`${sel} { color: ${v}; }`); });
      take('marginwidth', (v) => { css['margin-left'] = px(v); css['margin-right'] = px(v); });
      take('leftmargin', (v) => { css['margin-left'] = px(v); });
      take('marginheight', (v) => { css['margin-top'] = px(v); css['margin-bottom'] = px(v); });
      take('topmargin', (v) => { css['margin-top'] = px(v); });
    }
    if (n === 'iframe') {
      take('frameborder', (v) => { if (v.trim() === '0' || /no/i.test(v)) css.border = '0'; });
      take('marginwidth', () => void 0);
      take('marginheight', () => void 0);
      take('scrolling', (v) => { if (/no/i.test(v)) css.overflow = 'hidden'; });
    }
    if (n === 'a') { const nm = get('name'); if (nm != null && get('id') == null && !allIds.has(nm)) { set.id = nm; remove.push('name'); bump('a name converted to id'); } else if (nm != null && get('id') === nm) { remove.push('name'); } }
    if (n === 'script') { const tp = get('type'); if (tp != null && /^(text|application)\/(javascript|ecmascript)$/i.test(tp.trim())) { remove.push('type'); bump('script type removed'); } if (get('language') != null) { remove.push('language'); bump('script language removed'); } }
    if ((n === 'style' || n === 'link') && /^text\/css$/i.test((get('type') || '').trim())) { remove.push('type'); bump('type="text/css" removed'); }
    if (n === 'html') { const xl = get('xml:lang'); if (xl != null && get('lang') == null) set.lang = xl; for (const a of t.attrs) if (/^xmlns:/.test(a.name)) remove.push(a.name); if (get('version') != null) remove.push('version'); }
    if (n === 'head' && get('profile') != null) remove.push('profile');
    if (n === 'table' && get('summary') != null) { /* kept: harmless, and the text has no other place without a caption */ }
    if (!name && !remove.length && !Object.keys(css).length && !Object.keys(set).length) continue;
    if (Object.keys(css).length) set.style = mergeStyle(get('style'), css, false);
    edits.push({ start: t.start, end: t.end, text: rebuildTag(s, t, { name: name, remove, set }) });
  }
  s = applyEdits(s, edits);
  if (linkRules.length) {
    const rules = linkRules.join('\n');
    if (/<\/head>/i.test(s)) s = s.replace(/<\/head>/i, `<style>\n${rules}\n</style>\n</head>`);
  }
  for (const [k, v] of counts) log.push(`${k}: ${v}`);
  if (!log.length) log.push('The page was already HTML5.');
  return { src: s, log };
}

/** Writes the end tags HTML lets authors leave out (p, li, td…), as XHTML requires. */
export function closeImpliedTags(src: string): { src: string; count: number } {
  const { root } = parseHtml(src);
  const inserts = new Map<number, { depth: number; name: string }[]>();
  let count = 0;
  const walk = (n: HNode, depth: number) => {
    for (const c of n.children) {
      if (c.type !== 'el') continue;
      walk(c, depth + 1);
      if (c.implied && !VOID.has(c.name) && !c.foreign && c.close >= 0) {
        const l = inserts.get(c.close) || [];
        l.push({ depth, name: c.name });
        inserts.set(c.close, l);
        count++;
      }
    }
  };
  walk(root, 0);
  const edits: Edit[] = [...inserts].map(([at, list]) => ({ start: at, end: at, text: list.sort((a, b) => b.depth - a.depth).map((x) => `</${x.name}>`).join('') }));
  // Insert at the end of preceding white space so the closing tag follows the content.
  for (const e of edits) { let a = e.start; while (a > 0 && /\s/.test(src[a - 1])) a--; e.start = e.end = a; }
  return { src: applyEdits(src, edits), count };
}

/** Escapes "&" that does not start a character reference (outside script and style). */
export function escapeBareAmps(src: string): { src: string; count: number } {
  let count = 0;
  const keep: string[] = [];
  const s = src.replace(/<(script|style)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
  const out = s.replace(/&(?!#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)/gi, () => { count++; return '&amp;'; });
  return { src: out.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[+i]), count };
}

/** Converts a page to XHTML syntax with the given doctype (xhtml1t, xhtml1s, xhtml11, xhtml5). */
export function toXhtmlPage(src: string, doctype = 'xhtml1t'): CleanResult {
  const log: string[] = [];
  let s = toXhtml(src);
  if (s !== src) log.push('Tags and attributes lower-cased and quoted; void tags closed');
  const c = closeImpliedTags(s);
  s = c.src;
  if (c.count) log.push(`Omitted end tags written: ${c.count}`);
  const a = escapeBareAmps(s);
  s = a.src;
  if (a.count) log.push(`"&" escaped: ${a.count}`);
  s = setDoctype(s, doctype);
  log.push(`Doctype set (${doctype})`);
  if (!/<html\b[^>]*\sxmlns\s*=/i.test(s)) s = s.replace(/<html\b/i, '<html xmlns="http://www.w3.org/1999/xhtml"');
  s = s.replace(/<html\b([^>]*)>/i, (m, at: string) => (/\slang\s*=\s*["']([^"']*)["']/.test(at) && !/xml:lang/.test(at) && doctype !== 'xhtml5' ? `<html${at.replace(/\slang\s*=\s*["']([^"']*)["']/, (x, l) => ` lang="${l}" xml:lang="${l}"`)}>` : m));
  return { src: s, log };
}

// --------------------------------------------------------------------------------------------
// Encoding repair (mojibake: UTF-8 bytes read as Windows-1252, "Ã©" for "é")

const CP1252: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
const byteOf = (ch: string): number => { const c = ch.charCodeAt(0); if (c >= 0x80 && c <= 0xff) return c; return CP1252[c] ?? -1; };

function repairOnce(s: string): { s: string; count: number } {
  let count = 0;
  const out = s.replace(/[\u0080-ÿŒœŠšŸŽžƒˆ˜–—‘-‚“-„†-•…‰‹›€™]{2,}/g, (run) => {
    const chars = [...run];
    let res = '';
    let i = 0;
    while (i < chars.length) {
      const b0 = byteOf(chars[i]);
      const need = b0 >= 0xc2 && b0 <= 0xdf ? 1 : b0 >= 0xe0 && b0 <= 0xef ? 2 : b0 >= 0xf0 && b0 <= 0xf4 ? 3 : 0;
      if (need && i + need < chars.length + 0) {
        const bytes = [b0];
        let ok = true;
        for (let k = 1; k <= need; k++) { const b = chars[i + k] ? byteOf(chars[i + k]) : -1; if (b < 0x80 || b > 0xbf) { ok = false; break; } bytes.push(b); }
        if (ok) {
          try {
            res += new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
            i += need + 1;
            count++;
            continue;
          } catch { /* not UTF-8 */ }
        }
      }
      res += chars[i];
      i++;
    }
    return res;
  });
  return { s: out, count };
}

/** Repairs text that was decoded with the wrong character set (once or twice). */
export function fixMojibake(src: string): { src: string; count: number } {
  let s = src, count = 0;
  for (let k = 0; k < 2; k++) { const r = repairOnce(s); if (!r.count) break; s = r.s; count += r.count; }
  return { src: s, count };
}

// --------------------------------------------------------------------------------------------
// Minification

/** Removes comments (except /*! … *\/ notices) and unneeded white space from CSS. */
export function minifyCss(css: string): string {
  let out = '';
  let i = 0;
  const n = css.length;
  const strings: string[] = [];
  while (i < n) {
    const c = css[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < n && css[j] !== c) { if (css[j] === '\\') j++; j++; } strings.push(css.slice(i, j + 1)); out += `\u0001${strings.length - 1}\u0001`; i = j + 1; continue; }
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; if (css[i + 2] === '!') out += css.slice(i, end); i = end; continue; }
    if (/\s/.test(c)) { while (i < n && /\s/.test(css[i])) i++; out += ' '; continue; }
    out += c;
    i++;
  }
  return out
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/([{;][-\w]+)\s*:\s*(?=[^{};]*[;}])/g, '$1:')
    .replace(/;}/g, '}')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\u0001(\d+)\u0001/g, (m, k) => strings[+k]);
}

/**
 * Light JavaScript minification: removes comments and indentation and blank lines. Line breaks are kept,
 * so automatic semicolon insertion works as before. Strings, template literals and regular expressions are left alone.
 */
export function minifyJs(js: string): string {
  let out = '';
  let i = 0;
  const n = js.length;
  let lastSig = '';
  while (i < n) {
    const c = js[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && js[j] !== c) { if (js[j] === '\\') j++; j++; }
      out += js.slice(i, j + 1); i = j + 1; lastSig = c; continue;
    }
    if (c === '/' && js[i + 1] === '/') { while (i < n && js[i] !== '\n') i++; continue; }
    if (c === '/' && js[i + 1] === '*') { const e = js.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; if (js[i + 2] === '!') out += js.slice(i, end); i = end; continue; }
    if (c === '/' && (!lastSig || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(out.slice(-12).trimEnd()))) {
      let j = i + 1, cls = false;
      while (j < n && js[j] !== '\n') { if (js[j] === '\\') { j += 2; continue; } if (js[j] === '[') cls = true; else if (js[j] === ']') cls = false; else if (js[j] === '/' && !cls) break; j++; }
      j++;
      while (j < n && /[a-z]/i.test(js[j])) j++;
      out += js.slice(i, j); i = j; lastSig = '/'; continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Minifies a page: markup white space and comments, CSS in style blocks, and JavaScript in script blocks. */
export function minifyPage(src: string): string {
  let s = src.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, b) => a + minifyCss(css) + b);
  s = s.replace(/(<script\b([^>]*)>)([\s\S]*?)(<\/script>)/gi, (m, a, attrs: string, js, b) => (/\bsrc\s*=/.test(attrs) || (/type\s*=/.test(attrs) && !/javascript|module|ecmascript/i.test(attrs)) ? m : a + minifyJs(js) + b));
  s = s.replace(/(\sstyle\s*=\s*")([^"]*)(")/gi, (m, a, css, b) => a + minifyCss(css).replace(/^\{|\}$/g, '') + b);
  return minifyHtml(s);
}

// --------------------------------------------------------------------------------------------
// Line comparison (shortest edit script, Myers' algorithm)

export interface DiffOp { op: 'equal' | 'delete' | 'insert'; text: string; a?: number; b?: number }

/** Line differences between two texts. `a`/`b` are 1-based line numbers in each text. */
export function diffLines(aText: string, bText: string, opts: { ignoreWhitespace?: boolean; ignoreCase?: boolean } = {}): DiffOp[] {
  const A = aText.split(/\r?\n/), B = bText.split(/\r?\n/);
  if (A[A.length - 1] === '' && B[B.length - 1] === '') { A.pop(); B.pop(); }
  const key = (l: string) => { let k = opts.ignoreWhitespace ? l.replace(/\s+/g, ' ').trim() : l; if (opts.ignoreCase) k = k.toLowerCase(); return k; };
  const ids = new Map<string, number>();
  const id = (l: string) => { const k = key(l); let v = ids.get(k); if (v === undefined) { v = ids.size; ids.set(k, v); } return v; };
  const a = A.map(id), b = B.map(id);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: DiffOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ op: 'equal', text: A[i], a: i + 1, b: i + 1 });
  const ma = a.slice(pre, a.length - suf), mb = b.slice(pre, b.length - suf);
  const script = myers(ma, mb);
  let x = 0, y = 0;
  for (const s of script) {
    if (s === '=') { ops.push({ op: 'equal', text: A[pre + x], a: pre + x + 1, b: pre + y + 1 }); x++; y++; }
    else if (s === '-') { ops.push({ op: 'delete', text: A[pre + x], a: pre + x + 1 }); x++; }
    else { ops.push({ op: 'insert', text: B[pre + y], b: pre + y + 1 }); y++; }
  }
  for (let i = 0; i < suf; i++) ops.push({ op: 'equal', text: A[a.length - suf + i], a: a.length - suf + i + 1, b: b.length - suf + i + 1 });
  return ops;
}

function myers(a: number[], b: number[], limit = 3000): ('=' | '-' | '+')[] {
  const N = a.length, M = b.length;
  if (!N) return Array(M).fill('+');
  if (!M) return Array(N).fill('-');
  const maxD = Math.min(N + M, limit);
  const off = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { trace.push(v.slice(off - d, off + d + 1)); found = d; break outer; }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return [...Array(N).fill('-'), ...Array(M).fill('+')];
  const out: ('=' | '-' | '+')[] = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const vp = trace[d - 1];
    const get = (k: number) => vp[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push('='); x--; y--; }
    if (prevK === k + 1) { out.push('+'); y--; } else { out.push('-'); x--; }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { out.push('='); x--; y--; }
  return out.reverse();
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number; same: number } {
  let added = 0, removed = 0, same = 0;
  for (const o of ops) { if (o.op === 'insert') added++; else if (o.op === 'delete') removed++; else same++; }
  return { added, removed, same };
}
