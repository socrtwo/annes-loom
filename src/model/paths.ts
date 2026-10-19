/**
 * Site-relative paths. Every file in a site has a POSIX path without a leading slash
 * ("index.html", "css/site.css", "blog/2024/post.html"). Links inside pages are resolved
 * against the page's own folder, exactly as a web server would.
 */

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function extOf(path: string): string {
  const b = baseName(path);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/** Collapses "." and ".." segments and duplicate slashes. Paths never climb above the site root. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

/** True for links that leave the site: other schemes, protocol-relative URLs, fragments and data. */
export function isExternal(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#') || ref.startsWith('{') || ref.startsWith('<?') || ref.startsWith('$');
}

/** Splits "a/b.html?x=1#top" into the path and the "?x=1#top" suffix. */
export function splitRef(ref: string): [string, string] {
  const m = /^([^?#]*)(.*)$/.exec(ref)!;
  return [m[1], m[2]];
}

/**
 * Resolves a link written in `fromFile` to a site path, or null when it points outside the site.
 * Root-relative links ("/css/a.css") resolve against the site root.
 */
export function resolveRef(fromFile: string, ref: string): string | null {
  ref = ref.trim();
  if (!ref || isExternal(ref)) return null;
  let [p] = splitRef(ref);
  try { p = decodeURI(p); } catch { /* keep as written */ }
  if (!p) return null;
  const base = p.startsWith('/') ? '' : dirOf(fromFile);
  const r = joinPath(base, p);
  return p.endsWith('/') ? joinPath(r, 'index.html') : r;
}

/** The relative link from `fromFile` to `toPath` ("../img/a.png"). */
export function relativeRef(fromFile: string, toPath: string): string {
  const from = dirOf(fromFile).split('/').filter(Boolean);
  const to = toPath.split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  const rel = [...Array(up).fill('..'), ...to.slice(i)].join('/');
  return encodeURI(rel || baseName(toPath));
}

const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', shtml: 'text/html', php: 'application/x-httpd-php', asp: 'text/html', aspx: 'text/html', jsp: 'text/html',
  dwt: 'text/html', lbi: 'text/html', tpl: 'text/html', twig: 'text/html', hbs: 'text/html', liquid: 'text/html',
  css: 'text/css', scss: 'text/x-scss', less: 'text/x-less', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', json: 'application/json', map: 'application/json',
  xml: 'application/xml', rss: 'application/rss+xml', atom: 'application/atom+xml', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  htaccess: 'text/plain', webmanifest: 'application/manifest+json', ini: 'text/plain', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf', zip: 'application/zip', swf: 'application/x-shockwave-flash', wasm: 'application/wasm',
};

export function mimeOf(path: string): string {
  const b = baseName(path).toLowerCase();
  if (b === '.htaccess' || b === 'robots.txt' || b === 'cname') return 'text/plain';
  return MIME[extOf(path)] || 'application/octet-stream';
}

const TEXT_EXT = new Set(['html', 'htm', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'jsp', 'dwt', 'lbi', 'tpl', 'twig', 'hbs', 'liquid', 'css', 'scss', 'less', 'js', 'mjs', 'ts', 'json', 'map', 'xml', 'rss', 'atom', 'svg', 'txt', 'md', 'csv', 'webmanifest', 'ini', 'yml', 'yaml', 'toml', 'htaccess', 'inc', 'conf', 'py', 'rb', 'pl', 'cgi', 'sh', 'vue', 'jsx', 'tsx', 'sass', 'styl', 'ejs', 'njk', 'mustache']);

export function isTextPath(path: string): boolean {
  const e = extOf(path);
  const b = baseName(path).toLowerCase();
  return TEXT_EXT.has(e) || b === '.htaccess' || b === 'cname' || b === 'license' || b === 'readme' || (!e && !b.includes('.'));
}

/** Pages are files that open in the page editor (Design, Split, Code). */
export function isPagePath(path: string): boolean {
  return ['html', 'htm', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'jsp', 'dwt', 'lbi', 'tpl', 'twig', 'hbs', 'liquid', 'ejs', 'njk', 'mustache'].includes(extOf(path));
}

export function isImagePath(path: string): boolean {
  return mimeOf(path).startsWith('image/');
}

/** Turns any label into a safe file name ("About Us!" -> "about-us"). */
export function slugify(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
}
