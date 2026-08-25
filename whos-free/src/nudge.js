// Nudges. Sparing, personal, and specific about the stakes.

import { formatShort, ordinalDay } from '../public/shared/plainday.js';
import { buildBands, slotLabel } from '../public/shared/tally.js';
import { CONFIG } from './config.js';

/**
 * A per-person nudge.
 *
 *   "Sat 10th has 5 of 7 - you're the one we're missing. One tap: <link>"
 *
 * Always specific about what is riding on it. A nudge that does not say what is
 * at stake gets ignored. This is sent BY Ammar, to one person, in whatever chat
 * they already use - the app never messages anyone directly.
 */
export function personalNudge(state, roster, personId, url) {
  const { bands, maybeDependent, closest } = buildBands(
    state.days, roster, state.group.quorum, state.from, state.to, CONFIG.BAND_CAP,
  );

  // Bands first, then maybe-dependent slots, then the closest options. The
  // third source matters: early on, before anything reaches quorum, there are
  // no bands at all - and that is exactly when a nudge is most useful. Without
  // it the message degrades to "your row is empty", which says nothing about
  // what is riding on the reply and gets ignored.
  const candidates = [];
  for (const band of bands) candidates.push(...band.allRows);
  candidates.push(...maybeDependent, ...closest);

  // The best slot this person has not answered - that is the one with something
  // actually riding on their reply.
  for (const row of candidates) {
    if (row.t.by.notAnswered.includes(personId)) {
      const others = row.t.by.notAnswered.length - 1;
      const who = others === 0
        ? "you're the one we're missing"
        : `you're one of ${others + 1} we're missing`;
      return `${formatShort(row.day)} ${slotLabel(row.slot)} has ${row.free} of ${roster.length} - ${who}. One tap: ${url}`;
    }
  }
  return `We're planning the next few weeks and your row is empty. One tap and you're done: ${url}`;
}

/**
 * The weekly text for the group chat.
 *
 * DELIBERATELY NAMES NOBODY. The app's band rows name who is missing because
 * that is the person reading it deciding whether to send one message. A
 * broadcast into the group chat is different: publicly listing the people who
 * have not replied punishes everyone in the room and trains them to mute. So
 * this says what the options are and what would unlock them, and nothing about
 * who is silent.
 */
export function weeklyDigest(state, roster, origin, slug) {
  const { bands, maybeDependent, closest } = buildBands(
    state.days, roster, state.group.quorum, state.from, state.to, 3,
  );
  const lines = [`${state.group.name} - the next few weeks:`];

  if (bands.length) {
    for (const band of bands.slice(0, 2)) {
      for (const row of band.rows.slice(0, 2)) {
        lines.push(`- ${formatShort(row.day)} ${slotLabel(row.slot)}: ${row.free} of ${roster.length} free`);
      }
    }
  }
  if (maybeDependent.length) {
    const row = maybeDependent[0];
    lines.push(`- ${formatShort(row.day)} ${slotLabel(row.slot)} works if the maybes are in (${row.free} free + ${row.maybe} maybe)`);
  }
  if (!bands.length && !maybeDependent.length && closest.length) {
    const row = closest[0];
    lines.push(`- Closest so far: ${formatShort(row.day)} ${slotLabel(row.slot)}, ${row.free} of ${roster.length}`);
  }
  if (lines.length === 1) lines.push('- Nobody has filled anything in yet.');

  lines.push(`Update yours: ${origin}/g/${slug}`);
  return lines.join('\n');
}

export function nudgeNoteKey(slug) { return `nudge:${slug}`; }
