// Your own notes for a chronicle. Only you can read them, storytellers included (row level
// security in supabase/migrations/20261111000000_notes_chat.sql). The chronicle page and the
// table's side panel both use this panel. It saves as you type: one save at a time, in order,
// so a slow save can never overwrite a newer one. The list reads only each note's start
// (`preview`), and a note's whole text loads when you open it, to keep egress down.

import { sb, q } from './supa.js';
import { el, fail, fmtDay, fmtTime, confirmDialog } from './util.js';

const SAVE_MS = 700;
const when = (iso) => (Date.now() - new Date(iso) < 20 * 3600 * 1000 ? fmtTime(iso) : fmtDay(iso));
const labelOf = (n) => n.title.trim() || (n.preview || n.body || '').trim().split('\n')[0].slice(0, 70) || 'Untitled note';

/** One chronicle's notes: { node, refresh(), flush(), destroy() }. */
export function notesPanel(chronicleId) {
  const node = el('div', { class: 'notes' });
  let notes = [], open = null, timer = null, chain = Promise.resolve(), status = null;

  const setStatus = (text) => { if (status) status.textContent = text; };

  async function load() {
    notes = await q(sb.from('notes').select('id, title, preview, updated_at').eq('chronicle_id', chronicleId).order('updated_at', { ascending: false }));
  }

  function drawList() {
    open = null;
    status = null;
    node.replaceChildren(
      el('div', { class: 'row note-bar' },
        el('button', { class: 'btn btn-small', onclick: () => create() }, '+ New note'),
        el('span', { class: 'muted small' }, 'Only you can read these.')),
      notes.length
        ? el('div', { class: 'list' }, notes.map((n) => el('button', { class: 'list-row note-row', onclick: () => openNote(n) },
          el('span', { class: 'note-row-head' }, el('strong', {}, labelOf(n)), el('span', { class: 'muted small' }, when(n.updated_at))),
          n.title.trim() && n.preview?.trim() ? el('span', { class: 'muted small note-snippet' }, n.preview.trim().split('\n')[0]) : null)))
        : el('p', { class: 'muted small' }, 'No notes yet. Jot down names, clues, debts and plans: nobody else sees them.'));
  }

  async function openNote(n) {
    try {
      const [full] = await q(sb.from('notes').select('id, title, body, preview, updated_at').eq('id', n.id));
      if (!full) { await refresh(); return; }
      drawEditor(full);
    } catch (err) { fail(err); }
  }

  function drawEditor(n) {
    open = n;
    const title = el('input', { class: 'note-title', value: n.title, maxlength: 120, placeholder: 'Title', 'aria-label': 'Title' });
    const body = el('textarea', { class: 'note-body', value: n.body, maxlength: 20000, placeholder: 'Write anything…', 'aria-label': 'Note' });
    status = el('span', { class: 'muted small note-status', 'aria-live': 'polite' }, 'Saved');
    const changed = () => {
      n.title = title.value;
      n.body = body.value;
      setStatus('Saving…');
      clearTimeout(timer);
      timer = setTimeout(() => save(n), SAVE_MS);
    };
    title.addEventListener('input', changed);
    body.addEventListener('input', changed);
    node.replaceChildren(
      el('div', { class: 'row note-bar' },
        el('button', { class: 'link-btn small', onclick: () => back() }, '← All notes'),
        status,
        el('button', { class: 'link-btn small danger', onclick: () => remove(n) }, 'Delete')),
      title, body);
    return title;
  }

  function save(n) {
    clearTimeout(timer);
    timer = null;
    const want = { title: n.title, body: n.body };
    chain = chain.then(async () => {
      try {
        const [row] = await q(sb.from('notes').update(want).eq('id', n.id).select('updated_at, preview'));
        if (row) Object.assign(n, row);
        if (open === n && !timer) setStatus('Saved');
      } catch (err) {
        if (open === n) setStatus('Not saved');
        fail(err);
      }
    });
    return chain;
  }
  /** Saves now whatever is still waiting to be saved. */
  function flush() {
    return timer && open ? save(open) : chain;
  }

  async function back() {
    await flush();
    open = null;
    await refresh();
  }

  async function create() {
    try {
      const [n] = await q(sb.from('notes').insert({ chronicle_id: chronicleId, title: '', body: '' }).select('id, title, body, preview, updated_at'));
      notes.unshift(n);
      drawEditor(n).focus();
    } catch (err) { fail(err); }
  }

  async function remove(n) {
    if (!await confirmDialog(`Delete "${labelOf(n)}"? There is no undo.`, { ok: 'Delete note', danger: true })) return;
    clearTimeout(timer);
    timer = null;
    try {
      await chain;
      await q(sb.from('notes').delete().eq('id', n.id));
      notes = notes.filter((x) => x.id !== n.id);
      drawList();
    } catch (err) { fail(err); }
  }

  /** Reloads the list, unless a note is open (its editor is left alone). */
  async function refresh() {
    if (open) return;
    try { await load(); } catch (err) { fail(err); }
    if (!open) drawList();
  }

  // a closed or hidden tab still saves what was typed; a panel the page has left lets go
  // once nothing is waiting (the chronicle page has no clean-up step of its own)
  const onHide = () => {
    if (!node.isConnected && !timer) { destroy(); return; }
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = () => { flush(); };
  function destroy() {
    flush();
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
  }
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  drawList();
  return { node, refresh, flush, destroy };
}
