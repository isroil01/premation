/**
 * Per-quad Lambert shading (Accepts Lights). Pure-math unit tests plus the
 * buildSnapshot integration: default OFF must leave layers untouched.
 */

import { shadeLayer, planeNormalOf, toShaderLights, type SceneLight } from './lightShading';
import { buildSnapshot } from '../rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const COMP = { width: 800, height: 600, background: '#101014' };

function light(partial: Partial<SceneLight>): SceneLight {
  return {
    type: 'point', color: '#ffffff', intensity: 100, radius: 1000,
    angle: 0, cone: 45, shadows: false, x: 0, y: 0, z: 0,
    ...partial,
  };
}

describe('planeNormalOf', () => {
  it('identity world → +Z', () => {
    expect(planeNormalOf([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toEqual([0, 0, 1]);
  });
  it('normalises a scaled z axis', () => {
    const n = planeNormalOf([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1]);
    expect(n[2]).toBeCloseTo(1);
  });
});

describe('shadeLayer', () => {
  const N: readonly [number, number, number] = [0, 0, 1];
  const P = { x: 0, y: 0, z: 0 };

  it('no lights → null (identity, nothing attached)', () => {
    expect(shadeLayer(N, P, [])).toBeNull();
  });

  it('ambient light adds flat colour·intensity', () => {
    const rgb = shadeLayer(N, P, [light({ type: 'ambient', intensity: 50 })])!;
    expect(rgb[0]).toBeCloseTo(0.5);
    expect(rgb[1]).toBeCloseTo(0.5);
    expect(rgb[2]).toBeCloseTo(0.5);
  });

  it('a point light directly along the normal gives full Lambert; grazing gives ~0', () => {
    const head = shadeLayer(N, P, [light({ x: 0, y: 0, z: -500, radius: 10000 })])!;
    const graze = shadeLayer(N, P, [light({ x: 500, y: 0, z: 0, radius: 10000 })])!;
    expect(head[0]).toBeGreaterThan(graze[0]);
    expect(graze[0]).toBeCloseTo(0, 5);
  });

  it('point light attenuates with distance and dies at the radius', () => {
    const near = shadeLayer(N, P, [light({ x: 0, y: 0, z: -100, radius: 1000 })])!;
    const far = shadeLayer(N, P, [light({ x: 0, y: 0, z: -900, radius: 1000 })])!;
    const out = shadeLayer(N, P, [light({ x: 0, y: 0, z: -2000, radius: 1000 })])!;
    expect(near[0]).toBeGreaterThan(far[0]);
    expect(out[0]).toBe(0);
  });

  it('both faces of a plane are lit (two-sided layers)', () => {
    const front = shadeLayer(N, P, [light({ x: 0, y: 0, z: -300, radius: 10000 })])!;
    const back = shadeLayer(N, P, [light({ x: 0, y: 0, z: 300, radius: 10000 })])!;
    expect(back[0]).toBeCloseTo(front[0], 6);
  });

  it('a spot light outside its cone contributes nothing', () => {
    // Aimed toward +x (angle 0), layer sits in −x from the light.
    const inCone = shadeLayer(N, { x: 500, y: 0, z: 0 }, [light({ type: 'spot', x: 0, y: 0, z: -50, angle: 0, cone: 60, radius: 10000 })])!;
    const outCone = shadeLayer(N, { x: -500, y: 0, z: 0 }, [light({ type: 'spot', x: 0, y: 0, z: -50, angle: 0, cone: 60, radius: 10000 })])!;
    expect(inCone[0]).toBeGreaterThan(0);
    expect(outCone[0]).toBe(0);
  });

  it('the gain is clamped, never negative or unbounded', () => {
    const stack = Array.from({ length: 40 }, () => light({ type: 'ambient', intensity: 100 }));
    const rgb = shadeLayer(N, P, stack)!;
    expect(rgb[0]).toBeLessThanOrEqual(4);
  });
});

// ── buildSnapshot integration ────────────────────────────────────────────────

function shapeNode(id: string, extra: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, z: 100, ...extra } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

function lightNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', x: 400, y: 300, lightType: 'ambient', intensity: 80 } },
    ],
  } as unknown as SceneNode;
}

describe('buildSnapshot — Accepts Lights integration', () => {
  function snap(...nodes: SceneNode[]) {
    const graph = new SceneGraph();
    for (const n of nodes) graph.addNode(n);
    return buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
  }

  it('default (flag off): a lit scene attaches NO lighting gain', () => {
    const s = snap(shapeNode('a'), lightNode('sun'));
    expect(s.layers.find((l) => l.id === 'a')!.lighting).toBeUndefined();
  });

  it('acceptsLights: the 3D layer picks up the ambient gain', () => {
    const s = snap(shapeNode('a', { acceptsLights: true }), lightNode('sun'));
    const lit = s.layers.find((l) => l.id === 'a')!.lighting!;
    expect(lit).toBeDefined();
    expect(lit[0]).toBeCloseTo(0.8, 5);
  });

  it('acceptsLights in an UNLIT scene attaches nothing (identity)', () => {
    const s = snap(shapeNode('a', { acceptsLights: true }));
    expect(s.layers.find((l) => l.id === 'a')!.lighting).toBeUndefined();
  });

  it('a 2D layer never shades even with the flag on', () => {
    const s = snap(shapeNode('flat', { z: undefined as unknown as number, acceptsLights: true }), lightNode('sun'));
    const flat = s.layers.find((l) => l.id === 'flat')!;
    expect(flat.world3d).toBeUndefined();
    expect(flat.lighting).toBeUndefined();
  });
});

describe('toShaderLights (shader-term conversion for the per-fragment path)', () => {
  const base = { type: 'point' as const, color: '#ff8040', intensity: 80, radius: 600, angle: 90, cone: 60, shadows: false, x: 10, y: 20, z: -30 };

  it('converts color to linear rgb, intensity to gain, angle to cos/sin, cone to half-radians', () => {
    const [l] = toShaderLights([base]);
    expect(l).toBeDefined();
    expect(l!.gain).toBeCloseTo(0.8, 5);
    expect(l!.color.r).toBeCloseTo(1, 3);
    expect(l!.color.g).toBeCloseTo(0x80 / 255, 3);
    expect(l!.aimX).toBeCloseTo(0, 6); // cos 90°
    expect(l!.aimY).toBeCloseTo(1, 6); // sin 90°
    expect(l!.halfConeRad).toBeCloseTo((30 * Math.PI) / 180, 6);
    expect(l!.x).toBe(10);
    expect(l!.z).toBe(-30);
  });

  it('drops zero-intensity lights and clamps the tiny-cone floor', () => {
    const out = toShaderLights([
      { ...base, intensity: 0 },
      { ...base, cone: 0 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.halfConeRad).toBeGreaterThanOrEqual(1e-3);
  });

  /**
   * The three parameters that used to stop at the CPU.
   *
   * `lightShaderParity.test.ts` proves each field CROSSES to the DTO; these
   * prove it crosses carrying the right number. Both matter: a field wired
   * through with the wrong derivation typechecks, satisfies the structural
   * guard, and still renders wrong — roughly how the hardcoded 20 % feather
   * survived. Everything derived is asserted against `shadeLayer`'s own rule,
   * because the CPU path is the reference wherever the two could disagree.
   */
  describe('parameters that previously never reached the shader', () => {
    const half = (cone: number) => Math.max(1e-3, (cone / 2) * (Math.PI / 180));

    it('cone feather is absolute radians, not a percentage', () => {
      const [l] = toShaderLights([{ ...base, type: 'spot', coneFeather: 50 }]);
      expect(l!.coneFeatherRad).toBeCloseTo(half(60) * 0.5, 9);
    });

    it('an absent cone feather keeps the legacy 20 % the shader used to hardcode', () => {
      const [l] = toShaderLights([{ ...base, type: 'spot' }]);
      expect(l!.coneFeatherRad).toBeCloseTo(half(60) * 0.2, 9);
    });

    it('a zero feather is a hard edge and survives as one', () => {
      // Distinguishable from "absent" only because the default is applied here
      // rather than in the shader — the shader cannot tell 0 from undefined.
      const [l] = toShaderLights([{ ...base, type: 'spot', coneFeather: 0 }]);
      expect(l!.coneFeatherRad).toBe(0);
    });

    it('falloff mode maps to the shader enum and defaults the smooth span', () => {
      expect(toShaderLights([{ ...base }])[0]!.falloffMode).toBe(0);
      expect(toShaderLights([{ ...base, falloff: 'smooth' }])[0]!.falloffMode).toBe(1);
      expect(toShaderLights([{ ...base, falloff: 'inverse-square' }])[0]!.falloffMode).toBe(2);

      expect(toShaderLights([{ ...base, falloff: 'smooth', falloffDistance: 250 }])[0]!.falloffDistance).toBe(250);
      // Absent ⇒ the same default lightFalloffAt applies, resolved here so the
      // shader never has to know it.
      expect(toShaderLights([{ ...base, falloff: 'smooth' }])[0]!.falloffDistance).toBeGreaterThan(0);
    });

    it('a Point of Interest becomes the resolved 3D aim', () => {
      // POI directly below the light: aim is +Y — and crucially z is
      // expressible at all, which the old cos/sin pair could not do.
      const [l] = toShaderLights([{ ...base, type: 'spot', x: 0, y: 0, z: 0, poi: { x: 0, y: 100, z: 0 } }]);
      expect(l!.aimX).toBeCloseTo(0, 9);
      expect(l!.aimY).toBeCloseTo(1, 9);
      expect(l!.aimZ).toBeCloseTo(0, 9);

      const [d] = toShaderLights([{ ...base, type: 'spot', x: 0, y: 0, z: 0, poi: { x: 0, y: 0, z: 100 } }]);
      expect(d!.aimZ).toBeCloseTo(1, 9);
    });

    it('without a POI each type keeps its OWN legacy fallback', () => {
      // Collapsing these into one shared default would silently re-light every
      // existing scene, which is why shadeLayer has two distinct `??` branches.
      const [spot] = toShaderLights([{ ...base, type: 'spot', angle: 0 }]);
      expect([spot!.aimX, spot!.aimY, spot!.aimZ]).toEqual([1, 0, 0]);

      const [par] = toShaderLights([{ ...base, type: 'parallel', angle: 0 }]);
      expect(par!.aimX).toBeCloseTo(Math.SQRT1_2, 9);
      expect(par!.aimZ).toBeCloseTo(-Math.SQRT1_2, 9);
    });

    it('every emitted aim is unit length (the shader does not normalise)', () => {
      for (const type of ['point', 'spot', 'parallel'] as const) {
        const [l] = toShaderLights([{ ...base, type, angle: 37 }]);
        expect(Math.hypot(l!.aimX, l!.aimY, l!.aimZ)).toBeCloseTo(1, 9);
      }
    });
  });
});
