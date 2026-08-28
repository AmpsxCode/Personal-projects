// A plan that nobody is told about is not a plan.
//
// createPlan was the one mutation returning no ack, so the sheet closed in
// silence and the digest - the text written for the group chat - never mentioned
// the plan at all. The organiser then retyped it into WhatsApp, which is the
// thirty-message loop this app exists to end.
//
// The other half of this: the sentence must stay honest. "5 free" is not
// "5 coming", and a silent person is never quietly folded into the headcount.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { planAnnounce, weeklyDigest } from '../src/nudge.js';
import { slotsFor } from '../public/shared/tally.js';

const SAT = '2026-10-10';
const NAMES = ['Ammar', 'Nia', 'Priya', 'Rob', 'Sasha', 'Tomas', 'Wren'];
const ROSTER = NAMES.map((name, i) => ({ id: `p${i}`, name }));
const said = (s) => ({ s, src: 'EXPLICIT', stale: false });

/** Five free, one maybe, one who has said nothing at all. */
function stateWithAnswers() {
  return {
    today: SAT,
    from: SAT,
    to: SAT,
    group: { name: 'Thursday Club', quorum: 4 },
    days: {
      [SAT]: {
        AFTERNOON: {
          p0: said('FREE'), p1: said('FREE'), p2: said('FREE'), p3: said('FREE'),
          p4: said('FREE'), p5: said('MAYBE'),
        },
      },
    },
    plans: [],
  };
}

const PLAN = { day: SAT, slot: 'AFTERNOON', title: 'Dinner at mine', note: null };

test('the announcement is one pasteable line with an honest tally', () => {
  const line = planAnnounce(stateWithAnswers(), ROSTER, PLAN, 'https://free.example', 'kit-jo');
  assert.equal(
    line,
    "We're on for Sat 10 Oct, afternoon - Dinner at mine. "
    + '5 free · 1 maybe · 1 not answered. https://free.example/g/kit-jo',
  );
});

test('free is never printed as coming, and silence is never printed as free', () => {
  const line = planAnnounce(stateWithAnswers(), ROSTER, PLAN, 'https://free.example', 'kit-jo');
  assert.doesNotMatch(line, /coming|attending|going/i, 'nobody was asked to commit');
  assert.match(line, /1 not answered/, 'the silent person is counted as silent');
  assert.doesNotMatch(line, /6 free|7 free/, 'a maybe and a silence never inflate the free count');
});

test('"not answered" prints even when nobody has answered anything', () => {
  const empty = stateWithAnswers();
  empty.days[SAT].AFTERNOON = {};
  const line = planAnnounce(empty, ROSTER, PLAN, 'https://free.example', 'kit-jo');
  assert.match(line, /7 not answered/);
  assert.doesNotMatch(line, /\d+ free/, 'an empty slot claims no free people');
});

test('a day with no marks at all does not throw', () => {
  const bare = stateWithAnswers();
  bare.days = {};
  const line = planAnnounce(bare, ROSTER, PLAN, 'https://free.example', 'kit-jo');
  assert.match(line, /7 not answered/);
});

test('a note rides along in brackets, and its absence adds nothing', () => {
  const withNote = planAnnounce(
    stateWithAnswers(), ROSTER, { ...PLAN, note: 'bring a bottle' }, 'https://x', 'kit-jo',
  );
  assert.match(withNote, /Dinner at mine \(bring a bottle\)\./);
  const without = planAnnounce(stateWithAnswers(), ROSTER, PLAN, 'https://x', 'kit-jo');
  assert.doesNotMatch(without, /\(\)/);
});

test('the digest leads with the agreed plan and still names nobody', () => {
  const state = stateWithAnswers();
  state.plans = [
    { day: SAT, slot: 'AFTERNOON', title: 'Dinner at mine', createdBy: 'p0' },
    { day: '2026-10-17', slot: 'EVENING', title: 'Later thing', createdBy: 'p1' },
  ];
  const lines = weeklyDigest(state, ROSTER, 'https://x', 'kit-jo').split('\n');
  assert.equal(lines[1], '- Plan: Sat 10 Oct afternoon - Dinner at mine', 'the plan comes first');
  assert.equal(
    lines.filter((l) => l.startsWith('- Plan:')).length, 1,
    'only the next plan, not the whole list',
  );
  for (const p of ROSTER) {
    assert.ok(!lines.join('\n').includes(p.name), `the digest must not name ${p.name}`);
  }
});

test('the morning plan is the next plan, not the one SQL happens to sort first', () => {
  // ORDER BY slot sorts the NAMES: AFTERNOON, EVENING, MORNING. A Saturday
  // parkrun would file below that evening's dinner, and the digest would name
  // the dinner as "the plan" while never mentioning the morning at all.
  const state = stateWithAnswers();
  state.plans = [
    { day: SAT, slot: 'AFTERNOON', title: 'Dinner at mine', createdBy: 'p0' },
    { day: SAT, slot: 'MORNING', title: 'Parkrun 9am', createdBy: 'p1' },
  ];
  const lines = weeklyDigest(state, ROSTER, 'https://x', 'kit-jo').split('\n');
  assert.equal(lines[1], '- Plan: Sat 10 Oct morning - Parkrun 9am', 'the earliest slot leads');
});

test('a plan past the horizon does not lead a text headed "the next few weeks"', () => {
  const state = stateWithAnswers();
  state.plans = [{ day: '2027-01-02', slot: 'EVENING', title: 'New year thing', createdBy: 'p0' }];
  const text = weeklyDigest(state, ROSTER, 'https://x', 'kit-jo');
  assert.doesNotMatch(text, /New year thing/, 'outside the window is outside the text');
  assert.match(text, /- Sat 10 Oct afternoon: 5 of 7 free/, 'the bands still lead instead');
});

test('a plan with no answers is no longer "nobody has filled anything in yet"', () => {
  const state = stateWithAnswers();
  state.days[SAT].AFTERNOON = {};
  state.plans = [{ day: SAT, slot: 'AFTERNOON', title: 'Dinner at mine', createdBy: 'p0' }];
  const text = weeklyDigest(state, ROSTER, 'https://x', 'kit-jo');
  assert.match(text, /- Plan: Sat 10 Oct afternoon - Dinner at mine/);
  assert.doesNotMatch(text, /Nobody has filled anything in yet/);
});

test('a group with no plan gets exactly the digest it got before', () => {
  const text = weeklyDigest(stateWithAnswers(), ROSTER, 'https://x', 'kit-jo');
  assert.doesNotMatch(text, /- Plan:/, 'no plan, no plan line');
  assert.equal(text.split('\n')[1], '- Sat 10 Oct afternoon: 5 of 7 free', 'the bands still lead');
});

test('the "nothing at all" fallback is still reachable', () => {
  // rows only disappear when the window itself holds no slots, so that is the
  // one shape that reaches the fallback - a plan-less, answer-less window.
  const state = stateWithAnswers();
  state.days = {};
  state.from = '2026-10-10';
  state.to = '2026-10-09';
  assert.match(weeklyDigest(state, ROSTER, 'https://x', 'kit-jo'), /Nobody has filled anything in yet/);
});

// ------------------------------------------------------------------ server ---

const API = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');

function createPlanSource() {
  const start = API.indexOf('\nasync function createPlan(request, env, nowMs) {');
  assert.ok(start > -1, 'src/api.js must define createPlan');
  const end = API.indexOf('\n}\n', start);
  return API.slice(start, end);
}

test('createPlan rejects a slot the day does not have', () => {
  const fn = createPlanSource();
  assert.match(fn, /slotsFor\(body\.day\)\.includes\(body\.slot\)/, 'MORNING on a Tuesday is not a plan');
  assert.match(fn, /BAD_SLOT/);
  assert.equal(slotsFor('2026-10-13').includes('MORNING'), false, 'a weekday really has no morning');
});

test('createPlan drops the cached digest inside the same batch as the insert', () => {
  const fn = createPlanSource();
  // One batch() with the version bump - invariant 9. A separate write would be
  // a second round trip AND could leave the digest cached if it failed.
  const commitCall = fn.slice(fn.indexOf('await commit('), fn.indexOf('response.version'));
  assert.match(commitCall, /INSERT INTO plans/);
  assert.match(commitCall, /DELETE FROM notes WHERE k = \?1/);
  assert.match(commitCall, /nudgeNoteKey\(group\.slug\)/);
});

test('createPlan returns both ack and share, and they are the same sentence', () => {
  const fn = createPlanSource();
  assert.match(fn, /response\.ack = planAnnounce\(/);
  assert.match(fn, /response\.share = response\.ack/);
});

// ------------------------------------------------------------------ client ---

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/**
 * The real client function, lifted out of public/app.js rather than copied, so
 * this fails if the shipped flow regresses. app.js touches the DOM at module
 * scope and cannot be imported, so its free names are injected.
 */
function loadAddPlanFlow(deps) {
  const start = APP.indexOf('\nasync function addPlanFlow(day, slot) {');
  assert.ok(start > -1, 'public/app.js must define a top-level addPlanFlow(day, slot)');
  const end = APP.indexOf('\n}\n', start);
  const body = APP.slice(start, end + 3);
  // eslint-disable-next-line no-new-func
  return new Function('window', 'slotsFor', 'mutate', 'showSnack', 'navigator', 'say',
    `${body}; return addPlanFlow;`)(
    { prompt: deps.prompt }, slotsFor, deps.mutate, deps.showSnack, deps.navigator,
    deps.say || (() => {}),
  );
}

test('the share line is offered to the clipboard and shown as its own fallback', async () => {
  const share = "We're on for Sat 10 Oct, afternoon - Dinner at mine. 5 free · 1 not answered. https://x/g/kit-jo";
  const snacks = [];
  const copied = [];
  const addPlanFlow = loadAddPlanFlow({
    prompt: () => 'Dinner at mine',
    mutate: async () => ({ ok: true, share, ack: share }),
    showSnack: (text, label, action) => snacks.push({ text, label, action }),
    navigator: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } },
  });
  await addPlanFlow(SAT, 'AFTERNOON');

  assert.equal(snacks.length, 1, 'one snackbar');
  assert.equal(snacks[0].text, share, 'the whole line is visible, so a blocked clipboard is survivable');
  assert.ok(snacks[0].label, 'the copy is a labelled button, not an invisible side effect');
  assert.deepEqual(copied, [], 'nothing is copied before the user presses the button');

  snacks[0].action();
  assert.deepEqual(copied, [share], 'pressing it copies exactly the line that was shown');
});

test('no snackbar when the server said nothing to share', async () => {
  const snacks = [];
  const addPlanFlow = loadAddPlanFlow({
    prompt: () => 'Dinner at mine',
    mutate: async () => null, // offline: mutate() queued it and returned null
    showSnack: (text) => snacks.push(text),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  });
  await addPlanFlow(SAT, 'AFTERNOON');
  assert.deepEqual(snacks, [], 'an offline plan must not claim to have been announced');
});

test('the clipboard write sits in the handler, never behind an await', () => {
  const start = APP.indexOf('\nasync function addPlanFlow(day, slot) {');
  const fn = APP.slice(start, APP.indexOf('\n}\n', start));
  // Safari only honours a clipboard write inside the click that asked for it, so
  // nothing may be awaited in front of it - not in the flow, and not inside the
  // snackbar handler either. The result is chained instead, which is also what
  // lets a refusal be handled rather than thrown into nothing.
  // Comments stripped first: this file's own prose says the word "await" next to
  // the word "clipboard" more than once, and only the code is under test.
  const code = fn.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /await[^;]*navigator\.clipboard/);
  const handler = code.slice(code.indexOf("showSnack(data.share, 'Copy"));
  assert.match(handler, /navigator\.clipboard\.writeText\(data\.share\)/,
    'the button copies exactly the line that was shown');
  assert.match(handler, /catch/, 'a clipboard that refuses has to be handled');
});

test('a refused clipboard puts the text back instead of swallowing it', async () => {
  const share = "We're on for Sat 10 Oct, afternoon - Dinner at mine. 5 free. https://x/g/kit-jo";
  const snacks = [];
  const said = [];
  const addPlanFlow = loadAddPlanFlow({
    prompt: () => 'Dinner at mine',
    mutate: async () => ({ ok: true, share, ack: share }),
    showSnack: (text, label, action) => snacks.push({ text, label, action }),
    // An insecure context has no clipboard object at all: reading .writeText off
    // it throws synchronously, which no .catch() would ever see.
    navigator: {},
    say: (t) => said.push(t),
  });
  await addPlanFlow(SAT, 'AFTERNOON');
  snacks[0].action();
  assert.equal(snacks.length, 2, 'the line is shown again - showSnack had removed it');
  assert.equal(snacks[1].text, share, 'and it is the whole line, still long-pressable');
  assert.match(said.join(' '), /Could not copy/, 'and the failure is announced, not silent');
});

test('a clipboard that rejects is handled the same way as one that throws', async () => {
  const share = 'pasteable line';
  const snacks = [];
  const said = [];
  const addPlanFlow = loadAddPlanFlow({
    prompt: () => 'Dinner at mine',
    mutate: async () => ({ ok: true, share, ack: share }),
    showSnack: (text, label, action) => snacks.push({ text, label, action }),
    navigator: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } },
    say: (t) => said.push(t),
  });
  await addPlanFlow(SAT, 'AFTERNOON');
  snacks[0].action();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(snacks.length, 2, 'a denied permission re-shows the line too');
  assert.match(said.join(' '), /Could not copy/);
});
