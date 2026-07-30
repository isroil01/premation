/**
 * Which views carry the composition background across the whole viewport.
 *
 * The defect: every non-camera view (the six ortho views and the three custom
 * views) emitted `backdrop: false`, and BackgroundPass took that as "paint
 * nothing". Switching a comp to Left/Right/Top/Bottom/Front/Back therefore
 * discarded its background colour — the view showed layers over bare pasteboard
 * grey, and a black comp was indistinguishable from a white one. Only Active
 * Camera ever showed the colour.
 *
 * These assert the PLUMBING end to end: comp view mode → RenderSnapshot →
 * FrameScene. The coverage each mode actually paints is measured separately, in
 * packages/renderer/src/__tests__/backgroundPass.test.ts.
 */

import { buildSnapshot } from './buildSnapshot';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { Project3D } from '@motion/scene';
import type { SceneNode } from '@core/types';
import type { SnapshotComp } from './buildSnapshot';

const COMP: SnapshotComp = { width: 800, height: 600, background: '#101014' };

/** The six axis views AE offers, which is the full `OrthoView` union. */
const ORTHO_VIEWS: Project3D.OrthoView[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

function shape(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, width: 200, height: 200 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

function build(comp: SnapshotComp) {
  const g = new SceneGraph();
  g.addNode(shape('box'));
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp);
}

describe('composition backdrop per view', () => {
  it.each(ORTHO_VIEWS)('%s view fills the viewport with the comp background', (view) => {
    const snap = build({ ...COMP, camera3dMode: view });
    expect(snap.backdrop).toBe('viewport');
    expect(snapshotToFrameScene(snap).composition.backdrop).toBe('viewport');
  });

  it('a custom view fills the viewport too', () => {
    const snap = build({
      ...COMP,
      camera3dMode: 'active',
      customViewCamera: Project3D.defaultCamera(COMP.width, COMP.height),
    });
    expect(snap.backdrop).toBe('viewport');
    expect(snapshotToFrameScene(snap).composition.backdrop).toBe('viewport');
  });

  it('Active Camera leaves it unset, which the pass reads as the comp rect', () => {
    const snap = build({ ...COMP, camera3dMode: 'active' });
    expect(snap.backdrop).toBeUndefined();
    expect(snapshotToFrameScene(snap).composition.backdrop).toBeUndefined();
  });

  it('a headless build with no view mode at all is Active Camera — export is untouched', () => {
    // Export and the render-test harness never pass camera3dMode. If this ever
    // resolved to 'viewport' every exported frame would gain a full-bleed
    // background it did not have.
    const snap = build(COMP);
    expect(snap.backdrop).toBeUndefined();
    expect(snapshotToFrameScene(snap).composition.backdrop).toBeUndefined();
  });

  it('carries the background colour regardless of view, so the fill has something to paint', () => {
    for (const mode of ['active', ...ORTHO_VIEWS] as const) {
      expect(build({ ...COMP, camera3dMode: mode }).background).toBe('#101014');
    }
  });

  it('a transparent comp stays transparent in an ortho view', () => {
    // `transparent` beats the background colour everywhere; an ortho view must
    // not resurrect a fill the user turned off.
    const scene = snapshotToFrameScene(build({ ...COMP, transparent: true, camera3dMode: 'top' }));
    expect(scene.composition.backdrop).toBe('viewport');
    expect(scene.composition.background?.a).toBe(0);
  });
});
