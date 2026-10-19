/**
 * Helpers shared by the importers and exporters for other systems: text decoding, finding a page's main
 * content, a neutral starter style sheet, and the assembler that turns a rendered theme (WordPress, Joomla,
 * Drupal…) into a static site with a page template and sample pages.
 */
import JSZip from 'jszip';
import { Site, decodeText } from '../model/site';
import { esc, escAttr, regions, headInsert } from '../model/html';
import { relativeRef, dirOf, joinPath } from '../model/paths';
import { applyTemplate, makeRegionMarkup, pageRegions, templateRegions } from '../site/templates';

export const textOf = (u8: Uint8Array | undefined): string => (u8 ? decodeText(u8) : '');
export const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Files under `prefix` with the prefix removed. */
export function subtree(files: Map<string, Uint8Array>, prefix: string): Map<string, Uint8Array> {
  if (!prefix) return new Map(files);
  const p = prefix.endsWith('/') ? prefix : prefix + '/';
  const out = new Map<string, Uint8Array>();
  for (const [k, v] of files) if (k.startsWith(p)) out.set(k.slice(p.length), v);
  return out;
}

/** Index of the end tag that closes the element whose start tag ends at `from`, or -1. */
export function matchClose(src: string, from: number, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) { if (--depth === 0) return m.index; } else if (!/\/>$/.test(m[0])) depth++;
  }
  return -1;
}

export interface MainSplit {
  head: string;
  bodyTag: string;
  /** Body markup before the main content (header, navigation). */
  before: string;
  content: string;
  /** Body markup after the main content (sidebar, footer). */
  after: string;
  how: 'region' | 'main' | 'id' | 'body';
}

const MAIN_REGION = /^(content|body|main|maincontent|main ?content|page ?content|pagecontent)$/i;

/**
 * Splits a page into what comes before its main content, the content itself and what follows: the editable
 * region named content/body/main, else the <main> element, else an element with id/role "content"/"main",
 * else the whole body.
 */
export function splitMain(src: string): MainSplit {
  const r = regions(src);
  const bs = r.bodyOpen ? r.bodyOpen[1] : 0;
  const be = r.bodyClose >= 0 ? r.bodyClose : src.length;
  const head = r.headOpen && r.headClose >= 0 ? src.slice(r.headOpen[1], r.headClose) : '';
  const bodyTag = r.bodyOpen ? src.slice(r.bodyOpen[0], r.bodyOpen[1]) : '<body>';
  const regs = [...pageRegions(src), ...templateRegions(src)].filter((x) => x.innerStart >= bs && x.innerEnd <= be);
  const reg = regs.find((x) => MAIN_REGION.test(x.name));
  if (reg) return { head, bodyTag, before: src.slice(bs, reg.innerStart), content: reg.content, after: src.slice(reg.innerEnd, be), how: 'region' };
  const body = src.slice(bs, be);
  const main = /<main\b[^>]*>/i.exec(body);
  if (main) {
    const end = matchClose(body, main.index + main[0].length, 'main');
    if (end > 0) return { head, bodyTag, before: body.slice(0, main.index + main[0].length), content: body.slice(main.index + main[0].length, end), after: body.slice(end), how: 'main' };
  }
  const byId = /<(div|section|article)\b[^>]*\b(?:id\s*=\s*["'](?:content|main|main-content|maincontent|primary)["']|role\s*=\s*["']main["'])[^>]*>/i.exec(body);
  if (byId) {
    const end = matchClose(body, byId.index + byId[0].length, byId[1]);
    if (end > 0) return { head, bodyTag, before: body.slice(0, byId.index + byId[0].length), content: body.slice(byId.index + byId[0].length, end), after: body.slice(end), how: 'id' };
  }
  return { head, bodyTag, before: '', content: body, after: '', how: 'body' };
}

/** A small, neutral original style sheet for generated sites. */
export const STARTER_CSS = `/* Site styles */
:root { --ql-text: #1f2328; --ql-muted: #59636e; --ql-accent: #1a5fb4; --ql-line: #d0d7de; --ql-bg: #ffffff; --ql-soft: #f6f8fa; }
* { box-sizing: border-box; }
body { margin: 0; font: 17px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ql-text); background: var(--ql-bg); }
a { color: var(--ql-accent); }
img { max-width: 100%; height: auto; }
.site-header, .site-footer, .site-main { max-width: 960px; margin: 0 auto; padding: 1rem 1.25rem; }
.site-header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .5rem 2rem; border-bottom: 1px solid var(--ql-line); }
.site-title { margin: 0; font-size: 1.5rem; font-weight: 700; }
.site-title a { color: inherit; text-decoration: none; }
.site-tagline { margin: 0; color: var(--ql-muted); flex-basis: 100%; }
.site-nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.25rem; }
.site-nav ul ul { display: none; }
.site-footer { border-top: 1px solid var(--ql-line); color: var(--ql-muted); font-size: .9rem; }
.post-list { list-style: none; padding: 0; }
.post-list li { margin: 0 0 1.5rem; }
.post-meta { color: var(--ql-muted); font-size: .9rem; }
figure { margin: 1.5rem 0; }
figcaption { color: var(--ql-muted); font-size: .9rem; }
blockquote { margin: 1.5rem 0; padding: .25rem 1.25rem; border-left: 4px solid var(--ql-line); color: var(--ql-muted); }
pre { background: var(--ql-soft); padding: 1rem; overflow: auto; }
table { border-collapse: collapse; }
td, th { border: 1px solid var(--ql-line); padding: .4rem .6rem; }
.alignleft { float: left; margin: 0 1.5rem 1rem 0; }
.alignright { float: right; margin: 0 0 1rem 1.5rem; }
.aligncenter { display: block; margin-left: auto; margin-right: auto; }
`;

export interface MenuItem { label: string; path?: string; url?: string; children?: MenuItem[] }

/** A menu as nested lists; `from` is the file the links are written in. */
export function menuHtml(items: MenuItem[], from: string, opts: { cls?: string; id?: string; current?: string } = {}): string {
  const li = (it: MenuItem): string => {
    const href = it.path ? relativeRef(from, it.path) : it.url || '#';
    const cur = it.path && it.path === opts.current ? ' class="current-menu-item" aria-current="page"' : '';
    const kids = it.children?.length ? `<ul class="sub-menu">${it.children.map(li).join('')}</ul>` : '';
    return `<li${cur}><a href="${escAttr(href)}">${esc(it.label)}</a>${kids}</li>`;
  };
  return `<ul${opts.id ? ` id="${escAttr(opts.id)}"` : ''}${opts.cls ? ` class="${escAttr(opts.cls)}"` : ''}>${items.map(li).join('')}</ul>`;
}

export async function zipFiles(files: Map<string, string | Uint8Array>): Promise<Blob> {
  const zip = new JSZip();
  for (const [p, v] of files) zip.file(p, v);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' });
}

export function markNoPublish(site: Site, prefix: string): void {
  for (const f of site.files.values()) if (f.path.startsWith(prefix)) f.noPublish = true;
}

/** Keeps the original files of an imported theme in `_theme-source/`, excluded from publishing. */
export function keepSource(site: Site, files: Map<string, Uint8Array>, folder = '_theme-source'): void {
  for (const [p, v] of files) site.write(joinPath(folder, p), v, { silent: true });
  markNoPublish(site, folder + '/');
}

/** Short, de-duplicated list for reports. */
export function summarize(items: Iterable<string>, max = 25): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) || 0) + 1);
  const list = [...counts].map(([k, n]) => (n > 1 ? `${k} (×${n})` : k));
  return list.slice(0, max).join(', ') + (list.length > max ? `, and ${list.length - max} more` : '');
}

// ------------------------------------------------------------------------------------------
// Rendered themes → static site with a page template

export const MARK_TITLE = '\u0001QL:title\u0001';
export const MARK_CONTENT = '\u0001QL:content\u0001';

export interface SampleItem { id: number; title: string; content: string; excerpt: string; path: string; date: string; author: string; kind: 'page' | 'post' }

export type ThemeView = 'page' | 'front' | 'list' | 'single' | '404';

export interface ThemeCtx {
  view: ThemeView;
  /** Site path of the file being written (links are made relative to it). */
  file: string;
  /** Relative path from the file to the site root ("." or ".."). */
  root: string;
  /** Title and content are written as markers that become editable regions. */
  markers: boolean;
  item: SampleItem;
  items: SampleItem[];
  menu: MenuItem[];
  siteName: string;
  tagline: string;
}

export function rootRelFor(file: string): string {
  const depth = dirOf(file).split('/').filter(Boolean).length;
  return depth ? Array(depth).fill('..').join('/') : '.';
}

const today = () => new Date().toISOString().slice(0, 10);

export function sampleContent(siteName: string): { pages: SampleItem[]; posts: SampleItem[] } {
  const d = today();
  const pages: SampleItem[] = [
    { id: 2, kind: 'page', title: 'Home', path: 'index.html', date: d, author: 'Editor', excerpt: `Welcome to ${siteName}.`, content: `<p>Welcome to ${esc(siteName)}. Replace this text with your own.</p>\n<p>Everything inside this area is editable; the header, menu and footer come from the page template.</p>` },
    { id: 3, kind: 'page', title: 'About', path: 'about.html', date: d, author: 'Editor', excerpt: 'About this site.', content: '<p>Tell visitors who you are and what this site is about.</p>' },
  ];
  const posts: SampleItem[] = [
    { id: 10, kind: 'post', title: 'Hello world', path: 'blog/hello-world.html', date: d, author: 'Editor', excerpt: 'The first post of this blog.', content: '<p>This is the first post. Edit it or delete it, then start writing.</p>' },
    { id: 11, kind: 'post', title: 'A second post', path: 'blog/a-second-post.html', date: d, author: 'Editor', excerpt: 'Another sample post.', content: '<p>Posts are listed on the blog page, newest first.</p>' },
  ];
  return { pages, posts };
}

/**
 * Turns rendered markup that holds MARK_TITLE / MARK_CONTENT into a .dwt page template with
 * "doctitle", "pagetitle" and "content" editable regions.
 */
export function markersToTemplate(html: string, siteName: string): string {
  let s = html;
  const titleRe = /<title[^>]*>([\s\S]*?)<\/title>/i;
  if (titleRe.test(s)) s = s.replace(titleRe, (m, t: string) => makeRegionMarkup('doctitle', `<title>${t.split(MARK_TITLE).join('Page Title')}</title>`));
  else s = headInsert(s, makeRegionMarkup('doctitle', `<title>Page Title – ${esc(siteName)}</title>`));
  let n = 0;
  s = s.split(MARK_TITLE).reduce((acc, part, i) => (i === 0 ? part : acc + (n++ === 0 ? makeRegionMarkup('pagetitle', 'Page Title') : 'Page Title') + part), '');
  if (s.includes(MARK_CONTENT)) {
    let c = 0;
    s = s.split(MARK_CONTENT).reduce((acc, part, i) => (i === 0 ? part : acc + (c++ === 0 ? makeRegionMarkup('content', '\n<p>Page content goes here.</p>\n') : '') + part), '');
  } else {
    const r = regions(s);
    const at = r.bodyClose >= 0 ? r.bodyClose : s.length;
    s = s.slice(0, at) + makeRegionMarkup('content', '\n<p>Page content goes here.</p>\n') + s.slice(at);
  }
  return s;
}

/** A page attached to a template, with its own region content. */
export function attachPage(site: Site, tpl: string, path: string, item: { title: string; content: string }, siteName: string): void {
  const src = `<html>${makeRegionMarkup('doctitle', `<title>${esc(item.title)} – ${esc(siteName)}</title>`)}${makeRegionMarkup('pagetitle', esc(item.title))}${makeRegionMarkup('content', '\n' + item.content + '\n')}</html>`;
  const out = applyTemplate(site, tpl, src, path).split(MARK_TITLE).join(esc(item.title)).split(MARK_CONTENT).join('');
  site.write(path, out, { silent: true });
  site.data.templates[path] = tpl;
}

export interface ThemeRenderer {
  has(key: string): boolean;
  render(key: string, ctx: ThemeCtx): string;
}

/**
 * Builds the sample site from a theme renderer: Templates/page.dwt (and front-page/post templates when
 * the theme has them), Home and About pages attached to it, a blog index and two posts.
 */
export function assembleThemeSite(site: Site, r: ThemeRenderer, opts: { siteName: string; tagline: string; report: string[]; blog?: boolean }): string[] {
  const { pages, posts } = sampleContent(opts.siteName);
  const blog = opts.blog !== false && (r.has('home') || r.has('index') || r.has('single'));
  const menu: MenuItem[] = [...pages.map((p) => ({ label: p.title, path: p.path })), ...(blog ? [{ label: 'Blog', path: 'blog/index.html' }] : [])];
  const made: string[] = [];
  const ctxFor = (view: ThemeView, file: string, item: SampleItem, items: SampleItem[], markers: boolean): ThemeCtx => ({ view, file, root: rootRelFor(file), markers, item, items, menu, siteName: opts.siteName, tagline: opts.tagline });
  const marked: SampleItem = { ...pages[0], title: MARK_TITLE, content: MARK_CONTENT, excerpt: '' };
  const first = (...keys: string[]) => keys.find((k) => r.has(k));

  const makeTemplate = (key: string, view: ThemeView, tplPath: string): string => {
    const html = r.render(key, ctxFor(view, tplPath, { ...marked, kind: view === 'single' ? 'post' : 'page' }, [marked], true));
    site.write(tplPath, markersToTemplate(html, opts.siteName), { silent: true });
    made.push(tplPath);
    return tplPath;
  };

  const pageKey = first('page', 'singular', 'index');
  if (!pageKey) { opts.report.push('The theme has no page layout (page, singular or index) to build pages from.'); return made; }
  const pageTpl = makeTemplate(pageKey, 'page', 'Templates/page.dwt');
  const frontKey = first('front-page');
  const frontTpl = frontKey ? makeTemplate(frontKey, 'front', 'Templates/front-page.dwt') : pageTpl;
  attachPage(site, frontTpl, pages[0].path, pages[0], opts.siteName);
  attachPage(site, pageTpl, pages[1].path, pages[1], opts.siteName);
  made.push(pages[0].path, pages[1].path);
  if (blog) {
    const listKey = first('home', 'index', 'archive')!;
    if (listKey) {
      site.write('blog/index.html', r.render(listKey, ctxFor('list', 'blog/index.html', posts[0], posts, false)), { silent: true });
      made.push('blog/index.html');
    }
    const singleKey = first('single', 'singular', 'index');
    if (singleKey) {
      const postTpl = makeTemplate(singleKey, 'single', 'Templates/post.dwt');
      for (const p of posts) { attachPage(site, postTpl, p.path, p, opts.siteName); made.push(p.path); }
    }
  }
  if (r.has('404')) {
    site.write('404.html', r.render('404', ctxFor('404', '404.html', { ...pages[1], title: 'Page not found', content: '' }, [], false)), { silent: true });
    made.push('404.html');
  }
  site.data.nav = { path: 'index.html', children: menu.slice(1).filter((m) => m.path).map((m) => ({ path: m.path!, label: m.label, children: [] })) };
  return made;
}

/** A standalone generated page (used by importers that build their own pages). */
export function simplePage(opts: { title: string; siteName: string; tagline?: string; file: string; css: string[]; menu: MenuItem[]; content: string; lang?: string }): string {
  const rel = (p: string) => relativeRef(opts.file, p);
  return `<!DOCTYPE html>
<html lang="${escAttr(opts.lang || 'en')}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)}${opts.title === opts.siteName ? '' : ' – ' + esc(opts.siteName)}</title>
${opts.css.map((c) => `  <link rel="stylesheet" href="${escAttr(rel(c))}">`).join('\n')}
</head>
<body>
<header class="site-header">
  <p class="site-title"><a href="${escAttr(rel('index.html'))}">${esc(opts.siteName)}</a></p>
  <nav class="site-nav" aria-label="Main">${menuHtml(opts.menu, opts.file, { current: opts.file })}</nav>
  ${opts.tagline ? `<p class="site-tagline">${esc(opts.tagline)}</p>` : ''}
</header>
<main class="site-main">
${opts.content}
</main>
<footer class="site-footer">
  <p>© ${new Date().getFullYear()} ${esc(opts.siteName)}</p>
</footer>
</body>
</html>
`;
}

/** Shared CSS-framework and builder detection for HTML templates and fetched pages. */
export function detectFrameworks(paths: string[], texts: string[]): string[] {
  const all = paths.join('\n').toLowerCase();
  const sample = texts.join('\n').slice(0, 400000);
  const found: string[] = [];
  const t = (name: string, ok: boolean) => { if (ok && !found.includes(name)) found.push(name); };
  t('Bootstrap', /bootstrap(\.min)?\.(css|js)|bootstrap@|\/bootstrap\//.test(all) || /bootstrap(\.min)?\.css|class="[^"]*\b(container|row) [^"]*col-(sm|md|lg)-/.test(sample));
  t('Tailwind CSS', /tailwind/.test(all) || /cdn\.tailwindcss\.com|class="[^"]*\b(flex|grid) [^"]*\b(px|py|mt|mb)-\d/.test(sample));
  t('Foundation', /foundation(\.min)?\.css/.test(all + sample));
  t('Bulma', /bulma(\.min)?\.css/.test(all + sample));
  t('W3.CSS', /w3\.css/.test(all + sample));
  t('UIkit', /uikit(\.min)?\.(css|js)/.test(all + sample));
  t('Materialize', /materialize(\.min)?\.css/.test(all + sample));
  t('jQuery', /jquery[.-]?[\d.]*(\.min)?\.js/.test(all + sample));
  t('Font Awesome', /font-?awesome|fontawesome/.test(all + sample));
  t('AOS (animate on scroll)', /aos(\.min)?\.(css|js)/.test(all + sample));
  t('Swiper', /swiper(-bundle)?(\.min)?\.(css|js)/.test(all + sample));
  t('Sass sources (.scss) — the compiled .css is what pages use', /\.scss(\n|$)/.test(all));
  return found;
}

export function detectBuilder(paths: string[], texts: string[]): string | null {
  const all = paths.join('\n').toLowerCase();
  const sample = texts.join('\n').slice(0, 400000);
  if (/mobirise/i.test(all) || /mobirise/i.test(sample)) return 'Mobirise export';
  if (/nicepage\.css/i.test(all + sample)) return 'Nicepage export';
  if (/<meta[^>]+generator[^>]+Bootstrap Studio/i.test(sample) || /bss-|\.bss/i.test(all)) return 'Bootstrap Studio export';
  if (/data-pg-|pinegrow/i.test(sample)) return 'Pinegrow project';
  if (/html5up|html5 up/i.test(sample)) return 'HTML5 UP template';
  if (/start ?bootstrap/i.test(sample)) return 'Start Bootstrap template';
  if (/bootstrapmade/i.test(sample)) return 'BootstrapMade template';
  if (/colorlib/i.test(sample)) return 'Colorlib template';
  if (/templatemo/i.test(sample)) return 'Templatemo template';
  if (/themewagon/i.test(sample)) return 'ThemeWagon template';
  if (/w3layouts/i.test(sample)) return 'W3layouts template';
  return null;
}
