/**
 * Style panes (right side): Tag Properties, CSS Properties, Apply Styles, Manage Styles, Layers and CSS Reports.
 * They read the Design view selection and the page's style sheets (commands/css.ts pageSheets) and write
 * through the same helpers the CSS commands use, so every change is one undo step in the right file.
 */
import type { App } from '../app';
import { registerPane, sigOf, typingIn } from './panes';
import { h, icon, clear } from './dom';
import { toast, promptDialog, confirmDialog, showMenu } from './dialog';
import * as C from '../model/css';
import { isPage, view, selectedEl, mutate, setAttr, getAttr, styleOf } from '../editor/ops';
import { cacheFor } from '../editor/workspace';
import { isPagePath } from '../model/paths';
import {
  pageSheets, writeSheet, setInline, modifyRule, applyClass, definedClasses, previewStyle, track, fileText, editFile, inlineOf, removeClass, type SheetRef,
} from '../commands/css';

// ------------------------------------------------------------------------------------------
// Shared bits

const ids = new WeakMap<object, number>();
let idn = 0;
const idOf = (o: object | null | undefined) => { if (!o) return 0; let n = ids.get(o); if (!n) { n = ++idn; ids.set(o, n); } return n; };

const designOn = (app: App) => isPage(app) && !!view(app)?.design?.doc && app.active.view !== 'code' && app.active.view !== 'preview';

function note(el: HTMLElement, text: string): void { el.appendChild(h('p', { class: 'ql-help' }, text)); }

function tools(...btns: [string, string, () => void][]): HTMLElement {
  return h('div', { class: 'ql-row ql-pane-tools' }, ...btns.map(([ic, title, fn]) => h('button', { class: 'ql-iconbtn ql-sm', title, 'aria-label': title, type: 'button', onclick: fn }, icon(ic))));
}

const rowStyle = 'display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;cursor:pointer;min-height:26px';
const cellInput = (value: string, onCommit: (v: string) => void, opts: { list?: string; placeholder?: string; label?: string } = {}) => {
  const inp = h('input', { value, placeholder: opts.placeholder || '', 'aria-label': opts.label || '', list: opts.list || null, style: 'flex:1;min-width:0;font:12px ui-monospace,Consolas,monospace;padding:2px 4px' }) as HTMLInputElement;
  const commit = () => { if (inp.value !== value) { value = inp.value; onCommit(inp.value); } };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); } if (e.key === 'Escape') { inp.value = value; inp.blur(); } });
  return inp;
};

function datalist(id: string, values: string[]): HTMLElement {
  return h('datalist', { id }, ...values.map((v) => h('option', { value: v })));
}

/** The element as a short label: tag#id.class */
const elLabel = (e: Element) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + [...e.classList].slice(0, 2).map((c) => '.' + c).join('');

// ------------------------------------------------------------------------------------------
// Tag Properties

const GLOBAL_ATTRS = ['id', 'class', 'style', 'title', 'lang', 'dir', 'hidden', 'tabindex', 'accesskey', 'role', 'aria-label', 'aria-describedby', 'aria-hidden', 'contenteditable', 'draggable', 'spellcheck', 'translate', 'inert', 'popover', 'data-'];
const TAG_ATTRS: Record<string, string[]> = {
  a: ['href', 'target', 'rel', 'download', 'hreflang', 'type', 'name', 'referrerpolicy', 'ping'],
  img: ['src', 'alt', 'width', 'height', 'srcset', 'sizes', 'loading', 'decoding', 'fetchpriority', 'usemap', 'ismap', 'crossorigin'],
  table: ['border', 'cellpadding', 'cellspacing', 'summary', 'width', 'align', 'bgcolor'],
  td: ['colspan', 'rowspan', 'headers', 'align', 'valign', 'width', 'height', 'bgcolor', 'nowrap'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr', 'align', 'valign', 'width'],
  tr: ['align', 'valign', 'bgcolor'],
  input: ['type', 'name', 'value', 'placeholder', 'required', 'disabled', 'readonly', 'checked', 'min', 'max', 'step', 'pattern', 'autocomplete', 'size', 'maxlength', 'minlength', 'list', 'multiple', 'accept', 'form', 'autofocus'],
  form: ['action', 'method', 'enctype', 'target', 'novalidate', 'autocomplete', 'name', 'accept-charset'],
  button: ['type', 'name', 'value', 'disabled', 'form', 'formaction', 'autofocus', 'popovertarget'],
  select: ['name', 'multiple', 'size', 'required', 'disabled', 'form', 'autocomplete'],
  option: ['value', 'selected', 'disabled', 'label'],
  textarea: ['name', 'rows', 'cols', 'placeholder', 'required', 'disabled', 'readonly', 'maxlength', 'wrap'],
  label: ['for', 'form'],
  iframe: ['src', 'width', 'height', 'title', 'name', 'loading', 'allow', 'allowfullscreen', 'sandbox', 'referrerpolicy', 'srcdoc'],
  video: ['src', 'controls', 'autoplay', 'loop', 'muted', 'preload', 'poster', 'width', 'height', 'playsinline'],
  audio: ['src', 'controls', 'autoplay', 'loop', 'muted', 'preload'],
  source: ['src', 'srcset', 'type', 'media', 'sizes'],
  ol: ['start', 'reversed', 'type'], ul: ['type'], li: ['value'],
  blockquote: ['cite'], q: ['cite'], ins: ['cite', 'datetime'], del: ['cite', 'datetime'], time: ['datetime'], abbr: ['title'],
  meter: ['value', 'min', 'max', 'low', 'high', 'optimum'], progress: ['value', 'max'], details: ['open', 'name'], dialog: ['open'],
  area: ['shape', 'coords', 'href', 'alt', 'target'], col: ['span', 'width'], colgroup: ['span'], body: ['bgcolor', 'background', 'text', 'link', 'vlink', 'alink'],
  object: ['data', 'type', 'width', 'height', 'name'], embed: ['src', 'type', 'width', 'height'], canvas: ['width', 'height'], div: ['align'], p: ['align'],
};

/** Sets an attribute the way the source expects (style keeps its original resource links). */
function setRealAttr(app: App, el: HTMLElement, name: string, value: string | null): void {
  if (name === 'style') {
    if (value == null || value === '') { el.removeAttribute('style'); el.removeAttribute('data-ql-o-style'); return; }
    if (/url\(/i.test(value)) { el.setAttribute('data-ql-o-style', value); el.setAttribute('style', cacheFor(app).css(value, app.active.path, 'blob')); }
    else { el.removeAttribute('data-ql-o-style'); el.setAttribute('style', value); }
    return;
  }
  if (name === 'class' || name === 'id') { if (value == null || value === '') el.removeAttribute(name); else el.setAttribute(name, value); return; }
  setAttr(app, el, name, value);
}

const realAttrs = (el: Element) => [...el.attributes].filter((a) => !a.name.startsWith('data-ql-') && !(el.tagName === 'BODY' && (a.name === 'contenteditable' || a.name === 'spellcheck'))).map((a) => [a.name, getAttr(el, a.name) ?? ''] as [string, string]);

registerPane({
  id: 'tagProperties', title: 'Tag Properties', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    track(app);
    const sel = designOn(app) ? selectedEl(app) : null;
    const attrs = sel ? realAttrs(sel) : [];
    if (!sigOf(el, `${app.active?.id}:${idOf(sel)}:${JSON.stringify(attrs)}`) || typingIn(el)) return;
    clear(el);
    if (!sel) { note(el, 'Select an element in Design view to see and edit its attributes.'); return; }
    const tag = sel.tagName.toLowerCase();
    el.appendChild(h('div', { class: 'ql-pane-h' }, icon('code'), h('strong', null, `<${tag}>`), h('span', { class: 'ql-help', style: 'margin:0 0 0 auto' }, `${attrs.length} attribute${attrs.length === 1 ? '' : 's'}`)));
    const grid = h('div', { role: 'table', 'aria-label': 'Attributes', style: 'display:flex;flex-direction:column;gap:2px' });
    for (const [name, value] of attrs) {
      grid.appendChild(h('div', { role: 'row', style: 'display:flex;gap:4px;align-items:center' },
        h('span', { role: 'rowheader', title: name, style: 'flex:0 0 38%;overflow:hidden;text-overflow:ellipsis;font:12px ui-monospace,Consolas,monospace' }, name),
        cellInput(value, (v) => mutate(app, () => setRealAttr(app, sel, name, v)), { label: `${name} value` }),
        h('button', { class: 'ql-iconbtn ql-sm', title: `Remove ${name}`, 'aria-label': `Remove ${name}`, type: 'button', onclick: () => mutate(app, () => setRealAttr(app, sel, name, null)) }, icon('close'))));
    }
    el.appendChild(grid);
    const have = new Set(attrs.map(([n]) => n));
    const sugg = [...(TAG_ATTRS[tag] || []), ...GLOBAL_ATTRS].filter((a) => !have.has(a));
    const listId = 'ql-attr-sugg';
    const nameIn = h('input', { list: listId, placeholder: 'attribute', 'aria-label': 'New attribute name', style: 'flex:0 0 38%;min-width:0;font:12px ui-monospace,Consolas,monospace' }) as HTMLInputElement;
    const valIn = h('input', { placeholder: 'value', 'aria-label': 'New attribute value', style: 'flex:1;min-width:0;font:12px ui-monospace,Consolas,monospace' }) as HTMLInputElement;
    const add = () => {
      const n = nameIn.value.trim().toLowerCase();
      if (!n) return;
      if (!/^[a-z_:][-a-z0-9_:.]*$/.test(n) || n.startsWith('data-ql-')) { toast(`"${n}" is not a valid attribute name.`); return; }
      mutate(app, () => setRealAttr(app, sel, n, valIn.value || (/^(hidden|disabled|checked|required|readonly|controls|autoplay|loop|muted|reversed|open|multiple|selected|nowrap|allowfullscreen|novalidate|ismap|playsinline|inert|autofocus)$/.test(n) ? '' : valIn.value)));
      if (/^(hidden|disabled|checked|required|readonly|controls|autoplay|loop|muted|reversed|open|multiple|selected|nowrap|allowfullscreen|novalidate|ismap|playsinline|inert|autofocus)$/.test(n) && !valIn.value) mutate(app, () => sel.setAttribute(n, ''));
    };
    valIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); valIn.focus(); } });
    el.appendChild(h('div', { class: 'ql-pane-h' }, 'Add attribute'));
    el.appendChild(h('div', { style: 'display:flex;gap:4px;align-items:center' }, nameIn, valIn, h('button', { class: 'ql-iconbtn ql-sm', title: 'Add attribute', 'aria-label': 'Add attribute', type: 'button', onclick: add }, icon('add'))));
    el.appendChild(datalist(listId, sugg));
    el.appendChild(h('div', { class: 'ql-pane-actions', style: 'margin-top:8px' },
      h('button', { class: 'ql-btn ql-sm', type: 'button', onclick: () => app.exec('format.style') }, 'Style…'),
      h('button', { class: 'ql-btn ql-sm', type: 'button', onclick: () => app.ui.togglePane('cssProperties') }, 'CSS Properties')));
  },
});

// ------------------------------------------------------------------------------------------
// CSS Properties

export const CSS_PROPS = ['align-content', 'align-items', 'align-self', 'animation', 'aspect-ratio', 'backdrop-filter', 'background', 'background-attachment', 'background-clip', 'background-color', 'background-image', 'background-position', 'background-repeat', 'background-size', 'border', 'border-bottom', 'border-collapse', 'border-color', 'border-left', 'border-radius', 'border-right', 'border-spacing', 'border-style', 'border-top', 'border-width', 'bottom', 'box-shadow', 'box-sizing', 'caption-side', 'clear', 'clip-path', 'color', 'column-count', 'column-gap', 'columns', 'content', 'cursor', 'direction', 'display', 'empty-cells', 'filter', 'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow', 'flex-shrink', 'flex-wrap', 'float', 'font', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'gap', 'grid-area', 'grid-auto-flow', 'grid-column', 'grid-row', 'grid-template-areas', 'grid-template-columns', 'grid-template-rows', 'height', 'inset', 'justify-content', 'justify-items', 'justify-self', 'left', 'letter-spacing', 'line-height', 'list-style', 'list-style-image', 'list-style-position', 'list-style-type', 'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'max-height', 'max-width', 'min-height', 'min-width', 'object-fit', 'object-position', 'opacity', 'order', 'outline', 'overflow', 'overflow-x', 'overflow-y', 'padding', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top', 'place-items', 'pointer-events', 'position', 'right', 'row-gap', 'table-layout', 'text-align', 'text-decoration', 'text-indent', 'text-overflow', 'text-shadow', 'text-transform', 'top', 'transform', 'transition', 'user-select', 'vertical-align', 'visibility', 'white-space', 'width', 'word-break', 'word-spacing', 'z-index'];

const INHERITED = new Set(['color', 'font', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'letter-spacing', 'line-height', 'list-style', 'list-style-image', 'list-style-position', 'list-style-type', 'text-align', 'text-indent', 'text-transform', 'visibility', 'white-space', 'word-spacing', 'direction', 'cursor', 'border-collapse', 'border-spacing', 'caption-side', 'empty-cells', 'quotes', 'text-shadow', 'word-break']);

interface Applied { key: string; label: string; sheet?: SheetRef; rule?: C.CssRule; decls: C.CssDecl[]; spec: C.Specificity; order: number; ok: boolean; from?: Element }

function mediaOk(win: Window, media: string[]): boolean {
  for (const m of media) {
    const mm = /^@(\w[\w-]*)\s*(.*)$/.exec(m);
    if (!mm) continue;
    try {
      if (mm[1] === 'media' && mm[2] && !win.matchMedia(mm[2]).matches) return false;
      if (mm[1] === 'supports' && mm[2] && !(win as any).CSS?.supports?.(mm[2])) return false;
    } catch { /* unknown condition: assume it applies */ }
  }
  return true;
}

/** Rules that apply to an element, in cascade order (lowest priority first), then its inline style. */
export function appliedRules(app: App, el: Element, sheets = pageSheets(app)): Applied[] {
  const out: Applied[] = [];
  const win = el.ownerDocument.defaultView || window;
  let order = 0;
  for (const s of sheets) {
    const parsed = C.parseCss(s.css);
    for (const r of parsed.rules) {
      order++;
      if (!r.decls.length && !r.items.length) { if (!C.matches(r, el)) continue; }
      if (!C.matches(r, el)) continue;
      const parts = C.splitSelectors(r.selector).filter((p) => C.matches(p, el));
      const spec = parts.map((p) => C.specificity(p)).sort((a, b) => C.compareSpecificity(b, a))[0] || [0, 0, 0];
      out.push({ key: `${s.id}#${r.index}`, label: (r.media.length ? r.media.join(' ') + ' › ' : '') + r.selector, sheet: s, rule: r, decls: r.decls, spec, order, ok: mediaOk(win, r.media) });
    }
  }
  out.sort((a, b) => C.compareSpecificity(a.spec, b.spec) || a.order - b.order);
  const inline = C.parseDeclarations(styleOf(el));
  if (inline.length || el === selectedFor.get(el.ownerDocument)) out.push({ key: 'inline', label: '<inline style>', decls: inline, spec: [1, 0, 0], order: Infinity, ok: true });
  return out;
}
const selectedFor = new WeakMap<Document, Element>();

/** For each applied rule's declaration, whether a later rule overrides it. */
function overridden(list: Applied[], a: Applied, d: C.CssDecl): boolean {
  const i = list.indexOf(a);
  for (const b of list.slice(i + 1)) {
    if (!b.ok) continue;
    for (const e of b.decls) if (e.prop === d.prop && (e.important || !d.important)) return true;
  }
  if (!d.important) for (const e of a.decls) if (e !== d && e.prop === d.prop && a.decls.indexOf(e) > a.decls.indexOf(d)) return true;
  return false;
}

const cssPaneState = { chosen: '' as string, all: false };

function writeRuleProp(app: App, a: Applied, el: HTMLElement, prop: string, value: string | null): void {
  if (a.key === 'inline') { mutate(app, () => setInline(app, el, prop, value)); return; }
  const sheet = pageSheets(app).find((s) => s.id === a.sheet!.id);
  if (!sheet) return;
  const rule = C.parseCss(sheet.css).rules[a.rule!.index];
  if (!rule) return;
  writeSheet(app, sheet, C.setDeclarationInRule(sheet.css, rule, prop, value), 'Edit Style');
}

registerPane({
  id: 'cssProperties', title: 'CSS Properties', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    track(app);
    const sel = designOn(app) ? selectedEl(app) : null;
    if (!sigOf(el, `${app.active?.id}:${app.site.version}:${idOf(sel)}:${sel ? styleOf(sel) + '|' + sel.className : ''}:${cssPaneState.chosen}:${cssPaneState.all}:${idOf(view(app)?.design?.doc)}`) || typingIn(el)) return;
    clear(el);
    if (!sel) { note(el, 'Select an element in Design view to see the CSS rules that apply to it.'); return; }
    selectedFor.set(sel.ownerDocument, sel);
    const sheets = pageSheets(app);
    const list = appliedRules(app, sel, sheets);
    el.appendChild(tools(['add_box', 'New Style', () => app.exec('css.newStyle')], ['edit', 'Modify the chosen rule', () => { const a = list.find((x) => x.key === cssPaneState.chosen); if (a?.sheet && a.rule) void modifyRule(app, a.sheet, a.rule.index); else app.exec('format.style'); }], ['attach_file', 'Attach Style Sheet', () => app.exec('css.attachStyleSheet')], [cssPaneState.all ? 'filter_alt_off' : 'filter_alt', cssPaneState.all ? 'Show set properties only' : 'Show all properties', () => { cssPaneState.all = !cssPaneState.all; el.dataset.sig = ''; this.update!(app, el, {}); }]));
    el.appendChild(h('div', { class: 'ql-pane-h' }, icon('rule'), h('strong', null, 'Applied Rules'), h('span', { class: 'ql-help', style: 'margin:0 0 0 auto' }, `<${elLabel(sel)}>`)));
    if (!list.some((a) => a.key === cssPaneState.chosen)) cssPaneState.chosen = list[list.length - 1]?.key || '';
    const rules = h('div', { role: 'listbox', 'aria-label': 'Applied rules', style: 'display:flex;flex-direction:column;gap:1px' });
    for (const a of list) {
      const on = a.key === cssPaneState.chosen;
      const row = h('div', { role: 'option', 'aria-selected': String(on), tabindex: '0', title: a.sheet ? `${a.label}\n${a.sheet.label}  (specificity ${a.spec.join(',')})` : 'The element\'s style attribute', style: rowStyle + (on ? ';background:var(--on)' : '') + (a.ok ? '' : ';opacity:.5') },
        icon(a.key === 'inline' ? 'format_paint' : a.sheet?.kind === 'file' ? 'css' : 'code'),
        h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px ui-monospace,Consolas,monospace' }, a.label),
        h('span', { class: 'ql-help', style: 'margin:0;white-space:nowrap' }, a.sheet ? (a.sheet.kind === 'file' ? a.sheet.path.split('/').pop()! : 'page') : ''));
      row.addEventListener('click', () => { cssPaneState.chosen = a.key; el.dataset.sig = ''; this.update!(app, el, {}); });
      row.addEventListener('dblclick', () => { if (a.sheet && a.rule) void modifyRule(app, a.sheet, a.rule.index); else app.exec('format.style'); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.click(); });
      rules.appendChild(row);
    }
    if (!list.length) note(rules, 'No rule applies to this element yet.');
    el.appendChild(rules);
    // Inherited properties from the ancestors' rules.
    const inh: string[] = [];
    for (let p = sel.parentElement; p && inh.length < 6; p = p.parentElement) {
      const props = new Set<string>();
      for (const a of appliedRules(app, p, sheets)) if (a.ok) for (const d of a.decls) if (INHERITED.has(d.prop)) props.add(d.prop);
      if (props.size) inh.push(`<${elLabel(p)}>: ${[...props].slice(0, 6).join(', ')}`);
      if (p.tagName === 'HTML') break;
    }
    if (inh.length) el.appendChild(h('details', null, h('summary', { class: 'ql-help' }, `Inherited from ${inh.length} ancestor${inh.length === 1 ? '' : 's'}`), ...inh.map((t) => h('div', { class: 'ql-help', style: 'font-family:ui-monospace,Consolas,monospace' }, t))));
    const a = list.find((x) => x.key === cssPaneState.chosen);
    if (!a) return;
    el.appendChild(h('div', { class: 'ql-pane-h' }, icon('tune'), h('strong', null, 'Properties'), h('span', { class: 'ql-help', style: 'margin:0 0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, a.label)));
    const grid = h('div', { style: 'display:flex;flex-direction:column;gap:2px' });
    const shown = new Set<string>();
    const propRow = (prop: string, d: C.CssDecl | null) => {
      shown.add(prop);
      const ov = d ? overridden(list, a, d) : false;
      grid.appendChild(h('div', { style: 'display:flex;gap:4px;align-items:center' },
        h('span', { title: ov ? `${prop} (overridden by a later rule)` : prop, style: `flex:0 0 40%;overflow:hidden;text-overflow:ellipsis;font:12px ui-monospace,Consolas,monospace;${d ? 'font-weight:600;' : 'opacity:.75;'}${ov ? 'text-decoration:line-through;' : ''}` }, prop),
        cellInput(d ? d.value + (d.important ? ' !important' : '') : '', (v) => writeRuleProp(app, a, sel, prop, v.trim() || null), { label: `${prop} value` }),
        d ? h('button', { class: 'ql-iconbtn ql-sm', title: `Remove ${prop}`, 'aria-label': `Remove ${prop}`, type: 'button', onclick: () => writeRuleProp(app, a, sel, prop, null) }, icon('close')) : h('span', { style: 'width:30px' })));
    };
    for (const d of a.decls) if (!shown.has(d.prop)) propRow(d.prop, [...a.decls].reverse().find((x) => x.prop === d.prop) || d);
    if (cssPaneState.all) for (const p of CSS_PROPS) if (!shown.has(p)) propRow(p, null);
    el.appendChild(grid);
    if (!cssPaneState.all) {
      const listId = 'ql-css-props';
      const pIn = h('input', { list: listId, placeholder: 'property', 'aria-label': 'New property', style: 'flex:0 0 40%;min-width:0;font:12px ui-monospace,Consolas,monospace' }) as HTMLInputElement;
      const vIn = h('input', { placeholder: 'value', 'aria-label': 'New property value', style: 'flex:1;min-width:0;font:12px ui-monospace,Consolas,monospace' }) as HTMLInputElement;
      const add = () => { const p = pIn.value.trim().toLowerCase(); if (!p || !vIn.value.trim()) return; if (!/^(--)?[a-z-]+$/.test(p)) { toast(`"${p}" is not a property name.`); return; } writeRuleProp(app, a, sel, p, vIn.value.trim()); };
      vIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      pIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); vIn.focus(); } });
      el.appendChild(h('div', { style: 'display:flex;gap:4px;align-items:center;margin-top:4px' }, pIn, vIn, h('button', { class: 'ql-iconbtn ql-sm', title: 'Add property', 'aria-label': 'Add property', type: 'button', onclick: add }, icon('add'))));
      el.appendChild(datalist(listId, CSS_PROPS.filter((p) => !shown.has(p))));
    }
  },
});

// ------------------------------------------------------------------------------------------
// Apply Styles

registerPane({
  id: 'applyStyles', title: 'Apply Styles', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    track(app);
    const sel = designOn(app) ? selectedEl(app) : null;
    if (!sigOf(el, `${app.active?.id}:${app.site.version}:${idOf(sel)}:${sel?.className}:${sel?.id}`) || typingIn(el)) return;
    clear(el);
    if (!isPage(app)) { note(el, 'Open a page to apply its styles.'); return; }
    el.appendChild(tools(['add_box', 'New Style', () => app.exec('css.newStyle')], ['attach_file', 'Attach Style Sheet', () => app.exec('css.attachStyleSheet')], ['format_list_bulleted', 'Manage Styles', () => app.ui.togglePane('manageStyles')]));
    el.appendChild(h('button', { class: 'ql-btn ql-sm', type: 'button', title: 'Remove the class and style attributes from the selected element', onclick: () => { const s = selectedEl(app); if (!s || s.tagName === 'BODY') { toast('Select an element first.'); return; } mutate(app, () => { s.removeAttribute('class'); s.removeAttribute('style'); s.removeAttribute('data-ql-o-style'); }); } }, icon('format_clear'), ' Clear Styles'));
    const classes = definedClasses(app);
    const bySheet = new Map<string, typeof classes>();
    for (const c of classes) { const k = c.sheet.label; if (!bySheet.has(k)) bySheet.set(k, []); bySheet.get(k)!.push(c); }
    if (!classes.length) note(el, 'No classes are defined for this page yet. New Style creates one.');
    for (const [label, list] of bySheet) {
      el.appendChild(h('div', { class: 'ql-pane-h' }, icon(label.startsWith('Current page') ? 'code' : 'css'), h('strong', null, label)));
      for (const c of list) {
        const on = !!sel?.classList.contains(c.name);
        const row = h('div', { role: 'button', tabindex: '0', title: `Apply .${c.name} (${c.rule.selector})`, style: rowStyle + (on ? ';background:var(--on)' : '') },
          h('span', { style: `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 6px;border-radius:4px;${previewStyle(c.rule)}` }, '.' + c.name),
          on ? icon('check') : null);
        row.addEventListener('click', () => applyClass(app, c.name));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applyClass(app, c.name); } });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showMenu([{ id: 'apply', label: `Apply .${c.name}`, icon: 'format_paint' }, { id: 'remove', label: 'Remove from Selection', icon: 'remove' }, { id: 'modify', label: 'Modify Style…', icon: 'edit' }, { id: 'select', label: 'Select All Instances', icon: 'select_all' }], {
            x: e.clientX, y: e.clientY,
            onPick: (m) => {
              if (m.id === 'apply') applyClass(app, c.name, { toggle: false });
              if (m.id === 'remove') { const s = selectedEl(app); if (s) mutate(app, () => removeClass(s, c.name)); }
              if (m.id === 'modify') void modifyRule(app, c.sheet, c.rule.index);
              if (m.id === 'select') { const d = view(app)?.design; const n = d?.doc?.querySelectorAll('.' + CSS.escape(c.name)).length || 0; const first = d?.doc?.querySelector('.' + CSS.escape(c.name)); if (first) d!.select(first); toast(`${n} element${n === 1 ? '' : 's'} use .${c.name}.`); }
            },
          });
        });
        el.appendChild(row);
      }
    }
    const idsList = [...new Set(pageSheets(app).flatMap((s) => C.idsIn(s.css)))];
    if (idsList.length) {
      el.appendChild(h('div', { class: 'ql-pane-h' }, icon('tag'), h('strong', null, 'IDs')));
      const doc = view(app)?.design?.doc;
      for (const id of idsList) {
        const used = doc?.getElementById(id);
        const on = sel?.id === id;
        const row = h('div', { role: 'button', tabindex: '0', title: used && !on ? `#${id} is used by <${elLabel(used)}>; click to select it` : `Give the selected element id="${id}"`, style: rowStyle + (on ? ';background:var(--on)' : '') }, h('span', { style: 'flex:1;font:12px ui-monospace,Consolas,monospace' }, '#' + id), used ? icon(on ? 'check' : 'link', '') : null);
        row.addEventListener('click', () => {
          const s = selectedEl(app);
          if (used && used !== s) { view(app)?.design?.select(used); return; }
          if (!s || s.tagName === 'BODY') { toast('Select an element first.'); return; }
          mutate(app, () => { if (s.id === id) s.removeAttribute('id'); else s.id = id; });
        });
        el.appendChild(row);
      }
    }
  },
});

// ------------------------------------------------------------------------------------------
// Manage Styles

const manageState = { key: '' };
const ruleKey = (s: SheetRef, r: C.CssRule, sheet: C.CssSheet) => `${s.id}|${C.normSelector(r.selector)}|${r.media.join('|')}|${sheet.rules.filter((x) => x.index < r.index && C.normSelector(x.selector) === C.normSelector(r.selector) && x.media.join('|') === r.media.join('|')).length}`;

function renameClassAttrs(src: string, from: string, to: string): string {
  const re = new RegExp(`(\\bclass\\s*=\\s*["'])([^"']*)(["'])`, 'gi');
  return src.replace(re, (m, a, list: string, b) => a + list.split(/(\s+)/).map((t) => (t === from ? to : t)).join('') + b);
}

registerPane({
  id: 'manageStyles', title: 'Manage Styles', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    track(app);
    if (!sigOf(el, `${app.active?.id}:${app.site.version}:${manageState.key}`) || typingIn(el)) return;
    const scroll = el.scrollTop;
    clear(el);
    if (!isPage(app)) { note(el, 'Open a page to manage the styles it uses.'); return; }
    const sheets = pageSheets(app);
    const all: { s: SheetRef; r: C.CssRule; key: string }[] = [];
    for (const s of sheets) { const p = C.parseCss(s.css); for (const r of p.rules) if (!r.synthetic) all.push({ s, r, key: ruleKey(s, r, p) }); }
    const cur = all.find((x) => x.key === manageState.key);
    const fresh = () => { if (!cur) return null; const s = pageSheets(app).find((x) => x.id === cur.s.id); if (!s) return null; const p = C.parseCss(s.css); const r = p.rules.find((x) => ruleKey(s, x, p) === cur.key); return r ? { s, r } : null; };
    const need = (fn: (x: { s: SheetRef; r: C.CssRule }) => void) => () => { const x = fresh(); if (!x) { toast('Choose a rule first.'); return; } fn(x); };
    el.appendChild(tools(
      ['add_box', 'New Style', () => app.exec('css.newStyle')],
      ['attach_file', 'Attach Style Sheet', () => app.exec('css.attachStyleSheet')],
      ['edit', 'Modify Style', need(({ s, r }) => void modifyRule(app, s, r.index))],
      ['drive_file_rename_outline', 'Rename', need(async ({ s, r }) => {
        if (r.nested) { toast('Rename nested rules in Code view.'); return; }
        const to = await promptDialog('Rename Style', 'New selector', r.selector);
        if (!to || to.trim() === r.selector) return;
        const css = s.css.slice(0, r.selStart) + to.trim() + s.css.slice(r.selEnd);
        writeSheet(app, s, css, 'Rename Style');
        const a = /^\.(-?[_a-zA-Z][\w-]*)$/.exec(r.selector.trim())?.[1], b = /^\.(-?[_a-zA-Z][\w-]*)$/.exec(to.trim())?.[1];
        if (a && b && /class\s*=/.test(fileText(app, app.active.path)) && await confirmDialog('Rename Style', `Also change class="${a}" to class="${b}" in this page?`, 'Change', 'Keep')) editFile(app, app.active.path, 'Rename Class', (src) => renameClassAttrs(src, a, b));
        manageState.key = '';
      })],
      ['arrow_upward', 'Move Up', need(({ s, r }) => writeSheet(app, s, C.moveRule(s.css, r, -1), 'Move Rule'))],
      ['arrow_downward', 'Move Down', need(({ s, r }) => writeSheet(app, s, C.moveRule(s.css, r, 1), 'Move Rule'))],
      ['delete', 'Delete', need(async ({ s, r }) => { if (await confirmDialog('Delete Style', `Delete the rule ${r.selector}${r.media.length ? ` (${r.media.join(' ')})` : ''}?`, 'Delete')) { writeSheet(app, s, C.removeEmptyBlocks(C.removeRule(s.css, r)), 'Delete Style'); manageState.key = ''; } })],
    ));
    if (!sheets.length) { note(el, 'This page has no styles. New Style creates a rule; Attach Style Sheet links a .css file.'); return; }
    const list = h('div', { role: 'tree', 'aria-label': 'Style sheets and rules', style: 'display:flex;flex-direction:column;gap:1px' });
    for (const s of sheets) {
      const parsed = C.parseCss(s.css);
      const head = h('div', { class: 'ql-pane-h', role: 'treeitem', title: s.via ? `${s.label} (imported by ${s.via})` : s.label }, icon(s.kind === 'file' ? 'css' : 'code'), h('strong', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, s.label), h('span', { class: 'ql-help', style: 'margin:0 0 0 auto' }, String(parsed.rules.filter((r) => !r.synthetic).length)));
      if (s.kind === 'file') { head.style.cursor = 'pointer'; head.addEventListener('dblclick', () => app.openFile(s.path)); }
      list.appendChild(head);
      for (const a of parsed.atRules.filter((x) => x.name === 'import' || x.name === 'font-face' || /keyframes$/.test(x.name))) list.appendChild(h('div', { class: 'ql-help', style: 'padding-left:22px;font-family:ui-monospace,Consolas,monospace;margin:0' }, `@${a.name} ${a.name === 'font-face' ? a.decls?.find((d) => d.prop === 'font-family')?.value || '' : a.prelude}`));
      for (const r of parsed.rules) {
        if (r.synthetic) continue;
        const key = ruleKey(s, r, parsed);
        const on = key === manageState.key;
        const usedCls = /^\.(-?[_a-zA-Z][\w-]*)$/.exec(r.selector)?.[1];
        const used = usedCls ? !!view(app)?.design?.doc?.querySelector('.' + CSS.escape(usedCls)) : true;
        const row = h('div', { role: 'treeitem', 'aria-selected': String(on), tabindex: '0', title: `${r.selector}\n${r.decls.map((d) => `${d.prop}: ${d.value}`).join('; ')}`, style: rowStyle + `;padding-left:${18 + (r.media.length + (r.nested ? 1 : 0)) * 10}px` + (on ? ';background:var(--on)' : '') },
          h('span', { style: `width:10px;height:10px;border-radius:50%;flex:none;background:${used ? '#3a8f3a' : 'transparent'};border:1px solid ${used ? '#3a8f3a' : '#999'}`, title: used ? 'Used in this page' : 'Not used in this page' }),
          h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px ui-monospace,Consolas,monospace' }, (r.media.length ? r.media[r.media.length - 1].replace(/^@media\s*/, '') + ' › ' : '') + r.selector));
        row.addEventListener('click', () => { manageState.key = key; el.dataset.sig = ''; this.update!(app, el, {}); });
        row.addEventListener('dblclick', () => void modifyRule(app, s, r.index));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') void modifyRule(app, s, r.index); if (e.key === 'Delete') (el.querySelector('[aria-label="Delete"]') as HTMLElement | null)?.click(); });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); manageState.key = key; showMenu([{ id: 'modify', label: 'Modify Style…', icon: 'edit' }, { id: 'apply', label: 'Apply to Selection', icon: 'format_paint' }, { id: 'go', label: 'Go to Code', icon: 'code' }], { x: e.clientX, y: e.clientY, onPick: (m) => { if (m.id === 'modify') void modifyRule(app, s, r.index); if (m.id === 'apply' && usedCls !== undefined) applyClass(app, usedCls, { toggle: false }); else if (m.id === 'apply') toast('Only class rules can be applied.'); if (m.id === 'go') goToCss(app, s, r.start); } }); });
        list.appendChild(row);
      }
    }
    el.appendChild(list);
    if (cur) {
      el.appendChild(h('div', { class: 'ql-pane-h' }, icon('visibility'), h('strong', null, 'Selected style preview')));
      el.appendChild(h('div', { style: `border:1px solid var(--border);border-radius:6px;padding:10px;overflow:hidden;background:#fff;color:#000` }, h('span', { style: previewStyle(cur.r) }, 'AaBbYyGgLlJj')));
      el.appendChild(h('pre', { class: 'ql-help', style: 'white-space:pre-wrap;margin:4px 0' }, cur.r.decls.map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''};`).join('\n') || '(no declarations)'));
    }
    el.scrollTop = scroll;
  },
});

/** Opens the sheet (or the page) in Code view at a rule. */
function goToCss(app: App, s: SheetRef, offset: number): void {
  if (s.kind === 'file') {
    const t = app.openFile(s.path);
    setTimeout(() => t.ui.code?.goToLine(C.lineOf(s.css, offset)), 30);
    return;
  }
  const src = fileText(app, s.path);
  const at = src.indexOf(s.css);
  const t = app.openFile(s.path, { view: 'split' });
  setTimeout(() => t.ui.code?.goToLine(C.lineOf(src, Math.max(0, at) + offset)), 30);
}

// ------------------------------------------------------------------------------------------
// Layers

registerPane({
  id: 'layers', title: 'Layers', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    track(app);
    const d = designOn(app) ? view(app)!.design! : null;
    const doc = d?.doc;
    const layers = doc ? ([...doc.body.querySelectorAll('*')].filter((e) => !e.closest('[data-ql-ui]') && /^(absolute|fixed|relative|sticky)$/.test(doc.defaultView!.getComputedStyle(e).position)) as HTMLElement[]) : [];
    const sig = layers.map((e) => `${idOf(e)}:${styleOf(e)}:${e.id}`).join('|');
    if (!sigOf(el, `${app.active?.id}:${idOf(doc)}:${idOf(d?.selected)}:${sig}`) || typingIn(el)) return;
    clear(el);
    if (!doc) { note(el, 'Layers are the positioned elements of the page in Design view.'); return; }
    el.appendChild(tools(['add_box', 'Insert Layer', () => app.exec('insert.layer')], ['flip_to_front', 'Bring to Front', () => app.exec('format.bringToFront')], ['flip_to_back', 'Send to Back', () => app.exec('format.sendToBack')], ['tune', 'Layer Properties', () => app.exec('format.layerProperties')]));
    const prevent = h('input', { type: 'checkbox', id: 'ql-prevent-overlaps' }) as HTMLInputElement;
    try { prevent.checked = localStorage.getItem('ql.preventOverlaps') === '1'; } catch { /* */ }
    prevent.addEventListener('change', () => app.exec('format.preventOverlaps'));
    el.appendChild(h('label', { class: 'ql-help', for: 'ql-prevent-overlaps', style: 'display:flex;gap:6px;align-items:center' }, prevent, 'Prevent overlaps'));
    if (!layers.length) { note(el, 'This page has no positioned elements. Insert Layer adds one; Layout ▸ Absolute positions the selection.'); return; }
    const head = h('div', { style: 'display:flex;gap:6px;padding:0 6px;font-size:12px;opacity:.75' }, h('span', { style: 'width:30px' }, ''), h('span', { style: 'flex:1' }, 'Name'), h('span', { style: 'width:56px' }, 'Z'));
    el.appendChild(head);
    const z = (e: HTMLElement) => parseInt(doc.defaultView!.getComputedStyle(e).zIndex, 10) || 0;
    for (const e of [...layers].sort((a, b) => z(b) - z(a))) {
      const own = inlineOf(e);
      const hidden = own.visibility === 'hidden' || doc.defaultView!.getComputedStyle(e).visibility === 'hidden';
      const on = d!.selected === e;
      const pos = doc.defaultView!.getComputedStyle(e).position;
      const row = h('div', { style: rowStyle + (on ? ';background:var(--on)' : ''), title: `<${elLabel(e)}> position: ${pos}` },
        h('button', { class: 'ql-iconbtn ql-sm', title: hidden ? 'Show' : 'Hide', 'aria-label': hidden ? 'Show layer' : 'Hide layer', type: 'button', onclick: (ev: Event) => { ev.stopPropagation(); mutate(app, () => setInline(app, e, 'visibility', hidden ? null : 'hidden')); } }, icon(hidden ? 'visibility_off' : 'visibility')),
        h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px ui-monospace,Consolas,monospace' + (pos === 'relative' || pos === 'sticky' ? ';opacity:.75' : '') }, e.id || `<${elLabel(e)}>`),
        (() => { const inp = cellInput(own['z-index'] || '', (v) => mutate(app, () => setInline(app, e, 'z-index', v.trim() && !isNaN(+v) ? String(Math.round(+v)) : null)), { label: 'Z-index', placeholder: 'auto' }); inp.style.flex = '0 0 56px'; inp.addEventListener('click', (ev) => ev.stopPropagation()); return inp; })());
      row.addEventListener('click', () => d!.select(e));
      row.addEventListener('dblclick', () => { d!.select(e); app.exec('format.layerProperties'); });
      el.appendChild(row);
    }
  },
});

// ------------------------------------------------------------------------------------------
// CSS Reports

interface Finding { type: string; item: string; file: string; line: number; detail?: string }
const reportState: { scope: 'page' | 'site'; checks: Record<string, boolean>; results: Finding[] | null; ran: string } = { scope: 'page', checks: { unused: true, classes: true, ids: true, errors: true }, results: null, ran: '' };

export function cssReport(app: App, scope: 'page' | 'site', checks: Record<string, boolean>): Finding[] {
  const pages = scope === 'page' ? (app.active && isPagePath(app.active.path) ? [app.active.path] : []) : app.site.pages().map((f) => f.path).filter((p) => !/\.(lbi|dwt)$/i.test(p));
  const out: Finding[] = [];
  const sheetUse = new Map<string, { s: SheetRef; docs: Document[]; src: string }>();
  const parser = new DOMParser();
  const docs = new Map<string, Document>();
  for (const p of pages) {
    const src = fileText(app, p);
    const doc = parser.parseFromString(src, 'text/html');
    docs.set(p, doc);
    const sheets = pageSheets(app, p, src);
    const defined = new Set<string>();
    const definedIds = new Set<string>();
    for (const s of sheets) {
      const key = s.kind === 'file' ? s.id : `${s.id}@${p}`;
      if (!sheetUse.has(key)) sheetUse.set(key, { s, docs: [], src });
      sheetUse.get(key)!.docs.push(doc);
      for (const c of C.classesIn(s.css)) defined.add(c);
      for (const i of C.idsIn(s.css)) definedIds.add(i);
    }
    const lineIn = (needle: RegExp) => { const m = needle.exec(src); return m ? C.lineOf(src, m.index) : 1; };
    if (checks.classes) {
      const used = new Set<string>();
      doc.querySelectorAll('[class]').forEach((e) => e.classList.forEach((c) => used.add(c)));
      const lower = new Map([...defined].map((c) => [c.toLowerCase(), c]));
      for (const c of used) {
        if (defined.has(c)) continue;
        const near = lower.get(c.toLowerCase());
        out.push({ type: near ? 'Mismatched case' : 'Undefined class', item: '.' + c, file: p, line: lineIn(new RegExp(`class\\s*=\\s*["'][^"']*\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)), detail: near ? `The style sheets define .${near}` : 'No rule in the page\'s style sheets uses this class' });
      }
    }
    if (checks.ids) {
      const has = (id: string) => !!doc.getElementById(id) || !!doc.querySelector(`[name="${CSS.escape(id)}"]`);
      for (const m of src.matchAll(/\b(href|for|aria-labelledby|aria-describedby|aria-controls|list|form|headers|usemap)\s*=\s*["']([^"']+)["']/gi)) {
        const attr = m[1].toLowerCase();
        const vals = attr === 'href' || attr === 'usemap' ? (/^#([^#\s]+)$/.exec(m[2]) ? [m[2].slice(1)] : []) : m[2].split(/\s+/).filter(Boolean);
        for (const v of vals) if (v && v !== 'top' && !has(decodeURIComponent(v))) out.push({ type: 'Undefined ID', item: '#' + v, file: p, line: C.lineOf(src, m.index!), detail: `${attr}="${m[2]}" points to an element that is not on the page` });
      }
    }
  }
  for (const { s, docs: ds, src } of sheetUse.values()) {
    const base = s.kind === 'page' ? Math.max(0, src.indexOf(s.css)) : 0;
    const text = s.kind === 'page' ? src : s.css;
    const line = (off: number) => C.lineOf(text, base + off);
    const parsed = C.parseCss(s.css);
    if (checks.unused) for (const u of C.unusedSelectors(parsed, ds)) out.push({ type: 'Unused style', item: u.selector, file: s.path, line: line(u.rule.start), detail: `Matches nothing in ${ds.length === 1 ? 'the page' : `the ${ds.length} pages`} that use${ds.length === 1 ? 's' : ''} it` });
    if (checks.ids) for (const id of C.idsIn(parsed)) if (!ds.some((d) => d.getElementById(id))) { const r = parsed.rules.find((x) => x.selector.includes('#' + id)); if (!checks.unused || !r || !C.unusedSelectors({ ...parsed, rules: [r] }, ds).length) out.push({ type: 'Undefined ID', item: '#' + id, file: s.path, line: r ? line(r.start) : 1, detail: 'A style uses this id, but no element has it' }); }
    if (checks.errors) for (const e of parsed.errors) out.push({ type: 'CSS error', item: e.message, file: s.path, line: line(e.offset) });
  }
  const seen = new Set<string>();
  return out.filter((f) => { const k = `${f.type}|${f.item}|${f.file}|${f.line}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 1000);
}

registerPane({
  id: 'cssReports', title: 'CSS Reports', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    track(app);
    if (!sigOf(el, `${reportState.ran}:${reportState.scope}:${JSON.stringify(reportState.checks)}`) || typingIn(el)) return;
    clear(el);
    const run = () => { reportState.results = cssReport(app, reportState.scope, reportState.checks); reportState.ran = `${Date.now()}`; el.dataset.sig = ''; this.update!(app, el, {}); };
    const radio = (v: 'page' | 'site', label: string) => { const r = h('input', { type: 'radio', name: 'ql-cssrep-scope', checked: reportState.scope === v }) as HTMLInputElement; r.addEventListener('change', () => { reportState.scope = v; }); return h('label', { style: 'display:flex;gap:4px;align-items:center' }, r, label); };
    const check = (k: string, label: string) => { const c = h('input', { type: 'checkbox', checked: !!reportState.checks[k] }) as HTMLInputElement; c.addEventListener('change', () => { reportState.checks[k] = c.checked; }); return h('label', { style: 'display:flex;gap:4px;align-items:center' }, c, label); };
    el.appendChild(h('div', { class: 'ql-row' }, radio('page', 'Current page'), radio('site', 'All pages')));
    el.appendChild(h('div', { class: 'ql-row' }, check('unused', 'Unused styles'), check('classes', 'Undefined classes'), check('ids', 'Undefined IDs'), check('errors', 'Errors')));
    el.appendChild(h('div', { class: 'ql-pane-actions' }, h('button', { class: 'ql-btn ql-sm ql-primary', type: 'button', onclick: run }, icon('play_arrow'), ' Check')));
    const res = reportState.results;
    if (!res) { note(el, 'Finds rules that match nothing, classes and ids that point nowhere, and CSS syntax errors.'); return; }
    if (!res.length) { note(el, 'No problems found.'); return; }
    const counts = res.reduce((m, f) => m.set(f.type, (m.get(f.type) || 0) + 1), new Map<string, number>());
    note(el, [...counts].map(([t, n]) => `${n} ${t.toLowerCase()}${n === 1 ? '' : 's'}`).join(' · '));
    const table = h('div', { role: 'list', style: 'display:flex;flex-direction:column;gap:1px' });
    for (const f of res) {
      const row = h('div', { role: 'listitem', tabindex: '0', title: `${f.detail || f.type}\n${f.file}, line ${f.line}`, style: rowStyle + ';flex-wrap:wrap' },
        icon(f.type === 'CSS error' ? 'error' : f.type === 'Unused style' ? 'block' : 'help'),
        h('span', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px ui-monospace,Consolas,monospace' }, f.item),
        h('span', { class: 'ql-help', style: 'margin:0;white-space:nowrap' }, `${f.file.split('/').pop()}:${f.line}`));
      const open = () => {
        if (!app.site.has(f.file)) return;
        const t = app.openFile(f.file, isPagePath(f.file) ? { view: 'split' } : {});
        setTimeout(() => t.ui.code?.goToLine(f.line), 40);
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      table.appendChild(row);
    }
    el.appendChild(table);
  },
});
