/**
 * A light's glow wash must project through the ACTIVE VIEW.
 *
 * It used to be emitted at the light's raw comp x/y, so it ignored both the
 * light's depth and the view entirely: switch to Left view and every layer
 * moved while the glow stayed nailed to the same screen position, and pushing a
 * light forward or back in Z changed nothing about where it appeared.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { paneViewTransform, PANE_CONTAIN_FACTOR } from '@layout/Workspace/useSceneRefGeometry';
import { viewToCamera } from './snapshotToFrameScene';

const COMP = { width: 800, height: 600, background: '#101014' };

function light(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', ...props } }],
  } as unknown as SceneNode;
}

function snap(nodes: SceneNode[], camera3dMode = 'active') {
  const g = new SceneGraph();
  for (const n of nodes) g.addNode(n);
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    ...COMP, camera3dMode,
  } as never);
}

const at = (s: ReturnType<typeof snap>, id: string) => {
  const l = s.layers.find((x) => x.id === id)!;
  return { x: l.x, y: l.y };
};

describe('light glow follows the view', () => {
  it('a point light moves with the view, like everything else in the scene', () => {
    const nodes = [light('L', { x: 700, y: 300, z: 400, lightType: 'point' })];
    const front = at(snap(nodes, 'front'), 'L');
    const left = at(snap(nodes, 'left'), 'L');
    const top = at(snap(nodes, 'top'), 'L');
    // Left view carries z on screen X; Top view carries it on screen Y.
    expect(left.x).not.toBeCloseTo(front.x, 1);
    expect(top.y).not.toBeCloseTo(front.y, 1);
  });

  it("Left view places the glow by the light's DEPTH", () => {
    const near = at(snap([light('L', { x: 400, y: 300, z: -500, lightType: 'point' })], 'left'), 'L');
    const far = at(snap([light('L', { x: 400, y: 300, z: 500, lightType: 'point' })], 'left'), 'L');
    expect(near.x).toBeCloseTo(900, 4);
    expect(far.x).toBeCloseTo(-100, 4);
  });

  it('depth parallaxes the glow through the perspective camera too', () => {
    const shallow = at(snap([light('L', { x: 700, y: 300, z: 0, lightType: 'point' })]), 'L');
    const deep = at(snap([light('L', { x: 700, y: 300, z: 2000, lightType: 'point' })]), 'L');
    // Further away ⇒ pulled toward the vanishing point at the comp centre.
    expect(deep.x).toBeLessThan(shallow.x);
    expect(deep.x).toBeGreaterThan(400);
  });

  it('an AMBIENT light stays centred — it has no position to project', () => {
    // Ambient lifts the whole frame uniformly; projecting it would slide a
    // full-frame wash off the frame.
    const nodes = [light('A', { x: 50, y: 50, z: 900, lightType: 'ambient' })];
    for (const view of ['active', 'left', 'top', 'front']) {
      expect(at(snap(nodes, view), 'A')).toEqual({ x: 400, y: 300 });
    }
  });
});

describe('pane view transform matches the renderer fit', () => {
  // The panes pass no RenderView, so the renderer falls back to a centred
  // "contain" fit. The overlay recomputes that fit to land on the pane's
  // pixels — if the two ever drift, every gizmo in every pane is offset.
  it('reproduces viewToCamera zoom and centre exactly', () => {
    for (const [w, h] of [[640, 480], [1000, 400], [333, 777]] as const) {
      const t = paneViewTransform(w, h, COMP.width, COMP.height);
      const cam = viewToCamera(undefined, COMP, w, h);
      expect(t.scale).toBeCloseTo(cam.zoom, 9);
      // canvasPx = compPx·scale + offset, and the comp centre must land on the
      // viewport centre — the same thing `center` expresses for the renderer.
      expect((w / 2 - t.offsetX) / t.scale).toBeCloseTo(cam.center.x, 9);
      expect((h / 2 - t.offsetY) / t.scale).toBeCloseTo(cam.center.y, 9);
    }
  });

  it('uses the same contain factor the renderer does', () => {
    expect(PANE_CONTAIN_FACTOR).toBeCloseTo(
      viewToCamera(undefined, COMP, COMP.width, COMP.height).zoom,
      9,
    );
  });
});
