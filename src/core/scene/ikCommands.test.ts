/**
 * The palette command and the inspector's "3D IK" panel must be ONE code path.
 *
 * Before this, both command bodies inlined their own target resolution, solver
 * call and notification. A panel written against `applyIk3D` directly would
 * have been a second, subtly different implementation of "pose at target" —
 * the classic way two surfaces of one feature drift (the palette gaining a fix
 * the panel never sees). So the bodies were lifted into `poseIk3DAtTarget` /
 * `bakeIk3DToTarget`, and what is pinned here is that running the command and
 * calling the function land the SAME numbers on the joints.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { buildIk3DCommands, poseIk3DAtTarget, bakeIk3DToTarget } from './ikCommands';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import type { SceneNode } from '@core/types';

const IDS = ['cmd_root', 'cmd_j1', 'cmd_j2', 'cmd_target'];

const nullLayer = (id: string, props: Record<string, number>): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [
    {
      id: `${id}_t`, type: 'Transform',
      props: {
        [SCENE_KIND_PROP]: 'null',
        x: 0, y: 0, z: 0, rotation: 0, rotationX: 0, rotationY: 0,
        scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, width: 20, height: 20,
        ...props,
      },
    },
  ],
} as unknown as SceneNode);

function buildRig(): void {
  defaultSceneGraph.addNode(nullLayer('cmd_root', {}));
  defaultSceneGraph.addChild('cmd_root', nullLayer('cmd_j1', { x: 100 }));
  defaultSceneGraph.addChild('cmd_j1', nullLayer('cmd_j2', { x: 100 }));
  defaultSceneGraph.addNode(nullLayer('cmd_target', { x: 90, y: 120 }));
}

/** The three euler angles the solver writes, per joint. */
function poseOf(): number[] {
  const out: number[] = [];
  for (const id of ['cmd_root', 'cmd_j1']) {
    const t = defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!;
    out.push(Number(t.props.rotationX), Number(t.props.rotationY), Number(t.props.rotation));
  }
  return out;
}

function teardown(): void {
  for (const id of IDS) {
    try { defaultSceneGraph.removeNode(id); } catch { /* already gone */ }
    for (const prop of ['rotationX', 'rotationY', 'rotation', 'x']) {
      defaultAnimation.setTrackKeyframes(id, prop, []);
    }
  }
  useSelectionStore.setState({ ids: [] } as never);
}

const CHAIN = ['cmd_root', 'cmd_j1', 'cmd_j2'];

afterEach(teardown);

describe('3D IK: palette command and panel share one entry point', () => {
  it('“Pose at target” lands the same joint rotations either way', () => {
    buildRig();
    useSelectionStore.setState({ ids: ['cmd_j2', 'cmd_target'] } as never);
    const pose = buildIk3DCommands().find((c) => c.id === 'scene.ikPose3d')!;
    pose.execute?.({} as never);
    const viaCommand = poseOf();

    teardown();
    buildRig();
    expect(poseIk3DAtTarget(CHAIN, 'cmd_target')).toBe(true);

    expect(poseOf()).toEqual(viaCommand);
    // …and it is a real solve, not two matching no-ops.
    expect(viaCommand.some((v) => Math.abs(v) > 1)).toBe(true);
  });

  it('“Bake to target” bakes the comp’s frame count either way', () => {
    useCompositionStore.setState({ fps: 10, durationSeconds: 1 } as never);
    buildRig();
    defaultAnimation.setTrackKeyframes('cmd_target', 'x', [
      { t: 0, value: 90, easing: 'linear' },
      { t: 1, value: 150, easing: 'linear' },
    ]);
    useSelectionStore.setState({ ids: ['cmd_j2', 'cmd_target'] } as never);
    const bake = buildIk3DCommands().find((c) => c.id === 'scene.ikBake3d')!;
    bake.execute?.({} as never);
    const viaCommand = defaultAnimation.tracksFor('cmd_root').find((t) => t.prop === 'rotation')!.keyframes;
    expect(viaCommand.length).toBe(11);

    const first = viaCommand.map((k) => k.value);
    teardown();
    buildRig();
    defaultAnimation.setTrackKeyframes('cmd_target', 'x', [
      { t: 0, value: 90, easing: 'linear' },
      { t: 1, value: 150, easing: 'linear' },
    ]);
    expect(bakeIk3DToTarget(CHAIN, 'cmd_target')).toBe(11);
    const second = defaultAnimation.tracksFor('cmd_root').find((t) => t.prop === 'rotation')!.keyframes;
    expect(second.map((k) => k.value)).toEqual(first);
  });

  it('solver options reach the solver — one iteration cannot match twelve', () => {
    buildRig();
    poseIk3DAtTarget(CHAIN, 'cmd_target', { iterations: 1, maxStepRad: 0.05 });
    const damped = poseOf();
    teardown();
    buildRig();
    poseIk3DAtTarget(CHAIN, 'cmd_target');
    expect(poseOf()).not.toEqual(damped);
  });
});
