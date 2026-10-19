/**
 * Behaviors pane: the behaviors of the element selected in Design view, with add, edit, reorder and delete.
 */
import { registerPane, sigOf, typingIn } from './panes';
import { h, icon, clear } from './dom';
import { selectedEl, view, isPage } from '../editor/ops';
import { actionDef, BEHAVIOR_ATTR } from '../editor/behaviors';
import { behaviorsOf, behaviorElements, describeEl, editBehavior, deleteBehavior, moveBehavior } from '../commands/behavior';

registerPane({
  id: 'behaviors', title: 'Behaviors', side: 'right',
  render(app, el) { el.dataset.sig = ''; this.update!(app, el, {}); },
  update(app, el) {
    const v = view(app);
    const doc = v?.design?.doc || null;
    const sel = isPage(app) && doc ? selectedEl(app) : null;
    const sig = `${app.active?.path}:${app.site.version}:${v?.tab.view}:${sel ? describeEl(sel) + (sel.getAttribute(BEHAVIOR_ATTR) || '') : '-'}:${doc ? behaviorElements(doc).length : 0}`;
    if (typingIn(el) || !sigOf(el, sig)) return;
    clear(el);
    const tools = h('div', { class: 'ql-row ql-pane-tools' },
      h('button', { class: 'ql-btn ql-sm', onclick: () => app.exec('behavior.add'), disabled: !sel }, icon('add'), ' Add Behavior'),
      h('span', { class: 'ql-spacer' }),
      h('button', { class: 'ql-iconbtn ql-sm', title: 'Behavior List', 'aria-label': 'Behavior List', onclick: () => app.exec('behavior.list') }, icon('list')));
    el.appendChild(tools);
    if (!isPage(app)) { el.appendChild(h('p', { class: 'ql-help' }, 'Open a page to see its behaviors.')); return; }
    if (!doc || v?.tab.view === 'code' || v?.tab.view === 'preview') {
      el.appendChild(h('p', { class: 'ql-help' }, 'Behaviors are attached in Design or Split view.'));
      el.appendChild(h('button', { class: 'ql-btn ql-sm', onclick: () => v && app.setView(v.tab, 'split') }, 'Switch to Split View'));
      return;
    }
    if (!sel) return;
    el.appendChild(h('div', { class: 'ql-label' }, `Tag: ${describeEl(sel)}`));
    const list = behaviorsOf(sel);
    if (!list.length) {
      el.appendChild(h('p', { class: 'ql-help' }, 'No behaviors on this element. Add Behavior attaches an action (show a message, swap an image, open a window…) to one of its events.'));
    } else {
      const table = h('table', { class: 'ql-behaviors-table', style: 'width:100%;border-collapse:collapse;font-size:12px;text-align:left' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Event'), h('th', { scope: 'col' }, 'Action'), h('th', { scope: 'col', 'aria-label': 'Commands' }))));
      const body = h('tbody');
      list.forEach((b, i) => {
        const a = actionDef(b.action);
        const label = a?.label || b.action;
        const btn = (ic: string, title: string, fn: () => void, disabled = false) => h('button', { class: 'ql-iconbtn ql-sm', title, 'aria-label': `${title}: ${label}`, disabled, onclick: fn }, icon(ic));
        const tr = h('tr', null,
          h('td', null, 'on' + b.event),
          h('td', { title: a ? a.summary(b.params || {}) : '' }, h('div', null, label), h('div', { class: 'ql-help' }, a ? a.summary(b.params || {}) : 'Unknown action')),
          h('td', { style: 'white-space:nowrap' },
            btn('edit', 'Edit', () => void editBehavior(app, sel, i)),
            btn('arrow_upward', 'Move up', () => moveBehavior(app, sel, i, -1), i === 0),
            btn('arrow_downward', 'Move down', () => moveBehavior(app, sel, i, 1), i === list.length - 1),
            btn('delete', 'Delete', () => deleteBehavior(app, sel, i))));
        tr.addEventListener('dblclick', () => void editBehavior(app, sel, i));
        body.appendChild(tr);
      });
      table.appendChild(body);
      el.appendChild(table);
    }
    const others = behaviorElements(doc).filter((e) => e !== sel);
    if (others.length) {
      el.appendChild(h('div', { class: 'ql-label', style: 'margin-top:12px' }, 'Other elements with behaviors'));
      const ul = h('ul', { style: 'list-style:none;margin:4px 0;padding:0' });
      for (const o of others.slice(0, 50)) {
        ul.appendChild(h('li', null, h('button', { class: 'ql-link', onclick: () => { v!.design!.select(o); app.refresh(); } }, `${describeEl(o)} (${behaviorsOf(o).length})`)));
      }
      el.appendChild(ul);
    }
    el.appendChild(h('p', { class: 'ql-help' }, 'Design view does not run scripts; use Preview to try behaviors.'));
  },
});
