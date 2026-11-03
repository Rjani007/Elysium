// Live updates go through the same row level security as reads: a player's browser is
// never sent a private roll, another table's roll, or an NPC that wasn't revealed to them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chronicleWith, newUser, rpc, rows, wait } from './helpers.js';

function listen(user, events) {
  return new Promise((resolve, reject) => {
    const channel = user.client.channel(`test-${Math.random()}`);
    for (const [name, filter] of Object.entries(events.filters)) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: name, ...(filter ? { filter } : {}) },
        (msg) => events.seen.push({ table: name, type: msg.eventType, row: msg.new }));
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve(channel);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(`realtime ${status}`));
    });
  });
}

test('live roll updates respect private rolls and tables', async () => {
  const { st, chronicle, table, players: [ana] } = await chronicleWith(['Ana']);
  const table2 = await rpc(st, 'create_table', { p_chronicle: chronicle, p_name: 'Other' });
  const [inv2] = await rows(st, 'table_invites', (q) => q.eq('table_id', table2));
  const ben = await newUser('Ben');
  await rpc(ben, 'join_table', { p_code: inv2.code });

  const anaSeen = { seen: [], filters: { rolls: `table_id=eq.${table}`, npcs: `chronicle_id=eq.${chronicle}` } };
  const benSeen = { seen: [], filters: { rolls: null } };
  const subs = [await listen(ana, anaSeen), await listen(ben, benSeen)];
  await wait(1500); // let the subscriptions settle

  const open = await rpc(st, 'roll_pool', { p_table: table, p_pool: 4, p_label: 'Open roll' });
  const secret = await rpc(st, 'roll_pool', { p_table: table, p_pool: 4, p_private: true, p_label: 'Hidden roll' });
  const { data: [npc] } = await st.client.from('npcs').insert({ chronicle_id: chronicle, name: 'Unrevealed' }).select();
  await st.client.from('npcs').update({ description: 'changed' }).eq('id', npc.id);
  await wait(2500);

  const anaRolls = anaSeen.seen.filter((e) => e.table === 'rolls').map((e) => e.row.id);
  assert.deepEqual(anaRolls, [open.id], 'the seated player gets the open roll only');
  assert.ok(!anaRolls.includes(secret.id));
  assert.equal(anaSeen.seen.filter((e) => e.table === 'npcs').length, 0, 'unrevealed NPC changes are not pushed');
  assert.equal(benSeen.seen.filter((e) => e.type === 'INSERT').length, 0, 'another table hears nothing');

  await st.client.from('reveals').insert({ chronicle_id: chronicle, npc_id: npc.id, table_id: table, revealed_by: st.id });
  await st.client.from('npcs').update({ description: 'now public' }).eq('id', npc.id);
  await wait(2500);
  const npcEvents = anaSeen.seen.filter((e) => e.table === 'npcs');
  assert.equal(npcEvents.length, 1);
  assert.equal(npcEvents[0].row.description, 'now public');

  for (const s of subs) await s.unsubscribe();
  await ana.client.removeAllChannels();
  await ben.client.removeAllChannels();
});
