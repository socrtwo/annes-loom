/**
 * Insert commands, part 2: pictures, picture objects (placeholders, image maps, rollovers, interactive
 * buttons, clip art, shapes, decorative text), video and sound, embeds (YouTube, Vimeo, maps), drawing
 * (SVG, canvas), math, and legacy plug-in objects.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, type Field } from '../ui/dialog';
import { insertHtml, selectionText } from '../editor/ops';
import { resolveRef, isImagePath, extOf, stripExt } from '../model/paths';
import {
  imageMarkup, pictureMarkup, typeOfRef, imagePlaceholder, parseAreas, imageMapMarkup, rolloverImage, interactiveButton, videoMarkup, audioMarkup,
  parseYouTubeId, parseVimeoId, parseStart, youtubeEmbed, vimeoEmbed, parseMapLocation, osmEmbed, flashMarkup, objectMarkup, embedMarkup, appletMarkup,
  activexMarkup, parseParams, svgBlank, inlineSvg, canvasMarkup, CLIP_ART, clipArtSvg, SHAPES, shapeSvg, decorativeText, mathMarkup, idsIn, slugId, type ShapeKind, type TextEffect,
} from '../editor/components';
import { cmds, fileFields, imageSize, insertRaw, insertComponent, IMAGE_ACCEPT, rel } from './insert';

const isVideo = (p: string) => /\.(mp4|webm|ogv|mov|m4v)$/i.test(p);
const isAudio = (p: string) => /\.(mp3|ogg|oga|wav|m4a|flac|aac|opus)$/i.test(p);
const legacyWarning = (what: string) => toast(`${what} does not run in current browsers. The markup is inserted for old pages and archives; consider HTML5 video, audio or an image instead.`, { ms: 6500 });

/** Width/height fields filled from the picture when left empty. */
async function sizeOf(app: App, src: string, w: any, hgt: any, keep: boolean): Promise<{ width: number | null; height: number | null }> {
  let width = +w || null, height = +hgt || null;
  if (keep && (!width || !height)) {
    const s = await imageSize(app, src);
    if (s) {
      if (!width && !height) { width = s.width; height = s.height; }
      else if (width && !height) height = Math.round((s.height * width) / s.width);
      else if (height && !width) width = Math.round((s.width * height) / s.height);
    }
  }
  return { width, height };
}

const altFields = (value = ''): Field[] => [
  { key: 'alt', label: 'Alternate text (describes the picture for people who cannot see it)', type: 'text', value },
  { key: 'decorative', label: 'The picture is decorative (empty alternate text)', type: 'checkbox', value: false },
];
const altCheck = (x: Record<string, any>) => (!x.decorative && !String(x.alt || '').trim() ? 'Describe the picture, or mark it as decorative.' : null);
const imgFields = (app: App, key = 'src', label = 'Picture') => fileFields(app, key, label, { filter: isImagePath, accept: IMAGE_ACCEPT, dir: 'images' });
const guessAlt = (src: string) => stripExt(decodeURIComponent(src.split('/').pop() || '')).replace(/[-_]+/g, ' ').replace(/\b\d+\b/g, '').trim();

async function insertImage(app: App, arg: any, caption: boolean): Promise<void> {
  let v = arg && typeof arg === 'object' ? arg : typeof arg === 'string' ? { src: arg, alt: guessAlt(arg), auto: true } : null;
  if (!v) {
    v = await openDialog({
      title: caption ? 'Picture with Caption' : 'Picture', wide: true,
      fields: [
        ...imgFields(app),
        ...altFields(),
        ...(caption ? [{ key: 'caption', label: 'Caption', type: 'text' as const, value: '' }] : []),
        { key: 'width', label: 'Width', type: 'number', value: '', suffix: 'px', half: true, placeholder: 'auto' },
        { key: 'height', label: 'Height', type: 'number', value: '', suffix: 'px', half: true, placeholder: 'auto' },
        { key: 'auto', label: 'Use the picture’s own size for empty width/height (prevents layout shifts)', type: 'checkbox', value: true },
        { key: 'href', label: 'Link to (optional)', type: 'combo', value: '', options: [] },
        { key: 'lazy', label: 'Load when scrolled into view', type: 'checkbox', value: true },
        { key: 'title', label: 'Tooltip (optional)', type: 'text', value: '' },
      ],
      onChange: (x, ctl, key) => { if (key === 'src' && !ctl.get('alt')) ctl.set('alt', guessAlt(x.src || '')); },
      validate: (x) => (!x.src ? 'Choose a picture.' : altCheck(x)),
    });
    if (!v) return;
  }
  const { width, height } = await sizeOf(app, v.src, v.width, v.height, v.auto !== false);
  insertHtml(app, imageMarkup({ src: v.src, alt: v.decorative ? '' : v.alt || '', width, height, title: v.title, lazy: v.lazy !== false, href: v.href, caption: caption ? v.caption || 'Caption' : undefined }));
}

def(cmds('Pictures', 'FrontPage, Expression Web, Dreamweaver, KompoZer', [
  { id: 'insert.image', label: 'Picture', icon: 'image', popular: true, keywords: 'image img photo', run: (app, arg) => insertImage(app, arg, false) },
  { id: 'insert.picture', label: 'Picture with Caption', icon: 'add_photo_alternate', keywords: 'figure figcaption image', run: (app, arg) => insertImage(app, arg, true) },
  {
    id: 'insert.pictureElement', label: 'Responsive Picture', icon: 'photo_size_select_large', origin: 'HTML5 <picture>, modern builders', keywords: 'picture source srcset webp avif',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Responsive Picture', wide: true, help: 'Browsers pick the first source they support and that matches; the fallback picture is used otherwise. WebP/AVIF versions with the same name are found automatically.',
        fields: [
          ...imgFields(app, 'src', 'Fallback picture'),
          ...altFields(),
          { key: 'sources', label: 'Other sources (one per line: file | media condition)', type: 'textarea', rows: 4, value: '', placeholder: 'images/wide.webp | (min-width: 800px)\nimages/photo.avif' },
          { key: 'auto', label: 'Add WebP/AVIF versions found in the site', type: 'checkbox', value: true },
        ],
        validate: (x) => (!x.src ? 'Choose the fallback picture.' : altCheck(x)),
      });
      if (!v) return;
      const sources = String(v.sources || '').split('\n').map((l) => l.split('|').map((s) => s.trim())).filter(([s]) => s).map(([srcset, media]) => ({ srcset, media, type: typeOfRef(srcset) }));
      if (v.auto !== false) {
        const p = resolveRef(app.active.path, v.src);
        if (p) for (const e of ['avif', 'webp']) { const other: string = p.replace(/\.[^.]+$/, '.' + e); const ref = rel(app, other); if (other !== p && app.site.has(other) && !sources.some((s) => s.srcset === ref)) sources.unshift({ srcset: ref, media: '', type: `image/${e}` }); }
      }
      const { width, height } = await sizeOf(app, v.src, null, null, true);
      insertHtml(app, pictureMarkup({ src: v.src, alt: v.decorative ? '' : v.alt, sources, width, height }));
    },
  },
  {
    id: 'insert.imagePlaceholder', label: 'Picture Placeholder', icon: 'image_aspect_ratio', origin: 'Dreamweaver (Image Placeholder)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Picture Placeholder', help: 'A gray box of the right size to design with until the real picture is ready.',
        fields: [
          { key: 'width', label: 'Width', type: 'number', value: 400, suffix: 'px', half: true }, { key: 'height', label: 'Height', type: 'number', value: 300, suffix: 'px', half: true },
          { key: 'label', label: 'Label', type: 'text', value: '' },
          { key: 'bg', label: 'Background', type: 'color', value: '#d9dde3', half: true }, { key: 'fg', label: 'Text', type: 'color', value: '#5f6b7a', half: true },
        ],
      });
      if (!v) return;
      insertHtml(app, imagePlaceholder(Math.max(1, +v.width || 400), Math.max(1, +v.height || 300), v.label || undefined, v.bg, v.fg));
    },
  },
  {
    id: 'insert.imageMap', label: 'Image Map', icon: 'highlight_alt', origin: 'FrontPage (Hotspots), Dreamweaver, Expression Web',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Image Map', wide: true, help: 'Hotspots: one per line — shape, coordinates in pixels, link, and the text that describes the link. Shapes: rect (left,top,right,bottom), circle (x,y,radius), poly (x1,y1,x2,y2,…).',
        fields: [
          ...imgFields(app), ...altFields(),
          { key: 'name', label: 'Map name', type: 'text', value: slugId('map', new Set(idsIn(app.active.source))) },
          { key: 'areas', label: 'Hotspots', type: 'textarea', rows: 6, value: 'rect 0,0,100,100 index.html Home page\ncircle 200,60,40 contact.html Contact us' },
        ],
        validate: (x) => (!x.src ? 'Choose a picture.' : !parseAreas(x.areas || '').length ? 'Add at least one hotspot.' : altCheck(x)),
      });
      if (!v) return;
      const { width, height } = await sizeOf(app, v.src, null, null, true);
      insertHtml(app, imageMapMarkup({ src: v.src, alt: v.decorative ? '' : v.alt, name: v.name || 'map', areas: parseAreas(v.areas), width, height }));
    },
  },
  {
    id: 'insert.rolloverImage', label: 'Rollover Picture', icon: 'swap_horiz', origin: 'Dreamweaver (Rollover Image), FrontPage (Picture swap)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Rollover Picture', help: 'Shows a second picture while the pointer is over the first (or it has keyboard focus).',
        fields: [...imgFields(app, 'src', 'Picture'), ...imgFields(app, 'over', 'Rollover picture'), { key: 'alt', label: 'Alternate text', type: 'text', value: '' }, { key: 'href', label: 'Link to (optional)', type: 'text', value: '' }],
        validate: (x) => (!x.src || !x.over ? 'Choose both pictures.' : !x.alt?.trim() ? 'Describe the picture.' : null),
      });
      if (!v) return;
      const { width, height } = await sizeOf(app, v.src, null, null, true);
      insertRaw(app, rolloverImage({ src: v.src, over: v.over, alt: v.alt, href: v.href, width, height }), 'Insert Rollover Picture');
    },
  },
  {
    id: 'insert.interactiveButton', label: 'Interactive Button', icon: 'smart_button', origin: 'Expression Web, FrontPage (Interactive Buttons)', keywords: 'hover button link',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Interactive Button', help: 'A link styled as a button that changes when pointed at and when pressed. Made with CSS only, so it is sharp at any size and works with the keyboard.',
        preview: true, previewStyle: 'padding:16px;text-align:center;background:#fff',
        fields: [
          { key: 'text', label: 'Text', type: 'text', value: selectionText(app) || 'Button text', half: true },
          { key: 'href', label: 'Link', type: 'combo', value: '', options: [], half: true },
          { key: 'bg', label: 'Color', type: 'color', value: '#1a73e8', half: true }, { key: 'color', label: 'Text color', type: 'color', value: '#ffffff', half: true },
          { key: 'hoverBg', label: 'Hover color', type: 'color', value: '#1558b0', half: true }, { key: 'pressedBg', label: 'Pressed color', type: 'color', value: '#0d3c7a', half: true },
          { key: 'font', label: 'Font', type: 'combo', value: 'inherit', options: ['inherit', 'Arial, Helvetica, sans-serif', 'Georgia, serif', 'Verdana, sans-serif', 'Trebuchet MS, sans-serif', 'system-ui, sans-serif'], half: true },
          { key: 'size', label: 'Font size', type: 'number', value: 16, suffix: 'px', half: true },
          { key: 'radius', label: 'Corner radius', type: 'range', value: 6, min: 0, max: 30, suffix: 'px', half: true },
          { key: 'padX', label: 'Width padding', type: 'range', value: 22, min: 4, max: 60, suffix: 'px', half: true },
          { key: 'newWindow', label: 'Open the link in a new window', type: 'checkbox', value: false },
        ],
        onChange: (x, ctl) => { const c = interactiveButton({ ...x, href: '#' } as any, 'ql-ibtn-preview'); ctl.setPreview(`<style>${c.css}</style>${c.html}`); },
        validate: (x) => (x.text?.trim() ? null : 'Type the button text.'),
      });
      if (!v) return;
      insertComponent(app, interactiveButton({ ...v, size: +v.size, radius: +v.radius, padX: +v.padX, padY: Math.round(+v.padX / 2.2) }), 'Insert Interactive Button');
    },
  },
  {
    id: 'insert.clipArt', label: 'Clip Art', icon: 'interests', origin: 'FrontPage, Office (Clip Art)',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { id: arg, size: 48, color: '#1f4e9c', label: CLIP_ART.find((c) => c.id === arg)?.label } : arg || await openDialog({
        title: 'Clip Art', help: 'Simple drawings that scale to any size. The label is read by screen readers; leave it empty for a decorative picture.',
        preview: true, previewStyle: 'text-align:center;padding:12px',
        fields: [
          { key: 'id', label: 'Drawing', type: 'list', rows: 8, options: CLIP_ART.map((c) => ({ value: c.id, label: c.label })), value: CLIP_ART[0].id },
          { key: 'size', label: 'Size', type: 'number', value: 48, suffix: 'px', half: true }, { key: 'color', label: 'Color', type: 'color', value: '#1f4e9c', half: true },
          { key: 'label', label: 'Label', type: 'text', value: CLIP_ART[0].label },
        ],
        onChange: (x, ctl, key) => { if (key === 'id') ctl.set('label', CLIP_ART.find((c) => c.id === x.id)?.label || ''); ctl.setPreview(clipArtSvg(x.id, 96, x.color)); },
      });
      if (!v) return;
      insertHtml(app, clipArtSvg(v.id, +v.size || 48, v.color || 'currentColor', v.label ?? undefined));
    },
  },
  {
    id: 'insert.shape', label: 'Shape', icon: 'category', origin: 'FrontPage (Drawing), Office (Shapes)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Shape', preview: true, previewStyle: 'text-align:center;padding:12px',
        fields: [
          { key: 'kind', label: 'Shape', type: 'select', value: 'rounded', options: SHAPES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })) },
          { key: 'width', label: 'Width', type: 'number', value: 160, suffix: 'px', half: true }, { key: 'height', label: 'Height', type: 'number', value: 100, suffix: 'px', half: true },
          { key: 'fill', label: 'Fill', type: 'color', value: '#4c8bf5', half: true }, { key: 'stroke', label: 'Line', type: 'color', value: '#1d2733', half: true },
          { key: 'strokeWidth', label: 'Line width', type: 'range', value: 0, min: 0, max: 12, suffix: 'px' },
          { key: 'label', label: 'Label for screen readers (empty for decorative)', type: 'text', value: '' },
        ],
        onChange: (x, ctl) => ctl.setPreview(shapeSvg({ kind: x.kind, width: +x.width || 160, height: +x.height || 100, fill: x.fill, stroke: x.stroke, strokeWidth: +x.strokeWidth })),
      });
      if (!v) return;
      insertHtml(app, shapeSvg({ kind: v.kind as ShapeKind, width: Math.max(4, +v.width || 160), height: Math.max(4, +v.height || 100), fill: v.fill, stroke: v.stroke, strokeWidth: +v.strokeWidth || 0, label: v.label }));
    },
  },
  {
    id: 'insert.decorativeText', label: 'Decorative Text', icon: 'text_format', origin: 'FrontPage, Office (WordArt)', keywords: 'wordart fancy title',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Decorative Text', help: 'Styled text drawn as SVG. It stays real text for search engines and screen readers.', preview: true, previewStyle: 'text-align:center;padding:12px;overflow:auto',
        fields: [
          { key: 'text', label: 'Text', type: 'text', value: selectionText(app) || 'Your Text', autofocus: true },
          { key: 'effect', label: 'Effect', type: 'select', value: 'gradient', options: [{ value: 'plain', label: 'Plain' }, { value: 'gradient', label: 'Gradient' }, { value: 'outline', label: 'Outline' }, { value: 'shadow', label: 'Shadow' }, { value: 'arc', label: 'Arch' }] },
          { key: 'font', label: 'Font', type: 'combo', value: 'Georgia, serif', options: ['Georgia, serif', 'Impact, sans-serif', 'Arial Black, sans-serif', 'Trebuchet MS, sans-serif', 'Brush Script MT, cursive', 'Courier New, monospace'], half: true },
          { key: 'size', label: 'Size', type: 'number', value: 48, suffix: 'px', half: true },
          { key: 'fill', label: 'Color', type: 'color', value: '#1f4e9c', half: true }, { key: 'fill2', label: 'Second color', type: 'color', value: '#c2185b', half: true },
          { key: 'outline', label: 'Outline color', type: 'color', value: '#000000' },
        ],
        onChange: (x, ctl) => ctl.setPreview(decorativeText({ ...x, size: +x.size || 48 } as any, 'ql-wa-preview')),
        validate: (x) => (x.text?.trim() ? null : 'Type the text.'),
      });
      if (!v) return;
      insertHtml(app, decorativeText({ text: v.text, effect: v.effect as TextEffect, font: v.font, size: +v.size || 48, fill: v.fill, fill2: v.fill2, outline: v.outline }));
    },
  },
  {
    id: 'insert.math', label: 'Math Equation', icon: 'functions', origin: 'BlueGriffon (MathML), Office (Equation)', keywords: 'mathml formula equation',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { expr: arg, display: 'block' } : arg || await openDialog({
        title: 'Math Equation', wide: true, help: 'Type the equation in plain text: x^2 for powers, x_1 for subscripts, a/b for fractions, sqrt(x), root(3, x), Greek letter names (alpha, pi), sum, int, <=, >=, !=. It is inserted as MathML.',
        preview: true, previewStyle: 'padding:12px;font-size:20px',
        fields: [
          { key: 'expr', label: 'Equation', type: 'text', value: selectionText(app) || 'x = (-b +- sqrt(b^2 - 4a c)) / (2a)', autofocus: true },
          { key: 'display', label: 'Show as', type: 'radio', value: 'block', options: [{ value: 'block', label: 'Its own line' }, { value: 'inline', label: 'In the text' }] },
        ],
        onChange: (x, ctl) => ctl.setPreview(mathMarkup(x.expr || '', x.display)),
      });
      if (!v?.expr) return;
      insertHtml(app, mathMarkup(v.expr, v.display === 'inline' ? 'inline' : 'block'));
    },
  },
]));

// ------------------------------------------------------------------------------------------
// Video, sound, embeds

def(cmds('Media', 'Expression Web, Dreamweaver, modern builders', [
  {
    id: 'insert.video', label: 'Video', icon: 'movie', popular: true, origin: 'Expression Web, Dreamweaver (HTML5 Video), KompoZer',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { src: arg, controls: true } : arg || await openDialog({
        title: 'Video', wide: true,
        fields: [
          ...fileFields(app, 'src', 'Video file', { filter: isVideo, accept: 'video/*', dir: 'media' }),
          ...imgFields(app, 'poster', 'Poster picture').map((f) => (f.type === 'combo' ? { ...f, value: '' } : f)),
          ...fileFields(app, 'captions', 'Captions (.vtt)', { filter: (p) => /\.vtt$/i.test(p), accept: '.vtt', dir: 'media', blank: true }),
          { key: 'width', label: 'Width', type: 'number', value: '', suffix: 'px', half: true, placeholder: 'auto' }, { key: 'height', label: 'Height', type: 'number', value: '', suffix: 'px', half: true, placeholder: 'auto' },
          { key: 'controls', label: 'Show playback controls', type: 'checkbox', value: true, half: true },
          { key: 'autoplay', label: 'Play automatically (muted)', type: 'checkbox', value: false, half: true },
          { key: 'loop', label: 'Loop', type: 'checkbox', value: false, half: true }, { key: 'muted', label: 'Start muted', type: 'checkbox', value: false, half: true },
          { key: 'preload', label: 'Preload', type: 'select', value: 'metadata', options: [{ value: 'metadata', label: 'Size and length only' }, { value: 'auto', label: 'Whole video' }, { value: 'none', label: 'Nothing' }] },
        ],
        validate: (x) => (x.src ? null : 'Choose the video.'),
      });
      if (!v) return;
      if (/youtu\.?be|vimeo\.com/i.test(v.src)) { toast('That is a video page address: use YouTube or Vimeo instead.'); return; }
      insertHtml(app, videoMarkup({ ...v, width: +v.width || null, height: +v.height || null }));
    },
  },
  {
    id: 'insert.audio', label: 'Audio', icon: 'music_note', origin: 'Expression Web, Dreamweaver (HTML5 Audio), KompoZer',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { src: arg, controls: true } : arg || await openDialog({
        title: 'Audio',
        fields: [
          ...fileFields(app, 'src', 'Sound file', { filter: isAudio, accept: 'audio/*', dir: 'media' }),
          { key: 'title', label: 'Title (optional)', type: 'text', value: '' },
          { key: 'controls', label: 'Show playback controls', type: 'checkbox', value: true },
          { key: 'autoplay', label: 'Play automatically (most browsers block this)', type: 'checkbox', value: false },
          { key: 'loop', label: 'Loop', type: 'checkbox', value: false },
          { key: 'preload', label: 'Preload', type: 'select', value: 'metadata', options: [{ value: 'metadata', label: 'Length only' }, { value: 'auto', label: 'Whole file' }, { value: 'none', label: 'Nothing' }] },
        ],
        validate: (x) => (x.src ? null : 'Choose the sound file.'),
      });
      if (!v) return;
      if (!v.controls && !v.autoplay) toast('Without controls and autoplay, visitors cannot start the sound.');
      insertHtml(app, audioMarkup(v));
    },
  },
  {
    id: 'insert.youtube', label: 'YouTube Video', icon: 'smart_display', origin: 'Modern builders (Wix, Weebly, Bootstrap Studio)',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { url: arg, title: 'YouTube video', responsive: true } : arg || await openDialog({
        title: 'YouTube Video', help: 'Uses the privacy-enhanced player (youtube-nocookie.com): no cookies are set until the visitor plays the video.',
        fields: [
          { key: 'url', label: 'Video address or id', type: 'text', value: '', placeholder: 'https://www.youtube.com/watch?v=…', autofocus: true },
          { key: 'title', label: 'Title (describes the video for screen readers)', type: 'text', value: '' },
          { key: 'start', label: 'Start at (seconds or m:ss)', type: 'text', value: '', half: true },
          { key: 'responsive', label: 'Fit the width of the page (16:9)', type: 'checkbox', value: true, half: true },
          { key: 'width', label: 'Width', type: 'number', value: 560, suffix: 'px', half: true, visibleIf: (x) => !x.responsive }, { key: 'height', label: 'Height', type: 'number', value: 315, suffix: 'px', half: true, visibleIf: (x) => !x.responsive },
        ],
        validate: (x) => (!parseYouTubeId(x.url || '') ? 'That does not look like a YouTube address.' : !x.title?.trim() ? 'Give the video a title.' : null),
      });
      if (!v) return;
      const id = parseYouTubeId(v.url);
      if (!id) { toast('That does not look like a YouTube address.'); return; }
      insertHtml(app, youtubeEmbed({ id, title: v.title, start: parseStart(v.start || v.url), responsive: v.responsive, width: +v.width, height: +v.height }));
    },
  },
  {
    id: 'insert.vimeo', label: 'Vimeo Video', icon: 'video_library', origin: 'Modern builders (Wix, Weebly, Bootstrap Studio)',
    run: async (app, arg) => {
      const v = typeof arg === 'string' ? { url: arg, title: 'Vimeo video', responsive: true } : arg || await openDialog({
        title: 'Vimeo Video', help: 'The player is embedded with Do Not Track on.',
        fields: [
          { key: 'url', label: 'Video address or id', type: 'text', value: '', placeholder: 'https://vimeo.com/123456789', autofocus: true },
          { key: 'title', label: 'Title (describes the video for screen readers)', type: 'text', value: '' },
          { key: 'responsive', label: 'Fit the width of the page (16:9)', type: 'checkbox', value: true },
          { key: 'width', label: 'Width', type: 'number', value: 640, suffix: 'px', half: true, visibleIf: (x) => !x.responsive }, { key: 'height', label: 'Height', type: 'number', value: 360, suffix: 'px', half: true, visibleIf: (x) => !x.responsive },
        ],
        validate: (x) => (!parseVimeoId(x.url || '') ? 'That does not look like a Vimeo address.' : !x.title?.trim() ? 'Give the video a title.' : null),
      });
      if (!v) return;
      const id = parseVimeoId(v.url);
      if (id) insertHtml(app, vimeoEmbed({ id, title: v.title, responsive: v.responsive, width: +v.width, height: +v.height }));
    },
  },
  {
    id: 'insert.map', label: 'Map', icon: 'map', origin: 'Modern builders (map widget)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Map', help: 'An OpenStreetMap map: no API key and no tracking cookies. Paste an openstreetmap.org address (it contains #map=zoom/latitude/longitude), a map link with @latitude,longitude, or type "latitude, longitude".',
        fields: [
          { key: 'where', label: 'Location', type: 'text', value: '', placeholder: '40.7484, -73.9857', autofocus: true },
          { key: 'zoom', label: 'Zoom (1 = world, 18 = street)', type: 'range', value: 15, min: 2, max: 19 },
          { key: 'width', label: 'Width', type: 'number', value: 600, suffix: 'px', half: true }, { key: 'height', label: 'Height', type: 'number', value: 400, suffix: 'px', half: true },
          { key: 'title', label: 'Title (describes the map)', type: 'text', value: 'Map' },
          { key: 'marker', label: 'Show a marker at the location', type: 'checkbox', value: true },
        ],
        validate: (x) => (parseMapLocation(x.where || '') ? null : 'Type latitude, longitude or paste a map address.'),
      });
      if (!v) return;
      const loc = parseMapLocation(v.where);
      if (!loc) return;
      insertHtml(app, osmEmbed({ ...loc, zoom: loc.zoom ?? (+v.zoom || 15), width: +v.width || 600, height: +v.height || 400, title: v.title, marker: v.marker }));
    },
  },
  {
    id: 'insert.svg', label: 'SVG Drawing', icon: 'draw', origin: 'BlueGriffon, modern editors',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'SVG Drawing', help: 'Inserts an SVG file’s markup into the page (so CSS can style it), or an empty drawing to edit in Code view.',
        fields: [
          { key: 'mode', label: 'Insert', type: 'radio', value: 'file', options: [{ value: 'file', label: 'An SVG file' }, { value: 'blank', label: 'A blank drawing' }] },
          ...fileFields(app, 'src', 'SVG file', { filter: (p) => /\.svg$/i.test(p), accept: '.svg,image/svg+xml', dir: 'images' }).map((f) => ({ ...f, visibleIf: (x: any) => x.mode === 'file' })),
          { key: 'how', label: 'As', type: 'select', value: 'inline', options: [{ value: 'inline', label: 'Inline markup' }, { value: 'img', label: 'A picture (<img>)' }], visibleIf: (x) => x.mode === 'file' },
          { key: 'width', label: 'Width', type: 'number', value: 300, half: true, visibleIf: (x) => x.mode === 'blank' }, { key: 'height', label: 'Height', type: 'number', value: 150, half: true, visibleIf: (x) => x.mode === 'blank' },
          { key: 'title', label: 'Description (for screen readers)', type: 'text', value: '' },
        ],
      });
      if (!v) return;
      if (v.mode === 'blank') { insertHtml(app, svgBlank(+v.width || 300, +v.height || 150, v.title)); return; }
      if (!v.src) return;
      if (v.how === 'img') { insertHtml(app, imageMarkup({ src: v.src, alt: v.title || '' })); return; }
      const p = resolveRef(app.active.path, v.src);
      const text = p ? app.site.read(p) : null;
      if (!text) { toast('Only SVG files in this site can be inserted inline.'); return; }
      insertHtml(app, inlineSvg(text, v.title));
    },
  },
  {
    id: 'insert.canvas', label: 'Canvas', icon: 'brush', origin: 'Dreamweaver (HTML5 Canvas)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Canvas', help: 'A drawing surface for scripts.',
        fields: [{ key: 'id', label: 'Id', type: 'text', value: slugId('canvas', new Set(idsIn(app.active.source))) }, { key: 'width', label: 'Width', type: 'number', value: 300, half: true }, { key: 'height', label: 'Height', type: 'number', value: 150, half: true }, { key: 'fallback', label: 'Text when canvas is not available (describe the drawing)', type: 'text', value: '' }],
      });
      if (v) insertHtml(app, canvasMarkup({ id: v.id || 'canvas', width: +v.width || 300, height: +v.height || 150, fallback: v.fallback }));
    },
  },
]));

// ------------------------------------------------------------------------------------------
// Legacy plug-in objects

def(cmds('Plug-ins', 'Dreamweaver, FrontPage, Expression Web (Media)', [
  {
    id: 'insert.flash', label: 'Flash Movie (Legacy)', icon: 'flash_on', origin: 'Dreamweaver, FrontPage, Expression Web (Flash SWF)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Flash Movie', help: 'Flash Player ended in 2020 and no current browser runs .swf files. The markup is for archives and old pages; Ruffle (a Flash emulator) can play some of them.',
        fields: [...fileFields(app, 'src', 'SWF file', { filter: (p) => /\.swf$/i.test(p), accept: '.swf', dir: 'media' }), { key: 'width', label: 'Width', type: 'number', value: 550, half: true }, { key: 'height', label: 'Height', type: 'number', value: 400, half: true }],
        validate: (x) => (x.src ? null : 'Choose the file.'),
      });
      if (!v) return;
      insertHtml(app, flashMarkup({ src: v.src, width: +v.width || 550, height: +v.height || 400 }));
      legacyWarning('Flash');
    },
  },
  {
    id: 'insert.object', label: 'Object', icon: 'widgets', origin: 'Dreamweaver, Expression Web',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Object', help: 'Embeds a resource such as a PDF or an SVG file. The text inside is shown when it cannot be displayed.',
        fields: [
          ...fileFields(app, 'data', 'File', { filter: () => true, accept: '*/*', dir: 'files' }),
          { key: 'type', label: 'Type', type: 'combo', value: '', options: ['application/pdf', 'image/svg+xml', 'text/html'] },
          { key: 'width', label: 'Width', type: 'text', value: '600', half: true }, { key: 'height', label: 'Height', type: 'text', value: '400', half: true },
          { key: 'fallback', label: 'Text shown when it cannot be displayed', type: 'text', value: 'This content cannot be shown in your browser.' },
          { key: 'params', label: 'Parameters (name=value per line)', type: 'textarea', rows: 3, value: '' },
        ],
        validate: (x) => (x.data ? null : 'Choose the file.'),
      });
      if (!v) return;
      insertHtml(app, objectMarkup({ data: v.data, type: v.type || typeOfRef(v.data) || (extOf(v.data) === 'pdf' ? 'application/pdf' : ''), width: v.width as any, height: v.height as any, fallback: v.fallback, params: parseParams(v.params || '') }));
    },
  },
  {
    id: 'insert.embed', label: 'Embed', icon: 'extension', origin: 'Dreamweaver, Netscape Composer',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Embed', help: 'Embeds a file the browser shows itself (such as a PDF). <embed> has no fallback text; prefer Object or Video/Audio when you can.',
        fields: [...fileFields(app, 'src', 'File', { filter: () => true, accept: '*/*', dir: 'files' }), { key: 'type', label: 'Type', type: 'text', value: '' }, { key: 'width', label: 'Width', type: 'number', value: 600, half: true }, { key: 'height', label: 'Height', type: 'number', value: 400, half: true }],
        validate: (x) => (x.src ? null : 'Choose the file.'),
      });
      if (v) insertHtml(app, embedMarkup({ src: v.src, type: v.type, width: +v.width, height: +v.height }));
    },
  },
  {
    id: 'insert.applet', label: 'Java Applet (Legacy)', icon: 'coffee', origin: 'Dreamweaver, FrontPage (Advanced > Java Applet)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Java Applet', help: 'No current browser runs Java applets. The applet is written the HTML5 way (<object>) for archives and old pages.',
        fields: [
          { key: 'code', label: 'Applet class', type: 'text', value: 'Main.class' },
          { key: 'archive', label: 'Archive (.jar)', type: 'combo', value: '', options: [] },
          { key: 'width', label: 'Width', type: 'number', value: 300, half: true }, { key: 'height', label: 'Height', type: 'number', value: 200, half: true },
          { key: 'params', label: 'Parameters (name=value per line)', type: 'textarea', rows: 3, value: '' },
        ],
      });
      if (!v) return;
      insertHtml(app, appletMarkup({ code: v.code, archive: v.archive, width: +v.width || 300, height: +v.height || 200, params: parseParams(v.params || '') }));
      legacyWarning('A Java applet');
    },
  },
  {
    id: 'insert.activex', label: 'ActiveX Control (Legacy)', icon: 'settings_input_component', origin: 'FrontPage (Advanced > ActiveX Control), Dreamweaver',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'ActiveX Control', help: 'ActiveX controls ran only in old versions of Internet Explorer on Windows.',
        fields: [{ key: 'classid', label: 'Class id', type: 'text', value: 'clsid:', placeholder: 'clsid:D27CDB6E-AE6D-11cf-96B8-444553540000' }, { key: 'width', label: 'Width', type: 'number', value: 300, half: true }, { key: 'height', label: 'Height', type: 'number', value: 200, half: true }, { key: 'params', label: 'Parameters (name=value per line)', type: 'textarea', rows: 3, value: '' }],
      });
      if (!v) return;
      insertHtml(app, activexMarkup({ classid: v.classid, width: +v.width || 300, height: +v.height || 200, params: parseParams(v.params || '') }));
      legacyWarning('An ActiveX control');
    },
  },
  {
    id: 'insert.plugin', label: 'Plug-in (Legacy)', icon: 'power', origin: 'FrontPage (Advanced > Plug-In), Dreamweaver (Plugin)',
    run: async (app, arg) => {
      const v = arg || await openDialog({
        title: 'Plug-in', help: 'Browser plug-ins (NPAPI) are gone from current browsers; the file must be something the browser shows by itself.',
        fields: [...fileFields(app, 'src', 'File', { filter: () => true, accept: '*/*', dir: 'files' }), { key: 'width', label: 'Width', type: 'number', value: 300, half: true }, { key: 'height', label: 'Height', type: 'number', value: 200, half: true }],
        validate: (x) => (x.src ? null : 'Choose the file.'),
      });
      if (!v) return;
      insertHtml(app, embedMarkup({ src: v.src, width: +v.width, height: +v.height }));
      legacyWarning('A browser plug-in');
    },
  },
]));
