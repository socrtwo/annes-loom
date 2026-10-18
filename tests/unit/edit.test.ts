import { describe, it, expect } from 'vitest';
import '../../src/commands/edit';
import '../../src/commands/view';
import '../../src/commands/tag';
import '../../src/commands/panels';
import { getCommand } from '../../src/commands/registry';
import { classicIds } from '../../src/ui/classicMenus';
import { idsInTabs } from '../../src/ui/ribbonLayout';
import { DEFAULT_QAT, QAT_CHOICES } from '../../src/prefs';
import { expandAbbreviation, abbreviationStart, looksLikeAbbreviation, expandCss, numbered, lorem } from '../../src/editor/emmet';
import { parseSource, enclosingElement, balanceOutward, elementForPath, parseStartTag, buildStartTag, formatCss, formatJs, attrsFromText } from '../../src/commands/tag';
import { findMatches, expandReplacement, visibleText, searchText, replaceInText, convertPaste, cleanWordHtml, cleanClipboardHtml, jsSymbols, cssSymbols, symbolsOf } from '../../src/commands/edit';
import { siteColors, siteFonts } from '../../src/ui/panesEdit';

describe('edit/view/tag/code/panel command ids', () => {
  it('registers every id of these families that the menus, ribbon and Quick Access Bar name', () => {
    const want = new Set([...classicIds(), ...idsInTabs(), ...DEFAULT_QAT, ...QAT_CHOICES]);
    const missing = [...want].filter((id) => /^(edit|view|tag|code|panel)\./.test(id) && !getCommand(id));
    expect(missing).toEqual([]);
  });
});

describe('emmet abbreviations', () => {
  it('expands children, siblings and multiplication', () => {
    expect(expandAbbreviation('ul>li*3')).toBe('<ul>\n  <li></li>\n  <li></li>\n  <li></li>\n</ul>');
    expect(expandAbbreviation('p+p')).toBe('<p></p>\n<p></p>');
    expect(expandAbbreviation('span+span')).toBe('<span></span><span></span>');
  });
  it('handles id, classes, attributes and text', () => {
    expect(expandAbbreviation('div#main.a.b>p{Hi there}')).toBe('<div id="main" class="a b">\n  <p>Hi there</p>\n</div>');
    expect(expandAbbreviation('input[type=email required]')).toBe('<input type="email" name="" required>');
    expect(expandAbbreviation('a[href="x y" title=t]{go}')).toBe('<a href="x y" title="t">go</a>');
  });
  it('numbers with $, padding, reverse and start', () => {
    expect(expandAbbreviation('li.item$*3')).toBe('<li class="item1"></li>\n<li class="item2"></li>\n<li class="item3"></li>');
    expect(numbered('n$$', 3, 5)).toBe('n03');
    expect(numbered('n$@-', 1, 3)).toBe('n3');
    expect(numbered('n$@10', 2, 3)).toBe('n11');
    expect(expandAbbreviation('h$*2')).toBe('<h1></h1>\n<h2></h2>');
  });
  it('climbs up with ^ and groups with ()', () => {
    expect(expandAbbreviation('div>p>span^p')).toBe('<div>\n  <p><span></span></p>\n  <p></p>\n</div>');
    expect(expandAbbreviation('div>(header>nav)+footer')).toBe('<div>\n  <header>\n    <nav></nav>\n  </header>\n  <footer></footer>\n</div>');
    expect(expandAbbreviation('(li>a)*2')).toBe('<li><a href=""></a></li>\n<li><a href=""></a></li>');
  });
  it('uses implicit tag names', () => {
    expect(expandAbbreviation('.box')).toBe('<div class="box"></div>');
    expect(expandAbbreviation('ul>.x')).toBe('<ul>\n  <li class="x"></li>\n</ul>');
    expect(expandAbbreviation('table>.r>.c')).toBe('<table>\n  <tr class="r">\n    <td class="c"></td>\n  </tr>\n</table>');
    expect(expandAbbreviation('p>.s')).toBe('<p><span class="s"></span></p>');
  });
  it('makes placeholder text', () => {
    expect(expandAbbreviation('p>lorem5')).toBe('<p>Lorem ipsum dolor sit amet.</p>');
    expect(lorem(3).split(' ')).toHaveLength(3);
  });
  it('marks the caret and finds the abbreviation before the cursor', () => {
    expect(expandAbbreviation('ul>li', { caret: true })).toBe('<ul>\n  <li>\u0001</li>\n</ul>');
    expect(abbreviationStart('<div>ul>li*3', 12)).toBe(5);
    expect(abbreviationStart('  p>a{x y}', 10)).toBe(2);
    expect(abbreviationStart('<a href="x">ul', 14)).toBe(12);
    expect(looksLikeAbbreviation('div')).toBe(true);
    expect(looksLikeAbbreviation('hello')).toBe(false);
    expect(looksLikeAbbreviation('ul>li')).toBe(true);
    expect(expandAbbreviation('!')).toContain('<!DOCTYPE html>');
    expect(() => expandAbbreviation('div>(p')).toThrow();
  });
  it('expands CSS abbreviations', () => {
    expect(expandCss('m10')).toBe('margin: 10px;');
    expect(expandCss('p10-20')).toBe('padding: 10px 20px;');
    expect(expandCss('w100p')).toBe('width: 100%;');
    expect(expandCss('dn')).toBe('display: none;');
    expect(expandCss('zz9')).toBeNull();
  });
});

describe('markup scanner', () => {
  const src = '<body><div id="a"><p>one <b>two</b></p><ul><li>x<li>y</ul></div></body>';
  it('finds the enclosing element at the cursor', () => {
    const t = parseSource(src);
    const pos = src.indexOf('two') + 1;
    const b = enclosingElement(t.root, pos)!;
    expect(b.name).toBe('b');
    expect(src.slice(b.openStart, b.closeEnd)).toBe('<b>two</b>');
    expect(b.parent!.name).toBe('p');
  });
  it('closes optional end tags implicitly', () => {
    const t = parseSource(src);
    const ul = enclosingElement(t.root, src.indexOf('<li>x') + 4)!.parent!;
    expect(ul.name).toBe('ul');
    expect(ul.children.map((c) => c.name)).toEqual(['li', 'li']);
    expect(t.stray).toEqual([]);
    expect(t.unclosed).toEqual([]);
  });
  it('reports stray and unclosed tags', () => {
    const t = parseSource('<div><span>x</div></em>');
    expect(t.unclosed.map((e) => e.name)).toEqual(['span']);
    expect(t.stray).toHaveLength(1);
  });
  it('skips scripts, styles and comments', () => {
    const s = '<div><script>if (a<b) { "</div>" }</script><!-- <p> --></div>';
    const t = parseSource(s);
    expect(t.root.children[0].closeEnd).toBe(s.length);
    expect(t.unclosed).toEqual([]);
  });
  it('balances outward: contents, then element, then parent', () => {
    const t = parseSource(src);
    const pos = src.indexOf('two') + 1;
    const r1 = balanceOutward(t.root, pos, pos)!;
    expect(src.slice(r1[0], r1[1])).toBe('two');
    const r2 = balanceOutward(t.root, r1[0], r1[1])!;
    expect(src.slice(r2[0], r2[1])).toBe('<b>two</b>');
    const r3 = balanceOutward(t.root, r2[0], r2[1])!;
    expect(src.slice(r3[0], r3[1])).toBe('one <b>two</b>');
  });
  it('maps a Design view path to the source, ignoring the browser-added tbody', () => {
    const s = '<html><body><table><tr><td>a</td><td>b</td></tr></table><p>x</p><p>y</p></body></html>';
    const t = parseSource(s);
    const td = elementForPath(t.root, [{ tag: 'table', nth: 0 }, { tag: 'tbody', nth: 0 }, { tag: 'tr', nth: 0 }, { tag: 'td', nth: 1 }])!;
    expect(s.slice(td.openStart, td.closeEnd)).toBe('<td>b</td>');
    const p = elementForPath(t.root, [{ tag: 'p', nth: 1 }])!;
    expect(s.slice(p.openStart, p.closeEnd)).toBe('<p>y</p>');
  });
  it('parses and rebuilds start tags', () => {
    const t = parseStartTag('<a href="x.html" hidden data-x=\'1\' title=t>')!;
    expect(t.name).toBe('a');
    expect(t.attrs).toEqual([['href', 'x.html'], ['hidden', null], ['data-x', '1'], ['title', 't']]);
    expect(buildStartTag(t)).toBe('<a href="x.html" hidden data-x="1" title="t">');
    expect(buildStartTag({ name: 'img', attrs: [['alt', 'say "hi"']], selfClose: true })).toBe('<img alt="say &quot;hi&quot;" />');
    expect(attrsFromText('class="a b" id=c')).toEqual([['class', 'a b'], ['id', 'c']]);
  });
});

describe('formatters', () => {
  it('formats CSS', () => {
    expect(formatCss('a{color:red;margin:0}@media (max-width:600px){a{color:blue}}')).toBe('a {\n  color: red;\n  margin: 0;\n}\n\n@media (max-width:600px) {\n  a {\n    color: blue;\n  }\n}\n');
  });
  it('re-indents JavaScript by bracket depth', () => {
    expect(formatJs('function f() {\nif (a) {\nreturn "}";\n}\n}')).toBe('function f() {\n  if (a) {\n    return "}";\n  }\n}\n');
  });
});

describe('find and replace', () => {
  it('finds plain, case, whole-word and regex matches', () => {
    const t = 'Cat cat concat cat.';
    expect(findMatches(t, 'cat').length).toBe(4);
    expect(findMatches(t, 'cat', { matchCase: true }).length).toBe(3);
    expect(findMatches(t, 'cat', { wholeWord: true }).length).toBe(3);
    expect(findMatches(t, 'c(a)t', { regex: true, matchCase: true }).map((m) => m.from)).toEqual([4, 11, 15]);
    expect(() => findMatches(t, '(', { regex: true })).toThrow();
  });
  it('expands replacement groups only in regex mode', () => {
    const m = /(\w+)@(?<host>\w+)/.exec('me@site')!;
    expect(expandReplacement(m, '$2:$1 $<host> $& $$', true)).toBe('site:me site me@site $');
    expect(expandReplacement(m, '$1', false)).toBe('$1');
  });
  it('maps visible text back to the source', () => {
    const src = '<html><head><title>T</title></head><body><p>Fish &amp; <b>chips</b></p><script>var chips=1</script></body></html>';
    const v = visibleText(src);
    expect(v.text.trim()).toBe('Fish & chips');
    const hits = searchText('a.html', src, 'chips', { mode: 'text' });
    expect(hits).toHaveLength(1);
    expect(src.slice(hits[0].from, hits[0].to)).toBe('chips');
    expect(searchText('a.html', src, 'chips', { mode: 'source' })).toHaveLength(2);
    const amp = searchText('a.html', src, '&', { mode: 'text' })[0];
    expect(src.slice(amp.from, amp.to)).toBe('&amp;');
  });
  it('replaces in source and in visible text (leaving matches that cross tags)', () => {
    const src = '<body><p>red <b>red</b> re<i>d</i></p></body>';
    expect(replaceInText('a.html', src, 'red', 'blue', { mode: 'source' }).count).toBe(2);
    const r = replaceInText('a.html', src, 'red', 'blue', { mode: 'text' });
    expect(r.text).toBe('<body><p>blue <b>blue</b> re<i>d</i></p></body>');
    expect(r.skipped).toBe(1);
    expect(replaceInText('x.css', 'a{color:#f00}', '#(f)00', '#$1$1$1', { regex: true }).text).toBe('a{color:#fff}');
    expect(replaceInText('a.html', '<body><p>a</p></body>', 'a', '<x>', { mode: 'text' }).text).toBe('<body><p>&lt;x&gt;</p></body>');
  });
  it('gives line numbers and previews', () => {
    const hits = searchText('a.css', 'a {}\nb { color: red }\n', 'red', {});
    expect(hits[0].line).toBe(2);
    expect(hits[0].col).toBe(12);
    expect(hits[0].preview.slice(hits[0].pre, hits[0].pre + hits[0].len)).toBe('red');
  });
});

describe('paste conversions', () => {
  it('converts text', () => {
    expect(convertPaste('text', '', 'a\nb <c>')).toBe('a b &lt;c&gt;');
    expect(convertPaste('breaks', '', 'a\nb')).toBe('a<br>\nb');
    expect(convertPaste('paragraphs', '', 'one\ntwo\n\nthree')).toBe('<p>one<br>\ntwo</p>\n<p>three</p>');
    expect(convertPaste('pre', '', 'x < y')).toBe('<pre>x &lt; y</pre>');
  });
  it('cleans clipboard and Word HTML', () => {
    expect(cleanClipboardHtml('<html><body><!--StartFragment--><b onclick="x()">hi</b><script>bad()</script><!--EndFragment--></body></html>')).toBe('<b>hi</b>');
    const word = '<p class="MsoNormal" style="mso-margin-top-alt:auto;font-family:Calibri;color:red"><span lang="EN-US"><o:p>Hello</o:p></span></p><!--[if gte mso 9]><xml>x</xml><![endif]--><p class="MsoNormal"><o:p>&nbsp;</o:p></p>';
    expect(cleanWordHtml(word)).toBe('<p style="color:red">Hello</p>');
  });
});

describe('symbols for Go To Function', () => {
  it('lists functions, classes and rules', () => {
    const js = 'function a() {}\nconst b = (x) => x;\nclass C { m() { if (x) {} } }\n// function nope() {}';
    expect(jsSymbols(js).map((s) => s.name)).toEqual(['a()', 'b()', 'C', 'm()']);
    expect(cssSymbols('/* x{} */ a, b { } @media print { p {} }').map((s) => s.name)).toEqual(['a, b', '@media print', 'p']);
    const html = '<style>h1{}</style><div id="top"></div><script>function go(){}</script>';
    const syms = symbolsOf('a.html', html);
    expect(syms.map((s) => s.name)).toEqual(['h1', 'div#top', 'go()']);
    expect(html.slice(syms[2].at, syms[2].at + 8)).toBe('function');
  });
});

describe('assets', () => {
  it('collects colors and fonts', () => {
    expect(siteColors(['a{color:#FFF;background:#fff} b{color:rgb(1, 2, 3)}'])).toEqual([['#fff', 2], ['rgb(1,2,3)', 1]]);
    expect(siteFonts(['body{font-family: Georgia, serif}', '<font face="Arial">'])).toEqual(['Arial', 'Georgia, serif']);
  });
});
