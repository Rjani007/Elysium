// The one Supabase client. supabase-js is vendored (site/vendor/supabase.js, a UMD build)
// and loaded by index.html before the modules, so there is no build step.

import { config, configured } from '../config.js';

export { configured };

export const sb = configured
  ? window.supabase.createClient(config.url, config.key, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// Database errors arrive as "message" plus a Postgres code; the functions in
// supabase/migrations already write their messages for players.
function friendly(error) {
  const msg = String(error?.message || error || 'Something went wrong.');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return new Error('Could not reach the server. Check your connection and try again.');
  }
  if (/JWT expired|invalid JWT|not authenticated/i.test(msg)) return new Error('Your sign-in expired. Please sign in again.');
  if (error?.code === '42501' && /permission denied/i.test(msg)) return new Error("You don't have permission to do that.");
  if (error?.code === '23505') return new Error('That already exists.');
  return new Error(msg.charAt(0).toUpperCase() + msg.slice(1));
}

export async function call(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw friendly(error);
  return data;
}

/** Awaits a supabase-js query builder and returns its data, throwing a readable error. */
export async function q(builder) {
  const { data, error } = await builder;
  if (error) throw friendly(error);
  return data;
}

let me = null;
export function currentUser() { return me; }
export function setCurrentUser(user) { me = user; }

let offset = 0;
/** Milliseconds between this computer's clock and the database's (music sync uses it). */
export async function syncClock() {
  const t0 = Date.now();
  const server = await call('server_now');
  const t1 = Date.now();
  offset = server - (t0 + t1) / 2;
  return offset;
}
export const serverNow = () => Date.now() + offset;
