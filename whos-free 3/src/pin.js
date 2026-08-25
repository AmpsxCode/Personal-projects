// PIN handling. Weak auth on purpose - the threat is "someone taps the wrong
// name by accident", not a determined attacker.

import { CONFIG } from './config.js';
import { fromBase64Url, toBase64Url, utf8 } from './util.js';

/**
 * PBKDF2-SHA256 via crypto.subtle.deriveBits.
 *
 * 10,000 iterations, NOT 100,000. The Workers free plan gives a hard 10ms of
 * CPU per invocation, and 100k PBKDF2 rounds is well past that. The symptom
 * would be PIN entry failing with "Exceeded CPU limit" only sometimes, which is
 * undiagnosable from the outside. The measured cost is in the README.
 *
 * The rate limiter, not the KDF, is the real control here: a 4-digit PIN is a
 * 10,000-value keyspace and no iteration count saves it from someone who can
 * make 10,000 requests.
 */
export async function derive(pin, saltB64) {
  const salt = fromBase64Url(saltB64);
  const key = await crypto.subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: CONFIG.PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key, 256,
  );
  return toBase64Url(bits);
}

export function newSalt() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** 4+ digits. We nudge towards 6 in the UI but do not force it. */
export function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,12}$/.test(pin);
}

/**
 * Constant-time-ish comparison of two base64url digests of equal length.
 * timingSafeEqual is a Cloudflare extension and takes buffers.
 */
export function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    const x = fromBase64Url(a);
    const y = fromBase64Url(b);
    if (x.byteLength !== y.byteLength) return false;
    if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
    let diff = 0;
    for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
    return diff === 0;
  } catch {
    return false;
  }
}

/** Is this person locked out right now? */
export async function lockState(db, personId, nowMs) {
  const row = await db.prepare('SELECT fails, locked_until FROM pin_attempts WHERE person_id = ?1')
    .bind(personId).first();
  if (!row) return { locked: false, fails: 0 };
  if (row.locked_until > nowMs) {
    return { locked: true, fails: row.fails, retryAfterSeconds: Math.ceil((row.locked_until - nowMs) / 1000) };
  }
  return { locked: false, fails: row.fails };
}

export function recordFailStatement(db, personId, fails, nowMs) {
  const locked = fails + 1 >= CONFIG.PIN_MAX_FAILS ? nowMs + CONFIG.PIN_LOCK_MS : 0;
  return db.prepare(
    'INSERT INTO pin_attempts (person_id, fails, locked_until) VALUES (?1, 1, 0) '
    + 'ON CONFLICT(person_id) DO UPDATE SET fails = fails + 1, locked_until = ?2',
  ).bind(personId, locked);
}

export function clearFailsStatement(db, personId) {
  return db.prepare(
    'INSERT INTO pin_attempts (person_id, fails, locked_until) VALUES (?1, 0, 0) '
    + 'ON CONFLICT(person_id) DO UPDATE SET fails = 0, locked_until = 0',
  ).bind(personId);
}

/**
 * A dummy derivation, run when the named person does not exist or has no PIN,
 * so a wrong name and a wrong PIN cost the same wall-clock time and the
 * endpoint is not a membership oracle.
 */
export async function burnTime(pin) {
  await derive(typeof pin === 'string' ? pin : '0000', newSalt());
}
