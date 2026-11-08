// Importing a filled-in official V5 character sheet (PDF). Hermetic: every PDF here is built
// by the test from the sheet's field names alone; the publisher's file is never needed or shipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterFromPdf, officialFieldNames, progenyFieldNames } from '../../site/js/officialsheet.js';
import { importCharacterFile } from '../../site/js/importers.js';

// ---------- a synthetic fillable PDF ----------

// PDF text string: literal for plain ASCII, UTF-16BE hex otherwise
const pdfString = (s) => (/^[\x20-\x7e\n]*$/.test(s)
  ? `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')})`
  : `<FEFF${[...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`);

/**
 * fields: [{ name, type: 'text'|'checkbox'|'pushbutton', value, asOnly, widgets, caption, drawn }].
 * Dotted names become a field tree ("Button7.0" is kid "0" of "Button7"), as on the real sheet.
 * `asOnly` ticks a box through its widget's /AS and leaves /V unset; `widgets: 2` gives a box
 * field two boxes; `caption` is a push button's /MK /CA and `drawn` its appearance's operators.
 * `acroForm: false` drops the form, like a flattened or printed PDF. `imagesOver` names fields
 * to draw a picture over in the page content, the way Progeny ticks Humanity.
 */
function formPdf(fields, { acroForm = true, imagesOver = [] } = {}) {
  const objs = {
    1: null, 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    3: '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 0 >>\nstream\n\nendstream',
  };
  let next = 5;
  const roots = [], annots = [], nodes = new Map(), rects = new Map();
  const node = (path) => {
    if (nodes.has(path)) return nodes.get(path);
    const parts = path.split('.'), parent = parts.length > 1 ? node(parts.slice(0, -1).join('.')) : null;
    const n = { num: next++, partial: parts[parts.length - 1], parent, kids: [], widgetKids: [] };
    if (parent) parent.kids.push(n); else roots.push(n);
    nodes.set(path, n);
    return n;
  };
  const stream = (content) => {
    const num = next++;
    objs[num] = `<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length ${content.length} >>\nstream\n${content}\nendstream`;
    return num;
  };
  fields.forEach((f, i) => {
    const n = node(f.name);
    const x = 20 + (i % 10) * 55, y = 760 - (Math.floor(i / 10) % 40) * 10;
    const widget = (k) => `/Rect [${x} ${y - k * 300} ${x + 40} ${y - k * 300 + 8}] /Subtype /Widget /Type /Annot /P 4 0 R`;
    rects.set(f.name, [x, y, x + 40, y + 8]);
    if (f.type === 'checkbox') {
      const on = !!f.value, look = ` /AS /${on ? 'Yes' : 'Off'} /AP << /N << /Yes 3 0 R /Off 3 0 R >> >>`;
      n.body = f.asOnly ? '/FT /Btn' : `/FT /Btn /V /${on ? 'Yes' : 'Off'}`;
      if ((f.widgets || 1) > 1) {
        for (let k = 0; k < f.widgets; k++) { const w = next++; objs[w] = `<< /Parent ${n.num} 0 R ${widget(k)}${look} >>`; n.widgetKids.push(w); annots.push(w); }
      } else { n.body += ` ${widget(0)}${look}`; annots.push(n.num); }
    } else if (f.type === 'pushbutton') {
      n.body = `/FT /Btn /Ff 65536 ${widget(0)} /MK << ${f.caption ? `/CA ${pdfString(f.caption)}` : ''} >>${f.drawn ? ` /AP << /N ${stream(f.drawn)} 0 R >>` : ''}`;
      annots.push(n.num);
    } else {
      n.body = `/FT /Tx ${f.value ? `/V ${pdfString(String(f.value))}` : ''} /DA (/Helv 0 Tf 0 g) ${widget(0)}`;
      annots.push(n.num);
    }
  });
  for (const n of nodes.values()) {
    const kidNums = [...n.kids.map((k) => k.num), ...n.widgetKids];
    const kids = kidNums.length ? ` /Kids [${kidNums.map((k) => `${k} 0 R`).join(' ')}]` : '';
    objs[n.num] = `<< /T ${pdfString(n.partial)}${n.parent ? ` /Parent ${n.parent.num} 0 R` : ''}${kids} ${n.body || ''} >>`;
  }
  // pictures drawn as pdf-lib draws them: q, translate, scale, Do, Q
  let page = '';
  if (imagesOver.length) {
    const img = next++, content = next++;
    objs[img] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xff\nendstream';
    const ops = imagesOver.map((name) => { const [x0, y0, x1, y1] = rects.get(name); return `q\n1 0 0 1 ${x0 + 2} ${y0 + 1} cm\n${x1 - x0 - 4} 0 0 ${y1 - y0 - 2} 0 0 cm\n/Tick Do\nQ`; }).join('\n');
    objs[content] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
    page = ` /Resources << /XObject << /Tick ${img} 0 R >> >> /Contents ${content} 0 R`;
  }
  objs[1] = `<< /Type /Catalog /Pages 2 0 R${acroForm ? ` /AcroForm << /Fields [${roots.map((r) => `${r.num} 0 R`).join(' ')}] /DA (/Helv 0 Tf 0 g) >>` : ''} >>`;
  objs[4] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${page}${acroForm ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`;
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets = {};
  const size = Math.max(...Object.keys(objs).map(Number)) + 1;
  for (let num = 1; num < size; num++) { if (objs[num] == null) continue; offsets[num] = Buffer.byteLength(out, 'latin1'); out += `${num} 0 obj\n${objs[num]}\nendobj\n`; }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${size}\n0000000000 65535 f\r\n`;
  for (let num = 1; num < size; num++) out += offsets[num] != null ? `${String(offsets[num]).padStart(10, '0')} 00000 n\r\n` : '0000000000 00000 f\r\n';
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

// The official sheet's field kinds: its dots are tick boxes, Health/Willpower are text, Humanity is 10 buttons
const isBox = (n) => (/^[a-z]+\d$/.test(n) && !/^(health|will|adflaw)\d$/.test(n)) || /^potency\d+$/.test(n) || /^(main|adflaw)\d+-\d$/.test(n);
const officialFields = (set = {}) => officialFieldNames().map((name) => {
  const v = set[name];
  if (name.startsWith('Button7.')) return { name, type: 'pushbutton', ...(v || {}) };
  if (isBox(name)) return { name, type: 'checkbox', value: !!v, asOnly: v === 'as-only', widgets: name === 'adflaw1-5' ? 2 : 1 };
  return { name, type: 'text', value: v || '' };
});
const officialPdf = (set) => formPdf(officialFields(set));
const tick = (set, prefix, n) => { for (let k = 1; k <= n; k++) set[`${prefix}${k}`] = true; return set; };

// Humanity as Acrobat's script leaves it: ✔ for each point, ✕ for each Stain
const CHECKED = { caption: '✔' }, STAINED = { caption: '✕' };
// MundusMaker's "Official sheet…" fill draws a filled box and sets no caption
const DRAWN = { drawn: 'q 0 G 0.6 w 0.5 0.5 9 9 re S 0 g 2 2 6 6 re f Q' };

test('the synthetic sheet has the official sheet’s fields: 123 text, 279 boxes, 10 Humanity buttons', () => {
  const fields = officialFields();
  assert.equal(fields.length, 412);
  assert.equal(new Set(fields.map((f) => f.name)).size, 412);
  assert.equal(fields.filter((f) => f.type === 'text').length, 123);
  assert.equal(fields.filter((f) => f.type === 'checkbox').length, 279);
  assert.equal(fields.filter((f) => f.type === 'pushbutton').length, 10);
});

test('a filled-in official sheet imports with dots, damage, Humanity and powers', async () => {
  const set = {
    Name: 'Celeste Marchand', Concept: 'Jazz singer', Predator: 'Siren', Chronicle: 'Chicago Nights', Ambition: 'Be adored', Clan: 'toreador',
    Sire: 'Isolde', Desire: 'One more encore', Generation: '12th', Resonance: 'Sanguine', 'Clan Banes': 'Aesthetic fixation',
    'Blood Surge': 'Add 1 die', totalxp: '35', spentxp: '20 (15 left)', Notes: 'Lives above the club.',
    'Touchstones Convictions': 'Never harm a performer — Mara\nProtect the club',
    'AT.1.1.2.7': 'Singing, Jazz', 'AT.1.1.2.9': 'Seduction',
    Main1: 'Presence', Row1: 'Awe', Row2: '2 - Lingering Kiss', Main2: 'auspex', Row1_2: 'Heightened Senses (1)',
    adflaw1: 'Beautiful', adflaw2: 'Enemy (flaw)', adflaw5: 'Resources',
    health1: '/', health2: 'X', health3: 'o', will1: '/',
  };
  for (const [k, n] of Object.entries({ strength: 1, dexterity: 3, stamina: 2, charisma: 4, manipulation: 3, composure: 3, intelligence: 2, wits: 2, resolve: 2 })) tick(set, k, n);
  for (const [k, n] of Object.entries({ performance: 3, persuasion: 3, etiquette: 2, animalken: 1 })) tick(set, k, n);
  tick(set, 'main1-', 2); tick(set, 'main2-', 1); tick(set, 'hunger', 2); tick(set, 'potency', 1);
  tick(set, 'adflaw1-', 2); tick(set, 'adflaw2-', 1); tick(set, 'adflaw5-', 4);
  set['adflaw1-5'] = true; // row 5's fifth dot is this field's second box
  for (let i = 0; i < 6; i++) set[`Button7.${i}`] = CHECKED;
  set['Button7.6'] = { caption: '4' }; // ✔ as its ZapfDingbats code
  set['Button7.9'] = STAINED;

  const { name, data: d, warnings } = await characterFromPdf(officialPdf(set));
  assert.equal(name, 'Celeste Marchand');
  assert.equal(d.clan, 'Toreador');
  assert.equal(d.generation, 12);
  assert.equal(d.predatorType, 'Siren');
  assert.equal(d.concept, 'Jazz singer');
  assert.equal(d.bloodSurge, 'Add 1 die');
  assert.deepEqual(d.attributes, { strength: 1, dexterity: 3, stamina: 2, charisma: 4, manipulation: 3, composure: 3, intelligence: 2, wits: 2, resolve: 2 });
  assert.equal(d.skills.Performance, 3);
  assert.equal(d.skills['Animal Ken'], 1);
  assert.equal(d.skills.Brawl, 0);
  assert.deepEqual(d.specialties, [{ skill: 'Performance', name: 'Singing' }, { skill: 'Performance', name: 'Jazz' }, { skill: 'Persuasion', name: 'Seduction' }]);
  assert.deepEqual(d.disciplines, [
    { name: 'Presence', rating: 2, powers: [{ name: 'Awe', level: 1, desc: '' }, { name: 'Lingering Kiss', level: 2, desc: '' }] },
    { name: 'Auspex', rating: 1, powers: [{ name: 'Heightened Senses', level: 1, desc: '' }] },
  ]);
  assert.deepEqual(d.advantages, [
    { name: 'Beautiful', dots: 2, flaw: false, desc: '' }, { name: 'Enemy', dots: 1, flaw: true, desc: '' }, { name: 'Resources', dots: 5, flaw: false, desc: '' },
  ]);
  assert.equal(d.hunger, 2);
  assert.equal(d.bloodPotency, 1);
  assert.equal(d.humanity, 7);
  assert.equal(d.stains, 1);
  assert.deepEqual(d.health, { superficial: 1, aggravated: 1 });
  assert.deepEqual(d.willpower, { superficial: 1, aggravated: 0 });
  assert.equal(d.xp.total, 35);
  assert.equal(d.xp.spent, 20);
  assert.deepEqual(d.convictions, ['Never harm a performer']);
  assert.deepEqual(d.touchstones, [{ name: 'Mara', conviction: 'Never harm a performer', desc: '' }]);
  assert.match(d.notes, /^Lives above the club\.\n\nTouchstones & Convictions, from the sheet:\nProtect the club$/);
  assert.ok(warnings.some((w) => /Health box 3 \("o"\)/.test(w)), 'an unknown mark in a Health box is reported');
  assert.ok(warnings.some((w) => /went into the notes/.test(w)));
  assert.equal(warnings.some((w) => /fifth dot/.test(w)), false, 'only row 5 has a fourth dot, so the shared box is row 5’s');
});

test('MundusMaker’s drawn Humanity, ticks kept only in /AS, and the shared fifth dot', async () => {
  const set = { Name: 'Viktor', Clan: 'Thin-blood', strength1: 'as-only', strength2: 'as-only', adflaw1: 'Haven', adflaw5: 'Contacts' };
  tick(set, 'adflaw1-', 4); tick(set, 'adflaw5-', 4);
  set['adflaw1-5'] = true;
  for (let i = 0; i < 5; i++) set[`Button7.${i}`] = DRAWN;
  const { data: d, warnings } = await characterFromPdf(officialPdf(set));
  assert.equal(d.attributes.strength, 2, 'boxes ticked only through their widgets still count');
  assert.equal(d.humanity, 5);
  assert.equal(d.bloodPotency, 0, 'a thin-blood with no Blood Potency dots keeps 0');
  assert.deepEqual(d.advantages.map((a) => a.dots), [5, 5]);
  assert.ok(warnings.some((w) => /share their fifth dot/.test(w)));
  assert.ok(warnings.some((w) => /No Hunger boxes/.test(w)));
  assert.equal(d.hunger, 1);
});

test('empty, flattened and unknown PDFs explain themselves', async () => {
  await assert.rejects(characterFromPdf(officialPdf({})), /still empty/);
  await assert.rejects(characterFromPdf(progenyPdf({})), /still empty/);
  await assert.rejects(characterFromPdf(formPdf([], { acroForm: false })), /no fillable fields/);
  await assert.rejects(characterFromPdf(formPdf([{ name: 'CharacterName', type: 'text', value: 'X' }])), /isn’t a sheet Elysium knows/);
  await assert.rejects(characterFromPdf(new TextEncoder().encode('%PDF-1.7\nnothing here')), /damaged/);
});

// ---------- Progeny's PDF ----------

// What Progeny's "Download PDF" fills beyond the names every copy has: merits, and the
// Health, Willpower and Blood Potency boxes it ticks up to the character's own numbers
const progenyExtra = () => {
  const names = [];
  for (let i = 1; i <= 10; i++) { names.push(`Merit${i}`); for (let l = 1; l <= 5; l++) names.push(`Merit${i}-${l}`); }
  for (let i = 1; i <= 15; i++) names.push(`Health-${i}`);
  for (let i = 1; i <= 10; i++) names.push(`WP-${i}`, `BloodPotency-${i}`);
  names.push('pcConcept', 'Chronicle', 'chronicleTenets', 'Sect', 'Resonance', 'Age', 'Apparent Age', 'Birthday', 'Embrace');
  return names;
};
const progenyFields = (set = {}) => [...progenyFieldNames(), ...progenyExtra()].map((name) => {
  if (name.startsWith('Humanity-')) return { name, type: 'pushbutton' };
  if (/-\d+$/.test(name)) return { name, type: 'checkbox', value: !!set[name] };
  return { name, type: 'text', value: set[name] || '' };
});
const progenyPdf = (set, humanity = 0) => formPdf(progenyFields(set), { imagesOver: Array.from({ length: humanity }, (_, i) => `Humanity-${i + 1}`) });

test('Progeny’s PDF imports, with Humanity read from the ticks it draws on the page', async () => {
  const set = {
    Name: 'Viktor Hale', pcDescription: 'Broad, scarred, always in a leather jacket', pcConcept: 'Bouncer with a past', Sect: 'Anarch', Resonance: 'Choleric',
    'Predator type': 'Alleycat', Ambition: 'Own the club', Clan: 'Brujah', Sire: 'Mara',
    Desire: 'A quiet night', Title: '12', ClanBane: 'Violent temper', ClanCompulsion: 'Rebellion', BloodSurge: '1', Mend: '1 superficial damage',
    specBra: 'Grappling', specStree: 'Gangs, Drugs',
    Disc1: 'Celerity', Disc1_Ability1: 'Cat’s Grace: Keep your balance', Disc1_Ability2: 'Fleetness: Move faster // Dexterity + Athletics // 1 rouse check',
    Disc2: 'Potence', Disc2_Ability1: 'Lethal Body: Hit harder',
    Disc3: 'Celerity (cont.)', Disc3_Ability1: 'Blink: Close the distance // Dexterity + Athletics // 2 rouse checks',
    Disc4: 'Blood sorcery', Disc4_Ability1: 'Corrosive Vitae: Corrode things', Disc4_Ability2: 'Ward against Ghouls: Keep them out // requires: blood; 5 minutes',
    Merit1: 'Resources: Comfortable', Merit2: 'Prey Exclusion (Mortals): Cannot feed on them',
    Convictions: 'Never leave a friend behind (Mara)\n\n (Jules)', touchstoneNotes: 'Mara\nher sire\n\nJules\nthe bartender',
    tEXP: '15 XP', PC_Notes: 'Has a motorbike.',
  };
  for (const [k, n] of Object.entries({ Str: 4, Dex: 3, Sta: 3, Cha: 2, Man: 2, Com: 2, Int: 1, Wit: 2, Res: 2, Bra: 3, Stre: 2, Ath: 2, Inti: 2 })) tick(set, `${k}-`, n);
  tick(set, 'Disc1-', 2); tick(set, 'Disc2-', 1); tick(set, 'Disc3-', 1); tick(set, 'Disc4-', 1);
  tick(set, 'Merit1-', 3); tick(set, 'Merit2-', 2);
  tick(set, 'Health-', 7); tick(set, 'WP-', 4); tick(set, 'BloodPotency-', 2);

  const { name, data: d, warnings } = await characterFromPdf(progenyPdf(set, 6));
  assert.equal(name, 'Viktor Hale');
  assert.equal(d.concept, 'Bouncer with a past');
  assert.equal(d.appearance, 'Broad, scarred, always in a leather jacket', 'Progeny writes its description in pcDescription');
  assert.equal(d.sect, 'Anarch');
  assert.equal(d.resonance, 'Choleric');
  assert.equal(d.predatorType, 'Alleycat');
  assert.equal(d.clan, 'Brujah');
  assert.equal(d.generation, 12, 'Progeny writes the generation in the field named Title');
  assert.equal(d.bane, 'Violent temper');
  assert.equal(d.mendAmount, '1 superficial damage');
  assert.deepEqual(d.attributes, { strength: 4, dexterity: 3, stamina: 3, charisma: 2, manipulation: 2, composure: 2, intelligence: 1, wits: 2, resolve: 2 });
  assert.equal(d.skills.Brawl, 3);
  assert.equal(d.skills.Streetwise, 2);
  assert.equal(d.skills.Firearms, 0);
  assert.deepEqual(d.specialties, [{ skill: 'Brawl', name: 'Grappling' }, { skill: 'Streetwise', name: 'Gangs' }, { skill: 'Streetwise', name: 'Drugs' }]);
  assert.deepEqual(d.disciplines, [
    { name: 'Celerity', rating: 3, powers: [
      { name: 'Cat’s Grace', level: 1, desc: 'Keep your balance', rouse: 0 },
      { name: 'Fleetness', level: 2, desc: 'Move faster', pool: 'Dexterity + Athletics', rouse: 1 },
      { name: 'Blink', level: 3, desc: 'Close the distance', pool: 'Dexterity + Athletics', rouse: 2 },
    ] },
    { name: 'Potence', rating: 1, powers: [{ name: 'Lethal Body', level: 1, desc: 'Hit harder', rouse: 0 }] },
    { name: 'Blood Sorcery', rating: 1, powers: [{ name: 'Corrosive Vitae', level: 1, desc: 'Corrode things', rouse: 0 }] },
  ]);
  assert.deepEqual(d.rituals, [{ name: 'Ward against Ghouls', level: 1, desc: 'Keep them out · requires: blood; 5 minutes' }]);
  assert.deepEqual(d.advantages, [
    { name: 'Resources', dots: 3, flaw: false, desc: 'Comfortable' }, { name: 'Prey Exclusion (Mortals)', dots: 2, flaw: false, desc: 'Cannot feed on them' },
  ]);
  assert.deepEqual(d.convictions, ['Never leave a friend behind']);
  assert.deepEqual(d.touchstones, [{ name: 'Mara', conviction: 'Never leave a friend behind', desc: 'her sire' }, { name: 'Jules', conviction: '', desc: 'the bartender' }]);
  assert.equal(d.humanity, 6, 'one tick picture per point of Humanity');
  assert.equal(d.hunger, 1);
  assert.deepEqual(d.health, { superficial: 0, aggravated: 0 });
  assert.equal(d.bloodPotency, 2);
  assert.equal(d.healthMaxBonus, 1, '7 Health boxes against Stamina 3 + 3');
  assert.equal(d.willpowerMaxBonus, undefined);
  assert.equal(d.xp.total, 15);
  assert.equal(d.notes, 'Has a motorbike.\n\nClan compulsion: Rebellion');
  assert.ok(warnings.some((w) => /Merits and Flaws together/.test(w)));
  assert.ok(warnings.some((w) => /doesn’t carry Hunger/.test(w)));

  const unticked = await characterFromPdf(progenyPdf({ Name: 'Ana', 'Str-1': true }));
  assert.equal(unticked.data.humanity, 7);
  assert.ok(unticked.warnings.some((w) => /No Humanity boxes/.test(w)));
});

test('importCharacterFile reads PDFs and character files alike', async () => {
  const pdf = await importCharacterFile(officialPdf(tick({ Name: 'Rosa', Clan: 'Brujah' }, 'strength', 3)));
  assert.equal(pdf.source, 'pdf');
  assert.equal(pdf.name, 'Rosa');
  assert.equal(pdf.data.attributes.strength, 3);
  assert.equal(pdf.portrait, null);
  const file = { format: 'mundusmaker.character', version: 1, name: 'Rosa', system: 'vtm5', data: { clan: 'Brujah' } };
  const json = await importCharacterFile(new TextEncoder().encode(`﻿${JSON.stringify(file)}`));
  assert.equal(json.source, 'mundusmaker');
  assert.equal(json.data.clan, 'Brujah');
  await assert.rejects(importCharacterFile(new TextEncoder().encode('hello')), /isn't a character file/);
});
