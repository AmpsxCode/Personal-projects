// The date suite from section 10.
//
// Run under TZ=Europe/London FIRST - that is the only zone here that actually
// reproduces the BST bug class. If it fails under London there is a local-Date
// leak somewhere; if it passes there and fails elsewhere there is a sign error.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as P from '../public/shared/plainday.js';
import { slotsFor } from '../public/shared/tally.js';

const MONTHS = [
  { y: 2026, m: 3, days: 31 },
  { y: 2026, m: 10, days: 31 },
  { y: 2027, m: 3, days: 31 },
  { y: 2027, m: 10, days: 31 },
];

test('the date layer contains no Date at all', () => {
  // Section 10 permits exactly one Date call, inside mondayIndex. We do better:
  // the weekday comes from epoch-day arithmetic, so there is nothing in this
  // file a host timezone could shift. The oracle test below proves the
  // arithmetic agrees with Date.UTC without shipping it.
  const src = readFileSync(new URL('../public/shared/plainday.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['new Date', 'Date.UTC', 'Date.now', 'getDay(', 'getDate(', 'toISOString', 'Intl.']) {
    assert.ok(!code.includes(banned), `plainday.js must not use ${banned}`);
  }
});

test('mondayIndex agrees with a Date.UTC oracle for 12 years of days', () => {
  let day = P.parse('2020-01-01');
  const end = P.toEpochDay(P.parse('2032-01-01'));
  let checked = 0;
  for (let e = P.toEpochDay(day); e <= end; e += 1) {
    day = P.fromEpochDay(e);
    // Date.UTC + getUTCDay cannot be shifted by the host timezone, so it is a
    // safe oracle even though it is banned from the shipped module.
    const oracle = (new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() + 6) % 7;
    assert.equal(P.mondayIndex(day), oracle, `weekday mismatch on ${P.format(day)}`);
    checked += 1;
  }
  assert.ok(checked > 4000, `expected to check thousands of days, checked ${checked}`);
});

test('parse and format round-trip, and reject nonsense', () => {
  for (const s of ['2026-10-10', '2026-01-01', '2028-02-29', '1999-12-31']) {
    assert.equal(P.format(P.parse(s)), s);
  }
  for (const bad of ['2026-13-01', '2026-02-30', '2027-02-29', '2026-1-1', '20261010', '', null, undefined, 'today']) {
    assert.throws(() => P.parse(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

for (const { y, m, days } of MONTHS) {
  test(`month grid is correct for ${y}-${String(m).padStart(2, '0')}`, () => {
    assert.equal(P.daysInMonth(y, m), days);
    const cells = P.monthGrid({ y, m });
    assert.equal(cells.length, 42, 'always a 6x7 grid');

    const inMonth = cells.filter((c) => c.inMonth);
    assert.equal(inMonth.length, days, 'every day of the month appears exactly once');

    // Each cell's day number matches its ISO key.
    for (const c of cells) {
      assert.equal(P.format(c.day), c.key);
      assert.equal(Number(c.key.slice(8, 10)), c.day.d, `day number disagrees with key on ${c.key}`);
    }

    // Monday first, and each row is seven consecutive days.
    assert.equal(P.mondayIndex(cells[0].day), 0, 'grid starts on a Monday');
    for (let i = 1; i < cells.length; i += 1) {
      assert.equal(P.diffDays(cells[i - 1].day, cells[i].day), 1, 'cells are consecutive');
    }

    // Every weekend day has exactly 3 slots, every weekday exactly 1.
    for (const c of inMonth) {
      const n = slotsFor(c.key).length;
      assert.equal(n, P.isWeekend(c.day) ? 3 : 1, `${c.key} has ${n} slots`);
    }
  });
}

test('the UK clock changes do not move any date', () => {
  // Sun 25 Oct 2026 is a 25-hour day; Sun 28 Mar 2027 is a 23-hour day. Both
  // are the classic place a local-time Date shifts a calendar date by one.
  const cases = [
    ['2026-10-24', '2026-10-25'],   // Saturday before the autumn change
    ['2026-10-25', '2026-10-26'],   // the 25-hour day itself
    ['2027-03-27', '2027-03-28'],   // Saturday before the spring change
    ['2027-03-28', '2027-03-29'],   // the 23-hour day itself
    ['2026-03-28', '2026-03-29'],
    ['2027-10-30', '2027-10-31'],
  ];
  for (const [from, to] of cases) {
    assert.equal(P.format(P.addDays(P.parse(from), 1)), to, `next day from ${from}`);
    assert.equal(P.format(P.addDays(P.parse(to), -1)), from, `previous day from ${to}`);
    assert.equal(P.diffDays(P.parse(from), P.parse(to)), 1);
  }
  // And the transition Sundays really are Sundays.
  assert.equal(P.weekdayName(P.parse('2026-10-25')), 'Sun');
  assert.equal(P.weekdayName(P.parse('2027-03-28')), 'Sun');
  assert.ok(P.isWeekend(P.parse('2026-10-25')));
});

test('addDays and addMonths are exact across boundaries', () => {
  assert.equal(P.format(P.addDays(P.parse('2026-12-31'), 1)), '2027-01-01');
  assert.equal(P.format(P.addDays(P.parse('2027-01-01'), -1)), '2026-12-31');
  assert.equal(P.format(P.addDays(P.parse('2028-02-28'), 1)), '2028-02-29');
  assert.equal(P.format(P.addDays(P.parse('2026-02-28'), 1)), '2026-03-01');
  assert.equal(P.format(P.addMonths(P.parse('2026-01-31'), 1)), '2026-02-28');
  assert.equal(P.format(P.addMonths(P.parse('2028-01-31'), 1)), '2028-02-29');
  assert.equal(P.format(P.addMonths(P.parse('2026-10-10'), -10)), '2025-12-10');
  assert.equal(P.diffDays(P.parse('2026-01-01'), P.parse('2027-01-01')), 365);
  assert.equal(P.diffDays(P.parse('2028-01-01'), P.parse('2029-01-01')), 366);
});

test('epoch day round-trips over a long span', () => {
  for (let e = -25000; e < 30000; e += 137) {
    assert.equal(P.toEpochDay(P.fromEpochDay(e)), e);
  }
  assert.equal(P.toEpochDay(P.parse('1970-01-01')), 0);
  assert.equal(P.mondayIndex(P.parse('1970-01-01')), 3, '1 Jan 1970 was a Thursday');
});

test('presentation is en-GB and Monday-first regardless of host locale', () => {
  assert.equal(P.formatShort('2026-10-10'), 'Sat 10 Oct');
  assert.equal(P.formatMedium('2026-10-10'), 'Sat 10 October');
  assert.equal(P.formatLong('2026-10-10'), 'Saturday 10 October 2026');
  assert.equal(P.formatMonth({ y: 2026, m: 10 }), 'October 2026');
  assert.equal(P.ordinalDay('2026-10-01'), '1st');
  assert.equal(P.ordinalDay('2026-10-02'), '2nd');
  assert.equal(P.ordinalDay('2026-10-03'), '3rd');
  assert.equal(P.ordinalDay('2026-10-11'), '11th');
  assert.equal(P.ordinalDay('2026-10-12'), '12th');
  assert.equal(P.ordinalDay('2026-10-13'), '13th');
  assert.equal(P.ordinalDay('2026-10-21'), '21st');
  assert.equal(P.format(P.startOfWeek(P.parse('2026-10-10'))), '2026-10-05');
});

test('range is inclusive and ordered', () => {
  const r = P.range('2026-10-08', '2026-10-12');
  assert.deepEqual(r, ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
  assert.deepEqual(P.range('2026-10-08', '2026-10-08'), ['2026-10-08']);
});
