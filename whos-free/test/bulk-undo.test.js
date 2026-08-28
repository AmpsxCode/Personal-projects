// Undo after a bulk mark must PUT BACK, never delete.
//
// The bug this locks out: /api/marks/bulk cross-products days x slots, so an
// undo that grouped rows by their previous value alone and sent the union of
// days with the union of slots wrote each value over pairs it never touched -
// and the CLEAR group, arriving last, wiped what the earlier groups restored.
// A weekend marked busy and then undone came back EMPTY.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { expandBulk } from '../src/write.js';
import { slotsFor } from '../public/shared/tally.js';

// The real client function, lifted out of public/app.js rather than copied, so
// this suite fails if the shipped grouping ever regresses. app.js touches the
// DOM at module scope and cannot be imported; undoRequests is pure by design.
function loadUndoRequests() {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('\nfunction undoRequests(changed) {');
  assert.ok(start > -1, 'public/app.js must define a top-level undoRequests(changed)');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of undoRequests');
  const body = src.slice(start, end + 3);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return undoRequests;`)();
}

const undoRequests = loadUndoRequests();

const SAT = '2026-08-29';
const SUN = '2026-08-30';
const MON = '2026-08-31';

/** The server's write path, minus D1: apply one bulk request to a mark store. */
function applyBulk(store, req) {
  const keys = expandBulk(req.days, req.slots, req.eveningsOnly === true);
  const changed = keys.map(({ day, slot }) => ({
    day, slot, from: store[`${day}|${slot}`] || null, to: req.state === undefined ? null : req.state,
  }));
  for (const { day, slot } of keys) {
    const k = `${day}|${slot}`;
    if (req.state === null || req.state === undefined) delete store[k];
    else store[k] = req.state;
  }
  return changed;
}

test('the weekend case from the bug report: undo restores, it does not delete', () => {
  const store = { [`${SAT}|MORNING`]: 'FREE', [`${SUN}|EVENING`]: 'FREE' };
  const before = { ...store };

  const changed = applyBulk(store, { days: [SAT, SUN], slots: null, state: 'BUSY' });
  assert.equal(Object.keys(store).length, 6); // both days, all three slots, busy

  for (const req of undoRequests(changed)) applyBulk(store, req);
  assert.deepEqual(store, before);
});

test('an undo only ever touches pairs that were in `changed`', () => {
  const store = { [`${SAT}|AFTERNOON`]: 'MAYBE', [`${MON}|EVENING`]: 'BUSY' };
  const changed = applyBulk(store, { days: [SAT, SUN, MON], slots: null, state: 'FREE' });
  const allowed = new Set(changed.map((c) => `${c.day}|${c.slot}`));

  for (const req of undoRequests(changed)) {
    for (const { day, slot } of expandBulk(req.days, req.slots, req.eveningsOnly === true)) {
      assert.ok(allowed.has(`${day}|${slot}`), `undo would write ${day} ${slot}, never changed`);
    }
  }
});

test('undo sends no eveningsOnly, which would drop the mornings it owes back', () => {
  const store = { [`${SAT}|MORNING`]: 'FREE', [`${SAT}|EVENING`]: 'BUSY' };
  const before = { ...store };
  const changed = applyBulk(store, { days: [SAT, SUN], slots: null, state: 'MAYBE' });
  const reqs = undoRequests(changed);
  for (const req of reqs) assert.ok(!('eveningsOnly' in req), 'undo must not send eveningsOnly');
  for (const req of reqs) applyBulk(store, req);
  assert.deepEqual(store, before);
});

test('every mixed starting state survives a round trip, weekday slots included', () => {
  const days = [SAT, SUN, MON];
  const values = ['FREE', 'MAYBE', 'BUSY', null];
  // Every assignment of the four possible previous values across the seven
  // (day, slot) pairs this selection covers. 4^7 = 16384 stores, all restored.
  const pairs = [];
  for (const day of days) for (const slot of slotsFor(day)) pairs.push(`${day}|${slot}`);
  assert.equal(pairs.length, 7);

  for (let n = 0; n < values.length ** pairs.length; n += 1) {
    const store = {};
    let rest = n;
    for (const key of pairs) {
      const v = values[rest % values.length];
      rest = Math.floor(rest / values.length);
      if (v !== null) store[key] = v;
    }
    const before = { ...store };
    for (const state of values) {
      const changed = applyBulk(store, { days, slots: null, state });
      for (const req of undoRequests(changed)) applyBulk(store, req);
      assert.deepEqual(store, before, `state=${state} store=${JSON.stringify(before)}`);
    }
  }
});

test('one request per (value, slot) group, and each names exactly one slot', () => {
  const store = { [`${SAT}|MORNING`]: 'FREE', [`${SUN}|MORNING`]: 'FREE', [`${SAT}|EVENING`]: 'BUSY' };
  const changed = applyBulk(store, { days: [SAT, SUN], slots: null, state: 'BUSY' });
  const reqs = undoRequests(changed);
  for (const req of reqs) assert.equal(req.slots.length, 1);
  // FREE|MORNING (two days), BUSY|EVENING, CLEAR|MORNING is empty, so:
  // CLEAR|AFTERNOON, CLEAR|EVENING, and CLEAR|MORNING does not exist.
  const keys = reqs.map((r) => `${r.state === null ? 'CLEAR' : r.state}|${r.slots[0]}`).sort();
  assert.deepEqual(keys, ['BUSY|EVENING', 'CLEAR|AFTERNOON', 'CLEAR|EVENING', 'FREE|MORNING']);
  const morning = reqs.find((r) => r.state === 'FREE');
  assert.deepEqual(morning.days.slice().sort(), [SAT, SUN]);
});
