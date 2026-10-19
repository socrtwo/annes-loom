/**
 * Downloads published pages with their style sheets, scripts and pictures.
 *
 * The desktop app reads any https address through its main process (no CORS). The browser version can only
 * read sites that allow cross-origin requests, which most do not; then the honest fallback is to save the
 * page from the browser as "Web Page, Single File (.mht)" and import that archive.
 *
 * Binary files (pictures, fonts) need a byte-safe transport. The desktop bridge's http call returns text;
 * with `binary: true` it returns the body as base64, so pictures and fonts are saved,
 * otherwise they stay as links to the original server.
 */
import { Site, unb64 } from '../model/site';
import { extOf, joinPath, relativeRef, isImagePath } from '../model/paths';
import { desktopHttp } from '../platform/native';
import { detectFrameworks } from './common';

export const CORS_HELP = 'This web site does not let other sites read it from a browser (it sends no CORS permission). Use the desktop app, or open the page in your browser, choose Save Page As ▸ "Web Page, Single File (*.mht, *.mhtml)" (Chrome and Edge), and import the file with File ▸ Import ▸ Web Archive.';

export class CorsError extends Error { constructor(url: string) { super(`${CORS_HELP}\n(${url})`); this.name = 'CorsError'; } }

export interface HttpResult { status: number; text: string; bytes?: Uint8Array; headers?: Record<string, string> }

/** One HTTP request through the desktop bridge when present, else fetch(). Throws CorsError when the browser blocks it. */
export async function httpRequest(o: { url: string; method?: string; headers?: Record<string, string>; body?: string | Uint8Array; binary?: boolean }): Promise<HttpResult> {
  const method = o.method || 'GET';
  const headers = o.headers || {};
  const viaFetch = async (): Promise<HttpResult> => {
    const res = await fetch(o.url, { method, headers, body: o.body as BodyInit | undefined, mode: 'cors', credentials: 'omit', redirect: 'follow' });
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    if (o.binary) { const bytes = new Uint8Array(await res.arrayBuffer()); return { status: res.status, text: '', bytes, headers: h }; }
    return { status: res.status, text: await res.text(), headers: h };
  };
  if (desktopHttp && /^https:/i.test(o.url) && (typeof o.body !== 'object' || o.body == null)) {
    try {
      const r = await desktopHttp({ url: o.url, method, headers, data: o.body, binary: !!o.binary });
      if (o.binary) {
        if (typeof r.data === 'string') return { status: r.status, text: '', bytes: unb64(r.data), headers: r.headers };
        // The bridge returned text only: bytes would be damaged. Try the renderer, which works where CORS allows.
        try { return await viaFetch(); } catch { return { status: 0, text: '' }; }
      }
      return { status: r.status, text: r.text, headers: r.headers };
    } catch (e) { if (!o.binary) throw e; }
  }
  try { return await viaFetch(); } catch (e) {
    if (e instanceof TypeError) throw new CorsError(o.url);
    throw e;
  }
}

export async function fetchText(url: string): Promise<string> {
  const r = await httpRequest({ url });
  if (r.status >= 400) throw new Error(`${url} answered ${r.status}.`);
  return r.text;
}

// ------------------------------------------------------------------------------------------

export interface FetchSiteOptions {
  /** Pages to download, following same-site links (1 = only this page). */
  maxPages?: number;
  /** Download pictures, fonts and media (false keeps them as links to the original server). */
  binaries?: boolean;
  /** Remove scripts for which this returns true (src address or inline code). */
  dropScript?: (src: string, code: string) => boolean;
  /** Extra clean-up of each page's HTML before saving. */
  clean?: (html: string, url: string) => string;
  log?: (line: string) => void;
  name?: string;
}

const PAGE_EXT = /^(|html?|php|aspx?|jsp|shtml|cfm)$/i;

/** Site path for a downloaded address. */
function localPath(u: URL, origin: string, isPage: boolean): string {
  let p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (u.origin !== origin) p = joinPath('_external', u.hostname, p);
  if (isPage) {
    if (!p || p.endsWith('/')) p = joinPath(p, 'index.html');
    else if (!/\.html?$/i.test(p)) p = p.replace(/\.(php|aspx?|jsp|shtml|cfm)$/i, '') + '.html';
  } else if (!p || p.endsWith('/')) p = joinPath(p, 'index');
  if (u.search) {
    let h = 0;
    for (const c of u.search) h = (h * 31 + c.charCodeAt(0)) | 0;
    const tag = (h >>> 0).toString(36);
    const e = extOf(p);
    p = e ? p.slice(0, -(e.length + 1)) + `_${tag}.${e}` : `${p}_${tag}`;
  }
  return p.replace(/[<>:"|?*]/g, '_');
}

const ATTR_RE = /(\s(?:src|href|poster|data-src|data-bg|background)\s*=\s*)(["'])([^"']*)\2/gi;
const SRCSET_RE = /(\s(?:srcset|data-srcset)\s*=\s*)(["'])([^"']*)\2/gi;
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(["'])([^"']+)\1/gi;

export async function fetchSite(url: string, opts: FetchSiteOptions = {}): Promise<{ site: Site; report: string[]; open?: string }> {
  const start = new URL(url);
  if (!/^https?:$/.test(start.protocol)) throw new Error('Enter an address that starts with https://');
  const origin = start.origin;
  const log = opts.log || (() => undefined);
  const report: string[] = [];
  const site = new Site(opts.name || start.hostname);
  const maxPages = Math.max(1, opts.maxPages ?? 1);
  const pages: string[] = [];
  const queue: string[] = [start.href.replace(/#.*$/, '')];
  const seenPages = new Set(queue);
  const assets = new Map<string, string>(); // absolute URL → local path, or '' when kept external
  const external = new Set<string>();
  const failed: string[] = [];
  let droppedScripts = 0;
  let binaryUnsupported = false;
  const urls = new Map<string, string>(); // page URL → local path

  const fetchAsset = async (abs: string, fromPage: boolean): Promise<string | null> => {
    void fromPage;
    if (assets.has(abs)) return assets.get(abs) || null;
    const u = new URL(abs);
    const local = localPath(u, origin, false);
    const isText = /\.(css|js|mjs|svg|json|txt)$/i.test(u.pathname);
    if (!isText && opts.binaries === false) { assets.set(abs, ''); external.add(abs); return null; }
    assets.set(abs, local);
    try {
      if (isText) {
        const r = await httpRequest({ url: abs });
        if (r.status >= 400) throw new Error(String(r.status));
        let text = r.text;
        if (/\.css$/i.test(u.pathname)) text = await rewriteCss(text, abs, local);
        site.write(local, text, { silent: true });
      } else {
        const r = await httpRequest({ url: abs, binary: true });
        if (!r.bytes || r.status === 0 || r.status >= 400) { if (r.status === 0) binaryUnsupported = true; throw new Error(String(r.status)); }
        site.write(local, r.bytes, { silent: true });
      }
      return local;
    } catch {
      assets.set(abs, '');
      failed.push(abs);
      external.add(abs);
      return null;
    }
  };

  const rewriteCss = async (css: string, base: string, cssPath: string): Promise<string> => {
    const refs = new Set<string>();
    for (const m of css.matchAll(CSS_URL)) refs.add(m[2]);
    for (const m of css.matchAll(CSS_IMPORT)) refs.add(m[2]);
    const map = new Map<string, string>();
    for (const r of refs) {
      if (/^(data:|#)/i.test(r)) continue;
      let abs: string;
      try { abs = new URL(r, base).href; } catch { continue; }
      const l = await fetchAsset(abs, false);
      map.set(r, l ? relativeRef(cssPath, l) : abs);
    }
    return css.replace(CSS_URL, (m, q, r) => (map.has(r) ? `url(${q}${map.get(r)}${q})` : m)).replace(CSS_IMPORT, (m, q, r) => (map.has(r) ? `@import ${q}${map.get(r)}${q}` : m));
  };

  while (queue.length && pages.length < maxPages) {
    const pageUrl = queue.shift()!;
    log(`Reading ${pageUrl}`);
    let html: string;
    try {
      const r = await httpRequest({ url: pageUrl, headers: { Accept: 'text/html,application/xhtml+xml' } });
      if (r.status >= 400) throw new Error(`${pageUrl} answered ${r.status}.`);
      html = r.text;
    } catch (e) {
      if (!pages.length) throw e;
      failed.push(pageUrl);
      continue;
    }
    const pu = new URL(pageUrl);
    const path = localPath(pu, origin, true);
    const base = /<base\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] || pageUrl;
    // Scripts.
    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs: string, code: string) => {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || '';
      if (/type\s*=\s*["']application\/(ld\+json|json)["']/i.test(attrs) && !src) return m;
      if (opts.dropScript?.(src, code)) { droppedScripts++; return ''; }
      return m;
    });
    if (opts.clean) html = opts.clean(html, pageUrl);
    // Resources referenced by the page.
    const refs: { ref: string; abs: string; isLink: boolean }[] = [];
    const absOf = (r: string) => { try { return new URL(r.replace(/&amp;/g, '&'), base).href.replace(/#.*$/, ''); } catch { return null; } };
    for (const m of html.matchAll(/<(a|link|img|script|source|video|audio|iframe|input|embed|track|image|use)\b[^>]*>/gi)) {
      const tag = m[1].toLowerCase();
      const t = m[0];
      if (tag === 'a') {
        const href = /\shref\s*=\s*["']([^"']+)["']/i.exec(t)?.[1];
        const a = href && absOf(href);
        if (a && a.startsWith(origin) && PAGE_EXT.test(extOf(new URL(a).pathname)) && !seenPages.has(a) && seenPages.size < maxPages * 4) { seenPages.add(a); queue.push(a); }
        continue;
      }
      if (tag === 'link' && !/rel\s*=\s*["'][^"']*(stylesheet|icon|apple-touch-icon|manifest)/i.test(t)) continue;
      if (tag === 'iframe') continue;
      for (const am of t.matchAll(/\s(src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) { const a = absOf(am[2]); if (a && /^https?:/.test(a)) refs.push({ ref: am[2], abs: a, isLink: false }); }
      for (const am of t.matchAll(/\s(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi)) for (const part of am[1].split(',')) { const u = part.trim().split(/\s+/)[0]; const a = u && absOf(u); if (a && /^https?:/.test(a)) refs.push({ ref: u, abs: a, isLink: false }); }
    }
    for (const m of html.matchAll(CSS_URL)) { const a = absOf(m[2]); if (a && /^https?:/.test(a)) refs.push({ ref: m[2], abs: a, isLink: false }); }
    const map = new Map<string, string>();
    for (const r of refs) {
      if (map.has(r.ref)) continue;
      const l = await fetchAsset(r.abs, true);
      map.set(r.ref, l ? relativeRef(path, l) : r.abs);
    }
    // Links between downloaded pages are rewritten after all pages are known.
    const swap = (r: string) => map.get(r) ?? map.get(r.replace(/&amp;/g, '&'));
    html = html
      .replace(ATTR_RE, (m, a, q, r) => { const v = swap(r); return v ? `${a}${q}${v}${q}` : m; })
      .replace(SRCSET_RE, (m, a, q, list: string) => `${a}${q}${list.split(',').map((part) => { const t = part.trim().split(/\s+/); const v = t[0] && swap(t[0]); if (v) t[0] = v; return t.join(' '); }).join(', ')}${q}`)
      .replace(CSS_URL, (m, q, r) => { const v = swap(r); return v ? `url(${q}${v}${q})` : m; })
      .replace(/<base\b[^>]*>\s*/i, '');
    site.write(path, html, { silent: true });
    pages.push(path);
    urls.set(pageUrl, path);
  }
  // Page-to-page links.
  for (const [pageUrl, p] of urls) {
    const text = site.read(p)!;
    const out = text.replace(/(<a\b[^>]*\shref\s*=\s*)(["'])([^"']+)\2/gi, (m, a, q, href: string) => {
      let abs: string;
      try { abs = new URL(href.replace(/&amp;/g, '&'), pageUrl).href; } catch { return m; }
      const hash = /#.*$/.exec(abs)?.[0] || '';
      const local = urls.get(abs.replace(/#.*$/, ''));
      if (local) return `${a}${q}${relativeRef(p, local)}${hash}${q}`;
      return /^https?:/i.test(href) || href.startsWith('#') || /^(mailto|tel):/i.test(href) ? m : `${a}${q}${abs}${q}`;
    });
    site.write(p, out, { silent: true });
  }
  site.data.home = pages[0] || 'index.html';
  const saved = [...assets.values()].filter(Boolean).length;
  report.push(`Saved ${pages.length} page(s) and ${saved} file(s) from ${start.hostname}.`);
  if (pages.length >= maxPages && queue.length) report.push(`Stopped after ${maxPages} page(s); ${queue.length} more linked page(s) were not downloaded.`);
  if (external.size) report.push(`${external.size} file(s) stay as links to the original server${binaryUnsupported ? ' (this version of the desktop app can only download text files; pictures and fonts need its byte-safe download)' : ''}: ${[...external].slice(0, 8).join(', ')}${external.size > 8 ? ', …' : ''}`);
  if (failed.length && failed.length !== external.size) report.push(`${failed.length} address(es) could not be read.`);
  if (droppedScripts) report.push(`${droppedScripts} script(s) were removed.`);
  const fw = detectFrameworks([...site.files.keys()], pages.map((p) => site.read(p) || ''));
  if (fw.length) report.push(`Detected: ${fw.join(', ')}.`);
  report.push('Check that you have the right to reuse the content and pictures of this site.');
  void isImagePath;
  return { site, report, open: pages[0] };
}
