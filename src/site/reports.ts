/**
 * Site reports and other pure computations over a Site: link index, unlinked files, the site reports of
 * desktop web editors (summary, files, links, components, titles, styles, team fields, publish status,
 * SEO, accessibility, compatibility, CSS), the navigation tree operations, link bar regeneration and
 * the generated files (sitemap.xml, robots.txt, feed.xml, search-index.json).
 *
 * Nothing here touches the DOM or the network, so every function can be unit-tested.
 */
import { Site, linksOf, externalLinksOf, linkable, pageTitle, findNav, defaultNav, type NavNode, type PublishProfile } from '../model/site';
import { baseName, dirOf, extOf, isImagePath, isPagePath, relativeRef, resolveRef } from '../model/paths';
import { esc, escAttr, getMeta, getLang, getTitle, linkedStyles, htmlToText } from '../model/html';
import { attachedTemplate, isTemplatePath } from './templates';

// ------------------------------------------------------------------------------------------
// Report model

export type ColumnKind = 'text' | 'number' | 'size' | 'date' | 'path';
export interface ReportColumn { key: string; label: string; kind?: ColumnKind }
export interface ReportRow {
  /** File the row is about; clicking the row opens it. */
  path?: string;
  /** 1-based line in that file, when known. */
  line?: number;
  /** Report to open instead of a file (summary rows). */
  report?: string;
  severity?: 'error' | 'warning' | 'info';
  [key: string]: any;
}
export interface Report { id: string; title: string; columns: ReportColumn[]; rows: ReportRow[]; note?: string }

export interface ReportOptions {
  /** "Recently added/changed" and "older files" threshold in days. */
  days?: number;
  /** Slow pages: total size threshold in KB. */
  kb?: number;
  /** Connection speed in kilobits per second used for the download time estimate. */
  speedKbps?: number;
  /** Current time (tests pass a fixed one). */
  now?: number;
  /** Results of an external link check: URL -> status text ("OK", "404", "Unreachable"...). */
  externalStatus?: Map<string, string>;
  /** Publish status: the profile to compare against (default: every profile). */
  profileId?: string;
}

const DAY = 86400000;
export const DEFAULT_SPEED_KBPS = 1500;

/** Well-known files that are reached by servers and crawlers, not by links. */
const ROOT_FILES = /^(robots\.txt|sitemap\.xml|favicon\.ico|apple-touch-icon.*\.png|cname|\.htaccess|\.nojekyll|404\.html?|feed\.xml|rss\.xml|atom\.xml|search-index\.json|humans\.txt|manifest\.webmanifest|site\.webmanifest|browserconfig\.xml|ads\.txt|security\.txt|web\.config)$/i;

export function lineAt(text: string, index: number): number {
  if (index < 0) return 1;
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
/** Line of the first occurrence of `needle` in `text` (1 when absent). */
export function lineOf(text: string, needle: string, from = 0): number { return lineAt(text, text.indexOf(needle, from)); }

export function fileSize(site: Site, path: string): number {
  const f = site.get(path);
  if (!f) return 0;
  if (f.data) return f.data.length;
  return new TextEncoder().encode(f.text ?? '').length;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ------------------------------------------------------------------------------------------
// Link index

export interface LinkRef { from: string; target: string; ref: string; line: number; exists: boolean }
export interface LinkIndex { out: Map<string, LinkRef[]>; in: Map<string, LinkRef[]>; external: Map<string, { url: string; line: number }[]> }

const LIB_RE = /<!--\s*#BeginLibraryItem\s+"([^"]+)"\s*-->/gi;

/** Every in-site and external link of every page and style sheet (library item markers count as links). */
export function linkIndex(site: Site): LinkIndex {
  const idx: LinkIndex = { out: new Map(), in: new Map(), external: new Map() };
  for (const f of site.list()) {
    if (f.text == null || !linkable(f.path)) continue;
    const text = f.text;
    const outs: LinkRef[] = [];
    const seenPos = new Map<string, number>();
    const add = (target: string, ref: string) => {
      const from = seenPos.get(ref) ?? 0;
      const pos = text.indexOf(ref, from);
      seenPos.set(ref, pos < 0 ? 0 : pos + ref.length);
      outs.push({ from: f.path, target, ref, line: lineAt(text, pos), exists: site.has(target) });
    };
    for (const [target, ref] of linksOf(text, f.path)) add(target, ref);
    if (isPagePath(f.path)) for (const m of text.matchAll(LIB_RE)) { const t = resolveRef(f.path, m[1]); if (t) add(t, m[1]); }
    idx.out.set(f.path, outs);
    for (const l of outs) { const a = idx.in.get(l.target) || []; a.push(l); idx.in.set(l.target, a); }
    const ext = externalLinksOf(text).map((url) => ({ url, line: lineOf(text, url) }));
    if (ext.length) idx.external.set(f.path, ext);
  }
  return idx;
}

/**
 * Files not reachable from the home page by following links (pages, style sheets and their resources).
 * Well-known root files (robots.txt, favicon.ico, 404.html…) and the files of the editor itself are not reported.
 */
export function unlinkedFiles(site: Site, idx = linkIndex(site)): string[] {
  const seen = new Set<string>();
  const queue = [site.homePage];
  if (site.data.nav) { const walk = (n: NavNode) => { queue.push(n.path); n.children.forEach(walk); }; walk(site.data.nav); }
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p) || !site.has(p)) continue;
    seen.add(p);
    for (const l of idx.out.get(p) || []) if (!seen.has(l.target)) queue.push(l.target);
  }
  return site.list().map((f) => f.path).filter((p) => !seen.has(p) && !ROOT_FILES.test(baseName(p)) && !/\.qlsite$/i.test(p) && !/(^|\/)_notes\//.test(p));
}

/** Non-page files a page loads (pictures, style sheets, scripts, media), recursively through style sheets. */
export function pageResources(site: Site, path: string, idx = linkIndex(site)): string[] {
  const out = new Set<string>();
  const text = site.read(path) || '';
  // <a href> targets are navigation, not resources.
  const anchorTargets = new Set<string>();
  for (const m of text.matchAll(/<a\b[^>]*\shref\s*=\s*["']?([^"'\s>]+)/gi)) { const t = resolveRef(path, m[1]); if (t) anchorTargets.add(t); }
  const visit = (p: string, depth: number) => {
    for (const l of idx.out.get(p) || []) {
      if (!l.exists || out.has(l.target) || l.target === path) continue;
      if (depth === 0 && anchorTargets.has(l.target) && !isImagePath(l.target)) continue;
      if (isPagePath(l.target) && !/\.lbi$/i.test(l.target)) continue;
      if (isTemplatePath(l.target)) continue;
      out.add(l.target);
      if (/\.(css|scss|less)$/i.test(l.target) && depth < 4) visit(l.target, depth + 1);
    }
  };
  visit(path, 0);
  return [...out];
}

/** Estimated download seconds of `bytes` at `kbps`. */
export function downloadSeconds(bytes: number, kbps = DEFAULT_SPEED_KBPS): number { return (bytes * 8) / (kbps * 1000); }

// ------------------------------------------------------------------------------------------
// Individual reports

const fileCols: ReportColumn[] = [
  { key: 'name', label: 'Name' }, { key: 'path', label: 'Folder/Path', kind: 'path' }, { key: 'title', label: 'Title' },
  { key: 'size', label: 'Size', kind: 'size' }, { key: 'type', label: 'Type' }, { key: 'modified', label: 'Modified', kind: 'date' },
];
function fileRow(site: Site, path: string): ReportRow {
  const f = site.get(path)!;
  return { path, name: baseName(path), title: isPagePath(path) ? pageTitle(site, path) : '', size: fileSize(site, path), type: extOf(path) || 'file', modified: f.modified, created: f.created };
}

export function reportAllFiles(site: Site): Report {
  return { id: 'allFiles', title: 'All Files', columns: fileCols, rows: site.list().map((f) => fileRow(site, f.path)) };
}

export function reportRecentlyAdded(site: Site, o: ReportOptions = {}): Report {
  const now = o.now ?? Date.now(), days = o.days ?? 30;
  return { id: 'recentlyAdded', title: `Recently Added Files (last ${days} days)`, columns: [...fileCols.slice(0, 5), { key: 'created', label: 'Added', kind: 'date' }],
    rows: site.list((f) => now - f.created <= days * DAY).map((f) => fileRow(site, f.path)) };
}

export function reportRecentlyChanged(site: Site, o: ReportOptions = {}): Report {
  const now = o.now ?? Date.now(), days = o.days ?? 30;
  return { id: 'recentlyChanged', title: `Recently Changed Files (last ${days} days)`, columns: fileCols, rows: site.list((f) => now - f.modified <= days * DAY).map((f) => fileRow(site, f.path)) };
}

export function reportOlderFiles(site: Site, o: ReportOptions = {}): Report {
  const now = o.now ?? Date.now(), days = o.days ?? 72;
  return { id: 'olderFiles', title: `Older Files (not changed in ${days} days)`, columns: fileCols, rows: site.list((f) => now - f.modified > days * DAY).map((f) => fileRow(site, f.path)) };
}

export function reportUnlinked(site: Site, idx = linkIndex(site)): Report {
  return { id: 'unlinked', title: 'Unlinked Files', columns: fileCols, rows: unlinkedFiles(site, idx).map((p) => fileRow(site, p)),
    note: 'Files that cannot be reached from the home page by following links. Well-known root files such as robots.txt and favicon.ico are not listed.' };
}

export function reportSlowPages(site: Site, o: ReportOptions = {}, idx = linkIndex(site)): Report {
  const kb = o.kb ?? 500, speed = o.speedKbps ?? DEFAULT_SPEED_KBPS;
  const rows: ReportRow[] = [];
  for (const f of site.pages()) {
    if (/\.(dwt|lbi)$/i.test(f.path)) continue;
    const res = pageResources(site, f.path, idx);
    const total = fileSize(site, f.path) + res.reduce((s, p) => s + fileSize(site, p), 0);
    if (total / 1024 > kb) rows.push({ path: f.path, name: baseName(f.path), title: pageTitle(site, f.path), size: total, resources: res.length, seconds: Math.round(downloadSeconds(total, speed) * 10) / 10, severity: 'warning' });
  }
  rows.sort((a, b) => b.size - a.size);
  return { id: 'slowPages', title: `Slow Pages (over ${kb} KB)`, columns: [{ key: 'name', label: 'Name' }, { key: 'path', label: 'Path', kind: 'path' }, { key: 'title', label: 'Title' }, { key: 'size', label: 'Total size', kind: 'size' }, { key: 'resources', label: 'Files used', kind: 'number' }, { key: 'seconds', label: `Seconds at ${speed} kbps`, kind: 'number' }], rows,
    note: 'Total size counts the page and the pictures, style sheets, scripts and media it loads from the site. Files loaded from other servers are not counted.' };
}

export function reportBrokenLinks(site: Site, o: ReportOptions = {}, idx = linkIndex(site)): Report {
  const rows: ReportRow[] = [];
  for (const [from, links] of idx.out) for (const l of links) if (!l.exists) rows.push({ path: from, line: l.line, link: l.ref, target: l.target, kind: 'Internal', status: 'Broken', severity: 'error' });
  for (const [from, links] of idx.external) for (const l of links) {
    if (!/^https?:/i.test(l.url)) continue;
    const st = o.externalStatus?.get(l.url);
    if (st && /^(ok|2\d\d|3\d\d)/i.test(st)) continue;
    rows.push({ path: from, line: l.line, link: l.url, target: '', kind: 'External', status: st || 'Not checked', severity: st ? 'error' : 'info' });
  }
  return { id: 'brokenLinks', title: 'Hyperlinks: Broken and Unverified', columns: [{ key: 'status', label: 'Status' }, { key: 'link', label: 'Hyperlink' }, { key: 'path', label: 'In page', kind: 'path' }, { key: 'line', label: 'Line', kind: 'number' }, { key: 'kind', label: 'Kind' }], rows,
    note: 'Internal links are checked against the site files. External links are listed as "Not checked" until you run Check Links with external verification.' };
}

export function reportExternalLinks(site: Site, o: ReportOptions = {}, idx = linkIndex(site)): Report {
  const rows: ReportRow[] = [];
  for (const [from, links] of idx.external) for (const l of links) rows.push({ path: from, line: l.line, link: l.url, scheme: l.url.split(':')[0].toLowerCase(), status: o.externalStatus?.get(l.url) || '' });
  return { id: 'externalLinks', title: 'External Links', columns: [{ key: 'link', label: 'Address' }, { key: 'scheme', label: 'Kind' }, { key: 'path', label: 'In page', kind: 'path' }, { key: 'line', label: 'Line', kind: 'number' }, { key: 'status', label: 'Status' }], rows };
}

const SSI_RE = /<!--\s*#include\s+(virtual|file)\s*=\s*"([^"]+)"\s*-->/gi;
const WEBBOT_INC_RE = /<!--\s*webbot\s+bot="Include"[^>]*U-Include="([^"]+)"/gi;
const EDIT_BEGIN = /<!--\s*(?:#BeginEditable\s+"[^"]+"|TemplateBeginEditable\s+name="[^"]+"|InstanceBeginEditable\s+name="[^"]+")\s*-->/gi;
const EDIT_END = /<!--\s*(?:#EndEditable|TemplateEndEditable|InstanceEndEditable)\s*-->/gi;
const LIB_END = /<!--\s*#EndLibraryItem\s*-->/gi;
export const LINKBAR_MODES = ['children', 'siblings', 'top', 'breadcrumbs'] as const;
export type LinkBarMode = typeof LINKBAR_MODES[number];

export function reportComponentErrors(site: Site): Report {
  const rows: ReportRow[] = [];
  const err = (path: string, text: string, at: number, component: string, problem: string, severity: 'error' | 'warning' = 'error') => rows.push({ path, line: lineAt(text, at), component, problem, severity });
  for (const f of site.pages()) {
    const t = f.text ?? '';
    for (const m of t.matchAll(SSI_RE)) {
      const virtual = m[1].toLowerCase() === 'virtual';
      const p = virtual ? resolveRef('', m[2].startsWith('/') ? m[2] : '/' + m[2]) : resolveRef(f.path, m[2]);
      if (!p || (!site.has(p) && !site.has(resolveRef(f.path, m[2]) || ''))) err(f.path, t, m.index!, 'Include', `Included file not found: ${m[2]}`);
    }
    for (const m of t.matchAll(WEBBOT_INC_RE)) { const p = resolveRef(f.path, m[1]); if (!p || !site.has(p)) err(f.path, t, m.index!, 'Include Page', `Included page not found: ${m[1]}`); }
    const tpl = attachedTemplate(t, f.path) || site.data.templates[f.path];
    if (tpl && !site.has(tpl)) err(f.path, t, t.search(/#BeginTemplate|InstanceBegin\s/), 'Page template', `Attached template not found: ${tpl}`);
    const begins = [...t.matchAll(EDIT_BEGIN)].length, ends = [...t.matchAll(EDIT_END)].length;
    if (begins !== ends) err(f.path, t, Math.max(0, t.search(EDIT_BEGIN)), 'Editable region', `${begins} region start marker(s) but ${ends} end marker(s)`);
    const libs = [...t.matchAll(LIB_RE)];
    for (const m of libs) { const p = resolveRef(f.path, m[1]); if (!p || !site.has(p)) err(f.path, t, m.index!, 'Library item', `Library item not found: ${m[1]}`); }
    if (libs.length !== [...t.matchAll(LIB_END)].length) err(f.path, t, libs[0]?.index ?? 0, 'Library item', 'A library item has no end marker');
    for (const m of t.matchAll(/<nav\b[^>]*\bdata-ql-linkbar\s*=\s*["']([^"']*)["'][^>]*>/gi)) {
      if (!(LINKBAR_MODES as readonly string[]).includes(m[1])) err(f.path, t, m.index!, 'Link bar', `Unknown link bar kind "${m[1]}"`, 'warning');
      else if (m[1] !== 'top' && m[1] !== 'breadcrumbs' && site.data.nav && !findNav(site.data.nav, f.path)) err(f.path, t, m.index!, 'Link bar', 'The page is not in the navigation structure, so this link bar is empty', 'warning');
    }
  }
  return { id: 'componentErrors', title: 'Component Errors', columns: [{ key: 'path', label: 'Page', kind: 'path' }, { key: 'line', label: 'Line', kind: 'number' }, { key: 'component', label: 'Component' }, { key: 'problem', label: 'Problem' }], rows };
}

function contentPages(site: Site) { return site.pages().filter((f) => !/\.(lbi)$/i.test(f.path)); }

export function reportMissingAlt(site: Site): Report {
  const rows: ReportRow[] = [];
  for (const f of site.pages()) {
    const t = f.text ?? '';
    for (const m of t.matchAll(/<img\b[^>]*>/gi)) if (!/\salt\s*=/i.test(m[0])) rows.push({ path: f.path, line: lineAt(t, m.index!), element: m[0].slice(0, 120), severity: 'warning', src: /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(m[0])?.[1] || '' });
    for (const m of t.matchAll(/<area\b[^>]*>/gi)) if (!/\salt\s*=/i.test(m[0])) rows.push({ path: f.path, line: lineAt(t, m.index!), element: m[0].slice(0, 120), severity: 'warning', src: '' });
  }
  return { id: 'missingAlt', title: 'Pictures Without Alternate Text', columns: [{ key: 'path', label: 'Page', kind: 'path' }, { key: 'line', label: 'Line', kind: 'number' }, { key: 'src', label: 'Picture' }, { key: 'element', label: 'Code' }], rows };
}

export function reportMissingTitles(site: Site): Report {
  const rows = contentPages(site).filter((f) => !getTitle(f.text ?? '')).map((f) => ({ path: f.path, name: baseName(f.path), line: lineOf(f.text ?? '', '<head'), problem: /<title/i.test(f.text ?? '') ? 'Empty title' : 'No title', severity: 'warning' as const }));
  return { id: 'missingTitles', title: 'Pages Without Titles', columns: [{ key: 'name', label: 'Name' }, { key: 'path', label: 'Path', kind: 'path' }, { key: 'problem', label: 'Problem' }], rows };
}

export function reportDuplicateTitles(site: Site): Report {
  const by = new Map<string, string[]>();
  for (const f of contentPages(site)) { if (isTemplatePath(f.path)) continue; const t = getTitle(f.text ?? '').trim(); if (!t) continue; const k = t.toLowerCase(); by.set(k, [...(by.get(k) || []), f.path]); }
  const rows: ReportRow[] = [];
  for (const paths of by.values()) if (paths.length > 1) for (const p of paths) rows.push({ path: p, title: getTitle(site.read(p) || ''), count: paths.length, line: lineOf(site.read(p) || '', '<title'), severity: 'warning' });
  rows.sort((a, b) => a.title.localeCompare(b.title));
  return { id: 'duplicateTitles', title: 'Duplicate Page Titles', columns: [{ key: 'title', label: 'Title' }, { key: 'path', label: 'Page', kind: 'path' }, { key: 'count', label: 'Pages with it', kind: 'number' }], rows };
}

/** Class selectors defined in CSS text, with their offsets. */
export function cssClasses(css: string): { name: string; index: number }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const out: { name: string; index: number }[] = [];
  // Only selector text (before "{"), not property values such as url(a.b.png).
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const sel = m[1];
    if (/^\s*@/.test(sel) && !/^\s*@media|^\s*@supports|^\s*@container|^\s*@layer/.test(sel)) continue;
    for (const c of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.push({ name: c[1], index: m.index + c.index! });
  }
  return out;
}

export function reportUnusedStyles(site: Site): Report {
  const used = new Set<string>();
  let scripts = '';
  for (const f of site.list()) {
    const t = f.text;
    if (t == null) continue;
    if (isPagePath(f.path) || /\.(svg|xml)$/i.test(f.path)) for (const m of t.matchAll(/\sclass\s*=\s*(["'])([\s\S]*?)\1/gi)) for (const c of m[2].split(/\s+/)) if (c) used.add(c);
    if (/\.(js|mjs|ts|jsx|tsx|vue|php)$/i.test(f.path) || isPagePath(f.path)) scripts += '\n' + (isPagePath(f.path) ? [...t.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n') : t);
  }
  const rows: ReportRow[] = [];
  const seen = new Set<string>();
  const check = (path: string, css: string, offset: number, whole: string) => {
    for (const c of cssClasses(css)) {
      if (used.has(c.name) || seen.has(path + '|' + c.name)) continue;
      if (scripts && new RegExp(`['"\`.\\s]${c.name.replace(/[-]/g, '\\-')}['"\`\\s.]`).test(scripts)) continue;
      seen.add(path + '|' + c.name);
      rows.push({ path, line: lineAt(whole, offset + c.index), style: '.' + c.name, severity: 'info' });
    }
  };
  for (const f of site.list((x) => /\.(css|scss|less)$/i.test(x.path))) check(f.path, f.text ?? '', 0, f.text ?? '');
  for (const f of site.pages()) { const t = f.text ?? ''; for (const m of t.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) check(f.path, m[2], m.index! + m[1].length, t); }
  return { id: 'unusedStyles', title: 'Unused Styles', columns: [{ key: 'style', label: 'Class' }, { key: 'path', label: 'Defined in', kind: 'path' }, { key: 'line', label: 'Line', kind: 'number' }], rows,
    note: 'A class is unused when no page uses it in a class attribute and no script names it. Classes added by scripts in other ways may be reported by mistake.' };
}

export function reportStyleLinks(site: Site): Report {
  const rows: ReportRow[] = [];
  for (const f of contentPages(site)) {
    const t = f.text ?? '';
    for (const href of linkedStyles(t)) {
      const target = resolveRef(f.path, href);
      rows.push({ path: f.path, line: lineOf(t, href), sheet: href, status: target ? (site.has(target) ? 'OK' : 'Missing') : 'External', severity: target && !site.has(target) ? 'error' : undefined });
    }
    for (const m of t.matchAll(/@import\s+(?:url\()?["']([^"')]+)["']/gi)) { const target = resolveRef(f.path, m[1]); rows.push({ path: f.path, line: lineAt(t, m.index!), sheet: m[1] + ' (@import)', status: target ? (site.has(target) ? 'OK' : 'Missing') : 'External' }); }
    if (/<style\b/i.test(t)) rows.push({ path: f.path, line: lineOf(t, '<style'), sheet: '(embedded style block)', status: 'Embedded' });
  }
  return { id: 'styleLinks', title: 'Style Sheet Links', columns: [{ key: 'path', label: 'Page', kind: 'path' }, { key: 'sheet', label: 'Style sheet' }, { key: 'status', label: 'Status' }, { key: 'line', label: 'Line', kind: 'number' }], rows };
}

export function reportTemplates(site: Site): Report {
  const using = new Map<string, string[]>();
  for (const f of site.pages()) {
    if (isTemplatePath(f.path)) continue;
    const tpl = attachedTemplate(f.text ?? '', f.path) || site.data.templates[f.path];
    if (tpl) using.set(tpl, [...(using.get(tpl) || []), f.path]);
  }
  const rows: ReportRow[] = [];
  for (const f of site.list((x) => isTemplatePath(x.path))) rows.push({ path: f.path, template: f.path, pages: (using.get(f.path) || []).length, list: (using.get(f.path) || []).join(', ') });
  for (const [tpl, pages] of using) if (!site.has(tpl)) rows.push({ template: tpl + ' (missing)', pages: pages.length, list: pages.join(', '), severity: 'error', path: pages[0] });
  return { id: 'templates', title: 'Page Templates', columns: [{ key: 'template', label: 'Template' }, { key: 'pages', label: 'Pages', kind: 'number' }, { key: 'list', label: 'Attached pages' }], rows };
}

export function reportCheckedOut(site: Site): Report {
  return { id: 'checkedOut', title: 'Checked Out Files', columns: [{ key: 'name', label: 'Name' }, { key: 'path', label: 'Path', kind: 'path' }, { key: 'by', label: 'Checked out by' }, { key: 'modified', label: 'Modified', kind: 'date' }],
    rows: site.list((f) => !!f.checkedOut).map((f) => ({ path: f.path, name: baseName(f.path), by: f.checkedOut, modified: f.modified })),
    note: 'Check-out marks are kept in this site\'s data on this device. There is no shared server, so files checked out by other people appear only when their site data is opened here.' };
}

function propReport(site: Site, id: string, title: string, key: string, label: string): Report {
  const rows: ReportRow[] = [];
  for (const f of site.list()) {
    const v = f.props?.[key] || (key === 'review' ? f.props?.reviewStatus : '') || '';
    const values = key === 'category' ? v.split(/\s*[,;]\s*/).filter(Boolean) : [v];
    for (const x of values.length ? values : ['']) rows.push({ path: f.path, name: baseName(f.path), title: isPagePath(f.path) ? pageTitle(site, f.path) : '', value: x || '(none)', modified: f.modified });
  }
  rows.sort((a, b) => (a.value === '(none)' ? 1 : 0) - (b.value === '(none)' ? 1 : 0) || a.value.localeCompare(b.value));
  return { id, title, columns: [{ key: 'value', label }, { key: 'name', label: 'Name' }, { key: 'path', label: 'Path', kind: 'path' }, { key: 'title', label: 'Title' }, { key: 'modified', label: 'Modified', kind: 'date' }], rows };
}
export const reportReviewStatus = (site: Site) => propReport(site, 'reviewStatus', 'Review Status', 'review', 'Review status');
export const reportAssignedTo = (site: Site) => propReport(site, 'assignedTo', 'Assigned To', 'assignedTo', 'Assigned to');
export const reportCategories = (site: Site) => propReport(site, 'categories', 'Categories', 'category', 'Category');

export function reportPublishStatus(site: Site, o: ReportOptions = {}): Report {
  const profiles = site.data.publish.filter((p) => !o.profileId || p.id === o.profileId);
  const rows: ReportRow[] = [];
  for (const f of site.list()) {
    const row: ReportRow = { path: f.path, name: baseName(f.path), modified: f.modified };
    if (f.noPublish) row.status = "Don't publish";
    for (const p of profiles) {
      const t = p.published?.[f.path];
      row['p_' + p.id] = f.noPublish ? "Don't publish" : t == null ? 'Not published' : t >= f.modified ? 'Published' : 'Changed';
    }
    rows.push(row);
  }
  const note = profiles.length ? undefined : 'No publishing destinations yet. Use Publish Site to create one.';
  return { id: 'publishStatus', title: 'Publish Status', columns: [{ key: 'name', label: 'Name' }, { key: 'path', label: 'Path', kind: 'path' }, { key: 'modified', label: 'Modified', kind: 'date' }, ...profiles.map((p) => ({ key: 'p_' + p.id, label: p.name }))], rows, note };
}

export function reportSeo(site: Site): Report {
  const rows: ReportRow[] = [];
  const titles = new Map<string, number>();
  const pages = contentPages(site).filter((f) => !isTemplatePath(f.path));
  for (const f of pages) { const t = getTitle(f.text ?? '').toLowerCase(); if (t) titles.set(t, (titles.get(t) || 0) + 1); }
  for (const f of pages) {
    const t = f.text ?? '';
    const title = getTitle(t), desc = getMeta(t, 'description') ?? '';
    const h1 = [...t.matchAll(/<h1\b/gi)].length;
    const issues: string[] = [];
    if (!title) issues.push('no title'); else if (title.length < 10) issues.push('title too short'); else if (title.length > 60) issues.push('title over 60 characters');
    if (title && (titles.get(title.toLowerCase()) || 0) > 1) issues.push('duplicate title');
    if (!desc) issues.push('no description'); else if (desc.length < 50) issues.push('description too short'); else if (desc.length > 160) issues.push('description over 160 characters');
    if (h1 === 0) issues.push('no h1'); else if (h1 > 1) issues.push(`${h1} h1 headings`);
    if (!getLang(t)) issues.push('no lang');
    if (/<meta[^>]+name\s*=\s*["']robots["'][^>]+noindex/i.test(t)) issues.push('noindex');
    rows.push({ path: f.path, title, titleLength: title.length, descLength: desc.length, h1, words: (htmlToText(t).match(/\S+/g) || []).length, issues: issues.join('; ') || 'OK', severity: issues.length ? 'warning' : undefined });
  }
  return { id: 'seo', title: 'Search Engine Optimization', columns: [{ key: 'path', label: 'Page', kind: 'path' }, { key: 'title', label: 'Title' }, { key: 'titleLength', label: 'Title length', kind: 'number' }, { key: 'descLength', label: 'Description length', kind: 'number' }, { key: 'h1', label: 'H1', kind: 'number' }, { key: 'words', label: 'Words', kind: 'number' }, { key: 'issues', label: 'Issues' }], rows };
}

export function reportAccessibility(site: Site): Report {
  const rows: ReportRow[] = [];
  const add = (path: string, text: string, at: number, check: string, problem: string, severity: 'error' | 'warning' = 'warning') => rows.push({ path, line: lineAt(text, at), check, problem, severity });
  for (const f of contentPages(site)) {
    const t = f.text ?? '';
    if (isTemplatePath(f.path) || /\.lbi$/i.test(f.path)) continue;
    if (/<html\b/i.test(t) && !getLang(t)) add(f.path, t, t.search(/<html\b/i), 'Language', 'The <html> element has no lang attribute');
    if (/<html\b/i.test(t) && !getTitle(t)) add(f.path, t, Math.max(0, t.search(/<head\b/i)), 'Title', 'The page has no title');
    for (const m of t.matchAll(/<img\b[^>]*>/gi)) if (!/\salt\s*=/i.test(m[0])) add(f.path, t, m.index!, 'Alternate text', 'Picture without an alt attribute', 'error');
    for (const m of t.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      if (!/\shref\s*=/i.test(m[1])) continue;
      const inner = m[2];
      const text = htmlToText(inner).trim();
      const alt = [...inner.matchAll(/<img\b[^>]*\salt\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]).join('');
      if (!text && !alt.trim() && !/aria-label(ledby)?\s*=\s*["'][^"']+/i.test(m[1] + inner) && !/\stitle\s*=\s*["'][^"']+/i.test(m[1])) add(f.path, t, m.index!, 'Link text', 'Link with no text', 'error');
    }
    const labelled = new Set([...t.matchAll(/<label\b[^>]*\sfor\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
    // Controls wrapped in <label>…</label> are labelled too.
    const wrapped = new Set<number>();
    for (const m of t.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)) for (const c of m[0].matchAll(/<(input|select|textarea)\b/gi)) wrapped.add(m.index! + c.index!);
    for (const m of t.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
      const tag = m[0];
      const type = /\stype\s*=\s*["']?(\w+)/i.exec(tag)?.[1]?.toLowerCase() || 'text';
      if (m[1].toLowerCase() === 'input' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      const id = /\sid\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if ((id && labelled.has(id)) || wrapped.has(m.index!) || /aria-label(ledby)?\s*=|\stitle\s*=/i.test(tag)) continue;
      add(f.path, t, m.index!, 'Form labels', `<${m[1].toLowerCase()}${m[1].toLowerCase() === 'input' ? ` type="${type}"` : ''}> has no label`);
    }
    for (const m of t.matchAll(/<(iframe|frame)\b[^>]*>/gi)) if (!/\stitle\s*=/i.test(m[0])) add(f.path, t, m.index!, 'Frame titles', `<${m[1].toLowerCase()}> has no title`);
    for (const m of t.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) if (!/<th\b/i.test(m[1]) && !/role\s*=\s*["']presentation/i.test(m[0])) add(f.path, t, m.index!, 'Table headers', 'Table without header cells (fine for layout tables marked role="presentation")');
    const levels = [...t.matchAll(/<h([1-6])\b/gi)].map((m) => ({ n: +m[1], i: m.index! }));
    for (let i = 1; i < levels.length; i++) if (levels[i].n > levels[i - 1].n + 1) add(f.path, t, levels[i].i, 'Headings', `Heading level skips from h${levels[i - 1].n} to h${levels[i].n}`);
    for (const m of t.matchAll(/<(blink|marquee)\b/gi)) add(f.path, t, m.index!, 'Moving content', `<${m[1].toLowerCase()}> moves or flashes`, 'error');
  }
  return { id: 'accessibility', title: 'Accessibility', columns: [{ key: 'path', label: 'Page', kind: 'path' }, { key: 'line', label: 'Line', kind: 'number' }, { key: 'check', label: 'Check' }, { key: 'problem', label: 'Problem' }], rows,
    note: 'A quick site-wide check. The Accessibility checker in the Check tab examines the open page in more depth.' };
}

const DEPRECATED_TAGS = ['font', 'center', 'marquee', 'blink', 'frameset', 'frame', 'noframes', 'applet', 'basefont', 'big', 'strike', 'tt', 'acronym', 'dir', 'isindex', 'nobr', 'listing', 'xmp', 'plaintext', 'bgsound', 'spacer', 'layer', 'ilayer', 'multicol', 'keygen'];
const DEPRECATED_ATTRS: [RegExp, string][] = [
  [/<(?:body|table|tr|td|th)\b[^>]*\sbgcolor\s*=/gi, 'bgcolor (use CSS background-color)'],
  [/<(?:body|table|td|th)\b[^>]*\sbackground\s*=/gi, 'background (use CSS background-image)'],
  [/<(?:p|div|h[1-6]|img|table|td|th|tr|hr|caption|iframe|input|legend)\b[^>]*\salign\s*=/gi, 'align (use CSS text-align, float or margin)'],
  [/<(?:td|th|tr|tbody|thead|tfoot|col)\b[^>]*\svalign\s*=/gi, 'valign (use CSS vertical-align)'],
  [/<(?:img|object)\b[^>]*\s(?:hspace|vspace)\s*=/gi, 'hspace/vspace (use CSS margin)'],
  [/<img\b[^>]*\sborder\s*=/gi, 'border on img (use CSS border)'],
  [/<body\b[^>]*\s(?:text|link|vlink|alink|topmargin|leftmargin|marginwidth|marginheight)\s*=/gi, 'body presentation attributes (use CSS)'],
  [/<script\b[^>]*\slanguage\s*=/gi, 'language on script (use type or nothing)'],
  [/<(?:td|th)\b[^>]*\s(?:width|height|nowrap)\b/gi, 'width/height/nowrap on cells (use CSS)'],
  [/<(?:table)\b[^>]*\s(?:cellpadding|cellspacing)\s*=/gi, 'cellpadding/cellspacing (use CSS padding and border-spacing)'],
  [/<(?:a|form|frame|iframe)\b[^>]*\sname\s*=/gi, 'name as an anchor (use id)'],
];

export function reportCompatibility(site: Site): Report {
  const rows: ReportRow[] = [];
  for (const f of contentPages(site)) {
    const t = f.text ?? '';
    if (/<html\b/i.test(t) && !/^\s*(<\?[\s\S]*?\?>\s*)*<!doctype/i.test(t) && !/\.(lbi)$/i.test(f.path)) rows.push({ path: f.path, line: 1, item: 'No DOCTYPE', problem: 'The page renders in quirks mode', severity: 'warning' });
    const counts = new Map<string, { n: number; i: number }>();
    for (const m of t.matchAll(new RegExp(`<(${DEPRECATED_TAGS.join('|')})\\b`, 'gi'))) { const k = m[1].toLowerCase(); const c = counts.get(k); if (c) c.n++; else counts.set(k, { n: 1, i: m.index! }); }
    for (const [tag, c] of counts) rows.push({ path: f.path, line: lineAt(t, c.i), item: `<${tag}>`, problem: `Obsolete element (${c.n} use${c.n > 1 ? 's' : ''})`, severity: 'warning' });
    for (const [re, label] of DEPRECATED_ATTRS) { const all = [...t.matchAll(re)]; if (all.length) rows.push({ path: f.path, line: lineAt(t, all[0].index!), item: label.split(' ')[0], problem: `Obsolete attribute: ${label} (${all.length} use${all.length > 1 ? 's' : ''})`, severity: 'info' }); }
    for (const m of t.matchAll(/<(?:embed|object)\b[^>]*(?:\.swf|shockwave|x-shockwave-flash)[^>]*>/gi)) rows.push({ path: f.path, line: lineAt(t, m.index!), item: 'Flash', problem: 'Flash content no longer plays in any current browser', severity: 'error' });
    for (const m of t.matchAll(/<meta[^>]+http-equiv\s*=\s*["']X-UA-Compatible["'][^>]*>/gi)) rows.push({ path: f.path, line: lineAt(t, m.index!), item: 'X-UA-Compatible', problem: 'Only meaningful to retired browsers', severity: 'info' });
  }
  return { id: 'compatibility', title: 'Compatibility', columns: [{ key: 'path', label: 'Page', kind: 'path' }, { key: 'line', label: 'Line', kind: 'number' }, { key: 'item', label: 'Item' }, { key: 'problem', label: 'Problem' }], rows };
}

/** CSS sanity problems: unbalanced braces, unclosed comments and strings, empty rules, declarations without a colon. */
export function cssProblems(css: string): { index: number; problem: string; severity: 'error' | 'warning' }[] {
  const out: { index: number; problem: string; severity: 'error' | 'warning' }[] = [];
  const open = css.indexOf('/*');
  let depth = 0, i = 0, ruleStart = -1, lastOpen = -1;
  const stack: number[] = [];
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); if (e < 0) { out.push({ index: i, problem: 'Comment is never closed', severity: 'error' }); return out; } i = e + 2; continue; }
    if (ch === '"' || ch === "'") { let j = i + 1; while (j < css.length && css[j] !== ch && css[j] !== '\n') { if (css[j] === '\\') j++; j++; } if (css[j] !== ch) out.push({ index: i, problem: 'String is not closed on its line', severity: 'error' }); i = j + 1; continue; }
    if (ch === '{') { depth++; stack.push(i); lastOpen = i; ruleStart = i; }
    else if (ch === '}') {
      if (!depth) out.push({ index: i, problem: 'Closing brace without an opening brace', severity: 'error' });
      else {
        depth--; const s = stack.pop()!;
        const body = css.slice(s + 1, i);
        if (!body.replace(/\/\*[\s\S]*?\*\//g, '').trim()) out.push({ index: s, problem: 'Empty rule', severity: 'warning' });
        else if (!/[{}]/.test(body)) {
          for (const decl of body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
            const d = decl.trim();
            if (d && !d.includes(':') && !d.startsWith('@')) out.push({ index: s + 1 + body.indexOf(d), problem: `Declaration without a colon: "${d.slice(0, 40)}"`, severity: 'error' });
          }
        }
      }
      ruleStart = -1;
    }
    i++;
  }
  void open; void ruleStart; void lastOpen;
  if (depth > 0) out.push({ index: stack[0], problem: `${depth} rule(s) are not closed with "}"`, severity: 'error' });
  return out;
}

export function reportCss(site: Site): Report {
  const rows: ReportRow[] = [];
  for (const f of site.list((x) => /\.css$/i.test(x.path))) { const t = f.text ?? ''; for (const p of cssProblems(t)) rows.push({ path: f.path, line: lineAt(t, p.index), problem: p.problem, severity: p.severity, where: 'Style sheet' }); }
  for (const f of site.pages()) {
    const t = f.text ?? '';
    for (const m of t.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) for (const p of cssProblems(m[2])) rows.push({ path: f.path, line: lineAt(t, m.index! + m[1].length + p.index), problem: p.problem, severity: p.severity, where: 'Style block' });
    for (const m of t.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) for (const d of m[1].split(';')) { const x = d.trim(); if (x && !x.includes(':')) { rows.push({ path: f.path, line: lineAt(t, m.index!), problem: `Inline style declaration without a colon: "${x.slice(0, 40)}"`, severity: 'error', where: 'style attribute' }); break; } }
  }
  for (const r of reportStyleLinks(site).rows) if (r.status === 'Missing') rows.push({ path: r.path, line: r.line, problem: `Linked style sheet not found: ${r.sheet}`, severity: 'error', where: 'Link' });
  return { id: 'css', title: 'CSS Problems', columns: [{ key: 'path', label: 'File', kind: 'path' }, { key: 'line', label: 'Line', kind: 'number' }, { key: 'where', label: 'Where' }, { key: 'problem', label: 'Problem' }], rows,
    note: 'A syntax sanity check. Unused classes have their own report.' };
}

export function reportSummary(site: Site, o: ReportOptions = {}): Report {
  const idx = linkIndex(site);
  const all = site.list();
  const size = (paths: string[]) => paths.reduce((s, p) => s + fileSize(site, p), 0);
  const pages = all.filter((f) => isPagePath(f.path)).map((f) => f.path);
  const pics = all.filter((f) => isImagePath(f.path)).map((f) => f.path);
  const unlinked = unlinkedFiles(site, idx);
  const slow = reportSlowPages(site, o, idx).rows;
  const now = o.now ?? Date.now();
  const older = all.filter((f) => now - f.modified > (o.days ?? 72) * DAY).map((f) => f.path);
  const added = all.filter((f) => now - f.created <= 30 * DAY).map((f) => f.path);
  const changed = all.filter((f) => now - f.modified <= 30 * DAY).map((f) => f.path);
  let internal = 0, broken = 0, external = 0;
  for (const l of idx.out.values()) for (const x of l) { internal++; if (!x.exists) broken++; }
  for (const l of idx.external.values()) external += l.length;
  const comp = reportComponentErrors(site).rows.length;
  const tasks = site.data.tasks.filter((t) => t.status !== 'Completed').length;
  const alt = reportMissingAlt(site).rows.length;
  const titles = reportMissingTitles(site).rows.length;
  const dups = reportDuplicateTitles(site).rows.length;
  const unused = reportUnusedStyles(site).rows.length;
  const checked = all.filter((f) => f.checkedOut).length;
  const row = (item: string, count: number, bytes: number | '', description: string, report?: string, bad = false): ReportRow => ({ item, count, size: bytes, description, report, severity: bad && count ? 'warning' : undefined });
  const rows: ReportRow[] = [
    row('All files', all.length, size(all.map((f) => f.path)), 'All files in the site', 'allFiles'),
    row('Pages', pages.length, size(pages), 'Pages and page templates', 'allFiles'),
    row('Pictures', pics.length, size(pics), 'Picture files (GIF, JPEG, PNG, SVG, WebP…)', 'allFiles'),
    row('Unlinked files', unlinked.length, size(unlinked), 'Files that cannot be reached from the home page', 'unlinked', true),
    row('Linked files', all.length - unlinked.length, size(all.map((f) => f.path).filter((p) => !unlinked.includes(p))), 'Files that can be reached from the home page', 'allFiles'),
    row('Slow pages', slow.length, '', `Pages over ${o.kb ?? 500} KB with their files`, 'slowPages', true),
    row('Older files', older.length, size(older), `Files not changed in ${o.days ?? 72} days`, 'olderFiles'),
    row('Recently added files', added.length, size(added), 'Files added in the last 30 days', 'recentlyAdded'),
    row('Recently changed files', changed.length, size(changed), 'Files changed in the last 30 days', 'recentlyChanged'),
    row('Hyperlinks', internal + external, '', 'All links in pages and style sheets', 'externalLinks'),
    row('Broken internal links', broken, '', 'Links to files that are not in the site', 'brokenLinks', true),
    row('External links', external, '', 'Links to other sites (not verified)', 'externalLinks'),
    row('Component errors', comp, '', 'Includes, templates, library items and link bars with problems', 'componentErrors', true),
    row('Pictures without alternate text', alt, '', 'Pictures with no alt attribute', 'missingAlt', true),
    row('Pages without titles', titles, '', 'Pages with no or an empty title', 'missingTitles', true),
    row('Duplicate titles', dups, '', 'Pages that share a title', 'duplicateTitles', true),
    row('Unused styles', unused, '', 'Classes in style sheets that no page uses', 'unusedStyles'),
    row('Checked out files', checked, '', 'Files checked out', 'checkedOut'),
    row('Uncompleted tasks', tasks, '', 'Tasks not marked completed', undefined),
  ];
  return { id: 'summary', title: 'Site Summary', columns: [{ key: 'item', label: 'Name' }, { key: 'count', label: 'Count', kind: 'number' }, { key: 'size', label: 'Size', kind: 'size' }, { key: 'description', label: 'Description' }], rows };
}

/** Every report: id -> label and computation. */
export const REPORTS: { id: string; cmd: string; label: string; icon: string; ask?: 'days' | 'slow'; run: (site: Site, o: ReportOptions) => Report }[] = [
  { id: 'summary', cmd: 'site.reportSummary', label: 'Site Summary', icon: 'summarize', run: reportSummary },
  { id: 'allFiles', cmd: 'site.reportAllFiles', label: 'All Files', icon: 'list', run: (s) => reportAllFiles(s) },
  { id: 'recentlyAdded', cmd: 'site.reportRecentlyAdded', label: 'Recently Added Files', icon: 'new_releases', ask: 'days', run: reportRecentlyAdded },
  { id: 'recentlyChanged', cmd: 'site.reportRecentlyChanged', label: 'Recently Changed Files', icon: 'update', ask: 'days', run: reportRecentlyChanged },
  { id: 'olderFiles', cmd: 'site.reportOlderFiles', label: 'Older Files', icon: 'history', ask: 'days', run: reportOlderFiles },
  { id: 'unlinked', cmd: 'site.reportUnlinked', label: 'Unlinked Files', icon: 'link_off', run: (s) => reportUnlinked(s) },
  { id: 'slowPages', cmd: 'site.reportSlowPages', label: 'Slow Pages', icon: 'speed', ask: 'slow', run: (s, o) => reportSlowPages(s, o) },
  { id: 'brokenLinks', cmd: 'site.reportBrokenLinks', label: 'Broken Hyperlinks', icon: 'link_off', run: (s, o) => reportBrokenLinks(s, o) },
  { id: 'externalLinks', cmd: 'site.reportExternalLinks', label: 'External Hyperlinks', icon: 'open_in_new', run: (s, o) => reportExternalLinks(s, o) },
  { id: 'componentErrors', cmd: 'site.reportComponentErrors', label: 'Component Errors', icon: 'extension_off', run: (s) => reportComponentErrors(s) },
  { id: 'missingAlt', cmd: 'site.reportMissingAlt', label: 'Missing Alternate Text', icon: 'hide_image', run: (s) => reportMissingAlt(s) },
  { id: 'missingTitles', cmd: 'site.reportMissingTitles', label: 'Pages Without Titles', icon: 'title', run: (s) => reportMissingTitles(s) },
  { id: 'duplicateTitles', cmd: 'site.reportDuplicateTitles', label: 'Duplicate Titles', icon: 'content_copy', run: (s) => reportDuplicateTitles(s) },
  { id: 'unusedStyles', cmd: 'site.reportUnusedStyles', label: 'Unused Styles', icon: 'format_paint', run: (s) => reportUnusedStyles(s) },
  { id: 'styleLinks', cmd: 'site.reportStyleLinks', label: 'Style Sheet Links', icon: 'css', run: (s) => reportStyleLinks(s) },
  { id: 'templates', cmd: 'site.reportTemplates', label: 'Page Templates', icon: 'dashboard', run: (s) => reportTemplates(s) },
  { id: 'checkedOut', cmd: 'site.reportCheckedOut', label: 'Checked Out Files', icon: 'lock', run: (s) => reportCheckedOut(s) },
  { id: 'reviewStatus', cmd: 'site.reportReviewStatus', label: 'Review Status', icon: 'rate_review', run: (s) => reportReviewStatus(s) },
  { id: 'assignedTo', cmd: 'site.reportAssignedTo', label: 'Assigned To', icon: 'assignment_ind', run: (s) => reportAssignedTo(s) },
  { id: 'categories', cmd: 'site.reportCategories', label: 'Categories', icon: 'category', run: (s) => reportCategories(s) },
  { id: 'publishStatus', cmd: 'site.reportPublishStatus', label: 'Publish Status', icon: 'cloud_sync', run: (s, o) => reportPublishStatus(s, o) },
  { id: 'seo', cmd: 'site.reportSeo', label: 'Search Optimization (SEO)', icon: 'travel_explore', run: (s) => reportSeo(s) },
  { id: 'accessibility', cmd: 'site.reportAccessibility', label: 'Accessibility', icon: 'accessibility_new', run: (s) => reportAccessibility(s) },
  { id: 'compatibility', cmd: 'site.reportCompatibility', label: 'Compatibility', icon: 'devices', run: (s) => reportCompatibility(s) },
  { id: 'css', cmd: 'site.reportCss', label: 'CSS Problems', icon: 'css', run: (s) => reportCss(s) },
];

export function runReport(site: Site, id: string, o: ReportOptions = {}): Report {
  const r = REPORTS.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown report ${id}`);
  return r.run(site, o);
}

/** A report as CSV text (for "Save report"). */
export function reportCsv(r: Report): string {
  const q = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const fmt = (c: ReportColumn, v: any) => (c.kind === 'date' && typeof v === 'number' ? new Date(v).toISOString() : v);
  return [r.columns.map((c) => q(c.label)).join(','), ...r.rows.map((row) => r.columns.map((c) => q(fmt(c, row[c.key]))).join(','))].join('\n');
}

// ------------------------------------------------------------------------------------------
// Navigation structure

export function ensureNav(site: Site): NavNode {
  if (!site.data.nav) site.data.nav = defaultNav(site);
  return site.data.nav;
}

/** Adds `path` under `parentPath` (the root when missing). Returns false when it is already in the tree. */
export function navAdd(nav: NavNode, path: string, parentPath?: string, label?: string): boolean {
  if (findNav(nav, path)) return false;
  const parent = (parentPath && findNav(nav, parentPath)?.node) || nav;
  parent.children.push({ path, label, children: [] });
  return true;
}

/** Removes a page (its children move up to its parent). The root cannot be removed. */
export function navRemove(nav: NavNode, path: string, withChildren = false): boolean {
  const r = findNav(nav, path);
  if (!r || !r.parent) return false;
  const i = r.parent.children.indexOf(r.node);
  r.parent.children.splice(i, 1, ...(withChildren ? [] : r.node.children));
  return true;
}

export function navMove(nav: NavNode, path: string, delta: -1 | 1): boolean {
  const r = findNav(nav, path);
  if (!r?.parent) return false;
  const a = r.parent.children, i = a.indexOf(r.node), j = i + delta;
  if (j < 0 || j >= a.length) return false;
  [a[i], a[j]] = [a[j], a[i]];
  return true;
}

/** Makes a page a child of its previous sibling. */
export function navIndent(nav: NavNode, path: string): boolean {
  const r = findNav(nav, path);
  if (!r?.parent) return false;
  const a = r.parent.children, i = a.indexOf(r.node);
  if (i <= 0) return false;
  a.splice(i, 1);
  a[i - 1].children.push(r.node);
  return true;
}

/** Moves a page up one level, after its parent. */
export function navOutdent(nav: NavNode, path: string): boolean {
  const r = findNav(nav, path);
  if (!r?.parent) return false;
  const gp = findNav(nav, r.parent.path)?.parent;
  if (!gp) return false;
  r.parent.children.splice(r.parent.children.indexOf(r.node), 1);
  gp.children.splice(gp.children.indexOf(r.parent) + 1, 0, r.node);
  return true;
}

/** Moves `path` to be a child of `parentPath` (at `index`), refusing to move a page into its own subtree. */
export function navReparent(nav: NavNode, path: string, parentPath: string, index?: number): boolean {
  const r = findNav(nav, path);
  const target = findNav(nav, parentPath)?.node;
  if (!r?.parent || !target || findNav(r.node, parentPath)) return false;
  r.parent.children.splice(r.parent.children.indexOf(r.node), 1);
  target.children.splice(index ?? target.children.length, 0, r.node);
  return true;
}

export function navLabel(site: Site, n: NavNode): string { return n.label || pageTitle(site, n.path); }

/** Ancestors of a page from the root down to the page itself (empty when it is not in the tree). */
export function navTrail(nav: NavNode, path: string): NavNode[] {
  const walk = (n: NavNode, acc: NavNode[]): NavNode[] | null => {
    const next = [...acc, n];
    if (n.path === path) return next;
    for (const c of n.children) { const r = walk(c, next); if (r) return r; }
    return null;
  };
  return walk(nav, []) || [];
}

/** The pages a link bar of `mode` shows on `pagePath`. */
export function linkBarItems(nav: NavNode, pagePath: string, mode: LinkBarMode, opts: { home?: boolean; parent?: boolean } = {}): NavNode[] {
  const r = findNav(nav, pagePath);
  switch (mode) {
    case 'children': return r ? [...(opts.parent && r.parent ? [r.parent] : []), ...r.node.children] : [];
    case 'siblings': return r ? (r.parent ? [...(opts.home ? [nav] : []), ...r.parent.children] : [r.node]) : [];
    case 'top': return [...(opts.home === false ? [] : [nav]), ...nav.children];
    case 'breadcrumbs': { const t = navTrail(nav, pagePath); return t.length ? t : [nav]; }
  }
}

const LINKBAR_RE = /(<nav\b[^>]*\bdata-ql-linkbar\s*=\s*["']([^"']*)["'][^>]*>)([\s\S]*?)(<\/nav>)/gi;

/** The inner markup of one link bar. */
export function linkBarMarkup(site: Site, nav: NavNode, pagePath: string, openTag: string, oldInner: string): string {
  const mode = (/data-ql-linkbar\s*=\s*["']([^"']*)["']/i.exec(openTag)?.[1] || 'top') as LinkBarMode;
  const flag = (name: string) => { const v = new RegExp(`data-ql-${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(openTag)?.[1]; return v == null ? undefined : v !== 'false' && v !== '0'; };
  const items = linkBarItems(nav, pagePath, (LINKBAR_MODES as readonly string[]).includes(mode) ? mode : 'top', { home: flag('home'), parent: flag('parent') });
  const ulOpen = /<(ul|ol)\b[^>]*>/i.exec(oldInner)?.[0] || (mode === 'breadcrumbs' ? '<ol>' : '<ul>');
  const tag = /^<ol/i.test(ulOpen) ? 'ol' : 'ul';
  const lead = /^\s*/.exec(oldInner)![0], trail = oldInner.trim() ? /\s*$/.exec(oldInner)![0] : '';
  const lis = items.map((n) => {
    const label = esc(navLabel(site, n));
    if (n.path === pagePath) return `<li class="ql-current"><a href="${escAttr(relativeRef(pagePath, n.path))}" aria-current="page">${label}</a></li>`;
    return `<li><a href="${escAttr(relativeRef(pagePath, n.path))}">${label}</a></li>`;
  });
  return `${lead}${ulOpen}${lis.join('')}</${tag}>${trail}`;
}

/**
 * Rewrites the list inside every `<nav data-ql-linkbar="children|siblings|top|breadcrumbs">` of every page
 * from the navigation structure. Returns the pages that changed. Options in the nav tag:
 * `data-ql-home="false"` (top: leave out the home page; siblings: "true" adds it), `data-ql-parent="true"` (children: add the parent page).
 */
export function regenerateLinkBars(site: Site, only?: string[]): string[] {
  const changed: string[] = [];
  const pages = site.pages().filter((f) => (!only || only.includes(f.path)) && f.text && /data-ql-linkbar/i.test(f.text));
  if (!pages.length) return changed;
  const nav = ensureNav(site);
  for (const f of pages) {
    const out = f.text!.replace(LINKBAR_RE, (m, open, _mode, inner, close) => open + linkBarMarkup(site, nav, f.path, open, inner) + close);
    if (out !== f.text) { site.write(f.path, out); changed.push(f.path); }
  }
  return changed;
}

// ------------------------------------------------------------------------------------------
// Generated files

export function absoluteUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = path.split('/').map(encodeURIComponent).join('/');
  return `${base}/${p.replace(/(^|\/)index\.html?$/i, '$1')}`;
}

/** Pages that belong in a sitemap or search index: real pages, not templates, fragments, error pages or noindex pages. */
export function publicPages(site: Site): string[] {
  return site.pages().filter((f) => !f.noPublish && !/\.(dwt|lbi)$/i.test(f.path) && !/^(Templates|Library|_[^/]*)\//.test(f.path) && !/^404\.html?$/i.test(f.path)
    && !/<meta[^>]+name\s*=\s*["']robots["'][^>]+noindex/i.test(f.text ?? '')).map((f) => f.path);
}

export function sitemapXml(site: Site, baseUrl: string): string {
  const home = site.homePage;
  const urls = publicPages(site).sort((a, b) => (a === home ? -1 : b === home ? 1 : a.localeCompare(b))).map((p) => {
    const f = site.get(p)!;
    const depth = p.split('/').length - 1;
    const pri = p === home ? '1.0' : Math.max(0.3, 0.8 - depth * 0.2).toFixed(1);
    return `  <url>\n    <loc>${esc(absoluteUrl(baseUrl, p))}</loc>\n    <lastmod>${new Date(f.modified).toISOString().slice(0, 10)}</lastmod>\n    <priority>${pri}</priority>\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export function robotsTxt(site: Site, baseUrl: string, disallow: string[] = []): string {
  const lines = ['User-agent: *'];
  const dis = disallow.length ? disallow : site.folders().filter((d) => /^(Templates|Library|_private|_notes)$/i.test(d)).map((d) => `/${d}/`);
  if (dis.length) for (const d of dis) lines.push(`Disallow: ${d}`); else lines.push('Allow: /');
  if (baseUrl) lines.push('', `Sitemap: ${baseUrl.replace(/\/+$/, '')}/sitemap.xml`);
  return lines.join('\n') + '\n';
}

export function pageDescription(src: string, max = 300): string {
  const d = getMeta(src, 'description');
  if (d) return d;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(src)?.[1] ?? src;
  const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body.replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, ''))?.[1];
  const text = htmlToText(p || body).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : text;
}

/** Date of a page for feeds: <meta name="date"|"article:published_time">, <time datetime>, else the file's change time. */
export function pageDate(site: Site, path: string): number {
  const src = site.read(path) || '';
  const d = getMeta(src, 'date') || getMeta(src, 'article:published_time', 'property') || getMeta(src, 'dcterms.date') || /<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i.exec(src)?.[1];
  const t = d ? Date.parse(d) : NaN;
  return Number.isFinite(t) ? t : site.get(path)?.modified || Date.now();
}

export function rssFeed(site: Site, opts: { baseUrl: string; folder?: string; title?: string; description?: string; max?: number; lang?: string }): string {
  const dir = (opts.folder || '').replace(/^\/+|\/+$/g, '');
  const items = publicPages(site).filter((p) => !dir || p.startsWith(dir + '/')).filter((p) => !(dir && /^index\.html?$/i.test(p.slice(dir.length + 1))))
    .map((p) => ({ p, date: pageDate(site, p) })).sort((a, b) => b.date - a.date).slice(0, opts.max ?? 50);
  const base = opts.baseUrl.replace(/\/+$/, '');
  const x = (s: string) => esc(s).replace(/'/g, '&apos;');
  const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`, `<channel>`,
    `  <title>${x(opts.title || site.name)}</title>`, `  <link>${x(base + '/' + (dir ? dir + '/' : ''))}</link>`,
    `  <description>${x(opts.description || site.name)}</description>`, `  <language>${x(opts.lang || 'en-us')}</language>`,
    `  <atom:link href="${x(base + '/' + (dir ? dir + '/' : '') + 'feed.xml')}" rel="self" type="application/rss+xml"/>`,
    `  <lastBuildDate>${new Date(items[0]?.date || Date.now()).toUTCString()}</lastBuildDate>`];
  for (const { p, date } of items) {
    const url = absoluteUrl(base, p);
    out.push('  <item>', `    <title>${x(pageTitle(site, p))}</title>`, `    <link>${x(url)}</link>`, `    <guid>${x(url)}</guid>`, `    <pubDate>${new Date(date).toUTCString()}</pubDate>`, `    <description>${x(pageDescription(site.read(p) || ''))}</description>`, '  </item>');
  }
  out.push('</channel>', '</rss>', '');
  return out.join('\n');
}

export interface SearchEntry { url: string; title: string; description: string; text: string; headings: string[] }

export function searchIndex(site: Site, opts: { maxText?: number } = {}): SearchEntry[] {
  return publicPages(site).map((p) => {
    const src = site.read(p) || '';
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(src)?.[1] ?? src;
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1] ?? body.replace(/<(nav|header|footer|script|style)\b[\s\S]*?<\/\1>/gi, ' ');
    const text = htmlToText(main).replace(/\s+/g, ' ').trim();
    return { url: p, title: pageTitle(site, p), description: getMeta(src, 'description') || '', headings: [...body.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => htmlToText(m[1]).trim()).filter(Boolean), text: text.slice(0, opts.maxText ?? 5000) };
  });
}

/** Folders that hold pages (choices for the feed). */
export function pageFolders(site: Site): string[] {
  const s = new Set<string>(['']);
  for (const f of site.pages()) s.add(dirOf(f.path));
  return [...s].sort();
}

/** Profiles that have changes waiting (for the status bar and menus). */
export function changedCount(site: Site, profile: PublishProfile): number {
  return site.list((f) => !f.noPublish && (profile.published?.[f.path] ?? -1) < f.modified).length;
}
