/**
 * File commands: new pages and sites, open (by content), save, recent sites, close, import, export,
 * preview in browser, print, page and file properties, design notes, search and options.
 *
 * Where a site lives decides how Save works:
 *   - a folder on this device (site.folder): changed files are written back into the folder;
 *   - one file opened on its own (tab.uri): the file is written back where it came from;
 *   - a site file (.qlsite or .zip, app.siteFile): the whole site is written into that file;
 *   - otherwise the user picks one of those homes the first time.
 */
import { def, type MenuEntry } from './registry';
import type { App, PageTab } from '../app';
import { Site, linksOf, linkable, decodeText, newId } from '../model/site';
import { baseName, dirOf, extOf, joinPath, normalizePath, isPagePath, isTextPath, isImagePath, stripExt, relativeRef, slugify, resolveRef } from '../model/paths';
import {
  blankPage, formatHtml, getTitle, setTitle, getMeta, setMeta, getLang, setHtmlAttr, getCharset, setCharset, getDoctype, setDoctype, DOCTYPES,
  regions, setTagAttr, editHeadStyle, htmlToText, esc, escAttr, headInsert, headInner, wordCount,
} from '../model/html';
import { readZip, siteFromFiles, zipSite, qlsiteBlob, readQlsite, canPickFolder, openFolder, chooseSaveFolder, writeToFolder, deleteFromFolder, SKIP_RE } from '../site/io';
import { applyTemplate, pageToTemplate, pageRegions, templateRegions, isTemplatePath, attachedTemplate } from '../site/templates';
import { applyTemplateFull } from './template';
import { detectArchive, siteFromArchive } from '../io/archive';
import { isWxr, wxrToSite } from '../io/wxr';
import { isMhtml, parseMhtml } from '../io/mhtml';
import { openDocument, saveAs, writeBack, readUri, shareFile, OPEN_ACCEPT, OPEN_MIMES, isDesktop, isCapacitor, desktopFolders, desktopHttp, openExternal } from '../platform/native';
import { openDialog, toast, confirmDialog, choiceDialog, promptDialog } from '../ui/dialog';
import { h, download, pickFile } from '../ui/dom';
import { kvGet, kvSet, kvDel, kvKeys } from '../util/store';
import { TEMPLATES, templateById, type TemplateDef } from '../templates';
import { sanitizePrefs, DEFAULT_REPLACEMENTS, DEFAULT_QAT, type RecentEntry } from '../prefs';
import { previewDocument } from '../editor/resources';
import { cacheFor } from '../editor/workspace';
import { insertHtml, isPage, isText, closestSel } from '../editor/ops';
import { stripActiveContent } from '../util/sanitize';

// =============================================================================================
// Pure helpers (unit-tested)

export type SniffKind = 'qlsite' | 'zip' | 'wxr' | 'mhtml' | 'page' | 'php' | 'css' | 'js' | 'json' | 'xml' | 'svg' | 'text' | 'image' | 'binary';

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

/** What a file holds, judged by its content first (extensions are only a hint). */
export function sniffKind(bytes: Uint8Array, name = ''): SniffKind {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || startsWith(bytes, [0xff, 0xd8, 0xff]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) || (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    || startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) || (startsWith(bytes, [0x42, 0x4d]) && bytes.length > 26 && /\.bmp$/i.test(name)) || (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) && /avif|heic/.test(String.fromCharCode(...bytes.subarray(8, 12))))) return 'image';
  // Binary data has NUL bytes early on (UTF-16 text is handled by its byte-order mark).
  const bom16 = startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);
  const head = bytes.subarray(0, 4096);
  if (!bom16 && head.includes(0)) return 'binary';
  const text = decodeText(bytes.subarray(0, 64 * 1024)).replace(/^﻿/, '');
  const t = text.trimStart();
  if (t.startsWith('{') && /"format"\s*:\s*"quillloom-site"/.test(t.slice(0, 400))) return 'qlsite';
  if (isMhtml(text)) return 'mhtml';
  if (isWxr(text)) return 'wxr';
  const ext = extOf(name);
  // A known text extension wins for text: a .php file that is mostly HTML is still PHP.
  if (ext === 'php') return 'php';
  if (isPagePath(name)) return 'page';
  if (ext === 'css' || ext === 'scss' || ext === 'less') return 'css';
  if (ext === 'js' || ext === 'mjs') return 'js';
  if (ext === 'json' || ext === 'webmanifest') return 'json';
  if (ext === 'svg') return 'svg';
  if (ext === 'xml' || ext === 'rss' || ext === 'atom') return 'xml';
  if (ext && isTextPath(name) && !['txt', ''].includes(ext)) return 'text';
  // No telling extension: look at the text.
  if (/^<\?php/i.test(t)) return 'php';
  if (/^(<!DOCTYPE\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(t) || (/<(html|body|div|p|h1|table)[\s>]/i.test(t.slice(0, 2000)) && /<\/(html|body|div|p|h1|table)>/i.test(t))) return 'page';
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(t)) return 'svg';
  if (/^<\?xml/i.test(t) || /^<[a-zA-Z][\w:-]*[^>]*>[\s\S]*<\/[a-zA-Z][\w:-]*>\s*$/.test(t)) return 'xml';
  if (/^[[{]/.test(t)) { try { JSON.parse(text); return 'json'; } catch { /* not JSON */ } }
  if (/^(@charset|@import|@media|:root|\*\s*\{)|^[^{}<>;]{1,200}\{\s*[\w-]+\s*:[^;{}]+;?/m.test(t) && !/[=(]\s*function|=>/.test(t.slice(0, 2000))) return 'css';
  if (/^(['"]use strict['"]|import\s|export\s|const\s|let\s|var\s|function\s|\(function|document\.|window\.)/m.test(t)) return 'js';
  return 'text';
}

const KIND_EXT: Partial<Record<SniffKind, string>> = { page: 'html', php: 'php', css: 'css', js: 'js', json: 'json', xml: 'xml', svg: 'svg', text: 'txt' };

/** A site file name for an opened file: the name as given, with an extension that matches its content when it had none. */
export function fileNameFor(name: string, kind: SniffKind): string {
  const clean = normalizePath(baseName(name.replace(/\\/g, '/'))).replace(/[<>:"|?*\u0000-\u001f]/g, '_') || 'untitled';
  if (extOf(clean) || kind === 'image' || kind === 'binary') return clean;
  const ext = KIND_EXT[kind];
  return ext ? `${clean}.${ext}` : clean;
}

/** Guesses the separator of delimited text (comma, tab, semicolon or pipe). */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ',', bestScore = -1;
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    const score = min > 0 && counts.every((c) => c === counts[0]) ? 1000 + min : min;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Parses CSV/TSV text (RFC 4180 quoting: "a ""b""", newlines inside quotes). */
export function parseDelimited(text: string, delim = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** An HTML table for rows of text. */
export function rowsToTable(rows: string[][], opts: { header?: boolean; className?: string; caption?: string } = {}): string {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const cells = (r: string[], tag: string) => pad(r).map((c) => `<${tag}>${esc(c.trim())}</${tag}>`).join('');
  const out: string[] = [`<table${opts.className ? ` class="${escAttr(opts.className)}"` : ''}>`];
  if (opts.caption) out.push(`  <caption>${esc(opts.caption)}</caption>`);
  let body = rows;
  if (opts.header && rows.length) { out.push(`  <thead>\n    <tr>${cells(rows[0], 'th')}</tr>\n  </thead>`); body = rows.slice(1); }
  out.push('  <tbody>', ...body.map((r) => `    <tr>${cells(r, 'td')}</tr>`), '  </tbody>', '</table>');
  return out.join('\n');
}

/** Rows as CSV text (quoted where needed). */
export function rowsToCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) || /^\s|\s$/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n';
}

/**
 * Writes characters outside ASCII as numeric character references (&#233;) so the page reads the same in
 * any ASCII-compatible encoding. Script, style and server code blocks are left alone; `skipped` counts
 * the characters in them that still need the page's encoding.
 */
export function toAsciiEntities(src: string): { text: string; skipped: number } {
  let skipped = 0;
  const parts = src.split(/(<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<\?[\s\S]*?\?>|<%[\s\S]*?%>)/i);
  const text = parts.map((p, i) => {
    if (i % 2) { skipped += (p.match(/[^\x00-\x7f]/gu) || []).length; return p; }
    return p.replace(/[^\x00-\x7f]/gu, (ch) => `&#${ch.codePointAt(0)};`);
  }).join('');
  return { text, skipped };
}

/** "color: red; margin: 0" as an ordered map (property names lower-cased). */
export function parseStyleDecl(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of s.split(/;(?![^(]*\))/)) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k && v) m.set(k, v);
  }
  return m;
}
export function styleDeclToString(m: Map<string, string>): string {
  return [...m].map(([k, v]) => `${k}: ${v}`).join('; ');
}

/** Sets (or with null removes) one property of one rule in a style sheet's text, adding the rule when missing. */
export function setCssRuleProp(css: string, selector: string, prop: string, value: string | null): string {
  const selRe = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`(^|[}\\s])(${selRe})\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(css);
  if (m) {
    const decl = parseStyleDecl(m[3]);
    if (value == null || value === '') decl.delete(prop); else decl.set(prop, value);
    const start = m.index + m[1].length;
    const end = m.index + m[0].length;
    if (!decl.size) return (css.slice(0, start) + css.slice(end)).replace(/\n{3,}/g, '\n\n');
    return css.slice(0, start) + `${m[2]} { ${styleDeclToString(decl)}; }` + css.slice(end);
  }
  if (value == null || value === '') return css;
  const lead = css && !css.endsWith('\n') ? '\n' : '';
  return `${css}${lead}    ${selector} { ${prop}: ${value}; }\n`;
}

/** An attribute of a start tag written as text, or null. */
export function tagAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

/** Editable-region content of a page as template XML (Dreamweaver's "Export Template Data as XML" layout). */
export function regionsToXml(template: string | null, regionsList: { name: string; content: string }[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<templateItems${template ? ` template="${escAttr(template)}"` : ''} codeOutsideHTMLIsLocked="false">\n${regionsList.map((r) => `  <item name="${escAttr(r.name)}">${cdata(r.content)}</item>`).join('\n')}\n</templateItems>\n`;
}

/** Reads template XML: the template reference and the content of each named item. */
export function xmlToRegions(xml: string): { template: string | null; items: { name: string; content: string }[] } {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The file is not well-formed XML.');
  const root = doc.documentElement;
  const items = [...root.querySelectorAll('item')].map((el) => ({ name: el.getAttribute('name') || '', content: el.textContent || '' })).filter((x) => x.name);
  return { template: root.getAttribute('template'), items };
}

export interface SearchHit { path: string; nameMatch: boolean; count: number; snippet: string }

/** Finds files by name and/or content. */
export function searchSite(site: Site, query: string, opts: { names?: boolean; content?: boolean; matchCase?: boolean; regex?: boolean; textOnly?: boolean } = {}): SearchHit[] {
  const { names = true, content = true, matchCase = false, regex = false } = opts;
  if (!query) return [];
  let re: RegExp;
  try { re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi'); } catch { throw new Error('The search pattern is not a valid regular expression.'); }
  const hits: SearchHit[] = [];
  for (const f of site.list()) {
    re.lastIndex = 0;
    const nameMatch = names && re.test(f.path);
    let count = 0, snippet = '';
    if (content && f.text != null) {
      const hay = opts.textOnly && isPagePath(f.path) ? htmlToText(f.text) : f.text;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(hay))) {
        if (!count) snippet = hay.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
        count++;
        if (!m[0].length) re.lastIndex++;
        if (count > 999) break;
      }
    }
    if (nameMatch || count) hits.push({ path: f.path, nameMatch, count, snippet });
  }
  return hits;
}

/** A printable page of source code with line numbers. */
export function codePrintHtml(text: string, title: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const w = String(lines.length).length;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:10pt/1.35 ui-monospace,Consolas,"Courier New",monospace;margin:0;color:#000}
h1{font:bold 11pt system-ui,sans-serif;margin:0 0 8pt;border-bottom:1px solid #999;padding-bottom:4pt}
pre{margin:0;white-space:pre-wrap;word-break:break-all}
.n{color:#888;user-select:none;display:inline-block;width:${w + 1}ch;text-align:right;margin-right:1.5ch}
</style></head><body><h1>${esc(title)}</h1><pre>${lines.map((l, i) => `<span class="n">${i + 1}</span>${esc(l)}`).join('\n')}</pre></body></html>`;
}

export interface PageSetup { paper: 'auto' | 'letter' | 'legal' | 'a4' | 'a5'; orientation: 'portrait' | 'landscape'; margin: string; backgrounds: boolean; scale: number; linkUrls: boolean; hideNav: boolean }
export const DEFAULT_PAGE_SETUP: PageSetup = { paper: 'auto', orientation: 'portrait', margin: '0.75in', backgrounds: false, scale: 100, linkUrls: false, hideNav: false };

/** Print style rules for a page setup. */
export function pageSetupCss(s: PageSetup): string {
  const size = s.paper === 'auto' ? (s.orientation === 'landscape' ? 'landscape' : 'auto') : `${s.paper} ${s.orientation}`;
  const rules = [`@page { size: ${size}; margin: ${s.margin || '0.75in'}; }`];
  const print: string[] = [];
  if (s.backgrounds) print.push('html, body, * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }');
  if (s.scale && s.scale !== 100) print.push(`html { zoom: ${Math.max(10, Math.min(400, s.scale)) / 100}; }`);
  if (s.linkUrls) print.push('a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.85em; }');
  if (s.hideNav) print.push('nav, [role="navigation"] { display: none !important; }');
  if (print.length) rules.push(`@media print { ${print.join(' ')} }`);
  return rules.join('\n');
}

/** Rewrites style sheet text so print rules apply on screen (for Print Preview). */
export function emulatePrintCss(css: string): string {
  return css.replace(/@media\s+([^{]+)\{/gi, (m, q: string) => {
    const parts = q.split(',').map((p) => p.trim());
    const out = parts.map((p) => p.replace(/\bonly\s+/i, '').replace(/^print\b/i, 'all').replace(/^screen\b/i, 'not all'));
    return `@media ${out.join(', ')} {`;
  });
}

/** Where a downloaded web resource goes in the new site. */
export function localPathForUrl(u: URL, root: URL, page = false): string {
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch { /* keep encoded */ }
  p = normalizePath(p);
  if (!p || u.pathname.endsWith('/')) p = joinPath(p, 'index.html');
  else if (page && !extOf(p)) p += '.html';
  if (page && u.search) p = p.replace(/(\.[^.]+)$/, `-${slugify(u.search.slice(1)).slice(0, 40)}$1`);
  if (u.host !== root.host) p = joinPath('_external', u.host.replace(/[^\w.-]/g, '_'), p);
  return p.replace(/[<>:"|?*]/g, '_');
}

// =============================================================================================
// Save state

/** Modified time of each file as last written to the site's folder. */
const onDisk = new WeakMap<Site, Map<string, number>>();
export function markOnDisk(site: Site, paths?: string[]): void {
  let m = onDisk.get(site);
  if (!m) { m = new Map(); onDisk.set(site, m); }
  for (const p of paths || [...site.files.keys()]) { const f = site.get(p); if (f) m.set(f.path, f.modified); }
}
/** Files changed (or added) since they were last written to the site's folder. */
export function changedPaths(site: Site): string[] {
  const m = onDisk.get(site);
  return site.list().filter((f) => !m || m.get(f.path) !== f.modified).map((f) => f.path);
}

/** A tab's text when it was opened or last saved ("Don't Save" and Revert go back to it). */
const baselines = new WeakMap<PageTab, string>();
const baselineOf = (tab: PageTab) => baselines.get(tab) ?? tab.history.stack[0] ?? tab.source;

function setTitleBar(app: App): void {
  const t = app.active;
  if (t) document.title = `${t.displayName}${t.dirty ? ' •' : ''} – ${app.site.name} – Anne\'s Loom`;
}

function markClean(app: App, tabs: PageTab[]): void {
  for (const t of tabs) { t.dirty = false; baselines.set(t, t.source); }
  app.ui.tabsChanged();
  setTitleBar(app);
}

function siteSaved(app: App): void {
  markClean(app, app.docs);
  app.siteDirty = false;
  void kvDel('draft:site');
  app.ui.tabsChanged();
}

const fileBlob = (site: Site, path: string) => new Blob([site.bytes(path)! as BlobPart], { type: site.get(path)?.mime || 'application/octet-stream' });
const siteFileName = (site: Site, ext: string) => `${(site.name || 'site').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'site'}.${ext}`;

/** Apply Source Formatting on save (Options ▸ Format pages when saving). */
function formatOnSave(app: App, tab: PageTab): void {
  if (!app.prefs.formatOnSave || tab.kind !== 'page' || tab.readOnly) return;
  app.editSource('Format on Save', (s) => formatHtml(s, { indent: ' '.repeat(app.prefs.tabSize || 2) }), tab);
}

// =============================================================================================
// Recent sites and files

function addRecent(app: App, entry: Omit<RecentEntry, 'when' | 'pinned'>, payload: any): void {
  const old = app.prefs.recent.find((r) => r.key === entry.key);
  const list = app.prefs.recent.filter((r) => r.key !== entry.key);
  list.unshift({ ...entry, when: Date.now(), pinned: old?.pinned });
  const kept = [...list.filter((r) => r.pinned), ...list.filter((r) => !r.pinned)].slice(0, 30);
  for (const r of list) if (!kept.includes(r)) void kvDel('recent:' + r.key);
  app.prefs.recent = kept;
  app.savePrefs();
  void kvSet('recent:' + entry.key, payload).catch(() => undefined);
}

/** Remembers the open site (and a copy of it on this device, for reopening without folder access). */
export function rememberSite(app: App): void {
  ensureNotesWatch(app);
  const s = app.site;
  const json = s.toJSON();
  if (s.folder) {
    const id = s.folder.kind === 'desktop' ? s.folder.root : `fsa:${s.folder.handle?.name || s.name}`;
    addRecent(app, { key: 'site:' + id, name: s.name, format: 'site' }, { kind: 'folder', name: s.name, json, handle: s.folder.kind === 'fsa' ? s.folder.handle : undefined, root: s.folder.kind === 'desktop' ? s.folder.root : undefined });
  } else if (app.siteFile) {
    addRecent(app, { key: 'sitefile:' + (app.siteFile.uri && !app.siteFile.uri.startsWith('fsa:') ? app.siteFile.uri : app.siteFile.name), name: app.siteFile.name, uri: app.siteFile.uri || undefined, format: app.siteFile.format }, { kind: 'sitefile', name: app.siteFile.name, json, uri: app.siteFile.uri, format: app.siteFile.format });
  } else if (s.files.size === 1 && app.docs[0]) {
    const t = app.docs[0];
    addRecent(app, { key: 'file:' + (t.uri && !t.uri.startsWith('fsa:') ? t.uri : t.path), name: t.path, uri: t.uri || undefined, format: extOf(t.path) || 'file' }, { kind: 'file', name: t.path, json, uri: t.uri });
  }
}

async function readHandleFiles(dir: any, prefix = '', out = new Map<string, Uint8Array>()): Promise<Map<string, Uint8Array>> {
  for await (const [name, hd] of dir.entries()) {
    if (out.size >= 20000) break;
    const p = prefix ? `${prefix}/${name}` : name;
    if (SKIP_RE.test(p)) continue;
    if (hd.kind === 'directory') await readHandleFiles(hd, p, out);
    else { const f: File = await hd.getFile(); out.set(p, new Uint8Array(await f.arrayBuffer())); }
  }
  return out;
}

async function openRecentEntry(app: App, key: string): Promise<void> {
  const rec = app.prefs.recent.find((r) => r.key === key);
  const p = await kvGet<any>('recent:' + key);
  if (!p) {
    const f = rec?.uri ? await readUri(rec.uri) : null;
    if (f) { await openBuffer(app, f.data, f.name, f.uri); return; }
    toast('That site or file is no longer available. Use Open to locate it.');
    return;
  }
  if (p.kind === 'file' || p.kind === 'sitefile') {
    const f = p.uri ? await readUri(p.uri) : null;
    if (f) { await openBuffer(app, f.data, f.name, f.uri); return; }
  }
  if (!(await confirmLeaveSite(app))) return;
  if (p.kind === 'folder' && p.handle && typeof p.handle.requestPermission === 'function') {
    let perm = await p.handle.queryPermission?.({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await p.handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
    if (perm === 'granted') {
      const files = await readHandleFiles(p.handle);
      const site = siteFromFiles(p.name, files);
      if (p.json?.data) site.data = { ...site.data, ...p.json.data };
      site.folder = { kind: 'fsa', handle: p.handle };
      markOnDisk(site);
      app.setSite(site);
      rememberSite(app);
      toast(`Opened ${site.name}`);
      return;
    }
  }
  const site = Site.fromJSON(p.json);
  if (p.kind === 'folder' && p.root && desktopFolders) site.folder = { kind: 'desktop', root: p.root };
  app.setSite(site);
  if (site.folder) markOnDisk(site);
  if (p.kind === 'sitefile') app.siteFile = { uri: p.uri || null, name: p.name, format: p.format === 'zip' ? 'zip' : 'qlsite' };
  if (p.kind === 'file' && app.docs[0]) app.docs[0].uri = p.uri || null;
  rememberSite(app);
  const when = rec ? new Date(rec.when).toLocaleString() : 'its last save';
  if (p.kind === 'folder') toast(site.folder ? `Opened the copy of ${site.name} kept on this device (${when}). Changes made outside Anne\'s Loom since then are not shown; use Open Site to read the folder again.` : `Opened the copy of ${site.name} kept on this device (${when}). This browser cannot reopen the folder itself; save to a folder again or use Open Site.`, { ms: 9000 });
  else toast(`Opened the copy of ${p.name} kept on this device (${when}).`, { ms: 6000 });
}

// =============================================================================================
// Saving

/** Asks to save a changed site before it is replaced. False when the user cancels. */
export async function confirmLeaveSite(app: App): Promise<boolean> {
  for (const d of app.docs) d.ui.flush();
  if (!app.siteDirty || !app.prefs.confirmClose) return true;
  const c = await choiceDialog('Save Changes?', `Save the changes to "${app.site.name}" first?`, ['Save', "Don't Save"]);
  if (c < 0) return false;
  if (c === 1) return true;
  return saveSite(app);
}

/** Saves one tab's file. Returns true when it was saved. */
export async function saveTab(app: App, tab: PageTab | undefined = app.active): Promise<boolean> {
  if (!tab) { toast('There is no file to save.'); return false; }
  tab.ui.flush();
  formatOnSave(app, tab);
  const site = app.site;
  try {
    if (site.folder) {
      await writeToFolder(site, [tab.path]);
      markOnDisk(site, [tab.path]);
      markClean(app, [tab]);
      app.siteDirty = changedPaths(site).length > 0;
      rememberSite(app);
      app.ui.status?.(`Saved ${tab.path}`);
      return true;
    }
    if (tab.uri && (await writeBack(tab.uri, fileBlob(site, tab.path)))) {
      markClean(app, [tab]);
      if (site.files.size === 1) { app.siteDirty = false; void kvDel('draft:site'); }
      rememberSite(app);
      app.ui.status?.(`Saved ${tab.displayName}`);
      return true;
    }
    if (app.siteFile) return saveSiteFile(app, app.siteFile.format);
    if (site.files.size === 1) return saveSingleFileAs(app, tab);
    return chooseSiteHome(app, tab);
  } catch (e: any) {
    toast(`Could not save ${tab.displayName}: ${e?.message || e}`, { ms: 8000 });
    return false;
  }
}

async function saveSingleFileAs(app: App, tab: PageTab): Promise<boolean> {
  const r = await saveAs(fileBlob(app.site, tab.path), baseName(tab.path));
  if (!r) return false;
  tab.uri = r.uri;
  markClean(app, [tab]);
  app.siteDirty = false;
  void kvDel('draft:site');
  rememberSite(app);
  toast(r.uri ? `Saved ${r.name}` : `Downloaded ${r.name}. This browser cannot write the file back in place, so each Save downloads a new copy.`, { ms: r.uri ? 2800 : 7000 });
  return true;
}

/** The first save of a site that has no home yet. */
async function chooseSiteHome(app: App, tab?: PageTab): Promise<boolean> {
  const choices: [string, () => Promise<boolean>][] = [];
  if (canPickFolder()) choices.push(['Save Site to a Folder…', () => saveSiteToFolder(app)]);
  choices.push(['Save Site as One File (.qlsite)…', () => saveSiteFile(app, 'qlsite', { as: true, adopt: true })]);
  choices.push(['Save Site as ZIP…', () => saveSiteFile(app, 'zip', { as: true, adopt: true })]);
  if (tab) choices.push(['Save Only This File…', async () => { const r = await saveAs(fileBlob(app.site, tab.path), baseName(tab.path)); if (r) { markClean(app, [tab]); toast(`Saved a copy of ${tab.path}. The site itself is still unsaved.`); } return !!r; }]);
  const note = canPickFolder() ? 'A folder keeps every file as it will be published; Save then writes just the changed files.' : 'This browser cannot write into folders on this device (the desktop app and Chromium-based browsers can), so the site is saved as one file.';
  const c = await choiceDialog('Save Site', `"${app.site.name}" has not been saved yet. ${note}`, choices.map((x) => x[0]));
  if (c < 0) return false;
  return choices[c][1]();
}

export async function saveSiteToFolder(app: App): Promise<boolean> {
  if (!canPickFolder()) { toast('This browser cannot write into folders on this device. Save the site as a .qlsite or ZIP file instead, or use the desktop app.', { ms: 8000 }); return false; }
  for (const d of app.docs) d.ui.flush();
  const site = app.site;
  const prev = site.folder;
  if (!(await chooseSaveFolder(site))) { site.folder = prev; return false; }
  try {
    toast('Writing the site…');
    const n = await writeToFolder(site);
    markOnDisk(site);
    app.siteFile = null;
    siteSaved(app);
    rememberSite(app);
    toast(`Saved ${n} file${n === 1 ? '' : 's'} to the folder.`);
    return true;
  } catch (e: any) {
    site.folder = prev;
    toast(`Could not write the folder: ${e?.message || e}`, { ms: 8000 });
    return false;
  }
}

/** Saves the whole site as a .qlsite or .zip file (back into its file, or with Save As). */
export async function saveSiteFile(app: App, format: 'qlsite' | 'zip', opts: { as?: boolean; adopt?: boolean } = {}): Promise<boolean> {
  for (const d of app.docs) d.ui.flush();
  const site = app.site;
  const home = app.siteFile && app.siteFile.format === format ? app.siteFile : null;
  const adopt = opts.adopt || !!home || (!site.folder && !app.siteFile);
  const blob = format === 'zip' ? await zipSite(site, { all: adopt }) : qlsiteBlob(site);
  const name = home?.name || siteFileName(site, format);
  if (!opts.as && home?.uri) {
    try { if (await writeBack(home.uri, blob)) { siteSaved(app); rememberSite(app); app.ui.status?.(`Saved ${home.name}`); return true; } } catch (e) { console.warn(e); }
  }
  const r = await saveAs(blob, name);
  if (!r) return false;
  if (adopt && !site.folder) {
    app.siteFile = { uri: r.uri, name: r.name, format };
    siteSaved(app);
    rememberSite(app);
  }
  const zipNote = format === 'zip' ? ' A ZIP keeps the files only; save as .qlsite to keep tasks, navigation and publishing settings too.' : '';
  toast(r.uri ? `Saved ${r.name}.${zipNote}` : `Downloaded ${r.name}.${zipNote}`, { ms: zipNote ? 7000 : 3000 });
  return true;
}

/** Saves every changed file of the site to wherever the site lives. */
export async function saveSite(app: App): Promise<boolean> {
  for (const d of app.docs) { d.ui.flush(); if (d.dirty) formatOnSave(app, d); }
  const site = app.site;
  try {
    if (site.folder) {
      const paths = changedPaths(site);
      const n = paths.length ? await writeToFolder(site, paths) : 0;
      markOnDisk(site, paths);
      siteSaved(app);
      rememberSite(app);
      app.ui.status?.(n ? `Saved ${n} file${n === 1 ? '' : 's'}` : 'Nothing to save');
      return true;
    }
    if (app.siteFile) return saveSiteFile(app, app.siteFile.format);
    const dirty = app.docs.filter((d) => d.dirty);
    if (site.files.size === 1 && dirty[0]) return saveTab(app, dirty[0]);
    if (!app.siteDirty && !dirty.length) { app.ui.status?.('Nothing to save'); return true; }
    return chooseSiteHome(app);
  } catch (e: any) {
    toast(`Could not save the site: ${e?.message || e}`, { ms: 8000 });
    return false;
  }
}

// =============================================================================================
// Opening

/** True when the open site is the untouched starter (or another unsaved, unchanged site) that a newly opened file may replace. */
function isPristine(app: App): boolean {
  return !app.site.folder && !app.siteFile && !app.siteDirty && app.docs.every((d) => !d.dirty && !d.uri);
}

async function showReport(title: string, report: string[]): Promise<void> {
  if (!report.length) return;
  const pre = h('pre', { class: 'ql-notices', style: 'white-space:pre-wrap;max-height:60vh;overflow:auto' }, report.join('\n'));
  await openDialog({ title, wide: true, content: pre, cancel: false, ok: 'Close' });
}

function siteFromImport(app: App, site: Site, opts: { open?: string; siteFile?: App['siteFile']; report?: string[]; title?: string } = {}): void {
  app.setSite(site, { open: opts.open && site.has(opts.open) ? opts.open : undefined });
  app.siteFile = opts.siteFile ?? null;
  markClean(app, app.docs);
  if (opts.siteFile) rememberSite(app);
  if (opts.report?.length) toast(`Opened ${site.name} (${opts.report.length} note${opts.report.length === 1 ? '' : 's'})`, { action: 'Details', onAction: () => void showReport(opts.title || 'Import Report', opts.report!), ms: 9000 });
  else toast(`Opened ${site.name}`);
}

/**
 * Opens anything by its content: a .qlsite site, a ZIP (site, theme or template), a WordPress export,
 * an MHTML web archive, or one page, style sheet, script, text file or picture.
 */
export async function openBuffer(app: App, data: ArrayBuffer, name: string, uri: string | null): Promise<void> {
  ensureNotesWatch(app);
  try {
    const bytes = new Uint8Array(data);
    const kind = sniffKind(bytes, name);
    const base = stripExt(baseName(name)) || 'Web Site';
    switch (kind) {
      case 'qlsite': {
        const site = readQlsite(bytes);
        if (!(await confirmLeaveSite(app))) return;
        siteFromImport(app, site, { siteFile: { uri, name, format: 'qlsite' } });
        return;
      }
      case 'zip': {
        const files = await readZip(bytes);
        if (!files.size) { toast(`${name} is an empty archive.`); return; }
        const ak = detectArchive(files);
        let res: { site: Site; report: string[]; open?: string };
        try { res = await siteFromArchive(base, files, ak); } catch (e) {
          console.warn(e);
          res = { site: siteFromFiles(base, files), report: ak === 'site' ? [] : [`The archive looks like a ${ak.replace(/-/g, ' ')}, but it could not be converted (${(e as Error)?.message || e}); its files were opened as they are.`] };
        }
        if (!(await confirmLeaveSite(app))) return;
        siteFromImport(app, res.site, { open: res.open, siteFile: ak === 'site' ? { uri, name, format: 'zip' } : null, report: res.report, title: `Opened ${name}` });
        return;
      }
      case 'wxr': {
        const res = wxrToSite(decodeText(bytes), { name: base });
        if (!(await confirmLeaveSite(app))) return;
        siteFromImport(app, res.site, { open: res.open, report: res.report, title: 'WordPress Import' });
        app.siteDirty = true;
        return;
      }
      case 'mhtml': {
        const r = parseMhtml(bytes);
        const site = new Site(r.title || base);
        site.write('index.html', r.html, { silent: true });
        for (const [p, u8] of r.files) if (p && p !== 'index.html') site.write(p, u8, { silent: true });
        if (!(await confirmLeaveSite(app))) return;
        siteFromImport(app, site, { open: 'index.html' });
        app.siteDirty = true;
        return;
      }
      default:
        await openSingle(app, bytes, name, uri, kind);
    }
  } catch (e: any) {
    console.error(e);
    toast(`Could not open ${name}: ${e?.message || e}`, { ms: 9000 });
  }
}

async function openSingle(app: App, bytes: Uint8Array, name: string, uri: string | null, kind: SniffKind): Promise<void> {
  const fname = fileNameFor(name, kind);
  let own = isPristine(app);
  if (!own) {
    const c = await choiceDialog('Open File', `Add "${fname}" to the site "${app.site.name}", or open it as its own page?`, ['Add to This Site', 'Open as Its Own Page']);
    if (c < 0) return;
    own = c === 1;
    if (own && !(await confirmLeaveSite(app))) return;
  }
  if (own) {
    const site = new Site(stripExt(fname));
    site.write(fname, bytes, { silent: true });
    if (isPagePath(fname)) site.data.home = fname;
    app.setSite(site, { open: fname });
    const tab = app.docs.find((d) => d.path === fname);
    if (tab) { tab.uri = uri; baselines.set(tab, tab.source); }
    app.siteFile = null;
    rememberSite(app);
    toast(`Opened ${fname}`);
    return;
  }
  const site = app.site;
  let path = fname;
  if (site.has(path)) {
    const c = await choiceDialog('File Exists', `${path} is already in the site.`, ['Replace It', 'Keep Both']);
    if (c < 0) return;
    if (c === 1) path = site.freeName('', stripExt(fname), extOf(fname));
  }
  site.write(path, bytes);
  app.openFile(path);
  toast(`Added ${path} to the site`);
}

async function openSiteFolder(app: App): Promise<void> {
  if (!(await confirmLeaveSite(app))) return;
  const site = await openFolder();
  if (!site) return;
  app.setSite(site);
  if (site.folder) markOnDisk(site);
  rememberSite(app);
  toast(site.folder ? `Opened ${site.name} (${site.files.size} files)` : `Opened a copy of ${site.name} (${site.files.size} files). This browser can read folders but not write them; save the site as a .qlsite or ZIP file.`, { ms: site.folder ? 3000 : 9000 });
}

// ---------------------------------------------------------------------------------------------
// Open from a web address

async function fetchText(url: string): Promise<{ text: string; url: string }> {
  try {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error(`the server answered ${r.status}`);
    return { text: await r.text(), url: r.url || url };
  } catch (e) {
    if (desktopHttp) {
      const r = await desktopHttp({ url, method: 'GET', headers: {} });
      if (r.status >= 200 && r.status < 300) return { text: r.text, url };
      throw new Error(`the server answered ${r.status}`);
    }
    throw e;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    if (desktopHttp && /\.(css|js|svg|txt|json|xml)(\?|$)/i.test(url)) {
      try { const r = await desktopHttp({ url, method: 'GET', headers: {} }); if (r.status < 300) return new TextEncoder().encode(r.text); } catch { /* unreachable */ }
    }
    return null;
  }
}

/** Downloads a published page (and optionally the pages it links on the same site) with their files into a new site. */
export async function siteFromUrl(start: string, opts: { pages?: number; log?: (s: string) => void } = {}): Promise<{ site: Site; report: string[]; open: string }> {
  const root = new URL(start);
  const report: string[] = [];
  const log = (s: string) => { report.push(s); opts.log?.(s); };
  const site = new Site(root.host);
  const queue: URL[] = [root];
  const seenPages = new Set<string>();
  const fetched = new Map<string, string | null>();
  const maxPages = Math.max(1, opts.pages ?? 1);
  let first = '';
  const keyOf = (u: URL) => u.origin + u.pathname + u.search;

  const resource = async (abs: URL): Promise<string | null> => {
    const k = keyOf(abs);
    if (fetched.has(k)) return fetched.get(k)!;
    fetched.set(k, null);
    const path = localPathForUrl(abs, root);
    const data = await fetchBytes(abs.href);
    if (!data) { log(`Could not download ${abs.href} (the server may not allow it); the link was kept as an address.`); return null; }
    if (/\.css$/i.test(path)) {
      let css = decodeText(data);
      css = await rewriteCssUrls(css, abs, path);
      site.write(path, css, { silent: true });
    } else site.write(path, data, { silent: true });
    fetched.set(k, path);
    return path;
  };
  const rewriteCssUrls = async (css: string, base: URL, cssPath: string): Promise<string> => {
    const refs = new Set<string>();
    for (const m of css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/gi)) { const r = (m[2] || m[4] || '').trim(); if (r && !/^(data|blob|#)/i.test(r)) refs.add(r); }
    const map = new Map<string, string>();
    for (const r of refs) { let u: URL; try { u = new URL(r, base); } catch { continue; } if (!/^https?:$/.test(u.protocol)) continue; const p = await resource(u); if (p) map.set(r, relativeRef(cssPath, p)); }
    return css.replace(/(url\(\s*)(["']?)([^"')]+)\2(\s*\))/gi, (m, a, q, r, z) => (map.has(r.trim()) ? `${a}${q}${map.get(r.trim())}${q}${z}` : m)).replace(/(@import\s+)(["'])([^"']+)\2/gi, (m, a, q, r) => (map.has(r) ? `${a}${q}${map.get(r)}${q}` : m));
  };

  while (queue.length && seenPages.size < maxPages) {
    const u = queue.shift()!;
    const k = keyOf(u);
    if (seenPages.has(k)) continue;
    seenPages.add(k);
    let page: { text: string; url: string };
    try { page = await fetchText(u.href); } catch (e: any) {
      if (!first) throw new Error(`${u.href} could not be read: ${e?.message || e}. Most sites do not let a web page read them from another address; the desktop app can open any site.`);
      log(`Skipped ${u.href}: ${e?.message || e}`);
      continue;
    }
    const pageUrl = new URL(page.url);
    const baseHref = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(page.text)?.[1];
    const base = baseHref ? new URL(baseHref, pageUrl) : pageUrl;
    const path = localPathForUrl(pageUrl, root, true);
    if (!first) first = path;
    log(`Page ${pageUrl.href} → ${path}`);
    const map = new Map<string, string>();
    const anchors = new Map<string, string>();
    const re = /<(\w+)\b[^>]*?\s(src|href|poster|data-src|background)\s*=\s*(["'])([^"']*)\3/gi;
    let m: RegExpExecArray | null;
    const resRefs: string[] = [];
    while ((m = re.exec(page.text))) {
      const tag = m[1].toLowerCase(), attr = m[2].toLowerCase(), ref = m[4].trim();
      if (!ref || /^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(ref)) continue;
      const isNav = (tag === 'a' || tag === 'area') && attr === 'href';
      const isLinkTag = tag === 'link';
      if (isLinkTag && !/stylesheet|icon|preload|manifest/i.test(m[0] + page.text.slice(m.index + m[0].length, page.text.indexOf('>', m.index + m[0].length)))) continue;
      if (isNav) anchors.set(ref, '');
      else resRefs.push(ref);
    }
    for (const sm of page.text.matchAll(/\ssrcset\s*=\s*["']([^"']+)["']/gi)) for (const part of sm[1].split(',')) { const r = part.trim().split(/\s+/)[0]; if (r) resRefs.push(r); }
    for (const sm of page.text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) if (!/^(data|blob|#)/i.test(sm[2])) resRefs.push(sm[2].trim());
    for (const ref of new Set(resRefs)) {
      let abs: URL;
      try { abs = new URL(ref, base); } catch { continue; }
      if (!/^https?:$/.test(abs.protocol)) continue;
      const p = await resource(abs);
      if (p) map.set(ref, relativeRef(path, p));
    }
    for (const ref of anchors.keys()) {
      let abs: URL;
      try { abs = new URL(ref, base); } catch { continue; }
      if (!/^https?:$/.test(abs.protocol)) continue;
      if (abs.host === root.host && /\.(html?|php|aspx?|jsp)$|\/$|\/[^./]+$/i.test(abs.pathname)) {
        const target = localPathForUrl(new URL(abs.origin + abs.pathname + abs.search), root, true);
        const hash = abs.hash || '';
        if (seenPages.size + queue.length < maxPages && !seenPages.has(keyOf(abs))) queue.push(new URL(abs.origin + abs.pathname + abs.search));
        anchors.set(ref, relativeRef(path, target) + hash);
      } else anchors.set(ref, abs.href);
    }
    let text = page.text.replace(/<base\b[^>]*>\s*/i, '');
    text = text.replace(/(\s(?:src|href|poster|data-src|background)\s*=\s*)(["'])([^"']*)\2/gi, (mm, a, q, ref) => {
      const r = ref.trim();
      if (map.has(r)) return `${a}${q}${map.get(r)}${q}`;
      if (anchors.has(r)) return `${a}${q}${anchors.get(r)}${q}`;
      if (r && !/^(#|data:|blob:|javascript:|mailto:|tel:|[a-z][a-z0-9+.-]*:|\/\/)/i.test(r)) { try { return `${a}${q}${new URL(r, base).href}${q}`; } catch { return mm; } }
      return mm;
    });
    text = text.replace(/(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi, (mm, a, q, list: string) => `${a}${q}${list.split(',').map((part) => { const t = part.trim().split(/\s+/); if (t[0] && map.has(t[0])) t[0] = map.get(t[0])!; return t.join(' '); }).join(', ')}${q}`);
    text = text.replace(/(url\(\s*)(["']?)([^"')]+)\2(\s*\))/gi, (mm, a, q, r, z) => (map.has(r.trim()) ? `${a}${q}${map.get(r.trim())}${q}${z}` : mm));
    site.write(path, text, { silent: true });
  }
  if (!first) throw new Error('Nothing could be downloaded.');
  site.data.home = first;
  return { site, report, open: first };
}

// =============================================================================================
// New pages and sites

function langOf(app: App): string { return app.site.data.meta?.lang || (app.prefs.language || 'en').split('-')[0] || 'en'; }

function newPageText(app: App, title: string, body = ''): string {
  return blankPage({ title, doctype: app.prefs.defaultDoctype || 'html5', charset: app.prefs.defaultCharset || 'utf-8', lang: langOf(app), body });
}

function defaultDir(app: App, arg?: any): string {
  if (arg && typeof arg.dir === 'string') return normalizePath(arg.dir);
  return '';
}

function createFile(app: App, dir: string, base: string, ext: string, text: string): PageTab {
  const p = app.site.freeName(dir, base, ext);
  app.site.write(p, text);
  const t = app.openFile(p);
  baselines.set(t, text);
  return t;
}

function newPage(app: App, arg?: any): void {
  const tplId = typeof arg === 'string' ? arg : arg?.template;
  if (tplId) {
    const t = templateById(tplId);
    if (!t) { toast(`There is no template "${tplId}".`); return; }
    if (t.kind === 'site') { void app.exec('file.newSite', { template: t.id }); return; }
    pageFromTemplate(app, t, defaultDir(app, arg));
    return;
  }
  const ext = app.prefs.defaultExtension || 'html';
  const n = app.site.pages().filter((p) => /^untitled/i.test(baseName(p.path))).length + 1;
  createFile(app, defaultDir(app, arg), 'untitled', ext, newPageText(app, `Untitled ${n}`));
}

function pageFromTemplate(app: App, t: TemplateDef, dir: string): void {
  const site = app.site;
  const files = t.files();
  const page = site.freeName(dir, slugify(t.name) === 'blank-page' ? 'untitled' : slugify(t.name), app.prefs.defaultExtension || 'html');
  const map = (k: string) => (k === '{page}' ? page : k.replace(/\{page\}/g, stripExt(baseName(page))));
  let opened = page;
  for (const [k, text] of Object.entries(files)) {
    const p = map(k);
    let out = text;
    // Template files are written for the site root; a page made in a folder needs its links adjusted.
    if (p === page && dir) out = rewriteRefsSafe(text, baseName(page), page);
    if (p !== page && site.has(p)) continue; // shared style sheets already in the site are kept
    site.write(p, out);
    if (k === t.open) opened = p;
  }
  if (t.open === '{page}') opened = page;
  const tab = app.openFile(site.has(opened) ? opened : page);
  baselines.set(tab, tab.source);
}

function rewriteRefsSafe(text: string, asIfAt: string, realPath: string): string {
  let out = text;
  for (const [target, ref] of linksOf(text, asIfAt)) {
    const rel = relativeRef(realPath, target);
    if (rel !== ref) out = out.split(`"${ref}"`).join(`"${rel}"`).split(`'${ref}'`).join(`'${rel}'`).split(`(${ref})`).join(`(${rel})`);
  }
  return out;
}

async function newFromDwt(app: App, arg?: string): Promise<void> {
  const site = app.site;
  const dwts = site.list((f) => isTemplatePath(f.path)).map((f) => f.path);
  if (!dwts.length) {
    if (await confirmDialog('New Page from Template', 'This site has no page templates (.dwt) yet. Create one now? Pages made from it share its layout; only its editable regions differ.', 'Create Template')) newDwt(app);
    return;
  }
  let tpl = typeof arg === 'string' && site.has(arg) ? arg : '';
  let name = '';
  if (!tpl) {
    const r = await openDialog({ title: 'New Page from Template', fields: [
      { key: 'tpl', label: 'Page template', type: 'list', options: dwts, value: dwts[0], rows: Math.min(8, dwts.length + 1) },
      { key: 'name', label: 'File name', type: 'text', value: site.freeName('', 'untitled', app.prefs.defaultExtension || 'html') },
    ] });
    if (!r?.tpl) return;
    tpl = r.tpl; name = normalizePath(r.name || '');
  }
  const path = name && !site.has(name) ? (extOf(name) ? name : `${name}.${app.prefs.defaultExtension || 'html'}`) : site.freeName('', 'untitled', app.prefs.defaultExtension || 'html');
  const src = applyTemplateFull(site, tpl, newPageText(app, 'Untitled'), path);
  site.data.templates[path] = tpl;
  site.write(path, src);
  const tab = app.openFile(path);
  baselines.set(tab, src);
}

function newDwt(app: App): void {
  createFile(app, '', 'untitled', 'dwt', pageToTemplate(newPageText(app, 'Untitled', '\n<p>Page content goes here.</p>\n')));
  toast('New page template: mark the parts that change from page to page as editable regions (Template ▸ Editable Region).', { ms: 7000 });
}

async function newFluid(app: App): Promise<void> {
  const r = await openDialog({ title: 'New Fluid Grid Layout', help: 'A page and a style sheet with a mobile-first column grid that widens at tablet and desktop sizes.', fields: [
    { key: 'name', label: 'Page name', type: 'text', value: 'fluid' },
    { key: 'mobile', label: 'Columns on phones', type: 'number', value: 4, min: 1, max: 24, half: true },
    { key: 'tablet', label: 'Columns on tablets (from 768 px)', type: 'number', value: 8, min: 1, max: 24, half: true },
    { key: 'desktop', label: 'Columns on desktops (from 1024 px)', type: 'number', value: 12, min: 1, max: 24, half: true },
    { key: 'gap', label: 'Gutter (% of width)', type: 'number', value: 2, min: 0, max: 10, half: true },
    { key: 'max', label: 'Maximum page width (px)', type: 'number', value: 1200, min: 320, max: 4000 },
  ] });
  if (!r) return;
  const site = app.site;
  const cols = (n: any, d: number) => Math.max(1, Math.min(24, Math.round(+n || d)));
  const m = cols(r.mobile, 4), t = cols(r.tablet, 8), d = cols(r.desktop, 12);
  const gap = Math.max(0, Math.min(10, +r.gap || 0));
  const span = (n: number, total: number) => Array.from({ length: total }, (_, i) => `.span-${i + 1} { grid-column: span ${Math.min(i + 1, total)}; }`).join('\n  ');
  const css = `@charset "utf-8";
/* Fluid grid: ${m} columns on phones, ${t} on tablets, ${d} on desktops. */
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; }
.gridContainer { width: 92%; max-width: ${Math.round(+r.max || 1200)}px; margin: 0 auto; display: grid; grid-template-columns: repeat(${m}, 1fr); gap: ${gap}%; }
.gridContainer > * { grid-column: 1 / -1; min-width: 0; }
img { max-width: 100%; height: auto; }
@media (min-width: 768px) {
  .gridContainer { grid-template-columns: repeat(${t}, 1fr); }
  ${span(t, t).replace(/\.span-/g, '.tablet-span-')}
}
@media (min-width: 1024px) {
  .gridContainer { grid-template-columns: repeat(${d}, 1fr); }
  ${span(d, d).replace(/\.span-/g, '.desktop-span-')}
}
`;
  const cssPath = site.freeName('', 'fluid-grid', 'css');
  site.write(cssPath, css);
  const page = site.freeName('', slugify(r.name || 'fluid'), app.prefs.defaultExtension || 'html');
  const half = Math.max(1, Math.floor(d / 2));
  const body = `
<div class="gridContainer">
  <header class="tablet-span-${t} desktop-span-${d}"><h1>Site Name</h1></header>
  <main class="tablet-span-${t} desktop-span-${d - Math.max(1, Math.round(d / 4))}"><h2>Main Content</h2><p>Text goes here.</p></main>
  <aside class="tablet-span-${t} desktop-span-${Math.max(1, Math.round(d / 4))}"><h2>Sidebar</h2></aside>
  <section class="tablet-span-${Math.max(1, Math.floor(t / 2))} desktop-span-${half}"><h3>Column</h3></section>
  <section class="tablet-span-${Math.max(1, Math.floor(t / 2))} desktop-span-${d - half}"><h3>Column</h3></section>
  <footer class="tablet-span-${t} desktop-span-${d}"><p>Footer</p></footer>
</div>
`;
  const src = blankPage({ title: 'Fluid Grid Layout', css: [relativeRef(page, cssPath)], body, lang: langOf(app), charset: app.prefs.defaultCharset || 'utf-8', doctype: 'html5' });
  site.write(page, src);
  const tab = app.openFile(page);
  baselines.set(tab, src);
}

function siteFromTemplateDef(t: TemplateDef, name?: string): Site {
  const site = new Site(name || t.name);
  for (const [p, text] of Object.entries(t.files())) site.write(p.replace(/\{page\}/g, 'index.html'), text, { silent: true });
  const open = t.open.replace(/\{page\}/g, 'index.html');
  if (site.has(open) && isPagePath(open)) site.data.home = open;
  return site;
}

async function newSite(app: App, arg?: any): Promise<void> {
  const siteTpls = TEMPLATES.filter((t) => t.kind === 'site');
  let r: Record<string, any> | null;
  if (arg?.template) r = { how: 'template', tpl: arg.template, name: templateById(arg.template)?.name || 'My Web Site' };
  else if (arg?.how) r = { name: 'My Web Site', ...arg };
  else {
    r = await openDialog({ title: 'New Site', fields: [
      { key: 'how', label: 'Start with', type: 'radio', value: siteTpls.length ? 'template' : 'blank', options: [
        { value: 'blank', label: 'An empty site with one home page' },
        ...(siteTpls.length ? [{ value: 'template', label: 'A site template' }] : []),
        { value: 'copy', label: `A copy of the open site ("${app.site.name}")` },
        { value: 'import', label: 'Files from a folder, a ZIP or a web address (Import Site Wizard)' },
      ] },
      { key: 'tpl', label: 'Template', type: 'list', rows: 6, options: siteTpls.map((t) => ({ value: t.id, label: `${t.name} — ${t.description}` })), value: siteTpls[0]?.id, visibleIf: (v) => v.how === 'template' },
      { key: 'name', label: 'Site name', type: 'text', value: 'My Web Site' },
    ] });
  }
  if (!r) return;
  if (r.how === 'import') { await app.exec('file.importSiteWizard', { to: 'new' }); return; }
  let site: Site;
  if (r.how === 'template') {
    const t = templateById(r.tpl);
    if (!t) { toast('Choose a template.'); return; }
    site = siteFromTemplateDef(t, r.name || t.name);
  } else if (r.how === 'copy') {
    for (const d of app.docs) d.ui.flush();
    site = app.site.clone();
    site.folder = null;
    site.data.publish = site.data.publish.map((p) => ({ ...p, published: undefined }));
    site.data.name = r.name && r.name !== 'My Web Site' ? r.name : `Copy of ${app.site.name}`;
  } else {
    site = new Site(r.name || 'My Web Site');
    site.write('index.html', newPageText(app, r.name || 'Home', `\n<h1>${esc(r.name || 'My Web Site')}</h1>\n`), { silent: true });
  }
  if (!(await confirmLeaveSite(app))) return;
  app.setSite(site);
  markClean(app, app.docs);
  app.siteDirty = true;
  app.ui.hideBackstage();
  toast(`New site "${site.name}". Save it to choose where it lives (File ▸ Save Site As).`, { ms: 5000 });
}

// ---------------------------------------------------------------------------------------------
// My Templates (kept on this device)

async function saveAsMyTemplate(app: App, what?: 'page' | 'site'): Promise<void> {
  for (const d of app.docs) d.ui.flush();
  const tab = app.active;
  const kind = what === 'site' || what === 'page' ? what : tab && isPagePath(tab.path) ? 'page' : 'site';
  if (kind === 'page' && (!tab || !isPagePath(tab.path))) { toast('Open a page first.'); return; }
  const r = await openDialog({ title: kind === 'site' ? 'Save Site as Template' : 'Save Page as Template', fields: [
    { key: 'name', label: 'Template name', type: 'text', value: kind === 'site' ? app.site.name : getTitle(tab!.source) || stripExt(tab!.displayName) },
    { key: 'desc', label: 'Description', type: 'text', value: '' },
    ...(kind === 'page' ? [{ key: 'css', label: 'Include the style sheets the page links to', type: 'checkbox' as const, value: true }] : []),
  ], help: 'Templates are kept on this device and appear under File ▸ New ▸ My Templates.' });
  if (!r?.name) return;
  const key = `tpl:${r.name}`;
  if ((await kvGet(key)) && !(await confirmDialog('Save as Template', `Replace the template "${r.name}"?`, 'Replace'))) return;
  if (kind === 'site') {
    const json = app.site.toJSON();
    json.data.publish = [];
    await kvSet(key, { name: r.name, description: r.desc, kind, json, when: Date.now() });
  } else {
    const files: Record<string, string> = { [tab!.path]: tab!.source };
    if (r.css) for (const [t] of linksOf(tab!.source, tab!.path)) { const f = app.site.get(t); if (f?.text != null && /\.(css|js)$/i.test(t)) files[t] = f.text; }
    await kvSet(key, { name: r.name, description: r.desc, kind, page: tab!.path, files, when: Date.now() });
  }
  toast(`Template "${r.name}" saved`);
}

async function newFromMyTemplate(app: App, key?: string): Promise<void> {
  if (!key) {
    const keys = await kvKeys('tpl:');
    if (!keys.length) { toast('You have no templates yet. Use Save As ▸ Page as Template or Site as Template.', { ms: 6000 }); return; }
    const r = await openDialog({ title: 'My Templates', fields: [{ key: 'k', label: 'Template', type: 'list', options: keys.map((k) => ({ value: k, label: k.slice(4) })), value: keys[0] }] });
    if (!r?.k) return;
    key = r.k as string;
  }
  const t = await kvGet<any>(key);
  if (!t) { toast('That template is no longer available.'); return; }
  if (t.kind === 'site') {
    const site = Site.fromJSON(t.json);
    site.data.name = t.name;
    if (!(await confirmLeaveSite(app))) return;
    app.setSite(site);
    app.siteDirty = true;
    app.ui.hideBackstage();
    return;
  }
  const site = app.site;
  const page = site.freeName(dirOf(t.page || ''), slugify(t.name), extOf(t.page || '') || 'html');
  for (const [p, text] of Object.entries<string>(t.files || {})) {
    if (p === t.page) site.write(page, rewriteRefsSafe(text, p, page));
    else if (!site.has(p)) site.write(p, text);
  }
  const tab = app.openFile(page);
  baselines.set(tab, tab.source);
}

// =============================================================================================
// Preview in browser and printing

interface BrowserSize { name: string; width: number; height?: number }
const BROWSERS_KEY = 'quillloom.browsers.v1';
const DEFAULT_BROWSERS: BrowserSize[] = [{ name: 'Phone', width: 375, height: 667 }, { name: 'Tablet', width: 768, height: 1024 }, { name: 'Laptop', width: 1280, height: 800 }, { name: 'Desktop', width: 1920, height: 1080 }];
function loadBrowsers(): BrowserSize[] {
  try { const v = JSON.parse(localStorage.getItem(BROWSERS_KEY) || 'null'); if (Array.isArray(v) && v.length) return v.filter((b) => b && typeof b.name === 'string' && +b.width > 0).map((b) => ({ name: b.name, width: Math.round(+b.width), height: +b.height > 0 ? Math.round(+b.height) : undefined })); } catch { /* defaults */ }
  return DEFAULT_BROWSERS;
}

const SETUP_KEY = 'quillloom.pageSetup.v1';
function loadSetup(): PageSetup {
  try { return { ...DEFAULT_PAGE_SETUP, ...JSON.parse(localStorage.getItem(SETUP_KEY) || '{}') }; } catch { return { ...DEFAULT_PAGE_SETUP }; }
}

/** The page to preview: the active page, or for a style sheet or script the first page that uses it. */
function previewTarget(app: App, path?: string): { path: string; src: string } | null {
  for (const d of app.docs) d.ui.flush();
  const p = path && app.site.has(path) ? path : app.active?.path;
  if (p && isPagePath(p)) return { path: p, src: app.site.read(p) || '' };
  if (p && /\.(css|js|mjs|svg|png|jpe?g|gif|webp)$/i.test(p)) {
    const user = app.site.pages().find((f) => linksOf(f.text || '', f.path).some(([t]) => t === p));
    if (user) return { path: user.path, src: user.text || '' };
  }
  const home = app.site.homePage;
  if (app.site.has(home)) return { path: home, src: app.site.read(home) || '' };
  toast('Open a page to preview.');
  return null;
}

const SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';

/** Fills a sandboxed frame with a page; the desktop app serves it from its separate preview origin. */
function loadFrame(frame: HTMLIFrameElement, html: string): void {
  if (desktopFolders) void desktopFolders.setPreview({ id: 'ql-' + newId('p'), html }).then((r) => { frame.src = r.url; }).catch(() => { frame.srcdoc = html; });
  else frame.srcdoc = html;
}

/** Opens a new browser window with the page in a sandboxed frame (page scripts never run in Anne's Loom's origin). */
async function openPreviewWindow(title: string, html: string, width?: number): Promise<void> {
  if (desktopFolders) {
    const r = await desktopFolders.setPreview({ id: 'ql-' + newId('w'), html });
    const w = window.open(r.url, '_blank', width ? `width=${width + 20},height=900` : '');
    if (!w) openExternal(r.url);
    return;
  }
  const wrap = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} – Preview</title><style>html,body{margin:0;height:100%;background:#d9d9d9}iframe{border:0;display:block;margin:0 auto;height:100%;width:${width ? `${width}px` : '100%'};max-width:100%;background:#fff;box-shadow:0 0 12px rgba(0,0,0,.25)}</style></head><body><iframe sandbox="${SANDBOX}" title="${escAttr(title)}" srcdoc="${escAttr(html)}"></iframe></body></html>`;
  const url = URL.createObjectURL(new Blob([wrap], { type: 'text/html' }));
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  const w = window.open(url, '_blank');
  if (!w) { toast('The browser blocked the preview window.', { action: 'Open Preview', onAction: () => window.open(url, '_blank') }); return; }
  try { w.opener = null; } catch { /* cross-origin */ }
}

async function previewInBrowser(app: App, width?: number): Promise<void> {
  const t = previewTarget(app);
  if (!t) return;
  const html = previewDocument(app.site, t.path, t.src, cacheFor(app));
  await openPreviewWindow(`${getTitle(t.src) || t.path}${width ? ` (${width} px)` : ''}`, html, width);
}

function sizesGrid(app: App, html: string, sizes: BrowserSize[], colWidth = 300): HTMLElement {
  const grid = h('div', { style: 'display:flex;gap:16px;overflow:auto;align-items:flex-start;padding:4px' });
  for (const b of sizes) {
    const height = b.height || Math.round(b.width * 1.4);
    const scale = Math.min(1, colWidth / b.width);
    const frame = h('iframe', { sandbox: SANDBOX, title: `${b.name} ${b.width} px`, style: `width:${b.width}px;height:${height}px;border:0;background:#fff;transform:scale(${scale});transform-origin:0 0` }) as HTMLIFrameElement;
    loadFrame(frame, html);
    grid.appendChild(h('div', { style: 'flex:none' },
      h('div', { class: 'ql-help', style: 'margin-bottom:4px' }, `${b.name} — ${b.width}${b.height ? ` × ${b.height}` : ''} px`),
      h('div', { style: `width:${Math.round(b.width * scale)}px;height:${Math.round(height * scale)}px;overflow:hidden;border:1px solid var(--ql-border,#ccc)` }, frame)));
  }
  void app;
  return grid;
}

async function previewSizes(app: App): Promise<void> {
  const t = previewTarget(app);
  if (!t) return;
  const html = previewDocument(app.site, t.path, t.src, cacheFor(app));
  const list = loadBrowsers();
  const sizes = list.length >= 3 ? list.filter((b) => b.width <= 1440).slice(0, 3) : list;
  await openDialog({ title: `Preview at Several Sizes — ${t.path}`, full: true, cancel: false, ok: 'Close', content: sizesGrid(app, html, sizes.length ? sizes : DEFAULT_BROWSERS.slice(0, 3), 320),
    buttons: [{ label: 'Edit Sizes…', onClick: (_v, ctl) => { ctl.close(); void app.exec('file.editBrowsers'); } }] });
}

async function previewMultiple(app: App): Promise<void> {
  const t = previewTarget(app);
  if (!t) return;
  const html = previewDocument(app.site, t.path, t.src, cacheFor(app));
  const frames = loadBrowsers().map((b) => {
    const height = b.height || Math.round(b.width * 1.4);
    const scale = Math.min(1, 480 / b.width);
    return `<figure><figcaption>${esc(b.name)} — ${b.width} px</figcaption><div style="width:${Math.round(b.width * scale)}px;height:${Math.round(height * scale)}px;overflow:hidden"><iframe sandbox="${SANDBOX}" style="width:${b.width}px;height:${height}px;transform:scale(${scale});transform-origin:0 0" srcdoc="${escAttr(html)}"></iframe></div></figure>`;
  }).join('');
  if (desktopFolders) { await previewSizes(app); return; }
  const wrap = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(t.path)} – Preview at Several Sizes</title><style>body{margin:0;padding:16px;background:#d9d9d9;font:13px system-ui,sans-serif;display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}figure{margin:0}figcaption{margin-bottom:6px;color:#333}iframe{border:0;background:#fff}div{box-shadow:0 0 8px rgba(0,0,0,.25);background:#fff}</style></head><body>${frames}</body></html>`;
  const url = URL.createObjectURL(new Blob([wrap], { type: 'text/html' }));
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  const w = window.open(url, '_blank');
  if (!w) toast('The browser blocked the preview window.', { action: 'Open Preview', onAction: () => window.open(url, '_blank') });
}

/** The page as a print document: preview resources inlined, page scripts removed, page setup applied. */
function printableDocument(app: App, path: string, src: string, opts: { emulate?: boolean; autoPrint?: boolean } = {}): string {
  const html = previewDocument(app.site, path, src, cacheFor(app));
  const doc = new DOMParser().parseFromString(html, 'text/html');
  stripActiveContent(doc.documentElement);
  const setup = loadSetup();
  if (opts.emulate) {
    // Print rules applied on screen, inside a page-sized sheet.
    for (const st of doc.querySelectorAll('style')) st.textContent = emulatePrintCss(st.textContent || '');
    for (const l of doc.querySelectorAll('link[rel~="stylesheet"]')) {
      const media = (l.getAttribute('media') || '').trim();
      if (/^print\b/i.test(media)) l.setAttribute('media', 'all');
      else if (/^screen\b/i.test(media)) l.setAttribute('media', 'not all');
      const href = l.getAttribute('href') || '';
      const m = /^data:text\/css;charset=utf-8,(.*)$/i.exec(href);
      if (m) { try { l.setAttribute('href', 'data:text/css;charset=utf-8,' + encodeURIComponent(emulatePrintCss(decodeURIComponent(m[1])))); } catch { /* keep */ } }
    }
    const paper: Record<string, [number, number]> = { letter: [8.5, 11], legal: [8.5, 14], a4: [8.27, 11.69], a5: [5.83, 8.27], auto: [8.5, 11] };
    let [w, hh] = paper[setup.paper] || paper.letter;
    if (setup.orientation === 'landscape') [w, hh] = [hh, w];
    const sheet = doc.createElement('style');
    sheet.textContent = `html{background:#888 !important;padding:16px 0}body{background:#fff;width:${w}in;min-height:${hh}in;box-sizing:border-box;padding:${setup.margin || '0.75in'} !important;margin:0 auto !important;box-shadow:0 2px 10px rgba(0,0,0,.4)}${setup.backgrounds ? '' : 'body,body *{background-image:none !important}'}${setup.scale && setup.scale !== 100 ? `body{zoom:${setup.scale / 100}}` : ''}${setup.linkUrls ? 'a[href^="http"]::after{content:" (" attr(href) ")";font-size:.85em}' : ''}${setup.hideNav ? 'nav,[role="navigation"]{display:none !important}' : ''}`;
    doc.head.appendChild(sheet);
  } else {
    const st = doc.createElement('style');
    st.textContent = pageSetupCss(setup);
    doc.head.appendChild(st);
  }
  if (opts.autoPrint) {
    const s = doc.createElement('script');
    s.textContent = `addEventListener('load',function(){setTimeout(function(){try{print()}finally{parent.postMessage({qlPrinted:1},'*')}},250)});`;
    doc.body.appendChild(s);
  }
  const dt = /^\s*<!DOCTYPE[^>]*>/i.exec(src)?.[0] || '<!DOCTYPE html>';
  return dt + '\n' + doc.documentElement.outerHTML;
}

/** Prints a document from a hidden sandboxed frame (it can open the print dialog but cannot reach the app). */
function printHtml(html: string): void {
  const frame = h('iframe', { sandbox: 'allow-scripts allow-modals', title: 'Print', 'aria-hidden': 'true', style: 'position:fixed;left:-10000px;top:0;width:816px;height:1056px;border:0' }) as HTMLIFrameElement;
  const done = () => { window.removeEventListener('message', onMsg); setTimeout(() => frame.remove(), 1000); };
  const onMsg = (e: MessageEvent) => { if (e.source === frame.contentWindow && e.data?.qlPrinted) done(); };
  window.addEventListener('message', onMsg);
  setTimeout(done, 10 * 60 * 1000);
  document.body.appendChild(frame);
  loadFrame(frame, html);
}

function printPage(app: App): void {
  const t = previewTarget(app);
  if (!t) return;
  app.ui.hideBackstage();
  printHtml(printableDocument(app, t.path, t.src, { autoPrint: true }));
}

function printCode(app: App): void {
  const tab = app.active;
  if (!tab || (tab.kind !== 'page' && tab.kind !== 'text')) { toast('Open a page or text file to print its code.'); return; }
  tab.ui.flush();
  const html = codePrintHtml(tab.source, tab.path).replace('</body>', `<script>addEventListener('load',function(){setTimeout(function(){try{print()}finally{parent.postMessage({qlPrinted:1},'*')}},200)});</script></body>`);
  app.ui.hideBackstage();
  printHtml(html);
}

async function printPreview(app: App, inWindow = false): Promise<void> {
  const t = previewTarget(app);
  if (!t) return;
  app.ui.hideBackstage();
  const html = printableDocument(app, t.path, t.src, { emulate: true });
  if (inWindow) { await openPreviewWindow(`${t.path} (print layout)`, html); return; }
  const frame = h('iframe', { sandbox: '', title: 'Print preview', style: 'width:100%;height:70vh;border:0;background:#888' }) as HTMLIFrameElement;
  frame.srcdoc = html;
  await openDialog({ title: `Print Preview — ${t.path}`, full: true, ok: 'Close', cancel: false,
    content: h('div', null, h('p', { class: 'ql-help' }, 'An approximation of the printed page: the page\'s print styles and your page setup applied on screen. The browser\'s print dialog shows the exact pages.'), frame),
    buttons: [
      { label: 'Print…', primary: true, onClick: (_v, ctl) => { ctl.close(); printPage(app); } },
      { label: 'Page Setup…', onClick: (_v, ctl) => { ctl.close(); void pageSetupDialog(app).then((ok) => { if (ok) void printPreview(app); }); } },
    ] });
}

async function pageSetupDialog(app: App): Promise<boolean> {
  const s = loadSetup();
  const r = await openDialog({ title: 'Page Setup', help: 'These settings are added as print styles when you print or preview a page from QuillLoom. Headers and footers (title, address, page numbers) are set in the browser\'s print dialog.', fields: [
    { key: 'paper', label: 'Paper size', type: 'select', value: s.paper, half: true, options: [{ value: 'auto', label: 'Printer default' }, { value: 'letter', label: 'Letter (8.5 × 11 in)' }, { value: 'legal', label: 'Legal (8.5 × 14 in)' }, { value: 'a4', label: 'A4 (210 × 297 mm)' }, { value: 'a5', label: 'A5 (148 × 210 mm)' }] },
    { key: 'orientation', label: 'Orientation', type: 'select', value: s.orientation, half: true, options: [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }] },
    { key: 'margin', label: 'Margins (CSS: one to four lengths)', type: 'combo', value: s.margin, options: ['0.5in', '0.75in', '1in', '1in 0.75in', '15mm', '20mm', '0'], half: true },
    { key: 'scale', label: 'Scale', type: 'number', value: s.scale, min: 10, max: 400, suffix: '%', half: true },
    { key: 'backgrounds', label: 'Print background colors and pictures', type: 'checkbox', value: s.backgrounds },
    { key: 'linkUrls', label: 'Print the address after each external link', type: 'checkbox', value: s.linkUrls },
    { key: 'hideNav', label: 'Leave out navigation bars', type: 'checkbox', value: s.hideNav },
  ], buttons: [{ label: 'Defaults', onClick: (_v, ctl) => { for (const [k, v] of Object.entries(DEFAULT_PAGE_SETUP)) ctl.set(k, v); } }] });
  if (!r) return false;
  const next: PageSetup = { paper: r.paper, orientation: r.orientation, margin: String(r.margin || '0.75in').replace(/[;{}<>]/g, ''), backgrounds: !!r.backgrounds, scale: Math.max(10, Math.min(400, +r.scale || 100)), linkUrls: !!r.linkUrls, hideNav: !!r.hideNav };
  try { localStorage.setItem(SETUP_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  void app;
  return true;
}

// =============================================================================================
// Page and file properties

const CHARSETS = ['utf-8', 'windows-1252', 'iso-8859-1', 'iso-8859-15', 'us-ascii', 'utf-16', 'shift_jis', 'euc-jp', 'gb2312', 'big5', 'euc-kr', 'koi8-r', 'windows-1251', 'windows-1250', 'iso-8859-2'];
const LANGS = ['en', 'en-US', 'en-GB', 'es', 'fr', 'de', 'it', 'pt', 'pt-BR', 'nl', 'sv', 'da', 'no', 'fi', 'pl', 'cs', 'ru', 'uk', 'el', 'tr', 'ar', 'he', 'hi', 'zh-CN', 'zh-TW', 'ja', 'ko'];

function bodyTagOf(src: string): string | null {
  const r = regions(src);
  return r.bodyOpen ? src.slice(r.bodyOpen[0], r.bodyOpen[1]) : null;
}
function replaceBodyTag(src: string, tag: string): string {
  const r = regions(src);
  return r.bodyOpen ? src.slice(0, r.bodyOpen[0]) + tag + src.slice(r.bodyOpen[1]) : src;
}
const urlOf = (v: string) => /url\(\s*["']?([^"')]*)["']?\s*\)/i.exec(v)?.[1] ?? '';
const cssColor = (v: string) => { const t = String(v || '').trim(); return /^[#\w(),.%\s-]{1,40}$/.test(t) ? t : ''; };
const cssLen = (v: any) => { const t = String(v ?? '').trim(); if (!t) return ''; if (/^-?\d+(\.\d+)?$/.test(t)) return `${t}px`; return /^-?[\d.]+(px|em|rem|%|pt|in|cm|mm|vw|vh)$|^auto$/i.test(t) ? t : ''; };

function headStyleCss(src: string): string { return /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(headInner(src))?.[1] ?? ''; }
function ruleProp(css: string, sel: string, prop: string): string {
  const m = new RegExp(`(?:^|[}\\s])${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return m ? parseStyleDecl(m[1]).get(prop) || '' : '';
}

const OWN_META = new Set(['description', 'keywords', 'author', 'viewport', 'generator']);

async function pageProperties(app: App): Promise<void> {
  const tab = app.active;
  if (!tab || tab.kind !== 'page') { toast('Open a page first.'); return; }
  tab.ui.flush();
  const src = tab.source;
  const body = bodyTagOf(src) || '<body>';
  const bstyle = parseStyleDecl(tagAttr(body, 'style') || '');
  const css = headStyleCss(src);
  const baseTag = /<base\b[^>]*>/i.exec(headInner(src))?.[0] || '';
  const refresh = getMeta(src, 'refresh', 'http-equiv') || '';
  const rm = /^\s*(\d+)\s*(?:;\s*url\s*=\s*(.*))?$/i.exec(refresh);
  const others = [...headInner(src).matchAll(/<meta\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]).filter((n) => !OWN_META.has(n.toLowerCase()));
  const doctype = getDoctype(src);
  const v = {
    title: getTitle(src), description: getMeta(src, 'description') || '', keywords: getMeta(src, 'keywords') || '', author: getMeta(src, 'author') || '',
    lang: getLang(src), charset: getCharset(src) || '', doctype,
    baseHref: tagAttr(baseTag, 'href') || '', baseTarget: tagAttr(baseTag, 'target') || '',
    refreshSec: rm ? rm[1] : '', refreshUrl: rm?.[2]?.trim().replace(/^["']|["']$/g, '') || '',
    bg: bstyle.get('background-color') || tagAttr(body, 'bgcolor') || '', bgimg: urlOf(bstyle.get('background-image') || '') || tagAttr(body, 'background') || '',
    text: bstyle.get('color') || tagAttr(body, 'text') || '',
    link: ruleProp(css, 'a:link', 'color') || tagAttr(body, 'link') || '', vlink: ruleProp(css, 'a:visited', 'color') || tagAttr(body, 'vlink') || '',
    alink: ruleProp(css, 'a:active', 'color') || tagAttr(body, 'alink') || '', hover: ruleProp(css, 'a:hover', 'color'),
    mt: bstyle.get('margin-top') || tagAttr(body, 'topmargin') || '', mr: bstyle.get('margin-right') || tagAttr(body, 'rightmargin') || '',
    mb: bstyle.get('margin-bottom') || tagAttr(body, 'bottommargin') || '', ml: bstyle.get('margin-left') || tagAttr(body, 'leftmargin') || '',
    meta: others.map((n) => `${n} = ${getMeta(src, n) ?? ''}`).join('\n'),
  };
  const colorHelp = 'A color name or #rrggbb; leave blank for the browser default.';
  const r = await openDialog({ title: `Page Properties — ${tab.path}`, wide: true, fields: [
    { key: 'h1', type: 'heading', label: 'General' },
    { key: 'title', label: 'Title', type: 'text', value: v.title },
    { key: 'description', label: 'Page description', type: 'textarea', rows: 2, value: v.description },
    { key: 'keywords', label: 'Keywords (comma-separated)', type: 'text', value: v.keywords },
    { key: 'author', label: 'Author', type: 'text', value: v.author, half: true },
    { key: 'baseTarget', label: 'Default target frame', type: 'combo', value: v.baseTarget, options: ['_self', '_blank', '_parent', '_top'], half: true },
    { key: 'baseHref', label: 'Base location (base href)', type: 'text', value: v.baseHref, placeholder: 'https://example.com/', half: true },
    { key: 'refreshSec', label: 'Refresh after (seconds)', type: 'number', value: v.refreshSec, min: 0, half: true },
    { key: 'refreshUrl', label: 'Refresh to address (blank: reload this page)', type: 'text', value: v.refreshUrl },
    { key: 'h2', type: 'heading', label: 'Formatting' },
    { key: 'bg', label: 'Background color', type: 'text', value: v.bg, placeholder: '#ffffff', half: true, help: colorHelp },
    { key: 'text', label: 'Text color', type: 'text', value: v.text, placeholder: '#000000', half: true },
    { key: 'bgimg', label: 'Background picture', type: 'combo', value: v.bgimg, options: app.site.list((f) => isImagePath(f.path)).map((f) => relativeRef(tab.path, f.path)) },
    { key: 'link', label: 'Hyperlink color', type: 'text', value: v.link, half: true },
    { key: 'vlink', label: 'Visited hyperlink color', type: 'text', value: v.vlink, half: true },
    { key: 'alink', label: 'Active hyperlink color', type: 'text', value: v.alink, half: true },
    { key: 'hover', label: 'Hovered hyperlink color', type: 'text', value: v.hover, half: true },
    { key: 'h3', type: 'heading', label: 'Margins (blank: browser default; numbers are pixels)' },
    { key: 'mt', label: 'Top', type: 'text', value: v.mt, half: true }, { key: 'mb', label: 'Bottom', type: 'text', value: v.mb, half: true },
    { key: 'ml', label: 'Left', type: 'text', value: v.ml, half: true }, { key: 'mr', label: 'Right', type: 'text', value: v.mr, half: true },
    { key: 'h4', type: 'heading', label: 'Language and Document Type' },
    { key: 'lang', label: 'Page language', type: 'combo', value: v.lang, options: LANGS, half: true },
    { key: 'charset', label: 'Character encoding', type: 'combo', value: v.charset, options: CHARSETS, half: true, help: 'Changes the declaration only; Anne\'s Loom writes files as UTF-8 (see File ▸ Save with Encoding).' },
    { key: 'doctype', label: 'Document type', type: 'select', value: doctype, options: [...DOCTYPES.map((d) => ({ value: d.id, label: d.label })), ...(doctype === 'custom' ? [{ value: 'custom', label: 'Custom (keep as written)' }] : [])] },
    { key: 'h5', type: 'heading', label: 'Custom' },
    { key: 'meta', label: 'Other meta tags (name = content, one per line)', type: 'textarea', rows: 3, value: v.meta },
  ] });
  if (!r) return;
  const changed = (k: keyof typeof v) => String(r[k] ?? '') !== String(v[k] ?? '');
  app.editSource('Page Properties', (s) => {
    if (changed('title')) s = setTitle(s, r.title);
    for (const k of ['description', 'keywords', 'author'] as const) if (changed(k)) s = setMeta(s, k, r[k].trim() ? r[k].trim() : null);
    if (changed('lang')) s = setHtmlAttr(s, 'lang', r.lang.trim() || null);
    if (changed('charset') && r.charset.trim()) s = setCharset(s, r.charset.trim());
    if (changed('doctype') && r.doctype !== 'custom') s = setDoctype(s, r.doctype);
    if (changed('baseHref') || changed('baseTarget')) {
      s = s.replace(/[ \t]*<base\b[^>]*>[ \t]*\r?\n?/i, '');
      const attrs = `${r.baseHref.trim() ? ` href="${escAttr(r.baseHref.trim())}"` : ''}${r.baseTarget.trim() ? ` target="${escAttr(r.baseTarget.trim())}"` : ''}`;
      if (attrs) s = headInsert(s, `<base${attrs}>`);
    }
    if (changed('refreshSec') || changed('refreshUrl')) {
      const sec = r.refreshSec === '' || r.refreshSec == null ? null : Math.max(0, Math.round(+r.refreshSec));
      s = setMeta(s, 'refresh', sec == null ? null : `${sec}${r.refreshUrl.trim() ? `; url=${r.refreshUrl.trim()}` : ''}`, 'http-equiv');
    }
    // Body colors, picture and margins as CSS on the body tag (the old body attributes are removed).
    const bodyKeys = ['bg', 'text', 'bgimg', 'mt', 'mr', 'mb', 'ml'] as const;
    if (bodyKeys.some(changed) && bodyTagOf(s)) {
      let tag = bodyTagOf(s)!;
      const st = parseStyleDecl(tagAttr(tag, 'style') || '');
      const setp = (p: string, val: string) => { if (val) st.set(p, val); else st.delete(p); };
      if (changed('bg')) { setp('background-color', cssColor(r.bg)); tag = setTagAttr(tag, 'bgcolor', null); }
      if (changed('text')) { setp('color', cssColor(r.text)); tag = setTagAttr(tag, 'text', null); }
      if (changed('bgimg')) { const u = r.bgimg.trim().replace(/["()\\]/g, ''); setp('background-image', u ? `url("${u}")` : ''); tag = setTagAttr(tag, 'background', null); }
      const marg: [keyof typeof v, string, string][] = [['mt', 'margin-top', 'topmargin'], ['mr', 'margin-right', 'rightmargin'], ['mb', 'margin-bottom', 'bottommargin'], ['ml', 'margin-left', 'leftmargin']];
      for (const [k, prop, legacy] of marg) if (changed(k)) { setp(prop, cssLen(r[k])); tag = setTagAttr(tag, legacy, null); }
      tag = setTagAttr(tag, 'style', st.size ? styleDeclToString(st) : null);
      s = replaceBodyTag(s, tag);
    }
    const linkKeys: [keyof typeof v, string, string][] = [['link', 'a:link', 'link'], ['vlink', 'a:visited', 'vlink'], ['alink', 'a:active', 'alink'], ['hover', 'a:hover', '']];
    for (const [k, sel, legacy] of linkKeys) {
      if (!changed(k)) continue;
      const val = cssColor(r[k]);
      if (val || headStyleCss(s)) s = editHeadStyle(s, (c) => setCssRuleProp(c, sel, 'color', val || null));
      if (legacy && bodyTagOf(s)) s = replaceBodyTag(s, setTagAttr(bodyTagOf(s)!, legacy, null));
    }
    if (changed('meta')) {
      const next = new Map<string, string>();
      for (const line of String(r.meta).split('\n')) { const i = line.indexOf('='); if (i > 0) next.set(line.slice(0, i).trim(), line.slice(i + 1).trim()); }
      for (const n of others) if (!next.has(n)) s = setMeta(s, n, null);
      for (const [n, c] of next) if (n && !OWN_META.has(n.toLowerCase())) s = setMeta(s, n, c);
    }
    return s;
  }, tab);
}

async function fileProperties(app: App, path?: string): Promise<void> {
  const site = app.site;
  const p = path && site.has(path) ? path : app.active?.path;
  const f = p ? site.get(p) : undefined;
  if (!f) { toast('Select a file first.'); return; }
  app.active?.ui.flush();
  const props = f.props || {};
  const size = f.data?.length ?? new Blob([f.text || '']).size;
  const page = isPagePath(f.path);
  const users = site.pages().filter((x) => x.path !== f.path && linksOf(x.text || '', x.path).some(([t]) => t === f.path)).length;
  const links = f.text != null && linkable(f.path) ? linksOf(f.text, f.path).length : 0;
  const tpl = page ? attachedTemplate(f.text || '', f.path) : null;
  const info = [
    ['Location', f.path], ['Type', f.mime], ['Size', `${size.toLocaleString()} bytes`], ['Created', new Date(f.created).toLocaleString()], ['Modified', new Date(f.modified).toLocaleString()],
    ...(page ? [['Words', wordCount(f.text || '').toLocaleString()], ['Page template', tpl || 'None']] : []), ['Links in this file', String(links)], ['Pages linking here', String(users)],
  ].map(([k, x]) => `<tr><td>${esc(k)}</td><td>${esc(x)}</td></tr>`).join('');
  const r = await openDialog({ title: `Properties — ${baseName(f.path)}`, wide: true, fields: [
    { key: 'info', type: 'info', html: `<table class="ql-stats">${info}</table>` },
    ...(page ? [{ key: 'title', label: 'Title', type: 'text' as const, value: getTitle(f.text || '') }] : []),
    { key: 'summary', label: 'Summary', type: 'textarea', rows: 2, value: props.summary || '' },
    { key: 'category', label: 'Categories', type: 'text', value: props.category || '', half: true },
    { key: 'assignedTo', label: 'Assigned to', type: 'text', value: props.assignedTo || '', half: true },
    { key: 'review', label: 'Review status', type: 'combo', value: props.review || '', options: ['', 'Approved', 'Denied', 'Pending Review', 'Legal Review', 'Code Review', 'Manager Review'], half: true },
    { key: 'noPublish', label: 'Exclude this file when publishing', type: 'checkbox', value: !!f.noPublish, half: true },
  ], buttons: page ? [{ label: 'Page Properties…', onClick: (_v, ctl) => { ctl.close(); if (app.active?.path !== f.path) app.openFile(f.path); void app.exec('file.pageProperties'); } }] : [] });
  if (!r) return;
  const next: Record<string, string> = { ...props, summary: r.summary, category: r.category, assignedTo: r.assignedTo, review: r.review };
  for (const k of Object.keys(next)) if (!next[k]) delete next[k];
  f.props = Object.keys(next).length ? next : undefined;
  f.noPublish = r.noPublish || undefined;
  if (page && r.title !== getTitle(f.text || '')) {
    const tab = app.docs.find((d) => d.path === f.path);
    if (tab) app.editSource('Title', (s) => setTitle(s, r.title), tab); else site.write(f.path, setTitle(f.text || '', r.title));
  }
  site.touchMeta();
}

const NOTE_STATUS = ['', 'draft', 'revision1', 'revision2', 'revision3', 'alpha', 'beta', 'final', 'needs attention'];

async function designNotes(app: App, path?: string): Promise<void> {
  const site = app.site;
  const p = path && site.has(path) ? path : app.active?.path;
  const f = p ? site.get(p) : undefined;
  if (!f) { toast('Select a file first.'); return; }
  ensureNotesWatch(app);
  const props = f.props || {};
  const r = await openDialog({ title: `Design Notes — ${f.path}`, help: 'Notes stay with the site (in the .qlsite file and on this device) and are never published.', fields: [
    { key: 'status', label: 'Status', type: 'select', value: props['notes.status'] || '', options: NOTE_STATUS.map((s) => ({ value: s, label: s || '(none)' })) },
    { key: 'notes', label: 'Notes', type: 'textarea', rows: 8, value: props.notes || '' },
    { key: 'show', label: 'Show when the file is opened', type: 'checkbox', value: props['notes.show'] === '1' },
  ], buttons: [{ label: 'Insert Date', onClick: (vals, ctl) => ctl.set('notes', `${vals.notes ? vals.notes.replace(/\s*$/, '\n') : ''}${new Date().toLocaleDateString()}: `) }] });
  if (!r) return;
  const next: Record<string, string> = { ...props, notes: r.notes.trim(), 'notes.status': r.status, 'notes.show': r.show ? '1' : '' };
  for (const k of Object.keys(next)) if (!next[k]) delete next[k];
  f.props = Object.keys(next).length ? next : undefined;
  site.touchMeta();
  toast('Design notes saved');
}

// Shows design notes marked "show when opened" the first time a file becomes active.
const notesShown = new WeakSet<PageTab>();
function watchNotes(app: App): void {
  let last: PageTab | undefined;
  app.onRefresh(() => {
    const t = app.active;
    if (!t || t === last) return;
    last = t;
    if (notesShown.has(t)) return;
    notesShown.add(t);
    const f = app.site.get(t.path);
    if (f?.props?.['notes.show'] === '1' && f.props.notes) toast(`Design notes${f.props['notes.status'] ? ` (${f.props['notes.status']})` : ''}: ${f.props.notes.slice(0, 160)}`, { action: 'Open Notes', onAction: () => void app.exec('file.designNotes', t.path), ms: 9000 });
  });
}
const notesWatched = new WeakSet<App>();
function ensureNotesWatch(app: App): void { if (!notesWatched.has(app)) { notesWatched.add(app); watchNotes(app); } }

// =============================================================================================
// Import

async function chooseFolder(app: App, title: string, value = ''): Promise<string | null> {
  const dirs = ['', ...app.site.folders()];
  const r = await openDialog({ title, fields: [{ key: 'dir', label: 'Into folder', type: 'combo', value, options: dirs.map((d) => d || '/'), help: 'Type a new folder name to create it.' }] });
  if (!r) return null;
  return normalizePath(String(r.dir || '').replace(/^\/$/, ''));
}

/** Adds files to the site, asking before replacing. Returns the paths written. */
async function addFiles(app: App, entries: [string, Uint8Array][], dir: string): Promise<string[]> {
  const site = app.site;
  const list = entries.map(([p, u8]) => [joinPath(dir, normalizePath(p)), u8] as [string, Uint8Array]).filter(([p]) => p);
  const clash = list.filter(([p]) => site.has(p));
  let mode: 'replace' | 'keep' | 'skip' = 'replace';
  if (clash.length) {
    const c = await choiceDialog('Replace Files?', `${clash.length} file${clash.length === 1 ? ' is' : 's are'} already in the site (${clash.slice(0, 3).map(([p]) => p).join(', ')}${clash.length > 3 ? ', …' : ''}).`, ['Replace', 'Keep Both', 'Skip Those']);
    if (c < 0) return [];
    mode = c === 0 ? 'replace' : c === 1 ? 'keep' : 'skip';
  }
  const out: string[] = [];
  for (const [p0, u8] of list) {
    let p = p0;
    if (site.has(p)) { if (mode === 'skip') continue; if (mode === 'keep') p = site.freeName(dirOf(p), stripExt(baseName(p)), extOf(p)); }
    site.write(p, u8, { silent: true });
    out.push(p);
  }
  if (out.length) { site.touchMeta(); app.siteDirty = true; }
  return out;
}

async function importFiles(app: App, arg?: { files?: File[]; dir?: string }): Promise<void> {
  const files = arg?.files?.length ? arg.files : await pickFile('*/*', true);
  if (!files.length) return;
  const dir = arg && typeof arg.dir === 'string' ? normalizePath(arg.dir) : await chooseFolder(app, `Import ${files.length} File${files.length === 1 ? '' : 's'}`, app.active ? dirOf(app.active.path) : '');
  if (dir == null) return;
  const entries: [string, Uint8Array][] = [];
  for (const f of files) entries.push([((f as any).webkitRelativePath as string) || f.name, new Uint8Array(await f.arrayBuffer())]);
  const done = await addFiles(app, entries, dir);
  if (done.length) toast(`Imported ${done.length} file${done.length === 1 ? '' : 's'}${dir ? ` into ${dir}` : ''}`, done.length === 1 ? { action: 'Open', onAction: () => app.openFile(done[0]) } : {});
}

async function importFolder(app: App): Promise<void> {
  const src = await openFolder();
  if (!src) return;
  const r = await openDialog({ title: 'Import Folder', fields: [
    { key: 'dir', label: 'Into folder', type: 'combo', value: '', options: ['/', ...app.site.folders()] },
    { key: 'sub', label: `Keep the folder's name ("${src.name}") as a subfolder`, type: 'checkbox', value: true },
  ], help: `${src.files.size} files.` });
  if (!r) return;
  const dir = joinPath(normalizePath(String(r.dir || '').replace(/^\/$/, '')), r.sub ? src.name.replace(/[\\/:*?"<>|]/g, '_') : '');
  const done = await addFiles(app, [...src.files.values()].map((f) => [f.path, src.bytes(f.path)!]), dir);
  if (done.length) toast(`Imported ${done.length} files${dir ? ` into ${dir}` : ''}`);
}

async function importZip(app: App): Promise<void> {
  const f = (await pickFile('.zip,application/zip'))[0];
  if (!f) return;
  const files = await readZip(await f.arrayBuffer());
  const dir = await chooseFolder(app, `Import ${f.name} (${files.size} files)`, '');
  if (dir == null) return;
  const done = await addFiles(app, [...files], dir);
  if (done.length) toast(`Imported ${done.length} files${dir ? ` into ${dir}` : ''}`);
}

async function importSiteWizard(app: App, arg?: { to?: 'new' | 'current'; from?: string }): Promise<void> {
  const r = await openDialog({ title: 'Import Site Wizard', fields: [
    { key: 'from', label: 'Import from', type: 'radio', value: arg?.from || 'folder', options: [
      { value: 'folder', label: 'A folder on this device' }, { value: 'zip', label: 'A ZIP archive (site, template or theme)' },
      { value: 'url', label: 'A web address (download a published site)' }, { value: 'qlsite', label: 'A Anne\'s Loom site file (.qlsite)' },
    ] },
    { key: 'url', label: 'Address', type: 'text', placeholder: 'https://example.com/', visibleIf: (v) => v.from === 'url' },
    { key: 'pages', label: 'Pages to download (following links on the same site)', type: 'number', value: 10, min: 1, max: 200, visibleIf: (v) => v.from === 'url' },
    { key: 'to', label: 'Put the files', type: 'radio', value: arg?.to || 'new', options: [{ value: 'new', label: 'In a new site' }, { value: 'current', label: `Into the open site ("${app.site.name}")` }] },
    { key: 'dir', label: 'Folder in the open site', type: 'combo', value: '', options: ['/', ...app.site.folders()], visibleIf: (v) => v.to === 'current' },
  ], help: 'Imported files are copies: the original folder, archive or web site is not changed.', ok: 'Import' });
  if (!r) return;
  let site: Site | null = null;
  let report: string[] = [];
  let open: string | undefined;
  if (r.from === 'folder') { site = await openFolder(); if (site) site.folder = null; }
  else if (r.from === 'zip' || r.from === 'qlsite') {
    const f = (await pickFile(r.from === 'zip' ? '.zip,application/zip' : '.qlsite,application/json'))[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (r.from === 'qlsite') site = readQlsite(bytes);
    else {
      const files = await readZip(bytes);
      const ak = detectArchive(files);
      try { const res = await siteFromArchive(stripExt(f.name), files, ak); site = res.site; report = res.report; open = res.open; } catch { site = siteFromFiles(stripExt(f.name), files); }
    }
  } else {
    let url = String(r.url || '').trim();
    if (!url) { toast('Type the address of the site.'); return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    toast('Downloading…', { ms: 6000 });
    const res = await siteFromUrl(url, { pages: Math.max(1, Math.min(200, +r.pages || 10)), log: (s) => app.ui.status?.(s) });
    site = res.site; report = res.report; open = res.open;
  }
  if (!site) return;
  if (r.to === 'current') {
    const dir = normalizePath(String(r.dir || '').replace(/^\/$/, ''));
    const done = await addFiles(app, site.list().map((f) => [f.path, site!.bytes(f.path)!]), dir);
    if (done.length) toast(`Imported ${done.length} files${dir ? ` into ${dir}` : ''}`, report.length ? { action: 'Details', onAction: () => void showReport('Import Report', report), ms: 8000 } : {});
    return;
  }
  if (!(await confirmLeaveSite(app))) return;
  siteFromImport(app, site, { open, report, title: 'Import Report' });
  app.siteDirty = true;
}

async function openUrl(app: App, arg?: string): Promise<void> {
  let url = typeof arg === 'string' ? arg : '';
  let pages = 1;
  if (!url) {
    const r = await openDialog({ title: 'Open from Web Address', help: desktopHttp ? 'The page and the pictures, style sheets and scripts it uses are downloaded into a new site.' : 'The page and the files it uses are downloaded into a new site. Browsers only allow this for sites that permit reading from other addresses (CORS); the desktop app can open any site.', fields: [
      { key: 'url', label: 'Address', type: 'text', placeholder: 'https://example.com/', autofocus: true },
      { key: 'pages', label: 'Pages (1 = just this page; more follows links on the same site)', type: 'number', value: 1, min: 1, max: 200 },
    ], ok: 'Open' });
    if (!r?.url?.trim()) return;
    url = r.url.trim();
    pages = Math.max(1, Math.min(200, +r.pages || 1));
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { toast('That is not a valid web address.'); return; }
  toast('Downloading…', { ms: 5000 });
  const res = await siteFromUrl(url, { pages, log: (s) => app.ui.status?.(s) });
  if (!(await confirmLeaveSite(app))) return;
  siteFromImport(app, res.site, { open: res.open, report: res.report.filter((l) => !l.startsWith('Page ')), title: 'Download Report' });
  app.siteDirty = true;
}

async function importTabular(app: App): Promise<void> {
  if (!isPage(app)) { toast('Open a page to insert the table into.'); return; }
  const r = await openDialog({ title: 'Import Tabular Data', wide: true, fields: [
    { key: 'file', label: 'File (.csv, .tsv, .txt)', type: 'file', accept: '.csv,.tsv,.tab,.txt,text/csv,text/plain' },
    { key: 'text', label: '…or paste the data', type: 'textarea', rows: 6, placeholder: 'Name,Price\nApples,1.20' },
    { key: 'delim', label: 'Separator', type: 'select', value: 'auto', half: true, options: [{ value: 'auto', label: 'Detect' }, { value: ',', label: 'Comma' }, { value: '\t', label: 'Tab' }, { value: ';', label: 'Semicolon' }, { value: '|', label: 'Vertical bar' }] },
    { key: 'header', label: 'First row is a header', type: 'checkbox', value: true, half: true },
    { key: 'cls', label: 'Table class', type: 'text', value: '', half: true },
    { key: 'caption', label: 'Caption', type: 'text', value: '', half: true },
  ], ok: 'Insert' });
  if (!r) return;
  const text = r.file ? await (r.file as File).text() : String(r.text || '');
  if (!text.trim()) { toast('Choose a file or paste data.'); return; }
  const rows = parseDelimited(text, r.delim === 'auto' ? undefined : r.delim);
  if (!rows.length) { toast('No rows were found.'); return; }
  insertHtml(app, rowsToTable(rows, { header: !!r.header, className: r.cls.trim(), caption: r.caption.trim() }));
  toast(`Inserted a table with ${rows.length} rows`);
}

async function importXml(app: App): Promise<void> {
  const f = (await pickFile('.xml,application/xml,text/xml'))[0];
  if (!f) return;
  const xml = await f.text();
  let data: ReturnType<typeof xmlToRegions> | null = null;
  try { data = xmlToRegions(xml); } catch (e: any) { toast(e?.message || String(e)); return; }
  const site = app.site;
  const tpl = data.template ? resolveRef('', data.template.startsWith('/') ? data.template : '/' + data.template) : null;
  if (!data.items.length || !tpl || !site.has(tpl)) {
    const path = site.freeName('', stripExt(f.name) || 'imported', 'xml');
    site.write(path, xml);
    app.openFile(path);
    toast(tpl && !site.has(tpl) ? `The template ${tpl} is not in this site, so the XML was added as a file.` : 'The XML has no template data, so it was added as a file.', { ms: 7000 });
    return;
  }
  const page = site.freeName('', stripExt(f.name) || 'untitled', app.prefs.defaultExtension || 'html');
  const fake = data.items.map((it) => `<!-- InstanceBeginEditable name="${it.name.replace(/"/g, '')}" -->${it.content}<!-- InstanceEndEditable -->`).join('\n');
  const src = applyTemplateFull(site, tpl, fake, page);
  site.data.templates[page] = tpl;
  site.write(page, src);
  app.openFile(page);
  toast(`Created ${page} from ${tpl}`);
}

// =============================================================================================
// Export

async function saveBlob(blob: Blob, name: string): Promise<void> {
  const r = await saveAs(blob, name);
  if (r) toast(r.uri ? `Saved ${r.name}` : `Downloaded ${r.name}`);
}

async function exportFile(app: App, path?: string): Promise<void> {
  const p = typeof path === 'string' && app.site.has(path) ? path : app.active?.path;
  if (!p) { toast('Select a file first.'); return; }
  app.active?.ui.flush();
  await saveBlob(fileBlob(app.site, p), baseName(p));
}

async function exportText(app: App): Promise<void> {
  const tab = app.active;
  if (!tab || (tab.kind !== 'page' && tab.kind !== 'text')) { toast('Open a page first.'); return; }
  tab.ui.flush();
  const text = tab.kind === 'page' ? `${getTitle(tab.source) ? getTitle(tab.source) + '\n\n' : ''}${htmlToText(tab.source.replace(/<title[^>]*>[\s\S]*?<\/title>/i, ''))}\n` : tab.source;
  await saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${stripExt(tab.displayName)}.txt`);
}

async function exportTable(app: App): Promise<void> {
  const tab = app.active;
  if (!tab || tab.kind !== 'page') { toast('Open a page with a table.'); return; }
  tab.ui.flush();
  const rowsOf = (t: Element) => [...t.querySelectorAll('tr')].filter((tr) => tr.closest('table') === t).map((tr) => [...tr.children].filter((c) => /^(TD|TH)$/.test(c.tagName)).flatMap((c) => [((c as HTMLElement).textContent || '').replace(/\s+/g, ' ').trim(), ...Array(Math.max(0, (+(c.getAttribute('colspan') || 1)) - 1)).fill('')]));
  let table: Element | null = closestSel(app, 'table');
  if (!table) {
    const doc = new DOMParser().parseFromString(tab.source, 'text/html');
    const tables = [...doc.querySelectorAll('table')];
    if (!tables.length) { toast('This page has no tables.'); return; }
    if (tables.length === 1) table = tables[0];
    else {
      const r = await openDialog({ title: 'Export Table', fields: [{ key: 'i', label: 'Table', type: 'list', value: '0', options: tables.map((t, i) => ({ value: String(i), label: `Table ${i + 1}: ${(t.querySelector('caption')?.textContent || t.querySelector('tr')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)} (${t.querySelectorAll('tr').length} rows)` })) }] });
      if (!r?.i) return;
      table = tables[+r.i];
    }
  }
  const r = await openDialog({ title: 'Export Table', fields: [{ key: 'fmt', label: 'Format', type: 'radio', value: 'csv', options: [{ value: 'csv', label: 'Comma-separated (.csv)' }, { value: 'tsv', label: 'Tab-separated (.txt)' }] }] });
  if (!r) return;
  const rows = rowsOf(table);
  const text = r.fmt === 'tsv' ? rows.map((x) => x.map((c) => c.replace(/\t/g, ' ')).join('\t')).join('\r\n') + '\r\n' : rowsToCsv(rows);
  await saveBlob(new Blob(['﻿' + text], { type: r.fmt === 'tsv' ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8' }), `${stripExt(tab.displayName)}-table.${r.fmt === 'tsv' ? 'txt' : 'csv'}`);
}

async function exportTemplateXml(app: App): Promise<void> {
  const tab = app.active;
  if (!tab || tab.kind !== 'page') { toast('Open a page that uses a page template.'); return; }
  tab.ui.flush();
  const src = tab.source;
  const isTpl = isTemplatePath(tab.path);
  const regs = isTpl ? templateRegions(src) : pageRegions(src);
  if (!regs.length) { toast('This page has no editable regions. Attach a page template first (Template ▸ Attach).'); return; }
  const tpl = isTpl ? '/' + tab.path : attachedTemplate(src, tab.path);
  const xml = regionsToXml(tpl ? (tpl.startsWith('/') ? tpl : '/' + tpl) : null, regs);
  await saveBlob(new Blob([xml], { type: 'application/xml' }), `${stripExt(tab.displayName)}.xml`);
}

/** The files a set of pages need: their pictures, style sheets, scripts and what those use, recursively. */
export function dependenciesOf(site: Site, paths: string[]): string[] {
  const out = new Set<string>();
  const walk = (p: string) => {
    if (out.has(p) || !site.has(p)) return;
    out.add(p);
    const f = site.get(p)!;
    if (f.text == null || !linkable(p)) return;
    for (const [t] of linksOf(f.text, p)) if (!isPagePath(t) || isTemplatePath(t) || /\.lbi$/i.test(t)) walk(t);
  };
  for (const p of paths) walk(p);
  return [...out];
}

async function exportPackage(app: App): Promise<void> {
  for (const d of app.docs) d.ui.flush();
  const pages = app.site.pages().map((f) => f.path);
  if (!pages.length) { toast('The site has no pages.'); return; }
  const r = await openDialog({ title: 'Export Web Package', help: 'A ZIP with the chosen pages, everything they use, and a manifest listing the files, to import into another site.', fields: [
    { key: 'pages', label: 'Pages', type: 'list', multiple: true, rows: 10, options: pages, value: app.active && isPagePath(app.active.path) ? [app.active.path] : pages },
    { key: 'deps', label: 'Include the files the pages use (pictures, style sheets, scripts)', type: 'checkbox', value: true },
    { key: 'name', label: 'Package name', type: 'text', value: `${app.site.name} package` },
  ], ok: 'Export' });
  if (!r?.pages?.length) return;
  const files = r.deps ? dependenciesOf(app.site, r.pages) : r.pages;
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const p of files) { const f = app.site.get(p)!; zip.file(p, f.data ?? f.text ?? '', { date: new Date(f.modified) }); }
  zip.file('quillloom-package.json', JSON.stringify({ format: 'quillloom-package', version: 1, name: r.name, site: app.site.name, created: new Date().toISOString(), pages: r.pages, files }, null, 1));
  await saveBlob(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/zip' }), `${String(r.name || 'package').replace(/[\\/:*?"<>|]/g, '_')}.zip`);
}

// =============================================================================================
// Other file commands

async function closeTabCmd(app: App, arg?: string): Promise<boolean> {
  const tab = app.docs.find((d) => d.id === arg) || app.active;
  if (!tab) return true;
  tab.ui.flush();
  if (tab.dirty && app.prefs.confirmClose) {
    const c = await choiceDialog('Save Changes?', `Save changes to "${tab.displayName}" before closing?`, ['Save', "Don't Save"]);
    if (c < 0) return false;
    if (c === 0 && !(await saveTab(app, tab))) return false;
    if (c === 1) {
      const base = baselineOf(tab);
      if (base !== tab.source) { tab.ui.suppressExternal = true; try { app.site.write(tab.path, base); } finally { tab.ui.suppressExternal = false; } }
    }
  }
  app.closeTab(tab);
  app.ui.hideBackstage();
  return true;
}

async function closeTabs(app: App, keep?: PageTab): Promise<void> {
  for (const d of [...app.docs]) {
    if (d === keep || !app.docs.includes(d)) continue;
    if (d.dirty) app.activate(d);
    if (!(await closeTabCmd(app, d.id))) return;
  }
}

async function revert(app: App): Promise<void> {
  const tab = app.active;
  if (!tab || (tab.kind !== 'page' && tab.kind !== 'text')) { toast('Open a page or text file.'); return; }
  tab.ui.flush();
  let text: string | null = null;
  let from = 'when it was opened or last saved';
  const folder = app.site.folder;
  try {
    if (folder?.kind === 'fsa') {
      let d = folder.handle;
      const parts = tab.path.split('/');
      for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg);
      const fh = await d.getFileHandle(parts[parts.length - 1]);
      text = decodeText(new Uint8Array(await (await fh.getFile()).arrayBuffer()));
      from = 'in the site folder';
    } else if (tab.uri) {
      const f = await readUri(tab.uri);
      if (f) { text = decodeText(new Uint8Array(f.data)); from = 'in the saved file'; }
    }
  } catch { /* not on disk yet */ }
  if (text == null) text = baselineOf(tab);
  if (text === tab.source) { toast('The file has no changes to revert.'); return; }
  if (!(await confirmDialog('Revert', `Discard the changes to ${tab.displayName} and go back to the version ${from}? You can undo this with Undo.`, 'Revert'))) return;
  app.commit(tab, text, 'Revert');
  markClean(app, [tab]);
  if (folder) markOnDisk(app.site, [tab.path]);
}

async function saveRelated(app: App): Promise<void> {
  const tab = app.active;
  if (!tab) return;
  tab.ui.flush();
  const site = app.site;
  if (!site.folder) { await saveSite(app); return; }
  const related = [tab.path, ...linksOf(tab.source, tab.path).map(([t]) => t).filter((t) => site.has(t) && /\.(css|js|mjs|json|svg|lbi|dwt|inc|php)$/i.test(t))];
  const paths = [...new Set(related)].filter((p) => changedPaths(site).includes(p));
  if (!paths.length) { toast('The page and its related files have no unsaved changes.'); return; }
  await writeToFolder(site, paths);
  markOnDisk(site, paths);
  markClean(app, app.docs.filter((d) => paths.includes(d.path)));
  app.siteDirty = changedPaths(site).length > 0;
  toast(`Saved ${paths.length} file${paths.length === 1 ? '' : 's'}: ${paths.join(', ')}`);
}

async function saveAsCmd(app: App): Promise<void> {
  const tab = app.active;
  if (!tab) { toast('There is no file to save.'); return; }
  tab.ui.flush();
  const site = app.site;
  const r = await openDialog({ title: 'Save As', fields: [
    { key: 'path', label: 'File name (in the site)', type: 'text', value: tab.path, autofocus: true },
    { key: 'mode', label: 'The original', type: 'radio', value: 'copy', options: [{ value: 'copy', label: 'Keep it (save a copy under the new name)' }, { value: 'move', label: 'Rename it (links to it are updated)' }] },
    ...(isPagePath(tab.path) ? [{ key: 'title', label: 'Page title', type: 'text' as const, value: getTitle(tab.source) }] : []),
  ], buttons: [{ label: 'Save to Device…', onClick: (_v, ctl) => { ctl.close(); void exportFile(app, tab.path); } }], validate: (v) => {
    const p = normalizePath(v.path || '');
    if (!p) return 'Type a file name.';
    if (p !== tab.path && site.has(p)) return `${p} already exists.`;
    return null;
  } });
  if (!r) return;
  let to = normalizePath(r.path);
  if (!extOf(to) && extOf(tab.path)) to += '.' + extOf(tab.path);
  const from = tab.path;
  const moved = to !== from && r.mode === 'move';
  if (to !== from) {
    if (moved) site.rename(from, to);
    else { site.write(to, tab.source); app.openFile(to); }
  }
  const t = app.docs.find((d) => d.path === to) || tab;
  if (r.title != null && isPagePath(to) && r.title !== getTitle(t.source)) app.editSource('Title', (s) => setTitle(s, r.title), t);
  if (moved && site.folder) {
    // Pages whose links were updated are saved too, and the old file is removed from the folder.
    if (await saveSite(app)) await deleteFromFolder(site, from).catch(() => undefined);
    return;
  }
  await saveTab(app, t);
}

async function saveSiteAs(app: App): Promise<void> {
  const choices: [string, () => Promise<unknown>][] = [];
  if (canPickFolder()) choices.push(['To a Folder…', () => saveSiteToFolder(app)]);
  choices.push(['As a .qlsite File…', () => saveSiteFile(app, 'qlsite', { as: true, adopt: true })], ['As a ZIP…', () => saveSiteFile(app, 'zip', { as: true, adopt: true })]);
  const c = await choiceDialog('Save Site As', `Where should "${app.site.name}" be saved? A .qlsite file keeps everything (tasks, navigation, publishing settings); a folder or ZIP keeps the files as they are published.${canPickFolder() ? '' : ' This browser cannot write into folders on this device.'}`, choices.map((x) => x[0]));
  if (c >= 0) await choices[c][1]();
}

async function saveAsCharset(app: App): Promise<void> {
  const tab = app.active;
  if (!tab || tab.kind !== 'page') { toast('Open a page first.'); return; }
  tab.ui.flush();
  const cur = (getCharset(tab.source) || 'utf-8').toLowerCase();
  const r = await openDialog({ title: 'Save with Encoding', help: 'Browsers can only write UTF-8 text. For another encoding, Anne\'s Loom changes the declaration and writes every character outside plain ASCII as a numeric character reference (&#233;), which reads the same in any of these encodings.', fields: [
    { key: 'cs', label: 'Character encoding', type: 'select', value: ['utf-8', 'windows-1252', 'iso-8859-1', 'iso-8859-15', 'us-ascii'].includes(cur) ? cur : 'utf-8', options: [{ value: 'utf-8', label: 'Unicode (UTF-8)' }, { value: 'windows-1252', label: 'Western European (Windows-1252)' }, { value: 'iso-8859-1', label: 'Western European (ISO-8859-1)' }, { value: 'iso-8859-15', label: 'Western European (ISO-8859-15)' }, { value: 'us-ascii', label: 'US-ASCII' }] },
  ], ok: 'Save' });
  if (!r) return;
  let skipped = 0;
  app.editSource('Change Encoding', (s) => {
    let out = setCharset(s, r.cs);
    if (r.cs !== 'utf-8') { const a = toAsciiEntities(out); out = a.text; skipped = a.skipped; }
    return out;
  }, tab);
  if (skipped) toast(`${skipped} non-ASCII character${skipped === 1 ? '' : 's'} inside scripts or style blocks were left as they are; they need UTF-8.`, { ms: 8000 });
  await saveTab(app, tab);
}

async function fileSearch(app: App): Promise<void> {
  const r = await openDialog({ title: 'File Search', fields: [
    { key: 'q', label: 'Find files containing', type: 'text', autofocus: true },
    { key: 'names', label: 'Search file names', type: 'checkbox', value: true, half: true },
    { key: 'content', label: 'Search file contents', type: 'checkbox', value: true, half: true },
    { key: 'textOnly', label: 'Pages: visible text only (not markup)', type: 'checkbox', value: false, half: true },
    { key: 'matchCase', label: 'Match case', type: 'checkbox', value: false, half: true },
    { key: 'regex', label: 'Regular expression', type: 'checkbox', value: false, half: true },
  ], ok: 'Search' });
  if (!r?.q) return;
  for (const d of app.docs) d.ui.flush();
  let hits: SearchHit[];
  try { hits = searchSite(app.site, r.q, r); } catch (e: any) { toast(e?.message || String(e)); return; }
  if (!hits.length) { toast(`No files match "${r.q}".`); return; }
  const pick = await openDialog({ title: `File Search — ${hits.length} file${hits.length === 1 ? '' : 's'}`, wide: true, fields: [
    { key: 'p', label: 'Results (double-click to open)', type: 'list', rows: Math.min(14, hits.length + 1), value: hits[0].path, options: hits.map((x) => ({ value: x.path, label: `${x.path}${x.count ? ` — ${x.count} match${x.count === 1 ? '' : 'es'}: …${x.snippet}…` : ' (name)'}` })) },
  ], ok: 'Open' });
  if (pick?.p) app.openFile(pick.p);
}

async function emailPage(app: App): Promise<void> {
  const tab = app.active;
  if (!tab) { toast('Open a page first.'); return; }
  tab.ui.flush();
  const title = tab.kind === 'page' ? getTitle(tab.source) || tab.displayName : tab.displayName;
  const c = await choiceDialog('Email', 'Send the file as an attachment (through the system share sheet, where available), or start an email with its text?', ['Send as Attachment', 'Email the Text']);
  if (c < 0) return;
  if (c === 0) {
    const blob = tab.kind === 'page' ? new Blob([printableDocument(app, tab.path, tab.source)], { type: 'text/html' }) : fileBlob(app.site, tab.path);
    await shareFile(blob, tab.kind === 'page' ? `${stripExt(tab.displayName)}.html` : tab.displayName, title);
    return;
  }
  const text = tab.kind === 'page' ? htmlToText(tab.source.replace(/<title[^>]*>[\s\S]*?<\/title>/i, '')) : tab.source;
  const max = 1800;
  const body = text.length > max ? text.slice(0, max) + '\n…' : text;
  openExternal(`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`);
}

async function openInFrame(app: App): Promise<void> {
  const tab = app.active;
  if (!tab || tab.kind !== 'page') { toast('Open a frames page first.'); return; }
  tab.ui.flush();
  const src = tab.source;
  const frames = [...src.matchAll(/<(i?frame)\b[^>]*>/gi)];
  if (!frames.length) { toast('This page has no frames. Open a frames page (frameset) or a page with an inline frame.', { ms: 6000 }); return; }
  const pages = app.site.pages().map((f) => f.path).filter((p) => p !== tab.path);
  if (!pages.length) { toast('The site has no other pages to show in the frame.'); return; }
  const r = await openDialog({ title: 'Open in Frame', fields: [
    { key: 'i', label: 'Frame', type: 'select', value: '0', options: frames.map((m, i) => ({ value: String(i), label: `${m[1].toLowerCase()} ${tagAttr(m[0], 'name') || tagAttr(m[0], 'id') || i + 1}${tagAttr(m[0], 'src') ? ` (now ${tagAttr(m[0], 'src')})` : ''}` })) },
    { key: 'page', label: 'Page to show in it', type: 'list', rows: 8, options: pages, value: pages[0] },
    { key: 'edit', label: 'Also open the page for editing', type: 'checkbox', value: false },
  ] });
  if (!r?.page) return;
  const m = frames[+r.i];
  app.editSource('Open in Frame', (s) => s.slice(0, m.index!) + setTagAttr(m[0], 'src', relativeRef(tab.path, r.page)) + s.slice(m.index! + m[0].length), tab);
  if (r.edit) app.openFile(r.page);
}

async function recoverUnsaved(app: App): Promise<void> {
  const d = await kvGet<any>('draft:site');
  if (!d?.json) { toast('No unsaved site was found.'); return; }
  const r = await openDialog({ title: 'Recover Unsaved Site', content: h('div', { class: 'ql-msg' }, h('p', null, `"${d.name}" was kept automatically on ${new Date(d.time).toLocaleString()}.`), h('p', { class: 'ql-help' }, 'Recover it to keep working on it, then save it.')), ok: 'Recover', buttons: [{ label: 'Discard', onClick: async (_v, ctl) => { await kvDel('draft:site'); ctl.close(); toast('Draft discarded'); } }] });
  if (!r) return;
  let site: Site;
  try { site = Site.fromJSON(d.json); } catch (e: any) { toast(`The draft could not be read: ${e?.message || e}`); return; }
  if (!(await confirmLeaveSite(app))) return;
  const open: string[] = (d.open || []).filter((p: string) => site.has(p));
  app.setSite(site, { open: open[0] });
  for (const p of open.slice(1)) app.openFile(p);
  app.siteDirty = true;
  toast(`Recovered "${site.name}". Save it to keep it.`);
}

async function exitApp(app: App): Promise<void> {
  if (!(await confirmLeaveSite(app))) return;
  await app.saveDrafts();
  if (isDesktop()) { window.close(); return; }
  if (isCapacitor()) { try { const { App: CapApp } = await import('@capacitor/app'); await CapApp.exitApp(); return; } catch { /* fall through */ } }
  window.close();
  setTimeout(() => toast('Close this browser tab to exit. Your work is kept as a draft on this device.', { ms: 6000 }), 300);
}

// =============================================================================================
// Options

async function optionsDialog(app: App): Promise<void> {
  const p = app.prefs;
  const r = await openDialog({ title: 'Anne\'s Loom Options', wide: true, fields: [
    { key: 'h1', type: 'heading', label: 'General' },
    { key: 'author', label: 'User name', type: 'text', value: p.author, half: true },
    { key: 'initials', label: 'Initials', type: 'text', value: p.initials, half: true },
    { key: 'theme', label: 'App theme', type: 'select', value: p.theme, half: true, options: [{ value: 'system', label: 'Follow the system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] },
    { key: 'uiScale', label: 'Toolbar size', type: 'select', value: String(p.uiScale), half: true, options: [{ value: '0.85', label: 'Compact' }, { value: '1', label: 'Normal' }, { value: '1.15', label: 'Large (touch)' }] },
    { key: 'menuStyle', label: 'Menus', type: 'select', value: p.menuStyle, half: true, options: [{ value: 'ribbon', label: 'Ribbon' }, { value: 'classic', label: 'Classic menu bar' }, { value: 'both', label: 'Both' }] },
    { key: 'classicMenus', label: 'Classic menu layout', type: 'select', value: p.classicMenus, half: true, options: [{ value: 'expression', label: 'Expression Web style' }, { value: 'frontpage', label: 'FrontPage style' }, { value: 'dreamweaver', label: 'Dreamweaver style' }, { value: 'composer', label: 'Composer / KompoZer style' }, { value: 'union', label: 'Every command (union)' }] },
    { key: 'qatPosition', label: 'Quick Access Bar', type: 'select', value: p.qatPosition, half: true, options: [{ value: 'top', label: 'Above the ribbon' }, { value: 'below', label: 'Below the ribbon' }, { value: 'bottom', label: 'At the bottom' }] },
    { key: 'qatLabels', label: 'Show labels on the Quick Access Bar', type: 'checkbox', value: p.qatLabels, half: true },
    { key: 'touchMode', label: 'Touch mode (larger targets)', type: 'checkbox', value: p.touchMode, half: true },
    { key: 'highContrastUI', label: 'High-contrast interface', type: 'checkbox', value: p.highContrastUI, half: true },
    { key: 'h2', type: 'heading', label: 'New Pages' },
    { key: 'defaultView', label: 'Open pages in', type: 'select', value: p.defaultView, half: true, options: [{ value: 'design', label: 'Design view' }, { value: 'split', label: 'Split view' }, { value: 'code', label: 'Code view' }, { value: 'preview', label: 'Preview' }] },
    { key: 'splitVertical', label: 'Split view side by side', type: 'checkbox', value: p.splitVertical, half: true },
    { key: 'defaultExtension', label: 'Page file extension', type: 'select', value: p.defaultExtension, half: true, options: ['html', 'htm', 'php'] },
    { key: 'defaultDoctype', label: 'Document type', type: 'select', value: p.defaultDoctype, half: true, options: DOCTYPES.filter((d) => d.id !== 'none').map((d) => ({ value: d.id, label: d.label })) },
    { key: 'defaultCharset', label: 'Character encoding', type: 'select', value: p.defaultCharset, half: true, options: ['utf-8', 'windows-1252', 'iso-8859-1'] },
    { key: 'h3', type: 'heading', label: 'Editing' },
    { key: 'cssMode', label: 'Formatting is written as', type: 'select', value: p.cssMode, half: true, options: [{ value: 'auto', label: 'Automatic (classes when a style sheet is linked)' }, { value: 'inline', label: 'Inline styles' }, { value: 'class', label: 'CSS classes' }, { value: 'tags', label: 'Tags (b, i, font)' }] },
    { key: 'useStrongEm', label: 'Use <strong> and <em> instead of <b> and <i>', type: 'checkbox', value: p.useStrongEm, half: true },
    { key: 'formatOnSave', label: 'Apply source formatting when saving pages', type: 'checkbox', value: p.formatOnSave, half: true },
    { key: 'warnExternal', label: 'Warn about files changed outside Anne\'s Loom', type: 'checkbox', value: p.warnExternal, half: true },
    { key: 'autoCorrect', label: 'AutoCorrect as you type', type: 'checkbox', value: p.autoCorrect, half: true },
    { key: 'smartQuotes', label: 'Smart quotes', type: 'checkbox', value: p.smartQuotes, half: true },
    { key: 'autoCapitalize', label: 'Capitalize the first letter of sentences', type: 'checkbox', value: p.autoCapitalize, half: true },
    { key: 'autoLists', label: 'Automatic bulleted and numbered lists', type: 'checkbox', value: p.autoLists, half: true },
    { key: 'spellcheck', label: 'Check spelling as you type', type: 'checkbox', value: p.spellcheck, half: true },
    { key: 'miniToolbar', label: 'Show the mini toolbar on selection', type: 'checkbox', value: p.miniToolbar, half: true },
    { key: 'h4', type: 'heading', label: 'Code View' },
    { key: 'codeLineNumbers', label: 'Line numbers', type: 'checkbox', value: p.codeLineNumbers, half: true },
    { key: 'codeWrap', label: 'Word wrap', type: 'checkbox', value: p.codeWrap, half: true },
    { key: 'codeFold', label: 'Code folding', type: 'checkbox', value: p.codeFold, half: true },
    { key: 'codeHighlightLine', label: 'Highlight the current line', type: 'checkbox', value: p.codeHighlightLine, half: true },
    { key: 'codeAutoClose', label: 'Close tags and brackets automatically', type: 'checkbox', value: p.codeAutoClose, half: true },
    { key: 'codeComplete', label: 'Code completion (IntelliSense)', type: 'checkbox', value: p.codeComplete, half: true },
    { key: 'tabSize', label: 'Tab size', type: 'number', value: p.tabSize, min: 1, max: 8, half: true },
    { key: 'codeFontSize', label: 'Font size', type: 'number', value: p.codeFontSize, min: 8, max: 32, suffix: 'px', half: true },
    { key: 'h5', type: 'heading', label: 'Saving and Publishing' },
    { key: 'autosave', label: 'Keep an unsaved copy of the site on this device', type: 'checkbox', value: p.autosave, half: true },
    { key: 'autosaveSeconds', label: 'Every (seconds)', type: 'number', value: p.autosaveSeconds, min: 3, max: 3600, half: true },
    { key: 'confirmClose', label: 'Ask to save when closing', type: 'checkbox', value: p.confirmClose, half: true },
    { key: 'publishChangedOnly', label: 'Publish changed files only', type: 'checkbox', value: p.publishChangedOnly, half: true },
    { key: 'h6', type: 'heading', label: 'Customize' },
    { key: 'bq', type: 'button', label: 'Customize Quick Access Bar…', onClick: () => void app.exec('file.customizeQat') },
    { key: 'br', type: 'button', label: 'Customize Tabs…', onClick: () => void app.exec('file.customizeRibbon') },
    { key: 'bk', type: 'button', label: 'Customize Keyboard…', onClick: () => void app.exec('file.customizeKeyboard') },
    { key: 'ba', type: 'button', label: 'AutoCorrect Options…', onClick: () => void app.exec('file.autocorrectOptions') },
    { key: 'bx', type: 'button', label: 'Export / Import Settings…', onClick: () => void app.exec('file.exportSettings') },
  ] });
  if (!r) return;
  const num = (v: any, d: number, lo: number, hi: number) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, Math.round(+v))) : d);
  Object.assign(p, {
    author: String(r.author || 'Author').trim() || 'Author', initials: String(r.initials || (r.author || 'A')[0]).trim(), theme: r.theme, uiScale: parseFloat(r.uiScale) || 1,
    menuStyle: r.menuStyle, classicMenus: r.classicMenus, qatPosition: r.qatPosition, qatLabels: !!r.qatLabels, touchMode: !!r.touchMode, highContrastUI: !!r.highContrastUI,
    defaultView: r.defaultView, splitVertical: !!r.splitVertical, defaultExtension: r.defaultExtension, defaultDoctype: r.defaultDoctype, defaultCharset: r.defaultCharset,
    cssMode: r.cssMode, useStrongEm: !!r.useStrongEm, formatOnSave: !!r.formatOnSave, warnExternal: !!r.warnExternal, autoCorrect: !!r.autoCorrect, smartQuotes: !!r.smartQuotes,
    autoCapitalize: !!r.autoCapitalize, autoLists: !!r.autoLists, spellcheck: !!r.spellcheck, miniToolbar: !!r.miniToolbar,
    codeLineNumbers: !!r.codeLineNumbers, codeWrap: !!r.codeWrap, codeFold: !!r.codeFold, codeHighlightLine: !!r.codeHighlightLine, codeAutoClose: !!r.codeAutoClose, codeComplete: !!r.codeComplete,
    tabSize: num(r.tabSize, 2, 1, 8), codeFontSize: num(r.codeFontSize, 13, 8, 32),
    autosave: !!r.autosave, autosaveSeconds: num(r.autosaveSeconds, 10, 3, 3600), confirmClose: !!r.confirmClose, publishChangedOnly: !!r.publishChangedOnly,
  });
  app.savePrefs();
  app.ui.applyPrefs();
}

// =============================================================================================
// Registration

const recentMenu = (app: App, sitesOnly: boolean): MenuEntry[] => {
  const list = app.prefs.recent.filter((r) => !sitesOnly || r.format === 'site' || r.format === 'qlsite' || r.format === 'zip');
  if (!list.length) return [{ label: sitesOnly ? '(no recent sites)' : '(no recent files or sites)' }];
  return [...list.slice(0, 15).map((r) => ({ id: 'file.openRecent', arg: r.key, label: `${r.pinned ? '📌 ' : ''}${r.name}`, icon: r.format === 'site' ? 'language' : r.format === 'qlsite' || r.format === 'zip' ? 'inventory_2' : 'description' })), { separator: true }, { id: 'file.clearRecent', label: 'Clear Unpinned' }];
};

const hasTab = (app: App) => !!app.active;

def([
  // New ---------------------------------------------------------------------------------------
  {
    id: 'file.new', label: 'New', icon: 'note_add', tab: 'Backstage', group: 'New', kind: 'split', keys: ['Mod-n'], popular: true, edits: false,
    tip: 'New page (the arrow lists every kind of new file and site)',
    run: (app, arg) => (arg ? app.exec(arg) : newPage(app)),
    menu: () => [
      { id: 'file.newPage', label: 'Page', icon: 'web' }, { id: 'file.newCss', label: 'Style Sheet', icon: 'css' }, { id: 'file.newJs', label: 'JavaScript', icon: 'javascript' },
      { id: 'file.newPhp', label: 'PHP Page', icon: 'php' }, { id: 'file.newXml', label: 'XML', icon: 'data_object' }, { id: 'file.newText', label: 'Text File', icon: 'description' },
      { separator: true }, { id: 'file.newFromTemplate', label: 'Page from Template…', icon: 'library_books' }, { id: 'file.newFromDwt', label: 'Page from Page Template (.dwt)…', icon: 'dashboard_customize' },
      { id: 'file.newDwtFile', label: 'Page Template (.dwt)', icon: 'dashboard' }, { id: 'file.newFluid', label: 'Fluid Grid Layout…', icon: 'view_column' },
      { separator: true }, { id: 'file.newSite', label: 'Site…', icon: 'language' },
    ],
  },
  { id: 'file.newPage', label: 'New Page', icon: 'web', tab: 'Backstage', group: 'New', popular: true, edits: false, keywords: 'blank html document', tip: 'A blank page in the site (Options set its document type and extension)', run: (app, arg) => newPage(app, arg) },
  { id: 'file.newCss', label: 'New Style Sheet', icon: 'css', tab: 'Backstage', group: 'New', edits: false, run: (app, arg) => { createFile(app, defaultDir(app, arg), 'untitled', 'css', '@charset "utf-8";\n\n'); } },
  { id: 'file.newJs', label: 'New JavaScript', icon: 'javascript', tab: 'Backstage', group: 'New', edits: false, run: (app, arg) => { createFile(app, defaultDir(app, arg), 'untitled', 'js', "'use strict';\n\n"); } },
  { id: 'file.newPhp', label: 'New PHP Page', icon: 'php', tab: 'Backstage', group: 'New', edits: false, run: (app, arg) => { createFile(app, defaultDir(app, arg), 'untitled', 'php', newPageText(app, 'Untitled', '\n<?php\n// PHP code runs on the web server; Preview shows the page without running it.\n?>\n')); } },
  { id: 'file.newXml', label: 'New XML File', icon: 'data_object', tab: 'Backstage', group: 'New', edits: false, run: (app, arg) => { createFile(app, defaultDir(app, arg), 'untitled', 'xml', '<?xml version="1.0" encoding="utf-8"?>\n<root>\n  \n</root>\n'); } },
  { id: 'file.newText', label: 'New Text File', icon: 'description', tab: 'Backstage', group: 'New', edits: false, run: (app, arg) => { createFile(app, defaultDir(app, arg), 'untitled', 'txt', ''); } },
  {
    id: 'file.newFromTemplate', label: 'New Page from Template…', icon: 'library_books', tab: 'Backstage', group: 'New', edits: false, origin: 'FrontPage',
    run: async (app) => {
      const pages = TEMPLATES.filter((t) => t.kind === 'page');
      const mine = await kvKeys('tpl:');
      const opts = [...pages.map((t) => ({ value: 'b:' + t.id, label: `${t.name} — ${t.description}` })), ...mine.map((k) => ({ value: 'm:' + k, label: `${k.slice(4)} (My Templates)` }))];
      const r = await openDialog({ title: 'New Page from Template', fields: [{ key: 't', label: 'Template', type: 'list', rows: 12, options: opts, value: opts[0]?.value }], buttons: [{ label: 'Site Templates…', onClick: (_v, ctl) => { ctl.close(); app.ui.showBackstage('new'); } }] });
      if (!r?.t) return;
      if (r.t.startsWith('b:')) newPage(app, { template: r.t.slice(2) }); else await newFromMyTemplate(app, r.t.slice(2));
    },
  },
  { id: 'file.newFromDwt', label: 'New Page from Page Template…', icon: 'dashboard_customize', tab: 'Backstage', group: 'New', edits: false, origin: 'Expression Web, Dreamweaver', tip: 'A page attached to one of the site\'s .dwt templates', run: (app, arg) => newFromDwt(app, arg) },
  { id: 'file.newDwtFile', label: 'New Page Template (.dwt)', icon: 'dashboard', tab: 'Backstage', group: 'New', edits: false, origin: 'Expression Web, Dreamweaver', run: (app) => newDwt(app) },
  { id: 'file.newFluid', label: 'New Fluid Grid Layout…', icon: 'view_column', tab: 'Backstage', group: 'New', edits: false, origin: 'Dreamweaver', keywords: 'responsive columns grid mobile', run: (app) => newFluid(app) },
  { id: 'file.newSite', label: 'New Site…', icon: 'language', tab: 'Backstage', group: 'New', edits: false, popular: true, run: (app, arg) => newSite(app, arg) },
  {
    id: 'file.newSiteFromTemplate', label: 'New Site from Template…', icon: 'auto_awesome_mosaic', tab: 'Backstage', group: 'New', edits: false,
    run: async (app) => {
      const list = TEMPLATES.filter((t) => t.kind === 'site');
      if (!list.length) { toast('No site templates are installed; showing the New page.'); app.ui.showBackstage('new'); return; }
      const r = await openDialog({ title: 'New Site from Template', fields: [
        { key: 'tpl', label: 'Template', type: 'list', rows: 10, options: list.map((t) => ({ value: t.id, label: `${t.name} — ${t.description}` })), value: list[0].id },
        { key: 'name', label: 'Site name', type: 'text', value: 'My Web Site' },
      ] });
      if (r?.tpl) await newSite(app, { how: 'template', tpl: r.tpl, name: r.name });
    },
  },
  { id: 'file.newSiteFromExisting', label: 'New Site from Existing…', icon: 'content_copy', tab: 'Backstage', group: 'New', edits: false, tip: 'A copy of the open site, or a new site from a folder, ZIP or web address', run: async (app) => {
    const c = await choiceDialog('New Site from Existing', 'Start the new site from:', [`A Copy of "${app.site.name}"`, 'A Folder, ZIP or Web Address…']);
    if (c === 0) await newSite(app, { how: 'copy', name: `Copy of ${app.site.name}` });
    else if (c === 1) await app.exec('file.importSiteWizard', { to: 'new' });
  } },
  { id: 'file.newBlankSite', label: 'New Empty Site', icon: 'add_box', tab: 'Backstage', group: 'New', edits: false, run: async (app) => { const n = await promptDialog('New Empty Site', 'Site name', 'My Web Site'); if (n != null) await newSite(app, { how: 'blank', name: n || 'My Web Site' }); } },
  { id: 'file.newFromMyTemplate', label: 'New from My Template', icon: 'bookmarks', tab: 'Backstage', group: 'New', edits: false, run: (app, key) => newFromMyTemplate(app, key) },
  { id: 'file.saveAsMyTemplate', label: 'Save as My Template…', icon: 'bookmark_add', tab: 'Backstage', group: 'Save', noRecord: true, edits: false, tip: 'Keep this page or the whole site as a starting point under File ▸ New ▸ My Templates', run: (app, what) => saveAsMyTemplate(app, what) },

  // Open --------------------------------------------------------------------------------------
  {
    id: 'file.open', label: 'Open…', icon: 'file_open', tab: 'Backstage', group: 'Open', keys: ['Mod-o'], popular: true, noRecord: true, edits: false,
    tip: 'A page, style sheet, script, picture, .qlsite, ZIP, web archive or WordPress export (opened by its content)',
    run: async (app) => {
      const f = await openDocument(`${OPEN_ACCEPT},.wxr,.png,.jpg,.jpeg,.gif,.webp,.ico,.avif,.csv,.inc`, [...OPEN_MIMES, 'image/*']);
      if (!f) return;
      app.ui.hideBackstage();
      await openBuffer(app, f.data, f.name, f.uri);
    },
  },
  {
    id: 'file.openDropped', label: 'Open Dropped Files', icon: 'file_open', tab: 'Backstage', group: 'Open', internal: true, noRecord: true, edits: false,
    run: async (app, files: File[]) => {
      const list = [...(files || [])];
      if (!list.length) return;
      if (list.length === 1) { await openBuffer(app, await list[0].arrayBuffer(), list[0].name, null); return; }
      const sites = list.filter((f) => /\.(zip|qlsite|mht|mhtml)$/i.test(f.name));
      if (sites.length) { for (const f of sites) await openBuffer(app, await f.arrayBuffer(), f.name, null); return; }
      await importFiles(app, { files: list });
    },
  },
  { id: 'file.openSite', label: 'Open Site…', icon: 'folder_open', tab: 'Backstage', group: 'Open', popular: true, noRecord: true, edits: false, tip: 'Edit a folder of web files in place', run: (app) => openSiteFolder(app) },
  { id: 'file.openUrl', label: 'Open from Web Address…', icon: 'public', tab: 'Backstage', group: 'Open', noRecord: true, edits: false, origin: 'Composer', tip: 'Download a published page (and optionally the pages it links) into a new site', run: (app, arg) => openUrl(app, arg) },
  {
    id: 'file.openRecent', label: 'Recent Files', icon: 'history', tab: 'Backstage', group: 'Open', kind: 'menu', noRecord: true, edits: false,
    run: async (app, key) => { if (!key) { app.ui.showBackstage('open'); return; } app.ui.hideBackstage(); await openRecentEntry(app, key); },
    menu: (app) => recentMenu(app, false),
  },
  { id: 'file.openRecentSite', label: 'Recent Sites', icon: 'travel_explore', tab: 'Backstage', group: 'Open', kind: 'menu', noRecord: true, edits: false, run: async (app, key) => { if (!key) { app.ui.showBackstage('open'); return; } await openRecentEntry(app, key); }, menu: (app) => recentMenu(app, true) },
  {
    id: 'file.clearRecent', label: 'Clear Recent List', icon: 'delete_sweep', tab: 'Backstage', group: 'Open', noRecord: true, edits: false, tip: 'Remove every unpinned site and file from the recent list (and the copies kept for reopening them)',
    run: (app) => { for (const r of app.prefs.recent) if (!r.pinned) void kvDel('recent:' + r.key); app.prefs.recent = app.prefs.recent.filter((r) => r.pinned); app.savePrefs(); toast('Recent list cleared'); },
  },
  { id: 'file.recoverUnsaved', label: 'Recover Unsaved Site', icon: 'restore_page', tab: 'Backstage', group: 'Open', noRecord: true, edits: false, run: (app) => recoverUnsaved(app) },
  { id: 'file.openInFrame', label: 'Open in Frame…', icon: 'view_quilt', tab: 'Backstage', group: 'Open', edits: true, origin: 'Dreamweaver', isEnabled: isPage, tip: 'Show another site page in a frame of this frames page', run: (app) => openInFrame(app) },

  // Save --------------------------------------------------------------------------------------
  { id: 'file.save', label: 'Save', icon: 'save', tab: 'Backstage', group: 'Save', keys: ['Mod-s'], popular: true, edits: false, run: (app) => saveTab(app) },
  { id: 'file.saveAs', label: 'Save As…', icon: 'save_as', tab: 'Backstage', group: 'Save', popular: true, edits: false, noRecord: true, tip: 'Save the file under another name in the site (or a copy to this device)', run: (app) => saveAsCmd(app) },
  { id: 'file.saveAll', label: 'Save All', icon: 'library_add_check', tab: 'Backstage', group: 'Save', keys: ['Mod-Shift-s'], popular: true, edits: false, tip: 'Save every changed file of the site', run: (app) => saveSite(app) },
  { id: 'file.saveSiteAs', label: 'Save Site As…', icon: 'drive_folder_upload', tab: 'Backstage', group: 'Save', noRecord: true, edits: false, run: (app) => saveSiteAs(app) },
  { id: 'file.saveSiteToFolder', label: 'Save Site to Folder…', icon: 'folder_copy', tab: 'Backstage', group: 'Save', noRecord: true, edits: false, run: (app) => saveSiteToFolder(app) },
  { id: 'file.saveRelated', label: 'Save Page and Related Files', icon: 'file_save', tab: 'Backstage', group: 'Save', edits: false, origin: 'Dreamweaver', tip: 'Save the page and the changed style sheets and scripts it uses', isEnabled: hasTab, run: (app) => saveRelated(app) },
  { id: 'file.saveAsCharset', label: 'Save with Encoding…', icon: 'translate', tab: 'Backstage', group: 'Save', edits: true, origin: 'Composer', isEnabled: isPage, tip: 'Change the page\'s character encoding and save', run: (app) => saveAsCharset(app) },
  { id: 'file.revert', label: 'Revert', icon: 'settings_backup_restore', tab: 'Backstage', group: 'Save', edits: true, origin: 'Dreamweaver', isEnabled: isText, tip: 'Discard changes since the file was opened or last saved', run: (app) => revert(app) },
  { id: 'file.autosave', label: 'AutoSave', icon: 'autorenew', tab: 'Backstage', group: 'Save', kind: 'toggle', noRecord: true, edits: false, tip: 'Keep an unsaved copy of the site on this device while you work', isActive: (app) => app.prefs.autosave, run: (app) => { app.prefs.autosave = !app.prefs.autosave; app.savePrefs(); if (app.prefs.autosave) app.scheduleAutosave(); toast(app.prefs.autosave ? 'AutoSave on: an unsaved copy of the site is kept on this device.' : 'AutoSave off'); } },

  // Close -------------------------------------------------------------------------------------
  { id: 'file.close', label: 'Close', icon: 'close', tab: 'Backstage', group: 'Close', keys: ['Mod-w', 'Mod-F4'], popular: true, noRecord: true, edits: false, run: (app, arg) => closeTabCmd(app, arg) },
  { id: 'file.closeAll', label: 'Close All Files', icon: 'tab_close', tab: 'Backstage', group: 'Close', noRecord: true, edits: false, run: (app) => closeTabs(app) },
  {
    id: 'file.closeSite', label: 'Close Site', icon: 'folder_off', tab: 'Backstage', group: 'Close', noRecord: true, edits: false,
    run: async (app) => { if (!(await confirmLeaveSite(app))) return; app.setSite(new Site('My Web Site')); for (const d of app.docs) d.dirty = false; app.siteDirty = false; app.ui.hideBackstage(); app.ui.tabsChanged(); },
  },
  { id: 'file.exit', label: 'Exit', icon: 'logout', tab: 'Backstage', group: 'Close', noRecord: true, edits: false, run: (app) => exitApp(app) },

  // Import ------------------------------------------------------------------------------------
  { id: 'file.importFiles', label: 'Import Files…', icon: 'upload_file', tab: 'Backstage', group: 'Import', edits: true, tip: 'Add pages, pictures and other files to a folder of the site', run: (app, arg) => importFiles(app, arg) },
  { id: 'file.importFolder', label: 'Import Folder…', icon: 'drive_folder_upload', tab: 'Backstage', group: 'Import', edits: true, run: (app) => importFolder(app) },
  { id: 'file.importZip', label: 'Import ZIP…', icon: 'folder_zip', tab: 'Backstage', group: 'Import', edits: true, tip: 'Add every file of a ZIP archive to the site', run: (app) => importZip(app) },
  { id: 'file.importSiteWizard', label: 'Import Site Wizard…', icon: 'move_to_inbox', tab: 'Backstage', group: 'Import', edits: false, noRecord: true, origin: 'FrontPage, Expression Web', tip: 'Copy a site from a folder, ZIP, web address or .qlsite file into a new or the open site', run: (app, arg) => importSiteWizard(app, arg) },
  { id: 'file.importTabular', label: 'Import Tabular Data…', icon: 'table_view', tab: 'Backstage', group: 'Import', edits: true, origin: 'Dreamweaver', isEnabled: isPage, tip: 'Insert a CSV or tab-separated file as a table', run: (app) => importTabular(app) },
  { id: 'file.importXml', label: 'Import XML into Template…', icon: 'data_object', tab: 'Backstage', group: 'Import', edits: true, origin: 'Dreamweaver', tip: 'Make a page from template XML (the format Export Template Data as XML writes)', run: (app) => importXml(app) },

  // Export ------------------------------------------------------------------------------------
  { id: 'file.exportFile', label: 'Save a Copy of This File…', icon: 'download', tab: 'Backstage', group: 'Export', noRecord: true, edits: false, run: (app, path) => exportFile(app, path) },
  { id: 'file.exportZip', label: 'Export Site as ZIP…', icon: 'folder_zip', tab: 'Backstage', group: 'Export', popular: true, noRecord: true, edits: false, tip: 'Every file of the site in one ZIP, ready to upload anywhere', run: (app) => saveSiteFile(app, 'zip', { as: true }) },
  { id: 'file.exportQlsite', label: 'Export Site as .qlsite…', icon: 'inventory_2', tab: 'Backstage', group: 'Export', noRecord: true, edits: false, tip: 'One file with every page, picture and site setting', run: (app) => saveSiteFile(app, 'qlsite', { as: true }) },
  { id: 'file.exportPackage', label: 'Export Web Package…', icon: 'deployed_code', tab: 'Backstage', group: 'Export', noRecord: true, edits: false, origin: 'Expression Web (Personal Web Package)', run: (app) => exportPackage(app) },
  { id: 'file.exportText', label: 'Export as Text…', icon: 'text_snippet', tab: 'Backstage', group: 'Export', noRecord: true, edits: false, origin: 'Composer', isEnabled: isText, run: (app) => exportText(app) },
  { id: 'file.exportPdf', label: 'Export as PDF…', icon: 'picture_as_pdf', tab: 'Backstage', group: 'Export', noRecord: true, edits: false, tip: 'Opens the print dialog: choose "Save as PDF" as the printer', run: (app) => { toast('In the print dialog, choose "Save as PDF" (or "Microsoft Print to PDF") as the printer.', { ms: 6000 }); printPage(app); } },
  { id: 'file.exportTable', label: 'Export Table…', icon: 'grid_on', tab: 'Backstage', group: 'Export', noRecord: true, edits: false, origin: 'Dreamweaver', isEnabled: isPage, tip: 'Save the selected (or a chosen) table as CSV', run: (app) => exportTable(app) },
  { id: 'file.exportTemplateXml', label: 'Export Template Data as XML…', icon: 'code', tab: 'Backstage', group: 'Export', noRecord: true, edits: false, origin: 'Dreamweaver', isEnabled: isPage, run: (app) => exportTemplateXml(app) },

  // Preview and print -------------------------------------------------------------------------
  {
    id: 'file.previewBrowser', label: 'Preview in Browser', icon: 'travel_explore', tab: 'Backstage', group: 'Preview', kind: 'split', keys: ['F12'], popular: true, noRecord: true, edits: false,
    tip: 'Open the page in a new browser window (its scripts run in a sandbox, never with access to Anne\'s Loom)',
    run: (app, arg) => previewInBrowser(app, typeof arg === 'number' && arg > 0 ? arg : undefined),
    menu: () => [{ id: 'file.previewBrowser', label: 'Full Window' }, ...loadBrowsers().map((b) => ({ id: 'file.previewBrowser', arg: b.width, label: `${b.name} (${b.width} px)` })), { separator: true }, { id: 'file.previewMultiple', label: 'All Sizes at Once' }, { id: 'file.editBrowsers', label: 'Edit Browser List…' }],
  },
  { id: 'file.previewMultiple', label: 'Preview in Multiple Sizes', icon: 'devices', tab: 'Backstage', group: 'Preview', noRecord: true, edits: false, origin: 'Expression Web', tip: 'A new window with the page at every size in the browser list', run: (app) => previewMultiple(app) },
  { id: 'file.previewSizes', label: 'Preview at Several Sizes', icon: 'responsive_layout', tab: 'Backstage', group: 'Preview', noRecord: true, edits: false, keywords: 'responsive phone tablet desktop', run: (app) => previewSizes(app) },
  { id: 'file.previewPrint', label: 'Preview Print Layout in Browser', icon: 'print_connect', tab: 'Backstage', group: 'Preview', noRecord: true, edits: false, run: (app) => printPreview(app, true) },
  {
    id: 'file.editBrowsers', label: 'Edit Browser List…', icon: 'edit_note', tab: 'Backstage', group: 'Preview', noRecord: true, edits: false, origin: 'Expression Web, Dreamweaver',
    run: async () => {
      const r = await openDialog({ title: 'Edit Browser List', help: 'Preview in Browser opens the page in this browser at each of these window widths. One per line: name = width (or width × height).', fields: [{ key: 'list', label: 'Sizes', type: 'textarea', rows: 8, value: loadBrowsers().map((b) => `${b.name} = ${b.width}${b.height ? ` x ${b.height}` : ''}`).join('\n') }], buttons: [{ label: 'Defaults', onClick: (_v, ctl) => ctl.set('list', DEFAULT_BROWSERS.map((b) => `${b.name} = ${b.width} x ${b.height}`).join('\n')) }] });
      if (!r) return;
      const list = String(r.list).split('\n').map((l) => /^(.+?)\s*=\s*(\d+)(?:\s*[x×]\s*(\d+))?\s*$/i.exec(l.trim())).filter(Boolean).map((m) => ({ name: m![1].trim(), width: Math.max(200, Math.min(7680, +m![2])), height: m![3] ? Math.max(200, Math.min(7680, +m![3])) : undefined }));
      try { localStorage.setItem('quillloom.browsers.v1', JSON.stringify(list.length ? list : DEFAULT_BROWSERS)); } catch { /* storage unavailable */ }
      toast(`${list.length || DEFAULT_BROWSERS.length} preview sizes`);
    },
  },
  { id: 'file.print', label: 'Print…', icon: 'print', tab: 'Backstage', group: 'Print', keys: ['Mod-p'], popular: true, noRecord: true, edits: false, tip: 'Print the page as it looks in a browser (with your page setup)', run: (app) => printPage(app) },
  { id: 'file.quickPrint', label: 'Quick Print', icon: 'print', tab: 'Backstage', group: 'Print', noRecord: true, edits: false, run: (app) => printPage(app) },
  { id: 'file.printCode', label: 'Print Code', icon: 'code', tab: 'Backstage', group: 'Print', noRecord: true, edits: false, origin: 'Dreamweaver', isEnabled: isText, tip: 'Print the source with line numbers', run: (app) => printCode(app) },
  { id: 'file.printPreview', label: 'Print Preview', icon: 'preview', tab: 'Backstage', group: 'Print', noRecord: true, edits: false, run: (app) => printPreview(app) },
  { id: 'file.pageSetup', label: 'Page Setup…', icon: 'tune', tab: 'Backstage', group: 'Print', noRecord: true, edits: false, tip: 'Paper size, orientation, margins and print options', run: (app) => pageSetupDialog(app) },

  // Info --------------------------------------------------------------------------------------
  { id: 'file.pageProperties', label: 'Page Properties…', icon: 'description', tab: 'Backstage', group: 'Info', popular: true, edits: true, origin: 'FrontPage, Expression Web', isEnabled: isPage, keywords: 'title meta description keywords background colors margins language doctype refresh base', run: (app) => pageProperties(app) },
  { id: 'file.properties', label: 'File Properties…', icon: 'info', tab: 'Backstage', group: 'Info', edits: true, origin: 'FrontPage', tip: 'Size, dates, links, summary, review status and publishing of the file', run: (app, path) => fileProperties(app, path) },
  { id: 'file.designNotes', label: 'Design Notes…', icon: 'sticky_note_2', tab: 'Backstage', group: 'Info', edits: true, origin: 'Dreamweaver', tip: 'Private notes and a status for the file (never published)', run: (app, path) => designNotes(app, path) },
  { id: 'file.search', label: 'File Search…', icon: 'manage_search', tab: 'Backstage', group: 'Info', noRecord: true, edits: false, origin: 'FrontPage', tip: 'Find site files by name or content', run: (app) => fileSearch(app) },
  { id: 'file.email', label: 'Email…', icon: 'attach_email', tab: 'Backstage', group: 'Share', noRecord: true, edits: false, isEnabled: hasTab, tip: 'Send the page as an attachment or start an email with its text', run: (app) => emailPage(app) },

  // Options -----------------------------------------------------------------------------------
  { id: 'file.options', label: 'Options…', icon: 'settings', tab: 'Backstage', group: 'Options', popular: true, noRecord: true, edits: false, run: (app) => optionsDialog(app) },
  { id: 'file.customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune', tab: 'Backstage', group: 'Options', noRecord: true, edits: false, run: (app) => app.ui.customizeQat() },
  { id: 'file.customizeRibbon', label: 'Customize Tabs…', icon: 'view_quilt', tab: 'Backstage', group: 'Options', noRecord: true, edits: false, run: (app) => app.ui.customizeRibbon() },
  { id: 'file.customizeKeyboard', label: 'Customize Keyboard…', icon: 'keyboard', tab: 'Backstage', group: 'Options', noRecord: true, edits: false, run: (app, id) => app.ui.customizeKeyboard(typeof id === 'string' ? id : undefined) },
  {
    id: 'file.autocorrectOptions', label: 'AutoCorrect Options…', icon: 'auto_fix_normal', tab: 'Backstage', group: 'Options', noRecord: true, edits: false,
    run: async (app) => {
      const r = await openDialog({ title: 'AutoCorrect', wide: true, fields: [
        { key: 'on', label: 'Replace text as you type (Design view)', type: 'checkbox', value: app.prefs.autoCorrect },
        { key: 'quotes', label: 'Smart quotes', type: 'checkbox', value: app.prefs.smartQuotes },
        { key: 'caps', label: 'Capitalize the first letter of sentences', type: 'checkbox', value: app.prefs.autoCapitalize },
        { key: 'lists', label: 'Automatic bulleted and numbered lists', type: 'checkbox', value: app.prefs.autoLists },
        { key: 'list', label: 'Replacements (one per line: typed => replacement)', type: 'textarea', rows: 12, value: Object.entries(app.prefs.replacements).map(([k, x]) => `${k} => ${x}`).join('\n') },
      ], buttons: [{ label: 'Reset to Defaults', onClick: (_v, ctl) => ctl.set('list', Object.entries(DEFAULT_REPLACEMENTS).map(([k, x]) => `${k} => ${x}`).join('\n')) }] });
      if (!r) return;
      Object.assign(app.prefs, { autoCorrect: !!r.on, smartQuotes: !!r.quotes, autoCapitalize: !!r.caps, autoLists: !!r.lists });
      app.prefs.replacements = Object.fromEntries(String(r.list).split('\n').map((l) => l.split('=>')).filter((x) => x.length === 2 && x[0].trim()).map(([k, x]) => [k.trim(), x.trim()]));
      app.savePrefs();
    },
  },
  {
    id: 'file.exportSettings', label: 'Export / Import Settings…', icon: 'import_export', tab: 'Backstage', group: 'Options', noRecord: true, edits: false,
    run: async (app) => {
      const r = await openDialog({ title: 'Settings Transfer', wide: true, help: 'Copy this text to back up your Quick Access Bar, custom tabs, shortcuts, macros, AutoCorrect and options. Paste settings here and choose Import to restore them. The format is shared with the other Anne\'s Office apps; settings that do not apply are ignored.', fields: [{ key: 'json', label: 'Settings (JSON)', type: 'textarea', rows: 14, value: JSON.stringify({ ...app.prefs, recent: [] }, null, 1) }], ok: 'Import', buttons: [{ label: 'Copy', onClick: (x) => { void navigator.clipboard?.writeText(x.json); toast('Copied'); } }, { label: 'Save to File…', onClick: (x) => download(new Blob([x.json], { type: 'application/json' }), 'quillloom-settings.json') }] });
      if (!r) return;
      let p: unknown;
      try { p = JSON.parse(r.json); } catch { /* reported below */ }
      if (!p || typeof p !== 'object' || Array.isArray(p)) { toast('That is not valid settings JSON.'); return; }
      const before = JSON.parse(JSON.stringify(app.prefs));
      Object.assign(app.prefs, sanitizePrefs(p), { recent: app.prefs.recent });
      try { app.ui.applyPrefs(); app.ui.rebuild(); } catch (e: any) {
        Object.assign(app.prefs, before); app.ui.applyPrefs(); app.ui.rebuild();
        toast(`These settings could not be applied: ${e?.message || e}`);
        return;
      }
      app.savePrefs();
      toast('Settings imported');
    },
  },
  {
    id: 'file.resetCustomizations', label: 'Reset All Customizations', icon: 'restart_alt', tab: 'Backstage', group: 'Options', noRecord: true, edits: false,
    run: async (app) => {
      if (!(await confirmDialog('Reset', 'Reset the Quick Access Bar, custom tabs and keyboard shortcuts to their defaults?', 'Reset'))) return;
      Object.assign(app.prefs, { qat: [...DEFAULT_QAT], customTabs: [], hiddenTabs: [], tabOrder: [], keymap: {} });
      app.savePrefs();
      app.ui.rebuild();
    },
  },
]);

