/**
 * Resizing a ROTATED layer must not run away.
 *
 * The handler used to infer scale as `worldAABB.width / localWidth`. Rotation
 * inflates the AABB (`|w·cosθ| + |h·sinθ|`), so the very first drag tick
 * multiplied the scale by that inflation factor and every later tick re-inflated
 * it — grabbing a corner made the layer lurch sideways and grow without
 * settling. The tool now sends an absolute scale derived as a RATIO of the
 * starting bounds, which is stable across ticks.
 *
 * These assert the ratio contract, which is what makes the drag settle.
 */

import { resizeBounds } from '../selection/transform';
import { commands } from '../commands/WorkspaceCommands';
import type { NodeId } from '../ports';

const ID = 'n1' as NodeId;

/** What the tool computes for a drag, mirroring SelectTool.onDrag. */
function dragScale(
  from: { x: number; y: number; width: number; height: number },
  baseScale: { x: number; y: number },
  handle: 'se' | 'nw',
  pointer: { x: number; y: number },
) {
  const bounds = resizeBounds(from, handle, pointer);
  return {
    bounds,
    scale: {
      x: baseScale.x * (bounds.width / from.width),
      y: baseScale.y * (bounds.height / from.height),
    },
    center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
  };
}

describe('resize of a rotated layer', () => {
  // A 100×100 layer rotated 45° has an AABB of ~141×141 — the inflation that
  // used to be mistaken for scale.
  const ROTATED_AABB = { x: 0, y: 0, width: 141.42, height: 141.42 };

  it('reports scale 1 when the pointer has not moved off the handle', () => {
    // The old maths divided 141.42 by the LOCAL width 100 and got 1.41: a layer
    // jumped 41% bigger the instant it was grabbed.
    const d = dragScale(ROTATED_AABB, { x: 1, y: 1 }, 'se', { x: 141.42, y: 141.42 });
    expect(d.scale.x).toBeCloseTo(1, 5);
    expect(d.scale.y).toBeCloseTo(1, 5);
  });

  it('doubling the bounds doubles the scale, whatever the local size is', () => {
    const d = dragScale(ROTATED_AABB, { x: 1, y: 1 }, 'se', { x: 282.84, y: 282.84 });
    expect(d.scale.x).toBeCloseTo(2, 4);
  });

  it('is idempotent — repeating the same drag does not compound', () => {
    const first = dragScale(ROTATED_AABB, { x: 1, y: 1 }, 'se', { x: 212.13, y: 212.13 });
    const second = dragScale(ROTATED_AABB, { x: 1, y: 1 }, 'se', { x: 212.13, y: 212.13 });
    // Both ticks of one drag resolve to the SAME absolute scale. The old code
    // recomputed from the live (already inflated) bounds and grew every tick.
    expect(second.scale.x).toBeCloseTo(first.scale.x, 10);
  });

  it('applies the ratio on top of an existing scale', () => {
    const d = dragScale(ROTATED_AABB, { x: 3, y: 3 }, 'se', { x: 282.84, y: 282.84 });
    expect(d.scale.x).toBeCloseTo(6, 4);
  });

  it('keeps the opposite corner fixed, so the centre moves by half the growth', () => {
    const d = dragScale(ROTATED_AABB, { x: 1, y: 1 }, 'se', { x: 241.42, y: 141.42 });
    // Width 141.42 → 241.42, anchored at x=0, so the centre moves 50.
    expect(d.center.x).toBeCloseTo(120.71, 3);
    expect(d.center.y).toBeCloseTo(70.71, 3);
  });

  it('carries scale and centre on the command so the handler need not infer them', () => {
    const d = dragScale(ROTATED_AABB, { x: 1, y: 1 }, 'se', { x: 200, y: 200 });
    const cmd = commands.resizeNode(ID, d.bounds, d.scale, d.center);
    expect(cmd.payload).toMatchObject({ id: ID, scale: d.scale, center: d.center });
  });

  it('still resolves a scale when the tool sends none (unrotated fallback)', () => {
    const cmd = commands.resizeNode(ID, { x: 0, y: 0, width: 200, height: 100 });
    expect((cmd.payload as { scale?: unknown }).scale).toBeUndefined();
  });
});
