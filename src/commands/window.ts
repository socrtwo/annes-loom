/** Window commands: moving between open files, closing groups of them, and a second app window. */
import { def, getCommand, type MenuEntry } from './registry';
import type { App, PageTab } from '../app';
import { toast } from '../ui/dialog';

function step(app: App, by: number): void {
  const docs = app.docs;
  if (docs.length < 2) { toast(docs.length ? 'Only one file is open.' : 'No files are open.'); return; }
  const i = Math.max(0, docs.indexOf(app.active));
  app.activate(docs[(i + by + docs.length) % docs.length]);
  app.focus();
}

/** Closes tabs one by one through File ▸ Close, so each changed file asks to be saved. */
async function closeAll(app: App, keep?: PageTab): Promise<void> {
  for (const d of [...app.docs]) {
    if (d === keep || !app.docs.includes(d)) continue;
    if (d.dirty) app.activate(d);
    await app.exec('file.close', d.id);
    if (app.docs.includes(d)) return; // canceled
  }
  if (keep && app.docs.includes(keep)) app.activate(keep);
}

const tabsNote = 'QuillLoom shows open files as tabs in one window. Use Split view to see a page\'s design and code together, or Window ▸ New Window for a second window.';

def([
  { id: 'window.next', label: 'Next File', icon: 'arrow_forward', tab: 'View', group: 'Window', keys: ['Mod-F6', 'Mod-Alt-PageDown'], noRecord: true, edits: false, origin: 'Expression Web, Dreamweaver', run: (app) => step(app, 1) },
  { id: 'window.previous', label: 'Previous File', icon: 'arrow_back', tab: 'View', group: 'Window', keys: ['Mod-Shift-F6', 'Mod-Alt-PageUp'], noRecord: true, edits: false, origin: 'Expression Web, Dreamweaver', run: (app) => step(app, -1) },
  { id: 'window.closeAll', label: 'Close All', icon: 'tab_close', tab: 'View', group: 'Window', noRecord: true, edits: false, run: (app) => closeAll(app) },
  { id: 'window.closeOthers', label: 'Close Others', icon: 'tab_close_right', tab: 'View', group: 'Window', noRecord: true, edits: false, isEnabled: (app) => app.docs.length > 1, tip: 'Close every file except the current one', run: (app) => closeAll(app, app.active) },
  {
    id: 'window.list', label: 'Open Files', icon: 'tab', tab: 'View', group: 'Window', kind: 'menu', noRecord: true, edits: false,
    tip: 'Switch to any open file',
    run: (app, id?: string) => {
      const d = app.docs.find((x) => x.id === id);
      if (d) { app.activate(d); app.focus(); return; }
      const c = getCommand('window.list');
      if (c) app.ui.openCommandMenu(c, app.ui.anchorFor('window.list'));
    },
    menu: (app): MenuEntry[] => app.docs.length
      ? app.docs.map((d, i) => ({ id: 'window.list', arg: d.id, label: `${i < 9 ? `${i + 1} ` : ''}${d.path}${d.dirty ? ' •' : ''}`, checked: d === app.active }))
      : [{ label: '(no open files)' }],
  },
  {
    id: 'window.newWindow', label: 'New Window', icon: 'open_in_new', tab: 'View', group: 'Window', noRecord: true, edits: false,
    tip: 'Open another QuillLoom window',
    run: () => {
      const url = location.href.split('#')[0];
      const w = window.open(url, '_blank');
      if (!w) { toast('The browser blocked the new window. Allow pop-ups for QuillLoom, or open it in a new tab.'); return; }
      toast('The new window is a separate copy of QuillLoom with its own site; open a site there with File ▸ Open Site. Unsaved changes are not shared between windows.', { ms: 8000 });
    },
  },
  { id: 'window.cascade', label: 'Cascade', icon: 'filter_none', tab: 'View', group: 'Window', noRecord: true, edits: false, origin: 'Dreamweaver', run: () => toast(tabsNote, { ms: 7000 }) },
  {
    id: 'window.tile', label: 'Tile', icon: 'view_column_2', tab: 'View', group: 'Window', noRecord: true, edits: false, origin: 'Dreamweaver',
    tip: 'Shows the current page in Split view (design and code side by side)',
    run: (app) => {
      const t = app.active;
      if (t?.kind === 'page') { if (!app.prefs.splitVertical) { app.prefs.splitVertical = true; app.savePrefs(); } app.setView(t, 'split'); app.ui.applyPrefs(); toast(tabsNote, { ms: 7000 }); }
      else toast(tabsNote, { ms: 7000 });
    },
  },
]);
