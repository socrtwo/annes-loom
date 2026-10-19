import { describe, it, expect } from 'vitest';
import {
  TableGrid, tableMarkup, parseDelimited, guessSeparator, padRows, sortOrder, detectSortType, distribute,
  tableToGridMarkup, boxesToTable, ownRows,
} from '../../src/model/tableGrid';

function table(html: string): HTMLTableElement {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return doc.querySelector('table')!;
}

/** Text matrix of a table; cells covered by a span repeat the spanning cell's text. */
const m = (t: HTMLTableElement) => new TableGrid(t).textMatrix();

const T3 = '<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td><td>f</td></tr><tr><td>g</td><td>h</td><td>i</td></tr></tbody></table>';

describe('TableGrid', () => {
  it('maps rowspan and colspan to slots', () => {
    const t = table('<table><tr><td rowspan="2">a</td><td colspan="2">b</td></tr><tr><td>c</td><td>d</td></tr></table>');
    const g = new TableGrid(t);
    expect(g.width).toBe(3);
    expect(g.height).toBe(2);
    expect(g.textMatrix()).toEqual([['a', 'b', 'b'], ['a', 'c', 'd']]);
    expect(g.find(t.querySelectorAll('td')[2])!.col).toBe(1);
  });

  it('ignores rows of nested tables', () => {
    const t = table('<table><tr><td><table><tr><td>x</td></tr><tr><td>y</td></tr></table></td></tr></table>');
    expect(ownRows(t).length).toBe(1);
  });

  it('inserts rows above and below, growing rowspans that cross', () => {
    const t = table('<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>');
    const g = new TableGrid(t);
    g.insertRow(0, true); // between the two rows: the rowspan crosses
    expect(t.querySelector('td')!.getAttribute('rowspan')).toBe('3');
    expect(g.height).toBe(3);
    expect(g.width).toBe(2);
    g.insertRow(0, false); // above the first row: a full new row
    expect(g.height).toBe(4);
    expect(g.rows[0].children.length).toBe(2);
  });

  it('inserts columns left and right, growing colspans that cross', () => {
    const t = table('<table><tr><td colspan="2">a</td></tr><tr><td>b</td><td>c</td></tr></table>');
    const g = new TableGrid(t);
    g.insertCol(0, true);
    expect(t.querySelector('td')!.getAttribute('colspan')).toBe('3');
    expect(g.width).toBe(3);
    expect(g.textMatrix()[1]).toEqual(['b', '', 'c']);
    g.insertCol(0, false);
    expect(g.textMatrix()[1]).toEqual(['', 'b', '', 'c']);
  });

  it('deletes rows, moving cells that start there with a rowspan', () => {
    const t = table('<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr><tr><td>d</td><td>e</td></tr></table>');
    const g = new TableGrid(t);
    g.deleteRow(0);
    expect(m(t)).toEqual([['a', 'c'], ['d', 'e']]);
    expect(t.querySelector('td')!.hasAttribute('rowspan')).toBe(false);
  });

  it('deletes columns, shrinking colspans', () => {
    const t = table('<table><tr><td colspan="2">a</td><td>b</td></tr><tr><td>c</td><td>d</td><td>e</td></tr></table>');
    const g = new TableGrid(t);
    g.deleteCol(1);
    expect(m(t)).toEqual([['a', 'b'], ['c', 'e']]);
  });

  it('merges a rectangle into its top-left cell, keeping contents', () => {
    const t = table(T3);
    const g = new TableGrid(t);
    const cell = g.merge({ r1: 0, c1: 0, r2: 1, c2: 1 })!;
    expect(cell.getAttribute('rowspan')).toBe('2');
    expect(cell.getAttribute('colspan')).toBe('2');
    expect(cell.textContent).toBe('abde');
    expect(m(t)).toEqual([['abde', 'abde', 'c'], ['abde', 'abde', 'f'], ['g', 'h', 'i']]);
  });

  it('expands a merge rectangle that would cut a spanned cell', () => {
    const t = table('<table><tr><td>a</td><td rowspan="2">b</td></tr><tr><td>c</td></tr></table>');
    const g = new TableGrid(t);
    g.merge({ r1: 0, c1: 0, r2: 0, c2: 1 });
    // The rowspan of b forces the second row in: the whole table becomes one cell, and the empty row goes.
    expect(g.height).toBe(1);
    expect(g.cells.length).toBe(1);
    expect(t.querySelector('td')!.textContent).toBe('abc');
  });

  it('splits a cell into rows and columns', () => {
    const t = table(T3);
    const g = new TableGrid(t);
    const e = t.querySelectorAll('td')[4] as HTMLTableCellElement;
    const parts = g.split(e, 2, 2);
    expect(parts.length).toBe(4);
    expect(g.width).toBe(4);
    expect(g.height).toBe(4);
    // Neighbors grew to keep the shape.
    expect(t.querySelectorAll('td')[1].getAttribute('colspan')).toBe('2');
    expect(t.querySelectorAll('td')[3].getAttribute('rowspan')).toBe('2');
  });

  it('splits a spanned cell back into its slots without growing the table', () => {
    const t = table('<table><tr><td colspan="3">a</td></tr><tr><td>b</td><td>c</td><td>d</td></tr></table>');
    const g = new TableGrid(t);
    g.split(t.querySelector('td')!, 1, 3);
    expect(g.width).toBe(3);
    expect(g.rows[0].children.length).toBe(3);
  });

  it('grows and shrinks spans', () => {
    const t = table(T3);
    const g = new TableGrid(t);
    const a = t.querySelector('td')!;
    expect(g.growColSpan(a)).toBe(true);
    expect(a.getAttribute('colspan')).toBe('2');
    expect(g.growRowSpan(a)).toBe(true);
    expect(a.getAttribute('rowspan')).toBe('2');
    expect(g.shrinkColSpan(a)).toBe(true);
    expect(g.shrinkRowSpan(a)).toBe(true);
    expect(g.width).toBe(3);
    expect(g.height).toBe(3);
    // The cell freed by shrinking the column keeps the two-row span; shrinking the row frees one slot.
    expect(g.cells.length).toBe(8);
    expect(g.slots.every((r) => r.every(Boolean))).toBe(true);
  });

  it('deletes a rectangle of whole rows', () => {
    const t = table(T3);
    const g = new TableGrid(t);
    g.deleteRect({ r1: 1, c1: 0, r2: 1, c2: 2 });
    expect(m(t)).toEqual([['a', 'b', 'c'], ['g', 'h', 'i']]);
  });

  it('fills ragged rows', () => {
    const t = table('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>');
    const g = new TableGrid(t);
    expect(g.fillHoles()).toBe(1);
    expect(g.rows[1].children.length).toBe(2);
  });
});

describe('table helpers', () => {
  it('builds accessible table markup', () => {
    const html = tableMarkup({ rows: 3, cols: 2, headerRow: true, headerCol: true, caption: 'Prices', description: 'Monthly prices', width: '100%', border: 1, padding: 4, spacing: 0 });
    const t = table(html);
    expect(t.querySelector('caption')!.textContent).toBe('Prices');
    expect(t.querySelectorAll('thead th[scope="col"]').length).toBe(2);
    expect(t.querySelectorAll('tbody th[scope="row"]').length).toBe(2);
    const desc = t.getAttribute('aria-describedby')!;
    expect(t.ownerDocument.getElementById(desc)!.textContent).toBe('Monthly prices');
    expect(t.getAttribute('style')).toContain('border-collapse: collapse');
    const legacy = table(tableMarkup({ rows: 1, cols: 1, border: 2, padding: 3, spacing: 1, styleMode: 'attrs' }));
    expect(legacy.getAttribute('border')).toBe('2');
    expect(legacy.getAttribute('cellpadding')).toBe('3');
  });

  it('parses delimited text with quotes', () => {
    expect(parseDelimited('a,"b,c",d\n"e ""q""",f\n', ',')).toEqual([['a', 'b,c', 'd'], ['e "q"', 'f']]);
    expect(parseDelimited('x\ty\nz\tw', '\t')).toEqual([['x', 'y'], ['z', 'w']]);
    expect(guessSeparator('a\tb\nc\td')).toBe('\t');
    expect(guessSeparator('a;b;c')).toBe(';');
    expect(padRows([['a'], ['b', 'c']])).toEqual([['a', ''], ['b', 'c']]);
  });

  it('sorts numbers, dates and text', () => {
    expect(detectSortType(['10', '2', '$3.50'])).toBe('number');
    expect(detectSortType(['2024-01-02', '2023-05-01'])).toBe('date');
    expect(sortOrder(['10', '2', '33'], 'auto')).toEqual([1, 0, 2]);
    expect(sortOrder(['b', 'A', 'c'], 'text', true)).toEqual([2, 0, 1]);
    expect(sortOrder(['2024-01-02', '2023-05-01'], 'date')).toEqual([1, 0]);
    expect(distribute(5, 2)).toEqual([3, 2]);
  });

  it('converts a table to a CSS grid with spans', () => {
    const t = table('<table><tr><th>A</th><th>B</th></tr><tr><td colspan="2">x</td></tr></table>');
    const semantic = tableToGridMarkup(t, { semantic: true });
    expect(semantic).toContain('role="table"');
    expect(semantic).toContain('role="columnheader"');
    expect(semantic).toContain('grid-column: 1 / span 2');
    const layout = tableToGridMarkup(t, { semantic: false });
    expect(layout).not.toContain('role=');
    expect(layout).toContain('grid-template-columns: repeat(2, auto)');
  });

  it('lays out positioned boxes as a table', () => {
    const html = boxesToTable([
      { x: 0, y: 0, w: 200, h: 50, html: 'head' },
      { x: 0, y: 50, w: 50, h: 100, html: 'side' },
      { x: 50, y: 50, w: 150, h: 100, html: 'main' },
    ]);
    const t = table(html);
    expect(new TableGrid(t).textMatrix()).toEqual([['head', 'head'], ['side', 'main']]);
    expect(t.querySelector('td')!.getAttribute('colspan')).toBe('2');
    expect(t.getAttribute('role')).toBe('presentation');
  });
});
