/**
 * Shows site files inside Design view and Preview. A page's relative links ("css/site.css",
 * "../img/logo.png") cannot be fetched from the editor's own address, so before a page is shown its
 * resource links are pointed at blob: URLs of the site's files (or data: URLs for the sandboxed
 * preview, which has an opaque origin). Style sheets are rewritten the same way, recursively.
 *
 * Design view keeps every original value in a data-ql-o-<attr> attribute; restoreOriginals() puts
 * them back when the page is turned into source again, so the source never sees a blob: URL.
 */
import type { Site } from '../model/site';
import { b64 } from '../model/site';
import { extOf, resolveRef } from '../model/paths';
import { expandIncludes } from '../site/templates';

export type UrlMode = 'blob' | 'data';

export class ResourceCache {
  private blobs = new Map<string, { url: string; ver: number }>();
  constructor(public site: Site) {}

  url(path: string, mode: UrlMode, depth = 0): string | null {
    const f = this.site.get(path);
    if (!f) return null;
    const isCss = extOf(path) === 'css';
    if (mode === 'data') {
      if (isCss) return 'data:text/css;charset=utf-8,' + encodeURIComponent(this.css(f.text ?? '', path, mode, depth + 1));
      const bytes = this.site.bytes(path)!;
      return `data:${f.mime};base64,${b64(bytes)}`;
    }
    const c = this.blobs.get(path);
    if (c && c.ver === f.modified && !isCss) return c.url;
    if (c) URL.revokeObjectURL(c.url);
    const body: BlobPart = isCss ? this.css(f.text ?? '', path, mode, depth + 1) : (this.site.bytes(path)! as BlobPart);
    const url = URL.createObjectURL(new Blob([body], { type: f.mime }));
    this.blobs.set(path, { url, ver: f.modified });
    return url;
  }

  /** CSS with url() and @import pointing at displayable URLs. */
  css(text: string, cssPath: string, mode: UrlMode, depth = 0): string {
    if (depth > 8) return text;
    const map = (ref: string) => { const p = resolveRef(cssPath, ref); return (p && this.url(p, mode, depth)) || ref; };
    return text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, ref) => `url(${q}${map(ref)}${q})`).replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, ref) => `@import ${q}${map(ref)}${q}`);
  }

  dispose(): void { for (const c of this.blobs.values()) URL.revokeObjectURL(c.url); this.blobs.clear(); }
}

const RES_ATTRS: [string, string][] = [
  ['img', 'src'], ['img', 'srcset'], ['source', 'src'], ['source', 'srcset'], ['video', 'src'], ['video', 'poster'], ['audio', 'src'], ['track', 'src'],
  ['input', 'src'], ['embed', 'src'], ['object', 'data'], ['script', 'src'], ['iframe', 'src'], ['frame', 'src'], ['link', 'href'],
  ['body', 'background'], ['table', 'background'], ['td', 'background'], ['th', 'background'], ['tr', 'background'], ['image', 'href'], ['use', 'href'],
];

/**
 * Rewrites resource links of a parsed page in place. With keepOriginals, each original value is stored
 * in data-ql-o-<attr> for restoreOriginals().
 */
export function rewriteDom(doc: Document, pagePath: string, cache: ResourceCache, mode: UrlMode, keepOriginals: boolean): void {
  const map = (ref: string) => { const p = resolveRef(pagePath, ref); return (p && cache.url(p, mode)) || null; };
  for (const [tag, attr] of RES_ATTRS) {
    for (const el of doc.querySelectorAll(tag)) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      if (tag === 'link' && !/stylesheet|icon|preload|image/i.test(el.getAttribute('rel') || '')) continue;
      if (tag === 'iframe' || tag === 'frame') { if (mode === 'blob') continue; }
      let nv: string | null;
      if (attr === 'srcset') nv = v.split(',').map((part) => { const t = part.trim().split(/\s+/); const u = t[0] && map(t[0]); if (u) t[0] = u; return t.join(' '); }).join(', ');
      else nv = map(v);
      if (!nv || nv === v) continue;
      if (keepOriginals) el.setAttribute(`data-ql-o-${attr}`, v);
      el.setAttribute(attr, nv);
    }
  }
  for (const el of doc.querySelectorAll('[style]')) {
    const v = el.getAttribute('style')!;
    if (!/url\(/i.test(v)) continue;
    const nv = cache.css(v, pagePath, mode);
    if (nv !== v) { if (keepOriginals) el.setAttribute('data-ql-o-style', v); el.setAttribute('style', nv); }
  }
  for (const el of doc.querySelectorAll('style')) {
    const v = el.textContent || '';
    if (!/url\(|@import/i.test(v)) continue;
    const nv = cache.css(v, pagePath, mode);
    if (nv !== v) { if (keepOriginals) el.setAttribute('data-ql-o-text', v); el.textContent = nv; }
  }
}

/** Puts back the original links stored by rewriteDom() (on a clone that is about to be serialized). */
export function restoreOriginals(root: Element): void {
  const all = [root, ...root.querySelectorAll('*')];
  for (const el of all) {
    for (const a of [...el.attributes]) {
      if (!a.name.startsWith('data-ql-o-')) continue;
      const name = a.name.slice(10);
      if (name === 'text') el.textContent = a.value; else el.setAttribute(name, a.value);
      el.removeAttribute(a.name);
    }
  }
}

/**
 * The page as a self-contained document for Preview: includes expanded, every site resource as a data: URL,
 * and links between pages intercepted so the preview can navigate inside the site.
 */
export function previewDocument(site: Site, pagePath: string, src: string, cache: ResourceCache, opts: { width?: number } = {}): string {
  const expanded = expandIncludes(site, pagePath, src);
  const doc = new DOMParser().parseFromString(expanded, 'text/html');
  rewriteDom(doc, pagePath, cache, 'data', false);
  // Navigation between site pages: the preview posts the target and the editor opens it.
  const nav = doc.createElement('script');
  nav.textContent = `document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(!h||/^(#|[a-z][a-z0-9+.-]*:|\\/\\/)/i.test(h))return;e.preventDefault();parent.postMessage({qlPreviewNav:h},'*');},true);`;
  (doc.body || doc.documentElement).appendChild(nav);
  void opts;
  const dt = /^\s*<!DOCTYPE[^>]*>/i.exec(expanded)?.[0] || '<!DOCTYPE html>';
  return dt + '\n' + doc.documentElement.outerHTML;
}
