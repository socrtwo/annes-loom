/**
 * Commands for other systems and templates: WordPress (export file, themes, REST API), Weebly (themes and
 * site archives), Wix (import by address, embeds), Joomla/Drupal and any template ZIP, static generators,
 * web archives, word-processor HTML, Markdown and Photoshop files.
 */
import { def, getCommand } from './registry';
import type { App } from '../app';
import { Site } from '../model/site';
import { joinPath, slugify, stripExt, baseName, dirOf, normalizePath } from '../model/paths';
import { openDialog, toast, alertDialog, choiceDialog, confirmDialog, promptDialog, type DialogControl } from '../ui/dialog';
import { h } from '../ui/dom';
import { openDocument, saveAs, writeClipboardText } from '../platform/native';
import { readZip } from '../site/io';
import { getApiKey, setApiKey } from '../ai/store';
import { detectArchive, siteFromArchive, unwrapArchive, ARCHIVE_LABELS, type ArchiveKind } from '../io/archive';
import { wxrToSite, siteToWxr, isWxr, contentPages, pageContentOf } from '../io/wxr';
import { parseMhtml, buildMhtml } from '../io/mhtml';
import { publishToWordPress, fetchWordPressSite, testWordPress, wpBase } from '../io/wordpress';
import { exportWordPressThemeFiles, makeScreenshot } from '../io/wpTheme';
import { htmlToBlocks } from '../io/blocks';
import { exportWeeblyThemeFiles, WEEBLY_TAGS } from '../io/weebly';
import { importWixSite, exportEmbed, exportVelo, HOW_TO } from '../io/wix';
import { exportStaticFiles, exportJekyllFiles, exportHugoFiles, staticPage } from '../io/ssg';
import { cleanWordHtml } from '../io/wordHtml';
import { markdownToPage } from '../io/markdown';
import { zipFiles } from '../io/common';
import { CorsError } from '../io/fetchSite';
import { decodeText } from '../model/site';

type ImportResult = { site: Site; report: string[]; open?: string };

const TAB = 'CMS & Builders';

// ------------------------------------------------------------------------------------------
// Helpers

async function pick(accept: string, mimes: string[] = ['application/octet-stream']): Promise<{ name: string; bytes: Uint8Array } | null> {
  const f = await openDocument(accept, mimes);
  return f ? { name: f.name, bytes: new Uint8Array(f.data) } : null;
}

function reportView(lines: string[], extra?: HTMLElement): HTMLElement {
  return h('div', { class: 'ql-msg' }, h('ul', { style: 'margin:0;padding-left:1.2em;max-height:50vh;overflow:auto' }, ...lines.map((l) => h('li', { style: 'margin:.25em 0' }, l))), extra || null);
}

export async function showReport(title: string, lines: string[]): Promise<void> {
  await alertDialog(title, reportView(lines));
}

/** Copies an imported site into the open one under `folder`, keeping template links working. */
export function mergeInto(app: App, imported: Site, folder: string): string[] {
  const dir = normalizePath(folder);
  const written: string[] = [];
  for (const f of imported.list()) {
    const dest = joinPath(dir, f.path);
    let content: string | Uint8Array = f.data ?? f.text ?? '';
    if (typeof content === 'string' && dir) content = content.replace(/(<!--\s*(?:#BeginTemplate\s+|InstanceBegin\s+template=)")\/(?!\/)/g, `$1/${dir}/`);
    app.site.write(dest, content);
    const nf = app.site.get(dest);
    if (nf && f.noPublish) nf.noPublish = true;
    written.push(dest);
  }
  for (const [p, t] of Object.entries(imported.data.templates)) app.site.data.templates[joinPath(dir, p)] = joinPath(dir, t);
  app.site.touchMeta();
  return written;
}

/** Asks whether to open the result as a new site or add it to the current one, then does it and shows the report. */
async function deliver(app: App, r: ImportResult, title: string, opts: { suggestFolder?: string } = {}): Promise<void> {
  const hasContent = app.site.pages().length > 1 || app.siteDirty;
  let mode = 0;
  if (hasContent) {
    mode = await choiceDialog(title, `"${r.site.name}" is ready (${r.site.files.size} files). Open it as a new site, or add it to the current site in a folder?`, ['Open as New Site', 'Add to This Site']);
    if (mode < 0) return;
  }
  if (mode === 0) {
    if (app.siteDirty && hasContent && !(await confirmDialog(title, 'The current site has changes that are not saved to a folder or file. A draft is kept on this device. Open the imported site anyway?', 'Open', 'Cancel'))) return;
    app.setSite(r.site, { open: r.open && r.site.has(r.open) ? r.open : undefined });
  } else {
    const folder = await promptDialog(title, 'Folder in this site', opts.suggestFolder || slugify(r.site.name), { help: 'Links between the imported files keep working; links that start with "/" may need the folder added.' });
    if (folder == null) return;
    const written = mergeInto(app, r.site, folder);
    const open = r.open ? joinPath(folder, r.open) : written.find((p) => /\.html?$/.test(p));
    if (open && app.site.has(open)) app.openFile(open);
  }
  await showReport(title, r.report);
}

async function importZip(app: App, title: string, want?: ArchiveKind): Promise<void> {
  const f = await pick('.zip', ['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
  if (!f) return;
  toast('Reading the archive…');
  const raw = await readZip(f.bytes, { stripRoot: false });
  const { files } = await unwrapArchive(raw);
  const found = detectArchive(files);
  let kind: ArchiveKind = found;
  if (want && found !== want) {
    const i = await choiceDialog(title, `This archive looks like a ${ARCHIVE_LABELS[found]}, not a ${ARCHIVE_LABELS[want]}.`, [`Import as ${ARCHIVE_LABELS[found]}`, `Import as ${ARCHIVE_LABELS[want]}`]);
    if (i < 0) return;
    kind = i === 0 ? found : want;
  }
  const r = await siteFromArchive(stripExt(f.name), raw, kind);
  r.report.unshift(`Recognized: ${ARCHIVE_LABELS[kind]}.`);
  await deliver(app, r, title);
}

async function download(blob: Blob, name: string): Promise<void> {
  const r = await saveAs(blob, name);
  if (r) toast(`Saved ${r.name}`);
}

function pageArg(app: App): string | null {
  const p = app.page?.path || (app.site.has(app.site.homePage) ? app.site.homePage : null);
  if (!p) { toast('Open a page first.'); return null; }
  app.active?.ui?.flush?.();
  return p;
}

function pagesOptions(app: App): { value: string; label: string }[] {
  return contentPages(app.site).map((p) => ({ value: p, label: p }));
}

function codeDialog(title: string, code: string, notes: string[], fileName: string, mime: string): Promise<unknown> {
  return openDialog({
    title, wide: true, ok: 'Close', cancel: false,
    fields: [
      { key: 'notes', type: 'info', html: notes.map((n) => `<p>${n.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</p>`).join('') },
      { key: 'code', type: 'textarea', rows: 16, value: code },
    ],
    buttons: [
      { label: 'Copy', primary: true, onClick: async () => { toast((await writeClipboardText(code)) ? 'Copied to the clipboard.' : 'Copying was not allowed; select the text and copy it.'); } },
      { label: 'Save as File…', onClick: () => { void download(new Blob([code], { type: mime }), fileName); } },
    ],
  });
}

// ------------------------------------------------------------------------------------------
// WordPress

async function wpCredentials(app: App, title: string, opts: { needAuth: boolean; extra?: any[] }): Promise<Record<string, any> | null> {
  const prof = app.site.data.publish.find((p) => p.kind === 'wordpress');
  const url = prof?.url || app.site.data.meta['wp:url'] || '';
  const saved = url ? await getApiKey('wp:' + wpBase(url)) : '';
  return openDialog({
    title,
    help: opts.needAuth ? 'Create an application password in WordPress under Users ▸ Profile ▸ Application Passwords (WordPress 5.6 or later; the site must use https). Your normal password is not used.' : undefined,
    fields: [
      { key: 'url', label: 'Site address', type: 'text', value: url, placeholder: 'https://example.com', autofocus: true },
      { key: 'user', label: 'User name', type: 'text', value: prof?.user || '', placeholder: opts.needAuth ? '' : 'Optional' },
      { key: 'password', label: 'Application password', type: 'password', value: saved, placeholder: opts.needAuth ? 'xxxx xxxx xxxx xxxx xxxx xxxx' : 'Optional' },
      { key: 'remember', label: 'Remember the application password on this device (stored encrypted)', type: 'checkbox', value: !!saved },
      ...(opts.extra || []),
    ],
    validate: (v) => (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(String(v.url).trim()) && !/^[^\s/]+\.[^\s]+/.test(String(v.url).trim()) ? 'Enter the address of the WordPress site.' : opts.needAuth && (!v.user || !v.password) ? 'Enter the user name and an application password.' : null),
  });
}

async function rememberPassword(v: Record<string, any>): Promise<void> {
  const key = 'wp:' + wpBase(v.url);
  if (v.remember && v.password) await setApiKey(key, v.password);
  else if (!v.remember) await setApiKey(key, '');
}

def([
  {
    id: 'wp.importWxr', label: 'Import WordPress Export…', icon: 'article', tab: TAB, group: 'WordPress', edits: true, origin: 'WordPress Tools ▸ Import (WXR)',
    keywords: 'wxr xml wordpress export import posts pages',
    tip: 'Pages, posts, menus and media links from a WordPress export file (.xml)',
    run: async (app) => {
      const f = await pick('.xml,.wxr', ['application/xml', 'text/xml', 'application/rss+xml']);
      if (!f) return;
      const text = decodeText(f.bytes);
      if (!isWxr(text) && !(await confirmDialog('Import WordPress Export', 'This file does not look like a WordPress export (no wp: namespace). Try anyway?'))) return;
      const v = await openDialog({ title: 'Import WordPress Export', fields: [{ key: 'drafts', label: 'Include drafts and private items', type: 'checkbox', value: false }] });
      if (!v) return;
      await deliver(app, wxrToSite(text, { name: stripExt(f.name), includeDrafts: !!v.drafts }), 'Import WordPress Export', { suggestFolder: 'wordpress' });
    },
  },
  {
    id: 'wp.importTheme', label: 'Import WordPress Theme…', icon: 'palette', tab: TAB, group: 'WordPress', edits: true, origin: 'WordPress themes',
    keywords: 'wordpress theme php classic block import',
    tip: 'A classic or block theme (.zip) becomes static pages and a page template',
    run: (app) => importZip(app, 'Import WordPress Theme', 'wp-theme'),
  },
  {
    id: 'wp.importFromSite', label: 'Import from WordPress Site…', icon: 'cloud_download', tab: TAB, group: 'WordPress', edits: true, origin: 'WordPress REST API',
    keywords: 'wordpress rest api download site',
    tip: 'Reads pages and posts from a running WordPress site through its REST API',
    run: async (app) => {
      const v = await wpCredentials(app, 'Import from WordPress Site', { needAuth: false, extra: [{ key: 'drafts', label: 'Include drafts (needs a user and application password)', type: 'checkbox', value: false }] });
      if (!v) return;
      await rememberPassword(v);
      const report: string[] = [];
      try {
        toast('Reading the site…', { ms: 4000 });
        const site = await fetchWordPressSite(v.url, { user: v.user || undefined, password: v.password || undefined, report, includeDrafts: !!v.drafts, log: (s) => app.ui.status?.(s) });
        await deliver(app, { site, report, open: 'index.html' }, 'Import from WordPress Site', { suggestFolder: 'wordpress' });
      } catch (e: any) {
        await alertDialog('Import from WordPress Site', e instanceof CorsError ? e.message : `Could not read the site: ${e?.message || e}`);
      }
    },
  },
  {
    id: 'wp.exportWxr', label: 'WordPress Export File…', icon: 'article', tab: TAB, group: 'WordPress', origin: 'WordPress Tools ▸ Export (WXR)',
    keywords: 'wxr xml wordpress export',
    tip: 'Writes the site\'s pages as a WordPress export file to import with Tools ▸ Import ▸ WordPress',
    run: async (app) => {
      const v = await openDialog({
        title: 'WordPress Export File',
        fields: [
          { key: 'type', label: 'Import pages as', type: 'radio', value: 'page', options: [{ value: 'page', label: 'Pages (keeps the folder hierarchy)' }, { value: 'post', label: 'Posts' }] },
          { key: 'blocks', label: 'Convert content to blocks (for the block editor)', type: 'checkbox', value: true },
          { key: 'siteUrl', label: 'Address where this site\'s pictures are published (optional)', type: 'text', value: app.site.data.meta['site:url'] || '', placeholder: 'https://old.example.com', help: 'With an address, pictures are listed as attachments so the importer can download them ("Download and import file attachments").' },
          { key: 'author', label: 'Author user name', type: 'text', value: 'admin' },
          { key: 'pages', label: 'Pages', type: 'list', multiple: true, rows: 8, options: pagesOptions(app), value: contentPages(app.site) },
        ],
      });
      if (!v) return;
      const paths: string[] = Array.isArray(v.pages) && v.pages.length ? v.pages : contentPages(app.site);
      const xml = siteToWxr(app.site, { postType: v.type, blocks: !!v.blocks, siteUrl: v.siteUrl || undefined, author: v.author || 'admin', paths });
      await download(new Blob([xml], { type: 'application/xml' }), `${slugify(app.site.name)}.wordpress.xml`);
    },
  },
  {
    id: 'wp.exportTheme', label: 'WordPress Theme…', icon: 'palette', tab: TAB, group: 'WordPress', origin: 'WordPress classic themes',
    keywords: 'wordpress theme export php zip',
    tip: 'A classic WordPress theme made from this site\'s design',
    run: async (app) => {
      const page = pageArg(app);
      if (!page) return;
      const v = await openDialog({
        title: 'WordPress Theme',
        help: 'header.php and footer.php are split around the page\'s main content (an editable region named content or body, a <main> element, or #content).',
        fields: [
          { key: 'name', label: 'Theme name', type: 'text', value: app.site.name },
          { key: 'author', label: 'Author', type: 'text', value: '' },
          { key: 'description', label: 'Description', type: 'text', value: '' },
          { key: 'version', label: 'Version', type: 'text', value: '1.0.0', half: true },
          { key: 'page', label: 'Design from page', type: 'select', value: page, options: pagesOptions(app), half: true },
          { key: 'shot', label: 'Add a simple screenshot.png', type: 'checkbox', value: true },
        ],
      });
      if (!v) return;
      const report: string[] = [];
      const screenshot = v.shot ? await makeScreenshot(v.name || app.site.name) : undefined;
      const files = exportWordPressThemeFiles(app.site, { pagePath: v.page, name: v.name, author: v.author, description: v.description, version: v.version, screenshot, report });
      await download(await zipFiles(files), `${slugify(v.name || app.site.name)}.zip`);
      await showReport('WordPress Theme', report);
    },
  },
  {
    id: 'wp.exportBlocks', label: 'Copy as WordPress Blocks', icon: 'view_agenda', tab: TAB, group: 'WordPress', origin: 'WordPress block editor',
    keywords: 'gutenberg blocks markup copy paste',
    tip: 'This page\'s content as block-editor markup to paste into WordPress',
    run: async (app) => {
      const p = pageArg(app);
      if (!p) return;
      const blocks = htmlToBlocks(pageContentOf(staticPage(app.site, p)));
      await codeDialog('WordPress Blocks', blocks, ['In the WordPress block editor, open the Options menu ▸ Code editor and paste this; or paste it into a Custom HTML block.', 'Elements without a matching core block are Custom HTML blocks.'], `${slugify(stripExt(baseName(p)))}.blocks.html`, 'text/html');
    },
  },
  {
    id: 'wp.publish', label: 'Publish to WordPress…', icon: 'publish', tab: TAB, group: 'WordPress', origin: 'WordPress REST API',
    keywords: 'wordpress rest api publish upload pages posts',
    tip: 'Creates or updates WordPress pages or posts from site pages (matched by slug), uploading their pictures',
    run: async (app) => {
      const prof = app.site.data.publish.find((p) => p.kind === 'wordpress');
      const v = await wpCredentials(app, 'Publish to WordPress', {
        needAuth: true,
        extra: [
          { key: 'type', label: 'Send as', type: 'select', value: prof?.remoteDir || 'page', options: [{ value: 'page', label: 'Pages' }, { value: 'post', label: 'Posts' }], half: true },
          { key: 'status', label: 'Status', type: 'select', value: prof?.options?.status || 'draft', options: [{ value: 'draft', label: 'Draft' }, { value: 'publish', label: 'Published' }], half: true },
          { key: 'blocks', label: 'Convert to blocks', type: 'checkbox', value: prof?.options?.blocks !== false },
          { key: 'media', label: 'Upload pictures to the media library', type: 'checkbox', value: prof?.options?.media !== false },
          { key: 'pages', label: 'Pages to send', type: 'list', multiple: true, rows: 7, options: pagesOptions(app), value: app.page ? [app.page.path] : [] },
        ],
      });
      if (!v) return;
      const paths: string[] = Array.isArray(v.pages) ? v.pages : [];
      if (!paths.length) { toast('Choose at least one page.'); return; }
      await rememberPassword(v);
      let profile = prof;
      if (!profile) { profile = { id: `wp${Date.now().toString(36)}`, name: 'WordPress', kind: 'wordpress', url: wpBase(v.url) }; app.site.data.publish.push(profile); }
      Object.assign(profile, { url: wpBase(v.url), user: v.user, remoteDir: v.type, options: { ...(profile.options || {}), status: v.status, blocks: !!v.blocks, media: !!v.media } });
      app.site.touchMeta();
      const log: string[] = [];
      try {
        const n = await publishToWordPress(app.site, profile, paths, v.password, (l) => { log.push(l); app.ui.status?.(l); });
        app.site.touchMeta();
        await showReport(`Publish to WordPress (${n} sent)`, log);
      } catch (e: any) {
        log.push(e instanceof CorsError ? e.message : `Stopped: ${e?.message || e}`);
        await showReport('Publish to WordPress', log);
      }
    },
  },
  {
    id: 'wp.connect', label: 'Test WordPress Connection…', icon: 'link', tab: TAB, group: 'WordPress', origin: 'WordPress REST API', noRecord: true,
    keywords: 'wordpress application password login test',
    tip: 'Checks a site address, user name and application password',
    run: async (app) => {
      const v = await wpCredentials(app, 'Test WordPress Connection', { needAuth: true });
      if (!v) return;
      await rememberPassword(v);
      try {
        const r = await testWordPress(v.url, v.user, v.password);
        await alertDialog('Test WordPress Connection', `Connected to "${r.site}" as ${r.name}${r.roles.length ? ` (${r.roles.join(', ')})` : ''}.`);
      } catch (e: any) {
        await alertDialog('Test WordPress Connection', e instanceof CorsError ? e.message : `Could not connect: ${e?.message || e}`);
      }
    },
  },
]);

// ------------------------------------------------------------------------------------------
// Weebly

def([
  {
    id: 'weebly.importArchive', label: 'Import Weebly Site Archive…', icon: 'web', tab: TAB, group: 'Weebly', edits: true, origin: 'Weebly site archive',
    keywords: 'weebly archive zip download import',
    tip: 'The ZIP archive Weebly makes of a published site',
    run: (app) => importZip(app, 'Import Weebly Site Archive', 'weebly-archive'),
  },
  {
    id: 'weebly.importTheme', label: 'Import Weebly Theme…', icon: 'brush', tab: TAB, group: 'Weebly', edits: true, origin: 'Weebly custom themes',
    keywords: 'weebly theme import less tags',
    tip: 'Theme files with {content}, {menu} and other tags become pages for each header type',
    run: (app) => importZip(app, 'Import Weebly Theme', 'weebly-theme'),
  },
  {
    id: 'weebly.exportTheme', label: 'Weebly Theme…', icon: 'brush', tab: TAB, group: 'Weebly', origin: 'Weebly custom themes',
    keywords: 'weebly theme export',
    tip: 'A custom Weebly theme made from this page\'s design',
    run: async (app) => {
      const page = pageArg(app);
      if (!page) return;
      const report: string[] = [];
      const files = exportWeeblyThemeFiles(app.site, { pagePath: page, report });
      await download(await zipFiles(files), `${slugify(app.site.name)}-weebly-theme.zip`);
      await showReport('Weebly Theme', report);
    },
  },
  {
    id: 'weebly.tags', label: 'Weebly Theme Tags', icon: 'sell', tab: TAB, group: 'Weebly', origin: 'Weebly custom themes', noRecord: true,
    keywords: 'weebly tags reference',
    tip: 'What each Weebly theme tag means and what it becomes when a theme is imported or exported',
    run: async () => {
      const table = h('table', { class: 'ql-table', style: 'width:100%;border-collapse:collapse' },
        h('thead', null, h('tr', null, h('th', { style: 'text-align:left' }, 'Tag'), h('th', { style: 'text-align:left' }, 'In Weebly'), h('th', { style: 'text-align:left' }, 'Here'))),
        h('tbody', null, ...WEEBLY_TAGS.map((t) => h('tr', null, h('td', null, h('code', null, t.tag)), h('td', null, t.meaning), h('td', null, t.mapsTo)))));
      await openDialog({ title: 'Weebly Theme Tags', wide: true, ok: 'Close', cancel: false, content: h('div', { style: 'max-height:60vh;overflow:auto' }, table) });
    },
  },
]);

// ------------------------------------------------------------------------------------------
// Wix

def([
  {
    id: 'wix.importFromUrl', label: 'Import Wix Site by Address…', icon: 'public', tab: TAB, group: 'Wix', edits: true, origin: 'Wix (published pages)',
    keywords: 'wix import download url address',
    tip: 'Saves the published pages of a Wix (or any) site: text, layout and links to its pictures',
    run: async (app) => {
      const v = await openDialog({
        title: 'Import Wix Site by Address',
        help: 'Wix has no export. This saves what its server sends for published pages; interactive parts need to be rebuilt.',
        fields: [
          { key: 'url', label: 'Address of the published site', type: 'text', placeholder: 'https://username.wixsite.com/mysite', autofocus: true },
          { key: 'pages', label: 'Pages to save (follows links on the same site)', type: 'number', value: 10, min: 1, max: 100 },
        ],
        validate: (x) => (/^https?:\/\//i.test(String(x.url || '').trim()) ? null : 'Enter an address that starts with https://'),
      });
      if (!v) return;
      try {
        toast('Reading the site…', { ms: 4000 });
        const r = await importWixSite(String(v.url).trim(), { maxPages: Number(v.pages) || 10, log: (s) => app.ui.status?.(s) });
        await deliver(app, r, 'Import Wix Site', { suggestFolder: 'wix' });
      } catch (e: any) {
        await alertDialog('Import Wix Site', e instanceof CorsError ? e.message : `Could not read the site: ${e?.message || e}`);
      }
    },
  },
  {
    id: 'wix.exportEmbed', label: 'Wix Embed Code', icon: 'code', tab: TAB, group: 'Wix', origin: 'Wix Embed HTML element',
    keywords: 'wix embed html iframe code',
    tip: 'This page as one self-contained HTML document for an "Embed HTML" element',
    run: async (app) => {
      const p = pageArg(app);
      if (!p) return;
      const v = await openDialog({ title: 'Wix Embed Code', fields: [{ key: 'base', label: 'Web address where this site\'s pictures are published (optional)', type: 'text', value: app.site.data.meta['site:url'] || '', help: 'Leave empty to put pictures inside the code as data: URLs.' }] });
      if (!v) return;
      const r = exportEmbed(app.site, p, { baseUrl: v.base || undefined });
      await codeDialog('Wix Embed Code', r.html, r.notes, `${slugify(stripExt(baseName(p)))}-embed.html`, 'text/html');
    },
  },
  {
    id: 'wix.exportVelo', label: 'Wix Custom Element', icon: 'extension', tab: TAB, group: 'Wix', origin: 'Wix Velo custom elements',
    keywords: 'wix velo custom element web component shadow dom',
    tip: 'This page as a custom element (web component) script for a Velo Custom Element',
    run: async (app) => {
      const p = pageArg(app);
      if (!p) return;
      const tag = await promptDialog('Wix Custom Element', 'Tag name (must contain a hyphen)', `ql-${slugify(stripExt(baseName(p)))}`);
      if (tag == null) return;
      const r = exportVelo(app.site, p, { tagName: tag || undefined, baseUrl: app.site.data.meta['site:url'] || undefined });
      await codeDialog('Wix Custom Element', r.js, r.notes, `${r.tagName}.js`, 'text/javascript');
    },
  },
  {
    id: 'wix.howTo', label: 'Moving to Wix, Weebly or WordPress', icon: 'help', tab: TAB, group: 'Wix', noRecord: true,
    keywords: 'how to move migrate wix weebly wordpress help',
    tip: 'Step-by-step instructions for bringing pages into hosted site builders',
    run: async () => {
      const content = h('div', { style: 'max-height:60vh;overflow:auto' }, ...HOW_TO.map((s) => h('section', null, h('h3', { style: 'margin:.75em 0 .25em' }, s.title), h('ol', { style: 'margin:0;padding-left:1.4em' }, ...s.steps.map((x) => h('li', { style: 'margin:.25em 0' }, x))))));
      await openDialog({ title: 'Moving to Wix, Weebly or WordPress', wide: true, ok: 'Close', cancel: false, content });
    },
  },
]);

// ------------------------------------------------------------------------------------------
// Other systems and static generators

def([
  {
    id: 'cms.importJoomla', label: 'Import Joomla Template…', icon: 'view_quilt', tab: TAB, group: 'Other Systems', edits: true, origin: 'Joomla templates',
    keywords: 'joomla template jdoc import',
    tip: 'A Joomla template (.zip with templateDetails.xml) becomes a page template and pages',
    run: (app) => importZip(app, 'Import Joomla Template', 'joomla-template'),
  },
  {
    id: 'cms.importGeneric', label: 'Import Theme or Template…', icon: 'auto_awesome_mosaic', tab: TAB, group: 'Other Systems', edits: true, origin: 'Expression Web Import Site Wizard',
    keywords: 'drupal theme template zip import auto detect',
    tip: 'Any theme or template ZIP (WordPress, Joomla, Drupal, Weebly, HTML); the kind is detected',
    run: (app) => importZip(app, 'Import Theme or Template'),
  },
  {
    id: 'cms.exportStatic', label: 'Static Site (.zip)…', icon: 'folder_zip', tab: TAB, group: 'Other Systems', origin: 'Expression Web publishing (templates expanded)',
    keywords: 'static export zip expand templates',
    tip: 'A ZIP of the site with templates and includes expanded and editor markers removed',
    run: async (app) => { await download(await zipFiles(exportStaticFiles(app.site)), `${slugify(app.site.name)}-static.zip`); },
  },
  {
    id: 'cms.exportJekyll', label: 'Jekyll Site…', icon: 'deployed_code', tab: TAB, group: 'Other Systems', origin: 'Jekyll',
    keywords: 'jekyll static site generator front matter layout',
    tip: 'Pages with front matter and _layouts/default.html from the page template',
    run: async (app) => { await download(await zipFiles(exportJekyllFiles(app.site)), `${slugify(app.site.name)}-jekyll.zip`); },
  },
  {
    id: 'cms.exportHugo', label: 'Hugo Site…', icon: 'deployed_code', tab: TAB, group: 'Other Systems', origin: 'Hugo',
    keywords: 'hugo static site generator baseof layout',
    tip: 'content/ with front matter and layouts/_default/baseof.html from the page template',
    run: async (app) => { await download(await zipFiles(exportHugoFiles(app.site)), `${slugify(app.site.name)}-hugo.zip`); },
  },
]);

// ------------------------------------------------------------------------------------------
// Templates, archives, documents

export const TEMPLATE_SOURCES: { name: string; url: string; license: string; paid?: boolean }[] = [
  { name: 'HTML5 UP', url: 'https://html5up.net/', license: 'Free under Creative Commons Attribution 3.0: keep the credit.' },
  { name: 'Start Bootstrap', url: 'https://startbootstrap.com/themes', license: 'Free themes under the MIT license.' },
  { name: 'BootstrapMade', url: 'https://bootstrapmade.com/', license: 'Free versions require keeping the footer credit; a paid license removes it.' },
  { name: 'Templatemo', url: 'https://templatemo.com/', license: 'Free to use; see each template\'s terms.' },
  { name: 'Colorlib', url: 'https://colorlib.com/wp/templates/', license: 'Many free templates under CC BY 3.0: keep the credit link.' },
  { name: 'W3.CSS Templates', url: 'https://www.w3schools.com/w3css/w3css_templates.asp', license: 'Free to use.' },
  { name: 'Bootstrap Examples', url: 'https://getbootstrap.com/docs/5.3/examples/', license: 'MIT license.' },
  { name: 'WordPress.org Theme Directory', url: 'https://wordpress.org/themes/', license: 'GPL; import with Import ▸ WordPress Theme.' },
  { name: 'ThemeForest', url: 'https://themeforest.net/category/site-templates', license: 'Paid; licensed to the buyer (Regular or Extended license).', paid: true },
  { name: 'TemplateMonster', url: 'https://www.templatemonster.com/website-templates/', license: 'Paid; see the license sold with each template.', paid: true },
  { name: 'Creative Market', url: 'https://creativemarket.com/templates/websites', license: 'Paid; licensed to the buyer.', paid: true },
];

function sanitizeName(name: string): string { return slugify(stripExt(name)) || 'page'; }

async function writePageAndOpen(app: App, suggested: string, html: string, title: string): Promise<void> {
  const name = await promptDialog(title, 'Save as page', app.site.freeName(app.page ? dirOf(app.page.path) : '', suggested, 'html'));
  if (!name) return;
  let path = normalizePath(name);
  if (!/\.(html?|xhtml)$/i.test(path)) path += '.html';
  if (app.site.has(path) && !(await confirmDialog(title, `${path} already exists. Replace it?`, 'Replace'))) return;
  app.site.write(path, html);
  app.openFile(path);
}

def([
  {
    id: 'file.importTemplate', label: 'Import Web Template…', icon: 'auto_awesome_mosaic', tab: TAB, group: 'Web Templates', edits: true, origin: 'Expression Web Import Site Wizard', popular: true,
    keywords: 'template theme zip themeforest html5up bootstrap import',
    tip: 'Free or bought HTML templates, WordPress, Joomla, Drupal and Weebly themes (.zip): finds the template inside and opens it as a site',
    run: (app) => importZip(app, 'Import Web Template'),
  },
  {
    id: 'file.templateSources', label: 'Web Template Sources…', icon: 'travel_explore', tab: TAB, group: 'Web Templates', noRecord: true,
    keywords: 'free paid templates download where',
    tip: 'Reputable places to get free and paid web templates, with license notes',
    run: async (app) => {
      const row = (s: (typeof TEMPLATE_SOURCES)[number]) => h('li', { style: 'margin:.4em 0' }, h('button', { class: 'ql-link', type: 'button', onclick: () => app.followLink(s.url) }, s.name), ' — ', s.license);
      const content = h('div', { class: 'ql-msg', style: 'max-height:60vh;overflow:auto' },
        h('p', null, 'Download the template\'s ZIP file, then use Import ▸ Web Template. The editor finds the template folder inside (skipping documentation and design files) and opens it as a site.'),
        h('h3', null, 'Free'), h('ul', null, ...TEMPLATE_SOURCES.filter((s) => !s.paid).map(row)),
        h('h3', null, 'Paid marketplaces'), h('ul', null, ...TEMPLATE_SOURCES.filter((s) => s.paid).map(row)),
        h('p', null, 'Always read the license: free templates often require a visible credit, and paid templates are licensed to the buyer, usually for one site (or one end product) per license.'));
      await openDialog({ title: 'Web Template Sources', wide: true, ok: 'Close', cancel: false, content });
    },
  },
  {
    id: 'file.importMhtml', label: 'Import Web Archive (.mht)…', icon: 'archive', tab: 'Backstage', group: 'Import', edits: true, origin: 'Internet Explorer / Word "Web Page, Single File"',
    keywords: 'mht mhtml web archive single file import',
    tip: 'A page saved by a browser as "Web Page, Single File", with its pictures',
    run: async (app) => {
      const f = await pick('.mht,.mhtml', ['message/rfc822', 'multipart/related', 'application/x-mimearchive']);
      if (!f) return;
      const r = parseMhtml(f.bytes);
      const name = sanitizeName(r.title || f.name);
      const mode = app.site.pages().length > 1 ? await choiceDialog('Import Web Archive', `"${r.title || f.name}" with ${r.files.size} resource(s).`, ['Add to This Site', 'Open as New Site']) : 1;
      if (mode < 0) return;
      if (mode === 1) {
        const site = new Site(r.title || stripExt(f.name));
        site.write('index.html', r.html, { silent: true });
        for (const [p, v] of r.files) site.write(p, v, { silent: true });
        app.setSite(site, { open: 'index.html' });
      } else {
        const dir = app.page ? dirOf(app.page.path) : '';
        let page = app.site.freeName(dir, name, 'html');
        page = (await promptDialog('Import Web Archive', 'Save as page', page)) || '';
        if (!page) return;
        const d = dirOf(page);
        for (const [p, v] of r.files) app.site.write(joinPath(d, p), v);
        app.site.write(page, r.html);
        app.openFile(page);
      }
      if (r.report?.length) toast(r.report[0], { ms: 5000 });
    },
  },
  {
    id: 'file.exportMhtml', label: 'Export Web Archive (.mht)…', icon: 'archive', tab: 'Backstage', group: 'Export', origin: 'Internet Explorer / Word "Web Page, Single File"',
    keywords: 'mht mhtml web archive single file export',
    tip: 'This page and every file it uses in one web archive file',
    run: async (app) => {
      const p = pageArg(app);
      if (!p) return;
      const text = buildMhtml(app.site, p);
      await download(new Blob([text], { type: 'multipart/related' }), `${stripExt(baseName(p))}.mht`);
    },
  },
  {
    id: 'file.importWord', label: 'Import Word Document (HTML)…', icon: 'description', tab: 'Backstage', group: 'Import', edits: true, origin: 'FrontPage / Expression Web "Optimize HTML" for Word',
    keywords: 'word office html clean mso google docs paste',
    tip: 'Cleans HTML saved from a word processor (or pasted) into a new page',
    run: async (app) => {
      const v = await openDialog({
        title: 'Import Word Document',
        help: 'In the word processor, save as "Web Page" (.htm), or copy the text and paste its HTML here. Office markup, conditional comments and mso- styles are removed.',
        wide: true,
        fields: [
          { key: 'file', label: 'HTML file', type: 'file', accept: '.htm,.html,.xhtml' },
          { key: 'paste', label: 'Or paste HTML', type: 'textarea', rows: 6, placeholder: '<p class=MsoNormal>…' },
          { key: 'paste2', label: 'Paste formatted text from the clipboard', type: 'button', onClick: async (_v: Record<string, any>, ctl: DialogControl) => { const html = await readClipboardHtml(); if (html) ctl.set('paste', html); else toast('No formatted text on the clipboard (or reading it was not allowed).'); } },
          { key: 'styles', label: 'Keep basic formatting (colors, alignment)', type: 'checkbox', value: true },
        ],
      });
      if (!v) return;
      let html = String(v.paste || '');
      let name = 'document';
      if (v.file) { html = decodeText(new Uint8Array(await (v.file as File).arrayBuffer())); name = sanitizeName((v.file as File).name); }
      if (!html.trim()) { toast('Choose a file or paste HTML.'); return; }
      const r = cleanWordHtml(html, { keepStyles: !!v.styles });
      await writePageAndOpen(app, name === 'document' ? sanitizeName(r.title) : name, r.html, 'Import Word Document');
      if (r.report.length) await showReport('Import Word Document', r.report);
    },
  },
  {
    id: 'file.importMarkdown', label: 'Import Markdown…', icon: 'markdown', tab: 'Backstage', group: 'Import', edits: true, origin: 'Markdown (CommonMark, GitHub tables)',
    keywords: 'markdown md commonmark gfm import',
    tip: 'A Markdown file becomes a page',
    run: async (app) => {
      const f = await pick('.md,.markdown,.mdown,.txt', ['text/markdown', 'text/plain']);
      if (!f) return;
      const r = markdownToPage(decodeText(f.bytes), f.name);
      await writePageAndOpen(app, sanitizeName(f.name), r.html, 'Import Markdown');
    },
  },
  {
    id: 'file.importPsd', label: 'Import Photoshop File…', icon: 'image', tab: 'Backstage', group: 'Import', origin: 'Expression Web Photoshop import', noRecord: true,
    keywords: 'psd photoshop layers mockup tracing',
    tip: 'Layered Photoshop files cannot be turned into pages here; use a flattened picture as a tracing image instead',
    run: async (app) => {
      const choices = ['Use a Picture as Tracing Image…', 'Insert a Picture…'];
      const i = await choiceDialog('Import Photoshop File', 'Layered Photoshop (.psd) files are not supported: turning layers into HTML and CSS needs the layers\' text, effects and fonts, which only a design tool can read reliably. Export the design (or each slice) from your design tool as PNG or JPEG, then use it as a tracing image to rebuild the layout over it, or insert it as a picture.', choices);
      if (i === 0) { if (getCommand('view.tracingImage')) app.exec('view.tracingImage'); else toast('Tracing images are not available in this version.'); }
      if (i === 1) { const id = ['insert.picture', 'insert.image'].find((x) => getCommand(x)); if (id) app.exec(id); else toast('Use File ▸ Import ▸ Files to add the picture.'); }
    },
  },
]);

async function readClipboardHtml(): Promise<string | null> {
  try {
    const items = await (navigator.clipboard as any)?.read?.();
    for (const it of items || []) if (it.types.includes('text/html')) return await (await it.getType('text/html')).text();
  } catch { /* not allowed */ }
  return null;
}
