// tally.js - buckets, bands, quorum, coverage.
//
// THE ONE RULE: "not answered" is never rendered, counted, or reasoned about as
// "free". An absent entry means silence. Every function here treats absence as
// its own bucket and the bucket counts always partition the active roster, so
// `free` can never quietly absorb a silence, a guess, or a stale answer.

import { addDays, compare, diffDays, format, formatShort, isWeekend, parse, range } from './plainday.js';

export const MORNING = 'MORNING';
export const AFTERNOON = 'AFTERNOON';
export const EVENING = 'EVENING';

export const WEEKDAY_SLOTS = [EVENING];
export const WEEKEND_SLOTS = [MORNING, AFTERNOON, EVENING];

export const FREE = 'FREE';
export const MAYBE = 'MAYBE';
export const BUSY = 'BUSY';

/** Weekdays are evening-only. Nobody is free on a Tuesday morning. */
export function slotsFor(day) {
  return isWeekend(typeof day === 'string' ? parse(day) : day) ? WEEKEND_SLOTS : WEEKDAY_SLOTS;
}

export function slotLabel(slot) {
  return slot === MORNING ? 'morning' : slot === AFTERNOON ? 'afternoon' : 'evening';
}

// The six buckets, in the canonical print order.
export const BUCKETS = ['free', 'maybe', 'busy', 'assumed', 'stale', 'notAnswered'];

/**
 * Bucket one slot.
 *
 * `entries` is { personId: { s, src, stale } } exactly as it arrives on the wire.
 * A person absent from `entries` has not answered. `roster` is the list of
 * ACTIVE people; anyone not in it is ignored entirely (soft-deleted people keep
 * their marks so history stays intact, but they are not part of any count).
 *
 * Precedence is deliberate and load-bearing:
 *   no entry        -> notAnswered   (silence, always its own bucket)
 *   src === PATTERN -> assumed       (a prior, never a promise; never stale)
 *   stale === true  -> stale         (confirmed once, probably out of date)
 *   otherwise       -> free | maybe | busy
 *
 * So an assumed FREE lands in `assumed`, a stale FREE lands in `stale`, and
 * `free` only ever contains people who said so recently and explicitly.
 */
export function tally(entries, roster) {
  const by = { free: [], maybe: [], busy: [], assumed: [], stale: [], notAnswered: [] };
  const direction = {}; // personId -> FREE|MAYBE|BUSY, for assumed/stale glyphs

  for (const person of roster) {
    const id = typeof person === 'string' ? person : person.id;
    const e = entries ? entries[id] : undefined;
    if (!e || !e.s) { by.notAnswered.push(id); continue; }
    direction[id] = e.s;
    if (e.src === 'PATTERN') by.assumed.push(id);
    else if (e.stale) by.stale.push(id);
    else if (e.s === FREE) by.free.push(id);
    else if (e.s === MAYBE) by.maybe.push(id);
    else by.busy.push(id);
  }

  const counts = {};
  for (const b of BUCKETS) counts[b] = by[b].length;
  return { ...counts, by, direction };
}

/**
 * "5 free · 2 maybe · 1 busy · 0 not answered"
 * Zero buckets are dropped EXCEPT "not answered", which always prints, because
 * its presence is the entire point. Never a bare "4/6 free" - that is a lie
 * when two of the six are silent.
 */
export function formatTally(t) {
  const parts = [];
  if (t.free) parts.push(`${t.free} free`);
  if (t.maybe) parts.push(`${t.maybe} maybe`);
  if (t.busy) parts.push(`${t.busy} busy`);
  if (t.assumed) parts.push(`${t.assumed} assumed`);
  if (t.stale) parts.push(`${t.stale} stale`);
  parts.push(`${t.notAnswered} not answered`);
  return parts.join(' · ');
}

const nameOf = (roster, id) => {
  const p = roster.find((r) => (typeof r === 'string' ? r : r.id) === id);
  return p ? (typeof p === 'string' ? p : p.name) : id;
};

/** "Kit, Jo" - an Oxford-comma-free list, or "" for none. */
export function names(roster, ids) {
  return ids.map((id) => nameOf(roster, id)).join(', ');
}

/**
 * Everyone who is not a definite free: the actionable "missing" list. In a group
 * of 7, "6 free" is only useful if you know it is Kit.
 */
export function missing(t) {
  return [...t.by.busy, ...t.by.maybe, ...t.by.assumed, ...t.by.stale, ...t.by.notAnswered];
}

/**
 * Is this EXPLICIT mark stale?
 *
 * Stale = confirmed more than STALE_AFTER_DAYS ago AND about a day more than
 * STALE_HORIZON_DAYS in the future. An answer about tomorrow given three weeks
 * ago is probably still fine; an answer about six weeks out given three weeks
 * ago is a guess. Stale degrades towards "not answered", never towards "free".
 *
 * nowMs is a genuine instant (server Date.now()). today is a plain day supplied
 * by the client. The two are never mixed - one measures the age of the answer,
 * the other measures how far away the day is.
 */
export function isStale(updatedAtMs, day, today, cfg, nowMs) {
  const ageDays = (nowMs - updatedAtMs) / 86400000;
  if (ageDays <= cfg.STALE_AFTER_DAYS) return false;
  return diffDays(parse(today), parse(day)) > cfg.STALE_HORIZON_DAYS;
}

/**
 * The latest date D such that EVERY slot from today through D has an EXPLICIT,
 * non-stale mark for this person. A gap ends the run - one mark six weeks out
 * does not make someone confirmed. Returns null if today itself is incomplete.
 */
export function confirmedThrough(days, personId, today, horizonDays) {
  let last = null;
  for (let i = 0; i < horizonDays; i += 1) {
    const key = format(addDays(parse(today), i));
    const dayData = days[key];
    if (!dayData) break;
    let complete = true;
    for (const slot of slotsFor(key)) {
      const e = dayData[slot] ? dayData[slot][personId] : undefined;
      if (!e || !e.s || e.src === 'PATTERN' || e.stale) { complete = false; break; }
    }
    if (!complete) break;
    last = key;
  }
  return last;
}

/** Every (day, slot) pair in the window, in calendar order. */
export function enumerateSlots(fromDay, toDay) {
  const out = [];
  for (const day of range(fromDay, toDay)) {
    for (const slot of slotsFor(day)) out.push({ day, slot });
  }
  return out;
}

/**
 * The banded readout (section 6.3).
 *
 * Bands are keyed on the DEFINITE free count and nothing else. Maybes are
 * annotated on a row but never move it into a higher band - MAYBE exists so
 * that answering does not require committing, which is what gets the quieter
 * people to answer at all, but it must never inflate the number you would plan
 * around.
 *
 * Returns { bands, maybeDependent, closest, allEmpty }.
 */
export function buildBands(days, roster, quorum, fromDay, toDay, capPerBand = 5) {
  const rows = [];
  for (const { day, slot } of enumerateSlots(fromDay, toDay)) {
    const entries = days[day] && days[day][slot] ? days[day][slot] : {};
    const t = tally(entries, roster);
    rows.push({ day, slot, t, free: t.free, maybe: t.maybe, notAnswered: t.notAnswered });
  }

  // Highest headcount first, one section per distinct count, empties never
  // printed because a band with no rows simply never gets created.
  const byCount = new Map();
  for (const row of rows) {
    if (row.free < quorum) continue;
    if (!byCount.has(row.free)) byCount.set(row.free, []);
    byCount.get(row.free).push(row);
  }

  const bands = [...byCount.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([count, list]) => {
      list.sort((a, b) => (b.maybe - a.maybe)
        || (a.notAnswered - b.notAnswered)
        || compare(a.day, b.day));
      return {
        count,
        label: count === roster.length ? `All ${count} free` : `${count} free`,
        everyone: count === roster.length && count > 0,
        maybeTotal: list.reduce((n, r) => n + r.maybe, 0),
        rows: list.slice(0, capPerBand),
        hidden: Math.max(0, list.length - capPerBand),
        allRows: list,
      };
    });

  // "Could work if the maybes are in" - one message in the chat converts these
  // from a non-plan into a plan. This section is the entire reason MAYBE exists.
  const maybeDependent = rows
    .filter((r) => r.free < quorum && r.free + r.maybe >= quorum)
    .sort((a, b) => (b.free + b.maybe) - (a.free + a.maybe)
      || (b.maybe - a.maybe)
      || compare(a.day, b.day));

  // Never an empty screen.
  const closest = bands.length === 0 && maybeDependent.length === 0
    ? [...rows].sort((a, b) => (b.free - a.free)
      || (b.maybe - a.maybe)
      || (a.notAnswered - b.notAnswered)
      || compare(a.day, b.day)).slice(0, 3)
    : [];

  return { bands, maybeDependent, closest, allEmpty: rows.length === 0 };
}

/** "Sat 10 Oct · afternoon" */
export function slotTitle(day, slot) {
  return `${formatShort(day)} · ${slotLabel(slot)}`;
}

/** The next N slots where this person is explicitly FREE - the quick-change strip. */
export function myFreeSlots(days, personId, today, limit, horizonDays) {
  const out = [];
  for (let i = 0; i < horizonDays && out.length < limit; i += 1) {
    const day = format(addDays(parse(today), i));
    for (const slot of slotsFor(day)) {
      const e = days[day] && days[day][slot] ? days[day][slot][personId] : undefined;
      if (e && e.s === FREE && e.src === 'EXPLICIT' && !e.stale) {
        out.push({ day, slot });
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/** The 11 pattern keys, in screen order. */
export const PATTERN_KEYS = [
  'MON_EVENING', 'TUE_EVENING', 'WED_EVENING', 'THU_EVENING', 'FRI_EVENING',
  'SAT_MORNING', 'SAT_AFTERNOON', 'SAT_EVENING',
  'SUN_MORNING', 'SUN_AFTERNOON', 'SUN_EVENING',
];

const DAY_PREFIX = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/** The pattern key a (day, slot) maps to, e.g. 2026-10-10 EVENING -> SAT_EVENING. */
export function patternKey(day, slot, mondayIndexFn) {
  return `${DAY_PREFIX[mondayIndexFn(parse(day))]}_${slot}`;
}

/** Exactly the 11 keys, each true | false | null. Anything else is rejected. */
export function validatePattern(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of PATTERN_KEYS) {
    const v = input[k];
    if (v === true || v === false) out[k] = v;
    else if (v === null || v === undefined) out[k] = null;
    else return null;
  }
  return out;
}
