/**
 * Building blocks for the built-in templates: a theme-driven base style sheet (modern CSS, no framework),
 * the page shell (header with brand and navigation, main, footer), and placeholder illustrations drawn
 * as small SVG files so templates need no external assets.
 */
import { esc, escAttr } from '../model/html';
import { relativeRef } from '../model/paths';

export const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, "Times New Roman", serif',
  humanist: '"Avenir Next", Avenir, "Segoe UI", "Gill Sans", Optima, Candara, sans-serif',
  mono: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace',
  slab: '"Rockwell", "Roboto Slab", "Courier New", Georgia, serif',
};

export interface Theme {
  font: string;
  heading?: string;
  bg: string; fg: string; muted: string; surface: string; border: string;
  accent: string; accentFg: string;
  radius?: string; maxw?: string;
  /** Colors for visitors who prefer a dark scheme. */
  dark?: Partial<Pick<Theme, 'bg' | 'fg' | 'muted' | 'surface' | 'border' | 'accent' | 'accentFg'>>;
}

const vars = (t: Partial<Theme>) => [
  t.bg && `--bg: ${t.bg};`, t.fg && `--fg: ${t.fg};`, t.muted && `--muted: ${t.muted};`, t.surface && `--surface: ${t.surface};`,
  t.border && `--border: ${t.border};`, t.accent && `--accent: ${t.accent};`, t.accentFg && `--accent-fg: ${t.accentFg};`,
].filter(Boolean).join(' ');

/** The base style sheet every template builds on. */
export function baseCss(t: Theme): string {
  return `/* Base styles: colors and fonts are custom properties, so changing the look starts here. */
:root {
  ${vars(t)}
  --radius: ${t.radius || '10px'}; --maxw: ${t.maxw || '68rem'}; --gutter: clamp(1rem, 4vw, 2rem);
  --font: ${t.font}; --heading-font: ${t.heading || t.font};
}
${t.dark ? `@media (prefers-color-scheme: dark) { :root { ${vars(t.dark)} } }\n` : ''}*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; font-family: var(--font); font-size: 1.0625rem; line-height: 1.65; color: var(--fg); background: var(--bg); }
img, svg, video { max-width: 100%; height: auto; }
img { display: block; }
h1, h2, h3, h4 { font-family: var(--heading-font); line-height: 1.2; margin: 0 0 .5em; text-wrap: balance; }
h1 { font-size: clamp(2rem, 5vw, 3.1rem); }
h2 { font-size: clamp(1.5rem, 3.2vw, 2.05rem); }
h3 { font-size: 1.25rem; }
p, ul, ol, dl, figure, table, blockquote, pre { margin: 0 0 1rem; }
a { color: var(--accent); text-underline-offset: .15em; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }
code, pre, kbd { font-family: ${FONTS.mono}; font-size: .92em; }
pre { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; overflow-x: auto; }
.skip-link { position: absolute; left: -999px; top: .5rem; padding: .5rem 1rem; background: var(--bg); color: var(--fg); border: 2px solid var(--accent); z-index: 10; }
.skip-link:focus { left: .5rem; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.wrap { width: min(100% - 2 * var(--gutter), var(--maxw)); margin-inline: auto; }
.site-header { background: var(--surface); border-bottom: 1px solid var(--border); }
.site-header .wrap { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem 2rem; padding-block: 1rem; }
.brand { font-family: var(--heading-font); font-weight: 700; font-size: 1.3rem; color: var(--fg); text-decoration: none; }
.brand small { display: block; font-family: var(--font); font-weight: 400; font-size: .8rem; color: var(--muted); }
.site-nav ul { display: flex; flex-wrap: wrap; gap: .25rem; list-style: none; margin: 0; padding: 0; }
.site-nav a { display: block; padding: .4rem .8rem; border-radius: 999px; color: var(--fg); text-decoration: none; }
.site-nav a:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.site-nav a[aria-current="page"] { background: var(--accent); color: var(--accent-fg); }
main { display: block; }
.page { padding-block: clamp(2rem, 6vw, 4rem); }
.section { padding-block: clamp(2.5rem, 7vw, 5rem); }
.section.alt { background: var(--surface); border-block: 1px solid var(--border); }
.hero { padding-block: clamp(3rem, 10vw, 7rem); background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, var(--bg)), var(--bg) 70%); }
.eyebrow { text-transform: uppercase; letter-spacing: .12em; font-size: .8rem; font-weight: 700; color: var(--accent); margin-bottom: .5rem; }
.lead { font-size: clamp(1.1rem, 2vw, 1.3rem); color: var(--muted); max-width: 62ch; }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.5rem; }
.button { display: inline-block; padding: .7rem 1.3rem; border-radius: var(--radius); background: var(--accent); color: var(--accent-fg); border: 2px solid var(--accent); text-decoration: none; font-weight: 600; line-height: 1.3; }
.button:hover { filter: brightness(1.08); }
.button.ghost { background: transparent; color: var(--accent); }
.grid { display: grid; gap: clamp(1rem, 2.5vw, 1.75rem); grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--min, 16rem)), 1fr)); }
.card { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.4rem; }
.card > :last-child { margin-bottom: 0; }
.section.alt .card { background: var(--bg); }
.muted { color: var(--muted); }
.center { text-align: center; }
.center .lead { margin-inline: auto; }
.split { display: grid; gap: clamp(1.5rem, 4vw, 3rem); grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); align-items: center; }
.prose { max-width: 70ch; }
.prose img, figure img { border-radius: var(--radius); }
figcaption { font-size: .9rem; color: var(--muted); margin-top: .4rem; }
blockquote { border-left: 4px solid var(--accent); margin-left: 0; padding: .25rem 0 .25rem 1rem; font-style: italic; }
table { border-collapse: collapse; width: 100%; }
caption { text-align: left; font-weight: 700; padding-bottom: .5rem; }
th, td { text-align: left; padding: .6rem .75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { background: var(--surface); }
.table-scroll { overflow-x: auto; }
form .field { display: grid; gap: .3rem; margin-bottom: 1rem; }
label { font-weight: 600; }
input, textarea, select { font: inherit; padding: .65rem .8rem; border: 1px solid var(--border); border-radius: calc(var(--radius) / 1.5); background: var(--bg); color: var(--fg); width: 100%; }
button { font: inherit; cursor: pointer; }
.hint { font-size: .9rem; color: var(--muted); }
.site-footer { border-top: 1px solid var(--border); background: var(--surface); padding-block: 2rem; color: var(--muted); font-size: .95rem; }
.site-footer .wrap { display: flex; flex-wrap: wrap; gap: 1rem 2rem; justify-content: space-between; }
.site-footer a { color: inherit; }
.site-footer p { margin: 0; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } html { scroll-behavior: auto; } }
@media print { .site-header, .site-footer, .skip-link { display: none; } body { background: #fff; color: #000; } a { color: inherit; } }
`;
}

/** A complete HTML5 document. `css` are style sheet links as written. */
export function doc(o: { title: string; desc?: string; css?: string[]; body: string; lang?: string; head?: string }): string {
  return `<!DOCTYPE html>
<html lang="${escAttr(o.lang || 'en')}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(o.title)}</title>
${o.desc ? `  <meta name="description" content="${escAttr(o.desc)}">\n` : ''}${(o.css || []).map((h) => `  <link rel="stylesheet" href="${escAttr(h)}">\n`).join('')}${o.head ? o.head.replace(/^/gm, '  ') + '\n' : ''}</head>
<body>
${o.body.trim()}
</body>
</html>
`;
}

export interface NavItem { path: string; label: string }

export function navMarkup(items: NavItem[], from: string, opts: { current?: boolean } = {}): string {
  return `<nav class="site-nav" aria-label="Main">
      <ul>
${items.map((i) => `        <li><a href="${escAttr(relativeRef(from, i.path))}"${opts.current !== false && i.path === from ? ' aria-current="page"' : ''}>${esc(i.label)}</a></li>`).join('\n')}
      </ul>
    </nav>`;
}

export interface SitePage { path: string; title: string; /** Label in the navigation (pages without one are not listed). */ nav?: string; desc?: string; body: string; /** Wrap the body in .wrap.page (default true). */ wrap?: boolean; bodyClass?: string }

export interface SiteSpec {
  name: string; tagline?: string; theme: Theme; css?: string; pages: SitePage[];
  footer?: string; cssPath?: string; lang?: string;
}

/** Writes every page of a site with a shared header, navigation and footer, and the style sheet. */
export function buildSite(s: SiteSpec): Record<string, string> {
  const cssPath = s.cssPath || 'css/site.css';
  const nav = s.pages.filter((p) => p.nav).map((p) => ({ path: p.path, label: p.nav! }));
  const files: Record<string, string> = { [cssPath]: baseCss(s.theme) + (s.css ? `\n/* ${s.name} */\n${s.css.trim()}\n` : '') };
  const home = s.pages[0].path;
  for (const p of s.pages) {
    const body = `<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${escAttr(relativeRef(p.path, home))}">${esc(s.name)}${s.tagline ? `<small>${esc(s.tagline)}</small>` : ''}</a>
    ${navMarkup(nav, p.path)}
  </div>
</header>
<main id="main"${p.wrap === false ? '' : ' class="wrap page"'}>
${p.body.trim()}
</main>
<footer class="site-footer">
  <div class="wrap">
    ${(s.footer || `<p>&copy; 2026 ${esc(s.name)}</p>`).trim()}
  </div>
</footer>`;
    files[p.path] = doc({ title: p.path === home ? `${s.name}${s.tagline ? ` – ${s.tagline}` : ''}` : `${p.title} – ${s.name}`, desc: p.desc, css: [relativeRef(p.path, cssPath)], body, lang: s.lang });
    if (p.bodyClass) files[p.path] = files[p.path].replace('<body>', `<body class="${escAttr(p.bodyClass)}">`);
  }
  return files;
}

/** Links within a site page body: `href="${ln(from, to)}"`. */
export const ln = (from: string, to: string) => escAttr(relativeRef(from, to));

// ------------------------------------------------------------------------------------------
// Placeholder pictures (small SVG files, original artwork)

const PALETTES: [string, string, string, string][] = [
  ['#ffd7a8', '#ff9a76', '#5b8c5a', '#2f5d50'], ['#cde7ff', '#8ec5fc', '#6a8caf', '#34495e'], ['#fce1f0', '#e0aaff', '#7b6d8d', '#3c2f4d'],
  ['#fff1c1', '#ffcf66', '#a3b18a', '#3a5a40'], ['#d8f3dc', '#95d5b2', '#52796f', '#2d3e40'], ['#ffe5d9', '#ffb4a2', '#b5838d', '#6d6875'],
  ['#e0fbfc', '#98c1d9', '#3d5a80', '#293241'], ['#f8edeb', '#fec89a', '#d4a373', '#7f5539'], ['#edf6f9', '#83c5be', '#006d77', '#073b4c'],
];

/** A landscape-style placeholder picture: sky, sun and two hills, different for each seed. */
export function artSvg(seed: number, title: string, w = 800, h = 600): string {
  const [sky1, sky2, hill1, hill2] = PALETTES[seed % PALETTES.length];
  const sx = 120 + ((seed * 97) % (w - 240)), sy = 90 + ((seed * 53) % Math.round(h / 3));
  const y1 = Math.round(h * 0.62), y2 = Math.round(h * 0.75);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">
  <title>${esc(title)}</title>
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky2}"/><stop offset="1" stop-color="${sky1}"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#s)"/>
  <circle cx="${sx}" cy="${sy}" r="${Math.round(h / 9)}" fill="#fff" fill-opacity=".75"/>
  <path d="M0 ${y1} C ${w * 0.25} ${y1 - h * 0.18}, ${w * 0.5} ${y1 + h * 0.06}, ${w} ${y1 - h * 0.1} V ${h} H 0 Z" fill="${hill1}"/>
  <path d="M0 ${y2} C ${w * 0.3} ${y2 - h * 0.08}, ${w * 0.7} ${y2 + h * 0.08}, ${w} ${y2 - h * 0.04} V ${h} H 0 Z" fill="${hill2}"/>
</svg>
`;
}

/** A simple portrait placeholder (head and shoulders). */
export function avatarSvg(seed: number, title: string): string {
  const [bg, , fg, dark] = PALETTES[seed % PALETTES.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img">
  <title>${esc(title)}</title>
  <rect width="200" height="200" fill="${bg}"/>
  <circle cx="100" cy="80" r="38" fill="${fg}"/>
  <path d="M30 200 C 36 140, 164 140, 170 200 Z" fill="${dark}"/>
</svg>
`;
}
