/**
 * The composition backdrop is painted in EVERY view.
 *
 * The defect, reported twice: switching a comp to Front / Back / Left / Right /
 * Top / Bottom or any of the three custom views showed no composition at all —
 * just the projected dashed outline over bare pasteboard, while the layers kept
 * drawing normally. Only Active Camera showed the artboard. The cause was a
 * `backdrop: false` flag those views set, which `BackgroundPass` read as "paint
 * nothing".
 *
 * The flag is gone entirely rather than given a second mode: there is no view in
 * which the comp frame should be invisible, so a switch selecting between
 * "painted" and "not painted" was a control whose only correct value was one of
 * them. This pins that no view can opt out again.
 *
 * The end-to-end assertion — that the pass actually EMITS a draw for an ortho
 * view — is the one that would have caught the original bug; asserting the
 * snapshot alone would not, because the snapshot was fine and the pass discarded
 * it. See `renderGraphBackdrop` below.
 */

import { buildSnapshot } from './buildSnapshot';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { Project3D } from '@motion/scene';
import {
  NullBackend,
  Viewport,
  ResourceManager,
  CommandBuffer,
} from '@motion/renderer';
import { BackgroundPass } from '../../../packages/renderer/src/rendergraph/passes/BackgroundPass';
import type { SceneNode } from '@core/types';
import type { SnapshotComp } from './buildSnapshot';

const COMP: SnapshotComp = { width: 800, height: 600, background: '#101014' };

/** The six axis views AE offers — the full `OrthoView` union. */
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

describe('no view suppresses the composition backdrop', () => {
  it.each(ORTHO_VIEWS)('%s view carries the background through to the scene', (view) => {
    const scene = snapshotToFrameScene(build({ ...COMP, camera3dMode: view }));
    // No opt-out field exists any more; the colour is simply present.
    expect(scene.composition.background).toBeDefined();
    expect(scene.composition.background?.a).toBe(1);
  });

  it('a custom view carries it too', () => {
    const scene = snapshotToFrameScene(
      build({ ...COMP, camera3dMode: 'active', customViewCamera: Project3D.defaultCamera(COMP.width, COMP.height) }),
    );
    expect(scene.composition.background?.a).toBe(1);
  });

  it('Active Camera is unchanged', () => {
    const scene = snapshotToFrameScene(build({ ...COMP, camera3dMode: 'active' }));
    expect(scene.composition.background?.a).toBe(1);
  });

  it('the ortho and Active Camera scenes agree about the composition entirely', () => {
    // The whole class of bug: the two disagreeing about whether the comp exists.
    const active = snapshotToFrameScene(build({ ...COMP, camera3dMode: 'active' })).composition;
    for (const view of ORTHO_VIEWS) {
      const ortho = snapshotToFrameScene(build({ ...COMP, camera3dMode: view })).composition;
      expect(ortho.size).toEqual(active.size);
      expect(ortho.background).toEqual(active.background);
    }
  });

  it('a transparent comp is still transparent in an ortho view', () => {
    const scene = snapshotToFrameScene(build({ ...COMP, transparent: true, camera3dMode: 'top' }));
    expect(scene.composition.background?.a).toBe(0);
  });

  it('the layers keep rendering in an ortho view — they always did', () => {
    // Stated because it is half the reported symptom: objects drew while the
    // composition did not, which is what made it look like a rendering bug
    // rather than a missing fill.
    for (const view of ORTHO_VIEWS) {
      const scene = snapshotToFrameScene(build({ ...COMP, camera3dMode: view }));
      expect(scene.renderables.some((r) => r.id === 'box')).toBe(true);
    }
  });
});

describe('renderGraphBackdrop: the pass EMITS a draw, in every view', () => {
  /**
   * Run BackgroundPass for real and count the draw commands it queued.
   *
   * This is the assertion that would have caught the original defect. The
   * snapshot was always correct; `BackgroundPass` returned early and drew
   * nothing, so every snapshot-level test passed while the viewport was blank.
   */
  function drawsFor(scene: ReturnType<typeof snapshotToFrameScene>): number {
    const backend = new NullBackend();
    const resources = new ResourceManager(backend);
    resources.beginFrame(1);
    const commands = new CommandBuffer();
    const viewport = new Viewport({ width: COMP.width, height: COMP.height });
    viewport.camera.setState({ center: { x: COMP.width / 2, y: COMP.height / 2 }, zoom: 1 });

    const pass = new BackgroundPass();
    let drew = 0;
    pass.execute({
      scene,
      viewport,
      target: () => undefined,
      services: {
        backend,
        resources,
        commands,
        quad: {
          execute: (_enc: unknown, cmds: CommandBuffer) => {
            drew = cmds.length;
          },
        },
      },
    } as never);
    return drew;
  }

  it.each(ORTHO_VIEWS)('%s view queues a backdrop draw', (view) => {
    expect(drawsFor(snapshotToFrameScene(build({ ...COMP, camera3dMode: view })))).toBeGreaterThan(0);
  });

  it('a custom view queues one', () => {
    const scene = snapshotToFrameScene(
      build({ ...COMP, camera3dMode: 'active', customViewCamera: Project3D.defaultCamera(COMP.width, COMP.height) }),
    );
    expect(drawsFor(scene)).toBeGreaterThan(0);
  });

  it('Active Camera queues one — the case that always worked', () => {
    expect(drawsFor(snapshotToFrameScene(build({ ...COMP, camera3dMode: 'active' })))).toBeGreaterThan(0);
  });

  it('every view queues the SAME number, so none is special-cased', () => {
    const counts = ['active', ...ORTHO_VIEWS].map((mode) =>
      drawsFor(snapshotToFrameScene(build({ ...COMP, camera3dMode: mode as never }))),
    );
    expect(new Set(counts).size).toBe(1);
  });
});

