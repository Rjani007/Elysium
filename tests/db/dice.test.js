// V5 rolls are made by the database. These tests check the pools it builds from sheets,
// what rolls do to the sheet, and that nobody can forge or peek at a roll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chronicleWith, rpc, refused, rows, sheet } from './helpers.js';

async function seatedCharacter(overrides = {}) {
  const ctx = await chronicleWith(['Ana', 'Ben']);
  const [ana] = ctx.players;
  const id = await rpc(ana, 'create_character', { p_chronicle: ctx.chronicle, p_name: 'Rosa', p_data: sheet(overrides) });
  await rpc(ana, 'choose_character', { p_table: ctx.table, p_character: id });
  return { ...ctx, ana, ben: ctx.players[1], id };
}

const dataOf = async (user, id) => (await rows(user, 'characters', (q) => q.eq('id', id)))[0].data;

test('a pool is built on the server from the sheet, with hunger dice from the sheet', async () => {
  const { ana, table, id } = await seatedCharacter({ hunger: 2 });
  const r = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['attr:strength', 'skill:brawl'], p_modifier: 1, p_specialty: 'Grappling' });
  assert.equal(r.pool, 3 + 3 + 1 + 1);
  assert.equal(r.hunger, 2);
  assert.equal(r.regular.length, 6);
  assert.equal(r.hunger_dice.length, 2);
  assert.equal(r.label, 'Strength + Brawl + Specialty: Grappling');
  assert.deepEqual(r.parts.map((p) => [p.name, p.value]), [['Strength', 3], ['Brawl', 3], ['Modifier', 1], ['Specialty: Grappling', 1]]);
  assert.equal(r.who, 'Rosa');
  for (const d of [...r.regular, ...r.hunger_dice]) assert.ok(d >= 1 && d <= 10);
  const disc = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['attr:strength', 'disc:potence'] });
  assert.equal(disc.pool, 5);
  await refused(rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['disc:dominate'] }), /no discipline called/);
  await refused(rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['attr:luck'] }), /unknown attribute/);
});

test('hunger can\'t be dodged: a player\'s hunger override is ignored for their character', async () => {
  const { ana, table, id } = await seatedCharacter({ hunger: 4 });
  const r = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['attr:wits', 'skill:awareness'], p_hunger: 0 });
  assert.equal(r.hunger, 4);
  const small = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 2 });
  assert.equal(small.hunger, 2, 'hunger dice never outnumber the pool');
  const zero = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 0, p_modifier: -5 });
  assert.equal(zero.pool, 1, 'a pool never drops below one die');
});

test('rolls cannot be forged, edited, or made for someone else', async () => {
  const { ana, ben, st, table, chronicle, id } = await seatedCharacter();
  await refused(ana.client.from('rolls').insert({ table_id: table, chronicle_id: chronicle, who: 'Rosa', kind: 'pool', label: 'x', pool: 1, successes: 9, outcome: 'critical_win' }), /permission denied|42501/);
  const r = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 3 });
  await refused(ana.client.from('rolls').update({ successes: 9 }).eq('id', r.id), /permission denied|42501/);
  await refused(ana.client.from('rolls').delete().eq('id', r.id), /permission denied|42501/);
  await refused(rpc(ben, 'roll_pool', { p_table: table, p_character: id, p_pool: 3 }), /not your character/);
  await refused(rpc(ben, 'willpower_reroll', { p_roll: r.id, p_dice: [1] }), /only the player who rolled/);
  await refused(rpc(ben, 'set_roll_difficulty', { p_roll: r.id, p_difficulty: 2 }), /only storytellers/);
  const npc = (await st.client.from('npcs').insert({ chronicle_id: chronicle, name: 'Ghoul' }).select()).data[0];
  await refused(rpc(ana, 'roll_pool', { p_table: table, p_npc: npc.id, p_pool: 4 }), /only storytellers roll for NPCs/);
});

test('private rolls are seen by the roller and storytellers only', async () => {
  const { ana, ben, st, table, id } = await seatedCharacter();
  const secret = await rpc(st, 'roll_pool', { p_table: table, p_pool: 5, p_private: true, p_label: 'Ambush' });
  const mine = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 3, p_private: true });
  const open = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 3 });
  const seen = async (u) => (await rows(u, 'rolls', (q) => q.eq('table_id', table))).map((r) => r.id).sort();
  assert.deepEqual(await seen(ben), [open.id]);
  assert.deepEqual(await seen(ana), [mine.id, open.id].sort());
  assert.deepEqual(await seen(st), [secret.id, mine.id, open.id].sort());
});

test('an unrevealed NPC rolls as "The Storyteller"; a revealed one by name', async () => {
  const { st, ana, table, chronicle } = await seatedCharacter();
  const npc = (await st.client.from('npcs').insert({ chronicle_id: chronicle, name: 'Sheriff Kade' }).select()).data[0];
  await st.client.from('npc_secrets').update({ hunger: 3 }).eq('npc_id', npc.id);
  const hidden = await rpc(st, 'roll_pool', { p_table: table, p_npc: npc.id, p_pool: 6 });
  assert.equal(hidden.who, 'The Storyteller');
  assert.equal(hidden.hunger, 3, 'NPC hunger comes from its secrets');
  // "Show the name" at the table: one roll carries the name, the NPC itself stays hidden
  const named = await rpc(st, 'roll_pool', { p_table: table, p_npc: npc.id, p_pool: 6, p_as: 'Sheriff Kade' });
  assert.equal(named.who, 'Sheriff Kade');
  assert.equal(named.npc_id, npc.id);
  assert.equal(named.hunger, 3);
  assert.equal((await rows(ana, 'npcs')).length, 0, 'naming a roll reveals nothing else');
  assert.notEqual((await rpc(ana, 'roll_pool', { p_table: table, p_pool: 2, p_as: 'The Prince' })).who, 'The Prince', 'players cannot pick a name');
  await st.client.from('reveals').insert({ chronicle_id: chronicle, npc_id: npc.id, table_id: table, revealed_by: st.id });
  assert.equal((await rpc(st, 'roll_pool', { p_table: table, p_npc: npc.id, p_pool: 6 })).who, 'Sheriff Kade');
  assert.equal((await rpc(st, 'roll_pool', { p_table: table, p_pool: 2, p_as: 'A stray dog', p_hunger: 0 })).who, 'A stray dog');
});

test('a Willpower re-roll changes up to three regular dice once and costs Willpower', async () => {
  const { ana, table, id } = await seatedCharacter({ hunger: 2, attributes: { ...sheet().attributes, composure: 1, resolve: 1 } });
  const r = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 6 });
  await refused(rpc(ana, 'willpower_reroll', { p_roll: r.id, p_dice: [1, 2, 3, 4] }), /one to three/);
  await refused(rpc(ana, 'willpower_reroll', { p_roll: r.id, p_dice: [5] }), /hunger dice cannot be re-rolled/);
  await refused(rpc(ana, 'willpower_reroll', { p_roll: r.id, p_dice: [1, 1] }), /not regular dice/);
  const again = await rpc(ana, 'willpower_reroll', { p_roll: r.id, p_dice: [1, 3] });
  assert.equal(again.kind, 'reroll');
  assert.equal(again.parent_id, r.id);
  assert.deepEqual(again.hunger_dice, r.hunger_dice, 'hunger dice stay as rolled');
  assert.equal(again.regular[1], r.regular[1], 'untouched dice stay');
  assert.equal(again.regular[3], r.regular[3]);
  assert.deepEqual((await dataOf(ana, id)).willpower, { superficial: 1, aggravated: 0 });
  await refused(rpc(ana, 'willpower_reroll', { p_roll: r.id, p_dice: [2] }), /already re-rolled/);
  await refused(rpc(ana, 'willpower_reroll', { p_roll: again.id, p_dice: [2] }), /only dice pools/);
  // Willpower 2: a second spend fills the track, a third turns superficial into aggravated
  await rpc(ana, 'willpower_reroll', { p_roll: (await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 4 })).id, p_dice: [1] });
  await rpc(ana, 'willpower_reroll', { p_roll: (await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 4 })).id, p_dice: [1] });
  assert.deepEqual((await dataOf(ana, id)).willpower, { superficial: 1, aggravated: 1 });
  await rpc(ana, 'willpower_reroll', { p_roll: (await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 4 })).id, p_dice: [1] });
  await refused(rpc(ana, 'willpower_reroll', { p_roll: (await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 4 })).id, p_dice: [1] }),
    /Willpower is exhausted/);
});

test('rouse checks raise hunger on a failure, and refuse at Hunger 5 unless forced', async () => {
  const { ana, table, id } = await seatedCharacter({ hunger: 0 });
  let hunger = 0;
  for (let i = 0; i < 12 && hunger < 5; i++) {
    const r = await rpc(ana, 'rouse_check', { p_table: table, p_character: id });
    assert.equal(r.kind, 'rouse');
    const ok = r.regular[0] >= 6;
    assert.equal(r.outcome, ok ? 'rouse_ok' : 'rouse_fail');
    if (!ok) hunger += 1;
    assert.equal((await dataOf(ana, id)).hunger, hunger);
  }
  await rpc(ana, 'patch_character', { p_id: id, p_path: ['hunger'], p_value: 5 });
  await refused(rpc(ana, 'rouse_check', { p_table: table, p_character: id }), /can't be roused on purpose/);
  const forced = await rpc(ana, 'rouse_check', { p_table: table, p_character: id, p_forced: true });
  assert.match(forced.effect, /hunger frenzy test/);
  assert.equal((await dataOf(ana, id)).hunger, 5);
  await refused(rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['attr:strength'], p_surge: true }), /can't be roused on purpose/);
});

test('a rouse re-roll rolls a second die only when the first fails', async () => {
  const { ana, table, id } = await seatedCharacter({ hunger: 0 });
  for (let i = 0; i < 15; i++) {
    await rpc(ana, 'patch_character', { p_id: id, p_path: ['hunger'], p_value: 0 });
    const r = await rpc(ana, 'rouse_check', { p_table: table, p_character: id, p_reroll: true });
    if (r.regular[0] >= 6) assert.equal(r.regular.length, 1);
    else {
      assert.equal(r.regular.length, 2);
      assert.equal(r.outcome, r.regular[1] >= 6 ? 'rouse_ok' : 'rouse_fail');
    }
  }
});

test('Blood Surge rouses first, then adds the corebook\'s dice for the Blood Potency', async () => {
  const { ana, table, id } = await seatedCharacter({ hunger: 1, bloodPotency: 3 });
  const before = (await rows(ana, 'rolls', (q) => q.eq('table_id', table))).length;
  const r = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['attr:strength', 'skill:brawl'], p_surge: true });
  assert.deepEqual(r.parts.at(-1), { name: 'Blood Surge', value: 2 });
  assert.equal(r.pool, 3 + 3 + 2);
  const all = await rows(ana, 'rolls', (q) => q.eq('table_id', table).order('created_at'));
  assert.equal(all.length, before + 2, 'the rouse check is its own roll');
  const rouse = all.at(-2);
  assert.equal(rouse.kind, 'rouse');
  assert.equal(r.hunger, rouse.outcome === 'rouse_fail' ? 2 : 1, 'the surged roll uses the hunger after the rouse');
  await refused(rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['skill:brawl'], p_surge: true }), /includes an Attribute/);
  await rpc(ana, 'patch_character', { p_id: id, p_path: ['bloodSurge'], p_value: 'Add 4 dice' });
  await rpc(ana, 'patch_character', { p_id: id, p_path: ['hunger'], p_value: 1 });
  const written = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['attr:strength'], p_surge: true });
  assert.deepEqual(written.parts.at(-1), { name: 'Blood Surge', value: 4 }, 'a number written on the sheet wins');
  await rpc(ana, 'patch_character', { p_id: id, p_path: ['bloodSurge'], p_value: '' });
  await rpc(ana, 'patch_character', { p_id: id, p_path: ['bloodPotency'], p_value: 0 });
  await refused(rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_traits: ['attr:strength'], p_surge: true }), /Blood Potency 0/);
});

test('remorse rolls the unmarked Humanity boxes and clears stains', async () => {
  const { ana, table, id } = await seatedCharacter({ humanity: 6, stains: 2 });
  const r = await rpc(ana, 'remorse_check', { p_table: table, p_character: id });
  assert.equal(r.pool, 2);
  assert.equal(r.hunger_dice.length, 0);
  const d = await dataOf(ana, id);
  assert.equal(d.stains, 0);
  assert.equal(d.humanity, r.outcome === 'remorse_ok' ? 6 : 5);
  assert.equal(r.outcome, r.regular.some((x) => x >= 6) ? 'remorse_ok' : 'remorse_fail');
  await rpc(ana, 'patch_character', { p_id: id, p_path: ['humanity'], p_value: 8 });
  await rpc(ana, 'patch_character', { p_id: id, p_path: ['stains'], p_value: 4 });
  assert.equal((await rpc(ana, 'remorse_check', { p_table: table, p_character: id })).pool, 1, 'at least one die');
});

test('tracker rolls use undamaged boxes, never hunger dice, and are never re-rolled', async () => {
  const { ana, table, id } = await seatedCharacter({ hunger: 3, humanity: 7, willpower: { superficial: 1, aggravated: 0 } });
  const wp = await rpc(ana, 'tracker_roll', { p_table: table, p_character: id, p_tracker: 'willpower' });
  assert.equal(wp.pool, 3, 'Composure 2 + Resolve 2 minus one damage');
  assert.equal(wp.hunger_dice.length, 0);
  const frenzy = await rpc(ana, 'tracker_roll', { p_table: table, p_character: id, p_tracker: 'frenzy', p_difficulty: 3 });
  assert.equal(frenzy.pool, 3 + 2, 'plus a third of Humanity 7, rounded down');
  assert.equal(frenzy.label, 'Resist frenzy');
  await refused(rpc(ana, 'willpower_reroll', { p_roll: frenzy.id, p_dice: [1] }), /only dice pools/);
  assert.equal((await rpc(ana, 'tracker_roll', { p_table: table, p_character: id, p_tracker: 'humanity' })).pool, 7);
});

test('storytellers set a difficulty after the fact; the verdict follows the same dice', async () => {
  const { ana, st, table, id } = await seatedCharacter();
  const r = await rpc(ana, 'roll_pool', { p_table: table, p_character: id, p_pool: 5 });
  const hard = await rpc(st, 'set_roll_difficulty', { p_roll: r.id, p_difficulty: 15 });
  assert.deepEqual(hard.regular, r.regular);
  assert.equal(hard.difficulty, 15);
  assert.ok(['failure', 'total_failure', 'bestial_failure'].includes(hard.outcome));
  const easy = await rpc(st, 'set_roll_difficulty', { p_roll: r.id, p_difficulty: 1 });
  assert.equal(easy.outcome === 'win' || easy.outcome.endsWith('critical') || easy.outcome.endsWith('_win') || easy.successes < 1, true);
  const cleared = await rpc(st, 'set_roll_difficulty', { p_roll: r.id, p_difficulty: null });
  assert.equal(cleared.difficulty, null);
});

test('the dice are fair enough: every face appears, nothing outside 1-10', async () => {
  const { st, table } = await seatedCharacter();
  const counts = Array(11).fill(0);
  for (let i = 0; i < 20; i++) {
    const r = await rpc(st, 'roll_pool', { p_table: table, p_pool: 30, p_hunger: 0 });
    for (const d of r.regular) counts[d]++;
  }
  assert.equal(counts[0], 0);
  const faces = counts.slice(1);
  assert.equal(faces.reduce((a, b) => a + b), 600);
  // 600 dice: each face expects 60; anything under 25 or over 105 would be a broken generator
  for (const [i, n] of faces.entries()) assert.ok(n > 25 && n < 105, `face ${i + 1} came up ${n} times`);
});
