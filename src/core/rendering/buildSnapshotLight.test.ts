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
      poi: null,
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
