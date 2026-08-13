/**
 * The AI's `add_effect` type enum must offer every effect the editor ships.
 *
 * ## The bug that produced this file
 *
 * `addEffectDef`'s `type` enum is hand-written, and carried the comment *"Kept
 * in lockstep with EFFECT_DEFS"*. It was not. It listed **45 of 92** effects —
 * whole families were absent: most of blur (gaussian, fast-box, radial,
 * compound), all of distort (bulge, twirl, spherize, corner-pin, bezier-warp,
 * wave-warp, turbulent-displace), all of generate (checkerboard, grid,
 * cell-pattern, vegas, lens-flare, numbers, timecode, audio-spectrum), most of
 * transition, the round-two colour set (exposure, vibrance, colorama, lumetri,
 * selective-color, shadow-highlight) and the matte family (set-matte,
 * simple-choker, linear-color-key, shift-channels).
 *
 * Nothing failed. Nothing could: an enum is a GATE, so a missing member is a
 * request the model never gets to make. `list_capabilities` reads the live
 * registry and cheerfully described the params of effects that `add_effect`
 * would then reject, so the two AI surfaces disagreed and only the write one was
 * wrong. The comment was the whole trap — prose asserting a property no one
 * checked, which is the same shape as the Compound Blur bug next door in
 * `effectRegistryComplete.test.ts`.
 *
 * ## Why a test and not a type
 *
 * `packages/ai-tools` cannot import from the app — it is the boundary that makes
 * the tool defs portable, and it is the real reason the list is hand-written.
 * So the enum cannot be `EffectType[]` and the compiler cannot help. A test in
 * `src/` can import BOTH sides, and this is that test.
 *
 * ## Why EFFECT_DEFS is the expected set
 *
 * Not the `EffectType` union: `add_effect` on a type with no definition adds an
 * effect with no params that renders nothing (see
 * `gotcha_motion_effect_type_without_def` / `effectRegistryComplete.test.ts`).
 * The DEFS are what can actually be applied, so they are what the enum owes an
 * entry to. `effectRegistryComplete.test.ts` separately pins defs ≡ union, so
 * deriving from either is equivalent today — this file states the dependency it
 * actually means.
 */

import { addEffectDef, AI_EXCLUDED_EFFECTS } from '@motion/ai-tools';
import { EFFECT_DEFS, effectDefFor, type EffectType } from './effects';

/** The enum as shipped to the model, read off the def rather than re-listed. */
const ENUM = (addEffectDef.inputSchema.properties?.type?.enum ?? []) as readonly string[];

const REGISTRY = EFFECT_DEFS.map((d) => d.type);
const EXCLUDED = Object.keys(AI_EXCLUDED_EFFECTS);

describe('add_effect’s enum is in lockstep with EFFECT_DEFS', () => {
  it('offers every registered effect that is not explicitly excluded', () => {
    const offered = new Set(ENUM);
    const excluded = new Set(EXCLUDED);
    const missing = REGISTRY.filter((t) => !offered.has(t) && !excluded.has(t));
    // Named, not counted. "expected 91 to be 92" sends the next person back to
    // diffing two lists of ninety entries by eye, which is how this drifted for
    // three rounds. The message has to say WHICH effect the AI cannot reach.
    expect(missing).toEqual([]);
  });

  it('offers nothing the registry does not define', () => {
    // The other direction, and the one an enum makes easy to get wrong: a typo
    // or a renamed effect leaves a member the model will dutifully send and the
    // handler will reject — or worse, accept into an effect with no def, which
    // renders nothing at all.
    const orphans = ENUM.filter((t) => effectDefFor(t as EffectType) === undefined);
    expect(orphans).toEqual([]);
  });

  it('does not both offer and exclude the same effect', () => {
    // A contradiction here means the exclusion's stated reason is a lie about
    // shipped behaviour — the effect IS reachable. Cheap to assert, and it
    // makes the two lists a partition rather than two overlapping opinions.
    const both = EXCLUDED.filter((t) => ENUM.includes(t));
    expect(both).toEqual([]);
  });

  it('excludes only effects that actually exist, with a stated reason', () => {
    // An exclusion naming a misspelled or deleted effect is the failure mode
    // that would quietly re-open the original hole: the real effect stays out of
    // the enum, and the first test above is satisfied by a key matching nothing.
    const unknown = EXCLUDED.filter((t) => effectDefFor(t as EffectType) === undefined);
    expect(unknown).toEqual([]);

    for (const [type, reason] of Object.entries(AI_EXCLUDED_EFFECTS)) {
      // The reason is the point of the list. An empty one is the silent absence
      // this file exists to forbid, wearing a different hat.
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(40);
      expect(type).not.toBe('');
    }
  });

  it('keeps the exclusion list small enough to stay honest', () => {
    // Not a style rule. The failure being guarded against is someone answering a
    // red first test by moving the effect into the exclusions instead of into
    // the enum, which converts a caught bug back into a documented one. A list
    // that grows past a handful is that happening.
    expect(EXCLUDED.length).toBeLessThanOrEqual(5);
  });
});

describe('the effects the exclusion list is NOT allowed to claim', () => {
  // These were the plausible candidates when the drift was fixed, and each was
  // checked against shipped behaviour rather than assumed. Pinning them stops
  // the reasoning being redone from scratch — and wrongly — next time.

  it('offers the layer-reference effects, because layer params are settable', () => {
    // `update_effect_param`'s `value` has no declared JSON type and
    // `toolContext.updateEffectParam` forwards it uncoerced, so a `type: 'layer'`
    // param takes a nodeId from `describe_scene` directly. `displacement-map`
    // was already in the enum before this fix on exactly that basis, which is
    // what shows the omission of the others was drift, not a policy.
    for (const t of ['set-matte', 'displacement-map', 'compound-blur', 'audio-spectrum']) {
      expect(ENUM).toContain(t);
    }
  });

  it('offers every effect whose params are plain numbers and colours', () => {
    // The families that were absent had nothing unusual about them at all —
    // this is the sample that was cited as "maybe deliberate" and was not.
    for (const t of [
      'gaussian-blur', 'fast-box-blur', 'radial-blur',
      'bulge', 'twirl', 'spherize', 'corner-pin', 'bezier-warp', 'wave-warp', 'turbulent-displace',
      'checkerboard', 'grid', 'cell-pattern', 'vegas', 'lens-flare', 'numbers', 'timecode',
      'venetian-blinds', 'gradient-wipe', 'card-wipe',
      'exposure', 'vibrance', 'colorama', 'lumetri', 'selective-color', 'shadow-highlight',
      'simple-choker', 'linear-color-key', 'shift-channels',
    ]) {
      expect(ENUM).toContain(t);
    }
  });
});
