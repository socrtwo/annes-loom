/**
 * Panes for editing: Find and Replace, History (undo steps and saved snapshots), Outline (headings and
 * landmarks of the page), Assets (the site's pictures, colors, links, fonts and media, ready to insert)
 * and the Clipboard ring.
 */
import type { App, PageTab } from '../app';
import { registerPane, sigOf, typingIn } from './panes';
import { h, icon, clear } from './dom';
import { toast, confirmDialog, openDialog } from './dialog';
import { kvSet, kvGet, kvDel, kvKeys } from '../util/store';
import { findState, findAll, findNext, replaceOne, replaceAll, reveal, clipRing, clipVersion, symbolsOf, type FindScope } from '../commands/edit';
import { parseSource, type SrcEl } from '../commands/tag';
import { insertHtml, wrapTag, selectionHtml, view } from '../editor/ops';
import { cacheFor } from '../editor/workspace';
import { esc, escAttr, htmlToText } from '../model/html';
import { externalLinksOf } from '../model/site';
import { relativeRef, isImagePath, isPagePath, extOf, baseName } from '../model/paths';

// ==========================================================================================
// Find and Replace

registerPane({
  id: 'find', title: 'Find and Replace', side: 'right',
  render(app, el, opts) {
    clear(el);
    el.dataset.sig = '';
    const q = h('input', { type: 'search', class: 'ql-find-q', placeholder: 'Find…', 'aria-label': 'Find', value: findState.query, style: 'width:100%' }) as HTMLInputElement;
    const r = h('input', { type: 'text', class: 'ql-find-r', placeholder: 'Replace with…', 'aria-label': 'Replace with', value: findState.replace, style: 'width:100%' }) as HTMLInputElement;
    const chk = (key: 'regex' | 'matchCase' | 'wholeWord', label: string, title: string) => {
      const c = h('input', { type: 'checkbox', checked: findState[key] }) as HTMLInputElement;
      c.addEventListener('change', () => { findState[key] = c.checked; findState.version++; });
      return h('label', { class: 'ql-check', title }, c, ' ', label);
    };
    const mode = h('select', { 'aria-label': 'Search in' }, h('option', { value: 'source' }, 'Source code'), h('option', { value: 'text' }, 'Visible text only')) as HTMLSelectElement;
    mode.value = findState.mode;
    mode.addEventListener('change', () => { findState.mode = mode.value as any; });
    const scope = h('select', { 'aria-label': 'Look in' }, h('option', { value: 'page' }, 'Current page'), h('option', { value: 'selection' }, 'Selection (Code view)'), h('option', { value: 'open' }, 'Open pages'), h('option', { value: 'site' }, 'All pages in the site')) as HTMLSelectElement;
    scope.value = findState.scope;
    scope.addEventListener('change', () => { findState.scope = scope.value as FindScope; });
    const sync = () => { findState.query = q.value; findState.replace = r.value; };
    q.addEventListener('input', sync);
    r.addEventListener('input', sync);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sync(); if (e.shiftKey) findNext(app, -1); else findNext(app, 1); } });
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sync(); replaceOne(app); } });
    const btn = (label: string, ic: string, fn: () => void, title?: string) => h('button', { class: 'ql-btn ql-sm', type: 'button', title: title || label, onclick: () => { sync(); fn(); } }, icon(ic), ' ', label);
    const replaceRow = h('div', { class: 'ql-find-replace' }, r, h('div', { class: 'ql-row', style: 'gap:4px;flex-wrap:wrap;margin-top:4px' },
      btn('Replace', 'find_replace', () => replaceOne(app), 'Replace the selected match and find the next one'),
      btn('Replace All', 'published_with_changes', () => void replaceAll(app))));
    const status = h('div', { class: 'ql-help ql-find-status', 'aria-live': 'polite' });
    const results = h('div', { class: 'ql-find-results', role: 'list', style: 'overflow:auto;flex:1;min-height:80px' });
    el.append(
      h('div', { class: 'ql-pad', style: 'display:flex;flex-direction:column;gap:6px' },
        q,
        h('div', { class: 'ql-row', style: 'gap:8px;flex-wrap:wrap' }, chk('matchCase', 'Match case', 'Match upper and lower case'), chk('wholeWord', 'Whole word', 'Match whole words only'), chk('regex', 'Regular expression', 'JavaScript regular expression; $1 in the replacement inserts a group')),
        h('div', { class: 'ql-row', style: 'gap:6px;flex-wrap:wrap' }, h('label', null, 'In ', mode), h('label', null, 'Look in ', scope)),
        h('div', { class: 'ql-row', style: 'gap:4px;flex-wrap:wrap' }, btn('Find Next', 'arrow_downward', () => findNext(app, 1), 'Find Next (F3)'), btn('Previous', 'arrow_upward', () => findNext(app, -1), 'Find Previous (Shift+F3)'), btn('Find All', 'list', () => findAll(app))),
        replaceRow, status),
      results);
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    (el as any)._ql = { q, r, mode, scope, replaceRow, status, results };
    this.onOpen!(app, el, opts);
    this.update!(app, el, opts);
  },
  onOpen(app, el, opts) {
    const c = (el as any)._ql;
    if (!c) return;
    c.q.value = findState.query;
    c.scope.value = findState.scope;
    if (opts?.replace) c.replaceRow.style.display = '';
    if (opts?.focus) setTimeout(() => { c.q.focus(); c.q.select(); }, 20);
  },
  update(app, el) {
    const c = (el as any)._ql;
    if (!c) return;
    if (!sigOf(el, `${findState.version}`)) return;
    c.status.textContent = findState.message;
    clear(c.results);
    let last = '';
    for (const hit of findState.results.slice(0, 2000)) {
      if (hit.path !== last) { last = hit.path; c.results.appendChild(h('div', { class: 'ql-find-file', style: 'font-weight:600;padding:4px 8px 2px;font-size:12px' }, icon('description'), ' ', hit.path)); }
      const pre = hit.preview.slice(0, hit.pre), mid = hit.preview.slice(hit.pre, hit.pre + hit.len), post = hit.preview.slice(hit.pre + hit.len);
      const row = h('button', { class: 'ql-find-hit', type: 'button', role: 'listitem', style: 'display:flex;gap:6px;width:100%;text-align:left;padding:2px 8px 2px 18px;border:0;background:none;font:12px ui-monospace,Consolas,monospace;cursor:pointer;color:inherit', title: `${hit.path}, line ${hit.line}` },
        h('span', { class: 'ql-help', style: 'min-width:3em;text-align:right' }, String(hit.line)),
        h('span', { style: 'white-space:pre;overflow:hidden;text-overflow:ellipsis' }, pre, h('mark', null, mid), post));
      row.addEventListener('click', () => { findState.index = findState.results.indexOf(hit); reveal(app, hit.path, hit.from, hit.to); });
      c.results.appendChild(row);
    }
  },
});

// ==========================================================================================
// History: the tab's undo steps and saved snapshots

let snapVersion = 0;

export async function saveSnapshot(app: App, tab: PageTab, label = ''): Promise<void> {
  tab.ui.flush();
  const time = Date.now();
  await kvSet(`snap:${tab.path}:${time}`, { path: tab.path, time, label, text: tab.source });
  snapVersion++;
  app.refresh();
  toast('Snapshot saved on this device.');
}

registerPane({
  id: 'history', title: 'History', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    const tab = app.active;
    const hs = tab?.history;
    const sig = tab ? `${tab.id}:${tab.path}:${hs!.index}:${hs!.stack.length}:${hs!.labels[hs!.index]}:${snapVersion}` : 'none';
    if (!sigOf(el, sig) || typingIn(el)) return;
    clear(el);
    if (!tab || !hs) { el.appendChild(h('p', { class: 'ql-help ql-pad' }, 'Open a file to see its history.')); return; }
    el.appendChild(h('div', { class: 'ql-row ql-pane-tools' },
      h('button', { class: 'ql-btn ql-sm', type: 'button', onclick: () => app.exec('edit.undo') }, icon('undo'), ' Undo'),
      h('button', { class: 'ql-btn ql-sm', type: 'button', onclick: () => app.exec('edit.redo') }, icon('redo'), ' Redo'),
      h('button', { class: 'ql-btn ql-sm', type: 'button', title: 'Keep a copy of this file as it is now (stored on this device)', onclick: async () => { const r = await openDialog({ title: 'Save Snapshot', fields: [{ key: 'l', label: 'Name (optional)', type: 'text', value: '' }] }); if (r) void saveSnapshot(app, tab, String(r.l || '')); } }, icon('photo_camera'), ' Snapshot')));
    el.appendChild(h('h3', { class: 'ql-pane-sub', style: 'font-size:12px;margin:8px 8px 2px' }, `Changes to ${baseName(tab.path)} (${hs.stack.length})`));
    const list = h('div', { role: 'list', class: 'ql-history-list' });
    for (let i = hs.stack.length - 1; i >= 0; i--) {
      const cur = i === hs.index, future = i > hs.index;
      const b = h('button', { type: 'button', role: 'listitem', class: 'ql-tree-row' + (cur ? ' ql-on' : '') + (future ? ' ql-dim' : ''), style: 'width:100%;text-align:left;border:0;background:none;color:inherit;padding:3px 8px;cursor:pointer' + (future ? ';opacity:.55' : ''), title: future ? 'Undone; click to redo up to here' : 'Click to go back to this step' },
        icon(i === 0 ? 'folder_open' : cur ? 'radio_button_checked' : 'radio_button_unchecked'), ' ', `${i}. ${hs.labels[i] || 'Edit'}`);
      b.addEventListener('click', () => {
        tab.ui.flush();
        if (i === tab.history.index) return;
        tab.history.index = i;
        app.commit(tab, tab.history.stack[i], 'History', 'history');
      });
      list.appendChild(b);
    }
    el.appendChild(list);
    const snaps = h('div', { class: 'ql-snapshots' }, h('p', { class: 'ql-help ql-pad' }, 'Loading snapshots…'));
    el.append(h('h3', { class: 'ql-pane-sub', style: 'font-size:12px;margin:10px 8px 2px' }, 'Snapshots'), snaps);
    void (async () => {
      let keys: string[] = [];
      try { keys = (await kvKeys(`snap:${tab.path}:`)).sort().reverse(); } catch { /* storage unavailable */ }
      clear(snaps);
      if (!keys.length) { snaps.appendChild(h('p', { class: 'ql-help ql-pad' }, 'No snapshots yet. A snapshot keeps this file as it is now, even after you close it.')); return; }
      for (const k of keys.slice(0, 50)) {
        const time = +k.slice(k.lastIndexOf(':') + 1);
        const row = h('div', { class: 'ql-row', style: 'gap:4px;padding:2px 8px;align-items:center' });
        const restore = async () => {
          const s = await kvGet(k);
          if (!s?.text) { toast('This snapshot could not be read.'); return; }
          if (!(await confirmDialog('Restore Snapshot', `Replace ${tab.path} with the snapshot from ${new Date(time).toLocaleString()}? You can undo this.`, 'Restore'))) return;
          app.editSource('Restore Snapshot', () => s.text, tab);
        };
        const show = async () => { const s = await kvGet(k); if (s?.text) await openDialog({ title: `Snapshot ${new Date(time).toLocaleString()}`, wide: true, cancel: false, ok: 'Close', fields: [{ key: 't', type: 'textarea', rows: 18, value: s.text }] }); };
        const del = async () => { await kvDel(k); snapVersion++; app.refresh(); };
        void kvGet(k).then((s) => { if (s?.label) lab.textContent = `${s.label} · ${new Date(time).toLocaleString()}`; });
        const lab = h('span', { style: 'flex:1;font-size:12px' }, new Date(time).toLocaleString());
        row.append(icon('photo_camera'), lab,
          h('button', { class: 'ql-iconbtn ql-sm', type: 'button', title: 'View', 'aria-label': 'View snapshot', onclick: show }, icon('visibility')),
          h('button', { class: 'ql-iconbtn ql-sm', type: 'button', title: 'Restore', 'aria-label': 'Restore snapshot', onclick: restore }, icon('settings_backup_restore')),
          h('button', { class: 'ql-iconbtn ql-sm', type: 'button', title: 'Delete', 'aria-label': 'Delete snapshot', onclick: del }, icon('delete')));
        snaps.appendChild(row);
      }
    })();
  },
});

// ==========================================================================================
// Outline: headings and landmarks

const LANDMARKS = new Set(['header', 'nav', 'main', 'aside', 'footer', 'section', 'article', 'form', 'search', 'figure', 'dialog', 'table']);
const isHeading = (n: string) => /^h[1-6]$/.test(n);
let docIds = new WeakMap<Document, number>(), docCounter = 0;
const docId = (d: Document | null | undefined) => { if (!d) return 0; let i = docIds.get(d); if (!i) { i = ++docCounter; docIds.set(d, i); } return i; };

interface OutlineItem { label: string; tag: string; depth: number; el?: Element; at?: number; end?: number }

function domOutline(doc: Document): OutlineItem[] {
  const out: OutlineItem[] = [];
  const walk = (n: Element, depth: number) => {
    for (const c of n.children) {
      if (c.hasAttribute('data-ql-ui')) continue;
      const t = c.tagName.toLowerCase();
      const role = c.getAttribute('role');
      if (isHeading(t)) { out.push({ tag: t, depth: depth + (+t[1] - 1) * 0, label: (c.textContent || '').trim().replace(/\s+/g, ' ') || '(empty heading)', el: c }); continue; }
      if (LANDMARKS.has(t) || (role && /^(banner|navigation|main|complementary|contentinfo|region|search|form)$/.test(role))) {
        const name = c.getAttribute('aria-label') || c.id || (c.getAttribute('class') || '').trim().split(/\s+/)[0] || '';
        out.push({ tag: t, depth, label: name, el: c });
        walk(c, depth + 1);
        continue;
      }
      walk(c, depth);
    }
  };
  walk(doc.body, 0);
  return out;
}

function sourceOutline(src: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const walk = (n: SrcEl, depth: number) => {
    for (const c of n.children) {
      if (isHeading(c.name)) { out.push({ tag: c.name, depth, label: htmlToText(src.slice(c.openEnd, c.closeStart)).replace(/\s+/g, ' ').trim() || '(empty heading)', at: c.openStart, end: c.closeEnd }); continue; }
      if (LANDMARKS.has(c.name)) {
        const t = src.slice(c.openStart, c.openEnd);
        const name = /aria-label\s*=\s*["']([^"']+)/i.exec(t)?.[1] || /\bid\s*=\s*["']([^"']+)/i.exec(t)?.[1] || /\bclass\s*=\s*["']([^"'\s]+)/i.exec(t)?.[1] || '';
        out.push({ tag: c.name, depth, label: name, at: c.openStart, end: c.closeEnd });
        walk(c, depth + 1);
        continue;
      }
      walk(c, depth);
    }
  };
  walk(parseSource(src).root, 0);
  return out;
}

registerPane({
  id: 'outline', title: 'Outline', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    const tab = app.active;
    const d = tab?.ui?.design;
    const useDom = !!(tab?.kind === 'page' && d?.doc?.body && tab.view !== 'code');
    const sig = `${tab?.id}:${app.site.version}:${useDom ? docId(d!.doc) : 0}:${tab?.view}`;
    if (!sigOf(el, sig) || typingIn(el)) return;
    const scroll = el.scrollTop;
    clear(el);
    if (!tab || !(tab.kind === 'page' || tab.kind === 'text')) { el.appendChild(h('p', { class: 'ql-help ql-pad' }, 'Open a page to see its outline.')); return; }
    const list = h('div', { role: 'tree', 'aria-label': 'Page outline', class: 'ql-tree' });
    const row = (ic: string, text: string, depth: number, onclick: () => void, title = '') => {
      const b = h('div', { class: 'ql-tree-row', role: 'treeitem', tabindex: '0', style: `padding-left:${6 + depth * 14}px`, title }, icon(ic), h('span', { class: 'ql-tree-name' }, text));
      b.addEventListener('click', onclick);
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter') onclick(); });
      list.appendChild(b);
    };
    if (tab.kind === 'text') {
      const syms = symbolsOf(tab.path, tab.source);
      if (!syms.length) el.appendChild(h('p', { class: 'ql-help ql-pad' }, 'No functions or style rules found.'));
      for (const s of syms) row(s.kind === 'function' ? 'function' : s.kind === 'class' ? 'category' : 'css', s.name, 0, () => reveal(app, tab.path, s.at, s.at + s.name.length));
      el.appendChild(list);
      return;
    }
    const items = useDom ? domOutline(d!.doc!) : sourceOutline(tab.source);
    if (!items.length) { el.appendChild(h('p', { class: 'ql-help ql-pad' }, 'This page has no headings or landmark elements (header, nav, main, section, article, aside, footer).')); return; }
    // Heading levels that skip (h2 → h4) are flagged, as accessibility checkers do.
    let lastLevel = 0;
    for (const it of items) {
      const heading = isHeading(it.tag);
      const level = heading ? +it.tag[1] : 0;
      const skipped = heading && lastLevel && level > lastLevel + 1;
      if (heading) lastLevel = level;
      const label = heading ? `${it.tag.toUpperCase()}  ${it.label}` : `<${it.tag}>${it.label ? ' ' + it.label : ''}`;
      row(heading ? (skipped ? 'warning' : 'title') : it.tag === 'nav' ? 'menu' : it.tag === 'form' ? 'dynamic_form' : it.tag === 'table' ? 'table' : 'crop_square', label, it.depth + (heading ? Math.max(0, level - 1) * 0.5 : 0), () => {
        if (it.el && tab.ui.design) {
          if (tab.view === 'preview') app.setView(tab, 'design');
          tab.ui.focusArea = 'design';
          tab.ui.design.select(it.el);
          (it.el as HTMLElement).scrollIntoView?.({ block: 'center' });
        } else if (it.at != null) reveal(app, tab.path, it.at, it.end ?? it.at);
      }, skipped ? `Heading level skipped (after H${lastLevel === level ? level - 1 : ''})` : '');
    }
    el.appendChild(list);
    el.scrollTop = scroll;
  },
});

// ==========================================================================================
// Assets: pictures, colors, links, fonts and media of the site

let assetTab: 'images' | 'colors' | 'links' | 'fonts' | 'media' = 'images';
const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\([^)]{3,60}\)/g;

export function siteColors(texts: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of texts) for (const m of t.matchAll(COLOR_RE)) { const c = m[0].toLowerCase().replace(/\s+/g, ''); counts.set(c, (counts.get(c) || 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

export function siteFonts(texts: string[]): string[] {
  const s = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/font-family\s*:\s*([^;}"\n]+)/gi)) s.add(m[1].trim().replace(/\s*!important$/, ''));
    for (const m of t.matchAll(/\bface\s*=\s*["']([^"']+)["']/gi)) s.add(m[1]);
  }
  return [...s].filter(Boolean).sort();
}

function insertAt(app: App, markup: string, text?: string): void {
  if (!app.active || !(app.active.kind === 'page' || app.active.kind === 'text')) { toast('Open a page to insert into.'); return; }
  if (app.isReadOnly()) { toast('This file is read-only.'); return; }
  if (app.active.kind === 'text' && text != null) { const v = view(app); v?.code?.replaceSelection(text); v?.flush(); return; }
  insertHtml(app, markup);
}

registerPane({
  id: 'assets', title: 'Assets', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    const sig = `${app.site.version}:${assetTab}:${app.active?.path}`;
    if (!sigOf(el, sig) || typingIn(el)) return;
    clear(el);
    const tabs: [typeof assetTab, string, string][] = [['images', 'image', 'Pictures'], ['colors', 'palette', 'Colors'], ['links', 'link', 'Links'], ['fonts', 'font_download', 'Fonts'], ['media', 'movie', 'Media']];
    el.appendChild(h('div', { class: 'ql-row ql-pane-tools', role: 'tablist', style: 'flex-wrap:wrap;gap:2px' }, ...tabs.map(([id, ic, label]) => h('button', { class: 'ql-btn ql-sm' + (assetTab === id ? ' ql-on' : ''), type: 'button', role: 'tab', 'aria-selected': String(assetTab === id), onclick: () => { assetTab = id; el.dataset.sig = ''; this.update!(app, el, {}); } }, icon(ic), ' ', label))));
    const body = h('div', { class: 'ql-assets-body ql-pad' });
    el.appendChild(body);
    const here = app.active?.path || 'index.html';
    const rel = (p: string) => relativeRef(here, p);
    const texts = app.site.list((f) => f.text != null && (isPagePath(f.path) || /\.(css|scss|less)$/i.test(f.path))).map((f) => f.text!);
    const empty = (msg: string) => body.appendChild(h('p', { class: 'ql-help' }, msg));
    const hint = (msg: string) => body.appendChild(h('p', { class: 'ql-help', style: 'margin-top:0' }, msg));
    if (assetTab === 'images') {
      const imgs = app.site.list((f) => isImagePath(f.path));
      if (!imgs.length) { empty('The site has no pictures yet. Import some with File ▸ Import.'); return; }
      hint('Click a picture to insert it at the cursor.');
      const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:6px' });
      for (const f of imgs) {
        const url = cacheFor(app).url(f.path, 'blob') || '';
        const b = h('button', { type: 'button', class: 'ql-asset', title: f.path, style: 'display:flex;flex-direction:column;align-items:center;gap:2px;border:1px solid var(--border);border-radius:4px;background:var(--surface);padding:4px;cursor:pointer;color:inherit;min-width:0' },
          h('img', { src: url, alt: '', loading: 'lazy', style: 'width:72px;height:56px;object-fit:contain;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/12px 12px' }),
          h('span', { style: 'font-size:10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, baseName(f.path)));
        b.addEventListener('click', () => insertAt(app, `<img src="${escAttr(rel(f.path))}" alt="">`, rel(f.path)));
        b.addEventListener('dblclick', () => app.openFile(f.path));
        grid.appendChild(b);
      }
      body.appendChild(grid);
    } else if (assetTab === 'colors') {
      const colors = siteColors(texts);
      if (!colors.length) { empty('No colors are used in the site’s pages or style sheets.'); return; }
      hint('Click a color to apply it to the selected text (Design view) or insert its value (Code view).');
      for (const [c, n] of colors.slice(0, 200)) {
        const b = h('button', { type: 'button', class: 'ql-tree-row', style: 'display:flex;gap:8px;align-items:center;width:100%;border:0;background:none;color:inherit;cursor:pointer;padding:2px 4px' },
          h('span', { style: `width:22px;height:16px;border:1px solid var(--border);border-radius:3px;background:${c}` }), h('code', { style: 'flex:1;text-align:left' }, c), h('span', { class: 'ql-help' }, `×${n}`));
        b.addEventListener('click', () => {
          const v = view(app);
          if (v?.target === 'design' && v.design) { v.design.exec('foreColor', c); v.flush(); }
          else if (v?.code) { v.code.replaceSelection(c); v.flush(); }
        });
        b.addEventListener('contextmenu', (e) => { e.preventDefault(); void navigator.clipboard?.writeText(c).then(() => toast(`Copied ${c}`)); });
        body.appendChild(b);
      }
    } else if (assetTab === 'links') {
      const pages = app.site.pages().map((f) => f.path);
      const ext = [...new Set(texts.flatMap((t) => externalLinksOf(t)))].sort();
      hint('Click a link to make the selection a hyperlink to it (or insert the link).');
      const add = (href: string, label: string, ic: string) => {
        const b = h('button', { type: 'button', class: 'ql-tree-row', title: href, style: 'display:flex;gap:6px;align-items:center;width:100%;border:0;background:none;color:inherit;cursor:pointer;padding:2px 4px;text-align:left' }, icon(ic), h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, label));
        b.addEventListener('click', () => {
          if (selectionHtml(app)) wrapTag(app, 'a', { href });
          else insertAt(app, `<a href="${escAttr(href)}">${esc(label)}</a>`, href);
        });
        body.appendChild(b);
      };
      body.appendChild(h('h4', { style: 'margin:6px 0 2px;font-size:12px' }, 'Pages in this site'));
      for (const p of pages) add(rel(p), p, 'html');
      body.appendChild(h('h4', { style: 'margin:10px 0 2px;font-size:12px' }, 'External links used in the site'));
      if (!ext.length) body.appendChild(h('p', { class: 'ql-help' }, 'None.'));
      for (const u of ext.slice(0, 300)) add(u, u, 'public');
    } else if (assetTab === 'fonts') {
      const fonts = siteFonts(texts);
      const files = app.site.list((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f.path));
      if (!fonts.length && !files.length) { empty('No fonts are named in the site’s style sheets.'); return; }
      hint('Click a font to apply it to the selection (Design view) or insert it (Code view).');
      for (const f of fonts) {
        const b = h('button', { type: 'button', class: 'ql-tree-row', title: f, style: `display:block;width:100%;border:0;background:none;color:inherit;cursor:pointer;padding:3px 4px;text-align:left;font-family:${f.replace(/[;{}<>]/g, '')}` }, f);
        b.addEventListener('click', () => {
          const v = view(app);
          if (v?.target === 'design' && v.design) { v.design.exec('fontName', f); v.flush(); }
          else if (v?.code) { v.code.replaceSelection(f); v.flush(); }
        });
        body.appendChild(b);
      }
      if (files.length) {
        body.appendChild(h('h4', { style: 'margin:10px 0 2px;font-size:12px' }, 'Font files'));
        for (const f of files) body.appendChild(h('div', { class: 'ql-help', style: 'padding:1px 4px' }, icon('font_download'), ' ', f.path));
      }
    } else {
      const media = app.site.list((f) => /\.(mp4|webm|ogv|mov|m4v|mp3|ogg|oga|wav|m4a|flac|aac|pdf|swf|vtt)$/i.test(f.path));
      if (!media.length) { empty('The site has no video, sound or document files.'); return; }
      hint('Click a file to insert it at the cursor.');
      for (const f of media) {
        const e = extOf(f.path), r2 = escAttr(rel(f.path));
        const isVideo = /^(mp4|webm|ogv|mov|m4v)$/.test(e), isAudio = /^(mp3|ogg|oga|wav|m4a|flac|aac)$/.test(e);
        const markup = isVideo ? `<video src="${r2}" controls></video>` : isAudio ? `<audio src="${r2}" controls></audio>` : `<a href="${r2}">${esc(baseName(f.path))}</a>`;
        const b = h('button', { type: 'button', class: 'ql-tree-row', title: f.path, style: 'display:flex;gap:6px;align-items:center;width:100%;border:0;background:none;color:inherit;cursor:pointer;padding:2px 4px;text-align:left' }, icon(isVideo ? 'movie' : isAudio ? 'audio_file' : 'description'), h('span', null, f.path));
        b.addEventListener('click', () => insertAt(app, markup, rel(f.path)));
        body.appendChild(b);
      }
    }
  },
});

// ==========================================================================================
// Clipboard ring

registerPane({
  id: 'clipboard', title: 'Clipboard', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    if (!sigOf(el, String(clipVersion))) return;
    clear(el);
    el.appendChild(h('div', { class: 'ql-row ql-pane-tools' },
      h('button', { class: 'ql-btn ql-sm', type: 'button', onclick: () => { for (const c of [...clipRing].reverse()) insertAt(app, c.html || esc(c.text).replace(/\n/g, '<br>\n'), c.text); } }, icon('content_paste'), ' Paste All'),
      h('button', { class: 'ql-btn ql-sm', type: 'button', onclick: () => { clipRing.length = 0; el.dataset.sig = ''; this.update!(app, el, {}); } }, icon('clear_all'), ' Clear All')));
    if (!clipRing.length) { el.appendChild(h('p', { class: 'ql-help ql-pad' }, 'Text and markup you copy or cut in Anne\'s Loom appear here (the last 24). Click one to paste it at the cursor.')); return; }
    for (const c of clipRing) {
      const b = h('button', { type: 'button', class: 'ql-clip', title: `Copied ${new Date(c.time).toLocaleTimeString()} from ${c.source}`, style: 'display:block;width:calc(100% - 12px);margin:4px 6px;text-align:left;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:inherit;padding:4px 6px;cursor:pointer;font-size:12px;white-space:pre-wrap;max-height:5.5em;overflow:hidden' },
        (c.text || htmlToText(c.html)).slice(0, 240));
      b.addEventListener('click', () => insertAt(app, c.html || esc(c.text).replace(/\n/g, '<br>\n'), c.text));
      el.appendChild(b);
    }
  },
});
