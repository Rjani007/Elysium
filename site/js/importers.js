// Character files in and out. Pure functions (no DOM, no network), so tests run them in Node.
//
// Accepted:
//   * MundusMaker's character file: { format: 'mundusmaker.character', version: 1, system: 'vtm5', name, data, portrait? }
//   * a MundusMaker entry file (data/worlds/<world>/entities/<id>.json) holding a V5 sheet block
//   * Progeny's save file, its "Save File" button (https://progeny.odin-matthias.com), schema versions 1-11
//   * a filled-in official V5 character sheet or Progeny's "Download PDF", read by officialsheet.js,
//     and MundusMaker's own V5 sheet PDF, read by drawnsheet.js
// Written:
//   * the same MundusMaker character file, so a sheet can go back into MundusMaker.

import {
  ATTRIBUTES, SKILLS, DISCIPLINES, CLANS, TEXT_KEYS, LIST_KEYS, blankSheet, int, cap,
  attr, skill, hunger, humanity, bloodPotency, willpowerMax, specialtiesFor,
} from './v5.js';

export const EXCHANGE_FORMAT = 'mundusmaker.character';

const lower = (s) => String(s ?? '').trim().toLowerCase();
const text = (v, max = 20000) => (v == null ? '' : String(v)).slice(0, max);
const SKILL_BY_LOWER = Object.fromEntries(SKILLS.map((s) => [s.toLowerCase(), s]));
const DISC_BY_LOWER = Object.fromEntries(DISCIPLINES.map((s) => [s.toLowerCase(), s]));
const CLAN_BY_LOWER = { ...Object.fromEntries(CLANS.map((s) => [s.toLowerCase(), s])), ministry: 'The Ministry', 'thin-blooded': 'Thin-blood' };

export const canonSkill = (name) => SKILL_BY_LOWER[lower(name)] || null;
export const canonDiscipline = (name) => DISC_BY_LOWER[lower(name)] || cap(String(name ?? '').trim());
export const canonClan = (name) => CLAN_BY_LOWER[lower(name)] || String(name ?? '').trim();

/** Which kind of file this is, or null. */
export function detectFormat(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.format === EXCHANGE_FORMAT) return 'mundusmaker';
  if (Array.isArray(obj.blocks) && obj.blocks.some((b) => b?.kind === 'sheet')) return 'mundusmaker-entry';
  if (obj.ephemeral && typeof obj.ephemeral === 'object' && obj.attributes && obj.skills) return 'progeny';
  if (obj.attributes && obj.skills && !obj.ephemeral) return 'sheet';
  return null;
}

/**
 * Turns a parsed file into { name, data, source, portrait, warnings }.
 * Throws an Error with a plain explanation when the file can't be used.
 */
export function importCharacter(obj) {
  const kind = detectFormat(obj);
  if (kind === 'mundusmaker') {
    if (obj.system !== 'vtm5') {
      throw new Error(`This MundusMaker character uses ${obj.system ? `the "${obj.system}" sheet` : 'an unknown sheet'}; only Vampire: The Masquerade 5e sheets can be played here.`);
    }
    if (Number(obj.version) > 1) throw new Error('This character file comes from a newer MundusMaker. Update this site or export it again from an older MundusMaker.');
    const portrait = typeof obj.portrait === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(obj.portrait) ? obj.portrait : null;
    return { ...normalizeSheet(obj.data), name: text(obj.name, 80).trim() || 'Unnamed', source: 'mundusmaker', portrait };
  }
  if (kind === 'mundusmaker-entry') {
    const block = obj.blocks.find((b) => b?.kind === 'sheet' && b.system === 'vtm5');
    if (!block) throw new Error('This MundusMaker entry has no Vampire: The Masquerade 5e sheet.');
    return { ...normalizeSheet(block.data), name: text(obj.name, 80).trim() || 'Unnamed', source: 'mundusmaker', portrait: null };
  }
  if (kind === 'progeny') return { ...fromProgeny(obj), source: 'progeny', portrait: null };
  if (kind === 'sheet') return { ...normalizeSheet(obj), name: text(obj.name, 80).trim() || 'Unnamed', source: 'manual', portrait: null };
  throw new Error("This doesn't look like a character file. Use a MundusMaker character file (⇩ Character file on a V5 sheet) or sheet PDF, a Progeny save file or PDF, or a filled-in official V5 character sheet (PDF).");
}

/** A picked file's bytes, a character file (JSON) or a character sheet PDF -> what importCharacter returns. */
export async function importCharacterFile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (String.fromCharCode(...bytes.subarray(0, 1024)).includes('%PDF-')) {
    const { characterFromPdf } = await import('./officialsheet.js');
    return { ...(await characterFromPdf(bytes)), source: 'pdf', portrait: null };
  }
  let obj;
  try { obj = JSON.parse(new TextDecoder().decode(bytes)); } catch {
    throw new Error("That file isn't a character file or a character sheet PDF.");
  }
  return importCharacter(obj);
}

// The Attribute each Skill's quick pool uses when an NPC is made from a full sheet: a usual
// pairing, which the storyteller can change in the NPC editor before saving
const POOL_ATTRIBUTE = {
  Athletics: 'dexterity', Brawl: 'strength', Craft: 'dexterity', Drive: 'dexterity', Firearms: 'dexterity', Larceny: 'dexterity', Melee: 'strength', Stealth: 'dexterity', Survival: 'wits',
  'Animal Ken': 'charisma', Etiquette: 'charisma', Insight: 'wits', Intimidation: 'charisma', Leadership: 'charisma', Performance: 'charisma', Persuasion: 'charisma', Streetwise: 'charisma', Subterfuge: 'manipulation',
  Academics: 'intelligence', Awareness: 'wits', Finance: 'intelligence', Investigation: 'intelligence', Medicine: 'intelligence', Occult: 'intelligence', Politics: 'intelligence', Science: 'intelligence', Technology: 'intelligence',
};

/**
 * A character sheet -> what the NPC editor holds: the card players see once it is revealed
 * (name, role, clan, description), Hunger, quick pools worked out from the sheet, and the rest
 * of the sheet summed up in the storyteller-only notes.
 */
export function npcFromCharacter(name, d) {
  const trained = SKILLS.filter((s) => skill(d, s) > 0);
  const pools = trained.map((s) => ({ label: `${cap(POOL_ATTRIBUTE[s])} + ${s}`, dice: attr(d, POOL_ATTRIBUTE[s]) + skill(d, s) }))
    .sort((a, b) => b.dice - a.dice).slice(0, 12);
  pools.push({ label: 'Willpower', dice: willpowerMax(d) });
  const adv = list(d.advantages);
  const traits = (flaws) => adv.filter((a) => !!a.flaw === flaws).map((a) => `${a.name} ${int(a.dots, 0, 5, 0)}`).join(', ');
  const notes = [
    [d.generation ? `Generation ${d.generation}` : '', `Blood Potency ${bloodPotency(d)}`, `Humanity ${humanity(d)}`, d.predatorType ? `Predator type: ${d.predatorType}` : ''].filter(Boolean).join(' · '),
    `Attributes: ${ATTRIBUTES.map((a) => `${cap(a)} ${attr(d, a)}`).join(', ')}`,
    `Skills: ${trained.map((s) => { const sp = specialtiesFor(d, s); return `${s} ${skill(d, s)}${sp.length ? ` (${sp.join(', ')})` : ''}`; }).join(', ') || 'none'}`,
    list(d.disciplines).length ? `Disciplines: ${list(d.disciplines).map((x) => `${x.name} ${int(x.rating, 0, 5, 0)}${list(x.powers).length ? ` (${list(x.powers).map((p) => p.name).join(', ')})` : ''}`).join('; ')}` : '',
    list(d.rituals).length ? `Rituals: ${list(d.rituals).map((r) => r.name).join(', ')}` : '',
    traits(false) ? `Advantages: ${traits(false)}` : '', traits(true) ? `Flaws: ${traits(true)}` : '',
    list(d.touchstones).length ? `Touchstones: ${list(d.touchstones).map((t) => (t.conviction ? `${t.name} (${t.conviction})` : t.name)).join('; ')}` : '',
    [d.ambition ? `Ambition: ${d.ambition}` : '', d.desire ? `Desire: ${d.desire}` : '', d.sire ? `Sire: ${d.sire}` : ''].filter(Boolean).join(' · '),
    d.history || '', d.notes || '',
  ].filter(Boolean).join('\n');
  return {
    name, title: d.concept || '', clan: d.clan || '',
    description: [d.appearance, d.features].filter(Boolean).join('\n\n'),
    hunger: hunger(d), pools, notes,
  };
}

/** Where a character came from, for "Imported from …". */
export const SOURCE_LABEL = { mundusmaker: 'MundusMaker', progeny: 'Progeny', pdf: 'a character sheet PDF', manual: 'a blank sheet' };

/**
 * Cleans a V5 sheet into the shape the database stores (MundusMaker's vtm5 data):
 * canonical attribute/skill/discipline names, numbers clamped, unknown keys dropped.
 */
export function normalizeSheet(input) {
  const src = input && typeof input === 'object' ? input : {};
  const d = blankSheet();
  const warnings = [];

  for (const k of TEXT_KEYS) if (src[k] != null && typeof src[k] !== 'object') d[k] = text(src[k]);
  if (d.clan) d.clan = canonClan(d.clan);
  d.generation = int(src.generation, 1, 16, 13);
  d.bloodPotency = int(src.bloodPotency, 0, 10, 1);
  d.hunger = int(src.hunger, 0, 5, 1);
  d.humanity = int(src.humanity, 0, 10, 7);
  d.stains = int(src.stains, 0, 10, 0);
  for (const k of ['healthMaxBonus', 'willpowerMaxBonus']) {
    const v = int(src[k], -5, 10, 0);
    if (v) d[k] = v;
  }

  for (const [k, v] of Object.entries(src.attributes || {})) {
    const key = lower(k);
    if (ATTRIBUTES.includes(key)) d.attributes[key] = int(v, 1, 5, 1);
    else warnings.push(`Skipped unknown attribute "${k}".`);
  }
  for (const [k, v] of Object.entries(src.skills || {})) {
    const name = canonSkill(k);
    if (name) d.skills[name] = int(v, 0, 5, 0);
    else warnings.push(`Skipped unknown skill "${k}".`);
  }
  for (const which of ['health', 'willpower']) {
    const t = src[which] || {};
    d[which] = { superficial: int(t.superficial, 0, 15, 0), aggravated: int(t.aggravated, 0, 15, 0) };
  }
  const xp = src.xp || {};
  d.xp = { total: int(xp.total, 0, 100000, 0), spent: int(xp.spent, 0, 100000, 0), ledger: Array.isArray(xp.ledger) ? xp.ledger.slice(-100) : [] };

  d.specialties = list(src.specialties).map((s) => ({ skill: canonSkill(s?.skill) || text(s?.skill, 40), name: text(s?.name, 80) }))
    .filter((s) => s.name);
  d.disciplines = list(src.disciplines).map((x) => ({
    name: canonDiscipline(x?.name), rating: int(x?.rating, 0, 5, 0),
    powers: list(x?.powers).map((p) => cleanPower(p)).filter((p) => p.name),
  })).filter((x) => x.name);
  d.rituals = list(src.rituals).map((r) => ({ name: text(r?.name, 120), level: int(r?.level, 1, 5, 1), desc: text(r?.desc, 4000) }))
    .filter((r) => r.name);
  if (!d.rituals.length) delete d.rituals;
  d.advantages = list(src.advantages).map((a) => ({ name: text(a?.name, 120), dots: int(a?.dots, 0, 5, 0), flaw: !!a?.flaw, desc: text(a?.desc, 2000) }))
    .filter((a) => a.name);
  d.convictions = list(src.convictions).map((c) => text(c, 400)).filter(Boolean);
  d.touchstones = list(src.touchstones).map((t) => ({ name: text(t?.name, 120), conviction: text(t?.conviction, 400), desc: text(t?.desc, 2000) }))
    .filter((t) => t.name);
  return { data: d, warnings };
}

function list(v) {
  return Array.isArray(v) ? v.slice(0, 200) : [];
}

function cleanPower(p) {
  const out = { name: text(p?.name, 120), level: int(p?.level, 1, 5, 1), desc: text(p?.desc, 4000) };
  if (/^https?:\/\//i.test(p?.wikiUrl || '')) out.wikiUrl = text(p.wikiUrl, 400);
  if (p?.pool) out.pool = text(p.pool, 120);
  if (p?.rouse != null) out.rouse = int(p.rouse, 0, 5, 0);
  return out;
}

/** Progeny's save file -> a V5 sheet. Progeny lists powers flat and keeps damage in `ephemeral`. */
export function fromProgeny(p) {
  const warnings = [];
  const eph = p.ephemeral || {};
  const sheet = {
    clan: p.clan,
    sire: p.sire,
    concept: p.description,
    chronicle: p.chronicle,
    sect: p.sect,
    ambition: p.ambition,
    desire: p.desire,
    predatorType: p.predatorType?.name,
    generation: p.generation,
    bloodPotency: p.bloodPotency,
    humanity: p.humanity,
    hunger: eph.hunger,
    stains: eph.humanityStains,
    attributes: p.attributes,
    skills: p.skills,
    health: { superficial: eph.superficialDamage, aggravated: eph.aggravatedDamage },
    willpower: { superficial: eph.superficialWillpowerDamage, aggravated: eph.aggravatedWillpowerDamage },
    xp: { total: p.experience, spent: eph.experienceSpent },
    notes: p.notes,
  };
  if (p.clanBane === 'variant') warnings.push('Progeny marked a variant clan bane; note it on the sheet.');

  // Specialties: chosen ones plus the predator type's, without duplicates
  const seen = new Set();
  sheet.specialties = [...list(p.skillSpecialties), ...list(p.predatorType?.pickedSpecialties)]
    .map((s) => ({ skill: canonSkill(s?.skill) || cap(String(s?.skill || '')), name: String(s?.name || '').trim() }))
    .filter((s) => s.name && !seen.has(`${s.skill}|${s.name}`.toLowerCase()) && seen.add(`${s.skill}|${s.name}`.toLowerCase()));

  // Disciplines: levels from disciplineLevels when present (schema 4+), else one dot per power
  const levels = p.disciplineLevels && typeof p.disciplineLevels === 'object' ? p.disciplineLevels : {};
  const byName = new Map();
  const disc = (name) => {
    const key = lower(name);
    if (!byName.has(key)) byName.set(key, { name: canonDiscipline(name), rating: 0, powers: [] });
    return byName.get(key);
  };
  for (const [name, level] of Object.entries(levels)) if (name && Number(level) > 0) disc(name).rating = int(level, 0, 5, 0);
  for (const power of list(p.disciplines)) {
    if (!power?.discipline || !power?.name) continue;
    const d = disc(power.discipline);
    d.powers.push({
      name: power.name, level: power.level, desc: power.summary || '',
      pool: power.dicePool && power.dicePool !== '-' ? power.dicePool : '',
      rouse: power.rouseChecks,
    });
  }
  for (const d of byName.values()) {
    if (!(lower(d.name) in levels) && ![...Object.keys(levels)].some((k) => lower(k) === lower(d.name))) {
      d.rating = Math.min(5, Math.max(d.rating, d.powers.length));
    }
  }
  sheet.disciplines = [...byName.values()];
  sheet.rituals = [...list(p.rituals), ...list(p.ceremonies)].map((r) => ({ name: r?.name, level: r?.level, desc: r?.summary || '' }));

  // Merits and flaws, including the predator type's picks
  const advSeen = new Set();
  sheet.advantages = [...list(p.merits), ...list(p.flaws), ...list(p.predatorType?.pickedMeritsAndFlaws)]
    .map((m) => ({ name: m?.name, dots: m?.level, flaw: m?.type === 'flaw', desc: m?.summary || '' }))
    .filter((m) => m.name && !advSeen.has(`${m.flaw}|${lower(m.name)}`) && advSeen.add(`${m.flaw}|${lower(m.name)}`));

  // Touchstones carry their convictions in Progeny; MundusMaker pairs them by position
  const touch = list(p.touchstones);
  sheet.convictions = touch.map((t) => t?.conviction).filter(Boolean);
  sheet.touchstones = touch.map((t) => ({ name: t?.name, conviction: t?.conviction || '', desc: t?.description || '' }));

  // Progeny stores the maximums; anything above the attribute-based value (Fortitude, merits) is a bonus
  const base = normalizeSheet(sheet);
  const hp = Number(p.maxHealth), wp = Number(p.willpower);
  const hpBase = base.data.attributes.stamina + 3;
  const wpBase = base.data.attributes.composure + base.data.attributes.resolve;
  if (Number.isFinite(hp) && hp > 0 && hp !== hpBase) base.data.healthMaxBonus = Math.max(-5, Math.min(10, hp - hpBase));
  if (Number.isFinite(wp) && wp > 0 && wp !== wpBase) base.data.willpowerMaxBonus = Math.max(-5, Math.min(10, wp - wpBase));

  return { name: text(p.name, 80).trim() || 'Unnamed', data: base.data, warnings: [...warnings, ...base.warnings] };
}

/** The MundusMaker character file for a character row. */
export function exportCharacter(character, { portrait = null, app = 'Elysium' } = {}) {
  const out = {
    format: EXCHANGE_FORMAT,
    version: 1,
    exported: new Date().toISOString(),
    app,
    name: character.name,
    system: 'vtm5',
    data: character.data,
  };
  if (portrait) out.portrait = portrait;
  return out;
}

export function exportFileName(name) {
  const base = String(name || 'character').normalize('NFKD').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return `${base || 'character'}.character.json`;
}
