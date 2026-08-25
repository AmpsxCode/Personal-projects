// Acknowledge every single contribution, specifically.
//
//   "Thanks - that's 5 of 7 filled in for October, and Sat 10th just became
//    the best day."
//
// Three things in one sentence: gratitude, where they stand relative to the
// group, and what their answer actually changed. Generic confirmations ("Saved!")
// do nothing. This is the cheapest retention mechanism in the app, which is
// exactly why it is easy to leave out, so it is a requirement rather than a
// nicety.

import { MONTHS_LONG, compare, ordinalDay, parse, weekdayName } from '../public/shared/plainday.js';
import { enumerateSlots, slotsFor, tally } from '../public/shared/tally.js';

/** How many people have said anything explicit and current about this month. */
function filledForMonth(state, month, year) {
  const filled = new Set();
  for (const [day, slots] of Object.entries(state.days)) {
    const t = parse(day);
    if (t.m !== month || t.y !== year) continue;
    for (const slot of slotsFor(day)) {
      const entries = slots[slot] || {};
      for (const [id, e] of Object.entries(entries)) {
        if (e.src === 'EXPLICIT' && !e.stale) filled.add(id);
      }
    }
  }
  return filled.size;
}

/** Highest definite-free count, earliest day wins ties. */
function bestSlot(days, roster, from, to) {
  let best = null;
  for (const { day, slot } of enumerateSlots(from, to)) {
    const entries = (days[day] && days[day][slot]) || {};
    const t = tally(entries, roster);
    if (!best || t.free > best.free || (t.free === best.free && compare(day, best.day) < 0)) {
      best = { day, slot, free: t.free };
    }
  }
  return best && best.free > 0 ? best : null;
}

/**
 * Build the acknowledgement.
 *
 * `reverts` is [{ day, slot, personId, previous }] - what the state looked like
 * before this write. We apply it in memory to reconstruct "before" rather than
 * reading the whole grid twice, so this costs no extra database round trips.
 */
export function buildAck(state, roster, writtenDay, reverts) {
  const parts = [];
  const target = parse(writtenDay || state.today);
  const filled = filledForMonth(state, target.m, target.y);
  const total = roster.length;
  parts.push(`Thanks - that's ${filled} of ${total} filled in for ${MONTHS_LONG[target.m - 1]}`);

  const after = bestSlot(state.days, roster, state.from, state.to);

  // Reconstruct the pre-write grid in memory.
  const before = structuredClone(state.days);
  for (const r of (reverts || [])) {
    if (!before[r.day] || !before[r.day][r.slot]) continue;
    if (r.previous == null) delete before[r.day][r.slot][r.personId];
    else before[r.day][r.slot][r.personId] = { s: r.previous, src: 'EXPLICIT', stale: false };
  }
  const wasBest = bestSlot(before, roster, state.from, state.to);

  if (after) {
    const moved = !wasBest || wasBest.day !== after.day || wasBest.slot !== after.slot;
    const grew = wasBest && wasBest.day === after.day && wasBest.slot === after.slot
      && after.free > wasBest.free;
    const named = `${weekdayName(parse(after.day))} ${ordinalDay(after.day)}`;
    if (moved) parts.push(`and ${named} just became the best day`);
    else if (grew) parts.push(`and ${named} is now ${after.free} of ${total}`);
  }
  return `${parts.join(', ')}.`;
}
