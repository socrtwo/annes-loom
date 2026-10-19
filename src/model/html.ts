/**
 * Source-level HTML operations. The page source text is the document of record: Code view shows it
 * as written, and commands that change the head (title, meta tags, style sheets, scripts) edit the
 * text directly, so a page's own formatting survives everything except Design view edits of the body.
 */
import { decodeEntities } from './site';

export const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const escAttr = (s: string) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!);

export const DOCTYPES: { id: string; label: string; decl: string }[] = [
  { id: 'html5', label: 'HTML5', decl: '<!DOCTYPE html>' },
  { id: 'xhtml5', label: 'XHTML5 (polyglot)', decl: '<!DOCTYPE html>' },
  { id: 'xhtml1t', label: 'XHTML 1.0 Transitional', decl: '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">' },
  { id: 'xhtml1s', label: 'XHTML 1.0 Strict', decl: '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">' },
  { id: 'xhtml1f', label: 'XHTML 1.0 Frameset', decl: '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Frameset//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-frameset.dtd">' },
  { id: 'xhtml11', label: 'XHTML 1.1', decl: '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">' },
  { id: 'html401t', label: 'HTML 4.01 Transitional', decl: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">' },
  { id: 'html401s', label: 'HTML 4.01 Strict', decl: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">' },
  { id: 'html401f', label: 'HTML 4.01 Frameset', decl: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN" "http://www.w3.org/TR/html4/frameset.dtd">' },
  { id: 'none', label: 'None (quirks mode)', decl: '' },
];

export function blankPage(opts: { title?: string; lang?: string; charset?: string; css?: string[]; body?: string; doctype?: string } = {}): string {
  const dt = DOCTYPES.find((d) => d.id === (opts.doctype || 'html5'))?.decl ?? '<!DOCTYPE html>';
  const css = (opts.css || []).map((h) => `\n  <link rel="stylesheet" href="${escAttr(h)}">`).join('');
  return `${dt ? dt + '\n' : ''}<html lang="${escAttr(opts.lang || 'en')}">
<head>
  <meta charset="${escAttr(opts.charset || 'utf-8')}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title || 'Untitled 1')}</title>${css}
</head>
<body>
${opts.body ?? ''}
</body>
</html>
`;
}

// ------------------------------------------------------------------------------------------
// Regions

/** Character ranges of the head and body. Missing tags yield ranges an insertion can still use. */
export function regions(src: string): { headOpen: [number, number] | null; headClose: number; bodyOpen: [number, number] | null; bodyClose: number } {
  const ho = /<head(\s[^>]*)?>/i.exec(src);
  const hc = src.search(/<\/head\s*>/i);
  const bo = /<body(\s[^>]*)?>/i.exec(src);
  const bcAll = [...src.matchAll(/<\/body\s*>/gi)];
  const bc = bcAll.length ? bcAll[bcAll.length - 1].index! : -1;
  return {
    headOpen: ho ? [ho.index, ho.index + ho[0].length] : null,
    headClose: hc,
    bodyOpen: bo ? [bo.index, bo.index + bo[0].length] : null,
    bodyClose: bc,
  };
}

/** The body's inner HTML as written. Without a <body> tag, everything after the head. */
export function bodyInner(src: string): string {
  const r = regions(src);
  if (r.bodyOpen) return src.slice(r.bodyOpen[1], r.bodyClose >= 0 ? r.bodyClose : undefined);
  if (r.headClose >= 0) return src.slice(src.indexOf('>', r.headClose) + 1).replace(/<\/html\s*>\s*$/i, '');
  return src.replace(/^\s*<!DOCTYPE[^>]*>/i, '').replace(/<\/?html[^>]*>/gi, '');
}

/**
 * Replaces the body. `openTag` replaces the <body …> tag when given. The text before and after
 * the body (doctype, head, comments, server code) is kept exactly.
 */
export function replaceBody(src: string, inner: string, openTag?: string): string {
  const r = regions(src);
  if (r.bodyOpen) {
    const end = r.bodyClose >= 0 ? r.bodyClose : src.length;
    const keepInner = inner;
    return src.slice(0, r.bodyOpen[0]) + (openTag ?? src.slice(r.bodyOpen[0], r.bodyOpen[1])) + keepInner + (r.bodyClose >= 0 ? '' : '</body>') + src.slice(end);
  }
  if (r.headClose >= 0) {
    const at = src.indexOf('>', r.headClose) + 1;
    return src.slice(0, at) + `\n${openTag || '<body>'}${inner}</body>\n</html>\n`;
  }
  return blankPage({ body: inner });
}

export function headInner(src: string): string {
  const r = regions(src);
  if (!r.headOpen || r.headClose < 0) return '';
  return src.slice(r.headOpen[1], r.headClose);
}

/** Inserts markup at the end of the head (creating one if the page has none). */
export function headInsert(src: string, markup: string): string {
  const r = regions(src);
  if (r.headClose >= 0) {
    const before = src.slice(0, r.headClose);
    const indent = /\n([ \t]*)[^\n]*$/.exec(before)?.[1] ?? '  ';
    const lead = before.endsWith('\n') ? '' : '\n';
    return before.replace(/[ \t]*$/, '') + `${lead}${indent || '  '}${markup}\n` + src.slice(r.headClose);
  }
  const html = /<html[^>]*>/i.exec(src);
  if (html) return src.slice(0, html.index + html[0].length) + `\n<head>\n  ${markup}\n</head>` + src.slice(html.index + html[0].length);
  return `<head>\n  ${markup}\n</head>\n` + src;
}

export function getTitle(src: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  return m ? decodeEntities(m[1].trim()) : '';
}

export function setTitle(src: string, title: string): string {
  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(src)) return src.replace(/(<title[^>]*>)[\s\S]*?(<\/title>)/i, (m, a, b) => `${a}${esc(title)}${b}`);
  return headInsert(src, `<title>${esc(title)}</title>`);
}

const metaRe = (attr: string, name: string) => new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');

export function getMeta(src: string, name: string, attr: 'name' | 'property' | 'http-equiv' = 'name'): string | null {
  const m = metaRe(attr, name).exec(headInner(src) || src);
  if (!m) return null;
  const c = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(m[0]);
  return c ? decodeEntities(c[2]) : '';
}

/** Sets, adds or (with a null value) removes a <meta> tag. */
export function setMeta(src: string, name: string, content: string | null, attr: 'name' | 'property' | 'http-equiv' = 'name'): string {
  const re = metaRe(attr, name);
  if (content == null) return src.replace(new RegExp(`[ \\t]*${re.source}[ \\t]*\\r?\\n?`, 'i'), '');
  const tag = `<meta ${attr}="${escAttr(name)}" content="${escAttr(content)}">`;
  if (re.test(src)) return src.replace(re, tag);
  return headInsert(src, tag);
}

export function getLang(src: string): string {
  return /<html\b[^>]*\blang\s*=\s*["']([^"']*)["']/i.exec(src)?.[1] || '';
}

export function setHtmlAttr(src: string, name: string, value: string | null): string {
  const m = /<html\b[^>]*>/i.exec(src);
  if (!m) return src;
  return src.slice(0, m.index) + setTagAttr(m[0], name, value) + src.slice(m.index + m[0].length);
}

/** Sets an attribute on a start tag written as text ("<body class=x>"). */
export function setTagAttr(tag: string, name: string, value: string | null): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]*)`, 'i');
  const reBare = new RegExp(`\\s${name}(?=[\\s/>])`, 'i');
  let t = tag.replace(re, '').replace(reBare, '');
  if (value == null) return t;
  return t.replace(/\s*(\/?)>$/, ` ${name}="${escAttr(value)}"$1>`);
}

export function getDoctype(src: string): string {
  const m = /^\s*(<!DOCTYPE[^>]*>)/i.exec(src);
  if (!m) return 'none';
  const d = m[1].replace(/\s+/g, ' ');
  return DOCTYPES.find((x) => x.decl && x.decl.replace(/\s+/g, ' ').toLowerCase() === d.toLowerCase())?.id || (/^<!DOCTYPE html>$/i.test(d) ? 'html5' : 'custom');
}

export function setDoctype(src: string, id: string): string {
  const decl = DOCTYPES.find((d) => d.id === id)?.decl ?? '';
  const stripped = src.replace(/^\s*<!DOCTYPE[^>]*>\s*/i, '');
  return decl ? `${decl}\n${stripped}` : stripped;
}

export function getCharset(src: string): string {
  return /<meta\s+charset\s*=\s*["']?([\w-]+)/i.exec(src)?.[1] || /charset\s*=\s*([\w-]+)/i.exec(headInner(src))?.[1] || '';
}

export function setCharset(src: string, cs: string): string {
  if (/<meta\s+charset\s*=/i.test(src)) return src.replace(/(<meta\s+charset\s*=\s*["']?)[\w-]+/i, `$1${cs}`);
  if (/<meta[^>]+http-equiv\s*=\s*["']content-type["'][^>]*>/i.test(src)) return src.replace(/(<meta[^>]+http-equiv\s*=\s*["']content-type["'][^>]*charset\s*=\s*)[\w-]+/i, `$1${cs}`);
  return headInsert(src, `<meta charset="${escAttr(cs)}">`);
}

/** Linked style sheets and scripts as written in the page. */
export function linkedStyles(src: string): string[] {
  return [...src.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /rel\s*=\s*["']?[^"'>]*stylesheet/i.test(t)).map((t) => /href\s*=\s*["']([^"']+)["']/i.exec(t)?.[1] || '').filter(Boolean);
}
export function linkedScripts(src: string): string[] {
  return [...src.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
}

export function addStylesheet(src: string, href: string, media?: string): string {
  if (linkedStyles(src).includes(href)) return src;
  return headInsert(src, `<link rel="stylesheet" href="${escAttr(href)}"${media ? ` media="${escAttr(media)}"` : ''}>`);
}
export function removeStylesheet(src: string, href: string): string {
  return src.replace(new RegExp(`[ \\t]*<link\\b[^>]*href\\s*=\\s*["']${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>[ \\t]*\\r?\\n?`, 'gi'), (m) => (/stylesheet/i.test(m) ? '' : m));
}
export function addScript(src: string, href: string, opts: { defer?: boolean; module?: boolean; inBody?: boolean } = {}): string {
  const tag = `<script${opts.module ? ' type="module"' : ''} src="${escAttr(href)}"${opts.defer ? ' defer' : ''}></script>`;
  if (linkedScripts(src).includes(href)) return src;
  if (opts.inBody) { const r = regions(src); if (r.bodyClose >= 0) return src.slice(0, r.bodyClose) + tag + '\n' + src.slice(r.bodyClose); }
  return headInsert(src, tag);
}

/** The first <style> block in the head, created when missing; `fn` edits its CSS. */
export function editHeadStyle(src: string, fn: (css: string) => string): string {
  const m = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/i.exec(headInner(src) ? src : '');
  if (m) return src.slice(0, m.index) + m[1] + fn(m[2]) + m[3] + src.slice(m.index + m[0].length);
  const css = fn('\n');
  return headInsert(src, `<style>${css.startsWith('\n') ? '' : '\n'}${css}${css.endsWith('\n') ? '' : '\n'}  </style>`);
}

/** Every inline <style> block's CSS, in order. */
export function inlineStyles(src: string): string[] {
  return [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}

// ------------------------------------------------------------------------------------------
// Source formatting

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'frame', 'isindex', 'keygen']);
const RAW = new Set(['script', 'style', 'pre', 'textarea', 'code', 'xmp', 'plaintext']);
export const BLOCK = new Set(['html', 'head', 'body', 'title', 'meta', 'link', 'script', 'style', 'noscript', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'form', 'fieldset', 'legend', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'blockquote', 'pre', 'hr', 'br', 'address', 'details', 'summary', 'dialog', 'template', 'select', 'option', 'optgroup', 'iframe', 'video', 'audio', 'source', 'picture', 'canvas', 'map', 'area', 'object', 'embed', 'frameset', 'frame', 'noframes', 'center', 'menu', 'hgroup', 'search', 'base', 'svg']);

/**
 * Re-indents markup: one block element per line, children indented. Inline runs stay on one line,
 * and the contents of <pre>, <script>, <style> and <textarea> are left exactly as written.
 */
export function formatHtml(src: string, opts: { indent?: string; uppercase?: boolean } = {}): string {
  const ind = opts.indent ?? '  ';
  const out: string[] = [];
  let depth = 0;
  let line = '';
  const flush = () => { const t = line.trim(); if (t) out.push(ind.repeat(Math.max(0, depth)) + t); line = ''; };
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<%[\s\S]*?%>|<\/?([a-zA-Z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tok = m[0];
    const name = m[1]?.toLowerCase();
    if (!name) {
      if (tok.startsWith('<!--') || tok.startsWith('<!') || tok.startsWith('<?') || tok.startsWith('<%')) {
        if (/^<!--\s*(#?(Begin|End)|Instance|Template|webbot)/i.test(tok) || tok.startsWith('<!DOCTYPE') || tok.startsWith('<!doctype')) { flush(); out.push(ind.repeat(depth) + tok.trim()); }
        else line += tok;
      } else line += tok.replace(/\s+/g, ' ');
      continue;
    }
    const closing = tok[1] === '/';
    const t = opts.uppercase ? caseTag(tok, true) : tok;
    if (RAW.has(name) && !closing) {
      const endRe = new RegExp(`</${name}\\s*>`, 'ig');
      endRe.lastIndex = re.lastIndex;
      const em = endRe.exec(src);
      const end = em ? em.index + em[0].length : src.length;
      const whole = t + src.slice(re.lastIndex, end);
      re.lastIndex = end;
      if (name === 'code') { line += whole; continue; }
      flush();
      out.push(ind.repeat(depth) + whole.replace(/^\s+/, ''));
      continue;
    }
    if (!BLOCK.has(name)) { line += t; continue; }
    if (closing) { flush(); depth = Math.max(0, depth - 1); out.push(ind.repeat(depth) + t); continue; }
    flush();
    const selfClose = VOID.has(name) || /\/>$/.test(tok);
    // Short block elements with only inline content stay on one line: <p>text <b>x</b></p>
    if (!selfClose) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'i');
      const rest = src.slice(re.lastIndex, re.lastIndex + 400);
      const cm = closeRe.exec(rest);
      if (cm && !/<\/?(?:div|p|ul|ol|li|table|tr|td|th|section|article|header|footer|nav|main|aside|form|h[1-6]|blockquote|pre|script|style|dl|figure|select|option|br|hr|head|body|html|meta|link|title)\b/i.test(rest.slice(0, cm.index)) && (rest.slice(0, cm.index).length < 160)) {
        out.push(ind.repeat(depth) + t + rest.slice(0, cm.index).replace(/\s+/g, ' ').trim() + (opts.uppercase ? cm[0].toUpperCase() : cm[0]));
        re.lastIndex += cm.index + cm[0].length;
        continue;
      }
    }
    out.push(ind.repeat(depth) + t);
    if (!selfClose && name !== 'html') depth++;
    if (name === 'html') depth = 0;
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** Upper- or lower-cases a tag's name and attribute names, leaving values alone. */
export function caseTag(tag: string, upper: boolean): string {
  const f = (s: string) => (upper ? s.toUpperCase() : s.toLowerCase());
  return tag.replace(/^<(\/?)([\w:-]+)/, (m, s, n) => `<${s}${f(n)}`).replace(/(\s)([\w:-]+)(?=\s*=|\s|\/?>)/g, (m, sp, n) => sp + f(n));
}

export function changeTagCase(src: string, upper: boolean): string {
  return src.replace(/<\/?[a-zA-Z][\w:-]*(?:"[^"]*"|'[^']*'|[^'">])*>/g, (t) => caseTag(t, upper));
}

/** Removes comments (not server-side includes or template markers), indentation and blank lines. */
export function minifyHtml(src: string): string {
  const keep: string[] = [];
  let s = src.replace(/<(pre|script|style|textarea)\b[\s\S]*?<\/\1>/gi, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
  s = s.replace(/<!--(?!\s*(?:#|\[if|<!|Instance|Template|webbot))[\s\S]*?-->/g, '').replace(/>\s+</g, '> <').replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/gm, '');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[+i]).trim() + '\n';
}

/** Converts HTML-era markup to XHTML style: lower-case tags, quoted attributes, closed void tags. */
export function toXhtml(src: string): string {
  return src.replace(/<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g, (m, n, attrs: string) => {
    const name = n.toLowerCase();
    let a = attrs.replace(/(\s)([\w:-]+)(\s*=\s*)([^\s"'>]+)/g, (mm, sp, an, eq, v) => `${sp}${an.toLowerCase()}="${v}"`)
      .replace(/(\s)([\w:-]+)(?=\s|\/?$)(?!\s*=)/g, (mm, sp, an) => `${sp}${an.toLowerCase()}="${an.toLowerCase()}"`)
      .replace(/(\s)([\w:-]+)(?=\s*=)/g, (mm, sp, an) => sp + an.toLowerCase());
    if (VOID.has(name) && !/\/\s*$/.test(a)) a = a.replace(/\s*$/, ' /');
    return `<${name}${a}>`;
  }).replace(/<\/([a-zA-Z][\w:-]*)>/g, (m, n) => `</${n.toLowerCase()}>`);
}

/** Text only: drops tags, scripts and styles. */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Word count of visible text. */
export function wordCount(html: string): number {
  return (htmlToText(html).match(/\S+/g) || []).length;
}
