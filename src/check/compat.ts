/**
 * Browser compatibility checking.
 *
 * Legacy problems: obsolete elements and attributes, browser plugins (Flash, Java, ActiveX, Silverlight),
 * Internet Explorer conditional comments and CSS hacks, script APIs that browsers removed or deprecated
 * (document.write, synchronous XMLHttpRequest, attachEvent, showModalDialog, mutation events…), CSS that
 * only works with a vendor prefix, and resources loaded over plain HTTP (mixed content on HTTPS sites).
 *
 * With `modern`, also lists newer platform features with the year they reached all major browsers
 * ("Baseline"), or a note when they have not yet, so authors who support older browsers can test.
 */
import { parseHtml, findAll, attr, hasAttr, LineIndex, OBSOLETE_ELEMENTS, type HNode, type Issue, type Severity } from './validate';

export interface CompatOptions {
  /** Also report newer features (with the year all major browsers supported them). */
  modern?: boolean;
  /** Linked style sheets and scripts to check too (site files). */
  files?: { path: string; text: string }[];
}

/** Standard CSS properties whose prefixed forms should come with the unprefixed one. */
const STANDARD = new Set(('align-content align-items align-self animation animation-delay animation-direction animation-duration animation-fill-mode animation-iteration-count animation-name animation-play-state animation-timing-function appearance backface-visibility backdrop-filter background-clip background-origin background-size border-bottom-left-radius border-bottom-right-radius border-image border-radius border-top-left-radius border-top-right-radius box-decoration-break box-shadow box-sizing clip-path column-count column-gap column-rule column-width columns filter flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap font-feature-settings hyphens justify-content mask mask-image order perspective perspective-origin placeholder tab-size text-decoration-color text-decoration-line text-decoration-style text-emphasis text-size-adjust transform transform-origin transform-style transition transition-delay transition-duration transition-property transition-timing-function user-select writing-mode grid grid-template-columns grid-template-rows grid-column grid-row grid-gap gap print-color-adjust text-align-last font-kerning sticky').split(' '));

interface Rule { re: RegExp; severity: Severity; message: string; modern?: boolean }

const SCRIPT_RULES: Rule[] = [
  { re: /\bdocument\.write(ln)?\s*\(/g, severity: 'warning', message: 'document.write() blocks page loading and is ignored in some cases (Chrome blocks it on slow connections for scripts it inserts). Insert elements with the DOM instead.' },
  { re: /\.open\s*\(\s*['"`][A-Z]+['"`]\s*,[^;]*?,\s*false\s*[,)]/g, severity: 'warning', message: 'Synchronous XMLHttpRequest freezes the page and is deprecated on the main thread; use fetch() or an asynchronous request.' },
  { re: /\bdocument\.all\b/g, severity: 'warning', message: 'document.all is an Internet Explorer leftover; use document.getElementById or querySelector.' },
  { re: /\battachEvent\s*\(/g, severity: 'warning', message: 'attachEvent() exists only in old Internet Explorer; use addEventListener().' },
  { re: /\bnew\s+ActiveXObject\s*\(/g, severity: 'error', message: 'ActiveXObject exists only in Internet Explorer.' },
  { re: /\bshowModalDialog\s*\(/g, severity: 'error', message: 'showModalDialog() was removed from browsers; use the <dialog> element.' },
  { re: /\bdocument\.layers\b/g, severity: 'error', message: 'document.layers is Netscape 4 only.' },
  { re: /\bopenDatabase\s*\(/g, severity: 'error', message: 'Web SQL (openDatabase) was removed from browsers; use IndexedDB.' },
  { re: /\bapplicationCache\b/g, severity: 'error', message: 'The application cache was removed from browsers; use a service worker.' },
  { re: /\bDOM(NodeInserted|NodeRemoved|SubtreeModified|AttrModified|CharacterDataModified)\b/g, severity: 'warning', message: 'Mutation events were removed from current browsers; use MutationObserver.' },
  { re: /\bnavigator\.(appName|appVersion|userAgent)\b/g, severity: 'info', message: 'Browser sniffing through the user agent breaks with new browsers; test for the feature instead.' },
  { re: /\bwindow\.event\b/g, severity: 'info', message: 'window.event is deprecated; use the event passed to the handler.' },
  { re: /\b(un)?escape\s*\(/g, severity: 'info', message: 'escape() and unescape() are deprecated; use encodeURIComponent() and decodeURIComponent().' },
  { re: /\.keyCode\b|\.which\b|\.charCode\b/g, severity: 'info', message: 'keyCode, which and charCode are deprecated; use event.key or event.code.' },
  { re: /\bdocument\.execCommand\s*\(/g, severity: 'info', message: 'document.execCommand() is deprecated; it still works in editable regions but may change.' },
  { re: /\.substr\s*\(/g, severity: 'info', message: 'String.substr() is deprecated; use slice() or substring().' },
  { re: /addEventListener\s*\(\s*['"]unload['"]|\bonunload\s*=/g, severity: 'info', message: 'The unload event is deprecated and stops the back/forward cache; use pagehide or visibilitychange.' },
  { re: /\b(webkit|moz|ms|o)(RequestAnimationFrame|CancelAnimationFrame|Hidden|VisibilityState|IndexedDB|URL|AudioContext|RTCPeerConnection|GetUserMedia|RequestFullScreen|RequestFullscreen|ExitFullscreen|CancelFullScreen)\b/g, severity: 'info', message: 'A vendor-prefixed API; all current browsers have the standard name.' },
  { re: /__define(G|S)etter__|__lookup(G|S)etter__/g, severity: 'info', message: 'Legacy getter/setter functions; use Object.defineProperty or get/set syntax.' },
  { re: /\bevent\.returnValue\s*=/g, severity: 'info', message: 'event.returnValue is legacy; call event.preventDefault().' },
  { re: /\bdocument\.domain\s*=/g, severity: 'warning', message: 'Setting document.domain is being disabled by browsers; use postMessage between frames.' },
  // Newer features
  { re: /\bstructuredClone\s*\(/g, severity: 'info', message: 'structuredClone(): in all major browsers since 2022.', modern: true },
  { re: /\.(toSorted|toReversed|toSpliced|findLast|findLastIndex)\s*\(/g, severity: 'info', message: 'Array change-by-copy and findLast methods: in all major browsers since 2023.', modern: true },
  { re: /\b(Object|Map)\.groupBy\s*\(/g, severity: 'info', message: 'Object.groupBy / Map.groupBy: in all major browsers since 2024.', modern: true },
  { re: /\bPromise\.withResolvers\s*\(/g, severity: 'info', message: 'Promise.withResolvers(): in all major browsers since 2024.', modern: true },
  { re: /\.(union|intersection|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/g, severity: 'info', message: 'Set methods (union, intersection…): in all major browsers since 2024.', modern: true },
  { re: /\bTemporal\./g, severity: 'warning', message: 'Temporal is not yet supported by every major browser.', modern: true },
  { re: /\bURL\.(parse|canParse)\s*\(/g, severity: 'info', message: 'URL.parse() / URL.canParse(): in all major browsers since 2024.', modern: true },
  { re: /\bdocument\.startViewTransition\s*\(/g, severity: 'info', message: 'View transitions: in all major browsers only since 2025; older browsers skip the animation.', modern: true },
  { re: /\bnavigation\.(navigate|addEventListener|currentEntry)/g, severity: 'warning', message: 'The Navigation API is new; check support in Safari and older browsers.', modern: true },
];

const CSS_RULES: Rule[] = [
  { re: /\bexpression\s*\(/g, severity: 'error', message: 'CSS expression() worked only in old Internet Explorer.' },
  { re: /\bbehavior\s*:/g, severity: 'error', message: 'behavior (HTC files) worked only in Internet Explorer.' },
  { re: /progid\s*:\s*DXImageTransform|-ms-filter\s*:/g, severity: 'warning', message: 'Internet Explorer filters are ignored by every current browser; use opacity, filter or gradients.' },
  { re: /(^|[;{\s])[*_][a-z-]+\s*:/g, severity: 'info', message: 'An Internet Explorer 6/7 CSS hack (property starting with * or _); current browsers ignore it.' },
  { re: /-webkit-gradient\s*\(/g, severity: 'warning', message: 'The old -webkit-gradient() syntax; use linear-gradient() or radial-gradient().' },
  { re: /-webkit-overflow-scrolling\s*:/g, severity: 'info', message: '-webkit-overflow-scrolling no longer has any effect.' },
  { re: /\bzoom\s*:\s*1\b/g, severity: 'info', message: 'zoom: 1 was a hasLayout fix for old Internet Explorer.' },
  // Newer features
  { re: /:has\(/g, severity: 'info', message: 'The :has() selector: in all major browsers since December 2023.', modern: true },
  { re: /@container\b|container-type\s*:/g, severity: 'info', message: 'Container queries: in all major browsers since 2023.', modern: true },
  { re: /@layer\b/g, severity: 'info', message: 'Cascade layers (@layer): in all major browsers since 2022.', modern: true },
  { re: /\bsubgrid\b/g, severity: 'info', message: 'Subgrid: in all major browsers since 2023.', modern: true },
  { re: /color-mix\(|\boklch\(|\boklab\(|\blch\(/g, severity: 'info', message: 'color-mix() and OKLCH/LCH colors: in all major browsers since 2023.', modern: true },
  { re: /text-wrap\s*:\s*(balance|pretty)|text-wrap-style/g, severity: 'info', message: 'text-wrap: balance/pretty: balance since 2024; pretty is not yet in every browser (text still wraps normally).', modern: true },
  { re: /@property\b/g, severity: 'info', message: '@property: in all major browsers since 2024.', modern: true },
  { re: /@scope\b/g, severity: 'warning', message: '@scope is not supported in every major browser yet.', modern: true },
  { re: /anchor-name\s*:|position-anchor\s*:|\banchor\(/g, severity: 'warning', message: 'CSS anchor positioning is not supported in every major browser yet.', modern: true },
  { re: /field-sizing\s*:|interpolate-size\s*:|calc-size\(/g, severity: 'warning', message: 'This sizing feature is not supported in every major browser yet.', modern: true },
  { re: /@starting-style\b/g, severity: 'info', message: '@starting-style: in all major browsers since 2024.', modern: true },
  { re: /view-transition-name\s*:|@view-transition\b/g, severity: 'info', message: 'View transitions in CSS: in all major browsers only since 2025.', modern: true },
  { re: /appearance\s*:\s*base-select/g, severity: 'warning', message: 'Customizable select (appearance: base-select) is new; other browsers show a normal select.', modern: true },
  { re: /(^|[;{}]\s*)&[\s.:#\[>+~a-z]/g, severity: 'info', message: 'CSS nesting (&): in all major browsers since 2023; older browsers drop the nested rules.', modern: true },
];

function offsetIssue(lines: LineIndex, offset: number, severity: Severity, message: string, rule: string, path?: string): Issue {
  const p = lines.at(offset);
  return { line: p.line, col: p.col, severity, message, rule, offset, path };
}

/** Removes comments while keeping offsets (comments become spaces). */
function blankComments(code: string, css = false): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || (c === '`' && !css)) {
      const q = c;
      let j = i + 1;
      while (j < n && code[j] !== q) { if (code[j] === '\\') j++; if (code[j] === '\n' && q !== '`') break; j++; }
      out += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; out += code.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (!css && c === '/' && code[i + 1] === '/' && code[i - 1] !== ':') { let e = code.indexOf('\n', i); if (e < 0) e = n; out += ' '.repeat(e - i); i = e; continue; }
    out += c;
    i++;
  }
  return out;
}

/** Compatibility problems in a script's text. */
export function checkScript(code: string, base: number, lines: LineIndex, modern: boolean, path?: string): Issue[] {
  const out: Issue[] = [];
  const clean = blankComments(code);
  for (const r of SCRIPT_RULES) {
    if (r.modern && !modern) continue;
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = r.re.exec(clean)) && count < 5) { out.push(offsetIssue(lines, base + m.index, r.severity, r.message, r.modern ? 'modern' : 'script', path)); count++; }
  }
  return out;
}

/** Compatibility problems in CSS text (a style sheet, a <style> block or a style attribute). */
export function checkCss(css: string, base: number, lines: LineIndex, modern: boolean, path?: string, isAttr = false): Issue[] {
  const out: Issue[] = [];
  const clean = blankComments(css, true);
  for (const r of CSS_RULES) {
    if (r.modern && !modern) continue;
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = r.re.exec(clean)) && count < 5) { out.push(offsetIssue(lines, base + m.index + (m[1]?.length || 0), r.severity, r.message, r.modern ? 'modern' : 'css', path)); count++; }
  }
  // Prefixed properties and values without the standard form in the same rule.
  const blocks: [number, string][] = isAttr ? [[0, clean]] : [...clean.matchAll(/\{([^{}]*)\}/g)].map((m) => [m.index! + 1, m[1]]);
  for (const [at, body] of blocks) {
    const decls = [...body.matchAll(/([-\w]+)\s*:\s*([^;]*)/g)].map((m) => ({ prop: m[1].toLowerCase(), value: m[2].trim(), index: m.index! }));
    const props = new Set(decls.map((d) => d.prop));
    for (const d of decls) {
      const pm = /^-(webkit|moz|ms|o)-(.+)$/.exec(d.prop);
      if (pm && STANDARD.has(pm[2]) && !props.has(pm[2])) out.push(offsetIssue(lines, base + at + d.index, 'warning', `${d.prop} without the standard ${pm[2]}: browsers that do not use the -${pm[1]}- prefix ignore it. Add "${pm[2]}: ${d.value}".`, 'prefix', path));
      const vm = /^-(webkit|moz|ms|o)-(linear-gradient|radial-gradient|repeating-linear-gradient|repeating-radial-gradient|calc|flex|inline-flex|box|flexbox|inline-flexbox|sticky|grid|image-set|fit-content|min-content|max-content)\b/.exec(d.value);
      if (vm) {
        const std = vm[2] === 'box' || vm[2] === 'flexbox' ? 'flex' : vm[2] === 'inline-flexbox' ? 'inline-flex' : vm[2];
        const hasStd = decls.some((o) => o.prop === d.prop && o !== d && o.value.startsWith(std));
        if (!hasStd && !(vm[2] === 'box' && props.has('-webkit-line-clamp'))) out.push(offsetIssue(lines, base + at + d.index, 'warning', `${d.prop}: ${d.value.slice(0, 40)} uses a prefixed value; add the standard ${std}${/gradient|calc|image-set/.test(std) ? '()' : ''} as well.`, 'prefix', path));
      }
    }
  }
  for (const m of clean.matchAll(/@-(webkit|moz|o|ms)-keyframes\s+([-\w]+)/g)) {
    if (!new RegExp(`@keyframes\\s+${m[2]}\\b`).test(clean)) out.push(offsetIssue(lines, base + m.index!, 'warning', `@-${m[1]}-keyframes ${m[2]} without a standard @keyframes ${m[2]}.`, 'prefix', path));
  }
  return out;
}

const PLUGIN = /\.(swf|flv|class|jar|xap|mov|rm|ram|wmv|asf|mid|midi)(\?|\s|$)|shockwave|x-java|silverlight|x-ms-wmp|quicktime|realaudio|futuresplash|youtube\.com\/v\//i;

/** Checks a page (and optionally its linked files) for browser compatibility problems. */
export function checkCompat(src: string, opts: CompatOptions = {}): Issue[] {
  const { root, lines, tokens } = parseHtml(src);
  const modern = !!opts.modern;
  const out: Issue[] = [];
  const at = (n: { line: number; col: number; start?: number }, severity: Severity, message: string, rule: string) => out.push({ line: n.line, col: n.col, severity, message, rule, offset: n.start });
  const els = findAll(root, (n) => !n.foreign);

  for (const t of tokens) {
    if (t.type !== 'comment') continue;
    if (/^\[if\s/i.test(t.text) || /^\s*\[if\s/i.test(t.text)) at(t, 'info', 'Internet Explorer conditional comment: every current browser treats it as a plain comment (or shows its content to all browsers).', 'conditional');
  }
  for (const m of src.matchAll(/<!\[if\s[^\]]*\]>|<!\[endif\]>/gi)) out.push(offsetIssue(lines, m.index!, 'info', 'Downlevel-revealed conditional comment for Internet Explorer.', 'conditional'));

  for (const e of els) {
    const n = e.name;
    if (n in OBSOLETE_ELEMENTS) {
      const removed = ['applet', 'bgsound', 'blink', 'keygen', 'isindex', 'menuitem', 'multicol', 'spacer', 'nextid'].includes(n);
      at(e, removed ? 'error' : 'warning', `<${n}> ${removed ? 'is not supported by current browsers' : 'is obsolete'}. ${OBSOLETE_ELEMENTS[n]}`, 'obsolete');
    }
    if (n === 'object' || n === 'embed' || n === 'applet') {
      const blob = `${attr(e, 'type') || ''} ${attr(e, 'classid') || ''} ${attr(e, 'data') || ''} ${attr(e, 'src') || ''} ${attr(e, 'codebase') || ''} ${findAll(e, (c) => c.name === 'param').map((p) => attr(p, 'value') || '').join(' ')}`;
      if (n === 'applet' || PLUGIN.test(blob) || /clsid:/i.test(blob)) at(e, 'error', `This <${n}> needs a browser plugin (${/swf|shockwave|flash|futuresplash|youtube/i.test(blob) ? 'Flash' : /java|class|jar/i.test(blob) ? 'Java' : /silverlight|xap/i.test(blob) ? 'Silverlight' : /clsid/i.test(blob) ? 'ActiveX' : 'a media plugin'}); no current browser runs plugins. Use <video>, <audio>, <iframe> or JavaScript.`, 'plugin');
    }
    if (n === 'script') {
      const type = (attr(e, 'type') || '').toLowerCase();
      if (/vbscript/.test(type) || /vbscript/i.test(attr(e, 'language') || '')) at(e, 'error', 'VBScript runs only in old Internet Explorer.', 'script');
      const code = e.children.filter((c) => c.type === 'text').map((c) => c.text).join('');
      const first = e.children.find((c) => c.type === 'text');
      if (code.trim() && first && (!type || /javascript|ecmascript|module/.test(type))) out.push(...checkScript(code, first.start, lines, modern));
    }
    if (n === 'style') {
      const first = e.children.find((c) => c.type === 'text');
      if (first) out.push(...checkCss(first.text, first.start, lines, modern));
    }
    const style = e.attrs.find((a) => a.name === 'style');
    if (style?.value) out.push(...checkCss(style.value, style.start + 7, lines, modern, undefined, true));
    for (const a of e.attrs) if (/^on/.test(a.name) && a.value) out.push(...checkScript(a.value, a.start, lines, modern));
    if (n === 'meta') {
      const he = (attr(e, 'http-equiv') || '').toLowerCase();
      if (he === 'x-ua-compatible') at(e, 'info', 'X-UA-Compatible only affected Internet Explorer; it can be removed.', 'legacy');
      if (/^(page-enter|page-exit|site-enter|site-exit)$/.test(he)) at(e, 'info', 'Page transition meta tags worked only in Internet Explorer; use CSS view transitions.', 'legacy');
      if (he === 'imagetoolbar' || (attr(e, 'name') || '').toLowerCase() === 'mssmarttagspreventparsing') at(e, 'info', 'An Internet Explorer-only meta tag.', 'legacy');
    }
    if (n === 'html' && hasAttr(e, 'manifest')) at(e, 'error', 'The manifest attribute (application cache) was removed from browsers; use a service worker.', 'legacy');
    if (n === 'input' && /^datetime$/i.test(attr(e, 'type') || '')) at(e, 'warning', 'input type="datetime" was dropped; browsers show a text box. Use datetime-local.', 'legacy');
    if (n === 'frameset' || n === 'frame') at(e, 'warning', 'Frames are obsolete; search engines, bookmarks and small screens handle them poorly.', 'frames');
    // Mixed content
    const resAttr = n === 'img' || n === 'script' || n === 'iframe' || n === 'embed' || n === 'source' || n === 'video' || n === 'audio' || n === 'track' || n === 'input' ? 'src' : n === 'link' ? 'href' : n === 'object' ? 'data' : n === 'form' ? 'action' : null;
    const rv = resAttr ? attr(e, resAttr) : null;
    if (rv && /^http:\/\//i.test(rv.trim()) && !(n === 'link' && !/stylesheet|icon|preload|manifest/i.test(attr(e, 'rel') || ''))) {
      const blocking = n === 'script' || n === 'iframe' || n === 'link' || n === 'object' || n === 'embed' || n === 'form';
      at(e, blocking ? 'error' : 'warning', `<${n}> loads ${rv.slice(0, 70)} over plain HTTP; on an HTTPS site browsers ${blocking ? 'block it' : 'upgrade or block it'} (mixed content). Use https://.`, 'http');
    }
    const bg = attr(e, 'background');
    if (bg && /^http:\/\//i.test(bg)) at(e, 'warning', `Background ${bg.slice(0, 60)} loads over plain HTTP.`, 'http');
    // Newer HTML features
    if (modern) {
      if (hasAttr(e, 'popover') || hasAttr(e, 'popovertarget')) at(e, 'info', 'The popover attribute: in all major browsers since 2024.', 'modern');
      if (n === 'dialog') at(e, 'info', '<dialog>: in all major browsers since 2022.', 'modern');
      if (hasAttr(e, 'inert')) at(e, 'info', 'The inert attribute: in all major browsers since 2023.', 'modern');
      if (n === 'search') at(e, 'info', '<search>: in all major browsers since 2023; older browsers treat it as a plain block.', 'modern');
      if (n === 'details' && hasAttr(e, 'name')) at(e, 'info', 'Exclusive accordions (<details name>): in all major browsers since 2024.', 'modern');
      if (hasAttr(e, 'fetchpriority')) at(e, 'info', 'fetchpriority: in all major browsers since 2024 (a hint older browsers ignore).', 'modern');
      if (n === 'iframe' && attr(e, 'loading') === 'lazy') at(e, 'info', 'Lazy-loading iframes: in all major browsers since 2023.', 'modern');
      if (attr(e, 'hidden') === 'until-found') at(e, 'warning', 'hidden="until-found" is not supported by every browser; elsewhere the content stays hidden.', 'modern');
      if (hasAttr(e, 'closedby') || n === 'selectedcontent') at(e, 'warning', 'A very new feature that not every browser supports yet.', 'modern');
      if (n === 'img' && attr(e, 'src') && /\.avif(\?|$)/i.test(attr(e, 'src')!) && e.parent?.name !== 'picture') at(e, 'info', 'AVIF pictures: in all major browsers since 2024; use <picture> with a JPEG or PNG fallback for older ones.', 'modern');
    }
  }
  // Linked files
  for (const f of opts.files || []) {
    const li = new LineIndex(f.text);
    if (/\.css$/i.test(f.path)) out.push(...checkCss(f.text, 0, li, modern, f.path));
    else if (/\.m?js$/i.test(f.path)) out.push(...checkScript(f.text, 0, li, modern, f.path));
  }
  out.sort((a, b) => (a.path || '').localeCompare(b.path || '') || a.line - b.line || a.col - b.col);
  return out;
}

export type { HNode };
