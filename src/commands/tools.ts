/**
 * Tools: checking (HTML validation, XML well-formedness, accessibility, compatibility, SEO, performance),
 * proofing (spelling, thesaurus, language, dictionary, word count), comparison, side-by-side preview,
 * the script console, and small helpers (color picker, placeholder text, calculator, editor options).
 * The clean-up and conversion commands are in toolsCleanup.ts.
 */
import { def } from './registry';
import type { App, PageTab } from '../app';
import { openDialog, toast, alertDialog, confirmDialog, setListOptions } from '../ui/dialog';
import { h, icon, clear } from '../ui/dom';
import { insertHtml, isPage, isText, selectionText, selectedEl, mutate, setAttr, view } from '../editor/ops';
import { cacheFor, PAGE_SIZES } from '../editor/workspace';
import { previewDocument } from '../editor/resources';
import { validateHtml, validateXml, fromNuJson, parseHtml, byName, textOf, decodeHtml, type Issue } from '../check/validate';
import { checkAccessibility } from '../check/accessibility';
import { checkCompat } from '../check/compat';
import { seoCheck, siteSeoDuplicates, performanceCheck, fmtBytes } from '../check/seo';
import { diffLines, diffStats } from '../check/cleanup';
import { parseColor, rgbToHsl, toHexColor } from '../check/accessibility';
import { showReport, getReport, type CheckReport } from '../ui/panesCheck';
import { pageWords, workerChecker, replaceWord, isEnglish, escText, offlineSynonyms, type SpellWord } from '../proof/spelling';
import { resolveRef, isPagePath, isTextPath } from '../model/paths';
import { setHtmlAttr, getLang, linkedStyles, linkedScripts, DOCTYPES, htmlToText, esc } from '../model/html';
import { desktopFolders } from '../platform/native';

// --------------------------------------------------------------------------------------------
// Shared helpers

type Scope = 'page' | 'site';
const scopeOf = (arg: any): Scope => (arg === 'site' || arg?.scope === 'site' ? 'site' : 'page');

/** The pages a check covers: the active page, or every page in the site. */
function sources(app: App, scope: Scope, filter: (p: string) => boolean = isPagePath): { path: string; src: string }[] {
  app.active?.ui.flush();
  if (scope === 'page') {
    const t = app.active;
    if (!t || !filter(t.path)) return [];
    return [{ path: t.path, src: t.source }];
  }
  return app.site.list((f) => filter(f.path) && f.text != null).map((f) => ({ path: f.path, src: f.text! }));
}

function needPage(app: App, scope: Scope): boolean {
  if (scope === 'page' && !isPage(app)) { toast('Open a page first, or check the whole site.'); return false; }
  return true;
}

/** Edits a site file: through its tab (one undo step) when it is open, else directly. */
export function editFile(app: App, path: string, label: string, fn: (src: string) => string): boolean {
  const tab = app.docs.find((d) => d.path === path);
  if (tab) return app.editSource(label, fn, tab);
  const src = app.site.read(path);
  if (src == null) return false;
  const out = fn(src);
  if (out === src) return false;
  app.site.write(path, out);
  return true;
}

const withPath = (path: string, items: Issue[]) => items.map((i) => ({ ...i, path }));

// --------------------------------------------------------------------------------------------
// Validation

function runValidate(app: App, scope: Scope): void {
  if (!needPage(app, scope)) return;
  const pages = sources(app, scope);
  const items: Issue[] = [];
  for (const p of pages) items.push(...withPath(p.path, validateHtml(p.src, { fragment: /\.lbi$/i.test(p.path) })));
  const errors = items.filter((i) => i.severity === 'error').length;
  showReport(app, 'validation', {
    title: 'HTML validation', scope, items, when: Date.now(),
    summary: `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} checked: ${errors ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : 'no errors'}.`,
    rerun: runValidate,
    actions: [{ label: 'W3C', icon: 'public', title: 'Check the current page with the W3C Nu Html Checker (online)', run: (a) => void validateOnline(a) }],
    note: 'Checked against HTML5 (or XHTML when the page has an XHTML doctype). Click a finding to go to its line in Code view.',
  });
}

async function validateOnline(app: App): Promise<void> {
  const t = app.page;
  if (!t) { toast('Open a page first.'); return; }
  const ok = await confirmDialog('Check with the W3C Service', 'The source of this page will be sent to validator.w3.org, the W3C Nu Html Checker, and checked there.\nDo not send pages that hold private information. Nothing else leaves this device.', 'Send and Check');
  if (!ok) return;
  t.ui.flush();
  toast('Checking with the W3C service…');
  try {
    const res = await fetch('https://validator.w3.org/nu/?out=json', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: t.source });
    if (!res.ok) throw new Error(`The service answered ${res.status}.`);
    const items = withPath(t.path, fromNuJson(await res.json()));
    const prev = getReport('validation');
    showReport(app, 'validation', { ...(prev || { rerun: runValidate, actions: [] }), title: 'W3C Nu Html Checker', scope: 'page', items, when: Date.now(), summary: `${items.filter((i) => i.severity === 'error').length} errors from validator.w3.org.`, note: 'Results from the W3C Nu Html Checker (validator.w3.org).' } as CheckReport);
  } catch (e) {
    toast(`Could not reach the W3C service: ${(e as Error).message || e}`, { ms: 6000 });
  }
}

function runValidateXml(app: App, scope: Scope): void {
  const isXml = (p: string) => /\.(xml|svg|xhtml|xht|rss|atom|xsl|xslt|kml|gpx|plist|config|resx|xaml|dwt)$/i.test(p) || (isPagePath(p) && /^\s*<\?xml/.test(app.site.read(p) || ''));
  const pages = sources(app, scope, scope === 'page' ? (p) => isTextPath(p) || isPagePath(p) : isXml);
  if (!pages.length) { toast(scope === 'page' ? 'Open a file first.' : 'The site has no XML files.'); return; }
  const items: Issue[] = [];
  for (const p of pages) items.push(...withPath(p.path, validateXml(p.src)));
  showReport(app, 'validation', {
    title: 'XML well-formedness', scope, items, when: Date.now(),
    summary: `${pages.length} ${pages.length === 1 ? 'file' : 'files'} checked as XML: ${items.length ? `${items.length} problems` : 'well-formed'}.`,
    rerun: runValidateXml,
  });
}

// --------------------------------------------------------------------------------------------
// Accessibility, compatibility, SEO, performance

function runAccessibility(app: App, scope: Scope): void {
  if (!needPage(app, scope)) return;
  const items: Issue[] = [];
  const pages = sources(app, scope).filter((p) => !/\.lbi$/i.test(p.path));
  for (const p of pages) items.push(...withPath(p.path, checkAccessibility(p.src)));
  showReport(app, 'accessibility', {
    title: 'Accessibility (WCAG 2.2)', scope, items, when: Date.now(), rerun: runAccessibility,
    summary: `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} checked against WCAG 2.2 levels A and AA.`,
    note: 'Automatic checks find only some barriers. Also try the page with the keyboard alone, at 200% zoom and with a screen reader.',
  });
}

function linkedFiles(app: App, pages: { path: string; src: string }[]): { path: string; text: string }[] {
  const seen = new Set<string>();
  const out: { path: string; text: string }[] = [];
  for (const p of pages) for (const ref of [...linkedStyles(p.src), ...linkedScripts(p.src)]) {
    const r = resolveRef(p.path, ref);
    if (r && !seen.has(r) && app.site.has(r)) { seen.add(r); out.push({ path: r, text: app.site.read(r) || '' }); }
  }
  return out;
}

function runCompat(app: App, scope: Scope, modern = false): void {
  if (!needPage(app, scope)) return;
  const pages = sources(app, scope);
  const items: Issue[] = [];
  for (const p of pages) items.push(...withPath(p.path, checkCompat(p.src, { modern })));
  for (const i of checkCompat('<!DOCTYPE html><title>x</title>', { modern, files: linkedFiles(app, pages) })) items.push(i);
  items.sort((a, b) => (a.path || '').localeCompare(b.path || '') || a.line - b.line);
  showReport(app, 'compatibility', {
    title: modern ? 'Browser compatibility (with newer features)' : 'Compatibility', scope, items, when: Date.now(),
    rerun: (a, s) => runCompat(a, s, modern),
    summary: `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} and their linked style sheets and scripts checked.`,
    note: modern ? 'Newer features are listed with the year they reached every major browser (Chrome, Edge, Firefox, Safari).' : 'Use Browser Compatibility to also list newer features that older browsers lack.',
  });
}

function runSeo(app: App, scope: Scope): void {
  if (!needPage(app, scope)) return;
  const pages = sources(app, scope).filter((p) => !/\.(lbi|dwt)$/i.test(p.path));
  const items: Issue[] = [];
  for (const p of pages) items.push(...withPath(p.path, seoCheck(p.src, { path: p.path })));
  if (scope === 'site') items.push(...siteSeoDuplicates(pages));
  items.sort((a, b) => (a.path || '').localeCompare(b.path || '') || a.line - b.line);
  showReport(app, 'pageReport', { title: 'Search engine optimization', scope, items, when: Date.now(), rerun: runSeo, summary: `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} checked.`, actions: [{ label: 'Speed', icon: 'speed', title: 'Performance report', run: (a) => runPerformance(a, scope) }] });
}

function runPerformance(app: App, scope: Scope): void {
  if (!needPage(app, scope)) return;
  const pages = sources(app, scope).filter((p) => !/\.(lbi|dwt)$/i.test(p.path));
  const items: Issue[] = [];
  let heaviest = { path: '', bytes: 0 };
  let total = 0;
  for (const p of pages) {
    const r = performanceCheck(p.src, { resolve: (ref) => { const x = resolveRef(p.path, ref); return x && app.site.has(x) ? x : null; }, bytes: (path) => app.site.bytes(path) });
    items.push(...withPath(p.path, r.issues));
    total += r.totalBytes;
    if (r.totalBytes > heaviest.bytes) heaviest = { path: p.path, bytes: r.totalBytes };
  }
  showReport(app, 'pageReport', {
    title: 'Performance', scope, items, when: Date.now(), rerun: runPerformance,
    summary: scope === 'site' ? `${pages.length} pages; average weight ${fmtBytes(Math.round(total / Math.max(1, pages.length)))}; heaviest ${heaviest.path} (${fmtBytes(heaviest.bytes)}).` : items.find((i) => i.rule === 'weight')?.message,
    actions: [{ label: 'SEO', icon: 'travel_explore', title: 'Search engine report', run: (a) => runSeo(a, scope) }],
    note: 'Sizes are of the files in the site, before the server compresses them. Resources on other servers are not counted.',
  });
}

// --------------------------------------------------------------------------------------------
// Spelling

function contextOf(src: string, w: SpellWord): { before: string; after: string } {
  const clean = (s: string) => decodeHtml(s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
  const a = Math.max(0, w.start - 300);
  let before = clean(src.slice(a, w.start).replace(/^[^<]*>/, ''));
  let after = clean(src.slice(w.end, w.end + 300).replace(/<[^>]*$/, ''));
  before = before.length > 70 ? '…' + before.slice(-70) : before;
  after = after.length > 70 ? after.slice(0, 70) + '…' : after;
  return { before, after };
}

/** Shows a word in the open views: selects it in Code view, or finds it in Design view. */
function revealWord(tab: PageTab, w: SpellWord, nth: number): void {
  const v = tab.ui;
  try {
    if (v.code && (tab.view === 'code' || tab.view === 'split')) v.code.select(w.start, w.end);
    const doc = v.design?.doc;
    if (doc && (tab.view === 'design' || tab.view === 'split')) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let seen = 0;
      const re = new RegExp(`(^|[^\\p{L}\\p{M}'’])(${w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\p{M}])`, 'gu');
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.nodeValue || '';
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(t))) {
          if (seen++ === nth) {
            const r = doc.createRange();
            const at = m.index + m[1].length;
            r.setStart(n, at); r.setEnd(n, at + w.word.length);
            const sel = doc.getSelection();
            sel?.removeAllRanges(); sel?.addRange(r);
            (n.parentElement as HTMLElement | null)?.scrollIntoView({ block: 'center' });
            return;
          }
        }
      }
    }
  } catch { /* the views may be reloading */ }
}

async function runSpelling(app: App, scope: Scope): Promise<void> {
  if (scope === 'page' && !isPage(app)) { toast('Open a page first.'); return; }
  app.active?.ui.flush();
  const start = app.active?.path;
  const all = app.site.pages().map((p) => p.path).filter((p) => !/\.lbi$/i.test(p) || p === start);
  const paths = scope === 'page' ? [start!] : start && all.includes(start) ? [...all.slice(all.indexOf(start)), ...all.slice(0, all.indexOf(start))] : all;
  const checker = workerChecker(app.prefs.dictionary);
  const ignored = new Set([...app.prefs.ignoredWords, ...app.prefs.dictionary].map((w) => w.toLowerCase()));
  const changeAll = new Map<string, string>();
  const bad = new Map<string, boolean>();
  let pi = 0, cursor = 0, changes = 0;
  let current: { path: string; w: SpellWord; nth: number } | null = null;

  const apply = (path: string, w: SpellWord, rep: string): boolean => {
    let ok = false;
    editFile(app, path, 'Spelling', (src) => { const out = replaceWord(src, w, rep); ok = out != null; return out ?? src; });
    if (ok) changes++;
    return ok;
  };
  const next = async (): Promise<typeof current> => {
    while (pi < paths.length) {
      const path = paths[pi];
      scan: for (;;) {
        const src = app.site.read(path) ?? '';
        const words = pageWords(src);
        const unknown = [...new Set(words.map((w) => w.word))].filter((w) => !bad.has(w));
        if (unknown.length) { const b = await checker.check(unknown); for (const u of unknown) bad.set(u, b.has(u)); }
        const counts = new Map<string, number>();
        for (const w of words) {
          const nth = counts.get(w.word) || 0;
          counts.set(w.word, nth + 1);
          if (w.start < cursor || !bad.get(w.word) || ignored.has(w.word.toLowerCase()) || !isEnglish(w.lang)) continue;
          const rep = changeAll.get(w.word);
          if (rep != null) { if (apply(path, w, rep)) { cursor = w.start + escText(rep).length; continue scan; } continue; }
          return { path, w, nth };
        }
        break;
      }
      pi++; cursor = 0;
    }
    return null;
  };

  try {
    toast('Checking spelling…', { ms: 1500 });
    current = await next();
  } catch (e) { toast((e as Error).message); return; }
  if (!current) { toast(changes ? `Spelling check complete: ${changes} ${changes === 1 ? 'change' : 'changes'}.` : 'No spelling errors found.'); return; }

  const ctxEl = h('div', { class: 'ql-spell-context', 'aria-live': 'polite' });
  const fileEl = h('div', { class: 'ql-help' });
  const input = h('input', { type: 'text', 'aria-label': 'Change to', style: 'width:100%' }) as HTMLInputElement;
  const list = h('select', { size: '6', class: 'ql-listbox', 'aria-label': 'Suggestions', style: 'width:100%' }) as HTMLSelectElement;
  list.addEventListener('change', () => { input.value = list.value; });
  const buttons: HTMLButtonElement[] = [];
  const btn = (label: string, fn: () => void | Promise<void>, primary = false) => { const b = h('button', { class: 'ql-btn' + (primary ? ' ql-primary' : ''), type: 'button', onclick: () => void step(fn) }, label) as HTMLButtonElement; buttons.push(b); return b; };
  let close: () => void = () => void 0;
  const content = h('div', { style: 'display:flex;flex-direction:column;gap:8px;min-width:min(480px,80vw)' },
    fileEl,
    h('div', { class: 'ql-label' }, 'Not in dictionary:'), ctxEl,
    h('label', { class: 'ql-label' }, 'Change to:'), input,
    h('div', { class: 'ql-label' }, 'Suggestions:'), list,
    h('div', { class: 'ql-spell-buttons' },
      btn('Ignore Once', () => { cursor = current!.w.end; }),
      btn('Ignore All', () => { ignored.add(current!.w.word.toLowerCase()); if (!app.prefs.ignoredWords.includes(current!.w.word)) { app.prefs.ignoredWords.push(current!.w.word); app.savePrefs(); } }),
      btn('Add to Dictionary', async () => { const w = current!.w.word; if (!app.prefs.dictionary.includes(w)) { app.prefs.dictionary.push(w); app.savePrefs(); } ignored.add(w.toLowerCase()); await checker.add(w); }),
      btn('Change', () => { const rep = input.value; if (!rep.trim()) return; cursor = current!.w.start + escText(rep).length; if (!apply(current!.path, current!.w, rep)) cursor = current!.w.end; }, true),
      btn('Change All', () => { const rep = input.value; if (!rep.trim()) return; changeAll.set(current!.w.word, rep); cursor = current!.w.start + escText(rep).length; if (!apply(current!.path, current!.w, rep)) cursor = current!.w.end; }),
      btn('Delete Word', () => { cursor = current!.w.start; editFile(app, current!.path, 'Spelling', (src) => { const s2 = replaceWord(src, current!.w, ''); return s2 == null ? src : s2.slice(0, current!.w.start).replace(/[ \t]+$/, ' ') + s2.slice(current!.w.start).replace(/^[ \t]+/, ''); }); changes++; })));

  const show = async () => {
    const c = current!;
    const tab = app.docs.find((d) => d.path === c.path) || app.openFile(c.path);
    if (app.active !== tab) app.activate(tab);
    const src = app.site.read(c.path) || '';
    const { before, after } = contextOf(src, c.w);
    clear(ctxEl);
    ctxEl.append(before, h('mark', null, c.w.word), after);
    fileEl.textContent = scope === 'site' ? `Page ${pi + 1} of ${paths.length}: ${c.path}` : c.path;
    clear(list);
    input.value = c.w.word;
    list.appendChild(h('option', { value: '', disabled: true }, 'Looking up suggestions…'));
    revealWord(tab, c.w, c.nth);
    const sugg = await checker.suggest(c.w.word);
    if (current !== c) return;
    clear(list);
    if (!sugg.length) list.appendChild(h('option', { value: '', disabled: true }, '(no suggestions)'));
    for (const s of sugg) list.appendChild(h('option', { value: s }, s));
    if (sugg[0]) { input.value = sugg[0]; list.selectedIndex = 0; }
    input.focus(); input.select();
  };
  const step = async (fn: () => void | Promise<void>) => {
    for (const b of buttons) b.disabled = true;
    try {
      await fn();
      current = await next();
      if (!current) { close(); toast(`Spelling check complete${changes ? `: ${changes} ${changes === 1 ? 'change' : 'changes'}` : ''}.`); return; }
      await show();
    } catch (e) { toast((e as Error).message || String(e)); }
    finally { for (const b of buttons) b.disabled = false; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); buttons[3].click(); } });
  const done = openDialog({ title: scope === 'site' ? 'Spelling (Whole Site)' : 'Spelling', content, ok: false, cancel: 'Close', onOpen: (ctl) => { close = () => ctl.close(); } });
  await show();
  await done;
}

// --------------------------------------------------------------------------------------------
// Thesaurus, language, dictionary, word count

const ONLINE_KEY = 'quillloom.thesaurus.online';
const getOnline = () => { try { return localStorage.getItem(ONLINE_KEY) === '1'; } catch { return false; } };
const setOnline = (v: boolean) => { try { localStorage.setItem(ONLINE_KEY, v ? '1' : '0'); } catch { /* private window */ } };

async function synonyms(word: string, online: boolean): Promise<string[]> {
  const off = offlineSynonyms(word);
  if (!online) return off;
  try {
    const res = await fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(word)}&max=40`);
    let list: { word: string }[] = res.ok ? await res.json() : [];
    if (!list.length) { const r2 = await fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(word)}&max=30`); list = r2.ok ? await r2.json() : []; }
    return [...new Set([...off, ...list.map((x) => x.word)])];
  } catch { toast('The online thesaurus could not be reached; showing built-in words.'); return off; }
}

async function thesaurus(app: App): Promise<void> {
  const sel = selectionText(app).trim();
  const word = /^[\p{L}'’-]+$/u.test(sel) ? sel : sel.split(/\s+/)[0] || '';
  let results: string[] = [];
  const look = async (ctl: any, w: string, online: boolean) => {
    if (!w.trim()) return;
    setListOptions(ctl, 'list', [{ value: '', label: 'Looking up…' }]);
    results = await synonyms(w.trim(), online);
    setListOptions(ctl, 'list', results.length ? results : [{ value: '', label: 'No synonyms found.' }], results[0]);
    if (results[0]) ctl.set('replace', results[0]);
  };
  const r = await openDialog({
    title: 'Thesaurus', ok: sel ? 'Replace' : 'Insert',
    fields: [
      { key: 'word', label: 'Look up', type: 'text', value: word, autofocus: true },
      { key: 'go', label: 'Look Up', type: 'button', onClick: (v, ctl) => void look(ctl, v.word, v.online) },
      { key: 'list', label: 'Synonyms', type: 'list', rows: 9, options: [] },
      { key: 'replace', label: 'Replace with', type: 'text', value: '' },
      { key: 'online', label: 'Also ask the Datamuse online thesaurus (sends the word to api.datamuse.com)', type: 'checkbox', value: getOnline() },
    ],
    onOpen: (ctl) => { if (word) void look(ctl, word, getOnline()); },
    onChange: (v, ctl, key) => { if (key === 'list' && v.list) ctl.set('replace', v.list); if (key === 'online') { setOnline(!!v.online); void look(ctl, v.word, v.online); } },
  });
  if (!r || !r.replace?.trim()) return;
  insertHtml(app, esc(r.replace.trim()));
}

const LANGS: [string, string][] = [['en', 'English'], ['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['en-CA', 'English (Canada)'], ['en-AU', 'English (Australia)'], ['es', 'Spanish'], ['es-MX', 'Spanish (Mexico)'], ['fr', 'French'], ['fr-CA', 'French (Canada)'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['pt-BR', 'Portuguese (Brazil)'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['da', 'Danish'], ['nb', 'Norwegian Bokmål'], ['fi', 'Finnish'], ['pl', 'Polish'], ['cs', 'Czech'], ['hu', 'Hungarian'], ['ro', 'Romanian'], ['el', 'Greek'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['fa', 'Persian'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['id', 'Indonesian'], ['ms', 'Malay'], ['zh-Hans', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ca', 'Catalan'], ['eu', 'Basque'], ['gl', 'Galician'], ['ga', 'Irish'], ['cy', 'Welsh'], ['sw', 'Swahili'], ['af', 'Afrikaans'], ['tl', 'Filipino']];

async function setLanguage(app: App, arg?: any): Promise<void> {
  const tab = app.page;
  if (!tab) { toast('Open a page first.'); return; }
  const el = view(app)?.target === 'design' ? selectedEl(app) : null;
  const canEl = !!el && el.tagName !== 'BODY' && el.tagName !== 'HTML';
  let v = typeof arg === 'string' ? arg : arg?.lang;
  let target = arg?.target || 'page';
  if (v == null) {
    const cur = (canEl && el!.closest('[lang]')?.getAttribute('lang')) || getLang(tab.source) || app.prefs.language;
    const r = await openDialog({
      title: 'Set Language', help: 'The language tells browsers, screen readers, search engines and the spelling checker how to treat the text.',
      fields: [
        { key: 'lang', label: 'Language', type: 'combo', value: cur, options: LANGS.map(([c, n]) => ({ value: c, label: `${n} (${c})` })) },
        { key: 'target', label: 'Apply to', type: 'radio', value: canEl ? 'element' : 'page', options: [{ value: 'page', label: 'The whole page (<html lang>)' }, ...(canEl ? [{ value: 'element', label: `The selected <${el!.tagName.toLowerCase()}>` }] : [])] },
      ],
      validate: (x) => (/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(String(x.lang).trim()) ? null : 'Enter a language tag such as en, en-US or fr.'),
    });
    if (!r) return;
    v = String(r.lang).trim(); target = r.target;
  }
  if (target === 'element' && canEl) mutate(app, () => setAttr(app, el!, 'lang', v));
  else app.editSource('Set Language', (src) => setHtmlAttr(src, 'lang', v));
  toast(`Language set to ${v}.`);
}

async function manageDictionary(app: App): Promise<void> {
  const p = app.prefs;
  const words = () => [...p.dictionary].sort((a, b) => a.localeCompare(b));
  const ign = () => [...p.ignoredWords].sort((a, b) => a.localeCompare(b));
  const refresh = (ctl: any) => { setListOptions(ctl, 'words', words()); setListOptions(ctl, 'ignored', ign()); };
  await openDialog({
    title: 'Custom Dictionary', ok: 'Done', cancel: false,
    help: 'Words in your dictionary are never marked as misspelled, on any page or site.',
    fields: [
      { key: 'add', label: 'Word', type: 'text', placeholder: 'Type a word to add' },
      { key: 'addBtn', label: 'Add', type: 'button', onClick: (v, ctl) => { const w = String(v.add || '').trim(); if (!w || /\s/.test(w)) { toast('Enter a single word.'); return; } if (!p.dictionary.includes(w)) p.dictionary.push(w); app.savePrefs(); void workerChecker().add(w); ctl.set('add', ''); refresh(ctl); } },
      { key: 'words', label: 'Your dictionary', type: 'list', rows: 8, multiple: true, options: words() },
      { key: 'rm', label: 'Remove Selected', type: 'button', onClick: (v, ctl) => { const sel: string[] = v.words || []; p.dictionary = p.dictionary.filter((w) => !sel.includes(w)); app.savePrefs(); for (const w of sel) void workerChecker().remove(w); refresh(ctl); } },
      { key: 'ignored', label: 'Ignored words (Ignore All)', type: 'list', rows: 5, multiple: true, options: ign() },
      { key: 'rmIgn', label: 'Stop Ignoring Selected', type: 'button', onClick: (v, ctl) => { const sel: string[] = v.ignored || []; p.ignoredWords = p.ignoredWords.filter((w) => !sel.includes(w)); app.savePrefs(); refresh(ctl); } },
      { key: 'export', label: 'Copy All Words', type: 'button', onClick: () => { void navigator.clipboard?.writeText(words().join('\n')).then(() => toast('Words copied.')); } },
    ],
  });
}

function stats(html: string): Record<string, number> {
  const text = htmlToText(html);
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  const { root } = parseHtml(html);
  const body = byName(root, 'body')[0] || root;
  const btext = textOf(body);
  return {
    words,
    chars: btext.replace(/\s+/g, ' ').trim().length,
    charsNoSpaces: btext.replace(/\s/g, '').length,
    paragraphs: byName(root, 'p').filter((p) => textOf(p).trim()).length,
    sentences: (text.match(/[.!?]+(\s|$)/g) || []).length,
    headings: byName(root, 'h1', 'h2', 'h3', 'h4', 'h5', 'h6').length,
    links: byName(root, 'a').filter((a) => a.attrs.some((x) => x.name === 'href')).length,
    images: byName(root, 'img').length,
    tables: byName(root, 'table').length,
  };
}

async function wordCount(app: App, arg?: any): Promise<void> {
  if (!isPage(app) && scopeOf(arg) === 'page') { toast('Open a page first.'); return; }
  app.active?.ui.flush();
  const sel = selectionText(app);
  const page = isPage(app) ? stats(app.active.source) : null;
  const site = app.site.pages().reduce((acc, p) => { const s = stats(p.text || ''); for (const k in s) acc[k] = (acc[k] || 0) + s[k]; return acc; }, {} as Record<string, number>);
  const rows: [string, string][] = [['words', 'Words'], ['chars', 'Characters (with spaces)'], ['charsNoSpaces', 'Characters (no spaces)'], ['paragraphs', 'Paragraphs'], ['sentences', 'Sentences'], ['headings', 'Headings'], ['links', 'Links'], ['images', 'Pictures'], ['tables', 'Tables']];
  const table = h('table', { class: 'ql-stats' },
    h('tr', null, h('td', null, h('b', null, 'Statistic')), page ? h('td', null, h('b', null, 'This page')) : null, h('td', null, h('b', null, `Site (${app.site.pages().length} pages)`))),
    ...rows.map(([k, label]) => h('tr', null, h('td', null, label), page ? h('td', null, page[k].toLocaleString()) : null, h('td', null, (site[k] || 0).toLocaleString()))));
  const content = h('div', null, table,
    page ? h('p', { class: 'ql-help' }, `Reading time about ${Math.max(1, Math.round(page.words / 238))} min; speaking time about ${Math.max(1, Math.round(page.words / 140))} min.`) : null,
    sel.trim() ? h('p', { class: 'ql-help' }, `Selection: ${(sel.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length} words, ${sel.length} characters.`) : null);
  await alertDialog('Word Count', content);
}

// --------------------------------------------------------------------------------------------
// Side-by-side preview

function previewFrame(app: App, path: string, src: string, id: string): HTMLIFrameElement {
  const f = h('iframe', { sandbox: 'allow-scripts allow-forms', title: `Preview of ${path}`, style: 'border:0;background:#fff;transform-origin:0 0;display:block' }) as HTMLIFrameElement;
  const html = previewDocument(app.site, path, src, cacheFor(app));
  if (desktopFolders) void desktopFolders.setPreview({ id, html }).then((r) => { f.src = r.url; });
  else f.srcdoc = html;
  return f;
}

async function superPreview(app: App): Promise<void> {
  const pages = app.site.pages().map((p) => p.path);
  if (!pages.length) { toast('The site has no pages.'); return; }
  app.active?.ui.flush();
  let page = app.page?.path || pages[0];
  const widths = PAGE_SIZES.filter(([w]) => w > 0);
  let wa = 375, wb = 1280;
  const stage = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;height:min(64vh,640px)' });
  const mkSel = (opts: [string, string][], val: string, on: (v: string) => void, label: string) => { const s = h('select', { 'aria-label': label }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l))) as HTMLSelectElement; s.addEventListener('change', () => on(s.value)); return s; };
  const draw = () => {
    clear(stage);
    const src = app.site.read(page) || '';
    for (const [w, side] of [[wa, 'a'], [wb, 'b']] as [number, string][]) {
      const box = h('div', { style: 'position:relative;overflow:hidden;border:1px solid var(--border);border-radius:6px;background:#fff' });
      const frame = previewFrame(app, page, src, `superpreview-${side}`);
      box.appendChild(frame);
      box.appendChild(h('div', { style: 'position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;padding:2px 6px;border-radius:4px' }, `${w}px`));
      stage.appendChild(box);
      requestAnimationFrame(() => {
        const bw = box.clientWidth || 400, bh = box.clientHeight || 500;
        const scale = Math.min(1, bw / w);
        frame.style.width = `${w}px`;
        frame.style.height = `${Math.round(bh / scale)}px`;
        frame.style.transform = `scale(${scale})`;
      });
    }
  };
  const sizeOpts = widths.map(([w, l]) => [String(w), l] as [string, string]);
  const bar = h('div', { class: 'ql-row', style: 'gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px' },
    h('label', null, 'Page '), mkSel(pages.map((p) => [p, p]), page, (v) => { page = v; draw(); }, 'Page'),
    h('label', null, ' Left '), mkSel(sizeOpts, String(wa), (v) => { wa = +v; draw(); }, 'Left width'),
    h('label', null, ' Right '), mkSel(sizeOpts, String(wb), (v) => { wb = +v; draw(); }, 'Right width'),
    h('button', { class: 'ql-iconbtn', title: 'Reload', 'aria-label': 'Reload', onclick: () => draw() }, icon('refresh')));
  const content = h('div', null, bar, stage, h('p', { class: 'ql-help' }, 'Both previews run the page with its scripts in a sandbox. Narrow layouts are shown at real size; wide ones are scaled to fit.'));
  setTimeout(draw, 50);
  await openDialog({ title: 'Side-by-Side Preview', content, full: true, ok: false, cancel: 'Close' });
}

// --------------------------------------------------------------------------------------------
// Compare files

async function compareFiles(app: App, arg?: any): Promise<void> {
  const files = app.site.list((f) => f.text != null).map((f) => f.path);
  if (files.length < 1) { toast('The site has no text files to compare.'); return; }
  app.active?.ui.flush();
  let a = arg?.a, b = arg?.b, ignoreWhitespace = !!arg?.ignoreWhitespace, ignoreCase = !!arg?.ignoreCase;
  if (!a || !b) {
    const cur = app.active?.path && files.includes(app.active.path) ? app.active.path : files[0];
    const r = await openDialog({
      title: 'Compare Files', ok: 'Compare',
      fields: [
        { key: 'a', label: 'Original', type: 'select', value: cur, options: files },
        { key: 'b', label: 'Changed', type: 'select', value: files.find((f) => f !== cur) || cur, options: files },
        { key: 'ws', label: 'Ignore differences in white space', type: 'checkbox', value: false },
        { key: 'case', label: 'Ignore differences in case', type: 'checkbox', value: false },
      ],
    });
    if (!r) return;
    a = r.a; b = r.b; ignoreWhitespace = r.ws; ignoreCase = r.case;
  }
  const ops = diffLines(app.site.read(a) || '', app.site.read(b) || '', { ignoreWhitespace, ignoreCase });
  const st = diffStats(ops);
  const CONTEXT = 3;
  const show = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.op !== 'equal') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) show[k] = true; });
  const tbl = h('table', { style: 'border-collapse:collapse;width:100%;font:12px/1.45 ui-monospace,Consolas,monospace' });
  let skipped = 0;
  const flushSkip = () => { if (skipped) { tbl.appendChild(h('tr', null, h('td', { colspan: '3', style: 'color:var(--muted);padding:2px 8px;background:var(--surface2)' }, `… ${skipped} unchanged ${skipped === 1 ? 'line' : 'lines'} …`))); skipped = 0; } };
  ops.forEach((o, i) => {
    if (!show[i]) { skipped++; return; }
    flushSkip();
    const bg = o.op === 'insert' ? 'rgba(40,167,69,.16)' : o.op === 'delete' ? 'rgba(220,53,69,.16)' : 'transparent';
    tbl.appendChild(h('tr', { style: `background:${bg}` },
      h('td', { style: 'color:var(--muted);text-align:right;padding:0 6px;user-select:none;width:4em' }, o.a ? String(o.a) : ''),
      h('td', { style: 'color:var(--muted);text-align:right;padding:0 6px;user-select:none;width:4em' }, o.b ? String(o.b) : ''),
      h('td', { style: 'white-space:pre-wrap;word-break:break-all;padding:0 6px' }, (o.op === 'insert' ? '+ ' : o.op === 'delete' ? '− ' : '  ') + o.text)));
  });
  flushSkip();
  const content = h('div', null,
    h('p', null, `${a} → ${b}: `, h('b', null, `${st.added} added, ${st.removed} removed`), `, ${st.same} unchanged.`),
    st.added || st.removed ? h('div', { style: 'max-height:62vh;overflow:auto;border:1px solid var(--border);border-radius:6px' }, tbl) : h('p', null, 'The files are identical' + (ignoreWhitespace || ignoreCase ? ' (with the differences you chose to ignore)' : '') + '.'));
  await openDialog({ title: 'Compare Files', content, wide: true, ok: false, cancel: 'Close', buttons: [{ label: 'Open Both', onClick: (_v, ctl) => { app.openFile(a); app.openFile(b); ctl.close(); } }] });
}

// --------------------------------------------------------------------------------------------
// Script console

/** Script injected first into the console's page: forwards console output and errors to the editor. */
const CONSOLE_HOOK = `(function(){var P=parent;function s(v){try{if(v instanceof Error)return v.stack||String(v);if(typeof v==='object'&&v!==null){return JSON.stringify(v,function(k,x){return typeof x==='function'?'[function]':x},1).slice(0,2000)}return String(v)}catch(e){return String(v)}}
['log','info','warn','error','debug','table'].forEach(function(l){var o=console[l];console[l]=function(){try{P.postMessage({qlConsole:{level:l,text:[].map.call(arguments,s).join(' ')}},'*')}catch(e){}if(o)o.apply(console,arguments)}});
addEventListener('error',function(e){P.postMessage({qlConsole:{level:'error',text:(e.message||'Error')+(e.filename?' ('+(e.lineno||'?')+':'+(e.colno||'?')+')':'')}},'*')});
addEventListener('unhandledrejection',function(e){P.postMessage({qlConsole:{level:'error',text:'Unhandled promise rejection: '+s(e.reason)}},'*')});
addEventListener('message',function(e){if(!e.data||typeof e.data.qlEval!=='string')return;try{var r=(0,eval)(e.data.qlEval);P.postMessage({qlConsole:{level:'result',text:s(r)}},'*')}catch(err){P.postMessage({qlConsole:{level:'error',text:s(err)}},'*')}});
addEventListener('load',function(){P.postMessage({qlConsole:{level:'system',text:'Page loaded.'}},'*')});})();`;

async function jsConsole(app: App): Promise<void> {
  const tab = app.page;
  if (!tab) { toast('Open a page first.'); return; }
  tab.ui.flush();
  const out = h('div', { role: 'log', 'aria-live': 'polite', style: 'height:min(46vh,420px);overflow:auto;border:1px solid var(--border);border-radius:6px;padding:6px;font:12px/1.45 ui-monospace,Consolas,monospace;background:var(--surface2)' });
  const holder = h('div', { style: 'position:relative;height:0;overflow:hidden' });
  const input = h('input', { type: 'text', placeholder: 'Run JavaScript in the page (Enter)', 'aria-label': 'JavaScript to run', style: 'width:100%;font-family:ui-monospace,Consolas,monospace' }) as HTMLInputElement;
  const showFrame = h('input', { type: 'checkbox', id: 'qlcons-show' }) as HTMLInputElement;
  let frame: HTMLIFrameElement | null = null;
  const colors: Record<string, string> = { error: 'var(--danger,#c62828)', warn: '#b26a00', info: 'var(--accent)', result: 'var(--muted)', system: 'var(--muted)' };
  const line = (level: string, text: string) => {
    out.appendChild(h('div', { style: `color:${colors[level] || 'inherit'};white-space:pre-wrap;border-bottom:1px solid var(--border);padding:2px 0` }, level === 'result' ? `← ${text}` : level === 'system' ? `— ${text}` : `${level === 'log' ? '' : level.toUpperCase() + ': '}${text}`));
    out.scrollTop = out.scrollHeight;
  };
  const onMsg = (e: MessageEvent) => { if (!frame || e.source !== frame.contentWindow || !e.data?.qlConsole) return; const m = e.data.qlConsole; line(String(m.level), String(m.text)); };
  window.addEventListener('message', onMsg);
  const run = () => {
    frame?.remove();
    clear(out);
    line('system', `Running ${tab.path}…`);
    let html = previewDocument(app.site, tab.path, tab.source, cacheFor(app));
    const hook = `<script>${CONSOLE_HOOK}</script>`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + hook) : hook + html;
    frame = h('iframe', { sandbox: 'allow-scripts allow-forms allow-modals', title: 'Page running for the console', style: 'width:1024px;height:700px;border:0;background:#fff' }) as HTMLIFrameElement;
    if (desktopFolders) void desktopFolders.setPreview({ id: 'jsconsole', html }).then((r) => { frame!.src = r.url; });
    else frame.srcdoc = html;
    holder.appendChild(frame);
  };
  showFrame.addEventListener('change', () => { holder.style.height = showFrame.checked ? '320px' : '0'; holder.style.overflow = showFrame.checked ? 'auto' : 'hidden'; holder.style.border = showFrame.checked ? '1px solid var(--border)' : ''; });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    e.preventDefault(); e.stopPropagation();
    line('system', `> ${input.value}`);
    frame?.contentWindow?.postMessage({ qlEval: input.value }, '*');
    input.value = '';
  });
  const content = h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
    h('p', { class: 'ql-help' }, 'The page runs in a sandboxed frame that cannot reach the editor or your files. Messages from console.log, warnings and script errors appear here.'),
    out, input,
    h('div', { class: 'ql-row', style: 'gap:6px;align-items:center' }, showFrame, h('label', { for: 'qlcons-show' }, 'Show the page')),
    holder);
  run();
  await openDialog({ title: 'JavaScript Console', content, wide: true, ok: false, cancel: 'Close', buttons: [{ label: 'Reload Page', primary: true, onClick: () => run() }, { label: 'Clear', onClick: () => clear(out) }] });
  window.removeEventListener('message', onMsg);
  frame?.remove();
}

// --------------------------------------------------------------------------------------------
// Color picker, placeholder text, calculator

function formatColor(hex: string, alpha: number, fmt: string): string {
  const c = parseColor(hex) || { r: 0, g: 0, b: 0, a: 1 };
  const a = Math.round(alpha) / 100;
  if (fmt === 'rgb') return a < 1 ? `rgb(${c.r} ${c.g} ${c.b} / ${a})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
  if (fmt === 'hsl') { const [hh, s, l] = rgbToHsl(c.r, c.g, c.b); return a < 1 ? `hsl(${hh} ${s}% ${l}% / ${a})` : `hsl(${hh}, ${s}%, ${l}%)`; }
  return a < 1 ? toHexColor(c) + Math.round(a * 255).toString(16).padStart(2, '0') : toHexColor(c);
}

async function colorPicker(app: App): Promise<void> {
  const sel = selectionText(app).trim();
  const start = parseColor(sel);
  const out = h('code', { style: 'font-size:15px' });
  const swatch = h('div', { style: 'height:44px;border-radius:6px;border:1px solid var(--border);background-image:linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%);background-size:12px 12px;background-position:0 0,6px 6px' }, h('div', { style: 'height:100%;border-radius:6px' }));
  const update = (v: Record<string, any>) => { const text = formatColor(v.color, v.alpha ?? 100, v.format); out.textContent = text; (swatch.firstChild as HTMLElement).style.background = text; };
  const content = h('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:8px' }, swatch, h('div', null, 'Inserts: ', out));
  const hasDropper = typeof (window as any).EyeDropper === 'function';
  const r = await openDialog({
    title: 'Color Picker', ok: 'Insert', content,
    fields: [
      { key: 'color', label: 'Color', type: 'color', value: start ? toHexColor(start) : '#2563eb' },
      { key: 'alpha', label: 'Opacity', type: 'range', min: 0, max: 100, value: start ? Math.round(start.a * 100) : 100, suffix: '%' },
      { key: 'format', label: 'Format', type: 'radio', value: 'hex', options: [{ value: 'hex', label: 'Hex (#rrggbb)' }, { value: 'rgb', label: 'RGB' }, { value: 'hsl', label: 'HSL' }] },
      ...(hasDropper ? [{ key: 'drop', label: 'Pick from the Screen', type: 'button' as const, onClick: async (_v: any, ctl: any) => { try { const res = await new (window as any).EyeDropper().open(); ctl.set('color', res.sRGBHex); update(ctl.values()); } catch { /* canceled */ } } }] : []),
      { key: 'copy', label: 'Copy', type: 'button', onClick: (v) => { void navigator.clipboard?.writeText(formatColor(v.color, v.alpha, v.format)).then(() => toast('Color copied.')); } },
    ],
    onChange: (v) => update(v),
  });
  if (!r) return;
  insertHtml(app, esc(formatColor(r.color, r.alpha, r.format)));
}

const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum curabitur pretium tincidunt lacus nulla gravida orci a odio nullam varius turpis et commodo pharetra est eros bibendum elit nec luctus magna felis sollicitudin mauris integer in mauris eu nibh euismod gravida duis ac tellus et risus vulputate vehicula donec lobortis risus a elit etiam tempor ut ullamcorper ligula eu tempor congue eros est euismod turpis id tincidunt sapien risus a quam maecenas fermentum consequat mi donec fermentum pellentesque malesuada nulla a mi duis sapien sem aliquet nec commodo eget consequat quis neque aliquam faucibus elit ut dictum aliquet felis nisl adipiscing sapien sed malesuada diam lacus eget erat cras mollis scelerisque nunc nullam arcu aliquam consequat curabitur augue lorem dapibus quis laoreet et pretium ac nisi aenean magna nisl mollis quis molestie eu feugiat in orci'.split(' ');

/** Placeholder Latin text. `seed` makes the output repeatable (tests); otherwise it varies. */
export function lorem(kind: 'words' | 'sentences' | 'paragraphs', count: number, startClassic = true, seed = Math.random() * 1e9): string {
  let st = Math.floor(seed) % 2147483647 || 1;
  const rnd = () => { st = (st * 48271) % 2147483647; return st / 2147483647; };
  const word = () => LOREM[Math.floor(rnd() * LOREM.length)];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let first = startClassic;
  const sentence = () => {
    const n = 6 + Math.floor(rnd() * 10);
    const ws = first ? ['lorem', 'ipsum', 'dolor', 'sit', 'amet', ...Array.from({ length: Math.max(0, n - 5) }, word)] : Array.from({ length: n }, word);
    first = false;
    if (ws.length > 8 && rnd() < 0.5) ws[Math.floor(ws.length / 2)] += ',';
    return cap(ws.join(' ')) + '.';
  };
  if (kind === 'words') { const ws = Array.from({ length: count }, (_, i) => (startClassic && i < 5 ? LOREM[i] : word())); return cap(ws.join(' ')); }
  if (kind === 'sentences') return Array.from({ length: count }, sentence).join(' ');
  return Array.from({ length: count }, () => Array.from({ length: 3 + Math.floor(rnd() * 4) }, sentence).join(' ')).join('\n\n');
}

async function loremIpsum(app: App, arg?: any): Promise<void> {
  let o = arg;
  if (!o || typeof o !== 'object') {
    o = await openDialog({
      title: 'Placeholder Text', ok: 'Insert',
      fields: [
        { key: 'kind', label: 'Insert', type: 'select', value: 'paragraphs', options: [{ value: 'paragraphs', label: 'Paragraphs' }, { value: 'sentences', label: 'Sentences' }, { value: 'words', label: 'Words' }, { value: 'list', label: 'Bulleted list' }, { value: 'olist', label: 'Numbered list' }, { value: 'heading', label: 'Heading' }] },
        { key: 'count', label: 'How many', type: 'number', value: 3, min: 1, max: 200 },
        { key: 'classic', label: 'Start with "Lorem ipsum dolor sit amet"', type: 'checkbox', value: true },
        { key: 'tags', label: 'Wrap paragraphs in <p> tags', type: 'checkbox', value: true },
      ],
    });
    if (!o) return;
  }
  const n = Math.max(1, Math.min(200, Math.round(+o.count || 1)));
  let html: string;
  switch (o.kind) {
    case 'words': html = esc(lorem('words', n, o.classic)); break;
    case 'sentences': html = esc(lorem('sentences', n, o.classic)); break;
    case 'list': case 'olist': { const t = o.kind === 'list' ? 'ul' : 'ol'; html = `<${t}>\n${Array.from({ length: n }, (_, i) => `  <li>${esc(lorem('words', 3 + (i % 4), o.classic && i === 0))}</li>`).join('\n')}\n</${t}>`; break; }
    case 'heading': html = `<h2>${esc(lorem('words', Math.min(n, 12), o.classic))}</h2>`; break;
    default: { const ps = lorem('paragraphs', n, o.classic).split('\n\n'); html = o.tags !== false ? ps.map((p) => `<p>${esc(p)}</p>`).join('\n') : ps.map(esc).join('<br><br>'); }
  }
  insertHtml(app, html);
}

/**
 * Evaluates an arithmetic expression without eval: numbers (with exponents, hex 0x…), + − × ÷ % ^,
 * parentheses, unary signs, percent after a number ("15%"), the constants pi and e, and the functions
 * sqrt, cbrt, abs, round, floor, ceil, trunc, sign, sin, cos, tan, asin, acos, atan, ln, log (base 10),
 * log2, exp, min, max, pow, hypot. `ans` is the previous result.
 */
export function evaluateExpression(input: string, vars: Record<string, number> = {}): number {
  const s = input.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/,(?=\d{3}\b)/g, '');
  let i = 0;
  const FUNCS: Record<string, (...a: number[]) => number> = { sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, sign: Math.sign, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp, min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot };
  const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, ...vars };
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = (msg: string): never => { throw new Error(msg); };
  const peek = () => { ws(); return s[i]; };
  const expr = (): number => {
    let v = term();
    for (;;) { const c = peek(); if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v; }
  };
  const term = (): number => {
    let v = unary();
    for (;;) {
      const c = peek();
      if (c === '*') { i++; v *= unary(); }
      else if (c === '/') { i++; const d = unary(); if (d === 0) fail('Division by zero.'); v /= d; }
      else if (c === '%' ) { i++; v %= unary(); }
      else if (c === '(' || (c && /[a-z]/i.test(c))) v *= unary(); // implicit multiplication: 2(3), 2pi
      else return v;
    }
  };
  const unary = (): number => { const c = peek(); if (c === '-') { i++; return -unary(); } if (c === '+') { i++; return unary(); } return power(); };
  const power = (): number => { const b = postfix(); if (peek() === '^' || (s[i] === '*' && s[i + 1] === '*')) { i += s[i] === '^' ? 1 : 2; return Math.pow(b, unary()); } return b; };
  const postfix = (): number => {
    let v = primary();
    for (;;) {
      const save = i;
      ws();
      if (s[i] === '%' && !/^\s*[\d(a-z.]/i.test(s.slice(i + 1))) { i++; v /= 100; continue; }
      if (s[i] === '!') { i++; if (v < 0 || v > 170 || !Number.isInteger(v)) fail('Factorial needs a whole number from 0 to 170.'); let f = 1; for (let k = 2; k <= v; k++) f *= k; v = f; continue; }
      i = save;
      return v;
    }
  };
  const primary = (): number => {
    const c = peek();
    if (c === '(') { i++; const v = expr(); if (peek() !== ')') fail('A ")" is missing.'); i++; return v; }
    const num = /^(0x[0-9a-f]+|0b[01]+|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)/i.exec(s.slice(i));
    if (num) { i += num[0].length; return /^0b/i.test(num[0]) ? parseInt(num[0].slice(2), 2) : Number(num[0]); }
    const id = /^[a-z_]\w*/i.exec(s.slice(i));
    if (id) {
      const name = id[0].toLowerCase();
      i += id[0].length;
      if (FUNCS[name]) {
        if (peek() !== '(') fail(`${name} needs parentheses, as in ${name}(2).`);
        i++;
        const args: number[] = [];
        if (peek() !== ')') { args.push(expr()); while (peek() === ',' || peek() === ';') { i++; args.push(expr()); } }
        if (peek() !== ')') fail('A ")" is missing.');
        i++;
        return FUNCS[name](...args);
      }
      if (name in CONSTS) return CONSTS[name];
      fail(`Unknown name "${id[0]}".`);
    }
    return fail(i >= s.length ? 'The expression is incomplete.' : `Unexpected "${s[i]}".`);
  };
  if (!s.trim()) fail('Type an expression.');
  const v = expr();
  ws();
  if (i < s.length) fail(`Unexpected "${s[i]}".`);
  if (!Number.isFinite(v)) fail('The result is not a finite number.');
  return v;
}

export const formatNumber = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10));

let lastAnswer = 0;
async function calculator(app: App): Promise<void> {
  const result = h('div', { style: 'font-size:22px;font-variant-numeric:tabular-nums;min-height:32px;padding:4px 0', 'aria-live': 'polite' });
  const content = h('div', null, result, h('p', { class: 'ql-help' }, 'Use + − * / % ^, parentheses, 15% for percent, and functions such as sqrt(2), round(x), min(a, b). "ans" is the last result.'));
  const sel = selectionText(app).trim();
  const r = await openDialog({
    title: 'Calculator', ok: 'Insert Result', content,
    fields: [{ key: 'expr', label: 'Expression', type: 'text', value: sel && /^[\d\s+\-*/().%^,]+$/.test(sel) ? sel : '', autofocus: true, placeholder: '(1280 - 2 * 24) / 3' }],
    onChange: (v) => { try { result.textContent = v.expr?.trim() ? '= ' + formatNumber(evaluateExpression(v.expr, { ans: lastAnswer })) : ''; result.style.color = ''; } catch (e) { result.textContent = (e as Error).message; result.style.color = 'var(--muted)'; } },
    validate: (v) => { try { evaluateExpression(v.expr, { ans: lastAnswer }); return null; } catch (e) { return (e as Error).message; } },
  });
  if (!r) return;
  lastAnswer = evaluateExpression(r.expr, { ans: lastAnswer });
  if (isText(app)) insertHtml(app, formatNumber(lastAnswer));
  else { void navigator.clipboard?.writeText(formatNumber(lastAnswer)); toast(`${formatNumber(lastAnswer)} copied.`); }
}

// --------------------------------------------------------------------------------------------
// Extensions and editor options

async function extensionsInfo(app: App, title: string): Promise<void> {
  const content = h('div', { class: 'ql-msg' },
    h('p', null, 'QuillLoom is extended with macros: recorded or hand-written sequences of commands, and JavaScript macros that call any command with app.exec(id, argument) and read or change site files.'),
    h('p', null, 'Every command in the ribbon and menus can be placed in a macro, on the Quick Access Bar, on a custom ribbon tab or on a keyboard shortcut.'),
    h('p', null, 'Macros and their keys are kept on this device. Developer ▸ Macros lists, runs, edits, imports and exports them.'));
  await openDialog({ title, content, ok: false, cancel: 'Close', buttons: [{ label: 'Open Macros', primary: true, onClick: (_v, ctl) => { ctl.close(); app.exec('dev.macros'); } }, { label: 'Macro Editor', onClick: (_v, ctl) => { ctl.close(); app.exec('dev.macroEditor'); } }] });
}

async function pageEditorOptions(app: App): Promise<void> {
  const p = app.prefs;
  const r = await openDialog({
    title: 'Page Editor Options', wide: true,
    fields: [
      { key: 'h1', label: 'General', type: 'heading' },
      { key: 'defaultView', label: 'Open pages in', type: 'select', value: p.defaultView, half: true, options: [{ value: 'design', label: 'Design view' }, { value: 'split', label: 'Split view' }, { value: 'code', label: 'Code view' }, { value: 'preview', label: 'Preview' }] },
      { key: 'splitVertical', label: 'Split view side by side', type: 'checkbox', value: p.splitVertical, half: true },
      { key: 'defaultDoctype', label: 'Doctype for new pages', type: 'select', value: p.defaultDoctype, half: true, options: DOCTYPES.map((d) => ({ value: d.id, label: d.label })) },
      { key: 'defaultCharset', label: 'Character set for new pages', type: 'combo', value: p.defaultCharset, half: true, options: ['utf-8', 'windows-1252', 'iso-8859-1', 'shift_jis', 'gb2312', 'big5', 'euc-kr'] },
      { key: 'defaultExtension', label: 'File extension for new pages', type: 'select', value: p.defaultExtension, half: true, options: ['html', 'htm', 'php'] },
      { key: 'formatOnSave', label: 'Apply source formatting when saving', type: 'checkbox', value: p.formatOnSave, half: true },
      { key: 'h2', label: 'Formatting', type: 'heading' },
      { key: 'useStrongEm', label: 'Use <strong> and <em> instead of <b> and <i>', type: 'checkbox', value: p.useStrongEm },
      { key: 'cssMode', label: 'Apply formatting as', type: 'select', value: p.cssMode, options: [{ value: 'auto', label: 'Automatic (classes for styles, inline CSS for direct formatting)' }, { value: 'class', label: 'CSS classes' }, { value: 'inline', label: 'Inline styles' }, { value: 'tags', label: 'HTML tags (legacy)' }] },
      { key: 'h3', label: 'Code view', type: 'heading' },
      { key: 'tabSize', label: 'Tab size', type: 'number', value: p.tabSize, min: 1, max: 8, half: true },
      { key: 'codeFontSize', label: 'Font size', type: 'number', value: p.codeFontSize, min: 8, max: 32, half: true, suffix: 'px' },
      { key: 'codeLineNumbers', label: 'Line numbers', type: 'checkbox', value: p.codeLineNumbers, half: true },
      { key: 'codeWrap', label: 'Word wrap', type: 'checkbox', value: p.codeWrap, half: true },
      { key: 'codeAutoClose', label: 'Close tags and brackets automatically', type: 'checkbox', value: p.codeAutoClose, half: true },
      { key: 'codeComplete', label: 'IntelliSense (completion)', type: 'checkbox', value: p.codeComplete, half: true },
      { key: 'codeFold', label: 'Code folding', type: 'checkbox', value: p.codeFold, half: true },
      { key: 'codeHighlightLine', label: 'Highlight the current line', type: 'checkbox', value: p.codeHighlightLine, half: true },
    ],
  });
  if (!r) return;
  const n = (v: any, lo: number, hi: number, d: number) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d);
  Object.assign(p, {
    defaultView: r.defaultView, splitVertical: r.splitVertical, defaultDoctype: r.defaultDoctype, defaultCharset: String(r.defaultCharset || 'utf-8').trim() || 'utf-8', defaultExtension: r.defaultExtension, formatOnSave: r.formatOnSave,
    useStrongEm: r.useStrongEm, cssMode: r.cssMode, tabSize: n(r.tabSize, 1, 8, p.tabSize), codeFontSize: n(r.codeFontSize, 8, 32, p.codeFontSize),
    codeLineNumbers: r.codeLineNumbers, codeWrap: r.codeWrap, codeAutoClose: r.codeAutoClose, codeComplete: r.codeComplete, codeFold: r.codeFold, codeHighlightLine: r.codeHighlightLine,
  });
  app.savePrefs();
  app.ui.applyPrefs();
  toast('Editor options saved.');
}

// --------------------------------------------------------------------------------------------
// Commands

def([
  { id: 'tools.validate', label: 'Validate HTML', icon: 'rule', tab: 'Check', group: 'Validate', keys: ['Shift+F6'], origin: 'Dreamweaver Validator, Expression Web Compatibility Checker, HomeSite Validate Document', keywords: 'html5 validator conformance errors w3c check', tip: 'Check the page against HTML5: unclosed and misnested tags, duplicate ids, obsolete markup, missing attributes.', popular: true, noRecord: true, run: (app, arg) => runValidate(app, scopeOf(arg)) },
  { id: 'tools.validateXml', label: 'Validate as XML', icon: 'data_object', tab: 'Check', group: 'Validate', origin: 'Dreamweaver Validate as XML, HomeSite', keywords: 'xml well-formed rss sitemap svg xhtml', tip: 'Check that the file is well-formed XML.', noRecord: true, isEnabled: isText, run: (app, arg) => runValidateXml(app, scopeOf(arg)) },
  { id: 'tools.accessibility', label: 'Accessibility Checker', icon: 'accessibility_new', tab: 'Check', group: 'Validate', origin: 'Expression Web Accessibility Checker, FrontPage Accessibility, Dreamweaver Check Accessibility', keywords: 'wcag 508 a11y alt contrast aria screen reader', tip: 'Check the page against WCAG 2.2: text alternatives, labels, headings, contrast, keyboard and ARIA.', popular: true, noRecord: true, run: (app, arg) => runAccessibility(app, scopeOf(arg)) },
  { id: 'tools.compatibility', label: 'Compatibility Checker', icon: 'devices', tab: 'Check', group: 'Validate', origin: 'Expression Web Compatibility Checker', keywords: 'browser obsolete deprecated plugins flash mixed content prefix', tip: 'Find obsolete markup, plugins, removed script APIs, prefixed CSS and insecure resources.', noRecord: true, run: (app, arg) => runCompat(app, scopeOf(arg), false) },
  { id: 'tools.browserCompat', label: 'Browser Compatibility', icon: 'browser_updated', tab: 'Check', group: 'Validate', origin: 'Dreamweaver Browser Compatibility Check, FrontPage Browser Compatibility', keywords: 'browser support baseline newer features safari firefox', tip: 'Compatibility check that also lists newer features and when every major browser got them.', noRecord: true, run: (app, arg) => runCompat(app, scopeOf(arg), true) },
  { id: 'tools.seoCheck', label: 'SEO Checker', icon: 'travel_explore', tab: 'Check', group: 'SEO & Speed', origin: 'Expression Web SEO Checker', keywords: 'search engine optimization title description h1 canonical open graph', tip: 'Check titles, descriptions, headings, canonical links, social tags and more.', noRecord: true, run: (app, arg) => runSeo(app, scopeOf(arg)) },
  { id: 'tools.performance', label: 'Performance Report', icon: 'speed', tab: 'Check', group: 'SEO & Speed', origin: 'FrontPage Slow Pages report, Dreamweaver download size', keywords: 'speed page weight download size images render blocking lazy', tip: 'Page weight, oversized pictures, missing sizes, render-blocking scripts and lazy loading.', noRecord: true, run: (app, arg) => runPerformance(app, scopeOf(arg)) },
  { id: 'tools.superPreview', label: 'Side-by-Side Preview', icon: 'splitscreen', tab: 'Check', group: 'Validate', origin: 'Expression Web SuperPreview', keywords: 'superpreview responsive widths compare preview phone desktop', tip: 'Preview the page at two widths side by side.', noRecord: true, run: (app) => superPreview(app) },

  { id: 'tools.spelling', label: 'Spelling', icon: 'spellcheck', tab: 'Check', group: 'Proofing', keys: ['F7'], edits: true, origin: 'FrontPage, Expression Web, Dreamweaver Check Spelling', keywords: 'spell check misspelled dictionary', tip: 'Check the spelling of the page text.', popular: true, run: (app, arg) => runSpelling(app, scopeOf(arg)) },
  { id: 'tools.spellingSite', label: 'Spelling (Whole Site)', icon: 'library_add_check', tab: 'Check', group: 'Proofing', edits: true, origin: 'FrontPage and Expression Web site spelling', keywords: 'spell check all pages site', tip: 'Check the spelling of every page in the site.', run: (app) => runSpelling(app, 'site') },
  { id: 'tools.thesaurus', label: 'Thesaurus', icon: 'menu_book', tab: 'Check', group: 'Proofing', keys: ['Shift+F7'], edits: true, origin: 'FrontPage, Expression Web', keywords: 'synonyms words meaning', tip: 'Find other words for the selected word.', run: (app) => thesaurus(app) },
  { id: 'tools.setLanguage', label: 'Set Language', icon: 'translate', tab: 'Check', group: 'Proofing', edits: true, origin: 'FrontPage, Expression Web Set Language', keywords: 'lang attribute language page element', tip: 'Set the language of the page or the selected element.', isEnabled: isPage, run: (app, arg) => setLanguage(app, arg) },
  { id: 'tools.dictionary', label: 'Custom Dictionary', icon: 'book', tab: 'Check', group: 'Proofing', origin: 'FrontPage, Dreamweaver personal dictionary', keywords: 'words add remove spelling ignore', noRecord: true, run: (app) => manageDictionary(app) },
  { id: 'tools.wordCount', label: 'Word Count', icon: 'format_list_numbered', tab: 'Check', group: 'Proofing', origin: 'FrontPage page statistics', keywords: 'statistics words characters reading time', noRecord: true, run: (app, arg) => wordCount(app, arg) },

  { id: 'tools.compareFiles', label: 'Compare Files', icon: 'difference', tab: 'Check', group: 'Compare', origin: 'Dreamweaver Compare Files, Expression Web Compare', keywords: 'diff differences two files lines', tip: 'Show the line differences between two site files.', noRecord: true, run: (app, arg) => compareFiles(app, arg) },

  { id: 'tools.imageOptimize', label: 'Optimize Picture', icon: 'photo_size_select_large', tab: 'Picture', group: 'Web', edits: true, origin: 'Dreamweaver Optimize Image', keywords: 'compress image jpeg quality size', run: (app) => app.exec('picture.optimize') },
  { id: 'tools.autoThumbnail', label: 'Auto Thumbnail', icon: 'photo_size_select_small', tab: 'Picture', group: 'Web', edits: true, origin: 'FrontPage Auto Thumbnail', keywords: 'thumbnail small picture link', run: (app) => app.exec('picture.autoThumbnail') },
  { id: 'tools.photoAlbum', label: 'Photo Album', icon: 'photo_library', tab: 'Insert', group: 'Pictures & Media', edits: true, origin: 'Dreamweaver Create Web Photo Album, FrontPage Photo Gallery', keywords: 'gallery photos album', run: (app) => app.exec('insert.photoGallery') },
  { id: 'tools.snippetsManager', label: 'Snippets', icon: 'content_paste_go', tab: 'Code', group: 'Assist', origin: 'Dreamweaver Snippets panel, HomeSite Snippets', keywords: 'code snippets library reuse', noRecord: true, run: (app) => app.ui.togglePane('snippets') },
  { id: 'tools.charMap', label: 'Character Map', icon: 'emoji_symbols', tab: 'Insert', group: 'Text', edits: true, origin: 'HomeSite Special Characters, Windows Character Map', keywords: 'symbol special character entity', run: (app) => app.exec('insert.symbol') },
  { id: 'tools.emmet', label: 'Expand Abbreviation', icon: 'bolt', tab: 'Code', group: 'Assist', edits: true, origin: 'Dreamweaver Emmet, HomeSite tag shortcuts', keywords: 'emmet zen coding abbreviation expand', run: (app) => app.exec('code.emmet') },
  { id: 'tools.colorPicker', label: 'Color Picker', icon: 'colorize', tab: 'Code', group: 'Assist', edits: true, origin: 'HomeSite Color Palette, Dreamweaver color picker', keywords: 'color hex rgb hsl eyedropper', tip: 'Pick a color and insert its code at the cursor.', run: (app) => colorPicker(app) },
  { id: 'tools.loremIpsum', label: 'Placeholder Text', icon: 'notes', tab: 'Code', group: 'Assist', edits: true, origin: 'Dreamweaver Lorem Ipsum, Expression Web', keywords: 'lorem ipsum dummy filler text', run: (app, arg) => loremIpsum(app, arg) },
  { id: 'tools.calculator', label: 'Calculator', icon: 'calculate', tab: 'Code', group: 'Assist', origin: 'HomeSite, KompoZer', keywords: 'math arithmetic compute pixels', noRecord: true, run: (app) => calculator(app) },
  { id: 'tools.jsConsole', label: 'JavaScript Console', icon: 'terminal', tab: 'Developer', group: 'Tools', origin: 'KompoZer JavaScript Console, browser developer tools', keywords: 'console log errors debug script', tip: 'Run the page in a sandbox and see its console messages and script errors.', noRecord: true, run: (app) => jsConsole(app) },
  { id: 'tools.extensions', label: 'Extensions', icon: 'extension', tab: 'Developer', group: 'Tools', origin: 'Dreamweaver Extension Manager', keywords: 'add-ons plugins macros scripts', noRecord: true, run: (app) => extensionsInfo(app, 'Extensions') },
  { id: 'tools.addins', label: 'Add-ins', icon: 'widgets', tab: 'Developer', group: 'Tools', origin: 'FrontPage and Expression Web Add-ins', keywords: 'add-ons plugins macros', noRecord: true, run: (app) => extensionsInfo(app, 'Add-ins') },
  { id: 'tools.pageEditorOptions', label: 'Page Editor Options', icon: 'tune', tab: 'Backstage', group: 'Options', origin: 'FrontPage and Expression Web Page Editor Options', keywords: 'preferences settings code view doctype charset tab size', noRecord: true, run: (app) => pageEditorOptions(app) },
]);
