// Who an NPC or handout has been revealed to, and the storyteller's controls for it.
import { sb, q, currentUser } from './supa.js';
import { el, fail, toast } from './util.js';

/**
 * ctx: { chronicle, tables: [{id,name}], members: [{user_id, display_name, role}] }
 * item: { kind: 'npc'|'handout', id }
 * reveals: the reveal rows for this item
 */
export function revealControl(ctx, item, reveals, onChange) {
  const column = item.kind === 'npc' ? 'npc_id' : 'handout_id';
  const tableName = (id) => ctx.tables.find((t) => t.id === id)?.name || 'a table';
  const memberName = (id) => ctx.members.find((m) => m.user_id === id)?.display_name || 'a player';

  const chips = reveals.map((r) => el('span', { class: 'chip' },
    r.table_id ? `👁 ${tableName(r.table_id)}` : `👤 ${memberName(r.user_id)}`,
    el('button', {
      class: 'chip-x', title: 'Hide it again', 'aria-label': 'Hide it again',
      onclick: async () => {
        try { await q(sb.from('reveals').delete().eq('id', r.id)); onChange?.(); } catch (err) { fail(err); }
      },
    }, '✕')));

  const targets = [
    ...ctx.tables.filter((t) => !reveals.some((r) => r.table_id === t.id)).map((t) => ({ value: `t:${t.id}`, label: `Everyone at ${t.name}` })),
    ...ctx.members.filter((m) => m.role === 'player' && !reveals.some((r) => r.user_id === m.user_id))
      .map((m) => ({ value: `u:${m.user_id}`, label: `Only ${m.display_name}` })),
  ];
  const select = el('select', { 'aria-label': 'Reveal to' },
    el('option', { value: '' }, '👁 Reveal to…'),
    targets.map((t) => el('option', { value: t.value }, t.label)));
  select.addEventListener('change', async () => {
    const [kind, id] = select.value.split(':');
    select.value = '';
    if (!id) return;
    try {
      await q(sb.from('reveals').insert({
        chronicle_id: ctx.chronicle, [column]: item.id, revealed_by: currentUser().id,
        ...(kind === 't' ? { table_id: id } : { user_id: id }),
      }));
      toast(kind === 't' ? `Revealed to everyone at ${tableName(id)}.` : `Revealed to ${memberName(id)}.`);
      onChange?.();
    } catch (err) { fail(err); }
  });
  return el('div', { class: 'reveal-row' },
    chips.length ? chips : el('span', { class: 'muted small' }, '🔒 Hidden from players'),
    targets.length ? select : null);
}

/** Every reveal in a chronicle, grouped by item id. Storytellers only (RLS returns theirs). */
export async function revealsByItem(chronicle) {
  const rows = await q(sb.from('reveals').select('*').eq('chronicle_id', chronicle));
  const map = new Map();
  for (const r of rows) {
    const key = r.npc_id || r.handout_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}
