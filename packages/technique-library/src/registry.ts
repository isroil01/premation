/**
 * The technique registry and the casting query.
 *
 * ## What the caster sees
 *
 * Never a `TechniqueDef`. It sees `briefFor()` — id, one line of intent, tags,
 * energy range, duration range, parameter names, and the antipattern summary.
 * Roughly six lines per candidate.
 *
 * ## Why the filtering is aggressive
 *
 * Handing a model 250 candidates and asking it to choose does not produce a
 * considered choice; it produces a pick from the top of the list. So candidates
 * are filtered by LookPack allow/forbid, by the energy the brief called for, by
 * whether the slot is long enough for the technique to read, and by whether the
 * technique can animate the roles the layout actually produced — and the result
 * is capped at 25.
 *
 * The role filter is the one that matters most for correctness: it is what makes
 * casting motion onto a layout a **constrained match** rather than free
 * invention. A technique that animates `stat` is simply not offered for a layout
 * with no stats.
 */

import { ENTRANCE_TECHNIQUES } from './techniques/entrance';
import { ENTRANCE_TECHNIQUES_2 } from './techniques/entrance2';
import { ENTRANCE_TECHNIQUES_3 } from './techniques/entrance3';
import { ENTRANCE_TECHNIQUES_4 } from './techniques/entrance4';
import { KINETIC_TECHNIQUES } from './techniques/kinetic';
import { KINETIC_TECHNIQUES_2 } from './techniques/kinetic2';
import { SCENE_TECHNIQUES } from './techniques/scene';
import { SCENE_TECHNIQUES_2 } from './techniques/scene2';
import type { AnimatableRole, TechniqueDef } from './schema';

export const TECHNIQUES: readonly TechniqueDef[] = [
  ...ENTRANCE_TECHNIQUES,
  ...ENTRANCE_TECHNIQUES_2,
  ...ENTRANCE_TECHNIQUES_3,
  ...ENTRANCE_TECHNIQUES_4,
  ...KINETIC_TECHNIQUES,
  ...KINETIC_TECHNIQUES_2,
  ...SCENE_TECHNIQUES,
  ...SCENE_TECHNIQUES_2,
];

const BY_ID = new Map(TECHNIQUES.map((t) => [t.id, t]));

export function technique(id: string): TechniqueDef | undefined {
  return BY_ID.get(id);
}

export function techniqueIds(): string[] {
  return [...BY_ID.keys()];
}

/**
 * Validate every technique's `requires` against the live tool registry.
 *
 * Called at boot. A technique naming a tool that does not exist would fail at
 * emit time, deep inside a run, with an error the user sees as "the AI broke" —
 * so it fails at startup instead, where it is a developer's problem.
 */
export function validateRequirements(availableTools: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const t of TECHNIQUES) {
    for (const need of t.requires) {
      if (!availableTools.has(need)) {
        problems.push(`${t.id} requires '${need}', which is not in the tool registry`);
      }
    }
  }
  return problems;
}

export interface CastQuery {
  /**
   * The LookPack. Its `prefer`/`forbid` lists dominate the ranking.
   *
   * `forbidCategories` and `forbidAboveEnergy` are the rule form of `forbid`,
   * and they are what keeps the product packs correct as this library grows: an
   * id list only refuses techniques that existed when it was written.
   */
  pack: {
    id: string;
    prefer: readonly string[];
    forbid: readonly string[];
    forbidCategories?: readonly string[];
    forbidAboveEnergy?: number;
  };
  /** 0..1 energy the brief called for. */
  energy: number;
  /** How long this slot is. Techniques that cannot read in it are dropped. */
  slotDurationMs: number;
  /** Roles the layout produced. A technique must be able to animate at least one. */
  availableRoles: readonly AnimatableRole[];
  /** Techniques already cast in this composition, for the antipattern filter. */
  alreadyCast?: readonly string[];
  /** Prefer these tags. */
  tags?: readonly string[];
  limit?: number;
}

export interface Candidate {
  technique: TechniqueDef;
  brief: string;
}

/** Techniques already cast that clash with `t`, or an empty list. */
export function clashesWith(t: TechniqueDef, alreadyCast: readonly string[]): string[] {
  const out: string[] = [];
  for (const castId of alreadyCast) {
    if (t.antipatterns.neverWith?.includes(castId)) out.push(castId);
    // Symmetric: if the already-cast technique forbids THIS one, that is a clash
    // too. Checking only one direction meant a pair could be co-cast depending
    // purely on which was chosen first.
    const other = BY_ID.get(castId);
    if (other?.antipatterns.neverWith?.includes(t.id)) out.push(castId);
  }
  return [...new Set(out)];
}

/** Has this technique hit its per-composition cap? */
export function atCap(t: TechniqueDef, alreadyCast: readonly string[]): boolean {
  const cap = t.antipatterns.maxPerComposition;
  if (cap === undefined) return false;
  return alreadyCast.filter((id) => id === t.id).length >= cap;
}

/**
 * Does this pack permit this technique — by id, by category, and by energy?
 *
 * All three, because the id list alone let both product packs start offering
 * `kinetic_type.line_push_stack` and `exit.scatter_out` the moment the library
 * grew past the ids someone had typed out by hand.
 */
export function packPermits(
  pack: CastQuery['pack'],
  t: Pick<TechniqueDef, 'id' | 'category' | 'energy'>,
): boolean {
  if (pack.forbid.includes(t.id)) return false;
  if (pack.forbidCategories?.includes(t.category)) return false;
  if (pack.forbidAboveEnergy !== undefined && t.energy[1] >= pack.forbidAboveEnergy) return false;
  return true;
}

/**
 * Has something already cast claimed this technique's exclusive resource?
 *
 * Returns the claimant's id, or undefined. Checked at candidate time so the
 * model is never OFFERED a second camera technique, and again at validation so a
 * model that names one anyway gets a reason rather than a silently dead layer.
 */
export function resourceTakenBy(
  t: Pick<TechniqueDef, 'id' | 'exclusiveResource'>,
  alreadyCast: readonly string[],
): string | undefined {
  if (!t.exclusiveResource) return undefined;
  for (const id of alreadyCast) {
    if (id === t.id) continue;
    const other = BY_ID.get(id);
    if (other?.exclusiveResource === t.exclusiveResource) return other.id;
  }
  return undefined;
}

export function candidates(q: CastQuery): Candidate[] {
  const cast = q.alreadyCast ?? [];
  const roles = new Set(q.availableRoles);

  const eligible = TECHNIQUES.filter((t) => {
    if (!packPermits(q.pack, t)) return false;
    // A technique shorter than its own minimum cannot read. Offering it and
    // letting the linter reject it afterwards wastes the whole slot.
    if (q.slotDurationMs < t.minDurationMs) return false;
    if (t.antipatterns.neverUnderMs && q.slotDurationMs < t.antipatterns.neverUnderMs) return false;
    if (atCap(t, cast)) return false;
    if (clashesWith(t, cast).length) return false;
    if (resourceTakenBy(t, cast)) return false;
    // The constrained match: it must be able to animate something that exists.
    if (!t.roles.some((r) => roles.has(r))) return false;
    // Energy: a hair of slack either side, so a brief at 0.64 can still reach a
    // technique whose band starts at 0.65.
    if (q.energy < t.energy[0] - 0.1 || q.energy > t.energy[1] + 0.1) return false;
    return true;
  });

  const scored = eligible.map((t) => {
    let score = 0;
    const pref = q.pack.prefer.indexOf(t.id);
    if (pref >= 0) score += 100 - pref;
    if (q.tags?.length) score += t.tags.filter((tag) => q.tags!.includes(tag)).length * 8;
    // Closeness of the energy band's centre to what was asked for.
    const centre = (t.energy[0] + t.energy[1]) / 2;
    score += (1 - Math.abs(centre - q.energy)) * 10;
    // A technique that can animate more of what exists is a better fit.
    score += t.roles.filter((r) => roles.has(r)).length * 2;
    return { t, score };
  });

  scored.sort((a, b) => b.score - a.score || a.t.id.localeCompare(b.t.id));
  return scored.slice(0, q.limit ?? 25).map(({ t }) => ({ technique: t, brief: briefFor(t) }));
}

/** The six-line form the caster sees. Never the full definition. */
export function briefFor(t: TechniqueDef): string {
  const params = Object.entries(t.params)
    .map(([k, d]) => {
      if (d.kind === 'enum') return `${k}(${d.values.join('|')})`;
      if (d.kind === 'number') return `${k}(${d.min ?? '−∞'}..${d.max ?? '∞'})`;
      if (d.kind === 'stringArray') return `${k}[]`;
      return k;
    })
    .join(', ');
  const guards: string[] = [];
  if (t.antipatterns.neverWith?.length) guards.push(`never with: ${t.antipatterns.neverWith.join(', ')}`);
  if (t.antipatterns.maxPerComposition) guards.push(`max ${t.antipatterns.maxPerComposition} per comp`);
  if (t.antipatterns.requiresBreathingRoomMs) guards.push(`needs ${t.antipatterns.requiresBreathingRoomMs}ms clear before`);

  return (
    `${t.id} — ${t.intent}\n` +
    `  tags: ${t.tags.join(', ')}\n` +
    `  energy: ${t.energy[0]}–${t.energy[1]} | duration: ${(t.minDurationMs / 1000).toFixed(1)}–${(t.maxDurationMs / 1000).toFixed(1)}s | ${t.dimensionality}\n` +
    `  animates: ${t.roles.join(', ')}\n` +
    `  params: ${params || '(none)'}\n` +
    (guards.length ? `  ${guards.join(' | ')}\n` : '')
  );
}

/** How many distinct techniques a pack can reach — the diversity ceiling. */
export function techniquesForPack(pack: CastQuery['pack']): readonly TechniqueDef[] {
  return TECHNIQUES.filter((t) => packPermits(pack, t));
}
