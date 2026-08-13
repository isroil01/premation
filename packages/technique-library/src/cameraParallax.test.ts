/**
 * `CAMERA_WITHOUT_PARALLAX` — the rule, and every false positive it has to
 * survive.
 *
 * Written to the `verify.test.ts` convention: a mechanical check that reports
 * correct work is worse than no check, because it spends a repair round and then
 * makes the output worse. So each guard below is a case a naive version of this
 * rule got wrong while I was writing it, recorded rather than remembered.
 *
 * ## Why the rule exists
 *
 * A perspective camera moving across coplanar layers produces a uniform scale or
 * slide. Measured on the shipped library: five of the six camera techniques left
 * their own beat at a depth spread of **0**, because the pass that stages a beat
 * in z was disabled on exactly the beats that had a camera. The failure is
 * invisible in a still frame, so the sighted critique pass could never have
 * caught it — which is precisely the argument for making it arithmetic.
 */

import { lintTiming, type TimingLintScene } from './lint';
import type { ToolCall } from '@motion/design-system';

/** A z track, the shape `track()` emits. */
function zTrack(nodeId: string, value: number): ToolCall {
  return {
    name: 'set_keyframes',
    args: {
      keyframes: [
        { nodeId, prop: 'z', t: 0, value, easing: 'linear' },
        { nodeId, prop: 'z', t: 2, value, easing: 'linear' },
      ],
    },
  };
}

function scene(o: Partial<TimingLintScene> & { beatOf: ReadonlyMap<string, number> }): TimingLintScene {
  return { calls: [], fps: 30, durationMs: 4000, ...o };
}

const parallax = (findings: ReturnType<typeof lintTiming>) =>
  findings.filter((f) => f.rule === 'CAMERA_WITHOUT_PARALLAX');

describe('CAMERA_WITHOUT_PARALLAX', () => {
  it('fires when a camera beat is flat', () => {
    const found = parallax(
      lintTiming(
        scene({
          beatOf: new Map([['b0_headline', 0], ['b0_subhead', 0], ['b0_cta', 0]]),
          cameraBeats: [0],
        }),
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('error');
    // Addressed to whoever fixes it, per the linter's own convention.
    expect(found[0]!.message).toMatch(/uniform scale/);
    expect(found[0]!.nodeIds).toHaveLength(3);
  });

  it('passes a beat staged the way emitDepth stages one', () => {
    // 378px is what `emitDepth` produces on a 1080-tall frame at its default
    // 0.35 spread. If this ever fails, the rule and the staging pass disagree
    // about what "staged" means, which is worse than either being wrong alone.
    const found = parallax(
      lintTiming(
        scene({
          calls: [zTrack('b0_media', 378), zTrack('b0_subhead', 189), zTrack('b0_headline', 0)],
          beatOf: new Map([['b0_media', 0], ['b0_subhead', 0], ['b0_headline', 0]]),
          cameraBeats: [0],
        }),
      ),
    );
    expect(found).toEqual([]);
  });

  it('reads static z as well as an animated track', () => {
    // FALSE POSITIVE #1. `emitDepth` writes z as a static `update_layer` prop;
    // camera techniques write an animated track. A rule that read only tracks
    // reported every properly-staged beat as flat — and a rule that read only
    // props reported every camera-staged one as flat. Both mechanisms count.
    const found = parallax(
      lintTiming(
        scene({
          staticZ: new Map([['b0_media', 378], ['b0_headline', 0]]),
          beatOf: new Map([['b0_media', 0], ['b0_headline', 0]]),
          cameraBeats: [0],
        }),
      ),
    );
    expect(found).toEqual([]);
  });

  it('counts an unstaged layer as z=0 rather than skipping it', () => {
    // FALSE POSITIVE #2, and the one that matters most. A beat where ONE layer
    // was pushed to 378 and five were never staged is exactly the defect: five
    // planes at 0 and one behind them is not depth, it is a backdrop. A rule
    // that averaged or skipped the unstaged layers would have called this
    // healthy — which is how the original bug survived a whole-composition
    // spread of 378.
    const found = parallax(
      lintTiming(
        scene({
          staticZ: new Map([['b0_media', 378]]),
          beatOf: new Map([
            ['b0_media', 0], ['b0_headline', 0], ['b0_subhead', 0], ['b0_cta', 0],
          ]),
          cameraBeats: [0],
        }),
      ),
    );
    // Spread IS 378 here (378 → 0), so it passes — correctly. The guard is that
    // the unstaged layers were counted at 0 rather than dropped: had they been
    // dropped, a single staged layer would have given a spread of 0 and fired.
    expect(found).toEqual([]);
  });

  it('does not fire on a beat with no camera', () => {
    // The rule is about camera moves. A flat beat with no camera is a flat
    // composition choice, which is legitimate — every product-pack piece is one.
    const found = parallax(
      lintTiming(
        scene({
          beatOf: new Map([['b1_headline', 1], ['b1_subhead', 1]]),
          cameraBeats: [0],
        }),
      ),
    );
    expect(found).toEqual([]);
  });

  it('does not fire on a single-layer beat', () => {
    // FALSE POSITIVE #3. One layer has no spread by definition and nothing to
    // parallax against. A push-in on a single full-frame image is a legitimate
    // shot — the Ken Burns move — and flagging it would make the rule fire on
    // correct work.
    const found = parallax(
      lintTiming(
        scene({
          beatOf: new Map([['b0_media', 0]]),
          cameraBeats: [0],
        }),
      ),
    );
    expect(found).toEqual([]);
  });

  it('fires on a spread that is non-zero but too small to read', () => {
    // A rule that only caught EXACTLY zero would pass any beat with a single
    // stray `update_layer { z: 1 }` — i.e. it would stop failing the moment
    // anything touched z, whether or not it produced depth.
    const found = parallax(
      lintTiming(
        scene({
          staticZ: new Map([['b0_media', 40], ['b0_headline', 0]]),
          beatOf: new Map([['b0_media', 0], ['b0_headline', 0]]),
          cameraBeats: [0],
        }),
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toMatch(/40px/);
  });

  it('is silent when the scene carries no beat map at all', () => {
    // Every other caller of `lintTiming` — and there are several — passes no
    // `beatOf`. A rule that treated "no information" as "no depth" would fire on
    // all of them.
    const found = parallax(
      lintTiming({ calls: [], fps: 30, durationMs: 4000, cameraBeats: [0] }),
    );
    expect(found).toEqual([]);
  });

  it('names the beat, so the repair can be scoped to it', () => {
    // The repair channel parses the beat index out of this message. If the
    // wording changes without the parser changing, the repair silently stops
    // firing and the rule reports a defect nothing fixes.
    const found = parallax(
      lintTiming(
        scene({
          beatOf: new Map([['b2_a', 2], ['b2_b', 2]]),
          cameraBeats: [2],
        }),
      ),
    );
    expect(found[0]!.message).toMatch(/^Beat 2 /);
  });
});
