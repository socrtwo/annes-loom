/**
 * Site report commands (shown in the Reports pane) and link checking.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, choiceDialog } from '../ui/dialog';
import { REPORTS, linkIndex, unlinkedFiles, DEFAULT_SPEED_KBPS, type ReportOptions } from '../site/reports';
import { showReport, reportView, linkStatus, setLinkStatus } from '../ui/panesSite';
import { desktopHttp } from '../platform/native';

const hasSite = (app: App) => app.site.files.size > 0;

/** Asks for the options of reports that have them ("files changed in the last N days", slow page limits). */
async function askOptions(kind: 'days' | 'slow', id: string): Promise<ReportOptions | null> {
  const o = reportView.opts;
  if (kind === 'days') {
    const older = id === 'olderFiles';
    const r = await openDialog({ title: older ? 'Older Files' : id === 'recentlyAdded' ? 'Recently Added Files' : 'Recently Changed Files',
      fields: [{ key: 'days', label: older ? 'Files not changed in the last' : 'Files from the last', type: 'number', value: o.days ?? (older ? 72 : 30), min: 0, max: 36500, suffix: 'days', autofocus: true }] });
    return r ? { days: Math.max(0, Number(r.days) || 0) } : null;
  }
  const r = await openDialog({ title: 'Slow Pages',
    help: 'A page counts as slow when the page and the pictures, style sheets, scripts and media it loads add up to more than this size.',
    fields: [
      { key: 'kb', label: 'Larger than', type: 'number', value: o.kb ?? 500, min: 1, suffix: 'KB', half: true },
      { key: 'speed', label: 'Connection speed for the time estimate', type: 'select', value: String(o.speedKbps ?? DEFAULT_SPEED_KBPS), half: true,
        options: [['56', '56 kbps (dial-up)'], ['384', '384 kbps (slow mobile)'], ['1500', '1.5 Mbps (3G)'], ['10000', '10 Mbps'], ['50000', '50 Mbps'], ['100000', '100 Mbps']].map(([value, label]) => ({ value, label })) },
    ] });
  return r ? { kb: Math.max(1, Number(r.kb) || 500), speedKbps: Number(r.speed) || DEFAULT_SPEED_KBPS } : null;
}

for (const rep of REPORTS) {
  def({
    id: rep.cmd, label: rep.label, icon: rep.icon, tab: 'Site', group: 'Reports', noRecord: true, isEnabled: hasSite,
    origin: rep.id === 'seo' || rep.id === 'accessibility' || rep.id === 'compatibility' || rep.id === 'css' ? 'Expression Web, Dreamweaver' : 'FrontPage, Expression Web',
    keywords: 'report site',
    tip: `Site report: ${rep.label}`,
    run: async (app, arg) => {
      let opts: ReportOptions = {};
      if (rep.ask && (arg === undefined || arg?.ask)) { const o = await askOptions(rep.ask, rep.id); if (!o) return; opts = o; }
      else if (arg && typeof arg === 'object') opts = arg;
      showReport(app, rep.id, opts);
    },
  });
}

def({
  id: 'site.reportMenu', label: 'Reports', icon: 'summarize', tab: 'Site', group: 'Reports', kind: 'menu', noRecord: true, origin: 'FrontPage, Expression Web', isEnabled: hasSite,
  tip: 'Choose a site report',
  menu: () => [
    { id: 'site.reportSummary', label: 'Site Summary', icon: 'summarize' }, { separator: true },
    { heading: 'Files' }, ...REPORTS.filter((r) => ['allFiles', 'recentlyAdded', 'recentlyChanged', 'olderFiles', 'unlinked', 'slowPages'].includes(r.id)).map((r) => ({ id: r.cmd, label: r.label, icon: r.icon })),
    { heading: 'Problems' }, ...REPORTS.filter((r) => ['brokenLinks', 'externalLinks', 'componentErrors', 'missingAlt', 'missingTitles', 'duplicateTitles', 'unusedStyles', 'styleLinks', 'seo', 'accessibility', 'compatibility', 'css'].includes(r.id)).map((r) => ({ id: r.cmd, label: r.label, icon: r.icon })),
    { heading: 'Workflow' }, ...REPORTS.filter((r) => ['templates', 'checkedOut', 'reviewStatus', 'assignedTo', 'categories', 'publishStatus'].includes(r.id)).map((r) => ({ id: r.cmd, label: r.label, icon: r.icon })),
  ],
  run: (app) => showReport(app, 'summary'),
});

// ------------------------------------------------------------------------------------------
// Link checking

/**
 * Checks one external address. The desktop app asks the server directly (HTTPS); a web page can only
 * read the status when the other server allows it (CORS), otherwise it learns just whether the server answered.
 */
export async function checkUrl(url: string, timeoutMs = 10000): Promise<string> {
  if (!/^https?:/i.test(url)) return 'Not checked (not a web address)';
  if (desktopHttp && /^https:/i.test(url)) {
    try {
      let r = await desktopHttp({ url, method: 'HEAD', headers: { 'User-Agent': 'QuillLoom link checker' } });
      if (r.status === 405 || r.status === 501 || r.status === 403) r = await desktopHttp({ url, method: 'GET', headers: { 'User-Agent': 'QuillLoom link checker' } });
      return r.status > 0 && r.status < 400 ? `OK (${r.status})` : String(r.status || 'Unreachable');
    } catch { return 'Unreachable'; }
  }
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    try {
      const r = await fetch(url, { method: 'HEAD', mode: 'cors', redirect: 'follow', signal: ctl?.signal, cache: 'no-store' });
      return r.ok || (r.status >= 300 && r.status < 400) ? `OK (${r.status})` : String(r.status);
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'Timed out';
      // The server did not allow reading the answer: ask again without reading it.
      await fetch(url, { method: 'GET', mode: 'no-cors', redirect: 'follow', signal: ctl?.signal, cache: 'no-store' });
      return 'OK (server answered; status hidden by the browser)';
    }
  } catch (e: any) {
    return e?.name === 'AbortError' ? 'Timed out' : 'Unreachable';
  } finally { clearTimeout(timer); }
}

/** Checks addresses a few at a time; results go to the shared link status the panes and reports show. */
export async function checkUrls(urls: string[], progress?: (done: number, total: number) => void): Promise<Map<string, string>> {
  const list = [...new Set(urls)].filter((u) => /^https?:/i.test(u));
  const out = new Map<string, string>();
  let i = 0, done = 0;
  const worker = async () => {
    while (i < list.length) {
      const u = list[i++];
      const s = await checkUrl(u);
      out.set(u, s); setLinkStatus(u, s);
      progress?.(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
  return out;
}

const HONEST = desktopHttp
  ? 'The desktop app checks HTTPS addresses directly. Plain HTTP addresses are checked the way a browser would.'
  : 'In a browser, most sites do not let other pages read their answers (CORS). Such links are reported as "server answered" without the status, so a missing page on another site may not be detected. The desktop app checks them fully.';

def([
  { id: 'site.checkLinks', label: 'Check Links Sitewide', icon: 'link_off', tab: 'Site', group: 'Reports', noRecord: true, origin: 'Dreamweaver, FrontPage', isEnabled: hasSite,
    tip: 'Find broken links, unverified external links and unlinked files',
    run: async (app, arg) => {
      const idx = linkIndex(app.site);
      let broken = 0;
      for (const l of idx.out.values()) for (const x of l) if (!x.exists) broken++;
      const urls = [...new Set([...idx.external.values()].flat().map((x) => x.url).filter((u) => /^https?:/i.test(u)))];
      let external = arg?.external === true;
      if (arg === undefined && urls.length) {
        const c = await choiceDialog('Check Links', `${broken} broken internal link${broken === 1 ? '' : 's'} found. The site also has ${urls.length} external address${urls.length === 1 ? '' : 'es'}.\n${HONEST}`, ['Show results', 'Also verify external links']);
        if (c < 0) return;
        external = c === 1;
      }
      showReport(app, 'brokenLinks');
      if (external && urls.length) {
        toast(`Checking ${urls.length} external address${urls.length === 1 ? '' : 'es'}…`);
        app.ui.status?.(`Checking links 0/${urls.length}`);
        const res = await checkUrls(urls, (d, t) => app.ui.status?.(`Checking links ${d}/${t}`));
        const bad = [...res.values()].filter((s) => !/^ok/i.test(s)).length;
        toast(`External links checked: ${urls.length - bad} OK, ${bad} with problems.`, { ms: 6000 });
        app.refresh();
      }
      const orphans = unlinkedFiles(app.site, idx).length;
      if (orphans && arg === undefined) toast(`${orphans} file${orphans === 1 ? ' is' : 's are'} not linked from anywhere.`, { action: 'Show', onAction: () => showReport(app, 'unlinked') });
    } },

  { id: 'site.checkLinksPage', label: 'Check Links in Page', icon: 'add_link', tab: 'Check', group: 'Validate', noRecord: true, origin: 'Dreamweaver', isEnabled: (app) => !!app.active,
    tip: 'Check the links of the current page, including external ones',
    run: async (app) => {
      const path = app.active?.path;
      if (!path) return;
      app.active.ui.flush();
      const idx = linkIndex(app.site);
      const urls = (idx.external.get(path) || []).map((x) => x.url).filter((u) => /^https?:/i.test(u) && !linkStatus.has(u));
      showReport(app, 'brokenLinks', {}, path);
      if (urls.length) {
        app.ui.status?.(`Checking ${urls.length} external links…`);
        await checkUrls(urls, (d, t) => app.ui.status?.(`Checking links ${d}/${t}`));
        app.refresh();
      }
      const internalBroken = (idx.out.get(path) || []).filter((l) => !l.exists).length;
      const extBad = (idx.external.get(path) || []).filter((x) => { const s = linkStatus.get(x.url); return s && !/^ok/i.test(s); }).length;
      toast(internalBroken + extBad ? `${internalBroken} broken internal and ${extBad} failing external link${extBad === 1 ? '' : 's'}.` : 'No broken links found in this page.', { ms: 5000 });
      if (!desktopHttp && urls.length) setTimeout(() => toast(HONEST, { ms: 9000 }), 5200);
    } },
]);
