import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import { detectArchive, siteFromArchive, pickTemplateRoot, unwrapArchive } from '../../src/io/archive';
import { wxrToSite, siteToWxr, parseWxr, autop } from '../../src/io/wxr';
import { htmlToBlocks, blocksToHtml, parseBlocks } from '../../src/io/blocks';
import { parseMhtml, buildMhtml, isMhtml } from '../../src/io/mhtml';
import { lessToCss, exportWeeblyThemeFiles } from '../../src/io/weebly';
import { exportWordPressThemeFiles, themeHeader } from '../../src/io/wpTheme';
import { cleanWordHtml } from '../../src/io/wordHtml';
import { markdownToHtml, markdownToPage } from '../../src/io/markdown';
import { renderPhp } from '../../src/io/php';
import { exportEmbed, exportVelo } from '../../src/io/wix';
import { exportJekyllFiles, exportHugoFiles, exportStaticFiles } from '../../src/io/ssg';
import { splitMain } from '../../src/io/common';
import { Site } from '../../src/model/site';
import { pageRegions, templateRegions } from '../../src/site/templates';

const FIX = join(__dirname, '../fixtures/cms');

function load(dir: string, prefix = ''): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(prefix + relative(dir, p).replace(/\\/g, '/'), new Uint8Array(readFileSync(p)));
    }
  };
  walk(dir);
  return out;
}
const text = (s: string) => new TextEncoder().encode(s);
const read = (name: string) => readFileSync(join(FIX, name), 'utf8');
const noPhp = (s: string) => !/<\?(php|=)/.test(s) && !/\?>/.test(s);

describe('archive detection', () => {
  it('recognizes every kind', () => {
    expect(detectArchive(load(join(FIX, 'wp-classic'), 'harbor-light/'))).toBe('wp-theme');
    expect(detectArchive(load(join(FIX, 'wp-block')))).toBe('wp-theme');
    expect(detectArchive(load(join(FIX, 'joomla-template')))).toBe('joomla-template');
    expect(detectArchive(load(join(FIX, 'drupal-theme')))).toBe('drupal-theme');
    expect(detectArchive(load(join(FIX, 'weebly-theme')))).toBe('weebly-theme');
    const archive = new Map([['index.html', text('<html><body><script src="//cdn2.editmysite.com/js/site/main.js"></script></body></html>')], ['files/theme/main_style.css', text('body{}')]]);
    expect(detectArchive(archive)).toBe('weebly-archive');
    const tpl = new Map([['documentation/index.html', text('<h1>Docs</h1>')], ['Template/index.html', text('<html><body>Hi</body></html>')], ['Template/css/style.css', text('')], ['Template/js/main.js', text('')], ['PSD/home.psd', new Uint8Array(4)]]);
    expect(detectArchive(tpl)).toBe('html-template');
    expect(pickTemplateRoot(tpl)).toBe('Template');
    expect(detectArchive(new Map([['index.html', text('<p>x</p>')], ['about.html', text('<p>y</p>')]]))).toBe('site');
  });

  it('prefers built output over sources and unwraps nested zips', async () => {
    const files = new Map([['src/index.html', text('<p>src</p>')], ['dist/index.html', text('<p>dist</p>')], ['dist/css/a.css', text('')], ['src/scss/a.scss', text('')]]);
    expect(pickTemplateRoot(files)).toBe('dist');
    const inner = new JSZip();
    inner.file('shop/index.html', '<html><body>Shop</body></html>');
    inner.file('shop/css/shop.css', 'body{}');
    const outer = new Map([['Documentation/readme.html', text('<p>docs</p>')], ['shop-template.zip', await inner.generateAsync({ type: 'uint8array' })]]);
    const u = await unwrapArchive(outer);
    expect(u.inner).toBe('shop-template.zip');
    expect(u.files.has('shop/index.html')).toBe(true);
    const r = await siteFromArchive('package', outer);
    expect(r.site.has('index.html')).toBe(true);
    expect(r.site.has('css/shop.css')).toBe(true);
    expect(r.report.join(' ')).toMatch(/license/i);
  });
});

describe('WordPress classic theme', () => {
  it('stitches header, page and footer into static pages with no PHP left', async () => {
    const r = await siteFromArchive('harbor', load(join(FIX, 'wp-classic'), 'harbor-light/'));
    const s = r.site;
    expect(s.name).toBe('Harbor Light');
    for (const p of ['Templates/page.dwt', 'index.html', 'about.html', 'blog/index.html', 'blog/hello-world.html', 'Templates/post.dwt']) expect(s.has(p), p).toBe(true);
    for (const f of s.pages()) if (!f.path.startsWith('_theme-source/')) expect(noPhp(f.text!), f.path).toBe(true);
    const tpl = s.read('Templates/page.dwt')!;
    expect(templateRegions(tpl).map((x) => x.name).sort()).toEqual(['content', 'doctitle', 'pagetitle']);
    expect(tpl).toContain('href="../style.css"');
    expect(tpl).toContain('href="../css/layout.css"');
    expect(tpl).toContain('src="../js/nav.js"');
    expect(tpl).toContain('src="../images/logo.svg"');
    expect(tpl).toMatch(/<ul class="nav-menu">.*about\.html/);
    expect(tpl).toContain('Harbor Light');
    expect(tpl).toContain('Theme: Harbor Light');
    expect(tpl).toContain(`&copy; ${new Date().getFullYear()}`);
    const about = s.read('about.html')!;
    expect(pageRegions(about).find((x) => x.name === 'pagetitle')!.content).toBe('About');
    expect(about).toContain('href="style.css"');
    expect(s.data.templates['about.html']).toBe('Templates/page.dwt');
    const blog = s.read('blog/index.html')!;
    expect(blog).toContain('Hello world');
    expect(blog).toContain('A second post');
    expect(blog).toContain('href="hello-world.html"');
    expect(s.get('_theme-source/header.php')?.noPublish).toBe(true);
    expect(r.report.join('\n')).toMatch(/harbor_social_links/);
    expect(r.report.join('\n')).toMatch(/widget area/);
  });

  it('reads PHP conditionals, loops, assignments and printf without running anything', () => {
    const out = renderPhp(`<?php $x = 'a' . "b"; if ( $x === 'ab' ) : ?>yes<?php else : ?>no<?php endif; ?><?php foreach ( $items as $i ) { echo 'once'; } ?><?php printf( '%s-%s', 'p', 'q' ); ?><?= strtoupper('z') ?>`, { call: () => undefined, value: () => undefined, cond: () => undefined }, { dropped: [], assumed: [] });
    expect(out).toBe('yesoncep-qZ');
  });

  it('parses the style.css header', () => {
    expect(themeHeader(read('wp-classic/style.css'))['theme name']).toBe('Harbor Light');
  });
});

describe('WordPress block theme', () => {
  it('renders templates with parts, patterns and theme.json styles', async () => {
    const r = await siteFromArchive('pine', load(join(FIX, 'wp-block')));
    const s = r.site;
    const tpl = s.read('Templates/page.dwt')!;
    expect(tpl).not.toMatch(/<!--\s+\/?wp:/);
    expect(tpl).toContain('<header class="wp-block-template-part">');
    expect(tpl).toContain('class="wp-block-site-title"');
    expect(tpl).toMatch(/wp-block-navigation[^>]*>.*about\.html/);
    expect(tpl).toContain('is-layout-flex');
    expect(templateRegions(tpl).map((x) => x.name)).toContain('content');
    const front = s.read('Templates/front-page.dwt')!;
    expect(front).toContain('Quiet places');
    expect(front).toContain('src="../assets/images/pines.svg"');
    expect(front).toContain('wp-block-columns');
    const blog = s.read('blog/index.html')!;
    expect(blog).toContain('Hello world');
    expect(blog).toContain('wp-block-post-template');
    const css = s.read('wp-theme.css')!;
    expect(css).toContain('--wp--preset--color--accent: #2f7a4f;');
    expect(css).toContain('.has-accent-color');
    expect(css).toContain('background-color: var(--wp--preset--color--base)');
    expect(css).toContain('url("assets/fonts/inter.woff2")');
    expect(css).toContain('--wp--style--global--content-size: 640px;');
    expect(s.has('assets/fonts/inter.woff2')).toBe(true);
  });
});

describe('Joomla and Drupal', () => {
  it('turns a Joomla template into a page template', async () => {
    const r = await siteFromArchive('tide', load(join(FIX, 'joomla-template')));
    const tpl = r.site.read('Templates/page.dwt')!;
    expect(noPhp(tpl)).toBe(true);
    expect(tpl).not.toContain('jdoc:include');
    expect(tpl).toContain('href="../css/template.css"');
    expect(tpl).toMatch(/mod-menu.*about\.html/);
    expect(templateRegions(tpl).map((x) => x.name)).toContain('content');
    expect(r.report.join(' ')).toMatch(/sidebar-right/);
    expect(r.site.read('index.html')).toContain('Tidewater');
  });

  it('turns a Drupal theme into a page template', async () => {
    const r = await siteFromArchive('lumen', load(join(FIX, 'drupal-theme')));
    const tpl = r.site.read('Templates/page.dwt')!;
    expect(tpl).not.toMatch(/\{\{|\{%/);
    expect(tpl).toContain('href="../css/base.css"');
    expect(tpl).toContain('Lumen');
    expect(tpl).not.toContain('No sidebar');
    expect(tpl).toMatch(/region-primary_menu.*about\.html/);
  });
});

describe('WordPress export files (WXR)', () => {
  it('builds pages, posts, hierarchy and menus', () => {
    const r = wxrToSite(read('sample-wxr.xml'));
    const s = r.site;
    expect(s.name).toBe('Maple Street Bakery');
    expect(s.has('index.html')).toBe(true);
    expect(s.has('about/index.html')).toBe(true);
    expect(s.has('about/team.html')).toBe(true);
    expect(s.has('blog/rye-is-back.html')).toBe(true);
    expect(s.has('blog/index.html')).toBe(true);
    expect(s.has('blog/category/news.html')).toBe(true);
    expect([...s.files.keys()].some((k) => /draft-idea/.test(k))).toBe(false);
    const home = s.read('index.html')!;
    expect(home).toContain('<h2 class="wp-block-heading">Welcome</h2>');
    expect(home).not.toMatch(/<!--\s+wp:/);
    expect(home).toContain('href="about/index.html"');
    expect(home).toContain('https://maple.example.org/wp-content/uploads/2024/05/loaf.jpg');
    const about = s.read('about/index.html')!;
    expect(about).toContain('<p>Our bakery opened in 1998.</p>');
    expect(about).toContain('We use local flour.<br>');
    expect(about).toContain('[contact-form-7 id="12" title="Contact"]');
    expect(s.data.nav!.children[0].path).toBe('about/index.html');
    expect(s.data.nav!.children[0].children[0].path).toBe('about/team.html');
    expect(s.read('Templates/site.dwt')).toContain('https://orders.example.net/maple');
    expect(r.report.join(' ')).toMatch(/contact-form-7/);
    expect(r.report.join(' ')).toMatch(/media\.txt/);
    expect(s.read('blog/rye-is-back.html')).toContain('Robin Baker');
  });

  it('round-trips through siteToWxr', () => {
    const s = wxrToSite(read('sample-wxr.xml')).site;
    const xml = siteToWxr(s, { siteUrl: 'https://new.example.org' });
    const m = parseWxr(xml);
    const pages = m.items.filter((i) => i.type === 'page');
    const titles = pages.map((p) => p.title);
    expect(titles).toContain('About');
    expect(titles).toContain('Our Team');
    expect(titles).toContain('Rye is back');
    const team = pages.find((p) => p.title === 'Our Team')!;
    const about = pages.find((p) => p.title === 'About')!;
    expect(team.parent).toBe(about.id);
    expect(team.slug).toBe('team');
    expect(team.content).toContain('<!-- wp:list -->');
    expect(about.content).not.toContain('<h1>');
    expect(m.items.some((i) => i.type === 'nav_menu_item')).toBe(true);
    const back = wxrToSite(xml).site;
    expect(back.has('about/team.html')).toBe(true);
    expect(back.read('about/team.html')).toContain('<li>Robin</li>');
  });

  it('applies automatic paragraphs to classic content', () => {
    expect(autop('One\n\nTwo\nthree')).toBe('<p>One</p>\n<p>Two<br>\nthree</p>');
  });
});

describe('block markup', () => {
  it('converts HTML to blocks', () => {
    const b = htmlToBlocks('<h1>Title</h1><p style="text-align:center">Hi <b>there</b></p><ul><li>a<ul><li>b</li></ul></li></ul><p><img src="x.png" alt="X"></p><blockquote><p>Q</p><cite>Me</cite></blockquote><pre><code>a &lt; b</code></pre><table><tr><td>1</td></tr></table><hr><p><a class="btn" href="/go">Go</a></p><div class="row"><div class="col-6"><p>L</p></div><div class="col-6"><p>R</p></div></div><form><input></form>loose text');
    expect(b).toContain('<!-- wp:heading {"level":1} -->');
    expect(b).toContain('<!-- wp:paragraph {"align":"center"} -->\n<p class="has-text-align-center">Hi <b>there</b></p>');
    expect(b).toContain('<!-- wp:list -->');
    expect(b).toContain('<!-- wp:list-item -->');
    expect(b).toMatch(/<!-- wp:image \{"sizeSlug":"large"\} -->\n<figure class="wp-block-image size-large"><img src="x.png" alt="X"\/><\/figure>/);
    expect(b).toContain('<!-- wp:quote -->');
    expect(b).toContain('<cite>Me</cite>');
    expect(b).toContain('<!-- wp:code -->\n<pre class="wp-block-code"><code>a &lt; b</code></pre>');
    expect(b).toContain('<!-- wp:table -->');
    expect(b).toContain('<!-- wp:separator -->');
    expect(b).toContain('<!-- wp:buttons -->');
    expect(b).toContain('wp-block-button__link');
    expect(b).toContain('<!-- wp:columns -->');
    expect(b).toContain('<!-- wp:html -->\n<form>');
    expect(b).toContain('<p>loose text</p>');
    // Every opener has a closer.
    const opens = (b.match(/<!-- wp:([\w/-]+)/g) || []).length;
    const closes = (b.match(/<!-- \/wp:([\w/-]+)/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('converts blocks to HTML', () => {
    const html = blocksToHtml('<!-- wp:paragraph -->\n<p>A</p>\n<!-- /wp:paragraph -->\n<!-- wp:separator -->\n<hr class="wp-block-separator"/>\n<!-- /wp:separator -->\n<!-- wp:group {"layout":{"type":"flex"}} --><div class="wp-block-group"><!-- wp:image {"id":3} --><figure class="wp-block-image"><img src="a.jpg" alt=""/></figure><!-- /wp:image --></div><!-- /wp:group --><!-- wp:latest-posts /-->');
    expect(html).not.toMatch(/<!--\s+\/?wp:/);
    expect(html).toContain('<p>A</p>');
    expect(html).toContain('<hr class="wp-block-separator"/>');
    expect(html).toContain('<div class="wp-block-group is-layout-flex">');
    expect(html).toContain('<img src="a.jpg" alt=""/>');
    expect(html).toContain('latest-posts (dynamic block');
    const tree = parseBlocks('<!-- wp:heading {"level":3,"content":"a--b"} --><h3>x</h3><!-- /wp:heading -->');
    expect((tree[0] as any).attrs.level).toBe(3);
  });

  it('round-trips HTML through blocks', () => {
    const src = '<h2>Hello</h2><p>World <em>!</em></p><ol><li>one</li><li>two</li></ol>';
    const back = blocksToHtml(htmlToBlocks(src)).replace(/\s+/g, ' ');
    expect(back).toContain('<h2 class="wp-block-heading">Hello</h2>');
    expect(back).toContain('<p>World <em>!</em></p>');
    expect(back).toMatch(/<ol class="wp-block-list"> ?<li>one<\/li> ?<li>two<\/li> ?<\/ol>/);
  });
});

describe('Weebly', () => {
  it('imports a theme: tags replaced, LESS compiled, assets relinked', async () => {
    const r = await siteFromArchive('ember', load(join(FIX, 'weebly-theme')));
    const s = r.site;
    expect(s.has('index.html')).toBe(true);
    expect(s.has('no-header.html')).toBe(true);
    expect(s.has('splash.html')).toBe(true);
    const home = s.read('index.html')!;
    expect(home).not.toMatch(/\{(title|menu|content|logo|footer|header|social)\}/);
    expect(home).toContain('var x = {a: 1};');
    expect(home).toContain('href="main.css"');
    expect(home).toContain('url(assets/hero.svg)');
    expect(home).toMatch(/<ul class="wsite-menu-default menu">.*no-header\.html/);
    expect(home).toContain('(555) 010-0000');
    expect(s.read('splash.html')).toContain('wsite-button');
    const css = s.read('main.css')!;
    expect(css).toContain('body .header .nav a {');
    expect(css).toContain('color: #8a3b12;');
    expect(css).toContain('body .header .nav a:hover {');
    expect(css).toContain('url(assets/hero.svg)');
    expect(css).toContain('border-radius: 6px;');
    expect(css).toMatch(/@media \(max-width: 600px\) \{\s+\.wsite-button \{\s+display: block;/);
  });

  it('compiles LESS variables, nesting and mixins', () => {
    const r = lessToCss('@c: red; @d: @c;\n.m() { margin: 0 }\n.a { color: @d; .m(); &.b { x: 1 } .c, .d { y: 2 } }\n.e { .missing(); }');
    expect(r.css).toContain('.a {\n  color: red;\n  margin: 0;\n}');
    expect(r.css).toContain('.a.b {');
    expect(r.css).toContain('.a .c, .a .d {');
    expect(r.css).not.toContain('.m()');
    expect(r.warnings.join(' ')).toMatch(/missing/);
  });

  it('exports a theme with Weebly tags', () => {
    const s = new Site('Shop');
    s.write('css/site.css', 'header { background: url(../img/top.png); }');
    s.write('img/top.png', new Uint8Array([137, 80, 78, 71]));
    s.write('index.html', '<!DOCTYPE html><html><head><title>Shop</title><link rel="stylesheet" href="css/site.css"></head><body><header><a class="logo" href="index.html">Shop</a><nav><ul><li><a href="index.html">Home</a></li></ul></nav></header><main><p>Hello</p></main><footer><p>© Shop</p></footer></body></html>');
    const files = exportWeeblyThemeFiles(s);
    const idx = files.get('index.html') as string;
    for (const t of ['{title}', '{menu}', '{logo}', '{content}', '{footer}']) expect(idx).toContain(t);
    expect(idx).not.toContain('<p>Hello</p>');
    expect(files.get('main.css')).toContain('url(/files/theme/top.png)');
    expect(files.has('assets/top.png')).toBe(true);
    expect(files.has('no-header.html')).toBe(true);
    expect(files.has('splash.html')).toBe(true);
  });
});

describe('web archives (MHTML)', () => {
  it('parses quoted-printable and base64 parts and relinks resources', () => {
    const r = parseMhtml(new Uint8Array(readFileSync(join(FIX, 'page.mht'))));
    expect(isMhtml(read('page.mht'))).toBe(true);
    expect(r.title).toBe('Garden Notes');
    expect(r.html).toContain('Garden Notes — Spring');
    expect(r.html).toContain('href="garden-notes_files/main.css"');
    expect(r.html).toContain('src="garden-notes_files/tulip.png"');
    expect(r.html).toMatch(/src="garden-notes_files\/file\.gif"/);
    const png = r.files.get('garden-notes_files/tulip.png')!;
    expect([...png.slice(0, 4)]).toEqual([137, 80, 78, 71]);
    expect(new TextDecoder().decode(r.files.get('garden-notes_files/main.css'))).toContain('url("leaf.gif")');
  });

  it('builds an archive that parses back', () => {
    const s = new Site('A');
    s.write('css/a.css', 'body { background: url(../img/bg.png); }');
    s.write('img/bg.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    s.write('img/pic.png', new Uint8Array([137, 80, 78, 71, 9]));
    s.write('page.html', '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Café</title><link rel="stylesheet" href="css/a.css"></head><body><p>Crème brûlée — “quoted” ' + 'x'.repeat(120) + '</p><img src="img/pic.png"><a href="other.html">other</a></body></html>');
    s.write('other.html', '<p>o</p>');
    const mht = buildMhtml(s, 'page.html');
    expect(mht).toContain('Content-Type: multipart/related;');
    const r = parseMhtml(new TextEncoder().encode(mht));
    expect(r.title).toBe('Café');
    expect(r.html).toContain('Crème brûlée — “quoted”');
    expect(r.html).toContain('x'.repeat(120));
    const pic = [...r.files].find(([k]) => k.endsWith('pic.png'))!;
    expect([...pic[1]]).toEqual([137, 80, 78, 71, 9]);
    expect(r.html).toContain(`src="${pic[0]}"`);
    const css = [...r.files].find(([k]) => k.endsWith('a.css'))!;
    expect(new TextDecoder().decode(css[1])).toMatch(/url\(bg\.png\)/);
    expect(r.files.size).toBe(3);
  });
});

describe('word-processor HTML', () => {
  it('removes Office markup and rebuilds lists', () => {
    const r = cleanWordHtml(read('word.htm'));
    const b = r.body;
    expect(r.title).toBe('Trip Report');
    expect(b).toContain('<h1>Trip Report</h1>');
    expect(b).not.toMatch(/Mso|mso-|<o:p|<v:|<xml|<font|<!--\[if|_Toc/);
    expect(b).toContain('<strong>three</strong>');
    expect(b).toContain('<em>one</em>');
    expect(b).toContain('text-align: center');
    expect(b.replace(/\n/g, '')).toMatch(/<ul><li>Oakdale<ul><li>The old mill<\/li><\/ul><\/li><li>Pine Bluff<\/li><\/ul>/);
    expect(b).toContain('Plain text');
    expect(r.report.join(' ')).toMatch(/report_files\/image002\.png/);
  });
});

describe('Markdown', () => {
  it('converts the common syntax', () => {
    const r = markdownToPage(read('sample.md'), 'sample.md');
    const h = r.body;
    expect(r.title).toBe('Field Guide');
    expect(h).toContain('<h1 id="birds-of-the-valley">Birds of the Valley</h1>');
    expect(h).toContain('<em>common</em>');
    expect(h).toContain('<strong>rare</strong>');
    expect(h).toContain('<code>code</code>');
    expect(h).toContain('<a href="https://example.org" title="Example">link</a>');
    expect(h).toMatch(/<li>Finch\n?<ul>\n<li>House finch<\/li>/);
    expect(h).toContain('<input type="checkbox" disabled checked> Seen today');
    expect(h).toContain('<ol>\n<li>First</li>');
    expect(h).toContain('<blockquote>\n<p>A quote\nover two lines</p>\n</blockquote>');
    expect(h).toContain('<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>');
    expect(h).toContain('<th style="text-align: left">Bird</th>');
    expect(h).toContain('<td style="text-align: right">3</td>');
    expect(h).toContain('<img src="img/heron.jpg" alt="Heron">');
    expect(h).toContain('<hr>');
    expect(h).toContain('Line one<br>');
    expect(h).toContain('<del>gone</del>');
    expect(h).toContain('<a href="https://example.org/guide">ref link</a>');
  });
  it('handles setext headings and escapes', () => {
    expect(markdownToHtml('Title\n=====\n\n\\*not em\\* & <b>raw</b>')).toBe('<h1 id="title">Title</h1>\n<p>*not em* &amp; <b>raw</b></p>\n');
  });
});

describe('exports', () => {
  const site = () => {
    const s = new Site('Lake House');
    s.write('css/site.css', 'body { color: #333; } .hero { background: url(../img/lake.png); }');
    s.write('img/lake.png', new Uint8Array([137, 80, 78, 71]));
    s.write('js/menu.js', 'void 0;');
    s.write('Templates/main.dwt', '<!DOCTYPE html><html><head><!-- #BeginEditable "doctitle" --><title>Lake House</title><!-- #EndEditable --><link rel="stylesheet" href="../css/site.css"></head><body><header><p class="site-title">Lake House</p><nav><ul class="menu"><li><a href="../index.html">Home</a></li><li><a href="../about.html">About</a></li></ul></nav></header><main><!-- #BeginEditable "content" --><p>x</p><!-- #EndEditable --></main><footer>© Lake House</footer><script src="../js/menu.js"></script></body></html>');
    s.write('index.html', '<!DOCTYPE html><html><!-- #BeginTemplate "/Templates/main.dwt" --><head><!-- #BeginEditable "doctitle" --><title>Home</title><!-- #EndEditable --><link rel="stylesheet" href="css/site.css"></head><body><header><p class="site-title">Lake House</p><nav><ul class="menu"><li><a href="index.html">Home</a></li><li><a href="about.html">About</a></li></ul></nav></header><main><!-- #BeginEditable "content" --><h1>Welcome</h1><p class="hero">Hi {{ there }}</p><img src="img/lake.png" alt=""><!-- #EndEditable --></main><footer>© Lake House</footer><script src="js/menu.js"></script></body><!-- #EndTemplate --></html>');
    s.write('about.html', '<!DOCTYPE html><html><head><title>About</title></head><body><main><h1>About</h1><p>Us</p></main></body></html>');
    s.data.templates['index.html'] = 'Templates/main.dwt';
    return s;
  };

  it('splits a page around its main content', () => {
    const p = splitMain(site().read('index.html')!);
    expect(p.how).toBe('region');
    expect(p.content).toContain('<h1>Welcome</h1>');
    expect(p.before).toContain('<nav>');
    expect(p.after).toContain('<footer>');
  });

  it('writes a classic WordPress theme', () => {
    const report: string[] = [];
    const files = exportWordPressThemeFiles(site(), { name: 'Lake House', report });
    const get = (p: string) => files.get('lake-house/' + p) as string;
    expect(get('style.css')).toMatch(/Theme Name: Lake House[\s\S]*License: GNU General Public License v2 or later[\s\S]*Text Domain: lake-house/);
    expect(get('functions.php')).toContain("get_template_directory_uri() . '/assets/css/site.css'");
    expect(get('functions.php')).toContain("'/assets/js/menu.js', array(), '1.0.0', true");
    expect(get('functions.php')).toContain("add_theme_support( 'title-tag' )");
    expect(get('header.php')).toContain('<?php wp_head(); ?>');
    expect(get('header.php')).toContain("wp_nav_menu(");
    expect(get('header.php')).toContain("<?php bloginfo( 'name' ); ?>");
    expect(get('header.php')).not.toContain('Welcome');
    expect(get('header.php')).not.toMatch(/BeginEditable|BeginTemplate/);
    expect(get('footer.php')).toContain('<?php wp_footer(); ?>');
    expect(get('footer.php')).not.toContain('menu.js');
    expect(get('page.php')).toContain('the_content()');
    expect(get('index.php')).toContain('have_posts()');
    expect(get('single.php')).toContain('the_post()');
    expect(files.has('lake-house/assets/img/lake.png')).toBe(true);
    expect(files.has('lake-house/assets/css/site.css')).toBe(true);
  });

  it('writes Jekyll, Hugo and static exports', () => {
    const j = exportJekyllFiles(site());
    expect(j.get('_layouts/default.html')).toContain('{{ content }}');
    expect(j.get('_layouts/default.html')).toContain("{{ '/css/site.css' | relative_url }}");
    expect(j.get('index.html')).toMatch(/^---\nlayout: default\ntitle: "Welcome"\n---\n\{% raw %\}/);
    expect(j.has('img/lake.png')).toBe(true);
    const hu = exportHugoFiles(site());
    expect(hu.get('layouts/_default/baseof.html')).toContain('{{ block "main" . }}{{ end }}');
    expect(hu.get('layouts/_default/baseof.html')).toContain('{{ "css/site.css" | relURL }}');
    expect(hu.get('content/_index.html')).toContain('title: "Welcome"');
    expect(hu.get('content/about.html')).toContain('<p>Us</p>');
    expect(hu.has('static/css/site.css')).toBe(true);
    const st = exportStaticFiles(site());
    expect(st.has('Templates/main.dwt')).toBe(false);
    expect(st.get('index.html')).not.toMatch(/BeginEditable|BeginTemplate/);
  });

  it('writes Wix embed code and a custom element', () => {
    const e = exportEmbed(site(), 'index.html');
    expect(e.html).toContain('<style>');
    expect(e.html).toContain('data:image/png;base64,');
    expect(e.html).not.toContain('href="css/site.css"');
    expect(e.html).toContain('void 0;');
    const v = exportVelo(site(), 'index.html', { tagName: 'lake-page' });
    expect(v.js).toContain("customElements.define('lake-page', LakePage)");
    expect(v.js).toContain('attachShadow');
    expect(v.js).toContain('Welcome');
  });
});
