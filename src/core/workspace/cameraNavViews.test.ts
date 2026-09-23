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
import { Project3D } from '@motion/scene';
import { defaultFocalLength } from '@core/scene/camera3d';
import { customViewCamera, defaultCustomViews, ORTHO_VIEW_ANGLES } from './customViews';
import {
  CAMERA_TOOL_CYCLE,
  dollyNavBy,
  findNavTarget,
  orbitCameraAboutPivot,
  orbitNavBy,
  resolveOrbitPivot,
  resolveViewCameraInput,
  sceneHasAny3D,
  trackNavBy,
  unifiedNavModeFor,
} from './cameraNav';
import { flushToolBursts } from './viewportGesture';
import { engineIdle } from '@core/engine/engineInstance';

/** A nav write outside a pointer gesture is a wheel-style burst: commit it and let the engine apply it. */
async function settle(): Promise<void> {
  flushToolBursts();
  await engineIdle();
}

const ROOT = 'camnav-views-root';
const SHAPE = 'camnav-views-shape';
const CAMERA = 'camnav-views-camera';

function makeNode(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props }],
  } as unknown as SceneNode;
}

/**
 * Layers live INSIDE a composition, never at the graph root.
 *
 * These lookups are comp-scoped now (a camera belongs to its composition and
 * steers nothing outside it), and `activeCompRootId()` falls back to the first
 * ROOT node. With the layers added as roots the first layer became the "comp"
 * and the search never reached its siblings — so the fixture has to model a
 * composition the way a real document does.
 */
function addComp(): void {
  defaultSceneGraph.addNode(makeNode(ROOT, { [SCENE_KIND_PROP]: 'group' }));
}

/** A 3D content layer (numeric z ⇒ is3DEnabled). */
function add3DShape(): void {
  addComp();
  defaultSceneGraph.addChild(ROOT,
    makeNode(SHAPE, { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, z: 0, rotationX: 0, rotationY: 0 }),
  );
}

function addCamera(): void {
  addComp();
  defaultSceneGraph.addChild(ROOT, makeNode(CAMERA, { [SCENE_KIND_PROP]: 'camera', x: 960, y: 540 }));
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

afterEach(async () => {
  await settle();
  for (const id of [SHAPE, CAMERA, ROOT]) {
    try { defaultSceneGraph.removeNode(id); } catch { /* not added in this test */ }
  }
});

describe('findNavTarget', () => {
  it("'active' without a camera layer → the default-view promotion target", () => {
    // AE's default view orbits without a camera (the first orbit lands in a
    // custom view); demanding Layer ▸ New ▸ Camera first was pure friction.
    // The straight-on 'front' seed is what keeps the first swing continuous.
    add3DShape();
    expect(findNavTarget()).toEqual({ kind: 'ortho', view: 'front' });
  });

  it("'active' with no 3D content at all → null (nothing to move around)", () => {
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

  it.each(['front', 'back', 'left', 'right', 'top', 'bottom'] as const)(
    "ortho view '%s' → its OWN target, never the scene camera",
    (view) => {
      add3DShape();
      addCamera(); // present, and must be ignored
      useGuidesStore.getState().setCamera3dMode(view);
      expect(findNavTarget()).toEqual({ kind: 'ortho', view });
    },
  );

  it('ortho view without any 3D layer → null', () => {
    useGuidesStore.getState().setCamera3dMode('top');
    expect(findNavTarget()).toBeNull();
  });
});

describe('ortho-view navigation never touches the scene camera', () => {
  beforeEach(() => {
    add3DShape();
    addCamera();
    useGuidesStore.getState().setCamera3dMode('top');
  });

  it('orbit promotes to a custom view seeded from the axis, leaving the scene camera alone', () => {
    const before = { ...camProps() };
    orbitNavBy({ kind: 'ortho', view: 'top' }, 10, 30);

    // Seeded from ORTHO_VIEW_ANGLES.top = { yaw: 0, pitch: -89 }, then dragged.
    const v = useGuidesStore.getState().customViews.custom1;
    expect(v.yaw).toBeCloseTo(0 + 4, 9); // 10 × 0.4
    expect(v.pitch).toBeCloseTo(-89 + 12, 9); // 30 × 0.4, tilting down off the pole
    // The viewport is now a custom view — the label changes, so the promotion
    // is visible rather than silent.
    expect(useGuidesStore.getState().camera3dMode).toBe('custom1');
    expect(camProps()).toEqual(before);
  });

  it('orbit writes no orbitYaw/orbitPitch onto the camera layer (the reported bug)', () => {
    orbitNavBy({ kind: 'ortho', view: 'left' }, 40, 25);
    expect(camProps().orbitYaw).toBeUndefined();
    expect(camProps().orbitPitch).toBeUndefined();
  });

  it('track and dolly leave every scene-camera prop untouched', () => {
    const before = { ...camProps() };
    trackNavBy({ kind: 'ortho', view: 'top' }, 10, 20, 1, 1920, 1080);
    dollyNavBy({ kind: 'ortho', view: 'top' }, -50, 1920, 1080);
    expect(camProps()).toEqual(before);
  });
});

describe('ORTHO_VIEW_ANGLES reproduce each axis view', () => {
  // The promotion must not make the scene jump: a custom view built at these
  // angles has to look down the SAME axis the ortho view looks down. The ortho
  // "into screen" direction is right × down (project3d's ORTHO_BASIS).
  const W = 1920;
  const H = 1080;
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

// ── Unified Camera tool + orbit pivot modes ─────────────────────────

describe('Unified Camera (button → gesture) and the C cycle', () => {
  it('maps left → orbit, middle → pan, right → dolly, anything else → null', () => {
    expect(unifiedNavModeFor(0)).toBe('orbit');
    expect(unifiedNavModeFor(1)).toBe('pan');
    expect(unifiedNavModeFor(2)).toBe('dolly');
    expect(unifiedNavModeFor(3)).toBeNull();
    expect(unifiedNavModeFor(4)).toBeNull();
  });

  it('C cycles unified → orbit → pan → dolly → unified (AE order), and the constant matches', () => {
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

describe('orbit pivot modes', () => {
  const W = 1920;
  const H = 1080;

  beforeEach(() => {
    useGuidesStore.setState({ cameraOrbitPivot: 'poi' });
  });

  it("'poi' resolves to null — the classic POI orbit stays the default", () => {
    expect(resolveOrbitPivot({ x: 100, y: 100 }, W, H, 'poi')).toBeNull();
  });

  it("'scene' resolves to the world origin", () => {
    expect(resolveOrbitPivot({ x: 123, y: 456 }, W, H, 'scene')).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("'cursor' over empty space falls back to the POI-distance plane facing the camera", () => {
    addCamera();
    // Straight through the principal point: the ray is the view axis, so the
    // pivot lands on the comp plane at the comp centre (the default camera
    // sits pulled back by its focal length, aimed at the centre).
    const p = resolveOrbitPivot({ x: W / 2, y: H / 2 }, W, H, 'cursor');
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(W / 2, 4);
    expect(p!.y).toBeCloseTo(H / 2, 4);
    expect(p!.z).toBeCloseTo(0, 4);
  });

  it("'cursor' below the horizon hits the ground plane (y = compHeight), not the top edge", () => {
    addCamera();
    const p = resolveOrbitPivot({ x: W / 2, y: H - 10 }, W, H, 'cursor');
    expect(p).not.toBeNull();
    // The 3D ground grid draws at y = compHeight (+ groundLevel, 0 here).
    expect(p!.y).toBeCloseTo(H, 3);
  });
});

describe('orbitCameraAboutPivot — a rigid orbit about an arbitrary world point', () => {
  const W = 1920;
  const H = 1080;
  const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  function nav() {
    return { nodeId: CAMERA, transId: `${CAMERA}_t` };
  }

  /** The eye the renderer would resolve from the written props (one-node). */
  function resolvedEyeOneNode(): { x: number; y: number; z: number } {
    const p = camProps() as Record<string, number | undefined>;
    const focal = p.focalLength ?? defaultFocalLength(W);
    const base = { x: p.x ?? W / 2, y: p.y ?? H / 2, z: p.z ?? -focal };
    return Project3D.orbitCamera(
      base, { x: W / 2, y: H / 2, z: 0 }, p.orbitYaw ?? 0, p.orbitPitch ?? 0,
    ).position;
  }

  it('one-node: the eye keeps its distance to the pivot, and the aim angles advance additively', async () => {
    add3DShape();
    addCamera();
    const pivot = { x: 0, y: 0, z: 0 };
    const before = resolvedEyeOneNode();
    const r0 = dist(before, pivot);

    orbitCameraAboutPivot(nav(), 25, 10, pivot, W, H); // Δyaw 10°, Δpitch 4°
    await settle();

    const p = camProps() as Record<string, number | undefined>;
    expect(p.orbitYaw).toBeCloseTo(10, 9);
    expect(p.orbitPitch).toBeCloseTo(4, 9);
    const after = resolvedEyeOneNode();
    expect(dist(after, pivot)).toBeCloseTo(r0, 6);
    // And it actually moved — a pivot orbit is not the in-place POI orbit.
    expect(dist(after, before)).toBeGreaterThan(1);
  });

  it('two-node: eye AND POI rotate rigidly about the pivot; orbitYaw/orbitPitch stay untouched', async () => {
    add3DShape();
    addCamera();
    // Make it a two-node camera aimed at the comp centre.
    defaultSceneGraph.writeProp(CAMERA, `${CAMERA}_t`, 'poiX', W / 2);
    defaultSceneGraph.writeProp(CAMERA, `${CAMERA}_t`, 'poiY', H / 2);
    defaultSceneGraph.writeProp(CAMERA, `${CAMERA}_t`, 'poiZ', 0);

    const pivot = { x: 300, y: 200, z: -100 };
    const p0 = camProps() as Record<string, number | undefined>;
    const focal = p0.focalLength ?? defaultFocalLength(W);
    const poiBefore = { x: W / 2, y: H / 2, z: 0 };
    const eyeBefore = { x: p0.x ?? W / 2, y: p0.y ?? H / 2, z: p0.z ?? -focal };
    const eyeToPoi = dist(eyeBefore, poiBefore);
    const poiToPivot = dist(poiBefore, pivot);

    orbitCameraAboutPivot(nav(), 25, 10, pivot, W, H);
    await settle();

    const p = camProps() as Record<string, number | undefined>;
    // The pivot is never written INTO the POI — the POI rotates, it is not re-targeted.
    const poiAfter = { x: p.poiX!, y: p.poiY!, z: p.poiZ! };
    expect(poiAfter).not.toEqual(pivot);
    expect(dist(poiAfter, pivot)).toBeCloseTo(poiToPivot, 6);
    // Rigid: the shot keeps framing its subject (eye→POI distance preserved;
    // orbit props untouched, so the resolved eye is base orbited by 0/0 = base).
    expect(p.orbitYaw ?? 0).toBe(0);
    expect(p.orbitPitch ?? 0).toBe(0);
    const eyeAfter = { x: p.x!, y: p.y!, z: p.z! };
    expect(dist(eyeAfter, poiAfter)).toBeCloseTo(eyeToPoi, 6);
    expect(dist(eyeAfter, pivot)).toBeCloseTo(dist(eyeBefore, pivot), 6);
  });

  it('orbitNavBy without a pivot keeps the classic POI orbit (no position writes)', async () => {
    add3DShape();
    addCamera();
    orbitNavBy({ kind: 'scene', nodeId: CAMERA, transId: `${CAMERA}_t` }, 10, 5, null);
    await settle();
    const p = camProps() as Record<string, number | undefined>;
    expect(p.orbitYaw).toBeCloseTo(4, 9);
    expect(p.orbitPitch).toBeCloseTo(2, 9);
    // x/y untouched (the fixture's 960/540), z never written.
    expect(p.x).toBe(960);
    expect(p.y).toBe(540);
    expect(p.z).toBeUndefined();
  });
});
