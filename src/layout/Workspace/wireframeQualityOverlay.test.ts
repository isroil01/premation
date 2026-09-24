/**
 * The shared Quality = Wireframe geometry: which layers draw, and that each
 * host's OWN comp → canvas view places the box (the main viewport, a 2-up/4-up
 * pane, Presentation Mode all feed the same comp-space corners through
 * different views).
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { engineIdle } from '@core/engine/engineInstance';
import type { LocalEngine } from '@core/engine/LocalEngine';
import {
  isWireframeQualityLayer,
  viewToScreen,
  wireframeQuads,
  type WireframeNodeGeometry,
} from './wireframeQualityOverlay';

const identity = (p: { x: number; y: number }) => p;

const rotated: WireframeNodeGeometry = {
  id: 'wf',
  worldBounds: { x: 0, y: 0, width: 100, height: 100 },
  // A 45°-turned square: the oriented corners, not the AABB, must be drawn.
  worldCorners: [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }],
};

describe('wireframeQuads', () => {
  it('draws only wireframe-quality layers, from their oriented corners', () => {
    const plain: WireframeNodeGeometry = { id: 'best', worldBounds: { x: 0, y: 0, width: 10, height: 10 } };
    const quads = wireframeQuads([rotated, plain, undefined], identity, (id) => id === 'wf');
    expect(quads).toEqual([[{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }]]);
  });

  it('maps through each host’s own view — a pane at half scale, offset', () => {
    const pane = viewToScreen({ scale: 0.5, offsetX: 10, offsetY: 20 });
    const [quad] = wireframeQuads([rotated], pane, () => true);
    expect(quad).toEqual([{ x: 35, y: 20 }, { x: 60, y: 45 }, { x: 35, y: 70 }, { x: 10, y: 45 }]);
  });

  it('falls back to the bounds box when an adapter supplies no corners', () => {
    const box: WireframeNodeGeometry = { id: 'b', worldBounds: { x: 5, y: 6, width: 10, height: 20 } };
    expect(wireframeQuads([box], identity, () => true)).toEqual([
      [{ x: 5, y: 6 }, { x: 15, y: 6 }, { x: 15, y: 26 }, { x: 5, y: 26 }],
    ]);
  });

  it('skips a projection that is not finite (behind a camera) instead of drawing to infinity', () => {
    const behind = (p: { x: number; y: number }) => (p.x > 60 ? { x: Infinity, y: p.y } : p);
    expect(wireframeQuads([rotated], behind, () => true)).toEqual([]);
  });
});

describe('isWireframeQualityLayer', () => {
  // Built through the engine: the predicate reads the document mirror (B4),
  // which hears about a layer and its switches from the engine's events.
  let h: Harness & { engine: LocalEngine };
  beforeEach(async () => {
    h = await setupAppEngine();
  });
  afterEach(async () => {
    await h.dispose();
  });

  const add = async (name: string, visible: boolean, quality: 'best' | 'wireframe'): Promise<string> => {
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name, init: [] });
    await h.run({ type: 'setLayerSwitches', layers: [layer], patch: { visible, quality } });
    return layer;
  };

  it('is true for a visible wireframe layer, false for Best and for a hidden one', async () => {
    const on = await add('wf_on', true, 'wireframe');
    const hidden = await add('wf_hidden', false, 'wireframe');
    const best = await add('wf_best', true, 'best');
    await engineIdle();
    expect(isWireframeQualityLayer(on)).toBe(true);
    expect(isWireframeQualityLayer(hidden)).toBe(false);
    expect(isWireframeQualityLayer(best)).toBe(false);
    expect(isWireframeQualityLayer('no_such_layer')).toBe(false);
  });
});
