/**
 * Reading and writing whole sites: ZIP archives, the native .qlsite file, folders on this device
 * (File System Access API in Chromium browsers, the desktop bridge in the desktop app) and
 * browser folder pickers (<input webkitdirectory>) as a read-only fallback.
 */
import JSZip from 'jszip';
import { Site, b64, unb64 } from '../model/site';
import { normalizePath, isTextPath } from '../model/paths';
import { desktopFolders } from '../platform/native';

/** Folders and files that are never part of a site. */
export const SKIP_RE = /(^|\/)(\.git|\.svn|\.hg|node_modules|\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|_vti_cnf|_vti_pvt|_notes|\.idea|\.vscode)(\/|$)/i;

export interface ReadOptions { maxFiles?: number; maxBytes?: number }

/** Common leading folder of all paths ("theme-1.2/"), so a ZIP of a folder opens as that folder. */
export function commonRoot(paths: string[]): string {
  if (!paths.length) return '';
  const first = paths[0].split('/');
  let n = first.length - 1;
  for (const p of paths) {
    const parts = p.split('/');
    let i = 0;
    while (i < n && i < parts.length - 1 && parts[i] === first[i]) i++;
    n = i;
  }
  return n ? first.slice(0, n).join('/') + '/' : '';
}

export async function readZip(data: ArrayBuffer | Uint8Array, opts: ReadOptions & { stripRoot?: boolean } = {}): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(data);
  const out = new Map<string, Uint8Array>();
  const entries = Object.values(zip.files).filter((e) => !e.dir && !SKIP_RE.test(e.name));
  const max = opts.maxFiles ?? 20000;
  let bytes = 0;
  for (const e of entries.slice(0, max)) {
    const u8 = await e.async('uint8array');
    bytes += u8.length;
    if (opts.maxBytes && bytes > opts.maxBytes) throw new Error('The archive is too large to open here.');
    out.set(normalizePath(e.name), u8);
  }
  if (opts.stripRoot !== false) {
    const root = commonRoot([...out.keys()]);
    if (root) return new Map([...out].map(([k, v]) => [k.slice(root.length), v]));
  }
  return out;
}

export function siteFromFiles(name: string, files: Map<string, Uint8Array>): Site {
  const s = new Site(name);
  for (const [p, u8] of files) if (p) s.write(p, u8, { silent: true });
  return s;
}

/** A ZIP of the site's files (excluding "Don't publish" files unless `all`). */
export async function zipSite(site: Site, opts: { all?: boolean; filter?: (path: string) => boolean } = {}): Promise<Blob> {
  const zip = new JSZip();
  for (const f of site.list()) {
    if (!opts.all && f.noPublish) continue;
    if (opts.filter && !opts.filter(f.path)) continue;
    zip.file(f.path, f.data ?? f.text ?? '', { date: new Date(f.modified) });
  }
  for (const d of site.data.folders) zip.folder(d);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' });
}

export function qlsiteBlob(site: Site): Blob {
  return new Blob([JSON.stringify(site.toJSON())], { type: 'application/x-quillloom-site' });
}

export function readQlsite(data: ArrayBuffer | Uint8Array): Site {
  const text = new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data));
  return Site.fromJSON(JSON.parse(text));
}

// ------------------------------------------------------------------------------------------
// Folders: File System Access API

export const canPickFolder = (): boolean => !!desktopFolders || typeof (window as any).showDirectoryPicker === 'function';
export const canWriteFolder = canPickFolder;

async function walkHandle(dir: any, prefix: string, out: Map<string, Uint8Array>, max: number): Promise<void> {
  for await (const [name, h] of dir.entries()) {
    if (out.size >= max) return;
    const p = prefix ? `${prefix}/${name}` : name;
    if (SKIP_RE.test(p)) continue;
    if (h.kind === 'directory') await walkHandle(h, p, out, max);
    else { const f: File = await h.getFile(); out.set(p, new Uint8Array(await f.arrayBuffer())); }
  }
}

/** Lets the user pick a folder and reads it as a site. Null when canceled. */
export async function openFolder(opts: ReadOptions = {}): Promise<Site | null> {
  if (desktopFolders) {
    const r = await desktopFolders.openFolder({ maxFiles: opts.maxFiles ?? 20000 });
    if (!r || r.canceled) return null;
    const s = new Site(r.name || 'Web Site');
    for (const f of r.files) s.write(f.path, unb64(f.data), { silent: true });
    s.folder = { kind: 'desktop', root: r.root };
    return s;
  }
  const pick = (window as any).showDirectoryPicker;
  if (pick) {
    let handle: any;
    try { handle = await pick({ mode: 'readwrite', id: 'quillloom-site' }); } catch (e: any) { if (e?.name === 'AbortError') return null; throw e; }
    const files = new Map<string, Uint8Array>();
    await walkHandle(handle, '', files, opts.maxFiles ?? 20000);
    const s = siteFromFiles(handle.name || 'Web Site', files);
    s.folder = { kind: 'fsa', handle };
    return s;
  }
  // Read-only fallback: a folder chooser input. Saving then goes to a ZIP.
  const files = await new Promise<File[]>((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    (inp as any).webkitdirectory = true;
    inp.multiple = true;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { resolve(inp.files ? [...inp.files] : []); inp.remove(); });
    inp.addEventListener('cancel', () => { resolve([]); inp.remove(); });
    inp.click();
  });
  if (!files.length) return null;
  const map = new Map<string, Uint8Array>();
  for (const f of files) {
    const rel = (f as any).webkitRelativePath || f.name;
    if (SKIP_RE.test(rel)) continue;
    map.set(normalizePath(rel), new Uint8Array(await f.arrayBuffer()));
  }
  const root = commonRoot([...map.keys()]);
  const name = root.replace(/\/$/, '') || 'Web Site';
  return siteFromFiles(name, new Map([...map].map(([k, v]) => [k.slice(root.length), v])));
}

/** Picks an empty (or any) folder to save the site into; sets site.folder. */
export async function chooseSaveFolder(site: Site): Promise<boolean> {
  if (desktopFolders) {
    const r = await desktopFolders.chooseFolder({});
    if (!r || r.canceled) return false;
    site.folder = { kind: 'desktop', root: r.root };
    return true;
  }
  const pick = (window as any).showDirectoryPicker;
  if (!pick) return false;
  try { site.folder = { kind: 'fsa', handle: await pick({ mode: 'readwrite', id: 'quillloom-save' }) }; return true; } catch { return false; }
}

async function fsaFile(dir: any, path: string, create: boolean): Promise<any> {
  const parts = path.split('/');
  let d = dir;
  for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create });
  return d.getFileHandle(parts[parts.length - 1], { create });
}

/** Writes files of the site into its folder. Returns the number written. */
export async function writeToFolder(site: Site, paths?: string[]): Promise<number> {
  const folder = site.folder;
  if (!folder) throw new Error('The site has no folder yet.');
  const list = (paths || [...site.files.keys()]).filter((p) => site.has(p));
  let n = 0;
  if (folder.kind === 'fsa') {
    if ((await folder.handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
      if ((await folder.handle.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission to write the folder was not given.');
    }
    for (const p of list) {
      const fh = await fsaFile(folder.handle, p, true);
      const w = await fh.createWritable();
      await w.write(site.bytes(p)! as BlobPart);
      await w.close();
      n++;
    }
    for (const d of site.data.folders) { let h = folder.handle; for (const seg of d.split('/')) h = await h.getDirectoryHandle(seg, { create: true }); }
    return n;
  }
  for (const p of list) { await desktopFolders!.writeFolderFile({ root: folder.root, path: p, data: b64(site.bytes(p)!) }); n++; }
  return n;
}

/** Deletes a file (or folder) from the site's folder on disk. */
export async function deleteFromFolder(site: Site, path: string): Promise<void> {
  const folder = site.folder;
  if (!folder) return;
  if (folder.kind === 'desktop') { await desktopFolders!.deleteFolderFile({ root: folder.root, path }); return; }
  const parts = path.split('/');
  let d = folder.handle;
  try { for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg); await d.removeEntry(parts[parts.length - 1], { recursive: true }); } catch { /* already gone */ }
}

/** Text or bytes for a picked File, by extension. */
export async function fileBytes(f: File): Promise<Uint8Array> { return new Uint8Array(await f.arrayBuffer()); }
export { isTextPath };
