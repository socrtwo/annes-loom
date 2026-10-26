/** Help: documentation, shortcuts, command reference, where-is-it map for the classic menus, HTML and CSS quick references, about. */
import { def, getCommand, allCommands, commandCount } from './registry';
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import { h, clear } from '../ui/dom';
import { CLASSIC_MENUS, CLASSIC_LAYOUT_NAMES, type ClassicItem } from '../ui/classicMenus';
import { DEFAULT_TABS } from '../ui/ribbonLayout';
import { prettyKey } from '../util/keys';

declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const REPO = 'https://github.com/socrtwo/QuillLoom';

async function open(url: string): Promise<void> {
  const { openExternal } = await import('../platform/native');
  openExternal(url);
}

// ---------------------------------------------------------------------------------------------
// Where each command lives

/** For every command id: its menu paths in one classic layout ("File ▸ New ▸ Page"). */
export function menuPaths(layout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (items: ClassicItem[], trail: string[]) => {
    for (const it of items) {
      if (typeof it === 'string') {
        if (it === '|') continue;
        const label = getCommand(it)?.label || it;
        const p = [...trail, label].join(' ▸ ');
        out.set(it, [...(out.get(it) || []), p]);
      } else walk(it.items, [...trail, it.label]);
    }
  };
  for (const m of CLASSIC_MENUS[layout] || []) walk(m.items, [m.label]);
  return out;
}

/** For every command id: its ribbon places ("Home ▸ Clipboard"). */
export function ribbonPaths(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of DEFAULT_TABS) for (const g of t.groups) for (const id of g.items) out.set(id, [...(out.get(id) || []), `${t.label} ▸ ${g.label}`]);
  return out;
}

const LAYOUTS = ['expression', 'frontpage', 'dreamweaver', 'composer'];

async function menuMap(app: App): Promise<void> {
  const maps = LAYOUTS.map((l) => menuPaths(l));
  const ribbon = ribbonPaths();
  const input = h('input', { type: 'search', placeholder: 'Type a command name, e.g. "page properties" or "publish"', 'aria-label': 'Find a command', style: 'width:100%' }) as HTMLInputElement;
  const table = h('div', { style: 'max-height:60vh;overflow:auto;margin-top:8px' });
  const draw = () => {
    clear(table);
    const q = input.value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const cmds = allCommands().filter((c) => !terms.length || terms.every((t) => `${c.label} ${c.id} ${c.keywords || ''}`.toLowerCase().includes(t)))
      .filter((c) => maps.some((m) => m.has(c.id)) || ribbon.has(c.id)).sort((a, b) => a.label.localeCompare(b.label)).slice(0, 150);
    if (!cmds.length) { table.appendChild(h('p', { class: 'ql-help' }, 'No command in the menus matches.')); return; }
    const head = h('tr', null, h('th', null, 'Command'), h('th', null, 'Ribbon'), ...LAYOUTS.map((l) => h('th', null, CLASSIC_LAYOUT_NAMES[l] || l)));
    const rows = cmds.map((c) => h('tr', null,
      h('td', null, h('button', { class: 'ql-link', title: `Run ${c.label}`, onclick: () => { closeDlg?.(); void app.exec(c.id); } }, c.label), c.keys?.[0] ? h('div', { class: 'ql-help' }, prettyKey(c.keys[0])) : null),
      h('td', null, (ribbon.get(c.id) || ['—']).join('; ')),
      ...maps.map((m) => h('td', null, (m.get(c.id) || ['—']).join('; ')))));
    table.appendChild(h('table', { class: 'ql-stats ql-menumap' }, h('thead', null, head), h('tbody', null, ...rows)));
    if (cmds.length === 150) table.appendChild(h('p', { class: 'ql-help' }, 'Showing the first 150; type more of the name to narrow the list.'));
  };
  input.addEventListener('input', draw);
  let closeDlg: (() => void) | null = null;
  draw();
  await openDialog({ title: 'Where Is It? (Menu Map)', full: true, ok: 'Close', cancel: false, help: 'Where each command is on the ribbon and in each classic menu layout (View ▸ Menus switches layouts). Select a command name to run it.',
    content: h('div', null, input, table), onOpen: (ctl) => { closeDlg = () => ctl.close(); setTimeout(() => input.focus(), 40); } });
}

// ---------------------------------------------------------------------------------------------
// Quick references

/** [element, description, category] */
export const HTML_REF: [string, string, string][] = [
  ['html', 'Root of the page; lang sets its language', 'Document'], ['head', 'Title, metadata, style sheets and scripts', 'Document'], ['title', 'Page title (browser tab, bookmarks, search results)', 'Document'],
  ['meta', 'Metadata: charset, viewport, description, keywords, refresh', 'Document'], ['link', 'Links a style sheet, icon, feed or preload', 'Document'], ['style', 'CSS rules inside the page', 'Document'],
  ['script', 'JavaScript, inline or from src (type="module", defer, async)', 'Document'], ['noscript', 'Content shown when scripts are off', 'Document'], ['base', 'Base address and default target for links', 'Document'], ['body', 'Everything shown on the page', 'Document'],
  ['header', 'Introductory content or a page/section header', 'Sections'], ['nav', 'Main navigation links', 'Sections'], ['main', 'The main content (one per page)', 'Sections'], ['section', 'A thematic section, usually with a heading', 'Sections'],
  ['article', 'Self-contained content (post, card, comment)', 'Sections'], ['aside', 'Related content, sidebars, callouts', 'Sections'], ['footer', 'Footer of a page or section', 'Sections'], ['address', 'Contact information', 'Sections'],
  ['h1–h6', 'Headings, level 1 (most important) to 6', 'Sections'], ['hgroup', 'A heading with subtitles', 'Sections'], ['search', 'A search or filtering area', 'Sections'],
  ['div', 'Generic block container (style with CSS)', 'Grouping'], ['p', 'Paragraph', 'Grouping'], ['hr', 'Thematic break (horizontal line)', 'Grouping'], ['pre', 'Preformatted text (spacing kept)', 'Grouping'],
  ['blockquote', 'Quotation from another source (cite)', 'Grouping'], ['ol', 'Numbered list (start, reversed, type)', 'Grouping'], ['ul', 'Bulleted list', 'Grouping'], ['li', 'List item', 'Grouping'],
  ['dl', 'Description list', 'Grouping'], ['dt', 'Term in a description list', 'Grouping'], ['dd', 'Description of a term', 'Grouping'], ['figure', 'Self-contained figure (picture, code, chart)', 'Grouping'], ['figcaption', 'Caption of a figure', 'Grouping'],
  ['a', 'Hyperlink (href, target, rel, download)', 'Text'], ['em', 'Stress emphasis (italic)', 'Text'], ['strong', 'Strong importance (bold)', 'Text'], ['small', 'Side comments, fine print', 'Text'], ['s', 'No longer accurate (strikethrough)', 'Text'],
  ['cite', 'Title of a work', 'Text'], ['q', 'Short inline quotation', 'Text'], ['dfn', 'Defining instance of a term', 'Text'], ['abbr', 'Abbreviation (title gives the expansion)', 'Text'], ['time', 'Date or time (datetime)', 'Text'],
  ['code', 'Computer code', 'Text'], ['var', 'Variable', 'Text'], ['samp', 'Sample program output', 'Text'], ['kbd', 'Keyboard input', 'Text'], ['sub', 'Subscript', 'Text'], ['sup', 'Superscript', 'Text'],
  ['i', 'Alternate voice, terms, names (italic)', 'Text'], ['b', 'Keywords drawn attention to (bold)', 'Text'], ['u', 'Unarticulated annotation (underline)', 'Text'], ['mark', 'Highlighted text', 'Text'], ['bdi', 'Isolated text direction', 'Text'],
  ['span', 'Generic inline container', 'Text'], ['br', 'Line break', 'Text'], ['wbr', 'Optional line-break opportunity', 'Text'], ['ins', 'Inserted text', 'Edits'], ['del', 'Deleted text', 'Edits'],
  ['img', 'Picture (src, alt, width, height, srcset, sizes, loading)', 'Media'], ['picture', 'Alternative picture sources by size or format', 'Media'], ['source', 'Media source for picture, video, audio', 'Media'],
  ['video', 'Video (controls, autoplay, muted, loop, poster)', 'Media'], ['audio', 'Sound (controls, autoplay, loop)', 'Media'], ['track', 'Captions or subtitles for video', 'Media'], ['iframe', 'Another page inside this one (src, title, loading, sandbox)', 'Media'],
  ['embed', 'External content (plug-ins)', 'Media'], ['object', 'External resource', 'Media'], ['canvas', 'Bitmap drawing surface for scripts', 'Media'], ['svg', 'Vector graphics', 'Media'], ['map', 'Image map', 'Media'], ['area', 'Hotspot in an image map', 'Media'],
  ['table', 'Table of data', 'Tables'], ['caption', 'Table title', 'Tables'], ['thead', 'Header rows', 'Tables'], ['tbody', 'Body rows', 'Tables'], ['tfoot', 'Footer rows', 'Tables'], ['tr', 'Table row', 'Tables'],
  ['th', 'Header cell (scope, colspan, rowspan)', 'Tables'], ['td', 'Data cell (colspan, rowspan)', 'Tables'], ['colgroup', 'Group of columns', 'Tables'], ['col', 'Column properties', 'Tables'],
  ['form', 'Form (action, method, enctype)', 'Forms'], ['label', 'Caption for a form control (for)', 'Forms'], ['input', 'Field: text, email, number, date, checkbox, radio, file, submit…', 'Forms'], ['button', 'Push button (type submit/reset/button)', 'Forms'],
  ['select', 'Drop-down or list box', 'Forms'], ['option', 'Choice in a select', 'Forms'], ['optgroup', 'Group of choices', 'Forms'], ['datalist', 'Suggestions for an input', 'Forms'], ['textarea', 'Multi-line text field', 'Forms'],
  ['fieldset', 'Group of controls', 'Forms'], ['legend', 'Caption of a fieldset', 'Forms'], ['output', 'Result of a calculation', 'Forms'], ['progress', 'Progress bar', 'Forms'], ['meter', 'Gauge within a known range', 'Forms'],
  ['details', 'Disclosure widget (open)', 'Interactive'], ['summary', 'Visible heading of details', 'Interactive'], ['dialog', 'Dialog box or modal (open)', 'Interactive'], ['template', 'Inert markup for scripts to clone', 'Interactive'], ['slot', 'Placeholder inside a web component', 'Interactive'],
  ['frameset', 'Frames layout (obsolete in HTML5)', 'Obsolete'], ['frame', 'One frame of a frameset (obsolete)', 'Obsolete'], ['font', 'Font face/size/color (obsolete; use CSS)', 'Obsolete'], ['center', 'Centered block (obsolete; use CSS)', 'Obsolete'], ['marquee', 'Scrolling text (obsolete)', 'Obsolete'],
];

/** [property, values, description, category] */
export const CSS_REF: [string, string, string, string][] = [
  ['color', '#rgb, rgb(), hsl(), name', 'Text color', 'Text'], ['font-family', 'family names, serif, sans-serif, monospace, system-ui', 'Typeface list', 'Text'], ['font-size', 'px, em, rem, %, small…large, clamp()', 'Text size', 'Text'],
  ['font-weight', 'normal, bold, 100–900', 'Boldness', 'Text'], ['font-style', 'normal, italic, oblique', 'Italic', 'Text'], ['font', 'style weight size/line-height family', 'Shorthand for font properties', 'Text'],
  ['line-height', 'normal, number, length', 'Space between lines', 'Text'], ['letter-spacing', 'normal, length', 'Space between letters', 'Text'], ['word-spacing', 'normal, length', 'Space between words', 'Text'],
  ['text-align', 'left, right, center, justify, start, end', 'Horizontal alignment', 'Text'], ['text-decoration', 'none, underline, line-through, overline', 'Lines on text', 'Text'], ['text-transform', 'none, uppercase, lowercase, capitalize', 'Letter case', 'Text'],
  ['text-indent', 'length, %', 'First-line indent', 'Text'], ['text-shadow', 'x y blur color', 'Shadow behind text', 'Text'], ['white-space', 'normal, nowrap, pre, pre-wrap, pre-line', 'Spaces and wrapping', 'Text'],
  ['word-break', 'normal, break-all, keep-all', 'Line breaks inside words', 'Text'], ['overflow-wrap', 'normal, anywhere, break-word', 'Wrap long words', 'Text'], ['text-overflow', 'clip, ellipsis', 'Clipped text marker', 'Text'],
  ['vertical-align', 'baseline, top, middle, bottom, sub, super', 'Inline/table-cell vertical alignment', 'Text'], ['direction', 'ltr, rtl', 'Text direction', 'Text'], ['hyphens', 'none, manual, auto', 'Hyphenation', 'Text'],
  ['background-color', 'color', 'Background color', 'Background'], ['background-image', 'url(), linear-gradient(), radial-gradient()', 'Background pictures or gradients', 'Background'],
  ['background-repeat', 'repeat, no-repeat, repeat-x, repeat-y, space, round', 'Tiling', 'Background'], ['background-position', 'left/center/right top/center/bottom, length', 'Where the picture starts', 'Background'],
  ['background-size', 'auto, cover, contain, length', 'Picture size', 'Background'], ['background-attachment', 'scroll, fixed, local', 'Scrolls with the page or not', 'Background'], ['background', 'color image repeat position/size', 'Shorthand', 'Background'],
  ['opacity', '0–1', 'Transparency of the whole element', 'Background'],
  ['margin', '1–4 lengths, auto', 'Space outside the border', 'Box'], ['padding', '1–4 lengths', 'Space inside the border', 'Box'], ['border', 'width style color', 'Border shorthand', 'Box'],
  ['border-width', 'thin, medium, thick, length', 'Border thickness', 'Box'], ['border-style', 'none, solid, dashed, dotted, double, groove, ridge, inset, outset', 'Border line', 'Box'], ['border-color', 'color', 'Border color', 'Box'],
  ['border-radius', 'length, %', 'Rounded corners', 'Box'], ['box-shadow', 'x y blur spread color, inset', 'Shadow around the box', 'Box'], ['outline', 'width style color', 'Line outside the border (focus rings)', 'Box'],
  ['width', 'auto, length, %, min-content, max-content, fit-content', 'Width of the content box', 'Box'], ['height', 'auto, length, %', 'Height', 'Box'], ['min-width', 'length, %', 'Smallest width', 'Box'], ['max-width', 'none, length, %', 'Largest width', 'Box'],
  ['min-height', 'length, %, vh', 'Smallest height', 'Box'], ['max-height', 'none, length, %', 'Largest height', 'Box'], ['box-sizing', 'content-box, border-box', 'Whether width includes padding and border', 'Box'],
  ['aspect-ratio', 'auto, 16 / 9', 'Preferred width-to-height ratio', 'Box'], ['overflow', 'visible, hidden, scroll, auto, clip', 'What happens to content that does not fit', 'Box'],
  ['display', 'block, inline, inline-block, flex, grid, none, contents, table', 'How the element is laid out', 'Layout'], ['visibility', 'visible, hidden, collapse', 'Hide without removing from layout', 'Layout'],
  ['position', 'static, relative, absolute, fixed, sticky', 'Positioning scheme', 'Layout'], ['top / right / bottom / left', 'auto, length, %', 'Offsets of a positioned element', 'Layout'], ['inset', '1–4 lengths', 'Shorthand for top/right/bottom/left', 'Layout'],
  ['z-index', 'auto, integer', 'Stacking order of positioned elements', 'Layout'], ['float', 'none, left, right', 'Float beside following content', 'Layout'], ['clear', 'none, left, right, both', 'Move below floats', 'Layout'],
  ['flex-direction', 'row, row-reverse, column, column-reverse', 'Main axis of a flex container', 'Flexbox'], ['flex-wrap', 'nowrap, wrap, wrap-reverse', 'Wrap flex items', 'Flexbox'], ['flex', 'grow shrink basis', 'How a flex item grows and shrinks', 'Flexbox'],
  ['justify-content', 'flex-start, center, flex-end, space-between, space-around, space-evenly', 'Alignment on the main axis', 'Flexbox'], ['align-items', 'stretch, flex-start, center, flex-end, baseline', 'Alignment on the cross axis', 'Flexbox'],
  ['align-self', 'auto, stretch, center, flex-start, flex-end', 'Cross-axis alignment of one item', 'Flexbox'], ['align-content', 'stretch, center, space-between…', 'Alignment of wrapped lines', 'Flexbox'], ['order', 'integer', 'Visual order of an item', 'Flexbox'], ['gap', 'row-gap column-gap', 'Space between flex or grid items', 'Flexbox'],
  ['grid-template-columns', 'repeat(3, 1fr), 200px auto, minmax()', 'Column tracks', 'Grid'], ['grid-template-rows', 'track sizes', 'Row tracks', 'Grid'], ['grid-template-areas', '"head head" "nav main"', 'Named areas', 'Grid'],
  ['grid-column', 'start / end, span n', 'Columns an item spans', 'Grid'], ['grid-row', 'start / end, span n', 'Rows an item spans', 'Grid'], ['grid-area', 'name or row/column lines', 'Place an item in an area', 'Grid'],
  ['grid-auto-flow', 'row, column, dense', 'How auto-placed items fill the grid', 'Grid'], ['place-items', 'align justify', 'Align items in their cells', 'Grid'],
  ['list-style', 'type position image', 'List markers', 'Lists & Tables'], ['list-style-type', 'disc, circle, square, decimal, lower-alpha, upper-roman, none', 'Marker style', 'Lists & Tables'],
  ['border-collapse', 'separate, collapse', 'Shared or separate table borders', 'Lists & Tables'], ['border-spacing', 'length', 'Space between cells', 'Lists & Tables'], ['table-layout', 'auto, fixed', 'Column width algorithm', 'Lists & Tables'], ['caption-side', 'top, bottom', 'Caption position', 'Lists & Tables'],
  ['transition', 'property duration timing delay', 'Animate changes of a property', 'Effects'], ['animation', 'name duration timing iteration direction', 'Keyframe animation', 'Effects'],
  ['transform', 'translate(), rotate(), scale(), skew()', 'Move, rotate, scale', 'Effects'], ['transform-origin', 'x y', 'Point transforms pivot around', 'Effects'], ['filter', 'blur(), brightness(), grayscale(), drop-shadow()', 'Graphic effects', 'Effects'],
  ['backdrop-filter', 'blur() …', 'Effects on what is behind', 'Effects'], ['mix-blend-mode', 'normal, multiply, screen, overlay…', 'Blending with the backdrop', 'Effects'], ['clip-path', 'circle(), polygon(), inset()', 'Clip to a shape', 'Effects'],
  ['cursor', 'auto, pointer, text, move, not-allowed, grab', 'Mouse pointer', 'Interaction'], ['pointer-events', 'auto, none', 'Whether the element receives clicks', 'Interaction'], ['user-select', 'auto, none, text, all', 'Whether text can be selected', 'Interaction'],
  ['scroll-behavior', 'auto, smooth', 'Smooth scrolling to anchors', 'Interaction'], ['resize', 'none, both, horizontal, vertical', 'User-resizable boxes', 'Interaction'], ['accent-color', 'color', 'Color of checkboxes, radios, ranges', 'Interaction'],
  ['object-fit', 'fill, contain, cover, none, scale-down', 'How a picture fills its box', 'Media'], ['object-position', 'x y', 'Picture position inside its box', 'Media'],
  ['content', '"text", attr(), counter()', 'Generated content for ::before/::after', 'Generated'], ['counter-reset / counter-increment', 'name number', 'Automatic numbering', 'Generated'],
  ['--name (custom property)', 'any value; use var(--name)', 'CSS variables', 'Other'], ['@media', '(min-width: 768px), print, (prefers-color-scheme: dark)', 'Rules for some devices or conditions', 'Other'],
  ['@font-face', 'font-family, src: url() format()', 'Web fonts', 'Other'], ['@import', 'url() media', 'Import another style sheet', 'Other'], ['@keyframes', 'name { from {} to {} }', 'Animation steps', 'Other'], ['@container', '(min-width: 400px)', 'Rules by container size', 'Other'],
  ['page-break-before / break-before', 'auto, page, avoid', 'Page breaks when printing', 'Print'], ['break-inside', 'auto, avoid', 'Keep a block on one page', 'Print'], ['@page', 'size, margin', 'Printed page box', 'Print'],
];

function refDialog(title: string, help: string, cols: string[], rows: string[][], catCol: number): Promise<unknown> {
  const cats = ['All', ...new Set(rows.map((r) => r[catCol]))];
  const input = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search the reference', style: 'flex:1' }) as HTMLInputElement;
  const sel = h('select', { 'aria-label': 'Category' }, ...cats.map((c) => h('option', { value: c }, c))) as HTMLSelectElement;
  const body = h('div', { style: 'max-height:60vh;overflow:auto;margin-top:8px' });
  const draw = () => {
    clear(body);
    const q = input.value.trim().toLowerCase();
    const list = rows.filter((r) => (sel.value === 'All' || r[catCol] === sel.value) && (!q || r.join(' ').toLowerCase().includes(q)));
    if (!list.length) { body.appendChild(h('p', { class: 'ql-help' }, 'Nothing matches.')); return; }
    body.appendChild(h('table', { class: 'ql-stats ql-ref' }, h('thead', null, h('tr', null, ...cols.map((c) => h('th', null, c)))),
      h('tbody', null, ...list.map((r) => h('tr', null, ...r.map((c, i) => h('td', null, i === 0 ? h('code', null, c) : c)))))));
  };
  input.addEventListener('input', draw);
  sel.addEventListener('change', draw);
  draw();
  return openDialog({ title, wide: true, ok: 'Close', cancel: false, help, content: h('div', null, h('div', { style: 'display:flex;gap:8px' }, input, sel), body), onOpen: () => setTimeout(() => input.focus(), 40) });
}

async function showNotices(): Promise<void> {
  let text = '';
  try { const r = await fetch('./third-party-notices.txt'); if (r.ok) text = await r.text(); } catch { /* offline or not built */ }
  if (!text || /^\s*<!doctype/i.test(text)) { toast(`The notices file is part of release builds; see ${REPO} for the license list.`, { ms: 6000 }); return; }
  const pre = h('pre', { class: 'ql-notices', style: 'white-space:pre-wrap;max-height:60vh;overflow:auto;font-size:12px' }, text);
  await openDialog({ title: 'Third-Party Notices', wide: true, ok: 'Close', cancel: false, content: pre });
}

// ---------------------------------------------------------------------------------------------

def([
  {
    id: 'help.help', label: 'Help', icon: 'help', tab: 'Help', group: 'Help', keys: ['F1'], edits: false, noRecord: true,
    run: async () => {
      await openDialog({ title: 'Anne\'s Loom Help', wide: true, ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: [
        '<p><b>Every feature is a command.</b> Search for any of them with the magnifier in the title bar (Alt+Q), put them on the Quick Access Bar, your own tabs or keyboard shortcuts, or record them in macros.</p>',
        '<p><b>Sites:</b> File ▸ Open Site edits a folder in place (in the desktop app and Chromium-based browsers; other browsers read the folder and save the site as a .qlsite or ZIP file). The Folder List shows every file; renaming or moving a file updates the links to it.</p>',
        '<p><b>Views:</b> Design edits the page visually, Code edits its markup, Split shows both, and Preview runs the page\'s scripts in a sandbox. Preview in Browser (F12) opens the page in a new window.</p>',
        '<p><b>Menus:</b> use the ribbon, a classic menu bar laid out like the desktop web editors, or both (View ▸ Menus). Help ▸ Where Is It? shows where any command lives in each layout.</p>',
        '<p><b>Saving:</b> Ctrl+S saves the current file to the site folder or file; Save All saves every changed file. Until a site is saved, an unsaved copy is kept on this device (File ▸ Recover Unsaved Site).</p>',
        '<p><b>Publishing:</b> Site ▸ Publish copies the site to a folder, a ZIP, a WebDAV server, FTP (desktop app) or WordPress.</p>',
        `<p>Documentation: <a href="${REPO}#readme" target="_blank" rel="noopener">${REPO}</a></p>`,
      ].join('') }], buttons: [{ label: 'Open Online Documentation', onClick: () => void open(`${REPO}#readme`) }] });
    },
  },
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard', tab: 'Help', group: 'Help', edits: false, noRecord: true, run: (app) => app.ui.showShortcuts() },
  { id: 'help.commandReference', label: 'Command Reference', icon: 'menu_book', tab: 'Help', group: 'Help', edits: false, noRecord: true, tip: 'Every command, by tab, with its shortcut and where the idea comes from', run: (app) => app.ui.showCommandReference() },
  { id: 'help.menuMap', label: 'Where Is It? (Menu Map)', icon: 'map', tab: 'Help', group: 'Help', edits: false, noRecord: true, keywords: 'find command location classic menus expression frontpage dreamweaver composer', tip: 'Find where a command is on the ribbon and in each classic menu layout', run: (app) => menuMap(app) },
  { id: 'help.htmlReference', label: 'HTML Reference', icon: 'html', tab: 'Help', group: 'Reference', edits: false, noRecord: true, origin: 'Dreamweaver (Reference panel)', run: () => refDialog('HTML Reference', `${HTML_REF.length} common elements. Global attributes: id, class, style, title, lang, dir, hidden, tabindex, data-*, aria-*, role.`, ['Element', 'What it is for', 'Category'], HTML_REF, 2) },
  { id: 'help.cssReference', label: 'CSS Reference', icon: 'css', tab: 'Help', group: 'Reference', edits: false, noRecord: true, origin: 'Dreamweaver (Reference panel)', run: () => refDialog('CSS Reference', `${CSS_REF.length} common properties and rules. Every property also takes inherit, initial, unset and revert.`, ['Property', 'Values', 'What it does', 'Category'], CSS_REF, 3) },
  { id: 'help.tour', label: 'Tour', icon: 'tour', tab: 'Help', group: 'Help', edits: false, noRecord: true, run: (app) => app.ui.tour() },
  {
    id: 'help.whatsNew', label: "What's New", icon: 'new_releases', tab: 'Help', group: 'Help', edits: false, noRecord: true,
    run: async () => {
      await openDialog({ title: `What's New in Anne\'s Loom ${VERSION}`, ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: [
        '<ul>',
        '<li>Design, Split, Code and Preview views over the page source, which stays exactly as written outside the parts you change.</li>',
        '<li>Whole sites: folders, ZIP archives and .qlsite files, with link fix-up when files move, reports and publishing.</li>',
        '<li>Page templates (.dwt) and library items in both common marker styles.</li>',
        '<li>Imports from WordPress, Weebly, Wix, web templates and MHTML archives.</li>',
        '<li>Classic menu bars in four layouts beside the ribbon, and a menu map to find any command.</li>',
        '</ul>',
        `<p>The full change list is on the releases page.</p>`,
      ].join('') }], buttons: [{ label: 'Releases Page', onClick: () => void open(`${REPO}/releases`) }] });
    },
  },
  { id: 'help.feedback', label: 'Report a Problem / Feedback', icon: 'feedback', tab: 'Help', group: 'Help', edits: false, noRecord: true, tip: 'Open an issue on GitHub', run: () => open(`${REPO}/issues/new`) },
  {
    id: 'help.notices', label: 'Third-Party Notices', icon: 'gavel', tab: 'Help', group: 'Help', edits: false, noRecord: true,
    run: () => showNotices(),
  },
  {
    id: 'help.about', label: 'About Anne\'s Loom', icon: 'info', tab: 'Help', group: 'Help', edits: false, noRecord: true,
    run: async () => {
      await openDialog({ title: 'About Anne\'s Loom', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: `<p><b>Anne\'s Loom ${VERSION}</b> — an original, open-source web site editor with visual and code editing. Part of the Anne\'s Office suite (Anne\'s Pen, Anne\'s Grid, Anne\'s Stage, Anne\'s Post).</p><p>${commandCount()} commands, every one placeable on the Quick Access Bar, a tab, a shortcut or a macro.</p><p>MIT License. Copyright © 2026 Paul D Pruitt. Not affiliated with Microsoft, Adobe, Mozilla, WordPress, Weebly or Wix; product names are used only to describe compatibility and the origin of features.</p><p><a href="${REPO}" target="_blank" rel="noopener">${REPO}</a></p>` }],
        buttons: [{ label: 'Third-Party Notices', onClick: (_v, ctl) => { ctl.close(); void showNotices(); } }] });
    },
  },
]);
