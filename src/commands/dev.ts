/** Developer: macros (recorded lists of commands), the macro editor, macro import/export, and the site as JSON. */
import { def, getCommand } from './registry';
import type { App } from '../app';
import type { Macro } from '../prefs';
import { sanitizePrefs } from '../prefs';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { download, pickFile } from '../ui/dom';

let running = 0;

/** Runs a macro's steps in order, waiting for each command that works asynchronously. */
export async function runMacro(app: App, name: string): Promise<void> {
  const m = app.prefs.macros.find((x) => x.name === name);
  if (!m) { toast(`No macro named "${name}".`); return; }
  if (running > 8) { toast('Macros are calling each other too deeply; stopped.'); return; }
  running++;
  try {
    for (const s of m.steps) {
      if (s.id === 'dev.runMacro' && s.arg === name) continue; // never recurse into itself
      if (!getCommand(s.id)) { toast(`Macro "${name}" stopped: the command ${s.id} no longer exists.`); return; }
      const r = app.exec(s.id, s.arg);
      if (r instanceof Promise) await r;
      if (r === false) { toast(`Macro "${name}" stopped at ${getCommand(s.id)?.label || s.id}.`); return; }
    }
  } finally { running--; }
}

/** Parses the macro editor's text: one step per line, a command id and an optional JSON argument; # starts a comment. */
export function parseMacroText(text: string): { steps: Macro['steps']; error: string | null } {
  const steps: Macro['steps'] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sp = t.search(/\s/);
    const id = sp < 0 ? t : t.slice(0, sp);
    const rest = sp < 0 ? '' : t.slice(sp + 1).trim();
    if (!getCommand(id)) return { steps, error: `Line ${i + 1}: unknown command "${id}".` };
    if (rest) {
      try { steps.push({ id, arg: JSON.parse(rest) }); } catch { return { steps, error: `Line ${i + 1}: the argument is not valid JSON.` }; }
    } else steps.push({ id });
  }
  return { steps, error: null };
}

export function macroText(m: Macro | undefined): string {
  return m ? m.steps.map((s) => (s.arg === undefined ? s.id : `${s.id} ${JSON.stringify(s.arg)}`)).join('\n') : '# One command per line: its id, then an optional JSON argument, for example:\n# file.newPage\n# file.newPage {"dir":"blog"}\n';
}

function stepsLabel(m: Macro): string {
  return m.steps.map((s) => getCommand(s.id)?.label || s.id).slice(0, 6).join(' → ') + (m.steps.length > 6 ? ' …' : '');
}

const addToQat = (app: App, name: string) => { if (!app.prefs.qat.includes(`macro:${name}`)) app.prefs.qat = [...app.prefs.qat, `macro:${name}`]; app.savePrefs(); app.ui.renderQat(); };

def([
  {
    id: 'dev.macros', label: 'Macros', icon: 'smart_button', tab: 'Developer', group: 'Macros', keys: ['Alt-F8'], edits: false, noRecord: true,
    tip: 'Run, edit, rename, delete or put a macro on the Quick Access Bar',
    run: async (app) => {
      const ms = app.prefs.macros;
      if (!ms.length) { toast('No macros yet. Use Record Macro to make one.', { action: 'Record', onAction: () => void app.exec('dev.recordMacro') }); return; }
      const r = await openDialog({ title: 'Macros', fields: [
        { key: 'm', label: 'Macro', type: 'list', options: ms.map((m) => ({ value: m.name, label: `${m.name} — ${m.description ? m.description + ': ' : ''}${stepsLabel(m)}` })), value: ms[0].name },
        { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'run', label: 'Run' }, { value: 'edit', label: 'Edit…' }, { value: 'rename', label: 'Rename…' }, { value: 'key', label: 'Assign a shortcut…' }, { value: 'qat', label: 'Add to Quick Access Bar' }, { value: 'delete', label: 'Delete' }], value: 'run' },
      ], buttons: [{ label: 'New…', onClick: (_v, ctl) => { ctl.close(); void app.exec('dev.macroEditor', ''); } }] });
      if (!r?.m) return;
      const m = ms.find((x) => x.name === r.m)!;
      if (r.act === 'run') await runMacro(app, m.name);
      else if (r.act === 'edit') await app.exec('dev.macroEditor', m.name);
      else if (r.act === 'key') app.ui.customizeKeyboard(`macro:${m.name}`);
      else if (r.act === 'rename') {
        const n = (await promptDialog('Rename Macro', 'Name', m.name))?.trim();
        if (!n || n === m.name) return;
        if (ms.some((x) => x.name === n)) { toast(`There is already a macro named "${n}".`); return; }
        const old = m.name;
        m.name = n;
        app.prefs.qat = app.prefs.qat.map((q) => (q === `macro:${old}` ? `macro:${n}` : q));
        for (const [k, id] of Object.entries(app.prefs.keymap)) if (id === `macro:${old}`) app.prefs.keymap[k] = `macro:${n}`;
        app.savePrefs(); app.ui.renderQat();
      } else if (r.act === 'qat') addToQat(app, m.name);
      else if (r.act === 'delete' && (await confirmDialog('Delete Macro', `Delete "${m.name}"?`, 'Delete'))) {
        app.prefs.macros = ms.filter((x) => x !== m);
        app.prefs.qat = app.prefs.qat.filter((q) => q !== `macro:${m.name}`);
        for (const [k, id] of Object.entries(app.prefs.keymap)) if (id === `macro:${m.name}`) delete app.prefs.keymap[k];
        app.savePrefs(); app.ui.renderQat();
      }
    },
  },
  { id: 'dev.runMacro', label: 'Run Macro', icon: 'play_arrow', tab: 'Developer', group: 'Macros', internal: true, noRecord: true, edits: false, run: (app, name: string) => runMacro(app, name) },
  {
    id: 'dev.recordMacro', label: 'Record Macro', icon: 'fiber_manual_record', tab: 'Developer', group: 'Macros', kind: 'toggle', noRecord: true, edits: false, origin: 'Dreamweaver (Start Recording)',
    tip: 'Record the commands you run (formatting, inserting, new pages, saving) to replay them later',
    isActive: (app) => !!app.recording,
    run: async (app) => {
      if (app.recording) { await app.exec('dev.stopRecording'); return; }
      const name = (await promptDialog('Record Macro', 'Macro name', `Macro${app.prefs.macros.length + 1}`))?.trim();
      if (!name) return;
      if (app.prefs.macros.some((m) => m.name === name) && !(await confirmDialog('Record Macro', `Replace the macro "${name}"?`, 'Replace'))) return;
      app.recording = { name, steps: [] };
      app.recordingPaused = false;
      app.ui.status?.('● Recording macro');
      toast('Recording. Commands you run from the ribbon, menus, shortcuts or search are recorded; typing in the page is not.', { ms: 6000 });
    },
  },
  {
    id: 'dev.stopRecording', label: 'Stop Recording', icon: 'stop', tab: 'Developer', group: 'Macros', noRecord: true, edits: false, isEnabled: (app) => !!app.recording,
    run: (app) => {
      const rec = app.recording;
      if (!rec) return;
      app.recording = null;
      app.recordingPaused = false;
      app.ui.status?.('');
      if (!rec.steps.length) { toast('Nothing was recorded.'); return; }
      app.prefs.macros = [...app.prefs.macros.filter((m) => m.name !== rec.name), { name: rec.name, steps: rec.steps, created: Date.now() }];
      app.savePrefs();
      toast(`Macro "${rec.name}" saved with ${rec.steps.length} step${rec.steps.length === 1 ? '' : 's'}.`, { action: 'Add to Quick Access Bar', onAction: () => addToQat(app, rec.name) });
    },
  },
  {
    id: 'dev.pauseRecording', label: 'Pause Recording', icon: 'pause', tab: 'Developer', group: 'Macros', kind: 'toggle', noRecord: true, edits: false, isEnabled: (app) => !!app.recording,
    isActive: (app) => !!app.recording && app.recordingPaused,
    run: (app) => { if (!app.recording) return; app.recordingPaused = !app.recordingPaused; app.ui.status?.(app.recordingPaused ? '⏸ Recording paused' : '● Recording macro'); },
  },
  {
    id: 'dev.playLast', label: 'Play Recorded Macro', icon: 'replay', tab: 'Developer', group: 'Macros', noRecord: true, edits: false, origin: 'Dreamweaver (Play Recorded Command)',
    tip: 'Run the most recently recorded or edited macro',
    isEnabled: (app) => app.prefs.macros.length > 0 && !app.recording,
    run: async (app) => {
      const last = [...app.prefs.macros].sort((a, b) => b.created - a.created)[0];
      if (!last) { toast('No macros yet.'); return; }
      await runMacro(app, last.name);
    },
  },
  {
    id: 'dev.macroEditor', label: 'Macro Editor', icon: 'code', tab: 'Developer', group: 'Macros', noRecord: true, edits: false,
    tip: 'Edit a macro\'s steps (one command per line: id and an optional JSON argument)',
    run: async (app, name?: string) => {
      const ms = app.prefs.macros;
      const m = name === '' ? undefined : ms.find((x) => x.name === name) || ms[0];
      const r = await openDialog({ title: m ? `Edit Macro: ${m.name}` : 'New Macro', wide: true, fields: [
        { key: 'name', label: 'Name', type: 'text', value: m?.name || `Macro${ms.length + 1}` },
        { key: 'desc', label: 'Description', type: 'text', value: m?.description || '' },
        { key: 'steps', label: 'Steps', type: 'textarea', rows: 14, value: macroText(m), help: 'Find command ids in Help ▸ Command Reference or the Customize dialogs. Macros run QuillLoom commands only; they cannot run code or reach the network on their own.' },
      ], validate: (v) => (!String(v.name || '').trim() ? 'Give the macro a name.' : parseMacroText(String(v.steps)).error) });
      if (!r) return;
      const { steps } = parseMacroText(String(r.steps));
      const nm = String(r.name).trim();
      app.prefs.macros = [...ms.filter((x) => x.name !== nm && x !== m), { name: nm, description: r.desc || undefined, steps, created: Date.now() }];
      if (m && m.name !== nm) app.prefs.qat = app.prefs.qat.map((q) => (q === `macro:${m.name}` ? `macro:${nm}` : q));
      app.savePrefs();
      app.ui.renderQat();
      toast(`Saved "${nm}".`, { action: 'Run', onAction: () => void runMacro(app, nm) });
    },
  },
  {
    id: 'dev.exportMacros', label: 'Export Macros…', icon: 'file_download', tab: 'Developer', group: 'Macros', noRecord: true, edits: false,
    run: (app) => {
      if (!app.prefs.macros.length) { toast('There are no macros to export.'); return; }
      download(new Blob([JSON.stringify({ format: 'quill-macros', version: 1, macros: app.prefs.macros }, null, 1)], { type: 'application/json' }), 'quillloom-macros.json');
    },
  },
  {
    id: 'dev.importMacros', label: 'Import Macros…', icon: 'file_upload', tab: 'Developer', group: 'Macros', noRecord: true, edits: false,
    run: async (app) => {
      const f = (await pickFile('.json,application/json'))[0];
      if (!f) return;
      let raw: any;
      try { raw = JSON.parse(await f.text()); } catch { toast('That file is not JSON.'); return; }
      const list = sanitizePrefs({ macros: Array.isArray(raw) ? raw : raw?.macros }).macros || [];
      if (!list.length) { toast('No macros were found in that file.'); return; }
      const unknown = new Set(list.flatMap((m) => m.steps.map((s) => s.id)).filter((id) => !getCommand(id)));
      const clash = list.filter((m) => app.prefs.macros.some((x) => x.name === m.name));
      if (clash.length && !(await confirmDialog('Import Macros', `${clash.length} macro${clash.length === 1 ? ' has' : 's have'} the same name as one you have (${clash.map((m) => m.name).join(', ')}). Replace ${clash.length === 1 ? 'it' : 'them'}?`, 'Replace'))) return;
      const names = new Set(list.map((m) => m.name));
      app.prefs.macros = [...app.prefs.macros.filter((m) => !names.has(m.name)), ...list.map((m) => ({ name: m.name, description: typeof m.description === 'string' ? m.description : undefined, steps: m.steps.map((s) => (s.arg === undefined ? { id: s.id } : { id: s.id, arg: s.arg })), created: +m.created || Date.now() }))];
      app.savePrefs();
      toast(`Imported ${list.length} macro${list.length === 1 ? '' : 's'}${unknown.size ? `; ${unknown.size} command${unknown.size === 1 ? '' : 's'} in them do not exist in this app (${[...unknown].slice(0, 3).join(', ')})` : ''}.`, { ms: unknown.size ? 8000 : 3000 });
    },
  },
  {
    id: 'dev.exportSiteJson', label: 'Export Site JSON', icon: 'data_object', tab: 'Developer', group: 'Tools', noRecord: true, edits: false,
    tip: 'The whole site (files, navigation, tasks, settings) as readable JSON, the .qlsite format',
    run: (app) => {
      for (const d of app.docs) d.ui.flush();
      download(new Blob([JSON.stringify(app.site.toJSON(), null, 1)], { type: 'application/json' }), `${(app.site.name || 'site').replace(/[\\/:*?"<>|]+/g, '_')}.json`);
    },
  },
]);
