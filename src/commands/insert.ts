/**
 * Insert commands, part 1: text and layout objects, characters, links and bookmarks, head tags,
 * script objects, server-side code, raw HTML/files/snippets, and the ribbon's Insert menus.
 * Media lives in insertMedia.ts, web components and frameworks in insertComponents.ts; the helpers
 * exported here are shared by both.
 */
import { def, getCommand, type Command, type MenuEntry } from './registry';
import type { App } from '../app';
import { openDialog, toast, promptDialog, type Field } from '../ui/dialog';
import { h, pickFile } from '../ui/dom';
import { insertHtml, wrapTag, wrapSelection, selectionHtml, selectionText, view, isPage, isText, inDesign, closestSel, selectedEl, getAttr, setAttr, mutate, attrString } from '../editor/ops';
import { esc, escAttr, headInsert, setMeta, getMeta, getTitle, addScript, bodyInner } from '../model/html';
import { relativeRef, resolveRef, extOf, joinPath, slugify, stripExt, isTextPath, mimeOf, isPagePath, isImagePath } from '../model/paths';
import { rewriteRefs } from '../model/site';
import {
  type Component, ensureCss, idsIn, linkMarkup, emailLink, listMarkup, definitionList, entityFor, SYMBOL_BLOCKS, searchSymbols, EMOJI, SMILEYS, emojiMarkup,
  DATE_FORMATS, TIME_FORMATS, formatDate, formatTime, dateMarkup, php, ssi, SSI_VARS, asp, jsp, HANDLEBARS, LIQUID, openGraphTags, twitterTags, jsonLd, VIEWPORTS,
  setLinkRel, bodyEndInsert, headOnce, layerMarkup, iframeMarkup, fluidGrid, columnsBlock, flexRow, gridLayout, slugId, type SymbolInfo,
} from '../editor/components';
import { allSnippets } from '../ui/panesInsert';

// ------------------------------------------------------------------------------------------
// Shared helpers

/**
 * Inserts text exactly as written (server code, comments, scripts, style blocks) at the cursor. Design view
 * would re-parse markup such as <?php ?> into comments, so it inserts a marker node there and the text
 * replaces the marker in the source. `post` edits the page source in the same undo step.
 */
export function insertRaw(app: App, text: string, label = 'Insert', post?: (src: string) => string): void {
  const v = view(app);
  if (!v || app.isReadOnly()) return;
  if (v.target === 'code' || !v.design?.doc) {
    v.code?.replaceSelection(text);
    v.flush();
    if (post) app.editSource(label, post);
    return;
  }
  const d = v.design;
  const doc = d.doc!;
  const marker = `ql-insert-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  d.focus();
  const r = d.restoreRange();
  d.mutate(() => {
    const c = doc.createComment(marker);
    if (r && doc.body.contains(r.commonAncestorContainer)) { r.deleteContents(); r.insertNode(c); } else doc.body.appendChild(c);
  });
  v.flush();
  app.editSource(label, (src) => {
    const out = src.includes(`<!--${marker}-->`) ? src.replace(`<!--${marker}-->`, () => text) : bodyEndInsert(src, text);
    return post ? post(out) : out;
  });
}

/** Inserts a component: its markup at the cursor and its CSS once into the head. */
export function insertComponent(app: App, c: Component, label: string, extraHead?: (src: string) => string): void {
  insertRaw(app, c.html, label, (src) => {
    let s = c.css && c.key ? ensureCss(src, c.key, c.css) : src;
    if (extraHead) s = extraHead(s);
    return s;
  });
}

export const rel = (app: App, path: string) => relativeRef(app.active.path, path);

/** Site files (as links relative to the active page) that pass a filter. */
export function siteRefs(app: App, filter: (path: string) => boolean): string[] {
  return app.site.list((f) => filter(f.path) && f.path !== app.active?.path).map((f) => rel(app, f.path));
}

/** Copies a file from the device into the site folder `dir`; returns its site path. */
export async function uploadToSite(app: App, file: File, dir: string): Promise<string> {
  const ext = extOf(file.name);
  const base = slugify(stripExt(file.name));
  let path = joinPath(dir, `${base}${ext ? '.' + ext : ''}`);
  if (app.site.has(path)) path = app.site.freeName(dir, base, ext);
  const bytes = new Uint8Array(await file.arrayBuffer());
  app.site.write(path, isTextPath(path) ? new TextDecoder().decode(bytes) : bytes);
  return path;
}

/** A site-file chooser: a combo box of site files (or any URL) and a button that adds a file from the device. */
export function fileFields(app: App, key: string, label: string, o: { filter: (p: string) => boolean; accept: string; dir: string; value?: string; help?: string; placeholder?: string; blank?: boolean }): Field[] {
  const options = siteRefs(app, o.filter);
  return [
    { key, label, type: 'combo', value: o.value ?? (o.blank ? '' : options[0] ?? ''), options, placeholder: o.placeholder || 'Choose a site file or type an address', help: o.help },
    {
      key: key + '__upload', label: `${label.replace(/:$/, '')} from this device…`, type: 'button',
      onClick: async (_v, ctl) => {
        const [f] = await pickFile(o.accept);
        if (!f) return;
        const p = await uploadToSite(app, f, o.dir);
        ctl.set(key, rel(app, p));
        toast(`Added ${p} to the site.`);
      },
    },
  ];
}

/** Reads a picture's natural size (site file or web address). */
export function imageSize(app: App, ref: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!ref || typeof Image === 'undefined') return resolve(null);
    const p = resolveRef(app.active.path, ref);
    let url = '';
    let revoke = false;
    if (p) {
      const b = app.site.bytes(p);
      if (!b) return resolve(null);
      url = URL.createObjectURL(new Blob([b as BlobPart], { type: mimeOf(p) }));
      revoke = true;
    } else if (/^(https?:|data:)/i.test(ref)) url = ref;
    else return resolve(null);
    const img = new Image();
    const done = (r: { width: number; height: number } | null) => { if (revoke) URL.revokeObjectURL(url); resolve(r); };
    const t = setTimeout(() => done(null), 4000);
    img.onload = () => { clearTimeout(t); done(img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null); };
    img.onerror = () => { clearTimeout(t); done(null); };
    img.src = url;
  });
}

export const isImageRef = (p: string) => isImagePath(p);
export const IMAGE_ACCEPT = 'image/*,.svg,.avif,.webp';

/** Selected text split into non-empty lines (for lists and multi-item components). */
export function selectedLines(app: App): string[] {
  return selectionText(app).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(esc);
}

/** Wraps the selection in an element, or inserts the element with default content. */
export function wrapOrInsert(app: App, tag: string, attrs: Record<string, string | null | undefined> = {}, inner = ''): void {
  const sel = selectionHtml(app);
  insertHtml(app, `<${tag}${attrString(attrs)}>${sel || inner}</${tag}>`);
}

const pageExt = (app: App) => extOf(app.active?.path || '');
function warnServer(app: App, kind: 'php' | 'ssi' | 'asp' | 'jsp'): void {
  const e = pageExt(app);
  const ok = { php: ['php', 'phtml'], ssi: ['shtml', 'shtm', 'stm'], asp: ['asp', 'aspx'], jsp: ['jsp'] }[kind];
  if (!ok.includes(e)) toast(`This code runs only on a server that processes .${ok[0]} pages. This page is .${e || 'html'}.`, { ms: 5000 });
}

/** A menu that runs other Insert commands (labels and icons come from the commands). */
export function menuOf(items: (string | { heading: string } | { label: string; icon?: string; items: (string | { heading: string })[] })[]): MenuEntry[] {
  const one = (x: string | { heading: string }): MenuEntry | null => {
    if (typeof x !== 'string') return { heading: x.heading };
    if (x === '|') return { separator: true };
    const c = getCommand(x);
    return c ? { id: x, label: c.label, icon: c.icon } : null;
  };
  return items.map((x) => (typeof x === 'object' && 'items' in x ? { label: x.label, icon: x.icon, submenu: x.items.map(one).filter(Boolean) as MenuEntry[] } : one(x))).filter(Boolean) as MenuEntry[];
}

const T = 'Insert';
type Def = Omit<Command, 'tab'> & { tab?: string };
export function cmds(group: string, origin: string, list: Def[]): Command[] {
  return list.map((c) => ({ tab: T, group, origin, edits: true, isEnabled: isPage, ...c }));
}

/** A character: an entity in pages (when asked), the plain character in other files. */
export function insertChar(app: App, ch: string, asEntity = false): void {
  if (!isPage(app)) { const v = view(app); v?.code?.replaceSelection(ch); v?.flush(); return; }
  insertHtml(app, asEntity ? entityFor(ch) : esc(ch));
}

// ------------------------------------------------------------------------------------------
// Character pickers (symbols, emoji, smileys)

const RECENT_KEY = 'quillloom.recentSymbols';
function recentSymbols(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function rememberSymbol(ch: string): void { try { localStorage.setItem(RECENT_KEY, JSON.stringify([ch, ...recentSymbols().filter((x) => x !== ch)].slice(0, 24))); } catch { /* private mode */ } }

/** A searchable grid of characters. Resolves to the chosen character and how to write it, or null. */
export async function pickCharacter(title: string, blocks: { id: string; label: string; symbols: SymbolInfo[] }[], o: { entities?: boolean; search?: (q: string) => SymbolInfo[] } = {}): Promise<{ ch: string; name: string; entity: boolean } | null> {
  let chosen: SymbolInfo | null = null;
  let closeWith: ((v: any) => void) | null = null;
  const info = h('div', { class: 'ql-help', 'aria-live': 'polite' }, 'Pick a character.');
  const grid = h('div', { role: 'listbox', 'aria-label': title, style: 'display:flex;flex-wrap:wrap;gap:2px;max-height:280px;overflow:auto;padding:2px' });
  const search = h('input', { type: 'search', placeholder: 'Search by name, character or code (e.g. arrow, ©, U+2192)', 'aria-label': 'Search characters', style: 'width:100%' }) as HTMLInputElement;
  const blockSel = h('select', { 'aria-label': 'Character set' }, h('option', { value: '' }, 'All sets'), ...blocks.map((b) => h('option', { value: b.id }, b.label))) as HTMLSelectElement;
  const recent = recentSymbols();
  if (recent.length && o.entities !== false) blockSel.insertBefore(h('option', { value: '__recent' }, 'Recently used'), blockSel.options[1]);
  const all = blocks.flatMap((b) => b.symbols);
  const draw = () => {
    grid.textContent = '';
    const q = search.value.trim();
    let list: SymbolInfo[];
    if (q) list = o.search ? o.search(q) : all.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()) || s.ch === q);
    else if (blockSel.value === '__recent') list = recent.map((c) => all.find((s) => s.ch === c) || { ch: c, name: c });
    else list = blockSel.value ? blocks.find((b) => b.id === blockSel.value)!.symbols : all;
    for (const s of list.slice(0, 600)) {
      const shown = /^[\s­​-‍⁠]$/.test(s.ch) ? '·' : s.ch;
      const b = h('button', { type: 'button', class: 'ql-btn', role: 'option', title: `${s.name}${s.entity ? ` (&${s.entity};)` : ''} U+${s.ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`, 'aria-label': s.name, style: 'min-width:36px;height:36px;padding:0;font-size:20px' }, shown);
      b.addEventListener('click', () => { chosen = s; grid.querySelectorAll('[aria-selected]').forEach((x) => x.removeAttribute('aria-selected')); b.setAttribute('aria-selected', 'true'); info.textContent = `${s.ch.trim() ? s.ch : '(invisible)'} — ${s.name}${s.entity ? ` — &${s.entity};` : ''}`; });
      b.addEventListener('dblclick', () => { chosen = s; closeWith?.({}); });
      grid.appendChild(b);
    }
    if (!list.length) grid.appendChild(h('p', { class: 'ql-help' }, 'No characters match.'));
  };
  search.addEventListener('input', draw);
  blockSel.addEventListener('change', draw);
  draw();
  const content = h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, h('div', { style: 'display:flex;gap:6px' }, search, blockSel), grid, info);
  const fields: Field[] = o.entities === false ? [] : [{ key: 'as', label: 'Insert as', type: 'radio', value: 'char', options: [{ value: 'char', label: 'Character' }, { value: 'entity', label: 'HTML entity (named when one exists)' }] }];
  const r = await openDialog({ title, content, fields, wide: true, ok: 'Insert', onOpen: (ctl) => { closeWith = (v) => ctl.close({ ...ctl.values(), ...v }); setTimeout(() => search.focus(), 40); } });
  if (!r || !chosen) return null;
  const c = chosen as SymbolInfo;
  rememberSymbol(c.ch);
  return { ch: c.ch, name: c.name, entity: r.as === 'entity' || /^[ ­   ​-‍⁠]$/.test(c.ch) };
}

// ------------------------------------------------------------------------------------------
// Text objects

const block = (id: string, tag: string, label: string, icon: string, placeholder: string, extra: Partial<Def> = {}): Def => ({
  id, label, icon, run: (app) => wrapTag(app, tag, {}, placeholder), ...extra,
});
const inline = (id: string, tag: string, label: string, icon: string, tip: string, attrsFor?: (app: App, arg: any) => Promise<Record<string, string> | null> | Record<string, string>): Def => ({
  id, label, icon, tip,
  run: async (app, arg) => {
    const at = attrsFor ? await attrsFor(app, arg) : {};
    if (at === null) return;
    wrapTag(app, tag, at, label.toLowerCase());
  },
});
const nowIso = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

def(cmds('Text Objects', 'Expression Web, Dreamweaver', [
  block('insert.paragraph', 'p', 'Paragraph', 'format_paragraph', 'Paragraph text', { origin: 'Expression Web, Dreamweaver, KompoZer' }),
  ...[1, 2, 3, 4, 5, 6].map((n) => block(`insert.h${n}`, `h${n}`, `Heading ${n}`, n <= 3 ? `format_h${n}` : 'title', `Heading ${n}`)),
  { id: 'insert.blockquote', label: 'Block Quotation', icon: 'format_quote', run: (app) => { const s = selectionHtml(app); insertHtml(app, `<blockquote>${s ? (/<(p|div|ul|ol|h\d)\b/i.test(s) ? s : `<p>${s}</p>`) : '<p>Quotation</p>'}</blockquote>`); } },
  block('insert.pre', 'pre', 'Preformatted Text', 'wrap_text', 'Preformatted text'),
  block('insert.address', 'address', 'Address', 'contact_mail', 'Contact information'),
  {
    id: 'insert.ul', label: 'Bulleted List', icon: 'format_list_bulleted', origin: 'Expression Web, Dreamweaver, KompoZer',
    run: (app, arg) => insertHtml(app, listMarkup('ul', Array.isArray(arg) ? arg.map(esc) : selectedLines(app))),
  },
  {
    id: 'insert.ol', label: 'Numbered List', icon: 'format_list_numbered', origin: 'Expression Web, Dreamweaver, KompoZer',
    run: (app, arg) => insertHtml(app, listMarkup('ol', Array.isArray(arg) ? arg.map(esc) : selectedLines(app))),
  },
  {
    id: 'insert.dl', label: 'Definition List', icon: 'list_alt',
    run: (app) => {
      const l = selectedLines(app);
      const pairs: [string, string][] = [];
      for (let i = 0; i < l.length; i += 2) pairs.push([l[i], l[i + 1] || 'Definition']);
      insertHtml(app, definitionList(pairs));
    },
  },
  inline('insert.abbr', 'abbr', 'Abbreviation', 'short_text', 'Marks an abbreviation; the title gives the full form.', async (app, arg) => {
    const t = typeof arg === 'string' ? arg : await promptDialog('Abbreviation', 'Full form (shown as a tooltip):', '');
    return t == null ? null : { title: t };
  }),
  inline('insert.cite', 'cite', 'Citation', 'format_quote', 'The title of a cited work.'),
  inline('insert.code', 'code', 'Code', 'code', 'A fragment of computer code.'),
  inline('insert.dfn', 'dfn', 'Definition', 'menu_book', 'The defining instance of a term.'),
  inline('insert.kbd', 'kbd', 'Keyboard Input', 'keyboard', 'Text the user types.'),
  inline('insert.samp', 'samp', 'Sample Output', 'terminal', 'Sample output from a program.'),
  inline('insert.var', 'var', 'Variable', 'function', 'A variable in math or programming.'),
  inline('insert.q', 'q', 'Inline Quotation', 'format_quote', 'A short quotation (the browser adds quotation marks).'),
  inline('insert.mark', 'mark', 'Highlight', 'ink_highlighter', 'Highlighted (marked) text.'),
  inline('insert.small', 'small', 'Small Print', 'text_decrease', 'Side comments and small print.'),
  inline('insert.sub', 'sub', 'Subscript', 'subscript', 'Subscript text.'),
  inline('insert.sup', 'sup', 'Superscript', 'superscript', 'Superscript text.'),
  inline('insert.time', 'time', 'Time', 'schedule', 'A date or time with a machine-readable value.', async (app, arg) => {
    const t = typeof arg === 'string' ? arg : await promptDialog('Time', 'Machine-readable date/time (YYYY-MM-DD or YYYY-MM-DDThh:mm):', nowIso().slice(0, 10));
    return t == null ? null : { datetime: t };
  }),
  inline('insert.del', 'del', 'Deleted Text', 'strikethrough_s', 'Text removed from the document.', () => ({ datetime: nowIso() })),
  inline('insert.ins', 'ins', 'Inserted Text', 'format_underlined', 'Text added to the document.', () => ({ datetime: nowIso() })),
]));

// ------------------------------------------------------------------------------------------
// Layout objects

const section = (id: string, tag: string, label: string, icon: string, inner: string, extra: Partial<Def> = {}): Def => ({
  id, label, icon, run: (app, arg) => wrapOrInsert(app, tag, typeof arg === 'object' && arg ? arg : {}, inner), ...extra,
});

def(cmds('Layout Objects', 'Expression Web, Dreamweaver', [
  section('insert.div', 'div', 'Division (div)', 'check_box_outline_blank', '<p>Content</p>', { popular: true }),
  section('insert.section', 'section', 'Section', 'view_agenda', '<h2>Section heading</h2>\n<p>Content</p>'),
  section('insert.article', 'article', 'Article', 'article', '<h2>Article title</h2>\n<p>Content</p>'),
  section('insert.aside', 'aside', 'Aside', 'view_sidebar', '<h2>Related</h2>\n<p>Content</p>'),
  section('insert.header', 'header', 'Header', 'top_panel_open', '<p>Site name</p>'),
  section('insert.footer', 'footer', 'Footer', 'bottom_panel_open', '<p><small>&copy; Your name</small></p>'),
  section('insert.nav', 'nav', 'Navigation', 'menu', '<ul>\n  <li><a href="index.html">Home</a></li>\n</ul>', { run: (app) => wrapOrInsert(app, 'nav', { 'aria-label': 'Main' }, '<ul>\n  <li><a href="index.html">Home</a></li>\n</ul>') }),
  section('insert.main', 'main', 'Main Content', 'web_asset', '<h1>Page title</h1>\n<p>Content</p>', { run: (app) => wrapOrInsert(app, 'main', { id: 'main' }, '<h1>Page title</h1>\n<p>Content</p>') }),
  {
    id: 'insert.figure', label: 'Figure', icon: 'image_aspect_ratio',
    run: (app) => { const s = selectionHtml(app); insertHtml(app, `<figure>\n  ${s || '<img src="" alt="">'}\n  <figcaption>Caption</figcaption>\n</figure>`); },
  },
  { id: 'insert.details', label: 'Details (Disclosure)', icon: 'expand_circle_down', run: (app) => { const s = selectionHtml(app); insertHtml(app, `<details>\n  <summary>Summary</summary>\n  ${s || '<p>Details</p>'}\n</details>`); } },
  {
    id: 'insert.dialog', label: 'Dialog Box', icon: 'web_asset',
    run: (app) => {
      const id = slugId('dialog', new Set(idsIn(app.active.source)));
      insertHtml(app, `<dialog id="${id}" aria-labelledby="${id}-title">\n  <h2 id="${id}-title">Title</h2>\n  ${selectionHtml(app) || '<p>Message</p>'}\n  <form method="dialog"><button>Close</button></form>\n</dialog>`);
      toast('A dialog is hidden until a script opens it (dialog.showModal()). Insert > Components > Modal adds the button and script.', { ms: 5000 });
    },
  },
  { id: 'insert.span', label: 'Span', icon: 'text_select_move_forward_character', run: (app, arg) => wrapTag(app, 'span', typeof arg === 'object' && arg ? arg : {}, 'text') },
  {
    id: 'insert.layer', label: 'Layer (Positioned Box)', icon: 'layers', origin: 'Dreamweaver (AP Div), FrontPage (Layer), Expression Web',
    run: async (app, arg) => {
      const taken = new Set(idsIn(app.active.source));
      const v = arg || await openDialog({
        title: 'Insert Layer', help: 'An absolutely positioned box. Drag it in Design view or change its position on the Layout tab.',
        fields: [
          { key: 'id', label: 'Id', type: 'text', value: slugId('layer1', taken) },
          { key: 'left', label: 'Left', type: 'number', value: 40, suffix: 'px', half: true }, { key: 'top', label: 'Top', type: 'number', value: 40, suffix: 'px', half: true },
          { key: 'width', label: 'Width', type: 'number', value: 200, suffix: 'px', half: true }, { key: 'height', label: 'Height', type: 'number', value: 120, suffix: 'px', half: true },
          { key: 'z', label: 'Z-index', type: 'number', value: 1 },
        ],
      });
      if (!v) return;
      insertHtml(app, layerMarkup({ id: v.id || 'layer1', left: +v.left || 0, top: +v.top || 0, width: +v.width || 200, height: +v.height || 120, z: +v.z || 1, inner: selectionHtml(app) || undefined }));
    },
  },
  {
    id: 'insert.iframe', label: 'Inline Frame', icon: 'iframe', origin: 'FrontPage, Expression Web, Dreamweaver',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Insert Inline Frame',
        fields: [
          ...fileFields(app, 'src', 'Page to show', { filter: isPagePath, accept: '.html,.htm', dir: '', blank: false }),
          { key: 'title', label: 'Title (describes the frame for screen readers)', type: 'text', value: 'Embedded page' },
          { key: 'width', label: 'Width', type: 'text', value: '100%', half: true }, { key: 'height', label: 'Height', type: 'text', value: '400', half: true },
          { key: 'name', label: 'Frame name (target for links)', type: 'text', value: '' },
          { key: 'sandbox', label: 'Restrict the frame (sandbox: no scripts, forms or pop-ups)', type: 'checkbox', value: false },
          { key: 'lazy', label: 'Load when scrolled into view', type: 'checkbox', value: true },
        ],
        validate: (x) => (x.title?.trim() ? null : 'Give the frame a title.'),
      });
      if (!v) return;
      insertHtml(app, iframeMarkup({ src: v.src, title: v.title, width: v.width, height: v.height, name: v.name, lazy: v.lazy, sandbox: v.sandbox ? '' : null }).replace(' sandbox=""', ' sandbox'));
    },
  },
  {
    id: 'insert.fluidGrid', label: 'Fluid Grid Layout', icon: 'grid_view', origin: 'Dreamweaver (Fluid Grid Layout)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Fluid Grid Layout', help: 'A responsive grid: the number of columns changes with the screen width.',
        fields: [
          { key: 'mobile', label: 'Columns on phones', type: 'number', value: 1, min: 1, max: 12, half: true },
          { key: 'tablet', label: 'Columns on tablets (48em+)', type: 'number', value: 2, min: 1, max: 12, half: true },
          { key: 'desktop', label: 'Columns on desktops (64em+)', type: 'number', value: 4, min: 1, max: 12, half: true },
          { key: 'gap', label: 'Gutter', type: 'number', value: 20, suffix: 'px', half: true },
          { key: 'maxWidth', label: 'Maximum width', type: 'number', value: 1200, suffix: 'px' },
        ],
      });
      if (!v) return;
      insertComponent(app, fluidGrid({ mobile: +v.mobile || 1, tablet: +v.tablet || 2, desktop: +v.desktop || 4, gap: +v.gap, maxWidth: +v.maxWidth }), 'Insert Fluid Grid');
    },
  },
  {
    id: 'insert.columns', label: 'Text Columns', icon: 'view_column', origin: 'CSS multi-column layout',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Text Columns',
        fields: [
          { key: 'count', label: 'Number of columns', type: 'number', value: 2, min: 1, max: 8, half: true },
          { key: 'width', label: 'Minimum column width (optional)', type: 'text', value: '15em', half: true },
          { key: 'gap', label: 'Gap', type: 'text', value: '2em', half: true },
          { key: 'rule', label: 'Divider line', type: 'select', value: '', options: [{ value: '', label: 'None' }, { value: '1px solid #ccc', label: 'Thin gray line' }, { value: '1px dotted #999', label: 'Dotted line' }, { value: '2px solid currentColor', label: 'Text-colored line' }], half: true },
        ],
      });
      if (!v) return;
      insertHtml(app, columnsBlock({ count: +v.count || 2, width: v.width, gap: v.gap, rule: v.rule, inner: selectionHtml(app) || undefined }));
    },
  },
  {
    id: 'insert.flexRow', label: 'Flexible Row', icon: 'view_week', origin: 'Bootstrap Studio, modern builders',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Flexible Row (Flexbox)',
        fields: [
          { key: 'items', label: 'Items', type: 'number', value: 3, min: 1, max: 12, half: true },
          { key: 'gap', label: 'Gap', type: 'text', value: '1rem', half: true },
          { key: 'justify', label: 'Distribute', type: 'select', value: 'flex-start', options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'], half: true },
          { key: 'align', label: 'Align', type: 'select', value: 'stretch', options: ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'], half: true },
          { key: 'wrap', label: 'Wrap onto new lines on small screens', type: 'checkbox', value: true },
        ],
      });
      if (!v) return;
      insertHtml(app, flexRow({ items: +v.items || 3, gap: v.gap, justify: v.justify, align: v.align, wrap: v.wrap }));
    },
  },
  {
    id: 'insert.gridLayout', label: 'Grid Layout', icon: 'grid_on', origin: 'CSS grid layout, modern builders',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Grid Layout (CSS Grid)',
        fields: [
          { key: 'columns', label: 'Columns', type: 'number', value: 3, min: 1, max: 12, half: true },
          { key: 'rows', label: 'Rows', type: 'number', value: 2, min: 1, max: 20, half: true },
          { key: 'gap', label: 'Gap', type: 'text', value: '1rem', half: true },
          { key: 'responsive', label: 'Fit columns to the screen (minimum width)', type: 'text', value: '', placeholder: 'e.g. 14rem', half: true },
        ],
      });
      if (!v) return;
      insertHtml(app, gridLayout({ columns: +v.columns || 3, rows: +v.rows || 1, gap: v.gap, min: v.responsive || undefined }));
    },
  },
]));

// ------------------------------------------------------------------------------------------
// Characters, breaks, comments, dates

const ch = (id: string, label: string, c: string, icon = 'special_character', entity = false): Def => ({ id, label, icon, isEnabled: isText, run: (app) => insertChar(app, c, entity) });

def(cmds('Characters', 'FrontPage, Expression Web, Dreamweaver', [
  { id: 'insert.hr', label: 'Horizontal Line', icon: 'horizontal_rule', origin: 'FrontPage, Dreamweaver, KompoZer', popular: true, run: (app) => insertHtml(app, '<hr>') },
  { id: 'insert.br', label: 'Line Break', icon: 'keyboard_return', run: (app) => insertHtml(app, '<br>') },
  { id: 'insert.breakBelowImages', label: 'Break Below Pictures', icon: 'vertical_align_bottom', origin: 'KompoZer, FrontPage (Clear both margins)', tip: 'A line break that starts below floating pictures.', run: (app) => insertHtml(app, '<br style="clear:both">') },
  ch('insert.nbsp', 'Non-Breaking Space', ' ', 'space_bar', true),
  ch('insert.copyright', 'Copyright ©', '©', 'copyright'),
  ch('insert.registered', 'Registered ®', '®', 'registered'),
  ch('insert.trademark', 'Trademark ™', '™', 'trademark'),
  ch('insert.pound', 'Pound £', '£', 'currency_pound'),
  ch('insert.yen', 'Yen ¥', '¥', 'currency_yen'),
  ch('insert.euro', 'Euro €', '€', 'euro'),
  ch('insert.leftQuote', 'Left Quotation Mark “', '“', 'format_quote'),
  ch('insert.rightQuote', 'Right Quotation Mark ”', '”', 'format_quote'),
  ch('insert.emDash', 'Em Dash —', '—', 'remove'),
  ch('insert.enDash', 'En Dash –', '–', 'remove'),
  ch('insert.ellipsis', 'Ellipsis …', '…', 'more_horiz'),
  ch('insert.softHyphen', 'Optional Hyphen', '­', 'text_rotation_none', true),
  {
    id: 'insert.symbol', label: 'Symbol', icon: 'special_character', isEnabled: isText, popular: true, origin: 'FrontPage, Expression Web, Dreamweaver (Other Characters)',
    run: async (app, arg) => {
      if (typeof arg === 'string') { insertChar(app, arg); return; }
      const r = await pickCharacter('Symbol', SYMBOL_BLOCKS, { search: searchSymbols });
      if (r) insertChar(app, r.ch, r.entity && isPage(app));
    },
  },
  {
    id: 'insert.emoji', label: 'Emoji', icon: 'mood', isEnabled: isText, origin: 'Modern editors',
    run: async (app, arg) => {
      const r = typeof arg === 'string' ? { ch: arg, name: EMOJI.find((e) => e[0] === arg)?.[1] || 'emoji' } : await pickCharacter('Emoji', [{ id: 'emoji', label: 'Emoji', symbols: EMOJI.map(([c, n]) => ({ ch: c, name: n })) }], { entities: false });
      if (!r) return;
      if (isPage(app)) insertHtml(app, emojiMarkup(r.ch, r.name)); else insertChar(app, r.ch);
    },
  },
  {
    id: 'insert.smiley', label: 'Smiley', icon: 'sentiment_satisfied', origin: 'KompoZer, Netscape Composer (Insert Smiley)',
    run: async (app, arg) => {
      const r = typeof arg === 'string' ? SMILEYS.find((s) => s.code === arg || s.ch === arg) : await pickCharacter('Smiley', [{ id: 's', label: 'Smileys', symbols: SMILEYS.map((s) => ({ ch: s.ch, name: `${s.name} ${s.code}` })) }], { entities: false }).then((x) => x && SMILEYS.find((s) => s.ch === x.ch));
      if (r) insertHtml(app, emojiMarkup(r.ch, r.name));
    },
  },
  {
    id: 'insert.comment', label: 'Comment', icon: 'comment', isEnabled: isText, origin: 'FrontPage, Expression Web, Dreamweaver',
    run: async (app, arg) => {
      const t = typeof arg === 'string' ? arg : await openDialog({ title: 'Comment', help: 'Comments are kept in the source and are not shown in browsers (but anyone can read them in the source).', fields: [{ key: 't', label: 'Comment', type: 'textarea', value: selectionText(app), rows: 4, autofocus: true }] }).then((r) => r?.t ?? null);
      if (t == null) return;
      const e = pageExt(app);
      if (isPage(app)) insertRaw(app, `<!-- ${t.replace(/--/g, '- -').replace(/-$/, '- ')} -->`, 'Insert Comment');
      else if (['css', 'js', 'mjs', 'scss', 'less', 'ts', 'json'].includes(e)) insertRaw(app, `/* ${t.replace(/\*\//g, '* /')} */`, 'Insert Comment');
      else insertRaw(app, `# ${t}`, 'Insert Comment');
    },
  },
  ...(['insert.date', 'insert.dateTime'] as const).map((id): Def => ({
    id, label: id === 'insert.date' ? 'Date' : 'Date and Time', icon: id === 'insert.date' ? 'today' : 'schedule', isEnabled: isText, origin: 'FrontPage (Date and Time), Dreamweaver (Date), KompoZer',
    run: async (app, arg) => {
      const now = new Date();
      const v = arg || await openDialog({
        title: id === 'insert.date' ? 'Date' : 'Date and Time',
        fields: [
          { key: 'auto', label: 'Show', type: 'radio', value: 'static', options: [{ value: 'static', label: "Today's date as text" }, { value: 'auto', label: 'The date this page was last edited (updates when the page is saved)' }] },
          { key: 'date', label: 'Date format', type: 'select', value: 'long', options: DATE_FORMATS.map((f) => ({ value: f.id, label: f.id === 'none' ? f.label : formatDate(now, f.id) })) },
          ...(id === 'insert.dateTime' ? [{ key: 'time', label: 'Time format', type: 'select' as const, value: 't12', options: TIME_FORMATS.map((f) => ({ value: f.id, label: f.id === 'none' ? f.label : formatTime(now, f.id) })) }] : []),
        ],
      });
      if (!v) return;
      const tf = v.time || 'none';
      if (!isPage(app)) { insertChar(app, [formatDate(now, v.date), formatTime(now, tf)].filter(Boolean).join(' ')); return; }
      insertHtml(app, dateMarkup(now, { date: v.date, time: tf, auto: v.auto === 'auto' }));
    },
  })),
]));

// ------------------------------------------------------------------------------------------
// Links and bookmarks

const TARGETS = [{ value: '', label: 'Same window (default)' }, { value: '_blank', label: 'New window or tab' }, { value: '_parent', label: 'Parent frame' }, { value: '_top', label: 'Whole window (break out of frames)' }];

async function hyperlink(app: App, arg: any): Promise<void> {
  const editing = inDesign(app) ? closestSel(app, 'a') : null;
  const src = app.active.source;
  const bookmarks = idsIn(src).map((i) => '#' + i);
  const pages = siteRefs(app, () => true);
  const selText = selectionText(app);
  let v = arg && typeof arg === 'object' ? arg : typeof arg === 'string' ? { href: arg, text: selText || arg } : null;
  if (!v) {
    const cur = editing ? { href: getAttr(editing, 'href') || '', title: editing.getAttribute('title') || '', target: editing.getAttribute('target') || '', rel: editing.getAttribute('rel') || '', download: editing.hasAttribute('download') } : null;
    const tgt = cur?.target || '';
    v = await openDialog({
      title: editing ? 'Edit Hyperlink' : 'Insert Hyperlink', wide: true,
      fields: [
        { key: 'href', label: 'Address', type: 'combo', value: cur?.href ?? '', options: [...pages, ...bookmarks], placeholder: 'A page in this site, a bookmark (#name) or https://…', autofocus: true, help: bookmarks.length ? `Bookmarks on this page: ${bookmarks.slice(0, 12).join(', ')}${bookmarks.length > 12 ? '…' : ''}` : undefined },
        {
          key: 'href__browse', label: 'Link to a file from this device…', type: 'button',
          onClick: async (_x, ctl) => { const [f] = await pickFile('*/*'); if (!f) return; const p = await uploadToSite(app, f, isImagePath(f.name) ? 'images' : 'files'); ctl.set('href', rel(app, p)); },
        },
        ...(editing || selectionHtml(app) ? [] : [{ key: 'text', label: 'Text to display', type: 'text' as const, value: selText }]),
        { key: 'title', label: 'Tooltip (title)', type: 'text', value: cur?.title ?? '' },
        { key: 'target', label: 'Open in', type: 'select', value: TARGETS.some((t) => t.value === tgt) ? tgt : '__name', options: [...TARGETS, { value: '__name', label: 'Named frame or window…' }] },
        { key: 'targetName', label: 'Frame or window name', type: 'text', value: TARGETS.some((t) => t.value === tgt) ? '' : tgt, visibleIf: (x) => x.target === '__name' },
        { key: 'rel', label: 'Relationship (rel)', type: 'combo', value: cur?.rel ?? '', options: ['nofollow', 'noopener', 'noreferrer', 'sponsored', 'ugc', 'external', 'me', 'nofollow noopener'] },
        { key: 'download', label: 'Download the file instead of opening it', type: 'checkbox', value: cur?.download ?? false },
      ],
      buttons: editing ? [{ label: 'Remove Link', onClick: (_x, ctl) => ctl.close({ __remove: true }) }] : [],
      validate: (x) => (x.href?.trim() ? null : 'Type or choose an address.'),
    });
    if (!v) return;
    if (v.target === '__name') v.target = v.targetName || '';
  }
  const href = String(v.href || '').trim();
  if (editing) {
    mutate(app, () => {
      if (v.__remove) { const p = editing.parentNode!; while (editing.firstChild) p.insertBefore(editing.firstChild, editing); editing.remove(); return; }
      setAttr(app, editing, 'href', href);
      for (const k of ['title', 'target', 'rel']) setAttr(app, editing, k, v[k] || null);
      if (v.target === '_blank' && !/noopener/.test(editing.getAttribute('rel') || '')) editing.setAttribute('rel', ((editing.getAttribute('rel') || '') + ' noopener').trim());
      if (v.download) editing.setAttribute('download', ''); else editing.removeAttribute('download');
    });
    return;
  }
  const inner = selectionHtml(app);
  insertHtml(app, linkMarkup({ href, text: inner || esc(v.text || href), html: true, title: v.title, target: v.target, rel: v.rel, download: v.download }));
}

def(cmds('Links', 'FrontPage, Expression Web, Dreamweaver, KompoZer', [
  { id: 'insert.hyperlink', label: 'Hyperlink', icon: 'link', keys: ['Ctrl+K'], popular: true, run: hyperlink },
  {
    id: 'insert.bookmark', label: 'Bookmark', icon: 'bookmark_add', origin: 'FrontPage, Expression Web (Bookmark), Dreamweaver (Named Anchor), KompoZer (Anchor)',
    run: async (app, arg) => {
      const src = app.active.source;
      const existing = idsIn(src);
      const el = inDesign(app) ? selectedEl(app) : null;
      const target = el && el !== el.ownerDocument.body ? el : null;
      const suggestion = slugId(selectionText(app) || target?.textContent?.slice(0, 40) || 'bookmark', new Set(existing));
      const v = typeof arg === 'string' ? { name: arg, onEl: !!target } : await openDialog({
        title: 'Bookmark', help: 'A bookmark is a place on the page that links can jump to (#name).',
        fields: [
          { key: 'name', label: 'Bookmark name', type: 'text', value: target?.id || suggestion, autofocus: true },
          ...(target ? [{ key: 'onEl', label: `Name the selected <${target.tagName.toLowerCase()}> (sets its id)`, type: 'checkbox' as const, value: true }] : []),
          ...(existing.length ? [{ key: 'list', label: 'Other bookmarks on this page', type: 'info' as const, html: existing.map((x) => `<code>#${esc(x)}</code>`).join(' ') }] : []),
        ],
        validate: (x) => (!/^[^\s#]+$/.test(x.name || '') ? 'A bookmark name cannot be empty or contain spaces or #.' : x.name !== target?.id && existing.includes(x.name) ? 'This page already has a bookmark with that name.' : null),
      });
      if (!v) return;
      if (target && v.onEl) { mutate(app, () => { target.id = v.name; }); return; }
      const s = selectionHtml(app);
      if (s) insertHtml(app, `<a id="${escAttr(v.name)}">${s}</a>`); else insertRaw(app, `<a id="${escAttr(v.name)}"></a>`, 'Insert Bookmark');
    },
  },
  {
    id: 'insert.emailLink', label: 'Email Link', icon: 'mail', origin: 'Dreamweaver, Expression Web',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Email Link',
        fields: [
          { key: 'email', label: 'Email address', type: 'text', value: '', placeholder: 'name@example.com', autofocus: true },
          ...(selectionHtml(app) ? [] : [{ key: 'text', label: 'Text to display', type: 'text' as const, value: selectionText(app) }]),
          { key: 'subject', label: 'Subject (optional)', type: 'text', value: '' },
        ],
        validate: (x) => (/^[^@\s]+@[^@\s]+$/.test(x.email || '') ? null : 'Type an email address.'),
      });
      if (!v) return;
      const sel = selectionHtml(app);
      const m = emailLink(v.email, v.text || v.email, v.subject);
      insertHtml(app, sel ? m.replace(/>[^<]*<\/a>$/, `>${sel}</a>`) : m);
    },
  },
]));

// ------------------------------------------------------------------------------------------
// Code: any tag, raw HTML, file contents, snippets

const COMMON_TAGS = ['div', 'span', 'p', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'blockquote', 'pre', 'code', 'em', 'strong', 'small', 'mark', 'abbr', 'time', 'a', 'img', 'button', 'label', 'output', 'meter', 'progress', 'details', 'summary', 'dialog', 'template', 'slot', 'picture', 'source', 'video', 'audio', 'track', 'canvas', 'svg', 'math', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'hgroup', 'search', 'address', 'bdi', 'bdo', 'ruby', 'rt', 'rp', 'wbr', 'data'];
const VOIDS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Converts a file's text to markup for "Insert File". */
export function fileToHtml(app: App, path: string, text: string): string {
  const e = extOf(path);
  if (isPagePath(path) || e === 'htm' || e === 'html') {
    const body = bodyInner(text).trim();
    return app.site.has(path) ? rewriteRefs(body, path, (t) => relativeRef(app.active.path, t)) : body;
  }
  if (e === 'csv' || e === 'tsv') {
    const rows = text.trim().split(/\r?\n/).map((l) => l.split(e === 'tsv' ? '\t' : /,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => esc(c.replace(/^"|"$/g, '').replace(/""/g, '"'))));
    const [head, ...rest] = rows;
    return `<table>\n  <thead><tr>${(head || []).map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead>\n  <tbody>\n${rest.map((r) => `    <tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')}\n  </tbody>\n</table>`;
  }
  if (e === 'txt' || e === 'md' || !e) return text.trim().split(/\r?\n\s*\r?\n/).map((p) => `<p>${esc(p.trim()).replace(/\r?\n/g, '<br>\n')}</p>`).join('\n');
  return `<pre><code>${esc(text)}</code></pre>`;
}

def(cmds('Code', 'Dreamweaver, Expression Web, FrontPage', [
  {
    id: 'insert.tag', label: 'Tag', icon: 'code', origin: 'Dreamweaver (Tag Chooser), Expression Web',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { tag: arg, attrs: '' } : arg || await openDialog({
        title: 'Insert Tag', help: 'Wraps the selection in the tag, or inserts an empty one.',
        fields: [
          { key: 'tag', label: 'Tag name', type: 'combo', value: '', options: COMMON_TAGS, autofocus: true },
          { key: 'attrs', label: 'Attributes', type: 'text', value: '', placeholder: 'class="note" id="intro"' },
        ],
        validate: (x) => (/^[a-zA-Z][\w:-]*$/.test(x.tag || '') ? null : 'Type a tag name (letters, digits, - or :).'),
      });
      if (!v) return;
      const name = String(v.tag).toLowerCase();
      const at = v.attrs ? ' ' + String(v.attrs).trim().replace(/[<>]/g, '') : '';
      if (VOIDS.has(name)) insertHtml(app, `<${name}${at}>`);
      else wrapSelection(app, `<${name}${at}>`, `</${name}>`, name);
    },
  },
  {
    id: 'insert.html', label: 'HTML', icon: 'html', isEnabled: isText, origin: 'Expression Web, KompoZer (Insert HTML)',
    run: async (app, arg) => {
      const t = typeof arg === 'string' ? arg : await openDialog({ title: 'Insert HTML', wide: true, help: 'The markup is inserted exactly as typed, including scripts, comments and server code.', fields: [{ key: 'html', label: 'Markup', type: 'textarea', rows: 12, value: selectionHtml(app), autofocus: true }] }).then((r) => r?.html ?? null);
      if (t) insertRaw(app, t, 'Insert HTML');
    },
  },
  {
    id: 'insert.file', label: 'File Contents', icon: 'description', origin: 'FrontPage (Insert File), Expression Web',
    run: async (app, arg) => {
      let path: string | null = typeof arg === 'string' ? arg : null;
      let text: string | null = null;
      if (!path) {
        const opts = app.site.list((f) => isTextPath(f.path) && f.path !== app.active.path).map((f) => f.path);
        let device: File | null = null;
        const v = await openDialog({
          title: 'Insert File', help: 'Inserts the content of a page (its body), a text file (as paragraphs), a CSV file (as a table) or other text (as code).',
          fields: [
            { key: 'path', label: 'Site file', type: 'list', rows: 10, options: opts, value: opts[0] },
            { key: 'dev', label: 'Choose a file on this device…', type: 'button', onClick: async (_x, ctl) => { const [f] = await pickFile('.html,.htm,.txt,.md,.csv,.tsv,.css,.js,.xml,.json'); if (f) { device = f; ctl.close({ device: true }); } } },
          ],
        });
        if (!v) return;
        if (v.device && device) { path = (device as File).name; text = await (device as File).text(); }
        else path = v.path;
      }
      if (!path) return;
      if (/\.(docx?|rtf|odt)$/i.test(path)) { toast('Use File > Import > Word Document for word-processor files.'); return; }
      text ??= app.site.read(path) ?? null;
      if (text == null) { toast(`${path} is not a text file.`); return; }
      insertRaw(app, fileToHtml(app, path, text), 'Insert File');
    },
  },
  {
    id: 'insert.snippet', label: 'Snippet', icon: 'content_paste_go', origin: 'Dreamweaver (Snippets), Expression Web (Snippets)',
    run: async (app, arg) => {
      const list = allSnippets();
      let s = typeof arg === 'string' ? list.find((x) => x.id === arg || x.name === arg) : arg && typeof arg === 'object' && arg.body ? arg : null;
      if (!s) {
        const v = await openDialog({
          title: 'Insert Snippet',
          fields: [
            { key: 'id', label: 'Snippet', type: 'list', rows: 14, options: list.map((x) => ({ value: x.id, label: `${x.category} — ${x.name}${x.user ? ' (mine)' : ''}` })), value: list[0]?.id },
            { key: 'manage', label: 'Open the Snippets panel…', type: 'button', onClick: (_x, ctl) => { ctl.close(null); app.ui.togglePane('snippets'); } },
          ],
        });
        if (!v) return;
        s = list.find((x) => x.id === v.id);
      }
      if (s) insertRaw(app, s.body, 'Insert Snippet');
    },
  },
]));

// ------------------------------------------------------------------------------------------
// Head tags

const head = (app: App, label: string, fn: (src: string) => string) => { if (!app.editSource(label, fn)) toast('The page head already has this.'); else toast(`${label}: added to the page head.`); };
const absUrl = (app: App) => { const base = (app.site.data.meta?.url || app.site.data.meta?.siteUrl || '').replace(/\/+$/, ''); return base ? `${base}/${app.active.path.replace(/(^|\/)index\.html?$/, '$1')}` : ''; };

def(cmds('Head Tags', 'Dreamweaver (Head Tags), Expression Web, FrontPage (Page Properties)', [
  {
    id: 'insert.meta', label: 'Meta Tag', icon: 'data_object',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Meta Tag',
        fields: [
          { key: 'attr', label: 'Attribute', type: 'select', value: 'name', options: ['name', 'property', 'http-equiv'], half: true },
          { key: 'name', label: 'Value', type: 'combo', value: '', options: ['author', 'description', 'keywords', 'generator', 'theme-color', 'color-scheme', 'referrer', 'application-name', 'format-detection', 'og:title', 'content-security-policy', 'x-ua-compatible'], half: true },
          { key: 'content', label: 'Content', type: 'text', value: '' },
        ],
        validate: (x) => (x.name ? null : 'Type the meta name.'),
      });
      if (!v) return;
      head(app, 'Insert Meta Tag', (s) => setMeta(s, v.name, v.content ?? '', v.attr || 'name'));
    },
  },
  {
    id: 'insert.metaKeywords', label: 'Keywords', icon: 'sell',
    run: async (app, arg) => {
      const t = typeof arg === 'string' ? arg : await promptDialog('Keywords', 'Keywords, separated by commas (search engines mostly ignore these today):', getMeta(app.active.source, 'keywords') || '');
      if (t != null) head(app, 'Set Keywords', (s) => setMeta(s, 'keywords', t || null));
    },
  },
  {
    id: 'insert.metaDescription', label: 'Description', icon: 'short_text',
    run: async (app, arg) => {
      const t = typeof arg === 'string' ? arg : await openDialog({ title: 'Page Description', help: 'Search engines often show this under the page title. Aim for 50–160 characters.', fields: [{ key: 't', label: 'Description', type: 'textarea', rows: 4, value: getMeta(app.active.source, 'description') || '', autofocus: true }], onChange: (x, ctl) => { const n = (x.t || '').length; ctl.body.querySelector('.ql-help')!.textContent = `Search engines often show this under the page title. ${n} characters${n > 160 ? ' — may be cut off' : ''}.`; } }).then((r) => r?.t ?? null);
      if (t != null) head(app, 'Set Description', (s) => setMeta(s, 'description', t || null));
    },
  },
  {
    id: 'insert.metaRefresh', label: 'Refresh / Redirect', icon: 'autorenew',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Refresh', help: 'Reloads the page, or goes to another address, after a delay. For permanent moves a server redirect is better for visitors and search engines.',
        fields: [
          { key: 'delay', label: 'Delay', type: 'number', value: 5, suffix: 'seconds', min: 0 },
          { key: 'action', label: 'Then', type: 'radio', value: 'go', options: [{ value: 'go', label: 'Go to an address' }, { value: 'reload', label: 'Reload this page' }] },
          ...fileFields(app, 'url', 'Address', { filter: isPagePath, accept: '.html,.htm', dir: '', blank: true }).slice(0, 1).map((f) => ({ ...f, visibleIf: (x: any) => x.action === 'go' })),
        ],
      });
      if (!v) return;
      const content = `${Math.max(0, +v.delay || 0)}${v.action === 'go' && v.url ? `; url=${v.url}` : ''}`;
      head(app, 'Set Refresh', (s) => setMeta(s, 'refresh', content, 'http-equiv'));
    },
  },
  {
    id: 'insert.metaViewport', label: 'Viewport', icon: 'devices',
    run: async (app, arg) => {
      const t = typeof arg === 'string' ? arg : await openDialog({ title: 'Viewport', help: 'Tells phones to show the page at the device width. Needed for responsive pages.', fields: [{ key: 't', label: 'Content', type: 'combo', value: getMeta(app.active.source, 'viewport') || VIEWPORTS[0], options: VIEWPORTS }] }).then((r) => r?.t ?? null);
      if (t != null) head(app, 'Set Viewport', (s) => setMeta(s, 'viewport', t || null));
    },
  },
  {
    id: 'insert.metaRobots', label: 'Robots', icon: 'smart_toy',
    run: async (app, arg) => {
      const cur = (getMeta(app.active.source, 'robots') || '').toLowerCase();
      const v = arg || await openDialog({
        title: 'Robots', help: 'Tells search engines whether to list this page and follow its links.',
        fields: [
          { key: 'index', label: 'List this page in search results', type: 'checkbox', value: !cur.includes('noindex') },
          { key: 'follow', label: 'Follow the links on this page', type: 'checkbox', value: !cur.includes('nofollow') },
          { key: 'noarchive', label: 'Do not show a cached copy', type: 'checkbox', value: cur.includes('noarchive') },
          { key: 'nosnippet', label: 'Do not show a text snippet', type: 'checkbox', value: cur.includes('nosnippet') },
          { key: 'noimageindex', label: 'Do not index the pictures', type: 'checkbox', value: cur.includes('noimageindex') },
        ],
      });
      if (!v) return;
      const parts = [v.index ? 'index' : 'noindex', v.follow ? 'follow' : 'nofollow', ...['noarchive', 'nosnippet', 'noimageindex'].filter((k) => v[k])];
      head(app, 'Set Robots', (s) => setMeta(s, 'robots', parts.join(', ') === 'index, follow' ? null : parts.join(', ')));
    },
  },
  {
    id: 'insert.base', label: 'Base Address', icon: 'home_pin',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Base', help: 'Every relative link on the page is resolved against this address. Most pages should not have one.',
        fields: [{ key: 'href', label: 'Base address', type: 'text', value: app.site.data.meta?.url || '', placeholder: 'https://example.com/' }, { key: 'target', label: 'Default target for links', type: 'select', value: '', options: TARGETS }],
      });
      if (!v || (!v.href && !v.target)) return;
      const tag = `<base${attrString({ href: v.href, target: v.target })}>`;
      head(app, 'Set Base', (s) => (/<base\b[^>]*>/i.test(s) ? s.replace(/<base\b[^>]*>/i, () => tag) : headInsert(s, tag)));
    },
  },
  {
    id: 'insert.linkTag', label: 'Link Tag', icon: 'add_link',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Link',
        fields: [
          { key: 'rel', label: 'Relationship (rel)', type: 'combo', value: 'stylesheet', options: ['stylesheet', 'icon', 'apple-touch-icon', 'manifest', 'alternate', 'canonical', 'preload', 'preconnect', 'dns-prefetch', 'prefetch', 'modulepreload', 'author', 'license', 'next', 'prev', 'search', 'me'] },
          ...fileFields(app, 'href', 'Address', { filter: () => true, accept: '*/*', dir: '', blank: true }),
          { key: 'type', label: 'Type', type: 'text', value: '', half: true }, { key: 'media', label: 'Media', type: 'text', value: '', half: true },
          { key: 'title', label: 'Title', type: 'text', value: '', half: true }, { key: 'hreflang', label: 'Language (hreflang)', type: 'text', value: '', half: true },
          { key: 'as', label: 'Preload as', type: 'select', value: '', options: ['', 'style', 'script', 'font', 'image', 'fetch', 'document'], half: true },
          { key: 'crossorigin', label: 'Cross-origin', type: 'select', value: '', options: ['', 'anonymous', 'use-credentials'], half: true },
        ],
        validate: (x) => (x.rel && x.href ? null : 'Type the relationship and the address.'),
      });
      if (!v) return;
      const tag = `<link${attrString({ rel: v.rel, href: v.href, type: v.type, media: v.media, title: v.title, hreflang: v.hreflang, as: v.as, crossorigin: v.crossorigin === 'anonymous' ? true : v.crossorigin })}>`;
      head(app, 'Insert Link Tag', (s) => headOnce(s, tag));
    },
  },
  {
    id: 'insert.favicon', label: 'Site Icon (Favicon)', icon: 'star',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Site Icon', help: 'The small picture browsers show in tabs and bookmarks. Use a square PNG or SVG (at least 180 × 180 for phones) or an .ico file.',
        fields: [
          ...fileFields(app, 'href', 'Icon', { filter: (p) => /\.(ico|png|svg|gif|webp)$/i.test(p), accept: '.ico,.png,.svg,.gif,.webp', dir: 'images' }),
          { key: 'apple', label: 'Also use it as the home-screen icon on phones (apple-touch-icon)', type: 'checkbox', value: true },
        ],
        validate: (x) => (x.href ? null : 'Choose the icon.'),
      });
      if (!v) return;
      const type = /\.svg$/i.test(v.href) ? 'image/svg+xml' : /\.png$/i.test(v.href) ? 'image/png' : /\.ico$/i.test(v.href) ? 'image/x-icon' : '';
      head(app, 'Set Site Icon', (s) => {
        let out = setLinkRel(s, 'icon', `<link rel="icon" href="${escAttr(v.href)}"${type ? ` type="${type}"` : ''}>`);
        if (v.apple && !/\.ico$/i.test(v.href)) out = setLinkRel(out, 'apple-touch-icon', `<link rel="apple-touch-icon" href="${escAttr(v.href)}">`);
        return out;
      });
    },
  },
  {
    id: 'insert.openGraph', label: 'Social Sharing Tags (Open Graph)', icon: 'share',
    run: async (app, arg) => {
      const src = app.active.source;
      const meta = app.site.data.meta || {};
      const v = arg || await openDialog({
        title: 'Open Graph', help: 'Social networks and chat apps use these when someone shares the page. Addresses must be absolute (https://…).',
        fields: [
          { key: 'title', label: 'Title', type: 'text', value: getMeta(src, 'og:title', 'property') || getTitle(src) },
          { key: 'description', label: 'Description', type: 'textarea', rows: 2, value: getMeta(src, 'og:description', 'property') || getMeta(src, 'description') || '' },
          { key: 'url', label: 'Page address', type: 'text', value: getMeta(src, 'og:url', 'property') || absUrl(app) },
          { key: 'image', label: 'Picture address (1200 × 630 works best)', type: 'text', value: getMeta(src, 'og:image', 'property') || '' },
          { key: 'imageAlt', label: 'Picture description', type: 'text', value: getMeta(src, 'og:image:alt', 'property') || '' },
          { key: 'type', label: 'Type', type: 'select', value: getMeta(src, 'og:type', 'property') || 'website', options: ['website', 'article', 'profile', 'book', 'music.song', 'video.movie', 'product'], half: true },
          { key: 'locale', label: 'Locale', type: 'text', value: getMeta(src, 'og:locale', 'property') || 'en_US', half: true },
          { key: 'siteName', label: 'Site name', type: 'text', value: getMeta(src, 'og:site_name', 'property') || meta.name || app.site.name },
        ],
      });
      if (!v) return;
      head(app, 'Set Open Graph Tags', (s) => openGraphTags(v).reduce((acc, [k, c]) => setMeta(acc, k, c, 'property'), s));
    },
  },
  {
    id: 'insert.twitterCard', label: 'Social Card Tags (X / Twitter)', icon: 'badge',
    run: async (app, arg) => {
      const src = app.active.source;
      const v = arg || await openDialog({
        title: 'Social Card', help: 'X (Twitter) and some other apps read these; without them they fall back to the Open Graph tags.',
        fields: [
          { key: 'card', label: 'Card', type: 'select', value: getMeta(src, 'twitter:card') || 'summary_large_image', options: [{ value: 'summary_large_image', label: 'Large picture' }, { value: 'summary', label: 'Summary' }] },
          { key: 'title', label: 'Title', type: 'text', value: getMeta(src, 'twitter:title') || getTitle(src) },
          { key: 'description', label: 'Description', type: 'textarea', rows: 2, value: getMeta(src, 'twitter:description') || getMeta(src, 'description') || '' },
          { key: 'image', label: 'Picture address', type: 'text', value: getMeta(src, 'twitter:image') || getMeta(src, 'og:image', 'property') || '' },
          { key: 'imageAlt', label: 'Picture description', type: 'text', value: getMeta(src, 'twitter:image:alt') || '' },
          { key: 'site', label: 'Site account (@name)', type: 'text', value: getMeta(src, 'twitter:site') || '', half: true },
          { key: 'creator', label: 'Author account (@name)', type: 'text', value: getMeta(src, 'twitter:creator') || '', half: true },
        ],
      });
      if (!v) return;
      head(app, 'Set Social Card Tags', (s) => twitterTags(v).reduce((acc, [k, c]) => setMeta(acc, k, c), s));
    },
  },
  {
    id: 'insert.jsonLd', label: 'Structured Data (JSON-LD)', icon: 'schema',
    run: async (app, arg) => {
      const src = app.active.source;
      const v = arg || await openDialog({
        title: 'Structured Data', help: 'Describes the page for search engines (schema.org). Leave fields empty to skip them.',
        fields: [
          { key: 'type', label: 'This page describes', type: 'select', value: 'WebPage', options: ['WebPage', 'WebSite', 'Article', 'BlogPosting', 'Organization', 'LocalBusiness', 'Person', 'Product', 'Event', 'FAQPage'] },
          { key: 'name', label: 'Name or headline', type: 'text', value: getTitle(src) },
          { key: 'description', label: 'Description', type: 'textarea', rows: 2, value: getMeta(src, 'description') || '' },
          { key: 'url', label: 'Address', type: 'text', value: absUrl(app) },
          { key: 'image', label: 'Picture address', type: 'text', value: '' },
          { key: 'author', label: 'Author', type: 'text', value: getMeta(src, 'author') || '', visibleIf: (x) => /Article|BlogPosting/.test(x.type) },
          { key: 'date', label: 'Date published', type: 'date', value: nowIso().slice(0, 10), visibleIf: (x) => /Article|BlogPosting/.test(x.type) },
          { key: 'phone', label: 'Telephone', type: 'text', value: '', visibleIf: (x) => /Organization|LocalBusiness/.test(x.type) },
          { key: 'address', label: 'Street address', type: 'text', value: '', visibleIf: (x) => x.type === 'LocalBusiness' },
          { key: 'start', label: 'Starts', type: 'text', value: '', placeholder: '2026-12-31T19:00', visibleIf: (x) => x.type === 'Event' },
          { key: 'location', label: 'Location', type: 'text', value: '', visibleIf: (x) => x.type === 'Event' },
          { key: 'price', label: 'Price', type: 'text', value: '', visibleIf: (x) => x.type === 'Product' },
          { key: 'faq', label: 'Questions and answers (Q: … / A: … lines)', type: 'textarea', rows: 5, value: '', visibleIf: (x) => x.type === 'FAQPage' },
        ],
      });
      if (!v) return;
      const t = v.type;
      const data: Record<string, any> = { '@type': t, [/Article|BlogPosting/.test(t) ? 'headline' : 'name']: v.name, description: v.description, url: v.url, image: v.image };
      if (/Article|BlogPosting/.test(t)) Object.assign(data, { author: v.author ? { '@type': 'Person', name: v.author } : undefined, datePublished: v.date });
      if (/Organization|LocalBusiness/.test(t)) Object.assign(data, { telephone: v.phone, address: v.address ? { '@type': 'PostalAddress', streetAddress: v.address } : undefined });
      if (t === 'Event') Object.assign(data, { startDate: v.start, location: v.location ? { '@type': 'Place', name: v.location } : undefined });
      if (t === 'Product' && v.price) Object.assign(data, { offers: { '@type': 'Offer', price: v.price.replace(/[^\d.]/g, ''), priceCurrency: 'USD' } });
      if (t === 'FAQPage') {
        const qa: { q: string; a: string }[] = [];
        for (const line of String(v.faq || '').split('\n')) { const m = /^\s*([QA]):\s*(.*)$/i.exec(line); if (!m) continue; if (m[1].toUpperCase() === 'Q') qa.push({ q: m[2], a: '' }); else if (qa.length) qa[qa.length - 1].a += (qa[qa.length - 1].a ? ' ' : '') + m[2]; }
        data.mainEntity = qa.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } }));
      }
      head(app, 'Insert Structured Data', (s) => headInsert(s, jsonLd(data).replace(/\n/g, '\n  ')));
    },
  },
  {
    id: 'insert.canonical', label: 'Canonical Address', icon: 'verified',
    run: async (app, arg) => {
      const cur = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)/i.exec(app.active.source)?.[1];
      const t = typeof arg === 'string' ? arg : await promptDialog('Canonical Address', 'The preferred address of this page (absolute, https://…), for search engines:', cur || absUrl(app));
      if (t) head(app, 'Set Canonical Address', (s) => setLinkRel(s, 'canonical', `<link rel="canonical" href="${escAttr(t)}">`));
    },
  },
]));

// ------------------------------------------------------------------------------------------
// Script objects

def(cmds('Script Objects', 'Dreamweaver, Expression Web', [
  {
    id: 'insert.script', label: 'Script', icon: 'javascript',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { code: arg, type: 'classic', where: 'here' } : arg || await openDialog({
        title: 'Script', wide: true,
        fields: [
          { key: 'code', label: 'Script', type: 'textarea', rows: 10, value: selectionText(app) || '', autofocus: true },
          { key: 'type', label: 'Type', type: 'select', value: 'classic', options: [{ value: 'classic', label: 'JavaScript' }, { value: 'module', label: 'JavaScript module' }, { value: 'application/json', label: 'JSON data' }, { value: 'importmap', label: 'Import map' }], half: true },
          { key: 'where', label: 'Place', type: 'select', value: 'here', options: [{ value: 'here', label: 'At the cursor' }, { value: 'head', label: 'In the page head' }, { value: 'end', label: 'At the end of the body' }], half: true },
        ],
      });
      if (!v) return;
      const code = String(v.code || '').replace(/<\/script/gi, '<\\/script');
      const tag = `<script${v.type && v.type !== 'classic' ? ` type="${escAttr(v.type)}"` : ''}>\n${code}\n</script>`;
      if (v.where === 'head') app.editSource('Insert Script', (s) => headInsert(s, tag));
      else if (v.where === 'end') app.editSource('Insert Script', (s) => bodyEndInsert(s, tag));
      else insertRaw(app, tag, 'Insert Script');
    },
  },
  {
    id: 'insert.scriptFile', label: 'Script File', icon: 'integration_instructions',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { src: arg, where: 'head', defer: true } : arg || await openDialog({
        title: 'Link a Script File',
        fields: [
          ...fileFields(app, 'src', 'Script', { filter: (p) => /\.m?js$/i.test(p), accept: '.js,.mjs', dir: 'js' }),
          { key: 'where', label: 'Place', type: 'select', value: 'head', options: [{ value: 'head', label: 'In the page head' }, { value: 'end', label: 'At the end of the body' }, { value: 'here', label: 'At the cursor' }] },
          { key: 'defer', label: 'Run after the page is read (defer)', type: 'checkbox', value: true, half: true },
          { key: 'async', label: 'Run as soon as loaded (async)', type: 'checkbox', value: false, half: true },
          { key: 'module', label: 'JavaScript module', type: 'checkbox', value: /\.mjs$/i.test('') },
        ],
        validate: (x) => (x.src ? null : 'Choose a script.'),
      });
      if (!v) return;
      const tag = `<script${v.module ? ' type="module"' : ''} src="${escAttr(v.src)}"${v.defer && !v.module ? ' defer' : ''}${v.async ? ' async' : ''}></script>`;
      if (v.where === 'here') insertRaw(app, tag, 'Insert Script File');
      else if (v.where === 'end') app.editSource('Link Script', (s) => (s.includes(`src="${escAttr(v.src)}"`) ? s : bodyEndInsert(s, tag)));
      else if (!v.async) head(app, 'Link Script', (s) => addScript(s, v.src, { defer: v.defer && !v.module, module: v.module }));
      else head(app, 'Link Script', (s) => headOnce(s, tag));
    },
  },
  { id: 'insert.noscript', label: 'No-Script Content', icon: 'code_off', run: (app) => insertRaw(app, `<noscript>${selectionHtml(app) || '<p>This page works best with JavaScript turned on.</p>'}</noscript>`, 'Insert No-Script') },
  {
    id: 'insert.template', label: 'Template Element', icon: 'content_copy', tip: 'Markup that scripts can copy; browsers do not show it.',
    run: async (app) => {
      const id = await promptDialog('Template Element', 'Id (scripts find it with document.getElementById):', slugId('row-template', new Set(idsIn(app.active.source))));
      if (id != null) insertRaw(app, `<template id="${escAttr(id)}">\n  ${selectionHtml(app) || '<div class="item"><h3></h3><p></p></div>'}\n</template>`, 'Insert Template');
    },
  },
]));

// ------------------------------------------------------------------------------------------
// Server-side code

async function phpVar(app: App, arg: any, sup: '_POST' | '_GET' | '_SESSION' | '_COOKIE', label: string): Promise<void> {
  const n = typeof arg === 'string' ? arg : await promptDialog(label, 'Name:', '');
  if (!n) return;
  warnServer(app, 'php');
  insertRaw(app, php.variable(sup, n), label);
  if (sup === '_SESSION' && !/session_start\s*\(/.test(app.active.source)) toast('Call session_start() at the top of the page before using session variables.', { ms: 5000 });
}
async function phpFile(app: App, arg: any, kind: 'include' | 'require'): Promise<void> {
  const v = typeof arg === 'string' ? { file: arg, once: kind === 'require' } : await openDialog({
    title: kind === 'include' ? 'PHP Include' : 'PHP Require',
    help: kind === 'include' ? 'include continues the page if the file is missing; require stops it.' : 'require stops the page with an error if the file is missing.',
    fields: [{ key: 'file', label: 'File', type: 'combo', value: '', options: siteRefs(app, (p) => /\.(php|inc|phtml|html?)$/i.test(p)), autofocus: true }, { key: 'once', label: 'Only once (include_once / require_once)', type: 'checkbox', value: kind === 'require' }],
    validate: (x) => (x.file ? null : 'Choose the file.'),
  });
  if (!v) return;
  warnServer(app, 'php');
  insertRaw(app, kind === 'include' ? php.include(v.file, v.once) : php.require(v.file, v.once), `PHP ${kind}`);
}
const phpCmd = (id: string, label: string, icon: string, run: Def['run']): Def => ({ id, label, icon, origin: 'Dreamweaver (PHP objects), Expression Web', run });

def(cmds('PHP', 'Dreamweaver, Expression Web', [
  phpCmd('insert.phpBlock', 'Code Block', 'php', (app, arg) => { warnServer(app, 'php'); insertRaw(app, php.block(typeof arg === 'string' ? arg : selectionText(app)), 'PHP Block'); }),
  phpCmd('insert.phpEcho', 'Echo', 'output', async (app, arg) => {
    const v = typeof arg === 'string' ? { expr: arg, escape: true } : await openDialog({ title: 'PHP Echo', fields: [{ key: 'expr', label: 'Expression', type: 'text', value: '$name', autofocus: true }, { key: 'escape', label: 'Escape HTML characters (htmlspecialchars), recommended', type: 'checkbox', value: true }] });
    if (!v?.expr) return;
    warnServer(app, 'php');
    insertRaw(app, php.echo(v.expr, v.escape), 'PHP Echo');
  }),
  phpCmd('insert.phpInclude', 'Include', 'input', (app, arg) => phpFile(app, arg, 'include')),
  phpCmd('insert.phpRequire', 'Require', 'login', (app, arg) => phpFile(app, arg, 'require')),
  phpCmd('insert.phpIf', 'If', 'alt_route', async (app, arg) => {
    const c = typeof arg === 'string' ? arg : await promptDialog('PHP If', 'Condition (the selection is shown only when it is true):', "!empty($_GET['q'])");
    if (c == null) return;
    warnServer(app, 'php');
    insertRaw(app, php.if(c, selectionHtml(app) || '\n  <p>Shown when the condition is true</p>\n'), 'PHP If');
  }),
  phpCmd('insert.phpElse', 'Else', 'call_split', (app) => { warnServer(app, 'php'); insertRaw(app, php.else(), 'PHP Else'); }),
  phpCmd('insert.phpForeach', 'For Each', 'repeat', async (app, arg) => {
    const v = arg || await openDialog({ title: 'PHP For Each', help: 'Repeats the selection for each item.', fields: [{ key: 'list', label: 'Array', type: 'text', value: '$items', half: true }, { key: 'item', label: 'Item variable', type: 'text', value: '$item', half: true }] });
    if (!v) return;
    warnServer(app, 'php');
    insertRaw(app, php.foreach(v.list, v.item, selectionHtml(app) || `\n  <li><?= htmlspecialchars(${v.item || '$item'}, ENT_QUOTES) ?></li>\n`), 'PHP For Each');
  }),
  phpCmd('insert.phpFormVar', 'Form Variable', 'input', (app, arg) => phpVar(app, arg, '_POST', 'Form Variable')),
  phpCmd('insert.phpUrlVar', 'URL Variable', 'link', (app, arg) => phpVar(app, arg, '_GET', 'URL Variable')),
  phpCmd('insert.phpSessionVar', 'Session Variable', 'badge', (app, arg) => phpVar(app, arg, '_SESSION', 'Session Variable')),
  phpCmd('insert.phpCookie', 'Cookie Variable', 'cookie', (app, arg) => phpVar(app, arg, '_COOKIE', 'Cookie Variable')),
]));

async function chooseTemplate(title: string, list: { id: string; label: string; text: (s: string) => string }[], arg: any): Promise<((s: string) => string) | null> {
  const id = typeof arg === 'string' ? arg : await openDialog({ title, fields: [{ key: 'id', label: 'Insert', type: 'list', rows: list.length, options: list.map((x) => ({ value: x.id, label: x.label })), value: list[0].id }] }).then((r) => r?.id);
  return list.find((x) => x.id === id)?.text ?? null;
}

def(cmds('Server-Side', 'FrontPage, Dreamweaver, Expression Web', [
  {
    id: 'insert.ssi', label: 'Server-Side Include', icon: 'input', origin: 'Dreamweaver (Server-Side Include), Expression Web',
    run: async (app, arg) => {
      const f = typeof arg === 'string' ? arg : await openDialog({ title: 'Server-Side Include', help: 'The web server inserts the file when the page is requested (pages usually need the .shtml extension). Preview and Publish can expand includes for hosts that do not run them.', fields: [{ key: 'f', label: 'File', type: 'combo', value: '', options: app.site.list((x) => isTextPath(x.path) && x.path !== app.active.path).map((x) => '/' + x.path), autofocus: true }] }).then((r) => r?.f);
      if (!f) return;
      warnServer(app, 'ssi');
      insertRaw(app, ssi.include(f.startsWith('/') || /^https?:/.test(f) ? f : '/' + f, true), 'Insert Include');
    },
  },
  {
    id: 'insert.ssiEcho', label: 'Server Variable (Echo)', icon: 'output',
    run: async (app, arg) => {
      const n = typeof arg === 'string' ? arg : await openDialog({ title: 'Server Variable', fields: [{ key: 'v', label: 'Variable', type: 'combo', value: 'LAST_MODIFIED', options: SSI_VARS }] }).then((r) => r?.v);
      if (!n) return;
      warnServer(app, 'ssi');
      insertRaw(app, ssi.echo(n), 'Insert Server Variable');
    },
  },
  { id: 'insert.aspBlock', label: 'ASP Code Block', icon: 'terminal', origin: 'FrontPage, Dreamweaver (ASP)', run: (app, arg) => { warnServer(app, 'asp'); insertRaw(app, asp.block(typeof arg === 'string' ? arg : selectionText(app)), 'ASP Block'); } },
  {
    id: 'insert.aspInclude', label: 'ASP Include', icon: 'input', origin: 'FrontPage, Dreamweaver (ASP)',
    run: async (app, arg) => {
      const f = typeof arg === 'string' ? arg : await openDialog({ title: 'ASP Include', fields: [{ key: 'f', label: 'File', type: 'combo', value: '', options: siteRefs(app, (p) => /\.(asp|inc|html?)$/i.test(p)), autofocus: true }] }).then((r) => r?.f);
      if (!f) return;
      warnServer(app, 'asp');
      insertRaw(app, asp.include(f, false).replace('virtual', 'file'), 'ASP Include');
    },
  },
  { id: 'insert.jspBlock', label: 'JSP Code Block', icon: 'coffee', origin: 'Dreamweaver (JSP)', run: (app, arg) => { warnServer(app, 'jsp'); insertRaw(app, jsp.block(typeof arg === 'string' ? arg : selectionText(app)), 'JSP Block'); } },
  {
    id: 'insert.handlebars', label: 'Handlebars Tag', icon: 'data_object', origin: 'Template engines (Handlebars, Mustache)',
    run: async (app, arg) => { const t = await chooseTemplate('Handlebars', HANDLEBARS, arg); if (t) insertRaw(app, t(selectionHtml(app)), 'Insert Handlebars'); },
  },
  {
    id: 'insert.liquid', label: 'Liquid Tag', icon: 'water_drop', origin: 'Template engines (Liquid: Jekyll, Shopify, Eleventy)',
    run: async (app, arg) => { const t = await chooseTemplate('Liquid', LIQUID, arg); if (t) insertRaw(app, t(selectionHtml(app)), 'Insert Liquid'); },
  },
]));

// ------------------------------------------------------------------------------------------
// Ribbon menus

const HEADINGS = { label: 'Headings', icon: 'title', items: ['insert.h1', 'insert.h2', 'insert.h3', 'insert.h4', 'insert.h5', 'insert.h6'] };
const INLINE = { label: 'Inline Text', icon: 'text_fields', items: ['insert.abbr', 'insert.cite', 'insert.code', 'insert.dfn', 'insert.kbd', 'insert.samp', 'insert.var', 'insert.q', 'insert.mark', 'insert.small', 'insert.sub', 'insert.sup', 'insert.time', 'insert.del', 'insert.ins', 'insert.span'] };
const LAYOUT = { label: 'Layout', icon: 'dashboard', items: ['insert.div', 'insert.section', 'insert.article', 'insert.aside', 'insert.header', 'insert.footer', 'insert.nav', 'insert.main', 'insert.figure', 'insert.details', 'insert.dialog', '|', 'insert.layer', 'insert.iframe', 'insert.fluidGrid', 'insert.columns', 'insert.flexRow', 'insert.gridLayout'] };

const menuCmd = (id: string, label: string, icon: string, items: Parameters<typeof menuOf>[0]): Def => ({ id, label, icon, kind: 'menu', noRecord: true, run: () => undefined, menu: () => menuOf(items) });

def(cmds('Menus', 'Expression Web, Dreamweaver (Insert bar)', [
  menuCmd('insert.htmlMenu', 'HTML', 'html', ['insert.paragraph', HEADINGS, 'insert.blockquote', 'insert.pre', 'insert.address', '|', 'insert.ul', 'insert.ol', 'insert.dl', '|', INLINE, LAYOUT, '|', 'insert.hr', 'insert.br', 'insert.comment', 'insert.tag', 'insert.html']),
  menuCmd('insert.specialMenu', 'Special Characters', 'special_character', ['insert.nbsp', 'insert.copyright', 'insert.registered', 'insert.trademark', 'insert.pound', 'insert.yen', 'insert.euro', 'insert.leftQuote', 'insert.rightQuote', 'insert.emDash', 'insert.enDash', 'insert.ellipsis', 'insert.softHyphen', '|', 'insert.symbol', 'insert.emoji', 'insert.smiley', '|', 'insert.date', 'insert.dateTime', 'insert.breakBelowImages']),
  menuCmd('insert.headMenu', 'Head Tags', 'data_object', ['insert.meta', 'insert.metaKeywords', 'insert.metaDescription', 'insert.metaRefresh', 'insert.metaViewport', 'insert.metaRobots', 'insert.base', 'insert.linkTag', 'insert.favicon', '|', 'insert.openGraph', 'insert.twitterCard', 'insert.jsonLd', 'insert.canonical']),
  menuCmd('insert.scriptMenu', 'Script', 'javascript', ['insert.script', 'insert.scriptFile', 'insert.noscript', 'insert.template']),
  menuCmd('insert.phpMenu', 'PHP', 'php', ['insert.phpBlock', 'insert.phpEcho', 'insert.phpInclude', 'insert.phpRequire', '|', 'insert.phpIf', 'insert.phpElse', 'insert.phpForeach', '|', 'insert.phpFormVar', 'insert.phpUrlVar', 'insert.phpSessionVar', 'insert.phpCookie']),
  menuCmd('insert.serverMenu', 'Server-Side', 'dns', ['insert.ssi', 'insert.ssiEcho', '|', 'insert.aspBlock', 'insert.aspInclude', 'insert.jspBlock', '|', 'insert.handlebars', 'insert.liquid']),
  menuCmd('insert.mediaMenu', 'More Media', 'perm_media', [
    { heading: 'Pictures' }, 'insert.picture', 'insert.pictureElement', 'insert.imagePlaceholder', 'insert.imageMap', 'insert.rolloverImage', 'insert.clipArt', 'insert.shape', 'insert.decorativeText', 'insert.lightbox',
    { heading: 'Video, sound and maps' }, 'insert.video', 'insert.audio', 'insert.youtube', 'insert.vimeo', 'insert.map',
    { heading: 'Drawing and math' }, 'insert.svg', 'insert.canvas', 'insert.math',
    { label: 'Legacy Plug-ins', icon: 'extension', items: ['insert.flash', 'insert.object', 'insert.embed', 'insert.applet', 'insert.activex', 'insert.plugin'] },
  ]),
  menuCmd('insert.componentMenu', 'Web Component', 'widgets', [
    { label: 'Navigation', icon: 'menu', items: ['insert.navbar', 'insert.linkBar', 'insert.breadcrumbs', 'insert.tocSite', 'insert.tocPage', 'insert.backToTop'] },
    { label: 'Page Content', icon: 'web', items: ['insert.hero', 'insert.cards', 'insert.pricingTable', 'insert.testimonials', 'insert.timeline', 'insert.pageBanner', 'insert.marquee', 'insert.countdown'] },
    { label: 'Interactive', icon: 'touch_app', items: ['insert.carousel', 'insert.tabs', 'insert.accordion', 'insert.modal', 'insert.lightbox', 'insert.photoGallery'] },
    { label: 'Forms', icon: 'dynamic_form', items: ['insert.contactForm', 'insert.feedbackForm', 'insert.newsletterForm', 'insert.searchForm'] },
    { label: 'Social', icon: 'share', items: ['insert.socialLinks', 'insert.shareButtons', 'insert.rssFeed'] },
    { label: 'Site Content', icon: 'source', items: ['insert.includePage', 'insert.scheduledInclude', 'insert.scheduledPicture', 'insert.substitution', 'insert.lastUpdated', 'insert.hitCounter', 'insert.cookieBanner'] },
  ]),
  menuCmd('insert.frameworkMenu', 'Frameworks', 'deployed_code', ['insert.bootstrap', 'insert.tailwind', 'insert.picoCss', 'insert.bulma', 'insert.foundation', '|', 'insert.jquery', 'insert.alpine', '|', 'insert.fontAwesome', 'insert.googleFont', 'insert.normalize', '|', 'insert.analytics']),
]));
