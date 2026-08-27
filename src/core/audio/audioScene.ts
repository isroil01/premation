/**
 * audioScene — read audio layers out of the scene graph as the flat
 * {@link AudioLayerState} list the {@link AudioEngine} needs. Kept separate so
 * both the playback hook and the inspector can share one derivation.
 *
 * **The timeline clip bar is the authority on WHEN audio sounds.** An audio
 * node's bar (start / trim / splits) lives in the Timeline Engine exactly like
 * a visual layer's, and the renderer already gates visual layers on it
 * (`buildSnapshot`'s `isActiveAt` check). Audio used to read a parallel set of
 * `__start`/`__in`/`__out` props on the Audio component that NOTHING ever
 * wrote — so dragging, trimming or splitting an audio bar changed the picture
 * of the timeline and not one sample of the sound. Clips win here now; the
 * component props survive only as the fallback for audio that has no bar
 * (nested inside a plain group, or a headless/test scene with no timeline).
 *
 * One clip = one voice: a split audio layer yields two entries, each with its
 * own `id`, so the engine can schedule them independently.
 *
 * **Video layers are audio sources too.** A `.mp4` used to import as picture
 * only — the `<video>` elements the renderer scrubs for frames are hard-muted
 * (they must be: they are seeked, not played), and nothing else ever looked at
 * the file's audio track, so every import silently dropped its sound. They are
 * now read into the same voice list: the file's bytes go through the same
 * `decodeAudioData` path as an audio asset, which returns the decoded AUDIO
 * track of an mp4/webm container. That makes a video's sound follow the same
 * clip bars, the same gain, the same mixdown and the same export as any other
 * audio, instead of needing a parallel pipeline. A video with no audio track
 * simply fails to decode and is remembered as silent (see `AudioEngine`).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { compRootOf } from '@core/scene/parenting';
import type { SceneNode } from '@core/types';
import { assetUrl } from '@core/api/client';
import { useAssetStore } from '@stores/assetStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { AudioLayerState } from './AudioEngine';
import { percentToDb, isLevelAnimated, AUDIO_LEVEL_DB_PROP } from './audioParams';
import { readNodeLayerTime } from '@core/scene/layerTime';
import { readAudioEffects } from './audioEffects';
import { buildAudioRetimeSegments } from './audioRetimeSegments';

interface CompRef {
  id: string;
  props: Record<string, unknown>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** The `Audio` data component carrying the asset ref + level/trim. */
export function audioComponent(node: SceneNode): CompRef | undefined {
  return node.components.find((c) => c.type === 'Audio') as CompRef | undefined;
}

/** True when the node is an audio layer. */
export function isAudioNode(node: SceneNode): boolean {
  return readNodeKind(node) === 'audio' && audioComponent(node) !== undefined;
}

/** The asset-level facts of an audio node (no timing). */
interface AudioSource {
  assetId: string;
  src: string;
  /** Static level in dB. Keyframes, when present, are sampled per frame on top
   *  of this — see `audioParams`. */
  levelDb: number;
  duration: number;
  muted: boolean;
}

/**
 * A node's static level in dB.
 *
 * Prefers an explicit dB value, then migrates the legacy percent both layer
 * kinds used to store. Reading the percent through `percentToDb` rather than
 * treating it as dB is what keeps an existing project sounding identical: 100
 * means unity, not +100 dB.
 */
function staticLevelDb(props: Record<string, unknown>, dbKey: string, percentKey: string): number {
  const db = props[dbKey];
  if (typeof db === 'number') return db;
  const pct = props[percentKey];
  if (typeof pct === 'number') return percentToDb(pct);
  return 0;
}

/** Resolve an audio node's asset + gain, or null when it lacks a usable src. */
function readAudioSource(node: SceneNode): AudioSource | null {
  const a = audioComponent(node);
  if (!a) return null;
  const p = a.props;
  const assetId = typeof p.__assetId === 'string' ? p.__assetId : '';
  let src = typeof p.__src === 'string' ? assetUrl(p.__src) : '';
  if (assetId) {
    const asset = useAssetStore.getState().assets.find((x) => x.id === assetId);
    if (asset && asset.src) src = asset.src;
  }
  if (!src || !assetId) return null;
  return {
    assetId,
    src,
    levelDb: staticLevelDb(p, AUDIO_LEVEL_DB_PROP, '__level'),
    duration: num(p.__duration) ?? 0,
    muted: node.visible === false || p.__muted === true,
  };
}

/**
 * Timing for an audio node with NO clip bar (grouped layers, headless scenes).
 * The legacy `__start`/`__in`/`__out` props, kept so those paths still sound.
 */
function propTiming(node: SceneNode, s: AudioSource): AudioClipTiming {
  const p = audioComponent(node)!.props;
  return {
    startSec: num(p.__start) ?? 0,
    inSec: num(p.__in) ?? 0,
    outSec: num(p.__out) ?? s.duration,
  };
}

/** One audible span: where it starts in comp time and what part of the source it plays. */
export interface AudioClipTiming {
  /** Comp time (seconds) the span begins at. */
  startSec: number;
  /** Offset into the source media where it begins, seconds. */
  inSec: number;
  /** Offset into the source media where it ends, seconds. */
  outSec: number;
}

/**
 * The audio node's timing spans, read from its timeline clip bars.
 *
 * Returns `[]` when the node has no bars — the caller then falls back to
 * {@link propTiming}. Clip geometry is in FRAMES on the timeline that owns the
 * node, so it converts through that timeline's own fps (a node inside an opened
 * precomp keeps its clips in the precomp's registry, which may run at a
 * different rate than the active tab).
 */
export function readAudioClipTimings(nodeId: string): Array<AudioClipTiming & { id: string; enabled: boolean }> {
  const controller = getTimelineController();
  const clips = controller.getLayersForNode(nodeId);
  if (clips.length === 0) return [];
  const fps = controller.fpsForNode(nodeId) || 30;
  return clips.map((l) => ({
    id: l.id,
    enabled: l.enabled !== false,
    startSec: l.clip.start / fps,
    inSec: l.clip.sourceIn / fps,
    outSec: (l.clip.sourceIn + l.clip.duration) / fps,
  }));
}

/**
 * Read one audio node into transport state — one entry per clip bar (a split
 * layer yields several), or a single prop-derived entry when it has no bars.
 * Empty when the node lacks a usable src.
 */
export function readAudioVoices(node: SceneNode): AudioLayerState[] {
  const s = readAudioSource(node);
  if (!s) return [];
  const base = {
    nodeId: node.id, assetId: s.assetId, src: s.src,
    levelDb: s.levelDb, levelAnimated: isLevelAnimated(node.id),
    source: 'audio' as const,
    // On the BASE, so every voice of a node shares one chain. Splitting a clip
    // makes two voices of one layer; they must sound alike, and effects stored
    // per-voice would let one half of a split drift from the other.
    effects: readAudioEffects(node),
  };

  const timings = readAudioClipTimings(node.id);
  if (timings.length === 0) {
    const t = propTiming(node, s);
    return [{ id: node.id, ...base, ...t, muted: s.muted }];
  }
  return timings.map((t) => ({
    id: t.id,
    ...base,
    startSec: t.startSec,
    inSec: t.inSec,
    outSec: t.outSec,
    // A disabled clip is the timeline's own mute — honour it alongside the
    // layer-level mute so soloing/hiding in either surface silences the layer.
    muted: s.muted || !t.enabled,
  }));
}

/** Props a video layer carries for its own audio track. Namespaced rather than
 *  reusing the audio component's `__level`/`__muted`, because a video node's
 *  Transform component is shared with the picture path. */
export const VIDEO_AUDIO_LEVEL_PROP = 'audioLevel';
export const VIDEO_AUDIO_MUTED_PROP = 'audioMuted';

/**
 * Does this video layer's file have an audio track?
 *
 * Three-valued on purpose. `true`/`false` come from the import probe actually
 * reading the container; `null` means nobody looked — a web import, or a
 * desktop without ffprobe. The audio UI must not collapse `null` into `false`:
 * "this file has no sound" and "we cannot tell yet" are different claims, and
 * only the first justifies hiding the controls outright. In the `null` case the
 * decode outcome is still the answer, it just arrives later.
 */
export function videoHasAudioTrack(node: SceneNode): boolean | null {
  const assetId = (() => {
    for (const c of node.components) {
      const p = c.props as Record<string, unknown>;
      if (typeof p.assetId === 'string' && p.assetId) return p.assetId;
      if (typeof p.__assetId === 'string' && p.__assetId) return p.__assetId;
    }
    return '';
  })();
  if (!assetId) return null;
  const asset = useAssetStore.getState().assets.find((x) => x.id === assetId);
  const flag = asset?.metadata?.hasAudioTrack;
  return typeof flag === 'boolean' ? flag : null;
}

/**
 * The asset behind a VIDEO layer, resolved the same way the renderer resolves
 * its picture (scan every component, last write wins — see `readBase` in
 * buildSnapshot). Audio and picture must never resolve to different files.
 */
function readVideoAudioSource(node: SceneNode): AudioSource | null {
  let assetId = '';
  let rawSrc = '';
  let muted = false;
  const levelProps: Record<string, unknown> = {};
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.assetId === 'string' && p.assetId) assetId = p.assetId;
    if (typeof p.__assetId === 'string' && p.__assetId) assetId = p.__assetId;
    if (typeof p.src === 'string' && p.src) rawSrc = p.src;
    if (typeof p[AUDIO_LEVEL_DB_PROP] === 'number') levelProps[AUDIO_LEVEL_DB_PROP] = p[AUDIO_LEVEL_DB_PROP];
    if (typeof p[VIDEO_AUDIO_LEVEL_PROP] === 'number') levelProps[VIDEO_AUDIO_LEVEL_PROP] = p[VIDEO_AUDIO_LEVEL_PROP];
    if (p[VIDEO_AUDIO_MUTED_PROP] === true) muted = true;
  }
  if (!assetId) return null;

  // Prefer the library asset's URL — the same preference `readAudioSource` has,
  // so a re-imported or relinked asset sounds from the file the panel shows.
  let src = rawSrc ? assetUrl(rawSrc) : '';
  const asset = useAssetStore.getState().assets.find((x) => x.id === assetId);
  if (asset?.src) src = asset.src;
  if (!src) return null;

  return {
    assetId,
    src,
    levelDb: staticLevelDb(levelProps, AUDIO_LEVEL_DB_PROP, VIDEO_AUDIO_LEVEL_PROP),
    duration: asset?.metadata?.duration ?? 0,
    // A hidden video is silent, matching how a hidden audio layer behaves.
    muted: node.visible === false || muted,
  };
}

/**
 * Does this layer's speed force audio to mute?
 *
 * Freeze holds one picture frame — there is no continuous soundtrack, so we
 * mute. Time-remap keyframes used to mute too; they now expand into piecewise
 * varispeed segments (see {@link buildAudioRetimeSegments}).
 *
 * Constant stretch and reverse play via Web Audio `playbackRate` / buffer reverse.
 */
export function speedAltersAudio(node: SceneNode): boolean {
  return readNodeLayerTime(node)?.freeze === true;
}

/** Stretch → playbackRate. 100 = 1×, 200 = half-speed, 50 = 2×. */
export function videoAudioPlaybackRate(node: SceneNode): number {
  const stretch = readNodeLayerTime(node)?.stretch ?? 100;
  return 100 / Math.max(0.01, stretch);
}

export function videoAudioRetimeReverse(node: SceneNode): boolean {
  return readNodeLayerTime(node)?.reverse === true;
}

/**
 * Read a video node's audio track into transport state — one entry per clip
 * bar, exactly like an audio layer, so trimming, splitting or moving the
 * video's bar retimes its sound with the picture.
 *
 * Empty when the layer has no resolvable asset. A layer whose file turns out to
 * have no audio track still yields a voice here; the engine skips it once the
 * decode fails, which is cheaper than probing every video up front.
 *
 * Time-remap tracks expand into several short varispeed voices so the soundtrack
 * follows the same curve as the picture (preview and export share this list).
 */
export function readVideoAudioVoices(node: SceneNode): AudioLayerState[] {
  const s = readVideoAudioSource(node);
  if (!s) return [];
  const freezeMuted = speedAltersAudio(node);
  const playbackRate = videoAudioPlaybackRate(node);
  const retimeReverse = videoAudioRetimeReverse(node);
  const base = {
    nodeId: node.id, assetId: s.assetId, src: s.src,
    levelDb: s.levelDb, levelAnimated: isLevelAnimated(node.id),
    source: 'video' as const,
  };

  const fps = getTimelineController().fpsForNode(node.id) || 30;
  const timings = readAudioClipTimings(node.id);
  const spans: Array<AudioClipTiming & { id: string; enabled: boolean }> =
    timings.length > 0
      ? timings
      : [{ id: node.id, enabled: true, startSec: 0, inSec: 0, outSec: s.duration }];

  const out: AudioLayerState[] = [];
  for (const t of spans) {
    const muted = s.muted || !t.enabled || freezeMuted;
    const segs = freezeMuted ? [] : buildAudioRetimeSegments(node, t, fps);
    if (segs === null) {
      out.push({
        id: t.id,
        ...base,
        startSec: t.startSec,
        inSec: t.inSec,
        outSec: t.outSec,
        playbackRate,
        retimeReverse,
        muted,
      });
      continue;
    }
    if (segs.length === 0) {
      // Freeze / empty remap — keep a muted voice for waveform + inspector.
      out.push({
        id: t.id,
        ...base,
        startSec: t.startSec,
        inSec: t.inSec,
        outSec: t.outSec,
        playbackRate: 1,
        muted: true,
      });
      continue;
    }
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      // Convention: outSec − inSec is WALL duration (see AudioEngine / mixdown).
      out.push({
        id: `${t.id}::r${i}`,
        ...base,
        startSec: seg.startSec,
        inSec: seg.inSec,
        outSec: seg.inSec + seg.durationSec,
        playbackRate: seg.rate,
        retimeReverse: seg.reverse,
        muted,
      });
    }
  }
  return out;
}

/**
 * All audio voices currently in the scene (one per clip bar), from both audio
 * layers and the audio tracks of video layers.
 *
 * **Solo covers both kinds.** Solo is a layer switch the renderer already
 * honours for picture (`buildSnapshot`'s `anySolo`), but nothing applied it to
 * sound: soloing a layer left every other layer audible, and once video layers
 * became voices that got actively misleading — you would solo a title and still
 * hear the footage under it, which reads as the solo being broken rather than
 * as audio being out of scope. Applied here, once, so it cannot cover one kind
 * and miss the other.
 */
export function readAudioLayers(scopeRootId?: string): AudioLayerState[] {
  // Scoped to one composition when asked. flattenScene walks the WHOLE
  // project, so an export of comp B used to carry comp A's soundtrack under
  // comp B's picture (the picture was rootId-scoped; the sound was not), and
  // multi-comp projects heard every comp at once during playback.
  const all = flattenScene(defaultSceneGraph);
  const nodes = scopeRootId
    ? all.filter((n) => n.id !== scopeRootId && compRootOf(n.id) === scopeRootId)
    : all;
  const anySolo = nodes.some((n) => n.solo === true);

  const out: AudioLayerState[] = [];
  for (const node of nodes) {
    const kind = readNodeKind(node);
    const voices =
      kind === 'audio' ? readAudioVoices(node) : kind === 'video' ? readVideoAudioVoices(node) : [];
    if (voices.length === 0) continue;
    // Soloing silences rather than drops: the voice stays in the list so the
    // waveform, the decode cache and the inspector still see it.
    const soloed = !anySolo || node.solo === true;
    for (const v of voices) out.push(soloed ? v : { ...v, muted: true });
  }
  return out;
}
