/**
 * Task panes (panels). Site panels open on the left, properties and tools on the right; on phones they
 * appear as bottom sheets. Command modules register their own panes with registerPane(); the Folder
 * List is defined here because every other part of the app relies on it.
 */
import type { App } from '../app';
import { h, icon, clear } from './dom';
import { showMenu } from './dialog';
import { baseName, dirOf, isImagePath, isPagePath, extOf } from '../model/paths';

export interface PaneDef {
  id: string;
  title: string;
  side?: 'left' | 'right';
  render: (app: App, el: HTMLElement, opts: any) => void;
  update?: (app: App, el: HTMLElement, opts: any) => void;
  onOpen?: (app: App, el: HTMLElement, opts: any) => void;
  onClose?: (app: App) => void;
}

export const PANES: Record<string, PaneDef> = {};

export function registerPane(def: PaneDef): void { PANES[def.id] = def; }

/** True while the user is typing in a field of the pane (redrawing would destroy the field). */
export const typingIn = (el: HTMLElement) => { const a = document.activeElement as HTMLElement | null; return !!a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); };

export const sigOf = (el: HTMLElement, sig: string) => { if (el.dataset.sig === sig) return false; el.dataset.sig = sig; return true; };

export function fileIcon(path: string): string {
  if (/\.dwt$/i.test(path)) return 'dashboard';
  if (/\.lbi$/i.test(path)) return 'library_books';
  if (isPagePath(path)) return extOf(path) === 'php' ? 'php' : 'html';
  if (isImagePath(path)) return 'image';
  const e = extOf(path);
  return ({ css: 'css', scss: 'css', less: 'css', js: 'javascript', mjs: 'javascript', json: 'data_object', xml: 'code', svg: 'image', txt: 'description', md: 'markdown', pdf: 'picture_as_pdf', zip: 'folder_zip', mp4: 'movie', webm: 'movie', mp3: 'audio_file', woff: 'font_download', woff2: 'font_download', ttf: 'font_download', otf: 'font_download' } as Record<string, string>)[e] || 'draft';
}

const expanded = new Set<string>(['']);

registerPane({
  id: 'folders', title: 'Folder List', side: 'left',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    const site = app.site;
    const sig = `${site.version}:${app.active?.path}:${[...expanded].join('|')}`;
    if (!sigOf(el, sig) || typingIn(el)) return;
    const scroll = el.scrollTop;
    clear(el);
    el.appendChild(h('div', { class: 'ql-row ql-pane-tools' },
      h('button', { class: 'ql-iconbtn ql-sm', title: 'New page', 'aria-label': 'New page', onclick: () => app.exec('file.newPage') }, icon('note_add')),
      h('button', { class: 'ql-iconbtn ql-sm', title: 'New folder', 'aria-label': 'New folder', onclick: () => app.exec('site.newFolder') }, icon('create_new_folder')),
      h('button', { class: 'ql-iconbtn ql-sm', title: 'Import files', 'aria-label': 'Import files', onclick: () => app.exec('file.importFiles') }, icon('upload_file')),
      h('button', { class: 'ql-iconbtn ql-sm', title: 'Open site folder', 'aria-label': 'Open site', onclick: () => app.exec('file.openSite') }, icon('folder_open')),
      h('button', { class: 'ql-iconbtn ql-sm', title: 'Publish', 'aria-label': 'Publish', onclick: () => app.exec('site.publish') }, icon('cloud_upload'))));
    const tree = h('div', { class: 'ql-tree', role: 'tree', 'aria-label': 'Site files' });
    el.appendChild(tree);
    const home = site.homePage;
    const row = (path: string, depth: number, isDir: boolean) => {
      const name = path ? baseName(path) : site.name;
      const open = expanded.has(path);
      const f = site.get(path);
      const b = h('div', { class: 'ql-tree-row' + (app.active?.path === path ? ' ql-on' : '') + (f?.noPublish ? ' ql-dim' : ''), role: 'treeitem', tabindex: '0', style: `padding-left:${6 + depth * 14}px`, draggable: path ? 'true' : null, title: path || site.name },
        isDir ? icon(open ? 'expand_more' : 'chevron_right', 'ql-tree-caret') : h('span', { class: 'ql-tree-caret' }),
        icon(isDir ? (path ? (open ? 'folder_open' : 'folder') : 'language') : path === home ? 'home' : fileIcon(path)),
        h('span', { class: 'ql-tree-name' }, name),
        f?.checkedOut ? icon('check', 'ql-tree-badge') : null);
      b.addEventListener('click', () => { if (isDir) { if (open) expanded.delete(path); else expanded.add(path); el.dataset.sig = ''; this.update!(app, el, {}); } });
      b.addEventListener('dblclick', () => { if (!isDir) app.openFile(path); });
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (isDir) b.click(); else app.openFile(path); } if (e.key === 'F2' && path) app.exec('site.rename', path); if (e.key === 'Delete' && path) app.exec('site.deleteFile', path); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); fileMenu(app, path, isDir, e.clientX, e.clientY); });
      b.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('text/x-ql-path', path); e.dataTransfer!.setData('text/plain', path); });
      if (isDir) {
        b.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/x-ql-path') || e.dataTransfer?.types.includes('Files')) { e.preventDefault(); b.classList.add('ql-drop'); } });
        b.addEventListener('dragleave', () => b.classList.remove('ql-drop'));
        b.addEventListener('drop', (e) => {
          e.preventDefault(); b.classList.remove('ql-drop');
          const from = e.dataTransfer!.getData('text/x-ql-path');
          if (from) { if (from !== path && dirOf(from) !== path && !path.startsWith(from + '/')) app.exec('site.move', { from, toDir: path }); return; }
          const files = [...(e.dataTransfer?.files || [])];
          if (files.length) app.exec('file.importFiles', { files, dir: path });
        });
      }
      tree.appendChild(b);
    };
    const walk = (dir: string, depth: number) => {
      const dirs = site.folders().filter((d) => dirOf(d) === dir && d !== dir);
      const files = site.list((f) => dirOf(f.path) === dir);
      for (const d of dirs) { row(d, depth, true); if (expanded.has(d)) walk(d, depth + 1); }
      for (const f of files) row(f.path, depth, false);
    };
    row('', 0, true);
    if (expanded.has('')) walk('', 1);
    el.scrollTop = scroll;
  },
});

export function fileMenu(app: App, path: string, isDir: boolean, x: number, y: number): void {
  const f = app.site.get(path);
  showMenu(isDir ? [
    { id: 'file.newPage', arg: { dir: path }, label: 'New Page', icon: 'note_add' },
    { id: 'site.newFile', arg: { dir: path }, label: 'New File…', icon: 'draft' },
    { id: 'site.newFolder', arg: { dir: path }, label: 'New Folder…', icon: 'create_new_folder' },
    { id: 'file.importFiles', arg: { dir: path }, label: 'Import Files…', icon: 'upload_file' },
    ...(path ? [{ separator: true }, { id: 'site.rename', arg: path, label: 'Rename…', icon: 'edit' }, { id: 'site.deleteFile', arg: path, label: 'Delete', icon: 'delete' }] : []),
    { separator: true }, { id: 'site.publish', label: 'Publish…', icon: 'cloud_upload' }, { id: 'site.settings', label: 'Site Settings…', icon: 'settings' },
  ] : [
    { id: 'site.openFile', arg: path, label: 'Open', icon: 'open_in_new' },
    ...(isPagePath(path) ? [{ id: 'site.openFile', arg: { path, view: 'code' }, label: 'Open in Code View', icon: 'code' }, { id: 'site.openFile', arg: { path, view: 'preview' }, label: 'Preview', icon: 'visibility' }, { id: 'file.previewBrowser', arg: path, label: 'Preview in Browser', icon: 'travel_explore' }] : []),
    { separator: true },
    { id: 'site.rename', arg: path, label: 'Rename…', icon: 'edit' },
    { id: 'site.duplicate', arg: path, label: 'Duplicate', icon: 'content_copy' },
    { id: 'site.deleteFile', arg: path, label: 'Delete', icon: 'delete' },
    { id: 'site.exportFile', arg: path, label: 'Save a Copy…', icon: 'download' },
    { separator: true },
    ...(isPagePath(path) ? [{ id: 'site.setHome', arg: path, label: 'Set as Home Page', icon: 'home' }, { id: 'site.addToNav', arg: path, label: 'Add to Navigation', icon: 'account_tree' }] : []),
    ...(/\.dwt$/i.test(path) ? [{ id: 'file.newFromDwt', arg: path, label: 'New Page from Template', icon: 'dashboard' }, { id: 'template.updateAll', arg: path, label: 'Update Attached Pages', icon: 'sync' }] : []),
    { id: f?.checkedOut ? 'site.checkIn' : 'site.checkOut', arg: path, label: f?.checkedOut ? 'Check In' : 'Check Out', icon: f?.checkedOut ? 'lock_open' : 'lock' },
    { id: 'site.togglePublish', arg: path, label: f?.noPublish ? 'Publish This File' : "Don't Publish", icon: f?.noPublish ? 'cloud_done' : 'cloud_off', checked: !!f?.noPublish },
    { id: 'site.publishFile', arg: path, label: 'Publish Selected File', icon: 'cloud_upload' },
    { id: 'site.fileProperties', arg: path, label: 'Properties…', icon: 'info' },
  ], { x, y, onPick: (e) => e.id && app.exec(e.id, e.arg) });
}
