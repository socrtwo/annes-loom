/**
 * Cleans HTML written by word processors (Word's "Web Page" / "Web Page, Filtered", and HTML copied from
 * Word or Google Docs) into plain, editable HTML: Office namespaces (o:p, w:, v:, m:), conditional comments,
 * the Mso style block and classes, mso-* style properties, empty spans and font tags go; Word list
 * paragraphs become real lists; bold/italic spans become <strong>/<em>.
 */
import { blankPage, getTitle } from '../model/html';

export function isWordHtml(html: string): boolean {
  return /urn:schemas-microsoft-com:office|class=["']?Mso|mso-|<o:p>|docs-internal-guid|ProgId\s+content=["']?Word/i.test(html.slice(0, 200000));
}

const KEEP_STYLE = /^(font-weight|font-style|text-decoration|text-decoration-line|text-align|color|background|background-color|vertical-align|list-style-type|width|height)$/i;

export function cleanWordHtml(html: string, opts: { keepStyles?: boolean } = {}): { html: string; body: string; title: string; report: string[] } {
  const report: string[] = [];
  const counts: Record<string, number> = {};
  const count = (k: string, n = 1) => { counts[k] = (counts[k] || 0) + n; };
  let s = html;
  // Lists: keep the bullet text Word hides in <![if !supportLists]> so the list kind can be guessed.
  s = s.replace(/<!--\[if !supportLists\]-->([\s\S]*?)<!--\[endif\]-->/gi, '<span data-ql-bullet="1">$1</span>');
  s = s.replace(/<!\[if !supportLists\]>([\s\S]*?)<!\[endif\]>/gi, '<span data-ql-bullet="1">$1</span>');
  s = s.replace(/<!--\[if [^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, () => { count('conditional comments'); return ''; });
  s = s.replace(/<!\[if [^\]]*\]>([\s\S]*?)<!\[endif\]>/gi, '$1');
  s = s.replace(/<xml\b[\s\S]*?<\/xml>/gi, () => { count('Office XML blocks'); return ''; });
  s = s.replace(/<\/?o:p\s*>/gi, '');
  s = s.replace(/<v:[\w-]+\b[\s\S]*?<\/v:[\w-]+>|<v:[\w-]+\b[^>]*\/>/gi, () => { count('VML drawings (shapes)'); return ''; });
  s = s.replace(/<\/?(?:w|m|st1|o):[\w-]+\b[^>]*>/gi, '');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, () => { count('style blocks'); return ''; });
  s = s.replace(/<meta\b[^>]*(?:ProgId|Generator|Originator)[^>]*>/gi, '').replace(/<link\b[^>]*rel\s*=\s*["']?(?:File-List|Edit-Time-Data|themeData|colorSchemeMapping|Original-File)[^>]*>/gi, '');
  const title = getTitle(s);
  const doc = new DOMParser().parseFromString(s, 'text/html');
  const body = doc.body;
  // Google Docs wraps everything in <b id="docs-internal-guid-…" style="font-weight:normal">.
  for (const b of [...body.querySelectorAll('b[id^="docs-internal-guid"]')]) unwrap(b);
  // Spans that mean bold/italic.
  for (const sp of [...body.querySelectorAll('span[style]')]) {
    const st = sp.getAttribute('style') || '';
    const bold = /font-weight\s*:\s*(bold|[6-9]00)/i.test(st);
    const ital = /font-style\s*:\s*italic/i.test(st);
    if (bold || ital) {
      let inner: Element = sp;
      if (ital) { const em = doc.createElement('em'); moveKids(inner, em); inner.appendChild(em); inner = em; }
      if (bold) { const st2 = doc.createElement('strong'); moveKids(inner, st2); inner.appendChild(st2); }
    }
  }
  for (const el of [...body.querySelectorAll('b')]) rename(el, 'strong');
  for (const el of [...body.querySelectorAll('i')]) rename(el, 'em');
  // Word lists.
  convertLists(body, count);
  // Attributes.
  for (const el0 of [...body.querySelectorAll('*')]) {
    let el = el0;
    const cls = el.getAttribute('class');
    if (cls != null) {
      const m = /^Mso(Title|Subtitle|Heading(\d))/.exec(cls);
      if (m && el.tagName === 'P') { const level = m[2] ? Math.min(6, +m[2]) : m[1] === 'Title' ? 1 : 2; el = rename(el, `h${level}`); }
      const keep = cls.split(/\s+/).filter((c) => c && !/^Mso|^western$|^c\d+$/.test(c));
      if (keep.length) el.setAttribute('class', keep.join(' ')); else el.removeAttribute('class');
      if (/Mso|c\d/.test(cls)) count('Office classes');
    }
    const st = el.getAttribute('style');
    if (st != null) {
      const kept = opts.keepStyles === false ? [] : st.split(';').map((d) => d.trim()).filter(Boolean).filter((d) => {
        const [p, v = ''] = d.split(':').map((x) => x.trim());
        if (!KEEP_STYLE.test(p) || /mso|windowtext|auto$/i.test(v)) return false;
        if (/^(color)$/i.test(p) && /^(black|#000(000)?|rgb\(0,\s*0,\s*0\))$/i.test(v)) return false;
        if (/^background(-color)?$/i.test(p) && /^(transparent|white|#fff(fff)?)$/i.test(v)) return false;
        if (/^(font-weight|font-style)$/i.test(p) && (/^(normal|400)$/i.test(v) || el.tagName === 'SPAN')) return false;
        if (/^(width|height)$/i.test(p) && !/^(IMG|TABLE|TD|TH)$/.test(el.tagName)) return false;
        if (/^text-align$/i.test(p) && /^(left|start)$/i.test(v)) return false;
        if (/^text-decoration(-line)?$/i.test(p) && /^none$/i.test(v)) return false;
        if (/^vertical-align$/i.test(p) && /^baseline$/i.test(v)) return false;
        return true;
      });
      if (kept.length < st.split(';').filter((x) => x.trim()).length) count('Office style properties');
      if (kept.length) el.setAttribute('style', kept.map((d) => d.replace(/\s*:\s*/, ': ')).join('; ')); else el.removeAttribute('style');
    }
    for (const a of ['lang', 'xml:lang', 'dir', 'align', 'valign', 'nowrap', 'border', 'cellspacing', 'cellpadding', 'width', 'height', 'bgcolor', 'link', 'vlink', 'clear', 'data-ql-bullet']) {
      if (a === 'dir' && el.getAttribute('dir') === 'rtl') continue;
      if ((a === 'width' || a === 'height') && el.tagName === 'IMG') continue;
      if (a === 'align' && /^(center|right)$/i.test(el.getAttribute('align') || '') && /^(P|H\d|DIV)$/.test(el.tagName)) { el.setAttribute('style', `${el.getAttribute('style') ? el.getAttribute('style') + '; ' : ''}text-align: ${el.getAttribute('align')!.toLowerCase()}`); }
      if (a === 'border' && el.tagName === 'TABLE') continue;
      el.removeAttribute(a);
    }
    for (const a of [...el.attributes]) if (/^(v:|o:|w:)|^(id)$/.test(a.name) && (a.name !== 'id' || /^_(Toc|Hlk|GoBack|Ref)/.test(a.value))) el.removeAttribute(a.name);
  }
  // Empty anchors Word uses as bookmarks, font tags, bare spans, divs Word adds for sections.
  for (const a of [...body.querySelectorAll('a[name]:not([href])')]) { if (!a.textContent?.trim()) a.remove(); else unwrap(a); }
  for (const el of [...body.querySelectorAll('font')]) { unwrap(el); count('font tags'); }
  for (const el of [...body.querySelectorAll('span')]) if (!el.attributes.length) unwrap(el);
  for (const el of [...body.querySelectorAll('div.WordSection1, div.Section1, div[class^="WordSection"]')]) unwrap(el);
  for (const el of [...body.querySelectorAll('div')]) if (!el.attributes.length && el.parentElement === body) unwrap(el);
  // Empty paragraphs (Word uses &nbsp; paragraphs as spacing).
  for (const p of [...body.querySelectorAll('p, h1, h2, h3, h4, h5, h6')]) if (!p.textContent?.replace(/ /g, '').trim() && !p.querySelector('img, br, iframe, object')) { p.remove(); count('empty paragraphs'); }
  // Pictures saved next to the document.
  const imgs = [...body.querySelectorAll('img')].map((i) => i.getAttribute('src') || '').filter((x) => x && !/^(https?:|data:)/.test(x));
  if (imgs.length) report.push(`${imgs.length} picture(s) point at files saved next to the document (${imgs.slice(0, 4).join(', ')}${imgs.length > 4 ? ', …' : ''}); import that folder too, or the pictures will be missing.`);
  let out = body.innerHTML.replace(/ /g, '&nbsp;').replace(/(&nbsp;\s*){2,}/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/<p>\s*(&nbsp;)?\s*<\/p>/g, '').trim();
  out = out.replace(/(<\/(?:p|h[1-6]|ul|ol|li|table|tr|blockquote|div)>)\s*/g, '$1\n');
  const removed = Object.entries(counts).map(([k, n]) => `${k} (${n})`);
  if (removed.length) report.unshift(`Removed: ${removed.join(', ')}.`);
  return { html: blankPage({ title: title || 'Document', body: out }), body: out, title: title || 'Document', report };
}

function unwrap(el: Element): void { const p = el.parentNode; if (!p) return; while (el.firstChild) p.insertBefore(el.firstChild, el); el.remove(); }
function moveKids(from: Element, to: Element): void { while (from.firstChild) to.appendChild(from.firstChild); }
function rename(el: Element, tag: string): Element {
  const n = el.ownerDocument.createElement(tag);
  for (const a of el.attributes) n.setAttribute(a.name, a.value);
  moveKids(el, n);
  el.replaceWith(n);
  return n;
}

/** Word's list paragraphs (style="mso-list:l0 level1 lfo1") → <ul>/<ol> with nesting. */
function convertLists(body: HTMLElement, count: (k: string, n?: number) => void): void {
  const isItem = (el: Element | null): el is HTMLElement => !!el && el.tagName === 'P' && (/mso-list\s*:\s*l\d+\s+level\d+/i.test(el.getAttribute('style') || '') || /MsoListParagraph/i.test(el.getAttribute('class') || ''));
  const doc = body.ownerDocument;
  for (const start of [...body.querySelectorAll('p')]) {
    if (!start.isConnected || !isItem(start) || isItem(start.previousElementSibling)) continue;
    const run: HTMLElement[] = [];
    let cur: Element | null = start;
    while (isItem(cur)) { run.push(cur); cur = cur.nextElementSibling; }
    const stack: { list: HTMLElement; level: number }[] = [];
    const anchor = doc.createElement('div');
    start.before(anchor);
    let top: HTMLElement | null = null;
    for (const p of run) {
      const level = Number(/level(\d+)/i.exec(p.getAttribute('style') || '')?.[1] || 1);
      const bullet = p.querySelector('[data-ql-bullet]');
      const btext = (bullet?.textContent || '').replace(/ /g, ' ').trim();
      bullet?.remove();
      const ordered = /^(\(?[0-9]+[.)]|\(?[a-z][.)]|\(?[ivxlc]+[.)])/i.test(btext);
      while (stack.length && stack[stack.length - 1].level > level) stack.pop();
      if (!stack.length || stack[stack.length - 1].level < level) {
        const list = doc.createElement(ordered ? 'ol' : 'ul');
        if (stack.length) { const lastLi = stack[stack.length - 1].list.lastElementChild || stack[stack.length - 1].list.appendChild(doc.createElement('li')); lastLi.appendChild(list); }
        else { top = list; anchor.appendChild(list); }
        stack.push({ list, level });
      }
      const li = doc.createElement('li');
      moveKids(p, li);
      li.innerHTML = li.innerHTML.replace(/^(\s|&nbsp;)+/, '');
      stack[stack.length - 1].list.appendChild(li);
      p.remove();
    }
    if (top) anchor.replaceWith(top); else anchor.remove();
    count('Word list paragraphs converted to lists', run.length);
  }
}
