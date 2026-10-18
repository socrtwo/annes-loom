/**
 * A compact Markdown → HTML converter (CommonMark-like, with GitHub tables and strikethrough):
 * ATX and setext headings, paragraphs, emphasis, code spans and fenced/indented code blocks, links and
 * images (inline and reference), autolinks, nested lists (including task items), block quotes,
 * thematic breaks, tables, hard line breaks and raw HTML. YAML front matter gives the title.
 */
import { blankPage, esc, escAttr } from '../model/html';

export function markdownToHtml(md: string): string {
  const refs = new Map<string, { url: string; title?: string }>();
  const src = md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/gm, (m, label: string, url: string, t1, t2, t3) => {
    refs.set(label.toLowerCase().replace(/\s+/g, ' '), { url, title: t1 ?? t2 ?? t3 });
    return '';
  });
  return blocks(src.split('\n'), refs).trim() + '\n';
}

const HTML_BLOCK = /^ {0,3}<(?:\/?(?:address|article|aside|blockquote|details|dialog|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|iframe|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|video|audio|picture|script|style|center)\b|!--)/i;
const LIST_RE = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)/;

function blocks(lines: string[], refs: Map<string, { url: string; title?: string }>): string {
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join('\n').trim(), refs)}</p>`); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code.
    const fence = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/.exec(line);
    if (fence) {
      flush();
      const close = new RegExp(`^ {0,3}${fence[2][0]}{${fence[2].length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) { body.push(lines[i].replace(new RegExp(`^ {0,${fence[1].length}}`), '')); i++; }
      i++;
      out.push(`<pre><code${fence[3] ? ` class="language-${escAttr(fence[3])}"` : ''}>${esc(body.join('\n'))}${body.length ? '\n' : ''}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    // Indented code (not inside a paragraph).
    if (/^ {4}/.test(line) && !para.length) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) { body.push(lines[i].slice(4)); i++; }
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out.push(`<pre><code>${esc(body.join('\n'))}\n</code></pre>`);
      continue;
    }
    // ATX heading.
    const h = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}${idAttr(h[2] || '')}>${inline(h[2] || '', refs)}</h${h[1].length}>`); i++; continue; }
    // Setext heading.
    if (para.length && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      const level = line.trim()[0] === '=' ? 1 : 2;
      const text = para.join('\n').trim();
      para = [];
      out.push(`<h${level}${idAttr(text)}>${inline(text, refs)}</h${level}>`);
      i++;
      continue;
    }
    // Thematic break.
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    // Block quote.
    if (/^ {0,3}>/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || (lines[i].trim() && body.length && !LIST_RE.test(lines[i]) && !/^ {0,3}(#|```|~~~)/.test(lines[i])))) { body.push(lines[i].replace(/^ {0,3}> ?/, '')); i++; }
      out.push(`<blockquote>\n${blocks(body, refs)}\n</blockquote>`);
      continue;
    }
    // Table (GFM).
    if (line.includes('|') && i + 1 < lines.length && /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
      const al = (k: number) => (align[k] ? ` style="text-align: ${align[k]}"` : '');
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      out.push(`<table>\n<thead>\n<tr>${head.map((c, k) => `<th${al(k)}>${inline(c, refs)}</th>`).join('')}</tr>\n</thead>${rows.length ? `\n<tbody>\n${rows.map((r) => `<tr>${head.map((_, k) => `<td${al(k)}>${inline(r[k] ?? '', refs)}</td>`).join('')}</tr>`).join('\n')}\n</tbody>` : ''}\n</table>`);
      continue;
    }
    // Lists.
    const lm = LIST_RE.exec(line);
    if (lm && !(para.length && /^\d/.test(lm[2]) && !/^1[.)]/.test(lm[2]))) {
      flush();
      const ordered = /\d/.test(lm[2]);
      const marker = lm[2].slice(-1);
      const start = ordered ? parseInt(lm[2], 10) : 1;
      const items: { lines: string[]; loose: boolean }[] = [];
      let loose = false;
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m || /\d/.test(m[2]) !== ordered || m[2].slice(-1) !== marker) break;
        const indent = m[1].length + m[2].length + (m[3].length > 4 ? 1 : Math.max(1, m[3].length));
        const item = [lines[i].slice(indent)];
        i++;
        let blank = false;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) { blank = true; item.push(''); i++; continue; }
          const ind = /^ */.exec(l)![0].length;
          if (ind >= indent) { if (blank) loose = true; blank = false; item.push(l.slice(indent)); i++; continue; }
          if (!blank && !LIST_RE.test(l) && !/^ {0,3}(#|>|```|~~~|([-*_])(\s*\2){2,}\s*$)/.test(l)) { item.push(l.trim()); i++; continue; }
          break;
        }
        while (item.length && !item[item.length - 1].trim()) item.pop();
        const nx = i < lines.length ? LIST_RE.exec(lines[i]) : null;
        if (blank && nx && /\d/.test(nx[2]) === ordered && nx[2].slice(-1) === marker) loose = true;
        items.push({ lines: item, loose });
      }
      const tag = ordered ? 'ol' : 'ul';
      const lis = items.map((it) => {
        let body = blocks(it.lines, refs).trim();
        if (!loose) body = body.replace(/^<p>([\s\S]*?)<\/p>/, '$1').replace(/<p>([\s\S]*?)<\/p>(?=\n?<(ul|ol)>)/g, '$1');
        body = body.replace(/^(<p>)?\[([ xX])\]\s+/, (m, p: string | undefined, x: string) => `${p || ''}<input type="checkbox" disabled${x !== ' ' ? ' checked' : ''}> `);
        return `<li>${body}</li>`;
      });
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>\n${lis.join('\n')}\n</${tag}>`);
      continue;
    }
    // Raw HTML block.
    if (HTML_BLOCK.test(line) && !para.length) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim()) { body.push(lines[i]); i++; }
      out.push(body.join('\n'));
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

function idAttr(text: string): string {
  const id = text.toLowerCase().replace(/<[^>]+>|[`*_~[\]()]/g, '').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
  return id ? ` id="${escAttr(id)}"` : '';
}

function inline(text: string, refs: Map<string, { url: string; title?: string }>): string {
  const keep: string[] = [];
  const stash = (html: string) => { keep.push(html); return `\u0001${keep.length - 1}\u0001`; };
  let s = text;
  // Escapes.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (m, c) => stash(esc(c)));
  // Code spans.
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, code: string) => stash(`<code>${esc(code.replace(/^ (.*) $/, '$1'))}</code>`));
  // Autolinks.
  s = s.replace(/<((?:https?|ftp|mailto):[^\s<>]+)>/gi, (m, url) => stash(`<a href="${escAttr(url)}">${esc(url.replace(/^mailto:/, ''))}</a>`));
  s = s.replace(/<([\w.+-]+@[\w-]+\.[\w.-]+)>/g, (m, mail) => stash(`<a href="mailto:${escAttr(mail)}">${esc(mail)}</a>`));
  // Raw inline HTML is kept.
  s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<!--[\s\S]*?-->/g, (m) => stash(m));
  // Images and links (inline and reference).
  const link = (label: string, url: string, title: string | undefined, img: boolean) => {
    const t = title ? ` title="${escAttr(title)}"` : '';
    return img ? stash(`<img src="${escAttr(url)}" alt="${escAttr(label.replace(/[*_`]/g, ''))}"${t}>`) : stash(`<a href="${escAttr(url)}"${t}>${inline(label, refs)}</a>`);
  };
  s = s.replace(/(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g, (m, bang, label, url, t1, t2) => link(label, url, t1 ?? t2, !!bang));
  s = s.replace(/(!?)\[((?:[^[\]]|\[[^\]]*\])*)\](?:\[([^\]]*)\])?/g, (m, bang, label: string, ref: string | undefined) => {
    const r = refs.get((ref || label).toLowerCase().replace(/\s+/g, ' '));
    return r ? link(label, r.url, r.title, !!bang) : m;
  });
  s = esc(s).replace(/&amp;(#?\w+;)/g, '&$1');
  // Emphasis.
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  s = s.replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^\w_])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  // Hard breaks.
  s = s.replace(/( {2,}|\\)\n/g, '<br>\n');
  return s.replace(/\u0001(\d+)\u0001/g, (m, k) => keep[+k]).replace(/\u0001(\d+)\u0001/g, (m, k) => keep[+k]);
}

/** A page from a Markdown document: front matter title, else the first heading, else the file name. */
export function markdownToPage(md: string, fileName = 'Document'): { html: string; title: string; body: string } {
  let text = md;
  let title = '';
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n?/g, '\n'));
  if (fm) {
    title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])?.[1] || '';
    text = text.replace(/\r\n?/g, '\n').slice(fm[0].length);
  }
  const body = markdownToHtml(text);
  if (!title) title = (/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(body)?.[1] || '').replace(/<[^>]+>/g, '') || fileName.replace(/\.(md|markdown|mdown|txt)$/i, '');
  return { html: blankPage({ title, body }), title, body };
}
