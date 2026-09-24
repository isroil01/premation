/**
 * Track Motion results through the engine API (B3z, docs/B3_PATTERNS.md).
 *
 * The tracker's analysis (point tracks, the planar / SfM camera solves) runs
 * in the editor; `core/tracking/applyTrack.ts` turns a result into a PLAN —
 * keys per legacy track at composition seconds. This module sends a plan as
 * ONE undo entry of existing primitives (ENGINE_API.md §1 rule 7):
 *
 *   - member tracks of one API property go out together (x + y = one
 *     `transform/position` key; members the plan does not key keep their value
 *     at that time — ENGINE_API.md §3.3), in AE units (`scale` is percent);
 *   - each property is spliced the Motion Sketch way: keys inside the tracked
 *     span replaced, keys outside kept (keySpliceEdits);
 *   - an effect plan (Corner Pin, Mesh Warp) keys the target's first effect of
 *     that type, `addEffect` first when it has none;
 *   - Create Null & Apply / a camera solve's first run create the layer
 *     (`createLayer`) in the same entry, then key it.
 */

import type { Command, CommandResult, PropRef } from '@motion/engine-api';
import { compOfLayer, apiParentOf, isLayer } from '@core/engine/doc';
import { propRefForTrack, values, valueOfNumbers } from '@core/engine/propRefs';
import { apiUnitFactor } from '@core/engine/props';
import { documentMirror } from '@stores/documentMirror';
import { findSolveCameraIn, firstEffectOfType, memberStoredAt, nextTrackedNullNameIn } from '@core/mirror/tracking';
import { effectPropPath } from '@core/effects/effects';
import {
  canSolveCamera,
  planOntoNull,
  planPlanarCameraSolve,
  planSfmCameraSolve,
  trackedNullSeed,
  type CameraSolvePlan,
  type NullTrackMode,
  type PlanarCameraSolveOptions,
  type PlanarCameraSolveResult,
  type TrackPlan,
} from '@core/tracking/applyTrack';
import type { CompTrackSample } from '@core/tracking/trackVideoLayer';
import { inOneEntry, spliceSteps, type EntryStep, type KeySplice } from '../keySpliceEdits';

/** Why a plan cannot be sent: a track the engine does not address on the layer. */
class NotAddressable extends Error {}

/**
 * A plan's writes as splices of API properties (`effectId` = the effect an
 * effect plan keys). Throws when a track is not addressable.
 */
export function planSplices(plan: TrackPlan, effectId?: string): KeySplice[] {
  const groups = new Map<string, { ref: PropRef; members: readonly string[]; valueType: Parameters<typeof valueOfNumbers>[0]; byMember: Map<string, Map<number, number>> }>();
  for (const w of plan.writes) {
    if (w.keys.length === 0) continue;
    const track = effectId ? effectPropPath(effectId, w.track) : w.track;
    const r = propRefForTrack(plan.layer, track);
    if (!r) throw new NotAddressable(`'${track}' cannot be keyed on this layer`);
    let g = groups.get(r.ref.path);
    if (!g) {
      g = { ref: r.ref, members: r.members, valueType: r.valueType, byMember: new Map() };
      groups.set(r.ref.path, g);
    }
    const m = new Map<number, number>();
    for (const k of w.keys) m.set(k.compTime, k.value);
    g.byMember.set(track, m);
  }
  const out: KeySplice[] = [];
  // Members the plan does not key keep what they hold at that time — read
  // from the mirror (current once the entry's earlier steps have answered).
  const m = documentMirror();
  for (const g of groups.values()) {
    const times = [...new Set([...g.byMember.values()].flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
    out.push({
      prop: g.ref,
      replace: 'span',
      axisTrack: g.members[0],
      keys: times.map((seconds) => ({
        seconds,
        value: valueOfNumbers(g.valueType, g.members.map((member) => {
          const given = g.byMember.get(member)?.get(seconds);
          const stored = given ?? memberStoredAt(m, plan.layer, member, seconds);
          return stored * apiUnitFactor(member);
        })),
      })),
    });
  }
  return out;
}

/** The steps that key `plan` (adding its effect first when the target has none); a null plan keys nothing. */
function planSteps(plan: TrackPlan | ((earlier: ReadonlyArray<CommandResult[]>) => TrackPlan | null)): EntryStep[] {
  let current: TrackPlan | null = null;
  let effectStep = -1;
  const steps: EntryStep[] = [
    (earlier) => {
      const p = typeof plan === 'function' ? plan(earlier) : plan;
      current = p;
      effectStep = earlier.length;
      if (!p?.effectType || firstEffectOfType(documentMirror(), p.layer, p.effectType) !== undefined) return [];
      return [{ type: 'addEffect', layers: [p.layer], effect: p.effectType, params: [] }];
    },
    ...spliceSteps((earlier) => {
      const p: TrackPlan | null = current;
      if (!p) return [];
      if (!p.effectType) return planSplices(p);
      const added = earlier[effectStep]?.find((r) => r.type === 'addEffect') as { groups?: string[] } | undefined;
      const fromAdd = added?.groups?.[0]?.split('/')[1];
      const id = fromAdd ?? firstEffectOfType(documentMirror(), p.layer, p.effectType);
      if (!id) throw new Error(`No ${p.effectType} effect to key.`);
      return planSplices(p, id);
    }),
  ];
  return steps;
}

/** Send a plan as ONE undo entry (its own label). Resolves to its count, 0 when refused. */
export async function applyTrackPlanEdit(plan: TrackPlan | null): Promise<number> {
  if (!plan || !isLayer(plan.layer)) return 0;
  return (await inOneEntry(plan.label, planSteps(plan))) ? plan.count : 0;
}

export interface NullTrackInput {
  videoNodeId: string;
  mode: NullTrackMode;
  samples: readonly CompTrackSample[];
  tracks: readonly (readonly CompTrackSample[])[];
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
}

/** The `createLayer` of a tracked null beside the video, seeded on the first sample. */
function createNullCommand(input: NullTrackInput): Command | null {
  const comp = compOfLayer(input.videoNodeId);
  // Engine-side until C-phase: the seed is the first sample mapped through the
  // video's and its parent's WORLD transforms (layerSpaceAt).
  const seed = trackedNullSeed(input);
  if (!comp || !seed) return null;
  const parent = apiParentOf(input.videoNodeId);
  return {
    type: 'createLayer', comp, kind: 'null', name: nextTrackedNullNameIn(documentMirror()),
    ...(parent ? { parent } : {}),
    init: [{ path: 'transform/position', value: values.vec2(seed.x, seed.y) }],
  };
}

const createdLayer = (earlier: ReadonlyArray<CommandResult[]>, step: number): string | null =>
  (earlier[step]?.find((r) => r.type === 'createLayer') as { layer?: string } | undefined)?.layer ?? null;

/**
 * AE's Create Null & Apply: a null beside the video, seeded on the first
 * sample, keyed with the track — ONE entry ("Create Null & Apply Track").
 */
export async function createNullAndApplyEdit(input: NullTrackInput): Promise<{ nullId: string; keyframes: number } | null> {
  const create = createNullCommand(input);
  if (!create) return null;
  let nullId: string | null = null;
  let count = 0;
  const res = await inOneEntry('Create Null & Apply Track', [
    () => [create],
    ...planSteps((earlier) => {
      nullId = createdLayer(earlier, 0);
      const plan = nullId ? planOntoNull(nullId, input) : null;
      count = plan?.count ?? 0;
      return plan;
    }),
  ]);
  return res && nullId ? { nullId, keyframes: count } : null;
}

/** One tracked null per four tracks (a plane each), ONE entry. */
export async function createNullsForPlanesEdit(input: Omit<NullTrackInput, 'mode' | 'samples'>): Promise<{ nullIds: string[]; keyframes: number }> {
  const planeCount = Math.floor(input.tracks.length / 4);
  const steps: EntryStep[] = [];
  const nullIds: string[] = [];
  let keyframes = 0;
  for (let p = 0; p < planeCount; p++) {
    const slice = input.tracks.slice(p * 4, p * 4 + 4);
    const plane: NullTrackInput = { ...input, mode: 'corner', samples: slice[0] ?? [], tracks: slice };
    let createStep = -1;
    steps.push((earlier) => {
      createStep = earlier.length;
      const c = createNullCommand(plane);
      return c ? [c] : [];
    });
    steps.push(...planSteps((earlier) => {
      const id = createdLayer(earlier, createStep);
      if (!id) return null;
      nullIds.push(id);
      const plan = planOntoNull(id, plane);
      keyframes += plan?.count ?? 0;
      return plan;
    }));
  }
  if (steps.length === 0) return { nullIds: [], keyframes: 0 };
  const res = await inOneEntry('Create Nulls for Planes', steps);
  return res ? { nullIds, keyframes } : { nullIds: [], keyframes: 0 };
}

/**
 * The 3D Camera Tracker: the SfM solve (planar when it cannot run) keyed onto
 * the composition's solve camera — made (a one-node camera tagged
 * `camera/trackerSolve`) on the first run — as ONE entry.
 */
export async function solveCameraEdit(opts: PlanarCameraSolveOptions): Promise<PlanarCameraSolveResult | null> {
  if (!canSolveCamera(opts)) return null;
  const comp = compOfLayer(opts.videoNodeId);
  if (!comp) return null;
  const existing = findSolveCameraIn(documentMirror(), opts.comp.rootId);
  let solved: CameraSolvePlan | null = null;
  const steps: EntryStep[] = [
    () => (existing ? [] : [{
      type: 'createLayer', comp, kind: 'camera', name: '3D Camera Tracker',
      init: [{ path: 'camera/trackerSolve', value: values.bool(true) }],
    } as Command]),
    ...planSteps((earlier) => {
      const camId = existing ?? createdLayer(earlier, 0);
      if (!camId) return null;
      // Engine-side until C-phase: the SfM / planar solves (they read the solve camera's lens themselves).
      solved = planSfmCameraSolve(opts, camId) ?? planPlanarCameraSolve(opts, camId);
      return solved?.plan ?? null;
    }),
  ];
  const res = await inOneEntry('Apply 3D Camera Tracker', steps);
  return res ? (solved as CameraSolvePlan | null)?.result ?? null : null;
}
