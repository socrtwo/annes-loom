/**
 * A small WebDAV client (RFC 4918) for publishing: MKCOL to create folders, PUT to upload, DELETE,
 * PROPFIND to list the remote site and GET to download. Basic authentication.
 *
 * Requests go through fetch(). From a web page the server must allow this origin with CORS
 * (Access-Control-Allow-Origin, -Methods: PROPFIND, MKCOL, PUT, DELETE; -Headers: Authorization, Depth,
 * Content-Type). The desktop bridge's HTTP call only sends text bodies, so binary uploads use fetch there too.
 */

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: BodyInit | null }) => Promise<{ ok: boolean; status: number; statusText?: string; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface DavEntry { path: string; isDir: boolean; size: number; modified: number; etag?: string }

export interface DavRequest { method: string; url: string; headers: Record<string, string>; body?: Uint8Array | string }

/** Base64 of a UTF-8 string (for the Authorization header). */
export function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return 'Basic ' + btoa(s);
}

export class WebDavClient {
  readonly base: string;
  private made = new Set<string>();
  constructor(baseUrl: string, private user = '', private password = '', private fetchImpl: FetchLike = (u, i) => fetch(u, i as RequestInit) as any) {
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('A WebDAV address starts with https:// (or http:// on a local network).');
    this.base = baseUrl.replace(/\/+$/, '') + '/';
  }

  /** Full URL of a site path ("blog/a b.html" -> ".../blog/a%20b.html"); folders end with "/". */
  url(path: string, dir = false): string {
    const p = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return this.base + p + (dir && p ? '/' : '');
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.user || this.password ? { Authorization: basicAuth(this.user, this.password) } : {}), ...extra };
  }

  // Request builders (pure, tested)
  putRequest(path: string, data: Uint8Array | string, mime = 'application/octet-stream'): DavRequest { return { method: 'PUT', url: this.url(path), headers: this.headers({ 'Content-Type': mime }), body: data }; }
  mkcolRequest(dir: string): DavRequest { return { method: 'MKCOL', url: this.url(dir, true), headers: this.headers() }; }
  deleteRequest(path: string): DavRequest { return { method: 'DELETE', url: this.url(path), headers: this.headers() }; }
  getRequest(path: string): DavRequest { return { method: 'GET', url: this.url(path), headers: this.headers() }; }
  propfindRequest(dir: string, depth: '0' | '1' | 'infinity' = '1'): DavRequest {
    return { method: 'PROPFIND', url: this.url(dir, true), headers: this.headers({ Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }),
      body: '<?xml version="1.0" encoding="utf-8"?>\n<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>' };
  }

  private async send(r: DavRequest, okStatus: (s: number) => boolean = (s) => s >= 200 && s < 300) {
    let res;
    try {
      res = await this.fetchImpl(r.url, { method: r.method, headers: r.headers, body: (r.body as BodyInit) ?? null });
    } catch (e: any) {
      throw new Error(`${r.method} ${r.url} failed: ${e?.message || e}. The server may not allow requests from this app (CORS), or it is unreachable.`);
    }
    if (!okStatus(res.status)) {
      const why = res.status === 401 ? 'wrong user name or password' : res.status === 403 ? 'not allowed' : res.status === 405 ? 'method not allowed' : res.status === 409 ? 'parent folder missing' : res.status === 507 ? 'server is out of space' : res.statusText || '';
      throw new Error(`${r.method} ${decodeURI(r.url)}: ${res.status}${why ? ` (${why})` : ''}`);
    }
    return res;
  }

  /** Creates every folder of `path`'s parent chain that this session has not created yet. */
  async ensureDirs(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean).slice(0, -1);
    let cur = '';
    for (const seg of parts) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (this.made.has(cur)) continue;
      // 405 = already exists; 301 some servers redirect to the folder URL.
      await this.send(this.mkcolRequest(cur), (s) => (s >= 200 && s < 300) || s === 405 || s === 301);
      this.made.add(cur);
    }
  }

  async mkcol(dir: string): Promise<void> { await this.ensureDirs(dir + '/x'); }

  async put(path: string, data: Uint8Array | string, mime?: string): Promise<void> {
    await this.ensureDirs(path);
    await this.send(this.putRequest(path, data, mime));
  }

  async delete(path: string): Promise<void> { await this.send(this.deleteRequest(path), (s) => (s >= 200 && s < 300) || s === 404); }

  async get(path: string): Promise<Uint8Array | null> {
    const r = this.getRequest(path);
    const res = await this.send(r, (s) => (s >= 200 && s < 300) || s === 404);
    if (res.status === 404) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Lists a folder (Depth: 1) or, with `recursive`, walks every subfolder. Paths are site paths. */
  async list(dir = '', recursive = true): Promise<DavEntry[]> {
    const out: DavEntry[] = [];
    const queue = [dir];
    const seen = new Set<string>();
    while (queue.length) {
      const d = queue.shift()!;
      if (seen.has(d)) continue;
      seen.add(d);
      const res = await this.send(this.propfindRequest(d, '1'), (s) => s === 207 || (s >= 200 && s < 300));
      for (const e of parseMultistatus(await res.text(), this.base)) {
        if (e.path === d || e.path === '') continue;
        out.push(e);
        if (e.isDir && recursive) queue.push(e.path);
      }
    }
    return out;
  }
}

/** Parses a PROPFIND multistatus response. Namespace prefixes vary between servers, so tags are matched by local name. */
export function parseMultistatus(xml: string, base: string): DavEntry[] {
  const basePath = (() => { try { return new URL(base).pathname; } catch { return '/'; } })();
  const tag = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'i');
  const out: DavEntry[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const block = m[1];
    let href = (tag('href').exec(block)?.[1] || '').trim().replace(/&amp;/g, '&');
    try { href = new URL(href, base).pathname; } catch { /* relative */ }
    let rel = href.startsWith(basePath) ? href.slice(basePath.length) : href.replace(/^\/+/, '');
    try { rel = decodeURIComponent(rel); } catch { /* keep */ }
    // A 404 propstat for some properties is fine; look at the 200 one when there are several.
    const isDir = /<(?:[\w-]+:)?collection\b/i.test(block);
    const size = parseInt(tag('getcontentlength').exec(block)?.[1] || '0', 10) || 0;
    const lm = Date.parse(tag('getlastmodified').exec(block)?.[1] || '');
    const etag = tag('getetag').exec(block)?.[1]?.trim();
    out.push({ path: rel.replace(/\/+$/, ''), isDir, size, modified: Number.isFinite(lm) ? lm : 0, etag });
  }
  return out;
}
