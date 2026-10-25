/** File backstage: Home, New, Open, Info, Save As, Import, Export, Publish, Print, Share, Options. */
import type { App } from '../app';
import { h, icon, clear } from './dom';
import { TEMPLATES, type TemplateDef } from '../templates';
import { kvKeys, kvGet, kvDel } from '../util/store';
import { wordCount } from '../model/html';
import { isImagePath } from '../model/paths';

const PAGES: [string, string, string][] = [
  ['home', 'Home', 'home'], ['new', 'New', 'note_add'], ['open', 'Open', 'folder_open'], ['info', 'Info', 'info'],
  ['save', 'Save', 'save'], ['saveas', 'Save As', 'save_as'], ['import', 'Import', 'download'], ['export', 'Export', 'ios_share'],
  ['publish', 'Publish', 'cloud_upload'], ['print', 'Print', 'print'], ['close', 'Close', 'close'], ['options', 'Options', 'settings'],
];

export function renderBackstage(app: App, root: HTMLElement, page: string): void {
  clear(root);
  const nav = h('nav', { class: 'ql-bs-nav' }, h('button', { class: 'ql-bs-back', onclick: () => app.ui.hideBackstage(), 'aria-label': 'Back to the site' }, icon('arrow_back'), ' Back'));
  for (const [id, label, ic] of PAGES) {
    nav.appendChild(h('button', { class: 'ql-bs-item' + (id === page ? ' ql-on' : ''), onclick: () => {
      if (id === 'save') { app.ui.hideBackstage(); app.exec('file.save'); return; }
      if (id === 'close') { app.ui.hideBackstage(); app.exec('file.close'); return; }
      if (id === 'options') { app.exec('file.options'); return; }
      renderBackstage(app, root, id);
    } }, icon(ic), ' ', label));
  }
  const body = h('div', { class: 'ql-bs-body' });
  root.append(nav, body);
  const card = (title: string, sub: string, ic: string, onclick: () => void) => h('button', { class: 'ql-bs-card', onclick }, icon(ic, 'ql-bs-card-icon'), h('div', null, h('b', null, title), h('div', { class: 'ql-help' }, sub)));
  const run = (id: string, arg?: any) => () => { app.ui.hideBackstage(); app.exec(id, arg); };
  const tplGrid = (list: TemplateDef[]) => {
    const grid = h('div', { class: 'ql-bs-templates' });
    for (const t of list) grid.appendChild(h('button', { class: 'ql-template', onclick: run(t.kind === 'site' ? 'file.newSite' : 'file.newPage', { template: t.id }) }, h('div', { class: 'ql-template-thumb', style: `background:${t.swatch || 'var(--ql-surface)'}` }, icon(t.kind === 'site' ? 'language' : 'web')), h('b', null, t.name), h('div', { class: 'ql-help' }, t.description)));
    return grid;
  };
  switch (page) {
    case 'home': {
      const hr = new Date().getHours();
      body.appendChild(h('h1', null, 'Good ' + (hr < 12 ? 'morning' : hr < 18 ? 'afternoon' : 'evening')));
      body.appendChild(h('div', { class: 'ql-bs-cards' },
        card('New Page', 'A blank HTML5 page in this site', 'note_add', run('file.newPage')),
        card('New Site', 'Start a site from a template', 'language', () => renderBackstage(app, root, 'new')),
        card('Open Site…', 'A folder of web files on this device', 'folder_open', run('file.openSite')),
        card('Open File…', 'A page, style sheet, ZIP, .qlsite or export file', 'file_open', run('file.open')),
        card('Import a Web Template…', 'Free or bought HTML, WordPress, Weebly or Joomla template (.zip)', 'auto_awesome_mosaic', run('file.importTemplate')),
        card('Import WordPress Export…', 'Pages and posts from a WordPress export (.xml)', 'article', run('wp.importWxr'))));
      body.appendChild(h('h2', null, 'Templates'));
      body.appendChild(tplGrid(TEMPLATES.filter((t) => t.kind === 'site').slice(0, 6)));
      body.appendChild(h('h2', null, 'Recent'));
      recentList(app, body);
      break;
    }
    case 'new': {
      body.appendChild(h('h1', null, 'New'));
      body.appendChild(h('h2', null, 'Sites'));
      body.appendChild(tplGrid(TEMPLATES.filter((t) => t.kind === 'site')));
      body.appendChild(h('h2', null, 'Pages'));
      body.appendChild(tplGrid(TEMPLATES.filter((t) => t.kind === 'page')));
      body.appendChild(h('div', { class: 'ql-bs-cards' },
        card('Style Sheet', 'A new .css file', 'css', run('file.newCss')), card('JavaScript', 'A new .js file', 'javascript', run('file.newJs')),
        card('PHP Page', 'A new .php page', 'php', run('file.newPhp')), card('Page Template (.dwt)', 'Pages attached to it share its layout', 'dashboard', run('file.newDwtFile')),
        card('Page from Template…', 'A page attached to one of the site\'s .dwt templates', 'dashboard_customize', run('file.newFromDwt')),
        card('Web Template Sources…', 'Where to find free and paid templates you can import', 'travel_explore', run('file.templateSources'))));
      const mine = h('div', { class: 'ql-bs-templates' });
      body.append(h('h2', null, 'My Templates'), mine);
      void kvKeys('tpl:').then(async (keys) => {
        if (!keys.length) mine.appendChild(h('p', { class: 'ql-help' }, 'Use File ▸ Save As ▸ Template to keep a page or a whole site as your own template.'));
        for (const k of keys) {
          const t = await kvGet(k);
          mine.appendChild(h('div', { class: 'ql-template' }, h('button', { class: 'ql-link', onclick: run('file.newFromMyTemplate', k) }, h('b', null, t?.name || k)), h('div', { class: 'ql-help' }, t?.kind === 'site' ? 'Site' : 'Page'), h('button', { class: 'ql-iconbtn ql-sm', title: 'Delete template', onclick: async () => { await kvDel(k); renderBackstage(app, root, 'new'); } }, icon('delete'))));
        }
      });
      break;
    }
    case 'open': {
      body.append(h('h1', null, 'Open'),
        h('div', { class: 'ql-bs-cards' },
          card('Open Site Folder…', 'Edit a folder in place (the desktop app and Chromium browsers write back to it)', 'folder_open', run('file.openSite')),
          card('Open File…', 'Pages, style sheets, scripts, .qlsite, .zip, .mht, WordPress .xml', 'file_open', run('file.open')),
          card('Open from Web Address…', 'Download a published page or site (the desktop app can reach any site)', 'public', run('file.openUrl')),
          card('Recover Unsaved Site', 'The draft kept automatically before a crash or close', 'restore_page', run('file.recoverUnsaved'))),
        h('h2', null, 'Recent'));
      recentList(app, body, true);
      break;
    }
    case 'info': {
      const s = app.site;
      const pages = s.pages();
      const bytes = s.list().reduce((n, f) => n + (f.data?.length ?? new Blob([f.text || '']).size), 0);
      const words = pages.reduce((n, f) => n + wordCount(f.text || ''), 0);
      body.append(h('h1', null, 'Info'), h('h2', null, s.name),
        h('div', { class: 'ql-bs-cards' },
          card('Site Settings', 'Name, home page, language, publishing defaults', 'settings', run('site.settings')),
          card('Site Summary Report', 'Files, pictures, broken links, slow pages', 'summarize', run('site.reportSummary')),
          card('Check Links', 'Find broken links and unlinked files', 'link_off', run('site.checkLinks')),
          card('Accessibility', 'Check every page', 'accessibility_new', run('site.reportAccessibility')),
          card('Page Properties', 'Title, description, keywords, language of the current page', 'description', run('file.pageProperties')),
          card('Version History', 'Snapshots of the current file', 'history', run('edit.history'))),
        h('table', { class: 'ql-stats' }, ...[
          ['Files', String(s.files.size)], ['Pages', String(pages.length)], ['Pictures', String(s.list((f) => isImagePath(f.path)).length)],
          ['Style sheets', String(s.list((f) => /\.css$/i.test(f.path)).length)], ['Words on pages', words.toLocaleString()], ['Total size', `${(bytes / 1024).toFixed(1)} KB`],
          ['Home page', s.homePage], ['Location', s.folder ? (s.folder.kind === 'desktop' ? s.folder.root : 'Folder on this device') : app.siteFile ? app.siteFile.name : 'Not saved yet'],
          ['Publishing destinations', String(s.data.publish.length)], ['Tasks', String(s.data.tasks.filter((t) => t.status !== 'Completed').length)],
        ].map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v)))));
      break;
    }
    case 'saveas': {
      body.append(h('h1', null, 'Save As'), h('div', { class: 'ql-bs-cards' },
        card('Page As…', 'Save the current file under another name in the site', 'save_as', run('file.saveAs')),
        card('Site to Folder…', 'Write every file into a folder on this device', 'drive_folder_upload', run('file.saveSiteToFolder')),
        card('Site as Anne\'s Loom Site (.qlsite)…', 'One file with every page, picture and setting', 'inventory_2', run('file.exportQlsite')),
        card('Site as ZIP…', 'Every file, ready to upload anywhere', 'folder_zip', run('file.exportZip')),
        card('Page as Template…', 'Keep this page as one of My Templates', 'bookmark_add', run('file.saveAsMyTemplate', 'page')),
        card('Site as Template…', 'Keep the whole site as one of My Templates', 'bookmarks', run('file.saveAsMyTemplate', 'site')),
        card('Page Template (.dwt)…', 'Make a page template from this page', 'dashboard', run('template.saveAsTemplate'))));
      break;
    }
    case 'import': {
      body.append(h('h1', null, 'Import'), h('div', { class: 'ql-bs-cards' },
        card('Files…', 'Add pages, pictures, style sheets to the site', 'upload_file', run('file.importFiles')),
        card('Folder…', 'Add a folder of files', 'drive_folder_upload', run('file.importFolder')),
        card('Web Template (.zip)…', 'HTML/CSS templates (free or bought), WordPress and Joomla themes, Weebly themes', 'auto_awesome_mosaic', run('file.importTemplate')),
        card('WordPress Export (.xml)…', 'Pages, posts, menus and media links (Tools ▸ Export in WordPress)', 'article', run('wp.importWxr')),
        card('WordPress Theme (.zip)…', 'Its templates become static pages and a page template', 'palette', run('wp.importTheme')),
        card('WordPress Site (REST API)…', 'Pages and posts straight from a running WordPress site', 'cloud_download', run('wp.importFromSite')),
        card('Weebly Site Archive (.zip)…', 'The archive Weebly makes of a published site', 'web', run('weebly.importArchive')),
        card('Weebly Theme (.zip)…', 'Theme files with {content}, {menu} and other tags', 'brush', run('weebly.importTheme')),
        card('Wix Site by Address…', 'Saves the published pages and pictures of a Wix site', 'public', run('wix.importFromUrl')),
        card('Word / HTML Document…', 'Clean up and import word-processor HTML', 'description', run('file.importWord')),
        card('Web Archive (.mht)…', 'A page saved by a browser with its pictures', 'archive', run('file.importMhtml')),
        card('Markdown…', 'Markdown files become pages', 'markdown', run('file.importMarkdown'))));
      break;
    }
    case 'export': {
      body.append(h('h1', null, 'Export'), h('div', { class: 'ql-bs-cards' },
        card('ZIP of the Site', 'Every published file', 'folder_zip', run('file.exportZip')),
        card('Anne\'s Loom Site (.qlsite)', 'Everything including settings and tasks', 'inventory_2', run('file.exportQlsite')),
        card('Copy of This File…', 'Save the current file anywhere', 'download', run('file.exportFile')),
        card('Web Archive (.mht)', 'This page with its pictures in one file', 'archive', run('file.exportMhtml')),
        card('PDF / Print', 'Print the page or save it as PDF', 'picture_as_pdf', run('file.exportPdf')),
        card('WordPress Export (.xml)', 'Import into any WordPress site (Tools ▸ Import ▸ WordPress)', 'article', run('wp.exportWxr')),
        card('WordPress Theme (.zip)', 'A classic theme built from this site\'s design', 'palette', run('wp.exportTheme')),
        card('WordPress Blocks', 'This page as block-editor markup to paste into WordPress', 'view_agenda', run('wp.exportBlocks')),
        card('Weebly Theme (.zip)', 'A custom theme to upload in Weebly\'s theme editor', 'brush', run('weebly.exportTheme')),
        card('Wix Embed', 'This page as code for a Wix "Embed HTML" element', 'code', run('wix.exportEmbed')),
        card('Static Site for Jekyll / Hugo', 'Front matter and layouts for static site generators', 'deployed_code', run('cms.exportJekyll'))));
      break;
    }
    case 'publish': {
      body.append(h('h1', null, 'Publish'), h('div', { class: 'ql-bs-cards' },
        card('Publish Site…', 'Choose a destination and publish changed files', 'cloud_upload', run('site.publish')),
        card('Manage Destinations…', 'Folders, WebDAV, FTP, WordPress', 'settings_ethernet', run('site.managePublishing')),
        card('Publish to WordPress…', 'Create or update pages and posts through the REST API', 'article', run('wp.publish')),
        card('Publish Log', 'What was published, and when', 'receipt_long', run('site.publishLog'))));
      break;
    }
    case 'print': {
      body.append(h('h1', null, 'Print'), h('div', { class: 'ql-bs-cards' },
        card('Print…', 'Print the page as it looks in Preview', 'print', run('file.print')),
        card('Print Code', 'Print the source with line numbers', 'code', run('file.printCode')),
        card('Print Preview', 'Preview with print style sheets', 'preview', run('file.printPreview'))));
      break;
    }
  }
}

function recentList(app: App, body: HTMLElement, full = false) {
  const list = h('div', { class: 'ql-recent' });
  const rec = app.prefs.recent;
  if (!rec.length) list.appendChild(h('p', { class: 'ql-help' }, 'Sites and files you open or save appear here.'));
  for (const r of rec.slice(0, full ? 40 : 8)) {
    list.appendChild(h('div', { class: 'ql-recent-row' },
      h('button', { class: 'ql-recent-open', onclick: () => { app.ui.hideBackstage(); app.exec('file.openRecent', r.key); } }, icon(r.format === 'site' ? 'language' : 'html'), h('div', null, h('b', null, r.name), h('div', { class: 'ql-help' }, new Date(r.when).toLocaleString()))),
      h('button', { class: 'ql-iconbtn', title: r.pinned ? 'Unpin' : 'Pin', onclick: () => { r.pinned = !r.pinned; app.savePrefs(); renderBackstage(app, body.parentElement!, full ? 'open' : 'home'); } }, icon(r.pinned ? 'keep_off' : 'keep')),
      h('button', { class: 'ql-iconbtn', title: 'Remove from list', onclick: () => { app.prefs.recent = app.prefs.recent.filter((x) => x !== r); app.savePrefs(); renderBackstage(app, body.parentElement!, full ? 'open' : 'home'); } }, icon('close'))));
  }
  if (full && rec.length) list.appendChild(h('button', { class: 'ql-btn', onclick: () => app.exec('file.clearRecent') }, 'Clear unpinned'));
  body.appendChild(list);
}
