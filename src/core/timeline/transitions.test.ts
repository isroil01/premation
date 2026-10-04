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



import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import {
  
  
  
  transitionRegion,
  
  
  
  
  
  
  
  
} from './transitions';

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

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
