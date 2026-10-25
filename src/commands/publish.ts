/**
 * Publishing commands: Publish Site (choose a destination, review the files), publish changed / all /
 * selected files, Get and Put, Synchronize, Compare with Remote, destinations, the publish log and
 * supporting files. The engine is in site/publish.ts.
 *
 * Passwords and tokens are never written into the site. They are asked once per session, or kept in this
 * device's key store (the same one the AI keys use) under "publish:<destination id>" when "Remember" is ticked.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog, choiceDialog, alertDialog, type DialogControl } from '../ui/dialog';
import { h, clear, download } from '../ui/dom';
import { newId, type PublishProfile, type PublishKind } from '../model/site';
import { baseName, isPagePath, slugify, isTextPath } from '../model/paths';
import { desktopFolders, saveAs, isDesktop } from '../platform/native';
import { getApiKey, setApiKey, deleteApiKey } from '../ai/store';
import { publishToWordPress } from '../io/wordpress';
import {
  publishStatus, selectFiles, orphans, runPublish, appendPublishLog, readPublishLog, compareWithRemote, gitBlobSha, publishBytes,
  zipDestination, folderDestination, webdavDestination, ftpDestination, githubDestination, KIND_LABELS,
  type Destination, type FolderTarget, type PublishItem, type SyncEntry,
} from '../site/publish';
import { pageResources, linkIndex, formatSize, sitemapXml, robotsTxt, searchIndex } from '../site/reports';
import { syncDisk, ensureBaseUrl } from './site';

const hasSite = (app: App) => app.site.files.size > 0;

// ------------------------------------------------------------------------------------------
// Destinations and secrets

const sessionSecrets = new Map<string, string>();
/** Folder destinations: the picked folder handle (or desktop path) for each destination, this session. */
const folderTargets = new Map<string, FolderTarget>();

const NEEDS_SECRET: PublishKind[] = ['webdav', 'ftp', 'sftp', 'wordpress', 'github'];
const secretLabel = (p: PublishProfile) => (p.kind === 'github' ? 'Personal access token' : p.kind === 'wordpress' ? 'Application password' : 'Password');

async function getSecret(p: PublishProfile): Promise<string | null> {
  if (!NEEDS_SECRET.includes(p.kind)) return '';
  if (sessionSecrets.has(p.id)) return sessionSecrets.get(p.id)!;
  const stored = await getApiKey(`publish:${p.id}`).catch(() => '');
  if (stored) { sessionSecrets.set(p.id, stored); return stored; }
  const r = await openDialog({
    title: `Sign In – ${p.name}`,
    help: p.kind === 'github' ? 'A fine-grained personal access token with "Contents: Read and write" permission on the repository (github.com → Settings → Developer settings → Personal access tokens).'
      : p.kind === 'wordpress' ? 'An application password (WordPress → Users → Profile → Application Passwords), not your sign-in password.' : `Password for ${p.user || 'the account'} at ${p.url}.`,
    fields: [
      { key: 'secret', label: secretLabel(p), type: 'password', value: '', autofocus: true },
      { key: 'remember', label: 'Remember on this device', type: 'checkbox', value: false, help: 'Kept in this device\'s key store, never in the site file.' },
    ],
  });
  if (!r) return null;
  const s = String(r.secret || '');
  sessionSecrets.set(p.id, s);
  if (r.remember) await setApiKey(`publish:${p.id}`, s).catch(() => toast('The password could not be stored on this device.'));
  return s;
}

function forgetSecret(p: PublishProfile): void { sessionSecrets.delete(p.id); void deleteApiKey(`publish:${p.id}`).catch(() => {}); }

async function pickFolderTarget(p: PublishProfile): Promise<FolderTarget | null> {
  if (desktopFolders) { const r = await desktopFolders.chooseFolder({}); if (!r || r.canceled) return null; const t: FolderTarget = { kind: 'desktop', root: r.root }; folderTargets.set(p.id, t); p.url = r.root; return t; }
  const pick = (window as any).showDirectoryPicker;
  if (!pick) { toast('This browser cannot write to folders. Use a ZIP file, or a Chromium-based browser or the desktop app.', { ms: 7000 }); return null; }
  try { const handle = await pick({ mode: 'readwrite', id: 'quillloom-publish' }); const t: FolderTarget = { kind: 'fsa', handle, name: handle.name }; folderTargets.set(p.id, t); p.url = handle.name; return t; }
  catch { return null; }
}

/** The destination object for a profile, asking for a folder or password when needed. Null when canceled. */
async function destinationFor(app: App, p: PublishProfile): Promise<Destination | null> {
  switch (p.kind) {
    case 'zip': return zipDestination(`${slugify(app.site.name)}.zip`, (blob, name) => saveAs(blob, name));
    case 'folder': {
      let t = folderTargets.get(p.id) || (desktopFolders && p.url && /[\\/]/.test(p.url) ? ({ kind: 'desktop', root: p.url } as FolderTarget) : undefined);
      if (!t) {
        if (!(await confirmDialog('Choose Folder', `Choose the folder to publish "${p.name}" to. The browser asks again each session; the folder is not remembered in the site.`, 'Choose Folder…'))) return null;
        t = (await pickFolderTarget(p)) || undefined;
      }
      return t ? folderDestination(t, desktopFolders) : null;
    }
    case 'webdav': { const s = await getSecret(p); return s == null ? null : webdavDestination(p, s); }
    case 'ftp': case 'sftp': { const s = await getSecret(p); return s == null ? null : ftpDestination(p, s, desktopFolders ? (o) => desktopFolders!.ftp(o) : null); }
    case 'github': { const s = await getSecret(p); return s == null ? null : githubDestination(p, s); }
    case 'wordpress': return null; // handled separately
  }
  return null;
}

const defaultProfile = (app: App): PublishProfile | undefined => app.site.data.publish.find((p) => p.id === app.site.data.meta['publish:default']) || app.site.data.publish[0];

function profileSummary(p: PublishProfile): string {
  return `${KIND_LABELS[p.kind] || p.kind}${p.url ? ` – ${p.url}` : ''}${p.remoteDir ? ` / ${p.remoteDir}` : ''}`;
}

/** New or edit destination dialog. */
async function editProfile(app: App, existing?: PublishProfile): Promise<PublishProfile | null> {
  const p: PublishProfile = existing ? { ...existing, options: { ...(existing.options || {}) } } : { id: newId('pub'), name: '', kind: 'zip', url: '', options: {} };
  const kinds: PublishKind[] = ['zip', 'folder', 'webdav', 'ftp', 'github', 'wordpress', 'sftp'];
  const urlLabel: Record<string, string> = { webdav: 'WebDAV address (https://…)', ftp: 'FTP server (ftp.example.com or ftps://host:port)', sftp: 'Server', github: 'Repository (owner/name)', wordpress: 'WordPress site address (https://…)', folder: 'Folder', zip: '' };
  const r = await openDialog({
    title: existing ? 'Edit Destination' : 'New Publishing Destination', wide: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: p.name, placeholder: 'My web host', autofocus: true },
      { key: 'kind', label: 'Publish to', type: 'select', value: p.kind, options: kinds.map((k) => ({ value: k, label: KIND_LABELS[k] })) },
      { key: 'kindHelp', type: 'info', html: '' },
      { key: 'url', label: 'Address', type: 'text', value: p.url, visibleIf: (v) => v.kind !== 'zip' && v.kind !== 'folder' },
      { key: 'chooseFolder', type: 'button', label: 'Choose folder…', visibleIf: (v) => v.kind === 'folder', onClick: async (_v, ctl) => { const t = await pickFolderTarget(p); if (t) ctl.set('folderInfo', t.kind === 'desktop' ? t.root : t.name || ''); } },
      { key: 'folderInfo', label: 'Chosen folder', type: 'text', value: p.kind === 'folder' ? p.url : '', visibleIf: (v) => v.kind === 'folder' },
      { key: 'user', label: 'User name', type: 'text', value: p.user || '', half: true, visibleIf: (v) => ['webdav', 'ftp', 'sftp', 'wordpress'].includes(v.kind) },
      { key: 'remoteDir', label: 'Remote folder', type: 'text', value: p.kind === 'wordpress' ? '' : p.remoteDir || '', half: true, placeholder: 'public_html, docs…', visibleIf: (v) => ['webdav', 'ftp', 'sftp', 'github'].includes(v.kind) },
      { key: 'wpType', label: 'Publish pages as', type: 'select', value: p.kind === 'wordpress' ? p.remoteDir || 'page' : 'page', options: [{ value: 'page', label: 'WordPress pages' }, { value: 'post', label: 'WordPress posts' }], visibleIf: (v) => v.kind === 'wordpress' },
      { key: 'branch', label: 'Branch', type: 'text', value: p.options?.branch || 'main', half: true, visibleIf: (v) => v.kind === 'github' },
      { key: 'secure', label: 'Use FTPS (FTP over TLS)', type: 'checkbox', value: p.options?.secure ?? true, visibleIf: (v) => v.kind === 'ftp' },
      { key: 'port', label: 'Port', type: 'number', value: p.options?.port ?? null, half: true, visibleIf: (v) => v.kind === 'ftp' },
      { key: 'opts', type: 'heading', label: 'Options' },
      { key: 'expandIncludes', label: 'Expand server-side includes in pages (for hosts that do not run them)', type: 'checkbox', value: !!p.options?.expandIncludes },
      { key: 'deleteOrphans', label: 'Delete remote files that were removed from the site', type: 'checkbox', value: !!p.options?.deleteOrphans, visibleIf: (v) => v.kind !== 'zip' && v.kind !== 'wordpress' },
      { key: 'exclude', label: 'Also leave out (patterns, one per line)', type: 'textarea', rows: 2, value: Array.isArray(p.options?.exclude) ? p.options!.exclude.join('\n') : p.options?.exclude || '', placeholder: 'Templates/\n*.psd' },
      { key: 'isDefault', label: 'Use as the default destination', type: 'checkbox', value: !existing || app.site.data.meta['publish:default'] === p.id || app.site.data.publish.length === 0 },
      ...(existing && NEEDS_SECRET.includes(existing.kind) ? [{ key: 'forget', type: 'button' as const, label: 'Forget saved password', onClick: () => { forgetSecret(existing); toast('The saved password was removed from this device.'); } }] : []),
    ],
    onOpen: (ctl) => updateKindHelp(ctl),
    onChange: (_v, ctl, key) => { if (key === 'kind') updateKindHelp(ctl); },
    validate: (v) => {
      if (!String(v.name || '').trim()) return 'Give the destination a name.';
      if (v.kind === 'sftp') return 'SFTP (SSH) is not supported. Choose FTP with FTPS turned on, which most hosts that offer SFTP also accept.';
      if ((v.kind === 'webdav' || v.kind === 'wordpress') && !/^https?:\/\//i.test(v.url || '')) return 'The address starts with https://';
      if (v.kind === 'ftp' && !String(v.url || '').trim()) return 'Enter the FTP server name.';
      if (v.kind === 'github' && !/^(https?:\/\/github\.com\/)?[\w.-]+\/[\w.-]+\/?$/i.test(String(v.url || '').trim())) return 'Enter the repository as owner/name.';
      return null;
    },
  });
  function updateKindHelp(ctl: DialogControl) {
    const kind = ctl.get('kind') as PublishKind;
    const help: Record<string, string> = {
      zip: 'Downloads the files as a ZIP archive that you can upload with your host\'s file manager.',
      folder: isDesktop() ? 'Copies the files into another folder on this computer (for example a synced or served folder).' : 'Copies the files into a folder on this device. Needs a browser with folder access (Chromium-based); the folder is chosen again each session.',
      webdav: 'Uploads with WebDAV (MKCOL and PUT). ' + (isDesktop() ? '' : 'From the web app the server must allow this app\'s origin (CORS); many hosting control panels do not.'),
      ftp: isDesktop() ? 'Uploads over FTP or FTPS from the desktop app.' : 'FTP needs the Anne\'s Loom desktop app: web pages cannot open FTP connections.',
      sftp: 'SFTP (SSH file transfer) is not supported. Most hosts also accept FTPS: choose FTP and turn on FTPS.',
      github: 'Commits each file to a GitHub repository with the REST API; turn on GitHub Pages for the branch and folder in the repository settings. Works from the browser.',
      wordpress: 'Creates or updates WordPress pages or posts from your pages through the WordPress REST API, with an application password.',
    };
    const el = ctl.body.querySelector('.ql-info');
    if (el) el.textContent = help[kind] || '';
    const label = ctl.body.querySelector(`label[for$="url"]`) || null;
    if (label && urlLabel[kind]) label.textContent = urlLabel[kind];
  }
  if (!r) return null;
  Object.assign(p, {
    name: String(r.name).trim(), kind: r.kind, user: r.user || undefined,
    url: r.kind === 'folder' ? (folderTargets.get(p.id) ? p.url : r.folderInfo || p.url) : r.kind === 'zip' ? '' : String(r.url || '').trim(),
    remoteDir: r.kind === 'wordpress' ? r.wpType : String(r.remoteDir || '').trim() || undefined,
  });
  p.options = { ...(p.options || {}), expandIncludes: !!r.expandIncludes, deleteOrphans: !!r.deleteOrphans, exclude: String(r.exclude || '').split('\n').map((s: string) => s.trim()).filter(Boolean) };
  if (r.kind === 'github') p.options.branch = String(r.branch || 'main').trim();
  if (r.kind === 'ftp') { p.options.secure = !!r.secure; if (r.port) p.options.port = Number(r.port); else delete p.options.port; }
  const list = app.site.data.publish;
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0) list[i] = p; else list.push(p);
  if (r.isDefault) app.site.data.meta['publish:default'] = p.id;
  app.site.touchMeta();
  return p;
}

async function chooseProfile(app: App, title = 'Publish To'): Promise<PublishProfile | null> {
  const list = app.site.data.publish;
  if (!list.length) return editProfile(app);
  const r = await openDialog({
    title,
    fields: [
      { key: 'id', label: 'Destination', type: 'list', rows: Math.min(8, list.length + 1), value: defaultProfile(app)?.id, options: list.map((p) => ({ value: p.id, label: `${p.name} – ${profileSummary(p)}` })) },
      { key: 'new', type: 'button', label: 'New destination…', onClick: (_v, ctl) => ctl.close({ id: '__new' }) },
    ],
  });
  if (!r) return null;
  if (r.id === '__new') return editProfile(app);
  return list.find((p) => p.id === r.id) || null;
}

// ------------------------------------------------------------------------------------------
// Running a publish with progress and a log

async function publishPaths(app: App, p: PublishProfile, paths: string[], opts: { removeOrphans?: boolean } = {}): Promise<boolean> {
  for (const d of app.docs) d.ui.flush();
  if (!paths.length && !(opts.removeOrphans && orphans(app.site, p).length)) { toast(`Nothing to publish to ${p.name}: every file is up to date.`); return false; }
  const lines: string[] = [];
  const log = (l: string) => { lines.push(l); };
  if (p.kind === 'wordpress') {
    const s = await getSecret(p);
    if (s == null) return false;
    const pages = paths.filter(isPagePath);
    app.ui.status?.(`Publishing ${pages.length} pages to WordPress…`);
    try {
      const n = await publishToWordPress(app.site, p, pages, s, log);
      p.published = p.published || {};
      for (const path of pages) p.published[path] = app.site.get(path)?.modified ?? Date.now();
      log(`Done: ${n} item${n === 1 ? '' : 's'} published to WordPress.`);
      toast(`Published ${n} item${n === 1 ? '' : 's'} to ${p.name}.`);
    } catch (e: any) {
      log(`FAILED: ${e?.message || e}`);
      if (/401|403/.test(e?.message || '')) sessionSecrets.delete(p.id);
      toast(`WordPress publishing failed: ${e?.message || e}`, { ms: 8000 });
    }
    appendPublishLog(app.site, [`${p.name} (WordPress)`, ...lines]);
    return true;
  }
  const dest = await destinationFor(app, p);
  if (!dest) return false;
  const signal = { cancelled: false };
  const bar = h('progress', { max: String(Math.max(1, paths.length)), value: '0', style: 'width:100%' }) as HTMLProgressElement;
  const now = h('div', { class: 'ql-help' }, 'Starting…');
  let ctlRef: DialogControl | null = null;
  const dlg = openDialog({ title: `Publishing to ${p.name}`, content: h('div', null, h('p', null, dest.label), bar, now), ok: false, cancel: 'Cancel', onOpen: (c) => { ctlRef = c; } });
  dlg.then(() => { signal.cancelled = true; });
  let res;
  try {
    res = await runPublish(app.site, p, paths, dest, {
      log, signal, removeOrphans: opts.removeOrphans ?? !!p.options?.deleteOrphans,
      progress: (d, t, path) => { bar.value = d; now.textContent = path ? `${d + 1} of ${t}: ${path}` : 'Finishing…'; app.ui.status?.(`Publishing ${d}/${t}`); },
    });
  } finally {
    // The dialog's promise turns the cancel flag on; the publish has ended either way.
    (ctlRef as DialogControl | null)?.close();
  }
  appendPublishLog(app.site, [`${p.name} (${p.kind})`, ...lines]);
  app.site.touchMeta();
  if (res.failed.length && /\b401\b|password|token/i.test(res.failed[0].error)) sessionSecrets.delete(p.id);
  if (res.failed.length) {
    const first = res.failed.slice(0, 5).map((f) => `${f.path}: ${f.error}`).join('\n');
    await alertDialog('Publishing Problems', `${res.published.length} file${res.published.length === 1 ? '' : 's'} published, ${res.failed.length} failed.\n${first}${res.failed.length > 5 ? '\n…' : ''}\nSee the publish log for details.`);
  } else if (res.cancelled) toast(`Publishing canceled after ${res.published.length} file${res.published.length === 1 ? '' : 's'}.`);
  else toast(`Published ${res.published.length} file${res.published.length === 1 ? '' : 's'} to ${p.name}${res.removed.length ? `, deleted ${res.removed.length}` : ''}.`, { action: 'Log', onAction: () => app.exec('site.publishLog') });
  return true;
}

/** The Publish Site dialog: destination, what to publish, the file list with check boxes. */
async function publishDialog(app: App, profile?: PublishProfile, preset?: { mode?: 'changed' | 'all' | 'selected'; paths?: string[] }): Promise<void> {
  let p = profile || defaultProfile(app) || (await editProfile(app));
  if (!p) return;
  for (const d of app.docs) d.ui.flush();
  const site = app.site;
  let items: PublishItem[] = [];
  const checked = new Set<string>();
  let mode: 'changed' | 'all' | 'selected' = preset?.mode || 'changed';
  const listEl = h('div', { style: 'max-height:46vh;overflow:auto;border:1px solid var(--border);border-radius:6px' });
  const summary = h('div', { class: 'ql-help', 'aria-live': 'polite' });
  const content = h('div', null, summary, listEl);
  const refill = () => {
    items = publishStatus(site, p!, preset?.paths && mode === 'selected' ? { paths: preset.paths } : {});
    checked.clear();
    for (const i of items) if (i.status !== 'excluded' && (mode === 'all' || i.status !== 'unchanged' || (mode === 'selected' && preset?.paths?.includes(i.path)))) checked.add(i.path);
    draw();
  };
  const draw = () => {
    clear(listEl);
    const table = h('table', { class: 'ql-report-table' }, h('thead', null, h('tr', null,
      h('th', null, h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: items.filter((i) => i.status !== 'excluded').every((i) => checked.has(i.path)), onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; for (const i of items) if (i.status !== 'excluded') { if (on) checked.add(i.path); else checked.delete(i.path); } draw(); } })),
      h('th', null, 'File'), h('th', null, 'Status'), h('th', null, 'Size'), h('th', null, 'Modified'))));
    const body = h('tbody');
    const order = { changed: 0, new: 1, unchanged: 2, excluded: 3 } as Record<string, number>;
    for (const i of [...items].sort((a, b) => order[a.status] - order[b.status] || a.path.localeCompare(b.path))) {
      const ex = i.status === 'excluded';
      body.appendChild(h('tr', { class: ex ? 'ql-dim' : '', title: i.reason || '' },
        h('td', null, h('input', { type: 'checkbox', disabled: ex, checked: checked.has(i.path), 'aria-label': i.path, onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) checked.add(i.path); else checked.delete(i.path); upd(); } })),
        h('td', null, i.path), h('td', null, ex ? i.reason || 'Excluded' : i.status === 'new' ? 'Not published yet' : i.status === 'changed' ? 'Changed' : 'Published'),
        h('td', null, formatSize(i.size)), h('td', null, new Date(i.modified).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }))));
    }
    table.appendChild(body);
    listEl.appendChild(table);
    upd();
  };
  const upd = () => {
    const n = checked.size;
    const bytes = items.filter((i) => checked.has(i.path)).reduce((s, i) => s + i.size, 0);
    const orph = orphans(site, p!).length;
    summary.textContent = `${n} file${n === 1 ? '' : 's'} selected (${formatSize(bytes)}). ${items.filter((i) => i.status === 'changed' || i.status === 'new').length} changed or new since the last publish to this destination.${orph && p!.options?.deleteOrphans ? ` ${orph} file${orph === 1 ? '' : 's'} removed from the site will be deleted remotely.` : ''}`;
  };
  refill();
  const r = await openDialog({
    title: 'Publish Site', wide: true, content, ok: 'Publish',
    fields: [
      { key: 'profile', label: 'Destination', type: 'select', value: p.id, options: site.data.publish.map((x) => ({ value: x.id, label: `${x.name} – ${profileSummary(x)}` })) },
      { key: 'mode', label: 'Publish', type: 'radio', value: mode, options: [{ value: 'changed', label: 'Changed files only' }, { value: 'all', label: 'All files' }, ...(preset?.paths ? [{ value: 'selected', label: 'Selected files' }] : [])] },
      { key: 'edit', type: 'button', label: 'Destination settings…', onClick: async (_v, ctl) => { const np = await editProfile(app, p!); if (np) { p = np; ctl.close({ reopen: true }); } } },
      { key: 'new', type: 'button', label: 'New destination…', onClick: async (_v, ctl) => { const np = await editProfile(app); if (np) { p = np; ctl.close({ reopen: true }); } } },
    ],
    onChange: (v, _ctl, key) => {
      if (key === 'profile') { p = site.data.publish.find((x) => x.id === v.profile) || p; refill(); }
      if (key === 'mode') { mode = v.mode; refill(); }
    },
  });
  if (!r) return;
  if (r.reopen) { await publishDialog(app, p, preset); return; }
  await publishPaths(app, p!, items.filter((i) => checked.has(i.path)).map((i) => i.path));
}

// ------------------------------------------------------------------------------------------
// Remote listing helpers (Synchronize, Get, Compare)

const LISTABLE: PublishKind[] = ['webdav', 'github', 'folder'];

async function remoteFor(app: App, p: PublishProfile, need: 'list' | 'get'): Promise<Destination | null> {
  if (!LISTABLE.includes(p.kind) || (p.kind === 'folder' && isDesktop() && need === 'list')) {
    const why: Record<string, string> = {
      zip: 'A ZIP download has no remote copy to compare with.',
      ftp: 'The desktop FTP connection uploads only; it cannot list or download files yet. Use WebDAV or GitHub to synchronize, or publish changed files.',
      sftp: 'SFTP is not supported.',
      wordpress: 'WordPress pages are not files, so they cannot be listed or compared here.',
      folder: 'The desktop app cannot list other folders yet; publish changed files instead.',
    };
    await alertDialog(need === 'list' ? 'Synchronize' : 'Get', why[p.kind] || 'This destination cannot be read back.');
    return null;
  }
  return destinationFor(app, p);
}

/** Line-by-line differences (longest common subsequence), for Compare with Remote. */
export function lineDiff(a: string, b: string): { op: ' ' | '-' | '+'; line: string }[] {
  const A = a.split(/\r?\n/), B = b.split(/\r?\n/);
  if (A.length * B.length > 4_000_000) return [{ op: ' ', line: '(The files are too large to compare line by line.)' }];
  const n = A.length, m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push({ op: ' ', line: A[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', line: A[i++] }); else out.push({ op: '+', line: B[j++] }); }
  while (i < n) out.push({ op: '-', line: A[i++] });
  while (j < m) out.push({ op: '+', line: B[j++] });
  return out;
}

async function writeFromRemote(app: App, p: PublishProfile, path: string, data: Uint8Array): Promise<void> {
  app.site.write(path, data);
  const f = app.site.get(path)!;
  p.published = p.published || {};
  p.published[path] = f.modified;
  app.docs.find((d) => d.path === path)?.ui.externalChange();
}

// ------------------------------------------------------------------------------------------
// Commands

def([
  { id: 'site.publish', label: 'Publish Site', icon: 'cloud_upload', tab: 'Site', group: 'Publish', popular: true, origin: 'FrontPage, Expression Web, Dreamweaver', isEnabled: hasSite,
    tip: 'Choose a destination and the files to publish',
    run: (app, arg) => publishDialog(app, arg?.profile ? app.site.data.publish.find((p) => p.id === arg.profile) : undefined) },

  { id: 'site.publishChanged', label: 'Publish Changed Files', icon: 'published_with_changes', tab: 'Site', group: 'Publish', origin: 'FrontPage, Expression Web', isEnabled: hasSite,
    tip: 'Publish files changed since the last publish to the default destination',
    run: async (app) => {
      const p = defaultProfile(app) || (await editProfile(app));
      if (!p) return;
      for (const d of app.docs) d.ui.flush();
      await publishPaths(app, p, selectFiles(app.site, p, { changedOnly: true }));
    } },

  { id: 'site.publishAll', label: 'Publish All Files', icon: 'cloud_sync', tab: 'Site', group: 'Publish', origin: 'FrontPage, Expression Web', isEnabled: hasSite,
    tip: 'Publish every file to the default destination, changed or not',
    run: async (app) => {
      const p = defaultProfile(app) || (await editProfile(app));
      if (!p) return;
      const paths = selectFiles(app.site, p, {});
      if (!(await confirmDialog('Publish All Files', `Publish all ${paths.length} files to ${p.name}?`, 'Publish'))) return;
      await publishPaths(app, p, paths);
    } },

  { id: 'site.publishFile', label: 'Publish Selected File', icon: 'upload_file', tab: 'Site', group: 'Publish', origin: 'Expression Web, FrontPage', isEnabled: (app) => !!app.active || hasSite(app),
    tip: 'Publish this file to the default destination',
    run: async (app, arg) => {
      const path = typeof arg === 'string' ? arg : arg?.path || app.active?.path;
      if (!path || !app.site.has(path)) return;
      const p = defaultProfile(app) || (await editProfile(app));
      if (!p) return;
      const f = app.site.get(path)!;
      if (f.noPublish && !(await confirmDialog('Publish', `${path} is marked "Don't publish". Publish it anyway?`, 'Publish'))) return;
      await publishPaths(app, p, [path]);
    } },

  { id: 'site.publishAs', label: 'Publish To', icon: 'drive_folder_upload', tab: 'Site', group: 'Publish', origin: 'KompoZer, FrontPage', isEnabled: hasSite,
    tip: 'Publish to another destination', run: async (app) => { const p = await chooseProfile(app, 'Publish To'); if (p) await publishDialog(app, p); } },

  { id: 'site.put', label: 'Put', icon: 'upload', tab: 'Site', group: 'Publish', origin: 'Dreamweaver', isEnabled: (app) => !!app.active,
    tip: 'Upload the current file (and, if you like, the pictures and style sheets it uses)',
    run: async (app, arg) => {
      const path = typeof arg === 'string' ? arg : arg?.path || app.active?.path;
      if (!path || !app.site.has(path)) return;
      const p = defaultProfile(app) || (await editProfile(app));
      if (!p) return;
      app.docs.find((d) => d.path === path)?.ui.flush();
      let paths = [path];
      if (isPagePath(path)) {
        const deps = pageResources(app.site, path, linkIndex(app.site)).filter((d) => (p.published?.[d] ?? -1) < (app.site.get(d)?.modified ?? 0));
        if (deps.length) {
          const c = await choiceDialog('Put', `${path} uses ${deps.length} file${deps.length === 1 ? '' : 's'} that ${deps.length === 1 ? 'is' : 'are'} new or changed (${deps.slice(0, 4).map(baseName).join(', ')}${deps.length > 4 ? '…' : ''}). Put ${deps.length === 1 ? 'it' : 'them'} too?`, ['Yes, include them', 'Only this file']);
          if (c < 0) return;
          if (c === 0) paths = [path, ...deps];
        }
      }
      await publishPaths(app, p, paths);
    } },

  { id: 'site.get', label: 'Get', icon: 'download', tab: 'Site', group: 'Publish', edits: true, origin: 'Dreamweaver', isEnabled: hasSite,
    tip: 'Download files from the destination into the site',
    run: async (app, arg) => {
      const p = defaultProfile(app) || (await chooseProfile(app, 'Get From'));
      if (!p) return;
      const dest = await remoteFor(app, p, 'get');
      if (!dest?.get) return;
      let paths: string[];
      const cur = typeof arg === 'string' ? arg : app.active?.path;
      const c = cur ? await choiceDialog('Get', `Download from ${p.name}:`, [`This file (${baseName(cur)})`, 'Every remote file that differs']) : 1;
      if (c < 0) return;
      if (c === 0) paths = [cur!];
      else {
        if (!dest.list) return;
        app.ui.status?.('Reading the remote file list…');
        const remote = await dest.list();
        const sha = p.kind === 'github' ? await localShas(app, p) : undefined;
        paths = compareWithRemote(app.site, p, remote, sha).filter((e) => e.state === 'remoteOnly' || e.state === 'remoteChanged' || e.state === 'different').map((e) => e.path);
        if (!paths.length) { toast('The site already has every remote file.'); return; }
        if (!(await confirmDialog('Get', `Download ${paths.length} file${paths.length === 1 ? '' : 's'} from ${p.name}? Local files with the same names are replaced.\n${paths.slice(0, 10).join('\n')}${paths.length > 10 ? '\n…' : ''}`, 'Get'))) return;
      }
      const local = paths.filter((x) => app.site.has(x) && (p.published?.[x] ?? 0) < (app.site.get(x)?.modified ?? 0));
      if (c === 0 && local.length && !(await confirmDialog('Get', `${cur} has changes that were not published. Replace it with the remote copy?`, 'Replace'))) return;
      let n = 0;
      const lines: string[] = [];
      for (const path of paths) {
        try { const data = await dest.get(path); if (data) { await writeFromRemote(app, p, path, data); n++; lines.push(`  got ${path}`); } else lines.push(`  ${path}: not on the server`); }
        catch (e: any) { lines.push(`  FAILED ${path}: ${e?.message || e}`); }
      }
      appendPublishLog(app.site, [`Get from ${p.name}`, ...lines]);
      await syncDisk(app, paths.filter((x) => app.site.has(x)));
      toast(n ? `Got ${n} file${n === 1 ? '' : 's'} from ${p.name}.` : `Nothing was downloaded. ${lines[0] || ''}`);
    } },

  { id: 'site.synchronize', label: 'Synchronize', icon: 'sync_alt', tab: 'Site', group: 'Publish', edits: true, origin: 'Dreamweaver, Expression Web', isEnabled: hasSite,
    tip: 'Compare the site with the destination and copy newer files both ways',
    run: async (app) => {
      const p = defaultProfile(app) || (await chooseProfile(app, 'Synchronize With'));
      if (!p) return;
      const dest = await remoteFor(app, p, 'list');
      if (!dest?.list) return;
      for (const d of app.docs) d.ui.flush();
      app.ui.status?.('Reading the remote file list…');
      let entries: SyncEntry[];
      try { entries = compareWithRemote(app.site, p, await dest.list(), p.kind === 'github' ? await localShas(app, p) : undefined); }
      catch (e: any) { await alertDialog('Synchronize', `The remote files could not be listed: ${e?.message || e}`); return; }
      const label: Record<string, string> = { same: 'Same', localOnly: 'Only in the site', remoteOnly: 'Only on the server', localChanged: 'Changed in the site', remoteChanged: 'Changed on the server', different: 'Different (unknown which is newer)' };
      const diff = entries.filter((e) => e.state !== 'same');
      if (!diff.length) { toast(`The site and ${p.name} are in sync (${entries.length} files).`); return; }
      const table = h('table', { class: 'ql-report-table' }, h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Status'), h('th', null, 'Local'), h('th', null, 'Remote'))),
        h('tbody', null, ...diff.map((e) => h('tr', null, h('td', null, e.path), h('td', null, label[e.state]), h('td', null, e.local ? formatSize(e.local.size) : '—'), h('td', null, e.remote ? (e.remote.size >= 0 ? formatSize(e.remote.size) : 'present') : '—')))));
      const r = await openDialog({
        title: `Synchronize with ${p.name}`, wide: true, ok: 'Synchronize',
        content: h('div', { style: 'max-height:40vh;overflow:auto' }, table),
        fields: [
          { key: 'dir', label: 'Direction', type: 'radio', value: 'both', options: [{ value: 'put', label: 'Put newer local files' }, { value: 'get', label: 'Get newer remote files' }, { value: 'both', label: 'Both directions' }] },
          { key: 'different', label: 'Files that differ with no known newer side', type: 'select', value: 'skip', options: [{ value: 'skip', label: 'Leave them' }, { value: 'put', label: 'Use the local copy' }, { value: 'get', label: 'Use the remote copy' }] },
          { key: 'delRemote', label: 'Delete remote files that are not in the site', type: 'checkbox', value: false },
        ],
      });
      if (!r) return;
      const put = diff.filter((e) => (r.dir !== 'get' && (e.state === 'localOnly' || e.state === 'localChanged')) || (e.state === 'different' && r.different === 'put')).map((e) => e.path);
      const get = diff.filter((e) => (r.dir !== 'put' && (e.state === 'remoteOnly' || e.state === 'remoteChanged')) || (e.state === 'different' && r.different === 'get')).filter((e) => !(r.delRemote && e.state === 'remoteOnly')).map((e) => e.path);
      const del = r.delRemote ? diff.filter((e) => e.state === 'remoteOnly').map((e) => e.path) : [];
      if (del.length && !(await confirmDialog('Synchronize', `Delete ${del.length} file${del.length === 1 ? '' : 's'} from ${p.name}?\n${del.slice(0, 10).join('\n')}${del.length > 10 ? '\n…' : ''}`, 'Delete'))) return;
      const lines: string[] = [];
      let got = 0;
      for (const path of get) { try { const d = await dest.get!(path); if (d) { await writeFromRemote(app, p, path, d); got++; lines.push(`  got ${path}`); } } catch (e: any) { lines.push(`  FAILED get ${path}: ${e?.message || e}`); } }
      for (const path of del) { try { await dest.remove!(path); lines.push(`  deleted ${path}`); delete p.published?.[path]; } catch (e: any) { lines.push(`  FAILED delete ${path}: ${e?.message || e}`); } }
      appendPublishLog(app.site, [`Synchronize with ${p.name}`, ...lines]);
      if (got) await syncDisk(app, get);
      if (put.length) await publishPaths(app, p, put, { removeOrphans: false });
      else toast(`Synchronized: ${got} got, ${del.length} deleted.`);
    } },

  { id: 'site.compareRemote', label: 'Compare with Remote', icon: 'difference', tab: 'Check', group: 'Compare', noRecord: true, origin: 'Dreamweaver', isEnabled: (app) => !!app.active,
    tip: 'Show the differences between this file and the published copy',
    run: async (app) => {
      const path = app.active?.path;
      if (!path) return;
      app.active.ui.flush();
      const p = defaultProfile(app) || (await chooseProfile(app, 'Compare With'));
      if (!p) return;
      const dest = await remoteFor(app, p, 'get');
      if (!dest?.get) return;
      let remote: Uint8Array | null;
      try { remote = await dest.get(path); } catch (e: any) { await alertDialog('Compare with Remote', `The remote copy could not be read: ${e?.message || e}`); return; }
      if (!remote) { await alertDialog('Compare with Remote', `${path} is not on ${p.name} yet.`); return; }
      const local = publishBytes(app.site, path, p);
      if (local.length === remote.length && local.every((b, i) => b === remote![i])) { toast(`${path} is the same as the copy on ${p.name}.`); return; }
      if (!isTextPath(path)) { await alertDialog('Compare with Remote', `${path} differs from the copy on ${p.name} (${formatSize(local.length)} here, ${formatSize(remote.length)} there).`); return; }
      const d = lineDiff(new TextDecoder().decode(remote), new TextDecoder().decode(local));
      const shown = d.filter((x, i) => x.op !== ' ' || d.slice(Math.max(0, i - 2), i + 3).some((y) => y.op !== ' '));
      const pre = h('pre', { class: 'ql-code-sample', style: 'max-height:50vh' }, ...shown.slice(0, 3000).map((x) => h('div', { style: x.op === '+' ? 'background:rgba(0,160,0,.15)' : x.op === '-' ? 'background:rgba(200,0,0,.15)' : '' }, `${x.op} ${x.line}`)));
      const adds = d.filter((x) => x.op === '+').length, dels = d.filter((x) => x.op === '-').length;
      const r = await openDialog({
        title: `Compare ${baseName(path)} with ${p.name}`, wide: true, ok: false, cancel: 'Close',
        content: h('div', null, h('p', { class: 'ql-help' }, `Lines with + are only in the site copy, lines with − only in the remote copy. ${adds} added, ${dels} removed.`), pre),
        buttons: [
          { label: 'Get remote copy', onClick: (_v, c) => c.close({ action: 'get' }) },
          { label: 'Put local copy', primary: true, onClick: (_v, c) => c.close({ action: 'put' }) },
        ],
      });
      if (r?.action === 'get') { await writeFromRemote(app, p, path, remote); await syncDisk(app, [path]); toast(`${path} replaced with the remote copy.`); }
      else if (r?.action === 'put') await publishPaths(app, p, [path]);
    } },

  { id: 'site.managePublishing', label: 'Publishing Destinations', icon: 'settings_ethernet', tab: 'Site', group: 'Publish', edits: true, origin: 'Expression Web, Dreamweaver',
    tip: 'Add, change or remove places to publish to',
    run: async (app) => {
      const list = app.site.data.publish;
      const def0 = defaultProfile(app)?.id;
      const r = await openDialog({
        title: 'Publishing Destinations', wide: true, ok: false, cancel: 'Close',
        help: list.length ? 'Passwords are not saved in the site. Choose a destination, then an action.' : 'No destinations yet.',
        fields: [
          { key: 'id', label: 'Destinations', type: 'list', rows: 8, value: def0, options: list.map((p) => ({ value: p.id, label: `${p.id === def0 ? '★ ' : ''}${p.name} – ${profileSummary(p)} – ${Object.keys(p.published || {}).length} published` })) },
          { key: 'add', type: 'button', label: 'New…', onClick: (_v, c) => c.close({ action: 'new' }) },
          { key: 'edit', type: 'button', label: 'Edit…', onClick: (v, c) => v.id && c.close({ action: 'edit', id: v.id }) },
          { key: 'default', type: 'button', label: 'Make default', onClick: (v, c) => v.id && c.close({ action: 'default', id: v.id }) },
          { key: 'dup', type: 'button', label: 'Duplicate', onClick: (v, c) => v.id && c.close({ action: 'dup', id: v.id }) },
          { key: 'reset', type: 'button', label: 'Forget what was published', onClick: (v, c) => v.id && c.close({ action: 'reset', id: v.id }) },
          { key: 'del', type: 'button', label: 'Delete', onClick: (v, c) => v.id && c.close({ action: 'del', id: v.id }) },
        ],
      });
      if (!r?.action) return;
      const p = list.find((x) => x.id === r.id);
      if (r.action === 'new') await editProfile(app);
      else if (r.action === 'edit' && p) await editProfile(app, p);
      else if (r.action === 'default' && p) { app.site.data.meta['publish:default'] = p.id; app.site.touchMeta(); }
      else if (r.action === 'dup' && p) { list.push({ ...JSON.parse(JSON.stringify(p)), id: newId('pub'), name: `${p.name} (copy)`, published: {} }); app.site.touchMeta(); }
      else if (r.action === 'reset' && p) { if (await confirmDialog('Forget Published Files', `The next "changed files" publish to ${p.name} will send every file. Continue?`)) { p.published = {}; app.site.touchMeta(); } }
      else if (r.action === 'del' && p) { if (await confirmDialog('Delete Destination', `Delete the destination ${p.name}? Files already published stay where they are.`, 'Delete')) { app.site.data.publish = list.filter((x) => x !== p); forgetSecret(p); folderTargets.delete(p.id); if (app.site.data.meta['publish:default'] === p.id) delete app.site.data.meta['publish:default']; app.site.touchMeta(); } }
      app.exec('site.managePublishing');
    } },

  { id: 'site.publishSettings', label: 'Publish Settings', icon: 'tune', tab: 'Site', group: 'Publish', edits: true, origin: 'KompoZer, Expression Web',
    tip: 'Settings of the default publishing destination',
    run: async (app) => { const p = defaultProfile(app); await editProfile(app, p); } },

  { id: 'site.publishLog', label: 'Publish Log', icon: 'receipt_long', tab: 'Site', group: 'Publish', noRecord: true, origin: 'Expression Web, FrontPage',
    tip: 'What was published, and when',
    run: async (app) => {
      const lines = readPublishLog(app.site);
      const r = await openDialog({
        title: 'Publish Log', wide: true, ok: false, cancel: 'Close',
        content: h('pre', { class: 'ql-code-sample', style: 'max-height:60vh' }, lines.length ? lines.join('\n') : 'Nothing has been published from this site yet.'),
        buttons: [
          { label: 'Save as text', onClick: () => download(new Blob([lines.join('\n')], { type: 'text/plain' }), 'publish-log.txt') },
          { label: 'Clear', onClick: (_v, c) => c.close({ clear: true }) },
        ],
      });
      if (r?.clear) { delete app.site.data.meta.publishLog; app.site.touchMeta(); toast('Publish log cleared.'); }
    } },

  { id: 'site.deployFiles', label: 'Deploy Supporting Files', icon: 'deployed_code', tab: 'Site', group: 'Publish', edits: true, origin: 'Dreamweaver', isEnabled: hasSite,
    tip: 'Generate and publish sitemap.xml, robots.txt, the search index and host files',
    run: async (app) => {
      const p = defaultProfile(app) || (await editProfile(app));
      if (!p) return;
      const r = await openDialog({
        title: 'Deploy Supporting Files', help: `Creates or refreshes these files in the site and publishes them to ${p.name}.`,
        fields: [
          { key: 'sitemap', label: 'sitemap.xml', type: 'checkbox', value: true },
          { key: 'robots', label: 'robots.txt', type: 'checkbox', value: !app.site.has('robots.txt') },
          { key: 'search', label: 'search-index.json (client-side search)', type: 'checkbox', value: app.site.has('search-index.json') },
          { key: 'nojekyll', label: '.nojekyll (GitHub Pages: serve folders that start with _)', type: 'checkbox', value: p.kind === 'github' },
          { key: 'cname', label: 'CNAME (GitHub Pages custom domain)', type: 'checkbox', value: p.kind === 'github' && !!app.site.data.meta.baseUrl && !/github\.io/i.test(app.site.data.meta.baseUrl) },
        ],
      });
      if (!r) return;
      const paths: string[] = [];
      const put = (path: string, text: string) => { if (app.site.read(path) !== text) app.site.write(path, text); paths.push(path); };
      if (r.sitemap || r.robots || r.cname) { const base = await ensureBaseUrl(app); if (!base) return; }
      const base = app.site.data.meta.baseUrl || '';
      if (r.sitemap) put('sitemap.xml', sitemapXml(app.site, base));
      if (r.robots) put('robots.txt', robotsTxt(app.site, base));
      if (r.search) put('search-index.json', JSON.stringify(searchIndex(app.site), null, 1));
      if (r.nojekyll) put('.nojekyll', '');
      if (r.cname) { try { put('CNAME', new URL(base).hostname + '\n'); } catch { /* bad address */ } }
      await syncDisk(app, paths);
      await publishPaths(app, p, paths);
    } },
]);

async function localShas(app: App, p: PublishProfile): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of app.site.list()) out.set(f.path, await gitBlobSha(publishBytes(app.site, f.path, p)));
  return out;
}
