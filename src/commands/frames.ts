/**
 * Frames (Frames menus of desktop web editors): frameset pages made of several pages side by side.
 * Framesets are obsolete in HTML5, so every command says so and points at inline frames; the commands
 * still create and maintain them faithfully because old sites use them. Framesets are edited as source
 * text (app.editSource); the frames of a page are only drawn in Preview.
 */
import { def, getCommand } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import { closestSel, isPage, mutate, view } from '../editor/ops';
import { blankPage, esc, escAttr, headInsert, DOCTYPES } from '../model/html';
import { dirOf, joinPath, relativeRef, resolveRef, isPagePath, stripExt, baseName, isExternal } from '../model/paths';

export const FRAMES_NOTE = 'Frames are obsolete in HTML5: pages inside frames are hard to bookmark, link to, print, index in search engines and use with screen readers. For new sites, use an inline frame (Insert > Inline Frame) for embedded content, or a shared layout (templates, includes, CSS) for navigation.';

// ------------------------------------------------------------------------------------------
// Layouts

export interface FrameNode { frame?: string; title?: string; cols?: string; rows?: string; children?: FrameNode[] }

export const LAYOUTS: { id: string; label: string; tree: FrameNode }[] = [
  { id: 'contents', label: 'Contents on the left', tree: { cols: '200,*', children: [{ frame: 'contents', title: 'Contents' }, { frame: 'main', title: 'Main content' }] } },
  { id: 'contentsRight', label: 'Contents on the right', tree: { cols: '*,200', children: [{ frame: 'main', title: 'Main content' }, { frame: 'contents', title: 'Contents' }] } },
  { id: 'banner', label: 'Top banner', tree: { rows: '100,*', children: [{ frame: 'banner', title: 'Banner' }, { frame: 'main', title: 'Main content' }] } },
  { id: 'bannerContents', label: 'Banner and contents', tree: { rows: '100,*', children: [{ frame: 'banner', title: 'Banner' }, { cols: '200,*', children: [{ frame: 'contents', title: 'Contents' }, { frame: 'main', title: 'Main content' }] }] } },
  { id: 'headerFooter', label: 'Header and footer', tree: { rows: '80,*,60', children: [{ frame: 'header', title: 'Header' }, { frame: 'main', title: 'Main content' }, { frame: 'footer', title: 'Footer' }] } },
  { id: 'headerFooterContents', label: 'Header, footer and contents', tree: { rows: '80,*,60', children: [{ frame: 'header', title: 'Header' }, { cols: '200,*', children: [{ frame: 'contents', title: 'Contents' }, { frame: 'main', title: 'Main content' }] }, { frame: 'footer', title: 'Footer' }] } },
  { id: 'twoColumns', label: 'Two columns', tree: { cols: '50%,50%', children: [{ frame: 'left', title: 'Left' }, { frame: 'right', title: 'Right' }] } },
  { id: 'threeColumns', label: 'Three columns', tree: { cols: '*,*,*', children: [{ frame: 'left', title: 'Left' }, { frame: 'middle', title: 'Middle' }, { frame: 'right', title: 'Right' }] } },
  { id: 'twoRows', label: 'Two rows (top and bottom)', tree: { rows: '50%,50%', children: [{ frame: 'top', title: 'Top' }, { frame: 'bottom', title: 'Bottom' }] } },
  { id: 'threeRows', label: 'Three rows', tree: { rows: '*,*,*', children: [{ frame: 'top', title: 'Top' }, { frame: 'middle', title: 'Middle' }, { frame: 'bottom', title: 'Bottom' }] } },
];

function frameNames(n: FrameNode): { name: string; title: string }[] {
  return n.frame ? [{ name: n.frame, title: n.title || n.frame }] : (n.children || []).flatMap(frameNames);
}

const attrs = (el: Element) => [...el.attributes].map((a) => ` ${a.name}${a.value === '' && /^(noresize)$/i.test(a.name) ? '' : `="${escAttr(a.value)}"`}`).join('');

/** Source text of a frameset element tree, indented. */
export function serializeFrameset(el: Element, depth = 0): string {
  const ind = '  '.repeat(depth);
  const tag = el.tagName.toLowerCase();
  if (tag === 'frame') return `${ind}<frame${attrs(el)}>`;
  if (tag === 'noframes') return `${ind}<noframes>${el.textContent || ''}</noframes>`;
  if (tag !== 'frameset') return `${ind}${el.outerHTML}`;
  const kids = [...el.children].map((c) => serializeFrameset(c, depth + 1));
  return `${ind}<frameset${attrs(el)}>\n${kids.join('\n')}\n${ind}</frameset>`;
}

/** The outermost frameset of a page's source, parsed, with its text range. */
export function parseFrameset(src: string): { doc: Document; root: Element; start: number; end: number } | null {
  const start = src.search(/<frameset\b/i);
  if (start < 0) return null;
  const closes = [...src.matchAll(/<\/frameset\s*>/gi)];
  const last = closes[closes.length - 1];
  const end = last ? last.index! + last[0].length : src.length;
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><head></head>${src.slice(start, end)}</html>`, 'text/html');
  const root = doc.querySelector('frameset');
  return root ? { doc, root, start, end } : null;
}

function writeFrameset(src: string, p: { root: Element; start: number; end: number }): string {
  return src.slice(0, p.start) + serializeFrameset(p.root) + src.slice(p.end);
}

function dirAttr(fs: Element): 'cols' | 'rows' { return fs.hasAttribute('cols') ? 'cols' : 'rows'; }
function sizesOf(fs: Element): string[] { const d = fs.getAttribute(dirAttr(fs)); return d ? d.split(',').map((s) => s.trim()) : []; }
function setSizes(fs: Element, sizes: string[]): void { fs.setAttribute(dirAttr(fs), sizes.join(',')); }
const kidIndex = (el: Element) => [...el.parentElement!.children].filter((c) => /^(FRAME|FRAMESET)$/.test(c.tagName)).indexOf(el);
const frameKids = (fs: Element) => [...fs.children].filter((c) => /^(FRAME|FRAMESET)$/.test(c.tagName));

/** Halves a frame size: "200" → ["100","100"], "40%" → ["20%","20%"], "*" → ["*","*"]. */
export function splitSize(s: string): [string, string] {
  const px = /^(\d+)$/.exec(s);
  if (px) { const a = Math.floor(+px[1] / 2); return [String(a), String(+px[1] - a)]; }
  const pc = /^(\d+(?:\.\d+)?)%$/.exec(s);
  if (pc) { const a = +pc[1] / 2; return [`${+a.toFixed(2)}%`, `${+a.toFixed(2)}%`]; }
  return [s || '*', s || '*'];
}

function frameTreeMarkup(n: FrameNode, srcOf: (name: string) => string, depth = 1): string {
  const ind = '  '.repeat(depth);
  if (n.frame) return `${ind}<frame src="${escAttr(srcOf(n.frame))}" name="${escAttr(n.frame)}" title="${escAttr(n.title || n.frame)}">`;
  const a = n.cols ? ` cols="${n.cols}"` : ` rows="${n.rows}"`;
  return `${ind}<frameset${a}>\n${(n.children || []).map((c) => frameTreeMarkup(c, srcOf, depth + 1)).join('\n')}\n${ind}</frameset>`;
}

/** The whole frameset page (pure; exported for tests). */
export function framesetPage(title: string, tree: FrameNode, srcOf: (name: string) => string, mainHref: string): string {
  const dt = DOCTYPES.find((d) => d.id === 'html401f')!.decl;
  const inner = frameTreeMarkup(tree, srcOf, 0).replace(/\n\s*<\/frameset>$/, '');
  return `${dt}
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
</head>
${inner}
  <noframes>
  <body>
  <p>This page uses frames, which your browser does not show. <a href="${escAttr(mainHref)}">Open the main page</a>.</p>
  </body>
  </noframes>
</frameset>
</html>
`;
}

// ------------------------------------------------------------------------------------------
// Commands

function framesetOrToast(app: App): ReturnType<typeof parseFrameset> {
  if (!isPage(app)) { toast('Open a page first.'); return null; }
  app.active.ui.flush();
  const p = parseFrameset(app.active.source);
  if (!p) toast('This page is not a frames page. New Frames Page creates one; Insert > Inline Frame embeds a page in an ordinary page.');
  return p;
}

const frameLabel = (f: Element, i: number) => `${f.getAttribute('name') || `Frame ${i + 1}`} – ${f.getAttribute('src') || '(no page)'}`;

function pagesOptions(app: App): string[] {
  return app.site.pages().map((f) => relativeRef(app.active.path, f.path));
}

async function chooseFrame(app: App, title: string, p: NonNullable<ReturnType<typeof parseFrameset>>, arg: any, extra: Field[] = [], help?: string): Promise<{ frame: Element; values: Record<string, any> } | null> {
  const frames = [...p.root.querySelectorAll('frame')];
  if (!frames.length) { toast('The frameset has no frames.'); return null; }
  if (arg && typeof arg === 'object' && (arg.frame != null)) {
    const f = typeof arg.frame === 'number' ? frames[arg.frame] : frames.find((x) => x.getAttribute('name') === arg.frame);
    return f ? { frame: f, values: arg } : null;
  }
  const v = await openDialog({ title, help, fields: [{ key: 'frame', label: 'Frame', type: 'select', value: '0', options: frames.map((f, i) => ({ value: String(i), label: frameLabel(f, i) })) }, ...extra] });
  if (!v) return null;
  return { frame: frames[+v.frame], values: v };
}

async function newFrameset(app: App, arg?: any): Promise<void> {
  const dir = app.active ? dirOf(app.active.path) : '';
  const fields: Field[] = [
    { key: 'note', type: 'info', label: FRAMES_NOTE },
    { key: 'layout', label: 'Layout', type: 'list', rows: 8, value: 'contents', options: LAYOUTS.map((l) => ({ value: l.id, label: l.label })) },
    { key: 'file', label: 'Frames page file name', type: 'text', value: baseName(app.site.freeName(dir, 'frames', 'html')), half: true },
    { key: 'title', label: 'Page title', type: 'text', value: app.site.name || 'Frames', half: true },
    { key: 'prefix', label: 'Name prefix for new frame pages', type: 'text', value: '', placeholder: '(none)', half: true },
    { key: 'pages', type: 'info', label: '' },
  ];
  const v = arg && typeof arg === 'object' ? { layout: 'contents', file: 'frames.html', title: 'Frames', prefix: '', ...arg } : await openDialog({
    title: 'New Frames Page', wide: true, fields,
    onChange: (x, ctl) => {
      const l = LAYOUTS.find((y) => y.id === x.layout) || LAYOUTS[0];
      const info = ctl.body.querySelectorAll('.ql-info')[1] as HTMLElement | undefined;
      if (info) info.textContent = `Frames: ${frameNames(l.tree).map((f) => `${f.title} (${x.prefix || ''}${f.name}.html)`).join(', ')}. Existing pages with those names are used as they are; missing ones are created.`;
    },
    validate: (x) => (!String(x.file || '').trim() ? 'Type a file name for the frames page.' : !isPagePath(String(x.file).trim()) && /\./.test(String(x.file)) ? 'The frames page needs a page extension such as .html.' : null),
  });
  if (!v) return;
  const layout = LAYOUTS.find((l) => l.id === v.layout) || LAYOUTS[0];
  let file = String(v.file).trim();
  if (!/\.\w+$/.test(file)) file += '.html';
  const path = joinPath(dir, file);
  if (app.site.has(path) && !(await confirmDialog('New Frames Page', `${path} already exists. Replace it?`, 'Replace'))) return;
  const names = frameNames(layout.tree);
  const childPath = (n: string) => joinPath(dir, `${v.prefix || ''}${n}.html`);
  const mainName = names.find((n) => n.name === 'main')?.name || names[names.length - 1].name;
  const created: string[] = [];
  for (const n of names) {
    const cp = childPath(n.name);
    if (app.site.has(cp)) continue;
    let body: string;
    if (n.name === 'contents') {
      const links = names.filter((x) => x.name !== 'contents').map((x) => `  <li><a href="${escAttr(relativeRef(cp, childPath(x.name)))}">${esc(x.title)}</a></li>`).join('\n');
      body = `<nav aria-label="Contents">\n<h2>Contents</h2>\n<ul>\n${links}\n</ul>\n</nav>`;
    } else if (n.name === 'banner' || n.name === 'header') body = `<header>\n<h1>${esc(v.title || 'My Web Site')}</h1>\n</header>`;
    else if (n.name === 'footer') body = `<footer>\n<p><small>&copy; ${new Date().getFullYear()} ${esc(v.title || '')}</small></p>\n</footer>`;
    else body = `<main>\n<h1>${esc(n.title)}</h1>\n<p>This page appears in the ${esc(n.title.toLowerCase())} frame.</p>\n</main>`;
    let page = blankPage({ title: `${v.title || 'Frames'} – ${n.title}`, body });
    if (n.name === 'contents' && names.some((x) => x.name === mainName && x.name !== 'contents')) page = headInsert(page, `<base target="${mainName}">`);
    app.site.write(cp, page);
    created.push(cp);
  }
  const html = framesetPage(v.title || 'Frames', layout.tree, (n) => relativeRef(path, childPath(n)), relativeRef(path, childPath(mainName)));
  app.site.write(path, html);
  app.openFile(path, { view: 'code' });
  toast(`Created ${path}${created.length ? ` and ${created.length} frame page(s)` : ''}. Preview shows the frames; Open Frame Page edits one. Frames are obsolete: consider inline frames for new work.`, { ms: 8000 });
}

async function splitFrame(app: App, arg?: any): Promise<void> {
  const p = framesetOrToast(app);
  if (!p) return;
  const r = await chooseFrame(app, 'Split Frame', p, arg, [
    { key: 'dir', label: 'Split into', type: 'radio', value: 'cols', options: [{ value: 'cols', label: 'Columns (side by side)' }, { value: 'rows', label: 'Rows (one above the other)' }] },
    { key: 'name', label: 'New frame name', type: 'text', value: '' },
    { key: 'page', label: 'Page for the new frame', type: 'combo', value: '', options: pagesOptions(app), placeholder: '(a new page is created)' },
  ], FRAMES_NOTE);
  if (!r) return;
  const { frame, values: v } = r;
  const taken = new Set([...p.root.querySelectorAll('frame')].map((f) => f.getAttribute('name') || ''));
  let name = String(v.name || '').trim();
  if (!name) for (let i = 1; ; i++) if (!taken.has(`frame${i}`)) { name = `frame${i}`; break; }
  let ref = String(v.page || '').trim();
  const pageDir = dirOf(app.active.path);
  if (!ref) {
    const np = app.site.freeName(pageDir, name, 'html');
    app.site.write(np, blankPage({ title: name, body: `<main>\n<h1>${esc(name)}</h1>\n<p>This page appears in the ${esc(name)} frame.</p>\n</main>` }));
    ref = relativeRef(app.active.path, np);
  } else {
    const rp = resolveRef(app.active.path, ref);
    if (rp && !app.site.has(rp) && isPagePath(rp)) app.site.write(rp, blankPage({ title: name, body: `<h1>${esc(name)}</h1>` }));
  }
  const doc = p.doc;
  const nf = doc.createElement('frame');
  nf.setAttribute('src', ref);
  nf.setAttribute('name', name);
  nf.setAttribute('title', name);
  const parent = frame.parentElement!;
  const dir = v.dir === 'rows' ? 'rows' : 'cols';
  if (parent.tagName === 'FRAMESET' && parent.hasAttribute(dir) && !parent.hasAttribute(dir === 'cols' ? 'rows' : 'cols')) {
    const sizes = sizesOf(parent);
    const i = kidIndex(frame);
    const [a, b] = splitSize(sizes[i] || '*');
    sizes.splice(i, 1, a, b);
    frame.after(nf);
    setSizes(parent, sizes);
  } else {
    const fs = doc.createElement('frameset');
    fs.setAttribute(dir, '50%,50%');
    frame.replaceWith(fs);
    fs.append(frame, nf);
  }
  app.editSource('Split Frame', (src) => writeFrameset(src, p));
}

async function deleteFrame(app: App, arg?: any): Promise<void> {
  const p = framesetOrToast(app);
  if (!p) return;
  if (p.root.querySelectorAll('frame').length < 2) { toast('A frames page needs at least one frame. To remove frames altogether, open the main page instead.'); return; }
  const r = await chooseFrame(app, 'Delete Frame', p, arg, [{ key: 'info', type: 'info', label: 'The frame is removed from the frames page; the page it showed stays in the site.' }]);
  if (!r) return;
  const { frame } = r;
  const parent = frame.parentElement!;
  const sizes = sizesOf(parent);
  sizes.splice(kidIndex(frame), 1);
  frame.remove();
  setSizes(parent, sizes.length ? sizes : ['*']);
  // A frameset left with one child gives way to that child.
  let fs: Element | null = parent;
  while (fs && fs.tagName === 'FRAMESET' && frameKids(fs).length === 1) {
    const only = frameKids(fs)[0];
    if (fs === p.root) {
      if (only.tagName === 'FRAMESET') {
        for (const a of [...fs.attributes]) fs.removeAttribute(a.name);
        for (const a of [...only.attributes]) fs.setAttribute(a.name, a.value);
        only.replaceWith(...only.childNodes);
      } else setSizes(fs, ['*']);
      break;
    }
    const up: Element | null = fs.parentElement;
    fs.replaceWith(only);
    fs = up;
  }
  app.editSource('Delete Frame', (src) => writeFrameset(src, p));
}

function framePath(app: App, frame: Element): string | null {
  const src = frame.getAttribute('src') || '';
  return src ? resolveRef(app.active.path, src) : null;
}

async function openFramePage(app: App, arg?: any): Promise<void> {
  const p = framesetOrToast(app);
  if (!p) return;
  const r = await chooseFrame(app, 'Open Frame Page', p, arg);
  if (!r) return;
  const src = r.frame.getAttribute('src') || '';
  if (src && isExternal(src)) { app.followLink(src); return; }
  const fp = framePath(app, r.frame);
  if (!fp) { toast('This frame shows no page yet; Frame Properties sets one.'); return; }
  if (!app.site.has(fp)) {
    if (!(await confirmDialog('Open Frame Page', `${fp} is not in the site. Create it?`, 'Create'))) return;
    app.site.write(fp, blankPage({ title: r.frame.getAttribute('title') || stripExt(baseName(fp)) }));
  }
  app.openFile(fp);
}

async function saveFramePage(app: App, arg?: any): Promise<void> {
  const p = framesetOrToast(app);
  if (!p) return;
  const r = await chooseFrame(app, 'Save Frame Page', p, arg, [], 'Saves the page shown in a frame (creating it when it does not exist yet).');
  if (!r) return;
  const fp = framePath(app, r.frame);
  if (!fp || isExternal(r.frame.getAttribute('src') || '')) { toast('This frame does not show a page of this site.'); return; }
  if (!app.site.has(fp)) app.site.write(fp, blankPage({ title: r.frame.getAttribute('title') || stripExt(baseName(fp)) }));
  const tab = app.docs.find((d) => d.path === fp);
  if (tab) { tab.ui.flush(); app.activate(tab); }
  else app.openFile(fp);
  if (getCommand('file.save')) app.exec('file.save');
  else toast(`${fp} is saved in the site; save the site to write it to disk.`);
}

async function saveFramePageAs(app: App, arg?: any): Promise<void> {
  const p = framesetOrToast(app);
  if (!p) return;
  const r = await chooseFrame(app, 'Save Frame Page As', p, arg && typeof arg === 'object' ? arg : undefined);
  if (!r) return;
  const old = framePath(app, r.frame);
  const suggestion = old ? baseName(app.site.freeName(dirOf(old), stripExt(baseName(old)), 'html')) : 'frame.html';
  let name = (arg && typeof arg === 'object' && arg.file) || (await promptDialog('Save Frame Page As', 'New file name (the frame then shows the copy)', suggestion));
  if (!name) return;
  name = String(name).trim();
  if (!/\.\w+$/.test(name)) name += '.html';
  const np = joinPath(old ? dirOf(old) : dirOf(app.active.path), name);
  if (app.site.has(np) && !(await confirmDialog('Save Frame Page As', `${np} exists. Replace it?`, 'Replace'))) return;
  const tab = old ? app.docs.find((d) => d.path === old) : undefined;
  tab?.ui.flush();
  const text = old && app.site.has(old) ? app.site.read(old)! : blankPage({ title: r.frame.getAttribute('title') || stripExt(name) });
  app.site.write(np, text);
  r.frame.setAttribute('src', relativeRef(app.active.path, np));
  app.editSource('Save Frame Page As', (src) => writeFrameset(src, p));
  toast(`Saved ${np}; the frame now shows it.`);
}

async function iframeProperties(app: App, el: HTMLElement): Promise<void> {
  const a = (n: string) => el.getAttribute(`data-ql-o-${n}`) ?? el.getAttribute(n) ?? '';
  const v = await openDialog({ title: 'Inline Frame Properties', wide: true, fields: [
    { key: 'src', label: 'Page', type: 'combo', value: a('src'), options: pagesOptions(app) },
    { key: 'title', label: 'Title (describes the frame to screen reader users)', type: 'text', value: a('title') },
    { key: 'name', label: 'Name (for link targets)', type: 'text', value: a('name'), half: true },
    { key: 'loading', label: 'Loading', type: 'select', value: a('loading'), options: [{ value: '', label: 'Default' }, { value: 'lazy', label: 'Lazy (when scrolled near)' }, { value: 'eager', label: 'Eager' }], half: true },
    { key: 'width', label: 'Width', type: 'text', value: a('width'), half: true },
    { key: 'height', label: 'Height', type: 'text', value: a('height'), half: true },
    { key: 'sandbox', label: 'Sandbox (restrictions; empty value = all)', type: 'combo', value: el.hasAttribute('sandbox') ? a('sandbox') || '(all)' : '', options: ['', '(all)', 'allow-scripts', 'allow-scripts allow-same-origin', 'allow-forms allow-scripts', 'allow-popups allow-scripts'] },
    { key: 'allow', label: 'Permissions (allow)', type: 'combo', value: a('allow'), options: ['fullscreen', 'autoplay; encrypted-media; picture-in-picture', 'geolocation'], half: true },
    { key: 'referrerpolicy', label: 'Referrer policy', type: 'select', value: a('referrerpolicy'), options: ['', 'no-referrer', 'origin', 'strict-origin-when-cross-origin', 'same-origin'], half: true },
    { key: 'allowfullscreen', label: 'Allow full screen', type: 'checkbox', value: el.hasAttribute('allowfullscreen') },
  ], validate: (x) => (!String(x.title || '').trim() ? 'Give the frame a title: screen readers announce it.' : null) });
  if (!v) return;
  mutate(app, () => {
    for (const k of ['src', 'title', 'name', 'loading', 'width', 'height', 'allow', 'referrerpolicy']) {
      const val = String(v[k] ?? '').trim();
      el.removeAttribute(`data-ql-o-${k}`);
      if (val) el.setAttribute(k, val); else el.removeAttribute(k);
    }
    const sb = String(v.sandbox ?? '').trim();
    if (!sb) el.removeAttribute('sandbox'); else el.setAttribute('sandbox', sb === '(all)' ? '' : sb);
    if (v.allowfullscreen) el.setAttribute('allowfullscreen', ''); else el.removeAttribute('allowfullscreen');
  });
}

async function frameProperties(app: App, arg?: any): Promise<void> {
  if (!isPage(app)) { toast('Open a page first.'); return; }
  const ifr = view(app)?.target === 'design' ? closestSel(app, 'iframe') : null;
  if (ifr) return iframeProperties(app, ifr);
  const p = framesetOrToast(app);
  if (!p) return;
  const frames = [...p.root.querySelectorAll('frame')];
  if (!frames.length) { toast('The frameset has no frames.'); return; }
  const valuesOf = (f: Element) => ({
    name: f.getAttribute('name') || '', src: f.getAttribute('src') || '', title: f.getAttribute('title') || '', scrolling: (f.getAttribute('scrolling') || 'auto').toLowerCase(),
    noresize: f.hasAttribute('noresize'), frameborder: f.getAttribute('frameborder') ?? '', marginwidth: f.getAttribute('marginwidth') || '', marginheight: f.getAttribute('marginheight') || '',
    size: sizesOf(f.parentElement!)[kidIndex(f)] || '*', sizeDir: dirAttr(f.parentElement!) === 'cols' ? 'Width' : 'Height',
  });
  const first = valuesOf(frames[0]);
  let v: Record<string, any> | null;
  if (arg && typeof arg === 'object') v = { frame: '0', ...first, ...arg };
  else v = await openDialog({
    title: 'Frame Properties', wide: true, help: FRAMES_NOTE,
    fields: [
      { key: 'frame', label: 'Frame', type: 'select', value: '0', options: frames.map((f, i) => ({ value: String(i), label: frameLabel(f, i) })) },
      { key: 'name', label: 'Name (links target it with target="name")', type: 'text', value: first.name, half: true },
      { key: 'title', label: 'Title (for screen readers)', type: 'text', value: first.title, half: true },
      { key: 'src', label: 'Initial page', type: 'combo', value: first.src, options: pagesOptions(app) },
      { key: 'size', label: `${first.sizeDir} (pixels, percent, or * for the rest)`, type: 'text', value: first.size, half: true },
      { key: 'scrolling', label: 'Scroll bars', type: 'select', value: first.scrolling, options: [{ value: 'auto', label: 'If needed' }, { value: 'yes', label: 'Always' }, { value: 'no', label: 'Never' }], half: true },
      { key: 'marginwidth', label: 'Margin width', type: 'text', value: first.marginwidth, half: true },
      { key: 'marginheight', label: 'Margin height', type: 'text', value: first.marginheight, half: true },
      { key: 'frameborder', label: 'Border', type: 'select', value: first.frameborder, options: [{ value: '', label: 'Default' }, { value: '1', label: 'Show' }, { value: '0', label: 'Hide' }], half: true },
      { key: 'noresize', label: 'Visitors cannot resize the frame', type: 'checkbox', value: first.noresize, half: true },
    ],
    onChange: (x, ctl, key) => {
      if (key !== 'frame') return;
      const f = frames[+x.frame];
      if (!f) return;
      const nv = valuesOf(f);
      for (const k of ['name', 'title', 'src', 'size', 'scrolling', 'marginwidth', 'marginheight', 'frameborder', 'noresize'] as const) ctl.set(k, nv[k]);
    },
    validate: (x) => (!/^(\d+%?|\d*\*|\d+(\.\d+)?%)$/.test(String(x.size || '').trim()) ? 'Type a size such as 200, 25% or *.' : null),
  });
  if (!v) return;
  const f = frames[+v.frame] || frames[0];
  const set = (n: string, val: any) => { const s = String(val ?? '').trim(); if (s) f.setAttribute(n, s); else f.removeAttribute(n); };
  set('name', v.name); set('title', v.title); set('src', v.src); set('marginwidth', v.marginwidth); set('marginheight', v.marginheight); set('frameborder', v.frameborder);
  set('scrolling', v.scrolling === 'auto' ? '' : v.scrolling);
  if (v.noresize) f.setAttribute('noresize', ''); else f.removeAttribute('noresize');
  const parent = f.parentElement!;
  const sizes = sizesOf(parent);
  sizes[kidIndex(f)] = String(v.size || '*').trim();
  setSizes(parent, sizes);
  const rp = v.src ? resolveRef(app.active.path, String(v.src)) : null;
  if (rp && !app.site.has(rp) && isPagePath(rp) && (await confirmDialog('Frame Properties', `${rp} is not in the site yet. Create it?`, 'Create', 'Leave It'))) app.site.write(rp, blankPage({ title: v.title || v.name || 'Frame' }));
  app.editSource('Frame Properties', (src) => writeFrameset(src, p));
}

async function noFrames(app: App, arg?: any): Promise<void> {
  const p = framesetOrToast(app);
  if (!p) return;
  let nf = p.root.querySelector(':scope > noframes');
  const cur = nf?.textContent ?? '\n  <body>\n  <p>This page uses frames, which your browser does not show.</p>\n  </body>\n  ';
  const text = typeof arg === 'string' ? arg : await (async () => {
    const r = await openDialog({ title: 'No Frames Content', wide: true, help: 'Shown by browsers and tools that do not display frames (and read by some search engines). Link to the main page so that everyone can reach the content.', fields: [{ key: 'html', label: 'HTML', type: 'textarea', rows: 12, value: cur }] });
    return r ? (r.html as string) : null;
  })();
  if (text == null) return;
  if (!nf) { nf = p.doc.createElement('noframes'); p.root.appendChild(nf); }
  nf.textContent = /^\s*$/.test(text) ? '\n  <body>\n  </body>\n  ' : text;
  app.editSource('No Frames Content', (src) => writeFrameset(src, p));
}

const ORIGIN = 'FrontPage, Dreamweaver';

def([
  { id: 'frame.newFrameset', label: 'New Frames Page', icon: 'view_quilt', tab: 'Layout', group: 'Frames', edits: true, origin: ORIGIN, isEnabled: (app) => !!app.site,
    keywords: 'frameset frames page template banner contents', tip: 'Create a frames page and its frame pages (frames are obsolete; prefer inline frames).', run: (app, arg) => newFrameset(app, arg) },
  { id: 'frame.split', label: 'Split Frame', icon: 'vertical_split', tab: 'Layout', group: 'Frames', edits: true, origin: ORIGIN, isEnabled: isPage, tip: 'Divide a frame into two.', run: (app, arg) => splitFrame(app, arg) },
  { id: 'frame.delete', label: 'Delete Frame', icon: 'delete', tab: 'Layout', group: 'Frames', edits: true, origin: ORIGIN, isEnabled: isPage, tip: 'Remove a frame from the frames page.', run: (app, arg) => deleteFrame(app, arg) },
  { id: 'frame.openInNewWindow', label: 'Open Frame Page', icon: 'open_in_new', tab: 'Layout', group: 'Frames', noRecord: true, origin: 'FrontPage (Open Page in New Window)', isEnabled: isPage, tip: 'Open the page shown in a frame in its own tab.', run: (app, arg) => openFramePage(app, arg) },
  { id: 'frame.savePage', label: 'Save Frame Page', icon: 'save', tab: 'Layout', group: 'Frames', edits: true, origin: ORIGIN, isEnabled: isPage, tip: 'Save the page shown in a frame.', run: (app, arg) => saveFramePage(app, arg) },
  { id: 'frame.savePageAs', label: 'Save Frame Page As', icon: 'save_as', tab: 'Layout', group: 'Frames', edits: true, origin: ORIGIN, isEnabled: isPage, tip: 'Save a frame\'s page under a new name and show the copy in the frame.', run: (app, arg) => saveFramePageAs(app, arg) },
  { id: 'frame.properties', label: 'Frame Properties', icon: 'tune', tab: 'Layout', group: 'Frames', edits: true, origin: ORIGIN, isEnabled: isPage,
    keywords: 'frame iframe name src scrolling resize size', tip: 'Name, page, size and scrolling of a frame, or the selected inline frame.', run: (app, arg) => frameProperties(app, arg) },
  { id: 'frame.noFrames', label: 'No Frames Content', icon: 'web_asset_off', tab: 'Layout', group: 'Frames', edits: true, origin: ORIGIN, isEnabled: isPage, tip: 'Edit what browsers without frames show.', run: (app, arg) => noFrames(app, arg) },
]);
