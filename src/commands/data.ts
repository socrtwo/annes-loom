/**
 * Data: tables, lists and cards made from CSV, TSV, JSON and XML files — the modern counterpart of the
 * database results, data views and data sources of desktop web editors. Views are generated as static,
 * accessible markup now (refreshable from their source file, which data-ql-dataview names), with an
 * optional small fetch() script that renders the file again when the published page loads.
 * Server databases are not supported: export the data to CSV or JSON and use that file.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { closestSel, insertHtml, isPage, mutate, replaceElement, view } from '../editor/ops';
import { esc, escAttr, editHeadStyle } from '../model/html';
import { extOf, relativeRef, resolveRef, slugify, stripExt } from '../model/paths';
import { scriptSafe } from '../editor/behaviors';

// ------------------------------------------------------------------------------------------
// Parsing

/** Guesses the delimiter of delimited text from its first line (outside quotes). */
export function detectDelimiter(text: string): string {
  const line = firstRecord(text);
  const counts: [string, number][] = [',', '\t', ';', '|'].map((d) => [d, countOutsideQuotes(line, d)]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}
function firstRecord(text: string): string {
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') q = !q;
    else if (!q && (c === '\n' || c === '\r')) return text.slice(0, i);
  }
  return text;
}
function countOutsideQuotes(s: string, d: string): number {
  let q = false, n = 0;
  for (const c of s) { if (c === '"') q = !q; else if (!q && c === d) n++; }
  return n;
}

/**
 * Parses CSV/TSV (RFC 4180 and the usual variations): quoted fields with delimiters, line breaks and
 * doubled quotes inside, CRLF, LF or CR line ends, a byte-order mark, and a missing final line end.
 * Blank lines are skipped. `delimiter` defaults to detection.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(s);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const endField = () => { row.push(wasQuoted ? field : field.trim() === '' ? '' : field); field = ''; wasQuoted = false; };
  const endRow = () => { endField(); if (row.length > 1 || row[0] !== '') rows.push(row); row = []; };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field.trim() === '') { quoted = true; wasQuoted = true; field = ''; i++; continue; }
    if (c === d) { endField(); i++; continue; }
    if (c === '\r') { endRow(); i += s[i + 1] === '\n' ? 2 : 1; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || wasQuoted || row.length) endRow();
  return rows;
}

export interface Data { columns: string[]; rows: Record<string, string>[] }

function uniqueColumns(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n, i) => {
    let b = String(n ?? '').trim() || `Column ${i + 1}`;
    const k = b.toLowerCase();
    const c = seen.get(k) || 0;
    seen.set(k, c + 1);
    if (c) b = `${b} ${c + 1}`;
    return b;
  });
}

export function matrixToData(m: string[][], header = true): Data {
  if (!m.length) return { columns: [], rows: [] };
  const width = Math.max(...m.map((r) => r.length));
  const columns = uniqueColumns(header ? Array.from({ length: width }, (_, i) => m[0][i] ?? '') : Array.from({ length: width }, (_, i) => `Column ${i + 1}`));
  const body = header ? m.slice(1) : m;
  return { columns, rows: body.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))) };
}

const cellText = (v: any): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** JSON: an array of objects (or of values), or an object holding such an array. */
export function jsonToData(text: string): Data {
  let v = JSON.parse(text.replace(/^﻿/, ''));
  if (!Array.isArray(v) && v && typeof v === 'object') {
    const arr = Object.values(v).find((x) => Array.isArray(x));
    v = arr ?? [v];
  }
  if (!Array.isArray(v)) v = [v];
  const columns: string[] = [];
  const rows = (v as any[]).map((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const k of Object.keys(item)) if (!columns.includes(k)) columns.push(k);
      return Object.fromEntries(Object.entries(item).map(([k, x]) => [k, cellText(x)]));
    }
    if (!columns.includes('value')) columns.push('value');
    return { value: cellText(item) };
  });
  return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? '']))) };
}

/** XML: the repeating child elements of the root (or of its first child that repeats) are the rows. */
export function xmlToData(text: string): Data {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The XML file is not well-formed.');
  let parent: Element | null = doc.documentElement;
  for (let depth = 0; parent && depth < 4; depth++) {
    const kids: Element[] = [...parent.children];
    const names: string[] = kids.map((k) => k.tagName);
    if (kids.length > 1 && names.some((n, i) => names.indexOf(n) !== i)) break;
    if (kids.length === 1 && kids[0].children.length) { parent = kids[0]; continue; }
    break;
  }
  const items = parent ? [...parent.children] : [];
  const columns: string[] = [];
  const rows = items.map((it) => {
    const r: Record<string, string> = {};
    for (const a of it.attributes) { r[a.name] = a.value; if (!columns.includes(a.name)) columns.push(a.name); }
    if (!it.children.length && it.textContent?.trim()) { r[it.tagName] = it.textContent.trim(); if (!columns.includes(it.tagName)) columns.push(it.tagName); }
    for (const c of it.children) { r[c.tagName] = (c.textContent || '').trim(); if (!columns.includes(c.tagName)) columns.push(c.tagName); }
    return r;
  });
  return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? '']))) };
}

export type DataFormat = 'csv' | 'tsv' | 'json' | 'xml';
export function formatOf(pathOrText: string, isText = false): DataFormat {
  if (isText) { const t = pathOrText.trim(); return t.startsWith('[') || t.startsWith('{') ? 'json' : t.startsWith('<') ? 'xml' : 'csv'; }
  const e = extOf(pathOrText);
  return e === 'json' ? 'json' : e === 'xml' || e === 'rss' ? 'xml' : e === 'tsv' || e === 'tab' ? 'tsv' : 'csv';
}

export function parseData(text: string, format: DataFormat, opts: { header?: boolean; delimiter?: string } = {}): Data {
  if (format === 'json') return jsonToData(text);
  if (format === 'xml') return xmlToData(text);
  return matrixToData(parseCsv(text, format === 'tsv' ? '\t' : opts.delimiter || undefined), opts.header !== false);
}

// ------------------------------------------------------------------------------------------
// Views

export type Op = '=' | '!=' | 'contains' | '!contains' | 'starts' | '>' | '<' | '>=' | '<=' | 'empty' | '!empty';
export const OPS: { value: Op; label: string }[] = [
  { value: '=', label: 'equals' }, { value: '!=', label: 'does not equal' }, { value: 'contains', label: 'contains' }, { value: '!contains', label: 'does not contain' },
  { value: 'starts', label: 'starts with' }, { value: '>', label: 'is greater than' }, { value: '<', label: 'is less than' }, { value: '>=', label: 'is at least' },
  { value: '<=', label: 'is at most' }, { value: 'empty', label: 'is empty' }, { value: '!empty', label: 'is not empty' },
];

export interface Rule { col: string; op: Op; value: string; cls: string; css?: string }

export interface ViewConfig {
  id: string;
  /** Source file, relative to the page. Absent for pasted data (not refreshable). */
  src?: string;
  format?: DataFormat;
  layout: 'table' | 'list' | 'cards' | 'value';
  header?: boolean;
  delimiter?: string;
  columns?: string[];
  caption?: string;
  sort?: { key: string; dir: 'asc' | 'desc' };
  filter?: { key: string; op: Op; value: string };
  group?: string;
  rules?: Rule[];
  style?: string;
  live?: boolean;
  /** value layout: column and 1-based row, or the first row where match.key = match.value */
  column?: string;
  row?: number;
  match?: { key: string; value: string };
}

const numOf = (s: string): number | null => {
  const t = String(s ?? '').trim().replace(/[$€£¥,\s%]/g, '');
  return t !== '' && /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t) ? Number(t) : null;
};

export function matchOp(cell: string, op: Op, value: string): boolean {
  const a = String(cell ?? '');
  const b = String(value ?? '');
  const na = numOf(a), nb = numOf(b);
  const cmp = na != null && nb != null ? na - nb : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  switch (op) {
    case '=': return cmp === 0;
    case '!=': return cmp !== 0;
    case 'contains': return a.toLowerCase().includes(b.toLowerCase());
    case '!contains': return !a.toLowerCase().includes(b.toLowerCase());
    case 'starts': return a.toLowerCase().startsWith(b.toLowerCase());
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case 'empty': return a.trim() === '';
    case '!empty': return a.trim() !== '';
  }
  return false;
}

export function compareCells(a: string, b: string): number {
  const na = numOf(a), nb = numOf(b);
  if (na != null && nb != null) return na - nb;
  if (na != null) return -1;
  if (nb != null) return 1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Filtered and sorted rows of a view. */
export function queryRows(d: Data, cfg: Pick<ViewConfig, 'filter' | 'sort' | 'group'>): Record<string, string>[] {
  let rows = d.rows;
  const f = cfg.filter;
  if (f?.key) rows = rows.filter((r) => matchOp(r[f.key] ?? '', f.op, f.value));
  const keys: { key: string; dir: number }[] = [];
  if (cfg.group) keys.push({ key: cfg.group, dir: 1 });
  if (cfg.sort?.key) keys.push({ key: cfg.sort.key, dir: cfg.sort.dir === 'desc' ? -1 : 1 });
  if (keys.length) rows = rows.map((r, i) => ({ r, i })).sort((x, y) => { for (const k of keys) { const c = compareCells(x.r[k.key] ?? '', y.r[k.key] ?? ''); if (c) return c * k.dir; } return x.i - y.i; }).map((x) => x.r);
  return rows;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Class name for a rule: its own (".late") or one derived from its CSS. */
export function ruleClass(css: string): string { return `ql-cf-${hash(css.trim())}`; }

/** "Status = Late => background: #fde2e2" or "Price > 100 => .expensive", one per line. */
export function parseRules(text: string): Rule[] {
  const out: Rule[] = [];
  const opRe = /\s(!contains|!empty|contains|starts|empty|>=|<=|!=|=|>|<)(?:\s|$)/;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [cond, effect] = line.split(/\s*=>\s*/);
    if (!cond || !effect) continue;
    const m = opRe.exec(' ' + cond);
    if (!m) continue;
    const at = m.index;
    const col = cond.slice(0, at - 0).trim();
    const value = cond.slice(at - 1 + m[0].length).trim().replace(/^["']|["']$/g, '');
    const e = effect.trim();
    if (/^\.[\w-]+$/.test(e)) out.push({ col, op: m[1] as Op, value, cls: e.slice(1) });
    else out.push({ col, op: m[1] as Op, value, cls: ruleClass(e), css: e.replace(/;?\s*$/, '') });
  }
  return out;
}

export function formatRules(rules: Rule[] = []): string {
  return rules.map((r) => `${r.col} ${r.op}${r.op === 'empty' || r.op === '!empty' ? '' : ' ' + r.value} => ${r.css ?? '.' + r.cls}`).join('\n');
}

export function rulesCss(rules: Rule[] = []): string {
  return rules.filter((r) => r.css).map((r) => `.${r.cls} { ${r.css}; }`).join('\n');
}

function rowClasses(r: Record<string, string>, rules: Rule[] = []): string {
  return rules.filter((x) => matchOp(r[x.col] ?? '', x.op, x.value)).map((x) => x.cls).join(' ');
}

/** Cell markup: web and email addresses become links; everything else is text. */
export function cellHtml(v: string): string {
  const t = String(v ?? '');
  if (/^https?:\/\/[^\s"<>]+$/i.test(t)) return `<a href="${escAttr(t)}">${esc(t)}</a>`;
  if (/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(t)) return `<a href="mailto:${escAttr(t)}">${esc(t)}</a>`;
  return esc(t);
}

function cfgAttr(cfg: ViewConfig): string {
  if (!cfg.src) return '';
  const keep: any = {};
  for (const [k, v] of Object.entries(cfg)) if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) keep[k] = v;
  return ` data-ql-dataview="${escAttr(JSON.stringify(keep))}"`;
}

/** The view's markup (root element carries the id, classes and, when it has a source, its configuration). */
export function renderView(d: Data, cfg: ViewConfig): string {
  const cols = (cfg.columns?.length ? cfg.columns.filter((c) => d.columns.includes(c)) : d.columns);
  const useCols = cols.length ? cols : d.columns;
  const style = cfg.style && cfg.style !== 'plain' ? ` ql-data-${cfg.style}` : '';
  const idA = ` id="${escAttr(cfg.id)}"`;
  if (cfg.layout === 'value') {
    const row = cfg.match?.key ? d.rows.find((r) => matchOp(r[cfg.match!.key] ?? '', '=', cfg.match!.value)) : d.rows[Math.max(0, (cfg.row || 1) - 1)];
    const val = row ? row[cfg.column || useCols[0]] ?? '' : '';
    return `<span${idA} class="ql-data-value"${cfgAttr(cfg)}>${esc(val)}</span>`;
  }
  const rows = queryRows(d, cfg);
  const groups: [string | null, Record<string, string>[]][] = [];
  if (cfg.group) { for (const r of rows) { const g = r[cfg.group] ?? ''; const last = groups[groups.length - 1]; if (last && last[0] === g) last[1].push(r); else groups.push([g, [r]]); } }
  else groups.push([null, rows]);
  const shown = cfg.group ? useCols.filter((c) => c !== cfg.group) : useCols;
  const cls = (r: Record<string, string>, base = '') => { const c = [base, rowClasses(r, cfg.rules)].filter(Boolean).join(' '); return c ? ` class="${escAttr(c)}"` : ''; };
  if (cfg.layout === 'table') {
    const out: string[] = [`<table${idA} class="ql-data${style}"${cfgAttr(cfg)}>`];
    if (cfg.caption) out.push(`<caption>${esc(cfg.caption)}</caption>`);
    out.push('<thead>', `<tr>${shown.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr>`, '</thead>');
    for (const [g, rs] of groups) {
      out.push('<tbody>');
      if (g !== null) out.push(`<tr class="ql-data-group"><th scope="rowgroup" colspan="${shown.length}">${esc(cfg.group!)}: ${esc(g || '(none)')}</th></tr>`);
      for (const r of rs) out.push(`<tr${cls(r)}>${shown.map((c) => `<td>${cellHtml(r[c] ?? '')}</td>`).join('')}</tr>`);
      out.push('</tbody>');
    }
    if (!rows.length) out.push('<tbody>', `<tr><td colspan="${shown.length || 1}">No matching records.</td></tr>`, '</tbody>');
    out.push('</table>');
    return out.join('\n');
  }
  const [titleCol, ...rest] = shown;
  const item = (r: Record<string, string>) => cfg.layout === 'cards'
    ? `<article${cls(r, 'ql-data-card')}>\n<h3>${cellHtml(r[titleCol] ?? '')}</h3>\n<dl>\n${rest.map((c) => `<dt>${esc(c)}</dt><dd>${cellHtml(r[c] ?? '')}</dd>`).join('\n')}\n</dl>\n</article>`
    : `<li${cls(r)}><strong>${cellHtml(r[titleCol] ?? '')}</strong>${rest.map((c) => ` <span class="ql-data-field"><span class="ql-data-key">${esc(c)}:</span> ${cellHtml(r[c] ?? '')}</span>`).join('')}</li>`;
  const wrap = (rs: Record<string, string>[]) => cfg.layout === 'cards' ? `<div class="ql-data-cards">\n${rs.map(item).join('\n')}\n</div>` : `<ul>\n${rs.map(item).join('\n')}\n</ul>`;
  const out: string[] = [`<div${idA} class="ql-data ql-data-${cfg.layout}${style}"${cfgAttr(cfg)}>`];
  if (cfg.caption) out.push(`<h2 class="ql-data-caption">${esc(cfg.caption)}</h2>`);
  if (!rows.length) out.push('<p>No matching records.</p>');
  else for (const [g, rs] of groups) out.push(g !== null ? `<section>\n<h3 class="ql-data-group">${esc(cfg.group!)}: ${esc(g || '(none)')}</h3>\n${wrap(rs)}\n</section>` : wrap(rs));
  out.push('</div>');
  return out.join('\n');
}

/**
 * A script that renders the view again from the published data file when the page loads (fetch()). Without
 * it, or when the file cannot be fetched, the static copy stays. CSV and JSON only.
 */
export function liveScript(cfg: ViewConfig): string {
  const c = JSON.stringify({ ...cfg, live: undefined });
  return scriptSafe(`/* Live data view – generated by QuillLoom. Renders ${cfg.src} when the page loads; the static copy stays if it cannot be read. */
(function () {
  'use strict';
  var cfg = ${c};
  if (!window.fetch) return;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function cell(v) { v = String(v == null ? '' : v); if (/^https?:\\/\\/[^\\s"<>]+$/i.test(v)) return '<a href="' + esc(v) + '">' + esc(v) + '</a>'; if (/^[^\\s@<>"]+@[^\\s@<>"]+\\.[a-z]{2,}$/i.test(v)) return '<a href="mailto:' + esc(v) + '">' + esc(v) + '</a>'; return esc(v); }
  function csv(t, d) {
    t = t.replace(/^\\uFEFF/, '');
    if (!d) { var first = t.split(/\\r?\\n/)[0], best = ',', n = -1; [',', '\\t', ';', '|'].forEach(function (x) { var k = first.split(x).length; if (k > n) { n = k; best = x; } }); d = best; }
    var rows = [], row = [], f = '', q = false, wq = false;
    function endF() { row.push(f); f = ''; wq = false; }
    function endR() { endF(); if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
      if (c === '"' && f.trim() === '') { q = true; wq = true; f = ''; }
      else if (c === d) endF();
      else if (c === '\\r') { endR(); if (t[i + 1] === '\\n') i++; }
      else if (c === '\\n') endR();
      else f += c;
    }
    if (f !== '' || wq || row.length) endR();
    return rows;
  }
  function toData(text) {
    var cols = [], rows = [];
    if (cfg.format === 'json') {
      var v = JSON.parse(text);
      if (!Array.isArray(v) && v && typeof v === 'object') { var k = Object.keys(v).filter(function (x) { return Array.isArray(v[x]); })[0]; v = k ? v[k] : [v]; }
      (Array.isArray(v) ? v : [v]).forEach(function (it) {
        var r = {};
        if (it && typeof it === 'object' && !Array.isArray(it)) Object.keys(it).forEach(function (x) { if (cols.indexOf(x) < 0) cols.push(x); r[x] = it[x] != null && typeof it[x] === 'object' ? JSON.stringify(it[x]) : it[x]; });
        else { if (cols.indexOf('value') < 0) cols.push('value'); r.value = it; }
        rows.push(r);
      });
    } else {
      var m = csv(text, cfg.format === 'tsv' ? '\\t' : cfg.delimiter), w = 0;
      m.forEach(function (r) { w = Math.max(w, r.length); });
      for (var i = 0; i < w; i++) cols.push(cfg.header === false ? 'Column ' + (i + 1) : (m[0] && m[0][i] || 'Column ' + (i + 1)).trim());
      (cfg.header === false ? m : m.slice(1)).forEach(function (r) { var o = {}; cols.forEach(function (c, j) { o[c] = r[j] == null ? '' : r[j]; }); rows.push(o); });
    }
    return { cols: cols, rows: rows };
  }
  function num(s) { var t = String(s == null ? '' : s).trim().replace(/[$€£¥,\\s%]/g, ''); return t !== '' && /^[-+]?\\d*\\.?\\d+(e[-+]?\\d+)?$/i.test(t) ? Number(t) : null; }
  function cmp(a, b) { var x = num(a), y = num(b); if (x != null && y != null) return x - y; if (x != null) return -1; if (y != null) return 1; return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }); }
  function match(a, op, b) {
    a = String(a == null ? '' : a); b = String(b == null ? '' : b);
    var c = cmp(a, b), al = a.toLowerCase(), bl = b.toLowerCase();
    return op === '=' ? c === 0 : op === '!=' ? c !== 0 : op === 'contains' ? al.indexOf(bl) >= 0 : op === '!contains' ? al.indexOf(bl) < 0 : op === 'starts' ? al.indexOf(bl) === 0 :
      op === '>' ? c > 0 : op === '<' ? c < 0 : op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === 'empty' ? !a.trim() : op === '!empty' ? !!a.trim() : false;
  }
  function render(d) {
    var cols = (cfg.columns && cfg.columns.length ? cfg.columns.filter(function (c) { return d.cols.indexOf(c) >= 0; }) : d.cols);
    if (!cols.length) cols = d.cols;
    var rows = d.rows.slice(), f = cfg.filter;
    if (f && f.key) rows = rows.filter(function (r) { return match(r[f.key], f.op, f.value); });
    var keys = [];
    if (cfg.group) keys.push([cfg.group, 1]);
    if (cfg.sort && cfg.sort.key) keys.push([cfg.sort.key, cfg.sort.dir === 'desc' ? -1 : 1]);
    rows = rows.map(function (r, i) { return [r, i]; }).sort(function (x, y) { for (var k = 0; k < keys.length; k++) { var c = cmp(x[0][keys[k][0]], y[0][keys[k][0]]); if (c) return c * keys[k][1]; } return x[1] - y[1]; }).map(function (x) { return x[0]; });
    var groups = [];
    rows.forEach(function (r) { var g = cfg.group ? String(r[cfg.group] == null ? '' : r[cfg.group]) : null; var l = groups[groups.length - 1]; if (l && l[0] === g) l[1].push(r); else groups.push([g, [r]]); });
    if (!cfg.group && !groups.length) groups.push([null, []]);
    var shown = cfg.group ? cols.filter(function (c) { return c !== cfg.group; }) : cols;
    function cls(r, base) { var c = [base || ''].concat((cfg.rules || []).filter(function (x) { return match(r[x.col], x.op, x.value); }).map(function (x) { return x.cls; })).filter(Boolean).join(' '); return c ? ' class="' + esc(c) + '"' : ''; }
    var style = cfg.style && cfg.style !== 'plain' ? ' ql-data-' + cfg.style : '', h = [];
    if (cfg.layout === 'table') {
      h.push('<table id="' + esc(cfg.id) + '" class="ql-data' + style + '">');
      if (cfg.caption) h.push('<caption>' + esc(cfg.caption) + '</caption>');
      h.push('<thead><tr>' + shown.map(function (c) { return '<th scope="col">' + esc(c) + '</th>'; }).join('') + '</tr></thead>');
      groups.forEach(function (g) {
        h.push('<tbody>');
        if (g[0] !== null) h.push('<tr class="ql-data-group"><th scope="rowgroup" colspan="' + shown.length + '">' + esc(cfg.group) + ': ' + esc(g[0] || '(none)') + '</th></tr>');
        g[1].forEach(function (r) { h.push('<tr' + cls(r) + '>' + shown.map(function (c) { return '<td>' + cell(r[c]) + '</td>'; }).join('') + '</tr>'); });
        h.push('</tbody>');
      });
      if (!rows.length) h.push('<tbody><tr><td colspan="' + (shown.length || 1) + '">No matching records.</td></tr></tbody>');
      h.push('</table>');
    } else {
      var t = shown[0], rest = shown.slice(1);
      var item = function (r) {
        return cfg.layout === 'cards'
          ? '<article' + cls(r, 'ql-data-card') + '><h3>' + cell(r[t]) + '</h3><dl>' + rest.map(function (c) { return '<dt>' + esc(c) + '</dt><dd>' + cell(r[c]) + '</dd>'; }).join('') + '</dl></article>'
          : '<li' + cls(r) + '><strong>' + cell(r[t]) + '</strong>' + rest.map(function (c) { return ' <span class="ql-data-field"><span class="ql-data-key">' + esc(c) + ':</span> ' + cell(r[c]) + '</span>'; }).join('') + '</li>';
      };
      var wrap = function (rs) { return cfg.layout === 'cards' ? '<div class="ql-data-cards">' + rs.map(item).join('') + '</div>' : '<ul>' + rs.map(item).join('') + '</ul>'; };
      h.push('<div id="' + esc(cfg.id) + '" class="ql-data ql-data-' + cfg.layout + style + '">');
      if (cfg.caption) h.push('<h2 class="ql-data-caption">' + esc(cfg.caption) + '</h2>');
      if (!rows.length) h.push('<p>No matching records.</p>');
      else groups.forEach(function (g) { h.push(g[0] !== null ? '<section><h3 class="ql-data-group">' + esc(cfg.group) + ': ' + esc(g[0] || '(none)') + '</h3>' + wrap(g[1]) + '</section>' : wrap(g[1])); });
      h.push('</div>');
    }
    return h.join('');
  }
  fetch(cfg.src, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); }).then(function (text) {
    var el = document.getElementById(cfg.id);
    if (!el) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = render(toData(text));
    if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild);
  }).catch(function () { /* keep the static copy */ });
})();`);
}

/** Script that filters the rows, items or cards of a view as the visitor types in a search box. */
export function searchScript(inputId: string, targetId: string, statusId: string): string {
  return scriptSafe(`/* Data search – generated by QuillLoom. */
(function () {
  'use strict';
  var input = document.getElementById(${JSON.stringify(inputId)}), status = document.getElementById(${JSON.stringify(statusId)});
  if (!input) return;
  function apply() {
    var view = document.getElementById(${JSON.stringify(targetId)});
    if (!view) return;
    var q = input.value.trim().toLowerCase(), shown = 0, total = 0;
    var items = view.querySelectorAll('tbody tr:not(.ql-data-group), li, .ql-data-card');
    for (var i = 0; i < items.length; i++) {
      var hit = !q || items[i].textContent.toLowerCase().indexOf(q) >= 0;
      items[i].hidden = !hit;
      total++; if (hit) shown++;
    }
    if (status) status.textContent = q ? shown + ' of ' + total + ' shown' : '';
  }
  input.addEventListener('input', apply);
  if (input.form) input.form.addEventListener('submit', function (e) { e.preventDefault(); apply(); });
})();`);
}

/** Data of a plain HTML table (header row from thead or the first row). */
export function tableToData(table: Element): Data {
  const headRow = table.querySelector('thead tr') || table.querySelector('tr');
  const columns = uniqueColumns(headRow ? [...headRow.children].map((c) => (c.textContent || '').trim()) : []);
  const bodyRows = [...table.querySelectorAll('tr')].filter((r) => r !== headRow && !r.closest('thead') && !r.classList.contains('ql-data-group'));
  return { columns, rows: bodyRows.map((r) => Object.fromEntries(columns.map((c, i) => [c, (r.children[i]?.textContent || '').trim()]))) };
}

export const DATA_CSS = `/* ql-data-views */
table.ql-data { border-collapse: collapse; margin: 1em 0; }
table.ql-data caption { font-weight: bold; text-align: left; padding: .3em 0; }
table.ql-data th, table.ql-data td { padding: .35em .7em; text-align: left; vertical-align: top; }
table.ql-data thead th { border-bottom: 2px solid currentColor; }
table.ql-data .ql-data-group th { background: rgba(127,127,127,.12); }
table.ql-data-grid th, table.ql-data-grid td { border: 1px solid #999; }
table.ql-data-striped tbody tr:nth-child(even) { background: rgba(127,127,127,.1); }
table.ql-data-compact th, table.ql-data-compact td { padding: .15em .4em; font-size: .9em; }
.ql-data-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(14em, 1fr)); gap: 1em; }
.ql-data-card { border: 1px solid rgba(127,127,127,.4); border-radius: 6px; padding: .8em 1em; }
.ql-data-card h3 { margin: 0 0 .4em; }
.ql-data-card dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: .2em .6em; }
.ql-data-card dt { font-weight: bold; }
.ql-data-card dd { margin: 0; }
.ql-data-list .ql-data-key { font-weight: bold; }
.ql-data-striped .ql-data-card:nth-child(even), .ql-data-striped li:nth-child(even) { background: rgba(127,127,127,.1); }
/* end ql-data-views */`;

// ------------------------------------------------------------------------------------------
// Editor glue

const DATA_EXT = /\.(csv|tsv|tab|txt|json|xml)$/i;
const dataFiles = (app: App, kinds = DATA_EXT) => app.site.list((f) => kinds.test(f.path)).map((f) => f.path);

function readSiteData(app: App, cfg: ViewConfig): Data {
  if (!cfg.src) throw new Error('This view has no source file.');
  const p = resolveRef(app.active.path, cfg.src);
  if (!p || !app.site.has(p)) throw new Error(`The data file ${cfg.src} is not in the site.`);
  return parseData(app.site.read(p) || '', cfg.format || formatOf(p), { header: cfg.header, delimiter: cfg.delimiter });
}

function uniqueViewId(app: App, base = 'dataview'): string {
  const src = app.active?.source || '';
  const doc = view(app)?.design?.doc;
  for (let i = 1; ; i++) { const id = `${base}${i}`; if (!new RegExp(`\\sid\\s*=\\s*["']?${id}["'\\s>]`).test(src) && !doc?.getElementById(id)) return id; }
}

/** Adds the data view style sheet rules (and rule classes) to the page head when missing. */
function ensureCss(app: App, rules: Rule[] = []): void {
  app.editSource('Data View Styles', (src) => editHeadStyle(src, (css) => {
    let out = css;
    if (!out.includes('/* ql-data-views */')) out = out.replace(/\s*$/, '\n') + DATA_CSS.split('\n').map((l) => '    ' + l).join('\n') + '\n  ';
    for (const r of rules) if (r.css && !out.includes(`.${r.cls} `)) out = out.replace(/\s*$/, '\n') + `    .${r.cls} { ${r.css}; }\n  `;
    return out;
  }));
}

function viewCfgOf(el: Element | null): ViewConfig | null {
  const raw = el?.getAttribute('data-ql-dataview');
  if (!raw) return null;
  try { const c = JSON.parse(raw); if (!c.id) c.id = el!.id || 'dataview'; return c; } catch { return null; }
}

/** The data view (or plain table) around the selection. */
function selectedView(app: App): { el: HTMLElement; cfg: ViewConfig | null } | null {
  const el = closestSel(app, '[data-ql-dataview]');
  if (el) return { el, cfg: viewCfgOf(el) };
  const t = closestSel(app, 'table');
  return t ? { el: t, cfg: null } : null;
}

function needDesign(app: App): boolean {
  const v = view(app);
  if (!isPage(app) || !v) { toast('Open a page first.'); return false; }
  if (!v.design?.doc || v.target !== 'design') { if (v.tab.view === 'code' || v.tab.view === 'preview') app.setView(v.tab, 'split'); toast('Click the data view in Design view first.'); return false; }
  return true;
}

function viewMarkup(d: Data, cfg: ViewConfig): string {
  let html = renderView(d, cfg);
  if (cfg.live && cfg.src && cfg.format !== 'xml') html += `\n<script id="ql-live-${escAttr(cfg.id)}">\n${liveScript(cfg)}\n</script>`;
  return html;
}

/** Regenerates one view in Design view from its source file (and its live script). */
function regenerate(app: App, el: Element, cfg: ViewConfig, doc: Document): void {
  const d = readSiteData(app, cfg);
  replaceElement(app, el, renderView(d, cfg));
  const s = doc.getElementById(`ql-live-${cfg.id}`);
  if (cfg.live && cfg.src && cfg.format !== 'xml') {
    if (s) s.textContent = '\n' + liveScript(cfg) + '\n';
    else { const n = doc.getElementById(cfg.id); const sc = doc.createElement('script'); sc.id = `ql-live-${cfg.id}`; sc.textContent = '\n' + liveScript(cfg) + '\n'; n?.after(sc); }
  } else s?.remove();
}

function updateView(app: App, el: Element, cfg: ViewConfig): boolean {
  try {
    readSiteData(app, cfg);
  } catch (e) { toast((e as Error).message); return false; }
  const ok = mutate(app, (doc) => regenerate(app, el, cfg, doc));
  if (ok && (cfg.rules?.some((r) => r.css) || (cfg.style && cfg.style !== 'plain') || cfg.layout === 'cards')) ensureCss(app, cfg.rules);
  return ok;
}

// ------------------------------------------------------------------------------------------
// The data dialog (From CSV, From JSON, Data View, Database Results)

interface DialogOpts { title: string; paste: boolean; kinds: RegExp; layout?: ViewConfig['layout']; note?: string; help?: string; format?: DataFormat; query?: boolean }

const LAYOUTS = [{ value: 'table', label: 'Table' }, { value: 'list', label: 'List' }, { value: 'cards', label: 'Cards' }];
const STYLES = [{ value: 'plain', label: 'Plain' }, { value: 'grid', label: 'Grid lines' }, { value: 'striped', label: 'Striped rows' }, { value: 'compact', label: 'Compact' }];

async function dataDialog(app: App, o: DialogOpts, arg?: any): Promise<{ data: Data; cfg: ViewConfig; text: string; saveAs?: string } | null> {
  const files = dataFiles(app, o.kinds);
  const rel = (p: string) => relativeRef(app.active.path, p);
  let data: Data | null = null;
  let text = '';
  let error = '';
  let upload: { name: string; text: string } | null = null;
  const prefill = arg && typeof arg === 'object' && arg.prefill ? resolveRef(app.active.path, String(arg.src || '')) : null;
  if (prefill) arg = undefined;
  const fields: Field[] = [
    ...(o.note ? [{ key: 'note', type: 'info' as const, label: o.note }] : []),
    { key: 'source', label: 'Data from', type: 'radio', value: prefill || (files.length && !o.paste) ? 'site' : o.paste ? 'paste' : 'site', options: [
      ...(o.paste ? [{ value: 'paste', label: 'Pasted text' }] : []),
      { value: 'site', label: files.length ? 'A file in this site' : 'A file in this site (none yet)' },
      { value: 'upload', label: 'A file on this device' }] },
    { key: 'text', label: 'Paste the data', type: 'textarea', rows: 6, value: '', placeholder: o.format === 'json' ? '[{"name": "Ada", "role": "Engineer"}]' : 'Name,Role\nAda,Engineer', visibleIf: (v) => v.source === 'paste' },
    { key: 'file', label: 'Site file', type: 'select', value: (prefill && files.includes(prefill) ? prefill : files[0]) || '', options: files.length ? files : [{ value: '', label: '(no data files)' }], visibleIf: (v) => v.source === 'site' },
    { key: 'upload', label: 'File', type: 'file', accept: '.csv,.tsv,.txt,.json,.xml', visibleIf: (v) => v.source === 'upload' },
    { key: 'saveCopy', label: 'Save a copy in the site (data folder) so the view can be refreshed', type: 'checkbox', value: true, visibleIf: (v) => v.source === 'upload' },
    { key: 'delimiter', label: 'Delimiter', type: 'select', value: '', half: true, options: [{ value: '', label: 'Detect' }, { value: ',', label: 'Comma' }, { value: '\t', label: 'Tab' }, { value: ';', label: 'Semicolon' }, { value: '|', label: 'Vertical bar' }] },
    { key: 'header', label: 'First row holds the column names', type: 'checkbox', value: true, half: true },
    { key: 'cols', type: 'info', label: '' },
    { key: 'layout', label: 'Layout', type: 'select', value: o.layout || 'table', options: LAYOUTS, half: true },
    { key: 'style', label: 'Style', type: 'select', value: 'striped', options: STYLES, half: true },
    { key: 'caption', label: 'Caption (describes the data)', type: 'text', value: '' },
    { key: 'columns', label: 'Columns to show, in order (comma-separated; empty: all)', type: 'text', value: '' },
    ...(o.query !== false ? [
      { key: 'sortKey', label: 'Sort by column', type: 'text' as const, value: '', half: true },
      { key: 'sortDir', label: 'Order', type: 'select' as const, value: 'asc', options: [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], half: true },
      { key: 'filterKey', label: 'Show only rows where column', type: 'text' as const, value: '', half: true },
      { key: 'filterOp', label: 'Condition', type: 'select' as const, value: '=', options: OPS, half: true },
      { key: 'filterValue', label: 'Value', type: 'text' as const, value: '', half: true },
      { key: 'group', label: 'Group by column', type: 'text' as const, value: '', half: true },
    ] : []),
    { key: 'live', label: 'Also render the file again when the published page loads (adds a small fetch() script)', type: 'checkbox', value: false, visibleIf: (v) => v.source !== 'paste' },
  ];
  const fmtOf = (v: Record<string, any>): DataFormat => v.source === 'paste' ? (o.format && o.format !== 'csv' ? o.format : formatOf(v.text || '', true)) : formatOf(v.source === 'site' ? v.file || '' : upload?.name || '');
  const refresh = (v: Record<string, any>, ctl: any) => {
    text = v.source === 'paste' ? v.text || '' : v.source === 'site' ? (v.file && app.site.read(v.file)) || '' : upload?.text || '';
    error = '';
    data = null;
    if (text.trim()) {
      try { data = parseData(text, fmtOf(v), { header: v.header, delimiter: v.delimiter }); } catch (e) { error = (e as Error).message; }
    }
    const info = [...ctl.body.querySelectorAll('.ql-info')].pop() as HTMLElement | undefined;
    if (info) info.textContent = error ? `Cannot read the data: ${error}` : data ? `${data.rows.length} record(s). Columns: ${data.columns.join(', ') || '(none)'}` : 'No data yet.';
    if (data) {
      const cfg = cfgFrom(v, 'preview');
      const sample = { columns: data.columns, rows: data.rows.slice(0, 200) };
      try { ctl.setPreview(renderView(sample, { ...cfg, rules: [] }).replace(/<(table|div) /, '<$1 style="font-size:12px" ')); } catch { /* */ }
    } else ctl.setPreview('');
  };
  const cfgFrom = (v: Record<string, any>, id: string): ViewConfig => {
    const list = (s: string) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
    const fmt = fmtOf(v);
    return {
      id, layout: v.layout || 'table', format: fmt, header: fmt === 'csv' || fmt === 'tsv' ? v.header !== false : undefined, delimiter: fmt === 'csv' ? v.delimiter || undefined : undefined,
      caption: v.caption || undefined, columns: list(v.columns), style: v.style,
      sort: v.sortKey ? { key: String(v.sortKey).trim(), dir: v.sortDir === 'desc' ? 'desc' : 'asc' } : undefined,
      filter: v.filterKey ? { key: String(v.filterKey).trim(), op: v.filterOp || '=', value: v.filterValue ?? '' } : undefined,
      group: String(v.group || '').trim() || undefined, live: !!v.live,
    };
  };
  let v: Record<string, any> | null;
  if (arg && typeof arg === 'object') {
    const a: Record<string, any> = { source: arg.src ? 'site' : 'paste', file: arg.src ? resolveRef(app.active.path, arg.src) : '', text: arg.text || '', header: true, layout: o.layout || 'table', style: 'striped', ...arg };
    text = a.source === 'paste' ? a.text : app.site.read(a.file) || '';
    data = parseData(text, fmtOf(a), { header: a.header, delimiter: a.delimiter });
    v = a;
  } else {
    v = await openDialog({
      title: o.title, wide: true, preview: true, previewStyle: 'max-height:220px;overflow:auto', help: o.help, fields,
      onChange: (vals, ctl, key) => {
        if (key === 'upload') {
          const f: File | null = vals.upload;
          if (!f) { upload = null; refresh(vals, ctl); return; }
          void f.text().then((t) => { upload = { name: f.name, text: t }; refresh(ctl.values(), ctl); });
          return;
        }
        refresh(vals, ctl);
      },
      validate: (vals) => {
        if (error) return `Cannot read the data: ${error}`;
        if (!data || !data.columns.length) return 'Choose or paste some data first.';
        const cols = data.columns;
        for (const k of ['sortKey', 'filterKey', 'group']) if (vals[k] && !cols.includes(String(vals[k]).trim())) return `There is no column named "${vals[k]}". Columns: ${cols.join(', ')}`;
        if (vals.live && fmtOf(vals) === 'xml') return 'Live rendering supports CSV and JSON files; turn it off for XML.';
        if (vals.live && vals.source === 'upload' && !vals.saveCopy) return 'Live rendering needs the file in the site: turn on "Save a copy in the site".';
        return null;
      },
    });
  }
  if (!v || !data) return null;
  const cfg = cfgFrom(v, uniqueViewId(app));
  let saveAs: string | undefined;
  if (v.source === 'site' && v.file) cfg.src = rel(v.file);
  if (v.source === 'upload' && v.saveCopy && upload) {
    const u = upload as { name: string; text: string };
    saveAs = app.site.freeName('data', slugify(stripExt(u.name)), extOf(u.name) || 'csv');
    cfg.src = rel(saveAs);
  }
  if (!cfg.src) cfg.live = false;
  return { data, cfg, text, saveAs };
}

async function insertView(app: App, o: DialogOpts, arg?: any): Promise<void> {
  if (!isPage(app)) { toast('Open a page first.'); return; }
  const r = await dataDialog(app, o, arg);
  if (!r) return;
  if (r.saveAs) app.site.write(r.saveAs, r.text);
  insertHtml(app, viewMarkup(r.data, r.cfg));
  if ((r.cfg.style && r.cfg.style !== 'plain') || r.cfg.layout !== 'table') ensureCss(app);
  toast(r.cfg.src ? `Inserted ${r.data.rows.length} record(s) from ${r.cfg.src}. Refresh Data Views updates it after the file changes.` : `Inserted ${r.data.rows.length} record(s).`);
}

// ------------------------------------------------------------------------------------------
// Commands on an existing view

async function editView(app: App, title: string, build: (cfg: ViewConfig, d: Data) => Field[], apply: (cfg: ViewConfig, v: Record<string, any>) => void, plainTable?: (table: HTMLElement) => Promise<void>): Promise<void> {
  if (!needDesign(app)) return;
  const sel = selectedView(app);
  if (!sel) { toast('Click inside a data view (Insert > Data View) or a table first.'); return; }
  if (!sel.cfg) {
    if (plainTable && sel.el.tagName === 'TABLE') return plainTable(sel.el);
    toast('This table was not made from a data file. Data View makes one that can be filtered, sorted and refreshed.');
    return;
  }
  let d: Data;
  try { d = readSiteData(app, sel.cfg); } catch (e) { toast((e as Error).message); return; }
  const v = await openDialog({ title, wide: true, help: `Columns: ${d.columns.join(', ')}`, fields: build(sel.cfg, d) });
  if (!v) return;
  const cfg = { ...sel.cfg };
  apply(cfg, v);
  updateView(app, sel.el, cfg);
}

const colOptions = (d: Data) => [{ value: '', label: '(none)' }, ...d.columns.map((c) => ({ value: c, label: c }))];

async function sortPlainTable(app: App, table: HTMLElement): Promise<void> {
  const d = tableToData(table);
  if (!d.columns.length) { toast('The table has no header row to sort by.'); return; }
  const v = await openDialog({ title: 'Sort Table', fields: [
    { key: 'key', label: 'Sort by', type: 'select', value: d.columns[0], options: d.columns },
    { key: 'dir', label: 'Order', type: 'select', value: 'asc', options: [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }] },
  ] });
  if (!v) return;
  const idx = d.columns.indexOf(v.key);
  mutate(app, () => {
    for (const body of table.querySelectorAll(':scope > tbody')) {
      const rows = [...body.querySelectorAll(':scope > tr')].filter((r) => r.querySelector('td'));
      rows.sort((a, b) => compareCells(a.children[idx]?.textContent?.trim() || '', b.children[idx]?.textContent?.trim() || '') * (v.dir === 'desc' ? -1 : 1));
      for (const r of rows) body.appendChild(r);
    }
  });
}

async function conditionalPlainTable(app: App, table: HTMLElement): Promise<void> {
  const d = tableToData(table);
  const v = await openDialog({ title: 'Conditional Formatting', wide: true, help: `Columns: ${d.columns.join(', ')}. The classes are applied to the rows now; they do not update when the table changes.`, fields: [
    { key: 'rules', label: 'Rules (one per line: Column condition value => CSS declarations or .class)', type: 'textarea', rows: 6, value: table.getAttribute('data-ql-rules') || '', placeholder: 'Status = Late => background: #fde2e2; color: #8a1c1c\nPrice > 100 => .expensive' },
  ] });
  if (!v) return;
  const rules = parseRules(v.rules);
  mutate(app, () => {
    const headRow = table.querySelector('thead tr') || table.querySelector('tr');
    for (const tr of table.querySelectorAll('tr')) {
      if (tr === headRow || tr.closest('thead')) continue;
      for (const c of [...tr.classList]) if (c.startsWith('ql-cf-')) tr.classList.remove(c);
      const row = Object.fromEntries(d.columns.map((c, i) => [c, (tr.children[i]?.textContent || '').trim()]));
      for (const r of rules) if (matchOp(row[r.col] ?? '', r.op, r.value)) tr.classList.add(r.cls);
      if (!tr.classList.length) tr.removeAttribute('class');
    }
    if (rules.length) table.setAttribute('data-ql-rules', formatRules(rules)); else table.removeAttribute('data-ql-rules');
  });
  if (rules.some((r) => r.css)) ensureCss(app, rules);
}

async function refreshViews(app: App): Promise<void> {
  if (!needDesign(app)) return;
  const doc = view(app)!.design!.doc!;
  const els = [...doc.querySelectorAll('[data-ql-dataview]')];
  if (!els.length) { toast('This page has no data views to refresh.'); return; }
  const problems: string[] = [];
  let n = 0;
  mutate(app, () => {
    for (const el of els) {
      const cfg = viewCfgOf(el);
      if (!cfg) continue;
      try { regenerate(app, el, cfg, doc); n++; } catch (e) { problems.push(`${cfg.id}: ${(e as Error).message}`); }
    }
  });
  toast(problems.length ? `Refreshed ${n} view(s). ${problems.join(' ')}` : `Refreshed ${n} data view(s) from their files.`, { ms: problems.length ? 7000 : 2800 });
}

async function dataSources(app: App): Promise<void> {
  const files = dataFiles(app);
  const r = await openDialog({
    title: 'Data Sources', wide: true, ok: 'Open', help: 'Data files of this site (CSV, TSV, JSON, XML). Data views read them; edit a file and use Refresh Data Views to update the pages.',
    fields: [{ key: 'file', label: `${files.length} data file(s)`, type: 'list', rows: 8, value: files[0], options: files.length ? files : [{ value: '', label: '(none yet)' }] }],
    buttons: [
      { label: 'New CSV File', onClick: (_v, ctl) => ctl.close({ action: 'newCsv' }) },
      { label: 'New JSON File', onClick: (_v, ctl) => ctl.close({ action: 'newJson' }) },
      { label: 'Import…', onClick: (_v, ctl) => ctl.close({ action: 'import' }) },
      { label: 'Insert Data View', onClick: (v, ctl) => ctl.close({ action: 'view', file: v.file }) },
    ],
  });
  if (!r) return;
  if (r.action === 'newCsv' || r.action === 'newJson') {
    const json = r.action === 'newJson';
    const p = app.site.freeName('data', 'data', json ? 'json' : 'csv');
    app.site.write(p, json ? '[\n  { "name": "First item", "category": "General", "price": "10" },\n  { "name": "Second item", "category": "General", "price": "25" }\n]\n' : 'name,category,price\nFirst item,General,10\nSecond item,General,25\n');
    app.openFile(p);
    toast(`Created ${p}. Edit it, then insert a data view on a page.`);
    return;
  }
  if (r.action === 'import') {
    const picked = await pickFile('.csv,.tsv,.txt,.json,.xml', true);
    for (const f of picked) app.site.write(app.site.freeName('data', slugify(stripExt(f.name)), extOf(f.name) || 'csv'), await f.text());
    if (picked.length) toast(`Imported ${picked.length} file(s) into the data folder.`);
    return;
  }
  if (r.action === 'view') { if (isPage(app)) app.exec('data.dataView', r.file ? { src: relativeRef(app.active.path, r.file), prefill: true } : undefined); else toast('Open a page first.'); return; }
  if (r.file) app.openFile(r.file);
}

async function columnValue(app: App, arg?: any): Promise<void> {
  if (!isPage(app)) { toast('Open a page first.'); return; }
  const files = dataFiles(app);
  if (!files.length) { toast('The site has no data files yet; Data Sources adds one.'); return; }
  let d: Data | null = null;
  const load = (f: string) => { try { d = parseData(app.site.read(f) || '', formatOf(f)); } catch { d = null; } return d; };
  load(files[0]);
  const v = arg && typeof arg === 'object' ? arg : await openDialog({
    title: 'Column Value', help: 'Inserts one value from a data file (it is refreshed with the other data views).',
    fields: [
      { key: 'file', label: 'Data file', type: 'select', value: files[0], options: files },
      { key: 'cols', type: 'info', label: '' },
      { key: 'column', label: 'Column', type: 'text', value: (d as Data | null)?.columns[0] || '' },
      { key: 'how', label: 'Which record', type: 'radio', value: 'row', options: [{ value: 'row', label: 'By position' }, { value: 'match', label: 'The first where a column equals a value' }] },
      { key: 'row', label: 'Record number', type: 'number', value: 1, min: 1, visibleIf: (x) => x.how === 'row' },
      { key: 'matchKey', label: 'Column', type: 'text', value: '', half: true, visibleIf: (x) => x.how === 'match' },
      { key: 'matchValue', label: 'equals', type: 'text', value: '', half: true, visibleIf: (x) => x.how === 'match' },
    ],
    onChange: (x, ctl) => { const dd = load(x.file); const info = ctl.body.querySelector('.ql-info') as HTMLElement | null; if (info) info.textContent = dd ? `Columns: ${dd.columns.join(', ')} (${dd.rows.length} records)` : 'Cannot read this file.'; },
    validate: (x) => (!d ? 'Cannot read this data file.' : !(d as Data).columns.includes(String(x.column).trim()) ? `There is no column "${x.column}".` : null),
  });
  if (!v) return;
  const file = v.file || files[0];
  load(file);
  if (!d) return;
  const cfg: ViewConfig = { id: uniqueViewId(app, 'value'), src: relativeRef(app.active.path, file), format: formatOf(file), layout: 'value', column: String(v.column).trim(),
    ...(v.how === 'match' ? { match: { key: String(v.matchKey).trim(), value: String(v.matchValue ?? '') } } : { row: Math.max(1, +v.row || 1) }) };
  insertHtml(app, renderView(d, cfg));
}

async function searchForm(app: App, arg?: any): Promise<void> {
  if (!needDesign(app)) return;
  const doc = view(app)!.design!.doc!;
  const views = [...doc.querySelectorAll('[data-ql-dataview], table[id], .ql-data[id]')].filter((e) => e.id && !(viewCfgOf(e)?.layout === 'value'));
  if (!views.length) { toast('Insert a data view first (Data View); the search form filters it.'); return; }
  const v = arg && typeof arg === 'object' ? arg : await openDialog({
    title: 'Search Form', help: 'Adds a search box that shows only the records containing the typed text (in the browser; no server needed). Server database searches are not supported.',
    fields: [
      { key: 'target', label: 'Data view to search', type: 'select', value: views[0].id, options: views.map((e) => ({ value: e.id, label: `${e.id} (${e.tagName.toLowerCase()})` })) },
      { key: 'label', label: 'Label', type: 'text', value: 'Search' },
    ],
  });
  if (!v) return;
  const n = uniqueViewId(app, 'search');
  const status = `${n}_status`;
  insertHtml(app, `<form role="search" class="ql-data-search" action="#">\n<p><label for="${n}">${esc(v.label || 'Search')}</label> <input type="search" id="${n}" name="q" aria-controls="${escAttr(v.target)}"> <span id="${status}" role="status" aria-live="polite"></span></p>\n</form>\n<script id="ql-search-${n}">\n${searchScript(n, v.target, status)}\n</script>`);
}

// ------------------------------------------------------------------------------------------

const LEGACY = 'Server databases (Access, ODBC, SQL Server) are not supported: export the table to CSV or JSON, add the file to the site, and the results are generated from it.';

def([
  { id: 'data.fromCsv', label: 'Table from CSV', icon: 'table_view', tab: 'Insert', group: 'Data', edits: true, popular: true, origin: 'FrontPage (Import Spreadsheet), Dreamweaver (Import Tabular Data)', isEnabled: isPage,
    keywords: 'csv tsv spreadsheet import tabular data table', tip: 'Insert an accessible table from CSV or TSV data.',
    run: (app, arg) => insertView(app, { title: 'Insert Table from CSV', paste: true, kinds: /\.(csv|tsv|tab|txt)$/i, layout: 'table', format: 'csv', query: false }, arg) },
  { id: 'data.fromJson', label: 'Data from JSON', icon: 'data_object', tab: 'Insert', group: 'Data', edits: true, origin: 'Dreamweaver (Spry data sets)', isEnabled: isPage,
    keywords: 'json table cards list fetch live', tip: 'Insert a table, list or cards from JSON (optionally rendered live from the site file).',
    run: (app, arg) => insertView(app, { title: 'Insert Data from JSON', paste: true, kinds: /\.json$/i, layout: 'table', format: 'json', query: false }, arg) },
  { id: 'data.dataView', label: 'Data View', icon: 'view_list', tab: 'Insert', group: 'Data', edits: true, origin: 'Expression Web, SharePoint Designer (Data View)', isEnabled: isPage,
    keywords: 'data view csv json xml sort filter group table cards list', tip: 'Show a site data file as a table, list or cards, sorted, filtered and grouped.',
    run: (app, arg) => insertView(app, { title: 'Insert Data View', paste: false, kinds: DATA_EXT, layout: 'table' }, arg) },
  { id: 'data.insertResults', label: 'Database Results', icon: 'database', tab: 'Insert', group: 'Data', edits: true, origin: 'FrontPage (Database Results Wizard)', isEnabled: isPage,
    keywords: 'database results wizard odbc access', tip: 'Database results generated from a CSV or JSON file.',
    run: (app, arg) => insertView(app, { title: 'Database Results', paste: false, kinds: DATA_EXT, layout: 'table', note: LEGACY }, arg) },
  { id: 'data.columnValue', label: 'Column Value', icon: 'data_array', tab: 'Insert', group: 'Data', edits: true, origin: 'FrontPage (Database Column Value)', isEnabled: isPage,
    tip: 'Insert one value from a data file.', run: (app, arg) => columnValue(app, arg) },
  { id: 'data.searchForm', label: 'Search Form', icon: 'manage_search', tab: 'Insert', group: 'Data', edits: true, origin: 'FrontPage (Database Search Form)', isEnabled: isPage,
    tip: 'A search box that filters a data view in the browser.', run: (app, arg) => searchForm(app, arg) },
  { id: 'data.dataSources', label: 'Data Sources', icon: 'source', tab: 'Insert', group: 'Data', noRecord: true, origin: 'Expression Web (Data Source Library), FrontPage', isEnabled: (app) => !!app.site,
    tip: 'Data files of the site: open, create, import.', run: (app) => dataSources(app) },
  { id: 'data.findSource', label: 'Find Data Source', icon: 'find_in_page', tab: 'Insert', group: 'Data', noRecord: true, origin: 'Expression Web (Find Data Source)', isEnabled: isPage,
    tip: 'Open the data file of the selected data view.',
    run: (app) => {
      const sel = isPage(app) && view(app)?.design?.doc ? selectedView(app) : null;
      if (!sel?.cfg?.src) { toast('Click inside a data view made from a site file; here are the data sources of the site.'); return dataSources(app); }
      const p = resolveRef(app.active.path, sel.cfg.src);
      if (p && app.site.has(p)) app.openFile(p); else toast(`The data file ${sel.cfg.src} is not in the site.`);
    } },
  { id: 'data.style', label: 'Data View Style', icon: 'style', tab: 'Insert', group: 'Data', edits: true, origin: 'Expression Web (Data View Style)', isEnabled: isPage,
    tip: 'Layout and look of the selected data view or table.',
    run: (app) => editView(app, 'Data View Style',
      (cfg) => [
        { key: 'layout', label: 'Layout', type: 'select', value: cfg.layout === 'value' ? 'table' : cfg.layout, options: LAYOUTS },
        { key: 'style', label: 'Style', type: 'select', value: cfg.style || 'plain', options: STYLES },
        { key: 'caption', label: 'Caption', type: 'text', value: cfg.caption || '' },
        { key: 'columns', label: 'Columns to show, in order (comma-separated; empty: all)', type: 'text', value: (cfg.columns || []).join(', ') },
        { key: 'live', label: 'Render the file again when the published page loads', type: 'checkbox', value: !!cfg.live },
      ],
      (cfg, v) => { cfg.layout = v.layout; cfg.style = v.style; cfg.caption = v.caption || undefined; cfg.columns = String(v.columns || '').split(',').map((s) => s.trim()).filter(Boolean); cfg.live = !!v.live; },
      async (table) => {
        const v = await openDialog({ title: 'Table Style', fields: [{ key: 'style', label: 'Style', type: 'select', value: [...table.classList].find((c) => /^ql-data-(grid|striped|compact)$/.test(c))?.slice(8) || 'plain', options: STYLES }] });
        if (!v) return;
        mutate(app, () => { table.classList.remove('ql-data-grid', 'ql-data-striped', 'ql-data-compact'); table.classList.add('ql-data'); if (v.style !== 'plain') table.classList.add(`ql-data-${v.style}`); });
        ensureCss(app);
      }) },
  { id: 'data.filter', label: 'Filter', icon: 'filter_alt', tab: 'Insert', group: 'Data', edits: true, origin: 'Expression Web (Data View Filter)', isEnabled: isPage,
    tip: 'Show only the records that meet a condition.',
    run: (app) => editView(app, 'Filter Data View',
      (cfg, d) => [
        { key: 'key', label: 'Show only rows where column', type: 'select', value: cfg.filter?.key || '', options: colOptions(d) },
        { key: 'op', label: 'Condition', type: 'select', value: cfg.filter?.op || '=', options: OPS },
        { key: 'value', label: 'Value', type: 'text', value: cfg.filter?.value ?? '' },
      ],
      (cfg, v) => { cfg.filter = v.key ? { key: v.key, op: v.op, value: v.value ?? '' } : undefined; }) },
  { id: 'data.sortGroup', label: 'Sort and Group', icon: 'sort', tab: 'Insert', group: 'Data', edits: true, origin: 'Expression Web (Data View Sort and Group)', isEnabled: isPage,
    tip: 'Order and group the records of the selected data view (or sort a table).',
    run: (app) => editView(app, 'Sort and Group',
      (cfg, d) => [
        { key: 'sortKey', label: 'Sort by', type: 'select', value: cfg.sort?.key || '', options: colOptions(d) },
        { key: 'sortDir', label: 'Order', type: 'select', value: cfg.sort?.dir || 'asc', options: [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }] },
        { key: 'group', label: 'Group by', type: 'select', value: cfg.group || '', options: colOptions(d) },
      ],
      (cfg, v) => { cfg.sort = v.sortKey ? { key: v.sortKey, dir: v.sortDir } : undefined; cfg.group = v.group || undefined; },
      (table) => sortPlainTable(app, table)) },
  { id: 'data.conditional', label: 'Conditional Formatting', icon: 'format_color_fill', tab: 'Insert', group: 'Data', edits: true, origin: 'Expression Web, SharePoint Designer (Conditional Formatting)', isEnabled: isPage,
    tip: 'Format records that meet conditions (CSS classes).',
    run: (app) => editView(app, 'Conditional Formatting',
      (cfg) => [{ key: 'rules', label: 'Rules (one per line: Column condition value => CSS declarations or .class). Conditions: = != > < >= <= contains !contains starts empty !empty', type: 'textarea', rows: 7, value: formatRules(cfg.rules), placeholder: 'Status = Late => background: #fde2e2; color: #8a1c1c\nPrice > 100 => .expensive' }],
      (cfg, v) => { cfg.rules = parseRules(v.rules); },
      (table) => conditionalPlainTable(app, table)) },
  { id: 'data.refresh', label: 'Refresh Data Views', icon: 'refresh', tab: 'Insert', group: 'Data', edits: true, origin: 'Expression Web, FrontPage (Update Database Results)', isEnabled: isPage,
    tip: 'Regenerate every data view of the page from its file.', run: (app) => refreshViews(app) },
]);
