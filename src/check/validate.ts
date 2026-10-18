/**
 * HTML conformance checking over the source text.
 *
 * The page text is tokenized as written (line and column of every tag and attribute are kept), then a
 * small tree builder follows the HTML parsing rules that matter for authors: optional end tags (p, li,
 * td…), implied closing of paragraphs by block elements, void elements, raw text (script, style) and
 * foreign content (svg, math). Problems found on the way and in the finished tree are reported as
 * {line, col, severity, message}. The same tree (parseHtml) is used by the accessibility, compatibility,
 * SEO and spelling checks, so every report can point at a line.
 *
 * validateXml() checks XML well-formedness (feeds, sitemaps, SVG, XHTML served as XML).
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  line: number;
  col: number;
  severity: Severity;
  message: string;
  /** Short rule id, e.g. "unclosed", "img-alt". */
  rule?: string;
  /** Guideline reference (WCAG success criterion, etc.). */
  ref?: string;
  /** Site path of the file, set by site-wide runs. */
  path?: string;
  /** Character offset in the source. */
  offset?: number;
}

export interface Attr { name: string; value: string | null; quote: '"' | "'" | ''; start: number; end: number; line: number; col: number }

export interface Token {
  type: 'start' | 'end' | 'text' | 'comment' | 'doctype' | 'pi' | 'cdata' | 'server' | 'bogus';
  /** Tag name as written (case kept). */
  raw: string;
  name: string;
  attrs: Attr[];
  selfClose: boolean;
  start: number;
  end: number;
  line: number;
  col: number;
  /** Comment or text content. */
  text: string;
  /** Unterminated construct (comment, tag or raw text reaching the end of the file). */
  open?: boolean;
}

export interface HNode {
  type: 'el' | 'text' | 'comment' | 'root';
  name: string;
  attrs: Attr[];
  children: HNode[];
  parent: HNode | null;
  /** Offset of the start tag (or text). */
  start: number;
  /** End of the start tag (or text). */
  end: number;
  line: number;
  col: number;
  /** Offset where the element was closed (start of its end tag, or where it was closed implicitly). */
  close: number;
  /** End of the end tag (equal to close when it was implied). */
  closeEnd: number;
  /** True when no end tag was written. */
  implied: boolean;
  /** Text content of text and comment nodes (raw, entities not decoded). */
  text: string;
  selfClose?: boolean;
  /** Inside svg or math. */
  foreign?: boolean;
}

// --------------------------------------------------------------------------------------------
// Element knowledge

export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param', 'keygen', 'basefont', 'bgsound', 'frame', 'isindex', 'spacer']);
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);
const RCDATA = new Set(['textarea', 'title']);

export const HTML_ELEMENTS = new Set(('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr svg math selectedcontent').split(' '));

/** Obsolete (non-conforming) elements and what to use instead. */
export const OBSOLETE_ELEMENTS: Record<string, string> = {
  acronym: 'Use abbr.', applet: 'Use object, or a script-based player.', basefont: 'Use CSS font properties.', bgsound: 'Use audio.', big: 'Use CSS (font-size).', blink: 'Remove it; blinking text is an accessibility problem.',
  center: 'Use CSS (text-align: center or margin: auto).', dir: 'Use ul.', font: 'Use CSS (font-family, font-size, color).', frame: 'Use iframe or a single-page layout.', frameset: 'Use iframe or CSS layout.', noframes: 'Remove it along with the frameset.',
  isindex: 'Use a form with a text field.', keygen: 'Removed from browsers; use the Web Cryptography API.', listing: 'Use pre and code.', marquee: 'Use CSS animation, or no motion at all.', menuitem: 'Removed; use button elements.', multicol: 'Use CSS columns.',
  nextid: 'Remove it.', nobr: 'Use CSS (white-space: nowrap).', noembed: 'Use object fallback content.', plaintext: 'Use pre or the text/plain type.', rb: 'Use ruby with rt.', rtc: 'Use ruby with rt.', spacer: 'Use CSS margins or padding.', strike: 'Use del or s.', tt: 'Use code, kbd, samp or CSS.', xmp: 'Use pre and code.', image: 'Use img.',
};

/** Obsolete attributes: attribute -> elements ('*' = any) and the CSS or markup to use instead. */
const OBSOLETE_ATTRS: [string, string, string][] = [
  ['align', 'caption col colgroup div h1 h2 h3 h4 h5 h6 hr iframe img input legend object p table tbody td tfoot th thead tr embed', 'Use CSS (text-align, float or margin).'],
  ['bgcolor', 'body table td th tr', 'Use CSS (background-color).'],
  ['background', 'body table td th', 'Use CSS (background-image).'],
  ['text', 'body', 'Use CSS (color).'], ['link', 'body', 'Use CSS (a:link).'], ['vlink', 'body', 'Use CSS (a:visited).'], ['alink', 'body', 'Use CSS (a:active).'],
  ['marginwidth', 'body iframe', 'Use CSS (margin).'], ['marginheight', 'body iframe', 'Use CSS (margin).'], ['leftmargin', 'body', 'Use CSS (margin).'], ['topmargin', 'body', 'Use CSS (margin).'],
  ['cellpadding', 'table', 'Use CSS (padding on td and th).'], ['cellspacing', 'table', 'Use CSS (border-spacing).'], ['frame', 'table', 'Use CSS borders.'], ['rules', 'table', 'Use CSS borders.'], ['summary', 'table', 'Use a caption or a paragraph describing the table.'],
  ['valign', 'col colgroup tbody td tfoot th thead tr', 'Use CSS (vertical-align).'], ['char', 'col colgroup tbody td tfoot th thead tr', 'Remove it.'], ['charoff', 'col colgroup tbody td tfoot th thead tr', 'Remove it.'],
  ['width', 'col colgroup hr pre table td th', 'Use CSS (width).'], ['height', 'table td th tr', 'Use CSS (height).'], ['nowrap', 'td th', 'Use CSS (white-space: nowrap).'], ['abbr', 'td', 'Use text in the cell, or a th with abbr.'], ['axis', 'td th', 'Use scope on th.'], ['scope', 'td', 'Use th for header cells.'],
  ['hspace', 'img object embed iframe', 'Use CSS (margin).'], ['vspace', 'img object embed iframe', 'Use CSS (margin).'], ['border', 'img object', 'Use CSS (border).'], ['longdesc', 'img iframe', 'Link to the description, or use aria-describedby.'], ['lowsrc', 'img', 'Use srcset.'],
  ['name', 'img form embed', 'Use id.'], ['name', 'a', 'Use id on the target element.'], ['charset', 'a link script', 'Remove it; serve the file as UTF-8.'], ['rev', 'a link', 'Use rel with the opposite value.'], ['shape', 'a', 'Use area.'], ['coords', 'a', 'Use area.'], ['methods', 'a link', 'Remove it.'], ['urn', 'a link', 'Remove it.'],
  ['language', 'script', 'Omit it (JavaScript is the default) or use type.'], ['event', 'script', 'Remove it.'], ['for', 'script', 'Remove it.'],
  ['clear', 'br', 'Use CSS (clear).'], ['noshade', 'hr', 'Use CSS (border, background).'], ['size', 'hr', 'Use CSS (height).'], ['color', 'hr', 'Use CSS (border-color, background-color).'], ['compact', 'dl menu ol ul', 'Use CSS.'], ['type', 'li ul', 'Use CSS (list-style-type).'],
  ['frameborder', 'iframe', 'Use CSS (border).'], ['scrolling', 'iframe', 'Use CSS (overflow).'], ['allowtransparency', 'iframe', 'Use CSS.'], ['datapagesize', 'table', 'Remove it.'], ['datasrc', '*', 'Remove it.'], ['datafld', '*', 'Remove it.'], ['dataformatas', '*', 'Remove it.'],
  ['archive', 'object', 'Remove it.'], ['classid', 'object', 'Use data and type.'], ['code', 'object', 'Remove it.'], ['codebase', 'object', 'Remove it.'], ['codetype', 'object', 'Remove it.'], ['declare', 'object', 'Remove it.'], ['standby', 'object', 'Remove it.'],
  ['profile', 'head', 'Remove it.'], ['version', 'html', 'Remove it.'], ['manifest', 'html', 'Use a service worker.'], ['scheme', 'meta', 'Remove it.'], ['target', 'link', 'Remove it.'], ['nohref', 'area', 'Omit href instead.'], ['accept', 'form', 'Use accept on input type=file.'],
];
const OBSOLETE_ATTR_MAP = new Map<string, { els: Set<string> | null; advice: string }[]>();
for (const [a, els, advice] of OBSOLETE_ATTRS) {
  const l = OBSOLETE_ATTR_MAP.get(a) || [];
  l.push({ els: els === '*' ? null : new Set(els.split(' ')), advice });
  OBSOLETE_ATTR_MAP.set(a, l);
}

export function obsoleteAttrAdvice(el: string, attr: string): string | null {
  for (const r of OBSOLETE_ATTR_MAP.get(attr) || []) if (!r.els || r.els.has(el)) return r.advice;
  return null;
}

const INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'hidden', 'image', 'month', 'number', 'password', 'radio', 'range', 'reset', 'search', 'submit', 'tel', 'text', 'time', 'url', 'week']);
const BOOLEAN_ATTRS = new Set(['allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected', 'shadowrootclonable', 'shadowrootdelegatesfocus']);

/** Elements whose start closes an open p (HTML parsing rules). */
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul', 'center', 'dir', 'listing', 'xmp', 'plaintext', 'frameset']);
/** Elements whose end tag may be omitted. */
const OPTIONAL_END = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp']);
/** Flow (block) content that phrasing-only parents cannot hold. */
const FLOW_ONLY = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul', 'center']);
const PHRASING_PARENTS = new Set(['abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'kbd', 'label', 'mark', 'output', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'button', 'legend', 'summary', 'font', 'big', 'tt', 'strike', 'nobr']);
const FORMATTING = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);

export function isInteractive(n: HNode): boolean {
  switch (n.name) {
    case 'a': return hasAttr(n, 'href');
    case 'button': case 'select': case 'textarea': case 'iframe': case 'embed': case 'label': case 'details': return true;
    case 'input': return (attr(n, 'type') || '').toLowerCase() !== 'hidden';
    case 'audio': case 'video': return hasAttr(n, 'controls');
    case 'img': return hasAttr(n, 'usemap');
    default: return hasAttr(n, 'tabindex') && n.name !== 'body';
  }
}

// --------------------------------------------------------------------------------------------
// Positions

export class LineIndex {
  private starts: number[] = [0];
  constructor(src: string) { for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) this.starts.push(i + 1); }
  at(offset: number): { line: number; col: number } {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: offset - this.starts[lo] + 1 };
  }
  /** Offset of a 1-based line and column. */
  offset(line: number, col = 1): number { return (this.starts[Math.max(0, Math.min(this.starts.length - 1, line - 1))] ?? 0) + Math.max(0, col - 1); }
}

// --------------------------------------------------------------------------------------------
// Tokenizer

const isNameStart = (c: string) => /[A-Za-z]/.test(c);

/**
 * Splits markup into tokens. With `xml`, no element has raw text content and names keep their case.
 * Problems in the lexical layer (unterminated comments, bad attribute syntax, stray "<") go to `issues`.
 */
export function tokenize(src: string, opts: { xml?: boolean; issues?: Issue[]; lines?: LineIndex } = {}): Token[] {
  const lines = opts.lines || new LineIndex(src);
  const issues = opts.issues;
  const out: Token[] = [];
  const report = (offset: number, severity: Severity, message: string, rule: string) => { if (issues) { const p = lines.at(offset); issues.push({ ...p, severity, message, rule, offset }); } };
  const mk = (type: Token['type'], start: number, end: number, extra: Partial<Token> = {}): Token => {
    const p = lines.at(start);
    return { type, raw: '', name: '', attrs: [], selfClose: false, start, end, line: p.line, col: p.col, text: '', ...extra };
  };
  const n = src.length;
  let i = 0;
  let textStart = 0;
  const flushText = (to: number) => { if (to > textStart) out.push(mk('text', textStart, to, { text: src.slice(textStart, to) })); };
  while (i < n) {
    if (src[i] !== '<') { i++; continue; }
    const c1 = src[i + 1] || '';
    if (src.startsWith('<!--', i)) {
      flushText(i);
      let e = src.indexOf('-->', i + 4);
      let open = false;
      if (e < 0) { e = n; open = true; report(i, 'error', 'Comment is not closed ("-->" missing).', 'comment'); } else e += 3;
      out.push(mk('comment', i, e, { text: src.slice(i + 4, open ? n : e - 3), open }));
      i = textStart = e;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      flushText(i);
      let e = src.indexOf(']]>', i);
      e = e < 0 ? n : e + 3;
      out.push(mk('cdata', i, e, { text: src.slice(i + 9, Math.max(i + 9, e - 3)) }));
      i = textStart = e;
      continue;
    }
    if (c1 === '!') {
      flushText(i);
      let e = src.indexOf('>', i);
      e = e < 0 ? n : e + 1;
      const body = src.slice(i + 2, e - 1);
      out.push(mk(/^doctype\b/i.test(body) ? 'doctype' : 'bogus', i, e, { text: body }));
      i = textStart = e;
      continue;
    }
    if (c1 === '?') {
      flushText(i);
      let e = src.indexOf('?>', i);
      e = e < 0 ? n : e + 2;
      out.push(mk('pi', i, e, { text: src.slice(i + 2, e - 2) }));
      i = textStart = e;
      continue;
    }
    if (c1 === '%') {
      flushText(i);
      let e = src.indexOf('%>', i);
      e = e < 0 ? n : e + 2;
      out.push(mk('server', i, e, { text: src.slice(i, e) }));
      i = textStart = e;
      continue;
    }
    const closing = c1 === '/';
    const ns = closing ? i + 2 : i + 1;
    if (!isNameStart(src[ns] || '')) {
      if (closing && src[ns] === '>') { flushText(i); report(i, 'error', 'Empty end tag "</>".', 'syntax'); i = textStart = ns + 1; continue; }
      if (!opts.xml) report(i, 'warning', 'A "<" in text should be written as "&lt;".', 'escape');
      else report(i, 'error', '"<" in text must be written as "&lt;".', 'escape');
      i++;
      continue;
    }
    flushText(i);
    let j = ns;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const raw = src.slice(ns, j);
    const tok = mk(closing ? 'end' : 'start', i, j, { raw, name: opts.xml ? raw : raw.toLowerCase() });
    // Attributes
    let selfClose = false;
    let ended = false;
    while (j < n) {
      const ch = src[j];
      if (/\s/.test(ch)) { j++; continue; }
      if (ch === '>') { j++; ended = true; break; }
      if (ch === '/' ) {
        if (src[j + 1] === '>') { selfClose = true; j += 2; ended = true; break; }
        j++;
        continue;
      }
      if (ch === '<') { report(j, 'error', `Tag <${raw}> is not closed with ">".`, 'syntax'); break; }
      const as = j;
      while (j < n && !/[\s/>=]/.test(src[j]) && !(src[j] === '<' && j > as)) j++;
      if (j === as) j++;
      const an = src.slice(as, j);
      let k = j;
      while (k < n && /\s/.test(src[k])) k++;
      let value: string | null = null;
      let quote: Attr['quote'] = '';
      if (src[k] === '=') {
        k++;
        while (k < n && /\s/.test(src[k])) k++;
        const q = src[k];
        if (q === '"' || q === "'") {
          const e = src.indexOf(q, k + 1);
          if (e < 0) { report(as, 'error', `Attribute ${an} has an unclosed quote.`, 'syntax'); value = src.slice(k + 1); k = n; }
          else { value = src.slice(k + 1, e); k = e + 1; }
          quote = q;
          if (k < n && !/[\s/>]/.test(src[k])) report(k, 'error', `No space between attributes after ${an}.`, 'syntax');
        } else {
          const vs = k;
          while (k < n && !/[\s>]/.test(src[k])) k++;
          value = src.slice(vs, k);
          if (value.endsWith('/') && src[k] === '>') { value = value.slice(0, -1); k--; }
          if (/["'=<`]/.test(value)) report(vs, 'error', `Unquoted value of ${an} contains a quote, "=", "<" or "\`"; put the value in quotes.`, 'attr-value');
          if (value === '') report(vs, 'error', `Attribute ${an} has "=" but no value.`, 'attr-value');
        }
        j = k;
      }
      const p = lines.at(as);
      if (closing) report(as, 'error', `End tag </${raw}> has attributes.`, 'syntax');
      else tok.attrs.push({ name: opts.xml ? an : an.toLowerCase(), value, quote, start: as, end: j, line: p.line, col: p.col });
      void an;
    }
    if (!ended) { tok.open = true; if (j >= n) report(i, 'error', `Tag <${closing ? '/' : ''}${raw}> is not closed with ">".`, 'syntax'); }
    tok.end = j;
    tok.selfClose = selfClose;
    tok.text = src.slice(i, j);
    out.push(tok);
    i = textStart = j;
    // Raw text and RCDATA elements: everything up to the matching end tag is text.
    if (!opts.xml && !closing && (RAW_TEXT.has(tok.name) || RCDATA.has(tok.name)) && !selfClose) {
      const re = new RegExp(`</${tok.name}[\\s/>]`, 'ig');
      re.lastIndex = i;
      const m = re.exec(src);
      const e = m ? m.index : n;
      if (!m) report(tok.start, 'error', `<${tok.name}> is never closed; everything after it is treated as its text.`, 'unclosed');
      if (e > i) out.push(mk('text', i, e, { text: src.slice(i, e), name: '#raw' }));
      i = textStart = e;
    }
  }
  flushText(n);
  return out;
}

// --------------------------------------------------------------------------------------------
// Tree

export function attr(n: HNode, name: string): string | null {
  const a = n.attrs.find((x) => x.name === name);
  return a ? (a.value ?? '') : null;
}
export function hasAttr(n: HNode, name: string): boolean { return n.attrs.some((x) => x.name === name); }
export function attrNode(n: HNode, name: string): Attr | undefined { return n.attrs.find((x) => x.name === name); }

/** Every element (depth first) matching a predicate. */
export function findAll(root: HNode, pred: (n: HNode) => boolean): HNode[] {
  const out: HNode[] = [];
  const walk = (n: HNode) => { for (const c of n.children) { if (c.type === 'el' && pred(c)) out.push(c); walk(c); } };
  walk(root);
  return out;
}
export const byName = (root: HNode, ...names: string[]) => findAll(root, (n) => names.includes(n.name));

export function ancestor(n: HNode, pred: (a: HNode) => boolean): HNode | null {
  for (let p = n.parent; p; p = p.parent) if (p.type === 'el' && pred(p)) return p;
  return null;
}

/** Visible text of a node (entities decoded, scripts and styles skipped). */
export function textOf(n: HNode): string {
  if (n.type === 'text') return decodeHtml(n.text);
  if (n.type === 'comment') return '';
  if (n.name === 'script' || n.name === 'style' || n.name === 'template') return '';
  return n.children.map(textOf).join('');
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', atilde: 'ã', aring: 'å', aelig: 'æ', ccedil: 'ç', iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', ntilde: 'ñ', oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ', oslash: 'ø', uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß', Eacute: 'É', Agrave: 'À', Ccedil: 'Ç', Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä', Ntilde: 'Ñ', shy: '­', zwj: '‍', zwnj: '‌', ensp: ' ', emsp: ' ', thinsp: ' ', larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥', check: '✓', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', micro: 'µ', sup2: '²', sup3: '³' };

/** Decodes character references; returns the text and, per output character, its source range. */
export function decodeWithMap(s: string, base = 0): { text: string; from: number[]; to: number[] } {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  const re = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (str: string, a: number, b: number) => { for (const ch of str) { text += ch; from.push(base + a); to.push(base + b); } };
  while ((m = re.exec(s))) {
    for (let k = last; k < m.index; k++) { text += s[k]; from.push(base + k); to.push(base + k + 1); }
    const body = m[1];
    let ch: string | undefined;
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      ch = cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '�';
    } else ch = NAMED[body] ?? (m[0].endsWith(';') ? ' ' : undefined);
    if (ch === undefined) { text += '&'; from.push(base + m.index); to.push(base + m.index + 1); last = m.index + 1; re.lastIndex = last; continue; }
    push(ch, m.index, m.index + m[0].length);
    last = m.index + m[0].length;
  }
  for (let k = last; k < s.length; k++) { text += s[k]; from.push(base + k); to.push(base + k + 1); }
  return { text, from, to };
}
export const decodeHtml = (s: string) => decodeWithMap(s).text;

export interface ParseResult { root: HNode; tokens: Token[]; issues: Issue[]; lines: LineIndex; doctype: Token | null }

const TABLE_SECTIONS = new Set(['thead', 'tbody', 'tfoot']);

/**
 * Builds the element tree, reporting structural problems (unclosed, stray and misnested tags, content
 * that HTML does not allow where it is) into `issues`.
 */
export function parseHtml(src: string): ParseResult {
  const lines = new LineIndex(src);
  const issues: Issue[] = [];
  const tokens = tokenize(src, { issues, lines });
  const root: HNode = { type: 'root', name: '#root', attrs: [], children: [], parent: null, start: 0, end: 0, line: 1, col: 1, close: src.length, closeEnd: src.length, implied: false, text: '' };
  const stack: HNode[] = [root];
  const cur = () => stack[stack.length - 1];
  const report = (at: { line: number; col: number; start?: number }, severity: Severity, message: string, rule: string) => issues.push({ line: at.line, col: at.col, severity, message, rule, offset: at.start });
  const inStack = (name: string) => stack.some((s) => s.name === name);
  const closeTop = (at: number, implied = true) => { const n = stack.pop()!; n.close = at; n.closeEnd = at; n.implied = implied; return n; };
  /** Pops elements up to and including the nearest `name` (whose end tag may be omitted). */
  const closeImplied = (names: Set<string>, at: number, stopAt: Set<string>) => {
    for (let k = stack.length - 1; k > 0; k--) {
      const s = stack[k];
      if (stopAt.has(s.name)) return;
      if (names.has(s.name)) {
        while (stack.length > k) {
          const top = stack[stack.length - 1];
          if (top !== s && !OPTIONAL_END.has(top.name)) report(top, 'error', `<${top.name}> is not closed before </${s.name}> is implied.`, 'unclosed');
          closeTop(at);
        }
        return;
      }
    }
  };
  let doctype: Token | null = null;
  let sawContent = false;
  for (const t of tokens) {
    if (t.type === 'doctype') {
      if (sawContent || doctype) report(t, 'error', 'The doctype must come first in the document.', 'doctype');
      doctype = doctype || t;
      continue;
    }
    if (t.type === 'text') {
      if (/\S/.test(t.text)) sawContent = true;
      const n: HNode = { type: 'text', name: '#text', attrs: [], children: [], parent: cur(), start: t.start, end: t.end, line: t.line, col: t.col, close: t.end, closeEnd: t.end, implied: false, text: t.text };
      cur().children.push(n);
      continue;
    }
    if (t.type === 'comment' || t.type === 'server' || t.type === 'pi' || t.type === 'cdata' || t.type === 'bogus') {
      if (t.type === 'cdata' && !cur().foreign) report(t, 'warning', 'CDATA sections only have meaning inside svg or math.', 'cdata');
      const n: HNode = { type: 'comment', name: '#' + t.type, attrs: [], children: [], parent: cur(), start: t.start, end: t.end, line: t.line, col: t.col, close: t.end, closeEnd: t.end, implied: false, text: t.text };
      cur().children.push(n);
      continue;
    }
    sawContent = true;
    const name = t.name;
    const foreign = !!cur().foreign || name === 'svg' || name === 'math';
    if (t.type === 'start') {
      if (!cur().foreign) {
        // Implied end tags (HTML parsing rules).
        if (CLOSES_P.has(name) && inStack('p')) {
          const p = [...stack].reverse().find((s) => s.name === 'p')!;
          const blocked = stack.slice(stack.indexOf(p) + 1).some((s) => !OPTIONAL_END.has(s.name) && !FORMATTING.has(s.name));
          if (!blocked) {
            if (name !== 'p') report(t, 'warning', `<${name}> closes the open paragraph (line ${p.line}); a paragraph cannot contain a <${name}>. End the paragraph first, or make it a <div>.`, 'p-block');
            closeImplied(new Set(['p']), t.start, new Set(['button', 'table', 'td', 'th', 'caption', 'html', 'template', 'object', 'marquee']));
          }
        }
        if (name === 'li') closeImplied(new Set(['li']), t.start, new Set(['ul', 'ol', 'menu', 'dir', 'td', 'th', 'div', 'section', 'article', 'nav', 'aside', 'table', 'body']));
        if (name === 'dt' || name === 'dd') closeImplied(new Set(['dt', 'dd']), t.start, new Set(['dl', 'td', 'th', 'table', 'body']));
        if (name === 'option') closeImplied(new Set(['option']), t.start, new Set(['select', 'datalist', 'optgroup', 'body']));
        if (name === 'optgroup') closeImplied(new Set(['optgroup', 'option']), t.start, new Set(['select', 'body']));
        if (name === 'tr') closeImplied(new Set(['tr']), t.start, new Set(['table', 'thead', 'tbody', 'tfoot']));
        if (name === 'td' || name === 'th') closeImplied(new Set(['td', 'th']), t.start, new Set(['tr', 'table']));
        if (TABLE_SECTIONS.has(name)) closeImplied(new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup']), t.start, new Set(['table']));
        if (name === 'body' || /^(div|p|h[1-6]|table|ul|ol|section|article|header|footer|nav|main|form|img|a|span)$/.test(name)) {
          const head = stack.find((s) => s.name === 'head');
          if (head && name !== 'body') { report(t, 'error', `<${name}> cannot appear in the head; it belongs in the body.`, 'head-content'); }
          if (head) closeImplied(new Set(['head']), t.start, new Set());
        }
        if (/^h[1-6]$/.test(name)) {
          const open = stack.find((s) => /^h[1-6]$/.test(s.name));
          if (open) report(t, 'error', `Heading <${name}> inside heading <${open.name}> (line ${open.line}).`, 'nesting');
        }
      }
      const parent = cur();
      const el: HNode = { type: 'el', name, attrs: t.attrs, children: [], parent, start: t.start, end: t.end, line: t.line, col: t.col, close: -1, closeEnd: -1, implied: false, text: '', selfClose: t.selfClose, foreign };
      parent.children.push(el);
      if (!foreign) checkPlacement(el, stack, report);
      if (foreign) {
        if (!t.selfClose) stack.push(el); else { el.close = el.closeEnd = t.end; }
      } else if (VOID_ELEMENTS.has(name)) {
        el.close = el.closeEnd = t.end;
      } else {
        if (t.selfClose) report(t, 'error', `Self-closing syntax "<${t.raw}/>" on a non-void element; HTML ignores the "/", so the element stays open. Write <${t.raw}></${t.raw}>.`, 'self-close');
        stack.push(el);
      }
      continue;
    }
    // End tag
    if (VOID_ELEMENTS.has(name) && !cur().foreign) {
      report(t, name === 'br' ? 'error' : 'error', `End tag </${t.raw}> for a void element; <${name}> has no end tag.`, 'stray');
      continue;
    }
    let k = stack.length - 1;
    while (k > 0 && stack[k].name !== name) k--;
    if (k <= 0) {
      report(t, 'error', `Stray end tag </${t.raw}>: no <${name}> is open here.`, 'stray');
      continue;
    }
    while (stack.length - 1 > k) {
      const top = stack[stack.length - 1];
      if (!OPTIONAL_END.has(top.name) && !top.foreign) {
        if (FORMATTING.has(top.name) && FORMATTING.has(name)) report(top, 'error', `Misnested tags: </${name}> closes <${name}> while <${top.name}> (line ${top.line}) is still open inside it.`, 'misnested');
        else report(top, 'error', `Unclosed element <${top.name}>: it is still open at </${name}> (line ${t.line}).`, 'unclosed');
      }
      closeTop(t.start);
    }
    const el = stack.pop()!;
    el.close = t.start;
    el.closeEnd = t.end;
  }
  while (stack.length > 1) {
    const top = stack[stack.length - 1];
    if (!OPTIONAL_END.has(top.name)) report(top, 'error', `Unclosed element <${top.name}>: the file ends while it is open.`, 'unclosed');
    closeTop(src.length);
  }
  return { root, tokens, issues, lines, doctype };
}

type Reporter = (at: { line: number; col: number; start?: number }, severity: Severity, message: string, rule: string) => void;

/** Content-model checks for a new element at its place in the open-element stack. */
function checkPlacement(el: HNode, stack: HNode[], report: Reporter): void {
  const parent = stack[stack.length - 1];
  const name = el.name;
  const has = (n: string) => stack.some((s) => s.name === n);
  const nearest = (names: string[]) => { for (let k = stack.length - 1; k >= 0; k--) if (names.includes(stack[k].name)) return stack[k]; return null; };
  if (name === 'li' && !nearest(['ul', 'ol', 'menu', 'dir'])) report(el, 'error', '<li> must be inside <ul>, <ol> or <menu>.', 'nesting');
  if ((name === 'dt' || name === 'dd') && !nearest(['dl'])) report(el, 'error', `<${name}> must be inside <dl>.`, 'nesting');
  if ((name === 'td' || name === 'th') && parent.name !== 'tr') report(el, 'error', `<${name}> must be inside a table row <tr>.`, 'nesting');
  if (name === 'tr' && !['table', 'thead', 'tbody', 'tfoot'].includes(parent.name)) report(el, 'error', '<tr> must be inside <table>, <thead>, <tbody> or <tfoot>.', 'nesting');
  if ((TABLE_SECTIONS.has(name) || name === 'caption' || name === 'colgroup') && parent.name !== 'table') report(el, 'error', `<${name}> must be a child of <table>.`, 'nesting');
  if (parent.name === 'table' && !['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'script', 'template', 'style'].includes(name)) report(el, 'error', `<${name}> is not allowed directly inside <table>; put it in a cell.`, 'nesting');
  if (['tr', 'thead', 'tbody', 'tfoot'].includes(parent.name) && !['tr', 'td', 'th', 'script', 'template'].includes(name)) report(el, 'error', `<${name}> is not allowed directly inside <${parent.name}>; put it in a cell.`, 'nesting');
  if ((parent.name === 'ul' || parent.name === 'ol') && !['li', 'script', 'template'].includes(name)) report(el, 'error', `<${name}> is not allowed directly inside <${parent.name}>; wrap it in <li>.`, 'nesting');
  if (name === 'option' && !nearest(['select', 'datalist', 'optgroup'])) report(el, 'error', '<option> must be inside <select>, <datalist> or <optgroup>.', 'nesting');
  if (name === 'a' && has('a')) report(el, 'error', 'A link <a> cannot be inside another link.', 'nesting');
  if (name === 'form' && has('form')) report(el, 'error', 'A <form> cannot be inside another form.', 'nesting');
  if (name === 'label' && has('label')) report(el, 'error', 'A <label> cannot be inside another label.', 'nesting');
  if (isInteractive(el)) {
    const host = nearest(['button', 'a']);
    if (host && host !== el && !(host.name === 'a' && name === 'a') && (host.name === 'button' || hasAttr(host, 'href'))) report(el, 'error', `Interactive <${name}> inside <${host.name}> (line ${host.line}): controls cannot be nested.`, 'nesting');
  }
  if (FLOW_ONLY.has(name) && PHRASING_PARENTS.has(parent.name) && !(/^h[1-6]$/.test(name) && /^h[1-6]$/.test(parent.name))) report(el, 'error', `<${name}> is not allowed inside <${parent.name}>, which can only hold phrasing (inline) content.`, 'nesting');
  if (name === 'main' && stack.some((s) => ['article', 'aside', 'footer', 'header', 'nav'].includes(s.name))) report(el, 'error', '<main> cannot be inside article, aside, footer, header or nav.', 'nesting');
  if (name === 'legend' && parent.name !== 'fieldset') report(el, 'error', '<legend> must be the first child of <fieldset>.', 'nesting');
  if (name === 'figcaption' && parent.name !== 'figure') report(el, 'error', '<figcaption> must be inside <figure>.', 'nesting');
  if (name === 'summary' && parent.name !== 'details') report(el, 'error', '<summary> must be inside <details>.', 'nesting');
  if ((name === 'source' || name === 'track') && !['video', 'audio', 'picture'].includes(parent.name)) report(el, 'error', `<${name}> must be inside <video>, <audio> or <picture>.`, 'nesting');
}

// --------------------------------------------------------------------------------------------
// The validator

export interface ValidateOptions {
  /** Force XHTML rules ('auto' follows the doctype). */
  xhtml?: boolean | 'auto';
  /** Leave out obsolete-markup warnings. */
  noObsolete?: boolean;
  /** Treat the source as a fragment (no doctype, title or lang checks), e.g. a library item. */
  fragment?: boolean;
}

export function isXhtmlDoctype(src: string): boolean {
  const d = /^\s*(?:<\?xml[^>]*\?>\s*)?<!DOCTYPE([^>]*)>/i.exec(src)?.[1] || '';
  return /XHTML/i.test(d) || /^\s*<\?xml\s/i.test(src);
}

/** Checks a page's source. Issues are sorted by position. */
export function validateHtml(src: string, opts: ValidateOptions = {}): Issue[] {
  const r = parseHtml(src);
  const issues = r.issues;
  const { root, lines } = r;
  const at = (n: { line: number; col: number; start?: number }, severity: Severity, message: string, rule: string) => issues.push({ line: n.line, col: n.col, severity, message, rule, offset: n.start });
  const xhtml = opts.xhtml === true || ((opts.xhtml ?? 'auto') === 'auto' && isXhtmlDoctype(src));
  const frameset = /frameset/i.test(r.doctype?.text || '');
  const isTemplateFile = /<!--\s*#BeginEditable|InstanceBeginEditable|TemplateBeginEditable/i.test(src);

  // Document level
  if (!opts.fragment) {
    if (!r.doctype) at({ line: 1, col: 1, start: 0 }, 'error', 'Missing doctype. Start the page with <!DOCTYPE html>.', 'doctype');
    else {
      const d = r.doctype.text.replace(/\s+/g, ' ').trim();
      if (!/^doctype html$/i.test(d) && !xhtml) at(r.doctype, 'warning', `Legacy doctype "<!${d}>": HTML5 pages use <!DOCTYPE html>.`, 'doctype');
    }
    const html = byName(root, 'html')[0];
    if (!html) at({ line: 1, col: 1, start: 0 }, 'warning', 'No <html> element; add <html lang="…"> around the page.', 'structure');
    else {
      const lang = attr(html, 'lang') ?? attr(html, 'xml:lang');
      if (lang == null) at(html, 'warning', 'The <html> element has no lang attribute (for example lang="en").', 'lang');
      else if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(lang.trim())) at(html, 'error', `lang="${lang}" is not a valid language tag (BCP 47), for example "en" or "en-US".`, 'lang');
    }
    const titles = byName(root, 'title').filter((t) => !t.foreign);
    if (!titles.length && !isTemplateFile) at(byName(root, 'head')[0] || { line: 1, col: 1, start: 0 }, 'error', 'The page has no <title>; every page needs one.', 'title');
    if (titles.length > 1) at(titles[1], 'error', 'More than one <title> element.', 'title');
    if (titles[0] && !textOf(titles[0]).trim()) at(titles[0], 'error', 'The <title> is empty.', 'title');
    const metas = byName(root, 'meta');
    const charsetMetas = metas.filter((m) => hasAttr(m, 'charset') || (/content-type/i.test(attr(m, 'http-equiv') || '') && /charset/i.test(attr(m, 'content') || '')));
    if (!charsetMetas.length && !xhtml) at(byName(root, 'head')[0] || { line: 1, col: 1, start: 0 }, 'warning', 'No character encoding declared; add <meta charset="utf-8"> at the start of the head.', 'charset');
    if (charsetMetas.length > 1) at(charsetMetas[1], 'error', 'The character encoding is declared more than once.', 'charset');
    for (const m of charsetMetas) {
      if (m.start > 1024) at(m, 'error', 'The charset declaration must be within the first 1024 bytes of the page; move it to the top of the head.', 'charset');
      const cs = attr(m, 'charset') ?? /charset\s*=\s*([\w-]+)/i.exec(attr(m, 'content') || '')?.[1] ?? '';
      if (cs && !/^utf-?8$/i.test(cs.trim())) at(m, 'warning', `The page is declared as ${cs}; HTML5 pages should use UTF-8.`, 'charset');
    }
    for (const n of ['html', 'head', 'body', 'main']) {
      const all = byName(root, n).filter((x) => !(n === 'main' && hasAttr(x, 'hidden')));
      if (all.length > 1) at(all[1], 'error', `More than one <${n}> element.`, 'structure');
    }
  }

  // Elements and attributes
  const ids = new Map<string, HNode>();
  const allIds = new Set(findAll(root, (n) => hasAttr(n, 'id')).map((n) => attr(n, 'id')!));
  for (const el of findAll(root, () => true)) {
    const name = el.name;
    if (!el.foreign) {
      if (!HTML_ELEMENTS.has(name) && !OBSOLETE_ELEMENTS[name] && !name.includes('-') && !name.includes(':')) at(el, 'error', `Unknown element <${name}>.`, 'unknown-element');
      if (OBSOLETE_ELEMENTS[name] && !opts.noObsolete && !((name === 'frameset' || name === 'frame' || name === 'noframes') && frameset)) at(el, 'warning', `<${name}> is obsolete. ${OBSOLETE_ELEMENTS[name]}`, 'obsolete');
      if (name.includes(':') && !/^(o|w|v|st1|m):/.test(name)) at(el, 'warning', `Namespaced element <${name}> has no meaning in HTML.`, 'unknown-element');
      if (/^(o|w|v|st1|m):/.test(name)) at(el, 'warning', `<${name}> is word-processor markup; run Clean Up Word HTML.`, 'word');
    }
    // Duplicate attributes
    const seen = new Set<string>();
    for (const a of el.attrs) {
      if (seen.has(a.name)) at(a, 'error', `Duplicate attribute ${a.name} on <${name}>.`, 'dup-attr');
      seen.add(a.name);
      if (el.foreign) continue;
      if (!opts.noObsolete) { const adv = obsoleteAttrAdvice(name, a.name); if (adv && !(name === 'table' && a.name === 'border' )) at(a, 'warning', `The ${a.name} attribute on <${name}> is obsolete. ${adv}`, 'obsolete-attr'); }
      if (BOOLEAN_ATTRS.has(a.name) && a.value != null && a.value !== '' && a.value.toLowerCase() !== a.name) at(a, a.value === 'false' ? 'error' : 'warning', `Boolean attribute ${a.name}="${a.value}": any value turns it on${a.value === 'false' ? ' (even "false")' : ''}. Write ${a.name} alone, or remove it to turn it off.`, 'bool-attr');
      if (a.value != null && /&/.test(a.value)) checkAmp(a.value, a.start + a.name.length + 2, lines, issues, xhtml);
      if (xhtml) {
        { const rawName = src.slice(a.start, a.start + a.name.length); if (/[A-Z]/.test(rawName)) at(a, 'error', `XHTML: attribute names must be lower case (${rawName}).`, 'xhtml'); }
        if (a.value == null) at(a, 'error', `XHTML: attribute ${a.name} needs a value (${a.name}="${a.name}").`, 'xhtml');
        else if (!a.quote) at(a, 'error', `XHTML: the value of ${a.name} must be in quotes.`, 'xhtml');
      }
      if (a.name.startsWith('on') && a.value != null && !a.value.trim()) at(a, 'warning', `Empty event handler ${a.name}.`, 'attr-value');
    }
    if (el.foreign) continue;
    if (xhtml) {
      const raw = /^<\/?([^\s/>]+)/.exec(src.slice(el.start, el.end))?.[1] || '';
      if (/[A-Z]/.test(raw)) at(el, 'error', `XHTML: element names must be lower case (<${raw}>).`, 'xhtml');
      if (VOID_ELEMENTS.has(name) && !el.selfClose) at(el, 'error', `XHTML: void element <${name}> must be closed as <${name} />.`, 'xhtml');
      if (!VOID_ELEMENTS.has(name) && el.implied && name !== 'html' && name !== 'head' && name !== 'body') at(el, 'error', `XHTML: <${name}> needs an explicit end tag </${name}>.`, 'xhtml');
    }
    // Ids
    const id = attr(el, 'id');
    if (id != null) {
      if (!id) at(el, 'error', 'Empty id attribute.', 'id');
      else if (/\s/.test(id)) at(el, 'error', `id "${id}" contains spaces.`, 'id');
      else if (ids.has(id)) at(el, 'error', `Duplicate id "${id}" (first used on line ${ids.get(id)!.line}).`, 'dup-id');
      else ids.set(id, el);
    }
    // Required attributes and values
    switch (name) {
      case 'img':
        if (!hasAttr(el, 'alt')) at(el, 'error', '<img> needs an alt attribute (alt="" for a decorative picture).', 'img-alt');
        if (!hasAttr(el, 'src') && !hasAttr(el, 'srcset')) at(el, 'error', '<img> has no src.', 'required');
        for (const d of ['width', 'height']) { const v = attr(el, d); if (v != null && !/^\d+$/.test(v.trim())) at(attrNode(el, d)!, 'error', `${d}="${v}" must be a whole number of pixels (no "px" or "%"); use CSS for other units.`, 'attr-value'); }
        break;
      case 'area': if (hasAttr(el, 'href') && !hasAttr(el, 'alt')) at(el, 'error', '<area> with href needs an alt attribute.', 'img-alt'); break;
      case 'input': {
        const tp = attr(el, 'type');
        if (tp != null && !INPUT_TYPES.has(tp.toLowerCase())) at(attrNode(el, 'type')!, tp.toLowerCase() === 'datetime' ? 'warning' : 'error', `"${tp}" is not an input type.${tp.toLowerCase() === 'datetime' ? ' Use datetime-local.' : ''}`, 'attr-value');
        if ((tp || '').toLowerCase() === 'image' && !hasAttr(el, 'alt')) at(el, 'error', '<input type="image"> needs an alt attribute.', 'img-alt');
        break;
      }
      case 'button': { const tp = attr(el, 'type'); if (tp != null && !/^(submit|reset|button)$/i.test(tp)) at(attrNode(el, 'type')!, 'error', `"${tp}" is not a button type (submit, reset or button).`, 'attr-value'); break; }
      case 'label': { const f = attr(el, 'for'); if (f != null && !allIds.has(f)) at(attrNode(el, 'for')!, 'error', `<label for="${f}"> refers to no element with that id.`, 'label-for'); else if (f) { const tgt = ids.get(f) || findAll(root, (x) => attr(x, 'id') === f)[0]; if (tgt && !['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress'].includes(tgt.name) && !tgt.name.includes('-')) at(attrNode(el, 'for')!, 'error', `<label for="${f}"> points at a <${tgt.name}>, which cannot be labeled.`, 'label-for'); } break; }
      case 'link': if (!hasAttr(el, 'href')) at(el, 'error', '<link> needs an href.', 'required'); if (!hasAttr(el, 'rel') && !hasAttr(el, 'itemprop')) at(el, 'error', '<link> needs a rel attribute.', 'required'); break;
      case 'meta': if (!['name', 'http-equiv', 'charset', 'itemprop', 'property'].some((a) => hasAttr(el, a))) at(el, 'error', '<meta> needs name, http-equiv, charset or itemprop.', 'required'); else if ((hasAttr(el, 'name') || hasAttr(el, 'http-equiv') || hasAttr(el, 'property')) && !hasAttr(el, 'content')) at(el, 'error', '<meta> needs a content attribute.', 'required'); break;
      case 'optgroup': if (!hasAttr(el, 'label')) at(el, 'error', '<optgroup> needs a label attribute.', 'required'); break;
      case 'a': { const h = attr(el, 'href'); if (h != null && /\s/.test(h.trim())) at(attrNode(el, 'href')!, 'warning', `The link address "${h.slice(0, 60)}" contains spaces; write them as %20.`, 'attr-value'); break; }
      case 'script': if (hasAttr(el, 'src') && el.children.some((c) => c.type === 'text' && c.text.trim())) at(el, 'error', 'A <script> with src cannot also hold code.', 'script'); break;
      case 'iframe': case 'embed': case 'object': case 'video': case 'audio': case 'canvas':
        for (const d of ['width', 'height']) { const v = attr(el, d); if (v != null && !/^\d+$/.test(v.trim())) at(attrNode(el, d)!, 'error', `${d}="${v}" must be a whole number of pixels.`, 'attr-value'); }
        break;
    }
    const ti = attr(el, 'tabindex');
    if (ti != null && !/^-?\d+$/.test(ti.trim())) at(attrNode(el, 'tabindex')!, 'error', `tabindex="${ti}" must be an integer.`, 'attr-value');
  }

  // Text: character references
  for (const t of r.tokens) if (t.type === 'text' && t.name !== '#raw' && t.text.includes('&')) checkAmp(t.text, t.start, lines, issues, xhtml);

  issues.sort((a, b) => a.line - b.line || a.col - b.col);
  return dedupe(issues);
}

function checkAmp(text: string, base: number, lines: LineIndex, issues: Issue[], strict: boolean): void {
  const re = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[A-Za-z][A-Za-z0-9]*;?)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1];
    const p = lines.at(base + m.index);
    if (!body) { if (strict) issues.push({ ...p, severity: 'error', message: 'XHTML: "&" must be written as "&amp;".', rule: 'escape', offset: base + m.index }); continue; }
    if (!body.endsWith(';')) {
      if (/^[A-Za-z]/.test(body) && !strict && !(body.toLowerCase() in NAMED)) continue; // "&foo" that is no reference: allowed in HTML
      issues.push({ ...p, severity: strict ? 'error' : 'warning', message: `"&${body}" is ambiguous: write "&amp;${body}" for the text, or end the character reference with ";".`, rule: 'escape', offset: base + m.index });
    }
  }
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => { const k = `${i.line}:${i.col}:${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// --------------------------------------------------------------------------------------------
// XML

const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/** XML well-formedness: one root, balanced and case-matched tags, quoted attributes, escaped & and <. */
export function validateXml(src: string): Issue[] {
  const lines = new LineIndex(src);
  const issues: Issue[] = [];
  const tokens = tokenize(src, { xml: true, issues, lines });
  const at = (n: { line: number; col: number; start?: number }, message: string, severity: Severity = 'error', rule = 'xml') => issues.push({ line: n.line, col: n.col, severity, message, rule, offset: n.start });
  const stack: Token[] = [];
  let roots = 0;
  let seenContent = false;
  const declared = new Set<string>();
  for (const m of src.matchAll(/<!ENTITY\s+([\w.-]+)/g)) declared.add(m[1]);
  for (const t of tokens) {
    switch (t.type) {
      case 'pi':
        if (/^xml\s/i.test(t.text) && (t.start !== 0)) at(t, 'The XML declaration must be at the very start of the file.');
        break;
      case 'doctype': if (roots) at(t, 'The doctype must come before the root element.'); break;
      case 'comment': if (t.text.includes('--')) at(t, 'A comment cannot contain "--".'); seenContent = true; break;
      case 'text':
        if (!stack.length && /\S/.test(t.text)) at(t, 'Text outside the root element.');
        for (const m of t.text.matchAll(/&([^;\s&<]*)(;?)/g)) {
          const p = lines.at(t.start + m.index!);
          if (!m[2] || !m[1]) issues.push({ ...p, severity: 'error', message: '"&" must start a character reference ("&amp;", "&#169;").', rule: 'xml', offset: t.start + m.index! });
          else if (!/^#(\d+|x[0-9a-fA-F]+)$/.test(m[1]) && !XML_ENTITIES.has(m[1]) && !declared.has(m[1])) issues.push({ ...p, severity: 'error', message: `Undeclared entity "&${m[1]};" (XML knows only amp, lt, gt, quot and apos).`, rule: 'xml', offset: t.start + m.index! });
        }
        break;
      case 'start': {
        if (!stack.length) { roots++; if (roots > 1) at(t, `A second root element <${t.raw}>; an XML document has exactly one.`); }
        seenContent = true;
        const seen = new Set<string>();
        for (const a of t.attrs) {
          if (seen.has(a.name)) at(a, `Duplicate attribute ${a.name}.`);
          seen.add(a.name);
          if (a.value == null) at(a, `Attribute ${a.name} needs a value in quotes.`);
          else if (!a.quote) at(a, `The value of ${a.name} must be in quotes.`);
          else if (a.value.includes('<')) at(a, `"<" is not allowed in the value of ${a.name}.`);
        }
        if (!t.selfClose) stack.push(t);
        break;
      }
      case 'end': {
        const top = stack[stack.length - 1];
        if (!top) { at(t, `End tag </${t.raw}> without a start tag.`); break; }
        if (top.raw === t.raw) { stack.pop(); break; }
        const k = stack.map((s) => s.raw).lastIndexOf(t.raw);
        if (k < 0) {
          const ci = stack.find((s) => s.raw.toLowerCase() === t.raw.toLowerCase());
          at(t, ci ? `End tag </${t.raw}> does not match <${ci.raw}>: XML names are case-sensitive.` : `End tag </${t.raw}> without a start tag.`);
          if (ci) stack.splice(stack.indexOf(ci));
          break;
        }
        for (let j = stack.length - 1; j > k; j--) at(stack[j], `<${stack[j].raw}> is not closed before </${t.raw}>.`);
        stack.splice(k);
        break;
      }
      case 'bogus': if (!/^\[CDATA\[/.test(t.text)) at(t, `Unexpected markup "<!${t.text.slice(0, 20)}".`, 'warning'); break;
    }
  }
  for (const s of stack) at(s, `<${s.raw}> is never closed.`);
  if (!roots) at({ line: 1, col: 1, start: 0 }, 'The document has no root element.');
  void seenContent;
  issues.sort((a, b) => a.line - b.line || a.col - b.col);
  return dedupe(issues);
}

/** Converts a W3C Nu validator JSON response into issues. */
export function fromNuJson(j: any): Issue[] {
  const out: Issue[] = [];
  for (const m of j?.messages || []) {
    const severity: Severity = m.type === 'error' || m.subType === 'fatal' ? 'error' : m.subType === 'warning' ? 'warning' : 'info';
    out.push({ line: m.lastLine || m.firstLine || 1, col: m.firstColumn || m.lastColumn || 1, severity, message: String(m.message || ''), rule: 'w3c' });
  }
  return out;
}
