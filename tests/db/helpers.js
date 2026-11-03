// Shared setup for tests that run against the local Supabase stack (npm run db:start).
// Every test creates its own throwaway users and chronicle, so tests never share state.

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = fileURLToPath(new URL('../..', import.meta.url));
let env = null;

export function localEnv() {
  if (env) return env;
  let out;
  try {
    out = execSync('npx supabase status -o json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('The local Supabase stack is not running. Start it with: npm run db:start');
  }
  const status = JSON.parse(out.slice(out.indexOf('{')));
  env = { url: status.API_URL, anon: status.PUBLISHABLE_KEY || status.ANON_KEY, service: status.SERVICE_ROLE_KEY };
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.url)) throw new Error(`Refusing to run tests against ${env.url}`);
  return env;
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
export const adminClient = () => createClient(localEnv().url, localEnv().service, options);

export async function newUser(name) {
  const tag = randomBytes(4).toString('hex');
  const email = `${name.toLowerCase().replace(/\W+/g, '')}-${tag}@example.test`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await adminClient().auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { display_name: name },
  });
  if (error) throw error;
  const client = createClient(localEnv().url, localEnv().anon, options);
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { id: data.user.id, name, client };
}

export async function rpc(user, fn, args = {}) {
  const { data, error } = await user.client.rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { code: error.code });
  return data;
}

/** Resolves to the error a promise (or supabase-js { error } result) produced; fails if it didn't. */
export async function refused(promise, pattern) {
  let err = null;
  try {
    const res = await promise;
    err = res?.error ?? null;
    if (!err) throw Object.assign(new Error('expected a refusal, got success'), { success: true, res });
  } catch (e) {
    if (e.success) throw e;
    err = err || e;
  }
  if (pattern && !pattern.test(`${err.message} ${err.code ?? ''}`)) {
    throw new Error(`refused for the wrong reason: ${err.message} (${err.code})`);
  }
  return err;
}

export async function rows(user, table, query = (q) => q) {
  const { data, error } = await query(user.client.from(table).select('*'));
  if (error) throw error;
  return data;
}

/** A storyteller with a chronicle, plus players seated at its main table. */
export async function chronicleWith(playerNames = ['Ana']) {
  const st = await newUser('Storyteller');
  const chronicle = await rpc(st, 'create_chronicle', { p_name: 'Test Chronicle' });
  const [table] = await rows(st, 'game_tables', (q) => q.eq('chronicle_id', chronicle));
  const [invite] = await rows(st, 'table_invites', (q) => q.eq('table_id', table.id));
  const players = [];
  for (const name of playerNames) {
    const p = await newUser(name);
    await rpc(p, 'join_table', { p_code: invite.code });
    players.push(p);
  }
  return { st, chronicle, table: table.id, code: invite.code, players };
}

export const sheet = (overrides = {}) => ({
  clan: 'Brujah', generation: 13, bloodPotency: 1, hunger: 2, humanity: 7, stains: 0,
  attributes: { strength: 3, dexterity: 2, stamina: 2, charisma: 2, manipulation: 2, composure: 2, intelligence: 2, wits: 3, resolve: 2 },
  skills: { Brawl: 3, Firearms: 1, Awareness: 2, Intimidation: 2 },
  disciplines: [{ name: 'Potence', rating: 2, powers: [] }, { name: 'Celerity', rating: 1, powers: [] }],
  specialties: [{ skill: 'Brawl', name: 'Grappling' }],
  health: { superficial: 0, aggravated: 0 }, willpower: { superficial: 0, aggravated: 0 },
  ...overrides,
});

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
