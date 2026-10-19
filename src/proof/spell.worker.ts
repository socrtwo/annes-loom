/// <reference lib="webworker" />
/**
 * Spelling worker: Hunspell-compatible checking with nspell and the SCOWL-based American English
 * dictionary (dictionary-en). The dictionary is loaded on the first request, so it only takes memory
 * (and download time) once someone checks spelling. Words added to the user's dictionary arrive with
 * 'add' messages.
 */
import nspell from 'nspell';

type Speller = ReturnType<typeof nspell>;
let speller: Promise<Speller> | null = null;
const personal = new Set<string>();
const cache = new Map<string, boolean>();

function load(): Promise<Speller> {
  if (!speller) {
    speller = Promise.all([
      import('../../node_modules/dictionary-en/index.aff?raw'),
      import('../../node_modules/dictionary-en/index.dic?raw'),
    ]).then(([aff, dic]) => {
      const sp = nspell(aff.default, dic.default);
      for (const w of personal) sp.add(w);
      return sp;
    });
    speller.catch(() => { speller = null; });
  }
  return speller;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { id: number; type: 'check' | 'suggest' | 'add' | 'remove'; words?: string[]; word?: string };
  const reply = (v: Record<string, unknown>) => (self as any).postMessage({ id: msg.id, ...v });
  try {
    if (msg.type === 'add' && msg.word) {
      personal.add(msg.word);
      cache.set(msg.word, true);
      if (speller) (await speller).add(msg.word);
      reply({ ok: true });
      return;
    }
    if (msg.type === 'remove' && msg.word) {
      personal.delete(msg.word);
      cache.delete(msg.word);
      if (speller) (await speller).remove(msg.word);
      reply({ ok: true });
      return;
    }
    const sp = await load();
    if (msg.type === 'suggest' && msg.word) { reply({ suggestions: sp.suggest(msg.word).slice(0, 10) }); return; }
    const bad: string[] = [];
    for (const w of msg.words || []) {
      let ok = cache.get(w);
      if (ok === undefined) {
        ok = sp.correct(w) || (/^[A-Z]/.test(w) && sp.correct(w.toLowerCase())) || (/[’']s$/.test(w) && sp.correct(w.replace(/[’']s$/, ''))) || (w.includes('’') && sp.correct(w.replace(/’/g, "'")));
        cache.set(w, ok);
      }
      if (!ok) bad.push(w);
    }
    reply({ bad });
  } catch (err) {
    reply({ bad: [], suggestions: [], error: String((err as Error)?.message || err) });
  }
};
