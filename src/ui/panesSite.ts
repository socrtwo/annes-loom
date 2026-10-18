/**
 * Site panes: Navigation (the site's navigation structure, left), Hyperlinks (links into and out of the
 * current page, right), Tasks (right) and Reports (site reports in a sortable table, right).
 */
import type { App } from '../app';
import { h, icon, clear, download } from './dom';
import { registerPane, sigOf, typingIn, fileIcon } from './panes';
import { openDialog, toast, confirmDialog } from './dialog';
import { defaultNav, findNav, newId, pageTitle, type NavNode, type SiteTask } from '../model/site';
import { baseName, isPagePath } from '../model/paths';
import {
  REPORTS, runReport, reportCsv, linkIndex, formatSize, ensureNav, navAdd, navRemove, navMove, navIndent, navOutdent, navReparent, navLabel,
  regenerateLinkBars, type Report, type ReportOptions, type ReportColumn,
} from '../site/reports';

// ------------------------------------------------------------------------------------------
// Shared helpers

/** Results of external link checks this session: URL -> status. */
export const linkStatus = new Map<string, string>();
let linkStatusVersion = 0;
export function setLinkStatus(url: string, status: string): void { linkStatus.set(url, status); linkStatusVersion++; }

/** Opens a site file; with a line, shows the code (Split view for pages in Design view) and moves there. */
export function openAt(app: App, path: string, line?: number): void {
  if (!app.site.has(path)) { toast(`${path} is not in the site.`); return; }
  const existing = app.docs.find((d) => d.path === path);
  const view = line && isPagePath(path) ? ((existing?.view ?? app.prefs.defaultView) === 'code' || (existing?.view ?? app.prefs.defaultView) === 'split' ? undefined : 'split') : undefined;
  const tab = app.openFile(path, view ? { view } : {});
  if (line) requestAnimationFrame(() => requestAnimationFrame(() => { try { tab.ui.code?.goToLine(line); } catch { /* no code view */ } }));
}

/** After a navigation structure change: mark the site changed and refresh link bars in pages. */
export function navChanged(app: App, quiet = false): string[] {
  app.site.touchMeta();
  const changed = regenerateLinkBars(app.site);
  if (changed.length && !quiet) toast(`Updated link bars in ${changed.length} page${changed.length === 1 ? '' : 's'}.`);
  return changed;
}

const fmtDate = (t: any) => (typeof t === 'number' && t > 0 ? new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '');

// ------------------------------------------------------------------------------------------
// Reports pane

export const reportView: { id: string; opts: ReportOptions; sortKey: string; sortDir: 1 | -1; filterPath?: string } = { id: 'summary', opts: {}, sortKey: '', sortDir: 1 };

/** Opens the Reports pane on a report. */
export function showReport(app: App, id: string, opts: ReportOptions = {}, filterPath?: string): void {
  reportView.id = id;
  reportView.opts = { ...reportView.opts, ...opts };
  reportView.sortKey = '';
  reportView.filterPath = filterPath;
  app.ui.openPane('reports', { report: id });
}

function cellText(c: ReportColumn, v: any): string {
  if (v == null || v === '') return '';
  if (c.kind === 'size') return typeof v === 'number' ? formatSize(v) : String(v);
  if (c.kind === 'date') return fmtDate(v);
  return String(v);
}

function renderReportTable(app: App, r: Report, el: HTMLElement, redraw: () => void): void {
  let rows = r.rows;
  if (reportView.filterPath) rows = rows.filter((x) => x.path === reportView.filterPath);
  const k = reportView.sortKey;
  if (k) {
    const col = r.columns.find((c) => c.key === k);
    const num = col && (col.kind === 'number' || col.kind === 'size' || col.kind === 'date');
    rows = [...rows].sort((a, b) => {
      const x = a[k], y = b[k];
      const d = num ? (+x || 0) - (+y || 0) : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
      return d * reportView.sortDir;
    });
  }
  el.appendChild(h('div', { class: 'ql-help', 'aria-live': 'polite' }, `${rows.length} item${rows.length === 1 ? '' : 's'}${reportView.filterPath ? ` in ${reportView.filterPath}` : ''}`,
    reportView.filterPath ? h('button', { class: 'ql-btn ql-sm', style: 'margin-left:6px', onclick: () => { reportView.filterPath = undefined; redraw(); } }, 'Show all pages') : null));
  if (r.note) el.appendChild(h('p', { class: 'ql-help' }, r.note));
  const table = h('table', { class: 'ql-report-table' });
  const head = h('tr', null, ...r.columns.map((c) => h('th', {
    scope: 'col', tabindex: '0', 'aria-sort': k === c.key ? (reportView.sortDir > 0 ? 'ascending' : 'descending') : 'none',
    onclick: () => { if (reportView.sortKey === c.key) reportView.sortDir = (reportView.sortDir * -1) as 1 | -1; else { reportView.sortKey = c.key; reportView.sortDir = 1; } redraw(); },
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.target as HTMLElement).click(); } },
  }, c.label, k === c.key ? (reportView.sortDir > 0 ? ' ▲' : ' ▼') : '')));
  table.appendChild(h('thead', null, head));
  const body = h('tbody');
  const MAX = 2000;
  for (const row of rows.slice(0, MAX)) {
    const go = () => {
      if (row.report) { showReport(app, row.report); return; }
      if (row.path && app.site.has(row.path)) openAt(app, row.path, row.line);
    };
    const tr = h('tr', { tabindex: '0', class: row.severity ? `ql-sev-${row.severity}` : '', style: row.path || row.report ? 'cursor:pointer' : '', onclick: go, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') go(); } },
      ...r.columns.map((c) => h('td', { title: c.kind === 'path' ? row.path : undefined }, cellText(c, row[c.key]))));
    body.appendChild(tr);
  }
  table.appendChild(body);
  el.appendChild(table);
  if (rows.length > MAX) el.appendChild(h('p', { class: 'ql-help' }, `Showing the first ${MAX} items. Save the report to see all of them.`));
}

registerPane({
  id: 'reports', title: 'Site Reports', side: 'right',
  render(app, el, opts) { if (opts?.report) reportView.id = opts.report; el.dataset.sig = ''; this.update!(app, el, opts); },
  onOpen(app, el, opts) { if (opts?.report && opts.report !== reportView.id) { reportView.id = opts.report; } el.dataset.sig = ''; this.update!(app, el, opts); },
  update(app, el) {
    const sig = `${app.site.version}:${reportView.id}:${reportView.sortKey}:${reportView.sortDir}:${JSON.stringify(reportView.opts)}:${linkStatusVersion}:${reportView.filterPath || ''}`;
    if (!sigOf(el, sig) || typingIn(el)) return;
    const scroll = el.scrollTop;
    clear(el);
    const redraw = () => { el.dataset.sig = ''; this.update!(app, el, {}); };
    let report: Report;
    try { report = runReport(app.site, reportView.id, { ...reportView.opts, externalStatus: linkStatus }); }
    catch (e: any) { el.appendChild(h('p', { class: 'ql-help' }, `This report could not be made: ${e?.message || e}`)); return; }
    const chooser = h('select', { 'aria-label': 'Report', onchange: (e: Event) => { reportView.id = (e.target as HTMLSelectElement).value; reportView.sortKey = ''; redraw(); } },
      ...REPORTS.map((x) => h('option', { value: x.id, selected: x.id === reportView.id }, x.label))) as HTMLSelectElement;
    const def = REPORTS.find((x) => x.id === reportView.id);
    el.appendChild(h('div', { class: 'ql-row ql-pane-tools' }, chooser,
      def?.ask ? h('button', { class: 'ql-iconbtn ql-sm', title: 'Report settings', 'aria-label': 'Report settings', onclick: () => app.exec(def.cmd, { ask: true }) }, icon('tune')) : null,
      ['brokenLinks', 'externalLinks'].includes(reportView.id) ? h('button', { class: 'ql-iconbtn ql-sm', title: 'Verify external links', 'aria-label': 'Verify external links', onclick: () => app.exec('site.checkLinks', { external: true }) }, icon('travel_explore')) : null,
      h('button', { class: 'ql-iconbtn ql-sm', title: 'Refresh', 'aria-label': 'Refresh', onclick: redraw }, icon('refresh')),
      h('button', { class: 'ql-iconbtn ql-sm', title: 'Save report as CSV', 'aria-label': 'Save report as CSV', onclick: () => download(new Blob([reportCsv(report)], { type: 'text/csv' }), `${report.id}-report.csv`) }, icon('download'))));
    el.appendChild(h('h3', { style: 'margin:6px 0 2px;font-size:14px' }, report.title));
    renderReportTable(app, report, el, redraw);
    el.scrollTop = scroll;
  },
});

// ------------------------------------------------------------------------------------------
// Navigation pane

let navSel = '';

export function selectedNavPath(app: App): string { return navSel && app.site.data.nav && findNav(app.site.data.nav, navSel) ? navSel : app.active?.path || ''; }

function navOp(app: App, fn: (nav: NavNode) => boolean, failMsg?: string): void {
  const nav = ensureNav(app.site);
  if (fn(nav)) navChanged(app); else if (failMsg) toast(failMsg);
}

registerPane({
  id: 'navigation', title: 'Navigation', side: 'left',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    const site = app.site;
    const sig = `${site.version}:${navSel}:${app.active?.path}`;
    if (!sigOf(el, sig) || typingIn(el)) return;
    const scroll = el.scrollTop;
    clear(el);
    const saved = !!site.data.nav;
    const nav = site.data.nav || defaultNav(site);
    const sel = navSel;
    const tool = (ic: string, title: string, fn: () => void, disabled = false) => h('button', { class: 'ql-iconbtn ql-sm', title, 'aria-label': title, disabled, onclick: fn }, icon(ic));
    const inTree = !!(sel && findNav(nav, sel));
    el.appendChild(h('div', { class: 'ql-row ql-pane-tools' },
      tool('add', 'Add a page…', () => app.exec('site.addToNav', { pick: true, parent: inTree ? sel : undefined })),
      tool('playlist_add', 'Add the current page', () => app.active && app.exec('site.addToNav', { path: app.active.path, parent: inTree && sel !== app.active.path ? sel : undefined }), !app.active || !isPagePath(app.active.path)),
      tool('remove', 'Remove from navigation', () => app.exec('site.removeFromNav', sel), !inTree || sel === nav.path),
      tool('arrow_upward', 'Move up', () => navOp(app, (n) => navMove(n, sel, -1)), !inTree),
      tool('arrow_downward', 'Move down', () => navOp(app, (n) => navMove(n, sel, 1)), !inTree),
      tool('format_indent_increase', 'Make a child of the page above', () => navOp(app, (n) => navIndent(n, sel), 'There is no page above at this level.'), !inTree),
      tool('format_indent_decrease', 'Move up one level', () => navOp(app, (n) => navOutdent(n, sel), 'The page is already at the top level.'), !inTree),
      tool('edit', 'Rename label…', () => app.exec('site.navProperties', sel), !inTree),
      tool('autorenew', 'Rebuild from folders…', () => app.exec('site.navRebuild'))));
    if (!saved) el.appendChild(h('p', { class: 'ql-help' }, 'Suggested from the site\'s folders. It is kept as the navigation structure when you change it. ', h('button', { class: 'ql-btn ql-sm', onclick: () => { ensureNav(site); navChanged(app); } }, 'Use this structure')));
    const tree = h('div', { class: 'ql-nav-tree', role: 'tree', 'aria-label': 'Navigation structure' });
    const node = (n: NavNode, depth: number): HTMLElement => {
      const row = h('div', {
        role: 'treeitem', tabindex: '0', draggable: depth > 0 ? 'true' : null, 'aria-selected': n.path === sel ? 'true' : 'false',
        class: 'ql-tree-row' + (n.path === sel ? ' ql-on' : ''), title: n.path + (site.has(n.path) ? '' : ' (missing)'),
      }, icon(depth === 0 ? 'home' : fileIcon(n.path)), h('span', { class: 'ql-tree-name', style: site.has(n.path) ? '' : 'text-decoration:line-through' }, navLabel(site, n)),
        n.label ? h('span', { class: 'ql-help', style: 'margin-left:4px' }, baseName(n.path)) : null);
      row.addEventListener('click', () => { navSel = n.path; el.dataset.sig = ''; this.update!(app, el, {}); });
      row.addEventListener('dblclick', () => { if (site.has(n.path)) app.openFile(n.path); });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && site.has(n.path)) app.openFile(n.path);
        else if (e.key === 'Delete' && depth > 0) app.exec('site.removeFromNav', n.path);
        else if (e.key === 'F2') app.exec('site.navProperties', n.path);
        else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); navSel = n.path; navOp(app, (x) => navMove(x, n.path, e.key === 'ArrowUp' ? -1 : 1)); }
        else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navSel = n.path; navOp(app, (x) => navIndent(x, n.path)); }
        else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navSel = n.path; navOp(app, (x) => navOutdent(x, n.path)); }
      });
      row.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('text/x-ql-nav', n.path); e.dataTransfer!.setData('text/plain', n.path); });
      row.addEventListener('dragover', (e) => { const t = e.dataTransfer?.types || []; if (t.includes('text/x-ql-nav') || t.includes('text/x-ql-path')) { e.preventDefault(); row.classList.add('ql-drop'); } });
      row.addEventListener('dragleave', () => row.classList.remove('ql-drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault(); row.classList.remove('ql-drop');
        const moving = e.dataTransfer!.getData('text/x-ql-nav');
        if (moving) { if (moving !== n.path) navOp(app, (x) => navReparent(x, moving, n.path), 'A page cannot move under itself.'); return; }
        const file = e.dataTransfer!.getData('text/x-ql-path');
        if (file && isPagePath(file)) navOp(app, (x) => navAdd(x, file, n.path), `${file} is already in the navigation structure.`);
      });
      const li = h('li', null, row);
      if (n.children.length) li.appendChild(h('ul', { role: 'group' }, ...n.children.map((c) => node(c, depth + 1))));
      return li;
    };
    tree.appendChild(h('ul', { style: 'padding-left:0' }, node(nav, 0)));
    el.appendChild(tree);
    el.appendChild(h('p', { class: 'ql-help' }, 'Drag pages onto each other to rearrange them, or drag pages here from the Folder List. Link bars (nav elements with a data-ql-linkbar attribute) are rebuilt from this structure.'));
    el.scrollTop = scroll;
  },
});

// ------------------------------------------------------------------------------------------
// Hyperlinks pane

registerPane({
  id: 'hyperlinks', title: 'Hyperlinks', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    const path = app.active?.path || '';
    const sig = `${app.site.version}:${path}:${linkStatusVersion}`;
    if (!sigOf(el, sig) || typingIn(el)) return;
    clear(el);
    if (!path) { el.appendChild(h('p', { class: 'ql-help' }, 'Open a page to see its hyperlinks.')); return; }
    const idx = linkIndex(app.site);
    const inbound = idx.in.get(path) || [];
    const out = idx.out.get(path) || [];
    const ext = idx.external.get(path) || [];
    el.appendChild(h('div', { class: 'ql-row ql-pane-tools' },
      h('button', { class: 'ql-btn ql-sm', onclick: () => app.exec('site.checkLinksPage') }, icon('travel_explore'), 'Check this page'),
      h('button', { class: 'ql-btn ql-sm', onclick: () => app.exec('site.recalcHyperlinks') }, icon('sync'), 'Recalculate')));
    el.appendChild(h('h3', { style: 'margin:6px 0;font-size:14px;display:flex;gap:4px;align-items:center' }, icon(fileIcon(path)), isPagePath(path) ? pageTitle(app.site, path) : baseName(path)));
    el.appendChild(h('div', { class: 'ql-help' }, path));
    const section = (title: string, rows: HTMLElement[]) => {
      el.appendChild(h('h4', { style: 'margin:10px 0 2px;font-size:13px' }, `${title} (${rows.length})`));
      if (!rows.length) { el.appendChild(h('div', { class: 'ql-help' }, 'None')); return; }
      const t = h('table', { class: 'ql-report-table' }, h('tbody', null, ...rows));
      el.appendChild(t);
    };
    const tr = (cells: (string | HTMLElement)[], onclick: () => void, cls = '', title = '') => h('tr', { tabindex: '0', class: cls, title, style: 'cursor:pointer', onclick, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') onclick(); } }, ...cells.map((c) => h('td', null, c)));
    const byFrom = new Map<string, { line: number; n: number }>();
    for (const l of inbound) { const x = byFrom.get(l.from); if (x) x.n++; else byFrom.set(l.from, { line: l.line, n: 1 }); }
    section('Pages and files linking here', [...byFrom].map(([from, x]) => tr([icon('arrow_forward'), from, x.n > 1 ? `${x.n} links` : `line ${x.line}`], () => openAt(app, from, x.line), '', 'Open the linking file at the link')));
    const seen = new Set<string>();
    section('Links in this file', out.filter((l) => { const k = l.target; if (seen.has(k)) return false; seen.add(k); return true; }).map((l) =>
      tr([icon(l.exists ? 'link' : 'link_off'), l.ref, l.exists ? 'OK' : 'Broken'], () => (l.exists ? app.openFile(l.target) : openAt(app, path, l.line)), l.exists ? '' : 'ql-sev-error', l.exists ? `Open ${l.target}` : `Go to line ${l.line}`)));
    section('External links', ext.map((l) => tr([icon('public'), l.url, linkStatus.get(l.url) || 'Not checked'], () => openAt(app, path, l.line), /^(ok|2|3)/i.test(linkStatus.get(l.url) || 'ok') ? '' : 'ql-sev-error', `Go to line ${l.line}`)));
  },
});

// ------------------------------------------------------------------------------------------
// Tasks pane

let taskSort: 'priority' | 'status' | 'name' | 'file' | 'created' = 'priority';
let showCompleted = true;
const PRI: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
const STATUS: Record<string, number> = { 'Not Started': 0, 'In Progress': 1, Completed: 2 };

export function sortTasks(tasks: SiteTask[], by: typeof taskSort): SiteTask[] {
  const c = (a: SiteTask, b: SiteTask) => {
    switch (by) {
      case 'priority': return PRI[a.priority] - PRI[b.priority] || STATUS[a.status] - STATUS[b.status];
      case 'status': return STATUS[a.status] - STATUS[b.status] || PRI[a.priority] - PRI[b.priority];
      case 'file': return (a.file || '~').localeCompare(b.file || '~');
      case 'created': return b.created - a.created;
      default: return a.name.localeCompare(b.name);
    }
  };
  return [...tasks].sort(c);
}

/** Add (no task) or edit a task. */
export async function editTask(app: App, task?: SiteTask, defaults: Partial<SiteTask> = {}): Promise<SiteTask | null> {
  const t = task || { id: newId('task'), name: '', priority: 'Medium', assignedTo: app.prefs.author, status: 'Not Started', description: '', created: Date.now(), file: app.active?.path, ...defaults } as SiteTask;
  const files = app.site.list().map((f) => f.path);
  const r = await openDialog({
    title: task ? 'Edit Task' : 'New Task',
    fields: [
      { key: 'name', label: 'Task name', type: 'text', value: t.name, autofocus: true },
      { key: 'priority', label: 'Priority', type: 'radio', value: t.priority, options: ['High', 'Medium', 'Low'], half: true },
      { key: 'status', label: 'Status', type: 'select', value: t.status, options: ['Not Started', 'In Progress', 'Completed'], half: true },
      { key: 'assignedTo', label: 'Assigned to', type: 'text', value: t.assignedTo },
      { key: 'file', label: 'Associated file', type: 'select', value: t.file || '', options: [{ value: '', label: '(none)' }, ...files.map((p) => ({ value: p, label: p }))] },
      { key: 'description', label: 'Description', type: 'textarea', value: t.description, rows: 4 },
      { key: 'info', type: 'info', html: `Created ${new Date(t.created).toLocaleString()}` },
    ],
    validate: (v) => (String(v.name || '').trim() ? null : 'Give the task a name.'),
  });
  if (!r) return null;
  Object.assign(t, { name: String(r.name).trim(), priority: r.priority || 'Medium', status: r.status, assignedTo: r.assignedTo, file: r.file || undefined, description: r.description });
  if (!task) app.site.data.tasks.push(t);
  app.site.touchMeta();
  return t;
}

registerPane({
  id: 'tasks', title: 'Tasks', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    const site = app.site;
    const sig = `${site.version}:${taskSort}:${showCompleted}`;
    if (!sigOf(el, sig) || typingIn(el)) return;
    clear(el);
    const redraw = () => { el.dataset.sig = ''; this.update!(app, el, {}); };
    el.appendChild(h('div', { class: 'ql-row ql-pane-tools' },
      h('button', { class: 'ql-btn ql-sm', onclick: async () => { if (await editTask(app)) redraw(); } }, icon('add_task'), 'New task'),
      h('label', { class: 'ql-help', style: 'display:flex;align-items:center;gap:4px' }, 'Sort', h('select', { onchange: (e: Event) => { taskSort = (e.target as HTMLSelectElement).value as any; redraw(); } },
        ...[['priority', 'Priority'], ['status', 'Status'], ['name', 'Name'], ['file', 'File'], ['created', 'Newest']].map(([v, l]) => h('option', { value: v, selected: v === taskSort }, l)))),
      h('label', { class: 'ql-help', style: 'display:flex;align-items:center;gap:4px' }, h('input', { type: 'checkbox', checked: showCompleted, onchange: (e: Event) => { showCompleted = (e.target as HTMLInputElement).checked; redraw(); } }), 'Completed')));
    const tasks = sortTasks(site.data.tasks, taskSort).filter((t) => showCompleted || t.status !== 'Completed');
    if (!tasks.length) { el.appendChild(h('p', { class: 'ql-help' }, site.data.tasks.length ? 'Every task is completed.' : 'No tasks yet. Tasks are kept with the site and can point to a file.')); return; }
    const table = h('table', { class: 'ql-report-table' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Task'), h('th', null, 'Priority'), h('th', null, 'Status'), h('th', null, 'File'), h('th', null, ''))));
    const body = h('tbody');
    for (const t of tasks) {
      const done = t.status === 'Completed';
      body.appendChild(h('tr', { class: t.priority === 'High' && !done ? 'ql-sev-warning' : '' },
        h('td', null, h('input', { type: 'checkbox', checked: done, 'aria-label': `Completed: ${t.name}`, onchange: (e: Event) => { t.status = (e.target as HTMLInputElement).checked ? 'Completed' : 'In Progress'; site.touchMeta(); } })),
        h('td', { style: done ? 'text-decoration:line-through;opacity:.7' : '', title: t.description || t.name, ondblclick: async () => { if (await editTask(app, t)) redraw(); } }, t.name, t.assignedTo ? h('div', { class: 'ql-help' }, t.assignedTo) : null),
        h('td', null, t.priority),
        h('td', null, t.status),
        h('td', null, t.file ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); if (site.has(t.file!)) { app.openFile(t.file!); if (t.status === 'Not Started') { t.status = 'In Progress'; site.touchMeta(); } } else toast(`${t.file} is no longer in the site.`); } }, baseName(t.file)) : ''),
        h('td', { style: 'white-space:nowrap' },
          h('button', { class: 'ql-iconbtn ql-sm', title: 'Edit task', 'aria-label': `Edit ${t.name}`, onclick: async () => { if (await editTask(app, t)) redraw(); } }, icon('edit')),
          h('button', { class: 'ql-iconbtn ql-sm', title: 'Delete task', 'aria-label': `Delete ${t.name}`, onclick: async () => { if (await confirmDialog('Delete Task', `Delete the task "${t.name}"?`, 'Delete')) { site.data.tasks = site.data.tasks.filter((x) => x !== t); site.touchMeta(); } } }, icon('delete')))));
    }
    table.appendChild(body);
    el.appendChild(table);
  },
});

