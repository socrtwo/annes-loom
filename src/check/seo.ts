/**
 * Search engine optimization and page performance reports.
 *
 * seoCheck(): title and description length, h1 count and heading structure, canonical link, Open Graph
 * and social cards, robots directives, picture alt text, link text, word count, language and viewport,
 * structured data. Site runs add duplicate titles and descriptions across pages.
 *
 * performanceCheck(): page weight with every site resource it loads, oversized pictures (file bytes and
 * pixels compared with the displayed size), pictures without width and height (layout shift), lazy
 * loading, render-blocking scripts and style sheets, inline data: URLs and legacy image formats.
 */
import { parseHtml, findAll, byName, attr, hasAttr, textOf, type HNode, type Issue, type Severity } from './validate';

export interface SeoIssue extends Issue { category?: string }

const GENERIC = /^(click here|here|more|read more|learn more|link|this|go|details|continue|info|page)\.?$/i;

export function visibleWords(root: HNode): number {
  const body = byName(root, 'body')[0] || root;
  return (textOf(body).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

export interface SeoOptions { /** Page path (for file name checks). */ path?: string }

export function seoCheck(src: string, opts: SeoOptions = {}): SeoIssue[] {
  const { root } = parseHtml(src);
  const out: SeoIssue[] = [];
  const top = { line: 1, col: 1, start: 0 };
  const add = (n: { line: number; col: number; start?: number }, severity: Severity, category: string, message: string, rule: string) => out.push({ line: n.line, col: n.col, offset: n.start, severity, category, message, rule });
  const head = byName(root, 'head')[0] || top;
  const metas = byName(root, 'meta');
  const meta = (name: string, a = 'name') => metas.find((m) => (attr(m, a) || '').toLowerCase() === name);
  const metaContent = (name: string, a = 'name') => attr(meta(name, a) || ({ attrs: [] } as any), 'content');

  // Title
  const title = byName(root, 'title').find((t) => !t.foreign);
  const tt = title ? textOf(title).trim().replace(/\s+/g, ' ') : '';
  if (!tt) add(title || head, 'error', 'Title', 'No page title. Search results show the title as the link to the page.', 'title');
  else {
    if (tt.length < 15) add(title!, 'warning', 'Title', `The title "${tt}" is short (${tt.length} characters); 30–60 characters describe a page well.`, 'title-length');
    if (tt.length > 60) add(title!, 'warning', 'Title', `The title is ${tt.length} characters; search results cut titles at about 60.`, 'title-length');
    if (/^(untitled|new page|home|index|document|page \d*)( \d+)?$/i.test(tt)) add(title!, 'warning', 'Title', `"${tt}" is a placeholder title.`, 'title');
  }
  // Description
  const desc = meta('description');
  const dc = (desc ? attr(desc, 'content') : null)?.trim() || '';
  if (!desc) add(head, 'warning', 'Description', 'No meta description. Search engines often show it under the title (Insert ▸ Meta Description).', 'description');
  else if (!dc) add(desc, 'warning', 'Description', 'The meta description is empty.', 'description');
  else {
    if (dc.length < 50) add(desc, 'info', 'Description', `The description is short (${dc.length} characters); 70–160 works best.`, 'description-length');
    if (dc.length > 160) add(desc, 'warning', 'Description', `The description is ${dc.length} characters; results cut it at about 160.`, 'description-length');
    if (tt && dc.toLowerCase() === tt.toLowerCase()) add(desc, 'info', 'Description', 'The description repeats the title.', 'description');
  }
  const kw = meta('keywords');
  if (kw) add(kw, 'info', 'Meta', 'Search engines ignore meta keywords; it can be removed.', 'keywords');
  // Robots
  const robots = (metaContent('robots') || '') + ' ' + (metaContent('googlebot') || '');
  if (/noindex/i.test(robots)) add(meta('robots') || meta('googlebot')!, 'warning', 'Indexing', 'robots "noindex": this page will not appear in search results.', 'noindex');
  if (/nofollow/i.test(robots)) add(meta('robots') || meta('googlebot')!, 'info', 'Indexing', 'robots "nofollow": search engines will not follow links on this page.', 'nofollow');
  // Canonical
  const canon = byName(root, 'link').find((l) => /(^|\s)canonical(\s|$)/i.test(attr(l, 'rel') || ''));
  if (!canon) add(head, 'info', 'Canonical', 'No canonical link (<link rel="canonical" href="https://…">); it tells search engines which address is the original.', 'canonical');
  else if (!/^https?:\/\//i.test(attr(canon, 'href') || '')) add(canon, 'warning', 'Canonical', 'The canonical link should be a full address starting with https://.', 'canonical');
  // Social
  const og = (p: string) => metas.find((m) => (attr(m, 'property') || attr(m, 'name') || '').toLowerCase() === p);
  const missingOg = ['og:title', 'og:description', 'og:image'].filter((p) => !og(p));
  if (missingOg.length === 3) add(head, 'info', 'Social', 'No Open Graph tags; shared links show no picture or summary (Insert ▸ Open Graph).', 'og');
  else if (missingOg.length) add(head, 'info', 'Social', `Open Graph is missing ${missingOg.join(', ')}.`, 'og');
  if (og('og:image') && !/^https?:\/\//i.test(attr(og('og:image')!, 'content') || '')) add(og('og:image')!, 'warning', 'Social', 'og:image must be a full address (https://…).', 'og');
  if (!og('twitter:card') && missingOg.length < 3) add(head, 'info', 'Social', 'No twitter:card meta tag (summary_large_image shows a big picture).', 'og');
  // Mobile, language, structured data
  if (!meta('viewport')) add(head, 'warning', 'Mobile', 'No viewport meta tag; phones show the desktop layout zoomed out, which search engines rank lower.', 'viewport');
  const html = byName(root, 'html')[0];
  if (!html || !attr(html, 'lang')) add(html || top, 'warning', 'Language', 'No lang on <html>; it helps search engines serve the page to the right audience.', 'lang');
  if (!byName(root, 'script').some((s) => /ld\+json/i.test(attr(s, 'type') || '')) && !findAll(root, (e) => hasAttr(e, 'itemscope')).length) add(head, 'info', 'Structured data', 'No structured data (JSON-LD); it can earn rich results (ratings, events, breadcrumbs).', 'structured');
  for (const s of byName(root, 'script').filter((x) => /ld\+json/i.test(attr(x, 'type') || ''))) {
    try { JSON.parse(textOf(s) || s.children.map((c) => c.text).join('')); } catch { add(s, 'error', 'Structured data', 'This JSON-LD block is not valid JSON.', 'structured'); }
  }
  // Headings
  const hs = findAll(root, (e) => /^h[1-6]$/.test(e.name) && !e.foreign);
  const h1 = hs.filter((x) => x.name === 'h1');
  if (!h1.length) add(byName(root, 'body')[0] || top, 'warning', 'Headings', 'No h1 heading; the main heading tells search engines what the page is about.', 'h1');
  if (h1.length > 1) add(h1[1], 'info', 'Headings', `${h1.length} h1 headings; one main heading is clearer.`, 'h1');
  for (const x of h1) if (!textOf(x).trim()) add(x, 'warning', 'Headings', 'Empty h1.', 'h1');
  let prev = 0;
  for (const x of hs) { const l = +x.name[1]; if (prev && l > prev + 1) add(x, 'info', 'Headings', `Heading level jumps from h${prev} to h${l}.`, 'heading-order'); prev = l; }
  // Pictures and links
  const imgs = byName(root, 'img');
  const noAlt = imgs.filter((i) => !hasAttr(i, 'alt'));
  for (const i of noAlt.slice(0, 20)) add(i, 'warning', 'Pictures', `Picture without alt text (${attr(i, 'src') || ''}); image search uses alt text.`, 'alt');
  for (const i of imgs) { const s = attr(i, 'src') || ''; const file = s.split('/').pop() || ''; if (/^(img|image|dsc|pict|photo|screenshot)?[_-]?\d{3,}\.\w+$/i.test(file)) add(i, 'info', 'Pictures', `"${file}" says nothing about the picture; descriptive file names help image search.`, 'image-name'); }
  for (const a of byName(root, 'a').filter((x) => hasAttr(x, 'href'))) {
    const t = textOf(a).trim();
    if (GENERIC.test(t)) add(a, 'info', 'Links', `Link text "${t}" does not describe the destination.`, 'link-text');
    const href = attr(a, 'href') || '';
    if (/^https?:\/\//i.test(href) && (attr(a, 'target') === '_blank') && !/noopener|noreferrer/.test(attr(a, 'rel') || '')) add(a, 'info', 'Links', 'External link opening a new tab without rel="noopener".', 'noopener');
  }
  // Content
  const words = visibleWords(root);
  if (words < 300) add(byName(root, 'body')[0] || top, 'info', 'Content', `The page has ${words} words; pages with under about 300 words of text often rank poorly.`, 'word-count');
  // Address
  if (opts.path) {
    const file = opts.path.split('/').pop() || '';
    if (/[A-Z\s_]/.test(opts.path)) add(top, 'info', 'Address', `The address "${opts.path}" has capitals, spaces or underscores; lower-case words joined by hyphens make clearer addresses.`, 'url');
    if (file.length > 60) add(top, 'info', 'Address', 'A very long file name.', 'url');
  }
  if (findAll(root, (e) => e.name === 'frameset' || e.name === 'frame').length) add(top, 'warning', 'Content', 'Frames: search engines index frame pages separately and send visitors to pages without navigation.', 'frames');
  return out;
}

/** Duplicate titles and descriptions across pages (site report). */
export function siteSeoDuplicates(pages: { path: string; src: string }[]): SeoIssue[] {
  const titles = new Map<string, string[]>();
  const descs = new Map<string, string[]>();
  for (const p of pages) {
    const { root } = parseHtml(p.src);
    const t = byName(root, 'title')[0];
    const tt = t ? textOf(t).trim().toLowerCase() : '';
    if (tt) titles.set(tt, [...(titles.get(tt) || []), p.path]);
    const d = byName(root, 'meta').find((m) => (attr(m, 'name') || '').toLowerCase() === 'description');
    const dc = d ? (attr(d, 'content') || '').trim().toLowerCase() : '';
    if (dc) descs.set(dc, [...(descs.get(dc) || []), p.path]);
  }
  const out: SeoIssue[] = [];
  for (const [t, ps] of titles) if (ps.length > 1) for (const p of ps) out.push({ path: p, line: 1, col: 1, severity: 'warning', category: 'Title', message: `The title "${t.slice(0, 50)}" is also used by ${ps.filter((x) => x !== p).join(', ')}.`, rule: 'dup-title' });
  for (const [d, ps] of descs) if (ps.length > 1) for (const p of ps) out.push({ path: p, line: 1, col: 1, severity: 'info', category: 'Description', message: `The same description is used by ${ps.filter((x) => x !== p).join(', ')}: "${d.slice(0, 40)}…"`, rule: 'dup-description' });
  return out;
}

// --------------------------------------------------------------------------------------------
// Performance

/** Pixel size of a PNG, GIF, JPEG, WebP, BMP or SVG file (null when unknown). */
export function imageSize(bytes: Uint8Array): { width: number; height: number; type: string } | null {
  const b = bytes;
  const u16be = (o: number) => (b[o] << 8) | b[o + 1];
  const u16le = (o: number) => b[o] | (b[o + 1] << 8);
  const u32be = (o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32be(16), height: u32be(20), type: 'png' };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(6), height: u16le(8), type: 'gif' };
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24)), height: Math.abs(b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24)), type: 'bmp' };
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1, type: 'webp' };
    if (chunk === 'VP8L') { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' }; }
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff, type: 'webp' };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = u16be(o + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(o + 7), height: u16be(o + 5), type: 'jpeg' };
      o += 2 + len;
    }
    return null;
  }
  const head = new TextDecoder().decode(b.slice(0, 2048));
  if (/<svg\b/i.test(head)) {
    const tag = /<svg\b[^>]*>/i.exec(head)?.[0] || '';
    const w = /\swidth\s*=\s*["']?([\d.]+)(px)?["'\s>]/i.exec(tag)?.[1];
    const hh = /\sheight\s*=\s*["']?([\d.]+)(px)?["'\s>]/i.exec(tag)?.[1];
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    if (w && hh) return { width: +w, height: +hh, type: 'svg' };
    if (vb) return { width: +vb[1], height: +vb[2], type: 'svg' };
  }
  return null;
}

export interface PerfResource { ref: string; path: string | null; bytes: number | null; kind: string }
export interface PerfReport { issues: Issue[]; totalBytes: number; htmlBytes: number; resources: PerfResource[]; unknown: number }

export interface PerfEnv {
  /** Resolves a reference written in the page to a site path, or null. */
  resolve(ref: string): string | null;
  /** Bytes of a site file, or undefined. */
  bytes(path: string): Uint8Array | undefined;
}

const KB = 1024;
export const fmtBytes = (n: number) => (n < KB ? `${n} bytes` : n < KB * KB ? `${(n / KB).toFixed(1)} KB` : `${(n / KB / KB).toFixed(2)} MB`);

export function performanceCheck(src: string, env: PerfEnv): PerfReport {
  const { root } = parseHtml(src);
  const out: Issue[] = [];
  const add = (n: { line: number; col: number; start?: number }, severity: Severity, message: string, rule: string) => out.push({ line: n.line, col: n.col, offset: n.start, severity, message, rule });
  const htmlBytes = new TextEncoder().encode(src).length;
  const resources: PerfResource[] = [];
  const seen = new Set<string>();
  let unknown = 0;
  const addRes = (ref: string | null, kind: string): PerfResource | null => {
    if (!ref || /^(data:|#|mailto:|javascript:|tel:)/i.test(ref.trim())) return null;
    const path = env.resolve(ref.trim());
    if (seen.has(path || ref)) return null;
    seen.add(path || ref);
    const b = path ? env.bytes(path) : undefined;
    const r: PerfResource = { ref, path, bytes: b ? b.length : null, kind };
    if (r.bytes == null) unknown++;
    resources.push(r);
    return r;
  };
  const els = findAll(root, (n) => !n.foreign);
  const head = byName(root, 'head')[0];
  const inHead = (n: HNode) => { for (let p = n.parent; p; p = p.parent) if (p === head) return true; return false; };

  // Scripts and style sheets
  let blockingScripts = 0;
  const sheets = els.filter((e) => e.name === 'link' && /stylesheet/i.test(attr(e, 'rel') || ''));
  for (const s of sheets) {
    const r = addRes(attr(s, 'href'), 'css');
    if (r?.path) {
      const css = new TextDecoder().decode(env.bytes(r.path) || new Uint8Array());
      for (const m of css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g)) { add(s, 'info', `${r.path} uses @import (${m[1]}): imported sheets load one after another. Link them from the page instead.`, 'import'); addRes(m[1], 'css'); }
      for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) if (/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(m[1])) { const fr = env.resolve(m[1]); if (fr) { const b = env.bytes(fr); if (!seen.has(fr)) { seen.add(fr); resources.push({ ref: m[1], path: fr, bytes: b ? b.length : null, kind: 'font' }); } } }
    }
  }
  if (sheets.length > 5) add(sheets[5], 'info', `${sheets.length} style sheets; combining them saves requests.`, 'requests');
  for (const s of els.filter((e) => e.name === 'script' && hasAttr(e, 'src'))) {
    addRes(attr(s, 'src'), 'js');
    const isModule = (attr(s, 'type') || '').toLowerCase() === 'module';
    if (inHead(s) && !hasAttr(s, 'defer') && !hasAttr(s, 'async') && !isModule) { blockingScripts++; add(s, 'warning', `Render-blocking script ${attr(s, 'src')}: the page waits for it before showing anything. Add defer (or async if it does not depend on the page).`, 'render-blocking'); }
  }
  for (const s of els.filter((e) => e.name === 'script' && !hasAttr(e, 'src'))) {
    const code = s.children.map((c) => c.text).join('');
    if (code.length > 20 * KB) add(s, 'info', `Inline script of ${fmtBytes(code.length)}; an external file can be cached between pages.`, 'inline-size');
  }
  for (const s of els.filter((e) => e.name === 'style')) { const css = s.children.map((c) => c.text).join(''); if (css.length > 30 * KB) add(s, 'info', `Inline style block of ${fmtBytes(css.length)}; an external style sheet can be cached.`, 'inline-size'); }

  // Pictures
  const imgs = els.filter((e) => e.name === 'img');
  imgs.forEach((img, index) => {
    const src = attr(img, 'src');
    if (src && /^data:/i.test(src) && src.length > 10 * KB) add(img, 'info', `An embedded data: picture of ${fmtBytes(Math.round(src.length * 0.75))} cannot be cached; save it as a file.`, 'data-uri');
    const r = addRes(src, 'image');
    if (!hasAttr(img, 'width') || !hasAttr(img, 'height')) {
      const st = attr(img, 'style') || '';
      if (!(/\bwidth\s*:/.test(st) && /\bheight\s*:|aspect-ratio/.test(st))) add(img, 'warning', `Picture without width and height (${src || ''}): the page jumps as it loads (layout shift). Set both to the picture's size; CSS can still scale it.`, 'dimensions');
    }
    if (index >= 3 && attr(img, 'loading') !== 'lazy' && !img.parent?.name.match(/^picture$/)) add(img, 'info', `Picture ${src || ''} could load lazily (loading="lazy") if it is below the first screen.`, 'lazy');
    if (index < 1 && attr(img, 'loading') === 'lazy') add(img, 'info', 'The first picture is lazy-loaded; if it is at the top of the page, load it eagerly so it shows sooner.', 'lazy');
    if (!r?.path) return;
    const bytes = env.bytes(r.path);
    if (!bytes) return;
    if (bytes.length > 500 * KB) add(img, 'error', `${r.path} is ${fmtBytes(bytes.length)}; compress it (Picture ▸ Optimize) or save it as WebP or AVIF.`, 'image-bytes');
    else if (bytes.length > 200 * KB) add(img, 'warning', `${r.path} is ${fmtBytes(bytes.length)}; pictures for the web are usually under 200 KB.`, 'image-bytes');
    if (/\.(bmp|tiff?)$/i.test(r.path)) add(img, 'warning', `${r.path} is an uncompressed format; use JPEG, PNG or WebP.`, 'image-format');
    const dim = imageSize(bytes);
    const w = parseInt(attr(img, 'width') || '', 10), hgt = parseInt(attr(img, 'height') || '', 10);
    if (dim && dim.type !== 'svg' && w > 0) {
      if (dim.width > w * 2 && dim.width - w > 200) add(img, 'warning', `${r.path} is ${dim.width}×${dim.height} pixels but shown at ${w}×${hgt || '?'}; resample it (Picture ▸ Resample) to save ${Math.round((1 - (w * w) / (dim.width * dim.width)) * 100)}% of the pixels, or provide srcset sizes.`, 'image-scaled');
      if (hgt > 0 && Math.abs(dim.width / dim.height - w / hgt) > 0.05) add(img, 'info', `${r.path} is shown at ${w}×${hgt}, which distorts its ${dim.width}×${dim.height} proportions.`, 'image-aspect');
    }
    if (dim && dim.type === 'png' && bytes.length > 300 * KB) add(img, 'info', `${r.path} is a large PNG; if it is a photo, JPEG or WebP is much smaller.`, 'image-format');
  });
  for (const e of els) {
    if (e.name === 'source') addRes(attr(e, 'src') || (attr(e, 'srcset') || '').split(/[\s,]/)[0], e.parent?.name === 'picture' ? 'image' : 'media');
    if (e.name === 'video') { addRes(attr(e, 'src'), 'media'); addRes(attr(e, 'poster'), 'image'); if (!hasAttr(e, 'preload') && !hasAttr(e, 'autoplay')) add(e, 'info', 'Video without preload; preload="metadata" (or "none") avoids downloading the video before it plays.', 'preload'); }
    if (e.name === 'audio') addRes(attr(e, 'src'), 'media');
    if (e.name === 'iframe' && attr(e, 'loading') !== 'lazy') add(e, 'info', 'Embedded frame without loading="lazy"; frames below the first screen can wait.', 'lazy');
    if (e.name === 'link' && /icon/i.test(attr(e, 'rel') || '')) addRes(attr(e, 'href'), 'icon');
    const bg = attr(e, 'background') || /url\(\s*["']?([^"')]+)/.exec(attr(e, 'style') || '')?.[1] || null;
    if (bg) addRes(bg, 'image');
  }

  const fonts = resources.filter((r) => r.kind === 'font');
  if (fonts.length > 4) add(head || { line: 1, col: 1 }, 'info', `${fonts.length} web font files; each one delays text. Use fewer weights, or a variable font.`, 'fonts');
  const totalBytes = htmlBytes + resources.reduce((s, r) => s + (r.bytes || 0), 0);
  const top = head || { line: 1, col: 1, start: 0 };
  if (totalBytes > 5 * KB * KB) add(top, 'error', `Page weight ${fmtBytes(totalBytes)} (with ${resources.length} resources); pages over 5 MB load slowly on phones.`, 'weight');
  else if (totalBytes > 2 * KB * KB) add(top, 'warning', `Page weight ${fmtBytes(totalBytes)}; aim for under 2 MB.`, 'weight');
  else add(top, 'info', `Page weight ${fmtBytes(totalBytes)}: page ${fmtBytes(htmlBytes)} plus ${resources.length} site resources${unknown ? ` (${unknown} outside the site not counted)` : ''}.`, 'weight');
  if (htmlBytes > 150 * KB) add(top, 'warning', `The page itself is ${fmtBytes(htmlBytes)}; minify it or move inline code to files.`, 'html-size');
  if (blockingScripts > 2) add(top, 'warning', `${blockingScripts} render-blocking scripts in the head.`, 'render-blocking');
  if (resources.length > 60) add(top, 'info', `${resources.length} requests; combining files and using sprites or SVG icons reduces them.`, 'requests');
  const external = resources.filter((r) => !r.path && /^(https?:)?\/\//i.test(r.ref));
  const hosts = new Set(external.map((r) => { try { return new URL(r.ref, 'https://x').host; } catch { return ''; } }).filter(Boolean));
  if (hosts.size > 3) add(top, 'info', `Resources come from ${hosts.size} other servers (${[...hosts].slice(0, 4).join(', ')}…); each one costs a connection. Consider <link rel="preconnect">.`, 'hosts');
  return { issues: out, totalBytes, htmlBytes, resources, unknown };
}
