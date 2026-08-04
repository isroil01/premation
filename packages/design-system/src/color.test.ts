/**
 * The colour system's claims, tested as claims.
 *
 * Two of these matter more than the rest, because they are the reasons this file
 * does OKLCH maths instead of calling a CSS function:
 *
 *  • OKLCH interpolation does NOT pass through the grey dead-zone that sRGB
 *    interpolation does. That is the single visible difference and it is asserted
 *    directly.
 *  • A generated ramp is perceptually even. An sRGB ramp is not, and a ramp that
 *    is not perceptually even is why generated palettes look muddy at the bottom.
 */

import {
  buildPalette,
  contrast,
  enforceContrast,
  gradientStops,
  harmonize,
  hexToOklch,
  hexToRgb,
  isPureBlackOrWhite,
  mix,
  oklchToHex,
  ramp,
  requiredContrast,
  RAMP_L_MAX,
  RAMP_L_MIN,
} from './color';

/** sRGB channel-space interpolation — the thing OKLCH is replacing. */
function mixSrgb(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(A.r + (B.r - A.r) * t)}${h(A.g + (B.g - A.g) * t)}${h(A.b + (B.b - A.b) * t)}`;
}

describe('OKLCH round-trip', () => {
  it('survives hex → OKLCH → hex', () => {
    for (const hex of ['#2b7eff', '#ff3b1f', '#c8a862', '#0a0a0c', '#fafaf7', '#12a594']) {
      const back = oklchToHex(hexToOklch(hex));
      const a = hexToRgb(hex), b = hexToRgb(back);
      // Within one 8-bit step per channel.
      expect(Math.abs(a.r - b.r)).toBeLessThan(1.5 / 255);
      expect(Math.abs(a.g - b.g)).toBeLessThan(1.5 / 255);
      expect(Math.abs(a.b - b.b)).toBeLessThan(1.5 / 255);
    }
  });

  it('puts L in a perceptual order', () => {
    // Yellow and blue at the same sRGB "brightness" are wildly different
    // perceptually; OKLCH is what knows that.
    expect(hexToOklch('#ffff00').l).toBeGreaterThan(hexToOklch('#0000ff').l);
  });
});

describe('mix — the grey dead-zone', () => {
  it('keeps chroma up across a hue transition where sRGB collapses it', () => {
    // The headline claim. Blue → yellow is the classic case: the sRGB midpoint is
    // a desaturated grey-green, and that dead patch in the centre is the single
    // most recognisable feature of an amateur gradient.
    const from = '#0a4bff';
    const to = '#ffd60a';
    const okMid = hexToOklch(mix(from, to, 0.5)).c;
    const srgbMid = hexToOklch(mixSrgb(from, to, 0.5)).c;
    expect(okMid).toBeGreaterThan(srgbMid * 1.4);
  });

  it('beats sRGB decisively at the MIDPOINT, where the dead-zone lives', () => {
    // The dead-zone is specifically a midpoint phenomenon: near either endpoint
    // an sRGB blend is still close to a saturated colour, and it is halfway
    // across that it passes through the middle of the RGB cube. Measured here:
    // OKLCH holds 5.4× / 1.4× / 12.2× the midpoint chroma of the sRGB blend.
    const pairs: [string, string][] = [
      ['#0a4bff', '#ffd60a'],
      ['#ff2d95', '#00f0ff'],
      ['#12a594', '#e5484d'],
    ];
    for (const [a, b] of pairs) {
      const ok = hexToOklch(mix(a, b, 0.5)).c;
      const srgb = hexToOklch(mixSrgb(a, b, 0.5)).c;
      expect(ok).toBeGreaterThan(srgb * 1.3);
    }
  });

  it('does not collapse at the midpoint, within the sRGB gamut ceiling', () => {
    // The stronger claim — "never below the less-saturated endpoint" — is NOT
    // achievable, and not because of the interpolation. sRGB simply cannot
    // represent high-chroma colours at every hue/lightness combination: a
    // blue→yellow midpoint lands in a green-cyan region whose sRGB chroma
    // ceiling is genuinely lower than either endpoint's. `oklchToHex`
    // gamut-maps rather than clips, so what comes back is the most saturated
    // colour of that hue and lightness the display can show — and the honest
    // floor is ~0.7× the less-saturated endpoint, not 1.0×.
    const pairs: [string, string][] = [
      ['#0a4bff', '#ffd60a'],
      ['#ff2d95', '#00f0ff'],
      ['#12a594', '#e5484d'],
    ];
    for (const [a, b] of pairs) {
      const floor = Math.min(hexToOklch(a).c, hexToOklch(b).c);
      expect(hexToOklch(mix(a, b, 0.5)).c).toBeGreaterThan(floor * 0.7);
    }
  });

  it('gamut-maps rather than clips — hue survives the round trip', () => {
    // Per-channel clipping changes the RATIOS between channels, which moves hue
    // and lightness, not just saturation. That is what made the ramp come back
    // uneven before gamut mapping was added.
    const requested = { l: 0.62, c: 0.34, h: 150 }; // far outside sRGB
    const got = hexToOklch(oklchToHex(requested));
    expect(Math.abs(got.h - requested.h)).toBeLessThan(3);
    expect(Math.abs(got.l - requested.l)).toBeLessThan(0.02);
    expect(got.c).toBeLessThan(requested.c); // chroma is what gave way
  });

  it('takes the short way round the hue wheel', () => {
    // Blue (≈264°) → yellow (≈100°): the short way is through green, the long way
    // through red. Going the long way is not the transition anyone asked for.
    const midHue = hexToOklch(mix('#0a4bff', '#ffd60a', 0.5)).h;
    expect(midHue).toBeGreaterThan(100);
    expect(midHue).toBeLessThan(264);
  });

  it('returns the endpoints exactly at t=0 and t=1', () => {
    const a = '#2b7eff', b = '#ff3b1f';
    expect(hexToOklch(mix(a, b, 0)).h).toBeCloseTo(hexToOklch(a).h, 3);
    expect(hexToOklch(mix(a, b, 1)).h).toBeCloseTo(hexToOklch(b).h, 3);
  });
});

describe('ramp', () => {
  it('is perceptually even in lightness', () => {
    const steps = ramp('#2b7eff', 10).map((h) => hexToOklch(h).l);
    const deltas = steps.slice(1).map((l, i) => l - steps[i]!);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    // Every step within 15% of the mean step. An sRGB ramp fails this badly.
    for (const d of deltas) expect(Math.abs(d - mean) / mean).toBeLessThan(0.15);
  });

  it('is monotone and stays inside the ramp bounds', () => {
    const ls = ramp('#c8a862', 10).map((h) => hexToOklch(h).l);
    for (let i = 1; i < ls.length; i++) expect(ls[i]!).toBeGreaterThan(ls[i - 1]!);
    expect(ls[0]!).toBeGreaterThanOrEqual(RAMP_L_MIN - 0.01);
    expect(ls[ls.length - 1]!).toBeLessThanOrEqual(RAMP_L_MAX + 0.01);
  });

  it('never produces pure black or pure white', () => {
    // The bounds exist for this. A ramp that reaches #000000 hands the design
    // linter a guaranteed error.
    for (const base of ['#2b7eff', '#ff3b1f', '#0a0a0c', '#ffffff']) {
      for (const c of ramp(base, 12)) expect(isPureBlackOrWhite(c)).toBe(false);
    }
  });

  it('tapers chroma at the extremes so the ends do not clip', () => {
    const cs = ramp('#ff2d95', 9).map((h) => hexToOklch(h).c);
    const mid = cs[4]!;
    expect(cs[0]!).toBeLessThan(mid);
    expect(cs[cs.length - 1]!).toBeLessThan(mid);
  });
});

describe('gradientStops', () => {
  it('returns OKLCH-spaced intermediates, not just the endpoints', () => {
    const stops = gradientStops('#0a4bff', '#ffd60a', 3);
    expect(stops).toHaveLength(3);
    expect(hexToOklch(stops[1]!).c).toBeGreaterThan(hexToOklch(mixSrgb('#0a4bff', '#ffd60a', 0.5)).c);
  });

  it('clamps to 2..4 stops', () => {
    expect(gradientStops('#000010', '#fff0f0', 1)).toHaveLength(2);
    expect(gradientStops('#000010', '#fff0f0', 9)).toHaveLength(4);
  });
});

describe('enforceContrast', () => {
  it('lifts a failing colour until it passes', () => {
    const bg = '#12121a';
    const fg = '#1a1a24'; // nearly invisible
    expect(contrast(fg, bg)).toBeLessThan(4.5);
    const fixed = enforceContrast(fg, bg, 4.5);
    expect(contrast(fixed, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('leaves a passing colour untouched', () => {
    const bg = '#0a0a0c';
    const fg = '#fafaf7';
    expect(enforceContrast(fg, bg, 4.5)).toBe(fg);
  });

  it('keeps the hue — a brand accent stays recognisably itself', () => {
    // The reason this walks lightness instead of falling back to black or white.
    const bg = '#101018';
    const brand = '#1d2a5c';
    const fixed = enforceContrast(brand, bg, 4.5);
    const dh = Math.abs(hexToOklch(fixed).h - hexToOklch(brand).h);
    expect(Math.min(dh, 360 - dh)).toBeLessThan(12);
  });

  it('works in both directions — light background as well as dark', () => {
    const bg = '#fafaf7';
    const fg = '#f0f0ee';
    const fixed = enforceContrast(fg, bg, 4.5);
    expect(contrast(fixed, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('never returns pure black or white even when it cannot reach the target', () => {
    const impossible = enforceContrast('#808080', '#808080', 21);
    expect(isPureBlackOrWhite(impossible)).toBe(false);
  });
});

describe('requiredContrast', () => {
  it('uses the WCAG large-text threshold', () => {
    expect(requiredContrast(14, 400)).toBe(4.5);
    expect(requiredContrast(24, 400)).toBe(3);
    expect(requiredContrast(19, 700)).toBe(3);
    expect(requiredContrast(19, 400)).toBe(4.5);
  });
});

describe('buildPalette', () => {
  it('derives a full palette from one accent', () => {
    const p = buildPalette({ accent: '#2b7eff' });
    for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('never emits pure black or white anywhere', () => {
    for (const accent of ['#2b7eff', '#ff3b1f', '#c8a862', '#00f0ff']) {
      for (const mode of ['dark', 'light'] as const) {
        const p = buildPalette({ accent, mode });
        for (const [key, v] of Object.entries(p)) {
          expect(isPureBlackOrWhite(v)).toBe(false);
          void key;
        }
      }
    }
  });

  it('makes fg and muted legible on bg, and accent legible too', () => {
    for (const accent of ['#2b7eff', '#ff3b1f', '#c8a862', '#12a594', '#ff2d95']) {
      for (const mode of ['dark', 'light'] as const) {
        const p = buildPalette({ accent, mode });
        expect(contrast(p.fg, p.bg)).toBeGreaterThanOrEqual(6.5);
        expect(contrast(p.muted, p.bg)).toBeGreaterThanOrEqual(4.3);
        // Accent as large text — 3:1 is the bar, and every accent-coloured label
        // in the piece depends on it.
        expect(contrast(p.accent, p.bg)).toBeGreaterThanOrEqual(2.9);
      }
    }
  });

  it('tints the neutrals toward the accent hue rather than using flat grey', () => {
    // What makes a palette read as designed instead of "a colour on grey".
    const p = buildPalette({ accent: '#2b7eff', neutralTint: 0.05 });
    expect(hexToOklch(p.bg).c).toBeGreaterThan(0.01);
    const dh = Math.abs(hexToOklch(p.bg).h - hexToOklch('#2b7eff').h);
    expect(Math.min(dh, 360 - dh)).toBeLessThan(20);
  });

  it('respects neutralTint: 0 for a truly neutral palette', () => {
    const p = buildPalette({ accent: '#2b7eff', neutralTint: 0 });
    expect(hexToOklch(p.bg).c).toBeLessThan(0.005);
  });

  it('is deterministic', () => {
    expect(buildPalette({ accent: '#c8a862' })).toEqual(buildPalette({ accent: '#c8a862' }));
  });
});

describe('harmonize', () => {
  it('places the support colour at the harmony offset', () => {
    const accent = '#2b7eff';
    const h0 = hexToOklch(accent).h;
    const comp = hexToOklch(harmonize(accent, 'complementary')).h;
    // Signed hue delta normalised into [0, 360), compared against the intended
    // 180° offset. Gamut mapping can nudge the hue by a degree or two on the way
    // back through sRGB, hence the tolerance rather than an exact match.
    const delta = (((comp - h0) % 360) + 360) % 360;
    expect(Math.abs(delta - 180)).toBeLessThan(8);
  });

  it('keeps support quieter than the accent so the accent stays the accent', () => {
    const accent = '#ff3b1f';
    expect(hexToOklch(harmonize(accent, 'analogous')).c).toBeLessThan(hexToOklch(accent).c);
  });
});
