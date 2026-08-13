/**
 * ExportPreview — what the export will actually contain.
 *
 * The dialog used to be a set of buttons with no picture: the first time anyone
 * saw an export was after the file was written, which is how a black render made
 * it all the way to a player before anyone noticed. This renders real export
 * frames through the real export path, scrubbable across the export range, and
 * says so plainly when a frame has nothing in it.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import type { SnapshotComp } from '@core/rendering/buildSnapshot';
import { createExportPreviewRenderer, type ExportPreviewRenderer } from '@core/export/exportPreview';
import styles from './ExportPreview.module.css';

interface ExportPreviewProps {
  width: number;
  height: number;
  fps: number;
  /** Length of the export in seconds (the work area, or the whole comp). */
  durationSec: number;
  /** Comp time the export range begins at — nonzero when a work area is set. */
  startSec?: number;
  comp: SnapshotComp;
  /** Paused while an export is running — the GPU is busy with real frames. */
  disabled?: boolean;
}

/** Timecode as `mm:ss:ff`, matching the timeline's readout. */
function timecode(seconds: number, fps: number): string {
  const total = Math.max(0, Math.round(seconds * fps));
  const frames = total % Math.max(1, Math.round(fps));
  const secs = Math.floor(total / Math.max(1, Math.round(fps)));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}:${pad(frames)}`;
}

export function ExportPreview({
  width,
  height,
  fps,
  durationSec,
  startSec = 0,
  comp,
  disabled = false,
}: ExportPreviewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<ExportPreviewRenderer | null>(null);
  // The scrubber addresses frames WITHIN the export range; comp time is derived.
  // Tracking the frame index rather than a time keeps the slider exact and makes
  // "frame 1 of N" mean the first frame of the export, not of the composition.
  const [frame, setFrame] = useState(0);
  const [blank, setBlank] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const frameCount = Math.max(1, Math.round(durationSec * fps));
  const clampedFrame = Math.min(frame, frameCount - 1);
  const time = startSec + clampedFrame / fps;

  // One renderer (and one GPU context) for the dialog's lifetime.
  useEffect(() => {
    let host = hostRef.current;
    let renderer: ExportPreviewRenderer;
    try {
      renderer = createExportPreviewRenderer();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    rendererRef.current = renderer;
    renderer.canvas.className = styles.canvas ?? '';
    host?.appendChild(renderer.canvas);
    return () => {
      rendererRef.current = null;
      renderer.canvas.remove();
      renderer.dispose();
      host = null;
    };
  }, []);

  // Re-render whenever the preview time or any output setting changes. A render
  // in flight is left to finish and its result discarded — the generation guard
  // is what stops a fast scrub from painting frames out of order.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || disabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const frame = await renderer.render({ width, height, fps, comp, time });
        if (cancelled) return;
        setBlank(frame.blank);
        setError(null);
        setReady(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [width, height, fps, comp, time, disabled]);

  return (
    <div className={styles.root}>
      <div
        ref={hostRef}
        className={comp.transparent ? styles.stageTransparent : styles.stage}
        style={{ aspectRatio: `${Math.max(1, width)} / ${Math.max(1, height)}` }}
      >
        {error ? (
          <div className={styles.overlayError}>
            <Icon name="warning" size="md" />
            <span>{error}</span>
          </div>
        ) : !ready ? (
          <div className={styles.overlayMuted}>Preparing preview…</div>
        ) : blank ? (
          <div className={styles.overlayWarn}>
            <Icon name="warning" size="md" />
            <span>
              Nothing is visible at this frame — an export starting here would look empty. Check layer
              visibility, the work area, and whether this composition is the active one.
            </span>
          </div>
        ) : null}
      </div>

      <div className={styles.scrubRow}>
        <input
          type="range"
          className={styles.scrub}
          min={0}
          max={frameCount - 1}
          step={1}
          value={clampedFrame}
          disabled={disabled}
          aria-label="Preview frame"
          onChange={(e) => setFrame(Number(e.target.value))}
        />
        <span className={styles.timecode}>
          {timecode(time, fps)} · {clampedFrame + 1}/{frameCount}
        </span>
      </div>
    </div>
  );
}
