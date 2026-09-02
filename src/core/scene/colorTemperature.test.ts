/**
 * Colour temperature — the Kelvin control is only worth having if the numbers
 * mean what a gaffer thinks they mean, so the anchors are pinned by NAME as
 * well as by value: daylight is neutral, tungsten is orange, and a cold sky is
 * blue. The exact hexes are pinned too, because the inspector's Kelvin field
 * reads its own position back through `nearestKelvin` — drift in the forward
 * fit would silently move every light's displayed temperature.
 */

import { kelvinToHex, kelvinToRgb, nearestKelvin, KELVIN_MIN, KELVIN_MAX } from './colorTemperature';

describe('kelvinToHex', () => {
  it('is essentially white at 6500 K (daylight)', () => {
    expect(kelvinToHex(6500)).toBe('#fffefa');
    const [r, g, b] = kelvinToRgb(6500);
    // Neutral: every channel within a few units of full.
    expect(Math.min(r, g, b)).toBeGreaterThan(245);
  });

  it('is warm orange at 2700 K (tungsten practical)', () => {
    expect(kelvinToHex(2700)).toBe('#ffa757');
    const [r, g, b] = kelvinToRgb(2700);
    expect(r).toBe(255);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('is bluish at 10000 K (deep shade / moonlight look)', () => {
    expect(kelvinToHex(10000)).toBe('#cadaff');
    const [r, g, b] = kelvinToRgb(10000);
    expect(b).toBe(255);
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
  });

  it('crosses over to full white at 6600 K', () => {
    expect(kelvinToHex(6600)).toBe('#ffffff');
  });

  it('warms monotonically: blue falls and red holds as K drops', () => {
    const cool = kelvinToRgb(9000);
    const warm = kelvinToRgb(3000);
    expect(warm[2]).toBeLessThan(cool[2]);
    expect(warm[0]).toBeGreaterThanOrEqual(cool[0]);
  });

  it('clamps far outside the fit rather than producing junk channels', () => {
    for (const k of [0, -100, 1e6]) {
      const [r, g, b] = kelvinToRgb(k);
      for (const c of [r, g, b]) {
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('nearestKelvin', () => {
  it('round-trips the temperatures the UI can produce', () => {
    for (const k of [2000, 2700, 3200, 4000, 5600, 8000, 12000]) {
      expect(Math.abs(nearestKelvin(kelvinToHex(k)) - k)).toBeLessThanOrEqual(100);
    }
  });

  it('stays inside the offered range for colours off the locus', () => {
    for (const hex of ['#00ff00', '#000000', '#ff00ff']) {
      const k = nearestKelvin(hex);
      expect(k).toBeGreaterThanOrEqual(KELVIN_MIN);
      expect(k).toBeLessThanOrEqual(KELVIN_MAX);
    }
  });

  it('reads a DIMMED warm white as warm, not as some dark neutral', () => {
    // Half-brightness 2700 K: hue identical, energy halved.
    const [r, g, b] = kelvinToRgb(2700);
    const half = `#${[r, g, b].map((c) => Math.round(c / 2).toString(16).padStart(2, '0')).join('')}`;
    expect(Math.abs(nearestKelvin(half) - 2700)).toBeLessThanOrEqual(200);
  });

  it('falls back when the string is not a colour', () => {
    expect(nearestKelvin('not-a-colour', 5000)).toBe(5000);
    expect(nearestKelvin('#ab', 5000)).toBe(5000);
  });

  it('accepts short hex', () => {
    expect(nearestKelvin('#fff')).toBe(nearestKelvin('#ffffff'));
  });
});
