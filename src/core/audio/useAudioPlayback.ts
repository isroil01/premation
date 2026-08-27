/**
 * useAudioPlayback — bridges the transport to the {@link audioEngine}.
 *
 * Mounted once near the app root. It watches the active workspace's play-state
 * and playhead time, the scene revision, and the timeline's CLIP revision, and
 * calls `audioEngine.sync` so audio layers play in time with the composition
 * (and stop on pause/unmount). The engine itself handles seek/loop drift, so
 * this stays a thin subscription.
 *
 * The clip subscription is what makes a bar edit audible immediately: audio
 * timing now comes from the timeline clip (see `audioScene`), and clip edits go
 * through the Timeline Engine's own history — they never bump the scene
 * revision. Without this, trimming or sliding a bar while PAUSED left the
 * engine holding stale timing until something else happened to move the
 * playhead.
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useClipRevision } from '@hooks/useClipRevision';
import { useAssetStore } from '@stores/assetStore';
import { audioEngine, type AudioLayerState } from './AudioEngine';
import { readAudioLayers } from './audioScene';
import { playbackHealth } from '@core/rendering/videoPlaybackDiag';

/** During playback, refresh the layer list at most this often even with no
 *  revision bump — catches live edits (keyframed levels) whose paths don't
 *  bump a revision, at 2Hz instead of per frame. */
const PLAYBACK_REFRESH_MS = 500;

export function useAudioPlayback(): void {
  const ws = useActiveWorkspace();
  const playing = ws?.playing ?? false;
  const time = ws?.time ?? 0;
  const rev = useSceneRevision((s) => s.rev);
  // Bumped whenever a clip bar is added, removed, moved, trimmed or split.
  const clipRev = useClipRevision();
  // Asset identity: an import/relink changes audio sources without a scene rev.
  const assets = useAssetStore((s) => s.assets);

  // readAudioLayers() walks the ENTIRE scene graph and linear-scans the asset
  // list — running it on every playhead mirror (once per comp frame, 30-60x/s)
  // was pure per-frame garbage: the layer list only changes on scene/clip/
  // asset edits. Cache it on those revisions; the per-frame sync just passes
  // the cached list with the fresh time.
  const cache = useRef<{ key: string; at: number; layers: AudioLayerState[] } | null>(null);

  // Mute-on-slow hysteresis (the After Effects rule): a preview running under
  // realtime cannot keep audio in sync — voices restart on every quarter
  // second of drift, which is worse than silence. Mute once the transport
  // dips below ~85% realtime, unmute only once it holds ~97%, so the boundary
  // never chatters.
  const mutedRef = useRef(false);

  useEffect(() => {
    const key = `${rev}:${clipRev}:${assets.length}`;
    const now = performance.now();
    let entry = cache.current;
    if (!entry || entry.key !== key || (playing && now - entry.at > PLAYBACK_REFRESH_MS)) {
      entry = { key, at: now, layers: readAudioLayers() };
      cache.current = entry;
    }
    const rt = playbackHealth.realtimeFactor;
    if (mutedRef.current) {
      if (rt >= 0.97 || !playing) mutedRef.current = false;
    } else if (playing && rt < 0.85) {
      mutedRef.current = true;
    }
    audioEngine.sync(playing && !mutedRef.current, time, entry.layers);
  }, [playing, time, rev, clipRev, assets]);

  useEffect(() => () => audioEngine.sync(false, 0, []), []);
}

/**
 * Null-rendering host for {@link useAudioPlayback}. Mounted once near the app
 * root so only this tiny component re-renders as the playhead advances (rather
 * than the whole provider tree).
 */
export function AudioPlaybackBridge(): ReactElement | null {
  useAudioPlayback();
  return null;
}
