/**
 * Layer styles through the WHOLE pipeline, not just the compiler.
 *
 * `layerStyles.render.test.ts` proves the compiler emits a structured effect.
 * This proves `buildSnapshot` actually attaches it to the emitted RenderLayer —
 * the step that was missing, and the reason a shipped, UI-complete feature drew
 * nothing for as long as it did.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { DEFAULT_DROP_SHADOW, DEFAULT_OUTER_GLOW } from '@core/effects/layerStyles';

function shapeNode(id: string, fx?: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, width: 80, height: 80 } },
      { id: `${id}_s`, type: 'Style', props: { fill: '#ff0000', opacity: 100 } },
      ...(fx ? [{ id: `${id}_fx`, type: 'fx', props: fx }] : []),
    ],
  };
}

function snapshotOf(node: SceneNode) {
  const graph = new SceneGraph();
  graph.addNode(node);
  const anim = new AnimationEngine();
  const snap = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, {
    width: 400,
    height: 300,
    background: '#000',
  });
  return snap.layers.find((l) => l.id === node.id)!;
}

describe('buildSnapshot — layer styles reach the renderer', () => {
  it('attaches a drop-shadow effect for a drop-shadow style', () => {
    const layer = snapshotOf(shapeNode('a', { layerStyles: { dropShadow: { ...DEFAULT_DROP_SHADOW } } }));
    expect(layer.effects?.map((e) => e.type)).toContain('drop-shadow');
  });

  it('attaches a glow effect for an outer-glow style', () => {
    const layer = snapshotOf(shapeNode('b', { layerStyles: { outerGlow: { ...DEFAULT_OUTER_GLOW } } }));
    expect(layer.effects?.map((e) => e.type)).toContain('glow');
  });

  it('emits no effects for a layer with no styles (no phantom entries)', () => {
    expect(snapshotOf(shapeNode('c')).effects).toBeUndefined();
  });

  it('appends styles AFTER the layer’s own effect stack, as AE evaluates them', () => {
    const layer = snapshotOf(
      shapeNode('d', {
        effects: [{ id: 'fx1', type: 'blur', params: { amount: 4 } }],
        layerStyles: { dropShadow: { ...DEFAULT_DROP_SHADOW } },
      }),
    );
    expect(layer.effects?.map((e) => e.type)).toEqual(['blur', 'drop-shadow']);
  });

  it('gives style effects STABLE ids across frames', () => {
    // Keyframe prop paths and the renderer's per-effect caching are keyed by
    // effect id; a generated id would change identity every frame.
    const node = shapeNode('e', { layerStyles: { dropShadow: { ...DEFAULT_DROP_SHADOW } } });
    const first = snapshotOf(node).effects!.find((x) => x.type === 'drop-shadow')!.id;
    const second = snapshotOf(node).effects!.find((x) => x.type === 'drop-shadow')!.id;
    expect(first).toBe(second);
    expect(first).toBe('layerstyle:dropShadow');
  });

  it('a disabled style contributes nothing', () => {
    const layer = snapshotOf(
      shapeNode('f', { layerStyles: { dropShadow: { ...DEFAULT_DROP_SHADOW, enabled: false } } }),
    );
    expect(layer.effects).toBeUndefined();
  });

  it('the layer’s CSS filter describes its own effects only, never its styles', () => {
    // Both would double-apply if a future consumer started reading `filter`.
    const layer = snapshotOf(
      shapeNode('g', {
        effects: [{ id: 'fx1', type: 'blur', params: { amount: 4 } }],
        layerStyles: { dropShadow: { ...DEFAULT_DROP_SHADOW } },
      }),
    );
    expect(layer.filter).toContain('blur');
    expect(layer.filter).not.toContain('drop-shadow');
  });
});

describe('buildSnapshot — the composition light reaches the layer', () => {
  function snapshotWithLight(node: SceneNode, light?: { angle?: number; altitude?: number }) {
    const graph = new SceneGraph();
    graph.addNode(node);
    const snap = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
      width: 400, height: 300, background: '#000',
      ...(light?.angle !== undefined ? { globalLightAngle: light.angle } : {}),
      ...(light?.altitude !== undefined ? { globalLightAltitude: light.altitude } : {}),
    });
    return snap.layers.find((l) => l.id === node.id)!;
  }

  it('a bound shadow renders at the comp light angle', () => {
    const layer = snapshotWithLight(
      shapeNode('gl1', { layerStyles: { dropShadow: { ...DEFAULT_DROP_SHADOW, useGlobalLight: true, angle: 90 } } }),
      { angle: 210 },
    );
    const fx = layer.effects!.find((e) => e.type === 'drop-shadow')!;
    expect(fx.params!.angle).toBe(210);
  });

  it('an unbound shadow ignores it', () => {
    const layer = snapshotWithLight(
      shapeNode('gl2', { layerStyles: { dropShadow: { ...DEFAULT_DROP_SHADOW, useGlobalLight: false, angle: 12 } } }),
      { angle: 210 },
    );
    expect(layer.effects!.find((e) => e.type === 'drop-shadow')!.params!.angle).toBe(12);
  });

  it('a document saved BEFORE global light existed still renders a real angle', () => {
    // No light on the comp at all — the resolver supplies the default rather
    // than letting `undefined` reach the shadow.
    const layer = snapshotWithLight(
      shapeNode('gl3', { layerStyles: { dropShadow: { ...DEFAULT_DROP_SHADOW, useGlobalLight: true } } }),
    );
    const angle = layer.effects!.find((e) => e.type === 'drop-shadow')!.params!.angle;
    expect(Number.isFinite(angle)).toBe(true);
    expect(angle).toBe(90);
  });
});
