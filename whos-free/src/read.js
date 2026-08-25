// The read path. Builds the whole /api/state payload.

import { addDays, format, mondayIndex, parse, range } from '../public/shared/plainday.js';
import {
  PATTERN_KEYS, confirmedThrough, isStale, patternKey, slotsFor,
} from '../public/shared/tally.js';
import { CONFIG, HORIZON_DAYS } from './config.js';

/**
 * ASSUMED IS DERIVED, NEVER STORED.
 *
 * Nothing ever writes a mark row with source='PATTERN'. This function fills any
 * (person, day, slot) that has no row from that person's patterns row and tags
 * it "src":"PATTERN" IN THE RESPONSE ONLY.
 *
 * That is the mechanism that keeps "no row = not answered" true. If /setup
 * materialised rows for every future slot, the anti-join that finds silent
 * people would return nothing and the whole invariant would be unenforceable.
 *
 * A pattern value of null asserts NOTHING. It derives to "not answered", never
 * to assumed busy - inventing a BUSY claim from a blank toggle is the same
 * failure running in the other direction.
 */
export async function buildState(env, group, me, fromDay, toDay, today, nowMs) {
  const people = await env.DB.prepare(
    'SELECT id, name, colour_seed, active, last_seen_at FROM people WHERE group_slug = ?1 AND active = 1 ORDER BY created_at',
  ).bind(group.slug).all();
  const roster = (people.results || []).map((p) => ({
    id: p.id, name: p.name, colourSeed: p.colour_seed, lastSeenAt: p.last_seen_at,
  }));

  const markRows = await env.DB.prepare(
    'SELECT person_id, day, slot, state, source, updated_at FROM marks '
    + 'WHERE group_slug = ?1 AND day >= ?2 AND day <= ?3',
  ).bind(group.slug, fromDay, toDay).all();

  const patternRows = await env.DB.prepare(
    'SELECT person_id, json FROM patterns WHERE group_slug = ?1',
  ).bind(group.slug).all();

  const patterns = new Map();
  for (const row of (patternRows.results || [])) {
    try { patterns.set(row.person_id, JSON.parse(row.json)); } catch { /* ignore bad json */ }
  }

  const activeIds = new Set(roster.map((p) => p.id));

  // days -> slot -> personId -> { s, src, stale }
  const days = {};
  for (const day of range(fromDay, toDay)) {
    days[day] = {};
    for (const slot of slotsFor(day)) days[day][slot] = {};
  }

  for (const row of (markRows.results || [])) {
    if (!activeIds.has(row.person_id)) continue;      // soft-deleted: keep the row, ignore the person
    const dayObj = days[row.day];
    if (!dayObj || !dayObj[row.slot]) continue;       // a slot that no longer exists for that weekday
    dayObj[row.slot][row.person_id] = {
      s: row.state,
      src: row.source,
      stale: row.source === 'EXPLICIT'
        && isStale(row.updated_at, row.day, today, CONFIG, nowMs),
      at: row.updated_at,
    };
  }

  // Derive assumed values for every gap. Absence still means absence: a person
  // with no pattern value for that weekday+slot simply stays absent.
  for (const day of Object.keys(days)) {
    for (const slot of slotsFor(day)) {
      const key = patternKey(day, slot, mondayIndex);
      for (const person of roster) {
        if (days[day][slot][person.id]) continue;
        const pattern = patterns.get(person.id);
        if (!pattern) continue;
        const value = pattern[key];
        if (value === true) days[day][slot][person.id] = { s: 'FREE', src: 'PATTERN', stale: false };
        else if (value === false) days[day][slot][person.id] = { s: 'BUSY', src: 'PATTERN', stale: false };
        // null / undefined -> nothing. Not answered.
      }
    }
  }

  for (const person of roster) {
    person.confirmedThrough = confirmedThrough(days, person.id, today, HORIZON_DAYS);
    person.hasPattern = patterns.has(person.id);
  }

  const planRows = await env.DB.prepare(
    'SELECT id, day, slot, title, note, created_by, created_at FROM plans '
    + 'WHERE group_slug = ?1 AND deleted_at IS NULL AND day >= ?2 ORDER BY day, slot',
  ).bind(group.slug, today).all();

  return {
    today,
    from: fromDay,
    to: toDay,
    me,
    group: { name: group.name, quorum: group.quorum, slug: undefined },
    members: roster,
    days,
    plans: (planRows.results || []).map((p) => ({
      id: p.id, day: p.day, slot: p.slot, title: p.title, note: p.note, createdBy: p.created_by,
    })),
  };
}

/** The window a client asks for, clamped so nobody can ask for ten years. */
export function windowFor(today, fromParam, toParam) {
  const t = parse(today);
  const from = fromParam || format(t);
  const to = toParam || format(addDays(t, HORIZON_DAYS - 1));
  return { from, to };
}

/** The 11 pattern keys as a fresh all-null pattern. */
export function emptyPattern() {
  const out = {};
  for (const k of PATTERN_KEYS) out[k] = null;
  return out;
}
