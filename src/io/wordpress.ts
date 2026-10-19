/**
 * WordPress REST API (/wp-json/wp/v2/…): publish site pages as WordPress pages or posts, and read a running
 * WordPress site's public pages, posts and menus into a static site.
 *
 * Authentication uses Application Passwords (Users ▸ Profile ▸ Application Passwords, WordPress 5.6+) sent
 * with HTTP Basic authentication; WordPress accepts them only over HTTPS. WordPress answers REST requests
 * with CORS headers for any origin, so the browser version works unless a security plugin or the host
 * blocks it; the desktop app sends JSON requests through its main process.
 */
import type { Site, PublishProfile } from '../model/site';
import { escAttr } from '../model/html';
import { baseName, isImagePath, resolveRef, mimeOf } from '../model/paths';
import { expandIncludes } from '../site/templates';
import { htmlToBlocks } from './blocks';
import { httpRequest, type HttpResult } from './fetchSite';
import { buildSiteFromWp, pageContentOf, pageTitleOf, wpPathOf, type WpItem, type WpModel } from './wxr';

export interface WpClient { base: string; auth?: string; pretty: boolean }

const utf8b64 = (s: string) => { const u8 = new TextEncoder().encode(s); let b = ''; for (const c of u8) b += String.fromCharCode(c); return btoa(b); };

export function wpBase(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/wp-json\/?.*$/i, '').replace(/\/wp-admin\/?.*$/i, '').replace(/\/+$/, '');
}

export function wpClient(url: string, user?: string, password?: string): WpClient {
  return { base: wpBase(url), auth: user && password ? 'Basic ' + utf8b64(`${user}:${password.replace(/\s+/g, '')}`) : undefined, pretty: true };
}

/** Address of a REST route; falls back to ?rest_route= when the site has plain permalinks. */
export function route(c: WpClient, path: string, query: Record<string, string | number> = {}): string {
  const q = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  if (c.pretty) return `${c.base}/wp-json/${path.replace(/^\//, '')}${q ? '?' + q : ''}`;
  return `${c.base}/?rest_route=/${path.replace(/^\//, '')}${q ? '&' + q : ''}`;
}

async function api(c: WpClient, method: string, path: string, opts: { query?: Record<string, string | number>; json?: unknown; body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers || {}) };
  if (c.auth) headers.Authorization = c.auth;
  let body: string | Uint8Array | undefined;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  else if (opts.body) body = opts.body;
  let r: HttpResult = await httpRequest({ url: route(c, path, opts.query), method, headers, body });
  if (r.status === 404 && c.pretty && !/^\s*[{[]/.test(r.text)) {
    c.pretty = false;
    r = await httpRequest({ url: route(c, path, opts.query), method, headers, body });
  }
  let data: any = null;
  try { data = r.text ? JSON.parse(r.text) : null; } catch { data = null; }
  if (r.status >= 400 || r.status === 0) {
    const msg = data?.message ? String(data.message).replace(/<[^>]+>/g, '') : r.status === 0 ? 'no answer' : `HTTP ${r.status}`;
    const err = new Error(r.status === 401 || r.status === 403 ? `WordPress refused the request: ${msg}. Check the user name and application password, and that the site uses https.` : `WordPress: ${msg}`);
    (err as any).status = r.status;
    throw err;
  }
  if (data == null && method === 'GET') throw new Error(`${c.base} did not answer like a WordPress site (no JSON from the REST API).`);
  return data;
}

/** Checks credentials: the signed-in user's name and roles. */
export async function testWordPress(url: string, user: string, password: string): Promise<{ name: string; roles: string[]; site: string }> {
  const c = wpClient(url, user, password);
  const root = await api(c, 'GET', '/').catch(() => null);
  const me = await api(c, 'GET', 'wp/v2/users/me', { query: { context: 'edit' } });
  return { name: me?.name || user, roles: me?.roles || [], site: root?.name || c.base };
}

// ------------------------------------------------------------------------------------------
// Publishing

export async function publishToWordPress(site: Site, profile: PublishProfile, paths: string[], password: string, log: (line: string) => void): Promise<number> {
  const c = wpClient(profile.url, profile.user, password);
  const type = profile.remoteDir === 'post' ? 'posts' : 'pages';
  const status = profile.options?.status === 'publish' ? 'publish' : 'draft';
  const blocks = profile.options?.blocks !== false;
  const uploadImages = profile.options?.media !== false;
  const media: Record<string, string> = profile.options?.mediaMap || {};
  const ids = new Map<string, number>();
  const order = [...paths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const wpPath = new Map(order.map((p) => [p, wpPathOf(site, p)]));
  const permalink = (p: string) => `${c.base}/${wpPath.get(p) ? wpPath.get(p) + '/' : ''}`;
  let n = 0;
  log(`Connecting to ${c.base} as ${profile.user || '(no user)'}…`);
  for (const p of order) {
    const src0 = site.read(p);
    if (src0 == null) { log(`Skipped ${p}: not in the site.`); continue; }
    const src = expandIncludes(site, p, src0);
    const title = pageTitleOf(site, p, src);
    const wp = wpPath.get(p)!;
    const slug = wp ? wp.split('/').pop()! : 'home';
    let content = pageContentOf(src);
    // Pictures: upload once, then point at the media library copy.
    const imgs = [...content.matchAll(/<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
    for (const ref of imgs) {
      const target = resolveRef(p, ref);
      if (!target || !site.has(target) || !isImagePath(target)) continue;
      if (!media[target] && uploadImages) {
        try {
          const up = await api(c, 'POST', 'wp/v2/media', { body: site.bytes(target)!, headers: { 'Content-Type': mimeOf(target), 'Content-Disposition': `attachment; filename="${baseName(target).replace(/"/g, '')}"` } });
          media[target] = up.source_url;
          log(`Uploaded ${target}`);
        } catch (e: any) { log(`Could not upload ${target}: ${e?.message || e}`); }
      }
      if (media[target]) content = content.split(`"${ref}"`).join(`"${escAttr(media[target])}"`).split(`'${ref}'`).join(`'${escAttr(media[target])}'`);
    }
    content = content.replace(/\s(?:srcset|sizes)\s*=\s*["'][^"']*["']/gi, '');
    // Links to other published pages.
    content = content.replace(/(\shref\s*=\s*["'])([^"'#?]+)([^"']*["'])/gi, (m, a, ref, z) => { const t = resolveRef(p, ref); return t && wpPath.has(t) ? a + permalink(t) + z : m; });
    if (blocks) content = htmlToBlocks(content);
    const body: Record<string, unknown> = { title, slug, content, status };
    if (type === 'pages' && wp.includes('/')) {
      const parentWp = wp.split('/').slice(0, -1).join('/');
      const parent = [...wpPath].find(([, v]) => v === parentWp)?.[0];
      if (parent && ids.has(parent)) body.parent = ids.get(parent);
    }
    try {
      const found = await api(c, 'GET', `wp/v2/${type}`, { query: { slug, status: 'publish,draft,pending,private,future', context: 'edit', _fields: 'id,slug,parent' } }).catch(async () => api(c, 'GET', `wp/v2/${type}`, { query: { slug, _fields: 'id,slug,parent' } }));
      const existing = Array.isArray(found) ? found.find((x: any) => body.parent === undefined || x.parent === body.parent) || found[0] : null;
      const res = existing ? await api(c, 'POST', `wp/v2/${type}/${existing.id}`, { json: body }) : await api(c, 'POST', `wp/v2/${type}`, { json: body });
      ids.set(p, res.id);
      n++;
      log(`${existing ? 'Updated' : 'Created'} ${type === 'pages' ? 'page' : 'post'} "${title}" (${status}) ← ${p}`);
    } catch (e: any) {
      log(`Failed ${p}: ${e?.message || e}`);
      if ((e as any)?.status === 401 || (e as any)?.status === 403) break;
    }
  }
  profile.options = { ...(profile.options || {}), mediaMap: media };
  profile.published = { ...(profile.published || {}), ...Object.fromEntries(order.filter((p) => ids.has(p)).map((p) => [p, site.get(p)?.modified || Date.now()])) };
  log(`${n} of ${order.length} sent.`);
  return n;
}

// ------------------------------------------------------------------------------------------
// Reading a site

async function all(c: WpClient, path: string, query: Record<string, string | number>, max: number): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 50 && out.length < max; page++) {
    let batch: any;
    try { batch = await api(c, 'GET', path, { query: { ...query, per_page: 100, page } }); } catch (e: any) { if (page > 1 && (e.status === 400 || /invalid page/i.test(e.message))) break; throw e; }
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.slice(0, max);
}

const decodeHtml = (s: string) => s.replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

export async function fetchWordPressSite(url: string, opts: { user?: string; password?: string; maxItems?: number; log?: (s: string) => void; report?: string[]; includeDrafts?: boolean } = {}): Promise<Site> {
  const c = wpClient(url, opts.user, opts.password);
  const log = opts.log || (() => undefined);
  const max = opts.maxItems ?? 500;
  log(`Reading ${c.base}…`);
  const root = await api(c, 'GET', '/').catch(() => ({}));
  const status = opts.includeDrafts && c.auth ? 'publish,draft,pending,private' : 'publish';
  const q = (extra: Record<string, string | number> = {}) => ({ status, ...(c.auth ? { context: 'edit' } : {}), ...extra });
  const pages = await all(c, 'wp/v2/pages', q(), max);
  log(`${pages.length} page(s)`);
  const posts = await all(c, 'wp/v2/posts', q(), max).catch(() => []);
  log(`${posts.length} post(s)`);
  const cats = await all(c, 'wp/v2/categories', {}, 500).catch(() => []);
  const tags = await all(c, 'wp/v2/tags', {}, 500).catch(() => []);
  const catById = new Map(cats.map((x: any) => [x.id, x]));
  const tagById = new Map(tags.map((x: any) => [x.id, x]));
  const users = await all(c, 'wp/v2/users', {}, 100).catch(() => []);
  const userById = new Map(users.map((u: any) => [u.id, u.name]));
  const toItem = (x: any, type: string): WpItem => ({
    id: x.id, type, title: decodeHtml(x.title?.rendered || x.title?.raw || ''), slug: x.slug || '', status: x.status || 'publish', parent: x.parent || 0, order: x.menu_order || 0,
    date: x.date || '', author: userById.get(x.author) || '', content: x.content?.rendered || '', excerpt: x.excerpt?.rendered || '', rendered: true,
    link: x.link || '', guid: x.guid?.rendered || '', meta: {},
    categories: [...(x.categories || []).map((id: number) => catById.get(id)).filter(Boolean).map((t: any) => ({ domain: 'category', slug: t.slug, name: decodeHtml(t.name) })), ...(x.tags || []).map((id: number) => tagById.get(id)).filter(Boolean).map((t: any) => ({ domain: 'post_tag', slug: t.slug, name: decodeHtml(t.name) }))],
  });
  const items = [...pages.map((x) => toItem(x, 'page')), ...posts.map((x) => toItem(x, 'post'))];
  // Menus need an authenticated user with menu rights (WordPress 5.9+).
  let menus: Map<string, WpItem[]> | undefined;
  if (c.auth) {
    try {
      const mi = await all(c, 'wp/v2/menu-items', { context: 'edit' }, 500);
      const ms = await all(c, 'wp/v2/menus', { context: 'edit' }, 50).catch(() => []);
      const names = new Map(ms.map((m: any) => [m.id, m.slug || m.name]));
      menus = new Map();
      for (const x of mi) {
        const name = String(names.get(x.menus) || 'menu');
        if (!menus.has(name)) menus.set(name, []);
        menus.get(name)!.push({ id: x.id, type: 'nav_menu_item', title: decodeHtml(x.title?.rendered || x.title?.raw || ''), slug: '', status: 'publish', parent: 0, order: x.menu_order || 0, date: '', author: '', content: '', excerpt: '', link: '', guid: '', categories: [], meta: { _menu_item_type: x.type, _menu_item_object_id: String(x.object_id || ''), _menu_item_url: x.url || '', _menu_item_menu_item_parent: String(x.parent || 0) } });
      }
      if (!menus.size) menus = undefined;
    } catch { menus = undefined; }
  }
  const model: WpModel = { title: decodeHtml((root as any)?.name || ''), description: decodeHtml((root as any)?.description || ''), link: (root as any)?.home || (root as any)?.url || c.base, language: 'en-US', items, menus };
  const r = buildSiteFromWp(model, { includeDrafts: opts.includeDrafts });
  r.report.unshift(`Read ${pages.length} page(s) and ${posts.length} post(s) through the REST API of ${c.base}. Content is the HTML WordPress renders (blocks and shortcodes already expanded); theme styling is not included.`);
  if (!menus) r.report.push(c.auth ? 'Menus could not be read (they need WordPress 5.9 or later and a user who can edit menus); the navigation lists top-level pages.' : 'Menus are not public in the REST API; sign in with an application password to read them. The navigation lists top-level pages.');
  if (opts.report) opts.report.push(...r.report);
  r.site.data.meta['wp:url'] = c.base;
  return r.site;
}
