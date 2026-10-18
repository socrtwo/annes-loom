/**
 * Design view: the page rendered in an editable frame. Scripts do not run here (the frame is sandboxed
 * without allow-scripts); Preview runs them. Resource links are shown through blob: URLs and restored
 * on serialize (resources.ts). Only the <body> is edited here; head changes are made to the source.
 */
import type { Site } from '../model/site';
import { ResourceCache, rewriteDom, restoreOriginals } from './resources';

export interface VisualAids { blocks: boolean; cssLayout: boolean; invisibles: boolean; forms: boolean; empty: boolean; margins: boolean; grid: boolean; regions: boolean; tables: boolean }

export const DEFAULT_AIDS: VisualAids = { blocks: false, cssLayout: true, invisibles: true, forms: true, empty: true, margins: false, grid: false, regions: true, tables: true };

const UI_ATTR = 'data-ql-ui';

function aidsCss(a: VisualAids, gridSize: number): string {
  const c: string[] = [
    `[${UI_ATTR}]{all:initial}`,
    'html{cursor:text}',
    'img,hr,iframe,video,audio,object,embed,canvas,svg{cursor:default}',
  ];
  if (a.blocks) c.push('body :is(div,p,section,article,aside,header,footer,nav,main,figure,blockquote,ul,ol,li,form,h1,h2,h3,h4,h5,h6,table,pre,address,details,fieldset){outline:1px dashed rgba(80,120,200,.55);outline-offset:-1px}');
  if (a.cssLayout) c.push('body [style*="position:absolute"],body [style*="position: absolute"],body [style*="position:fixed"],body [style*="position: fixed"]{outline:1px solid rgba(220,120,0,.7)}');
  if (a.forms) c.push('body form{outline:1px dotted #d33;outline-offset:2px;min-height:1em}');
  if (a.empty) c.push('body :is(div,p,td,th,li,section,span):empty{min-height:1em;min-width:1em;outline:1px dotted rgba(128,128,128,.6)}', 'body p:empty::before{content:"\\00b6";color:#aaa}');
  if (a.tables) c.push('body table:not([border]),body table[border="0"]{outline:1px dashed rgba(128,128,128,.6)}', 'body table:not([border]) td,body table:not([border]) th,body table[border="0"] td{outline:1px dotted rgba(128,128,128,.4)}');
  if (a.invisibles) c.push('body a[id]:empty::before,body a[name]:empty::before{content:"\\2693";color:#888;font-size:80%}', 'body br::after{content:"\\21b5";color:#aaa}', 'body script,body noscript{display:inline-block;width:14px;height:14px;background:#fd4;border:1px solid #a80;overflow:hidden;color:transparent;vertical-align:middle}', 'body [hidden]{display:block!important;opacity:.4}');
  if (a.margins) c.push('body *:hover{box-shadow:0 0 0 1px rgba(0,150,0,.6),inset 0 0 0 9999px rgba(120,200,120,.08)}');
  if (a.grid) c.push(`html{background-image:linear-gradient(rgba(0,0,0,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(0,0,0,.06) 1px,transparent 1px);background-size:${gridSize}px ${gridSize}px}`);
  return c.join('\n');
}

export class DesignView {
  frame: HTMLIFrameElement;
  doc: Document | null = null;
  selected: Element | null = null;
  private savedRange: Range | null = null;
  private box: HTMLElement | null = null;
  private loadToken = 0;
  onEdit: (() => void) | null = null;
  onSelect: ((el: Element | null) => void) | null = null;
  onKey: ((e: KeyboardEvent) => boolean) | null = null;
  onContext: ((x: number, y: number, el: Element | null) => void) | null = null;
  onNavigate: ((href: string) => void) | null = null;
  aids: VisualAids = { ...DEFAULT_AIDS };
  gridSize = 16;
  zoom = 1;
  editable = true;
  useStrongEm = true;
  /** Absolute-position dragging snaps to the grid when on. */
  snap = false;

  constructor(public el: HTMLElement, public site: Site, public cache: ResourceCache) {
    this.frame = document.createElement('iframe');
    this.frame.className = 'ql-design-frame';
    this.frame.setAttribute('sandbox', 'allow-same-origin');
    this.frame.title = 'Design view';
    el.appendChild(this.frame);
  }

  /** Shows `src` as page `path`. Resolves when the frame is editable. */
  load(src: string, path: string): Promise<void> {
    const token = ++this.loadToken;
    const parsed = new DOMParser().parseFromString(src, 'text/html');
    rewriteDom(parsed, path, this.cache, 'blob', true);
    const style = parsed.createElement('style');
    style.id = 'ql-aids';
    style.setAttribute(UI_ATTR, '');
    style.textContent = aidsCss(this.aids, this.gridSize);
    parsed.head.appendChild(style);
    const dt = /^\s*<!DOCTYPE[^>]*>/i.exec(src)?.[0] || '';
    const html = dt + parsed.documentElement.outerHTML;
    return new Promise((resolve) => {
      const done = () => {
        if (token !== this.loadToken) return resolve();
        this.attach();
        resolve();
      };
      this.frame.addEventListener('load', done, { once: true });
      this.frame.srcdoc = html;
    });
  }

  private attach(): void {
    const doc = this.frame.contentDocument;
    if (!doc) return;
    this.doc = doc;
    this.selected = null;
    this.savedRange = null;
    if (!doc.body) doc.documentElement.appendChild(doc.createElement('body'));
    doc.body.contentEditable = this.editable ? 'true' : 'false';
    doc.body.spellcheck = true;
    try { doc.execCommand('styleWithCSS', false, 'false'); doc.execCommand('defaultParagraphSeparator', false, 'p'); doc.execCommand('enableObjectResizing', false, 'true'); doc.execCommand('enableInlineTableEditing', false, 'true'); } catch { /* not every engine has these */ }
    this.applyZoom();
    this.box = doc.createElement('div');
    this.box.setAttribute(UI_ATTR, '');
    this.box.style.cssText = 'position:absolute;pointer-events:none;border:1px solid #2b79d6;box-shadow:0 0 0 1px rgba(255,255,255,.7);z-index:2147483646;display:none';
    const tag = doc.createElement('span');
    tag.style.cssText = 'position:absolute;left:-1px;top:-17px;font:11px/15px system-ui,sans-serif;background:#2b79d6;color:#fff;padding:0 4px;white-space:nowrap;pointer-events:auto;cursor:move';
    this.box.appendChild(tag);
    doc.documentElement.appendChild(this.box);
    tag.addEventListener('mousedown', (e) => this.startDrag(e));

    doc.addEventListener('input', () => { this.updateBox(); this.onEdit?.(); });
    doc.addEventListener('selectionchange', () => this.fromSelection());
    doc.addEventListener('mousedown', (e) => {
      const t = e.target as Element;
      if (t.closest?.(`[${UI_ATTR}]`)) return;
      if (/^(IMG|HR|IFRAME|VIDEO|AUDIO|OBJECT|EMBED|CANVAS|INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName) || t.closest?.('svg')) {
        this.select(t.closest?.('svg') || t);
      }
    });
    doc.addEventListener('click', (e) => {
      const a = (e.target as Element).closest?.('a[href]');
      if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.onNavigate?.(a.getAttribute('data-ql-o-href') || a.getAttribute('href')!); }
    });
    doc.addEventListener('dblclick', (e) => { const t = e.target as Element; if (t.tagName === 'IMG') this.select(t); });
    doc.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = this.frame.getBoundingClientRect();
      const t = e.target as Element;
      if (!this.selected || !this.selected.contains(t)) this.select(t.nodeType === 1 ? t : t.parentElement);
      this.onContext?.(r.left + e.clientX * this.zoom, r.top + e.clientY * this.zoom, this.selected);
    });
    doc.addEventListener('keydown', (e) => { if (this.onKey?.(e)) { e.preventDefault(); e.stopPropagation(); } }, true);
    doc.addEventListener('scroll', () => this.updateBox());
    this.frame.contentWindow?.addEventListener('resize', () => this.updateBox());
    // Dropped files are handled by the workspace; dropped text and HTML are handled by the browser.
    doc.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  }

  setAids(a: Partial<VisualAids>): void {
    Object.assign(this.aids, a);
    const s = this.doc?.getElementById('ql-aids');
    if (s) s.textContent = aidsCss(this.aids, this.gridSize);
  }

  setEditable(on: boolean): void { this.editable = on; if (this.doc?.body) this.doc.body.contentEditable = on ? 'true' : 'false'; }

  setZoom(z: number): void { this.zoom = Math.max(0.1, Math.min(4, z)); this.applyZoom(); }
  private applyZoom(): void { if (this.doc?.documentElement) (this.doc.documentElement.style as any).zoom = this.zoom === 1 ? '' : String(this.zoom); this.updateBox(); }

  // ----------------------------------------------------------------------------------------
  // Selection

  private fromSelection(): void {
    const doc = this.doc;
    if (!doc) return;
    const sel = doc.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!doc.body.contains(r.commonAncestorContainer)) return;
    this.savedRange = r.cloneRange();
    let n: Node | null = r.commonAncestorContainer;
    if (n.nodeType !== 1) n = n.parentNode;
    // A selection that is exactly one element selects that element.
    if (!r.collapsed && r.startContainer === r.endContainer && r.startContainer.nodeType === 1 && r.endOffset - r.startOffset === 1) n = r.startContainer.childNodes[r.startOffset];
    const el = n as Element;
    if (el && el !== this.selected) { this.selected = el; this.updateBox(); this.onSelect?.(el); }
  }

  select(el: Element | null, opts: { contents?: boolean } = {}): void {
    const doc = this.doc;
    if (!doc) return;
    if (el && (el === doc.documentElement || el.hasAttribute(UI_ATTR))) el = doc.body;
    this.selected = el;
    if (el && el !== doc.body && el !== doc.documentElement) {
      const r = doc.createRange();
      if (opts.contents) r.selectNodeContents(el); else r.selectNode(el);
      const sel = doc.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      this.savedRange = r.cloneRange();
      if (!/^(IMG|HR|INPUT)$/.test(el.tagName)) (el as HTMLElement).scrollIntoView?.({ block: 'nearest' });
    }
    this.updateBox();
    this.onSelect?.(el);
  }

  /** The ancestors of the selection, outermost first, for the Quick Tag Selector. */
  ancestry(): Element[] {
    const out: Element[] = [];
    let n: Element | null = this.selected;
    while (n && n !== this.doc?.documentElement) { out.unshift(n); n = n.parentElement; }
    return out;
  }

  updateBox(): void {
    const b = this.box, el = this.selected, doc = this.doc;
    if (!b || !doc) return;
    if (!el || el === doc.body || !el.isConnected) { b.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    const win = doc.defaultView!;
    b.style.display = 'block';
    b.style.left = `${r.left + win.scrollX - 1}px`;
    b.style.top = `${r.top + win.scrollY - 1}px`;
    b.style.width = `${r.width}px`;
    b.style.height = `${r.height}px`;
    const label = b.firstChild as HTMLElement;
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('');
    label.textContent = `${el.tagName.toLowerCase()}${id}${cls}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
    label.style.top = r.top < 18 ? `${r.height}px` : '-17px';
  }

  restoreRange(): Range | null {
    const doc = this.doc;
    if (!doc) return null;
    const sel = doc.getSelection();
    if (this.savedRange && doc.body.contains(this.savedRange.commonAncestorContainer)) {
      sel?.removeAllRanges();
      sel?.addRange(this.savedRange);
      return this.savedRange;
    }
    return sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  }

  selectedText(): string {
    const r = this.restoreRange();
    return r ? r.toString() : '';
  }

  selectedHtml(): string {
    const r = this.restoreRange();
    if (!r || r.collapsed) return '';
    const d = this.doc!.createElement('div');
    d.appendChild(r.cloneContents());
    restoreOriginals(d);
    return d.innerHTML;
  }

  focus(): void { try { this.frame.contentWindow?.focus(); this.restoreRange(); } catch { /* */ } }

  // ----------------------------------------------------------------------------------------
  // Editing

  /** Runs a browser editing command on the selection. */
  exec(cmd: string, value?: string): boolean {
    const doc = this.doc;
    if (!doc || !this.editable) return false;
    this.focus();
    this.restoreRange();
    let ok = false;
    try { ok = doc.execCommand(cmd, false, value); } catch { ok = false; }
    this.changed();
    return ok;
  }

  queryState(cmd: string): boolean { try { return !!this.doc?.queryCommandState(cmd); } catch { return false; } }
  queryValue(cmd: string): string { try { return this.doc?.queryCommandValue(cmd) || ''; } catch { return ''; } }

  /** Inserts markup at the caret (replacing the selection). Resource links in it are made displayable. */
  insertHtml(markup: string, pagePath: string): void {
    const doc = this.doc;
    if (!doc) return;
    const tmp = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
    rewriteDom(tmp, pagePath, this.cache, 'blob', true);
    const html = tmp.body.innerHTML;
    this.focus();
    const r = this.restoreRange();
    if (!r || !doc.body.contains(r.commonAncestorContainer)) {
      doc.body.insertAdjacentHTML('beforeend', html);
    } else if (!doc.execCommand('insertHTML', false, html)) {
      const frag = r.createContextualFragment(html);
      r.deleteContents();
      r.insertNode(frag);
    }
    this.changed();
  }

  /** Changes the document directly (DOM) and reports one edit. */
  mutate(fn: (doc: Document) => void): void {
    if (!this.doc) return;
    fn(this.doc);
    this.changed();
  }

  changed(): void { this.updateBox(); this.onEdit?.(); }

  // ----------------------------------------------------------------------------------------
  // Serialize

  /** The edited body as source: inner HTML and the <body> start tag. */
  serialize(): { inner: string; openTag: string } | null {
    const doc = this.doc;
    if (!doc?.body) return null;
    const body = doc.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll(`[${UI_ATTR}]`).forEach((e) => e.remove());
    body.removeAttribute('contenteditable');
    body.removeAttribute('spellcheck');
    restoreOriginals(body);
    for (const e of body.querySelectorAll('[style=""]')) e.removeAttribute('style');
    for (const e of body.querySelectorAll('[class=""]')) e.removeAttribute('class');
    if (this.useStrongEm) {
      for (const [from, to] of [['b', 'strong'], ['i', 'em']]) for (const e of body.querySelectorAll(from)) renameElement(e, to);
    }
    const attrs = [...body.attributes].map((a) => ` ${a.name}${a.value === '' && /^(hidden|inert)$/.test(a.name) ? '' : `="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`}`).join('');
    return { inner: body.innerHTML, openTag: `<body${attrs}>` };
  }

  // ----------------------------------------------------------------------------------------
  // Absolutely positioned elements: drag the label to move.

  private startDrag(e: MouseEvent): void {
    const el = this.selected as HTMLElement | null;
    const doc = this.doc;
    if (!el || !doc) return;
    const cs = doc.defaultView!.getComputedStyle(el);
    if (cs.position !== 'absolute' && cs.position !== 'fixed' && cs.position !== 'relative') return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const l0 = parseFloat(cs.left) || 0, t0 = parseFloat(cs.top) || 0;
    const g = this.snap ? this.gridSize : 1;
    const move = (ev: MouseEvent) => {
      el.style.left = `${Math.round((l0 + (ev.clientX - sx)) / g) * g}px`;
      el.style.top = `${Math.round((t0 + (ev.clientY - sy)) / g) * g}px`;
      this.updateBox();
    };
    const up = () => { doc.removeEventListener('mousemove', move); doc.removeEventListener('mouseup', up); this.changed(); };
    doc.addEventListener('mousemove', move);
    doc.addEventListener('mouseup', up);
  }

  destroy(): void { this.frame.remove(); }
}

export function renameElement(e: Element, tag: string): Element {
  const n = e.ownerDocument.createElement(tag);
  for (const a of e.attributes) n.setAttribute(a.name, a.value);
  while (e.firstChild) n.appendChild(e.firstChild);
  e.replaceWith(n);
  return n;
}
