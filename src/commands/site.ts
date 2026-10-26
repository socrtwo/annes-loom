/**
 * Site commands: files and folders (new, rename/move with link fix-up, duplicate, delete, properties,
 * check out/in), navigation structure, hyperlinks (check, recalculate, change sitewide), tasks,
 * site settings and generated files (sitemap.xml, robots.txt, feed.xml, search-index.json).
 * Reports live in commands/reports.ts and publishing in commands/publish.ts.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog, promptDialog, alertDialog, choiceDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { findNav, defaultNav, pageTitle, linkable, rewriteRefs } from '../model/site';
import { baseName, dirOf, extOf, isPagePath, joinPath, normalizePath, relativeRef, stripExt, isExternal } from '../model/paths';
import { blankPage, esc } from '../model/html';
import { writeToFolder, deleteFromFolder } from '../site/io';
import { updateLibraryItems } from '../site/templates';
import { saveAs, isDesktop } from '../platform/native';
import {
  linkIndex, ensureNav, navAdd, navRemove, navLabel, regenerateLinkBars, sitemapXml, robotsTxt, rssFeed, searchIndex, pageFolders,
  fileSize, formatSize, publicPages,
} from '../site/reports';
import { openAt, navChanged, selectedNavPath, editTask } from '../ui/panesSite';
import '../ui/panesSite';

export { regenerateLinkBars } from '../site/reports';

// ------------------------------------------------------------------------------------------
// Helpers

const hasSite = (app: App) => app.site.files.size > 0;
const hasActive = (app: App) => !!app.active;
const hasPage = (app: App) => !!app.active && isPagePath(app.active.path);

/** The path a command acts on: its argument (a path or {path}), else the active tab's file. */
export function targetPath(app: App, arg: any): string {
  if (typeof arg === 'string') return normalizePath(arg);
  if (arg && typeof arg.path === 'string') return normalizePath(arg.path);
  return app.active?.path || '';
}

/** Mirrors changed files to the site's folder on disk, when the site has one. */
export async function syncDisk(app: App, write: string[], remove: string[] = []): Promise<void> {
  const site = app.site;
  if (!site.folder) return;
  try {
    if (write.length) await writeToFolder(site, write.filter((p) => site.has(p)));
    for (const p of remove) await deleteFromFolder(site, p);
  } catch (e: any) {
    toast(`The site folder could not be updated: ${e?.message || e}. Use Save to write it later.`, { ms: 7000 });
  }
}

/** Every file's text, to tell which files a rename changed. */
function snapshot(app: App): Map<string, string | undefined> {
  return new Map([...app.site.files.values()].map((f) => [f.path, f.text]));
}

/** Renames/moves with link fix-up; reports and mirrors to disk. */
async function doRename(app: App, from: string, to: string): Promise<boolean> {
  const site = app.site;
  from = normalizePath(from); to = normalizePath(to);
  if (!to || from === to) return false;
  for (const d of app.docs) d.ui.flush();
  const before = snapshot(app);
  const wasFolder = !site.has(from);
  let fixed: number;
  try { fixed = site.rename(from, to); } catch (e: any) { toast(e?.message || String(e)); return false; }
  const moved = [...site.lastMoves.values()];
  const changed = [...site.files.values()].filter((f) => { const old = [...site.lastMoves].find(([, b]) => b === f.path)?.[0] ?? f.path; return before.get(old) !== f.text; }).map((f) => f.path);
  const fixedNav = regenerateLinkBars(site);
  toast(`${wasFolder ? 'Folder' : baseName(from)} moved to ${to}.${fixed ? ` Links fixed in ${fixed} file${fixed === 1 ? '' : 's'}.` : ''}`, { ms: 5000 });
  await syncDisk(app, [...new Set([...moved, ...changed, ...fixedNav])], [from]);
  return true;
}

const NEW_FILE_TYPES: { ext: string; label: string; content: (name: string, app: App) => string }[] = [
  { ext: 'html', label: 'HTML page', content: (n, app) => blankPage({ title: stripExt(n), lang: app.site.data.meta.lang || undefined, charset: app.site.data.meta.charset || undefined }) },
  { ext: 'css', label: 'Style sheet (CSS)', content: () => '/* Style sheet */\n\nbody {\n  font-family: system-ui, sans-serif;\n}\n' },
  { ext: 'js', label: 'JavaScript', content: () => "'use strict';\n\n" },
  { ext: 'json', label: 'JSON', content: () => '{\n}\n' },
  { ext: 'xml', label: 'XML', content: () => '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n</root>\n' },
  { ext: 'svg', label: 'SVG picture', content: () => '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">\n  <rect width="200" height="200" fill="#e8eef7"/>\n</svg>\n' },
  { ext: 'php', label: 'PHP page', content: (n) => `<?php\n// ${n}\n?>\n` + blankPage({ title: stripExt(n) }) },
  { ext: 'md', label: 'Markdown', content: (n) => `# ${stripExt(n)}\n\n` },
  { ext: 'txt', label: 'Text file', content: () => '' },
  { ext: 'shtml', label: 'Page with server-side includes', content: (n) => blankPage({ title: stripExt(n), body: '<!--#include virtual="/includes/header.html" -->\n<main>\n</main>' }) },
  { ext: '', label: 'Other (type the extension)', content: () => '' },
];

const author = (app: App) => app.prefs.author || 'Author';

/** Contents saved when a file was checked out, for Undo Check Out (this session only). */
const checkoutCopies = new Map<string, { text?: string; data?: Uint8Array }>();

// ------------------------------------------------------------------------------------------
// Files and folders

def([
  { id: 'site.openFile', label: 'Open File', icon: 'open_in_new', tab: 'Site', group: 'Files', noRecord: true, internal: true, origin: 'FrontPage',
    run: (app, arg) => {
      const path = targetPath(app, arg);
      if (!path) return;
      if (arg && typeof arg === 'object' && arg.line) { openAt(app, path, arg.line); return; }
      app.openFile(path, arg && typeof arg === 'object' && arg.view ? { view: arg.view } : {});
    } },

  { id: 'site.newFolder', label: 'New Folder', icon: 'create_new_folder', tab: 'Site', group: 'Files', edits: true, origin: 'FrontPage, Dreamweaver',
    tip: 'Create a folder in the site',
    run: async (app, arg) => {
      const dir = typeof arg?.dir === 'string' ? arg.dir : app.active ? dirOf(app.active.path) : '';
      const name = typeof arg?.name === 'string' ? arg.name : await promptDialog('New Folder', `Folder name${dir ? ` (in ${dir})` : ''}`, 'new_folder');
      if (!name) return;
      const p = joinPath(dir, name.trim());
      if (!p || app.site.folders().includes(p) || app.site.has(p)) { toast(`${p || 'That name'} already exists.`); return; }
      app.site.addFolder(p);
      // Writing no files still creates the site's empty folders (browser folder access).
      if (app.site.folder) { try { await writeToFolder(app.site, []); } catch (e: any) { toast(`The folder could not be created on disk: ${e?.message || e}`); } }
      toast(`Folder ${p} created.`);
    } },

  { id: 'site.newFile', label: 'New File', icon: 'draft', tab: 'Site', group: 'Files', edits: true, origin: 'FrontPage, Dreamweaver', tip: 'Create a page, style sheet, script or other file',
    run: async (app, arg) => {
      const dir0 = typeof arg?.dir === 'string' ? arg.dir : app.active ? dirOf(app.active.path) : '';
      const r = arg?.name ? { name: arg.name, type: extOf(arg.name), dir: dir0, ext: '' } : await openDialog({
        title: 'New File',
        fields: [
          { key: 'type', label: 'Kind of file', type: 'list', rows: 8, value: 'html', options: NEW_FILE_TYPES.map((t) => ({ value: t.ext, label: t.label + (t.ext ? ` (.${t.ext})` : '') })) },
          { key: 'name', label: 'File name', type: 'text', value: 'untitled', autofocus: true, help: 'The extension is added for you.' },
          { key: 'ext', label: 'Extension', type: 'text', value: '', visibleIf: (v) => !v.type, placeholder: 'htaccess, yml, ts…' },
          { key: 'dir', label: 'Folder', type: 'select', value: dir0, options: [{ value: '', label: '(site root)' }, ...app.site.folders().map((d) => ({ value: d, label: d }))] },
        ],
      });
      if (!r) return;
      const type = NEW_FILE_TYPES.find((t) => t.ext === (r.type ?? 'html')) || NEW_FILE_TYPES[0];
      const ext = type.ext || String(r.ext || '').replace(/^\./, '') || '';
      let name = String(r.name || 'untitled').trim();
      if (ext && extOf(name) !== ext) name = `${name}.${ext}`;
      let path = joinPath(r.dir || '', name);
      if (app.site.has(path)) path = app.site.freeName(r.dir || '', stripExt(name), ext);
      app.site.write(path, type.content(baseName(path), app));
      app.openFile(path);
      await syncDisk(app, [path]);
    } },

  { id: 'site.rename', label: 'Rename', icon: 'drive_file_rename_outline', tab: 'Site', group: 'Files', edits: true, keys: [], origin: 'FrontPage, Dreamweaver', tip: 'Rename a file or folder and fix every link to it',
    isEnabled: hasSite,
    run: async (app, arg) => {
      const from = targetPath(app, typeof arg === 'object' && arg?.from ? arg.from : arg);
      if (!from) return;
      const to = typeof arg === 'object' && arg?.to ? arg.to : await promptDialog('Rename', `New name for ${from}`, baseName(from), { help: 'Links to it in other pages are updated. Type a folder path to move it, for example blog/' + baseName(from) });
      if (to == null || !to.trim()) return;
      const dest = to.includes('/') ? normalizePath(to) : joinPath(dirOf(from), to.trim());
      if (app.site.has(from) && extOf(from) && !extOf(dest) && !(await confirmDialog('Rename', `The new name has no extension (.${extOf(from)}). Rename anyway?`))) return;
      await doRename(app, from, dest);
    } },

  { id: 'site.move', label: 'Move to Folder', icon: 'drive_file_move', tab: 'Site', group: 'Files', edits: true, origin: 'FrontPage, Dreamweaver', isEnabled: hasSite, tip: 'Move a file or folder and fix every link to it',
    run: async (app, arg) => {
      const from = normalizePath(arg?.from || targetPath(app, arg));
      if (!from) return;
      let toDir: string | null = typeof arg?.toDir === 'string' ? arg.toDir : null;
      if (toDir == null) {
        const r = await openDialog({ title: 'Move to Folder', fields: [{ key: 'dir', label: `Move ${from} to`, type: 'list', rows: 10, value: '', options: [{ value: '', label: '(site root)' }, ...app.site.folders().filter((d) => d !== from && !d.startsWith(from + '/')).map((d) => ({ value: d, label: d }))] }] });
        if (!r) return;
        toDir = r.dir || '';
      }
      const dest = joinPath(toDir!, baseName(from));
      if (dest === from) return;
      if (app.site.has(dest)) { toast(`${dest} already exists.`); return; }
      await doRename(app, from, dest);
    } },

  { id: 'site.duplicate', label: 'Duplicate', icon: 'content_copy', tab: 'Site', group: 'Files', edits: true, origin: 'FrontPage', isEnabled: hasActive, tip: 'Make a copy of the file in the same folder',
    run: async (app, arg) => {
      const from = targetPath(app, arg);
      const f = app.site.get(from);
      if (!f) return;
      app.docs.find((d) => d.path === from)?.ui.flush();
      const ext = extOf(from);
      const to = app.site.freeName(dirOf(from), `${stripExt(baseName(from))}_copy`, ext);
      app.site.write(to, f.data ? new Uint8Array(f.data) : f.text ?? '', { mime: f.mime });
      if (app.site.data.templates[from]) app.site.data.templates[to] = app.site.data.templates[from];
      toast(`Copied to ${to}.`, { action: 'Open', onAction: () => app.openFile(to) });
      await syncDisk(app, [to]);
    } },

  { id: 'site.deleteFile', label: 'Delete', icon: 'delete', tab: 'Site', group: 'Files', edits: true, origin: 'FrontPage, Dreamweaver', isEnabled: hasSite, tip: 'Delete a file or folder from the site',
    run: async (app, arg) => {
      const path = targetPath(app, arg);
      if (!path) return;
      const site = app.site;
      const isFolder = !site.has(path);
      const inside = isFolder ? site.list((f) => f.path.startsWith(path + '/')).map((f) => f.path) : [path];
      if (!inside.length && !site.folders().includes(path)) return;
      const idx = linkIndex(site);
      const linking = new Set<string>();
      for (const p of inside) for (const l of idx.in.get(p) || []) if (!inside.includes(l.from)) linking.add(l.from);
      const lines = [isFolder ? `Delete the folder ${path} and the ${inside.length} file${inside.length === 1 ? '' : 's'} in it?` : `Delete ${path}?`];
      if (linking.size) lines.push(`${linking.size} other file${linking.size === 1 ? ' links' : 's link'} to ${isFolder ? 'files in it' : 'it'}: ${[...linking].slice(0, 8).join(', ')}${linking.size > 8 ? '…' : ''}. Those links will be broken.`);
      if (site.folder) lines.push('It is also deleted from the site folder on disk.');
      lines.push('Delete cannot be undone.');
      if (!(await confirmDialog('Delete', lines.join('\n'), 'Delete'))) return;
      site.remove(path);
      if (site.data.home === path) site.data.home = site.homePage;
      await syncDisk(app, [], [path]);
      toast(`Deleted ${path}.`);
    } },

  { id: 'site.exportFile', label: 'Save a Copy of File', icon: 'download', tab: 'Site', group: 'Files', origin: 'FrontPage', isEnabled: hasActive, noRecord: true, tip: 'Save a copy of this site file to your device',
    run: async (app, arg) => {
      const path = targetPath(app, arg);
      const f = app.site.get(path);
      if (!f) return;
      app.docs.find((d) => d.path === path)?.ui.flush();
      await saveAs(new Blob([app.site.bytes(path)! as BlobPart], { type: f.mime }), baseName(path));
    } },

  { id: 'site.setHome', label: 'Set as Home Page', icon: 'home', tab: 'Site', group: 'Files', edits: true, origin: 'FrontPage', isEnabled: hasPage, tip: 'Make this page the site\'s home page',
    run: (app, arg) => {
      const path = targetPath(app, arg);
      if (!isPagePath(path) || !app.site.has(path)) { toast('Choose a page.'); return; }
      const old = app.site.homePage;
      app.site.data.home = path;
      const nav = app.site.data.nav;
      if (nav && nav.path === old) {
        // The new home takes the root of the navigation structure; the old home becomes a top-level page.
        const r = findNav(nav, path);
        if (r?.parent) r.parent.children.splice(r.parent.children.indexOf(r.node), 1, ...r.node.children);
        nav.path = path;
        if (old !== path && !findNav(nav, old) && app.site.has(old)) nav.children.unshift({ path: old, children: [] });
        navChanged(app, true);
      } else app.site.touchMeta();
      toast(`${path} is the home page.`);
    } },

  { id: 'site.togglePublish', label: "Don't Publish", icon: 'cloud_off', tab: 'Site', group: 'Publish', kind: 'toggle', edits: true, origin: 'FrontPage, Expression Web', isEnabled: hasActive,
    tip: 'Leave this file out when publishing', isActive: (app) => !!app.site.get(app.active?.path || '')?.noPublish,
    run: (app, arg) => {
      const f = app.site.get(targetPath(app, arg));
      if (!f) return;
      if (f.noPublish) delete f.noPublish; else f.noPublish = true;
      app.site.touchMeta();
      toast(f.noPublish ? `${f.path} will not be published.` : `${f.path} will be published.`);
    } },

  { id: 'site.fileProperties', label: 'File Properties', icon: 'info', tab: 'Site', group: 'Files', origin: 'FrontPage', isEnabled: hasActive, tip: 'Title, summary, category, review status and more',
    run: async (app, arg) => {
      const path = targetPath(app, arg);
      const f = app.site.get(path);
      if (!f) return;
      const idx = linkIndex(app.site);
      const inbound = new Set((idx.in.get(path) || []).map((l) => l.from));
      const outbound = new Set((idx.out.get(path) || []).map((l) => l.target));
      const ext = (idx.external.get(path) || []).length;
      const p = f.props || {};
      const page = isPagePath(path);
      const info = `<table class="ql-prop-table"><tbody>
        <tr><td>Location</td><td>${esc(path)}</td></tr><tr><td>Type</td><td>${esc(f.mime)}</td></tr>
        <tr><td>Size</td><td>${esc(formatSize(fileSize(app.site, path)))}</td></tr>
        <tr><td>Created</td><td>${esc(new Date(f.created).toLocaleString())}</td></tr><tr><td>Modified</td><td>${esc(new Date(f.modified).toLocaleString())}</td></tr>
        <tr><td>Links to it</td><td>${inbound.size}</td></tr><tr><td>Links in it</td><td>${outbound.size} in the site, ${ext} external</td></tr>
        ${f.checkedOut ? `<tr><td>Checked out by</td><td>${esc(f.checkedOut)}</td></tr>` : ''}</tbody></table>`;
      const cats = new Set<string>();
      for (const x of app.site.list()) for (const c of (x.props?.category || '').split(/\s*[,;]\s*/)) if (c) cats.add(c);
      const people = new Set<string>([author(app), ...app.site.list().map((x) => x.props?.assignedTo || '').filter(Boolean)]);
      const r = await openDialog({
        title: `Properties – ${baseName(path)}`, wide: true,
        fields: [
          { key: 'general', type: 'heading', label: 'General' },
          ...(page ? [{ key: 'title', label: 'Title', type: 'text' as const, value: pageTitle(app.site, path) === baseName(path) ? '' : pageTitle(app.site, path), help: 'Changes the page\'s <title>.' }] : []),
          { key: 'info', type: 'info', html: info },
          { key: 'summaryH', type: 'heading', label: 'Summary' },
          { key: 'summary', label: 'Summary / comments', type: 'textarea', rows: 3, value: p.summary || p.comments || '' },
          { key: 'workgroup', type: 'heading', label: 'Workgroup' },
          { key: 'category', label: 'Categories', type: 'combo', value: p.category || '', options: [...cats], help: 'Separate several with commas.' },
          { key: 'assignedTo', label: 'Assigned to', type: 'combo', value: p.assignedTo || '', options: [...people], half: true },
          { key: 'review', label: 'Review status', type: 'combo', value: p.review || p.reviewStatus || '', options: ['', 'Approved', 'Denied', 'Pending Review', 'Code Review', 'Content Review', 'Legal Review', 'Manager Review'], half: true },
          { key: 'noPublish', label: "Don't publish this file", type: 'checkbox', value: !!f.noPublish },
        ],
      });
      if (!r) return;
      const props: Record<string, string> = { ...p };
      for (const k of ['summary', 'category', 'assignedTo', 'review']) { const v = String(r[k] ?? '').trim(); if (v) props[k] = v; else delete props[k]; }
      delete props.comments; delete props.reviewStatus;
      f.props = Object.keys(props).length ? props : undefined;
      if (r.noPublish) f.noPublish = true; else delete f.noPublish;
      if (page && typeof r.title === 'string' && r.title.trim() && r.title.trim() !== pageTitle(app.site, path)) {
        const tab = app.docs.find((d) => d.path === path);
        const { setTitle } = await import('../model/html');
        if (tab) app.editSource('Page Title', (s) => setTitle(s, r.title.trim()), tab);
        else app.site.write(path, setTitle(app.site.read(path) || '', r.title.trim()));
        regenerateLinkBars(app.site);
      }
      app.site.touchMeta();
    } },

  { id: 'site.locateInSite', label: 'Locate in Site', icon: 'my_location', tab: 'Site', group: 'Files', noRecord: true, origin: 'Dreamweaver', isEnabled: hasActive, tip: 'Show the current file in the Folder List',
    run: (app) => {
      const path = app.active?.path;
      if (!path) return;
      if (!app.ui.paneOpen('folders')) app.ui.openPane('folders');
      // Expand each parent folder in the Folder List, then select the file's row.
      const reveal = (tries: number) => requestAnimationFrame(() => {
        const rows = [...document.querySelectorAll<HTMLElement>('.ql-tree[aria-label="Site files"] .ql-tree-row')];
        if (!rows.length) { if (tries < 10) reveal(tries + 1); return; }
        const dirs: string[] = [];
        for (let d = dirOf(path); d; d = dirOf(d)) dirs.unshift(d);
        for (const d of ['', ...dirs]) {
          const row = rows.find((r) => r.title === (d || app.site.name) && r.querySelector('.ql-tree-caret')?.textContent === 'chevron_right');
          if (row) { row.click(); reveal(tries + 1); return; }
        }
        const target = rows.find((r) => r.title === path);
        if (target) { target.scrollIntoView({ block: 'center' }); target.focus(); target.classList.add('ql-on'); }
        else if (tries < 10) reveal(tries + 1);
      });
      reveal(0);
    } },

  { id: 'site.manageSites', label: 'Manage Sites', icon: 'language', tab: 'Site', group: 'Files', noRecord: true, origin: 'Dreamweaver', tip: 'Open, remove or rename recent sites',
    run: async (app) => {
      const rec = app.prefs.recent.filter((r) => r.format === 'site' || r.format === 'qlsite' || r.format === 'zip' || r.format === 'folder' || !r.format);
      const list = rec.length ? rec : app.prefs.recent;
      const r = await openDialog({
        title: 'Manage Sites', wide: true,
        help: `Open site: ${app.site.name} (${app.site.files.size} files${app.site.folder ? ', saved in a folder' : ''}). Recent sites and pages are listed below.`,
        fields: [
          { key: 'pick', label: 'Recent', type: 'list', rows: 10, value: list[0]?.key, options: list.map((x) => ({ value: x.key, label: `${x.pinned ? '★ ' : ''}${x.name} – ${new Date(x.when).toLocaleDateString()}` })) },
          { key: 'open', type: 'button', label: 'Open', onClick: (v, ctl) => { if (v.pick) { ctl.close({ action: 'open', pick: v.pick }); } } },
          { key: 'remove', type: 'button', label: 'Remove from list', onClick: (v, ctl) => { if (v.pick) ctl.close({ action: 'remove', pick: v.pick }); } },
          { key: 'pin', type: 'button', label: 'Pin / unpin', onClick: (v, ctl) => { if (v.pick) ctl.close({ action: 'pin', pick: v.pick }); } },
          { key: 'newSite', type: 'button', label: 'New site…', onClick: (_v, ctl) => ctl.close({ action: 'new' }) },
          { key: 'openSite', type: 'button', label: 'Open a site folder…', onClick: (_v, ctl) => ctl.close({ action: 'folder' }) },
          { key: 'settings', type: 'button', label: 'Settings of the open site…', onClick: (_v, ctl) => ctl.close({ action: 'settings' }) },
        ],
        ok: false, cancel: 'Close',
      });
      if (!r?.action) return;
      if (r.action === 'open') app.exec('file.openRecent', r.pick);
      else if (r.action === 'remove') { app.prefs.recent = app.prefs.recent.filter((x) => x.key !== r.pick); app.savePrefs(); app.exec('site.manageSites'); }
      else if (r.action === 'pin') { const x = app.prefs.recent.find((y) => y.key === r.pick); if (x) x.pinned = !x.pinned; app.savePrefs(); app.exec('site.manageSites'); }
      else if (r.action === 'new') app.exec('file.newSite');
      else if (r.action === 'folder') app.exec('file.openSite');
      else if (r.action === 'settings') app.exec('site.settings');
    } },
]);

// ------------------------------------------------------------------------------------------
// Check out / check in

def([
  { id: 'site.checkOut', label: 'Check Out', icon: 'lock', tab: 'Site', group: 'Team', edits: true, origin: 'FrontPage, Dreamweaver', isEnabled: hasActive,
    tip: 'Mark the file as being edited by you',
    run: (app, arg) => {
      const f = app.site.get(targetPath(app, arg));
      if (!f) return;
      if (f.checkedOut && f.checkedOut !== author(app)) { toast(`${f.path} is checked out by ${f.checkedOut}.`); return; }
      if (f.checkedOut) { toast(`${f.path} is already checked out to you.`); return; }
      f.checkedOut = author(app);
      checkoutCopies.set(f.path, { text: f.text, data: f.data ? new Uint8Array(f.data) : undefined });
      app.site.touchMeta();
      toast(`${f.path} is checked out to ${f.checkedOut}.`);
    } },
  { id: 'site.checkIn', label: 'Check In', icon: 'lock_open', tab: 'Site', group: 'Team', edits: true, origin: 'FrontPage, Dreamweaver', isEnabled: hasActive, tip: 'Keep your changes and release the file',
    run: async (app, arg) => {
      const f = app.site.get(targetPath(app, arg));
      if (!f) return;
      if (!f.checkedOut) { toast(`${f.path} is not checked out.`); return; }
      if (f.checkedOut !== author(app) && !(await confirmDialog('Check In', `${f.path} is checked out by ${f.checkedOut}. Check it in anyway?`, 'Check In'))) return;
      delete f.checkedOut;
      checkoutCopies.delete(f.path);
      app.site.touchMeta();
      await syncDisk(app, [f.path]);
      toast(`${f.path} is checked in.`);
    } },
  { id: 'site.undoCheckOut', label: 'Undo Check Out', icon: 'undo', tab: 'Site', group: 'Team', edits: true, origin: 'FrontPage, Dreamweaver', isEnabled: hasActive, tip: 'Discard changes since check-out and release the file',
    run: async (app, arg) => {
      const f = app.site.get(targetPath(app, arg));
      if (!f?.checkedOut) { toast('The file is not checked out.'); return; }
      const copy = checkoutCopies.get(f.path);
      const changed = copy && (copy.text !== f.text || (copy.data && f.data && copy.data.length !== f.data.length));
      if (changed) {
        if (!(await confirmDialog('Undo Check Out', `Discard the changes made to ${f.path} since it was checked out?`, 'Discard Changes'))) return;
        app.site.write(f.path, copy!.text ?? copy!.data ?? '');
      } else if (!copy && !(await confirmDialog('Undo Check Out', `The copy from check-out time is not available (it is kept only while the app stays open). Release ${f.path} and keep its current content?`, 'Release'))) return;
      const g = app.site.get(f.path)!;
      delete g.checkedOut;
      checkoutCopies.delete(f.path);
      app.site.touchMeta();
      toast(`${f.path} is no longer checked out.`);
    } },
  { id: 'site.showCheckedOut', label: 'Show Checked Out Files', icon: 'checklist', tab: 'Site', group: 'Team', noRecord: true, origin: 'Dreamweaver',
    run: (app) => app.exec('site.reportCheckedOut') },
]);

// ------------------------------------------------------------------------------------------
// Navigation

async function pickParent(app: App, title: string, path?: string, parent?: string): Promise<{ path: string; parent: string; label: string } | null> {
  const nav = ensureNav(app.site);
  const flat: { value: string; label: string }[] = [];
  const walk = (n: typeof nav, d: number) => { flat.push({ value: n.path, label: `${'  '.repeat(d)}${d ? '└ ' : ''}${navLabel(app.site, n)}` }); n.children.forEach((c) => walk(c, d + 1)); };
  walk(nav, 0);
  const pages = app.site.pages().filter((f) => !/\.(dwt|lbi)$/i.test(f.path) && !findNav(nav, f.path)).map((f) => f.path);
  const r = await openDialog({
    title,
    fields: [
      ...(path ? [] : [{ key: 'path', label: 'Page', type: 'select' as const, value: pages[0], options: pages.map((p) => ({ value: p, label: `${pageTitle(app.site, p)} (${p})` })) }]),
      { key: 'parent', label: 'Place under', type: 'list', rows: 8, value: parent || (findNav(nav, selectedNavPath(app)) ? selectedNavPath(app) : nav.path), options: flat },
      { key: 'label', label: 'Label in link bars (optional)', type: 'text', value: '', placeholder: 'Uses the page title' },
    ],
  });
  if (!r) return null;
  const p = path || r.path;
  if (!p) { toast('Every page is already in the navigation structure.'); return null; }
  return { path: p, parent: r.parent || nav.path, label: String(r.label || '').trim() };
}

def([
  { id: 'site.navigation', label: 'Navigation', icon: 'account_tree', tab: 'Site', group: 'Navigation', kind: 'toggle', noRecord: true, origin: 'FrontPage, Expression Web',
    tip: 'Show the site\'s navigation structure', isActive: (app) => app.ui.paneOpen('navigation'), run: (app) => app.ui.togglePane('navigation') },

  { id: 'site.addToNav', label: 'Add to Navigation', icon: 'playlist_add', tab: 'Site', group: 'Navigation', edits: true, origin: 'FrontPage', isEnabled: hasSite,
    tip: 'Add a page to the navigation structure (used by link bars)',
    run: async (app, arg) => {
      const nav = ensureNav(app.site);
      let path = typeof arg === 'string' ? arg : arg?.pick ? undefined : (arg?.path || app.active?.path);
      if (path && !isPagePath(path)) { toast('Only pages can be in the navigation structure.'); return; }
      if (path && findNav(nav, path)) { toast(`${path} is already in the navigation structure.`); if (!app.ui.paneOpen('navigation')) app.ui.openPane('navigation'); return; }
      let parent = typeof arg === 'object' ? arg?.parent : undefined;
      let label = '';
      if (!parent || !path) {
        const r = await pickParent(app, 'Add to Navigation', path, parent);
        if (!r) return;
        ({ path, parent, label } = r);
      }
      if (navAdd(nav, path!, parent, label || undefined)) { navChanged(app); toast(`${path} added to the navigation structure.`); }
      if (!app.ui.paneOpen('navigation')) app.ui.openPane('navigation');
    } },

  { id: 'site.removeFromNav', label: 'Remove from Navigation', icon: 'playlist_remove', tab: 'Site', group: 'Navigation', edits: true, origin: 'FrontPage', isEnabled: (app) => !!app.site.data.nav,
    run: async (app, arg) => {
      const nav = app.site.data.nav;
      const path = typeof arg === 'string' ? arg : selectedNavPath(app);
      const r = nav && findNav(nav, path);
      if (!r) { toast('The page is not in the navigation structure.'); return; }
      if (!r.parent) { toast('The home page is the root of the navigation structure and cannot be removed.'); return; }
      let withChildren = false;
      if (r.node.children.length) {
        const c = await choiceDialog('Remove from Navigation', `${navLabel(app.site, r.node)} has ${r.node.children.length} page(s) under it.`, ['Move them up a level', 'Remove them too']);
        if (c < 0) return;
        withChildren = c === 1;
      }
      navRemove(nav!, path, withChildren);
      navChanged(app);
    } },

  { id: 'site.navRebuild', label: 'Rebuild Navigation', icon: 'autorenew', tab: 'Site', group: 'Navigation', edits: true, origin: 'FrontPage', isEnabled: hasSite, tip: 'Make a new navigation structure from the folders',
    run: async (app) => {
      if (app.site.data.nav && !(await confirmDialog('Rebuild Navigation', 'Replace the navigation structure with one made from the site\'s folders? Your arrangement and labels are lost.', 'Rebuild'))) return;
      app.site.data.nav = defaultNav(app.site);
      navChanged(app);
      if (!app.ui.paneOpen('navigation')) app.ui.openPane('navigation');
    } },

  { id: 'site.navProperties', label: 'Navigation Properties', icon: 'tune', tab: 'Site', group: 'Navigation', edits: true, origin: 'FrontPage', isEnabled: hasSite, tip: 'Label and place of a page in the navigation structure',
    run: async (app, arg) => {
      const nav = ensureNav(app.site);
      const path = typeof arg === 'string' ? arg : selectedNavPath(app);
      const r = findNav(nav, path);
      if (!r) { toast('Select a page in the Navigation pane first.'); return; }
      const flat: { value: string; label: string }[] = [];
      const walk = (n: typeof nav, d: number) => { if (n === r.node) return; flat.push({ value: n.path, label: `${'  '.repeat(d)}${navLabel(app.site, n)}` }); n.children.forEach((c) => walk(c, d + 1)); };
      walk(nav, 0);
      const bars = app.site.pages().filter((f) => /data-ql-linkbar/i.test(f.text || '')).length;
      const v = await openDialog({
        title: 'Navigation Properties',
        fields: [
          { key: 'label', label: 'Label in link bars', type: 'text', value: r.node.label || '', placeholder: pageTitle(app.site, path), autofocus: true },
          ...(r.parent ? [{ key: 'parent', label: 'Parent page', type: 'select' as const, value: r.parent.path, options: flat }] : []),
          { key: 'info', type: 'info', html: `Page: ${esc(path)}<br>${bars} page${bars === 1 ? ' has' : 's have'} link bars that follow this structure.` },
        ],
      });
      if (!v) return;
      r.node.label = String(v.label || '').trim() || undefined;
      if (r.parent && v.parent && v.parent !== r.parent.path) {
        const { navReparent } = await import('../site/reports');
        navReparent(nav, path, v.parent);
      }
      navChanged(app);
    } },
]);

// ------------------------------------------------------------------------------------------
// Hyperlinks

def([
  { id: 'site.hyperlinks', label: 'Hyperlinks', icon: 'link', tab: 'Site', group: 'Reports', kind: 'toggle', noRecord: true, origin: 'FrontPage, Expression Web',
    tip: 'Links into and out of the current page', isActive: (app) => app.ui.paneOpen('hyperlinks'), run: (app) => app.ui.togglePane('hyperlinks') },

  { id: 'site.recalcHyperlinks', label: 'Recalculate Hyperlinks', icon: 'sync', tab: 'Site', group: 'Reports', edits: true, origin: 'FrontPage, Dreamweaver',
    tip: 'Refresh library items and link bars in every page and rebuild the link list',
    run: async (app) => {
      const site = app.site;
      for (const d of app.docs) d.ui.flush();
      const changed = new Set<string>();
      for (const f of site.pages()) {
        if (!f.text || !/#BeginLibraryItem/i.test(f.text)) continue;
        const out = updateLibraryItems(site, f.path, f.text);
        if (out !== f.text) { site.write(f.path, out); changed.add(f.path); }
      }
      for (const p of regenerateLinkBars(site)) changed.add(p);
      const idx = linkIndex(site);
      let broken = 0, links = 0;
      for (const l of idx.out.values()) for (const x of l) { links++; if (!x.exists) broken++; }
      site.touchMeta();
      await syncDisk(app, [...changed]);
      toast(`Hyperlinks recalculated: ${links} links, ${broken} broken. ${changed.size} page${changed.size === 1 ? '' : 's'} updated (library items and link bars).`, { ms: 6000, ...(broken ? { action: 'Show', onAction: () => app.exec('site.reportBrokenLinks') } : {}) });
    } },

  { id: 'site.changeLinkSitewide', label: 'Change Link Sitewide', icon: 'find_replace', tab: 'Site', group: 'Reports', edits: true, origin: 'Dreamweaver', isEnabled: hasSite,
    tip: 'Change every link to one file or address into a link to another',
    run: async (app, arg) => {
      const site = app.site;
      const idx = linkIndex(site);
      const targets = [...new Set([...idx.in.keys(), ...[...idx.external.values()].flat().map((x) => x.url)])].sort();
      const r = arg?.from && arg?.to ? arg : await openDialog({
        title: 'Change Link Sitewide',
        fields: [
          { key: 'from', label: 'Change all links to', type: 'combo', value: app.active?.path || '', options: targets, help: 'A site file (folder/page.html) or an address (https://…).' },
          { key: 'to', label: 'Into links to', type: 'combo', value: '', options: site.list().map((f) => f.path) },
        ],
        validate: (v) => (!v.from || !v.to ? 'Fill in both boxes.' : null),
      });
      if (!r) return;
      for (const d of app.docs) d.ui.flush();
      const from = String(r.from).trim(), to = String(r.to).trim();
      const external = isExternal(from);
      const toExternal = isExternal(to);
      const fromPath = normalizePath(from.replace(/^\//, ''));
      const toPath = normalizePath(to.replace(/^\//, ''));
      if (!toExternal && !site.has(toPath) && !(await confirmDialog('Change Link Sitewide', `${toPath} is not in the site. Change the links anyway?`))) return;
      let files = 0, count = 0;
      const changed: string[] = [];
      for (const f of site.list()) {
        if (f.text == null || !linkable(f.path)) continue;
        let n = 0;
        let out: string;
        if (external) {
          const re = new RegExp(`(\\s(?:href|src|action)\\s*=\\s*["'])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(["'#?])`, 'gi');
          out = f.text.replace(re, (_m, a, z) => { n++; return a + (toExternal ? to : relativeRef(f.path, toPath)) + z; });
        } else {
          out = rewriteRefs(f.text, f.path, (target) => { if (target !== fromPath) return null; n++; return toExternal ? to : relativeRef(f.path, toPath); });
        }
        if (n && out !== f.text) { site.write(f.path, out); files++; count += n; changed.push(f.path); }
      }
      await syncDisk(app, changed);
      toast(count ? `Changed ${count} link${count === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}.` : `No links to ${from} were found.`);
    } },
]);

// ------------------------------------------------------------------------------------------
// Tasks

def([
  { id: 'site.tasks', label: 'Tasks', icon: 'task_alt', tab: 'Site', group: 'Team', kind: 'toggle', noRecord: true, origin: 'FrontPage, Expression Web',
    tip: 'The site\'s task list', isActive: (app) => app.ui.paneOpen('tasks'),
    run: async (app, arg) => {
      if (arg === 'add' || arg?.action === 'add') { if (!app.ui.paneOpen('tasks')) app.ui.openPane('tasks'); await editTask(app, undefined, arg?.task || {}); return; }
      app.ui.togglePane('tasks');
    } },
]);

// ------------------------------------------------------------------------------------------
// Settings

/** Site data keys used by the settings; every other key in site.data.meta is a site variable. */
export const SITE_SETTING_KEYS = ['baseUrl', 'lang', 'charset', 'author', 'publishExclude', 'publishLog', 'description'];

export function siteVariables(app: App): [string, string][] {
  return Object.entries(app.site.data.meta).filter(([k]) => !SITE_SETTING_KEYS.includes(k) && !k.includes(':') && !k.startsWith('_'));
}

/** Asks for the site's address when it is not set. */
export async function ensureBaseUrl(app: App): Promise<string | null> {
  const cur = app.site.data.meta.baseUrl;
  if (cur) return cur;
  const v = await promptDialog('Site Address', 'Address of the published site', 'https://www.example.com', { help: 'Used for sitemap.xml, feeds and robots.txt. You can change it in Site Settings.' });
  if (!v) return null;
  if (!/^https?:\/\//i.test(v.trim())) { toast('The address starts with https://'); return null; }
  app.site.data.meta.baseUrl = v.trim().replace(/\/+$/, '');
  app.site.touchMeta();
  return app.site.data.meta.baseUrl;
}

def([
  { id: 'site.settings', label: 'Site Settings', icon: 'settings', tab: 'Site', group: 'Settings', edits: true, origin: 'FrontPage, Expression Web, Dreamweaver',
    tip: 'Name, home page, address, language, publishing exclusions and site variables',
    run: async (app) => {
      const site = app.site;
      const m = site.data.meta;
      const vars = siteVariables(app).map(([k, v]) => `${k}=${v}`).join('\n');
      const r = await openDialog({
        title: 'Site Settings', wide: true,
        fields: [
          { key: 'h1', type: 'heading', label: 'General' },
          { key: 'name', label: 'Site name', type: 'text', value: site.name },
          { key: 'home', label: 'Home page', type: 'select', value: site.homePage, options: site.pages().filter((f) => !/\.(dwt|lbi)$/i.test(f.path)).map((f) => f.path), half: true },
          { key: 'baseUrl', label: 'Address of the published site', type: 'text', value: m.baseUrl || '', placeholder: 'https://www.example.com', half: true },
          { key: 'description', label: 'Description', type: 'text', value: m.description || '' },
          { key: 'h2', type: 'heading', label: 'New pages' },
          { key: 'lang', label: 'Default language', type: 'combo', value: m.lang || 'en', options: ['en', 'en-US', 'en-GB', 'es', 'fr', 'de', 'it', 'pt', 'pt-BR', 'nl', 'sv', 'da', 'nb', 'fi', 'pl', 'cs', 'ru', 'uk', 'tr', 'el', 'he', 'ar', 'hi', 'ja', 'ko', 'zh-CN', 'zh-TW'], half: true },
          { key: 'charset', label: 'Character encoding', type: 'select', value: m.charset || 'utf-8', options: ['utf-8', 'windows-1252', 'iso-8859-1', 'iso-8859-15', 'shift_jis', 'euc-jp', 'gb2312', 'big5', 'euc-kr', 'koi8-r', 'windows-1251'], half: true },
          { key: 'author', label: 'Author', type: 'text', value: m.author || app.prefs.author || '' },
          { key: 'h3', type: 'heading', label: 'Publishing' },
          { key: 'publishExclude', label: 'Never publish files matching', type: 'textarea', rows: 3, value: m.publishExclude || '', placeholder: '*.psd\nTemplates/\ndrafts/**', help: 'One pattern per line. * matches within a folder, ** across folders, a trailing / means a whole folder.' },
          { key: 'h4', type: 'heading', label: 'Site variables' },
          { key: 'vars', label: 'Variables (name=value, one per line)', type: 'textarea', rows: 5, value: vars, help: 'Substitution components in pages show these values, for example company=Example Ltd.' },
          { key: 'info', type: 'info', html: `${site.files.size} files, ${site.pages().length} pages. ${site.folder ? 'The site is saved in a folder on this device.' : 'The site is not saved in a folder; use Save Site As to keep it.'}` },
        ],
        validate: (v) => (v.baseUrl && !/^https?:\/\//i.test(v.baseUrl) ? 'The address starts with https:// or http://' : !String(v.name || '').trim() ? 'Give the site a name.' : null),
      });
      if (!r) return;
      site.data.name = String(r.name).trim();
      if (r.home && site.has(r.home) && r.home !== site.homePage) app.exec('site.setHome', r.home);
      const setMeta = (k: string, v: string) => { const x = String(v ?? '').trim(); if (x) m[k] = x; else delete m[k]; };
      setMeta('baseUrl', String(r.baseUrl || '').replace(/\/+$/, ''));
      for (const k of ['description', 'lang', 'charset', 'author', 'publishExclude']) setMeta(k, r[k]);
      for (const [k] of siteVariables(app)) delete m[k];
      for (const line of String(r.vars || '').split('\n')) {
        const i = line.indexOf('=');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (k && !SITE_SETTING_KEYS.includes(k)) m[k] = v;
      }
      site.touchMeta();
      toast('Site settings saved.');
    } },

  { id: 'site.permissions', label: 'Permissions', icon: 'admin_panel_settings', tab: 'Site', group: 'Settings', noRecord: true, origin: 'FrontPage',
    run: () => alertDialog('Permissions', 'Anne\'s Loom edits sites as files and has no server of its own, so there are no site accounts or roles to manage here.\nWho may change the published site is decided by the destination: the FTP or WebDAV account, the GitHub repository\'s collaborators, or the WordPress users.\nCheck-out marks and task assignments are kept with the site data and are not enforced.') },

  { id: 'site.serverInfo', label: 'Server Information', icon: 'dns', tab: 'Site', group: 'Settings', noRecord: true, origin: 'FrontPage',
    run: (app) => {
      const site = app.site;
      const rows: [string, string][] = [
        ['Site', site.name], ['Files', `${site.files.size} (${formatSize(site.list().reduce((s, f) => s + fileSize(site, f.path), 0))})`],
        ['Stored in', site.folder ? (site.folder.kind === 'desktop' ? site.folder.root : `folder "${site.folder.handle?.name || ''}" (browser folder access)`) : app.siteFile ? app.siteFile.name : 'this device\'s drafts only'],
        ['Address', site.data.meta.baseUrl || '(not set)'],
        ['Publishing destinations', site.data.publish.map((p) => `${p.name} (${p.kind})`).join(', ') || 'none'],
        ['Server-side code', 'Not run while editing. Pages with includes can have them expanded when publishing.'],
        ['Network', isDesktop() ? 'Desktop app: FTP/FTPS and link checks without browser restrictions.' : 'Web app: WebDAV and link checks need the server to allow this app (CORS); FTP is not available.'],
      ];
      return alertDialog('Server Information', h('table', { class: 'ql-prop-table' }, h('tbody', null, ...rows.map(([a, b]) => h('tr', null, h('td', null, a), h('td', null, b))))));
    } },
]);

// ------------------------------------------------------------------------------------------
// Generated files

async function writeGenerated(app: App, path: string, text: string, what: string): Promise<void> {
  const exists = app.site.has(path);
  if (exists && app.site.read(path) === text) { toast(`${path} is up to date.`); return; }
  app.site.write(path, text);
  const open = app.docs.find((d) => d.path === path);
  if (open) open.ui.externalChange();
  await syncDisk(app, [path]);
  toast(`${exists ? 'Updated' : 'Created'} ${path} (${what}).`, { action: 'Open', onAction: () => app.openFile(path) });
}

def([
  { id: 'site.sitemapXml', label: 'Sitemap XML', icon: 'lan', tab: 'Site', group: 'Navigation', edits: true, origin: 'Expression Web add-ins, Dreamweaver extensions', isEnabled: hasSite,
    tip: 'Create sitemap.xml for search engines',
    run: async (app) => {
      const base = await ensureBaseUrl(app);
      if (!base) return;
      await writeGenerated(app, 'sitemap.xml', sitemapXml(app.site, base), `${publicPages(app.site).length} pages`);
    } },

  { id: 'site.robotsTxt', label: 'robots.txt', icon: 'smart_toy', tab: 'Site', group: 'Navigation', edits: true, origin: 'Expression Web add-ins', isEnabled: hasSite,
    tip: 'Create robots.txt that points crawlers to the sitemap',
    run: async (app) => {
      const r = await openDialog({
        title: 'robots.txt',
        fields: [
          { key: 'base', label: 'Site address (for the Sitemap line)', type: 'text', value: app.site.data.meta.baseUrl || '', placeholder: 'https://www.example.com' },
          { key: 'dis', label: 'Folders crawlers should skip (one per line)', type: 'textarea', rows: 4, value: robotsTxt(app.site, '').split('\n').filter((l) => l.startsWith('Disallow:')).map((l) => l.slice(10)).join('\n') },
        ],
      });
      if (!r) return;
      if (r.base && /^https?:\/\//i.test(r.base) && !app.site.data.meta.baseUrl) { app.site.data.meta.baseUrl = r.base.replace(/\/+$/, ''); app.site.touchMeta(); }
      const dis = String(r.dis || '').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith('/') ? s : '/' + s));
      await writeGenerated(app, 'robots.txt', robotsTxt(app.site, r.base || '', dis), 'crawler rules');
    } },

  { id: 'site.rssFeed', label: 'RSS Feed', icon: 'rss_feed', tab: 'Site', group: 'Navigation', edits: true, origin: 'Dreamweaver extensions', isEnabled: hasSite,
    tip: 'Create feed.xml from the pages of a folder',
    run: async (app) => {
      const folders = pageFolders(app.site);
      const r = await openDialog({
        title: 'RSS Feed',
        help: 'Each page becomes an item with its title, description (the description meta tag or first paragraph) and date (a date meta tag, a <time> element, or when it was last changed).',
        fields: [
          { key: 'folder', label: 'Pages in folder', type: 'select', value: folders.find((f) => /blog|news|posts|articles/i.test(f)) ?? '', options: folders.map((f) => ({ value: f, label: f || '(whole site)' })) },
          { key: 'title', label: 'Feed title', type: 'text', value: app.site.name },
          { key: 'description', label: 'Feed description', type: 'text', value: app.site.data.meta.description || '' },
          { key: 'base', label: 'Site address', type: 'text', value: app.site.data.meta.baseUrl || '', placeholder: 'https://www.example.com' },
          { key: 'max', label: 'Most items', type: 'number', value: 30, min: 1, max: 500, half: true },
          { key: 'link', label: 'Announce the feed in the home page', type: 'checkbox', value: true },
        ],
        validate: (v) => (!/^https?:\/\//i.test(v.base || '') ? 'Feeds need the site address (https://…).' : null),
      });
      if (!r) return;
      if (!app.site.data.meta.baseUrl) { app.site.data.meta.baseUrl = r.base.replace(/\/+$/, ''); app.site.touchMeta(); }
      const path = joinPath(r.folder || '', 'feed.xml');
      await writeGenerated(app, path, rssFeed(app.site, { baseUrl: r.base, folder: r.folder, title: r.title, description: r.description, max: r.max || 30, lang: app.site.data.meta.lang }), 'RSS 2.0');
      if (r.link) {
        const home = app.site.homePage;
        const href = relativeRef(home, path);
        const tag = `<link rel="alternate" type="application/rss+xml" title="${esc(r.title)}" href="${href}">`;
        const { headInsert } = await import('../model/html');
        const src = app.site.read(home) || '';
        if (!src.includes(`href="${href}"`)) {
          const tab = app.docs.find((d) => d.path === home);
          if (tab) app.editSource('Feed Link', (s) => headInsert(s, tag), tab); else app.site.write(home, headInsert(src, tag));
          await syncDisk(app, [home]);
        }
      }
    } },

  { id: 'site.searchIndex', label: 'Search Index', icon: 'manage_search', tab: 'Site', group: 'Navigation', edits: true, origin: 'FrontPage (search component)', isEnabled: hasSite,
    tip: 'Create search-index.json with the text of every page for a client-side search box',
    run: async (app) => {
      const idx = searchIndex(app.site);
      await writeGenerated(app, 'search-index.json', JSON.stringify(idx, null, 1), `${idx.length} pages; a search box script can fetch it`);
    } },
]);

