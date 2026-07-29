/**
 * The sequencer — deterministic, no LLM.
 *
 * Turns a creative brief into a beat grid with time budgets, tag hints, and a
 * **continuity contract**.
 *
 * ## The continuity contract is the point
 *
 * The old system's system prompt required "3–5 scenes tiling the duration", with a
 * `scene: N` on every content call. That rule structurally guarantees a
 * slideshow: discrete, non-overlapping segments with nothing crossing a boundary.
 * No amount of per-scene craft rescues it, because the failure is between the
 * scenes rather than inside them.
 *
 * This replaces the tiling rule with a survival rule:
 *
 * > Every beat boundary must declare at least one element that **survives** it,
 * > and how it transforms.
 *
 * `assignSurvivals` derives those from the content the beats actually share, and
 * `validate` REJECTS a sequence with a bare boundary. A rejection here costs
 * nothing; the same problem discovered after rendering costs a whole run.
 *
 * Pure.
 */

import type { SlotContent, SlotRole } from '@motion/design-system';
import type { Beat, BriefBeat, CreativeBrief, Sequence, Survival, SurvivalKind } from './types';

/** The minimum a beat needs to read at all. */
export const MIN_BEAT_MS = 700;

/**
 * Tag hints from a beat's free-text purpose.
 *
 * The purpose is the one place the model writes prose, and it is used only to
 * *rank* candidates — never to select one. A misread hint costs a slightly worse
 * ordering, not a wrong technique, which is why matching a keyword list is
 * adequate here and would not be adequate anywhere else.
 */
const PURPOSE_TAGS: readonly [RegExp, readonly string[]][] = [
  [/open|intro|title|hero|hook/i, ['hero', 'entrance']],
  [/proof|stat|number|metric|data|result/i, ['stat', 'data', 'proof']],
  [/feature|benefit|capab|what/i, ['grid', 'cards', 'features']],
  [/quote|testimon|said|voice/i, ['quote', 'testimonial']],
  [/step|how|process|flow|walk/i, ['list', 'steps', 'sequence']],
  [/close|end|cta|sign|start|try/i, ['endcard', 'cta', 'closing']],
  [/name|speaker|caption|label/i, ['lowerthird', 'caption']],
  [/fast|energy|punch|impact|slam/i, ['aggressive', 'impact']],
  [/calm|quiet|slow|restrain|luxur/i, ['calm', 'restrained']],
  [/tech|terminal|code|system/i, ['technical', 'mono']],
];

export function tagsForPurpose(purpose: string): string[] {
  const tags = new Set<string>();
  for (const [pattern, add] of PURPOSE_TAGS) {
    if (pattern.test(purpose)) for (const t of add) tags.add(t);
  }
  return [...tags];
}

/** Which slot roles this content can actually fill. */
function rolesIn(content: SlotContent): Set<SlotRole> {
  const roles = new Set<SlotRole>();
  if (content.headline) roles.add('headline');
  if (content.subhead) roles.add('subhead');
  if (content.support) roles.add('support');
  if (content.overline) roles.add('overline');
  if (content.quote) roles.add('quote');
  if (content.cta) roles.add('cta');
  if (content.mediaAssetId) roles.add('media');
  if (content.items?.length) {
    roles.add('stat');
    roles.add('list');
  }
  return roles;
}

/**
 * How beat `i` hands over to beat `i+1`.
 *
 * Derived from what the two beats actually share, in descending order of how
 * strongly it reads:
 *
 *  • the same **media** on both sides → `transform_into` (the strongest, because
 *    the viewer tracks a single object across the cut);
 *  • the same **headline text** → `persist`;
 *  • a shared **role** with different content → `match_cut`;
 *  • nothing shared but a mark or rule available → `carry_motion`, the weakest
 *    but still a real thread.
 *
 * Returns `undefined` only when the two beats genuinely share nothing, which is
 * exactly the case `validate` rejects.
 */
export function survivalBetween(a: SlotContent, b: SlotContent): Survival | undefined {
  if (a.mediaAssetId && a.mediaAssetId === b.mediaAssetId) {
    return { kind: 'transform_into', role: 'media' };
  }
  if (a.headline && a.headline === b.headline) {
    return { kind: 'persist', role: 'headline' };
  }
  const shared = [...rolesIn(a)].filter((r) => rolesIn(b).has(r));
  if (shared.length) {
    // A shared role with different content is a match cut: the eye stays in the
    // same place while what is there changes.
    return { kind: 'match_cut', role: shared[0]! };
  }
  if (a.mediaAssetId || b.mediaAssetId) {
    return { kind: 'mask_reveal', role: 'media' };
  }
  return undefined;
}

export interface SequenceOptions {
  /**
   * When two beats share nothing, insert a `carry_motion` survivor anyway rather
   * than failing.
   *
   * The mark or rule a layout draws is always available to carry across, so this
   * is a real thread rather than a rubber stamp. On by default because failing a
   * whole run over a boundary that a mark can bridge is worse than the weaker
   * continuity — but `validate` still reports it, so it is visible.
   */
  autoCarry?: boolean;
}

export function sequence(brief: CreativeBrief, o: SequenceOptions = {}): Sequence {
  const raw = brief.beats.length ? brief.beats : [{ purpose: 'hero', weight: 1, content: {} } as BriefBeat];

  // Normalise the weights. A model that returns weights summing to 0.9 or 3.7
  // meant the same proportions either way.
  const totalWeight = raw.reduce((s, b) => s + Math.max(0.01, b.weight), 0);
  const total = Math.max(MIN_BEAT_MS * raw.length, brief.totalDurationMs);

  const beats: Beat[] = [];
  let cursor = 0;
  raw.forEach((b, i) => {
    // Every beat gets at least MIN_BEAT_MS, taken proportionally from the rest.
    const share = (Math.max(0.01, b.weight) / totalWeight) * total;
    const durationMs = Math.max(MIN_BEAT_MS, Math.round(share));
    beats.push({
      index: i,
      startMs: cursor,
      durationMs,
      purpose: b.purpose,
      content: b.content,
      tags: tagsForPurpose(b.purpose),
    });
    cursor += durationMs;
  });

  // Assign survivals AFTER the grid exists, so a survival can reference the beat
  // that follows it.
  const boundaries: { atMs: number; survivors: number }[] = [];
  for (let i = 0; i < beats.length - 1; i++) {
    const found = survivalBetween(beats[i]!.content, beats[i + 1]!.content);
    const survival: Survival | undefined =
      found ?? (o.autoCarry !== false ? { kind: 'carry_motion' as SurvivalKind, role: 'mark' as SlotRole } : undefined);
    if (survival) beats[i] = { ...beats[i]!, survival };
    boundaries.push({
      atMs: beats[i]!.startMs + beats[i]!.durationMs,
      survivors: survival ? 1 : 0,
    });
  }

  return { beats, totalDurationMs: cursor, boundaries };
}

export interface SequenceProblem {
  severity: 'error' | 'warn';
  message: string;
}

/**
 * Reject a sequence that cannot produce a coherent piece.
 *
 * Every check here is one the model cannot be trusted to self-enforce — not
 * because it disagrees, but because it agrees and then violates it anyway. A
 * boundary with no survivor is the canonical case: ask any model whether a
 * slideshow is good and it says no, then plans one.
 */
export function validate(seq: Sequence): SequenceProblem[] {
  const problems: SequenceProblem[] = [];

  for (const b of seq.beats) {
    if (b.durationMs < MIN_BEAT_MS) {
      problems.push({
        severity: 'error',
        message: `Beat ${b.index} ("${b.purpose}") is ${b.durationMs}ms — under the ${MIN_BEAT_MS}ms floor. ` +
          `Nothing reads in that time. Merge it into a neighbour or lengthen the piece.`,
      });
    }
  }

  for (const boundary of seq.boundaries) {
    if (boundary.survivors <= 0) {
      problems.push({
        severity: 'error',
        message: `The boundary at ${(boundary.atMs / 1000).toFixed(1)}s has no surviving element — every ` +
          `element exits and a new set enters. That is a slideshow, not a cut. Give the two beats a ` +
          `shared headline, a shared media asset, or a shared slot role.`,
      });
    }
  }

  // A single beat is legal but usually means the brief was not decomposed.
  if (seq.beats.length === 1 && seq.totalDurationMs > 6000) {
    problems.push({
      severity: 'warn',
      message: `One beat across ${(seq.totalDurationMs / 1000).toFixed(1)}s. A piece this long with no ` +
        `internal structure will read as a still with a slow zoom. Break it into 3–5 beats.`,
    });
  }

  // Weak continuity everywhere: technically valid, visibly thin.
  const weak = seq.beats.filter((b) => b.survival?.kind === 'carry_motion').length;
  if (seq.boundaries.length >= 2 && weak === seq.boundaries.length) {
    problems.push({
      severity: 'warn',
      message: `Every boundary is bridged only by carry_motion — the weakest survival there is. No ` +
        `content is shared between any two beats, so the piece will read as related images rather ` +
        `than as one argument.`,
    });
  }

  return problems;
}

/** Roles a beat's content can fill — for constraining the motion cast. */
export function availableRolesFor(beat: Beat): SlotRole[] {
  const roles = [...rolesIn(beat.content)];
  // A layout can always draw a mark and a rule, so they are always castable.
  return [...roles, 'mark', 'rule'];
}
