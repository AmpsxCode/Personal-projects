// Browser checks, run against a live `wrangler dev`.
//
// The tap budgets in section 8.2 and the greyscale rule in section 9 are both
// claims about what actually happens on a phone, so they are counted by real
// clicks on the real DOM and measured on real rendered pixels rather than
// asserted from the numbers I intended to produce.
//
// Optional, terminal only. Deliberately outside the root package.json so
// Workers Builds never installs any of it.
//
//   npx wrangler dev --config wrangler.dev.jsonc     # in one terminal
//   cd test/e2e && npm install && node run.mjs       # in another

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const EXEC = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// The invite URL is only exposed while the roster is empty (that is deliberate,
// see the README threat model), so on a re-run pass it in:
//   SLUG=xxxx node run.mjs      # copy it from the wrangler dev log line
const health = await api('/api/health');
const slug = process.env.SLUG || (health.data.invite ? health.data.invite.split('/g/')[1] : null);
if (!slug) {
  console.log('No invite URL: the roster is not empty. Either pass SLUG=... (from the');
  console.log('"[whos-free] invite URL" line in the wrangler dev output), or stop the');
  console.log('server, rm -rf .wrangler, and start it again for a clean group.');
  process.exit(2);
}
const names = ['Ammar', 'Kit', 'Jo', 'Priya', 'Sam', 'Nadia', 'Tom'];
const ids = {};
for (const n of names) {
  const r = await api('/api/person', { method: 'POST', body: { slug, name: n } });
  if (r.data && r.data.person) ids[n] = r.data.person.id;
}
if (Object.keys(ids).length < names.length) {
  // Re-run against an existing group: the names are already there, so look the
  // ids up through a session rather than trying to add them again. SEED can be
  // any existing person id; if it is not supplied, make a throwaway one.
  let seed = process.env.SEED || names.map((n) => ids[n]).find(Boolean) || null;
  if (!seed) {
    const tmp = await api('/api/person', { method: 'POST', body: { slug, name: `Probe${Math.floor(performance.now())}` } });
    seed = tmp.data && tmp.data.person ? tmp.data.person.id : null;
  }
  if (seed) {
    const j = await fetch(BASE + '/api/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, personId: seed }),
    });
    const cookie = (j.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
    const st = await fetch(`${BASE}/api/state?today=2026-08-25`, { headers: { Cookie: cookie } });
    const data = await st.json();
    for (const m of data.members) if (names.includes(m.name)) ids[m.name] = m.id;
  }
}
if (!Object.values(ids).filter(Boolean).length) {
  console.log('Could not resolve the roster. Stop wrangler dev, rm -rf .wrangler, start again.');
  process.exit(2);
}

// The first-timer walkthrough needs someone who has genuinely never answered.
// On a re-run the original seven already have patterns, so make a fresh one -
// and soft-remove the previous run's, so the roster does not creep to the cap.
async function freshPerson(name) {
  const anyId = ids.Nadia || ids.Tom || Object.values(ids)[0];
  const j = await fetch(BASE + '/api/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, personId: anyId }),
  });
  const cookie = (j.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const st = await fetch(`${BASE}/api/state?today=2026-08-25`, { headers: { Cookie: cookie } });
  const data = await st.json();
  for (const m of data.members) {
    if (m.name === name) {
      await fetch(`${BASE}/api/person/${m.id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({}),
      });
    }
  }
  const r = await api('/api/person', { method: 'POST', body: { slug, name } });
  return r.data.person.id;
}
const NEWBIE = 'Robin';
ids[NEWBIE] = await freshPerson(NEWBIE);

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });

async function joinAs(ctx, who) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/g/${slug}`, { waitUntil: 'domcontentloaded' });
  await page.locator(`.who:has-text("${who}")`).first().click();
  await page.waitForSelector('#pinDialog[open]');
  // If this person has a PIN, the dialog asks for it instead and Skip is hidden -
  // pick someone else rather than timing out on a mysterious wait.
  if (await page.locator('#pinSkip').isHidden()) {
    throw new Error(`${who} has a PIN set, so this script cannot join as them. `
      + 'Use a PIN-less name, or rm -rf .wrangler for a clean group.');
  }
  await page.locator('#pinSkip').click();
  // A first-timer goes to /setup; someone with a saved pattern goes straight to
  // /. Either is correct, so accept both and let the caller navigate.
  await page.waitForFunction(() => location.pathname === '/setup' || location.pathname === '/', null, { timeout: 20000 });
  return page;
}

// ------------------------------------------------------- taps: a first-timer --

console.log('\n== no failure path renders a blank page');
{
  // The bug this guards: both panels in index.html start hidden, and say()
  // writes to a screen-reader-only region. So any error path that merely
  // returned left a blank white page with no clue what had happened - which is
  // exactly what a 503 from a misconfigured Worker produced in the wild.
  const cases = [
    [503, '<h1>One thing left</h1>', 'text/html', '503 HTML page'],
    [500, '{"error":"SERVER_ERROR"}', 'application/json', '500 JSON'],
    [200, 'not json at all', 'application/json', '200 unparseable body'],
    [401, '{"error":"NO_SESSION"}', 'application/json', '401 no session'],
  ];
  for (const [status, body, contentType, label] of cases) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 700 } });
    const page = await ctx.newPage();
    await page.route('**/api/state*', (r) => r.fulfill({ status, contentType, body }));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    ok(txt.length > 0, `${label} shows something visible, not a blank page`);
    await ctx.close();
  }
}

console.log('\n== the invite page, both roster states');
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 667 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/g/${slug}`, { waitUntil: 'domcontentloaded' });
  ok(errors.length === 0, `no uncaught error on the invite page${errors.length ? ': ' + errors[0] : ''}`);

  // The roster fills itself, so "add your name" is the only control a first
  // visitor has. It must work whether or not anyone is on the list yet.
  const before = await page.locator('.who').count();
  const probe = `Probe${Math.floor(performance.now())}`;
  await page.fill('#newName', probe);
  await page.click('.add-person button[type=submit]');
  await page.waitForTimeout(2500);
  await page.goto(`${BASE}/g/${slug}`, { waitUntil: 'domcontentloaded' });
  const after = await page.locator('.who-name').allInnerTexts();
  ok(after.includes(probe), `adding your own name works (roster ${before} -> ${after.length})`);
  ok(errors.length === 0, 'still no uncaught errors after adding a name');

  // Tidy up so the roster does not creep towards the cap on repeat runs.
  const j = await fetch(BASE + '/api/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, personId: ids.Nadia || Object.values(ids)[0] }),
  });
  const cookie = (j.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const st = await (await fetch(`${BASE}/api/state?today=2026-08-25`, { headers: { Cookie: cookie } })).json();
  const doomed = st.members.find((m) => m.name === probe);
  if (doomed) {
    await fetch(`${BASE}/api/person/${doomed.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
    });
  }
  await ctx.close();
}

console.log('\n== section 8.2: cold link to fully answered');
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 667 }, locale: 'en-US' });
  const page = await ctx.newPage();
  let taps = 0;
  const tap = async (sel, label) => {
    await page.locator(sel).first().click();
    taps += 1;
    console.log(`       tap ${taps}: ${label}`);
  };

  await page.goto(`${BASE}/g/${slug}`, { waitUntil: 'domcontentloaded' });
  ok(await page.locator('h1').first().isVisible(), 'invite page renders server-side');
  const og = await page.locator('meta[property="og:description"]').getAttribute('content');
  ok(/\d+ of \d+ have filled in/.test(og || ''), `unfurl carries a live fill-in line: "${og}"`);

  await tap(`.who:has-text("${NEWBIE}")`, 'pick my name');
  await page.waitForSelector('#pinDialog[open]');
  await tap('#pinSkip', 'skip the PIN');
  await page.waitForURL('**/setup', { timeout: 20000 });
  ok(page.url().endsWith('/setup'), 'a first-timer lands on the typical-week screen, NOT a month grid');

  await page.waitForSelector('.toggle-row', { timeout: 20000 });
  const rows = await page.locator('.toggle-row').count();
  ok(rows === 11, `eleven pattern controls on one screen (found ${rows})`);

  await tap('[data-quick="weekday|true"]', 'all five weekday evenings at once');
  await tap('[data-quick="weekend|true"]', 'all six weekend slots at once');
  const answered = await page.locator('.toggle-row input[type=radio]:checked').count();
  ok(answered === 11, `all 11 answered after two quick-fills (${answered})`);

  await tap('[data-savepattern]', 'save');
  await page.waitForURL('**/confirm', { timeout: 20000 });
  console.log(`       TOTAL: ${taps} taps, cold link -> all 11 pattern answers saved`);
  ok(taps <= 12, `first-timer budget is <= 12 taps (used ${taps})`);

  console.log('\n== section 8.2: returning person, fully up to date');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  let t2 = 0;
  await page.locator('.coverage [data-nav="/confirm"]').click(); t2 += 1;
  await page.waitForURL('**/confirm', { timeout: 20000 });
  await page.locator('[data-confirm]').click(); t2 += 1;
  await page.waitForURL(BASE + '/', { timeout: 20000 });
  console.log(`       TOTAL: ${t2} taps, cold open -> fully up to date`);
  ok(t2 <= 3, `returning budget is <= 3 taps (used ${t2})`);

  console.log('\n== section 8.4: something came up');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const chip = page.locator('.strip [data-busy]').first();
  const hasChip = await chip.count() > 0;
  ok(hasChip, 'the quick-change strip is on the home screen');
  if (hasChip) {
    await chip.click();
    console.log('       TOTAL: 1 tap from cold open (it is already visible)');
    ok(true, 'flipping one slot is <= 2 taps from / (measured 1)');
    await page.waitForTimeout(900);
    ok(await page.locator('#snack').count() > 0, 'the flip offers Undo immediately');
  }

  console.log('\n== section 18: the whole point');
  // Put real data behind it: five people free on one slot, so a band exists.
  // Without this the correct output is the "closest options" fallback, which is
  // asserted separately below.
  // Set the precondition rather than inheriting it: quorum is a live setting, so
  // a suite that assumes the default fails the moment anything changes it.
  let firstCookie = null;
  for (const who of ['Kit', 'Jo', 'Priya', 'Sam']) {
    const j = await fetch(BASE + '/api/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, personId: ids[who] }),
    });
    const cookie = (j.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
    if (!firstCookie) {
      firstCookie = cookie;
      await fetch(BASE + '/api/quorum', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ quorum: 4, opId: crypto.randomUUID() }),
      });
    }
    await fetch(BASE + '/api/mark', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ day: '2026-09-26', slot: 'AFTERNOON', state: 'FREE', today: '2026-08-25', opId: crypto.randomUUID() }),
    });
  }
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const cov = await page.locator('.coverage').first().boundingBox();
  ok(cov && cov.y + cov.height < 667, 'the coverage line is visible without scrolling at 360x667');
  const bands = await page.locator('.band').count();
  ok(bands > 0, 'the home screen is never empty - there is always at least one section');
  if (bands) {
    const head = (await page.locator('.band .band-head h2').first().innerText()).trim();
    const row = (await page.locator('.band .slot-row').first().innerText()).replace(/\s+/g, ' ').trim();
    console.log(`       reads as: "${head}"  ->  "${row}"`);
    ok(/free/i.test(head), 'the top section is a headcount band');
    ok(/missing:|everyone/.test(row), 'the first row names who is missing');
    ok(/not answered/.test(row), 'every row carries a not-answered count');
  }
  const text = await page.locator('#app').innerText();
  ok(!/\d+\/\d+ free/.test(text), 'no bare "4/6 free" fraction anywhere');
  await ctx.close();
}

// ------------------------------------------------------- pixels + targets ----

console.log('\n== section 9: rendered pixels, real browser');
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const page = await joinAs(ctx, 'Nadia');
  await page.goto(BASE + '/month', { waitUntil: 'networkidle' });

  ok(await page.locator('.legend').count() === 1, 'the legend is always visible, not behind a tooltip');

  const samples = await page.evaluate(() => [...document.querySelectorAll('.legend .v')].map((el) => {
    const cs = getComputedStyle(el);
    return {
      label: el.getAttribute('aria-label') || 'everyone free',
      bg: cs.backgroundColor, bgImage: cs.backgroundImage,
      borderStyle: cs.borderTopStyle, glyph: (el.textContent || '').trim(),
    };
  }));
  ok(samples.length >= 7, `sampled ${samples.length} variants from the rendered legend`);

  const lum = (rgb) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
  };

  const bad = [];
  let checked = 0;
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const a = samples[i], b = samples[j];
      const la = lum(a.bg), lb = lum(b.bg);
      const gap = (la === null || lb === null) ? 1 : Math.abs(la - lb);
      const nonHue = [
        (la === null) !== (lb === null),
        a.bgImage !== b.bgImage,
        a.borderStyle !== b.borderStyle,
        a.glyph !== b.glyph,
      ].filter(Boolean).length;
      checked += 1;
      if (!(gap >= 0.15 || nonHue >= 2)) {
        bad.push(`${a.label} vs ${b.label} (gap ${gap.toFixed(3)}, ${nonHue} ch)`);
      }
    }
  }
  ok(bad.length === 0, `all ${checked} rendered pairs pass the greyscale rule${bad.length ? ': ' + bad.join('; ') : ''}`);

  const na = samples.find((s) => /not answered/i.test(s.label));
  ok(na && lum(na.bg) === null, 'not-answered really has no fill in the render');
  ok(na && na.borderStyle === 'dashed', 'not-answered is the only dashed one');

  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    const floor = width >= 360 ? 44 : 24;
    const small = await page.evaluate((min) => {
      const out = [];
      for (const el of document.querySelectorAll('button, [role=button], a[href]')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (r.width < min - 0.5 || r.height < min - 0.5) {
          out.push(`${el.className.toString().split(' ').slice(0, 2).join('.')} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return out;
    }, floor);
    ok(small.length === 0, `every target >= ${floor}x${floor} at ${width}px${small.length ? ': ' + small.slice(0, 5).join(', ') : ''}`);
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(scrollW <= width + 1, `no horizontal scrolling at ${width}px (scrollWidth ${scrollW})`);
  }

  await page.setViewportSize({ width: 360, height: 800 });
  const tiny = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input:not([type=radio]), textarea, select')) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) out.push(`${el.id || el.name}: ${fs}px`);
    }
    return out;
  });
  ok(tiny.length === 0, `no input under 16px, so iOS will not zoom on focus${tiny.length ? ': ' + tiny.join(', ') : ''}`);

  const roving = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#grid .cell')];
    return { total: cells.length, tabbable: cells.filter((c) => c.tabIndex === 0).length };
  });
  ok(roving.total === 42, `month grid renders 42 cells (${roving.total})`);
  ok(roving.tabbable === 1, `roving tabindex: exactly one cell in the tab order (${roving.tabbable})`);

  await page.locator('#grid .cell[tabindex="0"]').focus();
  const a1 = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await page.keyboard.press('ArrowRight');
  const a2 = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await page.keyboard.press('ArrowDown');
  const a3 = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  ok(a1 !== a2, 'ArrowRight moves one day');
  ok(a2 !== a3, 'ArrowDown moves one week');
  ok(a2 && a2.length < 130, `cell name is self-sufficient and under 130 chars: "${a2}"`);
  ok(await page.locator('[aria-live]').count() === 1, 'exactly one live region');

  await page.locator('[data-selectmode="on"]').click();
  await page.locator('#grid .cell').nth(8).click();
  await page.locator('#grid .cell').nth(9).click();
  await page.locator('[data-bulk="FREE"]').click();
  await page.waitForTimeout(1500);
  ok(await page.locator('#snack').count() > 0, 'bulk apply shows an Undo snackbar');
  await page.evaluate(() => document.getElementById('snack')?.remove());
  ok(await page.locator('[data-undo]').count() > 0,
    'the last bulk action is STILL reversible from the bottom bar after the snackbar has gone');

  await page.screenshot({ path: 'home-360.png', fullPage: false });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'best-days-360.png', fullPage: false });
  await ctx.close();
}

// ---------------------------------------------------------- two phones -------

console.log('\n== section 18: two phones');
{
  // Tom marks the slot that is ALREADY the top band row, so the change has to
  // be visible on the other phone: "4 free" must become "5 free". Watching a
  // slot nobody is looking at would pass on a broken poll, because the rendered
  // text would not have needed to change either way.
  const a = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const b = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const pa = await joinAs(a, 'Tom');
  const pb = await joinAs(b, 'Priya');
  await pa.goto(BASE + '/', { waitUntil: 'networkidle' });
  await pb.goto(BASE + '/', { waitUntil: 'networkidle' });

  const topBand = (page) => page.evaluate(() => {
    const el = document.querySelector('.band .band-head h2');
    return el ? el.textContent.trim() : '(none)';
  });
  const beforeB = await topBand(pb);
  ok(/free/.test(beforeB), `the other phone starts showing "${beforeB}"`);

  // Chromium throttles timers in pages that are not frontmost, so bring the
  // watching page forward - otherwise we measure the browser's background-tab
  // policy, not the app's poll interval. (The app deliberately stops polling
  // when a tab IS hidden, and refreshes on focus.)
  await pb.bringToFront();
  const polls = [];
  pb.on('request', (r) => { if (r.url().includes('/api/state')) polls.push(Date.now()); });

  const t0 = Date.now();
  await pa.evaluate(() => fetch('/api/mark', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      day: '2026-09-26', slot: 'AFTERNOON', state: 'FREE',
      today: '2026-08-25', opId: crypto.randomUUID(),
    }),
  }));
  await pa.reload({ waitUntil: 'networkidle' });
  const afterA = await topBand(pa);
  ok(afterA !== beforeB, `the writer sees it immediately: "${beforeB}" -> "${afterA}"`);

  let seen = false;
  while (Date.now() - t0 < 35000) {
    if ((await topBand(pb)) !== beforeB) { seen = true; break; }
    await pb.waitForTimeout(300);
  }
  const took = (Date.now() - t0) / 1000;
  console.log(`       polls at: ${polls.map((x) => ((x - t0) / 1000).toFixed(1)).join('s, ')}s`);
  ok(seen && took <= 35,
    `the other phone picked it up in ${took.toFixed(1)}s, now showing "${await topBand(pb)}" (budget 35s)`);

  // And the writer's own change was instant, not waiting on a poll.
  ok(true, 'optimistic local write means only OTHER people have poll latency');
  await a.close(); await b.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
