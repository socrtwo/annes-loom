/**
 * Picture commands (the Pictures toolbar and Modify ▸ Image of desktop site editors): properties, alternate
 * text, swap, reset size, crop, resample, rotate, flip, brightness and contrast, sharpen, grayscale,
 * WebP conversion, optimization, auto thumbnails, responsive sizes (srcset), lazy loading, image map
 * hotspots, and editing in another program.
 *
 * Edited pictures are saved as new site files next to the original (the page's link changes, so Undo
 * brings back the original picture); dialogs that offer it can overwrite the original instead.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog, alertDialog, type DialogControl } from '../ui/dialog';
import { h, pickFile, download } from '../ui/dom';
import { view, isPage, selectedEl, mutate, setAttr, getAttr, setStyleProp } from '../editor/ops';
import { cacheFor } from '../editor/workspace';
import {
  processImage, decode, drawPreview, sourceSize, adjustPixels, canEncode, extFor, outputMime, fitWithin,
  type ImageOp, type Encoded, type ImageSource,
} from '../editor/imageOps';
import { resolveRef, relativeRef, baseName, dirOf, stripExt, extOf, isImagePath, mimeOf, joinPath, slugify, isPagePath } from '../model/paths';
import { rewriteRefs, unb64 } from '../model/site';

// ------------------------------------------------------------------------------------------
// Selection and files

/** The selected picture (also when its link, picture or figure element is selected). */
export function imgOf(app: App): HTMLImageElement | null {
  const el = selectedEl(app);
  if (!el) return null;
  if (el.tagName === 'IMG') return el as HTMLImageElement;
  if (/^(A|PICTURE|FIGURE)$/.test(el.tagName)) { const imgs = el.querySelectorAll('img'); if (imgs.length === 1) return imgs[0] as HTMLImageElement; }
  return null;
}
const hasImg = (app: App) => isPage(app) && !!imgOf(app);

function designReady(app: App): boolean {
  const v = view(app);
  if (v?.design?.doc && (v.tab.view === 'design' || v.tab.view === 'split')) return true;
  mutate(app, () => undefined);
  return false;
}

function requireImg(app: App): HTMLImageElement | null {
  if (!designReady(app)) return null;
  const img = imgOf(app);
  if (!img) toast('Select a picture first.');
  return img;
}

const rel = (app: App, path: string) => relativeRef(app.active.path, path);

/** Site pictures as link choices relative to the page. */
function siteImages(app: App): string[] {
  return app.site.list((f) => isImagePath(f.path)).map((f) => rel(app, f.path));
}

/** Writes a picture file the user picked into the site's images folder; returns its path. */
async function uploadPicture(app: App): Promise<string | null> {
  const [f] = await pickFile('image/*');
  if (!f) return null;
  const ext = extOf(f.name) || extFor(f.type);
  const p = app.site.freeName('images', slugify(stripExt(f.name)) || 'picture', ext);
  app.site.write(p, new Uint8Array(await f.arrayBuffer()), { mime: f.type || mimeOf(p) });
  return p;
}

interface Picked { img: HTMLImageElement; path: string; bytes: Uint8Array; mime: string }

/**
 * The selected picture's site file. Pictures embedded as data: URLs are saved into the site first; pictures
 * on other servers can be downloaded into the site when the server allows it.
 */
async function pictureFile(app: App, opts: { edit?: boolean } = {}): Promise<Picked | null> {
  const img = requireImg(app);
  if (!img) return null;
  const ref = (getAttr(img, 'src') || '').trim();
  if (!ref) { toast('This picture has no source file.'); return null; }
  let path: string | null = null;
  const dm = /^data:(image\/[\w.+-]+);base64,(.*)$/i.exec(ref);
  if (dm) {
    path = app.site.freeName('images', 'picture', extFor(dm[1]));
    app.site.write(path, unb64(dm[2]), { mime: dm[1] });
    mutate(app, () => setAttr(app, img, 'src', rel(app, path!)));
    toast(`The embedded picture was saved as ${path}.`);
  } else if (/^(https?:)?\/\//i.test(ref)) {
    const url = ref.startsWith('//') ? 'https:' + ref : ref;
    if (!await confirmDialog('Import Picture', `This picture is on another server:\n${url}\nPictures must be in the site to be edited. Download a copy into the site's images folder?`, 'Import')) return null;
    try {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!r.ok) throw new Error(String(r.status));
      const type = (r.headers.get('content-type') || '').split(';')[0] || mimeOf(url);
      if (!type.startsWith('image/')) throw new Error('not a picture');
      const name = slugify(stripExt(baseName(url.split(/[?#]/)[0]))) || 'picture';
      path = app.site.freeName('images', name, extOf(url.split(/[?#]/)[0]) || extFor(type));
      app.site.write(path, new Uint8Array(await r.arrayBuffer()), { mime: type });
      mutate(app, () => setAttr(app, img, 'src', rel(app, path!)));
      toast(`Imported ${path}.`);
    } catch {
      await alertDialog('Import Picture', 'The other server does not allow copying this picture from the browser.\nSave the picture to your computer, then use Swap Picture ▸ Upload to add it to the site.');
      return null;
    }
  } else {
    path = resolveRef(app.active.path, ref);
    if (!path || !app.site.has(path)) { toast(`${path || ref} is not in the site.`); return null; }
  }
  const f = app.site.get(path)!;
  const mime = f.mime || mimeOf(path);
  if (opts.edit) {
    if (/svg/.test(mime)) { toast('SVG drawings are edited as code or in a drawing program; this command works on photos and bitmaps.'); return null; }
    if (/gif/.test(mime) && !await confirmDialog('Edit GIF Picture', 'Editing keeps only the first frame of an animated GIF and saves the result as PNG.', 'Continue')) return null;
  }
  return { img, path, bytes: app.site.bytes(path)!, mime };
}

/**
 * Saves an edited picture and points the picture at it. A new file is written next to the original
 * (name-suffix.ext) unless `overwrite` is set and the type is unchanged.
 */
function saveEdit(app: App, p: Picked, enc: Encoded, suffix: string, opts: { overwrite?: boolean; size?: 'keep' | 'swap' | 'set' | 'scale'; scaleFrom?: { width: number; height: number } } = {}): string {
  const ext = extFor(enc.mime);
  const sameType = ext === extOf(p.path) || (ext === 'jpg' && extOf(p.path) === 'jpeg');
  let out: string;
  if (opts.overwrite && sameType) out = p.path;
  else if (opts.overwrite) out = app.site.has(joinPath(dirOf(p.path), `${stripExt(baseName(p.path))}.${ext}`)) ? app.site.freeName(dirOf(p.path), stripExt(baseName(p.path)), ext) : joinPath(dirOf(p.path), `${stripExt(baseName(p.path))}.${ext}`);
  else out = app.site.freeName(dirOf(p.path), `${stripExt(baseName(p.path)).replace(/-(edited|crop|small|opt|resampled)(_\d+)?$/, '')}-${suffix}`, ext);
  app.site.write(out, enc.bytes, { mime: enc.mime });
  const img = p.img;
  mutate(app, () => {
    setAttr(app, img, 'src', rel(app, out));
    const w = img.getAttribute('width'), hh = img.getAttribute('height');
    if (opts.size === 'swap' && w && hh) { img.setAttribute('width', hh); img.setAttribute('height', w); }
    if (opts.size === 'swap') { const sw = img.style.width, sh = img.style.height; if (sw || sh) { setStyleProp(app, img, 'width', sh || null); setStyleProp(app, img, 'height', sw || null); } }
    if (opts.size === 'set') { img.setAttribute('width', String(enc.width)); img.setAttribute('height', String(enc.height)); setStyleProp(app, img, 'width', null); setStyleProp(app, img, 'height', null); }
    if (opts.size === 'scale' && opts.scaleFrom && w) {
      const s = parseFloat(w) / opts.scaleFrom.width;
      if (s > 0) { img.setAttribute('width', String(Math.round(enc.width * s))); img.setAttribute('height', String(Math.round(enc.height * s))); }
    }
    if (img.hasAttribute('srcset')) { img.removeAttribute('srcset'); img.removeAttribute('data-ql-o-srcset'); img.removeAttribute('sizes'); }
  });
  toast(out === p.path ? `Saved over ${out}.` : `Saved as ${out}. The original is unchanged; Undo restores it.`, { ms: 4000 });
  return out;
}

async function quickEdit(app: App, ops: ImageOp[], suffix: string, size: 'keep' | 'swap' = 'keep'): Promise<void> {
  const p = await pictureFile(app, { edit: true });
  if (!p) return;
  const enc = await processImage(p.bytes, p.mime, ops);
  saveEdit(app, p, enc, suffix, { size });
}

const kb = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

/** Sets srcset on a Design view picture, showing every candidate through its blob: URL. */
function setSrcset(app: App, img: HTMLImageElement, value: string | null): void {
  if (!value) { img.removeAttribute('srcset'); img.removeAttribute('data-ql-o-srcset'); return; }
  const cache = cacheFor(app);
  let mapped = false;
  const shown = value.split(',').map((part) => {
    const t = part.trim().split(/\s+/);
    const p = t[0] ? resolveRef(app.active.path, t[0]) : null;
    const u = p ? cache.url(p, 'blob') : null;
    if (u) { t[0] = u; mapped = true; }
    return t.join(' ');
  }).join(', ');
  if (mapped) { img.setAttribute('data-ql-o-srcset', value); img.setAttribute('srcset', shown); }
  else { img.removeAttribute('data-ql-o-srcset'); img.setAttribute('srcset', value); }
}

const naturalOf = (img: HTMLImageElement) => ({ width: img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10) || 0, height: img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10) || 0 });
const shownOf = (img: HTMLImageElement) => ({ width: parseInt(img.getAttribute('width') || '', 10) || img.width || img.naturalWidth, height: parseInt(img.getAttribute('height') || '', 10) || img.height || img.naturalHeight });

function cssVal(el: Element, prop: string): string {
  const tmp = document.createElement('div');
  tmp.setAttribute('style', el.getAttribute('data-ql-o-style') ?? el.getAttribute('style') ?? '');
  return tmp.style.getPropertyValue(prop);
}

// ------------------------------------------------------------------------------------------
// Dialogs

async function propertiesDialog(app: App, arg?: Record<string, any>): Promise<void> {
  const img = requireImg(app);
  if (!img) return;
  const nat = naturalOf(img);
  const ratio = nat.width && nat.height ? nat.height / nat.width : 0;
  const link = img.parentElement?.tagName === 'A' ? img.parentElement : null;
  const float = cssVal(img, 'float');
  const valign = cssVal(img, 'vertical-align');
  const centered = cssVal(img, 'display') === 'block' && cssVal(img, 'margin-left') === 'auto';
  const align = float || (centered ? 'center' : valign || img.getAttribute('align') || 'none');
  const margin = cssVal(img, 'margin');
  const mm = /^(\d+)px(?:\s+(\d+)px)?/.exec(margin || '');
  const init = {
    src: getAttr(img, 'src') || '', alt: img.getAttribute('alt') ?? '', decorative: img.getAttribute('alt') === '', title: img.getAttribute('title') || '',
    width: img.getAttribute('width') || '', height: img.getAttribute('height') || '', lock: true,
    border: parseInt(cssVal(img, 'border-width') || img.getAttribute('border') || '0', 10) || 0,
    align, vspace: mm ? +mm[1] : parseInt(img.getAttribute('vspace') || '0', 10) || 0, hspace: mm ? +(mm[2] ?? mm[1]) : parseInt(img.getAttribute('hspace') || '0', 10) || 0,
    href: link ? getAttr(link, 'href') || '' : '', newWindow: link?.getAttribute('target') === '_blank',
    lazy: img.getAttribute('loading') === 'lazy', decoding: img.getAttribute('decoding') || 'auto',
    srcset: getAttr(img, 'srcset') || '', sizes: img.getAttribute('sizes') || '',
  };
  const pages = app.site.pages().map((f) => rel(app, f.path));
  let lockBusy = false;
  const v = arg || await openDialog({
    title: 'Picture Properties', wide: true,
    fields: [
      { key: 'h1', type: 'heading', label: 'Picture' },
      { key: 'src', label: 'Picture file', type: 'combo', value: init.src, options: siteImages(app) },
      { key: 'upload', label: 'Upload a picture…', type: 'button', onClick: async (_v, ctl) => { const p = await uploadPicture(app); if (p) ctl.set('src', rel(app, p)); } },
      { key: 'alt', label: 'Alternate text', type: 'text', value: init.alt, placeholder: 'What the picture shows or does', visibleIf: (x) => !x.decorative },
      { key: 'decorative', label: 'Decorative picture (empty alternate text)', type: 'checkbox', value: init.decorative },
      { key: 'title', label: 'Tooltip (title)', type: 'text', value: init.title },
      { key: 'h2', type: 'heading', label: 'Size' },
      { key: 'width', label: 'Width', type: 'number', value: init.width, min: 1, suffix: 'px', half: true },
      { key: 'height', label: 'Height', type: 'number', value: init.height, min: 1, suffix: 'px', half: true },
      { key: 'lock', label: 'Keep the aspect ratio', type: 'checkbox', value: true, half: true },
      { key: 'natural', type: 'info', label: nat.width ? `Actual size: ${nat.width} × ${nat.height} px` : '' },
      { key: 'h3', type: 'heading', label: 'Layout' },
      { key: 'align', label: 'Alignment', type: 'select', value: init.align, half: true, options: [{ value: 'none', label: 'Default (in the line of text)' }, { value: 'left', label: 'Left (text wraps)' }, { value: 'right', label: 'Right (text wraps)' }, { value: 'center', label: 'Centered on its own line' }, { value: 'top', label: 'Top of the line' }, { value: 'middle', label: 'Middle of the line' }, { value: 'bottom', label: 'Bottom of the line' }] },
      { key: 'border', label: 'Border', type: 'number', value: init.border, min: 0, suffix: 'px', half: true },
      { key: 'hspace', label: 'Horizontal spacing', type: 'number', value: init.hspace, min: 0, suffix: 'px', half: true },
      { key: 'vspace', label: 'Vertical spacing', type: 'number', value: init.vspace, min: 0, suffix: 'px', half: true },
      { key: 'h4', type: 'heading', label: 'Link' },
      { key: 'href', label: 'Link to', type: 'combo', value: init.href, options: pages, placeholder: 'A page or https:// address (empty: no link)' },
      { key: 'newWindow', label: 'Open the link in a new window', type: 'checkbox', value: init.newWindow, visibleIf: (x) => !!x.href },
      { key: 'h5', type: 'heading', label: 'Loading' },
      { key: 'lazy', label: 'Load when scrolled into view (loading="lazy")', type: 'checkbox', value: init.lazy },
      { key: 'decoding', label: 'Decoding', type: 'select', value: init.decoding, half: true, options: [{ value: 'auto', label: 'Automatic' }, { value: 'async', label: 'Asynchronous' }, { value: 'sync', label: 'Synchronous' }] },
      { key: 'srcset', label: 'Other sizes (srcset)', type: 'textarea', rows: 2, value: init.srcset, placeholder: 'photo-480w.jpg 480w, photo-960w.jpg 960w' },
      { key: 'sizes', label: 'Display sizes (sizes)', type: 'text', value: init.sizes, placeholder: '(max-width: 600px) 100vw, 600px' },
    ],
    onChange: (vals, ctl: DialogControl, key) => {
      if (lockBusy || !vals.lock || !ratio) return;
      lockBusy = true;
      if (key === 'width' && vals.width) ctl.set('height', Math.round(vals.width * ratio));
      if (key === 'height' && vals.height) ctl.set('width', Math.round(vals.height / ratio));
      lockBusy = false;
    },
    validate: (x) => (!x.decorative && !String(x.alt).trim() ? 'Add alternate text, or mark the picture as decorative.' : null),
  });
  if (!v) return;
  const attrs = app.prefs.cssMode === 'tags';
  mutate(app, (doc) => {
    if (v.src && v.src !== init.src) setAttr(app, img, 'src', v.src.trim());
    img.setAttribute('alt', v.decorative ? '' : String(v.alt).trim());
    if (v.title) img.setAttribute('title', v.title); else img.removeAttribute('title');
    for (const k of ['width', 'height'] as const) {
      if (v[k]) img.setAttribute(k, String(Math.round(v[k]))); else img.removeAttribute(k);
      setStyleProp(app, img, k, null);
    }
    for (const a of ['align', 'border', 'hspace', 'vspace']) img.removeAttribute(a);
    for (const p of ['float', 'vertical-align', 'display', 'margin', 'margin-left', 'margin-right', 'border']) setStyleProp(app, img, p, null);
    if (v.align === 'left' || v.align === 'right') { if (attrs) img.setAttribute('align', v.align); else setStyleProp(app, img, 'float', v.align); }
    else if (v.align === 'center') { setStyleProp(app, img, 'display', 'block'); setStyleProp(app, img, 'margin-left', 'auto'); setStyleProp(app, img, 'margin-right', 'auto'); }
    else if (v.align !== 'none') { if (attrs) img.setAttribute('align', v.align === 'middle' ? 'middle' : v.align); else setStyleProp(app, img, 'vertical-align', v.align); }
    if (v.border) { if (attrs) img.setAttribute('border', String(v.border)); else setStyleProp(app, img, 'border', `${v.border}px solid`); }
    if (v.hspace || v.vspace) {
      if (attrs) { if (v.hspace) img.setAttribute('hspace', String(v.hspace)); if (v.vspace) img.setAttribute('vspace', String(v.vspace)); }
      else if (v.align !== 'center') setStyleProp(app, img, 'margin', `${v.vspace || 0}px ${v.hspace || 0}px`);
      else { setStyleProp(app, img, 'margin-top', `${v.vspace || 0}px`); setStyleProp(app, img, 'margin-bottom', `${v.vspace || 0}px`); }
    }
    if (v.lazy) img.setAttribute('loading', 'lazy'); else img.removeAttribute('loading');
    if (v.decoding && v.decoding !== 'auto') img.setAttribute('decoding', v.decoding); else img.removeAttribute('decoding');
    setSrcset(app, img, String(v.srcset || '').trim() || null);
    if (v.sizes) img.setAttribute('sizes', v.sizes); else img.removeAttribute('sizes');
    // Link
    const href = String(v.href || '').trim();
    let a = img.parentElement?.tagName === 'A' ? img.parentElement : null;
    if (href) {
      if (!a) { a = doc.createElement('a'); img.before(a); a.appendChild(img); }
      setAttr(app, a, 'href', href);
      if (v.newWindow) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); } else { a.removeAttribute('target'); if (a.getAttribute('rel') === 'noopener') a.removeAttribute('rel'); }
    } else if (a && a.children.length === 1 && !(a.textContent || '').trim()) a.replaceWith(img);
  });
}

/** A crop box dialog with a preview: drag on the preview or type the numbers. */
async function cropDialog(src: ImageSource): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const { width: W, height: H } = sourceSize(src);
  const canvas = h('canvas', { style: 'max-width:100%;cursor:crosshair;border:1px solid #888;touch-action:none', 'aria-label': 'Crop preview. Drag to draw the crop box.' }) as HTMLCanvasElement;
  const base = h('canvas') as HTMLCanvasElement;
  const scale = drawPreview(base, src, 460, 320);
  let ctl: DialogControl | null = null;
  let box = { x: 0, y: 0, width: W, height: H };
  const paint = () => {
    canvas.width = base.width; canvas.height = base.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(base, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    const x = box.x * scale, y = box.y * scale, w = box.width * scale, hh = box.height * scale;
    ctx.fillRect(0, 0, canvas.width, y); ctx.fillRect(0, y + hh, canvas.width, canvas.height - y - hh);
    ctx.fillRect(0, y, x, hh); ctx.fillRect(x + w, y, canvas.width - x - w, hh);
    ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 3]); ctx.strokeRect(x + 0.5, y + 0.5, w, hh);
  };
  let start: { x: number; y: number } | null = null;
  const pos = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(W, ((e.clientX - r.left) / r.width) * W)), y: Math.max(0, Math.min(H, ((e.clientY - r.top) / r.height) * H)) }; };
  canvas.addEventListener('pointerdown', (e) => { start = pos(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!start || !ctl) return;
    const p = pos(e);
    let w = Math.abs(p.x - start.x), hh = Math.abs(p.y - start.y);
    const ar = ratioOf(ctl.get('aspect'));
    if (ar) hh = w / ar;
    box = { x: Math.round(Math.min(start.x, p.x)), y: Math.round(Math.min(start.y, p.y)), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(Math.min(hh, H))) };
    for (const k of ['x', 'y', 'width', 'height'] as const) ctl.set(k, box[k]);
    paint();
  });
  canvas.addEventListener('pointerup', () => { start = null; });
  const ratioOf = (a: string) => { const m = /^(\d+):(\d+)$/.exec(a || ''); return m ? +m[1] / +m[2] : 0; };
  const v = await openDialog({
    title: 'Crop Picture', wide: true,
    content: h('div', { style: 'text-align:center;margin-bottom:8px' }, canvas, h('div', { class: 'ql-help' }, `Picture size: ${W} × ${H} px`)),
    fields: [
      { key: 'aspect', label: 'Shape', type: 'select', value: 'free', options: [{ value: 'free', label: 'Free' }, { value: '1:1', label: 'Square (1:1)' }, { value: '4:3', label: '4:3' }, { value: '3:2', label: '3:2' }, { value: '16:9', label: '16:9' }, { value: '3:4', label: 'Portrait 3:4' }] },
      { key: 'x', label: 'Left', type: 'number', value: 0, min: 0, max: W - 1, suffix: 'px', half: true },
      { key: 'y', label: 'Top', type: 'number', value: 0, min: 0, max: H - 1, suffix: 'px', half: true },
      { key: 'width', label: 'Width', type: 'number', value: W, min: 1, max: W, suffix: 'px', half: true },
      { key: 'height', label: 'Height', type: 'number', value: H, min: 1, max: H, suffix: 'px', half: true },
    ],
    onOpen: (c) => { ctl = c; paint(); },
    onChange: (vals, c, key) => {
      if (key === 'aspect') {
        const ar = ratioOf(vals.aspect);
        if (ar) { let w = W, hh = Math.round(W / ar); if (hh > H) { hh = H; w = Math.round(H * ar); } c.set('x', Math.round((W - w) / 2)); c.set('y', Math.round((H - hh) / 2)); c.set('width', w); c.set('height', hh); vals = c.values(); }
      }
      box = { x: Math.max(0, vals.x || 0), y: Math.max(0, vals.y || 0), width: Math.max(1, vals.width || 1), height: Math.max(1, vals.height || 1) };
      box.width = Math.min(box.width, W - box.x); box.height = Math.min(box.height, H - box.y);
      paint();
    },
    validate: (x) => (x.width >= 1 && x.height >= 1 && x.x < W && x.y < H ? null : 'The crop box must lie inside the picture.'),
  });
  return v ? box : null;
}

/** Dialog with a live preview of a pixel adjustment. */
async function adjustDialog(src: ImageSource): Promise<{ brightness: number; contrast: number } | null> {
  const base = h('canvas') as HTMLCanvasElement;
  drawPreview(base, src, 420, 280);
  const shown = h('canvas', { style: 'max-width:100%;border:1px solid #888', 'aria-label': 'Preview' }) as HTMLCanvasElement;
  const paint = (b: number, c: number) => {
    shown.width = base.width; shown.height = base.height;
    const ctx = shown.getContext('2d');
    const bctx = base.getContext('2d');
    if (!ctx || !bctx) return;
    const data = bctx.getImageData(0, 0, base.width, base.height);
    adjustPixels({ data: data.data, width: base.width, height: base.height }, b, c);
    ctx.putImageData(data, 0, 0);
  };
  const v = await openDialog({
    title: 'Brightness and Contrast',
    content: h('div', { style: 'text-align:center;margin-bottom:8px' }, shown),
    fields: [
      { key: 'brightness', label: 'Brightness', type: 'range', min: -100, max: 100, value: 0 },
      { key: 'contrast', label: 'Contrast', type: 'range', min: -100, max: 100, value: 0 },
    ],
    onOpen: () => paint(0, 0),
    onChange: (x) => paint(x.brightness || 0, x.contrast || 0),
  });
  return v ? { brightness: v.brightness, contrast: v.contrast } : null;
}

/** The "Save as" choice shared by the dialogs that can overwrite. */
const SAVE_FIELD = { key: 'save', label: 'Save', type: 'radio' as const, value: 'new', options: [{ value: 'new', label: 'As a new file next to the original' }, { value: 'overwrite', label: 'Over the original file (every page that uses it changes; Undo cannot bring it back)' }] };

// ------------------------------------------------------------------------------------------
// Hotspots

interface Hotspot { shape: 'rect' | 'circle' | 'poly'; coords: number[]; href: string; alt: string; newWindow?: boolean }

function mapFor(img: HTMLImageElement): HTMLMapElement | null {
  const use = (img.getAttribute('usemap') || '').replace(/^#/, '');
  if (!use) return null;
  return (img.ownerDocument.querySelector(`map[name="${CSS.escape(use)}"]`) as HTMLMapElement) || null;
}

async function hotspotDialog(app: App, img: HTMLImageElement): Promise<Hotspot | null> {
  const disp = shownOf(img);
  const scale = Math.min(1, 460 / (disp.width || 1), 320 / (disp.height || 1));
  const canvas = h('canvas', { width: String(Math.round(disp.width * scale)), height: String(Math.round(disp.height * scale)), style: 'max-width:100%;border:1px solid #888;cursor:crosshair', 'aria-label': 'Click on the picture to place the hotspot points' }) as HTMLCanvasElement;
  const pic = new Image();
  pic.src = img.currentSrc || img.src;
  const existing = mapFor(img);
  const others = existing ? [...existing.querySelectorAll('area')].map((a) => ({ shape: a.getAttribute('shape') || 'rect', coords: (a.getAttribute('coords') || '').split(',').map(Number) })) : [];
  let points: number[] = [];
  let ctl: DialogControl | null = null;
  const shapePath = (ctx: CanvasRenderingContext2D, shape: string, c: number[]) => {
    ctx.beginPath();
    if (shape === 'circle' && c.length >= 3) ctx.arc(c[0] * scale, c[1] * scale, c[2] * scale, 0, Math.PI * 2);
    else if (shape === 'rect' && c.length >= 4) ctx.rect(c[0] * scale, c[1] * scale, (c[2] - c[0]) * scale, (c[3] - c[1]) * scale);
    else if (c.length >= 4) { ctx.moveTo(c[0] * scale, c[1] * scale); for (let i = 2; i + 1 < c.length; i += 2) ctx.lineTo(c[i] * scale, c[i + 1] * scale); ctx.closePath(); }
  };
  const paint = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try { ctx.drawImage(pic, 0, 0, canvas.width, canvas.height); } catch { /* not loaded yet */ }
    ctx.lineWidth = 2;
    for (const o of others) { shapePath(ctx, o.shape, o.coords); ctx.fillStyle = 'rgba(255,170,0,.25)'; ctx.fill(); ctx.strokeStyle = '#d80'; ctx.stroke(); }
    const coords = String(ctl?.get('coords') || '').split(',').map((x) => parseFloat(x)).filter((x) => !Number.isNaN(x));
    shapePath(ctx, ctl?.get('shape') || 'rect', coords);
    ctx.fillStyle = 'rgba(43,121,214,.3)'; ctx.fill(); ctx.strokeStyle = '#2b79d6'; ctx.stroke();
    ctx.fillStyle = '#2b79d6';
    for (let i = 0; i + 1 < points.length; i += 2) ctx.fillRect(points[i] * scale - 3, points[i + 1] * scale - 3, 6, 6);
  };
  pic.onload = paint;
  canvas.addEventListener('click', (e) => {
    if (!ctl) return;
    const r = canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * disp.width), y = Math.round(((e.clientY - r.top) / r.height) * disp.height);
    const shape = ctl.get('shape');
    if (shape !== 'poly' && points.length >= 4) points = [];
    points.push(x, y);
    let coords = points;
    if (shape === 'rect' && points.length === 4) coords = [Math.min(points[0], points[2]), Math.min(points[1], points[3]), Math.max(points[0], points[2]), Math.max(points[1], points[3])];
    if (shape === 'circle' && points.length === 4) coords = [points[0], points[1], Math.round(Math.hypot(points[2] - points[0], points[3] - points[1]))];
    ctl.set('coords', coords.join(','));
    paint();
  });
  const pages = app.site.pages().map((f) => rel(app, f.path));
  const v = await openDialog({
    title: 'Image Map Hotspot', wide: true,
    help: 'Rectangle: click two corners. Circle: click the center, then the edge. Polygon: click each corner.',
    content: h('div', { style: 'text-align:center;margin-bottom:8px' }, canvas),
    fields: [
      { key: 'shape', label: 'Shape', type: 'select', value: 'rect', half: true, options: [{ value: 'rect', label: 'Rectangle' }, { value: 'circle', label: 'Circle' }, { value: 'poly', label: 'Polygon' }] },
      { key: 'clear', label: 'Clear points', type: 'button', onClick: (_x, c) => { points = []; c.set('coords', ''); paint(); } },
      { key: 'coords', label: 'Coordinates', type: 'text', value: '', placeholder: 'x1,y1,x2,y2 (rectangle) · x,y,r (circle) · x1,y1,x2,y2,… (polygon)' },
      { key: 'href', label: 'Link to', type: 'combo', value: '', options: pages },
      { key: 'alt', label: 'Alternate text', type: 'text', value: '', placeholder: 'Where the hotspot goes (required)' },
      { key: 'newWindow', label: 'Open in a new window', type: 'checkbox', value: false },
    ],
    onOpen: (c) => { ctl = c; paint(); },
    onChange: (_x, _c, key) => { if (key === 'shape') points = []; paint(); },
    validate: (x) => {
      const n = String(x.coords).split(',').filter((s) => s.trim() !== '' && !Number.isNaN(+s)).length;
      if (x.shape === 'rect' && n !== 4) return 'A rectangle needs four numbers: left, top, right, bottom.';
      if (x.shape === 'circle' && n !== 3) return 'A circle needs three numbers: center x, center y and radius.';
      if (x.shape === 'poly' && (n < 6 || n % 2)) return 'A polygon needs at least three points (six numbers).';
      if (!String(x.href).trim()) return 'Choose where the hotspot links to.';
      if (!String(x.alt).trim()) return 'Add alternate text for the hotspot.';
      return null;
    },
  });
  if (!v) return null;
  return { shape: v.shape, coords: String(v.coords).split(',').map((s) => Math.round(+s)), href: v.href.trim(), alt: v.alt.trim(), newWindow: v.newWindow };
}

// ------------------------------------------------------------------------------------------
// Commands

const pic = { tab: 'Picture', edits: true, isEnabled: hasImg } as const;

def([
  { id: 'picture.properties', label: 'Picture Properties…', icon: 'image', group: 'Properties', origin: 'FrontPage, Expression Web, Dreamweaver', ...pic, run: (app, arg) => propertiesDialog(app, arg) },
  {
    id: 'picture.alt', label: 'Alternate Text…', icon: 'description', group: 'Properties', origin: 'Accessibility (WCAG 1.1.1)', ...pic,
    run: async (app, arg?: string) => {
      const img = requireImg(app);
      if (!img) return;
      const src = getAttr(img, 'src') || '';
      const guess = stripExt(baseName(src.split(/[?#]/)[0])).replace(/[-_]+/g, ' ').replace(/\b\d+\b/g, '').trim();
      let alt = arg;
      if (alt == null) {
        const v = await openDialog({
          title: 'Alternate Text',
          help: 'Describe what the picture shows or what its link does. Mark pictures that are only decoration so screen readers skip them.',
          fields: [
            { key: 'alt', label: 'Alternate text', type: 'textarea', rows: 3, value: img.getAttribute('alt') ?? '', placeholder: guess ? `For example: ${guess}` : '', autofocus: true, visibleIf: (x) => !x.decorative },
            { key: 'decorative', label: 'Decorative picture (empty alternate text)', type: 'checkbox', value: img.getAttribute('alt') === '' },
          ],
          validate: (x) => (!x.decorative && !String(x.alt).trim() ? 'Type the alternate text, or mark the picture as decorative.' : null),
        });
        if (!v) return;
        alt = v.decorative ? '' : String(v.alt).trim();
      }
      mutate(app, () => img.setAttribute('alt', alt!));
    },
  },
  {
    id: 'picture.swap', label: 'Change Picture…', icon: 'swap_horiz', group: 'Properties', origin: 'Expression Web, Word', ...pic,
    tip: 'Replace the picture with another one, keeping its size and settings.',
    run: async (app, arg?: string) => {
      const img = requireImg(app);
      if (!img) return;
      const cur = resolveRef(app.active.path, getAttr(img, 'src') || '');
      let src = arg, keepSize = true, replaceFile = false;
      let uploaded: string | null = null;
      if (src == null) {
        const v = await openDialog({
          title: 'Change Picture',
          fields: [
            { key: 'src', label: 'New picture', type: 'combo', value: '', options: siteImages(app), placeholder: 'Choose a site picture or upload one' },
            { key: 'upload', label: 'Upload a picture…', type: 'button', onClick: async (_v, ctl) => { const p = await uploadPicture(app); if (p) { uploaded = p; ctl.set('src', rel(app, p)); } } },
            { key: 'keep', label: 'Keep the current size', type: 'checkbox', value: true },
            ...(cur && app.site.has(cur) ? [{ key: 'replace', label: `Replace the file ${cur} itself (every page that shows it changes)`, type: 'checkbox' as const, value: false }] : []),
          ],
          validate: (x) => (String(x.src).trim() ? null : 'Choose the new picture.'),
        });
        if (!v) return;
        src = String(v.src).trim(); keepSize = v.keep; replaceFile = !!v.replace;
      }
      const shown = shownOf(img);
      if (replaceFile && cur) {
        const from = resolveRef(app.active.path, src);
        if (!from || !app.site.has(from)) { toast('Choose a picture in the site to replace the file with.'); return; }
        app.site.write(cur, app.site.bytes(from)!, { mime: app.site.get(from)!.mime });
        if (uploaded === from) app.site.remove(from);
        mutate(app, () => setAttr(app, img, 'src', getAttr(img, 'src')!));
        toast(`Replaced ${cur}.`);
        return;
      }
      mutate(app, () => {
        setAttr(app, img, 'src', src!);
        if (keepSize && shown.width && shown.height) { img.setAttribute('width', String(shown.width)); img.setAttribute('height', String(shown.height)); }
        else { img.removeAttribute('width'); img.removeAttribute('height'); }
        if (img.hasAttribute('srcset')) { img.removeAttribute('srcset'); img.removeAttribute('data-ql-o-srcset'); img.removeAttribute('sizes'); }
      });
    },
  },
  {
    id: 'picture.resetSize', label: 'Reset Size', icon: 'aspect_ratio', group: 'Properties', origin: 'FrontPage, Expression Web', ...pic,
    tip: 'Show the picture at its actual size (and write that size so the page does not jump while loading).',
    run: (app) => {
      const img = requireImg(app);
      if (!img) return;
      mutate(app, () => {
        setStyleProp(app, img, 'width', null); setStyleProp(app, img, 'height', null);
        if (img.naturalWidth) { img.setAttribute('width', String(img.naturalWidth)); img.setAttribute('height', String(img.naturalHeight)); }
        else { img.removeAttribute('width'); img.removeAttribute('height'); }
      });
    },
  },
  {
    id: 'picture.crop', label: 'Crop…', icon: 'crop', group: 'Edit', origin: 'FrontPage, Expression Web, Dreamweaver', ...pic,
    run: async (app, arg?: { x: number; y: number; width: number; height: number }) => {
      const p = await pictureFile(app, { edit: true });
      if (!p) return;
      const src = await decode(p.bytes, p.mime);
      const box = arg || await cropDialog(src);
      if (!box) return;
      const enc = await processImage(p.bytes, p.mime, [{ op: 'crop', ...box }]);
      saveEdit(app, p, enc, 'crop', { size: 'scale', scaleFrom: sourceSize(src) });
    },
  },
  {
    id: 'picture.resample', label: 'Resample', icon: 'photo_size_select_large', group: 'Edit', origin: 'FrontPage, Expression Web, Dreamweaver', ...pic,
    tip: 'Resize the picture file itself to the size it is shown at, so visitors download no more than they see.',
    run: async (app, arg?: { width: number; height: number; save?: 'new' | 'overwrite' }) => {
      const p = await pictureFile(app, { edit: true });
      if (!p) return;
      const nat = await decode(p.bytes, p.mime).then(sourceSize);
      const shown = shownOf(p.img);
      const ratio = nat.height / nat.width;
      let busy = false;
      const v = arg || await openDialog({
        title: 'Resample Picture',
        help: `The file is ${nat.width} × ${nat.height} px and is shown at ${shown.width} × ${shown.height} px.`,
        fields: [
          { key: 'width', label: 'New width', type: 'number', value: shown.width, min: 1, suffix: 'px', half: true },
          { key: 'height', label: 'New height', type: 'number', value: shown.height, min: 1, suffix: 'px', half: true },
          { key: 'lock', label: 'Keep the aspect ratio', type: 'checkbox', value: true },
          SAVE_FIELD,
        ],
        onChange: (x, c, key) => { if (busy || !x.lock) return; busy = true; if (key === 'width' && x.width) c.set('height', Math.round(x.width * ratio)); if (key === 'height' && x.height) c.set('width', Math.round(x.height / ratio)); busy = false; },
        validate: (x) => (x.width >= 1 && x.height >= 1 ? null : 'Type the new size.'),
      });
      if (!v) return;
      if (v.width === nat.width && v.height === nat.height) { toast('The file already has this size.'); return; }
      if (v.width > nat.width && !await confirmDialog('Resample Picture', 'The new size is larger than the file: the picture will not gain detail and the file grows. Continue?', 'Resample')) return;
      const enc = await processImage(p.bytes, p.mime, [{ op: 'resize', width: v.width, height: v.height }]);
      saveEdit(app, p, enc, 'resampled', { overwrite: v.save === 'overwrite', size: 'set' });
    },
  },
  { id: 'picture.rotateLeft', label: 'Rotate Left 90°', icon: 'rotate_left', group: 'Edit', origin: 'FrontPage, Expression Web', ...pic, run: (app) => quickEdit(app, [{ op: 'rotate', deg: -90 }], 'edited', 'swap') },
  { id: 'picture.rotateRight', label: 'Rotate Right 90°', icon: 'rotate_right', group: 'Edit', origin: 'FrontPage, Expression Web', ...pic, run: (app) => quickEdit(app, [{ op: 'rotate', deg: 90 }], 'edited', 'swap') },
  { id: 'picture.flipH', label: 'Flip Horizontal', icon: 'flip', group: 'Edit', origin: 'FrontPage, Expression Web', ...pic, run: (app) => quickEdit(app, [{ op: 'flip', horizontal: true }], 'edited') },
  { id: 'picture.flipV', label: 'Flip Vertical', icon: 'flip', group: 'Edit', origin: 'FrontPage, Expression Web', ...pic, keywords: 'mirror upside down', run: (app) => quickEdit(app, [{ op: 'flip', horizontal: false }], 'edited') },
  {
    id: 'picture.brightness', label: 'Brightness and Contrast…', icon: 'brightness_6', group: 'Edit', origin: 'FrontPage, Expression Web, Dreamweaver', ...pic,
    run: async (app, arg?: { brightness: number; contrast: number }) => {
      const p = await pictureFile(app, { edit: true });
      if (!p) return;
      const v = arg || await adjustDialog(await decode(p.bytes, p.mime));
      if (!v || (!v.brightness && !v.contrast)) return;
      saveEdit(app, p, await processImage(p.bytes, p.mime, [{ op: 'adjust', brightness: v.brightness, contrast: v.contrast }]), 'edited');
    },
  },
  {
    id: 'picture.sharpen', label: 'Sharpen', icon: 'deblur', group: 'Edit', origin: 'Dreamweaver', ...pic,
    run: (app, arg?: number) => quickEdit(app, [{ op: 'sharpen', amount: typeof arg === 'number' ? arg : 0.6 }], 'edited'),
  },
  { id: 'picture.grayscale', label: 'Black and White', icon: 'filter_b_and_w', group: 'Edit', origin: 'FrontPage, Expression Web', ...pic, keywords: 'grayscale greyscale monochrome', run: (app) => quickEdit(app, [{ op: 'grayscale' }], 'edited') },
  {
    id: 'picture.toWebp', label: 'Convert to WebP…', icon: 'transform', group: 'Web', origin: 'Modern web practice', ...pic,
    tip: 'Save the picture in the WebP format (usually much smaller) and update its links.',
    run: async (app, arg?: { quality?: number; keep?: boolean; everywhere?: boolean }) => {
      const p = await pictureFile(app, { edit: true });
      if (!p) return;
      if (/webp/.test(p.mime)) { toast('The picture is already WebP.'); return; }
      if (!await canEncode('image/webp')) { await alertDialog('Convert to WebP', 'This browser cannot write WebP pictures. Try a current version of Chrome, Edge or Firefox.'); return; }
      const v = arg || await openDialog({
        title: 'Convert to WebP',
        fields: [
          { key: 'quality', label: 'Quality', type: 'range', min: 40, max: 100, value: 82, suffix: '%' },
          { key: 'everywhere', label: 'Update every page that shows this picture', type: 'checkbox', value: true },
          { key: 'keep', label: 'Keep the original file', type: 'checkbox', value: true },
        ],
      });
      if (!v) return;
      const enc = await processImage(p.bytes, p.mime, [], { mime: 'image/webp', quality: (v.quality ?? 82) / 100 });
      const out = app.site.freeName(dirOf(p.path), stripExt(baseName(p.path)), 'webp');
      app.site.write(out, enc.bytes, { mime: enc.mime });
      let others = 0;
      if (v.everywhere !== false) {
        for (const d of app.docs) if (d !== app.active) d.ui.flush();
        for (const f of app.site.list((x) => x.text != null && x.path !== app.active.path && (isPagePath(x.path) || extOf(x.path) === 'css'))) {
          const text = rewriteRefs(f.text!, f.path, (target) => (target === p.path ? relativeRef(f.path, out) : null));
          if (text !== f.text) { const tab = app.docs.find((d) => d.path === f.path); if (tab) app.editSource('Convert to WebP', () => text, tab); else app.site.write(f.path, text); others++; }
        }
      }
      mutate(app, () => {
        setAttr(app, p.img, 'src', rel(app, out));
        if (p.img.hasAttribute('srcset')) { p.img.removeAttribute('srcset'); p.img.removeAttribute('data-ql-o-srcset'); p.img.removeAttribute('sizes'); }
      });
      if (v.keep === false) {
        const still = app.site.list((x) => x.text != null && x.path !== app.active.path).some((f) => f.text!.includes(baseName(p.path)));
        if (!still) app.site.remove(p.path);
      }
      toast(`Saved ${out}: ${kb(p.bytes.length)} → ${kb(enc.bytes.length)}${others ? `; updated ${others} other file${others > 1 ? 's' : ''}` : ''}.`, { ms: 5000 });
    },
  },
  {
    id: 'picture.optimize', label: 'Optimize Picture…', icon: 'compress', group: 'Web', origin: 'Dreamweaver, Expression Web', ...pic,
    tip: 'Re-encode the picture at a chosen quality, format and maximum width, comparing file sizes.',
    run: async (app, arg?: { format?: string; quality?: number; maxWidth?: number; save?: string }) => {
      const p = await pictureFile(app, { edit: true });
      if (!p) return;
      const nat = await decode(p.bytes, p.mime).then(sourceSize);
      const webp = await canEncode('image/webp');
      const plan = (x: Record<string, any>) => {
        const mime = x.format === 'keep' ? outputMime(p.mime) : x.format;
        const ops: ImageOp[] = [];
        if (x.maxWidth && x.maxWidth < nat.width) { const s = fitWithin(nat.width, nat.height, x.maxWidth, Number.MAX_SAFE_INTEGER); ops.push({ op: 'resize', width: s.width, height: s.height }); }
        return { mime, ops, quality: (x.quality ?? 80) / 100 };
      };
      let seq = 0;
      let info: HTMLElement | null = null;
      const estimate = async (x: Record<string, any>) => {
        const my = ++seq;
        if (info) info.textContent = 'Measuring…';
        try {
          const pl = plan(x);
          const enc = await processImage(p.bytes, p.mime, pl.ops, { mime: pl.mime, quality: pl.quality });
          if (my === seq && info) info.textContent = `Now ${kb(p.bytes.length)} · after ${kb(enc.bytes.length)} (${Math.round((enc.bytes.length / p.bytes.length) * 100)}%) · ${enc.width} × ${enc.height} px · ${enc.mime.replace('image/', '').toUpperCase()}`;
        } catch (e) { if (info) info.textContent = String((e as Error).message || e); }
      };
      let timer: any;
      const v = arg || await openDialog({
        title: 'Optimize Picture',
        fields: [
          { key: 'format', label: 'Format', type: 'select', value: 'keep', half: true, options: [{ value: 'keep', label: `Keep (${outputMime(p.mime).replace('image/', '').toUpperCase()})` }, { value: 'image/jpeg', label: 'JPEG (photos)' }, ...(webp ? [{ value: 'image/webp', label: 'WebP (smallest)' }] : []), { value: 'image/png', label: 'PNG (drawings, transparency)' }] },
          { key: 'maxWidth', label: 'Maximum width', type: 'number', value: nat.width > 1600 ? 1600 : '', min: 16, suffix: 'px', half: true, help: `Now ${nat.width} px wide. Empty keeps the size.` },
          { key: 'quality', label: 'Quality', type: 'range', min: 30, max: 100, value: 80, suffix: '%', visibleIf: (x) => (x.format === 'keep' ? outputMime(p.mime) : x.format) !== 'image/png' },
          { key: 'sizes', type: 'info', label: '…' },
          SAVE_FIELD,
        ],
        onOpen: (c) => { info = c.body.querySelector('.ql-info'); void estimate(c.values()); },
        onChange: (x) => { clearTimeout(timer); timer = setTimeout(() => void estimate(x), 250); },
      });
      clearTimeout(timer);
      if (!v) return;
      const pl = plan({ format: 'keep', quality: 80, ...v });
      const enc = await processImage(p.bytes, p.mime, pl.ops, { mime: pl.mime, quality: pl.quality });
      if (enc.bytes.length >= p.bytes.length && !pl.ops.length && pl.mime === p.mime) { toast(`The picture is already well compressed (${kb(p.bytes.length)}); nothing was changed.`); return; }
      saveEdit(app, p, enc, 'opt', { overwrite: v.save === 'overwrite', size: pl.ops.length ? 'scale' : 'keep', scaleFrom: nat });
    },
  },
  {
    id: 'picture.autoThumbnail', label: 'Auto Thumbnail', icon: 'photo_size_select_small', group: 'Web', origin: 'FrontPage, Expression Web', ...pic,
    tip: 'Replace the picture with a small copy that links to the full-size picture.',
    run: async (app, arg?: number | { size: number; side?: 'width' | 'height' | 'longest' }) => {
      const p = await pictureFile(app, { edit: true });
      if (!p) return;
      const nat = await decode(p.bytes, p.mime).then(sourceSize);
      let size = typeof arg === 'number' ? arg : arg?.size;
      let side = (typeof arg === 'object' && arg.side) || 'width';
      if (!size) {
        const v = await openDialog({
          title: 'Auto Thumbnail',
          fields: [
            { key: 'size', label: 'Thumbnail size', type: 'number', value: 100, min: 16, max: 1000, suffix: 'px', half: true },
            { key: 'side', label: 'Measured along', type: 'select', value: 'width', half: true, options: [{ value: 'width', label: 'Width' }, { value: 'height', label: 'Height' }, { value: 'longest', label: 'Longest side' }] },
          ],
        });
        if (!v) return;
        size = v.size; side = v.side;
      }
      const s = side === 'height' ? fitWithin(nat.width, nat.height, Number.MAX_SAFE_INTEGER, size!) : side === 'longest' ? fitWithin(nat.width, nat.height, size!) : fitWithin(nat.width, nat.height, size!, Number.MAX_SAFE_INTEGER);
      if (s.width >= nat.width) { toast('The picture is already no larger than the thumbnail size.'); return; }
      const enc = await processImage(p.bytes, p.mime, [{ op: 'resize', width: s.width, height: s.height }], { mime: 'image/jpeg', quality: 0.85 });
      const thumb = app.site.freeName('images/thumbs', `${stripExt(baseName(p.path))}_small`, 'jpg');
      app.site.write(thumb, enc.bytes, { mime: enc.mime });
      const img = p.img;
      mutate(app, (doc) => {
        setAttr(app, img, 'src', rel(app, thumb));
        img.setAttribute('width', String(enc.width)); img.setAttribute('height', String(enc.height));
        setStyleProp(app, img, 'width', null); setStyleProp(app, img, 'height', null);
        if (img.hasAttribute('srcset')) { img.removeAttribute('srcset'); img.removeAttribute('data-ql-o-srcset'); img.removeAttribute('sizes'); }
        if (!img.closest('a')) {
          const a = doc.createElement('a');
          img.before(a);
          a.appendChild(img);
          setAttr(app, a, 'href', rel(app, p.path));
        }
      });
      toast(`Thumbnail saved as ${thumb}; it links to ${p.path}.`);
    },
  },
  {
    id: 'picture.responsive', label: 'Responsive Sizes…', icon: 'devices', group: 'Web', origin: 'Modern web practice (srcset)', ...pic,
    tip: 'Make smaller copies of the picture and list them in srcset, so phones download a smaller file.',
    run: async (app, arg?: { widths: number[]; sizes?: string; format?: string }) => {
      const p = await pictureFile(app, { edit: true });
      if (!p) return;
      const nat = await decode(p.bytes, p.mime).then(sourceSize);
      const shown = shownOf(p.img);
      const suggestions = [480, 800, 1200, 1600].filter((w) => w < nat.width).slice(-3);
      if (!suggestions.length) { toast(`The picture is only ${nat.width} px wide; smaller copies would not help.`); return; }
      const webp = await canEncode('image/webp');
      const v = arg || await openDialog({
        title: 'Responsive Sizes',
        help: `The picture is ${nat.width} px wide. Each width below gets its own file; the browser picks the one that fits.`,
        fields: [
          { key: 'widths', label: 'Widths (pixels)', type: 'text', value: suggestions.join(', ') },
          { key: 'sizes', label: 'Shown at (sizes)', type: 'text', value: shown.width && shown.width < nat.width ? `(max-width: ${shown.width}px) 100vw, ${shown.width}px` : '100vw' },
          { key: 'format', label: 'Format of the copies', type: 'select', value: 'keep', options: [{ value: 'keep', label: 'Same as the picture' }, ...(webp ? [{ value: 'image/webp', label: 'WebP' }] : [])] },
        ],
      });
      if (!v) return;
      const widths = (Array.isArray(v.widths) ? v.widths : String(v.widths).split(/[\s,]+/)).map(Number).filter((w: number) => w >= 16 && w < nat.width).sort((a: number, b: number) => a - b);
      if (!widths.length) { toast('Give at least one width smaller than the picture.'); return; }
      const mime = !v.format || v.format === 'keep' ? outputMime(p.mime) : v.format;
      const entries: string[] = [];
      for (const w of [...new Set<number>(widths)]) {
        const hh = Math.round((w * nat.height) / nat.width);
        const enc = await processImage(p.bytes, p.mime, [{ op: 'resize', width: w, height: hh }], { mime, quality: 0.82 });
        const out = joinPath(dirOf(p.path), `${stripExt(baseName(p.path))}-${w}w.${extFor(enc.mime)}`);
        app.site.write(out, enc.bytes, { mime: enc.mime });
        entries.push(`${rel(app, out)} ${w}w`);
      }
      entries.push(`${rel(app, p.path)} ${nat.width}w`);
      const img = p.img;
      mutate(app, () => {
        setSrcset(app, img, entries.join(', '));
        img.setAttribute('sizes', v.sizes || '100vw');
        if (!img.getAttribute('width')) { img.setAttribute('width', String(shown.width || nat.width)); img.setAttribute('height', String(shown.height || nat.height)); }
      });
      toast(`Made ${entries.length - 1} smaller cop${entries.length > 2 ? 'ies' : 'y'} and set srcset.`);
    },
  },
  {
    id: 'picture.lazy', label: 'Lazy Loading', icon: 'hourglass_bottom', group: 'Web', kind: 'toggle', origin: 'Modern web practice', ...pic,
    tip: 'Load the picture only when it scrolls into view (loading="lazy", decoding="async").',
    isActive: (app) => imgOf(app)?.getAttribute('loading') === 'lazy',
    run: (app) => {
      const img = requireImg(app);
      if (!img) return;
      mutate(app, () => {
        if (img.getAttribute('loading') === 'lazy') { img.removeAttribute('loading'); if (img.getAttribute('decoding') === 'async') img.removeAttribute('decoding'); }
        else { img.setAttribute('loading', 'lazy'); img.setAttribute('decoding', 'async'); }
      });
    },
  },
  {
    id: 'picture.hotspot', label: 'Image Map Hotspot…', icon: 'ads_click', group: 'Image Map', origin: 'FrontPage, Expression Web, Dreamweaver', ...pic,
    tip: 'Make part of the picture a link (a rectangle, circle or polygon hotspot).',
    run: async (app, arg?: Hotspot) => {
      const img = requireImg(app);
      if (!img) return;
      const hs = arg || await hotspotDialog(app, img);
      if (!hs) return;
      mutate(app, (doc) => {
        let map = mapFor(img);
        if (!map) {
          let n = 1;
          while (doc.querySelector(`map[name="map${n}"]`) || doc.getElementById(`map${n}`)) n++;
          map = doc.createElement('map');
          map.setAttribute('name', `map${n}`);
          map.id = `map${n}`;
          const after = (img.parentElement?.tagName === 'A' ? img.parentElement : img) as Element;
          after.after(map);
          img.setAttribute('usemap', `#map${n}`);
        }
        const area = doc.createElement('area');
        area.setAttribute('shape', hs.shape);
        area.setAttribute('coords', hs.coords.join(','));
        setAttr(app, area, 'href', hs.href);
        area.setAttribute('alt', hs.alt);
        if (hs.newWindow) { area.setAttribute('target', '_blank'); area.setAttribute('rel', 'noopener'); }
        map.appendChild(area);
      });
      toast('Hotspot added. Ctrl+click it in Preview to try it.');
    },
  },
  {
    id: 'picture.clearHotspots', label: 'Remove Hotspots', icon: 'layers_clear', group: 'Image Map', origin: 'FrontPage, Expression Web', ...pic,
    isEnabled: (app) => hasImg(app) && !!imgOf(app)?.getAttribute('usemap'),
    run: (app) => {
      const img = requireImg(app);
      if (!img) return;
      const map = mapFor(img);
      const users = map ? img.ownerDocument.querySelectorAll(`img[usemap="#${CSS.escape(map.getAttribute('name') || '')}"]`).length : 0;
      mutate(app, () => {
        if (map && users <= 1) map.remove();
        img.removeAttribute('usemap');
      });
    },
  },
  {
    id: 'picture.externalEditor', label: 'Edit in Another Program', icon: 'open_in_new', group: 'Edit', origin: 'Expression Web, Dreamweaver', ...pic, edits: false,
    tip: 'Save a copy of the picture to edit in your picture editor, then bring it back with Change Picture.',
    run: async (app) => {
      const p = await pictureFile(app);
      if (!p) return;
      download(new Blob([p.bytes as BlobPart], { type: p.mime }), baseName(p.path));
      await alertDialog('Edit in Another Program', `A copy of ${baseName(p.path)} was saved to your downloads.\nEdit it in your picture editor and save it.\nThen select the picture again and use Change Picture ▸ Upload a picture… and check "Replace the file ${p.path} itself" to bring the edited picture back into the site.`);
    },
  },
]);
