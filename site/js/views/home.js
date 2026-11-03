// Your chronicles, starting a new one, joining with an invite.
import { sb, q, call, currentUser } from '../supa.js';
import { el, fail, compareNames } from '../util.js';
import { go, topbar, footer } from '../main.js';

export async function render(root) {
  const me = currentUser();
  const memberships = await q(sb.from('chronicle_members')
    .select('role, chronicle:chronicles(id, name, description, created_at)')
    .eq('user_id', me.id));
  const list = memberships.filter((m) => m.chronicle).sort((a, b) => compareNames(a.chronicle.name, b.chronicle.name));

  const name = el('input', { required: true, maxlength: 80, placeholder: 'Chicago by Night, The Rack…' });
  const description = el('textarea', { rows: 2, maxlength: 4000, placeholder: 'Optional: the city, the year, the mood' });
  const invite = el('input', { placeholder: 'Paste an invite link or code', 'aria-label': 'Invite link or code' });

  root.append(topbar('Chronicles'), el('main', { class: 'page' },
    el('section', {},
      el('h1', {}, 'Your chronicles'),
      list.length
        ? el('div', { class: 'cards' }, list.map(({ role, chronicle: c }) =>
          el('a', { class: 'card card-link', href: `#/c/${c.id}` },
            el('div', { class: 'row spread' }, el('h2', {}, c.name), el('span', { class: `badge badge-${role}` }, role === 'storyteller' ? 'Storyteller' : 'Player')),
            c.description ? el('p', { class: 'muted clamp' }, c.description) : null)))
        : el('p', { class: 'muted' }, 'No chronicles yet. Start one, or use the invite link your storyteller sent you.')),
    el('div', { class: 'two-col' },
      el('form', {
        class: 'card stack',
        onsubmit: async (e) => {
          e.preventDefault();
          try { go(`#/c/${await call('create_chronicle', { p_name: name.value.trim(), p_description: description.value.trim() })}`); } catch (err) { fail(err); }
        },
      },
      el('h2', {}, 'Start a chronicle'),
      el('p', { class: 'muted small' }, "You'll be its storyteller. It starts with one table and an invite link for your players."),
      el('label', { class: 'field' }, el('span', {}, 'Name'), name),
      el('label', { class: 'field' }, el('span', {}, 'Description'), description),
      el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create')),
      el('form', {
        class: 'card stack',
        onsubmit: (e) => {
          e.preventDefault();
          const code = invite.value.trim().match(/(?:#\/join\/)?([a-z0-9]{6,})\s*$/i)?.[1];
          if (code) go(`#/join/${code.toLowerCase()}`);
          else fail(new Error("That doesn't look like an invite link."));
        },
      },
      el('h2', {}, 'Join a table'),
      el('p', { class: 'muted small' }, 'Your storyteller can copy an invite link from the chronicle page.'),
      invite,
      el('button', { class: 'btn', type: 'submit' }, 'Join'))),
    footer()));
}
