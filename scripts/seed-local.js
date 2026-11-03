// Fills the LOCAL Supabase stack with a demo chronicle to click around in:
// a storyteller and two players, a table, two characters, NPCs, a handout, music.
// Test accounts and their passwords go to .local/test-users.json (git-ignored).
// Usage: npm run db:start, then node scripts/seed-local.js
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { importCharacter } from '../site/js/importers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const status = JSON.parse((s => s.slice(s.indexOf('{')))(execSync('npx supabase status -o json', { cwd: root, encoding: 'utf8' })));
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(status.API_URL)) throw new Error('seed-local only runs against the local stack');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, opts);

const usersFile = `${root}/.local/test-users.json`;
let saved = {};
try { saved = JSON.parse(await readFile(usersFile, 'utf8')); } catch { /* first run */ }

async function user(key, name) {
  const email = `${key}@example.test`;
  const password = saved[key]?.password || randomBytes(15).toString('base64url');
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const existing = list.users.find((u) => u.email === email);
  if (existing) await admin.auth.admin.updateUserById(existing.id, { password });
  else {
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: name } });
    if (error) throw error;
  }
  saved[key] = { email, password, name };
  const client = createClient(status.API_URL, status.PUBLISHABLE_KEY || status.ANON_KEY, opts);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { client, id: data.user.id, name };
}
const must = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };

const st = await user('storyteller', 'Rishi');
const ana = await user('ana', 'Ana');
const ben = await user('ben', 'Ben');
await mkdir(`${root}/.local`, { recursive: true });
await writeFile(usersFile, JSON.stringify(saved, null, 2));

const chronicle = await must(st.client.rpc('create_chronicle', { p_name: 'Chicago Nights (demo)', p_description: 'Winter, 2026. The Camarilla holds the Loop by its fingernails.' }));
const [table] = await must(st.client.from('game_tables').select('*').eq('chronicle_id', chronicle));
await must(st.client.from('game_tables').update({ name: 'Thursday coterie' }).eq('id', table.id));
const [invite] = await must(st.client.from('table_invites').select('*').eq('table_id', table.id));
for (const p of [ana, ben]) await must(p.client.rpc('join_table', { p_code: invite.code }));

const celeste = importCharacter({
  format: 'mundusmaker.character', version: 1, name: 'Celeste Marlowe', system: 'vtm5',
  data: {
    clan: 'Toreador', generation: 12, bloodPotency: 1, predatorType: 'Siren', sire: 'Isolde', ambition: 'Be adored', desire: 'One more encore', concept: 'Torch singer',
    attributes: { strength: 1, dexterity: 3, stamina: 2, charisma: 4, manipulation: 3, composure: 3, intelligence: 2, wits: 2, resolve: 2 },
    skills: { Athletics: 1, Melee: 1, Stealth: 1, Etiquette: 2, Insight: 2, Performance: 3, Persuasion: 3, Streetwise: 1, Subterfuge: 2, Academics: 1, Awareness: 2, Politics: 1, Technology: 1 },
    specialties: [{ skill: 'Performance', name: 'Singing' }, { skill: 'Persuasion', name: 'Seduction' }],
    disciplines: [{ name: 'Presence', rating: 2, powers: [{ name: 'Awe', level: 1, pool: '', rouse: 0 }, { name: 'Lingering Kiss', level: 2 }] },
      { name: 'Auspex', rating: 1, powers: [{ name: 'Heightened Senses', level: 1, pool: 'Wits + Resolve', rouse: 0 }] }],
    advantages: [{ name: 'Beautiful', dots: 2, flaw: false, desc: '' }, { name: 'Enemy', dots: 1, flaw: true, desc: 'a jealous ex' }],
    convictions: ['Never harm a performer'], touchstones: [{ name: 'Mara', conviction: 'Never harm a performer', desc: 'her accompanist' }],
    hunger: 2, humanity: 7, health: { superficial: 0, aggravated: 0 }, willpower: { superficial: 1, aggravated: 0 }, xp: { total: 12, spent: 3 },
  },
});
const viktor = importCharacter({
  name: 'Viktor Hale', description: 'Ex-cop turned enforcer', sire: 'Unknown', chronicle: 'Chicago Nights', sect: 'Anarch', clan: 'Brujah', clanBane: 'default',
  predatorType: { name: 'Alleycat', pickedDiscipline: 'potence', pickedSpecialties: [{ skill: 'intimidation', name: 'Stickups' }], pickedMeritsAndFlaws: [] },
  touchstones: [{ name: 'Rosa', description: 'his sister', conviction: 'Protect family' }], ambition: 'Run the South Side', desire: 'Find the snitch',
  attributes: { strength: 3, dexterity: 2, stamina: 3, charisma: 2, manipulation: 3, composure: 2, intelligence: 1, wits: 2, resolve: 2 },
  skills: { athletics: 1, brawl: 3, craft: 0, drive: 2, firearms: 2, melee: 1, larceny: 1, stealth: 1, survival: 0, 'animal ken': 0, etiquette: 0, insight: 1, intimidation: 3, leadership: 0, performance: 0, persuasion: 1, streetwise: 2, subterfuge: 1, academics: 0, awareness: 1, finance: 0, investigation: 1, medicine: 0, occult: 0, politics: 0, science: 0, technology: 0 },
  skillSpecialties: [{ skill: 'brawl', name: 'Grappling' }], availableDisciplineNames: ['celerity', 'potence', 'presence'],
  disciplines: [{ name: 'Lethal Body', description: '', summary: '', dicePool: '', level: 1, discipline: 'potence', rouseChecks: 0, amalgamPrerequisites: [] },
    { name: 'Daunt', description: '', summary: '', dicePool: 'Charisma + Presence', level: 1, discipline: 'presence', rouseChecks: 1, amalgamPrerequisites: [] }],
  disciplineLevels: { potence: 2, presence: 1, celerity: 0 }, rituals: [], bloodPotency: 1, generation: 13, maxHealth: 6, willpower: 4, experience: 5, humanity: 6,
  merits: [], flaws: [{ name: 'Prey Exclusion', level: 1, summary: '', excludes: [], type: 'flaw' }], notes: '',
  ephemeral: { hunger: 1, superficialDamage: 1, aggravatedDamage: 0, superficialWillpowerDamage: 0, aggravatedWillpowerDamage: 0, humanityStains: 1, experienceSpent: 0 }, version: 11,
});
for (const [player, c] of [[ana, celeste], [ben, viktor]]) {
  const id = await must(player.client.rpc('create_character', { p_chronicle: chronicle, p_name: c.name, p_data: c.data, p_source: c.source }));
  await must(player.client.rpc('choose_character', { p_table: table.id, p_character: id }));
}

const [prince] = await must(st.client.from('npcs').insert({ chronicle_id: chronicle, name: 'Prince Kevin Jackson', title: 'Prince of Chicago', clan: 'Ventrue', description: 'Holds court at the top of a glass tower. Smiles too much.' }).select());
await must(st.client.from('npc_secrets').update({ notes: 'Knows the coterie broke the Masquerade last week.', hunger: 1, pools: [{ label: 'Social', dice: 8 }, { label: 'Dominate', dice: 9 }] }).eq('npc_id', prince.id));
const [sheriff] = await must(st.client.from('npcs').insert({ chronicle_id: chronicle, name: 'The Sheriff', title: 'Enforcer of the Prince', clan: 'Banu Haqim', description: 'Nobody has seen her face.' }).select());
await must(st.client.from('npc_secrets').update({ notes: 'Hunting Viktor.', hunger: 2, pools: [{ label: 'Physical', dice: 8 }, { label: 'Stealth', dice: 9 }] }).eq('npc_id', sheriff.id));
await must(st.client.from('reveals').insert({ chronicle_id: chronicle, npc_id: prince.id, table_id: table.id, revealed_by: st.id }));
const [letter] = await must(st.client.from('handouts').insert({ chronicle_id: chronicle, title: 'A note under the door', kind: 'text', body: 'Celeste,\n\nThe **Prince** knows what you did at the Lyric.\n\nCome alone. Midnight.\n\n*A friend*' }).select());
await must(st.client.from('reveals').insert({ chronicle_id: chronicle, handout_id: letter.id, user_id: ana.id, revealed_by: st.id }));
await must(st.client.from('tracks').insert([
  { chronicle_id: chronicle, title: 'Bloodlines Main Theme', video_id: 'o6qo4msRqxU', mood: 'Elysium' },
  { chronicle_id: chronicle, title: 'Creepy Ambiance 2', video_id: '3Zubws3usK8', mood: 'Tension' },
  { chronicle_id: chronicle, title: 'Disturbed Combat', video_id: 'gVp_bkJyVDg', mood: 'Combat' },
]));
await must(st.client.rpc('roll_pool', { p_table: table.id, p_pool: 6, p_label: 'The Sheriff watches from the rafters', p_private: true }));

console.log(`Seeded "Chicago Nights (demo)". Accounts: storyteller@, ana@, ben@example.test; passwords in .local/test-users.json`);
