/**
 * Behaviors (Format/Insert > Behaviors in desktop web editors): event → action pairs on page elements.
 * The data lives in data-ql-behaviors on each element; one generated <script id="ql-behaviors"> at the end
 * of the body wires them up (editor/behaviors.ts). Design view runs no scripts, so Preview shows them working.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import { h } from '../ui/dom';
import '../ui/panesBehavior';
import { isPage, mutate, selectedEl, view } from '../editor/ops';
import {
  ACTIONS, EVENTS, BEHAVIOR_ATTR, BEHAVIOR_SCRIPT_ID, actionDef, describeBehavior, generateBehaviorScript, parseBehaviors, serializeBehaviors,
  type Behavior,
} from '../editor/behaviors';

// ------------------------------------------------------------------------------------------
// Page data

export function behaviorsOf(el: Element | null | undefined): Behavior[] {
  return el ? parseBehaviors(el.getAttribute(BEHAVIOR_ATTR)) : [];
}

/** Every element of the document that carries behaviors. */
export function behaviorElements(doc: Document): Element[] {
  return [...doc.querySelectorAll(`[${BEHAVIOR_ATTR}]`)].filter((e) => !e.closest('[data-ql-ui]'));
}

/**
 * Regenerates <script id="ql-behaviors"> from every element's data attribute: creates it at the end of the
 * body, replaces its text, or removes it when the page has no behaviors left. Idempotent.
 */
export function syncBehaviorScript(doc: Document): void {
  const all = behaviorElements(doc).flatMap((e) => behaviorsOf(e));
  const js = generateBehaviorScript(all);
  const existing = [...doc.querySelectorAll(`script#${BEHAVIOR_SCRIPT_ID}`)];
  for (const s of existing.slice(1)) s.remove();
  let script = existing[0] as HTMLScriptElement | undefined;
  if (!js) { script?.remove(); return; }
  if (!script) {
    script = doc.createElement('script');
    script.id = BEHAVIOR_SCRIPT_ID;
  }
  if (script.textContent !== '\n' + js + '\n') script.textContent = '\n' + js + '\n';
  // Keep it the last element of the body so every element exists when it runs.
  const body = doc.body;
  if (body && body.lastElementChild !== script) {
    body.appendChild(doc.createTextNode('\n'));
    body.appendChild(script);
    body.appendChild(doc.createTextNode('\n'));
  }
}

/** Replaces an element's behaviors and regenerates the script, as one undoable edit. */
export function setBehaviors(app: App, el: Element, list: Behavior[]): boolean {
  return mutate(app, (doc) => {
    const v = serializeBehaviors(list);
    if (v) el.setAttribute(BEHAVIOR_ATTR, v); else el.removeAttribute(BEHAVIOR_ATTR);
    syncBehaviorScript(doc);
  });
}

export function describeEl(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('');
  return `<${el.tagName.toLowerCase()}${id}${cls}>`;
}

/** The element behaviors should attach to: the selection, or null with a message. */
function targetEl(app: App): Element | null {
  const v = view(app);
  if (!isPage(app)) { toast('Open a page first.'); return null; }
  if (!v?.design?.doc || v.tab.view === 'code' || v.tab.view === 'preview') {
    if (v) app.setView(v.tab, 'split');
    toast('Select an element in Design view, then add the behavior.');
    return null;
  }
  return selectedEl(app);
}

function defaultEvent(el: Element, action?: string): string {
  const a = action ? actionDef(action) : undefined;
  const tag = el.tagName;
  if (action === 'jumpMenu') return 'change';
  if (action === 'validateForm') return tag === 'FORM' ? 'submit' : 'click';
  if (a?.event === 'load' || a?.event === 'mouseover' || a?.event === 'mouseout') return a.event;
  if (tag === 'BODY') return 'load';
  if (tag === 'FORM') return 'submit';
  if (tag === 'SELECT') return 'change';
  return a?.event || 'click';
}

// ------------------------------------------------------------------------------------------
// The behavior dialog

/** Asks for a behavior (new, or editing `existing`). Resolves to the behavior, or null when canceled. */
export async function behaviorDialog(app: App, el: Element, existing?: Behavior, presetAction?: string): Promise<Behavior | null> {
  const action = existing?.action || presetAction || 'popupMessage';
  const fields: Field[] = [
    { key: '_el', type: 'info', html: '' },
    { key: 'action', label: 'Action', type: 'select', value: action, options: ACTIONS.map((a) => ({ value: a.id, label: a.label })) },
    { key: 'event', label: 'Event', type: 'select', value: existing?.event || defaultEvent(el, action), options: EVENTS },
  ];
  for (const a of ACTIONS) {
    if (a.note) fields.push({ key: `${a.id}__note`, type: 'info', label: a.note, visibleIf: (v) => v.action === a.id });
    for (const p of a.params) {
      const cur = existing && existing.action === a.id ? existing.params?.[p.key] : undefined;
      fields.push({
        key: `${a.id}__${p.key}`, label: p.label, type: p.type, value: cur ?? p.value ?? (p.type === 'checkbox' ? false : ''),
        options: p.options, placeholder: p.placeholder, help: p.help, rows: p.type === 'textarea' ? 4 : undefined,
        visibleIf: (v) => v.action === a.id,
      });
    }
  }
  const info = h('p', { class: 'ql-help' }, `Element: ${describeEl(el)}. The page wires behaviors up with a generated script; Design view does not run scripts, so use Preview to try them.`);
  let lastAction = action;
  const r = await openDialog({
    title: existing ? 'Edit Behavior' : 'Add Behavior', content: info, fields, wide: true,
    onChange: (v, ctl, key) => {
      // A new action suggests its usual event (unless the user already chose one for this behavior).
      if (key === 'action' && v.action !== lastAction) { lastAction = v.action; if (!existing) ctl.set('event', defaultEvent(el, v.action)); }
    },
    validate: (v) => {
      const a = actionDef(v.action);
      if (!a) return 'Choose an action.';
      const need = (k: string) => String(v[`${a.id}__${k}`] ?? '').trim();
      if ((a.id === 'goToUrl' || a.id === 'openWindow') && !need('url')) return 'Type the address to open.';
      if ((a.id === 'swapImage' || a.id === 'playSound') && !need('src')) return 'Type the file address.';
      if (a.id === 'changeProperty' && !need('property')) return 'Type the CSS property to change.';
      if (a.id === 'showHide' && !need('show') && !need('hide') && !need('toggle')) return 'Type at least one element id.';
      if (a.id === 'setText' && v[`${a.id}__kind`] !== 'status' && !need('target') && /^(BODY|HTML)$/.test(el.tagName)) return 'Type the id of the element whose text changes.';
      return null;
    },
  });
  if (!r) return null;
  const a = actionDef(r.action)!;
  const params: Record<string, any> = {};
  for (const p of a.params) {
    let val = r[`${a.id}__${p.key}`];
    if (typeof val === 'string') val = p.type === 'textarea' ? val.replace(/\r\n/g, '\n') : val.trim();
    if (val === '' || val == null) continue;
    params[p.key] = val;
  }
  return { event: r.event, action: a.id, params };
}

/** Adds a behavior to the selected element (from a dialog, or directly from `arg` for macros). */
async function addBehavior(app: App, presetAction?: string, arg?: any): Promise<void> {
  let el = targetEl(app);
  if (!el) return;
  let b: Behavior | null;
  if (arg && typeof arg === 'object' && (arg.action || presetAction)) {
    b = { event: arg.event || defaultEvent(el, arg.action || presetAction), action: arg.action || presetAction!, params: arg.params || {} };
  } else {
    b = await behaviorDialog(app, el, undefined, presetAction);
  }
  if (!b) return;
  if (!el.isConnected) { toast('The page changed while the dialog was open; select the element again.'); return; }
  // Form validation belongs on the form; a jump menu on its select.
  if (b.action === 'validateForm' && el.tagName !== 'FORM' && b.event === 'submit') el = el.closest('form') || el;
  if (b.action === 'jumpMenu' && el.tagName !== 'SELECT') el = el.querySelector('select') || el.closest('select') || el;
  if (b.action === 'swapImage' && !b.params.target && el.tagName !== 'IMG' && !el.querySelector('img')) toast('Tip: this element is not a picture; type the id of the image to swap.');
  const list = [...behaviorsOf(el), b];
  if (setBehaviors(app, el, list)) {
    toast(`Added ${describeBehavior(b)} to ${describeEl(el)}. Use Preview to try it.`);
    view(app)?.design?.select(el);
  }
}

export async function editBehavior(app: App, el: Element, index: number): Promise<void> {
  const list = behaviorsOf(el);
  const cur = list[index];
  if (!cur) return;
  const b = await behaviorDialog(app, el, cur);
  if (!b || !el.isConnected) return;
  list[index] = b;
  setBehaviors(app, el, list);
}

export function deleteBehavior(app: App, el: Element, index: number): void {
  const list = behaviorsOf(el);
  if (!list[index]) return;
  list.splice(index, 1);
  setBehaviors(app, el, list);
}

export function moveBehavior(app: App, el: Element, index: number, by: number): void {
  const list = behaviorsOf(el);
  const j = index + by;
  if (!list[index] || j < 0 || j >= list.length) return;
  [list[index], list[j]] = [list[j], list[index]];
  setBehaviors(app, el, list);
}

async function removeBehaviors(app: App, arg?: any): Promise<void> {
  const el = targetEl(app);
  if (!el) return;
  const list = behaviorsOf(el);
  if (!list.length) { toast(`${describeEl(el)} has no behaviors. Behavior List shows every behavior on the page.`); return; }
  if (arg === 'all') { setBehaviors(app, el, []); return; }
  if (typeof arg === 'number') { deleteBehavior(app, el, arg); return; }
  if (list.length === 1) {
    if (await confirmDialog('Remove Behavior', `Remove ${describeBehavior(list[0])} from ${describeEl(el)}?`, 'Remove')) setBehaviors(app, el, []);
    return;
  }
  const r = await openDialog({
    title: 'Remove Behaviors', ok: 'Remove',
    fields: [{ key: 'which', label: `Behaviors of ${describeEl(el)} (select the ones to remove)`, type: 'list', multiple: true, rows: Math.min(10, list.length + 1), options: list.map((b, i) => ({ value: String(i), label: describeBehavior(b) })) }],
  });
  if (!r) return;
  const drop = new Set((r.which as string[]).map(Number));
  if (!drop.size) return;
  setBehaviors(app, el, list.filter((_b, i) => !drop.has(i)));
}

async function listBehaviors(app: App): Promise<void> {
  const v = view(app);
  if (!isPage(app) || !v) { toast('Open a page first.'); return; }
  if (!v.design?.doc || v.tab.view === 'code' || v.tab.view === 'preview') { app.setView(v.tab, 'split'); toast('Switched to Split view; run Behavior List again.'); return; }
  const doc = v.design.doc;
  const els = behaviorElements(doc);
  const table = h('table', { class: 'ql-behavior-list', style: 'width:100%;border-collapse:collapse;text-align:left' },
    h('caption', { class: 'ql-help' }, els.length ? `${els.reduce((n, e) => n + behaviorsOf(e).length, 0)} behavior(s) on ${els.length} element(s). Select a row to select the element.` : 'This page has no behaviors.'),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Element'), h('th', { scope: 'col' }, 'Event'), h('th', { scope: 'col' }, 'Action'))),
    h('tbody', null, ...els.flatMap((e) => behaviorsOf(e).map((b) => {
      const a = actionDef(b.action);
      const tr = h('tr', { tabindex: '0', style: 'cursor:pointer' }, h('td', null, describeEl(e)), h('td', null, 'on' + b.event), h('td', null, `${a?.label || b.action}${a ? ' – ' + a.summary(b.params || {}) : ''}`));
      const pick = () => { v.design?.select(e); app.refresh(); };
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', (ev) => { if ((ev as KeyboardEvent).key === 'Enter') pick(); });
      return tr;
    }))));
  const hasScript = !!doc.getElementById(BEHAVIOR_SCRIPT_ID);
  await openDialog({
    title: 'Behavior List', content: h('div', null, table), wide: true, ok: 'Close', cancel: false,
    buttons: [
      { label: 'Behaviors Panel', onClick: (_v, ctl) => { ctl.close({}); app.ui.togglePane('behaviors'); } },
      { label: hasScript || els.length ? 'Regenerate Script' : 'Remove Script', onClick: (_v, ctl) => { mutate(app, (d) => syncBehaviorScript(d)); toast('The behaviors script was regenerated.'); ctl.close({}); } },
      ...(els.length ? [{ label: 'Remove All', onClick: async (_v: any, ctl: any) => {
        ctl.close({});
        if (!(await confirmDialog('Remove All Behaviors', 'Remove every behavior on this page, and the generated script?', 'Remove All'))) return;
        mutate(app, (d) => { for (const e of behaviorElements(d)) e.removeAttribute(BEHAVIOR_ATTR); syncBehaviorScript(d); });
      } }] : []),
    ],
  });
}

// ------------------------------------------------------------------------------------------

const ORIGIN = 'Expression Web, Dreamweaver, FrontPage';

def([
  { id: 'behavior.add', label: 'Add Behavior', icon: 'bolt', tab: 'Developer', group: 'Behaviors', edits: true, popular: true, origin: ORIGIN, isEnabled: isPage,
    keywords: 'event action javascript interactivity onclick rollover', tip: 'Attach an action to an event of the selected element (generated JavaScript).',
    run: (app, arg) => addBehavior(app, arg?.action, arg) },
  ...ACTIONS.map((a) => ({
    id: `behavior.${a.id}`, label: a.label, icon: a.icon, tab: 'Developer', group: 'Behaviors', edits: true, origin: a.origin, isEnabled: isPage,
    keywords: `behavior ${a.id}`, tip: `Behavior: ${a.label}${a.note ? '. ' + a.note : ''}`,
    run: (app: App, arg?: any) => addBehavior(app, a.id, arg),
  })),
  { id: 'behavior.remove', label: 'Remove Behavior', icon: 'delete', tab: 'Developer', group: 'Behaviors', edits: true, origin: ORIGIN, isEnabled: isPage,
    tip: 'Remove behaviors from the selected element.', run: (app, arg) => removeBehaviors(app, arg) },
  { id: 'behavior.list', label: 'Behavior List', icon: 'list', tab: 'Developer', group: 'Behaviors', noRecord: true, origin: ORIGIN, isEnabled: isPage,
    tip: 'Every behavior on the page; regenerate or remove the behaviors script.', run: (app) => listBehaviors(app) },
]);
