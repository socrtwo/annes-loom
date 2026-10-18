/**
 * Markup generators for the Insert commands: media, embeds, web components, head tags, server code,
 * symbols, clip art and frameworks. Every function here is pure (text in, text out) so that it can be
 * unit-tested and reused by panes, macros and the AI layer. All markup and CSS is original work.
 *
 * Components return { html, css, key }: the command inserts `html` at the cursor and appends `css`
 * once into the page's head <style> block (guarded by a marker comment, see ensureCss()).
 */
import { esc, escAttr, editHeadStyle, headInsert, regions } from '../model/html';

export interface Component { html: string; css?: string; key?: string }

const a = escAttr;
let uidCounter = 0;
/** A short id that is unique within this session ("ql-tabs-3k9"). */
export function uid(prefix = 'ql'): string {
  return `${prefix}-${(Date.now() % 46656).toString(36)}${(uidCounter++).toString(36)}`;
}

/** Attribute string from a map; booleans become bare attributes, null/false/'' are left out. */
export function attrs(map: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(map)
    .filter(([, v]) => v != null && v !== false && v !== '')
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${a(String(v))}"`))
    .join('');
}

/** Runs a script when the DOM is ready (the inserted script may come before the elements it wires up). */
export function onReady(guard: string, body: string): string {
  return `<script>(function(){if(window.${guard})return;window.${guard}=1;function f(){${body}}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',f);else f();})();</script>`;
}

/** Adds CSS to the head <style> block once; the marker comment keeps a second insert from duplicating it. */
export function ensureCss(src: string, key: string, css: string): string {
  const marker = `/* ql:${key} */`;
  if (!css || src.includes(marker)) return src;
  const body = css.trim().split('\n').map((l) => '    ' + l.trim()).join('\n');
  return editHeadStyle(src, (c) => `${c.replace(/\s*$/, '')}\n    ${marker}\n${body}\n  `);
}

/** Inserts a tag into the head unless an identical one is already there. */
export function headOnce(src: string, tag: string): string {
  return src.includes(tag) ? src : headInsert(src, tag);
}

/** Inserts markup just before </body> (for scripts that belong at the end of the page). */
export function bodyEndInsert(src: string, markup: string): string {
  const r = regions(src);
  if (r.bodyClose < 0) return src + '\n' + markup + '\n';
  return src.slice(0, r.bodyClose).replace(/[ \t]*$/, '') + markup + '\n' + src.slice(r.bodyClose);
}

/** Replaces the head <link rel="…"> (canonical, icon…) or adds it. */
export function setLinkRel(src: string, rel: string, tag: string): string {
  const re = new RegExp(`<link\\b[^>]*\\brel\\s*=\\s*["']${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
  if (re.test(src)) return src.replace(re, () => tag);
  return headInsert(src, tag);
}

/** Every id="…" in a page (bookmark targets). */
export function idsIn(src: string): string[] {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(src)?.[1] ?? src;
  const out = new Set<string>();
  for (const m of body.matchAll(/<[a-zA-Z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/g)) if (!/^ql-insert-/.test(m[1])) out.add(m[1]);
  return [...out];
}

export function slugId(s: string, taken: Set<string> = new Set()): string {
  const base = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
  let id = /^[a-z]/.test(base) ? base : 's-' + base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

// ------------------------------------------------------------------------------------------
// Text, links and pictures

export function linkMarkup(o: { href: string; text: string; title?: string; target?: string; rel?: string; download?: boolean; html?: boolean }): string {
  let rel = o.rel || '';
  if (o.target === '_blank' && !/noopener/.test(rel)) rel = (rel + ' noopener').trim();
  return `<a${attrs({ href: o.href, title: o.title, target: o.target, rel, download: o.download })}>${o.html ? o.text : esc(o.text || o.href)}</a>`;
}

export function emailLink(email: string, text?: string, subject?: string, body?: string): string {
  const q = [subject ? `subject=${encodeURIComponent(subject)}` : '', body ? `body=${encodeURIComponent(body)}` : ''].filter(Boolean).join('&');
  return `<a href="mailto:${a(email)}${q ? '?' + a(q) : ''}">${esc(text || email)}</a>`;
}

/** Splits text into list items: one per line (selection text or a default). */
export function listMarkup(tag: 'ul' | 'ol', lines: string[], opts: { type?: string; start?: number } = {}): string {
  const items = (lines.length ? lines : ['Item 1', 'Item 2', 'Item 3']).map((l) => `  <li>${l}</li>`).join('\n');
  return `<${tag}${attrs({ type: opts.type, start: opts.start && opts.start !== 1 ? opts.start : null })}>\n${items}\n</${tag}>`;
}

export function definitionList(pairs: [string, string][]): string {
  const p = pairs.length ? pairs : [['Term', 'Definition'] as [string, string]];
  return `<dl>\n${p.map(([t, d]) => `  <dt>${t}</dt>\n  <dd>${d}</dd>`).join('\n')}\n</dl>`;
}

export function imageMarkup(o: { src: string; alt: string; width?: number | null; height?: number | null; title?: string; lazy?: boolean; href?: string; caption?: string; className?: string; style?: string }): string {
  const img = `<img${attrs({ src: o.src, alt: o.alt ?? '', width: o.width || null, height: o.height || null, title: o.title, loading: o.lazy ? 'lazy' : null, decoding: o.lazy ? 'async' : null, class: o.className, style: o.style })}>`;
  const linked = o.href ? `<a href="${a(o.href)}">${img}</a>` : img;
  return o.caption ? `<figure>\n  ${linked}\n  <figcaption>${esc(o.caption)}</figcaption>\n</figure>` : linked;
}

export interface PictureSource { srcset: string; type?: string; media?: string }
export function pictureMarkup(o: { src: string; alt: string; sources: PictureSource[]; width?: number | null; height?: number | null }): string {
  const s = o.sources.filter((x) => x.srcset).map((x) => `  <source${attrs({ srcset: x.srcset, type: x.type, media: x.media })}>`).join('\n');
  return `<picture>\n${s ? s + '\n' : ''}  <img${attrs({ src: o.src, alt: o.alt ?? '', width: o.width || null, height: o.height || null, loading: 'lazy' })}>\n</picture>`;
}

/** Guesses the media type of a source from its extension (for <source type>). */
export function typeOfRef(ref: string): string {
  const e = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(ref)?.[1]?.toLowerCase() || '';
  return ({ webp: 'image/webp', avif: 'image/avif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', jxl: 'image/jxl', mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', vtt: 'text/vtt' } as Record<string, string>)[e] || '';
}

/** A placeholder picture as an SVG data: URL of the given size. */
export function placeholderSvg(w: number, h: number, label = `${w} × ${h}`, bg = '#d9dde3', fg = '#5f6b7a'): string {
  const fs = Math.max(10, Math.round(Math.min(w, h) / 8));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${bg}"/><path d="M0 0L${w} ${h}M${w} 0L0 ${h}" stroke="${fg}" stroke-opacity=".25"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="${fs}" fill="${fg}">${esc(label)}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

export function imagePlaceholder(w: number, h: number, label?: string, bg?: string, fg?: string): string {
  return `<img src="${placeholderSvg(w, h, label || `${w} × ${h}`, bg, fg)}" width="${w}" height="${h}" alt="${a(label ? `Placeholder: ${label}` : 'Placeholder picture')}">`;
}

export interface MapArea { shape: 'rect' | 'circle' | 'poly' | 'default'; coords: string; href: string; alt: string }
/** Parses "rect 0,0,100,50 page.html Home page" lines. */
export function parseAreas(text: string): MapArea[] {
  const out: MapArea[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(rect|circle|poly|default)\s+([\d.,\s]*?)\s+(\S+)\s*(.*)$/i.exec(line);
    if (m) out.push({ shape: m[1].toLowerCase() as MapArea['shape'], coords: m[2].replace(/\s+/g, ''), href: m[3], alt: m[4].trim() || m[3] });
  }
  return out;
}
export function imageMapMarkup(o: { src: string; alt: string; name: string; areas: MapArea[]; width?: number | null; height?: number | null }): string {
  const areas = o.areas.map((x) => `  <area${attrs({ shape: x.shape, coords: x.shape === 'default' ? null : x.coords, href: x.href, alt: x.alt })}>`).join('\n');
  return `<img${attrs({ src: o.src, alt: o.alt, width: o.width || null, height: o.height || null, usemap: '#' + o.name })}>\n<map name="${a(o.name)}">\n${areas}\n</map>`;
}

export function rolloverImage(o: { src: string; over: string; alt: string; href?: string; width?: number | null; height?: number | null }): string {
  const img = `<img${attrs({ src: o.src, alt: o.alt, width: o.width || null, height: o.height || null, 'data-ql-rollover': o.over })}>`;
  return (o.href ? `<a href="${a(o.href)}">${img}</a>` : img) + '\n' + onReady('__qlRollover',
    "document.querySelectorAll('img[data-ql-rollover]').forEach(function(i){var s=i.getAttribute('src'),o=i.getAttribute('data-ql-rollover'),t=i.closest('a')||i;new Image().src=o;function on(){i.src=o}function off(){i.src=s}t.addEventListener('mouseenter',on);t.addEventListener('mouseleave',off);t.addEventListener('focus',on);t.addEventListener('blur',off);});");
}

export interface ButtonStyle { text: string; href: string; bg: string; color: string; hoverBg: string; hoverColor?: string; pressedBg: string; font?: string; size?: number; radius?: number; padX?: number; padY?: number; border?: string; bold?: boolean; newWindow?: boolean }
/** An interactive (hover / pressed) button made with CSS only: no pictures, works with the keyboard. */
export function interactiveButton(o: ButtonStyle, cls = uid('ql-ibtn')): Component {
  const html = linkMarkup({ href: o.href || '#', text: o.text || 'Button', target: o.newWindow ? '_blank' : undefined }).replace('<a ', `<a class="${a(cls)}" `);
  const css = `.${cls}{display:inline-block;padding:${o.padY ?? 10}px ${o.padX ?? 22}px;background:${o.bg};color:${o.color};font-family:${o.font || 'inherit'};font-size:${o.size ?? 16}px;font-weight:${o.bold === false ? 'normal' : '600'};border:${o.border || '0'};border-radius:${o.radius ?? 6}px;text-decoration:none;cursor:pointer;transition:background-color .15s,color .15s,transform .05s}
.${cls}:hover,.${cls}:focus-visible{background:${o.hoverBg};color:${o.hoverColor || o.color}}
.${cls}:focus-visible{outline:3px solid ${o.hoverBg};outline-offset:2px}
.${cls}:active{background:${o.pressedBg};transform:translateY(1px)}`;
  return { html, css, key: cls };
}

// ------------------------------------------------------------------------------------------
// Media and embeds

export function videoMarkup(o: { src: string; poster?: string; width?: number | null; height?: number | null; controls?: boolean; autoplay?: boolean; loop?: boolean; muted?: boolean; playsinline?: boolean; preload?: string; captions?: string; captionsLang?: string; title?: string }): string {
  const muted = o.muted || o.autoplay;
  const type = typeOfRef(o.src);
  const track = o.captions ? `\n  <track kind="captions" src="${a(o.captions)}" srclang="${a(o.captionsLang || 'en')}" label="Captions" default>` : '';
  return `<video${attrs({ width: o.width || null, height: o.height || null, poster: o.poster, controls: o.controls !== false, autoplay: o.autoplay, loop: o.loop, muted, playsinline: o.playsinline || o.autoplay, preload: o.preload && o.preload !== 'auto' ? o.preload : null, title: o.title })}>
  <source${attrs({ src: o.src, type })}>${track}
  <p>Your browser cannot play this video. <a href="${a(o.src)}">Download the video</a>.</p>
</video>`;
}

export function audioMarkup(o: { src: string; controls?: boolean; autoplay?: boolean; loop?: boolean; preload?: string; title?: string }): string {
  return `<audio${attrs({ controls: o.controls !== false, autoplay: o.autoplay, loop: o.loop, preload: o.preload && o.preload !== 'auto' ? o.preload : null, title: o.title })}>
  <source${attrs({ src: o.src, type: typeOfRef(o.src) })}>
  <p>Your browser cannot play this audio. <a href="${a(o.src)}">Download the audio</a>.</p>
</audio>`;
}

export function parseYouTubeId(s: string): string | null {
  s = s.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/))([\w-]{11})/i.exec(s);
  return m ? m[1] : null;
}
export function parseVimeoId(s: string): string | null {
  s = s.trim();
  if (/^\d{5,12}$/.test(s)) return s;
  const m = /vimeo\.com\/(?:video\/|channels\/[\w-]+\/|groups\/[\w-]+\/videos\/)?(\d{5,12})/i.exec(s);
  return m ? m[1] : null;
}
/** Seconds from "90", "1:30", "1m30s" or a ?t= / &t= value in a URL. */
export function parseStart(s: string): number {
  s = (s || '').trim();
  const t = /[?&#]t=([\dhms]+)/.exec(s)?.[1] ?? s;
  if (/^\d+$/.test(t)) return +t;
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (hms && t) return (+(hms[1] || 0)) * 3600 + (+(hms[2] || 0)) * 60 + (+(hms[3] || 0));
  const c = t.split(':').map(Number);
  if (c.length > 1 && c.every((n) => !isNaN(n))) return c.reduce((acc, n) => acc * 60 + n, 0);
  return 0;
}

function frame(src: string, title: string, w: number | null | undefined, h: number | null | undefined, allow: string, responsive: boolean): string {
  const size = responsive ? { style: 'width:100%;height:auto;aspect-ratio:16/9;border:0' } : { width: w || 560, height: h || 315, style: 'border:0' };
  return `<iframe${attrs({ ...size, src, title, allow, referrerpolicy: 'strict-origin-when-cross-origin', loading: 'lazy', allowfullscreen: true })}></iframe>`;
}

/** A privacy-enhanced YouTube player (youtube-nocookie.com: no cookies until the visitor plays it). */
export function youtubeEmbed(o: { id: string; title: string; start?: number; width?: number | null; height?: number | null; responsive?: boolean; controls?: boolean }): string {
  const q = [o.start ? `start=${o.start}` : '', o.controls === false ? 'controls=0' : '', 'rel=0'].filter(Boolean).join('&');
  return frame(`https://www.youtube-nocookie.com/embed/${encodeURIComponent(o.id)}${q ? '?' + q : ''}`, o.title || 'YouTube video', o.width, o.height, 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share', !!o.responsive);
}
/** A Vimeo player with Do Not Track on (dnt=1: no session data is recorded). */
export function vimeoEmbed(o: { id: string; title: string; width?: number | null; height?: number | null; responsive?: boolean }): string {
  return frame(`https://player.vimeo.com/video/${encodeURIComponent(o.id)}?dnt=1`, o.title || 'Vimeo video', o.width, o.height, 'fullscreen; picture-in-picture', !!o.responsive);
}

/** Reads "#map=15/51.5/-0.12", "?mlat=..&mlon=..", or "51.5, -0.12" into a location. */
export function parseMapLocation(s: string): { lat: number; lon: number; zoom?: number } | null {
  s = (s || '').trim();
  let m = /#map=(\d+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(s);
  if (m) return { zoom: +m[1], lat: +m[2], lon: +m[3] };
  m = /[?&]mlat=(-?[\d.]+)&mlon=(-?[\d.]+)/.exec(s);
  if (m) return { lat: +m[1], lon: +m[2] };
  m = /@(-?[\d.]+),(-?[\d.]+)(?:,(\d+(?:\.\d+)?)z)?/.exec(s);
  if (m) return { lat: +m[1], lon: +m[2], zoom: m[3] ? Math.round(+m[3]) : undefined };
  m = /^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (m) return { lat: +m[1], lon: +m[2] };
  return null;
}

/** An OpenStreetMap embed (no API key, no tracking cookies) with a link to the full map. */
export function osmEmbed(o: { lat: number; lon: number; zoom?: number; width?: number; height?: number; title?: string; marker?: boolean }): string {
  const z = Math.max(1, Math.min(19, o.zoom ?? 15));
  const w = o.width || 600, hgt = o.height || 400;
  const span = 360 / Math.pow(2, z);
  const dx = (span * (w / 256)) / 2;
  const dy = ((span * (hgt / 256)) / 2) * Math.cos((o.lat * Math.PI) / 180);
  const f = (n: number) => n.toFixed(5);
  const bbox = [o.lon - dx, o.lat - dy, o.lon + dx, o.lat + dy].map(f).join('%2C');
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik${o.marker !== false ? `&marker=${f(o.lat)}%2C${f(o.lon)}` : ''}`;
  const big = `https://www.openstreetmap.org/?mlat=${f(o.lat)}&mlon=${f(o.lon)}#map=${z}/${f(o.lat)}/${f(o.lon)}`;
  return `<figure class="ql-map">
  <iframe${attrs({ width: w, height: hgt, style: 'border:1px solid #ccc;max-width:100%', loading: 'lazy', title: o.title || 'Map', src })}></iframe>
  <figcaption><a href="${a(big)}">View larger map</a></figcaption>
</figure>`;
}

export function flashMarkup(o: { src: string; width: number; height: number }): string {
  return `<object type="application/x-shockwave-flash"${attrs({ data: o.src, width: o.width, height: o.height })}>
  <param name="movie" value="${a(o.src)}">
  <param name="quality" value="high">
  <p>This Flash content cannot be shown: current browsers no longer run Flash.</p>
</object>`;
}
export function objectMarkup(o: { data: string; type?: string; width?: number | null; height?: number | null; params?: [string, string][]; fallback?: string; classid?: string }): string {
  const p = (o.params || []).map(([n, v]) => `\n  <param name="${a(n)}" value="${a(v)}">`).join('');
  return `<object${attrs({ classid: o.classid, data: o.data, type: o.type, width: o.width || null, height: o.height || null })}>${p}
  <p>${esc(o.fallback || 'This content requires a plug-in that your browser does not support.')}</p>
</object>`;
}
export function embedMarkup(o: { src: string; type?: string; width?: number | null; height?: number | null }): string {
  return `<embed${attrs({ src: o.src, type: o.type || typeOfRef(o.src), width: o.width || null, height: o.height || null })}>`;
}
/** A Java applet written the HTML5 way (<object type="application/x-java-applet">). */
export function appletMarkup(o: { code: string; archive?: string; width: number; height: number; params?: [string, string][] }): string {
  return objectMarkup({ data: '', type: 'application/x-java-applet', width: o.width, height: o.height, params: [['code', o.code], ...(o.archive ? [['archive', o.archive] as [string, string]] : []), ...(o.params || [])], fallback: 'This Java applet cannot run: current browsers no longer support Java applets.' });
}
export function activexMarkup(o: { classid: string; width: number; height: number; params?: [string, string][] }): string {
  const cls = /^clsid:/i.test(o.classid) ? o.classid : `clsid:${o.classid}`;
  return objectMarkup({ data: '', classid: cls, width: o.width, height: o.height, params: o.params, fallback: 'This ActiveX control cannot run: only old versions of Internet Explorer ran ActiveX controls.' });
}
export function parseParams(text: string): [string, string][] {
  return text.split('\n').map((l) => /^\s*([^=\s]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m![1], m![2].trim()]);
}

export function svgBlank(w: number, h: number, title?: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"${title ? ` aria-label="${a(title)}"` : ''}>${title ? `<title>${esc(title)}</title>` : ''}
  <rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="currentColor" stroke-dasharray="4 4"/>
</svg>`;
}
/** Inline SVG from a file: drops the XML prolog, doctype and comments; adds role and label. */
export function inlineSvg(text: string, title?: string): string {
  let s = text.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '').trim();
  if (title && !/\brole=/.test(s.slice(0, s.indexOf('>')))) s = s.replace(/<svg\b/i, `<svg role="img" aria-label="${a(title)}"`);
  return s;
}
export function canvasMarkup(o: { id: string; width: number; height: number; fallback?: string }): string {
  return `<canvas${attrs({ id: o.id, width: o.width, height: o.height })}>${esc(o.fallback || 'A drawing that needs a browser with canvas support.')}</canvas>`;
}

// ------------------------------------------------------------------------------------------
// Clip art, shapes and decorative text (original SVG drawings on a 24 × 24 grid)

export interface ClipArt { id: string; label: string; body: string; stroke?: boolean }
export const CLIP_ART: ClipArt[] = [
  { id: 'star', label: 'Star', body: '<path d="M12 2l3 6.9 7 .5-5.4 4.6 1.7 7L12 17.2 5.7 21l1.7-7L2 9.4l7-.5z"/>' },
  { id: 'heart', label: 'Heart', body: '<path d="M12 21C5 16 2 12.5 2 8.5 2 5.5 4.4 3 7.3 3c1.9 0 3.6 1 4.7 2.6C13.1 4 14.8 3 16.7 3 19.6 3 22 5.5 22 8.5c0 4-3 7.5-10 12.5z"/>' },
  { id: 'sun', label: 'Sun', stroke: true, body: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/>' },
  { id: 'moon', label: 'Moon', body: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/>' },
  { id: 'cloud', label: 'Cloud', body: '<path d="M7 19h10.5a4.5 4.5 0 0 0 .6-9 6.5 6.5 0 0 0-12.4 1.7A3.7 3.7 0 0 0 7 19z"/>' },
  { id: 'house', label: 'House', body: '<path d="M3 11.5L12 3.5l9 8V21h-6v-6H9v6H3z"/>' },
  { id: 'check', label: 'Check mark', stroke: true, body: '<circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/>' },
  { id: 'arrow', label: 'Arrow', body: '<path d="M3 10.5h12.2l-4.6-4.6L12.7 3.8 20.9 12l-8.2 8.2-2.1-2.1 4.6-4.6H3z"/>' },
  { id: 'mail', label: 'Envelope', stroke: true, body: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M3 6.5l9 6.5 9-6.5"/>' },
  { id: 'phone', label: 'Telephone', body: '<path d="M6.8 2.8l3 3.6-1.6 2.4c1.1 2.4 3 4.4 5.4 5.5l2.4-1.6 3.6 3-.9 3.2c-.3.9-1.1 1.4-2 1.3C9.6 19.4 4.6 14.4 3.8 7.3c-.1-.9.4-1.8 1.3-2z"/>' },
  { id: 'pin', label: 'Map pin', body: '<path d="M12 22.5s7-7.2 7-12.6a7 7 0 0 0-14 0c0 5.4 7 12.6 7 12.6zm0-9.6a3 3 0 1 1 0-6 3 3 0 0 1 0 6z" fill-rule="evenodd"/>' },
  { id: 'leaf', label: 'Leaf', body: '<path d="M21 3C10.5 3 4 8.4 4 15.6c0 1.5.3 2.9.9 4.2C7.2 13.6 11.7 10.6 16 9.2c-4.2 2.2-8 6.2-9.6 11.7 1.4.4 2.6.6 3.6.6C17.3 21.5 21 14 21 3z"/>' },
  { id: 'music', label: 'Music note', body: '<path d="M9 18.5A2.8 2.8 0 1 1 7 15.9V5.2L19.5 3v12.6a2.8 2.8 0 1 1-2-2.6V7.2L9 8.7z"/>' },
  { id: 'camera', label: 'Camera', stroke: true, body: '<rect x="2.5" y="7" width="19" height="13" rx="2"/><path d="M8 7l1.6-3h4.8L16 7"/><circle cx="12" cy="13.5" r="3.5"/>' },
  { id: 'bulb', label: 'Light bulb', body: '<path d="M9 18h6v1.6c0 .8-.7 1.4-1.5 1.4h-3c-.8 0-1.5-.6-1.5-1.4zM12 2a7 7 0 0 0-4 12.7V16.5h8v-1.8A7 7 0 0 0 12 2z"/>' },
  { id: 'person', label: 'Person', body: '<circle cx="12" cy="7.5" r="4.5"/><path d="M3.5 21.5c0-4.6 3.8-7.5 8.5-7.5s8.5 2.9 8.5 7.5z"/>' },
  { id: 'calendar', label: 'Calendar', stroke: true, body: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>' },
  { id: 'cart', label: 'Shopping cart', stroke: true, body: '<path d="M2.5 3.5h2.8l2.3 11h11l2.4-8H6.4"/><circle cx="9" cy="19.5" r="1.5"/><circle cx="17" cy="19.5" r="1.5"/>' },
  { id: 'gift', label: 'Gift', stroke: true, body: '<rect x="3" y="8.5" width="18" height="4"/><path d="M5 12.5V21h14v-8.5M12 8.5V21M12 8.5C10 4 6.5 4.5 7 7c.3 1.3 3 1.5 5 1.5zm0 0c2-4.5 5.5-4 5-1.5-.3 1.3-3 1.5-5 1.5z"/>' },
  { id: 'globe', label: 'Globe', stroke: true, body: '<circle cx="12" cy="12" r="9.5"/><ellipse cx="12" cy="12" rx="4" ry="9.5"/><path d="M2.5 12h19M4 7h16M4 17h16"/>' },
  { id: 'flag', label: 'Flag', body: '<path d="M5 2.5h1.8v19H5zM8.5 3.5c3-1.4 5.2 1.4 9.5 0v9c-4.3 1.4-6.5-1.4-9.5 0z"/>' },
  { id: 'clock', label: 'Clock', stroke: true, body: '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2.5"/>' },
];

export function clipArtSvg(id: string, size = 48, color = 'currentColor', label?: string): string {
  const c = CLIP_ART.find((x) => x.id === id) || CLIP_ART[0];
  const paint = c.stroke ? `fill="none" stroke="${a(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` : `fill="${a(color)}"`;
  const name = label ?? c.label;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" ${paint}${name ? ` role="img" aria-label="${a(name)}"` : ' aria-hidden="true"'}>${c.body}</svg>`;
}

export const SHAPES = ['rectangle', 'rounded', 'circle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'star', 'arrow', 'line', 'speech'] as const;
export type ShapeKind = typeof SHAPES[number];

export function shapeSvg(o: { kind: ShapeKind; width: number; height: number; fill: string; stroke?: string; strokeWidth?: number; label?: string }): string {
  const w = o.width, h = o.height, sw = o.strokeWidth ?? 0, p = sw / 2;
  const paint = `fill="${a(o.kind === 'line' ? 'none' : o.fill)}"${sw || o.kind === 'line' ? ` stroke="${a(o.stroke || o.fill)}" stroke-width="${sw || 2}"` : ''}`;
  const pts = (list: [number, number][]) => `<polygon points="${list.map(([x, y]) => `${+x.toFixed(1)},${+y.toFixed(1)}`).join(' ')}" ${paint}/>`;
  let body: string;
  switch (o.kind) {
    case 'rounded': body = `<rect x="${p}" y="${p}" width="${w - sw}" height="${h - sw}" rx="${Math.min(w, h) / 6}" ${paint}/>`; break;
    case 'circle': { const r = Math.min(w, h) / 2 - p; body = `<circle cx="${w / 2}" cy="${h / 2}" r="${r}" ${paint}/>`; break; }
    case 'ellipse': body = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2 - p}" ry="${h / 2 - p}" ${paint}/>`; break;
    case 'triangle': body = pts([[w / 2, p], [w - p, h - p], [p, h - p]]); break;
    case 'diamond': body = pts([[w / 2, p], [w - p, h / 2], [w / 2, h - p], [p, h / 2]]); break;
    case 'hexagon': body = pts([[w * 0.25, p], [w * 0.75, p], [w - p, h / 2], [w * 0.75, h - p], [w * 0.25, h - p], [p, h / 2]]); break;
    case 'star': {
      const list: [number, number][] = [];
      for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.4 : 1; const ang = -Math.PI / 2 + (i * Math.PI) / 5; list.push([w / 2 + (r * (w / 2 - p)) * Math.cos(ang), h / 2 + (r * (h / 2 - p)) * Math.sin(ang)]); }
      body = pts(list); break;
    }
    case 'arrow': body = pts([[p, h * 0.3], [w * 0.6, h * 0.3], [w * 0.6, p], [w - p, h / 2], [w * 0.6, h - p], [w * 0.6, h * 0.7], [p, h * 0.7]]); break;
    case 'line': body = `<line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" ${paint}/>`; break;
    case 'speech': body = `<path d="M${p + 8} ${p}H${w - p - 8}Q${w - p} ${p} ${w - p} ${p + 8}V${h * 0.7 - 8}Q${w - p} ${h * 0.7} ${w - p - 8} ${h * 0.7}H${w * 0.35}L${w * 0.2} ${h - p}V${h * 0.7}H${p + 8}Q${p} ${h * 0.7} ${p} ${h * 0.7 - 8}V${p + 8}Q${p} ${p} ${p + 8} ${p}Z" ${paint}/>`; break;
    default: body = `<rect x="${p}" y="${p}" width="${w - sw}" height="${h - sw}" ${paint}/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${o.label ? ` role="img" aria-label="${a(o.label)}"` : ' aria-hidden="true"'}>${body}</svg>`;
}

export type TextEffect = 'plain' | 'outline' | 'gradient' | 'shadow' | 'arc';
/** Decorative text as SVG (the text stays real text: searchable and read by screen readers). */
export function decorativeText(o: { text: string; font?: string; size?: number; fill?: string; fill2?: string; outline?: string; effect?: TextEffect; bold?: boolean }, id = uid('ql-wa')): string {
  const size = o.size || 48;
  const w = Math.max(80, Math.round(o.text.length * size * 0.62 + size));
  const arc = o.effect === 'arc';
  const h = Math.round(size * (arc ? 2.2 : 1.5));
  const fill = o.effect === 'gradient' ? `url(#${id}-g)` : o.fill || '#1f4e9c';
  const stroke = o.effect === 'outline' ? ` stroke="${a(o.outline || '#000')}" stroke-width="${Math.max(1, size / 24)}" paint-order="stroke"` : '';
  const filter = o.effect === 'shadow' ? ` filter="url(#${id}-s)"` : '';
  const defs = [
    o.effect === 'gradient' ? `<linearGradient id="${id}-g" x1="0" x2="1"><stop offset="0" stop-color="${a(o.fill || '#1f4e9c')}"/><stop offset="1" stop-color="${a(o.fill2 || '#c2185b')}"/></linearGradient>` : '',
    o.effect === 'shadow' ? `<filter id="${id}-s"><feDropShadow dx="${size / 16}" dy="${size / 16}" stdDeviation="${size / 24}" flood-opacity=".45"/></filter>` : '',
    arc ? `<path id="${id}-p" d="M${size / 2} ${h - size / 3} Q${w / 2} ${-h * 0.35} ${w - size / 2} ${h - size / 3}" fill="none"/>` : '',
  ].join('');
  const style = `font-family="${a(o.font || 'Georgia, serif')}" font-size="${size}"${o.bold !== false ? ' font-weight="bold"' : ''} fill="${a(fill)}"${stroke}${filter}`;
  const text = arc
    ? `<text ${style}><textPath href="#${id}-p" startOffset="50%" text-anchor="middle">${esc(o.text)}</textPath></text>`
    : `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" ${style}>${esc(o.text)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${a(o.text)}">${defs ? `<defs>${defs}</defs>` : ''}${text}</svg>`;
}

// ------------------------------------------------------------------------------------------
// Math (MathML from simple input: x^2 + y_1 = sqrt(a/b), alpha, pi, sum…)

const GREEK: Record<string, string> = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', infinity: '∞', inf: '∞' };
const BIG_OPS: Record<string, string> = { sum: '∑', prod: '∏', int: '∫', oint: '∮' };
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'det', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan', 'mod', 'gcd']);
const OPS: Record<string, string> = { '<=': '≤', '>=': '≥', '!=': '≠', '+-': '±', '->': '→', '=>': '⇒', '*': '⋅', '-': '−', '~=': '≈', '...': '…' };

export function mathMarkup(input: string, display: 'block' | 'inline' = 'block'): string {
  const toks = input.match(/\d+(?:\.\d+)?|[A-Za-z]+|<=|>=|!=|\+-|->|=>|~=|\.\.\.|\S/g) || [];
  let i = 0;
  type Node = { x: string; inner?: string };
  const peek = () => toks[i];
  const atom = (): Node => {
    const t = toks[i++];
    if (t == null) return { x: '<mrow></mrow>' };
    if (/^\d/.test(t)) return { x: `<mn>${t}</mn>` };
    if (t === '(' || t === '[' || t === '{') {
      const close = t === '(' ? ')' : t === '[' ? ']' : '}';
      const inner = seq(close);
      if (peek() === close) i++;
      const shown = t === '{' ? '' : `<mo>${t}</mo>`;
      return { x: `<mrow>${shown}${inner}${t === '{' ? '' : `<mo>${close}</mo>`}</mrow>`, inner: `<mrow>${inner}</mrow>` };
    }
    if (/^[A-Za-z]+$/.test(t)) {
      if (t === 'sqrt') { const n = atom(); return { x: `<msqrt>${n.inner ?? n.x}</msqrt>` }; }
      if (t === 'root') { const deg = atom(); const n = atom(); return { x: `<mroot>${n.inner ?? n.x}${deg.inner ?? deg.x}</mroot>` }; }
      if (GREEK[t]) return { x: `<mi>${GREEK[t]}</mi>` };
      if (BIG_OPS[t]) return { x: `<mo>${BIG_OPS[t]}</mo>` };
      if (FUNCS.has(t)) return { x: `<mi>${t}</mi><mo>&#x2061;</mo>` };
      return { x: t.length === 1 ? `<mi>${t}</mi>` : [...t].map((c) => `<mi>${c}</mi>`).join('') };
    }
    return { x: `<mo>${esc(OPS[t] || t)}</mo>` };
  };
  const post = (): Node => {
    let base = atom();
    while (peek() === '^' || peek() === '_') {
      const op = toks[i++];
      const arg = atom();
      if (op === '_' && peek() === '^') { i++; const sup = atom(); base = { x: `<msubsup>${wrap(base.x)}${arg.inner ?? arg.x}${sup.inner ?? sup.x}</msubsup>` }; }
      else base = { x: `<${op === '^' ? 'msup' : 'msub'}>${wrap(base.x)}${arg.inner ?? arg.x}</${op === '^' ? 'msup' : 'msub'}>` };
    }
    return base;
  };
  const wrap = (x: string) => (/^<(mi|mn|mo|mrow|msqrt|mroot)>[^]*<\/\1>$/.test(x) && !/<\/(mi|mn|mo)><(mi|mn|mo)>/.test(x) ? x : `<mrow>${x}</mrow>`);
  const seq = (stop?: string): string => {
    const out: Node[] = [];
    while (i < toks.length && peek() !== stop) {
      if (peek() === '/' && out.length) {
        i++;
        const num = out.pop()!;
        const den = post();
        out.push({ x: `<mfrac>${wrap(num.inner ?? num.x)}${wrap(den.inner ?? den.x)}</mfrac>` });
        continue;
      }
      if ([')', ']', '}'].includes(peek()!)) { i++; continue; }
      out.push(post());
    }
    return out.map((n) => n.x).join('');
  };
  const body = seq();
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display === 'block' ? ' display="block"' : ''}><mrow>${body}</mrow></math>`;
}

// ------------------------------------------------------------------------------------------
// Characters: special characters, symbols, emoji, smileys

const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
const OTHER_ENT: [string, number][] = 'OElig 338 oelig 339 Scaron 352 scaron 353 Yuml 376 fnof 402 circ 710 tilde 732 ensp 8194 emsp 8195 thinsp 8201 ndash 8211 mdash 8212 lsquo 8216 rsquo 8217 sbquo 8218 ldquo 8220 rdquo 8221 bdquo 8222 dagger 8224 Dagger 8225 bull 8226 hellip 8230 permil 8240 prime 8242 Prime 8243 lsaquo 8249 rsaquo 8250 oline 8254 frasl 8260 euro 8364 image 8465 weierp 8472 real 8476 trade 8482 alefsym 8501 larr 8592 uarr 8593 rarr 8594 darr 8595 harr 8596 crarr 8629 lArr 8656 uArr 8657 rArr 8658 dArr 8659 hArr 8660 forall 8704 part 8706 exist 8707 empty 8709 nabla 8711 isin 8712 notin 8713 ni 8715 prod 8719 sum 8721 minus 8722 lowast 8727 radic 8730 prop 8733 infin 8734 ang 8736 and 8743 or 8744 cap 8745 cup 8746 int 8747 there4 8756 sim 8764 cong 8773 asymp 8776 ne 8800 equiv 8801 le 8804 ge 8805 sub 8834 sup 8835 nsub 8836 sube 8838 supe 8839 oplus 8853 otimes 8855 perp 8869 sdot 8901 lceil 8968 rceil 8969 lfloor 8970 rfloor 8971 loz 9674 spades 9824 clubs 9827 hearts 9829 diams 9830'
  .split(' ').reduce<[string, number][]>((acc, v, idx, arr) => { if (idx % 2 === 0) acc.push([v, +arr[idx + 1]]); return acc; }, []);
const GREEK_NAMES = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho - Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ');

/** Named HTML entity for a character, when there is one. */
export const ENTITY_OF = new Map<string, string>();
LATIN1.forEach((n, idx) => ENTITY_OF.set(String.fromCharCode(160 + idx), n));
for (const [n, c] of OTHER_ENT) ENTITY_OF.set(String.fromCharCode(c), n);
GREEK_NAMES.forEach((n, idx) => {
  if (n === '-') { ENTITY_OF.set(String.fromCharCode(0x3c2), 'sigmaf'); return; }
  ENTITY_OF.set(String.fromCharCode(0x391 + idx), n);
  ENTITY_OF.set(String.fromCharCode(0x3b1 + idx), n.toLowerCase());
});
ENTITY_OF.set('&', 'amp'); ENTITY_OF.set('<', 'lt'); ENTITY_OF.set('>', 'gt'); ENTITY_OF.set('"', 'quot');

/** The character as an entity: named when HTML has a name for it, else numeric. */
export function entityFor(ch: string): string {
  const n = ENTITY_OF.get(ch);
  if (n) return `&${n};`;
  return [...ch].map((c) => `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`).join('');
}

const LABELS: Record<string, string> = {
  nbsp: 'non-breaking space', iexcl: 'inverted exclamation mark', cent: 'cent sign', pound: 'pound sign', curren: 'currency sign', yen: 'yen sign', brvbar: 'broken bar', sect: 'section sign', uml: 'diaeresis', copy: 'copyright sign', ordf: 'feminine ordinal', laquo: 'left angle quotes', not: 'not sign', shy: 'soft hyphen', reg: 'registered sign', macr: 'macron', deg: 'degree sign', plusmn: 'plus-minus sign', sup2: 'superscript two', sup3: 'superscript three', acute: 'acute accent', micro: 'micro sign', para: 'pilcrow paragraph sign', middot: 'middle dot', cedil: 'cedilla', sup1: 'superscript one', ordm: 'masculine ordinal', raquo: 'right angle quotes', frac14: 'one quarter', frac12: 'one half', frac34: 'three quarters', iquest: 'inverted question mark', times: 'multiplication sign', divide: 'division sign', szlig: 'sharp s',
  ndash: 'en dash', mdash: 'em dash', lsquo: 'left single quote', rsquo: 'right single quote apostrophe', sbquo: 'low single quote', ldquo: 'left double quote', rdquo: 'right double quote', bdquo: 'low double quote', dagger: 'dagger', Dagger: 'double dagger', bull: 'bullet', hellip: 'ellipsis', permil: 'per mille', prime: 'prime minutes feet', Prime: 'double prime seconds inches', lsaquo: 'left single angle quote', rsaquo: 'right single angle quote', euro: 'euro sign', trade: 'trademark sign', larr: 'left arrow', uarr: 'up arrow', rarr: 'right arrow', darr: 'down arrow', harr: 'left right arrow', crarr: 'return arrow', lArr: 'left double arrow', uArr: 'up double arrow', rArr: 'right double arrow implies', dArr: 'down double arrow', hArr: 'left right double arrow iff', forall: 'for all', part: 'partial differential', exist: 'there exists', empty: 'empty set', nabla: 'nabla', isin: 'element of', notin: 'not an element of', ni: 'contains as member', prod: 'product', sum: 'summation', minus: 'minus sign', lowast: 'asterisk operator', radic: 'square root', prop: 'proportional to', infin: 'infinity', ang: 'angle', and: 'logical and', or: 'logical or', cap: 'intersection', cup: 'union', int: 'integral', there4: 'therefore', sim: 'tilde operator', cong: 'congruent', asymp: 'almost equal', ne: 'not equal', equiv: 'identical to', le: 'less than or equal', ge: 'greater than or equal', sub: 'subset', sup: 'superset', sube: 'subset or equal', supe: 'superset or equal', oplus: 'circled plus', otimes: 'circled times', perp: 'perpendicular', sdot: 'dot operator', loz: 'lozenge', spades: 'spade suit', clubs: 'club suit', hearts: 'heart suit', diams: 'diamond suit', fnof: 'function florin', OElig: 'OE ligature', oelig: 'oe ligature', ensp: 'en space', emsp: 'em space', thinsp: 'thin space', frasl: 'fraction slash', oline: 'overline',
};

export interface SymbolInfo { ch: string; name: string; entity?: string }
export interface SymbolBlock { id: string; label: string; symbols: SymbolInfo[] }
const sym = (ch: string, name?: string): SymbolInfo => { const e = ENTITY_OF.get(ch); return { ch, name: name || (e ? LABELS[e] || e : ch), entity: e }; };
const fromString = (s: string, names: Record<string, string> = {}) => [...s].map((c) => sym(c, names[c]));

export const SYMBOL_BLOCKS: SymbolBlock[] = [
  { id: 'common', label: 'Common', symbols: fromString('©®™§¶†‡•·…‰′″°±×÷€£¥¢¤¼½¾¹²³µ¬¦¡¿«»‹›“”‘’„‚–—') },
  { id: 'accents', label: 'Latin letters', symbols: [...LATIN1.slice(32).filter((n) => n !== 'times' && n !== 'divide').map((n, idx) => sym(String.fromCharCode(LATIN1.indexOf(n) + 160), n.replace(/^(\w)(grave|acute|circ|tilde|uml|ring|cedil|slash)$/, '$1 $2').replace('Elig', 'E ligature').replace('elig', 'e ligature'))), sym('Œ'), sym('œ'), sym('Š', 'S caron'), sym('š', 's caron'), sym('Ÿ', 'Y umlaut'), sym('ı', 'dotless i'), sym('ł', 'l stroke'), sym('Ł', 'L stroke'), sym('ğ', 'g breve'), sym('ş', 's cedilla'), sym('č', 'c caron'), sym('ž', 'z caron'), sym('ő', 'o double acute'), sym('ű', 'u double acute'), sym('ą', 'a ogonek'), sym('ę', 'e ogonek')] },
  { id: 'greek', label: 'Greek', symbols: GREEK_NAMES.flatMap((n, idx) => (n === '-' ? [] : [sym(String.fromCharCode(0x391 + idx), `${n} capital`), sym(String.fromCharCode(0x3b1 + idx), n.toLowerCase())])) },
  { id: 'currency', label: 'Currency', symbols: fromString('$¢£¥€₹₽₩₪₫₺₴₦₱₲₵₸₿¤', { '$': 'dollar sign', '₹': 'rupee sign', '₽': 'ruble sign', '₩': 'won sign', '₪': 'shekel sign', '₫': 'dong sign', '₺': 'lira sign', '₴': 'hryvnia sign', '₦': 'naira sign', '₱': 'peso sign', '₲': 'guarani sign', '₵': 'cedi sign', '₸': 'tenge sign', '₿': 'bitcoin sign' }) },
  { id: 'math', label: 'Math', symbols: [...fromString('±×÷−∗√∝∞∠∧∨∩∪∫∴∼≅≈≠≡≤≥⊂⊃⊆⊇⊕⊗⊥⋅∀∂∃∅∇∈∉∋∏∑⌈⌉⌊⌋'), ...fromString('∆≪≫≺≻⊢⊨∮∬ℕℤℚℝℂ⅓⅔⅛⅜⅝⅞', { '∆': 'increment', '≪': 'much less than', '≫': 'much greater than', '≺': 'precedes', '≻': 'succeeds', '⊢': 'proves', '⊨': 'models', '∮': 'contour integral', '∬': 'double integral', 'ℕ': 'natural numbers', 'ℤ': 'integers', 'ℚ': 'rational numbers', 'ℝ': 'real numbers', 'ℂ': 'complex numbers', '⅓': 'one third', '⅔': 'two thirds', '⅛': 'one eighth', '⅜': 'three eighths', '⅝': 'five eighths', '⅞': 'seven eighths' })] },
  { id: 'arrows', label: 'Arrows', symbols: [...fromString('←↑→↓↔↵⇐⇑⇒⇓⇔'), ...fromString('↕↖↗↘↙↩↪⇄⇆➔➜⟵⟶⤴⤵', { '↕': 'up down arrow', '↖': 'north west arrow', '↗': 'north east arrow', '↘': 'south east arrow', '↙': 'south west arrow', '↩': 'left hook arrow', '↪': 'right hook arrow', '⇄': 'right over left arrows', '⇆': 'left over right arrows', '➔': 'heavy right arrow', '➜': 'heavy round right arrow', '⟵': 'long left arrow', '⟶': 'long right arrow', '⤴': 'arrow curving up', '⤵': 'arrow curving down' })] },
  { id: 'shapes', label: 'Shapes and marks', symbols: [...fromString('◊♠♣♥♦'), ...fromString('■□▪▫▲△▶▷▼▽◀◁◆◇○●◎★☆☐☑☒✓✔✗✘', { '■': 'black square', '□': 'white square', '▪': 'small black square', '▫': 'small white square', '▲': 'up triangle', '△': 'white up triangle', '▶': 'right triangle play', '▷': 'white right triangle', '▼': 'down triangle', '▽': 'white down triangle', '◀': 'left triangle', '◁': 'white left triangle', '◆': 'black diamond', '◇': 'white diamond', '○': 'white circle', '●': 'black circle', '◎': 'bullseye', '★': 'black star', '☆': 'white star', '☐': 'ballot box', '☑': 'ballot box with check', '☒': 'ballot box with x', '✓': 'check mark', '✔': 'heavy check mark', '✗': 'ballot x', '✘': 'heavy ballot x' })] },
  { id: 'misc', label: 'Miscellaneous', symbols: fromString('☀☁☂☃☎✉✂✎✏⚠⚡♪♫☺☹♀♂⚥☯☮♻⌘⌥⇧⏎⌫⌚⌛℃℉№℗℠℮', { '☀': 'sun', '☁': 'cloud', '☂': 'umbrella', '☃': 'snowman', '☎': 'telephone', '✉': 'envelope', '✂': 'scissors', '✎': 'pencil', '✏': 'pencil', '⚠': 'warning sign', '⚡': 'high voltage', '♪': 'eighth note', '♫': 'beamed notes', '☺': 'smiling face', '☹': 'frowning face', '♀': 'female sign', '♂': 'male sign', '⚥': 'male and female sign', '☯': 'yin yang', '☮': 'peace symbol', '♻': 'recycling symbol', '⌘': 'command key', '⌥': 'option key', '⇧': 'shift key', '⏎': 'return key', '⌫': 'erase to the left', '⌚': 'watch', '⌛': 'hourglass', '℃': 'degree celsius', '℉': 'degree fahrenheit', '№': 'numero sign', '℗': 'sound recording copyright', '℠': 'service mark', '℮': 'estimated sign' }) },
  { id: 'spaces', label: 'Spaces and invisibles', symbols: [sym('\u00a0'), sym('\u00ad'), sym('\u2002'), sym('\u2003'), sym('\u2009'), sym('\u200b', 'zero width space'), sym('\u2060', 'word joiner'), sym('\u200c', 'zero width non-joiner'), sym('\u200d', 'zero width joiner')] },
];

export function searchSymbols(q: string): SymbolInfo[] {
  const t = q.trim().toLowerCase();
  const all = SYMBOL_BLOCKS.flatMap((b) => b.symbols);
  if (!t) return all;
  const hex = /^(?:u\+|0x|&#x)?([0-9a-f]{2,6});?$/i.exec(t);
  return all.filter((s) => s.ch === q.trim() || s.name.toLowerCase().includes(t) || s.entity?.toLowerCase() === t.replace(/^&|;$/g, '') || (hex && s.ch.codePointAt(0) === parseInt(hex[1], 16)));
}

export const EMOJI: [string, string][] = ([
  ['😀', 'grinning face'], ['😃', 'smiling face big eyes'], ['😄', 'smile'], ['😁', 'grin'], ['😆', 'laughing'], ['😅', 'sweat smile'], ['😂', 'tears of joy'], ['🙂', 'slight smile'], ['😉', 'wink'], ['😊', 'blush'], ['😍', 'heart eyes'], ['😘', 'kiss'], ['😎', 'cool sunglasses'], ['🤔', 'thinking'], ['😐', 'neutral'], ['🙄', 'eye roll'], ['😴', 'sleeping'], ['😢', 'crying'], ['😭', 'sobbing'], ['😡', 'angry'], ['😮', 'surprised'], ['🥳', 'party face'], ['🤩', 'star struck'], ['🤗', 'hug'],
  ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['👏', 'clapping'], ['🙌', 'raised hands'], ['🙏', 'thank you please'], ['👋', 'waving hand'], ['💪', 'strong'], ['👀', 'eyes'], ['🤝', 'handshake'], ['👉', 'pointing right'], ['👆', 'pointing up'], ['✌️', 'victory'],
  ['❤️', 'red heart'], ['💔', 'broken heart'], ['💯', 'hundred points'], ['✨', 'sparkles'], ['🔥', 'fire'], ['⭐', 'star'], ['🌟', 'glowing star'], ['🎉', 'party popper'], ['🎂', 'birthday cake'], ['🎁', 'gift'], ['🎈', 'balloon'], ['🏆', 'trophy'], ['🥇', 'gold medal'],
  ['✅', 'check box'], ['❌', 'cross mark'], ['⚠️', 'warning'], ['❓', 'question'], ['❗', 'exclamation'], ['💡', 'idea light bulb'], ['📌', 'pushpin'], ['📎', 'paperclip'], ['📅', 'calendar'], ['📞', 'telephone'], ['📧', 'email'], ['📷', 'camera'], ['🎵', 'music note'], ['🎬', 'film clapper'], ['💻', 'laptop'], ['📱', 'mobile phone'], ['🔒', 'lock'], ['🔑', 'key'], ['🔍', 'search magnifier'], ['🛒', 'shopping cart'], ['💰', 'money bag'], ['💳', 'credit card'], ['📚', 'books'], ['✏️', 'pencil'], ['📝', 'memo'], ['📈', 'chart up'], ['📉', 'chart down'], ['⏰', 'alarm clock'], ['⌛', 'hourglass'], ['🔔', 'bell'], ['📣', 'megaphone'], ['🎓', 'graduation cap'], ['💼', 'briefcase'],
  ['🏠', 'house'], ['🏢', 'office building'], ['🚗', 'car'], ['🚲', 'bicycle'], ['✈️', 'airplane'], ['🚀', 'rocket'], ['🌍', 'globe'], ['☀️', 'sun'], ['🌙', 'moon'], ['☁️', 'cloud'], ['🌧️', 'rain'], ['❄️', 'snowflake'], ['🌈', 'rainbow'], ['🌸', 'blossom'], ['🌳', 'tree'], ['🍀', 'four leaf clover'], ['🍁', 'maple leaf'],
  ['🐶', 'dog'], ['🐱', 'cat'], ['🐦', 'bird'], ['🦋', 'butterfly'], ['🐟', 'fish'], ['🍎', 'apple'], ['🍕', 'pizza'], ['🍔', 'burger'], ['☕', 'coffee'], ['🍰', 'cake slice'], ['🍷', 'wine'], ['⚽', 'soccer ball'], ['🏀', 'basketball'], ['🎮', 'video game'], ['🎨', 'palette art'], ['🎸', 'guitar'],
] as [string, string][]);

/** Text emoticons (as in Composer-family "Insert Smiley") mapped to emoji with an accessible label. */
export const SMILEYS: { code: string; ch: string; name: string }[] = [
  { code: ':-)', ch: '🙂', name: 'smile' }, { code: ';-)', ch: '😉', name: 'wink' }, { code: ':-D', ch: '😀', name: 'laughing' }, { code: ':-(', ch: '🙁', name: 'frown' },
  { code: ':-P', ch: '😛', name: 'tongue out' }, { code: ':-O', ch: '😮', name: 'surprised' }, { code: '8-)', ch: '😎', name: 'cool' }, { code: ":'(", ch: '😢', name: 'crying' },
  { code: ':-*', ch: '😘', name: 'kiss' }, { code: '>:(', ch: '😠', name: 'angry' }, { code: ':-/', ch: '😕', name: 'undecided' }, { code: ':-|', ch: '😐', name: 'neutral' },
  { code: ':-[', ch: '😳', name: 'embarrassed' }, { code: 'O:-)', ch: '😇', name: 'innocent' }, { code: ':-X', ch: '🤐', name: 'lips sealed' }, { code: '<3', ch: '❤️', name: 'heart' },
];
export function emojiMarkup(ch: string, name: string): string { return `<span role="img" aria-label="${a(name)}">${ch}</span>`; }

// ------------------------------------------------------------------------------------------
// Dates

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const p2 = (n: number) => String(n).padStart(2, '0');

export const DATE_FORMATS: { id: string; label: string }[] = [
  { id: 'long', label: 'October 18, 2026' }, { id: 'full', label: 'Sunday, October 18, 2026' }, { id: 'short', label: '10/18/2026' }, { id: 'iso', label: '2026-10-18' },
  { id: 'medium', label: 'Oct 18, 2026' }, { id: 'dmy', label: '18 October 2026' }, { id: 'dmyShort', label: '18/10/2026' }, { id: 'none', label: '(none)' },
];
export const TIME_FORMATS: { id: string; label: string }[] = [
  { id: 'none', label: '(none)' }, { id: 't12', label: '3:45 PM' }, { id: 't24', label: '15:45' }, { id: 't12s', label: '3:45:12 PM' }, { id: 't24s', label: '15:45:12' }, { id: 't12z', label: '3:45 PM UTC+02:00' },
];

export function formatDate(d: Date, fmt: string): string {
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  switch (fmt) {
    case 'full': return `${DAYS[d.getDay()]}, ${MONTHS[m]} ${day}, ${y}`;
    case 'short': return `${m + 1}/${day}/${y}`;
    case 'iso': return `${y}-${p2(m + 1)}-${p2(day)}`;
    case 'medium': return `${MONTHS[m].slice(0, 3)} ${day}, ${y}`;
    case 'dmy': return `${day} ${MONTHS[m]} ${y}`;
    case 'dmyShort': return `${p2(day)}/${p2(m + 1)}/${y}`;
    case 'none': return '';
    default: return `${MONTHS[m]} ${day}, ${y}`;
  }
}
export function formatTime(d: Date, fmt: string): string {
  const H = d.getHours(), M = p2(d.getMinutes()), S = p2(d.getSeconds());
  const h12 = `${H % 12 || 12}:${M}`, ap = H < 12 ? 'AM' : 'PM';
  const off = -d.getTimezoneOffset();
  const zone = `UTC${off >= 0 ? '+' : '-'}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
  switch (fmt) {
    case 't12': return `${h12} ${ap}`;
    case 't24': return `${p2(H)}:${M}`;
    case 't12s': return `${h12}:${S} ${ap}`;
    case 't24s': return `${p2(H)}:${M}:${S}`;
    case 't12z': return `${h12} ${ap} ${zone}`;
    default: return '';
  }
}
function isoLocal(d: Date, withTime: boolean): string {
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return withTime ? `${date}T${p2(d.getHours())}:${p2(d.getMinutes())}` : date;
}

/**
 * A date (and time). Static text, or a timestamp marked with data-ql-timestamp ("edited" updates when the
 * page is saved, as FrontPage's Date and Time component did; see refreshTimestamps()).
 */
export function dateMarkup(d: Date, o: { date?: string; time?: string; auto?: boolean } = {}): string {
  const df = o.date ?? 'long', tf = o.time ?? 'none';
  const text = [formatDate(d, df), formatTime(d, tf)].filter(Boolean).join(' ');
  const iso = isoLocal(d, tf !== 'none');
  if (!o.auto) return `<time datetime="${iso}">${esc(text)}</time>`;
  return `<time datetime="${iso}" data-ql-timestamp="edited" data-ql-format="${a(df + '|' + tf)}">${esc(text)}</time>`;
}

/** Updates every automatic timestamp in a page to `now` (call when a page is saved). */
export function refreshTimestamps(src: string, now = new Date()): string {
  return src.replace(/<time\b([^>]*\bdata-ql-timestamp\s*=\s*["']edited["'][^>]*)>[\s\S]*?<\/time>/gi, (m, at: string) => {
    const fmt = /data-ql-format\s*=\s*["']([^"']*)["']/i.exec(at)?.[1] || 'long|none';
    const [df, tf] = fmt.split('|');
    return dateMarkup(now, { date: df, time: tf || 'none', auto: true }).replace(/^<time\b[^>]*>/, (t) => {
      const keep = at.replace(/\s(datetime|data-ql-timestamp|data-ql-format)\s*=\s*("[^"]*"|'[^']*')/gi, '');
      return t.replace('<time', `<time${keep}`);
    });
  });
}

// ------------------------------------------------------------------------------------------
// Server-side code

export const php = {
  block: (code = '') => `<?php ${code || '// code'} ?>`,
  echo: (expr: string, escape = true) => (escape ? `<?= htmlspecialchars(${expr}, ENT_QUOTES) ?>` : `<?= ${expr} ?>`),
  include: (file: string, once = false) => `<?php include${once ? '_once' : ''} __DIR__ . '/${file.replace(/'/g, "\\'")}'; ?>`,
  require: (file: string, once = true) => `<?php require${once ? '_once' : ''} __DIR__ . '/${file.replace(/'/g, "\\'")}'; ?>`,
  if: (cond: string, inner: string) => `<?php if (${cond || 'true'}): ?>${inner}<?php endif; ?>`,
  else: () => '<?php else: ?>',
  foreach: (list: string, item: string, inner: string) => `<?php foreach (${list || '$items'} as ${item || '$item'}): ?>${inner}<?php endforeach; ?>`,
  variable: (sup: '_POST' | '_GET' | '_SESSION' | '_COOKIE', name: string) => `<?= htmlspecialchars($${sup}['${name.replace(/'/g, "\\'")}'] ?? '', ENT_QUOTES) ?>`,
};

export const ssi = {
  include: (path: string, virtual = true) => `<!--#include ${virtual ? 'virtual' : 'file'}="${a(path)}" -->`,
  echo: (v: string) => `<!--#echo var="${a(v)}" -->`,
};
export const SSI_VARS = ['DATE_LOCAL', 'DATE_GMT', 'LAST_MODIFIED', 'DOCUMENT_NAME', 'DOCUMENT_URI', 'QUERY_STRING_UNESCAPED', 'HTTP_USER_AGENT', 'REMOTE_ADDR', 'SERVER_NAME'];

export const asp = {
  block: (code = '') => `<% ${code || "' code"} %>`,
  echo: (expr: string) => `<%= Server.HTMLEncode(${expr}) %>`,
  include: (path: string, virtual = true) => `<!--#include ${virtual ? 'virtual' : 'file'}="${a(path)}" -->`,
};
export const jsp = {
  block: (code = '') => `<% ${code || '// code'} %>`,
  echo: (expr: string) => `<%= ${expr} %>`,
};
export const HANDLEBARS: { id: string; label: string; text: (inner: string) => string }[] = [
  { id: 'var', label: 'Variable {{name}}', text: () => '{{name}}' },
  { id: 'raw', label: 'Unescaped {{{html}}}', text: () => '{{{html}}}' },
  { id: 'if', label: 'If block', text: (s) => `{{#if condition}}${s || 'Shown when true'}{{else}}Shown when false{{/if}}` },
  { id: 'each', label: 'Each block', text: (s) => `{{#each items}}${s || '<li>{{this}}</li>'}{{/each}}` },
  { id: 'with', label: 'With block', text: (s) => `{{#with person}}${s || '{{firstName}} {{lastName}}'}{{/with}}` },
  { id: 'partial', label: 'Partial', text: () => '{{> header}}' },
  { id: 'comment', label: 'Comment', text: () => '{{!-- comment --}}' },
];
export const LIQUID: { id: string; label: string; text: (inner: string) => string }[] = [
  { id: 'output', label: 'Output {{ variable }}', text: () => '{{ page.title }}' },
  { id: 'filter', label: 'Output with filter', text: () => '{{ page.title | escape }}' },
  { id: 'if', label: 'If tag', text: (s) => `{% if condition %}${s || 'Shown when true'}{% else %}Shown when false{% endif %}` },
  { id: 'for', label: 'For loop', text: (s) => `{% for item in collection %}${s || '<li>{{ item }}</li>'}{% endfor %}` },
  { id: 'assign', label: 'Assign', text: () => "{% assign name = 'value' %}" },
  { id: 'include', label: 'Include', text: () => "{% include 'header.html' %}" },
  { id: 'comment', label: 'Comment', text: (s) => `{% comment %}${s || 'comment'}{% endcomment %}` },
];

// ------------------------------------------------------------------------------------------
// Head tags

export interface OpenGraph { title?: string; description?: string; url?: string; image?: string; imageAlt?: string; type?: string; siteName?: string; locale?: string }
export function openGraphTags(o: OpenGraph): [string, string][] {
  return ([['og:title', o.title], ['og:description', o.description], ['og:type', o.type || 'website'], ['og:url', o.url], ['og:image', o.image], ['og:image:alt', o.imageAlt], ['og:site_name', o.siteName], ['og:locale', o.locale]] as [string, string | undefined][]).filter(([, v]) => v) as [string, string][];
}
export function twitterTags(o: { card?: string; title?: string; description?: string; image?: string; imageAlt?: string; site?: string; creator?: string }): [string, string][] {
  return ([['twitter:card', o.card || 'summary_large_image'], ['twitter:title', o.title], ['twitter:description', o.description], ['twitter:image', o.image], ['twitter:image:alt', o.imageAlt], ['twitter:site', o.site], ['twitter:creator', o.creator]] as [string, string | undefined][]).filter(([, v]) => v) as [string, string][];
}

/** A JSON-LD structured data block. "</" is escaped so the JSON cannot close the script early. */
export function jsonLd(data: Record<string, any>): string {
  const clean = (o: any): any => {
    if (Array.isArray(o)) return o.map(clean).filter((x) => x !== undefined);
    if (o && typeof o === 'object') { const r: any = {}; for (const [k, v] of Object.entries(o)) { const c = clean(v); if (c !== undefined && c !== '' && !(typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length)) r[k] = c; } return r; }
    return o === '' || o == null ? undefined : o;
  };
  const json = JSON.stringify({ '@context': 'https://schema.org', ...clean(data) }, null, 2).replace(/<\//g, '<\\/');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

export const VIEWPORTS = ['width=device-width, initial-scale=1', 'width=device-width, initial-scale=1, viewport-fit=cover', 'width=device-width, initial-scale=1, maximum-scale=5', 'width=device-width', 'width=1024'];

// ------------------------------------------------------------------------------------------
// Frameworks (exact versions on public CDNs)

export interface Framework { id: string; label: string; css?: string[]; js?: { src: string; defer?: boolean; module?: boolean; end?: boolean }[]; note?: string }
export const FRAMEWORKS: Record<string, Framework> = {
  bootstrap: { id: 'bootstrap', label: 'Bootstrap 5.3', css: ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css'], js: [{ src: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js', end: true }] },
  tailwind: { id: 'tailwind', label: 'Tailwind CSS (Play CDN)', js: [{ src: 'https://cdn.tailwindcss.com/3.4.16' }], note: 'The Play CDN builds styles in the browser and is meant for prototypes. For production, build Tailwind into a style sheet.' },
  picoCss: { id: 'picoCss', label: 'Pico CSS 2', css: ['https://cdn.jsdelivr.net/npm/@picocss/pico@2.0.6/css/pico.min.css'] },
  bulma: { id: 'bulma', label: 'Bulma 1.0', css: ['https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/bulma.min.css'] },
  foundation: { id: 'foundation', label: 'Foundation 6.8', css: ['https://cdn.jsdelivr.net/npm/foundation-sites@6.8.1/dist/css/foundation.min.css'], js: [{ src: 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js', end: true }, { src: 'https://cdn.jsdelivr.net/npm/foundation-sites@6.8.1/dist/js/foundation.min.js', end: true }], note: 'Call $(document).foundation(); in a script after these to start its plug-ins.' },
  jquery: { id: 'jquery', label: 'jQuery 3.7', js: [{ src: 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js' }] },
  alpine: { id: 'alpine', label: 'Alpine.js 3', js: [{ src: 'https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js', defer: true }] },
  fontAwesome: { id: 'fontAwesome', label: 'Font Awesome 6 (free)', css: ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css'], note: 'Use icons like <i class="fa-solid fa-house" aria-hidden="true"></i> with a visible or screen-reader label.' },
  normalize: { id: 'normalize', label: 'normalize.css 8', css: ['https://cdn.jsdelivr.net/npm/normalize.css@8.0.1/normalize.css'] },
};

export const GOOGLE_FONTS: { family: string; fallback: string; weights: string }[] = [
  { family: 'Roboto', fallback: 'sans-serif', weights: '400;700' }, { family: 'Open Sans', fallback: 'sans-serif', weights: '400;700' }, { family: 'Lato', fallback: 'sans-serif', weights: '400;700' },
  { family: 'Montserrat', fallback: 'sans-serif', weights: '400;700' }, { family: 'Inter', fallback: 'sans-serif', weights: '400;700' }, { family: 'Poppins', fallback: 'sans-serif', weights: '400;700' },
  { family: 'Source Sans 3', fallback: 'sans-serif', weights: '400;700' }, { family: 'Nunito', fallback: 'sans-serif', weights: '400;700' }, { family: 'Raleway', fallback: 'sans-serif', weights: '400;700' },
  { family: 'Work Sans', fallback: 'sans-serif', weights: '400;700' }, { family: 'Noto Sans', fallback: 'sans-serif', weights: '400;700' }, { family: 'Oswald', fallback: 'sans-serif', weights: '400;700' },
  { family: 'Merriweather', fallback: 'serif', weights: '400;700' }, { family: 'Playfair Display', fallback: 'serif', weights: '400;700' }, { family: 'Lora', fallback: 'serif', weights: '400;700' },
  { family: 'PT Serif', fallback: 'serif', weights: '400;700' }, { family: 'Libre Baskerville', fallback: 'serif', weights: '400;700' }, { family: 'EB Garamond', fallback: 'serif', weights: '400;700' },
  { family: 'Fira Code', fallback: 'monospace', weights: '400;700' }, { family: 'JetBrains Mono', fallback: 'monospace', weights: '400;700' }, { family: 'Source Code Pro', fallback: 'monospace', weights: '400;700' },
  { family: 'Pacifico', fallback: 'cursive', weights: '400' }, { family: 'Lobster', fallback: 'cursive', weights: '400' }, { family: 'Dancing Script', fallback: 'cursive', weights: '400;700' },
];

export function googleFontTags(families: { family: string; weights?: string }[]): string[] {
  const fam = families.map((f) => `family=${encodeURIComponent(f.family).replace(/%20/g, '+')}${f.weights ? `:wght@${f.weights}` : ''}`).join('&');
  return [
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fam}&amp;display=swap">`,
  ];
}

export type AnalyticsKind = 'plausible' | 'goatcounter' | 'ga4';
export function analyticsSnippet(kind: AnalyticsKind, id: string): string {
  if (kind === 'plausible') return `<script defer data-domain="${a(id)}" src="https://plausible.io/js/script.js"></script>`;
  if (kind === 'goatcounter') return `<script data-goatcounter="https://${a(id)}.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>`;
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${a(encodeURIComponent(id))}"></script>\n  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id.replace(/[^\w-]/g, '')}');</script>`;
}

// ------------------------------------------------------------------------------------------
// Navigation components

export interface NavItem { href: string; label: string; current?: boolean; children?: NavItem[] }

export function linkBar(items: NavItem[], o: { orientation?: 'horizontal' | 'vertical'; label?: string; separator?: string } = {}): Component {
  const vert = o.orientation === 'vertical';
  const li = items.map((x) => `    <li><a href="${a(x.href)}"${x.current ? ' aria-current="page"' : ''}>${esc(x.label)}</a></li>`).join('\n');
  return {
    key: 'linkbar',
    html: `<nav class="ql-linkbar${vert ? ' ql-linkbar-v' : ''}" aria-label="${a(o.label || 'Site')}">\n  <ul>\n${li}\n  </ul>\n</nav>`,
    css: `.ql-linkbar ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.25rem 1rem}
.ql-linkbar-v ul{flex-direction:column}
.ql-linkbar a{text-decoration:none;padding:.25rem 0}
.ql-linkbar a:hover,.ql-linkbar a:focus-visible{text-decoration:underline}
.ql-linkbar a[aria-current=page]{font-weight:bold}`,
  };
}

export function breadcrumbs(items: NavItem[]): Component {
  const li = items.map((x, idx) => (idx === items.length - 1 ? `    <li><a href="${a(x.href)}" aria-current="page">${esc(x.label)}</a></li>` : `    <li><a href="${a(x.href)}">${esc(x.label)}</a></li>`)).join('\n');
  return {
    key: 'breadcrumbs',
    html: `<nav class="ql-breadcrumbs" aria-label="Breadcrumb">\n  <ol>\n${li}\n  </ol>\n</nav>`,
    css: `.ql-breadcrumbs ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap}
.ql-breadcrumbs li+li::before{content:"/";padding:0 .5em;color:#888}
.ql-breadcrumbs a[aria-current=page]{color:inherit;text-decoration:none}`,
  };
}

export function siteMap(tree: NavItem[], title = 'Site map'): Component {
  const list = (items: NavItem[], depth: number): string => {
    const pad = '  '.repeat(depth + 1);
    return `<ul>\n${items.map((x) => `${pad}<li><a href="${a(x.href)}">${esc(x.label)}</a>${x.children?.length ? '\n' + pad + '  ' + list(x.children, depth + 2) + '\n' + pad : ''}</li>`).join('\n')}\n${'  '.repeat(depth)}</ul>`;
  };
  return { html: `<nav class="ql-sitemap" aria-label="${a(title)}">\n  ${list(tree, 1)}\n</nav>` };
}

export interface Heading { level: number; id: string; text: string }
/** Adds ids to headings that lack one; returns the new source and the headings (in order). */
export function addHeadingIds(src: string, minLevel = 2, maxLevel = 4): { src: string; headings: Heading[] } {
  const r = regions(src);
  const start = r.bodyOpen ? r.bodyOpen[1] : 0;
  const end = r.bodyClose >= 0 ? r.bodyClose : src.length;
  const body = src.slice(start, end);
  const taken = new Set(idsIn(src));
  const headings: Heading[] = [];
  const out = body.replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1\s*>/gi, (m, lv: string, at = '', inner: string) => {
    const level = +lv;
    if (level < minLevel || level > maxLevel) return m;
    const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) return m;
    const existing = /\sid\s*=\s*["']([^"']+)["']/i.exec(at)?.[1];
    const id = existing || slugId(text, taken);
    headings.push({ level, id, text });
    return existing ? m : `<h${lv}${at} id="${a(id)}">${inner}</h${lv}>`;
  });
  return { src: src.slice(0, start) + out + src.slice(end), headings };
}

export function pageToc(headings: Heading[], title = 'Contents'): Component {
  if (!headings.length) return { html: `<nav class="ql-toc" aria-label="${a(title)}"><p>No headings on this page yet.</p></nav>` };
  const min = Math.min(...headings.map((x) => x.level));
  let html = '';
  let depth = 0;
  const open: boolean[] = [];
  for (const hd of headings) {
    const d = hd.level - min;
    while (depth < d) { html += '<ul>'; depth++; open.push(false); }
    while (depth > d) { html += '</li></ul>'; depth--; open.pop(); }
    if (html.endsWith('</a>')) html += '</li>';
    html += `<li><a href="#${a(hd.id)}">${esc(hd.text)}</a>`;
  }
  html += '</li>';
  while (depth > 0) { html += '</ul></li>'; depth--; }
  return { key: 'toc', html: `<nav class="ql-toc" aria-label="${a(title)}">\n  <p class="ql-toc-title"><strong>${esc(title)}</strong></p>\n  <ul>${html}</ul>\n</nav>`, css: '.ql-toc ul ul{margin:.2em 0}\n.ql-toc-title{margin-bottom:.3em}' };
}

export function pageBanner(title: string): string { return `<h1 class="page-banner">${esc(title)}</h1>`; }

export function substitution(name: string, value: string): string { return `<span data-ql-var="${a(name)}">${esc(value)}</span>`; }

/** Refreshes the value of every substitution (data-ql-var) in a page from the site variables. */
export function refreshSubstitutions(src: string, vars: Record<string, string>): string {
  return src.replace(/<span\b([^>]*\bdata-ql-var\s*=\s*["']([^"']+)["'][^>]*)>[\s\S]*?<\/span>/gi, (m, at: string, name: string) => (name in vars ? `<span${at}>${esc(vars[name])}</span>` : m));
}

export function includeWebbot(ref: string, content: string): string {
  return `<!--webbot bot="Include" U-Include="${a(ref)}" TAG="BODY" startspan -->${content}<!--webbot bot="Include" endspan -->`;
}

export function scheduled(content: string, start: string, end: string, otherwise = ''): string {
  const id = uid('ql-sched');
  return `<div class="ql-scheduled" id="${id}" data-ql-start="${a(start)}" data-ql-end="${a(end)}" hidden>\n${content}\n</div>${otherwise ? `\n<div class="ql-scheduled-else" data-ql-for="${id}">\n${otherwise}\n</div>` : ''}\n` + onReady('__qlScheduled',
    "var n=Date.now();document.querySelectorAll('.ql-scheduled').forEach(function(e){var s=Date.parse(e.dataset.qlStart||'')||-Infinity,t=Date.parse(e.dataset.qlEnd||'')||Infinity,on=n>=s&&n<t;e.hidden=!on;var o=document.querySelector('[data-ql-for=\"'+e.id+'\"]');if(o)o.hidden=on;});");
}

export function lastUpdated(d: Date, fmt = 'long', label = 'Last updated'): string {
  return `<p class="ql-last-updated">${esc(label)} ${dateMarkup(d, { date: fmt, auto: true })}</p>`;
}

// ------------------------------------------------------------------------------------------
// Forms

export interface FormOpts { action: string; method?: 'post' | 'get'; mailto?: boolean; submit?: string; title?: string; honeypot?: boolean }
function formOpen(o: FormOpts, cls: string): string {
  const mail = o.mailto || /^mailto:/i.test(o.action);
  const action = mail && !/^mailto:/i.test(o.action) ? `mailto:${o.action}` : o.action;
  return `<form class="${cls}"${attrs({ action: action || null, method: o.method || 'post', enctype: mail ? 'text/plain' : null })}>`;
}
const field = (id: string, label: string, input: string) => `  <p>\n    <label for="${id}">${label}</label>\n    ${input}\n  </p>`;
const honeypot = (on?: boolean) => (on ? `\n  <p class="ql-hp" aria-hidden="true"><label>Leave this empty <input type="text" name="_gotcha" tabindex="-1" autocomplete="off"></label></p>` : '');
const formCss = `.ql-form{display:grid;gap:.25rem;max-width:36rem}
.ql-form p{margin:0 0 .75rem}
.ql-form label{display:block;font-weight:600;margin-bottom:.25rem}
.ql-form input:not([type=checkbox]):not([type=radio]),.ql-form textarea,.ql-form select{width:100%;box-sizing:border-box;padding:.5rem;font:inherit;border:1px solid #888;border-radius:4px}
.ql-form fieldset{border:1px solid #ccc;border-radius:4px;margin:0 0 .75rem}
.ql-form fieldset label{display:inline;font-weight:normal;margin-right:1rem}
.ql-form button{padding:.6rem 1.4rem;font:inherit;cursor:pointer}
.ql-hp{position:absolute;left:-9999px}`;

export function contactForm(o: FormOpts, p = uid('cf')): Component {
  return {
    key: 'form', css: formCss,
    html: `${formOpen(o, 'ql-form ql-contact-form')}
${o.title ? `  <h2>${esc(o.title)}</h2>\n` : ''}${field(`${p}-name`, 'Name', `<input id="${p}-name" name="name" type="text" autocomplete="name" required>`)}
${field(`${p}-email`, 'Email', `<input id="${p}-email" name="email" type="email" autocomplete="email" required>`)}
${field(`${p}-subject`, 'Subject', `<input id="${p}-subject" name="subject" type="text">`)}
${field(`${p}-message`, 'Message', `<textarea id="${p}-message" name="message" rows="6" required></textarea>`)}${honeypot(o.honeypot)}
  <p><button type="submit">${esc(o.submit || 'Send message')}</button></p>
</form>`,
  };
}

export function feedbackForm(o: FormOpts, p = uid('fb')): Component {
  const kinds = ['Complaint', 'Problem', 'Suggestion', 'Praise'];
  const about = ['Web site', 'Company', 'Products', 'Service', 'Other'];
  return {
    key: 'form', css: formCss,
    html: `${formOpen(o, 'ql-form ql-feedback-form')}
  <h2>${esc(o.title || 'Feedback')}</h2>
  <fieldset>
    <legend>What kind of comment would you like to send?</legend>
${kinds.map((k, i) => `    <label><input type="radio" name="kind" value="${k}"${i === 2 ? ' checked' : ''}> ${k}</label>`).join('\n')}
  </fieldset>
${field(`${p}-about`, 'What is your comment about?', `<select id="${p}-about" name="about">${about.map((x) => `<option>${x}</option>`).join('')}</select>`)}
${field(`${p}-comments`, 'Comments', `<textarea id="${p}-comments" name="comments" rows="6" required></textarea>`)}
${field(`${p}-name`, 'Name', `<input id="${p}-name" name="name" type="text" autocomplete="name">`)}
${field(`${p}-email`, 'Email', `<input id="${p}-email" name="email" type="email" autocomplete="email">`)}
${field(`${p}-phone`, 'Phone', `<input id="${p}-phone" name="phone" type="tel" autocomplete="tel">`)}
  <p><label><input type="checkbox" name="contact_me" value="yes"> Please contact me as soon as possible</label></p>${honeypot(o.honeypot)}
  <p><button type="submit">${esc(o.submit || 'Send feedback')}</button> <button type="reset">Clear</button></p>
</form>`,
  };
}

export function newsletterForm(o: FormOpts, p = uid('nl')): Component {
  return {
    key: 'newsletter',
    css: `.ql-newsletter{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end;max-width:36rem}
.ql-newsletter p{margin:0;flex:1 1 14rem}
.ql-newsletter label{display:block;font-weight:600;margin-bottom:.25rem}
.ql-newsletter input[type=email]{width:100%;box-sizing:border-box;padding:.5rem;font:inherit}
.ql-newsletter button{padding:.55rem 1.2rem;font:inherit}
.ql-hp{position:absolute;left:-9999px}`,
    html: `${formOpen(o, 'ql-newsletter').replace(/>$/, ` aria-label="${a(o.title || 'Newsletter sign-up')}">`)}
  <p>
    <label for="${p}-email">Email address</label>
    <input id="${p}-email" name="email" type="email" autocomplete="email" required>
  </p>${honeypot(o.honeypot)}
  <button type="submit">${esc(o.submit || 'Subscribe')}</button>
</form>`,
  };
}

/** A search box. With a JSON index (search-index.json) results show on the page; otherwise it searches the web site with a search engine. */
export function searchForm(o: { index?: string; domain?: string; label?: string }, p = uid('sf')): Component {
  const idx = o.index || 'search-index.json';
  return {
    key: 'search',
    css: `.ql-search{display:flex;gap:.5rem;max-width:30rem}
.ql-search input{flex:1;padding:.45rem;font:inherit}
.ql-search-results{list-style:none;padding:0}
.ql-search-results li{margin:.6rem 0}
.ql-visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`,
    html: `<form class="ql-search" role="search" action="https://duckduckgo.com/" method="get" data-ql-index="${a(idx)}" data-ql-results="${p}-results">
  <label for="${p}-q" class="ql-visually-hidden">${esc(o.label || 'Search this site')}</label>
  <input id="${p}-q" name="q" type="search" placeholder="${a(o.label || 'Search this site')}" required>${o.domain ? `\n  <input type="hidden" name="sites" value="${a(o.domain)}">` : ''}
  <button type="submit">Search</button>
</form>
<ul class="ql-search-results" id="${p}-results" aria-live="polite"></ul>
` + onReady('__qlSearch',
      "document.querySelectorAll('form[data-ql-index]').forEach(function(f){f.addEventListener('submit',function(ev){ev.preventDefault();var q=f.querySelector('input[type=search]').value.toLowerCase().trim(),out=document.getElementById(f.dataset.qlResults);fetch(f.dataset.qlIndex).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){var list=Array.isArray(d)?d:(d.pages||[]),words=q.split(/\\s+/),hits=list.filter(function(p){var t=((p.title||'')+' '+(p.text||p.content||'')).toLowerCase();return words.every(function(w){return t.indexOf(w)>=0})});out.innerHTML='';if(!hits.length){out.textContent='No pages found.';return}hits.slice(0,50).forEach(function(p){var li=document.createElement('li'),a=document.createElement('a');a.href=p.url||p.path;a.textContent=p.title||p.url;li.appendChild(a);out.appendChild(li)})}).catch(function(){HTMLFormElement.prototype.submit.call(f)})})})"),
  };
}

// ------------------------------------------------------------------------------------------
// Social

export const SOCIAL_NETWORKS = ['Facebook', 'X', 'Instagram', 'LinkedIn', 'YouTube', 'GitHub', 'Mastodon', 'Bluesky', 'TikTok', 'Pinterest', 'Threads', 'Email'];
export function socialLinks(links: { network: string; url: string }[]): Component {
  const li = links.filter((l) => l.url).map((l) => {
    const href = l.network === 'Email' && !/^mailto:/i.test(l.url) ? `mailto:${l.url}` : l.url;
    return `    <li><a href="${a(href)}"${l.network === 'Mastodon' ? ' rel="me"' : ''}>${esc(l.network)}</a></li>`;
  }).join('\n');
  return {
    key: 'social',
    html: `<nav class="ql-social" aria-label="Social media">\n  <ul>\n${li}\n  </ul>\n</nav>`,
    css: `.ql-social ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.5rem}
.ql-social a{display:inline-block;padding:.35rem .8rem;border:1px solid currentColor;border-radius:999px;text-decoration:none}
.ql-social a:hover,.ql-social a:focus-visible{background:rgba(127,127,127,.15)}`,
  };
}

/** Share links (plain links, no third-party scripts or tracking). Without a URL, a tiny script fills in the page address. */
export function shareButtons(o: { url?: string; title?: string; networks?: string[] }): Component {
  const u = encodeURIComponent(o.url || ''), t = encodeURIComponent(o.title || '');
  const all: Record<string, string> = {
    Email: `mailto:?subject=${t}&body=${u}`,
    X: `https://twitter.com/intent/tweet?url=${u}&text=${t}`,
    Facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    LinkedIn: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    Reddit: `https://www.reddit.com/submit?url=${u}&title=${t}`,
    Bluesky: `https://bsky.app/intent/compose?text=${t}%20${u}`,
    WhatsApp: `https://wa.me/?text=${t}%20${u}`,
  };
  const nets = (o.networks?.length ? o.networks : Object.keys(all)).filter((n) => all[n]);
  const li = nets.map((n) => `    <li><a href="${a(all[n])}" data-ql-share="${a(n)}"${n === 'Email' ? '' : ' target="_blank" rel="noopener"'}>${n === 'Email' ? 'Email' : `Share on ${n}`}</a></li>`).join('\n');
  const fill = o.url ? '' : '\n' + onReady('__qlShare', "var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title);document.querySelectorAll('a[data-ql-share]').forEach(function(a){a.href=a.href.replace(/(url=|u=|body=)(?=&|$)/,'$1'+u).replace(/(text=|title=|subject=)(?=&|$|%20)/,'$1'+t).replace(/%20(?=$)/,'%20'+u)});");
  return {
    key: 'share',
    html: `<nav class="ql-share" aria-label="Share this page">\n  <ul>\n${li}\n  </ul>\n</nav>${fill}`,
    css: `.ql-share ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.5rem}
.ql-share a{display:inline-block;padding:.35rem .8rem;border-radius:4px;background:#eef1f5;color:#1d2733;text-decoration:none}
.ql-share a:hover,.ql-share a:focus-visible{background:#dde3ea}`,
  };
}

// ------------------------------------------------------------------------------------------
// Page components

export function marquee(o: { text: string; seconds?: number; direction?: 'left' | 'right'; legacy?: boolean; behavior?: 'scroll' | 'alternate' }): Component {
  if (o.legacy) return { html: `<marquee behavior="${o.behavior || 'scroll'}" direction="${o.direction || 'left'}" scrollamount="6">${esc(o.text)}</marquee>` };
  const dir = o.direction === 'right' ? ' ql-marquee-rtl' : '';
  const alt = o.behavior === 'alternate' ? ' ql-marquee-alt' : '';
  return {
    key: 'marquee',
    html: `<div class="ql-marquee${dir}${alt}" style="--ql-marquee-time:${o.seconds || 15}s"><span>${esc(o.text)}</span></div>`,
    css: `.ql-marquee{overflow:hidden;white-space:nowrap}
.ql-marquee>span{display:inline-block;padding-left:100%;animation:ql-marquee var(--ql-marquee-time,15s) linear infinite}
.ql-marquee-rtl>span{animation-direction:reverse}
.ql-marquee-alt>span{animation-direction:alternate;animation-timing-function:ease-in-out}
.ql-marquee:hover>span,.ql-marquee:focus-within>span{animation-play-state:paused}
@keyframes ql-marquee{from{transform:translateX(0)}to{transform:translateX(-100%)}}
@media (prefers-reduced-motion:reduce){.ql-marquee>span{animation:none;padding-left:0;white-space:normal}}`,
  };
}

export function hitCounter(o: { label?: string; service?: string } = {}): string {
  return `<p class="ql-hit-counter">${esc(o.label || 'Visitors')}: <span data-ql-counter>—</span></p>\n<!-- Hit counter placeholder: a static web host cannot count visits. Connect a counting service${o.service ? ` (${o.service.replace(/--/g, '-')})` : ''} or a server script that fills in [data-ql-counter]. -->`;
}

export interface GalleryImage { src: string; alt: string; caption?: string; width?: number | null; height?: number | null }
export type GalleryLayout = 'grid' | 'masonry' | 'slideshow';
export function photoGallery(images: GalleryImage[], o: { layout?: GalleryLayout; min?: number; lightbox?: boolean; captions?: boolean } = {}, gid = uid('ql-gal')): Component {
  const layout = o.layout || 'grid';
  const lb = o.lightbox !== false;
  const figs = images.map((im, i) => {
    const img = `<img${attrs({ src: im.src, alt: im.alt, width: im.width || null, height: im.height || null, loading: 'lazy' })}>`;
    const cap = o.captions !== false && im.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : '';
    return `  <figure${layout === 'slideshow' ? ` aria-label="${i + 1} of ${images.length}"` : ''}>${lb ? `<a href="#${gid}-${i + 1}">${img}</a>` : img}${cap}</figure>`;
  }).join('\n');
  const boxes = lb ? images.map((im, i) => `<div class="ql-lightbox" id="${gid}-${i + 1}" role="dialog" aria-label="${a(im.caption || im.alt || `Picture ${i + 1}`)}">
  <a class="ql-lightbox-close" href="#${gid}" aria-label="Close">×</a>
  <img src="${a(im.src)}" alt="${a(im.alt)}">${im.caption ? `\n  <p>${esc(im.caption)}</p>` : ''}${images.length > 1 ? `\n  <p class="ql-lightbox-nav"><a href="#${gid}-${((i - 1 + images.length) % images.length) + 1}">Previous</a> <a href="#${gid}-${((i + 1) % images.length) + 1}">Next</a></p>` : ''}
</div>`).join('\n') : '';
  return {
    key: 'gallery',
    html: `<div class="ql-gallery ql-gallery-${layout}" id="${gid}"${o.min ? ` style="--ql-gal-min:${o.min}px"` : ''}${layout === 'slideshow' ? ' tabindex="0" aria-label="Slide show"' : ''}>\n${figs}\n</div>${boxes ? '\n' + boxes : ''}`,
    css: `.ql-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--ql-gal-min,180px),1fr));gap:12px}
.ql-gallery figure{margin:0}
.ql-gallery img{display:block;width:100%;height:auto;border-radius:4px}
.ql-gallery figcaption{font-size:.9em;margin-top:.3em}
.ql-gallery-grid img{aspect-ratio:4/3;object-fit:cover}
.ql-gallery-masonry{display:block;columns:var(--ql-gal-min,220px);column-gap:12px}
.ql-gallery-masonry figure{break-inside:avoid;margin-bottom:12px}
.ql-gallery-slideshow{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:0}
.ql-gallery-slideshow figure{flex:0 0 100%;scroll-snap-align:center}
.ql-gallery-slideshow img{max-height:70vh;object-fit:contain}
.ql-lightbox{display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.88);color:#fff;flex-direction:column;align-items:center;justify-content:center;padding:2rem;text-align:center}
.ql-lightbox:target{display:flex}
.ql-lightbox img{max-width:100%;max-height:80vh}
.ql-lightbox a{color:#fff}
.ql-lightbox-close{position:absolute;top:.5rem;right:1rem;font-size:2.5rem;text-decoration:none;line-height:1}
.ql-lightbox-nav a{margin:0 1rem}`,
  };
}

export function lightbox(im: GalleryImage, thumbWidth = 240, id = uid('ql-lb')): Component {
  const g = photoGallery([im], { lightbox: true }, id);
  return { key: 'gallery', css: g.css, html: `<a href="#${id}-1" class="ql-lightbox-thumb"><img${attrs({ src: im.src, alt: im.alt, width: thumbWidth, loading: 'lazy' })}></a>\n<span id="${id}"></span>\n` + g.html.split('\n</div>\n')[1] };
}

export function carousel(slides: { title: string; text: string; image?: string; alt?: string }[], label = 'Featured', id = uid('ql-car')): Component {
  const n = slides.length;
  const s = slides.map((x, i) => `    <div class="ql-slide" id="${id}-${i + 1}" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${n}">
      ${x.image ? `<img src="${a(x.image)}" alt="${a(x.alt || '')}">` : ''}
      <div class="ql-slide-text"><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></div>
    </div>`).join('\n');
  const dots = slides.map((_, i) => `<a href="#${id}-${i + 1}" aria-label="Go to slide ${i + 1}">${i + 1}</a>`).join(' ');
  return {
    key: 'carousel',
    html: `<section class="ql-carousel" aria-roledescription="carousel" aria-label="${a(label)}">
  <div class="ql-carousel-track" tabindex="0">
${s}
  </div>
  <nav class="ql-carousel-dots" aria-label="Slides">${dots}</nav>
</section>`,
    css: `.ql-carousel{position:relative}
.ql-carousel-track{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;border-radius:8px}
.ql-slide{flex:0 0 100%;scroll-snap-align:start;position:relative;min-height:14rem;background:#2b3a4a;color:#fff;display:flex;align-items:flex-end}
.ql-slide img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ql-slide-text{position:relative;padding:1.5rem;background:linear-gradient(transparent,rgba(0,0,0,.6));width:100%}
.ql-carousel-dots{display:flex;justify-content:center;gap:.5rem;margin-top:.5rem}
.ql-carousel-dots a{display:inline-block;min-width:1.8rem;text-align:center;border-radius:999px;background:#e3e7ec;color:#1d2733;text-decoration:none}
@media (prefers-reduced-motion:reduce){.ql-carousel-track{scroll-behavior:auto}}`,
  };
}

/** Tabs built from radio buttons: no script, arrow keys move between tabs. */
export function tabs(items: { title: string; body: string }[], id = uid('ql-tabs')): Component {
  const html = items.map((t, i) => `  <input type="radio" name="${id}" id="${id}-${i + 1}"${i === 0 ? ' checked' : ''}>
  <label for="${id}-${i + 1}">${esc(t.title)}</label>
  <div class="ql-tab-panel">${t.body}</div>`).join('\n');
  return {
    key: 'tabs',
    html: `<div class="ql-tabs">\n${html}\n</div>`,
    css: `.ql-tabs{display:flex;flex-wrap:wrap;border-bottom:1px solid #ccc}
.ql-tabs>input{position:absolute;opacity:0;width:1px;height:1px}
.ql-tabs>label{order:0;padding:.5rem 1rem;cursor:pointer;border-bottom:3px solid transparent}
.ql-tabs>.ql-tab-panel{order:1;width:100%;display:none;padding:1rem 0;border-top:1px solid #ccc}
.ql-tabs>input:checked+label{border-bottom-color:currentColor;font-weight:600}
.ql-tabs>input:focus-visible+label{outline:2px solid #1a73e8;outline-offset:2px}
.ql-tabs>input:checked+label+.ql-tab-panel{display:block}`,
  };
}

export function accordion(items: { title: string; body: string }[], exclusive = false, name = uid('ql-acc')): Component {
  return {
    key: 'accordion',
    html: `<div class="ql-accordion">\n${items.map((x, i) => `  <details${exclusive ? ` name="${name}"` : ''}${i === 0 ? ' open' : ''}>\n    <summary>${esc(x.title)}</summary>\n    <div>${x.body}</div>\n  </details>`).join('\n')}\n</div>`,
    css: `.ql-accordion details{border:1px solid #ccc;border-radius:4px;margin-bottom:.5rem}
.ql-accordion summary{padding:.6rem .9rem;cursor:pointer;font-weight:600}
.ql-accordion details>div{padding:0 .9rem .8rem}`,
  };
}

export function modal(o: { button: string; title: string; body: string }, id = uid('ql-modal')): Component {
  return {
    key: 'modal',
    html: `<button type="button" class="ql-modal-open" data-ql-dialog="${id}">${esc(o.button)}</button>
<dialog id="${id}" class="ql-modal" aria-labelledby="${id}-title">
  <h2 id="${id}-title">${esc(o.title)}</h2>
  <div>${o.body}</div>
  <form method="dialog"><button>Close</button></form>
</dialog>
` + onReady('__qlDialogs', "document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-ql-dialog]');if(b){var d=document.getElementById(b.getAttribute('data-ql-dialog'));if(d&&d.showModal)d.showModal();}});"),
    css: `.ql-modal{max-width:32rem;border:0;border-radius:8px;padding:1.5rem;box-shadow:0 10px 40px rgba(0,0,0,.3)}
.ql-modal::backdrop{background:rgba(0,0,0,.5)}`,
  };
}

/** A responsive navigation bar: links in a row; on narrow screens a Menu button (a checkbox, no script) shows them. */
export function navbar(o: { brand: string; brandHref: string; items: NavItem[] }, id = uid('ql-nav')): Component {
  const li = o.items.map((x) => `      <li><a href="${a(x.href)}"${x.current ? ' aria-current="page"' : ''}>${esc(x.label)}</a></li>`).join('\n');
  return {
    key: 'navbar',
    html: `<header class="ql-navbar">
  <a class="ql-navbar-brand" href="${a(o.brandHref)}">${esc(o.brand)}</a>
  <input type="checkbox" id="${id}" class="ql-navbar-toggle">
  <label for="${id}" class="ql-navbar-button"><span aria-hidden="true">☰</span> Menu</label>
  <nav aria-label="Main">
    <ul>
${li}
    </ul>
  </nav>
</header>`,
    css: `.ql-navbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem;padding:.75rem 1rem;background:#1d2733;color:#fff}
.ql-navbar a{color:inherit;text-decoration:none}
.ql-navbar-brand{font-weight:700;font-size:1.2rem}
.ql-navbar ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:1.25rem}
.ql-navbar nav a:hover,.ql-navbar nav a:focus-visible,.ql-navbar a[aria-current=page]{text-decoration:underline}
.ql-navbar-toggle{position:absolute;opacity:0;width:1px;height:1px}
.ql-navbar-button{display:none;cursor:pointer;padding:.25rem .6rem;border:1px solid currentColor;border-radius:4px}
.ql-navbar-toggle:focus-visible+.ql-navbar-button{outline:2px solid #8ab4f8;outline-offset:2px}
@media (max-width:40em){.ql-navbar-button{display:inline-block}.ql-navbar nav{display:none;width:100%}.ql-navbar ul{flex-direction:column;gap:.5rem;padding:.5rem 0}.ql-navbar-toggle:checked~nav{display:block}}`,
  };
}

export function cookieBanner(o: { text: string; button?: string; policy?: string }): Component {
  return {
    key: 'cookie',
    html: `<div class="ql-cookie" role="region" aria-label="Cookie notice" hidden>
  <p>${esc(o.text)}${o.policy ? ` <a href="${a(o.policy)}">Learn more</a>` : ''}</p>
  <button type="button" class="ql-cookie-ok">${esc(o.button || 'OK')}</button>
</div>
` + onReady('__qlCookie', "var b=document.querySelector('.ql-cookie');if(!b)return;var k='ql-cookie-ok';try{if(localStorage.getItem(k))return}catch(e){}b.hidden=false;b.querySelector('.ql-cookie-ok').addEventListener('click',function(){b.hidden=true;try{localStorage.setItem(k,'1')}catch(e){}});"),
    css: `.ql-cookie{position:fixed;left:1rem;right:1rem;bottom:1rem;z-index:900;display:flex;flex-wrap:wrap;gap:1rem;align-items:center;justify-content:space-between;padding:1rem;background:#1d2733;color:#fff;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.3)}
.ql-cookie[hidden]{display:none}
.ql-cookie p{margin:0}
.ql-cookie a{color:#8ab4f8}
.ql-cookie button{padding:.5rem 1.2rem;font:inherit;cursor:pointer}`,
  };
}

export function backToTop(label = 'Back to top'): Component {
  return {
    key: 'top',
    html: `<p class="ql-back-to-top"><a href="#top">↑ ${esc(label)}</a></p>`,
    css: `html{scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
.ql-back-to-top{text-align:right}
.ql-back-to-top a{display:inline-block;padding:.3rem .7rem;text-decoration:none}`,
  };
}

export interface Plan { name: string; price: string; period?: string; features: string[]; cta: string; href: string; featured?: boolean }
export function pricingTable(plans: Plan[]): Component {
  const cards = plans.map((p) => `  <div class="ql-plan${p.featured ? ' ql-plan-featured' : ''}">
    <h3>${esc(p.name)}</h3>
    <p class="ql-plan-price"><strong>${esc(p.price)}</strong>${p.period ? ` <span>${esc(p.period)}</span>` : ''}</p>
    <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    <p><a class="ql-plan-cta" href="${a(p.href)}">${esc(p.cta)}</a></p>
  </div>`).join('\n');
  return {
    key: 'pricing',
    html: `<div class="ql-pricing">\n${cards}\n</div>`,
    css: `.ql-pricing{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem}
.ql-plan{border:1px solid #d5dbe2;border-radius:8px;padding:1.25rem;text-align:center;display:flex;flex-direction:column}
.ql-plan-featured{border:2px solid #1a73e8;box-shadow:0 4px 18px rgba(26,115,232,.18)}
.ql-plan ul{list-style:none;padding:0;margin:1rem 0;flex:1}
.ql-plan li{padding:.3rem 0;border-bottom:1px solid #eef1f5}
.ql-plan-price strong{font-size:2rem}
.ql-plan-cta{display:inline-block;padding:.6rem 1.4rem;border-radius:6px;background:#1a73e8;color:#fff;text-decoration:none}`,
  };
}

export function testimonials(items: { quote: string; name: string; role?: string }[]): Component {
  return {
    key: 'testimonials',
    html: `<div class="ql-testimonials">\n${items.map((t) => `  <figure>\n    <blockquote><p>${esc(t.quote)}</p></blockquote>\n    <figcaption>— ${esc(t.name)}${t.role ? `, <cite>${esc(t.role)}</cite>` : ''}</figcaption>\n  </figure>`).join('\n')}\n</div>`,
    css: `.ql-testimonials{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem}
.ql-testimonials figure{margin:0;padding:1.25rem;background:#f5f7fa;border-radius:8px}
.ql-testimonials blockquote{margin:0 0 .75rem;font-style:italic}
.ql-testimonials cite{font-style:normal;color:#5f6b7a}`,
  };
}

export function hero(o: { title: string; text: string; cta?: string; href?: string; image?: string; bg?: string; color?: string }): Component {
  const bg = o.image ? `background:linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),url('${o.image.replace(/'/g, '%27')}') center/cover` : `background:${o.bg || '#1d2733'}`;
  return {
    key: 'hero',
    html: `<section class="ql-hero" style="${a(bg)};color:${a(o.color || '#fff')}">
  <h1>${esc(o.title)}</h1>
  <p>${esc(o.text)}</p>${o.cta ? `\n  <p><a class="ql-hero-cta" href="${a(o.href || '#')}">${esc(o.cta)}</a></p>` : ''}
</section>`,
    css: `.ql-hero{padding:clamp(3rem,10vw,7rem) 1.5rem;text-align:center}
.ql-hero h1{font-size:clamp(2rem,5vw,3.5rem);margin:0 0 .5rem}
.ql-hero p{font-size:1.15rem;max-width:40rem;margin:0 auto 1rem}
.ql-hero-cta{display:inline-block;padding:.75rem 1.75rem;border-radius:6px;background:#fff;color:#1d2733;text-decoration:none;font-weight:600}`,
  };
}

export function cards(items: { title: string; text: string; image?: string; alt?: string; href?: string; link?: string }[]): Component {
  return {
    key: 'cards',
    html: `<div class="ql-cards">\n${items.map((c) => `  <article class="ql-card">
    ${c.image ? `<img src="${a(c.image)}" alt="${a(c.alt || '')}" loading="lazy">` : ''}
    <div class="ql-card-body">
      <h3>${esc(c.title)}</h3>
      <p>${esc(c.text)}</p>${c.href ? `\n      <p><a href="${a(c.href)}">${esc(c.link || 'Read more')}<span class="ql-visually-hidden"> about ${esc(c.title)}</span></a></p>` : ''}
    </div>
  </article>`).join('\n')}\n</div>`,
    css: `.ql-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:1rem}
.ql-card{border:1px solid #d5dbe2;border-radius:8px;overflow:hidden;background:#fff}
.ql-card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}
.ql-card-body{padding:1rem}
.ql-card h3{margin-top:0}
.ql-visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`,
  };
}

export function timeline(items: { date: string; title: string; text: string }[]): Component {
  return {
    key: 'timeline',
    html: `<ol class="ql-timeline">\n${items.map((t) => `  <li>\n    <p class="ql-timeline-date">${/^\d{4}(-\d\d){0,2}$/.test(t.date) ? `<time datetime="${a(t.date)}">${esc(t.date)}</time>` : esc(t.date)}</p>\n    <h3>${esc(t.title)}</h3>\n    <p>${esc(t.text)}</p>\n  </li>`).join('\n')}\n</ol>`,
    css: `.ql-timeline{list-style:none;margin:0;padding:0 0 0 1.5rem;border-left:3px solid #1a73e8}
.ql-timeline li{position:relative;margin-bottom:1.5rem}
.ql-timeline li::before{content:"";position:absolute;left:-1.5rem;margin-left:-8px;top:.3rem;width:13px;height:13px;border-radius:50%;background:#1a73e8;border:2px solid #fff}
.ql-timeline h3{margin:.2rem 0}
.ql-timeline-date{margin:0;color:#5f6b7a;font-size:.9em}`,
  };
}

export function countdown(o: { target: string; label: string; done?: string }): Component {
  return {
    key: 'countdown',
    html: `<p class="ql-countdown" data-ql-countdown="${a(o.target)}" data-ql-done="${a(o.done || 'It has started!')}">${esc(o.label)} <time datetime="${a(o.target)}">${esc(o.target.replace('T', ' '))}</time></p>
` + onReady('__qlCountdown', "document.querySelectorAll('[data-ql-countdown]').forEach(function(e){var t=Date.parse(e.dataset.qlCountdown),out=e.querySelector('time');if(isNaN(t)||!out)return;function tick(){var s=Math.max(0,Math.floor((t-Date.now())/1000));if(!s){out.textContent=e.dataset.qlDone;return}var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),r=s%60;out.textContent=(d?d+' days ':'')+h+' hours '+m+' minutes '+r+' seconds';setTimeout(tick,1000)}tick();});"),
    css: '.ql-countdown time{font-variant-numeric:tabular-nums;font-weight:600}',
  };
}

export function rssLink(href: string, title: string): { html: string; head: string } {
  return {
    html: `<p class="ql-rss"><a href="${a(href)}" type="application/rss+xml">${esc(title)} (RSS feed)</a></p>`,
    head: `<link rel="alternate" type="application/rss+xml" title="${a(title)}" href="${a(href)}">`,
  };
}

/** Layout helpers. */
export function fluidGrid(o: { mobile: number; tablet: number; desktop: number; gap?: number; cells?: number; maxWidth?: number }): Component {
  const n = o.cells || o.desktop;
  return {
    key: `fluid-${o.mobile}-${o.tablet}-${o.desktop}`,
    html: `<div class="ql-fluid ql-fluid-${o.mobile}-${o.tablet}-${o.desktop}">\n${Array.from({ length: n }, (_, i) => `  <div><p>Column ${i + 1}</p></div>`).join('\n')}\n</div>`,
    css: `.ql-fluid-${o.mobile}-${o.tablet}-${o.desktop}{display:grid;gap:${o.gap ?? 20}px;max-width:${o.maxWidth || 1200}px;margin:0 auto;grid-template-columns:repeat(${o.mobile},1fr)}
@media (min-width:48em){.ql-fluid-${o.mobile}-${o.tablet}-${o.desktop}{grid-template-columns:repeat(${o.tablet},1fr)}}
@media (min-width:64em){.ql-fluid-${o.mobile}-${o.tablet}-${o.desktop}{grid-template-columns:repeat(${o.desktop},1fr)}}`,
  };
}
export function columnsBlock(o: { count: number; width?: string; gap?: string; rule?: string; inner?: string }): string {
  const style = `columns:${o.count}${o.width ? ' ' + o.width : ''};column-gap:${o.gap || '2em'}${o.rule ? `;column-rule:${o.rule}` : ''}`;
  return `<div style="${a(style)}">${o.inner || '<p>Text flows from one column into the next.</p>'}</div>`;
}
export function flexRow(o: { items: number; gap?: string; wrap?: boolean; justify?: string; align?: string }): string {
  const style = `display:flex;gap:${o.gap || '1rem'}${o.wrap !== false ? ';flex-wrap:wrap' : ''}${o.justify && o.justify !== 'flex-start' ? `;justify-content:${o.justify}` : ''}${o.align && o.align !== 'stretch' ? `;align-items:${o.align}` : ''}`;
  return `<div style="${a(style)}">\n${Array.from({ length: o.items }, (_, i) => `  <div style="flex:1 1 12rem"><p>Item ${i + 1}</p></div>`).join('\n')}\n</div>`;
}
export function gridLayout(o: { columns: number; rows?: number; gap?: string; min?: string }): string {
  const cols = o.min ? `repeat(auto-fit,minmax(${o.min},1fr))` : `repeat(${o.columns},1fr)`;
  const n = o.columns * (o.rows || 1);
  return `<div style="${a(`display:grid;grid-template-columns:${cols};gap:${o.gap || '1rem'}`)}">\n${Array.from({ length: n }, (_, i) => `  <div><p>Cell ${i + 1}</p></div>`).join('\n')}\n</div>`;
}
export function layerMarkup(o: { id: string; left: number; top: number; width: number; height: number; z?: number; inner?: string }): string {
  return `<div id="${a(o.id)}" style="position:absolute;left:${o.left}px;top:${o.top}px;width:${o.width}px;height:${o.height}px;z-index:${o.z ?? 1}">${o.inner || '<p>Layer</p>'}</div>`;
}
export function iframeMarkup(o: { src: string; title: string; width?: string; height?: string; lazy?: boolean; sandbox?: string | null; allowFullscreen?: boolean; name?: string }): string {
  return `<iframe${attrs({ src: o.src, title: o.title, name: o.name, width: o.width || '100%', height: o.height || '400', style: 'border:0', loading: o.lazy !== false ? 'lazy' : null, sandbox: o.sandbox ?? null, allowfullscreen: o.allowFullscreen })}></iframe>`;
}

// ------------------------------------------------------------------------------------------
// Built-in snippets (for the Snippets pane)

export interface Snippet { id: string; name: string; category: string; body: string; user?: boolean }
export const BUILTIN_SNIPPETS: Snippet[] = [
  { id: 'b-skip', category: 'Accessibility', name: 'Skip to content link', body: '<a class="skip-link" href="#main">Skip to main content</a>' },
  { id: 'b-vh', category: 'Accessibility', name: 'Visually hidden text', body: '<span class="visually-hidden">Text for screen readers</span>' },
  { id: 'b-landmarks', category: 'Layout', name: 'Page landmarks', body: '<header>\n  <p>Site name</p>\n</header>\n<nav aria-label="Main">\n  <ul>\n    <li><a href="index.html">Home</a></li>\n  </ul>\n</nav>\n<main id="main">\n  <h1>Page title</h1>\n  <p>Content.</p>\n</main>\n<footer>\n  <p>&copy; Your name</p>\n</footer>' },
  { id: 'b-two-col', category: 'Layout', name: 'Two columns (grid)', body: '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:2rem">\n  <div><h2>Left</h2><p>Text.</p></div>\n  <div><h2>Right</h2><p>Text.</p></div>\n</div>' },
  { id: 'b-sidebar', category: 'Layout', name: 'Content with sidebar', body: '<div style="display:flex;flex-wrap:wrap;gap:2rem">\n  <main style="flex:3 1 30rem"><h1>Title</h1><p>Main content.</p></main>\n  <aside style="flex:1 1 14rem"><h2>Related</h2><p>Sidebar.</p></aside>\n</div>' },
  { id: 'b-center', category: 'Layout', name: 'Centered container', body: '<div style="max-width:60rem;margin:0 auto;padding:0 1rem">\n  <p>Content.</p>\n</div>' },
  { id: 'b-figure', category: 'Text', name: 'Figure with caption', body: '<figure>\n  <img src="images/picture.jpg" alt="Describe the picture">\n  <figcaption>Caption</figcaption>\n</figure>' },
  { id: 'b-quote', category: 'Text', name: 'Quotation with source', body: '<figure>\n  <blockquote cite="https://example.com/">\n    <p>Quotation.</p>\n  </blockquote>\n  <figcaption>— Author, <cite>Work</cite></figcaption>\n</figure>' },
  { id: 'b-address', category: 'Text', name: 'Contact address', body: '<address>\n  Company name<br>\n  123 Main Street<br>\n  City, ST 12345<br>\n  <a href="tel:+15555550100">(555) 555-0100</a><br>\n  <a href="mailto:info@example.com">info@example.com</a>\n</address>' },
  { id: 'b-copyright', category: 'Text', name: 'Copyright footer', body: '<footer>\n  <p><small>&copy; 2026 Your name. All rights reserved.</small></p>\n</footer>' },
  { id: 'b-table', category: 'Tables', name: 'Accessible data table', body: '<table>\n  <caption>Table title</caption>\n  <thead>\n    <tr><th scope="col">Name</th><th scope="col">Value</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>First</td><td>1</td></tr>\n    <tr><td>Second</td><td>2</td></tr>\n  </tbody>\n</table>' },
  { id: 'b-btn', category: 'Forms', name: 'Button', body: '<button type="button">Button</button>' },
  { id: 'b-login', category: 'Forms', name: 'Sign-in form', body: '<form method="post" action="">\n  <p><label for="user">Email</label><br><input id="user" name="email" type="email" autocomplete="username" required></p>\n  <p><label for="pass">Password</label><br><input id="pass" name="password" type="password" autocomplete="current-password" required></p>\n  <p><button type="submit">Sign in</button></p>\n</form>' },
  { id: 'b-video', category: 'Media', name: 'Responsive video frame', body: '<div style="aspect-ratio:16/9">\n  <iframe src="" title="Video" style="width:100%;height:100%;border:0" loading="lazy" allowfullscreen></iframe>\n</div>' },
  { id: 'b-meta', category: 'Head', name: 'Basic head tags', body: '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="description" content="">\n<link rel="icon" href="favicon.ico">' },
  { id: 'b-darkmode', category: 'CSS', name: 'Light and dark color scheme', body: '<style>\n  :root { color-scheme: light dark; }\n  body { background: Canvas; color: CanvasText; }\n</style>' },
  { id: 'b-js-ready', category: 'Script', name: 'Run script when page is ready', body: "<script>\n  document.addEventListener('DOMContentLoaded', () => {\n    // code\n  });\n</script>" },
  { id: 'b-year', category: 'Script', name: 'Current year', body: '<span class="year"></span><script>document.querySelectorAll(\'.year\').forEach((e) => { e.textContent = new Date().getFullYear(); });</script>' },
  { id: 'b-php-date', category: 'Server', name: 'PHP: current year', body: "<?= date('Y') ?>" },
  { id: 'b-php-include', category: 'Server', name: 'PHP: include header', body: "<?php include __DIR__ . '/includes/header.php'; ?>" },
];
