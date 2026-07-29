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

import { useEffect, type ReactElement } from 'react';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useClipRevision } from '@hooks/useClipRevision';
import { audioEngine } from './AudioEngine';
import { readAudioLayers } from './audioScene';

export function useAudioPlayback(): void {
  const ws = useActiveWorkspace();
  const playing = ws?.playing ?? false;
  const time = ws?.time ?? 0;
  const rev = useSceneRevision((s) => s.rev);
  // Bumped whenever a clip bar is added, removed, moved, trimmed or split.
  const clipRev = useClipRevision();

  useEffect(() => {
    audioEngine.sync(playing, time, readAudioLayers());
  }, [playing, time, rev, clipRev]);

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
