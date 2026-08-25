# Who's Free

A busy/free calendar for one friend group. One shared link, no accounts, one screen
that answers *"which upcoming evenings and weekend slots do most of us have free?"*

A Cloudflare Worker with static assets, plus one D1 database. No other services, no
third-party JavaScript on the client, and no terminal required.

---

## 1. Deploying it, entirely in a browser

**1. Put the code on GitHub.**
Create a new repository at [github.com/new](https://github.com/new) — call it
`whos-free`, make it private if you like. On the empty-repository page, click
**"uploading an existing file"** and drag the whole project folder in. Commit.

**2. Deploy it.**
Open, substituting your GitHub username and repo name:

```
https://deploy.workers.cloudflare.com/?url=https://github.com/<your-username>/whos-free
```

Cloudflare clones the repo into your account, reads `wrangler.jsonc`, **creates the
D1 database automatically**, connects Workers Builds, and deploys to a
`*.workers.dev` URL.

> **On `"database_id": "PLACEHOLDER"`** — leave it exactly as it is. The Deploy
> button provisions a database and rewrites that value for you. If it somehow
> doesn't, go to **D1 SQL database → Create**, name it `whos-free-db`, and paste
> its UUID over `PLACEHOLDER`. Do not run `wrangler d1 create`.

**3. Add the one secret.**
Your Worker → **Settings** → **Variables and Secrets** → **Add** → type **Secret**,
name `SESSION_SECRET`, value = any long random string (mash the keyboard, 40+
characters). **Deploy**.

Until this exists the app shows a "one thing left" page instead of running, so you
can't miss it.

**4. Open `/api/health` once.**
`https://whos-free.<your-subdomain>.workers.dev/api/health`

This creates the database tables, creates your group, and prints the invite URL.
It also self-checks: `checks.versionUpsert.ok` must be `true` (see
[§8](#8-if-something-is-wrong)).

**5. Add everyone.**
Open the invite URL, then use **"+ Add someone"** for each person. Send the same
invite link into the group chat. That's it.

**Changing something later:** edit the file on GitHub in the browser and commit.
Workers Builds redeploys automatically. Once the repo is connected, the repo is the
source of truth — make changes there rather than in the dashboard editor.

### Optional, terminal only

Everything below is optional. Note the `--remote` on every command: without it
wrangler silently uses a **local** SQLite file, which is how people "apply" a
change, deploy, and then get `no such table`.

```bash
npm install
npx wrangler dev --config wrangler.dev.jsonc   # local, with a throwaway database
npx wrangler d1 execute whos-free-db --remote --command "SELECT count(*) FROM people"
npm test                                       # the date and tally suites
npm run test:tz                                # the same suites in four timezones
```

You don't need any of it to run SQL, either — the dashboard has a browser console:
**D1 SQL database → your database → Console**, with a **Tables** tab for browsing.

---

## 2. Finding the invite URL, and rotating it

**Right after deploying,** `GET /api/health` returns it.

**After anyone has joined, it stops doing that** — deliberately. The invite link is
the entire security model, and an endpoint that prints it on request to anyone who
guesses your Worker's hostname would hand the group away. It is instead written to
your logs on every cold start: **your Worker → Logs**, look for
`[whos-free] invite URL:`.

**To rotate the slug** (someone leaves for real, or the link leaked) — dashboard
console, **D1 → your database → Console**:

```sql
UPDATE groups SET slug = 'paste-a-fresh-random-string-here';
UPDATE marks SET group_slug = (SELECT slug FROM groups);
UPDATE people SET group_slug = (SELECT slug FROM groups);
UPDATE patterns SET group_slug = (SELECT slug FROM groups);
UPDATE plans SET group_slug = (SELECT slug FROM groups);
DELETE FROM meta;
```

Everyone needs the new link. Everyone's existing sessions still work, because they
are signed against the person, not the slug — to log *everyone* out, change
`SESSION_SECRET` instead.

---

## 3. What this is and isn't secure against

In plain English, because you should be able to decide whether you're comfortable
with it.

**Anyone who has the group link can open the app**, and can pick any name that
hasn't set a PIN. That's the whole gate. A PIN stops your friends editing your row
by accident; it is not a password, and it doesn't stop anyone with the link from
reading everything.

**The `/c/...` nudge links are more dangerous than the group link.** One of them
lets whoever holds it act *as that person*, PIN or not, for seven days. They exist
so a nudge can be one tap. Send them to one person, in a direct message. **Never
paste one into the group chat.** The app never puts one on a page, and copying one
shows you that warning.

**Links leak in ways that aren't obvious.** Pasting a link into WhatsApp makes
WhatsApp's servers fetch it. Links sit in browser history, in screenshots, and on
shared screens.

**Removing someone properly means rotating the slug** (§2) and telling everyone
else the new link. Setting them inactive removes them from the app but not from the
link they already have.

**What's actually at risk:** there is nowhere in the database to put a private event
title. Availability is a single value — free, maybe or busy — with no note, no
description, no title field, and the schema must never gain one. So the worst case
is that somebody learns you're busy on Thursday.

**This is fine for busy/free among friends. It would not be fine for anything
sensitive.**

Rotating `SESSION_SECRET` in the dashboard logs everybody out immediately. For
seven people, that's a perfectly good panic button.

---

## 4. The boring alternative you might prefer: Cloudflare Access

Cloudflare Access (Zero Trust) puts an email one-time-code login in front of the
whole app, and would delete every line of PIN and session code in here. It works on
a `*.workers.dev` hostname — you do **not** need a custom domain, which contradicts
what you may have read; the current docs are explicit that Worker-level Access
covers "routes, Custom Domains, `workers.dev` hostname, and previews".

**I'd still say no, for two specific reasons:**

1. It sits in front of *every* request, including WhatsApp's link-preview fetcher.
   Your invite link would stop unfurling — no group name, no "3 of 7 have filled in"
   line, just a bare URL in the chat.
2. Everyone does an email round-trip before they can tap anything. The thing that
   makes this app work at all is that a cold link to fully answered is five taps;
   Access adds "go and check your email" to the front of it.

If you decide the login is worth it anyway: your Worker → **Settings** → **Domains
& Routes**, and enable Access there. Then delete `src/pin.js`, the `pin_attempts`
table, and the PIN branch in `/api/join`. It's your call and it's a reasonable one —
the reason to say no is the unfurl and the taps, not the security.

Note also that `*.workers.dev` is not a zone you own, so zone-level features — WAF
custom rules, rate-limiting rules — don't apply to it. Adding a custom domain
(Worker → Settings → Domains & Routes → Add → Custom domain; the domain has to be
on the same Cloudflare account) would change that.

---

## 5. PBKDF2, measured

The free plan gives a **hard 10 ms of CPU per invocation**. Measured on this
primitive:

| Iterations | Time |
|---|---|
| 1,000 | 1.9 ms |
| 5,000 | 3.6 ms |
| **6,000 (shipped)** | **~4 ms** |
| 10,000 | 5.8 ms |
| 20,000 | 10.0 ms — over budget |
| 100,000 | 48.5 ms — hopeless |

**Shipped: `PBKDF2_ITERATIONS = 6000`**, in `public/shared/config.js`.

10,000 also fits, but it spends about 58% of the entire CPU budget on one hash, and
it spends it on `/api/join` — the very first screen a new person touches. The
failure mode there is an intermittent `Exceeded CPU limit`, which is the least
diagnosable error in the whole app. 6,000 leaves real headroom.

This costs almost nothing in security, because the hash was never the control. A
4-digit PIN is a 10,000-value keyspace; no iteration count survives someone who can
make 10,000 requests. **The lockout is the control**: five wrong tries and that
person is locked out for 15 minutes, recorded in `pin_attempts`.

`/api/health` reports the live measurement (`pbkdf2.ms`) so you can check it on real
Cloudflare hardware rather than trusting this table. Note that the in-Worker number
is wall-clock across an async boundary and reads a little high — `Date.now()` in
this runtime returns the time of the last I/O — so treat the table above as the
better estimate of actual CPU.

Nothing else in the app does expensive work. A poll reads one indexed row and
usually returns a 304.

---

## 6. Deliberately not built

These were decided against, not forgotten.

- **Google / Apple calendar sync.** The obvious "don't make people type what their
  phone already knows" feature, and the biggest single reason tools like this get
  abandoned. It's also OAuth, token refresh, iCloud app-specific passwords, and a
  far bigger privacy surface. The typical-week pattern plus one-tap confirm is the
  cheap 80%. `marks.source` is deliberately left **unconstrained** in the schema so
  an `IMPORTED` value can be added later without rebuilding the table.
- **A fourth availability value.** `FREE` / `MAYBE` / `BUSY` is final for v1, and
  this one is a genuine one-way door: **SQLite cannot alter a CHECK constraint.**
  Adding a value later means rebuilding the `marks` table and copying the data — and
  because the schema bootstraps with `CREATE TABLE IF NOT EXISTS`, editing
  `src/schema.js` has **no effect on the live database**. The CHECK is kept on
  `state` because that is exactly where a bad write should be stopped at the
  database. Treat any change to it as a real migration.
- **Web Push.** On iOS the site has to be installed to the Home Screen first, which
  is a conversion cliff in the critical path. The weekly copy-paste nudge instead.
- **Multiple groups**, per-person visibility rules, "pause this week", native apps,
  event RSVPs, cost splitting, anything social-feed shaped.
- **Streaks, points, leaderboards.** The whole tension in this app is unwanted
  social obligation. Manufacturing more of it would be actively counterproductive.
- **Ads, upsell, per-person feature gating.** In a group this size a two-tier
  feature set breaks the one thing that has to work: everyone using the same app.
- **Drag-to-paint** in the month grid. On touch it fights the scroll gesture, has no
  hover state, and fails WCAG 2.5.7 unless a single-pointer alternative exists
  anyway — and if that alternative exists, it's the feature. Select mode plus the
  column-header bulk fill does the same job.

---

## 7. If you ever want real-time push

You don't need it. Polling every 25 seconds while the tab is visible costs about
14% of the free daily request allowance for a group of 12, and almost all of those
requests are 304s that read a single indexed row. Your own changes are applied
locally the instant you tap, so the only latency anyone experiences is on *other*
people's changes — which is why every row carries who changed it and when.

If you did want true push, the shape is **one Durable Object per group, using the
WebSocket Hibernation API**: clients connect to the DO, writes go through it, and it
broadcasts to everyone connected. Hibernation means you don't pay for idle
connections. That is the correct engineering, and it is completely disproportionate
for seven friends checking a grid a few times a week. SSE is not a middle ground —
a stateless Worker has no way to *learn* that someone else wrote something, so SSE
degenerates into polling D1 inside a held-open connection: same reads, worse retry
semantics.

---

## 8. If something is wrong

Open **`/api/health`** first. It reports:

```json
{ "ok": true, "version": 12,
  "checks": { "schema": "ok", "versionUpsert": { "before": 11, "after": 12, "ok": true } },
  "pbkdf2": { "iterations": 6000, "ms": 4, "cpuLimitMs": 10 } }
```

**`versionUpsert.ok` must be `true`.** If it is ever `false`, that is the single
worst failure this app can have, and it is worth understanding why: every write
bumps a counter, and the counter drives the ETag that tells other people's phones
that something changed. If the counter freezes, *your own* changes still appear
instantly — they're applied locally — so everything looks fine to you, while
everybody else silently stops seeing anything anyone does. No error appears
anywhere. That's why the check is in `/api/health` rather than assumed.

Other things worth knowing:

- **Logs:** your Worker → **Logs**. `observability` is on in `wrangler.jsonc`;
  without it, debugging is blind.
- **"Unexpected token '<'"** in a browser console means an `/api/*` request got
  served `index.html`. That means `assets.run_worker_first` in `wrangler.jsonc` has
  been changed or removed. It is load-bearing.
- **Everyone logged out at once:** `SESSION_SECRET` changed.
- **Nobody can join:** check `SESSION_SECRET` exists at all.

---

## How it's put together

```
src/worker.js       entry point: export default { fetch, scheduled }
src/api.js          every endpoint
src/read.js         builds /api/state, derives assumed values at read time
src/write.js        mutations, bulk chunking, opId idempotency
src/session.js      HMAC cookies and /c/ nudge tokens
src/pin.js          PBKDF2 and the lockout
src/pages.js        server-rendered /g/:slug (for the WhatsApp unfurl) and /c/
src/bootstrap.js    creates the schema and the group on first request
src/schema.js       the SQL, one statement per string
src/nudge.js        nudge and weekly-digest text
src/ack.js          the "thanks, that's 5 of 7" sentence

public/index.html   the app shell
public/app.js       every screen, polling, offline queue
public/app.css      the eight visual variants, defined once
public/join.js      the invite screen
public/shared/      plainday.js, tally.js, config.js, clock.js
                    -- shared by the Worker and the browser, ONE copy each.
                    Wrangler's bundler follows the import out of src/, and the
                    browser loads the same files as modules.

tools/palette.mjs   derives the fills from L* targets. Edit the targets, not the
                    hex values, or test/encoding.test.js will fail for reasons
                    nobody can see.
test/               node --test, zero dependencies
test/e2e/           browser checks. Own package.json on purpose, so Workers
                    Builds never installs Playwright.
```

Two files are worth reading before changing anything:

**`public/shared/plainday.js`** — dates are `{y,m,d}` tuples and `'YYYY-MM-DD'`
strings, never instants. There is no `Date` in that file at all: weekdays come from
epoch-day arithmetic, so nothing in it can be shifted by a timezone. The test suite
cross-checks 12 years of weekdays against `Date.UTC` as an oracle and runs under
`Europe/London`, `UTC`, `Pacific/Auckland` and `America/Los_Angeles`.

**`public/shared/tally.js`** — the one rule: *"not answered" is never counted as
"free"*. Absence of a row means silence. A test asserts the six buckets always sum
to the roster, which is the cheapest possible way to stop `free` quietly absorbing
a guess, a stale answer, or somebody who never opened the app.
