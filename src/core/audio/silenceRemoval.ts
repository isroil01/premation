/**
 * Silence removal — "cut the dead air out of this take", as one edit.
 *
 * The pieces to do this by hand have all been here for a while: split a bar at
 * the playhead, delete a bar, slide the survivors left. Doing it by hand on a
 * ten-minute talking-head take is forty cuts, eighty drags, and a soundtrack
 * that ends up one frame out of sync with the picture somewhere in the middle.
 * This is that operation with the arithmetic done once and correctly.
 *
 * ## Two shapes, deliberately separated
 *
 * {@link detectSilences} is PURE: samples in, source-second ranges out. No
 * scene, no engine, no Web Audio. That is what lets the dialog show a real
 * "will remove N gaps totalling S s" readout computed by the same code that
 * does the cut, rather than by a cheaper estimate that agrees on the easy cases
 * and disagrees exactly where the parameters are doing something interesting.
 *
 * {@link removeSilences} is the scene half: map source seconds onto comp time
 * through each layer's clip bars, cut, delete, close the gap.
 *
 * ## Why the ripple is done by hand
 *
 * `TimelineController.deleteLayerForClip({ ripple: true })` shifts every later
 * bar **on the same track**, and in this app a composition is ONE track — every
 * layer of the comp shares it (`compositionTrackIds`). So the built-in ripple
 * would drag unrelated layers left, and doing it once per paired layer would
 * shift the shared neighbours twice. What this module wants is narrower: close
 * the gap on the layers being cut and nothing else. So it deletes without
 * ripple and moves the survivors itself with `setClipStart`.
 *
 * ## Why intervals are processed last-first
 *
 * Closing a gap changes the comp time of everything after it. Walking the
 * removals in DESCENDING order means every interval's coordinates are still
 * valid when its turn comes, with no running offset to keep — and no running
 * offset is one fewer thing to get wrong on the day a clip boundary lands
 * exactly on a cut.
 *
 * ## The audio/video pairing
 *
 * A video layer in this app IS its own audio source (see
 * `docs/VIDEO_EDITING_PIPELINE.md` §15 and `readVideoAudioVoices`) — there is
 * no stored link between a picture layer and a sound layer, because normally
 * there is only one layer. When a project DOES hold both (an audio layer
 * imported from the same file, a detached take), the only thing tying them
 * together is the **asset id**, so that is what {@link pairedAudioNodeIds}
 * matches on. It is honest about what it is: same file, same comp.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getTimelineController } from '@core/timeline/TimelineController';
import { runAsOneHistoryEntry } from '@core/composition/compositeEdit';
import { audioEngine } from './AudioEngine';
import { readNodeKind } from '@core/scene/sceneDerive';
import {
  readAudioClipTimings,
  readAudioVoices,
  readVideoAudioVoices,
  type AudioClipTiming,
} from './audioScene';
import { mixToMono, type DriverBuffer } from './audioDriver';

// ── Detection (pure) ────────────────────────────────────────────────

/** A span of the SOURCE file, in seconds, that should go away. */
export interface SilenceRange {
  startSec: number;
  endSec: number;
}

export interface SilenceOptions {
  /** At or below this RMS level, a window counts as quiet. Default -40 dBFS. */
  thresholdDb?: number;
  /** Quiet runs shorter than this are left alone. Default 400 ms. */
  minSilenceMs?: number;
  /** Margin of silence kept at each end of a removed gap. Default 80 ms. */
  paddingMs?: number;
  /** RMS analysis hop, ms — the resolution of a cut. Default 10 ms. */
  windowMs?: number;
}

export const DEFAULT_SILENCE_OPTIONS: Required<SilenceOptions> = {
  thresholdDb: -40,
  minSilenceMs: 400,
  paddingMs: 80,
  windowMs: 10,
};

/** RMS of `samples[from, to)` as dBFS. Silence returns a large negative, not −∞. */
function windowDb(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return 20 * Math.log10(Math.sqrt(sum / n) + 1e-9);
}

/**
 * Spans of `samples` quiet enough, and long enough, to cut out.
 *
 * The order of operations is a choice: a run is measured against
 * `minSilenceMs` at its RAW length, and the padding is taken off AFTERWARDS.
 * Insetting first would make `minSilenceMs` mean "min silence plus twice the
 * padding", so raising the padding would silently start sparing gaps the user
 * had already asked to lose — two controls, one of them lying.
 *
 * A run that the padding eats entirely is dropped rather than returned empty:
 * there is nothing left to remove, and a zero-length range downstream is a
 * split at a point with no material between the two halves.
 */
export function detectSilences(
  samples: Float32Array,
  sampleRate: number,
  opts: SilenceOptions = {},
): SilenceRange[] {
  if (sampleRate <= 0 || samples.length === 0) return [];

  const thresholdDb = opts.thresholdDb ?? DEFAULT_SILENCE_OPTIONS.thresholdDb;
  const minSilenceMs = Math.max(0, opts.minSilenceMs ?? DEFAULT_SILENCE_OPTIONS.minSilenceMs);
  const paddingMs = Math.max(0, opts.paddingMs ?? DEFAULT_SILENCE_OPTIONS.paddingMs);
  const windowMs = Math.max(1, opts.windowMs ?? DEFAULT_SILENCE_OPTIONS.windowMs);

  const hop = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const windows = Math.ceil(samples.length / hop);
  const minSec = minSilenceMs / 1000;
  const padSec = paddingMs / 1000;
  const totalSec = samples.length / sampleRate;

  const out: SilenceRange[] = [];
  let runStart = -1;

  const closeRun = (endWindow: number): void => {
    if (runStart < 0) return;
    const startSec = (runStart * hop) / sampleRate;
    const endSec = Math.min(totalSec, (endWindow * hop) / sampleRate);
    runStart = -1;
    if (endSec - startSec < minSec) return;
    const a = startSec + padSec;
    const b = endSec - padSec;
    if (b - a <= 0) return;
    out.push({ startSec: a, endSec: b });
  };

  for (let w = 0; w < windows; w++) {
    const from = w * hop;
    const quiet = windowDb(samples, from, Math.min(samples.length, from + hop)) <= thresholdDb;
    if (quiet) {
      if (runStart < 0) runStart = w;
      continue;
    }
    closeRun(w);
  }
  closeRun(windows);
  return out;
}

/** Total seconds {@link detectSilences} would take out. */
export function totalSilenceSec(ranges: readonly SilenceRange[]): number {
  let sum = 0;
  for (const r of ranges) sum += Math.max(0, r.endSec - r.startSec);
  return sum;
}

// ── Source → comp time (pure) ───────────────────────────────────────

/** A span of COMPOSITION time to cut out, in seconds. */
export interface CompInterval {
  start: number;
  end: number;
}

/**
 * Source-second ranges onto the comp timeline, through one layer's clip bars.
 *
 * A range only exists in the comp where a bar is actually playing that part of
 * the file: trimmed-away material has no comp time, and a range spanning a cut
 * between two bars becomes two intervals rather than one that would swallow
 * whatever sits between them.
 */
export function rangesToCompIntervals(
  timings: ReadonlyArray<AudioClipTiming>,
  ranges: readonly SilenceRange[],
): CompInterval[] {
  const out: CompInterval[] = [];
  for (const t of timings) {
    const barLen = Math.max(0, t.outSec - t.inSec);
    if (barLen <= 0) continue;
    for (const r of ranges) {
      const from = Math.max(r.startSec, t.inSec);
      const to = Math.min(r.endSec, t.outSec);
      if (to <= from) continue;
      out.push({ start: t.startSec + (from - t.inSec), end: t.startSec + (to - t.inSec) });
    }
  }
  return mergeIntervals(out);
}

/** Sort and coalesce overlapping/abutting intervals. */
export function mergeIntervals(intervals: readonly CompInterval[]): CompInterval[] {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: CompInterval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end + 1e-9) {
      if (iv.end > last.end) last.end = iv.end;
      continue;
    }
    out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

// ── Reading a layer's samples ───────────────────────────────────────

/**
 * Decoded mono samples for ANY audio-bearing layer — an audio layer or a video
 * layer's own track.
 *
 * `ensureAudioBuffer` would be the obvious call, and it only resolves the
 * `Audio` component's `__assetId`/`__src`, so it returns null for every video
 * layer. `readAudioLayers` already resolves both kinds to an asset id and a
 * URL (that is its whole job for the engine), so the voice list is the door
 * that is open to both.
 *
 * {@link audioVoiceFor} is the synchronous half of the same lookup, so a panel
 * can say "this layer has no sound" without starting a decode it will throw
 * away.
 */
/**
 * One entry per layer with sound: its node, its asset, its URL.
 *
 * Walked with `traverse` rather than taken from `readAudioLayers`, which is
 * built on `flattenScene` — that walks `getRoots()`, and a freshly created
 * project has none, so the list a picker is built from would be empty exactly
 * when the user is trying to use it. (`AudioDriverSection` hit the same thing
 * and made the same choice.) Per-node the derivation is identical: it is the
 * same two `readAudioVoices` / `readVideoAudioVoices` functions the engine
 * uses, so nothing here can disagree with what actually plays.
 */
export function audioVoices(): Array<{ nodeId: string; assetId: string; src: string; name: string }> {
  const out: Array<{ nodeId: string; assetId: string; src: string; name: string }> = [];
  const seen = new Set<string>();
  defaultSceneGraph.traverse((node) => {
    if (seen.has(node.id)) return;
    const kind = readNodeKind(node);
    const voices =
      kind === 'audio' ? readAudioVoices(node) : kind === 'video' ? readVideoAudioVoices(node) : [];
    const first = voices[0];
    if (!first) return;
    seen.add(node.id);
    out.push({ nodeId: node.id, assetId: first.assetId, src: first.src, name: node.name ?? node.id });
  });
  return out;
}

/** The asset behind one layer's sound, or undefined when it has none. */
export function audioVoiceFor(nodeId: string): { assetId: string; src: string } | undefined {
  const voice = audioVoices().find((v) => v.nodeId === nodeId);
  return voice ? { assetId: voice.assetId, src: voice.src } : undefined;
}

export async function loadNodeMono(
  nodeId: string,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  const voice = audioVoiceFor(nodeId);
  if (!voice) return null;
  const loaded = await audioEngine.load(voice.assetId, voice.src);
  const buffer = loaded?.buffer as DriverBuffer | undefined;
  if (!buffer) return null;
  return { samples: mixToMono(buffer), sampleRate: buffer.sampleRate };
}

/** Detect a layer's silences straight from its decoded source. */
export async function analyseNodeSilences(
  nodeId: string,
  opts: SilenceOptions = {},
): Promise<SilenceRange[] | null> {
  const src = await loadNodeMono(nodeId);
  if (!src) return null;
  return detectSilences(src.samples, src.sampleRate, opts);
}

// ── The pairing ─────────────────────────────────────────────────────

/**
 * Every layer in the same composition playing the same file as `nodeId`,
 * including `nodeId` itself.
 *
 * Matched on ASSET ID, because there is no stored picture↔sound link to match
 * on — see the module header. Two independent imports of the same file share
 * an asset and will therefore be cut together; that is the correct call for
 * the case this exists for (a take and its detached sound) and a surprise
 * nowhere else, because the two are playing the identical material anyway.
 */
export function pairedAudioNodeIds(nodeId: string): string[] {
  const voices = audioVoices();
  const own = voices.find((v) => v.nodeId === nodeId);
  if (!own) return defaultSceneGraph.getNode(nodeId) ? [nodeId] : [];

  const controller = getTimelineController();
  const compId = controller.compIdForNode(nodeId);
  const out: string[] = [];
  for (const v of voices) {
    if (v.assetId !== own.assetId) continue;
    if (out.includes(v.nodeId)) continue;
    if (controller.compIdForNode(v.nodeId) !== compId) continue;
    out.push(v.nodeId);
  }
  return out.length > 0 ? out : [nodeId];
}

// ── The cut ─────────────────────────────────────────────────────────

export interface RemoveSilencesResult {
  /** Comp-time gaps actually closed. */
  gaps: number;
  /** Seconds taken out of the composition. */
  secondsRemoved: number;
  /** Clip bars deleted across every paired layer. */
  clipsDeleted: number;
  /** Set when nothing could be done, in a sentence the dialog can show. */
  error?: string;
}

/** Bars belonging to any of `nodeIds`, in the comp that owns them. */
function barsOf(compId: string, nodeIds: ReadonlySet<string>): Array<{
  id: string;
  sourceId: string;
  start: number;
  end: number;
}> {
  const controller = getTimelineController();
  controller.invalidateLayerIndex();
  const out: Array<{ id: string; sourceId: string; start: number; end: number }> = [];
  for (const l of controller.layersOfComp(compId)) {
    const sourceId = l.sourceId;
    if (!sourceId || !nodeIds.has(sourceId)) continue;
    out.push({ id: l.id, sourceId, start: l.start, end: l.end });
  }
  return out;
}

/** One frame's worth of seconds — the tolerance for "this edge is that edge". */
function epsilon(fps: number): number {
  return 0.5 / Math.max(1, fps);
}

/**
 * Cut every paired bar at `at` (comp seconds). New right-hand halves are
 * separate scene nodes, so they are folded into the working set.
 */
function splitPairedAt(compId: string, nodeIds: Set<string>, at: number, fps: number): void {
  const controller = getTimelineController();
  const frame = Math.round(at * fps);
  for (const bar of barsOf(compId, nodeIds)) {
    if (!(frame > bar.start && frame < bar.end)) continue;
    const rightLayerId = controller.splitClip(bar.id, at);
    if (!rightLayerId) continue;
    const right = controller.layersOfComp(compId).find((l) => l.id === rightLayerId);
    if (right?.sourceId) nodeIds.add(right.sourceId);
  }
}

/**
 * Remove `ranges` (SOURCE seconds) from every layer in `nodeIds`, keeping them
 * in sync, as ONE undo entry.
 *
 * The layers must already be the paired set — call {@link pairedAudioNodeIds}
 * to build it. Passing a single layer is legal and cuts only that one.
 */
export async function removeSilences(
  nodeIds: readonly string[],
  ranges: readonly SilenceRange[],
): Promise<RemoveSilencesResult> {
  const present = nodeIds.filter((id) => defaultSceneGraph.getNode(id) !== undefined);
  if (present.length === 0) return { gaps: 0, secondsRemoved: 0, clipsDeleted: 0, error: 'Those layers are gone.' };
  if (ranges.length === 0) return { gaps: 0, secondsRemoved: 0, clipsDeleted: 0, error: 'Nothing to remove.' };

  const controller = getTimelineController();
  const first = present[0] as string;
  const compId = controller.compIdForNode(first);
  const fps = controller.fpsForNode(first) || 30;

  // The comp intervals, unioned across the pair. Each layer is mapped through
  // its OWN bars — the two are normally identical, and when they are not
  // (someone slid one of them) the union still cuts both at the same comp
  // times, which is what keeps them in sync afterwards.
  const intervals = mergeIntervals(
    present.flatMap((id) => rangesToCompIntervals(readAudioClipTimings(id), ranges)),
  );
  if (intervals.length === 0) {
    return {
      gaps: 0,
      secondsRemoved: 0,
      clipsDeleted: 0,
      error: 'Every silent stretch is already trimmed off these clips.',
    };
  }

  const working = new Set(present);
  let clipsDeleted = 0;
  const eps = epsilon(fps);

  await runAsOneHistoryEntry('Remove Silence', () => {
    // Last-first: see the module header. Each interval's comp times are still
    // true when its turn comes because nothing after it has moved yet.
    for (let i = intervals.length - 1; i >= 0; i--) {
      const iv = intervals[i] as CompInterval;
      splitPairedAt(compId, working, iv.start, fps);
      splitPairedAt(compId, working, iv.end, fps);

      // Delete what now lies wholly inside the gap. After the two splits every
      // such bar is its own scene node, so deleting the node deletes exactly
      // one bar's worth of layer.
      for (const bar of barsOf(compId, working)) {
        const startSec = bar.start / fps;
        const endSec = bar.end / fps;
        if (endSec <= startSec) continue;
        if (startSec < iv.start - eps || endSec > iv.end + eps) continue;
        if (controller.deleteLayerForClip(bar.id, { ripple: false })) {
          working.delete(bar.sourceId);
          clipsDeleted++;
        }
      }

      // Close the gap on the paired layers only — never with the engine's own
      // ripple, which would drag the rest of the comp with it.
      const gap = iv.end - iv.start;
      for (const bar of barsOf(compId, working)) {
        const startSec = bar.start / fps;
        if (startSec < iv.end - eps) continue;
        controller.setClipStart(bar.id, Math.max(0, startSec - gap));
      }
    }
  });

  return {
    gaps: intervals.length,
    secondsRemoved: intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0),
    clipsDeleted,
  };
}
