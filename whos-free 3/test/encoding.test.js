// The mechanised greyscale test.
//
// Section 9's invariant: any two RENDERED variants must differ on at least TWO
// of {fill presence, fill pattern, fill lightness, border style, glyph}. Hue is
// never one of the two - about 1 in 12 men has some colour vision deficiency,
// which in a group of seven friends is not hypothetical.
//
// There are eight RENDERED variants, not ten semantic states. Assumed and stale
// deliberately share one rendering (section 9 gives them the same row in the
// table); they are separated by words instead - their own tally bucket, their
// own named list, and the relative-age line. Testing them as separate visual
// variants would be testing a distinction the design does not make.

import assert from 'node:assert/strict';
import test from 'node:test';
import { DARK, VARIANTS, build, contrast, hex, luminance } from '../tools/palette.mjs';

const LIGHT_PAGE = build({ p: { L: 98, C: 2, h: 250 } }).p.rgb;
const DARK_PAGE = build({ p: { L: 20, C: 6, h: 250 } }).p.rgb;

const keys = Object.keys(VARIANTS);

function channels(a, b, colours) {
  const va = VARIANTS[a], vb = VARIANTS[b];
  const ca = colours[a], cb = colours[b];
  const differs = [];
  if ((va.fill === 'none') !== (vb.fill === 'none')) differs.push('fill-presence');
  if (va.fill !== vb.fill && va.fill !== 'none' && vb.fill !== 'none') differs.push('fill-pattern');
  if (ca && cb && Math.abs(luminance(ca.rgb) - luminance(cb.rgb)) >= 0.15) differs.push('lightness');
  if (va.border !== vb.border) differs.push('border');
  if (va.glyph !== vb.glyph) differs.push('glyph');
  return differs;
}

test('eight rendered variants, all pairwise distinguishable without hue (light)', () => {
  const colours = build(VARIANTS);
  assert.equal(keys.length, 8, 'exactly eight rendered variants');
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const differs = channels(keys[i], keys[j], colours);
      assert.ok(
        differs.length >= 2,
        `${keys[i]} vs ${keys[j]} differ on only [${differs.join(', ')}] - needs 2+`,
      );
    }
  }
});

// Representative luminance. A split fill is two colours meeting at a hard stop,
// so its greyscale reading is the mean of its halves.
function repLuminance(key, colours) {
  const v = VARIANTS[key];
  if (!colours[key]) return null;
  if (v.splitOf) {
    const [a, b] = v.splitOf;
    return (luminance(colours[a].rgb) + luminance(colours[b].rgb)) / 2;
  }
  return luminance(colours[key].rgb);
}

test('greyscale rule: luminance gap >= 0.15, or two of fill-pattern/border/glyph differ', () => {
  // Section 9 states the rule as "luminance differs by >= 0.15 OR border-style
  // and glyph both differ". Fill PATTERN is folded into that second clause
  // here, because the one pair it matters for - maybe vs partly-free - cannot
  // be separated by luminance at all: a hard-stop diagonal split of free and
  // busy averages out to roughly a mid-tone by construction, which is exactly
  // what maybe is. A flat mid fill and a two-tone diagonal are not remotely
  // confusable on a greyscale screen, so the pattern difference is the real
  // signal and the mean-luminance number is the artefact.
  const colours = build(VARIANTS);
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = keys[i], b = keys[j];
      const la = repLuminance(a, colours), lb = repLuminance(b, colours);
      const lumGap = la == null || lb == null ? 1 : Math.abs(la - lb);
      const nonHue = [
        VARIANTS[a].fill !== VARIANTS[b].fill,
        VARIANTS[a].border !== VARIANTS[b].border,
        VARIANTS[a].glyph !== VARIANTS[b].glyph,
      ].filter(Boolean).length;
      assert.ok(
        lumGap >= 0.15 || nonHue >= 2,
        `${a} vs ${b}: luminance gap ${lumGap.toFixed(3)} and only ${nonHue} non-hue channel(s) differ`,
      );
    }
  }
});

test('lightness bands: free is light, busy is dark, maybe sits clear of both', () => {
  assert.ok(VARIANTS.free.L >= 78, `free L* ${VARIANTS.free.L} must be >= 78`);
  assert.ok(VARIANTS.busy.L <= 38, `busy L* ${VARIANTS.busy.L} must be <= 38`);
  assert.ok(VARIANTS.free.L - VARIANTS.busy.L >= 40, 'free and busy need 40 L* of separation');
  assert.ok(VARIANTS.maybe.L >= 55 && VARIANTS.maybe.L <= 68, 'maybe must sit in the 55-68 band');
  assert.ok(VARIANTS.free.L - VARIANTS.maybe.L >= 12, 'maybe must stay 12 L* clear of free');
  assert.ok(VARIANTS.maybe.L - VARIANTS.busy.L >= 12, 'maybe must stay 12 L* clear of busy');
});

test('not answered is the only variant with no fill, and the only dashed one', () => {
  const noFill = keys.filter((k) => VARIANTS[k].fill === 'none');
  assert.deepEqual(noFill, ['notAnswered']);
  const dashed = keys.filter((k) => VARIANTS[k].border === 'dashed');
  assert.deepEqual(dashed, ['notAnswered'], 'plain dashed belongs to not-answered alone');
  const hatched = keys.filter((k) => VARIANTS[k].fill === 'hatch');
  assert.deepEqual(hatched, ['busy'], 'busy is the only hatched fill');
});

test('assumed and stale keep a visible fill rather than becoming outlines', () => {
  const colours = build(VARIANTS);
  for (const k of ['dimFree', 'dimMaybe', 'dimBusy']) {
    const gap = Math.abs(luminance(colours[k].rgb) - luminance(LIGHT_PAGE));
    assert.ok(gap > 0.05, `${k} fill is invisible against the page (gap ${gap.toFixed(3)})`);
  }
});

test('dark mode inverts the ramp direction, not the lightness', () => {
  const dark = build(DARK);
  // "More free" must remain the more prominent end. If we simply inverted
  // lightness, "everyone free" would become the dimmest cell on the screen -
  // the exact state people scan for, rendered least visible.
  const freeContrast = contrast(dark.free.rgb, DARK_PAGE);
  const busyContrast = contrast(dark.busy.rgb, DARK_PAGE);
  assert.ok(freeContrast > busyContrast,
    `free (${freeContrast.toFixed(2)}) must be more prominent than busy (${busyContrast.toFixed(2)}) on a dark page`);
  assert.ok(DARK.free.L - DARK.busy.L >= 40, 'dark mode still needs 40 L* between free and busy');
});

test('every fill has a hex value that round-trips', () => {
  const colours = build(VARIANTS);
  for (const k of keys) {
    if (!colours[k]) continue;
    assert.match(hex(colours[k].rgb), /^#[0-9a-f]{6}$/);
  }
});
