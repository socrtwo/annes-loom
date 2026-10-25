/**
 * Insert commands, part 3: web components (FrontPage-style site components and modern builder blocks)
 * and front-end frameworks. Each component is self-contained: markup at the cursor plus a CSS block added
 * once to the page head; scripts are small, vanilla and only where a feature needs one.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, type Field } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { insertHtml, selectionHtml, selectionText } from '../editor/ops';
import { esc, escAttr, getTitle, headInsert, regions, addStylesheet } from '../model/html';
import { isImagePath, isPagePath, relativeRef, stripExt } from '../model/paths';
import { defaultNav, pageTitle, type NavNode } from '../model/site';
import { expandIncludes } from '../site/templates';
import { regenerateLinkBars } from '../site/reports';
import {
  type NavItem, type GalleryLayout, type Plan, marquee, hitCounter, photoGallery, linkBar, breadcrumbs, siteMap, addHeadingIds, pageToc, pageBanner, includeWebbot,
  scheduled, substitution, lastUpdated, searchForm, feedbackForm, contactForm, newsletterForm, SOCIAL_NETWORKS, socialLinks, shareButtons, cookieBanner, backToTop,
  carousel, tabs, accordion, modal, lightbox, navbar, pricingTable, testimonials, hero, cards, timeline, countdown, rssLink, FRAMEWORKS, GOOGLE_FONTS, googleFontTags,
  analyticsSnippet, type AnalyticsKind, ensureCss, headOnce, bodyEndInsert, imageMarkup, ssi, DATE_FORMATS, formatDate, type FormOpts, type Component,
} from '../editor/components';
import { cmds, insertComponent, insertRaw, fileFields, imageSize, uploadToSite, rel, IMAGE_ACCEPT } from './insert';

// ------------------------------------------------------------------------------------------
// Navigation helpers

/** Rewrites the page's link bars from the navigation structure (keeps them in step with Site > Navigation). */
function regenerate(app: App): void {
  try { app.active.ui.flush(); regenerateLinkBars(app.site, [app.active.path]); } catch (e) { console.warn(e); }
}

const navTree = (app: App): NavNode => app.site.data.nav || defaultNav(app.site);
function chain(n: NavNode, path: string, acc: NavNode[] = []): NavNode[] | null {
  const here = [...acc, n];
  if (n.path === path) return here;
  for (const c of n.children) { const r = chain(c, path, here); if (r) return r; }
  return null;
}
const item = (app: App, n: NavNode): NavItem => ({ href: rel(app, n.path), label: n.label || pageTitle(app.site, n.path), current: n.path === app.active.path });
const toTree = (app: App, n: NavNode): NavItem => ({ ...item(app, n), children: n.children.map((c) => toTree(app, c)) });

export type LinkBarLevel = 'top' | 'children' | 'siblings' | 'parent' | 'backNext' | 'homeChildren';
export function linkBarItems(app: App, level: LinkBarLevel, o: { home?: boolean; parent?: boolean } = {}): NavItem[] {
  const root = navTree(app);
  const path = chain(root, app.active.path) || [root];
  const me = path[path.length - 1];
  const parent = path.length > 1 ? path[path.length - 2] : null;
  const grand = path.length > 2 ? path[path.length - 3] : null;
  let nodes: NavNode[];
  switch (level) {
    case 'children': nodes = me.children; break;
    case 'siblings': nodes = parent ? parent.children : [root]; break;
    case 'parent': nodes = grand ? grand.children : parent ? [parent] : []; break;
    case 'backNext': { const sib = parent?.children || []; const i = sib.indexOf(me); nodes = [sib[i - 1], sib[i + 1]].filter(Boolean); break; }
    case 'homeChildren': nodes = root.children; break;
    default: nodes = root.children;
  }
  const items = nodes.map((n) => item(app, n));
  if (level === 'backNext') { const sib = parent?.children || []; const i = sib.indexOf(me); if (sib[i - 1]) items[0].label = `Back: ${items[0].label}`; if (sib[i + 1]) items[items.length - 1].label = `Next: ${items[items.length - 1].label}`; }
  if (o.parent && parent && !nodes.includes(parent)) items.unshift({ ...item(app, parent), label: `Up: ${parent.label || pageTitle(app.site, parent.path)}` });
  if (o.home && !nodes.includes(root) && root.path !== app.active.path) items.unshift({ ...item(app, root), label: 'Home' });
  else if (o.home && !nodes.includes(root)) items.unshift({ ...item(app, root), label: 'Home' });
  return items;
}

// ------------------------------------------------------------------------------------------
// Forms

async function formOptions(app: App, title: string, arg: any, submit: string): Promise<FormOpts | null> {
  if (arg && typeof arg === 'object') return arg;
  const v = await openDialog({
    title, help: 'Static web hosts cannot process forms by themselves. Send the results by email (opens the visitor’s mail program), to a form service (paste the address it gives you), or to your own server script.',
    fields: [
      { key: 'mode', label: 'Send results to', type: 'radio', value: 'service', options: [{ value: 'service', label: 'A form service or server script (address)' }, { value: 'mailto', label: 'An email address' }] },
      { key: 'action', label: 'Form address', type: 'text', value: '', placeholder: 'https://formspree.io/f/your-id or contact.php', visibleIf: (x) => x.mode === 'service' },
      { key: 'email', label: 'Email address', type: 'text', value: app.site.data.meta?.email || '', placeholder: 'you@example.com', visibleIf: (x) => x.mode === 'mailto' },
      { key: 'title', label: 'Heading', type: 'text', value: '' },
      { key: 'submit', label: 'Button text', type: 'text', value: submit },
      { key: 'honeypot', label: 'Add a hidden spam-trap field (many form services support “_gotcha”)', type: 'checkbox', value: false, visibleIf: (x) => x.mode === 'service' },
    ],
  });
  if (!v) return null;
  return v.mode === 'mailto' ? { action: v.email ? `mailto:${v.email}` : '', mailto: true, submit: v.submit, title: v.title } : { action: v.action, method: 'post', submit: v.submit, title: v.title, honeypot: v.honeypot };
}

// ------------------------------------------------------------------------------------------
// Pictures for galleries

async function chooseImages(app: App, title: string): Promise<{ src: string; alt: string; caption: string; width: number | null; height: number | null }[] | null> {
  const opts = app.site.list((f) => isImagePath(f.path)).map((f) => ({ value: f.path, label: f.path }));
  let added: string[] = [];
  const v = await openDialog({
    title, wide: true,
    fields: [
      { key: 'paths', label: 'Pictures in the site (Ctrl/Shift to pick several)', type: 'list', multiple: true, rows: 10, options: opts, value: [] },
      {
        key: 'upload', label: 'Add pictures from this device…', type: 'button',
        onClick: async (_x, ctl) => {
          const files = await pickFile(IMAGE_ACCEPT, true);
          for (const f of files) added.push(await uploadToSite(app, f, 'images'));
          if (files.length) { ctl.set('paths', [...(ctl.get('paths') || []), ...added]); toast(`Added ${files.length} picture(s) to the images folder.`); }
        },
      },
    ],
    validate: (x) => ((x.paths?.length || added.length) ? null : 'Pick at least one picture.'),
  });
  if (!v) return null;
  const paths = [...new Set([...(v.paths || []), ...added])];
  const guess = (p: string) => stripExt(p.split('/').pop() || '').replace(/[-_]+/g, ' ').trim();
  let details: Record<string, any> | null = {};
  if (paths.length <= 24) {
    const fields: Field[] = paths.flatMap((p, i) => [
      { key: `h${i}`, label: p, type: 'heading' as const },
      { key: `alt${i}`, label: 'Alternate text', type: 'text' as const, value: guess(p), half: true },
      { key: `cap${i}`, label: 'Caption', type: 'text' as const, value: '', half: true },
    ]);
    details = await openDialog({ title: 'Describe the Pictures', help: 'Alternate text describes each picture for people who cannot see it.', wide: true, fields });
    if (!details) return null;
  }
  const out = [];
  for (const [i, p] of paths.entries()) {
    const src = rel(app, p);
    const s = await imageSize(app, src);
    out.push({ src, alt: details[`alt${i}`] ?? guess(p), caption: details[`cap${i}`] || '', width: s?.width ?? null, height: s?.height ?? null });
  }
  return out;
}

const lines = (s: string) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
const ins = (app: App, c: Component, label: string, extra?: (s: string) => string) => insertComponent(app, c, label, extra);

// ------------------------------------------------------------------------------------------
// Components

def(cmds('Web Components', 'FrontPage (Web Components), Expression Web, modern builders', [
  {
    id: 'insert.marquee', label: 'Scrolling Text', icon: 'text_rotation_none', origin: 'FrontPage (Marquee)', keywords: 'marquee ticker',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Scrolling Text', help: 'Moving text is hard to read for many people: it pauses on hover and stops for visitors who ask for reduced motion.',
        fields: [
          { key: 'text', label: 'Text', type: 'text', value: selectionText(app) || 'Scrolling text', autofocus: true },
          { key: 'seconds', label: 'Time to cross', type: 'range', value: 15, min: 3, max: 60, suffix: ' s' },
          { key: 'direction', label: 'Direction', type: 'select', value: 'left', options: [{ value: 'left', label: 'Right to left' }, { value: 'right', label: 'Left to right' }], half: true },
          { key: 'behavior', label: 'Behavior', type: 'select', value: 'scroll', options: [{ value: 'scroll', label: 'Scroll' }, { value: 'alternate', label: 'Back and forth' }], half: true },
          { key: 'legacy', label: 'Use the old <marquee> tag (obsolete, for old pages)', type: 'checkbox', value: false },
        ],
      });
      if (v) ins(app, marquee({ ...v, seconds: +v.seconds || 15 }), 'Insert Scrolling Text');
    },
  },
  {
    id: 'insert.hitCounter', label: 'Hit Counter', icon: 'pin', origin: 'FrontPage (Hit Counter)',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Hit Counter', help: 'FrontPage counters needed its server extensions. A static host cannot count visits, so this inserts a placeholder for a server script or a counting service to fill in. Privacy-friendly statistics are under Insert > Frameworks > Analytics.', fields: [{ key: 'label', label: 'Label', type: 'text', value: 'Visitors' }, { key: 'service', label: 'Counting service or script (a note in the source)', type: 'text', value: '' }] });
      if (v) insertRaw(app, hitCounter(v), 'Insert Hit Counter');
    },
  },
  {
    id: 'insert.photoGallery', label: 'Photo Gallery', icon: 'photo_library', popular: true, origin: 'FrontPage, Expression Web (Photo Gallery), modern builders',
    run: async (app, arg) => {
      const images = Array.isArray(arg?.images) ? arg.images : await chooseImages(app, 'Photo Gallery');
      if (!images?.length) return;
      const o = arg?.layout ? arg : await openDialog({
        title: 'Gallery Layout',
        fields: [
          { key: 'layout', label: 'Layout', type: 'radio', value: 'grid', options: [{ value: 'grid', label: 'Grid of equal thumbnails' }, { value: 'masonry', label: 'Columns of natural-height pictures' }, { value: 'slideshow', label: 'Slide show (swipe or scroll)' }] },
          { key: 'min', label: 'Thumbnail width', type: 'number', value: 200, suffix: 'px' },
          { key: 'lightbox', label: 'Show the full picture when clicked', type: 'checkbox', value: true },
          { key: 'captions', label: 'Show captions', type: 'checkbox', value: true },
        ],
      });
      if (!o) return;
      ins(app, photoGallery(images, { layout: o.layout as GalleryLayout, min: +o.min || undefined, lightbox: o.lightbox, captions: o.captions }), 'Insert Photo Gallery');
    },
  },
  {
    id: 'insert.linkBar', label: 'Link Bar', icon: 'menu_open', origin: 'FrontPage (Link Bar / Navigation Bar), Expression Web',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Link Bar', help: 'Links built from the site’s navigation structure (Site > Navigation).',
        fields: [
          { key: 'level', label: 'Links to', type: 'radio', value: 'top', options: [{ value: 'top', label: 'Top-level pages' }, { value: 'siblings', label: 'Pages at the same level' }, { value: 'children', label: 'Child pages of this page' }, { value: 'parent', label: 'Parent level' }, { value: 'backNext', label: 'Back and next' }] },
          { key: 'home', label: 'Add the home page', type: 'checkbox', value: true, half: true }, { key: 'parent', label: 'Add the parent page', type: 'checkbox', value: false, half: true },
          { key: 'orientation', label: 'Orientation', type: 'select', value: 'horizontal', options: [{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }] },
          { key: 'label', label: 'Label for screen readers', type: 'text', value: 'Site' },
        ],
      });
      if (!v) return;
      const items = linkBarItems(app, v.level, { home: v.home, parent: v.parent });
      if (!items.length) { toast('No pages at that level in the navigation structure. Add pages under Site > Navigation.'); return; }
      const mode = ({ top: 'top', siblings: 'siblings', children: 'children' } as Record<string, string>)[v.level];
      ins(app, linkBar(items, { orientation: v.orientation, label: v.label, mode, home: mode === 'top' ? !!v.home : mode === 'siblings' ? !!v.home : undefined, parent: mode === 'children' && v.parent }), 'Insert Link Bar');
      if (mode) regenerate(app);
    },
  },
  {
    id: 'insert.breadcrumbs', label: 'Breadcrumbs', icon: 'linear_scale', origin: 'Dreamweaver extensions, modern builders',
    run: (app) => {
      const c = chain(navTree(app), app.active.path);
      if (!c) { toast('This page is not in the navigation structure (Site > Navigation).'); return; }
      ins(app, breadcrumbs(c.map((n, i) => ({ ...item(app, n), label: i === 0 ? 'Home' : n.label || pageTitle(app.site, n.path) })), true), 'Insert Breadcrumbs');
      regenerate(app);
    },
  },
  {
    id: 'insert.tocSite', label: 'Site Map', icon: 'account_tree', origin: 'FrontPage (Table of Contents for this Web site)',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Site Map', fields: [{ key: 'from', label: 'List', type: 'radio', value: 'nav', options: [{ value: 'nav', label: 'The navigation structure' }, { value: 'all', label: 'Every page, alphabetically by title' }] }, { key: 'title', label: 'Label', type: 'text', value: 'Site map' }] });
      if (!v) return;
      const tree = v.from === 'all'
        ? app.site.pages().filter((f) => !/\.(dwt|lbi)$/i.test(f.path)).map((f) => ({ href: rel(app, f.path), label: pageTitle(app.site, f.path) })).sort((a, b) => a.label.localeCompare(b.label))
        : [toTree(app, navTree(app))];
      ins(app, siteMap(tree, v.title || 'Site map'), 'Insert Site Map');
    },
  },
  {
    id: 'insert.tocPage', label: 'Table of Contents', icon: 'toc', origin: 'FrontPage (Table of Contents), Word', keywords: 'toc headings contents',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Table of Contents', help: 'Links to the headings on this page. Headings without an id get one.', fields: [{ key: 'min', label: 'From heading level', type: 'select', value: '2', options: ['1', '2', '3'], half: true }, { key: 'max', label: 'To heading level', type: 'select', value: '3', options: ['2', '3', '4', '5', '6'], half: true }, { key: 'title', label: 'Title', type: 'text', value: 'Contents' }] });
      if (!v) return;
      const min = +v.min || 2, max = Math.max(min, +v.max || 3);
      app.active.ui.flush();
      const { headings } = addHeadingIds(app.active.source, min, max);
      if (!headings.length) { toast(`This page has no level ${min}–${max} headings yet.`); return; }
      ins(app, pageToc(headings, v.title || 'Contents'), 'Insert Table of Contents', (s) => addHeadingIds(s, min, max).src);
    },
  },
  {
    id: 'insert.pageBanner', label: 'Page Banner', icon: 'title', origin: 'FrontPage (Page Banner)',
    run: (app, arg) => insertHtml(app, pageBanner(typeof arg === 'string' ? arg : getTitle(app.active.source) || pageTitle(app.site, app.active.path))),
  },
  {
    id: 'insert.includePage', label: 'Include Page', icon: 'input', origin: 'FrontPage (Include Page), Expression Web, Dreamweaver (Server-Side Include)',
    run: async (app, arg) => {
      const pages = app.site.pages().filter((f) => f.path !== app.active.path).map((f) => f.path);
      if (!pages.length) { toast('Add another page to include first.'); return; }
      const v = arg || await openDialog({
        title: 'Include Page', help: 'Shows another page’s body content here, so a shared header or footer is edited in one place.',
        fields: [
          { key: 'path', label: 'Page', type: 'list', rows: 8, options: pages, value: pages.find((p) => /header|footer|nav|menu|include/i.test(p)) || pages[0] },
          { key: 'how', label: 'Include', type: 'radio', value: 'copy', options: [{ value: 'copy', label: 'A copy of the content, updated by Anne\'s Loom (works on any host)' }, { value: 'ssi', label: 'A server-side include (the web server inserts it; needs SSI, usually .shtml pages)' }] },
        ],
      });
      if (!v?.path) return;
      const marker = ssi.include('/' + v.path, true);
      if (v.how === 'ssi') { insertRaw(app, marker, 'Include Page'); return; }
      const content = expandIncludes(app.site, app.active.path, marker).trim();
      insertRaw(app, includeWebbot(relativeRef(app.active.path, v.path), `\n${content}\n`), 'Include Page');
    },
  },
  {
    id: 'insert.scheduledInclude', label: 'Scheduled Include', icon: 'event', origin: 'FrontPage (Scheduled Include Page)',
    run: async (app, arg) => {
      const pages = app.site.pages().filter((f) => f.path !== app.active.path).map((f) => f.path);
      const today = formatDate(new Date(), 'iso');
      const v = arg || await openDialog({
        title: 'Scheduled Include', help: 'Content shown only between two dates (checked in the visitor’s browser; without scripts it stays hidden).',
        fields: [
          { key: 'source', label: 'Content', type: 'radio', value: selectionHtml(app) ? 'sel' : pages.length ? 'page' : 'text', options: [...(selectionHtml(app) ? [{ value: 'sel', label: 'The selection' }] : []), ...(pages.length ? [{ value: 'page', label: 'A page' }] : []), { value: 'text', label: 'Text' }] },
          { key: 'path', label: 'Page', type: 'select', value: pages[0], options: pages, visibleIf: (x) => x.source === 'page' },
          { key: 'text', label: 'Text', type: 'textarea', rows: 3, value: '<p>Special announcement</p>', visibleIf: (x) => x.source === 'text' },
          { key: 'start', label: 'Starting', type: 'date', value: today, half: true }, { key: 'end', label: 'Ending', type: 'date', value: '', half: true },
          { key: 'otherwise', label: 'Shown at other times (optional)', type: 'textarea', rows: 2, value: '' },
        ],
      });
      if (!v) return;
      const content = v.source === 'sel' ? selectionHtml(app) : v.source === 'page' ? expandIncludes(app.site, app.active.path, ssi.include('/' + v.path)) : v.text;
      insertRaw(app, scheduled(content, v.start, v.end ? `${v.end}T23:59:59` : '', v.otherwise), 'Insert Scheduled Include');
    },
  },
  {
    id: 'insert.scheduledPicture', label: 'Scheduled Picture', icon: 'event_available', origin: 'FrontPage (Scheduled Picture)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Scheduled Picture', help: 'A picture shown only between two dates, with an optional picture for other times.',
        fields: [
          ...fileFields(app, 'src', 'Picture', { filter: isImagePath, accept: IMAGE_ACCEPT, dir: 'images' }),
          { key: 'alt', label: 'Alternate text', type: 'text', value: '' },
          ...fileFields(app, 'other', 'Picture at other times', { filter: isImagePath, accept: IMAGE_ACCEPT, dir: 'images', blank: true }),
          { key: 'start', label: 'Starting', type: 'date', value: formatDate(new Date(), 'iso'), half: true }, { key: 'end', label: 'Ending', type: 'date', value: '', half: true },
        ],
        validate: (x) => (!x.src ? 'Choose a picture.' : !x.alt?.trim() ? 'Describe the picture.' : null),
      });
      if (!v) return;
      insertRaw(app, scheduled(imageMarkup({ src: v.src, alt: v.alt }), v.start, v.end ? `${v.end}T23:59:59` : '', v.other ? imageMarkup({ src: v.other, alt: v.alt }) : ''), 'Insert Scheduled Picture');
    },
  },
  {
    id: 'insert.substitution', label: 'Site Variable', icon: 'data_array', origin: 'FrontPage (Substitution), Dreamweaver (Template parameters)',
    run: async (app, arg) => {
      const meta = app.site.data.meta || {};
      const builtIn: Record<string, string> = { 'site.name': app.site.name, 'page.title': getTitle(app.active.source), 'page.path': app.active.path, 'page.modified': formatDate(new Date(app.site.get(app.active.path)?.modified || Date.now()), 'long') };
      const vars = { ...builtIn, ...meta };
      const v = typeof arg === 'string' ? { name: arg } : arg || await openDialog({
        title: 'Site Variable', help: 'Inserts the value of a site variable. The span keeps the variable name so the value can be refreshed everywhere when it changes.',
        fields: [
          { key: 'name', label: 'Variable', type: 'combo', value: Object.keys(meta)[0] || 'site.name', options: Object.keys(vars), autofocus: true },
          { key: 'value', label: 'Value (a new variable is added to the site)', type: 'text', value: '' },
        ],
        onChange: (x, ctl, key) => { if (key === 'name' && x.name in vars) ctl.set('value', vars[x.name]); },
        onOpen: (ctl) => ctl.set('value', vars[ctl.get('name')] ?? ''),
      });
      if (!v?.name) return;
      const value = v.value ?? vars[v.name] ?? '';
      if (!(v.name in builtIn) && meta[v.name] !== value) { app.site.data.meta = { ...meta, [v.name]: value }; app.site.touchMeta(); }
      insertHtml(app, substitution(v.name, value));
    },
  },
  {
    id: 'insert.lastUpdated', label: 'Last Updated', icon: 'update', origin: 'FrontPage (Timestamp), Dreamweaver (Date: update on save)',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Last Updated', fields: [{ key: 'label', label: 'Label', type: 'text', value: 'Last updated' }, { key: 'date', label: 'Format', type: 'select', value: 'long', options: DATE_FORMATS.filter((f) => f.id !== 'none').map((f) => ({ value: f.id, label: formatDate(new Date(), f.id) })) }] });
      if (v) insertHtml(app, lastUpdated(new Date(), v.date, v.label));
    },
  },
  {
    id: 'insert.searchForm', label: 'Search Box', icon: 'search', origin: 'FrontPage (Web Search), modern builders',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Search Box', help: 'Searches a JSON index of the site’s pages (Site > Search Index creates search-index.json) right in the page. Without the index it searches the site with a web search engine.',
        fields: [
          { key: 'index', label: 'Search index file', type: 'combo', value: relativeRef(app.active.path, 'search-index.json'), options: app.site.list((f) => /\.json$/i.test(f.path)).map((f) => rel(app, f.path)) },
          { key: 'domain', label: 'Site domain for the web search fallback', type: 'text', value: (app.site.data.meta?.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''), placeholder: 'example.com' },
          { key: 'label', label: 'Label', type: 'text', value: 'Search this site' },
        ],
      });
      if (v) ins(app, searchForm(v), 'Insert Search Box');
    },
  },
  { id: 'insert.feedbackForm', label: 'Feedback Form', icon: 'feedback', origin: 'FrontPage (Feedback Form template)', run: async (app, arg) => { const o = await formOptions(app, 'Feedback Form', arg, 'Send feedback'); if (o) ins(app, feedbackForm(o), 'Insert Feedback Form'); } },
  { id: 'insert.contactForm', label: 'Contact Form', icon: 'contact_mail', popular: true, origin: 'FrontPage (Form Page Wizard), modern builders', run: async (app, arg) => { const o = await formOptions(app, 'Contact Form', arg, 'Send message'); if (o) ins(app, contactForm(o), 'Insert Contact Form'); } },
  { id: 'insert.newsletterForm', label: 'Newsletter Sign-Up', icon: 'mark_email_unread', origin: 'Modern builders', run: async (app, arg) => { const o = await formOptions(app, 'Newsletter Sign-Up', arg, 'Subscribe'); if (o) ins(app, newsletterForm(o), 'Insert Newsletter Sign-Up'); } },
  {
    id: 'insert.socialLinks', label: 'Social Media Links', icon: 'group', origin: 'Modern builders (social bar)',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Social Media Links', help: 'Plain links to your profiles (no third-party scripts). Leave a network empty to skip it.', fields: SOCIAL_NETWORKS.map((n, i) => ({ key: n, label: n === 'Email' ? 'Email address' : `${n} address`, type: 'text' as const, value: app.site.data.meta?.[n.toLowerCase()] || '', half: true, autofocus: i === 0 })) });
      if (!v) return;
      const links = SOCIAL_NETWORKS.map((network) => ({ network, url: String(v[network] || '').trim() })).filter((l) => l.url);
      if (!links.length) { toast('Type at least one address.'); return; }
      ins(app, socialLinks(links), 'Insert Social Media Links');
    },
  },
  {
    id: 'insert.shareButtons', label: 'Share Links', icon: 'share', origin: 'Modern builders (share buttons)',
    run: async (app, arg) => {
      const nets = ['Email', 'X', 'Facebook', 'LinkedIn', 'Reddit', 'Bluesky', 'WhatsApp'];
      const base = (app.site.data.meta?.url || '').replace(/\/+$/, '');
      const v = arg || await openDialog({
        title: 'Share Links', help: 'Plain links that open each network’s share page: no scripts from those networks and no tracking. Leave the address empty to use the page’s address in the browser.',
        fields: [
          { key: 'url', label: 'Page address', type: 'text', value: base ? `${base}/${app.active.path}` : '' },
          { key: 'title', label: 'Text to share', type: 'text', value: getTitle(app.active.source) },
          ...nets.map((n) => ({ key: 'n_' + n, label: n, type: 'checkbox' as const, value: n !== 'WhatsApp', half: true })),
        ],
      });
      if (!v) return;
      ins(app, shareButtons({ url: v.url, title: v.title, networks: v.networks || nets.filter((n) => v['n_' + n]) }), 'Insert Share Links');
    },
  },
  {
    id: 'insert.cookieBanner', label: 'Cookie Notice', icon: 'cookie', origin: 'Modern builders',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Cookie Notice', help: 'A dismissible notice. Note: where the law requires consent before tracking (such as in the EU), a notice alone is not enough — load trackers only after consent, or use privacy-friendly statistics that need no notice.', fields: [{ key: 'text', label: 'Message', type: 'textarea', rows: 3, value: 'This site uses cookies only to remember your preferences.' }, { key: 'button', label: 'Button', type: 'text', value: 'OK', half: true }, { key: 'policy', label: 'Privacy policy page', type: 'combo', value: '', options: app.site.pages().map((f) => rel(app, f.path)), half: true }] });
      if (v) insertRaw(app, cookieBanner(v).html, 'Insert Cookie Notice', (s) => ensureCss(s, 'cookie', cookieBanner(v).css!));
    },
  },
  { id: 'insert.backToTop', label: 'Back to Top Link', icon: 'vertical_align_top', origin: 'Dreamweaver snippets, modern builders', run: (app, arg) => ins(app, backToTop(typeof arg === 'string' ? arg : undefined), 'Insert Back to Top') },
  {
    id: 'insert.carousel', label: 'Carousel', icon: 'view_carousel', origin: 'Bootstrap Studio, modern builders', keywords: 'slider slideshow',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Carousel', help: 'Slides that scroll sideways (swipe, scroll, arrow keys or the numbered links). No script and no automatic movement.', fields: [{ key: 'count', label: 'Slides', type: 'number', value: 3, min: 1, max: 12 }, { key: 'label', label: 'Label', type: 'text', value: 'Featured' }, ...fileFields(app, 'image', 'Picture for every slide (optional)', { filter: isImagePath, accept: IMAGE_ACCEPT, dir: 'images', blank: true })] });
      if (!v) return;
      const n = Math.max(1, Math.min(12, +v.count || 3));
      ins(app, carousel(Array.from({ length: n }, (_, i) => ({ title: `Slide ${i + 1}`, text: 'Describe this slide.', image: v.image || undefined, alt: '' })), v.label || 'Featured'), 'Insert Carousel');
    },
  },
  {
    id: 'insert.tabs', label: 'Tabs', icon: 'tab', origin: 'Dreamweaver (Spry Tabbed Panels), Bootstrap Studio',
    run: async (app, arg) => {
      const t = Array.isArray(arg) ? arg : await openDialog({ title: 'Tabs', fields: [{ key: 't', label: 'Tab names (one per line)', type: 'textarea', rows: 4, value: 'First\nSecond\nThird' }] }).then((r) => (r ? lines(r.t) : null));
      if (t?.length) ins(app, tabs(t.map((x: string, i: number) => ({ title: x, body: i === 0 && selectionHtml(app) ? selectionHtml(app) : `<p>Content for ${esc(x)}.</p>` }))), 'Insert Tabs');
    },
  },
  {
    id: 'insert.accordion', label: 'Accordion', icon: 'expand_all', origin: 'Dreamweaver (Spry Accordion), Bootstrap Studio', keywords: 'faq collapsible details',
    run: async (app, arg) => {
      const v = Array.isArray(arg) ? { t: arg.join('\n'), exclusive: false } : arg || await openDialog({ title: 'Accordion', help: 'Collapsible sections built with <details>: no script needed.', fields: [{ key: 't', label: 'Section titles (one per line)', type: 'textarea', rows: 4, value: 'First question\nSecond question\nThird question' }, { key: 'exclusive', label: 'Only one section open at a time', type: 'checkbox', value: false }] });
      if (!v) return;
      const t = lines(v.t);
      if (t.length) ins(app, accordion(t.map((x) => ({ title: x, body: '<p>Answer.</p>' })), v.exclusive), 'Insert Accordion');
    },
  },
  {
    id: 'insert.modal', label: 'Modal Dialog', icon: 'open_in_new', origin: 'Bootstrap Studio, modern builders', keywords: 'popup dialog',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Modal Dialog', help: 'A button that opens a dialog box (an HTML <dialog>). Escape or the Close button closes it.', fields: [{ key: 'button', label: 'Button text', type: 'text', value: 'Open' }, { key: 'title', label: 'Dialog title', type: 'text', value: 'Title' }, { key: 'body', label: 'Dialog text', type: 'textarea', rows: 3, value: 'Message.' }] });
      if (v) ins(app, modal({ button: v.button, title: v.title, body: selectionHtml(app) || `<p>${esc(v.body)}</p>` }), 'Insert Modal Dialog');
    },
  },
  {
    id: 'insert.lightbox', label: 'Lightbox Picture', icon: 'fullscreen', origin: 'Expression Web (Photo Gallery), modern builders',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Lightbox Picture', help: 'A thumbnail that opens the full picture over the page (CSS only).', fields: [...fileFields(app, 'src', 'Picture', { filter: isImagePath, accept: IMAGE_ACCEPT, dir: 'images' }), { key: 'alt', label: 'Alternate text', type: 'text', value: '' }, { key: 'caption', label: 'Caption', type: 'text', value: '' }, { key: 'thumb', label: 'Thumbnail width', type: 'number', value: 240, suffix: 'px' }], validate: (x) => (!x.src ? 'Choose a picture.' : !x.alt?.trim() ? 'Describe the picture.' : null) });
      if (v) ins(app, lightbox({ src: v.src, alt: v.alt, caption: v.caption }, +v.thumb || 240), 'Insert Lightbox');
    },
  },
  {
    id: 'insert.navbar', label: 'Navigation Bar', icon: 'menu', popular: true, origin: 'Bootstrap Studio, modern builders', keywords: 'navbar menu responsive',
    run: async (app, arg) => {
      const items = linkBarItems(app, 'top', { home: true });
      const v = arg || await openDialog({ title: 'Navigation Bar', help: 'Links from the site’s top-level pages. On narrow screens they fold behind a Menu button (no script needed).', fields: [{ key: 'brand', label: 'Site name', type: 'text', value: app.site.name }, { key: 'links', label: 'Links (text | address, one per line)', type: 'textarea', rows: 6, value: items.map((x) => `${x.label} | ${x.href}`).join('\n') }] });
      if (!v) return;
      const list: NavItem[] = lines(v.links).map((l) => { const [label, href] = l.split('|').map((s) => s.trim()); return { label, href: href || '#', current: items.some((x) => x.href === href && x.current) }; });
      ins(app, navbar({ brand: v.brand || app.site.name, brandHref: rel(app, navTree(app).path), items: list }), 'Insert Navigation Bar');
    },
  },
  {
    id: 'insert.pricingTable', label: 'Pricing Table', icon: 'payments', origin: 'Modern builders',
    run: async (app, arg) => {
      const n = Array.isArray(arg) ? arg.length : await openDialog({ title: 'Pricing Table', fields: [{ key: 'n', label: 'Plans', type: 'number', value: 3, min: 1, max: 5 }] }).then((r) => (r ? Math.max(1, Math.min(5, +r.n || 3)) : 0));
      if (!n) return;
      const names = ['Basic', 'Standard', 'Premium', 'Business', 'Enterprise'];
      const plans: Plan[] = Array.isArray(arg) ? arg : Array.from({ length: n }, (_, i) => ({ name: names[i], price: `$${[9, 19, 39, 79, 149][i]}`, period: 'per month', features: ['Feature one', 'Feature two', ...(i ? ['Feature three'] : []), ...(i > 1 ? ['Priority support'] : [])], cta: 'Choose plan', href: '#', featured: n > 1 && i === 1 }));
      ins(app, pricingTable(plans), 'Insert Pricing Table');
    },
  },
  {
    id: 'insert.testimonials', label: 'Testimonials', icon: 'reviews', origin: 'Modern builders',
    run: (app, arg) => ins(app, testimonials(Array.isArray(arg) ? arg : [1, 2, 3].map((i) => ({ quote: 'Write what a customer said here.', name: `Customer ${i}`, role: 'Company' }))), 'Insert Testimonials'),
  },
  {
    id: 'insert.hero', label: 'Hero Section', icon: 'wallpaper', popular: true, origin: 'Bootstrap Studio, modern builders', keywords: 'banner jumbotron header',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Hero Section', help: 'A large introduction at the top of a page. Check that text on a background picture stays readable.',
        fields: [
          { key: 'title', label: 'Heading', type: 'text', value: getTitle(app.active.source) || 'Welcome' },
          { key: 'text', label: 'Text', type: 'textarea', rows: 2, value: 'One sentence that says what this site offers.' },
          { key: 'cta', label: 'Button text', type: 'text', value: 'Get started', half: true }, { key: 'href', label: 'Button link', type: 'combo', value: '', options: app.site.pages().map((f) => rel(app, f.path)), half: true },
          ...fileFields(app, 'image', 'Background picture (optional)', { filter: isImagePath, accept: IMAGE_ACCEPT, dir: 'images', blank: true }),
          { key: 'bg', label: 'Background color', type: 'color', value: '#1d2733', half: true }, { key: 'color', label: 'Text color', type: 'color', value: '#ffffff', half: true },
        ],
      });
      if (v) ins(app, hero(v), 'Insert Hero Section');
    },
  },
  {
    id: 'insert.cards', label: 'Cards', icon: 'view_module', popular: true, origin: 'Bootstrap Studio, modern builders',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Cards', fields: [{ key: 'n', label: 'Cards', type: 'number', value: 3, min: 1, max: 12 }, { key: 'images', label: 'With a picture placeholder', type: 'checkbox', value: true }, { key: 'links', label: 'With a “Read more” link', type: 'checkbox', value: true }] });
      if (!v) return;
      const n = Math.max(1, Math.min(12, +v.n || 3));
      const ph = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#d9dde3"/></svg>');
      ins(app, cards(Array.from({ length: n }, (_, i) => ({ title: `Card ${i + 1}`, text: 'A short description.', image: v.images ? ph : undefined, alt: '', href: v.links ? '#' : undefined }))), 'Insert Cards');
    },
  },
  {
    id: 'insert.timeline', label: 'Timeline', icon: 'timeline', origin: 'Modern builders',
    run: async (app, arg) => {
      const t = Array.isArray(arg) ? arg : await openDialog({ title: 'Timeline', fields: [{ key: 't', label: 'Events (date | title | text, one per line)', type: 'textarea', rows: 6, value: '2024 | Founded | How it started.\n2025 | First product | What happened.\n2026 | Today | Where things stand.' }] }).then((r) => (r ? lines(r.t).map((l) => { const [date, title, text] = l.split('|').map((s) => s.trim()); return { date, title: title || '', text: text || '' }; }) : null));
      if (t?.length) ins(app, timeline(t), 'Insert Timeline');
    },
  },
  {
    id: 'insert.countdown', label: 'Countdown', icon: 'timer', origin: 'Modern builders',
    run: async (app, arg) => {
      const d = new Date(Date.now() + 7 * 864e5);
      const v = arg || await openDialog({ title: 'Countdown', help: 'Counts down to a date and time in the visitor’s browser (the date is shown without scripts).', fields: [{ key: 'date', label: 'Date', type: 'date', value: formatDate(d, 'iso'), half: true }, { key: 'time', label: 'Time', type: 'time', value: '09:00', half: true }, { key: 'label', label: 'Label', type: 'text', value: 'Starts in' }, { key: 'done', label: 'Text when the time comes', type: 'text', value: 'It has started!' }] });
      if (!v?.date) return;
      ins(app, countdown({ target: `${v.date}T${v.time || '00:00'}`, label: v.label, done: v.done }), 'Insert Countdown');
    },
  },
  {
    id: 'insert.rssFeed', label: 'Feed Link (RSS)', icon: 'rss_feed', origin: 'Dreamweaver, modern builders', keywords: 'rss atom feed subscribe',
    run: async (app, arg) => {
      const v = arg || await openDialog({ title: 'Feed Link', help: 'A link to the site’s RSS feed, and a head tag so browsers and feed readers find it. Site > RSS Feed creates the feed.', fields: [{ key: 'href', label: 'Feed', type: 'combo', value: siteFeed(app), options: app.site.list((f) => /\.(xml|rss|atom)$/i.test(f.path)).map((f) => rel(app, f.path)) }, { key: 'title', label: 'Feed title', type: 'text', value: app.site.name }] });
      if (!v?.href) return;
      const r = rssLink(v.href, v.title || app.site.name);
      insertRaw(app, r.html, 'Insert Feed Link', (s) => (/type\s*=\s*["']application\/rss\+xml["']/i.test(s.slice(0, Math.max(0, regions(s).headClose))) ? s : headInsert(s, r.head)));
    },
  },
]));

function siteFeed(app: App): string {
  const f = app.site.list((x) => /(^|\/)(feed|rss|atom)\.(xml|rss|atom)$/i.test(x.path))[0];
  return f ? rel(app, f.path) : relativeRef(app.active.path, 'feed.xml');
}

// ------------------------------------------------------------------------------------------
// Frameworks

/** Inserts a style sheet link before the page's own style sheets, so the page can override it. */
export function prependStylesheet(src: string, href: string): string {
  if (src.includes(`href="${href}"`)) return src;
  const r = regions(src);
  if (!r.headOpen || r.headClose < 0) return addStylesheet(src, href);
  const headTxt = src.slice(r.headOpen[1], r.headClose);
  const m = /<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*>|<style\b/i.exec(headTxt);
  if (!m) return addStylesheet(src, href);
  const at = r.headOpen[1] + m.index;
  const indent = /([ \t]*)$/.exec(src.slice(0, at))?.[1] ?? '  ';
  return src.slice(0, at) + `<link rel="stylesheet" href="${escAttr(href)}">\n${indent}` + src.slice(at);
}

export function addFramework(src: string, id: string): string {
  const f = FRAMEWORKS[id];
  if (!f) return src;
  let s = src;
  for (const c of f.css || []) s = prependStylesheet(s, c);
  for (const j of f.js || []) {
    if (s.includes(`src="${j.src}"`)) continue;
    const tag = `<script src="${escAttr(j.src)}"${j.defer ? ' defer' : ''}${j.module ? ' type="module"' : ''}></script>`;
    s = j.end ? bodyEndInsert(s, tag) : headInsert(s, tag);
  }
  return s;
}

const fw = (id: string, icon: string, origin: string): Parameters<typeof cmds>[2][number] => ({
  id: `insert.${id}`, label: FRAMEWORKS[id].label, icon, origin,
  run: (app) => {
    const f = FRAMEWORKS[id];
    if (!app.editSource(`Add ${f.label}`, (s) => addFramework(s, id))) { toast(`${f.label} is already linked to this page.`); return; }
    toast(`${f.label} linked from a public CDN.${f.note ? ' ' + f.note : ''}`, { ms: f.note ? 7000 : 3500 });
  },
});

def(cmds('Frameworks', 'Bootstrap Studio, Dreamweaver (Bootstrap), modern editors', [
  fw('bootstrap', 'view_quilt', 'Dreamweaver CC (Bootstrap), Bootstrap Studio'),
  fw('tailwind', 'air', 'Modern editors'),
  fw('picoCss', 'format_paint', 'Modern editors'),
  fw('bulma', 'dashboard', 'Modern editors'),
  fw('foundation', 'foundation', 'Dreamweaver (Foundation), modern editors'),
  fw('jquery', 'javascript', 'Dreamweaver (jQuery widgets), modern editors'),
  fw('alpine', 'landscape', 'Modern editors'),
  fw('fontAwesome', 'emoji_symbols', 'Modern editors'),
  fw('normalize', 'restart_alt', 'Modern editors'),
  {
    id: 'insert.googleFont', label: 'Google Font', icon: 'font_download', origin: 'Dreamweaver (Web Fonts), modern editors',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { families: [arg], apply: 'none', weights: '400;700' } : arg || await openDialog({
        title: 'Google Font', help: 'Links fonts from Google Fonts. Visitors’ browsers then contact Google’s servers; to avoid that, download the font files into the site and use Format > Web Fonts.', wide: true,
        fields: [
          { key: 'families', label: 'Fonts', type: 'list', multiple: true, rows: 10, options: GOOGLE_FONTS.map((f) => ({ value: f.family, label: `${f.family} (${f.fallback})`, style: `font-family:'${f.family}',${f.fallback}` })), value: ['Inter'] },
          { key: 'other', label: 'Other font family name', type: 'text', value: '', placeholder: 'e.g. Bitter' },
          { key: 'weights', label: 'Weights', type: 'text', value: '400;700', half: true },
          { key: 'apply', label: 'Use the first font for', type: 'select', value: 'body', options: [{ value: 'body', label: 'The whole page' }, { value: 'headings', label: 'Headings' }, { value: 'none', label: 'Nothing yet (just link it)' }], half: true },
        ],
        validate: (x) => ((x.families?.length || x.other?.trim()) ? null : 'Pick a font.'),
      });
      if (!v) return;
      const names: string[] = [...(v.families || []), ...(v.other?.trim() ? [v.other.trim()] : [])];
      const tags = googleFontTags(names.map((family) => ({ family, weights: GOOGLE_FONTS.find((g) => g.family === family)?.weights === '400' ? '400' : v.weights })));
      const first = names[0];
      const fb = GOOGLE_FONTS.find((g) => g.family === first)?.fallback || 'sans-serif';
      app.editSource('Add Google Font', (s) => {
        let out = tags.reduce((acc, t) => headOnce(acc, t), s);
        if (v.apply !== 'none' && first) out = ensureCss(out, `font-${first.toLowerCase().replace(/\W+/g, '-')}-${v.apply}`, `${v.apply === 'headings' ? 'h1,h2,h3,h4,h5,h6' : 'body'}{font-family:'${first.replace(/'/g, '')}',${fb}}`);
        return out;
      });
    },
  },
  {
    id: 'insert.analytics', label: 'Analytics', icon: 'monitoring', origin: 'Modern builders (site statistics)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Analytics', help: 'Adds a statistics script to the page head. Plausible and GoatCounter count visits without cookies or personal data; Google Analytics sets cookies and usually needs visitor consent.',
        fields: [
          { key: 'kind', label: 'Service', type: 'radio', value: 'plausible', options: [{ value: 'plausible', label: 'Plausible (site domain)' }, { value: 'goatcounter', label: 'GoatCounter (your code)' }, { value: 'ga4', label: 'Google Analytics 4 (measurement id G-…)' }] },
          { key: 'id', label: 'Domain, code or id', type: 'text', value: (app.site.data.meta?.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''), autofocus: true },
        ],
        validate: (x) => (!x.id?.trim() ? 'Type the domain, code or id from the service.' : x.kind === 'ga4' && !/^G-[A-Z0-9]+$/i.test(x.id.trim()) ? 'A Google Analytics 4 id looks like G-XXXXXXX.' : x.kind === 'goatcounter' && !/^[\w-]+$/.test(x.id.trim()) ? 'Type just the GoatCounter code (the part before .goatcounter.com).' : null),
      });
      if (!v) return;
      const snip = analyticsSnippet(v.kind as AnalyticsKind, v.id.trim());
      if (!app.editSource('Add Analytics', (s) => headOnce(s, snip))) toast('This analytics script is already on the page.');
      else if (v.kind === 'ga4') toast('Google Analytics sets cookies: consider a consent banner where the law requires one.', { ms: 5000 });
    },
  },
]));

