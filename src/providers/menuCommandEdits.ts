/**
 * The Animation menu's keyframe assistants that build or rewrite keys, through
 * the engine API (B3z, docs/B3_PATTERNS.md §6 — client macros: the plan is
 * computed in the editor, the result goes out as ONE batch, one undo entry).
 *
 *   exponentialScaleEdit   Exponential Scale — `setKeyframes` on Scale
 *   expressionBakeEdit     Convert Expression to Keyframes — the API command
 *   audioSliderNullEdit    Convert Audio to Keyframes — the AE "Audio
 *                          Amplitude" null, built off-document, one pasteLayers
 */

import type { Command, Keyframe as ApiKeyframe } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { compOfLayer, isLayer } from '@core/engine/doc';
import { compFps } from '@core/engine/time';
import { catalogFor, keyTimeToFlicks, numbersOf, readKeys, vectorValue } from '@core/engine/props';
import {
  planExponentialScale,
  refuseExponentialScale,
  type ExpScaleRange,
  type ExpScaleResult,
} from '@core/animation/exponentialScale';
import { eligibleExpressionProps, type BakeResult } from '@core/animation/convertExpressionToKeyframes';
import { applyAudioSliderNull, ensureAudioBuffer, type AudioSliderNullResult } from '@core/audio/audioKeyframes';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';
import { expressionTarget } from '@layout/Inspector/modifierEdits';

// ── Exponential Scale ─────────────────────────────────────────────────

/** A key of a keyframe assistant's result (a new id; linear — the samples ARE the curve). */
function linearKey(time: number, value: ApiKeyframe['value']): ApiKeyframe {
  return {
    id: '', time, value, easing: 'linear', continuous: false, roving: false,
    spatialInterp: 'legacy', spatialIn: [], spatialOut: [], label: 0, dims: [],
  };
}

/**
 * AE's Exponential Scale: the Scale property rebuilt from its first → last key
 * as a geometric ramp, one key per frame (the legacy assistant's plan,
 * `planExponentialScale`). The API keys Scale as ONE vector, so every
 * dimension ramps over the property's own span, from its value at the first
 * key to its value at the last (a dimension that does not change stays
 * constant). A dimension whose ramp would pass through 0 refuses the whole
 * command. ONE `setKeyframes` on the property, one undo entry.
 */
export async function exponentialScaleEdit(nodeId: string): Promise<ExpScaleResult> {
  const none = new Map<string, number>();
  const b = isLayer(nodeId) ? catalogFor(nodeId).byMember.get('scaleX') : undefined;
  if (!b || !b.animatable) return { written: none, refusal: 'needs-two-keyframes' };
  const have = readKeys(nodeId, b);
  const first = have[0];
  const last = have[have.length - 1];
  if (!first || !last || have.length < 2) return { written: none, refusal: 'needs-two-keyframes' };
  const from = numbersOf(b, first.value);
  const to = numbersOf(b, last.value);
  // API values (percent): the ramp is a ratio, so the unit does not matter.
  const ranges: ExpScaleRange[] = b.members.map((_m, i) => ({ t0: first.t, t1: last.t, s0: from[i] ?? 100, s1: to[i] ?? 100 }));
  for (const r of ranges) {
    const refusal = refuseExponentialScale(r);
    if (refusal) return { written: none, refusal };
  }
  const comp = compOfLayer(nodeId);
  const fps = comp ? compFps(comp) : 30;
  // Same span and fps for every dimension, so the plans share their times.
  const plans = ranges.map((r) => planExponentialScale(r, fps));
  const lead = plans[0] ?? [];
  const keys = lead.map((k, j) => linearKey(
    keyTimeToFlicks(nodeId, b, k.t),
    vectorValue(b.valueType, plans.map((p, i) => p[j]?.value ?? ranges[i]!.s1)),
  ));
  const res = await edit('Exponential scale', { type: 'setKeyframes', prop: { layer: nodeId, path: b.path }, keys });
  if (!res.ok) return { written: none, refusal: null };
  // The notice counts the dimensions that ramp (every dimension when none changes).
  const moving = b.members.filter((_m, i) => ranges[i]!.s0 !== ranges[i]!.s1);
  return { written: new Map((moving.length > 0 ? moving : b.members).map((m) => [m, keys.length] as const)), refusal: null };
}

// ── Convert Expression to Keyframes ───────────────────────────────────

/**
 * AE's Convert Expression to Keyframes over every property of the layer with
 * an ENABLED expression (`eligibleExpressionProps` — the command's enabled
 * gate): one `convertExpressionToKeyframes` per property (per dimension for a
 * vector whose dimensions carry their own expressions) — every frame over the
 * layer's in → out, the expression disabled, not deleted — as ONE entry.
 * `written` counts the keys per legacy track.
 */
export async function expressionBakeEdit(nodeId: string): Promise<BakeResult> {
  const targets = eligibleExpressionProps(nodeId);
  if (targets.length === 0) {
    // Why not — asked of the engine: a property with an expression that is switched off.
    const tree = isLayer(nodeId) ? await engine().query({ type: 'getPropertyTree', layer: nodeId, path: '', depth: 0 }) : null;
    const anyExpression = !!tree?.ok && tree.value.nodes.some((n) => n.kind === 'property' && n.expression.trim() !== '');
    return { written: new Map(), refusal: anyExpression ? 'expression-disabled' : 'no-expression' };
  }
  const tracks: string[] = [];
  const cmds: Command[] = [];
  const sent = new Set<string>();
  for (const track of targets) {
    const t = expressionTarget(nodeId, track);
    if (!t) continue;
    const key = `${t.prop.path}#${t.member ?? ''}`;
    if (sent.has(key)) continue;
    sent.add(key);
    tracks.push(track);
    cmds.push({ type: 'convertExpressionToKeyframes', prop: t.prop, step: 0, ...(t.member !== undefined ? { member: t.member } : {}) });
  }
  if (cmds.length === 0) return { written: new Map(), refusal: 'no-expression' };
  const res = await edit('Convert Expression to Keyframes', cmds);
  if (!res.ok) return { written: new Map(), refusal: null };
  const written = new Map<string, number>();
  res.value.forEach((r, i) => {
    const n = (r as { ids?: string[] } | undefined)?.ids?.length ?? 0;
    if (n > 0) written.set(tracks[i]!, n);
  });
  return { written, refusal: written.size === 0 ? 'empty-range' : null };
}

// ── Convert Audio to Keyframes ────────────────────────────────────────

/**
 * AE's Convert Audio to Keyframes: an "Audio Amplitude" null carrying Both
 * Channels / Left / Right slider controls keyed from the audio's envelope
 * (`applyAudioSliderNull`), BUILT off-document into the active composition and
 * sent as ONE `pasteLayers` — the null, its controls and their keys are all
 * part of the new layer. The null is selected.
 */
export async function audioSliderNullEdit(audioId: string): Promise<AudioSliderNullResult> {
  const buffer = await ensureAudioBuffer(audioId);
  if (!buffer) return { nodeId: null, written: new Map() };
  // The null goes where the legacy helper put it: the active composition (a
  // group open in its own tab is a layer of its composition).
  const comp = activeInsertTarget()?.comp;
  if (!comp) return { nodeId: null, written: new Map() };
  let made: AudioSliderNullResult | null = null;
  const ids = await insertBuiltLayers('Convert audio to keyframes', comp, () => {
    made = applyAudioSliderNull(audioId, buffer);
  });
  const r = made as AudioSliderNullResult | null;
  if (!ids || ids.length === 0 || !r) return { nodeId: null, written: new Map() };
  return { nodeId: ids[0]!, written: r.written };
}
