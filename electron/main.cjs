// Anne's Loom desktop app (Windows, macOS, Linux, Raspberry Pi OS): Electron main process.
//
// The web build (dist/) is served from the privileged app:// scheme so module workers, fetch and
// IndexedDB behave as on the web. The renderer is sandboxed with context isolation and no Node;
// electron/preload.cjs exposes `window.quillDesktop`, the same interface as the Android plugin.
// File access is limited to files and site folders the user opened or saved through a dialog, or
// opened the app with, so site content cannot use the bridge to read or overwrite arbitrary files.
// Page previews run on their own origin (preview://p), with no access to the app's storage.
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, clipboard, safeStorage, powerSaveBlocker, Menu, session } = require('electron');
const path = require('node:path');
// The data folder keeps the app's former name (QuillLoom) so settings, drafts and keys stay where earlier versions put them. // rename:keep
app.setPath('userData', path.join(app.getPath('appData'), 'QuillLoom')); // rename:keep
app.setPath('sessionData', app.getPath('userData')); // rename:keep
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ftpPublish } = require('./ftp.cjs');

const http = require('node:http');
const { pathToFileURL, fileURLToPath } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://quillloom`;
const PREVIEW = 'preview';
const PREVIEW_ORIGIN = `${PREVIEW}://p`;
/** Web pages, style sheets, scripts, templates and site archives Anne's Loom opens. */
const OPENABLE = ['html', 'htm', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'jsp', 'dwt', 'lbi', 'css', 'scss', 'less', 'js', 'mjs', 'json', 'xml', 'svg', 'txt', 'md', 'markdown', 'zip', 'qlsite', 'mht', 'mhtml', 'tpl', 'twig', 'hbs', 'liquid'];
/** Documents the app can import or hand to a sibling Anne's Office app (never programs or scripts). */
const DOCUMENTS = ['docx', 'docm', 'dotx', 'doc', 'odt', 'fodt', 'rtf', 'pdf', 'xlsx', 'ods', 'csv', 'pptx', 'odp'];

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  // A separate origin for page previews: secure (so page features that need HTTPS work), no CORS
  // access to anything, and no storage shared with the app.
  { scheme: PREVIEW, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

/** @type {BrowserWindow | null} */
let win = null;
/** Files opened before the page could receive them. Flushed when the page registers its fileOpened listener. */
const pendingFiles = [];
let rendererReady = false;
let wakeId = -1;

// ------------------------------------------------------------------------------------------
// Files the renderer may read and write

const grantsFile = () => path.join(app.getPath('userData'), 'granted-files.json');
let grants = new Set();
function loadGrants() {
  try { grants = new Set(JSON.parse(fs.readFileSync(grantsFile(), 'utf8'))); } catch { grants = new Set(); }
}
function grant(p) {
  grants.add(path.resolve(p));
  // Keep the most recent 200 (enough for the recent-files list).
  const list = [...grants].slice(-200);
  grants = new Set(list);
  try { fs.writeFileSync(grantsFile(), JSON.stringify(list)); } catch { /* read-only profile */ }
}
function grantedPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('Not a file address');
  const p = path.resolve(fileURLToPath(uri));
  if (!grants.has(p)) throw new Error('Anne\'s Loom has no permission for this file; open it again.');
  return p;
}
const MIME = {
  html: 'text/html', htm: 'text/html', shtml: 'text/html', dwt: 'text/html', lbi: 'text/html', tpl: 'text/html', twig: 'text/html', hbs: 'text/html', liquid: 'text/html',
  xhtml: 'application/xhtml+xml', php: 'application/x-httpd-php', asp: 'text/html', aspx: 'text/html', jsp: 'text/html',
  css: 'text/css', scss: 'text/x-scss', less: 'text/x-less', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', xml: 'application/xml', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  zip: 'application/zip', qlsite: 'application/x-quillloom-site', mht: 'multipart/related', mhtml: 'multipart/related',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', odt: 'application/vnd.oasis.opendocument.text',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odp: 'application/vnd.oasis.opendocument.presentation',
};
function fileResult(p) {
  const data = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  return { uri: pathToFileURL(p).href, name: path.basename(p), mime: MIME[ext] || 'application/octet-stream', data: data.toString('base64') };
}
function fileFromArgs(argv) {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    const ext = path.extname(a).slice(1).toLowerCase();
    // Files are recognized by their contents, so names without an extension open too.
    const known = OPENABLE.includes(ext) || DOCUMENTS.includes(ext) || (!ext && !a.includes('desktop-app'));
    try { if (known && fs.statSync(a).isFile()) return path.resolve(a); } catch { /* not a file */ }
  }
  return null;
}
function openExternalFile(p) {
  grant(p);
  if (win && rendererReady) win.webContents.send('ql:fileOpened', fileResult(p));
  else pendingFiles.push(p);
  // macOS keeps running with no window: opening a file from Finder must bring one back.
  if (!win && app.isReady()) createWindow();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}
function flushPendingFiles() {
  while (win && rendererReady && pendingFiles.length) win.webContents.send('ql:fileOpened', fileResult(pendingFiles.shift()));
}

// ------------------------------------------------------------------------------------------
// Site folders the renderer may read and write: only folders the user picked in a dialog.

const rootsFile = () => path.join(app.getPath('userData'), 'granted-folders.json');
let grantedRoots = new Set();
function loadRoots() {
  try { grantedRoots = new Set(JSON.parse(fs.readFileSync(rootsFile(), 'utf8')).filter((r) => typeof r === 'string')); } catch { grantedRoots = new Set(); }
}
function grantRoot(dir) {
  const real = fs.realpathSync(path.resolve(dir));
  grantedRoots.delete(real);
  grantedRoots.add(real);
  const list = [...grantedRoots].slice(-50);
  grantedRoots = new Set(list);
  try { fs.writeFileSync(rootsFile(), JSON.stringify(list)); } catch { /* read-only profile */ }
  return real;
}
/** Folders and files never read from a site folder (version control, editor metadata, OS clutter). */
const SKIP_NAMES = new Set(['.git', '.hg', '.svn', 'node_modules', '.DS_Store', 'Thumbs.db', 'desktop.ini', '_vti_cnf', '_vti_pvt', '__MACOSX']);
/** Segments the renderer may never write into: a site must not plant version-control hooks. */
const NO_WRITE = new Set(['.git', '.hg', '.svn']);
const MAX_FOLDER_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

const isInside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
function grantedRoot(root) {
  if (typeof root !== 'string' || !root || root.length > 4096 || root.includes('\0')) throw new Error('Invalid folder');
  const r = path.resolve(root);
  if (grantedRoots.has(r)) return r;
  // The renderer may hold the path as picked (before realpath): accept it when it resolves to a grant.
  try { const real = fs.realpathSync(r); if (grantedRoots.has(real)) return real; } catch { /* missing */ }
  throw new Error('Anne\'s Loom has no permission for this folder; open it again.');
}
/** Site-relative posix path → its segments, refusing absolute paths, '..', and names Windows cannot hold. */
function siteSegments(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || /[\0\\]/.test(rel)) throw new Error('Invalid file path');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new Error('Absolute paths are not allowed');
  const segs = rel.split('/').filter((x) => x !== '' && x !== '.');
  if (!segs.length) throw new Error('Invalid file path');
  for (const seg of segs) {
    if (seg === '..') throw new Error('Paths may not leave the site folder');
    if (NO_WRITE.has(seg)) throw new Error(`Anne\'s Loom does not write into ${seg} folders`);
    if (process.platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(seg) || /[. ]$/.test(seg))) throw new Error(`"${seg}" is not a valid file name on Windows`);
  }
  return segs;
}
/** The deepest existing ancestor of p, resolved through symbolic links. */
function realAncestor(p) {
  let cur = p;
  for (;;) {
    try { return fs.realpathSync(cur); } catch { /* does not exist yet */ }
    const up = path.dirname(cur);
    if (up === cur) throw new Error('Invalid folder');
    cur = up;
  }
}
/** Resolves a site file inside a granted root, refusing anything that leaves it (including through symlinks). */
function folderTarget(root, rel) {
  const base = grantedRoot(root);
  const target = path.join(base, ...siteSegments(rel));
  if (!isInside(base, target) || target === base) throw new Error('Paths may not leave the site folder');
  if (!isInside(base, realAncestor(path.dirname(target)))) throw new Error('The path leads outside the site folder through a link');
  return { base, target };
}
async function readTree(base, maxFiles) {
  const files = [];
  let bytes = 0;
  let truncated = false;
  async function walk(dir, prefix) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= maxFiles || bytes >= MAX_FOLDER_BYTES) { truncated = true; return; }
      if (SKIP_NAMES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      let st;
      try {
        // Links are followed only when they stay inside the site folder.
        const real = e.isSymbolicLink() ? await fs.promises.realpath(full) : full;
        if (e.isSymbolicLink() && !isInside(base, real)) continue;
        st = await fs.promises.stat(real);
      } catch { continue; }
      if (st.isDirectory()) { if (prefix.split('/').length < 40) await walk(full, rel); continue; }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES || bytes + st.size > MAX_FOLDER_BYTES) { truncated = true; continue; }
      try {
        const data = await fs.promises.readFile(full);
        bytes += data.length;
        files.push({ path: rel, data: data.toString('base64') });
      } catch { /* unreadable: skip */ }
    }
  }
  await walk(base, '');
  return { files, truncated };
}
function writeAtomic(target, buf) {
  const tmp = `${target}.ql-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, buf, { flag: 'wx' });
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
    throw e;
  }
}

// ------------------------------------------------------------------------------------------
// Page previews: HTML served from preview://p/<id>, an origin separate from the app

const previews = new Map(); // id → html
let previewBytes = 0;
let previewSeq = 0;
const MAX_PREVIEWS = 20;
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
const PREVIEW_CSP = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors app:";
function setPreview(id, html) {
  if (previews.has(id)) { previewBytes -= previews.get(id).length; previews.delete(id); }
  previews.set(id, html);
  previewBytes += html.length;
  for (const [k, v] of previews) {
    if (previews.size <= MAX_PREVIEWS && previewBytes <= MAX_PREVIEW_BYTES) break;
    if (k === id) continue;
    previews.delete(k);
    previewBytes -= v.length;
  }
}
function servePreviews() {
  protocol.handle(PREVIEW, async (req) => {
    const u = new URL(req.url);
    const id = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    const html = u.host === 'p' ? previews.get(id) : undefined;
    if (html == null) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PREVIEW_CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
    });
  });
}

// ------------------------------------------------------------------------------------------
// Secure storage (API keys): encrypted with the OS keychain / DPAPI / libsecret via safeStorage

const secureFile = () => path.join(app.getPath('userData'), 'secure.json');
function readSecure() { try { return JSON.parse(fs.readFileSync(secureFile(), 'utf8')); } catch { return {}; } }
function writeSecure(o) { fs.writeFileSync(secureFile(), JSON.stringify(o), { mode: 0o600 }); }
function seal(v) {
  return safeStorage.isEncryptionAvailable() ? { enc: true, v: safeStorage.encryptString(v).toString('base64') } : { enc: false, v };
}
function unseal(rec) {
  if (!rec) return null;
  return rec.enc ? safeStorage.decryptString(Buffer.from(rec.v, 'base64')) : rec.v;
}

// ------------------------------------------------------------------------------------------
// OAuth loopback (OpenRouter PKCE), as on Android: one-shot listener on 127.0.0.1 only

let loop = null;
function stopLoop() { if (loop) { clearTimeout(loop.timer); try { loop.server.close(); } catch { /* */ } loop = null; } }

// ------------------------------------------------------------------------------------------
// IPC

const safeUrl = (u) => typeof u === 'string' && /^(https?|mailto|tel|ftp|sms|geo):/i.test(u.trim());
function handle(name, fn) {
  ipcMain.handle('ql:' + name, async (e, opts) => {
    if (!win || e.sender !== win.webContents || !e.senderFrame || !e.senderFrame.url.startsWith(ORIGIN)) throw new Error('Refused');
    return fn(opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {});
  });
}

function registerIpc() {
  handle('openDocument', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'Web pages and sites', extensions: OPENABLE },
        { name: 'Web pages', extensions: ['html', 'htm', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'jsp'] },
        { name: 'Templates and library items', extensions: ['dwt', 'lbi', 'tpl', 'twig', 'hbs', 'liquid'] },
        { name: 'Style sheets and scripts', extensions: ['css', 'scss', 'less', 'js', 'mjs'] },
        { name: 'Site archives (ZIP, Anne\'s Loom site, web archive)', extensions: ['zip', 'qlsite', 'mht', 'mhtml'] },
        { name: 'Documents', extensions: DOCUMENTS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    grant(r.filePaths[0]);
    return fileResult(r.filePaths[0]);
  });
  handle('saveAs', async ({ name, data }) => {
    const ext = path.extname(String(name || '')).slice(1);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), path.basename(String(name || 'index.html'))),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : undefined,
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64'));
    grant(r.filePath);
    return { uri: pathToFileURL(r.filePath).href, name: path.basename(r.filePath) };
  });
  handle('writeUri', async ({ uri, data }) => {
    const p = grantedPath(uri);
    // Write a temporary file first, so a failed write never truncates the file.
    writeAtomic(p, Buffer.from(String(data || ''), 'base64'));
    return { ok: true };
  });
  handle('readUri', async ({ uri }) => fileResult(grantedPath(uri)));
  handle('print', async () => new Promise((res) => win.webContents.print({}, () => res())));
  handle('share', async ({ name, data }) => {
    // Desktops have no share sheet: offer Save As.
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), path.basename(String(name || 'site.zip'))) });
    if (!r.canceled && r.filePath) { fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64')); grant(r.filePath); }
  });
  handle('getLaunchFile', async () => {
    const p = pendingFiles.shift();
    return p ? fileResult(p) : {};
  });
  // Sent by the preload script once the page listens for fileOpened: deliver anything that arrived earlier.
  ipcMain.on('ql:fileListenerReady', (e) => { if (win && e.sender === win.webContents) { rendererReady = true; flushPendingFiles(); } });
  handle('keepAwake', async ({ on }) => {
    if (on && wakeId < 0) wakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && wakeId >= 0) { powerSaveBlocker.stop(wakeId); wakeId = -1; }
  });
  handle('secureSet', async ({ key, value }) => { const o = readSecure(); o[String(key)] = seal(String(value)); writeSecure(o); });
  handle('secureGet', async ({ key }) => { try { return { value: unseal(readSecure()[String(key)]) }; } catch { return { value: null }; } });
  handle('secureRemove', async ({ key }) => { const o = readSecure(); delete o[String(key)]; writeSecure(o); });
  handle('readClipboard', async () => ({ text: clipboard.readText() }));
  handle('writeClipboard', async ({ text }) => { clipboard.writeText(String(text ?? '')); });
  handle('startLoopback', async ({ timeoutMs, successHtml, path: want }) => {
    stopLoop();
    const server = http.createServer((req, res) => {
      // Only this sign-in's nonce path counts: another program probing the port must not end it.
      if (typeof want === 'string' && want && String(req.url || '').split('?')[0] !== want) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(typeof successHtml === 'string' ? successHtml : '<p>You can close this tab.</p>');
      const port = server.address().port;
      if (win) win.webContents.send('ql:oauthCallback', { url: `http://127.0.0.1:${port}${req.url}` });
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      setTimeout(stopLoop, 500);
    });
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    loop = { server, timer: setTimeout(stopLoop, Math.min(Number(timeoutMs) || 300000, 900000)) };
    return { port: server.address().port };
  });
  handle('stopLoopback', async () => stopLoop());
  handle('openExternal', async ({ url }) => { if (safeUrl(url)) await shell.openExternal(url); });
  // Hand a document to the program registered for its type (Anne's Pen, Anne's Post or Anne's Loom when installed).
  handle('openWith', async ({ name, data }) => {
    const base = path.basename(String(name || 'document')).replace(/[\\/:*?"<>|]/g, '_');
    const ext = path.extname(base).slice(1).toLowerCase();
    if (!DOCUMENTS.includes(ext)) return { ok: false, error: 'This kind of file is not handed to other programs.' };
    const dir = path.join(app.getPath('temp'), 'quillloom-handoff');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now().toString(36)}-${base}`);
    fs.writeFileSync(file, Buffer.from(String(data || ''), 'base64'));
    const err = await shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true };
  });
  handle('http', async ({ url, method, headers, data, binary }) => {
    if (typeof url !== 'string' || url.length > 8192 || !/^https:\/\//i.test(url)) throw new Error('Only https requests are allowed');
    const m = String(method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) throw new Error('Unsupported method');
    const h = {};
    if (headers && typeof headers === 'object') for (const [k, v] of Object.entries(headers)) if (typeof v === 'string' && /^[\w-]+$/.test(k)) h[k] = v;
    const res = await net.fetch(url, { method: m, headers: h, body: data == null || m === 'GET' || m === 'HEAD' ? undefined : typeof data === 'string' ? data : JSON.stringify(data) });
    if (binary === true) {
      // Downloads (a published site's images, fonts…): base64 body, capped.
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 100 * 1024 * 1024) throw new Error('The download is larger than 100 MB');
      const type = res.headers.get('content-type') || '';
      return { status: res.status, text: '', data: buf.toString('base64'), contentType: type, headers: { 'content-type': type } };
    }
    return { status: res.status, text: await res.text() };
  });

  // ---- Site folders ----
  handle('openFolder', async ({ maxFiles }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Open Site', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true, root: '', name: '', files: [] };
    const max = Number.isInteger(maxFiles) && maxFiles > 0 ? Math.min(maxFiles, 100000) : 20000;
    const root = grantRoot(r.filePaths[0]);
    const { files, truncated } = await readTree(root, max);
    return { root, name: path.basename(root) || root, files, truncated };
  });
  handle('chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a Folder for the Site', buttonLabel: 'Choose Folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true, root: '' };
    return { root: grantRoot(r.filePaths[0]) };
  });
  handle('writeFolderFile', async ({ root, path: rel, data }) => {
    if (typeof data !== 'string') throw new Error('Invalid file data');
    const buf = Buffer.from(data, 'base64');
    if (buf.length > MAX_FILE_BYTES) throw new Error('The file is too large');
    const { base, target } = folderTarget(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Check again after creating folders: a folder in the path may have been a link.
    if (!isInside(base, fs.realpathSync(path.dirname(target)))) throw new Error('The path leads outside the site folder through a link');
    try { if (fs.lstatSync(target).isDirectory()) throw new Error('A folder with this name exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    writeAtomic(target, buf);
    return { ok: true };
  });
  handle('deleteFolderFile', async ({ root, path: rel }) => {
    const { target } = folderTarget(root, rel);
    // rmSync removes a link itself, never what it points to.
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  });

  // ---- Preview origin ----
  handle('setPreview', async ({ id, html }) => {
    if (typeof id !== 'string' || !/^[\w.-]{1,128}$/.test(id)) throw new Error('Invalid preview id');
    if (typeof html !== 'string' || html.length > MAX_PREVIEW_BYTES) throw new Error('The preview is too large');
    setPreview(id, html);
    return { url: `${PREVIEW_ORIGIN}/${encodeURIComponent(id)}?v=${++previewSeq}` };
  });

  // ---- Publishing ----
  handle('ftp', async (o) => ftpPublish(o));
}

// ------------------------------------------------------------------------------------------
// Window

// Content Security Policy for the app. 'unsafe-eval' is needed by user macros (Developer tab);
// cdn.jsdelivr.net and wasm are for the optional on-device AI model; http to localhost is for
// Ollama and LM Studio. Inline scripts and plugins are never allowed. Design view frames show the
// site's pages without running scripts, so images, media, style sheets and fonts may come from the
// web (pages link to CDNs); page previews, which do run scripts, are served from preview://.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* data: blob:",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'self' preview: blob: data:",
].join('; ');

function serveApp() {
  protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return new Response('Forbidden', { status: 403 });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html');
    const res = await net.fetch(pathToFileURL(target).href);
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

// The app draws its own ribbon and menu bar; the native menu only carries the standard editing
// shortcuts (needed on macOS for copy and paste), zoom and full screen.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Pages in a preview may ask for the camera, location and so on; only the app itself gets
// anything, and only what it uses.
function limitPermissions() {
  const ses = session.defaultSession;
  const appAllowed = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'media']);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const from = String((details && (details.requestingUrl || details.securityOrigin)) || '');
    cb(from.startsWith(ORIGIN) && appAllowed.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => String(origin || '').startsWith(ORIGIN) && appAllowed.has(permission));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    title: 'Anne\'s Loom',
    backgroundColor: '#ffffff',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false, // Anne's Loom has its own spelling checker
    },
  });
  // Links (in the app and in page previews) open in the system browser; the app opens no windows of
  // its own and the main window never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safeUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // A preview page may navigate its own frame (links between site pages are handled by the app);
  // a frame may never load file: or other local addresses.
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return;
    const url = String(e.url || '');
    if (!/^(preview:|about:|blob:|data:|https?:)/i.test(url) && !url.startsWith(ORIGIN)) e.preventDefault();
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (safeUrl(url)) void shell.openExternal(url); } });
  // The page asks before unloading with unsaved pages: confirm here, as the browser would.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Unsaved changes', message: 'Some pages have unsaved changes. Close Anne\'s Loom anyway?' });
    if (choice === 0) e.preventDefault();
  });
  // A reload or navigation drops the page's listeners until it registers them again.
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.on('closed', () => { win = null; rendererReady = false; });
  void win.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', (_e, argv) => {
  const p = fileFromArgs(argv);
  if (p) openExternalFile(p);
  else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
// macOS: files opened from Finder (before or after launch).
app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) openExternalFile(p); else pendingFiles.push(p); });

app.whenReady().then(() => {
  loadGrants();
  loadRoots();
  const p = fileFromArgs(process.argv);
  if (p) pendingFiles.unshift(p);
  for (const f of pendingFiles) grant(f);
  limitPermissions();
  serveApp();
  servePreviews();
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { stopLoop(); if (process.platform !== 'darwin') app.quit(); });
