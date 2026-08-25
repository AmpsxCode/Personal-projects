// plainday.js - plain calendar dates as {y, m, d} tuples.
//
// A "day" is a calendar date. It is NOT an instant. "Saturday afternoon" has no
// single real instant, so storing one forces you to invent a time, and then
// toISOString() shifts the date by a day for every UK user for ~7 months a year
// because BST is UTC+1.
//
// THERE IS NO `Date` IN THIS FILE. Not new Date(y,m-1,d), not Date.UTC, not
// getDay, not getDate, not toISOString. Weekday is derived arithmetically from
// the epoch day count, which cannot be shifted by a host timezone because no
// timezone is ever consulted. test/plainday.test.js cross-checks every weekday
// in a 12-year range against `new Date(Date.UTC(...)).getUTCDay()` as an oracle,
// so the arithmetic is proven equivalent to the one Date call the spec allows -
// without shipping it.
//
// The single genuine instant in this project is marks.updated_at (epoch ms,
// stamped by the server). It is handled in src/, never here.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
  if (m < 1 || m > 12) throw new RangeError(`month out of range: ${m}`);
  return m === 2 && isLeap(y) ? 29 : MONTH_LENGTHS[m - 1];
}

/** Parse 'YYYY-MM-DD' into {y,m,d}. Throws on anything else. */
export function parse(s) {
  if (typeof s !== 'string') throw new TypeError(`not a plain day: ${JSON.stringify(s)}`);
  const match = DAY_RE.exec(s);
  if (!match) throw new TypeError(`not a plain day: ${JSON.stringify(s)}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) throw new RangeError(`month out of range in ${s}`);
  if (d < 1 || d > daysInMonth(y, m)) throw new RangeError(`day out of range in ${s}`);
  return { y, m, d };
}

/** True if s is a well-formed, real calendar date. Never throws. */
export function isValid(s) {
  try { parse(s); return true; } catch { return false; }
}

const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const pad4 = (n) => `${n}`.padStart(4, '0');

/** Format {y,m,d} as 'YYYY-MM-DD'. */
export function format({ y, m, d }) {
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
}

/** -1, 0 or 1. Accepts tuples or strings. */
export function compare(a, b) {
  const x = typeof a === 'string' ? a : format(a);
  const z = typeof b === 'string' ? b : format(b);
  return x < z ? -1 : x > z ? 1 : 0;
}

// Howard Hinnant's days_from_civil / civil_from_days. Exact for all years,
// integer arithmetic only, no calendar library and no Date.
export function toEpochDay({ y, m, d }) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;                                        // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromEpochDay(z) {
  const zz = z + 719468;
  const era = Math.floor((zz >= 0 ? zz : zz - 146096) / 146097);
  const doe = zz - era * 146097;                                     // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
    - Math.floor(doe / 146096)) / 365);                               // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);                         // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;                 // [1, 31]
  const m = mp + (mp < 10 ? 3 : -9);                                  // [1, 12]
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/** n whole calendar days later (n may be negative). */
export function addDays(day, n) {
  return fromEpochDay(toEpochDay(day) + n);
}

/** Whole days from a to b. Positive if b is later. */
export function diffDays(a, b) {
  return toEpochDay(b) - toEpochDay(a);
}

/** n calendar months later, clamped to the end of the target month. */
export function addMonths({ y, m, d }, n) {
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return { y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) };
}

/**
 * 0 = Monday .. 6 = Sunday.
 * Epoch day 0 is 1970-01-01, a Thursday, which is index 3 in a Monday-first
 * week. The +3 offset carries that, and the double modulo keeps it correct for
 * negative epoch days (dates before 1970).
 */
export function mondayIndex(day) {
  const e = toEpochDay(day);
  return ((e + 3) % 7 + 7) % 7;
}

export function weekdayName(day, long = false) {
  return (long ? WEEKDAYS_LONG : WEEKDAYS_SHORT)[mondayIndex(day)];
}

export function isWeekend(day) {
  return mondayIndex(day) >= 5;
}

export function startOfMonth({ y, m }) {
  return { y, m, d: 1 };
}

export function endOfMonth({ y, m }) {
  return { y, m, d: daysInMonth(y, m) };
}

/** The Monday of the week containing day. */
export function startOfWeek(day) {
  return addDays(day, -mondayIndex(day));
}

/** Inclusive list of 'YYYY-MM-DD' strings. */
export function range(fromDay, toDay) {
  const start = typeof fromDay === 'string' ? parse(fromDay) : fromDay;
  const end = typeof toDay === 'string' ? parse(toDay) : toDay;
  const out = [];
  for (let e = toEpochDay(start), last = toEpochDay(end); e <= last; e += 1) {
    out.push(format(fromEpochDay(e)));
  }
  return out;
}

// ---- Presentation. en-GB, Monday first, no Intl and no locale lookups, so a
// friend whose phone is set to US English still sees "Sat 10 Oct". ------------

/** 'Sat 10 Oct' */
export function formatShort(day) {
  const t = typeof day === 'string' ? parse(day) : day;
  return `${weekdayName(t)} ${t.d} ${MONTHS_SHORT[t.m - 1]}`;
}

/** 'Sat 10 October' */
export function formatMedium(day) {
  const t = typeof day === 'string' ? parse(day) : day;
  return `${weekdayName(t)} ${t.d} ${MONTHS_LONG[t.m - 1]}`;
}

/** 'Saturday 10 October 2026' - for accessible names */
export function formatLong(day) {
  const t = typeof day === 'string' ? parse(day) : day;
  return `${weekdayName(t, true)} ${t.d} ${MONTHS_LONG[t.m - 1]} ${t.y}`;
}

/** '10th' */
export function ordinalDay(day) {
  const t = typeof day === 'string' ? parse(day) : day;
  const n = t.d;
  const suffix = (n % 100 >= 11 && n % 100 <= 13) ? 'th'
    : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** 'October 2026' */
export function formatMonth({ y, m }) {
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

/**
 * The 6x7 grid of day strings covering a month, Monday first, padded with the
 * neighbouring months' days so every grid is exactly 42 cells.
 */
export function monthGrid({ y, m }) {
  const first = startOfMonth({ y, m });
  const gridStart = addDays(first, -mondayIndex(first));
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const day = addDays(gridStart, i);
    cells.push({ key: format(day), day, inMonth: day.y === y && day.m === m });
  }
  return cells;
}

/** 'updated 3 days ago'. Both arguments are epoch ms; no calendar involved. */
export function relativeAge(thenMs, nowMs) {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 90) return 'just now';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return days === 1 ? 'yesterday' : `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  return months <= 1 ? '1 month ago' : `${months} months ago`;
}
