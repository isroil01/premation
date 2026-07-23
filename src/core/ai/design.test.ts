/**
 * Runtime palette derivation + custom style resolution (Phase: de-templating).
 */

import {
  hexToHsl,
  hslToHex,
  paletteFromBrand,
  deriveStyleFromBrief,
  buildCustomStyle,
  resolveStyle,
  setRuntimeStyle,
  PHYSICS,
} from './design';

afterEach(() => setRuntimeStyle(null));

describe('colour math', () => {
  it('round-trips a hex through HSL within 1/255 per channel', () => {
    for (const hex of ['#ff3d71', '#0a0e1a', '#6366f1', '#ffffff', '#000000']) {
      const hsl = hexToHsl(hex)!;
      expect(hsl).toBeTruthy();
      const back = hslToHex(hsl.h, hsl.s, hsl.l);
      const px = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const [r1, g1, b1] = px(hex);
      const [r2, g2, b2] = px(back);
      expect(Math.abs(r1! - r2!)).toBeLessThanOrEqual(1);
      expect(Math.abs(g1! - g2!)).toBeLessThanOrEqual(1);
      expect(Math.abs(b1! - b2!)).toBeLessThanOrEqual(1);
    }
  });

  it('rejects junk hex', () => {
    expect(hexToHsl('not-a-colour')).toBeNull();
    expect(paletteFromBrand('#12')).toBeNull();
  });
});

describe('paletteFromBrand', () => {
  it('builds a full dark palette in the brand hue', () => {
    const p = paletteFromBrand('#ff3d71')!;
    for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    // Background is deep, foreground near-white.
    expect(hexToHsl(p.bg)!.l).toBeLessThan(0.12);
    expect(hexToHsl(p.fg)!.l).toBeGreaterThan(0.9);
    // Accent keeps the brand hue (±12°).
    const dh = Math.abs(hexToHsl(p.accent)!.h - hexToHsl('#ff3d71')!.h);
    expect(Math.min(dh, 360 - dh)).toBeLessThan(12);
  });
});

describe('deriveStyleFromBrief', () => {
  it('returns null when the brief has no colour signal (presets stay in charge)', () => {
    expect(deriveStyleFromBrief('make a cool intro for my channel')).toBeNull();
  });

  it('derives palette from the mentioned brand colour and tokens from the mood anchor', () => {
    const s = deriveStyleFromBrief('an energetic promo using our brand color #ff3d71')!;
    expect(s).toBeTruthy();
    expect(s.name).toBe('custom');
    // Mood "energetic" → bold anchor's motion tokens.
    expect(s.entranceDur).toBeCloseTo(0.55);
    // Palette is brand-derived, not the bold preset's pink-on-purple.
    expect(s.palette.bg).not.toBe('#0b0b10');
    const dh = Math.abs(hexToHsl(s.palette.accent)!.h - hexToHsl('#ff3d71')!.h);
    expect(Math.min(dh, 360 - dh)).toBeLessThan(12);
  });

  it('uses a second mentioned colour for bgAccent', () => {
    const s = deriveStyleFromBrief('luxury reveal, colors #d4af37 and #1a2e1a')!;
    expect(hexToHsl(s.palette.bgAccent)!.l).toBeLessThan(0.15);
  });
});

describe('buildCustomStyle', () => {
  it('fills unspecified fields from the basedOn anchor', () => {
    const s = buildCustomStyle({ basedOn: 'minimal', palette: { accent: '#00c2a8' } });
    expect(s.type.titlePx).toBe(88); // minimal's scale
    expect(s.glow).toBe(false);
    // Accent given alone derives the rest of the palette around it.
    const dh = Math.abs(hexToHsl(s.palette.accent)!.h - hexToHsl('#00c2a8')!.h);
    expect(Math.min(dh, 360 - dh)).toBeLessThan(12);
  });

  it('maps easing personalities to the physics curves and honours explicit fields', () => {
    const s = buildCustomStyle({ name: 'Punch', easing: 'overshoot', entranceDur: 0.4, palette: { bg: '#101010' } });
    expect(s.entranceCurve).toEqual(PHYSICS.overshoot);
    expect(s.entranceDur).toBe(0.4);
    expect(s.palette.bg).toBe('#101010');
    expect(s.name).toBe('Punch');
  });
});

describe('resolveStyle with a runtime style', () => {
  const custom = buildCustomStyle({ name: 'brandy', palette: { accent: '#ff8800' } });

  it('unnamed / "custom" / unknown names resolve to the runtime style', () => {
    setRuntimeStyle(custom);
    expect(resolveStyle()).toBe(custom);
    expect(resolveStyle('custom')).toBe(custom);
    expect(resolveStyle('brandy')).toBe(custom);
    expect(resolveStyle('some-unknown-word')).toBe(custom);
  });

  it('explicit preset names and aliases still win', () => {
    setRuntimeStyle(custom);
    expect(resolveStyle('bold').name).toBe('bold');
    expect(resolveStyle('apple').name).toBe('premium');
  });

  it('without a runtime style, unknown names fall back to premium', () => {
    expect(resolveStyle('some-unknown-word').name).toBe('premium');
  });
});
