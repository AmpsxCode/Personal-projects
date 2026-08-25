// The Deploy button provisions the D1 binding. It does NOT run a migrations/
// directory. So the Worker creates its own schema and its own group row on the
// first request that needs the database.

import { CONFIG } from './config.js';
import { SCHEMA } from './schema.js';
import { randomId } from './util.js';

// Module-scope guard. This is a per-isolate cache, not a datastore: if the
// isolate is recycled the whole thing runs again, which is fine because every
// statement is idempotent. No I/O happens at module scope - only inside await
// ensureBooted(), which is called from a request handler.
let booted = false;
let bootPromise = null;

export const DEFAULT_GROUP_NAME = 'French toast';

export function versionKey(slug) { return `ver:${slug}`; }

/**
 * Bump the group's data version. THE UPSERT IS LOAD-BEARING.
 *
 * A bare UPDATE ... WHERE k='ver:x' on a fresh database matches nothing,
 * succeeds silently, and freezes the version forever - so the ETag never
 * changes, every poll returns 304, and other people's changes never appear.
 * That is the worst failure mode in this app because it looks like it works:
 * your own writes are optimistic and instant, so only other people's are
 * missing, with no error anywhere.
 *
 * This statement must be included in the SAME batch() as every write.
 */
export function bumpVersion(db, slug) {
  return db.prepare(
    'INSERT INTO meta (k, v) VALUES (?1, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1',
  ).bind(versionKey(slug));
}

export async function readVersion(db, slug) {
  const row = await db.prepare('SELECT v FROM meta WHERE k = ?1').bind(versionKey(slug)).first();
  return row ? row.v : 0;
}

async function runBoot(env, nowMs) {
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));

  const existing = await env.DB.prepare('SELECT slug, name FROM groups LIMIT 1').first();
  if (existing) return existing.slug;

  // 16 bytes from crypto.getRandomValues, base64url: a true 128 bits.
  const slug = randomId(16);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO groups (slug, name, quorum, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(slug, DEFAULT_GROUP_NAME, CONFIG.DEFAULT_QUORUM, nowMs),
    // Seed the counter even though the upsert would handle it.
    env.DB.prepare('INSERT INTO meta (k, v) VALUES (?1, 1) ON CONFLICT(k) DO NOTHING')
      .bind(versionKey(slug)),
  ]);
  return slug;
}

export async function ensureBooted(env, nowMs) {
  if (booted) return;
  if (!bootPromise) {
    bootPromise = runBoot(env, nowMs)
      .then((slug) => { booted = true; return slug; })
      .catch((err) => { bootPromise = null; throw err; });
  }
  await bootPromise;
}

export async function loadGroup(env) {
  return env.DB.prepare('SELECT slug, name, quorum FROM groups LIMIT 1').first();
}

/** Prune expired opId rows. Cheap, indexed, and folded into an existing batch. */
export function pruneOpsStatement(db, nowMs) {
  return db.prepare('DELETE FROM ops WHERE created_at < ?1').bind(nowMs - CONFIG.OP_TTL_MS);
}
