// Router and shell. Hash routes, so GitHub Pages never needs server-side rewrites:
//   #/                     your chronicles
//   #/signin               sign in / create an account
//   #/join/<code>          accept a table invite
//   #/c/<chronicle>[/tab]  chronicle: tables, characters, NPCs, handouts, music, members
//   #/ch/<character>       a character sheet
//   #/t/<table>            the live table
//   #/account              your display name, password, sign out

import { sb, configured, q, currentUser, setCurrentUser } from './supa.js';
import { el, fail } from './util.js';

const app = document.getElementById('app');
let cleanup = null;
let renderSeq = 0;

const routes = [
  [/^#\/signin$/, () => import('./views/auth.js'), { public: true }],
  [/^#\/reset$/, () => import('./views/auth.js'), { public: true, args: ['reset'] }],
  [/^#\/join\/([a-z0-9]+)$/i, () => import('./views/join.js')],
  [/^#\/c\/([0-9a-f-]{36})(?:\/(\w+))?$/, () => import('./views/chronicle.js')],
  [/^#\/ch\/([0-9a-f-]{36})$/, () => import('./views/character.js')],
  [/^#\/t\/([0-9a-f-]{36})$/, () => import('./views/table.js')],
  [/^#\/account$/, () => import('./views/account.js')],
  [/^#\/?$/, () => import('./views/home.js')],
];

export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const seq = ++renderSeq;
  const hash = location.hash || '#/';
  const match = routes.find(([re]) => re.test(hash));
  if (!match) return go('#/');
  const [re, load, opts = {}] = match;
  if (!opts.public && !currentUser()) {
    sessionStorage.setItem('elysium.after-signin', hash);
    return go('#/signin');
  }
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* view already gone */ } }
  cleanup = null;
  try {
    const view = await load();
    if (seq !== renderSeq) return;
    // each render gets its own container, so a slow page that finishes after the user
    // has moved on draws into a detached node instead of on top of the new page
    const host = el('div', { class: 'view' });
    app.replaceChildren(host);
    const params = opts.args || hash.match(re).slice(1).map((p) => (p === undefined ? undefined : decodeURIComponent(p)));
    const result = await view.render(host, ...params);
    if (seq !== renderSeq) { if (typeof result === 'function') result(); return; }
    cleanup = result;
    app.focus({ preventScroll: true });
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    app.replaceChildren(el('div', { class: 'page narrow' },
      el('h1', {}, 'That page would not open'),
      el('p', { class: 'muted' }, err.message || String(err)),
      el('p', {}, el('a', { href: '#/' }, '← Back to your chronicles'))));
  }
}

/** The bar at the top of every page except the live table, which draws its own. */
export function topbar(...crumbs) {
  const user = currentUser();
  return el('header', { class: 'topbar' },
    el('a', { class: 'brand', href: '#/' }, el('img', { src: 'icon.svg', alt: '' }), el('span', {}, 'Elysium')),
    el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumbs' }, crumbs.filter(Boolean).map((c) =>
      typeof c === 'string' ? el('span', {}, c) : el('a', { href: c.href }, c.label))),
    user ? el('a', { class: 'user-chip', href: '#/account', title: 'Your account' }, user.displayName || 'Account') : null);
}

// Dark Pack fan-content notice, the same wording MundusMaker carries for its V5 data.
export function footer() {
  return el('footer', { class: 'site-foot' },
    el('p', {}, 'Elysium is an unofficial fan tool for Vampire: The Masquerade. Portions of the materials are the copyrights and trademarks of Paradox Interactive AB, and are used with permission. All rights reserved. For more information please visit ',
      el('a', { href: 'https://www.worldofdarkness.com', target: '_blank', rel: 'noopener' }, 'worldofdarkness.com'), '.'));
}

async function loadProfile(session) {
  if (!session?.user) { setCurrentUser(null); return; }
  const rows = await q(sb.from('profiles').select('display_name').eq('id', session.user.id));
  setCurrentUser({ id: session.user.id, email: session.user.email, displayName: rows[0]?.display_name || 'Player' });
}

function notConfigured() {
  app.replaceChildren(el('div', { class: 'page narrow' },
    el('h1', {}, 'Almost there'),
    el('p', {}, "This copy of Elysium doesn't know its Supabase project yet."),
    el('p', { class: 'muted' }, 'Put your project URL and publishable key in site/config.js (SETUP.md, step 3), commit, and GitHub Pages will publish it again.')));
}

async function boot() {
  if (!configured) return notConfigured();
  const { data } = await sb.auth.getSession();
  await loadProfile(data.session).catch(fail);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { go('#/reset'); return; }
    if (event === 'SIGNED_OUT') { setCurrentUser(null); go('#/signin'); return; }
    if (event === 'SIGNED_IN' && session?.user?.id !== currentUser()?.id) {
      loadProfile(session).then(() => {
        const after = sessionStorage.getItem('elysium.after-signin');
        sessionStorage.removeItem('elysium.after-signin');
        if (location.hash === '#/signin' || location.hash === '' || location.hash === '#/') go(after || '#/');
      }).catch(fail);
    }
  });
  window.addEventListener('hashchange', route);
  route();
}

boot().catch((err) => {
  console.error(err);
  app.replaceChildren(el('div', { class: 'page narrow' }, el('h1', {}, 'Elysium could not start'), el('p', {}, err.message)));
});
