/**
 * A 3D layer projects through the composition's CAMERA LAYER — the guard that
 * did not exist.
 *
 * The 3D suites around this one all render through the DEFAULT camera: none of
 * them puts an actual Camera layer in the graph and asserts that moving it moves
 * the 3D layers. So the whole camera → projection path — `activeCameraNode`
 * finding the camera, `cameraFromNode` resolving it, `project` applying it —
 * was carried by 4,600+ passing tests without a single assertion on its output.
 * A scene could lose its camera entirely and every test would still be green.
 *
 * These pin the two things a user actually sees:
 *   • moving the camera moves 3D layers and leaves 2D layers alone, and
 *   • per-character 3D text — a SEPARATE projection path from ordinary 3D
 *     layers — follows the same camera by the same amount.
 *
 * Both are asserted for a single-composition project and for a multi-comp one,
 * because the camera lookup is comp-SCOPED: a camera belongs to its composition
 * and must not steer any other.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const W = 1920;
const H = 1080;

function node(
  id: string,
  kind: string,
  parent: string | null,
  props: Record<string, unknown>,
): SceneNode {
  // Text content rides its OWN component (`Text.content`), not a Transform
  // prop — a text node without it lays out zero glyphs and silently emits no
  // per-character planes at all.
  const { text, fontSize, ...transformProps } = props as { text?: string; fontSize?: number };
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, ...transformProps } },
      ...(kind === 'text'
        ? [{ id: `${id}_x`, type: 'Text', props: { content: text ?? 'Text', fontSize: fontSize ?? 40, fontFamily: 'Inter', align: 'center' } }]
        : []),
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

/** Marks a layer 3D: numeric z / rotationX / rotationY is what is3DEnabled tests. */
const three = (p: Record<string, unknown> = {}) => ({ z: 0, rotationX: 0, rotationY: 0, ...p });

const snapOf = (g: SceneGraph, rootId: string) =>
  buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    width: W, height: H, background: '#101014', rootId,
  } as never);

/**
 * One comp: a 2D shape, a 3D shape, a 2D text and a per-char 3D text, all at the
 * comp centre, plus a camera at `camX`. Mirrors the live probe exactly.
 */
function scene(camX: number) {
  const g = new SceneGraph();
  g.addNode(node('root', 'group', null, {}));
  g.addChild('root', node('flatShape', 'shape', 'root', { x: W / 2, y: H / 2, width: 300, height: 300 }));
  g.addChild('root', node('deepShape', 'shape', 'root', { x: W / 2, y: H / 2, width: 300, height: 300, ...three() }));
  g.addChild('root', node('flatText', 'text', 'root', { x: W / 2, y: H / 2, text: 'Text', fontSize: 96 }));
  g.addChild('root', node('deepText', 'text', 'root', {
    x: W / 2, y: H / 2, text: 'Text', fontSize: 96, perChar3D: true, ...three(),
  }));
  // z = −focalLength is the framing insertCamera seeds: the comp plane renders 1:1.
  g.addChild('root', node('cam', 'camera', 'root', { x: camX, y: H / 2, z: -2666.5025797583758, focalLength: 2666.5025797583758 }));
  return snapOf(g, 'root');
}

const xOf = (s: ReturnType<typeof snapOf>, id: string) => s.layers.find((l) => l.id === id)?.x;
/** Every per-character glyph plane the text layer expanded into. */
const glyphsOf = (s: ReturnType<typeof snapOf>, id: string) =>
  s.layers.filter((l) => l.id.startsWith(`${id}::ch`));

describe('3D layers project through the comp camera; 2D layers do not', () => {
  it('panning the camera slides 3D layers the opposite way and leaves 2D put', () => {
    const at0 = scene(W / 2);
    const at400 = scene(W / 2 + 400);

    // 2D layers never consult the camera — this is the control.
    expect(xOf(at0, 'flatShape')).toBeCloseTo(W / 2, 4);
    expect(xOf(at400, 'flatShape')).toBeCloseTo(W / 2, 4);
    expect(xOf(at400, 'flatText')).toBeCloseTo(xOf(at0, 'flatText')!, 4);

    // The 3D layer sits on the comp plane, so a 400px camera pan moves it
    // exactly 400px the other way (1:1 at the focal distance).
    expect(xOf(at0, 'deepShape')).toBeCloseTo(W / 2, 4);
    expect(xOf(at400, 'deepShape')).toBeCloseTo(W / 2 - 400, 4);
  });

  it('per-character 3D text follows the SAME camera by the same amount', () => {
    // A separate projection path from ordinary 3D layers (each glyph is its own
    // plane), so it needs its own assertion — a break here is invisible to the
    // layer-level test above.
    const g0 = glyphsOf(scene(W / 2), 'deepText');
    const g400 = glyphsOf(scene(W / 2 + 400), 'deepText');

    expect(g0.length).toBeGreaterThan(1);
    expect(g400).toHaveLength(g0.length);
    g0.forEach((glyph, i) => {
      expect(g400[i]!.x).toBeCloseTo(glyph.x - 400, 4);
    });
  });

  it('a camera dollied back shrinks 3D layers and never touches 2D ones', () => {
    const g = new SceneGraph();
    g.addNode(node('root', 'group', null, {}));
    g.addChild('root', node('flat', 'shape', 'root', { x: W / 2, y: H / 2, width: 300, height: 300 }));
    g.addChild('root', node('deep', 'shape', 'root', { x: W / 2, y: H / 2, width: 300, height: 300, ...three() }));
    // Twice the focal distance from the comp plane ⇒ exactly half scale.
    g.addChild('root', node('cam', 'camera', 'root', { x: W / 2, y: H / 2, z: -2 * 2666.5025797583758, focalLength: 2666.5025797583758 }));
    const s = snapOf(g, 'root');
    expect(s.layers.find((l) => l.id === 'deep')!.scaleX).toBeCloseTo(0.5, 5);
    expect(s.layers.find((l) => l.id === 'flat')!.scaleX).toBeCloseTo(1, 5);
  });
});

describe('the camera is scoped to its own composition', () => {
  /** Two sibling comps, each with its own camera at a different x. */
  function twoComps() {
    const g = new SceneGraph();
    g.addNode(node('rootA', 'group', null, {}));
    g.addNode(node('rootB', 'group', null, {}));
    for (const [root, camX] of [['rootA', W / 2 + 400], ['rootB', W / 2 - 300]] as const) {
      g.addChild(root, node(`${root}_deep`, 'shape', root, { x: W / 2, y: H / 2, width: 300, height: 300, ...three() }));
      g.addChild(root, node(`${root}_cam`, 'camera', root, {
        x: camX, y: H / 2, z: -2666.5025797583758, focalLength: 2666.5025797583758,
      }));
    }
    return g;
  }

  it("each comp renders through its OWN camera, and neither leaks into the other", () => {
    const g = twoComps();
    // Comp A's camera is +400 ⇒ its layer projects 400 left of centre.
    expect(xOf(snapOf(g, 'rootA'), 'rootA_deep')).toBeCloseTo(W / 2 - 400, 4);
    // Comp B's is −300 ⇒ 300 right. If the lookup were scene-wide, one of these
    // would take the other's camera and both would land on the same number.
    expect(xOf(snapOf(g, 'rootB'), 'rootB_deep')).toBeCloseTo(W / 2 + 300, 4);
  });

  it('per-char 3D text is comp-scoped too', () => {
    const g = new SceneGraph();
    g.addNode(node('rootA', 'group', null, {}));
    g.addNode(node('rootB', 'group', null, {}));
    g.addChild('rootA', node('a_text', 'text', 'rootA', {
      x: W / 2, y: H / 2, text: 'Text', fontSize: 96, perChar3D: true, ...three(),
    }));
    g.addChild('rootA', node('a_cam', 'camera', 'rootA', {
      x: W / 2, y: H / 2, z: -2666.5025797583758, focalLength: 2666.5025797583758,
    }));
    // A far-away camera in the OTHER comp must not touch comp A's glyphs.
    g.addChild('rootB', node('b_cam', 'camera', 'rootB', {
      x: W / 2 + 5000, y: H / 2, z: -2666.5025797583758, focalLength: 2666.5025797583758,
    }));

    const glyphs = glyphsOf(snapOf(g, 'rootA'), 'a_text');
    expect(glyphs.length).toBeGreaterThan(1);
    // Centred camera ⇒ the glyph run straddles the comp centre, unshifted.
    for (const glyph of glyphs) {
      expect(Math.abs(glyph.x - W / 2)).toBeLessThan(W / 2);
    }
    const centre = glyphs.reduce((sum, glyph) => sum + glyph.x, 0) / glyphs.length;
    expect(centre).toBeGreaterThan(W / 2 - 400);
    expect(centre).toBeLessThan(W / 2 + 400);
  });
});

/**
 * The near plane, for geometry DERIVED from a layer rather than the layer itself.
 *
 * `projectPoint` clamps at the near plane instead of rejecting, so anything
 * behind the camera comes back at focalLength/1 — ~2666× on a 1920-wide comp.
 * The layer ORIGIN has been guarded for a long time; the three derived paths
 * (extrusion slices, extrusion faces, per-character glyphs) were not, and they
 * are exactly the cases where the origin sits safely in front while the geometry
 * hanging off it sweeps through the near plane.
 *
 * Measured before the guard: a glyph at scaleY 2666.5 (the focal length itself,
 * the clamp's signature) parked at x = 3259 on a 1920 comp, and an extrusion
 * face at x = 33306.
 */
describe('near-plane clipping reaches derived 3D geometry', () => {
  /**
   * The clamp's signature, asserted precisely rather than by an eyeballed
   * bound: `projectPoint` floors depth at NEAR = 1 for anything behind the eye,
   * so a piece of derived geometry that survived the guard reports depth 1 and
   * a scale of focalLength/1. Legitimately close geometry can still be large
   * and far off-frame — that is real perspective, not the bug — so depth at the
   * clamp floor is the thing to test.
   */
  const assertNoClampedGeometry = (s: ReturnType<typeof snapOf>) => {
    const derived = s.layers.filter((l) => l.id.includes('::ext') || l.id.includes('::ch'));
    expect(derived.length).toBeGreaterThan(0);
    for (const l of derived) {
      expect(l.depth).toBeGreaterThan(1);
      // …and none carries the focal-length scale the clamp produces.
      expect(Math.abs(l.scaleY)).toBeLessThan(2000);
    }
  };

  it('drops per-character glyphs that fall behind the camera', () => {
    const g = new SceneGraph();
    g.addNode(node('root', 'group', null, {}));
    // Edge-on text with the camera just in front of the comp plane: the glyph
    // run sweeps through depth, so the far glyphs pass behind the eye while the
    // layer's own origin stays in front and survives its own guard.
    g.addChild('root', node('txt', 'text', 'root', {
      x: W / 2, y: H / 2, text: 'Text', fontSize: 96, perChar3D: true, ...three({ rotationY: 89 }),
    }));
    g.addChild('root', node('cam', 'camera', 'root', {
      x: W / 2, y: H / 2, z: -50, focalLength: 2666.5025797583758,
    }));
    assertNoClampedGeometry(snapOf(g, 'root'));
  });

  // Extrusion grows along the layer's LOCAL +z, so a layer turned 180° about Y
  // extrudes back toward the viewer: the origin stays in front of the eye (and
  // passes its own guard) while the body runs through the near plane. That is
  // the only way a face gets behind the camera without the whole layer being
  // dropped first — a merely close, steeply-angled layer projects far off-frame
  // for legitimate perspective reasons and proves nothing.
  it('drops extrusion FACES that fall behind the camera', () => {
    const g = new SceneGraph();
    g.addNode(node('root', 'group', null, {}));
    g.addChild('root', node('box', 'shape', 'root', {
      x: W / 2, y: H / 2, width: 300, height: 300,
      // Depth 200 with the eye at −50 straddles deliberately: the front cap
      // (z = 100) and the side walls (mid z = 0) stay in front and must SURVIVE,
      // while the back cap (z = −100) is behind and must go. A depth that puts
      // every face behind would empty the list and assert nothing.
      ...three({ z: 100, rotationY: 180 }), extrusionDepth: 200,
    }));
    g.addChild('root', node('cam', 'camera', 'root', {
      x: W / 2, y: H / 2, z: -50, focalLength: 2666.5025797583758,
    }));
    assertNoClampedGeometry(snapOf(g, 'root'));
  });

  it('drops extrusion SLICES that fall behind the camera', () => {
    // Text extrudes as contour slices rather than six faces (isComplexContent),
    // which is a separate projection site and needs its own guard.
    const g = new SceneGraph();
    g.addNode(node('root', 'group', null, {}));
    g.addChild('root', node('word', 'text', 'root', {
      x: W / 2, y: H / 2, width: 400, height: 120, text: 'Text', fontSize: 96,
      ...three({ z: 100, rotationY: 180 }), extrusionDepth: 600,
    }));
    g.addChild('root', node('cam', 'camera', 'root', {
      x: W / 2, y: H / 2, z: -50, focalLength: 2666.5025797583758,
    }));
    assertNoClampedGeometry(snapOf(g, 'root'));
  });

  it('leaves ordinary in-front geometry alone', () => {
    // The regression guard for the guard: a normal extruded 3D layer must still
    // emit all of its faces.
    const g = new SceneGraph();
    g.addNode(node('root', 'group', null, {}));
    g.addChild('root', node('box', 'shape', 'root', {
      x: W / 2, y: H / 2, width: 300, height: 300, ...three(), extrusionDepth: 200,
    }));
    g.addChild('root', node('cam', 'camera', 'root', {
      x: W / 2, y: H / 2, z: -2666.5025797583758, focalLength: 2666.5025797583758,
    }));
    const s = snapOf(g, 'root');
    expect(s.layers.filter((l) => l.id.startsWith('box::ext')).length).toBeGreaterThan(0);
  });
});
