import { describe, it, expect } from 'vitest';
import {
  parseCss, findRules, setDeclaration, setDeclarations, removeRule, renameSelector, listSelectors, specificity, compareSpecificity,
  matches, minify, formatCss, removeUnused, unusedSelectors, addVendorPrefixes, vendorPrefixes, classesIn, idsIn, importsOf, fontFaces,
  listMedia, parseDeclarations, setStyleDecls, styleToObject, addRule, renameAtRule, rebaseCssUrls, ruleText, moveRule, replaceRuleBody,
  splitSelectors, staticSelector, removeEmptyBlocks, renameClassInCss, declMap, setDeclarationInRule,
} from '../../src/model/css';

const SAMPLE = `/* Site styles */
@charset "utf-8";
@import url("base.css") screen;
body { margin: 0; font-family: Georgia, serif }
.note, .tip > p {
  color: #333333;
  background: url("img/a;b.png") no-repeat; /* tricky */
  padding: 4px !important;
}
@media (max-width: 600px) {
  body { margin: 8px; }
  @supports (display: grid) {
    .grid { display: grid; }
  }
}
@font-face { font-family: "Brand Sans"; src: url(fonts/brand.woff2) format("woff2"); }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;

describe('parseCss', () => {
  const sheet = parseCss(SAMPLE);
  it('finds rules in every context, but not keyframes', () => {
    expect(sheet.rules.map((r) => r.selector)).toEqual(['body', '.note, .tip > p', 'body', '.grid']);
    expect(sheet.rules[2].media).toEqual(['@media (max-width: 600px)']);
    expect(sheet.rules[3].media).toEqual(['@media (max-width: 600px)', '@supports (display: grid)']);
  });
  it('reads declarations with !important, semicolons inside strings and comments', () => {
    const r = sheet.rules[1];
    expect(r.decls.map((d) => [d.prop, d.value, d.important])).toEqual([
      ['color', '#333333', false], ['background', 'url("img/a;b.png") no-repeat', false], ['padding', '4px', true],
    ]);
    expect(SAMPLE.slice(r.decls[0].valueStart, r.decls[0].valueEnd)).toBe('#333333');
    expect(SAMPLE.slice(r.selStart, r.selEnd)).toBe('.note, .tip > p');
  });
  it('keeps comments and at-rules', () => {
    expect(sheet.nodes[0]).toMatchObject({ type: 'comment', text: '/* Site styles */' });
    expect(sheet.atRules.map((a) => a.name)).toEqual(['charset', 'import', 'media', 'supports', 'font-face', 'keyframes']);
    expect(importsOf(sheet)).toMatchObject([{ href: 'base.css', media: 'screen' }]);
    expect(fontFaces(sheet)).toEqual(['Brand Sans']);
    expect(listMedia(sheet)).toEqual(['@media (max-width: 600px)', '@supports (display: grid)']);
  });
  it('is tolerant and reports errors', () => {
    const s = parseCss('a { color red; } } b { color: blue');
    expect(s.rules.map((r) => r.selector)).toEqual(['a', 'b']);
    expect(s.rules[1].decls[0].value).toBe('blue');
    expect(s.errors.length).toBeGreaterThanOrEqual(3);
    expect(s.errors[0].line).toBe(1);
  });
  it('resolves nested rules', () => {
    const s = parseCss('.card { color: red; &:hover { color: blue } .title { font-weight: bold } @media print { color: black } }');
    expect(s.rules.map((r) => r.selector)).toEqual(['.card', '.card:hover', '.card .title', '.card']);
    expect(s.rules[3].media).toEqual(['@media print']);
    expect(s.rules[3].synthetic).toBe(true);
  });
  it('handles empty and comment-only input', () => {
    expect(parseCss('').rules).toEqual([]);
    expect(parseCss('/* only */').nodes).toHaveLength(1);
  });
});

describe('queries', () => {
  it('finds rules by selector regardless of spacing and media', () => {
    expect(findRules(SAMPLE, 'body')).toHaveLength(2);
    expect(findRules(SAMPLE, 'body', null)).toHaveLength(1);
    expect(findRules(SAMPLE, 'body', '(max-width:600px)')).toHaveLength(1);
    expect(findRules(SAMPLE, '.note,.tip>p')).toHaveLength(1);
  });
  it('lists selectors, classes and ids', () => {
    expect(listSelectors('a{} a {} #x .y{}')).toEqual(['a', '#x .y']);
    expect(classesIn('.a, p.b > .c-d[title=".nope"] {} #e.f {}').sort()).toEqual(['a', 'b', 'c-d', 'f']);
    expect(idsIn('#main .x, a[href="#top"] {}')).toEqual(['main']);
  });
  it('splits selector lists at top-level commas only', () => {
    expect(splitSelectors('a, :is(b, c), [d=","]')).toEqual(['a', ':is(b, c)', '[d=","]']);
  });
  it('maps declarations', () => {
    expect(declMap({ decls: parseDeclarations('color: red; color: blue; margin: 0 !important; margin: 1px') })).toEqual({ color: 'blue', margin: '0 !important' });
  });
});

describe('setDeclaration', () => {
  it('changes a value in place and keeps everything else', () => {
    const out = setDeclaration(SAMPLE, '.note, .tip > p', 'color', 'red');
    expect(out).toBe(SAMPLE.replace('color: #333333;', 'color: red;'));
  });
  it('keeps !important when asked and can add it', () => {
    expect(setDeclaration('a { color: red }', 'a', 'color', 'blue !important')).toBe('a { color: blue !important }');
    expect(setDeclaration('a { padding: 1px !important; }', 'a', 'padding', '2px')).toBe('a { padding: 2px; }');
  });
  it('adds a declaration with the rule\'s own layout', () => {
    expect(setDeclaration('a { color: red }', 'a', 'margin', '0')).toBe('a { color: red; margin: 0; }');
    expect(setDeclaration('a {\n    color: red;\n}\n', 'a', 'margin', '0')).toBe('a {\n    color: red;\n    margin: 0;\n}\n');
    expect(setDeclaration('a {}', 'a', 'margin', '0')).toBe('a {\n  margin: 0;\n}');
  });
  it('removes a declaration (and its line)', () => {
    expect(setDeclaration('a {\n  color: red;\n  margin: 0;\n}', 'a', 'color', null)).toBe('a {\n  margin: 0;\n}');
    expect(setDeclaration('a { color: red; margin: 0 }', 'a', 'color', '')).toBe('a { margin: 0 }');
    expect(setDeclaration('a { color: red }', 'b', 'color', null)).toBe('a { color: red }');
  });
  it('creates the rule when missing, matching the sheet indentation', () => {
    expect(setDeclaration('', '.x', 'color', 'red')).toBe('.x {\n  color: red;\n}\n');
    expect(setDeclaration('\n    body { margin: 0; }\n  ', '.x', 'color', 'red')).toBe('\n    body { margin: 0; }\n\n    .x {\n      color: red;\n    }\n  ');
  });
  it('writes into the right media block, creating it when needed', () => {
    const out = setDeclaration(SAMPLE, 'body', 'color', 'navy', '(max-width: 600px)');
    expect(out).toContain('body { margin: 8px; color: navy; }');
    expect(out).toContain('body { margin: 0; font-family: Georgia, serif }');
    const out2 = setDeclaration('a { color: red; }\n', '.m', 'display', 'none', 'print');
    expect(out2).toBe('a { color: red; }\n\n@media print {\n  .m {\n    display: none;\n  }\n}\n');
    expect(parseCss(out2).rules[1].media).toEqual(['@media print']);
    const out3 = setDeclaration(out2, '.n', 'display', 'none', 'print');
    expect(out3).toBe('a { color: red; }\n\n@media print {\n  .m {\n    display: none;\n  }\n\n  .n {\n    display: none;\n  }\n}\n');
  });
  it('sets several properties at once', () => {
    expect(setDeclarations('a { color: red; }', 'a', { color: 'blue', margin: '0', padding: null })).toBe('a { color: blue; margin: 0; }');
    expect(setDeclarations('', 'b', { color: 'blue', margin: '' })).toBe('b {\n  color: blue;\n}\n');
  });
  it('edits a nested rule and a rule by index', () => {
    const css = '.a { color: red; &:hover { color: blue; } }';
    const s = parseCss(css);
    expect(setDeclarationInRule(css, s.rules[1], 'color', 'green')).toBe('.a { color: red; &:hover { color: green; } }');
    expect(setDeclarationInRule(css, s.rules[0], 'margin', '0')).toBe('.a { color: red; margin: 0; &:hover { color: blue; } }');
  });
  it('keeps the result parseable', () => {
    let css = SAMPLE;
    for (const [p, v] of [['color', 'red'], ['margin', '1px'], ['z-index', '3']]) css = setDeclaration(css, '.grid', p, v, '@media (max-width: 600px)');
    expect(parseCss(css).errors).toEqual([]);
  });
});

describe('rule edits', () => {
  it('adds rules', () => {
    expect(addRule('', 'p', [['color', 'red'], ['margin', '0 !important']])).toBe('p {\n  color: red;\n  margin: 0 !important;\n}\n');
  });
  it('removes rules', () => {
    expect(removeRule('a { color: red; }\nb { color: blue; }\n', 'a')).toBe('b { color: blue; }\n');
    expect(removeRule(SAMPLE, 'body', null)).not.toContain('font-family: Georgia');
    expect(removeRule(SAMPLE, 'body', null)).toContain('margin: 8px');
  });
  it('renames selectors and classes', () => {
    expect(renameSelector('.a { color: red }\n.a:hover { color: blue }', '.a', '.b')).toBe('.b { color: red }\n.a:hover { color: blue }');
    expect(renameClassInCss('.a, .ab, p.a:hover, [title=".a"] {}', 'a', 'z')).toBe('.z, .ab, p.z:hover, [title=".a"] {}');
  });
  it('renames media conditions', () => {
    expect(renameAtRule('@media (max-width: 600px) { a {} }', '(max-width:600px)', '(max-width: 640px)')).toBe('@media (max-width: 640px) { a {} }');
  });
  it('gives the text of a rule with its media wrapper', () => {
    const s = parseCss(SAMPLE);
    expect(ruleText(SAMPLE, s.rules[2])).toBe('@media (max-width: 600px) {\n  body { margin: 8px; }\n}');
  });
  it('moves rules up and down', () => {
    const css = 'a { }\nb { }\nc { }';
    expect(moveRule(css, parseCss(css).rules[1], -1)).toBe('b { }\na { }\nc { }');
    expect(moveRule(css, parseCss(css).rules[2], 1)).toBe(css);
  });
  it('replaces a rule body', () => {
    const css = 'a { color: red; }';
    expect(replaceRuleBody(css, parseCss(css).rules[0], 'margin: 0; padding: 1px')).toBe('a {\n  margin: 0;\n  padding: 1px;\n}');
  });
  it('removes empty media blocks', () => {
    expect(removeEmptyBlocks('a{}\n@media print {\n  /* none */\n}\n')).toBe('a{}\n');
  });
});

describe('specificity', () => {
  it('counts ids, classes and types', () => {
    expect(specificity('*')).toEqual([0, 0, 0]);
    expect(specificity('li')).toEqual([0, 0, 1]);
    expect(specificity('ul li')).toEqual([0, 0, 2]);
    expect(specificity('ul ol+li')).toEqual([0, 0, 3]);
    expect(specificity('h1 + *[rel=up]')).toEqual([0, 1, 1]);
    expect(specificity('ul ol li.red')).toEqual([0, 1, 3]);
    expect(specificity('li.red.level')).toEqual([0, 2, 1]);
    expect(specificity('#x34y')).toEqual([1, 0, 0]);
    expect(specificity('a:hover::before')).toEqual([0, 1, 2]);
    expect(specificity('p:first-line')).toEqual([0, 0, 2]);
  });
  it('handles :is, :not, :where and :nth-child(of)', () => {
    expect(specificity(':is(#a, .b) p')).toEqual([1, 0, 1]);
    expect(specificity(':where(#a) p')).toEqual([0, 0, 1]);
    expect(specificity('a:not(.x)')).toEqual([0, 1, 1]);
    expect(specificity(':nth-child(2n of .item)')).toEqual([0, 2, 0]);
  });
  it('takes the highest of a selector list', () => {
    expect(specificity('a, #b, .c')).toEqual([1, 0, 0]);
    expect(compareSpecificity([0, 1, 0], [0, 0, 9])).toBeGreaterThan(0);
  });
});

describe('matches', () => {
  document.body.innerHTML = '<div id="main" class="box"><p class="lead">Hi <a href="#">x</a></p></div>';
  const p = document.querySelector('p')!;
  const a = document.querySelector('a')!;
  it('matches static selectors', () => {
    expect(matches('#main > .lead', p)).toBe(true);
    expect(matches('div p.lead, span', p)).toBe(true);
    expect(matches('.other', p)).toBe(false);
  });
  it('ignores states and pseudo-elements', () => {
    expect(matches('a:hover', a)).toBe(true);
    expect(matches('p.lead::first-line', p)).toBe(true);
    expect(matches('a:not(:visited)', a)).toBe(true);
    expect(staticSelector('a:hover')).toBe('a');
    expect(staticSelector(':hover')).toBe('*');
  });
  it('matches rule objects and survives invalid selectors', () => {
    const r = parseCss('.box p { color: red }').rules[0];
    expect(matches(r, p)).toBe(true);
    expect(matches('p:unknown-thing(', p)).toBe(false);
  });
});

describe('minify and format', () => {
  it('minifies', () => {
    const m = minify(SAMPLE);
    expect(m).toContain('body{margin:0;font-family:Georgia,serif}');
    expect(m).toContain('.note,.tip>p{color:#333;background:url("img/a;b.png") no-repeat;padding:4px!important}');
    expect(m).toContain('@media (max-width:600px){body{margin:8px}@supports (display:grid){.grid{display:grid}}}');
    expect(m).toContain('@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}');
    expect(m).not.toContain('Site styles');
    expect(parseCss(m).errors).toEqual([]);
    expect(parseCss(m).rules.length).toBe(parseCss(SAMPLE).rules.length);
  });
  it('keeps /*! notices */', () => {
    expect(minify('/*! keep */ a { color : red ; }')).toBe('/*! keep */a{color:red}');
  });
  it('pretty-prints', () => {
    expect(formatCss('a{color:red;margin:0}b,c{x:y}')).toBe('a {\n  color: red;\n  margin: 0;\n}\n\nb,\nc {\n  x: y;\n}\n');
    expect(formatCss('@media print{a{color:red}}')).toBe('@media print {\n  a {\n    color: red;\n  }\n}\n');
    const f = formatCss(SAMPLE);
    expect(f).toContain('/* Site styles */');
    expect(parseCss(f).rules.map((r) => r.selector.replace(/\s+/g, ' '))).toEqual(parseCss(SAMPLE).rules.map((r) => r.selector));
    expect(formatCss(f)).toBe(f);
  });
});

describe('removeUnused', () => {
  const page = '<html><body><div class="a"><p id="x">Hi</p></div></body></html>';
  it('removes unused rules and selector parts', () => {
    const css = '.a { color: red; }\n.b { color: blue; }\n.a p, .c { margin: 0; }\na:hover { color: red; }\n@media print {\n  .gone { display: none; }\n}\n';
    const out = removeUnused(css, [page]);
    expect(out).toBe('.a { color: red; }\n.a p { margin: 0; }\n');
    expect(unusedSelectors(css, [page]).map((u) => u.selector)).toEqual(['.b', '.c', 'a:hover', '.gone']);
  });
  it('keeps at-rules like @font-face and @keyframes', () => {
    const css = '@font-face { font-family: X; }\n@keyframes k { from { opacity: 0; } }\n.none { color: red; }\n';
    expect(removeUnused(css, [page])).toBe('@font-face { font-family: X; }\n@keyframes k { from { opacity: 0; } }\n');
  });
});

describe('vendor prefixes', () => {
  it('lists prefixes', () => {
    expect(vendorPrefixes('user-select')).toEqual(['-webkit-user-select']);
    expect(vendorPrefixes('color')).toEqual([]);
  });
  it('adds missing prefixed declarations before the standard one', () => {
    expect(addVendorPrefixes('a {\n  user-select: none;\n}')).toBe('a {\n  -webkit-user-select: none;\n  user-select: none;\n}');
    expect(addVendorPrefixes('a { position: sticky; }')).toBe('a { position: -webkit-sticky; position: sticky; }');
    const once = addVendorPrefixes('a { backdrop-filter: blur(2px); }');
    expect(addVendorPrefixes(once)).toBe(once);
  });
});

describe('inline styles and urls', () => {
  it('edits style attributes', () => {
    expect(setStyleDecls('color: red; margin: 0', { color: 'blue', padding: '1px', margin: null })).toBe('color: blue; padding: 1px');
    expect(setStyleDecls('', { color: 'red' })).toBe('color: red');
    expect(styleToObject('color:red;background:url("a;b.png")')).toEqual({ color: 'red', background: 'url("a;b.png")' });
  });
  it('rebases urls when CSS moves to another folder', () => {
    expect(rebaseCssUrls('a { background: url("img/x.png"); } @import "base.css";', 'index.html', 'css/site.css')).toBe('a { background: url("../img/x.png"); } @import "../base.css";');
    expect(rebaseCssUrls('a { background: url(https://x.org/a.png) }', 'index.html', 'css/a.css')).toBe('a { background: url(https://x.org/a.png) }');
  });
});
