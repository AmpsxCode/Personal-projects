# Verification

Everything below was run, not estimated. **179 checks** across three layers.

Re-run it yourself:

```bash
npm install && npm run test:tz                     # 39 unit checks x 4 timezones
npx wrangler dev --config wrangler.dev.jsonc       # then, in another terminal:
cd test/e2e && npm install && node run.mjs         # 45 browser checks
```

---

## Unit suites — 86 checks, four timezones

```
TZ=Europe/London          # pass 86 # fail 0
TZ=UTC                    # pass 86 # fail 0
TZ=Pacific/Auckland       # pass 86 # fail 0
TZ=America/Los_Angeles    # pass 86 # fail 0
```

London first, because it is the only one of those zones that reproduces the BST
bug class at all. Notable checks:

- **The date layer contains no `Date`.** The brief allows exactly one (`Date.UTC`
  inside `mondayIndex`); weekdays are derived from epoch-day arithmetic instead, so
  there is nothing a host timezone could shift. A separate test cross-checks
  **every weekday over 12 years** against `new Date(Date.UTC(...)).getUTCDay()` as
  an oracle — proving the arithmetic matches the permitted call without shipping it.
- **Month grids** for March 2026, October 2026, March 2027, October 2027: 42 cells,
  every day present once, Monday first, consecutive, day number matching its ISO
  key, weekends with exactly 3 slots and weekdays exactly 1.
- **Both UK clock changes**, in both directions: Sun 25 Oct 2026 (25-hour day) and
  Sun 28 Mar 2027 (23-hour day). "Next day" from the Saturday before each lands on
  the transition Sunday.
- **The buckets always partition the roster.** `free + maybe + busy + assumed +
  stale + notAnswered === roster.length`, over several shapes of input. This is the
  cheapest mechanical way to stop `free` quietly absorbing a guess, a stale answer,
  or somebody who never opened the app.
- **A `MAYBE` never lifts a slot into a band.** 3 free + 3 maybe with a quorum of 4
  produces no band and lands in "could work if the maybes are in" instead.
- **A null pattern key derives to nothing**, never to assumed-busy.
- **Assumed and stale never extend `confirmed_through`.**

## API — 48 checks against a live Worker + D1

```
48 passed, 0 failed
```

Highlights, quoted from the run:

```
ok  version upsert increments (ON CONFLICT DO UPDATE works on D1)
ok  invite URL hidden once the roster is non-empty
ok  five wrong PINs locks the account
ok  correct PIN still refused while locked
ok  a cookie with bytes flipped is rejected
ok  no cookie gives a clean 401, not a 500
ok  server refuses to guess today
ok  a slot nobody answered is an empty object on the wire
ok  ETag changed after a write (W/"19" -> W/"20")
ok  two writes produce two different ETags
ok  another browser's stale ETag gets a 200, not a 304
ok  cleared mark is absent from the payload entirely
ok  a replayed opId does not change anything (version 23 -> 23)
ok  a null pattern key derives to NOTHING - not assumed busy
ok  confirm did NOT invent a value for the null-pattern slot
ok  bulk of 90 days succeeded (would be 540+ bound params as one INSERT)
ok  a tampered token is refused
ok  no field in any per-person availability payload could hold an event title
```

The ack copy, generated live:

> *"Thanks — that's 1 of 7 filled in for September, and Sat 5th just became the
> best day."*

A generated nudge, live:

> *"Sat 5 Sep evening has 2 of 7 — you're one of 5 we're missing. One tap: …"*

## Browser — 45 checks, real Chromium, real pixels

```
45 passed, 0 failed
```

### The invite page, in both roster states

```
ok  no uncaught error on the invite page
ok  adding your own name works (roster 0 -> 1)
ok  still no uncaught errors after adding a name
```

The roster starts empty and fills itself, so "add your name" is the only control a
first visitor has. These three exist because of bug 7 below.

### Tap budgets — counted by clicking, not estimated

| Journey | Budget | **Measured** |
|---|---|---|
| Cold WhatsApp link → all 11 pattern answers saved | ≤ 12 taps | **5** |
| Returning, stale window → fully up to date | ≤ 3 taps | **2** |
| Flipping one slot free → busy from `/` | ≤ 2 taps | **1** |

The five taps are: pick my name · skip the PIN · "all five weekday evenings" ·
"all six weekend slots" · save. The two quick-fill rows are the reason this is 5
rather than 13 — see the note on §8.2 in `REVIEW.md`.

### Encoding, measured on what the browser actually painted

```
ok  sampled 8 variants from the rendered legend
ok  all 28 rendered pairs pass the greyscale rule
ok  not-answered really has no fill in the render
ok  not-answered is the only dashed one
ok  every target >= 44x44 at 360px
ok  every target >= 24x24 at 320px
ok  no horizontal scrolling at 360px / 320px
ok  no input under 16px, so iOS will not zoom on focus
ok  roving tabindex: exactly one cell in the tab order
ok  exactly one live region
ok  the last bulk action is STILL reversible after the snackbar has gone
```

Screenshots were reviewed in light, dark and `prefers-contrast: more`.

### Multiplayer

```
ok  the other phone starts showing "4 free"
ok  the writer sees it immediately: "4 free" -> "5 free"
    polls at: 24.6s
ok  the other phone picked it up in 24.7s, now showing "5 free" (budget 35s)
```

## Static checks

| | |
|---|---|
| `marks` columns that could hold a private event title | **0** |
| Code paths writing `state='UNKNOWN'` | **0** |
| Code paths writing `source='PATTERN'` | **0** |
| `SESSION_SECRET` value anywhere in the repo | **0** |
| Pages-isms (`_worker.js`, `_routes.json`, `onRequest`, `context.env`) | **0** |
| Third-party script or stylesheet URLs in `public/` | **0** |
| Named SQL parameters (unsupported by D1) | **0** |
| Service-worker `addEventListener('fetch')` | **0** |
| Non-Cloudflare hosts suggested anywhere | **0** |

---

## Seven bugs the harness caught that review would not have

Each of these passed code review and failed a machine.

1. **A two-tone split fill and a flat mid-tone fill have near-identical mean
   luminance**, so "partly free" and "maybe" collided in greyscale. No luminance
   threshold can separate them — the fix was to count fill *pattern* as a channel,
   which is what actually distinguishes them on a screen.

2. **Assumed and confirmed values used the same glyph character**, distinguished
   only by CSS font weight. That vanishes in a greyscale screenshot and at 12px.
   Assumed/stale now use genuinely different marks — `(✓)`, `(~)`, `(✕)`.

3. **"Everyone free" had the corner wedge but no star inside the swatch**, so it was
   indistinguishable from plain free to anything reading the glyph — and its
   accessible name said "Free". It now carries all three markers the brief offers.

4. **The month grid used the *maybe* colour to mean "a couple of people are free."**
   Amber sat directly under a legend promising amber meant Maybe. Replaced with a
   proper five-step ramp inside the free hue.

5. **In `prefers-contrast: more`, today's numeral went white-on-white.** Fills are
   dropped in that mode, but the light-on-dark text rule still applied. Measured
   1.11:1 before the fix, 11.73:1 after. The fix had to go at the end of the
   stylesheet — media queries carry no extra specificity, so the first attempt was
   silently overridden by source order.

6. **A generated nudge fell back to generic copy** ("your row is empty") whenever no
   slot had reached quorum yet — which is exactly when a nudge matters most. It now
   falls back to the closest options, so it always names a slot, a count, and the
   person's absence.

7. **Making the roster grid conditional broke the only button a first visitor
   has.** With nobody on the list yet there is no `.who-grid` element, so
   `document.querySelector('.who-grid').addEventListener(...)` threw at module
   load — taking the "Add me" handler down with it. The page rendered perfectly
   and did nothing when tapped. Nothing in the code review of that change looked
   wrong; the screenshot flow caught it because the two names it added never
   appeared.

Two further findings came from measurement rather than assertion:

- **PBKDF2 at 10,000 iterations costs 5.8ms of a hard 10ms CPU budget** — 58% of it,
  spent on the first screen a new person touches. Lowered to 6,000 (~4ms). See
  README §5 for the full table and why this costs nothing in real security.
- **A 30s poll interval against a 35s acceptance bar leaves 5s of margin.** The
  measured cadence is exactly 30.0s, so the interval was fine — the *bar* was the
  problem. Tightened to 25s for 10s of real margin, at 14% of the free daily
  request allowance instead of 11.5%.

## Where the harness itself was wrong

Worth recording, because a test that fails for its own reasons wastes more time than
no test:

- Asserted 7 people when the roster had grown to 8; asserted `triesLeft === 3` when
  5 attempts minus 1 is 4; asserted an empty slot tallies to "0 not answered" when
  seven silent people is "7 not answered".
- Watched rendered text that did not *need* to change to prove propagation — it
  would have passed on a broken poll. Rewritten to mark the slot that is already the
  top band row, so "4 free" must become "5 free".
- Measured Chromium's background-tab timer throttling instead of the app's poll
  interval, until the watching page was brought to the front.
- Inherited a quorum of 5 left behind by another suite. It now sets its own
  preconditions.


---

## Round two: the use-case review

Fifteen agents, seventy minutes. Four reviewers each took a different lens on
"what does a friend group actually need", reading real source before claiming
anything. A prioritiser cut 40 findings to five safe changes and recorded why it
rejected the other twelve. Builders ran ONE AT A TIME with the test suite gating
each — they all edit public/app.js, so parallel writers would clobber each other.
Then three verifiers ran in parallel: one live, one auditing the ten hard
invariants statically, one paid to find what was wrong with each diff.

Commits produced:

```
e4d10cd Import the function I just started calling
e7d01ba Make "Add 2 more weeks" actually add two more weeks
efc57c3 Fix two browser-suite tests that were testing the suite, not the app
cda769d A refused clipboard has to say so, and the plan buttons have to say which slot
518a1cf Order plans by the clock, not by the spelling of the slot
1bb2bc6 Stop createPlan caching a response that has no announcement in it
bf201f7 Give every day cell back the 2px the UA stylesheet took
565f740 Make "Show all N" actually show them
51139fa Stop calling people who answered "missing"
cf5b850 Say something when a plan is made, and make it pasteable
c390f62 Carry the slot you were looking at into the plan you create
20e4b7d Fix undoBulk destroying marks it was meant to restore
```

### What it caught that the existing 128 checks did not

1. **`undoBulk` was destroying the marks it existed to restore.** The bulk
   endpoint cross-products days x slots, but undo grouped changes by previous
   value alone and sent the union of days with the union of slots — so each group
   wrote over every combination, and the CLEAR group, arriving last, deleted what
   the earlier groups had just put back. Mark a weekend busy in bulk, hit Undo,
   and your Saturday morning and Sunday evening were gone. Now grouped by
   (value, slot), with an exhaustive 4^7 round-trip test over every mixed
   starting state.

2. **Every month-grid day button was 42.56px wide, under the 44px floor.** The
   browser's default `td` padding was never reset. The restyle introduced it by
   moving the grid gap from 2px to 3px, and my own target check printed it as
   "43x74" — which rounds past a glance. All 42 cells were in violation.

3. **`createPlan` cached its idempotency response before the announcement
   existed**, so any replay created a plan with no announcement and no error.

4. **The weekly digest named the wrong plan.** Plans came back ordered by slot
   alphabetically — AFTERNOON, EVENING, MORNING — so a Saturday morning plan was
   never mentioned while the evening one was presented as *the* plan.

5. **"Add 2 more weeks" did nothing for anyone already filled in.** The confirm
   screen was anchored at today, so every slot in the window was already explicit
   and the server correctly skipped all of it: the most diligent person in the
   group tapped the app's one recurring ask and got `written: 0`. And a flawless
   confirm left `confirmedThrough` at today+13 while the ring wanted 14, so their
   own chip stayed hollow. The window now rolls forward from where their run ends.
   *(Deferred by the prioritiser purely for its five-item cap, then fixed by hand
   — it was the worst bug in the set.)*

6. **Copy that made people look bad.** Everyone who was not a definite yes got
   lumped into `missing:`, including people who had answered "busy". A row now
   reads `can't make it: Antonio · no answer yet: Annabelle`, which distinguishes
   someone who replied from someone who is ignoring the app.

### What it got wrong

Two of three verifiers failed the round, and one of those failures was the suite
testing itself rather than the app: an e2e assertion still looked for the word
`missing:` that the copy change had deliberately removed. Worth recording,
because a test that fails for its own reasons costs more time than no test.

One finding also overstated its blast radius, claiming the plan-announcement
defect broke "the whole offline drain path" when `drain()` never reads a response
body at all. The defect was real; the reasoning about it was not.

I also had to fix one of my own: I added the rolling confirm window and committed
it before running the browser suite, and the import was missing. The suite caught
it in seconds — and the failure surfaced as a visible "Something broke starting
up: nextConfirmWindow is not defined" rather than the blank page it would have
been before round one.
