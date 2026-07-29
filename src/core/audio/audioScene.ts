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
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';
import { assetUrl } from '@core/api/client';
import { useAssetStore } from '@stores/assetStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { AudioLayerState } from './AudioEngine';

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
  level: number;
  duration: number;
  muted: boolean;
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
    level: num(p.__level) ?? 100,
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
  const base = { nodeId: node.id, assetId: s.assetId, src: s.src, level: s.level };

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

/** All audio voices currently in the scene (one per clip bar). */
export function readAudioLayers(): AudioLayerState[] {
  const out: AudioLayerState[] = [];
  for (const node of flattenScene(defaultSceneGraph)) {
    if (readNodeKind(node) !== 'audio') continue;
    out.push(...readAudioVoices(node));
  }
  return out;
}
