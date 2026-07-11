import { SnapEngine } from '../snap/SnapEngine';
import * as R from '../math/Rect';

describe('SnapEngine', () => {
  it('snaps a point to the nearest grid line within threshold', () => {
    const engine = new SnapEngine();
    const targets = SnapEngine.gridTargets(R.rect(0, 0, 100, 100), 10);
    const result = engine.snapPoint({ x: 22, y: 48 }, targets, 3);
    expect(result.snapped).toBe(true);
    expect(result.value).toEqual({ x: 20, y: 50 });
    expect(result.delta).toEqual({ x: -2, y: 2 });
  });

  it('does not snap outside the threshold', () => {
    const engine = new SnapEngine();
    const targets = SnapEngine.gridTargets(R.rect(0, 0, 100, 100), 10);
    const result = engine.snapPoint({ x: 25, y: 25 }, targets, 3);
    expect(result.snapped).toBe(false);
    expect(result.value).toEqual({ x: 25, y: 25 });
  });

  it('snaps a rect edge to an object edge and reports a line', () => {
    const engine = new SnapEngine();
    const other = R.rect(200, 0, 100, 100); // left edge at x=200
    const targets = SnapEngine.objectTargets([other]);
    const moving = R.rect(97, 0, 100, 40); // right edge at x=197, near 200
    const result = engine.snapRect(moving, targets, 5);
    expect(result.snapped).toBe(true);
    // Right edge (197) snaps to 200 → delta +3.
    expect(result.delta.x).toBeCloseTo(3);
    expect(result.lines.some((l) => l.axis === 'x' && Math.abs(l.position - 200) < 1e-6)).toBe(true);
  });

  it('snaps centers when enabled', () => {
    const engine = new SnapEngine();
    engine.setSettings({ toEdges: false, toCenters: true });
    const other = R.rect(0, 0, 100, 100); // edges x=0,100; center x=50
    const targets = SnapEngine.objectTargets([other]);
    // left edge at 38 (no target within 5), center at 48 → snaps to 50.
    const moving = R.rect(38, 200, 20, 20);
    const result = engine.snapRect(moving, targets, 5);
    expect(result.delta.x).toBeCloseTo(2); // 48 → 50
  });

  it('respects source toggles', () => {
    const engine = new SnapEngine();
    engine.setSettings({ toGrid: false });
    const targets = SnapEngine.gridTargets(R.rect(0, 0, 100, 100), 10);
    const result = engine.snapPoint({ x: 21, y: 21 }, targets, 3);
    expect(result.snapped).toBe(false);
  });

  it('returns identity when disabled', () => {
    const engine = new SnapEngine();
    engine.setSettings({ enabled: false });
    const targets = SnapEngine.gridTargets(R.rect(0, 0, 100, 100), 10);
    const result = engine.snapPoint({ x: 20.5, y: 20.5 }, targets, 5);
    expect(result.snapped).toBe(false);
    expect(result.value).toEqual({ x: 20.5, y: 20.5 });
  });
});
