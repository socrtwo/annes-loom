/**
 * AI tab: setup, providers, several AIs, and the web-site features (generate a page, a site, a section;
 * build from a sketch; write and rewrite copy keeping its markup; fix, explain, refactor and convert code;
 * SEO, meta tags, structured data, alt text, accessibility; legal and error pages; the assistant pane and
 * the prompt library). Only the text a command needs is sent, every change is previewed in an editable
 * dialog, and it applies as one undoable step.
 */
import { def, type MenuEntry } from './registry';
import type { App, PageTab } from '../app';
import { aiSettings, saveAiSettings, resolveProvider, type SavedPrompt } from '../ai/store';
import { providerById } from '../ai/providers';
import { chat, activeEnsemble, type ChatMessage, type ContentPart } from '../ai/client';
import { outcomeLine, type EnsembleMode } from '../ai/ensemble';
import {
  WEB_SYSTEM, TEXT_TASKS, CODE_TASKS, ANALYSIS_TASKS, SECTION_KINDS, FRAMEWORKS, SCHEMA_TYPES, LANGUAGES, RTL_LANGS, SHELL_CSS,
  stripFences, cleanText, linesOf, parseJsonLoose, extractPage, extractFragment, extractSvg, findDocument, stripActive, unbalancedTags,
  parseSitePlan, sitePageShell, setAlternateLinks, langCode, structureOutline, lineDiff, foldDiff, diffStats, proseToHtml, codeLang, capCode, pageTextFor,
  pagePrompt, sitePlanPrompt, sitePagePrompt, sectionPrompt, sketchPrompt, cloneLayoutPrompt, svgPrompt, placeholderPrompt, seoPrompt, metaTagsPrompt,
  schemaPrompt, altTextPrompt, headlinePrompt, ctaPrompt, writeCopyPrompt, faqPrompt, blogPostPrompt, productCopyPrompt, legalPrompt, errorPagePrompt,
  cssPrompt, jsPrompt, translatePagePrompt, codeBlocks, normLang, type SitePlan, type PlanPage,
} from '../ai/web';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { h, pickFile, readFileAsDataURL, debounce } from '../ui/dom';
import { view, isPage, isText, insertHtml, mutate, selectedEl, closestSel, selectionHtml, selectionText, outerSource, replaceElement } from '../editor/ops';
import { Site, rewriteRefs, b64, newId } from '../model/site';
import { getTitle, setTitle, getMeta, setMeta, getLang, setHtmlAttr, headInsert, editHeadStyle, linkedStyles, inlineStyles, addStylesheet, addScript, replaceBody, blankPage, escAttr, esc } from '../model/html';
import { resolveRef, relativeRef, joinPath, dirOf, baseName, stripExt, slugify, normalizePath, isPagePath, mimeOf, extOf } from '../model/paths';
import { applyTemplate, detachTemplate, attachedTemplate } from '../site/templates';
import { desktopHttp } from '../platform/native';
import { postToAssistant } from '../ui/panesAi';

// ------------------------------------------------------------------------------------------
// Readiness, privacy, requests

const cloudId = (id: string) => { const p = providerById(id); return !!p && p.kind !== 'local' && p.kind !== 'builtin'; };
function aiRecipients(): string[] {
  const plan = activeEnsemble();
  if (!plan) { const a = aiSettings().active; return a ? [a] : []; }
  return [...new Set([...plan.members.map((m) => m.provider), plan.master.provider])];
}
const names = (ids: string[]) => { const n = ids.map((id) => providerById(id)?.name || id); return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`; };

export async function ensureAiReady(app: App, reason = 'This command needs an AI provider. Choose one below; free options, including one that runs on this device, are at the top.'): Promise<boolean> {
  const s = aiSettings();
  if (!s.enabled) { toast('AI features are turned off (AI ▸ AI Settings).', { action: 'Settings', onAction: () => app.exec('ai.settings') }); return false; }
  if (!(s.active && (await resolveProvider()))) {
    const { openAiSetup } = await import('../ui/aiWizard');
    if (!(await openAiSetup(app, { reason }))) return false;
  }
  const ids = aiRecipients().filter((id) => cloudId(id) && !aiSettings().privacyAck.includes(id));
  if (!ids.length) return true;
  const free = ids.some((id) => providerById(id)?.free === 'free');
  const ok = await confirmDialog('Sending Page Text and Code to an AI Service', `AI commands send only the page text and code they need (the selection, the page, or for site-wide commands the pages involved) directly from this device to ${names(ids)}. Anne\'s Loom has no server and keeps no copy. The service's terms and privacy policy apply${free ? ', and free tiers may use what you send to improve their models' : ''}. For confidential or unpublished sites, use the on-device model. Continue?`, 'Continue', 'Cancel');
  if (ok) saveAiSettings((x) => { for (const id of ids) if (!x.privacyAck.includes(id)) x.privacyAck.push(id); });
  return ok;
}

/** For commands that send many pages: one more confirmation when the setting asks for it and a cloud AI is used. */
async function confirmWhole(what: string): Promise<boolean> {
  if (!aiSettings().confirmDocument || !aiRecipients().some(cloudId)) return true;
  return confirmDialog('Send Several Pages?', `${what} will be sent to ${names(aiRecipients().filter(cloudId))}. Continue?`, 'Continue', 'Cancel');
}

let controller: AbortController | null = null;
const busyListeners = new Set<() => void>();
export const aiBusy = () => !!controller;
export function onAiBusy(f: () => void): () => void { busyListeners.add(f); return () => busyListeners.delete(f); }
const busyChanged = () => busyListeners.forEach((f) => f());
export function stopAi(): void { controller?.abort(); controller = null; busyChanged(); }

function system(): string {
  const s = aiSettings();
  return [WEB_SYSTEM, s.language && s.language !== 'auto' ? `Write in ${s.language} unless the task names another language.` : '', s.styleGuide ? `Style guide: ${s.styleGuide}` : '', s.voiceProfile ? `Voice: ${s.voiceProfile}` : ''].filter(Boolean).join('\n');
}

/** True when every AI that would answer can read pictures. */
export function canSeeImages(): boolean {
  const plan = activeEnsemble();
  if (plan) return [...plan.members, plan.master].every((m) => !!providerById(m.provider)?.vision);
  const id = aiSettings().active;
  return !!(id && providerById(id)?.vision);
}

export interface AskOptions { tier?: 'fast' | 'quality'; maxTokens?: number; history?: ChatMessage[]; status?: string; onToken?: (delta: string, full: string) => void }

/** Sends a prompt (after the readiness and privacy checks) and returns the answer text, or null. */
export async function ask(app: App, prompt: string | ContentPart[], opts: AskOptions = {}): Promise<string | null> {
  if (!(await ensureAiReady(app))) return null;
  controller?.abort();
  controller = new AbortController();
  const ctl = controller;
  busyChanged();
  app.ui.status?.(`● ${opts.status || 'AI is working…'} (AI ▸ Stop AI to cancel)`);
  try {
    const messages: ChatMessage[] = [{ role: 'system', content: system() }, ...(opts.history || []), { role: 'user', content: prompt }];
    const r = await chat({ messages, tier: opts.tier || 'quality', maxTokens: opts.maxTokens || 2000, signal: ctl.signal, onToken: opts.onToken, onStatus: (t) => app.ui.status?.(`● ${t}`) });
    if (r.ensemble && aiSettings().ensemble.showDeliberation) toast(outcomeLine(r.ensemble, (id) => providerById(id)?.name || id), { ms: 8000 });
    if (r.truncated) toast('The AI answer was cut short; the result may be incomplete.', { ms: 6000 });
    return r.text;
  } catch (e: any) {
    if (e?.code === 'aborted' || ctl.signal.aborted) toast('AI stopped.');
    else toast(`AI: ${e?.message || e}`, { ms: 7000 });
    return null;
  } finally {
    if (controller === ctl) controller = null;
    busyChanged();
    app.ui.status?.('');
  }
}

// ------------------------------------------------------------------------------------------
// Undo: several edits (an insert and a style change) recorded as one step with the command's name

function oneStep(app: App, label: string, fn: () => void, tab: PageTab | undefined = app.active): void {
  if (!tab) { fn(); return; }
  tab.ui.flush();
  const hist = tab.history;
  const start = hist.index;
  fn();
  tab.ui.flush();
  if (hist.index > start) {
    const n = hist.index - start;
    const last = hist.stack[hist.index];
    hist.stack.splice(start + 1, n, last);
    hist.labels.splice(start + 1, n, label);
    hist.index = start + 1;
  }
}

// ------------------------------------------------------------------------------------------
// Previews

async function previewText(title: string, text: string, ok = 'Apply', label = 'Result (you can edit it before applying)'): Promise<string | null> {
  const r = await openDialog({ title, wide: true, ok, fields: [{ key: 't', label, type: 'textarea', rows: Math.min(18, Math.max(5, text.split('\n').length + 1)), value: text }] });
  return r ? String(r.t) : null;
}

/** The CSS a page uses (its linked site style sheets and inline styles), for previews of fragments. */
function pageCss(app: App, path: string, src: string, max = 80000): string {
  const parts: string[] = [];
  for (const href of linkedStyles(src)) {
    const p = resolveRef(path, href);
    const t = p ? app.site.read(p) : undefined;
    if (t) parts.push(t);
  }
  parts.push(...inlineStyles(src));
  return parts.join('\n').slice(0, max);
}

function frameDoc(html: string, css: string, whole: boolean): string {
  const style = css ? `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>` : '';
  if (whole) return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : style + html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${style}</head><body>${html}</body></html>`;
}

/** A sandboxed frame (no scripts, opaque origin) that shows generated markup. */
function previewFrame(height = '42vh'): HTMLIFrameElement {
  return h('iframe', { sandbox: '', title: 'Preview', class: 'ql-ai-frame', style: `width:100%;height:${height};border:1px solid var(--border,#ccc);border-radius:6px;background:#fff` }) as HTMLIFrameElement;
}

/**
 * Previews markup in a sandboxed frame with the code editable below it. Resolves to the edited HTML
 * (and CSS when given), or null when cancelled.
 */
export async function previewHtml(title: string, html: string, opts: { css?: string | null; baseCss?: string; whole?: boolean; ok?: string; help?: string } = {}): Promise<{ html: string; css: string } | null> {
  const frame = previewFrame(opts.whole ? '46vh' : '34vh');
  const issues = h('div', { class: 'ql-help', style: 'color:#b3261e' });
  const content = h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, frame, issues);
  const update = (vals: { html: string; css?: string }) => {
    frame.srcdoc = frameDoc(vals.html, [opts.baseCss || '', vals.css || ''].join('\n'), !!opts.whole);
    const bad = opts.whole ? [] : unbalancedTags(vals.html);
    issues.textContent = bad.length ? `Check the markup: unbalanced ${bad.slice(0, 6).join(', ')}` : '';
  };
  const fields = [{ key: 'html', label: opts.whole ? 'Page (HTML)' : 'HTML', type: 'textarea' as const, rows: 12, value: html }];
  if (opts.css != null) fields.push({ key: 'css', label: 'CSS', type: 'textarea' as const, rows: 6, value: opts.css });
  const later = debounce((v: any) => update(v), 350);
  const r = await openDialog({ title, wide: true, ok: opts.ok || 'Apply', help: opts.help, content, fields, onOpen: () => update({ html, css: opts.css || '' }), onChange: (v, _c, key) => { if (key) later(v); } });
  return r ? { html: String(r.html ?? ''), css: String(r.css ?? '') } : null;
}

function diffElement(before: string, after: string): HTMLElement {
  const d = lineDiff(before, after);
  const st = diffStats(d);
  const rows = foldDiff(d).slice(0, 1500);
  const pre = h('pre', { class: 'ql-ai-diff', style: 'max-height:34vh;overflow:auto;margin:0;font:12px/1.45 ui-monospace,Consolas,monospace;border:1px solid var(--border,#ccc);border-radius:6px;padding:4px 0' });
  for (const l of rows) {
    const bg = l.op === '+' ? 'background:rgba(46,125,50,.16)' : l.op === '-' ? 'background:rgba(198,40,40,.14);text-decoration:line-through;text-decoration-color:rgba(198,40,40,.5)' : l.op === '…' ? 'color:#888;font-style:italic' : '';
    pre.appendChild(h('div', { style: `padding:0 8px;white-space:pre-wrap;${bg}` }, `${l.op === '…' ? '  ' : l.op + ' '}${l.text}`));
  }
  return h('div', null, h('div', { class: 'ql-help' }, st.added || st.removed ? `${st.added} line(s) added, ${st.removed} removed` : 'No changes'), pre);
}

/** Shows the changes between two texts, with the new text editable. Resolves to the edited text or null. */
export async function previewDiff(title: string, before: string, after: string, ok = 'Apply Changes'): Promise<string | null> {
  const holder = h('div');
  holder.appendChild(diffElement(before, after));
  const later = debounce((t: string) => { holder.replaceChildren(diffElement(before, t)); }, 500);
  const r = await openDialog({ title, wide: true, ok, content: holder, fields: [{ key: 't', label: 'New version (you can edit it before applying)', type: 'textarea', rows: 10, value: after }], onChange: (v, _c, key) => { if (key) later(String(v.t)); } });
  return r ? String(r.t) : null;
}

// ------------------------------------------------------------------------------------------
// What a command works on

interface Target { html: string; text: string; where: 'selection' | 'element' | 'code'; apply: (html: string, label: string) => void }

const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dd,dt,td,th,caption,summary,label,address,pre,section,article,aside,header,footer,div';

/**
 * The selection (Design view: its HTML; Code view: its text). Without a selection in Design view, the block
 * that holds the caret.
 */
function selectionTarget(app: App, allowBlock = true): Target | null {
  const v = view(app);
  if (!v || !isText(app)) return null;
  if (v.target === 'code') {
    const t = v.code?.selection.text || '';
    if (!t.trim()) return null;
    return { html: t, text: t, where: 'code', apply: (html, label) => oneStep(app, label, () => insertHtml(app, html)) };
  }
  const sel = selectionHtml(app);
  if (sel.trim()) return { html: sel, text: selectionText(app), where: 'selection', apply: (html, label) => oneStep(app, label, () => insertHtml(app, html)) };
  if (!allowBlock) return null;
  const el = selectedEl(app)?.closest(BLOCKS) as HTMLElement | null;
  if (!el || el === v.design?.doc?.body || !(el.textContent || '').trim()) return null;
  return {
    html: outerSource(el), text: el.textContent || '', where: 'element',
    apply: (html, label) => {
      if (!el.isConnected) { toast('The page changed; select the text again.'); return; }
      oneStep(app, label, () => mutate(app, () => replaceElement(app, el, html)));
    },
  };
}

function requireTab(app: App, pageOnly = true): PageTab | null {
  const t = app.active;
  if (!t || (pageOnly ? t.kind !== 'page' : !isText(app))) { toast(pageOnly ? 'Open a page first.' : 'Open a page, style sheet or script first.'); return null; }
  t.ui.flush();
  return t;
}

/** Site-wide file listing for context (titles of pages, style sheets). */
function siteOutline(app: App, max = 60): string {
  const pages = app.site.pages().filter((f) => !/\.(dwt|lbi)$/i.test(f.path)).slice(0, max);
  return [`Site: ${app.site.name}`, ...pages.map((f) => `- ${f.path}: ${getTitle(f.text || '') || baseName(f.path)}`), ...app.site.list((f) => extOf(f.path) === 'css').slice(0, 10).map((f) => `- ${f.path} (style sheet)`)].join('\n');
}

function classNames(src: string, max = 60): string[] {
  const s = new Set<string>();
  for (const m of src.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)) for (const c of m[1].split(/\s+/)) if (c && !c.startsWith('ql-') && s.size < max) s.add(c);
  return [...s];
}

function pageContext(app: App, tab: PageTab, cssChars = 2500): string {
  const src = tab.source;
  return [`Page title: ${getTitle(src)}`, `Class names in use: ${classNames(src).join(' ') || '(none)'}`, `CSS excerpt:\n${pageCss(app, tab.path, src).slice(0, cssChars)}`].join('\n');
}

const dataUrl = (bytes: Uint8Array, mime: string) => `data:${mime};base64,${b64(bytes)}`;

// ------------------------------------------------------------------------------------------
// Creating pages

/** The site's main style sheet (the one most pages link), if any. */
function mainStylesheet(app: App): string | null {
  const count = new Map<string, number>();
  for (const f of app.site.pages()) for (const href of linkedStyles(f.text || '')) { const p = resolveRef(f.path, href); if (p && app.site.has(p)) count.set(p, (count.get(p) || 0) + 1); }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best || app.site.list((f) => extOf(f.path) === 'css')[0]?.path || null;
}

/**
 * Adds a generated page to the site after asking for its file name; optional CSS and JavaScript become
 * files next to it, and the page can link the site style sheet or attach to a page template.
 */
export async function createPage(app: App, p: { html: string; css?: string; js?: string; name?: string; dir?: string; label: string; rootRelative?: boolean; offerSiteCss?: boolean }): Promise<string | null> {
  const site = app.site;
  const title = getTitle(p.html) || 'New Page';
  const suggested = p.name || joinPath(p.dir || '', `${slugify(title)}.html`);
  const dwts = site.list((f) => /\.dwt$/i.test(f.path)).map((f) => f.path);
  const main = mainStylesheet(app);
  const r = await openDialog({ title: `${p.label}: Save Page`, fields: [
    { key: 'path', label: 'File name in the site', type: 'text', value: suggested },
    ...(main && p.offerSiteCss !== false ? [{ key: 'siteCss', label: `Link the site style sheet (${main})`, type: 'checkbox' as const, value: false }] : []),
    ...(dwts.length ? [{ key: 'tpl', label: 'Attach to a page template', type: 'select' as const, options: [{ value: '', label: 'No' }, ...dwts.map((d) => ({ value: d, label: d }))], value: '', help: 'The page body becomes the template\'s main editable region.' }] : []),
  ] });
  if (!r) return null;
  let path = normalizePath(String(r.path || suggested));
  if (!path) return null;
  if (!isPagePath(path)) path += '.html';
  if (site.has(path) && !(await confirmDialog('Replace File?', `${path} already exists. Replace it?`, 'Replace', 'Keep Both'))) path = site.freeName(dirOf(path), stripExt(baseName(path)), extOf(path) || 'html');
  const link = (target: string) => (p.rootRelative ? '/' + encodeURI(target) : relativeRef(path, target));
  let html = p.html;
  const files: [string, string][] = [];
  if (p.css?.trim()) {
    const cssPath = site.has(joinPath('css', stripExt(baseName(path)) + '.css')) ? site.freeName('css', stripExt(baseName(path)), 'css') : joinPath('css', stripExt(baseName(path)) + '.css');
    files.push([cssPath, p.css.trim() + '\n']);
    if (/href\s*=\s*["'](?:\.\/)?style\.css["']/i.test(html)) html = html.replace(/(href\s*=\s*["'])(?:\.\/)?style\.css(["'])/i, `$1${link(cssPath)}$2`);
    else html = addStylesheet(html, link(cssPath));
  }
  if (p.js?.trim()) {
    const jsPath = site.freeName('js', stripExt(baseName(path)), 'js');
    files.push([jsPath, p.js.trim() + '\n']);
    html = addScript(html, link(jsPath), { defer: true });
  }
  if (r.siteCss && main) html = addStylesheet(html, link(main));
  for (const [fp, text] of files) site.write(fp, text);
  if (r.tpl) html = applyTemplate(site, r.tpl, html, path);
  site.write(path, html);
  app.openFile(path);
  toast(`${p.label}: created ${path}${files.length ? ` and ${files.map((f) => f[0]).join(', ')}` : ''}.`);
  return path;
}

async function pageFromAnswer(app: App, ans: string, label: string, opts: { name?: string; dir?: string; rootRelative?: boolean } = {}): Promise<void> {
  const pg = extractPage(ans);
  const pv = await previewHtml(`${label}: Preview`, pg.html, { whole: true, css: pg.css || null, ok: 'Create Page…', help: 'The preview runs no scripts. Edit the code if you like; the page is created next.' });
  if (!pv) return;
  await createPage(app, { html: pv.html, css: pv.css, js: pg.js, label, ...opts });
}

// ------------------------------------------------------------------------------------------
// Generate

const STYLES = ['clean and modern', 'warm and friendly', 'bold and colorful', 'minimal, lots of white space', 'elegant and classic', 'dark theme', 'playful', 'corporate and trustworthy', 'retro 1990s web, but accessible'];

async function generatePage(app: App): Promise<void> {
  const r = await openDialog({ title: 'Generate Page', wide: true, fields: [
    { key: 'purpose', label: 'What is the page for?', type: 'textarea', rows: 3, value: '', placeholder: 'e.g. A landing page for a neighborhood bakery that takes preorders for holiday pies' },
    { key: 'audience', label: 'Audience', type: 'text', value: '', half: true },
    { key: 'style', label: 'Style', type: 'combo', options: STYLES, value: 'clean and modern', half: true },
    { key: 'sections', label: 'Sections (optional, in order)', type: 'text', value: '', placeholder: 'hero, menu highlights, preorder form, hours and location' },
    { key: 'framework', label: 'CSS framework', type: 'select', options: Object.entries(FRAMEWORKS).map(([value, f]) => ({ value, label: f.label })), value: 'none', half: true },
    { key: 'separateCss', label: 'Put the CSS in its own file', type: 'checkbox', value: true, half: true, visibleIf: (v) => v.framework === 'none' },
  ] });
  if (!r || !String(r.purpose).trim()) return;
  const ans = await ask(app, pagePrompt({ purpose: r.purpose, audience: r.audience, style: r.style, sections: r.sections, framework: r.framework, separateCss: !!r.separateCss }), { maxTokens: 8000, status: 'Writing the page…' });
  if (ans != null) await pageFromAnswer(app, ans, 'Generate Page');
}

function planToText(plan: SitePlan): string {
  return plan.pages.map((p) => `${p.title} | ${p.path}\n${p.outline.split('\n').filter(Boolean).map((l) => `  - ${l.replace(/^\s*[-*•]\s*/, '')}`).join('\n')}`).join('\n');
}
function textToPages(t: string): PlanPage[] {
  const out: PlanPage[] = [];
  for (const line of t.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^\S.*?\|\s*(\S+)\s*$/.exec(line);
    if (m && !/^\s/.test(line)) { out.push({ title: line.slice(0, line.lastIndexOf('|')).trim(), path: normalizePath(m[1]), outline: '' }); continue; }
    if (!out.length) continue;
    const last = out[out.length - 1];
    last.outline += (last.outline ? '\n' : '') + line.trim().replace(/^[-*•]\s*/, '');
  }
  return out.filter((p) => p.title && p.path);
}

async function generateSite(app: App): Promise<void> {
  const r = await openDialog({ title: 'Generate Site', wide: true, fields: [
    { key: 'purpose', label: 'What is the site for?', type: 'textarea', rows: 3, value: '', placeholder: 'e.g. A small landscaping business in a college town' },
    { key: 'audience', label: 'Audience', type: 'text', value: '', half: true },
    { key: 'style', label: 'Style', type: 'combo', options: STYLES, value: 'clean and modern', half: true },
    { key: 'pages', label: 'Pages (optional)', type: 'text', value: '', placeholder: 'Home, Services, About, Contact' },
    { key: 'n', label: 'About how many pages', type: 'number', value: 4, min: 1, max: 12, half: true },
    { key: 'where', label: 'Put it', type: 'radio', options: [{ value: 'new', label: 'In a new site' }, { value: 'here', label: 'In a folder of this site' }], value: app.site.files.size > 3 ? 'new' : 'here' },
    { key: 'folder', label: 'Folder (empty for the site root)', type: 'text', value: '', visibleIf: (v) => v.where === 'here' },
  ] });
  if (!r || !String(r.purpose).trim()) return;
  const ans = await ask(app, sitePlanPrompt({ purpose: r.purpose, audience: r.audience, style: r.style, pages: r.pages, n: +r.n || 4 }), { maxTokens: 5000, status: 'Planning the site…' });
  if (ans == null) return;
  let plan = parseSitePlan(ans);
  if (!plan) { toast('The AI answer was not a site plan. Try again, perhaps with a different model.'); return; }
  const pr = await openDialog({ title: `Site Plan: ${plan.name}`, wide: true, ok: `Write the Pages`, help: 'Edit the plan if you like. Each page is one line "Title | file name" followed by its sections; the style sheet is shared by every page.', fields: [
    { key: 'name', label: 'Site name', type: 'text', value: plan.name },
    { key: 'pages', label: 'Pages and sections', type: 'textarea', rows: 12, value: planToText(plan) },
    { key: 'css', label: 'Shared style sheet (css/style.css)', type: 'textarea', rows: 8, value: plan.css },
  ] });
  if (!pr) return;
  const pages = textToPages(String(pr.pages));
  if (!pages.length) { toast('The plan has no pages.'); return; }
  plan = { ...plan, name: String(pr.name || plan.name), pages, css: String(pr.css || '') };
  const dir = r.where === 'here' ? normalizePath(String(r.folder || '')) : '';
  const files = new Map<string, string>();
  files.set('css/style.css', `/* Shared style sheet for ${plan.name} */\n${SHELL_CSS}\n${plan.css.trim()}\n`);
  for (const [i, page] of plan.pages.entries()) {
    const main = await ask(app, sitePagePrompt(plan, page), { maxTokens: 5000, status: `Writing page ${i + 1} of ${plan.pages.length}: ${page.title}…` });
    if (main == null) { if (!files.size || !(await confirmDialog('Generate Site', `Page ${i + 1} was not written. Keep the ${i} page(s) written so far?`, 'Keep', 'Discard'))) return; break; }
    files.set(page.path, sitePageShell(plan, page, stripActive(extractFragment(main))));
  }
  const written = plan.pages.filter((p) => files.has(p.path));
  // Review: every file, with a preview of each page.
  const frame = previewFrame('40vh');
  const css = files.get('css/style.css') || '';
  const show = (p: string) => { frame.srcdoc = frameDoc((files.get(p) || '').replace(/<link[^>]+style\.css[^>]*>/i, ''), css, true); };
  const ok = await openDialog({ title: `Generate Site: ${files.size} file(s)`, wide: true, ok: 'Create Site', content: frame, onOpen: () => show(written[0].path), onChange: (v, _c, key) => { if (key === 'page') show(v.page); },
    fields: [{ key: 'page', label: 'Preview page', type: 'select', options: written.map((p) => ({ value: p.path, label: `${p.title} (${p.path})` })), value: written[0].path },
      { key: 'i', type: 'info', html: `<p>${[...files.keys()].map((k) => esc(joinPath(dir, k))).join(', ')}</p>` }] });
  if (!ok) return;
  if (r.where === 'new') {
    if (app.siteDirty && app.docs.some((d) => d.dirty) && !(await confirmDialog('Generate Site', 'The open site has unsaved changes. Replace it with the new site anyway? (A draft of it is kept on this device.)', 'Replace', 'Cancel'))) return;
    await app.saveDrafts();
    const site = new Site(plan.name);
    for (const [p, t] of files) site.write(p, t, { silent: true });
    app.setSite(site, { open: 'index.html' });
  } else {
    const clash = [...files.keys()].map((k) => joinPath(dir, k)).filter((p) => app.site.has(p));
    if (clash.length && !(await confirmDialog('Replace Files?', `These files already exist and will be replaced: ${clash.join(', ')}`, 'Replace', 'Cancel'))) return;
    for (const [p, t] of files) app.site.write(joinPath(dir, p), t);
    app.openFile(joinPath(dir, 'index.html'));
  }
  toast(`Generate Site: created ${files.size} file(s).`);
}

async function generateSection(app: App, kind?: string): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const r = await openDialog({ title: 'Generate Section', fields: [
    { key: 'kind', label: 'Section', type: 'select', options: SECTION_KINDS.map((k) => ({ value: k.id, label: k.label })), value: kind || 'hero' },
    { key: 'topic', label: 'About (optional)', type: 'text', value: getTitle(tab.source) },
  ] });
  if (!r) return;
  const ans = await ask(app, sectionPrompt(r.kind, r.topic, pageContext(app, tab)), { maxTokens: 4000, status: 'Writing the section…' });
  if (ans == null) return;
  const html = stripActive(extractFragment(ans));
  const css = codeBlocks(ans).filter((b) => normLang(b.lang) === 'css').map((b) => b.code.trim()).join('\n\n');
  const pv = await previewHtml('Generate Section', html, { css, baseCss: pageCss(app, tab.path, tab.source), ok: 'Insert', help: 'The section is inserted at the cursor; its CSS goes into the page\'s <style> element.' });
  if (!pv) return;
  oneStep(app, 'Generate Section', () => {
    insertHtml(app, pv.html);
    if (pv.css.trim()) app.editSource('Generate Section', (s) => editHeadStyle(s, (c) => `${c.replace(/\s*$/, '\n')}${pv.css.trim()}\n`));
  });
}

async function generateFromSketch(app: App): Promise<void> {
  if (!(await ensureAiReady(app))) return;
  if (!canSeeImages()) {
    toast('The active AI cannot read pictures. Choose a provider with vision (for example Gemini, OpenRouter, OpenAI or Anthropic).', { action: 'Providers', onAction: () => app.exec('ai.providers'), ms: 9000 });
    return;
  }
  const f = (await pickFile('image/png,image/jpeg,image/webp,image/gif'))[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { toast('That picture is larger than 8 MB; use a smaller one.'); return; }
  const url = await readFileAsDataURL(f);
  const r = await openDialog({ title: 'Generate from Sketch', content: h('img', { src: url, alt: 'The sketch', style: 'max-width:100%;max-height:30vh;object-fit:contain;border:1px solid var(--border,#ccc)' }), fields: [
    { key: 'notes', label: 'Notes (optional)', type: 'textarea', rows: 3, value: '', placeholder: 'e.g. The boxes on the right are product cards; the top bar is sticky' },
    { key: 'framework', label: 'CSS framework', type: 'select', options: Object.entries(FRAMEWORKS).map(([value, x]) => ({ value, label: x.label })), value: 'none' },
  ] });
  if (!r) return;
  const ans = await ask(app, [{ type: 'text', text: sketchPrompt(r.notes, r.framework) }, { type: 'image', dataUrl: url }], { maxTokens: 8000, status: 'Reading the sketch…' });
  if (ans != null) await pageFromAnswer(app, ans, 'Generate from Sketch');
}

async function fetchText(url: string): Promise<string | null> {
  try {
    if (desktopHttp) { const r = await desktopHttp({ url, method: 'GET', headers: { Accept: 'text/html' } }); return r.status >= 200 && r.status < 400 ? r.text : null; }
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

async function cloneLayout(app: App): Promise<void> {
  const r = await openDialog({ title: 'Layout from Example', wide: true, help: 'Describe a layout you like, or give the address of a page that has it. Only the arrangement is used: the new page gets its own text, pictures and styling.', fields: [
    { key: 'desc', label: 'Describe the layout', type: 'textarea', rows: 4, value: '', placeholder: 'e.g. Full-width photo banner, three cards below, a two-column section with text and a form, dark footer' },
    { key: 'url', label: 'Or a page address (optional)', type: 'text', value: '', placeholder: 'https://…' },
    { key: 'purpose', label: 'What the new page is for', type: 'text', value: '' },
  ] });
  if (!r || (!String(r.desc).trim() && !String(r.url).trim())) return;
  let outline = '';
  const url = String(r.url || '').trim();
  if (url) {
    if (!/^https:\/\//i.test(url)) { toast('Use an https:// address.'); return; }
    const text = await fetchText(url);
    if (text) outline = structureOutline(text);
    else {
      toast(desktopHttp ? 'That page could not be read.' : 'That site does not allow reading it from a browser. The description is used instead; the desktop app can read most pages.', { ms: 8000 });
      if (!String(r.desc).trim()) return;
    }
  }
  const ans = await ask(app, cloneLayoutPrompt(r.desc, outline, r.purpose), { maxTokens: 8000, status: 'Designing the layout…' });
  if (ans != null) await pageFromAnswer(app, ans, 'Layout from Example');
}

async function generateImage(app: App): Promise<void> {
  const r = await openDialog({ title: 'Generate Illustration', help: 'Most chat AI services cannot make photos or bitmap pictures. This draws an original SVG illustration (shapes and paths) instead, which scales to any size and stays small.', fields: [
    { key: 'desc', label: 'Describe the illustration', type: 'textarea', rows: 3, value: '', placeholder: 'e.g. A hot-air balloon over rolling green hills at sunrise' },
    { key: 'style', label: 'Style', type: 'combo', options: ['flat, modern, friendly', 'line art, one color', 'isometric', 'geometric abstract', 'hand-drawn look', 'icon (simple, bold)'], value: 'flat, modern, friendly' },
    { key: 'w', label: 'Width', type: 'number', value: 800, min: 16, max: 4000, half: true },
    { key: 'h', label: 'Height', type: 'number', value: 500, min: 16, max: 4000, half: true },
  ] });
  if (!r || !String(r.desc).trim()) return;
  const ans = await ask(app, svgPrompt(r.desc, r.style, +r.w || 800, +r.h || 500), { maxTokens: 8000, status: 'Drawing…' });
  if (ans == null) return;
  const svg = extractSvg(ans);
  if (!svg) { toast('The AI answer had no SVG in it.'); return; }
  const img = h('img', { alt: 'Preview', style: 'max-width:100%;max-height:40vh;object-fit:contain;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px;border:1px solid var(--border,#ccc)' }) as HTMLImageElement;
  const show = (s: string) => { img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(stripActive(s)); };
  const pv = await openDialog({ title: 'Generate Illustration', wide: true, ok: isPage(app) ? 'Save and Insert' : 'Save', content: img, onOpen: () => show(svg), onChange: (v, _c, key) => { if (key === 'svg') show(v.svg); }, fields: [
    { key: 'name', label: 'File name', type: 'text', value: `images/${slugify(String(r.desc)).slice(0, 40)}.svg` },
    { key: 'svg', label: 'SVG', type: 'textarea', rows: 8, value: svg },
  ] });
  if (!pv) return;
  let path = normalizePath(String(pv.name || 'images/illustration.svg'));
  if (!/\.svg$/i.test(path)) path += '.svg';
  if (app.site.has(path)) path = app.site.freeName(dirOf(path), stripExt(baseName(path)), 'svg');
  app.site.write(path, stripActive(String(pv.svg)));
  if (isPage(app)) {
    const rel = relativeRef(app.active.path, path);
    oneStep(app, 'Generate Illustration', () => insertHtml(app, `<img src="${escAttr(rel)}" alt="${escAttr(String(r.desc).slice(0, 120))}" width="${+r.w || 800}" height="${+r.h || 500}">`));
  }
  toast(`Saved ${path}.`);
}

async function placeholderContent(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const r = await openDialog({ title: 'Placeholder Content', fields: [
    { key: 'kind', label: 'Content', type: 'select', options: ['paragraphs', 'a heading with paragraphs', 'a bulleted list', 'a data table', 'three cards (heading and paragraph each)', 'testimonials', 'a product list with prices', 'an events list with dates', 'a team list'], value: 'paragraphs' },
    { key: 'topic', label: 'About', type: 'text', value: getTitle(tab.source) },
    { key: 'amount', label: 'Amount', type: 'combo', options: ['short', 'about 150 words', 'about 400 words', 'five items', 'ten items'], value: 'about 150 words' },
  ] });
  if (!r) return;
  const ans = await ask(app, placeholderPrompt(r.kind, r.topic, r.amount), { tier: 'fast', maxTokens: 2500 });
  if (ans == null) return;
  const pv = await previewHtml('Placeholder Content', stripActive(extractFragment(ans)), { baseCss: pageCss(app, tab.path, tab.source), ok: 'Insert' });
  if (pv) oneStep(app, 'Placeholder Content', () => insertHtml(app, pv.html));
}

// ------------------------------------------------------------------------------------------
// Write

const TONES = ['more formal', 'more casual', 'more persuasive', 'more confident', 'friendlier', 'simpler (plain language)', 'more technical', 'more playful', 'more concise and direct'];

async function textTask(app: App, key: keyof typeof TEXT_TASKS, arg?: string): Promise<void> {
  const t = selectionTarget(app);
  if (!t) { toast('Select some text in Design or Code view first (or place the cursor in a paragraph).'); return; }
  const task = TEXT_TASKS[key];
  if (key === 'tone' && !arg) {
    const r = await openDialog({ title: 'Change Tone', fields: [{ key: 't', label: 'Tone', type: 'combo', options: TONES, value: 'more formal' }] });
    if (!r) return; arg = r.t;
  }
  if (key === 'translate' && !arg) {
    const r = await openDialog({ title: 'Translate', fields: [{ key: 'l', label: 'Into', type: 'combo', options: LANGUAGES.map((l) => l[0]), value: 'Spanish' }] });
    if (!r) return; arg = r.l;
  }
  const ans = await ask(app, task.prompt(t.html, arg), { maxTokens: Math.max(1200, Math.ceil(t.html.length / 2)) });
  if (ans == null) return;
  const out = t.where === 'code' && !/<[a-z]/i.test(t.html) ? cleanText(ans) : stripActive(extractFragment(ans));
  const tab = app.active;
  const pv = await previewHtml(task.label, out, { baseCss: tab?.kind === 'page' ? pageCss(app, tab.path, tab.source) : '', ok: t.where === 'element' ? 'Replace Paragraph' : 'Replace Selection' });
  if (pv) t.apply(pv.html, task.label);
}

async function writeCopy(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const r = await openDialog({ title: 'Write Copy', wide: true, fields: [
    { key: 'what', label: 'What should it say?', type: 'textarea', rows: 3, value: '', placeholder: 'e.g. Why customers choose our same-day bicycle repair' },
    { key: 'kind', label: 'Kind', type: 'combo', options: ['a short section with a heading and two paragraphs', 'an "About us" section', 'hero copy (headline and one sentence)', 'a services list with one sentence each', 'a mission statement', 'a short bio', 'an announcement'], value: 'a short section with a heading and two paragraphs' },
    { key: 'tone', label: 'Tone', type: 'combo', options: ['clear and friendly', ...TONES], value: 'clear and friendly' },
  ] });
  if (!r || !String(r.what).trim()) return;
  const ans = await ask(app, writeCopyPrompt(r.what, r.kind, r.tone, pageTextFor(tab.source, 3000)), { maxTokens: 2500 });
  if (ans == null) return;
  const pv = await previewHtml('Write Copy', stripActive(extractFragment(ans)), { baseCss: pageCss(app, tab.path, tab.source), ok: 'Insert' });
  if (pv) oneStep(app, 'Write Copy', () => insertHtml(app, pv.html));
}

async function headline(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const t = selectionTarget(app, false);
  const source = t?.text.trim() || pageTextFor(tab.source, 5000);
  const ans = await ask(app, headlinePrompt(source), { tier: 'fast', maxTokens: 400 });
  if (ans == null) return;
  const options = linesOf(ans).map((l) => l.replace(/^["“]|["”]$/g, '')).slice(0, 8);
  if (!options.length) { toast('The AI answer had no headlines.'); return; }
  const r = await openDialog({ title: 'Suggest Headline', ok: t ? 'Replace Selection' : 'Insert', fields: [
    { key: 'pick', label: 'Suggestions', type: 'list', options, value: options[0], rows: Math.min(8, options.length) },
    { key: 'text', label: 'Headline (edit if you like)', type: 'text', value: options[0] },
    { key: 'level', label: 'As', type: 'select', options: ['h1', 'h2', 'h3', 'text only'], value: 'h2', visibleIf: () => !t },
  ], onChange: (v, ctl, key) => { if (key === 'pick') ctl.set('text', v.pick); } });
  if (!r || !String(r.text).trim()) return;
  const text = esc(String(r.text).trim());
  if (t) t.apply(text, 'Suggest Headline');
  else oneStep(app, 'Suggest Headline', () => insertHtml(app, r.level === 'text only' ? text : `<${r.level}>${text}</${r.level}>`));
}

async function callToAction(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const goal = await promptDialog('Call to Action', 'What should visitors do? (optional)', '', { placeholder: 'e.g. book a free consultation' });
  if (goal == null) return;
  const ans = await ask(app, ctaPrompt(pageTextFor(tab.source, 4000), goal), { tier: 'fast', maxTokens: 800 });
  if (ans == null) return;
  const pv = await previewHtml('Call to Action', stripActive(extractFragment(ans)), { baseCss: pageCss(app, tab.path, tab.source), ok: 'Insert' });
  if (pv) oneStep(app, 'Call to Action', () => insertHtml(app, pv.html));
}

async function translateSite(app: App): Promise<void> {
  const site = app.site;
  const pages = site.pages().filter((f) => !/\.(dwt|lbi)$/i.test(f.path) && !/^(Templates|Library|_)/.test(f.path)).map((f) => f.path);
  if (!pages.length) { toast('The site has no pages.'); return; }
  for (const d of app.docs) d.ui.flush();
  const r = await openDialog({ title: 'Translate Site', wide: true, help: 'Makes a translated copy of each chosen page in a language folder (for example /es/), links each page and its translation with hreflang tags, and points links between translated pages at the translations. Style sheets and pictures are shared.', fields: [
    { key: 'lang', label: 'Into', type: 'combo', options: LANGUAGES.map((l) => l[0]), value: 'Spanish', half: true },
    { key: 'folder', label: 'Folder (language code)', type: 'text', value: '', placeholder: 'es', half: true },
    { key: 'pages', label: 'Pages', type: 'list', multiple: true, options: pages, value: pages, rows: Math.min(10, pages.length) },
    { key: 'detach', label: 'Detach the copies from page templates (so template updates do not overwrite the translation)', type: 'checkbox', value: true },
  ] });
  if (!r) return;
  const chosen: string[] = (r.pages || []).filter((p: string) => site.has(p));
  if (!chosen.length) return;
  const code = String(r.folder || '').trim() || langCode(String(r.lang));
  const folder = normalizePath(code);
  if (!(await ensureAiReady(app)) || !(await confirmWhole(`${chosen.length} page(s)`))) return;
  const set = new Set(chosen);
  const out = new Map<string, string>();
  const originals = new Map<string, string>();
  for (const [i, p] of chosen.entries()) {
    const src = site.read(p) || '';
    const { code: capped, cut } = capCode(src, 60000);
    if (cut) { toast(`${p} is too long to translate in one request; skipped.`); continue; }
    const ans = await ask(app, translatePagePrompt(capped, String(r.lang)), { maxTokens: Math.min(16000, Math.max(2000, Math.ceil(src.length / 2.5))), status: `Translating ${i + 1} of ${chosen.length}: ${p}…` });
    if (ans == null) break;
    const newPath = joinPath(folder, p);
    let t = findDocument(ans) || stripFences(ans, ['html']);
    if (!/<html[\s>]/i.test(t)) { toast(`The translation of ${p} was not a whole page; skipped.`); continue; }
    t = rewriteRefs(t, p, (target) => relativeRef(newPath, set.has(target) ? joinPath(folder, target) : target));
    if (r.detach && attachedTemplate(t, newPath)) t = detachTemplate(t);
    t = setHtmlAttr(t, 'lang', code);
    t = setHtmlAttr(t, 'dir', RTL_LANGS.has(code.split('-')[0]) ? 'rtl' : null);
    const origLang = getLang(src) || 'en';
    t = setAlternateLinks(t, [{ lang: origLang, href: relativeRef(newPath, p) }, { lang: code, href: relativeRef(newPath, newPath) }]);
    out.set(newPath, t);
    originals.set(p, setAlternateLinks(src, [{ lang: origLang, href: relativeRef(p, p) }, { lang: code, href: relativeRef(p, newPath) }]));
  }
  if (!out.size) return;
  const keys = [...out.keys()];
  const frame = previewFrame('40vh');
  const show = (p: string) => { frame.srcdoc = frameDoc(out.get(p) || '', pageCss(app, p, out.get(p) || ''), true); };
  const ok = await openDialog({ title: `Translate Site: ${out.size} page(s)`, wide: true, ok: 'Create Translations', content: frame, onOpen: () => show(keys[0]), onChange: (v, _c, key) => { if (key === 'page') show(v.page); },
    fields: [{ key: 'page', label: 'Preview', type: 'select', options: keys, value: keys[0] }, { key: 'i', type: 'info', html: `<p>The original pages also get hreflang links to their translations.</p>` }] });
  if (!ok) return;
  for (const [p, t] of out) site.write(p, t);
  for (const [p, t] of originals) {
    const tab = app.docs.find((d) => d.path === p);
    if (tab) app.editSource('Translate Site', () => t, tab); else site.write(p, t);
  }
  app.openFile(keys[0]);
  toast(`Translate Site: ${out.size} page(s) in /${folder}/.`);
}

// ------------------------------------------------------------------------------------------
// Code

interface CodeScope { code: string; lang: { name: string; fence: string }; selection: boolean; tab: PageTab; target: Target | null }

function codeScope(app: App): CodeScope | null {
  const tab = requireTab(app, false);
  if (!tab) return null;
  const target = selectionTarget(app, false);
  const lang = codeLang(tab.path);
  if (target) return { code: target.html, lang, selection: true, tab, target };
  return { code: tab.source, lang, selection: false, tab, target: null };
}

/** Quick findings for Fix Code (the AI also checks on its own). */
function quickFindings(code: string, fence: string): string {
  if (fence !== 'html' && fence !== 'php') return '';
  const f: string[] = [];
  const bad = unbalancedTags(code);
  if (bad.length) f.push(`Unbalanced tags: ${bad.slice(0, 10).join(', ')}`);
  const ids = [...code.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  if (dup.length) f.push(`Duplicate ids: ${dup.slice(0, 10).join(', ')}`);
  const noAlt = [...code.matchAll(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi)].length;
  if (noAlt) f.push(`${noAlt} image(s) without alt`);
  if (/<html\b(?![^>]*\blang=)/i.test(code)) f.push('<html> has no lang attribute');
  return f.join('\n');
}

async function codeTask(app: App, key: keyof typeof CODE_TASKS, arg?: string): Promise<void> {
  const s = codeScope(app);
  if (!s) return;
  const task = CODE_TASKS[key];
  if (key === 'convertFramework' && !arg) {
    const r = await openDialog({ title: 'Convert Framework', fields: [{ key: 'to', label: 'Convert to', type: 'select', options: ['Bootstrap 5', 'Tailwind CSS', 'plain CSS (no framework)'], value: 'plain CSS (no framework)' }] });
    if (!r) return; arg = r.to;
  }
  if (key === 'refactor' && arg === undefined) {
    const g = await promptDialog('Refactor Code', 'Goal (optional)', '', { placeholder: 'e.g. use CSS grid instead of floats' });
    if (g == null) return; arg = g;
  }
  if (key === 'fixCode') arg = quickFindings(s.code, s.lang.fence);
  const { code, cut } = capCode(s.code, 60000);
  if (cut) { toast('The code is too long for one request; select part of it first.'); return; }
  const ans = await ask(app, task.prompt(code, s.lang.name, arg), { maxTokens: Math.min(16000, Math.max(2000, Math.ceil(code.length / 2.2))), status: `${task.label}…` });
  if (ans == null) return;
  let result = stripFences(ans, [s.lang.fence, 'html']);
  if (!s.selection && s.lang.fence === 'html') result = findDocument(ans) || result;
  if (!result.trim()) { toast('The AI answer was empty.'); return; }
  if (!s.selection && s.code.endsWith('\n') && !result.endsWith('\n')) result += '\n';
  const out = await previewDiff(task.label, s.code, result);
  if (out == null) return;
  if (s.target) s.target.apply(out, task.label);
  else app.editSource(task.label, () => out, s.tab);
}

async function analysisTask(app: App, key: keyof typeof ANALYSIS_TASKS): Promise<void> {
  const s = codeScope(app);
  if (!s) return;
  const task = ANALYSIS_TASKS[key];
  const input = key === 'summarize' ? pageTextFor(s.tab.source, 20000) : capCode(s.code, 50000).code;
  const ans = await ask(app, task.prompt(input, s.lang.name), { maxTokens: 3000, status: `${task.label}…` });
  if (ans == null) return;
  postToAssistant(app, `${task.label}: ${s.selection ? 'selection' : s.tab.path}`, cleanText(ans));
}

async function generateCss(app: App): Promise<void> {
  const tab = requireTab(app, false);
  if (!tab) return;
  const isCss = extOf(tab.path) === 'css';
  const el = !isCss && view(app)?.target === 'design' ? selectedEl(app) : null;
  const elInfo = el && el !== view(app)?.design?.doc?.body ? outerSource(el).slice(0, 1500) : '';
  const sheets = isCss ? [tab.path] : linkedStyles(tab.source).map((href) => resolveRef(tab.path, href)).filter((p): p is string => !!p && app.site.has(p));
  const r = await openDialog({ title: 'Generate CSS', wide: true, fields: [
    { key: 'desc', label: 'Describe the styling', type: 'textarea', rows: 3, value: '', placeholder: elInfo ? 'e.g. Make this a card with a soft shadow and rounded corners' : 'e.g. A sticky header that shrinks, warm colors, readable body text' },
    ...(isCss ? [] : [{ key: 'where', label: 'Add the CSS to', type: 'select' as const, options: [{ value: '', label: 'This page (<style> in the head)' }, ...sheets.map((p) => ({ value: p, label: p })), { value: '__new', label: 'A new style sheet…' }], value: sheets[0] || '' }]),
  ] });
  if (!r || !String(r.desc).trim()) return;
  const ctx = [elInfo ? `Selected element:\n${elInfo}` : '', isCss ? `Existing style sheet:\n${tab.source.slice(0, 6000)}` : pageContext(app, tab, 4000)].filter(Boolean).join('\n\n');
  const ans = await ask(app, cssPrompt(r.desc, ctx), { maxTokens: 3000, status: 'Writing CSS…' });
  if (ans == null) return;
  const css = stripFences(ans, ['css']).replace(/<\/?style[^>]*>/gi, '').trim();
  const pv = await previewHtml('Generate CSS', isCss ? '<p>Preview the CSS on a page that uses this style sheet.</p>' : (elInfo || '<p>Sample paragraph.</p>'), { css, baseCss: isCss ? tab.source : pageCss(app, tab.path, tab.source), ok: 'Add CSS', help: 'The CSS is shown applied to the selected element (or a sample); edit it below.' });
  if (!pv || !pv.css.trim()) return;
  const add = (src: string) => `${src.replace(/\s*$/, '\n\n')}${pv.css.trim()}\n`;
  if (isCss) { app.editSource('Generate CSS', add, tab); return; }
  let where = String(r.where || '');
  if (where === '__new') {
    const name = await promptDialog('New Style Sheet', 'File name', 'css/styles.css');
    if (!name) return;
    where = normalizePath(name.endsWith('.css') ? name : name + '.css');
    if (!app.site.has(where)) app.site.write(where, '');
    app.editSource('Generate CSS', (s) => addStylesheet(s, relativeRef(tab.path, where)), tab);
  }
  if (!where) { app.editSource('Generate CSS', (s) => editHeadStyle(s, (c) => add(c)), tab); return; }
  const sheetTab = app.docs.find((d) => d.path === where);
  if (sheetTab) app.editSource('Generate CSS', add, sheetTab);
  else app.site.write(where, add(app.site.read(where) || ''));
  toast(`Generate CSS: added to ${where}.`);
}

async function generateJs(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const r = await openDialog({ title: 'Generate JavaScript', wide: true, fields: [
    { key: 'desc', label: 'What should the script do?', type: 'textarea', rows: 3, value: '', placeholder: 'e.g. A menu button that opens and closes the navigation on small screens' },
    { key: 'where', label: 'Put it', type: 'radio', options: [{ value: 'file', label: 'In a script file linked from the page' }, { value: 'inline', label: 'In a <script> at the end of the page' }], value: 'file' },
    { key: 'name', label: 'File name', type: 'text', value: `js/${stripExt(baseName(tab.path))}.js`, visibleIf: (v) => v.where === 'file' },
  ] });
  if (!r || !String(r.desc).trim()) return;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(tab.source)?.[1] || tab.source;
  const ans = await ask(app, jsPrompt(r.desc, body.replace(/<script\b[\s\S]*?<\/script>/gi, '').slice(0, 6000)), { maxTokens: 3000, status: 'Writing JavaScript…' });
  if (ans == null) return;
  const js = stripFences(ans, ['js']).replace(/<\/?script[^>]*>/gi, '').trim();
  const out = await previewText('Generate JavaScript', js, 'Add Script', 'JavaScript (it runs only in Preview and the published page, never in Design view)');
  if (out == null || !out.trim()) return;
  if (r.where === 'inline') {
    app.editSource('Generate JavaScript', (s) => { const at = s.search(/<\/body\s*>(?![\s\S]*<\/body)/i); const tag = `<script>\n${out.trim().replace(/<\/script/gi, '<\\/script')}\n</script>\n`; return at >= 0 ? s.slice(0, at) + tag + s.slice(at) : s + tag; }, tab);
    return;
  }
  let path = normalizePath(String(r.name || 'js/script.js'));
  if (!/\.m?js$/i.test(path)) path += '.js';
  const existing = app.site.read(path);
  app.site.write(path, existing ? `${existing.replace(/\s*$/, '\n\n')}${out.trim()}\n` : `${out.trim()}\n`);
  app.editSource('Generate JavaScript', (s) => addScript(s, relativeRef(tab.path, path), { defer: true }), tab);
  toast(`Generate JavaScript: ${existing ? 'added to' : 'created'} ${path}.`);
}

// ------------------------------------------------------------------------------------------
// Optimize

async function seo(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const src = tab.source;
  const ans = await ask(app, seoPrompt(pageTextFor(src, 12000), getTitle(src), getMeta(src, 'description') || '', tab.path), { maxTokens: 1500, status: 'Reviewing for search…' });
  if (ans == null) return;
  const j = parseJsonLoose<any>(ans);
  if (!j || typeof j !== 'object') { postToAssistant(app, 'SEO Suggestions', cleanText(ans)); return; }
  const list = (x: any) => (Array.isArray(x) ? x.map((s) => `<li>${esc(String(s))}</li>`).join('') : '');
  const r = await openDialog({ title: 'SEO Suggestions', wide: true, ok: 'Apply Title and Meta', fields: [
    { key: 'title', label: 'Title', type: 'text', value: String(j.title || getTitle(src)), help: `Currently: ${getTitle(src) || '(none)'}` },
    { key: 'description', label: 'Meta description', type: 'textarea', rows: 3, value: String(j.description || ''), help: 'About 140–160 characters' },
    { key: 'keywords', label: 'Meta keywords (search engines mostly ignore them)', type: 'text', value: String(j.keywords || '') },
    { key: 'useKeywords', label: 'Add the keywords meta tag', type: 'checkbox', value: false },
    { key: 'i', type: 'info', html: `${j.h1 ? `<p><b>Suggested h1:</b> ${esc(String(j.h1))}</p>` : ''}${Array.isArray(j.headings) && j.headings.length ? `<p><b>Suggested outline:</b></p><ul>${list(j.headings)}</ul>` : ''}${Array.isArray(j.notes) && j.notes.length ? `<p><b>Suggestions:</b></p><ul>${list(j.notes)}</ul>` : ''}` },
  ] });
  if (!r) return;
  app.editSource('SEO', (s) => {
    let o = setTitle(s, String(r.title).trim() || getTitle(s));
    if (String(r.description).trim()) o = setMeta(o, 'description', String(r.description).trim());
    if (r.useKeywords && String(r.keywords).trim()) o = setMeta(o, 'keywords', String(r.keywords).trim());
    return o;
  }, tab);
}

async function metaTags(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const src = tab.source;
  const ans = await ask(app, metaTagsPrompt(pageTextFor(src, 10000), getTitle(src), tab.path, app.site.name), { tier: 'fast', maxTokens: 1000, status: 'Writing meta tags…' });
  if (ans == null) return;
  const j = parseJsonLoose<Record<string, string>>(ans) || {};
  const keys: [string, 'name' | 'property', string][] = [['description', 'name', 'Description'], ['keywords', 'name', 'Keywords'], ['robots', 'name', 'Robots'], ['og:title', 'property', 'Open Graph title'], ['og:description', 'property', 'Open Graph description'], ['og:type', 'property', 'Open Graph type'], ['twitter:card', 'name', 'Card type (X/Twitter)']];
  const r = await openDialog({ title: 'Meta Tags', wide: true, ok: 'Apply', help: 'Empty fields are left out. Existing tags with the same name are replaced.', fields: keys.map(([k, attr, label]) => ({ key: k, label: `${label} (${k})`, type: k.includes('description') ? 'textarea' as const : 'text' as const, rows: 2, value: String(j[k] ?? getMeta(src, k, attr) ?? '') })) });
  if (!r) return;
  app.editSource('Meta Tags', (s) => { let o = s; for (const [k, attr] of keys) { const v = String(r[k] || '').trim(); if (v) o = setMeta(o, k, v, attr); } return o; }, tab);
}

function guessSchemaType(src: string): string {
  if (/<form\b/i.test(src) && /contact/i.test(getTitle(src))) return 'ContactPage';
  if (/<details\b/i.test(src) && /faq|question/i.test(src)) return 'FAQPage';
  if (/<article\b/i.test(src)) return 'Article';
  if (/price|\$\d/i.test(src) && /product|buy|cart/i.test(src)) return 'Product';
  if (/about/i.test(getTitle(src))) return 'AboutPage';
  return 'WebSite';
}

async function schema(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const src = tab.source;
  const r = await openDialog({ title: 'Structured Data', fields: [{ key: 'type', label: 'Schema type', type: 'combo', options: SCHEMA_TYPES, value: guessSchemaType(src) }] });
  if (!r) return;
  const ans = await ask(app, schemaPrompt(String(r.type), pageTextFor(src, 12000), tab.path), { maxTokens: 2000, status: 'Writing structured data…' });
  if (ans == null) return;
  const j = parseJsonLoose<any>(ans);
  if (!j || typeof j !== 'object') { toast('The AI answer was not JSON.'); return; }
  const r2 = await openDialog({ title: 'Structured Data (JSON-LD)', wide: true, ok: 'Add to Page', fields: [{ key: 't', label: 'JSON-LD (added to the head; only facts on the page should be in it)', type: 'textarea', rows: 16, value: JSON.stringify(j, null, 2) }], validate: (v) => { try { JSON.parse(v.t); return null; } catch (e: any) { return `Not valid JSON: ${e.message}`; } } });
  if (!r2) return;
  const json = JSON.stringify(JSON.parse(r2.t), null, 2).replace(/<\/script/gi, '<\\/script');
  const type = String(JSON.parse(r2.t)['@type'] || '');
  app.editSource('Structured Data', (s) => {
    const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let replaced = false;
    const o = s.replace(re, (m, body) => { if (replaced) return m; try { if (type && JSON.parse(body)['@type'] === type) { replaced = true; return `<script type="application/ld+json">\n${json}\n</script>`; } } catch { /* keep */ } return m; });
    return replaced ? o : headInsert(o, `<script type="application/ld+json">\n${json}\n</script>`);
  }, tab);
}

/** Alt text for one site picture: the picture itself when the AI can see, else its name and context. */
async function altFor(app: App, imgPath: string | null, ctx: string, rawSrc: string): Promise<string | null> {
  const bytes = imgPath ? app.site.bytes(imgPath) : undefined;
  const mime = imgPath ? mimeOf(imgPath) : '';
  const seeable = !!bytes && canSeeImages() && /^image\/(png|jpeg|gif|webp)$/.test(mime) && bytes.length < 5 * 1024 * 1024;
  const fullCtx = `${ctx}; file "${imgPath || rawSrc}"`;
  const prompt = altTextPrompt(fullCtx, seeable);
  const ans = await ask(app, seeable ? [{ type: 'text', text: prompt }, { type: 'image', dataUrl: dataUrl(bytes!, mime) }] : prompt, { tier: 'fast', maxTokens: 120, status: `Describing ${baseName(imgPath || rawSrc)}…` });
  if (ans == null) return null;
  const t = cleanText(ans).split('\n')[0].replace(/^alt(?: text)?:\s*/i, '').replace(/^["“]|["”]$/g, '').trim();
  return /^DECORATIVE\.?$/i.test(t) ? '' : t;
}

/** Pictures without an alt attribute in a page's source: [src, resolved path or null]. */
function imagesWithoutAlt(src: string, pagePath: string): [string, string | null][] {
  const out: [string, string | null][] = [];
  for (const m of src.matchAll(/<img\b[^>]*>/gi)) {
    if (/\balt\s*=/i.test(m[0])) continue;
    const s = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    if (s && !out.some((x) => x[0] === s)) out.push([s, resolveRef(pagePath, s)]);
  }
  return out;
}

function setAltsInSource(src: string, pagePath: string, alts: Map<string, string>): string {
  return src.replace(/<img\b[^>]*>/gi, (tag) => {
    if (/\balt\s*=/i.test(tag)) return tag;
    const s = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const key = s ? resolveRef(pagePath, s) || s : null;
    if (!key || !alts.has(key)) return tag;
    return tag.replace(/^<img\b/i, `<img alt="${escAttr(alts.get(key)!)}"`);
  });
}

async function altTextBatch(app: App, pagePaths: string[], label: string): Promise<void> {
  for (const d of app.docs) d.ui.flush();
  const jobs = new Map<string, { raw: string; ctx: string }>();
  for (const p of pagePaths) {
    const src = app.site.read(p) || '';
    for (const [raw, path] of imagesWithoutAlt(src, p)) {
      const key = path || raw;
      if (!jobs.has(key)) jobs.set(key, { raw, ctx: `on the page "${getTitle(src) || p}"` });
    }
  }
  if (!jobs.size) { toast('Every picture already has alternative text.'); return; }
  const list = [...jobs.entries()].slice(0, 40);
  if (jobs.size > 40) toast(`${jobs.size} pictures need alt text; the first 40 are done now. Run the command again for the rest.`, { ms: 7000 });
  if (!(await ensureAiReady(app)) || (pagePaths.length > 1 && !(await confirmWhole(`${list.length} picture(s)${canSeeImages() ? '' : ' (names and page titles only)'}`)))) return;
  const results: [string, string][] = [];
  for (const [key, j] of list) {
    const alt = await altFor(app, app.site.has(key) ? key : null, j.ctx, j.raw);
    if (alt == null) break;
    results.push([key, alt]);
  }
  if (!results.length) return;
  const text = results.map(([k, a]) => `${k} = ${a}`).join('\n');
  const out = await previewText(label, text, 'Apply', 'One picture per line: "picture = alternative text" (leave the text empty for decorative pictures)');
  if (out == null) return;
  const alts = new Map<string, string>();
  for (const line of out.split('\n')) { const i = line.indexOf(' = '); const j = i >= 0 ? i : line.indexOf('='); if (j > 0) alts.set(line.slice(0, j).trim(), line.slice(j + (i >= 0 ? 3 : 1)).trim()); }
  let n = 0;
  for (const p of pagePaths) {
    const src = app.site.read(p) || '';
    const next = setAltsInSource(src, p, alts);
    if (next === src) continue;
    n++;
    const tab = app.docs.find((d) => d.path === p);
    if (tab) app.editSource(label, () => next, tab); else app.site.write(p, next);
  }
  toast(`${label}: updated ${n} page(s).`);
}

async function altText(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const img = view(app)?.target === 'design' ? (closestSel(app, 'img') as HTMLImageElement | null) : null;
  if (!img) { await altTextBatch(app, [tab.path], 'Alt Text'); return; }
  const raw = img.getAttribute('data-ql-o-src') ?? img.getAttribute('src') ?? '';
  const path = resolveRef(tab.path, raw);
  const caption = img.closest('figure')?.querySelector('figcaption')?.textContent?.trim();
  const ctx = `on the page "${getTitle(tab.source)}"${caption ? `; caption "${caption}"` : ''}; nearby text "${(img.parentElement?.textContent || '').trim().slice(0, 200)}"`;
  const alt = await altFor(app, path && app.site.has(path) ? path : null, ctx, raw);
  if (alt == null) return;
  const out = await previewText('Alt Text', alt, 'Apply', 'Alternative text (empty for a decorative picture)');
  if (out == null || !img.isConnected) return;
  oneStep(app, 'Alt Text', () => mutate(app, () => img.setAttribute('alt', out.trim())));
}

async function altTextSite(app: App): Promise<void> {
  const pages = app.site.pages().filter((f) => !/\.lbi$/i.test(f.path)).map((f) => f.path);
  await altTextBatch(app, pages, 'Alt Text for Site');
}

// ------------------------------------------------------------------------------------------
// Content

async function insertFragmentFrom(app: App, tab: PageTab, ans: string, label: string): Promise<void> {
  const pv = await previewHtml(label, stripActive(extractFragment(ans)), { baseCss: pageCss(app, tab.path, tab.source), ok: 'Insert' });
  if (pv) oneStep(app, label, () => insertHtml(app, pv.html));
}

async function faq(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const r = await openDialog({ title: 'FAQ', fields: [
    { key: 'from', label: 'Questions from', type: 'radio', options: [{ value: 'page', label: 'This page\'s content' }, { value: 'topic', label: 'A topic' }], value: 'page' },
    { key: 'topic', label: 'Topic', type: 'text', value: '', visibleIf: (v) => v.from === 'topic' },
    { key: 'n', label: 'Questions', type: 'number', value: 6, min: 2, max: 20 },
  ] });
  if (!r) return;
  const ans = await ask(app, faqPrompt(r.from === 'page' ? pageTextFor(tab.source, 12000) : '', String(r.topic || getTitle(tab.source)), +r.n || 6), { maxTokens: 3000 });
  if (ans != null) await insertFragmentFrom(app, tab, ans, 'FAQ');
}

async function blogPost(app: App): Promise<void> {
  const r = await openDialog({ title: 'Blog Post', wide: true, fields: [
    { key: 'topic', label: 'Topic', type: 'textarea', rows: 2, value: '' },
    { key: 'audience', label: 'Audience', type: 'text', value: '', half: true },
    { key: 'tone', label: 'Tone', type: 'combo', options: ['friendly and informative', 'expert and practical', 'personal and reflective', 'enthusiastic', 'formal'], value: 'friendly and informative', half: true },
    { key: 'words', label: 'About how many words', type: 'number', value: 800, min: 150, max: 3000, half: true },
    { key: 'where', label: 'Put it', type: 'radio', options: [{ value: 'new', label: 'In a new page' }, { value: 'here', label: 'At the cursor' }], value: 'new' },
  ] });
  if (!r || !String(r.topic).trim()) return;
  const ans = await ask(app, blogPostPrompt(r.topic, r.audience, +r.words || 800, r.tone), { maxTokens: Math.min(8000, Math.round((+r.words || 800) * 2.2)), status: 'Writing the post…' });
  if (ans == null) return;
  const frag = stripActive(extractFragment(ans));
  if (r.where === 'here' && isPage(app)) { await insertFragmentFrom(app, app.active, ans, 'Blog Post'); return; }
  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(frag)?.[1]?.replace(/<[^>]+>/g, '').trim() || String(r.topic).slice(0, 70);
  const pv = await previewHtml('Blog Post', blankPage({ title, body: `<main>\n${frag}\n</main>` }), { whole: true, ok: 'Create Page…' });
  if (pv) await createPage(app, { html: pv.html, css: pv.css, label: 'Blog Post', dir: 'blog' });
}

async function productCopy(app: App): Promise<void> {
  const tab = requireTab(app);
  if (!tab) return;
  const r = await openDialog({ title: 'Product Description', wide: true, fields: [
    { key: 'name', label: 'Product or service name', type: 'text', value: '' },
    { key: 'features', label: 'Features and facts (one per line)', type: 'textarea', rows: 5, value: selectionText(app) },
    { key: 'audience', label: 'Audience', type: 'text', value: '', half: true },
    { key: 'tone', label: 'Tone', type: 'combo', options: ['confident and friendly', 'premium', 'technical', 'playful', 'warm'], value: 'confident and friendly', half: true },
  ] });
  if (!r || !String(r.name).trim()) return;
  const ans = await ask(app, productCopyPrompt(r.name, r.features, r.audience, r.tone), { maxTokens: 2000 });
  if (ans != null) await insertFragmentFrom(app, tab, ans, 'Product Description');
}

async function legalPage(app: App, kind: 'privacy' | 'terms'): Promise<void> {
  const label = kind === 'privacy' ? 'Privacy Policy' : 'Terms of Use';
  const r = await openDialog({ title: label, wide: true, help: 'This writes a starting template, not legal advice. Have it reviewed by a qualified professional before you publish it.', fields: [
    { key: 'org', label: 'Organization or owner', type: 'text', value: '', half: true },
    { key: 'site', label: 'Site name or address', type: 'text', value: app.site.name, half: true },
    { key: 'email', label: 'Contact email', type: 'text', value: '', half: true },
    { key: 'country', label: 'Country or state', type: 'text', value: 'United States', half: true },
    { key: 'practices', label: kind === 'privacy' ? 'What the site collects and uses (forms, analytics, cookies, newsletters, payments…)' : 'Facts that matter (accounts, user posts, purchases, age limits…)', type: 'textarea', rows: 4, value: '' },
  ] });
  if (!r) return;
  const ans = await ask(app, legalPrompt(kind, r as any), { maxTokens: 7000, status: `Writing the ${label.toLowerCase()}…` });
  if (ans != null) await pageFromAnswer(app, ans, label, { name: kind === 'privacy' ? 'privacy.html' : 'terms.html' });
}

async function errorPage(app: App): Promise<void> {
  const r = await openDialog({ title: '404 Page', fields: [{ key: 'style', label: 'Style', type: 'combo', options: STYLES, value: 'clean and modern' }] });
  if (!r) return;
  const ans = await ask(app, errorPagePrompt(app.site.name, r.style, '/'), { maxTokens: 5000, status: 'Writing the 404 page…' });
  if (ans != null) await pageFromAnswer(app, ans, '404 Page', { name: '404.html', rootRelative: true });
}

// ------------------------------------------------------------------------------------------
// Assistant answers (used by the AI pane)

/** Applies an assistant answer: insert at the cursor, replace the selection, or apply to the whole page/file. */
export async function applyAnswer(app: App, answer: string, mode: 'insert' | 'replace' | 'page'): Promise<void> {
  const tab = app.active;
  if (!tab || !isText(app)) { toast('Open a page first.'); return; }
  tab.ui.flush();
  if (mode === 'page') {
    const lang = codeLang(tab.path);
    let next: string;
    if (tab.kind === 'page') {
      const doc = findDocument(answer);
      next = doc || replaceBody(tab.source, `\n${stripActive(extractFragment(answer)) || proseToHtml(answer)}\n`);
    } else next = stripFences(answer, [lang.fence]);
    if (!next.trim()) { toast('The answer has nothing to apply.'); return; }
    const out = await previewDiff('Apply to Page', tab.source, next);
    if (out != null) app.editSource('AI Assistant', () => out, tab);
    return;
  }
  const blocks = codeBlocks(answer);
  const frag = tab.kind === 'page' ? (blocks.length ? stripActive(extractFragment(answer)) : proseToHtml(answer)) : stripFences(answer, [codeLang(tab.path).fence]);
  if (mode === 'replace') {
    const t = selectionTarget(app, false);
    if (!t) { toast('Select something to replace first.'); return; }
    const pv = await previewHtml('Replace Selection', frag, { baseCss: tab.kind === 'page' ? pageCss(app, tab.path, tab.source) : '', ok: 'Replace' });
    if (pv) t.apply(pv.html, 'AI Assistant');
    return;
  }
  const pv = await previewHtml('Insert', frag, { baseCss: tab.kind === 'page' ? pageCss(app, tab.path, tab.source) : '', ok: 'Insert' });
  if (pv) oneStep(app, 'AI Assistant', () => insertHtml(app, pv.html));
}

/** The context the assistant sends with a question. */
export function assistantContext(app: App, kind: 'none' | 'selection' | 'page' | 'site'): string {
  const tab = app.active;
  if (kind === 'none' || !tab) return '';
  if (kind === 'selection') { const t = isText(app) ? selectionTarget(app, false) : null; return t ? `Selected ${tab.kind === 'page' ? 'HTML' : 'code'} in ${tab.path}:\n"""\n${t.html.slice(0, 20000)}\n"""` : ''; }
  if (kind === 'page') { tab.ui.flush(); return `File ${tab.path}:\n"""\n${capCode(tab.source, 40000).code}\n"""`; }
  return siteOutline(app);
}

// ------------------------------------------------------------------------------------------
// Prompt library

type PromptInput = SavedPrompt['input'] | 'site';
const INPUTS: { value: PromptInput; label: string }[] = [{ value: 'selection', label: 'The selection' }, { value: 'document', label: 'The page (its code)' }, { value: 'site', label: 'The site (page list and text)' }, { value: 'none', label: 'Nothing (the prompt only)' }];
const OUTPUTS: { value: SavedPrompt['output']; label: string }[] = [{ value: 'replace', label: 'Replace the selection' }, { value: 'insert', label: 'Insert at the cursor' }, { value: 'pane', label: 'Show in the AI Assistant pane' }, { value: 'newdoc', label: 'Create a new page' }, { value: 'comment', label: 'Insert as an HTML comment' }];

const STARTER_PROMPTS: Omit<SavedPrompt, 'id'>[] = [
  { name: 'Plain-language rewrite', prompt: 'Rewrite this for an eighth-grade reading level, keeping the HTML markup.', input: 'selection', output: 'replace' },
  { name: 'Make a comparison table', prompt: 'Turn this content into an accessible HTML comparison table with a caption and header cells.', input: 'selection', output: 'replace' },
  { name: 'Site content audit', prompt: 'Audit this site: missing pages a visitor would expect, inconsistent titles, thin pages, and the five most useful improvements.', input: 'site' as any, output: 'pane' },
];

function siteText(app: App, max = 30000): string {
  for (const d of app.docs) d.ui.flush();
  let out = siteOutline(app) + '\n';
  for (const f of app.site.pages()) {
    if (/\.(dwt|lbi)$/i.test(f.path) || out.length > max) continue;
    out += `\n## ${f.path}\n${pageTextFor(f.text || '', 2000)}\n`;
  }
  return out.slice(0, max);
}

async function editPrompt(p?: SavedPrompt): Promise<void> {
  const r = await openDialog({ title: p ? 'Edit Prompt' : 'New Prompt', wide: true, fields: [
    { key: 'name', label: 'Name', type: 'text', value: p?.name || '' },
    { key: 'prompt', label: 'Prompt (the input is added after it)', type: 'textarea', rows: 5, value: p?.prompt || '' },
    { key: 'input', label: 'Input', type: 'select', options: INPUTS, value: p?.input || 'selection', half: true },
    { key: 'output', label: 'Result', type: 'select', options: OUTPUTS, value: p?.output || 'replace', half: true },
  ] });
  if (!r || !String(r.name).trim() || !String(r.prompt).trim()) return;
  saveAiSettings((x) => {
    const v = { name: String(r.name).trim(), prompt: String(r.prompt), input: r.input, output: r.output } as SavedPrompt;
    const at = p ? x.prompts.findIndex((q) => q.id === p.id) : -1;
    if (at >= 0) x.prompts[at] = { ...x.prompts[at], ...v }; else x.prompts.push({ ...v, id: newId('pr') });
  });
}

async function managePrompts(app: App): Promise<void> {
  for (;;) {
    const list = aiSettings().prompts;
    const r = await openDialog({ title: 'Prompt Library', ok: 'Close', cancel: false, fields: [
      { key: 'sel', label: 'Saved prompts', type: 'list', options: list.map((p) => ({ value: p.id, label: p.name })), rows: 8 },
      { key: 'new', label: 'New…', type: 'button', onClick: (_v, c) => c.close({ act: 'new' }) },
      { key: 'edit', label: 'Edit…', type: 'button', onClick: (v, c) => c.close({ act: 'edit', id: v.sel }) },
      { key: 'del', label: 'Delete', type: 'button', onClick: (v, c) => c.close({ act: 'del', id: v.sel }) },
      { key: 'run', label: 'Run', type: 'button', onClick: (v, c) => c.close({ act: 'run', id: v.sel }) },
      ...(list.length ? [] : [{ key: 'starter', label: 'Add Sample Prompts', type: 'button' as const, onClick: (_v: any, c: any) => c.close({ act: 'starter' }) }]),
    ] });
    if (!r?.act) return;
    const p = list.find((x) => x.id === r.id);
    if (r.act === 'new') await editPrompt();
    else if (r.act === 'starter') saveAiSettings((x) => { for (const s of STARTER_PROMPTS) x.prompts.push({ ...s, id: newId('pr') } as SavedPrompt); });
    else if (!p) toast('Choose a prompt first.');
    else if (r.act === 'edit') await editPrompt(p);
    else if (r.act === 'del') { if (await confirmDialog('Delete Prompt', `Delete "${p.name}"?`, 'Delete')) saveAiSettings((x) => { x.prompts = x.prompts.filter((q) => q.id !== p.id); }); }
    else if (r.act === 'run') { await runPrompt(app, p); return; }
  }
}

async function runPrompt(app: App, p: SavedPrompt): Promise<void> {
  const input = p.input as PromptInput;
  const tab = app.active;
  const target = isText(app) ? selectionTarget(app) : null;
  let data = '';
  if (input === 'selection') { if (!target) { toast('Select some text or code first.'); return; } data = target.html; }
  else if (input === 'document') { if (!tab || !isText(app)) { toast('Open a page first.'); return; } tab.ui.flush(); data = capCode(tab.source, 40000).code; }
  else if (input === 'site') { if (!(await confirmWhole('The text of the site\'s pages'))) return; data = siteText(app); }
  const ans = await ask(app, data ? `${p.prompt}\n"""\n${data}\n"""` : p.prompt, { maxTokens: p.output === 'newdoc' ? 8000 : 3000, status: `${p.name}…` });
  if (ans == null) return;
  switch (p.output) {
    case 'pane': postToAssistant(app, p.name, cleanText(ans)); return;
    case 'newdoc': await pageFromAnswer(app, ans, p.name); return;
    case 'comment': {
      if (!tab || !isText(app)) { postToAssistant(app, p.name, cleanText(ans)); return; }
      const c = await previewText(p.name, cleanText(ans), 'Insert Comment');
      if (c != null) oneStep(app, p.name, () => insertHtml(app, `<!-- ${c.replace(/--/g, '- -')} -->`));
      return;
    }
    default: {
      if (p.output === 'replace' && target) {
        const out = target.where === 'code' && !/<[a-z]/i.test(target.html) ? cleanText(ans) : stripActive(extractFragment(ans) || proseToHtml(ans));
        const pv = await previewHtml(p.name, out, { ok: 'Replace' });
        if (pv) target.apply(pv.html, p.name);
        return;
      }
      // Insert (or replace with nothing selected): at the cursor.
      if (!tab || !isText(app)) { postToAssistant(app, p.name, cleanText(ans)); return; }
      await applyAnswer(app, ans, 'insert');
    }
  }
}

// ------------------------------------------------------------------------------------------
// Several AIs

const ENSEMBLE_MODES: { value: EnsembleMode; label: string }[] = [
  { value: 'single', label: 'Single AI' },
  { value: 'master', label: 'Master Combines Answers' },
  { value: 'consensus', label: 'Quaker Consensus' },
];

async function setEnsembleMode(app: App, mode?: string): Promise<void> {
  const pick = ENSEMBLE_MODES.find((o) => o.value === mode);
  const { openAiSettings } = await import('../ui/aiWizard');
  if (!pick) { await openAiSettings(app, { section: 'ensemble' }); return; }
  if (pick.value !== 'single' && Object.keys(aiSettings().providers).length < 2) {
    toast('Set up at least two AI providers to use several AIs.', { action: 'Set Up AI', onAction: () => app.exec('ai.setup'), ms: 7000 });
    return;
  }
  saveAiSettings((s) => { s.ensemble.mode = pick.value; });
  if (pick.value !== 'single' && (aiSettings().ensemble.members?.length || 0) < 2) await openAiSettings(app, { section: 'ensemble', mode: pick.value });
  app.ui.refresh?.();
  toast(pick.value === 'single' ? 'AI: one AI answers (the active provider)' : `AI: ${pick.label}`);
}

// ------------------------------------------------------------------------------------------
// Commands

const W = 'AI';
const page = (app: App) => isPage(app);
const text = (app: App) => isText(app);

def([
  {
    id: 'ai.setup', label: 'Set Up AI', icon: 'auto_awesome', tab: W, group: 'Setup', popular: true, noRecord: true, edits: false,
    tip: 'Choose a free or paid AI: on this device, free cloud tiers, your own computer, or a paid key', keywords: 'api key openai anthropic gemini mistral groq openrouter ollama wizard',
    run: async (app) => { const { openAiSetup } = await import('../ui/aiWizard'); await openAiSetup(app); },
  },
  { id: 'ai.providers', label: 'Providers & Models', icon: 'tune', tab: W, group: 'Setup', noRecord: true, edits: false, tip: 'Switch AI provider, choose models, test or remove keys', run: async (app) => { const { openAiProviders } = await import('../ui/aiWizard'); await openAiProviders(app); } },
  {
    id: 'ai.active', label: 'Active AI', icon: 'swap_horiz', tab: W, group: 'Setup', kind: 'menu', noRecord: true, edits: false, tip: 'Switch between the AI providers you have set up',
    run: async (app, id?: string) => {
      if (!id) { const { openAiProviders } = await import('../ui/aiWizard'); await openAiProviders(app); return; }
      if (!aiSettings().providers[id]) return;
      saveAiSettings((s) => { s.active = id; });
      toast(`AI: ${providerById(id)?.name}`);
    },
    menu: () => { const s = aiSettings(); const items: MenuEntry[] = Object.keys(s.providers).map((id) => ({ id: 'ai.active', arg: id, label: `${providerById(id)?.name || id} · ${s.providers[id].model}`, checked: s.active === id })); return [...items, ...(items.length ? [{ separator: true }] : []), { id: 'ai.setup', label: 'Add a Provider…' }]; },
  },
  { id: 'ai.settings', label: 'AI Settings', icon: 'settings_suggest', tab: W, group: 'Setup', noRecord: true, edits: false, tip: 'Turn AI on or off, language for generated text, style guide, usage', run: async (app) => { const { openAiSettings } = await import('../ui/aiWizard'); await openAiSettings(app); } },
  {
    id: 'ai.privacy', label: 'AI & Privacy', icon: 'shield', tab: W, group: 'Setup', noRecord: true, edits: false, tip: 'Where your page text and code go when you use AI',
    run: async () => {
      const p = providerById(aiSettings().active || '');
      await openDialog({ title: 'AI & Privacy', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: [
        '<p><b>Anne\'s Loom has no server.</b> AI requests go directly from this device to the provider you choose, using your own key. Nothing is sent until you run an AI command.</p>',
        `<p><b>Active provider:</b> ${p ? esc(p.name) : 'none'}${p && (p.kind === 'local' || p.kind === 'builtin') ? ' — runs on this device; your site does not leave it.' : p ? ' — the page text and code a command needs (the selection, the page, or the pages involved in a site-wide command) are sent to this service; its terms apply.' : ''}</p>`,
        activeEnsemble() ? `<p><b>Several AIs are on.</b> Each AI command sends the same text to every one of these services: ${esc(names(aiRecipients()))}.</p>` : '',
        '<p><b>Pictures</b> are sent only by Generate from Sketch (the picture you choose) and Alt Text (the site\'s pictures that need alt text, and only when the AI can read pictures).</p>',
        '<p><b>Web addresses:</b> Layout from Example reads the page you name and sends only an outline of its structure (tags and class names), never its text or pictures.</p>',
        '<p><b>Keys</b> are stored on this device only. They are never placed in sites, drafts or exported settings.</p>',
        '<p><b>Changes are previewed</b> and applied as one step you can undo. Generated pages run no scripts in Design view or in previews.</p>',
      ].join('') }] });
    },
  },
  { id: 'ai.stop', label: 'Stop AI', icon: 'stop_circle', tab: W, group: 'Setup', noRecord: true, edits: false, isEnabled: () => !!controller, tip: 'Stop the AI request in progress', run: () => stopAi() },
  {
    id: 'ai.deleteModels', label: 'Delete Downloaded Models', icon: 'delete_sweep', tab: W, group: 'Setup', noRecord: true, edits: false, tip: 'Free the storage used by the on-device AI model',
    run: async () => { const { clearLocalModels, localStorageEstimate } = await import('../ai/local'); if (!(await confirmDialog('Delete Downloaded Models', `Delete the on-device AI model files? (${await localStorageEstimate()}). They download again the next time you use the on-device model.`, 'Delete'))) return; const n = await clearLocalModels(); toast(`Deleted ${n} cached file(s).`); },
  },
  {
    id: 'ai.ensembleMode', label: 'Several AIs', icon: 'groups', tab: W, group: 'Several AIs', kind: 'menu', edits: false,
    tip: 'Ask one AI, or several at once: one AI combines their answers (master), or they deliberate until they agree (Quaker consensus)',
    run: (app, mode?: string) => setEnsembleMode(app, mode),
    menu: () => { const e = aiSettings().ensemble; return [...ENSEMBLE_MODES.map((o) => ({ id: 'ai.ensembleMode', arg: o.value, label: o.label, checked: e.mode === o.value })), { separator: true }, { id: 'ai.ensembleMembers', label: 'Choose AIs…' }, { id: 'ai.showDeliberation', label: 'Show AI Discussion', checked: e.showDeliberation }]; },
    isActive: () => aiSettings().ensemble.mode !== 'single',
  },
  { id: 'ai.ensembleMembers', label: 'Choose AIs', icon: 'checklist', tab: W, group: 'Several AIs', noRecord: true, edits: false, tip: 'Choose which AIs answer together, the master or clerk, and the rounds of discussion', run: async (app) => { const { openAiSettings } = await import('../ui/aiWizard'); await openAiSettings(app, { section: 'ensemble' }); } },
  { id: 'ai.showDeliberation', label: 'Show AI Discussion', icon: 'forum', tab: W, group: 'Several AIs', kind: 'toggle', edits: false, tip: 'Show the outcome of the discussion when several AIs answer', run: (app, on?: boolean) => { saveAiSettings((s) => { s.ensemble.showDeliberation = typeof on === 'boolean' ? on : !s.ensemble.showDeliberation; }); app.ui.refresh?.(); }, isActive: () => aiSettings().ensemble.showDeliberation },

  // Create
  { id: 'ai.generatePage', label: 'Generate Page', icon: 'auto_awesome', tab: W, group: 'Create', edits: false, popular: true, origin: 'modern site builders', tip: 'Describe a page (purpose, audience, style, sections, framework); preview it, then add it to the site', keywords: 'create page ai builder', run: (app) => generatePage(app) },
  { id: 'ai.generateSite', label: 'Generate Site', icon: 'web_stories', tab: W, group: 'Create', edits: false, origin: 'modern site builders', tip: 'Plan a site, review the plan, then write every page with a shared style sheet and navigation', run: (app) => generateSite(app) },
  { id: 'ai.generateSection', label: 'Generate Section', icon: 'view_agenda', tab: W, group: 'Create', edits: true, isEnabled: page, origin: 'modern site builders', tip: 'Insert a hero, features, pricing, FAQ, contact or other section at the cursor', run: (app, kind?: string) => generateSection(app, typeof kind === 'string' ? kind : undefined) },
  { id: 'ai.generateFromSketch', label: 'Page from Sketch', icon: 'draw', tab: W, group: 'Create', edits: false, origin: 'sketch-to-code tools', tip: 'Turn a photo of a sketch, a wireframe or a screenshot into a page (needs an AI that reads pictures)', run: (app) => generateFromSketch(app) },
  { id: 'ai.cloneLayout', label: 'Layout from Example', icon: 'dashboard_customize', tab: W, group: 'Create', edits: false, tip: 'Describe a layout or name a page that has it; get an original page with that arrangement (no text or pictures are copied)', run: (app) => cloneLayout(app) },
  { id: 'ai.generateImage', label: 'Generate Illustration', icon: 'brush', tab: W, group: 'Create', edits: false, tip: 'Draw an original SVG illustration (chat AIs cannot make photos) and insert it', keywords: 'image picture svg drawing', run: (app) => generateImage(app) },
  { id: 'ai.placeholderContent', label: 'Placeholder Content', icon: 'notes', tab: W, group: 'Create', edits: true, isEnabled: page, origin: 'Lorem ipsum generators', tip: 'Realistic placeholder text, lists or tables about the page topic (instead of lorem ipsum)', run: (app) => placeholderContent(app) },

  // Write
  { id: 'ai.writeCopy', label: 'Write Copy', icon: 'edit_note', tab: W, group: 'Write', edits: true, isEnabled: page, tip: 'Write a section of web copy at the cursor', run: (app) => writeCopy(app) },
  ...(['rewrite', 'shorten', 'expand', 'tone', 'proofread', 'translate'] as const).map((k) => ({
    id: `ai.${k}`, label: TEXT_TASKS[k].label, icon: ({ rewrite: 'auto_fix_high', shorten: 'compress', expand: 'expand', tone: 'theater_comedy', proofread: 'spellcheck', translate: 'g_translate' } as Record<string, string>)[k],
    tab: W, group: 'Write', edits: true, isEnabled: text,
    tip: `${TEXT_TASKS[k].label} the selected text in Design or Code view (or the paragraph at the cursor), keeping its links and formatting`,
    run: (app: App, arg?: string) => textTask(app, k, typeof arg === 'string' ? arg : undefined),
  })),
  { id: 'ai.translateSite', label: 'Translate Site', icon: 'translate', tab: W, group: 'Write', edits: false, tip: 'Make translated copies of pages in a language folder, linked with hreflang tags', run: (app) => translateSite(app) },
  { id: 'ai.headline', label: 'Suggest Headline', icon: 'title', tab: W, group: 'Write', edits: true, isEnabled: page, tip: 'Headline ideas for the selection or the page; pick one to insert or replace the selection', run: (app) => headline(app) },
  { id: 'ai.callToAction', label: 'Call to Action', icon: 'ads_click', tab: W, group: 'Write', edits: true, isEnabled: page, tip: 'Write a call-to-action block from the page content', run: (app) => callToAction(app) },

  // Code
  { id: 'ai.explainCode', label: 'Explain Code', icon: 'help_center', tab: W, group: 'Code', edits: false, isEnabled: text, tip: 'Explain the selected code or the file in the AI Assistant pane', run: (app) => analysisTask(app, 'explainCode') },
  { id: 'ai.fixCode', label: 'Fix Code', icon: 'build', tab: W, group: 'Code', edits: true, isEnabled: text, tip: 'Find and fix markup, CSS and script errors in the selection or file; review the changes before applying', run: (app) => codeTask(app, 'fixCode') },
  { id: 'ai.refactor', label: 'Refactor Code', icon: 'construction', tab: W, group: 'Code', edits: true, isEnabled: text, tip: 'Clean up the selection or file without changing what it does', run: (app, arg?: string) => codeTask(app, 'refactor', typeof arg === 'string' ? arg : undefined) },
  { id: 'ai.generateCss', label: 'Generate CSS', icon: 'css', tab: W, group: 'Code', edits: true, isEnabled: text, tip: 'Describe styling for the selected element or the page; add it to the page or a style sheet', run: (app) => generateCss(app) },
  { id: 'ai.generateJs', label: 'Generate JavaScript', icon: 'javascript', tab: W, group: 'Code', edits: true, isEnabled: page, tip: 'Describe a behavior; get a script linked from the page or placed in it', run: (app) => generateJs(app) },
  { id: 'ai.makeResponsive', label: 'Make Responsive', icon: 'devices', tab: W, group: 'Code', edits: true, isEnabled: text, tip: 'Make the page (or selection) work on phones, tablets and desktops', run: (app) => codeTask(app, 'makeResponsive') },
  { id: 'ai.convertFramework', label: 'Convert Framework', icon: 'swap_vert', tab: W, group: 'Code', edits: true, isEnabled: text, tip: 'Convert the page to Bootstrap, Tailwind CSS or plain CSS', run: (app, arg?: string) => codeTask(app, 'convertFramework', typeof arg === 'string' ? arg : undefined) },
  { id: 'ai.commentCode', label: 'Comment Code', icon: 'comment', tab: W, group: 'Code', edits: true, isEnabled: text, tip: 'Add explanatory comments to the selection or file', run: (app) => codeTask(app, 'commentCode') },
  { id: 'ai.modernize', label: 'Modernize Markup', icon: 'upgrade', tab: W, group: 'Code', edits: true, isEnabled: text, origin: 'Expression Web (CSS conversion), Dreamweaver (Convert to HTML5)', tip: 'Replace layout tables, font tags and presentational attributes with semantic HTML5 and CSS', run: (app) => codeTask(app, 'modernize') },

  // Optimize
  { id: 'ai.seo', label: 'SEO Suggestions', icon: 'travel_explore', tab: W, group: 'Optimize', edits: true, isEnabled: page, origin: 'Expression Web (SEO report)', tip: 'Suggested title, description and headings; apply the title and meta tags', run: (app) => seo(app) },
  { id: 'ai.metaTags', label: 'Meta Tags', icon: 'sell', tab: W, group: 'Optimize', edits: true, isEnabled: page, tip: 'Write description, robots, Open Graph and card meta tags', run: (app) => metaTags(app) },
  { id: 'ai.altText', label: 'Alt Text', icon: 'image_search', tab: W, group: 'Optimize', edits: true, isEnabled: page, tip: 'Describe the selected picture, or every picture on the page without alt text (the picture is sent when the AI can read pictures)', run: (app) => altText(app) },
  { id: 'ai.altTextSite', label: 'Alt Text for Site', icon: 'imagesmode', tab: W, group: 'Optimize', edits: false, tip: 'Write alt text for every picture in the site that has none', run: (app) => altTextSite(app) },
  { id: 'ai.accessibilityFix', label: 'Fix Accessibility', icon: 'accessibility_new', tab: W, group: 'Optimize', edits: true, isEnabled: text, origin: 'FrontPage, Expression Web (accessibility checker)', tip: 'Fix accessibility problems in the page or selection; review the changes first', run: (app) => codeTask(app, 'accessibilityFix') },
  { id: 'ai.performance', label: 'Performance Advice', icon: 'speed', tab: W, group: 'Optimize', edits: false, isEnabled: text, tip: 'Page-load advice for the page, shown in the AI Assistant pane', run: (app) => analysisTask(app, 'performance') },
  { id: 'ai.schema', label: 'Structured Data', icon: 'data_object', tab: W, group: 'Optimize', edits: true, isEnabled: page, tip: 'Add schema.org JSON-LD for the page type', keywords: 'json-ld schema rich results', run: (app) => schema(app) },
  { id: 'ai.reviewPage', label: 'Review Page', icon: 'rate_review', tab: W, group: 'Optimize', edits: false, isEnabled: page, tip: 'A design and content critique of the page in the AI Assistant pane', run: (app) => analysisTask(app, 'reviewPage') },

  // Content
  { id: 'ai.summarize', label: 'Summarize Page', icon: 'summarize', tab: W, group: 'Content', edits: false, isEnabled: page, tip: 'Summarize the page in the AI Assistant pane (insert it from there)', run: (app) => analysisTask(app, 'summarize') },
  { id: 'ai.faq', label: 'FAQ', icon: 'quiz', tab: W, group: 'Content', edits: true, isEnabled: page, tip: 'Questions and answers from the page content or a topic, as an FAQ section', run: (app) => faq(app) },
  { id: 'ai.blogPost', label: 'Blog Post', icon: 'article', tab: W, group: 'Content', edits: false, tip: 'Write a blog post as a new page or at the cursor', run: (app) => blogPost(app) },
  { id: 'ai.productCopy', label: 'Product Description', icon: 'storefront', tab: W, group: 'Content', edits: true, isEnabled: page, tip: 'Product or service copy from your list of features', run: (app) => productCopy(app) },
  { id: 'ai.privacyPolicy', label: 'Privacy Policy', icon: 'policy', tab: W, group: 'Content', edits: false, tip: 'A privacy policy page template from what your site collects (not legal advice)', run: (app) => legalPage(app, 'privacy') },
  { id: 'ai.terms', label: 'Terms of Use', icon: 'gavel', tab: W, group: 'Content', edits: false, tip: 'A terms of use page template (not legal advice)', run: (app) => legalPage(app, 'terms') },
  { id: 'ai.errorPage', label: '404 Page', icon: 'error', tab: W, group: 'Content', edits: false, tip: 'A friendly "page not found" page with root-relative links', run: (app) => errorPage(app) },

  // More
  { id: 'ai.assistant', label: 'AI Assistant', icon: 'chat', tab: W, group: 'More', edits: false, noRecord: true, popular: true, tip: 'Chat about the page or site; insert, replace or apply answers', run: (app) => app.ui.togglePane('ai') },
  {
    id: 'ai.prompts', label: 'Prompt Library', icon: 'library_books', tab: W, group: 'More', kind: 'menu', edits: false,
    tip: 'Run your saved prompts on the selection, the page or the site',
    run: async (app, id?: string) => {
      if (id === '__new') { await editPrompt(); return; }
      const p = aiSettings().prompts.find((x) => x.id === id);
      if (!p) { await managePrompts(app); return; }
      await runPrompt(app, p);
    },
    menu: () => [...aiSettings().prompts.map((p) => ({ id: 'ai.prompts', arg: p.id, label: p.name })), ...(aiSettings().prompts.length ? [{ separator: true }] : []), { id: 'ai.prompts', arg: '__new', label: 'New Prompt…' }, { id: 'ai.prompts', arg: '__manage', label: 'Manage Prompts…' }],
  },
]);
