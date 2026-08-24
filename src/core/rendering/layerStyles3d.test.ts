/**
 * Layer styles on 3D layers — the seams where a style used to vanish the moment
 * a layer's 3D switch was flipped.
 *
 * Every one of these was verified against real GPU pixels through the
 * golden-frame harness before being written down here; these are the cheap
 * structural guards that keep the same regressions from coming back silently.
 */

import { buildSnapshot } from './buildSnapshot';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { Color, depthEligible3D } from '@motion/renderer';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { parseHex, sampleFillAt } from '@core/paint/fill';
import {
  DEFAULT_DROP_SHADOW, DEFAULT_COLOR_OVERLAY, DEFAULT_GRADIENT_OVERLAY,
  defaultGlassStyle, styledSurfaceFill, type LayerStyles,
} from '@core/effects/layerStyles';

// These cases pin the QUAD-SYNTHESIS extrusion (scene/extrusion.ts), which is
// now the FALLBACK behind the mesh path (scene/extrusionMesh.ts) — taken when
// an outline cannot be produced. The fallback is still live code, so its
// guarantees are kept by switching the mesh path off for this file.
import { setExtrusionMeshPath } from '@core/scene/extrusionMesh';
beforeAll(() => setExtrusionMeshPath(false));
afterAll(() => setExtrusionMeshPath(true));

const COMP = { width: 800, height: 600, background: '#101014' };

function layer(styles: LayerStyles, extra: Record<string, unknown> = {}): SceneNode {
  return {
    id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: 'n_t', type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0, width: 300, height: 150,
          z: 0, rotationX: 0, rotationY: 0, ...extra,
        },
      },
      { id: 'n_s', type: 'Style', props: { opacity: 100, fill: '#2b4a8f' } },
      { id: 'n_f', type: 'fx', props: { layerStyles: styles } },
    ],
  } as unknown as SceneNode;
}

function scene(styles: LayerStyles, extra: Record<string, unknown> = {}) {
  const g = new SceneGraph();
  g.addNode(layer(styles, extra));
  return snapshotToFrameScene(
    buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP),
  );
}

describe('glass on a 3D layer', () => {
  // Glass is a function of what is composited BENEATH the layer, and the
  // depth-tested 3D group cannot sample the target it is drawing into. It had
  // no backdrop branch at all, so a 3D glass panel fell through to the plain
  // solid draw and rendered as an opaque white card.
  it('is not depth-eligible, so it keeps the backdrop-sampling path', () => {
    const r = scene({ glass: defaultGlassStyle() }).renderables.find((x) => x.id === 'n')!;
    expect(r.glass).toBeDefined();
    expect(r.threeD).toBeDefined();
    expect(depthEligible3D(r)).toBe(false);
  });

  it('a 3D layer WITHOUT glass still takes the depth-tested path', () => {
    const r = scene({}).renderables.find((x) => x.id === 'n')!;
    expect(r.threeD).toBeDefined();
    expect(depthEligible3D(r)).toBe(true);
  });
});

describe('an extruded object is ONE object', () => {
  // The walls / bevel rings / back cap are synthesized geometry tinted from
  // `layer.fill` — the layer's RAW colour. An overlay repainted only the front
  // face, so a red-fronted box kept blue sides, split along the front edge.
  it('a colour overlay reaches the extruded faces, not just the front', () => {
    const g = new SceneGraph();
    g.addNode(layer({ colorOverlay: { ...DEFAULT_COLOR_OVERLAY, color: '#ff0000' } }, { extrusionDepth: 60 }));
    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    const faces = snap.layers.filter((l) => l.id.startsWith('n::ext-'));
    expect(faces.length).toBeGreaterThan(0);
    // Every face is tinted from the overlay colour, not the original blue.
    for (const f of faces) expect(f.fill).not.toBe('#2b4a8f');
  });

  it('styledSurfaceFill takes the overlay colour, and the ramp midpoint', () => {
    expect(styledSurfaceFill(undefined, '#2b4a8f')).toBe('#2b4a8f');
    expect(styledSurfaceFill({ colorOverlay: { ...DEFAULT_COLOR_OVERLAY, color: '#ff0000', opacity: 1 } }, '#2b4a8f'))
      .toBe('#ff0000');
    // Half-strength overlay lands halfway between the two.
    expect(styledSurfaceFill({ colorOverlay: { ...DEFAULT_COLOR_OVERLAY, color: '#ffffff', opacity: 0.5 } }, '#000000'))
      .toBe('#808080');
    // A ramp has to collapse to ONE colour on a flat face: its midpoint.
    expect(styledSurfaceFill({ gradientOverlay: { ...DEFAULT_GRADIENT_OVERLAY, from: '#000000', to: '#ffffff', opacity: 1 } }, '#2b4a8f'))
      .toBe('#808080');
  });

  it('the synthesized faces carry no effect chain of their own', () => {
    // One resolve per face would stack the same drop shadow N times AND force N
    // full-viewport offscreen passes every frame.
    const g = new SceneGraph();
    g.addNode(layer({ dropShadow: { ...DEFAULT_DROP_SHADOW } }, { extrusionDepth: 60 }));
    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    for (const f of snap.layers.filter((l) => l.id.startsWith('n::ext-'))) {
      expect(f.effects).toBeUndefined();
    }
  });
});

describe('drop shadow / outer glow survive the 3D switch', () => {
  // These compile to structured effects identically in 2D and 3D; what used to
  // break them was the RENDERER resolving a 3D layer's chain in a buffer the
  // layer filled edge to edge, leaving a shadow nowhere to fall.
  it('a 3D layer keeps its drop-shadow effect and stays depth-eligible', () => {
    const r = scene({ dropShadow: { ...DEFAULT_DROP_SHADOW } }).renderables.find((x) => x.id === 'n')!;
    expect(r.effects?.some((e) => e.type === 'drop-shadow')).toBe(true);
    expect(depthEligible3D(r)).toBe(true);
  });
});

describe('an extruded solid keeps ONE surface across every face', () => {
  // The walls are synthesized flat strips that used to take `layer.fill` — the
  // layer's BASE colour, which a gradient fill never writes to. So a
  // blue→orange box drew gradient caps and four flat BLUE walls.
  const GRADIENT = {
    type: 'linear', angle: 90, // 0°=→, 90°=↓ : blue at the top, orange at the bottom
    stops: [
      { id: 'a', offset: 0, color: '#0000ff' },
      { id: 'b', offset: 1, color: '#ff0000' },
    ],
  };

  function extruded(fill: unknown, shapeType = 'rect'): SceneNode {
    return {
      id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        {
          id: 'n_t', type: 'Transform',
          props: {
            [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0, width: 200, height: 140,
            shapeType, z: 0, rotationX: 0, rotationY: 0, extrusionDepth: 60,
          },
        },
        { id: 'n_s', type: 'Style', props: { opacity: 100, fill: '#0000ff' } },
        { id: 'n_f', type: 'fx', props: { fill } },
      ],
    } as unknown as SceneNode;
  }

  const facesOf = (n: SceneNode) => {
    const g = new SceneGraph();
    g.addNode(n);
    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    return snap.layers.filter((l) => l.id.startsWith('n::ext-'));
  };

  it('a vertical ramp puts its TOP colour on the top wall and its BOTTOM on the bottom', () => {
    const faces = facesOf(extruded(GRADIENT));
    const rgb = (id: string) => {
      const f = faces.find((l) => l.id === `n::ext-${id}`)!;
      const c = parseHex(String(f.fill));
      return [c.r, c.g, c.b];
    };
    // Walls are split into strips; strip 0 of the top wall sits at the top edge.
    const [tr, , tb] = rgb('t0');
    expect(tb).toBeGreaterThan(200); // blue
    expect(tr).toBeLessThan(60);
    const bottom = faces.filter((l) => /^n::ext-b\d+$/.test(l.id)).pop()!;
    const cb = parseHex(String(bottom.fill));
    expect(cb.r).toBeGreaterThan(200); // red
    expect(cb.b).toBeLessThan(60);
  });

  it('the side walls RAMP down their length instead of taking one flat colour', () => {
    const faces = facesOf(extruded(GRADIENT));
    const right = faces
      .filter((l) => /^n::ext-r\d+$/.test(l.id))
      .sort((a, b) => Number(a.id.slice(9)) - Number(b.id.slice(9)))
      .map((l) => parseHex(String(l.fill)).r);
    expect(right.length).toBeGreaterThan(1);
    // Red rises monotonically from the top of the wall to the bottom.
    expect(right[right.length - 1]!).toBeGreaterThan(right[0]! + 100);
    for (let i = 1; i < right.length; i++) expect(right[i]!).toBeGreaterThanOrEqual(right[i - 1]!);
  });

  it('a SOLID fill leaves the geometry exactly as it was — 4 walls, not 4×N strips', () => {
    // Splitting only buys something for a gradient; paying for it always would
    // change every existing extrusion's face count for no visible gain.
    const ids = facesOf(extruded({ type: 'solid', color: '#0000ff' })).map((l) => l.id).sort();
    expect(ids).toEqual(['n::ext-b', 'n::ext-back', 'n::ext-l', 'n::ext-r', 'n::ext-t']);
  });

  it('sampleFillAt agrees with the gradient the front face is painted with', () => {
    // Same geometry as makeCanvasGradient: 0°=→, 90°=↓, centred local space.
    const g = GRADIENT as never;
    expect(parseHex(sampleFillAt(g, 200, 140, 0, -70)!).b).toBeGreaterThan(200); // top → blue
    expect(parseHex(sampleFillAt(g, 200, 140, 0, +70)!).r).toBeGreaterThan(200); // bottom → red
    const mid = parseHex(sampleFillAt(g, 200, 140, 0, 0)!);
    expect(mid.r).toBeGreaterThan(100);
    expect(mid.b).toBeGreaterThan(100);
    expect(sampleFillAt(undefined, 200, 140, 0, 0)).toBeUndefined();
  });
});

describe('parseHex accepts the rgba() form this module itself emits', () => {
  // sampleGradientColor returns `rgba(r, g, b, a)`. Feeding that back in — a
  // gradient sample with an overlay composited over it — used to come back
  // opaque BLACK.
  it('round-trips its own output', () => {
    expect(parseHex('rgba(255, 106, 0, 1.000)')).toEqual({ r: 255, g: 106, b: 0, a: 255 });
    expect(parseHex('rgb(0, 128, 255)')).toEqual({ r: 0, g: 128, b: 255, a: 255 });
    expect(parseHex('#ff6a00')).toEqual({ r: 255, g: 106, b: 0, a: 255 });
    expect(parseHex('nonsense')).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });
});

describe('Color.fromHex accepts the rgba() form the effect adapter produces', () => {
  // `withAlpha()` folds an effect's opacity into its colour by rewriting a
  // 6-digit hex as `rgba(r,g,b,a)`. A hex-only parser answered BLACK for every
  // one of those — which is why Gradient Ramp painted a black rectangle.
  it('parses rgba() and rgb()', () => {
    expect(Color.fromHex('rgba(255,0,0,1)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(Color.fromHex('rgb(0,255,0)')).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(Color.fromHex('rgba(0,0,255,0.5)').a).toBeCloseTo(0.5);
  });

  it('still parses every hex form, and still fails closed on nonsense', () => {
    expect(Color.fromHex('#ff0000')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(Color.fromHex('#f00')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(Color.fromHex('#ff000080').a).toBeCloseTo(0.5019, 3);
    expect(Color.fromHex('not-a-colour')).toEqual(Color.black());
  });
});
