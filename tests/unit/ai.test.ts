import { describe, it, expect } from 'vitest';
import {
  codeBlocks, stripFences, cleanText, linesOf, parseJsonLoose, findJsonSpan, extractPage, extractFragment, extractSvg, findDocument, stripActive,
  unbalancedTags, parseSitePlan, navHtml, sitePageShell, setAlternateLinks, langCode, structureOutline, lineDiff, foldDiff, diffStats, proseToHtml,
  codeLang, pageTextFor, pagePrompt, TEXT_TASKS, stripPreamble,
} from '../../src/ai/web';
import '../../src/commands/ai';
import { getCommand } from '../../src/commands/registry';
import { classicIds } from '../../src/ui/classicMenus';
import { idsInTabs } from '../../src/ui/ribbonLayout';

describe('code fences', () => {
  it('strips a fenced block with a language and surrounding prose', () => {
    expect(stripFences('Here is the page:\n```html\n<p>Hi</p>\n```\nHope this helps!')).toBe('<p>Hi</p>');
  });
  it('handles tildes, long fences and uppercase languages', () => {
    expect(stripFences('~~~HTML\n<b>x</b>\n~~~')).toBe('<b>x</b>');
    expect(stripFences('````html\n```inner```\n````')).toBe('```inner```');
  });
  it('prefers the requested language, else the longest block', () => {
    const s = '```css\nbody{}\n```\ntext\n```html\n<main>long content here</main>\n```';
    expect(stripFences(s, ['css'])).toBe('body{}');
    expect(stripFences(s)).toBe('<main>long content here</main>');
    expect(stripFences('```javascript\nlet a=1\n```', ['js'])).toBe('let a=1');
  });
  it('keeps an unclosed (cut-off) block', () => {
    expect(stripFences('```html\n<div>\n<p>cut')).toBe('<div>\n<p>cut');
  });
  it('removes stray fence lines and chatty preambles without fences', () => {
    expect(stripFences('<p>a</p>\n```')).toBe('<p>a</p>');
    expect(stripFences('Sure! Here is the revised section:\n<section>x</section>')).toBe('<section>x</section>');
    expect(stripPreamble('Hello <b>world</b>')).toBe('Hello <b>world</b>');
  });
  it('lists every block with its language', () => {
    expect(codeBlocks('a\n```html\n<p>1</p>\n```\n```css\np{}\n```').map((b) => b.lang)).toEqual(['html', 'css']);
    expect(codeBlocks('```html <p>one line</p>```')).toEqual([{ lang: 'html', code: '<p>one line</p>' }]);
  });
  it('cleans text answers', () => {
    expect(cleanText('```\nJust text\n```')).toBe('Just text');
    expect(cleanText('"Quoted headline"')).toBe('Quoted headline');
    expect(linesOf('1. One\n- Two\n* **Three**')).toEqual(['One', 'Two', 'Three']);
  });
});

describe('JSON parsing', () => {
  it('parses JSON inside prose and fences', () => {
    expect(parseJsonLoose('Sure, here it is:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('The plan is {"pages": [{"title": "Home"}]} as requested.')).toEqual({ pages: [{ title: 'Home' }] });
  });
  it('honors braces inside strings and repairs trailing commas', () => {
    expect(parseJsonLoose('x {"css": "a { color: red }", "n": [1, 2,],} y')).toEqual({ css: 'a { color: red }', n: [1, 2] });
    expect(findJsonSpan('ab {"x":"}"} cd')).toEqual([3, 12]);
  });
  it('skips a non-JSON brace before the real value', () => {
    expect(parseJsonLoose('Use {this} format: {"ok": true}')).toEqual({ ok: true });
    expect(parseJsonLoose('no json here')).toBeNull();
  });
});

describe('pages and fragments', () => {
  it('finds a whole document and separate CSS', () => {
    const ans = 'Here you go.\n```html\n<!DOCTYPE html>\n<html lang="en"><head><title>Bakery</title><link rel="stylesheet" href="style.css"></head><body><h1>Pies</h1></body></html>\n```\n```css\nh1 { color: brown; }\n```';
    const p = extractPage(ans);
    expect(p.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(p.html.trim().endsWith('</html>')).toBe(true);
    expect(p.css).toBe('h1 { color: brown; }');
    expect(p.title).toBe('Bakery');
  });
  it('wraps a fragment in a page', () => {
    const p = extractPage('```html\n<h1>Hello</h1><p>x</p>\n```');
    expect(p.html).toMatch(/<!DOCTYPE html>/);
    expect(p.html).toMatch(/<title>Hello<\/title>/);
    expect(p.html).toMatch(/<body>\s*<h1>Hello<\/h1>/);
  });
  it('finds an unfenced document and closes a cut-off one', () => {
    expect(findDocument('Text before <html><body>x</body></html> after')).toBe('<html><body>x</body></html>');
    expect(findDocument('<!DOCTYPE html><html><body><p>cut')).toMatch(/<\/html>$/);
  });
  it('takes the body of a document when a fragment was asked for', () => {
    expect(extractFragment('```html\n<html><head><title>t</title></head><body><p>Only this</p></body></html>\n```')).toBe('<p>Only this</p>');
  });
  it('extracts SVG and removes active content', () => {
    const svg = extractSvg('```svg\n<svg viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><circle r="4"/></svg>\n```');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).not.toMatch(/script|onload/);
    expect(stripActive('<a href="javascript:evil()" onclick="x">a</a>')).toBe('<a href="#">a</a>');
  });
  it('reports unbalanced tags', () => {
    expect(unbalancedTags('<section><div><p>a</section>')).toEqual(['<div>']);
    expect(unbalancedTags('<ul><li>a<li>b</ul><img src=x><br>')).toEqual([]);
    expect(unbalancedTags('</div>')).toEqual(['</div>']);
  });
  it('turns prose into simple HTML', () => {
    expect(proseToHtml('# Title\n\nA **bold** idea.\n\n- one\n- two')).toBe('<h2>Title</h2>\n<p>A <strong>bold</strong> idea.</p>\n<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>');
    expect(proseToHtml('<p>already</p>')).toBe('<p>already</p>');
  });
});

describe('site plans', () => {
  const answer = 'Here is a plan:\n```json\n{"siteName":"Green Thumb","description":"Garden help","pages":[{"title":"Home","outline":["Hero","Services"]},{"title":"About Us","path":"/About Us.html"},{"title":"About Us"},{"title":"Contact","path":"contact"}],"css":"body{margin:0}"}\n```';
  it('normalizes paths, keeps them unique and makes the first page index.html', () => {
    const p = parseSitePlan(answer)!;
    expect(p.name).toBe('Green Thumb');
    expect(p.pages.map((x) => x.path)).toEqual(['index.html', 'about-us.html', 'about-us-2.html', 'contact.html']);
    expect(p.pages[0].outline).toBe('Hero\nServices');
    expect(p.css).toBe('body{margin:0}');
  });
  it('accepts a bare array and rejects non-plans', () => {
    expect(parseSitePlan('[{"title":"Start","path":"start.html"}]')!.pages[0].path).toBe('index.html');
    expect(parseSitePlan('I cannot do that.')).toBeNull();
  });
  it('builds a shared navigation with relative links and the current page marked', () => {
    const pages = [{ title: 'Home', path: 'index.html' }, { title: 'Post', path: 'blog/post.html' }];
    const nav = navHtml(pages, 'blog/post.html');
    expect(nav).toContain('href="../index.html"');
    expect(nav).toContain('href="post.html" aria-current="page"');
  });
  it('assembles a page shell linking the shared style sheet', () => {
    const plan = parseSitePlan(answer)!;
    const html = sitePageShell(plan, plan.pages[1], '<h1>About</h1>');
    expect(html).toContain('<link rel="stylesheet" href="css/style.css">');
    expect(html).toContain('<main id="main">\n<h1>About</h1>\n</main>');
    expect(html).toContain('<title>About Us – Green Thumb</title>');
    expect(unbalancedTags(html)).toEqual([]);
  });
});

describe('helpers', () => {
  it('adds and replaces hreflang links', () => {
    const src = '<html><head><title>x</title></head><body></body></html>';
    const once = setAlternateLinks(src, [{ lang: 'es', href: 'es/index.html' }]);
    const twice = setAlternateLinks(once, [{ lang: 'es', href: 'es/inicio.html' }]);
    expect(twice.match(/hreflang/g)!.length).toBe(1);
    expect(twice).toContain('href="es/inicio.html"');
    expect(langCode('Spanish')).toBe('es');
    expect(langCode('ja')).toBe('ja');
  });
  it('outlines structure without text', () => {
    const o = structureOutline('<body><header class="top"><nav><a>One</a><a>Two</a><a>Three</a></nav></header><main><h1>Secret headline</h1><img src="https://x/y.png"></main></body>');
    expect(o).toContain('header.top');
    expect(o).toContain('a × 3');
    expect(o).not.toContain('Secret');
    expect(o).not.toContain('y.png');
  });
  it('diffs lines', () => {
    const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(d.map((l) => l.op + l.text)).toEqual([' a', '-b', '+B', ' c', ' d', '+e']);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    const folded = foldDiff(lineDiff(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 15 ? 'X' : `l${i}`)).join('\n')), 2);
    expect(folded[0]).toEqual({ op: '…', text: '13 unchanged lines' });
  });
  it('builds prompts and page text', () => {
    expect(pagePrompt({ purpose: 'A bakery', framework: 'bootstrap' })).toMatch(/Bootstrap 5\.3/);
    expect(TEXT_TASKS.translate.prompt('<p>Hi</p>', 'French')).toMatch(/into French[\s\S]*Keep its inline markup/);
    expect(pageTextFor('<title>T</title><body><h2>Head</h2><p>Body &amp; soul</p><script>x()</script></body>')).toBe('Title: T\n## Head\nBody & soul');
    expect(codeLang('a/b.css').fence).toBe('css');
    expect(codeLang('x.html').name).toBe('HTML');
  });
});

describe('AI commands', () => {
  it('registers every ai.* id the menus and ribbon name', () => {
    const want = [...new Set([...classicIds(), ...idsInTabs()])].filter((id) => id.startsWith('ai.'));
    expect(want.length).toBeGreaterThan(40);
    expect(want.filter((id) => !getCommand(id))).toEqual([]);
  });
});
