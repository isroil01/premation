/**
 * EMIT + VALIDATE — the deterministic half of the pipeline.
 *
 * Takes a sequence plus a casting and produces `ToolCall[]`, then runs all three
 * linters over the result and repairs what it can without asking anyone.
 *
 * ## The repair pass is deterministic on purpose
 *
 * "Add an overshoot", "widen that stagger", "tighten the tracking" are not
 * judgements — they are corrections with exactly one right answer, and sending
 * them to a model costs a turn and sometimes gets them wrong. So a linter error
 * triggers a **re-emit with corrected parameters**, in code. The only thing left
 * for an LLM is "does this serve the brief", which is the one question here it can
 * actually answer.
 *
 * ## Order matters
 *
 * Layout composes first and motion second, always. Motion animates a design; a
 * technique cast against nothing has no targets, and a technique cast against
 * primitives encodes the assumption that what is being moved is a rectangle.
 *
 * Pure.
 */

import {
  composeContext,
  designScore as computeDesignScore,
  layoutTemplate,
  lintDesign,
  resolvePack,
  type ComposeResult,
  type LintLayer,
  type LintScene,
  type ResolvedPack,
  type SlotRole,
  type ToolCall,
} from '@motion/design-system';
import {
  coerceParams,
  compositionShutter,
  craftScore as computeCraftScore,
  lintTiming,
  technique,
  type AnimatableRole,
  type EmitContext,
} from '@motion/technique-library';
import { PRODUCT_TECHNIQUES, lintUiMotion, uiMotionScore as computeUiScore } from '@motion/product-motion';
import type { CastMetrics, CastReport, Casting, Sequence } from './types';

const PRODUCT_BY_ID = new Map(PRODUCT_TECHNIQUES.map((t) => [t.id, t]));

/** Editorial library first, then the product library. Ids never collide. */
function anyTechnique(id: string) {
  return technique(id) ?? PRODUCT_BY_ID.get(id);
}

export interface EmitOptions {
  sequence: Sequence;
  casting: Casting;
  lookPackId: string;
  accent?: string;
  mode?: 'dark' | 'light';
  width: number;
  height: number;
  fps: number;
  /**
   * Cap on repair rounds.
   *
   * Two, not five. Each round is deterministic, so a problem that survives two
   * corrections is not going to yield to a third — it is a technique/layout
   * mismatch the caster should be told about rather than ground down.
   */
  maxRepairs?: number;
}

interface EmitPass {
  calls: ToolCall[];
  /** Per-beat layout results, for role → layer id resolution. */
  layouts: Map<number, ComposeResult>;
  /** Which ids came from a library technique, for `techniqueCoverage`. */
  techniqueLayerIds: Set<string>;
  /** Layer ids belonging to the product vocabulary. */
  uiLayerIds: Set<string>;
  /** Ids exempt from the UI travel limit. */
  offFrameLayerIds: Set<string>;
  heroLayerIds: Set<string>;
  instances: { id: string; startMs: number; durationMs: number; minDurationMs?: number; neverWith?: readonly string[] }[];
  surfaces: Record<string, string>;
}

/**
 * Techniques whose elements legitimately move further than the UI limit.
 *
 * A sheet rising from below the screen edge, a list flinging under a finger, an
 * indicator travelling the distance the layout put between two tabs. None is
 * in-place UI motion, and capping them at 24px would break all three.
 */
const OFF_FRAME_TECHNIQUES = new Set(['ui.sheet_present', 'ui.momentum_scroll', 'ui.tab_switch']);

/** Roles that count as hero content for the overshoot rule. */
const HERO_ROLES: readonly SlotRole[] = ['headline', 'mark', 'stat', 'quote'];

function emitPass(o: EmitOptions, pack: ResolvedPack, repairs: readonly string[]): EmitPass {
  const pass: EmitPass = {
    calls: [],
    layouts: new Map(),
    techniqueLayerIds: new Set(),
    uiLayerIds: new Set(),
    offFrameLayerIds: new Set(),
    heroLayerIds: new Set(),
    instances: [],
    surfaces: {},
  };

  // ── Composition-level shutter, once ─────────────────────────────────────
  // Per-layer motion blur is only an opt-in switch; the shutter that decides
  // whether a fast move reads as rendered lives on the composition. Emitting it
  // per technique would be N redundant calls that fight each other.
  const shutterCtx: EmitContext = {
    startMs: 0, durationMs: o.sequence.totalDurationMs, frameMs: 1000 / o.fps,
    width: o.width, height: o.height, pack, targets: {}, idPrefix: 'comp',
  };
  pass.calls.push(...compositionShutter(shutterCtx));

  // ── Layout first, motion second ─────────────────────────────────────────
  for (const beat of o.sequence.beats) {
    const cast = o.casting.layouts.find((l) => l.beatIndex === beat.index);
    if (!cast) continue;
    const template = layoutTemplate(cast.templateId);
    if (!template) continue;

    const ctx = composeContext(pack, o.width, o.height, {
      startMs: beat.startMs,
      durationMs: beat.durationMs,
      // Per-beat prefix, so two beats using the same template cannot collide on
      // layer ids — the class of bug where beat 2's `update_layer` silently
      // retargets beat 1's headline.
      idPrefix: `b${beat.index}`,
    });
    const result = template.compose(ctx, beat.content, cast.seed);
    pass.calls.push(...result.calls);
    pass.layouts.set(beat.index, result);
    Object.assign(pass.surfaces, result.surfaces ?? {});

    for (const role of HERO_ROLES) {
      for (const id of result.slots[role] ?? []) pass.heroLayerIds.add(id);
    }
  }

  // ── Motion ──────────────────────────────────────────────────────────────
  for (const cast of o.casting.motion) {
    const beat = o.sequence.beats.find((b) => b.index === cast.beatIndex);
    const def = anyTechnique(cast.techniqueId);
    const layout = pass.layouts.get(cast.beatIndex);
    if (!beat || !def || !layout) continue;

    // Only the roles the technique DECLARES and the layout actually produced.
    // This is the constrained match: casting motion onto a layout is a bounded
    // choice rather than free invention.
    const targets: EmitContext['targets'] = {};
    for (const role of def.roles) {
      const ids = layout.slots[role as SlotRole];
      if (ids?.length) targets[role as AnimatableRole] = ids;
    }
    if (!Object.keys(targets).length) continue;

    const params = coerceParams(def.params, applyRepairs(cast.params, cast.techniqueId, repairs));
    const ctx: EmitContext = {
      startMs: beat.startMs,
      durationMs: beat.durationMs,
      frameMs: 1000 / o.fps,
      width: o.width,
      height: o.height,
      pack,
      targets,
      idPrefix: `b${beat.index}_${cast.techniqueId.replace(/\W/g, '_')}`,
    };
    const calls = def.emit(ctx, params.value, cast.seed);
    pass.calls.push(...calls);

    for (const ids of Object.values(targets)) {
      for (const id of ids ?? []) {
        pass.techniqueLayerIds.add(id);
        if (PRODUCT_BY_ID.has(cast.techniqueId)) pass.uiLayerIds.add(id);
        if (OFF_FRAME_TECHNIQUES.has(cast.techniqueId)) pass.offFrameLayerIds.add(id);
      }
    }
    pass.instances.push({
      id: def.id,
      startMs: beat.startMs,
      durationMs: beat.durationMs,
      minDurationMs: def.minDurationMs,
      ...(def.antipatterns.neverWith ? { neverWith: def.antipatterns.neverWith } : {}),
    });
  }

  return pass;
}

/**
 * The deterministic repair table.
 *
 * Each entry is a linter rule and the parameter change that fixes it. These are
 * corrections, not judgements — which is why they run in code rather than costing
 * a model turn. A rule with no entry here is one that cannot be fixed by
 * re-parameterising, and the caster reports it instead.
 */
const REPAIRS: Record<string, (params: Record<string, unknown>) => Record<string, unknown>> = {
  // A stagger too tight for the elements it has: widen the span.
  SIMULTANEOUS_ENTRY: (p) => ({ ...p, spanMs: Math.round(Number(p.spanMs ?? 400) * 1.8) }),
  // A metronome: widen the span so the pack's curve has room to bend.
  UNIFORM_STAGGER: (p) => ({ ...p, spanMs: Math.round(Number(p.spanMs ?? 400) * 1.5) }),
  // Too fast to read: the technique was given a slot it cannot fill.
  SUB_MINIMUM_DURATION: (p) => p,
  // UI travel over budget: halve it.
  UI_TRAVEL_TOO_FAR: (p) => ({
    ...p,
    ...(p.travelPx !== undefined ? { travelPx: Math.round(Number(p.travelPx) / 2) } : {}),
    ...(p.distancePx !== undefined ? { distancePx: Math.round(Number(p.distancePx) / 2) } : {}),
  }),
  // A UI stagger past the 60ms ceiling.
  UI_STAGGER_TOO_WIDE: (p) => ({ ...p, staggerMs: 35 }),
};

function applyRepairs(
  params: Record<string, unknown>,
  techniqueId: string,
  repairs: readonly string[],
): Record<string, unknown> {
  let out = params;
  for (const entry of repairs) {
    const [id, rule] = entry.split('::');
    if (id !== techniqueId) continue;
    const fix = rule && REPAIRS[rule];
    if (fix) out = fix(out);
  }
  return out;
}

/** Reduce a call batch to the flat scene description the design linter reads. */
export function sceneFromCalls(
  calls: readonly ToolCall[],
  frame: { width: number; height: number },
  surfaces: Record<string, string>,
): LintLayer[] {
  const byId = new Map<string, LintLayer>();
  for (const c of calls) {
    const a = c.args;
    switch (c.name) {
      case 'create_layer': {
        const id = String(a.id ?? '');
        if (!id) break;
        byId.set(id, {
          id,
          name: String(a.name ?? id),
          kind: String(a.kind ?? 'shape'),
          x: Number(a.x ?? 0),
          y: Number(a.y ?? 0),
          ...(a.width !== undefined ? { width: Number(a.width) } : {}),
          ...(a.height !== undefined ? { height: Number(a.height) } : {}),
          ...(a.fill !== undefined ? { fill: String(a.fill) } : {}),
          effects: [],
        });
        break;
      }
      case 'create_gradient': {
        const id = String(a.id ?? '__gradient');
        byId.set(id, {
          id, name: String(a.name ?? 'Gradient'), kind: 'solid',
          x: frame.width / 2, y: frame.height / 2, width: frame.width, height: frame.height,
          fill: Array.isArray(a.stops) ? String((a.stops as string[])[0]) : undefined,
          hasGradient: true, effects: ['gradient-ramp'],
        });
        break;
      }
      case 'add_surface_treatment': {
        const id = String(a.id ?? '__surface');
        byId.set(id, {
          id, name: 'Surface', kind: 'adjustment',
          x: frame.width / 2, y: frame.height / 2, width: frame.width, height: frame.height,
          isTreatment: true, effects: ['noise'],
        });
        break;
      }
      case 'create_media': {
        const id = String(a.id ?? '__media');
        byId.set(id, {
          id, name: 'Media', kind: 'image',
          x: Number(a.x ?? 0), y: Number(a.y ?? 0), isAsset: true, effects: [],
        });
        break;
      }
      case 'update_layer': {
        const l = byId.get(String(a.nodeId ?? ''));
        if (!l) break;
        if (a.fill !== undefined) l.fill = String(a.fill);
        if (a.width !== undefined) l.width = Number(a.width);
        if (a.height !== undefined) l.height = Number(a.height);
        if (a.fontSize !== undefined) l.fontSizePx = Number(a.fontSize);
        if (a.fontWeight !== undefined) l.fontWeight = Number(a.fontWeight);
        if (a.letterSpacing !== undefined) l.letterSpacingPx = Number(a.letterSpacing);
        if (a.cornerRadius !== undefined) l.cornerRadius = Number(a.cornerRadius);
        if (a.align !== undefined) l.align = String(a.align);
        if (a.backdropBlur !== undefined) l.effects = [...(l.effects ?? []), 'backdrop-blur'];
        break;
      }
      case 'add_effect': {
        const l = byId.get(String(a.nodeId ?? ''));
        if (l) l.effects = [...(l.effects ?? []), String(a.type ?? '')];
        break;
      }
      case 'set_shadow_stack': {
        const l = byId.get(String(a.nodeId ?? ''));
        if (l) l.shadowCount = Array.isArray(a.shadows) ? a.shadows.length : 0;
        break;
      }
      default:
        break;
    }
  }
  for (const [id, fill] of Object.entries(surfaces)) {
    const l = byId.get(id);
    if (l) l.onSurface = fill;
  }
  return [...byId.values()];
}

function metricsFor(pass: EmitPass, casting: Casting, beats: number): CastMetrics {
  const layerCount = new Set(
    pass.calls.filter((c) => c.name === 'create_layer').map((c) => String(c.args.id ?? '')),
  ).size;
  const techniqueIds = casting.motion.map((m) => m.techniqueId);
  const templateIds = casting.layouts.map((l) => l.templateId);
  const seeds = [...casting.motion.map((m) => m.seed), ...casting.layouts.map((l) => l.seed)];

  return {
    techniqueCoverage: layerCount > 0 ? pass.techniqueLayerIds.size / layerCount : 0,
    techniqueDiversity: techniqueIds.length ? new Set(techniqueIds).size / techniqueIds.length : 0,
    templateDiversity: beats > 0 ? new Set(templateIds).size / Math.max(1, templateIds.length) : 0,
    // Distinct seeds over total. Catches "always variant 0", which is how a
    // library with 20 techniques still produces 20 identical pieces.
    variantEntropy: seeds.length ? new Set(seeds).size / seeds.length : 0,
  };
}

/**
 * Run the pipeline's deterministic half: emit, lint, repair, re-emit.
 *
 * Returns the calls plus a report carrying every finding and every metric, so the
 * caller never has to re-derive them.
 */
export function emitAndValidate(o: EmitOptions): { calls: ToolCall[]; report: CastReport } {
  const pack = resolvePack(o.lookPackId, {
    ...(o.accent ? { accent: o.accent } : {}),
    ...(o.mode ? { mode: o.mode } : {}),
  });
  const maxRepairs = o.maxRepairs ?? 2;

  const repairs: string[] = [];
  let pass = emitPass(o, pack, repairs);
  let findings = lintAll(pass, o, pack);

  for (let round = 0; round < maxRepairs; round++) {
    const fixable = findings.filter((f) => f.severity === 'error' && f.rule in REPAIRS);
    if (!fixable.length) break;

    // Attribute each fixable error to the technique instance whose parameters can
    // change it. Without the attribution a repair would re-parameterise every
    // technique in the piece to fix one.
    let added = false;
    for (const f of fixable) {
      for (const inst of pass.instances) {
        const entry = `${inst.id}::${f.rule}`;
        if (!repairs.includes(entry)) {
          repairs.push(entry);
          added = true;
        }
      }
    }
    if (!added) break;

    pass = emitPass(o, pack, repairs);
    findings = lintAll(pass, o, pack);
  }

  const design = findings.filter((f) => f.source === 'design');
  const timing = findings.filter((f) => f.source === 'timing');
  const ui = findings.filter((f) => f.source === 'ui');

  return {
    calls: pass.calls,
    report: {
      lookPackId: o.lookPackId,
      beats: o.sequence.beats.length,
      techniques: o.casting.motion.map((m) => m.techniqueId),
      templates: o.casting.layouts.map((l) => l.templateId),
      seeds: [...o.casting.layouts.map((l) => l.seed), ...o.casting.motion.map((m) => m.seed)],
      metrics: metricsFor(pass, o.casting, o.sequence.beats.length),
      findings,
      designScore: computeDesignScore(design.map((f) => ({ rule: f.rule as never, severity: f.severity, nodeIds: [], message: f.message }))),
      craftScore: computeCraftScore(timing.map((f) => ({ rule: f.rule as never, severity: f.severity, nodeIds: [], message: f.message }))),
      uiMotionScore: computeUiScore(ui.map((f) => ({ rule: f.rule as never, severity: f.severity, nodeIds: [], message: f.message }))),
      repairs,
    },
  };
}

type Finding = CastReport['findings'][number];

/** All three linters, merged. */
function lintAll(pass: EmitPass, o: EmitOptions, pack: ResolvedPack): Finding[] {
  const out: Finding[] = [];
  const layers = sceneFromCalls(pass.calls, { width: o.width, height: o.height }, pass.surfaces);

  const designScene: LintScene = {
    grid: composeContext(pack, o.width, o.height).grid,
    background: pack.palette.bg,
    accent: pack.palette.accent,
    layers,
  };
  for (const f of lintDesign(designScene)) {
    out.push({ source: 'design', rule: f.rule, severity: f.severity, message: f.message });
  }

  for (const f of lintTiming({
    calls: pass.calls,
    fps: o.fps,
    durationMs: o.sequence.totalDurationMs,
    instances: pass.instances,
    beatBoundaries: o.sequence.boundaries,
    heroNodeIds: [...pass.heroLayerIds],
    uiNodeIds: [...pass.uiLayerIds],
  })) {
    out.push({ source: 'timing', rule: f.rule, severity: f.severity, message: f.message });
  }

  // The UI linter only runs when there IS product-vocabulary content. Running it
  // on a purely editorial piece would report correct editorial craft as a defect.
  if (pass.uiLayerIds.size) {
    for (const f of lintUiMotion({
      calls: pass.calls,
      fps: o.fps,
      uiNodeIds: [...pass.uiLayerIds],
      offFrameNodeIds: [...pass.offFrameLayerIds],
    })) {
      out.push({ source: 'ui', rule: f.rule, severity: f.severity, message: f.message });
    }
  }

  return out;
}
