/**
 * Source-level CSS: a tolerant parser that keeps every node's character offsets, so commands can change one
 * declaration or one rule and leave the rest of the style sheet exactly as written (comments, spacing, order).
 *
 * The parser never throws. Problems it can recover from (an unclosed block, a declaration without a colon,
 * a stray brace) are collected in `sheet.errors` for the CSS reports.
 *
 * Grouping at-rules (@media, @supports, @layer, @container, @scope, @document, @starting-style) hold child
 * rules. @keyframes keep their frames as children, but frames are not style rules and are left out of
 * `sheet.rules`. Descriptor blocks (@font-face, @page, @property, @counter-style, @view-transition…) keep
 * their declarations. CSS nesting is understood: a nested rule gets its resolved selector.
 */
import { resolveRef, relativeRef } from './paths';

export interface CssDecl {
  type: 'decl';
  prop: string;
  /** Value without comments and without "!important". */
  value: string;
  important: boolean;
  /** Start of the property name. */
  start: number;
  /** After the semicolon when there is one, else after the value. */
  end: number;
  /** End of the declaration text before the semicolon (and before trailing spaces). */
  textEnd: number;
  valueStart: number;
  /** End of the value without "!important". */
  valueEnd: number;
  semi: boolean;
}

export interface CssComment { type: 'comment'; text: string; start: number; end: number }

export interface CssRule {
  type: 'rule';
  /** The selector with nesting resolved, whitespace as written. */
  selector: string;
  /** The selector as written. */
  raw: string;
  /** Enclosing grouping at-rules, outermost first ("@media (max-width: 600px)"). */
  media: string[];
  decls: CssDecl[];
  /** Declarations, comments and nested nodes in source order. */
  items: (CssDecl | CssNode)[];
  start: number;
  end: number;
  selStart: number;
  selEnd: number;
  /** After "{". */
  bodyStart: number;
  /** At "}" (or the end of the text when the block is not closed). */
  bodyEnd: number;
  /** Position in sheet.rules. */
  index: number;
  /** Written inside another rule (CSS nesting). */
  nested?: boolean;
  /** A grouping at-rule written inside a rule ("a { @media … { color: red } }"): it has no selector of its own. */
  synthetic?: boolean;
}

export interface CssAtRule {
  type: 'at';
  name: string;
  prelude: string;
  start: number;
  end: number;
  /** -1 for statements (@import …;). */
  bodyStart: number;
  bodyEnd: number;
  preludeStart: number;
  preludeEnd: number;
  children?: CssNode[];
  decls?: CssDecl[];
  /** For a grouping at-rule written inside a rule: the rule that holds its declarations. */
  inner?: CssRule;
}

export type CssNode = CssRule | CssAtRule | CssComment;

export interface CssError { message: string; offset: number; line: number }

export interface CssSheet {
  text: string;
  nodes: CssNode[];
  /** Every style rule in source order, including rules inside @media and nested rules (not keyframes). */
  rules: CssRule[];
  /** Every at-rule, in source order. */
  atRules: CssAtRule[];
  errors: CssError[];
}

export const GROUPING = new Set(['media', 'supports', 'layer', 'container', 'document', '-moz-document', 'scope', 'starting-style']);
const DESCRIPTORS = new Set(['font-face', 'page', 'property', 'counter-style', 'view-transition', 'font-palette-values', 'font-feature-values', 'viewport', '-ms-viewport', 'position-try']);

export function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// ------------------------------------------------------------------------------------------
// Scanning

function skipString(t: string, i: number): number {
  const q = t[i];
  i++;
  while (i < t.length) {
    const c = t[i];
    if (c === '\\') { i += 2; continue; }
    if (c === q) return i + 1;
    if (c === '\n') return i;
    i++;
  }
  return i;
}

function skipComment(t: string, i: number): number {
  const e = t.indexOf('*/', i + 2);
  return e < 0 ? t.length : e + 2;
}

/** Index of the "}" matching the "{" at `i`, or -1. */
function matchBrace(t: string, i: number, end: number): number {
  let depth = 0;
  for (let j = i; j < end; j++) {
    const c = t[j];
    if (c === '"' || c === "'") { j = skipString(t, j) - 1; continue; }
    if (c === '/' && t[j + 1] === '*') { j = skipComment(t, j) - 1; continue; }
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** Scans from `i` to the first of `stops` outside strings, comments and brackets. */
function scanTo(t: string, i: number, end: number, stops: string): number {
  let depth = 0;
  for (let j = i; j < end; j++) {
    const c = t[j];
    if (c === '"' || c === "'") { j = skipString(t, j) - 1; continue; }
    if (c === '/' && t[j + 1] === '*') { j = skipComment(t, j) - 1; continue; }
    if (c === '\\') { j++; continue; }
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (depth === 0 && stops.includes(c)) return j;
  }
  return end;
}

export function stripComments(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { const e = skipString(s, i); out += s.slice(i, e); i = e - 1; continue; }
    if (c === '/' && s[i + 1] === '*') { i = skipComment(s, i) - 1; continue; }
    out += c;
  }
  return out;
}

const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// ------------------------------------------------------------------------------------------
// Parser

export function parseCss(text: string): CssSheet {
  const sheet: CssSheet = { text, nodes: [], rules: [], atRules: [], errors: [] };
  const err = (message: string, offset: number) => sheet.errors.push({ message, offset, line: lineOf(text, offset) });
  sheet.nodes = parseBlock(text, 0, text.length, [], false, sheet, err);
  return sheet;
}

type Err = (m: string, o: number) => void;

function parseBlock(t: string, a: number, b: number, media: string[], inFrames: boolean, sheet: CssSheet, err: Err): CssNode[] {
  const nodes: CssNode[] = [];
  let i = a;
  while (i < b) {
    const c = t[i];
    if (isWs(c)) { i++; continue; }
    if (c === '/' && t[i + 1] === '*') { const e = Math.min(skipComment(t, i), b); nodes.push({ type: 'comment', text: t.slice(i, e), start: i, end: e }); i = e; continue; }
    if (t.startsWith('<!--', i)) { i += 4; continue; }
    if (t.startsWith('-->', i)) { i += 3; continue; }
    if (c === '}') { err('Unexpected "}"', i); i++; continue; }
    if (c === ';') { i++; continue; }
    if (c === '@') {
      const at = parseAt(t, i, b, media, inFrames, sheet, err);
      nodes.push(at);
      i = at.end;
      continue;
    }
    // A qualified rule.
    const j = scanTo(t, i, b, '{;}');
    if (j >= b || t[j] !== '{') {
      err(t[j] === ';' ? 'Unexpected ";" before a rule block' : 'Expected "{" after the selector', i);
      i = j < b ? j + 1 : b;
      continue;
    }
    const raw = t.slice(i, j).trim();
    if (!raw) err('A rule has no selector', i);
    let close = matchBrace(t, j, b);
    if (close < 0) { err(`The block for "${raw.slice(0, 40)}" is not closed`, j); close = b; }
    const rule = newRule(raw, raw, media, i, i + rawLen(t, i, j), j + 1, close, Math.min(close + 1, b));
    if (!inFrames) pushRule(sheet, rule);
    parseBody(t, j + 1, close, rule, sheet, err, inFrames);
    nodes.push(rule);
    i = rule.end;
  }
  return nodes;
}

const rawLen = (t: string, i: number, j: number) => t.slice(i, j).replace(/\s+$/, '').length;

function newRule(selector: string, raw: string, media: string[], start: number, selEnd: number, bodyStart: number, bodyEnd: number, end: number): CssRule {
  return { type: 'rule', selector, raw, media, decls: [], items: [], start, end, selStart: start, selEnd, bodyStart, bodyEnd, index: -1 };
}

function pushRule(sheet: CssSheet, r: CssRule): void { r.index = sheet.rules.length; sheet.rules.push(r); }

function parseAt(t: string, i: number, b: number, media: string[], inFrames: boolean, sheet: CssSheet, err: Err): CssAtRule {
  const m = /^@(-?[\w-]+)/.exec(t.slice(i, Math.min(b, i + 80)));
  const name = (m?.[1] || '').toLowerCase();
  const ps = i + (m ? m[0].length : 1);
  const j = scanTo(t, ps, b, '{;}');
  const prelude = t.slice(ps, j).trim();
  const preludeStart = ps + (t.slice(ps, j).length - t.slice(ps, j).replace(/^\s+/, '').length);
  const at: CssAtRule = { type: 'at', name, prelude, start: i, end: j, bodyStart: -1, bodyEnd: -1, preludeStart, preludeEnd: preludeStart + prelude.length };
  sheet.atRules.push(at);
  if (j >= b || t[j] !== '{') {
    // A statement: @import, @charset, @namespace, @layer a, b;
    at.end = j < b && t[j] === ';' ? j + 1 : j;
    if (t[j] === '}') err(`"@${name}" is missing a semicolon`, i);
    return at;
  }
  let close = matchBrace(t, j, b);
  if (close < 0) { err(`The "@${name}" block is not closed`, j); close = b; }
  at.bodyStart = j + 1;
  at.bodyEnd = close;
  at.end = Math.min(close + 1, b);
  if (GROUPING.has(name)) at.children = parseBlock(t, j + 1, close, [...media, `@${name}${prelude ? ' ' + prelude : ''}`], inFrames, sheet, err);
  else if (/keyframes$/.test(name)) at.children = parseBlock(t, j + 1, close, media, true, sheet, err);
  else if (DESCRIPTORS.has(name)) {
    const holder = newRule('@' + name, '@' + name, media, i, i, j + 1, close, at.end);
    parseBody(t, j + 1, close, holder, sheet, err, true);
    at.decls = holder.decls;
  }
  return at;
}

/** Declarations, nested rules and nested at-rules of a block. */
function parseBody(t: string, a: number, b: number, rule: CssRule, sheet: CssSheet, err: Err, inFrames: boolean): void {
  let i = a;
  while (i < b) {
    const c = t[i];
    if (isWs(c) || c === ';') { i++; continue; }
    if (c === '/' && t[i + 1] === '*') { const e = Math.min(skipComment(t, i), b); rule.items.push({ type: 'comment', text: t.slice(i, e), start: i, end: e }); i = e; continue; }
    const j = scanTo(t, i, b, ';{}');
    if (j < b && t[j] === '{') {
      const raw = t.slice(i, j).trim();
      let close = matchBrace(t, j, b);
      if (close < 0) { err(`The block for "${raw.slice(0, 40)}" is not closed`, j); close = b; }
      const end = Math.min(close + 1, b);
      if (raw.startsWith('@')) {
        const name = (/^@(-?[\w-]+)/.exec(raw)?.[1] || '').toLowerCase();
        const prelude = raw.slice(name.length + 1).trim();
        const ps = i + name.length + 1;
        const at: CssAtRule = { type: 'at', name, prelude, start: i, end, bodyStart: j + 1, bodyEnd: close, preludeStart: ps + (t.slice(ps, j).length - t.slice(ps, j).trimStart().length), preludeEnd: 0 };
        at.preludeEnd = at.preludeStart + prelude.length;
        sheet.atRules.push(at);
        if (GROUPING.has(name)) {
          const inner = newRule(rule.selector, '', [...rule.media, `@${name}${prelude ? ' ' + prelude : ''}`], i, i, j + 1, close, end);
          inner.nested = true;
          inner.synthetic = true;
          if (!inFrames) pushRule(sheet, inner);
          parseBody(t, j + 1, close, inner, sheet, err, inFrames);
          at.inner = inner;
        }
        rule.items.push(at);
      } else {
        const sel = resolveNested(rule.selector, raw);
        const child = newRule(sel, raw, rule.media, i, i + rawLen(t, i, j), j + 1, close, end);
        child.nested = true;
        if (!inFrames) pushRule(sheet, child);
        parseBody(t, j + 1, close, child, sheet, err, inFrames);
        rule.items.push(child);
      }
      i = end;
      continue;
    }
    if (j < b && t[j] === '}') { err('Unexpected "}" in a declaration block', j); }
    const d = parseDecl(t, i, j, err);
    if (d) { rule.decls.push(d); rule.items.push(d); }
    i = j < b && t[j] === ';' ? j + 1 : j + (j < b ? 1 : 0);
  }
}

function parseDecl(t: string, s: number, e: number, err: Err): CssDecl | null {
  const seg = t.slice(s, e);
  if (!stripComments(seg).trim()) return null;
  const colon = scanTo(t, s, e, ':');
  if (colon >= e) { err(`Expected ":" in "${seg.trim().slice(0, 40)}"`, s); return null; }
  const prop = stripComments(t.slice(s, colon)).trim();
  if (!/^(--[\w-]*|-?[a-zA-Z_][\w-]*|\*[a-zA-Z_][\w-]*)$/.test(prop)) err(`"${prop.slice(0, 40)}" is not a property name`, s);
  let vs = colon + 1;
  while (vs < e && isWs(t[vs])) vs++;
  let te = e;
  while (te > vs && isWs(t[te - 1])) te--;
  let ve = te;
  let important = false;
  const im = /!\s*important\s*$/i.exec(t.slice(vs, te));
  if (im) { important = true; ve = vs + im.index; while (ve > vs && isWs(t[ve - 1])) ve--; }
  const value = stripComments(t.slice(vs, ve)).trim();
  if (!value && !prop.startsWith('--')) err(`"${prop}" has no value`, s);
  const semi = t[e] === ';';
  return { type: 'decl', prop: prop.startsWith('--') ? prop : prop.toLowerCase(), value, important, start: s, end: semi ? e + 1 : te, textEnd: te, valueStart: vs, valueEnd: ve, semi };
}

function resolveNested(parent: string, child: string): string {
  const p = splitSelectors(parent).length > 1 ? `:is(${parent})` : parent;
  return splitSelectors(child).map((part) => (part.includes('&') ? part.replace(/&/g, p) : `${p} ${part}`)).join(', ');
}

// ------------------------------------------------------------------------------------------
// Selectors

/** Splits a selector list at its top-level commas. */
export function splitSelectors(sel: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '"' || c === "'") { const e = skipString(sel, i); cur += sel.slice(i, e); i = e - 1; continue; }
    if (c === '\\') { cur += sel.slice(i, i + 2); i++; continue; }
    if (c === '(' || c === '[') depth++;
    if ((c === ')' || c === ']') && depth > 0) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Normalizes whitespace so that equivalent selectors compare equal ("a>b ,c" = "a > b, c"). */
export function normSelector(sel: string): string {
  return protect(stripComments(sel), (s) => s.replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, ' $1 ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ', ').trim());
}

/** Runs `fn` on text with string literals replaced by placeholders. */
function protect(s: string, fn: (s: string) => string): string {
  const keep: string[] = [];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { const e = skipString(s, i); keep.push(s.slice(i, e)); out += `\u0001${keep.length - 1}\u0001`; i = e - 1; continue; }
    out += c;
  }
  return fn(out).replace(/\u0001(\d+)\u0001/g, (m, n) => keep[+n]);
}

export type Specificity = [number, number, number];

const PSEUDO_ELEMENTS_LEGACY = new Set(['before', 'after', 'first-line', 'first-letter']);

/** Specificity of a selector (the highest of a list), as [ids, classes/attributes/pseudo-classes, types]. */
export function specificity(selector: string): Specificity {
  const parts = splitSelectors(selector);
  let best: Specificity = [0, 0, 0];
  for (const p of parts) { const s = specOne(p); if (compareSpecificity(s, best) > 0) best = s; }
  return best;
}

function specOne(sel: string): Specificity {
  const s: Specificity = [0, 0, 0];
  let i = 0;
  sel = sel.trim();
  while (i < sel.length) {
    const c = sel[i];
    if (c === '"' || c === "'") { i = skipString(sel, i); continue; }
    if (c === '\\') { i += 2; continue; }
    if (c === '#') { s[0]++; i++; while (i < sel.length && /[\w\-\\ -￿]/.test(sel[i])) i++; continue; }
    if (c === '.') { s[1]++; i++; while (i < sel.length && /[\w\-\\ -￿]/.test(sel[i])) i++; continue; }
    if (c === '[') { s[1]++; i = scanTo(sel, i + 1, sel.length, ']') + 1; continue; }
    if (c === ':') {
      const el = sel[i + 1] === ':';
      i += el ? 2 : 1;
      const m = /^[\w-]+/.exec(sel.slice(i));
      const name = (m?.[0] || '').toLowerCase();
      i += name.length;
      let arg: string | null = null;
      if (sel[i] === '(') { const e = scanTo(sel, i + 1, sel.length, ')'); arg = sel.slice(i + 1, e); i = e + 1; }
      if (el || PSEUDO_ELEMENTS_LEGACY.has(name)) { s[2]++; continue; }
      if (name === 'where') continue;
      if (name === 'is' || name === 'not' || name === 'has' || name === 'matches' || name === '-webkit-any' || name === '-moz-any') {
        if (arg != null) { const a = specificity(arg); s[0] += a[0]; s[1] += a[1]; s[2] += a[2]; }
        continue;
      }
      if ((name === 'nth-child' || name === 'nth-last-child') && arg && /\bof\b/i.test(arg)) {
        const a = specificity(arg.slice(arg.search(/\bof\b/i) + 2));
        s[0] += a[0]; s[1] += a[1] + 1; s[2] += a[2];
        continue;
      }
      s[1]++;
      continue;
    }
    if (/[a-zA-Z_ -￿-]/.test(c) && (i === 0 || /[\s>+~(,|]/.test(sel[i - 1]) || sel[i - 1] === '|')) {
      const m = /^[\w-]+(\|[\w-]+)?/.exec(sel.slice(i));
      const n = m ? m[0] : c;
      if (sel[i + n.length] !== '|') s[2]++;
      i += n.length;
      continue;
    }
    i++;
  }
  return s;
}

export function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Dynamic pseudo-classes and pseudo-elements, removed before testing a selector against a static page. */
const DYNAMIC = /::?(?:hover|focus|focus-within|focus-visible|active|visited|link|any-link|target|target-within|checked|default|indeterminate|placeholder-shown|autofill|-webkit-autofill|user-invalid|user-valid|invalid|valid|in-range|out-of-range|required|optional|read-only|read-write|enabled|disabled|playing|paused|current|past|future|local-link|popover-open|open|closed|modal|fullscreen|picture-in-picture|before|after|first-line|first-letter|marker|placeholder|selection|backdrop|file-selector-button|cue|part|slotted|highlight|spelling-error|grammar-error|target-text|view-transition[\w-]*|-webkit-[\w-]+|-moz-[\w-]+|-ms-[\w-]+)(?:\((?:[^()]|\([^()]*\))*\))?/gi;

/** The selector with states and pseudo-elements removed, testable with Element.matches(). */
export function staticSelector(sel: string): string {
  let s = protect(sel, (x) => x.replace(DYNAMIC, ''));
  s = s.replace(/:(?:not|is|where|has)\(\s*\)/g, '');
  s = s.trim().replace(/([>+~])\s*$/, '$1 *');
  return s || '*';
}

/** True when the rule (or selector) applies to the element, ignoring states such as :hover. */
export function matches(rule: CssRule | string, el: Element): boolean {
  const sel = typeof rule === 'string' ? rule : rule.selector;
  for (const part of splitSelectors(sel)) {
    const s = staticSelector(part);
    try { if (el.matches(s)) return true; } catch { /* a selector the browser does not know */ }
  }
  return false;
}

// ------------------------------------------------------------------------------------------
// Queries

export function normMedia(m: string): string {
  let s = m.trim();
  if (!s.startsWith('@')) s = '@media ' + s;
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/\s*:\s*/g, ':').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
}

const sameMedia = (r: CssRule, media?: string | string[]) => {
  const want = media == null ? [] : (Array.isArray(media) ? media : [media]).filter(Boolean).map(normMedia);
  return r.media.length === want.length && r.media.every((m, i) => normMedia(m) === want[i]);
};

const asSheet = (css: string | CssSheet) => (typeof css === 'string' ? parseCss(css) : css);

/** Rules whose selector equals `selector` (whitespace-insensitive). Without `media`, rules in any context. */
export function findRules(css: string | CssSheet, selector: string, media?: string | string[] | null): CssRule[] {
  const sheet = asSheet(css);
  const n = normSelector(selector);
  return sheet.rules.filter((r) => !r.synthetic && normSelector(r.selector) === n && (media === undefined || sameMedia(r, media ?? undefined)));
}

/** Unique selectors of every style rule, in source order. */
export function listSelectors(css: string | CssSheet): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of asSheet(css).rules) {
    if (r.synthetic) continue;
    const n = normSelector(r.selector);
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/** Class names used in selectors. */
export function classesIn(css: string | CssSheet): string[] {
  const set = new Set<string>();
  for (const r of asSheet(css).rules) protect(r.selector, (s) => { s.replace(/\[[^\]]*\]/g, '').replace(/\.(-?[_a-zA-Z -￿][\w-]*)/g, (m, c) => { set.add(c); return m; }); return s; });
  return [...set];
}

/** Ids used in selectors. */
export function idsIn(css: string | CssSheet): string[] {
  const set = new Set<string>();
  for (const r of asSheet(css).rules) protect(r.selector, (s) => { s.replace(/\[[^\]]*\]/g, '').replace(/#(-?[_a-zA-Z -￿][\w-]*)/g, (m, c) => { set.add(c); return m; }); return s; });
  return [...set];
}

/** @import targets, in order. */
export function importsOf(css: string | CssSheet): { href: string; media: string; start: number; end: number }[] {
  const out: { href: string; media: string; start: number; end: number }[] = [];
  for (const a of asSheet(css).atRules) {
    if (a.name !== 'import') continue;
    const m = /^(?:url\(\s*(["']?)([^"')]*)\1\s*\)|(["'])([^"']*)\3)\s*(.*)$/i.exec(a.prelude);
    if (m) out.push({ href: m[2] ?? m[4] ?? '', media: (m[5] || '').trim(), start: a.start, end: a.end });
  }
  return out;
}

/** Font family names declared by @font-face. */
export function fontFaces(css: string | CssSheet): string[] {
  const out = new Set<string>();
  for (const a of asSheet(css).atRules) if (a.name === 'font-face') { const f = a.decls?.find((d) => d.prop === 'font-family'); if (f) out.add(f.value.replace(/^["']|["']$/g, '')); }
  return [...out];
}

/** Grouping at-rule headers ("@media (max-width: 600px)") in source order, unique. */
export function listMedia(css: string | CssSheet): string[] {
  const out: string[] = [];
  for (const a of asSheet(css).atRules) if (a.name === 'media' || a.name === 'supports' || a.name === 'container') { const s = `@${a.name} ${a.prelude}`; if (!out.includes(s)) out.push(s); }
  return out;
}

/** Declarations of a rule as an object (later declarations win, !important ones win over others). */
export function declMap(rule: { decls: CssDecl[] }): Record<string, string> {
  const out: Record<string, string> = {};
  const imp = new Set<string>();
  for (const d of rule.decls) {
    if (imp.has(d.prop) && !d.important) continue;
    out[d.prop] = d.value + (d.important ? ' !important' : '');
    if (d.important) imp.add(d.prop);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Inline style attributes

/** Parses a style attribute ("color: red; margin: 0") to declarations. */
export function parseDeclarations(style: string): CssDecl[] {
  const holder = newRule('', '', [], 0, 0, 0, style.length, style.length);
  const sheet: CssSheet = { text: style, nodes: [], rules: [], atRules: [], errors: [] };
  parseBody(style, 0, style.length, holder, sheet, () => undefined, true);
  return holder.decls;
}

export function styleToObject(style: string): Record<string, string> { return declMap({ decls: parseDeclarations(style) }); }

export function objectToStyle(o: Record<string, string | null | undefined>): string {
  return Object.entries(o).filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => `${k}: ${String(v).trim()}`).join('; ');
}

/** Sets or (with null) removes properties in a style attribute value, keeping the others as written. */
export function setStyleDecls(style: string, props: Record<string, string | null | undefined>): string {
  let s = style;
  for (const [p, v] of Object.entries(props)) {
    const decls = parseDeclarations(s);
    const ex = decls.filter((d) => d.prop === p.toLowerCase() || d.prop === p);
    if (v == null || v === '') {
      for (const d of [...ex].reverse()) s = cut(s, d.start, d.end);
      continue;
    }
    const { value, important } = splitImportant(v);
    const text = value + (important ? ' !important' : '');
    if (ex.length) { const d = ex[ex.length - 1]; s = s.slice(0, d.valueStart) + text + s.slice(d.textEnd); continue; }
    const t = s.replace(/\s+$/, '');
    s = (t ? (t.endsWith(';') ? t + ' ' : t + '; ') : '') + `${p}: ${text}`;
  }
  return s.trim().replace(/;\s*$/, '');
}

// ------------------------------------------------------------------------------------------
// Editing with minimal changes

export function splitImportant(v: string): { value: string; important: boolean } {
  const m = /\s*!\s*important\s*$/i.exec(v);
  return m ? { value: v.slice(0, m.index).trim(), important: true } : { value: v.trim(), important: false };
}

function lineIndent(t: string, pos: number): string {
  const ls = t.lastIndexOf('\n', pos - 1) + 1;
  const pre = t.slice(ls, pos);
  return /^[ \t]*$/.test(pre) ? pre : (/^[ \t]*/.exec(pre)?.[0] ?? '');
}

/** Removes [s, e) and, when that leaves an empty line, the line. */
function cut(t: string, s: number, e: number): string {
  let a = s, b = e;
  while (a > 0 && (t[a - 1] === ' ' || t[a - 1] === '\t')) a--;
  while (b < t.length && (t[b] === ' ' || t[b] === '\t')) b++;
  if ((a === 0 || t[a - 1] === '\n') && (t[b] === '\n' || t[b] === '\r' || b === t.length)) {
    if (t[b] === '\r') b++;
    if (t[b] === '\n') b++;
    return t.slice(0, a) + t.slice(b);
  }
  return t.slice(0, s) + t.slice(e).replace(/^[ \t]+/, a < s ? '' : ' ').replace(/^ (?=[;}])/, '');
}

/** Sets (or with null/'' removes) one property in a specific rule. */
export function setDeclarationInRule(css: string, rule: CssRule, prop: string, value: string | null | undefined): string {
  const p = prop.startsWith('--') ? prop : prop.toLowerCase();
  const ex = rule.decls.filter((d) => d.prop === p);
  if (value == null || String(value).trim() === '') {
    let out = css;
    for (const d of [...ex].reverse()) out = cut(out, d.start, d.end);
    return out;
  }
  const { value: v, important } = splitImportant(String(value));
  const text = v + (important ? ' !important' : '');
  if (ex.length) {
    const d = ex[ex.length - 1];
    return css.slice(0, d.valueStart) + text + css.slice(d.textEnd);
  }
  const decl = `${p}: ${text};`;
  const body = css.slice(rule.bodyStart, rule.bodyEnd);
  if (rule.decls.length) {
    const last = rule.decls[rule.decls.length - 1];
    const fix = last.semi ? '' : ';';
    // Insert after the last declaration, before any nested rule that follows it.
    const at = last.end;
    if (body.includes('\n')) {
      const ind = lineIndent(css, last.start) || lineIndent(css, rule.start) + '  ';
      return css.slice(0, last.textEnd) + fix + css.slice(last.textEnd, at) + `\n${ind}${decl}` + css.slice(at);
    }
    return css.slice(0, last.textEnd) + fix + css.slice(last.textEnd, at) + ` ${decl}` + css.slice(at);
  }
  const ri = lineIndent(css, rule.start);
  const hasChildren = rule.items.some((x) => x.type !== 'decl');
  if (hasChildren) {
    return css.slice(0, rule.bodyStart) + `\n${ri}  ${decl}` + css.slice(rule.bodyStart);
  }
  if (!body.includes('\n') && body.trim() === '' && rule.synthetic) return css.slice(0, rule.bodyStart) + ` ${decl} ` + css.slice(rule.bodyEnd);
  return css.slice(0, rule.bodyStart) + `\n${ri}  ${decl}\n${ri}` + css.slice(rule.bodyEnd);
}

/**
 * Sets one property of the rule for `selector` (the last such rule in the given media context), creating the
 * rule when there is none. A null or empty value removes the property.
 */
export function setDeclaration(css: string, selector: string, prop: string, value: string | null | undefined, media?: string | null): string {
  const rules = findRules(css, selector, media ?? null);
  const rule = rules[rules.length - 1];
  if (!rule) {
    if (value == null || String(value).trim() === '') return css;
    return addRule(css, selector, { [prop]: String(value) }, media);
  }
  return setDeclarationInRule(css, rule, prop, value);
}

/** Sets several properties of one rule (creating it when missing). */
export function setDeclarations(css: string, selector: string, props: Record<string, string | null | undefined>, media?: string | null): string {
  const entries = Object.entries(props);
  if (!findRules(css, selector, media ?? null).length) {
    const set = Object.fromEntries(entries.filter(([, v]) => v != null && String(v).trim() !== '')) as Record<string, string>;
    return Object.keys(set).length ? addRule(css, selector, set, media) : css;
  }
  let out = css;
  for (const [p, v] of entries) out = setDeclaration(out, selector, p, v, media);
  return out;
}

/** Replaces all declarations of a rule with `declText` ("color: red; margin: 0" or one per line). */
export function replaceRuleBody(css: string, rule: CssRule, declText: string): string {
  const decls = parseDeclarations(declText);
  const ri = lineIndent(css, rule.start);
  const nestedText = rule.items.filter((x) => x.type !== 'decl' && x.type !== 'comment').map((x) => css.slice(x.start, x.end));
  const lines = decls.map((d) => `${ri}  ${d.prop}: ${d.value}${d.important ? ' !important' : ''};`);
  for (const n of nestedText) lines.push(`${ri}  ${n.trim()}`);
  return css.slice(0, rule.bodyStart) + (lines.length ? `\n${lines.join('\n')}\n${ri}` : '') + css.slice(rule.bodyEnd);
}

function ruleBlock(selector: string, props: Record<string, string> | [string, string][], indent: string): string {
  const list = Array.isArray(props) ? props : Object.entries(props);
  const lines = list.map(([k, v]) => { const s = splitImportant(v); return `${indent}  ${k}: ${s.value}${s.important ? ' !important' : ''};`; });
  return `${indent}${selector} {\n${lines.join('\n')}${lines.length ? '\n' : ''}${indent}}`;
}

/** Inserts `block` (already indented) before the trailing whitespace of [a, b) in `css`. */
function appendIn(css: string, a: number, b: number, block: string, outerIndent: string): string {
  const inner = css.slice(a, b);
  const trail = /\s*$/.exec(inner)![0];
  const headEnd = b - trail.length;
  const before = css.slice(0, headEnd);
  const hasContent = headEnd > a;
  const sep = hasContent ? '\n\n' : (css.slice(0, a).endsWith('\n') || a === 0 ? '' : '\n');
  const tail = trail.includes('\n') ? trail : '\n' + outerIndent;
  return before + sep + block + tail + css.slice(b);
}

/** The indentation of the sheet's top-level rules ("    " inside an indented <style> block). */
function baseIndent(sheet: CssSheet): string {
  const first = sheet.nodes.find((n) => n.type !== 'comment') || sheet.nodes[0];
  return first ? lineIndent(sheet.text, first.start) : '';
}

/** Adds a new rule at the end of the sheet (or at the end of the @media block, creating it when missing). */
export function addRule(css: string, selector: string, props: Record<string, string> | [string, string][], media?: string | null): string {
  return addRuleText(css, (ind) => ruleBlock(selector, props, ind), media);
}

/** Adds rule text produced by `make(indent)` at the end of the sheet or inside a media block. */
export function addRuleText(css: string, make: (indent: string) => string, media?: string | null): string {
  const sheet = parseCss(css);
  const base = baseIndent(sheet);
  if (media) {
    const want = normMedia(media);
    const at = [...sheet.atRules].reverse().find((a) => a.bodyStart >= 0 && GROUPING.has(a.name) && normMedia(`@${a.name} ${a.prelude}`) === want && sheet.nodes.includes(a));
    if (at) {
      const ind = lineIndent(css, at.start);
      const childInd = (at.children?.find((c) => c.type !== 'comment') ? lineIndent(css, at.children!.find((c) => c.type !== 'comment')!.start) : '') || ind + '  ';
      return appendIn(css, at.bodyStart, at.bodyEnd, make(childInd), ind);
    }
    const head = media.trim().startsWith('@') ? media.trim() : `@media ${media.trim()}`;
    const block = `${base}${head} {\n${make(base + '  ')}\n${base}}`;
    return appendIn(css, 0, css.length, block, '');
  }
  return appendIn(css, 0, css.length, make(base), '');
}

/** Removes rules for `selector` (in the given media context, or every context when media is undefined). */
export function removeRule(css: string, selector: string | CssRule, media?: string | null): string {
  const rules = typeof selector === 'string' ? findRules(css, selector, media) : [selector];
  let out = css;
  for (const r of [...rules].sort((a, b) => b.start - a.start)) out = cut(out, r.start, r.end);
  return out;
}

/** Renames the selector of every rule written exactly as `from`. */
export function renameSelector(css: string, from: string, to: string, media?: string | null): string {
  const rules = findRules(css, from, media).filter((r) => !r.nested);
  let out = css;
  for (const r of [...rules].sort((a, b) => b.start - a.start)) out = out.slice(0, r.selStart) + to + out.slice(r.selEnd);
  return out;
}

/** Renames a class wherever it appears in selectors (".old" → ".new"), leaving strings alone. */
export function renameClassInCss(css: string, from: string, to: string): string {
  const sheet = parseCss(css);
  let out = css;
  const re = new RegExp(`\\.${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
  for (const r of [...sheet.rules].filter((x) => !x.synthetic).sort((a, b) => b.selStart - a.selStart)) {
    const sel = out.slice(r.selStart, r.selEnd);
    const ns = protect(sel, (s) => s.replace(re, '.' + to));
    if (ns !== sel) out = out.slice(0, r.selStart) + ns + out.slice(r.selEnd);
  }
  return out;
}

/** Changes a grouping at-rule's condition ("(max-width: 600px)" → "(max-width: 640px)"). */
export function renameAtRule(css: string, from: string, to: string): string {
  const sheet = parseCss(css);
  const want = normMedia(from);
  let out = css;
  for (const a of [...sheet.atRules].reverse()) {
    if (a.bodyStart < 0 || normMedia(`@${a.name} ${a.prelude}`) !== want) continue;
    const prelude = to.trim().replace(/^@[\w-]+\s*/, '');
    out = out.slice(0, a.preludeStart) + prelude + out.slice(a.preludeEnd);
  }
  return out;
}

/** The source text of a rule, wrapped in its media blocks when it is inside any. */
export function ruleText(css: string, rule: CssRule): string {
  let t = css.slice(rule.start, rule.end);
  const ind = lineIndent(css, rule.start);
  if (ind) t = t.split('\n').map((l) => (l.startsWith(ind) ? l.slice(ind.length) : l)).join('\n');
  for (const m of [...rule.media].reverse()) t = `${m} {\n${t.split('\n').map((l) => '  ' + l).join('\n')}\n}`;
  return t;
}

/** Moves a rule up or down among its siblings (swapping source text with the neighboring rule). */
export function moveRule(css: string, rule: CssRule, dir: -1 | 1): string {
  const sheet = parseCss(css);
  const siblings = siblingsOf(sheet, rule).filter((n) => n.type !== 'comment');
  const i = siblings.findIndex((n) => n.start === rule.start);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= siblings.length) return css;
  const [a, b] = dir < 0 ? [siblings[j], siblings[i]] : [siblings[i], siblings[j]];
  const ta = css.slice(a.start, a.end), tb = css.slice(b.start, b.end);
  return css.slice(0, a.start) + tb + css.slice(a.end, b.start) + ta + css.slice(b.end);
}

function siblingsOf(sheet: CssSheet, rule: CssRule): CssNode[] {
  const find = (nodes: CssNode[]): CssNode[] | null => {
    for (const n of nodes) {
      if (n.start === rule.start && n.type === 'rule') return nodes;
      const kids = n.type === 'at' ? n.children : n.type === 'rule' ? (n.items.filter((x) => x.type !== 'decl') as CssNode[]) : null;
      if (kids) { const r = find(kids); if (r) return r; }
    }
    return null;
  };
  return find(sheet.nodes) || [];
}

/** Removes grouping at-rules that hold nothing but whitespace and comments. */
export function removeEmptyBlocks(css: string): string {
  let out = css;
  for (let guard = 0; guard < 20; guard++) {
    const sheet = parseCss(out);
    const empty = sheet.atRules.filter((a) => a.bodyStart >= 0 && GROUPING.has(a.name) && !stripComments(out.slice(a.bodyStart, a.bodyEnd)).trim());
    if (!empty.length) break;
    for (const a of empty.sort((x, y) => y.start - x.start)) out = cut(out, a.start, a.end);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Whole-sheet transforms

function collapseValue(v: string): string {
  return protect(stripComments(v), (s) => s.replace(/\s+/g, ' ').trim());
}

function shortHex(s: string): string {
  return s.replace(/#([0-9a-fA-F])\1([0-9a-fA-F])\2([0-9a-fA-F])\3(?![0-9a-fA-F])/g, '#$1$2$3');
}

function minValue(v: string): string {
  return protect(stripComments(v), (s) => shortHex(s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ',').replace(/\s*!\s*important/gi, '!important').trim()));
}

function minPrelude(v: string): string {
  return minValue(v).replace(/\(\s*([\w-]+)\s*:\s*/g, '($1:');
}

function minSelector(s: string): string {
  return protect(stripComments(s), (x) => x.replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim());
}

/** Removes comments (except /*! … *\/ notices) and unneeded whitespace; shortens #aabbcc colors. */
export function minify(css: string): string {
  const sheet = parseCss(css);
  const out = (nodes: (CssNode | CssDecl)[]): string => {
    const parts: string[] = [];
    let decls: string[] = [];
    const flushDecls = () => { if (decls.length) { parts.push(decls.join(';')); decls = []; } };
    for (const n of nodes) {
      if (n.type === 'decl') { decls.push(`${n.prop}:${minValue(n.value)}${n.important ? '!important' : ''}`); continue; }
      if (n.type === 'comment') { if (n.text.startsWith('/*!')) { flushDecls(); parts.push(n.text); } continue; }
      flushDecls();
      if (n.type === 'rule') parts.push(`${minSelector(n.raw)}{${out(n.items)}}`);
      else if (n.bodyStart < 0) parts.push(`@${n.name}${n.prelude ? ' ' + minPrelude(n.prelude) : ''};`);
      else if (n.inner) parts.push(`@${n.name}${n.prelude ? ' ' + minPrelude(n.prelude) : ''}{${out(n.inner.items)}}`);
      else if (n.children) parts.push(`@${n.name}${n.prelude ? ' ' + minPrelude(n.prelude) : ''}{${out(n.children)}}`);
      else if (n.decls) parts.push(`@${n.name}${n.prelude ? ' ' + minPrelude(n.prelude) : ''}{${n.decls.map((d) => `${d.prop}:${minValue(d.value)}${d.important ? '!important' : ''}`).join(';')}}`);
      else parts.push(`@${n.name}${n.prelude ? ' ' + minPrelude(n.prelude) : ''}{${collapseValue(css.slice(n.bodyStart, n.bodyEnd))}}`);
    }
    flushDecls();
    // Declarations that follow a nested block need a separator only before them.
    return parts.reduce((acc, p, i) => acc + (i && !acc.endsWith('}') && !acc.endsWith(';') && !p.startsWith('/*') && !acc.endsWith('*/') ? ';' : '') + p, '');
  };
  return out(sheet.nodes);
}

/** Pretty-prints a style sheet: one declaration per line, blank lines between rules, comments kept. */
export function formatCss(css: string, indent = '  '): string {
  const sheet = parseCss(css);
  const lines: string[] = [];
  const decl = (d: CssDecl, ind: string) => `${ind}${d.prop}: ${collapseValue(d.value)}${d.important ? ' !important' : ''};`;
  const sel = (s: string) => splitSelectors(collapseValue(s)).join(',\n');
  const emit = (nodes: (CssNode | CssDecl)[], depth: number) => {
    const ind = indent.repeat(depth);
    let afterComment = false;
    const gap = () => { const last = lines[lines.length - 1]; if (lines.length && last !== '' && !last.endsWith('{') && !afterComment) lines.push(''); };
    for (const n of nodes) {
      if (n.type === 'decl') { lines.push(decl(n, ind)); afterComment = false; continue; }
      if (n.type === 'comment') { if (depth === 0) gap(); lines.push(...n.text.split('\n').map((l, i) => (i ? l : ind + l))); afterComment = true; continue; }
      gap();
      afterComment = false;
      if (n.type === 'rule') {
        lines.push(sel(n.raw).split('\n').map((l) => ind + l).join('\n') + ' {');
        emit(n.items, depth + 1);
        lines.push(ind + '}');
      } else if (n.bodyStart < 0) {
        lines.push(`${ind}@${n.name}${n.prelude ? ' ' + collapseValue(n.prelude) : ''};`);
      } else {
        lines.push(`${ind}@${n.name}${n.prelude ? ' ' + collapseValue(n.prelude) : ''} {`);
        if (n.inner) emit(n.inner.items, depth + 1);
        else if (n.children) emit(n.children, depth + 1);
        else if (n.decls) for (const d of n.decls) lines.push(decl(d, indent.repeat(depth + 1)));
        else { const body = collapseValue(css.slice(n.bodyStart, n.bodyEnd)); if (body) lines.push(indent.repeat(depth + 1) + body); }
        lines.push(ind + '}');
      }
    }
  };
  emit(sheet.nodes, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** The CSS of a sheet rebuilt from its parse (normalized). */
export function serializeCss(sheet: CssSheet): string { return formatCss(sheet.text); }

// ------------------------------------------------------------------------------------------
// Unused rules

type DocLike = string | Document;

function toDocs(docs: DocLike[]): Document[] {
  return docs.map((d) => (typeof d === 'string' ? new DOMParser().parseFromString(d, 'text/html') : d));
}

function partUsed(part: string, docs: Document[]): boolean {
  const s = staticSelector(part);
  for (const d of docs) {
    try { if (d.querySelector(s)) return true; } catch { return true; }
  }
  return false;
}

/** Selectors (parts of selector lists) that match no element in any of the pages. */
export function unusedSelectors(css: string | CssSheet, docs: DocLike[]): { selector: string; rule: CssRule }[] {
  const sheet = asSheet(css);
  const ds = toDocs(docs);
  const out: { selector: string; rule: CssRule }[] = [];
  for (const r of sheet.rules) {
    if (r.synthetic) continue;
    for (const p of splitSelectors(r.selector)) if (!partUsed(p, ds)) out.push({ selector: p, rule: r });
  }
  return out;
}

/**
 * Removes rules that match nothing in the pages, and unused selectors from selector lists. @font-face,
 * @keyframes and other at-rules are kept; media blocks left empty are removed.
 */
export function removeUnused(css: string, docs: DocLike[]): string {
  const sheet = parseCss(css);
  const ds = toDocs(docs);
  const edits: { s: number; e: number; text: string | null }[] = [];
  for (const r of sheet.rules) {
    if (r.synthetic || r.nested) continue;
    const parts = splitSelectors(r.raw);
    const kept = parts.filter((p) => partUsed(p, ds));
    if (!kept.length) edits.push({ s: r.start, e: r.end, text: null });
    else if (kept.length < parts.length) edits.push({ s: r.selStart, e: r.selEnd, text: kept.join(', ') });
  }
  let out = css;
  for (const ed of edits.sort((a, b) => b.s - a.s)) out = ed.text == null ? cut(out, ed.s, ed.e) : out.slice(0, ed.s) + ed.text + out.slice(ed.e);
  return removeEmptyBlocks(out);
}

// ------------------------------------------------------------------------------------------
// Vendor prefixes

const PREFIXES: Record<string, string[]> = {
  'user-select': ['-webkit-'],
  appearance: ['-webkit-', '-moz-'],
  'backdrop-filter': ['-webkit-'],
  'text-size-adjust': ['-webkit-', '-moz-'],
  mask: ['-webkit-'], 'mask-image': ['-webkit-'], 'mask-size': ['-webkit-'], 'mask-position': ['-webkit-'], 'mask-repeat': ['-webkit-'], 'mask-clip': ['-webkit-'], 'mask-origin': ['-webkit-'], 'mask-composite': ['-webkit-'],
  hyphens: ['-webkit-'],
  'box-decoration-break': ['-webkit-'],
  'print-color-adjust': ['-webkit-'],
  'initial-letter': ['-webkit-'],
  'text-emphasis': ['-webkit-'], 'text-emphasis-color': ['-webkit-'], 'text-emphasis-style': ['-webkit-'], 'text-emphasis-position': ['-webkit-'],
  'tab-size': ['-moz-'],
  'line-clamp': ['-webkit-'],
  'text-stroke': ['-webkit-'], 'text-stroke-width': ['-webkit-'], 'text-stroke-color': ['-webkit-'],
};

/** Prefixed property names browsers still need for `prop` (empty when none). */
export function vendorPrefixes(prop: string): string[] {
  return (PREFIXES[prop.toLowerCase()] || []).map((p) => p + prop.toLowerCase());
}

/** Adds the prefixed declarations older browsers need (before each standard one), where missing. */
export function addVendorPrefixes(css: string): string {
  const sheet = parseCss(css);
  const blocks: { decls: CssDecl[] }[] = [...sheet.rules, ...sheet.atRules.filter((a) => a.decls).map((a) => ({ decls: a.decls! }))];
  const edits: { at: number; text: string }[] = [];
  for (const b of blocks) {
    const have = new Set(b.decls.map((d) => `${d.prop}:${d.value.toLowerCase()}`));
    const props = new Set(b.decls.map((d) => d.prop));
    for (const d of b.decls) {
      const extra: string[] = [];
      for (const p of vendorPrefixes(d.prop)) if (!props.has(p)) extra.push(`${p}: ${d.value}${d.important ? ' !important' : ''};`);
      if (d.prop === 'position' && d.value.toLowerCase() === 'sticky' && !have.has('position:-webkit-sticky')) extra.push(`position: -webkit-sticky${d.important ? ' !important' : ''};`);
      if (d.prop === 'background-clip' && d.value.toLowerCase() === 'text' && !props.has('-webkit-background-clip')) extra.push('-webkit-background-clip: text;');
      if (!extra.length) continue;
      const ind = lineIndent(css, d.start);
      const startsLine = css.slice(css.lastIndexOf('\n', d.start - 1) + 1, d.start) === ind;
      const sep = startsLine ? `\n${ind}` : ' ';
      edits.push({ at: d.start, text: extra.join(sep) + sep });
    }
  }
  let out = css;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

// ------------------------------------------------------------------------------------------
// Moving CSS between files

/** Rewrites relative url() and @import references when CSS moves from one file to another. */
export function rebaseCssUrls(css: string, fromFile: string, toFile: string): string {
  if (fromFile === toFile) return css;
  const map = (ref: string) => { const p = resolveRef(fromFile, ref); return p && !ref.startsWith('/') ? relativeRef(toFile, p) : ref; };
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, ref) => `url(${q}${map(ref.trim())}${q})`).replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, ref) => `@import ${q}${map(ref)}${q}`);
}

/** Readable CSS text for a set of declarations (used by previews). */
export function declText(props: Record<string, string | null | undefined>, sep = '; '): string {
  return Object.entries(props).filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => `${k}: ${String(v).trim()}`).join(sep);
}
