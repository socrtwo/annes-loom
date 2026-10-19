/**
 * WordPress block editor markup ⇄ plain HTML.
 *
 * Block markup is HTML with delimiter comments: <!-- wp:paragraph --> … <!-- /wp:paragraph -->, with
 * JSON attributes (<!-- wp:heading {"level":3} -->) and self-closing dynamic blocks (<!-- wp:latest-posts /-->)
 * that the server renders. Static blocks already hold their saved HTML, so turning markup into HTML is mostly
 * removing delimiters; dynamic blocks go through a renderer callback (theme import) or become a note.
 */

export interface Block {
  name: string;
  attrs: Record<string, any>;
  /** Children in order: HTML strings and nested blocks. */
  inner: (string | Block)[];
  selfClosing: boolean;
}

const DELIM = /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+((?:\{[\s\S]*?\})\s+)?(\/)?-->/g;

/** Parses block markup into a tree. Text outside any block becomes top-level HTML strings. */
export function parseBlocks(markup: string): (string | Block)[] {
  const root: Block = { name: '#root', attrs: {}, inner: [], selfClosing: false };
  const stack: Block[] = [root];
  let last = 0;
  DELIM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DELIM.exec(markup))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.inner.push(markup.slice(last, m.index));
    last = m.index + m[0].length;
    const name = (m[2] || 'core/') + m[3];
    if (m[1]) {
      // Closer: pop to the matching block (tolerates unbalanced markup).
      const i = stack.map((b) => b.name).lastIndexOf(name);
      if (i > 0) stack.length = i;
      continue;
    }
    let attrs: Record<string, any> = {};
    if (m[4]) { try { attrs = JSON.parse(m[4]); } catch { attrs = {}; } }
    const b: Block = { name, attrs, inner: [], selfClosing: !!m[5] };
    top.inner.push(b);
    if (!b.selfClosing) stack.push(b);
  }
  if (last < markup.length) stack[stack.length - 1].inner.push(markup.slice(last));
  return root.inner;
}

export const hasBlocks = (s: string): boolean => /<!--\s+wp:[a-z]/.test(s);

/**
 * Renders a dynamic or special block. `inner()` renders the children (it can be called more than once,
 * for query loops). Return undefined to use the default (the saved HTML).
 */
export type BlockRenderer = (b: Block, inner: () => string) => string | undefined;

/** Blocks the server renders; without a renderer they become an HTML comment noting what was there. */
const DYNAMIC = /^core\/(latest-posts|latest-comments|archives|categories|calendar|tag-cloud|rss|search|navigation|page-list|site-title|site-tagline|site-logo|post-title|post-content|post-excerpt|post-date|post-author|post-author-name|post-terms|post-featured-image|post-navigation-link|query|post-template|query-pagination.*|query-title|query-no-results|comments.*|post-comments.*|loginout|template-part|pattern|block|legacy-widget|widget-group|home-link|read-more|avatar|term-description|footnotes|social-link)$/;

export function blocksToHtml(markup: string, opts: { render?: BlockRenderer; dropped?: string[] } = {}): string {
  const tree = parseBlocks(markup);
  const renderList = (list: (string | Block)[]): string => list.map((n) => (typeof n === 'string' ? n : renderBlock(n))).join('');
  const renderBlock = (b: Block): string => {
    const inner = () => renderList(b.inner);
    const custom = opts.render?.(b, inner);
    if (custom !== undefined) return custom;
    if (b.name === 'core/shortcode') return inner();
    if (b.selfClosing || (DYNAMIC.test(b.name) && !b.inner.some((x) => typeof x === 'string' && x.trim()))) {
      if (b.name === 'core/social-link' && b.attrs.url) return `<li class="wp-social-link wp-social-link-${escA(b.attrs.service || 'link')}"><a href="${escA(b.attrs.url)}">${escT(b.attrs.label || b.attrs.service || 'Link')}</a></li>`;
      opts.dropped?.push(b.name);
      if (b.inner.length) return inner();
      return `<!-- ${b.name.replace(/^core\//, '')} (dynamic block, rendered by WordPress) -->`;
    }
    return addLayoutClasses(inner(), b);
  };
  return renderList(tree).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Layout classes WordPress adds when it renders container blocks (they are not in the saved markup). */
export function addLayoutClasses(html: string, b: Block): string {
  const l = b.attrs.layout;
  const cls: string[] = [];
  if (l && typeof l === 'object') {
    const type = l.type || (l.inherit ? 'constrained' : 'flow');
    cls.push(`is-layout-${type}`);
    if (l.justifyContent) cls.push(`is-content-justification-${l.justifyContent}`);
    if (l.orientation === 'vertical') cls.push('is-vertical');
    if (l.flexWrap === 'nowrap') cls.push('is-nowrap');
  } else if (/^core\/(columns|buttons|social-links|navigation)$/.test(b.name)) cls.push('is-layout-flex');
  else if (b.name === 'core/group') cls.push('is-layout-flow');
  if (!cls.length) return html;
  return addClassToFirstTag(html, cls.join(' '));
}

export function addClassToFirstTag(html: string, cls: string): string {
  if (!cls.trim()) return html;
  return html.replace(/<([a-z][\w-]*)(\s[^>]*?)?(\/?)>/i, (m, tag: string, attrs = '', sc: string) => {
    if (/\sclass\s*=\s*"/i.test(attrs)) return `<${tag}${attrs.replace(/(\sclass\s*=\s*")([^"]*)"/i, (_x: string, a: string, v: string) => `${a}${v ? v + ' ' : ''}${cls}"`)}${sc}>`;
    return `<${tag}${attrs} class="${cls}"${sc}>`;
  });
}

const escA = (s: unknown) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!);
const escT = (s: unknown) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

// ------------------------------------------------------------------------------------------
// HTML → blocks

/** Block comment attributes, serialized the way the block editor does (no "--" or "<" inside comments). */
export function serializeAttrs(a: Record<string, any>): string {
  const keys = Object.keys(a).filter((k) => a[k] !== undefined);
  if (!keys.length) return '';
  const json = JSON.stringify(Object.fromEntries(keys.map((k) => [k, a[k]])))
    .replace(/--/g, '\\u002d\\u002d').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\\"/g, '\\u0022');
  return ' ' + json;
}

function wrap(name: string, html: string, attrs: Record<string, any> = {}): string {
  return `<!-- wp:${name}${serializeAttrs(attrs)} -->\n${html}\n<!-- /wp:${name} -->`;
}

const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins', 'font', 'strike', 'tt', 'big', 'label']);

function isInline(n: Node): boolean {
  if (n.nodeType === 3) return true;
  if (n.nodeType !== 1) return false;
  const t = (n as Element).tagName.toLowerCase();
  if (t === 'img') return true;
  return INLINE.has(t);
}

function textAlign(el: Element): string | undefined {
  const m = /text-align\s*:\s*(left|center|right)/i.exec(el.getAttribute('style') || '') || /^(left|center|right)$/i.exec(el.getAttribute('align') || '');
  return m ? m[1].toLowerCase() : undefined;
}

function classAttr(el: Element, extra: string): string {
  const own = (el.getAttribute('class') || '').trim();
  return ` class="${escA([extra, own].filter(Boolean).join(' '))}"`;
}

/** Other attributes of an element, minus class (kept as they are). */
function otherAttrs(el: Element, skip: string[] = []): string {
  return [...el.attributes].filter((a) => a.name !== 'class' && !skip.includes(a.name)).map((a) => ` ${a.name}="${escA(a.value)}"`).join('');
}

function isButtonLink(el: Element): boolean {
  return el.tagName === 'A' && /\b(btn|button|wp-block-button__link)\b/i.test(el.getAttribute('class') || '');
}

function imageBlock(img: Element, link: Element | null, caption: string): string {
  const align = /\b(alignleft|alignright|aligncenter)\b/.exec(img.getAttribute('class') || '')?.[1]?.replace('align', '');
  const attrs: Record<string, any> = { sizeSlug: 'large' };
  if (align) attrs.align = align;
  if (link) attrs.linkDestination = 'custom';
  const imgTag = `<img src="${escA(img.getAttribute('src') || '')}" alt="${escA(img.getAttribute('alt') || '')}"${img.getAttribute('width') ? ` width="${escA(img.getAttribute('width'))}"` : ''}${img.getAttribute('height') ? ` height="${escA(img.getAttribute('height'))}"` : ''}/>`;
  const body = link ? `<a href="${escA(link.getAttribute('href') || '')}">${imgTag}</a>` : imgTag;
  const cap = caption.trim() ? `<figcaption class="wp-element-caption">${caption.trim()}</figcaption>` : '';
  return wrap('image', `<figure class="wp-block-image size-large${align ? ' align' + align : ''}">${body}${cap}</figure>`, attrs);
}

function onlyChild(el: Element): Element | null {
  const kids = [...el.childNodes].filter((n) => !(n.nodeType === 3 && !n.textContent!.trim()) && n.nodeType !== 8);
  return kids.length === 1 && kids[0].nodeType === 1 ? (kids[0] as Element) : null;
}

function listBlock(el: Element): string {
  const ordered = el.tagName === 'OL';
  const items = [...el.children].filter((c) => c.tagName === 'LI').map((li) => {
    const nested = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
    const clone = li.cloneNode(true) as Element;
    for (const n of [...clone.children]) if (n.tagName === 'UL' || n.tagName === 'OL') n.remove();
    const inner = clone.innerHTML.trim() + nested.map((n) => '\n' + listBlock(n)).join('');
    return wrap('list-item', `<li>${inner}</li>`);
  });
  const attrs: Record<string, any> = {};
  if (ordered) attrs.ordered = true;
  if (ordered && el.getAttribute('start')) attrs.start = Number(el.getAttribute('start'));
  const tag = ordered ? 'ol' : 'ul';
  return wrap('list', `<${tag}${classAttr(el, 'wp-block-list')}>${items.join('\n')}</${tag}>`, attrs);
}

function nodeToBlocks(n: Node, out: string[], para: Node[]): void {
  void para;
  if (n.nodeType === 8) return;
  const el = n as Element;
  const tag = el.tagName.toLowerCase();
  const align = textAlign(el);
  switch (tag) {
    case 'p': {
      const only = onlyChild(el);
      if (only && only.tagName === 'IMG') { out.push(imageBlock(only, null, '')); return; }
      if (only && only.tagName === 'A' && onlyChild(only)?.tagName === 'IMG') { out.push(imageBlock(onlyChild(only)!, only, '')); return; }
      if (el.children.length && [...el.childNodes].every((c) => (c.nodeType === 3 && !c.textContent!.trim()) || (c.nodeType === 1 && isButtonLink(c as Element)))) { out.push(buttonsBlock([...el.children])); return; }
      if (!el.innerHTML.trim()) return;
      out.push(wrap('paragraph', `<p${align ? ` class="has-text-align-${align}"` : ''}>${el.innerHTML.trim()}</p>`, align ? { align } : {}));
      return;
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = Number(tag[1]);
      const attrs: Record<string, any> = {};
      if (level !== 2) attrs.level = level;
      if (align) attrs.textAlign = align;
      const id = el.getAttribute('id');
      out.push(wrap('heading', `<${tag}${id ? ` id="${escA(id)}"` : ''} class="wp-block-heading${align ? ' has-text-align-' + align : ''}">${el.innerHTML.trim()}</${tag}>`, attrs));
      return;
    }
    case 'ul': case 'ol': out.push(listBlock(el)); return;
    case 'img': out.push(imageBlock(el, null, '')); return;
    case 'figure': {
      const img = el.querySelector('img');
      const table = el.querySelector('table');
      const cap = el.querySelector('figcaption')?.innerHTML || '';
      if (table) { out.push(tableBlock(table, cap)); return; }
      if (img && el.querySelectorAll('img').length === 1) { const a = img.parentElement?.tagName === 'A' ? img.parentElement : null; out.push(imageBlock(img, a, cap)); return; }
      if (el.querySelector('blockquote')) { nodeToBlocks(el.querySelector('blockquote')!, out, []); return; }
      out.push(wrap('html', el.outerHTML));
      return;
    }
    case 'blockquote': {
      const inner: string[] = [];
      const cite = el.querySelector(':scope > cite, :scope > footer');
      const clone = el.cloneNode(true) as Element;
      clone.querySelector(':scope > cite, :scope > footer')?.remove();
      convertChildren(clone, inner);
      out.push(wrap('quote', `<blockquote class="wp-block-quote">${inner.join('\n')}${cite ? `<cite>${cite.innerHTML.trim()}</cite>` : ''}</blockquote>`));
      return;
    }
    case 'pre': {
      const code = onlyChild(el);
      if (code && code.tagName === 'CODE') out.push(wrap('code', `<pre class="wp-block-code"><code>${code.innerHTML}</code></pre>`));
      else out.push(wrap('preformatted', `<pre class="wp-block-preformatted">${el.innerHTML}</pre>`));
      return;
    }
    case 'table': out.push(tableBlock(el, el.querySelector('caption')?.innerHTML || '')); return;
    case 'hr': out.push(wrap('separator', '<hr class="wp-block-separator has-alpha-channel-opacity"/>')); return;
    case 'a':
      if (isButtonLink(el)) { out.push(buttonsBlock([el])); return; }
      out.push(wrap('paragraph', `<p>${el.outerHTML}</p>`));
      return;
    case 'button': out.push(wrap('html', el.outerHTML)); return;
    case 'br': return;
    case 'video': {
      const src = el.getAttribute('src') || el.querySelector('source')?.getAttribute('src');
      if (src) { out.push(wrap('video', `<figure class="wp-block-video"><video controls src="${escA(src)}"></video></figure>`)); return; }
      out.push(wrap('html', el.outerHTML));
      return;
    }
    case 'div': case 'section': case 'article': case 'header': case 'footer': case 'main': case 'aside': case 'nav': {
      if (tag === 'nav' || el.querySelector('form, script, iframe, canvas, svg, input, select, textarea')) { out.push(wrap('html', el.outerHTML)); return; }
      const kids = [...el.children];
      const cls = el.getAttribute('class') || '';
      if (kids.length && kids.every(isButtonLink)) { out.push(buttonsBlock(kids)); return; }
      // Grid rows become columns.
      if (kids.length >= 2 && /\b(row|columns|grid|wp-block-columns)\b/.test(cls) && kids.every((k) => /\b(col(-[\w-]+)?|column|wp-block-column|cell)\b/.test(k.getAttribute('class') || ''))) {
        const cols = kids.map((k) => { const inner: string[] = []; convertChildren(k, inner); return wrap('column', `<div class="wp-block-column">${inner.join('\n')}</div>`); });
        out.push(wrap('columns', `<div class="wp-block-columns">${cols.join('\n')}</div>`));
        return;
      }
      const inner: string[] = [];
      convertChildren(el, inner);
      if (!inner.length) return;
      const attrs: Record<string, any> = { layout: { type: 'constrained' } };
      if (tag !== 'div') attrs.tagName = tag;
      const own = cls.trim();
      if (own) attrs.className = own;
      const id = el.getAttribute('id');
      out.push(wrap('group', `<${tag}${id ? ` id="${escA(id)}"` : ''} class="wp-block-group${own ? ' ' + escA(own) : ''}">${inner.join('\n')}</${tag}>`, attrs));
      return;
    }
    default:
      out.push(wrap('html', el.outerHTML));
  }
}

function buttonsBlock(links: Element[]): string {
  const btns = links.map((a) => wrap('button', `<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="${escA(a.getAttribute('href') || '#')}"${otherAttrs(a, ['href', 'style'])}>${a.innerHTML.trim()}</a></div>`));
  return wrap('buttons', `<div class="wp-block-buttons">${btns.join('\n')}</div>`);
}

function tableBlock(table: Element, caption: string): string {
  const t = table.cloneNode(true) as Element;
  t.querySelector('caption')?.remove();
  const cap = caption.trim() ? `<figcaption class="wp-element-caption">${caption.trim()}</figcaption>` : '';
  return wrap('table', `<figure class="wp-block-table"><table${otherAttrs(t, ['style', 'width', 'border', 'cellpadding', 'cellspacing'])}>${t.innerHTML.trim()}</table>${cap}</figure>`);
}

function convertChildren(parent: Element, out: string[]): void {
  let run: Node[] = [];
  const flush = () => {
    const html = run.map((n) => (n.nodeType === 3 ? escT(n.textContent) : (n as Element).outerHTML)).join('').trim();
    run = [];
    if (!html) return;
    const tmp = parent.ownerDocument.createElement('p');
    tmp.innerHTML = html;
    nodeToBlocks(tmp, out, []);
  };
  for (const n of [...parent.childNodes]) {
    if (isInline(n)) { run.push(n); continue; }
    flush();
    nodeToBlocks(n, out, []);
  }
  flush();
}

/** Converts HTML (a page's content) to block markup. Anything without a matching core block becomes a Custom HTML block. */
export function htmlToBlocks(html: string): string {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
  const out: string[] = [];
  convertChildren(doc.body, out);
  return out.join('\n\n') + (out.length ? '\n' : '');
}
