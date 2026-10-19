/**
 * Picture processing on a canvas: crop, resize (resample), rotate, flip, brightness and contrast,
 * grayscale, sharpen and re-encoding (JPEG, PNG, WebP). Works with OffscreenCanvas where the browser
 * has it and a document canvas otherwise. Pixel filters are plain functions over RGBA arrays so they
 * can be tested without a canvas.
 */

export interface Pixels { data: Uint8ClampedArray; width: number; height: number }

export interface Encoded { bytes: Uint8Array; mime: string; width: number; height: number }

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Source = ImageBitmap | HTMLImageElement | AnyCanvas;

export function makeCanvas(w: number, h: number): AnyCanvas {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function ctxOf(c: AnyCanvas): Ctx {
  const ctx = c.getContext('2d') as Ctx | null;
  if (!ctx) throw new Error('This browser cannot edit pictures (no 2D canvas).');
  return ctx;
}

const sizeOf = (s: Source): { w: number; h: number } => {
  if ('naturalWidth' in s) return { w: s.naturalWidth, h: s.naturalHeight };
  return { w: s.width, h: s.height };
};

/** Decodes picture bytes. */
export async function decode(bytes: Uint8Array, mime: string): Promise<Source> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (typeof createImageBitmap === 'function' && !/svg/.test(mime)) {
    try { return await createImageBitmap(blob); } catch { /* fall back to an image element */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

/** The picture's pixel size. */
export async function imageSize(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  const s = sizeOf(await decode(bytes, mime));
  return { width: s.w, height: s.h };
}

/** Encodes a canvas. Falls back to PNG when the browser cannot write the type; the result says which it wrote. */
export async function encode(c: AnyCanvas, mime: string, quality = 0.85): Promise<Encoded> {
  let blob: Blob | null;
  if ('convertToBlob' in c) blob = await c.convertToBlob({ type: mime, quality });
  else blob = await new Promise<Blob | null>((res) => (c as HTMLCanvasElement).toBlob(res, mime, quality));
  if (!blob) throw new Error('The picture could not be encoded.');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || mime, width: c.width, height: c.height };
}

/** True when the browser can encode the type (WebP is missing in some browsers). */
export async function canEncode(mime: string): Promise<boolean> {
  try { const r = await encode(makeCanvas(2, 2), mime, 0.8); return r.mime === mime; } catch { return false; }
}

function draw(src: Source, w: number, h: number, fn?: (ctx: Ctx) => void): AnyCanvas {
  const c = makeCanvas(w, h);
  const ctx = ctxOf(c);
  ctx.imageSmoothingEnabled = true;
  (ctx as any).imageSmoothingQuality = 'high';
  if (fn) fn(ctx); else ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);
  return c;
}

/** Resizes in halving steps for a smoother result when shrinking a lot. */
export function resizeCanvas(src: Source, w: number, h: number): AnyCanvas {
  let cur: Source = src;
  let { w: cw, h: ch } = sizeOf(src);
  while (cw / 2 >= w && ch / 2 >= h) {
    cw = Math.round(cw / 2); ch = Math.round(ch / 2);
    cur = draw(cur, cw, ch);
  }
  return draw(cur, w, h);
}

export function cropCanvas(src: Source, x: number, y: number, w: number, h: number): AnyCanvas {
  return draw(src, w, h, (ctx) => ctx.drawImage(src as CanvasImageSource, x, y, w, h, 0, 0, w, h));
}

export function rotateCanvas(src: Source, deg: 90 | -90 | 180): AnyCanvas {
  const { w, h } = sizeOf(src);
  const swap = deg !== 180;
  return draw(src, swap ? h : w, swap ? w : h, (ctx) => {
    ctx.translate(swap ? h / 2 : w / 2, swap ? w / 2 : h / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(src as CanvasImageSource, -w / 2, -h / 2);
  });
}

export function flipCanvas(src: Source, horizontal: boolean): AnyCanvas {
  const { w, h } = sizeOf(src);
  return draw(src, w, h, (ctx) => {
    if (horizontal) { ctx.translate(w, 0); ctx.scale(-1, 1); } else { ctx.translate(0, h); ctx.scale(1, -1); }
    ctx.drawImage(src as CanvasImageSource, 0, 0);
  });
}

/** Applies a pixel filter to a picture. */
export function filterCanvas(src: Source, fn: (p: Pixels) => void): AnyCanvas {
  const { w, h } = sizeOf(src);
  const c = draw(src, w, h);
  const ctx = ctxOf(c);
  const img = ctx.getImageData(0, 0, w, h);
  fn({ data: img.data, width: w, height: h });
  ctx.putImageData(img, 0, 0);
  return c;
}

// ------------------------------------------------------------------------------------------
// Pixel filters

/** Brightness and contrast, each -100…100. */
export function adjustPixels(p: Pixels, brightness: number, contrast: number): void {
  const b = (brightness / 100) * 255;
  const c = Math.max(-99.9, Math.min(100, contrast));
  const f = (259 * (c * 2.55 + 255)) / (255 * (259 - c * 2.55));
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = f * (d[i] - 128) + 128 + b;
    d[i + 1] = f * (d[i + 1] - 128) + 128 + b;
    d[i + 2] = f * (d[i + 2] - 128) + 128 + b;
  }
}

/** Luminance grayscale (ITU-R BT.709 weights). */
export function grayscalePixels(p: Pixels): void {
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = y;
  }
}

/** Unsharp-style 3×3 sharpen; amount 0…2 (1 is a moderate sharpen). Alpha is kept. */
export function sharpenPixels(p: Pixels, amount = 1): void {
  const { width: w, height: h } = p;
  const src = new Uint8ClampedArray(p.data);
  const d = p.data;
  const a = amount;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    for (let ch = 0; ch < 3; ch++) {
      const at = (xx: number, yy: number) => src[((Math.min(h - 1, Math.max(0, yy)) * w) + Math.min(w - 1, Math.max(0, xx))) * 4 + ch];
      const v = (1 + 4 * a) * at(x, y) - a * (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1));
      d[i + ch] = v;
    }
  }
}

/** Width and height that fit inside max × max (never enlarging). */
export function fitWithin(w: number, h: number, max: number, maxH = max): { width: number; height: number } {
  const s = Math.min(1, max / w, maxH / h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** The output type for an edit of a picture of `mime`: formats a canvas cannot write become PNG. */
export function outputMime(mime: string): string {
  return /^image\/(jpeg|png|webp)$/.test(mime) ? mime : 'image/png';
}

export function extFor(mime: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' } as Record<string, string>)[mime] || 'png';
}

// ------------------------------------------------------------------------------------------
// One-call operations on bytes

export type ImageOp =
  | { op: 'crop'; x: number; y: number; width: number; height: number }
  | { op: 'resize'; width: number; height: number }
  | { op: 'rotate'; deg: 90 | -90 | 180 }
  | { op: 'flip'; horizontal: boolean }
  | { op: 'adjust'; brightness: number; contrast: number }
  | { op: 'grayscale' }
  | { op: 'sharpen'; amount?: number }
  | { op: 'none' };

/** Decodes, applies the operations in order and encodes. */
export async function processImage(bytes: Uint8Array, mime: string, ops: ImageOp[], out: { mime?: string; quality?: number } = {}): Promise<Encoded> {
  let cur: Source = await decode(bytes, mime);
  for (const o of ops) cur = applyOp(cur, o);
  const target = out.mime || outputMime(mime);
  const { w, h } = sizeOf(cur);
  const src = cur;
  // JPEG has no transparency: transparent areas would turn black, so they are painted white.
  const canvas = target === 'image/jpeg'
    ? draw(src, w, h, (ctx) => { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(src as CanvasImageSource, 0, 0, w, h); })
    : 'getContext' in cur ? (cur as AnyCanvas) : draw(cur, w, h);
  return encode(canvas, target, out.quality ?? (target === 'image/png' ? undefined : 0.88));
}

export function applyOp(cur: Source, o: ImageOp): Source {
  const { w, h } = sizeOf(cur);
  switch (o.op) {
    case 'crop': {
      const x = Math.max(0, Math.min(w - 1, Math.round(o.x))), y = Math.max(0, Math.min(h - 1, Math.round(o.y)));
      return cropCanvas(cur, x, y, Math.max(1, Math.min(w - x, Math.round(o.width))), Math.max(1, Math.min(h - y, Math.round(o.height))));
    }
    case 'resize': return resizeCanvas(cur, Math.max(1, Math.round(o.width)), Math.max(1, Math.round(o.height)));
    case 'rotate': return rotateCanvas(cur, o.deg);
    case 'flip': return flipCanvas(cur, o.horizontal);
    case 'adjust': return filterCanvas(cur, (p) => adjustPixels(p, o.brightness, o.contrast));
    case 'grayscale': return filterCanvas(cur, grayscalePixels);
    case 'sharpen': return filterCanvas(cur, (p) => sharpenPixels(p, o.amount ?? 0.6));
    default: return cur;
  }
}

/** Draws a picture scaled into a canvas element for dialog previews; returns the scale used. */
export function drawPreview(target: HTMLCanvasElement, src: Source, maxW = 420, maxH = 300): number {
  const { w, h } = sizeOf(src);
  const s = Math.min(1, maxW / w, maxH / h);
  target.width = Math.max(1, Math.round(w * s));
  target.height = Math.max(1, Math.round(h * s));
  const ctx = target.getContext('2d');
  ctx?.drawImage(src as CanvasImageSource, 0, 0, target.width, target.height);
  return s;
}

export function sourceSize(src: Source): { width: number; height: number } { const s = sizeOf(src); return { width: s.w, height: s.h }; }
export type { Source as ImageSource };
