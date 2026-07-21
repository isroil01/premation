/**
 * Rig Logo — decision logic + starter rig + honest rig-tool gating.
 *
 * The GPU rasterize never runs in jest (no WebGL/canvas), so the rasterize seam
 * is injected. These tests cover the branch that MATTERS: when we rig in place
 * vs. when we rasterize, that a starter rig lands, and that the AI rig handlers
 * reject un-riggable (group/precomp) targets.
 */

import SceneGraph from './SceneGraph';
import { SCENE_KIND_PROP, type SceneKind } from './seedDefaultScene';
import {
  resolveRigTarget,
  starterPuppetPins,
  isRiggableKind,
  isRiggableLeafNode,
  rigLogoForAnimation,
  type RasterResult,
} from './rigLogo';
import type { SceneNode } from '@core/types';

// ── Test scene helpers ─────────────────────────────────────────────

function makeNode(id: string, kind: SceneKind, opts: { x?: number; y?: number; w?: number; h?: number } = {}): SceneNode {
  const x = opts.x ?? 0;
  const y = opts.y ?? 0;
  const components: SceneNode['components'] =
    kind === 'group'
      ? [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }]
      : [
          {
            id: `${id}_t`,
            type: 'Transform',
            props: { [SCENE_KIND_PROP]: kind, x, y, width: opts.w ?? 100, height: opts.h ?? 100, rotation: 0, scaleX: 1, scaleY: 1 },
          },
          { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
        ];
  return {
    id,
    name: id,
    parent: null,
    children: [],
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components,
  };
}

function readPuppet(graph: SceneGraph, id: string): { pins: Array<{ id: string; name: string; x: number; y: number }> } | undefined {
  const node = graph.getNode(id);
  const fx = node?.components.find((c) => c.type === 'fx');
  return fx?.props.puppet as { pins: Array<{ id: string; name: string; x: number; y: number }> } | undefined;
}

const noopDeps = () => ({
  setSelection: jest.fn(),
  setActiveTool: jest.fn(),
  notify: jest.fn(),
});

// ── Kind predicates ────────────────────────────────────────────────

describe('riggable-kind predicates', () => {
  it('shape/image/text are riggable; group/null/camera are not', () => {
    expect(isRiggableKind('shape')).toBe(true);
    expect(isRiggableKind('image')).toBe(true);
    expect(isRiggableKind('text')).toBe(true);
    expect(isRiggableKind('group')).toBe(false);
    expect(isRiggableKind('null')).toBe(false);
    expect(isRiggableKind('camera')).toBe(false);
  });

  it('isRiggableLeafNode follows the kind for a single node', () => {
    const g = new SceneGraph();
    const shape = makeNode('s1', 'shape');
    const group = makeNode('g1', 'group');
    g.addNode(shape);
    g.addNode(group);
    expect(isRiggableLeafNode(g.getNode('s1'), g)).toBe(true);
    expect(isRiggableLeafNode(g.getNode('g1'), g)).toBe(false);
    expect(isRiggableLeafNode(undefined, g)).toBe(false);
  });
});

// ── resolveRigTarget decision ──────────────────────────────────────

describe('resolveRigTarget', () => {
  it('a single image/shape LEAF rigs in place (no rasterize)', () => {
    const g = new SceneGraph();
    g.addNode(makeNode('img', 'image'));
    g.addNode(makeNode('shp', 'shape'));
    expect(resolveRigTarget(['img'], g)).toEqual({ mode: 'self', targetId: 'img' });
    expect(resolveRigTarget(['shp'], g)).toEqual({ mode: 'self', targetId: 'shp' });
  });

  it('a group (multi-part logo) rasterizes', () => {
    const g = new SceneGraph();
    g.addNode(makeNode('logo', 'group'));
    g.addChild('logo', makeNode('p1', 'shape', { x: 0 }));
    g.addChild('logo', makeNode('p2', 'shape', { x: 200 }));
    const d = resolveRigTarget(['logo'], g);
    expect(d).toEqual({ mode: 'rasterize', roots: ['logo'] });
  });

  it('a multi-selection of shapes rasterizes as one piece', () => {
    const g = new SceneGraph();
    g.addNode(makeNode('a', 'shape'));
    g.addNode(makeNode('b', 'shape'));
    const d = resolveRigTarget(['a', 'b'], g);
    expect(d).toEqual({ mode: 'rasterize', roots: ['a', 'b'] });
  });

  it('a shape that has children is NOT a plain leaf → rasterize', () => {
    const g = new SceneGraph();
    g.addNode(makeNode('parent', 'shape'));
    g.addChild('parent', makeNode('child', 'shape'));
    expect(resolveRigTarget(['parent'], g)).toEqual({ mode: 'rasterize', roots: ['parent'] });
  });

  it('empty selection → null', () => {
    const g = new SceneGraph();
    expect(resolveRigTarget([], g)).toBeNull();
  });
});

// ── Starter rig ────────────────────────────────────────────────────

describe('starterPuppetPins', () => {
  it('drops an anchor (bottom-center) and a wave mover (top-center) in local space', () => {
    const rig = starterPuppetPins(200, 100);
    expect(rig.pins).toHaveLength(2);
    expect(rig.pins[0]).toMatchObject({ name: 'Anchor', x: 0, y: 50 });
    expect(rig.pins[1]).toMatchObject({ name: 'Wave', x: 0, y: -50 });
    // Author-time id convention: pin_<ts>_<i>
    expect(rig.pins[0]!.id).toMatch(/^pin_\d+_0$/);
    expect(rig.pins[1]!.id).toMatch(/^pin_\d+_1$/);
  });
});

// ── Orchestrator: rigLogoForAnimation ──────────────────────────────

describe('rigLogoForAnimation', () => {
  it('single leaf → rigs in place, never rasterizes', async () => {
    const g = new SceneGraph();
    g.addNode(makeNode('img', 'image', { w: 300, h: 120 }));
    const rasterize = jest.fn<Promise<RasterResult | null>, unknown[]>();
    const d = noopDeps();

    await rigLogoForAnimation({
      graph: g,
      getSelection: () => ['img'],
      rasterize: rasterize as never,
      ...d,
    });

    expect(rasterize).not.toHaveBeenCalled();
    expect(readPuppet(g, 'img')?.pins).toHaveLength(2);
    expect(d.setActiveTool).toHaveBeenCalledWith('puppet-pin');
    expect(d.setSelection).toHaveBeenCalledWith(['img']);
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'success' }));
  });

  it('group → rasterizes, inserts an image layer, and rigs THAT with a starter rig', async () => {
    const g = new SceneGraph();
    g.addNode(makeNode('logo', 'group'));
    g.addChild('logo', makeNode('p1', 'shape', { x: -50 }));
    g.addChild('logo', makeNode('p2', 'shape', { x: 50 }));

    let sel: string[] = ['logo'];
    const rasterize = jest.fn(async () => ({
      dataUrl: 'data:image/png;base64,AAAA',
      compWidth: 220,
      compHeight: 110,
      centerX: 0,
      centerY: 0,
      name: 'logo (Rigged)',
    }));
    const addAsset = jest.fn(async () => ({ id: 'asset_1', name: 'logo (Rigged).png', type: 'image' as const, src: 'blob:x', size: 4 }));
    const insertMedia = jest.fn(async () => {
      // Mirror the real insertMedia: create an image layer + select it.
      g.addNode(makeNode('newimg', 'image', { w: 220, h: 110 }));
      sel = ['newimg'];
    });
    const toFile = jest.fn(async () => new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' }));
    const d = noopDeps();

    await rigLogoForAnimation({
      graph: g,
      getSelection: () => sel,
      rasterize,
      addAsset,
      insertMedia,
      toFile,
      ...d,
    });

    expect(rasterize).toHaveBeenCalledTimes(1);
    expect(addAsset).toHaveBeenCalledTimes(1);
    expect(insertMedia).toHaveBeenCalledTimes(1);
    // The NEW image layer carries the starter rig, not the group.
    expect(readPuppet(g, 'newimg')?.pins).toHaveLength(2);
    expect(readPuppet(g, 'logo')).toBeUndefined();
    expect(d.setActiveTool).toHaveBeenCalledWith('puppet-pin');
  });

  it('no selection → notifies and does nothing', async () => {
    const g = new SceneGraph();
    const rasterize = jest.fn();
    const d = noopDeps();
    await rigLogoForAnimation({ graph: g, getSelection: () => [], rasterize: rasterize as never, ...d });
    expect(rasterize).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  });

  it('rasterize returning null (media not decoded) → error notify, no throw', async () => {
    const g = new SceneGraph();
    g.addNode(makeNode('logo', 'group'));
    g.addChild('logo', makeNode('p1', 'shape'));
    const d = noopDeps();
    await rigLogoForAnimation({
      graph: g,
      getSelection: () => ['logo'],
      rasterize: async () => null,
      ...d,
    });
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });
});
