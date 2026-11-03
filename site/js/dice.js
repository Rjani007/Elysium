// A roll in the feed: who, what, the dice, and the verdict the database worked out.
import { el, fmtTime } from './util.js';
import { OUTCOMES } from './v5.js';

function die(value, { hunger = false, selectable = false, selected = false, index = null } = {}) {
  const cls = ['die', hunger ? 'die-hunger' : 'die-regular',
    value >= 6 ? 'die-success' : 'die-fail', value === 10 ? 'die-ten' : '', hunger && value === 1 ? 'die-beast' : '',
    selectable ? 'die-selectable' : '', selected ? 'die-selected' : ''].filter(Boolean).join(' ');
  const label = `${hunger ? 'Hunger die' : 'Die'} ${value}${value === 10 ? ' (ten)' : value >= 6 ? ' (success)' : hunger && value === 1 ? ' (the Beast)' : ''}`;
  return el(selectable ? 'button' : 'span', { class: cls, 'aria-label': label, 'aria-pressed': selectable ? String(selected) : null, dataset: index != null ? { i: index } : {}, type: selectable ? 'button' : null },
    el('span', { class: 'die-face' }, hunger && value === 1 ? '☠' : value === 10 ? '10' : String(value)));
}

function verdict(roll) {
  if (roll.kind === 'rouse' || roll.kind === 'remorse') {
    const o = OUTCOMES[roll.outcome] || { text: roll.outcome, tone: 'plain' };
    return el('div', { class: `verdict tone-${o.tone}` }, el('strong', {}, o.text), roll.effect ? el('span', { class: 'effect' }, roll.effect) : null);
  }
  const o = OUTCOMES[roll.outcome] || { text: roll.outcome, tone: 'plain' };
  const count = `${roll.successes} success${roll.successes === 1 ? '' : 'es'}`;
  const notes = [];
  if (roll.difficulty == null) {
    if (roll.flags?.includes('bestial_risk') && roll.successes > 0) notes.push('a Hunger 1: bestial if this falls short');
    if (roll.flags?.includes('messy') && roll.outcome !== 'messy_critical') notes.push('messy if this wins');
  } else {
    const margin = roll.successes - roll.difficulty;
    notes.push(`Difficulty ${roll.difficulty}${margin >= 0 ? `, margin ${margin}` : ''}`);
  }
  return el('div', { class: `verdict tone-${o.tone}` },
    o.text ? el('strong', {}, o.text) : null,
    el('span', { class: 'count' }, count),
    notes.length ? el('span', { class: 'effect' }, notes.join(' · ')) : null,
    roll.effect ? el('span', { class: 'effect' }, roll.effect) : null);
}

/**
 * opts: { me, isST, rerollSelection: Set|null, onStartReroll, onToggleDie, onConfirmReroll, onCancelReroll, onDifficulty, fresh }
 */
export function rollCard(roll, opts = {}) {
  const mine = roll.user_id === opts.me;
  const selecting = opts.rerollSelection && opts.rerollFor === roll.id;
  // free storyteller dice have no Willpower to spend; characters and NPCs do
  const canReroll = mine && roll.kind === 'pool' && !roll.rerolled && roll.regular.length > 0 && (roll.character_id || roll.npc_id);
  const regular = roll.regular.map((v, i) => die(v, {
    selectable: selecting, selected: selecting && opts.rerollSelection.has(i + 1), index: i + 1,
  }));
  const hunger = roll.hunger_dice.map((v) => die(v, { hunger: true }));
  const parts = (roll.parts || []).filter((p) => typeof p.value === 'number')
    .map((p) => `${p.name} ${p.value > 0 && p.name === 'Modifier' ? '+' : ''}${p.value}`).join(' · ');

  const card = el('article', {
    class: `roll kind-${roll.kind}${roll.private ? ' roll-private' : ''}${roll.rerolled ? ' roll-superseded' : ''}${opts.fresh ? ' roll-fresh' : ''}`,
    'aria-label': `${roll.who}: ${roll.label}`,
  },
  el('header', { class: 'roll-head' },
    el('span', { class: 'roll-who' }, roll.who),
    el('span', { class: 'roll-label' }, roll.kind === 'reroll' ? `${roll.label} · Willpower re-roll` : roll.label),
    roll.private ? el('span', { class: 'chip chip-private', title: 'Only the roller and the storytellers see this' }, '🔒 private') : null,
    el('time', { class: 'roll-time', datetime: roll.created_at }, fmtTime(roll.created_at))),
  el('div', { class: 'dice-row' }, regular, hunger.length ? el('span', { class: 'dice-split', 'aria-hidden': 'true' }) : null, hunger),
  parts && roll.kind !== 'rouse' ? el('div', { class: 'roll-parts' }, parts) : null,
  verdict(roll));

  if (selecting) {
    card.querySelector('.dice-row').addEventListener('click', (e) => {
      const i = Number(e.target.closest('[data-i]')?.dataset.i);
      if (i) opts.onToggleDie?.(roll, i);
    });
  }

  const actions = el('div', { class: 'roll-actions' });
  if (roll.rerolled) actions.append(el('span', { class: 'muted small' }, 'Re-rolled with Willpower ↓'));
  else if (selecting) {
    const n = opts.rerollSelection.size;
    actions.append(
      el('span', { class: 'small' }, n ? `Re-roll ${n} ${n === 1 ? 'die' : 'dice'} for 1 Willpower?` : 'Pick up to three regular dice.'),
      el('button', { class: 'btn btn-small btn-primary', disabled: !n, onclick: () => opts.onConfirmReroll?.(roll) }, 'Re-roll'),
      el('button', { class: 'btn btn-small', onclick: () => opts.onCancelReroll?.() }, 'Cancel'));
  } else if (canReroll) {
    actions.append(el('button', { class: 'btn btn-small', onclick: () => opts.onStartReroll?.(roll) }, '🗘 Spend Willpower to re-roll'));
  }
  if (opts.isST && ['pool', 'reroll', 'tracker'].includes(roll.kind) && !roll.rerolled) {
    const input = el('input', { type: 'number', min: 1, max: 15, value: roll.difficulty ?? '', placeholder: '–', class: 'num', 'aria-label': 'Difficulty' });
    input.addEventListener('change', () => opts.onDifficulty?.(roll, input.value === '' ? null : Number(input.value)));
    actions.append(el('label', { class: 'difficulty small' }, 'Difficulty', input));
  }
  if (actions.childNodes.length) card.append(actions);
  return card;
}
