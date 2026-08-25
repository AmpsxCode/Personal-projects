// The write path. Every mutation: guard the opId, do the work, bump the
// version, prune, all in ONE batch() so it is atomic and one round trip.

import { addDays, format, parse } from '../public/shared/plainday.js';
import { slotsFor, validatePattern } from '../public/shared/tally.js';
import { CONFIG } from './config.js';
import { bumpVersion, pruneOpsStatement } from './bootstrap.js';

const STATES = new Set(['FREE', 'MAYBE', 'BUSY']);
const SLOTS = new Set(['MORNING', 'AFTERNOON', 'EVENING']);

export function validState(s) { return s === null || STATES.has(s); }
export function validSlot(s) { return SLOTS.has(s); }

/**
 * Has this opId already been applied? Returns the cached response body if so.
 *
 * A replayed offline queue must not double-apply, and it must not get a
 * DIFFERENT answer than it got the first time either - so we cache the response
 * and hand back the same one.
 */
export async function seenOp(db, opId) {
  if (!opId) return null;
  const row = await db.prepare('SELECT response FROM ops WHERE op_id = ?1').bind(opId).first();
  if (!row) return null;
  try { return row.response ? JSON.parse(row.response) : { ok: true, replayed: true }; }
  catch { return { ok: true, replayed: true }; }
}

export function recordOpStatement(db, opId, personId, nowMs, response) {
  return db.prepare(
    'INSERT INTO ops (op_id, person_id, created_at, response) VALUES (?1, ?2, ?3, ?4) '
    + 'ON CONFLICT(op_id) DO NOTHING',
  ).bind(opId, personId, nowMs, JSON.stringify(response || null));
}

/**
 * One mark. state === null DELETES the row - we never write 'UNKNOWN'.
 * updated_at is stamped HERE, on the server. Never from a client clock: one
 * friend with a phone a day fast would win every conflict forever.
 */
export function markStatements(db, slug, personId, day, slot, state, nowMs) {
  if (state === null) {
    return [db.prepare(
      'DELETE FROM marks WHERE group_slug = ?1 AND person_id = ?2 AND day = ?3 AND slot = ?4',
    ).bind(slug, personId, day, slot)];
  }
  return [db.prepare(
    'INSERT INTO marks (group_slug, person_id, day, slot, state, source, updated_at) '
    + "VALUES (?1, ?2, ?3, ?4, ?5, 'EXPLICIT', ?6) "
    + 'ON CONFLICT(group_slug, person_id, day, slot) '
    + "DO UPDATE SET state = ?5, source = 'EXPLICIT', updated_at = ?6",
  ).bind(slug, personId, day, slot, state, nowMs)];
}

/**
 * What the caller's marks currently are for these keys, so a bulk response can
 * carry the previous values and undo becomes a client-driven replay with no
 * server-side undo token.
 *
 * Chunked: D1 caps bound parameters at EXACTLY 100 per statement, and this
 * query spends 2 on the slug and person plus 1 per day.
 */
export async function previousMarks(db, slug, personId, keys) {
  const byDay = new Map();
  for (const k of keys) {
    if (!byDay.has(k.day)) byDay.set(k.day, []);
    byDay.get(k.day).push(k.slot);
  }
  const days = [...byDay.keys()];
  const out = new Map();
  const CHUNK = 90; // 90 days + 2 fixed params, comfortably under 100
  for (let i = 0; i < days.length; i += CHUNK) {
    const slice = days.slice(i, i + CHUNK);
    const placeholders = slice.map((_, n) => `?${n + 3}`).join(',');
    const rows = await db.prepare(
      `SELECT day, slot, state FROM marks WHERE group_slug = ?1 AND person_id = ?2 AND day IN (${placeholders})`,
    ).bind(slug, personId, ...slice).all();
    for (const r of (rows.results || [])) out.set(`${r.day}|${r.slot}`, r.state);
  }
  return out;
}

/**
 * Expand a bulk selection into the (day, slot) pairs that actually exist.
 *
 * "Apply to: all slots" on a weekday means the evening, because that is the
 * only slot a weekday has. Asking about Tuesday morning is noise, and writing
 * a row for it would be a lie about a slot the UI never shows.
 */
export function expandBulk(days, slots, eveningsOnly) {
  const wanted = eveningsOnly ? ['EVENING'] : (slots && slots.length ? slots : null);
  const out = [];
  for (const day of days) {
    for (const slot of slotsFor(day)) {
      if (wanted && !wanted.includes(slot)) continue;
      out.push({ day, slot });
    }
  }
  return out;
}

/**
 * Statements for a bulk write.
 *
 * ONE PREPARED STATEMENT PER ROW, not one multi-row INSERT. A 14-day confirm is
 * up to 22 slots x 6 columns = 132 bound parameters and would fail as a single
 * statement against D1's hard cap of 100. batch() has no documented limit on
 * the number of statements, and each gets its own parameter budget.
 */
export function bulkStatements(db, slug, personId, keys, state, nowMs) {
  const out = [];
  for (const { day, slot } of keys) {
    out.push(...markStatements(db, slug, personId, day, slot, state, nowMs));
  }
  return out;
}

export function patternStatement(db, slug, personId, pattern, nowMs) {
  const clean = validatePattern(pattern);
  if (!clean) return null;
  return db.prepare(
    'INSERT INTO patterns (person_id, group_slug, json, updated_at) VALUES (?1, ?2, ?3, ?4) '
    + 'ON CONFLICT(person_id) DO UPDATE SET json = ?3, updated_at = ?4',
  ).bind(personId, slug, JSON.stringify(clean), nowMs);
}

/**
 * Wrap a set of statements with the version bump, the opId record and the
 * prune, and run them as one atomic batch.
 */
export async function commit(env, slug, statements, opId, personId, nowMs, response) {
  const all = [...statements, bumpVersion(env.DB, slug)];
  if (opId) all.push(recordOpStatement(env.DB, opId, personId, nowMs, response));
  all.push(pruneOpsStatement(env.DB, nowMs));
  await env.DB.batch(all);
}

export function confirmWindow(today) {
  const t = parse(today);
  return { from: format(t), to: format(addDays(t, CONFIG.CONFIRM_DAYS - 1)) };
}
