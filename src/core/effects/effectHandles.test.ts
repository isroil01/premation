/**
 * Effect handles — the shared on-canvas control-point mechanism.
 *
 * Interaction code resists assertions, so the split here is deliberate: every
 * decision that can be made pure IS pure and tested here (where a handle sits,
 * which one a click picks, what a drag writes, whether a write keyframes), and
 * only the pointer plumbing is left to the runtime check.
 *
 * ── The transform chain, derived once ───────────────────────────────────
 *
 * A handle's screen position is three conversions:
 *
 *   effect space (0..w, 0..h)  --effectToLayer-->  layer-local (centred)
 *   layer-local                --layerSpaceAt-->   composition
 *   composition                --camera-->         screen
 *
 * The camera is `(p − centre)·zoom + view/2` (Camera.ts:203). Fixtures below use
 * centre (0,0) and view 0×0, so screen = comp · zoom and the arithmetic stays
 * checkable.
 *
 * ── What the clean values exclude (rule 3a) ─────────────────────────────
 *
 * The main rig is rotation 90°, scale (2,3), zoom 2. Each of those was chosen to
 * make the numbers exact, and each makes something unreachable:
 *
 *   rotation 90  → the composed matrix has a ZERO DIAGONAL, so an error in the
 *                  a/d terms contributes nothing   → identity + 180° fixtures
 *   scale (2,3)  → non-uniform, so a scale read from one axis twice still
 *                  differs                          → uniform-scale fixture
 *   no parent    → the parent chain is never walked  → parented fixture
 *   zoom 2       → a zoom of 1 is where "forgot to apply zoom" hides
 *                                                    → zoom-1 fixture
 *   handle ≠ centre → the half-box offset is only visible off-centre
 *                                                    → identity fixture pins it
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { layerSpaceAt } from '@core/scene/layerSpace';
import { defaultWarpPoints } from './bezierWarp';
import {
  EFFECT_HANDLES,
  collectEffectHandles,
  hitTestEffectHandle,
  handleDragValues,
  effectToLayer,
  layerToEffect,
  hasEffectHandles,
  HANDLE_PICK_RADIUS,
  type HandlePoint,
} from './effectHandles';
import type { SceneNode } from '@core/types';

const COMP = { width: 1920, height: 1080 };

interface NodeOpts {
  x?: number; y?: number; rotation?: number;
  scaleX?: number; scaleY?: number; parent?: string | null;
}
function node(id: string, o: NodeOpts = {}): SceneNode {
  const { x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1, parent = null } = o;
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation, scale: { x: scaleX, y: scaleY } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation, scaleX, scaleY, width: 100, height: 100 } },
      { id: `${id}_g`, type: 'Geometry', props: { shapeType: 'rect' } },
    ],
  } as unknown as SceneNode;
}
function reset(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Comp', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
}
beforeEach(reset);

/** The camera of Camera.ts:203, with centre (0,0) and a 0×0 view. */
const cam = (zoom: number) => (p: HandlePoint): HandlePoint => ({ x: p.x * zoom, y: p.y * zoom });

/** effect space → screen, the full chain, for the node named `id`. */
function toScreenFor(id: string, w: number, h: number, zoom: number) {
  const space = layerSpaceAt(id, 0, COMP)!;
  const c = cam(zoom);
  return (p: HandlePoint): HandlePoint => {
    const local = effectToLayer(p, w, h);
    const [cx, cy] = space.toComp([local.x, local.y]);
    return c({ x: cx, y: cy });
  };
}
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const at = (f: (p: HandlePoint) => HandlePoint, p: HandlePoint): [number, number] => {
  const q = f(p);
  return [r6(q.x), r6(q.y)];
};

describe('collecting handles', () => {
  it('rests where the spec says and moves by the param offset', () => {
    const none = collectEffectHandles('corner-pin', {}, 200, 100);
    expect(none.map((x) => [x.pos.x, x.pos.y]))
      .toEqual([[0, 0], [200, 0], [200, 100], [0, 100]]);
    // Offsets ADD to rest; a param the caller never set reads as 0, not NaN.
    const moved = collectEffectHandles('corner-pin', { topLeftX: 30, bottomRightY: -12 }, 200, 100);
    expect(moved[0]!.pos).toEqual({ x: 30, y: 0 });
    expect(moved[2]!.pos).toEqual({ x: 200, y: 88 });
    // `rest` survives alongside `pos`, because a drag needs it to invert.
    expect(moved[0]!.rest).toEqual({ x: 0, y: 0 });
  });

  it('reports nothing for an effect with no handles', () => {
    expect(collectEffectHandles('blur', { amount: 5 }, 100, 100)).toEqual([]);
    expect(hasEffectHandles('blur')).toBe(false);
    expect(hasEffectHandles('bezier-warp')).toBe(true);
  });

  /**
   * The §2·0 guard on the registry. A handle table that disagrees with the
   * effect's own rest geometry draws the user a patch different from the one
   * that renders — and nothing else in the system would notice, because both
   * halves are internally consistent.
   */
  it('bezier-warp rests EXACTLY where defaultWarpPoints puts them', () => {
    const w = 240, h = 160;
    const pts = defaultWarpPoints(w, h);
    const handles = collectEffectHandles('bezier-warp', {}, w, h);
    expect(handles).toHaveLength(12);
    expect(handles.map((x) => [r6(x.pos.x), r6(x.pos.y)]))
      .toEqual(pts.map((p) => [r6(p.x), r6(p.y)]));
  });

  it('corner-pin rests on the untransformed rectangle, in the effect’s order', () => {
    // `defaultCorners(w,h)` is [0,0, w,0, w,h, 0,h] — TL, TR, BR, BL.
    const handles = collectEffectHandles('corner-pin', {}, 240, 160);
    expect(handles.map((x) => x.spec.id)).toEqual(['topLeft', 'topRight', 'bottomRight', 'bottomLeft']);
    expect(handles.map((x) => [x.pos.x, x.pos.y])).toEqual([[0, 0], [240, 0], [240, 160], [0, 160]]);
  });

  it('every spec names params the effect actually declares', () => {
    // Catches a typo'd key, which would otherwise read 0 forever and write to a
    // param nothing renders — a dead handle that looks alive.
    const { EFFECT_DEFS } = jest.requireActual<typeof import('./effects')>('./effects');
    for (const [type, specs] of Object.entries(EFFECT_HANDLES)) {
      const def = EFFECT_DEFS.find((d) => d.type === type)!;
      const keys = new Set(def.params.map((p) => p.key));
      for (const s of specs!) {
        expect({ type, key: s.xKey, known: keys.has(s.xKey) }).toEqual({ type, key: s.xKey, known: true });
        expect({ type, key: s.yKey, known: keys.has(s.yKey) }).toEqual({ type, key: s.yKey, known: true });
      }
    }
  });
});

describe('effect space ↔ layer space', () => {
  it('differs from layer-local by exactly half the box', () => {
    expect(effectToLayer({ x: 0, y: 0 }, 200, 100)).toEqual({ x: -100, y: -50 });
    expect(effectToLayer({ x: 200, y: 100 }, 200, 100)).toEqual({ x: 100, y: 50 });
    expect(effectToLayer({ x: 100, y: 50 }, 200, 100)).toEqual({ x: 0, y: 0 });
  });

  it('round-trips', () => {
    const p = { x: 37, y: -14 };
    expect(layerToEffect(effectToLayer(p, 200, 100), 200, 100)).toEqual(p);
  });
});

describe('hit-testing is SCREEN-space with a constant radius', () => {
  const handles = collectEffectHandles('corner-pin', {}, 100, 100);
  /** Identity layer, so effect (x,y) → screen (x−50, y−50)·zoom. */
  const screenAt = (zoom: number) => {
    defaultSceneGraph.addChild('comp_root', node('L'));
    return toScreenFor('L', 100, 100, zoom);
  };

  /**
   * THE ZOOM-INVARIANCE GUARD, asserted at two zooms as required.
   *
   * The topRight handle rests at effect (100,0) → layer (50,−50) → comp (50,−50)
   * → screen (50z, −50z). At zoom 1 that is (50,−50); at zoom 4, (200,−200).
   *
   * A pointer 8 SCREEN px away must hit at BOTH, and one 10 px away must miss at
   * both — because the radius is 9 screen px and never converted. Convert it to
   * layer space instead and the effective screen radius becomes 9·z or 9/z, so
   * one of these four assertions fails whichever way the mistake goes.
   */
  it('the same SCREEN distance hits at zoom 1 and at zoom 4', () => {
    for (const z of [1, 4]) {
      reset();
      const toScreen = screenAt(z);
      const hs = toScreen({ x: 100, y: 0 });
      expect(at(toScreen, { x: 100, y: 0 })).toEqual([50 * z, -50 * z]);
      const hit = hitTestEffectHandle({ x: hs.x + 8, y: hs.y }, handles, toScreen);
      const miss = hitTestEffectHandle({ x: hs.x + 10, y: hs.y }, handles, toScreen);
      expect({ z, hit: hit?.spec.id ?? null }).toEqual({ z, hit: 'topRight' });
      expect({ z, miss: miss?.spec.id ?? null }).toEqual({ z, miss: null });
    }
  });

  it('picks the NEAREST handle, not the first', () => {
    reset();
    const toScreen = screenAt(1);
    // Just inside the bottom-right corner: BR is nearer than TR.
    const br = toScreen({ x: 100, y: 100 });
    expect(hitTestEffectHandle({ x: br.x - 2, y: br.y - 2 }, handles, toScreen)?.spec.id)
      .toBe('bottomRight');
  });

  it('breaks an exact tie toward the VERTEX', () => {
    reset();
    const toScreen = screenAt(1);
    // Two handles at the same place: a tangent and a vertex, equidistant.
    const stacked = [
      { spec: { ...handles[0]!.spec, id: 'tan', kind: 'tangent' as const }, pos: { x: 0, y: 0 }, rest: { x: 0, y: 0 } },
      { spec: { ...handles[0]!.spec, id: 'vert', kind: 'vertex' as const }, pos: { x: 0, y: 0 }, rest: { x: 0, y: 0 } },
    ];
    const s = toScreen({ x: 0, y: 0 });
    expect(hitTestEffectHandle(s, stacked, toScreen)?.spec.id).toBe('vert');
    // And the reverse order gives the same answer — otherwise it is list order
    // wearing a tie-break's clothes.
    expect(hitTestEffectHandle(s, [stacked[1]!, stacked[0]!], toScreen)?.spec.id).toBe('vert');
  });

  it('the radius is the documented 9 px, at the boundary', () => {
    reset();
    const toScreen = screenAt(1);
    const s = toScreen({ x: 0, y: 0 });
    expect(hitTestEffectHandle({ x: s.x + HANDLE_PICK_RADIUS, y: s.y }, handles, toScreen)).not.toBeNull();
    expect(hitTestEffectHandle({ x: s.x + HANDLE_PICK_RADIUS + 0.001, y: s.y }, handles, toScreen)).toBeNull();
  });
});

describe('screen position under the layer’s own transform', () => {
  /**
   * THE MAIN RIG, hand-derived.
   *
   *   layer L at (100, 50), rotation 90°, scale (2, 3), 100×100, no parent
   *   W = translate(100,50)·rotate(90)·scale(2,3) = {a:0, b:2, c:-3, d:0, e:100, f:50}
   *   camera zoom 2, centre (0,0)  ⇒  screen = comp · 2
   *
   * Corner Pin's topRight handle:
   *   effect (100, 0) → layer (100−50, 0−50) = (50, −50)
   *   comp.x = 0·50 + (−3)·(−50) + 100 = 150 + 100 = 250
   *   comp.y = 2·50 +   0 ·(−50) +  50 = 100 +  50 = 150
   *   screen = (500, 300)
   */
  it('composes effect → layer → comp → screen', () => {
    defaultSceneGraph.addChild('comp_root', node('L', { x: 100, y: 50, rotation: 90, scaleX: 2, scaleY: 3 }));
    const toScreen = toScreenFor('L', 100, 100, 2);
    expect(at(toScreen, { x: 100, y: 0 })).toEqual([500, 300]);
    // topLeft: effect (0,0) → layer (−50,−50) → comp (0·−50 + −3·−50 + 100, 2·−50 + 50)
    //        = (150 + 100, −100 + 50) = (250, −50) → screen (500, −100)
    expect(at(toScreen, { x: 0, y: 0 })).toEqual([500, -100]);
  });

  /**
   * BOUNDARY — identity everything. Excluded by the main rig, which rotates,
   * scales and zooms. This is the ONLY fixture that isolates the half-box
   * offset: with rotation and scale in play a missing `effectToLayer` still
   * moves things, but here the answer is the offset and nothing else.
   */
  it('BOUNDARY identity: screen is effect space minus half the box', () => {
    defaultSceneGraph.addChild('comp_root', node('I'));
    const toScreen = toScreenFor('I', 100, 100, 1);
    expect(at(toScreen, { x: 0, y: 0 })).toEqual([-50, -50]);
    expect(at(toScreen, { x: 50, y: 50 })).toEqual([0, 0]);
    expect(at(toScreen, { x: 100, y: 100 })).toEqual([50, 50]);
  });

  /**
   * BOUNDARY — 180°, the complementary matrix pattern to 90°'s zero diagonal.
   *   W = translate(0,0)·rotate(180)·scale(2,3) = {a:-2, b:0, c:0, d:-3, e:0, f:0}
   *   effect (100,0) → layer (50,−50) → comp (−2·50, −3·−50) = (−100, 150)
   */
  it('BOUNDARY 180°: the diagonal terms the 90° rig cannot see', () => {
    defaultSceneGraph.addChild('comp_root', node('R', { rotation: 180, scaleX: 2, scaleY: 3 }));
    const toScreen = toScreenFor('R', 100, 100, 1);
    expect(at(toScreen, { x: 100, y: 0 })).toEqual([-100, 150]);
  });

  /**
   * BOUNDARY — uniform scale 1, isolating rotation from the (2,3) cases.
   *   W = rotate(90) ⇒ layer (50,−50) → comp (0·50 + −1·−50, 1·50 + 0) = (50, 50)
   */
  it('BOUNDARY uniform scale: rotation alone', () => {
    defaultSceneGraph.addChild('comp_root', node('U', { rotation: 90 }));
    const toScreen = toScreenFor('U', 100, 100, 1);
    expect(at(toScreen, { x: 100, y: 0 })).toEqual([50, 50]);
  });

  /**
   * BOUNDARY — parented. Every case above is unparented, so an implementation
   * that never walked the chain passes them all.
   *
   *   parent P at (200, 0), rotation 90
   *   child  C at local (0, 0), no rotation, 100×100
   *   W = translate(200,0)·rotate(90) = {a:0, b:1, c:-1, d:0, e:200, f:0}
   *   effect (100,0) → layer (50,−50) → comp (0·50 + −1·−50 + 200, 1·50 + 0) = (250, 50)
   */
  it('BOUNDARY parented: the chain is walked', () => {
    defaultSceneGraph.addChild('comp_root', node('P', { x: 200, y: 0, rotation: 90 }));
    defaultSceneGraph.addChild('P', node('C', { parent: 'P' }));
    const toScreen = toScreenFor('C', 100, 100, 1);
    expect(at(toScreen, { x: 100, y: 0 })).toEqual([250, 50]);
  });
});

describe('what a drag writes', () => {
  it('is the target MINUS the rest position, per axis', () => {
    const [tl, tr] = collectEffectHandles('corner-pin', {}, 200, 100);
    // TL rests at (0,0): dragging it to (30, −12) is offset (30, −12).
    expect(handleDragValues(tl!, { x: 30, y: -12 })).toEqual({ topLeftX: 30, topLeftY: -12 });
    // TR rests at (200,0): dragging it to (180, 25) is offset (−20, 25). An
    // implementation writing the ABSOLUTE target would put 180 here, which
    // looks right for the top-left corner and for nothing else.
    expect(handleDragValues(tr!, { x: 180, y: 25 })).toEqual({ topRightX: -20, topRightY: 25 });
  });

  it('inverts collectEffectHandles exactly', () => {
    const before = collectEffectHandles('bezier-warp', { top1X: 7, top1Y: -3 }, 240, 160);
    const h = before[1]!;
    const target = { x: 111, y: 222 };
    const vals = handleDragValues(h, target);
    const after = collectEffectHandles('bezier-warp', vals, 240, 160);
    expect(after[1]!.pos).toEqual(target);
  });
});
