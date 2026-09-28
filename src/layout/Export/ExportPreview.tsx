/**
 * ExportPreview — what the export will actually contain.
 *
 * The dialog used to be a set of buttons with no picture: the first time anyone
 * saw an export was after the file was written, which is how a black render made
 * it all the way to a player before anyone noticed. This shows the ENGINE's
 * frame of the composition (`getThumbnail` — the renderer the export runs),
 * scrubbable across the export range.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { secondsToFlicks } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import styles from './ExportPreview.module.css';

interface ExportPreviewProps {
  width: number;
  height: number;
  fps: number;
  /** Length of the export in seconds (the work area, or the whole comp). */
  durationSec: number;
  /** Comp time the export range begins at — nonzero when a work area is set. */
  startSec?: number;
  /** The composition exported. */
  compId: string;
  /** Show a checkerboard behind the frame (the export keeps alpha). */
  transparent?: boolean;
  /** Paused while an export is running — the GPU is busy with real frames. */
  disabled?: boolean;
  /** Still-frame export: hide the range scrubber. */
  singleFrame?: boolean;
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
  compId,
  transparent = false,
  disabled = false,
  singleFrame = false,
}: ExportPreviewProps): JSX.Element {
  // The frame shown: an object URL over the engine's encoded thumbnail.
  const [src, setSrc] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  // The scrubber addresses frames WITHIN the export range; comp time is derived.
  // Tracking the frame index rather than a time keeps the slider exact and makes
  // "frame 1 of N" mean the first frame of the export, not of the composition.
  const [frame, setFrame] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const frameCount = Math.max(1, Math.round(durationSec * fps));
  const clampedFrame = Math.max(0, Math.min(frame, frameCount - 1));
  const time = startSec + clampedFrame / fps;

  // The last frame's URL is revoked when the dialog goes.
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  // Continuous playback loop at the composition's frame rate.
  useEffect(() => {
    if (!isPlaying || disabled || singleFrame || frameCount <= 1) return;
    let animId: number;
    let lastTime = performance.now();
    let accumulatedSec = 0;

    const tick = (now: number) => {
      const deltaSec = Math.min(0.25, (now - lastTime) / 1000);
      lastTime = now;
      accumulatedSec += deltaSec;
      const stepSec = 1 / Math.max(1, fps);
      if (accumulatedSec >= stepSec) {
        const framesToAdvance = Math.floor(accumulatedSec / stepSec);
        accumulatedSec -= framesToAdvance * stepSec;
        setFrame((prev) => (prev + framesToAdvance) % frameCount);
      }
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, disabled, singleFrame, frameCount, fps]);

  // Pause playback automatically when export begins or switching to still frame.
  useEffect(() => {
    if (disabled || singleFrame) {
      setIsPlaying(false);
    }
  }, [disabled, singleFrame]);

  // Ask again whenever the preview time or the size changes. A request in
  // flight is left to finish and its answer discarded — the `cancelled` guard
  // is what stops a fast scrub from painting frames out of order.
  useEffect(() => {
    if (disabled || !compId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await engine().query({
          type: 'getThumbnail',
          item: compId,
          time: secondsToFlicks(time),
          maxSize: Math.min(1280, Math.max(width, height)),
        });
        if (cancelled) return;
        if (!res.ok) throw new Error(res.error.message);
        const t = res.value;
        const url = URL.createObjectURL(new Blob([t.data as BlobPart], { type: `image/${t.format || 'png'}` }));
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setSrc(url);
        setError(null);
        setReady(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [width, height, compId, time, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;
      if (e.key === ' ' || e.code === 'Space') {
        if (!singleFrame) {
          e.preventDefault();
          setIsPlaying((p) => !p);
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIsPlaying(false);
        setFrame((f) => Math.max(0, f - (e.shiftKey ? 10 : 1)));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIsPlaying(false);
        setFrame((f) => Math.min(frameCount - 1, f + (e.shiftKey ? 10 : 1)));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setIsPlaying(false);
        setFrame(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setIsPlaying(false);
        setFrame(frameCount - 1);
      }
    },
    [disabled, singleFrame, frameCount],
  );

  return (
    <div
      className={styles.root}
      tabIndex={0}
      role="region"
      aria-label="Export preview and scrubber"
      onKeyDown={handleKeyDown}
    >
      <div
        className={transparent ? styles.stageTransparent : styles.stage}
        style={{ aspectRatio: `${Math.max(1, width)} / ${Math.max(1, height)}` }}
      >
        {src ? <img className={styles.canvas} src={src} alt="" draggable={false} /> : null}
        {error ? (
          <div className={styles.overlayError}>
            <Icon name="warning" size="md" />
            <span>{error}</span>
          </div>
        ) : !ready ? (
          <div className={styles.overlayMuted}>Preparing preview…</div>
        ) : null}
      </div>

      {singleFrame ? (
        <div className={styles.scrubRow}>
          <span className={styles.timecode}>{timecode(time, fps)} · playhead</span>
        </div>
      ) : (
        <div className={styles.scrubRow}>
          <IconButton
            aria-label={isPlaying ? 'Pause preview (Space)' : 'Play preview (Space)'}
            size="sm"
            disabled={disabled}
            onClick={() => setIsPlaying((p) => !p)}
            title={isPlaying ? 'Pause preview (Space)' : 'Play preview (Space)'}
          >
            <Icon name={isPlaying ? 'pause' : 'play'} size="sm" />
          </IconButton>
          <IconButton
            aria-label="Previous frame (Left arrow)"
            size="sm"
            disabled={disabled || clampedFrame <= 0}
            onClick={() => {
              setIsPlaying(false);
              setFrame((f) => Math.max(0, f - 1));
            }}
            title="Previous frame (Left arrow)"
          >
            <Icon name="chevron-left" size="sm" />
          </IconButton>
          <input
            type="range"
            className={styles.scrub}
            min={0}
            max={frameCount - 1}
            step={1}
            value={clampedFrame}
            disabled={disabled}
            aria-label="Preview frame"
            onChange={(e) => {
              setIsPlaying(false);
              setFrame(Number(e.target.value));
            }}
          />
          <IconButton
            aria-label="Next frame (Right arrow)"
            size="sm"
            disabled={disabled || clampedFrame >= frameCount - 1}
            onClick={() => {
              setIsPlaying(false);
              setFrame((f) => Math.min(frameCount - 1, f + 1));
            }}
            title="Next frame (Right arrow)"
          >
            <Icon name="chevron-right" size="sm" />
          </IconButton>
          <span className={styles.timecode}>
            {timecode(time, fps)} · {clampedFrame + 1}/{frameCount}
          </span>
        </div>
      )}
    </div>
  );
}
