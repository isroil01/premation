/**
 * Sequence Layers — the cross-dissolve across the overlap.
 *
 * ## Rule 5·0 — the observable, the layer, the medium
 *
 * The observable is OPACITY OVER TIME during the overlap: the outgoing layer
 * falls to nothing exactly as the incoming one arrives. It is produced by
 * keyframes on `opacity`, sampled on the axis `compToKeyframeTime` defines — so
 * the medium is `defaultAnimation.sample(...)`, the same call the renderer
 * makes. Asserting the stored keyframe objects instead would guard the write and
 * not the read, and the axis is precisely where this feature can go wrong (the
 * naive `toLayerTime` next door carries a docstring forbidding its use here).
 *
 * ## What already existed
 *
 * `sequenceLayerBars(ids, overlapSeconds)` has done the overlap since it was
 * written, with a passing test. Only the UI hardcoded 0, so the overlap shipped
 * unreachable. The crossfade is the new part.
 *
 * ## Rule 2b — a symmetric ramp cannot show a swap
 *
 * 100 → 0 and 0 → 100 are mirror images, so "opacity changed across the
 * overlap" holds just as well with the two layers exchanged. Every assertion
 * below is therefore anchored to WHICH LAYER IS EARLIER IN THE SEQUENCE — a
 * fact this file fixes when it picks the selection order — rather than to
 * whichever ramp the implementation happened to write.
 *
 * ## What the clean fixture would exclude (rule 3a)
 *
 * Equal durations. With three 2-second layers the overlap regions are all the
 * same length and sit at regular spacing, so a fade written against the wrong
 * pair, or spanning the whole bar instead of the overlap, still lands on
 * plausible numbers. Durations here are 2 / 3 / 1 — distinct, and distinct from
 * the overlap.
 */

import { getTimelineController, compToKeyframeTime } from './TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { defaultAnimation } from '@motion/animation';
import { updateNodeLayerTime } from '@core/scene/layerTime';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';

/** Deliberately unequal, and none equal to the overlap. */
const DURATIONS: Record<string, number> = { a: 2, b: 3, c: 1 };
const OVERLAP = 0.5;

function node(id: string, parent: string | null = 'comp_root'): SceneNode {
  return {
    id, name: id, parent, children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true, locked: false,
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
}

function seed(ids: string[]): void {
  const existing: string[] = [];
  defaultSceneGraph.traverse((n) => existing.push(n.id));
  for (const id of existing) defaultSceneGraph.removeNode(id);
  const root = node('comp_root', null);
  root.children = [...ids];
  defaultSceneGraph.addNode(root);
  for (const id of ids) defaultSceneGraph.addNode(node(id));
  getTimelineController().syncFromScene('comp_root');
  const ctrl = getTimelineController();
  for (const id of ids) {
    const L = ctrl.getLayersForNode(id)[0];
    if (L) ctrl.trimClipTo(L.id, 'end', DURATIONS[id] ?? 2);
  }
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.clear();
});

const fps = (): number => getTimelineController().timeline.getFrameRate().fps;

/**
 * Opacity as the RENDERER would sample it, from a comp time in seconds.
 *
 * The `compToKeyframeTime` hop is not decoration. Every writer in the codebase
 * converts before `setKeyframe`, and `buildSnapshot` samples with an
 * already-converted time — so a test that sampled raw comp seconds would be
 * reading a different axis from the one that draws.
 *
 * The first version of this helper omitted it, and the failure was diagnostic:
 * the assertions passed for `a` and failed for `b`. `a` is the anchor and never
 * moves, so its two axes coincide; `b`'s bar is displaced by the sequencing, so
 * they do not. Passing only for the unmoved layer is the signature of an axis
 * error, and it was the harness's, not the implementation's.
 */
const opacityAt = (id: string, compSeconds: number): number =>
  defaultAnimation.sample(id, 'opacity', compToKeyframeTime(id, compSeconds)) as number;
const barOf = (id: string) => getTimelineController().getLayersForNode(id)[0]!;

describe('crossfade is opt-in', () => {
  it('writes NO opacity track when it is not asked for', () => {
    // Backwards compatibility: the existing menu path sequenced without fading,
    // and three shipped tests assert that geometry. Fading by default would
    // change every one of them.
    seed(['a', 'b']);
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP);
    expect(defaultAnimation.isAnimated('a', 'opacity')).toBe(false);
    expect(defaultAnimation.isAnimated('b', 'opacity')).toBe(false);
  });

  it('writes nothing at overlap 0 — there is no region to ramp across', () => {
    // A zero-length ramp would be two keyframes at the same time, which is a
    // discontinuity rather than a fade.
    seed(['a', 'b']);
    getTimelineController().sequenceLayerBars(['a', 'b'], 0, { crossfade: true });
    expect(defaultAnimation.isAnimated('a', 'opacity')).toBe(false);
    expect(defaultAnimation.isAnimated('b', 'opacity')).toBe(false);
  });

  it('POSITIVE CONTROL: it DOES write when asked, so the two above are not vacuous', () => {
    seed(['a', 'b']);
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP, { crossfade: true });
    expect(defaultAnimation.isAnimated('a', 'opacity')).toBe(true);
    expect(defaultAnimation.isAnimated('b', 'opacity')).toBe(true);
  });
});

describe('the ramp runs the right way, anchored to sequence order', () => {
  /** The overlap region in comp seconds, derived from the bars after sequencing. */
  function overlapRegion(earlier: string, later: string): { start: number; end: number } {
    const e = barOf(earlier);
    const l = barOf(later);
    return { start: l.start / fps(), end: (e.start + e.duration) / fps() };
  }

  it('the OUTGOING layer falls from full to nothing across the overlap', () => {
    seed(['a', 'b']);
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP, { crossfade: true });
    const { start, end } = overlapRegion('a', 'b');
    // Anchored to "a is first in the selection", not to what was written.
    expect(opacityAt('a', start)).toBeCloseTo(100, 3);
    expect(opacityAt('a', end)).toBeCloseTo(0, 3);
  });

  it('the INCOMING layer rises from nothing to full across the same span', () => {
    seed(['a', 'b']);
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP, { crossfade: true });
    const { start, end } = overlapRegion('a', 'b');
    expect(opacityAt('b', start)).toBeCloseTo(0, 3);
    expect(opacityAt('b', end)).toBeCloseTo(100, 3);
  });

  it('they are COMPLEMENTARY mid-overlap — a dissolve, not two independent fades', () => {
    // The property that makes it a cross-dissolve. Checked at a point neither
    // keyframe sits on, so it exercises interpolation rather than the endpoints.
    seed(['a', 'b']);
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP, { crossfade: true });
    const { start, end } = overlapRegion('a', 'b');
    const mid = (start + end) / 2;
    expect(opacityAt('a', mid) + opacityAt('b', mid)).toBeCloseTo(100, 0);
  });

  it('POSITIVE CONTROL: the two layers differ mid-overlap under a SWAP', () => {
    // Proves the directional assertions above can see a swap at all. If the
    // ramps were identical, exchanging them would be undetectable and every
    // direction check here would be decoration.
    seed(['a', 'b']);
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP, { crossfade: true });
    const { start } = overlapRegion('a', 'b');
    const justAfter = start + 0.1;
    expect(opacityAt('a', justAfter)).toBeGreaterThan(opacityAt('b', justAfter));
  });
});

describe('only the overlap is touched', () => {
  it('the ramp spans the overlap, not the whole bar', () => {
    // The failure an equal-duration fixture would hide: a fade written across
    // the layer instead of across the overlap.
    seed(['a', 'b']);
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP, { crossfade: true });
    const a = barOf('a');
    const { start } = overlapRegion('a', 'b');
    // Well before the overlap begins, `a` is still fully opaque.
    const beforeOverlap = (a.start / fps() + start) / 2;
    expect(opacityAt('a', beforeOverlap)).toBeCloseTo(100, 3);
  });

  function overlapRegion(earlier: string, later: string): { start: number; end: number } {
    const e = barOf(earlier);
    const l = barOf(later);
    return { start: l.start / fps(), end: (e.start + e.duration) / fps() };
  }

  it('the FIRST layer never fades in and the LAST never fades out', () => {
    // A sequence that opened from and ended in transparency is a different edit
    // from the one asked for.
    seed(['a', 'b', 'c']);
    getTimelineController().sequenceLayerBars(['a', 'b', 'c'], OVERLAP, { crossfade: true });
    const a = barOf('a');
    const c = barOf('c');
    expect(opacityAt('a', a.start / fps())).toBeCloseTo(100, 3);
    expect(opacityAt('c', (c.start + c.duration) / fps())).toBeCloseTo(100, 3);
  });

  it('every interior boundary gets its own dissolve', () => {
    // Derived from the chain rather than checking one hardcoded pair, so a
    // three-layer sequence cannot pass by fading only the first boundary.
    const ids = ['a', 'b', 'c'];
    seed(ids);
    getTimelineController().sequenceLayerBars(ids, OVERLAP, { crossfade: true });
    for (let i = 1; i < ids.length; i++) {
      const earlier = ids[i - 1]!;
      const later = ids[i]!;
      const { start, end } = overlapRegion(earlier, later);
      expect({ pair: `${earlier}->${later}`, out: Math.round(opacityAt(earlier, end)) })
        .toEqual({ pair: `${earlier}->${later}`, out: 0 });
      expect({ pair: `${earlier}->${later}`, in: Math.round(opacityAt(later, start)) })
        .toEqual({ pair: `${earlier}->${later}`, in: 0 });
    }
  });
});

/**
 * F30 — which guard observes the AXIS the keyframes are written on?
 *
 * For a plain layer, `compToKeyframeTime` and the forbidden `toLayerTime` return
 * the SAME number, so nothing above can tell them apart. Measured, not assumed:
 * swapping the implementation to `toLayerTime` left all eleven green.
 *
 * They diverge only under the things `toLayerTime`'s docstring says it ignores —
 * `sourceIn`, the active clip, stretch/reverse/freeze, precomp remaps. Time
 * STRETCH is the cheapest of those to seed, so the axis becomes observable here
 * and nowhere else in this file.
 */
describe('the keyframe axis, on a layer where the two axes differ', () => {
  it('POSITIVE CONTROL: stretch really does separate the two axes', () => {
    // Without this, the assertion below could pass because both axes agree —
    // exactly the hole this describe exists to close.
    seed(['a', 'b']);
    updateNodeLayerTime('b', { stretch: 200 });
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP, { crossfade: true });
    const probe = barOf('b').start / fps() + 0.25;
    expect(compToKeyframeTime('b', probe)).not.toBeCloseTo(
      getTimelineController().toLayerTime('b', probe), 4);
  });

  it('the incoming layer still reaches full opacity at the end of the overlap', () => {
    seed(['a', 'b']);
    updateNodeLayerTime('b', { stretch: 200 });
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP, { crossfade: true });
    const end = (barOf('a').start + barOf('a').duration) / fps();
    expect(opacityAt('b', end)).toBeCloseTo(100, 2);
  });

  it('and it is still transparent where the overlap begins', () => {
    seed(['a', 'b']);
    updateNodeLayerTime('b', { stretch: 200 });
    getTimelineController().sequenceLayerBars(['a', 'b'], OVERLAP, { crossfade: true });
    expect(opacityAt('b', barOf('b').start / fps())).toBeCloseTo(0, 2);
  });
});

describe('undo', () => {
  it('the whole crossfade is ONE history entry, not one per keyframe', () => {
    // A four-ramp dissolve is twelve setKeyframe calls; without bundling, undo
    // takes twelve presses.
    seed(['a', 'b', 'c']);
    const before = getCommandSystem().getHistory().getEntries().length;
    getTimelineController().sequenceLayerBars(['a', 'b', 'c'], OVERLAP, { crossfade: true });
    const added = getCommandSystem().getHistory().getEntries()
      .slice(before)
      .filter((e) => /crossfade/i.test(e.label));
    expect(added).toHaveLength(1);
  });
});
