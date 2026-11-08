// MundusMaker's own V5 sheet PDF -> a sheet. MundusMaker draws that PDF (its "familiar layout",
// the PDF button on a V5 sheet) instead of filling in a form: every label and value is text and
// every dot and box a shape, placed where public/js/sheets/familiar.js puts its V5 sections on a
// 100 x 129 page, which jsPDF scales to fit A4 or US Letter and centres. This reads them back from
// those positions, so if familiar.js moves a V5 section, change the positions here too. Pure (no
// DOM); pdfform.js's pageDrawing() reads the PDF.

import { ATTR_GROUPS, SKILL_GROUPS } from './v5.js';
import { normalizeSheet } from './importers.js';

const PAGE = [100, 129];
const COLS = [9.7, 36.57, 63.43, 90.3]; // page 1's three columns
const SKILL_X = [[9.7, 27.7], [36.8, 54.9], [64.2, 82.2]]; // label and dots, per column
const TRIO = [9.7, 36.8, 63.8, 90.3]; // page 2's tenets, touchstones and bane
const DOT = { r: 0.6, step: 1.58, gap: 0.7 };
const BOX = { size: 1.25, pitch: 1.67, gap: 1.67 };
const LINE = 1.85; // text boxes' line pitch at size 1.2
const MORE = '(continued on a later page)';
const CLIPPED = /…$/;

// Times-Roman widths (1/1000 em) as jsPDF measures them, for telling a line the writer ended from
// one MundusMaker wrapped. jsPDF also kerns, which only tightens a line, so the check leaves room.
const TIMES = [250, 330, 410, 500, 500, 830, 780, 180, 330, 330, 500, 560, 250, 330, 250, 280, 500, 500, 500, 500, 500, 500, 500, 500,
  500, 500, 280, 280, 560, 560, 560, 440, 920, 720, 660, 660, 720, 610, 550, 720, 720, 330, 390, 720, 610, 890, 720, 720, 550, 720, 660, 550,
  610, 720, 720, 940, 720, 720, 610, 330, 280, 330, 470, 500, 330, 440, 500, 440, 500, 440, 330, 500, 500, 280, 280, 500, 280, 780, 500, 500,
  500, 500, 330, 390, 280, 500, 500, 720, 500, 500, 440, 480, 200, 480, 540];
const TIMES_MORE = { '…': 1000, '—': 1000, '–': 500, '•': 350, '’': 330, '‘': 330, '“': 440, '”': 440, '·': 250 };
const textWidth = (s, size) => [...s].reduce((n, c) => { const k = c.charCodeAt(0); return n + (k >= 32 && k <= 126 ? TIMES[k - 32] : TIMES_MORE[c] ?? 500); }, 0) / 1000 * size;

// Discipline powers' levels, from MundusMaker's public/systems/vtm5.json (names and numbers only):
// the sheet shows a power's level only in the continued details, which list a discipline's
// powers only when one of them has a description
const POWER_LEVELS = new Map(Object.entries({
  1: "Bond Famulus|Sense the Beast|Heightened Senses|Sense the Unseen|Corrosive Vitae|A Taste for Blood|Cat's Grace|Rapid Reflexes|Cloud Memory|Compel|Resilience|Unswayable Mind|Cloak of Shadows|Silence of Death|Shadow Cloak|Oblivion's Sight|Lethal Body|Soaring Leap|Awe|Daunt|Eyes of the Beast|Weight of the Feather|Far Reach|Haze",
  2: 'Feral Whispers|Premonition|Extinguish Vitae|Fleetness|Mesmerize|Dementation|Toughness|Enduring Beasts|Unseen Passage|Shadow Cast|Where the Shroud Thins|Prowess|Lingering Kiss|Feral Weapons|Envelop',
  3: "Animal Succulence|Quell the Beast|Unliving Hive|Scry the Soul|Share the Senses|Blood of Potency|Scorpion's Touch|Blink|Traversal|The Forgetful Mind|Submerged Directive|Defy Bane|Fortify the Inner Facade|Ghost in the Machine|Mask of a Thousand Faces|Aura of Decay|Shadow Perspective|Touch of Oblivion|Brutal Feed|Spark of Rage|Uncanny Grip|Dread Gaze|Entrancement|Earth Meld|Shapechange|Defractionate|Profane Hieros Gamos",
  4: "Subsume the Spirit|Spirit's Touch|Theft of Vitae|Draught of Elegance|Unerring Aim|Rationalize|Draught of Endurance|Conceal|Vanish|Necrotic Plague|Stygian Shroud|Draught of Might|Irresistible Voice|Summon|Metamorphosis|Airborne Momentum",
  5: "Animal Dominion|Drawing Out the Beast|Clairvoyance|Possession|Telepathy|Baal's Caress|Cauldron of Blood|Lightning Strike|Split Second|Mass Manipulation|Terminal Decree|Flesh of Marble|Prowess from Pain|Cloak the Gathering|Impostor's Guise|Shadow Step|Skuld Fulfilled|Earthshock|Fist of Caine|Majesty|Star Magnetism|Mist Form|The Unfettered Heart|Awaken the Sleeper",
}).flatMap(([level, names]) => names.split('|').map((n) => [n.toLowerCase(), Number(level)])));
const levelOf = (power) => POWER_LEVELS.get(power.replace(/[’‘]/g, "'").toLowerCase());

// ink: a ticked dot or a filled box; paper: an empty one; off: a box past a track's maximum
const tone = (rgb) => {
  if (!rgb) return null;
  const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  return l < 0.5 ? 'ink' : l < 0.9 ? 'off' : 'paper';
};

/** A page from pageDrawing() in the layout's own units: x right and y down from the top-left corner. */
function inModel(page) {
  const u = Math.min(page.width / PAGE[0], page.height / PAGE[1]), ox = (page.width - PAGE[0] * u) / 2, oy = (page.height - PAGE[1] * u) / 2;
  const X = (x) => (x - ox) / u, Y = (y) => (page.height - y - oy) / u;
  return {
    texts: page.texts.map((t) => ({ x: X(t.x), y: Y(t.y), size: t.size / u, bold: /bold/i.test(t.font), text: t.text })),
    circles: page.circles.map((c) => ({ x: X(c.x), y: Y(c.y), tone: tone(c.fill) })),
    rects: page.rects.map((r) => ({ x: X(r.x0), y: Y(r.y1), w: (r.x1 - r.x0) / u, h: (r.y1 - r.y0) / u, tone: tone(r.fill) })),
    lines: page.lines.map((l) => ({ x: (X(l.x1) + X(l.x2)) / 2, y: (Y(l.y1) + Y(l.y2)) / 2, len: Math.hypot(l.x2 - l.x1, l.y2 - l.y1) / u })),
  };
}

const near = (a, b, tol = 0.3) => Math.abs(a - b) <= tol;
/** The text runs on the line at `base` between x0 and x1, left to right. */
const runsAt = (pg, x0, x1, base, tol = 0.35) => pg.texts.filter((t) => t.x >= x0 && t.x < x1 && near(t.y, base, tol)).sort((a, b) => a.x - b.x);
const textAt = (pg, x0, x1, base, tol) => runsAt(pg, x0, x1, base, tol).map((t) => t.text).join(' ').trim();

/** Ticked dots in a row drawn from x on the line at base: { value, found }. */
function dotsAt(pg, x, base, max) {
  let value = 0, found = 0;
  for (let i = 0; i < max; i++) {
    const cx = x + DOT.r + i * DOT.step + Math.floor(i / 5) * DOT.gap;
    const c = pg.circles.find((d) => near(d.x, cx) && near(d.y, base - 0.45));
    if (c) { found++; if (c.tone === 'ink') value++; }
  }
  return { value, found };
}

/** The boxes of a row drawn from x, or null when one is missing: [{ tone, marks }], marks being its damage strokes. */
function boxesAt(pg, x, top, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const bx = x + i * BOX.pitch + Math.floor(i / 5) * BOX.gap;
    const r = pg.rects.find((q) => near(q.x, bx, 0.2) && near(q.y, top, 0.2) && near(q.w, BOX.size, 0.2));
    if (!r) return null;
    out.push({ tone: r.tone, marks: pg.lines.filter((l) => l.len > 0.5 && near(l.x, bx + BOX.size / 2, 0.4) && near(l.y, top + BOX.size / 2, 0.4)).length });
  }
  return out;
}
const boxesWidth = (count) => (count - 1) * BOX.pitch + BOX.size + Math.floor((count - 1) / 5) * BOX.gap;

/** Health or Willpower: a row of at least ten boxes centred on `at`, those past the maximum greyed out. */
function trackAt(pg, at, top) {
  for (let count = 20; count >= 10; count--) {
    const boxes = boxesAt(pg, at - boxesWidth(count) / 2, top, count);
    if (!boxes) continue;
    return {
      max: boxes.filter((b) => b.tone !== 'off').length,
      superficial: boxes.filter((b) => b.marks === 1).length,
      aggravated: boxes.filter((b) => b.marks >= 2).length,
    };
  }
  return null;
}

/**
 * Lines of one text area as the writer typed them: MundusMaker wraps a paragraph only when the
 * next word doesn't fit, so a break where it would have fitted is the writer's own. A skipped
 * row is a blank line. `starts(line, sofar)` says whether a line begins a new paragraph anyway.
 */
function joinLines(lines, width, size, pitch, starts = () => false) {
  let out = '';
  lines.forEach((ln, i) => {
    if (!i) { out = ln.text; return; }
    const prev = lines[i - 1];
    const blank = prev.page === ln.page ? Math.max(0, Math.round((ln.y - prev.y) / pitch) - 1) : 0;
    if (blank) { out += '\n'.repeat(blank + 1) + ln.text; return; }
    const word = ln.text.split(/\s+/)[0];
    const own = textWidth(`${prev.text} ${word}`, size) <= width * 0.97 || starts(ln.text, out.slice(out.lastIndexOf('\n') + 1));
    out += (own ? '\n' : ' ') + ln.text;
  });
  return out;
}
// Touchstones & Convictions holds "conviction — touchstone" per line: a second dash means a new line
const PAIR = /\s—\s/;
const newPair = (line, sofar) => PAIR.test(line) && PAIR.test(sofar);
const TOUCH_TITLE = 'Touchstones & convictions';

/** A text area's lines from `first` (the first baseline) down to `bottom`, between x0 and x1. */
function areaLines(pg, x0, x1, first, bottom) {
  return pg.texts.filter((t) => t.x >= x0 && t.x < x1 && t.y >= first - 0.4 && t.y <= bottom && !t.bold)
    .sort((a, b) => a.y - b.y).map((t) => ({ text: t.text, y: t.y, page: 0 }));
}

/** The continued-details pages: [{ title, text }] in order. */
function readContinuations(pages) {
  const entries = [];
  let cur = null, lastHead = null;
  pages.forEach((pg, n) => {
    for (const t of [...pg.texts].sort((a, b) => a.y - b.y || a.x - b.x)) {
      if (t.y < 3 || t.y > PAGE[1] - 2 || near(t.y, 6, 0.5)) continue; // the banner, the footer and the page's title
      if (t.bold && / · continued$/.test(t.text)) { lastHead = null; continue; } // an entry carried onto a new page
      if (t.bold && near(t.size, 1.5, 0.15)) {
        if (cur && !cur.lines.length && lastHead && lastHead.page === n && t.y - lastHead.y < 2.5) cur.title += ` ${t.text}`;
        else { cur = { title: t.text, lines: [] }; entries.push(cur); }
        lastHead = { y: t.y, page: n };
        continue;
      }
      if (cur && !t.bold && near(t.size, 1.3, 0.12)) cur.lines.push({ text: t.text, y: t.y, page: n });
    }
  });
  return entries.map((e) => ({ title: e.title, text: joinLines(e.lines, 94, 1.3, 1.75, e.title === TOUCH_TITLE ? newPair : undefined) }));
}

const firstNumber = (s) => { const m = String(s).match(/\d+/); return m ? Number(m[0]) : null; };

/** Whether pageDrawing() found MundusMaker's familiar-layout sheet, and of which game. */
function bannerOf(page) {
  if (!page.texts.some((t) => / · familiar layout$/.test(t.text))) return null;
  for (const [label, system] of [['VAMPIRE: THE MASQUERADE V5', 'vtm5'], ['D&D 2024', 'dnd2024'], ['CALL OF CTHULHU 7TH EDITION', 'coc7']]) {
    if (page.texts.some((t) => t.text === label)) return system;
  }
  return null;
}

/**
 * pageDrawing()'s pages -> { name, data, warnings } for MundusMaker's V5 sheet PDF, or null when
 * the PDF isn't one. Throws a plain Error for MundusMaker's sheets of other games.
 */
export function characterFromDrawing(drawing) {
  const system = drawing.length >= 2 ? bannerOf(drawing[0]) : null;
  if (!system) {
    if (drawing.some((p) => p.texts.some((t) => t.text === 'MundusMaker · character sheet'))) {
      throw new Error('This MundusMaker sheet PDF uses the Standard layout, which can’t be read back. In MundusMaker, switch the sheet to Familiar layout and press Player sheet PDF again, or use ⇩ Character file.');
    }
    return null;
  }
  if (system !== 'vtm5') throw new Error(`This is a MundusMaker ${system === 'dnd2024' ? 'D&D' : 'Call of Cthulhu'} sheet; only Vampire: The Masquerade 5e sheets can be played here.`);
  const [p1, p2, ...rest] = drawing.map(inModel);
  const more = readContinuations(rest);
  const moreText = (title) => more.find((e) => e.title === title)?.text;
  const warnings = [], clipped = [];
  const sheet = {};

  // the heading row: a value follows its label on the same line
  const header = ['Name', 'Concept', 'Predator', 'Chronicle', 'Ambition', 'Clan', 'Sire', 'Desire', 'Generation'];
  const colW = 80.6 / 3, rowH = 11.2 / 3;
  const head = {};
  header.forEach((label, i) => {
    const cx = 9.7 + (i % 3) * colW;
    head[label] = textAt(p1, cx + 1.2, cx + colW, 14.9 + Math.floor(i / 3) * rowH + 2.3);
  });
  let name = head.Name;
  const fullName = rest[0]?.texts.find((t) => / · continued details$/.test(t.text))?.text.replace(/ · continued details$/, '');
  if (CLIPPED.test(name) && fullName) name = fullName;
  for (const [label, key] of [['Concept', 'concept'], ['Predator', 'predatorType'], ['Chronicle', 'chronicle'], ['Ambition', 'ambition'], ['Clan', 'clan'], ['Sire', 'sire'], ['Desire', 'desire']]) {
    if (!head[label]) continue;
    sheet[key] = head[label];
    if (CLIPPED.test(head[label])) clipped.push(label);
  }
  if (CLIPPED.test(name)) clipped.push('Name');
  sheet.generation = firstNumber(head.Generation) ?? undefined;

  // Attributes: three columns of three rows of five dots
  sheet.attributes = {};
  let found = 0;
  Object.values(ATTR_GROUPS).forEach((keys, i) => keys.forEach((key, r) => {
    const d = dotsAt(p1, COLS[i] + 16.1, 26.4 + 7.7 + r * 3.25, 5);
    found += d.found;
    sheet.attributes[key] = d.value;
  }));
  if (found < 40) return null; // not the layout this reads

  // Skills, each with its specialties written small after the name
  sheet.skills = {};
  sheet.specialties = [];
  Object.values(SKILL_GROUPS).forEach((names, i) => names.forEach((skill, r) => {
    const [lx0, dotsX] = SKILL_X[i], base = 46.4 + 6.7 + r * 3.3875;
    sheet.skills[skill] = dotsAt(p1, dotsX, base, 5).value;
    const spec = p1.texts.filter((t) => t.x > lx0 + 0.25 && t.x < dotsX - 0.2 && t.y > base - 0.6 && t.y < base - 0.05).map((t) => t.text).join(' ').trim();
    if (CLIPPED.test(spec)) clipped.push(`${skill}’s specialties`);
    for (const s of spec.replace(CLIPPED, '').split(/,\s*/)) if (s.trim()) sheet.specialties.push({ skill, name: s.trim() });
  }));

  // Health and Willpower: the greyed boxes past the maximum, / for Superficial and X for Aggravated
  const maxima = {};
  for (const [key, label, at] of [['health', 'Health', 38.95], ['willpower', 'Willpower', 60.7]]) {
    const t = trackAt(p1, at, 42.0 + 2.55);
    if (!t) { warnings.push(`The ${label} boxes couldn’t be read, so ${label} is undamaged.`); continue; }
    sheet[key] = { superficial: t.superficial, aggravated: t.aggravated };
    maxima[key] = t.max;
  }

  // Disciplines: six cells of a name, a rating and up to five powers; the continued details hold
  // every power with its level and description, and any discipline past the sixth
  const discs = [];
  for (let i = 0; i < 6; i++) {
    const cx = COLS[i % 3], cw = COLS[i % 3 + 1] - cx, cy = 81.4 + 3.1 + Math.floor(i / 3) * 6 * 2.78;
    const dname = textAt(p1, cx + 0.5, cx + 18.2, cy + 1.95);
    if (!dname) continue;
    const powers = [];
    for (let k = 0; k < 5; k++) { const p = textAt(p1, cx + 0.5, cx + cw, cy + (k + 1) * 2.78 + 1.95); if (p) powers.push(p); }
    discs.push({ name: dname, rating: dotsAt(p1, cx + 18.3, cy + 1.95, 5).value, powers });
  }
  const discMore = more.filter((e) => /^.+ \d+$/.test(e.title) && /\(level [1-5]\)$/m.test(e.text)).map((e) => {
    const [, dname, rating] = e.title.match(/^(.+) (\d+)$/);
    const powers = e.text.split(/\n\s*\n/).map((block) => {
      const [first, ...descLines] = block.split('\n');
      const m = first.match(/^(.+) \(level ([1-5])\)$/);
      return m ? { name: m[1].trim(), level: Number(m[2]), desc: descLines.join('\n').trim() } : null;
    }).filter(Boolean);
    return { name: dname, rating: Number(rating), powers };
  });
  const sameName = (shown, full) => shown === full || (CLIPPED.test(shown) && full.startsWith(shown.replace(CLIPPED, '')));
  sheet.disciplines = discs.map((d) => {
    const full = discMore.find((x) => sameName(d.name, x.name) && x.rating === d.rating);
    if (full) return full;
    if (CLIPPED.test(d.name)) clipped.push(`the discipline ${d.name}`);
    // without details, a power's level comes from its name, or else its place in the list
    return { name: d.name.replace(CLIPPED, ''), rating: d.rating, powers: d.powers.map((p, k) => ({ name: p.replace(CLIPPED, ''), level: levelOf(p) ?? Math.min(5, k + 1), desc: '' })) };
  });
  // past the sixth, a discipline is only in the details
  for (const x of discMore) if (!sheet.disciplines.some((d) => d.name === x.name)) sheet.disciplines.push(x);

  // Resonance, Hunger and Humanity along the bottom
  const base = 119.0 + 2.2;
  const resonance = runsAt(p1, 9.7, 36.7, base - 0.1).filter((t) => t.text !== 'Resonance').map((t) => t.text).join(' ');
  if (resonance) sheet.resonance = resonance;
  const hunger = boxesAt(p1, 48.4, base - 1.25, 5), humanity = boxesAt(p1, 71.4, base - 1.25, 10);
  sheet.hunger = hunger ? hunger.filter((b) => b.tone === 'ink').length : 1;
  if (humanity) sheet.humanity = humanity.filter((b) => b.tone === 'ink').length;
  else warnings.push('The Humanity boxes couldn’t be read, so Humanity starts at 7.');

  // page 2: three text areas, then advantages and notes on the left, potency, experience and the table on the right
  const area = (pg, x0, x1, first, bottom, width, title) => {
    const lines = areaLines(pg, x0, x1, first, bottom), starts = title === TOUCH_TITLE ? newPair : undefined;
    if (lines.length && lines[lines.length - 1].text === MORE) return moreText(title) ?? joinLines(lines.slice(0, -1), width, 1.2, LINE, starts);
    return joinLines(lines, width, 1.2, LINE, starts);
  };
  const trioTop = 12.0 + 3.5;
  const trio = TRIO.slice(0, 3).map((x, i) => area(p2, x + 0.5, TRIO[i + 1], trioTop + 2.4, 12.0 + 25.7, TRIO[i + 1] - x - 1.4,
    ['Chronicle tenets', TOUCH_TITLE, 'Clan bane'][i]));
  if (trio[0]) sheet.tenets = trio[0];
  if (trio[2]) sheet.bane = trio[2];

  // "conviction — touchstone" per line; a touchstone's details hold its own conviction, then its description
  sheet.convictions = [];
  sheet.touchstones = [];
  for (const line of trio[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(.+?)\s+—\s+(.+)$/);
    if (m) { sheet.convictions.push(m[1]); sheet.touchstones.push({ name: m[2], conviction: m[1], desc: '' }); } else sheet.convictions.push(line);
  }
  for (const e of more.filter((x) => x.title.startsWith('Touchstone · '))) {
    const tname = e.title.slice('Touchstone · '.length);
    let t = sheet.touchstones.find((x) => x.name === tname);
    if (!t) {
      // a touchstone shown without a conviction is a bare line, which was read as a conviction
      const i = sheet.convictions.indexOf(tname);
      if (i >= 0) sheet.convictions.splice(i, 1);
      t = { name: tname, conviction: '', desc: '' };
      sheet.touchstones.push(t);
    }
    const [first, ...others] = e.text.split('\n');
    t.desc = (t.conviction && first.trim() === t.conviction ? others.join('\n') : e.text).trim();
  }

  // Advantages & Flaws: eleven rows of a name and five dots, flaws marked "(flaw)"; the details hold
  // descriptions and, past eleven, the whole list
  const rows = [];
  for (let r = 0; r < 11; r++) {
    const b = 38.2 + 3.3 + r * 3.7 + 2.5, label = textAt(p2, 10.2, 40.4, b);
    if (label) rows.push({ label, dots: dotsAt(p2, 9.7 + 30.8, b, 5).value });
  }
  const all = moreText('All advantages & flaws');
  if (all) {
    rows.length = 0;
    for (const line of all.split('\n')) { const m = line.trim().match(/^(.*?)\s*(•*)$/); if (m?.[1]) rows.push({ label: m[1], dots: m[2].length }); }
  }
  sheet.advantages = rows.map(({ label, dots }) => {
    const flaw = /\s\(flaw\)$/.test(label), shown = label.replace(/\s\(flaw\)$/, '');
    const e = more.find((x) => x.title.startsWith(`${flaw ? 'Flaw' : 'Advantage'} · `) && sameName(shown, x.title.slice(x.title.indexOf(' · ') + 3)));
    const full = e ? e.title.slice(e.title.indexOf(' · ') + 3) : shown;
    if (CLIPPED.test(full)) clipped.push(`the ${flaw ? 'flaw' : 'advantage'} ${full}`);
    return { name: full.replace(CLIPPED, ''), dots, flaw, desc: e?.text || '' };
  });

  sheet.notes = area(p2, 10.2, 49.1, 83.8 + 3.6, 83.8 + 36.6, 39.4 - 1.4, 'Notes');

  // Blood Potency's ten dots follow its centred heading
  const potency = p2.circles.filter((c) => c.x > 50.9 && c.x < 90.3 && near(c.y, 38.2 + 2.5 - 0.45)).sort((a, b) => a.x - b.x);
  sheet.bloodPotency = potency.filter((c) => c.tone === 'ink').length;
  const potencyRows = [41.5, 48.0, 54.4];
  [['bloodSurge', 'Blood Surge'], ['mendAmount', 'Mend Amount'], ['powerBonus', 'Power Bonus'], ['rouseReroll', 'Rouse Re-Roll'], ['feedingPenalty', 'Feeding Penalty'], ['baneSeverity', 'Bane Severity']].forEach(([key, label], i) => {
    const cx = 50.9 + (i % 2) * 19.7, v = textAt(p2, cx + 0.5, cx + 19.7, potencyRows[Math.floor(i / 2)] + 4.6);
    if (v) { sheet[key] = v; if (CLIPPED.test(v)) clipped.push(label); }
  });

  const xpAt = (b, label) => firstNumber(runsAt(p2, 50.9, 90.3, b - 0.15).filter((t) => t.text !== label).map((t) => t.text).join(' ')) ?? 0;
  sheet.xp = { total: xpAt(62.4 + 2.7, 'Total Experience'), spent: xpAt(62.4 + 6.6, 'Spent Experience') };

  let y = 71.2;
  for (const [label, h, key, kind] of [['True age', 3.2, 'trueAge'], ['Apparent age', 3.25, 'apparentAge'], ['Date of birth', 3.2, 'dateOfBirth'], ['Date of death', 3.2, 'dateOfDeath'],
    ['Appearance', 6.5, 'appearance', 'area'], ['Distinguishing features', 6.5, 'features', 'area'], ['History', 23.35, 'history', 'area']]) {
    if (kind === 'area') {
      const v = area(p2, 51.4, 90.3, y + 3.95, y + h, 39.4 - 1.4, label);
      if (v) sheet[key] = v;
    } else {
      const v = runsAt(p2, 51.4, 90.3, y + 2.2).filter((t) => t.text !== label).map((t) => t.text).join(' ');
      if (v) { sheet[key] = v; if (CLIPPED.test(v)) clipped.push(label); }
    }
    y += h;
  }

  if (clipped.length) warnings.push(`Some text was cut short to fit the PDF, so check: ${clipped.length > 1 ? `${clipped.slice(0, -1).join(', ')} and ${clipped[clipped.length - 1]}` : clipped[0]}.`);
  const { data, warnings: more2 } = normalizeSheet(sheet);
  // more boxes than the Attributes give is a bonus (Fortitude, a Merit)
  if (maxima.health && maxima.health !== data.attributes.stamina + 3) data.healthMaxBonus = Math.max(-5, Math.min(10, maxima.health - data.attributes.stamina - 3));
  if (maxima.willpower && maxima.willpower !== data.attributes.composure + data.attributes.resolve) data.willpowerMaxBonus = Math.max(-5, Math.min(10, maxima.willpower - data.attributes.composure - data.attributes.resolve));
  return { name: (name.replace(CLIPPED, '') || 'Unnamed').slice(0, 80), data, warnings: [...warnings, ...more2] };
}
