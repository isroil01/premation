/**
 * Dragging a camera or light by its viewport handle.
 *
 * The headline case is the PARENTED one. A drag computes a world position; a
 * node stores parent-space values. Write the former as the latter and the
 * parent transform is applied to it a second time on the next frame, so the
 * device leaps away from the cursor by exactly the parent transform the instant
 * the mouse is released. It is the classic regression when parenting meets
 * direct manipulation, it is invisible from reading the write path, and it is
 * what `Matrix4Math.toLocalPoint` exists to prevent.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { usePreferenceStore } from '@stores/preferenceStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import type { SceneNode } from '@core/types';
import {
  collectDeviceHandles,
  dragDeviceHandleTo,
  hitTestDeviceHandle,
  type DeviceHandle,
} from './deviceHandles';

const ROOT = 'dh-root';
const RIG = 'dh-rig';
const CAM = 'dh-cam';
const SPOT = 'dh-spot';
const W = 1920;
const H = 1080;
const FOCAL = 2666.5025797583758;

function makeNode(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props }],
  } as unknown as SceneNode;
}

/** Read a node's stored (parent-space) Transform props. */
const props = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components[0]!.props as Record<string, unknown>;

function addComp(): void {
  defaultSceneGraph.addNode(makeNode(ROOT, { [SCENE_KIND_PROP]: 'group' }));
}

/** A camera, optionally under a null rig offset by `rigX`. */
function addCamera(opts: { rigX?: number; twoNode?: boolean } = {}): void {
  addComp();
  const cam = makeNode(CAM, {
    [SCENE_KIND_PROP]: 'camera',
    x: W / 2, y: H / 2, z: -FOCAL, focalLength: FOCAL,
    ...(opts.twoNode ? { poiX: W / 2, poiY: H / 2, poiZ: 0 } : {}),
  });
  if (opts.rigX === undefined) {
    defaultSceneGraph.addChild(ROOT, cam);
    return;
  }
  defaultSceneGraph.addChild(ROOT, makeNode(RIG, {
    [SCENE_KIND_PROP]: 'null', x: opts.rigX, y: 0, z: 0, rotationX: 0, rotationY: 0,
  }));
  defaultSceneGraph.addChild(RIG, cam);
}

function addSpot(rigX: number): void {
  addComp();
  defaultSceneGraph.addChild(ROOT, makeNode(RIG, {
    [SCENE_KIND_PROP]: 'null', x: rigX, y: 0, z: 0, rotationX: 0, rotationY: 0,
  }));
  defaultSceneGraph.addChild(RIG, makeNode(SPOT, {
    [SCENE_KIND_PROP]: 'light', lightType: 'spot',
    x: 100, y: 200, z: -300, poiX: 400, poiY: 500, poiZ: 0,
  }));
}

const handleOf = (kind: 'position' | 'poi', nodeId: string): DeviceHandle => {
  const h = collectDeviceHandles(0, W, H).find((x) => x.nodeId === nodeId && x.kind === kind);
  if (!h) throw new Error(`no ${kind} handle for ${nodeId}`);
  return h;
};

beforeEach(() => {
  usePreferenceStore.setState({ timelineAutoKeyframe: false });
  // Keyframing routes through runAnimEdit, which is undo-backed — without a
  // CommandSystem the write throws rather than silently skipping, so this is
  // required setup, not decoration.
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
});

afterEach(() => {
  for (const id of [CAM, SPOT, RIG, ROOT]) {
    try { defaultSceneGraph.removeNode(id); } catch { /* not added */ }
  }
  // Tracks outlive the graph nodes, and the ids are reused between tests — so
  // a keyframe written by the Auto-Keyframe-ON case would still be there for
  // the OFF case, where an existing track legitimately keyframes again.
  for (const id of [CAM, SPOT]) defaultAnimation.clearNode(id);
});

describe('the handle sits where the wireframe is', () => {
  it('an unparented camera handle is at its resolved eye', () => {
    addCamera();
    expect(handleOf('position', CAM).world).toEqual({ x: W / 2, y: H / 2, z: -FOCAL });
  });

  it('a PARENTED camera handle follows the rig', () => {
    // The gizmo and the renderer both resolve through the parent chain; a
    // handle that did not would sit off the wireframe it is supposed to grab.
    addCamera({ rigX: 3000 });
    expect(handleOf('position', CAM).world.x).toBeCloseTo(3000 + W / 2, 4);
  });

  it('a one-node camera has NO point-of-interest handle', () => {
    // It turns in place; a target handle would imply a property it does not own.
    addCamera();
    expect(collectDeviceHandles(0, W, H).some((h) => h.kind === 'poi')).toBe(false);
  });

  it('a two-node camera has both', () => {
    addCamera({ twoNode: true });
    const kinds = collectDeviceHandles(0, W, H).filter((h) => h.nodeId === CAM).map((h) => h.kind);
    expect(kinds.sort()).toEqual(['poi', 'position']);
  });
});

describe('dragging writes PARENT-SPACE values', () => {
  it('an unparented camera stores the world position directly', () => {
    addCamera();
    dragDeviceHandleTo(handleOf('position', CAM), { x: 1000, y: 200, z: -500 }, 0);
    expect(props(CAM).x).toBeCloseTo(1000, 4);
    expect(props(CAM).y).toBeCloseTo(200, 4);
    expect(props(CAM).z).toBeCloseTo(-500, 4);
  });

  it('a PARENTED camera stores the value MINUS the parent — no snap-back', () => {
    addCamera({ rigX: 3000 });
    // Drop it at world x = 5000. Stored naively that becomes 5000 + 3000 = 8000
    // on the next frame: the camera jumps 3000px away from the cursor.
    dragDeviceHandleTo(handleOf('position', CAM), { x: 5000, y: 200, z: -500 }, 0);
    expect(props(CAM).x).toBeCloseTo(2000, 4); // 5000 − 3000
  });

  it('lands where the cursor left it: re-resolving reproduces the drop point', () => {
    // The end-to-end invariant — drop, re-collect, and the handle must be back
    // under the pointer. This is what "no snap, no drift" means.
    addCamera({ rigX: 3000 });
    const target = { x: 4321, y: 654, z: -987 };
    dragDeviceHandleTo(handleOf('position', CAM), target, 0);
    const after = handleOf('position', CAM).world;
    expect(after.x).toBeCloseTo(target.x, 3);
    expect(after.y).toBeCloseTo(target.y, 3);
    expect(after.z).toBeCloseTo(target.z, 3);
  });

  it('the same holds for a parented SPOT LIGHT', () => {
    addSpot(900);
    const target = { x: 1500, y: 300, z: -200 };
    dragDeviceHandleTo(handleOf('position', SPOT), target, 0);
    expect(props(SPOT).x).toBeCloseTo(600, 4); // 1500 − 900
    const after = handleOf('position', SPOT).world;
    expect(after.x).toBeCloseTo(target.x, 3);
    expect(after.y).toBeCloseTo(target.y, 3);
  });
});

describe('position and target move independently', () => {
  it('dragging the POI leaves the camera position alone', () => {
    addCamera({ twoNode: true });
    const before = { x: props(CAM).x, y: props(CAM).y, z: props(CAM).z };
    dragDeviceHandleTo(handleOf('poi', CAM), { x: 100, y: 50, z: 700 }, 0);
    expect(props(CAM).poiX).toBeCloseTo(100, 4);
    expect(props(CAM).poiZ).toBeCloseTo(700, 4);
    expect(props(CAM).x).toBe(before.x);
    expect(props(CAM).y).toBe(before.y);
    expect(props(CAM).z).toBe(before.z);
  });

  it('dragging the position leaves the POI alone', () => {
    // The other direction matters just as much: a target that follows the body
    // can never be aimed.
    addCamera({ twoNode: true });
    const poiBefore = { x: props(CAM).poiX, y: props(CAM).poiY, z: props(CAM).poiZ };
    dragDeviceHandleTo(handleOf('position', CAM), { x: 42, y: 43, z: 44 }, 0);
    expect(props(CAM).x).toBeCloseTo(42, 4);
    expect(props(CAM).poiX).toBe(poiBefore.x);
    expect(props(CAM).poiY).toBe(poiBefore.y);
    expect(props(CAM).poiZ).toBe(poiBefore.z);
  });

  it('a parented POI is stored in parent space too', () => {
    addCamera({ rigX: 3000, twoNode: true });
    dragDeviceHandleTo(handleOf('poi', CAM), { x: 3500, y: 100, z: 0 }, 0);
    expect(props(CAM).poiX).toBeCloseTo(500, 4); // 3500 − 3000
  });
});

describe('auto-keyframe', () => {
  it('creates a keyframe when Auto-Keyframe is ON', () => {
    addCamera();
    usePreferenceStore.setState({ timelineAutoKeyframe: true });
    dragDeviceHandleTo(handleOf('position', CAM), { x: 700, y: 300, z: -500 }, 0);
    expect(defaultAnimation.getTrackKeyframes(CAM, 'x')?.length ?? 0).toBeGreaterThan(0);
  });

  it('creates none when it is OFF — the base prop still moves', () => {
    addCamera();
    dragDeviceHandleTo(handleOf('position', CAM), { x: 700, y: 300, z: -500 }, 0);
    expect(defaultAnimation.getTrackKeyframes(CAM, 'x')?.length ?? 0).toBe(0);
    expect(props(CAM).x).toBeCloseTo(700, 4);
  });
});

describe('hit testing', () => {
  const identity = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y });

  it('picks the handle under the pointer and ignores distant ones', () => {
    addCamera({ twoNode: true });
    const hs = collectDeviceHandles(0, W, H);
    expect(hitTestDeviceHandle({ x: W / 2, y: H / 2 }, hs, identity, 12)).not.toBeNull();
    expect(hitTestDeviceHandle({ x: 5, y: 5 }, hs, identity, 12)).toBeNull();
  });

  it('prefers the POI when both are under the pointer', () => {
    // A target sitting on the camera body is exactly when you mean the one you
    // can barely hit.
    addCamera({ twoNode: true });
    const hs = collectDeviceHandles(0, W, H).map((h) => ({ ...h, world: { x: 10, y: 10, z: 0 } }));
    expect(hitTestDeviceHandle({ x: 10, y: 10 }, hs, identity, 12)?.kind).toBe('poi');
  });
});

describe('comp scoping', () => {
  it('a camera in another composition gets no handle', () => {
    // It is not drawn in this viewport, so it must not be grabbable in it.
    addCamera();
    const OTHER = 'dh-other-root';
    const OTHERCAM = 'dh-other-cam';
    try {
      defaultSceneGraph.addNode(makeNode(OTHER, { [SCENE_KIND_PROP]: 'group' }));
      defaultSceneGraph.addChild(OTHER, makeNode(OTHERCAM, {
        [SCENE_KIND_PROP]: 'camera', x: 0, y: 0, z: -FOCAL, focalLength: FOCAL,
      }));
      const ids = collectDeviceHandles(0, W, H).map((h) => h.nodeId);
      expect(ids).toContain(CAM);
      expect(ids).not.toContain(OTHERCAM);
    } finally {
      for (const id of [OTHERCAM, OTHER]) {
        try { defaultSceneGraph.removeNode(id); } catch { /* ignore */ }
      }
    }
  });

  it('the camera being LOOKED THROUGH gets no handle', () => {
    // Its wireframe is already suppressed, and dragging the eye you are viewing
    // through is degenerate: it projects through its own view at zero depth.
    addCamera();
    expect(collectDeviceHandles(0, W, H).some((h) => h.nodeId === CAM)).toBe(true);
    expect(collectDeviceHandles(0, W, H, CAM).some((h) => h.nodeId === CAM)).toBe(false);
  });

  it('an AMBIENT light has no handle — it has no position that means anything', () => {
    addComp();
    const AMB = 'dh-amb';
    try {
      defaultSceneGraph.addChild(ROOT, makeNode(AMB, {
        [SCENE_KIND_PROP]: 'light', lightType: 'ambient', x: 100, y: 100,
      }));
      expect(collectDeviceHandles(0, W, H).some((h) => h.nodeId === AMB)).toBe(false);
    } finally {
      try { defaultSceneGraph.removeNode(AMB); } catch { /* ignore */ }
    }
  });
});
