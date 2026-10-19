/**
 * The logical grid of an HTML table: every (row, column) slot mapped to the cell that covers it, with
 * rowspan and colspan taken into account. Row and column insertion, deletion, merging and splitting work
 * on this grid so that spanned cells grow, shrink or move instead of breaking the table's shape.
 *
 * The grid works on any DOM (the Design view frame, a DOMParser document, jsdom in tests). Only the
 * table's own rows are used, never those of nested tables.
 */

export interface GridCell {
  el: HTMLTableCellElement;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

export interface CellRect { r1: number; c1: number; r2: number; c2: number }

const isCell = (n: Element) => n.tagName === 'TD' || n.tagName === 'TH';

/** The table's own rows in document order (thead, tbody, tfoot and direct rows; not nested tables). */
export function ownRows(table: HTMLTableElement): HTMLTableRowElement[] {
  const out: HTMLTableRowElement[] = [];
  for (const ch of table.children) {
    if (ch.tagName === 'TR') out.push(ch as HTMLTableRowElement);
    else if (/^(THEAD|TBODY|TFOOT)$/.test(ch.tagName)) for (const r of ch.children) if (r.tagName === 'TR') out.push(r as HTMLTableRowElement);
  }
  return out;
}

/** The cells of one row element, in order. */
export function rowCells(tr: Element): HTMLTableCellElement[] {
  return [...tr.children].filter(isCell) as HTMLTableCellElement[];
}

function spanOf(el: Element, attr: 'rowspan' | 'colspan'): number {
  const v = parseInt(el.getAttribute(attr) || '1', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 1000) : attr === 'rowspan' && v === 0 ? 0 : 1;
}

function setSpan(el: Element, attr: 'rowspan' | 'colspan', n: number): void {
  if (n <= 1) el.removeAttribute(attr); else el.setAttribute(attr, String(n));
}

/** Splits n into k nearly equal positive parts (larger parts first). */
export function distribute(n: number, k: number): number[] {
  const base = Math.floor(n / k), extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

export class TableGrid {
  rows: HTMLTableRowElement[] = [];
  slots: (GridCell | null)[][] = [];
  cells: GridCell[] = [];
  width = 0;
  private byEl = new Map<Element, GridCell>();

  constructor(public table: HTMLTableElement) { this.refresh(); }

  get height(): number { return this.rows.length; }
  get doc(): Document { return this.table.ownerDocument; }

  /** Rebuilds the grid from the DOM (every operation calls it when it is done). */
  refresh(): this {
    this.rows = ownRows(this.table);
    this.slots = this.rows.map(() => []);
    this.cells = [];
    this.byEl.clear();
    const n = this.rows.length;
    this.rows.forEach((tr, r) => {
      // rowspan never leaves the row group (thead/tbody/tfoot) it starts in.
      const group = tr.parentElement;
      let groupEnd = r;
      while (groupEnd + 1 < n && this.rows[groupEnd + 1].parentElement === group) groupEnd++;
      let c = 0;
      for (const el of rowCells(tr)) {
        while (this.slots[r][c]) c++;
        let rs = spanOf(el, 'rowspan');
        if (rs === 0) rs = groupEnd - r + 1;
        rs = Math.max(1, Math.min(rs, groupEnd - r + 1));
        const cs = spanOf(el, 'colspan');
        const g: GridCell = { el, row: r, col: c, rowSpan: rs, colSpan: cs };
        this.cells.push(g);
        this.byEl.set(el, g);
        for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) this.slots[i][j] = g;
        c += cs;
      }
    });
    this.width = Math.max(0, ...this.slots.map((s) => s.length));
    for (const s of this.slots) for (let j = 0; j < this.width; j++) if (s[j] === undefined) s[j] = null;
    return this;
  }

  at(r: number, c: number): GridCell | null { return this.slots[r]?.[c] ?? null; }
  find(el: Element | null): GridCell | null {
    const cell = el?.closest?.('td,th');
    return cell ? this.byEl.get(cell) ?? null : null;
  }

  /** Unique cells overlapping a rectangle, in reading order. */
  cellsIn(rect: CellRect): GridCell[] {
    const out: GridCell[] = [];
    const seen = new Set<GridCell>();
    for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) {
      const g = this.at(r, c);
      if (g && !seen.has(g)) { seen.add(g); out.push(g); }
    }
    return out;
  }

  /** The smallest rectangle containing `rect` that cuts no cell. */
  expand(rect: CellRect): CellRect {
    let { r1, c1, r2, c2 } = rect;
    for (let changed = true; changed;) {
      changed = false;
      for (const g of this.cellsIn({ r1, c1, r2, c2 })) {
        if (g.row < r1) { r1 = g.row; changed = true; }
        if (g.col < c1) { c1 = g.col; changed = true; }
        if (g.row + g.rowSpan - 1 > r2) { r2 = g.row + g.rowSpan - 1; changed = true; }
        if (g.col + g.colSpan - 1 > c2) { c2 = g.col + g.colSpan - 1; changed = true; }
      }
    }
    return { r1, c1, r2, c2 };
  }

  /** The rectangle spanned by two cells (in any order), expanded so it cuts no cell. */
  rectOf(a: GridCell, b: GridCell = a): CellRect {
    return this.expand({
      r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col),
      r2: Math.max(a.row + a.rowSpan - 1, b.row + b.rowSpan - 1), c2: Math.max(a.col + a.colSpan - 1, b.col + b.colSpan - 1),
    });
  }

  private newCell(tag: string, like?: Element | null): HTMLTableCellElement {
    const el = this.doc.createElement(tag) as HTMLTableCellElement;
    if (tag === 'th' && like?.getAttribute('scope')) el.setAttribute('scope', like.getAttribute('scope')!);
    el.appendChild(this.doc.createElement('br'));
    return el;
  }

  /** Inserts `cell` into row r so that it sits at logical column c. */
  private placeInRow(r: number, c: number, cell: HTMLTableCellElement): void {
    const tr = this.rows[r];
    const next = rowCells(tr).find((el) => (this.byEl.get(el)?.col ?? 0) >= c && el !== cell);
    if (next) tr.insertBefore(cell, next); else tr.appendChild(cell);
  }

  /** Inserts a row above (`after` false) or below row `ref`. Spanning cells grow across it. Returns the new row. */
  insertRow(ref: number, after = false): HTMLTableRowElement {
    const tr = this.doc.createElement('tr');
    const refRow = this.rows[ref];
    if (!refRow) {
      const body = this.table.querySelector(':scope > tbody') || this.table.appendChild(this.doc.createElement('tbody'));
      body.appendChild(tr);
      for (let c = 0; c < Math.max(1, this.width); c++) tr.appendChild(this.newCell('td'));
      this.refresh();
      return tr;
    }
    const boundary = after ? ref + 1 : ref;
    const grown = new Set<GridCell>();
    for (let c = 0; c < this.width;) {
      const g = this.at(ref, c);
      if (!g) { tr.appendChild(this.newCell('td')); c++; continue; }
      const span = g.colSpan - (c - g.col);
      const crosses = g.row < boundary && g.row + g.rowSpan > boundary;
      if (crosses) { if (!grown.has(g)) { grown.add(g); setSpan(g.el, 'rowspan', g.rowSpan + 1); } }
      else {
        const cell = this.newCell(g.el.tagName.toLowerCase(), g.el);
        setSpan(cell, 'colspan', span);
        tr.appendChild(cell);
      }
      c += span;
    }
    if (after) refRow.after(tr); else refRow.before(tr);
    this.refresh();
    return tr;
  }

  /** Inserts a column left (`after` false) or right of column `ref`. Spanning cells grow across it. */
  insertCol(ref: number, after = false): HTMLTableCellElement[] {
    const boundary = after ? ref + 1 : ref;
    const grown = new Set<GridCell>();
    const added: [number, HTMLTableCellElement][] = [];
    for (let r = 0; r < this.height; r++) {
      const g = this.at(r, Math.min(ref, this.width - 1));
      if (g && g.col < boundary && g.col + g.colSpan > boundary) {
        if (!grown.has(g)) { grown.add(g); setSpan(g.el, 'colspan', g.colSpan + 1); }
        continue;
      }
      if (g && g.row < r) continue; // covered by the cell created at the spanning cell's first row
      const cell = this.newCell(g ? g.el.tagName.toLowerCase() : 'td', g?.el);
      if (g) setSpan(cell, 'rowspan', g.rowSpan);
      added.push([r, cell]);
    }
    for (const [r, cell] of added) this.placeInRow(r, boundary, cell);
    this.refresh();
    return added.map(([, c]) => c);
  }

  /** Deletes row r. Cells spanning it shrink; cells starting in it with a rowspan move down. */
  deleteRow(r: number): void {
    const tr = this.rows[r];
    if (!tr) return;
    const seen = new Set<GridCell>();
    const moves: [GridCell, number][] = [];
    for (let c = 0; c < this.width; c++) {
      const g = this.at(r, c);
      if (!g || seen.has(g)) continue;
      seen.add(g);
      if (g.rowSpan > 1) {
        setSpan(g.el, 'rowspan', g.rowSpan - 1);
        if (g.row === r) moves.push([g, g.col]);
      }
    }
    for (const [g, col] of moves) {
      const below = this.rows[r + 1];
      if (!below) continue;
      const next = rowCells(below).find((el) => (this.byEl.get(el)?.col ?? 0) > col);
      if (next) below.insertBefore(g.el, next); else below.appendChild(g.el);
    }
    tr.remove();
    this.refresh();
    this.cleanup();
  }

  /** Deletes column c. Cells spanning it shrink. */
  deleteCol(c: number): void {
    const seen = new Set<GridCell>();
    for (let r = 0; r < this.height; r++) {
      const g = this.at(r, c);
      if (!g || seen.has(g)) continue;
      seen.add(g);
      if (g.colSpan > 1) setSpan(g.el, 'colspan', g.colSpan - 1); else g.el.remove();
    }
    this.table.querySelectorAll(':scope > colgroup').forEach((cg) => {
      const cols = [...cg.querySelectorAll('col')];
      let x = 0;
      for (const col of cols) { const s = Math.max(1, parseInt(col.getAttribute('span') || '1', 10) || 1); if (c >= x && c < x + s) { if (s > 1) col.setAttribute('span', String(s - 1)); else col.remove(); break; } x += s; }
    });
    this.refresh();
    this.cleanup();
  }

  /** Removes the cells of a rectangle, rows and columns left empty go too. */
  deleteRect(rect: CellRect): void {
    const fullRows = rect.c1 === 0 && rect.c2 >= this.width - 1;
    const fullCols = rect.r1 === 0 && rect.r2 >= this.height - 1;
    if (fullRows) { for (let r = rect.r2; r >= rect.r1; r--) { this.refresh(); this.deleteRow(r); } return; }
    if (fullCols) { for (let c = rect.c2; c >= rect.c1; c--) { this.refresh(); this.deleteCol(c); } return; }
    for (const g of this.cellsIn(rect)) g.el.remove();
    this.refresh();
    this.cleanup();
  }

  /**
   * Merges every cell of a rectangle into its top-left cell. The rectangle grows to cut no cell.
   * Contents are kept in reading order (empty cells add nothing). Returns the merged cell.
   */
  merge(rect: CellRect): HTMLTableCellElement | null {
    rect = this.expand(rect);
    const cells = this.cellsIn(rect);
    if (!cells.length) return null;
    const first = this.at(rect.r1, rect.c1)!;
    for (const g of cells) {
      if (g === first) continue;
      if (hasContent(g.el)) {
        if (hasContent(first.el)) {
          const block = [...first.el.children].some((x) => /^(P|DIV|UL|OL|TABLE|H[1-6])$/.test(x.tagName));
          if (!block) first.el.appendChild(this.doc.createElement('br'));
        } else first.el.textContent = '';
        while (g.el.firstChild) first.el.appendChild(g.el.firstChild);
      }
      g.el.remove();
    }
    setSpan(first.el, 'rowspan', rect.r2 - rect.r1 + 1);
    setSpan(first.el, 'colspan', rect.c2 - rect.c1 + 1);
    this.refresh();
    this.cleanup();
    return first.el;
  }

  /** Splits a cell into `rows` × `cols` cells. Other cells grow when the cell spans fewer slots. */
  split(el: HTMLTableCellElement, rows: number, cols: number): HTMLTableCellElement[] {
    rows = Math.max(1, Math.floor(rows)); cols = Math.max(1, Math.floor(cols));
    const pieces = this.splitCols(el, cols);
    if (rows === 1) return pieces;
    const out: HTMLTableCellElement[] = [];
    for (const p of pieces) out.push(...this.splitRows(p, rows));
    return out;
  }

  splitCols(el: HTMLTableCellElement, n: number): HTMLTableCellElement[] {
    let g = this.find(el);
    if (!g || n <= 1) return g ? [g.el] : [];
    if (g.colSpan < n) {
      const extra = n - g.colSpan;
      const last = g.col + g.colSpan - 1;
      const seen = new Set<GridCell>([g]);
      for (let r = 0; r < this.height; r++) {
        const o = this.at(r, last);
        if (o && !seen.has(o)) { seen.add(o); setSpan(o.el, 'colspan', o.colSpan + extra); }
      }
      setSpan(g.el, 'colspan', n);
      this.refresh();
      g = this.find(el)!;
    }
    const parts = distribute(g.colSpan, n);
    setSpan(g.el, 'colspan', parts[0]);
    const out = [g.el];
    let prev: Element = g.el;
    for (const s of parts.slice(1)) {
      const cell = this.newCell(g.el.tagName.toLowerCase(), g.el);
      setSpan(cell, 'colspan', s);
      setSpan(cell, 'rowspan', g.rowSpan);
      prev.after(cell);
      prev = cell;
      out.push(cell);
    }
    this.refresh();
    return out;
  }

  splitRows(el: HTMLTableCellElement, n: number): HTMLTableCellElement[] {
    let g = this.find(el);
    if (!g || n <= 1) return g ? [g.el] : [];
    if (g.rowSpan < n) {
      const extra = n - g.rowSpan;
      const last = g.row + g.rowSpan - 1;
      const seen = new Set<GridCell>([g]);
      for (let c = 0; c < this.width; c++) {
        const o = this.at(last, c);
        if (o && !seen.has(o)) { seen.add(o); setSpan(o.el, 'rowspan', o.rowSpan + extra); }
      }
      let after: Element = this.rows[last];
      for (let i = 0; i < extra; i++) { const tr = this.doc.createElement('tr'); after.after(tr); after = tr; }
      setSpan(g.el, 'rowspan', n);
      this.refresh();
      g = this.find(el)!;
    }
    const parts = distribute(g.rowSpan, n);
    setSpan(g.el, 'rowspan', parts[0]);
    const out = [g.el];
    const col = g.col;
    let r = g.row + parts[0];
    const add: [number, HTMLTableCellElement][] = [];
    for (const s of parts.slice(1)) {
      const cell = this.newCell(g.el.tagName.toLowerCase(), g.el);
      setSpan(cell, 'rowspan', s);
      setSpan(cell, 'colspan', g.colSpan);
      add.push([r, cell]);
      out.push(cell);
      r += s;
    }
    for (const [row, cell] of add) this.placeInRow(row, col, cell);
    this.refresh();
    return out;
  }

  /** Makes a cell span one more row (merging the cells below it into it). */
  growRowSpan(el: HTMLTableCellElement): boolean {
    const g = this.find(el);
    if (!g || g.row + g.rowSpan >= this.height) return false;
    this.merge({ r1: g.row, c1: g.col, r2: g.row + g.rowSpan, c2: g.col + g.colSpan - 1 });
    return true;
  }
  growColSpan(el: HTMLTableCellElement): boolean {
    const g = this.find(el);
    if (!g || g.col + g.colSpan >= this.width) return false;
    this.merge({ r1: g.row, c1: g.col, r2: g.row + g.rowSpan - 1, c2: g.col + g.colSpan });
    return true;
  }
  /** Makes a cell span one row fewer; the freed slots get new empty cells. */
  shrinkRowSpan(el: HTMLTableCellElement): boolean {
    const g = this.find(el);
    if (!g || g.rowSpan <= 1) return false;
    setSpan(g.el, 'rowspan', g.rowSpan - 1);
    const r = g.row + g.rowSpan - 1;
    this.refresh();
    const cell = this.newCell(g.el.tagName.toLowerCase(), g.el);
    setSpan(cell, 'colspan', g.colSpan);
    this.placeInRow(r, g.col, cell);
    this.refresh();
    return true;
  }
  shrinkColSpan(el: HTMLTableCellElement): boolean {
    const g = this.find(el);
    if (!g || g.colSpan <= 1) return false;
    setSpan(g.el, 'colspan', g.colSpan - 1);
    const cell = this.newCell(g.el.tagName.toLowerCase(), g.el);
    setSpan(cell, 'rowspan', g.rowSpan);
    g.el.after(cell);
    this.refresh();
    return true;
  }

  /**
   * Cuts every rowspan that crosses the line above row `b`: the part below the line becomes a new empty
   * cell in row b, so the rows from b down can be moved to another table.
   */
  cutRows(b: number): void {
    if (b <= 0 || b >= this.height) return;
    const seen = new Set<GridCell>();
    const add: [number, HTMLTableCellElement][] = [];
    for (let c = 0; c < this.width; c++) {
      const g = this.at(b, c);
      if (!g || seen.has(g) || g.row >= b) continue;
      seen.add(g);
      const below = g.row + g.rowSpan - b;
      setSpan(g.el, 'rowspan', b - g.row);
      const cell = this.newCell(g.el.tagName.toLowerCase(), g.el);
      setSpan(cell, 'rowspan', below);
      setSpan(cell, 'colspan', g.colSpan);
      add.push([g.col, cell]);
    }
    for (const [col, cell] of add) this.placeInRow(b, col, cell);
    this.refresh();
  }

  /** Fills ragged rows with empty cells so every row covers the full width. */
  fillHoles(): number {
    let added = 0;
    for (let r = 0; r < this.height; r++) for (let c = 0; c < this.width; c++) {
      if (!this.at(r, c)) { this.rows[r].appendChild(this.newCell('td')); added++; this.refresh(); }
    }
    return added;
  }

  /**
   * Removes rows that hold no cell of their own (every slot is covered by a rowspan from above) and
   * shrinks the spans across them; drops the table when no cells remain.
   */
  cleanup(): void {
    for (let r = this.height - 1; r >= 0; r--) {
      const tr = this.rows[r];
      if (rowCells(tr).length) continue;
      const seen = new Set<GridCell>();
      for (let c = 0; c < this.width; c++) { const g = this.at(r, c); if (g && !seen.has(g)) { seen.add(g); setSpan(g.el, 'rowspan', g.rowSpan - 1); } }
      const parent = tr.parentElement;
      tr.remove();
      if (parent && parent !== this.table && !parent.querySelector('tr')) parent.remove();
      this.refresh();
    }
    // A column covered only by colspans (nothing starts in it) is merged away.
    for (let c = this.width - 1; c > 0; c--) {
      let starts = false;
      for (let r = 0; r < this.height && !starts; r++) { const g = this.at(r, c); if (!g || g.col === c) starts = true; }
      if (starts) continue;
      const seen = new Set<GridCell>();
      for (let r = 0; r < this.height; r++) { const g = this.at(r, c); if (g && !seen.has(g)) { seen.add(g); setSpan(g.el, 'colspan', g.colSpan - 1); } }
      this.refresh();
    }
    if (!this.cells.length) this.table.remove();
  }

  /** Text of every slot (spanned cells repeat), for export and tests. */
  textMatrix(): string[][] {
    return this.slots.map((row) => row.map((g) => (g ? (g.el.textContent || '').trim() : '')));
  }
}

function hasContent(el: Element): boolean {
  if ((el.textContent || '').replace(/ /g, ' ').trim()) return true;
  return !!el.querySelector('img,iframe,video,audio,object,embed,input,select,textarea,table,svg,canvas');
}

// ------------------------------------------------------------------------------------------
// Table markup and data helpers (pure)

export interface TableSpec {
  rows: number;
  cols: number;
  width?: string;
  border?: number;
  padding?: number;
  spacing?: number;
  headerRow?: boolean;
  headerCol?: boolean;
  caption?: string;
  description?: string;
  /** 'css' writes inline styles; 'attrs' writes the classic presentational attributes. */
  styleMode?: 'css' | 'attrs';
  className?: string;
  cells?: string[][];
  id?: string;
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttrV = (s: string) => escText(s).replace(/"/g, '&quot;');

/** Markup for a new table. Header cells carry scope; an optional description is linked with aria-describedby. */
export function tableMarkup(s: TableSpec): string {
  const rows = Math.max(1, Math.min(500, Math.floor(s.rows || 1)));
  const cols = Math.max(1, Math.min(100, Math.floor(s.cols || 1)));
  const css = s.styleMode !== 'attrs';
  const tAttrs: string[] = [];
  const tStyle: string[] = [];
  const cStyle: string[] = [];
  if (s.className) tAttrs.push(`class="${escAttrV(s.className)}"`);
  if (s.id) tAttrs.push(`id="${escAttrV(s.id)}"`);
  const descId = s.description ? `${s.id || 'table'}-desc-${Math.random().toString(36).slice(2, 7)}` : '';
  if (descId) tAttrs.push(`aria-describedby="${descId}"`);
  if (css) {
    if (s.width) tStyle.push(`width: ${s.width}`);
    if (s.border) { tStyle.push(`border: ${s.border}px solid #808080`); cStyle.push(`border: ${s.border}px solid #808080`); }
    if (s.spacing != null && s.spacing >= 0) tStyle.push(s.spacing === 0 ? 'border-collapse: collapse' : `border-spacing: ${s.spacing}px`);
    if (s.padding != null && s.padding >= 0) cStyle.push(`padding: ${s.padding}px`);
    if (tStyle.length) tAttrs.push(`style="${tStyle.join('; ')}"`);
  } else {
    if (s.width) tAttrs.push(`width="${escAttrV(s.width.replace(/px$/, ''))}"`);
    if (s.border != null) tAttrs.push(`border="${s.border}"`);
    if (s.padding != null) tAttrs.push(`cellpadding="${s.padding}"`);
    if (s.spacing != null) tAttrs.push(`cellspacing="${s.spacing}"`);
  }
  const cs = cStyle.length ? ` style="${cStyle.join('; ')}"` : '';
  const text = (r: number, c: number) => {
    const v = s.cells?.[r]?.[c];
    return v == null || v === '' ? '&nbsp;' : escText(v);
  };
  const out: string[] = [];
  out.push(`<table${tAttrs.length ? ' ' + tAttrs.join(' ') : ''}>`);
  if (s.caption) out.push(`  <caption>${escText(s.caption)}</caption>`);
  let r0 = 0;
  if (s.headerRow) {
    out.push('  <thead>', '    <tr>');
    for (let c = 0; c < cols; c++) out.push(`      <th scope="col"${cs}>${text(0, c)}</th>`);
    out.push('    </tr>', '  </thead>');
    r0 = 1;
  }
  out.push('  <tbody>');
  for (let r = r0; r < rows; r++) {
    out.push('    <tr>');
    for (let c = 0; c < cols; c++) {
      if (c === 0 && s.headerCol) out.push(`      <th scope="row"${cs}>${text(r, c)}</th>`);
      else out.push(`      <td${cs}>${text(r, c)}</td>`);
    }
    out.push('    </tr>');
  }
  if (r0 >= rows) out.push('    <tr>' + Array.from({ length: cols }, () => `<td${cs}>&nbsp;</td>`).join('') + '</tr>');
  out.push('  </tbody>', '</table>');
  const table = out.join('\n');
  return descId ? `<p id="${descId}">${escText(s.description!)}</p>\n${table}` : table;
}

/** Parses delimited text (CSV-style quoting) into rows. `sep` is ',', '\t', ';', '|' or any string. */
export function parseDelimited(text: string, sep: string): string[][] {
  text = text.replace(/\r\n?/g, '\n');
  if (!sep) return text.split('\n').filter((l) => l.trim()).map((l) => [l]);
  const rows: string[][] = [];
  let row: string[] = [], cell = '', i = 0, quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (text.startsWith(sep, i)) { row.push(cell); cell = ''; i += sep.length; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Guesses the separator of tabular text: tab, comma, semicolon or pipe. */
export function guessSeparator(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts: [string, number][] = (['\t', ',', ';', '|'] as const).map((s) => [s, sample.split(s).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ',';
}

/** Rows of text as table rows, padded to the widest row. */
export function padRows(rows: string[][]): string[][] {
  const w = Math.max(1, ...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...Array(w - r.length).fill('')]);
}

export type SortType = 'auto' | 'text' | 'number' | 'date';

/** A comparable key for a cell's text. */
export function sortKey(text: string, type: SortType): string | number {
  const t = text.trim();
  if (type === 'text') return t.toLocaleLowerCase();
  if (type === 'date') { const d = Date.parse(t); return Number.isNaN(d) ? Number.POSITIVE_INFINITY : d; }
  const n = parseFloat(t.replace(/[,$€£¥%\s]/g, ''));
  if (type === 'number') return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
  return t.toLocaleLowerCase();
}

/** Picks number, date or text for a column of values. */
export function detectSortType(values: string[]): Exclude<SortType, 'auto'> {
  const v = values.map((x) => x.trim()).filter(Boolean);
  if (!v.length) return 'text';
  if (v.every((x) => /^[-+]?[$€£¥]?\s*[\d,]*\.?\d+\s*%?$/.test(x))) return 'number';
  if (v.every((x) => /\d/.test(x) && !Number.isNaN(Date.parse(x)))) return 'date';
  return 'text';
}

/** Order of rows sorted by column texts (stable). Returns the permutation of indices. */
export function sortOrder(texts: string[], type: SortType, descending = false): number[] {
  const t = type === 'auto' ? detectSortType(texts) : type;
  const keys = texts.map((x) => sortKey(x, t));
  const idx = texts.map((_, i) => i);
  idx.sort((a, b) => {
    const ka = keys[a], kb = keys[b];
    let d = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), undefined, { numeric: true });
    if (Number.isNaN(d)) d = 0;
    return (descending ? -d : d) || a - b;
  });
  return idx;
}

// ------------------------------------------------------------------------------------------
// Conversions

/** A table as a CSS grid of divs. `semantic` keeps table roles (row groups use display: contents). */
export function tableToGridMarkup(table: HTMLTableElement, opts: { semantic: boolean; className?: string } = { semantic: true }): string {
  const g = new TableGrid(table);
  const cls = opts.className || (opts.semantic ? 'data-grid' : 'layout-grid');
  const caption = table.querySelector(':scope > caption');
  const widths: string[] = [];
  for (let c = 0; c < g.width; c++) {
    const one = g.cells.find((x) => x.col === c && x.colSpan === 1 && (x.el.getAttribute('width') || /width\s*:/.test(x.el.getAttribute('style') || '')));
    let w = one ? (one.el.getAttribute('width') || /width\s*:\s*([^;]+)/.exec(one.el.getAttribute('style') || '')?.[1] || '').trim() : '';
    if (/^\d+$/.test(w)) w += 'px';
    widths.push(w || 'auto');
  }
  const cols = widths.every((w) => w === 'auto') ? `repeat(${g.width}, auto)` : widths.join(' ');
  const out: string[] = [];
  const attrs = opts.semantic ? ` role="table"${caption ? ' aria-label="' + escAttrV((caption.textContent || '').trim()) + '"' : ''}` : '';
  out.push(`<div class="${cls}"${attrs} style="display: grid; grid-template-columns: ${cols}">`);
  const inner = (el: Element) => (el.innerHTML || '').trim();
  const pos = (x: GridCell) => `grid-column: ${x.col + 1}${x.colSpan > 1 ? ` / span ${x.colSpan}` : ''}; grid-row: ${x.row + 1}${x.rowSpan > 1 ? ` / span ${x.rowSpan}` : ''}`;
  if (caption && !opts.semantic) out.push(`  <div style="grid-column: 1 / -1">${inner(caption)}</div>`);
  const offset = caption && !opts.semantic ? 1 : 0;
  g.rows.forEach((tr, r) => {
    const cells = g.cells.filter((x) => x.row === r);
    if (opts.semantic) out.push('  <div role="row" style="display: contents">');
    for (const x of cells) {
      const isHead = x.el.tagName === 'TH';
      const scope = x.el.getAttribute('scope') || (isHead && x.row === 0 ? 'col' : isHead ? 'row' : '');
      const role = opts.semantic ? ` role="${isHead ? (scope === 'row' ? 'rowheader' : 'columnheader') : 'cell'}"` : '';
      const style = offset ? pos({ ...x, row: x.row + offset }) : pos(x);
      const extra = x.el.getAttribute('style') ? '; ' + x.el.getAttribute('style')!.replace(/;\s*$/, '') : '';
      out.push(`${opts.semantic ? '    ' : '  '}<div${role} style="${escAttrV(style + extra)}">${inner(x.el)}</div>`);
    }
    if (opts.semantic) out.push('  </div>');
  });
  out.push('</div>');
  return out.join('\n');
}

export interface Box { x: number; y: number; w: number; h: number; html: string }

/**
 * Lays out absolutely positioned boxes as a table: the box edges become row and column lines, each box
 * a cell spanning the slots it covers, the gaps empty cells. Overlapping boxes go into the cell of the
 * box they overlap. Returns markup with column widths and row heights in pixels.
 */
export function boxesToTable(boxes: Box[]): string {
  if (!boxes.length) return '';
  const xs = [...new Set(boxes.flatMap((b) => [b.x, b.x + b.w]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap((b) => [b.y, b.y + b.h]))].sort((a, b) => a - b);
  const W = xs.length - 1, H = ys.length - 1;
  const owner: (number | null)[][] = Array.from({ length: H }, () => Array(W).fill(null));
  const extra = new Map<number, string[]>();
  const placed: { i: number; r: number; c: number; rs: number; cs: number }[] = [];
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].y - boxes[b].y || boxes[a].x - boxes[b].x);
  for (const i of order) {
    const b = boxes[i];
    const c1 = xs.indexOf(b.x), c2 = xs.indexOf(b.x + b.w) - 1;
    const r1 = ys.indexOf(b.y), r2 = ys.indexOf(b.y + b.h) - 1;
    if (c2 < c1 || r2 < r1) continue;
    let clash: number | null = null;
    for (let r = r1; r <= r2 && clash == null; r++) for (let c = c1; c <= c2; c++) if (owner[r][c] != null) { clash = owner[r][c]; break; }
    if (clash != null) { (extra.get(clash) || extra.set(clash, []).get(clash)!).push(b.html); continue; }
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) owner[r][c] = i;
    placed.push({ i, r: r1, c: c1, rs: r2 - r1 + 1, cs: c2 - c1 + 1 });
  }
  const left = xs[0], top = ys[0];
  const out: string[] = [];
  out.push(`<table role="presentation" style="border-collapse: collapse; margin-left: ${left}px; margin-top: ${top}px">`);
  out.push('  <colgroup>' + xs.slice(1).map((x, j) => `<col style="width: ${x - xs[j]}px">`).join('') + '</colgroup>');
  out.push('  <tbody>');
  for (let r = 0; r < H; r++) {
    out.push(`    <tr style="height: ${ys[r + 1] - ys[r]}px">`);
    for (let c = 0; c < W; c++) {
      const o = owner[r][c];
      if (o == null) { out.push('      <td></td>'); continue; }
      const p = placed.find((x) => x.i === o)!;
      if (p.r !== r || p.c !== c) continue;
      const span = (p.rs > 1 ? ` rowspan="${p.rs}"` : '') + (p.cs > 1 ? ` colspan="${p.cs}"` : '');
      out.push(`      <td${span} style="vertical-align: top">${boxes[o].html}${(extra.get(o) || []).join('')}</td>`);
    }
    out.push('    </tr>');
  }
  out.push('  </tbody>', '</table>');
  return out.join('\n');
}
