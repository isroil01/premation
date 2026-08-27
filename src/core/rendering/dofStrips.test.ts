import { dofBlurPx, type DofConfig } from '@core/scene/camera3d';
import { planDofStrips, planDofCocCorners, layerCornerDepths } from './dofStrips';

describe('dofStrips', () => {
  const dof: DofConfig = { strength: 40, focus: 1000, aperture: 50 };

  it('returns null when blur span is tiny', () => {
    // Identity-ish matrix; flat depths
    const m = [100, 0, 0, 100, 0, 0] as const;
    const plan = planDofStrips(m, [1000, 1000, 1000, 1000], dof);
    expect(plan).toBeNull();
  });

  it('splits along the dominant depth axis', () => {
    const m = [200, 0, 0, 100, 50, 50] as const;
    // Strong left→right depth gradient
    const plan = planDofStrips(m, [500, 2000, 2000, 500], dof, 6);
    expect(plan).not.toBeNull();
    expect(plan!.length).toBeGreaterThanOrEqual(2);
    // U strips: full V, partial U
    expect(plan![0]!.uvRect.height).toBe(1);
    expect(plan![0]!.uvRect.width).toBeLessThan(1);
    // Blur radii should vary across strips
    const blurs = plan!.map((p) => p.blurPx);
    expect(Math.max(...blurs) - Math.min(...blurs)).toBeGreaterThan(1);
  });

  it('uses a 2D CoC grid when both axes span meaningful blur', () => {
    const m = [200, 0, 0, 200, 0, 0] as const;
    // Depth ramps in U and V (tilted card).
    const plan = planDofStrips(m, [400, 1800, 2200, 900], dof, 8);
    expect(plan).not.toBeNull();
    expect(plan!.length).toBeGreaterThanOrEqual(4);
    const tall = plan!.filter((p) => p.uvRect.height < 1 && p.uvRect.width < 1);
    expect(tall.length).toBe(plan!.length);
  });

  it('dofBlurPx still drives strip radii', () => {
    const near = dofBlurPx(500, dof);
    const far = dofBlurPx(2000, dof);
    expect(far).toBeGreaterThan(near);
  });

  it('layerCornerDepths projects four corners', () => {
    // Identity world: local = world
    const I = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
    const depths = layerCornerDepths(I, 100, 50, (p) => ({ depth: 1000 + p.z + p.x * 0.01 }));
    expect(depths).not.toBeNull();
    expect(depths!).toHaveLength(4);
  });
});

describe('planDofCocCorners', () => {
  const dof: DofConfig = { strength: 40, focus: 1000, aperture: 50 };

  it('returns null when blur is uniform', () => {
    expect(planDofCocCorners([1000, 1000, 1000, 1000], dof)).toBeNull();
  });

  it('exposes four corner radii and a max for a depth-spanning plane', () => {
    const plan = planDofCocCorners([500, 2000, 2000, 500], dof);
    expect(plan).not.toBeNull();
    expect(plan!.corners).toHaveLength(4);
    expect(plan!.maxPx).toBe(Math.max(...plan!.corners));
    expect(plan!.maxPx - Math.min(...plan!.corners)).toBeGreaterThanOrEqual(1.25);
  });
});
