/**
 * `requiresBridge` — a technique that carries through a cut needs a cut worth
 * carrying through.
 *
 * `camera.match_move` is the first and only user. It deliberately does not
 * settle: its x and z tracks run to 1.25× the beat, so the move is still going
 * when the boundary arrives and the two beats read as one shot. That is a match
 * cut when something else survives the boundary too.
 *
 * The sequencer, however, inserts `carry_motion` on any boundary where
 * `survivalBetween()` found nothing — deliberately, so a run does not fail over
 * a boundary a drawn mark can span. Over one of those, `match_move` would be the
 * ONLY thing that continued while every element on screen was replaced. That
 * does not read as a match; it reads as a camera that failed to stop.
 *
 * Gated declaratively (`TechniqueDef.requiresBridge`) rather than by testing the
 * id in the caster, so the next technique with this dependency inherits the
 * guard instead of needing its id added next to this one's.
 */

import { candidates as motionCandidates, technique } from '@motion/technique-library';
import { lookPack } from '@motion/design-system';
import { availableRolesFor, sequence, validateCasting } from './index';
import type { CreativeBrief } from './types';

const SHARED_HEADLINE = 'Ship the thing you actually meant to ship';

/** Two beats that share a headline → `persist`, a strong bridge. */
const STRONG: CreativeBrief = {
  lookPackId: 'apple_keynote',
  energy: 0.4,
  tone: 'confident',
  totalDurationMs: 9000,
  beats: [
    { purpose: 'open on the promise', weight: 1, content: { headline: SHARED_HEADLINE, subhead: 'One pipeline.' } },
    { purpose: 'close on the CTA', weight: 1, content: { headline: SHARED_HEADLINE, cta: 'Start free' } },
  ],
};

/** Two beats that share NOTHING → the auto-inserted `carry_motion` bridge. */
const WEAK: CreativeBrief = {
  lookPackId: 'apple_keynote',
  energy: 0.4,
  tone: 'confident',
  totalDurationMs: 9000,
  beats: [
    { purpose: 'open on the promise', weight: 1, content: { headline: 'First thing entirely' } },
    { purpose: 'proof — the numbers', weight: 1, content: { quote: 'Something else completely', attribution: 'A. Person' } },
  ],
};

function candidatesForBeat0(brief: CreativeBrief): string[] {
  const seq = sequence(brief);
  const beat = seq.beats[0]!;
  const pack = lookPack(brief.lookPackId);
  return motionCandidates({
    pack: {
      id: pack.id,
      prefer: pack.prefer,
      forbid: pack.forbid,
      forbidCategories: pack.forbidCategories,
      forbidAboveEnergy: pack.forbidAboveEnergy,
    },
    energy: brief.energy,
    slotDurationMs: beat.durationMs,
    availableRoles: availableRolesFor(beat) as never,
    alreadyCast: [],
    tags: beat.tags,
    bridge: beat.survival
      ? ['persist', 'transform_into', 'match_cut', 'mask_reveal'].includes(beat.survival.kind)
        ? 'strong'
        : 'weak'
      : 'none',
    limit: 999,
  }).map((c) => c.technique.id);
}

describe('requiresBridge', () => {
  it('the two fixtures really do produce the bridges this test assumes', () => {
    // Guards the guard. If `survivalBetween` changed and both fixtures started
    // producing the same bridge, every assertion below would pass vacuously —
    // which is exactly how the `availableRolesFor` omission survived.
    expect(sequence(STRONG).beats[0]!.survival?.kind).toBe('persist');
    expect(sequence(WEAK).beats[0]!.survival?.kind).toBe('carry_motion');
  });

  it('match_move is OFFERED across a strong bridge', () => {
    expect(candidatesForBeat0(STRONG)).toContain('camera.match_move');
  });

  it('match_move is WITHHELD across the weakest bridge', () => {
    expect(candidatesForBeat0(WEAK)).not.toContain('camera.match_move');
  });

  it('withholds only the bridge-dependent technique, not every camera', () => {
    // The blunt version of this fix — refusing all cameras on a weak boundary —
    // would cost eight techniques to guard one, and the other thirteen have no
    // such dependency: a push-in over a hard cut is completely ordinary.
    const weak = candidatesForBeat0(WEAK);
    const cameras = weak.filter((id) => id.startsWith('camera.'));
    expect(cameras.length).toBeGreaterThan(0);
    expect(cameras).not.toContain('camera.match_move');
  });

  it('validateCasting refuses a model that names it anyway, with a reason', () => {
    // The candidate filter is not the whole guard: a model can name a technique
    // that was never offered, and `validateCasting` is what turns that into a
    // deterministic substitution plus a message the user can act on.
    const seq = sequence(WEAK);
    const { casting, problems } = validateCasting(seq, 'apple_keynote', 0.4, {
      layouts: [],
      motion: [{ beatIndex: 0, techniqueId: 'camera.match_move', params: {}, seed: 1 }],
    });
    const problem = problems.find((p) => p.beatIndex === 0);
    expect(problem).toBeDefined();
    expect(problem!.message).toMatch(/carry_motion|no survivor/);
    // Repaired, not dropped: the beat still gets motion.
    expect(problem!.replacedWith).toBeTruthy();
    expect(casting.motion[0]!.techniqueId).not.toBe('camera.match_move');
  });

  it('an unset bridge stays permissive', () => {
    // Every other caller of `candidates()` in the codebase — and there are
    // several — passes no bridge. A filter that read undefined as "not strong"
    // would silently withhold this technique from all of them.
    const seq = sequence(STRONG);
    const beat = seq.beats[0]!;
    const pack = lookPack('apple_keynote');
    const ids = motionCandidates({
      pack: {
        id: pack.id,
        prefer: pack.prefer,
        forbid: pack.forbid,
        forbidCategories: pack.forbidCategories,
        forbidAboveEnergy: pack.forbidAboveEnergy,
      },
      energy: 0.4,
      slotDurationMs: beat.durationMs,
      availableRoles: availableRolesFor(beat) as never,
      tags: beat.tags,
      limit: 999,
    }).map((c) => c.technique.id);
    expect(ids).toContain('camera.match_move');
  });

  it('is the only technique that declares the dependency', () => {
    // Not a style rule — a scope check. `requiresBridge` narrows a candidate
    // list, so a technique that gained it by accident would go quiet on most
    // beats with no other symptom.
    const declaring = technique('camera.match_move');
    expect(declaring?.requiresBridge).toBe(true);
  });
});
