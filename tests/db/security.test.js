// Who can see and change what. Runs against the local stack: npm run db:start, then npm run test:db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { chronicleWith, localEnv, newUser, rpc, refused, rows, sheet } from './helpers.js';

test('a chronicle and its tables are visible only to members, tables only to who sits there', async () => {
  const { st, chronicle, table, players: [ana] } = await chronicleWith(['Ana']);
  const table2 = await rpc(st, 'create_table', { p_chronicle: chronicle, p_name: 'Side table' });
  const [inv2] = await rows(st, 'table_invites', (q) => q.eq('table_id', table2));
  const ben = await newUser('Ben');
  await rpc(ben, 'join_table', { p_code: inv2.code });
  const outsider = await newUser('Outsider');

  assert.equal((await rows(ana, 'chronicles')).length, 1);
  assert.equal((await rows(outsider, 'chronicles')).length, 0);
  assert.deepEqual((await rows(ana, 'game_tables')).map((t) => t.id), [table]);
  assert.deepEqual((await rows(ben, 'game_tables')).map((t) => t.id), [table2]);
  assert.equal((await rows(st, 'game_tables')).length, 2);
  assert.equal((await rows(ana, 'table_invites')).length, 0, 'players never see invite codes');
  assert.equal((await rows(outsider, 'profiles')).length, 1, 'strangers only see themselves');
  assert.equal((await rows(ana, 'profiles')).length, 3, 'members see the people they play with');
  assert.equal((await rows(ana, 'seats', (q) => q.eq('table_id', table2))).length, 0);
});

test('players cannot make themselves storytellers or write membership directly', async () => {
  const { chronicle, players: [ana] } = await chronicleWith(['Ana']);
  await refused(ana.client.from('chronicle_members').update({ role: 'storyteller' }).eq('chronicle_id', chronicle).eq('user_id', ana.id), /permission denied|42501/);
  await refused(ana.client.from('chronicle_members').insert({ chronicle_id: chronicle, user_id: ana.id, role: 'storyteller' }), /permission denied|42501/);
  await refused(rpc(ana, 'set_member_role', { p_chronicle: chronicle, p_user: ana.id, p_role: 'storyteller' }), /only storytellers/);
  await refused(ana.client.from('chronicles').insert({ name: 'Mine now' }), /permission denied|42501/);
  const { data } = await ana.client.from('chronicles').update({ name: 'Renamed' }).eq('id', chronicle).select();
  assert.equal(data.length, 0, 'a player rename touches nothing');
});

test('the last storyteller cannot leave or step down', async () => {
  const { st, chronicle, players: [ana] } = await chronicleWith(['Ana']);
  await refused(rpc(st, 'remove_member', { p_chronicle: chronicle, p_user: st.id }), /at least one storyteller/);
  await refused(rpc(st, 'set_member_role', { p_chronicle: chronicle, p_user: st.id, p_role: 'player' }), /at least one storyteller/);
  await rpc(st, 'set_member_role', { p_chronicle: chronicle, p_user: ana.id, p_role: 'storyteller' });
  await rpc(st, 'remove_member', { p_chronicle: chronicle, p_user: st.id });
  assert.equal((await rows(st, 'chronicles')).length, 0);
});

test('characters are private to their owner and the storytellers', async () => {
  const { st, chronicle, players: [ana, ben] } = await chronicleWith(['Ana', 'Ben']);
  const id = await rpc(ana, 'create_character', { p_chronicle: chronicle, p_name: 'Rosa', p_data: sheet(), p_source: 'manual' });
  assert.equal((await rows(ana, 'characters')).length, 1);
  assert.equal((await rows(st, 'characters')).length, 1);
  assert.equal((await rows(ben, 'characters')).length, 0);
  await refused(rpc(ben, 'patch_character', { p_id: id, p_path: ['hunger'], p_value: 5 }), /not your character/);
  await refused(ana.client.from('characters').update({ data: {} }).eq('id', id), /permission denied|42501/);
  // the roster shows the public face of seated characters
  const [table] = await rows(ana, 'game_tables');
  await rpc(ana, 'choose_character', { p_table: table.id, p_character: id });
  await refused(rpc(ben, 'choose_character', { p_table: table.id, p_character: id }), /your own characters/);
  const roster = await rpc(ben, 'table_roster', { p_table: table.id });
  const rosa = roster.find((r) => r.character_id === id);
  assert.equal(rosa.character_name, 'Rosa');
  assert.equal(rosa.clan, 'Brujah');
  assert.equal(Object.keys(rosa).includes('data'), false);
});

test('sheet edits are validated and clamped by the database', async () => {
  const { chronicle, players: [ana] } = await chronicleWith(['Ana']);
  const id = await rpc(ana, 'create_character', {
    p_chronicle: chronicle, p_name: 'Rosa', p_source: 'manual',
    p_data: { ...sheet(), hunger: 12, junk: '<img src=x onerror=alert(1)>', skills: { Brawl: 9, Hacking: 3 } },
  });
  let [c] = await rows(ana, 'characters', (q) => q.eq('id', id));
  assert.equal(c.data.hunger, 5);
  assert.equal(c.data.junk, undefined);
  assert.equal(c.data.skills.Brawl, 5);
  assert.equal(c.data.skills.Hacking, undefined);
  const after = await rpc(ana, 'patch_character', { p_id: id, p_path: ['attributes', 'strength'], p_value: 4 });
  assert.equal(after.attributes.strength, 4);
  await refused(rpc(ana, 'patch_character', { p_id: id, p_path: ['owner_id'], p_value: 'x' }), /unknown sheet field/);
  await refused(rpc(ana, 'patch_character', { p_id: id, p_path: ['attributes', 'luck'], p_value: 3 }), /unknown sheet field/);
  await refused(rpc(ana, 'patch_character', { p_id: id, p_path: ['notes'], p_value: { a: 1 } }), /must be text/);
  [c] = await rows(ana, 'characters', (q) => q.eq('id', id));
  assert.equal(c.data.attributes.strength, 4);
});

test('NPCs and handouts stay hidden until revealed, and their secrets never show', async () => {
  const { st, chronicle, table, players: [ana] } = await chronicleWith(['Ana']);
  const table2 = await rpc(st, 'create_table', { p_chronicle: chronicle, p_name: 'Elsewhere' });
  const [inv2] = await rows(st, 'table_invites', (q) => q.eq('table_id', table2));
  const ben = await newUser('Ben');
  await rpc(ben, 'join_table', { p_code: inv2.code });

  const { data: [npc], error } = await st.client.from('npcs')
    .insert({ chronicle_id: chronicle, name: 'Prince Vallon', title: 'Prince of the city', clan: 'Ventrue', description: 'Old money.' }).select();
  assert.equal(error, null);
  await st.client.from('npc_secrets').update({ notes: 'Secretly a Tzimisce', hunger: 3 }).eq('npc_id', npc.id);
  const { data: [handout] } = await st.client.from('handouts')
    .insert({ chronicle_id: chronicle, title: 'A letter', kind: 'text', body: 'Meet me at midnight.' }).select();

  assert.equal((await rows(ana, 'npcs')).length, 0);
  assert.equal((await rows(ana, 'handouts')).length, 0);
  await refused(ana.client.from('reveals').insert({ chronicle_id: chronicle, npc_id: npc.id, table_id: table, revealed_by: ana.id }), /row-level security|42501/);

  await st.client.from('reveals').insert({ chronicle_id: chronicle, npc_id: npc.id, table_id: table, revealed_by: st.id });
  await st.client.from('reveals').insert({ chronicle_id: chronicle, handout_id: handout.id, user_id: ben.id, revealed_by: st.id });

  const anaNpcs = await rows(ana, 'npcs');
  assert.deepEqual(anaNpcs.map((n) => n.name), ['Prince Vallon']);
  assert.equal((await rows(ana, 'npc_secrets')).length, 0, 'revealing an NPC never reveals its secrets');
  assert.equal((await rows(ben, 'npcs')).length, 0, 'a table reveal stays at that table');
  assert.equal((await rows(ana, 'handouts')).length, 0, 'a personal reveal is personal');
  assert.deepEqual((await rows(ben, 'handouts')).map((h) => h.body), ['Meet me at midnight.']);

  // a reveal cannot reach across chronicles
  const other = await chronicleWith([]);
  await refused(other.st.client.from('reveals').insert({ chronicle_id: other.chronicle, npc_id: npc.id, table_id: other.table, revealed_by: other.st.id }),
    /foreign key|violates|row-level/);

  await st.client.from('reveals').delete().eq('npc_id', npc.id);
  assert.equal((await rows(ana, 'npcs')).length, 0, 'hiding again takes it away');
});

test('media files follow the same rules as the rows they belong to', async () => {
  const { st, chronicle, table, players: [ana, ben] } = await chronicleWith(['Ana', 'Ben']);
  const { data: [handout] } = await st.client.from('handouts')
    .insert({ chronicle_id: chronicle, title: 'Map', kind: 'image' }).select();
  const png = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: 'image/png' });
  const path = `${chronicle}/handouts/${handout.id}/map.png`;
  const up = await st.client.storage.from('media').upload(path, png, { contentType: 'image/png' });
  assert.equal(up.error, null);
  await refused(ana.client.storage.from('media').createSignedUrl(path, 60), /not found|denied|unauthor/i);
  await refused(ana.client.storage.from('media').download(path), /.+/);

  await st.client.from('reveals').insert({ chronicle_id: chronicle, handout_id: handout.id, table_id: table, revealed_by: st.id });
  const signed = await ana.client.storage.from('media').createSignedUrl(path, 60);
  assert.equal(signed.error, null);
  assert.ok((await fetch(signed.data.signedUrl)).ok);

  // players can't upload handouts, or portraits for someone else's character
  await refused(ana.client.storage.from('media').upload(`${chronicle}/handouts/${handout.id}/evil.png`, png, { contentType: 'image/png' }), /row-level|denied|unauthor/i);
  const benChar = await rpc(ben, 'create_character', { p_chronicle: chronicle, p_name: 'Bo', p_data: sheet() });
  await refused(ana.client.storage.from('media').upload(`${chronicle}/characters/${benChar}/p.png`, png, { contentType: 'image/png' }), /row-level|denied|unauthor/i);
  const ok = await ben.client.storage.from('media').upload(`${chronicle}/characters/${benChar}/p.png`, png, { contentType: 'image/png' });
  assert.equal(ok.error, null);
  // portraits of characters in the chronicle are visible to its members
  assert.equal((await ana.client.storage.from('media').createSignedUrl(`${chronicle}/characters/${benChar}/p.png`, 60)).error, null);
  // and a character can't borrow another folder for its portrait
  await refused(ben.client.from('characters').update({ portrait_path: path }).eq('id', benChar), /check constraint|violates/);
  // SVG is not accepted at all
  const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' });
  await refused(st.client.storage.from('media').upload(`${chronicle}/handouts/${handout.id}/x.svg`, svg, { contentType: 'image/svg+xml' }), /mime|type|invalid/i);
});

test('removing a member takes away their seats, reveals and access, but keeps their characters', async () => {
  const { st, chronicle, table, players: [ana] } = await chronicleWith(['Ana']);
  const id = await rpc(ana, 'create_character', { p_chronicle: chronicle, p_name: 'Rosa', p_data: sheet() });
  const { data: [h] } = await st.client.from('handouts').insert({ chronicle_id: chronicle, title: 'Note', kind: 'text', body: 'x' }).select();
  await st.client.from('reveals').insert({ chronicle_id: chronicle, handout_id: h.id, user_id: ana.id, revealed_by: st.id });
  await rpc(st, 'remove_member', { p_chronicle: chronicle, p_user: ana.id });
  assert.equal((await rows(ana, 'chronicles')).length, 0);
  assert.equal((await rows(ana, 'characters')).length, 0, 'a removed member no longer reads their old sheet');
  assert.equal((await rows(ana, 'handouts')).length, 0);
  assert.equal((await rows(st, 'seats', (q) => q.eq('table_id', table))).length, 0);
  assert.deepEqual((await rows(st, 'characters')).map((c) => c.id), [id]);
  await refused(rpc(ana, 'roll_pool', { p_table: table, p_pool: 3 }), /not at this table/);
});

test('invites: bad codes fail plainly, new codes retire old ones', async () => {
  const { st, table, code } = await chronicleWith([]);
  const late = await newUser('Late');
  await refused(rpc(late, 'join_table', { p_code: 'nope' }), /not valid/);
  const info = await rpc(late, 'invite_info', { p_code: ` ${code.toUpperCase()} ` });
  assert.deepEqual(info, [{ chronicle_name: 'Test Chronicle', table_name: 'Main table' }]);
  const fresh = await rpc(st, 'regenerate_invite', { p_table: table });
  await refused(rpc(late, 'join_table', { p_code: code }), /not valid/);
  await rpc(late, 'join_table', { p_code: fresh });
  await rpc(st, 'disable_invite', { p_table: table });
  await refused(rpc(await newUser('Later'), 'join_table', { p_code: fresh }), /not valid/);
});

test('nothing is readable without signing in', async () => {
  await chronicleWith(['Ana']);
  const guest = createClient(localEnv().url, localEnv().anon, { auth: { persistSession: false } });
  for (const t of ['chronicles', 'game_tables', 'characters', 'npcs', 'handouts', 'rolls', 'profiles']) {
    const { data, error } = await guest.from(t).select('*');
    assert.ok(error || data.length === 0, `${t} leaked to a signed-out visitor`);
  }
  await refused(guest.rpc('create_chronicle', { p_name: 'x' }), /.+/);
});
