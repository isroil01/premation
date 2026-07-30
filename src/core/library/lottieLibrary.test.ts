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

  /**
   * THE REGRESSION THAT BROKE EVERY PARENTED ITEM.
   *
   * These documents are authored in one flat design box, but Lottie parenting
   * composes (`world = parent · local`, same as the engine's worldTransform).
   * Shipping the authored absolute number as the child's local position added
   * the parent's position on top of it, once per level of parenting — a stepper
   * drawn inside a 200px box put its glyphs at (366,300), so inserting an item
   * scattered its parts across the scene instead of reproducing the card.
   *
   * Every part must therefore compose back INSIDE the design box.
   */
  it('every layer composes to a world position inside the design box', () => {
    const BOX = LOTTIE_DESIGN_CENTER * 2;
    for (const item of LOTTIE_ITEMS) {
      const plan = planLottieImport(item.doc);
      const byUid = new Map(plan.layers.map((l) => [l.uid, l]));
      for (const l of plan.layers) {
        // Rest position: static value, or where an animated channel settles.
        const restOf = (n: typeof l, prop: 'x' | 'y'): number => {
          const tr = n.scalarTracks.find((s) => s.prop === prop);
          return tr ? tr.keyframes[tr.keyframes.length - 1]!.value : prop === 'x' ? n.x : n.y;
        };
        let x = restOf(l, 'x');
        let y = restOf(l, 'y');
        let p = l.parentUid;
        for (let guard = 0; p !== undefined && guard < 16; guard++) {
          const q = byUid.get(p);
          if (!q) break;
          x += restOf(q, 'x');
          y += restOf(q, 'y');
          p = q.parentUid;
        }
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(BOX);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(BOX);
      }
    }
  });

  /** A parented part must land exactly where the flat design says it does. */
  it('Pill Stepper composes its capsules and glyphs onto the pill', () => {
    const plan = planLottieImport(getLottieItem('lot-pill-stepper')!.doc);
    const at = (name: string): { x: number; y: number } => {
      const l = plan.layers.find((n) => n.name === name)!;
      const byUid = new Map(plan.layers.map((n) => [n.uid, n]));
      let x = l.x;
      let y = l.y;
      let p = l.parentUid;
      for (let guard = 0; p !== undefined && guard < 16; guard++) {
        const q = byUid.get(p);
        if (!q) break;
        x += q.x;
        y += q.y;
        p = q.parentUid;
      }
      return { x, y };
    };
    expect(at('Outer Container')).toEqual({ x: 100, y: 100 });
    expect(at('Left White Capsule')).toEqual({ x: 67, y: 100 });
    expect(at('Right Dark Capsule')).toEqual({ x: 133, y: 100 });
    // Two levels deep — the level that used to be flung furthest out (234,300).
    expect(at('Minus Glyph')).toEqual({ x: 67, y: 100 });
    expect(at('Plus V Glyph')).toEqual({ x: 133, y: 100 });
  });
});
