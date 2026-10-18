/**
 * Table commands: insert and draw tables, rows, columns and cells, merge and split, sizing, fill, sort,
 * conversions (text, CSS grid, positioned boxes), properties, borders and table styles.
 *
 * Structural edits use the logical grid in model/tableGrid.ts so rowspan and colspan stay consistent.
 * A cell range is the rectangle between the anchor and focus cells of a selection dragged across cells,
 * or the rectangle stored by Select Row / Select Column / Select Cell (shown with a highlight).
 */
import { def, type MenuEntry } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog, type DialogControl } from '../ui/dialog';
import { h, pickFile } from '../ui/dom';
import {
  view, isPage, selectedEl, insertHtml, mutate, setStyleProp, styleOf, selectionHtml, replaceElement, inCode,
} from '../editor/ops';
import { restoreOriginals } from '../editor/resources';
import { renameElement } from '../editor/designView';
import {
  TableGrid, rowCells, ownRows, tableMarkup, parseDelimited, guessSeparator, padRows, sortOrder, detectSortType,
  tableToGridMarkup, boxesToTable, type CellRect, type GridCell, type TableSpec, type SortType, type Box,
} from '../model/tableGrid';
import { editHeadStyle, esc } from '../model/html';
import { decodeEntities } from '../model/site';
import { extOf } from '../model/paths';

// ------------------------------------------------------------------------------------------
// Selection

const UI = 'data-ql-ui';

/** The cell holding the caret (or the first cell of a selected row, section or table). */
export function cellOf(app: App): HTMLTableCellElement | null {
  const el = selectedEl(app);
  if (!el) return null;
  const c = el.closest('td,th');
  if (c) return c as HTMLTableCellElement;
  if (el.tagName === 'TR') return rowCells(el)[0] || null;
  if (/^(TABLE|THEAD|TBODY|TFOOT)$/.test(el.tagName)) return el.querySelector('td,th');
  return null;
}

export function tableOf(app: App): HTMLTableElement | null {
  const c = cellOf(app);
  if (c) return c.closest('table');
  return (selectedEl(app)?.closest('table') as HTMLTableElement) || null;
}

const inTable = (app: App) => isPage(app) && !!tableOf(app);
const inCell = (app: App) => isPage(app) && !!cellOf(app);

interface Sel { table: HTMLTableElement; grid: TableGrid; cell: HTMLTableCellElement; g: GridCell; rect: CellRect; multi: boolean }

let stored: { table: HTMLTableElement; rect: CellRect } | null = null;
const watched = new WeakSet<Document>();

function cellAtBoundary(node: Node, offset: number, end: boolean): HTMLTableCellElement | null {
  let n: Node | null = node;
  if (n.nodeType === 1 && !(n as Element).closest('td,th')) {
    const kids = n.childNodes;
    n = kids[Math.min(end ? offset - 1 : offset, kids.length - 1)] || n;
  }
  const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
  return (el?.closest('td,th') as HTMLTableCellElement) || null;
}

/** The table, its grid, the caret's cell and the selected cell rectangle. */
function selection(app: App): Sel | null {
  const cell = cellOf(app);
  if (!cell) return null;
  const table = cell.closest('table') as HTMLTableElement;
  const grid = new TableGrid(table);
  const g = grid.find(cell);
  if (!g) return null;
  const within = (r: CellRect) => g.row >= r.r1 && g.row <= r.r2 && g.col >= r.c1 && g.col <= r.c2;
  if (stored && stored.table === table && table.isConnected && within(stored.rect)) {
    const rect = grid.expand(stored.rect);
    return { table, grid, cell, g, rect, multi: grid.cellsIn(rect).length > 1 };
  }
  const doc = view(app)?.design?.doc;
  const range = doc?.getSelection()?.rangeCount ? doc.getSelection()!.getRangeAt(0) : null;
  if (range && !range.collapsed) {
    const a = cellAtBoundary(range.startContainer, range.startOffset, false);
    const b = cellAtBoundary(range.endContainer, range.endOffset, true);
    const ga = a && a.closest('table') === table ? grid.find(a) : null;
    const gb = b && b.closest('table') === table ? grid.find(b) : null;
    if (ga && gb && ga !== gb) {
      const rect = grid.rectOf(ga, gb);
      return { table, grid, cell, g, rect, multi: true };
    }
  }
  return { table, grid, cell, g, rect: grid.rectOf(g), multi: false };
}

function clearHighlight(doc?: Document | null): void {
  doc?.querySelectorAll('[data-ql-cellsel]').forEach((e) => e.remove());
}

function clearSel(app: App): void {
  stored = null;
  clearHighlight(view(app)?.design?.doc);
}

/** Stores a cell rectangle as the selection and shows it. */
function setRange(app: App, table: HTMLTableElement, rect: CellRect): void {
  const doc = table.ownerDocument;
  stored = { table, rect };
  clearHighlight(doc);
  const grid = new TableGrid(table);
  const win = doc.defaultView;
  let box: DOMRect | null = null;
  for (const g of grid.cellsIn(rect)) {
    const r = g.el.getBoundingClientRect();
    box = box ? new DOMRect(Math.min(box.left, r.left), Math.min(box.top, r.top), Math.max(box.right, r.right) - Math.min(box.left, r.left), Math.max(box.bottom, r.bottom) - Math.min(box.top, r.top)) : r;
  }
  if (box && win) {
    const hl = doc.createElement('div');
    hl.setAttribute(UI, '');
    hl.setAttribute('data-ql-cellsel', '');
    hl.style.cssText = `position:absolute;pointer-events:none;z-index:2147483645;background:rgba(43,121,214,.18);outline:2px solid rgba(43,121,214,.7);left:${box.left + win.scrollX}px;top:${box.top + win.scrollY}px;width:${box.width}px;height:${box.height}px`;
    doc.documentElement.appendChild(hl);
  }
  if (!watched.has(doc)) {
    watched.add(doc);
    doc.addEventListener('selectionchange', () => {
      if (!stored || stored.table.ownerDocument !== doc) return;
      const sel = doc.getSelection();
      const n = sel?.anchorNode;
      let c: Element | null = n ? cellAtBoundary(n, sel!.anchorOffset, false) : null;
      if (!c && n) {
        // A selected row (the selection is around the tr element) counts as its first cell.
        const el = n.nodeType === 1 ? (n as Element).childNodes[sel!.anchorOffset] as Element | undefined : undefined;
        if (el?.tagName === 'TR') c = rowCells(el)[0] || null;
      }
      const g = c && c.closest('table') === stored.table ? new TableGrid(stored.table).find(c) : null;
      const r = stored.rect;
      if (!g || g.row < r.r1 || g.row > r.r2 || g.col < r.c1 || g.col > r.c2) { stored = null; clearHighlight(doc); }
    });
  }
}

/** Places the caret at the start of a cell. */
function caretIn(app: App, el: Element | null | undefined): void {
  const d = view(app)?.design;
  if (!d?.doc || !el?.isConnected) return;
  d.select(el, { contents: true });
  try { d.doc.getSelection()?.collapseToStart(); } catch { /* */ }
}

/** True when the Design view is showing; otherwise switches to Split view and explains (via mutate). */
function designReady(app: App): boolean {
  const v = view(app);
  if (v?.design?.doc && (v.tab.view === 'design' || v.tab.view === 'split')) return true;
  mutate(app, () => undefined);
  return false;
}

/** Runs a table edit on the current selection as one undo step. */
function tableOp(app: App, fn: (s: Sel, doc: Document) => void): boolean {
  if (!designReady(app)) return false;
  const s = selection(app);
  if (!s) { toast('Put the cursor in a table cell first.'); return false; }
  clearSel(app);
  return mutate(app, (doc) => fn(s, doc));
}

function tableOnly(app: App, fn: (t: HTMLTableElement, doc: Document) => void): boolean {
  if (!designReady(app)) return false;
  const t = tableOf(app);
  if (!t) { toast('Put the cursor in a table first.'); return false; }
  clearSel(app);
  return mutate(app, (doc) => fn(t, doc));
}

// ------------------------------------------------------------------------------------------
// Style helpers

const useAttrs = (app: App) => app.prefs.cssMode === 'tags';

/** Sets a size (width/height) as CSS or as an attribute, per the style application mode. */
function setDim(app: App, el: HTMLElement, prop: 'width' | 'height', value: string | null): void {
  if (useAttrs(app) && !/^(TR)$/.test(el.tagName) && (value == null || /^\d+(\.\d+)?(px|%)?$/.test(value))) {
    setStyleProp(app, el, prop, null);
    if (value == null) el.removeAttribute(prop); else el.setAttribute(prop, value.replace(/px$/, ''));
  } else {
    el.removeAttribute(prop);
    setStyleProp(app, el, prop, value);
  }
}

/** A CSS property value from an element's style attribute. */
function cssOf(el: Element, prop: string): string {
  const tmp = document.createElement('div');
  tmp.setAttribute('style', styleOf(el));
  return tmp.style.getPropertyValue(prop);
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Adds or replaces one rule in CSS text. */
export function upsertRule(css: string, selector: string, decls: string): string {
  const re = new RegExp(`(^|\\n)[ \\t]*${escRe(selector)}\\s*\\{[^}]*\\}[ \\t]*`, '');
  const rule = `    ${selector} { ${decls} }`;
  if (re.test(css)) return css.replace(re, (m, lead) => `${lead}${rule}`);
  return css.replace(/\s*$/, '') + '\n' + rule + '\n  ';
}

/** Adds CSS rules to the page's head style block (once per selector). */
function addHeadRules(app: App, label: string, rules: [string, string][], replace = false): void {
  app.editSource(label, (src) => editHeadStyle(src, (css) => {
    let out = css;
    for (const [sel, decls] of rules) {
      if (!replace && new RegExp(`(^|[\\s,}])${escRe(sel)}\\s*\\{`).test(out)) continue;
      out = upsertRule(out, sel, decls);
    }
    return out;
  }));
}

/** A stable id for a table, created when it has none. */
function ensureId(table: HTMLTableElement): string {
  if (table.id) return table.id;
  const doc = table.ownerDocument;
  let i = 1;
  while (doc.getElementById(`table${i}`)) i++;
  table.id = `table${i}`;
  return table.id;
}

// ------------------------------------------------------------------------------------------
// Insert

function insertTableDialog(app: App, init: Partial<TableSpec> = {}): Promise<TableSpec | null> {
  const attrs = useAttrs(app);
  return openDialog({
    title: 'Insert Table',
    fields: [
      { key: 'heading1', type: 'heading', label: 'Size' },
      { key: 'rows', label: 'Rows', type: 'number', value: init.rows ?? 3, min: 1, max: 500, half: true, autofocus: true },
      { key: 'cols', label: 'Columns', type: 'number', value: init.cols ?? 3, min: 1, max: 100, half: true },
      { key: 'width', label: 'Width', type: 'number', value: 100, min: 0, half: true, help: 'Leave empty to fit the contents.' },
      { key: 'unit', label: 'Unit', type: 'select', value: '%', options: [{ value: '%', label: 'Percent' }, { value: 'px', label: 'Pixels' }], half: true },
      { key: 'heading2', type: 'heading', label: 'Borders and spacing' },
      { key: 'border', label: 'Border width', type: 'number', value: 1, min: 0, suffix: 'px', half: true },
      { key: 'padding', label: 'Cell padding', type: 'number', value: 4, min: 0, suffix: 'px', half: true },
      { key: 'spacing', label: 'Cell spacing', type: 'number', value: 0, min: 0, suffix: 'px', half: true, help: '0 collapses the borders.' },
      { key: 'styleMode', label: 'Write as', type: 'select', value: attrs ? 'attrs' : 'css', half: true, options: [{ value: 'css', label: 'CSS styles' }, { value: 'attrs', label: 'HTML attributes (legacy)' }] },
      { key: 'heading3', type: 'heading', label: 'Accessibility' },
      { key: 'headerRow', label: 'First row is a header row', type: 'checkbox', value: init.headerRow ?? true, half: true },
      { key: 'headerCol', label: 'First column is a header column', type: 'checkbox', value: !!init.headerCol, half: true },
      { key: 'caption', label: 'Caption', type: 'text', value: init.caption || '', placeholder: 'A short title shown with the table' },
      { key: 'description', label: 'Summary', type: 'textarea', rows: 2, value: '', placeholder: 'Optional: describes the table for screen reader users (linked with aria-describedby)' },
    ],
    validate: (v) => (!v.rows || !v.cols ? 'A table needs at least one row and one column.' : null),
  }).then((v) => v && ({
    rows: v.rows, cols: v.cols, width: v.width ? `${v.width}${v.unit}` : undefined, border: v.border ?? 0, padding: v.padding ?? 0, spacing: v.spacing ?? 0,
    headerRow: v.headerRow, headerCol: v.headerCol, caption: v.caption.trim() || undefined, description: v.description.trim() || undefined, styleMode: v.styleMode,
  }));
}

/** A grid of squares: point to choose a size, click to insert. */
function gridPicker(): Promise<{ rows: number; cols: number } | null> {
  const R = 10, C = 12;
  let chosen: { rows: number; cols: number } | null = null;
  let ctl: DialogControl | null = null;
  const label = h('div', { class: 'ql-help', 'aria-live': 'polite' }, 'Point to a size, then click. Arrow keys move between squares.');
  const grid = h('div', { role: 'grid', 'aria-label': 'Table size', style: `display:grid;grid-template-columns:repeat(${C},22px);gap:3px;margin:8px 0;user-select:none` });
  const btns: HTMLButtonElement[] = [];
  const show = (r: number, c: number) => {
    btns.forEach((b, i) => { const on = Math.floor(i / C) < r && (i % C) < c; b.style.background = on ? 'rgba(43,121,214,.55)' : 'transparent'; });
    label.textContent = `${r} × ${c} table`;
  };
  for (let r = 1; r <= R; r++) for (let c = 1; c <= C; c++) {
    const b = h('button', { type: 'button', 'aria-label': `${r} rows by ${c} columns`, style: 'width:22px;height:22px;border:1px solid #8aa0b8;border-radius:2px;padding:0;background:transparent;cursor:pointer' }) as HTMLButtonElement;
    b.addEventListener('mouseenter', () => show(r, c));
    b.addEventListener('focus', () => show(r, c));
    b.addEventListener('click', () => { chosen = { rows: r, cols: c }; ctl?.close({}); });
    b.addEventListener('keydown', (e) => {
      const i = (r - 1) * C + (c - 1);
      const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowDown' ? i + C : e.key === 'ArrowUp' ? i - C : -1;
      if (to >= 0 && to < btns.length && e.key.startsWith('Arrow')) { e.preventDefault(); btns[to].focus(); }
    });
    btns.push(b);
    grid.appendChild(b);
  }
  const wrap = h('div', null, grid, label);
  return openDialog({ title: 'Draw Table', content: wrap, ok: false, onOpen: (c) => { ctl = c; setTimeout(() => btns[0].focus(), 40); } }).then(() => chosen);
}

const LAYOUTS: { id: string; label: string; css: string; areas: [string, string, string][] }[] = [
  { id: 'hscf', label: 'Header, sidebar, content, footer', css: 'grid-template-columns: 220px 1fr; grid-template-areas: "header header" "nav main" "footer footer"', areas: [['header', 'header', 'Header'], ['nav', 'nav', 'Navigation'], ['main', 'main', 'Main content'], ['footer', 'footer', 'Footer']] },
  { id: 'hcsf', label: 'Header, content, sidebar on the right, footer', css: 'grid-template-columns: 1fr 260px; grid-template-areas: "header header" "main aside" "footer footer"', areas: [['header', 'header', 'Header'], ['main', 'main', 'Main content'], ['aside', 'aside', 'Sidebar'], ['footer', 'footer', 'Footer']] },
  { id: 'hcf', label: 'Header, content, footer', css: 'grid-template-columns: 1fr; grid-template-areas: "header" "main" "footer"', areas: [['header', 'header', 'Header'], ['main', 'main', 'Main content'], ['footer', 'footer', 'Footer']] },
  { id: 'holy', label: 'Header, two sidebars, content, footer', css: 'grid-template-columns: 200px 1fr 200px; grid-template-areas: "header header header" "nav main aside" "footer footer footer"', areas: [['header', 'header', 'Header'], ['nav', 'nav', 'Navigation'], ['main', 'main', 'Main content'], ['aside', 'aside', 'Sidebar'], ['footer', 'footer', 'Footer']] },
  { id: 'two', label: 'Two equal columns', css: 'grid-template-columns: 1fr 1fr; grid-template-areas: "a b"', areas: [['section', 'a', 'Column 1'], ['section', 'b', 'Column 2']] },
  { id: 'three', label: 'Three equal columns', css: 'grid-template-columns: repeat(3, 1fr); grid-template-areas: "a b c"', areas: [['section', 'a', 'Column 1'], ['section', 'b', 'Column 2'], ['section', 'c', 'Column 3']] },
];

/** Page layout markup: a CSS grid of semantic sections, or a legacy layout table. */
export function layoutMarkup(id: string, legacy: boolean): string {
  const l = LAYOUTS.find((x) => x.id === id) || LAYOUTS[0];
  if (legacy) {
    // Rows of the grid template areas become table rows; repeated area names become colspans.
    const rowsSpec = [...l.css.matchAll(/"([^"]+)"/g)].map((m) => m[1].split(/\s+/));
    const seen = new Set<string>();
    const rows = rowsSpec.map((names) => {
      const cells: string[] = [];
      for (let i = 0; i < names.length;) {
        let j = i; while (j < names.length && names[j] === names[i]) j++;
        const name = names[i];
        const area = l.areas.find((a) => a[1] === name);
        if (!seen.has(name)) cells.push(`<td${j - i > 1 ? ` colspan="${j - i}"` : ''} style="vertical-align: top; padding: 8px">${esc(area?.[2] || name)}</td>`);
        seen.add(name);
        i = j;
      }
      return `  <tr>${cells.join('')}</tr>`;
    });
    return `<table role="presentation" style="width: 100%; border-collapse: collapse">\n${rows.join('\n')}\n</table>`;
  }
  const kids = l.areas.map(([tag, area, text]) => `  <${tag} style="grid-area: ${area}; padding: 8px">\n    <p>${esc(text)}</p>\n  </${tag}>`).join('\n');
  return `<div class="page-layout" style="display: grid; gap: 16px; ${l.css}">\n${kids}\n</div>`;
}

// ------------------------------------------------------------------------------------------
// Text helpers

/** Plain lines of a selection's HTML, keeping tabs. */
function htmlLines(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|pre|blockquote)>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, '')).replace(/\t\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

const SEPS: Record<string, string> = { tab: '\t', comma: ',', semicolon: ';', pipe: '|' };
const sepName = (s: string) => Object.entries(SEPS).find(([, v]) => v === s)?.[0] || 'comma';

async function tabularDialog(title: string, text: string, opts: { allowParagraphs?: boolean } = {}): Promise<{ rows: string[][]; header: boolean } | null> {
  const guess = sepName(guessSeparator(text));
  const options = [{ value: 'tab', label: 'Tabs' }, { value: 'comma', label: 'Commas' }, { value: 'semicolon', label: 'Semicolons' }, { value: 'pipe', label: 'Vertical bars' }, ...(opts.allowParagraphs ? [{ value: 'paragraphs', label: 'Paragraphs (one cell each)' }] : []), { value: 'custom', label: 'Other' }];
  const rowsOf = (v: Record<string, any>): string[][] => {
    if (v.sep === 'paragraphs') {
      const items = text.split('\n').map((s) => s.trim()).filter(Boolean);
      const n = Math.max(1, v.cols || 1);
      const out: string[][] = [];
      for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
      return padRows(out);
    }
    const sep = v.sep === 'custom' ? v.custom || ',' : SEPS[v.sep];
    return padRows(parseDelimited(text, sep));
  };
  const info = (v: Record<string, any>) => { const r = rowsOf(v); return `${r.length} rows × ${r[0]?.length || 0} columns`; };
  const v = await openDialog({
    title,
    fields: [
      { key: 'sep', label: 'Separate cells at', type: 'radio', value: guess, options },
      { key: 'custom', label: 'Other separator', type: 'text', value: '', visibleIf: (x) => x.sep === 'custom', half: true },
      { key: 'cols', label: 'Columns', type: 'number', value: 2, min: 1, visibleIf: (x) => x.sep === 'paragraphs', half: true },
      { key: 'header', label: 'First row is a header row', type: 'checkbox', value: true },
      { key: 'size', type: 'info', label: info({ sep: guess, cols: 2 }) },
    ],
    onChange: (vals, ctl) => { const el = ctl.body.querySelector('.ql-info'); if (el) el.textContent = info(vals); },
  });
  if (!v) return null;
  const rows = rowsOf(v);
  if (!rows.length) { toast('There is no text to put in a table.'); return null; }
  return { rows, header: !!v.header };
}

// ------------------------------------------------------------------------------------------
// Table styles

interface TStyle { id: string; label: string; head: string; headText: string; line: string; stripe?: string; outer?: string; font?: string }
const STYLES: TStyle[] = [
  { id: 'lines', label: 'Simple Lines', head: 'transparent', headText: 'inherit', line: '#9aa5b1' },
  { id: 'ledger', label: 'Ledger', head: '#e8efe3', headText: '#22351c', line: '#c6d4bd', stripe: '#f5f8f2' },
  { id: 'ocean', label: 'Ocean', head: '#1f5f8b', headText: '#ffffff', line: '#b9d3e6', stripe: '#eef5fa' },
  { id: 'forest', label: 'Forest', head: '#2e6b3f', headText: '#ffffff', line: '#bcd8c3', stripe: '#eff6f0' },
  { id: 'slate', label: 'Slate', head: '#3c4650', headText: '#ffffff', line: '#c3c9cf', stripe: '#f1f3f5' },
  { id: 'sunrise', label: 'Sunrise', head: '#c8571b', headText: '#ffffff', line: '#f0c9ae', stripe: '#fdf3ec' },
  { id: 'grid', label: 'Full Grid', head: '#f0f0f0', headText: '#111111', line: '#7f7f7f', outer: '#7f7f7f' },
  { id: 'minimal', label: 'Minimal', head: 'transparent', headText: 'inherit', line: 'transparent', stripe: '#f6f6f6' },
  { id: 'contrast', label: 'High Contrast', head: '#000000', headText: '#ffffff', line: '#000000', outer: '#000000' },
  { id: 'paper', label: 'Paper', head: '#fbf6e9', headText: '#4a3b18', line: '#e2d6b5', stripe: '#fffdf6', font: 'Georgia, serif' },
  { id: 'berry', label: 'Berry', head: '#7b2a5c', headText: '#ffffff', line: '#e2bfd4', stripe: '#faf0f6' },
  { id: 'steel', label: 'Steel', head: '#5d7285', headText: '#ffffff', line: '#cdd6de', outer: '#5d7285', stripe: '#f2f5f8' },
];

function styleRules(s: TStyle): [string, string][] {
  const c = `table.qlt-${s.id}`;
  const rules: [string, string][] = [
    [c, `border-collapse: collapse; ${s.outer ? `border: 2px solid ${s.outer};` : ''}${s.font ? ` font-family: ${s.font};` : ''}`.trim()],
    [`${c} th, ${c} td`, `padding: 6px 10px; border: 1px solid ${s.line}; text-align: left`],
    [`${c} thead th, ${c} tr:first-child > th`, `background-color: ${s.head}; color: ${s.headText}; font-weight: bold`],
  ];
  if (s.id === 'lines' || s.id === 'minimal') rules[1][1] = `padding: 6px 10px; border: 0; border-bottom: 1px solid ${s.line === 'transparent' ? '#e3e3e3' : s.line}; text-align: left`;
  if (s.stripe) rules.push([`${c} tbody tr:nth-child(even) > td`, `background-color: ${s.stripe}`]);
  return rules;
}

function applyStyle(app: App, id: string): void {
  const s = STYLES.find((x) => x.id === id);
  if (!tableOnly(app, (t) => {
    for (const c of [...t.classList]) if (/^qlt-(?!striped)/.test(c)) t.classList.remove(c);
    if (s) t.classList.add(`qlt-${s.id}`);
  })) return;
  if (s) addHeadRules(app, 'Table Style', styleRules(s));
}

const STRIPE_RULE: [string, string] = ['table.qlt-striped > tbody > tr:nth-child(even) > *', 'background-color: #f2f5f9'];

// ------------------------------------------------------------------------------------------
// Borders

const BORDER_OPTS: { id: string; label: string; icon: string }[] = [
  { id: 'all', label: 'All Borders', icon: 'border_all' },
  { id: 'outside', label: 'Outside Borders', icon: 'border_outer' },
  { id: 'inside', label: 'Inside Borders', icon: 'border_inner' },
  { id: 'horizontal', label: 'Horizontal Lines Only', icon: 'border_horizontal' },
  { id: 'vertical', label: 'Vertical Lines Only', icon: 'border_vertical' },
  { id: 'none', label: 'No Borders', icon: 'border_clear' },
  { id: 'top', label: 'Top Border (Selected Cells)', icon: 'border_top' },
  { id: 'bottom', label: 'Bottom Border (Selected Cells)', icon: 'border_bottom' },
  { id: 'left', label: 'Left Border (Selected Cells)', icon: 'border_left' },
  { id: 'right', label: 'Right Border (Selected Cells)', icon: 'border_right' },
];
const SIDES = ['border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-style', 'border-width', 'border-color'];

function applyBorders(app: App, kind: string, line = '1px solid #808080'): void {
  tableOp(app, (s) => {
    const t = s.table;
    const cells = /^(top|bottom|left|right)$/.test(kind) ? s.grid.cellsIn(s.rect).map((g) => g.el) : s.grid.cells.map((g) => g.el);
    if (/^(top|bottom|left|right)$/.test(kind)) {
      setStyleProp(app, t, 'border-collapse', 'collapse');
      for (const c of cells) setStyleProp(app, c, `border-${kind}`, line);
      return;
    }
    for (const a of ['border', 'frame', 'rules']) t.removeAttribute(a);
    for (const p of SIDES) setStyleProp(app, t, p, null);
    for (const c of cells) for (const p of SIDES) setStyleProp(app, c, p, null);
    if (useAttrs(app) && (kind === 'all' || kind === 'none')) { t.setAttribute('border', kind === 'all' ? '1' : '0'); return; }
    setStyleProp(app, t, 'border-collapse', 'collapse');
    if (kind === 'all' || kind === 'outside') setStyleProp(app, t, 'border', line);
    if (kind === 'inside' || kind === 'horizontal' || kind === 'vertical') setStyleProp(app, t, 'border-style', 'hidden');
    for (const c of cells) {
      if (kind === 'all' || kind === 'inside') setStyleProp(app, c, 'border', line);
      if (kind === 'horizontal') { setStyleProp(app, c, 'border-top', line); setStyleProp(app, c, 'border-bottom', line); }
      if (kind === 'vertical') { setStyleProp(app, c, 'border-left', line); setStyleProp(app, c, 'border-right', line); }
    }
  });
}

// ------------------------------------------------------------------------------------------
// Properties dialogs

function parseLen(v: string): { n: number | null; unit: string } {
  const m = /^\s*([\d.]+)\s*(px|%|em|rem)?\s*$/.exec(v || '');
  return m ? { n: parseFloat(m[1]), unit: m[2] || 'px' } : { n: null, unit: '%' };
}

async function tableProperties(app: App, arg?: Record<string, any>): Promise<void> {
  if (!designReady(app)) return;
  const t = tableOf(app);
  if (!t) { toast('Put the cursor in a table first.'); return; }
  const firstCell = t.querySelector('td,th');
  const w = parseLen(cssOf(t, 'width') || t.getAttribute('width') || '');
  const float = cssOf(t, 'float');
  const align = float === 'left' || float === 'right' ? float : cssOf(t, 'margin-left') === 'auto' && cssOf(t, 'margin-right') === 'auto' ? 'center' : t.getAttribute('align') || 'default';
  const bw = parseLen(cssOf(t, 'border-width') || t.getAttribute('border') || '').n;
  const cap = t.querySelector(':scope > caption');
  const init = {
    width: w.n, unit: w.unit === '%' ? '%' : 'px', align,
    border: bw ?? 0, borderStyle: cssOf(t, 'border-style') || 'solid', borderColor: cssOf(t, 'border-color') || '#808080',
    padding: parseLen(firstCell ? cssOf(firstCell, 'padding') : '').n ?? (t.getAttribute('cellpadding') != null ? +t.getAttribute('cellpadding')! : null),
    spacing: parseLen(cssOf(t, 'border-spacing')).n ?? (t.getAttribute('cellspacing') != null ? +t.getAttribute('cellspacing')! : null),
    collapse: cssOf(t, 'border-collapse') === 'collapse',
    bg: cssOf(t, 'background-color') || t.getAttribute('bgcolor') || '', useBg: !!(cssOf(t, 'background-color') || t.getAttribute('bgcolor')),
    layout: cssOf(t, 'table-layout') || 'auto', captionSide: cap ? cssOf(cap, 'caption-side') || 'top' : 'top',
    id: t.id, cls: (t.getAttribute('class') || '').trim(),
  };
  const v = arg || await openDialog({
    title: 'Table Properties', wide: true,
    fields: [
      { key: 'h1', type: 'heading', label: 'Layout' },
      { key: 'width', label: 'Width', type: 'number', value: init.width ?? '', min: 0, half: true, help: 'Empty: fit the contents.' },
      { key: 'unit', label: 'Unit', type: 'select', value: init.unit, options: [{ value: '%', label: 'Percent' }, { value: 'px', label: 'Pixels' }], half: true },
      { key: 'align', label: 'Alignment', type: 'select', value: init.align, half: true, options: [{ value: 'default', label: 'Default' }, { value: 'left', label: 'Left (text wraps)' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right (text wraps)' }] },
      { key: 'layout', label: 'Column widths', type: 'select', value: init.layout, half: true, options: [{ value: 'auto', label: 'Automatic (by contents)' }, { value: 'fixed', label: 'Fixed (faster, by first row)' }] },
      { key: 'h2', type: 'heading', label: 'Borders' },
      { key: 'border', label: 'Border width', type: 'number', value: init.border, min: 0, suffix: 'px', half: true },
      { key: 'borderStyle', label: 'Style', type: 'select', value: init.borderStyle, half: true, options: ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'] },
      { key: 'borderColor', label: 'Border color', type: 'color', value: init.borderColor, half: true },
      { key: 'collapse', label: 'Collapse cell borders into single lines', type: 'checkbox', value: init.collapse, half: true },
      { key: 'h3', type: 'heading', label: 'Cells' },
      { key: 'padding', label: 'Cell padding', type: 'number', value: init.padding ?? '', min: 0, suffix: 'px', half: true },
      { key: 'spacing', label: 'Cell spacing', type: 'number', value: init.spacing ?? '', min: 0, suffix: 'px', half: true },
      { key: 'useBg', label: 'Background color', type: 'checkbox', value: init.useBg, half: true },
      { key: 'bg', label: 'Color', type: 'color', value: init.bg || '#ffffff', half: true, visibleIf: (x) => x.useBg },
      { key: 'h4', type: 'heading', label: 'Other' },
      { key: 'captionSide', label: 'Caption position', type: 'select', value: init.captionSide, half: true, options: [{ value: 'top', label: 'Above the table' }, { value: 'bottom', label: 'Below the table' }] },
      { key: 'id', label: 'ID', type: 'text', value: init.id, half: true },
      { key: 'cls', label: 'Class', type: 'text', value: init.cls },
    ],
  });
  if (!v) return;
  const attrs = useAttrs(app);
  const cellRules: string[] = [];
  let tid = '';
  mutate(app, () => {
    const cells = new TableGrid(t).cells.map((g) => g.el);
    // Width and alignment
    setDim(app, t, 'width', v.width != null && v.width !== '' ? `${v.width}${v.unit}` : null);
    t.removeAttribute('align');
    for (const p of ['float', 'margin-left', 'margin-right']) setStyleProp(app, t, p, null);
    if (v.align === 'center') { if (attrs) t.setAttribute('align', 'center'); else { setStyleProp(app, t, 'margin-left', 'auto'); setStyleProp(app, t, 'margin-right', 'auto'); } }
    else if (v.align === 'left' || v.align === 'right') { if (attrs) t.setAttribute('align', v.align); else setStyleProp(app, t, 'float', v.align); }
    setStyleProp(app, t, 'table-layout', v.layout === 'fixed' ? 'fixed' : null);
    // Borders
    t.removeAttribute('border');
    setStyleProp(app, t, 'border', null);
    for (const p of ['border-width', 'border-style', 'border-color']) setStyleProp(app, t, p, null);
    if (v.border) {
      if (attrs && v.borderStyle === 'solid') { t.setAttribute('border', String(v.border)); if (v.borderColor) t.setAttribute('bordercolor', v.borderColor); }
      else setStyleProp(app, t, 'border', `${v.border}px ${v.borderStyle} ${v.borderColor}`);
    } else t.removeAttribute('bordercolor');
    setStyleProp(app, t, 'border-collapse', v.collapse ? 'collapse' : null);
    // Spacing and padding
    t.removeAttribute('cellspacing'); t.removeAttribute('cellpadding');
    setStyleProp(app, t, 'border-spacing', null);
    if (v.spacing != null && v.spacing !== '') { if (attrs) t.setAttribute('cellspacing', String(v.spacing)); else if (!v.collapse) setStyleProp(app, t, 'border-spacing', `${v.spacing}px`); }
    const pad = v.padding != null && v.padding !== '' ? `${v.padding}px` : null;
    if (attrs) { if (pad) t.setAttribute('cellpadding', String(v.padding)); for (const c of cells) setStyleProp(app, c, 'padding', null); }
    else if (app.prefs.cssMode === 'inline') for (const c of cells) setStyleProp(app, c, 'padding', pad);
    else { for (const c of cells) setStyleProp(app, c, 'padding', null); if (pad) cellRules.push(`padding: ${pad}`); }
    if (!attrs && v.border && app.prefs.cssMode !== 'inline') cellRules.push(`border: 1px ${v.borderStyle} ${v.borderColor}`);
    // Background
    t.removeAttribute('bgcolor');
    setStyleProp(app, t, 'background-color', null);
    if (v.useBg && v.bg) { if (attrs) t.setAttribute('bgcolor', v.bg); else setStyleProp(app, t, 'background-color', v.bg); }
    // Caption, id, class
    const cap = t.querySelector(':scope > caption') as HTMLElement | null;
    if (cap) setStyleProp(app, cap, 'caption-side', v.captionSide === 'bottom' ? 'bottom' : null);
    if (v.id) t.id = v.id.trim(); else if (!cellRules.length) t.removeAttribute('id');
    if (v.cls.trim()) t.setAttribute('class', v.cls.trim()); else t.removeAttribute('class');
    if (cellRules.length) tid = ensureId(t);
  });
  if (tid) addHeadRules(app, 'Table Properties', [[`#${tid} > * > tr > td, #${tid} > * > tr > th`, cellRules.join('; ')]], true);
}

async function cellProperties(app: App, arg?: Record<string, any>): Promise<void> {
  if (!designReady(app)) return;
  const s = selection(app);
  if (!s) { toast('Put the cursor in a table cell first.'); return; }
  const c = s.cell;
  const single = !s.multi;
  const init = {
    align: cssOf(c, 'text-align') || c.getAttribute('align') || 'default',
    valign: cssOf(c, 'vertical-align') || c.getAttribute('valign') || 'default',
    width: cssOf(c, 'width') || c.getAttribute('width') || '',
    height: cssOf(c, 'height') || c.getAttribute('height') || '',
    rowspan: s.g.rowSpan, colspan: s.g.colSpan,
    header: c.tagName === 'TH', scope: c.getAttribute('scope') || (s.g.row === 0 ? 'col' : 'row'),
    useBg: !!(cssOf(c, 'background-color') || c.getAttribute('bgcolor')), bg: cssOf(c, 'background-color') || c.getAttribute('bgcolor') || '#ffffff',
    border: cssOf(c, 'border'), nowrap: cssOf(c, 'white-space') === 'nowrap' || c.hasAttribute('nowrap'),
  };
  const v = arg || await openDialog({
    title: single ? 'Cell Properties' : `Cell Properties (${s.grid.cellsIn(s.rect).length} cells)`, wide: true,
    fields: [
      { key: 'h1', type: 'heading', label: 'Layout' },
      { key: 'align', label: 'Horizontal alignment', type: 'select', value: init.align, half: true, options: [{ value: 'default', label: 'Default' }, { value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }, { value: 'justify', label: 'Justify' }] },
      { key: 'valign', label: 'Vertical alignment', type: 'select', value: init.valign, half: true, options: [{ value: 'default', label: 'Default' }, { value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }, { value: 'baseline', label: 'Baseline' }] },
      { key: 'width', label: 'Width', type: 'text', value: init.width, placeholder: 'e.g. 120px or 25%', half: true },
      { key: 'height', label: 'Height', type: 'text', value: init.height, placeholder: 'e.g. 40px', half: true },
      ...(single ? [
        { key: 'rowspan', label: 'Rows spanned', type: 'number' as const, value: init.rowspan, min: 1, half: true },
        { key: 'colspan', label: 'Columns spanned', type: 'number' as const, value: init.colspan, min: 1, half: true },
      ] : []),
      { key: 'nowrap', label: 'Do not wrap text', type: 'checkbox', value: init.nowrap },
      { key: 'h2', type: 'heading', label: 'Header' },
      { key: 'header', label: 'Header cell (th)', type: 'checkbox', value: init.header, half: true },
      { key: 'scope', label: 'Header for', type: 'select', value: init.scope, half: true, visibleIf: (x) => x.header, options: [{ value: 'col', label: 'Its column' }, { value: 'row', label: 'Its row' }, { value: 'colgroup', label: 'Column group' }, { value: 'rowgroup', label: 'Row group' }] },
      { key: 'h3', type: 'heading', label: 'Appearance' },
      { key: 'useBg', label: 'Background color', type: 'checkbox', value: init.useBg, half: true },
      { key: 'bg', label: 'Color', type: 'color', value: init.bg, half: true, visibleIf: (x) => x.useBg },
      { key: 'border', label: 'Border', type: 'text', value: init.border, placeholder: 'e.g. 1px solid #999' },
    ],
  });
  if (!v) return;
  const attrs = useAttrs(app);
  const fix = (x: string) => (/^\d+(\.\d+)?$/.test(x.trim()) ? x.trim() + 'px' : x.trim());
  mutate(app, () => {
    let cells = s.grid.cellsIn(s.rect).map((g) => g.el);
    if (single && (v.rowspan || v.colspan)) {
      const grid = new TableGrid(s.table);
      for (let guard = 0; guard < 200; guard++) {
        const g = grid.find(cells[0]);
        if (!g) break;
        if (v.colspan && g.colSpan < v.colspan) { if (!grid.growColSpan(g.el)) break; continue; }
        if (v.colspan && g.colSpan > v.colspan) { grid.shrinkColSpan(g.el); continue; }
        if (v.rowspan && g.rowSpan < v.rowspan) { if (!grid.growRowSpan(g.el)) break; continue; }
        if (v.rowspan && g.rowSpan > v.rowspan) { grid.shrinkRowSpan(g.el); continue; }
        break;
      }
    }
    cells = cells.map((el) => {
      if (!el.isConnected) return el;
      const want = v.header ? 'TH' : 'TD';
      let n = el as HTMLElement;
      if (el.tagName !== want) n = renameElement(el, want.toLowerCase()) as HTMLElement;
      if (v.header) n.setAttribute('scope', v.scope); else n.removeAttribute('scope');
      return n as HTMLTableCellElement;
    });
    for (const el of cells) {
      if (!el.isConnected) continue;
      el.removeAttribute('align'); el.removeAttribute('valign'); el.removeAttribute('nowrap'); el.removeAttribute('bgcolor');
      setStyleProp(app, el, 'text-align', null); setStyleProp(app, el, 'vertical-align', null);
      if (v.align !== 'default') { if (attrs && v.align !== 'justify') el.setAttribute('align', v.align); else setStyleProp(app, el, 'text-align', v.align); }
      if (v.valign !== 'default') { if (attrs) el.setAttribute('valign', v.valign); else setStyleProp(app, el, 'vertical-align', v.valign); }
      setDim(app, el, 'width', v.width.trim() ? fix(v.width) : null);
      setDim(app, el, 'height', v.height.trim() ? fix(v.height) : null);
      if (attrs && v.nowrap) { el.setAttribute('nowrap', ''); setStyleProp(app, el, 'white-space', null); }
      else setStyleProp(app, el, 'white-space', v.nowrap ? 'nowrap' : null);
      setStyleProp(app, el, 'background-color', null);
      if (v.useBg && v.bg) { if (attrs) el.setAttribute('bgcolor', v.bg); else setStyleProp(app, el, 'background-color', v.bg); }
      setStyleProp(app, el, 'border', v.border.trim() || null);
    }
  });
}

// ------------------------------------------------------------------------------------------
// Commands

const tl = { tab: 'Table Layout', edits: true, isEnabled: inCell } as const;
const td = { tab: 'Table Design', edits: true, isEnabled: inTable } as const;

const insertRows = (app: App, n: number, below: boolean) => tableOp(app, (s) => {
  for (let i = 0; i < n; i++) s.grid.insertRow(below ? s.rect.r2 : s.rect.r1, below);
  caretIn(app, rowCells(s.grid.rows[below ? s.rect.r2 + 1 : s.rect.r1])[0]);
});
const insertCols = (app: App, n: number, right: boolean) => tableOp(app, (s) => {
  for (let i = 0; i < n; i++) s.grid.insertCol(right ? s.rect.c2 : s.rect.c1, right);
});

function deleteRowsOf(s: Sel): void {
  for (let r = s.rect.r2; r >= s.rect.r1; r--) { s.grid.refresh(); if (s.table.isConnected) s.grid.deleteRow(r); }
}
function deleteColsOf(s: Sel): void {
  for (let c = s.rect.c2; c >= s.rect.c1; c--) { s.grid.refresh(); if (s.table.isConnected) s.grid.deleteCol(c); }
}

const AUTOFIT: MenuEntry[] = [
  { id: 'table.autofit', arg: 'contents', label: 'AutoFit to Contents', icon: 'fit_width' },
  { id: 'table.autofit', arg: 'window', label: 'AutoFit to Window', icon: 'width_full' },
  { id: 'table.autofit', arg: 'fixed', label: 'Fixed Column Widths', icon: 'view_column' },
];

def([
  // Insert -----------------------------------------------------------------------------------
  {
    id: 'table.insert', label: 'Insert Table…', icon: 'table', tab: 'Insert', group: 'Tables', edits: true, popular: true,
    origin: 'FrontPage, Expression Web, Dreamweaver', keys: ['Ctrl+Alt+T'], keywords: 'grid rows columns',
    tip: 'Insert a table with a header row, caption and summary.', isEnabled: isPage,
    run: async (app, arg?: Partial<TableSpec>) => {
      const spec = arg && arg.rows ? { styleMode: useAttrs(app) ? 'attrs' : 'css', ...arg } as TableSpec : await insertTableDialog(app);
      if (spec) insertHtml(app, tableMarkup(spec) + (inCode(app) ? '\n' : ''));
    },
  },
  {
    id: 'table.draw', label: 'Draw Table', icon: 'grid_on', tab: 'Insert', group: 'Tables', edits: true,
    origin: 'FrontPage, Word', tip: 'Point to a size in a grid of squares and click to insert the table.', isEnabled: isPage,
    run: async (app, arg?: { rows: number; cols: number }) => {
      const size = arg || await gridPicker();
      if (size) insertHtml(app, tableMarkup({ rows: size.rows, cols: size.cols, width: '100%', border: 1, padding: 4, spacing: 0, headerRow: size.rows > 1, styleMode: useAttrs(app) ? 'attrs' : 'css' }));
    },
  },
  {
    id: 'table.layoutTables', label: 'Layout Tables and Cells…', icon: 'dashboard', tab: 'Insert', group: 'Tables', edits: true,
    origin: 'FrontPage layout tables', keywords: 'page layout css grid', isEnabled: isPage,
    tip: 'Insert a page layout: a CSS grid of header, navigation, content and footer, or a legacy layout table.',
    run: async (app, arg?: { layout: string; legacy?: boolean }) => {
      const v = arg || await openDialog({
        title: 'Page Layout',
        help: 'Layout tables are a thing of the past: a CSS grid adapts to small screens and keeps the reading order. The legacy option inserts a presentational table for older sites.',
        fields: [
          { key: 'layout', label: 'Layout', type: 'list', rows: 6, value: LAYOUTS[0].id, options: LAYOUTS.map((l) => ({ value: l.id, label: l.label })) },
          { key: 'legacy', label: 'Use a layout table (legacy)', type: 'checkbox', value: false },
        ],
      });
      if (v) insertHtml(app, layoutMarkup(v.layout, !!v.legacy));
    },
  },
  {
    id: 'table.importTabular', label: 'Import Tabular Data…', icon: 'upload_file', tab: 'Insert', group: 'Tables', edits: true,
    origin: 'Dreamweaver', keywords: 'csv tsv spreadsheet', isEnabled: isPage, tip: 'Make a table from a CSV or tab-separated file.',
    run: async (app, arg?: { text: string; sep?: string; header?: boolean }) => {
      let text = arg?.text;
      if (text == null) {
        const files = app.site.list((f) => /^(csv|tsv|tab)$/.test(extOf(f.path)));
        let choice = '__pick';
        if (files.length) {
          const v = await openDialog({ title: 'Import Tabular Data', fields: [{ key: 'f', label: 'Data file', type: 'list', rows: 8, value: files[0].path, options: [...files.map((f) => ({ value: f.path, label: f.path })), { value: '__pick', label: 'A file on this computer…' }] }] });
          if (!v) return;
          choice = v.f;
        }
        if (choice === '__pick') {
          const [f] = await pickFile('.csv,.tsv,.tab,.txt,text/csv,text/tab-separated-values,text/plain');
          if (!f) return;
          text = await f.text();
        } else text = app.site.read(choice) || '';
      }
      let rows: string[][], header: boolean;
      if (arg?.text != null) { rows = padRows(parseDelimited(text, arg.sep || guessSeparator(text))); header = arg.header !== false; }
      else { const r = await tabularDialog('Import Tabular Data', text); if (!r) return; rows = r.rows; header = r.header; }
      if (!rows.length) { toast('The file has no rows.'); return; }
      insertHtml(app, tableMarkup({ rows: rows.length, cols: rows[0].length, cells: rows, headerRow: header, width: '100%', border: 1, padding: 4, spacing: 0, styleMode: useAttrs(app) ? 'attrs' : 'css' }));
    },
  },

  // Rows, columns, cells ----------------------------------------------------------------------
  { id: 'table.insertRowAbove', label: 'Insert Row Above', icon: 'add_row_above', group: 'Rows & Columns', origin: 'FrontPage, Expression Web', ...tl, run: (app) => insertRows(app, 1, false) },
  { id: 'table.insertRowBelow', label: 'Insert Row Below', icon: 'add_row_below', group: 'Rows & Columns', origin: 'FrontPage, Expression Web', ...tl, run: (app) => insertRows(app, 1, true) },
  { id: 'table.insertColLeft', label: 'Insert Column to the Left', icon: 'add_column_left', group: 'Rows & Columns', origin: 'FrontPage, Expression Web', ...tl, run: (app) => insertCols(app, 1, false) },
  { id: 'table.insertColRight', label: 'Insert Column to the Right', icon: 'add_column_right', group: 'Rows & Columns', origin: 'FrontPage, Expression Web', ...tl, run: (app) => insertCols(app, 1, true) },
  {
    id: 'table.insertRowsCols', label: 'Insert Rows or Columns…', icon: 'table_rows', group: 'Rows & Columns', origin: 'FrontPage, Dreamweaver', ...tl,
    run: async (app, arg?: { what: 'rows' | 'cols'; count: number; where: string }) => {
      const v = arg || await openDialog({
        title: 'Insert Rows or Columns',
        fields: [
          { key: 'what', label: 'Insert', type: 'radio', value: 'rows', options: [{ value: 'rows', label: 'Rows' }, { value: 'cols', label: 'Columns' }] },
          { key: 'count', label: 'Number', type: 'number', value: 1, min: 1, max: 100 },
          { key: 'where', label: 'Location', type: 'radio', value: 'after', options: [{ value: 'before', label: 'Above / left of the selection' }, { value: 'after', label: 'Below / right of the selection' }] },
        ],
      });
      if (!v) return;
      const n = Math.max(1, Math.min(100, v.count || 1));
      const after = v.where === 'after' || v.where === 'below' || v.where === 'right';
      if (v.what === 'cols') insertCols(app, n, after); else insertRows(app, n, after);
    },
  },
  {
    id: 'table.insertCell', label: 'Insert Cell', icon: 'add_box', group: 'Rows & Columns', origin: 'FrontPage', ...tl,
    tip: 'Add a cell after the current one in its row.',
    run: (app) => tableOp(app, (s, doc) => { const n = doc.createElement(s.cell.tagName.toLowerCase()); n.appendChild(doc.createElement('br')); s.cell.after(n); caretIn(app, n); }),
  },
  {
    id: 'table.insertCaption', label: 'Insert Caption', icon: 'title', group: 'Properties', origin: 'FrontPage, Expression Web', ...td,
    run: (app) => tableOnly(app, (t, doc) => {
      let cap = t.querySelector(':scope > caption');
      if (!cap) { cap = doc.createElement('caption'); cap.textContent = 'Table caption'; t.prepend(cap); }
      view(app)?.design?.select(cap, { contents: true });
    }),
  },
  {
    id: 'table.insertHeader', label: 'Insert Header Row', icon: 'table_rows', group: 'Rows & Columns', origin: 'HTML thead', ...td,
    tip: 'Put the first row in a table head (thead) of header cells, adding one when the first row holds data.',
    run: (app) => tableOnly(app, (t, doc) => {
      let head = t.querySelector(':scope > thead');
      if (head) { caretIn(app, head.querySelector('th,td')); return; }
      const g = new TableGrid(t);
      const first = g.rows[0];
      head = doc.createElement('thead');
      const anchor = t.querySelector(':scope > tbody, :scope > tr, :scope > tfoot');
      if (anchor) t.insertBefore(head, anchor); else t.appendChild(head);
      if (first && rowCells(first).every((c) => c.tagName === 'TH') && g.cells.every((c) => c.row !== 0 || c.rowSpan === 1)) head.appendChild(first);
      else {
        const tr = doc.createElement('tr');
        for (let c = 0; c < Math.max(1, g.width); c++) { const th = doc.createElement('th'); th.setAttribute('scope', 'col'); th.textContent = `Heading ${c + 1}`; tr.appendChild(th); }
        head.appendChild(tr);
      }
      // Rows left directly in the table move into a tbody so the sections stay valid.
      const loose = [...t.children].filter((x) => x.tagName === 'TR');
      if (loose.length) { const body = doc.createElement('tbody'); head.after(body); for (const r of loose) body.appendChild(r); }
      caretIn(app, head.querySelector('th,td'));
    }),
  },
  {
    id: 'table.insertFooter', label: 'Insert Footer Row', icon: 'table_rows', group: 'Rows & Columns', origin: 'HTML tfoot', ...td,
    run: (app) => tableOnly(app, (t, doc) => {
      let foot = t.querySelector(':scope > tfoot');
      if (!foot) {
        const g = new TableGrid(t);
        foot = doc.createElement('tfoot');
        const tr = doc.createElement('tr');
        for (let c = 0; c < Math.max(1, g.width); c++) { const cell = doc.createElement('td'); cell.appendChild(doc.createElement('br')); tr.appendChild(cell); }
        foot.appendChild(tr);
        const loose = [...t.children].filter((x) => x.tagName === 'TR');
        if (loose.length) { const body = doc.createElement('tbody'); loose[0].before(body); for (const r of loose) body.appendChild(r); }
        t.appendChild(foot);
      }
      caretIn(app, foot.querySelector('td,th'));
    }),
  },

  // Delete ------------------------------------------------------------------------------------
  {
    id: 'table.delete', label: 'Delete Table', icon: 'delete', group: 'Rows & Columns', origin: 'FrontPage, Expression Web', ...td,
    run: (app) => tableOnly(app, (t) => {
      const wrap = t.parentElement;
      if (wrap?.classList.contains('table-scroll') && wrap.children.length === 1) wrap.remove(); else t.remove();
      view(app)?.design?.select(null);
    }),
  },
  { id: 'table.deleteRows', label: 'Delete Rows', icon: 'delete_sweep', group: 'Rows & Columns', origin: 'FrontPage, Expression Web', ...tl, run: (app) => tableOp(app, (s) => deleteRowsOf(s)) },
  { id: 'table.deleteCols', label: 'Delete Columns', icon: 'view_column', group: 'Rows & Columns', origin: 'FrontPage, Expression Web', ...tl, run: (app) => tableOp(app, (s) => deleteColsOf(s)) },
  {
    id: 'table.deleteCells', label: 'Delete Cells', icon: 'backspace', group: 'Rows & Columns', origin: 'FrontPage', ...tl,
    tip: 'Delete the selected cells; the cells after them in each row move left. Whole rows or columns are deleted as such.',
    run: (app) => tableOp(app, (s) => s.grid.deleteRect(s.rect)),
  },

  // Select ------------------------------------------------------------------------------------
  {
    id: 'table.selectTable', label: 'Select Table', icon: 'select_all', group: 'Select', origin: 'FrontPage, Dreamweaver', noRecord: true, ...td, edits: false,
    run: (app) => { if (!designReady(app)) return; const t = tableOf(app); if (t) { clearSel(app); view(app)?.design?.select(t); } },
  },
  {
    id: 'table.selectRow', label: 'Select Row', icon: 'table_rows', group: 'Select', origin: 'FrontPage, Dreamweaver', noRecord: true, ...tl, edits: false,
    run: (app) => {
      if (!designReady(app)) return;
      const s = selection(app);
      if (!s) return;
      const rect = s.grid.expand({ r1: s.rect.r1, c1: 0, r2: s.rect.r2, c2: s.grid.width - 1 });
      if (rect.r1 === rect.r2) view(app)?.design?.select(s.grid.rows[rect.r1]);
      setRange(app, s.table, rect);
    },
  },
  {
    id: 'table.selectCol', label: 'Select Column', icon: 'view_column', group: 'Select', origin: 'FrontPage, Dreamweaver', noRecord: true, ...tl, edits: false,
    run: (app) => {
      if (!designReady(app)) return;
      const s = selection(app);
      if (!s) return;
      const rect = s.grid.expand({ r1: 0, c1: s.rect.c1, r2: s.grid.height - 1, c2: s.rect.c2 });
      setRange(app, s.table, rect);
    },
  },
  {
    id: 'table.selectCell', label: 'Select Cell', icon: 'crop_square', group: 'Select', origin: 'FrontPage, Dreamweaver', noRecord: true, ...tl, edits: false,
    run: (app) => {
      if (!designReady(app)) return;
      const s = selection(app);
      if (!s) return;
      view(app)?.design?.select(s.cell);
      setRange(app, s.table, s.grid.rectOf(s.g));
    },
  },

  // Merge and split ---------------------------------------------------------------------------
  {
    id: 'table.mergeCells', label: 'Merge Cells', icon: 'call_merge', group: 'Merge', origin: 'FrontPage, Expression Web, Dreamweaver', ...tl,
    tip: 'Merge the selected cells (drag across cells, or use Select Row / Column). With one cell, choose how many cells to the right and below to merge.',
    run: async (app, arg?: { right?: number; down?: number }) => {
      if (!designReady(app)) return;
      const s = selection(app);
      if (!s) { toast('Put the cursor in a table cell first.'); return; }
      let rect = s.rect;
      if (!s.multi || arg) {
        const v = arg || await openDialog({
          title: 'Merge Cells', help: 'Tip: drag across cells, or Shift+click, to select the cells to merge.',
          fields: [
            { key: 'right', label: 'Cells to the right to merge', type: 'number', value: 1, min: 0, max: s.grid.width - s.g.col - s.g.colSpan, half: true },
            { key: 'down', label: 'Cells below to merge', type: 'number', value: 0, min: 0, max: s.grid.height - s.g.row - s.g.rowSpan, half: true },
          ],
        });
        if (!v) return;
        rect = { r1: s.g.row, c1: s.g.col, r2: Math.min(s.grid.height - 1, s.g.row + s.g.rowSpan - 1 + (v.down || 0)), c2: Math.min(s.grid.width - 1, s.g.col + s.g.colSpan - 1 + (v.right || 0)) };
      }
      if (s.grid.cellsIn(rect).length < 2) { toast('There is nothing to merge with.'); return; }
      clearSel(app);
      let merged: Element | null = null;
      mutate(app, () => { merged = s.grid.merge(rect); });
      caretIn(app, merged);
    },
  },
  {
    id: 'table.splitCells', label: 'Split Cells…', icon: 'call_split', group: 'Merge', origin: 'FrontPage, Expression Web, Dreamweaver', ...tl,
    run: async (app, arg?: { rows?: number; cols?: number; mode?: string }) => {
      if (!designReady(app)) return;
      const s = selection(app);
      if (!s) { toast('Put the cursor in a table cell first.'); return; }
      const v: Record<string, any> | null = arg || await openDialog({
        title: 'Split Cells',
        fields: [
          { key: 'mode', label: 'Split into', type: 'radio', value: 'cols', options: [{ value: 'cols', label: 'Columns' }, { value: 'rows', label: 'Rows' }, { value: 'both', label: 'Rows and columns' }] },
          { key: 'cols', label: 'Number of columns', type: 'number', value: Math.max(2, s.g.colSpan), min: 1, max: 50, half: true, visibleIf: (x) => x.mode !== 'rows' },
          { key: 'rows', label: 'Number of rows', type: 'number', value: Math.max(2, s.g.rowSpan), min: 1, max: 50, half: true, visibleIf: (x) => x.mode !== 'cols' },
        ],
      });
      if (!v) return;
      const rows = v.mode === 'cols' ? 1 : Math.max(1, v.rows || 1);
      const cols = v.mode === 'rows' ? 1 : Math.max(1, v.cols || 1);
      if (rows === 1 && cols === 1) return;
      clearSel(app);
      const targets = s.grid.cellsIn(s.rect).map((g) => g.el);
      mutate(app, () => { for (const el of targets) { s.grid.refresh(); if (el.isConnected) s.grid.split(el, rows, cols); } });
      caretIn(app, targets[0]);
    },
  },
  {
    id: 'table.splitTable', label: 'Split Table', icon: 'vertical_split', group: 'Merge', origin: 'Word, Expression Web', ...tl,
    tip: 'Split the table into two above the current row.',
    run: (app) => tableOp(app, (s, doc) => {
      const b = s.g.row;
      if (b === 0) { toast('Put the cursor below the first row to split the table there.'); return; }
      const g = s.grid;
      g.cutRows(b);
      const t2 = s.table.cloneNode(false) as HTMLTableElement;
      t2.removeAttribute('id');
      const body = doc.createElement('tbody');
      t2.appendChild(body);
      const moving = g.rows.slice(b);
      for (const r of moving) { if (r.parentElement?.tagName === 'TFOOT') continue; body.appendChild(r); }
      const foot = s.table.querySelector(':scope > tfoot');
      if (foot) t2.appendChild(foot);
      for (const sec of [...s.table.querySelectorAll(':scope > tbody')]) if (!sec.querySelector('tr')) sec.remove();
      const p = doc.createElement('p');
      p.appendChild(doc.createElement('br'));
      s.table.after(p, t2);
      caretIn(app, t2.querySelector('td,th'));
    }),
  },

  // Size --------------------------------------------------------------------------------------
  {
    id: 'table.distributeRows', label: 'Distribute Rows Evenly', icon: 'height', group: 'Size', origin: 'FrontPage, Word', ...tl,
    run: (app) => tableOp(app, (s) => {
      const all = !s.multi;
      const r1 = all ? 0 : s.rect.r1, r2 = all ? s.grid.height - 1 : s.rect.r2;
      const rows = s.grid.rows.slice(r1, r2 + 1);
      const max = Math.max(0, ...rows.map((r) => Math.round(r.getBoundingClientRect().height)));
      for (const c of s.grid.cells) if (c.row >= r1 && c.row <= r2) setDim(app, c.el, 'height', null);
      for (const r of rows) { r.removeAttribute('height'); setStyleProp(app, r, 'height', max ? `${max}px` : null); }
    }),
  },
  {
    id: 'table.distributeCols', label: 'Distribute Columns Evenly', icon: 'width', group: 'Size', origin: 'FrontPage, Word', ...tl,
    run: (app) => tableOp(app, (s) => {
      const g = s.grid;
      const all = !s.multi || (s.rect.c1 === 0 && s.rect.c2 === g.width - 1);
      const c1 = all ? 0 : s.rect.c1, c2 = all ? g.width - 1 : s.rect.c2;
      const n = c2 - c1 + 1;
      let total = 0;
      for (let c = c1; c <= c2; c++) { const x = g.cells.find((y) => y.col === c && y.colSpan === 1); total += x ? x.el.getBoundingClientRect().width : 0; }
      for (const c of g.cells) {
        if (c.col < c1 || c.col + c.colSpan - 1 > c2) continue;
        if (c.colSpan !== 1) { setDim(app, c.el, 'width', null); continue; }
        setDim(app, c.el, 'width', all || !total ? `${Math.round((10000 / g.width)) / 100}%` : `${Math.round(total / n)}px`);
      }
    }),
  },
  {
    id: 'table.autofit', label: 'AutoFit', icon: 'fit_width', group: 'Size', origin: 'FrontPage, Word', kind: 'menu', ...td,
    menu: () => AUTOFIT,
    run: (app, arg?: string) => tableOnly(app, (t) => {
      const mode = arg || 'contents';
      const g = new TableGrid(t);
      for (const c of g.cells) setDim(app, c.el, 'width', null);
      t.querySelectorAll(':scope > colgroup, :scope > col').forEach((x) => x.remove());
      setStyleProp(app, t, 'table-layout', mode === 'fixed' ? 'fixed' : null);
      if (mode === 'window') setDim(app, t, 'width', '100%');
      else if (mode === 'contents') setDim(app, t, 'width', null);
      else if (mode === 'fixed') {
        const w = Math.round(t.getBoundingClientRect().width);
        if (w) setDim(app, t, 'width', `${w}px`);
        for (const c of g.cells) if (c.row === 0 && c.colSpan === 1) { const cw = Math.round(c.el.getBoundingClientRect().width); if (cw) setDim(app, c.el, 'width', `${cw}px`); }
      }
    }),
  },
  {
    id: 'table.clearHeights', label: 'Clear Row Heights', icon: 'format_line_spacing', group: 'Size', origin: 'Dreamweaver', ...td,
    run: (app) => tableOnly(app, (t) => {
      for (const el of [t, ...ownRows(t), ...new TableGrid(t).cells.map((c) => c.el)] as HTMLElement[]) { el.removeAttribute('height'); setStyleProp(app, el, 'height', null); }
    }),
  },
  {
    id: 'table.clearWidths', label: 'Clear Column Widths', icon: 'format_textdirection_l_to_r', group: 'Size', origin: 'Dreamweaver', ...td,
    run: (app) => tableOnly(app, (t) => {
      for (const el of new TableGrid(t).cells.map((c) => c.el) as HTMLElement[]) { el.removeAttribute('width'); setStyleProp(app, el, 'width', null); }
      t.querySelectorAll(':scope > colgroup col, :scope > col').forEach((c) => { c.removeAttribute('width'); setStyleProp(app, c as HTMLElement, 'width', null); });
    }),
  },
  {
    id: 'table.widthsToPixels', label: 'Convert Widths to Pixels', icon: 'straighten', group: 'Size', origin: 'Dreamweaver', ...td,
    run: (app) => tableOnly(app, (t) => {
      const w = Math.round(t.getBoundingClientRect().width);
      if (!w) { toast('The table has no size in Design view yet.'); return; }
      setDim(app, t, 'width', `${w}px`);
      for (const c of new TableGrid(t).cells) if (c.colSpan === 1 && c.row === 0) setDim(app, c.el, 'width', `${Math.round(c.el.getBoundingClientRect().width)}px`);
    }),
  },
  {
    id: 'table.widthsToPercent', label: 'Convert Widths to Percent', icon: 'percent', group: 'Size', origin: 'Dreamweaver', ...td,
    run: (app) => tableOnly(app, (t) => {
      const tw = t.getBoundingClientRect().width;
      const pw = (t.parentElement?.getBoundingClientRect().width) || tw;
      if (!tw) { toast('The table has no size in Design view yet.'); return; }
      setDim(app, t, 'width', `${Math.round((tw / pw) * 100)}%`);
      for (const c of new TableGrid(t).cells) if (c.colSpan === 1 && c.row === 0) setDim(app, c.el, 'width', `${Math.round((c.el.getBoundingClientRect().width / tw) * 1000) / 10}%`);
      for (const c of new TableGrid(t).cells) if (c.row > 0) setDim(app, c.el, 'width', null);
    }),
  },

  // Fill and spans ----------------------------------------------------------------------------
  {
    id: 'table.fillDown', label: 'Fill Down', icon: 'arrow_downward', group: 'Data', origin: 'FrontPage', ...tl,
    tip: 'Copy the top cell of each selected column into the cells below it (with one cell: to the end of its column).',
    run: (app) => tableOp(app, (s) => {
      const g = s.grid;
      const rect = s.multi ? s.rect : { ...s.rect, r2: g.height - 1 };
      for (let c = rect.c1; c <= rect.c2; c++) {
        const top = g.at(rect.r1, c);
        if (!top || top.col !== c) continue;
        for (let r = top.row + top.rowSpan; r <= rect.r2; r++) {
          const x = g.at(r, c);
          if (x && x.row === r && x.col === c && x !== top && x.el.parentElement?.parentElement === top.el.parentElement?.parentElement) x.el.innerHTML = top.el.innerHTML;
        }
      }
    }),
  },
  {
    id: 'table.fillRight', label: 'Fill Right', icon: 'arrow_forward', group: 'Data', origin: 'FrontPage', ...tl,
    tip: 'Copy the first cell of each selected row into the cells to its right (with one cell: to the end of its row).',
    run: (app) => tableOp(app, (s) => {
      const g = s.grid;
      const rect = s.multi ? s.rect : { ...s.rect, c2: g.width - 1 };
      for (let r = rect.r1; r <= rect.r2; r++) {
        const first = g.at(r, rect.c1);
        if (!first || first.row !== r) continue;
        for (let c = first.col + first.colSpan; c <= rect.c2; c++) { const x = g.at(r, c); if (x && x.row === r && x.col === c) x.el.innerHTML = first.el.innerHTML; }
      }
    }),
  },
  { id: 'table.increaseRowSpan', label: 'Increase Row Span', icon: 'expand', group: 'Merge', origin: 'Dreamweaver', ...tl, run: (app) => tableOp(app, (s) => { if (!s.grid.growRowSpan(s.cell)) toast('The cell already reaches the last row.'); }) },
  { id: 'table.decreaseRowSpan', label: 'Decrease Row Span', icon: 'compress', group: 'Merge', origin: 'Dreamweaver', ...tl, run: (app) => tableOp(app, (s) => { if (!s.grid.shrinkRowSpan(s.cell)) toast('The cell spans one row.'); }) },
  { id: 'table.increaseColSpan', label: 'Increase Column Span', icon: 'unfold_more_double', group: 'Merge', origin: 'Dreamweaver', ...tl, run: (app) => tableOp(app, (s) => { if (!s.grid.growColSpan(s.cell)) toast('The cell already reaches the last column.'); }) },
  { id: 'table.decreaseColSpan', label: 'Decrease Column Span', icon: 'unfold_less_double', group: 'Merge', origin: 'Dreamweaver', ...tl, run: (app) => tableOp(app, (s) => { if (!s.grid.shrinkColSpan(s.cell)) toast('The cell spans one column.'); }) },
  {
    id: 'table.headerCells', label: 'Header Cells', icon: 'table_chart', group: 'Table Styles', kind: 'toggle', origin: 'Dreamweaver, Expression Web', ...td,
    tip: 'Turn the selected cells into header cells (th with scope) or back into data cells.',
    isActive: (app) => cellOf(app)?.tagName === 'TH',
    run: (app) => tableOp(app, (s) => {
      const cells = s.grid.cellsIn(s.rect);
      const toTh = !cells.every((c) => c.el.tagName === 'TH');
      let first: Element | null = null;
      for (const c of cells) {
        const n = c.el.tagName === (toTh ? 'TH' : 'TD') ? c.el : renameElement(c.el, toTh ? 'th' : 'td');
        if (toTh) n.setAttribute('scope', n.closest('thead') || c.row === 0 ? 'col' : c.col === 0 ? 'row' : 'col'); else n.removeAttribute('scope');
        first ??= n;
      }
      caretIn(app, first);
    }),
  },

  // Data --------------------------------------------------------------------------------------
  {
    id: 'table.sort', label: 'Sort Table…', icon: 'sort', group: 'Data', origin: 'Dreamweaver', ...td,
    run: async (app, arg?: { col: number; type?: SortType; desc?: boolean; header?: boolean; then?: number }) => {
      if (!designReady(app)) return;
      const t = tableOf(app);
      if (!t) { toast('Put the cursor in a table first.'); return; }
      const grid = new TableGrid(t);
      const cur = grid.find(cellOf(app));
      const bodyRows = (t.tBodies.length ? [...(cellOf(app)?.closest('tbody') || t.tBodies[0]).children] : [...t.children]).filter((x) => x.tagName === 'TR') as HTMLTableRowElement[];
      const headLike = !t.tHead && bodyRows[0] && rowCells(bodyRows[0]).every((c) => c.tagName === 'TH');
      const labels = Array.from({ length: grid.width }, (_, c) => {
        const head = grid.at(0, c);
        const text = head && (t.tHead || headLike) ? (head.el.textContent || '').trim() : '';
        return { value: String(c), label: text ? `${c + 1}: ${text.slice(0, 40)}` : `Column ${c + 1}` };
      });
      const v = arg || await openDialog({
        title: 'Sort Table',
        fields: [
          { key: 'col', label: 'Sort by', type: 'select', value: String(cur?.col ?? 0), options: labels, half: true },
          { key: 'type', label: 'Type', type: 'select', value: 'auto', half: true, options: [{ value: 'auto', label: 'Detect' }, { value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }] },
          { key: 'desc', label: 'Order', type: 'radio', value: 'asc', options: [{ value: 'asc', label: 'Ascending (A to Z, 1 to 9)' }, { value: 'desc', label: 'Descending' }] },
          { key: 'header', label: 'Keep the first row in place (it is a header)', type: 'checkbox', value: !!headLike },
        ],
      });
      if (!v) return;
      const col = +v.col;
      const desc = v.desc === true || v.desc === 'desc';
      const keep = !!v.header;
      const rows = keep ? bodyRows.slice(1) : bodyRows;
      const gs = rows.map((r) => grid.cells.filter((c) => c.el.parentElement === r));
      if (grid.cells.some((c) => rows.includes(c.el.parentElement as HTMLTableRowElement) && c.rowSpan > 1)) { toast('Rows with cells merged across rows cannot be sorted. Split those cells first.'); return; }
      const texts = rows.map((r) => (grid.cells.find((c) => c.el.parentElement === r && c.col <= col && c.col + c.colSpan > col)?.el.textContent || '').trim());
      const order = sortOrder(texts, (v.type || 'auto') as SortType, desc);
      void gs;
      mutate(app, () => {
        const parent = rows[0]?.parentElement;
        if (!parent) return;
        const after = rows[rows.length - 1].nextSibling;
        for (const i of order) parent.insertBefore(rows[i], after);
      });
      toast(`Sorted ${rows.length} rows as ${v.type === 'auto' || !v.type ? detectSortType(texts) : v.type}.`);
    },
  },
  {
    id: 'table.stripes', label: 'Banded Rows', icon: 'view_day', group: 'Table Styles', kind: 'toggle', origin: 'Word, Expression Web', ...td,
    tip: 'Shade every other row (a class and a style rule in the page head).',
    isActive: (app) => !!tableOf(app)?.classList.contains('qlt-striped'),
    run: (app) => {
      let on = false;
      if (!tableOnly(app, (t) => { on = t.classList.toggle('qlt-striped'); if (!t.classList.length) t.removeAttribute('class'); })) return;
      if (on) addHeadRules(app, 'Banded Rows', [STRIPE_RULE]);
    },
  },
  {
    id: 'table.responsive', label: 'Scroll on Small Screens', icon: 'swipe', group: 'Table Styles', kind: 'toggle', origin: 'Responsive design', ...td,
    tip: 'Wrap the table in a container that scrolls sideways on narrow screens (focusable, labeled for screen readers).',
    isActive: (app) => !!tableOf(app)?.parentElement?.classList.contains('table-scroll'),
    run: (app) => tableOnly(app, (t, doc) => {
      const p = t.parentElement!;
      if (p.classList.contains('table-scroll')) { p.replaceWith(...p.childNodes); return; }
      const wrap = doc.createElement('div');
      wrap.className = 'table-scroll';
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('tabindex', '0');
      wrap.setAttribute('aria-label', (t.querySelector(':scope > caption')?.textContent || '').trim() || 'Table');
      wrap.setAttribute('style', 'overflow-x: auto; max-width: 100%');
      t.replaceWith(wrap);
      wrap.appendChild(t);
    }),
  },
  {
    id: 'table.textToTable', label: 'Convert Text to Table…', icon: 'table_view', tab: 'Table Layout', group: 'Data', edits: true, origin: 'FrontPage, Word', isEnabled: isPage,
    run: async (app, arg?: { text?: string; sep?: string; header?: boolean }) => {
      const raw = arg?.text ?? (inCode(app) ? view(app)?.code?.selection.text || '' : htmlLines(selectionHtml(app)));
      if (!raw.trim()) { toast('Select the text to convert first: one line per row, cells separated by tabs, commas or another character.'); return; }
      let rows: string[][], header: boolean;
      if (arg?.sep) { rows = padRows(parseDelimited(raw, SEPS[arg.sep] ?? arg.sep)); header = arg.header !== false; }
      else { const r = await tabularDialog('Convert Text to Table', raw, { allowParagraphs: true }); if (!r) return; rows = r.rows; header = r.header; }
      insertHtml(app, tableMarkup({ rows: rows.length, cols: rows[0].length, cells: rows, headerRow: header, border: 1, padding: 4, spacing: 0, styleMode: useAttrs(app) ? 'attrs' : 'css' }));
    },
  },
  {
    id: 'table.tableToText', label: 'Convert Table to Text…', icon: 'notes', group: 'Data', origin: 'FrontPage, Word', ...td,
    run: async (app, arg?: { sep: string; custom?: string }) => {
      if (!designReady(app)) return;
      const t = tableOf(app);
      if (!t) { toast('Put the cursor in a table first.'); return; }
      const v = arg || await openDialog({
        title: 'Convert Table to Text',
        fields: [
          { key: 'sep', label: 'Separate cells with', type: 'radio', value: 'paragraphs', options: [{ value: 'paragraphs', label: 'Paragraphs (each cell keeps its formatting)' }, { value: 'tab', label: 'Tabs' }, { value: 'comma', label: 'Commas' }, { value: 'custom', label: 'Other' }] },
          { key: 'custom', label: 'Other separator', type: 'text', value: ' | ', visibleIf: (x) => x.sep === 'custom' },
        ],
      });
      if (!v) return;
      const clone = t.cloneNode(true) as HTMLTableElement;
      restoreOriginals(clone);
      const g = new TableGrid(clone);
      const out: string[] = [];
      const cap = clone.querySelector(':scope > caption');
      if (cap) out.push(`<p><strong>${cap.innerHTML.trim()}</strong></p>`);
      g.rows.forEach((tr, r) => {
        const cells = g.cells.filter((c) => c.row === r);
        if (v.sep === 'paragraphs') { for (const c of cells) { const inner = c.el.innerHTML.trim(); if (inner && inner !== '<br>' && inner !== '&nbsp;') out.push(/^<(p|div|h[1-6]|ul|ol|table|blockquote)\b/i.test(inner) ? inner : `<p>${inner}</p>`); } return; }
        const sep = v.sep === 'tab' ? '\t' : v.sep === 'comma' ? ', ' : v.custom ?? ' | ';
        out.push(`<p${v.sep === 'tab' ? ' style="white-space: pre-wrap"' : ''}>${cells.map((c) => esc((c.el.textContent || '').trim())).join(esc(sep))}</p>`);
        void tr;
      });
      clearSel(app);
      mutate(app, () => replaceElement(app, t, out.join('\n') || '<p></p>'));
    },
  },
  {
    id: 'table.toDivs', label: 'Convert Table to Divs (CSS Grid)', icon: 'grid_view', group: 'Data', origin: 'Expression Web, modern CSS', ...td,
    tip: 'Rebuild a data table as divs laid out with CSS grid, keeping table roles for screen readers.',
    run: async (app) => {
      if (!designReady(app)) return;
      const t = tableOf(app);
      if (!t) return;
      if (!await confirmDialog('Convert Table to Divs', 'The table becomes a CSS grid of div elements with table roles (role="table", "row", "cell"). A real table is usually better for data; use this for card-like layouts.', 'Convert')) return;
      const clone = t.cloneNode(true) as HTMLTableElement;
      restoreOriginals(clone);
      clearSel(app);
      mutate(app, () => replaceElement(app, t, tableToGridMarkup(clone, { semantic: true })));
    },
  },
  {
    id: 'table.toCssGrid', label: 'Convert Layout Table to CSS Grid', icon: 'view_quilt', group: 'Data', origin: 'Modern CSS replacement for layout tables', ...td,
    tip: 'Replace a layout table with a CSS grid of divs (spans become grid-column and grid-row).',
    run: (app) => {
      if (!designReady(app)) return;
      const t = tableOf(app);
      if (!t) return;
      const clone = t.cloneNode(true) as HTMLTableElement;
      restoreOriginals(clone);
      clearSel(app);
      mutate(app, () => replaceElement(app, t, tableToGridMarkup(clone, { semantic: false })));
    },
  },
  {
    id: 'table.apDivsToTable', label: 'Convert Positioned Boxes to Table', icon: 'table_view', tab: 'Table Layout', group: 'Data', edits: true, origin: 'Dreamweaver (AP Divs to table)', isEnabled: isPage,
    tip: 'Lay out absolutely positioned elements as a table that keeps their places.',
    run: async (app) => {
      if (!designReady(app)) return;
      const d = view(app)!.design!;
      const doc = d.doc!;
      const scopeEl = (selectedEl(app) && selectedEl(app) !== doc.body && !selectedEl(app)!.matches('[style*="absolute"]') ? selectedEl(app) : doc.body) as HTMLElement;
      const all = [...scopeEl.querySelectorAll<HTMLElement>('[style]')].filter((e) => !e.closest('[data-ql-ui]') && doc.defaultView!.getComputedStyle(e).position === 'absolute');
      const top = all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
      if (!top.length) { toast('There are no absolutely positioned elements here.'); return; }
      if (!await confirmDialog('Convert to Table', `${top.length} positioned element${top.length > 1 ? 's' : ''} will be laid out as a table that keeps their places. Their contents move into table cells.`, 'Convert')) return;
      const base = scopeEl.getBoundingClientRect();
      const boxes: Box[] = top.map((e) => {
        const r = e.getBoundingClientRect();
        const c = e.cloneNode(true) as HTMLElement;
        restoreOriginals(c);
        return { x: Math.round(r.left - base.left), y: Math.round(r.top - base.top), w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)), html: c.innerHTML.trim() };
      });
      mutate(app, () => {
        const first = top[0];
        const marker = doc.createElement('span');
        first.before(marker);
        for (const e of top) e.remove();
        replaceElement(app, marker, boxesToTable(boxes));
      });
    },
  },

  // Properties and styles ---------------------------------------------------------------------
  { id: 'table.properties', label: 'Table Properties…', icon: 'settings', group: 'Properties', origin: 'FrontPage, Expression Web', ...td, run: (app, arg) => tableProperties(app, arg) },
  { id: 'table.cellProperties', label: 'Cell Properties…', icon: 'tune', group: 'Properties', origin: 'FrontPage, Expression Web', ...tl, tab: 'Table Design', run: (app, arg) => cellProperties(app, arg) },
  {
    id: 'table.autoFormat', label: 'Table Styles', icon: 'style', group: 'Table Styles', kind: 'menu', origin: 'FrontPage Table AutoFormat', ...td,
    tip: 'Apply a table style: a class on the table and its rules in the page head.',
    menu: (app) => {
      const cur = [...(tableOf(app)?.classList || [])].find((c) => /^qlt-(?!striped)/.test(c));
      return [
        ...STYLES.map((s): MenuEntry => ({ id: 'table.autoFormat', arg: s.id, label: s.label, swatch: s.head === 'transparent' ? s.line : s.head, checked: cur === `qlt-${s.id}` })),
        { separator: true },
        { id: 'table.autoFormat', arg: 'none', label: 'No Style', icon: 'format_clear' },
      ];
    },
    run: async (app, arg?: string) => {
      let id = arg;
      if (!id) {
        const v = await openDialog({ title: 'Table Styles', fields: [{ key: 's', label: 'Style', type: 'list', rows: 10, value: STYLES[0].id, options: [...STYLES.map((s) => ({ value: s.id, label: s.label })), { value: 'none', label: 'No style' }] }] });
        if (!v) return;
        id = v.s;
      }
      applyStyle(app, id!);
    },
  },
  {
    id: 'table.bordersMenu', label: 'Borders', icon: 'border_all', group: 'Table Styles', kind: 'menu', origin: 'Word, Expression Web', ...td,
    menu: () => BORDER_OPTS.map((b) => ({ id: 'table.bordersMenu', arg: b.id, label: b.label, icon: b.icon })),
    run: async (app, arg?: string | { kind: string; line?: string }) => {
      let kind = typeof arg === 'string' ? arg : arg?.kind;
      const line = typeof arg === 'object' ? arg.line : undefined;
      if (!kind) {
        const v = await openDialog({ title: 'Borders', fields: [{ key: 'k', label: 'Borders', type: 'list', rows: 10, value: 'all', options: BORDER_OPTS.map((b) => ({ value: b.id, label: b.label })) }] });
        if (!v) return;
        kind = v.k;
      }
      applyBorders(app, kind!, line);
    },
  },
]);

// Exported for tests and other modules.
export { STYLES as TABLE_STYLES, styleRules, htmlLines };
