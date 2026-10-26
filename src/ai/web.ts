/**
 * Prompts and response parsing for the web-site AI features. Everything here is pure text handling
 * (no network, no editor state), so it can be unit-tested: code-fence stripping, tolerant JSON parsing,
 * page and fragment extraction, site plans, the shared navigation, a line diff for previews, and the
 * prompt builders the AI commands send.
 */
import { slugify, relativeRef, normalizePath } from '../model/paths';
import { esc, escAttr, blankPage, headInsert } from '../model/html';

export const WEB_SYSTEM = 'You are a web design and front-end development assistant inside Anne\'s Loom, a web site editor. Write valid, semantic, accessible HTML5 and modern CSS (no frameworks unless asked). Use American English unless told otherwise. Follow the format instructions exactly. Do not add commentary before or after the requested output unless asked.';

// ------------------------------------------------------------------------------------------
// Code fences

export interface CodeBlock { lang: string; code: string }

/**
 * Every fenced code block (``` or ~~~, any length ≥ 3) in a model answer. An unclosed fence (a cut-off
 * answer) runs to the end of the text.
 */
export function codeBlocks(s: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  const lines = String(s ?? '').replace(/\r\n?/g, '\n').split('\n');
  let open: { fence: string; lang: string; body: string[] } | null = null;
  for (const line of lines) {
    if (!open) {
      const m = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/.exec(line);
      if (m) {
        open = { fence: m[1], lang: m[2].toLowerCase(), body: [] };
        continue;
      }
      // A one-line fence: ```html <p>Hi</p>```
      const one = /^\s*(`{3,})([\w+#.-]*)\s+([\s\S]*?)\1\s*$/.exec(line);
      if (one) out.push({ lang: one[2].toLowerCase(), code: one[3].trim() });
      continue;
    }
    const close = new RegExp(`^\\s{0,3}${open.fence[0] === '`' ? '`' : '~'}{${open.fence.length},}\\s*$`);
    if (close.test(line)) { out.push({ lang: open.lang, code: open.body.join('\n') }); open = null; continue; }
    open.body.push(line);
  }
  if (open && open.body.join('').trim()) out.push({ lang: open.lang, code: open.body.join('\n') });
  return out;
}

const LANG_ALIASES: Record<string, string> = { htm: 'html', xhtml: 'html', xml: 'html', svg: 'svg', javascript: 'js', mjs: 'js', jsx: 'js', ts: 'js', typescript: 'js', scss: 'css', less: 'css', jsonld: 'json', 'json-ld': 'json', md: 'markdown' };
export const normLang = (l: string) => LANG_ALIASES[l.toLowerCase()] ?? l.toLowerCase();

/**
 * The code in a model answer without Markdown fences. With several blocks, the first in a preferred
 * language wins, else the longest. Without fences, stray fence lines and a "Here is…:" preamble are removed.
 */
export function stripFences(s: string, prefer: string[] = []): string {
  const text = String(s ?? '');
  const blocks = codeBlocks(text);
  if (blocks.length) {
    const want = prefer.map(normLang);
    const hit = want.length ? blocks.find((b) => want.includes(normLang(b.lang))) : undefined;
    const pick = hit || [...blocks].sort((a, b) => b.code.length - a.code.length)[0];
    return pick.code.trim();
  }
  return stripPreamble(text.replace(/^\s*(`{3,}|~{3,})[\w+#.-]*\s*$/gm, '')).trim();
}

/** Removes a chatty first line ("Sure! Here is the section:") when markup follows. */
export function stripPreamble(s: string): string {
  return s.replace(/^\s*(?:(?:sure|certainly|of course|okay|ok)[!,.]?\s*)?(?:here(?:'s| is| are)|below is|the (?:revised|updated|corrected|translated|rewritten)[^\n:]*)[^\n<]*:\s*\n(?=\s*<)/i, '');
}

/** Text answers: no fences, no surrounding quotes. */
export function cleanText(s: string): string {
  const raw = String(s ?? '');
  const whole = /^\s*(`{3,}|~{3,})[\w+#.-]*[ \t]*\n([\s\S]*?)(?:\n[ \t]*\1[ \t]*)?\s*$/.exec(raw);
  const t = whole && !whole[2].includes(whole[1]) ? whole[2] : raw.replace(/^\s*(`{3,}|~{3,})[\w+#.-]*\s*$/gm, '');
  return t.trim().replace(/^"""\s*|\s*"""$/g, '').replace(/^"([^"\n]*)"$/, '$1').trim();
}

/** Lines of a list answer without bullets or numbers. */
export function linesOf(s: string): string[] {
  return cleanText(s).split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '').replace(/^\*\*(.*)\*\*$/, '$1').trim()).filter(Boolean);
}

// ------------------------------------------------------------------------------------------
// JSON

/** The first balanced JSON value ({…} or […]) in a text, honoring strings. */
export function findJsonSpan(t: string, from = 0): [number, number] | null {
  for (let start = from; start < t.length; start++) {
    const c = t[start];
    if (c !== '{' && c !== '[') continue;
    const stack: string[] = [];
    let inStr = false, escp = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (escp) escp = false;
        else if (ch === '\\') escp = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') {
        if (stack.pop() !== ch) break;
        if (!stack.length) return [start, i + 1];
      }
    }
  }
  return null;
}

/** Repairs common model JSON slips: trailing commas, smart quotes around keys. */
function repairJson(t: string): string {
  return t.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"');
}

/** Parses JSON that may be wrapped in prose or code fences. Returns null when there is none. */
export function parseJsonLoose<T = any>(s: string): T | null {
  const raw = String(s ?? '');
  const candidates = [stripFences(raw, ['json']), raw];
  for (const t of candidates) {
    for (const x of [t.trim(), repairJson(t.trim())]) { try { return JSON.parse(x); } catch { /* look inside */ } }
    let from = 0;
    for (let n = 0; n < 8; n++) {
      const span = findJsonSpan(t, from);
      if (!span) break;
      const piece = t.slice(span[0], span[1]);
      for (const x of [piece, repairJson(piece)]) { try { return JSON.parse(x); } catch { /* next */ } }
      from = span[0] + 1;
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// Pages and fragments

export interface ExtractedPage { html: string; css: string; js: string; title: string }

/** A whole HTML document in a model answer (fenced or not), or ''. */
export function findDocument(s: string): string {
  const blocks = codeBlocks(s);
  const pool = [...blocks.filter((b) => ['html', ''].includes(normLang(b.lang))).map((b) => b.code), ...blocks.map((b) => b.code), String(s ?? '')];
  for (const t of pool) {
    const start = t.search(/<!DOCTYPE\s+html|<html[\s>]/i);
    if (start < 0) continue;
    const endM = [...t.matchAll(/<\/html\s*>/gi)].pop();
    const end = endM ? endM.index! + endM[0].length : t.length;
    return t.slice(start, end).trim() + (endM ? '' : '\n</body>\n</html>');
  }
  return '';
}

/**
 * A page from a "write a page" answer: the HTML document (or a fragment wrapped in one), plus the CSS and
 * JavaScript of separate ```css / ```js blocks.
 */
export function extractPage(s: string, opts: { title?: string; css?: string[] } = {}): ExtractedPage {
  const blocks = codeBlocks(s);
  const css = blocks.filter((b) => normLang(b.lang) === 'css').map((b) => b.code.trim()).join('\n\n');
  const js = blocks.filter((b) => normLang(b.lang) === 'js').map((b) => b.code.trim()).join('\n\n');
  let html = findDocument(s);
  if (!html) {
    const frag = extractFragment(s);
    const t = opts.title || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(frag)?.[1]?.replace(/<[^>]+>/g, '').trim() || 'New Page';
    html = blankPage({ title: t, css: opts.css || [], body: frag });
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || opts.title || '';
  return { html: html.endsWith('\n') ? html : html + '\n', css, js, title };
}

/**
 * An HTML fragment from an answer: fences and preamble removed; when the model sent a whole document,
 * its body content.
 */
export function extractFragment(s: string): string {
  let t = stripFences(s, ['html', 'svg']);
  if (/<html[\s>]|<body[\s>]/i.test(t)) {
    const b = /<body[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(t);
    if (b) t = b[1];
    else t = t.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '').replace(/<head[\s\S]*?<\/head>/i, '');
  }
  return t.trim();
}

/** An <svg> element from an answer, or ''. */
export function extractSvg(s: string): string {
  const t = stripFences(s, ['svg', 'xml', 'html']);
  const a = t.search(/<svg[\s>]/i);
  const e = t.toLowerCase().lastIndexOf('</svg>');
  if (a < 0 || e < a) return '';
  let svg = t.slice(a, e + 6);
  if (!/\sxmlns=/.test(svg.slice(0, svg.indexOf('>')))) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return stripActive(svg);
}

/** Removes scripts, event-handler attributes and javascript: URLs (for text results that should be plain markup). */
export function stripActive(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|action|formaction|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, ' $1="#"');
}

/** Rough check that a fragment's tags balance (used to warn before applying). */
export function unbalancedTags(html: string): string[] {
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
  const OPTIONAL = /^(p|li|dt|dd|tr|td|th|option|thead|tbody|tfoot|colgroup|caption|optgroup|rt|rp|head|body|html)$/i;
  const stack: string[] = [];
  const bad: string[] = [];
  const t = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|textarea|pre)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  for (const m of t.matchAll(/<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g)) {
    const name = m[2].toLowerCase();
    if (VOID.test(name) || m[3]) continue;
    if (!m[1]) { stack.push(name); continue; }
    const at = stack.lastIndexOf(name);
    if (at < 0) { bad.push(`</${name}>`); continue; }
    for (const left of stack.splice(at)) if (left !== name && !OPTIONAL.test(left)) bad.push(`<${left}>`);
  }
  for (const left of stack) if (!OPTIONAL.test(left)) bad.push(`<${left}>`);
  return bad;
}

// ------------------------------------------------------------------------------------------
// Site plans

export interface PlanPage { title: string; path: string; outline: string }
export interface SitePlan { name: string; description: string; pages: PlanPage[]; css: string; palette?: string }

/** Parses a site plan answer (JSON, possibly wrapped in prose); paths are normalized and unique. */
export function parseSitePlan(s: string, maxPages = 12): SitePlan | null {
  const j = parseJsonLoose<any>(s);
  const list: any[] | null = Array.isArray(j) ? j : Array.isArray(j?.pages) ? j.pages : null;
  if (!list) return null;
  const seen = new Set<string>();
  const pages: PlanPage[] = [];
  for (const [i, p] of list.entries()) {
    if (!p || typeof p !== 'object') continue;
    const title = String(p.title || p.name || '').trim();
    if (!title) continue;
    let path = String(p.path || p.file || p.filename || '').trim().replace(/^\/+/, '');
    if (!path || i === 0 && /^(home|index)/i.test(title)) path = i === 0 ? 'index.html' : '';
    if (!path) path = slugify(title) + '.html';
    path = normalizePath(path.replace(/[^\w./-]+/g, '-').toLowerCase());
    if (!/\.html?$/.test(path)) path = path.replace(/\/?$/, '') + (path.endsWith('/') ? '/index.html' : '.html');
    if (!path || path === '.html') path = slugify(title) + '.html';
    let unique = path, n = 2;
    while (seen.has(unique)) unique = path.replace(/(\.html?)$/, `-${n++}$1`);
    seen.add(unique);
    const outline = Array.isArray(p.outline) ? p.outline.map(String).join('\n') : Array.isArray(p.sections) ? p.sections.map((x: any) => (typeof x === 'string' ? x : x?.title || JSON.stringify(x))).join('\n') : String(p.outline || p.description || p.summary || '');
    pages.push({ title, path: unique, outline });
    if (pages.length >= maxPages) break;
  }
  if (!pages.length) return null;
  if (!pages.some((p) => p.path === 'index.html')) pages[0].path = 'index.html';
  const css = typeof j?.css === 'string' ? stripFences(j.css, ['css']) : typeof j?.styles === 'string' ? stripFences(j.styles, ['css']) : '';
  return { name: String(j?.siteName || j?.name || j?.title || '').trim() || 'My Web Site', description: String(j?.description || j?.tagline || '').trim(), pages, css, palette: j?.palette ? String(typeof j.palette === 'string' ? j.palette : JSON.stringify(j.palette)) : undefined };
}

/** The shared navigation bar for the pages of a plan, with links relative to `fromPath`. */
export function navHtml(pages: { title: string; path: string }[], fromPath: string): string {
  const items = pages.map((p) => `      <li><a href="${escAttr(relativeRef(fromPath, p.path))}"${p.path === fromPath ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('\n');
  return `<nav class="site-nav" aria-label="Main">\n    <ul>\n${items}\n    </ul>\n  </nav>`;
}

/** Assembles one page of a generated site: shared header and navigation, the model's main content, footer. */
export function sitePageShell(plan: SitePlan, page: PlanPage, mainHtml: string, cssPath = 'css/style.css', lang = 'en'): string {
  const home = relativeRef(page.path, plan.pages[0]?.path || 'index.html');
  const head = `<!DOCTYPE html>
<html lang="${escAttr(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(page.title === plan.name ? page.title : `${page.title} – ${plan.name}`)}</title>
  ${plan.description ? `<meta name="description" content="${escAttr(plan.description)}">\n  ` : ''}<link rel="stylesheet" href="${escAttr(relativeRef(page.path, cssPath))}">
</head>`;
  return `${head}
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <a class="site-title" href="${escAttr(home)}">${esc(plan.name)}</a>
  ${navHtml(plan.pages, page.path)}
</header>
<main id="main">
${mainHtml.trim()}
</main>
<footer class="site-footer">
  <p>&copy; ${new Date().getFullYear()} ${esc(plan.name)}</p>
</footer>
</body>
</html>
`;
}

/** CSS for the shell parts a site plan's style sheet may not cover (prepended once). */
export const SHELL_CSS = `.skip-link { position: absolute; left: -999px; top: 0; padding: .5rem 1rem; background: #fff; color: #000; z-index: 10; }
.skip-link:focus { left: .5rem; }
.site-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem 1.5rem; padding: 1rem clamp(1rem, 4vw, 3rem); }
.site-nav ul { display: flex; flex-wrap: wrap; gap: .25rem 1rem; list-style: none; margin: 0; padding: 0; }
.site-nav a[aria-current="page"] { font-weight: 700; text-decoration: underline; }
main { display: block; }
img { max-width: 100%; height: auto; }
`;

// ------------------------------------------------------------------------------------------
// Translations

/** Adds (or replaces) <link rel="alternate" hreflang> tags in a page head. */
export function setAlternateLinks(src: string, links: { lang: string; href: string }[]): string {
  let out = src;
  for (const l of links) {
    const re = new RegExp(`[ \\t]*<link\\b[^>]*\\brel\\s*=\\s*["']alternate["'][^>]*\\bhreflang\\s*=\\s*["']${l.lang.replace(/[^\w-]/g, '')}["'][^>]*>[ \\t]*\\r?\\n?`, 'gi');
    out = out.replace(re, '');
    out = headInsert(out, `<link rel="alternate" hreflang="${escAttr(l.lang)}" href="${escAttr(l.href)}">`);
  }
  return out;
}

/** Common languages for translation: label and BCP 47 code. */
export const LANGUAGES: [string, string][] = [
  ['English', 'en'], ['Spanish', 'es'], ['French', 'fr'], ['German', 'de'], ['Italian', 'it'], ['Portuguese', 'pt'], ['Dutch', 'nl'], ['Polish', 'pl'],
  ['Russian', 'ru'], ['Ukrainian', 'uk'], ['Chinese (Simplified)', 'zh-Hans'], ['Chinese (Traditional)', 'zh-Hant'], ['Japanese', 'ja'], ['Korean', 'ko'],
  ['Arabic', 'ar'], ['Hebrew', 'he'], ['Hindi', 'hi'], ['Turkish', 'tr'], ['Greek', 'el'], ['Swedish', 'sv'], ['Norwegian', 'no'], ['Danish', 'da'],
  ['Finnish', 'fi'], ['Czech', 'cs'], ['Vietnamese', 'vi'], ['Thai', 'th'], ['Indonesian', 'id'], ['Tagalog', 'tl'],
];
export function langCode(label: string): string {
  const t = label.trim();
  const hit = LANGUAGES.find(([l, c]) => l.toLowerCase() === t.toLowerCase() || c.toLowerCase() === t.toLowerCase());
  return hit ? hit[1] : slugify(t).slice(0, 8) || 'xx';
}
export const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur']);

// ------------------------------------------------------------------------------------------
// Layout outline (for "clone a layout": structure only, never the text or pictures)

/** A short outline of a page's structure: tags, roles, class names and counts; no text, no image URLs. */
export function structureOutline(html: string, maxLines = 120): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines: string[] = [];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'META', 'LINK', 'BR', 'WBR']);
  const LEAF = new Set(['A', 'IMG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'SPAN', 'STRONG', 'EM', 'LABEL', 'VIDEO', 'IFRAME', 'PICTURE']);
  const label = (el: Element) => {
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c && c.length < 30).slice(0, 3).map((c) => '.' + c).join('');
    const role = el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '';
    return el.tagName.toLowerCase() + cls + role;
  };
  const walk = (el: Element, depth: number) => {
    if (lines.length >= maxLines || depth > 7) return;
    const kids = [...el.children].filter((c) => !SKIP.has(c.tagName.toUpperCase()));
    // Collapse runs of similar children ("li × 6").
    let i = 0;
    while (i < kids.length && lines.length < maxLines) {
      const k = kids[i];
      const l = label(k);
      let n = 1;
      while (i + n < kids.length && label(kids[i + n]) === l) n++;
      const leafKids = [...k.children].filter((c) => !SKIP.has(c.tagName.toUpperCase()));
      const words = (k.textContent || '').trim().split(/\s+/).filter(Boolean).length;
      const note = LEAF.has(k.tagName.toUpperCase()) || !leafKids.length ? (words ? ` (~${words} words)` : '') : '';
      lines.push(`${'  '.repeat(depth)}${l}${n > 1 ? ` × ${n}` : ''}${note}`);
      if (!LEAF.has(k.tagName.toUpperCase()) || k.tagName === 'LI') walk(k, depth + 1);
      i += n;
    }
  };
  walk(doc.body, 0);
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------
// Diff (for previews)

export interface DiffLine { op: ' ' | '+' | '-'; text: string }

/** A line diff (longest common subsequence). Very long inputs fall back to a trimmed prefix/suffix diff. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.replace(/\r\n?/g, '\n').split('\n'), B = b.replace(/\r\n?/g, '\n').split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  const out: DiffLine[] = A.slice(0, pre).map((t) => ({ op: ' ' as const, text: t }));
  const n = a2.length, m = b2.length;
  if (n * m > 4_000_000) {
    out.push(...a2.map((t) => ({ op: '-' as const, text: t })), ...b2.map((t) => ({ op: '+' as const, text: t })));
  } else {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a2[i] === b2[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { out.push({ op: ' ', text: a2[i] }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push({ op: '-', text: a2[i++] });
      else out.push({ op: '+', text: b2[j++] });
    }
    while (i < n) out.push({ op: '-', text: a2[i++] });
    while (j < m) out.push({ op: '+', text: b2[j++] });
  }
  out.push(...A.slice(A.length - suf).map((t) => ({ op: ' ' as const, text: t })));
  return out;
}

/** The diff with unchanged runs folded to `context` lines around each change. */
export function foldDiff(d: DiffLine[], context = 3): (DiffLine | { op: '…'; text: string })[] {
  const keep = new Array(d.length).fill(false);
  d.forEach((l, i) => { if (l.op !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true; });
  const out: (DiffLine | { op: '…'; text: string })[] = [];
  let skipped = 0;
  d.forEach((l, i) => {
    if (keep[i]) { if (skipped) { out.push({ op: '…', text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}` }); skipped = 0; } out.push(l); }
    else skipped++;
  });
  if (skipped) out.push({ op: '…', text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}` });
  return out;
}

export function diffStats(d: DiffLine[]): { added: number; removed: number } {
  return { added: d.filter((l) => l.op === '+').length, removed: d.filter((l) => l.op === '-').length };
}

// ------------------------------------------------------------------------------------------
// Prompts

const q = (t: string) => `"""\n${t}\n"""`;
const HTML_OUT = 'Reply with the HTML only, in one ```html code block.';
const KEEP_MARKUP = 'The input is an HTML fragment. Keep its inline markup (links, emphasis, spans, classes, attributes) and structure; change only the text as asked. Reply with the revised HTML fragment only, in one ```html code block. Do not wrap it in <html> or <body>.';

export const FRAMEWORKS: Record<string, { label: string; head: string; note: string }> = {
  none: { label: 'None (plain CSS)', head: '', note: 'Use plain modern CSS (custom properties, flexbox, grid); no CSS framework.' },
  bootstrap: { label: 'Bootstrap 5', head: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">', note: 'Use Bootstrap 5.3 classes. Link its CSS from https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css (and its bundle script only if a component needs it).' },
  tailwind: { label: 'Tailwind CSS', head: '<script src="https://cdn.tailwindcss.com"></script>', note: 'Use Tailwind CSS utility classes, loaded with <script src="https://cdn.tailwindcss.com"></script>. Add no separate CSS unless needed.' },
};

export interface PageBrief { purpose: string; audience?: string; style?: string; sections?: string; framework?: string; separateCss?: boolean; lang?: string }

export function pagePrompt(b: PageBrief): string {
  const fw = FRAMEWORKS[b.framework || 'none'] || FRAMEWORKS.none;
  return [
    `Write a complete, original HTML5 web page.`,
    `Purpose: ${b.purpose}`,
    b.audience ? `Audience: ${b.audience}` : '',
    b.style ? `Visual style: ${b.style}` : '',
    b.sections ? `Sections, in order: ${b.sections}` : '',
    fw.note,
    `Requirements: <!DOCTYPE html>, lang="${b.lang || 'en'}", meta charset and viewport, a descriptive <title> and meta description, semantic landmarks (header, nav, main, footer), one h1, accessible color contrast, alt text on images, a responsive layout that works from 320px wide. Use realistic but clearly placeholder content (no real people or brands). Use no external images; use CSS shapes, gradients or inline SVG instead.`,
    b.separateCss && (b.framework || 'none') === 'none'
      ? 'Put the CSS in a separate ```css code block and link it from the page as href="style.css"; put the page in one ```html code block.'
      : 'Put the CSS in a <style> element in the head. Reply with the page in one ```html code block.',
  ].filter(Boolean).join('\n');
}

export function sitePlanPrompt(b: { purpose: string; audience?: string; style?: string; pages?: string; n?: number }): string {
  return [
    `Plan a small, original web site.`,
    `Purpose: ${b.purpose}`,
    b.audience ? `Audience: ${b.audience}` : '',
    b.style ? `Visual style: ${b.style}` : '',
    b.pages ? `Pages wanted: ${b.pages}` : `About ${b.n || 4} pages.`,
    'Reply with JSON only: {"siteName": string, "description": string (one sentence), "pages": [{"title": string, "path": string (e.g. "index.html", "about.html"), "outline": [string, …] (the sections of the page)}], "css": string (one shared style sheet for every page: custom properties for colors and fonts, base typography, layout of .site-header, .site-nav, main, .site-footer and the common components; responsive; accessible contrast)}. The first page is the home page, "index.html".',
  ].filter(Boolean).join('\n');
}

export function sitePagePrompt(plan: SitePlan, page: PlanPage): string {
  return [
    `Write the main content of one page of the web site "${plan.name}"${plan.description ? ` (${plan.description})` : ''}.`,
    `Page: ${page.title}`,
    page.outline ? `Sections:\n${page.outline}` : '',
    `Other pages: ${plan.pages.filter((p) => p !== page).map((p) => `${p.title} (${p.path})`).join(', ')}. Link to them with those relative paths where it helps.`,
    `The page already has a header with the site name and navigation, and a footer. Write only what goes inside <main>: an h1 and the sections, semantic and accessible, using the class names of this shared style sheet where they fit:\n${q(plan.css.slice(0, 5000))}`,
    'Use realistic placeholder content (no real people or brands) and no external images. ' + HTML_OUT,
  ].filter(Boolean).join('\n');
}

export const SECTION_KINDS: { id: string; label: string; hint: string }[] = [
  { id: 'hero', label: 'Hero banner', hint: 'a hero banner with a headline, a supporting sentence and one or two call-to-action buttons' },
  { id: 'features', label: 'Features', hint: 'a features grid of three to six items, each with an icon (inline SVG), a heading and a sentence' },
  { id: 'pricing', label: 'Pricing table', hint: 'a pricing section with three plans (name, price, features list, button); mark the recommended plan' },
  { id: 'faq', label: 'FAQ', hint: 'a frequently asked questions section using <details> and <summary>' },
  { id: 'testimonials', label: 'Testimonials', hint: 'three testimonials as <figure> with <blockquote> and <figcaption> (placeholder names)' },
  { id: 'contact', label: 'Contact form', hint: 'a contact section with an accessible form (name, email, message; labels; required fields) and contact details' },
  { id: 'cta', label: 'Call to action', hint: 'a call-to-action band with a short headline, a sentence and a button' },
  { id: 'team', label: 'Team', hint: 'a team grid of four people with initials avatars (CSS), name, role and one line' },
  { id: 'gallery', label: 'Gallery', hint: 'a responsive image gallery grid using placeholder figures (CSS gradients, no external images) with captions' },
  { id: 'stats', label: 'Statistics', hint: 'a band of three or four key numbers with labels' },
  { id: 'timeline', label: 'Timeline', hint: 'a vertical timeline of four to six milestones as an ordered list' },
  { id: 'newsletter', label: 'Newsletter signup', hint: 'a newsletter signup with an email field and button' },
  { id: 'about', label: 'About', hint: 'an about section with a heading, two short paragraphs and a highlighted quote' },
  { id: 'logos', label: 'Logo strip', hint: 'a "trusted by" strip of five placeholder logos drawn as simple inline SVG wordmarks' },
  { id: 'footer', label: 'Footer', hint: 'a site footer with three link columns, a short about line and a copyright line' },
];

export function sectionPrompt(kind: string, topic: string, context: string): string {
  const k = SECTION_KINDS.find((x) => x.id === kind);
  return [
    `Write ${k ? k.hint : kind} for a web page${topic ? ` about: ${topic}` : ''}.`,
    context ? `It goes into a page whose title and existing class names are below; match their style where possible.\n${q(context)}` : '',
    'Wrap it in one <section> with a class name, and include an aria-labelledby heading. Put any CSS it needs in one ```css code block (scoped with the section class) and the HTML in one ```html code block. No scripts, no external images.',
  ].filter(Boolean).join('\n');
}

export function sketchPrompt(notes: string, framework = 'none'): string {
  return [
    'This picture is a sketch, wireframe or screenshot of a web page layout. Build that layout as an original HTML5 page.',
    'Match the arrangement of regions, columns, headings, buttons and form fields you see. Where text is legible, use it; otherwise write short placeholder text. Draw pictures as neutral placeholder boxes (CSS), never external images.',
    notes ? `Notes from the designer: ${notes}` : '',
    (FRAMEWORKS[framework] || FRAMEWORKS.none).note,
    'Make it semantic, accessible and responsive. Put the CSS in a <style> element in the head. Reply with the page in one ```html code block.',
  ].filter(Boolean).join('\n');
}

export function cloneLayoutPrompt(description: string, outline: string, purpose: string): string {
  return [
    'Create an ORIGINAL web page whose layout is inspired by the description and structure outline below.',
    'Reproduce only the general arrangement (regions, columns, the order and kinds of sections). Do not copy any text, brand names, logos, pictures, colors scheme or code from the original site; write new placeholder content and your own styling.',
    purpose ? `The new page is for: ${purpose}` : '',
    description ? `Layout description:\n${q(description)}` : '',
    outline ? `Structure outline of the reference page (tags and class names only):\n${q(outline)}` : '',
    'Make it semantic, accessible and responsive; plain modern CSS in a <style> element; no external images. Reply with the page in one ```html code block.',
  ].filter(Boolean).join('\n');
}

export function svgPrompt(description: string, style: string, w: number, h: number): string {
  return `Draw an original illustration as one self-contained SVG: ${description}\nStyle: ${style || 'flat, modern, friendly'}\nSize: viewBox="0 0 ${w} ${h}", width="${w}" height="${h}". Use only basic shapes, paths and gradients; no text unless asked, no external references, no scripts. Include a <title> element describing it. Reply with the SVG only, in one \`\`\`svg code block.`;
}

export function placeholderPrompt(kind: string, topic: string, amount: string): string {
  return `Write realistic placeholder content for a web page about: ${topic || 'a small business'}.\nForm: ${kind} (${amount || 'a moderate amount'}).\nIt must read naturally (not lorem ipsum), invent no real people, brands or statistics, and use semantic HTML (headings, paragraphs, lists or a table with <caption> and <th> as fits). No CSS, no scripts. ${HTML_OUT}`;
}

/** Writing tasks on a selected HTML fragment; every result is HTML that keeps the inline markup. */
export const TEXT_TASKS: Record<string, { label: string; prompt: (html: string, arg?: string) => string }> = {
  rewrite: { label: 'Rewrite', prompt: (t) => `Rewrite the text of this web page fragment to be clearer, more direct and more engaging for site visitors. Keep the meaning and roughly the length.\n${KEEP_MARKUP}\n${q(t)}` },
  shorten: { label: 'Shorten', prompt: (t) => `Shorten the text of this web page fragment to about half its length, keeping the key points.\n${KEEP_MARKUP}\n${q(t)}` },
  expand: { label: 'Expand', prompt: (t) => `Expand the text of this web page fragment with concrete, useful detail (about one and a half times as long). Invent no facts, names or numbers.\n${KEEP_MARKUP}\n${q(t)}` },
  tone: { label: 'Change Tone', prompt: (t, tone) => `Rewrite the text of this web page fragment in a ${tone || 'more formal'} tone.\n${KEEP_MARKUP}\n${q(t)}` },
  proofread: { label: 'Proofread', prompt: (t) => `Correct spelling, grammar and punctuation in the text of this HTML fragment. Change nothing else.\n${KEEP_MARKUP}\n${q(t)}` },
  translate: { label: 'Translate', prompt: (t, lang) => `Translate the text of this HTML fragment into ${lang || 'English'}. Translate visible text and the alt, title, placeholder and aria-label attributes; keep tags, URLs, class names and ids.\n${KEEP_MARKUP}\n${q(t)}` },
};

export const CODE_TASKS: Record<string, { label: string; prompt: (code: string, lang: string, arg?: string) => string; whole?: boolean }> = {
  fixCode: { label: 'Fix Code', prompt: (c, l, ctx) => `Fix the errors in this ${l} code: invalid or unclosed markup, misnested tags, duplicate ids, missing required attributes (alt, lang, labels), invalid CSS, JavaScript errors. Keep everything that is correct exactly as written, including formatting and comments.${ctx ? `\nValidator findings:\n${ctx}` : ''}\nReply with the corrected code only, complete, in one code block.\n${q(c)}` },
  refactor: { label: 'Refactor Code', prompt: (c, l, goal) => `Refactor this ${l} code for clarity and maintainability without changing what it renders or does${goal ? ` (goal: ${goal})` : ''}: remove duplication, use semantic elements and meaningful class names, consolidate CSS. Reply with the complete refactored code only, in one code block.\n${q(c)}` },
  commentCode: { label: 'Comment Code', prompt: (c, l) => `Add brief, useful comments to this ${l} code (in that language's comment syntax) explaining its structure and any non-obvious parts. Do not change the code itself. Reply with the complete commented code only, in one code block.\n${q(c)}` },
  modernize: { label: 'Modernize Markup', prompt: (c, l) => `Modernize this ${l}: replace layout tables, <font>, <center>, presentational attributes (bgcolor, align, border, width on non-media elements), spacer images and inline formatting with semantic HTML5 elements and CSS (put the CSS in a <style> element in the head, or keep it in the style sheet if this is CSS). Keep the visible content, links and look. Reply with the complete modernized code only, in one code block.\n${q(c)}` },
  makeResponsive: { label: 'Make Responsive', prompt: (c, l) => `Make this ${l} responsive: it must work from 320px to large screens. Add a viewport meta tag if missing, replace fixed widths with fluid ones, make images and tables fit, add media queries or flexible grid/flex layouts, and keep the design on wide screens. Reply with the complete revised code only, in one code block.\n${q(c)}` },
  convertFramework: { label: 'Convert Framework', prompt: (c, l, to) => `Convert this ${l} to ${to || 'plain CSS'}. ${to && /bootstrap/i.test(to) ? FRAMEWORKS.bootstrap.note : to && /tailwind/i.test(to) ? FRAMEWORKS.tailwind.note : 'Remove framework classes and links, and write equivalent plain modern CSS in a <style> element in the head.'} Keep the content and the look as close as possible. Reply with the complete converted code only, in one code block.\n${q(c)}` },
  accessibilityFix: { label: 'Fix Accessibility', prompt: (c, l) => `Fix the accessibility problems in this ${l} (WCAG 2.2 AA): page language, landmarks, heading order, alt text (descriptive, or alt="" for decorative images), form labels, link text, button names, ARIA misuse, focus visibility, color contrast in CSS, tables with headers. Keep the design and content otherwise. Reply with the complete corrected code only, in one code block, and nothing else.\n${q(c)}` },
};

export const ANALYSIS_TASKS: Record<string, { label: string; prompt: (code: string, lang: string) => string }> = {
  explainCode: { label: 'Explain Code', prompt: (c, l) => `Explain this ${l} code to a web designer: what it does, how it is structured, and anything unusual or risky. Be concise; use short paragraphs or bullets.\n${q(c)}` },
  performance: { label: 'Performance Advice', prompt: (c, l) => `Review this ${l} for page-load performance (Core Web Vitals): render-blocking resources, image sizes and formats, lazy loading, fonts, script loading (defer/async), CSS size, layout shifts, caching hints. List the most valuable changes first, each with the exact code change.\n${q(c)}` },
  reviewPage: { label: 'Review Page', prompt: (c, l) => `Critique this web page (${l}) as a senior web designer: first impression and clarity of purpose, content and copy, visual hierarchy and layout, navigation, accessibility, mobile behavior, SEO basics, and code quality. Give a short score (1–10) for each area and the three changes that would help most.\n${q(c)}` },
  summarize: { label: 'Summarize', prompt: (c) => `Summarize the content of this web page in 3–5 sentences for a visitor.\n${q(c)}` },
};

export function seoPrompt(pageText: string, title: string, desc: string, url: string): string {
  return `Suggest search engine optimization for this web page (${url}). Current title: "${title}". Current meta description: "${desc}".\nReply with JSON only: {"title": string (50–60 characters), "description": string (140–160 characters), "keywords": string (comma-separated, 5–8), "h1": string, "headings": [string] (suggested h2 outline), "notes": [string] (3–6 specific suggestions)}.\nPage text:\n${q(pageText)}`;
}

export function metaTagsPrompt(pageText: string, title: string, url: string, siteName: string): string {
  return `Write meta tags for this web page (${url}) of the site "${siteName}". Current title: "${title}".\nReply with JSON only: {"description": string (140–160 characters), "keywords": string, "og:title": string, "og:description": string, "og:type": "website"|"article"|"product"|"profile", "twitter:card": "summary"|"summary_large_image", "robots": "index, follow" unless the page should not be indexed}.\nPage text:\n${q(pageText)}`;
}

export const SCHEMA_TYPES = ['WebSite', 'Organization', 'LocalBusiness', 'Restaurant', 'Person', 'Article', 'BlogPosting', 'Product', 'Event', 'FAQPage', 'HowTo', 'Recipe', 'Course', 'BreadcrumbList', 'ContactPage', 'AboutPage'];

export function schemaPrompt(type: string, pageText: string, url: string): string {
  return `Write schema.org structured data (JSON-LD) of type ${type} for this web page (${url}), using only facts present in the page text; leave out properties the text does not support. Reply with the JSON object only (with "@context": "https://schema.org"), no <script> tag.\nPage text:\n${q(pageText)}`;
}

export function altTextPrompt(ctx: string, seen: boolean): string {
  return seen
    ? `Write alternative text for this picture on a web page: one sentence, at most 20 words, describing what matters in context, without "image of" or "picture of". If it is purely decorative, reply with exactly: DECORATIVE. Context: ${ctx}\nReply with the text only.`
    : `Suggest alternative text for a picture on a web page, from its file name and context only (you cannot see it): one short phrase, at most 12 words, without "image of". If the name suggests decoration (spacer, divider, bullet, background), reply with exactly: DECORATIVE. Context: ${ctx}\nReply with the text only.`;
}

export function headlinePrompt(text: string, n = 5): string {
  return `Write ${n} alternative headlines for this web page content: clear, specific, at most 10 words each, varied in approach (benefit, question, how-to, bold statement). One per line, no numbering, no quotes.\n${q(text)}`;
}

export function ctaPrompt(text: string, goal: string): string {
  return `Write a call-to-action block for this web page${goal ? ` (goal: ${goal})` : ''}: a short headline (h2), one persuasive sentence, and a link styled as a button (<a class="button" href="#">…</a>) with action-oriented text. Base it on this page content:\n${q(text)}\nWrap it in <section class="cta">. No CSS, no scripts. ${HTML_OUT}`;
}

export function writeCopyPrompt(what: string, kind: string, tone: string, context: string): string {
  return `Write ${kind || 'web page copy'} about: ${what}\nTone: ${tone || 'clear and friendly'}.\n${context ? `It goes into this page (for context):\n${q(context)}\n` : ''}Write for the web: short paragraphs, scannable headings where useful, plain language, no invented facts or statistics. Semantic HTML only (no CSS, no scripts). ${HTML_OUT}`;
}

export function faqPrompt(text: string, topic: string, n = 6): string {
  return `Write ${n} frequently asked questions with answers ${text ? 'based only on this web page content' : `about: ${topic}`}. Format as an FAQ section: <section class="faq" aria-labelledby="faq-title"><h2 id="faq-title">Frequently Asked Questions</h2> then each question as <details><summary>Question</summary><p>Answer</p></details>. ${HTML_OUT}${text ? `\n${q(text)}` : ''}`;
}

export function blogPostPrompt(topic: string, audience: string, words: number, tone: string): string {
  return `Write an original blog post about: ${topic}\nAudience: ${audience || 'general readers'}. Tone: ${tone || 'friendly and informative'}. Length: about ${words || 800} words.\nFormat: an <article> with an h1, a byline paragraph with class "byline" containing a <time> element, an introduction, h2 sections, and a conclusion. Invent no statistics, quotes or real people. ${HTML_OUT}`;
}

export function productCopyPrompt(name: string, features: string, audience: string, tone: string): string {
  return `Write product copy for "${name}". Features and facts:\n${q(features)}\nAudience: ${audience || 'general'}. Tone: ${tone || 'confident and friendly'}.\nFormat: a <section class="product"> with an h2 name, a one-sentence tagline paragraph, a short description, a <ul> of benefit-led features, and a call-to-action link with class "button". Use only the facts given. ${HTML_OUT}`;
}

export function legalPrompt(kind: 'privacy' | 'terms', f: { org: string; site: string; email: string; country: string; practices: string }): string {
  const what = kind === 'privacy'
    ? 'a privacy policy page: what is collected, why, cookies and analytics, sharing, retention, visitor rights (including GDPR and CCPA rights where they apply), children, security, changes, contact'
    : 'terms of use page: acceptance, use of the site, intellectual property, user content, disclaimers, limitation of liability, links to other sites, governing law, changes, contact';
  return `Write ${what} for the web site ${f.site || 'this site'}, run by ${f.org || 'the site owner'} in ${f.country || 'the United States'}. Contact: ${f.email || 'the contact page'}.\n${f.practices ? `Facts about the site's practices (use only these; do not invent others):\n${q(f.practices)}\n` : ''}Plain language, headings for each part, an "Effective date" line with the placeholder [DATE]. Start with an HTML comment saying this is a template that is not legal advice and should be reviewed by a qualified professional. Write a complete HTML5 page with a <style> element for simple readable typography. Reply with the page in one \`\`\`html code block.`;
}

export function errorPagePrompt(siteName: string, style: string, homeHref: string): string {
  return `Write a friendly, original 404 "page not found" page for the web site "${siteName}". Style: ${style || 'clean and modern'}. It must say clearly that the page was not found, suggest checking the address, and offer a link to the home page (href="${homeHref}") and a link to search or the site map if useful. Use an inline SVG illustration (no external images), accessible markup, a responsive layout and a <style> element in the head. Include <meta name="robots" content="noindex">. Reply with the page in one \`\`\`html code block.`;
}

export function cssPrompt(description: string, context: string): string {
  return `Write CSS for a web page: ${description}\n${context ? `Relevant markup and existing CSS (for selectors and consistency):\n${q(context)}\n` : ''}Use modern, responsive CSS, accessible contrast and focus styles. Reply with the CSS only, in one \`\`\`css code block.`;
}

export function jsPrompt(description: string, context: string): string {
  return `Write JavaScript for a web page: ${description}\n${context ? `Relevant markup (for selectors):\n${q(context)}\n` : ''}Plain modern JavaScript (no libraries), runs after the DOM is ready (the script is loaded with defer), progressive enhancement (the page still works without it), accessible (keyboard, ARIA states), no external requests unless asked. Reply with the JavaScript only, in one \`\`\`js code block.`;
}

export function translatePagePrompt(html: string, lang: string): string {
  return `Translate this web page into ${lang}. Translate visible text, the <title>, meta description, and alt, title, placeholder and aria-label attributes. Keep all tags, attributes, URLs, class names, ids, scripts, styles and comments exactly as they are. Reply with the complete translated page only, in one \`\`\`html code block.\n${q(html)}`;
}

/** Page text for prompts: title, description, headings and visible text, capped. */
export function pageTextFor(src: string, max = 12000): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1]?.trim() || '';
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(src)?.[1] ?? src;
  const text = body
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n${'#'.repeat(+n)} ${t.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|section|article|header|footer|blockquote|pre|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return (title ? `Title: ${title}\n` : '') + text.slice(0, max);
}

/** Source code capped for a prompt, with a note when cut. */
export function capCode(code: string, max = 40000): { code: string; cut: boolean } {
  return code.length <= max ? { code, cut: false } : { code: code.slice(0, max), cut: true };
}

/** Plain prose (an answer without markup) as simple HTML: paragraphs, bulleted and numbered lists, headings. */
export function proseToHtml(s: string): string {
  const t = cleanText(s);
  if (/<\/?[a-z][\w-]*[\s>]/i.test(t)) return t;
  const inline = (x: string) => esc(x).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out: string[] = [];
  for (const block of t.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const head = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
    if (head && lines.length === 1) { const n = Math.max(2, head[1].length); out.push(`<h${n}>${inline(head[2])}</h${n}>`); continue; }
    if (lines.every((l) => /^[-*•]\s+/.test(l))) { out.push(`<ul>\n${lines.map((l) => `  <li>${inline(l.replace(/^[-*•]\s+/, ''))}</li>`).join('\n')}\n</ul>`); continue; }
    if (lines.every((l) => /^\d+[.)]\s+/.test(l))) { out.push(`<ol>\n${lines.map((l) => `  <li>${inline(l.replace(/^\d+[.)]\s+/, ''))}</li>`).join('\n')}\n</ol>`); continue; }
    out.push(`<p>${lines.map(inline).join('<br>\n')}</p>`);
  }
  return out.join('\n');
}

/** The language name used in prompts for a file. */
export function codeLang(path: string): { name: string; fence: string } {
  const e = (/\.([a-z0-9]+)$/i.exec(path)?.[1] || '').toLowerCase();
  if (['css', 'scss', 'less'].includes(e)) return { name: 'CSS', fence: 'css' };
  if (['js', 'mjs', 'cjs', 'jsx', 'ts'].includes(e)) return { name: 'JavaScript', fence: 'js' };
  if (e === 'json') return { name: 'JSON', fence: 'json' };
  if (e === 'php') return { name: 'PHP/HTML', fence: 'php' };
  if (['xml', 'svg', 'rss'].includes(e)) return { name: 'XML', fence: 'xml' };
  return { name: 'HTML', fence: 'html' };
}
