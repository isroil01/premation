import { Grid } from '../grid/Grid';
import { Guides } from '../guides/Guides';
import * as R from '../math/Rect';

describe('Grid', () => {
  it('keeps on-screen spacing near the target as zoom changes', () => {
    const grid = new Grid({ baseSize: 10, targetScreenSpacing: 24 });
    for (const zoom of [0.1, 0.5, 1, 3, 12]) {
      const spacing = grid.adaptiveSpacing(zoom);
      const screen = spacing * zoom;
      // Within one 1-2-5 step of the target (roughly 0.4×–2.5×).
      expect(screen).toBeGreaterThan(24 * 0.4);
      expect(screen).toBeLessThan(24 * 2.6);
    }
  });

  it('snaps spacing to the 1-2-5 progression', () => {
    const grid = new Grid({ baseSize: 1, targetScreenSpacing: 20 });
    const spacing = grid.adaptiveSpacing(1);
    const mantissa = spacing / Math.pow(10, Math.floor(Math.log10(spacing)));
    expect([1, 2, 5, 10].some((c) => Math.abs(mantissa - c) < 1e-6)).toBe(true);
  });

  it('computes only the visible lines', () => {
    const grid = new Grid({ baseSize: 10, majorEvery: 5, targetScreenSpacing: 20 });
    const lines = grid.computeLines(R.rect(0, 0, 100, 100), 2);
    const allV = [...lines.verticalsMinor, ...lines.verticalsMajor];
    for (const x of allV) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
    }
    // Major lines land on multiples of majorSpacing.
    for (const x of lines.verticalsMajor) {
      expect(Math.abs(x % lines.majorSpacing)).toBeLessThan(1e-6);
    }
  });
});

describe('Guides', () => {
  it('adds, moves, and removes user guides', () => {
    const guides = new Guides();
    const g = guides.add('x', 100);
    expect(guides.verticalPositions()).toContain(100);
    expect(guides.move(g.id, 150)).toBe(true);
    expect(guides.get(g.id)?.position).toBe(150);
    expect(guides.remove(g.id)).toBe(true);
    expect(guides.list()).toHaveLength(0);
  });

  it('locks a guide against move/remove', () => {
    const guides = new Guides();
    const g = guides.add('y', 50);
    guides.setLocked(g.id, true);
    expect(guides.move(g.id, 80)).toBe(false);
    expect(guides.remove(g.id)).toBe(false);
    expect(guides.get(g.id)?.position).toBe(50);
  });

  it('derives center and safe-area guides from a frame', () => {
    const guides = new Guides();
    guides.setFrame(R.rect(0, 0, 1000, 500), 0.1);
    const centers = guides.list().filter((x) => x.kind === 'center');
    expect(centers.find((c) => c.axis === 'x')?.position).toBe(500);
    expect(centers.find((c) => c.axis === 'y')?.position).toBe(250);
    const safe = guides.list().filter((x) => x.kind === 'safe-area');
    expect(safe.map((s) => s.position).sort((a, b) => a - b)).toEqual([50, 100, 450, 900]);
    // Derived guides are locked.
    expect(safe.every((s) => s.locked)).toBe(true);
  });

  it('emits change events', () => {
    const guides = new Guides();
    const added: string[] = [];
    guides.events.on('added', ({ guide }) => added.push(guide.id));
    const g = guides.add('x', 10);
    expect(added).toEqual([g.id]);
  });
});
