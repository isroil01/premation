/**
 * A TARGETED light aims at its target — everywhere, not just in the blueprint.
 *
 * Reported as: "I added a light, made it a spot, created a target and selected
 * it, then moved the light around — the light is NOT directing its light at the
 * target; only the blueprint (the cone gizmo) points at the target."
 *
 * That is exactly what the code did. Three of the four consumers resolved a
 * targeted light's aim as `poi − position` in real 3D — the per-fragment shader
 * (`toShaderLights` → `resolvedAim`), the per-quad Lambert term (`shadeLayer`)
 * and the viewport cone gizmo (`buildLightGizmo`, which takes the POI directly).
 * The glow WASH did not: `buildSnapshot` aimed its quad with `nodeLightAimDeg`,
 * i.e. Direction + world rotation, which a POI is supposed to override outright.
 * Since the wash IS the light you see in a 2.5D comp, a targeted spot read as
 * not aiming at its target at all.
 *
 * These pin every consumer to ONE resolved aim, and pin it while the light
 * MOVES — by its own props, by keyframes at a non-zero playhead, and by a
 * parent rig — because "it aims correctly at the origin" is how a
 * space-confusion bug hides.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { SceneGizmos } from '@motion/workspace';

const W = 800;
const H = 600;
const COMP = { width: W, height: H, background: '#000', rootId: 'root' } as never;

type P3 = { x: number; y: number; z: number };

const tnode = (
  id: string,
  kind: string,
  parent: string | null,
  props: Record<string, unknown>,
): SceneNode => ({
  id, name: id, parent, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [
    { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, ...props } },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
  ],
} as unknown as SceneNode);

/**
 * The receiver: a 3D quad, which is what makes the frame emit `lights3d` at all.
 *
 * Deliberately NOT `acceptsLights`. A lit plane behind an aimed light turns the
 * fixture wedge into a landed POOL — a disc on the wall, which is radially
 * symmetric and therefore emitted with `rotation: 0` on purpose (that path has
 * its own coverage in buildSnapshotLight.test.ts). These tests are about the
 * FIXTURE's aim, so they keep the wedge; `lights3d` does not depend on the
 * receiver's material either way.
 */
const receiver = (): SceneNode => tnode('plate', 'shape', 'root', {
  x: 400, y: 300, z: 0, rotationX: 0, rotationY: 0,
  width: 200, height: 200, is3D: true,
});

/** normalize(b − a) — what every consumer is supposed to agree on. */
const unit = (a: P3, b: P3): [number, number, number] => {
  const d = [b.x - a.x, b.y - a.y, b.z - a.z] as const;
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
};
const degOf = (a: readonly [number, number, number]): number =>
  (Math.atan2(a[1], a[0]) * 180) / Math.PI;

/**
 * The axis the viewport cone gizmo actually draws, recovered from the gizmo's
 * OWN output rather than re-derived here — the point is parity with the code
 * the user is looking at, not with a formula repeated in the test.
 *
 * The cone ring is a closed 24-segment circle about `p + dir·len`, so the mean
 * of its vertices is that centre and the direction falls straight out.
 */
const gizmoAim = (position: P3, poi: P3): [number, number, number] => {
  const g = SceneGizmos.buildLightGizmo({
    nodeId: 'lamp', type: 'spot', position, radius: 500, cone: 45, coneFeatherPct: 0,
    angleDeg: 0, poi, compWidth: W, selected: false,
  });
  const ring = g.segments.filter((s) => s.kind === 'cone');
  const n = ring.length;
  const c = ring.reduce(
    (acc, s) => ({ x: acc.x + s.start.x / n, y: acc.y + s.start.y / n, z: acc.z + s.start.z / n }),
    { x: 0, y: 0, z: 0 },
  );
  return unit(position, c);
};

/**
 * Build one frame and report what each consumer thinks the aim is.
 *
 * `lights3d[0]` is the per-fragment shader's copy (and the per-quad Lambert
 * term reads the same `SceneLight`); the wash layer's rotation is the flat
 * consumer; the gizmo is rebuilt from the same world numbers.
 */
const aimsOf = (
  g: SceneGraph,
  anim: AnimationEngine,
  t: number,
  lightWorld: P3,
  targetWorld: P3,
): {
  shaderAim: [number, number, number];
  shaderPos: P3;
  washRotation: number;
  expected: [number, number, number];
  gizmo: [number, number, number];
} => {
  const s = buildSnapshot(g, anim, t, undefined, undefined, undefined, undefined, COMP);
  const shader = s.lights3d![0]!;
  const wash = s.layers.find((l) => l.id === 'lamp')!;
  return {
    shaderAim: [shader.aimX, shader.aimY, shader.aimZ],
    shaderPos: { x: shader.x, y: shader.y, z: shader.z },
    washRotation: wash.rotation,
    expected: unit(lightWorld, targetWorld),
    gizmo: gizmoAim(lightWorld, targetWorld),
  };
};

/** Every reader agrees, and agrees with normalize(target − lightWorld). */
const expectAimedAt = (a: ReturnType<typeof aimsOf>): void => {
  for (let i = 0; i < 3; i++) {
    expect(a.shaderAim[i]).toBeCloseTo(a.expected[i]!, 6);
    expect(a.gizmo[i]).toBeCloseTo(a.expected[i]!, 6);
  }
  // The wash quad carries the comp-plane half of that same aim.
  expect(a.washRotation).toBeCloseTo(degOf(a.expected), 4);
};

/** A spot at `pos` targeted at `poi`, plus the receiver it lights. */
const scene = (pos: P3, poi: P3, extra: Record<string, unknown> = {}): SceneGraph => {
  const g = new SceneGraph();
  g.addNode(tnode('root', 'group', null, {}));
  g.addChild('root', tnode('lamp', 'light', 'root', {
    lightType: 'spot', intensity: 100, radius: 500, lightCone: 45,
    x: pos.x, y: pos.y, z: pos.z, poiX: poi.x, poiY: poi.y, poiZ: poi.z, ...extra,
  }));
  g.addChild('root', receiver());
  return g;
};

describe('a targeted light aims at its target from wherever it is', () => {
  it('the reported case: a spot at (0,0,-300) targeted at (400,0,0), then moved', () => {
    const poi = { x: 400, y: 0, z: 0 };
    const start = { x: 0, y: 0, z: -300 };
    expectAimedAt(aimsOf(scene(start, poi), new AnimationEngine(), 0, start, poi));
    // "…then moved the light around". This is the half that was broken: the
    // start pose happens to want a 0° comp aim, which is also what an untargeted
    // light's Direction defaults to, so only MOVING the light separates them.
    const moved = { x: 120, y: -480, z: -300 };
    expectAimedAt(aimsOf(scene(moved, poi), new AnimationEngine(), 0, moved, poi));
  });

  it('MOVING the light re-aims it — the whole complaint, one position at a time', () => {
    const poi = { x: 400, y: 0, z: 0 };
    for (const pos of [
      { x: 0, y: 0, z: -300 },
      { x: 0, y: -500, z: -300 }, // above the target: the aim swings down
      { x: 700, y: 0, z: -300 }, // past it: the aim flips to point back left
      { x: 0, y: 0, z: 600 }, // behind it in depth
      { x: -250, y: 320, z: 80 },
    ]) {
      expectAimedAt(aimsOf(scene(pos, poi), new AnimationEngine(), 0, pos, poi));
    }
  });

  /**
   * The sharpest form of the bug: an aim resolved from the light's BASE props
   * while another consumer uses the animated pose. Sampling at a non-zero
   * playhead is what separates the two.
   */
  it('re-aims from the KEYFRAMED position at a non-zero playhead', () => {
    const poi = { x: 400, y: 0, z: 0 };
    const g = scene({ x: 0, y: 0, z: -300 }, poi);
    const anim = new AnimationEngine();
    anim.setKeyframes('lamp', 'x', [
      { t: 0, value: 0, easing: 'linear' },
      { t: 2, value: -600, easing: 'linear' },
    ] as never);
    anim.setKeyframes('lamp', 'y', [
      { t: 0, value: 0, easing: 'linear' },
      { t: 2, value: 400, easing: 'linear' },
    ] as never);
    expectAimedAt(aimsOf(g, anim, 0, { x: 0, y: 0, z: -300 }, poi));
    expectAimedAt(aimsOf(g, anim, 1, { x: -300, y: 200, z: -300 }, poi));
    expectAimedAt(aimsOf(g, anim, 2, { x: -600, y: 400, z: -300 }, poi));
  });

  /**
   * A light on a null rig: the eye AND the target ride the parent, so the aim
   * is invariant — the cone must not shear open as the rig travels.
   */
  it('re-aims through an animated PARENT rig', () => {
    const poi = { x: 400, y: 0, z: 0 };
    const g = new SceneGraph();
    g.addNode(tnode('root', 'group', null, {}));
    g.addChild('root', tnode('nul', 'null', 'root', { x: 0, y: 0 }));
    g.addChild('nul', tnode('lamp', 'light', 'nul', {
      lightType: 'spot', intensity: 100, radius: 500, lightCone: 45,
      x: 0, y: 0, z: -300, poiX: poi.x, poiY: poi.y, poiZ: poi.z,
    }));
    g.addChild('root', receiver());
    const anim = new AnimationEngine();
    anim.setKeyframes('nul', 'x', [
      { t: 0, value: 0, easing: 'linear' },
      { t: 2, value: 900, easing: 'linear' },
    ] as never);
    for (const [t, dx] of [[0, 0], [1, 450], [2, 900]] as const) {
      const a = aimsOf(g, anim, t,
        { x: dx, y: 0, z: -300 },
        { x: poi.x + dx, y: poi.y, z: poi.z });
      expect(a.shaderPos.x).toBeCloseTo(dx, 4);
      expectAimedAt(a);
    }
  });

  /** Moving the TARGET re-aims too — the other half of "aims at the target". */
  it('re-aims when the TARGET moves', () => {
    const pos = { x: 0, y: 0, z: -300 };
    const g = scene(pos, { x: 400, y: 0, z: 0 });
    const anim = new AnimationEngine();
    anim.setKeyframes('lamp', 'poiY', [
      { t: 0, value: 0, easing: 'linear' },
      { t: 2, value: -800, easing: 'linear' },
    ] as never);
    const at0 = aimsOf(g, anim, 0, pos, { x: 400, y: 0, z: 0 });
    const at2 = aimsOf(g, anim, 2, pos, { x: 400, y: -800, z: 0 });
    expectAimedAt(at0);
    expectAimedAt(at2);
    // And it actually MOVED — a test that passes on a frozen aim proves nothing.
    expect(at2.washRotation).not.toBeCloseTo(at0.washRotation, 1);
  });

  /** A PARALLEL light is aimable too, and resolves through the same path. */
  it('aims a parallel light at its target as well', () => {
    const pos = { x: 100, y: 500, z: -200 };
    const poi = { x: 600, y: 100, z: 250 };
    const g = scene(pos, poi, { lightType: 'parallel' });
    expectAimedAt(aimsOf(g, new AnimationEngine(), 0, pos, poi));
  });

  /**
   * The regression guard, and the reason the fix is narrow: an UNtargeted light
   * still aims by Direction + world rotation, exactly as before. Every existing
   * scene, and every light render reference, depends on that.
   */
  it('leaves an UNtargeted light on Direction + rotation', () => {
    const g = new SceneGraph();
    g.addNode(tnode('root', 'group', null, {}));
    g.addChild('root', tnode('lamp', 'light', 'root', {
      lightType: 'spot', intensity: 100, radius: 500,
      x: 0, y: 0, z: -300, lightAngle: 40, rotation: 25,
    }));
    g.addChild('root', receiver());
    const s = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    expect(s.layers.find((l) => l.id === 'lamp')!.rotation).toBeCloseTo(65, 6);
    const l = s.lights3d![0]!;
    // The legacy comp-plane aim: z = 0 for a spot, by construction.
    expect(l.aimZ).toBeCloseTo(0, 6);
    expect((Math.atan2(l.aimY, l.aimX) * 180) / Math.PI).toBeCloseTo(65, 4);
  });

  /**
   * A target dead ahead in depth has no comp-plane direction at all, so there is
   * no wedge to swing: the untargeted angle is kept rather than collapsing to an
   * arbitrary 0°. The 3D aim is still exact, and the landed-pool projection is
   * what draws this case properly.
   */
  it('keeps the untargeted angle when the aim is perpendicular to the comp plane', () => {
    const g = scene({ x: 0, y: 0, z: -300 }, { x: 0, y: 0, z: 0 }, { lightAngle: 33 });
    const s = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    expect(s.layers.find((l) => l.id === 'lamp')!.rotation).toBeCloseTo(33, 6);
    expect(s.lights3d![0]!.aimZ).toBeCloseTo(1, 6);
  });

  /** Point lights have no aim, but their POSITION must be the world one. */
  it('a point light has no aim and keeps its world position', () => {
    const g = new SceneGraph();
    g.addNode(tnode('root', 'group', null, {}));
    g.addChild('root', tnode('nul', 'null', 'root', { x: 250, y: -60 }));
    g.addChild('nul', tnode('lamp', 'light', 'nul', {
      lightType: 'point', intensity: 100, radius: 500, x: 100, y: 200, z: -80,
    }));
    g.addChild('root', receiver());
    const s = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    const l = s.lights3d![0]!;
    expect([l.x, l.y, l.z]).toEqual([350, 140, -80]);
    expect(s.layers.find((la) => la.id === 'lamp')!.rotation).toBeCloseTo(0, 6);
  });
});
