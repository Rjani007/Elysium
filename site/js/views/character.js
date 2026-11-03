// One character's full sheet: portrait, name, export and replace, every field editable.
import { sb, q, call, currentUser } from '../supa.js';
import { el, fail, toast, confirmDialog, readFileText, promptDialog } from '../util.js';
import { go, topbar } from '../main.js';
import { sheetView } from '../sheet.js';
import { importCharacter } from '../importers.js';
import { mediaImg, prepareImage, uploadMedia, removeMedia, removeMediaFolder, ACCEPT_IMAGES } from '../media.js';
import { exportCharacterFile } from './chronicle.js';

export async function render(root, id) {
  const [c] = await q(sb.from('characters').select('*').eq('id', id));
  if (!c) throw new Error("This character doesn't exist, or it isn't yours to see.");
  const [chronicle] = await q(sb.from('chronicles').select('id, name').eq('id', c.chronicle_id));
  const me = currentUser();
  const sheet = sheetView(c, { editable: true });

  const portrait = el('div', { class: 'portrait large' });
  const drawPortrait = () => portrait.replaceChildren(c.portrait_path ? mediaImg(c.portrait_path, { alt: c.name }) : el('span', {}, '🩸'));
  drawPortrait();
  const portraitInput = el('input', { type: 'file', accept: ACCEPT_IMAGES, hidden: true });
  portraitInput.addEventListener('change', async () => {
    const file = portraitInput.files[0];
    portraitInput.value = '';
    if (!file) return;
    try {
      const img = await prepareImage(file, 900);
      const path = await uploadMedia({ chronicle: c.chronicle_id, kind: 'characters', id: c.id, ...img });
      await q(sb.from('characters').update({ portrait_path: path }).eq('id', c.id));
      const old = c.portrait_path;
      c.portrait_path = path;
      drawPortrait();
      if (old) removeMedia(old).catch(() => {});
    } catch (err) { fail(err); }
  });

  const title = el('h1', {}, c.name);
  const replaceInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  replaceInput.addEventListener('change', async () => {
    const file = replaceInput.files[0];
    replaceInput.value = '';
    if (!file) return;
    try {
      const parsed = importCharacter(JSON.parse(await readFileText(file)));
      if (!await confirmDialog(`Replace ${c.name}'s whole sheet with the one in this file (${parsed.name})? Damage, hunger and XP come from the file too.`, { ok: 'Replace sheet' })) return;
      const data = await call('replace_character_data', { p_id: c.id, p_data: parsed.data, p_source: parsed.source });
      sheet.update(data);
      toast(parsed.warnings.length ? `Sheet replaced. ${parsed.warnings.length} thing(s) were skipped.` : 'Sheet replaced.');
    } catch (err) { fail(err instanceof SyntaxError ? new Error('That file is not valid JSON.') : err); }
  });

  const channel = sb.channel(`character:${c.id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'characters', filter: `id=eq.${c.id}` }, (msg) => {
      if (JSON.stringify(msg.new.data) !== JSON.stringify(sheet.data)) sheet.update(msg.new.data);
    })
    .subscribe();

  root.append(topbar({ href: '#/', label: 'Chronicles' }, { href: `#/c/${c.chronicle_id}/characters`, label: chronicle?.name || 'Chronicle' }, c.name),
    el('main', { class: 'page' },
      el('div', { class: 'char-head' },
        el('button', { class: 'portrait-btn', title: 'Change the portrait', onclick: () => portraitInput.click() }, portrait),
        el('div', { class: 'stack-tight' },
          el('div', { class: 'row' }, title,
            el('button', {
              class: 'link-btn',
              onclick: async () => {
                const n = await promptDialog('Rename', { value: c.name, maxlength: 80 });
                if (!n || n === c.name) return;
                try { await q(sb.from('characters').update({ name: n }).eq('id', c.id)); c.name = n; title.textContent = n; } catch (err) { fail(err); }
              },
            }, 'Rename')),
          el('p', { class: 'muted small' },
            c.owner_id === me.id ? 'Your character.' : 'You are seeing this as a storyteller.',
            ` Imported from ${{ mundusmaker: 'MundusMaker', progeny: 'Progeny', manual: 'a blank sheet' }[c.source] || c.source}.`),
          el('div', { class: 'row wrap' },
            el('button', { class: 'btn', onclick: () => exportCharacterFile({ ...c, data: sheet.data }).catch(fail) }, '⇩ Export for MundusMaker'),
            el('button', { class: 'btn', onclick: () => replaceInput.click() }, '⇪ Replace from a file'),
            el('button', {
              class: 'btn btn-danger',
              onclick: async () => {
                if (!await confirmDialog(`Delete ${c.name}? Export the sheet first if you want to keep it.`, { ok: 'Delete', danger: true })) return;
                try {
                  await removeMediaFolder(c.chronicle_id, 'characters', c.id).catch(() => {});
                  await q(sb.from('characters').delete().eq('id', c.id));
                  go(`#/c/${c.chronicle_id}/characters`);
                } catch (err) { fail(err); }
              },
            }, 'Delete'),
            portraitInput, replaceInput))),
      sheet.node));

  return () => { sheet.destroy(); sb.removeChannel(channel); };
}
