import { describe, it, expect } from 'vitest';
import { Site, type PublishProfile } from '../../src/model/site';
import {
  linkIndex, unlinkedFiles, reportSummary, reportBrokenLinks, reportSlowPages, reportComponentErrors, reportMissingAlt, reportMissingTitles,
  reportDuplicateTitles, reportUnusedStyles, reportStyleLinks, reportTemplates, reportRecentlyChanged, reportOlderFiles, reportPublishStatus,
  reportSeo, reportAccessibility, reportCompatibility, reportCss, reportCategories, cssProblems, cssClasses, REPORTS, runReport, reportCsv,
  regenerateLinkBars, linkBarItems, navAdd, navRemove, navMove, navIndent, navOutdent, navReparent, ensureNav, sitemapXml, robotsTxt, rssFeed, searchIndex, lineAt,
} from '../../src/site/reports';
import { selectFiles, publishStatus, orphans, globToRegExp, runPublish, compareWithRemote, appendPublishLog, readPublishLog, parseGitHubRepo, parseFtpUrl, githubDestination, webdavDestination, gitBlobSha, type Destination } from '../../src/site/publish';
import { WebDavClient, parseMultistatus, basicAuth, type FetchLike } from '../../src/site/webdav';

const page = (title: string, body: string, head = '') => `<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>${title}</title>${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

function sample(): Site {
  const s = new Site('Test');
  s.write('index.html', page('Home', '<nav data-ql-linkbar="top"><ul><li>old</li></ul></nav>\n<a href="about.html">About</a>\n<a href="blog/index.html">Blog</a>\n<img src="img/logo.png" alt="Logo">\n<a href="missing.html">Gone</a>\n<a href="https://example.com/x">Ext</a>', '\n<link rel="stylesheet" href="css/site.css">'));
  s.write('about.html', page('About', '<img src="img/big.jpg">\n<p class="lead">Hi</p>'));
  s.write('blog/index.html', page('Blog', '<a href="post1.html">Post</a>'));
  s.write('blog/post1.html', page('Post', '<p>First</p>'));
  s.write('orphan.html', page('Home', '<p>nobody links here</p>'));
  s.write('css/site.css', '.lead { color: red }\n.unused { color: blue }\nbody { background: url(../img/bg.png) }\n');
  s.write('img/logo.png', new Uint8Array(1000));
  s.write('img/big.jpg', new Uint8Array(600 * 1024));
  s.write('img/bg.png', new Uint8Array(10));
  s.write('img/stray.gif', new Uint8Array(5));
  s.write('robots.txt', 'User-agent: *\n');
  return s;
}

describe('link index and unlinked files', () => {
  it('indexes links in and out with lines', () => {
    const s = sample();
    const idx = linkIndex(s);
    const out = idx.out.get('index.html')!;
    expect(out.find((l) => l.target === 'about.html')?.exists).toBe(true);
    const broken = out.find((l) => l.target === 'missing.html')!;
    expect(broken.exists).toBe(false);
    expect(broken.line).toBe(lineAt(s.read('index.html')!, s.read('index.html')!.indexOf('missing.html')));
    expect(idx.in.get('img/bg.png')?.[0].from).toBe('css/site.css');
    expect(idx.external.get('index.html')?.[0].url).toBe('https://example.com/x');
  });
  it('finds files not reachable from the home page, ignoring well-known root files', () => {
    const u = unlinkedFiles(sample());
    expect(u).toContain('orphan.html');
    expect(u).toContain('img/stray.gif');
    expect(u).not.toContain('img/bg.png'); // reached through the style sheet
    expect(u).not.toContain('blog/post1.html');
    expect(u).not.toContain('robots.txt');
  });
});

describe('reports', () => {
  it('summary counts', () => {
    const r = reportSummary(sample());
    const get = (n: string) => r.rows.find((x) => x.item === n)!.count;
    expect(get('All files')).toBe(11);
    expect(get('Pages')).toBe(5);
    expect(get('Pictures')).toBe(4);
    expect(get('Broken internal links')).toBe(1);
    expect(get('Unlinked files')).toBe(2);
    expect(get('Slow pages')).toBe(1);
  });
  it('broken links: internal and unchecked external, checked external results', () => {
    const s = sample();
    const r = reportBrokenLinks(s);
    expect(r.rows.filter((x) => x.kind === 'Internal').map((x) => x.link)).toEqual(['missing.html']);
    expect(r.rows.find((x) => x.kind === 'External')?.status).toBe('Not checked');
    const ok = reportBrokenLinks(s, { externalStatus: new Map([['https://example.com/x', 'OK (200)']]) });
    expect(ok.rows.some((x) => x.kind === 'External')).toBe(false);
    const bad = reportBrokenLinks(s, { externalStatus: new Map([['https://example.com/x', '404']]) });
    expect(bad.rows.find((x) => x.kind === 'External')?.status).toBe('404');
  });
  it('slow pages count page resources through style sheets', () => {
    const r = reportSlowPages(sample(), { kb: 500, speedKbps: 1000 });
    expect(r.rows.map((x) => x.path)).toEqual(['about.html']);
    expect(r.rows[0].seconds).toBeGreaterThan(4);
    expect(reportSlowPages(sample(), { kb: 10000 }).rows).toEqual([]);
  });
  it('missing alt, titles, duplicate titles', () => {
    const s = sample();
    expect(reportMissingAlt(s).rows.map((x) => x.path)).toEqual(['about.html']);
    s.write('notitle.html', '<html><head></head><body></body></html>');
    expect(reportMissingTitles(s).rows.map((x) => x.path)).toEqual(['notitle.html']);
    expect(reportDuplicateTitles(s).rows.map((x) => x.path).sort()).toEqual(['index.html', 'orphan.html']);
  });
  it('unused styles and style links', () => {
    const s = sample();
    expect(cssClasses('a.b, .c:hover { x: url(a.png) } @media (x) { .d {} }').map((c) => c.name)).toEqual(['b', 'c', 'd']);
    const u = reportUnusedStyles(s).rows.map((x) => x.style);
    expect(u).toEqual(['.unused']);
    s.write('app.js', "el.classList.add('unused')");
    expect(reportUnusedStyles(s).rows).toEqual([]);
    expect(reportStyleLinks(s).rows[0]).toMatchObject({ path: 'index.html', sheet: 'css/site.css', status: 'OK' });
  });
  it('component errors: includes, templates, regions, library items, link bars', () => {
    const s = new Site();
    s.write('a.html', '<html><!-- #BeginTemplate "/Templates/gone.dwt" --><body><!--#include virtual="/inc/nav.html" --><!-- #BeginEditable "body" -->x<!-- #BeginLibraryItem "/Library/x.lbi" -->y<!-- #EndLibraryItem --><nav data-ql-linkbar="weird"></nav></body></html>');
    const probs = reportComponentErrors(s).rows.map((r) => r.component);
    expect(probs).toEqual(expect.arrayContaining(['Include', 'Page template', 'Editable region', 'Library item', 'Link bar']));
    s.write('inc/nav.html', 'nav');
    expect(reportComponentErrors(s).rows.map((r) => r.component)).not.toContain('Include');
  });
  it('templates, recency, publish status, categories', () => {
    const s = new Site();
    s.write('Templates/main.dwt', '<html><body><!-- #BeginEditable "body" --><!-- #EndEditable --></body></html>');
    s.write('p.html', '<html><!-- #BeginTemplate "/Templates/main.dwt" --><body></body><!-- #EndTemplate --></html>');
    expect(reportTemplates(s).rows[0]).toMatchObject({ template: 'Templates/main.dwt', pages: 1 });
    const now = Date.now();
    s.get('p.html')!.modified = now - 100 * 86400000;
    expect(reportRecentlyChanged(s, { days: 30, now }).rows.map((r) => r.path)).toEqual(['Templates/main.dwt']);
    expect(reportOlderFiles(s, { days: 72, now }).rows.map((r) => r.path)).toEqual(['p.html']);
    s.data.publish.push({ id: 'a', name: 'Host', kind: 'zip', url: '', published: { 'p.html': now } });
    const ps = reportPublishStatus(s).rows;
    expect(ps.find((r) => r.path === 'p.html')!.p_a).toBe('Published');
    expect(ps.find((r) => r.path === 'Templates/main.dwt')!.p_a).toBe('Not published');
    s.get('p.html')!.props = { category: 'News, Travel' };
    expect(reportCategories(s).rows.filter((r) => r.path === 'p.html').map((r) => r.value)).toEqual(['News', 'Travel']);
  });
  it('SEO, accessibility, compatibility and CSS checks', () => {
    const s = new Site();
    s.write('a.html', '<html><head><title>Hi</title></head><body><h1>A</h1><h3>B</h3><a href="x.html"></a><input type="text" id="q"><label>Name <input type="text"></label><center>x</center><table bgcolor="red"><tr><td>1</td></tr></table><img src="a.png"></body></html>');
    const seo = reportSeo(s).rows[0];
    expect(seo.issues).toMatch(/title too short/);
    expect(seo.issues).toMatch(/no description/);
    expect(seo.issues).toMatch(/no lang/);
    const acc = reportAccessibility(s).rows.map((r) => r.check);
    expect(acc).toEqual(expect.arrayContaining(['Language', 'Alternate text', 'Link text', 'Form labels', 'Headings', 'Table headers']));
    expect(reportAccessibility(s).rows.filter((r) => r.check === 'Form labels')).toHaveLength(1);
    const comp = reportCompatibility(s).rows.map((r) => r.item);
    expect(comp).toEqual(expect.arrayContaining(['No DOCTYPE', '<center>', 'bgcolor']));
    expect(cssProblems('a { color red; } b {} c { x: 1 ').map((p) => p.problem)).toEqual([expect.stringMatching(/without a colon/), 'Empty rule', expect.stringMatching(/not closed/)]);
    expect(cssProblems('/* open')[0].problem).toMatch(/Comment/);
    s.write('s.css', 'a { color: red; }');
    expect(reportCss(s).rows).toEqual([]);
  });
  it('every report runs and exports CSV', () => {
    const s = sample();
    for (const r of REPORTS) {
      const rep = runReport(s, r.id);
      expect(rep.columns.length, r.id).toBeGreaterThan(0);
      expect(typeof reportCsv(rep)).toBe('string');
    }
  });
});

describe('navigation and link bars', () => {
  it('edits the tree', () => {
    const s = sample();
    const nav = ensureNav(s);
    expect(nav.path).toBe('index.html');
    expect(navRemove(nav, 'orphan.html')).toBe(true);
    expect(navAdd(nav, 'orphan.html')).toBe(true);
    expect(navAdd(nav, 'orphan.html')).toBe(false);
    const order = () => nav.children.map((c) => c.path);
    const before = order();
    expect(navMove(nav, 'orphan.html', -1)).toBe(true);
    expect(order().indexOf('orphan.html')).toBe(before.length - 2);
    expect(navIndent(nav, 'orphan.html')).toBe(true);
    const parent = nav.children.find((c) => c.children.some((x) => x.path === 'orphan.html'))!;
    expect(parent).toBeTruthy();
    expect(navOutdent(nav, 'orphan.html')).toBe(true);
    expect(order()).toContain('orphan.html');
    expect(navReparent(nav, 'about.html', 'orphan.html')).toBe(true);
    expect(navReparent(nav, 'orphan.html', 'about.html')).toBe(false); // into its own subtree
    expect(navRemove(nav, 'orphan.html')).toBe(true);
    expect(order()).toContain('about.html'); // children move up
    expect(navRemove(nav, 'index.html')).toBe(false);
  });
  it('link bar items per mode', () => {
    const nav = { path: 'index.html', children: [{ path: 'a.html', children: [{ path: 'a1.html', children: [] }, { path: 'a2.html', children: [] }] }, { path: 'b.html', children: [] }] };
    const paths = (x: { path: string }[]) => x.map((n) => n.path);
    expect(paths(linkBarItems(nav, 'a.html', 'children'))).toEqual(['a1.html', 'a2.html']);
    expect(paths(linkBarItems(nav, 'a1.html', 'siblings'))).toEqual(['a1.html', 'a2.html']);
    expect(paths(linkBarItems(nav, 'a1.html', 'top'))).toEqual(['index.html', 'a.html', 'b.html']);
    expect(paths(linkBarItems(nav, 'a1.html', 'top', { home: false }))).toEqual(['a.html', 'b.html']);
    expect(paths(linkBarItems(nav, 'a2.html', 'breadcrumbs'))).toEqual(['index.html', 'a.html', 'a2.html']);
    expect(paths(linkBarItems(nav, 'zzz.html', 'children'))).toEqual([]);
  });
  it('regenerates link bars from the structure with relative links', () => {
    const s = new Site();
    s.write('index.html', page('Home', '<nav class="main" data-ql-linkbar="top">\n  <ul class="menu"><li>stale</li></ul>\n</nav>'));
    s.write('docs/guide.html', page('Guide', '<nav data-ql-linkbar="breadcrumbs"></nav><nav data-ql-linkbar="siblings"><ul></ul></nav>'));
    s.write('docs/faq.html', page('FAQ', ''));
    s.data.nav = { path: 'index.html', children: [{ path: 'docs/guide.html', label: 'User Guide', children: [] }, { path: 'docs/faq.html', children: [] }] };
    const changed = regenerateLinkBars(s);
    expect(changed.sort()).toEqual(['docs/guide.html', 'index.html']);
    const home = s.read('index.html')!;
    expect(home).toContain('<ul class="menu"><li class="ql-current"><a href="index.html" aria-current="page">Home</a></li><li><a href="docs/guide.html">User Guide</a></li><li><a href="docs/faq.html">FAQ</a></li></ul>');
    expect(home).toContain('<nav class="main" data-ql-linkbar="top">\n  <ul');
    const guide = s.read('docs/guide.html')!;
    expect(guide).toContain('<ol><li><a href="../index.html">Home</a></li><li class="ql-current"><a href="guide.html" aria-current="page">User Guide</a></li></ol>');
    expect(guide).toContain('<li><a href="faq.html">FAQ</a></li>');
    expect(regenerateLinkBars(s)).toEqual([]); // stable
  });
});

describe('generated files', () => {
  it('sitemap, robots, feed, search index', () => {
    const s = sample();
    s.write('blog/post1.html', page('Post', '<p>First post text.</p>', '\n<meta name="description" content="About the first post"><meta name="date" content="2024-05-01">'));
    const sm = sitemapXml(s, 'https://example.com/');
    expect(sm).toContain('<loc>https://example.com/</loc>');
    expect(sm).toContain('<loc>https://example.com/blog/post1.html</loc>');
    expect(robotsTxt(s, 'https://example.com')).toContain('Sitemap: https://example.com/sitemap.xml');
    const feed = rssFeed(s, { baseUrl: 'https://example.com', folder: 'blog', title: 'Blog' });
    expect(feed).toContain('<title>Post</title>');
    expect(feed).toContain('<description>About the first post</description>');
    expect(feed).toContain(new Date(Date.parse('2024-05-01')).toUTCString());
    expect(feed).not.toContain('blog/index.html');
    const idx = searchIndex(s);
    expect(idx.find((e) => e.url === 'blog/post1.html')!.text).toContain('First post text.');
  });
});

describe('publishing', () => {
  const prof = (published: Record<string, number> = {}): PublishProfile => ({ id: 'p', name: 'Host', kind: 'webdav', url: 'https://dav.example.com/site', published });

  it('globs', () => {
    expect(globToRegExp('*.psd').test('art/x.psd')).toBe(true);
    expect(globToRegExp('Templates/').test('Templates/a.dwt')).toBe(true);
    expect(globToRegExp('drafts/**').test('drafts/a/b.html')).toBe(true);
    expect(globToRegExp('drafts/*.html').test('drafts/a/b.html')).toBe(false);
  });
  it('selects changed files only, honoring Don\'t Publish and exclude patterns', () => {
    const s = sample();
    const all = selectFiles(s, prof());
    expect(all).toHaveLength(11);
    const t = Date.now() + 1000;
    const stamps = Object.fromEntries(s.list().map((f) => [f.path, t]));
    const p = prof(stamps);
    expect(selectFiles(s, p, { changedOnly: true })).toEqual([]);
    s.write('about.html', page('About us', 'changed'));
    s.get('about.html')!.modified = t + 5;
    s.write('new.html', page('New', ''));
    s.get('orphan.html')!.noPublish = true;
    s.data.meta.publishExclude = 'img/*.gif';
    expect(selectFiles(s, p, { changedOnly: true }).sort()).toEqual(['about.html', 'new.html']);
    const st = publishStatus(s, p);
    expect(st.find((i) => i.path === 'orphan.html')!.status).toBe('excluded');
    expect(st.find((i) => i.path === 'img/stray.gif')!.status).toBe('excluded');
    expect(selectFiles(s, p, {})).not.toContain('orphan.html');
    s.remove('robots.txt');
    expect(orphans(s, p)).toEqual(['robots.txt']);
  });
  it('runs a publish, records times, removes orphans and logs', async () => {
    const s = sample();
    const p = prof({ 'gone.html': 1 });
    const put: string[] = [], removed: string[] = [];
    const dest: Destination = { label: 'test', canDelete: true, put: async (path) => { if (path === 'about.html') throw new Error('disk full'); put.push(path); }, remove: async (path) => { removed.push(path); } };
    const lines: string[] = [];
    const r = await runPublish(s, p, ['index.html', 'about.html'], dest, { removeOrphans: true, log: (l) => lines.push(l) });
    expect(put).toEqual(['index.html']);
    expect(r.failed[0].path).toBe('about.html');
    expect(removed).toEqual(['gone.html']);
    expect(p.published!['index.html']).toBe(s.get('index.html')!.modified);
    expect(p.published!['about.html']).toBeUndefined();
    expect(p.published!['gone.html']).toBeUndefined();
    appendPublishLog(s, lines);
    expect(readPublishLog(s).some((l) => l.includes('disk full'))).toBe(true);
  });
  it('compares with a remote listing', () => {
    const s = new Site();
    s.write('a.html', 'a');
    s.write('b.html', 'bb');
    const t = s.get('a.html')!.modified;
    const p = prof({ 'a.html': t, 'b.html': t - 10 });
    const e = compareWithRemote(s, p, [{ path: 'a.html', size: 1, modified: t }, { path: 'b.html', size: 1, modified: t }, { path: 'c.html', size: 3, modified: t }]);
    expect(Object.fromEntries(e.map((x) => [x.path, x.state]))).toEqual({ 'a.html': 'same', 'b.html': 'localChanged', 'c.html': 'remoteOnly' });
  });
  it('parses destinations', () => {
    expect(parseGitHubRepo('https://github.com/me/site.git')).toEqual({ owner: 'me', repo: 'site' });
    expect(parseFtpUrl('ftps://ftp.example.com:2121/x')).toEqual({ host: 'ftp.example.com', port: 2121, secure: true });
  });
});

function mockFetch(responder: (url: string, init: any) => { status: number; body?: string }) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: any }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = responder(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body || '', arrayBuffer: async () => new TextEncoder().encode(r.body || '').buffer as ArrayBuffer };
  };
  return { f, calls };
}

describe('WebDAV', () => {
  it('builds requests', () => {
    const c = new WebDavClient('https://dav.example.com/site/', 'me', 'pw');
    const put = c.putRequest('a b/c.html', 'x', 'text/html');
    expect(put).toMatchObject({ method: 'PUT', url: 'https://dav.example.com/site/a%20b/c.html', body: 'x' });
    expect(put.headers.Authorization).toBe(basicAuth('me', 'pw'));
    expect(put.headers.Authorization).toBe('Basic ' + btoa('me:pw'));
    expect(c.mkcolRequest('a b').url).toBe('https://dav.example.com/site/a%20b/');
    expect(c.propfindRequest('').headers.Depth).toBe('1');
    expect(() => new WebDavClient('ftp://x')).toThrow();
  });
  it('creates parent folders once, then uploads', async () => {
    const { f, calls } = mockFetch((u, i) => ({ status: i.method === 'MKCOL' && u.endsWith('/a/') ? 405 : 201 }));
    const c = new WebDavClient('https://dav.example.com/root', 'u', 'p', f);
    await c.put('a/b/x.html', new Uint8Array([1, 2]), 'text/html');
    await c.put('a/b/y.html', 'y');
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'MKCOL https://dav.example.com/root/a/', 'MKCOL https://dav.example.com/root/a/b/',
      'PUT https://dav.example.com/root/a/b/x.html', 'PUT https://dav.example.com/root/a/b/y.html',
    ]);
    expect(calls[2].headers['Content-Type']).toBe('text/html');
  });
  it('reports authentication failures clearly', async () => {
    const { f } = mockFetch(() => ({ status: 401 }));
    await expect(new WebDavClient('https://h/x', 'u', 'bad', f).put('a.html', 'x')).rejects.toThrow(/401.*password/);
  });
  it('parses PROPFIND and lists recursively', async () => {
    const ms = (items: string) => `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${items}</D:multistatus>`;
    const resp = (href: string, dir: boolean, size = 0) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype><D:getcontentlength>${size}</D:getcontentlength><D:getlastmodified>Wed, 01 May 2024 10:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>`;
    const { f, calls } = mockFetch((u) => ({ status: 207, body: u.endsWith('/site/') ? ms(resp('/site/', true) + resp('/site/index.html', false, 12) + resp('/site/my%20dir/', true)) : ms(resp('/site/my%20dir/', true) + resp('/site/my%20dir/a.css', false, 3)) }));
    const c = new WebDavClient('https://dav.example.com/site', '', '', f);
    const list = await c.list();
    expect(list.filter((e) => !e.isDir).map((e) => [e.path, e.size])).toEqual([['index.html', 12], ['my dir/a.css', 3]]);
    expect(calls.every((x) => x.method === 'PROPFIND')).toBe(true);
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(parseMultistatus(ms(resp('https://dav.example.com/site/x.html', false, 1)), 'https://dav.example.com/site/')[0].path).toBe('x.html');
  });
  it('webdav destination publishes into the remote folder', async () => {
    const { f, calls } = mockFetch(() => ({ status: 201 }));
    const d = webdavDestination({ id: 'w', name: 'W', kind: 'webdav', url: 'https://h.example/dav/', remoteDir: '/public_html/' }, 'pw', f);
    await d.put('index.html', new Uint8Array([60]), 'text/html');
    expect(calls.at(-1)!.url).toBe('https://h.example/dav/public_html/index.html');
  });
});

describe('GitHub Pages', () => {
  it('computes git blob hashes', async () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(await gitBlobSha(new TextEncoder().encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
  it('puts with sha lookup and skips unchanged files', async () => {
    const same = await gitBlobSha(new TextEncoder().encode('same'));
    const { f, calls } = mockFetch((u, i) => {
      if (u.includes('/git/trees/')) return { status: 200, body: JSON.stringify({ tree: [{ type: 'blob', path: 'docs/a.html', sha: 'old' }, { type: 'blob', path: 'docs/b.html', sha: same }, { type: 'blob', path: 'other.txt', sha: 'z' }] }) };
      if (i.method === 'PUT') return { status: 200, body: JSON.stringify({ content: { sha: 'new' } }) };
      return { status: 404 };
    });
    const d = githubDestination({ id: 'g', name: 'G', kind: 'github', url: 'me/site', remoteDir: 'docs', options: { branch: 'gh-pages' } }, 'tok', f);
    await d.put('a.html', new TextEncoder().encode('changed'), 'text/html');
    await d.put('b.html', new TextEncoder().encode('same'), 'text/html');
    await d.put('c.html', new TextEncoder().encode('new'), 'text/html');
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url)).toEqual(['https://api.github.com/repos/me/site/contents/docs/a.html', 'https://api.github.com/repos/me/site/contents/docs/c.html']);
    const body = JSON.parse(puts[0].body);
    expect(body).toMatchObject({ sha: 'old', branch: 'gh-pages', content: btoa('changed') });
    expect(JSON.parse(puts[1].body).sha).toBeUndefined();
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect((await d.list!()).map((x) => x.path).sort()).toEqual(['a.html', 'b.html', 'c.html']);
  });
});

describe('command ids', () => {
  it('registers every site.* id the menus, ribbon and panes use', async () => {
    await import('../../src/commands/site');
    await import('../../src/commands/reports');
    await import('../../src/commands/publish');
    const { getCommand } = await import('../../src/commands/registry');
    const { classicIds } = await import('../../src/ui/classicMenus');
    const { idsInTabs } = await import('../../src/ui/ribbonLayout');
    const fs = await import('node:fs');
    const extra = ['src/ui/panes.ts', 'src/ui/backstage.ts', 'src/ui/shell.ts', 'src/editor/workspace.ts'].flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/'(site\.[A-Za-z]+)'/g)].map((m) => m[1]));
    const want = [...new Set([...classicIds(), ...idsInTabs(), ...extra])].filter((id) => id.startsWith('site.'));
    expect(want.length).toBeGreaterThan(60);
    expect(want.filter((id) => !getCommand(id))).toEqual([]);
  });
});
