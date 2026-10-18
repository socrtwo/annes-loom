/**
 * AI Assistant pane (right side): a chat about the current page or site. The question is sent with the
 * context the user picks (nothing, the selection, the page's code, or the site's page list). Each answer
 * can be inserted at the cursor, replace the selection, or be applied to the whole page; every one of
 * those is previewed first and applies as one undoable step. Analysis commands (Explain Code, Review
 * Page, Performance Advice, Summarize) post their results here too.
 */
import type { App } from '../app';
import { registerPane, sigOf, typingIn } from './panes';
import { h, icon, clear } from './dom';
import { toast } from './dialog';
import type { ChatMessage } from '../ai/client';
import { ask, aiBusy, onAiBusy, stopAi, applyAnswer, assistantContext } from '../commands/ai';
import { aiSettings } from '../ai/store';
import { providerById } from '../ai/providers';

type Ctx = 'none' | 'selection' | 'page' | 'site';
interface Msg { role: 'user' | 'assistant' | 'note'; text: string; title?: string; ctx?: Ctx; pending?: boolean }

const log: Msg[] = [];
let version = 0;
let ctxKind: Ctx = 'page';
let draft = '';
let host: { app: App; el: HTMLElement } | null = null;

const CTX_LABEL: Record<Ctx, string> = { none: 'No context', selection: 'The selection', page: 'This page (its code)', site: 'The site (page list)' };

function changed(): void {
  version++;
  if (host && host.app.ui.paneOpen('ai')) render(host.app, host.el);
}

/** Shows a result in the assistant pane (opening it when closed). */
export function postToAssistant(app: App, title: string, text: string): void {
  log.push({ role: 'note', title, text });
  version++;
  if (!app.ui.paneOpen('ai')) app.ui.openPane('ai');
  else if (host) render(app, host.el);
}

async function send(app: App, question: string): Promise<void> {
  const q = question.trim();
  if (!q || aiBusy()) return;
  const context = assistantContext(app, ctxKind);
  if (ctxKind !== 'none' && !context) { toast(ctxKind === 'selection' ? 'Nothing is selected; choose another context or select something.' : 'Open a page first, or choose "No context".'); return; }
  const history: ChatMessage[] = [];
  for (const m of log.slice(-20)) if (m.role === 'user' || (m.role === 'assistant' && !m.pending)) history.push({ role: m.role, content: m.text });
  log.push({ role: 'user', text: q, ctx: ctxKind });
  const answer: Msg = { role: 'assistant', text: '', pending: true };
  log.push(answer);
  draft = '';
  changed();
  const prompt = context ? `${context}\n\nQuestion: ${q}\n\nIf you suggest code, put it in a fenced code block (\`\`\`html, \`\`\`css or \`\`\`js). If you rewrite the whole page, give the complete page.` : q;
  let live: HTMLElement | null = null;
  const text = await ask(app, prompt, {
    history, maxTokens: 4000, status: 'The assistant is answering…',
    onToken: (_d, full) => {
      answer.text = full;
      live ||= host?.el.querySelector<HTMLElement>('[data-live="1"]') || null;
      if (live) { live.textContent = full; live.parentElement?.parentElement?.scrollTo?.({ top: 1e9 }); }
    },
  });
  answer.pending = false;
  if (text == null) { if (!answer.text) log.splice(log.indexOf(answer), 1); }
  else answer.text = text;
  changed();
}

function bubble(app: App, m: Msg): HTMLElement {
  const mine = m.role === 'user';
  const box = h('div', { class: `ql-ai-msg ql-ai-${m.role}`, style: `display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;border:1px solid var(--border,#ccc);${mine ? 'align-self:flex-end;max-width:92%;background:var(--accent-soft,#e8f0fe)' : 'background:var(--surface2,#f6f6f6)'}` });
  if (m.title) box.appendChild(h('b', null, m.title));
  if (mine && m.ctx && m.ctx !== 'none') box.appendChild(h('span', { class: 'ql-help', style: 'font-size:11px' }, `with ${CTX_LABEL[m.ctx].toLowerCase()}`));
  box.appendChild(h('div', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.45', 'data-live': m.pending ? '1' : null }, m.text || (m.pending ? '…' : '')));
  if (!mine && !m.pending && m.text.trim()) {
    const page = app.active && (app.active.kind === 'page' || app.active.kind === 'text');
    const btn = (label: string, ic: string, fn: () => void, enabled = true) => h('button', { class: 'ql-btn ql-sm', type: 'button', disabled: !enabled, title: label, onclick: fn }, icon(ic), label);
    box.appendChild(h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-top:2px' },
      btn('Insert', 'add', () => void applyAnswer(app, m.text, 'insert'), !!page),
      btn('Replace Selection', 'find_replace', () => void applyAnswer(app, m.text, 'replace'), !!page),
      btn('Apply to Page', 'published_with_changes', () => void applyAnswer(app, m.text, 'page'), !!page),
      btn('Copy', 'content_copy', () => { void navigator.clipboard?.writeText(m.text).then(() => toast('Copied.'), () => toast('Could not copy.')); })));
  }
  return box;
}

function render(app: App, el: HTMLElement): void {
  host = { app, el };
  const ta = el.querySelector<HTMLTextAreaElement>('textarea.ql-ai-input');
  if (ta) draft = ta.value;
  const hadFocus = !!ta && document.activeElement === ta;
  clear(el);
  const p = providerById(aiSettings().active || '');
  const ctxSel = h('select', { 'aria-label': 'Context sent with the question', title: 'Context sent with the question', style: 'flex:1;min-width:0' }) as HTMLSelectElement;
  for (const k of Object.keys(CTX_LABEL) as Ctx[]) ctxSel.appendChild(h('option', { value: k }, CTX_LABEL[k]));
  ctxSel.value = ctxKind;
  ctxSel.addEventListener('change', () => { ctxKind = ctxSel.value as Ctx; });
  el.appendChild(h('div', { class: 'ql-row ql-pane-tools', style: 'display:flex;gap:6px;align-items:center' },
    ctxSel,
    h('button', { class: 'ql-iconbtn ql-sm', title: 'Clear the conversation', 'aria-label': 'Clear the conversation', onclick: () => { log.length = 0; changed(); } }, icon('delete_sweep')),
    h('button', { class: 'ql-iconbtn ql-sm', title: 'AI & Privacy', 'aria-label': 'AI and privacy', onclick: () => app.exec('ai.privacy') }, icon('shield'))));
  el.appendChild(h('div', { class: 'ql-help', style: 'font-size:11.5px' }, p ? `Answers from ${p.name}. Nothing is sent until you ask.` : 'Set up an AI provider to start (AI ▸ Set Up AI).'));
  const list = h('div', { class: 'ql-ai-out', role: 'log', 'aria-live': 'polite', style: 'flex:1;min-height:120px;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:2px' });
  if (!log.length) list.appendChild(h('div', { class: 'ql-help' }, 'Ask about this page or site: "Why does the footer overlap on phones?", "Write a CSS rule for a two-column card grid", "Suggest a better headline". Answers with code can be inserted or applied to the page after a preview.'));
  for (const m of log) list.appendChild(bubble(app, m));
  el.appendChild(list);
  const input = h('textarea', { class: 'ql-ai-input', rows: '3', placeholder: 'Ask the assistant…  (Enter sends, Shift+Enter adds a line)', 'aria-label': 'Question', style: 'width:100%;resize:vertical' }) as HTMLTextAreaElement;
  input.value = draft;
  input.addEventListener('input', () => { draft = input.value; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(app, input.value); } });
  const busy = aiBusy();
  el.appendChild(input);
  el.appendChild(h('div', { style: 'display:flex;gap:6px;justify-content:flex-end' },
    busy ? h('button', { class: 'ql-btn', type: 'button', onclick: () => stopAi() }, icon('stop_circle'), 'Stop') : null,
    h('button', { class: 'ql-btn ql-primary', type: 'button', disabled: busy, onclick: () => void send(app, input.value) }, icon('send'), 'Ask')));
  if (hadFocus) input.focus();
  el.dataset.sig = `${version}:${busy}`;
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

let unbusy: (() => void) | null = null;

registerPane({
  id: 'ai', title: 'AI Assistant', side: 'right',
  render(app, el) { render(app, el); unbusy?.(); unbusy = onAiBusy(() => { if (host?.el.isConnected) render(host.app, host.el); }); },
  update(app, el) {
    if (!sigOf(el, `${version}:${aiBusy()}`) || typingIn(el)) return;
    render(app, el);
  },
  onOpen(_app, el) { setTimeout(() => el.querySelector<HTMLTextAreaElement>('textarea.ql-ai-input')?.focus(), 30); },
  onClose() { unbusy?.(); unbusy = null; host = null; },
});
