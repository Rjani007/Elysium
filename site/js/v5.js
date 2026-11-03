// V5 sheet shape and arithmetic, shared by the sheet, the dice tray and the importers.
// Names and numbers only: no rules text lives in this app. The database
// (supabase/migrations) is the authority on rolls; the helpers here only preview them.

export const ATTR_GROUPS = {
  Physical: ['strength', 'dexterity', 'stamina'],
  Social: ['charisma', 'manipulation', 'composure'],
  Mental: ['intelligence', 'wits', 'resolve'],
};
export const ATTRIBUTES = Object.values(ATTR_GROUPS).flat();

export const SKILL_GROUPS = {
  Physical: ['Athletics', 'Brawl', 'Craft', 'Drive', 'Firearms', 'Larceny', 'Melee', 'Stealth', 'Survival'],
  Social: ['Animal Ken', 'Etiquette', 'Insight', 'Intimidation', 'Leadership', 'Performance', 'Persuasion', 'Streetwise', 'Subterfuge'],
  Mental: ['Academics', 'Awareness', 'Finance', 'Investigation', 'Medicine', 'Occult', 'Politics', 'Science', 'Technology'],
};
export const SKILLS = Object.values(SKILL_GROUPS).flat();

export const CLANS = ['Banu Haqim', 'Brujah', 'Gangrel', 'Hecata', 'Lasombra', 'Malkavian', 'The Ministry',
  'Nosferatu', 'Ravnos', 'Salubri', 'Toreador', 'Tremere', 'Tzimisce', 'Ventrue', 'Caitiff', 'Thin-blood'];

export const DISCIPLINES = ['Animalism', 'Auspex', 'Blood Sorcery', 'Celerity', 'Dominate', 'Fortitude',
  'Obfuscate', 'Oblivion', 'Potence', 'Presence', 'Protean', 'Thin-Blood Alchemy'];

// Top-level keys the database accepts (public.v5_value); anything else is dropped on save.
export const TEXT_KEYS = ['clan', 'predatorType', 'sire', 'ambition', 'desire', 'concept', 'chronicle', 'sect',
  'resonance', 'tenets', 'bane', 'bloodSurge', 'mendAmount', 'powerBonus', 'rouseReroll', 'feedingPenalty',
  'baneSeverity', 'trueAge', 'apparentAge', 'dateOfBirth', 'dateOfDeath', 'appearance', 'features', 'history', 'notes'];
export const LIST_KEYS = ['specialties', 'disciplines', 'rituals', 'advantages', 'convictions', 'touchstones'];

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

/** A fresh sheet, the same defaults MundusMaker's V5 sheet starts from. */
export function blankSheet() {
  return {
    clan: '', generation: 13, bloodPotency: 1, predatorType: '', sire: '', ambition: '', desire: '', concept: '',
    attributes: Object.fromEntries(ATTRIBUTES.map((a) => [a, 1])),
    skills: Object.fromEntries(SKILLS.map((s) => [s, 0])),
    specialties: [], disciplines: [], advantages: [], convictions: [], touchstones: [],
    hunger: 1, humanity: 7, stains: 0,
    health: { superficial: 0, aggravated: 0 },
    willpower: { superficial: 0, aggravated: 0 },
    xp: { total: 0, spent: 0, ledger: [] },
    notes: '',
  };
}

/** An integer from anything a sheet might hold ("3", 3, "3.0"), clamped; dflt otherwise. */
export function int(v, lo, hi, dflt) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d{1,6}(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt;
}

export const attr = (d, key) => int(d?.attributes?.[key], 0, 5, 1);
export const skill = (d, name) => int(d?.skills?.[name], 0, 5, 0);
export const hunger = (d) => int(d?.hunger, 0, 5, 1);
export const humanity = (d) => int(d?.humanity, 0, 10, 7);
export const stains = (d) => int(d?.stains, 0, 10, 0);
export const bloodPotency = (d) => int(d?.bloodPotency, 0, 10, 1);

export function healthMax(d) {
  return Math.max(1, attr(d, 'stamina') + 3 + int(d?.healthMaxBonus, -5, 10, 0));
}
export function willpowerMax(d) {
  return Math.max(1, attr(d, 'composure') + attr(d, 'resolve') + int(d?.willpowerMaxBonus, -5, 10, 0));
}
export function track(d, which) {
  const t = d?.[which] || {};
  return { superficial: int(t.superficial, 0, 15, 0), aggravated: int(t.aggravated, 0, 15, 0) };
}
/** Undamaged boxes: what a Willpower roll rolls. */
export function willpowerLeft(d) {
  const t = track(d, 'willpower');
  return Math.max(0, willpowerMax(d) - t.superficial - t.aggravated);
}

/** Blood Surge dice: the number written on the sheet, else half the Blood Potency rounded up. */
export function surgeDice(d) {
  const written = String(d?.bloodSurge ?? '').match(/\d+/);
  if (written && Number(written[0]) > 0) return Math.min(10, Number(written[0]));
  return Math.ceil(bloodPotency(d) / 2);
}

export function disciplineRating(d, name) {
  const disc = (Array.isArray(d?.disciplines) ? d.disciplines : [])
    .find((x) => String(x?.name || '').trim().toLowerCase() === String(name).trim().toLowerCase());
  return disc ? int(disc.rating, 0, 5, 0) : 0;
}

/** Trait keys as the database's roll_pool reads them. */
export const traitKey = {
  attr: (key) => `attr:${key}`,
  skill: (name) => `skill:${name}`,
  disc: (name) => `disc:${name}`,
};

export function traitInfo(d, key) {
  const [kind, ...rest] = key.split(':');
  const name = rest.join(':');
  if (kind === 'attr') return { name: cap(name), value: attr(d, name), kind };
  if (kind === 'skill') return { name, value: skill(d, name), kind };
  return { name, value: disciplineRating(d, name), kind: 'disc' };
}

/** What the tray will roll; the server recomputes all of it from the sheet. */
export function poolPreview(d, { traits = [], modifier = 0, specialty = '', surge = false, freePool = null } = {}) {
  let total = freePool != null ? Math.max(0, Math.min(30, freePool | 0))
    : traits.reduce((sum, key) => sum + traitInfo(d, key).value, 0);
  total += Math.max(-10, Math.min(10, modifier | 0));
  if (specialty) total += 1;
  if (surge) total += surgeDice(d);
  const pool = Math.max(1, Math.min(30, total));
  const h = d ? Math.min(hunger(d), pool) : 0;
  return { pool, hunger: h };
}

export function specialtiesFor(d, skillName) {
  return (Array.isArray(d?.specialties) ? d.specialties : [])
    .filter((s) => String(s?.skill || '').toLowerCase() === skillName.toLowerCase() && s?.name)
    .map((s) => String(s.name));
}

export const OUTCOMES = {
  critical_win: { text: 'Critical win', tone: 'gold' },
  critical: { text: 'Critical', tone: 'gold' },
  messy_critical: { text: 'Messy critical', tone: 'blood' },
  win: { text: 'Win', tone: 'ok' },
  successes: { text: '', tone: 'plain' },
  failure: { text: 'Failure', tone: 'dim' },
  total_failure: { text: 'Total failure', tone: 'dim' },
  bestial_failure: { text: 'Bestial failure', tone: 'blood' },
  rouse_ok: { text: 'No Hunger gained', tone: 'ok' },
  rouse_fail: { text: 'Hunger rises', tone: 'blood' },
  remorse_ok: { text: 'Humanity holds', tone: 'ok' },
  remorse_fail: { text: 'Humanity lost', tone: 'blood' },
};

/** Pulls the 11-character video id out of any common YouTube link (or a bare id). */
export function youtubeId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let url;
  try { url = new URL(s); } catch { return null; }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    if (!id && m) id = m[1];
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
