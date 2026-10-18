/**
 * WordPress eXtended RSS (WXR), the file WordPress writes under Tools ▸ Export and reads under Tools ▸ Import.
 *
 * It is RSS 2.0 with extra namespaces: wp: (export/1.0 … 1.2) for posts, pages, terms, authors and post meta,
 * content: (content:encoded) and excerpt: (excerpt:encoded). Pages keep their hierarchy through wp:post_parent,
 * menus are posts of type nav_menu_item with _menu_item_* meta, and pictures are attachment posts with
 * wp:attachment_url.
 */
import { Site } from '../model/site';
import { esc, escAttr, getTitle, htmlToText } from '../model/html';
import { baseName, dirOf, isPagePath, joinPath, relativeRef, slugify, stripExt } from '../model/paths';
import { rewriteRefs, defaultNav, type NavNode } from '../model/site';
import { applyTemplate, makeRegionMarkup } from '../site/templates';
import { blocksToHtml, hasBlocks, htmlToBlocks } from './blocks';
import { STARTER_CSS, menuHtml, splitMain, summarize, type MenuItem } from './common';

export function isWxr(text: string): boolean { return /<rss[^>]+xmlns:wp=/i.test(text.slice(0, 4000)); }

// ------------------------------------------------------------------------------------------
// The content model shared by the WXR reader and the REST API reader

export interface WpItem {
  id: number;
  type: string;
  title: string;
  slug: string;
  status: string;
  parent: number;
  order: number;
  date: string;
  author: string;
  /** Raw post content (block markup or classic HTML), or rendered HTML when `rendered`. */
  content: string;
  excerpt: string;
  rendered?: boolean;
  link: string;
  guid: string;
  categories: { domain: string; slug: string; name: string }[];
  meta: Record<string, string>;
  attachmentUrl?: string;
}

export interface WpModel {
  title: string;
  description: string;
  link: string;
  language: string;
  items: WpItem[];
  /** Menu name → items. */
  menus?: Map<string, WpItem[]>;
}

// ------------------------------------------------------------------------------------------
// Reading

const isNs = (el: Element, re: RegExp) => re.test(el.namespaceURI || '');
const WP_NS = /wordpress\.org\/export\/\d\.\d\/?$/;
const CONTENT_NS = /purl\.org\/rss\/1\.0\/modules\/content\/?$/;
const EXCERPT_NS = /wordpress\.org\/export\/\d\.\d\/excerpt\/?$/;
const DC_NS = /purl\.org\/dc\/elements\/1\.1\/?$/;

function kids(el: Element, local: string, ns?: RegExp): Element[] {
  return [...el.children].filter((c) => c.localName === local && (ns ? isNs(c, ns) : !c.namespaceURI || c.namespaceURI === el.namespaceURI || !c.prefix));
}
function txt(el: Element, local: string, ns?: RegExp): string {
  return kids(el, local, ns)[0]?.textContent?.trim() ?? '';
}
function raw(el: Element, local: string, ns?: RegExp): string {
  return kids(el, local, ns)[0]?.textContent ?? '';
}

function parseXml(xml: string): Document {
  const p = new DOMParser();
  let doc = p.parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    // Exports from damaged databases can hold control characters and bare ampersands outside CDATA.
    const fixed = xml.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
    doc = p.parseFromString(fixed, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This file is not a readable WordPress export (XML error).');
  }
  return doc;
}

export function parseWxr(xml: string): WpModel {
  const doc = parseXml(xml);
  const channel = doc.getElementsByTagName('channel')[0];
  if (!channel) throw new Error('This file is not a WordPress export (no RSS channel).');
  const authors = new Map<string, string>();
  for (const a of kids(channel, 'author', WP_NS)) authors.set(txt(a, 'author_login', WP_NS), txt(a, 'author_display_name', WP_NS) || txt(a, 'author_login', WP_NS));
  const items: WpItem[] = [];
  for (const it of kids(channel, 'item')) {
    const meta: Record<string, string> = {};
    for (const pm of kids(it, 'postmeta', WP_NS)) meta[txt(pm, 'meta_key', WP_NS)] = txt(pm, 'meta_value', WP_NS);
    const login = txt(it, 'creator', DC_NS);
    items.push({
      id: Number(txt(it, 'post_id', WP_NS)) || 0,
      type: txt(it, 'post_type', WP_NS) || 'post',
      title: txt(it, 'title'),
      slug: txt(it, 'post_name', WP_NS),
      status: txt(it, 'status', WP_NS) || 'publish',
      parent: Number(txt(it, 'post_parent', WP_NS)) || 0,
      order: Number(txt(it, 'menu_order', WP_NS)) || 0,
      date: txt(it, 'post_date', WP_NS) || txt(it, 'pubDate'),
      author: authors.get(login) || login,
      content: raw(it, 'encoded', CONTENT_NS),
      excerpt: raw(it, 'encoded', EXCERPT_NS),
      link: txt(it, 'link'),
      guid: txt(it, 'guid'),
      categories: kids(it, 'category').map((c) => ({ domain: c.getAttribute('domain') || '', slug: c.getAttribute('nicename') || slugify(c.textContent || ''), name: (c.textContent || '').trim() })),
      meta,
      attachmentUrl: txt(it, 'attachment_url', WP_NS) || undefined,
    });
  }
  return {
    title: txt(channel, 'title'),
    description: txt(channel, 'description'),
    link: txt(channel, 'link') || txt(channel, 'base_site_url', WP_NS),
    language: txt(channel, 'language') || 'en-US',
    items,
  };
}

// ------------------------------------------------------------------------------------------
// Content conversion

const BLOCK_START = /^\s*<(?:div|p|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre|figure|hr|section|article|aside|header|footer|nav|form|dl|dd|dt|address|iframe|video|audio|script|style|!--)/i;

/** WordPress's automatic paragraphs for classic content: blank lines → <p>, single line breaks → <br>. */
export function autop(text: string): string {
  if (!text.trim()) return '';
  const keep: string[] = [];
  let s = text.replace(/\r\n?/g, '\n').replace(/<(pre|script|style)\b[\s\S]*?<\/\1>/gi, (m) => { keep.push(m); return `\u0002${keep.length - 1}\u0002`; });
  s = s.split(/\n\s*\n/).map((chunk) => {
    const c = chunk.trim();
    if (!c) return '';
    if (/^\u0002\d+\u0002$/.test(c) || BLOCK_START.test(c)) return c;
    return `<p>${c.replace(/\n/g, '<br>\n')}</p>`;
  }).filter(Boolean).join('\n');
  return s.replace(/\u0002(\d+)\u0002/g, (m, i) => keep[+i]);
}

/** Converts [caption] shortcodes to figures and lists the other shortcodes, which stay as text. */
export function handleShortcodes(html: string, found: string[]): string {
  let s = html.replace(/\[caption\b([^\]]*)\]([\s\S]*?)\[\/caption\]/gi, (m, attrs: string, inner: string) => {
    const img = /<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>|<img\b[^>]*>/i.exec(inner)?.[0] || '';
    const cap = (inner.replace(img, '').trim() || /caption\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || '').trim();
    const align = /align\s*=\s*["']?(align\w+)/i.exec(attrs)?.[1] || '';
    return `<figure class="wp-caption ${align}">${img}${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;
  });
  s = s.replace(/<[^>]+>|\[\/?([a-z][\w-]*)(?:\s[^\]]*)?\]/gi, (m, name: string | undefined) => { if (name && !m.startsWith('[/')) found.push(name); return m; });
  return s;
}

export function contentToHtml(item: WpItem, shortcodes: string[]): string {
  if (item.rendered) return item.content.trim();
  const c = item.content || '';
  const html = hasBlocks(c) ? blocksToHtml(c) : autop(c);
  return handleShortcodes(html, shortcodes).trim();
}

// ------------------------------------------------------------------------------------------
// Building the site

const norm = (u: string) => u.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[#].*$/, '').replace(/\/+$/, '').toLowerCase();

const TEMPLATE = 'Templates/site.dwt';

function templateSrc(m: WpModel, menu: MenuItem[]): string {
  const file = TEMPLATE;
  return `<!DOCTYPE html>
<html lang="${escAttr(m.language || 'en-US')}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${makeRegionMarkup('doctitle', `<title>${esc(m.title || 'Web Site')}</title>`)}
  <link rel="stylesheet" href="${relativeRef(file, 'css/site.css')}">
</head>
<body>
<header class="site-header">
  <p class="site-title"><a href="${relativeRef(file, 'index.html')}">${esc(m.title || 'Web Site')}</a></p>
  <nav class="site-nav" aria-label="Main">${menuHtml(menu, file)}</nav>
  ${m.description ? `<p class="site-tagline">${esc(m.description)}</p>` : ''}
</header>
<main class="site-main">
${makeRegionMarkup('content', '\n<p>Content</p>\n')}
</main>
<footer class="site-footer">
  <p>© ${new Date().getFullYear()} ${esc(m.title || 'Web Site')}</p>
</footer>
</body>
</html>
`;
}

function writePage(site: Site, path: string, title: string, siteTitle: string, content: string): void {
  const src = `<html>${makeRegionMarkup('doctitle', `<title>${esc(title)}${title === siteTitle ? '' : ' – ' + esc(siteTitle)}</title>`)}${makeRegionMarkup('content', '\n' + content + '\n')}</html>`;
  site.write(path, applyTemplate(site, TEMPLATE, src, path), { silent: true });
  site.data.templates[path] = TEMPLATE;
}

const dateOf = (d: string) => { const x = new Date(d.replace(' ', 'T')); return isNaN(+x) ? d : x.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); };

/** Builds a static site from WordPress content (from a WXR file or the REST API). */
export function buildSiteFromWp(m: WpModel, opts: { name?: string; includeDrafts?: boolean } = {}): { site: Site; report: string[]; open?: string } {
  const report: string[] = [];
  const siteTitle = m.title || opts.name || 'WordPress Site';
  const site = new Site(opts.name || siteTitle);
  site.data.meta.description = m.description;
  if (m.link) site.data.meta['wp:url'] = m.link;
  const live = (i: WpItem) => i.status === 'publish' || (opts.includeDrafts && /draft|pending|private|future/.test(i.status));
  const pages = m.items.filter((i) => i.type === 'page' && live(i));
  const posts = m.items.filter((i) => i.type === 'post' && live(i)).sort((a, b) => b.date.localeCompare(a.date));
  const attachments = m.items.filter((i) => i.type === 'attachment');
  const skipped = m.items.filter((i) => (i.type === 'page' || i.type === 'post') && !live(i));
  const others = m.items.filter((i) => !['page', 'post', 'attachment', 'nav_menu_item', 'revision', 'customize_changeset', 'oembed_cache', 'wp_global_styles', 'wp_navigation', 'custom_css'].includes(i.type));

  // Paths: pages by hierarchy, posts under blog/.
  const byId = new Map(m.items.map((i) => [i.id, i]));
  const hasKids = new Set(pages.map((p) => p.parent).filter(Boolean));
  const pathOf = new Map<number, string>();
  const slugOf = (i: WpItem) => i.slug || slugify(i.title) || `page-${i.id}`;
  const used = new Set<string>();
  const unique = (p: string) => { let q = p; for (let n = 2; used.has(q); n++) q = p.replace(/(\.html)$/, `-${n}$1`); used.add(q); return q; };
  let home = pages.find((p) => /^(home|front-page|start|startseite|accueil|inicio)$/.test(p.slug)) || pages.find((p) => /^home$/i.test(p.title));
  const pagePath = (p: WpItem, depth = 0): string => {
    if (pathOf.has(p.id)) return pathOf.get(p.id)!;
    if (p === home) { pathOf.set(p.id, 'index.html'); used.add('index.html'); return 'index.html'; }
    const parent = p.parent && depth < 12 ? byId.get(p.parent) : undefined;
    const dir = parent && parent.type === 'page' && parent !== home ? stripExt(pagePath(parent, depth + 1)).replace(/\/index$/, '') : '';
    const path = unique(hasKids.has(p.id) ? joinPath(dir, slugOf(p), 'index.html') : joinPath(dir, slugOf(p) + '.html'));
    pathOf.set(p.id, path);
    return path;
  };
  used.add('index.html');
  for (const p of [...pages].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))) pagePath(p);
  const blogDir = pages.some((p) => p.slug === 'blog') ? 'posts' : 'blog';
  for (const p of posts) pathOf.set(p.id, unique(joinPath(blogDir, slugOf(p) + '.html')));
  const hasBlog = posts.length > 0;

  // Menus → navigation.
  const menuItems = m.menus || new Map<string, WpItem[]>();
  if (!m.menus) {
    for (const it of m.items.filter((i) => i.type === 'nav_menu_item')) {
      const menu = it.categories.find((c) => c.domain === 'nav_menu')?.slug || 'menu';
      if (!menuItems.has(menu)) menuItems.set(menu, []);
      menuItems.get(menu)!.push(it);
    }
  }
  const pickMenu = [...menuItems.entries()].sort((a, b) => (/primary|main|header|top/.test(b[0]) ? 1 : 0) - (/primary|main|header|top/.test(a[0]) ? 1 : 0) || b[1].length - a[1].length)[0];
  const linkMap = new Map<string, string>();
  for (const i of [...pages, ...posts]) {
    const p = pathOf.get(i.id)!;
    if (i.link) linkMap.set(norm(i.link), p);
    if (i.guid) linkMap.set(norm(i.guid), p);
    if (m.link) { linkMap.set(norm(`${m.link}/?page_id=${i.id}`), p); linkMap.set(norm(`${m.link}/?p=${i.id}`), p); }
  }
  let menu: MenuItem[];
  if (pickMenu) {
    const list = pickMenu[1].sort((a, b) => a.order - b.order);
    const node = new Map<number, MenuItem>();
    menu = [];
    for (const it of list) {
      const type = it.meta._menu_item_type;
      const objId = Number(it.meta._menu_item_object_id);
      const target = byId.get(objId);
      let mi: MenuItem;
      if (type === 'post_type' && target && pathOf.has(objId)) mi = { label: it.title || target.title, path: pathOf.get(objId)! };
      else if (type === 'taxonomy') mi = hasBlog ? { label: it.title || 'Blog', path: joinPath(blogDir, 'index.html') } : { label: it.title || 'Category', url: '#' };
      else {
        const url = it.meta._menu_item_url || '#';
        const local = linkMap.get(norm(url)) || (m.link && norm(url) === norm(m.link) ? 'index.html' : undefined);
        mi = local ? { label: it.title || 'Link', path: local } : { label: it.title || url, url };
      }
      node.set(it.id, mi);
      const parent = Number(it.meta._menu_item_menu_item_parent);
      const pm = parent ? node.get(parent) : undefined;
      if (pm) (pm.children ||= []).push(mi); else menu.push(mi);
    }
    report.push(`Menu "${pickMenu[0]}" with ${list.length} items became the site navigation.${menuItems.size > 1 ? ` Other menus (${[...menuItems.keys()].filter((k) => k !== pickMenu[0]).join(', ')}) were not used.` : ''}`);
  } else {
    menu = [{ label: 'Home', path: 'index.html' }, ...pages.filter((p) => !p.parent && p !== home).sort((a, b) => a.order - b.order).map((p) => ({ label: p.title, path: pathOf.get(p.id)! }))];
    if (hasBlog) menu.push({ label: 'Blog', path: joinPath(blogDir, 'index.html') });
  }
  if (!menu.some((x) => x.path === 'index.html')) menu.unshift({ label: 'Home', path: 'index.html' });

  site.write('css/site.css', STARTER_CSS, { silent: true });
  site.write(TEMPLATE, templateSrc(m, menu), { silent: true });

  // Content.
  const shortcodes: string[] = [];
  const media = new Set<string>();
  const siteHost = m.link ? norm(m.link) : '';
  const relinkContent = (html: string, from: string): string => {
    let out = html.replace(/(\s(?:href|src)\s*=\s*)(["'])([^"']+)\2/gi, (mm, a: string, q: string, url: string) => {
      if (!/^https?:\/\//i.test(url)) return mm;
      const local = linkMap.get(norm(url)) || (siteHost && norm(url) === siteHost ? 'index.html' : undefined);
      if (local) return `${a}${q}${relativeRef(from, local)}${q}`;
      if (/\/wp-content\/uploads\//i.test(url)) media.add(url);
      return mm;
    });
    out = rewriteRefs(out, from, () => null);
    return out;
  };
  for (const p of pages) {
    const path = pathOf.get(p.id)!;
    const html = relinkContent(contentToHtml(p, shortcodes), path);
    const kidsOf = pages.filter((k) => k.parent === p.id).sort((a, b) => a.order - b.order);
    const sub = kidsOf.length && !/<a\b/.test(html.slice(-400)) ? `\n<ul class="child-pages">${kidsOf.map((k) => `<li><a href="${escAttr(relativeRef(path, pathOf.get(k.id)!))}">${esc(k.title)}</a></li>`).join('')}</ul>` : '';
    writePage(site, path, p.title, siteTitle, `<h1>${esc(p.title)}</h1>\n${html}${sub}`);
  }
  const catName = new Map<string, string>();
  const tagName = new Map<string, string>();
  for (const p of posts) for (const c of p.categories) (c.domain === 'category' ? catName : c.domain === 'post_tag' ? tagName : new Map()).set(c.slug, c.name);
  const termLinks = (p: WpItem, from: string, domain: string, folder: string) => p.categories.filter((c) => c.domain === domain).map((c) => `<a href="${escAttr(relativeRef(from, joinPath(blogDir, folder, c.slug + '.html')))}">${esc(c.name)}</a>`).join(', ');
  for (const p of posts) {
    const path = pathOf.get(p.id)!;
    const html = relinkContent(contentToHtml(p, shortcodes), path);
    const cats = termLinks(p, path, 'category', 'category');
    const tags = termLinks(p, path, 'post_tag', 'tag');
    writePage(site, path, p.title, siteTitle, `<article>\n<h1>${esc(p.title)}</h1>\n<p class="post-meta">${esc(dateOf(p.date))}${p.author ? ' · ' + esc(p.author) : ''}${cats ? ' · ' + cats : ''}</p>\n${html}\n${tags ? `<p class="post-meta">Tags: ${tags}</p>` : ''}\n</article>`);
  }
  const listing = (from: string, list: WpItem[]) => `<ul class="post-list">\n${list.map((p) => `<li><h2><a href="${escAttr(relativeRef(from, pathOf.get(p.id)!))}">${esc(p.title)}</a></h2><p class="post-meta">${esc(dateOf(p.date))}</p><p>${esc(excerptOf(p))}</p></li>`).join('\n')}\n</ul>`;
  if (hasBlog) {
    const idx = joinPath(blogDir, 'index.html');
    if (!site.has(idx)) writePage(site, idx, 'Blog', siteTitle, `<h1>Blog</h1>\n${listing(idx, posts)}`);
    for (const [slug, name] of catName) { const f = joinPath(blogDir, 'category', slug + '.html'); writePage(site, f, name, siteTitle, `<h1>${esc(name)}</h1>\n${listing(f, posts.filter((p) => p.categories.some((c) => c.domain === 'category' && c.slug === slug)))}`); }
    for (const [slug, name] of tagName) { const f = joinPath(blogDir, 'tag', slug + '.html'); writePage(site, f, `Tag: ${name}`, siteTitle, `<h1>Tag: ${esc(name)}</h1>\n${listing(f, posts.filter((p) => p.categories.some((c) => c.domain === 'post_tag' && c.slug === slug)))}`); }
  }
  if (!home) {
    const intro = `<h1>${esc(siteTitle)}</h1>\n${m.description ? `<p>${esc(m.description)}</p>\n` : ''}`;
    const list = hasBlog ? `<h2>Latest posts</h2>\n${listing('index.html', posts.slice(0, 10))}` : `<ul>${pages.filter((p) => !p.parent).map((p) => `<li><a href="${escAttr(relativeRef('index.html', pathOf.get(p.id)!))}">${esc(p.title)}</a></li>`).join('')}</ul>`;
    writePage(site, 'index.html', siteTitle, siteTitle, intro + list);
    report.push('No page is marked as the home page (slug "home"), so index.html lists the latest posts. WordPress exports do not say which page was the front page.');
  }

  // Navigation structure from the menu.
  const toNav = (items: MenuItem[]): NavNode[] => items.filter((i) => i.path && i.path !== 'index.html').map((i) => ({ path: i.path!, label: i.label, children: toNav(i.children || []) }));
  site.data.nav = { path: 'index.html', children: toNav(menu) };
  if (!site.data.nav.children.length) site.data.nav = defaultNav(site);
  site.data.meta['wp:menu'] = JSON.stringify(menu);

  report.push(`${pages.length} page(s) and ${posts.length} post(s) from "${siteTitle}". All pages use Templates/site.dwt (header, menu, footer); edit it once to change every page.`);
  if (hasBlog) report.push(`Posts are in ${blogDir}/ with an index, ${catName.size} category page(s) and ${tagName.size} tag page(s).`);
  if (skipped.length) report.push(`${skipped.length} draft, private or trashed item(s) were not imported.`);
  if (shortcodes.length) report.push(`Shortcodes need the plugins that define them and were left as text: ${summarize(shortcodes.map((s) => `[${s}]`))}.`);
  const atts = attachments.map((a) => a.attachmentUrl || a.guid).filter(Boolean);
  for (const u of atts) media.add(u);
  if (media.size) {
    report.push(`${media.size} picture/media address(es) still point at the original server (they were not downloaded). The list is in _wordpress/media.txt; download the files, add them to the site and relink, or keep the links if the old site stays online.`);
    site.write('_wordpress/media.txt', [...media].join('\n') + '\n', { silent: true });
    site.get('_wordpress/media.txt')!.noPublish = true;
  }
  if (others.length) report.push(`Other content types were skipped: ${summarize(others.map((o) => o.type))}.`);
  return { site, report, open: 'index.html' };
}

function excerptOf(p: WpItem): string {
  const e = htmlToText(p.excerpt || '');
  if (e) return e;
  const t = htmlToText(p.rendered ? p.content : blocksToHtml(p.content || '')).replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 197).replace(/\s+\S*$/, '') + '…' : t;
}

export function wxrToSite(xml: string, opts: { name?: string; includeDrafts?: boolean } = {}): { site: Site; report: string[]; open?: string } {
  return buildSiteFromWp(parseWxr(xml), opts);
}

// ------------------------------------------------------------------------------------------
// Writing

const cdata = (s: string) => `<![CDATA[${s.split(']]>').join(']]]]><![CDATA[>')}]]>`;
const xmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pad = (n: number) => String(n).padStart(2, '0');
const wpDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const wpDateGmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/** Pages of a site that belong in an export (not templates, library items or unpublished files). */
export function contentPages(site: Site): string[] {
  return site.pages().filter((f) => !f.noPublish && !/\.(dwt|lbi)$/i.test(f.path) && !/^(Templates|Library|_[^/]*)\//.test(f.path) && !/\.php$/i.test(f.path)).map((f) => f.path);
}

/** WordPress page path ("about/team") for a site page; "" for the home page. */
export function wpPathOf(site: Site, p: string): string {
  if (p === site.homePage) return '';
  const base = stripExt(baseName(p));
  const dir = dirOf(p);
  const parts = (base === 'index' || base === 'default' ? dir : joinPath(dir, base)).split('/').filter(Boolean).map(slugify);
  return parts.join('/');
}

/** Title of a page: its <title> (without " – Site"), else its first <h1>, else its file name. */
export function pageTitleOf(site: Site, p: string, src: string): string {
  let t = getTitle(src);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(splitMain(src).content)?.[1];
  if (h1) return htmlToText(h1) || t;
  if (t && site.name) t = t.replace(new RegExp(`\\s*[–|—-]\\s*${site.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '');
  return t || stripExt(baseName(p));
}

/** The content to send to WordPress for a page: its main area, with the leading <h1> (the title) removed. */
export function pageContentOf(src: string): string {
  const c = splitMain(src).content.replace(/<!--\s*#?(Begin|End)\w*[^>]*-->|<!--\s*(Instance|Template)\w*[^>]*-->/gi, '').trim();
  return c.replace(/^\s*(<(?:article|section|div)\b[^>]*>\s*)?<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, '$1').trim();
}

export function siteToWxr(site: Site, opts: { siteUrl?: string; author?: string; postType?: 'page' | 'post'; blocks?: boolean; paths?: string[] } = {}): string {
  const base = (opts.siteUrl || site.data.meta['wp:url'] || 'https://example.com').replace(/\/+$/, '');
  const author = opts.author || 'admin';
  const type = opts.postType || 'page';
  const now = new Date();
  const paths = opts.paths || contentPages(site);
  const ids = new Map<string, number>();
  let next = 100;
  for (const p of paths) ids.set(p, next++);
  const wpPath = new Map(paths.map((p) => [p, wpPathOf(site, p)]));
  const byWpPath = new Map([...wpPath].map(([k, v]) => [v, k]));
  const permalink = (p: string) => `${base}/${wpPath.get(p) ? wpPath.get(p) + '/' : ''}`;
  const navOrder = new Map<string, number>();
  let order = 1;
  const walk = (n: NavNode | null) => { if (!n) return; navOrder.set(n.path, order++); n.children.forEach(walk); };
  walk(site.data.nav);
  const attachments = new Map<string, number>();
  const items: string[] = [];
  for (const p of paths) {
    const src = site.read(p) || '';
    const title = pageTitleOf(site, p, src);
    const wp = wpPath.get(p)!;
    const slug = wp ? wp.split('/').pop()! : 'home';
    const parentPath = type === 'page' && wp.includes('/') ? byWpPath.get(wp.split('/').slice(0, -1).join('/')) : undefined;
    let content = pageContentOf(src);
    content = rewriteRefs(content, p, (target) => {
      if (isPagePath(target)) return paths.includes(target) ? (type === 'page' ? '/' + (wpPath.get(target) ? wpPath.get(target) + '/' : '') : permalink(target)) : null;
      if (!site.has(target)) return null;
      if (opts.siteUrl && /\.(png|jpe?g|gif|webp|svg|avif|pdf|mp4|mp3)$/i.test(target) && !attachments.has(target)) attachments.set(target, next++);
      return opts.siteUrl ? `${base}/${target}` : null;
    });
    if (opts.blocks !== false) content = htmlToBlocks(content);
    const d = new Date(site.get(p)?.modified || now);
    items.push(`
	<item>
		<title>${xmlEsc(title)}</title>
		<link>${xmlEsc(permalink(p))}</link>
		<pubDate>${d.toUTCString().replace('GMT', '+0000')}</pubDate>
		<dc:creator>${cdata(author)}</dc:creator>
		<guid isPermaLink="false">${xmlEsc(`${base}/?${type === 'page' ? 'page_id' : 'p'}=${ids.get(p)}`)}</guid>
		<description></description>
		<content:encoded>${cdata(content)}</content:encoded>
		<excerpt:encoded>${cdata('')}</excerpt:encoded>
		<wp:post_id>${ids.get(p)}</wp:post_id>
		<wp:post_date>${cdata(wpDate(d))}</wp:post_date>
		<wp:post_date_gmt>${cdata(wpDateGmt(d))}</wp:post_date_gmt>
		<wp:post_modified>${cdata(wpDate(d))}</wp:post_modified>
		<wp:post_modified_gmt>${cdata(wpDateGmt(d))}</wp:post_modified_gmt>
		<wp:comment_status>${cdata('closed')}</wp:comment_status>
		<wp:ping_status>${cdata('closed')}</wp:ping_status>
		<wp:post_name>${cdata(slug)}</wp:post_name>
		<wp:status>${cdata('publish')}</wp:status>
		<wp:post_parent>${parentPath ? ids.get(parentPath) : 0}</wp:post_parent>
		<wp:menu_order>${navOrder.get(p) ?? 0}</wp:menu_order>
		<wp:post_type>${cdata(type)}</wp:post_type>
		<wp:post_password>${cdata('')}</wp:post_password>
		<wp:is_sticky>0</wp:is_sticky>${type === 'post' ? `\n\t\t<category domain="category" nicename="uncategorized">${cdata('Uncategorized')}</category>` : ''}
	</item>`);
  }
  for (const [p, id] of attachments) {
    const url = `${base}/${p}`;
    items.push(`
	<item>
		<title>${xmlEsc(stripExt(baseName(p)))}</title>
		<link>${xmlEsc(url)}</link>
		<pubDate>${now.toUTCString().replace('GMT', '+0000')}</pubDate>
		<dc:creator>${cdata(author)}</dc:creator>
		<guid isPermaLink="false">${xmlEsc(url)}</guid>
		<description></description>
		<content:encoded>${cdata('')}</content:encoded>
		<excerpt:encoded>${cdata('')}</excerpt:encoded>
		<wp:post_id>${id}</wp:post_id>
		<wp:post_date>${cdata(wpDate(now))}</wp:post_date>
		<wp:post_date_gmt>${cdata(wpDateGmt(now))}</wp:post_date_gmt>
		<wp:comment_status>${cdata('closed')}</wp:comment_status>
		<wp:ping_status>${cdata('closed')}</wp:ping_status>
		<wp:post_name>${cdata(slugify(stripExt(baseName(p))))}</wp:post_name>
		<wp:status>${cdata('inherit')}</wp:status>
		<wp:post_parent>0</wp:post_parent>
		<wp:menu_order>0</wp:menu_order>
		<wp:post_type>${cdata('attachment')}</wp:post_type>
		<wp:post_password>${cdata('')}</wp:post_password>
		<wp:is_sticky>0</wp:is_sticky>
		<wp:attachment_url>${cdata(url)}</wp:attachment_url>
	</item>`);
  }
  // The navigation structure as a menu.
  let menuXml = '';
  const navItems: { path: string; label: string; parent: number; id: number; order: number }[] = [];
  const addNav = (n: NavNode, parent: number) => {
    for (const c of n.children) {
      if (!ids.has(c.path)) continue;
      const id = next++;
      navItems.push({ path: c.path, label: c.label || '', parent, id, order: navItems.length + 1 });
      addNav(c, id);
    }
  };
  if (site.data.nav && type === 'page') {
    if (ids.has(site.data.nav.path)) navItems.push({ path: site.data.nav.path, label: 'Home', parent: 0, id: next++, order: 1 });
    addNav(site.data.nav, 0);
  }
  if (navItems.length) {
    menuXml = `\n\t<wp:term><wp:term_id>1</wp:term_id><wp:term_taxonomy>${cdata('nav_menu')}</wp:term_taxonomy><wp:term_slug>${cdata('main-menu')}</wp:term_slug><wp:term_name>${cdata('Main Menu')}</wp:term_name></wp:term>`;
    for (const n of navItems) {
      items.push(`
	<item>
		<title>${xmlEsc(n.label)}</title>
		<link>${xmlEsc(`${base}/?p=${n.id}`)}</link>
		<pubDate>${now.toUTCString().replace('GMT', '+0000')}</pubDate>
		<dc:creator>${cdata(author)}</dc:creator>
		<guid isPermaLink="false">${xmlEsc(`${base}/?p=${n.id}`)}</guid>
		<description></description>
		<content:encoded>${cdata('')}</content:encoded>
		<excerpt:encoded>${cdata('')}</excerpt:encoded>
		<wp:post_id>${n.id}</wp:post_id>
		<wp:post_date>${cdata(wpDate(now))}</wp:post_date>
		<wp:post_date_gmt>${cdata(wpDateGmt(now))}</wp:post_date_gmt>
		<wp:comment_status>${cdata('closed')}</wp:comment_status>
		<wp:ping_status>${cdata('closed')}</wp:ping_status>
		<wp:post_name>${cdata(String(n.id))}</wp:post_name>
		<wp:status>${cdata('publish')}</wp:status>
		<wp:post_parent>0</wp:post_parent>
		<wp:menu_order>${n.order}</wp:menu_order>
		<wp:post_type>${cdata('nav_menu_item')}</wp:post_type>
		<wp:post_password>${cdata('')}</wp:post_password>
		<wp:is_sticky>0</wp:is_sticky>
		<category domain="nav_menu" nicename="main-menu">${cdata('Main Menu')}</category>
		<wp:postmeta><wp:meta_key>${cdata('_menu_item_type')}</wp:meta_key><wp:meta_value>${cdata('post_type')}</wp:meta_value></wp:postmeta>
		<wp:postmeta><wp:meta_key>${cdata('_menu_item_menu_item_parent')}</wp:meta_key><wp:meta_value>${cdata(String(n.parent))}</wp:meta_value></wp:postmeta>
		<wp:postmeta><wp:meta_key>${cdata('_menu_item_object_id')}</wp:meta_key><wp:meta_value>${cdata(String(ids.get(n.path)))}</wp:meta_value></wp:postmeta>
		<wp:postmeta><wp:meta_key>${cdata('_menu_item_object')}</wp:meta_key><wp:meta_value>${cdata('page')}</wp:meta_value></wp:postmeta>
		<wp:postmeta><wp:meta_key>${cdata('_menu_item_target')}</wp:meta_key><wp:meta_value>${cdata('')}</wp:meta_value></wp:postmeta>
		<wp:postmeta><wp:meta_key>${cdata('_menu_item_classes')}</wp:meta_key><wp:meta_value>${cdata('a:1:{i:0;s:0:"";}')}</wp:meta_value></wp:postmeta>
		<wp:postmeta><wp:meta_key>${cdata('_menu_item_xfn')}</wp:meta_key><wp:meta_value>${cdata('')}</wp:meta_value></wp:postmeta>
		<wp:postmeta><wp:meta_key>${cdata('_menu_item_url')}</wp:meta_key><wp:meta_value>${cdata('')}</wp:meta_value></wp:postmeta>
	</item>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<!-- This is a WordPress eXtended RSS file generated by QuillLoom for importing content into a site. -->
<!-- In WordPress: Tools > Import > WordPress, then choose this file. -->
<rss version="2.0"
	xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:wfw="http://wellformedweb.org/CommentAPI/"
	xmlns:dc="http://purl.org/dc/elements/1.1/"
	xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
	<title>${xmlEsc(site.name)}</title>
	<link>${xmlEsc(base)}</link>
	<description>${xmlEsc(site.data.meta.description || '')}</description>
	<pubDate>${now.toUTCString().replace('GMT', '+0000')}</pubDate>
	<language>en-US</language>
	<wp:wxr_version>1.2</wp:wxr_version>
	<wp:base_site_url>${xmlEsc(base)}</wp:base_site_url>
	<wp:base_blog_url>${xmlEsc(base)}</wp:base_blog_url>
	<wp:author><wp:author_id>1</wp:author_id><wp:author_login>${cdata(author)}</wp:author_login><wp:author_email>${cdata('')}</wp:author_email><wp:author_display_name>${cdata(author)}</wp:author_display_name><wp:author_first_name>${cdata('')}</wp:author_first_name><wp:author_last_name>${cdata('')}</wp:author_last_name></wp:author>${menuXml}
	<generator>QuillLoom</generator>
${items.join('\n')}
</channel>
</rss>
`;
}
