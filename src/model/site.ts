/**
 * A web site: a set of files keyed by site path, plus the site-level data that desktop web editors keep
 * beside the files (navigation structure, tasks, publishing destinations, check-out state, metadata).
 *
 * A single page opened on its own is a site with one file. Text files keep their text; everything else
 * keeps its bytes. All edits go through write()/remove()/rename() so listeners and link fix-up see them.
 */
import { baseName, dirOf, extOf, isPagePath, isTextPath, joinPath, mimeOf, normalizePath, relativeRef, resolveRef, splitRef } from './paths';

export interface SiteFile {
  path: string;
  mime: string;
  text?: string;
  data?: Uint8Array;
  created: number;
  modified: number;
  /** Excluded from publishing ("Don't publish"). */
  noPublish?: boolean;
  /** Checked out by this author (source control "check out / check in"). */
  checkedOut?: string;
  /** Free-form file properties (summary, category, review status, assigned to). */
  props?: Record<string, string>;
}

export interface NavNode { path: string; label?: string; children: NavNode[] }

export interface SiteTask { id: string; name: string; file?: string; priority: 'High' | 'Medium' | 'Low'; assignedTo: string; status: 'Not Started' | 'In Progress' | 'Completed'; description: string; created: number }

export type PublishKind = 'zip' | 'folder' | 'webdav' | 'ftp' | 'sftp' | 'wordpress' | 'github';

export interface PublishProfile {
  id: string;
  name: string;
  kind: PublishKind;
  url: string;
  user?: string;
  /** Remote folder (FTP/WebDAV) or WordPress post type ("page" | "post"). */
  remoteDir?: string;
  /** Path -> modified time of the last published copy, for "changed files only". */
  published?: Record<string, number>;
  /** Passive FTP, keep encoding, delete remote files missing locally. */
  options?: Record<string, any>;
}

export interface SiteData {
  name: string;
  home: string;
  nav: NavNode | null;
  tasks: SiteTask[];
  publish: PublishProfile[];
  meta: Record<string, string>;
  /** Page path -> attached template path (Page Templates / editable regions). */
  templates: Record<string, string>;
  /** Folder paths that exist even when empty. */
  folders: string[];
}

export const SITE_FORMAT = 'quillloom-site';

let idc = 0;
export const newId = (p = 'x') => `${p}${Date.now().toString(36)}${(idc++).toString(36)}`;

export class Site {
  files = new Map<string, SiteFile>();
  data: SiteData;
  /** Version counter: bumps on every change (panes use it to know when to redraw). */
  version = 0;
  private listeners = new Set<(path: string | null, kind: 'write' | 'remove' | 'rename' | 'meta') => void>();
  /** Where the site lives on disk, when it was opened from or saved to a folder. */
  folder: { kind: 'fsa'; handle: any } | { kind: 'desktop'; root: string } | null = null;
  /** Old path -> new path of the last rename(), for open tabs to follow. */
  lastMoves = new Map<string, string>();

  constructor(name = 'My Web Site') {
    this.data = { name, home: 'index.html', nav: null, tasks: [], publish: [], meta: {}, templates: {}, folders: [] };
  }

  onChange(fn: (path: string | null, kind: 'write' | 'remove' | 'rename' | 'meta') => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(path: string | null, kind: 'write' | 'remove' | 'rename' | 'meta'): void { this.version++; for (const l of this.listeners) l(path, kind); }
  touchMeta(): void { this.emit(null, 'meta'); }

  get name(): string { return this.data.name; }
  set name(v: string) { this.data.name = v; this.touchMeta(); }

  has(path: string): boolean { return this.files.has(normalizePath(path)); }
  get(path: string): SiteFile | undefined { return this.files.get(normalizePath(path)); }
  read(path: string): string | undefined {
    const f = this.get(path);
    if (!f) return undefined;
    if (f.text != null) return f.text;
    if (f.data) return new TextDecoder().decode(f.data);
    return '';
  }
  bytes(path: string): Uint8Array | undefined {
    const f = this.get(path);
    if (!f) return undefined;
    return f.data ?? new TextEncoder().encode(f.text ?? '');
  }

  write(path: string, content: string | Uint8Array, opts: { mime?: string; silent?: boolean } = {}): SiteFile {
    path = normalizePath(path);
    if (!path) throw new Error('A file needs a name.');
    const now = Date.now();
    const prev = this.files.get(path);
    const asText = typeof content === 'string' ? content : isTextPath(path) ? decodeText(content) : null;
    const f: SiteFile = { ...(prev || {}), path, mime: opts.mime || prev?.mime || mimeOf(path), created: prev?.created || now, modified: now };
    if (asText != null) { f.text = asText; delete f.data; } else { f.data = content as Uint8Array; delete f.text; }
    if (prev && prev.text === f.text && prev.data === f.data) return prev;
    this.files.set(path, f);
    if (!opts.silent) this.emit(path, 'write');
    return f;
  }

  remove(path: string): void {
    path = normalizePath(path);
    const prefix = path + '/';
    for (const k of [...this.files.keys()]) if (k === path || k.startsWith(prefix)) { this.files.delete(k); delete this.data.templates[k]; }
    this.data.folders = this.data.folders.filter((d) => d !== path && !d.startsWith(prefix));
    if (this.data.nav) pruneNav(this.data.nav, (p) => !(p === path || p.startsWith(prefix)));
    this.emit(path, 'remove');
  }

  addFolder(path: string): void {
    path = normalizePath(path);
    if (path && !this.data.folders.includes(path)) { this.data.folders.push(path); this.emit(path, 'write'); }
  }

  /** Every folder (explicit or implied by a file), sorted. */
  folders(): string[] {
    const s = new Set(this.data.folders);
    for (const p of this.files.keys()) { let d = dirOf(p); while (d) { s.add(d); d = dirOf(d); } }
    return [...s].sort();
  }

  list(filter?: (f: SiteFile) => boolean): SiteFile[] {
    return [...this.files.values()].filter((f) => !filter || filter(f)).sort((a, b) => a.path.localeCompare(b.path));
  }
  pages(): SiteFile[] { return this.list((f) => isPagePath(f.path)); }

  /**
   * Renames or moves a file or folder and, like desktop site editors, rewrites every link to it
   * in the site's pages and style sheets, and every link inside it that now needs another relative path.
   */
  rename(from: string, to: string, opts: { fixLinks?: boolean } = {}): number {
    from = normalizePath(from); to = normalizePath(to);
    if (!from || !to || from === to) return 0;
    const moves = new Map<string, string>();
    for (const k of this.files.keys()) {
      if (k === from) moves.set(k, to);
      else if (k.startsWith(from + '/')) moves.set(k, to + k.slice(from.length));
    }
    if (!moves.size) throw new Error(`${from} is not in the site.`);
    for (const t of moves.values()) if (this.files.has(t) && !moves.has(t)) throw new Error(`${t} already exists.`);
    let fixed = 0;
    if (opts.fixLinks !== false) {
      for (const f of this.files.values()) {
        if (f.text == null || !linkable(f.path)) continue;
        const newSelf = moves.get(f.path) || f.path;
        const out = rewriteRefs(f.text, f.path, (target) => {
          const dest = moves.get(target) || target;
          if (dest === target && newSelf === f.path) return null;
          return relativeRef(newSelf, dest);
        });
        if (out !== f.text) { f.text = out; f.modified = Date.now(); fixed++; }
      }
    }
    for (const [a, b] of moves) {
      const f = this.files.get(a)!;
      this.files.delete(a);
      f.path = b;
      this.files.set(b, f);
      if (this.data.templates[a]) { this.data.templates[b] = this.data.templates[a]; delete this.data.templates[a]; }
    }
    for (const [k, v] of Object.entries(this.data.templates)) if (moves.has(v)) this.data.templates[k] = moves.get(v)!;
    this.data.folders = this.data.folders.map((d) => (d === from ? to : d.startsWith(from + '/') ? to + d.slice(from.length) : d));
    if (moves.has(this.data.home)) this.data.home = moves.get(this.data.home)!;
    if (this.data.nav) mapNav(this.data.nav, (p) => moves.get(p) || p);
    this.lastMoves = moves;
    this.emit(to, 'rename');
    return fixed;
  }

  /** A free name like "untitled_2.html" in a folder. */
  freeName(dir: string, base: string, ext: string): string {
    for (let i = 0; ; i++) {
      const p = joinPath(dir, `${base}${i ? `_${i}` : ''}${ext ? '.' + ext : ''}`);
      if (!this.files.has(p)) return p;
    }
  }

  get homePage(): string {
    if (this.files.has(this.data.home)) return this.data.home;
    for (const c of ['index.html', 'index.htm', 'default.htm', 'default.html', 'index.php', 'home.html']) if (this.files.has(c)) return c;
    return this.pages()[0]?.path || 'index.html';
  }

  // ----------------------------------------------------------------------------------------
  // Serialization: the native .qlsite format is JSON with binary files in base64.

  toJSON(): any {
    return {
      format: SITE_FORMAT, version: 1, data: this.data,
      files: this.list().map((f) => ({ path: f.path, mime: f.mime, created: f.created, modified: f.modified, noPublish: f.noPublish, checkedOut: f.checkedOut, props: f.props, text: f.text, b64: f.data ? b64(f.data) : undefined })),
    };
  }

  static fromJSON(j: any): Site {
    if (!j || j.format !== SITE_FORMAT || !Array.isArray(j.files)) throw new Error('Not an Anne\'s Loom site file.');
    const s = new Site(String(j.data?.name || 'Web Site'));
    s.data = { ...s.data, ...(j.data || {}) };
    for (const f of j.files) {
      if (!f || typeof f.path !== 'string') continue;
      const p = normalizePath(f.path);
      if (!p) continue;
      s.files.set(p, { path: p, mime: f.mime || mimeOf(p), created: +f.created || Date.now(), modified: +f.modified || Date.now(), noPublish: !!f.noPublish || undefined, checkedOut: f.checkedOut || undefined, props: f.props || undefined, ...(typeof f.text === 'string' ? { text: f.text } : { data: unb64(f.b64 || '') }) });
    }
    return s;
  }

  clone(): Site { return Site.fromJSON(JSON.parse(JSON.stringify(this.toJSON()))); }
}

// ------------------------------------------------------------------------------------------
// Links

/** Files whose links the site keeps up to date. */
export function linkable(path: string): boolean {
  return isPagePath(path) || ['css', 'scss', 'less', 'svg', 'xml', 'rss'].includes(extOf(path));
}

const ATTR_RE = /(\s(?:href|src|action|poster|data|background|longdesc|cite|usemap|formaction|content|data-src|data-background|data-ql-rollover|lowsrc|dynsrc)\s*=\s*)(["']?)([^"'\s>]*)\2/gi;
const SRCSET_RE = /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi;
const CSS_URL_RE = /(url\(\s*)(["']?)([^"')]+)\2(\s*\))/gi;
const CSS_IMPORT_RE = /(@import\s+)(["'])([^"']+)\2/gi;
const TPL_RE = /(<!--\s*(?:#BeginTemplate|#BeginLibraryItem|InstanceBegin\s+template|#include\s+(?:virtual|file))\s*=?\s*)(["'])([^"']+)\2/gi;

/**
 * Calls `map` for every in-site link of a page or style sheet. When it returns a string, the link
 * is replaced (the query and fragment are kept). Used by rename fix-up, broken link reports, publishing.
 */
export function rewriteRefs(text: string, filePath: string, map: (target: string, ref: string) => string | null): string {
  const css = extOf(filePath) === 'css' || extOf(filePath) === 'scss' || extOf(filePath) === 'less';
  const one = (ref: string): string => {
    const target = resolveRef(filePath, ref);
    if (!target) return ref;
    const r = map(target, ref);
    if (r == null) return ref;
    const [, suffix] = splitRef(ref);
    return r + suffix;
  };
  let out = text.replace(CSS_URL_RE, (m, a, q, ref, z) => `${a}${q}${one(ref)}${q}${z}`).replace(CSS_IMPORT_RE, (m, a, q, ref) => `${a}${q}${one(ref)}${q}`);
  if (css) return out;
  out = out.replace(ATTR_RE, (m, a, q, ref) => {
    // <meta content> only for refresh URLs
    if (/content/i.test(a)) {
      const mm = /^(\d+\s*;\s*url=)(.*)$/i.exec(ref);
      return mm ? `${a}${q}${mm[1]}${one(mm[2])}${q}` : m;
    }
    return `${a}${q}${one(ref)}${q}`;
  });
  out = out.replace(SRCSET_RE, (m, a, q, list) => `${a}${q}${list.split(',').map((part: string) => { const t = part.trim().split(/\s+/); if (t[0]) t[0] = one(t[0]); return t.join(' '); }).join(', ')}${q}`);
  out = out.replace(TPL_RE, (m, a, q, ref) => {
    // Template references are written root-relative ("/Templates/main.dwt") or relative.
    const target = resolveRef(filePath, ref);
    if (!target) return m;
    const r = map(target, ref);
    if (r == null) return m;
    return `${a}${q}${ref.startsWith('/') ? '/' + resolveRef(filePath, r)! : r}${q}`;
  });
  return out;
}

/** Every in-site link in a file: [site path, link as written]. */
export function linksOf(text: string, filePath: string): [string, string][] {
  const out: [string, string][] = [];
  rewriteRefs(text, filePath, (t, ref) => { out.push([t, ref]); return null; });
  return out;
}

/** External links (http, https, mailto…) in a file. */
export function externalLinksOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\s(?:href|src|action)\s*=\s*["']((?:https?:|mailto:|ftp:|tel:)[^"']+)["']/gi)) out.add(m[1]);
  return [...out];
}

// ------------------------------------------------------------------------------------------
// Navigation structure

function pruneNav(n: NavNode, keep: (p: string) => boolean): void {
  n.children = n.children.filter((c) => keep(c.path));
  n.children.forEach((c) => pruneNav(c, keep));
}
function mapNav(n: NavNode, f: (p: string) => string): void { n.path = f(n.path); n.children.forEach((c) => mapNav(c, f)); }

export function findNav(n: NavNode | null, path: string, parent: NavNode | null = null): { node: NavNode; parent: NavNode | null } | null {
  if (!n) return null;
  if (n.path === path) return { node: n, parent };
  for (const c of n.children) { const r = findNav(c, path, n); if (r) return r; }
  return null;
}

/** Builds a navigation tree from the folder structure when the site has none (home, then pages by folder). */
export function defaultNav(site: Site): NavNode {
  const home = site.homePage;
  const root: NavNode = { path: home, children: [] };
  const byDir = new Map<string, NavNode>();
  byDir.set('', root);
  for (const f of site.pages()) {
    if (f.path === home || /\.(dwt|lbi)$/.test(f.path) || f.path.startsWith('Templates/') || f.path.startsWith('Library/') || f.path.startsWith('_')) continue;
    const d = dirOf(f.path);
    let parent = byDir.get(d);
    if (!parent) {
      const idx = ['index.html', 'index.htm', 'default.htm'].map((x) => joinPath(d, x)).find((x) => site.has(x));
      parent = { path: idx || f.path, children: [] };
      (byDir.get(dirOf(d)) || root).children.push(parent);
      byDir.set(d, parent);
      if (idx === f.path || !idx) continue;
    }
    if (parent.path === f.path) continue;
    parent.children.push({ path: f.path, children: [] });
  }
  return root;
}

export function pageTitle(site: Site, path: string): string {
  const t = site.read(path) || '';
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(t);
  const title = m ? decodeEntities(m[1].trim()) : '';
  return title || baseName(path);
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e: string) => {
    const l = e.toLowerCase();
    if (l[0] === '#') return String.fromCodePoint(l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[l] ?? m;
  });
}

// ------------------------------------------------------------------------------------------
// Bytes

export function decodeText(u8: Uint8Array): string {
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { /* legacy page */ }
  // Older sites were written in a Windows code page; honor a declared charset when the browser knows it.
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 4096));
  const cs = /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] || 'windows-1252';
  try { return new TextDecoder(cs).decode(u8); } catch { return new TextDecoder('windows-1252').decode(u8); }
}

export function b64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
