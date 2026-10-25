/**
 * MHTML web archives (.mht/.mhtml): a page and its resources in one MIME multipart/related message, as
 * browsers save "Web Page, Single File". Parts carry Content-Location (the original address) or Content-ID
 * (referenced as cid:), encoded as quoted-printable, base64 or 8-bit.
 *
 * parseMhtml() returns the page with its references rewritten to local files in a "<name>_files" folder;
 * buildMhtml() writes a page of the site and everything it uses (pictures, style sheets and what they
 * import, scripts, fonts) as one archive.
 */
import type { Site } from '../model/site';
import { b64 } from '../model/site';
import { baseName, extOf, isPagePath, mimeOf, slugify, stripExt } from '../model/paths';
import { linksOf, rewriteRefs } from '../model/site';
import { getTitle } from '../model/html';
import { expandIncludes } from '../site/templates';

export function isMhtml(text: string): boolean { return /^(?:[\s\S]{0,2000}?)Content-Type:\s*multipart\/related/i.test(text); }

interface Part { headers: Map<string, string>; body: Uint8Array }

const latin1 = (u8: Uint8Array) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return s; };
const fromLatin1 = (s: string) => { const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff; return u8; };

function parseHeaders(block: string): Map<string, string> {
  const h = new Map<string, string>();
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return h;
}

function param(header: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header);
  return m ? m[1] ?? m[2] : undefined;
}

export function decodeQuotedPrintable(s: string): Uint8Array {
  const t = s.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

export function encodeQuotedPrintable(u8: Uint8Array): string {
  const lines: string[] = [];
  let line = '';
  const push = (tok: string) => { if (line.length + tok.length > 75) { lines.push(line + '='); line = ''; } line += tok; };
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    if (b === 0x0a) { lines.push(line.replace(/[ \t]$/, (m) => `=${m.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)); line = ''; continue; }
    if (b === 0x0d) continue;
    const ch = (b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    push(ch);
  }
  lines.push(line);
  return lines.join('\r\n');
}

function decodeBody(body: string, enc: string): Uint8Array {
  const e = (enc || '').toLowerCase();
  if (e === 'base64') {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, '');
    try { return fromLatin1(atob(clean)); } catch { return new Uint8Array(); }
  }
  if (e === 'quoted-printable') return decodeQuotedPrintable(body);
  return fromLatin1(body);
}

function splitParts(text: string): { top: Map<string, string>; parts: Part[] } {
  const sep = /\r?\n\r?\n/.exec(text);
  if (!sep) throw new Error('This is not a web archive (no MIME headers).');
  const top = parseHeaders(text.slice(0, sep.index));
  const ct = top.get('content-type') || '';
  const boundary = param(ct, 'boundary');
  if (!/multipart\//i.test(ct) || !boundary) {
    // A single-part archive: the whole body is the page.
    return { top, parts: [{ headers: top, body: decodeBody(text.slice(sep.index + sep[0].length), top.get('content-transfer-encoding') || '') }] };
  }
  const parts: Part[] = [];
  const chunks = text.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
  for (const chunk of chunks.slice(1)) {
    if (!chunk.trim()) continue;
    const s = /\r?\n\r?\n/.exec(chunk);
    if (!s) continue;
    const headers = parseHeaders(chunk.slice(0, s.index));
    if (!headers.size) continue;
    parts.push({ headers, body: decodeBody(chunk.slice(s.index + s[0].length), headers.get('content-transfer-encoding') || '') });
  }
  return { top, parts };
}

function decodeText(u8: Uint8Array, charset?: string): string {
  try { return new TextDecoder(charset || 'utf-8').decode(u8); } catch { return new TextDecoder('utf-8').decode(u8); }
}

const EXT_FOR: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'text/css': 'css', 'text/javascript': 'js', 'application/javascript': 'js', 'application/x-javascript': 'js', 'font/woff2': 'woff2', 'font/woff': 'woff', 'application/font-woff': 'woff', 'font/ttf': 'ttf', 'text/html': 'html' };

function abs(ref: string, base: string): string | null {
  try { return new URL(ref.replace(/&amp;/g, '&'), base || undefined).href; } catch { return null; }
}

/**
 * Reads an archive. `files` are keyed by paths relative to the page ("page_files/logo.png"); the page's
 * references point at them.
 */
export function parseMhtml(bytes: Uint8Array, opts: { folder?: string } = {}): { html: string; files: Map<string, Uint8Array>; title?: string; report?: string[] } {
  const text = latin1(bytes);
  const { top, parts } = splitParts(text);
  const report: string[] = [];
  const start = param(top.get('content-type') || '', 'start')?.replace(/^<|>$/g, '');
  const snapshot = top.get('snapshot-content-location');
  const isHtml = (p: Part) => /text\/html|application\/xhtml/i.test(p.headers.get('content-type') || '');
  const main = parts.find((p) => start && (p.headers.get('content-id') || '').replace(/^<|>$/g, '') === start)
    || parts.find((p) => snapshot && p.headers.get('content-location') === snapshot)
    || parts.find(isHtml) || parts[0];
  if (!main) throw new Error('The web archive is empty.');
  const mainLoc = main.headers.get('content-location') || '';
  let html = decodeText(main.body, param(main.headers.get('content-type') || '', 'charset'));
  const title = getTitle(html) || undefined;
  const folder = opts.folder || `${slugify(title || stripExt(baseName(mainLoc.replace(/[?#].*$/, ''))) || 'page')}_files`;

  // Assign local names.
  const byUrl = new Map<string, string>();
  const used = new Set<string>();
  const files = new Map<string, Uint8Array>();
  const partFor = new Map<string, Part>();
  for (const p of parts) {
    if (p === main) continue;
    const loc = p.headers.get('content-location');
    const cid = (p.headers.get('content-id') || '').replace(/^<|>$/g, '');
    const type = (p.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    let name = loc ? decodeURIComponent(baseName(loc.replace(/[?#].*$/, '')) || '') : '';
    name = name.replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
    if (!extOf(name) && EXT_FOR[type]) name += '.' + EXT_FOR[type];
    let local = `${folder}/${name}`;
    for (let n = 2; used.has(local); n++) local = `${folder}/${stripExt(name)}_${n}${extOf(name) ? '.' + extOf(name) : ''}`;
    used.add(local);
    if (loc) { const a = abs(loc, mainLoc) || loc; byUrl.set(a, local); byUrl.set(loc, local); }
    if (cid) byUrl.set('cid:' + cid, local);
    partFor.set(local, p);
  }
  const lookup = (ref: string, base: string): string | null => {
    const r = ref.trim();
    if (!r || r.startsWith('data:') || r.startsWith('#') || r.startsWith('javascript:')) return null;
    if (byUrl.has(r)) return byUrl.get(r)!;
    const a = abs(r, base);
    if (a && byUrl.has(a)) return byUrl.get(a)!;
    if (a) { const noHash = a.replace(/#.*$/, ''); if (byUrl.has(noHash)) return byUrl.get(noHash)!; }
    return null;
  };
  const relFromFolder = (local: string) => local.slice(folder.length + 1);
  const rewriteCss = (css: string, base: string, fromFolder: boolean) => css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, ref) => { const l = lookup(ref, base); return l ? `url(${q}${fromFolder ? relFromFolder(l) : l}${q})` : m; })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, ref) => { const l = lookup(ref, base); return l ? `@import ${q}${fromFolder ? relFromFolder(l) : l}${q}` : m; });

  for (const [local, p] of partFor) {
    const type = (p.headers.get('content-type') || '').toLowerCase();
    const loc = p.headers.get('content-location') || mainLoc;
    if (/text\/css/.test(type)) files.set(local, new TextEncoder().encode(rewriteCss(decodeText(p.body, param(type, 'charset')), abs(loc, mainLoc) || loc, true)));
    else if (/text\/html/.test(type)) files.set(local, new TextEncoder().encode(rewriteHtml(decodeText(p.body, param(type, 'charset')), abs(loc, mainLoc) || loc, (r, b) => { const l = lookup(r, b); return l ? relFromFolder(l) : null; }, (c, b) => rewriteCss(c, b, true))));
    else files.set(local, p.body);
  }
  const base = /<base\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] || mainLoc;
  html = rewriteHtml(html, base, lookup, (c, b) => rewriteCss(c, b, false));
  html = html.replace(/<base\b[^>]*>\s*/i, '');
  if (!/<meta\s+charset/i.test(html)) html = html.replace(/<head([^>]*)>/i, '<head$1>\n<meta charset="utf-8">');
  html = html.replace(/(<meta[^>]+charset\s*=\s*["']?)[\w-]+/i, '$1utf-8');
  report.push(`Web archive${title ? ` "${title}"` : ''}: the page and ${files.size} resource(s) (saved in ${folder}/).`);
  if (mainLoc) report.push(`Saved from ${mainLoc}.`);
  const scripts = (html.match(/<script\b/gi) || []).length;
  if (scripts) report.push(`The page has ${scripts} script(s); they are kept, but they do not run in Design view.`);
  return { html, files, title, report };
}

function rewriteHtml(html: string, base: string, lookup: (ref: string, base: string) => string | null, css: (c: string, base: string) => string): string {
  return html
    .replace(/(\s(?:src|href|background|poster|data|data-src)\s*=\s*)(["'])([^"']*)\2/gi, (m, a, q, ref) => { const l = lookup(ref, base); return l ? `${a}${q}${l}${q}` : m; })
    .replace(/(\s(?:srcset|data-srcset)\s*=\s*)(["'])([^"']*)\2/gi, (m, a, q, list: string) => `${a}${q}${list.split(',').map((part) => { const t = part.trim().split(/\s+/); const l = t[0] && lookup(t[0], base); if (l) t[0] = l; return t.join(' '); }).join(', ')}${q}`)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, c, z) => a + css(c, base) + z)
    .replace(/(\sstyle\s*=\s*)(["'])([^"']*url\([^"']*)\2/gi, (m, a, q, c) => a + q + css(c.replace(/&quot;/g, "'"), base) + q);
}

// ------------------------------------------------------------------------------------------
// Writing

const LOCAL_BASE = 'https://site.invalid/';
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();

/** Builds an archive of one page of the site with every file it uses. */
export function buildMhtml(site: Site, pagePath: string): string {
  const src0 = site.read(pagePath);
  if (src0 == null) throw new Error(`${pagePath} is not in the site.`);
  const src = expandIncludes(site, pagePath, src0);
  const need: string[] = [];
  const seen = new Set<string>();
  const visit = (text: string, from: string, depth: number) => {
    for (const [target] of linksOf(text, from)) {
      if (seen.has(target) || !site.has(target)) continue;
      // Links to other pages stay links; their targets are not part of this page.
      if (isPagePath(target)) continue;
      seen.add(target);
      need.push(target);
      if (extOf(target) === 'css' && depth < 6) visit(site.read(target) || '', target, depth + 1);
    }
  };
  visit(src, pagePath, 0);
  const absUrl = (p: string) => LOCAL_BASE + p.split('/').map(encodeURIComponent).join('/');
  const toAbs = (text: string, from: string) => rewriteRefs(text, from, (target) => (seen.has(target) ? absUrl(target) : null));
  const boundary = `----=_NextPart_QuillLoom_${Date.now().toString(36)}`;
  const title = getTitle(src) || baseName(pagePath);
  const enc = new TextEncoder();
  const out: string[] = [
    'From: <Saved by Anne\'s Loom>',
    `Subject: ${title.replace(/[^\x20-\x7e]/g, '?')}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related;\r\n\ttype="text/html";\r\n\tboundary="${boundary}"`,
    `Snapshot-Content-Location: ${absUrl(pagePath)}`,
    '',
    'This is a multi-part message in MIME format.',
    '',
  ];
  const part = (headers: string[], body: string) => { out.push(`--${boundary}`, ...headers, '', body, ''); };
  part(['Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: quoted-printable', `Content-Location: ${absUrl(pagePath)}`], encodeQuotedPrintable(enc.encode(toAbs(src, pagePath))));
  for (const p of need) {
    const f = site.get(p)!;
    const mime = f.mime || mimeOf(p);
    if (extOf(p) === 'css' || (f.text != null && /^text\//.test(mime))) {
      part([`Content-Type: ${mime}; charset="utf-8"`, 'Content-Transfer-Encoding: quoted-printable', `Content-Location: ${absUrl(p)}`], encodeQuotedPrintable(enc.encode(extOf(p) === 'css' ? toAbs(f.text ?? '', p) : f.text ?? '')));
    } else {
      part([`Content-Type: ${mime}`, 'Content-Transfer-Encoding: base64', `Content-Location: ${absUrl(p)}`], wrap76(b64(site.bytes(p)!)));
    }
  }
  out.push(`--${boundary}--`, '');
  return out.join('\r\n');
}
