/**
 * Wix sites. Wix has no file export: its published pages are rendered by Wix's own scripts. What can be
 * done honestly:
 *  - Import: read the HTML the server sends for published pages (text, pictures, much of the layout as
 *    inline styles), remove Wix's runtime scripts, and keep pictures as links to Wix's media servers.
 *  - Export: a page as one self-contained HTML document to paste into an "Embed HTML" (iframe) element,
 *    or as a custom element (web component) script for a Velo "Custom Element".
 */
import type { Site } from '../model/site';
import { b64 } from '../model/site';
import { escAttr, getTitle, linkedStyles, regions } from '../model/html';
import { mimeOf, resolveRef, slugify } from '../model/paths';
import { rewriteRefs } from '../model/site';
import { detachTemplate, expandIncludes } from '../site/templates';
import { fetchSite } from './fetchSite';

const WIX_SCRIPT = /parastorage\.com|wixstatic\.com|wix\.com|thunderbolt|wix-|viewerModel|wixBiSession|fedops|sentry|clientSideRender|wixCodeNamespacesRegistry|__INITIAL_STATE__|requirejs|bolt/i;

export function isWixHtml(html: string): boolean { return /static\.parastorage\.com|wixstatic\.com|X-Wix-|wix-warmup-data|<meta[^>]+generator[^>]+Wix/i.test(html); }

export async function importWixSite(url: string, opts: { maxPages?: number; log?: (s: string) => void } = {}): Promise<{ site: Site; report: string[]; open?: string }> {
  let isWix = false;
  const r = await fetchSite(url, {
    maxPages: opts.maxPages ?? 10,
    binaries: false,
    log: opts.log,
    dropScript: (src, code) => !!src || WIX_SCRIPT.test(code) || code.length > 2000,
    clean: (html) => {
      if (isWixHtml(html)) isWix = true;
      return html
        .replace(/<link\b[^>]*rel\s*=\s*["'](?:preload|prefetch|modulepreload|preconnect|dns-prefetch)["'][^>]*>\s*/gi, '')
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, (m) => (/<img\b/i.test(m) ? m.replace(/<\/?noscript[^>]*>/gi, '') : ''))
        .replace(/\s(?:data-testid|data-mesh-id|data-hook)\s*=\s*["'][^"']*["']/gi, '');
    },
  });
  r.report.unshift(isWix
    ? 'Wix pages are built in the browser by Wix\'s own scripts, so this copy holds what the server sends: text, pictures (still on Wix\'s servers) and most of the layout as inline styles. Menus that open, galleries, forms, stores, members areas and animations do not work without Wix and need to be rebuilt.'
    : 'This does not look like a Wix site; the pages were saved as they are.');
  r.report.push('Wix scripts were removed. Pictures stay as links to Wix\'s media server; download the ones you need and replace them before the old site goes away.');
  return r;
}

/** The page as one document: linked style sheets inlined, site pictures as data: URLs (or absolute URLs from `baseUrl`). */
export function selfContainedPage(site: Site, pagePath: string, opts: { baseUrl?: string; scripts?: boolean } = {}): string {
  let src = detachTemplate(expandIncludes(site, pagePath, site.read(pagePath) || ''));
  const asUrl = (target: string): string | null => {
    if (!site.has(target)) return null;
    if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '') + '/' + target;
    const f = site.get(target)!;
    return `data:${f.mime || mimeOf(target)};base64,${b64(site.bytes(target)!)}`;
  };
  // Style sheets → <style>, with their url() made absolute or data:.
  const inlineCss = (css: string, from: string, depth = 0): string => css
    .replace(/@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?\s*;/gi, (m, ref: string) => { const t = resolveRef(from, ref); return t && site.has(t) && depth < 5 ? inlineCss(site.read(t) || '', t, depth + 1) : m; })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, ref: string) => { const t = resolveRef(from, ref); const u = t && asUrl(t); return u ? `url("${u}")` : m; });
  for (const href of linkedStyles(src)) {
    const t = resolveRef(pagePath, href);
    if (!t || !site.has(t)) continue;
    const css = inlineCss(site.read(t) || '', t);
    src = src.replace(new RegExp(`<link\\b[^>]*href\\s*=\\s*["']${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i'), `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`);
  }
  src = src.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, z) => a + inlineCss(css, pagePath) + z);
  // Scripts from the site → inline.
  src = src.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (m, a, ref: string, z) => {
    const t = resolveRef(pagePath, ref);
    if (!t || !site.has(t)) return m;
    if (opts.scripts === false) return '';
    return `<script${a}${z}>\n${(site.read(t) || '').replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });
  // Pictures and other resources.
  src = rewriteRefs(src, pagePath, (t, ref) => {
    if (/\.(html?|php)$/i.test(t)) return opts.baseUrl ? opts.baseUrl.replace(/\/+$/, '') + '/' + t : null;
    void ref;
    return asUrl(t);
  });
  // Links open outside the embed's frame.
  if (!/<base\b/i.test(src)) src = src.replace(/<head([^>]*)>/i, '<head$1>\n<base target="_top">');
  return src;
}

export function exportEmbed(site: Site, pagePath: string, opts: { baseUrl?: string } = {}): { html: string; bytes: number; notes: string[] } {
  const html = selfContainedPage(site, pagePath, opts);
  const bytes = new TextEncoder().encode(html).length;
  const notes = [
    `The code is ${(bytes / 1024).toFixed(0)} KB.${bytes > 200 * 1024 ? ' That is large for an embed: pictures as data: URLs make it big and slow. Publish the pictures somewhere and export again with their web address.' : ''}`,
    'In the Wix editor: Add ▸ Embed Code ▸ Embed HTML, choose "Code", paste, and size the element. The embed runs in its own frame, so it does not take on the Wix page\'s styles, and search engines see little of it.',
  ];
  return { html, bytes, notes };
}

/** A custom element (web component) script: the page's body and styles inside a shadow root. */
export function exportVelo(site: Site, pagePath: string, opts: { tagName?: string; baseUrl?: string } = {}): { js: string; tagName: string; notes: string[] } {
  const doc = selfContainedPage(site, pagePath, { ...opts, scripts: false });
  const r = regions(doc);
  const head = r.headOpen && r.headClose >= 0 ? doc.slice(r.headOpen[1], r.headClose) : '';
  const styles = [...head.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]).join('\n');
  const fonts = [...head.matchAll(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["'](https?:[^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  const body = r.bodyOpen ? doc.slice(r.bodyOpen[1], r.bodyClose >= 0 ? r.bodyClose : undefined) : doc;
  let tag = (opts.tagName || `ql-${slugify(getTitle(doc) || 'page')}`).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!tag.includes('-')) tag = 'ql-' + tag;
  const cls = tag.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('').replace(/^\d/, 'X$&');
  const markup = (styles + '\n' + body.replace(/<script\b[\s\S]*?<\/script>/gi, '')).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const js = `// Custom element <${tag}> — generated by Anne\'s Loom from ${pagePath}.
// Wix: Add ▸ Embed Code ▸ Custom Element, choose "Velo file" as the source, pick this file (in the
// public/custom-elements folder of the site code) and enter the tag name "${tag}".
const TEMPLATE = \`${markup}\`;
const FONTS = ${JSON.stringify(fonts)};

class ${cls} extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    for (const href of FONTS) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      root.appendChild(link);
    }
    const wrap = document.createElement('div');
    wrap.className = 'ql-root';
    wrap.innerHTML = TEMPLATE;
    root.appendChild(wrap);
  }
}

if (!customElements.get('${tag}')) customElements.define('${tag}', ${cls});
`;
  const notes = [
    `Tag name: ${tag}. Styles are scoped to the element; rules written for "body" or "html" apply to nothing inside a shadow root, so check them (use ".ql-root" or ":host").`,
    'Scripts of the page are not included; Velo code can talk to the element through attributes.',
  ];
  return { js, tagName: tag, notes };
}

export const HOW_TO: { title: string; steps: string[] }[] = [
  {
    title: 'Move content into Wix',
    steps: [
      'Wix has no import for HTML pages. Recreate each page in the Wix editor, and paste text and pictures from Design view.',
      'For parts that must look exactly like your page, use Export ▸ Wix Embed and add it with Add ▸ Embed Code ▸ Embed HTML ("Code").',
      'With Velo turned on, use Export ▸ Wix Custom Element, save the file in public/custom-elements and add Embed Code ▸ Custom Element with the given tag name.',
      'Upload pictures to the Wix Media Manager instead of embedding them as data: URLs when they are large.',
    ],
  },
  {
    title: 'Move content into Weebly',
    steps: [
      'Export ▸ Weebly Theme makes a custom theme from your page design (header, menu, footer and style sheet).',
      'In Weebly: Theme ▸ Edit HTML / CSS, add the files, and pick the header type for each page.',
      'Copy each page\'s content into Weebly\'s editor, or paste it into an Embed Code element.',
      'To bring a Weebly site here, download its archive in Weebly and use Import ▸ Weebly Site Archive.',
    ],
  },
  {
    title: 'Move content into WordPress',
    steps: [
      'Export ▸ WordPress Export (.xml) writes your pages as WordPress pages (or posts) with their menu. In WordPress: Tools ▸ Import ▸ WordPress, then choose the file.',
      'Or use Publish to WordPress to create and update pages directly, with an application password (Users ▸ Profile ▸ Application Passwords).',
      'Export ▸ WordPress Theme turns the site\'s design into a classic theme: Appearance ▸ Themes ▸ Add New ▸ Upload Theme.',
      'For a single page, Export ▸ WordPress Blocks gives block markup to paste into the block editor\'s Code editor view.',
    ],
  },
];

void escAttr;

/** Same as importWixSite (name used by the command). */
export const importFromUrl = importWixSite;
