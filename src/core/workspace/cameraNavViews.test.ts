/**
 * Mode-aware camera navigation (cameraNav.ts) — the routing contract for
 * AE-style custom views:
 *
 *   - findNavTarget: 'active' needs Camera layer + 3D layer (scene target);
 *     a CUSTOM view needs only a 3D layer (view target, no camera required);
 *   - orbit/track/dolly on a view target write the STORED params in
 *     guidesStore and never touch scene nodes — the shot camera stays put;
 *   - resolveViewCameraInput maps a custom mode to an override camera and
 *     everything else straight through.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useGuidesStore } from '@stores/guidesStore';
import type { SceneNode } from '@core/types';
import { customViewCamera, defaultCustomViews } from './customViews';
import {
  dollyNavBy,
  findNavTarget,
  orbitNavBy,
  resolveViewCameraInput,
  sceneHasAny3D,
  trackNavBy,
} from './cameraNav';

const SHAPE = 'camnav-views-shape';
const CAMERA = 'camnav-views-camera';

function makeNode(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props }],
  } as unknown as SceneNode;
}

/** A 3D content layer (numeric z ⇒ is3DEnabled). */
function add3DShape(): void {
  defaultSceneGraph.addNode(
    makeNode(SHAPE, { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, z: 0, rotationX: 0, rotationY: 0 }),
  );
}

function addCamera(): void {
  defaultSceneGraph.addNode(makeNode(CAMERA, { [SCENE_KIND_PROP]: 'camera', x: 960, y: 540 }));
}

function camProps(): Record<string, unknown> {
  return defaultSceneGraph.getNode(CAMERA)!.components[0]!.props as Record<string, unknown>;
}

beforeEach(() => {
  useGuidesStore.setState({
    camera3dMode: 'active',
    customViews: defaultCustomViews(),
    lastCustomView: 'custom1',
  });
});

afterEach(() => {
  for (const id of [SHAPE, CAMERA]) {
    try { defaultSceneGraph.removeNode(id); } catch { /* not added in this test */ }
  }
});

describe('findNavTarget', () => {
  it("'active' without a camera layer → null (unchanged legacy gate)", () => {
    add3DShape();
    expect(findNavTarget()).toBeNull();
  });

  it("'active' with camera + 3D layer → the scene camera target", () => {
    add3DShape();
    addCamera();
    const t = findNavTarget();
    expect(t).toEqual({ kind: 'scene', nodeId: CAMERA, transId: `${CAMERA}_t` });
  });

  it('custom view with a 3D layer → view target, NO camera layer needed', () => {
    add3DShape();
    useGuidesStore.getState().setCamera3dMode('custom2');
    expect(findNavTarget()).toEqual({ kind: 'view', viewId: 'custom2' });
  });

  it('custom view without any 3D layer → null (nothing to look at)', () => {
    useGuidesStore.getState().setCamera3dMode('custom1');
    expect(findNavTarget()).toBeNull();
    expect(sceneHasAny3D()).toBe(false);
  });
});

describe('custom-view navigation writes the STORE, never the scene', () => {
  beforeEach(() => {
    add3DShape();
    addCamera(); // present but must be IGNORED by custom-view nav
    useGuidesStore.getState().setCamera3dMode('custom1');
  });

  it('orbit updates yaw/pitch in guidesStore.customViews only', () => {
    const before = { ...camProps() };
    orbitNavBy({ kind: 'view', viewId: 'custom1' }, 10, -5);
    const v = useGuidesStore.getState().customViews.custom1;
    expect(v.yaw).toBeCloseTo(35 + 4, 9); // default 35 + 10 × 0.4
    expect(v.pitch).toBeCloseTo(-20 - 2, 9); // default −20 + (−5) × 0.4
    expect(camProps()).toEqual(before); // scene camera untouched
  });

  it('track resolves the default POI against the comp size, then shifts it opposite the drag', () => {
    trackNavBy({ kind: 'view', viewId: 'custom1' }, 10, 20, 1, 1920, 1080);
    const v = useGuidesStore.getState().customViews.custom1;
    expect(v.poi).toEqual({ x: 960 - 10, y: 540 - 20, z: 0 });
    expect(typeof camProps().poiX).toBe('undefined'); // no scene write
  });

  it('dolly resolves the default distance, then moves along the view axis (scene z untouched)', () => {
    const beforeZ = camProps().z;
    dollyNavBy({ kind: 'view', viewId: 'custom1' }, -50, 1920, 1080);
    const v = useGuidesStore.getState().customViews.custom1;
    expect(typeof v.distance).toBe('number');
    expect(v.distance!).toBeGreaterThan(0);
    expect(camProps().z).toBe(beforeZ);
  });

  it('scene-target nav still routes to the camera node (regression)', () => {
    useGuidesStore.getState().setCamera3dMode('active');
    const t = findNavTarget();
    expect(t?.kind).toBe('scene');
  });
});

describe('resolveViewCameraInput', () => {
  it('passes active / ortho modes straight through with no override camera', () => {
    expect(resolveViewCameraInput(1920, 1080, 'active')).toEqual({ camera3dMode: 'active' });
    expect(resolveViewCameraInput(1920, 1080, 'top')).toEqual({ camera3dMode: 'top' });
  });

  it('maps a custom mode to {active + the stored-params camera}', () => {
    useGuidesStore.getState().updateCustomView('custom3', { yaw: 12, pitch: -8, distance: 1200 });
    const input = resolveViewCameraInput(1920, 1080, 'custom3');
    expect(input.camera3dMode).toBe('active');
    expect(input.customViewCamera).toEqual(
      customViewCamera(useGuidesStore.getState().customViews.custom3, 1920, 1080),
    );
  });

  it('defaults to the store camera3dMode when no mode is passed', () => {
    useGuidesStore.getState().setCamera3dMode('custom1');
    expect(resolveViewCameraInput(1920, 1080).customViewCamera).toBeDefined();
    expect(useGuidesStore.getState().lastCustomView).toBe('custom1');
  });
});

describe('guidesStore custom-view state', () => {
  it('updateCustomView merges a partial patch', () => {
    useGuidesStore.getState().updateCustomView('custom2', { yaw: 99 });
    const v = useGuidesStore.getState().customViews.custom2;
    expect(v.yaw).toBe(99);
    expect(v.pitch).toBe(-20); // untouched default
  });

  it('setCamera3dMode records the last custom view for the `2` shortcut', () => {
    useGuidesStore.getState().setCamera3dMode('custom3');
    useGuidesStore.getState().setCamera3dMode('active');
    expect(useGuidesStore.getState().lastCustomView).toBe('custom3');
  });
});
