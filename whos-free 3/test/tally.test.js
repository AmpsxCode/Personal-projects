// The one rule, mechanised.
//
// "not answered" must never be rendered, counted, or reasoned about as "free".
// Everything here exists to make that unenforceable by accident.

import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, format, parse, range } from '../public/shared/plainday.js';
import {
  BUCKETS, buildBands, confirmedThrough, enumerateSlots, formatTally, isStale,
  missing, myFreeSlots, names, slotsFor, tally, validatePattern,
} from '../public/shared/tally.js';
import { CONFIG } from '../public/shared/config.js';

const R = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
const seven = R(7);
const E = (s, src = 'EXPLICIT', stale = false) => ({ s, src, stale });

test('an empty slot is all not-answered, and zero free', () => {
  const t = tally({}, seven);
  assert.equal(t.free, 0);
  assert.equal(t.notAnswered, 7);
  assert.equal(formatTally(t), '7 not answered');
});

test('a person who has never opened the app is never free, in any bucket', () => {
  const t = tally({ p0: E('FREE'), p1: E('BUSY') }, seven);
  assert.equal(t.free, 1);
  assert.equal(t.busy, 1);
  assert.equal(t.notAnswered, 5);
  assert.ok(!t.by.free.includes('p2'));
  assert.ok(t.by.notAnswered.includes('p2'));
});

test('the buckets always partition the active roster', () => {
  const cases = [
    {},
    { p0: E('FREE') },
    { p0: E('FREE'), p1: E('MAYBE'), p2: E('BUSY'), p3: E('FREE', 'PATTERN'), p4: E('FREE', 'EXPLICIT', true) },
    Object.fromEntries(seven.map((p, i) => [p.id, E(['FREE', 'MAYBE', 'BUSY'][i % 3])])),
  ];
  for (const entries of cases) {
    const t = tally(entries, seven);
    const sum = BUCKETS.reduce((n, b) => n + t[b], 0);
    assert.equal(sum, seven.length, `buckets summed to ${sum}, roster is ${seven.length}`);
  }
});

test('entries for inactive people are ignored entirely', () => {
  const t = tally({ p0: E('FREE'), pGONE: E('FREE') }, seven);
  assert.equal(t.free, 1);
  assert.equal(BUCKETS.reduce((n, b) => n + t[b], 0), 7);
});

test('assumed and stale are counted separately, never folded into free', () => {
  const t = tally({
    p0: E('FREE'), p1: E('FREE', 'PATTERN'), p2: E('FREE', 'EXPLICIT', true),
    p3: E('BUSY', 'PATTERN'), p4: E('MAYBE', 'EXPLICIT', true),
  }, seven);
  assert.equal(t.free, 1, 'only the explicit, fresh FREE counts as free');
  assert.equal(t.assumed, 2);
  assert.equal(t.stale, 2);
  assert.equal(t.notAnswered, 2);
  assert.equal(formatTally(t), '1 free · 2 assumed · 2 stale · 2 not answered');
});

test('a PATTERN entry is assumed even when it is also old - never stale', () => {
  const t = tally({ p0: E('FREE', 'PATTERN', true) }, seven);
  assert.equal(t.assumed, 1);
  assert.equal(t.stale, 0);
});

test('the tally never prints a bare fraction, and always prints not-answered', () => {
  const all = Object.fromEntries(seven.map((p) => [p.id, E('FREE')]));
  const t = tally(all, seven);
  assert.equal(formatTally(t), '7 free · 0 not answered');
  assert.ok(!formatTally(t).includes('/'));
});

test('missing names everyone who is not a definite free', () => {
  const t = tally({ p0: E('FREE'), p1: E('MAYBE'), p2: E('BUSY'), p3: E('FREE', 'PATTERN') }, seven);
  const miss = missing(t);
  assert.equal(miss.length, 6);
  assert.ok(!miss.includes('p0'));
  assert.equal(names(seven, ['p1', 'p2']), 'P1, P2');
});

// ------------------------------------------------------------------- bands ---

function grid(spec, from, to) {
  const days = {};
  for (const day of range(from, to)) {
    days[day] = {};
    for (const slot of slotsFor(day)) days[day][slot] = (spec[`${day}|${slot}`]) || {};
  }
  return days;
}

test('bands key on definite frees only - maybes never lift a slot into a band', () => {
  const from = '2026-10-05', to = '2026-10-11';
  const days = grid({
    // 3 free + 3 maybe = 6, but the band is 3, which is below a quorum of 4.
    '2026-10-10|AFTERNOON': {
      p0: E('FREE'), p1: E('FREE'), p2: E('FREE'),
      p3: E('MAYBE'), p4: E('MAYBE'), p5: E('MAYBE'),
    },
    '2026-10-10|EVENING': {
      p0: E('FREE'), p1: E('FREE'), p2: E('FREE'), p3: E('FREE'), p4: E('FREE'),
    },
  }, from, to);
  const { bands, maybeDependent } = buildBands(days, seven, 4, from, to);
  assert.deepEqual(bands.map((b) => b.count), [5], 'only the 5-free slot gets a band');
  assert.ok(bands[0].rows.every((r) => r.free >= 4));
  // The 3+3 slot lands in the maybe-dependent section instead.
  const dep = maybeDependent.find((r) => r.slot === 'AFTERNOON' && r.day === '2026-10-10');
  assert.ok(dep, 'the 3 free + 3 maybe slot must appear under "could work if the maybes are in"');
  assert.equal(dep.free, 3);
  assert.equal(dep.maybe, 3);
});

test('empty bands are never produced at all', () => {
  const from = '2026-10-05', to = '2026-10-11';
  const days = grid({
    '2026-10-10|EVENING': Object.fromEntries(seven.map((p) => [p.id, E('FREE')])),
  }, from, to);
  const { bands } = buildBands(days, seven, 4, from, to);
  assert.deepEqual(bands.map((b) => b.count), [7]);
  assert.equal(bands[0].label, 'All 7 free');
  assert.equal(bands[0].everyone, true);
  assert.ok(bands.every((b) => b.rows.length > 0));
});

test('bands are ordered highest first and sorted within by maybe, silence, then date', () => {
  const from = '2026-10-05', to = '2026-10-25';
  const days = grid({
    '2026-10-10|EVENING': { p0: E('FREE'), p1: E('FREE'), p2: E('FREE'), p3: E('FREE') },
    '2026-10-17|EVENING': {
      p0: E('FREE'), p1: E('FREE'), p2: E('FREE'), p3: E('FREE'), p4: E('MAYBE'), p5: E('BUSY'), p6: E('BUSY'),
    },
    '2026-10-24|EVENING': {
      p0: E('FREE'), p1: E('FREE'), p2: E('FREE'), p3: E('FREE'), p4: E('FREE'),
    },
  }, from, to);
  const { bands } = buildBands(days, seven, 4, from, to);
  assert.deepEqual(bands.map((b) => b.count), [5, 4]);
  // Within the 4-band, the row with a maybe sorts first even though it is later.
  assert.equal(bands[1].rows[0].day, '2026-10-17');
  assert.equal(bands[1].maybeTotal, 1);
});

test('when nothing reaches quorum and no maybes help, the closest three are offered', () => {
  const from = '2026-10-05', to = '2026-10-18';
  const days = grid({
    '2026-10-10|EVENING': { p0: E('FREE'), p1: E('FREE') },
    '2026-10-11|EVENING': { p0: E('FREE') },
  }, from, to);
  const { bands, maybeDependent, closest } = buildBands(days, seven, 4, from, to);
  assert.equal(bands.length, 0);
  assert.equal(maybeDependent.length, 0);
  assert.equal(closest.length, 3, 'never an empty screen');
  assert.equal(closest[0].day, '2026-10-10');
  assert.equal(closest[0].free, 2);
});

test('bands cap at five rows and report how many are hidden', () => {
  const from = '2026-10-01', to = '2026-11-30';
  const spec = {};
  for (const day of range(from, to)) {
    for (const slot of slotsFor(day)) {
      spec[`${day}|${slot}`] = { p0: E('FREE'), p1: E('FREE'), p2: E('FREE'), p3: E('FREE') };
    }
  }
  const { bands } = buildBands(grid(spec, from, to), seven, 4, from, to, 5);
  assert.equal(bands[0].rows.length, 5);
  assert.ok(bands[0].hidden > 50);
  assert.equal(bands[0].rows.length + bands[0].hidden, bands[0].allRows.length);
});

// ------------------------------------------------------- staleness + coverage --

test('staleness needs BOTH an old answer and a distant day', () => {
  const now = 1_800_000_000_000;
  const old = now - 20 * 86400000;   // 20 days ago
  const fresh = now - 2 * 86400000;
  const today = '2026-10-01';
  // Old answer about a distant day: stale.
  assert.equal(isStale(old, '2026-11-15', today, CONFIG, now), true);
  // Old answer about tomorrow: still fine.
  assert.equal(isStale(old, '2026-10-02', today, CONFIG, now), false);
  // Fresh answer about a distant day: fine.
  assert.equal(isStale(fresh, '2026-11-15', today, CONFIG, now), false);
  // Exactly on the horizon boundary is not yet stale.
  assert.equal(isStale(old, format(addDays(parse(today), CONFIG.STALE_HORIZON_DAYS)), today, CONFIG, now), false);
});

test('confirmed_through stops at the first gap', () => {
  const today = '2026-10-05';
  const days = {};
  for (const day of range(today, '2026-10-20')) {
    days[day] = {};
    for (const slot of slotsFor(day)) {
      // A hole on the 8th, and one lone mark far out on the 20th.
      const answered = day !== '2026-10-08';
      days[day][slot] = answered ? { p0: E('FREE') } : {};
    }
  }
  assert.equal(confirmedThrough(days, 'p0', today, 30), '2026-10-07');
});

test('an assumed or stale value does not extend confirmed_through', () => {
  const today = '2026-10-05';
  const days = {};
  for (const day of range(today, '2026-10-09')) {
    days[day] = {};
    for (const slot of slotsFor(day)) {
      days[day][slot] = day === '2026-10-07'
        ? { p0: E('FREE', 'PATTERN') }
        : day === '2026-10-08' ? { p0: E('FREE', 'EXPLICIT', true) } : { p0: E('FREE') };
    }
  }
  assert.equal(confirmedThrough(days, 'p0', today, 10), '2026-10-06');
});

test('weekdays are evening-only and weekends have three slots', () => {
  assert.deepEqual(slotsFor('2026-10-06'), ['EVENING']);
  assert.deepEqual(slotsFor('2026-10-10'), ['MORNING', 'AFTERNOON', 'EVENING']);
  const slots = enumerateSlots('2026-10-05', '2026-10-11');
  assert.equal(slots.length, 5 * 1 + 2 * 3);
});

test('the quick-change strip only offers my own explicit, fresh frees', () => {
  const today = '2026-10-05';
  const days = {};
  for (const day of range(today, '2026-10-20')) {
    days[day] = {};
    for (const slot of slotsFor(day)) days[day][slot] = {};
  }
  days['2026-10-06'].EVENING = { p0: E('FREE') };
  days['2026-10-07'].EVENING = { p0: E('FREE', 'PATTERN') };      // assumed: not offered
  days['2026-10-08'].EVENING = { p0: E('FREE', 'EXPLICIT', true) }; // stale: not offered
  days['2026-10-09'].EVENING = { p0: E('MAYBE') };                 // maybe: not offered
  days['2026-10-12'].EVENING = { p0: E('FREE') };
  const got = myFreeSlots(days, 'p0', today, 3, 20);
  assert.deepEqual(got.map((g) => g.day), ['2026-10-06', '2026-10-12']);
});

// ----------------------------------------------------------------- patterns ---

test('a pattern must be exactly the 11 keys, each true, false or null', () => {
  const ok = validatePattern({
    MON_EVENING: true, TUE_EVENING: null, WED_EVENING: false, THU_EVENING: true, FRI_EVENING: true,
    SAT_MORNING: false, SAT_AFTERNOON: true, SAT_EVENING: true,
    SUN_MORNING: null, SUN_AFTERNOON: true, SUN_EVENING: false,
  });
  assert.equal(Object.keys(ok).length, 11);
  assert.equal(ok.TUE_EVENING, null);

  assert.equal(validatePattern({}).MON_EVENING, null, 'missing keys become null, not false');
  assert.equal(validatePattern({ MON_EVENING: 'yes' }), null, 'a string is rejected');
  assert.equal(validatePattern({ MON_EVENING: 1 }), null, 'a number is rejected');
  assert.equal(validatePattern(null), null);
  // There is deliberately no MAYBE pattern value.
  assert.equal(validatePattern({ MON_EVENING: 'MAYBE' }), null);
});

test('an untoggled pattern control derives to not-answered, never to busy', () => {
  const p = validatePattern({});
  for (const v of Object.values(p)) {
    assert.equal(v, null);
    assert.notEqual(v, false, 'a blank must never become an assumed BUSY');
  }
});
