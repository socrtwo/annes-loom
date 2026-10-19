/**
 * Forms: the form toolbox of desktop web editors (form, every HTML5 field type, labels, groups, buttons),
 * form and field properties, and HTML5 constraint validation. Every inserted field gets a <label> and a
 * unique name and id; a field inserted outside a form can be wrapped in a new one.
 */
import { def, getCommand, type MenuEntry } from './registry';
import type { App } from '../app';
import { openDialog, toast, choiceDialog } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import { attrString, closestSel, getAttr, insertHtml, isPage, mutate, selectedEl, selectionHtml, setAttr, view } from '../editor/ops';
import { esc, escAttr } from '../model/html';
import { generateValidationScript, jumpMenuHandler, VALIDATION_SCRIPT_ID } from '../editor/behaviors';

// ------------------------------------------------------------------------------------------
// Names and placement

/** Every id and name used on the page (source text and Design view). */
function usedNames(app: App): Set<string> {
  const s = new Set<string>();
  const src = app.active?.source || '';
  for (const m of src.matchAll(/\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) s.add((m[1] ?? m[2] ?? m[3]).toLowerCase());
  const doc = view(app)?.design?.doc;
  if (doc) for (const e of doc.querySelectorAll('[id],[name]')) { if (e.id) s.add(e.id.toLowerCase()); const n = e.getAttribute('name'); if (n) s.add(n.toLowerCase()); }
  return s;
}

/** A name not yet used on the page: base1, base2… */
export function uniqueName(app: App, base: string, taken = usedNames(app)): string {
  const b = base.replace(/[^\w-]/g, '') || 'field';
  for (let i = 1; ; i++) { const n = `${b}${i}`; if (!taken.has(n.toLowerCase())) { taken.add(n.toLowerCase()); return n; } }
}

/** Whether the caret is inside a <form> (Design view DOM, or the text around the Code view cursor). */
export function caretInForm(app: App): boolean {
  const v = view(app);
  if (!v) return false;
  if (v.target === 'design') return !!closestSel(app, 'form');
  const at = v.code?.selection.from ?? 0;
  const before = app.active.source.slice(0, at);
  return (before.match(/<form\b/gi)?.length || 0) > (before.match(/<\/form\s*>/gi)?.length || 0);
}

let wrapChoice: boolean | null = null;

/** Inserts field markup; outside a form, offers to wrap it in a new one (arg.wrap answers for macros). */
async function placeField(app: App, markup: string, wrap?: boolean): Promise<void> {
  if (!caretInForm(app)) {
    let w = wrap ?? wrapChoice;
    if (w == null) {
      const i = await choiceDialog('Insert Form Field', 'The cursor is not inside a form. A field only submits its value from inside a <form>. Wrap the field in a new form?', ['Wrap in a New Form', 'Insert the Field Only', 'Always Wrap (this session)']);
      if (i < 0) return;
      w = i !== 1;
      if (i === 2) wrapChoice = true;
    }
    if (w) markup = `<form method="post">\n${markup}\n<p><button type="submit">Submit</button></p>\n</form>`;
  }
  insertHtml(app, markup);
}

// ------------------------------------------------------------------------------------------
// Options lists: one per line, "Label = value", a leading * marks the selected one, [Group] starts a group.

export interface OptionItem { label: string; value: string; selected: boolean; group?: string }

export function parseOptions(text: string): OptionItem[] {
  const out: OptionItem[] = [];
  let group: string | undefined;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const g = /^\[(.*)\]$/.exec(line);
    if (g) { group = g[1].trim() || undefined; continue; }
    const selected = line.startsWith('*');
    const body = selected ? line.slice(1).trim() : line;
    const m = /\s+=(?:\s+|$)/.exec(body);
    const label = m ? body.slice(0, m.index).trim() : body;
    const value = m ? body.slice(m.index + m[0].length).trim() : body;
    out.push({ label, value, selected, group });
  }
  return out;
}

export function formatOptions(items: OptionItem[]): string {
  const out: string[] = [];
  let group: string | undefined;
  for (const o of items) {
    if (o.group !== group) { out.push(`[${o.group || ''}]`); group = o.group; }
    out.push(`${o.selected ? '*' : ''}${o.label}${o.value !== o.label ? ` = ${o.value}` : ''}`);
  }
  return out.join('\n');
}

export function optionsHtml(items: OptionItem[], indent = '  '): string {
  const out: string[] = [];
  let group: string | undefined;
  for (const o of items) {
    if (o.group !== group) {
      if (group !== undefined) out.push(`${indent}</optgroup>`);
      if (o.group !== undefined) out.push(`${indent}<optgroup label="${escAttr(o.group)}">`);
      group = o.group;
    }
    const pad = group !== undefined ? indent + '  ' : indent;
    out.push(`${pad}<option${o.value !== o.label ? ` value="${escAttr(o.value)}"` : ''}${o.selected ? ' selected' : ''}>${esc(o.label)}</option>`);
  }
  if (group !== undefined) out.push(`${indent}</optgroup>`);
  return out.join('\n');
}

function readOptions(sel: Element): OptionItem[] {
  return [...sel.querySelectorAll('option')].map((o) => ({
    label: (o.textContent || '').trim(), value: o.getAttribute('value') ?? (o.textContent || '').trim(), selected: o.hasAttribute('selected'),
    group: o.parentElement?.tagName === 'OPTGROUP' ? o.parentElement.getAttribute('label') || '' : undefined,
  }));
}

// ------------------------------------------------------------------------------------------
// Field kinds

interface Kind {
  id: string;
  label: string;
  icon: string;
  /** input type, or the element for non-input fields */
  type?: string;
  base: string;
  labelText: string;
  origin: string;
  keywords?: string;
}

const TEXTISH = new Set(['text', 'password', 'email', 'tel', 'url', 'search']);
const RANGEISH = new Set(['number', 'range', 'date', 'time', 'datetime-local', 'month', 'week']);

const KINDS: Kind[] = [
  { id: 'textbox', label: 'Text Box', icon: 'text_fields', type: 'text', base: 'text', labelText: 'Name:', origin: 'FrontPage, Expression Web, Dreamweaver' },
  { id: 'textarea', label: 'Text Area', icon: 'notes', type: 'textarea', base: 'message', labelText: 'Message:', origin: 'FrontPage, Expression Web, Dreamweaver', keywords: 'scrolling text box multiline' },
  { id: 'password', label: 'Password Box', icon: 'password', type: 'password', base: 'password', labelText: 'Password:', origin: 'FrontPage, Expression Web' },
  { id: 'email', label: 'Email Box', icon: 'alternate_email', type: 'email', base: 'email', labelText: 'Email:', origin: 'Dreamweaver (HTML5)' },
  { id: 'tel', label: 'Telephone Box', icon: 'call', type: 'tel', base: 'phone', labelText: 'Phone:', origin: 'Dreamweaver (HTML5)' },
  { id: 'url', label: 'URL Box', icon: 'link', type: 'url', base: 'website', labelText: 'Web site:', origin: 'Dreamweaver (HTML5)' },
  { id: 'number', label: 'Number Box', icon: 'pin', type: 'number', base: 'number', labelText: 'Quantity:', origin: 'Dreamweaver (HTML5)' },
  { id: 'range', label: 'Range Slider', icon: 'linear_scale', type: 'range', base: 'range', labelText: 'Level:', origin: 'Dreamweaver (HTML5)' },
  { id: 'date', label: 'Date Box', icon: 'calendar_today', type: 'date', base: 'date', labelText: 'Date:', origin: 'Dreamweaver (HTML5)' },
  { id: 'time', label: 'Time Box', icon: 'schedule', type: 'time', base: 'time', labelText: 'Time:', origin: 'Dreamweaver (HTML5)' },
  { id: 'datetime', label: 'Date and Time Box', icon: 'event', type: 'datetime-local', base: 'datetime', labelText: 'Date and time:', origin: 'Dreamweaver (HTML5)' },
  { id: 'month', label: 'Month Box', icon: 'calendar_month', type: 'month', base: 'month', labelText: 'Month:', origin: 'Dreamweaver (HTML5)' },
  { id: 'week', label: 'Week Box', icon: 'date_range', type: 'week', base: 'week', labelText: 'Week:', origin: 'Dreamweaver (HTML5)' },
  { id: 'color', label: 'Color Picker', icon: 'palette', type: 'color', base: 'color', labelText: 'Color:', origin: 'Dreamweaver (HTML5)' },
  { id: 'search', label: 'Search Box', icon: 'search', type: 'search', base: 'q', labelText: 'Search:', origin: 'Dreamweaver (HTML5)' },
  { id: 'file', label: 'File Upload', icon: 'upload_file', type: 'file', base: 'file', labelText: 'File:', origin: 'FrontPage, Expression Web, Dreamweaver' },
  { id: 'hidden', label: 'Hidden Field', icon: 'visibility_off', type: 'hidden', base: 'hidden', labelText: '', origin: 'FrontPage, Dreamweaver' },
  { id: 'checkbox', label: 'Check Box', icon: 'check_box', type: 'checkbox', base: 'check', labelText: 'I agree', origin: 'FrontPage, Expression Web, Dreamweaver' },
  { id: 'radio', label: 'Option Button', icon: 'radio_button_checked', type: 'radio', base: 'choice', labelText: 'Option', origin: 'FrontPage, Expression Web, Dreamweaver', keywords: 'radio button' },
  { id: 'radioGroup', label: 'Option Button Group', icon: 'radio_button_checked', type: 'radiogroup', base: 'choice', labelText: 'Choose one', origin: 'Dreamweaver (Radio Group)', keywords: 'radio group' },
  { id: 'select', label: 'Drop-Down Box', icon: 'arrow_drop_down_circle', type: 'select', base: 'select', labelText: 'Choose:', origin: 'FrontPage, Expression Web, Dreamweaver', keywords: 'select list menu' },
  { id: 'listBox', label: 'List Box', icon: 'list', type: 'listbox', base: 'list', labelText: 'Choose:', origin: 'FrontPage, Dreamweaver', keywords: 'select multiple' },
  { id: 'datalist', label: 'Text Box with Suggestions', icon: 'manage_search', type: 'datalist', base: 'pick', labelText: 'Choose or type:', origin: 'HTML5 datalist', keywords: 'datalist autocomplete combo' },
  { id: 'jumpMenu', label: 'Jump Menu', icon: 'menu_open', type: 'jumpmenu', base: 'jump', labelText: 'Go to:', origin: 'Dreamweaver, Expression Web', keywords: 'navigation drop-down' },
  { id: 'button', label: 'Input Button', icon: 'smart_button', type: 'button', base: 'button', labelText: 'Button', origin: 'FrontPage, Expression Web' },
  { id: 'submit', label: 'Submit Button', icon: 'send', type: 'submit', base: 'submit', labelText: 'Submit', origin: 'FrontPage, Expression Web, Dreamweaver' },
  { id: 'reset', label: 'Reset Button', icon: 'restart_alt', type: 'reset', base: 'reset', labelText: 'Reset', origin: 'FrontPage, Expression Web, Dreamweaver' },
  { id: 'imageButton', label: 'Picture Button', icon: 'image', type: 'image', base: 'imagebutton', labelText: 'Submit', origin: 'FrontPage, Expression Web, Dreamweaver (Image Field)' },
  { id: 'advancedButton', label: 'Advanced Button', icon: 'smart_button', type: 'buttonEl', base: 'button', labelText: 'Send', origin: 'FrontPage, Expression Web', keywords: 'button element html content' },
  { id: 'label', label: 'Label', icon: 'label', type: 'label', base: 'label', labelText: 'Label', origin: 'FrontPage, Expression Web, Dreamweaver' },
  { id: 'fieldset', label: 'Group Box', icon: 'select_all', type: 'fieldset', base: 'group', labelText: 'Group', origin: 'FrontPage, Expression Web, Dreamweaver (Fieldset)', keywords: 'fieldset legend' },
  { id: 'output', label: 'Output', icon: 'output', type: 'output', base: 'result', labelText: 'Result:', origin: 'HTML5' },
  { id: 'progress', label: 'Progress Bar', icon: 'hourglass_bottom', type: 'progress', base: 'progress', labelText: 'Progress:', origin: 'HTML5' },
  { id: 'meter', label: 'Meter', icon: 'speed', type: 'meter', base: 'meter', labelText: 'Usage:', origin: 'HTML5' },
];

const AUTOCOMPLETE: Record<string, string> = { email: 'email', tel: 'tel', url: 'url', password: 'current-password' };

function kindFields(k: Kind, name: string): Field[] {
  const t = k.type!;
  const f: Field[] = [];
  const labelled = !['hidden', 'button', 'submit', 'reset', 'image', 'buttonEl', 'fieldset', 'label'].includes(t);
  if (labelled) f.push({ key: 'label', label: t === 'radiogroup' ? 'Group label (legend)' : 'Label', type: 'text', value: k.labelText, autofocus: true });
  if (t === 'fieldset') f.push({ key: 'legend', label: 'Legend (group caption)', type: 'text', value: 'Group', autofocus: true });
  if (t !== 'label' && t !== 'fieldset') f.push({ key: 'name', label: t === 'radio' ? 'Group name (shared by the option buttons of one question)' : 'Name', type: 'text', value: name, half: true });
  if (t !== 'label' && t !== 'fieldset' && t !== 'radiogroup') f.push({ key: 'id', label: 'Id', type: 'text', value: t === 'radio' ? `${name}_1` : name, half: true });
  if (TEXTISH.has(t) || t === 'textarea' || t === 'datalist') {
    f.push({ key: 'placeholder', label: 'Placeholder (hint shown when empty)', type: 'text', value: '' });
    if (t !== 'textarea') f.push({ key: 'value', label: 'Initial value', type: 'text', value: '', half: true });
    f.push({ key: 'maxlength', label: 'Maximum length', type: 'number', value: null, min: 1, half: true });
  }
  if (t === 'textarea') f.push({ key: 'rows', label: 'Rows', type: 'number', value: 4, min: 1, half: true }, { key: 'cols', label: 'Columns', type: 'number', value: 40, min: 1, half: true });
  if (RANGEISH.has(t)) f.push({ key: 'min', label: 'Minimum', type: 'text', value: t === 'range' ? '0' : '', half: true }, { key: 'max', label: 'Maximum', type: 'text', value: t === 'range' ? '100' : '', half: true }, { key: 'step', label: 'Step', type: 'text', value: '', half: true }, { key: 'value', label: 'Initial value', type: 'text', value: '', half: true });
  if (t === 'color') f.push({ key: 'value', label: 'Initial color', type: 'color', value: '#336699' });
  if (t === 'file') f.push({ key: 'accept', label: 'Accepted types', type: 'combo', value: '', options: ['image/*', '.pdf', '.doc,.docx', 'audio/*', 'video/*', '.csv'] }, { key: 'multiple', label: 'Allow several files', type: 'checkbox', value: false });
  if (t === 'hidden') f.push({ key: 'value', label: 'Value', type: 'text', value: '' });
  if (t === 'checkbox' || t === 'radio') f.push({ key: 'value', label: 'Value sent when checked', type: 'text', value: t === 'checkbox' ? 'yes' : 'option1', half: true }, { key: 'checked', label: 'Initially checked', type: 'checkbox', value: false, half: true });
  if (t === 'radiogroup') f.push({ key: 'options', label: 'Options (one per line; "Label = value"; * marks the default)', type: 'textarea', rows: 5, value: '*Yes = yes\nNo = no\nMaybe = maybe' }, { key: 'inline', label: 'Lay the options out on one line', type: 'checkbox', value: false });
  if (t === 'select' || t === 'listbox' || t === 'datalist' || t === 'jumpmenu') {
    const sample = t === 'jumpmenu' ? '*Choose a page… = \nHome = index.html\nAbout = about.html\nContact = contact.html' : t === 'datalist' ? 'Red\nGreen\nBlue' : '*Choose one… = \nOption 1 = 1\nOption 2 = 2\nOption 3 = 3';
    f.push({ key: 'options', label: t === 'jumpmenu' ? 'Menu items (one per line: "Label = address"; * marks the first shown)' : t === 'datalist' ? 'Suggestions (one per line)' : 'Options (one per line; "Label = value"; * marks selected; [Group] starts a group)', type: 'textarea', rows: 6, value: sample });
  }
  if (t === 'listbox') f.push({ key: 'size', label: 'Visible rows', type: 'number', value: 4, min: 2, half: true }, { key: 'multiple', label: 'Allow several choices', type: 'checkbox', value: true, half: true });
  if (t === 'jumpmenu') f.push({ key: 'target', label: 'Open in', type: 'select', value: '_self', options: [{ value: '_self', label: 'Same window' }, { value: '_blank', label: 'New window' }, { value: '_top', label: 'Whole window (leave frames)' }] },
    { key: 'onchange', label: 'Go as soon as an item is chosen', type: 'checkbox', value: false, help: 'Off is friendlier to keyboard users: they choose, then press Go.' },
    { key: 'go', label: 'Add a Go button', type: 'checkbox', value: true },
    { key: 'noscript', label: 'Add plain links for browsers without scripts', type: 'checkbox', value: true });
  if (t === 'button' || t === 'submit' || t === 'reset') f.push({ key: 'value', label: 'Button text', type: 'text', value: k.labelText, autofocus: true });
  if (t === 'buttonEl') f.push({ key: 'btype', label: 'Button type', type: 'select', value: 'submit', options: ['submit', 'reset', 'button'] }, { key: 'html', label: 'Content (HTML: text, pictures, formatting)', type: 'textarea', rows: 3, value: '<strong>Send</strong>' });
  if (t === 'image') f.push({ key: 'src', label: 'Picture address', type: 'text', value: 'images/submit.png' }, { key: 'alt', label: 'Alternate text (what the button does)', type: 'text', value: 'Submit' }, { key: 'width', label: 'Width', type: 'number', value: null, half: true }, { key: 'height', label: 'Height', type: 'number', value: null, half: true });
  if (t === 'output') f.push({ key: 'for', label: 'Calculated from (field ids, space-separated)', type: 'text', value: '' }, { key: 'value', label: 'Initial text', type: 'text', value: '0' });
  if (t === 'progress') f.push({ key: 'value', label: 'Value (empty: indeterminate)', type: 'number', value: 70, half: true }, { key: 'max', label: 'Maximum', type: 'number', value: 100, half: true });
  if (t === 'meter') f.push({ key: 'value', label: 'Value', type: 'number', value: 0.6, half: true }, { key: 'min', label: 'Minimum', type: 'number', value: 0, half: true }, { key: 'max', label: 'Maximum', type: 'number', value: 1, half: true }, { key: 'low', label: 'Low', type: 'number', value: 0.25, half: true }, { key: 'high', label: 'High', type: 'number', value: 0.75, half: true }, { key: 'optimum', label: 'Optimum', type: 'number', value: 0.5, half: true });
  if (t === 'label') f.push({ key: 'text', label: 'Label text', type: 'text', value: k.labelText, autofocus: true }, { key: 'for', label: 'For field (id)', type: 'combo', value: '', options: [] });
  if (labelled && !['range', 'color', 'radiogroup', 'output', 'progress', 'meter', 'checkbox'].includes(t)) f.push({ key: 'required', label: 'Required', type: 'checkbox', value: false, half: true });
  if (TEXTISH.has(t)) f.push({ key: 'autocomplete', label: 'Autofill hint', type: 'combo', value: AUTOCOMPLETE[t] || '', options: ['on', 'off', 'name', 'given-name', 'family-name', 'email', 'tel', 'url', 'organization', 'street-address', 'postal-code', 'country-name', 'username', 'current-password', 'new-password', 'one-time-code'], half: true });
  return f;
}

const num = (v: any) => (v == null || v === '' || Number.isNaN(v) ? null : String(v));

/** Markup for a field kind from dialog values (pure apart from nothing; exported for tests). */
export function fieldMarkup(kindId: string, v: Record<string, any>): string {
  const k = KINDS.find((x) => x.id === kindId);
  if (!k) return '';
  const t = k.type!;
  const name = (v.name || k.base).trim();
  const id = (v.id || name).trim();
  const label = (txt: string, forId: string) => (txt ? `<label for="${escAttr(forId)}">${esc(txt)}</label>` : '');
  const common = { name, id, required: !!v.required, autocomplete: v.autocomplete || null } as Record<string, any>;
  switch (t) {
    case 'textarea':
      return `<p>${label(v.label, id)}<br>\n<textarea${attrString({ ...common, rows: num(v.rows), cols: num(v.cols), placeholder: v.placeholder, maxlength: num(v.maxlength) })}></textarea></p>`;
    case 'checkbox': case 'radio':
      return `<p><input${attrString({ type: t, ...common, value: v.value, checked: !!v.checked })}> ${label(v.label, id)}</p>`;
    case 'radiogroup': {
      const opts = parseOptions(v.options);
      const items = opts.map((o, i) => { const oid = `${name}_${i + 1}`; return `<label for="${escAttr(oid)}"><input${attrString({ type: 'radio', name, id: oid, value: o.value, checked: o.selected, required: i === 0 && !!v.required })}> ${esc(o.label)}</label>`; });
      return `<fieldset>\n<legend>${esc(v.label || 'Choose one')}</legend>\n${items.join(v.inline ? '\n' : '<br>\n')}\n</fieldset>`;
    }
    case 'select': case 'listbox':
      return `<p>${label(v.label, id)}\n<select${attrString({ ...common, autocomplete: null, size: t === 'listbox' ? num(v.size) : null, multiple: t === 'listbox' && !!v.multiple })}>\n${optionsHtml(parseOptions(v.options))}\n</select></p>`;
    case 'datalist': {
      const lid = `${id}_list`;
      return `<p>${label(v.label, id)}\n<input${attrString({ type: 'text', ...common, list: lid, placeholder: v.placeholder, value: v.value, maxlength: num(v.maxlength) })}>\n<datalist id="${escAttr(lid)}">\n${parseOptions(v.options).map((o) => `  <option value="${escAttr(o.value)}">`).join('\n')}\n</datalist></p>`;
    }
    case 'jumpmenu': {
      // A select outside any form is valid; the Go button reads it by id, and plain links serve browsers without scripts.
      const opts = parseOptions(v.options);
      const go = `var s=document.getElementById('${id.replace(/[^\w-]/g, '')}');if(s&&s.value){${jumpMenuHandler(v.target).replace(/^if\(this\.value\)/, '').replace(/this\./g, 's.')}}`;
      const sel = `<select${attrString({ name, id, onchange: v.onchange ? jumpMenuHandler(v.target) : null })}>\n${optionsHtml(opts)}\n</select>`;
      const btn = v.go !== false ? `\n<button type="button" onclick="${escAttr(go)}">Go</button>` : '';
      const links = v.noscript !== false ? `\n<noscript><ul>\n${opts.filter((o) => o.value).map((o) => `  <li><a href="${escAttr(o.value)}"${v.target && v.target !== '_self' ? ` target="${escAttr(v.target)}"` : ''}>${esc(o.label)}</a></li>`).join('\n')}\n</ul></noscript>` : '';
      return `<div class="jump-menu">\n<p>${label(v.label, id)}\n${sel}${btn}</p>${links}\n</div>`;
    }
    case 'button': case 'submit': case 'reset':
      return `<p><input${attrString({ type: t, name: t === 'reset' ? null : name, id, value: v.value || k.labelText })}></p>`;
    case 'image':
      return `<p><input${attrString({ type: 'image', name, id, src: v.src, alt: v.alt || 'Submit', width: num(v.width), height: num(v.height) })}></p>`;
    case 'buttonEl':
      return `<p><button${attrString({ type: v.btype || 'submit', name, id })}>${v.html || 'Send'}</button></p>`;
    case 'hidden':
      return `<input${attrString({ type: 'hidden', name, id, value: v.value ?? '' })}>`;
    case 'output':
      return `<p>${label(v.label, id)} <output${attrString({ name, id, for: v.for })}>${esc(v.value ?? '')}</output></p>`;
    case 'progress':
      return `<p>${label(v.label, id)} <progress${attrString({ id, value: num(v.value), max: num(v.max) })}>${v.value != null && v.value !== '' ? esc(String(Math.round((+v.value / (+v.max || 1)) * 100))) + '%' : ''}</progress></p>`;
    case 'meter':
      return `<p>${label(v.label, id)} <meter${attrString({ id, value: num(v.value), min: num(v.min), max: num(v.max), low: num(v.low), high: num(v.high), optimum: num(v.optimum) })}>${esc(String(v.value ?? ''))}</meter></p>`;
    case 'color':
      return `<p>${label(v.label, id)} <input${attrString({ type: 'color', ...common, required: false, autocomplete: null, value: v.value })}></p>`;
    case 'file':
      return `<p>${label(v.label, id)} <input${attrString({ type: 'file', ...common, autocomplete: null, accept: v.accept, multiple: !!v.multiple })}></p>`;
    default:
      return `<p>${label(v.label, id)} <input${attrString({ type: t, ...common, placeholder: v.placeholder, value: v.value, maxlength: num(v.maxlength), min: v.min, max: v.max, step: v.step })}></p>`;
  }
}

/** The form field nearest the selection: inside the selected block, or the next one in document order. */
function nearestField(app: App): HTMLElement | null {
  const el = selectedEl(app);
  if (!el) return null;
  const fieldSel = 'input:not([type=hidden]):not([type=submit]):not([type=reset]):not([type=button]):not([type=image]),select,textarea,meter,progress,output';
  if (el.matches?.(fieldSel)) return el;
  const block = el.closest('p,div,li,td,fieldset,form') || el;
  const inside = block.querySelector<HTMLElement>(fieldSel);
  if (inside) return inside;
  const all = [...el.ownerDocument.querySelectorAll<HTMLElement>(fieldSel)];
  return all.find((f) => el.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) || all[all.length - 1] || null;
}

async function insertKind(app: App, kindId: string, arg?: any): Promise<void> {
  const k = KINDS.find((x) => x.id === kindId)!;
  if (!isPage(app)) { toast('Open a page first.'); return; }
  const taken = usedNames(app);
  const name = uniqueName(app, k.base, taken);
  if (k.type === 'label') return insertLabel(app, arg);
  if (k.type === 'fieldset') {
    const v = arg && typeof arg === 'object' ? arg : await openDialog({ title: 'Insert Group Box', fields: kindFields(k, name), help: 'A group box (fieldset) groups related fields under a caption (legend); the selection is placed inside it.' });
    if (!v) return;
    const inner = selectionHtml(app) || '<p>&nbsp;</p>';
    await placeField(app, `<fieldset>\n<legend>${esc(v.legend || 'Group')}</legend>\n${inner}\n</fieldset>`, arg?.wrap);
    return;
  }
  let v: Record<string, any> | null;
  if (arg && typeof arg === 'object') v = { ...Object.fromEntries(kindFields(k, name).map((f) => [f.key, f.value])), ...arg };
  else {
    v = await openDialog({
      title: `Insert ${k.label}`, fields: kindFields(k, name), wide: ['radiogroup', 'select', 'listbox', 'jumpmenu', 'datalist'].includes(k.type!),
      validate: (x) => {
        const n = String(x.name ?? 'ok').trim();
        if ('name' in x && !n) return 'Type a name: the form sends each value under its field name.';
        if ('id' in x && /\s/.test(String(x.id))) return 'An id cannot contain spaces.';
        if ('id' in x && x.id && x.id !== name && taken.has(String(x.id).toLowerCase())) return `The id "${x.id}" is already used on this page.`;
        if (k.type === 'image' && !String(x.alt || '').trim()) return 'Type alternate text so that screen reader users know what the button does.';
        if ('options' in x && !parseOptions(x.options).length) return 'Type at least one option.';
        return null;
      },
    });
  }
  if (!v) return;
  const markup = fieldMarkup(kindId, v);
  if (k.type === 'jumpmenu') { insertHtml(app, markup); return; }
  await placeField(app, markup, arg?.wrap);
  if (k.type === 'file' && view(app)?.target === 'design') {
    const form = closestSel(app, 'form') || view(app)?.design?.doc?.querySelector(`#${CSS.escape(String(v.id || v.name))}`)?.closest('form');
    if (form && getAttr(form, 'enctype') !== 'multipart/form-data') toast('Tip: forms that upload files need method POST and encoding multipart/form-data (Form Properties).');
  }
}

async function insertLabel(app: App, arg?: any): Promise<void> {
  const doc = view(app)?.design?.doc;
  const near = view(app)?.target === 'design' ? nearestField(app) : null;
  const ids = doc ? [...doc.querySelectorAll('input[id],select[id],textarea[id],meter[id],progress[id],output[id]')].map((e) => e.id) : [];
  const text = (view(app)?.target === 'design' ? view(app)?.design?.selectedText() : '') || '';
  let v = arg && typeof arg === 'object' ? arg : null;
  if (!v) {
    const k = KINDS.find((x) => x.id === 'label')!;
    const fields = kindFields(k, '');
    fields[0].value = text || k.labelText;
    fields[1].value = near?.id || (near ? near.getAttribute('name') || uniqueName(app, 'field') : '');
    fields[1].options = ids;
    v = await openDialog({ title: 'Insert Label', fields, help: 'A label names a field for everyone: clicking it focuses the field, and screen readers read it with the field.' + (near && !near.id ? ' The nearest field has no id; it is given this one.' : '') });
  }
  if (!v) return;
  const forId = String(v.for || '').trim();
  if (near && !near.id && forId && !ids.includes(forId)) mutate(app, () => near.setAttribute('id', forId));
  insertHtml(app, `<label${attrString({ for: forId })}>${esc(v.text || 'Label')}</label>`);
}

// ------------------------------------------------------------------------------------------
// Form and field properties

function designOnly(app: App, what: string): boolean {
  const v = view(app);
  if (!isPage(app) || !v) { toast('Open a page first.'); return false; }
  if (v.target !== 'design' || !v.design?.doc) {
    if (v.tab.view === 'code' || v.tab.view === 'preview') app.setView(v.tab, 'split');
    toast(`Click ${what} in Design view first.`);
    return false;
  }
  return true;
}

const ENCTYPES = [{ value: '', label: 'Default (URL-encoded)' }, { value: 'multipart/form-data', label: 'multipart/form-data (file uploads)' }, { value: 'text/plain', label: 'text/plain (email forms)' }];
const TARGETS = ['', '_self', '_blank', '_parent', '_top'];

function formFields(cur: Record<string, string>, opts: { creating: boolean }): Field[] {
  const action = cur.action || '';
  const mailto = /^mailto:/i.test(action);
  const mail = mailto ? decodeURIComponent(action.slice(7).split('?')[0]) : '';
  const subject = mailto ? new URLSearchParams(action.split('?')[1] || '').get('subject') || '' : '';
  const sendTo = mailto ? 'email' : cur['data-ql-sendto'] === 'service' ? 'service' : action ? 'url' : 'none';
  return [
    { key: 'sendTo', label: 'Send the results to', type: 'radio', value: sendTo, options: [
      { value: 'url', label: 'A script or page on my server (custom URL)' },
      { value: 'email', label: 'An email address (opens the visitor\'s mail program)' },
      { value: 'service', label: 'A form-handling service (paste its endpoint URL)' },
      { value: 'none', label: 'Nowhere yet / handled by a script on this page' }] },
    { key: 'action', label: 'Action (URL)', type: 'text', value: mailto || sendTo === 'service' ? '' : action, placeholder: '/cgi-bin/form-handler.php', visibleIf: (v) => v.sendTo === 'url' },
    { key: 'email', label: 'Email address', type: 'text', value: mail, placeholder: 'you@example.com', visibleIf: (v) => v.sendTo === 'email', half: true },
    { key: 'subject', label: 'Subject', type: 'text', value: subject, visibleIf: (v) => v.sendTo === 'email', half: true },
    { key: 'emailNote', type: 'info', label: 'Email forms depend on a mail program on the visitor\'s device and send plain text; many visitors have none set up. A server script or form service is more reliable.', visibleIf: (v) => v.sendTo === 'email' },
    { key: 'service', label: 'Service endpoint URL', type: 'text', value: sendTo === 'service' ? action : '', placeholder: 'https://forms.example.com/f/your-form-id', visibleIf: (v) => v.sendTo === 'service' },
    { key: 'serviceNote', type: 'info', label: 'Form services receive the submission and email or store it for you. Create a form in the service, then paste the address it gives you.', visibleIf: (v) => v.sendTo === 'service' },
    { key: 'method', label: 'Method', type: 'select', value: (cur.method || (opts.creating ? 'post' : 'get')).toLowerCase(), options: [{ value: 'get', label: 'GET (in the address; searches)' }, { value: 'post', label: 'POST (in the request body)' }, { value: 'dialog', label: 'dialog (closes a <dialog>)' }], half: true, visibleIf: (v) => v.sendTo !== 'email' },
    { key: 'enctype', label: 'Encoding type', type: 'select', value: cur.enctype || '', options: ENCTYPES, half: true, visibleIf: (v) => v.sendTo !== 'email' },
    { key: 'target', label: 'Target window or frame', type: 'combo', value: cur.target || '', options: TARGETS, half: true },
    { key: 'autocomplete', label: 'Autofill', type: 'select', value: cur.autocomplete || '', options: [{ value: '', label: 'Browser default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], half: true },
    { key: 'name', label: 'Form name', type: 'text', value: cur.name || '', half: true },
    { key: 'id', label: 'Id', type: 'text', value: cur.id || '', half: true },
    { key: 'accept-charset', label: 'Character set', type: 'combo', value: cur['accept-charset'] || '', options: ['', 'UTF-8'], half: true },
    { key: 'aria-label', label: 'Accessible name (when no heading names it)', type: 'text', value: cur['aria-label'] || '', half: true },
    { key: 'novalidate', label: 'Do not validate in the browser (novalidate)', type: 'checkbox', value: cur.novalidate != null },
    ...(opts.creating ? [{ key: 'buttons', label: 'Add Submit and Reset buttons', type: 'checkbox' as const, value: true }] : []),
  ];
}

/** Form attributes from the dialog values (null removes). Exported for tests. */
export function formAttrs(v: Record<string, any>): Record<string, string | null> {
  const a: Record<string, string | null> = {};
  if (v.sendTo === 'email') {
    const q = v.subject ? `?subject=${encodeURIComponent(v.subject)}` : '';
    a.action = `mailto:${String(v.email || '').trim()}${q}`;
    a.method = 'post';
    a.enctype = 'text/plain';
    a['data-ql-sendto'] = null;
  } else {
    a.action = v.sendTo === 'url' ? (String(v.action || '').trim() || null) : v.sendTo === 'service' ? (String(v.service || '').trim() || null) : null;
    a.method = v.method && v.method !== 'get' ? v.method : null;
    a.enctype = v.enctype || null;
    a['data-ql-sendto'] = v.sendTo === 'service' ? 'service' : null;
  }
  for (const k of ['target', 'autocomplete', 'name', 'id', 'accept-charset', 'aria-label']) a[k] = String(v[k] || '').trim() || null;
  a.novalidate = v.novalidate ? '' : null;
  return a;
}

function validateFormValues(v: Record<string, any>): string | null {
  if (v.sendTo === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v.email || '').trim())) return 'Type a valid email address.';
  if (v.sendTo === 'service' && !/^https:\/\//i.test(String(v.service || '').trim())) return 'Paste the service\'s https:// endpoint address.';
  if (v.id && /\s/.test(v.id)) return 'An id cannot contain spaces.';
  return null;
}

async function insertForm(app: App, arg?: any): Promise<void> {
  if (!isPage(app)) { toast('Open a page first.'); return; }
  const inner = selectionHtml(app);
  const v = arg && typeof arg === 'object' ? { sendTo: 'none', buttons: true, ...arg } : await openDialog({
    title: 'Insert Form', wide: true, fields: formFields({}, { creating: true }), validate: validateFormValues,
    help: inner ? 'The selection is placed inside the new form.' : 'Insert fields inside the form; each sends its value under its name.',
  });
  if (!v) return;
  const attrs = formAttrs(v);
  if (attrs.novalidate === '') (attrs as any).novalidate = true;
  const buttons = v.buttons ? '\n<p><button type="submit">Submit</button> <button type="reset">Reset</button></p>' : '';
  insertHtml(app, `<form${attrString(attrs as any)}>\n${inner || '<p>&nbsp;</p>'}${buttons}\n</form>`);
}

async function formProperties(app: App, arg?: any): Promise<void> {
  if (!designOnly(app, 'inside a form')) return;
  const form = closestSel(app, 'form');
  if (!form) { toast('Click inside a form first (Insert > Form adds one).'); return; }
  const cur: Record<string, string> = {};
  for (const a of form.attributes) if (!a.name.startsWith('data-ql-o-')) cur[a.name] = getAttr(form, a.name) ?? '';
  const v = arg && typeof arg === 'object' ? arg : await openDialog({ title: 'Form Properties', wide: true, fields: formFields(cur, { creating: false }), validate: validateFormValues });
  if (!v) return;
  const attrs = formAttrs(v);
  mutate(app, () => {
    for (const [k, val] of Object.entries(attrs)) {
      if (k === 'novalidate') { if (val != null) form.setAttribute(k, ''); else form.removeAttribute(k); } else setAttr(app, form, k, val);
    }
  });
  if (form.querySelector('input[type=file]') && attrs.enctype !== 'multipart/form-data' && v.sendTo !== 'email') toast('This form has a file upload field: set the encoding to multipart/form-data and the method to POST.');
}

/** Field properties: the attributes that apply to the selected field's type. */
async function fieldProperties(app: App): Promise<void> {
  if (!designOnly(app, 'a form field')) return;
  const el = closestSel(app, 'input,select,textarea,button,output,meter,progress');
  if (!el) { toast('Select a form field first.'); return; }
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
  const doc = el.ownerDocument;
  const labelEl = el.id ? doc.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest('label');
  const attr = (n: string) => getAttr(el, n) ?? '';
  const has = (n: string) => el.hasAttribute(n);
  const TYPES = ['text', 'password', 'email', 'tel', 'url', 'search', 'number', 'range', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'file', 'hidden', 'checkbox', 'radio', 'submit', 'reset', 'button', 'image'];
  const is = (t: string[]) => (v: Record<string, any>) => t.includes(v.type ?? type);
  const textLike = ['text', 'password', 'email', 'tel', 'url', 'search'];
  const fields: Field[] = [];
  if (tag === 'input') fields.push({ key: 'type', label: 'Type', type: 'select', value: type, options: TYPES, half: true });
  if (tag === 'button') fields.push({ key: 'btype', label: 'Button type', type: 'select', value: attr('type') || 'submit', options: ['submit', 'reset', 'button'], half: true });
  if (labelEl) fields.push({ key: 'labelText', label: 'Label text', type: 'text', value: labelEl.textContent?.trim() || '', half: true });
  fields.push({ key: 'name', label: 'Name', type: 'text', value: attr('name'), half: true }, { key: 'id', label: 'Id', type: 'text', value: el.id, half: true });
  if (tag === 'textarea') fields.push({ key: 'text', label: 'Initial text', type: 'textarea', rows: 3, value: el.textContent || '' });
  else if (tag === 'button') fields.push({ key: 'html', label: 'Content (HTML)', type: 'textarea', rows: 3, value: el.innerHTML }, { key: 'value', label: 'Value', type: 'text', value: attr('value'), half: true });
  else if (tag !== 'select') fields.push({ key: 'value', label: tag === 'input' ? 'Value' : 'Value', type: 'text', value: tag === 'output' ? el.textContent || '' : attr('value'), half: true, visibleIf: (v) => (v.type ?? type) !== 'file' });
  if (tag === 'input' || tag === 'textarea') {
    fields.push({ key: 'placeholder', label: 'Placeholder', type: 'text', value: attr('placeholder'), half: true, visibleIf: (v) => tag === 'textarea' || is([...textLike, 'number'])(v) });
    fields.push({ key: 'pattern', label: 'Pattern (regular expression)', type: 'text', value: attr('pattern'), half: true, visibleIf: (v) => tag === 'input' && is(textLike)(v) });
    fields.push({ key: 'maxlength', label: 'Maximum length', type: 'text', value: attr('maxlength'), half: true, visibleIf: (v) => tag === 'textarea' || is(textLike)(v) });
    fields.push({ key: 'minlength', label: 'Minimum length', type: 'text', value: attr('minlength'), half: true, visibleIf: (v) => tag === 'textarea' || is(textLike)(v) });
  }
  if (tag === 'input' || tag === 'meter' || tag === 'progress') {
    const ranged = (v: Record<string, any>) => tag !== 'input' || is(['number', 'range', 'date', 'time', 'datetime-local', 'month', 'week'])(v);
    if (tag !== 'progress') fields.push({ key: 'min', label: 'Minimum', type: 'text', value: attr('min'), half: true, visibleIf: ranged });
    fields.push({ key: 'max', label: 'Maximum', type: 'text', value: attr('max'), half: true, visibleIf: ranged });
    if (tag === 'input') fields.push({ key: 'step', label: 'Step', type: 'text', value: attr('step'), half: true, visibleIf: ranged });
    if (tag === 'meter') fields.push({ key: 'low', label: 'Low', type: 'text', value: attr('low'), half: true }, { key: 'high', label: 'High', type: 'text', value: attr('high'), half: true }, { key: 'optimum', label: 'Optimum', type: 'text', value: attr('optimum'), half: true });
  }
  if (tag === 'input' || tag === 'select') fields.push({ key: 'size', label: tag === 'select' ? 'Visible rows' : 'Width in characters', type: 'text', value: attr('size'), half: true, visibleIf: (v) => tag === 'select' || is(textLike)(v) });
  if (tag === 'textarea') fields.push({ key: 'rows', label: 'Rows', type: 'text', value: attr('rows'), half: true }, { key: 'cols', label: 'Columns', type: 'text', value: attr('cols'), half: true });
  if (tag === 'input') {
    fields.push({ key: 'accept', label: 'Accepted file types', type: 'combo', value: attr('accept'), options: ['image/*', '.pdf', 'audio/*', 'video/*'], visibleIf: is(['file']) });
    fields.push({ key: 'src', label: 'Picture address', type: 'text', value: attr('src'), half: true, visibleIf: is(['image']) }, { key: 'alt', label: 'Alternate text', type: 'text', value: attr('alt'), half: true, visibleIf: is(['image']) });
    fields.push({ key: 'list', label: 'Suggestions list (datalist id)', type: 'text', value: attr('list'), half: true, visibleIf: is([...textLike, 'number', 'range', 'date', 'time', 'color']) });
  }
  if (tag === 'output') fields.push({ key: 'for', label: 'Calculated from (ids)', type: 'text', value: attr('for') });
  if (/^(input|select|textarea)$/.test(tag)) fields.push({ key: 'autocomplete', label: 'Autofill hint', type: 'combo', value: attr('autocomplete'), options: ['on', 'off', 'name', 'email', 'tel', 'url', 'street-address', 'postal-code', 'username', 'current-password', 'new-password'], half: true, visibleIf: (v) => tag !== 'input' || is([...textLike, 'number', 'date', 'month', 'week', 'time'])(v) });
  if (/^(input|button|select|textarea)$/.test(tag)) fields.push({ key: 'title', label: 'Tooltip / hint (title)', type: 'text', value: attr('title'), half: true });
  if (tag === 'select') fields.push({ key: 'options', label: 'Options (one per line; "Label = value"; * marks selected; [Group] starts a group)', type: 'textarea', rows: 7, value: formatOptions(readOptions(el)) });
  if (tag === 'input') fields.push({ key: 'checked', label: 'Initially checked', type: 'checkbox', value: has('checked'), half: true, visibleIf: is(['checkbox', 'radio']) });
  if (tag === 'input' || tag === 'select') fields.push({ key: 'multiple', label: 'Allow several', type: 'checkbox', value: has('multiple'), half: true, visibleIf: (v) => tag === 'select' || is(['email', 'file'])(v) });
  if (/^(input|select|textarea)$/.test(tag)) fields.push({ key: 'required', label: 'Required', type: 'checkbox', value: has('required'), half: true, visibleIf: (v) => tag !== 'input' || !is(['hidden', 'range', 'color', 'submit', 'reset', 'button', 'image'])(v) });
  if (tag === 'input' || tag === 'textarea') fields.push({ key: 'readonly', label: 'Read-only', type: 'checkbox', value: has('readonly'), half: true, visibleIf: (v) => tag === 'textarea' || !is(['hidden', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'reset', 'button', 'image'])(v) });
  if (/^(input|select|textarea|button)$/.test(tag)) fields.push({ key: 'disabled', label: 'Disabled', type: 'checkbox', value: has('disabled'), half: true }, { key: 'autofocus', label: 'Focus when the page opens', type: 'checkbox', value: has('autofocus'), half: true });
  const v = await openDialog({ title: `${tag === 'input' ? type.replace(/^\w/, (c) => c.toUpperCase()) : tag.replace(/^\w/, (c) => c.toUpperCase())} Field Properties`, wide: true, fields,
    validate: (x) => (x.id && /\s/.test(x.id) ? 'An id cannot contain spaces.' : x.pattern ? (() => { try { new RegExp(x.pattern, 'v'); return null; } catch { try { new RegExp(x.pattern); return null; } catch { return 'The pattern is not a valid regular expression.'; } } })() : null) });
  if (!v) return;
  mutate(app, () => {
    const set = (n: string, val: any) => setAttr(app, el, n, val == null ? null : String(val).trim() === '' ? null : String(val));
    const flag = (n: string, on: any) => { if (on) el.setAttribute(n, ''); else el.removeAttribute(n); };
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      switch (k) {
        case 'type': if (val === 'text') el.removeAttribute('type'); else el.setAttribute('type', val); break;
        case 'btype': el.setAttribute('type', val); break;
        case 'labelText': if (labelEl) labelEl.textContent = val; break;
        case 'text': el.textContent = val; break;
        case 'html': el.innerHTML = val; break;
        case 'value': if (tag === 'output') el.textContent = val; else set('value', val); break;
        case 'options': {
          for (const c of [...el.childNodes]) c.remove();
          const tmp = doc.createElement('select');
          tmp.innerHTML = optionsHtml(parseOptions(val));
          el.appendChild(doc.createTextNode('\n'));
          for (const c of [...tmp.childNodes]) el.appendChild(c);
          el.appendChild(doc.createTextNode('\n'));
          break;
        }
        case 'checked': case 'multiple': case 'required': case 'readonly': case 'disabled': case 'autofocus': flag(k, val); break;
        case 'id': {
          const old = el.id;
          set('id', val);
          if (labelEl && labelEl.getAttribute('for') === old && val) labelEl.setAttribute('for', val);
          break;
        }
        default: set(k, val);
      }
    }
  });
}

// ------------------------------------------------------------------------------------------
// Validation

/** Adds, refreshes or removes <script id="ql-validation"> depending on whether any field has a custom message. */
export function syncValidationScript(doc: Document): void {
  const needed = !!doc.querySelector('[data-ql-message]');
  let s = doc.getElementById(VALIDATION_SCRIPT_ID);
  if (!needed) { s?.remove(); return; }
  const js = '\n' + generateValidationScript() + '\n';
  if (!s) {
    s = doc.createElement('script');
    s.id = VALIDATION_SCRIPT_ID;
    const beh = doc.getElementById('ql-behaviors');
    doc.body.appendChild(doc.createTextNode('\n'));
    if (beh) doc.body.insertBefore(s, beh); else doc.body.appendChild(s);
  }
  if (s.textContent !== js) s.textContent = js;
}

async function validation(app: App): Promise<void> {
  if (!designOnly(app, 'a form field or form')) return;
  const el = closestSel(app, 'input,select,textarea');
  const form = closestSel(app, 'form');
  if (!el) {
    if (!form) { toast('Select a form field (or click inside a form) first.'); return; }
    const fieldsIn = [...form.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=reset]):not([type=button]):not([type=image]),select,textarea')];
    const v = await openDialog({ title: 'Form Validation', fields: [
      { key: 'info', type: 'info', label: `${fieldsIn.length} field(s); ${fieldsIn.filter((f) => f.hasAttribute('required')).length} required. Select a field and run Form Validation again to set its rules.` },
      { key: 'novalidate', label: 'Turn off browser validation for this form (novalidate)', type: 'checkbox', value: form.hasAttribute('novalidate') },
      { key: 'requireAll', label: 'Make every field required', type: 'checkbox', value: false },
    ] });
    if (!v) return;
    mutate(app, () => {
      if (v.novalidate) form.setAttribute('novalidate', ''); else form.removeAttribute('novalidate');
      if (v.requireAll) for (const f of fieldsIn) if (!/^(range|color|checkbox)$/.test(f.getAttribute('type') || '')) f.setAttribute('required', '');
    });
    return;
  }
  const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName.toLowerCase();
  const attr = (n: string) => el.getAttribute(n) ?? '';
  const textLike = ['text', 'password', 'email', 'tel', 'url', 'search', 'textarea'];
  const ranged = ['number', 'range', 'date', 'time', 'datetime-local', 'month', 'week'];
  const v = await openDialog({
    title: 'Form Validation', wide: true,
    help: 'Browsers check these rules before sending the form and show a message next to the field. Always check again on the server: rules in the page can be bypassed.',
    fields: [
      { key: 'required', label: 'Required (cannot be left empty)', type: 'checkbox', value: el.hasAttribute('required') },
      ...(el.tagName === 'INPUT' ? [{ key: 'type', label: 'Data type', type: 'select' as const, value: type, options: [
        { value: 'text', label: 'Any text' }, { value: 'email', label: 'Email address' }, { value: 'url', label: 'Web address' }, { value: 'tel', label: 'Telephone number' },
        { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }, { value: 'time', label: 'Time' }, { value: type, label: `Keep (${type})` }] }] : []),
      ...(textLike.includes(type) && type !== 'textarea' ? [{ key: 'pattern', label: 'Pattern (regular expression the whole value must match)', type: 'combo' as const, value: attr('pattern'), options: ['[0-9]{5}', '[A-Za-z]+', '[0-9]{3}-[0-9]{3}-[0-9]{4}', '.{8,}', '[A-Za-z0-9_]{3,16}'] }] : []),
      ...(textLike.includes(type) ? [
        { key: 'minlength', label: 'Minimum length', type: 'number' as const, value: attr('minlength') ? +attr('minlength') : null, half: true },
        { key: 'maxlength', label: 'Maximum length', type: 'number' as const, value: attr('maxlength') ? +attr('maxlength') : null, half: true }] : []),
      { key: 'min', label: 'Minimum', type: 'text', value: attr('min'), half: true, visibleIf: (x) => ranged.includes(x.type ?? type) },
      { key: 'max', label: 'Maximum', type: 'text', value: attr('max'), half: true, visibleIf: (x) => ranged.includes(x.type ?? type) },
      { key: 'step', label: 'Step', type: 'text', value: attr('step'), half: true, visibleIf: (x) => ranged.includes(x.type ?? type) },
      { key: 'title', label: 'Hint shown with the message (title)', type: 'text', value: attr('title') },
      { key: 'message', label: 'Custom message (replaces the browser\'s message; adds a small script)', type: 'text', value: attr('data-ql-message'), placeholder: 'Please enter your email address.' },
      { key: 'missing', label: 'Message when empty (optional)', type: 'text', value: attr('data-ql-message-value-missing'), half: true },
      { key: 'mismatch', label: 'Message when the format is wrong (optional)', type: 'text', value: attr('data-ql-message-type-mismatch') || attr('data-ql-message-pattern-mismatch'), half: true },
    ],
    validate: (x) => { if (x.pattern) { try { new RegExp(x.pattern); } catch { return 'The pattern is not a valid regular expression.'; } } return null; },
  });
  if (!v) return;
  mutate(app, (doc) => {
    const set = (n: string, val: any) => { const s = val == null ? '' : String(val).trim(); if (s) el.setAttribute(n, s); else el.removeAttribute(n); };
    if (v.required) el.setAttribute('required', ''); else el.removeAttribute('required');
    if (v.type) { if (v.type === 'text') el.removeAttribute('type'); else el.setAttribute('type', v.type); }
    for (const k of ['pattern', 'minlength', 'maxlength', 'min', 'max', 'step', 'title']) if (k in v) set(k, v[k]);
    const anyMsg = v.message || v.missing || v.mismatch;
    if (anyMsg) el.setAttribute('data-ql-message', String(v.message || '').trim()); else el.removeAttribute('data-ql-message');
    set('data-ql-message-value-missing', v.missing);
    set('data-ql-message-type-mismatch', v.mismatch);
    set('data-ql-message-pattern-mismatch', v.mismatch);
    syncValidationScript(doc);
  });
}

// ------------------------------------------------------------------------------------------

const FIELD_ORDER = ['textbox', 'textarea', 'password', 'email', 'tel', 'url', 'number', 'range', 'date', 'time', 'datetime', 'month', 'week', 'color', 'search', 'file', 'hidden', '|', 'checkbox', 'radio', 'radioGroup', 'select', 'listBox', 'datalist', 'jumpMenu', '|', 'button', 'submit', 'reset', 'imageButton', 'advancedButton', '|', 'label', 'fieldset', 'output', 'progress', 'meter'];

def([
  { id: 'form.form', label: 'Form', icon: 'dynamic_form', tab: 'Insert', group: 'Forms', edits: true, popular: true, origin: 'FrontPage, Expression Web, Dreamweaver', isEnabled: isPage,
    keywords: 'form action method mailto', tip: 'Insert a form (wraps the selection).', run: (app, arg) => insertForm(app, arg) },
  ...KINDS.map((k) => ({
    id: `form.${k.id}`, label: k.label, icon: k.icon, tab: 'Insert', group: 'Forms', edits: true, origin: k.origin, isEnabled: isPage,
    keywords: `form field ${k.type || ''} ${k.keywords || ''}`.trim(), tip: `Insert a ${k.label.toLowerCase()} with a label.`,
    run: (app: App, arg?: any) => insertKind(app, k.id, arg),
  })),
  { id: 'form.menu', label: 'More Fields', icon: 'list_alt', tab: 'Insert', group: 'Forms', kind: 'menu', edits: true, origin: 'Expression Web (Toolbox: Form Controls)', isEnabled: isPage,
    keywords: 'form controls toolbox fields', tip: 'Every form field type.',
    menu: (): MenuEntry[] => [
      { id: 'form.form', label: 'Form', icon: 'dynamic_form' }, { separator: true },
      ...FIELD_ORDER.map((id): MenuEntry => { if (id === '|') return { separator: true }; const k = KINDS.find((x) => x.id === id)!; return { id: `form.${k.id}`, label: k.label, icon: k.icon }; }),
      { separator: true }, { id: 'form.properties', label: 'Form Properties…', icon: 'tune' }, { id: 'form.fieldProperties', label: 'Field Properties…', icon: 'input' }, { id: 'form.validation', label: 'Validation…', icon: 'rule' }],
    run: (app, arg) => {
      if (typeof arg === 'string' && getCommand(arg)) return app.exec(arg);
      const c = getCommand('form.menu');
      if (c) app.ui.openCommandMenu(c, app.ui.anchorFor('form.menu'));
    } },
  { id: 'form.properties', label: 'Form Properties', icon: 'tune', tab: 'Form', group: 'Properties', edits: true, origin: 'FrontPage, Expression Web, Dreamweaver', isEnabled: isPage,
    keywords: 'action method send results email mailto handler enctype', tip: 'Where the form sends its results, and its other attributes.', run: (app, arg) => formProperties(app, arg) },
  { id: 'form.fieldProperties', label: 'Field Properties', icon: 'input', tab: 'Form', group: 'Properties', edits: true, origin: 'FrontPage, Expression Web, Dreamweaver', isEnabled: isPage,
    keywords: 'form field name value placeholder required options', tip: 'Attributes of the selected form field.', run: (app) => fieldProperties(app) },
  { id: 'form.validation', label: 'Validation', icon: 'rule', tab: 'Form', group: 'Properties', edits: true, origin: 'FrontPage (Form Field Validation), Dreamweaver', isEnabled: isPage,
    keywords: 'required pattern constraint validate messages', tip: 'HTML5 constraint rules and custom messages for the selected field.', run: (app) => validation(app) },
]);
