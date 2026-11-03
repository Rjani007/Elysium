// A chronicle: its tables and invite links, characters, and for storytellers the NPCs,
// handouts, music and members.
import { sb, q, call, currentUser } from '../supa.js';
import { el, fail, toast, copyText, promptDialog, confirmDialog, compareNames, modal, downloadJson, fmtDay } from '../util.js';
import { go, topbar } from '../main.js';
import { importCharacterFile, exportCharacter, exportFileName, SOURCE_LABEL } from '../importers.js';
import { blankSheet, youtubeId } from '../v5.js';
import { mediaImg, mediaUrl, dataUrlToFile, prepareImage, uploadMedia, removeChronicleMedia } from '../media.js';
import { npcCard, editNpc, editHandout, openHandout, HANDOUT_ICON } from '../library.js';
import { revealControl, revealsByItem } from '../reveal.js';

const TABS = [
  ['tables', 'Tables'], ['characters', 'Characters'], ['npcs', 'NPCs', true], ['handouts', 'Handouts', true],
  ['music', 'Music', true], ['members', 'Members'], ['settings', 'Settings', true],
];

export async function render(root, chronicleId, tab = 'tables') {
  const me = currentUser();
  const [chronicle] = await q(sb.from('chronicles').select('*').eq('id', chronicleId));
  if (!chronicle) throw new Error("This chronicle doesn't exist, or you aren't a member of it.");
  const members = await q(sb.from('chronicle_members').select('user_id, role, joined_at, profile:profiles(display_name)').eq('chronicle_id', chronicleId));
  for (const m of members) m.display_name = m.profile?.display_name || 'Player';
  members.sort((a, b) => (a.role === b.role ? compareNames(a.display_name, b.display_name) : a.role === 'storyteller' ? -1 : 1));
  const isST = members.some((m) => m.user_id === me.id && m.role === 'storyteller');
  if (!TABS.some(([key, , st]) => key === tab && (!st || isST))) tab = 'tables';

  const ctx = { chronicle: chronicleId, chronicleRow: chronicle, members, isST, me, tables: [] };
  ctx.tables = await q(sb.from('game_tables').select('*').eq('chronicle_id', chronicleId).order('created_at'));

  const panel = el('section', { class: 'tab-panel' });
  root.append(topbar({ href: '#/', label: 'Chronicles' }, chronicle.name),
    el('main', { class: 'page' },
      el('div', { class: 'page-head' },
        el('h1', {}, chronicle.name),
        el('span', { class: `badge badge-${isST ? 'storyteller' : 'player'}` }, isST ? 'Storyteller' : 'Player')),
      chronicle.description ? el('p', { class: 'muted lead' }, chronicle.description) : null,
      el('nav', { class: 'tabs', role: 'tablist' }, TABS.filter(([, , st]) => !st || isST).map(([key, label]) =>
        el('a', { href: `#/c/${chronicleId}/${key}`, role: 'tab', class: key === tab ? 'active' : '', 'aria-selected': String(key === tab) }, label))),
      panel));

  const views = { tables, characters, npcs, handouts, music, members: membersTab, settings };
  const draw = async () => {
    try { panel.replaceChildren(await views[tab](ctx, draw)); } catch (err) { fail(err); }
  };
  await draw();
}

// ---------- Tables ----------

async function tables(ctx, redraw) {
  const { isST, chronicle } = ctx;
  ctx.tables = await q(sb.from('game_tables').select('*').eq('chronicle_id', chronicle).order('created_at'));
  const seats = await q(sb.from('seats').select('table_id, user_id').eq('chronicle_id', chronicle));
  const invites = isST ? await q(sb.from('table_invites').select('*').eq('chronicle_id', chronicle)) : [];
  const name = (id) => ctx.members.find((m) => m.user_id === id)?.display_name || 'Player';
  const link = (code) => `${location.origin}${location.pathname}#/join/${code}`;

  const cards = ctx.tables.map((t) => {
    const seated = seats.filter((s) => s.table_id === t.id);
    const invite = invites.find((i) => i.table_id === t.id);
    const unseated = ctx.members.filter((m) => m.role === 'player' && !seated.some((s) => s.user_id === m.user_id));
    return el('article', { class: 'card stack' },
      el('div', { class: 'row spread' },
        el('h2', {}, t.name),
        el('a', { class: 'btn btn-primary', href: `#/t/${t.id}` }, 'Open table →')),
      el('div', { class: 'row wrap' },
        seated.length ? seated.map((s) => el('span', { class: 'chip' }, name(s.user_id),
          isST ? el('button', {
            class: 'chip-x', title: 'Unseat', 'aria-label': `Unseat ${name(s.user_id)}`,
            onclick: async () => { try { await call('unseat', { p_table: t.id, p_user: s.user_id }); redraw(); } catch (err) { fail(err); } },
          }, '✕') : null)) : el('span', { class: 'muted small' }, 'Nobody seated yet.'),
        isST && unseated.length ? (() => {
          const sel = el('select', { 'aria-label': 'Seat a member' }, el('option', { value: '' }, '+ Seat a member'),
            unseated.map((m) => el('option', { value: m.user_id }, m.display_name)));
          sel.addEventListener('change', async () => {
            if (!sel.value) return;
            try { await call('seat_member', { p_table: t.id, p_user: sel.value }); redraw(); } catch (err) { fail(err); }
          });
          return sel;
        })() : null),
      isST ? el('div', { class: 'invite' },
        invite
          ? [el('code', { class: 'invite-link' }, link(invite.code)),
            el('div', { class: 'row wrap' },
              el('button', { class: 'btn btn-small', onclick: () => copyText(link(invite.code)) }, 'Copy invite link'),
              el('button', { class: 'btn btn-small', onclick: async () => { await call('regenerate_invite', { p_table: t.id }).catch(fail); redraw(); } }, 'New link'),
              el('button', { class: 'btn btn-small', onclick: async () => { await call('disable_invite', { p_table: t.id }).catch(fail); redraw(); } }, 'Turn off invites'))]
          : el('div', { class: 'row' }, el('span', { class: 'muted small' }, 'Invites are off.'),
            el('button', { class: 'btn btn-small', onclick: async () => { await call('regenerate_invite', { p_table: t.id }).catch(fail); redraw(); } }, 'Make an invite link')),
        el('p', { class: 'muted small' }, 'Anyone with the link can join this chronicle as a player and sit at this table.')) : null,
      isST ? el('div', { class: 'row' },
        el('button', {
          class: 'link-btn',
          onclick: async () => {
            const n = await promptDialog('Rename table', { value: t.name, maxlength: 60 });
            if (!n) return;
            try { await q(sb.from('game_tables').update({ name: n }).eq('id', t.id)); redraw(); } catch (err) { fail(err); }
          },
        }, 'Rename'),
        el('button', {
          class: 'link-btn danger',
          onclick: async () => {
            if (!await confirmDialog(`Delete "${t.name}"? Its roll history goes with it.`, { ok: 'Delete table', danger: true })) return;
            try { await q(sb.from('game_tables').delete().eq('id', t.id)); redraw(); } catch (err) { fail(err); }
          },
        }, 'Delete')) : null);
  });

  return el('div', { class: 'stack' },
    ctx.tables.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'muted' }, isST ? 'No tables yet.' : 'You are not seated at any table in this chronicle yet. Ask your storyteller.'),
    isST ? el('button', {
      class: 'btn',
      onclick: async () => {
        const n = await promptDialog('New table', { label: 'Name', placeholder: 'The Anarch table, Side session…', maxlength: 60 });
        if (!n) return;
        try { await call('create_table', { p_chronicle: ctx.chronicle, p_name: n }); redraw(); } catch (err) { fail(err); }
      },
    }, '+ Add a table') : null,
    isST ? el('p', { class: 'muted small' }, 'Tables share this chronicle\'s NPCs, handouts and music, but each has its own players, rolls and reveals.') : null);
}

// ---------- Characters ----------

async function characters(ctx, redraw) {
  const { isST, me, chronicle } = ctx;
  const rows = await q(sb.from('characters').select('id, name, owner_id, source, portrait_path, updated_at, data->clan, data->generation, data->predatorType')
    .eq('chronicle_id', chronicle));
  rows.sort((a, b) => compareNames(a.name, b.name));
  const owner = (id) => ctx.members.find((m) => m.user_id === id)?.display_name || 'a former member';

  const fileInput = el('input', { type: 'file', accept: '.json,application/json,.pdf,application/pdf', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) importDialog(ctx, file).catch(fail);
  });

  return el('div', { class: 'stack' },
    el('div', { class: 'row wrap' },
      el('button', { class: 'btn btn-primary', onclick: () => fileInput.click() }, '⇪ Import a character'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          const name = await promptDialog('New character', { label: 'Name', maxlength: 80 });
          if (!name) return;
          try { go(`#/ch/${await call('create_character', { p_chronicle: chronicle, p_name: name, p_data: blankSheet(), p_source: 'manual' })}`); } catch (err) { fail(err); }
        },
      }, '+ Fill in a blank sheet'),
      fileInput),
    el('p', { class: 'muted small' }, 'Imports take MundusMaker character files (⇩ Character file on a V5 sheet), Progeny save files (Save File) ' +
      'and the official fillable V5 character sheet, filled in and saved as a PDF. ' +
      (isST ? 'You see every character in the chronicle.' : 'Only you and the storytellers see your characters.')),
    rows.length ? el('div', { class: 'cards' }, rows.map((c) => el('a', { class: 'card card-link char-card', href: `#/ch/${c.id}` },
      el('div', { class: 'portrait small' }, c.portrait_path ? mediaImg(c.portrait_path, { alt: '' }) : el('span', {}, '🩸')),
      el('div', {},
        el('h3', {}, c.name),
        el('p', { class: 'muted small' }, [c.clan || 'Clan unknown', c.generation ? `${c.generation}th generation` : '', c.predatorType].filter(Boolean).join(' · ')),
        isST && c.owner_id !== me.id ? el('p', { class: 'small' }, `Played by ${owner(c.owner_id)}`) : null))))
      : el('p', { class: 'muted' }, 'No characters yet.'));
}

async function importDialog(ctx, file) {
  const { name, data, warnings, source, portrait } = await importCharacterFile(new Uint8Array(await file.arrayBuffer()));
  const nameInput = el('input', { value: name, maxlength: 80, required: true });
  const ownerSelect = ctx.isST ? el('select', {}, ctx.members.map((m) => el('option', { value: m.user_id, selected: m.user_id === ctx.me.id }, m.user_id === ctx.me.id ? `${m.display_name} (you)` : m.display_name))) : null;
  const d = data;
  const discs = d.disciplines.map((x) => `${x.name} ${x.rating}`).join(', ');
  const { close } = modal('Import a character', el('div', { class: 'stack' },
    el('p', { class: 'muted small' }, `From ${source === 'manual' ? 'a sheet file' : SOURCE_LABEL[source]}.`),
    el('label', { class: 'field' }, el('span', {}, 'Name'), nameInput),
    ownerSelect ? el('label', { class: 'field' }, el('span', {}, 'Played by'), ownerSelect) : null,
    el('dl', { class: 'facts' },
      el('dt', {}, 'Clan'), el('dd', {}, d.clan || '—'),
      el('dt', {}, 'Generation'), el('dd', {}, String(d.generation)),
      el('dt', {}, 'Disciplines'), el('dd', {}, discs || '—'),
      el('dt', {}, 'Hunger / Humanity'), el('dd', {}, `${d.hunger} / ${d.humanity}`)),
    portrait ? el('p', { class: 'small' }, '🖼 The portrait comes along too.') : null,
    warnings.length ? el('details', {}, el('summary', {}, `${warnings.length} thing${warnings.length > 1 ? 's' : ''} to check`),
      el('ul', {}, warnings.map((w) => el('li', { class: 'small' }, w)))) : null), {
    actions: [
      el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const id = await call('create_character', {
              p_chronicle: ctx.chronicle, p_name: nameInput.value.trim() || name, p_data: data, p_source: source,
              p_owner: ownerSelect?.value || null,
            });
            if (portrait) {
              try {
                const img = await prepareImage(dataUrlToFile(portrait), 900);
                const path = await uploadMedia({ chronicle: ctx.chronicle, kind: 'characters', id, ...img });
                await q(sb.from('characters').update({ portrait_path: path }).eq('id', id));
              } catch { toast('The character came in, but its portrait did not.', { tone: 'warn' }); }
            }
            close();
            go(`#/ch/${id}`);
          } catch (err) { fail(err); e.target.disabled = false; }
        },
      }, 'Add to the chronicle'),
    ],
  });
}

export async function exportCharacterFile(character) {
  let portrait = null;
  if (character.portrait_path) {
    try {
      const url = await mediaUrl(character.portrait_path);
      const blob = await (await fetch(url)).blob();
      if (blob.size < 1.5 * 1024 * 1024) {
        portrait = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
      }
    } catch { /* export without it */ }
  }
  downloadJson(exportCharacter(character, { portrait, app: 'Elysium' }), exportFileName(character.name));
}

// ---------- NPCs ----------

async function npcs(ctx, redraw) {
  const rows = await q(sb.from('npcs').select('*').eq('chronicle_id', ctx.chronicle));
  rows.sort((a, b) => compareNames(a.name, b.name));
  const reveals = await revealsByItem(ctx.chronicle);
  return el('div', { class: 'stack' },
    el('div', { class: 'row wrap' },
      el('button', { class: 'btn btn-primary', onclick: () => editNpc(ctx.chronicle, null, redraw) }, '+ Add an NPC')),
    el('p', { class: 'muted small' }, 'NPCs stay hidden until you reveal them to a table or a player. Players only ever see the name, title, clan, description and portrait; notes and dice pools stay yours.'),
    rows.length ? el('div', { class: 'npc-grid' }, rows.map((n) => npcCard(n, el('div', { class: 'stack-tight' },
      revealControl(ctx, { kind: 'npc', id: n.id }, reveals.get(n.id) || [], redraw),
      el('button', { class: 'link-btn', onclick: () => editNpc(ctx.chronicle, n, redraw) }, 'Edit')))))
      : el('p', { class: 'muted' }, 'No NPCs yet.'));
}

// ---------- Handouts ----------

async function handouts(ctx, redraw) {
  const rows = await q(sb.from('handouts').select('*').eq('chronicle_id', ctx.chronicle).order('created_at', { ascending: false }));
  const reveals = await revealsByItem(ctx.chronicle);
  return el('div', { class: 'stack' },
    el('div', { class: 'row wrap' },
      el('button', { class: 'btn btn-primary', onclick: () => editHandout(ctx.chronicle, null, redraw) }, '+ Add a handout')),
    el('p', { class: 'muted small' }, 'Notes, pictures and PDFs. Reveal one to a whole table or a single player; at the table you can also show it on everyone\'s screen at once.'),
    rows.length ? el('div', { class: 'list' }, rows.map((h) => el('article', { class: 'list-row' },
      el('button', { class: 'list-main', onclick: () => openHandout(h).catch(fail) },
        el('span', { class: 'list-icon' }, HANDOUT_ICON[h.kind]),
        el('span', {}, el('strong', {}, h.title), el('span', { class: 'muted small' }, ` · ${fmtDay(h.created_at)}`))),
      revealControl(ctx, { kind: 'handout', id: h.id }, reveals.get(h.id) || [], redraw),
      el('button', { class: 'link-btn', onclick: () => editHandout(ctx.chronicle, h, redraw) }, 'Edit'))))
      : el('p', { class: 'muted' }, 'No handouts yet.'));
}

// ---------- Music ----------

async function music(ctx, redraw) {
  const tracks = await q(sb.from('tracks').select('*').eq('chronicle_id', ctx.chronicle).order('mood').order('title'));
  const link = el('input', { placeholder: 'YouTube link', required: true });
  const title = el('input', { placeholder: 'Title', maxlength: 120, required: true });
  const mood = el('input', { placeholder: 'Mood (Elysium, combat, chase…)', maxlength: 40, list: 'moods' });
  const moods = [...new Set(tracks.map((t) => t.mood).filter(Boolean))];
  const bulk = el('textarea', { rows: 4, placeholder: 'One per line: Title | YouTube link | mood (optional)' });
  const add = async (rows) => {
    const clean = rows.map((r) => ({ ...r, video_id: youtubeId(r.link) })).filter((r) => r.video_id && r.title);
    if (!clean.length) throw new Error('No usable YouTube links there.');
    await q(sb.from('tracks').insert(clean.map((r) => ({ chronicle_id: ctx.chronicle, title: r.title.slice(0, 120), video_id: r.video_id, mood: (r.mood || '').slice(0, 40) }))));
    toast(`${clean.length} track${clean.length > 1 ? 's' : ''} added.`);
    redraw();
  };
  return el('div', { class: 'stack' },
    el('p', { class: 'muted small' }, 'Your playlist for this chronicle. At a table, press play and everyone seated hears the same track at the same moment. The music streams from YouTube to each player, so it costs your Supabase project nothing.'),
    el('form', {
      class: 'card row wrap',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!youtubeId(link.value)) return fail(new Error("That doesn't look like a YouTube link."));
        try { await add([{ link: link.value, title: title.value.trim(), mood: mood.value.trim() }]); } catch (err) { fail(err); }
      },
    }, link, title, mood, el('datalist', { id: 'moods' }, moods.map((m) => el('option', { value: m }))),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Add')),
    el('details', {}, el('summary', {}, 'Add many at once'),
      el('div', { class: 'stack' }, bulk, el('button', {
        class: 'btn',
        onclick: async () => {
          const rows = bulk.value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p.length >= 2)
            .map(([t, l, m]) => ({ title: t, link: l, mood: m }));
          try { await add(rows); bulk.value = ''; } catch (err) { fail(err); }
        },
      }, 'Add these'))),
    tracks.length ? el('div', { class: 'list' }, tracks.map((t) => el('div', { class: 'list-row' },
      el('span', { class: 'list-main' }, el('span', { class: 'list-icon' }, '♪'), el('strong', {}, t.title), t.mood ? el('span', { class: 'chip' }, t.mood) : null),
      el('a', { class: 'link-btn', href: `https://www.youtube.com/watch?v=${t.video_id}`, target: '_blank', rel: 'noopener' }, 'YouTube ↗'),
      el('button', {
        class: 'link-btn danger',
        onclick: async () => { try { await q(sb.from('tracks').delete().eq('id', t.id)); redraw(); } catch (err) { fail(err); } },
      }, 'Remove'))))
      : el('p', { class: 'muted' }, 'No tracks yet.'));
}

// ---------- Members ----------

async function membersTab(ctx, redraw) {
  const { isST, me, chronicle } = ctx;
  const fresh = await q(sb.from('chronicle_members').select('user_id, role, joined_at, profile:profiles(display_name)').eq('chronicle_id', chronicle));
  for (const m of fresh) m.display_name = m.profile?.display_name || 'Player';
  ctx.members = fresh.sort((a, b) => (a.role === b.role ? compareNames(a.display_name, b.display_name) : a.role === 'storyteller' ? -1 : 1));
  return el('div', { class: 'stack' },
    el('div', { class: 'list' }, ctx.members.map((m) => el('div', { class: 'list-row' },
      el('span', { class: 'list-main' }, el('strong', {}, m.display_name), m.user_id === me.id ? el('span', { class: 'muted' }, ' (you)') : null),
      el('span', { class: `badge badge-${m.role}` }, m.role === 'storyteller' ? 'Storyteller' : 'Player'),
      isST && m.user_id !== me.id ? el('button', {
        class: 'link-btn',
        onclick: async () => {
          try { await call('set_member_role', { p_chronicle: chronicle, p_user: m.user_id, p_role: m.role === 'storyteller' ? 'player' : 'storyteller' }); redraw(); } catch (err) { fail(err); }
        },
      }, m.role === 'storyteller' ? 'Make player' : 'Make storyteller') : null,
      isST && m.user_id !== me.id ? el('button', {
        class: 'link-btn danger',
        onclick: async () => {
          if (!await confirmDialog(`Remove ${m.display_name} from the chronicle? Their characters stay with you.`, { ok: 'Remove', danger: true })) return;
          try { await call('remove_member', { p_chronicle: chronicle, p_user: m.user_id }); redraw(); } catch (err) { fail(err); }
        },
      }, 'Remove') : null))),
    el('button', {
      class: 'btn',
      onclick: async () => {
        if (!await confirmDialog('Leave this chronicle? You lose access to it and your characters in it stay with the storytellers.', { ok: 'Leave', danger: true })) return;
        try { await call('remove_member', { p_chronicle: chronicle, p_user: me.id }); go('#/'); } catch (err) { fail(err); }
      },
    }, 'Leave this chronicle'));
}

// ---------- Settings ----------

async function settings(ctx) {
  const c = ctx.chronicleRow;
  const name = el('input', { value: c.name, maxlength: 80, required: true });
  const description = el('textarea', { rows: 3, maxlength: 4000 }, c.description);
  return el('div', { class: 'stack narrow-block' },
    el('form', {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        try { await q(sb.from('chronicles').update({ name: name.value.trim(), description: description.value }).eq('id', c.id)); toast('Saved.'); go(`#/c/${c.id}/settings`); } catch (err) { fail(err); }
      },
    },
    el('label', { class: 'field' }, el('span', {}, 'Name'), name),
    el('label', { class: 'field' }, el('span', {}, 'Description'), description),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')),
    el('div', { class: 'card stack danger-zone' },
      el('h2', {}, 'Delete this chronicle'),
      el('p', { class: 'muted small' }, 'Deletes every table, character, NPC, handout and roll in it, for everyone. There is no undo, so export the characters you want to keep first.'),
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          const typed = await promptDialog('Delete the chronicle', { label: `Type "${c.name}" to confirm`, ok: 'Delete forever' });
          if (typed !== c.name) { if (typed) toast('The name did not match, so nothing was deleted.'); return; }
          try {
            await removeChronicleMedia(c.id);
            await q(sb.from('chronicles').delete().eq('id', c.id));
            go('#/');
          } catch (err) { fail(err); }
        },
      }, 'Delete chronicle…')));
}
