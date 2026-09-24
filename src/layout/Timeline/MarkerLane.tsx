/**
 * MarkerLane — the comp markers, as things you can grab.
 *
 * They used to be `aria-hidden` flags with a `title` and no pointer handlers:
 * you could add one from a menu and read its name on hover, and that was the
 * whole of it. Renaming meant deleting and re-adding at the right frame, which
 * is not a workflow, it is a workaround.
 *
 * ## Why a lane of its own, above the ruler
 *
 * A marker chip drawn INSIDE the ruler competes with the two gestures the ruler
 * already owns — scrubbing and the work-area band — and every one of the three
 * wants the same 26 pixels. Above it the chip has a row to itself, the ruler
 * keeps its whole height for scrubbing, and the marker's full-height guide can
 * still be drawn down through the lanes because the guide takes no pointer
 * events at all.
 *
 * ## The gestures
 *
 *   drag         → move (frame-snapped; see `markerGeometry.markerTimeAt`)
 *   double-click → the editor: name, colour, span
 *   right-click  → delete, with the editor as the other entry
 *   click        → seek to it, which is what a bookmark is FOR
 *
 * A press that has not travelled {@link MARKER_DRAG_THRESHOLD_PX} is a click,
 * not a zero-length drag: without the threshold every click wrote a "Move
 * Marker" undo entry that moved nothing.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@utils/cn';
import { Icon } from '@components/Icon';
import { openContextMenu } from '@stores/contextMenuStore';
import { documentMirror } from '@stores/documentMirror';
import { markerViewOf, mirrorMarkerById } from '@core/mirror/markers';
import type { TimelineMarker } from './TimelineModel';
import { deleteMarker, updateMarker } from './markerCommands';
import { activeCompId } from './timelineEdits';
import {
  MARKER_COLORS,
  MARKER_DRAG_THRESHOLD_PX,
  MARKER_LANE_HEIGHT,
  markerTimeAt,
  markerX,
} from './markerGeometry';
import styles from './Timeline.module.css';

interface MarkerLaneProps {
  markers: ReadonlyArray<TimelineMarker>;
  pps: number;
  leftOffset: number;
  /** Lane content width, so the strip spans the scrolled area. */
  width: number;
  fps: number;
  /** Comp duration, seconds — a marker cannot be dragged past the end. */
  duration: number;
  /** Frame-snap the drag. Follows the panel's snap switch. */
  snap: boolean;
  onSeek?: (time: number) => void;
}

/** What the editor popover is open on, and where it sits. */
interface EditorState {
  id: string;
  x: number;
  y: number;
}

function MarkerLaneImpl({
  markers,
  pps,
  leftOffset,
  width,
  fps,
  duration,
  snap,
  onSeek,
}: MarkerLaneProps): JSX.Element {
  const [editor, setEditor] = useState<EditorState | null>(null);
  /** Live preview x while dragging, so the chip tracks the pointer. */
  const [preview, setPreview] = useState<{ id: string; time: number } | null>(null);
  const drag = useRef<null | { id: string; startX: number; startTime: number; moved: boolean }>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);

  const onMarkerDown = useCallback(
    (marker: TimelineMarker, e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      drag.current = { id: marker.id, startX: e.clientX, startTime: marker.time, moved: false };
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (!d.moved && Math.abs(dx) < MARKER_DRAG_THRESHOLD_PX) return;
      d.moved = true;
      const time = markerTimeAt(
        markerX(d.startTime, pps, leftOffset) + dx,
        pps,
        leftOffset,
        { fps, snap, duration },
      );
      setPreview({ id: d.id, time });
    };
    const onUp = (): void => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      const moved = d.moved;
      const time = preview?.id === d.id ? preview.time : null;
      setPreview(null);
      if (moved && time !== null) updateMarker(d.id, { time });
      // A press that never travelled is a click: seek to the marker, which is
      // the whole reason a bookmark exists.
      else if (!moved) onSeek?.(d.startTime);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pps, leftOffset, fps, snap, duration, preview, onSeek]);

  return (
    <div
      ref={laneRef}
      className={styles.markerLane}
      style={{ height: MARKER_LANE_HEIGHT, width }}
      role="group"
      aria-label="Composition markers"
    >
      {markers.map((m) => {
        const time = preview?.id === m.id ? preview.time : m.time;
        return (
          <div
            key={m.id}
            className={cn(styles.markerChip, preview?.id === m.id && styles.markerChipDragging)}
            style={{ left: markerX(time, pps, leftOffset), background: m.color ?? undefined }}
            title={`${m.label} — drag to move, double-click to edit, right-click to delete`}
            aria-label={`Marker ${m.label}`}
            onPointerDown={(e) => onMarkerDown(m, e)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              // The press that opened this also armed a drag; disarm it or the
              // release lands as a click and seeks away from the popover.
              drag.current = null;
              setEditor({ id: m.id, x: e.clientX, y: e.clientY });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              drag.current = null;
              openContextMenu(e.clientX, e.clientY, [
                {
                  id: 'edit-marker',
                  label: 'Edit Marker…',
                  onSelect: () => setEditor({ id: m.id, x: e.clientX, y: e.clientY }),
                },
                { id: 'sep', separator: true },
                {
                  id: 'delete-marker',
                  label: 'Delete Marker',
                  danger: true,
                  onSelect: () => deleteMarker(m.id),
                },
              ]);
            }}
          >
            <Icon name="marker" size="sm" />
            <span className={styles.markerChipLabel}>{m.label}</span>
          </div>
        );
      })}

      {editor ? (
        <MarkerEditor id={editor.id} x={editor.x} y={editor.y} onClose={() => setEditor(null)} />
      ) : null}
    </div>
  );
}

/**
 * The editor popover.
 *
 * Reads the marker's CURRENT values from the controller rather than from the
 * `TimelineModel`, because the model deliberately carries only what has to be
 * drawn — no comment, no span. Widening the model to feed one popover would
 * rebuild every row whenever anyone typed a note.
 */
function MarkerEditor({
  id,
  x,
  y,
  onClose,
}: {
  id: string;
  x: number;
  y: number;
  onClose: () => void;
}): JSX.Element | null {
  // The popover's starting values, read once from the document mirror (B4).
  const found = mirrorMarkerById(documentMirror(), activeCompId(), id);
  const initial = found ? markerViewOf(found) : null;
  const [label, setLabel] = useState(initial?.label ?? 'Marker');
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [durationText, setDurationText] = useState(String(initial?.duration ?? 0));
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent): void => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  if (!initial) return null;

  const commit = (): void => {
    const seconds = Number(durationText);
    updateMarker(id, {
      label,
      comment,
      // A span that will not parse is left alone rather than zeroed: silently
      // turning a two-second marker into a point because of a stray keystroke
      // is a worse answer than ignoring the field.
      ...(Number.isFinite(seconds) && seconds >= 0 ? { duration: seconds } : {}),
    });
    onClose();
  };

  return (
    <div
      ref={ref}
      className={styles.markerEditor}
      style={{ left: x, top: y }}
      role="dialog"
      aria-label="Edit marker"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <label className={styles.markerEditorRow}>
        <span>Name</span>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      </label>
      <label className={styles.markerEditorRow}>
        <span>Comment</span>
        <input value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <label className={styles.markerEditorRow}>
        <span>Duration</span>
        <input
          value={durationText}
          inputMode="decimal"
          onChange={(e) => setDurationText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      </label>
      <div className={styles.markerSwatches} role="group" aria-label="Marker colour">
        {MARKER_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={cn(styles.markerSwatch, initial.color === c.token && styles.markerSwatchActive)}
            style={{ background: c.token }}
            title={c.label}
            aria-label={c.label}
            // Colour applies immediately: it is a one-click choice with a
            // visible result, and making it wait for a save button is how a
            // three-field popover starts feeling like a form.
            onClick={() => updateMarker(id, { color: c.token })}
          />
        ))}
      </div>
      <div className={styles.markerEditorActions}>
        <button type="button" onClick={() => { deleteMarker(id); onClose(); }}>Delete</button>
        <button type="button" onClick={commit}>Done</button>
      </div>
    </div>
  );
}

export const MarkerLane = memo(MarkerLaneImpl);
export default MarkerLane;
