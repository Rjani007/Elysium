// Sign in, create an account, reset a password.
import { sb, currentUser } from '../supa.js';
import { el, toast, fail } from '../util.js';
import { go, footer } from '../main.js';

export async function render(root, mode = 'signin') {
  if (mode === 'reset') return renderReset(root);
  if (currentUser()) { go('#/'); return; }

  let creating = false;
  const nameField = el('label', { class: 'field', hidden: true },
    el('span', {}, 'Your name at the table'),
    el('input', { name: 'name', autocomplete: 'nickname', maxlength: 40, placeholder: 'What should the others call you?' }));
  const email = el('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' });
  const password = el('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'current-password' });
  const submit = el('button', { class: 'btn btn-primary btn-wide', type: 'submit' }, 'Sign in');
  const switcher = el('button', { class: 'link-btn', type: 'button', onclick: () => setMode(!creating) }, 'New here? Create an account');
  const message = el('p', { class: 'form-note', role: 'alert' });

  const joining = /^#\/join\//.test(sessionStorage.getItem('elysium.after-signin') || '');

  function setMode(create) {
    creating = create;
    nameField.hidden = !create;
    nameField.querySelector('input').required = create;
    password.autocomplete = create ? 'new-password' : 'current-password';
    submit.textContent = create ? 'Create account' : 'Sign in';
    switcher.textContent = create ? 'Already have an account? Sign in' : 'New here? Create an account';
    message.textContent = '';
  }

  const form = el('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      message.textContent = '';
      try {
        if (creating) {
          const { data, error } = await sb.auth.signUp({
            email: email.value.trim(), password: password.value,
            options: { data: { display_name: nameField.querySelector('input').value.trim() }, emailRedirectTo: location.origin + location.pathname },
          });
          if (error) throw error;
          if (!data.session) {
            message.textContent = 'Check your email for a link to confirm your account, then come back and sign in.';
            setMode(false);
          }
        } else {
          const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
          if (error) throw error;
        }
      } catch (err) {
        message.textContent = /invalid login/i.test(err.message) ? 'That email and password don\'t match an account.' : err.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
  nameField,
  el('label', { class: 'field' }, el('span', {}, 'Email'), email),
  el('label', { class: 'field' }, el('span', {}, 'Password'), password),
  message, submit,
  el('div', { class: 'row spread' }, switcher,
    el('button', {
      class: 'link-btn', type: 'button',
      onclick: async () => {
        if (!email.value.trim()) { message.textContent = 'Type your email above first.'; return; }
        const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + location.pathname + '#/reset' });
        message.textContent = error ? error.message : 'If that address has an account, a reset link is on its way.';
      },
    }, 'Forgot password?')));

  root.append(el('div', { class: 'auth-page' },
    el('div', { class: 'auth-card' },
      el('div', { class: 'auth-brand' }, el('img', { src: 'icon.svg', alt: '' }), el('h1', {}, 'Elysium')),
      el('p', { class: 'muted center' }, joining ? 'Sign in or create an account to take your seat.' : 'An online table for Vampire: The Masquerade chronicles.'),
      form),
    footer()));
  if (joining) setMode(true);
  email.focus();
}

function renderReset(root) {
  const password = el('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
  root.append(el('div', { class: 'auth-page' }, el('div', { class: 'auth-card' },
    el('h1', {}, 'Choose a new password'),
    el('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const { error } = await sb.auth.updateUser({ password: password.value });
        if (error) return fail(error);
        toast('Password changed.');
        go('#/');
      },
    }, el('label', { class: 'field' }, el('span', {}, 'New password (8 characters or more)'), password),
    el('button', { class: 'btn btn-primary btn-wide', type: 'submit' }, 'Save password')))));
}
