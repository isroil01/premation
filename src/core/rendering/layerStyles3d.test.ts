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
import {
  DEFAULT_DROP_SHADOW, DEFAULT_COLOR_OVERLAY, DEFAULT_GRADIENT_OVERLAY,
  defaultGlassStyle, styledSurfaceFill, type LayerStyles,
} from '@core/effects/layerStyles';

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
