/**
 * Live video decoder health in the status bar. Two jobs: show dropped-frame
 * pressure during playback (decode overload reads as "broken video" with no
 * other symptom), and — the important one — say OUT LOUD when the browser's
 * media pipeline has wedged (every new <video> stalls at readyState 0 with no
 * error; only a full app/browser restart clears it). That failure mode used
 * to be indistinguishable from editor bugs.
 *
 * Moved here from App.tsx, where it lived as an inline-styled local.
 */

import { useEffect, useRef, useState } from 'react';
import { videoDiag, VIDEO_DIAG_LIVE_MS, DropRateWindow } from '@core/media/videoPlaybackDiag';
import { useUIStore } from '@stores/uiStore';
import { cn } from '@utils/cn';
import styles from './EditorStatusBar.module.css';

/** How far back the drop readout looks. Long enough that sustained pressure
 *  cannot hide between ticks, short enough that the badge clears within a
 *  breath of playback recovering. */
const DROP_WINDOW_MS = 4000;
/** Drops inside the window that turn the badge red — about a quarter-second of
 *  30fps footage lost while the window is only four seconds long. */
const DROP_BAD_COUNT = 30;

export function VideoHealth(): JSX.Element | null {
  const [state, setState] = useState<{ label: string; bad: boolean } | null>(null);
  const warnedRef = useRef(false);
  // Recent drops, not lifetime drops — the counters are cumulative and the
  // elements are reused across loops, so raw totals kept the badge red forever
  // after one rough pass. The arithmetic and its reasoning live in
  // `DropRateWindow`.
  const dropsRef = useRef(new DropRateWindow(DROP_WINDOW_MS));
  useEffect(() => {
    const id = setInterval(() => {
      if (videoDiag.stalledSources.size > 0) {
        setState({ label: 'video decoder not responding — restart the app', bad: true });
        if (!warnedRef.current) {
          warnedRef.current = true;
          useUIStore.getState().notify({
            level: 'error',
            message:
              'Video decoding is not responding (the system media pipeline appears wedged). '
              + 'Fully restart the app — or your browser — to restore video playback.',
            durationMs: 12000,
          });
        }
        return;
      }
      const now = performance.now();
      let live = 0;
      let seeking = false;
      let worstLagMs = 0;
      const counts = new Map<string, number>();
      for (const s of videoDiag.samples.values()) {
        if (now - s.updatedAt > VIDEO_DIAG_LIVE_MS) continue;
        live += 1;
        counts.set(s.key, s.droppedFrames);
        seeking = seeking || s.seeking;
        if (s.driftMs < worstLagMs) worstLagMs = s.driftMs;
      }
      const recentDrops = dropsRef.current.sample(now, counts);
      if (live === 0) {
        setState(null);
        return;
      }
      // "behind" = the decoder cannot sustain realtime on this machine; the
      // timeline is pacing down to meet it. The cure is a preview proxy
      // (Media Settings ▸ Proxy), not a code path.
      const lag = worstLagMs < -150 ? ` · behind ${(-worstLagMs / 1000).toFixed(1)}s` : '';
      setState({
        label: `video ×${live} · drop ${recentDrops}${seeking ? ' · seeking' : ''}${lag}`,
        // ~1/4 of a second's frames lost inside the window = real pressure now;
        // a couple of drops around a seek is normal and stays quiet.
        bad: recentDrops > DROP_BAD_COUNT || worstLagMs < -400,
      });
    }, 500);
    return () => clearInterval(id);
  }, []);
  if (!state) return null;
  return (
    <>
      <span className={styles.dot} aria-hidden>·</span>
      <span
        className={cn(styles.mono, state.bad && styles.bad)}
        title={`Video decoder health: live elements, frames dropped in the last ${DROP_WINDOW_MS / 1000}s`}
      >
        {state.label}
      </span>
    </>
  );
}
