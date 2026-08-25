// One complete statement per string, with NO internal newlines.
//
// This is not a style choice. env.DB.exec() splits its input on \n and treats
// each line as a statement, so a pretty-printed multi-line CREATE TABLE fails
// with a syntax error on the very first request. We use batch() instead, which
// is atomic and one round trip, and keeping each statement on one line means
// either method would work.

export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS groups (slug TEXT PRIMARY KEY, name TEXT NOT NULL, quorum INTEGER NOT NULL DEFAULT 4, created_at INTEGER NOT NULL)",

  "CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, group_slug TEXT NOT NULL, name TEXT NOT NULL, pin_salt TEXT, pin_hash TEXT, colour_seed INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_seen_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_people_group ON people (group_slug, active)",

  "CREATE TABLE IF NOT EXISTS marks (group_slug TEXT NOT NULL, person_id TEXT NOT NULL, day TEXT NOT NULL, slot TEXT NOT NULL CHECK (slot IN ('MORNING','AFTERNOON','EVENING')), state TEXT NOT NULL CHECK (state IN ('FREE','MAYBE','BUSY')), source TEXT NOT NULL DEFAULT 'EXPLICIT', updated_at INTEGER NOT NULL, PRIMARY KEY (group_slug, person_id, day, slot))",
  "CREATE INDEX IF NOT EXISTS idx_marks_day ON marks (group_slug, day)",
  "CREATE INDEX IF NOT EXISTS idx_marks_person ON marks (group_slug, person_id, day)",

  "CREATE TABLE IF NOT EXISTS patterns (person_id TEXT PRIMARY KEY, group_slug TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL)",

  "CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, group_slug TEXT NOT NULL, day TEXT NOT NULL, slot TEXT NOT NULL, title TEXT NOT NULL, note TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_plans_day ON plans (group_slug, day)",

  "CREATE TABLE IF NOT EXISTS pin_attempts (person_id TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)",

  // v is INTEGER, not TEXT: it is a counter.
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",

  // Text that has nowhere to live in meta - currently the weekly nudge.
  "CREATE TABLE IF NOT EXISTS notes (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)",

  // opId idempotency. Without this, "ignore a repeated opId within an hour" has
  // nowhere to remember what it has already seen, and a replayed offline queue
  // double-applies. `response` caches the original body so a replay gets the
  // same answer it got the first time rather than a different one.
  "CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, created_at INTEGER NOT NULL, response TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_ops_created ON ops (created_at)",
];

// No FOREIGN KEY declarations, on purpose. D1 enforces them by default and
// there are no interactive transactions to defer them in. Referential integrity
// is the application's job, and a person is never DELETEd - active goes to 0 -
// so marks are never orphaned.
//
// PRIVACY INVARIANT, ENFORCED BY THE SCHEMA: there is nowhere to put a private
// event title. `marks` has no title, description or note column and MUST NEVER
// GAIN ONE. Private busy-ness is a single enum value and nothing else. The only
// titled entity is `plans`, which is group-visible by definition.
