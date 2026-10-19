/**
 * A small Emmet-style abbreviation expander (original implementation).
 *
 * Supported: tag names, #id, .class, [attr=value attr2="v" bool], {text}, child (>), sibling (+),
 * climb up (^), multiplication (*n), numbering ($, $$, $@-, $@3), grouping ( ), implicit tag names
 * (li inside ul/ol, td inside tr, …), lorem / loremN placeholder text, a few aliases (a, img, link:css,
 * input:email, !) and a handful of CSS abbreviations (m10, p10-20, w100p, dn, …).
 */

export interface ExpandOptions { indent?: string; /** Put a caret marker (\u0001) at the first empty slot. */ caret?: boolean }

interface Item {
  kind: 'el' | 'group' | 'text';
  name: string;
  id?: string;
  classes: string[];
  attrs: [string, string | null][];
  text?: string;
  mult: number;
  children: Item[];
  /** The inner items of a group. */
  items?: Item[];
}

interface Node {
  name: string; // '' for a text node
  attrs: [string, string | null][];
  text?: string;
  children: Node[];
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const INLINE = new Set(['a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'br', 'button', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'mark', 'meter', 'output', 'q', 's', 'samp', 'select', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'textarea', 'time', 'tt', 'u', 'var', 'wbr']);

/** Known HTML element names: an abbreviation that is a bare word expands only when it is one of these. */
export const HTML_TAGS = new Set(['a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress', 'q', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr', 'svg']);

/** Aliases: name → [tag, default attributes]. */
const ALIASES: Record<string, [string, [string, string | null][]]> = {
  a: ['a', [['href', '']]],
  'a:link': ['a', [['href', 'https://']]],
  'a:mail': ['a', [['href', 'mailto:']]],
  'a:tel': ['a', [['href', 'tel:']]],
  img: ['img', [['src', ''], ['alt', '']]],
  link: ['link', [['rel', 'stylesheet'], ['href', '']]],
  'link:css': ['link', [['rel', 'stylesheet'], ['href', 'style.css']]],
  'link:favicon': ['link', [['rel', 'icon'], ['type', 'image/x-icon'], ['href', 'favicon.ico']]],
  'script:src': ['script', [['src', '']]],
  'meta:vp': ['meta', [['name', 'viewport'], ['content', 'width=device-width, initial-scale=1']]],
  'meta:utf': ['meta', [['charset', 'utf-8']]],
  input: ['input', [['type', 'text'], ['name', '']]],
  form: ['form', [['action', '']]],
  'form:post': ['form', [['action', ''], ['method', 'post']]],
  label: ['label', [['for', '']]],
  iframe: ['iframe', [['src', '']]],
  video: ['video', [['src', ''], ['controls', null]]],
  audio: ['audio', [['src', ''], ['controls', null]]],
  source: ['source', [['src', ''], ['type', '']]],
  area: ['area', [['shape', ''], ['coords', ''], ['href', ''], ['alt', '']]],
  option: ['option', [['value', '']]],
  textarea: ['textarea', [['name', ''], ['rows', '4'], ['cols', '30']]],
  btn: ['button', [['type', 'button']]],
  'btn:s': ['button', [['type', 'submit']]],
  'btn:r': ['button', [['type', 'reset']]],
  bq: ['blockquote', []],
  fig: ['figure', []],
  figc: ['figcaption', []],
  pic: ['picture', []],
  sect: ['section', []],
  art: ['article', []],
  hdr: ['header', []],
  ftr: ['footer', []],
  str: ['strong', []],
  emb: ['embed', [['src', ''], ['type', '']]],
  obj: ['object', [['data', ''], ['type', '']]],
  tarea: ['textarea', [['name', ''], ['rows', '4'], ['cols', '30']]],
  opt: ['option', [['value', '']]],
  sel: ['select', [['name', '']]],
};

const HTML5_DOC = '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>\u0001Document</title>\n</head>\n<body>\n\t\u0001\n</body>\n</html>';

const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum'.split(' ');

/** Placeholder text of `n` words: sentences of 5–12 words, capitalized, ending with a period. */
export function lorem(n: number, offset = 0): string {
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(LOREM[(i + offset) % LOREM.length]);
  const out: string[] = [];
  let i = 0, s = 0;
  while (i < words.length) {
    const len = Math.min(words.length - i, 5 + ((s * 7 + offset) % 8));
    const sent = words.slice(i, i + len);
    sent[0] = sent[0][0].toUpperCase() + sent[0].slice(1);
    out.push(sent.join(' ') + '.');
    i += len; s++;
  }
  return out.join(' ');
}

class Parser {
  i = 0;
  constructor(public s: string) {}
  peek(): string { return this.s[this.i] || ''; }
  eof(): boolean { return this.i >= this.s.length; }
  fail(msg: string): never { throw new Error(`${msg} at position ${this.i + 1} in "${this.s}"`); }

  /** Siblings at one level, following > and ^. Returns the items and the number of ^ still to climb. */
  seq(): { items: Item[]; up: number } {
    const items: Item[] = [];
    for (;;) {
      if (this.eof() || this.peek() === ')') return { items, up: 0 };
      const item = this.item();
      items.push(item);
      const c = this.peek();
      if (c === '+') { this.i++; continue; }
      if (c === '>') {
        this.i++;
        const r = this.seq();
        const target = item.kind === 'group' ? lastLeaf(item) : item;
        target.children.push(...r.items);
        if (r.up > 1) return { items, up: r.up - 1 };
        if (r.up === 1) continue;
        return { items, up: 0 };
      }
      if (c === '^') {
        let n = 0;
        while (this.peek() === '^') { n++; this.i++; }
        return { items, up: n };
      }
      if (this.eof() || c === ')') return { items, up: 0 };
      this.fail(`Unexpected "${c}"`);
    }
  }

  /** A whole level: ^ that climbs above it just continues here. */
  level(): Item[] {
    const all: Item[] = [];
    for (;;) {
      const r = this.seq();
      all.push(...r.items);
      if (r.up > 0 && !this.eof() && this.peek() !== ')') continue;
      return all;
    }
  }

  item(): Item {
    if (this.peek() === '(') {
      this.i++;
      const items = this.level();
      if (this.peek() !== ')') this.fail('Missing ")"');
      this.i++;
      const g: Item = { kind: 'group', name: '', classes: [], attrs: [], mult: 1, children: [], items };
      this.mult(g);
      return g;
    }
    const el: Item = { kind: 'el', name: '', classes: [], attrs: [], mult: 1, children: [] };
    const m = /^[A-Za-z!][\w:!$@-]*/.exec(this.s.slice(this.i));
    if (m) { el.name = m[0]; this.i += m[0].length; }
    let any = !!m;
    for (;;) {
      const c = this.peek();
      if (c === '#') { this.i++; el.id = this.word(); any = true; }
      else if (c === '.') { this.i++; el.classes.push(this.word()); any = true; }
      else if (c === '[') { this.i++; this.attrs(el); any = true; }
      else if (c === '{') { this.i++; el.text = (el.text || '') + this.braced(); any = true; }
      else if (c === '*') { this.mult(el); }
      else break;
    }
    if (!any) this.fail(this.eof() ? 'Abbreviation ends too early' : `Unexpected "${this.peek()}"`);
    if (!el.name && el.text != null && !el.id && !el.classes.length && !el.attrs.length) el.kind = 'text';
    return el;
  }

  word(): string {
    const m = /^[^\s.#[\]{}>+^*()]+/.exec(this.s.slice(this.i));
    if (!m) this.fail('Expected a name');
    this.i += m[0].length;
    return m[0];
  }

  mult(it: Item): void {
    if (this.peek() !== '*') return;
    this.i++;
    const m = /^\d+/.exec(this.s.slice(this.i));
    if (!m) this.fail('Expected a number after "*"');
    this.i += m[0].length;
    it.mult = Math.min(1000, parseInt(m[0], 10));
  }

  braced(): string {
    let depth = 1, out = '';
    while (!this.eof()) {
      const c = this.s[this.i++];
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) return out;
      out += c;
    }
    this.fail('Missing "}"');
  }

  attrs(el: Item): void {
    for (;;) {
      while (this.peek() === ' ' || this.peek() === ',') this.i++;
      if (this.peek() === ']') { this.i++; return; }
      if (this.eof()) this.fail('Missing "]"');
      const m = /^[^\s=\]]+/.exec(this.s.slice(this.i));
      if (!m) this.fail('Expected an attribute name');
      this.i += m[0].length;
      let val: string | null = null;
      if (this.peek() === '=') {
        this.i++;
        const q = this.peek();
        if (q === '"' || q === "'") {
          const end = this.s.indexOf(q, this.i + 1);
          if (end < 0) this.fail('Missing closing quote');
          val = this.s.slice(this.i + 1, end);
          this.i = end + 1;
        } else {
          const v = /^[^\s\]]*/.exec(this.s.slice(this.i))![0];
          val = v; this.i += v.length;
        }
      }
      el.attrs.push([m[0], val]);
    }
  }
}

function lastLeaf(g: Item): Item {
  const items = g.items || [];
  const last = items[items.length - 1];
  if (!last) return g;
  return last.kind === 'group' ? lastLeaf(last) : last;
}

/** Replaces $ runs with the number (padded to the run's length); $@- counts down, $@3 starts at 3. */
export function numbered(s: string, index: number, count: number): string {
  return s.replace(/(\$+)(@(-)?(\d+)?)?/g, (m, dollars: string, at, rev, start) => {
    const base = start ? parseInt(start, 10) : 1;
    const n = rev ? base + count - index : base + index - 1;
    return String(n).padStart(dollars.length, '0');
  });
}

function expand(items: Item[], index: number, count: number): Node[] {
  const out: Node[] = [];
  for (const it of items) {
    const reps = it.mult;
    for (let r = 1; r <= reps; r++) {
      const idx = reps > 1 ? r : index, cnt = reps > 1 ? reps : count;
      const num = (s: string) => numbered(s, idx, cnt);
      if (it.kind === 'group') { out.push(...expand(it.items || [], idx, cnt)); continue; }
      if (it.kind === 'text') { out.push({ name: '', attrs: [], text: num(it.text || ''), children: [] }); continue; }
      let name = num(it.name);
      let text = it.text != null ? num(it.text) : undefined;
      const lm = /^(?:lorem|lipsum)(\d*)$/i.exec(name);
      const attrs: [string, string | null][] = [];
      if (lm) {
        const words = lm[1] ? parseInt(lm[1], 10) : 30;
        const t = lorem(words, (idx - 1) * 3);
        if (!it.id && !it.classes.length && !it.attrs.length && it.text == null) { out.push({ name: '', attrs: [], text: t, children: expand(it.children, idx, cnt) }); continue; }
        name = ''; text = t;
      }
      const alias = ALIASES[name] || (/^input:(\w+)$/.exec(name) ? ['input', [['type', /^input:(\w+)$/.exec(name)![1]], ['name', '']]] as [string, [string, string | null][]] : null);
      if (alias) { name = alias[0]; for (const a of alias[1]) attrs.push([a[0], a[1]]); }
      if (it.id) setAttr(attrs, 'id', num(it.id));
      if (it.classes.length) setAttr(attrs, 'class', it.classes.map(num).join(' '));
      for (const [k, v] of it.attrs) setAttr(attrs, num(k), v == null ? null : num(v));
      const children = expand(it.children, idx, cnt);
      out.push({ name, attrs, text, children });
    }
  }
  return out;
}

function setAttr(attrs: [string, string | null][], k: string, v: string | null): void {
  const i = attrs.findIndex((a) => a[0] === k);
  if (i >= 0) attrs[i][1] = v; else attrs.push([k, v]);
}

function implicitName(parent: string): string {
  switch (parent) {
    case 'ul': case 'ol': case 'menu': return 'li';
    case 'table': case 'tbody': case 'thead': case 'tfoot': return 'tr';
    case 'tr': return 'td';
    case 'select': case 'optgroup': case 'datalist': return 'option';
    case 'dl': return 'dt';
    case 'audio': case 'video': case 'picture': return 'source';
    case 'colgroup': return 'col';
    default: return INLINE.has(parent) || /^(p|h[1-6]|span|label|button|dt|caption|legend|summary)$/.test(parent) ? 'span' : 'div';
  }
}

function resolveNames(nodes: Node[], parent: string): void {
  for (const n of nodes) {
    if (!n.name && (n.attrs.length || (n.text == null && n.children.length))) n.name = implicitName(parent);
    if (!n.name && n.text == null && !n.children.length) n.name = implicitName(parent);
    resolveNames(n.children, n.name || parent);
  }
}

const escText = (s: string) => s.replace(/&(?![a-zA-Z#][\w#]*;)/g, '&amp;').replace(/</g, '&lt;');
const escAttr = (s: string) => s.replace(/"/g, '&quot;');

function isInlineNode(n: Node): boolean { return (!n.name || INLINE.has(n.name.toLowerCase())) && n.children.every(isInlineNode); }

function render(nodes: Node[], depth: number, ind: string, mark: string): string {
  const parts: string[] = [];
  const multiline = nodes.some((n) => !isInlineNode(n)) && nodes.length > 1;
  for (const n of nodes) parts.push(renderNode(n, depth, ind, mark));
  if (!multiline) return parts.join('');
  return parts.join('\n' + ind.repeat(depth));
}

function renderNode(n: Node, depth: number, ind: string, mark: string): string {
  if (!n.name) return escText(n.text || '') + (n.children.length ? render(n.children, depth, ind, mark) : '');
  const attrs = n.attrs.map(([k, v]) => (v == null ? ` ${k}` : ` ${k}="${v === '' ? mark : escAttr(v)}"`)).join('');
  const open = `<${n.name}${attrs}>`;
  if (VOID.has(n.name.toLowerCase())) return open;
  const kids: Node[] = [];
  if (n.text != null) kids.push({ name: '', attrs: [], text: n.text, children: [] });
  kids.push(...n.children);
  if (!kids.length) return `${open}${mark}</${n.name}>`;
  const block = kids.some((k) => !isInlineNode(k));
  if (!block) return `${open}${kids.map((k) => renderNode(k, depth + 1, ind, mark)).join('')}</${n.name}>`;
  const inner = kids.map((k) => ind.repeat(depth + 1) + renderNode(k, depth + 1, ind, mark)).join('\n');
  return `${open}\n${inner}\n${ind.repeat(depth)}</${n.name}>`;
}

/**
 * Expands an HTML abbreviation. With opts.caret, the result keeps \u0001 at the first empty slot
 * (an empty attribute value or element) so an editor can place the cursor there.
 */
export function expandAbbreviation(abbr: string, opts: ExpandOptions = {}): string {
  const ind = opts.indent ?? '  ';
  const a = abbr.trim();
  if (!a) throw new Error('Type an abbreviation first, such as ul>li*3.');
  let out: string;
  if (a === '!' || a === 'html:5' || a === '!!!') out = HTML5_DOC.replace(/\t/g, ind);
  else {
    const p = new Parser(a);
    const items = p.level();
    if (!p.eof()) p.fail(`Unexpected "${p.peek()}"`);
    const nodes = expand(items, 1, 1);
    resolveNames(nodes, 'body');
    out = render(nodes, 0, ind, '\u0001');
  }
  if (opts.caret) {
    const first = out.indexOf('\u0001');
    out = out.replace(/\u0001/g, '');
    return first >= 0 ? out.slice(0, first) + '\u0001' + out.slice(first) : out;
  }
  return out.replace(/\u0001/g, '');
}

/**
 * Where the abbreviation that ends at `pos` in `line` starts (the text before the cursor), or -1.
 * It stops at white space outside braces/brackets and at the end of a preceding tag.
 */
export function abbreviationStart(line: string, pos: number): number {
  let depthBrace = 0, depthBracket = 0, i = pos;
  while (i > 0) {
    const c = line[i - 1];
    if (c === '}') depthBrace++;
    else if (c === '{') { if (depthBrace === 0) break; depthBrace--; }
    else if (c === ']') depthBracket++;
    else if (c === '[') { if (depthBracket === 0) break; depthBracket--; }
    else if (depthBrace === 0 && depthBracket === 0) {
      if (/\s/.test(c) || c === '<') break;
      if (c === '>' && /<[^<>]*$/.test(line.slice(0, i - 1))) break;
      if (c === '>' && /["']$/.test(line.slice(0, i - 1))) break;
    }
    i--;
  }
  return i < pos ? i : -1;
}

/** True when the text looks like an abbreviation worth expanding with Tab (not a plain word). */
export function looksLikeAbbreviation(a: string): boolean {
  if (!a || /^\d/.test(a)) return false;
  if (a === '!') return true;
  if (/[>+^*#.[{(]/.test(a)) return /^[\w!(.#[{]/.test(a);
  const base = a.toLowerCase();
  return HTML_TAGS.has(base) || base in ALIASES || /^(lorem|lipsum)\d*$/.test(base) || /^input:\w+$/.test(base);
}

// ------------------------------------------------------------------------------------------
// CSS abbreviations

const CSS_PROPS: Record<string, string> = {
  m: 'margin', mt: 'margin-top', mr: 'margin-right', mb: 'margin-bottom', ml: 'margin-left',
  p: 'padding', pt: 'padding-top', pr: 'padding-right', pb: 'padding-bottom', pl: 'padding-left',
  w: 'width', h: 'height', maw: 'max-width', mah: 'max-height', miw: 'min-width', mih: 'min-height',
  t: 'top', r: 'right', b: 'bottom', l: 'left', z: 'z-index', fz: 'font-size', lh: 'line-height', fw: 'font-weight',
  bdrs: 'border-radius', gap: 'gap', op: 'opacity', ti: 'text-indent', ls: 'letter-spacing',
};
const CSS_KEYWORDS: Record<string, string> = {
  dn: 'display: none;', db: 'display: block;', di: 'display: inline;', dib: 'display: inline-block;', df: 'display: flex;', dg: 'display: grid;',
  posa: 'position: absolute;', posr: 'position: relative;', posf: 'position: fixed;', poss: 'position: sticky;',
  tac: 'text-align: center;', tal: 'text-align: left;', tar: 'text-align: right;', taj: 'text-align: justify;',
  fwb: 'font-weight: bold;', fwn: 'font-weight: normal;', fsi: 'font-style: italic;', tdn: 'text-decoration: none;', tdu: 'text-decoration: underline;',
  ttu: 'text-transform: uppercase;', ovh: 'overflow: hidden;', ova: 'overflow: auto;', curp: 'cursor: pointer;',
  fl: 'float: left;', fr: 'float: right;', cb: 'clear: both;', bxsb: 'box-sizing: border-box;',
  jcc: 'justify-content: center;', jcsb: 'justify-content: space-between;', aic: 'align-items: center;', fdc: 'flex-direction: column;', fww: 'flex-wrap: wrap;',
  c: 'color: #000;', bgc: 'background-color: #fff;', bd: 'border: 1px solid #000;', bdn: 'border: none;', mxa: 'margin: 0 auto;',
};

/** Expands a CSS abbreviation (m10 → margin: 10px;), or returns null. */
export function expandCss(abbr: string): string | null {
  const a = abbr.trim();
  if (CSS_KEYWORDS[a]) return CSS_KEYWORDS[a];
  const m = /^([a-z]+?)(-?\d[\d.]*[a-z%]*(?:-\d[\d.]*[a-z%]*)*|a(?:uto)?)$/.exec(a.replace(/:/g, ''));
  if (!m || !CSS_PROPS[m[1]]) return null;
  const prop = CSS_PROPS[m[1]];
  const unitless = /^(z-index|opacity|font-weight|line-height)$/.test(prop);
  const vals = m[2] === 'a' || m[2] === 'auto' ? ['auto'] : m[2].split(/(?<=\d|[a-z%])-(?=\d)/);
  const unit = (v: string) => {
    if (v === 'auto' || unitless) return v.replace(/p$/, '%');
    if (/^-?[\d.]+$/.test(v)) return v === '0' ? '0' : `${v}px`;
    return v.replace(/p$/, '%').replace(/e$/, 'em').replace(/r$/, 'rem').replace(/x$/, 'ex');
  };
  return `${prop}: ${vals.map(unit).join(' ')};`;
}
