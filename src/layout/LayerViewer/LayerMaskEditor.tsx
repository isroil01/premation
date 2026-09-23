/**
 * LayerMaskEditor — drawing and reshaping masks in the Layer panel, where
 * After Effects does that work.
 *
 * Tools (the Layer panel header picks one):
 *   • Select — drag a vertex (its handles follow), a handle of the picked
 *     vertex (the opposite one mirrors; Alt breaks them), or a path's outline
 *     to move the whole mask. Delete removes the picked mask.
 *   • Rectangle / Ellipse — drag out a new mask.
 *   • Pen — click for a corner, drag for a smooth point; click the first point
 *     (or press Enter) to close it; Backspace takes back the last point; Esc
 *     throws the draft away.
 *
 * Everything is in the layer's own space, so the panel's fit is the only
 * mapping (`maskEditing`). A drag previews on a local draft and writes ONCE
 * on release, as one undo step. Writes go through `setMaskPoints` /
 * `addMaskPath` at the time the renderer samples the mask, so on an animated
 * mask an edit lands on a keyframe at that moment, as in AE.
 *
 * The SVG takes focus on press and CLAIMS Delete / Backspace / Esc / Enter
 * (`data-shortcut-claim`): the global dispatcher runs first on every key, and
 * Delete there means "delete the selected LAYER".
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  readNodeMask,
  readNodeMaskAt,
  type MaskPath,
  type MaskPoint,
} from '@core/effects/mask';
import { edit } from '@core/engine/uiEdits';
import { addMaskEdit, deleteMaskEdit, maskPathCommand } from '@layout/Workspace/viewportEdits';
import { useLayerViewerStore } from '@stores/layerViewerStore';
import { cn } from '@utils/cn';
import { shortId } from '@utils/lang';
import {
  localToScreen,
  maskFromDrag,
  moveHandle,
  moveVertex,
  penPath,
  penPoint,
  screenToLocal,
  translatePoints,
  type ViewFit,
} from './maskEditing';
import styles from './LayerViewer.module.css';

export interface LayerMaskEditorProps {
  nodeId: string;
  frameWidth: number;
  frameHeight: number;
  view: ViewFit;
  stageWidth: number;
  stageHeight: number;
  /** The mask's time on the layer's keyframe axis — where the renderer reads it (drawing). */
  maskTime: number;
  /** The same moment in comp seconds — where edits land (the engine maps it to the key axis). */
  maskCompTime: number;
}

type Drag =
  | { kind: 'vertex'; pathId: string; index: number; startX: number; startY: number; points: MaskPoint[] }
  | { kind: 'handle'; pathId: string; index: number; which: 'in' | 'out'; points: MaskPoint[] }
  | { kind: 'path'; pathId: string; startX: number; startY: number; points: MaskPoint[] }
  | { kind: 'shape'; shape: 'rect' | 'ellipse'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'pen'; x: number; y: number; dragX: number; dragY: number };

/** Screen px within which a click on the pen's first point closes the path. */
const CLOSE_RADIUS = 8;

function pathD(points: ReadonlyArray<MaskPoint>, closed: boolean, map: (x: number, y: number) => [number, number]): string {
  if (points.length === 0) return '';
  const [x0, y0] = map(points[0]!.x, points[0]!.y);
  let d = `M${x0} ${y0}`;
  const seg = (a: MaskPoint, b: MaskPoint): void => {
    const [c1x, c1y] = map(a.outX, a.outY);
    const [c2x, c2y] = map(b.inX, b.inY);
    const [bx, by] = map(b.x, b.y);
    d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${bx} ${by}`;
  };
  for (let i = 1; i < points.length; i++) seg(points[i - 1]!, points[i]!);
  if (closed && points.length > 1) {
    seg(points[points.length - 1]!, points[0]!);
    d += ' Z';
  }
  return d;
}

export function LayerMaskEditor({
  nodeId, frameWidth: w, frameHeight: h, view, stageWidth, stageHeight, maskTime, maskCompTime,
}: LayerMaskEditorProps): JSX.Element | null {
  const tool = useLayerViewerStore((s) => s.maskTool);
  const selection = useLayerViewerStore((s) => s.maskSelection);
  const selectMask = useLayerViewerStore((s) => s.selectMask);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pen, setPen] = useState<MaskPoint[]>([]);

  const node = defaultSceneGraph.getNode(nodeId);
  const locked = node?.locked === true;
  const mask = node ? readNodeMaskAt(node, maskTime) ?? readNodeMask(node) : undefined;
  const paths: MaskPath[] = mask?.paths ?? [];

  // A tool change abandons a half-drawn pen path.
  useEffect(() => { setPen([]); }, [tool, nodeId]);

  const map = useMemo(
    () => (x: number, y: number): [number, number] => localToScreen(view, w, h, x, y),
    [view, w, h],
  );
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current?.getBoundingClientRect();
    return screenToLocal(view, w, h, e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
  };

  // One entry per release. On an animated mask the engine keys the shape at
  // this moment (AE); on a static one it reshapes the mask itself.
  const commitPoints = async (pathId: string, points: MaskPoint[], label: string): Promise<void> => {
    const closed = paths.find((p) => p.id === pathId)?.closed ?? true;
    await edit(label, maskPathCommand(nodeId, pathId, points, closed, maskCompTime));
  };
  const commitNew = (path: MaskPath): void => {
    // The engine mints the mask's id; the new mask is selected once it exists.
    void addMaskEdit(nodeId, path).then((id) => {
      if (id) selectMask({ pathId: id, point: null });
    });
  };
  const finishPen = (): void => {
    const path = penPath(pen, `mask_lp_${shortId()}`);
    setPen([]);
    if (path) commitNew(path);
  };

  const capture = (e: ReactPointerEvent<SVGElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    svgRef.current?.focus();
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  // ── Presses ────────────────────────────────────────────────────────
  const onStageDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (locked || e.button !== 0) return;
    capture(e);
    const [x, y] = local(e);
    if (tool === 'rect' || tool === 'ellipse') {
      setDrag({ kind: 'shape', shape: tool, x0: x, y0: y, x1: x, y1: y });
    } else if (tool === 'pen') {
      const first = pen[0];
      if (first && pen.length >= 3) {
        const [fx, fy] = map(first.x, first.y);
        const [sx, sy] = map(x, y);
        if (Math.hypot(fx - sx, fy - sy) <= CLOSE_RADIUS) { finishPen(); return; }
      }
      setDrag({ kind: 'pen', x, y, dragX: x, dragY: y });
    } else {
      selectMask(null);
    }
  };
  const onVertexDown = (e: ReactPointerEvent<SVGElement>, path: MaskPath, index: number): void => {
    if (locked || tool !== 'select' || e.button !== 0) return;
    capture(e);
    const [x, y] = local(e);
    selectMask({ pathId: path.id, point: index });
    setDrag({ kind: 'vertex', pathId: path.id, index, startX: x, startY: y, points: path.points });
  };
  const onHandleDown = (e: ReactPointerEvent<SVGElement>, path: MaskPath, index: number, which: 'in' | 'out'): void => {
    if (locked || tool !== 'select' || e.button !== 0) return;
    capture(e);
    setDrag({ kind: 'handle', pathId: path.id, index, which, points: path.points });
  };
  const onPathDown = (e: ReactPointerEvent<SVGElement>, path: MaskPath): void => {
    if (locked || tool !== 'select' || e.button !== 0) return;
    capture(e);
    const [x, y] = local(e);
    selectMask({ pathId: path.id, point: null });
    setDrag({ kind: 'path', pathId: path.id, startX: x, startY: y, points: path.points });
  };

  // ── Drag + release ─────────────────────────────────────────────────
  const [draftPoints, setDraftPoints] = useState<{ pathId: string; points: MaskPoint[] } | null>(null);
  const onMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drag) return;
    const [x, y] = local(e);
    switch (drag.kind) {
      case 'vertex':
        setDraftPoints({ pathId: drag.pathId, points: moveVertex(drag.points, drag.index, x - drag.startX, y - drag.startY) });
        break;
      case 'handle':
        setDraftPoints({ pathId: drag.pathId, points: moveHandle(drag.points, drag.index, drag.which, x, y, e.altKey) });
        break;
      case 'path':
        setDraftPoints({ pathId: drag.pathId, points: translatePoints(drag.points, x - drag.startX, y - drag.startY) });
        break;
      case 'shape':
        setDrag({ ...drag, x1: x, y1: y });
        break;
      case 'pen':
        setDrag({ ...drag, dragX: x, dragY: y });
        break;
    }
  };
  const onUp = (): void => {
    if (!drag) return;
    if (drag.kind === 'shape') {
      const path = maskFromDrag(drag.shape, drag.x0, drag.y0, drag.x1, drag.y1);
      if (path) commitNew(path);
    } else if (drag.kind === 'pen') {
      setPen((pts) => [...pts, penPoint(drag.x, drag.y, drag.dragX, drag.dragY)]);
    } else if (draftPoints) {
      const label = drag.kind === 'path' ? 'Move Mask' : 'Edit Mask';
      // The draft stays drawn until the engine has applied the edit, so the
      // outline never flashes back to its pre-drag shape for a frame.
      const committed = draftPoints;
      setDrag(null);
      void commitPoints(committed.pathId, committed.points, label).finally(() => {
        setDraftPoints((d) => (d === committed ? null : d));
      });
      return;
    }
    setDrag(null);
    setDraftPoints(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>): void => {
    if (e.key === 'Escape') {
      if (pen.length > 0) setPen([]);
      else selectMask(null);
    } else if (e.key === 'Enter') {
      finishPen();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && pen.length > 0) {
      // Mid-draw, take back the last pen vertex — not the selected mask.
      setPen((pts) => pts.slice(0, -1));
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection && !locked) {
      const pathId = selection.pathId;
      selectMask(null);
      void deleteMaskEdit(nodeId, pathId);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  if (!node) return null;

  const shown = (p: MaskPath): MaskPoint[] => (draftPoints?.pathId === p.id ? draftPoints.points : p.points);
  const sel = selection && paths.find((p) => p.id === selection.pathId) ? selection : null;
  const selPath = sel ? paths.find((p) => p.id === sel.pathId) : undefined;
  const selPoint = selPath && sel?.point !== null && sel?.point !== undefined ? shown(selPath)[sel.point] : undefined;

  // Drafts of new shapes.
  const shapeDraft = drag?.kind === 'shape' ? maskFromDrag(drag.shape, drag.x0, drag.y0, drag.x1, drag.y1) : null;
  const penDraft = drag?.kind === 'pen' ? [...pen, penPoint(drag.x, drag.y, drag.dragX, drag.dragY)] : pen;

  return (
    <svg
      ref={svgRef}
      className={cn(styles.maskEditor, tool !== 'select' && styles.maskEditorDraw)}
      width={stageWidth}
      height={stageHeight}
      tabIndex={0}
      aria-label="Layer masks"
      data-shortcut-claim="delete backspace escape enter"
      onPointerDown={onStageDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKeyDown}
    >
      {paths.map((p) => {
        const pts = shown(p);
        const d = pathD(pts, p.closed, map);
        const picked = sel?.pathId === p.id;
        return (
          <g key={p.id}>
            {/* A wide invisible stroke makes the outline easy to grab. */}
            <path d={d} className={styles.maskHit} onPointerDown={(e) => onPathDown(e, p)} />
            <path d={d} className={cn(styles.mask, picked && styles.maskPicked)} />
            {tool === 'select' && !locked
              ? pts.map((pt, i) => {
                  const [vx, vy] = map(pt.x, pt.y);
                  const on = picked && sel?.point === i;
                  return (
                    <rect
                      key={i}
                      x={vx - 4}
                      y={vy - 4}
                      width={8}
                      height={8}
                      className={cn(styles.vertex, on && styles.vertexOn)}
                      onPointerDown={(e) => onVertexDown(e, p, i)}
                    />
                  );
                })
              : null}
          </g>
        );
      })}

      {/* Bezier handles of the picked vertex. */}
      {selPath && selPoint && sel?.point !== null && sel?.point !== undefined && tool === 'select' ? (
        (['in', 'out'] as const).map((which) => {
          const hx = which === 'in' ? selPoint.inX : selPoint.outX;
          const hy = which === 'in' ? selPoint.inY : selPoint.outY;
          const [vx, vy] = map(selPoint.x, selPoint.y);
          const [sx, sy] = map(hx, hy);
          return (
            <g key={which}>
              <line x1={vx} y1={vy} x2={sx} y2={sy} className={styles.handleLine} />
              <circle
                cx={sx}
                cy={sy}
                r={4}
                className={styles.handle}
                onPointerDown={(e) => onHandleDown(e, selPath, sel.point!, which)}
              />
            </g>
          );
        })
      ) : null}

      {shapeDraft ? <path d={pathD(shapeDraft.points, true, map)} className={styles.maskDraft} /> : null}
      {penDraft.length > 0 ? (
        <g>
          <path d={pathD(penDraft, false, map)} className={styles.maskDraft} />
          {penDraft.map((pt, i) => {
            const [vx, vy] = map(pt.x, pt.y);
            return <rect key={i} x={vx - 3} y={vy - 3} width={6} height={6} className={styles.vertex} />;
          })}
        </g>
      ) : null}
    </svg>
  );
}

export default LayerMaskEditor;
