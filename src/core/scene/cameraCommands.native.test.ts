/**
 * The camera-rig verbs over the engine's document: reads from the mirror and
 * engine queries, writes as engine commands (cameraEdits.test.ts pins the
 * history entries).
 */

import { Project3D } from '@motion/scene';
import type { Value } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { defaultCustomViews } from '@core/workspace/customViews';
import { cameraFromNode } from './camera3d';
import { layerSpaceAt } from './layerSpace';
import {
  buildCameraCommands,
  createOrbitNullEdit,
  focusDepthToLayer,
  framingFor,
  linkFocusToLayerExpression,
  linkFocusToPoiExpression,
  lookAt,
  linkFocusDistanceToLayer,
  linkFocusDistanceToPoi,
  resolveCommandCamera,
} from './cameraCommands';

const W = 1920;
const H = 1080;
const FOCAL = Project3D.defaultCamera(W, H).focalLength;
const comp = 'comp_root';

let h: Harness;

const scalar = (value: number): Value => ({ kind: 'scalar', value });
const vec3 = (x: number, y: number, z: number): Value => ({ kind: 'vec3', value: { x, y, z } });

async function layer(kind: 'camera' | 'solid', name: string): Promise<string> {
  return (await h.run({ type: 'createLayer', comp, kind, name, init: [] })).layer;
}

async function set(id: string, path: string, value: Value): Promise<void> {
  await h.run({ type: 'setProperty', prop: { layer: id, path }, value });
}

/** A 3D solid at a world position. */
async function solid3D(name: string, x: number, y: number, z: number): Promise<string> {
  const id = await layer('solid', name);
  await h.run({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } });
  await set(id, 'transform/position', vec3(x, y, z));
  return id;
}

/** A camera at the default eye (comp centre, pulled back by the focal length); two-node with its POI at the comp centre. */
async function camera(twoNode: boolean): Promise<string> {
  const id = await layer('camera', 'Camera 1');
  if (twoNode) await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/orientTowardsPointOfInterest' }, value: { kind: 'bool', value: true } });
  await engineIdle();
  await documentMirror().loadTree(id);
  return id;
}

const valueOf = (id: string, path: string): Value | undefined => documentMirror().property(id, path)?.value;

beforeEach(async () => {
  h = await setupAppEngine();
  useSelectionStore.setState({ ids: [] });
  useGuidesStore.setState({ camera3dMode: 'active', customViews: defaultCustomViews(), lastCustomView: 'custom1' });
});
afterEach(async () => { await h.dispose(); });

describe('focus distance', () => {
  it('Set Focus Distance to Layer measures the axial depth the renderer defocuses by', async () => {
    const cam = await camera(false);
    const subject = await solid3D('Subject', 1200, 300, 500);
    // Straight-on camera: depth is the z gap, not the diagonal distance.
    expect(await focusDepthToLayer(cam, subject, 0)).toBeCloseTo(FOCAL + 500, 6);
    // The write itself goes through the engine — cameraEdits.test.ts.
  });

  it('a layer behind the camera has no focus distance', async () => {
    const cam = await camera(false);
    const subject = await solid3D('Subject', 1200, 300, -FOCAL - 100);
    expect(await focusDepthToLayer(cam, subject, 0)).toBeNull();
  });

  it('Link writes AE\'s toWorld/length expression', async () => {
    const cam = await camera(true);
    const subject = await solid3D('Subject', 1200, 300, 500);
    expect(await linkFocusDistanceToLayer(cam, subject)).toBe(true);
    expect(documentMirror().property(cam, 'camera/focusDistance')?.expression).toBe(linkFocusToLayerExpression('Subject'));
    expect(linkFocusToLayerExpression('He said "hi"')).toContain('"He said \\"hi\\""');
  });

  it('Link to Point of Interest needs a two-node camera', async () => {
    const one = await camera(false);
    expect(await linkFocusDistanceToPoi(one)).toBe(false);
    const two = await camera(true);
    expect(await linkFocusDistanceToPoi(two)).toBe(true);
    expect(documentMirror().property(two, 'camera/focusDistance')?.expression).toBe(linkFocusToPoiExpression('Camera 1'));
  });

  it('a camera has a layer space: toWorld([0,0]) is the eye the renderer projects through', async () => {
    const cam = await camera(true);
    await set(cam, 'camera/orbitYaw', scalar(30));
    const expected = cameraFromNode((await docView()).getNode(cam)!, W, H).position;
    const space = layerSpaceAt(cam, 0, { width: W, height: H, rootId: comp });
    expect(space).toBeDefined();
    const [x, y, z] = space!.toWorld([0, 0]);
    expect(x).toBeCloseTo(expected.x, 6);
    expect(y).toBeCloseTo(expected.y, 6);
    expect(z).toBeCloseTo(expected.z, 6);
    // The verbs resolve the same eye from the engine's values.
    const rig = await resolveCommandCamera(cam, 0);
    expect(rig!.camera.position.x).toBeCloseTo(expected.x, 6);
    expect(rig!.camera.position.z).toBeCloseTo(expected.z, 6);
  });
});

describe('Link expressions evaluate live', () => {
  it('in the engine that stores them (layer names, base props, layer spaces)', async () => {
    const cam = await camera(true);
    const subject = await solid3D('Subject', 1200, 300, 500);
    const focus = async (): Promise<number> => {
      const r = await h.query({ type: 'getPropertyValues', props: [{ layer: cam, path: 'camera/focusDistance' }], time: 0, evaluated: true });
      return (r.values[0]!.value as Extract<Value, { kind: 'scalar' }>).value;
    };
    await linkFocusDistanceToLayer(cam, subject);
    // Eye (960, 540, −F) to the subject's toWorld([0, 0]) — its layer origin through its world matrix: the straight-line distance.
    const t = await h.query({ type: 'getLayerTransforms', layers: [subject], time: 0 });
    const [ox, oy, oz] = [12, 13, 14].map((i) => t.transforms[0]!.matrix[i]!);
    expect(await focus()).toBeCloseTo(Math.hypot(ox! - W / 2, oy! - H / 2, oz! + FOCAL), 3);
    await linkFocusDistanceToPoi(cam);
    // POI at the comp centre on the plane, eye pulled back by the focal length.
    expect(await focus()).toBeCloseTo(FOCAL, 3);
  });
});

describe('Create Orbit Null', () => {
  it('parents a two-node camera to a null at its POI without moving the shot', async () => {
    const cam = await camera(true);
    await set(cam, 'camera/orbitYaw', scalar(25));
    await set(cam, 'camera/poiX', scalar(1000));
    await set(cam, 'camera/poiZ', scalar(200));
    await h.run({
      type: 'addKeyframes',
      keys: [0, 2].map((s) => ({
        prop: { layer: cam, path: 'transform/position' }, time: s * 705_600_000,
        value: vec3(W / 2 + s * 150, H / 2, -FOCAL), spatialIn: [], spatialOut: [],
      })),
    });
    await engineIdle();
    const before = (await resolveCommandCamera(cam, 0))!.camera;
    const beforeLater = (await resolveCommandCamera(cam, 1.5))!.camera;

    const nullId = await createOrbitNullEdit(cam, 0);
    expect(nullId).not.toBeNull();
    await engineIdle();
    const m = documentMirror();
    expect(m.layer(cam)!.parent).toBe(nullId);
    expect(useSelectionStore.getState().ids).toEqual([nullId]);
    await m.loadTree(nullId!);
    expect(valueOf(nullId!, 'transform/position')).toEqual(vec3(1000, H / 2, 200));

    // Local props are now relative to the null: POI sits at its origin.
    expect(valueOf(cam, 'camera/poiX')).toEqual(scalar(0));
    expect(valueOf(cam, 'camera/poiY')).toEqual(scalar(0));
    expect(valueOf(cam, 'camera/poiZ')).toEqual(scalar(0));
    // The keyframed Position moved by the same delta, every key.
    const keys = m.keyframes(cam, 'transform/position').map((k) => k.value);
    expect(keys).toEqual([vec3(W / 2 - 1000, 0, -FOCAL - 200), vec3(W / 2 + 300 - 1000, 0, -FOCAL - 200)]);

    // Resolved through the parent lift, the camera is exactly where it was.
    for (const [t, was] of [[0, before], [1.5, beforeLater]] as const) {
      const after = (await resolveCommandCamera(cam, t))!.camera;
      expect(after.position.x).toBeCloseTo(was.position.x, 6);
      expect(after.position.y).toBeCloseTo(was.position.y, 6);
      expect(after.position.z).toBeCloseTo(was.position.z, 6);
      expect(after.orientation?.yaw ?? 0).toBeCloseTo(was.orientation?.yaw ?? 0, 6);
    }
  });

  it('a one-node camera gets its null at the focus distance along the axis', async () => {
    const cam = await camera(false);
    await set(cam, 'camera/focusDistance', scalar(FOCAL + 400));
    const nullId = (await createOrbitNullEdit(cam, 0))!;
    await engineIdle();
    await documentMirror().loadTree(nullId);
    const p = valueOf(nullId, 'transform/position');
    expect(p?.kind).toBe('vec3');
    const v = (p as Extract<Value, { kind: 'vec3' }>).value;
    expect(v.x).toBeCloseTo(W / 2, 6);
    expect(v.y).toBeCloseTo(H / 2, 6);
    expect(v.z).toBeCloseTo(400, 6);
    const eye = (valueOf(cam, 'transform/position') as Extract<Value, { kind: 'vec3' }>).value;
    expect(eye.z).toBeCloseTo(-FOCAL - 400, 6);
  });
});

describe('Look at', () => {
  it('frames the subjects: POI at the centroid, distance that fits the enclosing sphere', async () => {
    const r = Math.hypot(200, 100) / 2;
    const f = framingFor([{ p: { x: 1200, y: 300, z: 500 }, r }, { p: { x: 400, y: 800, z: 0 }, r }], W, H)!;
    expect(f.poi).toEqual({ x: 800, y: 550, z: 250 });
    const spread = Math.hypot(400, 250, 250) + r;
    const fovV = Project3D.fovForFocalLength(H, FOCAL) * (Math.PI / 180);
    expect(f.distance).toBeCloseTo((spread / Math.sin(fovV / 2)) * 1.1, 6);
  });

  it('switches Active Camera to the last custom view and aims it, keeping its angle', async () => {
    const subject = await solid3D('Subject', 1200, 300, 500);
    useGuidesStore.getState().updateCustomView('custom2', { yaw: 50, pitch: -10 });
    useGuidesStore.setState({ lastCustomView: 'custom2' });
    const view = await lookAt([subject], 0);
    expect(view).toBe('custom2');
    const s = useGuidesStore.getState();
    expect(s.camera3dMode).toBe('custom2');
    expect(s.customViews.custom2).toMatchObject({ yaw: 50, pitch: -10, poi: { x: 1200, y: 300, z: 500 } });
    expect(s.customViews.custom2.distance).toBeGreaterThan(0);
  });
});

describe('commands', () => {
  it('enable on the right selections', async () => {
    const cam = await camera(true);
    const subject = await solid3D('Subject', 1200, 300, 500);
    const other = await solid3D('Other', 400, 800, 0);
    const byId = new Map(buildCameraCommands().map((c) => [String(c.id), c]));
    useSelectionStore.setState({ ids: [] });
    expect(byId.get('camera.createOrbitNull')!.enabled?.()).toBe(true);
    expect(byId.get('camera.setFocusToLayer')!.enabled?.()).toBe(false);
    expect(byId.get('camera.linkFocusToPoi')!.enabled?.()).toBe(true);
    expect(byId.get('view.lookAtSelected')!.enabled?.()).toBe(false);
    expect(byId.get('view.lookAtAll')!.enabled?.()).toBe(true);
    useSelectionStore.setState({ ids: [subject, cam] });
    expect(byId.get('camera.setFocusToLayer')!.enabled?.()).toBe(true);
    expect(byId.get('camera.linkFocusToLayer')!.enabled?.()).toBe(true);
    expect(byId.get('view.lookAtSelected')!.enabled?.()).toBe(true);
    useSelectionStore.setState({ ids: [subject, other] });
    expect(byId.get('camera.setFocusToLayer')!.enabled?.()).toBe(false);
  });
});
