/**
 * Depth of field — the legacy ramp, and the physical circle of confusion.
 *
 * TWO ASSERTIONS CARRY THIS FILE.
 *
 * 1. **The legacy model is byte-identical without an f-stop.** A new lens model
 *    that quietly re-grades every shot someone already approved is worse than
 *    no lens model. `fStop` being absent is the whole switch, exactly as
 *    `lightFalloffAt`'s `'none'` preserves the pre-falloff radius ramp.
 *
 * 2. **The physical model is ASYMMETRIC.** That is the actual defect in the old
 *    maths and the reason to have done this at all: `|d − S|` treats a layer
 *    the same distance in FRONT of the focal plane exactly like one behind it,
 *    and lets background blur grow without bound. Real lenses saturate behind
 *    the focal plane and blow up in front of it. Symmetry is invisible in a
 *    still and unmistakable the moment the camera moves.
 */

import { readSource } from '@/__testHelpers__/readSource';
import { dofBlurPx, focusRangeAt, type DofConfig } from './camera3d';

/** Legacy config — no `fStop`, so the old ramp. */
const legacy = (over: Partial<DofConfig> = {}): DofConfig => ({
  strength: 100, focus: 1000, aperture: 50, ...over,
});

/** Physical config — `fStop` present selects the thin-lens model. */
const physical = (over: Partial<DofConfig> = {}): DofConfig => ({
  strength: 1000, focus: 1000, aperture: 50, focalLength: 50, fStop: 2.8, ...over,
});

describe('legacy ramp (no f-stop) is untouched', () => {
  it('reproduces the original formula exactly', () => {
    const dof = legacy();
    const original = (depth: number): number =>
      Math.min(dof.strength, (Math.abs(depth - dof.focus) / Math.max(1, dof.focus)) * dof.aperture);
    for (const d of [0, 1, 500, 1000, 1500, 5000, 100000]) {
      expect(dofBlurPx(d, dof)).toBe(original(d));
    }
  });

  it('is symmetric about the focal plane — the defect, pinned as legacy behaviour', () => {
    const dof = legacy();
    expect(dofBlurPx(600, dof)).toBeCloseTo(dofBlurPx(1400, dof), 10);
  });

  it('ignores focal length, since the old ramp never read it', () => {
    expect(dofBlurPx(2000, legacy({ focalLength: 20 })))
      .toBe(dofBlurPx(2000, legacy({ focalLength: 200 })));
  });

  it('a zero or absent f-stop does NOT switch models', () => {
    // `readSceneDof` only forwards a positive f-stop; belt and braces, because
    // a 0 reaching here would divide by zero in the physical branch.
    expect(dofBlurPx(2000, legacy())).toBe(dofBlurPx(2000, legacy({ fStop: undefined })));
  });
});

describe('physical circle of confusion', () => {
  it('is zero exactly at the focal plane', () => {
    expect(dofBlurPx(1000, physical())).toBeCloseTo(0, 10);
  });

  it('is ASYMMETRIC — foreground defocuses harder than background', () => {
    const dof = physical();
    const front = dofBlurPx(1000 - 400, dof);
    const back = dofBlurPx(1000 + 400, dof);
    expect(front).toBeGreaterThan(back);
  });

  it('saturates behind the focal plane', () => {
    const dof = physical();
    const limit = (50 / 2.8) * 50 / (1000 - 50);
    const far = dofBlurPx(1e6, dof);
    const further = dofBlurPx(1e9, dof);

    // Convergence stated as convergence, rather than as an arbitrary decimal
    // place: each is below the limit and the further one is strictly closer.
    // (Picking `toBeCloseTo(…, 3)` failed at a true error of 9.4e-4 — the
    // physics was right and the tolerance was a guess.)
    expect(far).toBeLessThan(limit);
    expect(further).toBeLessThan(limit);
    expect(limit - further).toBeLessThan(limit - far);
    expect(further).toBeCloseTo(limit, 5);

    // The point of saturation: a distant and a VERY distant backdrop look alike.
    expect(further - far).toBeLessThan(limit * 0.01);
  });

  it('grows without bound in front of the focal plane, up to the cap', () => {
    const dof = physical({ strength: 1e9 });
    expect(dofBlurPx(1, dof)).toBeGreaterThan(dofBlurPx(100, dof));
    expect(dofBlurPx(100, dof)).toBeGreaterThan(dofBlurPx(500, dof));
  });

  it('a longer lens is shallower at the same f-number', () => {
    const wide = dofBlurPx(2000, physical({ focalLength: 25 }));
    const long = dofBlurPx(2000, physical({ focalLength: 100 }));
    expect(long).toBeGreaterThan(wide);
  });

  it('a wider aperture (smaller f-number) blurs more', () => {
    expect(dofBlurPx(2000, physical({ fStop: 1.4 })))
      .toBeGreaterThan(dofBlurPx(2000, physical({ fStop: 16 })));
  });

  it('honours the Blur Level cap', () => {
    expect(dofBlurPx(1, physical({ strength: 12 }))).toBe(12);
  });

  it('matches the closed form for a hand-checked case', () => {
    // f=50, N=2, S=1000, d=2000 → A=25; CoC = 25·50·1000 / (2000·950)
    const coc = (25 * 50 * 1000) / (2000 * 950);
    expect(dofBlurPx(2000, physical({ focalLength: 50, fStop: 2, strength: 1e9 })))
      .toBeCloseTo(coc, 10);
  });
});

describe('the control reaches the model', () => {
  // Four dead controls have shipped in this repo by a writer and a reader
  // drifting apart. `fStop` is exactly that shape — one prop, written in one
  // place, read in one place — so both ends are pinned here.

  it('CameraSection writes the prop', () => {
    const ui = readSource('layout/Inspector/CameraSection.tsx');
    expect(ui).toMatch(/useNodeComponentProp\([^)]*'fStop'\)/);
    expect(ui).toMatch(/prop="fStop"/);
  });

  it('readSceneDof reads it, from components AND from a sampled track', () => {
    const src = readSource('core/scene/camera3d.ts');
    expect(src).toMatch(/num\(p\.fStop\)/);
    expect(src).toMatch(/sample\?\.\(node\.id, 'fStop'\)/);
  });

  it('is forwarded only when positive, so 0 cannot switch models', () => {
    const src = readSource('core/scene/camera3d.ts');
    expect(src).toMatch(/fStop !== undefined && fStop > 0/);
  });
});

describe('degenerate rigs resolve to the cap, never to NaN', () => {
  // A NaN blur radius does not throw — it silently blanks the layer, which is
  // the worst possible failure mode for a camera parameter.
  it.each([
    ['focus inside the focal length', { focus: 10, focalLength: 50 }],
    ['focus exactly at the focal length', { focus: 50, focalLength: 50 }],
    ['a zero f-stop', { fStop: 0 }],
  ])('%s', (_why, over) => {
    const v = dofBlurPx(500, physical({ strength: 7, ...over }));
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(7);
  });

  it.each([0, -100, NaN, Infinity])('a depth of %p stays finite', (d) => {
    const v = dofBlurPx(d, physical({ strength: 7 }));
    expect(Number.isFinite(v)).toBe(true);
  });
});

/**
 * The focus BAND, which is what the viewport's focus-plane gizmo draws.
 *
 * The assertion that matters is the round trip: `focusRangeAt` is the algebraic
 * inverse of `dofBlurPx`, so evaluating the blur AT the limits it returns must
 * land back on the threshold. A band derived any other way — a search, a fudge
 * factor, a second copy of the lens maths — drifts off the pixels the renderer
 * actually blurs, and the drift is invisible in a still.
 */
describe('focusRangeAt inverts the blur model', () => {
  it('round-trips on the legacy ramp', () => {
    const dof = legacy({ strength: 100, focus: 1000, aperture: 50 });
    const { near, far } = focusRangeAt(dof, 2);
    expect(dofBlurPx(near, dof)).toBeCloseTo(2, 9);
    expect(dofBlurPx(far, dof)).toBeCloseTo(2, 9);
  });

  it('round-trips on the physical CoC, both sides', () => {
    const dof = physical({ strength: 1e9, focus: 1000, focalLength: 50, fStop: 2.8 });
    const { near, far } = focusRangeAt(dof, 0.5);
    expect(Number.isFinite(far)).toBe(true);
    expect(dofBlurPx(near, dof)).toBeCloseTo(0.5, 9);
    expect(dofBlurPx(far, dof)).toBeCloseTo(0.5, 9);
  });

  it('brackets the focal plane, and the plane itself is sharp', () => {
    const dof = physical({ strength: 1e9 });
    const { near, far } = focusRangeAt(dof, 0.5);
    expect(near).toBeLessThan(dof.focus);
    expect(far).toBeGreaterThan(dof.focus);
  });

  it('is ASYMMETRIC under the physical model and symmetric under the ramp', () => {
    const phys = physical({ strength: 1e9 });
    const r = focusRangeAt(phys, 0.5);
    // Depth of field extends further BEHIND the subject than in front — the
    // classic ~1/3-in-front rule, and something the legacy ramp cannot express.
    expect(r.far - phys.focus).toBeGreaterThan(phys.focus - r.near);

    const ramp = legacy();
    const l = focusRangeAt(ramp, 2);
    expect(l.far - ramp.focus).toBeCloseTo(ramp.focus - l.near, 9);
  });

  it('runs to infinity past the hyperfocal distance', () => {
    // A tiny f-number stop is not needed: a large enough tolerance swallows the
    // saturated background blur entirely, which IS the hyperfocal condition.
    const dof = physical({ strength: 1e9, focus: 1000, focalLength: 50, fStop: 16 });
    expect(focusRangeAt(dof, 5).far).toBe(Infinity);
    expect(focusRangeAt(dof, 5).near).toBeGreaterThan(0);
  });

  it('reports the whole scene in focus when the threshold is at or above the cap', () => {
    // Blur saturates at `strength`, so nothing can ever exceed a bigger
    // threshold — a band that pretended otherwise would draw two planes the
    // render does not honour.
    expect(focusRangeAt(physical({ strength: 3 }), 3)).toEqual({ near: 0, far: Infinity });
    expect(focusRangeAt(legacy({ strength: 3 }), 4)).toEqual({ near: 0, far: Infinity });
  });

  it('collapses to the plane for a rig that never converges', () => {
    const dof = physical({ strength: 100, focus: 40, focalLength: 50 });
    expect(focusRangeAt(dof, 1)).toEqual({ near: 40, far: 40 });
  });

  it('never returns NaN', () => {
    for (const over of [{ focus: 0 }, { focus: -10 }, { fStop: 0 }, { aperture: 0 }]) {
      const { near, far } = focusRangeAt(physical(over), 1);
      expect(Number.isNaN(near)).toBe(false);
      expect(Number.isNaN(far)).toBe(false);
    }
  });
});
