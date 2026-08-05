/**
 * Save/load fidelity — the round trip that no test crossed.
 *
 * Every unit here passed its own tests while the product silently lost data,
 * because the suites exercised each engine's interior and never the boundary
 * between them. `serializeTimeline` was correct AND had zero callers; the
 * timeline field on the document was declared and never assigned. So every
 * trim, split, marker and work area died on reload, and nothing went red.
 *
 * These tests assert the CONTRACT — capture(...) → restore(...) preserves what
 * a user authored. When you add authored state to the editor, add it here.
 */

import { captureDocument, restoreDocument } from './cloudDocument';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useGuidesStore } from '@stores/guidesStore';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

function node(id: string, parent: string | null = 'comp_root'): SceneNode {
  return {
    id,
    name: id,
    parent,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  };
}

function seedScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);

  const root = node('comp_root', null);
  root.children = ['layer_a', 'layer_b'];
  defaultSceneGraph.addNode(root);
  defaultSceneGraph.addNode(node('layer_a'));
  defaultSceneGraph.addNode(node('layer_b'));
}

beforeEach(() => {
  seedScene();
  getTimelineController().syncFromScene('comp_root');
});

describe('captureDocument → restoreDocument', () => {
  it('preserves the work area', () => {
    const ctrl = getTimelineController();
    ctrl.setWorkArea(1, 3);
    const before = ctrl.getWorkArea();
    expect(before).not.toBeNull();

    const doc = structuredClone(captureDocument());
    ctrl.clearWorkArea();
    expect(ctrl.getWorkArea()).toBeNull();

    restoreDocument(doc);

    expect(ctrl.getWorkArea()).toEqual(before);
  });

  it('preserves markers', () => {
    const ctrl = getTimelineController();
    ctrl.seekSeconds(2);
    ctrl.addMarkerAtPlayhead('Beat', '#ff0000');
    const before = ctrl.getMarkers();
    expect(before).toHaveLength(1);

    const doc = structuredClone(captureDocument());
    for (const m of ctrl.getMarkers()) ctrl.removeMarker(m.id);
    expect(ctrl.getMarkers()).toHaveLength(0);

    restoreDocument(doc);

    expect(ctrl.getMarkers()).toEqual(before);
  });

  it('preserves clip trims', () => {
    const ctrl = getTimelineController();
    const clip = ctrl.getLayersForNode('layer_a')[0];
    expect(clip).toBeDefined();
    ctrl.trimClipTo(clip!.id, 'end', 4);
    const before = ctrl.getLayersForNode('layer_a').map((l) => ({ start: l.start, end: l.end }));

    const doc = structuredClone(captureDocument());
    // A reload rebuilds the controller's view from the document; syncFromScene
    // must not stomp restored geometry back to full-length.
    restoreDocument(doc);

    expect(ctrl.getLayersForNode('layer_a').map((l) => ({ start: l.start, end: l.end }))).toEqual(before);
  });

  it('preserves splits (a node backing multiple clips)', () => {
    const ctrl = getTimelineController();
    const clip = ctrl.getLayersForNode('layer_b')[0];
    ctrl.splitClip(clip!.id, 5);
    const before = ctrl.getLayersForNode('layer_b').map((l) => ({ start: l.start, end: l.end }));
    expect(before).toHaveLength(2);

    const doc = structuredClone(captureDocument());
    restoreDocument(doc);

    expect(ctrl.getLayersForNode('layer_b').map((l) => ({ start: l.start, end: l.end }))).toEqual(before);
  });

  it('preserves every composition, not just the active one', () => {
    const actions = useProjectStore.getState().actions;
    actions.updateComp('comp_root', { name: 'Main', width: 1080, height: 1920, fps: 24 });
    // A second comp exists only in the comps table — the bug was that capture
    // saved `comp` (the active tab's) and every other comp reverted.
    actions.updateComp('comp_second', { name: 'Lower Third', width: 800, height: 200, fps: 60 });

    const doc = structuredClone(captureDocument());
    actions.replaceComps({});

    restoreDocument(doc);

    const comps = useProjectStore.getState().comps;
    expect(comps.comp_root).toMatchObject({ name: 'Main', width: 1080, height: 1920, fps: 24 });
    expect(comps.comp_second).toMatchObject({ name: 'Lower Third', width: 800, height: 200, fps: 60 });
  });

  it('preserves motion blur (it changes what exports look like)', () => {
    const mb = useMotionBlurStore.getState();
    mb.setEnabled(true);
    mb.setShutterAngle(90);
    mb.setSamples(16);

    const doc = structuredClone(captureDocument());
    useMotionBlurStore.getState().setShutterAngle(360);
    useMotionBlurStore.getState().setSamples(4);

    restoreDocument(doc);

    expect(useMotionBlurStore.getState().settings()).toMatchObject({ shutterAngle: 90, samples: 16 });
  });

  it('preserves guides', () => {
    useGuidesStore.getState().restore({
      rulers: true, grid: true, gridSpacing: 120, gridSubdivisions: 3, gridStyle: 'dashed',
      snapToGrid: true, proportionalGrid: true, proportionalColumns: 3, proportionalRows: 3,
      safeArea: true,
    });

    const doc = structuredClone(captureDocument());
    useGuidesStore.getState().restore({
      rulers: false, grid: false, gridSpacing: 100, gridSubdivisions: 4, gridStyle: 'lines',
      snapToGrid: false, proportionalGrid: false, proportionalColumns: 8, proportionalRows: 6,
      safeArea: false,
    });

    restoreDocument(doc);

    expect(useGuidesStore.getState().settings()).toMatchObject({
      rulers: true,
      grid: true,
      gridSpacing: 120,
      gridSubdivisions: 3,
      gridStyle: 'dashed',
      snapToGrid: true,
      proportionalGrid: true,
      proportionalColumns: 3,
      proportionalRows: 3,
      safeArea: true,
    });
  });

  /**
   * A DISABLED expression is authored state: the user switched it off and kept
   * the formula. If only the source round-trips, every disabled expression comes
   * back live on the next load — the property jumps, and the cause is a save
   * boundary rather than anything visible in the editor.
   *
   * The enabled case is asserted beside it deliberately: a round trip that
   * hard-coded `enabled: true` would pass a disabled-only test's inverse and
   * fail nothing, so both directions are pinned.
   */
  it('preserves an expression that is DISABLED, and one that is not', () => {
    defaultAnimation.clear();
    defaultAnimation.setKeyframe('layer_a', 'x', 0, 0);
    defaultAnimation.setKeyframe('layer_a', 'x', 2, 100);
    defaultAnimation.setExpression('layer_a', 'x', 'value + 200');
    defaultAnimation.setExpressionEnabled('layer_a', 'x', false);
    defaultAnimation.setExpression('layer_b', 'rotation', 'time * 90');

    const doc = structuredClone(captureDocument());
    defaultAnimation.clear();
    restoreDocument(doc);

    expect(defaultAnimation.getExpressionSrc('layer_a', 'x')).toBe('value + 200');
    expect(defaultAnimation.isExpressionEnabled('layer_a', 'x')).toBe(false);
    // Not merely "the flag survived" — the property answers its keyframes.
    expect(defaultAnimation.sample('layer_a', 'x', 1)).toBeCloseTo(50);

    expect(defaultAnimation.isExpressionEnabled('layer_b', 'rotation')).toBe(true);
    expect(defaultAnimation.sample('layer_b', 'rotation', 2)).toBeCloseTo(180);
  });

  it('migrates a legacy gridDivisions onto the PROPORTIONAL grid', () => {
    // Projects saved before the absolute/proportional split stored one
    // `gridDivisions` (cells per axis). That only ever described a
    // comp-relative division, so it must not land on the absolute grid's
    // pixel spacing — 12 cells and 12 pixels are wildly different things.
    useGuidesStore.getState().restore({ proportionalColumns: 8, proportionalRows: 6, gridSpacing: 100 });
    useGuidesStore.getState().restore({ gridDivisions: 12 } as never);

    const s = useGuidesStore.getState().settings();
    expect(s.proportionalColumns).toBe(12);
    expect(s.proportionalRows).toBe(12);
    expect(s.gridSpacing).toBe(100);
  });

  it('reads v1.0.0 documents, which carried only the active comp', () => {
    restoreDocument({
      version: '1.0.0',
      scene: { version: '1.0.0', nodes: [node('comp_root', null)] },
      animation: { tracks: {}, expressions: {} },
      comp: {
        id: 'comp_root',
        name: 'Legacy',
        width: 640,
        height: 480,
        fps: 12,
        durationSeconds: 5,
        background: '#000000',
        transparent: false,
        startFrame: 0,
      },
    });

    expect(useProjectStore.getState().comps.comp_root).toMatchObject({ name: 'Legacy', width: 640, fps: 12 });
  });

  it('survives a document with no timeline (older save)', () => {
    expect(() =>
      restoreDocument({
        version: '1.0.0',
        scene: { version: '1.0.0', nodes: [node('comp_root', null)] },
        animation: { tracks: {}, expressions: {} },
      }),
    ).not.toThrow();
  });
});
