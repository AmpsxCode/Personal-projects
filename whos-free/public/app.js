// Who's Free - the client.
//
// No third-party JavaScript, no bundler, no build step. Plain ES modules loaded
// straight from the static asset layer.

import {
  MONTHS_LONG, addDays, addMonths, compare, diffDays, format, formatLong,
  formatMedium, formatMonth, formatShort, monthGrid, mondayIndex, ordinalDay,
  parse, range, relativeAge, startOfWeek, weekdayName,
} from './shared/plainday.js';
import {
  BUSY, FREE, MAYBE, PATTERN_KEYS, buildBands, formatTally, myFreeSlots,
  names, nextConfirmWindow, patternKey, slotLabel, slotTitle, slotsFor, tally,
} from './shared/tally.js';
import { CONFIG, COPY, HORIZON_DAYS, SLOT_WINDOWS } from './shared/config.js';
import { nowMs, today as londonToday } from './shared/clock.js';

const app = document.getElementById('app');
const noSession = document.getElementById('noSession');
const live = document.getElementById('live');

const store = {
  state: null,
  etag: null,
  today: londonToday(),
  route: location.pathname,
  month: null,           // {y,m} for the month view
  weekStart: null,
  selection: new Set(),
  selectMode: false,
  rangeMode: false,
  rangeAnchor: null,
  lastBulk: null,        // stays reversible after the snackbar has gone
  ack: null,
  showAll: null,         // headcount of the one expanded band, or null
  expanded: new Set(),
  nudgeDismissed: false,
  polling: null,
  offline: false,
};

const say = (msg) => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------- offline queue --

const DB_NAME = 'whos-free';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbPromise;
}

async function enqueue(item) {
  const d = await db();
  if (!d) return;
  await new Promise((resolve) => {
    const tx = d.transaction('queue', 'readwrite');
    tx.objectStore('queue').add(item);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

async function queued() {
  const d = await db();
  if (!d) return [];
  return new Promise((resolve) => {
    const tx = d.transaction('queue', 'readonly');
    const req = tx.objectStore('queue').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function dequeue(seq) {
  const d = await db();
  if (!d) return;
  const tx = d.transaction('queue', 'readwrite');
  tx.objectStore('queue').delete(seq);
}

/**
 * Replay the queue in the order it was made. queued_at orders the client's own
 * batch and nothing else - the server always stamps updated_at itself and takes
 * last arrival. Never trust a client clock to resolve a conflict between two
 * people: one friend with a phone a day fast would win every conflict forever.
 */
async function drain() {
  const items = (await queued()).sort((a, b) => a.queuedAt - b.queuedAt);
  for (const item of items) {
    try {
      const res = await fetch(item.url, {
        method: item.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.body),
      });
      if (res.ok || (res.status >= 400 && res.status < 500)) await dequeue(item.seq);
      else return;
    } catch { return; }
  }
  if (items.length) { store.etag = null; await load(); }
}

// -------------------------------------------------------------------- network --

async function load() {
  const params = new URLSearchParams({ today: store.today });
  const headers = {};
  if (store.etag) headers['If-None-Match'] = store.etag;
  let res;
  try {
    res = await fetch(`/api/state?${params}`, { headers });
  } catch {
    store.offline = true;
    if (!store.state) {
      showProblem('No connection', "Couldn't reach the app. Check your signal and try again.");
    } else {
      render();
    }
    return;
  }
  store.offline = false;
  if (res.status === 304) return;
  if (res.status === 401) { showNoSession(); return; }
  if (!res.ok) {
    // A 5xx here is usually the Worker itself failing, and the body is often
    // an HTML page rather than JSON - so surface the status rather than trying
    // to parse it.
    const detail = `The server answered with error ${res.status}.`
      + (res.status >= 500 ? ' Check your Worker\u2019s Logs in the Cloudflare dashboard.' : '');
    if (!store.state) showProblem("The app couldn't load", detail);
    else say(`Couldn't refresh (error ${res.status}). Still showing what I had.`);
    return;
  }
  store.etag = res.headers.get('ETag');
  try {
    store.state = await res.json();
  } catch {
    showProblem("The app couldn't load", 'The server sent something unreadable. Check the Worker Logs.');
    return;
  }
  if (!store.month) store.month = { y: parse(store.today).y, m: parse(store.today).m };
  if (!store.weekStart) store.weekStart = format(startOfWeek(parse(store.today)));
  render();
}

/**
 * A mutation. Optimistic locally, queued if offline, and always carrying an
 * opId so a replay cannot double-apply.
 */
async function mutate(url, body, { method = 'POST', optimistic } = {}) {
  const opId = crypto.randomUUID();
  const payload = { ...body, opId, today: store.today };
  if (optimistic) { optimistic(); render(); }
  try {
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (res.status === 401) { showNoSession(); return null; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { say(data.message || 'That did not save.'); store.etag = null; await load(); return null; }
    if (data.ack) { store.ack = data.ack; say(data.ack); }
    store.etag = null;
    await load();
    return data;
  } catch {
    // A tap must never fail on the Tube.
    await enqueue({ url, method, body: payload, queuedAt: nowMs() });
    store.offline = true;
    say('Saved on your phone - it will sync when you have signal.');
    render();
    return null;
  }
}

function showNoSession() {
  noSession.hidden = false;
  app.hidden = true;
  stopPolling();
}

/**
 * The visible failure state.
 *
 * Both #noSession and #app start hidden, and say() writes to a
 * screen-reader-only region - so any error path that just returns leaves a
 * blank white page with no clue what happened. That is the worst possible
 * failure, so every path that cannot render the app has to come through here.
 */
function showProblem(title, detail) {
  noSession.hidden = false;
  app.hidden = true;
  noSession.innerHTML = `<h1>${esc(title)}</h1>`
    + `<p class="lede">${esc(detail)}</p>`
    + '<button class="btn primary" onclick="location.reload()">Try again</button>';
  stopPolling();
  say(`${title}. ${detail}`);
}

// ---------------------------------------------------------------- polling ----

function startPolling() {
  stopPolling();
  // Only while the tab is visible. Never poll a hidden tab.
  if (document.visibilityState !== 'visible') return;
  store.polling = setInterval(load, CONFIG.POLL_MS);
}
function stopPolling() { if (store.polling) clearInterval(store.polling); store.polling = null; }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { load(); drain(); startPolling(); } else stopPolling();
});
window.addEventListener('focus', () => { load(); drain(); });
window.addEventListener('online', drain);

// ------------------------------------------------------------------ helpers --

const S = () => store.state;
const roster = () => (S() ? S().members : []);
const me = () => (S() ? S().me : null);
const quorum = () => (S() ? S().group.quorum : CONFIG.DEFAULT_QUORUM);

function entriesFor(day, slot) {
  const s = S();
  return (s && s.days[day] && s.days[day][slot]) ? s.days[day][slot] : {};
}

function myMark(day, slot) {
  const e = entriesFor(day, slot)[me()];
  return e || null;
}

/** Which of the eight rendered variants a single person's entry is. */
function variantOf(entry) {
  if (!entry || !entry.s) return 'notAnswered';
  if (entry.src === 'PATTERN') return entry.s === FREE ? 'dimFree' : entry.s === MAYBE ? 'dimMaybe' : 'dimBusy';
  if (entry.stale) return entry.s === FREE ? 'dimFree' : entry.s === MAYBE ? 'dimMaybe' : 'dimBusy';
  return entry.s === FREE ? 'free' : entry.s === MAYBE ? 'maybe' : 'busy';
}

// The glyph is a real channel, so assumed/stale use a DIFFERENT MARK, not the
// same mark in a lighter weight - a font-weight difference vanishes in a
// greyscale screenshot and at 12px. Brackets also read as "provisional", which
// is what an assumed or stale value is.
const GLYPHS = {
  notAnswered: '', free: '✓', maybe: '~', busy: '✕',
  dimFree: '(✓)', dimMaybe: '(~)', dimBusy: '(✕)',
  partly: '◐', everyone: '★',
};
const OUTLINED = new Set(['dimFree', 'dimMaybe', 'dimBusy']);
const VARIANT_LABEL = {
  notAnswered: COPY.NOT_ANSWERED, free: 'Free', maybe: 'Maybe', busy: 'Busy',
  dimFree: 'Assumed free', dimMaybe: 'Assumed maybe', dimBusy: 'Assumed busy',
  partly: 'Partly free', everyone: 'Everyone free',
};

function swatch(variant, extra = '') {
  const everyone = extra.includes('v-everyone');
  const g = everyone ? GLYPHS.everyone : GLYPHS[variant];
  const label = everyone ? VARIANT_LABEL.everyone : VARIANT_LABEL[variant];
  const cls = OUTLINED.has(variant) ? 'glyph glyph-outline' : 'glyph';
  return `<span class="v v-${variant} ${extra}" role="img" aria-label="${esc(label)}">`
    + (g ? `<span class="${cls}" aria-hidden="true">${g}</span>` : '') + '</span>';
}

/**
 * The day-level roll-up shown in a month cell.
 *
 * The NUMERAL is the primary encoding; this fill is redundant reinforcement, so
 * it uses a five-step ramp inside the free hue. It must never reuse the maybe
 * or busy fill to mean "a couple of people are free" - the legend sits directly
 * above the grid and promises those colours mean something else.
 */
function dayRollup(day) {
  const slots = slotsFor(day);
  const tallies = slots.map((slot) => tally(entriesFor(day, slot), roster()));
  const total = roster().length;
  const counts = tallies.map((t) => t.free);
  const best = Math.max(...counts, 0);
  const worst = Math.min(...counts, 0);
  const anyAnswer = tallies.some((t) => t.notAnswered < total);

  if (!anyAnswer) return { variant: 'notAnswered', best: 0, ramp: 0 };
  if (best === total && total > 0) return { variant: 'free', best, everyone: true, ramp: 5 };
  if (slots.length > 1 && best !== worst && best > 0) return { variant: 'partly', best, ramp: 0 };
  if (best === 0) {
    // "Nobody is free" and "hardly anyone has said" look identical in a count,
    // but they are not the same thing and must not look the same. The dark
    // busy fill is loud, so it is reserved for days where at least half the
    // group has EXPLICITLY said busy. Anything less reads as quiet, not blocked.
    const explicitBusy = Math.max(...tallies.map((t) => t.busy), 0);
    if (total > 0 && explicitBusy >= Math.ceil(total / 2)) return { variant: 'busy', best: 0, ramp: 0 };
    return { variant: 'notAnswered', best: 0, ramp: 0 };
  }
  const ramp = Math.min(5, Math.max(1, Math.ceil((best / Math.max(1, total)) * 5)));
  return { variant: `roll${ramp}`, best, ramp };
}

/**
 * The people who are free (or maybe) on a day, for the stacked bars in a month
 * cell. One bar each, in their own hue, so a good weekend visibly fills up with
 * colour and a dead Tuesday stays empty.
 *
 * Decoration only — the cell's accessible name carries the real numbers, and
 * hue is never the only way to identify anyone (their name is on the chip row
 * and in the day sheet).
 */
function dayPeople(day) {
  const out = [];
  for (const person of roster()) {
    let best = null;
    for (const slot of slotsFor(day)) {
      const e = entriesFor(day, slot)[person.id];
      if (!e || !e.s) continue;
      if (e.s === FREE && e.src === 'EXPLICIT' && !e.stale) { best = 'free'; break; }
      if (e.s === FREE || e.s === MAYBE) best = best || 'soft';
    }
    if (best) out.push({ id: person.id, seed: person.colourSeed, soft: best === 'soft' });
  }
  return out;
}

function plansOn(day) {
  const s = S();
  return s ? s.plans.filter((p) => p.day === day) : [];
}

function coverage() {
  const mine = roster().find((p) => p.id === me());
  const through = mine ? mine.confirmedThrough : null;
  if (!through) return { level: 'none', text: 'Nobody knows when you’re free', through: null, days: 0 };
  const daysAhead = diffDays(parse(store.today), parse(through));
  if (daysAhead >= CONFIG.COVERAGE_TARGET_DAYS) {
    return { level: 'ok', text: `You’re filled in for the next ${Math.floor(daysAhead / 7)} weeks`, through, days: daysAhead };
  }
  if (daysAhead < 7) {
    return { level: 'soon', text: `You’re only filled in until ${weekdayName(parse(through), true)}`, through, days: daysAhead };
  }
  return { level: 'mid', text: `You’re filled in until ${formatShort(through)}`, through, days: daysAhead };
}

// -------------------------------------------------------------------- render --

function render() {
  if (!S()) return;
  noSession.hidden = true;
  app.hidden = false;
  const path = store.route;
  document.body.classList.toggle('has-bottom', store.selectMode || path === '/month' || path === '/week');
  if (path === '/setup') app.innerHTML = viewSetup();
  else if (path === '/confirm') app.innerHTML = viewConfirm();
  else if (path === '/month') app.innerHTML = viewMonth();
  else if (path === '/week') app.innerHTML = viewWeek();
  else app.innerHTML = viewHome();
  wire();
}

function nav(path, replace = false) {
  store.route = path;
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  window.scrollTo(0, 0);
  render();
}
window.addEventListener('popstate', () => { store.route = location.pathname; render(); });

function tabbar(active) {
  const tab = (path, label) => `<button class="btn ${active === path ? '' : 'ghost'}" data-nav="${path}"
    ${active === path ? 'aria-current="page"' : ''}>${label}</button>`;
  return `<nav class="tabbar">${tab('/', 'Best days')}${tab('/week', 'Week')}${tab('/month', 'Month')}</nav>`;
}

// ---------------------------------------------------------------- home view --

function viewHome() {
  const s = S();
  const cov = coverage();
  const { bands, maybeDependent, closest } = buildBands(
    s.days, roster(), quorum(), s.from, s.to, CONFIG.BAND_CAP,
  );
  const quick = myFreeSlots(s.days, me(), store.today, CONFIG.QUICK_CHANGE_SLOTS, HORIZON_DAYS);
  const total = roster().length;

  const avatars = roster().map((p) => {
    const filled = p.confirmedThrough
      && diffDays(parse(store.today), parse(p.confirmedThrough)) >= CONFIG.RING_FILLED_DAYS;
    const label = p.confirmedThrough
      ? `${p.name}, filled in until ${formatMedium(p.confirmedThrough)}`
      : `${p.name}, hasn't filled anything in`;
    return `<button class="person-chip ${filled ? 'filled' : 'hollow'}" data-nudge="${esc(p.id)}"
      style="--seed:${Number(p.colourSeed) || 0}"
      title="${esc(label)}" aria-label="${esc(label)}. Copy a nudge to send them.">
      <span class="dot" aria-hidden="true"></span>${esc(p.name)}${
  filled ? '<span class="tick" aria-hidden="true">✓</span>' : ''}</button>`;
  }).join('');

  const plans = s.plans.length ? `<div class="plan-strip" aria-label="Plans coming up">${
    s.plans.map((p) => `<button class="plan-pill" data-open="${esc(p.day)}"
      aria-label="${esc(p.title)} on ${esc(slotTitle(p.day, p.slot))}. Open that day.">
      <span class="plan-title">${esc(p.title)}</span>
      <span class="plan-when">${esc(formatShort(p.day))} · ${esc(slotLabel(p.slot))}</span>
    </button>`).join('')}</div>` : '';

  // One band is expanded at a time because store.showAll holds a single
  // headcount: on a phone, two fully expanded bands is a scroll wall.
  const bandHtml = bands.map((band) => {
    const open = store.showAll === band.count;
    const shown = open ? band.allRows : band.rows;
    return `
    <section class="band">
      <div class="band-head">
        <h2>${esc(band.label)}${band.everyone ? ' <span class="star" aria-hidden="true">★</span>' : ''}</h2>
        ${band.maybeTotal ? `<span class="band-maybe">(+${band.maybeTotal} maybe)</span>` : ''}
      </div>
      ${shown.map((r, i) => slotRow(r, i === 0 && band === bands[0])).join('')}
      ${band.hidden ? `<button class="btn small ghost" data-showall="${band.count}"
        data-showtotal="${band.allRows.length}" aria-expanded="${open}">${
  open ? 'Show fewer' : `Show all ${band.allRows.length}`}</button>` : ''}
    </section>`;
  }).join('');

  const maybeHtml = maybeDependent.length ? `
    <section class="band">
      <div class="band-head"><h2>Could work if the maybes are in 🤞</h2></div>
      ${maybeDependent.slice(0, CONFIG.BAND_CAP).map((r) => slotRow(r, false)).join('')}
    </section>` : '';

  const closestHtml = closest.length ? `
    <section class="band">
      <div class="band-head"><h2>Nothing hits ${quorum()} yet — closest options</h2></div>
      ${closest.map((r) => slotRow(r, false)).join('')}
    </section>` : '';

  // Displayed without the trailing link, which is long and adds nothing on a
  // screen you are already looking at. Copy still puts the full text, link
  // included, on the clipboard.
  const nudgeShown = s.nudge ? s.nudge.text.split('\n').filter((l) => !/^Update yours:/.test(l)).join('\n') : '';
  const nudge = (s.nudge && !store.nudgeDismissed) ? `
    <section class="ack">
      <strong>This week’s nudge 💬</strong>
      <p class="hint" style="white-space:pre-line">${esc(nudgeShown)}</p>
      <div class="row">
        <button class="btn small" data-copy="nudge">Copy for the group chat</button>
        <button class="btn small ghost" data-dismiss="nudge">Dismiss</button>
      </div>
    </section>` : '';

  return `
  <header class="head">
    <div class="head-row">
      <h1>${esc(s.group.name)}</h1>
      <button class="btn small ghost" data-nav="/settings" data-settings="1" aria-label="Settings">⚙︎</button>
    </div>
  </header>
  <div class="people" aria-label="Everyone in the group">${avatars}</div>
  </header>

  <div class="coverage ${cov.level}">
    <span>${esc(cov.text)}</span>
    <button class="btn small primary" data-nav="/confirm">Add 2 more weeks</button>
  </div>

  ${quick.length ? `<div class="strip" aria-label="Something came up">${quick.map((q) => `
    <span class="chip">${esc(weekdayName(parse(q.day)))} ${esc(ordinalDay(q.day))} ${esc(slotLabel(q.slot))} · free
      <button class="btn small" data-busy="${esc(q.day)}|${esc(q.slot)}">actually, busy</button></span>`).join('')}</div>` : ''}

  ${store.ack ? `<div class="ack">${esc(store.ack)}</div>` : ''}
  ${store.offline ? '<div class="ack">Offline — your taps are saved and will sync.</div>' : ''}
  ${plans}
  ${bandHtml}${maybeHtml}${closestHtml}
  ${nudge}
  ${tabbar('/')}
  <p class="hint pad">Slot times: morning ${SLOT_WINDOWS.MORNING.from}–${SLOT_WINDOWS.MORNING.to},
    afternoon ${SLOT_WINDOWS.AFTERNOON.from}–${SLOT_WINDOWS.AFTERNOON.to},
    evening ${SLOT_WINDOWS.EVENING.from}–${SLOT_WINDOWS.EVENING.to}. ${total} in the group.</p>`;
}

// "missing" is the word that turns an answer into a failure, so this line never
// uses it. Kit blocking out six straight weeks on day one ANSWERED - he should
// not read as the same kind of gap as Sam, who has never opened the app - and a
// value the app derived from someone's typical week is the app's guess, not
// their omission. One clause per bucket, in this order; `free` is deliberately
// absent because this line exists to say who still needs chasing.
const WHO_CLAUSES = [
  ['busy', "can't make it"],
  ['maybe', 'maybe'],
  ['notAnswered', 'no answer yet'],
  ['assumed', 'not confirmed'],
  ['stale', 'worth a re-check'],
];

/**
 * "can't make it: Kit · maybe: Sam · not confirmed: Jo" - HTML, names escaped.
 *
 * The buckets partition the roster, so naming each one separately also fixes
 * the double-print: a maybe-person used to appear in the missing list AND in a
 * trailing maybe clause. Nobody is named twice here.
 */
function slotWho(t, people) {
  const parts = WHO_CLAUSES
    .filter(([bucket]) => t.by[bucket].length)
    .map(([bucket, label]) => `${label}: <em>${esc(names(people, t.by[bucket]))}</em>`);
  return parts.length ? parts.join(' · ') : 'everyone’s in';
}

function slotRow(r, isTop) {
  const key = `${r.day}|${r.slot}`;
  const open = store.expanded.has(key);
  return `
  <button class="slot-row ${isTop ? 'top' : ''}" data-expand="${esc(key)}" aria-expanded="${open}">
    <span class="slot-title">${esc(slotTitle(r.day, r.slot))}</span>
    <span class="slot-sub">${slotWho(r.t, roster())}</span>
    <span class="slot-sub">${esc(formatTally(r.t))}</span>
    ${open ? breakdown(r) : ''}
  </button>`;
}

/** Named lists, never counts alone - in a group of seven, WHO is the question. */
function breakdown(r) {
  const groups = [
    ['Free', r.t.by.free, 'free'], ['Maybe', r.t.by.maybe, 'maybe'], ['Busy', r.t.by.busy, 'busy'],
    ['Not confirmed (from their typical week)', r.t.by.assumed, null],
    ['Worth a re-check', r.t.by.stale, null],
    [COPY.NOT_ANSWERED, r.t.by.notAnswered, 'notAnswered'],
  ];
  const body = groups.filter(([, ids]) => ids.length).map(([label, ids, variant]) => {
    const items = ids.map((id) => {
      const person = roster().find((p) => p.id === id);
      const entry = entriesFor(r.day, r.slot)[id];
      // Assumed and stale share one bucket but have two directions, so the
      // glyph carries which way round it is per person.
      const v = variant || variantOf(entry);
      const age = entry && entry.at ? ` <span class="person-age">${esc(relativeAge(entry.at, nowMs()))}</span>` : '';
      return `<span class="person-line">${swatch(v)}${esc(person ? person.name : id)}${age}</span>`;
    }).join('');
    return `<dt>${esc(label)}</dt><dd>${items}</dd>`;
  }).join('');
  const nudges = r.t.by.notAnswered.map((id) => {
    const person = roster().find((p) => p.id === id);
    return `<button class="btn small ghost" data-nudge="${esc(id)}">Nudge ${esc(person ? person.name : '')}</button>`;
  }).join(' ');
  // This markup is emitted INSIDE <button class="slot-row" data-expand=...>, and
  // the HTML parser auto-closes that outer button at the first nested <button> -
  // so everything in this row parses as a SIBLING of .slot-row and
  // closest('[data-expand]') does not match it. That is why data-open works, and
  // why the plan action belongs in this same row rather than nested any deeper.
  return `<dl class="breakdown">${body}</dl>
    <div class="row" style="margin-top:8px;flex-wrap:wrap">${nudges}
    <button class="btn small" data-makeplan="${esc(r.day)}|${esc(r.slot)}"
      aria-label="Make ${esc(formatShort(r.day))} ${esc(slotLabel(r.slot))} the plan">Make this the plan</button>
    <button class="btn small" data-open="${esc(r.day)}">Open ${esc(formatShort(r.day))}</button></div>`;
}

// --------------------------------------------------------------- month view --

function viewMonth() {
  const cells = monthGrid(store.month);
  const headers = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const rows = [];
  for (let i = 0; i < 42; i += 7) rows.push(cells.slice(i, i + 7));

  const body = rows.map((week) => `<tr>${week.map((c) => {
    const roll = dayRollup(c.key);
    const isToday = c.key === store.today;
    const mine = myMark(c.key, 'EVENING');
    const sel = store.selection.has(c.key);
    const slots = slotsFor(c.key);
    const people = dayPeople(c.key);
    const plans = plansOn(c.key);
    // At most five bars: beyond that they stop being countable at this size and
    // the numeral is doing the work anyway.
    const bars = people.length
      ? `<span class="cell-people" aria-hidden="true">${people.slice(0, 5).map((pp) => `<i class="person-bar${
        pp.soft ? ' soft' : ''}" style="--seed:${Number(pp.seed) || 0}"></i>`).join('')}</span>`
      : '<span class="cell-people" aria-hidden="true"></span>';
    const planPill = plans.length
      ? `<span class="cell-plan" aria-hidden="true">${esc(plans[0].title)}</span>`
      : '';
    const myVariant = variantOf(mine);
    // Self-sufficient accessible name: weekday, date, month, my state, group
    // count, and anything planned. A screen reader user should never have to
    // explore the headers to know where they are.
    const label = `${isToday ? 'Today, ' : ''}${formatLong(c.key)}. You: ${VARIANT_LABEL[myVariant]}. `
      + `${roll.best} of ${roster().length} free.${plans.length ? ` Plan: ${plans[0].title}.` : ''}`;
    return `<td class="cell-wrap"><button class="cell v v-${roll.variant} ${isToday ? 'cell-today' : ''} ${
      c.inMonth ? '' : 'cell-out'} ${sel ? 'cell-sel' : ''} ${roll.everyone ? 'v-everyone' : ''}"
      data-day="${esc(c.key)}" tabindex="-1" aria-label="${esc(label)}"
      ${sel ? 'aria-selected="true"' : ''}>
      <span class="cell-head">
        <span class="cell-num">${c.day.d}</span>
        <span class="cell-count">${roll.everyone ? '★' : ''}${roll.best || ''}</span>
      </span>
      ${bars}${planPill}</button></td>`;
  }).join('')}</tr>`).join('');

  return `
  <header class="head"><div class="head-row"><h1>${esc(formatMonth(store.month))}</h1>
    <button class="btn small ghost" data-nav="/">Best days</button></div></header>
  <div class="month">
    <table role="${store.selectMode ? 'grid' : 'table'}" ${store.selectMode ? 'aria-multiselectable="true"' : ''}
      aria-label="${esc(formatMonth(store.month))}">
      <thead><tr>${headers.map((h, i) => `<th scope="col"><button type="button" data-col="${i}"
        aria-label="Fill every ${h} in ${esc(formatMonth(store.month))}">${h}</button></th>`).join('')}</tr></thead>
      <tbody id="grid">${body}</tbody>
    </table>
  </div>
  ${legend()}
  ${bottomBar()}`;
}

function legend() {
  const items = ['free', 'maybe', 'busy', 'notAnswered', 'dimFree', 'dimBusy', 'partly'];
  return `<div class="legend" aria-label="What the colours mean">${items.map((v) => `
    <span class="legend-item">${swatch(v)}<span>${esc(VARIANT_LABEL[v])}</span></span>`).join('')}
    <span class="legend-item">${swatch('free', 'v-everyone')}<span>Everyone free</span></span>
    <span class="legend-item"><span class="legend-ramp" aria-hidden="true">${
  [1, 2, 3, 4, 5].map((n) => `<i class="v-roll${n}"></i>`).join('')}</span>
    <span>Fewer &rarr; more free (the number is what counts)</span></span></div>`;
}

function bottomBar() {
  if (store.selectMode) {
    const n = store.selection.size;
    return `<div class="bottom">
      <div class="row">
        <button class="btn" data-bulk="FREE">Free</button>
        <button class="btn" data-bulk="MAYBE">Maybe</button>
        <button class="btn" data-bulk="BUSY">Busy</button>
      </div>
      <div class="row">
        <button class="btn ghost" data-bulk="CLEAR">Clear</button>
        <button class="btn ghost" data-selectmode="off">Cancel</button>
      </div>
      <div class="row">
        <button class="btn small ${store.rangeMode ? '' : 'ghost'}" data-range="1"
          aria-pressed="${store.rangeMode}">Range</button>
        <button class="btn small ${store.eveningsOnly ? '' : 'ghost'}" data-evenings="1"
          aria-pressed="${!!store.eveningsOnly}">Evenings only</button>
        <span class="hint">${n} day${n === 1 ? '' : 's'}${store.rangeLabel ? ` · ${esc(store.rangeLabel)}` : ''}</span>
      </div>
    </div>`;
  }
  const isMonth = store.route === '/month';
  return `<div class="bottom">
    <div class="row">
      ${isMonth ? '<button class="btn ghost" data-month="-1" aria-label="Previous month">‹</button>' : ''}
      <button class="btn" data-selectmode="on" aria-pressed="false">Select days</button>
      ${isMonth ? '<button class="btn ghost" data-month="1" aria-label="Next month">›</button>' : ''}
    </div>
    <div class="row">
      <button class="btn ghost" data-nav="/">Best days</button>
      <button class="btn ghost" data-nav="/week">Week</button>
      <button class="btn ghost" data-nav="/month">Month</button>
    </div>
    ${store.lastBulk ? '<div class="row"><button class="btn ghost" data-undo="1">Undo last bulk change</button></div>' : ''}
  </div>`;
}

// ---------------------------------------------------------------- week view --

function viewWeek() {
  const start = parse(store.weekStart);
  const days = range(format(start), format(addDays(start, 20)));   // three weeks
  const rows = days.map((day) => {
    const slots = slotsFor(day);
    const plans = plansOn(day);
    const planRow = plans.length
      ? `<div class="week-plans">${plans.map((p) => `<span class="week-plan">${esc(p.title)}</span>`).join('')}</div>`
      : '';
    return `<div class="week-row">
      <div class="week-label">${esc(formatShort(day))}</div>
      <div class="week-slots">${slots.map((slot) => {
      const v = variantOf(myMark(day, slot));
      const t = tally(entriesFor(day, slot), roster());
      return `<button class="week-slot v v-${v}" data-slot="${esc(day)}|${esc(slot)}"
          aria-label="${esc(formatLong(day))} ${esc(slotLabel(slot))}. You: ${esc(VARIANT_LABEL[v])}. ${t.free} of ${roster().length} free.">
          <span>${esc(slotLabel(slot).slice(0, 3))} ${t.free || ''}</span></button>`;
    }).join('')}</div>
    </div>${planRow}`;
  }).join('');
  return `<header class="head"><div class="head-row"><h1>Three weeks</h1>
      <button class="btn small ghost" data-nav="/">Best days</button></div>
      <p class="hint">Tap any slot to cycle it through free, maybe, busy. This is the fastest way to fill in a lot at once.</p>
    </header>
    <div class="pad">${rows}</div>
    ${legend()}
    ${bottomBar()}`;
}

// --------------------------------------------------------------- setup view --

function viewSetup() {
  const three = (key, value) => `
    <div class="seg" role="radiogroup" aria-label="${esc(key.replace('_', ' ').toLowerCase())}">
      ${[['free', true, 'Usually free'], ['busy', false, 'Usually busy'], ['none', null, 'Don’t assume']]
    .map(([cls, val, label]) => `<label class="${cls === 'none' ? '' : cls}">
        <input type="radio" name="${esc(key)}" value="${val === null ? 'null' : val}"
          ${value === val ? 'checked' : ''}><span>${label}</span></label>`).join('')}
    </div>`;

  const pattern = store.pattern || {};
  const rowFor = (key, label) => `<div class="toggle-row"><span class="name">${label}</span>${three(key, pattern[key] === undefined ? null : pattern[key])}</div>`;

  return `<main class="pad">
    <h1>Which evenings are you usually free?</h1>
    <p class="lede">A rough pattern is enough. We’ll assume it going forward and you can change any single day later.</p>

    <div class="quickfill">
      <strong>All five weekday evenings at once</strong>
      <div class="seg" style="margin-top:6px">
        <button class="btn small" data-quick="weekday|true">Usually free</button>
        <button class="btn small ghost" data-quick="weekday|false">Usually busy</button>
        <button class="btn small ghost" data-quick="weekday|null">Don’t assume</button>
      </div>
    </div>
    ${['MON', 'TUE', 'WED', 'THU', 'FRI'].map((d) => rowFor(`${d}_EVENING`, d[0] + d.slice(1).toLowerCase())).join('')}

    <h2>Weekends?</h2>
    <div class="quickfill">
      <strong>All six weekend slots at once</strong>
      <div class="seg" style="margin-top:6px">
        <button class="btn small" data-quick="weekend|true">Usually free</button>
        <button class="btn small ghost" data-quick="weekend|false">Usually busy</button>
        <button class="btn small ghost" data-quick="weekend|null">Don’t assume</button>
      </div>
    </div>
    ${['SAT_MORNING', 'SAT_AFTERNOON', 'SAT_EVENING', 'SUN_MORNING', 'SUN_AFTERNOON', 'SUN_EVENING']
    .map((k) => rowFor(k, k.replace('_', ' ').toLowerCase().replace(/^(sat|sun)/, (m) => m[0].toUpperCase() + m.slice(1)))).join('')}

    <p class="hint">${esc(COPY.SETUP_FOOTER)} A blank stays blank — it never becomes “busy”.</p>
    <button class="btn primary wide" data-savepattern="1" style="margin-top:12px">Save and see the best days</button>
  </main>`;
}

// ------------------------------------------------------------- confirm view --

function viewConfirm() {
  const s = S();
  const mine = roster().find((p) => p.id === me());
  const win = nextConfirmWindow(
    mine ? mine.confirmedThrough : null, store.today, CONFIG.CONFIRM_DAYS, HORIZON_DAYS,
  );
  if (!win.from) {
    return `<main class="pad">
      <h1>You're all caught up 🌿</h1>
      <p class="lede">You're filled in as far ahead as this app looks — through
        ${esc(formatMedium(win.horizonEnd))}. Nothing to confirm.</p>
      <button class="btn primary wide" data-nav="/">Back to best days</button>
    </main>`;
  }
  store.confirmFrom = win.from;
  store.confirmTo = win.to;
  const to = win.to;
  const unknown = [];
  const guessed = [];
  for (const day of range(win.from, to)) {
    for (const slot of slotsFor(day)) {
      const mine = entriesFor(day, slot)[me()];
      const override = store.overrides && store.overrides[`${day}|${slot}`];
      if (override) { guessed.push({ day, slot, entry: { s: override, src: 'EXPLICIT' }, overridden: true }); continue; }
      if (!mine) unknown.push({ day, slot });
      else if (mine.src === 'EXPLICIT' && !mine.stale) guessed.push({ day, slot, entry: mine, solid: true });
      else guessed.push({ day, slot, entry: mine });
    }
  }

  const rowFor = ({ day, slot, entry, solid, overridden }) => {
    const v = variantOf(entry);
    return `<div class="toggle-row">
      <span class="name">${esc(formatShort(day))}<br><span class="hint">${esc(slotLabel(slot))}</span></span>
      <div class="seg">
        ${[[FREE, 'free', 'Free'], [MAYBE, 'maybe', 'Maybe'], [BUSY, 'busy', 'Busy']].map(([st, cls, label]) => `
          <label class="${cls}"><input type="radio" name="c_${esc(day)}_${esc(slot)}" value="${st}"
            data-confirmrow="${esc(day)}|${esc(slot)}"
            ${entry && entry.s === st ? 'checked' : ''}><span>${label}</span></label>`).join('')}
      </div>
      ${solid ? '<span class="hint">✓</span>' : overridden ? '<span class="hint">set</span>' : ''}
    </div>`;
  };

  return `<main class="pad">
    <h1>${esc(formatShort(win.from))} to ${esc(formatShort(win.to))}</h1>
    <p class="lede">Confirming the next stretch after what you've already filled in.</p>
    ${unknown.length ? `
      <h2>We can’t guess these — ${unknown.length} to answer</h2>
      <p class="hint">Your typical week doesn’t say anything about these, and we won’t invent an answer.
        Leave them and you’ll show as “${esc(COPY.NOT_ANSWERED)}”.</p>
      ${unknown.map((u) => rowFor({ ...u, entry: store.overrides && store.overrides[`${u.day}|${u.slot}`] ? { s: store.overrides[`${u.day}|${u.slot}`], src: 'EXPLICIT' } : null })).join('')}
    ` : ''}
    <h2>We think this is you</h2>
    <p class="hint">Tap any row to change it before you confirm.</p>
    ${guessed.map(rowFor).join('')}
    <button class="btn primary wide" data-confirm="1" style="margin-top:14px">
      Yes, that’s right${unknown.length ? ` · ${unknown.length - Object.keys(store.overrides || {}).filter((k) => unknown.some((u) => `${u.day}|${u.slot}` === k)).length} left` : ''}
    </button>
    <button class="btn ghost wide" data-nav="/" style="margin-top:8px">Back</button>
  </main>`;
}

// ----------------------------------------------------------------- day sheet --

/**
 * The primary editing surface. A radio group per slot, persisted on selection,
 * no Save button. "Clear" is a separate small button, not a fourth segment:
 * four options stacked vertically would push a weekend day's three slots off a
 * 667px screen.
 */
function openDay(day) {
  const existing = document.getElementById('daySheet');
  if (existing) existing.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'daySheet';
  dialog.innerHTML = daySheetHtml(day);
  document.body.appendChild(dialog);
  dialog.showModal();
  wireDaySheet(dialog, day);
}

function daySheetHtml(day) {
  const slots = slotsFor(day);
  const plansHere = S().plans.filter((p) => p.day === day);
  return `<div class="sheet">
    <div class="sheet-head">
      <button class="btn small ghost" data-step="-1" aria-label="Previous day">‹</button>
      <h2>${esc(formatMedium(day))}</h2>
      <button class="btn small ghost" data-step="1" aria-label="Next day">›</button>
      <button class="btn small" data-close="1" aria-label="Close">Close</button>
    </div>
    <div class="sheet-body">
      ${slots.map((slot) => {
    const mine = myMark(day, slot);
    return `<fieldset class="slotset">
          <legend>${esc(slotLabel(slot))} <span class="hint" style="font-weight:400">${
      esc(SLOT_WINDOWS[slot].from)}–${esc(SLOT_WINDOWS[slot].to)}</span></legend>
          <div class="seg">
            ${[[FREE, 'free', 'Free'], [MAYBE, 'maybe', 'Maybe'], [BUSY, 'busy', 'Busy']].map(([st, cls, label]) => `
              <label class="${cls}"><input type="radio" name="${esc(day)}_${esc(slot)}" value="${st}"
                data-mark="${esc(day)}|${esc(slot)}" ${mine && mine.src === 'EXPLICIT' && mine.s === st ? 'checked' : ''}>
                <span>${label}</span></label>`).join('')}
          </div>
          <div class="slot-extra">
            <button class="clear-btn" data-clear="${esc(day)}|${esc(slot)}">Clear</button>
            <span class="hint">${esc(COPY.CLEAR_HELP)}</span>
          </div>
          <p class="hint">Maybe: ${esc(COPY.MAYBE_HELP)}</p>
          ${othersHtml(day, slot)}
          <button class="btn ghost wide" data-addplan="${esc(day)}|${esc(slot)}">+ Add a plan for the ${
      esc(slotLabel(slot))}</button>
        </fieldset>`;
  }).join('')}

      ${plansHere.length ? `<h4>Plans</h4>${plansHere.map((p) => `<div class="plan">
        <span><strong>${esc(p.title)}</strong>
        <span class="plan-when">${esc(slotLabel(p.slot))}</span></span>
        <button class="btn small ghost" data-plan-del="${esc(p.id)}"
          aria-label="Remove ${esc(p.title)}, ${esc(slotLabel(p.slot))}">Remove</button></div>`).join('')}` : ''}
    </div>
  </div>`;
}

/** Everyone else, ordered Free → Maybe → Busy → Assumed → Stale → Not answered. */
function othersHtml(day, slot) {
  const t = tally(entriesFor(day, slot), roster());
  const order = [
    ['Free', t.by.free], ['Maybe', t.by.maybe], ['Busy', t.by.busy],
    ['Assumed', t.by.assumed], ['Stale', t.by.stale],
  ];
  const blocks = order.filter(([, ids]) => ids.filter((id) => id !== me()).length)
    .map(([label, ids]) => `<h4>${esc(label)}</h4>${ids.filter((id) => id !== me()).map((id) => personLine(day, slot, id)).join('')}`)
    .join('');
  const silent = t.by.notAnswered.filter((id) => id !== me());
  const silentBlock = silent.length ? `<h4>${esc(COPY.NOT_ANSWERED)}</h4>${silent.map((id) => {
    const p = roster().find((x) => x.id === id);
    return `<span class="person-line">${swatch('notAnswered')}${esc(p ? p.name : id)}
      <button class="btn small ghost" data-nudge="${esc(id)}">Nudge</button></span>`;
  }).join('')}` : '';
  return `<div class="others"><p class="hint">${esc(formatTally(t))}</p>${blocks}${silentBlock}</div>`;
}

function personLine(day, slot, id) {
  const p = roster().find((x) => x.id === id);
  const entry = entriesFor(day, slot)[id];
  const v = variantOf(entry);
  const age = entry && entry.at ? relativeAge(entry.at, nowMs()) : (entry && entry.src === 'PATTERN' ? COPY.ASSUMED_HELP : '');
  return `<span class="person-line">${swatch(v)}${esc(p ? p.name : id)}
    ${age ? `<span class="person-age">${esc(age)}</span>` : ''}</span>`;
}

function wireDaySheet(dialog, day) {
  dialog.addEventListener('click', async (e) => {
    const close = e.target.closest('[data-close]');
    if (close) { dialog.close(); dialog.remove(); return; }
    const step = e.target.closest('[data-step]');
    if (step) {
      const next = format(addDays(parse(day), Number(step.dataset.step)));
      dialog.close(); dialog.remove(); openDay(next); return;
    }
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      const [d, slot] = clear.dataset.clear.split('|');
      await setMark(d, slot, null);
      dialog.querySelectorAll(`input[name="${d}_${slot}"]`).forEach((i) => { i.checked = false; });
      refreshSheet(dialog, day);
      return;
    }
    const addPlan = e.target.closest('[data-addplan]');
    if (addPlan) {
      const [d, s] = addPlan.dataset.addplan.split('|');
      await addPlanFlow(d, s);
      dialog.close(); dialog.remove(); return;
    }
    const delPlan = e.target.closest('[data-plan-del]');
    if (delPlan) { await deletePlan(delPlan.dataset.planDel); refreshSheet(dialog, day); return; }
    const nudgeBtn = e.target.closest('[data-nudge]');
    if (nudgeBtn) { await copyNudge(nudgeBtn.dataset.nudge); return; }
  });

  // Persist on selection, optimistically. No Save button.
  dialog.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-mark]');
    if (!input) return;
    const [d, slot] = input.dataset.mark.split('|');
    await setMark(d, slot, input.value);
    refreshSheet(dialog, day);
  });
}

function refreshSheet(dialog, day) {
  const scroll = dialog.querySelector('.sheet-body').scrollTop;
  dialog.innerHTML = daySheetHtml(day);
  dialog.querySelector('.sheet-body').scrollTop = scroll;
}

// -------------------------------------------------------------------- writes --

async function setMark(day, slot, state) {
  return mutate('/api/mark', { day, slot, state }, {
    optimistic: () => {
      const s = S();
      if (!s.days[day]) s.days[day] = {};
      if (!s.days[day][slot]) s.days[day][slot] = {};
      if (state === null) delete s.days[day][slot][me()];
      else s.days[day][slot][me()] = { s: state, src: 'EXPLICIT', stale: false, at: nowMs() };
    },
  });
}

async function bulkApply(state) {
  const days = [...store.selection].sort(compare);
  if (!days.length) { say('Pick some days first.'); return; }
  const value = state === 'CLEAR' ? null : state;
  const data = await mutate('/api/marks/bulk', {
    days, slots: null, state: value, eveningsOnly: !!store.eveningsOnly,
  });
  store.selection.clear();
  store.selectMode = false;
  store.rangeAnchor = null;
  store.rangeLabel = null;
  if (data && data.changed) {
    // Undo, not confirm. Confirmation dialogs on a seven-person availability
    // app are pure friction. The snackbar auto-hides after 8 seconds, but the
    // last bulk action stays reversible from the bottom bar until the next one:
    // a timed-only undo fails WCAG 2.2.1.
    store.lastBulk = data.changed;
    showSnack(data.ack || `${days.length} days updated`, 'Undo', undoBulk);
  }
  render();
}

/**
 * The requests one undo needs: one per (previous value, slot) pair.
 *
 * Keyed on the slot as well as the value because /api/marks/bulk CROSS-PRODUCTS
 * days x slots. A group naming two days and two slots would write its value to
 * all four pairs - including pairs it never touched - and a later CLEAR group
 * would then wipe the rows an earlier group had just restored. Naming exactly
 * one slot per request means the server's expansion can only ever land on pairs
 * that were really changed.
 *
 * Deliberately pure - no store, no DOM - so test/bulk-undo.test.js can lift it
 * out of this file and run the shipped code instead of a copy of it.
 */
function undoRequests(changed) {
  const groups = new Map();
  for (const c of changed) {
    const k = `${c.from === null ? 'CLEAR' : c.from}|${c.slot}`;
    if (!groups.has(k)) groups.set(k, { value: c.from, slot: c.slot, days: new Set() });
    groups.get(k).days.add(c.day);
  }
  // No eveningsOnly: that flag belongs to the original selection UI. On the way
  // back it would silently drop every morning and afternoon we owe someone.
  return [...groups.values()].map((g) => ({
    days: [...g.days],
    slots: [g.slot],
    state: g.value === undefined ? null : g.value,
  }));
}

async function undoBulk() {
  const changed = store.lastBulk;
  if (!changed) return;
  store.lastBulk = null;
  // Replay the previous values back through the same endpoint, one request per
  // (value, slot) group. No server-side undo token.
  for (const req of undoRequests(changed)) {
    await mutate('/api/marks/bulk', req);
  }
  say('Put back.');
  render();
}

let snackTimer = null;
function showSnack(text, actionLabel, action) {
  const old = document.getElementById('snack');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'snack';
  el.className = 'snack';
  el.innerHTML = `<span>${esc(text)}</span>${actionLabel ? '<button type="button">' + esc(actionLabel) + '</button>' : ''}`;
  if (actionLabel) el.querySelector('button').addEventListener('click', () => { el.remove(); action(); });
  document.body.appendChild(el);
  if (snackTimer) clearTimeout(snackTimer);
  snackTimer = setTimeout(() => el.remove(), 8000);
}

async function copyNudge(personId) {
  try {
    const res = await fetch(`/api/nudge/${personId}?today=${store.today}`);
    if (!res.ok) { say('Could not build a nudge.'); return; }
    const data = await res.json();
    await navigator.clipboard.writeText(data.text);
    showSnack(`Copied a nudge for ${data.to}. Send it to them only — never the group chat.`, null, null);
    say(`Nudge for ${data.to} copied.`);
  } catch {
    say('Could not copy. Long-press to copy manually.');
  }
}

/**
 * A plan always inherits a slot, it never guesses one.
 *
 * This used to ask a second question that DEFAULTED to 'evening', so the happy
 * path - accept the default - filed an afternoon's 5-of-7 under the evening.
 * The app wrote down a decision nobody made. Every caller now passes the slot
 * whose row the user was actually reading, so the fallback below is a guard
 * against a stale data attribute, not an option offered to anyone.
 */
async function addPlanFlow(day, slot) {
  const title = window.prompt('What is it? (everyone in the group can see this)');
  if (!title) return;
  const chosen = slot && slotsFor(day).includes(slot) ? slot : slotsFor(day)[slotsFor(day).length - 1];
  const data = await mutate('/api/plan', { day, slot: chosen, title });
  // The other six find out from the group chat, not from a polling window. The
  // clipboard write has to happen inside a fresh click handler with no await in
  // front of it - the only shape Safari honours - so it hangs off the snackbar
  // button rather than firing here. The text is in the snackbar either way, so
  // a refused clipboard still leaves something to long-press and copy.
  if (data && data.share) {
    showSnack(data.share, 'Copy for the group chat', () => {
      // showSnack has already removed the snackbar by the time this runs, so a
      // clipboard that refuses - insecure context, denied permission, or no
      // clipboard object at all - would take the only copy of the text away and
      // throw into nothing. Put it back and say what happened.
      const failed = () => {
        showSnack(data.share, null, null);
        say('Could not copy. Long-press the text to copy it manually.');
      };
      // NOT `await navigator.clipboard...`: the write is chained, never awaited,
      // because Safari only honours one made synchronously inside the gesture.
      try {
        navigator.clipboard.writeText(data.share)
          .then(() => say('Copied. Paste it into the group chat.'), failed);
      } catch { failed(); }
    });
  }
}

async function deletePlan(id) {
  const data = await mutate(`/api/plan/${id}`, {}, { method: 'DELETE' });
  if (data && data.previous) {
    // Name what went, slot included: on a day with a morning plan and an evening
    // one, "Plan removed" does not tell you whether you hit the right button.
    showSnack(`Removed "${data.previous.title}" (${slotLabel(data.previous.slot)})`, 'Undo',
      () => mutate('/api/plan', { ...data.previous }));
  }
}

// ------------------------------------------------------------------- wiring ---

/** Roving tabindex. Never aria-activedescendant. */
function setupRoving() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const cells = [...grid.querySelectorAll('.cell')];
  if (!cells.length) return;
  const start = cells.findIndex((c) => c.dataset.day === store.today);
  const initial = start >= 0 ? start : 0;
  cells.forEach((c, i) => { c.tabIndex = i === initial ? 0 : -1; });

  grid.addEventListener('keydown', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const i = cells.indexOf(cell);
    let next = null;
    if (e.key === 'ArrowRight') next = i + 1;
    else if (e.key === 'ArrowLeft') next = i - 1;
    else if (e.key === 'ArrowDown') next = i + 7;
    else if (e.key === 'ArrowUp') next = i - 7;
    else if (e.key === 'Home') next = i - (i % 7);
    else if (e.key === 'End') next = i - (i % 7) + 6;
    else if (e.key === 'PageDown') { stepMonth(1); return; }
    else if (e.key === 'PageUp') { stepMonth(-1); return; }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cell.click(); return; }
    else return;
    e.preventDefault();
    if (next < 0 || next >= cells.length) {
      stepMonth(next < 0 ? -1 : 1);
      return;
    }
    cells[i].tabIndex = -1;
    cells[next].tabIndex = 0;
    cells[next].focus();
    // Keep the focused cell clear of the fixed bottom bar (WCAG 2.4.11).
    cells[next].scrollIntoView({ block: 'nearest' });
  });
}

function stepMonth(delta) {
  store.month = addMonths({ ...store.month, d: 1 }, delta);
  render();
  say(`${formatMonth(store.month)}`);
}

let pressTimer = null;

function wire() {
  setupRoving();

  app.onclick = async (e) => {
    const navBtn = e.target.closest('[data-nav]');
    if (navBtn) {
      if (navBtn.dataset.settings) { openSettings(); return; }
      nav(navBtn.dataset.nav); return;
    }
    const cell = e.target.closest('.cell');
    if (cell) {
      const day = cell.dataset.day;
      if (store.selectMode) { toggleSelect(day); return; }
      openDay(day); return;
    }
    const slotBtn = e.target.closest('[data-slot]');
    if (slotBtn) {
      const [day, slot] = slotBtn.dataset.slot.split('|');
      const cur = myMark(day, slot);
      const nextState = !cur || cur.src !== 'EXPLICIT' ? FREE : cur.s === FREE ? MAYBE : cur.s === MAYBE ? BUSY : null;
      await setMark(day, slot, nextState);
      return;
    }
    const expand = e.target.closest('[data-expand]');
    if (expand) {
      const k = expand.dataset.expand;
      if (store.expanded.has(k)) store.expanded.delete(k); else store.expanded.add(k);
      render(); return;
    }
    const makePlan = e.target.closest('[data-makeplan]');
    if (makePlan) {
      const [day, slot] = makePlan.dataset.makeplan.split('|');
      await addPlanFlow(day, slot);
      return;
    }
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) { openDay(openBtn.dataset.open); return; }
    const busyBtn = e.target.closest('[data-busy]');
    if (busyBtn) {
      const [day, slot] = busyBtn.dataset.busy.split('|');
      await setMark(day, slot, BUSY);
      showSnack('Marked busy', 'Undo', () => setMark(day, slot, FREE));
      return;
    }
    const nudgeBtn = e.target.closest('[data-nudge]');
    if (nudgeBtn) { await copyNudge(nudgeBtn.dataset.nudge); return; }
    const monthBtn = e.target.closest('[data-month]');
    if (monthBtn) { stepMonth(Number(monthBtn.dataset.month)); return; }
    const selBtn = e.target.closest('[data-selectmode]');
    if (selBtn) {
      store.selectMode = selBtn.dataset.selectmode === 'on';
      store.selection.clear(); store.rangeAnchor = null; store.rangeLabel = null;
      render();
      say(store.selectMode ? 'Select mode on. Tap days to choose them.' : 'Select mode off.');
      return;
    }
    const bulkBtn = e.target.closest('[data-bulk]');
    if (bulkBtn) { await bulkApply(bulkBtn.dataset.bulk); return; }
    const rangeBtn = e.target.closest('[data-range]');
    if (rangeBtn) { store.rangeMode = !store.rangeMode; store.rangeAnchor = null; render(); return; }
    const evBtn = e.target.closest('[data-evenings]');
    if (evBtn) { store.eveningsOnly = !store.eveningsOnly; render(); return; }
    const undoBtn = e.target.closest('[data-undo]');
    if (undoBtn) { await undoBulk(); return; }
    const colBtn = e.target.closest('[data-col]');
    if (colBtn) { columnFill(Number(colBtn.dataset.col)); return; }
    const showAll = e.target.closest('[data-showall]');
    if (showAll) {
      // Tapping the same band's expander again collapses it, so the one button
      // is both "Show all" and "Show fewer".
      const n = Number(showAll.dataset.showall);
      store.showAll = store.showAll === n ? null : n;
      render();
      say(store.showAll === n
        ? `Showing all ${showAll.dataset.showtotal} options with ${n} free`
        : 'Showing the first five');
      return;
    }
    const quick = e.target.closest('[data-quick]');
    if (quick) { quickFill(quick.dataset.quick); return; }
    const save = e.target.closest('[data-savepattern]');
    if (save) { await savePattern(); return; }
    const confirmBtn = e.target.closest('[data-confirm]');
    if (confirmBtn) { await doConfirm(); return; }
    const planDel = e.target.closest('[data-plan-del]');
    if (planDel) { await deletePlan(planDel.dataset.planDel); return; }
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      try { await navigator.clipboard.writeText(S().nudge.text); showSnack('Copied.', null, null); }
      catch { say('Could not copy.'); }
      return;
    }
    const dismiss = e.target.closest('[data-dismiss]');
    if (dismiss) { store.nudgeDismissed = true; render(); return; }
  };

  app.onchange = (e) => {
    const radio = e.target.closest('[data-confirmrow]');
    if (radio) {
      store.overrides = store.overrides || {};
      store.overrides[radio.dataset.confirmrow] = radio.value;
      return;
    }
    const setupRadio = e.target.closest('.toggle-row input[type=radio]');
    if (setupRadio && store.route === '/setup') {
      store.pattern = store.pattern || {};
      store.pattern[setupRadio.name] = setupRadio.value === 'null' ? null : setupRadio.value === 'true';
    }
  };

  // Long-press as a SHORTCUT into select mode. There is always the visible
  // "Select days" button, so nothing depends on the gesture (WCAG 2.5.7).
  app.onpointerdown = (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    pressTimer = setTimeout(() => {
      if (!store.selectMode) { store.selectMode = true; render(); }
      toggleSelect(cell.dataset.day);
      if (navigator.vibrate) navigator.vibrate(10);
    }, 350);
  };
  const cancelPress = () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = null; };
  app.onpointerup = cancelPress;
  app.onpointercancel = cancelPress;
  app.onpointerleave = cancelPress;
}

/** Single tap toggles a day in or out. NO drag-select. */
function toggleSelect(day) {
  if (store.rangeMode) {
    if (!store.rangeAnchor) {
      store.rangeAnchor = day;
      store.selection.clear();
      store.selection.add(day);
      store.rangeLabel = formatShort(day);
    } else {
      const [a, b] = compare(store.rangeAnchor, day) <= 0 ? [store.rangeAnchor, day] : [day, store.rangeAnchor];
      store.selection = new Set(range(a, b));
      store.rangeLabel = `${formatShort(a)} – ${formatShort(b)} · ${store.selection.size} days`;
      store.rangeAnchor = null;
    }
  } else if (store.selection.has(day)) store.selection.delete(day);
  else store.selection.add(day);
  render();
  say(`${store.selection.size} days selected`);
}

/** Tap "Sat" → every Saturday in the visible month. */
function columnFill(colIndex) {
  const cells = monthGrid(store.month).filter((c) => c.inMonth && mondayIndex(c.day) === colIndex);
  store.selectMode = true;
  store.selection = new Set(cells.map((c) => c.key));
  store.rangeLabel = `every ${weekdayName(cells[0].day, true)} in ${MONTHS_LONG[store.month.m - 1]}`;
  render();
  say(`${cells.length} days selected: ${store.rangeLabel}. Now pick free, maybe or busy.`);
}

function quickFill(spec) {
  const [which, raw] = spec.split('|');
  const value = raw === 'null' ? null : raw === 'true';
  store.pattern = store.pattern || {};
  const keys = which === 'weekday'
    ? PATTERN_KEYS.filter((k) => k.endsWith('_EVENING') && !k.startsWith('SAT') && !k.startsWith('SUN'))
    : PATTERN_KEYS.filter((k) => k.startsWith('SAT') || k.startsWith('SUN'));
  for (const k of keys) store.pattern[k] = value;
  render();
  say(`${keys.length} set.`);
}

async function savePattern() {
  const pattern = {};
  for (const k of PATTERN_KEYS) {
    const v = store.pattern ? store.pattern[k] : undefined;
    pattern[k] = v === undefined ? null : v;
  }
  const data = await mutate('/api/pattern', { pattern });
  if (data) nav('/confirm', true);
}

async function doConfirm() {
  const overrides = Object.entries(store.overrides || {}).map(([k, state]) => {
    const [day, slot] = k.split('|');
    return { day, slot, state };
  });
  // Send the window explicitly. Without it the server falls back to a
  // today-anchored fortnight, which for anyone already filled in is entirely
  // slots it will (correctly) skip.
  const data = await mutate('/api/confirm', {
    overrides, from: store.confirmFrom, to: store.confirmTo,
  });
  if (data) { store.overrides = {}; nav('/'); }
}

function openSettings() {
  const s = S();
  const current = quorum();
  const suggested = Math.ceil(roster().length / 2);
  const value = window.prompt(
    `Don’t bother showing me anything below…\n\n(suggested: half the group rounded up = ${suggested})`,
    String(current),
  );
  if (value === null) return;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) { say('That is not a number.'); return; }
  mutate('/api/quorum', { quorum: n });
}

// --------------------------------------------------------------------- boot ---

(async function boot() {
  try {
    store.route = location.pathname;
    await load();
    await drain();
    startPolling();
  } catch (err) {
    // Anything unhandled during startup would otherwise leave a blank page.
    showProblem('Something broke starting up', String((err && err.message) || err));
    return;
  }
  // If the day rolls over while the tab is open, pick it up.
  setInterval(() => {
    const t = londonToday();
    if (t !== store.today) { store.today = t; store.etag = null; load(); }
  }, 60000);
}());
