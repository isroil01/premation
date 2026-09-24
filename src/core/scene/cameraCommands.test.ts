import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, resolveLayerRef } from '@motion/animation';
import { Project3D } from '@motion/scene';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultCustomViews } from '@core/workspace/customViews';
import { cameraFromNode } from './camera3d';
import { layerSpaceAt } from './layerSpace';
import {
  buildCameraCommands,
  createOrbitNull,
  focusDepthToLayer,
  framingFor,
  linkFocusToLayerExpression,
  linkFocusToPoiExpression,
  lookAt,
  linkFocusDistanceToLayer,
  linkFocusDistanceToPoi,
} from './cameraCommands';

function bootCommandSystem(): void {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) as never }));
}

const CAM = 'cc_camera';
const SUBJECT = 'cc_subject';
const OTHER = 'cc_other';
const W = 1920;
const H = 1080;
const FOCAL = Project3D.defaultCamera(W, H).focalLength;

function addNode(id: string, name: string, kind: string, props: Record<string, unknown>): void {
  defaultSceneGraph.addChild('comp_root', {
    id,
    name,
    parent: 'comp_root',
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: kind, ...props } }],
  } as never);
}

function props(id: string): Record<string, unknown> {
  return defaultSceneGraph.getNode(id)!.components[0]!.props as Record<string, unknown>;
}

function addCamera(twoNode: boolean): void {
  addNode(CAM, 'Camera 1', 'camera', {
    x: W / 2, y: H / 2, z: -FOCAL, focalLength: FOCAL,
    ...(twoNode ? { poiX: W / 2, poiY: H / 2, poiZ: 0 } : {}),
  });
}

beforeEach(() => {
  bootCommandSystem();
  // The jest graph is not seeded: `addChild('comp_root', …)` stores the node
  // but a walk from the root finds nothing until the root itself exists.
  if (!defaultSceneGraph.getNode('comp_root')) {
    defaultSceneGraph.addNode({
      id: 'comp_root', name: 'Comp', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'comp_root_t', type: 'Transform', props: { __kind: 'group' } }],
    } as never);
  }
  for (const id of [CAM, SUBJECT, OTHER]) {
    if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode(id);
  }
  for (const n of [...defaultSceneGraph.getNode('comp_root')?.children ?? []]) {
    if (n.startsWith('null_orbit_')) defaultSceneGraph.removeNode(n);
  }
  // A 3D shape 500 px behind the comp plane, off the optical axis.
  addNode(SUBJECT, 'Subject', 'shape', { x: 1200, y: 300, z: 500, rotationX: 0, rotationY: 0, width: 200, height: 100 });
  addNode(OTHER, 'Other', 'shape', { x: 400, y: 800, z: 0, rotationX: 0, rotationY: 0, width: 200, height: 100 });
  // Tracks outlive their node in the shared engine — a keyframe left by one
  // test would move the camera in the next.
  for (const prop of ['x', 'y', 'z', 'poiX', 'poiY', 'poiZ', 'focusDistance', 'orbitYaw']) {
    if (defaultAnimation.isAnimated(CAM, prop)) defaultAnimation.removeTrack(CAM, prop);
  }
  defaultAnimation.setExpression(CAM, 'focusDistance', '');
  useSelectionStore.setState({ ids: [] });
  useGuidesStore.setState({ camera3dMode: 'active', customViews: defaultCustomViews(), lastCustomView: 'custom1' });
});

describe('focus distance', () => {
  it('Set Focus Distance to Layer writes the axial depth the renderer defocuses by', () => {
    addCamera(false);
    const cam = defaultSceneGraph.getNode(CAM)!;
    const subject = defaultSceneGraph.getNode(SUBJECT)!;
    // Straight-on camera: depth is the z gap, not the diagonal distance.
    expect(focusDepthToLayer(cam, subject, 0)).toBeCloseTo(FOCAL + 500, 6);
    // The write itself goes through the engine — cameraEdits.test.ts.
  });

  it('a layer behind the camera has no focus distance', () => {
    addCamera(false);
    defaultSceneGraph.writeProp(SUBJECT, `${SUBJECT}_t`, 'z', -FOCAL - 100);
    expect(focusDepthToLayer(defaultSceneGraph.getNode(CAM)!, defaultSceneGraph.getNode(SUBJECT)!, 0)).toBeNull();
  });

  it('Link writes AE\'s toWorld/length expression', () => {
    addCamera(true);
    expect(linkFocusDistanceToLayer(CAM, SUBJECT)).toBe(true);
    expect(defaultAnimation.getExpressionSrc(CAM, 'focusDistance')).toBe(linkFocusToLayerExpression('Subject'));
    expect(linkFocusToLayerExpression('He said "hi"')).toContain('"He said \\"hi\\""');
  });

  it('Link to Point of Interest needs a two-node camera', () => {
    addCamera(false);
    expect(linkFocusDistanceToPoi(CAM)).toBe(false);
    defaultSceneGraph.removeNode(CAM);
    addCamera(true);
    expect(linkFocusDistanceToPoi(CAM)).toBe(true);
    expect(defaultAnimation.getExpressionSrc(CAM, 'focusDistance')).toBe(linkFocusToPoiExpression('Camera 1'));
  });

  it('a camera has a layer space: toWorld([0,0]) is the eye the renderer projects through', () => {
    addCamera(true);
    defaultSceneGraph.writeProp(CAM, `${CAM}_t`, 'orbitYaw', 30);
    const cam = defaultSceneGraph.getNode(CAM)!;
    const expected = cameraFromNode(cam, W, H).position;
    const space = layerSpaceAt(CAM, 0, { width: W, height: H, rootId: 'comp_root' });
    expect(space).toBeDefined();
    const [x, y, z] = space!.toWorld([0, 0]);
    expect(x).toBeCloseTo(expected.x, 6);
    expect(y).toBeCloseTo(expected.y, 6);
    expect(z).toBeCloseTo(expected.z, 6);
  });
});

describe('Link expressions evaluate live', () => {
  it('through the same providers the app installs (layer names, base props, layer spaces)', () => {
    addCamera(true);
    const byName = (name: string): string | null => {
      let found: string | null = null;
      defaultSceneGraph.traverse((n) => { if (found === null && n.name === name) found = n.id; });
      return found;
    };
    defaultAnimation.setLayerResolver(byName);
    defaultAnimation.setBaseValueProvider((nodeId, prop) => {
      const t = defaultSceneGraph.getNode(nodeId)?.components.find((c) => c.type === 'Transform');
      const v = t?.props[prop as string];
      return typeof v === 'number' ? v : undefined;
    });
    defaultAnimation.setCompInfoProvider((() => ({ width: W, height: H, duration: 10, fps: 30, numLayers: 3 })) as never);
    defaultAnimation.setLayerSpaceProvider((self, name, t) => {
      const id = name === null ? self : resolveLayerRef(name, byName);
      return id ? layerSpaceAt(id, t, { width: W, height: H, rootId: 'comp_root' }) : undefined;
    });

    linkFocusDistanceToLayer(CAM, SUBJECT);
    expect(defaultAnimation.getExpressionError(CAM, 'focusDistance')).toBeNull();
    // Eye (960, 540, −F) to the subject at (1200, 300, 500): the straight-line distance.
    expect(defaultAnimation.sample(CAM, 'focusDistance', 0)).toBeCloseTo(Math.hypot(240, 240, FOCAL + 500), 3);

    linkFocusDistanceToPoi(CAM);
    // POI at the comp centre on the plane, eye pulled back by the focal length.
    expect(defaultAnimation.sample(CAM, 'focusDistance', 0)).toBeCloseTo(FOCAL, 3);
  });
});

describe('Create Orbit Null', () => {
  it('parents a two-node camera to a null at its POI without moving the shot', () => {
    addCamera(true);
    defaultSceneGraph.writeProp(CAM, `${CAM}_t`, 'orbitYaw', 25);
    defaultSceneGraph.writeProp(CAM, `${CAM}_t`, 'poiX', 1000);
    defaultSceneGraph.writeProp(CAM, `${CAM}_t`, 'poiZ', 200);
    defaultAnimation.setKeyframe(CAM, 'x', 0, W / 2);
    defaultAnimation.setKeyframe(CAM, 'x', 2, W / 2 + 300);
    const cam = defaultSceneGraph.getNode(CAM)!;
    const before = cameraFromNode(cam, W, H, undefined, undefined);
    const sample = (id: string, prop: string) => defaultAnimation.evaluateNode(id, 0).get(prop);
    const beforeAnimated = cameraFromNode(cam, W, H, sample);

    const nullId = createOrbitNull(CAM, 0);
    expect(nullId).not.toBeNull();
    const nul = defaultSceneGraph.getNode(nullId!)!;
    expect(props(nullId!)).toMatchObject({ x: 1000, y: H / 2, z: 200 });
    expect(defaultSceneGraph.getNode(CAM)!.parent).toBe(nullId);
    expect(useSelectionStore.getState().ids).toEqual([nullId]);

    // Local props are now relative to the null: POI sits at its origin.
    expect(props(CAM)).toMatchObject({ poiX: 0, poiY: 0, poiZ: 0, z: -FOCAL - 200 });
    // The keyframed x track moved with the base prop.
    const kfs = defaultAnimation.getTrackKeyframes(CAM, 'x')!;
    expect(kfs[0]!.value).toBeCloseTo(W / 2 - 1000, 6);
    expect(kfs[1]!.value).toBeCloseTo(W / 2 + 300 - 1000, 6);

    // Resolved through the parent lift, the camera is exactly where it was.
    const lift = (_id: string, p: { x: number; y: number; z: number }) => {
      const np = nul.components[0]!.props as Record<string, number>;
      return { x: p.x + (np.x ?? 0), y: p.y + (np.y ?? 0), z: p.z + (np.z ?? 0) };
    };
    const after = cameraFromNode(defaultSceneGraph.getNode(CAM)!, W, H, undefined, lift);
    expect(after.position.x).toBeCloseTo(before.position.x, 6);
    expect(after.position.y).toBeCloseTo(before.position.y, 6);
    expect(after.position.z).toBeCloseTo(before.position.z, 6);
    expect(after.orientation?.yaw ?? 0).toBeCloseTo(before.orientation?.yaw ?? 0, 6);
    const afterAnimated = cameraFromNode(defaultSceneGraph.getNode(CAM)!, W, H, sample, lift);
    expect(afterAnimated.position.x).toBeCloseTo(beforeAnimated.position.x, 6);
  });

  it('a one-node camera gets its null at the focus distance along the axis', () => {
    addCamera(false);
    defaultSceneGraph.writeProp(CAM, `${CAM}_t`, 'focusDistance', FOCAL + 400);
    const nullId = createOrbitNull(CAM, 0)!;
    expect(props(nullId)).toMatchObject({ x: W / 2, y: H / 2 });
    expect(props(nullId).z as number).toBeCloseTo(400, 6);
    expect(props(CAM).z as number).toBeCloseTo(-FOCAL - 400, 6);
  });
});

describe('Look at', () => {
  it('frames the selection: POI at the centroid, distance that fits the enclosing sphere', () => {
    const nodes = [defaultSceneGraph.getNode(SUBJECT)!, defaultSceneGraph.getNode(OTHER)!];
    const f = framingFor(nodes, 0, W, H)!;
    expect(f.poi).toEqual({ x: 800, y: 550, z: 250 });
    const spread = Math.hypot(400, 250, 250) + Math.hypot(200, 100) / 2;
    const fovV = Project3D.fovForFocalLength(H, FOCAL) * (Math.PI / 180);
    expect(f.distance).toBeCloseTo((spread / Math.sin(fovV / 2)) * 1.1, 6);
  });

  it('switches Active Camera to the last custom view and aims it, keeping its angle', () => {
    useGuidesStore.getState().updateCustomView('custom2', { yaw: 50, pitch: -10 });
    useGuidesStore.setState({ lastCustomView: 'custom2' });
    const view = lookAt([defaultSceneGraph.getNode(SUBJECT)!], 0);
    expect(view).toBe('custom2');
    const s = useGuidesStore.getState();
    expect(s.camera3dMode).toBe('custom2');
    expect(s.customViews.custom2).toMatchObject({ yaw: 50, pitch: -10, poi: { x: 1200, y: 300, z: 500 } });
    expect(s.customViews.custom2.distance).toBeGreaterThan(0);
  });
});

describe('commands', () => {
  it('enable on the right selections', () => {
    addCamera(true);
    const byId = new Map(buildCameraCommands().map((c) => [String(c.id), c]));
    useSelectionStore.setState({ ids: [] });
    expect(byId.get('camera.createOrbitNull')!.enabled?.()).toBe(true);
    expect(byId.get('camera.setFocusToLayer')!.enabled?.()).toBe(false);
    expect(byId.get('camera.linkFocusToPoi')!.enabled?.()).toBe(true);
    expect(byId.get('view.lookAtSelected')!.enabled?.()).toBe(false);
    expect(byId.get('view.lookAtAll')!.enabled?.()).toBe(true);
    useSelectionStore.setState({ ids: [SUBJECT, CAM] });
    expect(byId.get('camera.setFocusToLayer')!.enabled?.()).toBe(true);
    expect(byId.get('camera.linkFocusToLayer')!.enabled?.()).toBe(true);
    expect(byId.get('view.lookAtSelected')!.enabled?.()).toBe(true);
    useSelectionStore.setState({ ids: [SUBJECT, OTHER] });
    expect(byId.get('camera.setFocusToLayer')!.enabled?.()).toBe(false);
  });
});
