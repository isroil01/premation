import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNodeLight } from '@core/scene/light';

const COMP = { width: 800, height: 600, background: '#101014' };

function light(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', x: 400, y: 300, rotation: 0, intensity: 80, radius: 250 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffcc00' } },
    ],
  } as unknown as SceneNode;
}

describe('lights', () => {
  it('readNodeLight reads colour / intensity / radius (with type defaults)', () => {
    expect(readNodeLight(light('L'))).toEqual({
      type: 'point',
      color: '#ffcc00',
      intensity: 80,
      radius: 250,
      angle: 0,
      cone: 45,
      shadows: false,
      // AE parity additions. All default to a no-op: `falloff: 'none'` keeps
      // the legacy radius ramp, and a null POI keeps the legacy 2D aim, so a
      // light that sets none of them renders exactly as it always did.
      coneFeather: 50,
      falloff: 'none',
      falloffDistance: 500,
      shadowDarkness: 100,
      shadowDiffusion: 0,
      // Geometry-aware shadows, off by default: `shadowMap: false` leaves the
      // 2.5D projected copy in place, and the three settings below are inert
      // until it is switched on.
      shadowMap: false,
      shadowMapSize: 1024,
      shadowBias: 3,
      shadowSoftness: 1,
      poi: null,
      // Environment-light fields (no-ops on the four classic types).
      envPreset: 'studio',
      envRotation: 0,
      envReflections: 100,
    });
  });

  it('readNodeLight honours explicit spot config', () => {
    const n = light('S');
    (n.components[0]!.props as Record<string, unknown>).lightType = 'spot';
    (n.components[0]!.props as Record<string, unknown>).lightAngle = 90;
    (n.components[0]!.props as Record<string, unknown>).lightCone = 30;
    const lt = readNodeLight(n);
    expect(lt.type).toBe('spot');
    expect(lt.angle).toBe(90);
    expect(lt.cone).toBe(30);
  });

  it('Draft 3D (comp.draft3d) suppresses light washes and cast shadows', () => {
    const g = new SceneGraph();
    const shadowCaster = light('L');
    (shadowCaster.components[0]!.props as Record<string, unknown>).castShadows = true;
    g.addNode(shadowCaster);
    g.addNode({
      id: 'box', name: 'box', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'box_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, rotation: 0 } },
        { id: 'box_s', type: 'Style', props: { opacity: 100, fill: '#3aa' } },
      ],
    } as unknown as SceneNode);

    // Full quality: the light wash layer renders and the shape casts a shadow.
    const full = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
    expect(full.some((l) => l.light)).toBe(true);
    const fullShape = full.find((l) => l.id === 'box')!;
    expect((fullShape.effects ?? []).some((fx) => fx.id === 'cast-shadow')).toBe(true);

    // Draft 3D: same scene, lighting entirely gone — layer set and effects.
    const draft = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, { ...COMP, draft3d: true }).layers;
    expect(draft.some((l) => l.light)).toBe(false);
    const draftShape = draft.find((l) => l.id === 'box')!;
    expect((draftShape.effects ?? []).some((fx) => fx.id === 'cast-shadow' || fx.id === 'dof')).toBe(false);
    expect(draftShape.filter ?? '').not.toContain('drop-shadow');
  });

  it('buildSnapshot emits a light layer at the light position', () => {
    const g = new SceneGraph();
    g.addNode(light('L'));
    const layers = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
    expect(layers).toHaveLength(1);
    expect(layers[0]!.light).toEqual({
      color: '#ffcc00',
      intensity: 80,
      radius: 250,
      type: 'point',
      cone: 45,
      // The wash shapes a spot's cone, so it needs the feather too. 50 is
      // LIGHT_DEFAULTS.coneFeather — a point light carries it and ignores it.
      coneFeather: 50,
      // Comp px — the quad's half-size. Equal to `radius` for a fixture's glow,
      // which is authored in comp pixels. Only a landed beam's footprint goes
      // through the projection.
      screenRadius: 250,
      // No `angle`. The wash texture is baked aim-agnostic (the cone opens
      // along +X) and the LAYER's rotation aims it, so a rotating spot reuses
      // one cached texture instead of re-rastering 512² pixels per frame.
    });
    expect(layers[0]!.x).toBeCloseTo(400);
    expect(layers[0]!.y).toBeCloseTo(300);
  });

  /**
   * Rotating a light did nothing. The inspector gives a light the full
   * Transform section, Rotation included, but the wash was emitted with
   * `rotation: 0`, its cone was baked from `lightAngle` alone, and `sceneLights`
   * read the same raw prop — so the control reached no render path. The only way
   * to swing a spot was the Direction field, and because the wash is a big
   * centre-weighted glow, the beam appeared to pile up on the light rather than
   * sweep.
   */
  describe("a light's rotation aims it", () => {
    const spot = (rotation: number, direction: number): SceneNode => {
      const n = light('S');
      const props = n.components[0]!.props as Record<string, unknown>;
      props.lightType = 'spot';
      props.lightAngle = direction;
      props.rotation = rotation;
      return n;
    };
    const wash = (n: SceneNode) => {
      const g = new SceneGraph();
      g.addNode(n);
      return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP)
        .layers.find((l) => l.light)!;
    };

    it('adds the layer rotation to the Direction field', () => {
      expect(wash(spot(30, 45)).rotation).toBeCloseTo(75);
    });

    it('rotation alone aims a light whose Direction is untouched', () => {
      expect(wash(spot(90, 0)).rotation).toBeCloseTo(90);
    });

    it('an unrotated light is aimed by Direction exactly as before', () => {
      expect(wash(spot(0, 45)).rotation).toBeCloseTo(45);
    });
  });

  /**
   * A spot's wash was drawn at the FIXTURE: a glow centred on the emitter, the
   * same shape whatever the light was aimed at. That is what makes an aimed
   * light read as light piling up on itself — in a real scene you do not see the
   * lamp, you see the pool it throws on the wall.
   *
   * A targeted light's axis is now intersected with the nearest lit plane and
   * the wash is flattened onto it, the same construction cast shadows use.
   */
  describe('an aimed beam lands on the plane it lights', () => {
    /** A 3D layer that accepts lights, sitting at `z` — a wall to light. */
    const wall = (id: string, z: number): SceneNode => ({
      id, name: id, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 960, y: 540 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: `${id}_t`, type: 'Transform', props: {
          [SCENE_KIND_PROP]: 'shape', x: 960, y: 540, rotation: 0,
          is3D: true, z, acceptsLights: true,
        } },
        { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#888' } },
      ],
    } as unknown as SceneNode);

    /** A spot at the comp centre, optionally aimed at a Point of Interest. */
    const aimed = (poi: { x: number; y: number; z: number } | null): SceneNode => {
      const n = light('S');
      const props = n.components[0]!.props as Record<string, unknown>;
      props.lightType = 'spot';
      props.x = 960; props.y = 540; props.z = -400;
      props.radius = 4000;
      props.lightCone = 60;
      if (poi) { props.poiX = poi.x; props.poiY = poi.y; props.poiZ = poi.z; }
      return n;
    };

    const build = (...nodes: SceneNode[]) => {
      const g = new SceneGraph();
      for (const n of nodes) g.addNode(n);
      const comp = { ...COMP, width: 1920, height: 1080 };
      return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp)
        .layers.find((l) => l.light)!;
    };

    it('a targeted spot paints a pool on the wall, not a wedge at the lamp', () => {
      const w = build(aimed({ x: 960, y: 540, z: 0 }), wall('wall', 0));
      expect(w.light!.pool).toBe(true);
      // A cone crossing a plane is a disc: no wedge mask, so no aim to carry.
      expect(w.rotation).toBe(0);
    });

    it('the pool sits where the axis meets the plane, not under the lamp', () => {
      // Aimed down-right: the axis travels 400 in z and 400 in x, so it lands
      // 400px to the right of the light rather than on top of it.
      const w = build(aimed({ x: 1360, y: 540, z: 0 }), wall('wall', 0));
      expect(w.x).toBeGreaterThan(1200);
      expect(w.y).toBeCloseTo(540, 0);
    });

    it('the pool grows with the distance the beam travelled', () => {
      const near = build(aimed({ x: 960, y: 540, z: 0 }), wall('wall', 0));
      const far = build(aimed({ x: 960, y: 540, z: 0 }), wall('wall', 600));
      expect(far.light!.screenRadius).toBeGreaterThan(near.light!.screenRadius);
    });

    it('and dims with it — the beam is attenuated over the distance it carried', () => {
      const near = build(aimed({ x: 960, y: 540, z: 0 }), wall('wall', 0));
      const far = build(aimed({ x: 960, y: 540, z: 0 }), wall('wall', 600));
      expect(far.light!.intensity).toBeLessThan(near.light!.intensity);
    });

    it('an UNtargeted spot keeps the wedge at the fixture', () => {
      // Its aim lies in the comp plane by construction, so it has no depth
      // component to travel along and nothing to land on.
      const w = build(aimed(null), wall('wall', 0));
      expect(w.light!.pool).toBeUndefined();
      expect(w.x).toBeCloseTo(960, 0);
    });

    it('a targeted spot with no lit plane in front of it keeps the wedge too', () => {
      const w = build(aimed({ x: 960, y: 540, z: 0 }));
      expect(w.light!.pool).toBeUndefined();
    });

    it('a wall that does not accept lights is not a surface to land on', () => {
      const plain = wall('wall', 0);
      (plain.components[0]!.props as Record<string, unknown>).acceptsLights = false;
      expect(build(aimed({ x: 960, y: 540, z: 0 }), plain).light!.pool).toBeUndefined();
    });
  });
});

describe('environment light', () => {
  function envLight(id: string, preset = 'sky'): SceneNode {
    const n = light(id);
    const p = n.components[0]!.props as Record<string, unknown>;
    p.lightType = 'environment';
    p.envPreset = preset;
    p.intensity = 100;
    return n;
  }

  /** lights3d only ships when something 3D is there to be lit. */
  function shape3d(id: string): SceneNode {
    return {
      id, name: id, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 200, y: 200 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 200, y: 200, z: 0, rotation: 0, width: 50, height: 50, acceptsLights: true } },
        { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#3aa' } },
      ],
    } as unknown as SceneNode;
  }

  it('expands into an ambient floor + directional deviations in lights3d', () => {
    const g = new SceneGraph();
    g.addNode(envLight('E'));
    g.addNode(shape3d('S'));
    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    const lights = snap.lights3d ?? [];
    expect(lights.length).toBeGreaterThanOrEqual(2);
    expect(lights.some((l) => l.type === 'ambient')).toBe(true);
    expect(lights.some((l) => l.type === 'parallel')).toBe(true);
    // Nothing claims to be an 'environment' downstream — the probe expands
    // BEFORE collection (toShaderLights would drop it, mis-typed).
    expect(lights.every((l) => l.type !== ('environment' as never))).toBe(true);
  });

  it('draws no wash layer — an environment lights, it does not glow', () => {
    const g = new SceneGraph();
    g.addNode(envLight('E'));
    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    expect(snap.layers.some((l) => l.light)).toBe(false);
    expect(snap.layers.some((l) => l.id.startsWith('E'))).toBe(false);
  });

  /*
    The REFLECTION half of the same light. `lights3d` above is the irradiance
    probe — how much light arrives; `envMap` is the prefiltered radiance a
    smooth Physical surface mirrors. Both come from one light, one sky and one
    rotation, and these pin the three conditions under which the second half
    ships at all — because whenever it does NOT ship, the shader's reflection
    block is dead and the frame is bit-identical to the engine that predates it.
  */
  describe('its reflection map', () => {
    const snapOf = (g: SceneGraph): ReturnType<typeof buildSnapshot> =>
      buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);

    it('ships beside the rig, carrying the same sky, rotation and intensity', () => {
      const g = new SceneGraph();
      const e = envLight('E', 'sunset');
      (e.components[0]!.props as Record<string, unknown>).envRotation = 40;
      g.addNode(e);
      g.addNode(shape3d('S'));
      const snap = snapOf(g);
      expect(snap.envMap).toBeDefined();
      expect(snap.envMap!.rotationDeg).toBe(40);
      expect(snap.envMap!.intensity).toBeCloseTo(1, 6);
      expect(snap.envMap!.data.length).toBe(snap.envMap!.width * snap.envMap!.height * 4);
    });

    it('does not ship without a 3D layer — nothing there to reflect in', () => {
      const g = new SceneGraph();
      g.addNode(envLight('E'));
      expect(snapOf(g).envMap).toBeUndefined();
    });

    it('does not ship at zero Reflections — the term would multiply to nothing', () => {
      const g = new SceneGraph();
      const e = envLight('E');
      (e.components[0]!.props as Record<string, unknown>).envReflections = 0;
      g.addNode(e);
      g.addNode(shape3d('S'));
      // And this is the user-facing OFF switch: no map bound, `envParams.x`
      // zero, the shader back to exactly its pre-reflection arithmetic.
      expect(snapOf(g).envMap).toBeUndefined();
    });

    it('scales with Reflections independently of the light rig', () => {
      const build = (refl: number): ReturnType<typeof buildSnapshot> => {
        const g = new SceneGraph();
        const e = envLight('E');
        (e.components[0]!.props as Record<string, unknown>).envReflections = refl;
        g.addNode(e);
        g.addNode(shape3d('S'));
        return snapOf(g);
      };
      const full = build(100);
      const half = build(50);
      expect(half.envMap!.intensity).toBeCloseTo(full.envMap!.intensity / 2, 6);
      // The rig is untouched by it: dimming reflections must not dim the scene.
      expect(half.lights3d).toEqual(full.lights3d);
    });

    it('shares one atlas across frames, so a keyframed sky re-uploads nothing', () => {
      const g = new SceneGraph();
      g.addNode(envLight('E', 'sunset'));
      g.addNode(shape3d('S'));
      const anim = new AnimationEngine();
      anim.setKeyframe('E', 'envRotation', 0, 0);
      anim.setKeyframe('E', 'envRotation', 2, 180);
      const at = (t: number): ReturnType<typeof buildSnapshot> =>
        buildSnapshot(g, anim, t, undefined, undefined, undefined, undefined, COMP);
      const a = at(0).envMap!;
      const b = at(2).envMap!;
      // Same id AND the same buffer object: the renderer keys its GPU texture
      // off the id, so a per-frame rebuild would re-upload 640 KB every frame
      // of an animated sky.
      expect(b.id).toBe(a.id);
      expect(b.data).toBe(a.data);
      expect(b.rotationDeg).not.toBe(a.rotationDeg);
    });
  });

  it('keyframed envRotation swings the rig (animated sky)', () => {
    const g = new SceneGraph();
    g.addNode(envLight('E', 'sunset'));
    g.addNode(shape3d('S'));
    const anim = new AnimationEngine();
    anim.setKeyframe('E', 'envRotation', 0, 0);
    anim.setKeyframe('E', 'envRotation', 2, 180);
    const at0 = buildSnapshot(g, anim, 0, undefined, undefined, undefined, undefined, COMP).lights3d ?? [];
    const at2 = buildSnapshot(g, anim, 2, undefined, undefined, undefined, undefined, COMP).lights3d ?? [];
    const horizGains = (ls: typeof at0): number[] =>
      ls.filter((l) => l.type === 'parallel' && Math.abs(l.aimY) < 0.01).map((l) => Math.round(l.gain * 1000));
    expect(horizGains(at0).length).toBeGreaterThan(0);
    expect(horizGains(at2)).not.toEqual(horizGains(at0));
  });
});

