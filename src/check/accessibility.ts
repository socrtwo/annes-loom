/**
 * Accessibility checker (WCAG 2.2 oriented).
 *
 * Works on the source tree from validate.ts, so every finding has a line. The checks are the ones a
 * program can make reliably from markup: text alternatives, names of links, buttons and form controls,
 * heading order, language, page title, landmarks, data tables, color contrast where both colors are
 * written in the page (inline styles, <font color>, body text/bgcolor), moving and autoplaying media,
 * frame titles, focus order, and basic ARIA misuse. A clean report does not mean a page is accessible:
 * reading order, meaningful alternatives and keyboard use still need a person.
 */
import { parseHtml, findAll, byName, attr, hasAttr, attrNode, textOf, ancestor, isInteractive, type HNode, type Issue, type Severity } from './validate';

export interface A11yIssue extends Issue { ref: string; level: 'A' | 'AA' | 'AAA' | 'Best practice' }

const WCAG: Record<string, [string, 'A' | 'AA' | 'AAA']> = {
  '1.1.1': ['Non-text Content', 'A'], '1.2.2': ['Captions (Prerecorded)', 'A'], '1.3.1': ['Info and Relationships', 'A'], '1.3.5': ['Identify Input Purpose', 'AA'], '1.4.2': ['Audio Control', 'A'], '1.4.3': ['Contrast (Minimum)', 'AA'], '1.4.4': ['Resize Text', 'AA'], '1.4.6': ['Contrast (Enhanced)', 'AAA'],
  '2.1.1': ['Keyboard', 'A'], '2.2.1': ['Timing Adjustable', 'A'], '2.2.2': ['Pause, Stop, Hide', 'A'], '2.4.1': ['Bypass Blocks', 'A'], '2.4.2': ['Page Titled', 'A'], '2.4.3': ['Focus Order', 'A'], '2.4.4': ['Link Purpose (In Context)', 'A'], '2.4.6': ['Headings and Labels', 'AA'], '2.4.7': ['Focus Visible', 'AA'],
  '2.5.3': ['Label in Name', 'A'], '3.1.1': ['Language of Page', 'A'], '3.1.2': ['Language of Parts', 'AA'], '3.2.5': ['Change on Request', 'AAA'], '3.3.2': ['Labels or Instructions', 'A'], '4.1.2': ['Name, Role, Value', 'A'],
};

export function wcagLabel(ref: string): string { const w = WCAG[ref]; return w ? `WCAG ${ref} ${w[0]} (${w[1]})` : ref; }

// --------------------------------------------------------------------------------------------
// Colors

const NAMED_COLORS: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080', silver: 'c0c0c0', maroon: '800000', purple: '800080', fuchsia: 'ff00ff', magenta: 'ff00ff', lime: '00ff00', olive: '808000', navy: '000080', teal: '008080', aqua: '00ffff', cyan: '00ffff', orange: 'ffa500',
  pink: 'ffc0cb', brown: 'a52a2a', gold: 'ffd700', beige: 'f5f5dc', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', coral: 'ff7f50', salmon: 'fa8072', tomato: 'ff6347', crimson: 'dc143c', indigo: '4b0082', violet: 'ee82ee', orchid: 'da70d6', plum: 'dda0dd', tan: 'd2b48c', wheat: 'f5deb3', linen: 'faf0e6', snow: 'fffafa',
  darkgray: 'a9a9a9', darkgrey: 'a9a9a9', lightgray: 'd3d3d3', lightgrey: 'd3d3d3', dimgray: '696969', dimgrey: '696969', gainsboro: 'dcdcdc', whitesmoke: 'f5f5f5', darkblue: '00008b', darkred: '8b0000', darkgreen: '006400', lightblue: 'add8e6', lightgreen: '90ee90', lightyellow: 'ffffe0', lightpink: 'ffb6c1', skyblue: '87ceeb', steelblue: '4682b4', royalblue: '4169e1',
  midnightblue: '191970', slategray: '708090', slategrey: '708090', darkslategray: '2f4f4f', forestgreen: '228b22', seagreen: '2e8b57', firebrick: 'b22222', chocolate: 'd2691e', sienna: 'a0522d', peru: 'cd853f', goldenrod: 'daa520', darkorange: 'ff8c00', orangered: 'ff4500', hotpink: 'ff69b4', deeppink: 'ff1493', turquoise: '40e0d0', aliceblue: 'f0f8ff', honeydew: 'f0fff0', mintcream: 'f5fffa', azure: 'f0ffff', ghostwhite: 'f8f8ff', floralwhite: 'fffaf0', oldlace: 'fdf5e6', seashell: 'fff5ee', cornsilk: 'fff8dc', lemonchiffon: 'fffacd', papayawhip: 'ffefd5', mistyrose: 'ffe4e1', rebeccapurple: '663399',
};

export interface RGBA { r: number; g: number; b: number; a: number }

/** Parses a CSS color (hex, rgb(), hsl(), named). Returns null for anything else (variables, gradients, currentColor). */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace(/\s*!important$/, '');
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  if (/^[0-9a-f]{6}$/.test(s)) return parseColor('#' + s); // legacy attribute values without "#"
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const ch = (v: string) => (v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v));
    const al = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: clamp(ch(m[1]), 0, 255), g: clamp(ch(m[2]), 0, 255), b: clamp(ch(m[3]), 0, 255), a: clamp(al, 0, 1) };
  }
  m = /^hsla?\(\s*([\d.-]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const [r, g, b] = hslToRgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    const al = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r, g, b, a: clamp(al, 0, 1) };
  }
  if (NAMED_COLORS[s]) return parseColor('#' + NAMED_COLORS[s]);
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

export function toHexColor(c: RGBA): string { return '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''); }

function luminance(c: RGBA): number {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** Composites a translucent color over an opaque one. */
function over(fg: RGBA, bg: RGBA): RGBA {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
}

/** WCAG contrast ratio of two colors (1 to 21). */
export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const b = bg.a < 1 ? over(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg;
  const f = fg.a < 1 ? over(fg, b) : fg;
  const l1 = luminance(f), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Declarations of a style attribute, lower-cased property names. */
export function parseStyle(style: string | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (style || '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k && v) m.set(k, v);
  }
  return m;
}

function backgroundOf(style: Map<string, string>): string | null {
  if (style.has('background-color')) return style.get('background-color')!;
  const bg = style.get('background');
  if (!bg) return null;
  if (/url\(|gradient\(/i.test(bg)) return 'image';
  const c = bg.split(/\s+(?![^(]*\))/).find((p) => parseColor(p));
  return c || null;
}

/** Font size in px when the inline style or <font size> says so. */
function fontSizePx(n: HNode): number | null {
  for (let e: HNode | null = n; e && e.type === 'el'; e = e.parent) {
    const st = parseStyle(attr(e, 'style'));
    const fs = st.get('font-size');
    if (fs) {
      const m = /^([\d.]+)(px|pt|em|rem|%)?$/.exec(fs.trim());
      if (m) { const v = parseFloat(m[1]); return m[2] === 'pt' ? v * 4 / 3 : m[2] === 'em' || m[2] === 'rem' ? v * 16 : m[2] === '%' ? v * 0.16 : v; }
      return null;
    }
    if (e.name === 'font' && attr(e, 'size')) return [10, 13, 16, 18, 24, 32, 48][clamp(parseInt(attr(e, 'size')!, 10) || 3, 1, 7) - 1];
    if (/^h[12]$/.test(e.name)) return e.name === 'h1' ? 32 : 24;
  }
  return null;
}
function isBold(n: HNode): boolean {
  for (let e: HNode | null = n; e && e.type === 'el'; e = e.parent) {
    if (/^(b|strong|h[1-6]|th)$/.test(e.name)) return true;
    const w = parseStyle(attr(e, 'style')).get('font-weight');
    if (w) return w === 'bold' || w === 'bolder' || parseInt(w, 10) >= 700;
  }
  return false;
}

// --------------------------------------------------------------------------------------------
// ARIA

const ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-biblioref doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph doc-epilogue doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-glossref doc-index doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc graphics-document graphics-object graphics-symbol').split(' '));
const ARIA_ATTRS = new Set(('activedescendant atomic autocomplete braillelabel brailleroledescription busy checked colcount colindex colindextext colspan controls current describedby description details disabled dropeffect errormessage expanded flowto grabbed haspopup hidden invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation owns placeholder posinset pressed readonly relevant required roledescription rowcount rowindex rowindextext rowspan selected setsize sort valuemax valuemin valuenow valuetext').split(' ').map((a) => 'aria-' + a));
const ARIA_BOOL = new Set(['aria-atomic', 'aria-busy', 'aria-disabled', 'aria-modal', 'aria-multiline', 'aria-multiselectable', 'aria-readonly', 'aria-required', 'aria-hidden']);
const ARIA_IDREFS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-flowto', 'aria-activedescendant', 'aria-errormessage', 'aria-details'];

/** Accessible name as far as markup can tell (aria-labelledby, aria-label, content, alt, title). */
export function accessibleName(n: HNode, root: HNode): string {
  const lb = attr(n, 'aria-labelledby');
  if (lb) { const t = lb.split(/\s+/).map((id) => { const e = findAll(root, (x) => attr(x, 'id') === id)[0]; return e ? textOf(e) : ''; }).join(' ').trim(); if (t) return t; }
  const al = attr(n, 'aria-label');
  if (al && al.trim()) return al.trim();
  const inner = contentName(n).trim();
  if (inner) return inner;
  return (attr(n, 'title') || '').trim();
}
function contentName(n: HNode): string {
  let s = '';
  for (const c of n.children) {
    if (c.type === 'text') s += textOf(c);
    else if (c.type === 'el') {
      if (attr(c, 'aria-hidden') === 'true' || c.name === 'script' || c.name === 'style') continue;
      if (c.name === 'img' || (c.name === 'input' && (attr(c, 'type') || '') === 'image')) s += ' ' + (attr(c, 'alt') || attr(c, 'aria-label') || '') + ' ';
      else if (c.name === 'svg') s += ' ' + (attr(c, 'aria-label') || (byName(c, 'title')[0] ? textOf(byName(c, 'title')[0]) : '')) + ' ';
      else s += attr(c, 'aria-label') || contentName(c);
    }
  }
  return s.replace(/\s+/g, ' ');
}

const GENERIC_LINK = /^(click here|click|here|more|read more|more info|more information|learn more|details|link|this|this link|go|continue|info|download|see more|view more|page)\.?$/i;

// --------------------------------------------------------------------------------------------
// The checker

export interface A11yOptions { /** Report AAA-level contrast (7:1) as well. */ aaa?: boolean }

export function checkAccessibility(src: string, opts: A11yOptions = {}): A11yIssue[] {
  const { root } = parseHtml(src);
  const out: A11yIssue[] = [];
  const add = (n: { line: number; col: number; start?: number }, severity: Severity, ref: string, message: string, rule: string) => {
    const w = WCAG[ref];
    out.push({ line: n.line, col: n.col, offset: n.start, severity, ref: w ? `WCAG ${ref}` : ref, level: w ? w[1] : 'Best practice', message, rule });
  };
  const top = { line: 1, col: 1, start: 0 };
  const els = findAll(root, (n) => !n.foreign || n.name === 'svg');
  const idMap = new Map<string, HNode[]>();
  for (const e of els) { const id = attr(e, 'id'); if (id) idMap.set(id, [...(idMap.get(id) || []), e]); }
  const hidden = (n: HNode) => !!ancestor(n, (a) => attr(a, 'aria-hidden') === 'true' || hasAttr(a, 'hidden')) || attr(n, 'aria-hidden') === 'true' || hasAttr(n, 'hidden');
  const isTemplateFile = /InstanceBeginEditable|TemplateBeginEditable|#BeginEditable/.test(src);

  // Page
  const html = byName(root, 'html')[0];
  const lang = html ? attr(html, 'lang') ?? attr(html, 'xml:lang') : null;
  if (!lang || !lang.trim()) add(html || top, 'error', '3.1.1', 'The page language is not set: add lang to <html> (for example lang="en") so screen readers pronounce the text correctly.', 'lang');
  else if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(lang.trim())) add(html!, 'error', '3.1.1', `lang="${lang}" is not a valid language tag.`, 'lang');
  for (const e of els) { const l = attr(e, 'lang'); if (e !== html && l != null && !/^([a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*)?$/.test(l.trim())) add(e, 'error', '3.1.2', `lang="${l}" is not a valid language tag.`, 'lang'); }
  const title = byName(root, 'title').find((t) => !t.foreign);
  if (!isTemplateFile && (!title || !textOf(title).trim())) add(title || top, 'error', '2.4.2', 'The page has no title; screen reader users hear the title first and use it to tell pages apart.', 'title');
  const body = byName(root, 'body')[0];

  // Viewport zoom and timed refresh
  for (const m of byName(root, 'meta')) {
    const name = (attr(m, 'name') || '').toLowerCase();
    const content = attr(m, 'content') || '';
    if (name === 'viewport') {
      if (/user-scalable\s*=\s*(no|0)/i.test(content)) add(m, 'error', '1.4.4', 'The viewport stops pinch zoom (user-scalable=no); people with low vision need to enlarge the page.', 'zoom');
      const mx = /maximum-scale\s*=\s*([\d.]+)/i.exec(content);
      if (mx && parseFloat(mx[1]) < 2) add(m, 'error', '1.4.4', `The viewport limits zoom to ${mx[1]}×; allow at least 2× (better: no maximum-scale).`, 'zoom');
    }
    if ((attr(m, 'http-equiv') || '').toLowerCase() === 'refresh') {
      const delay = parseFloat(content);
      if (delay > 0) add(m, 'error', '2.2.1', `The page refreshes or redirects itself after ${delay} seconds; users cannot stop or extend it.`, 'refresh');
    }
  }

  // Landmarks and bypass
  const mains = els.filter((e) => e.name === 'main' || attr(e, 'role') === 'main');
  if (!isTemplateFile && body && !mains.length) add(body, 'warning', '1.3.1', 'No <main> landmark: mark the main content with <main> so people can jump straight to it.', 'landmark');
  if (mains.filter((m) => !hasAttr(m, 'hidden')).length > 1) add(mains[1], 'error', '1.3.1', 'More than one visible main landmark.', 'landmark');
  const links = els.filter((e) => e.name === 'a' && hasAttr(e, 'href'));
  const skip = links.slice(0, 5).some((a) => /^#./.test(attr(a, 'href') || ''));
  const navs = els.filter((e) => e.name === 'nav' || attr(e, 'role') === 'navigation');
  if (body && !mains.length && !skip && links.length > 10) add(body, 'warning', '2.4.1', 'Many links and no way to skip them: add a "Skip to content" link or use <main> and <nav> landmarks.', 'bypass');
  if (navs.length > 1 && navs.filter((n) => !attr(n, 'aria-label') && !attr(n, 'aria-labelledby')).length > 1) add(navs[1], 'info', '1.3.1', 'Several <nav> regions without labels; give each an aria-label ("Main", "Footer") so they can be told apart.', 'landmark');

  // Headings
  const headings = els.filter((e) => /^h[1-6]$/.test(e.name) && !hidden(e));
  if (!headings.length && body && !isTemplateFile && textOf(body).trim().length > 400) add(body, 'warning', '1.3.1', 'The page has no headings; headings let screen reader users skim and jump through a page.', 'headings');
  let prev = 0;
  for (const hd of headings) {
    const lvl = +hd.name[1];
    if (!accessibleName(hd, root).trim()) add(hd, 'error', '2.4.6', `Empty heading <${hd.name}>.`, 'heading-empty');
    if (prev && lvl > prev + 1) add(hd, 'warning', '1.3.1', `Heading level skips from h${prev} to h${lvl}; use h${prev + 1} so the outline has no gaps.`, 'heading-order');
    if (!prev && lvl > 1 && headings.every((x) => x.name !== 'h1')) add(hd, 'info', 'Best practice', `The first heading is h${lvl}; pages usually start with one h1.`, 'heading-order');
    prev = lvl;
  }
  const h1s = headings.filter((x) => x.name === 'h1');
  if (h1s.length > 1) add(h1s[1], 'info', 'Best practice', `${h1s.length} h1 headings; most pages have one.`, 'heading-order');

  // Images
  for (const e of els) {
    if (hidden(e)) continue;
    const role = (attr(e, 'role') || '').toLowerCase();
    if (e.name === 'img') {
      const alt = attr(e, 'alt');
      if (alt == null && !attr(e, 'aria-label') && !attr(e, 'aria-labelledby') && role !== 'presentation' && role !== 'none') add(e, 'error', '1.1.1', `Picture without a text alternative (alt): ${attr(e, 'src') || ''}. Describe it, or write alt="" if it is decorative.`, 'img-alt');
      else if (alt != null) {
        const src = (attr(e, 'src') || '').split(/[?#]/)[0];
        const file = src.split('/').pop() || '';
        if (alt.trim() && file && (alt.trim().toLowerCase() === file.toLowerCase() || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(alt.trim()))) add(e, 'error', '1.1.1', `The alt text "${alt}" is a file name; describe the picture instead.`, 'img-alt');
        else if (/^(image|picture|photo|graphic|img|spacer|logo|icon|\s*)$/i.test(alt) && alt.trim()) add(e, 'warning', '1.1.1', `The alt text "${alt}" says nothing about the picture.`, 'img-alt');
        else if (/^(image|picture|photo|graphic) of /i.test(alt)) add(e, 'info', '1.1.1', 'Alt text need not start with "image of" or "picture of"; screen readers already say it is an image.', 'img-alt');
        if (alt.length > 150) add(e, 'info', '1.1.1', 'Very long alt text; put a long description in the page and keep alt short.', 'img-alt');
      }
    }
    if (e.name === 'area' && hasAttr(e, 'href') && !(attr(e, 'alt') || '').trim() && !attr(e, 'aria-label')) add(e, 'error', '1.1.1', 'Image map area without alt text.', 'img-alt');
    if (e.name === 'input' && (attr(e, 'type') || '').toLowerCase() === 'image' && !(attr(e, 'alt') || '').trim() && !attr(e, 'aria-label')) add(e, 'error', '1.1.1', 'Image button without alt text: say what the button does.', 'img-alt');
    if ((e.name === 'object' || e.name === 'embed') && !accessibleName(e, root).trim() && !attr(e, 'aria-label')) add(e, 'warning', '1.1.1', `<${e.name}> without a text alternative.`, 'img-alt');
    if (e.name === 'svg' && (role === 'img') && !accessibleName(e, root).trim()) add(e, 'error', '1.1.1', 'SVG with role="img" has no name (aria-label or <title>).', 'img-alt');
    if (role === 'img' && e.name !== 'svg' && !accessibleName(e, root).trim()) add(e, 'error', '1.1.1', `<${e.name} role="img"> has no name.`, 'img-alt');
  }

  // Links
  const linkTexts = new Map<string, Set<string>>();
  for (const a of links) {
    if (hidden(a)) continue;
    const name = accessibleName(a, root).trim();
    if (!name) add(a, 'error', '2.4.4', `Link without text: ${attr(a, 'href')}. Add link text, alt text on its picture, or aria-label.`, 'link-name');
    else if (GENERIC_LINK.test(name)) add(a, 'warning', '2.4.4', `Link text "${name}" does not say where it goes; describe the destination ("Read the pricing details").`, 'link-text');
    else if (/^(https?:\/\/|www\.)/i.test(name) && name.length > 40) add(a, 'info', '2.4.4', 'Link text is a long web address; screen readers read it character by character.', 'link-text');
    if (name) { const k = name.toLowerCase(); const s = linkTexts.get(k) || new Set(); s.add(attr(a, 'href') || ''); linkTexts.set(k, s); }
    if ((attr(a, 'target') || '') === '_blank' && !/new (window|tab)/i.test(name + (attr(a, 'title') || ''))) add(a, 'info', '3.2.5', `"${name.slice(0, 40)}" opens a new window without saying so.`, 'new-window');
    const href = attr(a, 'href') || '';
    if (/^javascript:/i.test(href)) add(a, 'warning', '4.1.2', 'Link with a javascript: address; use a <button> for actions.', 'link-js');
  }
  for (const [text, hrefs] of linkTexts) if (hrefs.size > 1 && !GENERIC_LINK.test(text)) {
    const a = links.find((l) => accessibleName(l, root).trim().toLowerCase() === text)!;
    add(a, 'info', '2.4.4', `Links with the same text "${text.slice(0, 40)}" go to ${hrefs.size} different places.`, 'link-text');
  }
  for (const a of els.filter((e) => e.name === 'a' && !hasAttr(e, 'href'))) {
    if (hasAttr(a, 'onclick') && !hasAttr(a, 'tabindex')) add(a, 'error', '2.1.1', 'A link without href that runs a script cannot be reached with the keyboard; give it an href or use a button.', 'keyboard');
  }

  // Buttons
  for (const b of els.filter((e) => e.name === 'button' || attr(e, 'role') === 'button')) {
    if (hidden(b)) continue;
    if (!accessibleName(b, root).trim()) add(b, 'error', '4.1.2', 'Button without a name: add text, or aria-label for an icon button.', 'button-name');
  }
  for (const i of els.filter((e) => e.name === 'input' && /^(submit|button|reset)$/i.test(attr(e, 'type') || ''))) {
    if ((attr(i, 'type') || '').toLowerCase() === 'button' && !(attr(i, 'value') || '').trim() && !attr(i, 'aria-label')) add(i, 'error', '4.1.2', '<input type="button"> without a value has no name.', 'button-name');
  }

  // Form controls
  const labelsFor = new Set(els.filter((e) => e.name === 'label' && attr(e, 'for')).map((e) => attr(e, 'for')!));
  const radiosByName = new Map<string, HNode[]>();
  for (const c of els.filter((e) => ['input', 'select', 'textarea'].includes(e.name))) {
    const type = (attr(c, 'type') || 'text').toLowerCase();
    if (c.name === 'input' && /^(hidden|submit|button|reset|image)$/.test(type)) continue;
    if (hidden(c)) continue;
    const id = attr(c, 'id');
    const labeled = (id && labelsFor.has(id)) || !!ancestor(c, (a) => a.name === 'label') || !!(attr(c, 'aria-label') || '').trim() || !!attr(c, 'aria-labelledby') || !!(attr(c, 'title') || '').trim();
    if (!labeled) add(c, 'error', '3.3.2', `Form field without a label (${c.name}${c.name === 'input' ? ` type=${type}` : ''}${attr(c, 'name') ? `, name=${attr(c, 'name')}` : ''}). Add <label for="…">.${attr(c, 'placeholder') ? ' Placeholder text is not a label: it disappears when typing.' : ''}`, 'label');
    if (type === 'radio' && attr(c, 'name')) radiosByName.set(attr(c, 'name')!, [...(radiosByName.get(attr(c, 'name')!) || []), c]);
    const ac = attr(c, 'autocomplete');
    if (ac === 'off' && /^(email|tel)$/.test(type)) add(c, 'info', '1.3.5', `autocomplete="off" on a ${type} field; let browsers fill in personal details (autocomplete="${type === 'email' ? 'email' : 'tel'}").`, 'autocomplete');
  }
  for (const [name, group] of radiosByName) if (group.length > 1 && !ancestor(group[0], (a) => a.name === 'fieldset' || attr(a, 'role') === 'radiogroup' || attr(a, 'role') === 'group')) add(group[0], 'warning', '1.3.1', `The radio buttons "${name}" are not grouped: put them in a <fieldset> with a <legend> that asks the question.`, 'fieldset');
  for (const f of els.filter((e) => e.name === 'fieldset')) if (!f.children.some((c) => c.name === 'legend')) add(f, 'warning', '1.3.1', '<fieldset> without a <legend>.', 'fieldset');

  // Tables
  for (const t of els.filter((e) => e.name === 'table')) {
    const role = (attr(t, 'role') || '').toLowerCase();
    if (role === 'presentation' || role === 'none') { if (findAll(t, (x) => x.name === 'th' || x.name === 'caption').length) add(t, 'error', '1.3.1', 'A layout table (role=presentation) has header cells or a caption.', 'table'); continue; }
    const rows = findAll(t, (x) => x.name === 'tr' && ancestor(x, (a) => a.name === 'table') === t);
    const ths = findAll(t, (x) => x.name === 'th');
    const cells = findAll(t, (x) => x.name === 'td');
    if (rows.length < 2 || cells.length < 2) continue;
    if (!ths.length) add(t, findAll(t, (x) => x.name === 'table').length || cells.length <= 3 ? 'info' : 'warning', '1.3.1', 'Table without header cells: mark headers with <th> (or role="presentation" if the table only lays out the page; better, use CSS for layout).', 'table');
    else {
      const colHeads = ths.some((th) => ancestor(th, (a) => a.name === 'thead') || rows[0].children.includes(th));
      const rowHeads = ths.some((th) => !ancestor(th, (a) => a.name === 'thead') && !rows[0].children.includes(th));
      if (colHeads && rowHeads && ths.some((th) => !hasAttr(th, 'scope') && !hasAttr(th, 'id'))) add(t, 'warning', '1.3.1', 'The table has row and column headers; give each <th> scope="col" or scope="row".', 'table');
    }
    for (const th of ths) if (!textOf(th).trim() && !attr(th, 'aria-label')) add(th, 'warning', '1.3.1', 'Empty header cell <th>.', 'table');
    if (!t.children.some((c) => c.name === 'caption') && !attr(t, 'aria-label') && !attr(t, 'aria-labelledby')) add(t, 'info', 'Best practice', 'Data table without a <caption>.', 'table');
  }

  // Media and motion
  for (const m of els.filter((e) => e.name === 'video' || e.name === 'audio')) {
    if (hasAttr(m, 'autoplay') && !hasAttr(m, 'muted')) add(m, 'error', '1.4.2', `<${m.name}> plays sound automatically; add muted, or let the user start it.`, 'autoplay');
    if (hasAttr(m, 'autoplay') && hasAttr(m, 'loop') && m.name === 'video' && !hasAttr(m, 'controls')) add(m, 'warning', '2.2.2', 'Looping autoplay video without controls: users must be able to pause motion that lasts more than five seconds.', 'motion');
    if (m.name === 'video' && !m.children.some((c) => c.name === 'track' && /^(captions|subtitles)$/i.test(attr(c, 'kind') || 'subtitles'))) add(m, 'warning', '1.2.2', 'Video without captions (<track kind="captions">).', 'captions');
  }
  for (const e of els) if (e.name === 'marquee' || e.name === 'blink') add(e, 'error', '2.2.2', `<${e.name}> moves or flashes and cannot be paused.`, 'motion');
  for (const e of els) if (e.name === 'embed' || e.name === 'bgsound') { if (e.name === 'bgsound' || /\.(mp3|wav|mid|midi|ogg)$/i.test(attr(e, 'src') || '')) add(e, 'error', '1.4.2', 'Background sound plays without a way to stop it.', 'autoplay'); }
  for (const f of els.filter((e) => e.name === 'iframe' || e.name === 'frame')) if (!hidden(f) && !(attr(f, 'title') || '').trim() && !attr(f, 'aria-label')) add(f, 'error', '4.1.2', `<${f.name}> without a title: say what it contains (title="Map of our office").`, 'frame-title');

  // Focus and keyboard
  for (const e of els) {
    const ti = attr(e, 'tabindex');
    if (ti != null && parseInt(ti, 10) > 0) add(e, 'warning', '2.4.3', `tabindex="${ti}" changes the tab order; use 0 or -1 and order the markup instead.`, 'tabindex');
    if ((hasAttr(e, 'onclick') || hasAttr(e, 'onmousedown')) && !isInteractive(e) && !['a', 'body', 'html', 'label', 'summary', 'option'].includes(e.name) && !attr(e, 'role')) add(e, 'warning', '2.1.1', `<${e.name}> responds to clicks but cannot be reached or used with the keyboard; use a <button>, or add role, tabindex="0" and key handlers.`, 'keyboard');
    const st = parseStyle(attr(e, 'style'));
    if (/^(none|0)$/.test(st.get('outline') || '') && isInteractive(e)) add(e, 'warning', '2.4.7', 'outline: none hides where the keyboard focus is.', 'focus');
  }
  for (const s of els.filter((e) => e.name === 'style')) {
    const css = s.children.map((c) => c.text).join('');
    const re = /([^{}]*:focus[^{}]*)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) if (/outline\s*:\s*(none|0)\b/.test(m[2]) && !/box-shadow|border|background/.test(m[2])) add(s, 'warning', '2.4.7', `The style sheet removes the focus outline (${m[1].trim().slice(0, 50)}) without another focus style.`, 'focus');
  }
  const keys = new Map<string, HNode>();
  for (const e of els) { const k = attr(e, 'accesskey'); if (k) { if (keys.has(k.toLowerCase())) add(e, 'warning', 'Best practice', `Access key "${k}" is used twice.`, 'accesskey'); keys.set(k.toLowerCase(), e); } }

  // Ids
  for (const [id, list] of idMap) if (list.length > 1) {
    const referenced = els.some((e) => ARIA_IDREFS.some((a) => (attr(e, a) || '').split(/\s+/).includes(id)) || (e.name === 'label' && attr(e, 'for') === id));
    add(list[1], referenced ? 'error' : 'warning', referenced ? '4.1.2' : '1.3.1', `Duplicate id "${id}"${referenced ? ', and a label or ARIA reference uses it: assistive technology finds the wrong element' : ''}.`, 'dup-id');
  }

  // ARIA
  for (const e of els) {
    const role = attr(e, 'role');
    if (role != null) for (const r of role.trim().split(/\s+/).filter(Boolean)) if (!ROLES.has(r.toLowerCase())) add(attrNode(e, 'role')!, 'error', '4.1.2', `"${r}" is not an ARIA role.`, 'aria');
    for (const a of e.attrs) {
      if (!a.name.startsWith('aria-')) continue;
      if (!ARIA_ATTRS.has(a.name)) { add(a, 'error', '4.1.2', `${a.name} is not an ARIA attribute.`, 'aria'); continue; }
      if (ARIA_BOOL.has(a.name) && a.value != null && !/^(true|false)$/.test(a.value.trim())) add(a, 'error', '4.1.2', `${a.name}="${a.value}" must be "true" or "false".`, 'aria');
      if (ARIA_IDREFS.includes(a.name) && a.value) for (const id of a.value.trim().split(/\s+/)) if (!idMap.has(id)) add(a, 'error', '4.1.2', `${a.name} refers to "${id}", which is not an id on this page.`, 'aria');
    }
    if (attr(e, 'aria-hidden') === 'true') {
      const focusables = [e, ...findAll(e, () => true)].filter((x) => isInteractive(x) && attr(x, 'tabindex') !== '-1' && !hasAttr(x, 'disabled'));
      if (focusables.length) add(e, 'error', '4.1.2', 'aria-hidden="true" on content with focusable elements: keyboard users reach controls that screen readers cannot see. Use inert, or tabindex="-1".', 'aria-hidden');
    }
    if ((role === 'presentation' || role === 'none') && isInteractive(e)) add(e, 'error', '4.1.2', `role="${role}" on a focusable <${e.name}> is ignored and confusing.`, 'aria');
    const al = attr(e, 'aria-label');
    if (al != null && !al.trim()) add(attrNode(e, 'aria-label')!, 'warning', '4.1.2', 'Empty aria-label.', 'aria');
    if (al && (e.name === 'a' || e.name === 'button')) {
      const vis = contentName(e).trim().toLowerCase();
      if (vis && vis.length > 2 && !al.toLowerCase().includes(vis)) add(e, 'warning', '2.5.3', `The visible text "${vis.slice(0, 30)}" is not part of the aria-label "${al.slice(0, 30)}"; voice users say what they see.`, 'label-in-name');
    }
    if (/^(div|span)$/.test(e.name) && al && !role) add(e, 'info', '4.1.2', `aria-label on a <${e.name}> without a role is ignored by most screen readers.`, 'aria');
  }

  // Contrast
  checkContrast(root, add, !!opts.aaa);

  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

type Adder = (n: { line: number; col: number; start?: number }, severity: Severity, ref: string, message: string, rule: string) => void;

function checkContrast(root: HNode, add: Adder, aaa: boolean): void {
  const body = byName(root, 'body')[0];
  const bodyStyle = body ? parseStyle(attr(body, 'style')) : new Map();
  const pageBg = parseColor(backgroundOf(bodyStyle) || (body ? attr(body, 'bgcolor') : null)) || null;
  const pageFg = parseColor(bodyStyle.get('color') || (body ? attr(body, 'text') : null));
  const bgFor = (n: HNode): { c: RGBA | null; image: boolean; assumed: boolean } => {
    for (let e: HNode | null = n; e && e.type === 'el'; e = e.parent) {
      const b = backgroundOf(parseStyle(attr(e, 'style'))) || attr(e, 'bgcolor');
      if (b === 'image') return { c: null, image: true, assumed: false };
      const c = parseColor(b);
      if (c && c.a > 0) return { c, image: false, assumed: false };
      if (e.name === 'body') break;
    }
    return pageBg ? { c: pageBg, image: false, assumed: false } : { c: { r: 255, g: 255, b: 255, a: 1 }, image: false, assumed: true };
  };
  const checked = new Set<HNode>();
  const consider = (e: HNode, fgText: string | null) => {
    const fg = parseColor(fgText);
    if (!fg) return;
    if (!textOf(e).trim()) return;
    const bg = bgFor(e);
    if (bg.image || !bg.c) return;
    const ratio = contrastRatio(fg, bg.c);
    const px = fontSizePx(e);
    const large = px != null && (px >= 24 || (px >= 18.66 && isBold(e)));
    const need = large ? 3 : 4.5;
    const r = Math.round(ratio * 100) / 100;
    if (ratio < need) add(e, bg.assumed ? 'warning' : 'error', '1.4.3', `Text contrast ${r}:1 (${toHexColor(fg)} on ${toHexColor(bg.c)}${bg.assumed ? ', assuming a white page' : ''}) is below ${need}:1${large ? ' for large text' : ''}.`, 'contrast');
    else if (aaa && ratio < (large ? 4.5 : 7)) add(e, 'info', '1.4.6', `Text contrast ${r}:1 is below the enhanced ${large ? 4.5 : 7}:1.`, 'contrast');
  };
  for (const e of findAll(root, (n) => !n.foreign)) {
    if (checked.has(e)) continue;
    const st = parseStyle(attr(e, 'style'));
    if (st.has('color')) { consider(e, st.get('color')!); checked.add(e); continue; }
    if (e.name === 'font' && attr(e, 'color')) { consider(e, attr(e, 'color')); checked.add(e); continue; }
    // A background set without a text color: the text keeps the inherited (page) color.
    const bgv = backgroundOf(st) || attr(e, 'bgcolor');
    if (bgv && bgv !== 'image' && e.name !== 'body' && e.children.some((c) => c.type === 'text' && c.text.trim())) {
      let fg: string | null = null;
      for (let p = e.parent; p && p.type === 'el'; p = p.parent) { const c = parseStyle(attr(p, 'style')).get('color') || (p.name === 'font' ? attr(p, 'color') : null); if (c) { fg = c; break; } }
      if (!fg) fg = pageFg ? toHexColor(pageFg) : '#000000';
      consider(e, fg);
    }
  }
  if (body && pageFg && pageBg) {
    const ratio = contrastRatio(pageFg, pageBg);
    if (ratio < 4.5) add(body, 'error', '1.4.3', `The page text color ${toHexColor(pageFg)} on ${toHexColor(pageBg)} has a contrast of ${Math.round(ratio * 100) / 100}:1 (needs 4.5:1).`, 'contrast');
  }
}
