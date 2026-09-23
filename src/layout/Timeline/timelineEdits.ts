/**
 * The timeline's document edits through the engine API (B3,
 * docs/B3_PATTERNS.md): bar moves / trims / slip / slide / roll / split /
 * ripple delete / nudges, the work area and the comp markers. Every function
 * here is ONE user action = ONE undo entry (`edit` batch), with the label the
 * legacy timeline command carried.
 *
 * ── Bars ─────────────────────────────────────────────────────────────
 * The engine addresses a LAYER (a scene node); the timeline hands us BAR ids
 * (`clip:<nodeId>`). Bar geometry is computed HERE with the timeline's own
 * `Clip` math on a CLONE — the same clamps the legacy commands applied (source
 * bounds, one-frame minimum, slide's one-frame abut tolerance, roll limits) —
 * and sent as absolute `setLayerTiming` patches. A client macro (ENGINE_API.md
 * §1 rule 7): the engine's own trim/slide/roll refuse what the legacy clamped,
 * so sending the clamped RESULT is what keeps the gesture identical.
 *
 * Display reads (the bars, the playhead, the marker list) stay direct until
 * B4's mirror.
 */

import type { Command, LayerTimingPatch, MarkerPatch } from '@motion/engine-api';
import { Clip, type ClipData, rollClips } from '@motion/timeline';
import { getTimelineController } from '@core/timeline/TimelineController';
import { framesToFlicks } from '@core/engine/time';
import { edit } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { useWorkspaceStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useAssetStore } from '@stores/assetStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isReplaceableLayer } from '@core/scene/replaceSourceDrop';
import { isLayer } from '@core/engine/doc';

// ── Reads (display facts a write needs) ──────────────────────────────

/** The composition the active tab shows — the one the timeline controller edits. */
export function activeCompId(): string {
  const ws = useWorkspaceStore.getState();
  const tab = ws.activeTabId ? ws.tabs[ws.activeTabId] : null;
  return tab?.compositionId || 'comp_default';
}

function fps(): number {
  return getTimelineController().timeline.getFrameRate().fps || 30;
}

interface Bar {
  /** The scene node = the API layer. */
  nodeId: string;
  clip: ClipData;
  locked: boolean;
}

/** A bar of the active comp by its timeline id (`clip:<nodeId>`). */
export function barOf(clipId: string): Bar | null {
  const layer = getTimelineController().timeline.getLayer(clipId);
  if (!layer || !layer.sourceId) return null;
  return { nodeId: layer.sourceId, clip: layer.clip.toJSON(), locked: layer.locked };
}

/** Every bar of a node, in start order. */
function barsOfNode(nodeId: string): Bar[] {
  return getTimelineController().getLayersForNode(nodeId).map((l) => ({
    nodeId, clip: l.clip.toJSON(), locked: l.locked,
  }));
}

// ── Geometry → setLayerTiming ─────────────────────────────────────────

/**
 * The absolute patch that turns a layer's bar into `to`: start time first
 * (source 0), then in and out — the order the engine applies them in.
 */
function timingPatch(nodeId: string, to: ClipData, rate: number): LayerTimingPatch {
  return {
    layer: nodeId,
    startTime: framesToFlicks(to.start - to.sourceIn, rate),
    inPoint: framesToFlicks(to.start, rate),
    outPoint: framesToFlicks(to.start + to.duration, rate),
  };
}

function sameClip(a: ClipData, b: ClipData): boolean {
  return a.start === b.start && a.duration === b.duration && a.sourceIn === b.sourceIn;
}

/**
 * Whether the API can express this geometry: at least a frame long. An
 * UNBOUNDED source's in point may sit before its source frame 0 (B3z: a shape
 * or text layer whose head was extended past where it began — AE allows it);
 * a footage bar cannot, and the `Clip` clamps never produce one.
 */
function expressible(to: ClipData): boolean {
  return to.duration >= 1;
}

/** One `setLayerTiming` for a set of (node, new geometry) — or null when nothing changes. */
function timingCommand(changes: ReadonlyArray<{ nodeId: string; from: ClipData; to: ClipData }>): Command | null {
  const rate = fps();
  const items = changes.filter((c) => !sameClip(c.from, c.to)).map((c) => timingPatch(c.nodeId, c.to, rate));
  return items.length > 0 ? { type: 'setLayerTiming', items } : null;
}

/**
 * Send a set of bar geometries as one entry. Returns false when the API cannot
 * express one of them (the caller keeps the legacy path for that edit).
 */
async function sendGeometry(
  label: string,
  changes: ReadonlyArray<{ nodeId: string; from: ClipData; to: ClipData }>,
): Promise<boolean> {
  if (changes.some((c) => !expressible(c.to) || !expressible(c.from))) return false;
  const cmd = timingCommand(changes);
  if (cmd) await edit(label, cmd);
  return true;
}

/** Whether a set of new geometries can all go through the API (see `expressible`). */
export function geometryExpressible(tos: ReadonlyArray<ClipData>): boolean {
  return tos.every(expressible);
}

// ── Bar gestures (committed on release, like the legacy commands) ─────

/** Move one bar so it starts at `startSeconds` (drag release). */
export function moveBar(clipId: string, startSeconds: number): Promise<void> {
  return moveBars([{ clipId, start: startSeconds }], 'Move Layer');
}

/**
 * Move several bars in ONE undo entry (a multi-row drag / stagger release).
 * Same clamp as `Timeline.setLayerStart`: whole frames, never before frame 0,
 * locked bars stay put.
 */
export async function moveBars(
  moves: ReadonlyArray<{ clipId: string; start: number }>,
  label = 'Move Layers',
): Promise<void> {
  const rate = fps();
  const changes: Array<{ nodeId: string; from: ClipData; to: ClipData }> = [];
  const seen = new Set<string>();
  for (const m of moves) {
    const bar = barOf(m.clipId);
    if (!bar || bar.locked || seen.has(bar.nodeId)) continue;
    seen.add(bar.nodeId);
    const start = Math.max(0, Math.round(m.start * rate));
    changes.push({ nodeId: bar.nodeId, from: bar.clip, to: { ...bar.clip, start } });
  }
  const name = changes.length === 1 && moves.length === 1 ? 'Move Layer' : label;
  await sendGeometry(name, changes);
}

/**
 * Trim one edge of a bar to `seconds` (drag release). `ripple` = Ctrl-drag:
 * later layers follow the length change (legacy Ripple Trim Layer / Start).
 * Returns false when the API cannot express the result (see `expressible`).
 */
export async function trimBar(
  clipId: string,
  edge: 'start' | 'end',
  seconds: number,
  opts: { ripple?: boolean } = {},
): Promise<boolean> {
  const bar = barOf(clipId);
  if (!bar || bar.locked) return true;
  const rate = fps();
  const frame = Math.round(seconds * rate);
  const trial = Clip.fromJSON(bar.clip);
  if (edge === 'start') trial.trimStart(frame);
  else trial.trimEnd(frame);
  const to = trial.toJSON();
  if (!expressible(to) || !expressible(bar.clip)) return false;
  if (!opts.ripple) {
    return sendGeometry('Trim Layer', [{ nodeId: bar.nodeId, from: bar.clip, to }]);
  }
  // Ripple: the length change moves every later layer (the engine's ripple
  // set is the comp's layers starting at/after this bar's old out point —
  // the legacy track). The legacy tail ripple only ever SHORTENED.
  const delta = bar.clip.duration - to.duration;
  if (edge === 'end' ? delta <= 0 : delta === 0) return true;
  const cmd: Command = edge === 'end'
    ? { type: 'trimLayers', layers: [bar.nodeId], edge: 'out', time: framesToFlicks(to.start + to.duration, rate), ripple: true }
    // Ripple on the head keeps the bar's start (the engine's keep-place trim).
    : { type: 'trimLayers', layers: [bar.nodeId], edge: 'in', time: framesToFlicks(bar.clip.start + (to.sourceIn - bar.clip.sourceIn), rate), ripple: true };
  await edit(edge === 'end' ? 'Ripple Trim Layer' : 'Ripple Trim Start', cmd);
  return true;
}

/** Slip: the source under a fixed bar, to `sourceInSec` (clamped like `Clip.slip`). */
export async function slipBar(clipId: string, sourceInSec: number): Promise<void> {
  const bar = barOf(clipId);
  if (!bar || bar.locked) return;
  const rate = fps();
  const trial = Clip.fromJSON(bar.clip);
  trial.slip(Math.round(sourceInSec * rate) - bar.clip.sourceIn);
  await sendGeometry('Slip Layer', [{ nodeId: bar.nodeId, from: bar.clip, to: trial.toJSON() }]);
}

/**
 * Slide: move the bar to `startSec`, trimming the neighbours it abuts (within
 * one frame) so the edit stays closed — `Timeline.slideLayer`'s rules, on
 * clones.
 */
export async function slideBar(clipId: string, startSec: number): Promise<void> {
  const bar = barOf(clipId);
  if (!bar || bar.locked) return;
  const c = getTimelineController();
  const layer = c.timeline.getLayer(clipId);
  const track = layer ? c.timeline.getTrack(layer.trackId) : undefined;
  if (!layer || !track) return;
  const rate = fps();
  const deltaFrames = Math.round(startSec * rate) - bar.clip.start;
  if (deltaFrames === 0) return;
  const minDuration = 1;
  const ordered = [...track.layers].sort((a, b) => a.clip.start - b.clip.start);
  const idx = ordered.findIndex((l) => l.id === clipId);
  const prev = ordered[idx - 1];
  const next = ordered[idx + 1];
  const clip = layer.clip;
  const abuts = (aEnd: number, bStart: number): boolean => Math.abs(aEnd - bStart) <= 1;
  const abutsPrev = !!prev && abuts(prev.clip.end, clip.start);
  const abutsNext = !!next && abuts(clip.end, next.clip.start);
  let d = deltaFrames;
  if (d > 0) {
    if (abutsNext && next) d = Math.min(d, next.clip.duration - minDuration);
    else if (next) d = Math.min(d, Math.max(0, next.clip.start - clip.end));
  } else {
    d = Math.max(d, -clip.start);
    if (abutsPrev && prev) d = Math.max(d, -(prev.clip.duration - minDuration));
    else if (prev) d = Math.max(d, -Math.max(0, clip.start - prev.clip.end));
  }
  d = Math.trunc(d);
  if (d === 0) return;
  const changes: Array<{ nodeId: string; from: ClipData; to: ClipData }> = [];
  const self = clip.clone();
  self.shift(d);
  changes.push({ nodeId: bar.nodeId, from: clip.toJSON(), to: self.toJSON() });
  if (abutsPrev && prev?.sourceId) {
    const p = prev.clip.clone();
    p.trimEnd(p.end + d, minDuration);
    changes.push({ nodeId: prev.sourceId, from: prev.clip.toJSON(), to: p.toJSON() });
  }
  if (abutsNext && next?.sourceId) {
    const n = next.clip.clone();
    n.trimStart(n.start + d, minDuration);
    changes.push({ nodeId: next.sourceId, from: next.clip.toJSON(), to: n.toJSON() });
  }
  await sendGeometry('Slide Layer', changes);
}

/**
 * Roll the cut between two bars by `deltaSeconds` (clamped by the roll limits,
 * like `rollClips`). Addressed by BAR ids: a split node has several bars and
 * only one pair meets at the cut.
 */
export async function rollBars(leftClipId: string, rightClipId: string, deltaSeconds: number): Promise<void> {
  const left = barOf(leftClipId);
  const right = barOf(rightClipId);
  if (!left || !right || left.locked || right.locked || left.nodeId === right.nodeId) return;
  const l = Clip.fromJSON(left.clip);
  const r = Clip.fromJSON(right.clip);
  const applied = rollClips(l, r, Math.round(deltaSeconds * fps()));
  if (applied === 0) return;
  await sendGeometry('Roll Edit', [
    { nodeId: left.nodeId, from: left.clip, to: l.toJSON() },
    { nodeId: right.nodeId, from: right.clip, to: r.toJSON() },
  ]);
}

// ── Split / ripple delete ─────────────────────────────────────────────

/** Nodes of the list that have a bar in the active comp, unlocked, deduplicated. */
function editableLayers(nodeIds: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of new Set(nodeIds)) {
    const bars = barsOfNode(id);
    if (bars.length > 0 && !bars.some((b) => b.locked)) out.push(id);
  }
  return out;
}

/**
 * Split layers at a comp time (whole frames). AE's Ctrl+Shift+D: the right
 * halves end up selected. Layers the time does not cut are left alone.
 */
export async function splitLayersAt(nodeIds: readonly string[], seconds: number, opts: { selectRight?: boolean } = {}): Promise<string[]> {
  const rate = fps();
  const frame = Math.round(seconds * rate);
  // Only the layers the frame actually cuts (at least a frame on each side),
  // so a selection that includes one it misses still splits the rest.
  const layers = editableLayers(nodeIds).filter((id) =>
    barsOfNode(id).some((b) => frame - b.clip.start >= 1 && b.clip.start + b.clip.duration - frame >= 1));
  if (layers.length === 0) return [];
  const res = await edit(layers.length === 1 ? 'Split Layer' : 'Split Layers', {
    type: 'splitLayers', layers, time: framesToFlicks(frame, rate),
  });
  if (!res.ok) return [];
  const right = (res.value[0] as { layers?: string[] } | undefined)?.layers ?? [];
  if (opts.selectRight && right.length > 0) useSelectionStore.getState().set(right);
  return right;
}

/** Split the selected layers at the playhead, leaving the right halves selected. */
export function splitSelectedAtPlayhead(nodeIds: readonly string[]): Promise<string[]> {
  const c = getTimelineController();
  return splitLayersAt(nodeIds, Math.round(c.timeline.currentFrame) / fps(), { selectRight: true });
}

/**
 * The clip menu's Ripple Trim In / Out to Playhead. A composition has ONE
 * track, so "later clips on the clip's track" is the comp's later layers —
 * exactly `trimLayers{ripple}`'s set (B3z; the legacy entries were the same
 * walk through the timeline controller).
 */
export function rippleTrimToPlayhead(clipId: string, edge: 'start' | 'end'): Promise<boolean> {
  return trimBar(clipId, edge, Math.round(getTimelineController().timeline.currentFrame) / fps(), { ripple: true });
}

/** Ripple Insert Gap at the playhead: every layer starting at/after it moves right (`insertGap`). */
export async function rippleInsertGapAtPlayhead(clipId: string, seconds = 1): Promise<void> {
  const bar = barOf(clipId);
  if (!bar) return;
  const rate = fps();
  const at = Math.round(getTimelineController().timeline.currentFrame);
  const d = Math.max(1, Math.round(seconds * rate));
  const c = getTimelineController();
  const layer = c.timeline.getLayer(clipId);
  // Nothing later on the track: nothing to push (the legacy edit recorded nothing either).
  if (!layer || !c.timeline.getTrack(layer.trackId)?.layers.some((l) => l.start >= at)) return;
  await edit('Ripple Insert Gap', { type: 'insertGap', comp: activeCompId(), time: framesToFlicks(at, rate), duration: framesToFlicks(d, rate) });
}

/** Ripple-delete layers (the gap closes). */
export async function rippleDeleteLayers(nodeIds: readonly string[]): Promise<void> {
  const layers = editableLayers(nodeIds);
  if (layers.length === 0) return;
  await edit(layers.length === 1 ? 'Ripple Delete Layer' : 'Ripple Delete Layers', { type: 'rippleDeleteLayers', layers });
}

// ── Keyboard bar edits (AE's [ ] Alt+[ Alt+] Alt+PageUp/Down) ─────────

function playheadFrame(): number {
  return Math.round(getTimelineController().timeline.currentFrame);
}

/** Every unlocked bar of the given nodes (the legacy commands walked bars). */
function barsOf(nodeIds: readonly string[]): Bar[] {
  return nodeIds.flatMap((id) => barsOfNode(id)).filter((b) => !b.locked);
}

/** One geometry per NODE: the API moves a layer, whose first bar anchors it. */
function perNode(bars: Bar[], to: (b: Bar) => ClipData | null): Array<{ nodeId: string; from: ClipData; to: ClipData }> {
  const out: Array<{ nodeId: string; from: ClipData; to: ClipData }> = [];
  const seen = new Set<string>();
  for (const b of bars) {
    if (seen.has(b.nodeId)) continue;
    const t = to(b);
    if (!t) continue;
    seen.add(b.nodeId);
    out.push({ nodeId: b.nodeId, from: b.clip, to: t });
  }
  return out;
}

/** Alt+[ — trim the in points of the selected layers to the playhead. */
export async function trimSelectedStartToPlayhead(nodeIds: readonly string[]): Promise<void> {
  const f = playheadFrame();
  const changes = perNode(barsOf(nodeIds), (b) => {
    if (!(f < b.clip.start + b.clip.duration)) return null;
    const c = Clip.fromJSON(b.clip);
    c.trimStart(f);
    return c.toJSON();
  });
  await sendGeometry('Trim Layer', changes);
}

/** Alt+] — trim the out points of the selected layers to the playhead. */
export async function trimSelectedEndToPlayhead(nodeIds: readonly string[]): Promise<void> {
  const f = playheadFrame();
  const changes = perNode(barsOf(nodeIds), (b) => {
    if (!(f > b.clip.start)) return null;
    const c = Clip.fromJSON(b.clip);
    c.trimEnd(f);
    return c.toJSON();
  });
  await sendGeometry('Trim Layer', changes);
}

/** `[` — move the selected layers so their in points sit on the playhead. */
export async function moveSelectedStartToPlayhead(nodeIds: readonly string[]): Promise<void> {
  const f = Math.max(0, playheadFrame());
  const changes = perNode(barsOf(nodeIds), (b) => ({ ...b.clip, start: f }));
  await sendGeometry('Move Layer', changes);
}

/** Floor for a move that may hang off the front of the comp (`allowNegative`). */
function negativeFloor(b: ClipData): number {
  return Math.min(0, 1 - Math.round(b.duration));
}

/** `]` — move the selected layers so their out points sit on the playhead. */
export async function moveSelectedEndToPlayhead(nodeIds: readonly string[]): Promise<void> {
  const f = playheadFrame();
  const changes = perNode(barsOf(nodeIds), (b) => ({ ...b.clip, start: Math.max(negativeFloor(b.clip), f - b.clip.duration) }));
  await sendGeometry('Move Layer Out Point', changes);
}

/**
 * Alt+PageUp/Down — nudge the selected layers by whole frames. Returns
 * whether any layer can move (synchronously, so the key handler can leave the
 * key alone when there is nothing to nudge).
 */
export function nudgeSelectedLayers(nodeIds: readonly string[], deltaFrames: number): boolean {
  const delta = Math.trunc(deltaFrames);
  if (delta === 0) return false;
  const changes = perNode(barsOf(nodeIds), (b) => {
    const start = Math.max(negativeFloor(b.clip), b.clip.start + delta);
    return start === b.clip.start ? null : { ...b.clip, start };
  });
  if (changes.length === 0) return false;
  void sendGeometry(changes.length > 1 ? 'Nudge Layers' : 'Nudge Layer', changes);
  return true;
}

// ── Layer ▸ Time (B3z) ────────────────────────────────────────────────

/**
 * AE's Time Stretch (the dialog, the clip menu's prompt): `timeStretchLayers`
 * — footage changes rate with the bar scaled about the Hold in Place frame, any
 * other layer bakes bar + keys + layer markers (negative = reversed). One entry.
 */
export async function timeStretchEdit(
  ids: readonly string[],
  percent: number,
  hold: 'in' | 'current' | 'out',
  seconds: number = getTimelineController().currentSeconds,
): Promise<boolean> {
  const layers = [...new Set(ids)].filter((id) => isLayer(id));
  if (layers.length === 0 || !Number.isFinite(percent) || percent === 0) return false;
  const res = await edit('Time Stretch', {
    type: 'timeStretchLayers',
    layers,
    stretch: percent / 100,
    hold: hold === 'in' ? 'inPoint' : hold === 'out' ? 'outPoint' : 'currentFrame',
    time: compTime(seconds),
  });
  return res.ok;
}

/** Unfreeze Frame: the frozen layers play their source again (`unfreezeLayers`). */
export async function unfreezeEdit(ids: readonly string[]): Promise<void> {
  const layers = [...new Set(ids)].filter((id) => isLayer(id));
  if (layers.length === 0) return;
  await edit('Unfreeze Frame', { type: 'unfreezeLayers', layers });
}

// ── Replace source (Alt-drop an asset on a lane) ──────────────────────

/**
 * Point an image/video layer at another footage item, size kept (transforms,
 * keyframes and effects stay) — the same rules and messages as
 * `replaceLayerSourceWithAsset`, the write through `replaceLayerSource`.
 */
export async function replaceSourceWithAsset(nodeId: string | null, assetId: string): Promise<boolean> {
  const notify = useUIStore.getState().notify;
  const asset = useAssetStore.getState().assets.find((a) => a.id === assetId);
  if (!nodeId || !isReplaceableLayer(nodeId)) {
    notify({ level: 'info', message: 'Alt-drop onto an image or video layer (or select one) to replace its source.', durationMs: 3200 });
    return false;
  }
  if (!asset || (asset.type !== 'image' && asset.type !== 'video')) {
    notify({ level: 'info', message: 'Only image and video footage can replace a layer’s source.', durationMs: 3200 });
    return false;
  }
  const name = defaultSceneGraph.getNode(nodeId)?.name ?? 'layer';
  const res = await edit(`Replace Source of “${name}”`, { type: 'replaceLayerSource', layer: nodeId, source: asset.id, keepSize: true });
  if (res.ok) notify({ level: 'info', message: `Replaced the source of “${name}” with “${asset.name}”.`, durationMs: 2600 });
  return res.ok;
}

// ── Work area ─────────────────────────────────────────────────────────

/** Set the work area in comp seconds (whole frames, inside the comp). */
export async function setWorkArea(startSeconds: number, endSeconds: number): Promise<void> {
  const c = getTimelineController();
  const rate = fps();
  const startF = Math.max(0, Math.round(startSeconds * rate));
  const endF = Math.min(c.timeline.duration, Math.round(endSeconds * rate));
  if (endF <= startF) return;
  await sendWorkArea(startF, endF);
}

/**
 * Shift+B — clear the work area: it covers the whole composition again and
 * follows its duration (`clearWorkArea`, B3z).
 */
export async function clearWorkArea(): Promise<void> {
  if (!getTimelineController().timeline.getRanges().workArea) return;
  await edit('Clear Work Area', { type: 'clearWorkArea', comp: activeCompId() });
}

async function sendWorkArea(startF: number, endF: number): Promise<void> {
  const rate = fps();
  const wa = getTimelineController().timeline.getRanges().workArea;
  if (wa && wa.start === startF && wa.duration === endF - startF) return;
  await edit('Work Area', {
    type: 'setWorkArea',
    comp: activeCompId(),
    range: { start: framesToFlicks(startF, rate), duration: framesToFlicks(endF - startF, rate) },
  });
}

/** B — the work-area in point at the playhead (at/past the out point MOVES the area). */
export async function setWorkAreaIn(): Promise<void> {
  const t = getTimelineController().timeline;
  const f = Math.round(t.currentFrame);
  const wa = t.getRanges().workArea;
  const last = t.duration;
  const outFrame = wa && f < wa.start + wa.duration ? wa.start + wa.duration : last;
  const start = Math.max(0, Math.min(f, last - 1));
  if (outFrame <= start) return;
  await sendWorkArea(start, outFrame);
}

/** N — the work-area out point at the playhead (at/before the in point pulls it back to 0). */
export async function setWorkAreaOut(): Promise<void> {
  const t = getTimelineController().timeline;
  const f = Math.round(t.currentFrame);
  const wa = t.getRanges().workArea;
  const inFrame = wa && f > wa.start ? wa.start : 0;
  const end = Math.min(t.duration, Math.max(f, inFrame + 1));
  if (end <= inFrame) return;
  await sendWorkArea(inFrame, end);
}

/** The active composition's duration (the timeline's duration field). */
export async function setCompDuration(seconds: number): Promise<void> {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return;
  await edit('Set Duration', {
    type: 'setCompositionSettings', comp: activeCompId(), patch: { duration: compTime(seconds) },
  });
}

// ── Markers ───────────────────────────────────────────────────────────

export interface MarkerEditPatch {
  label?: string;
  color?: string | null;
  comment?: string;
  time?: number;
  duration?: number;
}

/**
 * The engine patch for a marker edit, or null when nothing changes. Times are
 * comp seconds in; a LAYER marker is stored layer-relative (API: layer time),
 * so its time goes through `toLayerTime`, the inverse of what the lanes draw.
 * The colour is the stored swatch token (Marker/patch `color`, B3z).
 */
export function markerPatch(id: string, patch: MarkerEditPatch): MarkerPatch | null {
  const c = getTimelineController();
  const m = c.timeline.getMarker(id);
  if (!m) return null;
  const rate = c.timeline.getFrameRate().fps || 30;
  const out: MarkerPatch = { id };
  let changed = false;
  if (patch.label !== undefined && patch.label !== m.name) { out.name = patch.label; changed = true; }
  if (patch.comment !== undefined && patch.comment !== m.comment) { out.comment = patch.comment; changed = true; }
  // B3z: the colour is stored as given (a swatch token), '' = none.
  if (patch.color !== undefined && (m.color ?? null) !== patch.color) { out.color = patch.color ?? ''; changed = true; }
  if (patch.duration !== undefined) {
    const d = Math.max(0, Math.round(patch.duration * rate));
    if (d !== m.duration) { out.duration = framesToFlicks(d, rate); changed = true; }
  }
  if (patch.time !== undefined) {
    const owner = m.scope === 'layer' && m.ownerId ? c.timeline.getLayer(m.ownerId)?.sourceId : undefined;
    const seconds = owner ? c.toLayerTime(owner, patch.time) : patch.time;
    const f = Math.max(0, Math.round(seconds * rate));
    if (f !== m.frame) { out.time = framesToFlicks(f, rate); changed = true; }
  }
  return changed ? out : null;
}

/** A marker edit — one entry. Label: Move Marker for a pure move. */
export async function editMarker(id: string, patch: MarkerEditPatch): Promise<void> {
  const p = markerPatch(id, patch);
  if (!p) return;
  const moveOnly = patch.time !== undefined && patch.label === undefined;
  await edit(moveOnly ? 'Move Marker' : 'Edit Marker', { type: 'updateMarkers', patches: [p] });
}

export async function deleteMarkers(ids: readonly string[]): Promise<void> {
  const c = getTimelineController();
  const live = ids.filter((id) => !!c.timeline.getMarker(id));
  if (live.length === 0) return;
  await edit(live.length === 1 ? 'Remove Marker' : 'Remove Markers', { type: 'deleteMarkers', ids: [...live] });
}
