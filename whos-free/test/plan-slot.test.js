// A plan inherits the slot the user was looking at. It never guesses one.
//
// The bug this locks out: addPlanFlow asked a second question whose default was
// 'evening', so the happy path - accept the default - recorded an AFTERNOON's
// 5-of-7 against the EVENING. "Sat 10 Oct · afternoon" is the whole point of
// Best days; filing it under the wrong slot is the app writing down a decision
// nobody made.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { slotsFor } from '../public/shared/tally.js';

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/**
 * The real client function, lifted out of public/app.js rather than copied, so
 * this suite fails if the shipped flow ever regresses. app.js touches the DOM
 * at module scope and cannot be imported, so its three free names - window,
 * slotsFor and mutate - are injected instead.
 */
function loadAddPlanFlow({ prompt, mutate }) {
  const start = SRC.indexOf('\nasync function addPlanFlow(day, slot) {');
  assert.ok(start > -1, 'public/app.js must define a top-level addPlanFlow(day, slot)');
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of addPlanFlow');
  const body = SRC.slice(start, end + 3);
  // eslint-disable-next-line no-new-func
  return new Function('window', 'slotsFor', 'mutate', `${body}; return addPlanFlow;`)(
    { prompt }, slotsFor, mutate,
  );
}

const SAT = '2026-10-10';   // weekend: morning, afternoon, evening
const TUE = '2026-10-13';   // weekday: evening only

function recorder() {
  const calls = [];
  return { calls, mutate: async (url, body) => { calls.push({ url, body }); } };
}

test('the slot the row was about is the slot the plan gets', async () => {
  for (const slot of slotsFor(SAT)) {
    const rec = recorder();
    const addPlanFlow = loadAddPlanFlow({ prompt: () => 'Roast', mutate: rec.mutate });
    await addPlanFlow(SAT, slot);
    assert.deepEqual(rec.calls, [{ url: '/api/plan', body: { day: SAT, slot, title: 'Roast' } }]);
  }
});

test('one prompt only - the title - and cancelling it writes nothing', async () => {
  const rec = recorder();
  let asked = 0;
  const addPlanFlow = loadAddPlanFlow({ prompt: () => { asked += 1; return null; }, mutate: rec.mutate });
  await addPlanFlow(SAT, 'AFTERNOON');
  assert.equal(asked, 1, 'exactly one prompt: the title');
  assert.deepEqual(rec.calls, [], 'no plan written when the title is cancelled');
});

test('a slot the day does not have is never written', async () => {
  const rec = recorder();
  const addPlanFlow = loadAddPlanFlow({ prompt: () => 'Pub', mutate: rec.mutate });
  // A weekday has no afternoon slot, so a stale data attribute falls back to a
  // slot that exists rather than inventing one.
  await addPlanFlow(TUE, 'AFTERNOON');
  assert.equal(rec.calls.length, 1);
  assert.ok(slotsFor(TUE).includes(rec.calls[0].body.slot));
});

test("every plan button in the markup carries a slot, so the fallback stays unreachable", () => {
  const attrs = [...SRC.matchAll(/data-(?:addplan|makeplan)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(attrs.length >= 2, 'expected both the day-sheet and band-row plan buttons');
  for (const a of attrs) {
    assert.match(a, /^\$\{esc\([^)]*\)\}\|\$\{esc\([^)]*\)\}$/, `plan button "${a}" must encode day|slot`);
  }
});

test('the slot prompt that defaulted to evening is gone for good', () => {
  const start = SRC.indexOf('\nasync function addPlanFlow(day, slot) {');
  const fn = SRC.slice(start, SRC.indexOf('\n}\n', start));
  assert.equal((fn.match(/window\.prompt/g) || []).length, 1, 'title prompt only');
  assert.doesNotMatch(fn, /'evening'/, 'no evening default anywhere in the flow');
});
