// The two paths that must render server-side: the invite link (because WhatsApp
// does not run JavaScript to build a preview) and the nudge token exchange
// (because it sets a cookie).

import { CONFIG, COPY } from './config.js';
import { loadGroup } from './bootstrap.js';

import { addDays, format, parse } from '../public/shared/plainday.js';
import { esc, html, originOf } from './util.js';
import { sessionCookie, verifyNudgeToken } from './session.js';

const OG_IMAGE = '/og/whos-free-v1.png';

/**
 * How many people are filled in for the next fortnight. Goes in the unfurl card
 * so the link carries a reason to tap it.
 *
 * This is a rough count against the CONFIRM window, and it deliberately does
 * not name anybody: a link preview lands in the group chat, and naming the
 * people who have not replied is the public shaming that makes everyone mute
 * the thread.
 */
async function fillStatus(env, group, todayGuess) {
  const people = await env.DB.prepare(
    'SELECT count(*) AS n FROM people WHERE group_slug = ?1 AND active = 1',
  ).bind(group.slug).first();
  const total = people ? people.n : 0;
  if (!total) return { total: 0, filled: 0, line: 'Nobody has joined yet' };

  const to = format(addDays(parse(todayGuess), CONFIG.CONFIRM_DAYS - 1));
  const rows = await env.DB.prepare(
    'SELECT person_id, count(*) AS n FROM marks WHERE group_slug = ?1 AND day >= ?2 AND day <= ?3 '
    + "AND source = 'EXPLICIT' GROUP BY person_id",
  ).bind(group.slug, todayGuess, to).all();
  const filled = (rows.results || []).filter((r) => r.n > 0).length;
  return {
    total,
    filled,
    line: `${filled} of ${total} have filled in the next 2 weeks`,
  };
}

/**
 * GET /g/:slug - the join screen.
 *
 * ALWAYS 200 HTML with server-rendered Open Graph tags. Never a redirect on the
 * GET: WhatsApp and iMessage do not follow redirects to build a preview, and
 * they do not run JavaScript, so a client-rendered card is a blank card. The
 * cookie is set and the redirect happens on the POST, when a name is picked.
 */
export async function joinPage(request, env, slug, nowMs) {
  const group = await loadGroup(env);
  const origin = originOf(request);
  if (!group || group.slug !== slug) {
    return html(shell({
      title: 'Link not found',
      origin,
      og: { title: "Who's Free", description: 'This invite link is not valid any more.', image: origin + OG_IMAGE },
      body: `<main class="pad"><h1>That link isn't valid</h1><p>Ask whoever set this up for a fresh one.</p></main>`,
    }), { status: 404 });
  }

  const people = await env.DB.prepare(
    'SELECT id, name, colour_seed, pin_hash FROM people WHERE group_slug = ?1 AND active = 1 ORDER BY created_at',
  ).bind(group.slug).all();
  const roster = people.results || [];

  // A plain UTC day, used only as a default window boundary for the unfurl
  // count. The live app always sends its own `today`; this page has no client
  // to ask, and being a few hours out on a preview line does not matter.
  const utcToday = new Date(nowMs).toISOString().slice(0, 10);
  const status = await fillStatus(env, group, utcToday);

  const buttons = roster.map((p) => `
      <button type="button" class="who" data-id="${esc(p.id)}" data-pin="${p.pin_hash ? '1' : '0'}"
              style="--seed:${Number(p.colour_seed) || 0}">
        <span class="who-dot" aria-hidden="true"></span>
        <span class="who-name">${esc(p.name)}</span>
        ${p.pin_hash ? '<span class="who-lock" aria-label="has a PIN">PIN</span>' : ''}
      </button>`).join('');

  const body = `
    <main class="pad join" data-slug="${esc(group.slug)}" data-cap="${CONFIG.ROSTER_CAP}">
      <h1>${esc(group.name)}</h1>
      <p class="lede">Say which evenings and weekends you're free. Nobody sees <em>what</em> you're doing &mdash; just free, maybe or busy.</p>
      ${roster.length ? `<p class="status">${esc(status.line)}</p>` : ''}

      ${roster.length ? `
        <h2 class="h-sm">Which one are you?</h2>
        <div class="who-grid">${buttons}</div>` : `
        <h2 class="h-sm">Nobody's here yet &mdash; you're first</h2>
        <p class="hint">Add your name below. Everyone else does the same when they open this link.</p>`}

      <form class="add-person" novalidate>
        <label for="newName">${roster.length ? 'Not on the list?' : 'What should we call you?'}</label>
        <div class="row">
          <input id="newName" name="name" type="text" inputmode="text" autocomplete="off"
                 maxlength="24" placeholder="Your name">
          <button type="submit" class="btn">${roster.length ? '+ Add someone' : 'Add me'}</button>
        </div>
        <p class="hint" id="addHint" role="status" aria-live="polite">${
  roster.length >= CONFIG.ROSTER_CAP ? esc(COPY.ROSTER_FULL) : ''}</p>
      </form>

      <dialog id="pinDialog">
        <form method="dialog" id="pinForm">
          <h2 class="h-sm" id="pinTitle">Enter your PIN</h2>
          <p class="hint" id="pinHint">${esc(COPY.PIN_OFFER)}</p>
          <input id="pinInput" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="12"
                 autocomplete="off" aria-describedby="pinHint">
          <p class="hint err" id="pinError" role="alert"></p>
          <div class="row end">
            <button type="button" class="btn ghost" id="pinSkip">Skip</button>
            <button type="button" class="btn primary" id="pinGo">That's me</button>
          </div>
        </form>
      </dialog>
    </main>`;

  return html(shell({
    title: `${group.name} - Who's Free`,
    origin,
    og: {
      title: `${group.name} on Who's Free`,
      description: `${status.line}. Tap to say when you're free.`,
      image: origin + OG_IMAGE,
      url: `${origin}/g/${group.slug}`,
    },
    body,
    script: 'join',
  }));
}

/**
 * GET /c/:token - the nudge deep link.
 *
 * Sets the cookie and redirects to a clean /confirm, so the token never sits in
 * the address bar or in history. A redirect is fine here precisely because
 * there is no preview to build: this URL is never pasted into a group chat.
 */
export async function tokenExchange(request, env, token, nowMs) {
  const payload = await verifyNudgeToken(token, env.SESSION_SECRET, nowMs);
  const origin = originOf(request);
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  if (!payload) {
    return html(shell({
      title: 'Link expired',
      origin,
      body: `<main class="pad"><h1>That link has expired</h1><p>Nudge links last a week. Open the app from your group chat instead.</p></main>`,
    }), { status: 410, headers });
  }
  const group = await loadGroup(env);
  if (!group || group.slug !== payload.g) {
    return html(shell({ title: 'Link expired', origin, body: `<main class="pad"><h1>That link is no longer valid</h1></main>` }),
      { status: 410, headers });
  }
  headers.set('Location', '/confirm');
  headers.append('Set-Cookie', await sessionCookie(group.slug, payload.u, env.SESSION_SECRET, nowMs));
  return new Response(null, { status: 302, headers });
}

/** The one HTML skeleton. No third-party anything, ever. */
export function shell({ title, origin, og, body, script }) {
  const tags = og ? `
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Who's Free">
    <meta property="og:title" content="${esc(og.title)}">
    <meta property="og:description" content="${esc(og.description)}">
    <meta property="og:image" content="${esc(og.image)}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    ${og.url ? `<meta property="og:url" content="${esc(og.url)}">` : ''}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="description" content="${esc(og.description)}">` : '';
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/app.css">
<meta name="theme-color" content="#1d2433" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7f8fb" media="(prefers-color-scheme: light)">
${tags}
</head>
<body>
${body}
${script ? `<script type="module" src="/${script}.js"></script>` : ''}
</body>
</html>`;
}
