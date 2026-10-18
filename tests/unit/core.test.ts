import { describe, it, expect } from 'vitest';
import { resolveRef, relativeRef, normalizePath, isExternal, mimeOf, isPagePath, slugify } from '../../src/model/paths';
import { Site, linksOf, rewriteRefs, defaultNav, pageTitle, decodeText } from '../../src/model/site';
import { bodyInner, replaceBody, headInsert, setTitle, getTitle, setMeta, getMeta, setDoctype, getDoctype, addStylesheet, linkedStyles, removeStylesheet, formatHtml, setCharset, getCharset, htmlToText, toXhtml, setTagAttr } from '../../src/model/html';

describe('paths', () => {
  it('resolves relative, root-relative and folder links', () => {
    expect(resolveRef('blog/post.html', '../css/a.css')).toBe('css/a.css');
    expect(resolveRef('blog/post.html', 'img/x.png?v=2#t')).toBe('blog/img/x.png');
    expect(resolveRef('blog/post.html', '/about.html')).toBe('about.html');
    expect(resolveRef('index.html', 'docs/')).toBe('docs/index.html');
    expect(resolveRef('index.html', 'my%20page.html')).toBe('my page.html');
    expect(resolveRef('a.html', 'https://x.org/a')).toBeNull();
    expect(resolveRef('a.html', '#top')).toBeNull();
    expect(resolveRef('a.html', 'mailto:a@b.c')).toBeNull();
  });
  it('makes relative links', () => {
    expect(relativeRef('blog/post.html', 'css/a.css')).toBe('../css/a.css');
    expect(relativeRef('index.html', 'blog/post.html')).toBe('blog/post.html');
    expect(relativeRef('a/b/c.html', 'a/b/d.html')).toBe('d.html');
    expect(relativeRef('a/c.html', 'a/b/my page.html')).toBe('b/my%20page.html');
  });
  it('normalizes and classifies', () => {
    expect(normalizePath('/a//b/./c/../d')).toBe('a/b/d');
    expect(normalizePath('../../x')).toBe('x');
    expect(isExternal('//cdn.x/y.js')).toBe(true);
    expect(mimeOf('a/B.PNG')).toBe('image/png');
    expect(isPagePath('t.dwt')).toBe(true);
    expect(slugify('About Us — Our Story!')).toBe('about-us-our-story');
  });
});

function sampleSite(): Site {
  const s = new Site('Test');
  s.write('index.html', '<!DOCTYPE html><html><head><title>Home</title><link rel="stylesheet" href="css/site.css"></head><body><a href="about/team.html">Team</a><img src="images/logo.png" srcset="images/logo.png 1x, images/logo@2x.png 2x"></body></html>');
  s.write('about/team.html', '<html><head><title>Team</title><link rel="stylesheet" href="../css/site.css"></head><body><a href="../index.html">Home</a><img src="../images/logo.png"></body></html>');
  s.write('css/site.css', 'body { background: url("../images/bg.jpg"); } @import "more.css";');
  s.write('css/more.css', '');
  s.write('images/logo.png', new Uint8Array([137, 80, 78, 71]));
  s.write('images/bg.jpg', new Uint8Array([255, 216]));
  return s;
}

describe('site', () => {
  it('lists links of pages and style sheets', () => {
    const s = sampleSite();
    expect(linksOf(s.read('index.html')!, 'index.html').map((l) => l[0])).toEqual(['css/site.css', 'about/team.html', 'images/logo.png', 'images/logo.png', 'images/logo@2x.png']);
    expect(linksOf(s.read('css/site.css')!, 'css/site.css').map((l) => l[0])).toEqual(['images/bg.jpg', 'css/more.css']);
  });
  it('fixes links when a file moves', () => {
    const s = sampleSite();
    const n = s.rename('images/logo.png', 'media/brand/logo.png');
    expect(n).toBe(2);
    expect(s.read('index.html')).toContain('src="media/brand/logo.png"');
    expect(s.read('index.html')).toContain('srcset="media/brand/logo.png 1x, images/logo@2x.png 2x"');
    expect(s.read('about/team.html')).toContain('src="../media/brand/logo.png"');
    expect(s.has('images/logo.png')).toBe(false);
    expect(s.bytes('media/brand/logo.png')!.length).toBe(4);
  });
  it('fixes links inside a moved page and links to it', () => {
    const s = sampleSite();
    s.rename('about/team.html', 'team.html');
    expect(s.read('team.html')).toContain('href="css/site.css"');
    expect(s.read('team.html')).toContain('href="index.html"');
    expect(s.read('index.html')).toContain('href="team.html"');
  });
  it('moves folders', () => {
    const s = sampleSite();
    s.rename('css', 'styles');
    expect(s.read('index.html')).toContain('href="styles/site.css"');
    expect(s.read('styles/site.css')).toContain('url("../images/bg.jpg")');
    expect(s.lastMoves.get('css/more.css')).toBe('styles/more.css');
  });
  it('refuses to overwrite', () => {
    const s = sampleSite();
    expect(() => s.rename('css/more.css', 'css/site.css')).toThrow();
  });
  it('round-trips through JSON', () => {
    const s = sampleSite();
    s.data.tasks.push({ id: 't1', name: 'Fix', priority: 'High', assignedTo: 'me', status: 'Not Started', description: '', created: 1 });
    const c = Site.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(c.read('index.html')).toBe(s.read('index.html'));
    expect([...c.bytes('images/bg.jpg')!]).toEqual([255, 216]);
    expect(c.data.tasks[0].name).toBe('Fix');
  });
  it('builds navigation and titles', () => {
    const s = sampleSite();
    const nav = defaultNav(s);
    expect(nav.path).toBe('index.html');
    expect(pageTitle(s, 'about/team.html')).toBe('Team');
  });
  it('rewrites only in-site links', () => {
    const out = rewriteRefs('<a href="https://x.org/a.html">x</a><a href="a.html#b">y</a>', 'p.html', () => 'z.html');
    expect(out).toBe('<a href="https://x.org/a.html">x</a><a href="z.html#b">y</a>');
  });
  it('decodes legacy text', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
  });
});

describe('html source helpers', () => {
  const page = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>A &amp; B</title>\n</head>\n<body class="x">\n<p>Hi</p>\n</body>\n</html>\n';
  it('reads and replaces the body, keeping the rest', () => {
    expect(bodyInner(page)).toBe('\n<p>Hi</p>\n');
    const r = replaceBody(page, '<p>Bye</p>', '<body>');
    expect(r).toBe(page.replace('<body class="x">\n<p>Hi</p>\n', '<body><p>Bye</p>'));
  });
  it('edits the title, meta, doctype and charset', () => {
    expect(getTitle(page)).toBe('A & B');
    expect(getTitle(setTitle(page, 'C < D'))).toBe('C < D');
    const m = setMeta(page, 'description', 'About "us"');
    expect(getMeta(m, 'description')).toBe('About "us"');
    expect(getMeta(setMeta(m, 'description', null), 'description')).toBeNull();
    expect(getDoctype(setDoctype(page, 'xhtml1s'))).toBe('xhtml1s');
    expect(getCharset(setCharset(page, 'windows-1252'))).toBe('windows-1252');
  });
  it('inserts into the head with indentation', () => {
    const r = headInsert(page, '<meta name="x" content="y">');
    expect(r).toContain('  <title>A &amp; B</title>\n  <meta name="x" content="y">\n</head>');
  });
  it('links and unlinks style sheets', () => {
    const r = addStylesheet(page, 'css/a.css');
    expect(linkedStyles(r)).toEqual(['css/a.css']);
    expect(addStylesheet(r, 'css/a.css')).toBe(r);
    expect(linkedStyles(removeStylesheet(r, 'css/a.css'))).toEqual([]);
  });
  it('formats markup', () => {
    const f = formatHtml('<html><head><title>t</title></head><body><div><p>a <b>b</b></p><ul><li>x</li></ul></div><pre>  keep\n me</pre></body></html>');
    expect(f).toContain('<head>\n  <title>t</title>\n</head>\n<body>\n  <div>\n    <p>a <b>b</b></p>\n    <ul>\n      <li>x</li>\n    </ul>\n  </div>');
    expect(f).toContain('<pre>  keep\n me</pre>');
  });
  it('converts to XHTML syntax and text', () => {
    expect(toXhtml('<BR><IMG SRC=a.png ALT=x><input checked>')).toBe('<br /><img src="a.png" alt="x" /><input checked="checked" />');
    expect(htmlToText('<p>a</p><script>x</script><p>b&amp;c</p>')).toBe('a\nb&c');
    expect(setTagAttr('<body class="a">', 'class', 'b')).toBe('<body class="b">');
  });
});

import { restoreOriginals } from '../../src/editor/resources';
describe('design view originals', () => {
  it('restores script types and resource links exactly', () => {
    const d = document.createElement('div');
    d.innerHTML = '<script type="text/x-ql-inert" data-ql-o-type="">a()</script><script type="text/x-ql-inert" data-ql-o-type="module">b()</script><img src="blob:x" data-ql-o-src="img/a.png">';
    restoreOriginals(d);
    expect(d.innerHTML).toBe('<script>a()</script><script type="module">b()</script><img src="img/a.png">');
  });
});
