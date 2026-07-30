/**
 * PresentationMode — full-bleed, distraction-free playback for review + preview.
 *
 * The composition renders centred on a dark stage with a real player chrome:
 *   • Frame-accurate transport (start / prev / play / next / end / loop)
 *   • A seekable, draggable progress bar
 *   • Timecode (current / total) computed at the COMPOSITION frame rate
 *   • Size + fps + preview-quality badges (quality actually re-renders)
 *   • Download the current frame (PNG) and Export video…
 *   • Fullscreen toggle + auto-hiding chrome while playing
 *
 * Esc (or the close button) exits.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@components/Icon';
import { usePresentationStore } from '@stores/presentationStore';
import { useWorkspaceStore, useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useRenderQualityStore, RESOLUTION_LABELS, type PreviewResolution } from '@stores/renderQualityStore';
import { useViewportRenderer } from '@layout/Workspace/useViewportRenderer';
import { getTimelineController } from '@core/timeline/TimelineController';
import { framesToTimecode } from '@core/time/timecode';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { renderStillFrame } from '@core/export/offlineRenderer';
import styles from './PresentationMode.module.css';
import { compSizeOf } from '@core/composition/compSizes';

const QUALITY_ORDER: PreviewResolution[] = [1, 2, 3, 4];
/** Hide the chrome after this long with no pointer movement while playing. */
const IDLE_HIDE_MS = 2600;

export function PresentationMode(): JSX.Element | null {
  const active = usePresentationStore((s) => s.active);
  const exit = usePresentationStore((s) => s.exit);
  const ws = useActiveWorkspace();
  const setPlaying = useWorkspaceStore((s) => s.actions.setPlaying);
  const sceneRev = useSceneRevision((s) => s.rev);

  const name = useCompositionStore((s) => s.name);
  const width = useCompositionStore((s) => s.width);
  const height = useCompositionStore((s) => s.height);
  const fps = useCompositionStore((s) => s.fps) || 30;
  const startFrame = useCompositionStore((s) => s.startFrame) || 0;
  const duration = useCompositionStore((s) => s.durationSeconds) || 1;

  const previewResolution = useRenderQualityStore((s) => s.resolution);
  const setResolution = useRenderQualityStore((s) => s.setResolution);

  const time = ws?.time ?? 0;
  const playing = ws?.playing ?? false;
  const durationFrames = Math.max(1, Math.round(duration * fps));
  const currentFrame = Math.min(durationFrames, Math.max(0, Math.round(time * fps)));
  const progress = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrubRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // Tracks whether the backend has painted at least one frame — used to show a
  // loading spinner on the stage until the first pixels arrive (previously the
  // canvas was blank with no feedback while the GPU backend initialised).
  const [backendReady, setBackendReady] = useState(false);

  const { initError } = useViewportRenderer(canvasRef, stageRef, sceneRev, time);
  // NOTE: no usePlaybackClock here — App.tsx runs the single shared clock; a
  // second instance would double-tick the controller (2× playback speed).

  const [looping, setLoopingState] = useState(() => getTimelineController().isLooping());
  const [uiVisible, setUiVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Auto-play from the start on enter; stop on exit.
  //
  // Previously setPlaying(true) fired synchronously the moment `active` turned
  // true — before the canvas had been mounted in the DOM, before the GPU backend
  // had initialised, and before the ResizeObserver had sized the surface. The
  // playback clock then hammered renderImmediate against a null backend
  // (no-ops), and when the backend came up the render queue was already backed
  // up. On complex 3D/2D scenes one buildSnapshot call can take >50 ms, causing
  // the event loop to stall and making Esc/close completely unresponsive.
  //
  // Fix: defer auto-play by one rAF (≈ one paint) so React has committed the
  // portal DOM and useViewportRenderer's attach effect has had a chance to run
  // and size the canvas. This is not a "wait for GPU ready" — the backend may
  // still be initialising — but it gives the layout engine time to mount the
  // canvas before the first frame is requested.
  useEffect(() => {
    if (!active) {
      setPlaying(false);
      setBackendReady(false);
      return;
    }
    getTimelineController().goToStart();

    // One rAF delay lets the portal DOM commit and the resize observer fire
    // before we start the clock.
    const rafId = requestAnimationFrame(() => {
      setPlaying(true);
      // Mark backend as "ready enough to show" after the first rAF — the
      // spinner disappears and the canvas is revealed. The real first pixel may
      // arrive a frame later (GPU init is async), but the spinner covers that.
      setBackendReady(true);
    });

    return () => {
      cancelAnimationFrame(rafId);
      setPlaying(false);
    };
  }, [active, setPlaying]);

  // Reveal chrome; while playing, re-arm an idle timer that hides it. Paused
  // always shows (the user is inspecting a still, not watching).
  const pokeControls = useCallback(() => {
    setUiVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing) hideTimer.current = setTimeout(() => setUiVisible(false), IDLE_HIDE_MS);
  }, [playing]);

  useEffect(() => {
    pokeControls();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [pokeControls]);

  // ── Transport ──────────────────────────────────────────────────────
  const togglePlay = useCallback(() => setPlaying(!playing), [playing, setPlaying]);
  const toggleLoop = useCallback(() => {
    const on = !looping;
    getTimelineController().setLooping(on);
    setLoopingState(on);
  }, [looping]);
  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }, []);
  const cycleQuality = useCallback(() => {
    const i = QUALITY_ORDER.indexOf(previewResolution);
    setResolution(QUALITY_ORDER[(i + 1) % QUALITY_ORDER.length]!);
  }, [previewResolution, setResolution]);

  // Download the current frame. Rendered through the deterministic offline
  // path rather than read off the live preview canvas: a WebGL/WebGPU canvas
  // returns a BLANK toBlob (the drawing buffer is cleared after composite
  // unless preserveDrawingBuffer is set), so reading the surface only worked on
  // Canvas2D. The offline renderer produces a correct frame on any backend.
  const downloadFrame = useCallback(() => {
    void (async () => {
      const comp = useCompositionStore.getState().comp();
      const blob = await renderStillFrame(
        {
          width,
          height,
          fps,
          durationSec: duration,
          comp: { ...comp, rootId: comp.id, compSizeOf },
        },
        currentFrame,
      );
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(name || 'frame').replace(/\s+/g, '_')}_${String(currentFrame).padStart(4, '0')}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    })();
  }, [name, currentFrame, width, height, fps, duration]);

  // ── Seekable scrub bar ─────────────────────────────────────────────
  const seekToClientX = useCallback((clientX: number) => {
    const el = scrubRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
    getTimelineController().seekSeconds(frac * duration);
  }, [duration]);

  const onScrubDown = (e: React.PointerEvent): void => {
    draggingRef.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    seekToClientX(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent): void => {
    if (draggingRef.current) seekToClientX(e.clientX);
  };
  const onScrubUp = (e: React.PointerEvent): void => {
    draggingRef.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const handleExit = useCallback((e?: React.SyntheticEvent | Event) => {
    e?.stopPropagation();
    setPlaying(false);
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
    exit();
  }, [exit, setPlaying]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const c = getTimelineController();
    const onKey = (e: KeyboardEvent): void => {
      switch (e.key) {
        case 'Escape': e.preventDefault(); handleExit(e); break;
        case ' ': e.preventDefault(); setPlaying(!playing); break;
        case 'ArrowLeft': e.preventDefault(); c.previousFrame(); break;
        case 'ArrowRight': e.preventDefault(); c.nextFrame(); break;
        case 'Home': e.preventDefault(); c.goToStart(); break;
        case 'End': e.preventDefault(); c.goToEnd(); break;
        case 'l': case 'L': toggleLoop(); break;
        case 'f': case 'F': toggleFullscreen(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
  }, [active, handleExit, setPlaying, playing, toggleLoop, toggleFullscreen]);

  useEffect(() => {
    const onFs = (): void => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  if (!active) return null;

  const pct = `${progress * 100}%`;

  return createPortal(
    <div
      ref={rootRef}
      className={styles.root}
      role="dialog"
      aria-label="Presentation"
      data-hidden={uiVisible ? undefined : ''}
      onPointerMove={pokeControls}
    >
      {/* Top bar: title, comp badges, and primary actions. */}
      <div className={styles.topBar}>
        <div className={styles.title} title={name}>{name || 'Composition'}</div>
        <div className={styles.badges}>
          <span className={styles.badge} title="Composition size">{width}×{height}</span>
          <span className={styles.badge} title="Frame rate">{fps} fps</span>
          <button
            type="button"
            className={styles.badgeBtn}
            onClick={cycleQuality}
            title="Preview quality — fewer pixels play back faster (click to cycle)"
          >
            {RESOLUTION_LABELS[previewResolution]}
          </button>
        </div>
        <div className={styles.topActions}>
          <button type="button" className={styles.iconBtn} onClick={downloadFrame} title="Download current frame (PNG)" aria-label="Download current frame">
            <Icon name="download" size={16} />
          </button>
          <button type="button" className={styles.iconBtn} onClick={() => openExportDialog(duration, fps)} title="Export video…" aria-label="Export video">
            <Icon name="export" size={16} />
          </button>
          <button type="button" className={styles.iconBtn} onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} aria-label="Toggle fullscreen">
            <Icon name={isFullscreen ? 'minimize' : 'maximize'} size={16} />
          </button>
          <button type="button" className={styles.iconBtn} onClick={handleExit} title="Exit presentation (Esc)" aria-label="Exit presentation">
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>

      <div className={styles.stage} ref={stageRef}>
        <canvas ref={canvasRef} className={styles.canvas} />
        {/* Loading spinner — shown until the first rAF fires (backend mounting).
            Prevents the user from seeing a blank stage and assuming it's broken. */}
        {!backendReady && !initError && (
          <div className={styles.stageLoader} aria-label="Loading preview…">
            <div className={styles.stageSpinner} />
          </div>
        )}
        {/* The renderer could not start. Presentation Mode is the LAST GPU
            context the page creates, so it is the first to be refused when the
            browser's live-context cap is reached — and a silent black stage here
            reads as "my composition is broken" rather than "this window could
            not get a GPU". */}
        {initError && (
          <div className={styles.stageLoader} role="alert">
            <div className={styles.stageError}>
              <strong>Preview unavailable</strong>
              <span>{initError}</span>
            </div>
          </div>
        )}
      </div>

      {/* Player chrome. */}
      <div className={styles.controls}>
        <div className={styles.scrubRow}>
          <span className={styles.time}>{framesToTimecode(currentFrame, fps, startFrame)}</span>
          <div
            className={styles.scrub}
            ref={scrubRef}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={durationFrames}
            aria-valuenow={currentFrame}
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
          >
            <div className={styles.scrubTrack} />
            <div className={styles.scrubFill} style={{ width: pct }} />
            <div className={styles.scrubHandle} style={{ left: pct }} />
          </div>
          <span className={styles.time}>{framesToTimecode(durationFrames, fps, startFrame)}</span>
        </div>

        <div className={styles.transport}>
          <button type="button" className={styles.tBtn} onClick={() => getTimelineController().goToStart()} title="Go to start (Home)" aria-label="Go to start">
            <Icon name="skip-back" size={15} />
          </button>
          <button type="button" className={styles.tBtn} onClick={() => getTimelineController().previousFrame()} title="Previous frame (←)" aria-label="Previous frame">
            <Icon name="chevron-left" size={17} />
          </button>
          <button type="button" className={styles.play} onClick={togglePlay} title={playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={18} />
          </button>
          <button type="button" className={styles.tBtn} onClick={() => getTimelineController().nextFrame()} title="Next frame (→)" aria-label="Next frame">
            <Icon name="chevron-right" size={17} />
          </button>
          <button type="button" className={styles.tBtn} onClick={() => getTimelineController().goToEnd()} title="Go to end (End)" aria-label="Go to end">
            <Icon name="skip-forward" size={15} />
          </button>
          <button
            type="button"
            className={looping ? styles.tBtnActive : styles.tBtn}
            onClick={toggleLoop}
            title="Loop playback (L)"
            aria-label="Loop playback"
            aria-pressed={looping}
          >
            <Icon name="loop" size={15} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default PresentationMode;
