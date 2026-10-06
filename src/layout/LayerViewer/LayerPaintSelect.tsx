/**
 * LayerPaintSelect — pick, move and delete paint strokes on the layer itself,
 * with the Selection tool, as in After Effects' Layer panel.
 *
 * Click a stroke to select it (the same selection the Paint panel's list
 * shows); drag it to move it — the stroke's own Transform ▸ Position, one undo
 * step; Delete removes it; Esc or a click on it again leaves it selected, a
 * click elsewhere on the layer goes to whatever is underneath (masks).
 *
 * Only the strokes themselves take the pointer, so the mask editor below keeps
 * everything else. Stroke points are read from the document mirror (the
 * stroke's Path property); a stroke whose Path is keyframed is asked of the
 * engine at the time on show.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { secondsToFlicks } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { mirrorPaintStrokeShapes, strokePointAt, type MirrorPaintStrokeShape } from '@core/mirror/paintStrokes';
import { deletePaintStroke, movePaintStroke } from '@core/engine/paintEdits';
import { usePaintStore } from '@stores/paintStore';
import { useUIStore } from '@stores/uiStore';
import { localToScreen, type ViewFit } from './maskEditing';
import styles from './LayerViewer.module.css';

export interface LayerPaintSelectProps {
  nodeId: string;
  frameWidth: number;
  frameHeight: number;
  view: ViewFit;
  stageWidth: number;
  stageHeight: number;
  /** Comp time on show — where a KEYFRAMED Path is read. */
  compTime: number;
}

/** A stroke narrower than this on screen is still this easy to hit. */
const MIN_HIT_PX = 10;
/** Less pointer travel than this is a click, not a move. */
const DRAG_SLOP_PX = 3;

interface Drag {
  strokeId: string;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  moved: boolean;
}

export function LayerPaintSelect({ nodeId, frameWidth: w, frameHeight: h, view, stageWidth, stageHeight, compTime }: LayerPaintSelectProps): JSX.Element | null {
  const tool = useUIStore((s) => s.activeTool) as string;
  const selected = usePaintStore((s) => (s.selectedStroke?.nodeId === nodeId ? s.selectedStroke.strokeId : null));
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const active = tool === 'select' || tool === 'direct-select';

  // The Layer viewer re-renders on every document revision, so this is current.
  const m = documentMirror();
  const layer = m.layer(nodeId);
  const tree = m.tree(nodeId);
  const stored: MirrorPaintStrokeShape[] = mirrorPaintStrokeShapes(m, nodeId);

  // A keyframed Path: the mirror carries only the un-keyed points, so the
  // shape at the time on show is asked of the engine (once per time / edit,
  // never per played frame — this overlay exists only under the Selection tool).
  const keyedIds = stored.filter((s) => s.pathKeyed).map((s) => s.id).join(',');
  const [keyedPoints, setKeyedPoints] = useState<Readonly<Record<string, ReadonlyArray<{ x: number; y: number }>>>>({});
  useEffect(() => {
    if (!active || keyedIds === '') {
      setKeyedPoints((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return undefined;
    }
    let stale = false;
    const ids = keyedIds.split(',');
    void engine().query({
      type: 'getPropertyValues',
      props: ids.map((id) => ({ layer: nodeId, path: `paint/${id}/path` })),
      time: secondsToFlicks(Math.max(0, compTime)),
      evaluated: false,
    }).then((res) => {
      if (stale || !res.ok) return;
      const next: Record<string, { x: number; y: number }[]> = {};
      res.value.values.forEach((v, i) => {
        const value = v.value;
        if (value?.kind !== 'path') return;
        const flat = value.value.vertices;
        const pts: { x: number; y: number }[] = [];
        for (let k = 0; k + 1 < flat.length; k += 2) pts.push({ x: flat[k]!, y: flat[k + 1]! });
        if (pts.length > 0) next[ids[i]!] = pts;
      });
      setKeyedPoints(next);
    });
    return () => { stale = true; };
    // `tree`: a new object on every change to the layer's properties.
  }, [active, keyedIds, nodeId, compTime, tree]);
  const strokes: MirrorPaintStrokeShape[] = stored.map((s) => (s.pathKeyed && keyedPoints[s.id] ? { ...s, points: keyedPoints[s.id]! } : s));
  const locked = layer?.switches.locked === true;

  // A selection naming a stroke that is gone (deleted, undone) is dropped.
  const stale = selected !== null && m.tree(nodeId) !== undefined && !strokes.some((s) => s.id === selected);
  useEffect(() => {
    if (stale) usePaintStore.getState().set({ selectedStroke: null });
  }, [stale]);

  if (!active || strokes.length === 0) return null;

  const d = (s: MirrorPaintStrokeShape, dx = 0, dy = 0): string =>
    s.points.map((p, i) => {
      const q = strokePointAt(s, p);
      const [x, y] = localToScreen(view, w, h, q.x, q.y);
      return `${i === 0 ? 'M' : 'L'}${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)}`;
    }).join(' ') + (s.points.length === 1 ? ' l0.01 0' : '');

  const onDown = (e: ReactPointerEvent<SVGPathElement>, s: MirrorPaintStrokeShape): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    svgRef.current?.focus({ preventScroll: true });
    usePaintStore.getState().set({ selectedStroke: { nodeId, strokeId: s.id } });
    if (locked) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ strokeId: s.id, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, moved: false });
  };
  const onMove = (e: ReactPointerEvent<SVGPathElement>): void => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const moved = drag.moved || Math.hypot(dx, dy) >= DRAG_SLOP_PX;
    setDrag({ ...drag, dx: moved ? dx : 0, dy: moved ? dy : 0, moved });
  };
  const onUp = (): void => {
    if (!drag) return;
    const done = drag;
    setDrag(null);
    if (!done.moved) return;
    const s = strokes.find((x) => x.id === done.strokeId);
    if (!s) return;
    // Screen px → the layer's px: the Layer viewer shows the layer untransformed.
    void movePaintStroke(nodeId, s.id, s.positionX + done.dx / view.scale, s.positionY + done.dy / view.scale);
  };

  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>): void => {
    if (selected === null) return;
    if (e.key === 'Escape') {
      usePaintStore.getState().set({ selectedStroke: null });
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !locked) {
      usePaintStore.getState().set({ selectedStroke: null });
      void deletePaintStroke(nodeId, selected);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <svg
      ref={svgRef}
      className={styles.paintSelect}
      width={stageWidth}
      height={stageHeight}
      tabIndex={-1}
      aria-label="Paint strokes"
      data-shortcut-claim="delete backspace escape"
      onKeyDown={onKeyDown}
    >
      {strokes.map((s) => {
        if (!s.visible || s.points.length === 0) return null;
        const isSel = s.id === selected;
        const live = drag && drag.strokeId === s.id ? drag : null;
        const path = d(s, live?.dx ?? 0, live?.dy ?? 0);
        const width = Math.max(MIN_HIT_PX, s.diameter * (s.scale / 100) * view.scale);
        return (
          <g key={s.id} data-paint-stroke={s.id} data-selected={isSel || undefined}>
            {isSel ? (
              <>
                <path d={path} className={styles.paintSelHalo} strokeWidth={width + 3} />
                <path d={path} className={styles.paintSelLine} />
              </>
            ) : null}
            <path
              d={path}
              className={styles.paintHit}
              strokeWidth={width}
              onPointerDown={(e) => onDown(e, s)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              <title>{`${s.name} — click to select, drag to move, Delete to remove`}</title>
            </path>
          </g>
        );
      })}
    </svg>
  );
}

export default LayerPaintSelect;
