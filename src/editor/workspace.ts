/**
 * The view of one open file. Pages get Design, Split, Code and Preview; style sheets, scripts and other
 * text get Code (and Preview for style sheets is the pages that use them); pictures get a viewer.
 *
 * Synchronization: the file text in the site is the source of truth. Design view edits are serialized
 * (debounced) into the body of that text; Code view edits replace it; either one refreshes the other.
 */
import type { App, PageTab } from '../app';
import { h, icon, clear, debounce } from '../ui/dom';
import { CodeView, type CodeOptions } from './codeView';
import { DesignView } from './designView';
import { ResourceCache, previewDocument } from './resources';
import { replaceBody } from '../model/html';
import { resolveRef, baseName } from '../model/paths';
import { desktopFolders } from '../platform/native';

const caches = new WeakMap<object, ResourceCache>();
export function cacheFor(app: App): ResourceCache {
  let c = caches.get(app.site);
  if (!c) { c = new ResourceCache(app.site); caches.set(app.site, c); }
  return c;
}

export function codeOptions(app: App): CodeOptions {
  const p = app.prefs;
  return { lineNumbers: p.codeLineNumbers, wrap: p.codeWrap, fold: p.codeFold, autoClose: p.codeAutoClose, complete: p.codeComplete, tabSize: p.tabSize, highlightLine: p.codeHighlightLine };
}

export const PAGE_SIZES: [number, string][] = [[0, 'Fill window'], [320, '320 (small phone)'], [375, '375 (phone)'], [414, '414 (large phone)'], [768, '768 (tablet)'], [800, '800 × 600 (classic)'], [1024, '1024 (tablet landscape)'], [1280, '1280 (laptop)'], [1440, '1440 (desktop)'], [1920, '1920 (full HD)']];

export class PageView {
  el: HTMLElement;
  private body: HTMLElement;
  private designWrap: HTMLElement;
  private codeWrap: HTMLElement;
  private previewWrap: HTMLElement;
  private tagBar: HTMLElement;
  private modeBar: HTMLElement;
  code: CodeView | null = null;
  design: DesignView | null = null;
  private preview: HTMLIFrameElement | null = null;
  /** Which half of Split view the user worked in last. */
  focusArea: 'design' | 'code' = 'design';
  /** Set while the tab itself writes the site, so its own change is not handled as an outside one. */
  suppressExternal = false;
  private designDirty = false;
  private designStale = true;
  private codePending: string | null = null;
  private loadedPath = '';
  private msgListener: ((e: MessageEvent) => void) | null = null;

  constructor(public app: App, public tab: PageTab) {
    this.tagBar = h('div', { class: 'ql-tagbar', role: 'toolbar', 'aria-label': 'Quick Tag Selector' });
    this.designWrap = h('div', { class: 'ql-design' });
    this.codeWrap = h('div', { class: 'ql-code' });
    this.previewWrap = h('div', { class: 'ql-preview' });
    this.body = h('div', { class: 'ql-viewbody' }, this.codeWrap, this.designWrap, this.previewWrap);
    this.modeBar = h('div', { class: 'ql-modebar' });
    this.el = h('div', { class: 'ql-pageview' }, this.tagBar, this.body, this.modeBar);
    this.build();
  }

  private build(): void {
    const t = this.tab;
    if (t.kind === 'image' || t.kind === 'binary') { this.buildViewer(); return; }
    this.code = new CodeView(this.codeWrap, t.path, t.source, codeOptions(this.app));
    this.code.onChange = (text) => { this.codePending = text; this.flushCode(); };
    this.code.onFocus = () => { this.focusArea = 'code'; this.app.refresh(); };
    if (t.kind === 'page') {
      this.design = new DesignView(this.designWrap, this.app.site, cacheFor(this.app));
      this.applyDesignPrefs();
      this.design.onEdit = () => { this.designDirty = true; this.focusArea = 'design'; this.flushDesign(); };
      this.design.onSelect = () => { this.focusArea = 'design'; this.renderTagBar(); this.app.refresh(); };
      this.design.onKey = (e) => this.app.ui.frameKey(e);
      this.design.onContext = (x, y, el) => this.app.ui.designContextMenu(x, y, el);
      this.design.onNavigate = (href) => this.followSiteLink(href);
    }
    this.renderModeBar();
  }

  applyDesignPrefs(): void {
    const d = this.design, p = this.app.prefs;
    if (!d) return;
    d.gridSize = p.gridSize;
    d.snap = p.snapToGrid;
    d.useStrongEm = p.useStrongEm;
    d.setAids({ blocks: p.aidBlocks, cssLayout: p.aidCssLayout, invisibles: p.aidInvisibles, forms: p.aidForms, empty: p.aidEmpty, margins: p.aidMargins, tables: p.aidTables, grid: p.showGrid });
    this.designWrap.style.setProperty('--ql-page-width', p.pageWidth ? `${p.pageWidth}px` : '100%');
    this.code?.setOptions(codeOptions(this.app));
    this.el.style.setProperty('--ql-code-size', `${p.codeFontSize}px`);
  }

  private buildViewer(): void {
    const t = this.tab;
    const f = this.app.site.get(t.path);
    if (t.kind === 'image' && f) {
      const url = cacheFor(this.app).url(t.path, 'blob');
      const img = h('img', { src: url || '', alt: t.path, class: 'ql-image-view' }) as HTMLImageElement;
      const info = h('div', { class: 'ql-help' });
      img.onload = () => { info.textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${(f.data?.length || 0).toLocaleString()} bytes · ${f.mime}`; };
      this.previewWrap.append(h('div', { class: 'ql-image-wrap' }, img), info);
    } else {
      this.previewWrap.append(h('div', { class: 'ql-empty' }, icon('draft'), h('p', null, `${t.path} is a binary file (${f?.mime || 'unknown type'}, ${(f?.data?.length || 0).toLocaleString()} bytes).`), h('button', { class: 'ql-btn', onclick: () => this.app.exec('site.exportFile', t.path) }, 'Save a copy…')));
    }
    this.tab.view = 'preview';
  }

  // ----------------------------------------------------------------------------------------
  // Layout

  layout(): void {
    // A frameset page has no body to edit visually (its <body> lives inside <noframes>).
    if (this.design && (this.tab.view === 'design' || this.tab.view === 'split') && /<frameset\b/i.test(this.tab.source)) this.tab.view = 'code';
    const v = this.tab.view;
    this.el.dataset.view = v;
    this.el.classList.toggle('ql-split-vertical', this.app.prefs.splitVertical);
    const showDesign = !!this.design && (v === 'design' || v === 'split');
    const showCode = !!this.code && (v === 'code' || v === 'split');
    this.designWrap.style.display = showDesign ? '' : 'none';
    this.codeWrap.style.display = showCode ? '' : 'none';
    this.previewWrap.style.display = v === 'preview' ? '' : 'none';
    this.tagBar.style.display = this.design && v !== 'preview' ? '' : 'none';
    if (showDesign && (this.designStale || this.loadedPath !== this.tab.path)) void this.reloadDesign();
    if (v === 'preview' && (this.tab.kind === 'page' || this.tab.kind === 'text')) this.renderPreview();
    if (v !== 'preview') this.disposePreview();
    this.renderModeBar();
    this.renderTagBar();
  }

  async reloadDesign(): Promise<void> {
    if (!this.design) return;
    this.designStale = false;
    this.loadedPath = this.tab.path;
    await this.design.load(this.tab.source, this.tab.path);
    this.design.setEditable(!this.tab.readOnly);
    this.renderTagBar();
  }

  private renderPreview(): void {
    this.disposePreview();
    let path = this.tab.path, src = this.tab.source;
    if (this.tab.kind !== 'page') {
      // A style sheet or script previews the first page that uses it.
      const user = this.app.site.pages().find((p) => (p.text || '').includes(baseName(path)));
      if (!user) { this.previewWrap.appendChild(h('p', { class: 'ql-help ql-pad' }, 'No page in the site uses this file.')); return; }
      path = user.path; src = user.text || '';
    }
    const frame = h('iframe', { class: 'ql-preview-frame', sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-downloads', title: 'Preview' }) as HTMLIFrameElement;
    frame.style.width = this.app.prefs.pageWidth ? `${this.app.prefs.pageWidth}px` : '100%';
    const html = previewDocument(this.app.site, path, src, cacheFor(this.app));
    // The desktop app's content security policy would apply to a srcdoc frame and stop the page's own
    // scripts, so there the page is served from a separate preview origin.
    if (desktopFolders) void desktopFolders.setPreview({ id: this.tab.id, html }).then((r) => { frame.src = r.url; });
    else frame.srcdoc = html;
    this.previewWrap.appendChild(frame);
    this.preview = frame;
    this.msgListener = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || !e.data || typeof e.data.qlPreviewNav !== 'string') return;
      const target = resolveRef(path, e.data.qlPreviewNav);
      if (target && this.app.site.has(target)) this.app.openFile(target, { view: 'preview' });
    };
    window.addEventListener('message', this.msgListener);
  }

  private disposePreview(): void {
    if (this.msgListener) window.removeEventListener('message', this.msgListener);
    this.msgListener = null;
    if (this.preview) { this.preview.remove(); this.preview = null; }
    if (this.tab.kind === 'page' || this.tab.kind === 'text') clear(this.previewWrap);
  }

  private renderModeBar(): void {
    clear(this.modeBar);
    const t = this.tab;
    const modes: [string, string, string][] = t.kind === 'page' ? [['design', 'Design', 'draw'], ['split', 'Split', 'vertical_split'], ['code', 'Code', 'code'], ['preview', 'Preview', 'visibility']]
      : t.kind === 'text' ? [['code', 'Code', 'code'], ['preview', 'Preview', 'visibility']] : [];
    for (const [m, label, ic] of modes) {
      this.modeBar.appendChild(h('button', { class: 'ql-mode' + (t.view === m ? ' ql-on' : ''), title: `${label} view`, onclick: () => this.app.exec(`view.${m}`) }, icon(ic), h('span', null, label)));
    }
    this.modeBar.appendChild(h('span', { class: 'ql-spacer' }));
    if (this.app.site.data.templates[t.path] || /#BeginTemplate|InstanceBegin\s/.test(t.source)) this.modeBar.appendChild(h('span', { class: 'ql-modebar-note', title: 'This page is attached to a page template' }, icon('dashboard'), ' Template'));
    if (t.kind === 'page') {
      const w = this.app.prefs.pageWidth;
      this.modeBar.appendChild(h('button', { class: 'ql-mode', title: 'Page size', onclick: () => this.app.exec('view.pageSize', 'menu') }, icon('devices'), h('span', null, w ? `${w}px` : 'Fill')));
    }
  }

  // ----------------------------------------------------------------------------------------
  // Quick Tag Selector

  renderTagBar(): void {
    clear(this.tagBar);
    const d = this.design;
    if (!d?.doc) return;
    const chain = d.ancestry();
    if (!chain.length) chain.push(d.doc.body);
    for (const el of chain) {
      const name = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + ((el.getAttribute('class') || '').trim() ? '.' + (el.getAttribute('class') || '').trim().split(/\s+/).join('.') : '');
      const b = h('button', { class: 'ql-tag' + (el === d.selected ? ' ql-on' : ''), title: `<${name}>` }, `<${name}>`);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { d.select(el); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); d.select(el); this.app.ui.tagMenu(b); });
      const arrow = h('button', { class: 'ql-tag-arrow', 'aria-label': `Options for ${name}` }, icon('arrow_drop_down'));
      arrow.addEventListener('mousedown', (e) => e.preventDefault());
      arrow.addEventListener('click', () => { d.select(el); this.app.ui.tagMenu(arrow); });
      this.tagBar.append(h('span', { class: 'ql-tag-wrap' }, b, arrow));
    }
  }

  // ----------------------------------------------------------------------------------------
  // Synchronization

  private flushDesign = debounce(() => this.flush(), 250);
  private flushCode = debounce(() => this.flush(), 300);

  /** Writes pending view edits into the file now (commands call this before reading the source). */
  flush(): void {
    if (this.designDirty && this.design) {
      this.designDirty = false;
      const s = this.design.serialize();
      if (s) {
        const src = replaceBody(this.tab.source, s.inner, s.openTag);
        this.app.commit(this.tab, src, 'Typing', 'design');
      }
    }
    if (this.codePending != null) {
      const text = this.codePending;
      this.codePending = null;
      this.app.commit(this.tab, text, 'Edit Code', 'code');
    }
  }

  /** Called by App.commit after the file changed. */
  sourceChanged(origin: 'design' | 'code' | 'command' | 'history'): void {
    if (origin !== 'code') this.code?.setText(this.tab.source);
    if (origin !== 'design') {
      this.designStale = true;
      if (this.design && (this.tab.view === 'design' || this.tab.view === 'split')) {
        if (origin === 'code') this.reloadSoon(); else void this.reloadDesign();
      }
    }
    if (this.tab.view === 'preview') this.renderPreview();
    this.renderModeBar();
  }

  private reloadSoon = debounce(() => { if (this.designStale) void this.reloadDesign(); }, 700);

  /** The file changed through the site (another tab, a command on several files, a rename). */
  externalChange(): void {
    if (this.suppressExternal) return;
    if (this.code && this.code.text !== this.tab.source) this.code.setText(this.tab.source);
    this.code?.setLanguage(this.tab.path);
    this.designStale = true;
    if (this.tab.view === 'design' || this.tab.view === 'split') void this.reloadDesign();
    if (this.tab.view === 'preview') this.renderPreview();
  }

  private followSiteLink(href: string): void {
    const p = resolveRef(this.tab.path, href);
    if (p && this.app.site.has(p)) this.app.openFile(p);
    else if (/^https?:/i.test(href)) this.app.followLink(href);
  }

  /** Where commands that insert or format should act: Code view when it has focus, else Design view. */
  get target(): 'design' | 'code' {
    const v = this.tab.view;
    if (v === 'code' || !this.design) return 'code';
    if (v === 'design') return 'design';
    if (v === 'split') return this.focusArea;
    return 'code';
  }

  invalidate(): void { this.designStale = true; }
  focus(): void { if (this.target === 'code') this.code?.focus(); else this.design?.focus(); }
  destroy(): void { this.flush(); this.disposePreview(); this.code?.destroy(); this.design?.destroy(); }
}
