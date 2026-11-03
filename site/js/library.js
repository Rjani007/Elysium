// NPC and handout editors (storytellers) and the viewers players see once something is revealed.
import { sb, q } from './supa.js';
import { el, fail, toast, modal, confirmDialog, richText } from './util.js';
import { mediaImg, mediaUrl, prepareImage, uploadMedia, removeMedia, dataUrlToFile, ACCEPT_IMAGES, ACCEPT_HANDOUTS } from './media.js';
import { CLANS } from './v5.js';
import { importCharacterFile, npcFromCharacter } from './importers.js';

// ---------- NPCs ----------

export function npcCard(npc, extra = null) {
  return el('article', { class: 'npc-card' },
    el('div', { class: 'portrait' }, npc.portrait_path ? mediaImg(npc.portrait_path, { alt: '' }) : el('span', {}, '🦇')),
    el('div', { class: 'npc-text' },
      el('h3', {}, npc.name),
      npc.title || npc.clan ? el('p', { class: 'muted small' }, [npc.title, npc.clan].filter(Boolean).join(' · ')) : null,
      npc.description ? richText(npc.description) : null,
      extra));
}

/** Create or edit an NPC: its public card, and the secrets only storytellers ever read. */
export async function editNpc(chronicle, npc = null, onSaved = null) {
  const secrets = npc ? (await q(sb.from('npc_secrets').select('*').eq('npc_id', npc.id)))[0] : null;
  const f = {
    name: el('input', { value: npc?.name || '', maxlength: 80, required: true }),
    title: el('input', { value: npc?.title || '', maxlength: 120, placeholder: 'Prince of the city, the bartender at Lucky\'s…' }),
    clan: el('input', { value: npc?.clan || '', maxlength: 60, list: 'clan-list', placeholder: 'As far as the players know' }),
    description: el('textarea', { rows: 4, maxlength: 8000, placeholder: 'What the coterie knows. Players see this once you reveal the NPC.' }, npc?.description || ''),
    notes: el('textarea', { rows: 4, maxlength: 20000, placeholder: 'Only storytellers ever see this.' }, secrets?.notes || ''),
    hunger: el('input', { type: 'number', min: 0, max: 5, value: secrets?.hunger ?? 1 }),
    pools: el('textarea', { rows: 3, placeholder: 'One per line: Label: dice\nPhysical: 6\nDominate: 7' },
      (secrets?.pools || []).map((p) => `${p.label}: ${p.dice}`).join('\n')),
    portrait: el('input', { type: 'file', accept: ACCEPT_IMAGES }),
  };
  // A new NPC can start from a character sheet: a filled-in V5 sheet PDF, a MundusMaker
  // character file or a Progeny save. Nothing is saved until "Add NPC".
  let sheetPortrait = null;
  const sheetFile = el('input', { type: 'file', accept: '.json,application/json,.pdf,application/pdf', hidden: true });
  const sheetNote = el('div', {});
  sheetFile.addEventListener('change', async () => {
    const file = sheetFile.files[0];
    sheetFile.value = '';
    if (!file) return;
    try {
      const { name, data, warnings, portrait } = await importCharacterFile(new Uint8Array(await file.arrayBuffer()));
      const n = npcFromCharacter(name, data);
      f.name.value = n.name;
      f.title.value = n.title;
      f.clan.value = n.clan;
      f.description.value = n.description;
      f.notes.value = n.notes;
      f.hunger.value = n.hunger;
      f.pools.value = n.pools.map((p) => `${p.label}: ${p.dice}`).join('\n');
      sheetPortrait = portrait ? dataUrlToFile(portrait) : null;
      sheetNote.replaceChildren(el('p', { class: 'muted small' }, `Filled in from ${file.name}. Each quick pool pairs a Skill with a usual Attribute; change any before saving.`),
        warnings.length ? el('details', {}, el('summary', { class: 'small' }, `${warnings.length} thing${warnings.length > 1 ? 's' : ''} to check`),
          el('ul', {}, warnings.map((w) => el('li', { class: 'small' }, w)))) : '');
    } catch (err) { fail(err); }
  });
  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, npc ? 'Save' : 'Add NPC');
  const form = el('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        const card = { name: f.name.value.trim(), title: f.title.value.trim(), clan: f.clan.value.trim(), description: f.description.value };
        let row = npc;
        if (npc) row = (await q(sb.from('npcs').update(card).eq('id', npc.id).select()))[0];
        else row = (await q(sb.from('npcs').insert({ chronicle_id: chronicle, ...card }).select()))[0];
        const pools = f.pools.value.split('\n').map((line) => line.match(/^\s*(.+?)\s*[:=]\s*(\d{1,2})\s*$/))
          .filter(Boolean).map((m) => ({ label: m[1].slice(0, 60), dice: Math.min(30, Number(m[2])) })).slice(0, 30);
        await q(sb.from('npc_secrets').update({ notes: f.notes.value, hunger: Math.max(0, Math.min(5, Number(f.hunger.value) || 0)), pools }).eq('npc_id', row.id));
        const file = f.portrait.files[0] || sheetPortrait;
        if (file) {
          const img = await prepareImage(file, 900);
          const path = await uploadMedia({ chronicle, kind: 'npcs', id: row.id, ...img });
          await q(sb.from('npcs').update({ portrait_path: path }).eq('id', row.id));
          if (npc?.portrait_path) removeMedia(npc.portrait_path).catch(() => {});
        }
        toast(npc ? 'NPC saved.' : 'NPC added. Players can\'t see it until you reveal it.');
        close();
        onSaved?.();
      } catch (err) { fail(err); save.disabled = false; }
    },
  },
  npc ? null : el('div', { class: 'stack-tight' },
    el('div', { class: 'row wrap' },
      el('button', { class: 'btn btn-small', type: 'button', onclick: () => sheetFile.click() }, '⇪ Fill in from a character sheet…'),
      el('span', { class: 'muted small' }, 'A filled-in V5 sheet PDF, a MundusMaker character file or a Progeny save'), sheetFile),
    sheetNote),
  el('fieldset', {}, el('legend', {}, 'What players see once revealed'),
    el('label', { class: 'field' }, el('span', {}, 'Name'), f.name),
    el('div', { class: 'two-col' },
      el('label', { class: 'field' }, el('span', {}, 'Title or role'), f.title),
      el('label', { class: 'field' }, el('span', {}, 'Clan'), f.clan)),
    el('label', { class: 'field' }, el('span', {}, 'Description'), f.description),
    el('label', { class: 'field' }, el('span', {}, 'Portrait'), f.portrait)),
  el('fieldset', { class: 'secret' }, el('legend', {}, '🔒 Storyteller only'),
    el('label', { class: 'field' }, el('span', {}, 'Notes'), f.notes),
    el('div', { class: 'two-col' },
      el('label', { class: 'field' }, el('span', {}, 'Hunger'), f.hunger),
      el('label', { class: 'field' }, el('span', {}, 'Quick dice pools'), f.pools))),
  el('datalist', { id: 'clan-list' }, CLANS.map((c) => el('option', { value: c }))));
  const { close } = modal(npc ? `Edit ${npc.name}` : 'New NPC', form, {
    wide: true,
    actions: [
      npc ? el('button', {
        class: 'btn btn-danger', type: 'button', style: 'margin-right:auto',
        onclick: async () => {
          if (!await confirmDialog(`Delete ${npc.name}? This can't be undone.`, { ok: 'Delete', danger: true })) return;
          try {
            await q(sb.from('npcs').delete().eq('id', npc.id));
            if (npc.portrait_path) removeMedia(npc.portrait_path).catch(() => {});
            close();
            onSaved?.();
          } catch (err) { fail(err); }
        },
      }, 'Delete') : null,
      el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      save,
    ],
  });
  save.addEventListener('click', (e) => { e.preventDefault(); form.requestSubmit(); });
  f.name.focus();
}

// ---------- Handouts ----------

export const HANDOUT_ICON = { text: '📜', image: '🖼', pdf: '📄' };

export async function editHandout(chronicle, handout = null, onSaved = null) {
  const kind = el('select', { disabled: !!handout },
    el('option', { value: 'text' }, 'Written note'),
    el('option', { value: 'image' }, 'Picture'),
    el('option', { value: 'pdf' }, 'PDF'));
  kind.value = handout?.kind || 'text';
  const title = el('input', { value: handout?.title || '', maxlength: 120, required: true, placeholder: 'A letter sealed in black wax' });
  const body = el('textarea', { rows: 8, maxlength: 20000, placeholder: 'The text players will read. **bold** and *italic* work.' }, handout?.body || '');
  const file = el('input', { type: 'file', accept: ACCEPT_HANDOUTS });
  const bodyField = el('label', { class: 'field' }, el('span', {}, 'Text'), body);
  const fileField = el('label', { class: 'field' }, el('span', {}, handout?.file_path ? 'Replace the file' : 'File'), file,
    el('small', { class: 'muted' }, 'Pictures are shrunk before upload to keep things quick. 10 MB at most.'));
  const sync = () => {
    bodyField.querySelector('span').textContent = kind.value === 'text' ? 'Text' : 'Caption (optional)';
    fileField.hidden = kind.value === 'text';
  };
  kind.addEventListener('change', sync);
  sync();
  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, handout ? 'Save' : 'Add handout');
  const form = el('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      const chosen = file.files[0];
      if (!handout && kind.value !== 'text' && !chosen) return fail(new Error('Choose a file to upload.'));
      if (chosen && kind.value === 'pdf' && chosen.type !== 'application/pdf') return fail(new Error('That is not a PDF.'));
      save.disabled = true;
      try {
        let row = handout;
        if (handout) row = (await q(sb.from('handouts').update({ title: title.value.trim(), body: body.value }).eq('id', handout.id).select()))[0];
        else row = (await q(sb.from('handouts').insert({ chronicle_id: chronicle, title: title.value.trim(), kind: kind.value, body: body.value }).select()))[0];
        if (chosen) {
          const upload = kind.value === 'image' ? await prepareImage(chosen, 2000) : { blob: chosen, type: 'application/pdf', ext: 'pdf' };
          const path = await uploadMedia({ chronicle, kind: 'handouts', id: row.id, ...upload });
          await q(sb.from('handouts').update({ file_path: path }).eq('id', row.id));
          if (handout?.file_path) removeMedia(handout.file_path).catch(() => {});
        }
        toast(handout ? 'Handout saved.' : 'Handout added. Players can\'t see it until you reveal it.');
        close();
        onSaved?.();
      } catch (err) { fail(err); save.disabled = false; }
    },
  },
  el('div', { class: 'two-col' },
    el('label', { class: 'field' }, el('span', {}, 'Kind'), kind),
    el('label', { class: 'field' }, el('span', {}, 'Title'), title)),
  fileField, bodyField);
  const { close } = modal(handout ? `Edit ${handout.title}` : 'New handout', form, {
    wide: true,
    actions: [
      handout ? el('button', {
        class: 'btn btn-danger', type: 'button', style: 'margin-right:auto',
        onclick: async () => {
          if (!await confirmDialog(`Delete "${handout.title}"? Players who had it lose it too.`, { ok: 'Delete', danger: true })) return;
          try {
            await q(sb.from('handouts').delete().eq('id', handout.id));
            if (handout.file_path) removeMedia(handout.file_path).catch(() => {});
            close();
            onSaved?.();
          } catch (err) { fail(err); }
        },
      }, 'Delete') : null,
      el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      save,
    ],
  });
  save.addEventListener('click', (e) => { e.preventDefault(); form.requestSubmit(); });
  title.focus();
}

/** Opens a handout full-size. */
export async function openHandout(h) {
  const body = el('div', { class: 'handout-view' });
  if (h.kind === 'text') body.append(el('div', { class: 'paper' }, richText(h.body)));
  else {
    const url = await mediaUrl(h.file_path);
    if (!url) body.append(el('p', { class: 'muted' }, 'The file is not available.'));
    else if (h.kind === 'image') body.append(el('img', { src: url, alt: h.title }));
    else body.append(el('iframe', { src: url, title: h.title }), el('p', {}, el('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open the PDF in a new tab ↗')));
    if (h.body) body.append(richText(h.body));
  }
  modal(`${HANDOUT_ICON[h.kind]} ${h.title}`, body, { wide: true });
}
