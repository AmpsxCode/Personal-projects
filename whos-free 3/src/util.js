// Small shared server helpers. No I/O at module scope.

const B64URL = /[+/=]/g;
const B64URL_MAP = { '+': '-', '/': '_', '=': '' };

export function toBase64Url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(B64URL, (c) => B64URL_MAP[c]);
}

export function fromBase64Url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * n cryptographically random bytes as base64url.
 * 16 bytes = 128 bits. Never Math.random(), never sequential, never derived
 * from the group name.
 */
export function randomId(bytes = 16) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function personId() { return `p_${randomId(9)}`; }
export function planId() { return `pl_${randomId(9)}`; }

const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(s);

export function json(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  // Cloudflare's edge will not cache a private/no-store response, so it also
  // will not do anything automatic with our ETag. The conditional-request
  // handling below is entirely ours, which is what we want.
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Vary', 'Cookie');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function fail(status, error, message) {
  return json({ error, message: message || error }, { status });
}

export function html(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store');
  return new Response(body, { ...init, headers });
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function colourSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] % 360;
}

/** Trim, collapse whitespace, cap length. Names are display strings, not markup. */
export function cleanName(input, max = 24) {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Base URL of this deployment, from the request. Never guessed or configured. */
export function originOf(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}
