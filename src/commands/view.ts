/**
 * View commands: page views (Design / Split / Code / Preview), site views, visual aids, formatting marks,
 * reveal tags, rulers, grid, guides, tracing image, page size, zoom, style rendering (print, dark,
 * reduced motion, no styles), Code view options, menus and ribbon, Quick Access Bar, full screen,
 * head and noscript content, related files, live code and the element inspector.
 *
 * Design view additions (marks, rulers, guides, tracing image, template region outlines, inspector)
 * live in the Design view frame as data-ql-ui elements and a style sheet in its head, so they are
 * never written into the page. They are re-applied every time the frame reloads.
 */
import { def, getCommand, type MenuEntry } from './registry';
import type { App, PageTab, ViewMode } from '../app';
import { openDialog, toast } from '../ui/dialog';
import { view, isPage, isText } from '../editor/ops';
import { PAGE_SIZES, cacheFor } from '../editor/workspace';
import { CLASSIC_LAYOUT_NAMES } from '../ui/classicMenus';
import { addAllQatChoices } from '../prefs';
import { regions, linkedStyles, linkedScripts } from '../model/html';
import { resolveRef, isImagePath, baseName } from '../model/paths';
import { ensureCodeExtras, parseSource, elementForPath } from './tag';
import { EditorSelection } from '@codemirror/state';
import { PANES } from '../ui/panes';

// ==========================================================================================
// View state kept on this device (beyond the shared preferences)

type Media = 'screen' | 'print' | 'dark' | 'reducedMotion';
interface Tracing { src: string; opacity: number; x: number; y: number; show: boolean; name: string }

interface ViewFlags {
  revealTags: boolean;
  marks: { tags: boolean; paragraphs: boolean; breaks: boolean; hiddenFields: boolean; bookmarks: boolean };
  aidRegions: boolean;
  aidHidden: boolean;
  inspect: boolean;
  liveCode: boolean;
  media: Media;
  disableStyles: boolean;
  expandedTables: boolean;
  guides: boolean;
  guideList: { x: number[]; y: number[] };
  origin: { x: number; y: number };
  codeHiddenChars: boolean;
  codeHighlightInvalid: boolean;
  hideTagBar: boolean;
  hideStatus: boolean;
  savedAids: Record<string, boolean> | null;
  tracing: Record<string, Tracing>;
}

const FLAGS_KEY = 'quillloom.view.v1';
const DEFAULT_FLAGS: ViewFlags = {
  revealTags: false, marks: { tags: false, paragraphs: false, breaks: false, hiddenFields: false, bookmarks: false },
  aidRegions: true, aidHidden: false, inspect: false, liveCode: false, media: 'screen', disableStyles: false, expandedTables: false,
  guides: true, guideList: { x: [], y: [] }, origin: { x: 0, y: 0 }, codeHiddenChars: false, codeHighlightInvalid: true,
  hideTagBar: false, hideStatus: false, savedAids: null, tracing: {},
};

function loadFlags(): ViewFlags {
  const d: ViewFlags = JSON.parse(JSON.stringify(DEFAULT_FLAGS));
  try {
    const raw = JSON.parse(localStorage.getItem(FLAGS_KEY) || '{}');
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(d) as (keyof ViewFlags)[]) if (k in raw && typeof raw[k] === typeof d[k]) (d as any)[k] = raw[k];
      d.marks = { ...DEFAULT_FLAGS.marks, ...(raw.marks || {}) };
    }
  } catch { /* unavailable */ }
  // Session-only states start off.
  d.media = 'screen'; d.disableStyles = false; d.inspect = false;
  return d;
}

export const flags: ViewFlags = loadFlags();
let flagsVersion = 1;

function saveFlags(): void {
  flagsVersion++;
  try { localStorage.setItem(FLAGS_KEY, JSON.stringify(flags)); }
  catch { try { localStorage.setItem(FLAGS_KEY, JSON.stringify({ ...flags, tracing: {} })); } catch { /* full */ } }
}

// ------------------------------------------------------------------------------------------
// Editor-wide CSS for hidden bars (the classes live on <html> so they apply before the app exists)

if (typeof document !== 'undefined') {
  const st = document.createElement('style');
  st.id = 'ql-view-global';
  st.textContent = '.ql-hide-tagbar .ql-tagbar{display:none!important}.ql-hide-status .ql-status{display:none!important}';
  document.head?.appendChild(st);
  applyRootClasses();
}
function applyRootClasses(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('ql-hide-tagbar', flags.hideTagBar);
  document.documentElement.classList.toggle('ql-hide-status', flags.hideStatus);
}

// ==========================================================================================
// Hooks: every refresh, make sure each open tab's Design frame and Code view carry the extras.

let installedOn: App | null = null;
const hookedFrames = new WeakSet<HTMLIFrameElement>();
const lastLive = new WeakMap<PageTab, Element | null>();

export function installViewHooks(app: App): void {
  if (installedOn === app) return;
  installedOn = app;
  app.onRefresh(() => syncAll(app));
  syncAll(app);
}
if (typeof window !== 'undefined') setTimeout(() => { const a = (window as any).ql; if (a?.onRefresh) installViewHooks(a); }, 0);

function syncAll(app: App): void {
  for (const tab of app.docs) {
    try {
      if (tab.ui?.code) ensureCodeExtras(tab, { hiddenChars: flags.codeHiddenChars, highlightInvalid: flags.codeHighlightInvalid });
      const d = tab.ui?.design;
      if (d) {
        if (!hookedFrames.has(d.frame)) { hookedFrames.add(d.frame); d.frame.addEventListener('load', () => setTimeout(() => applyExtras(app, tab), 0)); }
        const doc = d.frame.contentDocument as any;
        if (doc?.body && (doc._qlExtVer !== flagsVersion || (flags.aidRegions && /BeginEditable/.test(tab.source)))) applyExtras(app, tab);
        if (flags.liveCode && tab === app.active) liveSync(tab);
      }
    } catch (e) { console.error(e); }
  }
}

function liveSync(tab: PageTab): void {
  const d = tab.ui.design, c = tab.ui.code;
  if (!d || !c || tab.view !== 'split' || tab.ui.target !== 'design') return;
  const el = d.selected;
  if (lastLive.get(tab) === el) return;
  lastLive.set(tab, el);
  if (!el || el === d.doc?.body) return;
  const r = sourceRangeOf(tab, el);
  if (r) c.view.dispatch({ selection: EditorSelection.range(r[0], r[1]), scrollIntoView: true });
}

/** The source range of a Design view element, found by its position among same-tag siblings from <body>. */
export function sourceRangeOf(tab: PageTab, el: Element): [number, number] | null {
  const doc = el.ownerDocument;
  const path: { tag: string; nth: number }[] = [];
  let n: Element | null = el;
  while (n && n !== doc.body && n !== doc.documentElement) {
    const tag = n.tagName.toLowerCase();
    let nth = 0;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName && !s.hasAttribute('data-ql-ui')) nth++;
    path.unshift({ tag, nth });
    n = n.parentElement;
  }
  tab.ui.flush();
  const src = tab.source;
  const found = elementForPath(parseSource(src).root, path);
  if (!found || found.name === '#root') return null;
  return [found.openStart, found.closeEnd];
}

// ------------------------------------------------------------------------------------------
// Design frame extras

const NO_PSEUDO = new Set(['img', 'input', 'br', 'hr', 'iframe', 'video', 'audio', 'canvas', 'select', 'textarea', 'svg', 'object', 'embed', 'meter', 'progress', 'wbr', 'area', 'source', 'track', 'col', 'colgroup', 'option', 'optgroup', 'script', 'style', 'template', 'math']);
const BADGE = 'font:normal normal 10px/1.3 ui-monospace,Consolas,monospace!important;color:#6b4a00!important;background:#fff1bf!important;border:1px solid #d9b04a!important;border-radius:2px!important;padding:0 2px!important;margin:0 1px!important;display:inline-block!important;vertical-align:middle!important;text-decoration:none!important;text-transform:none!important;letter-spacing:0!important;white-space:nowrap!important;float:none!important;position:static!important';

function extrasCss(doc: Document): string {
  const c: string[] = [];
  const tags = flags.revealTags || flags.marks.tags;
  const para = flags.marks.paragraphs;
  if (tags) {
    const names = new Set<string>();
    for (const e of doc.body.querySelectorAll('*')) if (!e.hasAttribute('data-ql-ui')) names.add(e.tagName.toLowerCase());
    for (const n of names) {
      if (NO_PSEUDO.has(n) || !/^[a-z][a-z0-9-]*$/.test(n)) continue;
      const sel = `body ${n}:not([data-ql-ui])`;
      c.push(`${sel}::before{content:"<${n}>";${BADGE}}`, `${sel}[class]::before{content:"<${n}." attr(class) ">"}`, `${sel}[id]::before{content:"<${n}#" attr(id) ">"}`);
      c.push(`${sel}::after{content:"${n === 'p' && para ? '\\00b6' : ''}</${n}>";${BADGE}}`);
    }
    c.push('body img:not([data-ql-ui]),body input:not([data-ql-ui]),body iframe,body video,body audio,body select,body textarea{outline:1px dashed #d9b04a!important}');
  } else if (para) c.push('body p::after{content:"\\00b6";color:#7aa0c8!important;font-weight:normal!important;margin-left:2px}');
  if (flags.marks.breaks) c.push('body br::after{content:"\\21b5";color:#7aa0c8}');
  if (flags.marks.hiddenFields) c.push('body input[type=hidden]{display:inline-block!important;width:12px!important;height:12px!important;background:#dfe9ff!important;border:1px dashed #3a6fd8!important;vertical-align:middle}');
  if (flags.marks.bookmarks) c.push('body a[id]:not([href])::before,body a[name]::before{content:"\\2691";color:#c06000;font-size:85%}');
  if (flags.aidHidden) c.push('body [hidden],body [style*="display:none"],body [style*="display: none"]{display:block!important;opacity:.45;outline:1px dashed #c06000!important}', 'body [style*="visibility:hidden"],body [style*="visibility: hidden"]{visibility:visible!important;opacity:.45}', 'body noscript{display:block!important;opacity:.6;outline:1px dashed #888}');
  if (flags.expandedTables) c.push('body table{border-collapse:separate!important;border-spacing:4px!important;outline:1px solid rgba(0,0,0,.35)!important}', 'body td,body th{padding:8px!important;min-width:24px;min-height:16px;outline:1px dashed rgba(0,0,0,.35)!important}');
  if (flags.media === 'dark') c.push(':root{color-scheme:dark}');
  return c.join('\n');
}

const UI = 'data-ql-ui';

function uiEl(doc: Document, css: string, text = ''): HTMLElement {
  const e = doc.createElement('div');
  e.setAttribute(UI, '');
  e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

/** Puts the style sheet and overlays into a tab's Design frame (idempotent). */
export function applyExtras(app: App, tab: PageTab): void {
  const d = tab.ui?.design;
  const doc = d?.frame.contentDocument as (Document & { _qlExtVer?: number; _qlMedia?: string; _qlHooks?: boolean }) | null;
  if (!d || !doc?.body || !doc.head) return;
  // Media emulation changes the frame's style sheets; going back to normal needs a fresh load.
  const want = `${flags.media}|${flags.disableStyles}`;
  const have = doc._qlMedia || 'screen|false';
  if (want !== have) {
    if (have !== 'screen|false') { doc._qlMedia = 'reloading'; void tab.ui.reloadDesign(); return; }
    emulateMedia(doc);
    doc._qlMedia = want;
  }
  let st = doc.getElementById('ql-view-extras');
  if (!st) { st = doc.createElement('style'); st.id = 'ql-view-extras'; st.setAttribute(UI, ''); doc.head.appendChild(st); }
  const css = extrasCss(doc);
  if (st.textContent !== css) st.textContent = css;
  doc.getElementById('ql-ext-layer')?.remove();
  const layer = uiEl(doc, 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483000;pointer-events:none');
  layer.id = 'ql-ext-layer';
  doc.documentElement.appendChild(layer);
  drawTracing(app, tab, doc, layer);
  if (flags.aidRegions) drawRegions(doc, layer);
  if (flags.guides) drawGuides(app, doc, layer);
  if (app.prefs.showRulers) drawRulers(app, doc, layer);
  if (!doc._qlHooks) {
    doc._qlHooks = true;
    doc.addEventListener('scroll', () => { if (app.prefs.showRulers) { const l = doc.getElementById('ql-ext-layer'); l?.querySelectorAll('[data-ql-ruler]').forEach((r) => r.remove()); if (l) drawRulers(app, doc, l); } });
    doc.addEventListener('mousemove', (e) => inspectMove(doc, e));
    doc.addEventListener('mouseleave', () => doc.getElementById('ql-inspect')?.remove());
  }
  if (!flags.inspect) doc.getElementById('ql-inspect')?.remove();
  doc._qlExtVer = flagsVersion;
}

function emulateMedia(doc: Document): void {
  const mode = flags.media;
  const sheets = [...doc.styleSheets];
  for (const sh of sheets) {
    const owner = sh.ownerNode as Element | null;
    if (owner?.hasAttribute?.(UI)) continue;
    if (flags.disableStyles) { sh.disabled = true; continue; }
    try {
      const mt = sh.media.mediaText;
      if (mode === 'print') {
        if (/\bprint\b/i.test(mt)) sh.media.mediaText = 'all';
        else if (/\bscreen\b/i.test(mt)) sh.disabled = true;
      }
      rewriteRules(sh.cssRules, mode);
    } catch { /* a style sheet the frame cannot read */ }
  }
  if (flags.disableStyles) {
    const s = doc.createElement('style');
    s.setAttribute(UI, '');
    s.textContent = 'body [style]{all:revert!important}';
    doc.head.appendChild(s);
  }
}

const ALWAYS = '(min-width: 0px)', NEVER = '(max-width: 0.01px)';
function rewriteRules(rules: CSSRuleList, mode: Media): void {
  for (const r of [...rules]) {
    const g = r as CSSMediaRule;
    if (g.media && g.media.mediaText != null && g.cssRules) {
      const m = g.media;
      let t = m.mediaText;
      if (mode === 'print') t = t.replace(/\bprint\b/gi, 'all').replace(/(^|,\s*)(only\s+)?screen\b/gi, '$1not all');
      if (mode === 'dark') t = t.replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, ALWAYS).replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, NEVER);
      if (mode === 'reducedMotion') t = t.replace(/\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/gi, ALWAYS).replace(/\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/gi, NEVER);
      if (t !== m.mediaText) { try { m.mediaText = t; } catch { /* */ } }
      rewriteRules(g.cssRules, mode);
    } else if ((r as any).cssRules) rewriteRules((r as any).cssRules, mode);
  }
}

function drawTracing(app: App, tab: PageTab, doc: Document, layer: HTMLElement): void {
  const t = flags.tracing[tab.path];
  if (!t || !t.show) return;
  const src = t.src.startsWith('data:') ? t.src : cacheFor(app).url(t.src, 'blob');
  if (!src) return;
  const img = doc.createElement('img');
  img.setAttribute(UI, '');
  img.src = src;
  img.alt = '';
  img.style.cssText = `position:absolute;left:${t.x}px;top:${t.y}px;opacity:${t.opacity};pointer-events:none;max-width:none;z-index:2147483001;border:0;margin:0;padding:0`;
  layer.appendChild(img);
}

/** Outlines editable regions of attached templates (comments the frame cannot style). */
function drawRegions(doc: Document, layer: HTMLElement): void {
  const it = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const open: { name: string; node: Comment }[] = [];
  const win = doc.defaultView!;
  let c: Node | null;
  while ((c = it.nextNode())) {
    const t = (c as Comment).data;
    const b = /^\s*(?:#BeginEditable\s+"([^"]+)"|(?:Instance|Template)BeginEditable\s+name="([^"]+)")/.exec(t);
    if (b) { open.push({ name: b[1] || b[2], node: c as Comment }); continue; }
    if (/^\s*(?:#EndEditable|(?:Instance|Template)EndEditable)/.test(t)) {
      const o = open.pop();
      if (!o) continue;
      const r = doc.createRange();
      r.setStartAfter(o.node);
      r.setEndBefore(c);
      const rect = r.getBoundingClientRect();
      const x = rect.left + win.scrollX, y = rect.top + win.scrollY;
      const box = uiEl(doc, `position:absolute;left:${x - 2}px;top:${y - 2}px;width:${Math.max(rect.width, 40) + 4}px;height:${Math.max(rect.height, 14) + 4}px;border:1px dashed #e08a00;box-sizing:border-box;pointer-events:none`);
      box.appendChild(uiEl(doc, 'position:absolute;left:-1px;top:-15px;font:10px/14px system-ui,sans-serif;background:#e08a00;color:#fff;padding:0 4px;white-space:nowrap', o.name));
      layer.appendChild(box);
    }
  }
}

function drawGuides(app: App, doc: Document, layer: HTMLElement): void {
  const H = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight), W = Math.max(doc.documentElement.scrollWidth, doc.body.scrollWidth);
  const o = flags.origin;
  const add = (vertical: boolean, v: number, i: number) => {
    const g = uiEl(doc, vertical ? `position:absolute;left:${v + o.x}px;top:0;width:5px;margin-left:-2px;height:${H}px;cursor:ew-resize;pointer-events:auto;background:linear-gradient(90deg,transparent 2px,#18a0fb 2px,#18a0fb 3px,transparent 3px)`
      : `position:absolute;top:${v + o.y}px;left:0;height:5px;margin-top:-2px;width:${W}px;cursor:ns-resize;pointer-events:auto;background:linear-gradient(180deg,transparent 2px,#18a0fb 2px,#18a0fb 3px,transparent 3px)`);
    g.title = `${vertical ? 'Vertical' : 'Horizontal'} guide at ${v}px (click to remove)`;
    g.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); (vertical ? flags.guideList.x : flags.guideList.y).splice(i, 1); saveFlags(); app.refresh(); });
    layer.appendChild(g);
  };
  flags.guideList.x.forEach((v, i) => add(true, v, i));
  flags.guideList.y.forEach((v, i) => add(false, v, i));
}

function drawRulers(app: App, doc: Document, layer: HTMLElement): void {
  const win = doc.defaultView!;
  const W = win.innerWidth, H = win.innerHeight, sx = win.scrollX, sy = win.scrollY, o = flags.origin;
  const base = 'position:fixed;background-color:rgba(246,247,249,.94);pointer-events:auto;font:9px/1 system-ui,sans-serif;color:#555;overflow:hidden;z-index:2147483002;box-sizing:border-box';
  const ticks = (dir: 'right' | 'bottom', off: number) => `background-image:repeating-linear-gradient(to ${dir},#777 0 1px,transparent 1px 100px),repeating-linear-gradient(to ${dir},#999 0 1px,transparent 1px 50px),repeating-linear-gradient(to ${dir},#bbb 0 1px,transparent 1px 10px);background-size:${dir === 'right' ? '100% 100%,100% 8px,100% 4px' : '100% 100%,8px 100%,4px 100%'};background-repeat:repeat;background-position:${dir === 'right' ? `${off}px 0` : `0 ${off}px`}`;
  const top = uiEl(doc, `${base};left:16px;top:0;height:16px;width:${W - 16}px;border-bottom:1px solid #bbb;${ticks('right', o.x - sx - 16)}`);
  const left = uiEl(doc, `${base};left:0;top:16px;width:16px;height:${H - 16}px;border-right:1px solid #bbb;${ticks('bottom', o.y - sy - 16)}`);
  const corner = uiEl(doc, `${base};left:0;top:0;width:16px;height:16px;border-right:1px solid #bbb;border-bottom:1px solid #bbb;cursor:pointer`);
  corner.title = 'Reset the ruler origin';
  for (const r of [top, left, corner]) r.setAttribute('data-ql-ruler', '');
  // Labels every 100px of page coordinates.
  for (let px = Math.floor((sx - o.x) / 100) * 100; px < sx - o.x + W; px += 100) {
    const vx = px + o.x - sx;
    if (vx < 16) continue;
    top.appendChild(uiEl(doc, `position:absolute;left:${vx - 16 + 2}px;top:1px;font:9px/1 system-ui,sans-serif;color:#555`, String(px)));
  }
  for (let py = Math.floor((sy - o.y) / 100) * 100; py < sy - o.y + H; py += 100) {
    const vy = py + o.y - sy;
    if (vy < 16) continue;
    left.appendChild(uiEl(doc, `position:absolute;top:${vy - 16 + 2}px;left:1px;font:9px/1 system-ui,sans-serif;color:#555;writing-mode:vertical-rl`, String(py)));
  }
  top.title = 'Click to add a vertical guide; Shift+click to move the origin here';
  left.title = 'Click to add a horizontal guide; Shift+click to move the origin here';
  top.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const x = Math.round(e.clientX + win.scrollX);
    if (e.shiftKey) flags.origin.x = x; else { flags.guideList.x.push(x - flags.origin.x); flags.guides = true; }
    saveFlags(); app.refresh();
  });
  left.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const y = Math.round(e.clientY + win.scrollY);
    if (e.shiftKey) flags.origin.y = y; else { flags.guideList.y.push(y - flags.origin.y); flags.guides = true; }
    saveFlags(); app.refresh();
  });
  corner.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); flags.origin = { x: 0, y: 0 }; saveFlags(); app.refresh(); });
  layer.append(top, left, corner);
}

function inspectMove(doc: Document, e: MouseEvent): void {
  if (!flags.inspect) return;
  const t = e.target as Element;
  if (!t || t.nodeType !== 1 || t.closest(`[${UI}]`) || t === doc.documentElement) return;
  const win = doc.defaultView!;
  const r = t.getBoundingClientRect();
  const cs = win.getComputedStyle(t);
  let box = doc.getElementById('ql-inspect');
  if (!box) { box = uiEl(doc, ''); box.id = 'ql-inspect'; doc.documentElement.appendChild(box); }
  const m = (p: string) => parseFloat(cs.getPropertyValue(p)) || 0;
  const [mt, mr, mb, ml] = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'].map(m);
  const [pt, pr, pb, pl] = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'].map(m);
  box.style.cssText = `position:absolute;left:${r.left + win.scrollX}px;top:${r.top + win.scrollY}px;width:${r.width}px;height:${r.height}px;pointer-events:none;z-index:2147483003;box-sizing:border-box;outline:1px solid #c2185b;box-shadow:0 0 0 ${0}px transparent;background:rgba(194,24,91,.06);border-style:solid;border-color:rgba(120,200,120,.35);border-width:${pt}px ${pr}px ${pb}px ${pl}px`;
  box.textContent = '';
  const margin = uiEl(doc, `position:absolute;left:${-ml}px;top:${-mt}px;right:${-mr}px;bottom:${-mb}px;outline:1px dashed rgba(230,150,0,.8);pointer-events:none`);
  const cls = (t.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => '.' + c).join('');
  const label = uiEl(doc, `position:absolute;left:-1px;top:${r.top < 18 ? r.height + 2 : -17}px;font:11px/15px system-ui,sans-serif;background:#c2185b;color:#fff;padding:0 4px;white-space:nowrap`,
    `${t.tagName.toLowerCase()}${t.id ? '#' + t.id : ''}${cls}  ${Math.round(r.width)} × ${Math.round(r.height)}  ${cs.display}${cs.position !== 'static' ? ' ' + cs.position : ''}`);
  box.append(margin, label);
}

function touchExtras(app: App): void { saveFlags(); app.refresh(); }

// ==========================================================================================
// Helpers

const VIEWS: ViewMode[] = ['design', 'split', 'code', 'preview'];

function setView(app: App, v: ViewMode): void {
  const t = app.active;
  if (!t) return;
  if (t.kind !== 'page' && (v === 'design' || v === 'split')) { toast('Design view is for pages. Style sheets and scripts open in Code view.'); return; }
  app.setView(t, v);
  setTimeout(() => app.focus(), 0);
}

function switchViews(app: App, dir: 1 | -1): void {
  const t = app.active;
  if (!t) return;
  const list: ViewMode[] = t.kind === 'page' ? ['design', 'split', 'code'] : ['code', 'preview'];
  const i = list.indexOf(t.view);
  app.setView(t, list[(i + dir + list.length) % list.length]);
  setTimeout(() => app.focus(), 0);
}

function prefToggle(app: App, key: keyof App['prefs']): void {
  (app.prefs as any)[key] = !(app.prefs as any)[key];
  app.savePrefs();
  app.ui.applyPrefs();
}

const AID_KEYS = ['aidBlocks', 'aidCssLayout', 'aidEmpty', 'aidMargins', 'aidForms', 'aidTables', 'aidInvisibles'] as const;
const anyAid = (app: App) => AID_KEYS.some((k) => app.prefs[k]) || flags.aidRegions || flags.aidHidden;

function toggleAllAids(app: App): void {
  if (anyAid(app)) {
    flags.savedAids = Object.fromEntries([...AID_KEYS.map((k) => [k, app.prefs[k]]), ['aidRegions', flags.aidRegions], ['aidHidden', flags.aidHidden]]);
    for (const k of AID_KEYS) app.prefs[k] = false;
    flags.aidRegions = false; flags.aidHidden = false;
  } else {
    const s = flags.savedAids;
    for (const k of AID_KEYS) app.prefs[k] = s ? !!s[k] : k !== 'aidMargins' && k !== 'aidBlocks';
    flags.aidRegions = s ? !!s.aidRegions : true;
    flags.aidHidden = s ? !!s.aidHidden : false;
  }
  app.savePrefs();
  saveFlags();
  app.ui.applyPrefs();
}

const anyMark = () => Object.values(flags.marks).some(Boolean);

function zoomOf(app: App): number { return view(app)?.design?.zoom ?? 1; }
function setZoom(app: App, z: number): void {
  const d = view(app)?.design;
  if (!d) { toast('Zoom applies to Design view.'); return; }
  d.setZoom(Math.round(z * 100) / 100);
  app.refresh();
}
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const zoomStep = (z: number, dir: 1 | -1) => (dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) ?? 4 : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? 0.25);

async function zoomDialog(app: App, arg?: number): Promise<void> {
  if (typeof arg === 'number') { setZoom(app, arg > 10 ? arg / 100 : arg); return; }
  const r = await openDialog({ title: 'Zoom', fields: [
    { key: 'preset', label: 'Zoom to', type: 'radio', value: String(Math.round(zoomOf(app) * 100)), options: ['50', '75', '100', '125', '150', '200'].map((v) => ({ value: v, label: `${v}%` })) },
    { key: 'pct', label: 'Percent', type: 'number', value: Math.round(zoomOf(app) * 100), min: 10, max: 400, suffix: '%' },
  ], onChange: (v, ctl, key) => { if (key === 'preset') ctl.set('pct', +v.preset); } });
  if (r) setZoom(app, Math.max(10, Math.min(400, +r.pct || 100)) / 100);
}

function zoomFitWidth(app: App): void {
  const d = view(app)?.design;
  if (!d?.doc) { toast('Zoom applies to Design view.'); return; }
  const z = d.zoom;
  const content = d.doc.documentElement.scrollWidth / z;
  const avail = d.frame.clientWidth;
  if (!content || !avail) return;
  setZoom(app, Math.min(4, Math.max(0.1, avail / content)));
}

async function pageSize(app: App, arg?: any): Promise<void> {
  if (arg === 'menu') {
    const c = getCommand('view.pageSize')!;
    const a = document.activeElement as HTMLElement | null;
    const anchor = a?.closest?.('.ql-modebar button') as HTMLElement | null;
    app.ui.openCommandMenu(c, anchor || app.ui.anchorFor('view.pageSize'));
    return;
  }
  let w: number | null = typeof arg === 'number' ? arg : null;
  if (arg === 'custom' || w == null) {
    const r = await openDialog({ title: 'Page Size', fields: [
      { key: 'size', label: 'Size', type: 'select', value: String(app.prefs.pageWidth), options: [...PAGE_SIZES.map(([v, l]) => ({ value: String(v), label: l })), { value: 'custom', label: 'Custom…' }] },
      { key: 'w', label: 'Width (pixels)', type: 'number', value: app.prefs.pageWidth || 1024, min: 200, max: 5000, visibleIf: (v) => v.size === 'custom' },
      { key: 'info', type: 'info', label: 'Design view and Preview show the page at this width, as a browser window of that size would.' },
    ] });
    if (!r) return;
    w = r.size === 'custom' ? Math.max(200, Math.min(5000, Math.round(+r.w || 1024))) : +r.size;
  }
  app.prefs.pageWidth = Math.max(0, w || 0);
  app.savePrefs();
  app.ui.applyPrefs();
}

async function gridSettings(app: App): Promise<void> {
  const p = app.prefs;
  const r = await openDialog({ title: 'Ruler and Grid Settings', fields: [
    { key: 'gridSize', label: 'Grid spacing', type: 'number', value: p.gridSize, min: 2, max: 200, suffix: 'px' },
    { key: 'showGrid', label: 'Show the grid', type: 'checkbox', value: p.showGrid },
    { key: 'snap', label: 'Snap positioned elements to the grid', type: 'checkbox', value: p.snapToGrid },
    { key: 'rulers', label: 'Show rulers', type: 'checkbox', value: p.showRulers },
    { key: 'guides', label: 'Show guides', type: 'checkbox', value: flags.guides },
    { key: 'clear', label: 'Remove all guides', type: 'checkbox', value: false },
    { key: 'info', type: 'info', label: 'Click a ruler to add a guide, click a guide to remove it, and Shift+click a ruler to move the origin.' },
  ] });
  if (!r) return;
  p.gridSize = Math.max(2, Math.min(200, Math.round(+r.gridSize || 16)));
  p.showGrid = !!r.showGrid; p.snapToGrid = !!r.snap; p.showRulers = !!r.rulers;
  flags.guides = !!r.guides;
  if (r.clear) flags.guideList = { x: [], y: [] };
  app.savePrefs(); saveFlags(); app.ui.applyPrefs();
}

// ------------------------------------------------------------------------------------------
// Tracing image

function tracingFor(app: App): Tracing | null { return app.active ? flags.tracing[app.active.path] || null : null; }

async function tracingImage(app: App, adjustOnly = false): Promise<void> {
  const tab = app.active;
  if (!tab || tab.kind !== 'page') { toast('Open a page first.'); return; }
  const cur = flags.tracing[tab.path];
  if (adjustOnly && !cur) { toast('Choose a tracing image first (View ▸ Tracing Image ▸ Set).'); void tracingImage(app); return; }
  const imgs = app.site.list((f) => isImagePath(f.path)).map((f) => f.path);
  const before = cur ? { ...cur } : null;
  const preview = (v: Record<string, any>) => {
    const t = flags.tracing[tab.path];
    if (!t) return;
    t.opacity = (+v.opacity || 50) / 100; t.x = Math.round(+v.x || 0); t.y = Math.round(+v.y || 0);
    flagsVersion++; app.refresh();
  };
  const r = await openDialog({
    title: adjustOnly ? 'Adjust Tracing Image' : 'Tracing Image',
    fields: [
      ...(adjustOnly ? [] : [
        { key: 'source', label: 'Picture', type: 'select' as const, value: cur && !cur.src.startsWith('data:') ? cur.src : cur ? '__keep' : imgs[0] || '__device', options: [...(cur?.src.startsWith('data:') ? [{ value: '__keep', label: `${cur.name} (from this device)` }] : []), ...imgs.map((p) => ({ value: p, label: p })), { value: '__device', label: 'From this device…' }] },
        { key: 'file', label: 'Picture file', type: 'file' as const, accept: 'image/*', visibleIf: (v: Record<string, any>) => v.source === '__device' },
      ]),
      { key: 'opacity', label: 'Opacity', type: 'range', value: Math.round((cur?.opacity ?? 0.5) * 100), min: 5, max: 100, step: 5, suffix: '%' },
      { key: 'x', label: 'X position', type: 'number', value: cur?.x ?? 0, half: true, suffix: 'px' },
      { key: 'y', label: 'Y position', type: 'number', value: cur?.y ?? 0, half: true, suffix: 'px' },
      { key: 'info', type: 'info', label: 'The tracing image shows behind your work in Design view only, to match a mock-up. It is never added to the page.' },
    ],
    onChange: (v) => preview(v),
  });
  if (!r) { if (before) flags.tracing[tab.path] = before; touchExtras(app); return; }
  let src = cur?.src || '', name = cur?.name || '';
  if (!adjustOnly) {
    if (r.source === '__device') {
      const f = r.file as File | null;
      if (!f) { toast('Choose a picture file.'); return; }
      src = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(f); });
      name = f.name;
    } else if (r.source !== '__keep') { src = r.source; name = baseName(r.source); }
  }
  if (!src) { toast('Choose a picture.'); return; }
  flags.tracing[tab.path] = { src, name, opacity: (+r.opacity || 50) / 100, x: Math.round(+r.x || 0), y: Math.round(+r.y || 0), show: true };
  touchExtras(app);
}

// ------------------------------------------------------------------------------------------
// Head / noscript / related files

async function headContent(app: App): Promise<void> {
  const tab = app.page;
  if (!tab) { toast('Open a page first.'); return; }
  tab.ui.flush();
  const src = tab.source;
  const r = regions(src);
  const inner = r.headOpen && r.headClose >= 0 ? src.slice(r.headOpen[1], r.headClose) : '';
  const items = [...inner.matchAll(/<(title|meta|link|script|style|base|noscript)\b[^>]*>/gi)].map((m) => m[0].length > 90 ? m[0].slice(0, 88) + '…' : m[0]);
  const res = await openDialog({ title: 'Head Content', wide: true, fields: [
    { key: 'list', type: 'info', label: items.length ? `${items.length} items: ` + items.map((s) => s.replace(/\s+/g, ' ')).join('  ·  ') : 'The head of this page is empty.' },
    { key: 'head', label: 'Head markup', type: 'textarea', rows: 14, value: inner.replace(/^\n/, ''), help: 'Everything between <head> and </head>. Design view does not show these items; edit them here or in Code view.' },
  ] });
  if (!res) return;
  const nh = String(res.head);
  app.editSource('Edit Head Content', (s) => {
    const g = regions(s);
    if (g.headOpen && g.headClose >= 0) return s.slice(0, g.headOpen[1]) + (nh.startsWith('\n') ? '' : '\n') + nh.replace(/\s*$/, '\n') + s.slice(g.headClose);
    const html = /<html[^>]*>/i.exec(s);
    const block = `<head>\n${nh.replace(/\s*$/, '\n')}</head>\n`;
    return html ? s.slice(0, html.index + html[0].length) + '\n' + block + s.slice(html.index + html[0].length) : block + s;
  }, tab);
}

async function noscriptContent(app: App): Promise<void> {
  const tab = app.page;
  if (!tab) { toast('Open a page first.'); return; }
  tab.ui.flush();
  const src = tab.source;
  const found = [...src.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi)];
  if (!found.length) {
    const r = await openDialog({ title: 'Noscript Content', fields: [
      { key: 'info', type: 'info', label: 'This page has no <noscript> content. Browsers show noscript content when scripts are turned off.' },
      { key: 'add', label: 'Add noscript content at the end of the body', type: 'textarea', rows: 4, value: '' },
    ] });
    if (r?.add) app.editSource('Add Noscript', (s) => { const g = regions(s); const at = g.bodyClose >= 0 ? g.bodyClose : s.length; return s.slice(0, at) + `<noscript>${r.add}</noscript>\n` + s.slice(at); }, tab);
    return;
  }
  const r = await openDialog({ title: 'Noscript Content', wide: true, fields: found.slice(0, 10).map((m, i) => ({ key: `n${i}`, label: `noscript ${i + 1}`, type: 'textarea' as const, rows: 4, value: m[1] })) });
  if (!r) return;
  app.editSource('Edit Noscript Content', (s) => {
    let i = 0;
    return s.replace(/(<noscript\b[^>]*>)([\s\S]*?)(<\/noscript\s*>)/gi, (m, a, b, c) => { const k = `n${i++}`; return k in r ? a + r[k] + c : m; });
  }, tab);
}

const MEDIA_REF = /<(?:img|source|video|audio|iframe)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const CSS_REF = new RegExp('@import\\s+(?:url\\()?["\']?([^"\')\\s;]+)|url\\(\\s*["\']?([^"\')\\s]+)', 'gi');

function relatedFiles(app: App): MenuEntry[] {
  const tab = app.active;
  if (!tab) return [{ label: 'No file is open' }];
  const src = tab.source;
  const media = [...src.matchAll(MEDIA_REF)].map((m) => m[1]);
  const css = [...src.matchAll(CSS_REF)].map((m) => m[1] || m[2]);
  const refs: string[] = tab.kind === 'page' ? [...linkedStyles(src), ...linkedScripts(src), ...media, ...css] : css;
  const paths = [...new Set(refs.map((r) => resolveRef(tab.path, r)).filter((p): p is string => !!p && app.site.has(p)))];
  const users = app.site.list((f) => f.text != null && f.path !== tab.path && (f.text.includes(baseName(tab.path)))).filter((f) => {
    const t = f.text!; return [...t.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)/gi)].some((m) => resolveRef(f.path, m[1] || m[2]) === tab.path);
  }).map((f) => f.path);
  const out: MenuEntry[] = [];
  if (paths.length) { out.push({ heading: 'Used by this file' }); for (const p of paths) out.push({ id: 'view.relatedFiles', arg: p, label: p, icon: /\.css$/i.test(p) ? 'css' : /\.js$/i.test(p) ? 'javascript' : isImagePath(p) ? 'image' : 'draft' }); }
  if (users.length) { out.push({ heading: 'Files that use this file' }); for (const p of users.slice(0, 30)) out.push({ id: 'view.relatedFiles', arg: p, label: p, icon: 'html' }); }
  if (!out.length) out.push({ label: 'No related files in the site' });
  return out;
}

// ------------------------------------------------------------------------------------------
// Panels and bars

let hiddenPanes: string[] | null = null;
let lastRightPane = '';

function hidePanels(app: App): void {
  const open = (['left', 'right'] as const).map((s) => app.ui.panes[s]?.def.id).filter((x): x is string => !!x);
  if (open.length) { hiddenPanes = open; app.ui.closePane('left'); app.ui.closePane('right'); return; }
  if (hiddenPanes?.length) { for (const id of hiddenPanes) if (PANES[id]) app.ui.openPane(id); hiddenPanes = null; return; }
  toast('No panels are open. Open one from View ▸ Panels.');
}

function taskPane(app: App): void {
  const cur = app.ui.panes.right?.def.id;
  if (cur) { lastRightPane = cur; app.ui.closePane('right'); return; }
  const id = [lastRightPane, 'tagProperties', 'cssProperties', 'find'].find((x) => x && PANES[x] && (PANES[x].side || 'right') === 'right');
  if (id) app.ui.openPane(id); else toast('No task panes are available.');
}

function openSitePane(app: App, id: string, alt?: string): void {
  if (PANES[id]) { app.ui.openPane(id); return; }
  if (alt && getCommand(alt)) { app.exec(alt); return; }
  toast(`The ${id} view is not available in this build.`);
}

async function menuStyle(app: App, arg?: 'ribbon' | 'classic' | 'both'): Promise<void> {
  let v = arg;
  if (!v) {
    const r = await openDialog({ title: 'Menus', fields: [
      { key: 'style', label: 'Show', type: 'radio', value: app.prefs.menuStyle, options: [{ value: 'ribbon', label: 'Ribbon' }, { value: 'classic', label: 'Classic menu bar' }, { value: 'both', label: 'Both (menu bar above the ribbon)' }] },
      { key: 'layout', label: 'Classic menu layout', type: 'select', value: app.prefs.classicMenus, options: Object.entries(CLASSIC_LAYOUT_NAMES).map(([value, label]) => ({ value, label })), visibleIf: (x) => x.style !== 'ribbon' },
      { key: 'info', type: 'info', label: 'Both reach the same commands. The classic menu bar follows the menus of the desktop web editor you choose.' },
    ] });
    if (!r) return;
    v = r.style;
    if (r.layout && r.layout !== app.prefs.classicMenus) { app.prefs.classicMenus = r.layout; app.ui.renderMenuBar(); }
  }
  app.prefs.menuStyle = v || 'both';
  app.savePrefs();
  app.ui.applyPrefs();
}

async function classicLayout(app: App, arg?: string): Promise<void> {
  let v = arg;
  if (!v) {
    const r = await openDialog({ title: 'Classic Menu Layout', fields: [{ key: 'l', label: 'Menu bar layout', type: 'radio', value: app.prefs.classicMenus, options: Object.entries(CLASSIC_LAYOUT_NAMES).map(([value, label]) => ({ value, label })) }] });
    if (!r) return;
    v = r.l;
  }
  if (!v || !(v in CLASSIC_LAYOUT_NAMES)) return;
  app.prefs.classicMenus = v as any;
  if (app.prefs.menuStyle === 'ribbon') app.prefs.menuStyle = 'both';
  app.savePrefs();
  app.ui.applyPrefs();
  app.ui.renderMenuBar();
  toast(`Menu bar: ${CLASSIC_LAYOUT_NAMES[v]}`);
}

function selectInCode(app: App): void {
  const tab = app.page;
  const d = tab?.ui.design;
  if (!tab || !d?.selected || d.selected === d.doc?.body) { toast('Select an element in Design view first.'); return; }
  const el = d.selected;
  const r = sourceRangeOf(tab, el);
  if (tab.view !== 'split' && tab.view !== 'code') app.setView(tab, 'split');
  if (!r) { toast('The element could not be found in the source (the browser may have repaired the markup).'); return; }
  tab.ui.focusArea = 'code';
  setTimeout(() => tab.ui.code?.select(r[0], r[1]), 0);
}

function mediaCmd(app: App, m: Media): void {
  flags.media = flags.media === m && m !== 'screen' ? 'screen' : m;
  touchExtras(app);
}

// ==========================================================================================
// Commands

const page = (app: App) => isPage(app);
const designish = (app: App) => isPage(app);

def([
  // --- page views
  { id: 'view.design', label: 'Design', icon: 'draw', tab: 'View', group: 'Page Views', noRecord: true, kind: 'toggle', popular: true, origin: 'FrontPage, Expression Web', isEnabled: page, isActive: (app) => app.active?.view === 'design', run: (app) => setView(app, 'design') },
  { id: 'view.split', label: 'Split', icon: 'vertical_split', tab: 'View', group: 'Page Views', noRecord: true, kind: 'toggle', popular: true, origin: 'Expression Web, Dreamweaver', isEnabled: page, isActive: (app) => app.active?.view === 'split', run: (app) => setView(app, 'split') },
  { id: 'view.code', label: 'Code', icon: 'code', tab: 'View', group: 'Page Views', noRecord: true, kind: 'toggle', popular: true, origin: 'FrontPage, Expression Web', isEnabled: isText, isActive: (app) => app.active?.view === 'code', run: (app) => setView(app, 'code') },
  { id: 'view.preview', label: 'Preview', icon: 'visibility', tab: 'View', group: 'Page Views', noRecord: true, kind: 'toggle', popular: true, origin: 'FrontPage', tip: 'Run the page with its scripts in a sandbox', isEnabled: isText, isActive: (app) => app.active?.view === 'preview', run: (app) => setView(app, 'preview') },
  { id: 'view.splitVertical', label: 'Split Side by Side', icon: 'view_column_2', tab: 'View', group: 'Page Views', kind: 'toggle', noRecord: true, origin: 'Expression Web 4, Dreamweaver', isActive: (app) => app.prefs.splitVertical, run: (app) => { prefToggle(app, 'splitVertical'); if (app.page && app.page.view !== 'split') app.setView(app.page, 'split'); } },
  { id: 'view.switchViews', label: 'Next View', icon: 'swap_horiz', tab: 'View', group: 'Page Views', keys: ['Mod-PageDown'], noRecord: true, origin: 'Expression Web', tip: 'Design → Split → Code (Ctrl+Page Down; Ctrl+Page Up goes back)', isEnabled: isText, run: (app) => switchViews(app, 1) },
  { id: 'view.switchViewsBack', label: 'Previous View', icon: 'swap_horiz', tab: 'View', group: 'Page Views', keys: ['Mod-PageUp'], noRecord: true, origin: 'Expression Web', isEnabled: isText, run: (app) => switchViews(app, -1) },
  { id: 'view.refresh', label: 'Refresh', icon: 'refresh', tab: 'View', group: 'Page Views', keys: ['F5'], noRecord: true, origin: 'FrontPage, Expression Web', tip: 'Redraw the page from its source', isEnabled: isText, run: (app) => { const t = app.active; if (!t) return; t.ui.flush(); t.ui.code?.setText(t.source); t.ui.invalidate(); t.ui.layout(); app.ui.status?.('Refreshed'); } },
  { id: 'view.liveCode', label: 'Live Code', icon: 'sync_alt', tab: 'View', group: 'Page Views', kind: 'toggle', noRecord: true, origin: 'Dreamweaver', tip: 'In Split view, Code view follows the selection in Design view', isEnabled: page, isActive: () => flags.liveCode, run: (app) => { flags.liveCode = !flags.liveCode; saveFlags(); if (flags.liveCode && app.page && app.page.view !== 'split') app.setView(app.page, 'split'); app.refresh(); } },
  { id: 'view.selectInCode', label: 'Select in Code View', icon: 'code', tab: 'View', group: 'Page Views', noRecord: true, origin: 'Expression Web', isEnabled: page, run: (app) => selectInCode(app) },
  { id: 'view.inspect', label: 'Inspect', icon: 'frame_inspect', tab: 'View', group: 'Page Views', kind: 'toggle', noRecord: true, origin: 'Dreamweaver, browser developer tools', tip: 'Outline the element under the pointer with its size, margins and padding', isEnabled: page, isActive: () => flags.inspect, run: (app) => { flags.inspect = !flags.inspect; touchExtras(app); toast(flags.inspect ? 'Inspect: point at elements in Design view to see their box. Run Inspect again to stop.' : 'Inspect off'); } },

  // --- site views
  { id: 'view.folders', label: 'Folders', icon: 'folder', tab: 'View', group: 'Site Views', noRecord: true, origin: 'FrontPage', run: (app) => openSitePane(app, 'folders') },
  { id: 'view.remoteSite', label: 'Remote Web Site', icon: 'cloud_sync', tab: 'View', group: 'Site Views', noRecord: true, origin: 'FrontPage, Expression Web', run: (app) => { if (PANES.remote) app.ui.openPane('remote'); else if (getCommand('site.synchronize')) app.exec('site.synchronize'); else app.exec('site.publish'); } },
  { id: 'view.reports', label: 'Reports', icon: 'summarize', tab: 'View', group: 'Site Views', noRecord: true, origin: 'FrontPage', run: (app) => openSitePane(app, 'reports', 'site.reportSummary') },
  { id: 'view.hyperlinks', label: 'Hyperlinks', icon: 'link', tab: 'View', group: 'Site Views', noRecord: true, origin: 'FrontPage', run: (app) => openSitePane(app, 'hyperlinks') },
  { id: 'view.navigationView', label: 'Navigation', icon: 'account_tree', tab: 'View', group: 'Site Views', noRecord: true, origin: 'FrontPage', run: (app) => openSitePane(app, 'navigation', 'site.navigation') },
  { id: 'view.tasksView', label: 'Tasks', icon: 'task_alt', tab: 'View', group: 'Site Views', noRecord: true, origin: 'FrontPage', run: (app) => openSitePane(app, 'tasks', 'site.tasks') },

  // --- visual aids
  { id: 'view.aidsShow', label: 'Show Visual Aids', icon: 'visibility', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'Expression Web', tip: 'Turn all visual aids off, or back on', isActive: anyAid, run: (app) => toggleAllAids(app) },
  { id: 'view.aidBlocks', label: 'Block Selection', icon: 'border_outer', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'Expression Web', tip: 'Outline block elements', isActive: (app) => app.prefs.aidBlocks, run: (app) => prefToggle(app, 'aidBlocks') },
  { id: 'view.aidCssLayout', label: 'Positioned Elements', icon: 'picture_in_picture', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'Expression Web (CSS Display: None / Absolutely Positioned Elements)', isActive: (app) => app.prefs.aidCssLayout, run: (app) => prefToggle(app, 'aidCssLayout') },
  { id: 'view.aidEmpty', label: 'Empty Containers', icon: 'check_box_outline_blank', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'Expression Web', isActive: (app) => app.prefs.aidEmpty, run: (app) => prefToggle(app, 'aidEmpty') },
  { id: 'view.aidMargins', label: 'Margins and Padding', icon: 'padding', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'Expression Web', isActive: (app) => app.prefs.aidMargins, run: (app) => prefToggle(app, 'aidMargins') },
  { id: 'view.aidForms', label: 'Form Outlines', icon: 'dynamic_form', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'Dreamweaver (Invisible Elements)', isActive: (app) => app.prefs.aidForms, run: (app) => prefToggle(app, 'aidForms') },
  { id: 'view.aidTables', label: 'Borderless Tables', icon: 'border_clear', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'FrontPage (Show table borders)', isActive: (app) => app.prefs.aidTables, run: (app) => prefToggle(app, 'aidTables') },
  { id: 'view.aidInvisibles', label: 'Visible Borders for Invisible Elements', icon: 'anchor', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'Dreamweaver (Invisible Elements), Expression Web', tip: 'Anchors, line breaks, scripts and hidden elements', isActive: (app) => app.prefs.aidInvisibles, run: (app) => prefToggle(app, 'aidInvisibles') },
  { id: 'view.aidRegions', label: 'Template Region Labels', icon: 'select', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'Expression Web, Dreamweaver', tip: 'Outline and name the editable regions of attached page templates', isActive: () => flags.aidRegions, run: (app) => { flags.aidRegions = !flags.aidRegions; touchExtras(app); } },
  { id: 'view.aidHidden', label: 'Hidden Elements', icon: 'visibility_off', tab: 'Layout', group: 'Visual Aids', kind: 'toggle', noRecord: true, origin: 'Expression Web (CSS Display: None Elements)', tip: 'Show elements hidden by display:none, visibility:hidden or the hidden attribute, faded', isActive: () => flags.aidHidden, run: (app) => { flags.aidHidden = !flags.aidHidden; touchExtras(app); } },

  // --- formatting marks and reveal tags
  { id: 'view.marksShow', label: 'Show Formatting Marks', icon: 'format_paragraph', tab: 'View', group: 'Formatting Marks', kind: 'toggle', noRecord: true, origin: 'Expression Web, FrontPage', keys: ['Mod-Shift-8'], isActive: anyMark, run: (app) => { const on = !anyMark(); for (const k of Object.keys(flags.marks) as (keyof ViewFlags['marks'])[]) flags.marks[k] = on; touchExtras(app); } },
  { id: 'view.marksTags', label: 'Tag Marks', icon: 'code', tab: 'View', group: 'Formatting Marks', kind: 'toggle', noRecord: true, origin: 'Expression Web', isActive: () => flags.marks.tags, run: (app) => { flags.marks.tags = !flags.marks.tags; touchExtras(app); } },
  { id: 'view.marksParagraphs', label: 'Paragraph Marks', icon: 'format_paragraph', tab: 'View', group: 'Formatting Marks', kind: 'toggle', noRecord: true, origin: 'Expression Web, FrontPage', isActive: () => flags.marks.paragraphs, run: (app) => { flags.marks.paragraphs = !flags.marks.paragraphs; touchExtras(app); } },
  { id: 'view.marksBreaks', label: 'Line Breaks', icon: 'keyboard_return', tab: 'View', group: 'Formatting Marks', kind: 'toggle', noRecord: true, origin: 'Expression Web', isActive: () => flags.marks.breaks, run: (app) => { flags.marks.breaks = !flags.marks.breaks; touchExtras(app); } },
  { id: 'view.marksHiddenFields', label: 'Hidden Form Fields', icon: 'password', tab: 'View', group: 'Formatting Marks', kind: 'toggle', noRecord: true, origin: 'Expression Web', isActive: () => flags.marks.hiddenFields, run: (app) => { flags.marks.hiddenFields = !flags.marks.hiddenFields; touchExtras(app); } },
  { id: 'view.marksBookmarks', label: 'Bookmarks', icon: 'flag', tab: 'View', group: 'Formatting Marks', kind: 'toggle', noRecord: true, origin: 'Expression Web, FrontPage', isActive: () => flags.marks.bookmarks, run: (app) => { flags.marks.bookmarks = !flags.marks.bookmarks; touchExtras(app); } },
  { id: 'view.revealTags', label: 'Reveal Tags', icon: 'data_object', tab: 'View', group: 'Formatting Marks', kind: 'toggle', noRecord: true, origin: 'FrontPage, WordPerfect Reveal Codes', tip: 'Show every tag as a badge in Design view', isEnabled: designish, isActive: () => flags.revealTags, run: (app) => { flags.revealTags = !flags.revealTags; touchExtras(app); } },
  { id: 'view.expandedTables', label: 'Expanded Tables', icon: 'table_view', tab: 'View', group: 'Formatting Marks', kind: 'toggle', noRecord: true, origin: 'Dreamweaver', tip: 'Add room around table cells in Design view so they are easy to click', isActive: () => flags.expandedTables, run: (app) => { flags.expandedTables = !flags.expandedTables; touchExtras(app); } },

  // --- ruler, grid, guides, tracing image
  { id: 'view.rulers', label: 'Ruler', icon: 'straighten', tab: 'Layout', group: 'Ruler & Grid', kind: 'toggle', noRecord: true, origin: 'Expression Web, FrontPage', isActive: (app) => app.prefs.showRulers, run: (app) => { prefToggle(app, 'showRulers'); flagsVersion++; app.refresh(); } },
  { id: 'view.grid', label: 'Grid', icon: 'grid_on', tab: 'Layout', group: 'Ruler & Grid', kind: 'toggle', noRecord: true, origin: 'Expression Web, FrontPage', isActive: (app) => app.prefs.showGrid, run: (app) => prefToggle(app, 'showGrid') },
  { id: 'view.snapToGrid', label: 'Snap to Grid', icon: 'grid_goldenratio', tab: 'Layout', group: 'Ruler & Grid', kind: 'toggle', noRecord: true, origin: 'Expression Web, FrontPage', isActive: (app) => app.prefs.snapToGrid, run: (app) => prefToggle(app, 'snapToGrid') },
  { id: 'view.guides', label: 'Guides', icon: 'border_vertical', tab: 'Layout', group: 'Ruler & Grid', kind: 'toggle', noRecord: true, origin: 'Dreamweaver', tip: 'Show guides; click a ruler to add one', isActive: () => flags.guides, run: (app) => { flags.guides = !flags.guides; if (flags.guides && !app.prefs.showRulers && !flags.guideList.x.length && !flags.guideList.y.length) { app.prefs.showRulers = true; app.savePrefs(); app.ui.applyPrefs(); toast('Click the ruler to add a guide.'); } touchExtras(app); } },
  { id: 'view.gridSettings', label: 'Ruler and Grid Settings…', icon: 'settings', tab: 'Layout', group: 'Ruler & Grid', noRecord: true, origin: 'Expression Web', run: (app) => gridSettings(app) },
  { id: 'view.resetOrigin', label: 'Reset Origin', icon: 'restart_alt', tab: 'Layout', group: 'Ruler & Grid', noRecord: true, origin: 'Expression Web, Dreamweaver', run: (app) => { flags.origin = { x: 0, y: 0 }; touchExtras(app); } },
  { id: 'view.tracingImage', label: 'Tracing Image…', icon: 'image', tab: 'Layout', group: 'Ruler & Grid', noRecord: true, origin: 'FrontPage, Expression Web, Dreamweaver', tip: 'Show a mock-up picture behind the page in Design view', isEnabled: page, run: (app) => tracingImage(app) },
  { id: 'view.tracingShow', label: 'Show Tracing Image', icon: 'visibility', tab: 'Layout', group: 'Ruler & Grid', kind: 'toggle', noRecord: true, origin: 'Expression Web', isEnabled: page, isActive: (app) => !!tracingFor(app)?.show, run: (app) => { const t = tracingFor(app); if (!t) { void tracingImage(app); return; } t.show = !t.show; touchExtras(app); } },
  { id: 'view.tracingAlign', label: 'Align Tracing Image with Selection', icon: 'align_horizontal_left', tab: 'Layout', group: 'Ruler & Grid', noRecord: true, origin: 'Dreamweaver', isEnabled: page, run: (app) => {
    const t = tracingFor(app), d = view(app)?.design;
    if (!t) { toast('Choose a tracing image first.'); return; }
    const el = d?.selected;
    if (!d?.doc || !el || el === d.doc.body) { toast('Select an element in Design view first.'); return; }
    const r = el.getBoundingClientRect(), w = d.doc.defaultView!;
    t.x = Math.round(r.left + w.scrollX); t.y = Math.round(r.top + w.scrollY); t.show = true;
    touchExtras(app);
  } },
  { id: 'view.tracingAdjust', label: 'Adjust Tracing Image…', icon: 'tune', tab: 'Layout', group: 'Ruler & Grid', noRecord: true, origin: 'Dreamweaver, Expression Web', isEnabled: page, run: (app) => tracingImage(app, true) },
  { id: 'view.tracingReset', label: 'Reset Tracing Image Position', icon: 'restart_alt', tab: 'Layout', group: 'Ruler & Grid', noRecord: true, origin: 'Dreamweaver', isEnabled: page, run: (app) => { const t = tracingFor(app); if (!t) { toast('There is no tracing image on this page.'); return; } t.x = 0; t.y = 0; touchExtras(app); } },
  { id: 'view.tracingClear', label: 'Remove Tracing Image', icon: 'hide_image', tab: 'Layout', group: 'Ruler & Grid', noRecord: true, origin: 'Expression Web', isEnabled: page, run: (app) => { if (app.active) delete flags.tracing[app.active.path]; touchExtras(app); } },

  // --- page size and zoom
  {
    id: 'view.pageSize', label: 'Page Size', icon: 'devices', tab: 'Design', group: 'Responsive', kind: 'menu', noRecord: true, origin: 'Expression Web (Page Size), Dreamweaver (Window Size)',
    menu: (app) => [...PAGE_SIZES.map(([w, label]) => ({ id: 'view.pageSize', arg: w, label, checked: app.prefs.pageWidth === w })), { separator: true }, { id: 'view.pageSize', arg: 'custom', label: 'Custom Size…' }],
    run: (app, arg) => pageSize(app, arg),
  },
  { id: 'view.zoom', label: 'Zoom…', icon: 'search', tab: 'View', group: 'Zoom', noRecord: true, origin: 'Expression Web', isEnabled: page, value: (app) => `${Math.round(zoomOf(app) * 100)}%`, run: (app, arg) => zoomDialog(app, arg) },
  { id: 'view.zoomIn', label: 'Zoom In', icon: 'zoom_in', tab: 'View', group: 'Zoom', keys: ['Mod-Alt-='], noRecord: true, origin: 'Expression Web', isEnabled: page, run: (app) => setZoom(app, zoomStep(zoomOf(app), 1)) },
  { id: 'view.zoomOut', label: 'Zoom Out', icon: 'zoom_out', tab: 'View', group: 'Zoom', keys: ['Mod-Alt--'], noRecord: true, origin: 'Expression Web', isEnabled: page, run: (app) => setZoom(app, zoomStep(zoomOf(app), -1)) },
  { id: 'view.zoom100', label: '100%', icon: 'crop_free', tab: 'View', group: 'Zoom', keys: ['Mod-Alt-0'], noRecord: true, origin: 'Expression Web', isEnabled: page, run: (app) => setZoom(app, 1) },
  { id: 'view.zoomFitWidth', label: 'Fit Width', icon: 'fit_width', tab: 'View', group: 'Zoom', noRecord: true, origin: 'Dreamweaver', isEnabled: page, run: (app) => zoomFitWidth(app) },

  // --- style rendering
  { id: 'view.mediaScreen', label: 'Screen', icon: 'desktop_windows', tab: 'View', group: 'Style Rendering', kind: 'toggle', noRecord: true, origin: 'Dreamweaver (Style Rendering)', tip: 'Show the page as on a screen (normal)', isActive: () => flags.media === 'screen' && !flags.disableStyles, run: (app) => { flags.media = 'screen'; flags.disableStyles = false; touchExtras(app); } },
  { id: 'view.mediaPrint', label: 'Print', icon: 'print', tab: 'View', group: 'Style Rendering', kind: 'toggle', noRecord: true, origin: 'Dreamweaver (Style Rendering)', tip: 'Apply print style sheets and @media print rules in Design view', isActive: () => flags.media === 'print', run: (app) => mediaCmd(app, 'print') },
  { id: 'view.mediaDark', label: 'Dark Color Scheme', icon: 'dark_mode', tab: 'View', group: 'Style Rendering', kind: 'toggle', noRecord: true, origin: 'browser developer tools', tip: 'Apply prefers-color-scheme: dark rules in Design view', isActive: () => flags.media === 'dark', run: (app) => mediaCmd(app, 'dark') },
  { id: 'view.mediaReducedMotion', label: 'Reduced Motion', icon: 'motion_photos_off', tab: 'View', group: 'Style Rendering', kind: 'toggle', noRecord: true, origin: 'browser developer tools', tip: 'Apply prefers-reduced-motion: reduce rules in Design view', isActive: () => flags.media === 'reducedMotion', run: (app) => mediaCmd(app, 'reducedMotion') },
  { id: 'view.disableStyles', label: 'No Styles', icon: 'format_color_reset', tab: 'View', group: 'Style Rendering', kind: 'toggle', noRecord: true, origin: 'Dreamweaver (Display Styles off), Firefox (No Style)', tip: 'Show the page without its style sheets in Design view', isActive: () => flags.disableStyles, run: (app) => { flags.disableStyles = !flags.disableStyles; touchExtras(app); } },

  // --- code view options
  { id: 'view.codeWrap', label: 'Word Wrap', icon: 'wrap_text', tab: 'Code', group: 'Options', kind: 'toggle', noRecord: true, origin: 'Expression Web', isActive: (app) => app.prefs.codeWrap, run: (app) => prefToggle(app, 'codeWrap') },
  { id: 'view.codeLineNumbers', label: 'Line Numbers', icon: 'format_list_numbered', tab: 'Code', group: 'Options', kind: 'toggle', noRecord: true, origin: 'Expression Web', isActive: (app) => app.prefs.codeLineNumbers, run: (app) => prefToggle(app, 'codeLineNumbers') },
  { id: 'view.codeFold', label: 'Code Collapse', icon: 'unfold_less', tab: 'Code', group: 'Options', kind: 'toggle', noRecord: true, origin: 'Dreamweaver', isActive: (app) => app.prefs.codeFold, run: (app) => prefToggle(app, 'codeFold') },
  { id: 'view.codeHighlightLine', label: 'Highlight Current Line', icon: 'highlight', tab: 'Code', group: 'Options', kind: 'toggle', noRecord: true, origin: 'Expression Web', isActive: (app) => app.prefs.codeHighlightLine, run: (app) => prefToggle(app, 'codeHighlightLine') },
  { id: 'view.codeAutoClose', label: 'Auto-Close Tags and Brackets', icon: 'data_array', tab: 'Code', group: 'Options', kind: 'toggle', noRecord: true, origin: 'Expression Web, Dreamweaver', isActive: (app) => app.prefs.codeAutoClose, run: (app) => prefToggle(app, 'codeAutoClose') },
  { id: 'view.codeComplete', label: 'Code Completion', icon: 'auto_awesome', tab: 'Code', group: 'Options', kind: 'toggle', noRecord: true, origin: 'Expression Web IntelliSense', isActive: (app) => app.prefs.codeComplete, run: (app) => prefToggle(app, 'codeComplete') },
  { id: 'view.codeHiddenChars', label: 'Hidden Characters', icon: 'space_bar', tab: 'Code', group: 'Options', kind: 'toggle', noRecord: true, origin: 'Dreamweaver', tip: 'Show spaces and tabs in Code view', isActive: () => flags.codeHiddenChars, run: (app) => { flags.codeHiddenChars = !flags.codeHiddenChars; touchExtras(app); } },
  { id: 'view.codeHighlightInvalid', label: 'Highlight Incompatible / Invalid Code', icon: 'error', tab: 'Code', group: 'Options', kind: 'toggle', noRecord: true, origin: 'Expression Web, Dreamweaver', tip: 'Underline unmatched start and end tags in Code view', isActive: () => flags.codeHighlightInvalid, run: (app) => { flags.codeHighlightInvalid = !flags.codeHighlightInvalid; touchExtras(app); } },
  { id: 'view.codeFontSize', label: 'Code Font Size…', icon: 'format_size', tab: 'Code', group: 'Options', noRecord: true, origin: 'Expression Web', run: async (app, arg) => {
    let n: number | null = typeof arg === 'number' ? arg : null;
    if (n == null) { const r = await openDialog({ title: 'Code Font Size', fields: [{ key: 'n', label: 'Size', type: 'number', value: app.prefs.codeFontSize, min: 8, max: 40, suffix: 'px' }] }); if (!r) return; n = +r.n; }
    app.prefs.codeFontSize = Math.max(8, Math.min(40, Math.round(n || 13))); app.savePrefs(); app.ui.applyPrefs();
  } },

  // --- menus, ribbon, bars
  { id: 'view.quickTagSelector', label: 'Quick Tag Selector', icon: 'code_blocks', tab: 'View', group: 'Menus', kind: 'toggle', noRecord: true, origin: 'Expression Web', tip: 'The bar of tags above the page', isActive: () => !flags.hideTagBar, run: () => { flags.hideTagBar = !flags.hideTagBar; saveFlags(); applyRootClasses(); } },
  { id: 'view.statusBar', label: 'Status Bar', icon: 'call_to_action', tab: 'View', group: 'Menus', kind: 'toggle', noRecord: true, origin: 'FrontPage', isActive: () => !flags.hideStatus, run: () => { flags.hideStatus = !flags.hideStatus; saveFlags(); applyRootClasses(); } },
  { id: 'view.menuStyle', label: 'Menus…', icon: 'menu_open', tab: 'View', group: 'Menus', noRecord: true, origin: 'Quill suite', tip: 'Ribbon, classic menu bar, or both', run: (app, arg) => menuStyle(app, arg) },
  {
    id: 'view.classicLayout', label: 'Classic Menu Layout', icon: 'menu', tab: 'View', group: 'Menus', kind: 'menu', noRecord: true, origin: 'Expression Web, FrontPage, Dreamweaver, Composer',
    menu: (app) => Object.entries(CLASSIC_LAYOUT_NAMES).map(([k, label]) => ({ id: 'view.classicLayout', arg: k, label, checked: app.prefs.classicMenus === k })),
    run: (app, arg) => classicLayout(app, arg),
  },
  { id: 'view.collapseRibbon', label: 'Collapse the Ribbon', icon: 'expand_less', tab: 'View', group: 'Menus', keys: ['Mod-F1'], kind: 'toggle', noRecord: true, origin: 'Microsoft Office', isActive: (app) => app.prefs.ribbon !== 'full', run: (app) => { app.prefs.ribbon = app.prefs.ribbon === 'full' ? 'tabs' : 'full'; app.savePrefs(); app.ui.applyPrefs(); } },
  {
    id: 'view.toolbars', label: 'Toolbars', icon: 'toolbar', tab: 'View', group: 'Menus', kind: 'menu', noRecord: true, origin: 'FrontPage, Expression Web',
    menu: (app) => [
      { id: 'view.qatToggle', label: 'Quick Access Bar', checked: !app.prefs.qatHidden },
      { id: 'view.collapseRibbon', label: 'Ribbon', checked: app.prefs.ribbon === 'full' },
      { id: 'view.menuStyle', arg: app.prefs.menuStyle === 'ribbon' ? 'both' : 'ribbon', label: 'Menu Bar', checked: app.prefs.menuStyle !== 'ribbon' },
      { id: 'view.quickTagSelector', label: 'Quick Tag Selector', checked: !flags.hideTagBar },
      { id: 'view.statusBar', label: 'Status Bar', checked: !flags.hideStatus },
      { separator: true }, { id: 'file.customizeQat', label: 'Customize…' },
    ],
    run: (app) => app.ui.openCommandMenu(getCommand('view.toolbars')!, app.ui.anchorFor('view.toolbars')),
  },
  { id: 'view.fullScreen', label: 'Full Screen', icon: 'fullscreen', tab: 'View', group: 'Window', kind: 'toggle', noRecord: true, keys: ['Mod-Shift-F11'], origin: 'Microsoft Office', tip: 'Hide the title bar, tabs and ribbon (run again to return)', isActive: () => document.body.classList.contains('ql-fullscreen'), run: () => {
    const on = !document.body.classList.contains('ql-fullscreen');
    document.body.classList.toggle('ql-fullscreen', on);
    try { if (on) void document.documentElement.requestFullscreen?.()?.catch?.(() => {}); else if (document.fullscreenElement) void document.exitFullscreen(); } catch { /* not allowed */ }
  } },
  { id: 'view.cmdSearch', label: 'Search Commands', icon: 'search', tab: 'View', group: 'Window', keys: ['Alt-q'], popular: true, noRecord: true, origin: 'Microsoft Office (Tell Me)', run: (app) => app.ui.commandPalette() },
  { id: 'view.touchMode', label: 'Touch/Mouse Mode', icon: 'touch_app', tab: 'View', group: 'Window', kind: 'toggle', noRecord: true, origin: 'Microsoft Office', tip: 'More space between commands for fingers', isActive: (app) => app.prefs.touchMode, run: (app) => prefToggle(app, 'touchMode') },
  { id: 'view.hidePanels', label: 'Hide All Panels', icon: 'hide', tab: 'View', group: 'Window', keys: ['F4'], kind: 'toggle', noRecord: true, origin: 'Dreamweaver', tip: 'Hide the open panels; run again to bring them back', isActive: () => !!hiddenPanes, run: (app) => hidePanels(app) },
  { id: 'view.taskPane', label: 'Task Pane', icon: 'right_panel_open', tab: 'View', group: 'Window', kind: 'toggle', noRecord: true, origin: 'FrontPage 2003', isActive: (app) => !!app.ui.panes.right, run: (app) => taskPane(app) },

  // --- Quick Access Bar
  { id: 'view.qatAddAll', label: 'Add All Quick Access Choices (A–Z)', icon: 'sort_by_alpha', tab: 'View', group: 'Quick Access Bar', noRecord: true, origin: 'Quill suite', run: (app) => { app.prefs.qat = addAllQatChoices(app.prefs.qat, (id) => getCommand(id)?.label); app.prefs.qatHidden = false; app.savePrefs(); app.ui.applyPrefs(); app.ui.renderQat(); toast('All Quick Access choices added'); } },
  {
    id: 'view.qatPosition', label: 'Quick Access Bar Position', icon: 'swap_vert', tab: 'View', group: 'Quick Access Bar', kind: 'menu', noRecord: true, origin: 'Microsoft Office',
    menu: (app) => (['top', 'below', 'bottom'] as const).map((p) => ({ id: 'view.qatPosition', arg: p, label: p === 'top' ? 'Show Above the Ribbon' : p === 'below' ? 'Show Below the Ribbon' : 'Show at the Bottom (near keyboard)', checked: app.prefs.qatPosition === p })),
    run: (app, pos?: 'top' | 'below' | 'bottom') => { const order: ('top' | 'below' | 'bottom')[] = ['top', 'below', 'bottom']; app.prefs.qatPosition = pos && order.includes(pos) ? pos : order[(order.indexOf(app.prefs.qatPosition) + 1) % 3]; app.savePrefs(); app.ui.applyPrefs(); app.ui.renderQat(); },
  },
  { id: 'view.qatShow', label: 'Show Quick Access Bar', icon: 'bolt', tab: 'View', group: 'Quick Access Bar', noRecord: true, origin: 'Microsoft Office', run: (app) => { app.prefs.qatHidden = false; app.savePrefs(); app.ui.applyPrefs(); } },
  { id: 'view.qatToggle', label: 'Quick Access Bar', icon: 'bolt', tab: 'View', group: 'Quick Access Bar', kind: 'toggle', noRecord: true, origin: 'Microsoft Office', isActive: (app) => !app.prefs.qatHidden, run: (app) => { app.prefs.qatHidden = !app.prefs.qatHidden; app.savePrefs(); app.ui.applyPrefs(); } },

  // --- page content views
  { id: 'view.headContent', label: 'Head Content…', icon: 'data_object', tab: 'View', group: 'Page Content', edits: true, origin: 'Dreamweaver (View ▸ Head Content)', isEnabled: page, run: (app) => headContent(app) },
  { id: 'view.noscriptContent', label: 'Noscript Content…', icon: 'code_off', tab: 'View', group: 'Page Content', edits: true, origin: 'Dreamweaver (View ▸ Noscript Content)', isEnabled: page, run: (app) => noscriptContent(app) },
  {
    id: 'view.relatedFiles', label: 'Related Files', icon: 'file_present', tab: 'View', group: 'Page Content', kind: 'menu', noRecord: true, origin: 'Dreamweaver (Related Files toolbar)', isEnabled: isText,
    menu: (app) => relatedFiles(app),
    run: (app, arg) => { if (typeof arg === 'string' && app.site.has(arg)) { app.openFile(arg); return; } app.ui.openCommandMenu(getCommand('view.relatedFiles')!, app.ui.anchorFor('view.relatedFiles')); },
  },
  { id: 'view.playPlugins', label: 'Play Plug-ins and Scripts', icon: 'play_circle', tab: 'View', group: 'Page Content', noRecord: true, origin: 'Dreamweaver (View ▸ Plugins ▸ Play)', isEnabled: page, run: (app) => { const t = app.page; if (!t) return; app.setView(t, 'preview'); toast('Design view never runs scripts or plug-ins. Preview runs the page and its scripts in a sandbox.'); } },
  { id: 'view.stopPlugins', label: 'Stop Plug-ins and Scripts', icon: 'stop_circle', tab: 'View', group: 'Page Content', noRecord: true, origin: 'Dreamweaver (View ▸ Plugins ▸ Stop)', isEnabled: page, run: (app) => { const t = app.page; if (!t) return; if (t.view === 'preview') app.setView(t, 'split'); toast('Scripts stopped: the page is shown in Design view, which does not run them.'); } },
]);
