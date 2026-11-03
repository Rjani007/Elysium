// Accepting a table invite: shows where the link leads, then seats you.
import { call } from '../supa.js';
import { el, fail } from '../util.js';
import { go, topbar } from '../main.js';

export async function render(root, code) {
  const info = (await call('invite_info', { p_code: code }))[0];
  const body = el('main', { class: 'page narrow' });
  root.append(topbar({ href: '#/', label: 'Chronicles' }, 'Join'), body);
  if (!info) {
    body.append(el('h1', {}, 'That invite has expired'),
      el('p', { class: 'muted' }, 'Ask your storyteller for a fresh link.'));
    return;
  }
  const join = el('button', {
    class: 'btn btn-primary btn-wide',
    onclick: async () => {
      join.disabled = true;
      try { go(`#/t/${await call('join_table', { p_code: code })}`); } catch (err) { fail(err); join.disabled = false; }
    },
  }, 'Take your seat');
  body.append(el('div', { class: 'card stack center' },
    el('p', { class: 'eyebrow' }, 'You are invited to'),
    el('h1', {}, info.table_name),
    el('p', { class: 'muted' }, `in the chronicle ${info.chronicle_name}`),
    join));
}
