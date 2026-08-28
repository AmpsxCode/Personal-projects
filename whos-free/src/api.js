// The API surface. Every response is private/no-store with Vary: Cookie, every
// mutation returns the new version, and every mutation's write shares one
// batch() with the version bump.

import { isValid } from '../public/shared/plainday.js';
import { slotsFor, validatePattern } from '../public/shared/tally.js';
import { buildAck } from './ack.js';
import { CONFIG, COPY } from './config.js';
import {
  DEFAULT_GROUP_NAME, bumpVersion, loadGroup, pruneOpsStatement, readVersion,
} from './bootstrap.js';
import { nudgeNoteKey, personalNudge, planAnnounce, weeklyDigest } from './nudge.js';
import * as pin from './pin.js';
import { buildState, windowFor } from './read.js';
import { clearCookie, currentSession, nudgeToken, sessionCookie } from './session.js';
import { cleanName, colourSeed, fail, json, originOf, personId as newPersonId, planId } from './util.js';
import {
  bulkStatements, commit, confirmWindow, expandBulk, markStatements, patternStatement,
  previousMarks, recordOpStatement, seenOp, validSlot, validState,
} from './write.js';

const etagFor = (v) => `W/"${v}"`;

/** Resolve the session into a live, active person, or return a 401 response. */
async function authenticate(request, env, nowMs) {
  const session = await currentSession(request, env.SESSION_SECRET, nowMs);
  if (!session) return { error: fail(401, 'NO_SESSION', 'Open your invite link.') };
  const group = await loadGroup(env);
  if (!group || group.slug !== session.g) {
    return { error: fail(401, 'NO_SESSION', 'That link is no longer valid.') };
  }
  const person = await env.DB.prepare(
    'SELECT id, name, active, last_seen_at FROM people WHERE id = ?1 AND group_slug = ?2',
  ).bind(session.u, group.slug).first();
  if (!person || !person.active) {
    return { error: fail(401, 'NO_SESSION', 'You are no longer in this group.'), clear: true };
  }
  return { session, group, person };
}

/** Slide the cookie forward so "first visit only" does not recur every 90 days. */
async function withRenewedSession(response, group, personId, env, nowMs) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', await sessionCookie(group.slug, personId, env.SESSION_SECRET, nowMs));
  return new Response(response.body, { status: response.status, headers });
}

// ---------------------------------------------------------------- health -----

async function health(request, env, nowMs) {
  const group = await loadGroup(env);
  const version = group ? await readVersion(env.DB, group.slug) : 0;
  const roster = group
    ? await env.DB.prepare('SELECT count(*) AS n FROM people WHERE group_slug = ?1 AND active = 1')
      .bind(group.slug).first()
    : { n: 0 };

  // Prove the version upsert actually increments on THIS database.
  //
  // INSERT ... ON CONFLICT DO UPDATE is standard SQLite but is not documented
  // for D1 either way, and a silently frozen version counter is the worst
  // failure mode in this app: your own writes are optimistic so everything
  // looks fine, and only other people's changes go missing, with no error
  // anywhere. So we check it here instead of assuming.
  let check = { ok: false };
  if (group) {
    const before = await readVersion(env.DB, group.slug);
    await env.DB.batch([bumpVersion(env.DB, group.slug)]);
    const after = await readVersion(env.DB, group.slug);
    check = { before, after, ok: after === before + 1 };
  }

  // Measure PBKDF2 so the number in the README is real. Date.now() does not
  // advance during synchronous execution in this runtime, but deriveBits is
  // async I/O-ish work, so the clock does move across it.
  const t0 = Date.now();
  await pin.derive('123456', pin.newSalt());
  const pbkdf2Ms = Date.now() - t0;

  const body = {
    ok: true,
    version,
    roster: roster ? roster.n : 0,
    group: group ? { name: group.name, quorum: group.quorum } : null,
    checks: { schema: 'ok', versionUpsert: check },
    pbkdf2: { iterations: CONFIG.PBKDF2_ITERATIONS, ms: pbkdf2Ms, cpuLimitMs: 10 },
  };

  // The invite URL is the whole capability. It is printed here only while the
  // roster is still empty - i.e. for the minute after deploying, when you need
  // it - and then never again. It is also console.logged on bootstrap, so it
  // stays findable in the dashboard logs forever.
  if (group && (!roster || roster.n === 0)) {
    body.invite = `${originOf(request)}/g/${group.slug}`;
    body.inviteNote = 'Open this now. It disappears from here once someone joins.';
  } else {
    body.inviteHidden = true;
    body.inviteNote = 'Hidden because the roster is not empty. It is in the dashboard logs (Workers > your Worker > Logs), or rotate it per the README.';
  }
  return json(body);
}

// ------------------------------------------------------------------ join -----

async function join(request, env, nowMs) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.personId !== 'string') return fail(400, 'BAD_REQUEST');
  const group = await loadGroup(env);
  if (!group || body.slug !== group.slug) return fail(404, 'NO_GROUP', 'That invite link is not valid.');

  const person = await env.DB.prepare(
    'SELECT id, name, pin_salt, pin_hash, active FROM people WHERE id = ?1 AND group_slug = ?2',
  ).bind(body.personId, group.slug).first();

  // Compute a hash even when the person does not exist, so a wrong name and a
  // wrong PIN cost the same time and this is not a membership oracle.
  if (!person || !person.active) {
    await pin.burnTime(body.pin);
    return fail(404, 'NO_PERSON', 'That name is not in this group any more.');
  }

  if (person.pin_hash) {
    const lock = await pin.lockState(env.DB, person.id, nowMs);
    if (lock.locked) {
      return json({
        error: 'LOCKED', message: COPY.PIN_LOCKED, retryAfterSeconds: lock.retryAfterSeconds,
      }, { status: 429 });
    }
    if (!pin.validPin(body.pin)) {
      await pin.burnTime(body.pin);
      return fail(401, 'PIN_REQUIRED', 'This name is protected by a PIN.');
    }
    const hash = await pin.derive(body.pin, person.pin_salt);
    if (!pin.sameHash(hash, person.pin_hash)) {
      await env.DB.batch([pin.recordFailStatement(env.DB, person.id, lock.fails, nowMs)]);
      const left = Math.max(0, CONFIG.PIN_MAX_FAILS - (lock.fails + 1));
      return left === 0
        ? json({
          error: 'LOCKED', message: COPY.PIN_LOCKED,
          retryAfterSeconds: Math.ceil(CONFIG.PIN_LOCK_MS / 1000),
        }, { status: 429 })
        : json({ error: 'PIN_WRONG', message: 'That PIN is not right.', triesLeft: left }, { status: 401 });
    }
    await env.DB.batch([pin.clearFailsStatement(env.DB, person.id)]);
  } else if (pin.validPin(body.pin)) {
    // First-time PIN set: they offered one and this name had none.
    const salt = pin.newSalt();
    const hash = await pin.derive(body.pin, salt);
    await env.DB.batch([
      env.DB.prepare('UPDATE people SET pin_salt = ?2, pin_hash = ?3 WHERE id = ?1')
        .bind(person.id, salt, hash),
    ]);
  }

  const pattern = await env.DB.prepare('SELECT person_id FROM patterns WHERE person_id = ?1')
    .bind(person.id).first();
  const version = await readVersion(env.DB, group.slug);

  await env.DB.batch([
    env.DB.prepare('UPDATE people SET last_seen_at = ?2 WHERE id = ?1').bind(person.id, nowMs),
  ]);

  const res = json({ ok: true, me: person.id, name: person.name, hasPattern: !!pattern, version });
  const headers = new Headers(res.headers);
  headers.append('Set-Cookie', await sessionCookie(group.slug, person.id, env.SESSION_SECRET, nowMs));
  return new Response(res.body, { status: 200, headers });
}

// ---------------------------------------------------------------- person -----

async function addPerson(request, env, nowMs) {
  const body = await request.json().catch(() => null);
  const name = cleanName(body && body.name);
  if (!name) return fail(400, 'BAD_NAME', 'Give them a name.');
  const group = await loadGroup(env);
  if (!group) return fail(404, 'NO_GROUP');

  // Works with a valid slug and no cookie: the roster has to be fillable before
  // anyone has joined. Anyone with the group link can add a name; that is in
  // the threat model, and ROSTER_CAP is the backstop.
  const session = await currentSession(request, env.SESSION_SECRET, nowMs);
  const slug = (body && body.slug) || (session && session.g);
  if (slug !== group.slug) return fail(403, 'FORBIDDEN');

  const count = await env.DB.prepare(
    'SELECT count(*) AS n FROM people WHERE group_slug = ?1 AND active = 1',
  ).bind(group.slug).first();
  if (count.n >= CONFIG.ROSTER_CAP) {
    return fail(409, 'ROSTER_FULL', `The group is full at ${CONFIG.ROSTER_CAP} people.`);
  }
  const clash = await env.DB.prepare(
    'SELECT id FROM people WHERE group_slug = ?1 AND active = 1 AND lower(name) = lower(?2)',
  ).bind(group.slug, name).first();
  if (clash) return fail(409, 'NAME_TAKEN', `${name} is already on the list.`);

  const id = newPersonId();
  const seed = colourSeed();
  await commit(env, group.slug, [
    env.DB.prepare(
      'INSERT INTO people (id, group_slug, name, colour_seed, active, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)',
    ).bind(id, group.slug, name, seed, nowMs),
  ], body && body.opId, id, nowMs, { ok: true });

  return json({
    ok: true,
    person: { id, name, colourSeed: seed },
    version: await readVersion(env.DB, group.slug),
  });
}

// ----------------------------------------------------------------- state -----

async function state(request, env, ctx, nowMs) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) {
    return auth.clear
      ? new Response(auth.error.body, {
        status: auth.error.status,
        headers: (() => { const h = new Headers(auth.error.headers); h.append('Set-Cookie', clearCookie()); return h; })(),
      })
      : auth.error;
  }
  const { group, person } = auth;
  const url = new URL(request.url);

  // The client sends its own `today`. The server treats it as an opaque window
  // boundary and never derives it: the Workers runtime is always UTC, so it
  // cannot know what day it is where the reader is standing.
  const today = url.searchParams.get('today');
  if (!isValid(today)) return fail(400, 'BAD_TODAY', 'Send today as YYYY-MM-DD.');

  const version = await readVersion(env.DB, group.slug);
  const etag = etagFor(version);
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
    });
  }

  const { from, to } = windowFor(today, url.searchParams.get('from'), url.searchParams.get('to'));
  const payload = await buildState(env, group, person.id, from, to, today, nowMs);
  payload.version = version;

  // The weekly nudge text. A stored snapshot (written by the cron) keeps the
  // wording stable across the week; if there is none, or it has gone stale, we
  // compute it live so the banner is never empty and no GET ever writes.
  const stored = await env.DB.prepare('SELECT v, updated_at FROM notes WHERE k = ?1')
    .bind(nudgeNoteKey(group.slug)).first();
  if (stored && nowMs - stored.updated_at < CONFIG.NUDGE_TTL_MS) {
    payload.nudge = { text: stored.v, generatedAt: stored.updated_at, live: false };
  } else {
    payload.nudge = {
      text: weeklyDigest(payload, payload.members, originOf(request), group.slug),
      generatedAt: nowMs,
      live: true,
    };
  }

  // Refresh last_seen_at at most every 10 minutes, and DO NOT bump the version
  // for it: a version bump on every poll would invalidate every other client's
  // ETag, so nothing would ever return 304 and polling would cost 30x more.
  if (!person.last_seen_at || nowMs - person.last_seen_at > 600000) {
    ctx.waitUntil(env.DB.prepare('UPDATE people SET last_seen_at = ?2 WHERE id = ?1')
      .bind(person.id, nowMs).run());
  }

  const res = json(payload, { headers: { ETag: etag } });
  return withRenewedSession(res, group, person.id, env, nowMs);
}

// ----------------------------------------------------------------- marks -----

async function mark(request, env, nowMs) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group, person } = auth;
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, 'BAD_REQUEST');

  const { day, slot, opId } = body;
  const st = body.state === undefined ? null : body.state;
  if (!isValid(day)) return fail(400, 'BAD_DAY');
  if (!validSlot(slot)) return fail(400, 'BAD_SLOT');
  if (!validState(st)) return fail(400, 'BAD_STATE');

  const replay = await seenOp(env.DB, opId);
  if (replay) return json(replay);

  const prev = await previousMarks(env.DB, group.slug, person.id, [{ day, slot }]);
  const previous = prev.get(`${day}|${slot}`) || null;

  await commit(env, group.slug,
    markStatements(env.DB, group.slug, person.id, day, slot, st, nowMs),
    null, person.id, nowMs, null);

  const today = isValid(body.today) ? body.today : day;
  const { from, to } = windowFor(today);
  const fresh = await buildState(env, group, person.id, from, to, today, nowMs);
  const version = await readVersion(env.DB, group.slug);
  const response = {
    ok: true,
    version,
    changed: [{ day, slot, from: previous, to: st }],
    ack: buildAck(fresh, fresh.members, day, [{ day, slot, personId: person.id, previous }]),
  };
  if (opId) {
    await env.DB.batch([recordOpStatement(env.DB, opId, person.id, nowMs, response)]);
  }
  return json(response, { headers: { ETag: etagFor(version) } });
}

async function bulk(request, env, nowMs) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group, person } = auth;
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.days) || !body.days.length) return fail(400, 'BAD_REQUEST');
  const st = body.state === undefined ? null : body.state;
  if (!validState(st)) return fail(400, 'BAD_STATE');
  for (const d of body.days) if (!isValid(d)) return fail(400, 'BAD_DAY', `Not a date: ${d}`);
  if (body.days.length > 400) return fail(400, 'TOO_MANY_DAYS');

  const replay = await seenOp(env.DB, body.opId);
  if (replay) return json(replay);

  const keys = expandBulk(body.days, body.slots, body.eveningsOnly === true);
  if (!keys.length) return fail(400, 'NO_SLOTS');

  const prev = await previousMarks(env.DB, group.slug, person.id, keys);
  const changed = keys.map(({ day, slot }) => ({
    day, slot, from: prev.get(`${day}|${slot}`) || null, to: st,
  }));

  // ONE STATEMENT PER ROW. As a single multi-row INSERT this would blow D1's
  // hard cap of 100 bound parameters at 17 rows.
  await commit(env, group.slug,
    bulkStatements(env.DB, group.slug, person.id, keys, st, nowMs),
    null, person.id, nowMs, null);

  const today = isValid(body.today) ? body.today : body.days[0];
  const { from, to } = windowFor(today);
  const fresh = await buildState(env, group, person.id, from, to, today, nowMs);
  const version = await readVersion(env.DB, group.slug);
  const word = st === null ? 'cleared' : `marked ${st.toLowerCase()}`;
  const response = {
    ok: true,
    version,
    changed,
    ack: `${body.days.length} ${body.days.length === 1 ? 'day' : 'days'} ${word}. `
      + buildAck(fresh, fresh.members, body.days[0],
        changed.map((c) => ({ ...c, personId: person.id, previous: c.from }))),
  };
  if (body.opId) await env.DB.batch([recordOpStatement(env.DB, body.opId, person.id, nowMs, response)]);
  return json(response, { headers: { ETag: etagFor(version) } });
}

// --------------------------------------------------------------- pattern -----

async function pattern(request, env, nowMs) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group, person } = auth;
  const body = await request.json().catch(() => null);
  const clean = validatePattern(body && body.pattern);
  if (!clean) return fail(400, 'BAD_PATTERN', 'Send exactly the 11 keys, each true, false or null.');

  const replay = await seenOp(env.DB, body.opId);
  if (replay) return json(replay);

  // Writes the patterns row and NO marks. Assumed values are derived at read
  // time; materialising them here would make "no row = not answered" false.
  const stmt = patternStatement(env.DB, group.slug, person.id, clean, nowMs);
  await commit(env, group.slug, [stmt], body.opId, person.id, nowMs, { ok: true });

  const answered = Object.values(clean).filter((v) => v !== null).length;
  return json({
    ok: true,
    version: await readVersion(env.DB, group.slug),
    answered,
    ack: answered === 0
      ? "Saved - but you haven't told us anything yet, so you'll show as 'not answered' everywhere."
      : `Saved ${answered} of 11. We'll assume this going forward - you can confirm or change any day.`,
  });
}

// --------------------------------------------------------------- confirm -----

async function confirm(request, env, nowMs) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group, person } = auth;
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, 'BAD_REQUEST');
  const today = isValid(body.today) ? body.today : null;
  if (!today) return fail(400, 'BAD_TODAY');
  const win = confirmWindow(today);
  const from = isValid(body.from) ? body.from : win.from;
  const to = isValid(body.to) ? body.to : win.to;

  const replay = await seenOp(env.DB, body.opId);
  if (replay) return json(replay);

  // Read the derived grid, then materialise exactly what was shown. Rows with
  // no derived value are NOT written - there is nothing to confirm, and
  // inventing a value would be the whole thing this app must not do. Those rows
  // arrive as explicit `overrides` instead, so the "3 left" list and the
  // confirmation commit together in one request and one tap.
  const view = await buildState(env, group, person.id, from, to, today, nowMs);
  const overrides = new Map();
  for (const o of (Array.isArray(body.overrides) ? body.overrides : [])) {
    if (isValid(o.day) && validSlot(o.slot) && validState(o.state)) {
      overrides.set(`${o.day}|${o.slot}`, o.state);
    }
  }

  const statements = [];
  const reverts = [];
  let written = 0;
  for (const [day, slots] of Object.entries(view.days)) {
    for (const [slot, entries] of Object.entries(slots)) {
      const key = `${day}|${slot}`;
      const mine = entries[person.id];
      const override = overrides.has(key) ? overrides.get(key) : undefined;
      const target = override !== undefined ? override : (mine ? mine.s : undefined);
      if (target === undefined) continue;                       // nothing to confirm
      if (override === undefined && mine && mine.src === 'EXPLICIT' && !mine.stale) continue; // already solid
      statements.push(...markStatements(env.DB, group.slug, person.id, day, slot, target, nowMs));
      reverts.push({ day, slot, personId: person.id, previous: mine && mine.src === 'EXPLICIT' ? mine.s : null });
      written += 1;
    }
  }

  if (statements.length) {
    await commit(env, group.slug, statements, null, person.id, nowMs, null);
  }

  const fresh = await buildState(env, group, person.id, from, to, today, nowMs);
  const mine = fresh.members.find((m) => m.id === person.id);
  const version = await readVersion(env.DB, group.slug);
  const response = {
    ok: true,
    version,
    written,
    confirmedThrough: mine ? mine.confirmedThrough : null,
    ack: buildAck(fresh, fresh.members, from, reverts),
  };
  if (body.opId) await env.DB.batch([recordOpStatement(env.DB, body.opId, person.id, nowMs, response)]);
  return json(response, { headers: { ETag: etagFor(version) } });
}

// ---------------------------------------------------------------- quorum -----

async function quorum(request, env, nowMs) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group, person } = auth;
  const body = await request.json().catch(() => null);
  const n = Number(body && body.quorum);
  if (!Number.isInteger(n) || n < 1 || n > CONFIG.ROSTER_CAP) return fail(400, 'BAD_QUORUM');

  await commit(env, group.slug, [
    env.DB.prepare('UPDATE groups SET quorum = ?2 WHERE slug = ?1').bind(group.slug, n),
  ], body.opId, person.id, nowMs, { ok: true });

  const count = await env.DB.prepare(
    'SELECT count(*) AS n FROM people WHERE group_slug = ?1 AND active = 1',
  ).bind(group.slug).first();
  return json({
    ok: true,
    quorum: n,
    suggested: Math.ceil((count.n || 1) / 2),
    version: await readVersion(env.DB, group.slug),
  });
}

async function renameGroup(request, env, nowMs) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group, person } = auth;
  const body = await request.json().catch(() => null);
  const name = cleanName(body && body.name, 40);
  if (!name) return fail(400, 'BAD_NAME');
  await commit(env, group.slug, [
    env.DB.prepare('UPDATE groups SET name = ?2 WHERE slug = ?1').bind(group.slug, name),
  ], body.opId, person.id, nowMs, { ok: true });
  return json({ ok: true, name, version: await readVersion(env.DB, group.slug) });
}

// ----------------------------------------------------------------- plans -----

async function createPlan(request, env, nowMs) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group, person } = auth;
  const body = await request.json().catch(() => null);
  if (!body || !isValid(body.day) || !validSlot(body.slot)) return fail(400, 'BAD_REQUEST');
  // A slot the day does not have. A Tuesday has no morning, so buildState would
  // never render this plan and it would sit in the database invisible.
  if (!slotsFor(body.day).includes(body.slot)) return fail(400, 'BAD_SLOT');
  const title = cleanName(body.title, 60);
  if (!title) return fail(400, 'BAD_TITLE', 'Give it a name so people know what it is.');
  const replay = await seenOp(env.DB, body.opId);
  if (replay) return json(replay);

  const id = planId();
  const note = body.note ? cleanName(body.note, 140) : null;
  const response = {
    ok: true,
    plan: { id, day: body.day, slot: body.slot, title, note, createdBy: person.id },
  };
  // The opId is recorded AFTER the response is complete, exactly as mark() and
  // bulk() do it. Recording it in this batch would cache a body with no
  // version, no ack and no share - so a replay, and every offline drain is one,
  // would create the plan, announce nothing, and report no error.
  await commit(env, group.slug, [
    env.DB.prepare(
      'INSERT INTO plans (id, group_slug, day, slot, title, note, created_by, created_at, updated_at) '
      + 'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)',
    ).bind(id, group.slug, body.day, body.slot, title, note, person.id, nowMs),
    // Drop the cached digest in the SAME batch as the insert and the version
    // bump (one atomic write). Otherwise the stored snapshot survives for
    // NUDGE_TTL_MS - seven days - and the text built for the group chat never
    // mentions the plan that was just agreed.
    env.DB.prepare('DELETE FROM notes WHERE k = ?1').bind(nudgeNoteKey(group.slug)),
  ], null, person.id, nowMs, null);
  response.version = await readVersion(env.DB, group.slug);

  // The pasteable line. A one-day window is all planAnnounce reads, so this
  // costs one small read rather than a whole horizon.
  const today = isValid(body.today) ? body.today : body.day;
  const fresh = await buildState(env, group, person.id, body.day, body.day, today, nowMs);
  // `ack` is what every other mutation returns and what the home screen says.
  // `share` is the identical string, named for what the client does with it:
  // straight into the clipboard, then into the group chat.
  response.ack = planAnnounce(fresh, fresh.members, response.plan, originOf(request), group.slug);
  response.share = response.ack;
  if (body.opId) {
    await env.DB.batch([recordOpStatement(env.DB, body.opId, person.id, nowMs, response)]);
  }
  return json(response);
}

async function editPlan(request, env, nowMs, id, remove) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group, person } = auth;
  const body = await request.json().catch(() => ({}));
  const existing = await env.DB.prepare(
    'SELECT id, day, slot, title, note, deleted_at FROM plans WHERE id = ?1 AND group_slug = ?2',
  ).bind(id, group.slug).first();
  if (!existing) return fail(404, 'NO_PLAN');

  if (remove) {
    // Soft delete, and hand back the previous row so the undo snackbar can put
    // it straight back.
    await commit(env, group.slug, [
      env.DB.prepare('UPDATE plans SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1').bind(id, nowMs),
    ], body.opId, person.id, nowMs, { ok: true });
    return json({
      ok: true,
      deleted: id,
      previous: {
        day: existing.day, slot: existing.slot, title: existing.title, note: existing.note,
      },
      version: await readVersion(env.DB, group.slug),
    });
  }

  const title = body.title !== undefined ? cleanName(body.title, 60) : existing.title;
  if (!title) return fail(400, 'BAD_TITLE');
  const note = body.note !== undefined ? (body.note ? cleanName(body.note, 140) : null) : existing.note;
  const day = isValid(body.day) ? body.day : existing.day;
  const slot = validSlot(body.slot) ? body.slot : existing.slot;
  await commit(env, group.slug, [
    env.DB.prepare(
      'UPDATE plans SET title = ?2, note = ?3, day = ?4, slot = ?5, updated_at = ?6, deleted_at = NULL WHERE id = ?1',
    ).bind(id, title, note, day, slot, nowMs),
  ], body.opId, person.id, nowMs, { ok: true });
  return json({
    ok: true,
    plan: { id, day, slot, title, note },
    version: await readVersion(env.DB, group.slug),
  });
}

// ---------------------------------------------------------------- nudges -----

async function nudge(request, env, nowMs, targetId) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group } = auth;
  const target = await env.DB.prepare(
    'SELECT id, name FROM people WHERE id = ?1 AND group_slug = ?2 AND active = 1',
  ).bind(targetId, group.slug).first();
  if (!target) return fail(404, 'NO_PERSON');

  const today = new URL(request.url).searchParams.get('today');
  if (!isValid(today)) return fail(400, 'BAD_TODAY');
  const { from, to } = windowFor(today);
  const view = await buildState(env, group, targetId, from, to, today, nowMs);
  const token = await nudgeToken(group.slug, targetId, env.SESSION_SECRET, nowMs);
  const url = `${originOf(request)}/c/${token}`;

  // No OG tags, not indexable, no referrer. This link is a STRONGER capability
  // than the group link - it bypasses that person's PIN - so it is generated
  // per-person for a nudge and never rendered into a page.
  return json({
    to: target.name,
    text: personalNudge(view, view.members, targetId, url),
    url,
    expiresAt: nowMs + CONFIG.TOKEN_MAX_AGE_S * 1000,
    warning: 'Send this to one person only. Never paste it into the group chat - anyone holding it can act as them.',
  }, {
    headers: { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function removePerson(request, env, nowMs, targetId) {
  const auth = await authenticate(request, env, nowMs);
  if (auth.error) return auth.error;
  const { group, person } = auth;
  const body = await request.json().catch(() => ({}));
  // Soft delete only. Their marks stay so history is intact; they vanish from
  // rosters and tallies. There is no hard delete anywhere in this app.
  await commit(env, group.slug, [
    env.DB.prepare('UPDATE people SET active = 0 WHERE id = ?1 AND group_slug = ?2')
      .bind(targetId, group.slug),
  ], body.opId, person.id, nowMs, { ok: true });
  return json({ ok: true, removed: targetId, version: await readVersion(env.DB, group.slug) });
}

// ---------------------------------------------------------------- router -----

export async function handleApi(request, env, ctx, nowMs, path) {
  const method = request.method;

  if (path === '/api/health') return health(request, env, nowMs);
  if (path === '/api/join' && method === 'POST') return join(request, env, nowMs);
  if (path === '/api/person' && method === 'POST') return addPerson(request, env, nowMs);
  if (path === '/api/state' && method === 'GET') return state(request, env, ctx, nowMs);
  if (path === '/api/mark' && method === 'POST') return mark(request, env, nowMs);
  if (path === '/api/marks/bulk' && method === 'POST') return bulk(request, env, nowMs);
  if (path === '/api/pattern' && method === 'POST') return pattern(request, env, nowMs);
  if (path === '/api/confirm' && method === 'POST') return confirm(request, env, nowMs);
  if (path === '/api/quorum' && method === 'POST') return quorum(request, env, nowMs);
  if (path === '/api/group' && method === 'POST') return renameGroup(request, env, nowMs);
  if (path === '/api/plan' && method === 'POST') return createPlan(request, env, nowMs);

  const planMatch = /^\/api\/plan\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (planMatch && (method === 'PATCH' || method === 'DELETE')) {
    return editPlan(request, env, nowMs, planMatch[1], method === 'DELETE');
  }
  const nudgeMatch = /^\/api\/nudge\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (nudgeMatch && method === 'GET') return nudge(request, env, nowMs, nudgeMatch[1]);

  const personMatch = /^\/api\/person\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (personMatch && method === 'DELETE') return removePerson(request, env, nowMs, personMatch[1]);

  return fail(404, 'NO_ROUTE', `No such endpoint: ${method} ${path}`);
}
