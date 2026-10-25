/** Anne's Loom entry point. */
import 'material-symbols/outlined.css';
import './styles/app.css';
import './styles/loom.css';
import './ui/scrollcue.css';
import './commands';
import { App } from './app';
import { Shell } from './ui/shell';
import { launchFile, onFileOpened, onBackButton, isNative, isDesktop, isCapacitor, type OpenedFile } from './platform/native';
import { closeMenus, inDialog, toast } from './ui/dialog';
import { kvGet } from './util/store';
import { allCommands, getCommand } from './commands/registry';
import { installScrollCues } from './ui/scrollcue';
import { Site } from './model/site';
import { TEMPLATES } from './templates';

const host = document.getElementById('app')!;

installScrollCues({
  selector: [
    '.ql-menu', '.ql-dialog-body', '.ql-cmdlist', '.ql-listbox', '.ql-pane-body', '.ql-bs-nav', '.ql-bs-body',
    '.ql-palette-list', '.ql-symbol-grid', '.ql-notices', '.ql-dialog-preview', '.ql-ai-out', '.ql-tree',
  ].join(', '),
});

const app = new App(host);
app.ui = new Shell(app);
app.rebuildKeyIndex();
// A first site: the starter template, so a new user sees a working page.
{
  const site = new Site('My Web Site');
  const starter = TEMPLATES.find((t) => t.id === 'starter-site') || TEMPLATES.find((t) => t.kind === 'site');
  if (starter) for (const [p, text] of Object.entries(starter.files())) site.write(p, text, { silent: true });
  app.setSite(site, { open: starter?.open });
  app.siteDirty = false;
  for (const d of app.docs) d.dirty = false;
  app.ui.tabsChanged();
}
(window as any).ql = app;
(window as any).__qlAllIds = allCommands().map((c) => c.id);
(window as any).__qlGetCommand = getCommand;

window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length || (e.target as HTMLElement)?.closest?.('.ql-tree')) return;
  e.preventDefault();
  app.exec('file.openDropped', files);
});

async function start() {
  if (!isNative() && /[?&]ql-oauth=/.test(location.search)) {
    try {
      const { handleOAuthRedirect } = await import('./ai/oauth');
      const { setApiKey, saveAiSettings } = await import('./ai/store');
      const ok = await handleOAuthRedirect(async (key) => {
        await setApiKey('openrouter', key);
        saveAiSettings((s) => {
          s.providers.openrouter = s.providers.openrouter || { id: 'openrouter', model: 'openrouter/free', fastModel: 'openrouter/free' };
          if (!s.active) s.active = 'openrouter';
        });
      });
      if (ok) toast('Signed in to OpenRouter and saved the key. You can close this tab and return to QuillLoom.', { ms: 15000 });
    } catch (e: any) {
      toast(`OpenRouter sign-in did not complete: ${e?.message || e}`, { ms: 10000 });
    }
  }
  const { openBuffer } = await import('./commands/file');
  let ready = false;
  const queued: OpenedFile[] = [];
  onFileOpened((f) => { if (ready) void openBuffer(app, f.data, f.name, f.uri); else queued.push(f); });
  const lf = await launchFile();
  if (lf) await openBuffer(app, lf.data, lf.name, lf.uri);
  const openedAny = !!lf || queued.length > 0;
  for (const f of queued.splice(0)) await openBuffer(app, f.data, f.name, f.uri);
  ready = true;
  const draft = await kvGet('draft:site');
  if (draft && !openedAny) toast(`An unsaved copy of "${draft.name}" can be recovered.`, { action: 'Recover', onAction: () => app.exec('file.recoverUnsaved'), ms: 9000 });
  if (app.prefs.firstRun && !openedAny) setTimeout(() => app.ui.tour(), 600);
  app.focus();
}
void start();

if (!isNative() && !isCapacitor() && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !import.meta.env.DEV) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}

onBackButton(() => {
  if (document.querySelector('.ql-menu')) { closeMenus(); return true; }
  if (inDialog()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; }
  if (host.classList.contains('ql-backstage-open')) { app.ui.hideBackstage(); return true; }
  if (app.ui.pane) { app.ui.closePane(); return true; }
  void app.saveDrafts();
  return false;
});

window.addEventListener('beforeunload', (e) => {
  for (const d of app.docs) d.ui.flush();
  void app.saveDrafts();
  if ((!isNative() || isDesktop()) && app.siteDirty && app.docs.some((d) => d.dirty)) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void app.saveDrafts(); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.ui.applyPrefs());
