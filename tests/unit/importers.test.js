import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCharacter, detectFormat, normalizeSheet, exportCharacter, exportFileName, fromProgeny } from '../../site/js/importers.js';
import { poolPreview, surgeDice, youtubeId, healthMax, willpowerMax, willpowerLeft } from '../../site/js/v5.js';

// A sheet as MundusMaker's V5 wizard writes it (public/js/sheets/vtm5.js defaults + picks)
const mundusSheet = {
  clan: 'Toreador', generation: 12, bloodPotency: 1, predatorType: 'Siren', sire: 'Isolde', ambition: 'Be adored', desire: 'One more encore',
  attributes: { strength: 1, dexterity: 3, stamina: 2, charisma: 4, manipulation: 3, composure: 3, intelligence: 2, wits: 2, resolve: 2 },
  skills: { Athletics: 1, Brawl: 0, Craft: 0, Drive: 0, Firearms: 0, Larceny: 0, Melee: 1, Stealth: 1, Survival: 0, 'Animal Ken': 0, Etiquette: 2, Insight: 2, Intimidation: 0, Leadership: 0, Performance: 3, Persuasion: 3, Streetwise: 1, Subterfuge: 2, Academics: 1, Awareness: 2, Finance: 0, Investigation: 0, Medicine: 0, Occult: 0, Politics: 1, Science: 0, Technology: 1 },
  specialties: [{ skill: 'Performance', name: 'Singing' }, { skill: 'Persuasion', name: 'Seduction' }],
  disciplines: [{ name: 'Presence', rating: 2, powers: [{ name: 'Awe', level: 1, desc: '', wikiUrl: 'https://example.org/awe' }, { name: 'Lingering Kiss', level: 2, desc: 'my note', wikiUrl: 'javascript:alert(1)' }] },
    { name: 'Auspex', rating: 1, powers: [{ name: 'Heightened Senses', level: 1 }] }],
  advantages: [{ name: 'Beautiful', dots: 2, flaw: false, desc: '' }, { name: 'Enemy', dots: 1, flaw: true, desc: 'jealous ex' }],
  convictions: ['Never harm a performer'], touchstones: [{ name: 'Mara', conviction: '', desc: 'her accompanist' }],
  hunger: 2, humanity: 7, health: { superficial: 1, aggravated: 0 }, willpower: { superficial: 0, aggravated: 0 },
  xp: { total: 10, spent: 3, ledger: [{ label: 'Skill: Performance (2 → 3)', cost: 9 }] }, notes: 'Lives above the club.',
  bloodSurge: '1', resonance: 'Sanguine',
};

test('MundusMaker character file imports losslessly', () => {
  const file = { format: 'mundusmaker.character', version: 1, app: 'MundusMaker 1.9.3', name: 'Celeste', system: 'vtm5', data: mundusSheet };
  assert.equal(detectFormat(file), 'mundusmaker');
  const c = importCharacter(file);
  assert.equal(c.name, 'Celeste');
  assert.equal(c.source, 'mundusmaker');
  assert.equal(c.data.clan, 'Toreador');
  assert.deepEqual(c.data.attributes, mundusSheet.attributes);
  assert.deepEqual(c.data.skills, mundusSheet.skills);
  assert.deepEqual(c.data.specialties, mundusSheet.specialties);
  assert.equal(c.data.disciplines[0].powers[0].wikiUrl, 'https://example.org/awe');
  assert.equal(c.data.disciplines[0].powers[1].wikiUrl, undefined, 'a javascript: link is dropped');
  assert.equal(c.data.disciplines[0].powers[1].desc, 'my note');
  assert.deepEqual(c.data.health, { superficial: 1, aggravated: 0 });
  assert.equal(c.data.xp.total, 10);
  assert.equal(c.data.xp.ledger.length, 1);
  assert.equal(c.data.resonance, 'Sanguine');
  assert.equal(c.data.notes, 'Lives above the club.');
});

test('a non-V5 MundusMaker character is refused with a reason', () => {
  assert.throws(() => importCharacter({ format: 'mundusmaker.character', version: 1, name: 'Bard', system: 'dnd2024', data: {} }),
    /only Vampire: The Masquerade 5e/);
  assert.throws(() => importCharacter({ format: 'mundusmaker.character', version: 2, name: 'X', system: 'vtm5', data: {} }),
    /newer MundusMaker/);
});

test('a MundusMaker entry file uses its V5 sheet block', () => {
  const entry = { id: 'celeste', name: 'Celeste', type: 'character', blocks: [
    { kind: 'text', text: 'secret backstory', secret: true },
    { kind: 'sheet', system: 'vtm5', data: mundusSheet },
  ] };
  assert.equal(detectFormat(entry), 'mundusmaker-entry');
  const c = importCharacter(entry);
  assert.equal(c.name, 'Celeste');
  assert.equal(c.data.attributes.charisma, 4);
  assert.ok(!JSON.stringify(c).includes('secret backstory'), 'other blocks never come along');
});

test('normalizing fixes casing, clamps numbers and drops junk', () => {
  const { data, warnings } = normalizeSheet({
    clan: 'ministry', hunger: 9, humanity: '6', attributes: { Strength: 7, Wisdom: 3 },
    skills: { firearms: 3, 'animal ken': '2', Hacking: 4 }, disciplines: [{ name: 'blood sorcery', rating: 8 }],
    health: { superficial: -2 }, evil: '<script>',
  });
  assert.equal(data.clan, 'The Ministry');
  assert.equal(data.hunger, 5);
  assert.equal(data.humanity, 6);
  assert.equal(data.attributes.strength, 5);
  assert.equal(data.skills.Firearms, 3);
  assert.equal(data.skills['Animal Ken'], 2);
  assert.equal(data.disciplines[0].name, 'Blood Sorcery');
  assert.equal(data.disciplines[0].rating, 5);
  assert.equal(data.health.superficial, 0);
  assert.equal(data.evil, undefined);
  assert.ok(warnings.some((w) => w.includes('Wisdom')));
  assert.ok(warnings.some((w) => w.includes('Hacking')));
});

// Shaped like Progeny's "Download JSON" (schema 11 field names; values invented for the test)
const progeny = {
  id: '', name: 'Viktor Hale', description: 'Ex-cop turned enforcer', sire: 'Unknown', player: 'Sam', chronicle: 'Chicago Nights', sect: 'Anarch',
  clan: 'Ministry', clanBane: 'default',
  predatorType: { name: 'Alleycat', pickedDiscipline: 'potence', pickedSpecialties: [{ skill: 'brawl', name: 'Grappling' }],
    pickedMeritsAndFlaws: [{ name: 'Contacts', level: 3, summary: 'criminal contacts', excludes: [], type: 'merit' }] },
  touchstones: [{ name: 'Rosa', description: 'his sister', conviction: 'Protect family' }],
  ambition: 'Run the South Side', desire: 'Find the snitch',
  attributes: { strength: 3, dexterity: 2, stamina: 3, charisma: 2, manipulation: 3, composure: 2, intelligence: 1, wits: 2, resolve: 2 },
  skills: { athletics: 1, brawl: 3, craft: 0, drive: 2, firearms: 2, melee: 0, larceny: 1, stealth: 1, survival: 0, 'animal ken': 0, etiquette: 0, insight: 1,
    intimidation: 3, leadership: 0, performance: 0, persuasion: 1, streetwise: 2, subterfuge: 1, academics: 0, awareness: 1, finance: 0, investigation: 1,
    medicine: 0, occult: 0, politics: 0, science: 0, technology: 0 },
  skillSpecialties: [{ skill: 'intimidation', name: 'Stickups' }, { skill: 'brawl', name: 'Grappling' }],
  availableDisciplineNames: ['obfuscate', 'presence', 'protean'],
  disciplines: [
    { name: 'Cloak of Shadows', description: '', summary: 'stay unseen while still', dicePool: '-', level: 1, discipline: 'obfuscate', rouseChecks: 0, amalgamPrerequisites: [] },
    { name: 'Daunt', description: '', summary: 'push people away', dicePool: 'Charisma + Presence', level: 1, discipline: 'presence', rouseChecks: 1, amalgamPrerequisites: [] },
    { name: 'Lethal Body', description: '', summary: 'unarmed blows hurt more', dicePool: '', level: 1, discipline: 'potence', rouseChecks: 0, amalgamPrerequisites: [] },
  ],
  disciplineLevels: { obfuscate: 2, presence: 1, potence: 1 },
  rituals: [], bloodPotency: 1, generation: 13, maxHealth: 7, willpower: 4, experience: 5, humanity: 6,
  merits: [{ name: 'Iron Gullet', level: 3, summary: 'drink rancid blood', excludes: [], type: 'merit' }],
  flaws: [{ name: 'Prey Exclusion', level: 1, summary: 'no mortals', excludes: [], type: 'flaw' }],
  notes: 'Owes Mara a favor',
  ephemeral: { hunger: 2, superficialDamage: 1, aggravatedDamage: 1, superficialWillpowerDamage: 2, aggravatedWillpowerDamage: 0, humanityStains: 1, experienceSpent: 2 },
  version: 11,
};

test('a Progeny save imports with its sheet, damage and powers', () => {
  assert.equal(detectFormat(progeny), 'progeny');
  const c = importCharacter(progeny);
  assert.equal(c.source, 'progeny');
  assert.equal(c.name, 'Viktor Hale');
  const d = c.data;
  assert.equal(d.clan, 'The Ministry');
  assert.equal(d.predatorType, 'Alleycat');
  assert.equal(d.concept, 'Ex-cop turned enforcer');
  assert.equal(d.sect, 'Anarch');
  assert.equal(d.skills.Brawl, 3);
  assert.equal(d.skills['Animal Ken'], 0);
  assert.deepEqual(d.specialties, [{ skill: 'Intimidation', name: 'Stickups' }, { skill: 'Brawl', name: 'Grappling' }]);
  const obf = d.disciplines.find((x) => x.name === 'Obfuscate');
  assert.equal(obf.rating, 2, 'levels come from disciplineLevels, not the power count');
  const pres = d.disciplines.find((x) => x.name === 'Presence');
  assert.equal(pres.powers[0].pool, 'Charisma + Presence');
  assert.equal(pres.powers[0].rouse, 1);
  assert.equal(obf.powers[0].pool, undefined, 'a "-" pool means none');
  assert.deepEqual(d.advantages.map((a) => [a.name, a.dots, a.flaw]),
    [['Iron Gullet', 3, false], ['Prey Exclusion', 1, true], ['Contacts', 3, false]]);
  assert.deepEqual(d.convictions, ['Protect family']);
  assert.deepEqual(d.touchstones, [{ name: 'Rosa', conviction: 'Protect family', desc: 'his sister' }]);
  assert.deepEqual(d.health, { superficial: 1, aggravated: 1 });
  assert.deepEqual(d.willpower, { superficial: 2, aggravated: 0 });
  assert.equal(d.hunger, 2);
  assert.equal(d.stains, 1);
  assert.equal(d.humanity, 6);
  assert.deepEqual([d.xp.total, d.xp.spent], [5, 2]);
  assert.equal(d.healthMaxBonus, 1, 'Progeny max health 7 vs Stamina 3 + 3');
  assert.equal(d.willpowerMaxBonus, undefined, 'willpower 4 equals Composure + Resolve');
  assert.equal(healthMax(d), 7);
  assert.equal(willpowerMax(d), 4);
  assert.equal(willpowerLeft(d), 2);
});

test('an old Progeny save without disciplineLevels rates disciplines by power count', () => {
  const old = { ...progeny, version: 3, disciplineLevels: undefined };
  const { data } = fromProgeny(old);
  assert.equal(data.disciplines.find((x) => x.name === 'Obfuscate').rating, 1);
});

test('export writes the MundusMaker character file and round-trips', () => {
  const imported = importCharacter({ format: 'mundusmaker.character', version: 1, name: 'Celeste', system: 'vtm5', data: mundusSheet });
  const file = exportCharacter({ name: 'Celeste', data: imported.data });
  assert.equal(file.format, 'mundusmaker.character');
  assert.equal(file.version, 1);
  assert.equal(file.system, 'vtm5');
  const again = importCharacter(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(again.data, imported.data);
  assert.equal(exportFileName('Céleste du Lac!'), 'Celeste-du-Lac.character.json');
});

test('pool preview and Blood Surge follow the sheet', () => {
  const d = { ...mundusSheet };
  assert.deepEqual(poolPreview(d, { traits: ['attr:charisma', 'skill:Performance'] }), { pool: 7, hunger: 2 });
  assert.deepEqual(poolPreview(d, { traits: ['attr:charisma', 'skill:Performance'], specialty: 'Singing', modifier: -2 }), { pool: 6, hunger: 2 });
  assert.equal(surgeDice({ bloodSurge: 'Add 2 dice' }), 2, 'the number written on the sheet wins');
  assert.equal(surgeDice({ bloodPotency: 0 }), 0);
  assert.equal(surgeDice({ bloodPotency: 1 }), 1);
  assert.equal(surgeDice({ bloodPotency: 3 }), 2);
  assert.equal(surgeDice({ bloodPotency: 10 }), 5);
  assert.deepEqual(poolPreview({ hunger: 4, attributes: { wits: 1 }, skills: {} }, { traits: ['attr:wits', 'skill:Awareness'], modifier: -3 }),
    { pool: 1, hunger: 1 }, 'a pool never drops below one die, and hunger dice never outnumber it');
});

test('YouTube links of every common shape give the video id', () => {
  for (const link of ['https://www.youtube.com/watch?v=HQC9sToSdmM', 'https://youtu.be/HQC9sToSdmM?t=30', 'https://music.youtube.com/watch?v=HQC9sToSdmM&list=x',
    'https://www.youtube.com/embed/HQC9sToSdmM', 'https://youtube.com/shorts/HQC9sToSdmM', 'HQC9sToSdmM']) {
    assert.equal(youtubeId(link), 'HQC9sToSdmM', link);
  }
  assert.equal(youtubeId('https://example.com/watch?v=HQC9sToSdmM'), null);
  assert.equal(youtubeId('not a link'), null);
});
