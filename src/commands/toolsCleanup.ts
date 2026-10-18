/**
 * Clean-up and conversion commands: Optimize HTML, Clean Up HTML, Clean Up Word HTML, the markup cleaner,
 * removing empty tags, comments and font tags, font tags to CSS, inline styles to classes, moving inline
 * scripts and style sheets to files, HTML5 and XHTML conversion, encoding repair and minification.
 * Each works on the current page or, with the argument 'site', on every page; each change is one undo
 * step in pages that are open.
 */
import { def, type MenuEntry } from './registry';
import type { App } from '../app';
import { openDialog, toast, alertDialog, confirmDialog, choiceDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { isPage, isText } from '../editor/ops';
import { editFile } from './tools';
import {
  optimizeHtml, cleanupHtml, cleanupWordHtml, removeEmptyTags, removeComments, removeFontTags, fontToCss, inlineToClasses, inlineBlocks,
  toHtml5, toXhtmlPage, fixMojibake, minifyPage, minifyCss, minifyJs, markupCleaner, applyEdits, type CleanResult,
} from '../check/cleanup';
import { setCharset, getCharset, editHeadStyle, addStylesheet, headInsert, escAttr, DOCTYPES } from '../model/html';
import { relativeRef, resolveRef, isPagePath, dirOf, stripExt, baseName, joinPath, extOf } from '../model/paths';
import { rewriteRefs } from '../model/site';

type Scope = 'page' | 'site';
const scopeOf = (arg: any): Scope => (arg === 'site' || arg?.scope === 'site' ? 'site' : 'page');

function targetPages(app: App, scope: Scope): string[] {
  app.active?.ui.flush();
  if (scope === 'site') return app.site.pages().map((p) => p.path).filter((p) => !app.docs.find((d) => d.path === p)?.readOnly);
  return isPage(app) ? [app.active.path] : [];
}

/** Runs a transformation over pages; returns the combined log and how many files changed. */
function transform(app: App, scope: Scope, label: string, fn: (src: string, path: string) => CleanResult | { src: string; count: number }): { changed: number; log: string[]; count: number } {
  const pages = targetPages(app, scope);
  if (!pages.length) { toast('Open a page first.'); return { changed: 0, log: [], count: 0 }; }
  let changed = 0, count = 0;
  const log: string[] = [];
  for (const p of pages) {
    let entry: string[] = [];
    const did = editFile(app, p, label, (src) => {
      const r = fn(src, p);
      if ('log' in r) entry = r.log; else { count += r.count; if (r.count) entry = [`${r.count} changes`]; }
      return r.src;
    });
    if (did) { changed++; if (scope === 'site') log.push(`${p}: ${entry.filter((l) => !/^Size/.test(l)).join('; ') || 'changed'}`); else log.push(...entry); }
  }
  return { changed, log, count };
}

async function showLog(title: string, scope: Scope, r: { changed: number; log: string[] }): Promise<void> {
  if (!r.changed) { toast('Nothing needed to change.'); return; }
  const lines = scope === 'site' ? [`${r.changed} ${r.changed === 1 ? 'page' : 'pages'} changed.`, ...r.log.slice(0, 60), ...(r.log.length > 60 ? [`…and ${r.log.length - 60} more.`] : [])] : r.log;
  await alertDialog(title, h('div', { class: 'ql-msg' }, ...lines.map((l) => h('p', { style: 'margin:2px 0' }, l)), h('p', { class: 'ql-help' }, 'Undo reverses the changes in open pages.')));
}

const scopeField = (arg: any) => ({ key: 'scope', label: 'Apply to', type: 'radio' as const, value: scopeOf(arg), options: [{ value: 'page', label: 'Current page' }, { value: 'site', label: 'All pages in the site' }] });

// --------------------------------------------------------------------------------------------

async function optimize(app: App, arg?: any): Promise<void> {
  let o = typeof arg === 'object' && arg?.options ? arg : null;
  if (!o) {
    const r = await openDialog({
      title: 'Optimize HTML', wide: true, ok: 'Optimize',
      help: 'Removes markup a browser does not need. Template markers, conditional comments and server code are kept unless you choose otherwise.',
      fields: [
        scopeField(arg),
        { key: 'hc', label: 'Comments', type: 'heading' },
        { key: 'commentsAll', label: 'All HTML comments', type: 'checkbox', value: false, half: true },
        { key: 'commentsTemplate', label: 'Page template comments', type: 'checkbox', value: false, half: true },
        { key: 'commentsLayout', label: 'Layout table comments', type: 'checkbox', value: true, half: true },
        { key: 'commentsScript', label: 'Script comment wrappers', type: 'checkbox', value: false, half: true },
        { key: 'commentsOther', label: 'Other comments', type: 'checkbox', value: false, half: true },
        { key: 'hw', label: 'White space', type: 'heading' },
        { key: 'whitespaceLeading', label: 'Leading white space (indentation)', type: 'checkbox', value: false, half: true },
        { key: 'whitespaceAll', label: 'All unneeded white space', type: 'checkbox', value: false, half: true },
        { key: 'hg', label: 'Generated HTML', type: 'heading' },
        { key: 'wordHtml', label: 'Word HTML', type: 'checkbox', value: true, half: true },
        { key: 'unusedStyles', label: 'Unused styles', type: 'checkbox', value: false, half: true },
        { key: 'emptyTags', label: 'Empty tags', type: 'checkbox', value: true, half: true },
        { key: 'generator', label: 'Generator and ProgID tags', type: 'checkbox', value: true, half: true },
        { key: 'frontpage', label: 'Web component (webbot) markup', type: 'checkbox', value: false, half: true },
        { key: 'tracing', label: 'Tracing image and interactive button attributes', type: 'checkbox', value: true, half: true },
        { key: 'fontToCss', label: 'Convert font tags to CSS', type: 'checkbox', value: false, half: true },
      ],
    });
    if (!r) return;
    o = { scope: r.scope, options: r };
  }
  const scope = scopeOf(o.scope);
  await showLog('Optimize HTML', scope, transform(app, scope, 'Optimize HTML', (src) => optimizeHtml(src, o.options)));
}

async function cleanup(app: App, arg?: any): Promise<void> {
  const r = arg?.options ? { ...arg.options, scope: arg.scope } : await openDialog({
    title: 'Clean Up HTML', ok: 'Clean Up',
    fields: [
      scopeField(arg),
      { key: 'h', label: 'Remove', type: 'heading' },
      { key: 'emptyTags', label: 'Empty container tags (<b></b>, <font></font>…)', type: 'checkbox', value: true },
      { key: 'redundantNested', label: 'Redundant nested tags (<b><b>…</b></b>)', type: 'checkbox', value: true },
      { key: 'otherComments', label: 'Comments (not page template markers)', type: 'checkbox', value: false },
      { key: 'templateComments', label: 'Page template markers (the page detaches from its template)', type: 'checkbox', value: false },
      { key: 'tags', label: 'Specific tags', type: 'text', value: '', placeholder: 'for example: font, blink, marquee' },
      { key: 'h2', label: 'Options', type: 'heading' },
      { key: 'combineFonts', label: 'Combine nested <font> tags when possible', type: 'checkbox', value: true },
    ],
  });
  if (!r) return;
  const scope = scopeOf(r.scope);
  if (r.templateComments && !(await confirmDialog('Clean Up HTML', 'Removing page template markers detaches pages from their template; template updates will no longer reach them.', 'Remove Them'))) return;
  await showLog('Clean Up HTML', scope, transform(app, scope, 'Clean Up HTML', (src) => cleanupHtml(src, r)));
}

async function cleanupWord(app: App, arg?: any): Promise<void> {
  const r = arg?.options ? { ...arg.options, scope: arg.scope } : await openDialog({
    title: 'Clean Up Word HTML', ok: 'Clean Up',
    help: 'Removes the markup word processors write when saving as a web page or when text is pasted from them.',
    fields: [
      scopeField(arg),
      { key: 'css', label: 'Remove word-processor style sheets (else only mso- declarations)', type: 'checkbox', value: true },
      { key: 'lists', label: 'Convert list paragraphs to real lists (ul, ol)', type: 'checkbox', value: true },
      { key: 'fonts', label: 'Font tags', type: 'select', value: 'css', options: [{ value: 'css', label: 'Convert to CSS' }, { value: 'remove', label: 'Remove' }, { value: 'keep', label: 'Keep' }] },
      { key: 'emptyParagraphs', label: 'Remove empty paragraphs (only &nbsp;)', type: 'checkbox', value: true },
      { key: 'fontFamilies', label: 'Remove font-family from inline styles', type: 'checkbox', value: false },
      { key: 'lang', label: 'Remove lang attributes on text', type: 'checkbox', value: true },
    ],
  });
  if (!r) return;
  const scope = scopeOf(r.scope);
  await showLog('Clean Up Word HTML', scope, transform(app, scope, 'Clean Up Word HTML', (src) => cleanupWordHtml(src, r)));
}

function simple(label: string, fn: (src: string) => { src: string; count: number }, noun: string) {
  return (app: App, arg?: any) => {
    const scope = scopeOf(arg);
    const r = transform(app, scope, label, fn);
    if (!r.changed && !r.count) { toast(`No ${noun} found.`); return; }
    toast(`${label}: ${r.count} ${noun}${scope === 'site' ? ` in ${r.changed} ${r.changed === 1 ? 'page' : 'pages'}` : ''}.`, { ms: 4000 });
  };
}

async function inlineClasses(app: App, arg?: any): Promise<void> {
  const tab = app.page;
  if (!tab) { toast('Open a page first.'); return; }
  tab.ui.flush();
  const sheets = app.site.list((f) => extOf(f.path) === 'css').map((f) => f.path);
  const r = arg?.prefix ? arg : await openDialog({
    title: 'Inline Styles to Classes', ok: 'Convert',
    help: 'Gathers identical style attributes into CSS classes, so the formatting lives in one place.',
    fields: [
      { key: 'prefix', label: 'Class name prefix', type: 'text', value: 'style' },
      { key: 'min', label: 'Only styles used at least', type: 'number', value: 1, min: 1, max: 50, suffix: 'times' },
      { key: 'target', label: 'Write the classes to', type: 'select', value: 'head', options: [{ value: 'head', label: 'The page (<style> in the head)' }, ...sheets.map((s) => ({ value: s, label: s }))] },
    ],
    validate: (v) => (/^-?[_a-zA-Z][\w-]*$/.test(String(v.prefix).trim()) ? null : 'The prefix must be a valid class name.'),
  });
  if (!r) return;
  const res = inlineToClasses(tab.source, { prefix: String(r.prefix).trim(), min: +r.min || 1 });
  if (!res.classes) { toast('No inline styles to convert.'); return; }
  let css = res.css;
  if (r.target === 'head') {
    app.editSource('Inline Styles to Classes', () => editHeadStyle(res.src, (old) => `${old.replace(/\s*$/, '\n')}${css}`));
  } else {
    // url() references are relative to the page; rewrite them for the style sheet.
    css = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (m, qq, ref) => { const p = resolveRef(tab.path, ref); return p ? `url(${qq}${relativeRef(r.target, p)}${qq})` : m; });
    app.site.write(r.target, (app.site.read(r.target) || '').replace(/\s*$/, '\n\n') + css);
    app.editSource('Inline Styles to Classes', () => addStylesheet(res.src, relativeRef(tab.path, r.target)));
  }
  toast(`${res.replaced} style attributes replaced by ${res.classes} ${res.classes === 1 ? 'class' : 'classes'}.`, { ms: 4000 });
}

async function externalize(app: App, kind: 'style' | 'script', arg?: any): Promise<void> {
  const tab = app.page;
  if (!tab) { toast('Open a page first.'); return; }
  tab.ui.flush();
  const blocks = inlineBlocks(tab.source, kind).filter((b) => b.content.trim());
  if (!blocks.length) { toast(kind === 'style' ? 'The page has no <style> blocks.' : 'The page has no inline scripts.'); return; }
  const ext = kind === 'style' ? 'css' : 'js';
  const dir = kind === 'style' ? 'css' : 'js';
  const suggested = joinPath(dirOf(tab.path) ? dirOf(tab.path) + '/' + dir : dir, `${stripExt(baseName(tab.path))}.${ext}`);
  const r = arg?.file ? arg : await openDialog({
    title: kind === 'style' ? 'Move Styles to a File' : 'Move Scripts to a File', ok: 'Move',
    help: kind === 'style'
      ? `${blocks.length} <style> ${blocks.length === 1 ? 'block' : 'blocks'} will move to a style sheet that the page links to. Blocks with different media are kept apart.`
      : `${blocks.length} inline ${blocks.length === 1 ? 'script' : 'scripts'} will move to ${blocks.length === 1 ? 'a file' : 'files'} the page loads at the same place, so they still run in order. Event attributes (onclick…) stay in the page.`,
    fields: [
      { key: 'file', label: 'File', type: 'text', value: suggested },
      { key: 'append', label: 'If the file exists, add to it (else replace it)', type: 'checkbox', value: true },
    ],
    validate: (v) => (new RegExp(`\\.${ext}$`, 'i').test(String(v.file).trim()) ? null : `The file name must end in .${ext}.`),
  });
  if (!r) return;
  const file = String(r.file).trim().replace(/^\/+/, '');
  const rel = (p: string) => relativeRef(tab.path, p);
  const edits: { start: number; end: number; text: string }[] = [];
  const fixUrls = (css: string, to: string) => rewriteRefs(css, tab.path, (target) => relativeRef(to, target)).replace(/@import\s+(["'])([^"']+)\1/g, (m, qq, ref) => { const p = resolveRef(tab.path, ref); return p ? `@import ${qq}${relativeRef(to, p)}${qq}` : m; });
  if (kind === 'style') {
    const byMedia = new Map<string, typeof blocks>();
    for (const b of blocks) { const media = b.open.attrs.find((a) => a.name === 'media')?.value || ''; byMedia.set(media, [...(byMedia.get(media) || []), b]); }
    let n = 0;
    for (const [media, list] of byMedia) {
      const target = n++ === 0 ? file : file.replace(/\.css$/i, `-${n}.css`);
      const css = list.map((b) => fixUrls(b.content.replace(/^\s*<!--|-->\s*$/g, '').trim(), target)).join('\n\n') + '\n';
      const prev = app.site.read(target);
      app.site.write(target, prev && r.append ? prev.replace(/\s*$/, '\n\n') + css : css);
      list.forEach((b, i) => edits.push({ start: b.start, end: b.end, text: i === 0 ? `<link rel="stylesheet" href="${escAttr(rel(target))}"${media ? ` media="${escAttr(media)}"` : ''}>` : '' }));
    }
  } else {
    blocks.forEach((b, i) => {
      const target = i === 0 ? file : file.replace(/\.js$/i, `-${i + 1}.js`);
      const code = b.content.replace(/^\s*<!--[^\n]*\n?/, '').replace(/\n?\s*\/\/\s*-->\s*$/, '').replace(/^\s*\n|\s*$/g, '') + '\n';
      const prev = app.site.read(target);
      app.site.write(target, prev && r.append && i === 0 ? prev.replace(/\s*$/, '\n\n') + code : code);
      const type = b.open.attrs.find((a) => a.name === 'type')?.value;
      const extra = b.open.attrs.filter((a) => /^(defer|async|nomodule|crossorigin|nonce|id)$/.test(a.name)).map((a) => (a.value == null ? ` ${a.name}` : ` ${a.name}="${escAttr(a.value)}"`)).join('');
      edits.push({ start: b.start, end: b.end, text: `<script${type && /module/.test(type) ? ' type="module"' : ''} src="${escAttr(rel(target))}"${extra}></script>` });
    });
  }
  app.editSource(kind === 'style' ? 'Move Styles to a File' : 'Move Scripts to a File', (src) => applyEdits(src, edits).replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n'));
  toast(`Moved to ${file}${blocks.length > 1 && kind === 'script' ? ` and ${blocks.length - 1} more` : ''}.`);
}

async function convertXhtml(app: App, arg?: any): Promise<void> {
  const r = arg?.doctype ? arg : await openDialog({
    title: 'Convert to XHTML', ok: 'Convert',
    help: 'Lower-cases tags, quotes attribute values, closes empty elements (<br />), writes omitted end tags and escapes "&".',
    fields: [scopeField(arg), { key: 'doctype', label: 'Doctype', type: 'select', value: 'xhtml1t', options: DOCTYPES.filter((d) => /^xhtml/.test(d.id)).map((d) => ({ value: d.id, label: d.label })) }],
  });
  if (!r) return;
  const scope = scopeOf(r.scope);
  await showLog('Convert to XHTML', scope, transform(app, scope, 'Convert to XHTML', (src) => toXhtmlPage(src, r.doctype)));
}

async function convertHtml5(app: App, arg?: any): Promise<void> {
  const scope = scopeOf(arg);
  if (arg === undefined) {
    const c = await choiceDialog('Convert to HTML5', 'Sets the HTML5 doctype and charset, removes default script and style types, and turns obsolete elements and presentational attributes (font, center, align, bgcolor, width on cells…) into CSS.', ['Current Page', 'All Pages']);
    if (c < 0) return;
    return convertHtml5(app, c === 1 ? 'site' : 'page');
  }
  await showLog('Convert to HTML5', scope, transform(app, scope, 'Convert to HTML5', (src) => toHtml5(src)));
}

function fixEncoding(app: App, arg?: any): void {
  const scope = scopeOf(arg);
  let charset = 0;
  const r = transform(app, scope, 'Fix Encoding', (src) => {
    const m = fixMojibake(src);
    let s = m.src;
    if (!/^utf-?8$/i.test(getCharset(s))) { s = setCharset(s, 'utf-8'); if (!/<meta\s+charset/i.test(src) || s !== m.src) charset++; }
    return { src: s, count: m.count };
  });
  if (!r.changed) { toast('No garbled characters found, and the charset is already UTF-8.'); return; }
  toast(`Fix Encoding: ${r.count} garbled ${r.count === 1 ? 'character' : 'characters'} repaired${charset ? '; charset set to UTF-8' : ''}${scope === 'site' ? ` in ${r.changed} pages` : ''}.`, { ms: 5000 });
}

async function minifyCurrent(app: App, arg?: any): Promise<void> {
  const tab = app.active;
  if (!tab || !isText(app)) { toast('Open a page, style sheet or script first.'); return; }
  tab.ui.flush();
  const ext = extOf(tab.path);
  const fn = isPagePath(tab.path) ? minifyPage : ext === 'css' ? minifyCss : /^m?js$/.test(ext) ? minifyJs : null;
  if (!fn) { toast('Minify works on pages, style sheets and scripts.'); return; }
  const choice = arg === 'inPlace' ? 0 : arg === 'copy' ? 1 : await choiceDialog('Minify', `Minifying removes comments and white space from ${tab.path}. The result is hard to edit, so you can keep the original and save a minified copy.`, ['Save a Minified Copy', 'Minify in Place']).then((c) => (c < 0 ? -1 : c === 0 ? 1 : 0));
  if (choice < 0) return;
  const before = tab.source.length;
  const out = fn(tab.source);
  if (choice === 0) {
    app.editSource('Minify', () => out);
    toast(`Minified: ${before.toLocaleString()} → ${out.length.toLocaleString()} characters.`);
  } else {
    const copy = tab.path.replace(/(\.[^.\/]+)$/, '.min$1');
    app.site.write(copy, out);
    toast(`Saved ${copy}: ${before.toLocaleString()} → ${out.length.toLocaleString()} characters.`, { ms: 4000, action: 'Open', onAction: () => app.openFile(copy) });
  }
}

async function minifySite(app: App): Promise<void> {
  const r = await openDialog({
    title: 'Minify Site', ok: 'Minify',
    fields: [
      { key: 'pages', label: 'Pages', type: 'checkbox', value: true, half: true },
      { key: 'css', label: 'Style sheets', type: 'checkbox', value: true, half: true },
      { key: 'js', label: 'Scripts', type: 'checkbox', value: true, half: true },
      { key: 'dest', label: 'Where', type: 'radio', value: 'copy', options: [{ value: 'copy', label: 'Copy the minified files into a folder (the originals stay as they are)' }, { value: 'inPlace', label: 'Minify the files in place' }] },
      { key: 'folder', label: 'Folder', type: 'text', value: '_minified', visibleIf: (v) => v.dest === 'copy' },
    ],
  });
  if (!r) return;
  if (r.dest === 'inPlace' && !(await confirmDialog('Minify Site', 'Minify every selected file in place? Pages that are not open cannot be restored with Undo.', 'Minify'))) return;
  app.active?.ui.flush();
  const folder = String(r.folder || '_minified').trim().replace(/^\/+|\/+$/g, '') || '_minified';
  let n = 0, before = 0, after = 0;
  for (const f of app.site.list((x) => x.text != null && !x.path.startsWith(folder + '/'))) {
    const ext = extOf(f.path);
    const fn = isPagePath(f.path) && r.pages ? minifyPage : ext === 'css' && r.css ? minifyCss : /^m?js$/.test(ext) && r.js && !/\.min\.js$/.test(f.path) ? minifyJs : null;
    if (!fn) continue;
    const out = fn(f.text!);
    before += f.text!.length; after += out.length; n++;
    if (r.dest === 'copy') app.site.write(`${folder}/${f.path}`, out);
    else editFile(app, f.path, 'Minify', () => out);
  }
  if (r.dest === 'copy') {
    for (const f of app.site.list((x) => x.text == null && !x.path.startsWith(folder + '/'))) app.site.write(`${folder}/${f.path}`, f.data!, { mime: f.mime });
  }
  toast(`${n} files minified: ${before.toLocaleString()} → ${after.toLocaleString()} characters${r.dest === 'copy' ? ` in ${folder}/` : ''}.`, { ms: 5000 });
}

async function cleaner(app: App, arg?: any): Promise<void> {
  const r = arg?.options ? { ...arg.options, scope: arg.scope } : await openDialog({
    title: 'Markup Cleaner', ok: 'Clean',
    fields: [
      scopeField(arg),
      { key: 'trailingBr', label: 'Remove line breaks at the end of blocks', type: 'checkbox', value: true },
      { key: 'emptyBlocks', label: 'Remove empty blocks', type: 'checkbox', value: true },
      { key: 'nestedLists', label: 'Fix lists written directly inside lists', type: 'checkbox', value: true },
    ],
  });
  if (!r) return;
  const scope = scopeOf(r.scope);
  await showLog('Markup Cleaner', scope, transform(app, scope, 'Markup Cleaner', (src) => markupCleaner(src, r)));
}

const CLEANUP_MENU = ['tools.optimizeHtml', 'tools.cleanupHtml', 'tools.cleanupWord', 'tools.markupCleaner', '|', 'tools.removeEmptyTags', 'tools.removeComments', 'tools.removeFontTags', 'tools.fontToCss', 'tools.inlineToClasses', '|', 'tools.externalizeCss', 'tools.externalizeJs', '|', 'tools.toHtml5', 'tools.toXhtml', 'tools.fixEncoding', '|', 'tools.minifyPage', 'tools.minifySite'];

def([
  { id: 'tools.optimizeHtml', label: 'Optimize HTML', icon: 'auto_fix_high', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Expression Web Optimize HTML', keywords: 'remove comments whitespace generator word html unused styles empty tags', tip: 'Remove comments, white space and generated markup the browser does not need.', popular: true, run: (app, arg) => optimize(app, arg) },
  { id: 'tools.cleanupHtml', label: 'Clean Up HTML', icon: 'cleaning_services', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Dreamweaver Clean Up HTML, HomeSite CodeSweeper', keywords: 'empty tags redundant nested comments font codesweeper', run: (app, arg) => cleanup(app, arg) },
  { id: 'tools.cleanupWord', label: 'Clean Up Word HTML', icon: 'description', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Dreamweaver Clean Up Word HTML, FrontPage', keywords: 'word office mso paste cleanup lists', tip: 'Remove word-processor markup and turn its list paragraphs into real lists.', run: (app, arg) => cleanupWord(app, arg) },
  { id: 'tools.markupCleaner', label: 'Markup Cleaner', icon: 'mop', tab: 'Check', group: 'Clean Up', edits: true, origin: 'KompoZer Markup Cleaner', keywords: 'br empty blocks nested lists', run: (app, arg) => cleaner(app, arg) },
  { id: 'tools.removeEmptyTags', label: 'Remove Empty Tags', icon: 'check_box_outline_blank', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Dreamweaver, Expression Web', keywords: 'empty elements span font', run: simple('Remove Empty Tags', (s) => removeEmptyTags(s), 'empty tags') },
  { id: 'tools.removeComments', label: 'Remove Comments', icon: 'comments_disabled', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Dreamweaver, Expression Web, HomeSite CodeSweeper', keywords: 'html comments strip', tip: 'Remove HTML comments, keeping template markers, conditional comments and server includes.', run: simple('Remove Comments', (s) => removeComments(s), 'comments') },
  { id: 'tools.removeFontTags', label: 'Remove Font Tags', icon: 'format_clear', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Dreamweaver Clean Up HTML', keywords: 'font basefont strip', run: simple('Remove Font Tags', (s) => removeFontTags(s), 'font tags') },
  { id: 'tools.fontToCss', label: 'Font Tags to CSS', icon: 'format_shapes', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Expression Web Optimize HTML, HomeSite CodeSweeper', keywords: 'font face size color span style convert', run: simple('Font Tags to CSS', (s) => fontToCss(s), 'font tags converted') },
  { id: 'tools.inlineToClasses', label: 'Inline Styles to Classes', icon: 'style', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Expression Web Manage Styles (new style from inline)', keywords: 'style attribute class css gather', isEnabled: isPage, run: (app, arg) => inlineClasses(app, arg) },
  { id: 'tools.externalizeCss', label: 'Move Styles to File', icon: 'file_export', tab: 'Code', group: 'Case & Markup', edits: true, origin: 'Dreamweaver Move CSS, Expression Web', keywords: 'external style sheet css extract link', isEnabled: isPage, run: (app, arg) => externalize(app, 'style', arg) },
  { id: 'tools.externalizeJs', label: 'Move Scripts to File', icon: 'javascript', tab: 'Code', group: 'Case & Markup', edits: true, origin: 'Dreamweaver Externalize JavaScript', keywords: 'external script js extract', isEnabled: isPage, run: (app, arg) => externalize(app, 'script', arg) },
  { id: 'tools.toXhtml', label: 'Convert to XHTML', icon: 'code_blocks', tab: 'Code', group: 'Case & Markup', edits: true, origin: 'Dreamweaver Convert to XHTML, HomeSite CodeSweeper', keywords: 'xhtml lower case quote close tags doctype', run: (app, arg) => convertXhtml(app, arg) },
  { id: 'tools.toHtml5', label: 'Convert to HTML5', icon: 'html', tab: 'Code', group: 'Case & Markup', edits: true, origin: 'Dreamweaver Convert to HTML5', keywords: 'html5 doctype obsolete presentational css modernize', run: (app, arg) => convertHtml5(app, arg) },
  { id: 'tools.fixEncoding', label: 'Fix Encoding', icon: 'translate', tab: 'Check', group: 'Clean Up', edits: true, origin: 'HomeSite, KompoZer character set conversion', keywords: 'mojibake utf-8 charset garbled characters', tip: 'Repair garbled characters such as "Ã©" and declare UTF-8.', run: (app, arg) => fixEncoding(app, arg) },
  { id: 'tools.minifyPage', label: 'Minify', icon: 'compress', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Expression Web Optimize HTML (white space)', keywords: 'minify compress whitespace css js', run: (app, arg) => minifyCurrent(app, arg) },
  { id: 'tools.minifySite', label: 'Minify Site', icon: 'folder_zip', tab: 'Check', group: 'Clean Up', edits: true, origin: 'Expression Web Optimize HTML at publishing', keywords: 'minify all files publish compress', run: (app) => minifySite(app) },
  {
    id: 'tools.cleanupMenu', label: 'More Clean Up', icon: 'cleaning_services', tab: 'Check', group: 'Clean Up', kind: 'menu', noRecord: true, origin: 'Dreamweaver Commands menu, HomeSite CodeSweeper',
    run: (app) => app.ui.openCommandMenu?.({ id: 'tools.cleanupMenu' } as any, app.ui.anchorFor('tools.cleanupMenu')),
    menu: (): MenuEntry[] => CLEANUP_MENU.map((id) => (id === '|' ? { separator: true } : { id })),
  },
]);

void headInsert;
