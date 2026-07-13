/**
 * useAudioPlayback (Prompt 8) — bridges the transport to the {@link audioEngine}.
 *
 * Mounted once near the app root. It watches the active workspace's play-state
 * and playhead time plus the scene revision, and calls `audioEngine.sync` so
 * audio layers play in time with the composition (and stop on pause/unmount).
 * The engine itself handles seek/loop drift, so this stays a thin subscription.
 */

import { useEffect, type ReactElement } from 'react';
import { useActiveWorkspace } from '@stores/workspaceStore';
import { useSceneRevision } from '@stores/sceneStore';
import { audioEngine } from './AudioEngine';
import { readAudioLayers } from './audioScene';

export function useAudioPlayback(): void {
  const ws = useActiveWorkspace();
  const playing = ws?.playing ?? false;
  const time = ws?.time ?? 0;
  const rev = useSceneRevision((s) => s.rev);

  useEffect(() => {
    audioEngine.sync(playing, time, readAudioLayers());
  }, [playing, time, rev]);

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
