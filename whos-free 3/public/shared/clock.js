// The ONE place in the client that consults a real clock.
//
// Everything else in the app works on plain 'YYYY-MM-DD' strings, and the
// server never derives a date at all - the Workers runtime is always UTC, so it
// cannot know what day it is where the reader is standing. So the client tells
// it, once per read, as an opaque window boundary.
//
// Pinned to Europe/London rather than the device timezone on purpose: this is a
// London friend group, and a friend on holiday in Auckland should see the same
// grid as everyone else rather than a calendar shifted by a day. Intl with an
// explicit timeZone is the only way to get a wall-clock date without local Date
// arithmetic, which is why this is the single carve-out from the no-Date rule.

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today in London, as 'YYYY-MM-DD'. */
export function today() {
  const parts = {};
  for (const p of FMT.formatToParts(new Date())) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Epoch ms. Used only for relative-age strings, never for date identity. */
export function nowMs() {
  return Date.now();
}
