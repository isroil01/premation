/**
 * Keyframe velocity: the half-ownership rule.
 *
 * The one thing this feature can get wrong invisibly is writing the INCOMING
 * numbers onto the keyframe you clicked. A keyframe's bezier shapes the
 * segment that starts at it, so incoming belongs to the PREVIOUS keyframe —
 * put it in the wrong place and the curve on the other side changes while the
 * side you were editing does not, which reads as "the dialog does nothing".
 */

import { defaultAnimation, POSITION_PSEUDO_PROP } from '@motion/animation';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { incomingSpeed, outgoingSpeed, effectiveBezier, influences } from './speedGraph';
import { applyKeyframeVelocity, readKeyframeVelocity } from './keyframeVelocity';

const NODE = 'kf_velocity_node';

function seedX(): void {
  defaultAnimation.removeTrack(NODE, 'x');
  defaultAnimation.setKeyframe(NODE, 'x', 0, 0);
  defaultAnimation.setKeyframe(NODE, 'x', 1, 100);
  defaultAnimation.setKeyframe(NODE, 'x', 2, 300);
}

function kf(prop: string, t: number) {
  return (defaultAnimation.getTrackKeyframes(NODE, prop) ?? []).find((k) => Math.abs(k.t - t) < 1e-6);
}

describe('keyframe velocity', () => {
  beforeAll(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  });

  beforeEach(() => {
    getCommandSystem().getHistory().clear();
    seedX();
  });

  afterEach(() => {
    defaultAnimation.removeTrack(NODE, 'x');
    defaultAnimation.removeTrack(NODE, 'y');
  });

  it('reports both sides for a middle keyframe', () => {
    const r = readKeyframeVelocity(NODE, 'x', 1);
    expect(r).not.toBeNull();
    expect(r!.hasIncoming).toBe(true);
    expect(r!.hasOutgoing).toBe(true);
    expect(r!.props).toEqual(['x']);
  });

  it('reports only the outgoing side at the first keyframe', () => {
    const r = readKeyframeVelocity(NODE, 'x', 0);
    expect(r!.hasIncoming).toBe(false);
    expect(r!.hasOutgoing).toBe(true);
  });

  it('reports only the incoming side at the last keyframe', () => {
    const r = readKeyframeVelocity(NODE, 'x', 2);
    expect(r!.hasIncoming).toBe(true);
    expect(r!.hasOutgoing).toBe(false);
  });

  it('is null for a lone keyframe — no segment, no velocity', () => {
    defaultAnimation.removeTrack(NODE, 'x');
    defaultAnimation.setKeyframe(NODE, 'x', 0, 0);
    expect(readKeyframeVelocity(NODE, 'x', 0)).toBeNull();
  });

  it('is null when nothing is keyed at that time', () => {
    expect(readKeyframeVelocity(NODE, 'x', 0.5)).toBeNull();
  });

  it('writes the incoming half onto the PREVIOUS keyframe, the outgoing onto this one', () => {
    const before0 = { ...kf('x', 0)! };
    const before1 = { ...kf('x', 1)! };

    applyKeyframeVelocity(NODE, 'x', 1, {
      inSpeed: 40,
      outSpeed: 500,
      inInfluence: 0.5,
      outInfluence: 0.25,
    });

    // Both ends of the middle keyframe's neighbourhood changed…
    expect(kf('x', 0)!.bezier).not.toEqual(before0.bezier);
    expect(kf('x', 1)!.bezier).not.toEqual(before1.bezier);
    // …and the keyframe AFTER it did not: nothing here owns that segment.
    expect(kf('x', 2)!.bezier).toBeUndefined();
  });

  it('round-trips the numbers it was given', () => {
    applyKeyframeVelocity(NODE, 'x', 1, {
      inSpeed: 40,
      outSpeed: 500,
      inInfluence: 0.5,
      outInfluence: 0.25,
    });

    // Incoming: segment 0→1, dv 100 over dt 1, read off keyframe 0's bezier.
    const inB = effectiveBezier(kf('x', 0)!);
    expect(incomingSpeed(inB, 100, 1)).toBeCloseTo(40, 4);
    expect(influences(inB).in).toBeCloseTo(0.5, 4);

    // Outgoing: segment 1→2, dv 200 over dt 1, read off keyframe 1's bezier.
    const outB = effectiveBezier(kf('x', 1)!);
    expect(outgoingSpeed(outB, 200, 1)).toBeCloseTo(500, 4);
    expect(influences(outB).out).toBeCloseTo(0.25, 4);
  });

  it('records exactly one undo entry for the whole write', () => {
    const depth = getCommandSystem().getHistory().getIndex() + 1;
    applyKeyframeVelocity(NODE, 'x', 1, {
      inSpeed: 10,
      outSpeed: 20,
      inInfluence: 0.4,
      outInfluence: 0.4,
    });
    expect(getCommandSystem().getHistory().getIndex() + 1).toBe(depth + 1);
  });

  it('solves each axis of a merged Position separately for the same speed', () => {
    // y moves a tenth as far as x over the same segment, so the bezier that
    // expresses "leaves at 50/s" is necessarily different on each track. One
    // shared bezier would mean two different speeds, which is the bug.
    defaultAnimation.setKeyframe(NODE, 'y', 0, 0);
    defaultAnimation.setKeyframe(NODE, 'y', 1, 10);
    defaultAnimation.setKeyframe(NODE, 'y', 2, 30);

    const r = readKeyframeVelocity(NODE, POSITION_PSEUDO_PROP, 1);
    expect(r!.props).toEqual(expect.arrayContaining(['x', 'y']));

    applyKeyframeVelocity(NODE, POSITION_PSEUDO_PROP, 1, {
      inSpeed: 50,
      outSpeed: 50,
      inInfluence: 1 / 3,
      outInfluence: 1 / 3,
    });

    expect(outgoingSpeed(effectiveBezier(kf('x', 1)!), 200, 1)).toBeCloseTo(50, 4);
    expect(outgoingSpeed(effectiveBezier(kf('y', 1)!), 20, 1)).toBeCloseTo(50, 4);
    expect(kf('x', 1)!.bezier).not.toEqual(kf('y', 1)!.bezier);
  });
});
