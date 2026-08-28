// "Show all 15" has to actually show fifteen.
//
// The bug this locks out: viewHome always rendered band.rows - the list already
// capped at five - so the expander repainted byte-identical HTML. In a group
// that has filled things in, that is the difference between picking from five
// candidate slots and picking from all of them.
//
// The band render is a template expression inside viewHome, so it is lifted out
// of public/app.js rather than copied: this suite fails if the shipped screen
// regresses. Its free names - store, esc and slotRow - are injected.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildBands } from '../public/shared/tally.js';

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function loadBandHtml({ bands, store }) {
  const start = SRC.indexOf('\n  const bandHtml = bands.map((band) => {');
  assert.ok(start > -1, 'public/app.js must build bandHtml by mapping over bands');
  const end = SRC.indexOf("\n  }).join('');", start);
  assert.ok(end > start, 'could not find the end of the bandHtml map');
  const body = SRC.slice(start, end + "\n  }).join('');".length);
  // eslint-disable-next-line no-new-func
  return new Function('bands', 'store', 'esc', 'slotRow', `${body}; return bandHtml;`)(
    bands, store, (s) => String(s), (r, isTop) => `<row day="${r.day}" slot="${r.slot}" top="${isTop}">`,
  );
}

/** The wire() click branch for the expander, lifted rather than reimplemented. */
function loadShowAllBranch() {
  const start = SRC.indexOf("\n    const showAll = e.target.closest('[data-showall]');");
  assert.ok(start > -1, 'wire() must handle [data-showall] clicks');
  const end = SRC.indexOf('\n    }\n', start);
  assert.ok(end > start, 'could not find the end of the showAll branch');
  // eslint-disable-next-line no-new-func
  return new Function('e', 'store', 'render', 'say', SRC.slice(start, end + 6));
}

const NAMES = ['Ammar', 'Nia', 'Priya', 'Rob', 'Sasha', 'Tomas', 'Wren'];
const ROSTER = NAMES.map((name, i) => ({ id: `p${i}`, name }));
const said = (s) => ({ s, src: 'EXPLICIT', stale: false });

/** Five of seven free on every slot of a fortnight - one big band, lots hidden. */
function fortnightOfFives() {
  const days = {};
  for (let d = 10; d <= 23; d += 1) {
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    days[day] = {};
    for (const slot of ['MORNING', 'AFTERNOON', 'EVENING']) {
      days[day][slot] = {
        p0: said('FREE'), p1: said('FREE'), p2: said('FREE'), p3: said('FREE'), p4: said('FREE'),
        p5: said('BUSY'), p6: said('BUSY'),
      };
    }
  }
  return buildBands(days, ROSTER, 4, '2026-10-10', '2026-10-23', 5);
}

const rowsIn = (html) => (html.match(/<row /g) || []).length;

test('collapsed, a band shows five rows and offers to show them all', () => {
  const { bands } = fortnightOfFives();
  assert.equal(bands.length, 1);
  assert.ok(bands[0].allRows.length > 5);
  const html = loadBandHtml({ bands, store: { showAll: null } });
  assert.equal(rowsIn(html), 5);
  assert.match(html, new RegExp(`Show all ${bands[0].allRows.length}`));
  assert.match(html, /aria-expanded="false"/);
});

test('expanded, the same band renders every qualifying slot', () => {
  const { bands } = fortnightOfFives();
  const band = bands[0];
  const html = loadBandHtml({ bands, store: { showAll: band.count } });
  assert.equal(rowsIn(html), band.allRows.length);
  assert.match(html, /Show fewer/);
  assert.match(html, /aria-expanded="true"/);
  // The promoted top row stays the first row of the first band.
  assert.match(html, new RegExp(`<row day="${band.allRows[0].day}" slot="${band.allRows[0].slot}" top="true">`));
  assert.equal((html.match(/top="true"/g) || []).length, 1);
});

test('expanding one band leaves the others capped', () => {
  const days = {};
  const day = '2026-10-10';
  const other = '2026-10-11';
  const fill = (n) => {
    const e = {};
    ROSTER.forEach((p, i) => { e[p.id] = said(i < n ? 'FREE' : 'BUSY'); });
    return e;
  };
  days[day] = { MORNING: fill(6), AFTERNOON: fill(6), EVENING: fill(6) };
  days[other] = { MORNING: fill(5), AFTERNOON: fill(5), EVENING: fill(5) };
  const { bands } = buildBands(days, ROSTER, 4, day, other, 2);
  assert.equal(bands.length, 2);
  const html = loadBandHtml({ bands, store: { showAll: bands[1].count } });
  assert.equal(rowsIn(html), bands[0].rows.length + bands[1].allRows.length);
});

test('a band with nothing hidden never renders an expander', () => {
  const days = { '2026-10-10': { EVENING: { p0: said('FREE'), p1: said('FREE'), p2: said('FREE'), p3: said('FREE') } } };
  const { bands } = buildBands(days, ROSTER, 4, '2026-10-10', '2026-10-10', 5);
  assert.equal(bands[0].hidden, 0);
  const html = loadBandHtml({ bands, store: { showAll: null } });
  assert.doesNotMatch(html, /data-showall/);
});

test('the expander toggles rather than latching open', () => {
  const store = { showAll: null };
  const announced = [];
  const renders = [];
  const branch = loadShowAllBranch();
  const tap = (headcount, total) => branch(
    { target: { closest: () => ({ dataset: { showall: String(headcount), showtotal: String(total) } }) } },
    store, () => renders.push(store.showAll), (m) => announced.push(m),
  );

  tap(5, 15);
  assert.equal(store.showAll, 5);
  tap(5, 15);
  assert.equal(store.showAll, null, 'tapping the open band again collapses it');
  tap(6, 3);
  assert.equal(store.showAll, 6, 'tapping a different band moves the expansion there');
  assert.deepEqual(renders, [5, null, 6], 'every tap repaints');
  assert.deepEqual(announced, ['Showing all 15 options with 5 free', 'Showing the first five', 'Showing all 3 options with 6 free']);
});
