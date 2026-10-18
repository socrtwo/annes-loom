/**
 * WordPress themes.
 *
 * Import: a classic theme (style.css header + PHP templates) or a block theme (theme.json + templates/*.html
 * + parts/*.html) becomes a static, editable site: a page template (Templates/page.dwt) with "doctitle",
 * "pagetitle" and "content" editable regions, sample pages attached to it, a blog index and posts. Template
 * tags get static values (site title, menus from the pages, relative asset links); PHP is never run, and
 * everything that had no static meaning is listed in the report. The original theme is kept in
 * _theme-source/ (not published).
 *
 * Export: a classic theme generated from a page of the site: header.php / footer.php split around the main
 * content, index.php / page.php / single.php / 404.php with the loop, functions.php that enqueues the
 * site's style sheets and scripts, and a style.css header.
 */
import { Site } from '../model/site';
import { esc, escAttr, getTitle, regions } from '../model/html';
import { baseName, dirOf, extOf, isPagePath, joinPath, relativeRef, resolveRef, slugify, stripExt } from '../model/paths';
import { rewriteRefs } from '../model/site';
import { detachTemplate, expandIncludes } from '../site/templates';
import { renderPhp, type PhpEnv, type PhpReport, type Evaluator } from './php';
import { blocksToHtml, addClassToFirstTag, type Block } from './blocks';
import {
  textOf, assembleThemeSite, keepSource, menuHtml, summarize, splitMain, zipFiles, bytesOf,
  MARK_CONTENT, MARK_TITLE, type ThemeCtx, type ThemeRenderer, type MenuItem,
} from './common';

// ------------------------------------------------------------------------------------------
// style.css header

export function themeHeader(css: string): Record<string, string> {
  const m = /\/\*([\s\S]*?)\*\//.exec(css);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*\*?\s*([A-Za-z][A-Za-z ]+?)\s*:\s*(.+?)\s*$/.exec(line);
    if (kv) out[kv[1].toLowerCase()] = kv[2];
  }
  return out;
}

export function isClassicTheme(files: Map<string, Uint8Array>): boolean {
  return files.has('style.css') && /Theme Name\s*:/i.test(textOf(files.get('style.css'))) && files.has('index.php');
}
export function isBlockTheme(files: Map<string, Uint8Array>): boolean {
  return files.has('theme.json') && [...files.keys()].some((k) => /^(templates|block-templates)\/[^/]+\.html$/.test(k));
}

const isPhp = (p: string) => extOf(p) === 'php';

// ------------------------------------------------------------------------------------------
// Shared WordPress environment (classic templates and block patterns)

interface Enqueued { kind: 'style' | 'script'; handle: string; src: string; footer: boolean; deps: string }

/** Finds wp_enqueue_style / wp_enqueue_script calls in functions.php (and files it includes). */
function findEnqueues(files: Map<string, Uint8Array>): Enqueued[] {
  const out: Enqueued[] = [];
  const srcs = [...files.keys()].filter((k) => isPhp(k) && (k === 'functions.php' || /^(inc|includes|lib)\//.test(k))).map((k) => textOf(files.get(k)));
  for (const s of srcs) {
    for (const m of s.matchAll(/wp_(?:enqueue|register)_(style|script)\s*\(/g)) {
      const start = m.index! + m[0].length - 1;
      let depth = 0, j = start, q: string | null = null;
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '(') depth++; else if (c === ')' && --depth === 0) break;
      }
      const inner = s.slice(start + 1, j);
      const args = splitArgs(inner);
      if (args.length < 2) continue;
      out.push({ kind: m[1] as 'style' | 'script', handle: args[0], src: args[1], deps: args[2] || '', footer: m[1] === 'script' && /true|in_footer|'footer'/.test(args[4] || '') });
    }
  }
  return out;
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, q: string | null = null, last = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(last, j).trim()); last = j + 1; }
  }
  if (s.slice(last).trim()) out.push(s.slice(last).trim());
  return out;
}

const fmtDate = (iso: string) => { const d = new Date(iso + 'T12:00:00'); return isNaN(+d) ? iso : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); };

class WpEnv implements PhpEnv {
  private loopIndex = 0;
  constructor(public ctx: ThemeCtx, private files: Map<string, Uint8Array>, private report: PhpReport, private enq: Enqueued[], private depth = 0, private vars = new Map<string, string>()) {}
  get item() { return this.ctx.item; }
  rel(p: string): string { return relativeRef(this.ctx.file, p); }
  get root(): string { return this.ctx.root; }
  title(): string { return this.ctx.markers ? MARK_TITLE : esc(this.item.title); }
  content(): string { return this.ctx.markers ? MARK_CONTENT : this.item.content; }

  include(candidates: string[]): string {
    const f = candidates.find((c) => this.files.has(c));
    if (!f) return '';
    if (this.depth > 8) return '';
    const sub = new WpEnv(this.ctx, this.files, this.report, this.enq, this.depth + 1, this.vars);
    sub.loopIndex = this.loopIndex;
    const out = renderPhp(textOf(this.files.get(f)), sub, this.report, this.vars);
    return out;
  }

  menu(args: Record<string, string>): string {
    const ul = menuHtml(this.ctx.menu, this.ctx.file, { cls: args.menu_class ?? 'menu', id: args.menu_id, current: this.ctx.file });
    const container = args.container === '' || args.container === '0' ? '' : args.container || 'div';
    if (!container) return ul;
    return `<${container}${args.container_class ? ` class="${escAttr(args.container_class)}"` : ''}${args.container_id ? ` id="${escAttr(args.container_id)}"` : ''}>${ul}</${container}>`;
  }

  enqueued(footer: boolean, ev: Evaluator): string {
    const out: string[] = [];
    let jquery = false;
    for (const e of this.enq) {
      if (e.footer !== footer) continue;
      if (/jquery/.test(e.deps)) jquery = true;
      const src = ev.expr(e.src);
      if (!src) continue;
      out.push(e.kind === 'style' ? `<link rel="stylesheet" href="${escAttr(src)}">` : `<script src="${escAttr(src)}"></script>`);
    }
    if (!footer && !this.enq.some((e) => e.kind === 'style' && /get_stylesheet_uri|style\.css/.test(e.src))) out.unshift(`<link rel="stylesheet" href="${escAttr(this.root + '/style.css')}">`);
    if (!footer && (jquery || this.enq.some((e) => /jquery/.test(e.deps)))) out.unshift('<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>');
    return out.join('\n');
  }

  bloginfo(k: string): string {
    switch (k) {
      case '': case 'name': return esc(this.ctx.siteName);
      case 'description': return esc(this.ctx.tagline);
      case 'charset': return 'UTF-8';
      case 'url': case 'wpurl': case 'home': case 'siteurl': return this.rel('index.html');
      case 'stylesheet_url': return this.root + '/style.css';
      case 'template_url': case 'template_directory': case 'stylesheet_directory': return this.root;
      case 'language': return 'en-US';
      case 'version': return '6.6';
      case 'html_type': return 'text/html';
      default: return '';
    }
  }

  homeUrl(path: string): string {
    const p = path.replace(/^\/+|\/+$/g, '');
    if (!p) return this.rel('index.html');
    const hit = this.ctx.menu.find((m) => m.path && stripExt(baseName(m.path)) === p.split('/').pop());
    return hit?.path ? this.rel(hit.path) : this.root + '/' + p;
  }

  call(name: string, args: string[], ev: Evaluator): string | undefined {
    const a = (i: number) => ev.expr(args[i] || '');
    const n = name.toLowerCase();
    switch (n) {
      case 'get_header': return this.include([args[0] ? `header-${a(0)}.php` : '', 'header.php'].filter(Boolean));
      case 'get_footer': return this.include([args[0] ? `footer-${a(0)}.php` : '', 'footer.php'].filter(Boolean));
      case 'get_sidebar': return this.include([args[0] ? `sidebar-${a(0)}.php` : '', 'sidebar.php'].filter(Boolean));
      case 'get_template_part': { const slug = a(0), nm = a(1); return this.include([nm ? `${slug}-${nm}.php` : '', `${slug}.php`].filter(Boolean)); }
      case 'locate_template': case 'load_template': return '';
      case 'get_search_form': return this.files.has('searchform.php') ? this.include(['searchform.php']) : `<form role="search" class="search-form" action="#"><label><span class="screen-reader-text">Search for:</span><input type="search" class="search-field" name="s" placeholder="Search …"></label><button type="submit" class="search-submit">Search</button></form>`;
      case 'comments_template': this.report.dropped.push('comments_template() (comments need a server)'); return '';
      case 'wp_head': return `<!--QL:wp_head-->\n${this.enqueued(false, ev)}`;
      case 'wp_footer': return this.enqueued(true, ev);
      case 'wp_body_open': case 'do_action': case 'wp_reset_postdata': case 'wp_reset_query': case 'rewind_posts': case 'setup_postdata': case 'add_action': case 'add_filter': case 'add_theme_support': case 'register_nav_menus': case 'wp_enqueue_style': case 'wp_enqueue_script': case 'wp_link_pages': case 'edit_post_link': case 'the_posts_navigation': case 'the_posts_pagination': case 'posts_nav_link': case 'next_posts_link': case 'previous_posts_link': case 'the_post_navigation': case 'next_post_link': case 'previous_post_link': case 'the_post_thumbnail': case 'the_custom_logo': case 'the_privacy_policy_link': case 'comment_form': case 'wp_list_comments': case 'the_comments_navigation': case 'post_thumbnail': case 'the_archive_description': case 'wp_meta': case 'wp_register': case 'wp_loginout': case 'paginate_links': case 'the_tags': case 'comments_popup_link': case 'comments_number':
        return '';
      case 'the_post': this.loopIndex = Math.min(this.loopIndex, this.ctx.items.length - 1); return '';
      case 'language_attributes': return 'lang="en-US"';
      case 'body_class': { const c = { page: 'page', front: 'home page', list: 'blog', single: 'single single-post', '404': 'error404' }[this.ctx.view]; return `class="${c}${args[0] ? ' ' + escAttr(a(0)) : ''}"`; }
      case 'post_class': return `class="post-${this.item.id} ${this.item.kind} type-${this.item.kind} status-publish hentry${args[0] ? ' ' + escAttr(a(0)) : ''}"`;
      case 'bloginfo': return this.bloginfo(a(0));
      case 'the_title': return a(0) + this.title() + a(1);
      case 'the_title_attribute': case 'single_post_title': case 'wp_title': return this.ctx.markers ? 'Page Title' : esc(this.item.title);
      case 'the_content': return this.content();
      case 'the_excerpt': return `<p>${esc(this.item.excerpt)}</p>`;
      case 'the_permalink': return this.rel(this.item.path);
      case 'the_id': return String(this.item.id);
      case 'the_date': case 'the_time': case 'the_modified_date': case 'the_modified_time': return a(1) + fmtDate(this.item.date) + a(2);
      case 'the_author': case 'the_author_posts_link': case 'the_author_link': return esc(this.item.author);
      case 'the_category': return `<a href="${escAttr(this.rel('blog/index.html'))}">News</a>`;
      case 'the_archive_title': return a(0) + 'Blog' + a(1);
      case 'wp_nav_menu': return this.menu(ev.array(args[0] || ''));
      case 'wp_page_menu': return `<div class="menu">${menuHtml(this.ctx.menu, this.ctx.file)}</div>`;
      case 'wp_list_pages': return menuHtml(this.ctx.menu, this.ctx.file).replace(/^<ul>|<\/ul>$/g, '');
      case 'dynamic_sidebar': this.report.dropped.push(`widget area ${a(0) || ''} (left empty)`); return '';
      case 'wp_get_archives': case 'wp_list_categories': return '';
    }
    const v = this.value(name, args, ev);
    if (v !== undefined) return '';
    return undefined;
  }

  value(name: string, args: string[], ev: Evaluator): string | undefined {
    const a = (i: number) => ev.expr(args[i] || '');
    switch (name.toLowerCase()) {
      case 'home_url': case 'site_url': case 'network_home_url': return this.homeUrl(a(0));
      case 'get_template_directory_uri': case 'get_stylesheet_directory_uri': return this.root;
      case 'get_stylesheet_uri': return this.root + '/style.css';
      case 'get_theme_file_uri': case 'get_parent_theme_file_uri': return this.root + '/' + a(0).replace(/^\/+/, '');
      case 'get_template_directory': case 'get_stylesheet_directory': return '';
      case 'get_bloginfo': return this.bloginfo(a(0));
      case 'get_option': return a(0) === 'blogname' ? esc(this.ctx.siteName) : a(0) === 'blogdescription' ? esc(this.ctx.tagline) : '';
      case 'get_the_title': case 'single_post_title': return this.ctx.markers ? MARK_TITLE : esc(this.item.title);
      case 'get_the_content': return this.content();
      case 'get_the_excerpt': return esc(this.item.excerpt);
      case 'get_permalink': case 'get_the_permalink': return this.rel(this.item.path);
      case 'get_the_id': return String(this.item.id);
      case 'get_the_date': case 'get_the_time': case 'get_the_modified_date': return fmtDate(this.item.date);
      case 'get_the_author': case 'get_the_author_meta': return esc(this.item.author);
      case 'get_post_type': return this.item.kind;
      case 'get_theme_mod': return a(1);
      case 'wp_get_document_title': return `${this.ctx.markers ? MARK_TITLE : esc(this.item.title)} – ${esc(this.ctx.siteName)}`;
      case 'get_locale': case 'get_user_locale': return 'en_US';
      case 'get_search_query': case 'admin_url': case 'wp_create_nonce': case 'get_header_image': case 'get_post_format': case 'get_site_icon_url': case 'get_avatar': case 'get_the_post_thumbnail': case 'get_the_post_thumbnail_url': case 'wp_get_attachment_image': case 'wp_get_attachment_image_url': case 'get_custom_logo': case 'get_the_tag_list': case 'get_previous_post_link': case 'get_next_post_link': case 'get_post_meta': case 'wp_login_url': case 'wp_logout_url': case 'get_the_archive_description': case 'wp_unique_id': case 'get_comments_number_text': case 'wp_get_theme':
        return '';
      case 'get_comments_number': return '0';
      case 'get_the_category_list': return `<a href="${escAttr(this.rel('blog/index.html'))}">News</a>`;
      case 'get_the_archive_title': return 'Blog';
      case 'get_search_form': return this.call('get_search_form', args, ev);
      case 'wp_nav_menu': return this.menu(ev.array(args[0] || ''));
      case 'get_template_part': return this.call('get_template_part', args, ev);
    }
    const c = this.cond(name, args, ev);
    if (c !== undefined) return c ? '1' : '';
    return undefined;
  }

  cond(name: string, args: string[], ev: Evaluator): boolean | undefined {
    void ev; void args;
    const v = this.ctx.view;
    switch (name.toLowerCase()) {
      case 'have_posts': return this.loopIndex < this.ctx.items.length;
      case 'is_front_page': return v === 'front';
      case 'is_home': return v === 'list' || v === 'front';
      case 'is_page': return v === 'page' || v === 'front';
      case 'is_single': return v === 'single';
      case 'is_singular': return v === 'page' || v === 'front' || v === 'single';
      case 'is_archive': case 'is_category': case 'is_tag': case 'is_author': case 'is_date': case 'is_tax': return false;
      case 'is_search': return false;
      case 'is_404': return v === '404';
      case 'is_paged': case 'is_attachment': case 'is_sticky': case 'is_admin': case 'is_user_logged_in': case 'is_customize_preview': case 'wp_is_mobile': case 'is_active_sidebar': case 'has_custom_logo': case 'has_post_thumbnail': case 'comments_open': case 'get_comments_number': case 'post_password_required': case 'has_excerpt': case 'pings_open': case 'has_header_image': case 'get_header_image': case 'is_rtl': case 'has_tag': case 'is_page_template':
        return false;
      case 'has_nav_menu': case 'display_header_text': case 'function_exists': case 'is_main_query': case 'in_the_loop': case 'has_category': return true;
    }
    return undefined;
  }

  variable(expr: string): string | undefined {
    if (/^\$post->post_title\b/.test(expr)) return esc(this.item.title);
    if (/^\$post->ID\b/.test(expr)) return String(this.item.id);
    if (/^\$post->post_content\b/.test(expr)) return this.content();
    if (/^\$(wp_query|wp_the_query|post|wpdb)\b/.test(expr)) return '';
    return undefined;
  }

  loopCount(cond: string): number { void cond; this.loopIndex = 0; return this.ctx.items.length; }
  loopPass(i: number): void { this.loopIndex = i; this.ctx = { ...this.ctx, item: this.ctx.items[i] }; }
}

function finishWpHead(html: string, ctx: ThemeCtx): string {
  const needTitle = !/<title[\s>]/i.test(html);
  const title = needTitle ? `<title>${ctx.markers ? MARK_TITLE : esc(ctx.item.title)} – ${esc(ctx.siteName)}</title>` : '';
  let out = html.replace('<!--QL:wp_head-->', title);
  if (needTitle && !title) out = out.replace(/<\/head>/i, `${title}</head>`);
  return out.replace(/\n{3,}/g, '\n\n');
}

// ------------------------------------------------------------------------------------------
// Classic theme import

export function classicRenderer(files: Map<string, Uint8Array>, report: string[], php: PhpReport): ThemeRenderer {
  const enq = findEnqueues(files);
  return {
    has: (k) => files.has(`${k}.php`),
    render: (k, ctx) => {
      const env = new WpEnv(ctx, files, php, enq);
      const out = renderPhp(textOf(files.get(`${k}.php`)), env, php);
      void report;
      return finishWpHead(out, ctx);
    },
  };
}

function copyAssets(site: Site, files: Map<string, Uint8Array>, skip: (p: string) => boolean): number {
  let n = 0;
  for (const [p, v] of files) {
    if (skip(p) || isPhp(p)) continue;
    site.write(p, v, { silent: true });
    n++;
  }
  return n;
}

function phpSummary(php: PhpReport, report: string[]): void {
  if (php.dropped.length) report.push(`PHP with no static meaning was left out (kept in _theme-source/): ${summarize(php.dropped)}.`);
  if (php.assumed.length) report.push(`Conditions that could not be judged statically were taken as true: ${summarize(php.assumed, 12)}.`);
}

export function importWordPressTheme(name: string, files: Map<string, Uint8Array>): { site: Site; report: string[]; open?: string } {
  const report: string[] = [];
  const block = isBlockTheme(files);
  const hdr = themeHeader(textOf(files.get('style.css')));
  const siteName = hdr['theme name'] || name;
  const site = new Site(siteName);
  site.data.meta.description = hdr.description || '';
  report.push(`${block ? 'Block' : 'Classic'} WordPress theme "${siteName}"${hdr.version ? ` ${hdr.version}` : ''}${hdr.author ? ` by ${hdr.author}` : ''}.`);
  if (hdr.template) report.push(`This is a child theme of "${hdr.template}". Templates it inherits from the parent are not in this archive; import the parent theme for the full design.`);
  if (hdr.license) report.push(`License: ${hdr.license}. WordPress themes in the official directory are GPL; check the license of themes bought elsewhere.`);
  const php: PhpReport = { dropped: [], assumed: [] };
  const renderer = block ? blockRenderer(files, report, php, siteName) : classicRenderer(files, report, php);
  const tagline = hdr.description ? hdr.description.split(/[.!?]/)[0].slice(0, 90) : 'Just another site';
  if (block) site.write('wp-theme.css', themeJsonCss(textOf(files.get('theme.json')), report), { silent: true });
  const made = assembleThemeSite(site, renderer, { siteName, tagline, report });
  const n = copyAssets(site, files, (p) => p === 'theme.json' || /^(templates|parts|block-templates|block-template-parts|patterns|languages)\//.test(p) || /\.(pot?|mo|md|txt)$/i.test(p) && !/^(assets|css|js|fonts|images|img)\//.test(p));
  keepSource(site, files);
  report.push(`Made ${made.length} files: ${made.join(', ')}.`);
  report.push(`Copied ${n} asset files (style sheets, scripts, pictures, fonts); the original theme is in _theme-source/ and is not published.`);
  report.push('Edit page content in each page; edit the header, menu and footer once in Templates/page.dwt and every attached page follows.');
  phpSummary(php, report);
  return { site, report, open: 'index.html' };
}

// ------------------------------------------------------------------------------------------
// Block themes

function patternFiles(files: Map<string, Uint8Array>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [p, v] of files) {
    if (!/^patterns\/[^/]+\.(php|html)$/.test(p)) continue;
    const t = textOf(v);
    const slug = /Slug:\s*([\w/-]+)/.exec(t)?.[1];
    if (slug) map.set(slug, p);
  }
  return map;
}

export function blockRenderer(files: Map<string, Uint8Array>, report: string[], php: PhpReport, siteName: string): ThemeRenderer {
  void siteName;
  const tplDir = [...files.keys()].some((k) => k.startsWith('templates/')) ? 'templates' : 'block-templates';
  const partDir = [...files.keys()].some((k) => k.startsWith('parts/')) ? 'parts' : 'block-template-parts';
  const patterns = patternFiles(files);
  const dropped: string[] = [];
  return {
    has: (k) => files.has(`${tplDir}/${k}.html`),
    render: (k, ctx0) => {
      let ctx = ctx0;
      const rel = (p: string) => relativeRef(ctx.file, p);
      const title = () => (ctx.markers ? MARK_TITLE : esc(ctx.item.title));
      const depth = { n: 0 };
      const renderMarkup = (markup: string): string => blocksToHtml(markup, { render, dropped });
      const navItems = (items: MenuItem[]) => items.map((m) => `<li class="wp-block-navigation-item${m.path === ctx.file ? ' current-menu-item' : ''}"><a class="wp-block-navigation-item__content" href="${escAttr(m.path ? rel(m.path) : m.url || '#')}">${esc(m.label)}</a></li>`).join('');
      const render = (b: Block, inner: () => string): string | undefined => {
        const at = b.attrs;
        const short = b.name.replace(/^core\//, '');
        switch (b.name) {
          case 'core/template-part': {
            const f = `${partDir}/${at.slug}.html`;
            if (!files.has(f) || depth.n > 6) { dropped.push(`template part ${at.slug}`); return ''; }
            depth.n++;
            const body = renderMarkup(textOf(files.get(f)));
            depth.n--;
            const tag = at.tagName || (at.slug === 'header' ? 'header' : at.slug === 'footer' ? 'footer' : 'div');
            return `<${tag} class="wp-block-template-part${at.className ? ' ' + escAttr(at.className) : ''}">${body}</${tag}>`;
          }
          case 'core/pattern': {
            const f = patterns.get(at.slug);
            if (!f || depth.n > 6) { dropped.push(`pattern ${at.slug}`); return ''; }
            depth.n++;
            const env = new WpEnv(ctx, files, php, []);
            const markup = renderPhp(textOf(files.get(f)).replace(/^\s*<\?php\s*\/\*\*[\s\S]*?\*\/\s*\?>/, ''), env, php);
            const body = renderMarkup(markup);
            depth.n--;
            return body;
          }
          case 'core/post-content': return `<div class="entry-content wp-block-post-content${at.layout ? ' is-layout-constrained' : ''}">${ctx.markers ? MARK_CONTENT : ctx.item.content}</div>`;
          case 'core/post-title': {
            const lv = at.level === 0 ? 'p' : `h${at.level || 2}`;
            const t = at.isLink ? `<a href="${escAttr(rel(ctx.item.path))}">${title()}</a>` : title();
            return `<${lv} class="wp-block-post-title${at.textAlign ? ' has-text-align-' + at.textAlign : ''}">${t}</${lv}>`;
          }
          case 'core/site-title': {
            const lv = at.level === 0 ? 'p' : `h${at.level ?? 1}`;
            return `<${lv} class="wp-block-site-title"><a href="${escAttr(rel('index.html'))}">${esc(ctx.siteName)}</a></${lv}>`;
          }
          case 'core/site-tagline': return `<p class="wp-block-site-tagline">${esc(ctx.tagline)}</p>`;
          case 'core/site-logo': return '';
          case 'core/navigation': {
            const own = inner().trim();
            const list = own && /<li/i.test(own) ? own : navItems(ctx.menu);
            return addClassToFirstTag(`<nav class="wp-block-navigation is-layout-flex${at.className ? ' ' + escAttr(at.className) : ''}" aria-label="Main"><ul class="wp-block-navigation__container">${list}</ul></nav>`, at.layout?.justifyContent ? `is-content-justification-${at.layout.justifyContent}` : '');
          }
          case 'core/navigation-link': case 'core/navigation-submenu': {
            const url = String(at.url || '#');
            const hit = ctx.menu.find((m) => m.label.toLowerCase() === String(at.label || '').toLowerCase());
            const href = hit?.path ? rel(hit.path) : /^\//.test(url) ? ctx.root + url : url;
            const sub = b.name === 'core/navigation-submenu' ? `<ul class="wp-block-navigation__submenu-container">${inner()}</ul>` : '';
            return `<li class="wp-block-navigation-item"><a class="wp-block-navigation-item__content" href="${escAttr(href)}">${at.label || ''}</a>${sub}</li>`;
          }
          case 'core/page-list': return navItems(ctx.menu);
          case 'core/home-link': return `<li class="wp-block-navigation-item"><a class="wp-block-navigation-item__content" href="${escAttr(rel('index.html'))}">${esc(at.label || 'Home')}</a></li>`;
          case 'core/query': return `<div class="wp-block-query${at.className ? ' ' + escAttr(at.className) : ''}">${inner()}</div>`;
          case 'core/post-template': {
            const items = ctx.view === 'list' ? ctx.items : ctx.items.filter((x) => x.kind === 'post').length ? ctx.items.filter((x) => x.kind === 'post') : [];
            const saved = ctx;
            const out = items.map((it) => { ctx = { ...saved, item: it, markers: false }; return `<li class="wp-block-post post-${it.id}">${inner()}</li>`; }).join('');
            ctx = saved;
            return `<ul class="wp-block-post-template${at.layout?.type === 'grid' ? ' is-layout-grid' : ''}">${out}</ul>`;
          }
          case 'core/post-excerpt': return `<div class="wp-block-post-excerpt"><p class="wp-block-post-excerpt__excerpt">${esc(ctx.item.excerpt)}</p></div>`;
          case 'core/post-date': return `<div class="wp-block-post-date"><time>${fmtDate(ctx.item.date)}</time></div>`;
          case 'core/post-author': case 'core/post-author-name': return `<div class="wp-block-${short}">${esc(ctx.item.author)}</div>`;
          case 'core/post-terms': return `<div class="wp-block-post-terms"><a href="${escAttr(rel('blog/index.html'))}">News</a></div>`;
          case 'core/query-title': return `<h1 class="wp-block-query-title">Blog</h1>`;
          case 'core/read-more': return `<a class="wp-block-read-more" href="${escAttr(rel(ctx.item.path))}">${esc(at.content || 'Read more')}</a>`;
          case 'core/search': return `<form role="search" class="wp-block-search" action="#"><label class="wp-block-search__label" for="ql-search">${esc(at.label || 'Search')}</label><div class="wp-block-search__inside-wrapper"><input class="wp-block-search__input" id="ql-search" type="search" name="s" placeholder="${escAttr(at.placeholder || '')}"><button class="wp-block-search__button" type="submit">${esc(at.buttonText || 'Search')}</button></div></form>`;
          case 'core/latest-posts': case 'core/archives': return `<ul class="wp-block-${short}"><li><a href="${escAttr(rel('blog/hello-world.html'))}">Hello world</a></li><li><a href="${escAttr(rel('blog/a-second-post.html'))}">A second post</a></li></ul>`;
          case 'core/categories': return `<ul class="wp-block-categories"><li><a href="${escAttr(rel('blog/index.html'))}">News</a></li></ul>`;
          case 'core/social-links': return `<ul class="wp-block-social-links is-layout-flex">${inner().replace(/^\s*<ul[^>]*>|<\/ul>\s*$/g, '')}</ul>`;
          case 'core/query-pagination': case 'core/query-pagination-next': case 'core/query-pagination-previous': case 'core/query-pagination-numbers': case 'core/query-no-results': case 'core/post-featured-image': case 'core/post-navigation-link': case 'core/comments': case 'core/comments-query-loop': case 'core/post-comments-form': case 'core/comment-template': case 'core/loginout': case 'core/avatar': case 'core/term-description': case 'core/post-comments-count': case 'core/comments-title':
            if (!/pagination|featured|navigation-link/.test(b.name)) dropped.push(short);
            return '';
          case 'core/block': dropped.push('reusable block'); return '';
        }
        return undefined;
      };
      const markup = textOf(files.get(`${tplDir}/${k}.html`));
      const body = renderMarkup(markup);
      if (dropped.length) { report.push(`Block-theme parts that need WordPress were left out: ${summarize(dropped)}.`); dropped.length = 0; }
      const root = ctx.root;
      const titleText = ctx.markers ? MARK_TITLE : esc(ctx.item.title);
      const fonts = [...files.keys()].some((f) => /\.woff2?$/.test(f));
      void fonts;
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${titleText} – ${esc(ctx.siteName)}</title>
  <link rel="stylesheet" href="${root}/wp-theme.css">
  <link rel="stylesheet" href="${root}/style.css">
</head>
<body class="${ctx.view === 'list' ? 'blog' : ctx.view === 'single' ? 'single' : 'page'}">
<div class="wp-site-blocks">
${body}
</div>
</body>
</html>
`;
    },
  };
}

/** CSS for a block theme's theme.json: presets as custom properties and classes, global styles, element styles. */
export function themeJsonCss(json: string, report: string[] = []): string {
  let tj: any = {};
  try { tj = JSON.parse(json || '{}'); } catch { report.push('theme.json could not be read.'); }
  const S = tj.settings || {};
  const vars: string[] = [];
  const rules: string[] = [];
  const val = (v: any): string => {
    if (v == null) return '';
    if (typeof v === 'object') return '';
    const s = String(v);
    const m = /^var:(preset|custom)\|(.+)$/.exec(s);
    if (m) return m[1] === 'preset' ? `var(--wp--preset--${m[2].split('|').join('--')})` : `var(--wp--custom--${m[2].split('|').join('--')})`;
    return s;
  };
  for (const c of S.color?.palette?.theme || S.color?.palette || []) {
    if (!c?.slug) continue;
    vars.push(`--wp--preset--color--${c.slug}: ${c.color};`);
    rules.push(`.has-${c.slug}-color { color: var(--wp--preset--color--${c.slug}) !important; }`, `.has-${c.slug}-background-color { background-color: var(--wp--preset--color--${c.slug}) !important; }`, `.has-${c.slug}-border-color { border-color: var(--wp--preset--color--${c.slug}) !important; }`);
  }
  for (const g of S.color?.gradients?.theme || S.color?.gradients || []) if (g?.slug) { vars.push(`--wp--preset--gradient--${g.slug}: ${g.gradient};`); rules.push(`.has-${g.slug}-gradient-background { background: var(--wp--preset--gradient--${g.slug}) !important; }`); }
  for (const f of S.typography?.fontSizes?.theme || S.typography?.fontSizes || []) {
    if (!f?.slug) continue;
    const size = typeof f.fluid === 'object' && f.fluid?.min && f.fluid?.max ? `clamp(${f.fluid.min}, ${f.fluid.min} + ((1vw - 0.2rem) * 0.8), ${f.fluid.max})` : f.size;
    vars.push(`--wp--preset--font-size--${f.slug}: ${size};`);
    rules.push(`.has-${f.slug}-font-size { font-size: var(--wp--preset--font-size--${f.slug}) !important; }`);
  }
  const faces: string[] = [];
  for (const f of S.typography?.fontFamilies?.theme || S.typography?.fontFamilies || []) {
    if (!f?.slug) continue;
    vars.push(`--wp--preset--font-family--${f.slug}: ${f.fontFamily};`);
    rules.push(`.has-${f.slug}-font-family { font-family: var(--wp--preset--font-family--${f.slug}) !important; }`);
    for (const ff of f.fontFace || []) {
      const srcs = (Array.isArray(ff.src) ? ff.src : [ff.src]).filter(Boolean).map((s: string) => `url("${s.replace(/^file:\.\//, '')}")`);
      if (srcs.length) faces.push(`@font-face { font-family: ${ff.fontFamily}; font-style: ${ff.fontStyle || 'normal'}; font-weight: ${ff.fontWeight || '400'}; font-display: ${ff.fontDisplay || 'swap'}; src: ${srcs.join(', ')}; }`);
    }
  }
  for (const sp of S.spacing?.spacingSizes?.theme || S.spacing?.spacingSizes || []) if (sp?.slug) vars.push(`--wp--preset--spacing--${sp.slug}: ${sp.size};`);
  for (const sh of S.shadow?.presets || []) if (sh?.slug) vars.push(`--wp--preset--shadow--${sh.slug}: ${sh.shadow};`);
  const custom = (o: any, path: string[]) => { for (const [k, v] of Object.entries(o || {})) { const kk = k.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(); if (v && typeof v === 'object') custom(v, [...path, kk]); else vars.push(`--wp--custom--${[...path, kk].join('--')}: ${v};`); } };
  custom(S.custom, []);
  const content = S.layout?.contentSize || '720px';
  const wide = S.layout?.wideSize || '1200px';
  vars.push(`--wp--style--global--content-size: ${content};`, `--wp--style--global--wide-size: ${wide};`);
  const decl = (st: any): string => {
    if (!st) return '';
    const d: string[] = [];
    const add = (p: string, v: any) => { const x = val(v); if (x) d.push(`${p}: ${x};`); };
    add('color', st.color?.text); add('background-color', st.color?.background); add('background', st.color?.gradient);
    add('font-family', st.typography?.fontFamily); add('font-size', st.typography?.fontSize); add('font-weight', st.typography?.fontWeight);
    add('line-height', st.typography?.lineHeight); add('letter-spacing', st.typography?.letterSpacing); add('text-transform', st.typography?.textTransform); add('text-decoration', st.typography?.textDecoration); add('font-style', st.typography?.fontStyle);
    for (const side of ['top', 'right', 'bottom', 'left']) { add(`padding-${side}`, st.spacing?.padding?.[side]); add(`margin-${side}`, st.spacing?.margin?.[side]); }
    if (typeof st.spacing?.padding === 'string') add('padding', st.spacing.padding);
    add('border-radius', st.border?.radius); add('border-color', st.border?.color); add('border-width', st.border?.width); add('border-style', st.border?.style);
    add('box-shadow', st.shadow);
    return d.join(' ');
  };
  const st = tj.styles || {};
  const out: string[] = [`/* Generated from the theme's theme.json */`, ...faces, `:root { ${vars.join(' ')} }`];
  const bodyDecl = decl(st);
  out.push(`body { margin: 0; ${bodyDecl} }`);
  if (st.spacing?.blockGap) out.push(`:root { --wp--style--block-gap: ${val(st.spacing.blockGap)}; }`);
  const el = st.elements || {};
  const elSel: Record<string, string> = { link: 'a', heading: 'h1, h2, h3, h4, h5, h6', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6', button: '.wp-element-button, .wp-block-button__link', caption: '.wp-element-caption, figcaption', cite: 'cite' };
  for (const [k, sel] of Object.entries(elSel)) {
    if (!el[k]) continue;
    const d = decl(el[k]);
    if (d) out.push(`${sel} { ${d} }`);
    const hov = decl(el[k][':hover']);
    if (hov) out.push(sel.split(', ').map((s) => s + ':hover').join(', ') + ` { ${hov} }`);
  }
  for (const [name, bs] of Object.entries<any>(st.blocks || {})) {
    const cls = '.wp-block-' + name.replace(/^core\//, '').replace('/', '-');
    const d = decl(bs);
    if (d) out.push(`${cls} { ${d} }`);
    for (const [k, sel] of Object.entries(elSel)) if (bs?.elements?.[k]) { const dd = decl(bs.elements[k]); if (dd) out.push(sel.split(', ').map((s) => `${cls} ${s}`).join(', ') + ` { ${dd} }`); }
  }
  if (typeof st.css === 'string') out.push(st.css);
  out.push(BLOCK_BASE_CSS);
  out.push(...rules);
  return out.join('\n') + '\n';
}

/** Layout rules for core blocks (an original minimal set). */
export const BLOCK_BASE_CSS = `
.wp-site-blocks > * + * { margin-block-start: var(--wp--style--block-gap, 1.5rem); }
.is-layout-constrained > :where(:not(.alignleft):not(.alignright):not(.alignfull)) { max-width: var(--wp--style--global--content-size); margin-left: auto !important; margin-right: auto !important; }
.is-layout-constrained > .alignwide { max-width: var(--wp--style--global--wide-size); }
.is-layout-flex { display: flex; flex-wrap: wrap; align-items: center; gap: var(--wp--style--block-gap, 0.5em); }
.is-layout-flex.is-vertical { flex-direction: column; align-items: flex-start; }
.is-layout-flex.is-nowrap { flex-wrap: nowrap; }
.is-content-justification-center { justify-content: center; }
.is-content-justification-right { justify-content: flex-end; }
.is-content-justification-space-between { justify-content: space-between; }
.is-layout-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(12rem, 100%), 1fr)); gap: var(--wp--style--block-gap, 1.5rem); }
.wp-block-columns { display: flex; flex-wrap: wrap; gap: 2em; }
.wp-block-column { flex: 1 1 0; min-width: 0; }
@media (max-width: 781px) { .wp-block-columns { flex-direction: column; } }
.wp-block-buttons { display: flex; flex-wrap: wrap; gap: .5em; }
.wp-block-button__link { display: inline-block; padding: .6em 1.2em; border-radius: 4px; background: currentColor; text-decoration: none; }
.wp-block-button__link { background: var(--wp--preset--color--contrast, #222); color: var(--wp--preset--color--base, #fff); }
.wp-block-image img { max-width: 100%; height: auto; }
.wp-block-image.aligncenter, .aligncenter { text-align: center; margin-left: auto; margin-right: auto; }
.alignfull { width: 100%; }
.alignleft { float: left; margin-right: 1.5em; }
.alignright { float: right; margin-left: 1.5em; }
.wp-block-navigation ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 1.25em; }
.wp-block-navigation a { text-decoration: none; color: inherit; }
.wp-block-post-template, .wp-block-latest-posts, .wp-block-social-links { list-style: none; padding: 0; }
.wp-block-social-links { display: flex; gap: .75em; }
.wp-block-separator { border: none; border-top: 1px solid currentColor; opacity: .4; }
.wp-block-quote { border-left: 3px solid currentColor; padding-left: 1em; margin-left: 0; }
.wp-block-search__inside-wrapper { display: flex; gap: .5em; }
.wp-block-cover { position: relative; display: flex; align-items: center; justify-content: center; min-height: 430px; padding: 1em; overflow: hidden; }
.wp-block-cover__image-background, .wp-block-cover__video-background { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.wp-block-cover__background { position: absolute; inset: 0; }
.wp-block-cover__inner-container { position: relative; width: 100%; }
.has-text-align-center { text-align: center; }
.has-text-align-right { text-align: right; }
.screen-reader-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(1px, 1px, 1px, 1px); }
`;

// ------------------------------------------------------------------------------------------
// Export: classic theme from the site's design

export interface ThemeExportOptions {
  pagePath?: string;
  name?: string;
  author?: string;
  description?: string;
  version?: string;
  /** Screenshot (PNG bytes, ideally 1200×900). */
  screenshot?: Uint8Array;
  report?: string[];
}

function phpSlug(s: string): string { return slugify(s).replace(/-/g, '_').replace(/^(\d)/, '_$1') || 'theme'; }

/** The pages, styles and scripts in the site that a theme can use. */
function exportable(site: Site): string[] {
  return site.list((f) => !f.noPublish && !/^(Templates|Library|_[^/]*)\//.test(f.path) && !/\.(dwt|lbi)$/i.test(f.path)).map((f) => f.path);
}

export async function exportWordPressTheme(site: Site, opts: ThemeExportOptions = {}): Promise<Blob> {
  const files = exportWordPressThemeFiles(site, opts);
  return zipFiles(files);
}

/** The theme's files keyed by path inside the ZIP (all under "<slug>/"). */
export function exportWordPressThemeFiles(site: Site, opts: ThemeExportOptions = {}): Map<string, string | Uint8Array> {
  const report = opts.report || [];
  const name = opts.name || site.name || 'My Theme';
  const slug = slugify(name);
  const fn = phpSlug(name);
  const pagePath = opts.pagePath || site.homePage;
  let src = site.read(pagePath) || '';
  src = expandIncludes(site, pagePath, src);
  const parts = splitMain(src);
  const avail = new Set(exportable(site));
  const assetPath = (p: string) => 'assets/' + p;
  const pages = site.pages().filter((f) => avail.has(f.path) && !/\.(php)$/.test(f.path)).map((f) => f.path);
  const permalink = (p: string): string => {
    if (p === site.homePage) return '/';
    const s = stripExt(baseName(p)) === 'index' ? dirOf(p) : stripExt(p);
    return '/' + s.split('/').map(slugify).join('/') + '/';
  };
  const themeUri = (p: string) => `<?php echo esc_url( get_template_directory_uri() ); ?>/${assetPath(p)}`;
  // Links in header/footer: assets to the theme folder, pages to permalinks.
  const relink = (html: string) => rewriteRefs(detachTemplate(html), pagePath, (target) => {
    if (isPagePath(target)) return `<?php echo esc_url( home_url( '${permalink(target)}' ) ); ?>`;
    return avail.has(target) ? themeUri(target) : null;
  });
  const styles: string[] = [];
  const scripts: string[] = [];
  let head = parts.head
    .replace(/<title[^>]*>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+charset[^>]*>\s*/i, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']content-type["'][^>]*>\s*/i, '');
  head = head.replace(/[ \t]*<link\b[^>]*>\s*/gi, (tag) => {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const t = href ? resolveRef(pagePath, href) : null;
    if (t && /stylesheet/i.test(tag) && avail.has(t)) { styles.push(t); return ''; }
    return tag;
  });
  const takeScripts = (html: string, footer: boolean) => html.replace(/[ \t]*<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>\s*/gi, (tag, s: string) => {
    const t = resolveRef(pagePath, s);
    if (t && avail.has(t)) { scripts.push(`${t}|${footer ? 1 : 0}`); return ''; }
    return tag;
  });
  head = takeScripts(head, false);
  let before = takeScripts(parts.before, true);
  let after = takeScripts(parts.after, true);
  head = relink(head.replace(/<!--\s*#?(BeginEditable|EndEditable|TemplateBeginEditable|TemplateEndEditable|InstanceBeginEditable|InstanceEndEditable)[^>]*-->/gi, ''));
  before = relink(before);
  after = relink(after);
  // The site name becomes bloginfo('name'); the first menu becomes a WordPress menu location.
  const siteTitleRe = new RegExp(`(>\\s*)${site.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*<)`);
  if (site.name && siteTitleRe.test(before)) before = before.replace(siteTitleRe, `$1<?php bloginfo( 'name' ); ?>$2`);
  const nav = /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(before);
  if (nav) {
    const ul = /<ul\b([^>]*)>[\s\S]*<\/ul>/i.exec(nav[1]);
    if (ul) {
      const cls = /class\s*=\s*["']([^"']*)["']/i.exec(ul[1])?.[1] || 'menu';
      const id = /id\s*=\s*["']([^"']*)["']/i.exec(ul[1])?.[1];
      const call = `<?php\n\twp_nav_menu( array(\n\t\t'theme_location' => 'primary',\n\t\t'container'      => false,\n\t\t'menu_class'     => '${cls.replace(/'/g, '')}',${id ? `\n\t\t'menu_id'        => '${id.replace(/'/g, '')}',` : ''}\n\t\t'fallback_cb'    => '${fn}_fallback_menu',\n\t) );\n\t?>`;
      const navInner = nav[1].replace(ul[0], call);
      before = before.replace(nav[1], navInner);
      report.push('The first menu became the "Primary Menu" location (Appearance ▸ Menus); until a menu is assigned, the pages are listed.');
    }
  } else report.push('No <nav> was found before the main content, so the header has no menu location.');
  if (parts.how === 'body') report.push('No main content area (an editable region named content/body, a <main> element or #content) was found, so the whole body became page content and header.php/footer.php are minimal.');
  const bodyAttrs = /<body\b([^>]*)>/i.exec(parts.bodyTag)?.[1] || '';
  const bodyCls = /class\s*=\s*["']([^"']*)["']/i.exec(bodyAttrs)?.[1];
  const ver = opts.version || '1.0.0';

  const out = new Map<string, string | Uint8Array>();
  const put = (p: string, v: string | Uint8Array) => out.set(`${slug}/${p}`, v);
  put('style.css', `/*
Theme Name: ${name}
Author: ${opts.author || ''}
Description: ${opts.description || `A classic theme made from the design of ${name}.`}
Version: ${ver}
Requires at least: 5.9
Tested up to: 6.6
Requires PHP: 7.4
License: GNU General Public License v2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html
Text Domain: ${slug}
*/

/* The design's own style sheets are in assets/ and loaded by functions.php. These are the classes WordPress content uses. */
.alignleft { float: left; margin: 0 1.5em 1em 0; }
.alignright { float: right; margin: 0 0 1em 1.5em; }
.aligncenter { display: block; margin-left: auto; margin-right: auto; }
.wp-caption { max-width: 100%; }
.wp-caption-text, .gallery-caption { font-size: .9em; }
.sticky, .bypostauthor { }
.screen-reader-text { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(1px, 1px, 1px, 1px); }
.wp-block-image img { max-width: 100%; height: auto; }
.entry-content img { max-width: 100%; height: auto; }
`);
  const enqStyles = styles.map((s, i) => `\twp_enqueue_style( '${slug}-${i + 1}', get_template_directory_uri() . '/${assetPath(s)}', array(), '${ver}' );`).join('\n');
  const enqScripts = scripts.map((x, i) => { const [s, f] = x.split('|'); return `\twp_enqueue_script( '${slug}-script-${i + 1}', get_template_directory_uri() . '/${assetPath(s)}', array(), '${ver}', ${f === '1' ? 'true' : 'false'} );`; }).join('\n');
  put('functions.php', `<?php
/**
 * ${name} theme functions.
 *
 * @package ${fn}
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function ${fn}_setup() {
	add_theme_support( 'title-tag' );
	add_theme_support( 'post-thumbnails' );
	add_theme_support( 'automatic-feed-links' );
	add_theme_support( 'html5', array( 'search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script' ) );
	add_theme_support( 'responsive-embeds' );
	register_nav_menus( array( 'primary' => __( 'Primary Menu', '${slug}' ) ) );
}
add_action( 'after_setup_theme', '${fn}_setup' );

function ${fn}_assets() {
	wp_enqueue_style( '${slug}-style', get_stylesheet_uri(), array(), '${ver}' );
${enqStyles}
${enqScripts}
}
add_action( 'wp_enqueue_scripts', '${fn}_assets' );

/** Lists the pages when no menu is assigned to the Primary Menu location. */
function ${fn}_fallback_menu( $args ) {
	echo '<ul class="' . esc_attr( $args['menu_class'] ) . '">';
	wp_list_pages( array( 'title_li' => '', 'depth' => 1 ) );
	echo '</ul>';
}
`);
  put('header.php', `<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
${head.trim()}
<?php wp_head(); ?>
</head>
<body <?php body_class(${bodyCls ? ` '${bodyCls.replace(/'/g, '')}' ` : ''}); ?>>
<?php wp_body_open(); ?>
${before.trim()}
`);
  put('footer.php', `${after.trim()}
<?php wp_footer(); ?>
</body>
</html>
`);
  put('index.php', `<?php
/**
 * The main template: the blog and any listing without a more specific template.
 *
 * @package ${fn}
 */
get_header();
?>
<?php if ( have_posts() ) : ?>
	<?php if ( is_home() && ! is_front_page() ) : ?>
		<h1 class="page-title"><?php single_post_title(); ?></h1>
	<?php endif; ?>
	<?php while ( have_posts() ) : the_post(); ?>
		<article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
			<?php the_title( '<h2 class="entry-title"><a href="' . esc_url( get_permalink() ) . '">', '</a></h2>' ); ?>
			<p class="entry-meta"><?php echo esc_html( get_the_date() ); ?></p>
			<div class="entry-summary"><?php the_excerpt(); ?></div>
		</article>
	<?php endwhile; ?>
	<?php the_posts_navigation(); ?>
<?php else : ?>
	<p><?php esc_html_e( 'Nothing has been published yet.', '${slug}' ); ?></p>
<?php endif; ?>
<?php
get_footer();
`);
  put('page.php', `<?php
/**
 * A single page.
 *
 * @package ${fn}
 */
get_header();
while ( have_posts() ) :
	the_post();
	?>
	<article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
		<?php the_title( '<h1 class="entry-title">', '</h1>' ); ?>
		<div class="entry-content">
			<?php the_content(); ?>
		</div>
	</article>
	<?php
endwhile;
get_footer();
`);
  put('single.php', `<?php
/**
 * A single post.
 *
 * @package ${fn}
 */
get_header();
while ( have_posts() ) :
	the_post();
	?>
	<article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
		<?php the_title( '<h1 class="entry-title">', '</h1>' ); ?>
		<p class="entry-meta"><?php echo esc_html( get_the_date() ); ?> · <?php the_author(); ?></p>
		<div class="entry-content">
			<?php the_content(); ?>
		</div>
	</article>
	<?php
	the_post_navigation();
	if ( comments_open() || get_comments_number() ) {
		comments_template();
	}
endwhile;
get_footer();
`);
  put('404.php', `<?php
/**
 * Page not found.
 *
 * @package ${fn}
 */
get_header();
?>
<h1 class="page-title"><?php esc_html_e( 'Page not found', '${slug}' ); ?></h1>
<p><?php esc_html_e( 'The page you are looking for is not here. Try a search:', '${slug}' ); ?></p>
<?php get_search_form(); ?>
<?php
get_footer();
`);
  put('readme.txt', `=== ${name} ===
Requires at least: 5.9
Tested up to: 6.6
Requires PHP: 7.4
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A classic theme made with a web site editor from the design of "${name}".

== Installation ==
In WordPress, go to Appearance > Themes > Add New > Upload Theme and choose this ZIP file.
Then assign a menu to the "Primary Menu" location in Appearance > Menus.

== Copyright ==
Themes in the WordPress.org directory must be GPL-compatible (GPL-2.0-or-later). Make sure every
picture, font and script in assets/ may be distributed under compatible terms.
`);
  for (const p of avail) {
    if (isPagePath(p)) continue;
    const f = site.get(p)!;
    put(assetPath(p), f.data ?? f.text ?? '');
  }
  if (opts.screenshot) put('screenshot.png', opts.screenshot);
  report.push(`Theme "${name}" (folder ${slug}/): header.php and footer.php from ${pagePath}, ${styles.length} style sheet(s) and ${scripts.length} script(s) enqueued, ${[...avail].filter((p) => !isPagePath(p)).length} asset files.`);
  report.push('Upload it in WordPress under Appearance ▸ Themes ▸ Add New ▸ Upload Theme. Page content is not part of a theme: use the WordPress export or Publish to WordPress for that.');
  report.push('The WordPress.org theme directory requires a GPL-2.0-or-later license and its review rules; this theme declares that license.');
  void getTitle; void regions; void joinPath; void bytesOf;
  return out;
}

/** A simple 1200×900 screenshot with the theme name, where a canvas is available. */
export async function makeScreenshot(name: string, colors: { bg?: string; fg?: string } = {}): Promise<Uint8Array | undefined> {
  try {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 900;
    const g = c.getContext('2d');
    if (!g) return undefined;
    g.fillStyle = colors.bg || '#f4f1ea'; g.fillRect(0, 0, 1200, 900);
    g.fillStyle = colors.fg || '#1f2328';
    g.font = 'bold 72px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(name.slice(0, 28), 600, 450);
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  } catch { return undefined; }
}
