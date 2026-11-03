// Your name at the table, your password, signing out.
import { sb, q, currentUser, setCurrentUser } from '../supa.js';
import { el, toast, fail } from '../util.js';
import { topbar } from '../main.js';

export async function render(root) {
  const me = currentUser();
  const name = el('input', { value: me.displayName, maxlength: 40, required: true });
  const password = el('input', { type: 'password', minlength: 8, autocomplete: 'new-password', placeholder: 'Leave empty to keep it' });
  root.append(topbar({ href: '#/', label: 'Chronicles' }, 'Account'),
    el('main', { class: 'page narrow' },
      el('h1', {}, 'Your account'),
      el('p', { class: 'muted' }, `Signed in as ${me.email}`),
      el('form', {
        class: 'stack card',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const display = name.value.trim();
            await q(sb.from('profiles').update({ display_name: display }).eq('id', me.id));
            setCurrentUser({ ...me, displayName: display });
            if (password.value) {
              const { error } = await sb.auth.updateUser({ password: password.value });
              if (error) throw error;
              password.value = '';
            }
            toast('Saved.');
          } catch (err) { fail(err); }
        },
      },
      el('label', { class: 'field' }, el('span', {}, 'Name at the table'), name),
      el('label', { class: 'field' }, el('span', {}, 'New password'), password),
      el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')),
      el('button', { class: 'btn', onclick: () => sb.auth.signOut() }, 'Sign out')));
}
