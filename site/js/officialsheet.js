// Filled-in V5 character sheets (PDF) -> a sheet. Two layouts are known:
//   * the official sheet: Renegade Game Studios' free fillable PDF, filled in the player's own
//     PDF viewer. Its field names are the map MundusMaker fills (public/js/sheets/
//     officialsheets.js, vtmOfficial), checked against Renegade's sheet in October 2026.
//   * Progeny's "Download PDF": Nerdbert's 2-page sheet as progeny.odin-matthias.com fills it.
//     The field names come from Progeny's frontend/src/generator/pdfCreator.ts; Progeny is
//     AGPL, so only the names are used here, never its code.
// The PDF is read in the browser for its form fields and never uploaded. MundusMaker reads the
// same two layouts (public/js/sheets/vtmpdfimport.js): if a sheet is revised, change both. Pure
// (no DOM), so tests run it in Node on PDFs they build themselves. Never commit a publisher's or
// Progeny's PDF.

import { readPdf, readForm, pageImages } from './pdfform.js';
import { ATTRIBUTES, SKILLS, cap, healthMax, willpowerMax } from './v5.js';
import { normalizeSheet } from './importers.js';

// ---------- the official sheet ----------

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

// ---------- Progeny's PDF (Nerdbert's sheet) ----------

// Dots are "<prefix>-1".."-5"; the specialty line beside each skill has a name of its own.
// The sheet's names are uneven ("Fri" for Firearms, "specStree" for Streetwise).
const PROGENY_ATTRS = { strength: 'Str', dexterity: 'Dex', stamina: 'Sta', charisma: 'Cha', manipulation: 'Man', composure: 'Com', intelligence: 'Int', wits: 'Wit', resolve: 'Res' };
const PROGENY_SKILLS = {
  Athletics: ['Ath', 'specAth'], Brawl: ['Bra', 'specBra'], Craft: ['Cra', 'specCra'], Drive: ['Dri', 'specDri'], Firearms: ['Fri', 'specFir'],
  Larceny: ['Lar', 'specLar'], Melee: ['Mel', 'specMel'], Stealth: ['Ste', 'specStea'], Survival: ['Sur', 'specSur'],
  'Animal Ken': ['AniKen', 'specAniKen'], Etiquette: ['Etiq', 'specEtiq'], Insight: ['Insi', 'specInsi'], Intimidation: ['Inti', 'specInti'],
  Leadership: ['Lead', 'specLea'], Performance: ['Perf', 'specPerf'], Persuasion: ['Pers', 'specPers'], Streetwise: ['Stre', 'specStree'], Subterfuge: ['Subt', 'specSubt'],
  Academics: ['Acad', 'specAcad'], Awareness: ['Awar', 'specAwar'], Finance: ['Fina', 'specFina'], Investigation: ['Inve', 'specInve'],
  Medicine: ['Medi', 'specMedi'], Occult: ['Occu', 'specOccu'], Politics: ['Poli', 'specPoli'], Science: ['Scie', 'specScie'], Technology: ['Tech', 'specTech'],
};
const PROGENY_TEXT = {
  pcDescription: 'concept', 'Predator type': 'predatorType', Ambition: 'ambition', Clan: 'clan', ClanBane: 'bane', Sire: 'sire', Desire: 'desire',
  BloodSurge: 'bloodSurge', Mend: 'mendAmount', PowBonus: 'powerBonus', ReRouse: 'rouseReroll', FeedPen: 'feedingPenalty', BaneSev: 'baneSeverity',
};

/** The field names every Progeny PDF has (303), which is how one is recognised. */
export function progenyFieldNames() {
  const names = ['Name', 'Title', 'ClanCompulsion', 'Convictions', 'touchstoneNotes', 'tEXP', 'PC_Notes', ...Object.keys(PROGENY_TEXT)];
  for (const p of Object.values(PROGENY_ATTRS)) for (let n = 1; n <= 5; n++) names.push(`${p}-${n}`);
  for (const [p, spec] of Object.values(PROGENY_SKILLS)) {
    names.push(spec);
    for (let n = 1; n <= 5; n++) names.push(`${p}-${n}`);
  }
  for (let b = 1; b <= 6; b++) {
    names.push(`Disc${b}`);
    for (let i = 1; i <= 5; i++) names.push(`Disc${b}_Ability${i}`, `Disc${b}-${i}`);
  }
  for (let i = 1; i <= 10; i++) names.push(`Humanity-${i}`);
  return names;
}

// "Awe: summary // Manipulation + Presence // 1 rouse check"; a ritual adds "// requires: …"
function progenyLine(line) {
  const [head, ...rest] = line.split(' // ');
  const at = head.indexOf(': ');
  const rouse = rest.map((s) => s.match(/^(\d+) rouse checks?$/i)).find(Boolean);
  return {
    name: (at > 0 ? head.slice(0, at) : head).trim(),
    desc: [at > 0 ? head.slice(at + 2).trim() : '', ...rest.filter((s) => /^requires:/i.test(s))].filter(Boolean).join(' · '),
    pool: rest.find((s) => !/^\d+ rouse checks?$/i.test(s) && !/^requires:/i.test(s)) || '',
    rouse: rouse ? Number(rouse[1]) : 0,
  };
}

// ---------- reading ----------

const joinList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
const firstNumber = (s) => { const m = String(s).match(/\d+/); return m ? Number(m[0]) : null; };
const centreIn = (r, box) => { const x = (r[0] + r[2]) / 2, y = (r[1] + r[3]) / 2; return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]; };

// "Heightened Senses", "1 - Heightened Senses", "Heightened Senses (1)": the written level, else the row
function power(raw, row) {
  if (!raw) return null;
  let m = raw.match(/^(?:(?:level|lvl|lv|l)\.?\s*)?([1-5])\s*[:.)\-–—]\s*(.+)$/i);
  if (m) return { name: m[2].trim(), level: Number(m[1]) };
  m = raw.match(/^(.+?)\s*\(\s*(?:(?:level|lvl|lv|l)\.?\s*)?([1-5])\s*\)$/i);
  if (m) return { name: m[1].trim(), level: Number(m[2]) };
  return { name: raw, level: row };
}

function layoutOf(byName) {
  const share = (names) => names.filter((n) => byName.has(n)).length / names.length;
  if (share(officialFieldNames()) >= 0.9) return 'official';
  if (share(progenyFieldNames()) >= 0.9) return 'progeny';
  return null;
}

function attributesFrom(dotsOf, warnings) {
  const attributes = {}, undotted = [];
  for (const a of ATTRIBUTES) {
    attributes[a] = dotsOf(a) || 1;
    if (!dotsOf(a)) undotted.push(cap(a));
  }
  if (undotted.length === ATTRIBUTES.length) warnings.push('No Attribute dots were ticked, so every Attribute starts at 1.');
  else if (undotted.length) warnings.push(`No dots were ticked for ${joinList(undotted)}, so ${undotted.length > 1 ? 'they start' : 'it starts'} at 1, the lowest an Attribute can be.`);
  return attributes;
}

function bloodPotencyFrom(dots, clan, warnings) {
  if (dots || /thin/i.test(clan)) return dots;
  warnings.push('No Blood Potency dots were ticked, so Blood Potency starts at 1.');
  return 1;
}

function readOfficial({ byName, text, ticked, dots }) {
  const warnings = [];
  const attributes = attributesFrom((a) => dots(a), warnings);
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
    generation: generation ?? undefined, bloodPotency: bloodPotencyFrom(dots('potency', 10), text('Clan'), warnings), hunger, humanity, stains,
    attributes, skills, specialties, disciplines, advantages, convictions, touchstones,
    health: damage('health', 'Health'), willpower: damage('will', 'Willpower'),
    xp: { total: firstNumber(text('totalxp')) ?? 0, spent: firstNumber(text('spentxp')) ?? 0 },
    notes: notes.filter(Boolean).join('\n\n'),
  };
  for (const [field, key] of Object.entries(TEXT_FIELDS)) { const v = text(field); if (v) sheet[key] = v; }
  return { name: text('Name'), sheet, warnings };
}

function readProgeny({ byName, text, ticked, dots }, images) {
  const warnings = [];
  const attributes = attributesFrom((a) => dots(`${PROGENY_ATTRS[a]}-`), warnings);
  const skills = {}, specialties = [];
  for (const [skillName, [prefix, spec]] of Object.entries(PROGENY_SKILLS)) {
    skills[skillName] = dots(`${prefix}-`);
    for (const name of text(spec).split(/[,;\n]+/)) if (name.trim()) specialties.push({ skill: skillName, name: name.trim() });
  }

  // A title per block ("Celerity (cont.)" carries on an earlier block) and a line per power,
  // ticked for each power; unticked lines and the "Oblivion Ceremonies" block are rituals
  const discs = new Map(), rituals = [];
  for (let b = 1; b <= 6; b++) {
    const title = text(`Disc${b}`).replace(/\s*\(cont\.\)$/i, '');
    const lines = [];
    for (let i = 1; i <= 5; i++) { const t = text(`Disc${b}_Ability${i}`); if (t) lines.push({ ...progenyLine(t), dot: ticked(`Disc${b}-${i}`) }); }
    if (!title) { if (lines.length) warnings.push(`Discipline block ${b} on the sheet has powers but no name, so it was left out.`); continue; }
    const ceremonies = /ceremon/i.test(title);
    const key = title.toLowerCase();
    if (!ceremonies && !discs.has(key)) discs.set(key, { name: title, rating: 0, powers: [] });
    for (const { dot, ...line } of lines) {
      if (dot && !ceremonies) {
        const d = discs.get(key);
        d.rating++;
        d.powers.push({ ...line, level: Math.min(5, d.powers.length + 1) });
      } else rituals.push({ name: line.name, level: 1, desc: line.desc });
    }
  }

  const advantages = [];
  for (let n = 1; n <= 40; n++) {
    if (!byName.has(`Merit${n}`)) continue;
    const t = text(`Merit${n}`), count = dots(`Merit${n}-`);
    if (!t) { if (count) warnings.push(`Merit or Flaw ${n} on the sheet has dots but no name, so it was left out.`); continue; }
    const at = t.indexOf(': ');
    advantages.push({ name: (at > 0 ? t.slice(0, at) : t).trim(), dots: count, flaw: false, desc: at > 0 ? t.slice(at + 2).trim() : '' });
  }
  if (advantages.length) warnings.push('Progeny’s PDF lists Merits and Flaws together without saying which is which, so all of them came in as Advantages. Mark the Flaws on the sheet.');

  // "Never harm a performer (Mara)" per touchstone, a blank line between; the notes hold "Mara\nher accompanist"
  const descs = new Map();
  for (const block of text('touchstoneNotes').split(/\n\s*\n/)) {
    const [first, ...more] = block.split('\n');
    if (first?.trim()) descs.set(first.trim().toLowerCase(), more.join('\n').trim());
  }
  const convictions = [], touchstones = [];
  for (const block of text('Convictions').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
    const m = block.match(/^([\s\S]*?)\s*\(([^()]*)\)$/);
    const conviction = (m ? m[1] : block).trim(), name = m ? m[2].trim() : '';
    if (conviction) convictions.push(conviction);
    if (name) touchstones.push({ name, conviction, desc: descs.get(name.toLowerCase()) || '' });
  }

  // Progeny stamps a tick picture over each point of Humanity rather than filling the form
  let humanity = 0;
  for (let i = 1; i <= 10; i++) {
    const w = byName.get(`Humanity-${i}`)?.widgets[0];
    if (w && (images.some((im) => (w.page < 0 || im.page === w.page) && centreIn(im.rect, w.rect)) || CHECK.test((w.caption || '').trim()))) humanity++;
  }
  if (!humanity) { humanity = 7; warnings.push('No Humanity boxes were ticked on this sheet, so Humanity starts at 7.'); }
  warnings.push('Progeny’s PDF doesn’t carry Hunger or damage, so Hunger starts at 1 and Health and Willpower are undamaged.');

  const boxes = (prefix) => { let n = 0; for (let i = 1; i <= 20; i++) if (ticked(`${prefix}${i}`)) n = i; return n; };
  const compulsion = text('ClanCompulsion');
  const generationText = text('Title'), generation = firstNumber(generationText);
  if (generationText && generation == null) warnings.push(`Generation “${generationText.slice(0, 20)}” isn’t a number, so it was set to 13.`);
  const sheet = {
    generation: generation ?? undefined, bloodPotency: bloodPotencyFrom(dots('BloodPotency-', 10), text('Clan'), warnings), hunger: 1, humanity, stains: 0,
    attributes, skills, specialties, disciplines: [...discs.values()], rituals, advantages, convictions, touchstones,
    xp: { total: firstNumber(text('tEXP')) ?? 0, spent: 0 },
    notes: [text('PC_Notes'), compulsion ? `Clan compulsion: ${compulsion}` : ''].filter(Boolean).join('\n\n'),
  };
  for (const [field, key] of Object.entries(PROGENY_TEXT)) { const v = text(field); if (v) sheet[key] = v; }
  // the sheet ticks the boxes a character has; more than its Attributes give is a bonus (Fortitude, Merits)
  return { name: text('Name'), sheet, warnings, maxima: { health: boxes('Health-'), willpower: boxes('WP-') } };
}

function reader(byName) {
  const text = (name) => String(byName.get(name)?.value ?? '').replace(/\r\n?/g, '\n').trim();
  const ticked = (name) => {
    const f = byName.get(name);
    return !!f && ((!!f.value && f.value !== 'Off') || f.widgets.some((w) => !!w.state && w.state !== 'Off'));
  };
  const dots = (prefix, max = 5) => { let n = 0; for (let i = 1; i <= max; i++) if (ticked(`${prefix}${i}`)) n = i; return n; };
  return { byName, text, ticked, dots };
}

/** A PDF's bytes -> { name, data, warnings }. Throws an Error that explains, in plain words, when it can't be used. */
export async function characterFromPdf(bytes) {
  const doc = await readPdf(bytes);
  const form = await readForm(doc);
  if (layoutOf(new Map(form.fields.map((f) => [f.name, f]))) === 'progeny') form.images = await pageImages(doc);
  return characterFromForm(form);
}

/** The form fields readForm found (plus `images` from pageImages for Progeny's PDF) -> { name, data, warnings }. */
export function characterFromForm(form) {
  const byName = new Map(form.fields.map((f) => [f.name, f]));
  if (!form.fields.length) {
    throw new Error('This PDF has no fillable fields, so there is nothing to read: it may have been printed, scanned or flattened. Import the copy you typed into, or fill in a blank sheet here.');
  }
  const layout = layoutOf(byName);
  if (!layout) {
    throw new Error('This PDF isn’t a sheet Elysium knows: the official fillable V5 character sheet from Renegade Game Studios, or a PDF from Progeny. Import one of those, a MundusMaker character file or a Progeny save file, or fill in a blank sheet here.');
  }
  const read = reader(byName);
  const marked = (f) => f.widgets.some((w) => (w.caption || '').trim() || DRAWN_BOX.test(w.drawn || ''));
  if (!form.fields.some((f) => (f.type === 'text' ? !!read.text(f.name) : f.type === 'pushbutton' ? marked(f) : read.ticked(f.name)))) {
    throw new Error('This copy of the sheet is still empty. Fill it in, save your changes in your PDF viewer, then import the saved file.');
  }

  const { name, sheet, warnings, maxima } = layout === 'official' ? readOfficial(read) : readProgeny(read, form.images || []);
  const { data, warnings: more } = normalizeSheet(sheet);
  if (maxima) {
    for (const [which, key, base] of [['health', 'healthMaxBonus', data.attributes.stamina + 3], ['willpower', 'willpowerMaxBonus', data.attributes.composure + data.attributes.resolve]]) {
      if (maxima[which] && maxima[which] !== base) data[key] = Math.max(-5, Math.min(10, maxima[which] - base));
    }
  }
  for (const [which, label, max] of [['health', 'Health', healthMax(data)], ['willpower', 'Willpower', willpowerMax(data)]]) {
    const total = data[which].superficial + data[which].aggravated;
    if (total > max) warnings.push(`${label} shows ${total} damage, but this character’s track has only ${max} boxes. If a Discipline or Merit adds boxes, add them on the sheet.`);
  }
  return { name: name.slice(0, 80) || 'Unnamed', data, warnings: [...warnings, ...more] };
}
