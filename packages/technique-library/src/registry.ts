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
import { SCENE_TECHNIQUES_3 } from './techniques/scene3';
import { CAMERA_TECHNIQUES_2 } from './techniques/camera';
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
  // The four a pack already PREFERRED and nobody had written. See scene3.ts —
  // a dangling `prefer` entry degrades to "no preference" in silence, so four
  // packs had been shipping their second choice since they were authored.
  ...SCENE_TECHNIQUES_3,
  // The second camera set — 6 → 14. See techniques/camera.ts for why six was
  // a fallback rather than a vocabulary.
  ...CAMERA_TECHNIQUES_2,
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
    /**
     * Which motion vocabulary this pack speaks. Undefined means `'editorial'`.
     *
     * The structural form of `forbid` and `forbidCategories`, and the reason
     * both product packs could name five `ui.*` techniques in `prefer` and be
     * offered none of them. See `packPermits`.
     */
    vocabulary?: 'editorial' | 'product';
  };
  /**
   * The techniques to choose from. Defaults to the editorial `TECHNIQUES`.
   *
   * ## Why this is a parameter rather than a merged module-level array
   *
   * The product techniques live in `@motion/product-motion`, which imports this
   * package — so this package cannot import them back. The consequence went
   * unnoticed for as long as it did because the failure is silent in both
   * directions: `motionCastPrompts` built its candidate list from `TECHNIQUES`
   * alone, so `saas_product` and `mobile_app` were offered **zero** product
   * techniques on every beat of every run, and fell back to whatever editorial
   * technique their forbid rules had not yet caught. Both packs named five
   * `ui.*` ids in `prefer`; all ten were unreachable.
   *
   * The caster owns the pool because the caster is the only place that can see
   * both registries. `packPermits` still checks vocabulary, so a caller passing
   * the wrong pool gets an empty list rather than a leak.
   */
  pool?: readonly TechniqueDef[];
  /** 0..1 energy the brief called for. */
  energy: number;
  /** How long this slot is. Techniques that cannot read in it are dropped. */
  slotDurationMs: number;
  /** Roles the layout produced. A technique must be able to animate at least one. */
  availableRoles: readonly AnimatableRole[];
  /**
   * How strongly this beat is bridged to the next one.
   *
   * `'strong'` = the sequencer found a real survivor (`persist`,
   * `transform_into`, `match_cut`). `'weak'` = the auto-inserted `carry_motion`
   * bridge. `'none'` = the last beat, or no bridge at all.
   *
   * Gates `requiresBridge` techniques. Undefined means unknown, and unknown is
   * treated as `'strong'` so every existing caller keeps its behaviour — a
   * filter that defaults to refusing would silently narrow every candidate list
   * in the codebase the moment this field was added.
   */
  bridge?: 'strong' | 'weak' | 'none';
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

/**
 * Techniques already cast that clash with `t`, or an empty list.
 *
 * `pool` is how the symmetric half of this check survives a second registry: the
 * already-cast id has to be RESOLVED to read its `neverWith`, and resolving it
 * through `BY_ID` alone means every product technique looks like it has no
 * antipatterns at all.
 */
export function clashesWith(
  t: TechniqueDef,
  alreadyCast: readonly string[],
  pool: readonly TechniqueDef[] = TECHNIQUES,
): string[] {
  const out: string[] = [];
  const resolve = (id: string): TechniqueDef | undefined =>
    BY_ID.get(id) ?? pool.find((p) => p.id === id);
  for (const castId of alreadyCast) {
    if (t.antipatterns.neverWith?.includes(castId)) out.push(castId);
    // Symmetric: if the already-cast technique forbids THIS one, that is a clash
    // too. Checking only one direction meant a pair could be co-cast depending
    // purely on which was chosen first.
    const other = resolve(castId);
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
 * Does this pack permit this technique — by vocabulary, id, category and energy?
 *
 * ## Vocabulary is checked FIRST, and it is what the other three were reaching for
 *
 * The id list alone let both product packs start offering
 * `kinetic_type.line_push_stack` and `exit.scatter_out` the moment the library
 * grew past the ids someone had typed out by hand, so `forbidCategories` was
 * added. But `TechniqueCategory` is shared across both vocabularies while the
 * *meaning* of a category is not: an editorial `transition` is a full-frame
 * wipe, and a product `transition` is `ui.shared_element_expand` — a row growing
 * into a detail view, the single most characteristic move in the discipline.
 *
 * So `forbidCategories: ['transition']` on `saas_product`, written to refuse
 * editorial wipes, was also refusing that pack's own first-choice technique.
 * Same for `ui.tab_switch` and `ui.momentum_scroll` on `mobile_app`. Three of
 * the ten product `prefer` entries were being filtered out by their own pack
 * before their preference was ever consulted.
 *
 * A category name cannot carry that distinction and should not be asked to. The
 * vocabulary check states the constraint that was actually meant — a pack casts
 * from its own discipline — and it is the structural form of acceptance
 * criterion 6b: a product prompt cannot emit an editorial technique because the
 * two vocabularies do not intersect, not because someone listed the ids.
 *
 * Undefined on either side means `'editorial'`, so every existing pack and every
 * technique in this library keeps its behaviour exactly.
 */
export function packPermits(
  pack: CastQuery['pack'],
  t: Pick<TechniqueDef, 'id' | 'category' | 'energy' | 'vocabulary'>,
): boolean {
  const vocabulary = pack.vocabulary ?? 'editorial';
  if ((t.vocabulary ?? 'editorial') !== vocabulary) return false;
  if (pack.forbid.includes(t.id)) return false;
  // `forbidCategories` is a list of EDITORIAL categories — every entry on both
  // product packs (`kinetic_type`, `camera`, `transition`, `exit`) was written to
  // name an editorial technique. The vocabulary check above already refuses all
  // of those, so applying it a second time inside the product vocabulary can only
  // do harm, and it did: it refused `ui.shared_element_expand`, `ui.tab_switch`
  // and `ui.momentum_scroll` — three of the ten ids the product packs PREFER.
  if (vocabulary === 'editorial' && pack.forbidCategories?.includes(t.category)) return false;
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
  pool: readonly TechniqueDef[] = TECHNIQUES,
): string | undefined {
  if (!t.exclusiveResource) return undefined;
  for (const id of alreadyCast) {
    if (id === t.id) continue;
    const other = BY_ID.get(id) ?? pool.find((p) => p.id === id);
    if (other?.exclusiveResource === t.exclusiveResource) return other.id;
  }
  return undefined;
}

export function candidates(q: CastQuery): Candidate[] {
  const cast = q.alreadyCast ?? [];
  const roles = new Set(q.availableRoles);
  const pool = q.pool ?? TECHNIQUES;

  const eligible = pool.filter((t) => {
    if (!packPermits(q.pack, t)) return false;
    // A technique shorter than its own minimum cannot read. Offering it and
    // letting the linter reject it afterwards wastes the whole slot.
    if (q.slotDurationMs < t.minDurationMs) return false;
    if (t.antipatterns.neverUnderMs && q.slotDurationMs < t.antipatterns.neverUnderMs) return false;
    if (atCap(t, cast)) return false;
    if (clashesWith(t, cast, pool).length) return false;
    if (resourceTakenBy(t, cast, pool)) return false;
    // The constrained match: it must be able to animate something that exists.
    if (!t.roles.some((r) => roles.has(r))) return false;
    // A technique that carries through a cut needs a cut worth carrying through.
    // See `requiresBridge` — undefined bridge means unknown, which stays
    // permissive so this filter cannot narrow a caller that never set it.
    if (t.requiresBridge && q.bridge !== undefined && q.bridge !== 'strong') return false;
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

  const limit = q.limit ?? 25;
  const chosen = reserveByCategory(scored, limit);
  return chosen.map(({ t }) => ({ technique: t, brief: briefFor(t) }));
}

/**
 * How many slots each category is guaranteed, when it has anything eligible.
 *
 * Two, not one: a single offer is a Hobson's choice, and the point of showing
 * the model a list is that it exercises taste over real alternatives.
 */
export const CATEGORY_FLOOR = 2;

/**
 * Take the top `limit`, but never let a whole category be evicted by ranking.
 *
 * ## The measurement that produced this
 *
 * The score is `pack.prefer` position + **8 per matching tag** + energy-band
 * closeness + role coverage. A beat's tags come from its purpose, so beat 0 of a
 * typical brief carries `[hero, entrance]` — and the camera techniques are
 * tagged `[camera, calm, cinematic, 2.5d, parallax]`. Zero overlap, so every
 * entrance technique outscores every camera technique, and with 47 techniques
 * competing for 25 slots the cameras fall off the end.
 *
 * Measured across 8 packs × 3 energies × 3 beats: **16 of 72 beat-slots lost an
 * eligible camera to the cap, and in 4 of them the count reached zero** — the
 * pack permitted a camera, the energy band permitted it, the duration permitted
 * it, and the model was never shown one. It bit hardest at energy 0.50, where
 * the most techniques qualify and competition is fiercest, and it bit hardest on
 * beat 0 — the hero beat, the one most likely to want a camera.
 *
 * This is the same shape as `availableRolesFor()` omitting `background`: a
 * filter quietly removing capability, invisible because the fallback looks like
 * a decision. So the fix is the same shape too — make the constraint explicit
 * rather than tuning the scores until the symptom goes away. Tagging cameras
 * with `hero` would have fixed this one beat and left the mechanism in place.
 *
 * Reservation is capped by what is actually eligible, so a category with one
 * member gets one slot and a category with none gets none. Categories over their
 * floor still fill every remaining slot by score, so a beat that genuinely wants
 * eleven entrances still gets them.
 */
function reserveByCategory<T extends { t: TechniqueDef; score: number }>(
  scored: readonly T[],
  limit: number,
): T[] {
  if (scored.length <= limit) return [...scored];

  const byCategory = new Map<string, T[]>();
  for (const s of scored) {
    const list = byCategory.get(s.t.category);
    if (list) list.push(s);
    else byCategory.set(s.t.category, [s]);
  }

  const picked = new Set<T>();
  // Reserve in descending category size, so when the floors cannot all be met
  // the categories that lose out are the ones with the most alternatives.
  const categories = [...byCategory.values()].sort((a, b) => b.length - a.length);
  for (const list of categories) {
    for (const s of list.slice(0, Math.min(CATEGORY_FLOOR, list.length))) {
      if (picked.size >= limit) break;
      picked.add(s);
    }
  }

  // Fill the rest strictly by score.
  for (const s of scored) {
    if (picked.size >= limit) break;
    picked.add(s);
  }

  // Hand back in score order: the list the model reads is still ranked, and a
  // reserved camera appears where its score puts it rather than pinned to the
  // top, which would overstate it.
  return scored.filter((s) => picked.has(s));
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
