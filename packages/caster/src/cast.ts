/**
 * CASTING — the prompts, and the validation of what comes back.
 *
 * ## What the model sees
 *
 * A pre-filtered, capped list of one-line briefs. Never a `TechniqueDef`, never a
 * `LayoutTemplate`, never a keyframe. Filtering happens by LookPack, by energy, by
 * slot duration, and by which roles the content can actually fill — so the model
 * chooses from candidates that are all *valid*, and its job is taste rather than
 * feasibility.
 *
 * Handing it 250 options and asking it to choose does not produce a considered
 * choice; it produces a pick from the top of the list. So the cap is 25 for motion
 * and 12 for layout, and both are enforced by the registries.
 *
 * ## Validation is not optional
 *
 * A cast naming an unknown technique, a forbidden one, a clashing pair, or one
 * whose slot is too short is REJECTED and replaced with the highest-ranked valid
 * candidate. The model is not asked to try again: the constraint was already in the
 * prompt, and a model that violated it once will violate it again. Falling back
 * deterministically costs nothing and always produces something castable.
 *
 * Pure — builds prompt strings and validates plain objects. Makes no calls.
 */

import { candidates as layoutCandidates, lookPack, type LookPack } from '@motion/design-system';
import { candidates as motionCandidates, atCap, clashesWith, resourceTakenBy, technique } from '@motion/technique-library';
import { PRODUCT_TECHNIQUES } from '@motion/product-motion';
import { availableRolesFor } from './sequencer';
import type { Beat, Casting, LayoutCast, MotionCast, Sequence } from './types';

const PRODUCT_BY_ID = new Map(PRODUCT_TECHNIQUES.map((t) => [t.id, t]));
const anyTechnique = (id: string) => technique(id) ?? PRODUCT_BY_ID.get(id);

// ── Stage 1: the brief prompt ─────────────────────────────────────────

/**
 * The system prompt for the creative-brief call.
 *
 * Note what is absent: any mention of keyframes, easing, timing, stagger, or
 * colour values. The model is a creative director and a casting agent, and asking
 * it about craft it cannot perceive is what produced naive output from 14k lines
 * of pipeline.
 */
export function briefPrompt(packs: readonly LookPack[]): string {
  const list = packs
    .map((p) => `  ${p.id} — ${p.intent} (${p.vocabulary})`)
    .join('\n');
  return [
    'You are a creative director. Read the brief and make three decisions:',
    '',
    '  1. WHICH LOOK. Pick one pack. This is the single most consequential choice —',
    '     it fixes the palette, the type, the shape language, the pacing and the',
    '     motion vocabulary.',
    '  2. HOW MUCH ENERGY (0..1). Restraint is a choice, not an absence of one.',
    '  3. WHAT THE BEATS ARE. Three to five, each with a purpose and a weight, each',
    '     carrying the content it needs.',
    '',
    'Available packs:',
    list,
    '',
    'Two rules about the beats, and they are structural rather than stylistic:',
    '',
    '  • **Consecutive beats must SHARE something** — the same headline, the same',
    '    media asset, or at least the same kind of content in the same place. A',
    '    sequence where every element leaves and a new set arrives is a slideshow,',
    '    and no amount of craft inside the beats fixes it.',
    '  • **Do not describe motion.** Do not name an animation, a curve, a',
    '    duration, or a transition. Those are chosen later, from a hand-authored',
    '    library, by matching your stated purpose and energy — describing them here',
    '    would override authored craft with a guess.',
    '',
    'If the brief names a brand colour, return it as `accent`. Otherwise omit it.',
  ].join('\n');
}

// ── Stage 2: the layout-cast prompt ───────────────────────────────────

export interface LayoutCastPrompt {
  beatIndex: number;
  prompt: string;
  /** The ids the model may choose from. Used to validate the response. */
  allowed: readonly string[];
}

export function layoutCastPrompts(seq: Sequence, packId: string): LayoutCastPrompt[] {
  return seq.beats.map((beat) => {
    const list = layoutCandidates({ packId, content: beat.content, tags: beat.tags });
    return {
      beatIndex: beat.index,
      allowed: list.map((c) => c.template.id),
      prompt: [
        `Beat ${beat.index} — "${beat.purpose}" (${(beat.durationMs / 1000).toFixed(1)}s).`,
        '',
        'Choose ONE layout and a variant seed. Layouts are hand-authored: the grid,',
        'the type scale, the colour and the depth are already decided. Your job is',
        'which STRUCTURE suits this beat.',
        '',
        'Candidates:',
        ...list.map((c) => `  ${c.brief}`),
        '',
        'Return { templateId, seed }. The seed picks a variant — vary it between',
        'beats so two beats using the same layout do not look identical.',
      ].join('\n'),
    };
  });
}

// ── Stage 3: the motion-cast prompt ───────────────────────────────────

export interface MotionCastPrompt {
  beatIndex: number;
  prompt: string;
  allowed: readonly string[];
}

export function motionCastPrompts(
  seq: Sequence,
  packId: string,
  energy: number,
  alreadyCast: readonly string[] = [],
): MotionCastPrompt[] {
  const pack = lookPack(packId);
  const cast = [...alreadyCast];

  return seq.beats.map((beat) => {
    const list = motionCandidates({
      pack: { id: pack.id, prefer: pack.prefer, forbid: pack.forbid, forbidCategories: pack.forbidCategories, forbidAboveEnergy: pack.forbidAboveEnergy },
      energy,
      slotDurationMs: beat.durationMs,
      availableRoles: availableRolesFor(beat) as never,
      alreadyCast: cast,
      tags: beat.tags,
    });
    return {
      beatIndex: beat.index,
      allowed: list.map((c) => c.technique.id),
      prompt: [
        `Beat ${beat.index} — "${beat.purpose}" (${(beat.durationMs / 1000).toFixed(1)}s), energy ${energy.toFixed(2)}.`,
        `Roles present in this beat's layout: ${availableRolesFor(beat).join(', ')}.`,
        '',
        'Choose ONE technique, its parameters, and a variant seed.',
        '',
        'Techniques are hand-authored. Every keyframe, every bezier, every stagger',
        'interval and every overshoot is already decided inside them — you are',
        'choosing WHICH craft applies here, not authoring it. The parameters below',
        'are the only surface you control.',
        '',
        'Candidates:',
        ...list.map((c) => `  ${c.brief}`),
        '',
        'Return { techniqueId, params, seed }. Vary the seed between beats.',
      ].join('\n'),
    };
  });
}

// ── Validation ────────────────────────────────────────────────────────

export interface CastProblem {
  beatIndex: number;
  message: string;
  /** What was used instead. */
  replacedWith?: string;
}

export interface ValidatedCasting {
  casting: Casting;
  problems: CastProblem[];
}

/**
 * Validate and repair a casting.
 *
 * Every rejection falls back to the highest-ranked valid candidate rather than
 * asking the model again. The constraint was already stated in the prompt; a model
 * that violated it once will violate it again, and a round-trip to re-ask costs a
 * call for something a sort can decide.
 */
export function validateCasting(
  seq: Sequence,
  packId: string,
  energy: number,
  proposed: Casting,
): ValidatedCasting {
  const pack = lookPack(packId);
  const problems: CastProblem[] = [];
  const layouts: LayoutCast[] = [];
  const motion: MotionCast[] = [];

  // ── Layouts ─────────────────────────────────────────────────────────────
  for (const beat of seq.beats) {
    const list = layoutCandidates({ packId, content: beat.content, tags: beat.tags });
    if (!list.length) {
      problems.push({ beatIndex: beat.index, message: `No layout in '${packId}' can hold this beat's content.` });
      continue;
    }
    const wanted = proposed.layouts.find((l) => l.beatIndex === beat.index);
    const valid = wanted && list.some((c) => c.template.id === wanted.templateId);
    if (wanted && !valid) {
      problems.push({
        beatIndex: beat.index,
        message: `'${wanted.templateId}' is not a valid layout for beat ${beat.index} in '${packId}' — ` +
          `either the pack forbids it or its required slots cannot be filled.`,
        replacedWith: list[0]!.template.id,
      });
    }
    layouts.push({
      beatIndex: beat.index,
      templateId: valid ? wanted!.templateId : list[0]!.template.id,
      // A seed of exactly 0 on every beat is how a library with four variants
      // produces one. Deriving a fallback from the beat index at least varies it.
      seed: wanted?.seed ?? beat.index * 7 + 1,
    });
  }

  // ── Motion ──────────────────────────────────────────────────────────────
  // Cast in beat order and thread `alreadyCast` through, so per-composition caps
  // and antipattern clashes are evaluated against what has actually been chosen
  // rather than against the whole plan at once.
  const castSoFar: string[] = [];
  for (const beat of seq.beats) {
    const list = motionCandidates({
      pack: { id: pack.id, prefer: pack.prefer, forbid: pack.forbid, forbidCategories: pack.forbidCategories, forbidAboveEnergy: pack.forbidAboveEnergy },
      energy,
      slotDurationMs: beat.durationMs,
      availableRoles: availableRolesFor(beat) as never,
      alreadyCast: castSoFar,
      tags: beat.tags,
    });
    const wanted = proposed.motion.find((m) => m.beatIndex === beat.index);
    if (!wanted) continue;

    const def = anyTechnique(wanted.techniqueId);
    const reason = rejectReason(wanted.techniqueId, def, pack, beat, castSoFar, list.map((c) => c.technique.id));

    if (reason) {
      if (!list.length) {
        problems.push({ beatIndex: beat.index, message: `${reason} No valid alternative for this beat.` });
        continue;
      }
      problems.push({ beatIndex: beat.index, message: reason, replacedWith: list[0]!.technique.id });
      motion.push({
        beatIndex: beat.index,
        techniqueId: list[0]!.technique.id,
        params: {},
        seed: wanted.seed ?? beat.index * 11 + 3,
      });
      castSoFar.push(list[0]!.technique.id);
      continue;
    }

    motion.push({
      beatIndex: beat.index,
      techniqueId: wanted.techniqueId,
      params: wanted.params ?? {},
      seed: wanted.seed ?? beat.index * 11 + 3,
    });
    castSoFar.push(wanted.techniqueId);
  }

  return { casting: { layouts, motion }, problems };
}

function rejectReason(
  id: string,
  def: ReturnType<typeof anyTechnique>,
  pack: LookPack,
  beat: Beat,
  castSoFar: readonly string[],
  offered: readonly string[],
): string | undefined {
  if (!def) return `'${id}' is not a registered technique.`;
  if (pack.forbid.includes(id)) {
    return `'${id}' is forbidden in the '${pack.id}' pack — its motion vocabulary contradicts this look.`;
  }
  if (pack.forbidCategories?.includes(def.category)) {
    return `'${id}' is a '${def.category}' technique and the '${pack.id}' pack refuses that whole ` +
      `category — a product interface has no camera and its type is read, not watched.`;
  }
  if (pack.forbidAboveEnergy !== undefined && def.energy[1] >= pack.forbidAboveEnergy) {
    return `'${id}' peaks at energy ${def.energy[1]} and the '${pack.id}' pack caps at ` +
      `${pack.forbidAboveEnergy}. Nothing in a real interface moves that hard.`;
  }
  if (beat.durationMs < def.minDurationMs) {
    return `'${id}' needs at least ${def.minDurationMs}ms and beat ${beat.index} is ${beat.durationMs}ms; ` +
      `it would not read at all.`;
  }
  if (atCap(def, castSoFar)) {
    return `'${id}' is already at its per-composition cap of ${def.antipatterns.maxPerComposition}.`;
  }
  const clashes = clashesWith(def, castSoFar);
  if (clashes.length) {
    return `'${id}' clashes with '${clashes.join("', '")}' already cast in this composition.`;
  }
  const holder = resourceTakenBy(def, castSoFar);
  if (holder) {
    return `'${id}' needs the composition's ${def.exclusiveResource}, and '${holder}' already has it. ` +
      `A second camera layer would sit in the scene with its whole animation ignored — the renderer ` +
      `uses the first camera it finds.`;
  }
  if (!offered.includes(id)) {
    return `'${id}' was not among the candidates offered for beat ${beat.index} — its energy band or the ` +
      `roles it animates do not match this beat.`;
  }
  return undefined;
}

// ── The fit critic ────────────────────────────────────────────────────

/**
 * The prompt for the one optional critique call.
 *
 * Not six critics scoring rubrics. Averaged rubric scores converge to the mean,
 * and the mean is exactly the naive output the whole re-architecture exists to
 * escape — so the old loop's most expensive stage was actively pulling toward the
 * problem.
 *
 * One critic, one adversarial question. "Name the stock template it resembles" is
 * far sharper signal than six 1–10 scores, because a piece that can be named is a
 * piece to reject, and naming is something a vision model is genuinely good at.
 */
export function fitCriticPrompt(brief: { tone: string; lookPackId: string }): string {
  return [
    'You are looking at a filmstrip of a generated motion piece, sampled around its',
    'keyframe events, plus velocity graphs for its hero properties.',
    '',
    `The brief was: "${brief.tone}" in the '${brief.lookPackId}' look.`,
    '',
    'Answer two questions:',
    '',
    '  1. Does this serve that brief? Be specific about where it does not.',
    '  2. **Name the stock template it resembles.** If you can name one, it fails.',
    '',
    'Do not score it. Do not comment on easing, timing or spacing — those are',
    'already verified mechanically and you cannot see them accurately in stills.',
    'Judge only fit and distinctiveness.',
  ].join('\n');
}
