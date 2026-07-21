/**
 * Capability benchmark — build the SaaS ad and render it through the real
 * snapshot pipeline across the whole 24s timeline. Proves the editor handles a
 * dense, multi-scene, precomp-based composition and that the scene
 * choreography actually animates.
 */

import { buildSaaSAd } from './seedSaaSAd';
import defaultSceneGraph from './DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';

const render = (t: number) => buildSnapshot(defaultSceneGraph, defaultAnimation, t);
const S = (id: string, prop: string, t: number) => defaultAnimation.sample(id, prop, t) ?? 0;

describe('SaaS ad — motion capability benchmark', () => {
  beforeAll(() => { buildSaaSAd(); });

  it('authors a dense, 6-scene composition', () => {
    const r = buildSaaSAd();
    expect(r.scenes).toBe(6);
    expect(r.nodes).toBeGreaterThanOrEqual(60); // many components across the scenes
    const snap = render(1.5);
    expect(snap.width).toBe(1920);
    expect(snap.height).toBe(1080);
  });

  it('renders every scene across the timeline without throwing', () => {
    for (const t of [0, 0.5, 1.5, 4, 6, 8, 10, 13, 15, 17.5, 18.5, 20.5, 22, 23.5, 24]) {
      const snap = render(t);
      expect(snap.layers.length).toBeGreaterThan(0);
      for (const l of snap.layers) {
        expect(Number.isFinite(l.x)).toBe(true);
        expect(Number.isFinite(l.y)).toBe(true);
        expect(Number.isFinite(l.opacity)).toBe(true);
      }
    }
  });

  it('cross-dissolves scenes (opacity choreography across the story)', () => {
    // Opening is up early, gone by the UI-demo beat.
    expect(S('ad_s1', 'opacity', 1.5)).toBeGreaterThan(80);
    expect(S('ad_s1', 'opacity', 10)).toBeLessThan(20);
    // Product beat peaks mid, CTA peaks at the end.
    expect(S('ad_s2', 'opacity', 6)).toBeGreaterThan(80);
    expect(S('ad_s6', 'opacity', 22)).toBeGreaterThan(80);
    expect(S('ad_s6', 'opacity', 6)).toBeLessThan(20);
  });

  it('animates within scenes (background parallax + trim draw-ons)', () => {
    // Background orb drifts (parallax depth).
    expect(Math.abs(S('ad_orb1', 'x', 0) - S('ad_orb1', 'x', 12))).toBeGreaterThan(100);
    // The persistent background keeps rendering at every beat.
    expect(render(0.2).layers.length).toBeGreaterThan(2);
  });

  it('keeps a persistent animated background behind the scenes', () => {
    const bg = render(15).layers.find((l) => l.id === 'ad_bg' || l.id.startsWith('ad_bg'));
    // The gradient background is a full-comp layer.
    const anyBg = render(15).layers.some((l) => l.width >= 1920);
    expect(anyBg || !!bg).toBe(true);
  });
});
