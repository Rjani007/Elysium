// The live table: your sheet and dice tray, the shared roll feed, the coterie, revealed
// Kindred and handouts, and the music. Everything arrives through one realtime channel,
// and the database's row level security decides what each browser is sent.

import { sb, q, call, currentUser, syncClock } from '../supa.js';
import { el, fail, toast, stored, compareNames, initials, confirmDialog, promptDialog } from '../util.js';
import { go } from '../main.js';
import { sheetView } from '../sheet.js';
import { rollCard } from '../dice.js';
import { musicDock } from '../music.js';
import { npcCard, openHandout, editNpc, editHandout, HANDOUT_ICON } from '../library.js';
import { revealControl } from '../reveal.js';
import { mediaImg } from '../media.js';
import {
  ATTRIBUTES, SKILLS, DISCIPLINES, cap, poolPreview, specialtiesFor, surgeDice, traitInfo, traitKey, hunger as hungerOf,
} from '../v5.js';

const FEED_SIZE = 80;

export async function render(root, tableId) {
  const me = currentUser();
  const [table] = await q(sb.from('game_tables').select('*').eq('id', tableId));
  if (!table) throw new Error("This table doesn't exist, or you aren't seated at it. Ask your storyteller for an invite link.");
  const chronicleId = table.chronicle_id;
  const [[chronicle], [membership]] = await Promise.all([
    q(sb.from('chronicles').select('id, name').eq('id', chronicleId)),
    q(sb.from('chronicle_members').select('role').eq('chronicle_id', chronicleId).eq('user_id', me.id)),
  ]);
  const isST = membership?.role === 'storyteller';
  syncClock().catch(() => {});

  const s = {
    rolls: new Map(), roster: [], characters: [], npcs: [], handouts: [], secrets: new Map(),
    reveals: [], tables: [], members: [], tableState: null, presence: [], tracks: [],
    active: stored(`as:${tableId}`) || null, // ST: 'npc:<id>' | '<character id>' | null
    tray: { traits: [], modifier: 0, specialty: '', surge: false, difficulty: '', private: false, label: '', pool: 2, hunger: 0, rouseFirst: 0, showName: false },
    reroll: null, sideTab: stored('side-tab') || 'coterie', mobileTab: 'feed', spotlightSeen: 0,
  };
  let sheet = null;

  // ---------- data ----------

  async function loadRolls() {
    const rows = await q(sb.from('rolls').select('*').eq('table_id', tableId).order('created_at', { ascending: false }).limit(FEED_SIZE));
    s.rolls = new Map(rows.reverse().map((r) => [r.id, r]));
  }
  async function loadRoster() {
    s.roster = await call('table_roster', { p_table: tableId });
  }
  async function loadCharacters() {
    const query = sb.from('characters').select('*').eq('chronicle_id', chronicleId);
    s.characters = (await q(isST ? query : query.eq('owner_id', me.id))).sort((a, b) => compareNames(a.name, b.name));
  }
  async function loadLibrary() {
    const [npcs, handouts, reveals] = await Promise.all([
      q(sb.from('npcs').select('*').eq('chronicle_id', chronicleId)),
      q(sb.from('handouts').select('*').eq('chronicle_id', chronicleId).order('created_at', { ascending: false })),
      q(sb.from('reveals').select('*').eq('chronicle_id', chronicleId)),
    ]);
    s.npcs = npcs.sort((a, b) => compareNames(a.name, b.name));
    s.handouts = handouts;
    s.reveals = reveals;
    if (isST) {
      const secrets = await q(sb.from('npc_secrets').select('*').eq('chronicle_id', chronicleId));
      s.secrets = new Map(secrets.map((x) => [x.npc_id, x]));
    }
  }
  async function loadStoryteller() {
    if (!isST) return;
    const [tables, members, tracks] = await Promise.all([
      q(sb.from('game_tables').select('id, name').eq('chronicle_id', chronicleId).order('created_at')),
      q(sb.from('chronicle_members').select('user_id, role, profile:profiles(display_name)').eq('chronicle_id', chronicleId)),
      q(sb.from('tracks').select('*').eq('chronicle_id', chronicleId).order('mood').order('title')),
    ]);
    s.tables = tables;
    s.members = members.map((m) => ({ ...m, display_name: m.profile?.display_name || 'Player' }));
    s.tracks = tracks;
  }
  async function loadState() {
    s.tableState = (await q(sb.from('table_state').select('*').eq('table_id', tableId)))[0] || null;
  }
  async function loadAll() {
    await Promise.all([loadRolls(), loadRoster(), loadCharacters(), loadLibrary(), loadStoryteller(), loadState()]);
  }
  await loadAll();

  // ---------- who am I rolling as ----------

  const mySeat = () => s.roster.find((r) => r.user_id === me.id);
  function activeCharacter() {
    if (isST) return s.active && !s.active.startsWith('npc:') ? s.characters.find((c) => c.id === s.active) || null : null;
    const id = mySeat()?.character_id;
    return id ? s.characters.find((c) => c.id === id) || null : null;
  }
  const activeNpc = () => (isST && s.active?.startsWith('npc:') ? s.npcs.find((n) => n.id === s.active.slice(4)) || null : null);
  // rolls name an NPC only once it is revealed to this table (public.roller_name)
  const namedHere = (npc) => s.reveals.some((r) => r.npc_id === npc.id && r.table_id === tableId);
  function rollAs(value) {
    s.active = value || null;
    stored(`as:${tableId}`, s.active);
    resetTray();
    drawSheetPane();
    drawTray();
  }

  // ---------- layout ----------

  const feed = el('div', { class: 'feed', role: 'log', 'aria-label': 'Rolls', 'aria-live': 'polite' });
  const sheetPane = el('aside', { class: 'pane pane-sheet', 'aria-label': 'Sheet' });
  const tray = el('div', { class: 'tray' });
  const side = el('aside', { class: 'pane pane-side', 'aria-label': 'Table' });
  const presence = el('div', { class: 'presence', 'aria-label': 'Who is here' });
  const music = musicDock({ controls: isST ? musicControls() : null });
  // on a phone the sheet and the tray are different tabs: a picked pool can be rolled from the sheet
  const floatRoll = el('button', { class: 'btn btn-primary float-roll', onclick: () => { showTab('feed'); rollNow(); } });
  const tableName = el('h1', {}, table.name);
  const shell = el('div', { class: `table-app mobile-${s.mobileTab}` },
    el('header', { class: 'table-top' },
      el('a', { class: 'back', href: `#/c/${chronicleId}`, title: 'Back to the chronicle' }, '←', el('span', {}, chronicle?.name || 'Chronicle')),
      tableName,
      isST ? el('button', { class: 'icon-btn small', title: 'Rename this table', 'aria-label': 'Rename this table', onclick: () => renameTable() }, '✎') : null,
      presence,
      isST ? el('span', { class: 'badge badge-storyteller' }, 'Storyteller') : null),
    el('div', { class: 'table-grid' }, sheetPane, el('section', { class: 'pane pane-feed' }, feed, tray), side),
    el('nav', { class: 'mobile-tabs' }, [['sheet', 'Sheet'], ['feed', 'Rolls'], ['side', 'Table']].map(([key, label]) =>
      el('button', { class: key === s.mobileTab ? 'active' : '', onclick: () => showTab(key) }, label))),
    music.node, floatRoll);
  root.append(shell);
  // the dock floats over the layout; the panes leave room for it (--music-h in app.css)
  const fit = new ResizeObserver(() => {
    shell.classList.toggle('has-music', !music.node.hidden);
    shell.style.setProperty('--music-h', `${music.node.hidden ? 0 : music.node.offsetHeight}px`);
  });
  fit.observe(music.node);
  function drawMobileTabs() {
    shell.querySelectorAll('.mobile-tabs button').forEach((b, i) => b.classList.toggle('active', ['sheet', 'feed', 'side'][i] === s.mobileTab));
  }
  async function renameTable() {
    const n = await promptDialog('Rename table', { value: table.name, maxlength: 60 });
    if (!n || n === table.name) return;
    try {
      await q(sb.from('game_tables').update({ name: n }).eq('id', tableId));
      table.name = n;
      tableName.textContent = n;
      const listed = s.tables.find((t) => t.id === tableId);
      if (listed) listed.name = n;
      drawSide();
    } catch (err) { fail(err); }
  }
  // on a phone each pane is a tab: show the one that answers what was just tapped
  function showTab(tab) {
    s.mobileTab = tab;
    shell.className = `table-app mobile-${tab}`;
    drawMobileTabs();
  }

  // ---------- sheet pane ----------

  function drawSheetPane() {
    sheet?.destroy();
    sheet = null;
    const parts = [];
    if (isST) {
      const sel = el('select', { 'aria-label': 'Roll as' },
        el('option', { value: '' }, 'The Storyteller (free dice)'),
        s.npcs.length ? el('optgroup', { label: 'NPCs' }, s.npcs.map((n) => el('option', { value: `npc:${n.id}`, selected: s.active === `npc:${n.id}` }, n.name))) : null,
        el('optgroup', { label: 'Characters at this table' }, s.roster.filter((r) => r.character_id).map((r) =>
          el('option', { value: r.character_id, selected: s.active === r.character_id }, `${r.character_name} (${r.display_name})`))));
      sel.addEventListener('change', () => rollAs(sel.value));
      parts.push(el('label', { class: 'field' }, el('span', {}, 'Roll as'), sel));
    }
    const c = activeCharacter();
    const npc = activeNpc();
    if (c) {
      parts.push(el('div', { class: 'sheet-who' },
        el('div', { class: 'portrait small' }, c.portrait_path ? mediaImg(c.portrait_path, { alt: '' }) : el('span', {}, '🩸')),
        el('div', {}, el('h2', {}, c.name), el('a', { class: 'small', href: `#/ch/${c.id}` }, 'Full sheet ↗'))));
      sheet = sheetView(c, {
        editable: true, compact: true,
        isPicked: (key) => s.tray.traits.includes(key),
        onPick: (key) => { togglePick(key); },
        onRollPower: (p) => loadPower(p),
        onChange: () => drawTray(),
      });
      parts.push(sheet.node);
    } else if (npc) {
      const secret = s.secrets.get(npc.id) || {};
      parts.push(npcCard(npc, el('div', { class: 'stack-tight' },
        el('p', { class: 'small' }, `🔒 Hunger ${secret.hunger ?? 0}`),
        (secret.pools || []).length ? el('div', { class: 'row wrap' }, secret.pools.map((p) => el('button', {
          class: 'btn btn-small', onclick: () => { s.tray = { ...s.tray, traits: [], pool: p.dice, label: p.label, hunger: secret.hunger ?? 0 }; drawTray(); showTab('feed'); },
        }, `${p.label} ${p.dice}`))) : el('p', { class: 'muted small' }, 'Add quick dice pools to this NPC to roll them in one click.'),
        el('p', { class: 'muted small' }, namedHere(npc) ? 'Revealed to this table, so its rolls carry its name.'
          : '🔒 Not revealed to this table, so players see its rolls as “The Storyteller”. Tick “Show the name” on a roll to name it anyway.'),
        secret.notes ? el('details', {}, el('summary', {}, '🔒 Notes'), el('p', { class: 'small pre' }, secret.notes)) : null,
        el('button', { class: 'link-btn', onclick: () => editNpc(chronicleId, npc, refreshLibrary) }, 'Edit NPC'))));
    } else if (isST) {
      parts.push(el('p', { class: 'muted small' }, 'Rolling free dice as the Storyteller. Pick an NPC above to roll as them; their name shows only if they were revealed to this table, or if you tick “Show the name”.'));
    } else {
      const mine = s.characters;
      parts.push(el('div', { class: 'stack' },
        el('h2', {}, 'Who are you playing?'),
        mine.length ? mine.map((ch) => el('button', {
          class: 'btn btn-wide',
          onclick: async () => { try { await call('choose_character', { p_table: tableId, p_character: ch.id }); await loadRoster(); drawAll(); } catch (err) { fail(err); } },
        }, ch.name)) : el('p', { class: 'muted' }, 'You have no character in this chronicle yet.'),
        el('a', { class: 'btn', href: `#/c/${chronicleId}/characters` }, mine.length ? 'Import or make another' : 'Import or make a character')));
    }
    if (c && !isST) {
      parts.push(el('button', {
        class: 'link-btn small',
        onclick: async () => { try { await call('choose_character', { p_table: tableId, p_character: null }); await loadRoster(); drawAll(); } catch (err) { fail(err); } },
      }, 'Play a different character'));
    }
    sheetPane.replaceChildren(...parts);
  }

  // ---------- dice tray ----------

  function resetTray() {
    s.tray = { ...s.tray, traits: [], modifier: 0, specialty: '', surge: false, label: '', rouseFirst: 0, showName: false };
  }
  function togglePick(key) {
    const t = s.tray.traits;
    if (t.includes(key)) t.splice(t.indexOf(key), 1);
    else { if (t.length >= 3) t.shift(); t.push(key); }
    if (!skillSpecialties().includes(s.tray.specialty)) s.tray.specialty = '';
    sheet?.redraw();
    drawTray();
  }
  // the tray lists "Skill: Specialty"; the roll records just the specialty
  const specialtyName = (s) => (s ? s.split(': ').slice(1).join(': ') || s : null);
  function skillSpecialties() {
    const c = activeCharacter();
    if (!c) return [];
    return s.tray.traits.filter((k) => k.startsWith('skill:')).flatMap((k) => specialtiesFor(c.data, k.slice(6)).map((n) => `${k.slice(6)}: ${n}`));
  }

  // "Charisma + Presence" -> trait keys; null if any part isn't on the sheet's vocabulary
  function parsePool(text) {
    const words = String(text || '').split(/\bvs\.?\b|versus/i)[0].split(/\+|,|\band\b/i).map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (!words.length || words.length > 3) return null;
    const keys = words.map((w) => {
      if (ATTRIBUTES.includes(w)) return traitKey.attr(w);
      const sk = SKILLS.find((x) => x.toLowerCase() === w);
      if (sk) return traitKey.skill(sk);
      const disc = DISCIPLINES.find((x) => x.toLowerCase() === w);
      return disc ? traitKey.disc(disc) : null;
    });
    return keys.every(Boolean) ? keys : null;
  }
  function loadPower(p) {
    const keys = parsePool(p.pool);
    s.tray = { ...s.tray, traits: keys || [], label: p.name, rouseFirst: Math.max(0, Math.min(5, Number(p.rouse) || 0)), specialty: '', surge: false };
    if (p.pool && !keys) toast(`Pick the traits for "${p.pool}" on the sheet.`);
    sheet?.redraw();
    drawTray();
    showTab('feed');
  }

  function drawTray() {
    const c = activeCharacter();
    const npc = activeNpc();
    const t = s.tray;
    const usingTraits = !!c && t.traits.length > 0;
    const preview = usingTraits
      ? poolPreview(c.data, { traits: t.traits, modifier: t.modifier, specialty: t.specialty, surge: t.surge })
      : { pool: Math.max(1, Math.min(30, Number(t.pool) + Number(t.modifier) + (t.specialty ? 1 : 0))), hunger: c ? Math.min(hungerOf(c.data), Number(t.pool) || 1) : npc ? (s.secrets.get(npc.id)?.hunger ?? 0) : Number(t.hunger) || 0 };
    preview.hunger = Math.min(preview.hunger, preview.pool);

    const chips = usingTraits
      ? t.traits.map((k) => {
        const info = traitInfo(c.data, k);
        return el('button', { class: 'chip chip-trait', onclick: () => togglePick(k), title: 'Remove' }, `${info.name} ${info.value}`, el('span', { class: 'chip-x' }, '✕'));
      })
      : [el('label', { class: 'free-pool' }, el('span', { class: 'small' }, c ? 'Pick traits on your sheet, or roll' : 'Roll'),
        (() => {
          const n = el('input', { type: 'number', min: 1, max: 30, value: t.pool, class: 'num', 'aria-label': 'Number of dice' });
          n.addEventListener('input', () => { t.pool = Math.max(0, Math.min(30, Number(n.value) || 0)); drawRollButton(); });
          return n;
        })(), el('span', { class: 'small' }, 'dice'))];

    const specs = skillSpecialties();
    const modifier = el('span', { class: 'stepper', 'aria-label': 'Bonus or penalty dice' },
      el('button', { class: 'icon-btn small', 'aria-label': 'One die fewer', onclick: () => { t.modifier = Math.max(-10, t.modifier - 1); drawTray(); } }, '−'),
      el('span', { class: 'small' }, t.modifier > 0 ? `+${t.modifier}` : String(t.modifier)),
      el('button', { class: 'icon-btn small', 'aria-label': 'One die more', onclick: () => { t.modifier = Math.min(10, t.modifier + 1); drawTray(); } }, '+'));
    const specialty = specs.length ? (() => {
      const sel = el('select', { 'aria-label': 'Specialty' }, el('option', { value: '' }, 'No specialty'), specs.map((x) => el('option', { value: x, selected: x === t.specialty }, `+1 ${x}`)));
      sel.addEventListener('change', () => { t.specialty = sel.value; drawTray(); });
      return sel;
    })() : null;
    const surgeN = c ? surgeDice(c.data) : 0;
    const surge = c && usingTraits && surgeN > 0 && t.traits.some((k) => k.startsWith('attr:')) ? el('label', { class: 'check small', title: 'Make a Rouse check, then add dice' },
      el('input', { type: 'checkbox', checked: t.surge, onchange: (e) => { t.surge = e.target.checked; drawTray(); } }), `Blood Surge +${surgeN}`) : null;
    const hungerInput = !c && !npc ? (() => {
      const h = el('input', { type: 'number', min: 0, max: 5, value: t.hunger, class: 'num', 'aria-label': 'Hunger dice' });
      h.addEventListener('input', () => { t.hunger = Math.max(0, Math.min(5, Number(h.value) || 0)); drawRollButton(); });
      return el('label', { class: 'small inline-field' }, 'Hunger', h);
    })() : null;
    const difficulty = el('input', { type: 'number', min: 1, max: 15, value: t.difficulty, placeholder: '–', class: 'num', 'aria-label': 'Difficulty, if you know it' });
    difficulty.addEventListener('input', () => { t.difficulty = difficulty.value; });
    const label = el('input', { value: t.label, placeholder: 'What for? (optional)', maxlength: 120, class: 'grow', 'aria-label': 'What the roll is for' });
    label.addEventListener('input', () => { t.label = label.value; });
    label.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rollNow(); } });
    const priv = el('label', { class: 'check small', title: isST ? 'Only storytellers see it' : 'Only you and the storytellers see it' },
      el('input', { type: 'checkbox', checked: t.private, onchange: (e) => { t.private = e.target.checked; } }), '🔒 Private');
    const showName = npc && !namedHere(npc) ? el('label', { class: 'check small', title: 'Players see the name on this roll; the NPC’s card stays hidden' },
      el('input', { type: 'checkbox', checked: t.showName, onchange: (e) => { t.showName = e.target.checked; } }), `Show the name “${npc.name}”`) : null;
    const rouseFirst = t.rouseFirst && c ? el('label', { class: 'check small' },
      el('input', { type: 'checkbox', checked: true, onchange: (e) => { t.rouseFirst = e.target.checked ? t.rouseFirst : 0; drawTray(); } }),
      `🩸 ${t.rouseFirst} Rouse check${t.rouseFirst > 1 ? 's' : ''} first`) : null;

    const rollBtn = el('button', { class: 'btn btn-primary btn-roll', onclick: () => rollNow() });
    function drawRollButton() {
      const p = usingTraits ? preview : { pool: Math.max(1, Math.min(30, Number(t.pool) + Number(t.modifier) + (t.specialty ? 1 : 0))), hunger: preview.hunger };
      const h = Math.min(p.hunger, p.pool);
      rollBtn.replaceChildren(el('span', {}, `Roll ${p.pool}`), h ? el('span', { class: 'roll-hunger' }, ` · ${h} Hunger`) : '');
    }
    drawRollButton();
    floatRoll.toggleAttribute('data-ready', usingTraits);
    floatRoll.textContent = rollBtn.textContent;

    const quick = c ? el('div', { class: 'row wrap quick' },
      el('button', { class: 'btn btn-small', onclick: () => rouse(), title: 'One die: 6 or more and Hunger stays' }, '🩸 Rouse'),
      el('button', { class: 'btn btn-small', onclick: () => tracker('willpower'), title: 'Your undamaged Willpower' }, 'Willpower'),
      el('button', { class: 'btn btn-small', onclick: () => tracker('frenzy'), title: 'Willpower plus a third of Humanity' }, 'Resist frenzy'),
      el('button', { class: 'btn btn-small', onclick: () => remorse(), title: 'At the end of a session with Stains' }, 'Remorse')) : null;

    tray.replaceChildren(
      el('div', { class: 'tray-pool' }, chips, usingTraits ? el('button', { class: 'link-btn small', onclick: () => { t.traits = []; t.specialty = ''; t.surge = false; sheet?.redraw(); drawTray(); } }, 'clear') : null),
      el('div', { class: 'row wrap tray-options' }, modifier, specialty, surge, hungerInput, el('label', { class: 'small inline-field' }, 'Difficulty', difficulty), priv, showName, rouseFirst),
      el('div', { class: 'row tray-go' }, label, rollBtn),
      quick || '');
  }

  async function busy(fn) {
    tray.classList.add('busy');
    try { await fn(); } catch (err) { fail(err); } finally { tray.classList.remove('busy'); }
  }

  function addRoll(r, fresh = true) {
    const known = s.rolls.has(r.id);
    s.rolls.set(r.id, r);
    if (!known && s.rolls.size > FEED_SIZE * 2) s.rolls.delete(s.rolls.keys().next().value);
    drawFeed(fresh && !known ? r.id : null);
  }

  function rollNow() {
    return busy(async () => {
      const c = activeCharacter();
      const npc = activeNpc();
      const t = s.tray;
      const common = { p_table: tableId, p_private: t.private, p_label: t.label.trim() || null, p_difficulty: t.difficulty ? Number(t.difficulty) : null };
      if (c && t.rouseFirst) {
        for (let i = 0; i < t.rouseFirst; i++) {
          addRoll(await call('rouse_check', { p_table: tableId, p_character: c.id, p_label: `Rouse check: ${t.label || 'power'}`, p_private: t.private }));
        }
      }
      let r;
      if (c && t.traits.length) {
        r = await call('roll_pool', { ...common, p_character: c.id, p_traits: t.traits, p_modifier: t.modifier, p_specialty: specialtyName(t.specialty), p_surge: t.surge });
      } else if (c) {
        r = await call('roll_pool', { ...common, p_character: c.id, p_pool: Number(t.pool) || 1, p_modifier: t.modifier, p_specialty: specialtyName(t.specialty) });
      } else if (npc) {
        r = await call('roll_pool', { ...common, p_npc: npc.id, p_pool: Number(t.pool) || 1, p_modifier: t.modifier, p_as: t.showName && !namedHere(npc) ? npc.name : null });
      } else {
        r = await call('roll_pool', { ...common, p_pool: Number(t.pool) || 1, p_modifier: t.modifier, p_hunger: Number(t.hunger) || 0 });
      }
      addRoll(r);
      t.rouseFirst = 0;
      t.surge = false;
      t.label = '';
      drawTray();
    });
  }
  const rouse = () => busy(async () => {
    const c = activeCharacter();
    if (hungerOf(c.data) >= 5) {
      if (!await confirmDialog('At Hunger 5 the Blood can\'t be roused on purpose. Is something forcing this check?', { ok: 'Yes, roll it', title: 'Hunger 5' })) return;
      addRoll(await call('rouse_check', { p_table: tableId, p_character: c.id, p_forced: true, p_private: s.tray.private }));
      return;
    }
    addRoll(await call('rouse_check', { p_table: tableId, p_character: c.id, p_label: s.tray.label.trim() || null, p_private: s.tray.private }));
  });
  const tracker = (which) => busy(async () => {
    const c = activeCharacter();
    addRoll(await call('tracker_roll', { p_table: tableId, p_character: c.id, p_tracker: which, p_difficulty: s.tray.difficulty ? Number(s.tray.difficulty) : null, p_private: s.tray.private }));
  });
  const remorse = () => busy(async () => {
    const c = activeCharacter();
    if (!await confirmDialog(`Make a Remorse check for ${c.name}? It clears every Stain, and on a failure costs a dot of Humanity.`, { ok: 'Roll Remorse' })) return;
    addRoll(await call('remorse_check', { p_table: tableId, p_character: c.id, p_private: s.tray.private }));
  });

  // ---------- feed ----------

  function drawFeed(freshId = null) {
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    const rolls = [...s.rolls.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    feed.replaceChildren(...(rolls.length ? rolls.map((r) => rollCard(r, {
      me: me.id, isST, fresh: r.id === freshId,
      npcName: isST ? (id) => s.npcs.find((n) => n.id === id)?.name : null,
      rerollFor: s.reroll?.rollId, rerollSelection: s.reroll?.selected,
      onStartReroll: (roll) => { s.reroll = { rollId: roll.id, selected: new Set() }; drawFeed(); },
      onToggleDie: (roll, i) => {
        const sel = s.reroll.selected;
        if (sel.has(i)) sel.delete(i); else if (sel.size < 3) sel.add(i);
        drawFeed();
      },
      onCancelReroll: () => { s.reroll = null; drawFeed(); },
      onConfirmReroll: (roll) => busy(async () => {
        const dice = [...s.reroll.selected];
        s.reroll = null;
        addRoll(await call('willpower_reroll', { p_roll: roll.id, p_dice: dice }));
        s.rolls.set(roll.id, { ...roll, rerolled: true });
        drawFeed();
      }),
      onDifficulty: (roll, d) => busy(async () => addRoll(await call('set_roll_difficulty', { p_roll: roll.id, p_difficulty: d }), false)),
    })) : [el('p', { class: 'muted center feed-empty' }, 'No rolls yet. The night is young.')]));
    if (nearBottom || freshId) feed.scrollTop = feed.scrollHeight;
  }

  // ---------- side panel ----------

  function drawSide() {
    const tabs = [['coterie', 'Coterie'], ['kindred', 'Kindred'], ['handouts', 'Handouts'], ...(isST ? [['music', 'Music']] : [])];
    if (!tabs.some(([k]) => k === s.sideTab)) s.sideTab = 'coterie';
    const body = el('div', { class: 'side-body' }, ({ coterie, kindred, handouts: handoutsTab, music: musicTab })[s.sideTab]());
    side.replaceChildren(
      el('nav', { class: 'tabs tabs-small', role: 'tablist' }, tabs.map(([k, label]) => el('button', {
        role: 'tab', class: k === s.sideTab ? 'active' : '', 'aria-selected': String(k === s.sideTab),
        onclick: () => { s.sideTab = k; stored('side-tab', k); drawSide(); },
      }, label, k === 'handouts' && !isST ? ` ${visibleHandouts().length || ''}` : ''))),
      body);
  }

  const online = (userId) => s.presence.some((p) => p.user_id === userId);
  function coterie() {
    const sts = s.presence.filter((p) => p.role === 'storyteller');
    return el('div', { class: 'stack-tight' },
      sts.map((p) => el('div', { class: 'member' }, el('span', { class: 'avatar st' }, initials(p.name)), el('span', {}, p.name, el('span', { class: 'muted small' }, ' · Storyteller')))),
      s.roster.map((r) => el('div', { class: `member${online(r.user_id) ? ' online' : ''}` },
        el('span', { class: 'portrait tiny' }, r.portrait_path ? mediaImg(r.portrait_path, { alt: '' }) : el('span', {}, initials(r.character_name || r.display_name))),
        el('span', {},
          el('strong', {}, r.character_name || 'No character chosen'),
          el('span', { class: 'muted small' }, ` ${r.clan ? `${r.clan} · ` : ''}${r.display_name}`)),
        el('span', { class: 'dot-online', title: online(r.user_id) ? 'Here now' : 'Away' }))),
      !s.roster.length ? el('p', { class: 'muted small' }, 'Nobody is seated here yet. Share this table\'s invite link from the chronicle page.') : null);
  }

  const revealedHere = (kind, id) => s.reveals.filter((r) => (kind === 'npc' ? r.npc_id : r.handout_id) === id);
  const revealCtx = () => ({ chronicle: chronicleId, tables: s.tables, members: s.members });
  // row level security already limits players to what was revealed to them
  const visibleNpcs = () => s.npcs;
  const visibleHandouts = () => s.handouts;

  function kindred() {
    const list = visibleNpcs();
    return el('div', { class: 'stack' },
      isST ? el('button', { class: 'btn btn-small', onclick: () => editNpc(chronicleId, null, refreshLibrary) }, '+ New NPC') : null,
      list.length ? list.map((n) => npcCard(n, isST ? el('div', { class: 'stack-tight' },
        revealControl(revealCtx(), { kind: 'npc', id: n.id }, revealedHere('npc', n.id), refreshLibrary),
        el('div', { class: 'row' },
          el('button', { class: 'link-btn small', onclick: () => { rollAs(`npc:${n.id}`); showTab('sheet'); } }, 'Roll as'),
          el('button', { class: 'link-btn small', onclick: () => editNpc(chronicleId, n, refreshLibrary) }, 'Edit'))) : null))
        : el('p', { class: 'muted small' }, isST ? 'No NPCs yet.' : 'Nobody has been revealed to you yet.'));
  }

  function handoutsTab() {
    const list = visibleHandouts();
    return el('div', { class: 'stack' },
      isST ? el('button', { class: 'btn btn-small', onclick: () => editHandout(chronicleId, null, refreshLibrary) }, '+ New handout') : null,
      list.length ? el('div', { class: 'list' }, list.map((h) => el('div', { class: 'list-row column' },
        el('button', { class: 'list-main', onclick: () => openHandout(h).catch(fail) }, el('span', { class: 'list-icon' }, HANDOUT_ICON[h.kind]), el('strong', {}, h.title)),
        isST ? revealControl(revealCtx(), { kind: 'handout', id: h.id }, revealedHere('handout', h.id), refreshLibrary) : null,
        isST ? el('button', {
          class: 'btn btn-small', title: 'Reveals it to this table and opens it on every screen',
          onclick: async () => { try { await call('spotlight_handout', { p_table: tableId, p_handout: h.id }); toast('Shown to the table.'); } catch (err) { fail(err); } },
        }, '📣 Show everyone now') : null)))
        : el('p', { class: 'muted small' }, isST ? 'No handouts yet.' : 'Nothing has been handed to you yet.'));
  }

  function musicTab() {
    const now = s.tableState?.music;
    return el('div', { class: 'stack' },
      now ? el('p', { class: 'small' }, `${now.playing ? 'Playing' : 'Paused'}: `, el('strong', {}, now.title || now.videoId)) : el('p', { class: 'muted small' }, 'Nothing playing.'),
      s.tracks.length ? el('div', { class: 'list' }, groupByMood(s.tracks).map(([mood, tracks]) => el('div', { class: 'stack-tight' },
        mood ? el('h4', {}, mood) : null,
        tracks.map((t) => el('div', { class: 'list-row' },
          el('span', { class: 'list-main' }, el('span', { class: 'list-icon' }, now?.videoId === t.video_id ? '♫' : '♪'), t.title),
          el('button', {
            class: 'btn btn-small', onclick: async () => {
              try { await call('set_music', { p_table: tableId, p_action: 'play', p_video: t.video_id, p_title: t.title }); } catch (err) { fail(err); }
            },
          }, '▶ Play')))))) : el('p', { class: 'muted small' }, 'No tracks yet.'),
      el('a', { class: 'link-btn small', href: `#/c/${chronicleId}/music` }, 'Edit the playlist ↗'),
      el('p', { class: 'muted small' }, 'Players press Listen once; browsers don\'t let a page start sound by itself.'));
  }
  const groupByMood = (tracks) => {
    const groups = new Map();
    for (const t of tracks) { if (!groups.has(t.mood)) groups.set(t.mood, []); groups.get(t.mood).push(t); }
    return [...groups.entries()];
  };

  function musicControls() {
    const act = (action, extra = {}) => call('set_music', { p_table: tableId, p_action: action, ...extra }).catch(fail);
    return {
      pause: () => act('pause'), resume: () => act('resume'), stop: () => act('stop'),
      restart: () => act('seek', { p_position: 0 }), loop: (on) => act('loop', { p_loop: on }),
    };
  }

  async function refreshLibrary() {
    await loadLibrary();
    drawSide();
    if (activeNpc() || isST) drawSheetPane();
  }

  function drawPresence() {
    const people = [...new Map(s.presence.map((p) => [p.user_id, p])).values()];
    presence.replaceChildren(...people.map((p) => el('span', { class: `avatar${p.role === 'storyteller' ? ' st' : ''}`, title: `${p.name}${p.role === 'storyteller' ? ' (Storyteller)' : ''}` }, initials(p.name))));
  }

  function applyState() {
    music.apply(s.tableState?.music || null);
    const spot = s.tableState?.spotlight;
    if (spot && spot.at > s.spotlightSeen) {
      const fresh = s.spotlightSeen > 0 || Date.now() - spot.at < 90 * 1000;
      s.spotlightSeen = spot.at;
      const h = s.handouts.find((x) => x.id === spot.handoutId);
      if (fresh && h) openHandout(h).catch(() => {});
    }
  }

  function drawAll() {
    drawSheetPane();
    drawTray();
    drawFeed();
    drawSide();
    drawPresence();
  }
  drawAll();
  s.spotlightSeen = s.tableState?.spotlight?.at && Date.now() - s.tableState.spotlight.at < 90 * 1000 ? 0 : (s.tableState?.spotlight?.at || 0);
  applyState();

  // ---------- realtime ----------

  const channel = sb.channel(`table:${tableId}`, { config: { presence: { key: me.id } } })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rolls', filter: `table_id=eq.${tableId}` }, ({ new: r }) => addRoll(r))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rolls', filter: `table_id=eq.${tableId}` }, ({ new: r }) => addRoll(r, false))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'table_state', filter: `table_id=eq.${tableId}` }, async ({ new: st }) => {
      s.tableState = st;
      if (st.spotlight && !s.handouts.some((h) => h.id === st.spotlight.handoutId)) await loadLibrary().catch(() => {});
      applyState();
      if (isST) drawSide();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'seats', filter: `table_id=eq.${tableId}` }, async () => {
      await loadRoster().catch(() => {});
      if (!isST && !mySeat()) { toast('You are no longer seated at this table.'); go(`#/c/${chronicleId}`); return; }
      drawSheetPane(); drawTray(); drawSide();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reveals' }, () => refreshLibrary().catch(() => {}))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'npcs', filter: `chronicle_id=eq.${chronicleId}` }, () => refreshLibrary().catch(() => {}))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'handouts', filter: `chronicle_id=eq.${chronicleId}` }, () => refreshLibrary().catch(() => {}))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'characters', filter: `chronicle_id=eq.${chronicleId}` }, ({ new: c }) => {
      const i = s.characters.findIndex((x) => x.id === c.id);
      if (i < 0) return;
      s.characters[i] = { ...s.characters[i], ...c };
      if (activeCharacter()?.id === c.id && sheet && JSON.stringify(sheet.data) !== JSON.stringify(c.data)) sheet.update(c.data);
      drawTray();
    })
    .on('presence', { event: 'sync' }, () => {
      s.presence = Object.values(channel.presenceState()).flat();
      drawPresence();
      if (s.sideTab === 'coterie') drawSide();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await channel.track({ user_id: me.id, name: me.displayName, role: isST ? 'storyteller' : 'player' });
    });

  // A sleeping laptop or a dropped connection can miss events: catch up when the tab comes back.
  let lastSeen = Date.now();
  const onVisible = async () => {
    if (document.visibilityState !== 'visible') { lastSeen = Date.now(); return; }
    if (Date.now() - lastSeen < 20000) return;
    try { await loadAll(); drawAll(); applyState(); } catch { /* next time */ }
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    fit.disconnect();
    sheet?.destroy();
    music.destroy();
    sb.removeChannel(channel);
  };
}
