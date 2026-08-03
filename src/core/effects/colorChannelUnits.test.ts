/**
 * Decomposed colour tracks (`<base>_r/_g/_b/_a`) are 0..1 EVERYWHERE.
 *
 * There is no type that says so — the tracks are plain numbers — so the scale is
 * an agreement between four writers, two readers and the property registry that
 * describes the slider. It broke: `Color.fromHex` (every writer) emits 0..1,
 * `Color.toHex` (the fill/stroke/text reader) consumes 0..1, and
 * `parseColorChannels`/`channelsToColor` (the effect, layer-style, particle and
 * Glass reader) used 0..255. Full red went in as 1.0 and came out as `#010000`,
 * so every animated colour on an effect or a layer style rendered near-black at
 * every frame — indistinguishable, on a drop shadow, from "the colour keyframes
 * do nothing".
 *
 * The round-trip below is what pins it: whatever a colour picker stores, the
 * renderer must read back as the same colour.
 */

import { Color } from '@motion/renderer';
import {
  parseColorChannels,
  channelsToColor,
  resolveChannelColor,
  resolveEffectParams,
  effectParam,
  effectPropPath,
  type Effect,
} from './effects';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';

const HEXES = ['#ff0000', '#00ff00', '#3080ff', '#000000', '#ffffff', '#78b4ff'];

describe('colour channel tracks are one scale end to end', () => {
  it('what the picker WRITES is what the renderer READS', () => {
    for (const hex of HEXES) {
      // The write path, verbatim: every colour stopwatch in the app does this.
      const c = Color.fromHex(hex);
      const written = { _r: c.r, _g: c.g, _b: c.b, _a: c.a ?? 1 };
      // The read path, verbatim.
      const readBack = resolveChannelColor('#000000', (s) => written[s]);
      expect(readBack.toLowerCase()).toBe(hex.toLowerCase());
    }
  });

  it('parseColorChannels and channelsToColor are inverses, in 0..1', () => {
    for (const hex of HEXES) {
      const [r, g, b, a] = parseColorChannels(hex);
      for (const v of [r, g, b, a]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(channelsToColor(r, g, b, a).toLowerCase()).toBe(hex.toLowerCase());
    }
  });

  it('agrees with Color.fromHex channel for channel — the writers use it directly', () => {
    for (const hex of HEXES) {
      const [r, g, b] = parseColorChannels(hex);
      const c = Color.fromHex(hex);
      expect(r).toBeCloseTo(c.r, 6);
      expect(g).toBeCloseTo(c.g, 6);
      expect(b).toBeCloseTo(c.b, 6);
    }
  });

  it('an animated EFFECT colour resolves to the colour that was picked', () => {
    const glow: Effect[] = [{ id: 'g', type: 'glow', params: { radius: 16, intensity: 100, color: '#78b4ff' } }];
    const c = Color.fromHex('#ff0000');
    const out = resolveEffectParams(glow, (p) => {
      if (p === effectPropPath('g', 'color_r')) return c.r;
      if (p === effectPropPath('g', 'color_g')) return c.g;
      if (p === effectPropPath('g', 'color_b')) return c.b;
      if (p === effectPropPath('g', 'color_a')) return c.a ?? 1;
      return undefined;
    });
    // Not '#010000' — the value the 0..255 reader produced from a 0..1 track.
    expect(effectParam(out[0]!, 'color')).toBe('#ff0000');
  });

  it('a partially-keyframed colour keeps the STORED channels, not white', () => {
    const glow: Effect[] = [{ id: 'g', type: 'glow', params: { radius: 16, color: '#78b4ff' } }];
    const out = resolveEffectParams(glow, (p) =>
      p === effectPropPath('g', 'color_g') ? 0 : undefined,
    );
    expect(effectParam(out[0]!, 'color')).toBe('#7800ff');
  });

  it('the property registry describes the range the tracks are actually stored in', () => {
    // The slider, the graph editor and the timeline row all read this. Declaring
    // 0..255 for a 0..1 track made everything above 1 a no-op the UI still let
    // you drag to.
    for (const path of ['fill_r', 'fill_g', 'fill_b', 'fill_a', 'stroke_r', 'effect.e1.color_r']) {
      const m = resolvePropertyMeta(path);
      expect(m.max).toBe(1);
      expect(m.min).toBe(0);
      expect(m.step).toBeLessThan(1);
    }
  });
});
