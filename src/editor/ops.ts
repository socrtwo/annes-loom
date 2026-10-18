/**
 * Editing helpers shared by the command modules. Each helper works in whichever view has focus:
 * in Design view on the live page, in Code view on the text at the cursor.
 */
import type { App } from '../app';
import { toast } from '../ui/dialog';
import type { PageView } from './workspace';
import { ResourceCache, rewriteDom } from './resources';
import { cacheFor } from './workspace';
import { esc, escAttr } from '../model/html';
import { resolveRef } from '../model/paths';

export const view = (app: App): PageView | undefined => app.active?.ui;

/** True when a page (not a style sheet or picture) is active. */
export const isPage = (app: App) => app.active?.kind === 'page';
export const isText = (app: App) => app.active?.kind === 'page' || app.active?.kind === 'text';
export const inDesign = (app: App) => isPage(app) && view(app)?.target === 'design';
export const inCode = (app: App) => isText(app) && view(app)?.target === 'code';

export function requirePage(app: App): PageView | null {
  if (!isPage(app)) { toast('Open a page first.'); return null; }
  return view(app)!;
}

/** The element selected in Design view (the caret's element), or null. */
export function selectedEl(app: App): HTMLElement | null {
  const v = view(app);
  if (!v?.design?.doc) return null;
  const s = v.design.selected as HTMLElement | null;
  return s && s !== v.design.doc.documentElement ? s : v.design.doc.body;
}

/** The nearest selected element matching a selector (the table cell, the link, the form). */
export function closestSel(app: App, selector: string): HTMLElement | null {
  const el = selectedEl(app);
  return (el?.closest?.(selector) as HTMLElement) || null;
}

export function selectionText(app: App): string {
  const v = view(app);
  if (!v) return '';
  if (v.target === 'code') return v.code?.selection.text || '';
  return v.design?.selectedText() || '';
}

export function selectionHtml(app: App): string {
  const v = view(app);
  if (!v) return '';
  if (v.target === 'code') return v.code?.selection.text || '';
  return v.design?.selectedHtml() || '';
}

/** Inserts markup at the cursor in the focused view. */
export function insertHtml(app: App, markup: string): void {
  const v = view(app);
  if (!v || app.isReadOnly()) return;
  if (v.target === 'code') v.code?.replaceSelection(markup);
  else v.design?.insertHtml(markup, app.active.path);
  v.flush();
}

/** Wraps the selection in a start/end tag pair; with nothing selected inserts the pair with `placeholder`. */
export function wrapSelection(app: App, open: string, close: string, placeholder = ''): void {
  const v = view(app);
  if (!v) return;
  const inner = selectionHtml(app) || esc(placeholder);
  insertHtml(app, open + inner + close);
}

/** Wraps the selection in an element: <tag attrs>…</tag>. */
export function wrapTag(app: App, tag: string, attrs: Record<string, string | null | undefined> = {}, placeholder = ''): void {
  wrapSelection(app, `<${tag}${attrString(attrs)}>`, `</${tag}>`, placeholder);
}

export function attrString(attrs: Record<string, string | null | undefined | boolean>): string {
  return Object.entries(attrs).filter(([, v]) => v != null && v !== false && v !== '').map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escAttr(String(v))}"`)).join('');
}

/** A browser editing command in Design view; in Code view, the equivalent tag pair. */
export function richCommand(app: App, cmd: string, value?: string, codeTag?: [string, string]): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'design' && v.design) { v.design.exec(cmd, value); v.flush(); return; }
  if (codeTag) wrapSelection(app, codeTag[0], codeTag[1]);
  else toast('Switch to Design view for this command, or select text in Design view.');
}

/** Changes the page DOM in Design view as one edit. */
export function mutate(app: App, fn: (doc: Document) => void): boolean {
  const v = view(app);
  if (!v?.design?.doc) { toast('This command works in Design view.'); return false; }
  if (v.tab.view === 'code' || v.tab.view === 'preview') { app.setView(v.tab, 'split'); toast('Switched to Split view; run the command again in Design view.'); return false; }
  v.design.mutate(fn);
  v.flush();
  return true;
}

/** Sets an attribute in Design view, keeping resource-link originals in step (resources.ts). */
export function setAttr(app: App, el: Element, name: string, value: string | null): void {
  const v = view(app);
  if (value == null || value === '') { el.removeAttribute(name); el.removeAttribute(`data-ql-o-${name}`); return; }
  const isRes = /^(src|href|poster|data|background|srcset)$/.test(name);
  if (isRes && v?.design) {
    const p = resolveRef(app.active.path, value);
    const shown = p ? cacheFor(app).url(p, 'blob') : null;
    if (shown && !(el.tagName === 'A' && name === 'href')) { el.setAttribute(`data-ql-o-${name}`, value); el.setAttribute(name, shown); return; }
  }
  el.removeAttribute(`data-ql-o-${name}`);
  el.setAttribute(name, value);
}

/** The attribute's real value (not the displayed blob: URL). */
export function getAttr(el: Element, name: string): string | null {
  return el.getAttribute(`data-ql-o-${name}`) ?? el.getAttribute(name);
}

/** Sets one CSS property on an element's style attribute (null removes it). */
export function setStyleProp(app: App, el: HTMLElement, prop: string, value: string | null): void {
  const orig = el.getAttribute('data-ql-o-style');
  const tmp = document.createElement('div');
  tmp.setAttribute('style', orig ?? el.getAttribute('style') ?? '');
  if (value == null || value === '') tmp.style.removeProperty(prop); else tmp.style.setProperty(prop, value);
  const css = tmp.getAttribute('style') || '';
  if (orig != null) {
    el.setAttribute('data-ql-o-style', css);
    el.setAttribute('style', new ResourceCache(app.site).css(css, app.active.path, 'blob'));
  } else if (css) el.setAttribute('style', css); else el.removeAttribute('style');
}

export function styleOf(el: Element): string { return el.getAttribute('data-ql-o-style') ?? el.getAttribute('style') ?? ''; }

/** Wraps or changes the block that holds the caret (p, h1…h6, pre, address, blockquote, div). */
export function formatBlock(app: App, tag: string): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'design' && v.design) {
    const el = selectedEl(app);
    const block = el?.closest('p,h1,h2,h3,h4,h5,h6,pre,address,div,blockquote,li,dt,dd,td,th');
    if (block && !/^(LI|DT|DD|TD|TH)$/.test(block.tagName) && block !== v.design.doc!.body && tag.toLowerCase() !== 'blockquote') {
      v.design.mutate(() => { const n = block.ownerDocument.createElement(tag); for (const a of block.attributes) n.setAttribute(a.name, a.value); while (block.firstChild) n.appendChild(block.firstChild); block.replaceWith(n); v.design!.select(n, { contents: true }); });
    } else v.design.exec('formatBlock', `<${tag}>`);
    v.flush();
    return;
  }
  wrapTag(app, tag);
}

/** Removes the selected element, keeping its contents ("Remove Tag"). */
export function unwrap(el: Element): void {
  const p = el.parentNode;
  if (!p) return;
  while (el.firstChild) p.insertBefore(el.firstChild, el);
  el.remove();
}

/** Outer HTML of a Design view element as source (original resource links restored). */
export function outerSource(el: Element): string {
  const c = el.cloneNode(true) as Element;
  for (const e of [c, ...c.querySelectorAll('*')]) {
    for (const a of [...e.attributes]) if (a.name.startsWith('data-ql-o-')) { const n = a.name.slice(10); if (n === 'text') e.textContent = a.value; else if (n === 'type' && a.value === '') e.removeAttribute('type'); else e.setAttribute(n, a.value); e.removeAttribute(a.name); }
  }
  c.querySelectorAll('[data-ql-ui]').forEach((x) => x.remove());
  return c.outerHTML;
}

/** Replaces a Design view element with markup. */
export function replaceElement(app: App, el: Element, markup: string): void {
  const tmp = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  rewriteDom(tmp, app.active.path, cacheFor(app), 'blob', true);
  const doc = el.ownerDocument;
  const frag = doc.createDocumentFragment();
  for (const n of [...tmp.body.childNodes]) frag.appendChild(doc.importNode(n, true));
  el.replaceWith(frag);
}
