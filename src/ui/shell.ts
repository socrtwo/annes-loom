/**
 * Application shell: title bar, Quick Access Bar, classic menu bar, tabs + ribbon, document tabs,
 * left and right task panes, workspace and status bar.
 */
import type { App, PageTab } from '../app';
import { getCommand, allCommands, searchCommands, type Command, type MenuEntry } from '../commands/registry';
import { h, icon, clear, isPhone } from './dom';
import { showMenu, closeMenus, openDialog, toast } from './dialog';
import { DEFAULT_TABS, tabsFor, type RibbonTab } from './ribbonLayout';
import { CLASSIC_MENUS, type ClassicItem } from './classicMenus';
import { prettyKey, canonicalKey, keyName } from '../util/keys';
import { PANES, type PaneDef } from './panes';
import { customizeQat, customizeRibbon, customizeKeyboard } from './customize';
import { renderBackstage } from './backstage';
import { PageView } from '../editor/workspace';
import { QAT_STANDARD, QAT_EXTRAS } from '../prefs';
import { getDoctype, DOCTYPES } from '../model/html';

type Side = 'left' | 'right';

export class Shell {
  root: HTMLElement;
  titlebar!: HTMLElement;
  qatEl!: HTMLElement;
  qatBelow!: HTMLElement;
  qatBottom!: HTMLElement;
  menuBarEl!: HTMLElement;
  tabsEl!: HTMLElement;
  ribbonEl!: HTMLElement;
  docTabsEl!: HTMLElement;
  workspace!: HTMLElement;
  paneEls!: Record<Side, HTMLElement>;
  statusEl!: HTMLElement;
  backstageEl!: HTMLElement;
  titleBtn!: HTMLElement;
  emptyEl!: HTMLElement;
  currentTab = 'home';
  ribbonOpen = true;
  panes: Record<Side, { def: PaneDef; el: HTMLElement; opts: any } | null> = { left: null, right: null };
  statusMsg = '';
  private statusTimer: any;
  private lastContextual = '';

  constructor(public app: App) {
    this.root = app.host;
    this.build();
    this.applyPrefs();
    document.addEventListener('keydown', (e) => this.globalKey(e), true);
  }

  /** The right pane (the one most commands open), kept for code written against one pane. */
  get pane() { return this.panes.right || this.panes.left; }

  // ----------------------------------------------------------------------------------------
  // Layout

  build(): void {
    clear(this.root);
    this.root.className = 'ql-app';
    this.titlebar = h('header', { class: 'ql-titlebar' });
    const fileBtn = h('button', { class: 'ql-iconbtn ql-filebtn', title: 'File', 'aria-label': 'File menu', onclick: () => this.showBackstage() }, icon('menu'));
    this.qatEl = h('div', { class: 'ql-qat', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.titleBtn = h('button', { class: 'ql-title', title: 'Site and page properties', onclick: () => this.app.exec('file.pageProperties') }, 'QuillLoom');
    const search = h('button', { class: 'ql-iconbtn', title: 'Search commands (Alt+Q)', 'aria-label': 'Search commands', onclick: () => this.commandPalette() }, icon('search'));
    const preview = h('button', { class: 'ql-btn ql-present', title: 'Preview in Browser (F12)', onclick: () => this.app.exec('file.previewBrowser') }, icon('travel_explore'), h('span', { class: 'ql-present-label' }, ' Preview'));
    const publish = h('button', { class: 'ql-iconbtn', title: 'Publish Site', 'aria-label': 'Publish site', onclick: () => this.app.exec('site.publish') }, icon('cloud_upload'));
    const more = h('button', { class: 'ql-iconbtn', title: 'More', 'aria-label': 'More', onclick: (e: MouseEvent) => this.moreMenu(e.currentTarget as HTMLElement) }, icon('more_vert'));
    this.titlebar.append(fileBtn, this.qatEl, this.titleBtn, h('span', { class: 'ql-spacer' }), search, publish, preview, more);
    this.menuBarEl = h('nav', { class: 'ql-menubar', role: 'menubar', 'aria-label': 'Menu bar' });
    this.tabsEl = h('nav', { class: 'ql-tabs', role: 'tablist' });
    this.ribbonEl = h('div', { class: 'ql-ribbon', role: 'toolbar' });
    this.qatBelow = h('div', { class: 'ql-qat ql-qat-below', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.docTabsEl = h('div', { class: 'ql-doctabs' });
    this.workspace = h('div', { class: 'ql-workspace' });
    this.emptyEl = h('div', { class: 'ql-empty ql-hidden-tab' }, icon('web'), h('p', null, 'No file is open. Double-click a file in the Folder List, or create a page.'), h('button', { class: 'ql-btn', onclick: () => this.app.exec('file.newPage') }, 'New Page'));
    this.workspace.appendChild(this.emptyEl);
    this.paneEls = {
      left: h('aside', { class: 'ql-pane ql-pane-left', 'aria-hidden': 'true' }),
      right: h('aside', { class: 'ql-pane', 'aria-hidden': 'true' }),
    };
    const main = h('main', { class: 'ql-main' }, this.paneEls.left, h('div', { class: 'ql-center' }, this.docTabsEl, this.workspace), this.paneEls.right);
    this.qatBottom = h('div', { class: 'ql-qat ql-qat-bottom', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.statusEl = h('footer', { class: 'ql-status' });
    this.backstageEl = h('div', { class: 'ql-backstage', 'aria-hidden': 'true' });
    this.root.append(this.titlebar, this.menuBarEl, this.tabsEl, this.ribbonEl, this.qatBelow, main, this.qatBottom, this.statusEl, this.backstageEl, h('div', { class: 'ql-toasts' }));
    this.renderQat();
    this.renderMenuBar();
    this.renderTabs();
    this.renderRibbon();
  }

  rebuild(): void {
    this.renderQat();
    this.renderMenuBar();
    this.renderTabs();
    this.renderRibbon();
    this.refresh();
  }

  mountTab(tab: PageTab): void {
    const pv = new PageView(this.app, tab);
    tab.ui = pv;
    tab.el = h('div', { class: 'ql-doc' }, pv.el);
    this.workspace.appendChild(tab.el);
    this.emptyEl.classList.add('ql-hidden-tab');
    requestAnimationFrame(() => pv.layout());
  }

  showEmpty(): void { this.emptyEl.classList.remove('ql-hidden-tab'); }

  /** A new site was opened: redraw the panes that show it. */
  siteChanged(): void {
    for (const side of ['left', 'right'] as Side[]) { const p = this.panes[side]; if (p) { p.el.dataset.sig = ''; p.def.render(this.app, p.el, p.opts); } }
    if (!this.panes.left && this.app.prefs.startPanes.length) for (const id of this.app.prefs.startPanes) if (PANES[id]) this.openPane(id);
    this.titleBtn.textContent = this.app.site.name;
  }

  // ----------------------------------------------------------------------------------------
  // Quick Access Bar

  renderQat(): void {
    const pos = this.app.prefs.qatPosition;
    const target = pos === 'bottom' ? this.qatBottom : pos === 'below' ? this.qatBelow : this.qatEl;
    clear(this.qatEl); clear(this.qatBottom); clear(this.qatBelow);
    for (const id of this.app.prefs.qat) {
      if (id === '|') { target.appendChild(h('span', { class: 'ql-qat-sep' })); continue; }
      const c = getCommand(id);
      if (!c) continue;
      target.appendChild(this.commandButton(c, 'qat'));
    }
    target.appendChild(h('button', { class: 'ql-iconbtn ql-qat-customize', title: 'Customize Quick Access Bar', 'aria-label': 'Customize Quick Access Bar', onclick: (e: MouseEvent) => this.qatMenu(e.currentTarget as HTMLElement) }, icon('arrow_drop_down')));
  }

  qatMenu(anchor: HTMLElement): void {
    const q = this.app.prefs.qat;
    const item = (id: string) => ({ id, label: getCommand(id)?.label || id, checked: q.includes(id), arg: '__toggle' });
    const present = (id: string) => !!getCommand(id);
    const pos = this.app.prefs.qatPosition;
    showMenu([
      { heading: 'Customize Quick Access Bar' },
      ...QAT_STANDARD.filter(present).map(item),
      { separator: true },
      ...QAT_EXTRAS.filter(present).map(item),
      { separator: true },
      { id: '__addAll', label: 'Add All Choices (Save, Print, then A–Z)', icon: 'sort_by_alpha' },
      { id: '__more', label: 'More Commands…', icon: 'library_add' },
      ...(pos !== 'top' ? [{ id: '__pos', arg: 'top', label: 'Show Above the Ribbon', icon: 'vertical_align_top' }] : []),
      ...(pos !== 'below' ? [{ id: '__pos', arg: 'below', label: 'Show Below the Ribbon', icon: 'vertical_align_center' }] : []),
      ...(pos !== 'bottom' ? [{ id: '__pos', arg: 'bottom', label: 'Show at the Bottom (near keyboard)', icon: 'vertical_align_bottom' }] : []),
      { id: '__labels', label: this.app.prefs.qatLabels ? 'Hide Command Labels' : 'Show Command Labels', icon: 'label' },
      { id: '__hide', label: 'Hide Quick Access Bar', icon: 'visibility_off' },
      { id: '__ribbon', label: this.app.prefs.ribbon === 'full' ? 'Collapse the Ribbon' : 'Show the Ribbon', icon: 'expand_less' },
    ], {
      anchor, onPick: (e) => {
        const p = this.app.prefs;
        if (e.arg === '__toggle' && e.id) { p.qat = q.includes(e.id) ? q.filter((x) => x !== e.id) : [...q, e.id]; }
        else if (e.id === '__addAll') { this.app.exec('view.qatAddAll'); return; }
        else if (e.id === '__more') { this.customizeQat(); return; }
        else if (e.id === '__pos') { this.app.exec('view.qatPosition', e.arg); return; }
        else if (e.id === '__labels') p.qatLabels = !p.qatLabels;
        else if (e.id === '__hide') { p.qatHidden = true; toast('Quick Access Bar hidden. Show it again from View ▸ Show Quick Access Bar or by long-pressing any ribbon command.', { ms: 5000 }); }
        else if (e.id === '__ribbon') p.ribbon = p.ribbon === 'full' ? 'tabs' : 'full';
        this.app.savePrefs();
        this.applyPrefs();
        this.renderQat();
        this.refresh();
      },
    });
  }

  // ----------------------------------------------------------------------------------------
  // Classic menu bar

  renderMenuBar(): void {
    clear(this.menuBarEl);
    const menus = CLASSIC_MENUS[this.app.prefs.classicMenus] || CLASSIC_MENUS.expression;
    for (const m of menus) {
      const b = h('button', { class: 'ql-menubar-item', role: 'menuitem', 'aria-haspopup': 'true' }, m.label);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.openClassicMenu(m.items, b));
      b.addEventListener('mouseenter', () => { if (document.querySelector('.ql-menu[data-classic]')) this.openClassicMenu(m.items, b); });
      this.menuBarEl.appendChild(b);
    }
  }

  private classicEntries(items: ClassicItem[]): MenuEntry[] {
    const out: MenuEntry[] = [];
    for (const it of items) {
      if (it === '|') { if (out.length && !out[out.length - 1].separator) out.push({ separator: true }); continue; }
      if (typeof it === 'string') {
        const c = getCommand(it);
        if (!c) continue;
        let checked: boolean | undefined;
        try { checked = c.kind === 'toggle' ? !!c.isActive?.(this.app) : undefined; } catch { /* */ }
        if (c.kind === 'menu' && c.menu) { out.push({ label: c.label, icon: c.icon, submenu: c.menu(this.app) }); continue; }
        out.push({ id: it, label: c.label + (c.keys?.[0] ? `\t${prettyKey(c.keys[0])}` : ''), icon: c.icon, checked });
        continue;
      }
      const sub = this.classicEntries(it.items);
      if (sub.length) out.push({ label: it.label, icon: it.icon, submenu: sub });
    }
    while (out.length && out[out.length - 1].separator) out.pop();
    return out;
  }

  private openClassicMenu(items: ClassicItem[], anchor: HTMLElement): void {
    closeMenus();
    const m = showMenu(this.classicEntries(items), { anchor, onPick: (e) => { if (e.id) { const c = getCommand(e.id); if (c?.kind === 'menu' && e.id === c.id && e.arg === undefined) this.openCommandMenu(c, this.anchorFor(c.id)); else this.app.exec(e.id, e.arg); setTimeout(() => this.app.focus(), 0); } } });
    m.dataset.classic = '1';
  }

  // ----------------------------------------------------------------------------------------
  // Tabs and ribbon

  renderTabs(): void {
    clear(this.tabsEl);
    this.tabsEl.appendChild(h('button', { class: 'ql-tab ql-tab-file', role: 'tab', onclick: () => this.showBackstage() }, 'File'));
    for (const t of tabsFor(this.app)) {
      const b = h('button', { class: 'ql-tab' + (t.contextual ? ' ql-contextual' : '') + (t.id === this.currentTab ? ' ql-active' : ''), role: 'tab', 'data-tab': t.id, style: t.accent ? `--tab-accent:${t.accent}` : '' }, t.label);
      b.addEventListener('click', () => {
        if (this.currentTab === t.id && this.app.prefs.ribbon !== 'hidden') { this.ribbonOpen = !this.ribbonOpen; this.root.classList.toggle('ql-ribbon-closed', !this.ribbonOpen); return; }
        this.currentTab = t.id; this.ribbonOpen = true; this.root.classList.remove('ql-ribbon-closed');
        this.renderTabs(); this.renderRibbon(); this.refresh();
        b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      });
      b.addEventListener('dblclick', () => { this.app.exec('view.collapseRibbon'); });
      this.tabsEl.appendChild(b);
    }
  }

  ribbonTab(): RibbonTab {
    return tabsFor(this.app).find((t) => t.id === this.currentTab) || DEFAULT_TABS[0];
  }

  renderRibbon(): void {
    clear(this.ribbonEl);
    const tab = this.ribbonTab();
    for (const g of tab.groups) {
      const items = h('div', { class: 'ql-group-items' });
      for (const id of g.items) {
        const c = getCommand(id);
        if (!c) continue;
        items.appendChild(this.ribbonItem(c));
      }
      if (!items.children.length) continue;
      const label = h('div', { class: 'ql-group-label' }, g.label, g.launcher ? h('button', { class: 'ql-launcher', title: `${g.label} settings`, 'aria-label': `${g.label} settings`, onclick: () => this.app.exec(g.launcher!) }, icon('open_in_new')) : null);
      this.ribbonEl.appendChild(h('section', { class: 'ql-group', 'data-group': g.id }, items, label));
    }
    this.ribbonEl.scrollLeft = 0;
  }

  ribbonItem(c: Command): HTMLElement {
    switch (c.kind) {
      case 'font': return this.fontBox(c);
      case 'size': return this.sizeBox(c);
      case 'gallery': return this.gallery(c);
      case 'combo': case 'style': return this.comboBox(c);
      default: return this.commandButton(c, 'ribbon');
    }
  }

  commandButton(c: Command, where: 'ribbon' | 'qat' | 'mini'): HTMLElement {
    const showLabel = where === 'ribbon' || (where === 'qat' && this.app.prefs.qatLabels);
    const key = c.keys?.[0] ? ` (${prettyKey(c.keys[0])})` : '';
    const main = h('button', { class: 'ql-cmd', 'data-cmd': c.id, title: (c.tip ? `${c.label}: ${c.tip}` : c.label) + key, 'aria-label': c.label, type: 'button' }, icon(c.icon), showLabel ? h('span', { class: 'ql-cmd-label' }, c.label.replace(/…$/, '')) : null);
    if (c.kind === 'color') main.appendChild(h('span', { class: 'ql-colorbar' }));
    let longPress: any;
    main.addEventListener('pointerdown', () => { longPress = setTimeout(() => { longPress = 'fired'; this.longPress(c, main); }, 550); });
    main.addEventListener('pointerup', () => { if (longPress !== 'fired') clearTimeout(longPress); });
    main.addEventListener('pointerleave', () => { if (longPress !== 'fired') clearTimeout(longPress); });
    main.addEventListener('contextmenu', (e) => { e.preventDefault(); this.longPress(c, main); });
    main.addEventListener('click', () => {
      if (longPress === 'fired') { longPress = null; return; }
      if (c.kind === 'menu') { this.openCommandMenu(c, main); return; }
      this.app.exec(c.id);
      if (where !== 'qat' && !['menu', 'split', 'color'].includes(c.kind || '')) setTimeout(() => this.app.focus(), 0);
    });
    main.addEventListener('mousedown', (e) => e.preventDefault());
    if (c.kind === 'menu') main.appendChild(icon('arrow_drop_down', 'ql-caret'));
    if (c.kind === 'split' || c.kind === 'color') {
      const arrow = h('button', { class: 'ql-split-arrow', type: 'button', title: `${c.label} options`, 'aria-label': `${c.label} options` }, icon('arrow_drop_down'));
      arrow.addEventListener('mousedown', (e) => e.preventDefault());
      arrow.addEventListener('click', () => (c.kind === 'color' ? this.app.exec(c.id, 'menu') : this.openCommandMenu(c, wrap)));
      const wrap = h('span', { class: 'ql-split', 'data-cmd-wrap': c.id }, main, arrow);
      return wrap;
    }
    return main;
  }

  longPress(c: Command, el: HTMLElement): void {
    const inQat = this.app.prefs.qat.includes(c.id);
    showMenu([
      { id: '__qat', label: inQat ? 'Remove from Quick Access Bar' : 'Add to Quick Access Bar', icon: inQat ? 'remove_circle' : 'add_circle' },
      { id: '__customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune' },
      ...(this.app.prefs.qatHidden ? [{ id: '__showQat', label: 'Show Quick Access Bar', icon: 'bolt' }] : []),
      { id: '__key', label: 'Assign Shortcut…', icon: 'keyboard' },
      { id: '__ribbon', label: this.app.prefs.ribbon === 'full' ? 'Collapse the Ribbon' : 'Show the Ribbon', icon: 'expand_less' },
      { id: '__info', label: `About: ${c.label}`, icon: 'info' },
    ], {
      anchor: el, onPick: (e) => {
        if (e.id === '__qat') { this.app.prefs.qat = inQat ? this.app.prefs.qat.filter((x) => x !== c.id) : [...this.app.prefs.qat, c.id]; this.app.savePrefs(); this.renderQat(); this.refresh(); toast(inQat ? 'Removed from Quick Access Bar' : 'Added to Quick Access Bar'); }
        if (e.id === '__customizeQat') this.customizeQat();
        if (e.id === '__showQat') this.app.exec('view.qatShow');
        if (e.id === '__key') this.customizeKeyboard(c.id);
        if (e.id === '__ribbon') this.app.exec('view.collapseRibbon');
        if (e.id === '__info') toast(`${c.label} — ${c.tab}${c.group ? ' ▸ ' + c.group : ''}${c.keys?.length ? ' — ' + c.keys.map(prettyKey).join(', ') : ''}${c.origin ? ' — from ' + c.origin : ''}`, { ms: 5000 });
      },
    });
  }

  openCommandMenu(c: Command, anchor: HTMLElement): void {
    const entries = c.menu ? c.menu(this.app) : [];
    showMenu(entries, { anchor, onPick: (e) => this.pickEntry(c, e) });
  }

  pickEntry(c: Command, e: MenuEntry): void {
    if (!e.id) return;
    if (e.id === c.id) this.app.exec(c.id, e.arg);
    else this.app.exec(e.id, e.arg);
    setTimeout(() => this.app.focus(), 0);
  }

  fontBox(c: Command): HTMLElement {
    const b = h('button', { class: 'ql-combo ql-fontbox', 'data-cmd': c.id, 'data-combo': c.id, title: c.label, type: 'button' }, h('span', { class: 'ql-combo-text' }, 'Font'), icon('arrow_drop_down'));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const entries = c.menu ? c.menu(this.app) : [];
      const input = h('input', { class: 'ql-menu-search', placeholder: 'Search fonts or type a font stack…' }) as HTMLInputElement;
      const m = showMenu(entries, { anchor: b, onPick: (e) => { this.app.exec(c.id, e.arg); this.app.focus(); }, className: 'ql-font-menu' });
      m.prepend(input);
      input.addEventListener('input', () => {
        const q = input.value.toLowerCase();
        m.querySelectorAll<HTMLElement>('.ql-menu-item').forEach((it) => { it.style.display = it.textContent!.toLowerCase().includes(q) ? '' : 'none'; });
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value) { closeMenus(); this.app.exec(c.id, input.value); this.app.focus(); } });
      setTimeout(() => { if (!isPhone()) input.focus(); }, 20);
    });
    return b;
  }

  sizeBox(c: Command): HTMLElement {
    const wrap = h('span', { class: 'ql-sizebox', 'data-cmd-wrap': c.id });
    const input = h('input', { class: 'ql-size-input', 'data-combo': c.id, 'aria-label': c.label, title: c.label }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) this.app.exec(c.id, input.value.trim()); this.app.focus(); }
      if (e.key === 'Escape') this.app.focus();
    });
    const arrow = h('button', { class: 'ql-split-arrow', type: 'button', 'aria-label': `${c.label} list` }, icon('arrow_drop_down'));
    arrow.addEventListener('mousedown', (e) => e.preventDefault());
    arrow.addEventListener('click', () => { if (c.menu) this.openCommandMenu(c, wrap); else this.app.exec(c.id); });
    wrap.append(input, arrow);
    return wrap;
  }

  comboBox(c: Command): HTMLElement {
    const b = h('button', { class: 'ql-combo ql-wide-combo', 'data-cmd': c.id, 'data-combo': c.id, title: c.label, type: 'button' }, h('span', { class: 'ql-combo-text' }, c.label), icon('arrow_drop_down'));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => this.openCommandMenu(c, b));
    return b;
  }

  gallery(c: Command): HTMLElement {
    const wrap = h('div', { class: 'ql-gallery', 'data-gallery': c.id });
    const strip = h('div', { class: 'ql-gallery-strip' });
    const more = h('button', { class: 'ql-gallery-more', title: 'More', 'aria-label': `More ${c.label}` }, icon('expand_more'));
    more.addEventListener('mousedown', (e) => e.preventDefault());
    more.addEventListener('click', () => this.openCommandMenu(c, wrap));
    wrap.append(strip, more);
    return wrap;
  }

  fillGalleries(): void {
    this.ribbonEl.querySelectorAll<HTMLElement>('[data-gallery]').forEach((wrap) => {
      const id = wrap.dataset.gallery!;
      const c = getCommand(id);
      if (!c?.menu) return;
      const strip = wrap.querySelector('.ql-gallery-strip')!;
      const entries = c.menu(this.app).filter((e) => !e.heading && !e.separator).slice(0, 12);
      const sig = JSON.stringify(entries.map((e) => [e.label, e.checked, e.preview, e.swatch]));
      if (strip.getAttribute('data-sig') === sig) return;
      strip.setAttribute('data-sig', sig);
      clear(strip as HTMLElement);
      for (const e of entries) {
        const chip = h('button', { class: 'ql-gallery-item' + (e.checked ? ' ql-on' : ''), title: e.label || '', type: 'button' }, e.icon ? icon(e.icon) : null, h('span', { style: e.preview || '' }, e.label || ''));
        chip.addEventListener('mousedown', (ev) => ev.preventDefault());
        chip.addEventListener('click', () => { this.app.exec(e.id || id, e.arg); this.app.focus(); });
        strip.appendChild(chip);
      }
    });
  }

  // ----------------------------------------------------------------------------------------
  // Refresh (state → UI)

  refresh(): void {
    const app = this.app;
    const sig = DEFAULT_TABS.filter((t) => t.contextual).map((t) => { try { return t.contextual!(app) ? 1 : 0; } catch { return 0; } }).join('');
    if (sig !== this.lastContextual) {
      this.lastContextual = sig;
      for (const t of DEFAULT_TABS.filter((x) => x.contextual)) {
        let show = false;
        try { show = t.contextual!(app); } catch { /* */ }
        if (!show && this.currentTab === t.id) { this.currentTab = 'home'; this.renderRibbon(); }
      }
      this.renderTabs();
    }
    for (const t of DEFAULT_TABS.filter((x) => x.contextual)) {
      const el = this.tabsEl.querySelector<HTMLElement>(`[data-tab="${t.id}"]`);
      let show = false;
      try { show = t.contextual!(app); } catch { /* */ }
      if (el) el.style.display = show ? '' : 'none';
    }
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-cmd]')) {
      const c = getCommand(b.dataset.cmd!);
      if (!c) continue;
      let active = false, enabled = true;
      try { active = !!c.isActive?.(app); enabled = c.isEnabled ? c.isEnabled(app) : true; } catch { /* */ }
      b.classList.toggle('ql-on', active);
      b.setAttribute('aria-pressed', String(active));
      b.classList.toggle('ql-disabled', !enabled);
    }
    this.root.querySelectorAll<HTMLInputElement>('input[data-combo]').forEach((inp) => {
      if (document.activeElement === inp) return;
      const c = getCommand(inp.dataset.combo!);
      let v: any = null;
      try { v = c?.value?.(app); } catch { /* */ }
      inp.value = v != null ? String(v) : '';
    });
    this.root.querySelectorAll<HTMLElement>('button[data-combo]').forEach((b) => {
      const c = getCommand(b.dataset.combo!);
      let v: any = null;
      try { v = c?.value?.(app); } catch { /* */ }
      const t = b.querySelector<HTMLElement>('.ql-combo-text');
      if (t) { t.textContent = v != null && v !== '' ? String(v) : c?.label || ''; if (c?.kind === 'font') t.style.fontFamily = v ? String(v) : ''; }
    });
    this.fillGalleries();
    this.renderStatus();
    for (const side of ['left', 'right'] as Side[]) { const p = this.panes[side]; if (p?.def.update) try { p.def.update(app, p.el, p.opts); } catch (e) { console.error(e); } }
    this.titleBtn.textContent = app.site.name + (app.siteDirty ? ' •' : '');
  }

  // ----------------------------------------------------------------------------------------
  // Status bar

  renderStatus(): void {
    const app = this.app;
    const tab = app.active;
    clear(this.statusEl);
    const item = (text: string, onclick?: () => void, title?: string, cls = '') => h('button', { class: 'ql-status-item ' + cls, onclick, title: title || text, type: 'button' }, text);
    this.statusEl.appendChild(item(app.site.name, () => app.exec('site.settings'), 'Site settings'));
    if (tab) {
      this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, tab.path));
      if (tab.ui?.code && tab.ui.target === 'code') { const c = tab.ui.code.cursor(); this.statusEl.appendChild(item(`Ln ${c.line}, Col ${c.col}`, () => app.exec('edit.goToLine'), 'Go to line')); }
      if (tab.kind === 'page') {
        const dt = getDoctype(tab.source);
        this.statusEl.appendChild(item(DOCTYPES.find((d) => d.id === dt)?.label || 'Custom DOCTYPE', () => app.exec('format.doctype'), 'Document type (click to change)'));
        const el = tab.ui?.design?.selected;
        if (el && tab.ui.target === 'design') this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, `<${el.tagName.toLowerCase()}>`));
      }
      this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, `${(new Blob([tab.source]).size / 1024).toFixed(1)} KB`));
      if (tab.readOnly) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, 'Read-only'));
      if (app.site.get(tab.path)?.checkedOut) this.statusEl.appendChild(h('span', { class: 'ql-status-msg', title: 'Checked out' }, '✓ Checked out'));
    }
    if (app.recording) this.statusEl.appendChild(item(app.recordingPaused ? '⏸ Paused' : '● REC', () => app.exec('dev.stopRecording'), 'Stop recording macro', 'ql-status-rec'));
    if (this.statusMsg) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, this.statusMsg));
    this.statusEl.appendChild(h('span', { class: 'ql-spacer' }));
    this.statusEl.appendChild(item(`CSS: ${app.prefs.cssMode === 'auto' ? 'Auto' : app.prefs.cssMode === 'inline' ? 'Inline' : app.prefs.cssMode === 'class' ? 'Classes' : 'Tags'}`, () => app.exec('format.cssMode', 'menu'), 'Style application mode'));
    this.statusEl.appendChild(h('button', { class: 'ql-iconbtn ql-status-view' + (this.paneOpen('folders') ? ' ql-on' : ''), title: 'Folder List', 'aria-label': 'Folder List', onclick: () => app.exec('panel.folders') }, icon('folder')));
    this.statusEl.appendChild(h('button', { class: 'ql-iconbtn ql-status-view' + (app.prefs.aidBlocks ? ' ql-on' : ''), title: 'Visual Aids: Block Outlines', 'aria-label': 'Block outlines', onclick: () => app.exec('view.aidBlocks') }, icon('border_outer')));
    if (tab?.kind === 'page' || tab?.kind === 'text') {
      const views: [string, string, string][] = tab.kind === 'page' ? [['design', 'draw', 'Design'], ['split', 'vertical_split', 'Split'], ['code', 'code', 'Code'], ['preview', 'visibility', 'Preview']] : [['code', 'code', 'Code'], ['preview', 'visibility', 'Preview']];
      for (const [m, ic, l] of views) this.statusEl.appendChild(h('button', { class: 'ql-iconbtn ql-status-view' + (tab.view === m ? ' ql-on' : ''), title: `${l} view`, 'aria-label': `${l} view`, onclick: () => app.exec(`view.${m}`) }, icon(ic)));
    }
    if (tab?.ui?.design) {
      const z = tab.ui.design.zoom;
      this.statusEl.append(
        h('button', { class: 'ql-iconbtn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => app.exec('view.zoomOut') }, icon('remove')),
        h('button', { class: 'ql-status-item ql-zoom', title: 'Zoom…', onclick: () => app.exec('view.zoom') }, `${Math.round(z * 100)}%`),
        h('button', { class: 'ql-iconbtn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => app.exec('view.zoomIn') }, icon('add')));
    }
  }

  status(msg: string): void {
    this.statusMsg = msg;
    clearTimeout(this.statusTimer);
    if (msg && !msg.startsWith('●')) this.statusTimer = setTimeout(() => { this.statusMsg = ''; this.renderStatus(); }, 3000);
    this.renderStatus();
  }

  // ----------------------------------------------------------------------------------------
  // Document tabs strip

  tabsChanged(): void {
    const app = this.app;
    clear(this.docTabsEl);
    this.root.classList.toggle('ql-multi-doc', app.docs.length > 1);
    for (const d of app.docs) {
      const t = h('div', { class: 'ql-doctab' + (d === app.active ? ' ql-active' : ''), role: 'tab', title: d.path },
        h('button', { class: 'ql-doctab-name', onclick: () => app.activate(d) }, d.displayName + (d.dirty ? ' •' : '')),
        h('button', { class: 'ql-doctab-close', 'aria-label': `Close ${d.displayName}`, onclick: () => { app.activate(d); app.exec('file.close', d.id); } }, icon('close')));
      this.docTabsEl.appendChild(t);
    }
    this.docTabsEl.appendChild(h('button', { class: 'ql-iconbtn', title: 'New page', 'aria-label': 'New page', onclick: () => app.exec('file.newPage') }, icon('add')));
    this.titleBtn.textContent = app.site.name + (app.siteDirty ? ' •' : '');
  }

  moreMenu(anchor: HTMLElement): void {
    const app = this.app;
    showMenu([
      { id: 'file.save', label: 'Save', icon: 'save' }, { id: 'file.saveAll', label: 'Save All', icon: 'save' }, { id: 'site.publish', label: 'Publish Site…', icon: 'cloud_upload' },
      { separator: true },
      { id: 'panel.folders', label: 'Folder List', icon: 'folder' }, { id: 'panel.cssProperties', label: 'CSS Properties', icon: 'css' }, { id: 'edit.find', label: 'Find & Replace', icon: 'search' },
      { separator: true },
      { id: 'view.menuStyle', label: 'Menus: Ribbon / Classic / Both…', icon: 'menu_open' },
      { id: 'file.customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune' }, { id: 'file.customizeRibbon', label: 'Customize Tabs…', icon: 'view_quilt' },
      { id: 'file.customizeKeyboard', label: 'Customize Keyboard…', icon: 'keyboard' }, { id: 'file.options', label: 'Options…', icon: 'settings' },
      { id: 'help.about', label: 'About', icon: 'info' },
    ], { anchor, onPick: (e) => e.id && app.exec(e.id, e.arg) });
  }

  // ----------------------------------------------------------------------------------------
  // Panes (left: site panels; right: properties, styles and tools)

  openPane(id: string, opts: any = {}): void {
    const def = PANES[id];
    if (!def) { toast(`Unknown pane ${id}`); return; }
    const side: Side = def.side || 'right';
    const cur = this.panes[side];
    if (cur?.def.id === id) { cur.opts = opts; def.update?.(this.app, cur.el, opts); def.onOpen?.(this.app, cur.el, opts); return; }
    this.closePane(side);
    const el = this.paneEls[side];
    const body = h('div', { class: 'ql-pane-body' });
    const head = h('div', { class: 'ql-pane-head' }, h('h2', null, def.title), h('button', { class: 'ql-iconbtn', 'aria-label': 'Close pane', onclick: () => this.closePane(side) }, icon('close')));
    clear(el);
    el.append(head, body);
    el.setAttribute('aria-hidden', 'false');
    this.root.classList.add(side === 'left' ? 'ql-lpane-open' : 'ql-pane-open');
    this.panes[side] = { def, el: body, opts };
    def.render(this.app, body, opts);
    def.onOpen?.(this.app, body, opts);
    this.refresh();
    requestAnimationFrame(() => this.app.active?.ui.layout());
  }

  closePane(side?: Side): void {
    const sides: Side[] = side ? [side] : this.panes.right ? ['right'] : ['left'];
    for (const s of sides) {
      const p = this.panes[s];
      if (!p) continue;
      p.def.onClose?.(this.app);
      this.panes[s] = null;
      clear(this.paneEls[s]);
      this.paneEls[s].setAttribute('aria-hidden', 'true');
      this.root.classList.remove(s === 'left' ? 'ql-lpane-open' : 'ql-pane-open');
    }
    this.app.refresh();
  }

  togglePane(id: string, opts?: any): void {
    const side: Side = PANES[id]?.side || 'right';
    if (this.panes[side]?.def.id === id) this.closePane(side); else this.openPane(id, opts);
  }
  paneOpen(id: string): boolean { return this.panes.left?.def.id === id || this.panes.right?.def.id === id; }

  // ----------------------------------------------------------------------------------------
  // Backstage

  showBackstage(page = 'home'): void {
    closeMenus();
    this.app.active?.ui.flush();
    this.backstageEl.setAttribute('aria-hidden', 'false');
    this.root.classList.add('ql-backstage-open');
    renderBackstage(this.app, this.backstageEl, page);
  }
  hideBackstage(): void {
    this.backstageEl.setAttribute('aria-hidden', 'true');
    this.root.classList.remove('ql-backstage-open');
    clear(this.backstageEl);
  }

  customizeQat(): void { customizeQat(this.app); }
  customizeRibbon(): void { customizeRibbon(this.app); }
  customizeKeyboard(id?: string): void { customizeKeyboard(this.app, id); }

  // ----------------------------------------------------------------------------------------
  // Command palette

  commandPalette(): void {
    const app = this.app;
    const overlay = h('div', { class: 'ql-overlay ql-palette-overlay' });
    const input = h('input', { class: 'ql-palette-input', placeholder: `Search ${allCommands().length} commands… (e.g. "hyperlink", "publish", "wordpress")`, 'aria-label': 'Search commands' }) as HTMLInputElement;
    const list = h('div', { class: 'ql-palette-list', role: 'listbox' });
    const box = h('div', { class: 'ql-palette', role: 'dialog' }, input, list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    let results: Command[] = [];
    let sel = 0;
    const close = () => { overlay.remove(); app.focus(); };
    const run = (c: Command) => { close(); if (c.kind === 'menu' && c.menu) this.openCommandMenu(c, this.anchorFor(c.id)); else app.exec(c.id); };
    const draw = () => {
      clear(list);
      const q = input.value.trim();
      results = q ? searchCommands(q, 80) : [...app.prefs.pinnedCommands.map((id) => getCommand(id)!).filter(Boolean), ...allCommands().filter((c) => c.popular).slice(0, 40)];
      results.forEach((c, i) => {
        const pinned = app.prefs.qat.includes(c.id);
        const row = h('div', { class: 'ql-palette-row' + (i === sel ? ' ql-sel' : ''), role: 'option' },
          icon(c.icon), h('span', { class: 'ql-palette-label' }, c.label), h('span', { class: 'ql-palette-tab' }, `${c.tab === 'Backstage' ? 'File' : c.tab}${c.group ? ' ▸ ' + c.group : ''}`),
          c.keys?.[0] ? h('kbd', null, prettyKey(c.keys[0])) : null,
          h('button', { class: 'ql-iconbtn ql-palette-pin', title: pinned ? 'Remove from Quick Access Bar' : 'Add to Quick Access Bar', onclick: (e: Event) => { e.stopPropagation(); app.prefs.qat = pinned ? app.prefs.qat.filter((x) => x !== c.id) : [...app.prefs.qat, c.id]; app.savePrefs(); this.renderQat(); draw(); } }, icon(pinned ? 'push_pin' : 'keep')));
        row.addEventListener('click', () => run(c));
        list.appendChild(row);
      });
      if (!results.length) list.appendChild(h('div', { class: 'ql-help' }, 'No matching commands.'));
    };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      if (e.key === 'Enter' && results[sel]) { e.preventDefault(); run(results[sel]); }
      if (e.key === 'Escape') close();
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    draw();
    setTimeout(() => input.focus(), 20);
  }

  // ----------------------------------------------------------------------------------------
  // Context menus

  designContextMenu(x: number, y: number, el: Element | null): void {
    const app = this.app;
    const tag = el?.tagName.toLowerCase() || '';
    const entries: MenuEntry[] = [
      { id: 'edit.cut', label: 'Cut', icon: 'content_cut' }, { id: 'edit.copy', label: 'Copy', icon: 'content_copy' }, { id: 'edit.paste', label: 'Paste', icon: 'content_paste' }, { id: 'edit.pasteText', label: 'Paste Text', icon: 'content_paste_go' },
      { separator: true },
    ];
    if (el?.closest('a')) entries.push({ id: 'insert.hyperlink', label: 'Hyperlink Properties…', icon: 'link' }, { id: 'format.removeLink', label: 'Remove Hyperlink', icon: 'link_off' }, { id: 'edit.followLink', label: 'Follow Hyperlink', icon: 'open_in_new' });
    else entries.push({ id: 'insert.hyperlink', label: 'Hyperlink…', icon: 'link' });
    if (tag === 'img') entries.push({ id: 'picture.properties', label: 'Picture Properties…', icon: 'image' }, { id: 'picture.autoThumbnail', label: 'Auto Thumbnail', icon: 'photo_size_select_small' }, { id: 'picture.hotspot', label: 'Image Map Hotspot…', icon: 'ads_click' });
    if (el?.closest('td,th')) entries.push({ label: 'Table', icon: 'table', submenu: [
      { id: 'table.insertRowAbove', label: 'Insert Row Above' }, { id: 'table.insertRowBelow', label: 'Insert Row Below' }, { id: 'table.insertColLeft', label: 'Insert Column to the Left' }, { id: 'table.insertColRight', label: 'Insert Column to the Right' },
      { separator: true }, { id: 'table.deleteRows', label: 'Delete Rows' }, { id: 'table.deleteCols', label: 'Delete Columns' }, { id: 'table.mergeCells', label: 'Merge Cells' }, { id: 'table.splitCells', label: 'Split Cells…' },
      { separator: true }, { id: 'table.cellProperties', label: 'Cell Properties…' }, { id: 'table.properties', label: 'Table Properties…' }] });
    if (el?.closest('form')) entries.push({ id: 'form.properties', label: 'Form Properties…', icon: 'dynamic_form' });
    if (el && /^(input|select|textarea|button)$/.test(tag)) entries.push({ id: 'form.fieldProperties', label: 'Form Field Properties…', icon: 'input' });
    entries.push(
      { separator: true },
      { id: 'tag.properties', label: 'Tag Properties…', icon: 'tune' },
      { id: 'tag.edit', label: 'Edit Tag…', icon: 'edit_note' },
      { id: 'format.style', label: 'Style…', icon: 'style' },
      { id: 'format.newStyleFromSelection', label: 'New Style from Selection…', icon: 'add_box' },
      { id: 'format.position', label: 'Position…', icon: 'open_with' },
      { id: 'behavior.add', label: 'Add Behavior…', icon: 'bolt' },
      { separator: true },
      { id: 'tag.selectParent', label: 'Select Parent Tag', icon: 'north_west' },
      { id: 'tag.remove', label: 'Remove Tag', icon: 'backspace' },
      { id: 'view.selectInCode', label: 'Select in Code View', icon: 'code' },
      { id: 'file.pageProperties', label: 'Page Properties…', icon: 'description' },
    );
    showMenu(entries, { x, y, onPick: (en) => { if (en.id) app.exec(en.id, en.arg); } });
  }

  /** The Quick Tag Selector drop-down. */
  tagMenu(anchor: HTMLElement): void {
    const app = this.app;
    showMenu([
      { id: 'tag.select', label: 'Select Tag', icon: 'select_all' }, { id: 'tag.selectContents', label: 'Select Tag Contents', icon: 'text_select_start' },
      { id: 'tag.edit', label: 'Edit Tag…', icon: 'edit_note' }, { id: 'tag.remove', label: 'Remove Tag', icon: 'backspace' },
      { id: 'tag.insertHtml', label: 'Insert HTML…', icon: 'html' }, { id: 'tag.wrap', label: 'Wrap Tag…', icon: 'wrap_text' },
      { separator: true }, { id: 'tag.properties', label: 'Tag Properties…', icon: 'tune' }, { id: 'panel.cssProperties', label: 'CSS Properties', icon: 'css' },
      { id: 'tag.positioning', label: 'Positioning…', icon: 'open_with' },
    ], { anchor, onPick: (e) => e.id && app.exec(e.id, e.arg) });
  }

  // ----------------------------------------------------------------------------------------

  anchorFor(id: string): HTMLElement {
    const els = [...this.root.querySelectorAll<HTMLElement>(`[data-cmd-wrap="${id}"], [data-cmd="${id}"]`)].filter((e) => e.offsetParent);
    return els[0] || this.ribbonEl;
  }

  applyPrefs(): void {
    const p = this.app.prefs;
    const dark = p.theme === 'dark' || (p.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    this.root.classList.toggle('ql-ribbon-collapsed', p.ribbon !== 'full');
    this.root.classList.toggle('ql-qat-at-bottom', p.qatPosition === 'bottom');
    this.root.classList.toggle('ql-qat-below-ribbon', p.qatPosition === 'below');
    this.root.classList.toggle('ql-qat-hidden', p.qatHidden);
    this.root.classList.toggle('ql-touch', p.touchMode);
    this.root.classList.toggle('ql-high-contrast', p.highContrastUI);
    this.root.classList.toggle('ql-no-ribbon', p.menuStyle === 'classic');
    this.root.classList.toggle('ql-no-menubar', p.menuStyle === 'ribbon');
    this.root.style.setProperty('--ql-ui-scale', String(p.uiScale || 1));
    if (!this.app.docs.length) return;
    this.renderQat();
    this.renderMenuBar();
    for (const d of this.app.docs) { d.ui.applyDesignPrefs(); d.ui.layout(); }
    this.refresh();
  }

  /** Keys typed inside the Design view frame. Returns true when a command handled the key. */
  frameKey(e: KeyboardEvent): boolean {
    const k = keyName(e);
    if (!k) return false;
    const id = this.app.keyIndex.get(canonicalKey(k));
    if (!id) return false;
    // Plain typing keys and native editing keys stay with the editor.
    if (!(e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key))) return false;
    if (id === 'edit.selectAll' || id === 'edit.copy' || id === 'edit.cut' || id === 'edit.paste') return false;
    this.app.exec(id);
    return true;
  }

  globalKey(e: KeyboardEvent): void {
    const k = keyName(e);
    if (!k) return;
    if (e.key === 'Escape') {
      if (document.querySelector('.ql-menu')) { closeMenus(); return; }
      if (this.root.classList.contains('ql-backstage-open')) { this.hideBackstage(); return; }
    }
    if (document.querySelector('.ql-overlay')) return;
    const t = e.target as HTMLElement;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    const inCode = !!t?.closest?.('.cm-editor');
    const id = this.app.keyIndex.get(canonicalKey(k));
    if (!id) return;
    const mod = e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key);
    if (inCode) {
      // CodeMirror owns undo, redo, find, indent, comment and selection keys; app commands get the rest.
      if (!mod || /^edit\.(undo|redo|selectAll|copy|cut|paste|find|replace|indent|outdent|comment)$/.test(id) || id.startsWith('code.')) return;
    } else if (inField) {
      if (!/^(file\.|view\.cmdSearch)/.test(id) || !mod) return;
    } else if (!mod && !/^(Delete|Backspace)$/.test(e.key)) return;
    if (!mod) return;
    e.preventDefault();
    this.app.exec(id);
  }

  async showShortcuts(): Promise<void> {
    const rows = allCommands().filter((c) => (c.keys && c.keys.length) || Object.values(this.app.prefs.keymap).includes(c.id));
    const custom = Object.entries(this.app.prefs.keymap);
    const table = h('table', { class: 'ql-stats ql-shortcuts' },
      ...rows.sort((a, b) => a.tab.localeCompare(b.tab) || a.label.localeCompare(b.label)).map((c) => {
        const keys = [...(c.keys || []), ...custom.filter(([, id]) => id === c.id).map(([k2]) => k2)];
        return h('tr', null, h('td', null, c.label), h('td', null, keys.map(prettyKey).join(', ')), h('td', { class: 'ql-help' }, c.tab === 'Backstage' ? 'File' : c.tab));
      }));
    await openDialog({ title: 'Keyboard Shortcuts', wide: true, content: table, cancel: false });
  }

  async showCommandReference(): Promise<void> {
    const byTab = new Map<string, Command[]>();
    for (const c of allCommands()) { const t = c.tab === 'Backstage' ? 'File' : c.tab; if (!byTab.has(t)) byTab.set(t, []); byTab.get(t)!.push(c); }
    const div = h('div', { class: 'ql-cmdref' });
    div.appendChild(h('p', { class: 'ql-help' }, `${allCommands().length} commands. Every command can be added to the Quick Access Bar, a custom tab, a keyboard shortcut, or a macro.`));
    for (const [t, cs] of byTab) {
      div.appendChild(h('h3', null, `${t} (${cs.length})`));
      div.appendChild(h('ul', null, ...cs.sort((a, b) => a.label.localeCompare(b.label)).map((c) => h('li', null, h('b', null, c.label), c.keys?.length ? ` — ${c.keys.map(prettyKey).join(', ')}` : '', c.origin ? h('span', { class: 'ql-help' }, ` (from ${c.origin})`) : ''))));
    }
    await openDialog({ title: 'Command Reference', wide: true, content: div, cancel: false });
  }

  async tour(): Promise<void> {
    const steps = [
      ['Everything is a command', 'Every feature of QuillLoom is a command you can find with the search button (or Alt+Q), place on the Quick Access Bar, put on your own tab, assign a key, or record in a macro.'],
      ['Ribbon or classic menus', 'Use the ribbon tabs, or the classic menu bar laid out like the desktop web editors you may know (View ▸ Menus). Both reach the same commands; you can show either or both.'],
      ['Design, Split, Code, Preview', 'Edit visually in Design view, write markup in Code view, or do both in Split view. Preview runs the page\'s scripts in a sandbox. The Quick Tag Selector above the page shows where you are; its drop-downs edit, wrap or remove tags.'],
      ['Sites', 'Open a whole folder (File ▸ Open Site), a ZIP, a template, a WordPress export or a Weebly site archive. The Folder List shows every file; renaming or moving one fixes the links to it. Site ▸ Reports checks links, pictures and pages.'],
      ['Publishing', 'Publish to a folder, a ZIP, a WebDAV server, FTP (desktop app) or WordPress. Save the site as one .qlsite file to carry it between devices.'],
    ];
    for (let i = 0; i < steps.length; i++) {
      const r = await openDialog({ title: `${steps[i][0]} (${i + 1}/${steps.length})`, content: h('p', { class: 'ql-msg' }, steps[i][1]), ok: i === steps.length - 1 ? 'Start' : 'Next', cancel: 'Skip tour' });
      if (!r) break;
    }
    this.app.prefs.firstRun = false;
    this.app.savePrefs();
  }
}
