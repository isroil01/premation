/**
 * Lottie library — every bundled document must be a genuinely importable
 * Lottie file: it plans through the REAL planner with zero warnings, yields
 * at least one layer, and only uses features the importer understands.
 */

import { planLottieImport } from '@core/lottie/lottieImport';
import { LOTTIE_ITEMS, getLottieItem, LOTTIE_DESIGN_CENTER } from './lottieLibrary';

describe('lottieLibrary', () => {
  it('has unique ids and a catalog lookup', () => {
    const ids = LOTTIE_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getLottieItem('lot-pill-stepper')?.name).toBe('Pill Stepper');
    expect(getLottieItem('nope')).toBeNull();
  });

  it.each(LOTTIE_ITEMS.map((i) => [i.id, i] as const))(
    '%s plans through the real importer with zero warnings',
    (_id, item) => {
      const plan = planLottieImport(item.doc);
      expect(plan.warnings).toEqual([]);
      expect(plan.layers.length).toBeGreaterThan(0);
      // The document advertises the design box the insert offset math assumes.
      expect(plan.comp.width).toBe(LOTTIE_DESIGN_CENTER * 2);
      expect(plan.comp.height).toBe(LOTTIE_DESIGN_CENTER * 2);
      expect(plan.comp.fps).toBe(30);
      expect(plan.comp.durationSeconds).toBeCloseTo(item.frames / 30, 5);
    }
  );

  it('shape layers carry real geometry and fills', () => {
    for (const item of LOTTIE_ITEMS) {
      const plan = planLottieImport(item.doc);
      const shapes = plan.layers.filter((l) => l.kind === 'shape');
      expect(shapes.length).toBeGreaterThan(0);
      for (const s of shapes) {
        expect(typeof s.staticProps.fill).toBe('string');
        if (s.pointsTrack) {
          expect(s.pointsTrack.keyframes.length).toBeGreaterThanOrEqual(1);
          const counts = s.pointsTrack.keyframes.map((kf) => (kf.value as unknown[]).length);
          for (const c of counts) expect(c).toBeGreaterThanOrEqual(3);
          expect(new Set(counts).size).toBe(1);
        } else {
          expect(s.staticProps.shapeType === 'rect' || s.staticProps.shapeType === 'ellipse').toBe(true);
          expect(typeof s.staticProps.width).toBe('number');
          expect(typeof s.staticProps.height).toBe('number');
        }
      }
    }
  });

  it('every document animates something (transform tracks or path morphs)', () => {
    for (const item of LOTTIE_ITEMS) {
      const plan = planLottieImport(item.doc);
      const animated = plan.layers.some(
        (l) => l.scalarTracks.length > 0 || (l.pointsTrack?.keyframes.length ?? 0) > 1
      );
      expect(animated).toBe(true);
    }
  });

  it('parented layers reference existing parents (Pill Stepper, Dynamic Island, Face ID)', () => {
    for (const id of ['lot-pill-stepper', 'lot-dynamic-island', 'lot-face-id', 'lot-glass-action']) {
      const plan = planLottieImport(getLottieItem(id)!.doc);
      const inds = new Set(plan.layers.map((l) => l.ind));
      const withParent = plan.layers.filter((l) => l.parentInd !== undefined);
      expect(withParent.length).toBeGreaterThan(0);
      for (const l of withParent) expect(inds.has(l.parentInd!)).toBe(true);
    }
  });
});
