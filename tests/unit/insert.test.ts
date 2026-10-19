import { describe, it, expect } from 'vitest';
import '../../src/commands/insert';
import '../../src/commands/insertMedia';
import '../../src/commands/insertComponents';
import { getCommand, allCommands } from '../../src/commands/registry';
import { classicIds } from '../../src/ui/classicMenus';
import { idsInTabs } from '../../src/ui/ribbonLayout';
import { PANES } from '../../src/ui/panes';
import * as C from '../../src/editor/components';
import { blankPage } from '../../src/model/html';

const parse = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;

describe('insert command catalog', () => {
  it('registers every insert.* id the menus and ribbon name', () => {
    const want = [...new Set([...classicIds(), ...idsInTabs()])].filter((id) => id.startsWith('insert.'));
    expect(want.filter((id) => !getCommand(id))).toEqual([]);
    expect(want.length).toBeGreaterThan(150);
  });
  it('has unique labels per group and registers the panes', () => {
    const seen = new Set<string>();
    for (const c of allCommands().filter((x) => x.id.startsWith('insert.'))) {
      const k = `${c.tab}/${c.group}/${c.label}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
      expect(c.icon, c.id).toBeTruthy();
    }
    expect(PANES.toolbox?.side).toBe('right');
    expect(PANES.snippets?.side).toBe('right');
  });
  it('menu commands list registered commands', () => {
    const m = getCommand('insert.componentMenu')!.menu!({} as any);
    const ids = m.flatMap((e) => (e.submenu || [e]).map((x) => x.id)).filter(Boolean);
    expect(ids).toContain('insert.navbar');
    expect(ids.every((id) => getCommand(id!))).toBe(true);
  });
});

describe('head helpers', () => {
  const page = blankPage({ title: 'T' });
  it('ensureCss adds CSS once', () => {
    const a = C.ensureCss(page, 'x', '.a{color:red}');
    expect(a).toContain('/* ql:x */');
    expect(C.ensureCss(a, 'x', '.a{color:red}')).toBe(a);
    expect(a.match(/<style/g)!.length).toBe(1);
  });
  it('setLinkRel replaces an existing link', () => {
    const a = C.setLinkRel(page, 'canonical', '<link rel="canonical" href="https://a/">');
    const b = C.setLinkRel(a, 'canonical', '<link rel="canonical" href="https://b/">');
    expect(b).toContain('https://b/');
    expect(b).not.toContain('https://a/');
  });
  it('bodyEndInsert puts markup before </body>', () => {
    expect(C.bodyEndInsert(page, '<script src="x.js"></script>')).toMatch(/x\.js"><\/script>\n<\/body>/);
  });
  it('jsonLd escapes </script>', () => {
    const s = C.jsonLd({ '@type': 'WebPage', name: '</script><b>', empty: '' });
    expect(s).not.toContain('</script><b>');
    expect(s).not.toContain('empty');
    expect(JSON.parse(s.replace(/^<script[^>]*>|<\/script>$/g, '').replace(/<\\\//g, '</')).name).toBe('</script><b>');
  });
  it('builds Open Graph and Google Font tags', () => {
    expect(C.openGraphTags({ title: 'A', image: 'https://x/i.png' })).toEqual([['og:title', 'A'], ['og:type', 'website'], ['og:image', 'https://x/i.png']]);
    expect(C.googleFontTags([{ family: 'Open Sans', weights: '400;700' }])[2]).toContain('family=Open+Sans:wght@400;700');
  });
  it('analytics snippets', () => {
    expect(C.analyticsSnippet('plausible', 'example.com')).toContain('data-domain="example.com"');
    expect(C.analyticsSnippet('ga4', 'G-ABC123')).toContain("gtag('config','G-ABC123')");
  });
});

describe('media markup', () => {
  it('parses video addresses', () => {
    expect(C.parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43')).toBe('dQw4w9WgXcQ');
    expect(C.parseYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(C.parseYouTubeId('not a video')).toBeNull();
    expect(C.parseVimeoId('https://vimeo.com/76979871')).toBe('76979871');
    expect(C.parseStart('1:30')).toBe(90);
    expect(C.parseStart('https://youtu.be/x?t=1m5s')).toBe(65);
  });
  it('embeds privacy-enhanced players with titles', () => {
    const y = C.youtubeEmbed({ id: 'dQw4w9WgXcQ', title: 'Song', start: 10, responsive: true });
    expect(y).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ?start=10');
    expect(y).toContain('title="Song"');
    expect(C.vimeoEmbed({ id: '1234567', title: 'V' })).toContain('dnt=1');
  });
  it('builds OpenStreetMap embeds', () => {
    expect(C.parseMapLocation('https://www.openstreetmap.org/#map=15/51.5/-0.12')).toEqual({ zoom: 15, lat: 51.5, lon: -0.12 });
    expect(C.parseMapLocation('40.7, -73.9')).toEqual({ lat: 40.7, lon: -73.9 });
    const m = C.osmEmbed({ lat: 40, lon: -73, zoom: 12 });
    expect(m).toContain('openstreetmap.org/export/embed.html?bbox=');
    expect(m).toContain('marker=40.00000%2C-73.00000');
  });
  it('video and audio have controls, sources and fallbacks', () => {
    const v = parse(C.videoMarkup({ src: 'media/a.mp4', poster: 'p.jpg', autoplay: true }));
    const el = v.querySelector('video')!;
    expect(el.hasAttribute('controls') && el.hasAttribute('muted') && el.hasAttribute('playsinline')).toBe(true);
    expect(v.querySelector('source')!.getAttribute('type')).toBe('video/mp4');
    expect(parse(C.audioMarkup({ src: 'a.mp3' })).querySelector('audio[controls] source[type="audio/mpeg"]')).toBeTruthy();
  });
  it('images, pictures and maps', () => {
    expect(C.imageMarkup({ src: 'a b.png', alt: 'A "q"', width: 10, height: 5, caption: 'Cap' })).toBe('<figure>\n  <img src="a b.png" alt="A &quot;q&quot;" width="10" height="5">\n  <figcaption>Cap</figcaption>\n</figure>');
    const pic = parse(C.pictureMarkup({ src: 'a.jpg', alt: 'x', sources: [{ srcset: 'a.webp', type: 'image/webp' }] }));
    expect(pic.querySelector('picture > source[type="image/webp"] + img[alt="x"]')).toBeTruthy();
    const areas = C.parseAreas('rect 0,0,10,10 a.html Home\ncircle 5, 5, 3 b.html');
    expect(areas).toEqual([{ shape: 'rect', coords: '0,0,10,10', href: 'a.html', alt: 'Home' }, { shape: 'circle', coords: '5,5,3', href: 'b.html', alt: 'b.html' }]);
    expect(C.imageMapMarkup({ src: 'm.png', alt: 'Map', name: 'm', areas })).toContain('usemap="#m"');
  });
  it('legacy plug-ins use valid HTML5 objects with fallback text', () => {
    const f = parse(C.flashMarkup({ src: 'a.swf', width: 10, height: 10 }));
    expect(f.querySelector('object[type="application/x-shockwave-flash"] > p')).toBeTruthy();
    expect(C.appletMarkup({ code: 'Main.class', width: 1, height: 1 })).toContain('application/x-java-applet');
    expect(C.activexMarkup({ classid: 'ABC', width: 1, height: 1 })).toContain('classid="clsid:ABC"');
  });
  it('placeholder pictures are SVG data addresses', () => {
    const p = C.imagePlaceholder(300, 200);
    expect(p).toContain('src="data:image/svg+xml,');
    expect(p).toContain('width="300"');
  });
  it('rollover pictures carry the second picture', () => {
    const r = C.rolloverImage({ src: 'a.png', over: 'b.png', alt: 'A', href: 'x.html' });
    expect(r).toContain('data-ql-rollover="b.png"');
    expect(r).toContain('<script>');
  });
  it('interactive buttons are CSS-only links', () => {
    const b = C.interactiveButton({ text: 'Go', href: 'a.html', bg: '#00f', color: '#fff', hoverBg: '#008', pressedBg: '#004' }, 'btn1');
    expect(b.html).toBe('<a class="btn1" href="a.html">Go</a>');
    expect(b.css).toContain('.btn1:hover');
    expect(b.css).toContain('.btn1:active');
  });
  it('clip art, shapes and decorative text are labeled SVG', () => {
    expect(C.CLIP_ART.length).toBeGreaterThanOrEqual(20);
    for (const c of C.CLIP_ART) expect(parse(C.clipArtSvg(c.id)).querySelector('svg[role=img]')).toBeTruthy();
    for (const s of C.SHAPES) expect(C.shapeSvg({ kind: s, width: 100, height: 60, fill: '#f00' })).toMatch(/^<svg[\s\S]*<\/svg>$/);
    const t = C.decorativeText({ text: 'Hi & bye', effect: 'arc' }, 'w1');
    expect(t).toContain('aria-label="Hi &amp; bye"');
    expect(t).toContain('textPath href="#w1-p"');
  });
});

describe('math', () => {
  it('converts simple input to MathML', () => {
    expect(C.mathMarkup('x^2')).toContain('<msup><mi>x</mi><mn>2</mn></msup>');
    expect(C.mathMarkup('a/b')).toContain('<mfrac><mi>a</mi><mi>b</mi></mfrac>');
    expect(C.mathMarkup('sqrt(x+1)')).toContain('<msqrt><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></msqrt>');
    expect(C.mathMarkup('alpha <= pi', 'inline')).toBe('<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>α</mi><mo>≤</mo><mi>π</mi></mrow></math>');
    expect(C.mathMarkup('x_1^2')).toContain('<msubsup>');
    expect(C.mathMarkup('(a+b)/2')).toContain('<mfrac><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mn>2</mn></mfrac>');
  });
});

describe('characters and dates', () => {
  it('writes entities', () => {
    expect(C.entityFor('©')).toBe('&copy;');
    expect(C.entityFor('­')).toBe('&shy;');
    expect(C.entityFor('α')).toBe('&alpha;');
    expect(C.entityFor('₹')).toBe('&#x20B9;');
  });
  it('searches symbols by name, character and code', () => {
    expect(C.searchSymbols('copyright').some((s) => s.ch === '©')).toBe(true);
    expect(C.searchSymbols('U+2192').map((s) => s.ch)).toContain('→');
    expect(C.searchSymbols('eacute').map((s) => s.ch)).toContain('é');
  });
  it('formats dates and timestamps', () => {
    const d = new Date(2026, 9, 18, 15, 45, 12);
    expect(C.formatDate(d, 'long')).toBe('October 18, 2026');
    expect(C.formatDate(d, 'full')).toBe('Sunday, October 18, 2026');
    expect(C.formatTime(d, 't12')).toBe('3:45 PM');
    expect(C.dateMarkup(d, { date: 'iso' })).toBe('<time datetime="2026-10-18">2026-10-18</time>');
    const auto = C.dateMarkup(d, { date: 'long', time: 't24', auto: true });
    expect(auto).toContain('data-ql-timestamp="edited"');
    const later = C.refreshTimestamps(`<p class="x">${auto}</p>`, new Date(2027, 0, 2, 8, 5));
    expect(later).toContain('January 2, 2027 08:05');
    expect(later).toContain('datetime="2027-01-02T08:05"');
  });
});

describe('server code', () => {
  it('generates PHP, SSI, ASP and template tags', () => {
    expect(C.php.echo('$name')).toBe('<?= htmlspecialchars($name, ENT_QUOTES) ?>');
    expect(C.php.variable('_GET', 'q')).toBe("<?= htmlspecialchars($_GET['q'] ?? '', ENT_QUOTES) ?>");
    expect(C.php.if('$x', '<p>a</p>')).toBe('<?php if ($x): ?><p>a</p><?php endif; ?>');
    expect(C.php.include("a'b.php")).toBe("<?php include __DIR__ . '/a\\'b.php'; ?>");
    expect(C.ssi.include('/inc/footer.html')).toBe('<!--#include virtual="/inc/footer.html" -->');
    expect(C.asp.echo('x')).toBe('<%= Server.HTMLEncode(x) %>');
    expect(C.LIQUID.find((x) => x.id === 'for')!.text('<li>x</li>')).toBe('{% for item in collection %}<li>x</li>{% endfor %}');
  });
});

describe('components', () => {
  it('link bars and breadcrumbs are accessible navs', () => {
    const lb = C.linkBar([{ href: 'a.html', label: 'A', current: true }, { href: 'b.html', label: 'B & C' }], { mode: 'top', home: true });
    const nav = parse(lb.html).querySelector('nav')!;
    expect(nav.getAttribute('data-ql-linkbar')).toBe('top');
    expect(nav.getAttribute('data-ql-home')).toBe('true');
    expect(nav.querySelector('a[aria-current=page]')!.textContent).toBe('A');
    expect(nav.querySelectorAll('li').length).toBe(2);
    const bc = parse(C.breadcrumbs([{ href: 'index.html', label: 'Home' }, { href: 'x.html', label: 'X' }], true).html);
    expect(bc.querySelector('nav[aria-label=Breadcrumb][data-ql-linkbar=breadcrumbs] ol li:last-child a[aria-current=page]')).toBeTruthy();
  });
  it('adds heading ids and builds a nested table of contents', () => {
    const src = blankPage({ body: '<h2>Intro</h2><p>x</p><h3 id="det">Details</h3><h2>Intro</h2>' });
    const r = C.addHeadingIds(src);
    expect(r.headings.map((x) => x.id)).toEqual(['intro', 'det', 'intro-2']);
    expect(r.src).toContain('<h2 id="intro">Intro</h2>');
    const toc = parse(C.pageToc(r.headings).html);
    expect(toc.querySelectorAll('nav > ul > li').length).toBe(2);
    expect(toc.querySelector('nav > ul > li > ul > li > a')!.getAttribute('href')).toBe('#det');
  });
  it('site maps nest children', () => {
    const m = parse(C.siteMap([{ href: 'index.html', label: 'Home', children: [{ href: 'a.html', label: 'A' }] }]).html);
    expect(m.querySelector('ul > li > ul > li > a')!.getAttribute('href')).toBe('a.html');
  });
  it('photo galleries link to CSS lightboxes', () => {
    const g = C.photoGallery([{ src: 'a.jpg', alt: 'A', caption: 'Cap' }, { src: 'b.jpg', alt: 'B' }], { layout: 'masonry' }, 'g');
    const b = parse(g.html);
    expect(b.querySelector('#g.ql-gallery-masonry figure a[href="#g-1"] img[alt=A]')).toBeTruthy();
    expect(b.querySelector('#g-2.ql-lightbox a.ql-lightbox-close[href="#g"]')).toBeTruthy();
    expect(g.css).toContain('.ql-lightbox:target');
  });
  it('forms have labels for every control', () => {
    for (const c of [C.contactForm({ action: 'me@example.com', mailto: true }), C.feedbackForm({ action: 'https://f.example/x' }), C.newsletterForm({ action: 'x.php', honeypot: true })]) {
      const b = parse(c.html);
      const form = b.querySelector('form')!;
      for (const inp of b.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([name=_gotcha]), textarea, select')) {
        expect(b.querySelector(`label[for="${inp.id}"]`), inp.outerHTML).toBeTruthy();
      }
      if (form.getAttribute('action')!.startsWith('mailto:')) expect(form.getAttribute('enctype')).toBe('text/plain');
    }
    expect(C.contactForm({ action: 'me@example.com', mailto: true }).html).toContain('action="mailto:me@example.com"');
  });
  it('tabs, accordion, modal and navbar', () => {
    const t = parse(C.tabs([{ title: 'A', body: '<p>a</p>' }, { title: 'B', body: '<p>b</p>' }], 't').html);
    expect(t.querySelectorAll('input[type=radio][name=t]').length).toBe(2);
    expect(t.querySelector('label[for="t-1"]')).toBeTruthy();
    expect(parse(C.accordion([{ title: 'Q', body: 'A' }], true, 'acc').html).querySelector('details[name=acc] > summary')).toBeTruthy();
    const m = parse(C.modal({ button: 'Open', title: 'T', body: '<p>x</p>' }, 'm').html);
    expect(m.querySelector('button[data-ql-dialog=m]')).toBeTruthy();
    expect(m.querySelector('dialog#m[aria-labelledby=m-title]')).toBeTruthy();
    const n = parse(C.navbar({ brand: 'S', brandHref: 'index.html', items: [{ href: 'a.html', label: 'A' }] }, 'n').html);
    expect(n.querySelector('input#n + label[for=n]')).toBeTruthy();
  });
  it('share links contain no third-party scripts', () => {
    const s = C.shareButtons({ url: 'https://example.com/a', title: 'A & B', networks: ['Email', 'X'] });
    expect(s.html).toContain('mailto:?subject=A%20%26%20B&amp;body=https%3A%2F%2Fexample.com%2Fa');
    expect(s.html).not.toContain('<script');
    expect(C.shareButtons({}).html).toContain('<script>');
  });
  it('substitutions refresh from site variables', () => {
    const s = C.substitution('company', 'Old & Co');
    expect(s).toBe('<span data-ql-var="company">Old &amp; Co</span>');
    expect(C.refreshSubstitutions(`<p>${s}</p>`, { company: 'New' })).toBe('<p><span data-ql-var="company">New</span></p>');
  });
  it('marquee respects reduced motion; legacy option', () => {
    expect(C.marquee({ text: 'Hi' }).css).toContain('prefers-reduced-motion');
    expect(C.marquee({ text: 'Hi', legacy: true }).html).toMatch(/^<marquee/);
  });
  it('include markers can be expanded later', () => {
    expect(C.includeWebbot('footer.html', 'x')).toMatch(/^<!--webbot bot="Include" U-Include="footer.html" TAG="BODY" startspan -->x<!--webbot bot="Include" endspan -->$/);
  });
  it('layout helpers', () => {
    expect(C.gridLayout({ columns: 3, rows: 2 })).toContain('grid-template-columns:repeat(3,1fr)');
    expect(parse(C.gridLayout({ columns: 3, rows: 2 })).querySelectorAll('div > div').length).toBe(6);
    const f = C.fluidGrid({ mobile: 1, tablet: 2, desktop: 4 });
    expect(f.css).toContain('@media (min-width:64em)');
    expect(C.layerMarkup({ id: 'l', left: 1, top: 2, width: 3, height: 4 })).toContain('position:absolute;left:1px;top:2px');
  });
  it('ids and slugs', () => {
    expect(C.idsIn('<body><a id="x"></a><a name="y"></a><p id="ql-insert-1"></p></body>')).toEqual(['x', 'y']);
    expect(C.slugId('Hello, World!', new Set(['hello-world']))).toBe('hello-world-2');
    expect(C.slugId('2024 plans')).toBe('s-2024-plans');
  });
  it('built-in snippets have unique ids', () => {
    const ids = C.BUILTIN_SNIPPETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
