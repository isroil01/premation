/**
 * Convert Expression to Keyframes.
 *
 * ── THE OBSERVABLE, AND THE MEDIUM THAT SAMPLES IT (rule 5·0) ───────────────
 *
 * The claim is "the picture does not change": for every comp frame in the
 * range, the property's value after the bake equals its value before. The layer
 * that produces that value is `AnimationEngine.sample` on the axis
 * `compToKeyframeTime` defines, so a test that samples the engine at comp
 * frames — mapped through the same axis the renderer uses — sees exactly the
 * observable. It does NOT see whether a menu entry calls the command; that is
 * checked in `convertExpressionMenu.test.ts` and in the running app.
 *
 * ── RULE 3a: WHAT EACH OBVIOUS FIXTURE EXCLUDES ─────────────────────────────
 *
 * | Fixture | What it cannot fail on |
 * |---|---|
 * | a CONSTANT expression | every keyframe is identical, so a bake that sampled ONCE and copied passes |
 * | a LINEAR expression | the samples lie on a straight line, so a bake that wrote only the endpoints passes — linear interpolation fills the rest correctly |
 * | `wiggle()` | nothing: it pins per-sample seeding, and is the only one of the three that does |
 * | a clip starting at 0 | both time axes are the identity, so writing on the wrong one passes |
 * | an expression that ignores `value` | write-as-you-go cannot compound, so the ordering bug passes |
 *
 * All five are here, and the last two are the ones with real defects behind
 * them: `getRemappedTime` is the only axis the renderer samples, and an
 * expression that reads its own property makes the plan/write order decisive.
 */

import { defaultAnimation } from '@motion/animation';
import {
  bakeRangeFor,
  planExpressionBake,
  eligibleExpressionProps,
  convertExpressionToKeyframes,
} from './convertExpressionToKeyframes';
import { getTimelineController, getRemappedTime } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';

const NODE = 'bake-node';
const FPS = 30;

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

function addNode(id = NODE): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100 } },
    ],
  } as unknown as SceneNode);
}

/**
 * Give the node a clip bar starting at `startFrames` and lasting `lenFrames`.
 *
 * It MUST go on the controller's COMPOSITION track — its timeline's first, the
 * one `initTimeline` creates — because `getLayersForNode` consults only that
 * one. A clip parked anywhere else is invisible to it, both time axes collapse
 * to the identity, and a test that believes it has an offset layer proves
 * nothing. (The private `compositionTrackId` cast some older suites used went
 * stale when the controller grew a per-comp map; it now returns undefined.)
 */
function addClip(startFrames: number, lenFrames: number, id = NODE): void {
  const c = getTimelineController();
  const trackId = c.timeline.getTracks()[0]!.id;
  c.timeline.addLayer(String(trackId), {
    name: id, sourceId: id, clip: { start: startFrames, duration: lenFrames },
  });
  c.invalidateLayerIndex();
}

function clearClips(): void {
  const c = getTimelineController();
  for (const track of c.timeline.getTracks()) {
    for (const layer of [...track.layers]) c.timeline.removeLayer(layer.id);
  }
  c.clearWorkArea();
  c.invalidateLayerIndex();
}

beforeEach(() => {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
  getCommandSystem().getHistory().clear();
  clearClips();
});

/**
 * Sample every comp frame in `range` — the observable the bake must preserve.
 * HALF-OPEN, matching `BakeRange`: the bar's `end` frame is not one the layer
 * occupies, so asserting about it would be asserting about a frame that renders
 * nothing.
 */
function valuesAtCompFrames(nodeId: string, prop: string, range: { start: number; end: number }): number[] {
  const out: number[] = [];
  const n = Math.round((range.end - range.start) * FPS);
  for (let i = 0; i < n; i++) {
    const compT = range.start + i / FPS;
    out.push(defaultAnimation.sample(nodeId, prop, getRemappedTime(nodeId, compT)) ?? NaN);
  }
  return out;
}

describe('the range is the LAYER EXTENT, not the work area', () => {
  test('a clip from 1s to 3s bakes 1s..3s', () => {
    addNode();
    addClip(FPS, FPS * 2);
    const r = bakeRangeFor(NODE);
    expect(r.start).toBeCloseTo(1);
    expect(r.end).toBeCloseTo(3);
  });

  test('a work area does NOT narrow it — a preview scope is not an authoring scope', () => {
    addNode();
    addClip(0, FPS * 4);
    getTimelineController().setWorkArea(1, 2);
    expect(getTimelineController().getWorkArea()).not.toBeNull();
    const r = bakeRangeFor(NODE);
    expect(r.start).toBeCloseTo(0);
    expect(r.end).toBeCloseTo(4);
  });

  /**
   * A SPLIT layer is one node with several bars. Taking the first bar only
   * would leave everything after the cut to the clamped endpoint — the exact
   * silent tail-change the extent choice exists to avoid.
   */
  test('a split layer bakes the UNION of its bars, not the first', () => {
    addNode();
    addClip(0, FPS);
    addClip(FPS * 3, FPS);
    const r = bakeRangeFor(NODE);
    expect(r.start).toBeCloseTo(0);
    expect(r.end).toBeCloseTo(4);
  });

  test('a node with NO clip falls back to the composition duration', () => {
    addNode();
    const r = bakeRangeFor(NODE);
    expect(r.start).toBe(0);
    expect(r.end).toBeGreaterThan(0);
  });
});

describe('the bake preserves the picture', () => {
  /**
   * CONSTANT — the weakest of the three, kept as the arithmetic anyone can
   * recheck rather than as evidence about sampling. `value * 0 + 42` is 42
   * everywhere, so this passes on a bake that samples once and copies.
   */
  test('a constant expression bakes to 42 at every frame', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'value * 0 + 42');

    // 30 frames, not 31: the range is half-open, so frame 30 (= 1.0s) belongs
    // to whatever comes next, not to a one-second bar.
    const kfs = planExpressionBake(NODE, 'x', { start: 0, end: 1 }, FPS);
    expect(kfs).toHaveLength(30);
    expect(kfs.every((k) => k.value === 42)).toBe(true);
  });

  /**
   * LINEAR — `time * 90` at 30fps. Hand-derived: frame i is at t = i/30, so the
   * value is 3·i. Frame 15 is 45 and the last frame, 29, is 87. Excludes
   * curvature, so it passes on an endpoints-only bake.
   */
  test('a linear expression bakes to hand-derived values', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');

    const kfs = planExpressionBake(NODE, 'x', { start: 0, end: 1 }, FPS);
    expect(kfs[0]!.value).toBeCloseTo(0);
    expect(kfs[15]!.value).toBeCloseTo(45);
    expect(kfs[29]!.value).toBeCloseTo(87);
  });

  /**
   * WIGGLE — the one that pins seeding, and the reason the other two are not
   * enough. `wiggle` is deterministic per (node, prop, time) via `propSeed`; if
   * the bake sampled at even slightly different times, or re-seeded, the baked
   * values would be a DIFFERENT wiggle that looks equally like a wiggle.
   *
   * Asserted as a universal against the live expression rather than at a
   * hand-picked point, because the claim is universal and there is no single
   * interesting sample to derive.
   */
  test('wiggle bakes to the LIVE value at every keyframe time', () => {
    addNode();
    addClip(0, FPS * 2);
    defaultAnimation.setExpression(NODE, 'x', 'wiggle(3, 50)');

    const range = bakeRangeFor(NODE);
    const kfs = planExpressionBake(NODE, 'x', range, FPS);
    expect(kfs.length).toBeGreaterThan(30);
    for (const k of kfs) {
      expect(k.value).toBeCloseTo(defaultAnimation.sample(NODE, 'x', k.t)!, 10);
    }
    // …and it is genuinely varying, so the loop above is not comparing a
    // constant to itself.
    expect(new Set(kfs.map((k) => k.value)).size).toBeGreaterThan(10);
  });

  test('end to end: every comp frame reads the same value after the bake', () => {
    addNode();
    addClip(0, FPS * 2);
    defaultAnimation.setExpression(NODE, 'x', 'wiggle(3, 50)');

    const range = bakeRangeFor(NODE);
    const before = valuesAtCompFrames(NODE, 'x', range);
    convertExpressionToKeyframes(NODE);
    const after = valuesAtCompFrames(NODE, 'x', range);

    expect(after).toHaveLength(before.length);
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 10));
  });
});

describe('boundaries — what the clean fixtures exclude', () => {
  /**
   * An expression that reads its OWN property. `value` is the keyframed base,
   * so writing keyframes as the walk proceeds changes the input to every later
   * sample: frame 0 bakes 200, and a later frame then reads a base of 200 and
   * bakes 400. The output compounds smoothly and looks like motion.
   *
   * Every other fixture here ignores `value`, so none of them can fail on it.
   */
  test('an expression reading `value` does not COMPOUND — plan is pure', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'value + 200');

    const kfs = planExpressionBake(NODE, 'x', { start: 0, end: 1 }, FPS);
    // base is 0 (no keyframes), so every frame is 200 — never 400, 600, …
    expect(kfs.every((k) => k.value === 200)).toBe(true);
    // The plan wrote nothing on its way: the engine still has no track.
    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(false);
  });

  test('…and the same holds through the command, which does write', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'value + 200');

    convertExpressionToKeyframes(NODE);
    const kfs = defaultAnimation.getTrackKeyframes(NODE, 'x')!;
    expect(kfs.every((k) => k.value === 200)).toBe(true);
  });

  /**
   * A clip that does NOT start at 0. With a clip at 0 the comp and keyframe
   * axes are the identity, so a bake writing on the wrong axis passes. Offset
   * by 1s they differ by 1s, and the stored times have to be the layer's.
   */
  test('an OFFSET clip stores keyframes on the layer axis', () => {
    addNode();
    addClip(FPS, FPS * 2); // 1s .. 3s

    // Prove the axes really differ, or this fixture proves nothing.
    expect(getRemappedTime(NODE, 1)).toBeCloseTo(0);
    expect(getRemappedTime(NODE, 2)).toBeCloseTo(1);

    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    convertExpressionToKeyframes(NODE);

    const kfs = defaultAnimation.getTrackKeyframes(NODE, 'x')!;
    // Comp [1s, 3s) → layer [0, 2s). Stored on the layer axis, so the first t
    // is 0 and the last is the frame BEFORE 2s — 59/30, not 2. Baking comp 3.0
    // would put a keyframe at layer 3.0, a whole clip offset out of place,
    // because no bar is active there for the axis to subtract.
    expect(kfs[0]!.t).toBeCloseTo(0);
    expect(kfs).toHaveLength(60);
    expect(kfs[kfs.length - 1]!.t).toBeCloseTo(59 / 30);
    // And the VALUE at layer 0 is the expression at layer time 0 — `time` in an
    // expression is the property's own axis, so it is 0, not 90.
    expect(kfs[0]!.value).toBeCloseTo(0);
  });

  test('the picture is preserved on an OFFSET clip too', () => {
    addNode();
    addClip(FPS, FPS * 2);
    defaultAnimation.setExpression(NODE, 'x', 'wiggle(3, 50)');

    const range = bakeRangeFor(NODE);
    const before = valuesAtCompFrames(NODE, 'x', range);
    convertExpressionToKeyframes(NODE);
    const after = valuesAtCompFrames(NODE, 'x', range);
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 10));
  });
});

describe('the expression is disabled, not deleted', () => {
  test('after the bake: source retained, bit off, keyframes driving', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    convertExpressionToKeyframes(NODE);

    expect(defaultAnimation.hasExpression(NODE, 'x')).toBe(true);
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('time * 90');
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(false);
    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(true);
  });

  /**
   * Re-enabling after a bake puts the expression back on top of the keyframes
   * it produced. For an expression that ignores `value` that is the original
   * motion again — which is the promise "disable, do not delete" is making.
   */
  test('re-enabling restores the expression over the baked track', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    convertExpressionToKeyframes(NODE);
    defaultAnimation.setExpressionEnabled(NODE, 'x', true);
    expect(defaultAnimation.sample(NODE, 'x', 0.5)).toBeCloseTo(45);
  });
});

describe('one undo step', () => {
  test('undo restores no-track AND re-enables, together', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');

    convertExpressionToKeyframes(NODE);
    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(true);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(false);

    const history = getCommandSystem().getHistory();
    history.undo();

    // BOTH halves, from ONE undo. Two commands would leave a state with baked
    // keyframes under a live expression, which renders as the expression alone
    // and reads as the bake having done nothing.
    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(false);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(true);
    expect(defaultAnimation.sample(NODE, 'x', 0.5)).toBeCloseTo(45);
  });

  test('baking TWO props is still one undo step', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    defaultAnimation.setExpression(NODE, 'y', 'time * 45');

    const res = convertExpressionToKeyframes(NODE);
    expect([...res.written.keys()].sort()).toEqual(['x', 'y']);

    getCommandSystem().getHistory().undo();
    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(false);
    expect(defaultAnimation.isAnimated(NODE, 'y')).toBe(false);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(true);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'y')).toBe(true);
  });
});

describe('eligibility — one predicate, two callers', () => {
  test('a property with an enabled expression is eligible', () => {
    addNode();
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    expect(eligibleExpressionProps(NODE)).toEqual(['x']);
  });

  test('a DISABLED expression is not eligible, and the refusal says why', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    defaultAnimation.setExpressionEnabled(NODE, 'x', false);

    expect(eligibleExpressionProps(NODE)).toEqual([]);
    const res = convertExpressionToKeyframes(NODE);
    expect(res.refusal).toBe('expression-disabled');
    expect(res.written.size).toBe(0);
    // Nothing was written, so the property is untouched.
    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(false);
  });

  test('a keyframed property with no expression is not eligible', () => {
    addNode();
    defaultAnimation.setKeyframe(NODE, 'x', 0, 10);
    expect(eligibleExpressionProps(NODE)).toEqual([]);
    expect(convertExpressionToKeyframes(NODE).refusal).toBe('no-expression');
  });

  test('a layer with nothing on it refuses with no-expression', () => {
    addNode();
    expect(convertExpressionToKeyframes(NODE).refusal).toBe('no-expression');
  });

  test('an explicitly named prop with a disabled expression refuses too', () => {
    addNode();
    addClip(0, FPS);
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    defaultAnimation.setExpressionEnabled(NODE, 'x', false);
    expect(convertExpressionToKeyframes(NODE, ['x']).refusal).toBe('expression-disabled');
  });
});
