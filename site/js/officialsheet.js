// A filled-in official V5 character sheet (PDF) -> a sheet.
//
// The official sheet is Renegade Game Studios' free fillable PDF. Players fill it in their own
// PDF viewer and import the saved copy; it is read here, in the browser, for its form fields
// and never uploaded. The field names are the map MundusMaker fills (public/js/sheets/
// officialsheets.js, vtmOfficial), checked against Renegade's sheet in October 2026: if the
// publisher revises the sheet, change both. Pure (no DOM), so tests run it in Node on PDFs
// they build themselves. Never commit the publisher's file: it may not be redistributed.

import { readPdf, readForm } from './pdfform.js';
import { ATTRIBUTES, SKILLS, cap, healthMax, willpowerMax } from './v5.js';
import { normalizeSheet } from './importers.js';

// Fields that map straight onto a text key of the sheet
const TEXT_FIELDS = {
  Concept: 'concept', Predator: 'predatorType', Chronicle: 'chronicle', Ambition: 'ambition', Clan: 'clan', Sire: 'sire', Desire: 'desire',
  Resonance: 'resonance', 'Chronicle Tenets': 'tenets', 'Clan Banes': 'bane', 'Blood Surge': 'bloodSurge', 'Mend Amount': 'mendAmount',
  'Power Bonus': 'powerBonus', 'Rouse ReRoll': 'rouseReroll', 'Feeding Penalty': 'feedingPenalty', 'Bane Severity': 'baneSeverity',
  'True age': 'trueAge', 'Apparent Age': 'apparentAge', 'Date of Birth': 'dateOfBirth', 'Date of Death': 'dateOfDeath',
  Appearance: 'appearance', 'Distinguishing features': 'features', History: 'history',
};
// The specialty line under each skill, named by its place on the sheet
const SPECIALTY_FIELDS = {
  'AT.0.0.0': 'Athletics', 'AT.0.1': 'Animal Ken', 'AT.1.0': 'Academics', 'AT.1.1.0': 'Brawl', 'AT.0.0.1': 'Etiquette', 'AT.1.1.2.1': 'Awareness',
  'AT.0.0.2': 'Craft', 'AT.1.1.2.0': 'Insight', 'AT.1.1.1': 'Finance', 'AT.0.0.3': 'Drive', 'AT.1.1.2.2': 'Intimidation', 'AT.1.1.2.3': 'Investigation',
  'AT.1.1.3': 'Firearms', 'AT.1.1.2.5': 'Leadership', 'AT.1.1.2.4': 'Medicine', 'AT.0.0.4': 'Larceny', 'AT.1.1.2.7': 'Performance', 'AT.1.1.2.6': 'Occult',
  'AT.1.1.4': 'Melee', 'AT.1.1.2.9': 'Persuasion', 'AT.1.1.2.8': 'Politics', 'AT.0.0.5': 'Stealth', 'AT.1.1.2.12': 'Streetwise', 'AT.1.1.2.10': 'Science',
  'AT.1.1.5': 'Survival', 'AT.1.1.2.14': 'Subterfuge', 'AT.1.1.2.13': 'Technology',
};
const skillField = (name) => name.toLowerCase().replace(/\s+/g, '');
const powerField = (disc, row) => (disc === 1 ? `Row${row}` : `Row${row}_${disc}`);

// The Humanity boxes are push buttons whose script cycles their caption: a click puts ✔
// (Humanity), the next ✕ (a Stain), the next clears it. A viewer may store those as the
// codes the glyphs have in the buttons' ZapfDingbats font ("4" is ✔, "5" is ✕).
// MundusMaker's fill sets no caption and draws a filled box.
const CHECK = /^(?:[✓✔☑✅]|[34])$/u;
const CROSS = /^(?:[✕✖✗✘×xX]|[5-8])$/u;
const DRAWN_BOX = /\bre\s+f\b/;
// Health and Willpower boxes are text fields: / is Superficial, X Aggravated
const SUPERFICIAL = /^[/\\]+$/;
const AGGRAVATED = /^[xX×✕✖✗✘*]+$/u;

/** Every field name of the official sheet: 412 of them. */
export function officialFieldNames() {
  const names = ['Name', 'Generation', 'Notes', 'Touchstones Convictions', 'totalxp', 'spentxp', ...Object.keys(TEXT_FIELDS), ...Object.keys(SPECIALTY_FIELDS)];
  for (const a of ATTRIBUTES) for (let n = 1; n <= 5; n++) names.push(`${a}${n}`);
  for (const s of SKILLS) for (let n = 1; n <= 5; n++) names.push(`${skillField(s)}${n}`);
  for (let i = 1; i <= 10; i++) names.push(`health${i}`, `will${i}`, `potency${i}`, `Button7.${i - 1}`);
  for (let n = 1; n <= 5; n++) names.push(`hunger${n}`);
  for (let i = 1; i <= 6; i++) {
    names.push(`Main${i}`);
    for (let n = 1; n <= 5; n++) names.push(`main${i}-${n}`, powerField(i, n));
  }
  // rows 1 and 5 share one fifth-dot field ("adflaw1-5", two boxes); there is no "adflaw5-5"
  for (let i = 1; i <= 11; i++) {
    names.push(`adflaw${i}`);
    for (let n = 1; n <= 5; n++) if (!(i === 5 && n === 5)) names.push(`adflaw${i}-${n}`);
  }
  return names;
}

const joinList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
const firstNumber = (s) => { const m = String(s).match(/\d+/); return m ? Number(m[0]) : null; };

// "Heightened Senses", "1 - Heightened Senses", "Heightened Senses (1)": the written level, else the row
function power(raw, row) {
  if (!raw) return null;
  let m = raw.match(/^(?:(?:level|lvl|lv|l)\.?\s*)?([1-5])\s*[:.)\-–—]\s*(.+)$/i);
  if (m) return { name: m[2].trim(), level: Number(m[1]) };
  m = raw.match(/^(.+?)\s*\(\s*(?:(?:level|lvl|lv|l)\.?\s*)?([1-5])\s*\)$/i);
  if (m) return { name: m[1].trim(), level: Number(m[2]) };
  return { name: raw, level: row };
}

/** A PDF's bytes -> { name, data, warnings }. Throws an Error that explains, in plain words, when it can't be used. */
export async function characterFromPdf(bytes) {
  return characterFromForm(await readForm(await readPdf(bytes)));
}

/** The form fields readForm found -> { name, data, warnings }. */
export function characterFromForm(form) {
  const byName = new Map(form.fields.map((f) => [f.name, f]));
  if (!form.fields.length) {
    throw new Error('This PDF has no fillable fields, so there is nothing to read: it may have been printed, scanned or flattened. Import the copy you typed into, or fill in a blank sheet here.');
  }
  const expected = officialFieldNames();
  if (expected.filter((n) => byName.has(n)).length / expected.length < 0.9) {
    if (['Stre-1', 'BloodPotency-1', 'Disc1_Ability1'].some((n) => byName.has(n))) {
      throw new Error('This looks like a PDF from Progeny, which uses a different sheet. In Progeny, press Save File and import that file instead: it carries everything, powers included.');
    }
    throw new Error('This PDF isn’t the official fillable V5 character sheet from Renegade Game Studios, so there’s no telling which box means what. Import that sheet, a MundusMaker character file or a Progeny save file, or fill in a blank sheet here.');
  }

  const text = (name) => String(byName.get(name)?.value ?? '').replace(/\r\n?/g, '\n').trim();
  const ticked = (name) => {
    const f = byName.get(name);
    return !!f && ((!!f.value && f.value !== 'Off') || f.widgets.some((w) => !!w.state && w.state !== 'Off'));
  };
  const dots = (prefix, max = 5) => { let n = 0; for (let i = 1; i <= max; i++) if (ticked(`${prefix}${i}`)) n = i; return n; };
  const marked = (f) => f.widgets.some((w) => (w.caption || '').trim() || DRAWN_BOX.test(w.drawn || ''));
  if (!form.fields.some((f) => (f.type === 'text' ? !!text(f.name) : f.type === 'pushbutton' ? marked(f) : ticked(f.name)))) {
    throw new Error('This copy of the sheet is still empty. Fill it in, save your changes in your PDF viewer, then import the saved file.');
  }
  const warnings = [];

  const attributes = {}, undotted = [];
  for (const a of ATTRIBUTES) {
    attributes[a] = dots(a) || 1;
    if (!dots(a)) undotted.push(cap(a));
  }
  if (undotted.length === ATTRIBUTES.length) warnings.push('No Attribute dots were ticked, so every Attribute starts at 1.');
  else if (undotted.length) warnings.push(`No dots were ticked for ${joinList(undotted)}, so ${undotted.length > 1 ? 'they start' : 'it starts'} at 1, the lowest an Attribute can be.`);

  const skills = Object.fromEntries(SKILLS.map((s) => [s, dots(skillField(s))]));
  const specialties = [];
  for (const [field, skillName] of Object.entries(SPECIALTY_FIELDS)) {
    for (const name of text(field).split(/[,;\n]+/)) if (name.trim()) specialties.push({ skill: skillName, name: name.trim() });
  }

  const disciplines = [];
  for (let i = 1; i <= 6; i++) {
    const name = text(`Main${i}`), rating = dots(`main${i}-`);
    const powers = [];
    for (let row = 1; row <= 5; row++) { const p = power(text(powerField(i, row)), row); if (p) powers.push(p); }
    if (name) disciplines.push({ name, rating, powers });
    else if (rating || powers.length) warnings.push(`Discipline ${i} on the sheet has ${rating ? 'dots' : 'powers'} but no name, so it was left out.`);
  }

  // Rows 1 and 5 share their fifth dot: it counts for a row whose fourth dot is ticked (row 1 when neither is)
  const shared = ticked('adflaw1-5');
  const fifth = { 1: shared && (ticked('adflaw1-4') || !ticked('adflaw5-4')), 5: shared && ticked('adflaw5-4') };
  if (fifth[1] && fifth[5]) warnings.push('On this sheet, rows 1 and 5 of Advantages & Flaws share their fifth dot, so both read as 5 dots. Check them.');
  const advantages = [];
  for (let i = 1; i <= 11; i++) {
    let n = 0;
    for (let k = 1; k <= 4; k++) if (ticked(`adflaw${i}-${k}`)) n = k;
    if (i === 1 || i === 5 ? fifth[i] : ticked(`adflaw${i}-5`)) n = 5;
    const raw = text(`adflaw${i}`);
    if (!raw) { if (n) warnings.push(`Row ${i} of Advantages & Flaws has dots but no name, so it was left out.`); continue; }
    const flaw = /\(\s*flaw\s*\)$/i.test(raw) || /^flaw\s*[:\-–—]/i.test(raw);
    advantages.push({ name: raw.replace(/\s*\(\s*flaw\s*\)$/i, '').replace(/^flaw\s*[:\-–—]\s*/i, '') || raw, dots: n, flaw });
  }

  let hunger = dots('hunger');
  if (!hunger) { hunger = 1; warnings.push('No Hunger boxes were ticked, so Hunger starts at 1.'); }
  let bloodPotency = dots('potency', 10);
  if (!bloodPotency && !/thin/i.test(text('Clan'))) { bloodPotency = 1; warnings.push('No Blood Potency dots were ticked, so Blood Potency starts at 1.'); }

  let humanity = 0, stains = 0;
  for (let i = 0; i < 10; i++) {
    const w = byName.get(`Button7.${i}`)?.widgets[0];
    const mark = (w?.caption || '').trim();
    if (CHECK.test(mark)) humanity++;
    else if (CROSS.test(mark)) stains++;
    else if (!mark && DRAWN_BOX.test(w?.drawn || '')) humanity++;
  }
  if (!humanity) { humanity = 7; warnings.push('No Humanity boxes were marked ✔ (some PDF viewers can’t mark them), so Humanity starts at 7.'); }

  const damage = (prefix, label) => {
    let superficial = 0, aggravated = 0;
    const odd = [];
    for (let i = 1; i <= 10; i++) {
      const mark = text(`${prefix}${i}`);
      if (!mark) continue;
      if (SUPERFICIAL.test(mark)) superficial++;
      else if (AGGRAVATED.test(mark)) aggravated++;
      else odd.push(`${i} ("${mark.slice(0, 10)}")`);
    }
    if (odd.length) warnings.push(`${label} box${odd.length > 1 ? 'es' : ''} ${joinList(odd)} ${odd.length > 1 ? 'hold marks' : 'holds a mark'} that isn’t damage (/ for Superficial, X for Aggravated), so ${odd.length > 1 ? 'they were' : 'it was'} ignored.`);
    return { superficial, aggravated };
  };
  const health = damage('health', 'Health'), willpower = damage('will', 'Willpower');

  // MundusMaker writes each pair as "conviction — touchstone"; anything else goes to the notes
  const convictions = [], touchstones = [], loose = [];
  for (const line of text('Touchstones Convictions').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(.+?)\s+[—–]\s+(.+)$/);
    if (m) { convictions.push(m[1].trim()); touchstones.push({ name: m[2].trim(), conviction: m[1].trim() }); }
    else loose.push(line);
  }
  const notes = [text('Notes')];
  if (loose.length) {
    notes.push(`Touchstones & Convictions, from the sheet:\n${loose.join('\n')}`);
    warnings.push('Touchstones and Convictions not written as “conviction — touchstone” went into the notes. Move them to their place on the sheet.');
  }

  const generationText = text('Generation'), generation = firstNumber(generationText);
  if (generationText && generation == null) warnings.push(`Generation “${generationText.slice(0, 20)}” isn’t a number, so it was set to 13.`);

  const sheet = {
    generation: generation ?? undefined, bloodPotency, hunger, humanity, stains, attributes, skills, specialties, disciplines, advantages,
    convictions, touchstones, health, willpower,
    xp: { total: firstNumber(text('totalxp')) ?? 0, spent: firstNumber(text('spentxp')) ?? 0 },
    notes: notes.filter(Boolean).join('\n\n'),
  };
  for (const [field, key] of Object.entries(TEXT_FIELDS)) { const v = text(field); if (v) sheet[key] = v; }
  const { data, warnings: more } = normalizeSheet(sheet);

  for (const [which, label, max] of [['health', 'Health', healthMax(data)], ['willpower', 'Willpower', willpowerMax(data)]]) {
    const total = data[which].superficial + data[which].aggravated;
    if (total > max) warnings.push(`${label} shows ${total} damage, but this character’s track has only ${max} boxes. If a Discipline or Merit adds boxes, add them on the sheet.`);
  }
  return { name: text('Name').slice(0, 80) || 'Unnamed', data, warnings: [...warnings, ...more] };
}
