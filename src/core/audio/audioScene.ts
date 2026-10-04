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

import {  readNodeKind } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';
import { useAssetStore } from '@stores/assetStore';
import { readNodeLayerTime } from '@core/scene/layerTime';

interface CompRef {
  id: string;
  props: Record<string, unknown>;
}

/** The `Audio` data component carrying the asset ref + level/trim. */
export function audioComponent(node: SceneNode): CompRef | undefined {
  return node.components.find((c) => c.type === 'Audio') as CompRef | undefined;
}

/** True when the node is an audio layer. */
export function isAudioNode(node: SceneNode): boolean {
  return readNodeKind(node) === 'audio' && audioComponent(node) !== undefined;
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
