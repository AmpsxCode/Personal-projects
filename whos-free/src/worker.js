// Who's Free - a busy/free calendar for one friend group.
//
// The ONLY correct Worker shape. addEventListener('fetch', ...) is the legacy
// service-worker syntax and cannot use a D1 binding at all.

import { ensureBooted, loadGroup } from './bootstrap.js';
import { handleApi } from './api.js';
import { joinPage, shell, tokenExchange } from './pages.js';
import { nudgeNoteKey, weeklyDigest } from './nudge.js';
import { buildState, windowFor } from './read.js';
import { html, originOf, randomId } from './util.js';
import { addDays, format } from '../public/shared/plainday.js';

let loggedInvite = false;

/**
 * The HMAC signing key for sessions and nudge tokens.
 *
 * A dashboard secret called SESSION_SECRET wins if one exists. If it does not,
 * the Worker generates 32 random bytes on first boot and keeps them in the
 * database.
 *
 * Why: a dashboard secret has to be added by hand, and if it is added in the
 * wrong order relative to a deploy the running version comes up without it -
 * at which point every request 503s and there is no obvious cause. A key the
 * app owns cannot be missing, cannot be forgotten, and cannot be wiped by a
 * deploy.
 *
 * The trade: the key sits in D1 rather than in the secret store, so anyone with
 * dashboard access to this account can read it. For a busy/free calendar among
 * friends that is the same practical trust boundary - and the worst case if it
 * leaks is that someone who ALSO has the group link can act as another person.
 * Rotating it is deleting one row, which logs everyone out.
 */
async function signingKey(env, nowMs) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;

  const existing = await env.DB.prepare('SELECT v FROM notes WHERE k = ?1')
    .bind('signing_key').first();
  if (existing && existing.v) return existing.v;

  // ON CONFLICT DO NOTHING then re-read, so two simultaneous first requests
  // cannot end up trusting different keys.
  const fresh = randomId(32);
  await env.DB.prepare(
    'INSERT INTO notes (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO NOTHING',
  ).bind('signing_key', fresh, nowMs).run();
  const settled = await env.DB.prepare('SELECT v FROM notes WHERE k = ?1')
    .bind('signing_key').first();
  return settled ? settled.v : fresh;
}

async function logInviteOnce(env, origin) {
  if (loggedInvite) return;
  const group = await loadGroup(env);
  if (group) {
    // Printed to the dashboard logs so the invite URL stays findable forever,
    // even after /api/health stops returning it.
    console.log(`[whos-free] invite URL: ${origin}/g/${group.slug}`);
    loggedInvite = true;
  }
}

export default {
  async fetch(request, env, ctx) {
    // Date.now() is the only genuine clock in the app. In this runtime it
    // returns the time of the last I/O and does not advance during synchronous
    // execution, so it is a timestamp source and never a monotonic tick.
    const nowMs = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      await ensureBooted(env, nowMs);
      // Must come after boot: it reads a table boot creates.
      env.SESSION_SECRET = await signingKey(env, nowMs);
      ctx.waitUntil(logInviteOnce(env, originOf(request)));

      if (path.startsWith('/api/')) return handleApi(request, env, ctx, nowMs, path);

      const invite = /^\/g\/([A-Za-z0-9_-]{6,64})\/?$/.exec(path);
      if (invite) return joinPage(request, env, invite[1], nowMs);

      const token = /^\/c\/([A-Za-z0-9_.\-]{16,600})\/?$/.exec(path);
      if (token) return tokenExchange(request, env, token[1], nowMs);

      // Everything else in run_worker_first that we do not recognise falls
      // through to the static asset layer.
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('[whos-free] unhandled', err && err.stack ? err.stack : String(err));
      if (path.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'SERVER_ERROR', message: String(err && err.message) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
        });
      }
      return html(shell({
        title: 'Something broke',
        body: `<main class="pad"><h1>Something broke</h1><p>Reload. If it keeps happening, the details are in the Cloudflare dashboard under your Worker &rsaquo; Logs.</p></main>`,
      }), { status: 500 });
    }
  },

  /**
   * Cron Triggers are UTC only. "0 17 * * SUN" is 18:00 London in summer and
   * 17:00 in winter, which is fine for a weekly nudge.
   *
   * This writes a snapshot of the digest so the banner wording stays stable all
   * week. If it never runs, /api/state computes the same text live, so cutting
   * the cron costs nothing but stability - it is not load-bearing.
   */
  async scheduled(controller, env, ctx) {
    const nowMs = Date.now();
    await ensureBooted(env, nowMs);
    env.SESSION_SECRET = await signingKey(env, nowMs);
    const group = await loadGroup(env);
    if (!group) return;

    // The runtime is always UTC and there is no client here to ask, so the
    // scheduled window uses a UTC day boundary. Being an hour either side of
    // midnight does not change which weekend is coming up.
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const { from, to } = windowFor(today);
    const state = await buildState(env, group, null, from, to, today, nowMs);
    const origin = env.PUBLIC_ORIGIN || `https://${env.WORKER_HOST || 'whos-free.workers.dev'}`;
    const text = weeklyDigest(state, state.members, origin, group.slug);

    ctx.waitUntil(env.DB.prepare(
      'INSERT INTO notes (k, v, updated_at) VALUES (?1, ?2, ?3) '
      + 'ON CONFLICT(k) DO UPDATE SET v = ?2, updated_at = ?3',
    ).bind(nudgeNoteKey(group.slug), text, nowMs).run());
  },
};
