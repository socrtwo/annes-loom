/**
 * Weebly themes and site archives.
 *
 * A custom Weebly theme is a set of HTML files, one per header type (index.html, no-header.html,
 * splash.html, landing.html…), that place Weebly's content with curly-brace tags such as {title}, {menu},
 * {logo}, {content} and {footer}; editable elements are written {name:type} ({phone:text}, {cta:button}).
 * Styles are in main.less or main.css (often under styles/), scripts in custom.js, pictures in assets/,
 * which pages and styles reach as /files/theme/<name>.
 *
 * Import turns each header type into a page with the tags replaced by sample content; export writes such a
 * theme from a page of the site. A Weebly site archive (the ZIP of a published site) is plain HTML.
 */
import { Site } from '../model/site';
import { esc, escAttr, getTitle, linkedStyles, regions } from '../model/html';
import { baseName, dirOf, extOf, isPagePath, joinPath, relativeRef, resolveRef, slugify, stripExt } from '../model/paths';
import { rewriteRefs } from '../model/site';
import { detachTemplate, expandIncludes } from '../site/templates';
import { menuHtml, splitMain, summarize, textOf, keepSource, zipFiles, type MenuItem } from './common';

export const WEEBLY_TAGS: { tag: string; meaning: string; mapsTo: string }[] = [
  { tag: '{title}', meaning: 'Site title (or the page title in the <title> element)', mapsTo: 'The site name, linked to the home page' },
  { tag: '{logo}', meaning: 'Logo picture or site title, set in the editor', mapsTo: 'An element with class "logo" holding the site name' },
  { tag: '{menu}', meaning: 'Main navigation with the site\'s pages', mapsTo: 'A <ul class="menu"> list of the site pages' },
  { tag: '{content}', meaning: 'The page\'s drag-and-drop content area', mapsTo: 'The main content (an editable region in templates)' },
  { tag: '{footer}', meaning: 'Footer content area', mapsTo: 'The footer\'s inner markup' },
  { tag: '{header}', meaning: 'Header area (banner picture and headline) on header types that have one', mapsTo: 'A header block with a headline' },
  { tag: '{search}', meaning: 'Site search box', mapsTo: 'A search form (static)' },
  { tag: '{social}', meaning: 'Social media icons', mapsTo: 'A list of social links' },
  { tag: '{copyright}', meaning: 'Copyright line', mapsTo: '© year and site name' },
  { tag: '{name:text}', meaning: 'Editable text element, e.g. {phone:text global="true"}', mapsTo: 'A <span> with sample text' },
  { tag: '{name:button}', meaning: 'Editable button', mapsTo: 'A link styled as a button' },
  { tag: '{name:image}', meaning: 'Editable picture', mapsTo: 'An empty picture placeholder' },
  { tag: '{name:content}', meaning: 'Additional drag-and-drop area', mapsTo: 'A <div> with sample text' },
  { tag: '/files/theme/…', meaning: 'Address of a file in the theme\'s assets/ folder', mapsTo: 'Relative links to assets/' },
];

export function isWeeblyTheme(files: Map<string, Uint8Array>): string | null {
  for (const [p, v] of files) {
    if (!/\.html?$/i.test(p)) continue;
    const t = textOf(v);
    if (/\{content\}/.test(t) && /\{(menu|footer|title|logo)\}/.test(t)) return dirOf(p);
  }
  return null;
}

export function isWeeblyArchive(files: Map<string, Uint8Array>): boolean {
  const keys = [...files.keys()];
  if (keys.some((k) => /(^|\/)files\/theme\//.test(k)) && keys.some((k) => /\.html?$/.test(k))) return true;
  for (const k of keys.filter((x) => /\.html?$/i.test(x)).slice(0, 10)) {
    if (/editmysite\.com|weebly\.com|_W\.configDomain|wsite-/i.test(textOf(files.get(k)))) return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------
// LESS → CSS (variables, nesting with &, simple mixins); anything else is reported.

interface LessRule { sel: string; decls: string[]; kids: LessRule[]; at?: boolean }

export function lessToCss(less: string): { css: string; warnings: string[] } {
  const warnings: string[] = [];
  // Remove // comments outside strings and url().
  let s = less.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\))|\/\/[^\n]*/g, (m, keep) => keep ?? '');
  const vars = new Map<string, string>();
  const mixins = new Map<string, string[]>();
  let i = 0;
  const parseBlock = (): LessRule => {
    const r: LessRule = { sel: '', decls: [], kids: [] };
    let buf = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
      if (c === '"' || c === "'") { const q = c; let j = i + 1; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } buf += s.slice(i, j + 1); i = j + 1; continue; }
      if (c === '{' && s[i - 1] === '@') { const e = s.indexOf('}', i); buf += s.slice(i, e + 1); i = e + 1; continue; }
      if (c === '{') {
        i++;
        const kid = parseBlock();
        kid.sel = buf.trim();
        kid.at = kid.sel.startsWith('@');
        buf = '';
        r.kids.push(kid);
        continue;
      }
      if (c === '}') { i++; if (buf.trim()) r.decls.push(buf.trim()); return r; }
      if (c === ';') {
        const d = buf.trim();
        buf = '';
        i++;
        if (d) r.decls.push(d);
        continue;
      }
      buf += c;
      i++;
    }
    if (buf.trim()) r.decls.push(buf.trim());
    return r;
  };
  const root = parseBlock();
  // Variables and mixins (only top-level ones are global).
  const collect = (r: LessRule) => {
    r.decls = r.decls.filter((d) => {
      const m = /^@([\w-]+)\s*:\s*([\s\S]+)$/.exec(d);
      if (m && !/^(import|media|charset|font-face|keyframes|supports)$/.test(m[1])) { vars.set(m[1], m[2].trim()); return false; }
      return true;
    });
  };
  collect(root);
  for (const k of root.kids) if (/^\.[\w-]+\s*(\(\s*\))?$/.test(k.sel)) mixins.set(k.sel.replace(/\s*\(\s*\)$/, ''), k.decls);
  const subst = (v: string, depth = 0): string => v.replace(/@\{?([\w-]+)\}?/g, (m, n) => (vars.has(n) && depth < 10 ? subst(vars.get(n)!, depth + 1) : m));
  const fnUsed = new Set<string>();
  const ops = new Set<string>();
  const decl = (d: string): string[] => {
    const mix = /^(\.[\w-]+)\s*(\(\s*\))?\s*(!important)?$/.exec(d);
    if (mix) { if (mixins.has(mix[1])) return mixins.get(mix[1])!.map((x) => subst(x)); warnings.push(`mixin ${mix[1]}`); return []; }
    if (/^\.[\w-]+\s*\(/.test(d)) { warnings.push(`parametric mixin ${d.split('(')[0]}`); return []; }
    let out = subst(d);
    for (const m of out.matchAll(/\b(darken|lighten|fade|fadein|fadeout|saturate|desaturate|spin|mix|tint|shade|percentage|e|escape|unit|ceil|floor|round)\(/g)) fnUsed.add(m[1]);
    if (/:\s*[^;]*\d\s*[*/+]\s*\d|\)\s*[*/]\s*\d/.test(out)) ops.add(out.split(':')[0]);
    out = out.replace(/~"([^"]*)"/g, '$1').replace(/~'([^']*)'/g, '$1');
    return [out];
  };
  const join = (parent: string, sel: string): string => {
    const ps = parent ? parent.split(',').map((x) => x.trim()) : [''];
    const ss = sel.split(',').map((x) => x.trim());
    const out: string[] = [];
    for (const p of ps) for (const c of ss) out.push(c.includes('&') ? c.replace(/&/g, p) : p ? `${p} ${c}` : c);
    return out.join(', ');
  };
  const out: string[] = [];
  const emit = (r: LessRule, parentSel: string, media: string[]) => {
    for (const k of r.kids) {
      const sel = subst(k.sel);
      if (/^\.[\w-]+\s*\(.*\)$/.test(k.sel) || (parentSel === '' && mixins.has(k.sel.replace(/\s*\(\s*\)$/, '')) && /\(\s*\)$/.test(k.sel))) continue;
      if (k.at) {
        if (/^@media/i.test(sel)) { emit(k, parentSel, [...media, sel]); if (k.decls.length && parentSel) push(parentSel, k.decls, [...media, sel]); continue; }
        // @font-face, @keyframes, @supports: copied as they are.
        const body = k.decls.map((d) => `  ${subst(d)};`).join('\n') + k.kids.map((kk) => `\n  ${subst(kk.sel)} { ${kk.decls.map((d) => subst(d) + ';').join(' ')} }`).join('');
        wrapMedia(`${sel} {\n${body}\n}`, media);
        continue;
      }
      const full = join(parentSel, sel);
      if (k.decls.length) push(full, k.decls, media);
      emit(k, full, media);
    }
  };
  const push = (sel: string, decls: string[], media: string[]) => {
    const lines = decls.flatMap(decl).filter(Boolean);
    if (!lines.length) return;
    wrapMedia(`${sel} {\n${lines.map((l) => `  ${l};`).join('\n')}\n}`, media);
  };
  const wrapMedia = (css: string, media: string[]) => {
    if (!media.length) { out.push(css); return; }
    out.push(`${media.join(' and ').replace(/\s+and\s+@media/g, ' and')} {\n${css.replace(/^/gm, '  ')}\n}`);
  };
  for (const d of root.decls) {
    if (/^@import/i.test(d)) { out.push(subst(d) + ';'); continue; }
    if (/^@charset/i.test(d)) { out.unshift(d + ';'); continue; }
  }
  emit(root, '', []);
  if (fnUsed.size) warnings.push(`LESS functions left as written (browsers ignore them): ${[...fnUsed].join(', ')}`);
  if (ops.size) warnings.push(`arithmetic left as written in: ${[...ops].slice(0, 8).join(', ')}`);
  const unresolved = new Set([...out.join('\n').matchAll(/@([\w-]+)/g)].map((m) => m[1]).filter((n) => !/^(media|import|charset|font-face|keyframes|supports|page|namespace|-webkit-keyframes|-moz-keyframes)$/.test(n)));
  if (unresolved.size) warnings.push(`undefined variables: @${[...unresolved].slice(0, 8).join(', @')}`);
  return { css: out.join('\n\n') + '\n', warnings };
}

// ------------------------------------------------------------------------------------------
// Import

const HEADER_TYPES: Record<string, string> = { 'index.html': 'Home', 'header.html': 'Header', 'no-header.html': 'No header', 'splash.html': 'Splash', 'landing.html': 'Landing', 'tall-header.html': 'Tall header', 'short-header.html': 'Short header', 'blog.html': 'Blog', 'store.html': 'Store' };

export function importWeeblyTheme(name: string, files0: Map<string, Uint8Array>): { site: Site; report: string[]; open?: string } {
  const root = isWeeblyTheme(files0) ?? '';
  const files = root ? new Map([...files0].filter(([k]) => k.startsWith(root + '/')).map(([k, v]) => [k.slice(root.length + 1), v])) : files0;
  const report: string[] = [];
  const siteName = name.replace(/[-_]+/g, ' ').replace(/\.zip$/i, '') || 'Weebly Theme';
  const site = new Site(siteName);
  const has = (p: string) => files.has(p);
  const assetsDir = has('assets') || [...files.keys()].some((k) => k.startsWith('assets/')) ? 'assets' : '';
  // Style sheet.
  let cssPath = ['main.css', 'styles/main.css', 'css/main.css'].find(has) || '';
  const lessPath = ['main.less', 'styles/main.less', 'less/main.less'].find(has);
  if (!cssPath && lessPath) {
    const parts: string[] = [];
    const seen = new Set<string>();
    const inline = (p: string, depth: number): string => {
      if (seen.has(p) || depth > 6) return '';
      seen.add(p);
      return textOf(files.get(p)).replace(/@import\s+(?:\([^)]*\)\s*)?["']([^"']+)["']\s*;/g, (m, ref: string) => {
        const t = joinPath(dirOf(p), /\.(less|css)$/.test(ref) ? ref : ref + '.less');
        return files.has(t) ? inline(t, depth + 1) : m;
      });
    };
    parts.push(inline(lessPath, 0));
    const r = lessToCss(parts.join('\n'));
    cssPath = 'main.css';
    site.write(cssPath, rewriteThemeUrls(r.css, cssPath, assetsDir), { silent: true });
    report.push(`main.css was made from ${lessPath} (variables, nesting and simple mixins).${r.warnings.length ? ` Not converted: ${r.warnings.join('; ')}.` : ''}`);
  }
  const pageFiles = [...files.keys()].filter((k) => /^[^/]+\.html?$/i.test(k)).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  if (!pageFiles.length) throw new Error('No header type pages (index.html, no-header.html, …) were found in the theme.');
  const menu: MenuItem[] = pageFiles.map((p) => ({ label: HEADER_TYPES[p] || stripExt(p).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), path: p === 'header.html' && !files.has('index.html') ? 'index.html' : p }));
  const partials = new Map([...files.keys()].filter((k) => /^partials\/.+\.(tpl|html?)$/i.test(k)).map((k) => [stripExt(k.slice(9)), textOf(files.get(k))]));
  const unknown: string[] = [];
  for (const [i, p] of pageFiles.entries()) {
    const out = menu[i].path!;
    let html = textOf(files.get(p));
    html = html.replace(/\{\{>\s*([\w/-]+)\s*\}\}/g, (m, n: string) => partials.get(n) ?? (unknown.push(`{{> ${n}}}`), ''));
    html = replaceTags(html, { siteName, file: out, menu, title: menu[i].label, unknown });
    html = rewriteThemeUrls(html, out, assetsDir);
    if (cssPath && !linkedStyles(html).some((h) => resolveRef(out, h) === cssPath)) html = addHead(html, `<link rel="stylesheet" href="${relativeRef(out, cssPath)}">`);
    if (has('custom.js') && !/custom\.js/.test(html)) html = addBodyEnd(html, `<script src="${relativeRef(out, 'custom.js')}"></script>`);
    site.write(out, html, { silent: true });
  }
  for (const [p, v] of files) {
    if (/^[^/]+\.html?$/i.test(p) || /\.less$/i.test(p) || p.startsWith('partials/')) continue;
    if (extOf(p) === 'css') { site.write(p, rewriteThemeUrls(textOf(v), p, assetsDir), { silent: true }); continue; }
    site.write(p, v, { silent: true });
  }
  keepSource(site, files);
  site.data.nav = { path: 'index.html', children: menu.filter((m) => m.path !== 'index.html').map((m) => ({ path: m.path!, label: m.label, children: [] })) };
  report.unshift(`Weebly theme with ${pageFiles.length} header type(s): ${pageFiles.join(', ')}. Each became a page with sample content in place of the theme tags.`);
  if (unknown.length) report.push(`Tags without a static meaning were removed: ${summarize(unknown)}.`);
  report.push('The original theme files are in _theme-source/ (not published).');
  return { site, report, open: site.has('index.html') ? 'index.html' : menu[0].path };
}

function addHead(html: string, tag: string): string {
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `  ${tag}\n</head>`) : tag + '\n' + html;
}
function addBodyEnd(html: string, tag: string): string {
  const r = regions(html);
  return r.bodyClose >= 0 ? html.slice(0, r.bodyClose) + tag + '\n' + html.slice(r.bodyClose) : html + '\n' + tag;
}

/** /files/theme/x → assets/x relative to the file. */
function rewriteThemeUrls(text: string, file: string, assetsDir: string): string {
  return text.replace(/(["'(\s])\/?files\/theme\/([^"')\s]+)/g, (m, a, rest) => `${a}${relativeRef(file, joinPath(assetsDir, rest))}`)
    .replace(/%%WEEBLYTHEMEIMAGES%%\/?/g, relativeRef(file, joinPath(assetsDir, 'x')).replace(/x$/, ''));
}

function replaceTags(html: string, o: { siteName: string; file: string; menu: MenuItem[]; title: string; unknown: string[] }): string {
  // Leave scripts and style blocks alone: their braces are code.
  const keep: string[] = [];
  let s = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => { keep.push(m); return `\u0002${keep.length - 1}\u0002`; });
  const home = relativeRef(o.file, 'index.html');
  s = s.replace(/<title>\s*\{title\}\s*<\/title>/i, `<title>${esc(o.title)} – ${esc(o.siteName)}</title>`);
  s = s.replace(/\{([a-z][\w-]*)(?::([a-z]+))?((?:\s+[\w-]+=(?:"[^"]*"|'[^']*'))*)\s*\}/gi, (m, name: string, type: string | undefined, attrs: string) => {
    const n = name.toLowerCase();
    const label = (attrs.match(/(?:label|placeholder|default)="([^"]*)"/) || [])[1];
    if (type) {
      switch (type.toLowerCase()) {
        case 'text': return `<span class="wsite-${escAttr(n)}">${esc(label || sampleText(n))}</span>`;
        case 'button': return `<a class="wsite-button" href="#"><span class="wsite-button-inner">${esc(label || 'Learn more')}</span></a>`;
        case 'image': return `<img class="wsite-${escAttr(n)}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">`;
        case 'content': return `<div class="wsite-${escAttr(n)}"><p>${esc(label || 'Content area')}</p></div>`;
        default: o.unknown.push(m); return '';
      }
    }
    switch (n) {
      case 'title': return `<a href="${escAttr(home)}">${esc(o.siteName)}</a>`;
      case 'logo': return `<span class="wsite-logo"><a href="${escAttr(home)}"><span id="wsite-title">${esc(o.siteName)}</span></a></span>`;
      case 'menu': case 'mobile-menu': return menuHtml(o.menu, o.file, { cls: 'wsite-menu-default menu', current: o.file });
      case 'content': return `<div class="wsite-section-wrap"><div class="wsite-section"><h2>${esc(o.title)}</h2><p>This is the content area. Replace this text with your own.</p></div></div>`;
      case 'footer': return `<div class="wsite-footer"><p>${esc(o.siteName)} · © ${new Date().getFullYear()}</p></div>`;
      case 'header': return `<div class="wsite-header-section"><h2 class="wsite-content-title">${esc(o.siteName)}</h2><p>A short headline about this site.</p></div>`;
      case 'search': return '<form class="wsite-search" action="#" role="search"><input type="search" name="q" class="wsite-search-input" placeholder="Search"><button type="submit" class="wsite-search-button">Search</button></form>';
      case 'social': return '<ul class="wsite-social"><li><a href="#">Facebook</a></li><li><a href="#">Instagram</a></li><li><a href="#">LinkedIn</a></li></ul>';
      case 'copyright': return `© ${new Date().getFullYear()} ${esc(o.siteName)}`;
      default: o.unknown.push(m); return '';
    }
  });
  return s.replace(/\u0002(\d+)\u0002/g, (m, i) => keep[+i]);
}

function sampleText(n: string): string {
  if (/phone|tel/.test(n)) return '(555) 010-0000';
  if (/mail/.test(n)) return 'hello@example.com';
  if (/address|location/.test(n)) return '123 Main Street';
  if (/head|title/.test(n)) return 'Headline';
  return 'Text';
}

/** A Weebly site archive is a static site: it opens as it is; Weebly's own scripts are reported. */
export function importWeeblyArchive(name: string, files: Map<string, Uint8Array>): { site: Site; report: string[]; open?: string } {
  const site = new Site(name.replace(/\.zip$/i, '') || 'Weebly Site');
  for (const [p, v] of files) site.write(p, v, { silent: true });
  const report: string[] = [];
  const pages = site.pages().map((f) => f.path);
  report.push(`Weebly site archive: ${pages.length} page(s) and ${site.files.size - pages.length} other file(s).`);
  let remote = 0;
  for (const p of pages) remote += (site.read(p)!.match(/<script\b[^>]*src\s*=\s*["'][^"']*(editmysite|weebly)\.com[^"']*["']/gi) || []).length;
  if (remote) report.push(`${remote} script reference(s) still load Weebly's own code from its servers (forms, galleries, stores need them). Remove them for a fully independent site.`);
  if (site.has('files/theme/main_style.css') || [...site.files.keys()].some((k) => k.startsWith('files/'))) report.push('Pictures and the theme are in files/ as Weebly saved them.');
  return { site, report, open: site.homePage };
}

// ------------------------------------------------------------------------------------------
// Export

export async function exportWeeblyTheme(site: Site, opts: { pagePath?: string; report?: string[] } = {}): Promise<Blob> {
  return zipFiles(exportWeeblyThemeFiles(site, opts));
}

export function exportWeeblyThemeFiles(site: Site, opts: { pagePath?: string; report?: string[] } = {}): Map<string, string | Uint8Array> {
  const report = opts.report || [];
  const pagePath = opts.pagePath || site.homePage;
  const src = detachTemplate(expandIncludes(site, pagePath, site.read(pagePath) || ''));
  const parts = splitMain(src);
  const out = new Map<string, string | Uint8Array>();
  const assets = new Map<string, string>(); // site path → asset name
  const assetName = (p: string) => {
    if (assets.has(p)) return assets.get(p)!;
    let n = baseName(p).replace(/[^\w.-]/g, '_');
    const used = new Set(assets.values());
    for (let i = 2; used.has(n); i++) n = `${stripExt(baseName(p))}_${i}.${extOf(p)}`;
    assets.set(p, n);
    return n;
  };
  const relink = (text: string, from: string) => rewriteRefs(text, from, (t) => {
    if (isPagePath(t)) return '/' + slugify(stripExt(baseName(t))) + '.html';
    if (!site.has(t) || extOf(t) === 'css') return null;
    return `/files/theme/${assetName(t)}`;
  });
  // CSS: every in-site style sheet the page links, in order, as main.css.
  const css: string[] = [];
  for (const h of linkedStyles(src)) {
    const t = resolveRef(pagePath, h);
    if (!t || !site.has(t)) continue;
    css.push(`/* from ${t} */\n` + relink(site.read(t) || '', t));
  }
  for (const m of parts.head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css.push(relink(m[1], pagePath));
  let before = relink(parts.before, pagePath);
  let after = relink(parts.after, pagePath);
  const nav = /<nav\b[^>]*>[\s\S]*?<\/nav>/i.exec(before) || /<ul\b[^>]*class\s*=\s*["'][^"']*(menu|nav)[^"']*["'][^>]*>[\s\S]*?<\/ul>/i.exec(before);
  if (nav) before = before.replace(nav[0], /^<nav/i.test(nav[0]) ? nav[0].replace(/(<nav\b[^>]*>)[\s\S]*(<\/nav>)/i, '$1{menu}$2') : '{menu}');
  else { before = `<div class="nav-wrap">{menu}</div>\n` + before; report.push('No menu was found in the header, so {menu} was added at the top.'); }
  const logoRe = /(<(?:a|span|div|p|h1)\b[^>]*class\s*=\s*["'][^"']*(?:logo|site-title|brand)[^"']*["'][^>]*>)[\s\S]*?(<\/(?:a|span|div|p|h1)>)/i;
  if (logoRe.test(before)) before = before.replace(logoRe, '$1{logo}$2');
  else before = `<div class="logo">{logo}</div>\n` + before;
  const foot = /(<footer\b[^>]*>)[\s\S]*?(<\/footer>)/i;
  if (foot.test(after)) after = after.replace(foot, '$1{footer}$2'); else after += '\n<footer class="footer">{footer}</footer>';
  const headKeep = parts.head
    .replace(/<title[^>]*>[\s\S]*?<\/title>/i, '')
    .replace(/<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*>\s*/gi, (t) => (/href\s*=\s*["']https?:/i.test(t) ? t : ''))
    .replace(/<style\b[\s\S]*?<\/style>\s*/gi, '')
    .replace(/<meta\s+charset[^>]*>\s*/i, '')
    .trim();
  const head = `<head>\n  <title>{title}</title>\n  <meta charset="utf-8">\n  ${relink(headKeep, pagePath).replace(/\n/g, '\n  ')}\n</head>`;
  const page = (b: string, a: string, content: string) => `<!DOCTYPE html>\n<html lang="en">\n${head}\n${parts.bodyTag}\n${b.trim()}\n${content}\n${a.trim()}\n</body>\n</html>\n`;
  const headerBlock = /<header\b[\s\S]*?<\/header>/i.exec(before)?.[0];
  out.set('index.html', page(before, after, '<div class="main-wrap">{content}</div>'));
  out.set('header.html', page(before, after, '<div class="banner-wrap">{header}</div>\n<div class="main-wrap">{content}</div>'));
  out.set('no-header.html', page(headerBlock ? before.replace(headerBlock, '<div class="header-wrap"><div class="logo">{logo}</div><div class="nav-wrap">{menu}</div></div>') : before, after, '<div class="main-wrap">{content}</div>'));
  out.set('splash.html', page(before, after, '<div class="splash-wrap">{header}</div>\n<div class="main-wrap">{content}</div>'));
  out.set('main.css', css.join('\n\n') || '/* Theme styles */\n');
  const scripts = [...src.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => resolveRef(pagePath, m[1])).filter((t): t is string => !!t && site.has(t));
  if (scripts.length) out.set('custom.js', scripts.map((t) => `/* from ${t} */\n${site.read(t)}`).join('\n\n'));
  for (const [p, n] of assets) {
    const f = site.get(p)!;
    out.set(`assets/${n}`, f.data ?? f.text ?? '');
  }
  // Remove page script tags (custom.js replaces them).
  for (const [k, v] of out) if (k.endsWith('.html')) out.set(k, (v as string).replace(/[ \t]*<script\b[^>]*\bsrc\s*=\s*["'](?!https?:)[^"']*["'][^>]*>\s*<\/script>\s*/gi, ''));
  report.push(`Weebly theme from ${pagePath}: index.html, header.html, no-header.html and splash.html header types, main.css (${css.length} style sheet(s) combined), ${assets.size} asset file(s)${scripts.length ? ', custom.js' : ''}.`);
  report.push('In Weebly: Theme ▸ Edit HTML / CSS, then upload the files (or import the ZIP where offered). Page content is not part of a theme; copy it into Weebly\'s editor or use an Embed Code element.');
  void getTitle; void joinPath;
  return out;
}
