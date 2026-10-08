/**
 * Overlays drawn ON a layer see a 3D layer through the VIEW ON SCREEN.
 *
 * Regression (2026-10-08, overlays "somewhere other than where the engine
 * renders the layer", especially in 3D): `layerScreenMapping` — the projection
 * the puppet / bone pins, the effect and gradient handles, the roto strokes and
 * the track points all draw and hit-test through — always projected a 3D layer
 * through the ACTIVE camera. In an axis view, a custom view or another camera's
 * view (`camera:<id>`) the handles sat where the active camera would have drawn
 * the layer, not on it. Face picking (`projectFacesForView`) took the active
 * camera for a `camera:<id>` view the same way.
 *
 * No engine: the frame geometry is published here the way EngineSurface
 * publishes a frame's, and the mirror's layer header is stubbed (the 3D switch
 * is all `layerScreenMapping` reads of it).
 */

import type { OverlayLayerGeometry, OverlayView } from '@motion/engine-api';
import { Project3D, type Vec3 } from '@motion/scene';
import { cameraOfLens } from '@core/mirror/viewGeometry';
import { customViewCamera, type CustomViewParams } from '@core/workspace/customViews';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { MAIN_VIEWPORT, publishFrameGeometry, publishFrameView, setEngineDrivenViewport } from '@stores/overlayGeometry';
import { layerScreenMapping } from './layerScreen';
import { projectFacesForView } from './layerFaces';
import type { Camera2DLike } from './cameraTypes';

jest.mock('@stores/documentMirror', () => {
  const actual = jest.requireActual('@stores/documentMirror');
  // One 3D layer, as the mirror's header carries it.
  const layers: Record<string, unknown> = { L3: { id: 'L3', kind: 'shape', switches: { threeD: true } } };
  const mirror = {
    layer: (id: string) => layers[id],
    layerIds: () => Object.keys(layers),
    subscribe: () => () => undefined,
    revision: 0,
  };
  return { ...actual, documentMirror: () => mirror };
});

const W = 1920;
const H = 1080;
const COMP = { width: W, height: H };
const c30 = Math.cos(Math.PI / 6);
const s30 = Math.sin(Math.PI / 6);
/** The layer's world matrix (column-major): turned 30° about Y, at (300, 200, 150). */
const WORLD = [c30, 0, -s30, 0, 0, 1, 0, 0, s30, 0, c30, 0, 300, 200, 150, 1];
/** The Active Camera and a second camera, as the push resolves them (position, focal length, principal, yaw, pitch, roll). */
const ACTIVE_LENS = [960, 540, -2400, 2400, 960, 540, 15, -5, 0];
const CAM2_LENS = [200, 300, -1500, 1600, 960, 540, -25, 8, 0];

/** 1:1 and unpanned: screen px ARE comp px, so the numbers are the projection's own. */
const SCREEN: Camera2DLike = { worldToScreen: (p) => ({ x: p.x, y: p.y }), screenToWorld: (p) => ({ x: p.x, y: p.y }) };

const record = (layer: string, matrix: number[]): OverlayLayerGeometry => ({
  layer, matrix, box: [0, 0, 200, 100], corners: [], path: [], pathKeys: [], pins: [], bones: [], textBox: [], pathFrames: [], pathNow: [], local: [],
});
const viewOf = (mode: string, camera: string, lens: number[]): OverlayView => ({ mode, camera, liveCamera: camera, lens, compWidth: W, compHeight: H });

/** A layer-local point in world space. */
const worldOf = (lx: number, ly: number): Vec3 => ({
  x: WORLD[0]! * lx + WORLD[4]! * ly + WORLD[12]!,
  y: WORLD[1]! * lx + WORLD[5]! * ly + WORLD[13]!,
  z: WORLD[2]! * lx + WORLD[6]! * ly + WORLD[14]!,
});

/** The layer's corners and a point inside it, layer px. */
const PROBES: ReadonlyArray<[number, number]> = [[0, 0], [200, 0], [200, 100], [0, 100], [73, 41]];

/** The mapping in view `mode` must be `project` (world → comp), and invert back onto the layer. */
function expectThrough(mode: Camera3dMode, project: (p: Vec3) => { x: number; y: number }): void {
  useGuidesStore.getState().setCamera3dMode(mode);
  const m = layerScreenMapping('L3', 0, COMP, SCREEN);
  expect(m).not.toBeNull();
  for (const [lx, ly] of PROBES) {
    const want = project(worldOf(lx, ly));
    const got = m!.localToScreen(lx, ly);
    expect(got.x).toBeCloseTo(want.x, 4);
    expect(got.y).toBeCloseTo(want.y, 4);
    // A pointer over that spot of the picture lands on that spot of the layer.
    const back = m!.screenToLocal(want.x, want.y);
    expect(back.x).toBeCloseTo(lx, 3);
    expect(back.y).toBeCloseTo(ly, 3);
  }
}

const throughActive = (p: Vec3): Project3D.Projected => Project3D.projectPoint(p, cameraOfLens(ACTIVE_LENS)!);

const initialMode = useGuidesStore.getState().camera3dMode;
const initialCustom = useGuidesStore.getState().customViews;

beforeEach(() => {
  setEngineDrivenViewport(MAIN_VIEWPORT, true);
  publishFrameGeometry(MAIN_VIEWPORT, 0, 1, [record('L3', WORLD)], [viewOf('active', 'cam1', ACTIVE_LENS), viewOf('camera:cam2', 'cam2', CAM2_LENS)]);
});

afterEach(() => {
  setEngineDrivenViewport(MAIN_VIEWPORT, false);
  useGuidesStore.setState({ camera3dMode: initialMode, customViews: initialCustom });
});

describe('a layer-attached overlay projects a 3D layer through the view on screen', () => {
  it('Active Camera: the active camera the push resolved', () => {
    expectThrough('active', throughActive);
  });

  it('an axis view: its orthographic projection, not the active camera', () => {
    expectThrough('left', (p) => Project3D.projectOrtho(p, 'left', W, H));
    // …which is a different place on screen: the old projection would miss the layer.
    const m = layerScreenMapping('L3', 0, COMP, SCREEN)!;
    const old = throughActive(worldOf(73, 41));
    const now = m.localToScreen(73, 41);
    expect(Math.hypot(now.x - old.x, now.y - old.y)).toBeGreaterThan(50);
  });

  it('another camera’s view (`camera:<id>`): THAT camera, not the active one', () => {
    expectThrough('camera:cam2', (p) => Project3D.projectPoint(p, cameraOfLens(CAM2_LENS)!));
  });

  it('a custom view: its orbit — as the frame on screen was drawn while the engine is behind the stored one', () => {
    const stored: CustomViewParams = { yaw: 35, pitch: -20, distance: null, poi: null };
    useGuidesStore.getState().updateCustomView('custom1', stored);
    expectThrough('custom1', (p) => Project3D.projectPoint(p, customViewCamera(stored, W, H)));

    // The frame on screen was drawn with an earlier orbit (the stored one has moved on).
    const drawn: CustomViewParams = { yaw: 10, pitch: -5, distance: 2600, poi: { x: 700, y: 500, z: 0 } };
    publishFrameView(MAIN_VIEWPORT, { render: { scale: 0.5, offsetX: 160, offsetY: 90 }, view: 'custom', customView: drawn });
    expectThrough('custom1', (p) => Project3D.projectPoint(p, customViewCamera(drawn, W, H)));
  });
});

describe('face picking projects through the view on screen', () => {
  it('a `camera:<id>` view picks through that camera, not the active one', () => {
    useGuidesStore.getState().setCamera3dMode('camera:cam2');
    const points = [worldOf(0, 0), worldOf(200, 0), worldOf(200, 100), worldOf(0, 100)];
    const [face] = projectFacesForView([{ kind: 'front', suffix: '', points }], 0, W, H);
    const cam2 = cameraOfLens(CAM2_LENS)!;
    expect(face).toBeDefined();
    face!.quad.forEach((q, i) => {
      const want = Project3D.projectPoint(points[i]!, cam2);
      expect(q.x).toBeCloseTo(want.x, 6);
      expect(q.y).toBeCloseTo(want.y, 6);
    });
  });
});
