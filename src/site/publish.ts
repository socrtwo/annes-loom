/**
 * Publishing engine: which files to publish for a destination (all, or only those changed since the last
 * publish to it), and the destinations themselves: a ZIP download, another folder, WebDAV, FTP/FTPS
 * (desktop app), GitHub Pages (REST contents API) and WordPress (src/io/wordpress.ts).
 *
 * The engine never stores passwords or tokens; callers pass them in.
 */
import JSZip from 'jszip';
import type { Site, PublishProfile } from '../model/site';
import { b64 } from '../model/site';
import { mimeOf, isPagePath } from '../model/paths';
import { expandIncludes } from './templates';
import { WebDavClient, type FetchLike } from './webdav';

export interface PublishItem { path: string; status: 'new' | 'changed' | 'unchanged' | 'excluded'; reason?: string; size: number; modified: number }
export interface PublishSelectOptions {
  /** Only files never published to this destination or changed since. */
  changedOnly?: boolean;
  /** Glob patterns; when given, only matching files are considered. */
  include?: string[];
  /** Extra glob patterns to leave out (added to the site's and the profile's). */
  exclude?: string[];
  /** Limit to these paths (Publish Selected Files). */
  paths?: string[];
}

export interface RemoteFile { path: string; size: number; modified: number; sha?: string }

export interface Destination {
  label: string;
  canDelete: boolean;
  put(path: string, data: Uint8Array, mime: string): Promise<void>;
  remove?(path: string): Promise<void>;
  list?(): Promise<RemoteFile[]>;
  get?(path: string): Promise<Uint8Array | null>;
  /** Called once after every put (batching destinations upload here). */
  finish?(log: (line: string) => void): Promise<void>;
}

export interface PublishRunOptions {
  log?: (line: string) => void;
  progress?: (done: number, total: number, path: string) => void;
  /** Delete remote copies of files that were published before and are no longer in the site. */
  removeOrphans?: boolean;
  signal?: { cancelled: boolean };
}
export interface PublishResult { published: string[]; failed: { path: string; error: string }[]; removed: string[]; cancelled: boolean }

// ------------------------------------------------------------------------------------------
// Selection

/** "*.psd", "Templates/**", "drafts/" -> RegExp over site paths. A pattern without "/" matches the file name anywhere. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\/+/, '');
  if (g.endsWith('/')) g += '**';
  const anywhere = !g.includes('/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${anywhere ? '(^|/)' : '^'}${re}$`, 'i');
}

export function matchesAny(path: string, globs: string[]): boolean { return globs.some((g) => g.trim() && globToRegExp(g).test(path)); }

/** Patterns from site settings (meta.publishExclude, one per line) and the profile (options.exclude). */
export function excludePatterns(site: Site, profile?: PublishProfile): string[] {
  const split = (s: unknown) => (typeof s === 'string' ? s.split(/[\n,]/) : Array.isArray(s) ? s : []).map((x: string) => x.trim()).filter(Boolean);
  return ['*.qlsite', '_notes/', ...split(site.data.meta.publishExclude), ...split(profile?.options?.exclude)];
}

/** Every site file with its publish status for `profile`. Excluded files are included with status "excluded". */
export function publishStatus(site: Site, profile: PublishProfile, opts: PublishSelectOptions = {}): PublishItem[] {
  const ex = [...excludePatterns(site, profile), ...(opts.exclude || [])];
  const out: PublishItem[] = [];
  for (const f of site.list()) {
    if (opts.paths && !opts.paths.includes(f.path)) continue;
    const size = f.data ? f.data.length : new TextEncoder().encode(f.text ?? '').length;
    const base = { path: f.path, size, modified: f.modified };
    if (f.noPublish) { out.push({ ...base, status: 'excluded', reason: "Marked Don't Publish" }); continue; }
    if (matchesAny(f.path, ex)) { out.push({ ...base, status: 'excluded', reason: 'Matches an exclude pattern' }); continue; }
    if (opts.include?.length && !matchesAny(f.path, opts.include)) { out.push({ ...base, status: 'excluded', reason: 'Not in the include patterns' }); continue; }
    const t = profile.published?.[f.path];
    out.push({ ...base, status: t == null ? 'new' : f.modified > t ? 'changed' : 'unchanged' });
  }
  return out;
}

/** The paths to publish: new and changed files (changedOnly) or every file that is not excluded. */
export function selectFiles(site: Site, profile: PublishProfile, opts: PublishSelectOptions = {}): string[] {
  return publishStatus(site, profile, opts).filter((i) => i.status === 'new' || i.status === 'changed' || (!opts.changedOnly && i.status === 'unchanged')).map((i) => i.path);
}

/** Files published to this destination earlier that are no longer in the site (candidates for remote deletion). */
export function orphans(site: Site, profile: PublishProfile): string[] {
  return Object.keys(profile.published || {}).filter((p) => !site.has(p)).sort();
}

/** The bytes to upload: pages can have server-side includes expanded for hosts that do not run them. */
export function publishBytes(site: Site, path: string, profile?: PublishProfile): Uint8Array {
  if (profile?.options?.expandIncludes && isPagePath(path)) {
    const src = site.read(path) || '';
    if (/<!--\s*(#include|webbot\s+bot="Include")/i.test(src)) return new TextEncoder().encode(expandIncludes(site, path, src));
  }
  return site.bytes(path) || new Uint8Array();
}

// ------------------------------------------------------------------------------------------
// Running

export async function runPublish(site: Site, profile: PublishProfile, paths: string[], dest: Destination, o: PublishRunOptions = {}): Promise<PublishResult> {
  const log = o.log || (() => {});
  const res: PublishResult = { published: [], failed: [], removed: [], cancelled: false };
  const total = paths.length;
  log(`Publishing ${total} file${total === 1 ? '' : 's'} to ${dest.label}`);
  const stamps: [string, number][] = [];
  for (let i = 0; i < paths.length; i++) {
    if (o.signal?.cancelled) { res.cancelled = true; log('Canceled.'); break; }
    const p = paths[i];
    const f = site.get(p);
    if (!f) continue;
    o.progress?.(i, total, p);
    try {
      await dest.put(p, publishBytes(site, p, profile), f.mime || mimeOf(p));
      stamps.push([p, f.modified]);
      res.published.push(p);
      log(`  ${p}`);
    } catch (e: any) {
      res.failed.push({ path: p, error: e?.message || String(e) });
      log(`  FAILED ${p}: ${e?.message || e}`);
      // Authentication and CORS failures repeat for every file: stop early.
      if (/\b401\b|CORS|unreachable|not allow/i.test(e?.message || '') && res.published.length === 0) { log('Stopped: the destination refused the connection.'); break; }
    }
  }
  if (o.removeOrphans && dest.canDelete && dest.remove && !res.cancelled) {
    for (const p of orphans(site, profile)) {
      try { await dest.remove(p); res.removed.push(p); log(`  deleted ${p}`); } catch (e: any) { log(`  could not delete ${p}: ${e?.message || e}`); }
    }
  }
  try { await dest.finish?.(log); } catch (e: any) {
    // A batching destination failed as a whole: nothing was published.
    log(`FAILED: ${e?.message || e}`);
    for (const p of res.published) res.failed.push({ path: p, error: e?.message || String(e) });
    res.published = []; res.removed = []; stamps.length = 0;
  }
  o.progress?.(total, total, '');
  profile.published = profile.published || {};
  for (const [p, t] of stamps) profile.published[p] = t;
  for (const p of res.removed) delete profile.published[p];
  log(`Done: ${res.published.length} published, ${res.failed.length} failed${res.removed.length ? `, ${res.removed.length} deleted` : ''}.`);
  return res;
}

/** Appends lines to the site's publish log (site.data.meta.publishLog, JSON, last 200 lines). */
export function appendPublishLog(site: Site, lines: string[]): void {
  let old: string[] = [];
  try { old = JSON.parse(site.data.meta.publishLog || '[]'); if (!Array.isArray(old)) old = []; } catch { old = []; }
  const stamp = new Date().toLocaleString();
  site.data.meta.publishLog = JSON.stringify([...old, `— ${stamp}`, ...lines].slice(-200));
  site.touchMeta();
}

export function readPublishLog(site: Site): string[] {
  try { const a = JSON.parse(site.data.meta.publishLog || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

// ------------------------------------------------------------------------------------------
// Comparing with a remote listing (Synchronize)

export type SyncState = 'same' | 'localOnly' | 'remoteOnly' | 'localChanged' | 'remoteChanged' | 'different';
export interface SyncEntry { path: string; state: SyncState; local?: { size: number; modified: number }; remote?: RemoteFile }

/**
 * Compares the site with a remote listing. With `localSha` (GitHub blob hashes) content is compared exactly;
 * otherwise by size and by the time of the last publish to this destination.
 */
export function compareWithRemote(site: Site, profile: PublishProfile, remote: RemoteFile[], localSha?: Map<string, string>): SyncEntry[] {
  const ex = excludePatterns(site, profile);
  const byPath = new Map(remote.map((r) => [r.path, r]));
  const out: SyncEntry[] = [];
  for (const f of site.list()) {
    if (f.noPublish || matchesAny(f.path, ex)) continue;
    const size = f.data ? f.data.length : new TextEncoder().encode(f.text ?? '').length;
    const local = { size, modified: f.modified };
    const r = byPath.get(f.path);
    byPath.delete(f.path);
    if (!r) { out.push({ path: f.path, state: 'localOnly', local }); continue; }
    const pub = profile.published?.[f.path];
    let state: SyncState;
    if (localSha && r.sha) state = localSha.get(f.path) === r.sha ? 'same' : pub != null && f.modified > pub ? 'localChanged' : pub != null ? 'remoteChanged' : 'different';
    else if (pub != null && f.modified <= pub && (!r.modified || r.modified <= pub + 120000) && r.size === size) state = 'same';
    else if (pub != null && f.modified > pub) state = 'localChanged';
    else if (pub != null && r.modified > pub + 120000) state = 'remoteChanged';
    else state = r.size === size ? 'same' : 'different';
    out.push({ path: f.path, state, local, remote: r });
  }
  for (const r of byPath.values()) if (!matchesAny(r.path, ex)) out.push({ path: r.path, state: 'remoteOnly', remote: r });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ------------------------------------------------------------------------------------------
// Destinations

/** Collects files into a ZIP; `save` receives the archive when publishing ends. */
export function zipDestination(name: string, save: (blob: Blob, name: string) => Promise<unknown>): Destination {
  const zip = new JSZip();
  let n = 0;
  return {
    label: `ZIP file ${name}`, canDelete: false,
    async put(path, data) { zip.file(path, data); n++; },
    async finish(log) { if (!n) return; const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' }); await save(blob, name); log(`Saved ${name} (${n} files).`); },
  };
}

export type FolderTarget = { kind: 'fsa'; handle: any; name?: string } | { kind: 'desktop'; root: string };

/** Writes into another folder on this device (File System Access API or the desktop bridge). */
export function folderDestination(target: FolderTarget, desktop: { writeFolderFile(o: { root: string; path: string; data: string }): Promise<{ ok: boolean }>; deleteFolderFile(o: { root: string; path: string }): Promise<{ ok: boolean }> } | null): Destination {
  const label = target.kind === 'desktop' ? `folder ${target.root}` : `folder ${target.handle?.name || target.name || ''}`;
  let permitted = false;
  const fsaDir = async (path: string, create: boolean) => {
    const parts = path.split('/');
    let d = (target as any).handle;
    for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create });
    return { dir: d, name: parts[parts.length - 1] };
  };
  const ensure = async () => {
    if (permitted || target.kind !== 'fsa') return;
    const h = target.handle;
    if ((await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission to write the folder was not given.');
    permitted = true;
  };
  return {
    label, canDelete: true,
    async put(path, data) {
      if (target.kind === 'desktop') { if (!desktop) throw new Error('Folder access needs the desktop app.'); await desktop.writeFolderFile({ root: target.root, path, data: b64(data) }); return; }
      await ensure();
      const { dir, name } = await fsaDir(path, true);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(data as BlobPart);
      await w.close();
    },
    async remove(path) {
      if (target.kind === 'desktop') { await desktop?.deleteFolderFile({ root: target.root, path }); return; }
      await ensure();
      try { const { dir, name } = await fsaDir(path, false); await dir.removeEntry(name); } catch { /* gone */ }
    },
    async get(path) {
      if (target.kind !== 'fsa') return null;
      try { const { dir, name } = await fsaDir(path, false); const f: File = await (await dir.getFileHandle(name)).getFile(); return new Uint8Array(await f.arrayBuffer()); } catch { return null; }
    },
    async list() {
      if (target.kind !== 'fsa') throw new Error('Listing a folder is available for folders picked in the browser.');
      const out: RemoteFile[] = [];
      const walk = async (d: any, prefix: string) => {
        for await (const [name, h] of d.entries()) {
          const p = prefix ? `${prefix}/${name}` : name;
          if (h.kind === 'directory') await walk(h, p); else { const f: File = await h.getFile(); out.push({ path: p, size: f.size, modified: f.lastModified }); }
        }
      };
      await walk(target.handle, '');
      return out;
    },
  };
}

/** WebDAV base URL for a profile: url + remoteDir. */
export function webdavBase(profile: PublishProfile): string {
  const dir = (profile.remoteDir || '').replace(/^\/+|\/+$/g, '');
  return profile.url.replace(/\/+$/, '') + (dir ? '/' + dir.split('/').map(encodeURIComponent).join('/') : '');
}

export function webdavDestination(profile: PublishProfile, password: string, fetchImpl?: FetchLike): Destination {
  const dav = new WebDavClient(webdavBase(profile), profile.user || '', password, fetchImpl);
  return {
    label: `WebDAV ${dav.base}`, canDelete: true,
    put: (p, data, mime) => dav.put(p, data, mime),
    remove: (p) => dav.delete(p),
    get: (p) => dav.get(p),
    list: async () => (await dav.list('', true)).filter((e) => !e.isDir).map((e) => ({ path: e.path, size: e.size, modified: e.modified, sha: undefined })),
  };
}

/** FTP host and port from "ftp.example.com", "ftp://host:2121" or "ftps://host". */
export function parseFtpUrl(url: string): { host: string; port?: number; secure: boolean } {
  const m = /^(?:(ftps?|sftp):\/\/)?([^/:]+)(?::(\d+))?/i.exec(url.trim());
  if (!m) throw new Error('Enter the FTP server name, for example ftp.example.com.');
  return { host: m[2], port: m[3] ? +m[3] : undefined, secure: (m[1] || '').toLowerCase() === 'ftps' };
}

/** FTP/FTPS through the desktop app: files are collected and sent in one session when publishing ends. */
export function ftpDestination(profile: PublishProfile, password: string, ftp: ((o: { host: string; port?: number; user: string; password: string; secure?: boolean; dir?: string; files: { path: string; data: string }[]; remove?: string[] }) => Promise<{ ok: boolean; log: string[] }>) | null): Destination {
  if (profile.kind === 'sftp') throw new Error('SFTP (SSH) is not supported. Most hosts that offer SFTP also offer FTPS (FTP over TLS): choose FTP and turn on "Use FTPS".');
  if (!ftp) throw new Error('FTP publishing needs the Anne\'s Loom desktop app: web pages cannot open FTP connections. Use WebDAV, GitHub Pages, a folder or a ZIP file here.');
  const { host, port, secure } = parseFtpUrl(profile.url);
  const files: { path: string; data: string }[] = [];
  const remove: string[] = [];
  return {
    label: `FTP${secure || profile.options?.secure ? 'S' : ''} ${host}`, canDelete: true,
    async put(path, data) { files.push({ path, data: b64(data) }); },
    async remove(path) { remove.push(path); },
    async finish(log) {
      if (!files.length && !remove.length) return;
      const r = await ftp({ host, port: port ?? profile.options?.port, user: profile.user || 'anonymous', password, secure: secure || !!profile.options?.secure, dir: profile.remoteDir || '', files, remove });
      for (const l of r.log || []) log('  ' + l);
      if (!r.ok) throw new Error('The FTP server reported an error (see the log).');
    },
  };
}

// GitHub Pages ------------------------------------------------------------------------------

export function parseGitHubRepo(url: string): { owner: string; repo: string } {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m) throw new Error('Enter the repository as owner/name or https://github.com/owner/name.');
  return { owner: m[1], repo: m[2] };
}

/** Git blob hash of some bytes (what GitHub reports as a file's sha). */
export async function gitBlobSha(data: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head); all.set(data, head.length);
  const d = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class GitHubClient {
  readonly owner: string; readonly repo: string; readonly branch: string; readonly dir: string;
  private shas: Map<string, string> | null = null;
  constructor(profile: PublishProfile, private token: string, private fetchImpl: FetchLike = (u, i) => fetch(u, i as RequestInit) as any) {
    ({ owner: this.owner, repo: this.repo } = parseGitHubRepo(profile.url));
    this.branch = profile.options?.branch || 'main';
    this.dir = (profile.remoteDir || '').replace(/^\/+|\/+$/g, '');
  }
  private remotePath(p: string) { return (this.dir ? this.dir + '/' : '') + p; }
  private contentsUrl(p: string) { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.remotePath(p).split('/').map(encodeURIComponent).join('/')}`; }
  private headers(extra: Record<string, string> = {}) { return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra }; }
  private async call(method: string, url: string, body?: any, ok = (s: number) => s >= 200 && s < 300) {
    let res;
    try { res = await this.fetchImpl(url, { method, headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : null }); }
    catch (e: any) { throw new Error(`GitHub is unreachable: ${e?.message || e}`); }
    if (!ok(res.status)) {
      let msg = '';
      try { msg = JSON.parse(await res.text()).message || ''; } catch { /* not JSON */ }
      const hint = res.status === 401 ? ' (check the token)' : res.status === 403 ? ' (the token needs Contents: read and write on this repository, or the rate limit was reached)' : res.status === 404 ? ' (repository, branch or file not found, or the token cannot see it)' : res.status === 409 ? ' (the file changed on GitHub meanwhile; try again)' : '';
      throw new Error(`GitHub ${method} ${res.status}${msg ? ': ' + msg : ''}${hint}`);
    }
    return res;
  }
  /** Remote files under the publish folder with their blob hashes. */
  async tree(): Promise<Map<string, string>> {
    if (this.shas) return this.shas;
    const res = await this.call('GET', `https://api.github.com/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`, undefined, (s) => (s >= 200 && s < 300) || s === 404 || s === 409);
    const map = new Map<string, string>();
    if (res.status === 200) {
      const j = JSON.parse(await res.text());
      const pre = this.dir ? this.dir + '/' : '';
      for (const e of j.tree || []) if (e.type === 'blob' && e.path.startsWith(pre)) map.set(e.path.slice(pre.length), e.sha);
    }
    this.shas = map;
    return map;
  }
  async put(path: string, data: Uint8Array): Promise<void> {
    const shas = await this.tree();
    const sha = shas.get(path);
    if (sha && sha === (await gitBlobSha(data))) return; // unchanged
    const res = await this.call('PUT', this.contentsUrl(path), { message: `Publish ${path}`, content: b64(data), branch: this.branch, ...(sha ? { sha } : {}) });
    try { const j = JSON.parse(await res.text()); if (j?.content?.sha) shas.set(path, j.content.sha); } catch { /* fine */ }
  }
  async remove(path: string): Promise<void> {
    const sha = (await this.tree()).get(path);
    if (!sha) return;
    await this.call('DELETE', this.contentsUrl(path), { message: `Delete ${path}`, sha, branch: this.branch });
    this.shas?.delete(path);
  }
  async get(path: string): Promise<Uint8Array | null> {
    const res = await this.call('GET', this.contentsUrl(path) + `?ref=${encodeURIComponent(this.branch)}`, undefined, (s) => (s >= 200 && s < 300) || s === 404);
    if (res.status === 404) return null;
    const j = JSON.parse(await res.text());
    let content: string = j.content || '';
    if (!content && j.sha) { // files over 1 MB: read the blob
      const b = await this.call('GET', `https://api.github.com/repos/${this.owner}/${this.repo}/git/blobs/${j.sha}`);
      content = JSON.parse(await b.text()).content || '';
    }
    const bin = atob(content.replace(/\s+/g, ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
}

export function githubDestination(profile: PublishProfile, token: string, fetchImpl?: FetchLike): Destination & { client: GitHubClient } {
  const gh = new GitHubClient(profile, token, fetchImpl);
  return {
    client: gh,
    label: `GitHub ${gh.owner}/${gh.repo} (${gh.branch}${gh.dir ? ', ' + gh.dir : ''})`, canDelete: true,
    put: (p, d) => gh.put(p, d),
    remove: (p) => gh.remove(p),
    get: (p) => gh.get(p),
    list: async () => [...(await gh.tree())].map(([path, sha]) => ({ path, size: -1, modified: 0, sha })),
  };
}

export const KIND_LABELS: Record<string, string> = {
  zip: 'ZIP file (download)', folder: 'Folder on this device', webdav: 'WebDAV server', ftp: 'FTP / FTPS server (desktop app)', sftp: 'SFTP server (not supported)', wordpress: 'WordPress site (pages and posts)', github: 'GitHub Pages repository',
};
