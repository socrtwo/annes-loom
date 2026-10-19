/**
 * Insert panes: the Toolbox (every insertable tag, form control, media type and component, by category;
 * click to insert) and Snippets (a built-in library plus the user's own snippets, stored on this device).
 */
import type { App } from '../app';
import { registerPane, sigOf, typingIn } from './panes';
import { h, icon, clear } from './dom';
import { openDialog, confirmDialog, toast } from './dialog';
import { getCommand } from '../commands/registry';
import { BUILTIN_SNIPPETS, type Snippet } from '../editor/components';

// ------------------------------------------------------------------------------------------
// Snippet storage

export const SNIPPETS_KEY = 'quillloom.snippets';
let snippetVersion = 0;

export function userSnippets(): Snippet[] {
  try {
    const v = JSON.parse(localStorage.getItem(SNIPPETS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((s) => s && typeof s.body === 'string').map((s) => ({ id: String(s.id), name: String(s.name || 'Snippet'), category: String(s.category || 'My Snippets'), body: s.body, user: true })) : [];
  } catch { return []; }
}
export function saveUserSnippets(list: Snippet[]): void {
  try { localStorage.setItem(SNIPPETS_KEY, JSON.stringify(list.map(({ id, name, category, body }) => ({ id, name, category, body })))); } catch { toast('Could not save snippets on this device.'); }
  snippetVersion++;
}
export function allSnippets(): Snippet[] { return [...userSnippets(), ...BUILTIN_SNIPPETS]; }

async function editSnippet(app: App, s: Partial<Snippet> | null): Promise<void> {
  const cats = [...new Set(allSnippets().map((x) => x.category))];
  const v = await openDialog({
    title: s?.id && s.user ? 'Edit Snippet' : 'New Snippet', wide: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: s?.name || '', autofocus: true },
      { key: 'category', label: 'Category', type: 'combo', value: s?.category && s.user ? s.category : 'My Snippets', options: cats },
      { key: 'body', label: 'Markup', type: 'textarea', rows: 12, value: s?.body || '' },
    ],
    validate: (x) => (!x.name?.trim() ? 'Give the snippet a name.' : !x.body ? 'The snippet is empty.' : null),
  });
  if (!v) return;
  const list = userSnippets();
  if (s?.id && s.user) {
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list[i] = { ...list[i], name: v.name.trim(), category: v.category || 'My Snippets', body: v.body };
  } else list.unshift({ id: `u${Date.now().toString(36)}`, name: v.name.trim(), category: v.category || 'My Snippets', body: v.body, user: true });
  saveUserSnippets(list);
  app.refresh();
}

// ------------------------------------------------------------------------------------------
// Toolbox

export interface ToolItem { id: string; arg?: any; label?: string; icon?: string }
export const TOOLBOX: { title: string; items: (string | ToolItem)[] }[] = [
  { title: 'Tags', items: ['insert.paragraph', 'insert.h1', 'insert.h2', 'insert.h3', 'insert.h4', 'insert.h5', 'insert.h6', 'insert.div', 'insert.span', 'insert.section', 'insert.article', 'insert.aside', 'insert.header', 'insert.footer', 'insert.nav', 'insert.main', 'insert.figure', 'insert.details', 'insert.dialog', 'insert.blockquote', 'insert.pre', 'insert.address', 'insert.ul', 'insert.ol', 'insert.dl', 'insert.hr', 'insert.br', 'insert.hyperlink', 'insert.bookmark', 'insert.image', 'table.insert', 'insert.iframe', 'insert.layer', 'insert.comment', 'insert.tag'] },
  { title: 'Text', items: ['insert.abbr', 'insert.cite', 'insert.code', 'insert.dfn', 'insert.kbd', 'insert.samp', 'insert.var', 'insert.q', 'insert.mark', 'insert.small', 'insert.sub', 'insert.sup', 'insert.time', 'insert.del', 'insert.ins', 'insert.symbol', 'insert.emoji', 'insert.nbsp', 'insert.dateTime'] },
  { title: 'Layout', items: ['insert.fluidGrid', 'insert.columns', 'insert.flexRow', 'insert.gridLayout'] },
  { title: 'Form Controls', items: ['form.form', 'form.textbox', 'form.textarea', 'form.password', 'form.email', 'form.tel', 'form.url', 'form.number', 'form.range', 'form.date', 'form.time', 'form.color', 'form.search', 'form.file', 'form.checkbox', 'form.radio', 'form.select', 'form.listBox', 'form.datalist', 'form.button', 'form.submit', 'form.reset', 'form.imageButton', 'form.hidden', 'form.label', 'form.fieldset', 'form.output', 'form.progress', 'form.meter'] },
  { title: 'Media', items: ['insert.image', 'insert.picture', 'insert.pictureElement', 'insert.imagePlaceholder', 'insert.imageMap', 'insert.rolloverImage', 'insert.interactiveButton', 'insert.clipArt', 'insert.shape', 'insert.decorativeText', 'insert.video', 'insert.audio', 'insert.youtube', 'insert.vimeo', 'insert.map', 'insert.svg', 'insert.canvas', 'insert.math'] },
  { title: 'Components', items: ['insert.navbar', 'insert.linkBar', 'insert.breadcrumbs', 'insert.tocSite', 'insert.tocPage', 'insert.hero', 'insert.cards', 'insert.pricingTable', 'insert.testimonials', 'insert.timeline', 'insert.carousel', 'insert.tabs', 'insert.accordion', 'insert.modal', 'insert.lightbox', 'insert.photoGallery', 'insert.contactForm', 'insert.feedbackForm', 'insert.newsletterForm', 'insert.searchForm', 'insert.socialLinks', 'insert.shareButtons', 'insert.cookieBanner', 'insert.backToTop', 'insert.countdown', 'insert.marquee', 'insert.pageBanner', 'insert.includePage', 'insert.substitution', 'insert.lastUpdated', 'insert.hitCounter', 'insert.rssFeed'] },
  { title: 'Head', items: ['insert.meta', 'insert.metaDescription', 'insert.metaViewport', 'insert.linkTag', 'insert.favicon', 'insert.openGraph', 'insert.jsonLd', 'insert.canonical', 'insert.googleFont', 'insert.analytics'] },
  { title: 'Script and Server', items: ['insert.script', 'insert.scriptFile', 'insert.noscript', 'insert.template', 'insert.phpBlock', 'insert.phpEcho', 'insert.phpInclude', 'insert.phpIf', 'insert.phpForeach', 'insert.ssi', 'insert.aspBlock', 'insert.jspBlock', 'insert.handlebars', 'insert.liquid'] },
];

const collapsed = new Set<string>();
let toolFilter = '';

function toolRow(app: App, it: string | ToolItem): HTMLElement | null {
  const item: ToolItem = typeof it === 'string' ? { id: it } : it;
  const c = getCommand(item.id);
  if (!c) return null;
  const label = item.label || c.label;
  if (toolFilter && !`${label} ${c.keywords || ''} ${c.id}`.toLowerCase().includes(toolFilter)) return null;
  const enabled = !c.isEnabled || c.isEnabled(app);
  const run = () => { if (enabled) { app.exec(item.id, item.arg); setTimeout(() => app.focus(), 0); } };
  const row = h('div', { class: 'ql-tree-row' + (enabled ? '' : ' ql-dim'), role: 'button', tabindex: '0', title: c.tip || label, 'aria-disabled': enabled ? null : 'true', draggable: 'true', style: 'padding-left:14px' }, icon(item.icon || c.icon || 'code'), h('span', { class: 'ql-tree-name' }, label));
  row.addEventListener('click', run);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } });
  row.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/x-ql-command', JSON.stringify({ id: item.id, arg: item.arg })); e.dataTransfer?.setData('text/plain', label); });
  return row;
}

registerPane({
  id: 'toolbox', title: 'Toolbox', side: 'right',
  render(app, el) {
    clear(el);
    const search = h('input', { type: 'search', placeholder: 'Find a tag or component', 'aria-label': 'Find in Toolbox', value: toolFilter }) as HTMLInputElement;
    const list = h('div', { class: 'ql-toolbox', role: 'list' });
    search.addEventListener('input', () => { toolFilter = search.value.trim().toLowerCase(); list.dataset.sig = ''; this.update!(app, list, {}); });
    el.append(search, list);
    this.update!(app, list, {});
  },
  update(app, el) {
    const list = el.classList.contains('ql-toolbox') ? el : el.querySelector<HTMLElement>('.ql-toolbox');
    if (!list) return;
    const sig = `${app.active?.kind}:${app.active?.ui?.target}:${toolFilter}:${[...collapsed].join('|')}:${app.isReadOnly()}`;
    if (!sigOf(list, sig) || typingIn(list)) return;
    clear(list);
    for (const cat of TOOLBOX) {
      const rows = cat.items.map((x) => toolRow(app, x)).filter(Boolean) as HTMLElement[];
      if (!rows.length) continue;
      const open = toolFilter ? true : !collapsed.has(cat.title);
      const head = h('button', { class: 'ql-pane-h ql-link', type: 'button', 'aria-expanded': String(open), style: 'width:100%;text-align:left;background:none;border:0;cursor:pointer' }, icon(open ? 'expand_more' : 'chevron_right'), h('strong', null, cat.title), h('span', { class: 'ql-dim' }, ` (${rows.length})`));
      head.addEventListener('click', () => { if (collapsed.has(cat.title)) collapsed.delete(cat.title); else collapsed.add(cat.title); list.dataset.sig = ''; this.update!(app, list, {}); });
      list.appendChild(head);
      if (open) for (const r of rows) list.appendChild(r);
    }
    if (!list.children.length) list.appendChild(h('p', { class: 'ql-help' }, 'Nothing matches.'));
  },
});

// ------------------------------------------------------------------------------------------
// Snippets

let snipFilter = '';

registerPane({
  id: 'snippets', title: 'Snippets', side: 'right',
  render(app, el) {
    clear(el);
    const search = h('input', { type: 'search', placeholder: 'Find a snippet', 'aria-label': 'Find a snippet', value: snipFilter }) as HTMLInputElement;
    const list = h('div', { class: 'ql-snippets', role: 'list' });
    search.addEventListener('input', () => { snipFilter = search.value.trim().toLowerCase(); list.dataset.sig = ''; this.update!(app, list, {}); });
    const tools = h('div', { class: 'ql-pane-actions' },
      h('button', { class: 'ql-btn', type: 'button', onclick: async () => {
        const v = app.active?.ui;
        const body = v ? (v.target === 'code' ? v.code?.selection.text : v.design?.selectedHtml()) : '';
        if (!body) { toast('Select something on the page first.'); return; }
        await editSnippet(app, { body });
        list.dataset.sig = ''; this.update!(app, list, {});
      } }, icon('add'), ' From Selection'),
      h('button', { class: 'ql-btn', type: 'button', onclick: async () => { await editSnippet(app, null); list.dataset.sig = ''; this.update!(app, list, {}); } }, icon('note_add'), ' New'));
    el.append(tools, search, list);
    this.update!(app, list, {});
  },
  update(app, el) {
    const list = el.classList.contains('ql-snippets') ? el : el.querySelector<HTMLElement>('.ql-snippets');
    if (!list) return;
    const sig = `${snippetVersion}:${snipFilter}:${app.active?.kind}`;
    if (!sigOf(list, sig) || typingIn(list)) return;
    clear(list);
    const all = allSnippets().filter((s) => !snipFilter || `${s.name} ${s.category} ${s.body}`.toLowerCase().includes(snipFilter));
    const cats = [...new Set(all.map((s) => s.category))];
    for (const cat of cats) {
      list.appendChild(h('div', { class: 'ql-pane-h' }, icon('folder'), h('strong', null, cat)));
      for (const s of all.filter((x) => x.category === cat)) {
        const ins = () => { app.exec('insert.snippet', s.id); setTimeout(() => app.focus(), 0); };
        const row = h('div', { class: 'ql-tree-row', role: 'listitem', style: 'padding-left:14px' },
          h('button', { class: 'ql-link', type: 'button', title: s.body.slice(0, 300), style: 'flex:1;text-align:left;background:none;border:0;cursor:pointer;padding:0', onclick: ins }, icon('content_paste_go'), ' ', s.name),
          h('button', { class: 'ql-iconbtn ql-sm', type: 'button', title: s.user ? 'Edit' : 'Copy to my snippets and edit', 'aria-label': `Edit ${s.name}`, onclick: async () => { await editSnippet(app, s.user ? s : { name: s.name + ' (copy)', body: s.body }); list.dataset.sig = ''; this.update!(app, list, {}); } }, icon('edit')),
          s.user ? h('button', { class: 'ql-iconbtn ql-sm', type: 'button', title: 'Delete', 'aria-label': `Delete ${s.name}`, onclick: async () => {
            if (!(await confirmDialog('Delete Snippet', `Delete the snippet "${s.name}"?`, 'Delete'))) return;
            saveUserSnippets(userSnippets().filter((x) => x.id !== s.id));
            list.dataset.sig = ''; this.update!(app, list, {});
          } }, icon('delete')) : null);
        row.setAttribute('draggable', 'true');
        row.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/html', s.body); e.dataTransfer?.setData('text/plain', s.body); });
        list.appendChild(row);
      }
    }
    if (!all.length) list.appendChild(h('p', { class: 'ql-help' }, snipFilter ? 'No snippets match.' : 'No snippets yet.'));
  },
});
