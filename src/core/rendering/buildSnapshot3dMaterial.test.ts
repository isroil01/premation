/**
 * Renderer wiring for the AE-parity 3D additions:
 * Auto-Orient → Towards Camera, the `Only` shadow modes, and Zoom ↔ Angle of
 * View staying two views of one value.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { Project3D, Matrix4Math } from '@motion/scene';

const COMP = { width: 800, height: 600, background: '#101014' };

function layer(
  id: string,
  transform: Record<string, unknown> = {},
  fx?: Record<string, unknown>,
): SceneNode {
  const components: Array<Record<string, unknown>> = [
    {
      id: `${id}_t`,
      type: 'Transform',
      props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0, width: 100, height: 100, ...transform },
    },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
  ];
  if (fx) components.push({ id: `${id}_fx`, type: 'fx', props: fx });
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components,
  } as unknown as SceneNode;
}

function camera(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'camera', ...props } }],
  } as unknown as SceneNode;
}

function light(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', castShadows: true, ...props } }],
  } as unknown as SceneNode;
}

function snap(nodes: SceneNode[]) {
  const g = new SceneGraph();
  for (const n of nodes) g.addNode(n);
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP as never);
}

const byId = (s: ReturnType<typeof snap>, id: string) => s.layers.find((l) => l.id === id);

/** The layer's world-space facing: the +Z column of its 4×4 model matrix. */
function normalOf(world: readonly number[]): { x: number; y: number; z: number } {
  const [x, y, z] = [world[8]!, world[9]!, world[10]!];
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

describe('Auto-Orient → Towards Camera (AE per-layer, opt-in billboard)', () => {
  const eye = { x: 400, y: 300, z: -1000 };
  const cam = () => camera('cam', { x: eye.x, y: eye.y, z: eye.z, focalLength: 1000 });

  it('turns an OFF-AXIS layer to face the camera', () => {
    const off = { x: 700, y: 300, z: 400 };
    const s = snap([cam(), layer('n', { ...off, z: off.z, rotationX: 0, rotationY: 0 }, { autoOrient: 'camera' })]);
    const n = normalOf(byId(s, 'n')!.world3d!);
    // The layer's normal must point back at the eye.
    const want = { x: eye.x - off.x, y: eye.y - off.y, z: eye.z - off.z };
    const len = Math.hypot(want.x, want.y, want.z);
    expect(n.x).toBeCloseTo(want.x / len, 5);
    expect(n.y).toBeCloseTo(want.y / len, 5);
    expect(n.z).toBeCloseTo(want.z / len, 5);
  });

  it('leaves an ON-AXIS layer facing straight back, as before', () => {
    const s = snap([cam(), layer('n', { z: 0, rotationX: 0, rotationY: 0 }, { autoOrient: 'camera' })]);
    const n = normalOf(byId(s, 'n')!.world3d!);
    expect(n.z).toBeCloseTo(-1, 5);
  });

  it('overrides the layer\'s own rotation — that is the point of auto-orient', () => {
    const off = { x: 700, y: 300 };
    const free = snap([cam(), layer('n', { ...off, z: 400, rotationY: 70 })]);
    const bill = snap([cam(), layer('n', { ...off, z: 400, rotationY: 70 }, { autoOrient: 'camera' })]);
    expect(normalOf(byId(bill, 'n')!.world3d!)).not.toEqual(normalOf(byId(free, 'n')!.world3d!));
  });

  it('does NOT billboard layers that did not opt in — the global-billboard bug', () => {
    // If every layer faced the viewer, rotating the view would change nothing
    // and the scene would look permanently flat-on. Only the flagged one moves.
    const s = snap([cam(), layer('plain', { x: 700, z: 400, rotationX: 0, rotationY: 0 })]);
    expect(normalOf(byId(s, 'plain')!.world3d!).z).toBeCloseTo(1, 5);
  });

  it('ignores the flag on a 2D layer (nothing to face a camera with)', () => {
    const s = snap([cam(), layer('flat', {}, { autoOrient: 'camera' })]);
    expect(byId(s, 'flat')!.world3d).toBeUndefined();
  });
});

describe('shadow `Only` modes (shadow-catcher workflow)', () => {
  const scene = (casts: unknown, accepts: unknown) =>
    snap([
      light('L', { x: 400, y: 100, z: -400, intensity: 100 }),
      layer('caster', { z: 0, rotationX: 0, rotationY: 0, castsShadows: casts }),
      layer('floor', { z: 600, rotationX: 0, rotationY: 0, acceptsShadows: accepts }),
    ]);

  it('normally draws both layers', () => {
    const s = scene(undefined, undefined);
    expect(byId(s, 'caster')!.visible).not.toBe(false);
    expect(byId(s, 'floor')!.visible).not.toBe(false);
  });

  it("`Casts Shadows: Only` hides the caster but KEEPS its shadow", () => {
    const s = scene('only', undefined);
    expect(byId(s, 'caster')!.visible).toBe(false);
    const shadow = s.layers.find((l) => l.id === 'caster::shadow');
    expect(shadow).toBeDefined();
    // The shadow must not inherit the caster's invisibility — that would make
    // the mode delete the very thing it exists to produce.
    expect(shadow!.visible).toBe(true);
  });

  it("`Accepts Shadows: Only` hides the receiver and still catches the shadow", () => {
    const s = scene(undefined, 'only');
    expect(byId(s, 'floor')!.visible).toBe(false);
    expect(s.layers.find((l) => l.id === 'caster::shadow')).toBeDefined();
  });

  it('`off` removes the layer from the shadow pass entirely', () => {
    const s = scene(false, undefined);
    expect(s.layers.find((l) => l.id === 'caster::shadow')).toBeUndefined();
    expect(byId(s, 'caster')!.visible).not.toBe(false); // …but still draws
  });
});

describe('Light Transmission tints the shadow', () => {
  const scene = (transmission?: number) =>
    snap([
      light('L', { x: 400, y: 100, z: -400, intensity: 100 }),
      layer('caster', { z: 0, rotationX: 0, rotationY: 0, ...(transmission === undefined ? {} : { lightTransmission: transmission }) }),
      layer('floor', { z: 600, rotationX: 0, rotationY: 0 }),
    ]);

  it('is a black silhouette at 0 (the pre-transmission behaviour)', () => {
    const shadow = scene()!.layers.find((l) => l.id === 'caster::shadow')!;
    expect(shadow.fill).toBe('#000000');
    expect(shadow.filter).toContain('brightness(0)');
  });

  it("takes the caster's colour as transmission rises", () => {
    const shadow = scene(100).layers.find((l) => l.id === 'caster::shadow')!;
    expect(shadow.fill).toBe('#2b7eff');
    // brightness(0) would crush the transmitted colour straight back to black.
    expect(shadow.filter).not.toContain('brightness(0)');
  });
});

describe('Zoom and Angle of View are two views of one value', () => {
  it('round-trips through both conversions', () => {
    for (const fov of [15, 39.6, 73, 100, 150]) {
      const focal = Project3D.focalLengthForFov(800, fov);
      expect(Project3D.fovForFocalLength(800, focal)).toBeCloseTo(fov, 6);
    }
  });

  it('a wider angle means a shorter zoom, monotonically', () => {
    const f = (fov: number) => Project3D.focalLengthForFov(800, fov);
    expect(f(100)).toBeLessThan(f(50));
    expect(f(50)).toBeLessThan(f(15));
  });

  it('the default camera reports the field of view it was built from', () => {
    const cam = Project3D.defaultCamera(800, 600, 39.6);
    expect(Project3D.fovForFocalLength(800, cam.focalLength)).toBeCloseTo(39.6, 6);
  });
});

describe('shadow darkness and diffusion', () => {
  const scene = (props: Record<string, unknown>) =>
    snap([
      light('L', { x: 400, y: 100, z: -400, intensity: 100, ...props }),
      layer('caster', { z: 0, rotationX: 0, rotationY: 0 }),
      layer('floor', { z: 600, rotationX: 0, rotationY: 0 }),
    ]);
  const shadowOf = (s: ReturnType<typeof snap>) => s.layers.find((l) => l.id === 'caster::shadow')!;

  it('darkness scales the shadow opacity (100% = the previous look)', () => {
    const full = shadowOf(scene({}));
    const half = shadowOf(scene({ shadowDarkness: 50 }));
    expect(shadowOf(scene({ shadowDarkness: 100 })).opacity).toBeCloseTo(full.opacity, 9);
    expect(half.opacity).toBeCloseTo(full.opacity / 2, 6);
  });

  it('diffusion adds softness on top of the distance-driven blur', () => {
    const amount = (s: ReturnType<typeof snap>) =>
      (shadowOf(s).effects!.find((e) => e.id === 'shadow-blur')!.params as { amount: number }).amount;
    expect(amount(scene({ shadowDiffusion: 40 }))).toBeCloseTo(amount(scene({})) + 40, 6);
  });
});

describe('nothing above disturbs a plain 3D layer', () => {
  it('a layer with no material or auto-orient props renders exactly as before', () => {
    const s = snap([camera('cam', { x: 400, y: 300, z: -1000, focalLength: 1000 }), layer('n', { z: 500, rotationX: 0, rotationY: 0 })]);
    const l = byId(s, 'n')!;
    expect(l.visible).not.toBe(false);
    // Straight pinhole scale at twice the focal distance.
    expect(l.scaleX).toBeCloseTo(1000 / 1500, 6);
    expect(normalOf(l.world3d!).z).toBeCloseTo(1, 6);
    expect(Matrix4Math.transformPoint(l.world3d as never, { x: 0, y: 0, z: 0 }).z).toBeCloseTo(500, 6);
  });
});
