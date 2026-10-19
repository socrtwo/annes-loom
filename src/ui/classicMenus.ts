/**
 * Classic menu bars. Each layout reproduces where the desktop web editors put their commands, so people
 * who learned one of them find every command where they expect it. Items are command ids; '|' is a
 * separator; { label, items } is a submenu. A command missing from the registry is skipped, so a
 * layout can name every command its editor had. Labels come from the commands themselves.
 *
 * Layouts (nominative references; see docs/MENUS.md for the source of each menu):
 *   expression  — Expression Web 4 family
 *   frontpage   — FrontPage 2000–2003 family
 *   dreamweaver — Dreamweaver CS3–CC family
 *   composer    — Netscape/Mozilla/SeaMonkey Composer, Nvu, KompoZer, BlueGriffon family
 *   union       — every command of all of them, merged by menu
 */
export type ClassicItem = string | { label: string; icon?: string; items: ClassicItem[] };
export interface ClassicMenu { label: string; items: ClassicItem[] }

const sub = (label: string, items: ClassicItem[], icon?: string): ClassicItem => ({ label, items, icon });

// ------------------------------------------------------------------------------------------
// Shared submenus

const NEW: ClassicItem = sub('New', ['file.newPage', 'file.newCss', 'file.newJs', 'file.newPhp', 'file.newXml', 'file.newText', 'file.newFromTemplate', 'file.newFromDwt', 'file.newFluid', '|', 'file.newSite', 'file.newSiteFromTemplate', 'file.newSiteFromExisting', 'file.newBlankSite'], 'note_add');
const IMPORT: ClassicItem = sub('Import', ['file.importFiles', 'file.importFolder', 'file.importSiteWizard', 'file.importZip', 'file.importTemplate', '|', 'wp.importWxr', 'wp.importTheme', 'wp.importFromSite', 'weebly.importArchive', 'weebly.importTheme', 'wix.importFromUrl', 'cms.importJoomla', 'cms.importGeneric', '|', 'file.importWord', 'file.importTabular', 'file.importMhtml', 'file.importMarkdown', 'file.importPsd', 'file.importXml'], 'download');
const EXPORT: ClassicItem = sub('Export', ['file.exportFile', 'file.exportZip', 'file.exportPackage', 'file.exportQlsite', 'file.exportMhtml', 'file.exportText', 'file.exportPdf', 'file.exportTable', 'file.exportTemplateXml', '|', 'wp.exportWxr', 'wp.exportTheme', 'wp.exportBlocks', 'weebly.exportTheme', 'wix.exportEmbed', 'cms.exportStatic'], 'upload');
const PREVIEW: ClassicItem = sub('Preview in Browser', ['file.previewBrowser', 'file.previewMultiple', 'file.previewSizes', 'file.previewPrint', 'file.editBrowsers'], 'travel_explore');
const RECENT: ClassicItem = sub('Recent', ['file.openRecent', 'file.openRecentSite', 'file.clearRecent'], 'history');

const VISUAL_AIDS: ClassicItem = sub('Visual Aids', ['view.aidsShow', '|', 'view.aidBlocks', 'view.aidCssLayout', 'view.aidEmpty', 'view.aidMargins', 'view.aidForms', 'view.aidTables', 'view.aidInvisibles', 'view.aidRegions', 'view.aidHidden'], 'border_outer');
const FORMATTING_MARKS: ClassicItem = sub('Formatting Marks', ['view.marksShow', 'view.marksTags', 'view.marksParagraphs', 'view.marksBreaks', 'view.marksHiddenFields', 'view.marksBookmarks'], 'format_paragraph');
const RULER_GRID: ClassicItem = sub('Ruler and Grid', ['view.rulers', 'view.grid', 'view.snapToGrid', 'view.guides', 'view.gridSettings', 'view.resetOrigin'], 'grid_on');
const TRACING: ClassicItem = sub('Tracing Image', ['view.tracingImage', 'view.tracingShow', 'view.tracingAlign', 'view.tracingAdjust', 'view.tracingReset'], 'image');
const PAGE_MODES: ClassicItem = sub('Page', ['view.design', 'view.split', 'view.code', 'view.preview', '|', 'view.splitVertical', 'view.switchViews', 'view.refresh'], 'web');
const CODE_OPTIONS: ClassicItem = sub('Code View Options', ['view.codeWrap', 'view.codeLineNumbers', 'view.codeFold', 'view.codeHighlightLine', 'view.codeAutoClose', 'view.codeComplete', 'view.codeHiddenChars', 'view.codeHighlightInvalid', 'view.codeFontSize'], 'code');
const ZOOM: ClassicItem = sub('Zoom', ['view.zoomIn', 'view.zoomOut', 'view.zoom100', 'view.zoom', 'view.zoomFitWidth'], 'zoom_in');
const STYLE_RENDER: ClassicItem = sub('Style Rendering', ['view.mediaScreen', 'view.mediaPrint', 'view.mediaDark', 'view.mediaReducedMotion', 'view.disableStyles'], 'brush');

const PANELS: ClassicItem[] = ['panel.folders', 'panel.navigation', 'panel.tagProperties', 'panel.cssProperties', 'panel.toolbox', 'panel.applyStyles', 'panel.manageStyles', 'panel.behaviors', 'panel.layers', 'panel.snippets', 'panel.assets', 'panel.find', 'panel.hyperlinks', 'panel.tasks', 'panel.reports', 'panel.accessibility', 'panel.compatibility', 'panel.validation', 'panel.cssReports', 'panel.history', 'panel.outline', 'panel.ai', '|', 'panel.closeAll', 'panel.resetLayout'];

const HTML_TEXT: ClassicItem = sub('Text Objects', ['insert.paragraph', 'insert.h1', 'insert.h2', 'insert.h3', 'insert.h4', 'insert.h5', 'insert.h6', 'insert.blockquote', 'insert.pre', 'insert.address', '|', 'insert.ul', 'insert.ol', 'insert.dl', '|', 'insert.abbr', 'insert.cite', 'insert.code', 'insert.dfn', 'insert.kbd', 'insert.samp', 'insert.var', 'insert.q', 'insert.mark', 'insert.small', 'insert.sub', 'insert.sup', 'insert.time', 'insert.del', 'insert.ins'], 'text_fields');
const HTML_LAYOUT: ClassicItem = sub('Layout Objects', ['insert.div', 'insert.section', 'insert.article', 'insert.aside', 'insert.header', 'insert.footer', 'insert.nav', 'insert.main', 'insert.figure', 'insert.details', 'insert.dialog', 'insert.layer', 'insert.iframe', 'insert.fluidGrid', 'insert.columns', 'insert.flexRow', 'insert.gridLayout'], 'dashboard');
const HTML_HEAD: ClassicItem = sub('Head Tags', ['insert.meta', 'insert.metaKeywords', 'insert.metaDescription', 'insert.metaRefresh', 'insert.metaViewport', 'insert.metaRobots', 'insert.base', 'insert.linkTag', 'insert.favicon', 'insert.openGraph', 'insert.twitterCard', 'insert.jsonLd', 'insert.canonical'], 'data_object');
const HTML_SCRIPT: ClassicItem = sub('Script Objects', ['insert.script', 'insert.scriptFile', 'insert.noscript', 'insert.template'], 'javascript');
const SPECIAL_CHARS: ClassicItem = sub('Special Characters', ['insert.br', 'insert.nbsp', 'insert.copyright', 'insert.registered', 'insert.trademark', 'insert.pound', 'insert.yen', 'insert.euro', 'insert.leftQuote', 'insert.rightQuote', 'insert.emDash', 'insert.enDash', 'insert.ellipsis', 'insert.softHyphen', 'insert.symbol', 'insert.emoji'], 'special_character');
const MEDIA: ClassicItem = sub('Media', ['insert.video', 'insert.audio', 'insert.youtube', 'insert.vimeo', 'insert.map', 'insert.flash', 'insert.object', 'insert.embed', 'insert.applet', 'insert.activex', 'insert.plugin', 'insert.svg', 'insert.canvas', 'insert.picture', 'insert.pictureElement'], 'movie');
const PHP: ClassicItem = sub('PHP', ['insert.phpBlock', 'insert.phpEcho', 'insert.phpInclude', 'insert.phpRequire', 'insert.phpIf', 'insert.phpElse', 'insert.phpForeach', 'insert.phpFormVar', 'insert.phpUrlVar', 'insert.phpSessionVar', 'insert.phpCookie'], 'php');
const SERVER: ClassicItem = sub('Server-Side', ['insert.ssi', 'insert.ssiEcho', 'insert.aspBlock', 'insert.aspInclude', 'insert.jspBlock', 'insert.handlebars', 'insert.liquid'], 'dns');
const WEB_COMPONENTS: ClassicItem = sub('Web Component', ['insert.marquee', 'insert.hitCounter', 'insert.photoGallery', 'insert.linkBar', 'insert.breadcrumbs', 'insert.tocSite', 'insert.tocPage', 'insert.pageBanner', 'insert.includePage', 'insert.scheduledInclude', 'insert.scheduledPicture', 'insert.substitution', 'insert.lastUpdated', 'insert.searchForm', 'insert.feedbackForm', 'insert.contactForm', 'insert.newsletterForm', 'insert.socialLinks', 'insert.shareButtons', 'insert.cookieBanner', 'insert.backToTop', 'insert.carousel', 'insert.tabs', 'insert.accordion', 'insert.modal', 'insert.lightbox', 'insert.navbar', 'insert.pricingTable', 'insert.testimonials', 'insert.hero', 'insert.cards', 'insert.timeline', 'insert.countdown', 'insert.rssFeed'], 'widgets');
const FRAMEWORKS: ClassicItem = sub('Frameworks', ['insert.bootstrap', 'insert.tailwind', 'insert.picoCss', 'insert.bulma', 'insert.foundation', 'insert.jquery', 'insert.alpine', 'insert.fontAwesome', 'insert.googleFont', 'insert.normalize', 'insert.analytics'], 'deployed_code');
const TEMPLATE_OBJECTS: ClassicItem = sub('Template Objects', ['template.makeTemplate', 'template.makeNested', 'template.editableRegion', 'template.optionalRegion', 'template.repeatingRegion', 'template.editableOptional', 'template.repeatingTable', 'template.editableAttribute'], 'dashboard_customize');
const FORM_ITEMS: ClassicItem[] = ['form.form', '|', 'form.textbox', 'form.textarea', 'form.password', 'form.email', 'form.tel', 'form.url', 'form.number', 'form.range', 'form.date', 'form.time', 'form.datetime', 'form.month', 'form.week', 'form.color', 'form.search', 'form.file', '|', 'form.checkbox', 'form.radio', 'form.radioGroup', 'form.select', 'form.listBox', 'form.datalist', 'form.jumpMenu', '|', 'form.button', 'form.submit', 'form.reset', 'form.imageButton', 'form.advancedButton', 'form.hidden', 'form.label', 'form.fieldset', 'form.output', 'form.progress', 'form.meter', '|', 'form.properties', 'form.fieldProperties', 'form.validation'];
const DATE_TIME: ClassicItem[] = ['insert.date', 'insert.dateTime'];

const TABLE_INSERT: ClassicItem = sub('Insert', ['table.insert', 'table.insertRowAbove', 'table.insertRowBelow', 'table.insertColLeft', 'table.insertColRight', 'table.insertRowsCols', 'table.insertCell', 'table.insertCaption', 'table.insertHeader', 'table.insertFooter'], 'add');
const TABLE_DELETE: ClassicItem = sub('Delete', ['table.delete', 'table.deleteRows', 'table.deleteCols', 'table.deleteCells'], 'delete');
const TABLE_SELECT: ClassicItem = sub('Select', ['table.selectTable', 'table.selectRow', 'table.selectCol', 'table.selectCell'], 'select_all');
const TABLE_MODIFY: ClassicItem = sub('Modify', ['table.distributeRows', 'table.distributeCols', 'table.autofit', 'table.fillDown', 'table.fillRight', 'table.increaseRowSpan', 'table.decreaseRowSpan', 'table.increaseColSpan', 'table.decreaseColSpan', 'table.clearHeights', 'table.clearWidths', 'table.widthsToPixels', 'table.widthsToPercent', 'table.headerCells'], 'tune');
const TABLE_CONVERT: ClassicItem = sub('Convert', ['table.textToTable', 'table.tableToText', 'table.toDivs', 'table.toCssGrid', 'table.apDivsToTable'], 'transform');
const TABLE_PROPS: ClassicItem = sub('Table Properties', ['table.properties', 'table.cellProperties', 'table.autoFormat', 'table.sort', 'table.stripes', 'table.responsive'], 'settings');

const TEMPLATES_MENU: ClassicItem = sub('Page Template', ['template.attach', 'template.detach', 'template.openAttached', 'template.updatePage', 'template.updateAll', 'template.updatePages', 'template.manageRegions', 'template.checkSyntax', 'template.exportNoMarkup', 'template.removeMarkup', 'template.properties', 'template.newFromPage'], 'dashboard');
const LIBRARY_MENU: ClassicItem = sub('Library', ['template.addLibraryItem', 'template.insertLibraryItem', 'template.updateLibraryPage', 'template.updateLibraryAll', 'template.detachLibraryItem'], 'library_books');
const CSS_MENU: ClassicItem = sub('CSS Styles', ['css.newStyle', 'css.newStyleFromSelection', 'css.attachStyleSheet', 'css.detachStyleSheet', 'css.manageStyles', 'css.applyStyles', 'css.inlineToRule', 'css.moveRules', 'css.exportStyles', 'css.designTime', 'css.mediaQueries', 'css.webFonts', 'css.variables', 'css.minify', 'css.format', 'css.removeUnused', 'css.prefix'], 'css');
const BEHAVIORS: ClassicItem = sub('Behaviors', ['behavior.add', 'behavior.swapImage', 'behavior.swapRestore', 'behavior.preloadImages', 'behavior.popupMessage', 'behavior.openWindow', 'behavior.goToUrl', 'behavior.jumpMenu', 'behavior.showHide', 'behavior.changeProperty', 'behavior.setText', 'behavior.validateForm', 'behavior.playSound', 'behavior.callScript', 'behavior.checkBrowser', 'behavior.effects', 'behavior.dragElement', 'behavior.statusBar', 'behavior.remove', 'behavior.list'], 'bolt');
const LAYERS: ClassicItem = sub('Layers / Positioning', ['format.position', 'format.positionAbsolute', 'format.positionRelative', 'format.bringToFront', 'format.sendToBack', 'format.bringForward', 'format.sendBackward', 'format.alignLeftEdges', 'format.alignTops', 'format.alignRightEdges', 'format.alignBottoms', 'format.sameWidth', 'format.sameHeight', 'format.preventOverlaps', 'format.layerProperties'], 'layers');

const SPELLING: ClassicItem[] = ['tools.spelling', 'tools.spellingSite', 'tools.thesaurus', 'tools.setLanguage', 'tools.dictionary'];
const REPORTS: ClassicItem = sub('Reports', ['site.reportSummary', '|', 'site.reportAllFiles', 'site.reportRecentlyAdded', 'site.reportRecentlyChanged', 'site.reportOlderFiles', 'site.reportUnlinked', 'site.reportSlowPages', 'site.reportBrokenLinks', 'site.reportExternalLinks', 'site.reportComponentErrors', 'site.reportMissingAlt', 'site.reportMissingTitles', 'site.reportDuplicateTitles', 'site.reportUnusedStyles', 'site.reportStyleLinks', 'site.reportTemplates', 'site.reportCheckedOut', 'site.reportReviewStatus', 'site.reportAssignedTo', 'site.reportCategories', 'site.reportPublishStatus', 'site.reportSeo', 'site.reportAccessibility', 'site.reportCompatibility', 'site.reportCss'], 'summarize');
const CHECK_PAGE: ClassicItem = sub('Check Page', ['tools.validate', 'tools.validateXml', 'tools.accessibility', 'tools.compatibility', 'site.checkLinksPage', 'tools.seoCheck', 'tools.performance'], 'fact_check');
const CLEANUP: ClassicItem = sub('Clean Up', ['tools.optimizeHtml', 'tools.cleanupHtml', 'tools.cleanupWord', 'tools.removeEmptyTags', 'tools.removeComments', 'tools.removeFontTags', 'tools.fontToCss', 'tools.inlineToClasses', 'tools.externalizeJs', 'tools.externalizeCss', 'tools.toXhtml', 'tools.toHtml5', 'tools.fixEncoding', 'tools.minifyPage', 'tools.minifySite'], 'cleaning_services');
const SOURCE_FMT: ClassicItem = sub('Source Formatting', ['code.format', 'code.formatSelection', 'code.formatSite', 'code.formatSettings', 'code.upperTags', 'code.lowerTags'], 'format_align_left');
const MACROS: ClassicItem = sub('Macros', ['dev.recordMacro', 'dev.stopRecording', 'dev.pauseRecording', 'dev.playLast', 'dev.macros', 'dev.macroEditor', 'dev.importMacros', 'dev.exportMacros'], 'smart_button');
const CHECKOUT: ClassicItem[] = ['site.checkOut', 'site.checkIn', 'site.undoCheckOut', 'site.showCheckedOut'];
const PUBLISH: ClassicItem[] = ['site.publish', 'site.publishFile', 'site.publishChanged', 'site.publishAll', 'site.synchronize', 'site.get', 'site.put', 'site.compareRemote', 'site.publishSettings', 'site.publishLog'];
const NAV: ClassicItem[] = ['site.navigation', 'site.addToNav', 'site.removeFromNav', 'site.navRebuild', 'site.navProperties', 'site.sitemapXml', 'site.robotsTxt', 'site.rssFeed', 'site.searchIndex'];

const AI_MENU: ClassicItem[] = ['ai.setup', 'ai.active', 'ai.providers', 'ai.settings', 'ai.stop', '|',
  sub('Create', ['ai.generatePage', 'ai.generateSite', 'ai.generateSection', 'ai.generateFromSketch', 'ai.cloneLayout', 'ai.generateImage', 'ai.placeholderContent']),
  sub('Write', ['ai.writeCopy', 'ai.rewrite', 'ai.shorten', 'ai.expand', 'ai.tone', 'ai.proofread', 'ai.translate', 'ai.translateSite', 'ai.headline', 'ai.callToAction']),
  sub('Code', ['ai.explainCode', 'ai.fixCode', 'ai.refactor', 'ai.generateCss', 'ai.generateJs', 'ai.makeResponsive', 'ai.convertFramework', 'ai.commentCode', 'ai.modernize']),
  sub('Optimize', ['ai.seo', 'ai.metaTags', 'ai.altText', 'ai.altTextSite', 'ai.accessibilityFix', 'ai.performance', 'ai.schema', 'ai.reviewPage']),
  sub('Content', ['ai.summarize', 'ai.faq', 'ai.blogPost', 'ai.productCopy', 'ai.privacyPolicy', 'ai.terms', 'ai.errorPage']),
  '|', 'ai.assistant', 'ai.prompts', 'ai.ensembleMode', 'ai.ensembleMembers', 'ai.showDeliberation', 'ai.privacy'];

const HELP: ClassicItem[] = ['help.help', 'help.shortcuts', 'help.commandReference', 'help.menuMap', 'help.htmlReference', 'help.cssReference', 'help.tour', 'help.whatsNew', 'help.feedback', 'help.notices', 'help.about'];

// ------------------------------------------------------------------------------------------
// Expression Web 4 family

const expression: ClassicMenu[] = [
  { label: 'File', items: [NEW, 'file.open', 'file.openSite', 'file.close', 'file.closeSite', '|', 'file.save', 'file.saveAs', 'file.saveAll', 'file.saveSiteAs', '|', IMPORT, EXPORT, '|', PREVIEW, '|', 'file.pageProperties', 'file.properties', RECENT, '|', 'file.print', 'file.printPreview', 'file.pageSetup', '|', 'file.exit'] },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '|', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteText', 'edit.pasteSpecial', 'edit.delete', '|', 'edit.selectAll', '|', 'edit.find', 'edit.replace', 'edit.findInSite', 'edit.goToLine', 'edit.goToFunction', 'code.matchingTag', 'code.matchingBrace', 'tag.select', 'tag.selectContents', 'tag.edit', '|', sub('IntelliSense', ['code.complete', 'code.hints', 'code.emmet', 'code.snippetsInsert']), sub('Code View', ['code.comment', 'code.uncomment', 'code.indent', 'code.outdent', 'code.fold', 'code.unfold', 'code.foldAll', 'code.unfoldAll', 'code.toggleBookmark', 'code.nextBookmark', 'code.prevBookmark']), '|', ...CHECKOUT, '|', 'edit.history'] },
  { label: 'View', items: [PAGE_MODES, 'view.folders', 'view.remoteSite', 'view.reports', 'view.hyperlinks', 'view.navigationView', 'view.tasksView', '|', VISUAL_AIDS, FORMATTING_MARKS, RULER_GRID, TRACING, '|', 'view.pageSize', ZOOM, STYLE_RENDER, CODE_OPTIONS, '|', 'view.quickTagSelector', 'view.menuStyle', 'view.classicLayout', 'view.collapseRibbon', 'view.fullScreen', 'view.refresh'] },
  { label: 'Insert', items: [sub('HTML', ['insert.paragraph', 'insert.hr', 'insert.br', 'insert.div', 'insert.span', HTML_TEXT, HTML_LAYOUT, HTML_HEAD, HTML_SCRIPT, 'insert.tag', 'insert.html']), sub('Form', FORM_ITEMS), PHP, SERVER, MEDIA, '|', 'insert.layer', 'insert.image', 'insert.interactiveButton', 'insert.rolloverImage', '|', 'insert.hyperlink', 'insert.bookmark', 'insert.symbol', 'insert.comment', ...DATE_TIME, '|', WEB_COMPONENTS, FRAMEWORKS, 'insert.snippet', 'insert.file'] },
  { label: 'Format', items: ['format.font', 'format.paragraph', 'format.bulletsNumbering', 'format.bordersShading', 'format.position', BEHAVIORS, LAYERS, 'format.background', '|', TEMPLATES_MENU, CSS_MENU, '|', 'format.removeFormatting', 'format.doctype', 'format.cssMode', 'format.encoding'] },
  { label: 'Tools', items: [...SPELLING, '|', CHECK_PAGE, 'tools.browserCompat', 'tools.superPreview', '|', 'tools.optimizeHtml', 'tools.autoThumbnail', 'tools.imageOptimize', 'tools.snippetsManager', 'tools.colorPicker', 'tools.loremIpsum', 'tools.charMap', 'tools.calculator', '|', 'tools.addins', 'file.customizeKeyboard', 'tools.pageEditorOptions', 'file.options'] },
  { label: 'Table', items: [TABLE_INSERT, TABLE_DELETE, TABLE_SELECT, '|', 'table.mergeCells', 'table.splitCells', 'table.splitTable', TABLE_MODIFY, TABLE_CONVERT, '|', TABLE_PROPS] },
  { label: 'Site', items: ['site.newFolder', 'site.newFile', 'site.rename', 'site.deleteFile', 'site.setHome', '|', ...PUBLISH, '|', REPORTS, 'site.hyperlinks', 'site.recalcHyperlinks', 'site.checkLinks', 'site.changeLinkSitewide', '|', ...NAV, '|', 'site.tasks', 'site.settings', 'site.managePublishing'] },
  { label: 'Panels', items: PANELS },
  { label: 'AI', items: AI_MENU },
  { label: 'Window', items: ['window.next', 'window.previous', 'window.closeAll', 'window.closeOthers', 'window.list', 'window.newWindow'] },
  { label: 'Help', items: HELP },
];

// ------------------------------------------------------------------------------------------
// FrontPage 2003 family

const frontpage: ClassicMenu[] = [
  { label: 'File', items: [NEW, 'file.open', 'file.openSite', 'file.close', 'file.closeSite', '|', 'file.save', 'file.saveAs', 'file.saveAll', '|', 'file.search', IMPORT, EXPORT, '|', 'site.publish', 'file.previewBrowser', '|', 'file.pageSetup', 'file.printPreview', 'file.print', '|', 'file.email', 'file.properties', RECENT, '|', 'file.exit'] },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '|', 'edit.cut', 'edit.copy', 'edit.officeClipboard', 'edit.paste', 'edit.pasteSpecial', '|', 'edit.delete', 'edit.selectAll', '|', 'edit.find', 'edit.replace', 'edit.goToLine', 'tag.edit', '|', ...CHECKOUT, '|', 'edit.tasks', 'code.snippetsInsert'] },
  { label: 'View', items: [PAGE_MODES, 'view.folders', 'view.remoteSite', REPORTS, 'view.navigationView', 'view.hyperlinks', 'view.tasksView', '|', 'view.revealTags', 'view.quickTagSelector', RULER_GRID, TRACING, '|', 'panel.folders', 'panel.navigation', 'view.taskPane', 'view.toolbars', 'view.refresh'] },
  { label: 'Insert', items: ['insert.br', 'insert.hr', 'insert.layer', 'insert.iframe', '|', ...DATE_TIME, 'insert.symbol', 'insert.comment', '|', 'insert.linkBar', 'insert.pageBanner', WEB_COMPONENTS, sub('Database', ['data.insertResults', 'data.columnValue', 'data.searchForm', 'data.dataView', 'data.fromCsv', 'data.fromJson']), sub('Form', FORM_ITEMS), sub('Picture', ['insert.image', 'insert.clipArt', 'insert.photoGallery', 'insert.video', 'insert.flash', 'insert.shape', 'insert.decorativeText', 'insert.svg']), 'insert.interactiveButton', 'insert.file', 'insert.bookmark', 'insert.hyperlink'] },
  { label: 'Format', items: ['format.font', 'format.paragraph', 'format.bulletsNumbering', 'format.bordersShading', 'format.position', BEHAVIORS, LAYERS, '|', 'format.theme', 'format.styles', 'css.attachStyleSheet', 'format.sharedBorders', 'format.pageTransition', 'format.background', '|', 'format.removeFormatting', 'format.properties', TEMPLATES_MENU] },
  { label: 'Tools', items: [...SPELLING, '|', 'tools.accessibility', 'tools.browserCompat', '|', 'tools.autoThumbnail', 'site.recalcHyperlinks', 'tools.optimizeHtml', '|', sub('Server', ['site.publishSettings', 'site.permissions', 'site.serverInfo']), MACROS, 'tools.addins', 'file.customizeRibbon', '|', 'site.settings', 'tools.pageEditorOptions', 'file.options'] },
  { label: 'Table', items: ['table.layoutTables', 'table.draw', TABLE_INSERT, TABLE_DELETE, TABLE_SELECT, '|', 'table.mergeCells', 'table.splitCells', 'table.splitTable', '|', 'table.autoFormat', 'table.distributeRows', 'table.distributeCols', 'table.autofit', TABLE_CONVERT, sub('Fill', ['table.fillDown', 'table.fillRight']), '|', TABLE_PROPS] },
  { label: 'Data', items: ['data.dataView', 'data.dataSources', 'data.findSource', 'data.style', 'data.filter', 'data.sortGroup', 'data.conditional', 'data.refresh', 'data.fromCsv', 'data.fromJson'] },
  { label: 'Frames', items: ['frame.newFrameset', 'frame.split', 'frame.delete', 'frame.openInNewWindow', 'frame.savePage', 'frame.savePageAs', 'frame.properties', 'frame.noFrames', 'insert.iframe'] },
  { label: 'AI', items: AI_MENU },
  { label: 'Window', items: ['window.newWindow', 'window.closeAll', 'window.next', 'window.previous', 'window.list'] },
  { label: 'Help', items: HELP },
];

// ------------------------------------------------------------------------------------------
// Dreamweaver family

const dreamweaver: ClassicMenu[] = [
  { label: 'File', items: [NEW, 'file.newFluid', 'file.open', RECENT, 'file.openInFrame', 'file.close', 'file.closeAll', '|', 'file.save', 'file.saveAs', 'file.saveAll', 'file.saveRelated', 'template.saveAsTemplate', 'file.revert', '|', 'file.printCode', IMPORT, EXPORT, 'tools.toHtml5', '|', PREVIEW, 'file.previewSizes', CHECK_PAGE, sub('Validate', ['tools.validate', 'tools.validateXml']), 'site.compareRemote', 'file.designNotes', '|', 'file.exit'] },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '|', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteSpecial', 'edit.delete', 'edit.selectAll', 'tag.selectParent', 'tag.selectChild', '|', 'edit.find', 'edit.findSelection', 'edit.findNext', 'edit.findInSite', 'edit.goToLine', 'code.hints', 'code.indent', 'code.outdent', 'code.matchingBrace', sub('Repeating Entries', ['template.repeatingRegion', 'template.repeatingTable']), sub('Code Collapse', ['code.fold', 'code.unfold', 'code.foldAll', 'code.unfoldAll']), 'edit.externalEditor', 'edit.tagLibraries', '|', 'file.customizeKeyboard', 'file.options'] },
  { label: 'View', items: [ZOOM, '|', 'view.code', 'view.split', 'view.design', 'view.splitVertical', 'view.switchViews', 'view.preview', 'view.liveCode', 'view.inspect', 'view.refresh', 'view.headContent', 'view.noscriptContent', sub('Table Mode', ['view.expandedTables']), VISUAL_AIDS, STYLE_RENDER, CODE_OPTIONS, 'view.pageSize', RULER_GRID, TRACING, sub('Plugins', ['view.playPlugins', 'view.stopPlugins']), 'view.relatedFiles', 'view.hidePanels', 'view.toolbars'] },
  { label: 'Insert', items: ['insert.tag', 'insert.image', sub('Image Objects', ['insert.imagePlaceholder', 'insert.rolloverImage', 'insert.interactiveButton', 'insert.imageMap']), MEDIA, 'css.mediaQueries', 'table.insert', sub('Table Objects', ['table.importTabular']), HTML_LAYOUT, sub('Form', FORM_ITEMS), 'insert.hyperlink', 'insert.emailLink', 'insert.bookmark', ...DATE_TIME, 'insert.ssi', 'insert.comment', sub('HTML', ['insert.hr', sub('Frames', ['frame.newFrameset', 'frame.split', 'frame.properties']), HTML_TEXT, HTML_SCRIPT, HTML_HEAD, SPECIAL_CHARS]), TEMPLATE_OBJECTS, 'insert.snippet', WEB_COMPONENTS, FRAMEWORKS, sub('Data Objects', ['data.dataView', 'data.fromCsv', 'data.fromJson']), PHP, SERVER] },
  { label: 'Modify', items: ['file.pageProperties', 'template.properties', 'tag.properties', CSS_MENU, 'css.webFonts', '|', 'tag.edit', 'tag.quickEdit', '|', 'insert.hyperlink', 'format.removeLink', 'edit.followLink', 'format.linkTarget', '|', sub('Table', ['table.selectTable', 'table.mergeCells', 'table.splitCells', 'table.insertRowBelow', 'table.insertColRight', 'table.insertRowsCols', 'table.deleteRows', 'table.deleteCols', 'table.increaseRowSpan', 'table.increaseColSpan', 'table.decreaseRowSpan', 'table.decreaseColSpan', 'table.clearHeights', 'table.clearWidths', 'table.widthsToPixels', 'table.widthsToPercent']), sub('Image', ['picture.externalEditor', 'picture.optimize', 'picture.crop', 'picture.resample', 'picture.brightness', 'picture.sharpen', 'picture.rotateLeft', 'picture.rotateRight', 'picture.flipH', 'picture.flipV', 'picture.toWebp', 'picture.grayscale']), sub('Frameset', ['frame.split', 'frame.delete', 'frame.properties']), LAYERS, sub('Convert', ['table.toDivs', 'table.apDivsToTable']), '|', LIBRARY_MENU, sub('Templates', ['template.attach', 'template.detach', 'template.openAttached', 'template.checkSyntax', 'template.updatePage', 'template.updatePages', 'template.exportNoMarkup', 'template.removeMarkup', 'template.properties', 'template.editableAttribute'])] },
  { label: 'Format', items: ['format.indent', 'format.outdent', sub('Paragraph Format', ['format.blockNone', 'format.blockP', 'format.blockH1', 'format.blockH2', 'format.blockH3', 'format.blockH4', 'format.blockH5', 'format.blockH6', 'format.blockPre', 'format.blockAddress', 'format.blockQuote']), sub('Align', ['format.alignLeft', 'format.alignCenter', 'format.alignRight', 'format.justify']), sub('List', ['format.listNone', 'format.bullets', 'format.numbering', 'format.definitionList', 'format.listProperties']), sub('Font', ['format.fontFamily', 'format.editFontList']), sub('Style', ['format.bold', 'format.italic', 'format.underline', 'format.strikethrough', 'format.teletype', 'format.emphasis', 'format.strong', 'format.code', 'format.variable', 'format.sample', 'format.keyboard', 'format.citation', 'format.definition', 'format.deleted', 'format.inserted', 'format.superscript', 'format.subscript']), CSS_MENU, 'format.color', 'format.highlight'] },
  { label: 'Commands', items: [MACROS, '|', 'tools.extensions', SOURCE_FMT, 'tools.cleanupHtml', 'tools.cleanupWord', 'tools.externalizeJs', 'tools.imageOptimize', 'table.sort', 'table.autoFormat', 'tools.spelling', 'tools.photoAlbum', 'tools.emmet'] },
  { label: 'Site', items: ['file.newSite', 'site.manageSites', '|', 'site.get', 'site.checkOut', 'site.put', 'site.checkIn', 'site.undoCheckOut', 'site.showCheckedOut', 'site.locateInSite', '|', REPORTS, 'site.synchronize', 'site.checkLinks', 'site.changeLinkSitewide', sub('Advanced', ['site.publishLog', 'site.recalcHyperlinks', 'site.deployFiles'])] },
  { label: 'Window', items: [...PANELS, '|', 'window.cascade', 'window.tile', 'window.next', 'window.previous', 'window.closeAll'] },
  { label: 'AI', items: AI_MENU },
  { label: 'Help', items: HELP },
];

// ------------------------------------------------------------------------------------------
// Composer family (Netscape/Mozilla/SeaMonkey Composer, Nvu, KompoZer, BlueGriffon)

const composer: ClassicMenu[] = [
  { label: 'File', items: [NEW, 'file.open', 'file.openUrl', RECENT, '|', 'file.save', 'file.saveAs', 'file.saveAsCharset', 'file.exportText', '|', 'site.publish', 'site.publishAs', 'file.previewBrowser', '|', 'file.pageSetup', 'file.print', 'file.close', 'file.exit'] },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '|', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteText', 'edit.delete', 'edit.selectAll', '|', 'edit.find', 'edit.findNext', 'tools.spelling', '|', 'site.publishSettings', 'file.options'] },
  { label: 'View', items: ['view.toolbars', '|', 'view.design', 'view.revealTags', 'view.code', 'view.preview', '|', 'format.encoding', 'view.rulers'] },
  { label: 'Insert', items: ['insert.hyperlink', 'insert.bookmark', 'insert.image', 'insert.hr', 'table.insert', sub('Form', FORM_ITEMS), 'insert.html', 'insert.symbol', 'insert.math', 'insert.smiley', 'insert.br', 'insert.breakBelowImages', 'insert.video', 'insert.audio', TEMPLATE_OBJECTS] },
  { label: 'Format', items: ['format.fontFamily', 'format.fontSize', sub('Text Style', ['format.bold', 'format.italic', 'format.underline', 'format.strikethrough', 'format.superscript', 'format.subscript', 'format.nobreak', 'format.emphasis', 'format.strong', 'format.citation', 'format.abbreviation', 'format.acronym', 'format.code', 'format.sample', 'format.variable']), 'format.color', 'format.removeTextStyles', 'format.removeLink', 'format.removeAnchors', '|', sub('Paragraph', ['format.blockP', 'format.blockH1', 'format.blockH2', 'format.blockH3', 'format.blockH4', 'format.blockH5', 'format.blockH6', 'format.blockAddress', 'format.blockPre', 'format.blockNone']), sub('List', ['format.listNone', 'format.bullets', 'format.numbering', 'format.definitionList', 'format.listProperties']), sub('Align', ['format.alignLeft', 'format.alignCenter', 'format.alignRight', 'format.justify']), 'format.positionAbsolute', 'format.bringToFront', 'format.sendToBack', 'format.indent', 'format.outdent', '|', 'format.pageColors', 'file.pageProperties', 'css.editor'] },
  { label: 'Table', items: [TABLE_INSERT, TABLE_SELECT, TABLE_DELETE, '|', 'table.mergeCells', 'table.splitCells', 'table.textToTable', '|', 'table.properties'] },
  { label: 'Tools', items: ['css.editor', 'tools.cleanupHtml', 'tools.validate', 'tools.jsConsole', 'tools.markupCleaner', MACROS, 'file.options'] },
  { label: 'AI', items: AI_MENU },
  { label: 'Window', items: ['window.list', 'window.next', 'window.previous', 'window.closeAll'] },
  { label: 'Help', items: HELP },
];

// ------------------------------------------------------------------------------------------
// Union: every layout's items merged menu by menu (duplicates removed, order of first appearance).

function union(): ClassicMenu[] {
  const order = ['File', 'Edit', 'View', 'Insert', 'Format', 'Modify', 'Commands', 'Tools', 'Table', 'Data', 'Frames', 'Site', 'Panels', 'AI', 'Window', 'Help'];
  const map = new Map<string, ClassicItem[]>();
  for (const layout of [expression, frontpage, dreamweaver, composer]) {
    for (const m of layout) {
      const label = m.label === 'Window' && layout === dreamweaver ? 'Panels' : m.label;
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push('|', ...m.items);
    }
  }
  return order.filter((l) => map.has(l)).map((label) => ({ label, items: dedupe(map.get(label)!) }));
}

/** Removes items already present (ids, and submenus by label, whose items are merged). */
function dedupe(items: ClassicItem[]): ClassicItem[] {
  const seen = new Set<string>();
  const subs = new Map<string, { label: string; icon?: string; items: ClassicItem[] }>();
  const out: ClassicItem[] = [];
  for (const it of items) {
    if (it === '|') { if (out.length && out[out.length - 1] !== '|') out.push('|'); continue; }
    if (typeof it === 'string') { if (!seen.has(it)) { seen.add(it); out.push(it); } continue; }
    const prev = subs.get(it.label);
    if (prev) { prev.items = dedupe([...prev.items, ...it.items]); continue; }
    const copy = { label: it.label, icon: it.icon, items: dedupe(it.items) };
    subs.set(it.label, copy);
    out.push(copy);
  }
  while (out[0] === '|') out.shift();
  while (out[out.length - 1] === '|') out.pop();
  return out;
}

export const CLASSIC_MENUS: Record<string, ClassicMenu[]> = { expression, frontpage, dreamweaver, composer, union: union() };

export const CLASSIC_LAYOUT_NAMES: Record<string, string> = {
  expression: 'Expression Web style', frontpage: 'FrontPage style', dreamweaver: 'Dreamweaver style', composer: 'Composer / KompoZer / BlueGriffon style', union: 'All editors combined',
};

/** Every command id any classic layout names (for tests and the menu map). */
export function classicIds(): Set<string> {
  const s = new Set<string>();
  const walk = (items: ClassicItem[]) => { for (const it of items) { if (it === '|') continue; if (typeof it === 'string') s.add(it); else walk(it.items); } };
  for (const layout of Object.values(CLASSIC_MENUS)) for (const m of layout) walk(m.items);
  return s;
}
