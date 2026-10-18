/**
 * Default tab and group arrangement. Groups reference command ids only, so users can rebuild any of it
 * with Customize Tabs. Contextual tabs appear when the selection is in a table, a picture or a form,
 * or when a page template is open.
 */
import type { App } from '../app';

export interface RibbonGroup { id: string; label: string; items: string[]; launcher?: string }
export interface RibbonTab { id: string; label: string; groups: RibbonGroup[]; contextual?: (app: App) => boolean; accent?: string; custom?: boolean }

const selIn = (app: App, selector: string): boolean => {
  const t = app.active;
  if (!t || t.kind !== 'page' || t.view === 'code' || t.view === 'preview') return false;
  const el = t.ui?.design?.selected as Element | null;
  return !!el?.closest?.(selector);
};

export const DEFAULT_TABS: RibbonTab[] = [
  {
    id: 'home', label: 'Home', groups: [
      { id: 'clipboard', label: 'Clipboard', items: ['edit.paste', 'edit.cut', 'edit.copy', 'edit.pasteText', 'edit.formatPainter'], launcher: 'edit.pasteSpecial' },
      { id: 'font', label: 'Font', items: ['format.fontFamily', 'format.fontSize', 'format.bold', 'format.italic', 'format.underline', 'format.strikethrough', 'format.superscript', 'format.subscript', 'format.color', 'format.highlight', 'format.removeFormatting'], launcher: 'format.font' },
      { id: 'paragraph', label: 'Paragraph', items: ['format.blockStyle', 'format.bullets', 'format.numbering', 'format.outdent', 'format.indent', 'format.alignLeft', 'format.alignCenter', 'format.alignRight', 'format.justify', 'format.bordersShading'], launcher: 'format.paragraph' },
      { id: 'styles', label: 'Styles', items: ['css.classGallery', 'css.newStyle', 'css.applyStyles'], launcher: 'css.manageStyles' },
      { id: 'editing', label: 'Editing', items: ['edit.find', 'edit.replace', 'edit.findInSite', 'edit.selectAll', 'tag.selectParent'] },
      { id: 'view', label: 'View', items: ['view.design', 'view.split', 'view.code', 'view.preview', 'file.previewBrowser'] },
    ],
  },
  {
    id: 'insert', label: 'Insert', groups: [
      { id: 'pages', label: 'Pages', items: ['file.newPage', 'file.newFromTemplate', 'insert.file'] },
      { id: 'structure', label: 'Structure', items: ['insert.div', 'insert.section', 'insert.header', 'insert.nav', 'insert.main', 'insert.footer', 'insert.layer', 'insert.columns', 'insert.htmlMenu'] },
      { id: 'tables', label: 'Tables', items: ['table.insert', 'table.draw', 'data.fromCsv'] },
      { id: 'media', label: 'Pictures & Media', items: ['insert.image', 'insert.photoGallery', 'insert.video', 'insert.audio', 'insert.youtube', 'insert.svg', 'insert.mediaMenu'] },
      { id: 'links', label: 'Links', items: ['insert.hyperlink', 'insert.bookmark', 'insert.emailLink', 'insert.interactiveButton', 'insert.linkBar'] },
      { id: 'forms', label: 'Forms', items: ['form.form', 'form.textbox', 'form.textarea', 'form.checkbox', 'form.radio', 'form.select', 'form.submit', 'form.menu'] },
      { id: 'components', label: 'Components', items: ['insert.componentMenu', 'insert.includePage', 'insert.navbar', 'insert.hero', 'insert.cards', 'insert.contactForm', 'insert.snippet'] },
      { id: 'text', label: 'Text', items: ['insert.hr', 'insert.br', 'insert.symbol', 'insert.dateTime', 'insert.comment', 'insert.specialMenu'] },
      { id: 'code', label: 'Code', items: ['insert.tag', 'insert.html', 'insert.headMenu', 'insert.scriptMenu', 'insert.phpMenu', 'insert.serverMenu', 'insert.frameworkMenu'] },
    ],
  },
  {
    id: 'design', label: 'Design', groups: [
      { id: 'page', label: 'Page', items: ['file.pageProperties', 'format.background', 'format.doctype', 'format.encoding', 'format.theme'] },
      { id: 'css', label: 'CSS', items: ['css.newStyle', 'css.attachStyleSheet', 'css.manageStyles', 'css.applyStyles', 'panel.cssProperties', 'css.inlineToRule', 'css.moveRules', 'css.variables'] },
      { id: 'responsive', label: 'Responsive', items: ['css.mediaQueries', 'view.pageSize', 'file.previewSizes', 'ai.makeResponsive'] },
      { id: 'type', label: 'Typography', items: ['css.webFonts', 'insert.googleFont', 'format.editFontList'] },
      { id: 'templates', label: 'Page Templates', items: ['template.attach', 'template.detach', 'template.updateAll', 'template.manageRegions', 'template.editableRegion', 'template.newFromPage'] },
      { id: 'library', label: 'Library Items', items: ['template.addLibraryItem', 'template.insertLibraryItem', 'template.updateLibraryAll'] },
      { id: 'frameworks', label: 'Frameworks', items: ['insert.bootstrap', 'insert.tailwind', 'insert.picoCss', 'insert.fontAwesome'] },
    ],
  },
  {
    id: 'layout', label: 'Layout', groups: [
      { id: 'position', label: 'Position', items: ['format.position', 'format.positionAbsolute', 'format.positionRelative', 'format.bringToFront', 'format.sendToBack', 'panel.layers'] },
      { id: 'align', label: 'Align Layers', items: ['format.alignLeftEdges', 'format.alignTops', 'format.alignRightEdges', 'format.alignBottoms', 'format.sameWidth', 'format.sameHeight'] },
      { id: 'box', label: 'Box', items: ['format.bordersShading', 'format.boxModel', 'format.flexbox', 'format.cssGrid'] },
      { id: 'aids', label: 'Visual Aids', items: ['view.aidBlocks', 'view.aidCssLayout', 'view.aidEmpty', 'view.aidMargins', 'view.aidForms', 'view.aidTables', 'view.aidInvisibles'] },
      { id: 'grid', label: 'Ruler & Grid', items: ['view.rulers', 'view.grid', 'view.snapToGrid', 'view.gridSettings', 'view.tracingImage'] },
      { id: 'frames', label: 'Frames', items: ['frame.newFrameset', 'insert.iframe', 'frame.properties'] },
    ],
  },
  {
    id: 'site', label: 'Site', groups: [
      { id: 'files', label: 'Files', items: ['site.newFolder', 'site.newFile', 'site.rename', 'site.deleteFile', 'site.setHome', 'panel.folders'] },
      { id: 'publish', label: 'Publish', items: ['site.publish', 'site.publishChanged', 'site.synchronize', 'site.managePublishing', 'site.publishLog'] },
      { id: 'reports', label: 'Reports', items: ['site.reportSummary', 'site.checkLinks', 'site.reportMenu', 'panel.hyperlinks', 'site.recalcHyperlinks'] },
      { id: 'nav', label: 'Navigation', items: ['site.navigation', 'insert.linkBar', 'site.sitemapXml', 'site.robotsTxt', 'site.rssFeed'] },
      { id: 'team', label: 'Team', items: ['site.checkOut', 'site.checkIn', 'site.undoCheckOut', 'site.tasks'] },
      { id: 'settings', label: 'Settings', items: ['site.settings', 'file.saveSiteAs', 'file.exportZip'] },
    ],
  },
  {
    id: 'cms', label: 'CMS & Builders', groups: [
      { id: 'wordpress', label: 'WordPress', items: ['wp.importWxr', 'wp.importTheme', 'wp.importFromSite', 'wp.exportWxr', 'wp.exportTheme', 'wp.exportBlocks', 'wp.publish', 'wp.connect'] },
      { id: 'weebly', label: 'Weebly', items: ['weebly.importArchive', 'weebly.importTheme', 'weebly.exportTheme', 'weebly.tags'] },
      { id: 'wix', label: 'Wix', items: ['wix.importFromUrl', 'wix.exportEmbed', 'wix.exportVelo', 'wix.howTo'] },
      { id: 'other', label: 'Other Systems', items: ['cms.importJoomla', 'cms.importGeneric', 'cms.exportStatic', 'cms.exportJekyll', 'cms.exportHugo'] },
      { id: 'templates', label: 'Web Templates', items: ['file.importTemplate', 'file.templateSources', 'file.newSiteFromTemplate'] },
    ],
  },
  {
    id: 'review', label: 'Check', groups: [
      { id: 'proofing', label: 'Proofing', items: ['tools.spelling', 'tools.spellingSite', 'tools.thesaurus', 'tools.setLanguage', 'tools.wordCount'] },
      { id: 'validate', label: 'Validate', items: ['tools.validate', 'tools.validateXml', 'tools.accessibility', 'tools.compatibility', 'site.checkLinksPage', 'panel.cssReports'] },
      { id: 'seo', label: 'SEO & Speed', items: ['tools.seoCheck', 'tools.performance', 'insert.metaDescription', 'insert.openGraph'] },
      { id: 'cleanup', label: 'Clean Up', items: ['tools.optimizeHtml', 'tools.cleanupWord', 'tools.cleanupMenu', 'tools.minifyPage'] },
      { id: 'compare', label: 'Compare', items: ['tools.compareFiles', 'site.compareRemote', 'edit.history'] },
    ],
  },
  {
    id: 'code', label: 'Code', groups: [
      { id: 'edit', label: 'Edit', items: ['code.comment', 'code.indent', 'code.outdent', 'code.format', 'code.formatSelection', 'edit.goToLine'] },
      { id: 'tags', label: 'Tags', items: ['tag.quickEdit', 'tag.wrap', 'tag.remove', 'tag.selectParent', 'tag.selectChild', 'code.matchingTag', 'code.balanceTags'] },
      { id: 'collapse', label: 'Collapse', items: ['code.fold', 'code.unfold', 'code.foldAll', 'code.unfoldAll'] },
      { id: 'assist', label: 'Assist', items: ['code.complete', 'code.emmet', 'code.snippetsInsert', 'tools.colorPicker', 'tools.loremIpsum'] },
      { id: 'case', label: 'Case & Markup', items: ['code.lowerTags', 'code.upperTags', 'tools.toXhtml', 'tools.toHtml5', 'tools.externalizeJs', 'tools.externalizeCss'] },
      { id: 'options', label: 'Options', items: ['view.codeWrap', 'view.codeLineNumbers', 'view.codeFold', 'view.codeComplete', 'view.codeAutoClose'] },
    ],
  },
  {
    id: 'view', label: 'View', groups: [
      { id: 'page', label: 'Page Views', items: ['view.design', 'view.split', 'view.code', 'view.preview', 'view.splitVertical'] },
      { id: 'site', label: 'Site Views', items: ['view.folders', 'view.navigationView', 'view.hyperlinks', 'view.reports', 'view.tasksView', 'view.remoteSite'] },
      { id: 'panels', label: 'Panels', items: ['panel.folders', 'panel.tagProperties', 'panel.cssProperties', 'panel.toolbox', 'panel.applyStyles', 'panel.manageStyles', 'panel.snippets', 'panel.menu'] },
      { id: 'size', label: 'Page Size', items: ['view.pageSize', 'view.zoomIn', 'view.zoomOut', 'view.zoom100'] },
      { id: 'menus', label: 'Menus', items: ['view.menuStyle', 'view.classicLayout', 'view.collapseRibbon', 'view.quickTagSelector'] },
      { id: 'window', label: 'Window', items: ['window.next', 'window.closeAll', 'view.fullScreen', 'view.cmdSearch'] },
    ],
  },
  {
    id: 'ai', label: 'AI', groups: [
      { id: 'setup', label: 'Setup', items: ['ai.setup', 'ai.active', 'ai.providers', 'ai.privacy', 'ai.stop'] },
      { id: 'create', label: 'Create', items: ['ai.generatePage', 'ai.generateSite', 'ai.generateSection', 'ai.generateFromSketch', 'ai.cloneLayout'] },
      { id: 'write', label: 'Write', items: ['ai.writeCopy', 'ai.rewrite', 'ai.shorten', 'ai.expand', 'ai.tone', 'ai.proofread', 'ai.translate'] },
      { id: 'code', label: 'Code', items: ['ai.explainCode', 'ai.fixCode', 'ai.generateCss', 'ai.generateJs', 'ai.makeResponsive', 'ai.modernize'] },
      { id: 'optimize', label: 'Optimize', items: ['ai.seo', 'ai.metaTags', 'ai.altText', 'ai.accessibilityFix', 'ai.schema', 'ai.reviewPage'] },
      { id: 'more', label: 'More', items: ['ai.assistant', 'ai.prompts', 'ai.blogPost', 'ai.faq'] },
      { id: 'several', label: 'Several AIs', items: ['ai.ensembleMode', 'ai.ensembleMembers', 'ai.showDeliberation'] },
    ],
  },
  {
    id: 'developer', label: 'Developer', groups: [
      { id: 'macros', label: 'Macros', items: ['dev.macros', 'dev.recordMacro', 'dev.stopRecording', 'dev.macroEditor'] },
      { id: 'behaviors', label: 'Behaviors', items: ['behavior.add', 'panel.behaviors', 'behavior.list'] },
      { id: 'data', label: 'Data', items: ['data.dataView', 'data.fromCsv', 'data.fromJson'] },
      { id: 'tools', label: 'Tools', items: ['tools.jsConsole', 'tools.extensions', 'tools.addins', 'dev.exportSiteJson'] },
    ],
  },
  {
    id: 'help', label: 'Help', groups: [
      { id: 'help', label: 'Help', items: ['help.help', 'help.shortcuts', 'help.commandReference', 'help.menuMap', 'help.htmlReference', 'help.cssReference', 'help.tour', 'help.whatsNew', 'help.feedback', 'help.notices', 'help.about'] },
    ],
  },
  // Contextual tabs
  {
    id: 'tableDesign', label: 'Table Design', contextual: (app) => selIn(app, 'table'), accent: '#2F6F8F', groups: [
      { id: 'styles', label: 'Table Styles', items: ['table.autoFormat', 'table.stripes', 'table.headerCells', 'table.responsive', 'table.bordersMenu'] },
      { id: 'props', label: 'Properties', items: ['table.properties', 'table.cellProperties', 'table.insertCaption'] },
    ],
  },
  {
    id: 'tableLayout', label: 'Table Layout', contextual: (app) => selIn(app, 'table'), accent: '#2F6F8F', groups: [
      { id: 'select', label: 'Select', items: ['table.selectTable', 'table.selectRow', 'table.selectCol', 'table.selectCell'] },
      { id: 'rows', label: 'Rows & Columns', items: ['table.insertRowAbove', 'table.insertRowBelow', 'table.insertColLeft', 'table.insertColRight', 'table.deleteRows', 'table.deleteCols', 'table.delete'] },
      { id: 'merge', label: 'Merge', items: ['table.mergeCells', 'table.splitCells', 'table.splitTable'] },
      { id: 'size', label: 'Size', items: ['table.distributeRows', 'table.distributeCols', 'table.autofit', 'table.widthsToPercent', 'table.widthsToPixels'] },
      { id: 'data', label: 'Data', items: ['table.sort', 'table.fillDown', 'table.fillRight', 'table.tableToText', 'table.toCssGrid'] },
    ],
  },
  {
    id: 'pictureFormat', label: 'Picture', contextual: (app) => selIn(app, 'img'), accent: '#C2502A', groups: [
      { id: 'props', label: 'Properties', items: ['picture.properties', 'picture.alt', 'picture.swap', 'picture.resetSize'] },
      { id: 'edit', label: 'Edit', items: ['picture.crop', 'picture.resample', 'picture.rotateLeft', 'picture.rotateRight', 'picture.flipH', 'picture.flipV', 'picture.brightness', 'picture.grayscale'] },
      { id: 'web', label: 'Web', items: ['picture.autoThumbnail', 'picture.toWebp', 'picture.optimize', 'picture.responsive', 'picture.lazy'] },
      { id: 'map', label: 'Image Map', items: ['picture.hotspot', 'picture.clearHotspots'] },
    ],
  },
  {
    id: 'formTools', label: 'Form', contextual: (app) => selIn(app, 'form'), accent: '#6B4E9B', groups: [
      { id: 'props', label: 'Properties', items: ['form.properties', 'form.fieldProperties', 'form.validation'] },
      { id: 'fields', label: 'Fields', items: ['form.textbox', 'form.email', 'form.textarea', 'form.checkbox', 'form.radio', 'form.select', 'form.file', 'form.hidden', 'form.label', 'form.fieldset', 'form.submit'] },
    ],
  },
  {
    id: 'templateTools', label: 'Template', contextual: (app) => /\.dwt$/i.test(app.active?.path || ''), accent: '#3F8F7A', groups: [
      { id: 'regions', label: 'Regions', items: ['template.editableRegion', 'template.optionalRegion', 'template.repeatingRegion', 'template.manageRegions', 'template.checkSyntax'] },
      { id: 'pages', label: 'Attached Pages', items: ['template.updateAll', 'template.listPages', 'file.newFromDwt'] },
    ],
  },
];

export const BACKSTAGE_ITEMS = ['file.newPage', 'file.open', 'file.openSite', 'file.save', 'file.saveAs', 'file.saveAll', 'file.print', 'site.publish', 'file.exportZip', 'file.properties', 'file.close', 'file.options'];

export function tabsFor(app: App): RibbonTab[] {
  const p = app.prefs;
  const order = p.tabOrder.length ? p.tabOrder : [];
  const builtIn = DEFAULT_TABS.filter((t) => !p.hiddenTabs.includes(t.id));
  const custom: RibbonTab[] = p.customTabs.filter((t) => !t.hidden).map((t) => ({ id: t.id, label: t.label, groups: t.groups, custom: true }));
  const all = [...builtIn, ...custom];
  if (!order.length) return all;
  return [...all].sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
}

export function idsInTabs(): Set<string> {
  const s = new Set<string>();
  for (const t of DEFAULT_TABS) for (const g of t.groups) for (const id of g.items) s.add(id);
  return s;
}
