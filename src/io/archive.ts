/**
 * Recognizes what a ZIP holds and turns it into an editable static site.
 *
 * Kinds: WordPress themes (classic: style.css "Theme Name:" header + index.php; block: theme.json +
 * templates/), Joomla templates (templateDetails.xml), Drupal themes (*.info.yml), Weebly themes ({content}
 * and {menu} tags) and Weebly site archives, HTML templates (free or bought: the template is often in a
 * subfolder next to documentation, sometimes in a ZIP inside the ZIP), and plain sites.
 */
import JSZip from 'jszip';
import type { Site } from '../model/site';
import { baseName, dirOf, extOf, normalizePath } from '../model/paths';
import { SKIP_RE } from '../site/io';
import { textOf, subtree, detectFrameworks, detectBuilder } from './common';
import { importWordPressTheme } from './wpTheme';
import { joomlaTemplateToSite, drupalThemeToSite, drupalInfo } from './joomla';
import { importWeeblyTheme, importWeeblyArchive, isWeeblyTheme, isWeeblyArchive } from './weebly';
import { Site as SiteClass } from '../model/site';

export type ArchiveKind = 'wp-theme' | 'joomla-template' | 'weebly-theme' | 'weebly-archive' | 'drupal-theme' | 'html-template' | 'site';

export const ARCHIVE_LABELS: Record<ArchiveKind, string> = {
  'wp-theme': 'WordPress theme',
  'joomla-template': 'Joomla template',
  'weebly-theme': 'Weebly theme',
  'weebly-archive': 'Weebly site archive',
  'drupal-theme': 'Drupal theme',
  'html-template': 'HTML template',
  site: 'Web site',
};

const DOC_DIR = /(^|\/)(docs?|documentation|documents?|help|guide|manual|psd|psds|sketch|figma|xd|design|source[-_ ]?files|screenshots?|previews?|licen[cs]es?|credits|__macosx)(\/|$)/i;

/** Folder holding a file named `name`, among all paths. */
function dirsWith(files: Map<string, Uint8Array>, test: (path: string) => boolean): string[] {
  return [...files.keys()].filter(test).map(dirOf);
}

/** The theme root for WordPress: the folder with a style.css theme header (and index.php or theme.json+templates). */
export function wpThemeRoot(files: Map<string, Uint8Array>): string | null {
  const cands = dirsWith(files, (p) => baseName(p) === 'style.css' && /Theme Name\s*:/i.test(textOf(files.get(p)).slice(0, 4000)));
  for (const d of cands.sort((a, b) => a.length - b.length)) {
    const pre = d ? d + '/' : '';
    if (files.has(pre + 'index.php') || (files.has(pre + 'theme.json') && [...files.keys()].some((k) => k.startsWith(pre + 'templates/') || k.startsWith(pre + 'block-templates/')))) return d;
  }
  return null;
}

function joomlaRoot(files: Map<string, Uint8Array>): string | null {
  const d = dirsWith(files, (p) => baseName(p).toLowerCase() === 'templatedetails.xml' && /type\s*=\s*["']template["']/i.test(textOf(files.get(p)))).sort((a, b) => a.length - b.length)[0];
  return d ?? null;
}

function drupalRoot(files: Map<string, Uint8Array>): string | null {
  const d = dirsWith(files, (p) => /\.info\.yml$/.test(p) && /type:\s*theme/.test(textOf(files.get(p)))).sort((a, b) => a.length - b.length)[0];
  return d ?? null;
}

/**
 * The folder that holds the actual HTML template: the one with an index.html (or the most pages) and the
 * most assets beneath it, skipping documentation, design sources and preview folders, preferring built
 * output (dist/, build/, html/) over sources (src/).
 */
export function pickTemplateRoot(files: Map<string, Uint8Array>): string {
  const paths = [...files.keys()];
  const htmlDirs = new Set(paths.filter((p) => /\.html?$/i.test(p) && !DOC_DIR.test(p)).map(dirOf));
  if (!htmlDirs.size) return '';
  let best = '';
  let bestScore = -Infinity;
  for (const d of htmlDirs) {
    const pre = d ? d + '/' : '';
    const under = paths.filter((p) => p.startsWith(pre) && !DOC_DIR.test(p.slice(pre.length)));
    const pages = under.filter((p) => /\.html?$/i.test(p) && dirOf(p) === d).length;
    const assets = under.filter((p) => /\.(css|js|png|jpe?g|gif|svg|webp|woff2?|ttf)$/i.test(p)).length;
    let score = pages * 5 + assets + (paths.includes(pre + 'index.html') || paths.includes(pre + 'index.htm') ? 40 : 0);
    if (/(^|\/)(dist|build|public|html|www|site|template|templates?-?files?|main[-_ ]?files?)$/i.test(d)) score += 15;
    if (/(^|\/)(src|source|dev|pug|scss|sass)(\/|$)/i.test(d)) score -= 25;
    if (/(^|\/)(rtl|demo\d*|preview)(\/|$)/i.test(d)) score -= 10;
    score -= d.split('/').filter(Boolean).length * 2;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Replaces a lone inner ZIP (or the most template-like of several) with its contents. */
export async function unwrapArchive(files: Map<string, Uint8Array>, depth = 0): Promise<{ files: Map<string, Uint8Array>; inner?: string }> {
  if (depth > 3) return { files };
  const keys = [...files.keys()];
  const zips = keys.filter((k) => extOf(k) === 'zip');
  if (!zips.length) return { files };
  const hasWork = keys.some((k) => /\.(html?|php|twig)$/i.test(k) && !DOC_DIR.test(k)) || keys.some((k) => baseName(k) === 'style.css');
  if (hasWork && keys.filter((k) => !DOC_DIR.test(k) && extOf(k) !== 'zip').length > 5) return { files };
  const rank = (z: string) => {
    const n = z.toLowerCase();
    let s = 0;
    if (DOC_DIR.test(n) || /doc|psd|sketch|figma|license|child|demo-?content|sample-?data|plugins?\//.test(n)) s -= 50;
    if (/theme|template|html|site|dist|main|package|files/.test(baseName(n))) s += 20;
    s += Math.min(30, (files.get(z)!.length / 100000) | 0);
    return s;
  };
  const pick = zips.sort((a, b) => rank(b) - rank(a))[0];
  const inner = await JSZip.loadAsync(files.get(pick)!);
  const out = new Map<string, Uint8Array>();
  for (const e of Object.values(inner.files)) {
    if (e.dir || SKIP_RE.test(e.name)) continue;
    out.set(normalizePath(e.name), await e.async('uint8array'));
  }
  const r = await unwrapArchive(out, depth + 1);
  return { files: r.files, inner: pick + (r.inner ? ' ▸ ' + r.inner : '') };
}

export function detectArchive(files: Map<string, Uint8Array>): ArchiveKind {
  if (wpThemeRoot(files) !== null) return 'wp-theme';
  if (joomlaRoot(files) !== null) return 'joomla-template';
  if (drupalRoot(files) !== null) return 'drupal-theme';
  if (isWeeblyTheme(files) !== null) return 'weebly-theme';
  if (isWeeblyArchive(files)) return 'weebly-archive';
  const keys = [...files.keys()];
  const html = keys.filter((k) => /\.html?$/i.test(k));
  if (!html.length) return 'site';
  const root = pickTemplateRoot(files);
  const rootIndex = keys.includes('index.html') || keys.includes('index.htm');
  const docs = keys.some((k) => DOC_DIR.test(k));
  const sample = html.slice(0, 6).map((k) => textOf(files.get(k)).slice(0, 20000));
  const credit = detectBuilder(keys, sample) || keys.some((k) => /(^|\/)(license|licence|readme|credits)(\.(txt|md|html?))?$/i.test(k));
  if (root || !rootIndex || docs || credit) return 'html-template';
  return 'site';
}

function plainSite(name: string, files: Map<string, Uint8Array>): Site {
  const s = new SiteClass(name);
  for (const [p, v] of files) if (p) s.write(p, v, { silent: true });
  return s;
}

export async function siteFromArchive(name: string, files0: Map<string, Uint8Array>, kind?: ArchiveKind): Promise<{ site: Site; report: string[]; open?: string }> {
  const unwrapped = await unwrapArchive(files0);
  const files = unwrapped.files;
  const k = kind && (kind !== 'site' || !unwrapped.inner) ? kind : detectArchive(files);
  const pre: string[] = [];
  if (unwrapped.inner) pre.push(`The archive held another archive; used ${unwrapped.inner}.`);
  const base = name.replace(/\.zip$/i, '');
  const finish = (r: { site: Site; report: string[]; open?: string }, root: string) => {
    if (root) pre.push(`Used the folder "${root}/" of the archive.`);
    r.site.data.meta['import:kind'] = k;
    return { ...r, report: [...pre, ...r.report] };
  };
  switch (k) {
    case 'wp-theme': {
      const root = wpThemeRoot(files);
      if (root === null) throw new Error('No WordPress theme (style.css with a "Theme Name:" header) was found in the archive.');
      return finish(importWordPressTheme(baseName(root) || base, subtree(files, root)), root);
    }
    case 'joomla-template': {
      const root = joomlaRoot(files);
      if (root === null) throw new Error('No Joomla template (templateDetails.xml) was found in the archive.');
      return finish(joomlaTemplateToSite(baseName(root) || base, subtree(files, root)), root);
    }
    case 'drupal-theme': {
      const root = drupalRoot(files);
      if (root === null || !drupalInfo(subtree(files, root))) throw new Error('No Drupal theme (*.info.yml) was found in the archive.');
      return finish(drupalThemeToSite(baseName(root) || base, subtree(files, root)), root);
    }
    case 'weebly-theme': {
      const root = isWeeblyTheme(files);
      if (root === null) throw new Error('No Weebly theme files ({content} and {menu} tags) were found in the archive.');
      return finish(importWeeblyTheme(baseName(root) || base, subtree(files, root)), root);
    }
    case 'weebly-archive': {
      const root = commonDir(files);
      return finish(importWeeblyArchive(base, subtree(files, root)), root);
    }
    case 'html-template': {
      const root = pickTemplateRoot(files);
      const sub = subtree(files, root);
      const site = plainSite(baseName(root) && !/^(html|dist|build|public|www|template)$/i.test(baseName(root)) ? baseName(root) : base, sub);
      const report = templateReport(site, files, root);
      return finish({ site, report, open: site.homePage }, root);
    }
    default: {
      const root = commonDir(files);
      const site = plainSite(baseName(root) || base, subtree(files, root));
      const pages = site.pages().length;
      return finish({ site, report: [`${site.files.size} file(s), ${pages} page(s).`], open: site.homePage }, root);
    }
  }
}

function commonDir(files: Map<string, Uint8Array>): string {
  const keys = [...files.keys()];
  if (!keys.length) return '';
  let pre = dirOf(keys[0]);
  for (const k of keys) while (pre && !k.startsWith(pre + '/')) pre = dirOf(pre);
  return pre;
}

function templateReport(site: Site, all: Map<string, Uint8Array>, root: string): string[] {
  const report: string[] = [];
  const pages = site.pages().map((f) => f.path);
  report.push(`HTML template with ${pages.length} page(s): ${pages.slice(0, 15).join(', ')}${pages.length > 15 ? ', …' : ''}.`);
  const texts = pages.slice(0, 8).map((p) => site.read(p) || '');
  const builder = detectBuilder([...site.files.keys()], texts);
  if (builder) report.push(`Made with or published as: ${builder}.`);
  const fw = detectFrameworks([...site.files.keys()], texts);
  if (fw.length) report.push(`Uses: ${fw.join(', ')}.`);
  const outside = [...all.keys()].filter((k) => root ? !k.startsWith(root + '/') : false);
  const docs = [...new Set(outside.map((k) => k.split('/').slice(0, root.split('/').length).join('/')))];
  if (outside.length) report.push(`Left out ${outside.length} file(s) outside the template folder (${docs.slice(0, 6).join(', ')}${docs.length > 6 ? ', …' : ''}), such as documentation and design sources.`);
  const cdn = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^/"']+)/gi)) cdn.add(m[1].replace(/^https?:\/\//, ''));
  if (cdn.size) report.push(`Loads files from other servers: ${[...cdn].slice(0, 8).join(', ')}${cdn.size > 8 ? ', …' : ''}.`);
  if ([...site.files.keys()].some((k) => /\.(scss|sass|less|pug)$/i.test(k))) report.push('Source files (Sass/LESS/Pug) are included; pages use the compiled CSS, so edit that or recompile with the template\'s own tools.');
  if ([...site.files.keys()].some((k) => /\.php$/i.test(k))) report.push('Some files are PHP (for example a contact form handler); they need a PHP server to work.');
  const lic = [...site.files.keys()].find((k) => /(^|\/)(license|licence)(\.(txt|md|html?))?$/i.test(k));
  report.push(`Check the template's license${lic ? ` (${lic})` : ''}: free templates often require a visible credit link (for example CC BY 3.0), and paid templates are licensed to the buyer for a set number of sites.`);
  return report;
}
