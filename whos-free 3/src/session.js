// Stateless HMAC-signed sessions. No session store, no third-party auth.
//
//   unguessable group link -> pick your name -> optional PIN -> signed cookie
//        (capability)          (identity)      (weak auth)     (stateless)

import { CONFIG } from './config.js';
import { fromBase64Url, toBase64Url, utf8 } from './util.js';

const COOKIE = 'wf';

let keyCache = null;
let keyCacheSecret = null;

// Per-isolate cache of the imported CryptoKey. This is a cache, not a
// datastore: worst case is an extra idempotent import per isolate. No I/O
// happens at module scope.
async function hmacKey(secret) {
  if (keyCache && keyCacheSecret === secret) return keyCache;
  const key = await crypto.subtle.importKey(
    'raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
  keyCache = key;
  keyCacheSecret = secret;
  return key;
}

/**
 * Sign a payload. exp is INSIDE the signed payload: the client controls how
 * long it keeps the cookie, the server controls what it is willing to trust.
 *
 * exp is in SECONDS - JWT convention, and the one place in this project that is
 * not milliseconds. Everything in D1 is ms. A missing /1000 here either expires
 * every session instantly or never expires one.
 */
export async function sign(payload, secret) {
  const body = toBase64Url(utf8(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, utf8(body));
  return `${body}.${toBase64Url(sig)}`;
}

/**
 * Verify and decode. Returns null on any failure - bad shape, bad signature,
 * expired - with no distinction, because the caller has no legitimate use for
 * the difference.
 *
 * crypto.subtle.verify is the documented way to compare an HMAC: it does not
 * bail out on the first mismatched byte the way a string comparison does.
 * Never `sig === expected`.
 */
export async function verify(token, secret, nowMs) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  let sig;
  try { sig = fromBase64Url(sigPart); } catch { return null; }
  const key = await hmacKey(secret);
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', key, sig, utf8(body)); } catch { return null; }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
  if (typeof payload.g !== 'string' || typeof payload.u !== 'string') return null;
  return payload;
}

export async function sessionCookie(groupSlug, personId, secret, nowMs) {
  const exp = Math.floor(nowMs / 1000) + CONFIG.SESSION_MAX_AGE_S;
  const token = await sign({ g: groupSlug, u: personId, exp }, secret);
  // All five attributes. SameSite=Lax, NOT Strict: clicking the invite link
  // from WhatsApp is a cross-site navigation and Strict drops the cookie.
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${CONFIG.SESSION_MAX_AGE_S}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readCookie(request) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The session for this request, or null. */
export async function currentSession(request, secret, nowMs) {
  const raw = readCookie(request);
  if (!raw) return null;
  return verify(raw, secret, nowMs);
}

/**
 * The ?p= / /c/ nudge token.
 *
 * A STRONGER CAPABILITY THAN THE GROUP LINK: it bypasses that person's PIN. So
 * it is only ever generated per-person for a nudge, never rendered into any
 * page, and never pasted into the group chat. Not single-use, because
 * link-preview fetchers will hit the URL before the recipient does.
 */
export async function nudgeToken(groupSlug, personId, secret, nowMs) {
  const exp = Math.floor(nowMs / 1000) + CONFIG.TOKEN_MAX_AGE_S;
  return sign({ g: groupSlug, u: personId, exp, k: 'nudge' }, secret);
}

export async function verifyNudgeToken(token, secret, nowMs) {
  const payload = await verify(token, secret, nowMs);
  if (!payload || payload.k !== 'nudge') return null;
  return payload;
}
