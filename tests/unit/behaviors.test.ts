import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateBehaviorScript, generateValidationScript, parseBehaviors, serializeBehaviors, scriptSafe, describeBehavior, ACTIONS, jumpMenuHandler, type Behavior,
} from '../../src/editor/behaviors';
import { parseCsv, detectDelimiter, matrixToData, jsonToData, xmlToData, parseData, renderView, queryRows, parseRules, formatRules, rulesCss, matchOp, liveScript, searchScript, tableToData, compareCells } from '../../src/commands/data';
import { parseOptions, formatOptions, optionsHtml, fieldMarkup, formAttrs } from '../../src/commands/form';
import { parseFrameset, serializeFrameset, framesetPage, LAYOUTS, splitSize } from '../../src/commands/frames';

/** Compiles generated script text (throws on a syntax error). */
const compile = (js: string) => new Function(js);

function runOnPage(html: string, list?: Behavior[]): void {
  document.body.innerHTML = html;
  delete (window as any).__qlBehaviors;
  const all = list ?? [...document.querySelectorAll('[data-ql-behaviors]')].flatMap((e) => parseBehaviors(e.getAttribute('data-ql-behaviors')));
  compile(generateBehaviorScript(all))();
}
const attr = (list: Behavior[]) => serializeBehaviors(list)!.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

describe('behavior data', () => {
  it('round-trips and rejects bad attribute values', () => {
    const list: Behavior[] = [{ event: 'click', action: 'popupMessage', params: { message: 'Hi "there"' } }];
    expect(parseBehaviors(serializeBehaviors(list))).toEqual(list);
    expect(parseBehaviors('not json')).toEqual([]);
    expect(parseBehaviors('{"a":1}')).toEqual([]);
    expect(parseBehaviors('[{"event":"click"},{"event":"click","action":"x"}]')).toEqual([{ event: 'click', action: 'x', params: {} }]);
    expect(serializeBehaviors([])).toBeNull();
    expect(describeBehavior(list[0])).toContain('Popup Message');
  });
});

describe('behavior script generator', () => {
  beforeEach(() => { delete (window as any).__qlBehaviors; });

  it('returns nothing without behaviors and only includes used actions', () => {
    expect(generateBehaviorScript([])).toBe('');
    const js = generateBehaviorScript([{ event: 'click', action: 'popupMessage', params: { message: 'x' } }]);
    expect(js).toContain('popupMessage');
    expect(js).not.toContain('swapImage');
    expect(js).not.toContain('function draggable');
  });

  it('generates valid JavaScript for every action', () => {
    const all: Behavior[] = ACTIONS.map((a) => ({ event: a.event || 'click', action: a.id, params: Object.fromEntries(a.params.map((p) => [p.key, p.value ?? 'x'])) }));
    all.push({ event: 'click', action: 'callScript', params: { code: 'element.title = "</script> safe";\nreturn false;' } });
    const js = generateBehaviorScript(all);
    expect(() => compile(js)).not.toThrow();
    expect(js).not.toMatch(/<\/script/i);
  });

  it('wires a popup message to a click and is idempotent', () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    runOnPage(`<button id="b" data-ql-behaviors="${attr([{ event: 'click', action: 'popupMessage', params: { message: 'Hello' } }])}">Go</button>`);
    // A second copy of the script does nothing.
    compile(generateBehaviorScript([{ event: 'click', action: 'popupMessage', params: { message: 'Hello' } }]))();
    document.getElementById('b')!.click();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('Hello');
    alert.mockRestore();
  });

  it('shows, hides and toggles elements', () => {
    runOnPage(`<a id="t" href="#" data-ql-behaviors="${attr([{ event: 'click', action: 'showHide', params: { show: 'a', hide: 'b', toggle: 'c' } }])}">x</a><div id="a" hidden></div><div id="b"></div><div id="c"></div>`);
    document.getElementById('t')!.click();
    expect(document.getElementById('a')!.hidden).toBe(false);
    expect(document.getElementById('b')!.hidden).toBe(true);
    expect(document.getElementById('c')!.hidden).toBe(true);
  });

  it('swaps and restores an image, changes properties and sets text', () => {
    runOnPage(`<img id="i" src="a.png" alt="" data-ql-behaviors="${attr([{ event: 'mouseover', action: 'swapImage', params: { src: 'b.png', restore: true } }])}">
      <p id="p" data-ql-behaviors="${attr([{ event: 'click', action: 'changeProperty', params: { property: 'color', value: 'red' } }, { event: 'dblclick', action: 'setText', params: { kind: 'element', target: 'out', text: 'Done' } }])}">p</p><span id="out"></span>`);
    const img = document.getElementById('i')!;
    img.dispatchEvent(new MouseEvent('mouseover'));
    expect(img.getAttribute('src')).toBe('b.png');
    img.dispatchEvent(new MouseEvent('mouseout'));
    expect(img.getAttribute('src')).toBe('a.png');
    const p = document.getElementById('p')!;
    p.click();
    expect(p.style.color).toBe('red');
    p.dispatchEvent(new MouseEvent('dblclick'));
    expect(document.getElementById('out')!.textContent).toBe('Done');
  });

  it('validates a form and cancels the submit', () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    runOnPage(`<form id="f" data-ql-behaviors="${attr([{ event: 'submit', action: 'validateForm', params: { rules: 'name required\nemail email' } }])}">
      <label for="name">Name:</label><input id="name" name="name"><input id="email" name="email" value="nope"></form>`);
    const ev = new Event('submit', { cancelable: true });
    document.getElementById('f')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(alert.mock.calls[0][0]).toContain('Name is required.');
    expect(alert.mock.calls[0][0]).toContain('email must be an email address.');
    (document.getElementById('name') as HTMLInputElement).value = 'Ada';
    (document.getElementById('email') as HTMLInputElement).value = 'ada@example.com';
    const ok = new Event('submit', { cancelable: true });
    document.getElementById('f')!.dispatchEvent(ok);
    expect(ok.defaultPrevented).toBe(false);
    alert.mockRestore();
  });

  it('runs custom scripts and load behaviors', () => {
    runOnPage(`<div id="d" data-ql-behaviors="${attr([{ event: 'load', action: 'callScript', params: { code: 'element.setAttribute("data-ran", "yes");' } }])}"></div>`);
    expect(document.getElementById('d')!.getAttribute('data-ran')).toBe('yes');
  });

  it('makes script text safe inside a script element', () => {
    expect(scriptSafe('a</script>b<!--c')).toBe('a<\\/script>b<\\!--c');
    expect(() => compile(generateValidationScript())).not.toThrow();
    expect(jumpMenuHandler()).toBe('if(this.value)location.href=this.value');
    expect(jumpMenuHandler('main')).toContain("'main'");
  });
});

describe('CSV parser', () => {
  it('handles quotes, escaped quotes, delimiters and line breaks in fields, CRLF and BOM', () => {
    const text = '﻿name,quote,n\r\n"Smith, Ada","She said ""hi""",1\r\n"Line\nbreak",,2\r\n\r\nlast,x,3';
    expect(parseCsv(text)).toEqual([
      ['name', 'quote', 'n'],
      ['Smith, Ada', 'She said "hi"', '1'],
      ['Line\nbreak', '', '2'],
      ['last', 'x', '3'],
    ]);
  });
  it('detects tabs and semicolons, and handles CR-only line ends and a trailing newline', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('"a;b",c')).toBe(',');
    expect(parseCsv('a;b\r1;2\r')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('"",x')).toEqual([['', 'x']]);
  });
  it('builds records with unique column names', () => {
    const d = matrixToData([['A', 'A', ''], ['1', '2', '3'], ['4']]);
    expect(d.columns).toEqual(['A', 'A 2', 'Column 3']);
    expect(d.rows[1]).toEqual({ A: '4', 'A 2': '', 'Column 3': '' });
    expect(matrixToData([['1', '2']], false).columns).toEqual(['Column 1', 'Column 2']);
  });
});

describe('JSON and XML data', () => {
  it('reads arrays of objects, wrapped arrays and values', () => {
    expect(jsonToData('[{"a":1,"b":{"c":2}},{"a":3,"d":null}]')).toEqual({ columns: ['a', 'b', 'd'], rows: [{ a: '1', b: '{"c":2}', d: '' }, { a: '3', b: '', d: '' }] });
    expect(jsonToData('{"items":[{"x":"y"}]}').rows).toEqual([{ x: 'y' }]);
    expect(jsonToData('[1,2]').rows).toEqual([{ value: '1' }, { value: '2' }]);
  });
  it('reads repeating XML elements with attributes', () => {
    const d = xmlToData('<catalog><book id="1"><title>A</title><price>5</price></book><book id="2"><title>B</title><price>7</price></book></catalog>');
    expect(d.columns).toEqual(['id', 'title', 'price']);
    expect(d.rows[1]).toEqual({ id: '2', title: 'B', price: '7' });
    expect(() => xmlToData('<a><b></a>')).toThrow();
  });
});

describe('data views', () => {
  const d = parseData('Name,Team,Score\nAda,Red,10\nBob,Blue,7\nCy,Red,12\nDee,Blue,$1,000', 'csv');
  it('parses the quoted-less money oddity as extra column', () => {
    expect(d.rows[3].Score).toBe('$1');
  });
  const data = parseData('Name,Team,Score\nAda,Red,10\nBob,Blue,7\nCy,Red,12\nDee,Blue,"1,000"', 'csv');

  it('filters, sorts numerically and groups', () => {
    expect(queryRows(data, { sort: { key: 'Score', dir: 'desc' } }).map((r) => r.Name)).toEqual(['Dee', 'Cy', 'Ada', 'Bob']);
    expect(queryRows(data, { filter: { key: 'Score', op: '>', value: '9' } }).map((r) => r.Name)).toEqual(['Ada', 'Cy', 'Dee']);
    expect(queryRows(data, { group: 'Team', sort: { key: 'Name', dir: 'asc' } }).map((r) => r.Name)).toEqual(['Bob', 'Dee', 'Ada', 'Cy']);
    expect(compareCells('9', '10')).toBeLessThan(0);
    expect(matchOp('Hello', 'contains', 'ell')).toBe(true);
    expect(matchOp('', 'empty', '')).toBe(true);
  });

  it('renders an accessible table with caption, header scopes, groups and the config attribute', () => {
    const html = renderView(data, { id: 'dv1', src: 'data/scores.csv', layout: 'table', caption: 'Scores <2024>', group: 'Team' });
    document.body.innerHTML = html;
    const t = document.querySelector('table')!;
    expect(t.id).toBe('dv1');
    expect(t.querySelector('caption')!.textContent).toBe('Scores <2024>');
    expect([...t.querySelectorAll('thead th')].map((th) => th.getAttribute('scope'))).toEqual(['col', 'col']);
    expect(t.querySelectorAll('tbody').length).toBe(2);
    expect(t.querySelector('th[scope=rowgroup]')!.textContent).toBe('Team: Blue');
    expect(JSON.parse(t.getAttribute('data-ql-dataview')!).src).toBe('data/scores.csv');
    expect(tableToData(t).columns).toEqual(['Name', 'Score']);
  });

  it('renders lists and cards, escapes text and links addresses', () => {
    const dd = jsonToData('[{"name":"<b>x</b>","site":"https://example.com/","mail":"a@example.com"}]');
    const cards = renderView(dd, { id: 'c', layout: 'cards' });
    expect(cards).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(cards).toContain('<a href="https://example.com/">');
    expect(cards).toContain('href="mailto:a@example.com"');
    expect(cards).not.toContain('data-ql-dataview');
    expect(renderView(dd, { id: 'l', layout: 'list' })).toContain('<ul>');
    expect(renderView(data, { id: 'v', layout: 'value', column: 'Score', match: { key: 'Name', value: 'cy' } })).toContain('>12</span>');
  });

  it('parses conditional formatting rules into classes and CSS', () => {
    const rules = parseRules('Score >= 10 => background: #efe\nTeam = Blue => .blue\n# comment\nbad line');
    expect(rules.length).toBe(2);
    expect(rules[0]).toMatchObject({ col: 'Score', op: '>=', value: '10', css: 'background: #efe' });
    expect(rules[1]).toMatchObject({ col: 'Team', op: '=', value: 'Blue', cls: 'blue' });
    expect(rulesCss(rules)).toBe(`.${rules[0].cls} { background: #efe; }`);
    expect(parseRules(formatRules(rules))).toEqual(rules);
    const html = renderView(data, { id: 'r', layout: 'table', rules });
    expect(html).toContain(`<tr class="${rules[0].cls}"><td>Ada</td>`);
    expect(html).toContain('<tr class="blue"><td>Bob</td>');
  });

  it('generates valid live and search scripts that render the same view', async () => {
    const cfg = { id: 'live1', src: 'data/s.csv', format: 'csv' as const, layout: 'table' as const, sort: { key: 'Score', dir: 'asc' as const } };
    const js = liveScript(cfg);
    expect(() => compile(js)).not.toThrow();
    expect(() => compile(searchScript('q', 'live1', 's'))).not.toThrow();
    document.body.innerHTML = '<div id="live1">static</div>';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('Name,Score\nA,3\nB,1') });
    (window as any).fetch = fetchMock;
    compile(js)();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledWith('data/s.csv', expect.anything());
    expect([...document.querySelectorAll('#live1 tbody td:first-child')].map((t) => t.textContent)).toEqual(['B', 'A']);
    delete (window as any).fetch;
  });
});

describe('form helpers', () => {
  it('parses and writes option lists with groups and selection', () => {
    const items = parseOptions('*Choose… = \n[Fruit]\nApple = a\nPear\n[]\nOther = o');
    expect(items).toEqual([
      { label: 'Choose…', value: '', selected: true, group: undefined },
      { label: 'Apple', value: 'a', selected: false, group: 'Fruit' },
      { label: 'Pear', value: 'Pear', selected: false, group: 'Fruit' },
      { label: 'Other', value: 'o', selected: false, group: undefined },
    ]);
    expect(parseOptions(formatOptions(items))).toEqual(items);
    const html = optionsHtml(items);
    expect(html).toContain('<optgroup label="Fruit">');
    expect(html).toContain('<option value="" selected>Choose…</option>');
  });

  it('labels every field and escapes values', () => {
    const t = fieldMarkup('email', { label: 'Email:', name: 'email1', id: 'email1', required: true, placeholder: 'a"b' });
    expect(t).toBe('<p><label for="email1">Email:</label> <input type="email" name="email1" id="email1" required placeholder="a&quot;b"></p>');
    document.body.innerHTML = fieldMarkup('radioGroup', { label: 'Size', name: 'size', options: '*Small = s\nLarge = l' });
    expect(document.querySelector('legend')!.textContent).toBe('Size');
    expect(document.querySelectorAll('input[type=radio][name=size]').length).toBe(2);
    expect((document.getElementById('size_1') as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector('label[for=size_2]')!.textContent).toContain('Large');
    document.body.innerHTML = fieldMarkup('jumpMenu', { label: 'Go to:', name: 'jump1', id: 'jump1', options: 'Home = index.html', go: true, noscript: true });
    expect(document.querySelector('select#jump1 option')!.getAttribute('value')).toBe('index.html');
    expect(document.querySelector('button')!.getAttribute('onclick')).toContain("getElementById('jump1')");
    expect(fieldMarkup('imageButton', { name: 'go', id: 'go', src: 'i.png', alt: 'Send' })).toContain('alt="Send"');
    expect(fieldMarkup('meter', { label: 'Disk', id: 'm', value: 0.5, min: 0, max: 1 })).toContain('<meter id="m" value="0.5" min="0" max="1">');
  });

  it('builds form attributes for each destination', () => {
    expect(formAttrs({ sendTo: 'email', email: 'me@example.com', subject: 'Hi there' })).toMatchObject({ action: 'mailto:me@example.com?subject=Hi%20there', method: 'post', enctype: 'text/plain' });
    expect(formAttrs({ sendTo: 'service', service: 'https://forms.example.com/f/1', method: 'post' })).toMatchObject({ action: 'https://forms.example.com/f/1', method: 'post', 'data-ql-sendto': 'service' });
    expect(formAttrs({ sendTo: 'none', method: 'get', novalidate: true })).toMatchObject({ action: null, method: null, novalidate: '' });
  });
});

describe('frames', () => {
  it('creates a frameset page and edits it as text', () => {
    const layout = LAYOUTS.find((l) => l.id === 'bannerContents')!;
    const page = framesetPage('Site', layout.tree, (n) => `${n}.html`, 'main.html');
    expect(page).toMatch(/^<!DOCTYPE HTML PUBLIC "-\/\/W3C\/\/DTD HTML 4.01 Frameset/);
    const p = parseFrameset(page)!;
    expect(p.root.getAttribute('rows')).toBe('100,*');
    expect([...p.root.querySelectorAll('frame')].map((f) => f.getAttribute('name'))).toEqual(['banner', 'contents', 'main']);
    expect(p.root.querySelector('noframes')!.textContent).toContain('main.html');
    // Serializing an unchanged tree keeps the page equivalent.
    const again = page.slice(0, p.start) + serializeFrameset(p.root) + page.slice(p.end);
    const p2 = parseFrameset(again)!;
    expect(serializeFrameset(p2.root)).toBe(serializeFrameset(p.root));
    expect(again).toContain('<frame src="main.html" name="main" title="Main content">');
    expect(splitSize('200')).toEqual(['100', '100']);
    expect(splitSize('50%')).toEqual(['25%', '25%']);
    expect(splitSize('*')).toEqual(['*', '*']);
  });
});
