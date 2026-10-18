/**
 * Spelling for pages.
 *
 * Words are taken only from the visible text of a page (text nodes of the body and the title; never
 * tags, attribute values, scripts, styles, code samples or anything marked spellcheck="false" or
 * translate="no"). Each word keeps its exact range in the source text, character references included,
 * so a correction replaces just those characters and leaves the markup around it alone.
 *
 * Checking runs in a background worker (spell.worker.ts) that loads the dictionary on first use.
 */
import { parseHtml, decodeWithMap, attr, hasAttr, type HNode } from '../check/validate';

// --------------------------------------------------------------------------------------------
// Worker client

let worker: Worker | null = null;
let failures = 0;
let reqId = 0;
const pending = new Map<number, (v: any) => void>();
const FAILED = { bad: [], suggestions: [], failed: true };

function getWorker(): Worker | null {
  if (worker) return worker;
  if (failures >= 3 || typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('./spell.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { const cb = pending.get(e.data.id); if (cb) { pending.delete(e.data.id); cb(e.data); } };
    w.onerror = () => {
      failures++;
      if (worker === w) worker = null;
      try { w.terminate(); } catch { /* gone */ }
      for (const cb of pending.values()) cb(FAILED);
      pending.clear();
    };
    worker = w;
  } catch { worker = null; }
  return worker;
}

function call(msg: Record<string, any>): Promise<any> {
  const w = getWorker();
  if (!w) return Promise.resolve(FAILED);
  const id = ++reqId;
  return new Promise((res) => { pending.set(id, res); w.postMessage({ ...msg, id }); });
}

export interface SpellChecker {
  /** The words (of those given) that are not in the dictionary. */
  check(words: string[]): Promise<Set<string>>;
  suggest(word: string): Promise<string[]>;
  add(word: string): Promise<void>;
  remove(word: string): Promise<void>;
}

let personalSent = false;

/** The background-worker checker. `personal` words are sent once (the user's dictionary). */
export function workerChecker(personal: string[] = []): SpellChecker {
  const ensurePersonal = async () => { if (personalSent) return; personalSent = true; for (const w of personal) await call({ type: 'add', word: w }); };
  return {
    async check(words) {
      await ensurePersonal();
      const out = new Set<string>();
      for (let i = 0; i < words.length; i += 2000) {
        const r = await call({ type: 'check', words: words.slice(i, i + 2000) });
        if (r.failed) throw new Error('The spelling checker could not start on this device.');
        if (r.error) throw new Error(r.error);
        for (const w of r.bad || []) out.add(w);
      }
      return out;
    },
    async suggest(word) { return (await call({ type: 'suggest', word })).suggestions || []; },
    async add(word) { await call({ type: 'add', word }); },
    async remove(word) { await call({ type: 'remove', word }); },
  };
}

// --------------------------------------------------------------------------------------------
// Words of a page

export interface SpellOptions { ignoreUpper?: boolean; ignoreDigits?: boolean; ignoreMixed?: boolean }
export const DEFAULT_SPELL_OPTIONS: SpellOptions = { ignoreUpper: true, ignoreDigits: true, ignoreMixed: true };

export interface SpellWord { word: string; start: number; end: number; lang: string }

const SKIP = new Set(['script', 'style', 'code', 'pre', 'kbd', 'samp', 'var', 'textarea', 'template', 'noscript', 'svg', 'math', 'head', 'xmp', 'tt']);

/** Words in a text run (already decoded), with their indexes in it. */
export function wordsInText(text: string, opts: SpellOptions = DEFAULT_SPELL_OPTIONS): { word: string; index: number }[] {
  const out: { word: string; index: number }[] = [];
  const re = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const w = m[0];
    const before = text[m.index - 1] || ' ';
    const after = text[m.index + w.length] || ' ';
    if ([...w].length < 2) continue;
    if (opts.ignoreDigits !== false && (/\d/.test(before) || /\d/.test(after) || before === '_' || after === '_')) continue;
    if (opts.ignoreUpper !== false && w === w.toUpperCase() && w !== w.toLowerCase()) continue;
    if (opts.ignoreMixed !== false && /\p{Ll}\p{Lu}/u.test(w)) continue;
    // Addresses and file names: the word sits in a run with ://, @, a dot followed by letters, or a slash.
    const s = text.lastIndexOf(' ', m.index) + 1;
    let e = text.indexOf(' ', m.index);
    if (e < 0) e = text.length;
    const chunk = text.slice(s, e);
    if (/:\/\/|@|www\.|\w\.\w+\/|\.(com|org|net|html?|php|css|js|png|jpe?g|gif|svg|pdf)\b|\\|\/\w/.test(chunk)) continue;
    out.push({ word: w, index: m.index });
  }
  return out;
}

/** The checkable words of a page's source, with their source ranges, in order. */
export function pageWords(src: string, opts: SpellOptions = DEFAULT_SPELL_OPTIONS): SpellWord[] {
  const { root } = parseHtml(src);
  const out: SpellWord[] = [];
  const walk = (n: HNode, lang: string, inTitle: boolean) => {
    for (const c of n.children) {
      if (c.type === 'text') {
        const d = decodeWithMap(c.text, c.start);
        for (const w of wordsInText(d.text, opts)) {
          const last = w.index + w.word.length - 1;
          out.push({ word: w.word, start: d.from[w.index], end: d.to[last], lang });
        }
        continue;
      }
      if (c.type !== 'el') continue;
      if (c.name === 'title' && !c.foreign) { walk(c, lang, true); continue; }
      if (SKIP.has(c.name) || c.foreign) continue;
      if (attr(c, 'spellcheck') === 'false' || attr(c, 'translate') === 'no' || hasAttr(c, 'hidden') || /\bnotranslate\b/.test(attr(c, 'class') || '')) continue;
      walk(c, attr(c, 'lang') ?? lang, inTitle);
    }
  };
  // The title is in the head, which is otherwise skipped.
  const head = findFirst(root, 'head');
  const title = head ? findFirst(head, 'title') : null;
  const html = findFirst(root, 'html');
  const lang = (html && attr(html, 'lang')) || '';
  if (title) walk(title, lang, true);
  walk(root, lang, false);
  return out.sort((a, b) => a.start - b.start).filter((w, i, arr) => i === 0 || arr[i - 1].start !== w.start);
}

function findFirst(n: HNode, name: string): HNode | null {
  for (const c of n.children) { if (c.type !== 'el') continue; if (c.name === name) return c; const f = findFirst(c, name); if (f) return f; }
  return null;
}

/** True for a language tag the bundled (English) dictionary covers, or none. */
export const isEnglish = (lang: string | null | undefined) => !lang || /^en([-_]|$)/i.test(lang);

/** Escapes a replacement word for page text. */
export const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Replaces one word's source range, checking first that the range still holds the expected word. */
export function replaceWord(src: string, w: { start: number; end: number; word: string }, replacement: string): string | null {
  const cur = decodeWithMap(src.slice(w.start, w.end)).text;
  if (cur !== w.word) return null;
  return src.slice(0, w.start) + escText(replacement) + src.slice(w.end);
}

// --------------------------------------------------------------------------------------------
// Thesaurus (small offline list; the Datamuse service adds more when allowed)

export const THESAURUS: Record<string, string[]> = {
  big: ['large', 'huge', 'vast', 'sizable', 'substantial', 'major'], small: ['little', 'tiny', 'compact', 'minor', 'modest', 'slight'], good: ['fine', 'excellent', 'great', 'sound', 'solid', 'favorable'], bad: ['poor', 'awful', 'faulty', 'harmful', 'inferior', 'unpleasant'],
  fast: ['quick', 'rapid', 'swift', 'speedy', 'brisk'], slow: ['gradual', 'leisurely', 'sluggish', 'unhurried'], easy: ['simple', 'effortless', 'straightforward', 'painless'], hard: ['difficult', 'tough', 'demanding', 'firm', 'solid'],
  important: ['significant', 'essential', 'key', 'vital', 'crucial', 'major'], new: ['fresh', 'recent', 'modern', 'novel', 'latest'], old: ['aged', 'former', 'previous', 'ancient', 'vintage'], happy: ['glad', 'cheerful', 'pleased', 'content', 'delighted'],
  sad: ['unhappy', 'sorrowful', 'gloomy', 'downcast'], beautiful: ['lovely', 'attractive', 'stunning', 'gorgeous', 'elegant'], help: ['assist', 'aid', 'support', 'serve'], show: ['display', 'present', 'reveal', 'demonstrate', 'exhibit'],
  make: ['create', 'build', 'produce', 'form', 'construct'], use: ['employ', 'apply', 'utilize', 'operate'], get: ['obtain', 'acquire', 'receive', 'gain', 'fetch'], give: ['provide', 'offer', 'supply', 'grant', 'hand'],
  start: ['begin', 'launch', 'open', 'commence', 'initiate'], end: ['finish', 'close', 'conclude', 'stop', 'complete'], change: ['alter', 'modify', 'adjust', 'revise', 'transform'], buy: ['purchase', 'acquire', 'order'],
  idea: ['concept', 'notion', 'thought', 'plan', 'proposal'], problem: ['issue', 'difficulty', 'trouble', 'obstacle', 'challenge'], result: ['outcome', 'effect', 'consequence', 'finding'], goal: ['aim', 'objective', 'target', 'purpose'],
  improve: ['enhance', 'better', 'refine', 'upgrade', 'boost'], choose: ['select', 'pick', 'opt for', 'decide on'], need: ['require', 'want', 'lack'], offer: ['provide', 'propose', 'present', 'extend'],
  great: ['excellent', 'superb', 'outstanding', 'wonderful', 'remarkable'], nice: ['pleasant', 'agreeable', 'kind', 'lovely'], many: ['numerous', 'several', 'countless', 'various'], often: ['frequently', 'regularly', 'commonly', 'repeatedly'],
  quickly: ['rapidly', 'swiftly', 'promptly', 'speedily'], very: ['extremely', 'highly', 'really', 'truly', 'quite'], say: ['state', 'mention', 'remark', 'note'], think: ['believe', 'consider', 'suppose', 'reckon'],
  look: ['glance', 'view', 'watch', 'examine', 'appear'], find: ['discover', 'locate', 'detect', 'uncover'], keep: ['retain', 'hold', 'maintain', 'preserve'], team: ['group', 'crew', 'staff', 'squad'],
  customer: ['client', 'buyer', 'patron', 'consumer'], price: ['cost', 'charge', 'fee', 'rate'], fix: ['repair', 'mend', 'correct', 'resolve'], clear: ['plain', 'obvious', 'evident', 'transparent'],
  strong: ['powerful', 'sturdy', 'robust', 'tough'], free: ['complimentary', 'gratis', 'available', 'unrestricted'], simple: ['plain', 'basic', 'easy', 'uncomplicated'], unique: ['distinctive', 'singular', 'exclusive', 'one-of-a-kind'],
};

export function offlineSynonyms(word: string): string[] {
  const w = word.toLowerCase();
  if (THESAURUS[w]) return THESAURUS[w];
  const rev = Object.entries(THESAURUS).filter(([, l]) => l.includes(w)).map(([k]) => k);
  return rev;
}
