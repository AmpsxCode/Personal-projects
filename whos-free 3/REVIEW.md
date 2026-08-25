# Who's Free — pre-build review

What §17 asks for before any code: what's contradictory or worth pushing back on, the file list, and the `[FILL IN]`s. Plus §12's API contract for approval.

I did what §2 asked and checked every Cloudflare number and config key against the live docs rather than memory. **Six of them have moved since your spec was written**, and one of those changes a decision you made deliberately. Those are in §B.

---

## A. Contradictions and pushback

Ordered by how much damage getting it wrong would do.

### A1. §8.2 says the `/setup` defaults are already an answer. §4 and §6.2 say they're silence.

§8.2: *"11 pattern toggles are optional — the defaults are already an answer."*
§6.2: *"Default is don't assume."*
§4: *"An un-toggled control in the typical-week editor means no assumption. It derives to not answered."*

So a first-timer who skips `/setup` is 100% silent — which is the phantom §4 exists to prevent, arrived at by a different road. §18 agrees with §4, not §8.2: it requires *"all 11 pattern answers saved in under 60 seconds"*.

**Resolution:** §4 wins, defaults stay *don't assume*, and I drop §8.2's parenthetical. To keep the tap budget honest rather than just achievable, `/setup` gets two **quick-fill rows** above the individual controls — *"Weekday evenings: usually free / usually busy / don't assume"* applying to all five at once, same for weekends — each overridable per control afterwards. That makes all 11 answers **2 taps** instead of 11, so the cold-link path is 5 taps rather than 13, and nobody is tempted to ship a default that lies.

### A2. §9's eight variants include `assumed-maybe`, which §4 and §5 say cannot exist.

`patterns.json` holds `true | false | null` only, and §4 states outright: *"There is no 'assumed maybe' — a pattern only ever asserts free or busy."*

**Resolution:** the eighth variant is **stale-maybe**, not assumed-maybe. A `MAYBE` is an `EXPLICIT` row, so it ages and can go stale like any other. Final rendered set of eight, which is what the greyscale test runs over:

`not answered · free · maybe · busy · dim-free · dim-maybe · dim-busy · partly-free`

where *dim* = assumed **or** stale (§9 already gives them the same treatment).

### A3. Assumed and stale render identically, but §9's test demands every pair be distinguishable.

§9 gives assumed and stale one row in the table — *"same fill at 40% opacity"* — while also asking me to assert that every pair of variants differs. Those can't both hold if assumed and stale are separate variants.

**Resolution:** the mechanised test runs over the **eight rendered** variants above, not the ten semantic states. Assumed and stale are separated by words, not pixels: their own tally buckets (§4), their own named lists in the expanded row (§6.3), and the age line — *"assumed from your typical week"* vs *"you said this 3 weeks ago"*. I'll put that reasoning in a comment in the test file so it reads as a decision rather than a gap.

### A4. The canonical tally example sums to 12, for a group of 7.

`5 free · 2 maybe · 1 busy · 1 assumed · 1 stale · 2 not answered` = 12. Which tells me the buckets are meant to **partition** the roster — and that the example is a leftover from when the number was `ROSTER_CAP`.

**Resolution:** buckets are mutually exclusive and always sum to the active roster. A stale free counts in `stale`, not in `free`. An assumed free counts in `assumed`, not in `free`. There'll be a unit test asserting `sum(buckets) === activeRoster.length` for every slot in a generated month — that single assertion is the cheapest possible mechanical enforcement of §4's entire thesis, so it's worth having even though you didn't ask for it.

### A5. "1 assumed" doesn't say which direction.

One bucket, two meanings: someone we think is free and someone we think is busy land in the same number and the same named list in §6.3's expanded breakdown.

**Resolution:** keep the single bucket — the canonical format is fixed and I'd rather not widen it — but render direction per person inside the list with §9's outlined ✓ / ✕. Same for stale.

### A6. `/confirm` can't reach "fully up to date" for anyone whose pattern has nulls.

"Yes, that's right" materialises *derived* values. A null pattern key derives to nothing, so nothing is written, so `confirmed_through` stops dead at the first null slot — and §8.2's 3-tap budget quietly fails for exactly the people who were careful enough not to over-claim. Writing something for a null would be inventing an answer, which §4 forbids.

**Resolution:** `/confirm` splits the list. Slots with no derived value go **first**, under *"We can't guess these — 3 to answer"*, each a one-tap Free/Maybe/Busy row. Everything else sits under *"We think this is you"*. The primary button carries the count: **"Yes, that's right · 3 left"**, becoming plain **"Yes, that's right"** once the list is clean. The 3-tap budget holds exactly for anyone with a complete pattern; for anyone else the app is honest about the cost instead of silently writing a guess or silently failing to advance.

### A7. `confirmed_through` starting at today makes the coverage line alarmist.

If tonight's `EVENING` is unanswered, the run from today is empty, so the coverage line reads *"Nobody knows when you're free"* — to someone who is in fact filled in for the next month. And §10 rule 6 forbids the server knowing the time of day, so I can't skip slots that have already elapsed.

**Resolution:** the run starts at `today` as written, and `/confirm` always includes today, so the standard 3-tap flow clears it immediately. Flagging it because the alternative — starting the run at `today + 1` — is a one-line change and you may prefer it. Say the word either way.

### A8. Avatar ring fills at 14 days (§6.3); the coverage line asks until 21 (§8.3).

Between 14 and 20 days your ring is filled while the line still nags. I think that's right rather than wrong — the ring answers *"is this person useful to the group"* and the line answers *"are you where you want to be"* — so I'm keeping both, with the ring's accessible name giving the actual date so it's never mysterious. Noting it in case you want them unified.

### A9. §6.3's within-band sort puts maybes ahead of the calendar.

`(maybe DESC, not_answered ASC, day ASC)` means the soonest slot in a band isn't necessarily its first row, which fights *"within five seconds I can say Saturday the 10th"* a little, since the first row is what gets read aloud. Building it as specified — the logic is defensible, more maybes really is more upside — but the first row in each band is doing more work than the sort key implies.

### A10. Group size drifts between 7, 6 and 12.

§1 says 7. §7's unfurl example says *"3 of 6"*. §13's budget and `ROSTER_CAP` say 12. Cosmetic and the roster is data, so: live active count everywhere, `ROSTER_CAP = 12`, unfurl reads *"3 of 7 have filled in the next 2 weeks"*.

### A11. `GET /api/health` returning the invite URL hands the group away to anyone who finds the Worker.

§12 wants it there so you can find the link after deploying, which is the right instinct. But `whos-free.<you>.workers.dev/api/health` is guessable, and the invite slug behind it is the whole capability — 128 bits of entropy protecting a URL that a second endpoint prints on request.

**Resolution:** `console.log` the invite URL on bootstrap, so it's in the dashboard logs permanently, **and** return it from `/api/health` only while the roster is empty. The moment the first person joins, that field disappears and is replaced by a pointer to the logs. You get the convenience for the sixty seconds you need it, and the hole closes by itself.

### A12. §6.9's server-rendered "open your invite link" page can't happen with §14's config.

Confirmed in the docs: with `not_found_handling: "single-page-application"` and asset-first routing, `/` is served straight off the asset layer and **the Worker is never invoked**. Adding `"/"` to `run_worker_first` would fix it, at the cost of a Worker invocation plus an `env.ASSETS.fetch()` subrequest on every single home load — which is the one path the five-second acceptance test measures.

**Resolution:** handle it client-side. `index.html` ships the no-session panel; the first `/api/state` returns 401 and the panel shows *"Open your invite link"*. Same words, no 500, no slug guessing, and `/` stays a static edge hit.

### A13. Two schema tables are missing for features §12 and §7 require.

- §12 mandates `opId` idempotency — *"the server ignores a repeated `opId` within an hour"* — but there is nowhere to record which `opId`s have been seen. Needs an `ops` table (below), pruned opportunistically inside the same `batch()` as the write it guards.
- §7 says the weekly nudge text goes to a *"`meta`-adjacent row"*, and §5 pins `meta.v` to `INTEGER` on purpose because it's a counter. So text needs its own table.

```sql
CREATE TABLE IF NOT EXISTS ops (
  op_id      TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  response   TEXT                  -- cached body, so a replay returns the same answer
);
CREATE INDEX IF NOT EXISTS idx_ops_created ON ops (created_at);

CREATE TABLE IF NOT EXISTS notes (
  k          TEXT PRIMARY KEY,     -- e.g. 'nudge:<group_slug>'
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### A14. The endpoint table is missing two things §6.3 needs.

No endpoint sets `quorum`, though §6.3 makes it a setting. And nothing surfaces the generated nudge text, though §6.3 wants it as a banner. Adding `POST /api/quorum`, and a `nudge` field on `/api/state`. Both in §F.

### A15. Minor, no action needed from you.

- §2 bans third-party client JS; the test suite needs a runner. Node's built-in `node --test`, zero dependencies, dev-only, never served from `public/`. I run it here and paste the output — you never open a terminal.
- `POST /api/join` and `POST /api/person` happen **before** there's a cookie, so they need the group slug in the body. Added.
- §5's `pin_attempts` has no `group_slug`; `person_id` is globally unique so it doesn't need one. Fine as written.

---

## B. Where the live docs disagree with the spec

### B1. `nodejs_compat` is no longer opt-in, and your compat date is three days from the cliff.

§15 item 4 says *"`nodejs_compat` is never on by default"* and treats `>= 2024-09-23` as an open-ended window. Both have expired. The docs now read:

> For compatibility dates of **2026-08-04** or later, Workers and Pages projects enable both `nodejs_compat` and `nodejs_compat_v2` **by default**.

The v2 window was 2024-09-23 → 2026-08-03 and is closed. Your proposed `"2026-08-01"` sits three days on the old side of that cliff — which, by luck, preserves exactly the guardrail §15 item 4 wanted: `process.env` stays undefined.

**I'd keep `2026-08-01`, with a comment in the config saying why.** Otherwise the next person to look at it — including me in a later session — "helpfully" bumps it to today and silently turns Node compat on. The alternative (today's date, Node compat on, guardrail gone) costs you nothing functional either; it's the silent-change risk I care about, not the flag.

### B2. Cloudflare Access **can** now protect a `*.workers.dev` hostname. §11 says it can't.

> Require sign-in on a single Worker. This automatically protects every domain associated with the Worker, including its routes, Custom Domains, `workers.dev` hostname, and previews.

No custom domain needed. So the option §11 asks me to present as "the boring one that deletes a couple of hundred lines of security-sensitive code" is genuinely available to you today.

**I'd still say no, for two better reasons than the one in the spec:**
1. Access sits in front of *every* request, so WhatsApp's link-preview fetcher gets a login page and §7's unfurl dies outright.
2. Every friend does an email one-time-PIN round trip before they can tap anything, which blows §8.2's cold-link budget on the exact path that determines whether they bother.

It goes in the README as available-and-rejected-on-purpose with those reasons, so it stays your decision. (Free seat count: Cloudflare's technical docs don't state one and the plans page wasn't reachable from here, so I won't quote a number I can't source.)

### B3. D1's bound-parameter cap is exactly **100**, not "~100" — and it's per statement *inside* a batch.

So §15 item 19's warning is real and the arithmetic holds: a 14-day confirm at 22 slots × 6 columns = 132 parameters fails as one multi-row `INSERT`. There's no documented cap on the *number* of statements in a `batch()`, and each gets its own 100-parameter budget, so the answer is `batch()` with one prepared statement per row at 6 parameters each. Also per statement: 100 KB of SQL, 30 s max duration.

### B4. `INSERT … ON CONFLICT DO UPDATE` is not documented for D1 either way.

It's plain SQLite ≥ 3.24 so it will almost certainly work — but §13 calls the version counter *"the worst failure mode in the whole app"* and it's the one place I'm not willing to accept "almost certainly". So `GET /api/health` runs the upsert twice and reports whether the version actually moved:

```json
"checks": { "versionUpsert": { "before": 7, "after": 8, "ok": true } }
```

One click in a browser and you know. Fallback if it ever comes back false, using nothing newer than SQLite 3.0:
`INSERT OR REPLACE INTO meta(k,v) VALUES (?1, COALESCE((SELECT v FROM meta WHERE k=?1),0)+1)`

### B5. Cloudflare's cron weekdays run 1 = Sunday … 7 = Saturday.

Non-standard, and the docs recommend the three-letter form precisely to dodge it. `"0 17 * * SUN"` is correct as written; `"0 17 * * 0"` would have been invalid. Also: **5 cron triggers per account** on the free plan, so this uses one of five.

### B6. You never need the terminal, even for SQL.

The dashboard has a browser SQL console: **D1 → your database → Console → paste → Execute**, with a **Tables** tab for browsing rows. That's the escape hatch for anything the app can't do, and it removes the last reason to touch wrangler.

Related, and confirmed in the wrangler source rather than just the docs: `wrangler d1 execute` and `d1 migrations apply` default to `--local` with no error and no prompt — they silently hit a local SQLite file. §14 is right to warn about it. Every optional command in the README gets `--remote` on it.

### B7. Free-plan numbers, confirmed for the README.

| | |
|---|---|
| Workers requests | **100,000/day**, resets midnight UTC (Error 1027 over) |
| Workers CPU | **10 ms per invocation**, hard cap. Average Worker ≈ 2.2 ms |
| Subrequests | **50 per invocation** |
| D1 rows read | **5,000,000/day** |
| D1 rows written | **100,000/day** |
| D1 database size | **500 MB** max, 10 databases |
| Cron triggers | **5 per account** |

§13's *"about 11% of the daily allowance"* checks out (11,520 / 100,000). Worth noting it says nothing about the CPU budget, which is the tighter constraint and is per-invocation, not amortised — every poll must finish inside 10 ms of CPU on its own. That's what makes the PBKDF2 number in §11 matter, and it's why §19 asks me to measure it.

### B8. Smaller confirmations and corrections.

- **The Deploy button does not run a `migrations/` directory** — confirms §14's self-bootstrap decision. It *does* provision D1 and rewrite `database_id`.
- `"PLACEHOLDER"` isn't a documented magic string — any non-empty default works, because the button overwrites it. Cloudflare's own template uses `"<DATABASE_ID>"`. Keeping `"PLACEHOLDER"` per the spec, with a comment.
- **"Dashboard code editing is disabled once Workers Builds is connected" is not documented anywhere.** Widely reported, not citable, so the README will say "once the repo is connected, the repo is the source of truth" rather than asserting a UI lock. What *is* solid: **static assets cannot be uploaded from the dashboard editor at all.** So §14's zero-build fallback really does mean deleting the `assets` block and inlining the HTML.
- `preview_urls` defaults to whatever `workers_dev` is, so leaving it unset gives you a **second live hostname** serving the same app. Since the group link is a capability, I'm setting `"preview_urls": false` to keep it to one.
- `env.ASSETS.fetch()` accepts a `Request`, `URL` or string; the hostname is ignored, only the pathname matters. Whether it counts against the 50-subrequest budget is undocumented — another small reason A12 avoids putting it on the home path.
- `scheduled()`'s first argument is documented as `controller` (`controller.cron`, `controller.scheduledTime`), not `event`. Cosmetic; matching the docs.
- Service-worker syntax isn't blind to *all* bindings — but **D1 bindings specifically require ES modules.** Same conclusion as §15 item 1, sharper reason.
- `Cache-Control: private, no-store` means Cloudflare's edge won't cache and won't auto-304, so the Worker does its own `If-None-Match` comparison. Exactly as §13 assumes.
- `$schema`: every Cloudflare example uses `./node_modules/wrangler/config-schema.json`, which won't exist in your repo since you never run `npm install`. Keeping the unpkg URL — it's an editor hint with no effect on deploy.
- FK constraints **are** enforced by default in D1, confirming §5's decision to declare none.
- Read replication is opt-in and off by default; a default D1 is single-primary. §15 item 14 stands, leave it alone.
- `.all()` is documented as an alias of `.run()`, both returning `{ success, meta, results }`. §15 item 10 stands.
- Named parameters: *"D1 only supports Ordered (`?NNNN`) and Anonymous (`?`)."* §15 item 9 stands.
- `exec()`: *"The input can be one or multiple queries separated by `\n`."* §15 item 20 stands.
- `Date.now()`: *"returns the time of the last I/O. It does not advance during code execution."* §15 item 7 stands, and it's a Spectre mitigation from 2017, so it isn't going away.

---

## C. Deviations I'm proposing

Three, all small, each buying something specific.

**C1. The nudge deep link becomes `/c/<token>`, not `/confirm?p=<token>`.**
`run_worker_first` patterns can't match query strings, so `/confirm` would have to be Worker-first in its entirety — meaning every visit to the confirm screen, token or not, costs a Worker invocation and an asset subrequest. Making the token its own path (`/c/*` Worker-first) means `/c/<token>` sets the cookie and 302s to a clean `/confirm`, which is then served straight from the asset layer. Shorter link for WhatsApp, token gone from the address bar and from history, and the screen that §6.4 calls the highest-leverage in the app loads at static-asset speed. Same headers as §7 requires: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, no logging of the path.

**C2. `plainday.js` and `tally.js` live once, in `public/shared/`, and the Worker imports them.**
Both are needed on both sides. Wrangler's bundler follows a relative import out of `src/`, and the browser loads the same file as a module — so one copy, no build step, no drift. A test asserts there's exactly one copy of each. (If Workers Builds ever refuses that import, the fallback is duplication plus a byte-equality test, and I'd tell you.)

**C3. I verify the tap budgets and the greyscale test by driving the real UI, not by declaring numbers.**
Chromium and Playwright are already in this session's container. So §8.2's counts come from actual clicks on the actual DOM at 320 px and 360 px, and §9's greyscale assertion runs on real rendered pixels rather than on the colour values I intended to produce. The rig lives in `test/e2e/` with its own dependencies, deliberately outside the root `package.json` so Workers Builds never installs it. §18's multiplayer criteria — two browsers, ETag change, 35-second propagation, replayed `opId` — get the same treatment.

---

## D. The config I'd actually ship

```jsonc
{
  "$schema": "https://unpkg.com/wrangler/config-schema.json",
  "name": "whos-free",
  "main": "./src/worker.js",

  // Deliberately BEFORE 2026-08-04. On or after that date the runtime turns
  // nodejs_compat + nodejs_compat_v2 on by default, which makes process.env
  // defined and removes the guardrail in §15 item 4. Do not "helpfully" bump
  // this to today without reading that note first.
  "compatibility_date": "2026-08-01",

  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    // Load-bearing. Assets are matched BEFORE the Worker by default, so without
    // this an /api/* request is served index.html and res.json() throws.
    // '*' is a deep match: /api/* covers /api/plan/abc123.
    // '/' is deliberately absent — see A12.
    "run_worker_first": ["/api/*", "/g/*", "/c/*"]
  },

  "d1_databases": [
    // "PLACEHOLDER" is overwritten by the Deploy button when it provisions the DB.
    { "binding": "DB", "database_name": "whos-free-db", "database_id": "PLACEHOLDER" }
  ],

  // UTC only, no timezone option. Cloudflare weekdays are 1=Sun..7=Sat, so the
  // three-letter form is the unambiguous one. 17:00 UTC = 18:00 London in summer.
  "triggers": { "crons": ["0 17 * * SUN"] },

  "observability": { "enabled": true },
  "workers_dev": true,
  // Otherwise this defaults to the value of workers_dev and you get a second
  // live hostname serving the same capability URL.
  "preview_urls": false
}
```

No `compatibility_flags`. No `wrangler.toml`. No `nodejs_compat`.

---

## E. File list

```
whos-free/
├── wrangler.jsonc
├── package.json                  # pins wrangler for Workers Builds. No build script.
├── README.md                     # all seven §19 items
├── .gitignore
│
├── src/
│   ├── worker.js                 # export default { fetch, scheduled }. Router only.
│   ├── config.js                 # §17's config object, slot windows, every copy string
│   ├── schema.js                 # SCHEMA[]: one statement per string, no internal newlines
│   ├── bootstrap.js              # booted guard, schema batch, group row, version seed
│   ├── session.js                # HMAC cookie + /c/ token. exp in SECONDS, the one place.
│   ├── pin.js                    # PBKDF2 deriveBits, pin_attempts lockout, timing-safe path
│   ├── read.js                   # /api/state: rows + pattern derivation + staleness
│   ├── write.js                  # marks, bulk chunking, confirm, pattern, plans, opId guard
│   ├── api.js                    # §F's handlers, ETag/304, version upsert in every batch
│   ├── pages.js                  # server-rendered /g/:slug with OG tags; /c/ token exchange
│   └── nudge.js                  # per-person nudge text; the scheduled() handler
│
├── public/
│   ├── index.html                # SPA shell. No third-party anything.
│   ├── app.js                    # views, router, polling, optimistic writes, offline queue
│   ├── app.css                   # the §9 encoding — one source of truth for the 8 variants
│   ├── shared/
│   │   ├── plainday.js           # 10 pure fns. The only Date.UTC in the codebase. (C2)
│   │   └── tally.js              # buckets, bands, quorum, confirmed_through. (C2)
│   └── og/whos-free-v1.png       # 1200×630, <300KB, versioned path
│
└── test/
    ├── plainday.test.js          # §10's required suite, run under all four TZs
    ├── tally.test.js             # buckets partition the roster; bands; quorum; maybe never counts
    ├── encoding.test.js          # §9 greyscale over the 8 rendered variants
    └── e2e/                      # (C3) own deps, outside root package.json
        ├── taps.spec.mjs         # §8.2 budgets, counted by real clicks
        ├── pixels.spec.mjs       # greyscale + contrast + 320px/360px targets, on real renders
        └── multiplayer.spec.mjs  # two contexts, ETag, 35s propagation, replayed opId
```

24 files. Nothing in `public/` that isn't mine.

---

## F. API contract (§12) — for approval

Every response carries `Cache-Control: private, no-store` and `Vary: Cookie`. Every mutation returns the new `version`. Errors are always `{ "error": "CODE", "message": "human string" }`.

Changes from §12's table are marked **[+]**.

### `GET /api/health` — no auth
```json
{ "ok": true, "version": 42, "booted": true,
  "invite": "https://whos-free.x.workers.dev/g/kQ2...",
  "inviteHidden": false,
  "checks": { "schema": "ok", "versionUpsert": { "before": 41, "after": 42, "ok": true } },
  "pbkdf2Ms": 3.4, "roster": 0 }
```
`invite` present only while `roster === 0` (A11); after that `"inviteHidden": true` and a pointer to the logs.

### `POST /api/join`
```json
→ { "slug": "kQ2...", "personId": "p_7Kd2...", "pin": "0000" }
← { "ok": true, "me": "p_7Kd2...", "hasPattern": false, "version": 42 }
← 401 { "error": "PIN_REQUIRED" }
← 401 { "error": "PIN_WRONG", "triesLeft": 3 }
← 429 { "error": "LOCKED", "retryAfterSeconds": 900,
        "message": "Too many tries, try again in 15 minutes." }
```
**[+]** `slug` in the body — there's no cookie yet, so the slug can't come from one. `pin` optional. Sets the session cookie: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7776000`.

### `POST /api/person`
```json
→ { "slug": "kQ2...", "name": "Kit", "opId": "..." }
← { "ok": true, "person": { "id": "p_3Bn8...", "name": "Kit", "colourSeed": 5 }, "version": 43 }
← 409 { "error": "ROSTER_FULL", "message": "The group is full at 12 people." }
← 409 { "error": "NAME_TAKEN" }
```
Works with a valid slug and no cookie — §6.1 needs it before anyone has joined. Capped at `ROSTER_CAP`.

### `GET /api/state?from=2026-08-25&to=2026-10-06&today=2026-08-25`
Send `If-None-Match` from the stored ETag; a 304 means nothing changed.
```json
{ "today": "2026-08-25", "version": 42, "me": "p_7Kd2...",
  "group": { "name": "The Group", "quorum": 4,
    "members": [ { "id": "p_7Kd2...", "name": "Ammar", "colourSeed": 3,
                   "confirmedThrough": "2026-09-08", "lastSeenAt": 1756108800000 } ] },
  "days": {
    "2026-08-29": {
      "MORNING":   { "p_7Kd2...": { "s": "FREE", "src": "EXPLICIT", "stale": false } },
      "AFTERNOON": { "p_7Kd2...": { "s": "FREE",  "src": "PATTERN",  "stale": false },
                     "p_9Qm4...": { "s": "BUSY",  "src": "EXPLICIT", "stale": true  } },
      "EVENING":   {}
    }
  },
  "plans": [ { "id": "pl_...", "day": "2026-08-29", "slot": "EVENING",
               "title": "Curry", "note": null, "createdBy": "p_7Kd2..." } ],
  "nudge": { "text": "Sat 10th has 5 of 7 …", "generatedAt": 1756108800000 }
}
```
Absence is the wire format for "not answered": a person missing from a slot object hasn't answered it, and `"EVENING": {}` means nobody has. **[+]** `nudge` (A14). `"src": "PATTERN"` is derived at read time and has no row.

### `POST /api/mark`
```json
→ { "day": "2026-09-05", "slot": "EVENING", "state": "FREE", "opId": "..." }
← { "ok": true, "version": 44,
    "tally": { "free": 5, "maybe": 1, "busy": 0, "assumed": 0, "stale": 0, "notAnswered": 1 },
    "ack": "Thanks — that's 5 of 7 filled in for September, and Sat 5th just became the best day." }
```
`"state": null` deletes the row. `ack` is §8.5, composed server-side where the group numbers actually live.

### `POST /api/marks/bulk`
```json
→ { "days": ["2026-09-05","2026-09-12"], "slots": ["EVENING"], "state": "FREE", "opId": "..." }
← { "ok": true, "version": 45,
    "changed": [ { "day": "2026-09-05", "slot": "EVENING", "from": null,   "to": "FREE" },
                 { "day": "2026-09-12", "slot": "EVENING", "from": "BUSY", "to": "FREE" } ],
    "ack": "12 days marked free." }
```
`from` is what makes undo a client-driven replay with no server-side undo token. Chunked to stay under 100 bound parameters per statement (B3), tested at the largest selection the UI allows.

### `POST /api/pattern`
```json
→ { "pattern": { "MON_EVENING": true, "TUE_EVENING": null, … }, "opId": "..." }
← { "ok": true, "version": 46, "confirmedThrough": null,
    "ack": "Saved. We'll assume this going forward — you can confirm or change any day." }
```
Exactly the 11 keys. Writes no marks.

### `POST /api/confirm`
```json
→ { "from": "2026-08-25", "to": "2026-09-07",
    "overrides": [ { "day": "2026-08-29", "slot": "EVENING", "state": "BUSY" } ],
    "opId": "..." }
← { "ok": true, "version": 47, "written": 19, "confirmedThrough": "2026-09-07",
    "ack": "Thanks — you're filled in until Sun 7 Sep. That's 5 of 7 for the next two weeks." }
```
**[+]** `overrides`, so A6's "3 left" rows and any flipped row commit in the same request as the confirmation — which is what keeps it one tap.

### `POST /api/quorum` **[+]** (A14)
```json
→ { "quorum": 5, "opId": "..." }
← { "ok": true, "version": 48, "quorum": 5, "suggested": 4 }
```

### `POST /api/plan` · `PATCH /api/plan/:id` · `DELETE /api/plan/:id`
```json
→ { "day": "2026-09-12", "slot": "EVENING", "title": "Curry", "note": null, "opId": "..." }
← { "ok": true, "version": 49, "plan": { "id": "pl_...", … } }
```
`DELETE` is a soft delete; the response returns the previous row so the undo snackbar can restore it.

### `GET /api/nudge/:personId`
```json
{ "text": "Sat 10th has 5 of 7 — you're the one we're missing. One tap: https://…/c/eyJ…",
  "url": "https://…/c/eyJ…", "expiresAt": 1756713600000 }
```
Never rendered into a page, never pasted into the group chat. Headers per §7. Token expiry 7 days, not single-use.

### Idempotency
Every mutation carries `opId`. A repeat within an hour returns the **cached original response** rather than re-applying, so a replayed offline queue can't double-apply and can't confuse the client with a different answer than it got the first time. Backed by the `ops` table in A13.

---

## G. What I need from you

1. **The group name.**
2. **The seven names.** Or say the word and I'll seed only you and let the roster fill itself through "+ Add someone" after deploy — the app supports that path already, so this genuinely isn't a blocker.
3. **Approval of §F**, per §12. Or tell me what to change.
4. The four questions on the card.
