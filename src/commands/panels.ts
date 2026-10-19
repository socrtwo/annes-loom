/** Panel commands: show or hide each task pane, close all, reset the layout, and a menu of every panel. */
import { def, getCommand, type Command, type MenuEntry } from './registry';
import type { App } from '../app';
import { toast } from '../ui/dialog';
import { PANES } from '../ui/panes';
import { defaultPrefs } from '../prefs';

/** [pane id, label, icon, heritage] */
export const PANEL_LIST: [string, string, string, string][] = [
  ['folders', 'Folder List', 'folder', 'FrontPage, Expression Web'],
  ['navigation', 'Navigation', 'account_tree', 'FrontPage'],
  ['tagProperties', 'Tag Properties', 'tune', 'Expression Web'],
  ['cssProperties', 'CSS Properties', 'css', 'Expression Web'],
  ['toolbox', 'Toolbox', 'construction', 'Expression Web'],
  ['applyStyles', 'Apply Styles', 'format_paint', 'Expression Web'],
  ['manageStyles', 'Manage Styles', 'style', 'Expression Web'],
  ['behaviors', 'Behaviors', 'bolt', 'Expression Web, Dreamweaver'],
  ['layers', 'Layers', 'layers', 'Expression Web, Dreamweaver'],
  ['snippets', 'Snippets', 'integration_instructions', 'Expression Web, Dreamweaver'],
  ['assets', 'Assets', 'perm_media', 'Dreamweaver'],
  ['find', 'Find and Replace', 'search', 'Expression Web (Find 1 / Find 2)'],
  ['hyperlinks', 'Hyperlinks', 'link', 'FrontPage, Expression Web'],
  ['tasks', 'Tasks', 'task_alt', 'FrontPage'],
  ['reports', 'Reports', 'summarize', 'FrontPage, Expression Web'],
  ['accessibility', 'Accessibility', 'accessibility_new', 'Expression Web'],
  ['compatibility', 'Compatibility', 'devices', 'Expression Web'],
  ['validation', 'HTML Validation', 'fact_check', 'Dreamweaver'],
  ['cssReports', 'CSS Reports', 'analytics', 'Expression Web'],
  ['history', 'History', 'history', 'Dreamweaver'],
  ['outline', 'Outline', 'toc', 'Dreamweaver (DOM panel), BlueGriffon'],
  ['ai', 'AI Assistant', 'auto_awesome', 'Quill suite'],
];

export function togglePanel(app: App, id: string): void {
  if (!PANES[id]) { toast(`The ${PANEL_LIST.find((p) => p[0] === id)?.[1] || id} panel is not available in this build.`); return; }
  app.ui.togglePane(id);
}

function closeAll(app: App): void {
  app.ui.closePane('left');
  app.ui.closePane('right');
}

function resetLayout(app: App): void {
  closeAll(app);
  app.prefs.startPanes = [...defaultPrefs().startPanes];
  app.savePrefs();
  for (const id of app.prefs.startPanes) if (PANES[id]) app.ui.openPane(id);
  toast('Panels reset to the default layout.');
}

const panelMenu = (app: App): MenuEntry[] => [
  ...PANEL_LIST.filter(([id]) => PANES[id]).map(([id, label, ic]) => ({ id: `panel.${id}`, label, icon: ic, checked: app.ui.paneOpen(id) })),
  { separator: true },
  { id: 'panel.closeAll', label: 'Close All Panels', icon: 'close' },
  { id: 'panel.resetLayout', label: 'Reset Panel Layout', icon: 'restart_alt' },
];

const cmds: Command[] = PANEL_LIST.map(([id, label, ic, origin]) => ({
  id: `panel.${id}`, label, icon: ic, tab: 'View', group: 'Panels', kind: 'toggle' as const, noRecord: true, origin,
  keys: id === 'folders' ? ['Alt-F1'] : undefined,
  isActive: (app: App) => app.ui.paneOpen(id),
  run: (app: App) => togglePanel(app, id),
}));

def([
  ...cmds,
  { id: 'panel.closeAll', label: 'Close All Panels', icon: 'close', tab: 'View', group: 'Panels', noRecord: true, origin: 'Expression Web', run: (app) => closeAll(app) },
  { id: 'panel.resetLayout', label: 'Reset Panel Layout', icon: 'restart_alt', tab: 'View', group: 'Panels', noRecord: true, origin: 'Expression Web (Reset Workspace Layout)', run: (app) => resetLayout(app) },
  {
    id: 'panel.menu', label: 'Panels', icon: 'view_sidebar', tab: 'View', group: 'Panels', kind: 'menu', noRecord: true, origin: 'Expression Web (Panels menu)',
    menu: panelMenu,
    run: (app, arg) => { if (typeof arg === 'string') togglePanel(app, arg); else app.ui.openCommandMenu(getCommand('panel.menu')!, app.ui.anchorFor('panel.menu')); },
  },
]);
