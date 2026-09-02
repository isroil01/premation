/**
 * Per-cut transitions — the record, the four kinds, and getting back out.
 *
 * ## Rule 5·0 — the observable, the layer, the medium
 *
 * The observable is WHAT THE RENDERER SEES ACROSS THE CUT, so opacity is read
 * through `defaultAnimation.sample` on `compToKeyframeTime`'s axis — the call
 * `buildSnapshot` makes — and never off the stored keyframe objects. That
 * distinction is not pedantry here: the axis moves when the bars move, and the
 * overlapping kinds move the bars, so a test that read raw comp seconds would
 * be checking a different timeline from the one that draws. (The neighbouring
 * `sequenceCrossfade.test.ts` records the day that exact harness bug passed for
 * the unmoved layer and failed for the displaced one.)
 *
 * The two effect-driven kinds have no opacity to sample, so their observable is
 * the effect's animated parameter — read the same way, through `sample`.
 *
 * ## Rule 2b — a symmetric ramp cannot show a swap
 *
 * 100 → 0 and 0 → 100 are mirror images, so "opacity changed across the cut"
 * holds just as well with the two layers exchanged. Every assertion is anchored
 * to WHICH NODE IS THE OUTGOING ONE — a fact the fixture fixes by construction
 * ('a' ends at the cut, 'b' begins there) — rather than to whichever ramp the
 * implementation happened to write.
 *
 * ## Rule 3a — what the clean fixture would exclude
 *
 * Equal durations, a symmetric duration, and unbounded sources. The bars are 30
 * and 40 frames, the transitions are 8 frames (so the centred split is 4/4 and
 * an odd one is visibly not), and both clips carry an explicit
 * `sourceDuration` — because the interesting half of this feature is the bound:
 * a shape layer has infinite handles and would pass the refusal test by never
 * being able to fail it.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { getNodeEffects } from '@core/effects/effects';
import type { SceneNode } from '@core/types';
import { getTimelineController, compToKeyframeTime } from './TimelineController';
import {
  materializeTransition,
  dematerializeTransition,
  checkTransition,
  transitionRegion,
  transitionOverlaps,
  transitionEffectId,
  addTransition,
  setTransition,
  removeTransition,
  useTransitionStore,
  type TransitionRecord,
  type TransitionKind,
} from './transitions';

const ROOT = 'comp_root';

function layer(id: string): void {
  defaultSceneGraph.addChild(ROOT, {
    id,
    name: id,
    parent: ROOT,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, width: 50, height: 50 } },
    ],
  } as unknown as SceneNode);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.clear();
  useTransitionStore.getState().clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: ROOT,
    name: 'Composition 1',
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  layer('a');
  layer('b');
  const controller = getTimelineController();
  controller.reset();
  controller.syncFromScene(ROOT);
});

const barOf = (nodeId: string) => getTimelineController().getLayersForNode(nodeId)[0]!;
const fps = (): number => getTimelineController().timeline.getFrameRate().fps;

/**
 * Butt `b` against `a` at frame 30, with explicit handles on both sides.
 *
 * `leftTail` is how much source lies after a's out-point and `rightHead` how
 * much lies before b's in-point — the two quantities a transition spends. Both
 * are stated, never defaulted, because every interesting case here is about one
 * of them running out.
 */
const CUT = 30;
function butt(opts: { leftTail?: number; rightHead?: number } = {}): void {
  const leftTail = opts.leftTail ?? 60;
  const rightHead = opts.rightHead ?? 60;
  const a = barOf('a');
  const b = barOf('b');
  a.clip.start = 0;
  a.clip.duration = CUT;
  a.clip.sourceIn = 5;
  a.clip.sourceDuration = a.clip.sourceIn + a.clip.duration + leftTail;
  b.clip.start = CUT;
  b.clip.duration = 40;
  b.clip.sourceIn = rightHead;
  b.clip.sourceDuration = rightHead + b.clip.duration + 60;
  getTimelineController().invalidateLayerIndex();
}

function record(kind: TransitionKind, over: Partial<TransitionRecord> = {}): TransitionRecord {
  return {
    id: `t_${kind}`,
    leftNodeId: 'a',
    rightNodeId: 'b',
    kind,
    durationFrames: 8,
    alignment: 'centred',
    ...over,
  };
}

/** Opacity as the renderer would sample it, from a comp time in FRAMES. */
const opacityAtFrame = (id: string, frame: number): number =>
  defaultAnimation.sample(id, 'opacity', compToKeyframeTime(id, frame / fps())) as number;

/** An animated effect parameter, sampled on the same axis. */
const paramAtFrame = (id: string, path: string, frame: number): number =>
  defaultAnimation.sample(id, path, compToKeyframeTime(id, frame / fps())) as number;

// ── The region, before anything is applied ──────────────────────────

describe('transitionRegion — the one conversion all four kinds share', () => {
  it('splits a centred transition either side of the cut', () => {
    // 8 is even, so the halves are equal; the odd case below is what proves the
    // arithmetic is a split and not a hardcoded halving.
    expect(transitionRegion(8, 'centred')).toEqual({ before: 4, after: 4 });
  });

  it('gives the extra frame of an ODD duration to the side after the cut', () => {
    // Stated so a later "tidy-up" that flips it fails here rather than silently
    // moving every centred transition by one frame.
    expect(transitionRegion(9, 'centred')).toEqual({ before: 4, after: 5 });
  });

  it('puts the whole thing after the cut for startAtCut, and before it for endAtCut', () => {
    expect(transitionRegion(8, 'startAtCut')).toEqual({ before: 0, after: 8 });
    expect(transitionRegion(8, 'endAtCut')).toEqual({ before: 8, after: 0 });
  });

  it('never produces a zero-length transition', () => {
    // A zero-length transition is a cut, and the way to make one is to delete
    // the record — not to shrink it until it stops meaning anything.
    expect(transitionRegion(0, 'centred').before + transitionRegion(0, 'centred').after).toBe(1);
  });
});

// ── Cross dissolve ──────────────────────────────────────────────────

describe('cross dissolve', () => {
  it('overlaps the two bars by exactly the transition length', () => {
    butt();
    expect(materializeTransition(record('crossDissolve')).ok).toBe(true);
    // 4 either side: a's out moves to 34, b's in back to 26.
    expect(barOf('a').end).toBe(CUT + 4);
    expect(barOf('b').start).toBe(CUT - 4);
    expect(barOf('a').end - barOf('b').start).toBe(8);
  });

  it('buys the overlap from the SOURCE HANDLES, not by stretching the media', () => {
    butt();
    materializeTransition(record('crossDissolve'));
    // a keeps its head and eats 4 frames of tail; b keeps its out and gives up
    // 4 frames of head. Anything else would be showing footage twice.
    expect(barOf('a').clip.sourceIn).toBe(5);
    expect(barOf('a').clip.sourceOut).toBe(5 + CUT + 4);
    expect(barOf('b').clip.sourceIn).toBe(60 - 4);
    expect(barOf('b').clip.sourceOut).toBe(60 + 40);
  });

  /*
   * Sampled only at frames the two bars actually OCCUPY.
   *
   * The overlap runs [26, 34): frame 34 is the outgoing bar's exclusive end, a
   * frame it does not draw, and asking `compToKeyframeTime` for it finds no
   * governing clip and falls through to identity — a different axis entirely.
   * A test that sampled there would be asserting against a mapping the renderer
   * never uses (and would, as it happens, have passed while the write was on
   * the wrong axis — see `kfTime`'s note).
   */
  const FIRST = CUT - 4; // 26 — first frame of the overlap
  const LAST = CUT + 3; // 33 — last frame either bar draws inside it

  it('the OUTGOING layer falls from full towards nothing across the overlap', () => {
    butt();
    materializeTransition(record('crossDissolve'));
    expect(opacityAtFrame('a', FIRST)).toBeCloseTo(100, 3);
    expect(opacityAtFrame('a', CUT)).toBeLessThan(60);
    // The last frame it draws is nearly gone; it reaches exactly 0 on the frame
    // after, which is the frame it ceases to exist.
    expect(opacityAtFrame('a', LAST)).toBeLessThan(20);
  });

  it('the INCOMING layer rises from nothing to full across the same span', () => {
    butt();
    materializeTransition(record('crossDissolve'));
    expect(opacityAtFrame('b', FIRST)).toBeCloseTo(0, 3);
    expect(opacityAtFrame('b', CUT)).toBeGreaterThan(40);
    expect(opacityAtFrame('b', LAST)).toBeGreaterThan(80);
  });

  it('the two ramps SUM to full at every frame of the overlap', () => {
    /*
     * This is the actual observable — and the one assertion rule 2b's warning
     * cannot be satisfied by an implementation with the two layers exchanged,
     * by a ramp written over the wrong span, or by one written on the wrong
     * axis. A dissolve that does not sum to full flashes the background through
     * the middle of the cut, which is the classic broken crossfade.
     */
    butt();
    materializeTransition(record('crossDissolve'));
    for (const f of [FIRST, 28, CUT, 32, LAST]) {
      expect(opacityAtFrame('a', f) + opacityAtFrame('b', f)).toBeCloseTo(100, 3);
    }
  });

  it('the ramps run the right way round, anchored to which node ENDS at the cut', () => {
    // Without this the sum test above holds just as well with the two layers
    // exchanged: 100 → 0 and 0 → 100 are mirror images.
    butt();
    materializeTransition(record('crossDissolve'));
    expect(opacityAtFrame('a', FIRST)).toBeGreaterThan(opacityAtFrame('a', LAST));
    expect(opacityAtFrame('b', FIRST)).toBeLessThan(opacityAtFrame('b', LAST));
  });
});

// ── Insufficient handles ────────────────────────────────────────────

describe('it refuses when the handles cannot pay for the overlap', () => {
  it('refuses on the OUTGOING side and says which side and by how much', () => {
    // 1 frame of tail against a centred 8-frame dissolve, which needs 4.
    butt({ leftTail: 1 });
    const verdict = checkTransition(record('crossDissolve'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toContain('outgoing');
    // The numbers are the whole value of the message: "not enough handle" with
    // no quantities leaves the user guessing how much shorter to make it.
    expect(verdict.reason).toContain('1 frame');
    expect(verdict.reason).toContain('4 frames');
  });

  it('refuses on the INCOMING side too', () => {
    butt({ rightHead: 2 });
    const verdict = checkTransition(record('crossDissolve'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toContain('incoming');
  });

  it('a refusal CHANGES NOTHING — no partial overlap, no stray keyframes', () => {
    // The failure this guards against is the worst one available: a transition
    // that reports an error and has already moved one of the two bars.
    butt({ leftTail: 1 });
    const before = { aEnd: barOf('a').end, bStart: barOf('b').start };
    const res = materializeTransition(record('crossDissolve'));
    expect(res.ok).toBe(false);
    expect(barOf('a').end).toBe(before.aEnd);
    expect(barOf('b').start).toBe(before.bStart);
    expect(defaultAnimation.isAnimated('a', 'opacity')).toBe(false);
    expect(defaultAnimation.isAnimated('b', 'opacity')).toBe(false);
  });

  it('POSITIVE CONTROL: the same cut with room accepts, so the refusals are not vacuous', () => {
    butt({ leftTail: 4, rightHead: 4 });
    expect(checkTransition(record('crossDissolve')).ok).toBe(true);
  });

  it('an alignment that spends nothing on the starved side is allowed', () => {
    // endAtCut takes all 8 frames from the INCOMING clip's head and none from
    // the outgoing clip's tail — so a clip with no tail can still dissolve.
    // This is the concrete advice the refusal message gives, tested.
    butt({ leftTail: 0, rightHead: 20 });
    expect(checkTransition(record('crossDissolve')).ok).toBe(false);
    expect(checkTransition(record('crossDissolve', { alignment: 'endAtCut' })).ok).toBe(true);
  });

  it('a DIP needs no handles at all, because it does not overlap', () => {
    butt({ leftTail: 0, rightHead: 0 });
    expect(transitionOverlaps('dipToBlack')).toBe(false);
    expect(checkTransition(record('dipToBlack')).ok).toBe(true);
  });
});

// ── Dips ────────────────────────────────────────────────────────────

describe('dip to black', () => {
  it('leaves the bars exactly where they were — a dip is not an overlap', () => {
    butt();
    materializeTransition(record('dipToBlack'));
    expect(barOf('a').end).toBe(CUT);
    expect(barOf('b').start).toBe(CUT);
  });

  it('the outgoing layer falls away into the cut and the incoming rises out of it', () => {
    // Frame 29 is the last one the outgoing bar draws (its end, 30, is
    // exclusive); the ramp reaches exactly 0 on the cut itself.
    butt();
    materializeTransition(record('dipToBlack'));
    expect(opacityAtFrame('a', CUT - 4)).toBeCloseTo(100, 3);
    expect(opacityAtFrame('a', CUT - 1)).toBeLessThan(30);
    expect(opacityAtFrame('b', CUT)).toBeCloseTo(0, 3);
    expect(opacityAtFrame('b', CUT + 4)).toBeCloseTo(100, 3);
  });

  it('BOTH layers are dark at the cut — that is the whole point of a dip', () => {
    // A dip that only faded one side is a fade-out or a fade-in, not a dip. The
    // two must overlap in darkness at the seam or the cut still shows.
    butt();
    materializeTransition(record('dipToBlack'));
    expect(opacityAtFrame('a', CUT - 1) + opacityAtFrame('b', CUT)).toBeLessThan(40);
  });

  it('writes only the side its alignment asks for', () => {
    // startAtCut means "all of it after the cut": the outgoing clip simply ends
    // and the incoming one fades up. A ramp on the outgoing layer here would be
    // a fade the user did not ask for.
    butt();
    materializeTransition(record('dipToBlack', { alignment: 'startAtCut' }));
    expect(defaultAnimation.isAnimated('a', 'opacity')).toBe(false);
    expect(opacityAtFrame('b', CUT)).toBeCloseTo(0, 3);
    expect(opacityAtFrame('b', CUT + 8)).toBeCloseTo(100, 3);
  });
});

describe('dip to white', () => {
  it('drives a white FILL rather than opacity — the layers must not vanish', () => {
    // The documented choice: opacity 0 reveals the composition background, so a
    // dip to white done that way is a dip to whatever colour the comp is. The
    // fill turns the frame white on any background.
    butt();
    materializeTransition(record('dipToWhite'));
    expect(defaultAnimation.isAnimated('a', 'opacity')).toBe(false);
    expect(defaultAnimation.isAnimated('b', 'opacity')).toBe(false);

    const fx = getNodeEffects('a').find((e) => e.id === transitionEffectId(record('dipToWhite'), 'l'));
    expect(fx?.type).toBe('fill');
    expect(fx?.params?.color).toBe('#ffffff');
  });

  it('the fill rises to full at the cut and falls away after it', () => {
    butt();
    const rec = record('dipToWhite');
    materializeTransition(rec);
    const leftPath = `effect.${transitionEffectId(rec, 'l')}.opacity`;
    const rightPath = `effect.${transitionEffectId(rec, 'r')}.opacity`;
    expect(paramAtFrame('a', leftPath, CUT - 4)).toBeCloseTo(0, 3);
    // Frame 29 is the last the outgoing bar draws; the ramp tops out at 100 on
    // the cut itself, which is the frame it hands over.
    expect(paramAtFrame('a', leftPath, CUT - 1)).toBeGreaterThan(70);
    expect(paramAtFrame('b', rightPath, CUT)).toBeCloseTo(100, 3);
    expect(paramAtFrame('b', rightPath, CUT + 4)).toBeCloseTo(0, 3);
  });

  it('does not overlap the bars', () => {
    butt();
    materializeTransition(record('dipToWhite'));
    expect(barOf('a').end).toBe(CUT);
    expect(barOf('b').start).toBe(CUT);
  });
});

// ── Wipe ────────────────────────────────────────────────────────────

describe('wipe', () => {
  it('overlaps the bars like a dissolve — there must be something to wipe onto', () => {
    butt();
    materializeTransition(record('wipe'));
    expect(barOf('a').end - barOf('b').start).toBe(8);
  });

  it('uses the registry’s Linear Wipe, keyframed on the INCOMING clip only', () => {
    butt();
    const rec = record('wipe');
    materializeTransition(rec);
    const fx = getNodeEffects('b').find((e) => e.id === transitionEffectId(rec, 'r'));
    expect(fx?.type).toBe('linear-wipe');
    // The outgoing clip is untouched: it plays normally and is revealed
    // underneath. An effect on it too would be a second transition.
    expect(getNodeEffects('a')).toHaveLength(0);
    expect(defaultAnimation.isAnimated('a', 'opacity')).toBe(false);
  });

  it('runs completion from fully wiped to fully arrived across the overlap', () => {
    butt();
    const rec = record('wipe');
    materializeTransition(rec);
    const path = `effect.${transitionEffectId(rec, 'r')}.completion`;
    // 100 = nothing of the incoming clip showing, 0 = all of it. Backwards, and
    // the wipe plays in reverse while every other assertion still passes.
    expect(paramAtFrame('b', path, CUT - 4)).toBeCloseTo(100, 3);
    expect(paramAtFrame('b', path, CUT + 3)).toBeLessThan(20);
    expect(paramAtFrame('b', path, CUT)).toBeLessThan(paramAtFrame('b', path, CUT - 4));
  });
});

// ── Getting back out ────────────────────────────────────────────────

describe('dematerialize restores the exact previous state', () => {
  /** Everything a transition can touch, as one comparable value. */
  const stateOf = () => ({
    aClip: barOf('a').clip.toJSON(),
    bClip: barOf('b').clip.toJSON(),
    aOpacity: defaultAnimation.getTrackKeyframes('a', 'opacity') ?? [],
    bOpacity: defaultAnimation.getTrackKeyframes('b', 'opacity') ?? [],
    aEffects: getNodeEffects('a'),
    bEffects: getNodeEffects('b'),
  });

  for (const kind of ['crossDissolve', 'dipToBlack', 'dipToWhite', 'wipe'] as TransitionKind[]) {
    it(`${kind}: a bare cut comes back bare`, () => {
      butt();
      const before = stateOf();
      const res = materializeTransition(record(kind));
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      dematerializeTransition(res.record);
      expect(stateOf()).toEqual(before);
    });

    it(`${kind}: a HAND-AUTHORED fade already on the cut survives`, () => {
      // The case an inverse computed from the record cannot handle: `setKeyframe`
      // overwrites whatever sat at that time, so the only faithful "before" is
      // the array captured at materialise time. Keyframes at 0 and at the cut
      // are chosen to collide with the ones the transition writes.
      butt();
      defaultAnimation.setKeyframe('a', 'opacity', 0, 42);
      defaultAnimation.setKeyframe('a', 'opacity', compToKeyframeTime('a', CUT / fps()), 17);
      const before = stateOf();
      const res = materializeTransition(record(kind));
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      dematerializeTransition(res.record);
      expect(stateOf()).toEqual(before);
    });
  }

  it('an effect stack the user already had is not disturbed', () => {
    butt();
    const { addEffect } = require('@core/effects/effects') as typeof import('@core/effects/effects');
    addEffect('b', 'gaussian-blur', 'user_fx');
    const before = stateOf();
    const res = materializeTransition(record('wipe'));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    // While it is on, the transition's own effect is stacked ON TOP of the
    // user's rather than replacing it.
    expect(getNodeEffects('b').map((e) => e.id)).toContain('user_fx');
    dematerializeTransition(res.record);
    expect(stateOf()).toEqual(before);
  });

  it('removing one transition does not disturb the OTHER cut', () => {
    // Rule 3a's third layer: with only one cut in the fixture, a dematerialize
    // that restored the whole comp would pass every test above.
    butt();
    const res = materializeTransition(record('crossDissolve'));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    defaultAnimation.setKeyframe('a', 'rotation', 0, 90);
    dematerializeTransition(res.record);
    expect(defaultAnimation.sample('a', 'rotation', 0)).toBe(90);
  });
});

// ── History ─────────────────────────────────────────────────────────

describe('history', () => {
  it('materialise + dematerialise is at most a handful of engine entries, and undoes clean', () => {
    // The undoable unit is the OPERATION (`addTransition` wraps this in
    // `runAsOneHistoryEntry`); what is pinned here is that the primitive itself
    // leaves the geometry recoverable through the engine's own stack, which is
    // what makes the composite's suspend/resume safe.
    butt();
    const history = getCommandSystem().getHistory();
    const start = history.getEntries().length;
    const res = materializeTransition(record('crossDissolve'));
    expect(res.ok).toBe(true);
    expect(history.getEntries().length).toBeGreaterThan(start);
    if (!res.ok) throw new Error('unreachable');
    dematerializeTransition(res.record);
    expect(barOf('a').end).toBe(CUT);
    expect(barOf('b').start).toBe(CUT);
  });
});

// ── The undoable operations ─────────────────────────────────────────

describe('add / change / remove are ONE undo entry each', () => {
  /*
   * Every transition op crosses BOTH history mechanisms — clip geometry is on
   * the engine's command stack, keyframes and the effect stack on the app's
   * debounced snapshot — which is exactly the split `runAsOneHistoryEntry`
   * exists to close. Left uncomposed, one dissolve costs three undo presses and
   * the middle press shows a broken edit: bars overlapped with no fade on them.
   */
  const historyLength = (): number => getCommandSystem().getHistory().getEntries().length;
  const compId = (): string => getTimelineController().compIdForNode('a');

  it('adding one is a single entry, and undo puts the cut back AND forgets the record', () => {
    butt();
    const start = historyLength();
    return addTransition('a', 'b', 'crossDissolve', 8, 'centred').then((res) => {
      expect(res.ok).toBe(true);
      expect(historyLength()).toBe(start + 1);
      expect(barOf('a').end).toBe(CUT + 4);
      expect(useTransitionStore.getState().list(compId())).toHaveLength(1);

      getCommandSystem().getHistory().undo();
      expect(barOf('a').end).toBe(CUT);
      expect(barOf('b').start).toBe(CUT);
      // The record has to go back too. A store that survived undo would leave a
      // bracket drawn over a cut that no longer has a transition on it.
      expect(useTransitionStore.getState().list(compId())).toHaveLength(0);
    });
  });

  it('a REFUSED add pushes no entry at all', () => {
    // An undo step describing an edit that never happened is worse than no
    // feedback: the next Ctrl+Z appears to do nothing.
    butt({ leftTail: 0, rightHead: 0 });
    const start = historyLength();
    return addTransition('a', 'b', 'crossDissolve', 8, 'centred').then((res) => {
      expect(res.ok).toBe(false);
      expect(historyLength()).toBe(start);
    });
  });

  it('adding to a cut that already has one REPLACES it rather than stacking', () => {
    butt();
    return addTransition('a', 'b', 'crossDissolve', 8, 'centred')
      .then(() => addTransition('a', 'b', 'dipToBlack', 8, 'centred'))
      .then(() => {
        const list = useTransitionStore.getState().list(compId());
        expect(list).toHaveLength(1);
        expect(list[0]?.kind).toBe('dipToBlack');
        // The first one's overlap has to have been undone, or the dip sits on a
        // cut that is still 8 frames wide.
        expect(barOf('a').end).toBe(CUT);
      });
  });

  it('changing the duration is one entry and re-measures from the ORIGINAL handles', () => {
    butt();
    return addTransition('a', 'b', 'crossDissolve', 8, 'centred')
      .then(() => {
        const id = useTransitionStore.getState().list(compId())[0]?.id ?? '';
        const start = historyLength();
        return setTransition(compId(), id, { durationFrames: 16 }).then((res) => {
          expect(res.ok).toBe(true);
          expect(historyLength()).toBe(start + 1);
          // 16 centred → 8 either side of the original cut, not 8 either side
          // of the overlap the first dissolve already opened.
          expect(barOf('a').end).toBe(CUT + 8);
          expect(barOf('b').start).toBe(CUT - 8);
        });
      });
  });

  it('changing the KIND swaps what is written, in one entry', () => {
    butt();
    return addTransition('a', 'b', 'crossDissolve', 8, 'centred')
      .then(() => {
        const id = useTransitionStore.getState().list(compId())[0]?.id ?? '';
        return setTransition(compId(), id, { kind: 'dipToBlack' });
      })
      .then(() => {
        // The dissolve's overlap must be gone — a dip does not overlap — and
        // the dip's ramps must be there instead.
        expect(barOf('a').end).toBe(CUT);
        expect(opacityAtFrame('a', CUT - 4)).toBeCloseTo(100, 3);
      });
  });

  it('removing restores the cut and is one entry', () => {
    butt();
    return addTransition('a', 'b', 'crossDissolve', 8, 'centred').then(() => {
      const id = useTransitionStore.getState().list(compId())[0]?.id ?? '';
      const start = historyLength();
      return removeTransition(compId(), id).then((done) => {
        expect(done).toBe(true);
        expect(historyLength()).toBe(start + 1);
        expect(barOf('a').end).toBe(CUT);
        expect(defaultAnimation.isAnimated('a', 'opacity')).toBe(false);
        expect(useTransitionStore.getState().list(compId())).toHaveLength(0);
      });
    });
  });
});

// ── The store ───────────────────────────────────────────────────────

describe('the store is comp-scoped and round-trips', () => {
  it('keeps each composition’s transitions apart', () => {
    const store = useTransitionStore.getState();
    store.put('compA', record('crossDissolve'));
    store.put('compB', record('wipe', { id: 't_other' }));
    expect(useTransitionStore.getState().list('compA').map((t) => t.id)).toEqual(['t_crossDissolve']);
    expect(useTransitionStore.getState().list('compB').map((t) => t.id)).toEqual(['t_other']);
  });

  it('restore(undefined) CLEARS, so a new project cannot inherit the last one’s', () => {
    // The bug this pins: a guard of `if (next)` inside restore would leave the
    // previous document's dissolves recorded against comp ids the new one
    // happens to share.
    useTransitionStore.getState().put('compA', record('crossDissolve'));
    useTransitionStore.getState().restore(undefined);
    expect(useTransitionStore.getState().list('compA')).toHaveLength(0);
  });

  it('capture hands back a COPY, so the document cannot alias the store', () => {
    useTransitionStore.getState().put('compA', record('crossDissolve'));
    const captured = useTransitionStore.getState().capture();
    const first = captured['compA']?.[0];
    if (first) first.durationFrames = 999;
    expect(useTransitionStore.getState().list('compA')[0]?.durationFrames).toBe(8);
  });
});
