/**
 * The lane-side row content: a track's clip bars (with their waveform and
 * trim handles), its collapsed keyframe summary, its layer markers, and the
 * positioned row wrapper. Split out of `Timeline.tsx`.
 */

import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@utils/cn';
import { clipHandleLayout } from './clipHandleLayout';
import type { TimelineTrack, TimelineClip, TimelineMarker } from './TimelineModel';
import { openContextMenu } from '@stores/contextMenuStore';
import { audioEngine } from '@core/audio/AudioEngine';
import { waveformPath, peaksInRange } from '@core/audio/waveform';
import { spanInWindow, timeInWindow, type TimeWindow } from './visibleWindow';
import styles from './Timeline.module.css';
import { MARKER_DRAG_THRESHOLD_PX } from './markerGeometry';
import { deleteMarker, updateMarker } from './markerCommands';
import { TIMELINE_LEFT_OFFSET } from './timelineShared';
import { areRowPropsEqual } from './rowMemo';

/**
 * One clip bar. Its own component so the WAVEFORM work is memoised per bar:
 * the SVG path is rebuilt only when the bar's window onto its source, its
 * width or the peaks themselves change — not on every render of the row —
 * and the bar subscribes to the audio engine ITSELF, so a decoded waveform
 * repaints the one bar that shows it rather than the whole panel.
 */
export const ClipBar = memo(function ClipBar({
  clip,
  view,
  trackId,
  trackColor,
  pps,
  trackHeight,
  selected,
  locked,
  onClipDown,
  onClipContextMenu,
  onActivate,
}: {
  clip: TimelineClip;
  /** The bar's live geometry — the drag preview when one is in flight. */
  view: { start: number; duration: number; sourceInSec?: number };
  trackId: string;
  trackColor?: string;
  pps: number;
  trackHeight: number;
  selected: boolean;
  locked: boolean;
  onClipDown?: (clip: TimelineClip, mode: 'move' | 'start' | 'end', e: ReactPointerEvent<HTMLDivElement>, locked: boolean) => void;
  onClipContextMenu?: (clipId: string, clientX: number, clientY: number) => void;
  onActivate?: (nodeId: string) => void;
}): JSX.Element {
  const wave = useWaveform(clip.assetId);
  const width = Math.max(2, view.duration * pps);
  const height = trackHeight - 6;
  // Slice to the bar's own window onto the source. Drawing `wave.peaks`
  // whole squeezed the entire file into the bar, so the peaks under the
  // playhead were not the audio you would hear there.
  const sourceInSec = view.sourceInSec ?? clip.sourceInSec;
  const sourceOutSec = sourceInSec !== undefined ? sourceInSec + view.duration : clip.sourceOutSec;
  const pathD = useMemo(() => {
    if (!wave) return '';
    const slice =
      sourceInSec !== undefined && sourceOutSec !== undefined
        ? peaksInRange(wave, sourceInSec, sourceOutSec)
        : wave.peaks;
    return slice ? waveformPath(slice, width, height) : '';
  }, [wave, sourceInSec, sourceOutSec, width, height]);
  // A bar narrower than three handle widths is all handle: the body could not
  // be grabbed at all. Below that the handles shrink and the body wins; on a
  // bar too thin to hold any body beside them they are not drawn at all.
  const { narrow, handleWidth } = clipHandleLayout(width);
  const baseColor = clip.color ?? 'var(--color-primary)';
  return (
    <div
      className={cn(styles.clip, selected && styles.clipSelected, locked && styles.clipLocked)}
      data-narrow={narrow || undefined}
      style={{
        ['--clip-handle-w' as string]: `${handleWidth}px`,
        transform: `translateX(${TIMELINE_LEFT_OFFSET + view.start * pps}px)`,
        width,
        height,
        // Tinted by the layer's label colour, so the lanes read the same
        // colour code as the header column's bar.
        background: trackColor ? `color-mix(in srgb, ${baseColor} 62%, ${trackColor})` : baseColor,
        border: 'none',
        cursor: locked ? 'not-allowed' : onClipDown ? 'grab' : undefined,
      }}
      title={locked ? `${clip.label ?? clip.id} — locked` : clip.label ?? clip.id}
      onPointerDown={onClipDown ? (e) => onClipDown(clip, 'move', e, locked) : undefined}
      onContextMenu={
        onClipContextMenu
          ? (e) => {
            e.preventDefault();
            onClipContextMenu(clip.id, e.clientX, e.clientY);
          }
          : undefined
      }
      onDoubleClick={onActivate ? () => onActivate(trackId) : undefined}
    >
      {pathD && (
        <svg className={styles.clipWave} aria-hidden focusable="false">
          <path d={pathD} fill="currentColor" />
        </svg>
      )}
      {onClipDown && !locked && handleWidth > 0 ? (
        <>
          <div
            className={styles.clipHandle}
            data-edge="start"
            onPointerDown={(e) => onClipDown(clip, 'start', e, locked)}
          />
          <div
            className={styles.clipHandle}
            data-edge="end"
            onPointerDown={(e) => onClipDown(clip, 'end', e, locked)}
          />
        </>
      ) : null}
      {/* No speaker on the bar: AE's audio switch is the A/V column's, and
          two mute buttons per layer was one too many (2026-10-07). */}
      <span className={styles.clipLabel}>{clip.label ?? clip.id}</span>
    </div>
  );
}, areRowPropsEqual);

/**
 * This asset's waveform, re-read when the audio engine reports a change.
 * A per-bar subscription: the panel used to `forceUpdate` itself on every
 * engine change, re-rendering every row for one decoded file.
 */
function useWaveform(assetId: string | undefined): ReturnType<typeof audioEngine.getWaveform> {
  const [wave, setWave] = useState(() => (assetId ? audioEngine.getWaveform(assetId) : undefined));
  useEffect(() => {
    if (!assetId) {
      setWave(undefined);
      return;
    }
    const read = (): void => setWave((prev) => {
      const next = audioEngine.getWaveform(assetId);
      return next === prev ? prev : next;
    });
    read();
    return audioEngine.onChange(read);
  }, [assetId]);
  return wave;
}

/** A track's lane content: the calm animation block + (collapsed) keyframes. */
export const TrackContent = memo(function TrackContent({
  track,
  ghosted,
  pps,
  trackHeight,
  top,
  selected,
  clipPreviews,
  window,
  onClipDown,
  onClipContextMenu,
  onActivate,
}: {
  track: TimelineTrack;
  ghosted: boolean;
  pps: number;
  trackHeight: number;
  top: number;
  /** This layer is in the selection — the bar carries the highlight so the
   *  lanes show what is selected without a trip back to the name column. */
  selected: boolean;
  /** Only ever non-null for the row whose bar is being dragged — see `dragOverlay.ts`. */
  clipPreviews: ReadonlyArray<{ id: string; start: number; duration: number; sourceInSec?: number }> | null;
  /** The stretch of the comp worth painting — bars outside it are skipped. */
  window: TimeWindow;
  onClipDown?: (clip: TimelineClip, mode: 'move' | 'start' | 'end', e: ReactPointerEvent<HTMLDivElement>, locked: boolean) => void;
  onClipContextMenu?: (clipId: string, clientX: number, clientY: number) => void;
  onActivate?: (nodeId: string) => void;
}): JSX.Element {
  const locked = track.locked === true;
  return (
    <LaneRow top={top} trackHeight={trackHeight} ghosted={ghosted}>
      {/* Clips — body: move / Alt-slip / Shift+Alt-slide; edges: trim. */}
      {track.clips?.map((clip) => {
        const view = clipPreviews?.find((p) => p.id === clip.id) ?? clip;
        if (!spanInWindow(view.start, view.start + view.duration, window)) return null;
        return (
          <ClipBar
            key={clip.id}
            clip={clip}
            view={view}
            trackId={track.id}
            trackColor={track.color}
            pps={pps}
            trackHeight={trackHeight}
            selected={selected}
            locked={locked}
            onClipDown={onClipDown}
            onClipContextMenu={onClipContextMenu}
            onActivate={onActivate}
          />
        );
      })}

      {/* Layer markers — anchored to this row, on the comp axis (AE draws them
          on the layer bar, and they move with a trimmed layer because the
          engine stores them layer-relative). */}
      {track.markers?.map((m) => (
        timeInWindow(m.time, window) ? (
          <LayerMarker key={m.id} marker={m} pps={pps} locked={locked} />
        ) : null
      ))}
    </LaneRow>
  );
}, areRowPropsEqual);

/**
 * One LAYER marker, with the same three gestures the comp markers have.
 *
 * Its own component because each one owns a drag: a shared handler on the row
 * would have to carry "which marker" through a ref, and the row is memoised
 * precisely so it does not re-render while one of its children is being
 * dragged.
 *
 * The write goes through `updateMarker`, which maps comp seconds back to LAYER
 * seconds — a layer marker is STORED relative to its layer's in-point so it
 * travels with a trim, and writing a comp time straight into it puts every
 * marker on a layer starting at 2s two seconds early.
 */
export function LayerMarker({
  marker,
  pps,
  locked,
}: {
  marker: TimelineMarker;
  pps: number;
  locked: boolean;
}): JSX.Element {
  const drag = useRef<null | { startX: number; startTime: number; moved: boolean }>(null);
  const [preview, setPreview] = useState<number | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (!d.moved && Math.abs(dx) < MARKER_DRAG_THRESHOLD_PX) return;
      d.moved = true;
      setPreview(Math.max(0, d.startTime + dx / (pps || 1)));
    };
    const onUp = (): void => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (d.moved && preview !== null) updateMarker(marker.id, { time: preview });
      setPreview(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pps, preview, marker.id]);

  const time = preview ?? marker.time;
  return (
    <div
      className={styles.layerMarker}
      style={{ left: `${TIMELINE_LEFT_OFFSET + time * pps}px`, background: marker.color ?? undefined }}
      title={locked ? `${marker.label} — locked` : `${marker.label} — drag to move, right-click to delete`}
      onPointerDown={(e) => {
        if (locked || e.button !== 0) return;
        // Stopped so the press does not also start a CLIP drag on the bar this
        // marker is sitting on top of.
        e.stopPropagation();
        e.preventDefault();
        drag.current = { startX: e.clientX, startTime: marker.time, moved: false };
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        drag.current = null;
        if (locked) return;
        openContextMenu(e.clientX, e.clientY, [
          {
            id: 'delete-layer-marker',
            label: 'Delete Layer Marker',
            danger: true,
            onSelect: () => deleteMarker(marker.id),
          },
        ]);
      }}
    />
  );
}

export function LaneRow({
  top,
  trackHeight,
  ghosted,
  children,
}: {
  top: number;
  trackHeight: number;
  ghosted?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={styles.laneRow}
      style={{ position: 'absolute', top, left: 0, right: 0, height: trackHeight, opacity: ghosted ? 0.32 : undefined }}
    >
      {children}
    </div>
  );
}
