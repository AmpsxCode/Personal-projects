// Derives the eight rendered variants from explicit L* targets, so the encoding
// is computed from the accessibility constraints rather than eyeballed.
//
// Constraints (section 9 of the brief):
//   free   L* >= 78        busy L* <= 38        free - busy >= 40
//   maybe  L* 55..68, and >= 12 clear of both neighbours
//   dim (assumed/stale) keeps a visible fill, and must not land inside another
//   variant's lightness band
// Hue is never load-bearing: it is decoration on top of lightness + border
// style + glyph.

const D65 = [95.047, 100.0, 108.883];

function labToXyz(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (116 * t - 16) / 903.3);
  return [f(fx) * D65[0], (L > 8 ? fy ** 3 : L / 903.3) * D65[1], f(fz) * D65[2]];
}

function xyzToRgb(X, Y, Z) {
  const x = X / 100, y = Y / 100, z = Z / 100;
  const lin = [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.2040 * y + 1.0570 * z,
  ];
  return lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  });
}

export function lch(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  return xyzToRgb(...labToXyz(L, C * Math.cos(h), C * Math.sin(h)));
}

export const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** WCAG relative luminance. */
export function luminance([r, g, b]) {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// L*, chroma, hue, border style, glyph. The glyph and border columns are what
// carry the pairs whose lightness is close.
// fill: 'none' | 'solid' | 'hatch' | 'split'. Fill PATTERN is a real channel -
// section 9 gives busy a 45-degree hatch and the day roll-up a hard-stop
// diagonal split precisely so they read differently in greyscale. Hue is the
// only channel that is never allowed to count.
export const VARIANTS = {
  notAnswered: { L: null, C: 0, h: 0, fill: 'none', border: 'dashed', glyph: 'none', label: 'Not answered' },
  free: { L: 86, C: 34, h: 150, fill: 'solid', border: 'solid', glyph: 'check-solid', label: 'Free' },
  maybe: { L: 64, C: 46, h: 78, fill: 'solid', border: 'solid', glyph: 'tilde', label: 'Maybe' },
  busy: { L: 30, C: 26, h: 20, fill: 'hatch', border: 'none', glyph: 'cross-solid', label: 'Busy' },
  dimFree: { L: 95, C: 12, h: 150, fill: 'solid', border: 'dashed-thin', glyph: 'check-outline', label: 'Assumed free' },
  dimMaybe: { L: 76, C: 18, h: 78, fill: 'solid', border: 'dashed-thin', glyph: 'tilde-outline', label: 'Assumed maybe' },
  dimBusy: { L: 47, C: 12, h: 20, fill: 'solid', border: 'dashed-thin', glyph: 'cross-outline', label: 'Assumed busy' },
  // The day roll-up. Its fill is literally the free colour and the busy colour
  // meeting at a hard stop, so its representative luminance is the mean of the
  // two halves - which is inherently close to a flat mid-tone. That is why fill
  // PATTERN has to count as a channel: a hard diagonal stop is unmistakable in
  // greyscale in a way that no luminance threshold can express.
  partly: { L: 70, C: 20, h: 150, fill: 'split', border: 'solid', glyph: 'half', label: 'Partly free', splitOf: ['free', 'busy'] },
};

// Dark mode inverts the RAMP DIRECTION, not the lightness. "More free" has to
// stay the more prominent end, or the state people scan for becomes the dimmest
// cell on the screen.
export const DARK = {
  notAnswered: { L: null, C: 0, h: 0 },
  free: { L: 74, C: 40, h: 150 },
  maybe: { L: 52, C: 44, h: 78 },
  busy: { L: 26, C: 18, h: 20 },
  dimFree: { L: 56, C: 16, h: 150 },
  dimMaybe: { L: 42, C: 16, h: 78 },
  dimBusy: { L: 30, C: 8, h: 20 },
  partly: { L: 58, C: 18, h: 150 },
};

export function build(spec) {
  const out = {};
  for (const [k, v] of Object.entries(spec)) {
    out[k] = v.L == null ? null : { rgb: lch(v.L, v.C, v.h), L: v.L };
  }
  return out;
}

export const PAGE_LIGHT = lch(98, 2, 250);
export const PAGE_DARK = lch(20, 6, 250);
export const INK_LIGHT = lch(22, 6, 250);
export const INK_DARK = lch(94, 3, 250);

// The day roll-up heat ramp. Bucketed to FIVE steps, because a 12-step ramp is
// indistinguishable, and kept inside the "free" hue so it never collides with
// the maybe or busy fills - the grid must not use the maybe colour to mean
// "some people are free", which would contradict the legend it sits under.
//
// The numeral in the cell is the primary encoding. This is redundant
// reinforcement, which is why it is allowed to be subtle.
export const RAMP_LIGHT = [
  { L: 94, C: 10, h: 150 },
  { L: 90, C: 18, h: 150 },
  { L: 86, C: 26, h: 150 },
  { L: 82, C: 34, h: 150 },
  { L: 78, C: 42, h: 150 },
];

// Dark mode inverts the RAMP DIRECTION: more free stays the brighter, more
// prominent end. Flipping lightness instead would make the state people scan
// for the dimmest thing on the screen.
export const RAMP_DARK = [
  { L: 42, C: 8, h: 150 },
  { L: 50, C: 14, h: 150 },
  { L: 58, C: 22, h: 150 },
  { L: 66, C: 30, h: 150 },
  { L: 74, C: 38, h: 150 },
];
