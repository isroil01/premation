/**
 * usePlaybackClock — keeps the page's playhead model in step with the
 * transport while the C++ engine runs the clock.
 *
 * The engine owns the clock (audio paced, ENGINE_API §6): its `playhead`
 * events move the TimelineController and the transient clock the UI reads
 * (core/engine/engineTransport.ts). The page no longer pumps time itself; this
 * hook only mirrors the active tab's play flag into the playhead model and
 * stops every composition but the active one.
 *
 * Mount once, near the timeline host.
 */

import { useEffect } from 'react';
import { useWorkspaceStore } from '@stores/projectStore';
import { pauseInactiveComps, syncTransportPlaying } from '@core/timeline/timelineView';
import { playbackHealth } from '@core/media/videoPlaybackDiag';

export function usePlaybackClock(): void {
  const playing = useWorkspaceStore((s) =>
    s.activeTabId ? s.tabs[s.activeTabId]?.playing ?? false : false,
  );
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);

  // Exactly one composition may hold the transport: whenever the active tab
  // changes, stop everything else (TimelineController.pauseInactiveComps).
  useEffect(() => {
    pauseInactiveComps();
  }, [activeTabId]);

  useEffect(() => {
    syncTransportPlaying(playing);
    // The engine paces playback itself; the page's realtime estimate stays at 1.
    playbackHealth.realtimeFactor = 1;
  }, [playing]);
}

export default usePlaybackClock;
