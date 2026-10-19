/**
 * Result panes for the checkers: HTML validation, accessibility, compatibility, and the SEO and
 * performance report. A command runs a check and hands its findings to showReport(); the pane lists
 * them by file with severity, line and guideline, and a click opens the file in Code view at that line.
 */
import type { App } from '../app';
import { h, icon, clear, download } from './dom';
import { registerPane, sigOf } from './panes';
import { toast } from './dialog';
import { LineIndex, type Issue, type Severity } from '../check/validate';

export type ReportPane = 'validation' | 'accessibility' | 'compatibility' | 'pageReport';

export interface ReportAction { label: string; icon: string; title?: string; run: (app: App) => void }

export interface CheckReport {
  title: string;
  scope: 'page' | 'site';
  items: Issue[];
  when: number;
  /** One line shown above the list (e.g. page weight). */
  summary?: string;
  /** Runs the check again; `scope` switches between the page and the site. */
  rerun?: (app: App, scope: 'page' | 'site') => void;
  actions?: ReportAction[];
  /** Note shown under the list. */
  note?: string;
}

const reports: Partial<Record<ReportPane, CheckReport>> = {};
const filters: Partial<Record<ReportPane, Severity | 'all'>> = {};
let version = 0;

const TITLES: Record<ReportPane, string> = { validation: 'HTML Validation', accessibility: 'Accessibility', compatibility: 'Compatibility', pageReport: 'SEO & Performance' };

export function getReport(id: ReportPane): CheckReport | undefined { return reports[id]; }

/** Shows (or refreshes) a report in its pane. */
export function showReport(app: App, id: ReportPane, report: CheckReport): void {
  reports[id] = report;
  version++;
  app.ui.openPane(id);
  app.refresh();
}

/** Opens a file in Code view at a line and column. */
export function goToIssue(app: App, path: string | undefined, line: number, col = 1): void {
  const p = path || app.active?.path;
  if (!p || !app.site.has(p)) { toast(`${p || 'The file'} is no longer in the site.`); return; }
  const tab = app.openFile(p);
  if (tab.view === 'design' || tab.view === 'preview') app.setView(tab, 'code');
  const go = () => {
    const cv = tab.ui.code;
    if (!cv) return;
    try {
      const li = new LineIndex(tab.source);
      const off = Math.min(tab.source.length, li.offset(line, col));
      const lineEnd = tab.source.indexOf('\n', off);
      const tagEnd = tab.source[off] === '<' ? tab.source.indexOf('>', off) + 1 : 0;
      cv.select(off, tagEnd > off && (lineEnd < 0 || tagEnd <= lineEnd) ? tagEnd : off);
    } catch { cv.goToLine(line); }
  };
  requestAnimationFrame(() => requestAnimationFrame(go));
}

const SEV_ICON: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'info' };
const SEV_COLOR: Record<Severity, string> = { error: 'var(--danger, #c62828)', warning: '#b26a00', info: 'var(--accent, #2563eb)' };

export function reportText(r: CheckReport): string {
  const lines = [`${r.title} (${r.scope === 'site' ? 'whole site' : 'page'}), ${new Date(r.when).toLocaleString()}`];
  if (r.summary) lines.push(r.summary);
  for (const i of r.items) lines.push(`${i.path ? i.path + ':' : ''}${i.line}:${i.col}\t${i.severity}\t${i.message}${i.ref ? `\t${i.ref}` : ''}`);
  return lines.join('\n');
}

function csv(r: CheckReport): string {
  const cell = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  return ['File,Line,Column,Severity,Message,Reference', ...r.items.map((i) => [i.path || '', i.line, i.col, i.severity, i.message, i.ref || ''].map((x) => cell(String(x))).join(','))].join('\r\n');
}

function renderReport(app: App, id: ReportPane, el: HTMLElement): void {
  const r = reports[id];
  const sig = `${version}:${filters[id] || 'all'}:${r ? 1 : 0}`;
  if (!sigOf(el, sig)) return;
  clear(el);
  if (!r) {
    el.appendChild(h('div', { class: 'ql-help', style: 'padding:10px' }, `No ${TITLES[id].toLowerCase()} report yet.`));
    const cmd = id === 'validation' ? 'tools.validate' : id === 'accessibility' ? 'tools.accessibility' : id === 'compatibility' ? 'tools.compatibility' : 'tools.seoCheck';
    el.appendChild(h('div', { style: 'padding:0 10px' }, h('button', { class: 'ql-btn ql-primary', onclick: () => app.exec(cmd) }, 'Check the page')));
    return;
  }
  const n = { error: 0, warning: 0, info: 0 } as Record<Severity, number>;
  for (const i of r.items) n[i.severity]++;
  const f = filters[id] || 'all';
  const setFilter = (v: Severity | 'all') => { filters[id] = v; el.dataset.sig = ''; renderReport(app, id, el); };
  const chip = (sev: Severity | 'all', label: string, count: number) => h('button', { class: 'ql-btn ql-sm' + (f === sev ? ' ql-on' : ''), style: 'padding:2px 8px;min-height:26px', 'aria-pressed': String(f === sev), onclick: () => setFilter(f === sev ? 'all' : sev) }, sev === 'all' ? null : icon(SEV_ICON[sev]), ` ${count} ${label}`);
  const tools = h('div', { class: 'ql-row ql-pane-tools', style: 'flex-wrap:wrap;gap:4px' },
    r.rerun ? h('button', { class: 'ql-iconbtn ql-sm', title: 'Check again', 'aria-label': 'Check again', onclick: () => r.rerun!(app, r.scope) }, icon('refresh')) : null,
    r.rerun ? h('button', { class: 'ql-iconbtn ql-sm', title: r.scope === 'site' ? 'Check the current page only' : 'Check every page in the site', 'aria-label': 'Change scope', onclick: () => r.rerun!(app, r.scope === 'site' ? 'page' : 'site') }, icon(r.scope === 'site' ? 'description' : 'language')) : null,
    h('button', { class: 'ql-iconbtn ql-sm', title: 'Copy the report', 'aria-label': 'Copy the report', onclick: () => { void navigator.clipboard?.writeText(reportText(r)).then(() => toast('Report copied.'), () => toast('Copying is not allowed here.')); } }, icon('content_copy')),
    h('button', { class: 'ql-iconbtn ql-sm', title: 'Save as CSV', 'aria-label': 'Save as CSV', onclick: () => download(new Blob([csv(r)], { type: 'text/csv' }), `${id}-report.csv`) }, icon('download')),
    ...(r.actions || []).map((a) => h('button', { class: 'ql-btn ql-sm', title: a.title || a.label, style: 'min-height:26px;padding:2px 8px', onclick: () => a.run(app) }, icon(a.icon), ' ', a.label)));
  el.appendChild(tools);
  el.appendChild(h('div', { style: 'padding:4px 10px;font-size:12px;color:var(--muted)' }, `${r.title} · ${r.scope === 'site' ? 'whole site' : app.active?.path || 'page'} · ${new Date(r.when).toLocaleTimeString()}`));
  el.appendChild(h('div', { class: 'ql-row', style: 'gap:4px;padding:2px 10px;flex-wrap:wrap' }, chip('error', n.error === 1 ? 'error' : 'errors', n.error), chip('warning', n.warning === 1 ? 'warning' : 'warnings', n.warning), chip('info', 'notes', n.info)));
  if (r.summary) el.appendChild(h('div', { class: 'ql-help', style: 'padding:4px 10px' }, r.summary));
  const items = r.items.filter((i) => f === 'all' || i.severity === f);
  if (!r.items.length) el.appendChild(h('div', { style: 'padding:14px 10px;display:flex;gap:8px;align-items:center' }, icon('check_circle'), h('span', null, 'No problems found.')));
  const list = h('div', { role: 'list', style: 'padding:4px 0' });
  let lastPath: string | undefined = '\u0000';
  const LIMIT = 1500;
  for (const i of items.slice(0, LIMIT)) {
    if (r.scope === 'site' && i.path !== lastPath) {
      lastPath = i.path;
      list.appendChild(h('div', { style: 'padding:8px 10px 2px;font-weight:600;font-size:12px;display:flex;gap:6px;align-items:center' }, icon('description'), i.path || ''));
    }
    const row = h('div', { role: 'listitem', tabindex: '0', class: 'ql-tree-row', style: 'display:flex;gap:6px;align-items:flex-start;padding:4px 10px;cursor:pointer;height:auto;white-space:normal', title: 'Go to this line in Code view' },
      h('span', { style: `color:${SEV_COLOR[i.severity]};flex:none`, 'aria-label': i.severity }, icon(SEV_ICON[i.severity])),
      h('span', { style: 'flex:1;min-width:0;font-size:13px;line-height:1.35' },
        h('span', { style: 'color:var(--muted);font-variant-numeric:tabular-nums' }, `Line ${i.line}${i.col > 1 ? `:${i.col}` : ''} `),
        i.message,
        i.ref ? h('span', { style: 'display:block;font-size:11px;color:var(--muted)' }, i.ref) : null));
    const go = () => goToIssue(app, i.path, i.line, i.col);
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    list.appendChild(row);
  }
  el.appendChild(list);
  if (items.length > LIMIT) el.appendChild(h('div', { class: 'ql-help', style: 'padding:6px 10px' }, `${items.length - LIMIT} more not shown; save the report as CSV to see them all.`));
  if (r.note) el.appendChild(h('div', { class: 'ql-help', style: 'padding:8px 10px' }, r.note));
}

for (const id of ['validation', 'accessibility', 'compatibility', 'pageReport'] as ReportPane[]) {
  registerPane({
    id, title: TITLES[id], side: 'right',
    render(app, el) { el.dataset.sig = ''; renderReport(app, id, el); },
    update(app, el) { renderReport(app, id, el); },
  });
}
