/**
 * Format commands: character and paragraph formatting, lists, borders and shading, the CSS box, flexbox and
 * grid containers, positioning and layers, page background and colors, document type and encoding, the
 * style application mode, themes, shared borders and page transitions.
 *
 * Every command works in the focused view: Design view changes the page DOM (as one undo step), Code view
 * wraps the selected source. Styles follow the style application mode (prefs.cssMode): inline styles, or
 * generated classes ("style1", "style2"…) in the page's <style> block.
 */
import { def, type MenuEntry, type Command } from './registry';
import type { App } from '../app';
import { openDialog, toast, colorMenu, showMenu, promptDialog, type Field } from '../ui/dialog';
import { DOCTYPES, getDoctype, setDoctype, getCharset, setCharset, editHeadStyle, addStylesheet, removeStylesheet, regions, setTagAttr, getMeta, setMeta } from '../model/html';
import { decodeEntities } from '../model/site';
import { relativeRef } from '../model/paths';
import { cacheFor } from '../editor/workspace';
import * as C from '../model/css';
import { isPage, inDesign, view, selectedEl, closestSel, mutate, wrapTag, richCommand, formatBlock, unwrap, selectionText, insertHtml } from '../editor/ops';
import { renameElement } from '../editor/designView';
import { libraryItemMarkup, updateLibraryItems } from '../site/templates';
import {
  pageOk, textOk, track, setInline, styleSelection, applyProps, fileText, editFile, pageSheets, keepSelection, propFields, syncPicker, previewHtml, inlineOf,
  STYLE_CATEGORIES, FONT_SIZES, fontList, saveFontList, FONT_STACKS, newStyleFromSelection, elementStyleDialog, pickPages, siteImages, type PropSpec,
} from './css';

// ------------------------------------------------------------------------------------------
// Small helpers

let pointer = { x: 240, y: 160 };
if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { pointer = { x: e.clientX, y: e.clientY }; }, true);

/** Where to open a picker for a command: its ribbon/QAT control when visible, else where the user clicked. */
function anchorFor(id: string): HTMLElement | { x: number; y: number } {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-cmd-wrap="${id}"], [data-cmd="${id}"]`)) if (el.offsetParent !== null) return el;
  return pointer;
}
const at = (a: HTMLElement | { x: number; y: number }) => (a instanceof HTMLElement ? { anchor: a } : { x: a.x, y: a.y });

const win = (el: Element) => el.ownerDocument.defaultView!;
const cs = (el: Element) => win(el).getComputedStyle(el);

const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,pre,address,blockquote,div,li,dt,dd,td,th,section,article,aside,header,footer,nav,main,figure,figcaption,form';

/** The block that holds the selection (for paragraph formatting). */
function blockEl(app: App): HTMLElement | null {
  const el = selectedEl(app);
  if (!el) return null;
  const b = el.closest(BLOCKS) as HTMLElement | null;
  return b || el;
}

function needDesign(app: App): HTMLElement | null {
  const v = view(app);
  if (!v?.design?.doc) { toast('This command works in Design view.'); return null; }
  if (v.tab.view === 'code' || v.tab.view === 'preview') { app.setView(v.tab, 'split'); toast('Switched to Split view; run the command again in Design view.'); return null; }
  return selectedEl(app);
}

/** Values to write: empty fields remove the property (they were prefilled from the element's own style). */
function changesFor(specs: PropSpec[], v: Record<string, any>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of specs) { const x = String(v[s.prop] ?? '').trim(); out[s.prop] = x || null; }
  return out;
}

function localFlag(key: string, value?: boolean): boolean {
  try {
    if (value !== undefined) localStorage.setItem(key, value ? '1' : '0');
    return localStorage.getItem(key) === '1';
  } catch { return !!value; }
}

const firstFamily = (stack: string) => (stack.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');

// ------------------------------------------------------------------------------------------
// Character formatting

const strongTag = (app: App) => (app.prefs.useStrongEm ? 'strong' : 'b');
const emTag = (app: App) => (app.prefs.useStrongEm ? 'em' : 'i');
const stateOf = (cmd: string) => (app: App) => inDesign(app) && !!view(app)?.design?.queryState(cmd);

const RICH: { id: string; label: string; icon: string; cmd: string; keys?: string[]; tag: (app: App) => string; origin: string }[] = [
  { id: 'format.bold', label: 'Bold', icon: 'format_bold', cmd: 'bold', keys: ['Ctrl+B'], tag: strongTag, origin: 'Every editor' },
  { id: 'format.italic', label: 'Italic', icon: 'format_italic', cmd: 'italic', keys: ['Ctrl+I'], tag: emTag, origin: 'Every editor' },
  { id: 'format.underline', label: 'Underline', icon: 'format_underlined', cmd: 'underline', keys: ['Ctrl+U'], tag: () => 'u', origin: 'Every editor' },
  { id: 'format.strikethrough', label: 'Strikethrough', icon: 'strikethrough_s', cmd: 'strikeThrough', tag: () => 's', origin: 'FrontPage, Expression Web' },
  { id: 'format.superscript', label: 'Superscript', icon: 'superscript', cmd: 'superscript', keys: ['Ctrl+Shift+='], tag: () => 'sup', origin: 'FrontPage, Expression Web' },
  { id: 'format.subscript', label: 'Subscript', icon: 'subscript', cmd: 'subscript', keys: ['Ctrl+='], tag: () => 'sub', origin: 'FrontPage, Expression Web' },
];

/** Wraps the selection in a phrase element, or removes the element when the selection is already inside one. */
function toggleInline(app: App, tag: string, attrs: Record<string, string> = {}): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'design' && v.design?.doc) {
    const sel = tag === 'span' ? null : closestSel(app, tag);
    if (sel) { mutate(app, () => unwrap(sel)); return; }
    if (!v.design.selectedText()) { toast('Select the text to format.'); return; }
  }
  wrapTag(app, tag, attrs);
}

const legacyDoctype = (app: App) => !/^(html5|xhtml5|none|custom)$/.test(getDoctype(fileText(app, app.active.path)));

const PHRASE: { id: string; label: string; icon: string; tag: (app: App) => string; attrs?: (app: App) => Promise<Record<string, string> | null> | Record<string, string>; origin: string; keywords?: string }[] = [
  { id: 'format.teletype', label: 'Teletype', icon: 'keyboard_alt', tag: (app) => (legacyDoctype(app) ? 'tt' : 'code'), origin: 'FrontPage (Typewriter), Dreamweaver', keywords: 'tt monospace typewriter' },
  { id: 'format.emphasis', label: 'Emphasis', icon: 'format_italic', tag: () => 'em', origin: 'Dreamweaver, KompoZer' },
  { id: 'format.strong', label: 'Strong', icon: 'format_bold', tag: () => 'strong', origin: 'Dreamweaver, KompoZer' },
  { id: 'format.code', label: 'Code', icon: 'code', tag: () => 'code', origin: 'FrontPage, Dreamweaver' },
  { id: 'format.variable', label: 'Variable', icon: 'function', tag: () => 'var', origin: 'FrontPage, Dreamweaver' },
  { id: 'format.sample', label: 'Sample', icon: 'terminal', tag: () => 'samp', origin: 'FrontPage, Dreamweaver' },
  { id: 'format.keyboard', label: 'Keyboard', icon: 'keyboard', tag: () => 'kbd', origin: 'FrontPage, Dreamweaver' },
  { id: 'format.citation', label: 'Citation', icon: 'format_quote', tag: () => 'cite', origin: 'FrontPage, Dreamweaver' },
  { id: 'format.definition', label: 'Definition', icon: 'menu_book', tag: () => 'dfn', origin: 'FrontPage, Dreamweaver' },
  { id: 'format.deleted', label: 'Deleted Text', icon: 'format_strikethrough', tag: () => 'del', origin: 'Dreamweaver, Expression Web' },
  { id: 'format.inserted', label: 'Inserted Text', icon: 'edit_note', tag: () => 'ins', origin: 'Dreamweaver, Expression Web' },
  {
    id: 'format.abbreviation', label: 'Abbreviation', icon: 'short_text', tag: () => 'abbr', origin: 'Dreamweaver, KompoZer',
    attrs: async () => { const t = await promptDialog('Abbreviation', 'Full text (shown as a tooltip)', ''); return t == null ? null : { title: t }; },
  },
  {
    id: 'format.acronym', label: 'Acronym', icon: 'abc', tag: (app) => (legacyDoctype(app) ? 'acronym' : 'abbr'), origin: 'Dreamweaver, KompoZer', keywords: 'abbr',
    attrs: async () => { const t = await promptDialog('Acronym', 'Expansion (shown as a tooltip)', ''); return t == null ? null : { title: t }; },
  },
  { id: 'format.nobreak', label: 'No Break', icon: 'wrap_text', tag: () => 'span', attrs: () => ({ style: 'white-space: nowrap' }), origin: 'Dreamweaver (nobr), Composer', keywords: 'nowrap nobr keep together' },
];

// ------------------------------------------------------------------------------------------
// Font and color

let lastColor = '#c00000';
let lastHighlight = '#ffff00';

function computedFont(app: App): string | null {
  if (!inDesign(app)) return null;
  const el = selectedEl(app);
  if (!el) return null;
  return firstFamily(cs(el).fontFamily || '') || null;
}

function computedSize(app: App): string | null {
  if (!inDesign(app)) return null;
  const el = selectedEl(app);
  if (!el) return null;
  const own = inlineOf(el)['font-size'];
  if (own) return own;
  const px = parseFloat(cs(el).fontSize);
  return isFinite(px) ? `${Math.round(px * 10) / 10}px` : null;
}

function fontMenu(app: App): MenuEntry[] {
  const site = new Set<string>();
  if (isPage(app)) for (const s of pageSheets(app)) for (const f of C.fontFaces(s.css)) site.add(f);
  const entries: MenuEntry[] = [{ id: 'format.fontFamily', arg: '', label: 'Default (inherit)', icon: 'format_clear' }];
  if (site.size) { entries.push({ heading: 'Fonts in this site' }); for (const f of site) entries.push({ id: 'format.fontFamily', arg: `"${f}", sans-serif`, label: f, preview: `font-family:"${f}"` }); }
  entries.push({ heading: 'Font stacks' });
  for (const s of fontList()) entries.push({ id: 'format.fontFamily', arg: s, label: firstFamily(s), preview: `font-family:${s}` });
  entries.push({ heading: 'Google Fonts: Insert ▸ Google Font; your own: Design ▸ Web Fonts' });
  return entries;
}

function sizeMenu(): MenuEntry[] {
  const e: MenuEntry[] = [{ id: 'format.fontSize', arg: '', label: 'Default (inherit)', icon: 'format_clear' }];
  e.push({ heading: 'Pixels' }, ...FONT_SIZES.filter((s) => s.endsWith('px')).map((s) => ({ id: 'format.fontSize', arg: s, label: s })));
  e.push({ heading: 'Relative' }, ...FONT_SIZES.filter((s) => /r?em$/.test(s)).map((s) => ({ id: 'format.fontSize', arg: s, label: s })));
  e.push({ heading: 'Keywords' }, ...FONT_SIZES.filter((s) => /^[a-z-]+$/.test(s)).map((s) => ({ id: 'format.fontSize', arg: s, label: s })));
  return e;
}

async function colorCommand(app: App, arg: any, prop: 'color' | 'background-color', id: string): Promise<void> {
  const hl = prop === 'background-color';
  let c: string | null | undefined = arg;
  if (arg === 'menu') {
    c = await colorMenu(anchorFor(id), hl ? { none: 'No Color', highlight: true, title: 'Highlight' } : { auto: 'Automatic', title: 'Font Color' });
    if (c === undefined) return;
  } else if (arg === undefined) c = hl ? lastHighlight : lastColor;
  if (c) { if (hl) lastHighlight = c; else lastColor = c; }
  styleSelection(app, { [prop]: c || null }, hl ? 'Highlight' : 'Font Color');
  setTimeout(() => {
    for (const bar of document.querySelectorAll<HTMLElement>(`[data-cmd="${id}"] .ql-colorbar`)) bar.style.background = hl ? lastHighlight : lastColor;
  }, 0);
}

async function fontDialog(app: App): Promise<void> {
  const el = selectedEl(app);
  const own = inlineOf(el);
  const comp = el && inDesign(app) ? cs(el) : null;
  const specs: PropSpec[] = [
    ...STYLE_CATEGORIES.Font,
    { prop: 'letter-spacing', label: 'Letter spacing', type: 'combo', options: ['normal', '0.05em', '0.1em', '1px', '2px'] },
    { prop: 'word-spacing', label: 'Word spacing', type: 'combo', options: ['normal', '0.1em', '0.25em', '4px'] },
    { prop: 'text-shadow', label: 'Shadow', type: 'combo', options: ['none', '1px 1px 2px rgba(0, 0, 0, 0.3)', '0 0 4px currentColor'] },
  ];
  const v = await openDialog({
    title: 'Font', wide: true, preview: true,
    help: comp ? `The selection now shows ${firstFamily(comp.fontFamily)} at ${comp.fontSize}${comp.fontWeight !== '400' ? `, weight ${comp.fontWeight}` : ''}. Leave a box empty to keep what the page's styles give.` : undefined,
    fields: [...propFields(specs, own), { key: 'smallCaps', label: 'Small caps', type: 'checkbox', value: own['font-variant'] === 'small-caps' }],
    onChange: (vals, ctl, key) => {
      syncPicker(ctl, key, vals);
      if (key === 'smallCaps') ctl.set('font-variant', vals.smallCaps ? 'small-caps' : '');
      const p: Record<string, string> = {};
      for (const s of specs) if (vals[s.prop]) p[s.prop] = vals[s.prop];
      ctl.setPreview(previewHtml(p, comp ? (selectedEl(app)?.textContent || '').trim().slice(0, 60) || 'AaBbYyGgLlJj' : 'AaBbYyGgLlJj'));
    },
  });
  if (!v) return;
  const ch = changesFor(specs, v);
  if (!Object.keys(own).length) for (const k of Object.keys(ch)) if (ch[k] == null) delete ch[k];
  styleSelection(app, ch, 'Font');
}

// ------------------------------------------------------------------------------------------
// Paragraphs and blocks

const BLOCK_STYLES: [string, string][] = [['p', 'Paragraph'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'], ['h5', 'Heading 5'], ['h6', 'Heading 6'], ['pre', 'Preformatted'], ['address', 'Address'], ['blockquote', 'Blockquote'], ['div', 'Div']];
const BLOCK_PREVIEW: Record<string, string> = { h1: 'font-size:1.6em;font-weight:bold', h2: 'font-size:1.4em;font-weight:bold', h3: 'font-size:1.2em;font-weight:bold', h4: 'font-weight:bold', h5: 'font-size:.9em;font-weight:bold', h6: 'font-size:.8em;font-weight:bold', pre: 'font-family:monospace', address: 'font-style:italic', blockquote: 'padding-left:1em;border-left:3px solid #999' };

function currentBlock(app: App): string | null {
  if (!inDesign(app)) return null;
  const b = selectedEl(app)?.closest('p,h1,h2,h3,h4,h5,h6,pre,address,blockquote,div');
  if (!b) return 'None';
  return BLOCK_STYLES.find(([t]) => t === b.tagName.toLowerCase())?.[1] || null;
}

function blockNone(app: App): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code') {
    const s = selectionText(app);
    if (!s) { toast('Select the source to remove block tags from.'); return; }
    v.code?.replaceSelection(s.replace(/<\/?(?:p|h[1-6]|pre|address|blockquote|div)\b[^>]*>/gi, ''), true);
    v.flush();
    return;
  }
  const b = selectedEl(app)?.closest('p,h1,h2,h3,h4,h5,h6,pre,address,blockquote,div');
  if (!b || b === v.design?.doc?.body) return;
  mutate(app, () => { const next = b.nextSibling; unwrap(b); if (next && b.textContent) next.parentNode?.insertBefore(next.ownerDocument!.createElement('br'), next); });
}

function setBlock(app: App, tag: string): void {
  if (tag === 'none') { blockNone(app); return; }
  // In a list item or table cell the block goes inside the item, not around the list.
  const v = view(app);
  const el = v?.target === 'design' ? selectedEl(app) : null;
  const cell = el?.closest('p,h1,h2,h3,h4,h5,h6,pre,address,div,blockquote,li,dt,dd,td,th');
  if (cell && /^(LI|DT|DD|TD|TH)$/.test(cell.tagName) && tag !== 'blockquote') {
    mutate(app, (doc) => {
      const only = cell.children.length === 1 && cell.firstElementChild!.matches('p,h1,h2,h3,h4,h5,h6,pre,address,div') && !(cell.textContent || '').replace(cell.firstElementChild!.textContent || '', '').trim() ? cell.firstElementChild! : null;
      if (only) { const n = renameElement(only, tag); v!.design!.select(n, { contents: true }); return; }
      const n = doc.createElement(tag);
      while (cell.firstChild) n.appendChild(cell.firstChild);
      cell.appendChild(n);
      v!.design!.select(n, { contents: true });
    });
    return;
  }
  formatBlock(app, tag);
}

async function paragraphDialog(app: App): Promise<void> {
  const b = needDesign(app) && blockEl(app);
  if (!b) return;
  const own = inlineOf(b);
  const specs: PropSpec[] = [
    { prop: 'text-align', label: 'Alignment', type: 'select', options: ['left', 'center', 'right', 'justify', 'start', 'end'] },
    { prop: 'margin-left', label: 'Indent before text', type: 'combo', options: ['0', '20px', '40px', '2em'] },
    { prop: 'margin-right', label: 'Indent after text', type: 'combo', options: ['0', '20px', '40px', '2em'] },
    { prop: 'text-indent', label: 'First line indent', type: 'combo', options: ['0', '1em', '2em', '-1em'] },
    { prop: 'margin-top', label: 'Spacing before', type: 'combo', options: ['0', '0.5em', '1em', '12px'] },
    { prop: 'margin-bottom', label: 'Spacing after', type: 'combo', options: ['0', '0.5em', '1em', '12px'] },
    { prop: 'line-height', label: 'Line spacing', type: 'combo', options: ['normal', '1', '1.15', '1.5', '2'] },
    { prop: 'word-spacing', label: 'Word spacing', type: 'combo', options: ['normal', '0.25em'] },
  ];
  const fields = propFields(specs, own).map((f, i) => ({ ...f, half: i > 0 }));
  if (b.getAttribute('align') && !own['text-align']) fields[0].value = b.getAttribute('align');
  const v = await openDialog({
    title: `Paragraph: <${b.tagName.toLowerCase()}>`, fields, wide: true, preview: true,
    onChange: (vals, ctl) => { const p: Record<string, string> = {}; for (const s of specs) if (vals[s.prop]) p[s.prop] = vals[s.prop]; ctl.setPreview(previewHtml(p, 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.')); },
  });
  if (!v) return;
  const ch = changesFor(specs, v);
  if (app.prefs.cssMode === 'tags' && ch['text-align'] && /^(left|center|right|justify)$/.test(ch['text-align']!)) {
    const a = ch['text-align']!;
    delete ch['text-align'];
    mutate(app, () => { b.setAttribute('align', a); setInline(app, b, 'text-align', null); });
  } else if (b.hasAttribute('align')) mutate(app, () => b.removeAttribute('align'));
  applyProps(app, b, ch, 'Paragraph');
}

function align(app: App, value: 'left' | 'center' | 'right' | 'justify'): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' || !v.design?.doc) { wrapTag(app, 'div', { style: `text-align: ${value}` }); return; }
  const sel = selectedEl(app);
  const b = sel?.tagName === 'IMG' || sel?.tagName === 'TABLE' ? (sel.parentElement?.closest(BLOCKS) as HTMLElement) || sel : blockEl(app);
  if (!b) return;
  const cur = (b.getAttribute('align') || inlineOf(b)['text-align'] || '').toLowerCase();
  const next = cur === value && value !== 'left' ? null : value;
  if (app.prefs.cssMode === 'tags' && b.tagName !== 'BODY') {
    mutate(app, () => { if (next) b.setAttribute('align', next); else b.removeAttribute('align'); setInline(app, b, 'text-align', null); });
    return;
  }
  if (b.hasAttribute('align')) mutate(app, () => b.removeAttribute('align'));
  applyProps(app, b, { 'text-align': next }, 'Align');
}

function alignActive(value: string) {
  return (app: App) => {
    if (!inDesign(app)) return false;
    const b = blockEl(app);
    if (!b) return false;
    const a = (b.getAttribute('align') || cs(b).textAlign || '').toLowerCase();
    return a === value || (value === 'left' && a === 'start' && cs(b).direction !== 'rtl') || (value === 'right' && a === 'end' && cs(b).direction !== 'rtl');
  };
}

function indent(app: App, dir: 1 | -1): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' || !v.design?.doc) {
    if (dir > 0) wrapTag(app, 'blockquote');
    else { const s = selectionText(app); if (s) { v.code?.replaceSelection(s.replace(/^\s*<blockquote\b[^>]*>|<\/blockquote>\s*$/gi, ''), true); v.flush(); } }
    return;
  }
  const el = selectedEl(app);
  if (el?.closest('li')) { v.design.exec(dir > 0 ? 'indent' : 'outdent'); v.flush(); return; }
  const b = blockEl(app);
  if (!b || b === v.design.doc.body) { v.design.exec(dir > 0 ? 'indent' : 'outdent'); v.flush(); return; }
  if (dir < 0 && b.closest('blockquote') && !inlineOf(b)['margin-left']) { const q = b.closest('blockquote')!; mutate(app, () => unwrap(q)); return; }
  const curPx = parseFloat(inlineOf(b)['margin-left'] || '0') || 0;
  const unit = /em$/.test(inlineOf(b)['margin-left'] || '') ? 'em' : 'px';
  const step = unit === 'em' ? 2.5 : 40;
  const next = Math.max(0, curPx + dir * step);
  applyProps(app, b, { 'margin-left': next ? `${next}${unit}` : null }, dir > 0 ? 'Increase Indent' : 'Decrease Indent');
}

// ------------------------------------------------------------------------------------------
// Lists

function selectionLines(app: App): string[] {
  const t = selectionText(app);
  return t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The block elements the selection covers (siblings from the start block to the end block). */
function selectedBlocks(app: App): HTMLElement[] {
  const d = view(app)?.design;
  const r = d?.restoreRange();
  const one = blockEl(app);
  if (!d?.doc || !r) return one && one !== d?.doc?.body ? [one] : [];
  const blockOf = (n: Node) => (n.nodeType === 1 ? n as Element : n.parentElement)?.closest('p,h1,h2,h3,h4,h5,h6,pre,address,div,blockquote') as HTMLElement | null;
  const a = blockOf(r.startContainer), b = blockOf(r.endContainer);
  if (a && b && a !== b && a.parentElement === b.parentElement) {
    const out: HTMLElement[] = [];
    for (let n: Element | null = a; n; n = n.nextElementSibling) { out.push(n as HTMLElement); if (n === b) break; }
    return out;
  }
  const blk = a || one;
  return blk && blk !== d.doc.body ? [blk] : [];
}

function makeList(app: App, ordered: boolean): void {
  const v = view(app);
  if (!v) return;
  const tag = ordered ? 'ol' : 'ul';
  if (v.target === 'design' && v.design?.doc) {
    const list = closestSel(app, 'ul,ol');
    if (list) {
      if (list.tagName.toLowerCase() === tag) { listNone(app); return; }
      mutate(app, () => { const n = renameElement(list, tag); v.design!.select(n); });
      return;
    }
    const blocks = selectedBlocks(app).filter((b) => !/^(BODY|TD|TH|LI)$/.test(b.tagName));
    if (!blocks.length) { v.design.exec(ordered ? 'insertOrderedList' : 'insertUnorderedList'); v.flush(); return; }
    mutate(app, (doc) => {
      const l = doc.createElement(tag);
      blocks[0].before(l);
      for (const b of blocks) {
        const li = doc.createElement('li');
        if (/^(P|DIV)$/.test(b.tagName) && !b.attributes.length) { while (b.firstChild) li.appendChild(b.firstChild); b.remove(); } else li.appendChild(b);
        l.appendChild(li);
      }
      v.design!.select(l.lastElementChild, { contents: true });
    });
    return;
  }
  const lines = selectionLines(app);
  insertHtml(app, `<${tag}>\n${(lines.length ? lines : ['']).map((l) => `  <li>${/</.test(l) ? l : escText(l)}</li>`).join('\n')}\n</${tag}>`);
}

function listNone(app: App): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' || !v.design?.doc) {
    const s = selectionText(app);
    if (!s) return;
    v.code?.replaceSelection(s.replace(/<\/?(?:ul|ol|dl)\b[^>]*>\s*/gi, '').replace(/<(li|dt|dd)\b[^>]*>/gi, '<p>').replace(/<\/(li|dt|dd)>/gi, '</p>'), true);
    v.flush();
    return;
  }
  const list = closestSel(app, 'ul,ol,dl');
  if (!list) { toast('The selection is not in a list.'); return; }
  mutate(app, (doc) => {
    const frag = doc.createDocumentFragment();
    for (const li of [...list.children]) {
      const p = doc.createElement('p');
      while (li.firstChild) p.appendChild(li.firstChild);
      frag.appendChild(p);
    }
    list.replaceWith(frag);
  });
}

function definitionList(app: App): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'design' && v.design?.doc) {
    const list = closestSel(app, 'ul,ol');
    if (list) {
      mutate(app, (doc) => {
        const dl = doc.createElement('dl');
        [...list.children].forEach((li, i) => { const n = doc.createElement(i % 2 ? 'dd' : 'dt'); while (li.firstChild) n.appendChild(li.firstChild); dl.appendChild(n); });
        list.replaceWith(dl);
      });
      return;
    }
  }
  const lines = selectionLines(app);
  const items = lines.length ? lines : ['Term', 'Definition'];
  insertHtml(app, `<dl>\n${items.map((l, i) => `  <${i % 2 ? 'dd' : 'dt'}>${/</.test(l) ? l : escText(l)}</${i % 2 ? 'dd' : 'dt'}>`).join('\n')}\n</dl>`);
}

const LIST_TYPES = [
  { value: 'disc', label: 'Bullets: filled circle' }, { value: 'circle', label: 'Bullets: open circle' }, { value: 'square', label: 'Bullets: square' },
  { value: 'decimal', label: 'Numbers: 1, 2, 3' }, { value: 'decimal-leading-zero', label: 'Numbers: 01, 02, 03' }, { value: 'lower-alpha', label: 'Letters: a, b, c' }, { value: 'upper-alpha', label: 'Letters: A, B, C' },
  { value: 'lower-roman', label: 'Roman: i, ii, iii' }, { value: 'upper-roman', label: 'Roman: I, II, III' }, { value: 'lower-greek', label: 'Greek: α, β, γ' }, { value: 'none', label: 'None' },
];

async function listDialog(app: App): Promise<void> {
  if (!needDesign(app)) return;
  let list = closestSel(app, 'ul,ol');
  const own = inlineOf(list);
  const type = own['list-style-type'] || (list?.tagName === 'OL' ? ({ a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' } as Record<string, string>)[list.getAttribute('type') || ''] || 'decimal' : 'disc');
  const images = siteImages(app, app.active.path);
  const v = await openDialog({
    title: list ? 'List Properties' : 'Bullets and Numbering', wide: true, preview: true,
    fields: [
      { key: 'kind', label: 'List', type: 'radio', value: list?.tagName === 'OL' ? 'ol' : 'ul', options: [{ value: 'ul', label: 'Bulleted' }, { value: 'ol', label: 'Numbered' }] },
      { key: 'type', label: 'Style', type: 'select', value: type, options: LIST_TYPES },
      { key: 'image', label: 'Picture bullets', type: 'combo', value: own['list-style-image'] || '', options: ['none', ...images], placeholder: 'url("images/bullet.png")' },
      { key: 'position', label: 'Bullet position', type: 'select', value: own['list-style-position'] || '', options: [{ value: '', label: '(not set)' }, 'outside', 'inside'] },
      { key: 'start', label: 'Start at', type: 'number', value: list?.getAttribute('start') || '', min: -1000, visibleIf: (x) => x.kind === 'ol', half: true },
      { key: 'reversed', label: 'Count down (reversed)', type: 'checkbox', value: list?.hasAttribute('reversed'), visibleIf: (x) => x.kind === 'ol', half: true },
    ],
    onChange: (vals, ctl) => {
      const t = vals.kind === 'ol' ? 'ol' : 'ul';
      const st = C.declText({ 'list-style-type': vals.type, 'list-style-image': /^url\(/.test(vals.image) ? cacheFor(app).css(vals.image, app.active.path, 'blob') : '', 'list-style-position': vals.position });
      ctl.setPreview(`<${t} style="${st.replace(/"/g, '&quot;')}"${vals.start && t === 'ol' ? ` start="${+vals.start}"` : ''}${vals.reversed && t === 'ol' ? ' reversed' : ''}><li>First item</li><li>Second item</li><li>Third item</li></${t}>`);
    },
  });
  if (!v) return;
  if (!list) {
    makeList(app, v.kind === 'ol');
    list = closestSel(app, 'ul,ol');
    if (!list) return;
  }
  let target = list as HTMLElement;
  const defType = v.kind === 'ol' ? 'decimal' : 'disc';
  mutate(app, () => {
    if (target.tagName.toLowerCase() !== v.kind) target = renameElement(target, v.kind) as HTMLElement;
    target.removeAttribute('type');
    if (v.kind === 'ol' && v.start !== null && v.start !== '' && !isNaN(+v.start)) target.setAttribute('start', String(Math.round(+v.start))); else target.removeAttribute('start');
    if (v.kind === 'ol' && v.reversed) target.setAttribute('reversed', ''); else target.removeAttribute('reversed');
    if (app.prefs.cssMode !== 'class') {
      setInline(app, target, 'list-style-type', v.type === defType ? null : v.type);
      setInline(app, target, 'list-style-image', v.image && v.image !== 'none' ? v.image : null);
      setInline(app, target, 'list-style-position', v.position || null);
    }
  });
  if (app.prefs.cssMode === 'class') applyProps(app, target, { 'list-style-type': v.type === defType ? null : v.type, 'list-style-image': v.image && v.image !== 'none' ? v.image : null, 'list-style-position': v.position || null }, 'List Properties');
}

// ------------------------------------------------------------------------------------------
// Borders, box, flexbox, grid

async function bordersDialog(app: App): Promise<void> {
  const el = needDesign(app);
  if (!el) return;
  const own = inlineOf(el);
  const c = cs(el);
  const side = ['top', 'right', 'bottom', 'left'].find((s) => own[`border-${s}`] || own[`border-${s}-style`]) && !own['border'] && !own['border-style'] ? 'top' : 'all';
  const k = (p: string, s = side) => (s === 'all' ? `border-${p}` : `border-${s}-${p}`);
  const sh = C.styleToObject(`x: ${own.border || ''}`).x || '';
  const shStyle = /\b(none|solid|dashed|dotted|double|groove|ridge|inset|outset|hidden)\b/.exec(sh)?.[1] || '';
  const v = await openDialog({
    title: `Borders and Shading: <${el.tagName.toLowerCase()}>`, wide: true, preview: true,
    help: `Now: border ${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}; padding ${c.padding || c.paddingTop}; background ${c.backgroundColor}.`,
    fields: [
      { key: 'heading1', type: 'heading', label: 'Borders' },
      { key: 'side', label: 'Apply to', type: 'select', value: side, options: [{ value: 'all', label: 'All sides' }, { value: 'top', label: 'Top' }, { value: 'right', label: 'Right' }, { value: 'bottom', label: 'Bottom' }, { value: 'left', label: 'Left' }] },
      { key: 'style', label: 'Style', type: 'select', value: own[k('style')] || shStyle, options: [{ value: '', label: '(not set)' }, 'none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'], half: true },
      { key: 'width', label: 'Width', type: 'combo', value: own[k('width')] || /\b(\d*\.?\d+(px|em|rem)|thin|medium|thick)\b/.exec(sh)?.[1] || '', options: ['thin', 'medium', 'thick', '1px', '2px', '3px', '5px'], half: true },
      { key: 'color', label: 'Color', type: 'text', value: own[k('color')] || '', half: true, placeholder: '#rrggbb' },
      { key: 'pick_color', label: 'Pick', type: 'color', value: own[k('color')] || '#000000', half: true },
      { key: 'border-radius', label: 'Rounded corners', type: 'combo', value: own['border-radius'] || '', options: ['0', '4px', '8px', '16px', '50%'] },
      { key: 'heading2', type: 'heading', label: 'Padding' },
      { key: 'padding-top', label: 'Top', type: 'combo', value: own['padding-top'] || '', options: ['0', '4px', '8px', '1em'], half: true },
      { key: 'padding-bottom', label: 'Bottom', type: 'combo', value: own['padding-bottom'] || '', options: ['0', '4px', '8px', '1em'], half: true },
      { key: 'padding-left', label: 'Left', type: 'combo', value: own['padding-left'] || '', options: ['0', '4px', '8px', '1em'], half: true },
      { key: 'padding-right', label: 'Right', type: 'combo', value: own['padding-right'] || '', options: ['0', '4px', '8px', '1em'], half: true },
      { key: 'heading3', type: 'heading', label: 'Shading' },
      { key: 'background-color', label: 'Background color', type: 'text', value: own['background-color'] || '', half: true, placeholder: '#rrggbb' },
      { key: 'pick_background-color', label: 'Pick', type: 'color', value: own['background-color'] || '#ffffff', half: true },
      { key: 'background-image', label: 'Background picture', type: 'combo', value: own['background-image'] || '', options: ['none', ...siteImages(app, app.active.path)] },
      { key: 'background-repeat', label: 'Repeat', type: 'select', value: own['background-repeat'] || '', options: [{ value: '', label: '(not set)' }, 'repeat', 'repeat-x', 'repeat-y', 'no-repeat'], half: true },
      { key: 'background-position', label: 'Position', type: 'combo', value: own['background-position'] || '', options: ['left top', 'center', 'right bottom'], half: true },
    ],
    onChange: (vals, ctl, key) => {
      syncPicker(ctl, key, vals);
      if (key === 'side') { ctl.set('style', own[k('style', vals.side)] || ''); ctl.set('width', own[k('width', vals.side)] || ''); ctl.set('color', own[k('color', vals.side)] || ''); }
      const x = ctl.values();
      const b = [x.width, x.style, x.color].filter(Boolean).join(' ');
      const p = C.declText({ [x.side === 'all' ? 'border' : `border-${x.side}`]: x.style ? b : '', 'border-radius': x['border-radius'], 'padding-top': x['padding-top'], 'padding-bottom': x['padding-bottom'], 'padding-left': x['padding-left'], 'padding-right': x['padding-right'], 'background-color': x['background-color'] });
      ctl.setPreview(`<div style="${p.replace(/"/g, '&quot;')}">The quick brown fox jumps over the lazy dog.</div>`);
    },
  });
  if (!v) return;
  const ch: Record<string, string | null> = {};
  if (v.side === 'all') { ch['border-style'] = v.style || null; ch['border-width'] = v.width || null; ch['border-color'] = v.color || null; if (own.border && (v.style || v.width || v.color)) ch.border = null; }
  else { ch[`border-${v.side}-style`] = v.style || null; ch[`border-${v.side}-width`] = v.width || null; ch[`border-${v.side}-color`] = v.color || null; }
  for (const p of ['border-radius', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'background-color', 'background-image', 'background-repeat', 'background-position']) ch[p] = String(v[p] || '').trim() || null;
  if (own.padding && ['padding-top', 'padding-bottom', 'padding-left', 'padding-right'].some((p) => ch[p])) {
    const parts = own.padding.split(/\s+/);
    const [t, r = t, b = t, l = r] = parts;
    for (const [p, d] of [['padding-top', t], ['padding-right', r], ['padding-bottom', b], ['padding-left', l]] as const) if (!ch[p]) ch[p] = d;
    ch.padding = null;
  }
  applyProps(app, el, ch, 'Borders and Shading');
}

async function propDialog(app: App, title: string, specs: PropSpec[], opts: { extra?: Field[]; onApply?: (el: HTMLElement, v: Record<string, any>) => void; defaults?: Record<string, string>; help?: string; preview?: (v: Record<string, any>) => string } = {}): Promise<void> {
  const el = needDesign(app);
  if (!el) return;
  const own = { ...(opts.defaults || {}), ...inlineOf(el) };
  const v = await openDialog({
    title: `${title}: <${el.tagName.toLowerCase()}>`, wide: true, help: opts.help, preview: !!opts.preview,
    fields: [...propFields(specs, own).map((f) => ({ ...f, half: f.type !== 'color' && f.key !== specs[0]?.prop ? true : f.half })), ...(opts.extra || [])],
    onChange: (vals, ctl, key) => { syncPicker(ctl, key, vals); if (opts.preview) ctl.setPreview(opts.preview(ctl.values())); },
  });
  if (!v) return;
  const ch = changesFor(specs, v);
  applyProps(app, el, ch, title);
  opts.onApply?.(el, v);
}

const BOX_SPECS: PropSpec[] = [
  { prop: 'margin', label: 'Margin (top right bottom left)', type: 'combo', options: ['0', 'auto', '0 auto', '1em 0', '10px 20px'] },
  { prop: 'padding', label: 'Padding (top right bottom left)', type: 'combo', options: ['0', '4px', '8px', '1em', '10px 20px'] },
  { prop: 'width', label: 'Width', type: 'combo', options: ['auto', '100%', '50%', '300px', 'fit-content', 'max-content'] },
  { prop: 'height', label: 'Height', type: 'combo', options: ['auto', '100%', '200px', '100vh'] },
  { prop: 'min-width', label: 'Min width', type: 'combo', options: ['0', '200px'] },
  { prop: 'max-width', label: 'Max width', type: 'combo', options: ['none', '100%', '960px', '1200px'] },
  { prop: 'min-height', label: 'Min height', type: 'combo', options: ['0', '100px', '100vh'] },
  { prop: 'box-sizing', label: 'Box sizing', type: 'select', options: ['content-box', 'border-box'] },
  { prop: 'display', label: 'Display', type: 'select', options: ['block', 'inline', 'inline-block', 'flex', 'grid', 'none', 'contents'] },
  { prop: 'overflow', label: 'Overflow', type: 'select', options: ['visible', 'hidden', 'scroll', 'auto', 'clip'] },
];

const FLEX_SPECS: PropSpec[] = [
  { prop: 'display', label: 'Display', type: 'select', options: ['flex', 'inline-flex', 'block'] },
  { prop: 'flex-direction', label: 'Direction', type: 'select', options: ['row', 'row-reverse', 'column', 'column-reverse'] },
  { prop: 'flex-wrap', label: 'Wrap', type: 'select', options: ['nowrap', 'wrap', 'wrap-reverse'] },
  { prop: 'justify-content', label: 'Justify content', type: 'select', options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] },
  { prop: 'align-items', label: 'Align items', type: 'select', options: ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'] },
  { prop: 'align-content', label: 'Align lines', type: 'select', options: ['normal', 'flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'stretch'] },
  { prop: 'gap', label: 'Gap', type: 'combo', options: ['0', '8px', '1em', '16px', '1rem 2rem'] },
];

const GRID_SPECS: PropSpec[] = [
  { prop: 'display', label: 'Display', type: 'select', options: ['grid', 'inline-grid', 'block'] },
  { prop: 'grid-template-columns', label: 'Columns', type: 'combo', options: ['repeat(2, 1fr)', 'repeat(3, 1fr)', 'repeat(4, 1fr)', '1fr 3fr', '200px 1fr', '1fr 2fr 1fr', 'repeat(auto-fill, minmax(200px, 1fr))'] },
  { prop: 'grid-template-rows', label: 'Rows', type: 'combo', options: ['auto', 'auto 1fr auto', 'repeat(2, 200px)'] },
  { prop: 'grid-template-areas', label: 'Areas', type: 'combo', options: ['"header header" "sidebar main" "footer footer"'] },
  { prop: 'gap', label: 'Gap', type: 'combo', options: ['0', '8px', '1em', '16px', '1rem 2rem'] },
  { prop: 'grid-auto-flow', label: 'Auto flow', type: 'select', options: ['row', 'column', 'dense', 'row dense'] },
  { prop: 'justify-items', label: 'Justify items', type: 'select', options: ['stretch', 'start', 'center', 'end'] },
  { prop: 'align-items', label: 'Align items', type: 'select', options: ['stretch', 'start', 'center', 'end', 'baseline'] },
];

const boxPreview = (style: Record<string, any>, kids = 3) => `<div style="${C.declText(Object.fromEntries(Object.entries(style).filter(([k, x]) => x && !k.startsWith('pick_') && !k.startsWith('kid')))).replace(/"/g, '&quot;')};border:1px dashed #999;padding:4px">${Array.from({ length: kids }, (_, i) => `<div style="background:#cfe0f5;border:1px solid #7aa3d6;padding:6px;${style.kidsFlex ? 'flex:1 1 0;' : ''}">Item ${i + 1}</div>`).join('')}</div>`;

// ------------------------------------------------------------------------------------------
// Positioning and layers

const isPositioned = (el: Element) => cs(el).position !== 'static';
const isAbs = (el: Element) => /^(absolute|fixed)$/.test(cs(el).position);

function posEl(app: App, abs = false): HTMLElement | null {
  const el = needDesign(app);
  if (!el) return null;
  let n: HTMLElement | null = el;
  while (n && n.tagName !== 'BODY' && !(abs ? isAbs(n) : isPositioned(n))) n = n.parentElement;
  if (!n || n.tagName === 'BODY') { toast(abs ? 'Select an absolutely positioned element (Layout ▸ Absolute).' : 'Select a positioned element first (Layout ▸ Absolute or Relative).'); return null; }
  return n;
}

function togglePosition(app: App, kind: 'absolute' | 'relative'): void {
  const el = needDesign(app);
  if (!el || el.tagName === 'BODY') { toast('Select an element (not the page body).'); return; }
  const own = inlineOf(el);
  if (own.position === kind) { applyProps(app, el, { position: null, ...(kind === 'absolute' ? { left: null, top: null } : {}) }, 'Position'); return; }
  if (kind === 'absolute') {
    const c = cs(el);
    const ml = parseFloat(c.marginLeft) || 0, mt = parseFloat(c.marginTop) || 0;
    applyProps(app, el, { position: 'absolute', left: `${Math.round(el.offsetLeft - ml)}px`, top: `${Math.round(el.offsetTop - mt)}px`, width: own.width || (c.display === 'inline' ? null : `${Math.round(parseFloat(c.width))}px`) }, 'Position Absolutely');
  } else applyProps(app, el, { position: 'relative' }, 'Position Relatively');
}

/** Restacks the positioned siblings so `el` moves to the front/back or one step. */
function zOrder(app: App, how: 'front' | 'back' | 'forward' | 'backward'): void {
  const el = posEl(app);
  if (!el) return;
  const sibs = [...el.parentElement!.children].filter((c) => c === el || isPositioned(c)) as HTMLElement[];
  const z = (e: HTMLElement) => { const v = parseInt(cs(e).zIndex, 10); return isNaN(v) ? 0 : v; };
  const order = sibs.map((e, i) => ({ e, z: z(e), i })).sort((a, b) => a.z - b.z || a.i - b.i).map((x) => x.e);
  const i = order.indexOf(el);
  order.splice(i, 1);
  const j = how === 'front' ? order.length : how === 'back' ? 0 : how === 'forward' ? Math.min(order.length, i + 1) : Math.max(0, i - 1);
  order.splice(j, 0, el);
  mutate(app, () => order.forEach((e, k) => setInline(app, e, 'z-index', String(k + 1))));
}

/** Aligns the absolutely positioned siblings of the selected element to it. */
function alignLayers(app: App, how: 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'): void {
  const el = posEl(app, true);
  if (!el) return;
  const others = [...el.parentElement!.children].filter((c) => c !== el && isAbs(c)) as HTMLElement[];
  if (!others.length) { toast('There are no other absolutely positioned elements beside the selected one.'); return; }
  const L = el.offsetLeft, T = el.offsetTop, W = el.offsetWidth, H = el.offsetHeight;
  mutate(app, () => {
    for (const o of others) {
      const c = cs(o);
      const ml = parseFloat(c.marginLeft) || 0, mt = parseFloat(c.marginTop) || 0;
      const px = (n: number) => `${Math.round(n)}px`;
      const extraW = c.boxSizing === 'border-box' ? 0 : (parseFloat(c.paddingLeft) || 0) + (parseFloat(c.paddingRight) || 0) + (parseFloat(c.borderLeftWidth) || 0) + (parseFloat(c.borderRightWidth) || 0);
      const extraH = c.boxSizing === 'border-box' ? 0 : (parseFloat(c.paddingTop) || 0) + (parseFloat(c.paddingBottom) || 0) + (parseFloat(c.borderTopWidth) || 0) + (parseFloat(c.borderBottomWidth) || 0);
      if (how === 'left') { setInline(app, o, 'left', px(L - ml)); setInline(app, o, 'right', null); }
      if (how === 'right') { setInline(app, o, 'left', px(L + W - o.offsetWidth - ml)); setInline(app, o, 'right', null); }
      if (how === 'top') { setInline(app, o, 'top', px(T - mt)); setInline(app, o, 'bottom', null); }
      if (how === 'bottom') { setInline(app, o, 'top', px(T + H - o.offsetHeight - mt)); setInline(app, o, 'bottom', null); }
      if (how === 'width') setInline(app, o, 'width', px(W - extraW));
      if (how === 'height') setInline(app, o, 'height', px(H - extraH));
    }
  });
}

const POSITION_SPECS: PropSpec[] = [
  { prop: 'float', label: 'Wrapping style', type: 'select', options: ['none', 'left', 'right'] },
  { prop: 'position', label: 'Positioning', type: 'select', options: ['static', 'relative', 'absolute', 'fixed', 'sticky'] },
  { prop: 'top', label: 'Top', type: 'combo', options: ['0', 'auto', '10px', '50px'] },
  { prop: 'left', label: 'Left', type: 'combo', options: ['0', 'auto', '10px', '50px'] },
  { prop: 'bottom', label: 'Bottom', type: 'combo', options: ['0', 'auto'] },
  { prop: 'right', label: 'Right', type: 'combo', options: ['0', 'auto'] },
  { prop: 'width', label: 'Width', type: 'combo', options: ['auto', '100%', '200px'] },
  { prop: 'height', label: 'Height', type: 'combo', options: ['auto', '100px', '200px'] },
  { prop: 'z-index', label: 'Z-index', type: 'text' },
];

const LAYER_SPECS: PropSpec[] = [
  { prop: 'visibility', label: 'Visibility', type: 'select', options: ['visible', 'hidden', 'inherit'] },
  { prop: 'overflow', label: 'Overflow', type: 'select', options: ['visible', 'hidden', 'scroll', 'auto'] },
  { prop: 'background-color', label: 'Background color', type: 'color' },
  ...POSITION_SPECS.filter((s) => s.prop !== 'float'),
];

// ------------------------------------------------------------------------------------------
// Page: background, colors, doctype, encoding

/** Changes the <body> start tag of a page's source. */
function editBodyTag(src: string, fn: (tag: string) => string): string {
  const r = regions(src);
  if (!r.bodyOpen) return src;
  return src.slice(0, r.bodyOpen[0]) + fn(src.slice(r.bodyOpen[0], r.bodyOpen[1])) + src.slice(r.bodyOpen[1]);
}
const tagAttr = (tag: string, name: string) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag); return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null; };
const bodyTag = (src: string) => { const r = regions(src); return r.bodyOpen ? src.slice(r.bodyOpen[0], r.bodyOpen[1]) : '<body>'; };

/** Sets body declarations: in the page's <style> (Classes mode, or when asked) or in the body's style attribute. */
function setBodyStyle(app: App, props: Record<string, string | null>, label: string, inRule = app.prefs.cssMode === 'class'): void {
  keepSelection(app);
  app.editSource(label, (src) => {
    if (inRule) return editHeadStyle(src, (css) => C.setDeclarations(css, 'body', props));
    return editBodyTag(src, (tag) => { const s = C.setStyleDecls(tagAttr(tag, 'style') || '', props); return setTagAttr(tag, 'style', s || null); });
  });
}

function bodyStyleNow(app: App): Record<string, string> {
  const src = fileText(app, app.active.path);
  const fromRule = pageSheets(app).filter((s) => s.kind === 'page').flatMap((s) => C.findRules(s.css, 'body', null)).reduce((o, r) => ({ ...o, ...C.declMap(r) }), {} as Record<string, string>);
  return { ...fromRule, ...C.styleToObject(tagAttr(bodyTag(src), 'style') || '') };
}

async function backgroundDialog(app: App): Promise<void> {
  const src = fileText(app, app.active.path);
  const tag = bodyTag(src);
  const now = bodyStyleNow(app);
  const legacy = { bgcolor: tagAttr(tag, 'bgcolor'), background: tagAttr(tag, 'background') };
  const images = siteImages(app, app.active.path);
  const specs: PropSpec[] = [
    { prop: 'background-color', label: 'Background color', type: 'color' },
    { prop: 'background-image', label: 'Background picture', type: 'combo', options: images },
    { prop: 'background-repeat', label: 'Repeat', type: 'select', options: ['repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round'] },
    { prop: 'background-attachment', label: 'Attachment', type: 'select', options: ['scroll', 'fixed', 'local'] },
    { prop: 'background-position', label: 'Position', type: 'combo', options: ['left top', 'center top', 'center center', 'right bottom'] },
    { prop: 'background-size', label: 'Size', type: 'combo', options: ['auto', 'cover', 'contain'] },
  ];
  const init = { ...now };
  if (!init['background-color'] && legacy.bgcolor) init['background-color'] = legacy.bgcolor;
  if (!init['background-image'] && legacy.background) init['background-image'] = `url("${legacy.background}")`;
  const v = await openDialog({
    title: 'Page Background', wide: true, preview: true,
    fields: [...propFields(specs, init, { images }), { key: 'where', label: 'Write as', type: 'radio', value: legacy.bgcolor || legacy.background ? 'legacy' : app.prefs.cssMode === 'class' ? 'rule' : 'inline', options: [{ value: 'rule', label: 'A body rule in the page\'s style block' }, { value: 'inline', label: 'The body\'s style attribute' }, { value: 'legacy', label: 'Legacy attributes (bgcolor, background) for old browsers' }] }],
    onChange: (vals, ctl, key) => { syncPicker(ctl, key, vals); ctl.setPreview(`<div style="height:90px;${C.declText({ 'background-color': ctl.get('background-color') }).replace(/"/g, '&quot;')};border:1px solid #999;padding:8px">Page text</div>`); },
  });
  if (!v) return;
  const ch = changesFor(specs, v);
  if (v.where === 'legacy') {
    const img = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(ch['background-image'] || '')?.[1] || null;
    app.editSource('Page Background', (s) => editBodyTag(s, (t) => setTagAttr(setTagAttr(t, 'bgcolor', ch['background-color']), 'background', img)));
    const rest = { 'background-repeat': ch['background-repeat'], 'background-attachment': ch['background-attachment'], 'background-position': ch['background-position'], 'background-size': ch['background-size'] };
    if (Object.values(rest).some(Boolean)) setBodyStyle(app, rest, 'Page Background', false);
    return;
  }
  app.editSource('Page Background', (s) => editBodyTag(s, (t) => setTagAttr(setTagAttr(t, 'bgcolor', null), 'background', null)));
  if (v.where === 'rule') {
    const inline = C.styleToObject(tagAttr(bodyTag(fileText(app, app.active.path)), 'style') || '');
    const strip = Object.fromEntries(specs.map((s) => [s.prop, null]).filter(([p]) => inline[p as string]));
    if (Object.keys(strip).length) setBodyStyle(app, strip, 'Page Background', false);
  }
  setBodyStyle(app, ch, 'Page Background', v.where === 'rule');
}

async function pageColorsDialog(app: App): Promise<void> {
  const sheets = pageSheets(app).filter((s) => s.kind === 'page');
  const ruleVal = (sel: string, p: string) => { for (const s of [...sheets].reverse()) { const r = C.findRules(s.css, sel, null).pop(); const d = r && C.declMap(r)[p]; if (d) return d; } return ''; };
  const rows: [string, string, string, string][] = [
    ['text', 'Text', 'body', 'color'], ['bg', 'Background', 'body', 'background-color'], ['link', 'Hyperlink', 'a:link', 'color'],
    ['visited', 'Visited hyperlink', 'a:visited', 'color'], ['hover', 'Hovered hyperlink', 'a:hover', 'color'], ['active', 'Active hyperlink', 'a:active', 'color'],
  ];
  const fields: Field[] = [];
  for (const [k, label, sel, p] of rows) {
    const cur = ruleVal(sel, p);
    fields.push({ key: k, label, type: 'text', value: cur, half: true, placeholder: '(default)' }, { key: 'pick_' + k, label: 'Pick', type: 'color', value: toHexSafe(cur, k === 'bg' ? '#ffffff' : '#000000'), half: true });
  }
  fields.push({ key: 'legacy', label: 'Also write the legacy body attributes (text, link, vlink, alink, bgcolor)', type: 'checkbox', value: false });
  const v = await openDialog({
    title: 'Page Colors', wide: true, preview: true, fields,
    onChange: (vals, ctl, key) => {
      if (key.startsWith('pick_')) ctl.set(key.slice(5), vals[key]);
      const x = ctl.values();
      ctl.setPreview(`<div style="padding:8px;color:${x.text || 'inherit'};background:${x.bg || 'transparent'}">Page text with <span style="color:${x.link || '#0000ee'};text-decoration:underline">a link</span>, <span style="color:${x.visited || '#551a8b'};text-decoration:underline">a visited link</span> and <span style="color:${x.hover || x.link || '#0000ee'};text-decoration:underline">a hovered link</span>.</div>`.replace(/color:([^;"]*)/g, (m) => m.replace(/[<>"]/g, '')));
    },
  });
  if (!v) return;
  const val = (k: string) => String(v[k] || '').trim() || null;
  keepSelection(app);
  app.editSource('Page Colors', (src) => {
    let out = editHeadStyle(src, (css) => {
      let c = C.setDeclarations(css, 'body', { color: val('text'), 'background-color': val('bg') });
      for (const [k, sel] of [['link', 'a:link'], ['visited', 'a:visited'], ['hover', 'a:hover'], ['active', 'a:active']]) c = C.setDeclaration(c, sel, 'color', val(k));
      return c;
    });
    if (v.legacy) out = editBodyTag(out, (t) => [['text', 'text'], ['link', 'link'], ['vlink', 'visited'], ['alink', 'active'], ['bgcolor', 'bg']].reduce((tag, [attr, k]) => setTagAttr(tag, attr, val(k)), t));
    return out;
  });
}

function toHexSafe(c: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('');
  return fallback;
}

const CHARSETS: [string, string][] = [
  ['utf-8', 'Unicode (UTF-8)'], ['utf-16', 'Unicode (UTF-16)'], ['iso-8859-1', 'Western European (ISO 8859-1)'], ['windows-1252', 'Western European (Windows)'], ['iso-8859-15', 'Western European (ISO 8859-15, with euro)'],
  ['iso-8859-2', 'Central European (ISO 8859-2)'], ['windows-1250', 'Central European (Windows)'], ['iso-8859-5', 'Cyrillic (ISO 8859-5)'], ['windows-1251', 'Cyrillic (Windows)'], ['koi8-r', 'Cyrillic (KOI8-R)'],
  ['iso-8859-7', 'Greek (ISO 8859-7)'], ['windows-1253', 'Greek (Windows)'], ['iso-8859-9', 'Turkish (ISO 8859-9)'], ['windows-1254', 'Turkish (Windows)'], ['iso-8859-6', 'Arabic (ISO 8859-6)'], ['windows-1256', 'Arabic (Windows)'],
  ['iso-8859-8', 'Hebrew (ISO 8859-8)'], ['windows-1255', 'Hebrew (Windows)'], ['windows-874', 'Thai (Windows)'], ['shift_jis', 'Japanese (Shift_JIS)'], ['euc-jp', 'Japanese (EUC)'], ['iso-2022-jp', 'Japanese (JIS)'],
  ['gb2312', 'Chinese Simplified (GB2312)'], ['gbk', 'Chinese Simplified (GBK)'], ['gb18030', 'Chinese Simplified (GB18030)'], ['big5', 'Chinese Traditional (Big5)'], ['euc-kr', 'Korean (EUC-KR)'], ['windows-1258', 'Vietnamese (Windows)'],
];

// ------------------------------------------------------------------------------------------
// Themes

interface Theme { id: string; name: string; bg: string; surface: string; text: string; muted: string; accent: string; accent2: string; link: string; visited: string; heading: string; body: string }
export const THEMES: Theme[] = [
  { id: 'harbor', name: 'Harbor', bg: '#f7fafc', surface: '#e6eef5', text: '#1f2d3a', muted: '#9fb3c4', accent: '#1d5b8f', accent2: '#e0893a', link: '#1d5b8f', visited: '#5a4a8a', heading: 'Georgia, "Times New Roman", serif', body: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif' },
  { id: 'meadow', name: 'Meadow', bg: '#fbfdf7', surface: '#eaf3dc', text: '#27321f', muted: '#b4c79a', accent: '#3f7a2a', accent2: '#d4a72c', link: '#2f6b1f', visited: '#6b5a1f', heading: '"Trebuchet MS", Helvetica, sans-serif', body: 'Verdana, Geneva, sans-serif' },
  { id: 'sandstone', name: 'Sandstone', bg: '#fdf8f1', surface: '#f3e6d3', text: '#3b2f25', muted: '#d2bea2', accent: '#a0522d', accent2: '#5f8a8b', link: '#8b3f1d', visited: '#6d4c41', heading: '"Palatino Linotype", "Book Antiqua", Palatino, serif', body: 'Georgia, "Times New Roman", serif' },
  { id: 'slate', name: 'Slate', bg: '#ffffff', surface: '#eef0f3', text: '#2b2f36', muted: '#b8bec8', accent: '#3d4a5c', accent2: '#2a9d8f', link: '#1f6f8b', visited: '#5b5f97', heading: '"Helvetica Neue", Helvetica, Arial, sans-serif', body: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'orchard', name: 'Orchard', bg: '#fffaf6', surface: '#fde7da', text: '#3a2a2a', muted: '#e6b9a3', accent: '#b23a48', accent2: '#f4a259', link: '#a02c3a', visited: '#7a3b69', heading: 'Garamond, Baskerville, "Baskerville Old Face", serif', body: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif' },
  { id: 'midnight', name: 'Midnight', bg: '#141a24', surface: '#1f2836', text: '#dfe6ef', muted: '#3b4a5e', accent: '#7fb7ff', accent2: '#f6c177', link: '#8ec5ff', visited: '#c3a6ff', heading: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'blossom', name: 'Blossom', bg: '#fff9fb', surface: '#fbe4ee', text: '#3d2a33', muted: '#e7b8cb', accent: '#b0457a', accent2: '#6aa39b', link: '#a33a6e', visited: '#6e4a8a', heading: '"Trebuchet MS", Helvetica, sans-serif', body: 'Georgia, "Times New Roman", serif' },
  { id: 'ledger', name: 'Ledger', bg: '#fdfdfb', surface: '#f0efe8', text: '#222222', muted: '#c9c7bb', accent: '#2d4739', accent2: '#8c6d31', link: '#2d4739', visited: '#5d4b2a', heading: '"Times New Roman", Times, serif', body: '"Courier New", Courier, monospace' },
];

export function themeCss(t: Theme): string {
  return `/* Theme: ${t.name}. Created by Format > Theme. Applying another theme replaces this file. */
:root {
  --theme-bg: ${t.bg};
  --theme-surface: ${t.surface};
  --theme-text: ${t.text};
  --theme-muted: ${t.muted};
  --theme-accent: ${t.accent};
  --theme-accent-2: ${t.accent2};
  --theme-link: ${t.link};
  --theme-visited: ${t.visited};
  --theme-heading-font: ${t.heading};
  --theme-body-font: ${t.body};
}

body {
  background-color: var(--theme-bg);
  color: var(--theme-text);
  font-family: var(--theme-body-font);
  line-height: 1.6;
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--theme-heading-font);
  color: var(--theme-accent);
  line-height: 1.25;
}

h1 {
  border-bottom: 3px solid var(--theme-accent-2);
  padding-bottom: 0.25em;
}

a:link { color: var(--theme-link); }
a:visited { color: var(--theme-visited); }
a:hover, a:focus { color: var(--theme-accent-2); }

hr {
  border: 0;
  border-top: 2px solid var(--theme-accent-2);
}

blockquote {
  margin: 1em 0;
  padding: 0.5em 1em;
  border-left: 4px solid var(--theme-accent-2);
  background-color: var(--theme-surface);
}

table { border-collapse: collapse; }
th, td {
  border: 1px solid var(--theme-muted);
  padding: 0.4em 0.6em;
}
th {
  background-color: var(--theme-accent);
  color: var(--theme-bg);
}

button, input[type="submit"], input[type="button"], input[type="reset"] {
  background-color: var(--theme-accent);
  color: var(--theme-bg);
  border: 0;
  border-radius: 4px;
  padding: 0.5em 1em;
  font: inherit;
  cursor: pointer;
}

nav a, .shared-border a {
  font-weight: bold;
  text-decoration: none;
}

.shared-border {
  background-color: var(--theme-surface);
  padding: 0.5em 1em;
}
`;
}

const THEME_PATH = 'css/theme.css';

async function themeDialog(app: App): Promise<void> {
  const linked = pageSheets(app).some((s) => s.path === THEME_PATH);
  const cur = /Theme: (\w+)/.exec(app.site.read(THEME_PATH) || '')?.[1];
  const sample = (t: Theme) => `<div style="background:${t.bg};color:${t.text};font-family:${t.body.replace(/"/g, "'")};padding:10px;border:1px solid ${t.muted}"><div style="font-family:${t.heading.replace(/"/g, "'")};color:${t.accent};font-size:1.4em;border-bottom:3px solid ${t.accent2}">${t.name} heading</div><p style="margin:.5em 0">Body text with <span style="color:${t.link};text-decoration:underline">a link</span>.</p><span style="background:${t.accent};color:${t.bg};padding:3px 10px;border-radius:4px">Button</span> <span style="background:${t.surface};padding:3px 8px">Surface</span></div>`;
  const v = await openDialog({
    title: 'Theme', wide: true, preview: true,
    help: `A theme is a style sheet (${THEME_PATH}) of colors and fonts linked into your pages. Your pages' own styles still win over it.`,
    fields: [
      { key: 'theme', label: 'Themes', type: 'list', rows: 9, value: THEMES.find((t) => t.name === cur)?.id || THEMES[0].id, options: [...THEMES.map((t) => ({ value: t.id, label: t.name + (t.name === cur ? ' (current)' : '') })), { value: 'none', label: '(No theme)' }] },
      { key: 'scope', label: 'Apply to', type: 'radio', value: linked || !cur ? 'all' : 'current', options: [{ value: 'current', label: 'Current page' }, { value: 'all', label: 'All pages' }] },
    ],
    onChange: (vals, ctl) => { const t = THEMES.find((x) => x.id === vals.theme); ctl.setPreview(t ? sample(t) : '<p>Pages keep only their own styles.</p>'); },
  });
  if (!v?.theme) return;
  const pages = pickPages(app, v.scope);
  if (v.theme === 'none') {
    let n = 0;
    for (const p of pages) if (editFile(app, p, 'Remove Theme', (s) => removeStylesheet(s, relativeRef(p, THEME_PATH)))) n++;
    toast(n ? `Theme removed from ${n} page${n === 1 ? '' : 's'}.` : 'No page had the theme.');
    return;
  }
  const t = THEMES.find((x) => x.id === v.theme)!;
  app.active?.ui.flush();
  const open = app.docs.find((d) => d.path === THEME_PATH);
  if (open) app.commit(open, themeCss(t), 'Theme'); else app.site.write(THEME_PATH, themeCss(t));
  let n = 0;
  for (const p of pages) {
    // The theme goes first, so the page's own style sheets and <style> blocks override it.
    if (editFile(app, p, 'Apply Theme', (s) => {
      const ref = relativeRef(p, THEME_PATH);
      if (pageSheets(app, p, s).some((x) => x.path === THEME_PATH)) return s;
      const tag = `<link rel="stylesheet" href="${ref}">`;
      const first = /<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*>|<style\b/i.exec(s);
      if (first && first.index < (regions(s).headClose >= 0 ? regions(s).headClose : Infinity)) {
        const ind = /([ \t]*)$/.exec(s.slice(0, first.index))?.[1] || '';
        return s.slice(0, first.index) + tag + '\n' + ind + s.slice(first.index);
      }
      return addStylesheet(s, ref);
    })) n++;
  }
  if (app.active?.path && !pages.includes(app.active.path)) { app.active.ui.invalidate(); app.active.ui.layout(); }
  else if (app.active?.kind === 'page' && !n) { app.active.ui.invalidate(); app.active.ui.layout(); }
  toast(`Theme ${t.name} applied${n ? ` to ${n} page${n === 1 ? '' : 's'}` : ''}.`);
}

// ------------------------------------------------------------------------------------------
// Shared borders (FrontPage): site-wide header/sidebars/footer kept as library items

const BORDERS = ['top', 'left', 'right', 'bottom'] as const;
type Border = typeof BORDERS[number];
const borderPath = (b: Border) => `Library/border-${b}.lbi`;
const borderRe = (b: Border) => new RegExp(`[ \\t]*<!--\\s*#BeginLibraryItem\\s+"/?${borderPath(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*-->[\\s\\S]*?<!--\\s*#EndLibraryItem\\s*-->[ \\t]*\\r?\\n?`, 'gi');

function borderContent(app: App, b: Border): string {
  const site = app.site;
  const pages = site.pages().map((f) => f.path).filter((p) => !p.includes('/') && !/\.(lbi|dwt)$/i.test(p)).slice(0, 8);
  const home = site.homePage;
  const ordered = [home, ...pages.filter((p) => p !== home)].filter((p) => p && site.has(p));
  const title = (p: string) => (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(site.read(p) || '')?.[1] || p).trim().replace(/[<>]/g, '');
  const links = ordered.map((p) => `<a href="${relativeRef(borderPath(b), p)}">${p === home ? 'Home' : title(p)}</a>`);
  const name = site.name.replace(/[<>&]/g, '');
  switch (b) {
    case 'top': return `\n<header class="shared-border shared-border-top">\n  <p class="site-name"><strong>${name}</strong></p>\n  <nav>${links.join(' | ')}</nav>\n</header>\n`;
    case 'left': return `\n<aside class="shared-border shared-border-left" style="float: left; width: 12em; margin-right: 1.5em">\n  <nav>\n    ${links.join('<br>\n    ')}\n  </nav>\n</aside>\n`;
    case 'right': return `\n<aside class="shared-border shared-border-right" style="float: right; width: 12em; margin-left: 1.5em">\n  <p>Edit Library/border-right.lbi to change this border.</p>\n</aside>\n`;
    case 'bottom': return `\n<footer class="shared-border shared-border-bottom" style="clear: both">\n  <p>&copy; ${new Date().getFullYear()} ${name}. ${links.slice(0, 1).join('')}</p>\n</footer>\n`;
  }
}

async function sharedBordersDialog(app: App): Promise<void> {
  const src = fileText(app, app.active.path);
  const has = (b: Border) => new RegExp(borderRe(b).source, 'i').test(src);
  const v = await openDialog({
    title: 'Shared Borders',
    help: 'Shared borders are regions repeated on every page: a top banner, side bars and a footer. Each is a library item (Library/border-*.lbi) copied into the pages, so pages need no server includes. Edit a border file, then choose Update to copy it into every page again.',
    fields: [
      { key: 'action', label: 'Action', type: 'radio', value: 'apply', options: [{ value: 'apply', label: 'Set borders' }, { value: 'update', label: 'Update pages from the border files' }] },
      { key: 'scope', label: 'Apply to', type: 'radio', value: 'all', options: [{ value: 'current', label: 'Current page' }, { value: 'all', label: 'All pages' }], visibleIf: (x) => x.action === 'apply' },
      ...BORDERS.map((b) => ({ key: b, label: b[0].toUpperCase() + b.slice(1), type: 'checkbox' as const, value: has(b) || (b === 'top' || b === 'bottom') && !BORDERS.some(has), half: true, visibleIf: (x: any) => x.action === 'apply' })),
    ],
  });
  if (!v) return;
  app.active?.ui.flush();
  const allPages = app.site.pages().map((f) => f.path).filter((p) => !/\.(lbi|dwt)$/i.test(p));
  if (v.action === 'update') {
    let n = 0;
    for (const p of allPages) if (editFile(app, p, 'Update Shared Borders', (s) => (BORDERS.some((b) => new RegExp(borderRe(b).source, 'i').test(s)) ? updateLibraryItems(app.site, p, s) : s))) n++;
    toast(n ? `Updated ${n} page${n === 1 ? '' : 's'}.` : 'All pages are up to date.');
    return;
  }
  for (const b of BORDERS) if (v[b] && !app.site.has(borderPath(b))) app.site.write(borderPath(b), borderContent(app, b));
  let n = 0;
  for (const p of pickPages(app, v.scope)) {
    const ok = editFile(app, p, 'Shared Borders', (s) => {
      let out = s;
      for (const b of BORDERS) if (!v[b]) out = out.replace(borderRe(b), '');
      const r = regions(out);
      if (!r.bodyOpen) return out;
      const lead = (['top', 'left', 'right'] as Border[]).filter((b) => v[b] && !new RegExp(borderRe(b).source, 'i').test(out)).map((b) => libraryItemMarkup(borderPath(b), '')).join('\n');
      if (lead) out = out.slice(0, r.bodyOpen[1]) + '\n' + lead + out.slice(r.bodyOpen[1]);
      if (v.bottom && !new RegExp(borderRe('bottom').source, 'i').test(out)) { const r2 = regions(out); const at = r2.bodyClose >= 0 ? r2.bodyClose : out.length; out = out.slice(0, at) + libraryItemMarkup(borderPath('bottom'), '') + '\n' + out.slice(at); }
      return updateLibraryItems(app.site, p, out);
    });
    if (ok) n++;
  }
  toast(n ? `Shared borders set on ${n} page${n === 1 ? '' : 's'}.` : 'No page changed.');
}

// ------------------------------------------------------------------------------------------
// Page transitions

async function pageTransitionDialog(app: App): Promise<void> {
  const src = fileText(app, app.active.path);
  const legacy = getMeta(src, 'Page-Enter', 'http-equiv') ?? getMeta(src, 'Page-Exit', 'http-equiv');
  const has = pageSheets(app).some((s) => /@view-transition/.test(s.css));
  const v = await openDialog({
    title: 'Page Transition',
    help: 'Old pages used Internet Explorer "Page-Enter" effects, which no current browser runs. Today the CSS View Transitions rule @view-transition { navigation: auto; } cross-fades between pages of the same site in browsers that support it; others simply show the next page.',
    fields: [
      { key: 'effect', label: 'Effect', type: 'select', value: has ? 'fade' : 'fade', options: [{ value: 'fade', label: 'Cross-fade' }, { value: 'slide', label: 'Slide in from the right' }, { value: 'none', label: 'No transition (remove)' }] },
      { key: 'duration', label: 'Duration (seconds)', type: 'number', value: 0.4, min: 0.1, max: 5, step: 0.1, visibleIf: (x) => x.effect !== 'none' },
      { key: 'scope', label: 'Apply to', type: 'radio', value: 'current', options: [{ value: 'current', label: 'Current page' }, { value: 'all', label: 'All pages' }] },
      ...(legacy != null ? [{ key: 'dropLegacy', label: `Remove the legacy transition meta tag (${legacy || 'Page-Enter'})`, type: 'checkbox' as const, value: true }] : []),
    ],
  });
  if (!v) return;
  const d = Math.max(0.1, Math.min(5, +v.duration || 0.4));
  const strip = (css: string) => {
    let out = css;
    const sheet = C.parseCss(out);
    const drop = sheet.nodes.filter((n) => n.type === 'at' && (n.name === 'view-transition' || (n.name === 'keyframes' && /^ql-vt-/.test(n.prelude)) || (n.name === 'media' && /prefers-reduced-motion/.test(n.prelude) && /::view-transition-group/.test(out.slice(n.start, n.end)))));
    for (const n of [...drop].reverse()) out = out.slice(0, n.start).replace(/[ \t]*$/, '') + out.slice(n.end).replace(/^[ \t]*\r?\n?/, '');
    for (const r of [...C.parseCss(out).rules].reverse()) if (!r.media.length && /::view-transition-(old|new)\(root\)/.test(r.selector)) out = C.removeRule(out, r);
    return out;
  };
  const add = (css: string) => {
    let out = strip(css);
    out = C.addRuleText(out, (i) => `${i}@view-transition {\n${i}  navigation: auto;\n${i}}`);
    if (v.effect === 'fade') out = C.addRule(out, '::view-transition-old(root), ::view-transition-new(root)', { 'animation-duration': `${d}s` });
    else {
      out = C.addRuleText(out, (i) => `${i}@keyframes ql-vt-slide-in {\n${i}  from { transform: translateX(100%); }\n${i}}`);
      out = C.addRule(out, '::view-transition-new(root)', { animation: `${d}s ease-out both ql-vt-slide-in` });
    }
    return C.addRule(out, '::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*)', { animation: 'none !important' }, '(prefers-reduced-motion: reduce)');
  };
  let n = 0;
  for (const p of pickPages(app, v.scope)) {
    const ok = editFile(app, p, 'Page Transition', (s) => {
      let out = s;
      if (v.dropLegacy) out = setMeta(setMeta(out, 'Page-Enter', null, 'http-equiv'), 'Page-Exit', null, 'http-equiv');
      if (v.effect === 'none') return /<style\b/i.test(out) ? editHeadStyle(out, strip) : out;
      return editHeadStyle(out, add);
    });
    if (ok) n++;
  }
  toast(v.effect === 'none' ? 'Page transition removed.' : `Page transition set${n > 1 ? ` on ${n} pages` : ''}. Preview it in a browser that supports view transitions.`);
}

// ------------------------------------------------------------------------------------------
// Removing formatting

const INLINE_TAGS = 'b|i|u|s|strike|strong|em|span|font|sub|sup|small|big|tt|mark|ins|del|code|kbd|samp|var|cite|dfn|abbr|acronym|q|nobr';

function removeFormatting(app: App): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' || !v.design?.doc) {
    const s = selectionText(app);
    if (!s) { toast('Select the source to clean up.'); return; }
    v.code?.replaceSelection(s.replace(new RegExp(`<\\/?(?:${INLINE_TAGS})\\b[^>]*>`, 'gi'), ''), true);
    v.flush();
    return;
  }
  const d = v.design;
  const r = d.restoreRange();
  if (!r || r.collapsed) {
    const el = selectedEl(app);
    if (!el || el === d.doc!.body) { toast('Select the text to remove formatting from.'); return; }
    mutate(app, () => { for (const e of [...el.querySelectorAll(INLINE_TAGS.split('|').join(','))].reverse()) unwrap(e); if (new RegExp(`^(${INLINE_TAGS})$`, 'i').test(el.tagName)) unwrap(el); else { el.removeAttribute('style'); el.removeAttribute('data-ql-o-style'); } });
    return;
  }
  mutate(app, (doc) => {
    try { doc.execCommand('removeFormat'); } catch { /* */ }
    const root = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer as Element : r.commonAncestorContainer.parentElement!;
    for (const e of [...root.querySelectorAll('span,font')]) if (r.intersectsNode(e) && (!e.attributes.length || e.tagName === 'FONT' || (e.attributes.length === 1 && e.hasAttribute('style')))) unwrap(e);
  });
}

function removeTextStyles(app: App): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' || !v.design?.doc) {
    const s = selectionText(app);
    if (!s) return;
    v.code?.replaceSelection(s.replace(/\s(?:style|class)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ''), true);
    v.flush();
    return;
  }
  const r = v.design.restoreRange();
  const el = selectedEl(app);
  if (!el) return;
  mutate(app, () => {
    const targets = r && !r.collapsed ? [...(r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer as Element : r.commonAncestorContainer.parentElement!).querySelectorAll('[style],[class]')].filter((e) => r.intersectsNode(e)) : [el, ...el.querySelectorAll('[style],[class]')];
    for (const e of targets) { if (e.tagName === 'BODY') continue; e.removeAttribute('style'); e.removeAttribute('data-ql-o-style'); e.removeAttribute('class'); }
    for (const s of [...(el.tagName === 'SPAN' ? [el] : []), ...el.querySelectorAll('span')]) if (!s.attributes.length) unwrap(s);
  });
}

function removeLink(app: App): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' || !v.design?.doc) {
    const s = selectionText(app);
    if (!s) return;
    v.code?.replaceSelection(s.replace(/<a\b[^>]*\bhref[^>]*>|<\/a>/gi, ''), true);
    v.flush();
    return;
  }
  const a = closestSel(app, 'a[href]');
  if (a) { mutate(app, () => unwrap(a)); return; }
  v.design.exec('unlink');
  v.flush();
}

function removeAnchors(app: App): void {
  const v = view(app);
  if (!v) return;
  if (v.target === 'code' || !v.design?.doc) {
    const s = selectionText(app);
    const re = /<a\b(?![^>]*\bhref)[^>]*\b(?:name|id)\s*=[^>]*>([\s\S]*?)<\/a>/gi;
    if (s) { v.code?.replaceSelection(s.replace(re, '$1'), true); v.flush(); }
    else app.editSource('Remove Bookmarks', (src) => src.replace(re, '$1'));
    return;
  }
  const r = v.design.restoreRange();
  const doc = v.design.doc;
  const all = [...doc.body.querySelectorAll('a[name]:not([href]), a[id]:not([href])')].filter((a) => !r || r.collapsed || r.intersectsNode(a));
  if (!all.length) { toast('There are no bookmarks here.'); return; }
  mutate(app, () => all.forEach((a) => unwrap(a)));
  toast(`Removed ${all.length} bookmark${all.length === 1 ? '' : 's'}.`);
}

// ------------------------------------------------------------------------------------------
// Commands

const CSS_MODES: [string, string, string][] = [['auto', 'Auto', 'Inline styles, and the page\'s own rules where they exist'], ['inline', 'Inline Styles', 'style="…" on the element'], ['class', 'Classes', 'Generated classes (style1, style2…) in the page\'s style block'], ['tags', 'Tags', 'Tags and attributes where HTML has them (align, <b>, <i>)']];

const commands: Command[] = [
  ...RICH.map((r): Command => ({
    id: r.id, label: r.label, icon: r.icon, tab: 'Home', group: 'Font', keys: r.keys, kind: 'toggle', edits: true, origin: r.origin, popular: ['format.bold', 'format.italic', 'format.underline'].includes(r.id),
    isEnabled: textOk, isActive: stateOf(r.cmd),
    run: (app) => { const t = r.tag(app); richCommand(app, r.cmd, undefined, [`<${t}>`, `</${t}>`]); },
  })),
  ...PHRASE.map((p): Command => ({
    id: p.id, label: p.label, icon: p.icon, tab: 'Home', group: 'Text Style', edits: true, origin: p.origin, keywords: `${p.keywords || ''} phrase element`,
    isEnabled: textOk, isActive: (app) => inDesign(app) && p.tag(app) !== 'span' && !!closestSel(app, p.tag(app)),
    run: async (app) => {
      const tag = p.tag(app);
      if (inDesign(app) && tag !== 'span' && closestSel(app, tag)) { toggleInline(app, tag); return; }
      const attrs = p.attrs ? await p.attrs(app) : {};
      if (attrs === null) return;
      toggleInline(app, tag, attrs);
    },
  })),
  {
    id: 'format.font', label: 'Font…', icon: 'text_format', tab: 'Home', group: 'Font', edits: true, origin: 'FrontPage, Expression Web', keywords: 'font family size weight style color letter spacing small caps',
    isEnabled: pageOk, run: (app) => fontDialog(app),
  },
  {
    id: 'format.fontFamily', label: 'Font', icon: 'font_download', tab: 'Home', group: 'Font', kind: 'font', edits: true, origin: 'Every editor', keywords: 'typeface font-family stack',
    isEnabled: textOk, menu: (app) => fontMenu(app), value: (app) => computedFont(app),
    run: async (app, arg) => {
      let f = arg;
      if (f === undefined) { f = await promptDialog('Font', 'Font family (a font stack)', inlineOf(selectedEl(app))['font-family'] || '', { type: 'combo', options: [...fontList(), ...FONT_STACKS.filter((s) => !fontList().includes(s))] }); if (f == null) return; }
      styleSelection(app, { 'font-family': String(f).trim() || null }, 'Font');
    },
  },
  {
    id: 'format.fontSize', label: 'Font Size', icon: 'format_size', tab: 'Home', group: 'Font', kind: 'size', edits: true, origin: 'Every editor', keywords: 'font-size px em rem',
    isEnabled: textOk, menu: () => sizeMenu(), value: (app) => computedSize(app),
    run: async (app, arg) => {
      let s = arg;
      if (s === undefined) { s = await promptDialog('Font Size', 'Size (px, em, rem, % or a keyword)', computedSize(app) || '16px', { type: 'combo', options: FONT_SIZES }); if (s == null) return; }
      let v = String(s).trim();
      if (/^\d+(\.\d+)?$/.test(v)) v += 'px';
      if (v && !/^(\d*\.?\d+(px|em|rem|%|pt|vw|vh|ex|ch)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|inherit|initial|unset|(calc|clamp|min|max)\(.*\))$/i.test(v)) { toast(`"${v}" is not a font size.`); return; }
      styleSelection(app, { 'font-size': v || null }, 'Font Size');
    },
  },
  { id: 'format.color', label: 'Font Color', icon: 'format_color_text', tab: 'Home', group: 'Font', kind: 'color', edits: true, origin: 'Every editor', keywords: 'text color foreground', isEnabled: textOk, run: (app, arg) => colorCommand(app, arg, 'color', 'format.color') },
  { id: 'format.highlight', label: 'Highlight', icon: 'format_ink_highlighter', tab: 'Home', group: 'Font', kind: 'color', edits: true, origin: 'Expression Web, Word', keywords: 'background color marker', isEnabled: textOk, run: (app, arg) => colorCommand(app, arg, 'background-color', 'format.highlight') },
  { id: 'format.removeFormatting', label: 'Clear Formatting', icon: 'format_clear', tab: 'Home', group: 'Font', keys: ['Ctrl+Space'], edits: true, origin: 'Expression Web, FrontPage', keywords: 'remove formatting plain', isEnabled: textOk, run: (app) => removeFormatting(app) },
  { id: 'format.removeTextStyles', label: 'Remove Styles and Classes', icon: 'format_color_reset', tab: 'Home', group: 'Font', edits: true, origin: 'Dreamweaver (CSS Styles: None)', keywords: 'remove style class attribute', isEnabled: textOk, run: (app) => removeTextStyles(app) },
  { id: 'format.removeLink', label: 'Remove Hyperlink', icon: 'link_off', tab: 'Insert', group: 'Hyperlink Tools', edits: true, origin: 'Dreamweaver, KompoZer', keywords: 'unlink', isEnabled: textOk, run: (app) => removeLink(app) },
  { id: 'format.removeAnchors', label: 'Remove Bookmarks', icon: 'bookmark_remove', tab: 'Insert', group: 'Hyperlink Tools', edits: true, origin: 'KompoZer (Remove Named Anchors)', keywords: 'named anchors a name', isEnabled: textOk, run: (app) => removeAnchors(app) },
  {
    id: 'format.paragraph', label: 'Paragraph…', icon: 'format_paragraph', tab: 'Home', group: 'Paragraph', edits: true, origin: 'FrontPage, Expression Web', keywords: 'alignment indent spacing line height',
    isEnabled: pageOk, run: (app) => paragraphDialog(app),
  },
  {
    id: 'format.blockStyle', label: 'Paragraph Format', icon: 'title', tab: 'Home', group: 'Paragraph', kind: 'combo', edits: true, origin: 'Every editor (Style box)', keywords: 'heading paragraph block format',
    isEnabled: textOk, value: (app) => currentBlock(app),
    menu: (app) => [{ id: 'format.blockStyle', arg: 'none', label: 'None' }, ...BLOCK_STYLES.map(([t, l]) => ({ id: 'format.blockStyle', arg: t, label: l, preview: BLOCK_PREVIEW[t] || '', checked: currentBlock(app) === l }))],
    run: async (app, arg) => {
      let t = arg;
      if (t === undefined) { const v = await openDialog({ title: 'Paragraph Format', fields: [{ key: 't', label: 'Format', type: 'list', rows: 12, value: 'p', options: [{ value: 'none', label: 'None' }, ...BLOCK_STYLES.map(([value, label]) => ({ value, label }))] }] }); if (!v?.t) return; t = v.t; }
      setBlock(app, String(t));
    },
  },
  ...([['blockNone', 'None', 'format_clear', 'none'], ['blockP', 'Paragraph', 'notes', 'p'], ['blockH1', 'Heading 1', 'format_h1', 'h1'], ['blockH2', 'Heading 2', 'format_h2', 'h2'], ['blockH3', 'Heading 3', 'format_h3', 'h3'], ['blockH4', 'Heading 4', 'format_h4', 'h4'], ['blockH5', 'Heading 5', 'format_h5', 'h5'], ['blockH6', 'Heading 6', 'format_h6', 'h6'], ['blockPre', 'Preformatted', 'code_blocks', 'pre'], ['blockAddress', 'Address', 'contact_mail', 'address'], ['blockQuote', 'Blockquote', 'format_quote', 'blockquote']] as const).map(([id, label, ic, tag]): Command => ({
    id: `format.${id}`, label, icon: ic, tab: 'Home', group: 'Paragraph Format', edits: true, origin: 'Dreamweaver (Format ▸ Paragraph Format)', keys: /^h[1-6]$/.test(tag) ? [`Ctrl+${tag[1]}`] : undefined,
    keywords: `block ${tag}`, isEnabled: textOk, isActive: (app) => currentBlock(app) === (tag === 'none' ? 'None' : BLOCK_STYLES.find(([t]) => t === tag)?.[1]), run: (app) => setBlock(app, tag),
  })),
  { id: 'format.alignLeft', label: 'Align Left', icon: 'format_align_left', tab: 'Home', group: 'Paragraph', kind: 'toggle', keys: ['Ctrl+L'], edits: true, origin: 'Every editor', isEnabled: textOk, isActive: alignActive('left'), run: (app) => align(app, 'left') },
  { id: 'format.alignCenter', label: 'Center', icon: 'format_align_center', tab: 'Home', group: 'Paragraph', kind: 'toggle', keys: ['Ctrl+E'], edits: true, origin: 'Every editor', isEnabled: textOk, isActive: alignActive('center'), run: (app) => align(app, 'center') },
  { id: 'format.alignRight', label: 'Align Right', icon: 'format_align_right', tab: 'Home', group: 'Paragraph', kind: 'toggle', keys: ['Ctrl+R'], edits: true, origin: 'Every editor', isEnabled: textOk, isActive: alignActive('right'), run: (app) => align(app, 'right') },
  { id: 'format.justify', label: 'Justify', icon: 'format_align_justify', tab: 'Home', group: 'Paragraph', kind: 'toggle', keys: ['Ctrl+J'], edits: true, origin: 'Every editor', isEnabled: textOk, isActive: alignActive('justify'), run: (app) => align(app, 'justify') },
  { id: 'format.indent', label: 'Increase Indent', icon: 'format_indent_increase', tab: 'Home', group: 'Paragraph', keys: ['Ctrl+M'], edits: true, origin: 'Every editor', isEnabled: textOk, run: (app) => indent(app, 1) },
  { id: 'format.outdent', label: 'Decrease Indent', icon: 'format_indent_decrease', tab: 'Home', group: 'Paragraph', keys: ['Ctrl+Shift+M'], edits: true, origin: 'Every editor', isEnabled: textOk, run: (app) => indent(app, -1) },
  { id: 'format.bullets', label: 'Bullets', icon: 'format_list_bulleted', tab: 'Home', group: 'Paragraph', kind: 'toggle', edits: true, origin: 'Every editor', keywords: 'unordered list ul', isEnabled: textOk, isActive: stateOf('insertUnorderedList'), run: (app) => makeList(app, false) },
  { id: 'format.numbering', label: 'Numbering', icon: 'format_list_numbered', tab: 'Home', group: 'Paragraph', kind: 'toggle', edits: true, origin: 'Every editor', keywords: 'ordered list ol', isEnabled: textOk, isActive: stateOf('insertOrderedList'), run: (app) => makeList(app, true) },
  { id: 'format.listNone', label: 'Remove List', icon: 'playlist_remove', tab: 'Home', group: 'Lists', edits: true, origin: 'KompoZer, Dreamweaver (List ▸ None)', isEnabled: textOk, run: (app) => listNone(app) },
  { id: 'format.definitionList', label: 'Definition List', icon: 'list_alt', tab: 'Home', group: 'Lists', edits: true, origin: 'FrontPage, Dreamweaver', keywords: 'dl dt dd glossary', isEnabled: textOk, run: (app) => definitionList(app) },
  { id: 'format.listProperties', label: 'List Properties…', icon: 'checklist', tab: 'Home', group: 'Lists', edits: true, origin: 'Dreamweaver, FrontPage', keywords: 'list-style start reversed picture bullets', isEnabled: pageOk, run: (app) => listDialog(app) },
  { id: 'format.bulletsNumbering', label: 'Bullets and Numbering…', icon: 'format_list_numbered_rtl', tab: 'Home', group: 'Lists', edits: true, origin: 'FrontPage, Expression Web', keywords: 'list style picture bullets', isEnabled: pageOk, run: (app) => listDialog(app) },
  { id: 'format.bordersShading', label: 'Borders and Shading…', icon: 'border_style', tab: 'Home', group: 'Paragraph', edits: true, origin: 'FrontPage, Expression Web', keywords: 'border padding background shading', isEnabled: pageOk, run: (app) => bordersDialog(app) },
  { id: 'format.boxModel', label: 'Box…', icon: 'check_box_outline_blank', tab: 'Layout', group: 'Box', edits: true, origin: 'CSS box model (Expression Web, Dreamweaver)', keywords: 'margin padding width height box-sizing display overflow', isEnabled: pageOk, run: (app) => propDialog(app, 'Box', BOX_SPECS) },
  {
    id: 'format.flexbox', label: 'Flexbox…', icon: 'view_column', tab: 'Layout', group: 'Box', edits: true, origin: 'Modern CSS (Dreamweaver Flexbox)', keywords: 'flex container row column justify align gap',
    isEnabled: pageOk,
    run: (app) => propDialog(app, 'Flexbox', FLEX_SPECS, {
      defaults: { display: 'flex' }, help: 'These settings make the selected element a flex container; its child elements are laid out in a row or a column.',
      extra: [{ key: 'kidsFlex', label: 'Make the child elements share the space equally (flex: 1)', type: 'checkbox', value: false }],
      preview: (v) => boxPreview(Object.fromEntries(FLEX_SPECS.map((s) => [s.prop, v[s.prop]]).concat([['kidsFlex', v.kidsFlex]]))),
      onApply: (el, v) => { if (v.kidsFlex) mutate(app, () => { for (const k of el.children) if (!k.hasAttribute('data-ql-ui')) setInline(app, k as HTMLElement, 'flex', '1 1 0'); }); },
    }),
  },
  {
    id: 'format.cssGrid', label: 'CSS Grid…', icon: 'grid_view', tab: 'Layout', group: 'Box', edits: true, origin: 'Modern CSS (Dreamweaver CSS Grid)', keywords: 'grid template columns rows gap areas',
    isEnabled: pageOk,
    run: (app) => propDialog(app, 'CSS Grid', GRID_SPECS, {
      defaults: { display: 'grid' }, help: 'These settings make the selected element a grid container; its child elements fill the grid cells in order.',
      preview: (v) => boxPreview(Object.fromEntries(GRID_SPECS.filter((s) => s.prop !== 'grid-template-areas').map((s) => [s.prop, v[s.prop]])), 6),
    }),
  },
  { id: 'format.position', label: 'Position…', icon: 'open_with', tab: 'Layout', group: 'Position', edits: true, origin: 'FrontPage, Expression Web', keywords: 'absolute relative fixed sticky float z-index wrapping', isEnabled: pageOk, run: (app) => propDialog(app, 'Position', POSITION_SPECS) },
  { id: 'format.positionAbsolute', label: 'Absolute', icon: 'picture_in_picture_alt', tab: 'Layout', group: 'Position', kind: 'toggle', edits: true, origin: 'FrontPage, Expression Web (Position Absolutely)', keywords: 'layer absolute position', isEnabled: pageOk, isActive: (app) => inDesign(app) && inlineOf(selectedEl(app)).position === 'absolute', run: (app) => togglePosition(app, 'absolute') },
  { id: 'format.positionRelative', label: 'Relative', icon: 'move_down', tab: 'Layout', group: 'Position', kind: 'toggle', edits: true, origin: 'Expression Web', keywords: 'relative position', isEnabled: pageOk, isActive: (app) => inDesign(app) && inlineOf(selectedEl(app)).position === 'relative', run: (app) => togglePosition(app, 'relative') },
  { id: 'format.bringToFront', label: 'Bring to Front', icon: 'flip_to_front', tab: 'Layout', group: 'Position', edits: true, origin: 'FrontPage, Expression Web', keywords: 'z-index layer order', isEnabled: pageOk, run: (app) => zOrder(app, 'front') },
  { id: 'format.sendToBack', label: 'Send to Back', icon: 'flip_to_back', tab: 'Layout', group: 'Position', edits: true, origin: 'FrontPage, Expression Web', keywords: 'z-index layer order', isEnabled: pageOk, run: (app) => zOrder(app, 'back') },
  { id: 'format.bringForward', label: 'Bring Forward', icon: 'arrow_upward', tab: 'Layout', group: 'Position', edits: true, origin: 'FrontPage, Expression Web', keywords: 'z-index layer order', isEnabled: pageOk, run: (app) => zOrder(app, 'forward') },
  { id: 'format.sendBackward', label: 'Send Backward', icon: 'arrow_downward', tab: 'Layout', group: 'Position', edits: true, origin: 'FrontPage, Expression Web', keywords: 'z-index layer order', isEnabled: pageOk, run: (app) => zOrder(app, 'backward') },
  { id: 'format.alignLeftEdges', label: 'Align Left Edges', icon: 'align_horizontal_left', tab: 'Layout', group: 'Align Layers', edits: true, origin: 'Dreamweaver (Arrange ▸ Align Left)', keywords: 'layers ap elements', isEnabled: pageOk, run: (app) => alignLayers(app, 'left') },
  { id: 'format.alignTops', label: 'Align Tops', icon: 'align_vertical_top', tab: 'Layout', group: 'Align Layers', edits: true, origin: 'Dreamweaver (Arrange ▸ Align Top)', keywords: 'layers ap elements', isEnabled: pageOk, run: (app) => alignLayers(app, 'top') },
  { id: 'format.alignRightEdges', label: 'Align Right Edges', icon: 'align_horizontal_right', tab: 'Layout', group: 'Align Layers', edits: true, origin: 'Dreamweaver (Arrange ▸ Align Right)', keywords: 'layers ap elements', isEnabled: pageOk, run: (app) => alignLayers(app, 'right') },
  { id: 'format.alignBottoms', label: 'Align Bottoms', icon: 'align_vertical_bottom', tab: 'Layout', group: 'Align Layers', edits: true, origin: 'Dreamweaver (Arrange ▸ Align Bottom)', keywords: 'layers ap elements', isEnabled: pageOk, run: (app) => alignLayers(app, 'bottom') },
  { id: 'format.sameWidth', label: 'Make Same Width', icon: 'width', tab: 'Layout', group: 'Align Layers', edits: true, origin: 'Dreamweaver (Arrange ▸ Make Same Width)', keywords: 'layers size', isEnabled: pageOk, run: (app) => alignLayers(app, 'width') },
  { id: 'format.sameHeight', label: 'Make Same Height', icon: 'height', tab: 'Layout', group: 'Align Layers', edits: true, origin: 'Dreamweaver (Arrange ▸ Make Same Height)', keywords: 'layers size', isEnabled: pageOk, run: (app) => alignLayers(app, 'height') },
  {
    id: 'format.preventOverlaps', label: 'Prevent Layer Overlaps', icon: 'layers_clear', tab: 'Layout', group: 'Align Layers', kind: 'toggle', noRecord: true, origin: 'Dreamweaver (Prevent AP Element Overlaps)', keywords: 'layers overlap',
    isActive: () => localFlag('ql.preventOverlaps'),
    run: () => { const on = !localFlag('ql.preventOverlaps'); localFlag('ql.preventOverlaps', on); toast(on ? 'Layers should not overlap: new and moved layers are kept apart.' : 'Layers may overlap.'); },
  },
  {
    id: 'format.layerProperties', label: 'Layer Properties…', icon: 'layers', tab: 'Layout', group: 'Position', edits: true, origin: 'Dreamweaver (AP Element properties), FrontPage', keywords: 'ap div layer visibility z-index',
    isEnabled: pageOk,
    run: (app) => {
      const el = posEl(app);
      if (!el) return;
      app.active.ui.design?.select(el);
      return propDialog(app, 'Layer', LAYER_SPECS, { extra: [{ key: 'layerId', label: 'Layer ID', type: 'text', value: el.id }], onApply: (e, v) => { const id = String(v.layerId || '').trim().replace(/\s+/g, '-'); if (id !== e.id) mutate(app, () => { if (id) e.id = id; else e.removeAttribute('id'); }); } });
    },
  },
  { id: 'format.background', label: 'Background…', icon: 'format_color_fill', tab: 'Design', group: 'Page', edits: true, origin: 'FrontPage, Expression Web', keywords: 'page background color picture bgcolor', isEnabled: pageOk, run: (app) => backgroundDialog(app) },
  { id: 'format.pageColors', label: 'Page Colors…', icon: 'palette', tab: 'Design', group: 'Page', edits: true, origin: 'FrontPage (Page Properties ▸ Formatting), KompoZer', keywords: 'text link visited hover active colors', isEnabled: pageOk, run: (app) => pageColorsDialog(app) },
  {
    id: 'format.doctype', label: 'Document Type…', icon: 'description', tab: 'Design', group: 'Page', edits: true, origin: 'Expression Web, Dreamweaver', keywords: 'doctype dtd html5 xhtml',
    isEnabled: pageOk,
    run: async (app, arg) => {
      const cur = getDoctype(fileText(app, app.active.path));
      let id = arg;
      if (!id) {
        const v = await openDialog({ title: 'Document Type', fields: [{ key: 'id', label: 'DOCTYPE', type: 'list', rows: 10, value: cur, options: DOCTYPES.map((d) => ({ value: d.id, label: d.label })) }, ...(cur === 'custom' ? [{ key: 'note', type: 'info' as const, label: 'This page has a DOCTYPE Anne\'s Loom does not list; choosing one replaces it.' }] : [])] });
        if (!v?.id) return;
        id = v.id;
      }
      if (!DOCTYPES.some((d) => d.id === id)) { toast(`Unknown document type ${id}.`); return; }
      app.editSource('Document Type', (src) => setDoctype(src, id));
    },
  },
  {
    id: 'format.encoding', label: 'Encoding…', icon: 'translate', tab: 'Design', group: 'Page', edits: true, origin: 'Every editor (Page Properties ▸ Language)', keywords: 'charset utf-8 character set',
    isEnabled: pageOk,
    run: async (app, arg) => {
      const cur = getCharset(fileText(app, app.active.path)).toLowerCase() || 'utf-8';
      let cs2 = arg;
      if (!cs2) {
        const v = await openDialog({ title: 'Encoding', help: 'The character set the page declares. Anne\'s Loom keeps text as Unicode; when you publish, the file is written in UTF-8, so UTF-8 is the right choice unless a server requires another.', fields: [{ key: 'cs', label: 'Character set', type: 'list', rows: 12, value: CHARSETS.some(([c]) => c === cur) ? cur : 'utf-8', options: CHARSETS.map(([value, label]) => ({ value, label })) }] });
        if (!v?.cs) return;
        cs2 = v.cs;
      }
      app.editSource('Encoding', (src) => setCharset(src, String(cs2)));
      if (String(cs2).toLowerCase() !== 'utf-8') toast('Pages are saved as UTF-8; make sure your server sends the declared encoding, or keep UTF-8.', { ms: 6000 });
    },
  },
  {
    id: 'format.cssMode', label: 'Style Application', icon: 'style', tab: 'Design', group: 'CSS', kind: 'menu', noRecord: true, origin: 'Expression Web (Style Application: Auto/Manual)', keywords: 'css mode inline class tags',
    menu: (app) => CSS_MODES.map(([value, label]) => ({ id: 'format.cssMode', arg: value, label, checked: app.prefs.cssMode === value })),
    run: async (app, arg) => {
      if (arg === 'menu') { showMenu(CSS_MODES.map(([value, label]) => ({ id: 'format.cssMode', arg: value, label, checked: app.prefs.cssMode === value })), { ...at(pointer), title: 'Apply formatting as', onPick: (e) => app.exec('format.cssMode', e.arg) }); return; }
      let m = arg;
      if (m === undefined) { const v = await openDialog({ title: 'Style Application', fields: [{ key: 'm', label: 'Apply formatting as', type: 'radio', value: app.prefs.cssMode, options: CSS_MODES.map(([value, label, help]) => ({ value, label: `${label}: ${help}` })) }] }); if (!v?.m) return; m = v.m; }
      if (!CSS_MODES.some(([x]) => x === m)) return;
      app.prefs.cssMode = m;
      app.savePrefs();
      app.ui.refresh();
      toast(`Formatting is applied as: ${CSS_MODES.find(([x]) => x === m)![1]}.`);
    },
  },
  { id: 'format.theme', label: 'Theme…', icon: 'brush', tab: 'Design', group: 'Page', edits: true, origin: 'FrontPage (Themes)', keywords: 'colors fonts site look', isEnabled: pageOk, run: (app) => themeDialog(app) },
  { id: 'format.styles', label: 'Styles', icon: 'style', tab: 'Design', group: 'CSS', noRecord: true, origin: 'FrontPage (Format ▸ Style)', keywords: 'manage styles panel', run: (app) => { track(app); app.ui.togglePane('manageStyles'); } },
  { id: 'format.sharedBorders', label: 'Shared Borders…', icon: 'border_outer', tab: 'Design', group: 'Page', edits: true, origin: 'FrontPage', keywords: 'header footer sidebar every page library item', isEnabled: pageOk, run: (app) => sharedBordersDialog(app) },
  { id: 'format.pageTransition', label: 'Page Transition…', icon: 'animation', tab: 'Design', group: 'Page', edits: true, origin: 'FrontPage (Page Transition); now CSS View Transitions', keywords: 'view transition fade page-enter', isEnabled: pageOk, run: (app) => pageTransitionDialog(app) },
  { id: 'format.properties', label: 'Properties…', icon: 'tune', tab: 'Home', group: 'Editing', origin: 'FrontPage (Format ▸ Properties)', keywords: 'tag properties attributes', isEnabled: pageOk, run: (app) => app.exec('tag.properties') },
  {
    id: 'format.linkTarget', label: 'Link Target…', icon: 'open_in_new', tab: 'Insert', group: 'Hyperlink Tools', edits: true, origin: 'Dreamweaver (Modify ▸ Link Target)', keywords: 'target _blank new window frame',
    isEnabled: pageOk,
    run: async (app, arg) => {
      if (!needDesign(app)) return;
      const a = closestSel(app, 'a[href]');
      if (!a) { toast('Put the cursor in a hyperlink first.'); return; }
      let t = arg;
      if (t === undefined) {
        const frames = [...new Set([...fileText(app, app.active.path).matchAll(/<i?frame\b[^>]*\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]))];
        const v = await openDialog({ title: 'Link Target', fields: [{ key: 't', label: 'Open the link in', type: 'combo', value: a.getAttribute('target') || '', options: ['_blank', '_self', '_parent', '_top', ...frames], help: '_blank opens a new tab; _self the same window; a frame name opens it in that frame. Leave empty for the default.' }] });
        if (!v) return;
        t = v.t;
      }
      const target = String(t || '').trim();
      mutate(app, () => {
        if (target) a.setAttribute('target', target); else a.removeAttribute('target');
        if (target === '_blank') { const rel = new Set((a.getAttribute('rel') || '').split(/\s+/).filter(Boolean)); rel.add('noopener'); a.setAttribute('rel', [...rel].join(' ')); }
      });
    },
  },
  {
    id: 'format.editFontList', label: 'Edit Font List…', icon: 'list', tab: 'Design', group: 'Typography', noRecord: true, origin: 'Dreamweaver (Edit Font List)', keywords: 'font stacks families',
    run: async () => {
      const v = await openDialog({
        title: 'Edit Font List', help: 'One font stack per line, most wanted font first, ending with a generic family (serif, sans-serif, monospace).',
        fields: [{ key: 'list', label: 'Font stacks', type: 'textarea', rows: 14, value: fontList().join('\n') }, { key: 'reset', label: 'Restore the built-in list', type: 'checkbox', value: false }],
      });
      if (!v) return;
      if (v.reset) { saveFontList(null); toast('Font list restored.'); return; }
      saveFontList(String(v.list || '').split('\n').map((l) => l.trim().replace(/;$/, '')).filter(Boolean));
      toast('Font list saved.');
    },
  },
  { id: 'format.style', label: 'Style…', icon: 'style', tab: 'Home', group: 'Styles', edits: true, origin: 'Expression Web, FrontPage (Format ▸ Style)', keywords: 'inline style modify element', isEnabled: pageOk, run: (app) => elementStyleDialog(app) },
  { id: 'format.newStyleFromSelection', label: 'New Style from Selection…', icon: 'library_add', tab: 'Home', group: 'Styles', edits: true, origin: 'Dreamweaver', keywords: 'css rule from inline style', isEnabled: pageOk, run: (app) => newStyleFromSelection(app) },
];

def(commands);
