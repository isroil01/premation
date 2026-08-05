/**
 * IK/FK switching — the pose-preservation invariant.
 *
 * The flag is trivial; the conversion is the feature. So almost everything here
 * asserts ONE thing in two directions: after a switch, every bone's world
 * transform is where it was before it.
 *
 * ## What the clean values would exclude (rule 3a)
 *
 * Each of these makes a WRONG conversion read as correct, so none is used:
 *
 *  • **a chain at rest** — if the FK pose already satisfies the IK target, both
 *    modes agree and a conversion that did nothing at all would pass;
 *  • **a fully extended chain** — IK is degenerate there (the solver has no bend
 *    to choose), so the elbow-side information the conversion must carry does
 *    not exist to be lost;
 *  • **a symmetric two-bone layout** — mirror it and a sign error in the FK
 *    write reproduces the same picture (rule 2b), so the chain here has unequal
 *    bone lengths and an off-axis root;
 *  • **zero rotation anywhere** — a zero angle is its own negation, so a flipped
 *    sign is invisible at it.
 *
 * The chain below is bent, unequal-length, rooted off-origin and rotated at
 * every joint, and `the fixture is genuinely bent` asserts that rather than
 * trusting it.
 */

import {
  planChainSwitch,
  solvedChainRotations,
  effectorPosition,
  chainModeAt,
  chainModeValue,
  chainModePropPath,
} from './ikfk';
import { computeWorldTransforms, boneTip, type Bone } from './skeleton';
import { applyIk, type IkTargetResolved } from './rigDeform';
import type { Mat2D } from './mat2d';

const DEG = Math.PI / 180;

/** Unequal lengths, off-origin root, non-zero rotation at every joint. */
const FK_BONES: Bone[] = [
  { id: 'upper', parentId: null, length: 70, x: -55, y: 18, rotation: -22 * DEG },
  { id: 'fore', parentId: 'upper', length: 45, x: 70, y: 0, rotation: 48 * DEG },
];
const END = 'fore';
const CHAIN = 2;

/** A goal the chain can reach but is NOT already at. */
const GOAL: IkTargetResolved = { boneId: END, x: 15, y: 62, chainLength: CHAIN };

const worldOf = (bones: readonly Bone[]) => computeWorldTransforms({ bones: [...bones] });

function poseSignature(bones: readonly Bone[]): Record<string, Mat2D> {
  const w = worldOf(bones);
  const out: Record<string, Mat2D> = {};
  for (const b of bones) out[b.id] = w.get(b.id)!;
  return out;
}

function expectPoseClose(a: Record<string, Mat2D>, b: Record<string, Mat2D>, digits = 6): void {
  expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  for (const id of Object.keys(a)) {
    for (let i = 0; i < 6; i++) {
      expect({ id, i, v: a[id]![i]! }).toEqual({ id, i, v: expect.closeTo(b[id]![i]!, digits) });
    }
  }
}

/** Apply a plan's rotations to produce the post-switch FK bones. */
function applyPlanRotations(bones: readonly Bone[], rotations: Map<string, number>): Bone[] {
  return bones.map((b) => (rotations.has(b.id) ? { ...b, rotation: rotations.get(b.id)! } : { ...b }));
}

describe('the fixture is unclean, as required', () => {
  it('is genuinely bent, unequal, off-origin and non-zero everywhere', () => {
    expect(FK_BONES[0]!.length).not.toBe(FK_BONES[1]!.length);
    expect(FK_BONES.every((b) => b.rotation !== 0)).toBe(true);
    expect(FK_BONES[0]!.x === 0 && FK_BONES[0]!.y === 0).toBe(false);
    // Not already at the goal — otherwise IK and FK agree and nothing is tested.
    const tip = effectorPosition(FK_BONES, END)!;
    expect(Math.hypot(tip.x - GOAL.x, tip.y - GOAL.y)).toBeGreaterThan(10);
  });

  it('the chain is NOT fully extended — there is a bend to preserve', () => {
    // A straight chain makes IK degenerate, so a conversion that dropped the
    // elbow side entirely would still look right.
    const w = worldOf(applyIk(FK_BONES, [GOAL]));
    const root = { x: w.get('upper')![4], y: w.get('upper')![5] };
    const tip = boneTip(w.get(END)!, FK_BONES[1]!.length);
    const span = Math.hypot(tip.x - root.x, tip.y - root.y);
    const straight = FK_BONES[0]!.length + FK_BONES[1]!.length;
    expect(span).toBeLessThan(straight - 5);
  });
});

describe('IK → FK preserves the pose', () => {
  it('every bone lands where the IK solve had it, to 6 digits', () => {
    // The solved pose is the thing to preserve.
    const solved = applyIk(FK_BONES, [GOAL]);
    const before = poseSignature(solved);

    const plan = planChainSwitch(FK_BONES, [GOAL], END, 'fk', CHAIN);
    // After the switch the chain is FK: no targets applied, rotations written.
    const after = poseSignature(applyPlanRotations(FK_BONES, plan.rotations));

    expectPoseClose(after, before);
  });

  it('and the fixture could have shown a failure — IK and FK differ before it', () => {
    // Positive control for the assertion above. If the un-switched FK pose
    // already equalled the IK pose, "preserved" would be free.
    const solved = poseSignature(applyIk(FK_BONES, [GOAL]));
    const raw = poseSignature(FK_BONES);
    let differs = false;
    for (const id of Object.keys(raw)) {
      for (let i = 0; i < 6; i++) if (Math.abs(raw[id]![i]! - solved[id]![i]!) > 1e-6) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('writes rotations ONLY for the chain — bones outside it are untouched', () => {
    const withSpare: Bone[] = [...FK_BONES, { id: 'tail', parentId: null, length: 20, x: 90, y: -40, rotation: 12 * DEG }];
    const plan = planChainSwitch(withSpare, [GOAL], END, 'fk', CHAIN);
    // Derived from the chain, not hard-coded.
    expect([...plan.rotations.keys()].sort()).toEqual(['fore', 'upper']);
    expect(plan.rotations.has('tail')).toBe(false);
  });
});

describe('FK → IK preserves the pose', () => {
  it('the target is the FK effector, so solving toward it reproduces the pose', () => {
    const before = poseSignature(FK_BONES);
    const plan = planChainSwitch(FK_BONES, [], END, 'ik', CHAIN);
    expect(plan.target).not.toBeNull();

    const target: IkTargetResolved = {
      boneId: END, x: plan.target!.x, y: plan.target!.y, chainLength: CHAIN,
    };
    const after = poseSignature(applyIk(FK_BONES, [target]));
    expectPoseClose(after, before, 4);
  });

  it('carries the BEND SIDE without a pole — the solver already preserves it', () => {
    // The corrected claim. `applyIk` keeps the CURRENT bend side when given no
    // pole, so FK → IK writes a target and nothing else. Asserted by measuring
    // the elbow, not by trusting the docstring: the joint must land on the same
    // side of the root→target line it started on.
    const plan = planChainSwitch(FK_BONES, [], END, 'ik', CHAIN);
    const target: IkTargetResolved = {
      boneId: END, x: plan.target!.x, y: plan.target!.y, chainLength: CHAIN,
    };
    const sideOf = (bones: readonly Bone[]) => {
      const w = worldOf(bones);
      const root = { x: w.get('upper')![4]!, y: w.get('upper')![5]! };
      const elbow = { x: w.get('fore')![4]!, y: w.get('fore')![5]! };
      const tip = boneTip(w.get(END)!, FK_BONES[1]!.length);
      const ax = tip.x - root.x, ay = tip.y - root.y;
      return Math.sign(ax * (elbow.y - root.y) - ay * (elbow.x - root.x));
    };
    const before = sideOf(FK_BONES);
    expect(before).not.toBe(0);           // the fixture HAS a side to preserve
    expect(sideOf(applyIk(FK_BONES, [target]))).toBe(before);
  });

  it('a plan to IK carries a target and no pole at all', () => {
    const plan = planChainSwitch(FK_BONES, [], END, 'ik', CHAIN);
    expect(plan.target).not.toBeNull();
    expect('pole' in plan).toBe(false);
  });
  it('an unknown bone yields no target rather than one at the origin', () => {
    expect(effectorPosition(FK_BONES, 'ghost')).toBeNull();
  });
});

describe('a round trip returns to where it started', () => {
  it('IK → FK → IK leaves the pose unchanged', () => {
    const solved = applyIk(FK_BONES, [GOAL]);
    const start = poseSignature(solved);

    const toFk = planChainSwitch(FK_BONES, [GOAL], END, 'fk', CHAIN);
    const fkBones = applyPlanRotations(FK_BONES, toFk.rotations);

    const toIk = planChainSwitch(fkBones, [], END, 'ik', CHAIN);
    const target: IkTargetResolved = {
      boneId: END, x: toIk.target!.x, y: toIk.target!.y, chainLength: CHAIN,
    };
    expectPoseClose(poseSignature(applyIk(fkBones, [target])), start, 4);
  });
});

describe('the mode is animation data', () => {
  it('holds rather than ramps — a sampled 0.4 is FK, 0.6 is IK', () => {
    expect(chainModeAt(0.4, 'ik')).toBe('fk');
    expect(chainModeAt(0.6, 'fk')).toBe('ik');
    // The threshold is where the hold flips, asserted rather than assumed.
    expect(chainModeAt(0.5, 'fk')).toBe('ik');
  });

  it('falls back to the stored mode with no track, and to IK with neither', () => {
    expect(chainModeAt(undefined, 'fk')).toBe('fk');
    expect(chainModeAt(undefined, undefined)).toBe('ik');
  });

  it('round-trips through its stored numeric value', () => {
    for (const m of ['ik', 'fk'] as const) {
      expect(chainModeAt(chainModeValue(m), undefined)).toBe(m);
    }
  });

  it('names the track per chain', () => {
    expect(chainModePropPath('fore')).toBe('ikMode.fore');
    expect(chainModePropPath('a')).not.toBe(chainModePropPath('b'));
  });
});

/**
 * Rule 2b — FIXTURE VALIDITY, not a directional guard.
 *
 * Named honestly after the break sweep: negating the solved rotations flips the
 * FK write, and this suite does NOT catch it — the pose-preservation tests do.
 * What this asserts is a property of the FIXTURE (that its chain is asymmetric
 * enough for a mirrored write to be distinguishable at all), which is the
 * precondition those tests depend on. Left in place for that reason, relabelled
 * so nobody reads it as the thing that catches a sign error.
 */
describe('rule 2b — the fixture can distinguish a mirrored write', () => {
  it('an asymmetric chain makes the mirrored rotations a DIFFERENT pose', () => {
    // A symmetric chain cannot show a sign error: mirror it and the wrong sign
    // reproduces the right picture. The expected rotations here come from the
    // solver's own solved bones read independently, and the MIRRORED rotations
    // are computed and shown to differ — so the assertion has a direction.
    const rot = solvedChainRotations(FK_BONES, [GOAL], END, CHAIN);
    expect(rot.size).toBe(2);
    for (const [id, r] of rot) {
      expect({ id, zero: r === 0 }).toEqual({ id, zero: false });
    }
    // Negating every solved rotation must NOT reproduce the same pose.
    const mirrored = applyPlanRotations(FK_BONES, new Map([...rot].map(([id, r]) => [id, -r])));
    const correct = applyPlanRotations(FK_BONES, rot);
    let differs = false;
    const a = poseSignature(mirrored), b = poseSignature(correct);
    for (const id of Object.keys(a)) {
      for (let i = 0; i < 6; i++) if (Math.abs(a[id]![i]! - b[id]![i]!) > 1e-6) differs = true;
    }
    expect(differs).toBe(true);
  });
});
