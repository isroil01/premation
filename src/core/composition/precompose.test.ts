/**
 * AE Pre-compose: the selection becomes a REAL composition (settings record +
 * scene root) and a comp instance takes its place in the stack — with every
 * layer where it was on screen, its clip timing intact, and (optionally) the
 * new comp trimmed to the layers' span.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readCompRef } from '@core/scene/compInstance';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readNodeBlend } from '@core/effects/blendMode';
import { defaultAnimation } from '@motion/animation';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore, type CompositionSettings, type TabInfo } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { isRealComposition } from './compNavigation';
import {
  defaultPrecompName,
  leaveAttributesUnavailableReason,
  precomposeNow,
  precomposeTargets,
  type PrecomposeOptions,
} from './precompose';
import type { SceneNode } from '@core/types';

const IDENTITY = { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } };

function comp(id: string, name: string): CompositionSettings {
  return {
    id, name, width: 1920, height: 1080, fps: 30,
    durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
  };
}

function addRoot(id: string, name: string): void {
  defaultSceneGraph.addNode({
    id, name, parent: null, children: [], visible: true, locked: false, transform: IDENTITY,
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

function addLayer(id: string, parent: string, kind = 'shape', x = 100, y = 200): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false, transform: IDENTITY,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x, y, width: 20, height: 20 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as never);
}

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

function active(): TabInfo {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId!]!;
}

function transformOf(id: string): Record<string, unknown> {
  return defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;
}

const MOVE: PrecomposeOptions = { name: 'Pre-comp 1', mode: 'move', adjustDuration: false, openNew: false };

beforeEach(() => {
  resetScene();
  const actions = useProjectStore.getState().actions;
  actions.resetTabs();
  addRoot('comp_root', 'Main');
  actions.replaceComps({ comp_root: comp('comp_root', 'Main') });
  addLayer('a', 'comp_root', 'shape', 100, 200);
  addLayer('b', 'comp_root', 'shape', 300, 400);
  addLayer('c', 'comp_root', 'image', 500, 600);
  getTimelineController().syncFromScene('comp_root');
  useSelectionStore.getState().clear();
});

describe('which layers move', () => {
  it('drops the comp root, unknown ids and layers inside another selected one', () => {
    addLayer('a_child', 'a');
    expect(precomposeTargets(['comp_root', 'ghost', 'a_child', 'a', 'c'])).toEqual(['a', 'c']);
  });

  it('names new comps Pre-comp 1, 2, …', () => {
    expect(defaultPrecompName()).toBe('Pre-comp 1');
    precomposeNow(['a'], MOVE);
    expect(defaultPrecompName()).toBe('Pre-comp 2');
  });
});

describe('Move all attributes', () => {
  it('makes a real comp the size of this one and places an instance where the layers were', () => {
    const result = precomposeNow(['a', 'c'], MOVE)!;
    expect(result).not.toBeNull();
    const { compId, instanceId } = result;

    const settings = useProjectStore.getState().comps[compId]!;
    expect(settings).toMatchObject({ name: 'Pre-comp 1', width: 1920, height: 1080, fps: 30, durationSeconds: 10 });
    expect(defaultSceneGraph.getNode(compId)?.parent).toBeNull();
    expect(isRealComposition(compId)).toBe(true);

    // The layers are now the new comp's, in the same back-to-front order…
    expect(defaultSceneGraph.getChildOrder(compId)).toEqual(['a', 'c']);
    // …and the instance took the FRONTMOST one's slot (c was above b).
    expect(defaultSceneGraph.getChildOrder('comp_root')).toEqual(['b', instanceId]);

    const instance = defaultSceneGraph.getNode(instanceId)!;
    expect(readCompRef(instance)).toBe(compId);
    expect(instance.name).toBe('Pre-comp 1');
    expect(transformOf(instanceId)).toMatchObject({ x: 960, y: 540, width: 1920, height: 1080 });

    // Same-size comp, centred instance: nothing moved on screen.
    expect(transformOf('a')).toMatchObject({ x: 100, y: 200 });
    expect(transformOf('c')).toMatchObject({ x: 500, y: 600 });

    expect(useSelectionStore.getState().ids).toEqual([instanceId]);
    expect(active().compositionId).toBe('comp_root');
  });

  it('carries each layer’s clip timing into the new comp', () => {
    const controller = getTimelineController();
    controller.timeline.setLayerStart(controller.getLayersForNode('a')[0]!.id, 45);
    const { compId } = precomposeNow(['a'], MOVE)!;
    expect(controller.compIdForNode('a')).toBe(compId);
    expect(controller.getLayersForNode('a')[0]!.start).toBe(45);
  });

  it('trims the new comp to the layers’ span and starts the instance bar there', () => {
    const controller = getTimelineController();
    controller.timeline.setLayerStart(controller.getLayersForNode('a')[0]!.id, 30);
    controller.timeline.setLayerStart(controller.getLayersForNode('c')[0]!.id, 60);
    const bars = ['a', 'c'].map((id) => controller.getLayersForNode(id)[0]!);
    const start = Math.min(...bars.map((l) => l.start));
    const end = Math.max(...bars.map((l) => l.start + l.duration));
    const before = Object.fromEntries(bars.map((l) => [l.sourceId, l.start]));

    const { compId, instanceId } = precomposeNow(['a', 'c'], { ...MOVE, adjustDuration: true })!;

    expect(useProjectStore.getState().comps[compId]!.durationSeconds * 30).toBeCloseTo(end - start, 5);
    expect(controller.getLayersForNode('a')[0]!.start).toBe(before.a! - start);
    expect(controller.getLayersForNode('c')[0]!.start).toBe(before.c! - start);
    expect(controller.getLayersForNode(instanceId)[0]!.start).toBe(start);
  });

  // "Opens the new composition when asked, with a navigator trail back" is the engine route's now
  // (compositionEdits.test.ts: precomposeEdit + openNew) — navigation reads the document mirror, which a
  // bare scene-graph fixture does not feed (B4 round 5).

  it('does nothing for a selection with no layers of this comp', () => {
    expect(precomposeNow(['comp_root', 'ghost'], MOVE)).toBeNull();
    expect(Object.keys(useProjectStore.getState().comps)).toEqual(['comp_root']);
  });
});

function addPhoto(id: string, extra: Record<string, unknown> = {}, fx?: Record<string, unknown>): void {
  defaultSceneGraph.addChild('comp_root', {
    id, name: id, parent: 'comp_root', children: [], visible: true, locked: false, transform: IDENTITY,
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'image', x: 700, y: 300, rotation: 30, scaleX: 2, scaleY: 2,
          anchorX: 0, anchorY: 0, width: 400, height: 250, src: 'photo.png', assetId: 'asset_1', ...extra,
        },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 50 } },
      ...(fx ? [{ id: `${id}_fx`, type: 'fx', props: fx }] : []),
    ],
  } as never);
}

const LEAVE: PrecomposeOptions = { ...MOVE, mode: 'leave' };

describe('Leave all attributes', () => {
  afterEach(() => {
    for (const id of ['photo', 'solid']) defaultAnimation.clearNode(id);
  });

  it('moves only the content into a comp the layer’s size; the layer keeps its id, slot and attributes', () => {
    addPhoto('photo', {}, { blendMode: 'multiply' });
    getTimelineController().syncFromScene('comp_root');
    defaultAnimation.setKeyframes('photo', 'x', [{ time: 0, value: 700 }, { time: 1, value: 900 }] as never);
    const orderBefore = defaultSceneGraph.getChildOrder('comp_root');

    const { compId, instanceId } = precomposeNow(['photo'], LEAVE)!;

    // The layer IS the composition layer now — same id, same place in the stack.
    expect(instanceId).toBe('photo');
    expect(defaultSceneGraph.getChildOrder('comp_root')).toEqual(orderBefore);
    const layer = defaultSceneGraph.getNode('photo')!;
    expect(readCompRef(layer)).toBe(compId);
    expect(readNodeKind(layer)).toBe('comp');
    expect(layer.name).toBe('Pre-comp 1');
    expect(transformOf('photo')).toMatchObject({ x: 700, y: 300, rotation: 30, scaleX: 2, scaleY: 2 });
    expect(transformOf('photo').src).toBeUndefined();
    expect(transformOf('photo').assetId).toBeUndefined();
    expect(readNodeBlend(layer)).toBe('multiply');
    expect(defaultAnimation.tracksFor('photo').map((t) => t.prop)).toContain('x');

    // The comp is the layer's size, and holds the content untransformed.
    expect(useProjectStore.getState().comps[compId]).toMatchObject({ width: 400, height: 250 });
    const inner = defaultSceneGraph.getChildren(compId);
    expect(inner).toHaveLength(1);
    const content = inner[0]!;
    expect(readNodeKind(content)).toBe('image');
    expect(transformOf(content.id)).toMatchObject({
      x: 200, y: 125, rotation: 0, scaleX: 1, scaleY: 1,
      width: 400, height: 250, src: 'photo.png', assetId: 'asset_1',
    });
    expect(defaultAnimation.tracksFor(content.id)).toHaveLength(0);
  });

  it('takes a solid’s colour, and its colour animation, with the content', () => {
    defaultSceneGraph.addChild('comp_root', {
      id: 'solid', name: 'Solid', parent: 'comp_root', children: [], visible: true, locked: false, transform: IDENTITY,
      components: [
        { id: 'solid_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 960, y: 540, width: 1920, height: 1080 } },
        { id: 'solid_s', type: 'Style', props: { opacity: 100 } },
        { id: 'solid_fx', type: 'fx', props: { solid: true, fill: { type: 'solid', color: '#ff0000' } } },
      ],
    } as never);
    defaultAnimation.setKeyframes('solid', 'fill_r', [{ time: 0, value: 0 }, { time: 1, value: 255 }] as never);
    defaultAnimation.setKeyframes('solid', 'opacity', [{ time: 0, value: 0 }, { time: 1, value: 100 }] as never);

    const { compId } = precomposeNow(['solid'], LEAVE)!;

    const content = defaultSceneGraph.getChildren(compId)[0]!;
    const innerFx = content.components.find((c) => c.type === 'fx')!.props as Record<string, unknown>;
    expect(innerFx).toMatchObject({ solid: true, fill: { type: 'solid', color: '#ff0000' } });
    const outerFx = defaultSceneGraph.getNode('solid')!.components.find((c) => c.type === 'fx')!.props as Record<string, unknown>;
    expect(outerFx.solid).toBeUndefined();
    expect(outerFx.fill).toBeUndefined();
    expect(defaultAnimation.tracksFor(content.id).map((t) => t.prop)).toEqual(['fill_r']);
    expect(defaultAnimation.tracksFor('solid').map((t) => t.prop)).toEqual(['opacity']);
  });

  it('is offered for one footage-like layer and refused for what a comp layer would render differently', () => {
    expect(leaveAttributesUnavailableReason(['c'])).toBeNull();
    expect(leaveAttributesUnavailableReason(['a'])).toMatch(/shape/);
    expect(leaveAttributesUnavailableReason(['a', 'c'])).toMatch(/single layer/);

    addPhoto('p3d', { z: 0 });
    expect(leaveAttributesUnavailableReason(['p3d'])).toMatch(/3D/);
    // A composition layer turns around its anchor like any layer, so an
    // off-centre anchor no longer blocks it.
    addPhoto('pAnchor', { anchorX: 12 });
    expect(leaveAttributesUnavailableReason(['pAnchor'])).toBeNull();
    // A composition layer motion-blurs like any layer, so this no longer blocks it.
    addPhoto('pBlur', {}, { motionBlur: true });
    expect(leaveAttributesUnavailableReason(['pBlur'])).toBeNull();
    addPhoto('pParent');
    addLayer('kid', 'pParent');
    expect(leaveAttributesUnavailableReason(['pParent'])).toMatch(/parented/);

    // …and a refused Leave does nothing at all.
    expect(precomposeNow(['p3d'], LEAVE)).toBeNull();
    expect(Object.keys(useProjectStore.getState().comps)).toEqual(['comp_root']);
  });
});
