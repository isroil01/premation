/**
 * Smart Animate over the engine (B4 round 7): two compositions in, a
 * transition composition out, ONE history entry (an engine gesture around the
 * duplicate, the arrivals' paste and the keys).
 *
 *   1. `duplicateComposition` of the FROM board — the transition is built in a
 *      copy, never in either board;
 *   2. both boards described off the document mirror (name, kind, parent
 *      path, footage source, source text) and paired by `matchLayers`;
 *   3. each pair's tweenable values read with `trackValuesAt` (stored units)
 *      and planned (`planMatchedTracks`); leavers fade out, arrivals are
 *      copied in (`copyLayers` → `pasteLayers`, into the layer their parent
 *      matched) and fade in;
 *   4. the planned tracks written as `addKeyframes` (vector members of one
 *      property share a key; a member the plan does not move holds its value).
 *
 * One command per TARGET composition; the set follows the mirror's
 * compositions (`installSmartAnimateCommandSync`).
 */

import { asCommandId } from '@app-types/common';
import type { Command as EngineCommand, KeyframeInsert, LayerInfo, Value } from '@motion/engine-api';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { matchLayers, type LayerDescriptor } from '@core/animation/layerMatch';
import {
  planArrivalTracks,
  planDepartureTracks,
  planMatchedTracks,
  TWEENABLE_PROPS,
  type TweenOptions,
  type TweenTrack,
} from '@core/animation/smartAnimate';
import { PHYSICS } from '@core/animation/motionCurves';
import { uiKindOf } from '@core/mirror/layerKinds';
import { trackRefIn } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { mirrorTreeOf, trackValuesAt } from '@stores/trackValues';
import { activeCompIdNow } from '@hooks/useMirror';

/** How long a transition runs, per motion feel. */
const DURATION: Record<string, number> = { snappy: 0.45, smooth: 0.8, bouncy: 0.7 };
const MEDIA = new Set(['video', 'audio', 'image', 'svg']);

function textOf(v: Value | undefined): string | undefined {
  if (v?.kind === 'textDocument') return v.value.text;
  if (v?.kind === 'string') return v.value;
  return undefined;
}

/** A composition's layers for matching (depth first, never through a precomp). */
export async function describeMirrorComposition(compId: string): Promise<LayerDescriptor[]> {
  const m = documentMirror();
  const ids = m.comp(compId)?.layers ?? [];
  const out: LayerDescriptor[] = [];
  for (const id of ids) {
    const l = m.layer(id);
    if (!l) continue;
    const path: string[] = [];
    for (let p = l.parent, guard = 0; p && guard < 256; guard++) {
      const pl = m.layer(p);
      path.unshift(pl?.name ?? p);
      p = pl?.parent;
    }
    const kind = uiKindOf(l) ?? l.kind;
    const text = kind === 'text' ? textOf((await mirrorTreeOf(id))?.nodes.get('text/sourceText')?.value) : undefined;
    out.push({ id, name: l.name ?? '', kind, path, assetId: MEDIA.has(kind) && l.source ? l.source : undefined, text });
  }
  return out;
}

async function valuesOf(nodeId: string, atTime: number): Promise<Record<string, number | undefined>> {
  const vals = await trackValuesAt(nodeId, TWEENABLE_PROPS, atTime);
  const out: Record<string, number | undefined> = {};
  TWEENABLE_PROPS.forEach((p, i) => { out[p] = vals[i]; });
  return out;
}

/** `addKeyframes` inserts for one layer's planned tracks (stored units → API units, members of a vector share a key). */
async function keyInserts(nodeId: string, tracks: readonly TweenTrack[]): Promise<KeyframeInsert[]> {
  const tree = await mirrorTreeOf(nodeId);
  const byPath = new Map<string, { members: readonly string[]; factor: number; kind: Value['kind']; tracks: Map<string, TweenTrack> }>();
  for (const t of tracks) {
    const r = trackRefIn(tree, t.prop);
    if (!r) continue;
    const e = byPath.get(r.path) ?? { members: r.members, factor: r.factor, kind: r.info.value?.kind ?? 'scalar', tracks: new Map() };
    e.tracks.set(t.prop, t);
    byPath.set(r.path, e);
  }
  const out: KeyframeInsert[] = [];
  for (const [path, e] of byPath) {
    const times = [...new Set([...e.tracks.values()].flatMap((t) => t.keys.map((k) => k.t)))].sort((a, b) => a - b);
    for (const t of times) {
      const held = await trackValuesAt(nodeId, e.members, t);
      const nums = e.members.map((mem, i) => (e.tracks.get(mem)?.keys.find((k) => k.t === t)?.value ?? held[i] ?? 0) * e.factor);
      const bez = [...e.tracks.values()].map((tr) => tr.keys.find((k) => k.t === t)?.bezier).find((b) => b !== undefined);
      const value: Value = nums.length >= 3 && e.kind === 'vec3'
        ? { kind: 'vec3', value: { x: nums[0]!, y: nums[1]!, z: nums[2]! } }
        : nums.length >= 2 ? { kind: 'vec2', value: { x: nums[0]!, y: nums[1]! } } : { kind: 'scalar', value: nums[0] ?? 0 };
      out.push({
        prop: { layer: nodeId, path },
        time: compTime(t),
        value,
        easing: bez ? 'bezier' : 'easeOut',
        ...(bez ? { bezier: { x1: bez[0], y1: bez[1], x2: bez[2], y2: bez[3] } } : {}),
        spatialIn: [],
        spatialOut: [],
      });
    }
  }
  return out;
}

export interface SmartAnimateOutcome {
  compId: string;
  matched: number;
  departing: number;
  arriving: number;
  keyframes: number;
}

/** Build the transition composition from `fromId` to `toId` (one entry), or null when a board is missing / refused. */
export async function smartAnimateBetweenEdit(fromId: string, toId: string, opts: TweenOptions & { name?: string }): Promise<SmartAnimateOutcome | null> {
  const m = documentMirror();
  if (!m.comp(fromId) || !m.comp(toId)) return null;
  const client = engine();
  const g = await client.beginGesture('Smart Animate');
  if (!g.ok) return null;
  let commit = false;
  try {
    const dup = await client.execute({ type: 'duplicateComposition', comp: fromId, deep: false });
    if (!dup.ok) return null;
    const compId = (dup.value as { item: string }).item;
    await m.whenIdle();
    for (let i = 0; i < 4 && !m.comp(compId); i++) await new Promise((r) => setTimeout(r, 0));

    const working = await describeMirrorComposition(compId);
    const target = await describeMirrorComposition(toId);
    const match = matchLayers(working, target);
    const plans: Array<{ nodeId: string; tracks: TweenTrack[] }> = [];
    for (const pair of match.pairs) {
      const tracks = planMatchedTracks(await valuesOf(pair.from.id, opts.startTime), await valuesOf(pair.to.id, 0), opts);
      if (tracks.length > 0) plans.push({ nodeId: pair.from.id, tracks });
    }
    for (const leaving of match.onlyFrom) {
      const [op] = await trackValuesAt(leaving.id, ['opacity'], opts.startTime);
      const tracks = planDepartureTracks(op, opts);
      if (tracks.length > 0) plans.push({ nodeId: leaving.id, tracks });
    }

    // Arrivals: top-level ones only (a child comes along inside its parent), into what their parent matched.
    const matchedByTargetId = new Map(match.pairs.map((p) => [p.to.id, p.from.id]));
    const arrivingIds = new Set(match.onlyTo.map((a) => a.id));
    let arriving = 0;
    for (const incoming of match.onlyTo) {
      const src: LayerInfo | undefined = m.layer(incoming.id);
      if (src?.parent && arrivingIds.has(src.parent)) continue;
      const parent = src?.parent ? matchedByTargetId.get(src.parent) : undefined;
      const frag = await client.query({ type: 'copyLayers', layers: [incoming.id] });
      if (!frag.ok) continue;
      const pasted = await client.execute({ type: 'pasteLayers', comp: compId, fragment: frag.value, ...(parent ? { parent } : {}) } as EngineCommand);
      if (!pasted.ok) continue;
      const newId = (pasted.value as { layers?: string[] }).layers?.[0];
      if (!newId) continue;
      arriving++;
      const [op] = await trackValuesAt(incoming.id, ['opacity'], 0);
      const tracks = planArrivalTracks(op, opts);
      if (tracks.length > 0) plans.push({ nodeId: newId, tracks });
    }
    await m.whenIdle();

    const keys = (await Promise.all(plans.map((p) => keyInserts(p.nodeId, p.tracks)))).flat();
    if (keys.length > 0) {
      const res = await client.execute({ type: 'addKeyframes', keys });
      if (!res.ok) return null;
    }
    if (opts.name) await client.execute({ type: 'renameItem', item: compId, name: opts.name });
    commit = true;
    return { compId, matched: match.pairs.length, departing: match.onlyFrom.length, arriving, keyframes: keys.length };
  } finally {
    await client.endGesture(g.value.gesture, commit);
  }
}

async function run(toId: string): Promise<void> {
  const from = activeCompIdNow();
  if (!from) return;
  const m = documentMirror();
  const fromName = m.comp(from)?.settings.name ?? 'A';
  const toName = m.comp(toId)?.settings.name ?? 'B';
  const feel = usePreferenceStore.getState().motionFeel ?? 'smooth';
  const result = await smartAnimateBetweenEdit(from, toId, {
    startTime: 0,
    durationSec: DURATION[feel] ?? 0.8,
    curve: feel === 'bouncy' ? PHYSICS.overshoot : PHYSICS.softOut,
    name: `${fromName} → ${toName}`,
  });
  const ui = useUIStore.getState();
  if (!result) {
    ui.notify({ level: 'warning', message: 'Could not build the transition — one of the compositions is missing.', durationMs: 5000 });
    return;
  }
  // The counts are the explanation: nothing matched means the layer NAMES did not line up.
  const parts = [`${result.matched} matched`];
  if (result.departing > 0) parts.push(`${result.departing} leaving`);
  if (result.arriving > 0) parts.push(`${result.arriving} arriving`);
  ui.notify({
    level: result.matched === 0 ? 'warning' : 'success',
    message: `“${fromName} → ${toName}”: ${parts.join(', ')}, ${result.keyframes} keyframes.`
      + (result.matched === 0 ? ' Nothing matched — layers pair up by name, so give the elements the same names in both boards.' : ''),
    durationMs: 7000,
  });
}

/**
 * Compositions that could be a target: every composition but the active one
 * and an untouched placeholder (pristine AND layerless).
 */
export function transitionTargets(): Array<{ id: string; name: string }> {
  const m = documentMirror();
  const current = activeCompIdNow();
  return m.compIds
    .filter((id) => {
      const c = m.comp(id);
      if (!c || id === current || m.layer(id)) return false;
      return !c.settings.pristine || c.layers.length > 0;
    })
    .map((id) => ({ id, name: m.comp(id)!.settings.name }));
}

/** Every Smart Animate command, for `buildStaticCommands`. */
export function buildSmartAnimateCommands(): ReadonlyArray<Command> {
  return transitionTargets().map((target) => ({
    id: asCommandId(`comp.smartAnimate.${target.id}`),
    label: `Smart Animate to “${target.name}”`,
    description: 'Build a transition composition from this board to that one: matching layers move, the rest fade. Layers pair up by name.',
    icon: 'sparkles',
    enabled: () => activeCompIdNow() !== undefined,
    execute: () => { void run(target.id); },
  }));
}

let registered = new Set<string>();

/** Bring the registry in line with the compositions that exist now. */
export function syncSmartAnimateCommands(): void {
  const commands = buildSmartAnimateCommands();
  const wanted = new Set(commands.map((c) => String(c.id)));
  const registry = getCommandRegistry();
  for (const id of registered) if (!wanted.has(id)) registry.unregister(asCommandId(id));
  for (const command of commands) registry.register(command);
  registered = wanted;
}

/** Keep the Smart Animate commands in step with the compositions (the mirror) and the active one. Returns the disposer. */
export function installSmartAnimateCommandSync(): () => void {
  let lastKey = '';
  const refresh = (): void => {
    const m = documentMirror();
    const key = `${m.compIds.map((id) => `${id}:${m.comp(id)?.settings.name ?? ''}:${m.comp(id)?.layers.length ?? 0}`).join(',')}|${activeCompIdNow() ?? ''}`;
    if (key === lastKey) return;
    lastKey = key;
    syncSmartAnimateCommands();
  };
  const offMirror = documentMirror().subscribe(['comps'], refresh);
  const offTab = onActiveTabChange(refresh);
  refresh();
  return () => { offMirror(); offTab(); };
}

function onActiveTabChange(cb: () => void): () => void {
  let last = useProjectStore.getState().activeTabId;
  return useProjectStore.subscribe((s) => {
    if (s.activeTabId === last) return;
    last = s.activeTabId;
    cb();
  });
}
