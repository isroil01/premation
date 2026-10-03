/**
 * Mode-aware camera navigation (cameraNav.ts) — the routing contract for
 * AE-style custom views:
 *
 *   - the nav target (viewGeometry.ts `navTargetOf`, what the viewport asks of
 *     the frame on screen): 'active' needs a 3D layer and drives the camera
 *     the renderer looks through; a CUSTOM view needs only a 3D layer (view
 *     target, no camera required);
 *   - orbit/track/dolly on a view target write the STORED params in
 *     guidesStore and never touch the document — the shot camera stays put;
 *   - scene-camera nav reads the camera off the document mirror and writes
 *     through the engine;
 *   - resolveViewCameraInput maps a custom mode to an override camera and
 *     everything else straight through.
 */

import type { OverlayView, Value } from '@motion/engine-api';
import { Project3D } from '@motion/scene';
import { useGuidesStore } from '@stores/guidesStore';
import { documentMirror } from '@stores/documentMirror';
import { defaultFocalLength } from '@core/scene/camera3d';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { navTargetOf, orbitPivotFrom } from '@core/mirror/viewGeometry';
import { customViewCamera, defaultCustomViews, ORTHO_VIEW_ANGLES } from './customViews';
import {
  CAMERA_TOOL_CYCLE,
  dollyNavBy,
  orbitCameraAboutPivot,
  orbitNavBy,
  resolveViewCameraInput,
  trackNavBy,
  unifiedNavModeFor,
} from './cameraNav';
import { flushToolBursts, settleToolEdits } from './viewportGesture';

const W = 1920;
const H = 1080;

/** A nav write outside a pointer gesture is a wheel-style burst: commit it and let the engine apply it. */
async function settle(): Promise<void> {
  flushToolBursts();
  // The burst closes its engine gesture a few round trips after the flush; then the mirror catches up.
  await settleToolEdits();
  await engineIdle();
  await documentMirror().whenIdle();
}

beforeEach(() => {
  useGuidesStore.setState({
    camera3dMode: 'active',
    customViews: defaultCustomViews(),
    lastCustomView: 'custom1',
  });
});

describe('the nav target of a view (navTargetOf over the frame on screen)', () => {
  const view = (liveCamera: string): OverlayView => ({
    mode: 'active', camera: liveCamera, liveCamera, lens: [], compWidth: W, compHeight: H,
  });

  it("'active' without a camera layer → the default-view promotion target", async () => {
    // AE's default view orbits without a camera (the first orbit lands in a
    // custom view); demanding Layer ▸ New ▸ Camera first was pure friction.
    // The straight-on 'front' seed is what keeps the first swing continuous.
    expect(navTargetOf('active', view(''), true)).toEqual({ kind: 'ortho', view: 'front' });
  });

  it("no 3D content at all → null (nothing to move around), in every mode", async () => {
    for (const mode of ['active', 'custom1', 'top']) expect(navTargetOf(mode, view('cam'), false)).toBeNull();
  });

  it("'active' / a camera view → the camera the renderer looks through", async () => {
    expect(navTargetOf('active', view('cam_1'), true)).toEqual({ kind: 'scene', nodeId: 'cam_1', transId: '' });
    expect(navTargetOf('camera:cam_2', view('cam_2'), true)).toEqual({ kind: 'scene', nodeId: 'cam_2', transId: '' });
  });

  it('custom view with a 3D layer → view target, NO camera layer needed', async () => {
    expect(navTargetOf('custom2', undefined, true)).toEqual({ kind: 'view', viewId: 'custom2' });
  });

  it.each(['front', 'back', 'left', 'right', 'top', 'bottom'] as const)(
    "ortho view '%s' → its OWN target, never the scene camera",
    (v) => {
      expect(navTargetOf(v, view('cam'), true)).toEqual({ kind: 'ortho', view: v });
    },
  );
});

describe('view navigation never touches the document', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setupAppEngine();
    await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Camera 1', init: [] });
    await engineIdle();
  });
  afterEach(async () => {
    await settle();
    await h.dispose();
  });

  it('ortho orbit promotes to a custom view seeded from the axis, leaving the scene camera alone', async () => {
    useGuidesStore.getState().setCamera3dMode('top');
    const before = (await h.doc());
    orbitNavBy({ kind: 'ortho', view: 'top' }, 10, 30);
    await settle();

    // Seeded from ORTHO_VIEW_ANGLES.top = { yaw: 0, pitch: -89 }, then dragged.
    const v = useGuidesStore.getState().customViews.custom1;
    expect(v.yaw).toBeCloseTo(0 + 4, 9); // 10 × 0.4
    expect(v.pitch).toBeCloseTo(-89 + 12, 9); // 30 × 0.4, tilting down off the pole
    // The viewport is now a custom view — the label changes, so the promotion
    // is visible rather than silent.
    expect(useGuidesStore.getState().camera3dMode).toBe('custom1');
    expect((await h.doc())).toBe(before);
  });

  it('ortho track and dolly leave the document untouched', async () => {
    useGuidesStore.getState().setCamera3dMode('top');
    const before = (await h.doc());
    trackNavBy({ kind: 'ortho', view: 'top' }, 10, 20, 1, W, H);
    dollyNavBy({ kind: 'ortho', view: 'top' }, -50, W, H);
    await settle();
    expect((await h.doc())).toBe(before);
  });

  it('custom-view orbit updates yaw/pitch in guidesStore.customViews only', async () => {
    useGuidesStore.getState().setCamera3dMode('custom1');
    const before = (await h.doc());
    orbitNavBy({ kind: 'view', viewId: 'custom1' }, 10, -5);
    await settle();
    const v = useGuidesStore.getState().customViews.custom1;
    expect(v.yaw).toBeCloseTo(35 + 4, 9); // default 35 + 10 × 0.4
    expect(v.pitch).toBeCloseTo(-20 - 2, 9); // default −20 + (−5) × 0.4
    expect((await h.doc())).toBe(before);
  });

  it('custom-view track resolves the default POI against the comp size, then shifts it opposite the drag', async () => {
    useGuidesStore.getState().setCamera3dMode('custom1');
    const before = (await h.doc());
    trackNavBy({ kind: 'view', viewId: 'custom1' }, 10, 20, 1, W, H);
    await settle();
    const v = useGuidesStore.getState().customViews.custom1;
    expect(v.poi).toEqual({ x: 960 - 10, y: 540 - 20, z: 0 });
    expect((await h.doc())).toBe(before);
  });

  it('custom-view dolly resolves the default distance, then moves along the view axis', async () => {
    useGuidesStore.getState().setCamera3dMode('custom1');
    const before = (await h.doc());
    dollyNavBy({ kind: 'view', viewId: 'custom1' }, -50, W, H);
    await settle();
    const v = useGuidesStore.getState().customViews.custom1;
    expect(typeof v.distance).toBe('number');
    expect(v.distance!).toBeGreaterThan(0);
    expect((await h.doc())).toBe(before);
  });
});

describe('ORTHO_VIEW_ANGLES reproduce each axis view', () => {
  // The promotion must not make the scene jump: a custom view built at these
  // angles has to look down the SAME axis the ortho view looks down. The ortho
  // "into screen" direction is right × down (project3d's ORTHO_BASIS).
  const AXIS: Record<string, { x: number; y: number; z: number }> = {
    front: { x: 0, y: 0, z: 1 },
    back: { x: 0, y: 0, z: -1 },
    left: { x: 1, y: 0, z: 0 },
    right: { x: -1, y: 0, z: 0 },
    top: { x: 0, y: 1, z: 0 },
    bottom: { x: 0, y: -1, z: 0 },
  };

  it.each(Object.keys(AXIS))('%s', (view) => {
    const a = ORTHO_VIEW_ANGLES[view as keyof typeof ORTHO_VIEW_ANGLES];
    const cam = customViewCamera({ ...a, distance: null, poi: null }, W, H);
    const poi = { x: W / 2, y: H / 2, z: 0 };
    // Eye → POI, normalised, should be the view axis.
    const d = { x: poi.x - cam.position.x, y: poi.y - cam.position.y, z: poi.z - cam.position.z };
    const len = Math.hypot(d.x, d.y, d.z);
    const want = AXIS[view]!;
    // Top/bottom are clamped to ±89°, so allow 1° of slop on those.
    expect(d.x / len).toBeCloseTo(want.x, 1);
    expect(d.y / len).toBeCloseTo(want.y, 1);
    expect(d.z / len).toBeCloseTo(want.z, 1);
  });
});

describe('resolveViewCameraInput', () => {
  it('passes active / ortho modes straight through with no override camera', async () => {
    expect(resolveViewCameraInput(W, H, 'active')).toEqual({ camera3dMode: 'active' });
    expect(resolveViewCameraInput(W, H, 'top')).toEqual({ camera3dMode: 'top' });
  });

  it('maps a custom mode to {active + the stored-params camera}', async () => {
    useGuidesStore.getState().updateCustomView('custom3', { yaw: 12, pitch: -8, distance: 1200 });
    const input = resolveViewCameraInput(W, H, 'custom3');
    expect(input.camera3dMode).toBe('active');
    expect(input.customViewCamera).toEqual(
      customViewCamera(useGuidesStore.getState().customViews.custom3, W, H),
    );
  });

  it('defaults to the store camera3dMode when no mode is passed', async () => {
    useGuidesStore.getState().setCamera3dMode('custom1');
    expect(resolveViewCameraInput(W, H).customViewCamera).toBeDefined();
    expect(useGuidesStore.getState().lastCustomView).toBe('custom1');
  });
});

describe('guidesStore custom-view state', () => {
  it('updateCustomView merges a partial patch', async () => {
    useGuidesStore.getState().updateCustomView('custom2', { yaw: 99 });
    const v = useGuidesStore.getState().customViews.custom2;
    expect(v.yaw).toBe(99);
    expect(v.pitch).toBe(-20); // untouched default
  });

  it('setCamera3dMode records the last custom view for the `2` shortcut', async () => {
    useGuidesStore.getState().setCamera3dMode('custom3');
    useGuidesStore.getState().setCamera3dMode('active');
    expect(useGuidesStore.getState().lastCustomView).toBe('custom3');
  });
});

// ── Unified Camera tool + orbit pivot modes ─────────────────────────

describe('Unified Camera (button → gesture) and the C cycle', () => {
  it('maps left → orbit, middle → pan, right → dolly, anything else → null', async () => {
    expect(unifiedNavModeFor(0)).toBe('orbit');
    expect(unifiedNavModeFor(1)).toBe('pan');
    expect(unifiedNavModeFor(2)).toBe('dolly');
    expect(unifiedNavModeFor(3)).toBeNull();
    expect(unifiedNavModeFor(4)).toBeNull();
  });

  it('C cycles unified → orbit → pan → dolly → unified (AE order), and the constant matches', async () => {
    useGuidesStore.setState({ cameraTool: 'none' });
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      useGuidesStore.getState().cycleCameraTool();
      seen.push(useGuidesStore.getState().cameraTool);
    }
    expect(seen).toEqual(['unified', 'orbit', 'pan', 'dolly', 'unified']);
    expect(CAMERA_TOOL_CYCLE).toEqual(['unified', 'orbit', 'pan', 'dolly']);
  });
});

describe('orbit pivot modes (orbitPivotFrom, resolved at drag start)', () => {
  const cam = Project3D.defaultCamera(W, H);

  it("'poi' resolves to null — the classic POI orbit stays the default", async () => {
    expect(orbitPivotFrom({ x: 100, y: 100 }, 'poi', cam, [], W, H, 0, null)).toBeNull();
  });

  it("'scene' resolves to the world origin", async () => {
    expect(orbitPivotFrom({ x: 123, y: 456 }, 'scene', cam, [], W, H, 0, null)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("'cursor' over empty space falls back to the POI-distance plane facing the camera", async () => {
    // Straight through the principal point: the ray is the view axis, so the
    // pivot lands on the comp plane at the comp centre (the default camera
    // sits pulled back by its focal length, aimed at the centre).
    const p = orbitPivotFrom({ x: W / 2, y: H / 2 }, 'cursor', cam, [], W, H, 0, null);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(W / 2, 4);
    expect(p!.y).toBeCloseTo(H / 2, 4);
    expect(p!.z).toBeCloseTo(0, 4);
  });

  it("'cursor' below the horizon hits the ground plane (y = compHeight), not the top edge", async () => {
    const p = orbitPivotFrom({ x: W / 2, y: H - 10 }, 'cursor', cam, [], W, H, 0, null);
    expect(p).not.toBeNull();
    // The 3D ground grid draws at y = compHeight (+ groundLevel, 0 here).
    expect(p!.y).toBeCloseTo(H, 3);
  });
});

describe('scene-camera navigation — read off the mirror, written through the engine', () => {
  let h: Harness;
  let cam: string;
  const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const nav = () => ({ nodeId: cam, transId: '' });

  beforeEach(async () => {
    h = await setupAppEngine();
    cam = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Camera 1', init: [] })).layer;
    await engineIdle();
    await documentMirror().loadTree(cam);
  });
  afterEach(async () => {
    await settle();
    await h.dispose();
  });

  const num = (path: string): number | undefined => {
    const v = documentMirror().property(cam, path)?.value;
    return v?.kind === 'scalar' ? v.value : undefined;
  };
  const eyeProps = (): { x: number; y: number; z: number } => {
    const v = documentMirror().property(cam, 'transform/position')?.value as Extract<Value, { kind: 'vec3' }>;
    return v.value;
  };

  /** The eye the renderer would resolve from the written props (one-node). */
  function resolvedEyeOneNode(): { x: number; y: number; z: number } {
    return Project3D.orbitCamera(eyeProps(), { x: W / 2, y: H / 2, z: 0 }, num('camera/orbitYaw') ?? 0, num('camera/orbitPitch') ?? 0).position;
  }

  it('one-node: the eye keeps its distance to the pivot, and the aim angles advance additively', async () => {
    const pivot = { x: 0, y: 0, z: 0 };
    const before = resolvedEyeOneNode();
    const r0 = dist(before, pivot);

    orbitCameraAboutPivot(nav(), 25, 10, pivot, W, H); // Δyaw 10°, Δpitch 4°
    await settle();

    expect(num('camera/orbitYaw')).toBeCloseTo(10, 9);
    expect(num('camera/orbitPitch')).toBeCloseTo(4, 9);
    const after = resolvedEyeOneNode();
    expect(dist(after, pivot)).toBeCloseTo(r0, 6);
    // And it actually moved — a pivot orbit is not the in-place POI orbit.
    expect(dist(after, before)).toBeGreaterThan(1);
  });

  it('two-node: eye AND POI rotate rigidly about the pivot; orbitYaw/orbitPitch stay untouched', async () => {
    // A two-node camera aimed at the comp centre.
    await h.run({ type: 'setProperty', prop: { layer: cam, path: 'transform/orientTowardsPointOfInterest' }, value: { kind: 'bool', value: true } });
    await engineIdle();

    const pivot = { x: 300, y: 200, z: -100 };
    const poiBefore = { x: num('camera/poiX')!, y: num('camera/poiY')!, z: num('camera/poiZ')! };
    expect(poiBefore).toEqual({ x: W / 2, y: H / 2, z: 0 });
    const eyeBefore = eyeProps();
    expect(eyeBefore.z).toBeCloseTo(-defaultFocalLength(W), 6);
    const eyeToPoi = dist(eyeBefore, poiBefore);
    const poiToPivot = dist(poiBefore, pivot);

    orbitCameraAboutPivot(nav(), 25, 10, pivot, W, H);
    await settle();

    // The pivot is never written INTO the POI — the POI rotates, it is not re-targeted.
    const poiAfter = { x: num('camera/poiX')!, y: num('camera/poiY')!, z: num('camera/poiZ')! };
    expect(poiAfter).not.toEqual(pivot);
    expect(dist(poiAfter, pivot)).toBeCloseTo(poiToPivot, 6);
    // Rigid: the shot keeps framing its subject (eye→POI distance preserved;
    // orbit props untouched, so the resolved eye is base orbited by 0/0 = base).
    expect(num('camera/orbitYaw') ?? 0).toBe(0);
    expect(num('camera/orbitPitch') ?? 0).toBe(0);
    const eyeAfter = eyeProps();
    expect(dist(eyeAfter, poiAfter)).toBeCloseTo(eyeToPoi, 6);
    expect(dist(eyeAfter, pivot)).toBeCloseTo(dist(eyeBefore, pivot), 6);
  });

  it('orbitNavBy without a pivot keeps the classic POI orbit (no position writes)', async () => {
    const before = eyeProps();
    orbitNavBy({ kind: 'scene', nodeId: cam, transId: '' }, 10, 5, null);
    await settle();
    expect(num('camera/orbitYaw')).toBeCloseTo(4, 9);
    expect(num('camera/orbitPitch')).toBeCloseTo(2, 9);
    expect(eyeProps()).toEqual(before);
  });
});
