// The V5 sheet, editable in place. Every change is one small patch_character call
// (a single field, merged by the database), so two people editing at once, or a rouse
// check landing while someone clicks a dot, never overwrite each other's work.
//
// sheetView(character, opts) returns { node, update(data), destroy() }.
//   opts.editable  allow changes (owner or storyteller)
//   opts.compact   the table's rolling sheet: no identity form, trait names pick dice
//   opts.isPicked(key) / opts.onPick(key)   dice-tray selection (compact)
//   opts.onRollPower(power, disc)           a power's dice pool or rouse checks (compact)
//   opts.onChange(data)                     after any successful patch

import { call } from './supa.js';
import { el, fail, debounce } from './util.js';
import {
  ATTR_GROUPS, SKILL_GROUPS, SKILLS, DISCIPLINES, CLANS, cap, int, healthMax, willpowerMax, track,
  hunger, humanity, stains, bloodPotency, surgeDice, traitKey,
} from './v5.js';

export function sheetView(character, opts = {}) {
  const editable = !!opts.editable;
  let data = character.data;
  const node = el('div', { class: `sheet${opts.compact ? ' sheet-compact' : ''}` });
  const pending = new Map(); // debounced text/list patches by path

  async function patch(path, value) {
    try {
      data = await call('patch_character', { p_id: character.id, p_path: path, p_value: value });
      character.data = data;
      opts.onChange?.(data);
    } catch (err) {
      fail(err);
      draw();
    }
  }
  function patchLater(path, value, ms = 700) {
    const key = path.join('.');
    if (!pending.has(key)) pending.set(key, debounce((v) => patch(path, v), ms));
    pending.get(key)(value);
  }
  function flushAll() { for (const fn of pending.values()) fn.flush(); }

  // Set a number locally right away, then save it.
  function setNum(path, value) {
    if (path.length === 1) data[path[0]] = value;
    else (data[path[0]] ??= {})[path[1]] = value;
    draw();
    patch(path, value);
  }

  // ---------- widgets ----------

  function dots(value, max, { min = 0, label, path }) {
    const canEdit = editable && !!path;
    const wrap = el('span', {
      class: 'dots', role: 'slider', tabindex: canEdit ? 0 : -1, 'aria-label': label,
      'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': value, 'aria-readonly': String(!canEdit),
    });
    for (let i = 1; i <= max; i++) {
      wrap.append(el('span', { class: `dot${i <= value ? ' on' : ''}${i > 5 && i % 5 === 1 ? ' gap' : ''}`, dataset: { n: i } }));
    }
    if (canEdit) {
      wrap.addEventListener('click', (e) => {
        const n = Number(e.target.dataset?.n);
        if (!n) return;
        setNum(path, Math.max(min, n === value ? n - 1 : n));
      });
      wrap.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const next = Math.max(min, Math.min(max, value + step));
        if (next !== value) { setNum(path, next); requestAnimationFrame(() => node.querySelector(`[aria-label="${CSS.escape(label)}"]`)?.focus()); }
      });
    }
    return wrap;
  }

  // Damage track: aggravated boxes (X) first, then superficial (/), then empty.
  // A click on an empty box adds superficial, on a superficial box makes it aggravated,
  // on an aggravated box heals it.
  function damage(which, label) {
    const max = which === 'health' ? healthMax(data) : willpowerMax(data);
    const t = track(data, which);
    const boxes = el('span', { class: 'track', role: 'group', 'aria-label': `${label}: ${t.superficial} superficial, ${t.aggravated} aggravated of ${max}` });
    for (let i = 0; i < max; i++) {
      const state = i < t.aggravated ? 'agg' : i < t.aggravated + t.superficial ? 'sup' : 'ok';
      const box = el(editable ? 'button' : 'span', {
        class: `box box-${state}`, type: editable ? 'button' : null,
        'aria-label': `${label} box ${i + 1}: ${{ ok: 'undamaged', sup: 'superficial', agg: 'aggravated' }[state]}`,
      }, state === 'agg' ? '✕' : state === 'sup' ? '╱' : '');
      if (editable) {
        box.addEventListener('click', () => {
          let { superficial: s, aggravated: a } = t;
          if (state === 'ok') { if (s + a < max) s++; } else if (state === 'sup') { s--; a++; } else a--;
          data[which] = { superficial: s, aggravated: a };
          draw();
          patch([which], data[which]);
        });
      }
      boxes.append(box);
    }
    return boxes;
  }

  function humanityTrack() {
    const h = humanity(data), st = stains(data);
    const boxes = el('span', { class: 'track humanity', role: 'group', 'aria-label': `Humanity ${h}, ${st} stains` });
    for (let i = 1; i <= 10; i++) {
      const filled = i <= h, stained = i > 10 - st;
      const box = el(editable ? 'button' : 'span', {
        class: `box${filled ? ' box-filled' : ''}${stained ? ' box-stain' : ''}`, type: editable ? 'button' : null,
        'aria-label': `Humanity ${i}${filled ? '' : ' (empty)'}${stained ? ', stained' : ''}`,
      }, stained && !filled ? '╱' : '');
      if (editable) box.addEventListener('click', () => setNum(['humanity'], i === h ? i - 1 : i));
      boxes.append(box);
    }
    return el('span', { class: 'row tight' }, boxes,
      el('span', { class: 'stepper', 'aria-label': 'Stains' },
        editable ? el('button', { class: 'icon-btn small', 'aria-label': 'Remove a stain', onclick: () => setNum(['stains'], Math.max(0, st - 1)) }, '−') : null,
        el('span', { class: 'small' }, `${st} stain${st === 1 ? '' : 's'}`),
        editable ? el('button', { class: 'icon-btn small', 'aria-label': 'Add a stain', onclick: () => setNum(['stains'], Math.min(10, st + 1)) }, '+') : null));
  }

  function textField(key, label, { multiline = false, placeholder = '', list = null, wide = false } = {}) {
    const value = data[key] ?? '';
    const input = multiline
      ? el('textarea', { rows: 3, placeholder, disabled: !editable }, String(value))
      : el('input', { value: String(value), placeholder, disabled: !editable, list });
    input.addEventListener('input', () => { data[key] = input.value; patchLater([key], input.value); });
    input.addEventListener('blur', () => pending.get(key)?.flush());
    return el('label', { class: `field${wide ? ' wide' : ''}` }, el('span', {}, label), input);
  }

  function numField(key, label, lo, hi, dflt) {
    const input = el('input', { type: 'number', min: lo, max: hi, value: int(data[key], lo, hi, dflt), disabled: !editable });
    input.addEventListener('change', () => setNum([key], int(input.value, lo, hi, dflt)));
    return el('label', { class: 'field narrow' }, el('span', {}, label), input);
  }

  // A trait name: in the compact sheet it is a toggle that adds the trait to the dice tray.
  function traitName(key, label, value) {
    if (!opts.compact || !opts.onPick) return el('span', { class: 'trait-name' }, label);
    const picked = opts.isPicked?.(key);
    return el('button', {
      class: `trait-name pick${picked ? ' picked' : ''}${value === 0 ? ' zero' : ''}`, type: 'button',
      'aria-pressed': String(!!picked), title: picked ? 'Remove from the dice pool' : 'Add to the dice pool',
      onclick: () => opts.onPick(key),
    }, label);
  }

  // A list edited as a whole: rows render with renderRow(item, i, changed, remove).
  function listEditor(key, { title, empty, renderRow, blank, addLabel }) {
    const items = Array.isArray(data[key]) ? data[key] : (data[key] = []);
    const save = () => patchLater([key], items, 900);
    const body = el('div', { class: 'list-edit' });
    const redrawList = () => {
      body.replaceChildren(...(items.length ? items.map((item, i) => renderRow(item, i, save, () => { items.splice(i, 1); save(); redrawList(); }))
        : [el('p', { class: 'muted small' }, empty)]));
    };
    redrawList();
    return section(title, body, editable ? el('button', { class: 'link-btn', type: 'button', onclick: () => { items.push(blank()); save(); redrawList(); } }, addLabel) : null);
  }

  const removeBtn = (remove, label) => (editable ? el('button', { class: 'icon-btn small', type: 'button', 'aria-label': `Remove ${label}`, onclick: remove }, '✕') : null);
  const bind = (input, obj, prop, save, { number = false } = {}) => {
    input.disabled = !editable;
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
      obj[prop] = input.type === 'checkbox' ? input.checked : number ? int(input.value, 0, 10, 0) : input.value;
      save();
    });
    return input;
  };

  function section(title, body, extra = null) {
    return el('section', { class: 'sheet-section' }, el('div', { class: 'sheet-section-head' }, el('h3', {}, title), extra), body);
  }

  // ---------- sections ----------

  function identity() {
    return section('Identity', el('div', { class: 'id-grid' },
      textField('concept', 'Concept'), textField('predatorType', 'Predator type'), textField('chronicle', 'Chronicle'),
      textField('clan', 'Clan', { list: 'sheet-clans' }), textField('sire', 'Sire'), numField('generation', 'Generation', 1, 16, 13),
      textField('ambition', 'Ambition'), textField('desire', 'Desire'), textField('sect', 'Sect'),
      el('datalist', { id: 'sheet-clans' }, CLANS.map((c) => el('option', { value: c })))));
  }

  function attributes() {
    return section('Attributes', el('div', { class: 'trait-cols' }, Object.entries(ATTR_GROUPS).map(([group, keys]) =>
      el('div', { class: 'trait-col' }, el('h4', {}, group), keys.map((k) => {
        const v = int(data.attributes?.[k], 1, 5, 1);
        return el('div', { class: 'trait-row' }, traitName(traitKey.attr(k), cap(k), v), dots(v, 5, { min: 1, label: cap(k), path: ['attributes', k] }));
      })))));
  }

  function skills() {
    const specs = Array.isArray(data.specialties) ? data.specialties : [];
    return section('Skills', el('div', { class: 'trait-cols' }, Object.entries(SKILL_GROUPS).map(([group, names]) =>
      el('div', { class: 'trait-col' }, el('h4', {}, group), names.map((s) => {
        const v = int(data.skills?.[s], 0, 5, 0);
        const mine = specs.filter((x) => String(x.skill).toLowerCase() === s.toLowerCase()).map((x) => x.name);
        return el('div', { class: 'trait-row' },
          el('span', { class: 'trait-label' }, traitName(traitKey.skill(s), s, v), mine.length ? el('span', { class: 'spec' }, mine.join(', ')) : null),
          dots(v, 5, { label: s, path: ['skills', s] }));
      })))));
  }

  function trackers() {
    const surge = surgeDice(data);
    return section('Health, Willpower and the Blood', el('div', { class: 'trackers' },
      el('div', { class: 'tracker' }, el('span', { class: 'tracker-label' }, 'Health'), damage('health', 'Health')),
      el('div', { class: 'tracker' }, el('span', { class: 'tracker-label' }, 'Willpower'), damage('willpower', 'Willpower')),
      el('div', { class: 'tracker' }, el('span', { class: 'tracker-label' }, 'Hunger'), el('span', { class: 'hunger' }, dots(hunger(data), 5, { label: 'Hunger', path: ['hunger'] }))),
      el('div', { class: 'tracker' }, el('span', { class: 'tracker-label' }, 'Humanity'), humanityTrack()),
      el('div', { class: 'tracker' }, el('span', { class: 'tracker-label' }, 'Blood Potency'), dots(bloodPotency(data), 10, { label: 'Blood Potency', path: ['bloodPotency'] })),
      opts.compact ? el('p', { class: 'muted small' }, surge ? `Blood Surge adds ${surge} ${surge === 1 ? 'die' : 'dice'}.` : 'No Blood Surge at Blood Potency 0.') : null));
  }

  function disciplines() {
    if (opts.compact) {
      const list = Array.isArray(data.disciplines) ? data.disciplines : [];
      return section('Disciplines', list.length ? el('div', { class: 'disc-list' }, list.map((d) => {
        const rating = int(d.rating, 0, 5, 0);
        return el('div', { class: 'disc' },
          el('div', { class: 'trait-row' }, traitName(traitKey.disc(d.name), d.name, rating), dots(rating, 5, { label: d.name, path: null })),
          (d.powers || []).map((p) => el('div', { class: 'power' },
            el('span', {}, p.name, el('span', { class: 'muted small' }, ` ${p.level ? `· ${p.level}` : ''}`)),
            p.pool || int(p.rouse, 0, 5, 0) ? el('button', {
              class: 'btn btn-tiny', type: 'button', title: [p.pool, p.rouse ? `${p.rouse} Rouse check${p.rouse > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · '),
              onclick: () => opts.onRollPower?.(p, d),
            }, p.pool ? `🎲 ${p.pool}` : `🩸 Rouse ×${p.rouse}`) : null)));
      })) : el('p', { class: 'muted small' }, 'No disciplines.'));
    }
    return listEditor('disciplines', {
      title: 'Disciplines', empty: 'No disciplines yet.', addLabel: '+ Discipline',
      blank: () => ({ name: '', rating: 1, powers: [] }),
      renderRow: (d, i, save, remove) => {
        d.powers ??= [];
        const powers = el('div', { class: 'powers' });
        const drawPowers = () => powers.replaceChildren(...d.powers.map((p, j) => el('div', { class: 'power-edit' },
          bind(el('input', { value: p.name || '', placeholder: 'Power', 'aria-label': 'Power name' }), p, 'name', save),
          bind(el('input', { type: 'number', min: 1, max: 5, value: p.level || 1, 'aria-label': 'Level', class: 'num' }), p, 'level', save, { number: true }),
          bind(el('input', { value: p.pool || '', placeholder: 'Dice pool, e.g. Charisma + Presence', 'aria-label': 'Dice pool' }), p, 'pool', save),
          bind(el('input', { type: 'number', min: 0, max: 5, value: p.rouse ?? 0, 'aria-label': 'Rouse checks', class: 'num', title: 'Rouse checks' }), p, 'rouse', save, { number: true }),
          bind(el('textarea', { rows: 1, placeholder: 'Your notes on the power', 'aria-label': 'Notes' }, p.desc || ''), p, 'desc', save),
          removeBtn(() => { d.powers.splice(j, 1); save(); drawPowers(); }, 'power'))));
        drawPowers();
        const rating = el('span', { class: 'dots-holder' });
        const drawRating = () => rating.replaceChildren(ratingDots(d.rating, (n) => { d.rating = n; save(); drawRating(); }, d.name || 'Discipline'));
        drawRating();
        return el('div', { class: 'disc-edit' },
          el('div', { class: 'row' },
            bind(el('input', { value: d.name || '', placeholder: 'Discipline', list: 'sheet-disciplines', 'aria-label': 'Discipline name' }), d, 'name', save),
            rating, removeBtn(remove, d.name || 'discipline')),
          d.powers.length ? el('div', { class: 'power-legend small muted' }, el('span', {}, 'Power'), el('span', {}, 'Level'), el('span', {}, 'Dice pool'), el('span', {}, 'Rouse'), el('span', {}, 'Notes')) : null,
          powers,
          editable ? el('button', { class: 'link-btn small', type: 'button', onclick: () => { d.powers.push({ name: '', level: 1, desc: '' }); save(); drawPowers(); } }, '+ Power') : null,
          i === 0 ? el('datalist', { id: 'sheet-disciplines' }, DISCIPLINES.map((x) => el('option', { value: x }))) : null);
      },
    });
  }

  // Dots that edit a list item rather than a sheet path.
  function ratingDots(value, onSet, label, max = 5) {
    const v = int(value, 0, max, 0);
    const wrap = el('span', { class: 'dots', role: 'slider', tabindex: editable ? 0 : -1, 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': v });
    for (let n = 1; n <= max; n++) wrap.append(el('span', { class: `dot${n <= v ? ' on' : ''}`, dataset: { n } }));
    if (editable) {
      wrap.addEventListener('click', (e) => { const n = Number(e.target.dataset?.n); if (n) onSet(n === v ? n - 1 : n); });
      wrap.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (step) { e.preventDefault(); onSet(Math.max(0, Math.min(max, v + step))); }
      });
    }
    return wrap;
  }

  function specialties() {
    return listEditor('specialties', {
      title: 'Specialties', empty: 'No specialties yet.', addLabel: '+ Specialty',
      blank: () => ({ skill: 'Athletics', name: '' }),
      renderRow: (sp, i, save, remove) => {
        const skillSel = el('select', { 'aria-label': 'Skill' }, SKILLS.map((s) => el('option', { value: s, selected: s === sp.skill }, s)));
        return el('div', { class: 'row' }, bind(skillSel, sp, 'skill', save),
          bind(el('input', { value: sp.name || '', placeholder: 'Specialty', 'aria-label': 'Specialty' }), sp, 'name', save),
          removeBtn(remove, 'specialty'));
      },
    });
  }

  function advantages() {
    return listEditor('advantages', {
      title: 'Advantages and flaws', empty: 'No merits, backgrounds or flaws yet.', addLabel: '+ Advantage or flaw',
      blank: () => ({ name: '', dots: 1, flaw: false, desc: '' }),
      renderRow: (a, i, save, remove) => {
        const holder = el('span', { class: 'dots-holder' });
        const drawDots = () => holder.replaceChildren(ratingDots(a.dots, (n) => { a.dots = n; save(); drawDots(); }, a.name || 'Dots'));
        drawDots();
        return el('div', { class: 'row adv-edit' },
          bind(el('input', { value: a.name || '', placeholder: 'Name', 'aria-label': 'Name' }), a, 'name', save),
          holder,
          el('label', { class: 'check small' }, bind(el('input', { type: 'checkbox', checked: !!a.flaw }), a, 'flaw', save), 'flaw'),
          bind(el('input', { value: a.desc || '', placeholder: 'Note', 'aria-label': 'Note' }), a, 'desc', save),
          removeBtn(remove, a.name || 'advantage'));
      },
    });
  }

  function convictions() {
    // MundusMaker pairs convictions[i] with touchstones[i]; edit them side by side.
    const conv = Array.isArray(data.convictions) ? [...data.convictions] : [];
    const touch = Array.isArray(data.touchstones) ? data.touchstones.map((t) => ({ ...t })) : [];
    const rowsCount = Math.max(conv.length, touch.length);
    const pairs = Array.from({ length: rowsCount }, (_, i) => ({ conviction: conv[i] || '', name: touch[i]?.name || '', desc: touch[i]?.desc || '' }));
    const save = () => {
      const kept = pairs.filter((p) => p.conviction || p.name);
      patchLater(['convictions'], kept.map((p) => p.conviction), 900);
      patchLater(['touchstones'], kept.map((p) => ({ name: p.name, conviction: p.conviction, desc: p.desc })), 900);
    };
    const body = el('div', { class: 'list-edit' });
    const drawPairs = () => body.replaceChildren(...(pairs.length ? pairs.map((p, i) => el('div', { class: 'row pair-edit' },
      bind(el('input', { value: p.conviction, placeholder: 'Conviction', 'aria-label': 'Conviction' }), p, 'conviction', save),
      bind(el('input', { value: p.name, placeholder: 'Touchstone', 'aria-label': 'Touchstone' }), p, 'name', save),
      bind(el('input', { value: p.desc, placeholder: 'Who they are to you', 'aria-label': 'Touchstone note' }), p, 'desc', save),
      removeBtn(() => { pairs.splice(i, 1); save(); drawPairs(); }, 'conviction')))
      : [el('p', { class: 'muted small' }, 'No convictions or touchstones yet.')]));
    drawPairs();
    return section('Convictions and touchstones', body,
      editable ? el('button', { class: 'link-btn', type: 'button', onclick: () => { pairs.push({ conviction: '', name: '', desc: '' }); drawPairs(); } }, '+ Conviction') : null);
  }

  function experience() {
    const xp = data.xp || {};
    const total = el('input', { type: 'number', min: 0, value: int(xp.total, 0, 100000, 0), disabled: !editable });
    const spent = el('input', { type: 'number', min: 0, value: int(xp.spent, 0, 100000, 0), disabled: !editable });
    total.addEventListener('change', () => setNum(['xp', 'total'], int(total.value, 0, 100000, 0)));
    spent.addEventListener('change', () => setNum(['xp', 'spent'], int(spent.value, 0, 100000, 0)));
    const ledger = Array.isArray(xp.ledger) ? xp.ledger.slice(-5).reverse() : [];
    return section('Experience', el('div', { class: 'stack-tight' },
      el('div', { class: 'row' },
        el('label', { class: 'field narrow' }, el('span', {}, 'Total'), total),
        el('label', { class: 'field narrow' }, el('span', {}, 'Spent'), spent),
        el('strong', {}, `${Math.max(0, int(xp.total, 0, 100000, 0) - int(xp.spent, 0, 100000, 0))} XP to spend`)),
      ledger.length ? el('ul', { class: 'ledger' }, ledger.map((e) => el('li', { class: 'small muted' }, `${e.label || ''}${e.cost ? ` · ${e.cost} XP` : ''}`))) : null));
  }

  function more() {
    return el('details', { class: 'sheet-section' }, el('summary', {}, 'Blood, bane and history'),
      el('div', { class: 'id-grid' },
        textField('bloodSurge', 'Blood Surge', { placeholder: `Add ${Math.ceil(bloodPotency(data) / 2)} dice (from Blood Potency)` }),
        textField('mendAmount', 'Mend amount'), textField('powerBonus', 'Power bonus'),
        textField('rouseReroll', 'Rouse re-roll'), textField('feedingPenalty', 'Feeding penalty'), textField('baneSeverity', 'Bane severity'),
        textField('resonance', 'Resonance'), textField('bane', 'Clan bane', { wide: true }),
        textField('tenets', 'Chronicle tenets', { multiline: true, wide: true }),
        textField('trueAge', 'True age'), textField('apparentAge', 'Apparent age'), textField('dateOfBirth', 'Date of birth'),
        textField('dateOfDeath', 'Date of death'), textField('appearance', 'Appearance', { multiline: true, wide: true }),
        textField('features', 'Distinguishing features', { wide: true }), textField('history', 'History', { multiline: true, wide: true })));
  }

  function rituals() {
    if (!Array.isArray(data.rituals) || !data.rituals.length) {
      if (!editable) return null;
    }
    return listEditor('rituals', {
      title: 'Rituals and formulae', empty: 'None.', addLabel: '+ Ritual',
      blank: () => ({ name: '', level: 1, desc: '' }),
      renderRow: (r, i, save, remove) => el('div', { class: 'row' },
        bind(el('input', { value: r.name || '', placeholder: 'Ritual', 'aria-label': 'Ritual' }), r, 'name', save),
        bind(el('input', { type: 'number', min: 1, max: 5, value: r.level || 1, class: 'num', 'aria-label': 'Level' }), r, 'level', save, { number: true }),
        bind(el('input', { value: r.desc || '', placeholder: 'Notes', 'aria-label': 'Notes' }), r, 'desc', save),
        removeBtn(remove, 'ritual')),
    });
  }

  function draw() {
    const focused = node.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (focused) { deferred = true; return; }
    deferred = false;
    node.replaceChildren(...(opts.compact
      ? [trackers(), attributes(), skills(), disciplines()]
      : [identity(), attributes(), skills(), specialties(), trackers(), disciplines(), rituals(), advantages(), convictions(), experience(),
        section('Notes', textField('notes', 'Anything else worth remembering', { multiline: true, wide: true })), more()]).filter(Boolean));
  }
  let deferred = false;
  node.addEventListener('focusout', () => { if (deferred) setTimeout(() => { if (!node.contains(document.activeElement)) draw(); }, 0); });

  draw();
  return {
    node,
    get data() { return data; },
    update(next) { data = next; character.data = next; draw(); },
    redraw: draw,
    destroy() { flushAll(); },
  };
}
