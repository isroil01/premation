/**
 * THE PREFER-LIST STANDING TEST.
 *
 * Every id in a pack's `prefer` list must survive the whole way down: exist in
 * the registry, be castable under that same pack's own rules, reach `emit()`,
 * and land something a parse of the resulting scene can actually see.
 *
 * ## Why this is written as a standing test rather than a one-off sweep
 *
 * Three separate defects in this project had the same shape — a name that reads
 * as a live capability and resolves to nothing:
 *
 *  1. `layoutPrefer` in both product packs named four templates that were never
 *     written. The ranking degraded silently to "no preference", so both packs
 *     had techniques, components, and nowhere to put them.
 *  2. `set_text_on_path` was named by an authored surface and had no handler.
 *  3. `set_trim_path` emitted nothing (a handler bug) AND was invisible to the
 *     linter, so five authored surfaces — two of them in `prefer` lists — were
 *     both broken and unmeasurable at once.
 *
 * Each was found by accident, later, in a different investigation. The common
 * factor is that a `prefer` entry is a *ranking hint*: naming something that
 * does not work degrades to naming nothing, and nothing is indistinguishable
 * from a pack that simply had no opinion. There is no symptom at the point of
 * failure. So the check has to be structural and it has to run every time.
 *
 * A failure here is a Phase-0-class defect — a capability that was authored,
 * declared, and does not reach the frame. It is never fixed by deleting the
 * `prefer` entry.
 */

import {
  LOOK_PACKS,
  mk,
  resolvePack,
  type LookPack,
  type ToolCall,
} from '@motion/design-system';
import {
  candidates,
  coerceParams,
  packPermits,
  technique,
  tracksFromCalls,
  type AnimatableRole,
  type EmitContext,
  type TechniqueDef,
} from '@motion/technique-library';
import { PRODUCT_TECHNIQUES } from '@motion/product-motion';
import { motionCastScope } from './cast';
import { sceneFromCalls } from './emit';

/**
 * Resolution goes through BOTH registries, exactly as `cast.ts` and `emit.ts` do.
 *
 * The first draft of this file resolved only through `@motion/technique-library`
 * and reported all ten `ui.*` prefer entries as dangling. They are not: they live
 * in `PRODUCT_TECHNIQUES`, and the caster merges the two maps at both the
 * validate and the emit step. Looking one registry up and concluding "does not
 * exist" is the same mistake as grepping for a name that is only ever reached
 * through a wrapper — so the rule is the same. Follow the chain the production
 * code follows.
 */
const PRODUCT_BY_ID = new Map(PRODUCT_TECHNIQUES.map((t) => [t.id, t]));
const anyTechnique = (id: string): TechniqueDef | undefined => technique(id) ?? PRODUCT_BY_ID.get(id);

const FRAME = { width: 1920, height: 1080 };
const FPS = 30;
const VERBOSE = process.env.PREFER_LIST === '1';
const log = (...a: unknown[]): void => {

  if (VERBOSE) console.log(...a);
};

/**
 * Every role a technique might animate.
 *
 * Generous on purpose. The question this file asks is "does this technique work
 * at all", not "does it work on a stingy layout" — a technique that needs three
 * stats and is handed one would fail here for a reason that is not a defect.
 */
const ALL_TARGETS: EmitContext['targets'] = {
  headline: ['hl_0', 'hl_1', 'hl_2'],
  subhead: ['sub_0'],
  support: ['sup_0'],
  overline: ['ov_0'],
  media: ['media_0'],
  mark: ['mark_0'],
  stat: ['stat_0', 'stat_1', 'stat_2'],
  quote: ['quote_0', 'quote_1'],
  list: ['li_0', 'li_1', 'li_2'],
  cta: ['cta_0'],
  rule: ['rule_0'],
  background: ['bg_0'],
  camera: [],
};

const ALL_ROLES = Object.keys(ALL_TARGETS) as AnimatableRole[];

/**
 * The layers the layout would have produced, as `create_layer` calls.
 *
 * A technique animates a design it did not create, so the parse has to start
 * from a scene that already contains its targets. Without this every track
 * would point at a layer id the parse has never heard of — which is precisely
 * the failure mode `tracksReachRealLayers` below is looking for, and seeding
 * the scene is what makes that check mean something.
 */
function baseCalls(): ToolCall[] {
  const out: ToolCall[] = [];
  let i = 0;
  for (const [role, ids] of Object.entries(ALL_TARGETS)) {
    for (const id of ids ?? []) {
      out.push(
        mk('create_layer', {
          id,
          name: `${role} ${i}`,
          kind: role === 'media' ? 'image' : role === 'rule' ? 'shape' : 'text',
          x: 200 + (i % 3) * 320,
          y: 200 + Math.floor(i / 3) * 180,
          width: 480,
          height: 96,
          fill: '#ffffff',
          ...(role === 'rule' ? { shape: 'rect' } : {}),
        }),
      );
      i++;
    }
  }
  return out;
}

function contextFor(packId: string, durationMs: number): EmitContext {
  return {
    startMs: 500,
    durationMs,
    frameMs: 1000 / FPS,
    width: FRAME.width,
    height: FRAME.height,
    pack: resolvePack(packId),
    targets: ALL_TARGETS,
    idPrefix: 'pref',
  };
}

/** Emit a technique at a duration inside its own declared range. */
function emitFor(t: TechniqueDef, packId: string, seed = 0): { ctx: EmitContext; calls: ToolCall[] } {
  const dur = Math.min(Math.max(4000, t.minDurationMs), t.maxDurationMs);
  const ctx = contextFor(packId, dur);
  const params = coerceParams(t.params, {});
  return { ctx, calls: t.emit(ctx, params.value, seed) };
}

/** Fields of a parsed layer that carry a technique's structural work. */
const STRUCTURAL_KEYS = [
  'trim', 'pathOps', 'hasMask', 'textAnimators', 'isLight', 'layerStyles',
  'isParticle', 'repeater', 'hasRepeater', 'shape', 'isAsset', 'effects',
  'fill', 'width', 'height', 'hasGradient', 'shadowCount', 'cornerRadius',
] as const;

interface Effect {
  /** ≥1 track with ≥2 keys whose values are not all identical. */
  animates: boolean;
  /** The parse of base+emitted differs structurally from the parse of base. */
  structural: boolean;
  /** New layers the technique created. */
  newLayers: number;
  /** Track node ids the parsed scene has never heard of. */
  orphanTrackNodes: string[];
  /** Human-readable summary, for the report. */
  note: string;
}

/**
 * What did this emission actually DO to a parsed scene?
 *
 * Two axes, because techniques legitimately land in two different places.
 * Structure-only (a mask, a repeater, a light) is visible to `sceneFromCalls`
 * and invisible to `tracksFromCalls`; animation-only (most entrances) is the
 * reverse. Requiring both would fail honest techniques; requiring neither is
 * what let `set_trim_path` emit nothing for as long as it did.
 */
function effectOf(emitted: readonly ToolCall[]): Effect {
  const base = baseCalls();
  const before = sceneFromCalls(base, FRAME, {});
  const after = sceneFromCalls([...base, ...emitted], FRAME, {});

  const beforeById = new Map(before.map((l) => [l.id, l]));
  const newLayers = after.filter((l) => !beforeById.has(l.id)).length;

  let structural = newLayers > 0;
  const changed: string[] = [];
  for (const l of after) {
    const b = beforeById.get(l.id);
    if (!b) continue;
    for (const k of STRUCTURAL_KEYS) {
      const before_ = JSON.stringify((b as Record<string, unknown>)[k] ?? null);
      const after_ = JSON.stringify((l as Record<string, unknown>)[k] ?? null);
      if (before_ !== after_) {
        structural = true;
        changed.push(`${l.id}.${k}`);
      }
    }
  }

  const tracks = tracksFromCalls(emitted);
  const moving = tracks.filter(
    (t) => t.keys.length >= 2 && t.keys.some((k) => k.value !== t.keys[0]!.value),
  );

  /**
   * Springs count as animation, and `tracksFromCalls` cannot see them.
   *
   * Product motion has no beziers — every `PRODUCT_TECHNIQUE` emits `set_spring`
   * and nothing else. `tracksFromCalls` reads `set_keyframes` only, so scoring
   * this on keyframe tracks alone would report all thirty-odd product techniques
   * as emitting nothing. That would be a defect in the measurement, not in them,
   * and it is the same shape as the trim-path gap: a live capability the parse
   * has no case for.
   */
  const springs = emitted.filter(
    (c) => c.name === 'set_spring' && Number(c.args.from ?? 0) !== Number(c.args.to ?? 0),
  );

  // A track pointing at a node nobody created animates nothing. It costs a tool
  // call, passes every timing rule, and produces no motion — the most expensive
  // possible way to do nothing.
  const known = new Set(after.map((l) => l.id));
  const orphanTrackNodes = [
    ...new Set(
      [
        ...tracks.map((t) => t.nodeId),
        ...emitted.filter((c) => c.name === 'set_spring').map((c) => String(c.args.nodeId ?? '')),
      ].filter((id) => id && !known.has(id)),
    ),
  ];

  const parts: string[] = [];
  if (moving.length) parts.push(`${moving.length} moving track(s)`);
  if (springs.length) parts.push(`${springs.length} spring(s)`);
  if (newLayers) parts.push(`+${newLayers} layer(s)`);
  if (changed.length) parts.push(`${[...new Set(changed.map((c) => c.split('.')[1]))].join('/')}`);
  if (!parts.length) parts.push('NOTHING');

  return {
    animates: moving.length > 0 || springs.length > 0,
    structural,
    newLayers,
    orphanTrackNodes,
    note: parts.join(', '),
  };
}

/** Packs, and the prefer entries each declares. */
const PREFER_ENTRIES: Array<{ pack: LookPack; id: string }> = LOOK_PACKS.flatMap((pack) =>
  pack.prefer.map((id) => ({ pack, id })),
);

describe('pack prefer lists', () => {
  it('names a technique that exists', () => {
    // The dangling-reference check, the same one `layoutPrefer` needed. A
    // `prefer` id that resolves to nothing is not an error anywhere in the
    // pipeline: `indexOf` returns -1 and the ranking simply has no opinion.
    const missing = PREFER_ENTRIES.filter(({ id }) => !anyTechnique(id)).map(
      ({ pack, id }) => `${pack.id} -> ${id}`,
    );
    expect(missing).toEqual([]);
  });

  it('never prefers a technique the same pack forbids', () => {
    // Self-contradiction. `packPermits` runs before ranking, so a technique in
    // both lists is filtered out before its preference is ever consulted — the
    // `prefer` entry is dead text and nothing says so.
    const contradictory = PREFER_ENTRIES.filter(({ pack, id }) => {
      const t = anyTechnique(id);
      return t !== undefined && !packPermits(pack, t);
    }).map(({ pack, id }) => `${pack.id} prefers ${id} but its own rules refuse it`);
    expect(contradictory).toEqual([]);
  });

  it('offers every preferred technique to the caster at some energy', () => {
    // Permitted is not the same as reachable. The candidate list is capped, and
    // a preferred technique whose energy band the pack never visits is offered
    // to the model exactly never — the pack's stated first choice, unofferable.
    const unreachable: string[] = [];
    for (const { pack, id } of PREFER_ENTRIES) {
      const t = anyTechnique(id);
      if (!t) continue;
      const offered = [0.15, 0.35, 0.5, 0.65, 0.85, 0.95].some((energy) =>
        candidates({
          // The caster's own scope, not a rebuilt literal — see `motionCastScope`.
          ...motionCastScope(pack),
          energy,
          slotDurationMs: Math.max(t.minDurationMs, 4000),
          availableRoles: ALL_ROLES,
        }).some((c) => c.technique.id === id),
      );
      if (!offered) unreachable.push(`${pack.id} -> ${id}`);
    }
    expect(unreachable).toEqual([]);
  });

  it('reaches emission and produces a measurable effect in the parsed scene', () => {
    const rows: string[] = [];
    const inert: string[] = [];
    const orphans: string[] = [];

    for (const { pack, id } of PREFER_ENTRIES) {
      const t = anyTechnique(id);
      if (!t) continue;
      const { calls } = emitFor(t, pack.id);

      if (!calls.length) {
        inert.push(`${pack.id} -> ${id}: emit() returned NO calls`);
        continue;
      }

      const fx = effectOf(calls);
      rows.push(
        `${pack.id.padEnd(18)} ${id.padEnd(34)} ${String(calls.length).padStart(3)} calls  ${fx.note}`,
      );
      if (!fx.animates && !fx.structural) {
        inert.push(`${pack.id} -> ${id}: ${calls.length} calls, nothing the parse can see`);
      }
      if (fx.orphanTrackNodes.length) {
        orphans.push(`${pack.id} -> ${id}: tracks on unknown node(s) ${fx.orphanTrackNodes.join(', ')}`);
      }
    }

    log(`\n── PREFER-LIST EMISSION (${rows.length} entries) ──\n${rows.join('\n')}`);

    expect(inert).toEqual([]);
    expect(orphans).toEqual([]);
  });

  it('never keyframes an effect it did not create', () => {
    /**
     * The narrowest, most expensive way to do nothing.
     *
     * `effect.<effectId>.<param>` is accepted by `isAnimatableProp` on its
     * prefix alone, so a track naming an effect that does not exist validates,
     * stores its keyframes, and is never sampled. `add_effect` generated its own
     * `fx_<n>` and a flat emitter cannot read a return value, so two techniques
     * invented an id instead — `emphasis.flash_pop` (in `broadcast_sports`'s
     * prefer list) and `entrance.blur_resolve_slow`. Both had shipped their
     * headline gesture as a stored track nothing read: a flash with no light and
     * a blur resolve that never blurred.
     *
     * The whole-scene checks above cannot catch this. Both techniques also emit
     * a real transform track and a real `add_effect` call, so the emission both
     * animates and changes the parsed scene — it is only the LINK between the
     * two that is broken. That is why this is asserted on its own terms.
     */
    const dangling: string[] = [];
    for (const { pack, id } of PREFER_ENTRIES) {
      const t = anyTechnique(id);
      if (!t) continue;
      for (let seed = 0; seed < Math.max(1, t.variants); seed++) {
        const { calls } = emitFor(t, pack.id, seed);
        // `nodeId::effectId` pairs this emission actually created.
        const created = new Set(
          calls
            .filter((c) => c.name === 'add_effect' && c.args.id)
            .map((c) => `${String(c.args.nodeId ?? '')}::${String(c.args.id)}`),
        );
        for (const track of tracksFromCalls(calls)) {
          if (!track.prop.startsWith('effect.')) continue;
          const effectId = track.prop.slice('effect.'.length).split('.')[0]!;
          if (!created.has(`${track.nodeId}::${effectId}`)) {
            dangling.push(`${pack.id} -> ${id} seed ${seed}: ${track.nodeId}.${track.prop}`);
          }
        }
      }
    }
    expect([...new Set(dangling)]).toEqual([]);
  });

  it('produces the same effect across every seed the technique declares', () => {
    // A technique with 4 variants where variant 3 emits nothing is a 25% chance
    // of a dead beat, and the corpus metrics — which cast seed 0 — would never
    // show it.
    const dead: string[] = [];
    for (const { pack, id } of PREFER_ENTRIES) {
      const t = anyTechnique(id);
      if (!t) continue;
      for (let seed = 0; seed < Math.max(1, t.variants); seed++) {
        const { calls } = emitFor(t, pack.id, seed);
        if (!calls.length) {
          dead.push(`${pack.id} -> ${id} seed ${seed}: no calls`);
          continue;
        }
        const fx = effectOf(calls);
        if (!fx.animates && !fx.structural) dead.push(`${pack.id} -> ${id} seed ${seed}: inert`);
      }
    }
    expect(dead).toEqual([]);
  });
});
