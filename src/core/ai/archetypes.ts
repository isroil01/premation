/**
 * Entrance archetypes for the compose recipes — the AI's half.
 *
 * The keyframe craft itself (the six archetypes, the weighted pick, the
 * non-uniform stagger) moved to `core/animation/entranceArchetypes.ts` when
 * the editor grew its own choreography commands: it is pure, and two very
 * different callers now need it. Re-exported below so every `from
 * './archetypes'` in the recipe layer still resolves.
 *
 * What stays here is the part that is genuinely AI-shaped: the per-RUN
 * variation seed (module state, set once per generation so a prompt run is
 * reproducible), and `applyEntrance` — the impure applicator that writes
 * through a `ToolContext` and installs effects and text animators.
 */

import type { ToolContext } from '@motion/ai-tools';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { set3DEnabled } from '@core/scene/threeD';
import { addTextAnimator, updateAnimator, readAnimatorData } from '@core/text/textAnimators';
import type { MotionStyle } from './design';
import {
  blurResolvePoints,
  charCascadePoints,
  entranceTrackPlans,
  hash32,
  pickEntranceArchetype,
  type EntranceArchetype,
  type EntranceParams,
  type EntranceRole,
  type EntranceTrackPlan,
} from '@core/animation/entranceArchetypes';

export {
  ENTRANCE_ARCHETYPES,
  blurResolvePoints,
  charCascadePoints,
  entranceTrackPlans,
  hash32,
  hashFrac,
  nonUniformStagger,
  pickEntranceArchetype,
  type EntranceArchetype,
  type EntranceParams,
  type EntrancePoint,
  type EntranceRole,
  type EntranceTrackPlan,
} from '@core/animation/entranceArchetypes';

// ── Deterministic per-run variation ────────────────────────────────

let runSeed = 1;

/** Set the variation seed for this AI run (called from createToolContext). */
export function setEntranceSeed(seed: number): void {
  runSeed = seed >>> 0 || 1;
}

export function currentEntranceSeed(): number {
  return runSeed;
}

// ── Impure applicator ──────────────────────────────────────────────

export interface ApplyEntranceOptions {
  /** Explicit archetype (from the tool's `entrance` param). Omit = varied auto-pick. */
  archetype?: EntranceArchetype;
  role?: EntranceRole;
  /** Sibling index — feeds the pick hash so a row varies deliberately. */
  index?: number;
  /** Accent multiplier on travel (deliberate asymmetry: one element pops more). */
  travelScale?: number;
}

/** Coerce a requested archetype away from targets it cannot work on. */
function resolveArchetype(ctx: ToolContext, id: string, opts: ApplyEntranceOptions, s: MotionStyle): EntranceArchetype {
  const role = opts.role ?? 'generic';
  let arch =
    opts.archetype ??
    pickEntranceArchetype({ role, styleName: s.name, seed: runSeed, index: opts.index ?? 0 });
  const isText = ctx.scene.get(id)?.kind === 'text';
  if (arch === 'char_cascade' && !isText) arch = 'scale_pop';
  return arch;
}

function setKfs(ctx: ToolContext, id: string, plans: EntranceTrackPlan[]): void {
  for (const plan of plans) {
    for (const pt of plan.points) {
      const lt = ctx.time.toLayerTime(id, pt.t);
      ctx.anim.setKeyframe(id, plan.prop, lt, pt.value, pt.easing ?? 'easeOut');
      if (pt.easing === 'bezier' && pt.bezier) ctx.anim.setBezier(id, plan.prop, lt, pt.bezier);
    }
  }
}

/**
 * Apply an entrance to a layer. Replaces the old always-rise `entranceRise3D`:
 * same contract (start + style + resting centre), but the archetype varies.
 */
export function applyEntrance(
  ctx: ToolContext,
  id: string,
  start: number,
  s: MotionStyle,
  cy: number,
  opts: ApplyEntranceOptions = {},
): EntranceArchetype {
  const arch = resolveArchetype(ctx, id, opts, s);
  const node = ctx.scene.get(id);
  const cx = node?.x ?? 0;
  const travelPx = s.travelPx * (opts.travelScale ?? 1);
  const direction = (['left', 'right', 'up', 'down'] as const)[
    hash32(runSeed, 'dir', opts.index ?? 0, id) % 4
  ];
  const params: EntranceParams = { start, dur: s.entranceDur, travelPx, cy, cx, curve: s.entranceCurve, direction };

  if (arch === 'rise') set3DEnabled(id, true);
  setKfs(ctx, id, entranceTrackPlans(arch, params));

  if (arch === 'blur_resolve') {
    const fx = ctx.scene.addEffect(id, 'blur');
    if (fx) {
      setKfs(ctx, id, [{ prop: `effect.${fx}`, points: blurResolvePoints(start, s.entranceDur) }]);
    }
  }

  if (arch === 'char_cascade') {
    const raw = defaultSceneGraph.getNode(id);
    if (raw) {
      addTextAnimator(id);
      const idx = readAnimatorData(raw).length - 1;
      // Covered glyphs are invisible and offset down; sweeping the selector
      // window off the string (offset 0 → 100) reveals characters left→right.
      updateAnimator(id, idx, { basedOn: 'characters', shape: 'rampUp', start: 0, end: 100, opacity: 0, y: 16, scale: 88 });
      setKfs(ctx, id, [
        { prop: `ta.${idx}.offset`, points: charCascadePoints(start, Math.max(0.4, s.entranceDur * 1.1)) },
      ]);
    }
  }

  return arch;
}
