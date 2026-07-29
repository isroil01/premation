/**
 * Document capability analysis — Phase 5: unified GPU engine.
 *
 * The old backend-capability tables (Canvas2D vs GPU) and backend-picking
 * functions have been removed. This file tests the remaining public API:
 *   - analyzeDocument correctly detects which features a document uses.
 */

import { analyzeDocument } from './capabilities';
import SceneGraph from '@core/scene/SceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

function node(id: string, kind: string, fx?: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind } },
      ...(fx ? [{ id: `${id}_fx`, type: 'fx', props: fx }] : []),
    ],
  } as unknown as SceneNode;
}

function graphOf(...nodes: SceneNode[]): SceneGraph {
  const g = new SceneGraph();
  for (const n of nodes) g.addNode(n);
  return g;
}

describe('analyzeDocument', () => {
  it('finds nothing in a plain shape document', () => {
    expect(analyzeDocument(graphOf(node('a', 'shape')))).toEqual({
      gpuEffects: false, adjustmentLayers: false, trackMattes: false, lights: false, textStyling: false, colorLut: false,
      canvas2dEffects: false, frameBlending: false, motionBlur: false, spatialAdjustments: false,
    });
  });

  it('detects frame blending', () => {
    const g = graphOf(node('a', 'video', {
      time: { stretch: 200, reverse: false, freeze: false, freezeTime: 0, frameBlend:'mix' },
    }));
    expect(analyzeDocument(g).frameBlending).toBe(true);
  });

  it('does not flag frame blending when it is off', () => {
    const g = graphOf(node('a', 'video', {
      time: { stretch: 200, reverse: false, freeze: false, freezeTime: 0, frameBlend:'none' },
    }));
    expect(analyzeDocument(g).frameBlending).toBe(false);
  });

  it('detects adjustment layers', () => {
    expect(analyzeDocument(graphOf(node('a', 'shape', { isAdjustment: true }))).adjustmentLayers).toBe(true);
  });

  it('detects track mattes', () => {
    const g = graphOf(node('a', 'shape', { matte: { mode: 'alpha', sourceId: 'b' } }));
    expect(analyzeDocument(g).trackMattes).toBe(true);
  });

  it('detects lights and text', () => {
    expect(analyzeDocument(graphOf(node('l', 'light'))).lights).toBe(true);
    expect(analyzeDocument(graphOf(node('t', 'text'))).textStyling).toBe(true);
  });

  it('detects GPU-only effects but ignores CSS ones', () => {
    const gpu = graphOf(node('a', 'shape', { effects: [{ id: 'e1', type: 'displacement-map', amount: 10 }] }));
    const proc = graphOf(node('a', 'shape', { effects: [{ id: 'e1', type: 'fractal-noise', amount: 10 }] }));
    const css = graphOf(node('a', 'shape', { effects: [{ id: 'e1', type: 'blur', amount: 10 }] }));
    expect(analyzeDocument(gpu).gpuEffects).toBe(true);
    expect(analyzeDocument(proc).gpuEffects).toBe(false);
    expect(analyzeDocument(css).gpuEffects).toBe(false);
  });

  it('ignores a disabled GPU effect', () => {
    const g = graphOf(node('a', 'shape', { effects: [{ id: 'e1', type: 'displacement-map', amount: 10, enabled: false }] }));
    expect(analyzeDocument(g).gpuEffects).toBe(false);
  });

  it('detects per-layer motion blur — unless the comp toggle is off', () => {
    const g = graphOf(node('a', 'shape', { motionBlur: true }));
    expect(analyzeDocument(g).motionBlur).toBe(true);
    expect(analyzeDocument(g, { motionBlurEnabled: false }).motionBlur).toBe(false);
    expect(analyzeDocument(graphOf(node('a', 'shape'))).motionBlur).toBe(false);
  });

  it('distinguishes spatial from colour-grade adjustment layers', () => {
    const spatial = graphOf(node('a', 'adjustment', {
      isAdjustment: true, effects: [{ id: 'e1', type: 'blur', amount: 10 }],
    }));
    const grade = graphOf(node('a', 'adjustment', {
      isAdjustment: true, effects: [{ id: 'e1', type: 'tint', amount: 50 }],
    }));
    expect(analyzeDocument(spatial).spatialAdjustments).toBe(true);
    expect(analyzeDocument(grade).spatialAdjustments).toBe(false);
    const normal = graphOf(node('a', 'shape', { effects: [{ id: 'e1', type: 'blur', amount: 10 }] }));
    expect(analyzeDocument(normal).spatialAdjustments).toBe(false);
  });
});
