import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { Matrix4Math } from '@motion/scene';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import { depthEligible3D } from '@motion/renderer';
import { EXTRUSION_WALL_GAIN, EXTRUSION_BACK_GAIN, ELLIPSE_WALL_SEGMENTS } from '@core/scene/extrusion';

const COMP = { width: 800, height: 600, background: '#101014' };

function shape3D(id: string, props: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0, width: 100, height: 60, z: 0, ...props } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

function whiteLight(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', x: 400, y: 300, rotation: 0, intensity: 80, radius: 500 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

function snap(graph: SceneGraph, anim = new AnimationEngine(), t = 0, comp: { draft3d?: boolean } = {}) {
  return buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, { ...COMP, ...comp });
}

const origin = (world3d: readonly number[]) =>
  Matrix4Math.transformPoint(world3d as import('@motion/scene').Matrix4, { x: 0, y: 0, z: 0 });

describe('buildSnapshot — 3D extrusion geometry synthesis', () => {
  it('extrusionDepth 0 emits NO extra layers (regression: flat 3D unchanged)', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('flat'));
    const layers = snap(g).layers;
    expect(layers).toHaveLength(1);
    expect(layers[0]!.id).toBe('flat');
  });

  it('extrusion > 0 emits back + 4 walls CONTIGUOUS with the front face (front last)', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40 }));
    const layers = snap(g).layers;
    expect(layers.map((l) => l.id)).toEqual([
      'box::ext-back', 'box::ext-r', 'box::ext-l', 'box::ext-t', 'box::ext-b', 'box',
    ]);
    for (const l of layers) {
      expect(l.world3d).toBeDefined();
      expect(l.matrix).toBeDefined(); // affine fallback computed for every face
    }
  });

  it('back cap world matrix is the front translated by +d along the layer z axis', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40 }));
    const layers = snap(g).layers;
    const front = layers.find((l) => l.id === 'box')!;
    const back = layers.find((l) => l.id === 'box::ext-back')!;
    const of = origin(front.world3d!);
    const ob = origin(back.world3d!);
    expect(of.z).toBeCloseTo(0, 6);
    expect(ob.x).toBeCloseTo(of.x, 6);
    expect(ob.y).toBeCloseTo(of.y, 6);
    expect(ob.z).toBeCloseTo(of.z + 40, 6); // +z = away from the default camera
  });

  // Was: "all faces share the front face sort depth (one object, one depth)".
  // That premise was the bug. Giving every face the parent layer's depth left the
  // painter sort with nothing to order them by, so the darker back cap and walls
  // could paint OVER the front face — a dark patch with a border, inside the
  // object. Each face must carry its own projected depth.
  it('each face carries its OWN sort depth, ordered back cap → walls → front', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40, z: 150 }));
    const layers = snap(g).layers;
    const depthOf = (id: string): number => layers.find((l) => l.id === id)!.depth!;

    const front = depthOf('box');
    const back = depthOf('box::ext-back');
    const wall = depthOf('box::ext-r');

    // Back cap sits a full extrusionDepth behind the front face.
    expect(back - front).toBeCloseTo(40, 6);
    // Walls span the middle, so their origin is at half depth.
    expect(wall - front).toBeCloseTo(20, 6);
    // Farther = larger depth = painted earlier (the sort is descending).
    expect(back).toBeGreaterThan(wall);
    expect(wall).toBeGreaterThan(front);
    // The front face is still emitted last, i.e. painted on top.
    expect(layers[layers.length - 1]!.id).toBe('box');
  });

  it('unlit: walls carry the fixed wall gain, back cap the back gain, front none', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40 }));
    const layers = snap(g).layers;
    const wall = layers.find((l) => l.id === 'box::ext-r')!;
    const back = layers.find((l) => l.id === 'box::ext-back')!;
    const front = layers.find((l) => l.id === 'box')!;
    expect(wall.lighting).toEqual([EXTRUSION_WALL_GAIN, EXTRUSION_WALL_GAIN, EXTRUSION_WALL_GAIN]);
    expect(back.lighting).toEqual([EXTRUSION_BACK_GAIN, EXTRUSION_BACK_GAIN, EXTRUSION_BACK_GAIN]);
    expect(front.lighting).toBeUndefined();
    expect(wall.shade3d).toBeUndefined();
  });

  it('walls are solid rect quads in the layer fill; back cap keeps the content', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40 }));
    const layers = snap(g).layers;
    const wall = layers.find((l) => l.id === 'box::ext-t')!;
    expect(wall.kind).toBe('shape');
    expect(wall.primitive).toBe('rect');
    expect(wall.fill).toBe('#2b7eff');
    expect(wall.width).toBe(100); // top wall: w×d plane
    expect(wall.height).toBe(40);
    expect(wall.effects).toBeUndefined(); // keeps depth-group eligibility
    const back = layers.find((l) => l.id === 'box::ext-back')!;
    expect(back.kind).toBe('shape');
    expect(back.fill).toBe('#2b7eff');
    expect(back.width).toBe(100);
    expect(back.height).toBe(60);
    expect(back.matte).toBeUndefined();
    expect(back.isMatteSource).toBeUndefined();
  });

  it('lit (Accepts Lights + scene light): per-fragment shade data, no fixed gains', () => {
    const g = new SceneGraph();
    g.addNode(whiteLight('L'));
    g.addNode(shape3D('box', { extrusionDepth: 40, acceptsLights: true }));
    const layers = snap(g).layers;
    const wall = layers.find((l) => l.id === 'box::ext-r')!;
    const back = layers.find((l) => l.id === 'box::ext-back')!;
    // A white 80% point light AT the layer position: full contribution on every
    // face regardless of normal (d ≈ 0 ⇒ lambert 1).
    expect(wall.shade3d).toBeDefined();
    expect(back.shade3d).toBeDefined();
    expect(wall.lighting![0]).toBeCloseTo(0.8, 5);
    expect(back.lighting![0]).toBeCloseTo(0.8, 5);
  });

  it('Draft 3D still emits the geometry, with the fixed gains (cheap path)', () => {
    const g = new SceneGraph();
    g.addNode(whiteLight('L'));
    g.addNode(shape3D('box', { extrusionDepth: 40, acceptsLights: true }));
    const layers = snap(g, new AnimationEngine(), 0, { draft3d: true }).layers;
    const wall = layers.find((l) => l.id === 'box::ext-r')!;
    expect(wall).toBeDefined(); // shape must not collapse in draft
    expect(wall.lighting).toEqual([EXTRUSION_WALL_GAIN, EXTRUSION_WALL_GAIN, EXTRUSION_WALL_GAIN]);
    expect(wall.shade3d).toBeUndefined();
  });

  it('keyframed extrusionDepth samples at the frame time', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box'));
    const anim = new AnimationEngine();
    anim.setKeyframe('box', 'extrusionDepth', 0, 0);
    anim.setKeyframe('box', 'extrusionDepth', 2, 100);
    expect(snap(g, anim, 0).layers).toHaveLength(1); // 0 at t=0 ⇒ flat
    const layers = snap(g, anim, 1).layers; // 50 at t=1
    expect(layers).toHaveLength(6);
    const back = layers.find((l) => l.id === 'box::ext-back')!;
    expect(origin(back.world3d!).z).toBeCloseTo(50, 6);
  });

  it('ellipse content gets a segmented side wall ring', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('disc', { extrusionDepth: 40, shapeType: 'ellipse' }));
    const layers = snap(g).layers;
    expect(layers).toHaveLength(1 + 1 + ELLIPSE_WALL_SEGMENTS); // front + back + ring
    expect(layers[layers.length - 1]!.id).toBe('disc');
    expect(layers.filter((l) => l.id.startsWith('disc::ext-w'))).toHaveLength(ELLIPSE_WALL_SEGMENTS);
  });

  it('two extruded objects stay grouped per object after the painter sort', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('far', { extrusionDepth: 30, z: 400 }));
    g.addNode(shape3D('near', { extrusionDepth: 30, z: 0 }));
    const ids = snap(g).layers.map((l) => l.id.split('::')[0]);
    // Painter order: farther object's whole run first, then the nearer one.
    expect(ids).toEqual(['far', 'far', 'far', 'far', 'far', 'far', 'near', 'near', 'near', 'near', 'near', 'near']);
  });
});

describe('buildSnapshot — 3D extrusion bevel', () => {
  it('bevelDepth 0 (or unset) is byte-identical to today: back + 4 walls + front', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40 })); // no bevelDepth prop
    const ids = snap(g).layers.map((l) => l.id);
    expect(ids).toEqual(['box::ext-back', 'box::ext-r', 'box::ext-l', 'box::ext-t', 'box::ext-b', 'box']);
    // Explicit bevelDepth 0 must not add chamfer faces either.
    const g2 = new SceneGraph();
    g2.addNode(shape3D('box2', { extrusionDepth: 40, bevelDepth: 0 }));
    expect(snap(g2).layers.map((l) => l.id)).toEqual([
      'box2::ext-back', 'box2::ext-r', 'box2::ext-l', 'box2::ext-t', 'box2::ext-b', 'box2',
    ]);
  });

  it('bevel > 0 emits the chamfer rings CONTIGUOUS in the depth group, front last', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40, bevelDepth: 10 }));
    const layers = snap(g).layers;
    // Back-to-front by true depth: back cap, then the BACK chamfer ring, then the
    // walls, then the FRONT chamfer ring, then the front face. Previously the
    // back chamfers were painted after the front chamfers (they all shared one
    // depth, so emission order won) — visibly wrong on a bevelled box.
    expect(layers.map((l) => l.id)).toEqual([
      'box::ext-back',
      'box::ext-cbr', 'box::ext-cbl', 'box::ext-cbt', 'box::ext-cbb',
      'box::ext-r', 'box::ext-l', 'box::ext-t', 'box::ext-b',
      'box::ext-cfr', 'box::ext-cfl', 'box::ext-cft', 'box::ext-cfb',
      'box',
    ]);
    // Depths are strictly non-increasing along paint order (farthest first).
    const depths = layers.map((l) => l.depth!);
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]!).toBeLessThanOrEqual(depths[i - 1]! + 1e-9);
    }
    // Chamfers are solid wall quads carrying the fixed wall gain (unlit).
    const cf = layers.find((l) => l.id === 'box::ext-cfr')!;
    expect(cf.kind).toBe('shape');
    expect(cf.fill).toBe('#2b7eff');
    expect(cf.lighting).toEqual([EXTRUSION_WALL_GAIN, EXTRUSION_WALL_GAIN, EXTRUSION_WALL_GAIN]);
  });

  it('front face is inset by the bevel (w−2b × h−2b), back cap too', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40, bevelDepth: 10 }));
    const layers = snap(g).layers;
    const front = layers.find((l) => l.id === 'box')!;
    expect(front.width).toBe(100 - 20);
    expect(front.height).toBe(60 - 20);
    const back = layers.find((l) => l.id === 'box::ext-back')!;
    expect(back.width).toBe(100 - 20);
    expect(back.height).toBe(60 - 20);
  });

  it('keyframed bevelDepth is sampled at the frame time', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40 }));
    const anim = new AnimationEngine();
    anim.setKeyframe('box', 'bevelDepth', 0, 0);
    anim.setKeyframe('box', 'bevelDepth', 2, 20);
    // t=0 ⇒ bevel 0 ⇒ plain box (6 layers, no chamfers).
    expect(snap(g, anim, 0).layers).toHaveLength(6);
    // t=1 ⇒ bevel 10 ⇒ chamfer rings present + inset front.
    const layers = snap(g, anim, 1).layers;
    expect(layers).toHaveLength(14);
    expect(layers.find((l) => l.id === 'box::ext-cfr')).toBeDefined();
    expect(layers.find((l) => l.id === 'box')!.width).toBeCloseTo(100 - 20, 6);
  });

  it('bevel is clamped so geometry never inverts (huge bevel ⇒ walls drop out)', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40, bevelDepth: 999 }));
    const ids = snap(g).layers.map((l) => l.id);
    // Clamp = d/2 = 20 ⇒ wall depth 0 ⇒ side walls omitted; caps + rings stay.
    expect(ids).not.toContain('box::ext-r');
    expect(ids).toContain('box::ext-back');
    expect(ids.filter((i) => i.includes('::ext-c'))).toHaveLength(8);
  });

  /**
   * A ROUNDED layer with a bevel set: the inset must follow the geometry.
   *
   * The rounded-outline branch returns before the bevel path and emits no
   * chamfer ring — while `buildSnapshot` insets the front face by
   * `clampBevel(...)` for any rect. A rounded card with `bevelDepth: 12`
   * therefore drew a front face 24 px narrower than its own outline, meeting a
   * ring that did not exist, and the darker back cap showed through the
   * ring-shaped gap between them.
   *
   * Asserted on the front face's SIZE rather than on the presence of chamfer
   * ids: the missing ring was never the bug — declining to bevel a rounded
   * corner is a deliberate, documented choice. The bug was the caller acting on
   * a bevel that had not been emitted.
   */
  it('a ROUNDED layer with a bevel keeps its front face full-size', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('card', { extrusionDepth: 40, bevelDepth: 12, cornerRadius: 20 }));
    const layers = snap(g).layers;
    const front = layers.find((l) => l.id === 'card')!;
    expect([front.width, front.height]).toEqual([100, 60]);
    // No chamfer ring was emitted, which is why there is nothing to inset to.
    expect(layers.filter((l) => l.id.includes('::ext-c'))).toHaveLength(0);
  });

  it('a square-cornered layer with the same bevel still insets (no over-correction)', () => {
    // The control for the case above: the fix must not have turned the inset
    // off in general, only where the geometry declined to bevel.
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40, bevelDepth: 12, cornerRadius: 0 }));
    const front = snap(g).layers.find((l) => l.id === 'box')!;
    expect([front.width, front.height]).toEqual([100 - 24, 60 - 24]);
  });

  it('an ELLIPSE with a bevel keeps its front face full-size too', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('disc', { extrusionDepth: 40, bevelDepth: 12, shapeType: 'ellipse' }));
    const front = snap(g).layers.find((l) => l.id === 'disc')!;
    expect([front.width, front.height]).toEqual([100, 60]);
  });
});

describe('buildSnapshot — anchor-offset extrusion stays glued', () => {
  const tp = (m: readonly number[], p: { x: number; y: number; z: number }) =>
    Matrix4Math.transformPoint(m as import('@motion/scene').Matrix4, p);

  it('a wall corner still coincides with the front-face corner under an offset anchor', () => {
    const W = 100, H = 60, D = 40;
    const g = new SceneGraph();
    // Non-centered anchor (offset from the layer centre) + rotation so the
    // whole box is obliquely projected — the wall must stay welded to the front.
    g.addNode(shape3D('box', { extrusionDepth: D, anchorX: 30, anchorY: -15, rotationY: 35, rotationX: 20 }));
    const layers = snap(g).layers;
    const front = layers.find((l) => l.id === 'box')!;
    const wallR = layers.find((l) => l.id === 'box::ext-r')!;
    // Shared front-bottom-right corner: front content (W/2,−H/2,0) vs the right
    // wall's own front edge (face-local D/2,−H/2,0). Both ride the SAME layer
    // world matrix, so the corner lands at one world point regardless of anchor.
    const a = tp(front.world3d!, { x: W / 2, y: -H / 2, z: 0 });
    const b = tp(wallR.world3d!, { x: D / 2, y: -H / 2, z: 0 });
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
  });
});

describe('extrusion through the FrameScene adapter', () => {
  it('all 6 faces become depth-eligible 3D renderables (ONE depth-tested group)', () => {
    const g = new SceneGraph();
    g.addNode(shape3D('box', { extrusionDepth: 40 }));
    const scene = snapshotToFrameScene(snap(g));
    expect(scene.camera3d).toBeDefined();
    expect(scene.renderables).toHaveLength(6);
    for (const r of scene.renderables) {
      expect(r.threeD).toBeDefined();
      expect(depthEligible3D(r)).toBe(true);
    }
  });
});

describe('buildSnapshot — 3D solids', () => {
  function solid(id: string, extra: Record<string, unknown> = {}): SceneNode {
    return {
      id, name: id, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 100, y: 80 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 80, rotation: 0, ...extra } },
        { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#222222' } },
        { id: `${id}_f`, type: 'fx', props: { solid: true } },
      ],
    } as unknown as SceneNode;
  }

  it('an un-switched solid stays pinned full-comp exactly as before', () => {
    const g = new SceneGraph();
    g.addNode(solid('bg'));
    const l = snap(g).layers[0]!;
    expect(l.x).toBe(COMP.width / 2);
    expect(l.y).toBe(COMP.height / 2);
    expect(l.width).toBe(COMP.width);
    expect(l.height).toBe(COMP.height);
    expect(l.matrix).toBeUndefined();
    expect(l.world3d).toBeUndefined();
  });

  it('a solid with the 3D switch projects through the camera like any layer', () => {
    const g = new SceneGraph();
    g.addNode(solid('wall3d', { z: 0, rotationY: 60 }));
    const l = snap(g).layers[0]!;
    expect(l.world3d).toBeDefined();
    expect(l.matrix).toBeDefined();
    expect(l.width).toBe(COMP.width); // still comp-sized content
    expect(l.scaleX).toBeLessThan(0.75); // rotY 60° foreshortens (~cos + perspective)
    expect(l.scaleY).toBeCloseTo(1, 1);
  });

  it('a 3D solid can extrude too', () => {
    const g = new SceneGraph();
    g.addNode(solid('slab', { z: 0, extrusionDepth: 25 }));
    const layers = snap(g).layers;
    expect(layers).toHaveLength(6);
    expect(layers[5]!.id).toBe('slab');
  });

  it('text layers generate continuous 3D contour volume slices for solid 3D text', () => {
    const g = new SceneGraph();
    g.addNode({
      id: 'text3d',
      name: '3D Text',
      parent: null,
      children: [],
      visible: true,
      locked: false,
      transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        // NB: the component type is 'Transform' (capital T) and the copy lives
        // on a Text component's `content` — this is what threeD.ts/buildSnapshot
        // actually read. A lowercase 'transform' here silently yields a plain
        // 2D shape layer, so the assertions below would never exercise the
        // contour-slice path.
        { id: 'c1', type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 960, y: 540, z: 0, width: 400, height: 80, extrusionDepth: 30 } },
        { id: 'c2', type: 'Text', props: { content: 'HELLO 3D', fontSize: 40, fontFamily: 'Inter' } },
      ],
    } as unknown as SceneNode);
    const layers = snap(g).layers;
    expect(layers.length).toBeGreaterThan(10);
    const backCap = layers.find((l) => l.id === 'text3d::ext-back');
    expect(backCap).toBeDefined();
    expect(layers[layers.length - 1]!.id).toBe('text3d');
  });
});

