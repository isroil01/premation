/**
 * PresentationMode — full-bleed, distraction-free playback for client review
 * (spec §Collaboration V1). The composition renders centered on a dark stage
 * with a minimal transport; Esc or the close button exits.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@components/Icon';
import { usePresentationStore } from '@stores/presentationStore';
import { useWorkspaceStore, useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useViewportRenderer } from '@layout/Workspace/useViewportRenderer';
import { getTimelineController } from '@core/timeline/TimelineController';
import styles from './PresentationMode.module.css';

export function PresentationMode(): JSX.Element | null {
  const active = usePresentationStore((s) => s.active);
  const exit = usePresentationStore((s) => s.exit);
  const ws = useActiveWorkspace();
  const setPlaying = useWorkspaceStore((s) => s.actions.setPlaying);
  const sceneRev = useSceneRevision((s) => s.rev);
  // Real comp duration for the scrub bar (was a hardcoded 10s).
  const duration = useCompositionStore((s) => s.durationSeconds) || 1;
  const time = ws?.time ?? 0;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useViewportRenderer(canvasRef, stageRef, sceneRev, time);
  // NOTE: no usePlaybackClock() here — App.tsx already runs the single shared
  // clock; a second instance double-ticked the controller (2× playback speed).

  // Auto-play from the start on enter; stop on exit.
  useEffect(() => {
    if (active) { getTimelineController().goToStart(); setPlaying(true); }
    return () => setPlaying(false);
  }, [active, setPlaying]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); exit(); }
      else if (e.key === ' ') { e.preventDefault(); setPlaying(!ws?.playing); }
    };
    if (active) window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
  }, [active, exit, setPlaying, ws?.playing]);

  if (!active) return null;

  return createPortal(
    <div className={styles.root} role="dialog" aria-label="Presentation">
      <button type="button" className={styles.close} onClick={exit} aria-label="Exit presentation (Esc)">
        <Icon name="close" size={18} />
      </button>
      <div className={styles.stage} ref={stageRef}>
        <canvas ref={canvasRef} className={styles.canvas} />
      </div>
      <div className={styles.transport}>
        <button type="button" className={styles.play} onClick={() => setPlaying(!ws?.playing)} aria-label={ws?.playing ? 'Pause' : 'Play'}>
          <Icon name={ws?.playing ? 'pause' : 'play'} size={16} />
        </button>
        <div className={styles.scrub}>
          <div className={styles.scrubFill} style={{ width: `${Math.min(100, (time / duration) * 100)}%` }} />
        </div>
        <span className={styles.time}>{time.toFixed(1)}s</span>
      </div>
    </div>,
    document.body,
  );
}

export default PresentationMode;
