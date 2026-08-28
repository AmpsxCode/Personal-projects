// Every tunable number and every user-facing string in one place.
// Slot -> wall-clock is presentation, not data: changing it is a copy change,
// never a migration.

export const CONFIG = {
  HORIZON_WEEKS: 6,
  CONFIRM_DAYS: 14,
  STALE_AFTER_DAYS: 14,
  STALE_HORIZON_DAYS: 7,
  ROSTER_CAP: 12,
  DEFAULT_QUORUM: 4,
  COVERAGE_TARGET_DAYS: 21,
  // The brief says 30s, and the measured cadence is exactly 30.0s - but the
  // acceptance bar is "within 35 seconds", so a write landing just after a poll
  // uses 30 of the 35 before anything has gone wrong. One slow request or one
  // deferred timer and it misses. 25s leaves 10s of real margin and takes the
  // request budget from ~11.5% to ~14% of the Workers free daily allowance
  // (12 people x 2.4 polls/min x 8h = 13,824 of 100,000), which is still
  // comfortable - and most of those are 304s reading one indexed row.
  POLL_MS: 25000,
  // MEASURED, not guessed. The Workers free plan gives a hard 10ms of CPU per
  // invocation. On workerd this primitive costs roughly:
  //     1,000 -> 1.9ms   5,000 -> 3.6ms   10,000 -> 5.8ms
  //    20,000 -> 10.0ms  50,000 -> 25.7ms  100,000 -> 48.5ms
  // The brief suggested starting at 10,000, which is right about 100,000 being
  // hopeless but still spends ~58% of the whole budget on one hash - and it is
  // spent on /api/join, the very first screen a new person touches, where an
  // intermittent "Exceeded CPU limit" is the least diagnosable failure in the
  // app. 6,000 lands near 4ms and leaves real headroom.
  //
  // This costs almost nothing in security, because the KDF was never the
  // control here: a 4-digit PIN is a 10,000-value keyspace and no iteration
  // count survives someone who can make 10,000 requests. The pin_attempts
  // lockout is the control.
  PBKDF2_ITERATIONS: 6000,

  // Ring on the avatar row fills at this much confirmed coverage.
  // A fortnight of coverage means today THROUGH today+13 inclusive — which is
  // what CONFIRM_DAYS: 14 writes, and which leaves confirmedThrough at
  // today+13. Requiring 14 meant a flawless confirm still left your own chip
  // hollow, so the one person who had done exactly what the app asked was told
  // they hadn't.
  RING_FILLED_DAYS: 13,
  // Rows per band before the "show all" expander.
  BAND_CAP: 5,
  // How many chips in the quick-change strip.
  QUICK_CHANGE_SLOTS: 3,

  SESSION_MAX_AGE_S: 7776000,   // 90 days. Cookie lifetime.
  TOKEN_MAX_AGE_S: 604800,      // 7 days. The /c/ nudge token.
  PIN_MAX_FAILS: 5,
  PIN_LOCK_MS: 900000,          // 15 minutes
  OP_TTL_MS: 3600000,           // opId replay window: 1 hour
  NUDGE_TTL_MS: 604800000,      // regenerate the weekly nudge after 7 days
};

export const HORIZON_DAYS = CONFIG.HORIZON_WEEKS * 7;

// Wall-clock windows, UK local time. Presentation only - never stored, never
// compared against an instant, never sent to the server.
export const SLOT_WINDOWS = {
  MORNING: { from: '09:00', to: '13:00', label: 'morning' },
  AFTERNOON: { from: '13:00', to: '18:00', label: 'afternoon' },
  EVENING: { from: '18:00', to: '23:00', label: 'evening' },
};

export const COPY = {
  NOT_ANSWERED: 'Not answered',       // the ONE string for the unknown state
  MAYBE_HELP: 'could work if it is happening',
  CLEAR_HELP: "removes your answer - you'll show as 'not answered'",
  ASSUMED_HELP: 'assumed from your typical week',
  SETUP_FOOTER: "We'll assume this going forward - you can confirm or change any day.",
  NO_SESSION: 'Open your invite link',
  NO_SESSION_BODY: 'This app works from the link in your group chat. Ask whoever set it up to send it again.',
  PIN_LOCKED: 'Too many tries, try again in 15 minutes.',
  PIN_OFFER: 'Set a 4+ digit PIN so nobody edits your row by accident (optional - skip it)',
  ROSTER_FULL: 'The group is full at 12 people.',
};
