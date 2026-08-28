// The one rule, mechanised.
//
// "not answered" must never be rendered, counted, or reasoned about as "free".
// Everything here exists to make that unenforceable by accident.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { addDays, diffDays, format, parse, range } from '../public/shared/plainday.js';
import {
  BUCKETS, buildBands, confirmedThrough, enumerateSlots, formatTally, isStale,
  missing, myFreeSlots, names, nextConfirmWindow, slotsFor, tally, validatePattern,
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

// ------------------------------------------------- the who-still-needs-chasing line ---
//
// "missing" is the word that turns an answer into a failure. It belongs to
// silence and nothing else. Kit marking himself busy for six straight weeks so
// nobody has to chase him must not read like Sam, who has never opened the app.
// missing() itself stays exported and unchanged above - it is the SENTENCE that
// was wrong, not the bucket maths.

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The real client function and its real label table, lifted out of public/app.js
 * rather than copied, so this suite fails if the shipped wording regresses.
 * app.js touches the DOM at module scope and cannot be imported, so its two
 * free names - esc and names - are injected instead.
 */
function loadSlotWho() {
  const start = APP.indexOf('\nconst WHO_CLAUSES = [');
  assert.ok(start > -1, 'public/app.js must define a top-level WHO_CLAUSES');
  const fnStart = APP.indexOf('\nfunction slotWho(t, people) {', start);
  assert.ok(fnStart > start, 'public/app.js must define a top-level slotWho(t, people)');
  const end = APP.indexOf('\n}\n', fnStart);
  assert.ok(end > fnStart, 'could not find the end of slotWho');
  const body = APP.slice(start, end + 3);
  // eslint-disable-next-line no-new-func
  return new Function('esc', 'names', `${body}; return slotWho;`)(escHtml, names);
}

const slotWho = loadSlotWho();
const plain = (html) => html.replace(/<[^>]*>/g, '');

test('someone who answered busy is never called missing', () => {
  const t = tally({ p0: E('BUSY') }, R(1));
  assert.equal(plain(slotWho(t, R(1))), "can't make it: P0");
  assert.doesNotMatch(slotWho(t, R(1)), /missing/i, 'an answer is not a failure to answer');
});

test('only silence gets the no-answer words', () => {
  const roster = R(2);
  const t = tally({ p0: E('BUSY') }, roster);
  assert.equal(plain(slotWho(t, roster)), "can't make it: P0 · no answer yet: P1");
});

test('a pattern-derived value is the app guessing, not the person going quiet', () => {
  const roster = R(1);
  const t = tally({ p0: E('FREE', 'PATTERN') }, roster);
  assert.equal(plain(slotWho(t, roster)), 'not confirmed: P0');
  assert.doesNotMatch(slotWho(t, roster), /missing|no answer/i);
});

test('a stale answer asks for a re-check rather than being erased', () => {
  const roster = R(1);
  const t = tally({ p0: E('FREE', 'EXPLICIT', true) }, roster);
  assert.equal(plain(slotWho(t, roster)), 'worth a re-check: P0');
});

test('a maybe-person is named exactly once on the line', () => {
  const roster = R(3);
  const t = tally({ p0: E('BUSY'), p1: E('MAYBE'), p2: E('FREE') }, roster);
  const line = plain(slotWho(t, roster));
  assert.equal(line, "can't make it: P0 · maybe: P1");
  assert.equal(line.split('P1').length - 1, 1, 'P1 was printed twice by the old missing+maybe pair');
});

test('every non-free bucket gets its own clause, in one fixed order', () => {
  const roster = R(6);
  const t = tally({
    p0: E('FREE'),
    p1: E('BUSY'),
    p2: E('MAYBE'),
    p3: E('FREE', 'PATTERN'),
    p4: E('FREE', 'EXPLICIT', true),
  }, roster);
  assert.equal(
    plain(slotWho(t, roster)),
    "can't make it: P1 · maybe: P2 · no answer yet: P5 · not confirmed: P3 · worth a re-check: P4",
  );
  // Everyone who is not a definite free appears, so the line stays as
  // actionable as the old missing list was - it just stops slandering them.
  for (const id of missing(t)) {
    const name = names(roster, [id]);
    assert.match(plain(slotWho(t, roster)), new RegExp(name), `${name} must still be named`);
  }
});

test('an empty bucket prints no clause at all', () => {
  const roster = R(2);
  const t = tally({ p0: E('FREE'), p1: E('MAYBE') }, roster);
  assert.equal(plain(slotWho(t, roster)), 'maybe: P1');
});

test('all free and nobody silent is still everyone\u2019s in', () => {
  const roster = R(3);
  const t = tally({ p0: E('FREE'), p1: E('FREE'), p2: E('FREE') }, roster);
  assert.equal(slotWho(t, roster), 'everyone\u2019s in');
});

test('the line never names who IS free, so it cannot be read as a free count', () => {
  const roster = R(2);
  const t = tally({ p0: E('FREE'), p1: E('BUSY') }, roster);
  const line = slotWho(t, roster);
  assert.doesNotMatch(line, /\bfree\b/i);
  assert.doesNotMatch(line, /P0/, 'a definite free is not chased');
  // The exact counts, "not answered" included, live on the next line.
  assert.equal(formatTally(t), '1 free · 1 busy · 0 not answered');
});

test('names are escaped before they reach the markup', () => {
  const roster = [{ id: 'p0', name: '<script>x</script>' }];
  const t = tally({}, roster);
  const line = slotWho(t, roster);
  assert.doesNotMatch(line, /<script>/);
  assert.match(line, /&lt;script&gt;/);
});

test('the word "missing" is gone from the row markup but missing() still exists', () => {
  const start = APP.indexOf('\nfunction slotRow(r, isTop) {');
  assert.ok(start > -1, 'public/app.js must define a top-level slotRow(r, isTop)');
  const fn = APP.slice(start, APP.indexOf('\n}\n', start));
  assert.doesNotMatch(fn, /missing/i, 'slotRow must not print or compute a "missing" list');
  assert.equal(typeof missing, 'function', 'missing() stays exported from tally.js');
});

// ---------------------------------------------------- the recurring ask ------

test('"Add 2 more weeks" rolls forward instead of re-asking what is already done', () => {
  const today = '2026-08-25';
  const H = 42, C = 14;

  // Nobody confirmed yet: start today.
  assert.deepEqual(nextConfirmWindow(null, today, C, H),
    { from: '2026-08-25', to: '2026-09-07', horizonEnd: '2026-10-05' });

  // THE BUG THIS GUARDS: anchored at today, every slot in this window is
  // already EXPLICIT and not stale, so the server skips all of them and the
  // most diligent person in the group gets written:0 for their trouble.
  const rolled = nextConfirmWindow('2026-09-07', today, C, H);
  assert.equal(rolled.from, '2026-09-08', 'starts the day after their run ends');
  assert.equal(rolled.to, '2026-09-21');
  assert.notEqual(rolled.from, today);

  // Never ask about days the loaded window does not cover.
  const clamped = nextConfirmWindow('2026-09-28', today, C, H);
  assert.equal(clamped.to, clamped.horizonEnd, 'clamped to the horizon');
  assert.ok(diffDays(parse(clamped.from), parse(clamped.to)) < C - 1, 'short final window');

  // Already covered to the horizon is a real state, not an empty list.
  assert.equal(nextConfirmWindow('2026-10-05', today, C, H).from, null);
  assert.equal(nextConfirmWindow('2026-12-01', today, C, H).from, null);
});

test('a flawless confirm is enough to tick your own chip', () => {
  // confirmedThrough after confirming today..today+13 is today+13, so the ring
  // threshold has to be satisfied by 13 days of lead — not 14, or the one person
  // who did exactly what the app asked is told they did not.
  const today = '2026-08-25';
  const win = nextConfirmWindow(null, today, CONFIG.CONFIRM_DAYS, 42);
  const lead = diffDays(parse(today), parse(win.to));
  assert.equal(lead, CONFIG.CONFIRM_DAYS - 1);
  assert.ok(lead >= CONFIG.RING_FILLED_DAYS,
    `confirming once gives ${lead} days of lead but the ring needs ${CONFIG.RING_FILLED_DAYS}`);
});
