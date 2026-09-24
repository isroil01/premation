/**
 * LayerPaintSurface — painting and Roto Brush in the Layer panel, where After
 * Effects does both.
 *
 * Active while the app's Paint, Eraser or Roto tool is (the toolbar, or the
 * Layer panel's own buttons); in any other mode it is not in the DOM, so the
 * mask editor underneath keeps the pointer.
 *
 *   • Paint / Eraser — drag to paint a stroke onto the layer (one undo step),
 *     committed through `commitPaintDrag`, so the Layer panel and the comp
 *     viewer apply the same rules: Duration / Write On, pen pressure and tilt,
 *     Shift continues the previous stroke, a stroke selected in the Paint panel
 *     has its Path replaced, Ctrl+Shift erases the Last Stroke Only. With the
 *     Clone Stamp, Alt-click sets the source. Ctrl-drag sets the Diameter;
 *     releasing Ctrl mid-drag switches to Hardness.
 *   • Roto — paint over the subject (Alt: background); on release the whole
 *     stroke set is re-segmented into the layer's Roto Brush mask, exactly as
 *     the comp viewer's `RotoBrushOverlay` does — same store, same segmenter.
 *
 * Points need no conversion: the Layer panel shows the layer untransformed, so
 * the panel's fit (`maskEditing.screenToLocal`) is the whole mapping into the
 * layer's own centred space, which is what paint strokes and roto strokes are
 * stored in — and the brush diameter is layer px as-is.
 */

import { useCallback, useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isPaintableKind } from '@core/paint/paintCoords';
import { commitPaintDrag } from '@core/engine/paintEdits';
import { ctrlDragBrush, penSample } from '@core/paint/paintCapture';
import { segmentStrokesToMask } from '@core/workspace/rotoBrushTool';
import { drawToolOptions } from '@motion/workspace';
import { assetIdOf } from '@core/source/sourceInfo';
import { useUIStore } from '@stores/uiStore';
import { useAssetStore } from '@stores/assetStore';
import { usePaintStore } from '@stores/paintStore';
import { useRotoBrushStore, type RotoStroke } from '@stores/rotoBrushStore';
import { bumpScene } from '@stores/sceneStore';
import { cn } from '@utils/cn';
import { appendPoint } from './layerPaint';
import { localToScreen, screenToLocal, type ViewFit } from './maskEditing';
import styles from './LayerViewer.module.css';

export interface LayerPaintSurfaceProps {
  nodeId: string;
  frameWidth: number;
  frameHeight: number;
  view: ViewFit;
  stageWidth: number;
  stageHeight: number;
  /** Comp time — where roto segments and where a paint stroke begins. */
  compTime: number;
}

type Pt = { x: number; y: number };
type Pen = { pressure: number; tiltX: number; tiltY: number } | null;

interface LiveStroke {
  points: Pt[];
  times: number[];
  pen: Pen[];
  shift: boolean;
  lastStrokeOnly: boolean;
}

interface SizeDrag {
  at: Pt;
  startX: number;
  start: { size: number; hardness: number };
}

export function LayerPaintSurface({
  nodeId, frameWidth: w, frameHeight: h, view, stageWidth, stageHeight, compTime,
}: LayerPaintSurfaceProps): JSX.Element | null {
  const tool = useUIStore((s) => s.activeTool) as string;
  const painting = tool === 'paint' || tool === 'eraser';
  const roto = tool === 'roto';

  const svgRef = useRef<SVGSVGElement>(null);
  const [live, setLive] = useState<LiveStroke | null>(null);
  const [sizeDrag, setSizeDrag] = useState<SizeDrag | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const rotoDown = useRef(false);

  const cloneSource = usePaintStore((s) => s.cloneSource);
  const paintMode = usePaintStore((s) => s.mode);
  const rotoStrokes = useRotoBrushStore((s) => s.strokes);
  const rotoLive = useRotoBrushStore((s) => s.live);
  const rotoSize = useRotoBrushStore((s) => s.size);
  const rotoBusy = useRotoBrushStore((s) => s.busy);
  const rotoStatus = useRotoBrushStore((s) => s.status);
  const [notice, setNotice] = useState<string | null>(null);

  // Roto strokes are in ONE layer's pixels — bind the store to this layer.
  useEffect(() => {
    if (roto) useRotoBrushStore.getState().setNode(nodeId);
  }, [roto, nodeId]);
  useEffect(() => { setNotice(null); }, [nodeId, tool]);

  const node = defaultSceneGraph.getNode(nodeId);
  const paintable = !!node && isPaintableKind(node);
  const locked = node?.locked === true;
  // The segmenter cuts the layer's SOURCE pixels, so Roto needs footage — a
  // solid or a comp layer has nothing for it to read.
  const assetId = node ? assetIdOf(node) : null;
  const assetType = useAssetStore((s) => (assetId ? s.assets.find((a) => a.id === assetId)?.type : undefined));
  const rotoable = assetType === 'video' || assetType === 'image';

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = svgRef.current?.getBoundingClientRect();
    const [x, y] = screenToLocal(view, w, h, e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
    return { x, y };
  };
  const toScreen = (p: Pt): Pt => {
    const [x, y] = localToScreen(view, w, h, p.x, p.y);
    return { x, y };
  };

  const finishRoto = useCallback((): void => {
    if (!rotoDown.current) return;
    rotoDown.current = false;
    const store = useRotoBrushStore.getState();
    const done = store.end();
    if (!done) return;
    store.setBusy(true);
    store.setStatus('Segmenting…');
    void segmentStrokesToMask(nodeId, useRotoBrushStore.getState().strokes, compTime, {
      featherPx: store.featherPx,
      replacePathId: store.maskPathId,
    })
      .then((pathId) => {
        const s = useRotoBrushStore.getState();
        s.setMaskPathId(pathId);
        s.setStatus(pathId ? null : 'Nothing to segment there — paint over the subject.');
        bumpScene();
      })
      .catch((err: unknown) => {
        useRotoBrushStore.getState().setStatus(err instanceof Error ? err.message : 'Segmentation failed.');
      })
      .finally(() => useRotoBrushStore.getState().setBusy(false));
  }, [nodeId, compTime]);

  if (!painting && !roto) return null;

  const onDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0 || locked) return;
    e.preventDefault();
    e.stopPropagation();
    const p = local(e);
    if (painting) {
      if (!paintable) return;
      // Clone stamp aiming: Alt-click sets the source, paints nothing.
      if (e.altKey && paintMode === 'clone' && tool === 'paint') {
        usePaintStore.getState().set({ cloneSource: { nodeId, x: p.x, y: p.y }, alignedOffset: null });
        return;
      }
      svgRef.current?.setPointerCapture?.(e.pointerId);
      // Ctrl-drag (not Ctrl+Shift, which is the eraser's Last Stroke Only):
      // size the brush instead of painting.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
        setSizeDrag({ at: p, startX: e.clientX, start: { size: drawToolOptions.brushSize, hardness: usePaintStore.getState().hardness } });
        return;
      }
      setNotice(null);
      setLive({
        points: [p],
        times: [e.timeStamp],
        pen: [penSample(e.nativeEvent)],
        shift: e.shiftKey && !(e.ctrlKey || e.metaKey),
        lastStrokeOnly: tool === 'eraser' && e.shiftKey && (e.ctrlKey || e.metaKey),
      });
      return;
    }
    if (rotoBusy || !rotoable) return;
    svgRef.current?.setPointerCapture?.(e.pointerId);
    rotoDown.current = true;
    // Alt flips THIS stroke to background, as in the comp viewer.
    useRotoBrushStore.getState().begin(e.altKey ? 'bg' : 'fg', p);
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (painting && sizeDrag) {
      const phase = e.ctrlKey || e.metaKey ? 'size' : 'hardness';
      const next = ctrlDragBrush(sizeDrag.start, (e.clientX - sizeDrag.startX) / Math.max(1e-6, view.scale), phase);
      drawToolOptions.brushSize = next.size;
      if (phase === 'hardness') usePaintStore.getState().set({ hardness: next.hardness });
      bump();
      return;
    }
    if (painting && live) {
      const p = local(e);
      const pts = appendPoint(live.points, p);
      if (pts.length === live.points.length) return;
      setLive({ ...live, points: pts, times: [...live.times, e.timeStamp], pen: [...live.pen, penSample(e.nativeEvent)] });
    } else if (roto && rotoDown.current) {
      useRotoBrushStore.getState().extend(local(e));
    }
  };
  const onUp = (): void => {
    if (painting && sizeDrag) {
      setSizeDrag(null);
      return;
    }
    if (painting && live) {
      setLive(null);
      // One engine edit (one undo step), shared with the comp viewer.
      void commitPaintDrag({
        nodeId,
        mode: tool === 'eraser' ? 'erase' : paintMode === 'clone' ? 'clone' : 'paint',
        points: live.points,
        times: live.times,
        pen: live.pen,
        size: drawToolOptions.brushSize,
        compTime,
        continueStroke: live.shift,
        lastStrokeOnly: live.lastStrokeOnly,
      }).then((result) => {
        if (!result.ok && result.reason) setNotice(result.reason);
      });
      return;
    }
    if (roto) finishRoto();
  };

  const d = (pts: ReadonlyArray<Pt>): string =>
    pts.map((p, i) => {
      const s = toScreen(p);
      return `${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
    }).join(' ');

  const erasing = tool === 'eraser';
  const brushPx = Math.max(1, drawToolOptions.brushSize * view.scale);
  const rotoAll: RotoStroke[] = rotoLive ? [...rotoStrokes, rotoLive] : rotoStrokes;
  const message = painting
    ? (!paintable ? 'This layer cannot be painted on.' : locked ? 'This layer is locked.' : notice)
    : !rotoable
      ? 'Roto Brush works on footage — open a video or image layer.'
      : locked ? 'This layer is locked.' : rotoStatus;
  const cloneMark = cloneSource && cloneSource.nodeId === nodeId ? toScreen(cloneSource) : null;
  const sizeMark = sizeDrag ? toScreen(sizeDrag.at) : null;
  const hardness = usePaintStore.getState().hardness;

  return (
    <>
      <svg
        ref={svgRef}
        className={cn(styles.paintSurface)}
        width={stageWidth}
        height={stageHeight}
        aria-label={roto ? 'Roto Brush' : erasing ? 'Eraser' : 'Paint'}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {painting && live && live.points.length > 0 ? (
          <path
            d={d(live.points)}
            className={cn(styles.paintLive, erasing && styles.paintLiveErase)}
            stroke={erasing ? undefined : drawToolOptions.brushColor}
            strokeWidth={brushPx}
            strokeOpacity={erasing ? undefined : usePaintStore.getState().opacity}
          />
        ) : null}
        {sizeMark ? (
          <g className={styles.cloneMark}>
            <circle cx={sizeMark.x} cy={sizeMark.y} r={brushPx / 2} />
            {hardness < 1 ? <circle cx={sizeMark.x} cy={sizeMark.y} r={(brushPx / 2) * hardness} strokeDasharray="3 3" /> : null}
          </g>
        ) : null}
        {roto
          ? rotoAll.map((s) => (
              <g key={s.id}>
                <path className={styles.rotoHalo} d={d(s.points)} strokeWidth={rotoSize + 2} />
                <path className={s.kind === 'fg' ? styles.rotoFg : styles.rotoBg} d={d(s.points)} strokeWidth={rotoSize} />
              </g>
            ))
          : null}
        {cloneMark && painting ? (
          <g className={styles.cloneMark}>
            <circle cx={cloneMark.x} cy={cloneMark.y} r={6} />
            <line x1={cloneMark.x - 10} y1={cloneMark.y} x2={cloneMark.x + 10} y2={cloneMark.y} />
            <line x1={cloneMark.x} y1={cloneMark.y - 10} x2={cloneMark.x} y2={cloneMark.y + 10} />
          </g>
        ) : null}
      </svg>
      {message ? <div className={styles.paintStatus} role="status">{message}</div> : null}
    </>
  );
}

export default LayerPaintSurface;
