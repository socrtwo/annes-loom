/**
 * Anne's Loom application core: the open site, page tabs, command execution, macro recording, history and autosave.
 *
 * One site is open at a time (as in desktop site editors); any number of its files are open in tabs.
 * The site's files are the document of record. A tab mirrors one file's text, keeps its undo history,
 * and owns the view (Design, Split, Code, Preview) that shows it.
 */
import { isSafeExternalUrl } from './util/sanitize';
import { Site } from './model/site';
import { isPagePath, isImagePath, isTextPath, baseName } from './model/paths';
import { getCommand, allCommands, type Command } from './commands/registry';
import { loadPrefs, savePrefs, type Prefs } from './prefs';
import { kvSet } from './util/store';
import { toast } from './ui/dialog';
import { canonicalKey } from './util/keys';
import type { Shell } from './ui/shell';
import { PageView } from './editor/workspace';
import { blankPage } from './model/html';

let tabCounter = 0;

export type ViewMode = 'design' | 'split' | 'code' | 'preview';

class History {
  stack: string[] = [];
  index = -1;
  labels: string[] = [];
  private last = 0;
  private lastLabel = '';
  push(src: string, label: string): void {
    if (this.stack[this.index] === src) return;
    const now = Date.now();
    // Typing coalesces into one step per pause.
    if ((label === 'Typing' || label === 'Edit Code') && label === this.lastLabel && now - this.last < 1200 && this.index > 0) {
      this.stack[this.index] = src;
    } else {
      this.stack.splice(this.index + 1);
      this.labels.splice(this.index + 1);
      this.stack.push(src);
      this.labels.push(label);
      if (this.stack.length > 300) { this.stack.shift(); this.labels.shift(); }
      this.index = this.stack.length - 1;
    }
    this.last = now;
    this.lastLabel = label;
  }
  reset(src: string): void { this.stack = [src]; this.labels = ['Open']; this.index = 0; this.lastLabel = ''; }
  get canUndo(): boolean { return this.index > 0; }
  get canRedo(): boolean { return this.index < this.stack.length - 1; }
  undo(): string | null { if (!this.canUndo) return null; this.lastLabel = ''; return this.stack[--this.index]; }
  redo(): string | null { if (!this.canRedo) return null; this.lastLabel = ''; return this.stack[++this.index]; }
  get undoLabel(): string { return this.labels[this.index] || ''; }
  get redoLabel(): string { return this.labels[this.index + 1] || ''; }
}

export class PageTab {
  id = `t${Date.now().toString(36)}${tabCounter++}`;
  view: ViewMode;
  dirty = false;
  history = new History();
  el!: HTMLElement;
  ui!: PageView;
  readOnly = false;
  /** Address of the single file this tab came from when it was opened outside a site folder. */
  uri: string | null = null;
  constructor(public app: App, public path: string) {
    this.view = isPagePath(path) ? app.prefs.defaultView : 'code';
    this.history.reset(app.site.read(path) ?? '');
  }
  get source(): string { return this.app.site.read(this.path) ?? ''; }
  get kind(): 'page' | 'text' | 'image' | 'binary' { return isPagePath(this.path) ? 'page' : isImagePath(this.path) && !/\.svg$/i.test(this.path) ? 'image' : isTextPath(this.path) ? 'text' : 'binary'; }
  get displayName(): string { return baseName(this.path); }
}

export class App {
  prefs: Prefs = loadPrefs();
  site: Site;
  docs: PageTab[] = [];
  active!: PageTab;
  ui!: Shell;
  recording: { name: string; steps: { id: string; arg?: any }[] } | null = null;
  recordingPaused = false;
  private refreshQueued = false;
  private autosaveTimer: any = null;
  private listeners = new Set<(app: App) => void>();
  lastCommand: { id: string; arg?: any } | null = null;
  keyIndex = new Map<string, string>();
  /** Site files changed since the last save to disk / the site file. */
  siteDirty = false;
  /** Where the site was saved as one file (.qlsite or .zip), if it was. */
  siteFile: { uri: string | null; name: string; format: 'qlsite' | 'zip' } | null = null;
  private unbind: (() => void) | null = null;

  constructor(public host: HTMLElement) {
    this.site = new Site();
    this.rebuildKeyIndex();
  }

  get tab(): PageTab { return this.active; }
  /** The active tab when it is a page (Design/Code), else undefined. */
  get page(): PageTab | undefined { return this.active?.kind === 'page' ? this.active : undefined; }

  onRefresh(fn: (app: App) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  savePrefs(): void { savePrefs(this.prefs); this.rebuildKeyIndex(); }

  rebuildKeyIndex(): void {
    this.keyIndex.clear();
    for (const c of allCommands()) for (const k of c.keys || []) this.keyIndex.set(canonicalKey(k), c.id);
    for (const [k, id] of Object.entries(this.prefs.keymap)) {
      if (id) this.keyIndex.set(canonicalKey(k), id); else this.keyIndex.delete(canonicalKey(k));
    }
  }

  // ------------------------------------------------------------------------------------------
  // Sites

  /** Replaces the open site (tabs of the old one are closed). Opens the home page. */
  setSite(site: Site, opts: { open?: string | false } = {}): void {
    for (const d of [...this.docs]) { d.ui.destroy(); d.el.remove(); }
    this.docs = [];
    this.unbind?.();
    this.site = site;
    this.siteDirty = false;
    this.siteFile = null;
    this.unbind = site.onChange((path, kind) => this.siteChanged(path, kind));
    this.ui.siteChanged();
    const first = opts.open === false ? null : opts.open || (site.files.size ? site.homePage : null);
    if (first && site.has(first)) this.openFile(first);
    else if (!site.files.size) this.newBlankPage();
    else this.ui.tabsChanged();
    this.refresh();
  }

  newBlankPage(): PageTab {
    const p = this.site.freeName('', 'untitled', 'html');
    this.site.write(p, blankPage({ title: `Untitled ${this.docs.length + 1}`, css: [] }));
    const t = this.openFile(p);
    t.dirty = false;
    return t;
  }

  private siteChanged(path: string | null, kind: string): void {
    this.siteDirty = true;
    if (kind === 'rename' || kind === 'remove') {
      for (const d of [...this.docs]) {
        const to = kind === 'rename' ? this.site.lastMoves.get(d.path) : undefined;
        if (to) d.path = to;
        else if (!this.site.has(d.path)) this.closeTab(d, true);
      }
    }
    for (const d of this.docs) if (path === d.path || kind === 'rename') d.ui.externalChange();
    this.ui.tabsChanged();
    this.scheduleAutosave();
    this.refresh();
  }

  // ------------------------------------------------------------------------------------------
  // Tabs

  openFile(path: string, opts: { view?: ViewMode } = {}): PageTab {
    const existing = this.docs.find((d) => d.path === path);
    if (existing) { if (opts.view) this.setView(existing, opts.view); this.activate(existing); return existing; }
    if (!this.site.has(path)) throw new Error(`${path} is not in the site.`);
    const tab = new PageTab(this, path);
    if (opts.view) tab.view = opts.view;
    this.ui.mountTab(tab);
    this.docs.push(tab);
    this.activate(tab);
    return tab;
  }

  activate(tab: PageTab): void {
    this.active = tab;
    for (const d of this.docs) d.el.classList.toggle('ql-hidden-tab', d !== tab);
    this.ui.tabsChanged();
    tab.ui.layout();
    this.refresh();
    document.title = `${tab.displayName}${tab.dirty ? ' •' : ''} – ${this.site.name} – Anne's Loom`;
  }

  closeTab(tab: PageTab, silent = false): void {
    const i = this.docs.indexOf(tab);
    if (i < 0) return;
    tab.ui.destroy();
    tab.el.remove();
    this.docs.splice(i, 1);
    if (!this.docs.length) {
      if (!silent && this.site.files.size) { this.active = undefined as any; this.ui.tabsChanged(); this.ui.showEmpty(); this.refresh(); return; }
      if (this.site.files.size) this.openFile(this.site.homePage); else this.newBlankPage();
    } else this.activate(this.docs[Math.max(0, i - 1)]);
  }

  setView(tab: PageTab, v: ViewMode): void {
    if (tab.kind !== 'page' && v !== 'code' && v !== 'preview') return;
    tab.view = v;
    tab.ui.layout();
    this.refresh();
  }

  /** Records a new source for a tab's file (from an edit or a command) and adds an undo step. */
  commit(tab: PageTab, src: string, label: string, origin: 'design' | 'code' | 'command' | 'history' = 'command'): void {
    if (src === tab.source && origin !== 'history') return;
    tab.ui.suppressExternal = true;
    try { this.site.write(tab.path, src); } finally { tab.ui.suppressExternal = false; }
    if (origin !== 'history') tab.history.push(src, label);
    if (!tab.dirty) { tab.dirty = true; this.ui.tabsChanged(); }
    tab.ui.sourceChanged(origin);
    document.title = `${tab.displayName} • – ${this.site.name} – Anne's Loom`;
    this.refresh();
  }

  /** Edits the active page's source text as one undoable step. */
  editSource(label: string, fn: (src: string) => string, tab = this.active): boolean {
    if (!tab) return false;
    tab.ui.flush();
    const before = tab.source;
    const after = fn(before);
    if (after === before) return false;
    this.commit(tab, after, label, 'command');
    return true;
  }

  undo(): void { const t = this.active; t.ui.flush(); const s = t.history.undo(); if (s != null) this.commit(t, s, 'Undo', 'history'); }
  redo(): void { const t = this.active; const s = t.history.redo(); if (s != null) this.commit(t, s, 'Redo', 'history'); }

  refresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.ui.refresh();
      for (const l of this.listeners) l(this);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Commands

  handleKey(key: string): boolean {
    const id = this.keyIndex.get(canonicalKey(key));
    if (!id) return false;
    const c = getCommand(id);
    if (!c) return false;
    if (c.isEnabled && !c.isEnabled(this)) return false;
    this.exec(id);
    return true;
  }

  isReadOnly(): boolean { return !this.active || this.active.readOnly; }

  exec(id: string, arg?: any): unknown {
    const c = getCommand(id);
    if (!c) { toast(`Unknown command: ${id}`); return false; }
    if (c.edits && this.isReadOnly()) { toast('This file is read-only.'); return false; }
    if (c.isEnabled && !c.isEnabled(this)) { toast(`${c.label} is not available here.`); return false; }
    if (this.recording && !c.noRecord && id !== 'dev.recordMacro' && id !== 'dev.stopRecording') this.recordStep(id, arg);
    if (!c.noRecord && id !== 'edit.repeat') this.lastCommand = { id, arg };
    try {
      const r = c.run(this, arg);
      if (r instanceof Promise) r.catch((e) => this.reportError(c, e)).finally(() => this.refresh());
      this.refresh();
      return r;
    } catch (e) {
      this.reportError(c, e);
      return false;
    }
  }

  private reportError(c: Command, e: unknown): void {
    console.error(e);
    toast(`${c.label}: ${(e as any)?.message || e}`, { ms: 6000 });
  }

  recordStep(id: string, arg?: any): void {
    if (!this.recording || this.recordingPaused) return;
    this.recording.steps.push(arg === undefined ? { id } : { id, arg: JSON.parse(JSON.stringify(arg)) });
  }

  // ------------------------------------------------------------------------------------------
  // Autosave: the whole site is kept as a draft on this device until it is saved.

  scheduleAutosave(): void {
    if (!this.prefs.autosave || this.autosaveTimer) return;
    this.autosaveTimer = setTimeout(() => { this.autosaveTimer = null; void this.saveDrafts(); }, Math.max(3, this.prefs.autosaveSeconds) * 1000);
  }

  async saveDrafts(): Promise<void> {
    if (!this.siteDirty) return;
    try {
      await kvSet('draft:site', { json: this.site.toJSON(), name: this.site.name, time: Date.now(), open: this.docs.map((d) => d.path) });
      this.ui.status?.('Draft saved');
    } catch { /* storage full */ }
  }

  followLink(href: string): void {
    if (!isSafeExternalUrl(href)) { toast(`Blocked a link with an unsupported or unsafe address: ${href.slice(0, 60)}`); return; }
    import('./platform/native').then(({ openExternal }) => openExternal(href));
  }

  focus(): void { this.active?.ui.focus(); }
}
