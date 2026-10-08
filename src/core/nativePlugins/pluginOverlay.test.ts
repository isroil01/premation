/**
 * Plugin viewer overlays, page side: the engine's layer-px items drawn through
 * the layer's screen mapping, handles picked by screen distance, and a drag as
 * `dragEffectOverlay` steps.
 */

import type { OverlayPluginItem } from '@motion/engine-api';
import { cssColor, dragCommand, overlayShapes, pickHandle, DRAG_MOVE } from './pluginOverlay';

const item = (over: Partial<OverlayPluginItem>): OverlayPluginItem => ({
  effect: 'effects/fx1', kind: 'line', points: [], closed: false, color: [], handle: 0, shape: 0, ...over,
});
const double = (x: number, y: number) => ({ x: x * 2 + 10, y: y * 2 + 20 });

describe('overlayShapes', () => {
  it('maps lines, closed paths and handles to screen px', () => {
    const shapes = overlayShapes([
      item({ kind: 'line', points: [0, 0, 5, 5], color: [1, 0, 0, 1] }),
      item({ kind: 'path', points: [0, 0, 1, 0, 1, 1], closed: true }),
      item({ kind: 'handle', points: [3, 4], handle: 7, shape: 2 }),
    ], double);
    expect(shapes[0]).toEqual({ kind: 'path', d: 'M10.00 20.00L20.00 30.00', color: 'rgba(255, 0, 0, 1.000)' });
    expect(shapes[1]).toEqual({ kind: 'path', d: 'M10.00 20.00L12.00 20.00L12.00 22.00Z', color: null });
    expect(shapes[2]).toEqual({ kind: 'handle', effect: 'effects/fx1', handle: 7, shape: 2, at: { x: 16, y: 28 }, local: { x: 3, y: 4 }, color: null });
  });

  it('skips malformed items rather than drawing garbage', () => {
    expect(overlayShapes([item({ kind: 'line', points: [1] }), item({ kind: 'handle', points: [] }), item({ kind: 'blob', points: [0, 0, 1, 1] })], double)).toEqual([]);
  });
});

describe('pickHandle', () => {
  it('takes the nearest handle within the radius', () => {
    const shapes = overlayShapes([item({ kind: 'handle', points: [0, 0], handle: 1 }), item({ kind: 'handle', points: [3, 0], handle: 2 })], double);
    expect(pickHandle(shapes, { x: 15, y: 20 }, 8)?.handle).toBe(2);
    expect(pickHandle(shapes, { x: 100, y: 100 }, 8)).toBeNull();
  });
});

describe('dragCommand and cssColor', () => {
  it('builds the engine command', () => {
    expect(dragCommand('L1', 'effects/fx1', 1, { x: 5, y: 6 }, { x: 1, y: 2 }, DRAG_MOVE)).toEqual({
      type: 'dragEffectOverlay', group: { layer: 'L1', path: 'effects/fx1' }, handle: 1, x: 5, y: 6, startX: 1, startY: 2, phase: 1,
    });
  });
  it('clamps colours and defaults to the viewer colour', () => {
    expect(cssColor([2, -1, 0.5, 0.25])).toBe('rgba(255, 0, 128, 0.250)');
    expect(cssColor([])).toBeNull();
  });
});
