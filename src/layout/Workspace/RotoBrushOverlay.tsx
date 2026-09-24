/**
 * Roto Brush — the on-canvas half.
 *
 * Paint over the subject and the segmenter cuts a matte from your strokes;
 * Alt-paint marks background to take a piece back out. On release the whole
 * stroke set is re-segmented and written as ONE mask path on the layer
 * (`ROTO_PATH_NAME`), replacing the tool's previous path — so the tenth
 * stroke refines the same matte rather than adding a tenth mask.
 *
 * ## What is not here
 *
 * No segmentation, no coordinate conversion to source pixels, no mask write:
 * that is `core/workspace/rotoBrushTool.ts`, sitting on the same
 * `core/tracking/rotoBrush.ts` + `samSegment.ts` entry points the inspector's
 * `TrackMotionSection` calls. This file is pointer plumbing and SVG — the part
 * that cannot be unit-tested, and therefore the part that should be smallest.
 *
 * ## Strokes live in LAYER-LOCAL pixels
 *
 * Screen coordinates would detach from the artwork the moment you pan, zoom or
 * scrub — and the segmenter wants source pixels anyway. Points are converted
 * once on the way in, through `layerScreenMapping` (the shared projection the
 * rig and effect-handle overlays use, which follows parenting AND animation),
 * and converted back for drawing. A pan therefore moves the strokes with the
 * layer, for free.
 *
 * ## Why it takes the pointer
 *
 * `RotoTool` in the engine deliberately does nothing on pointer-down: a press
 * during a brush stroke must not start a marquee. This overlay is `inset: 0`
 * and claims the press, exactly as `PuppetOverlay` and `BoneOverlay` do for
 * their tools. It renders `null` unless the roto tool is active, so in every
 * other mode it is not in the DOM at all.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { useCurrentTime } from '@stores/playbackClockStore';
import { useRotoBrushStore, type RotoStroke } from '@stores/rotoBrushStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { segmentStrokesToMask } from '@core/workspace/rotoBrushTool';
import { isDescendantOf } from '@core/composition/compNavigation';
import { openLayerOnDoubleClick } from '@layout/LayerViewer/openLayer';
import { layerScreenMapping } from './layerScreen';
import styles from './RotoBrushOverlay.module.css';

/** How long a click waits for its second press (Windows' default is 500 ms). */
const DOUBLE_CLICK_MS = 350;
/** How far the second press may land from the first and still pair with it. */
const DOUBLE_CLICK_SLOP_PX = 6;

export function RotoBrushOverlay(): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const ids = useSelectionStore((s) => s.ids);
  const time = useCurrentTime();
  const comp = useActiveCompSize();
  const sceneTick = useMirrorRevisionFrame();

  const nodeId = ids.length === 1 ? ids[0]! : null;
  const strokes = useRotoBrushStore((s) => s.strokes);
  const live = useRotoBrushStore((s) => s.live);
  const size = useRotoBrushStore((s) => s.size);
  const busy = useRotoBrushStore((s) => s.busy);
  const status = useRotoBrushStore((s) => s.status);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const paintingRef = useRef(false);

  const active = activeTool === 'roto';

  // Switching layer drops the strokes: they are in the OLD layer's local
  // pixels and mean nothing in the new one's.
  useEffect(() => {
    if (active) useRotoBrushStore.getState().setNode(nodeId);
  }, [active, nodeId]);

  const camera = getWorkspaceController().ws.camera;
  const mapping = useMemo(
    () => (nodeId ? layerScreenMapping(nodeId, time, comp, camera) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- camera is a live singleton
    [nodeId, time, comp.width, comp.height, sceneTick],
  );

  /** Client coords → layer-local px, or null when the projection is gone. */
  const toLocal = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const el = rootRef.current;
      if (!el || !mapping) return null;
      const r = el.getBoundingClientRect();
      return mapping.screenToLocal(clientX - r.left, clientY - r.top);
    },
    [mapping],
  );

  const segmentNow = useCallback(() => {
    if (!nodeId) return;
    const store = useRotoBrushStore.getState();
    // Re-segment from the WHOLE set, not the one stroke just painted — a
    // background stroke only means anything relative to the foreground ones.
    store.setBusy(true);
    store.setStatus('Segmenting…');
    void segmentStrokesToMask(nodeId, useRotoBrushStore.getState().strokes, time, {
      featherPx: store.featherPx,
      replacePathId: store.maskPathId,
    })
      .then((pathId) => {
        const s = useRotoBrushStore.getState();
        s.setMaskPathId(pathId);
        s.setStatus(pathId ? null : 'Nothing to segment there — paint over the subject.');
        getWorkspaceController().requestRender();
      })
      .catch((err: unknown) => {
        useRotoBrushStore.getState().setStatus(err instanceof Error ? err.message : 'Segmentation failed.');
      })
      .finally(() => useRotoBrushStore.getState().setBusy(false));
  }, [nodeId, time]);

  /**
   * A CLICK (a press that never dragged) waits out the double-click interval
   * before it segments: a second press on the layer inside it makes the pair a
   * double-click, which — as in After Effects, where the Roto Brush works in
   * the Layer panel — opens the layer there instead, taking the click back.
   */
  const pendingClickRef = useRef<{ timer: number; strokeId: string; x: number; y: number } | null>(null);
  const flushPendingClick = useCallback((): void => {
    const pending = pendingClickRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingClickRef.current = null;
    segmentNow();
  }, [segmentNow]);
  useEffect(() => () => {
    if (pendingClickRef.current) window.clearTimeout(pendingClickRef.current.timer);
    pendingClickRef.current = null;
  }, [active, nodeId]);

  const finishStroke = useCallback((e?: { clientX: number; clientY: number }) => {
    if (!paintingRef.current) return;
    paintingRef.current = false;
    const store = useRotoBrushStore.getState();
    const done = store.end();
    if (!done || !nodeId) return;
    if (done.points.length < 2 && e) {
      pendingClickRef.current = {
        strokeId: done.id,
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          pendingClickRef.current = null;
          segmentNow();
        }, DOUBLE_CLICK_MS),
      };
      return;
    }
    segmentNow();
  }, [nodeId, segmentNow]);

  /** A second press close to a pending click: open the layer, if it is under it. */
  const takeDoubleClick = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const pending = pendingClickRef.current;
    if (!pending || !nodeId) return false;
    if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > DOUBLE_CLICK_SLOP_PX) {
      flushPendingClick();
      return false;
    }
    const r = rootRef.current?.getBoundingClientRect();
    const hit = r ? getWorkspaceController().ws.hitTestScreen({ x: e.clientX - r.left, y: e.clientY - r.top }) : null;
    if (!hit || !(hit.id === nodeId || isDescendantOf(hit.id, nodeId))) {
      flushPendingClick();
      return false;
    }
    window.clearTimeout(pending.timer);
    pendingClickRef.current = null;
    if (!openLayerOnDoubleClick(nodeId, { alt: e.altKey })) {
      // Nothing opened: the click was a click after all.
      segmentNow();
      return false;
    }
    useRotoBrushStore.getState().removeStroke(pending.strokeId);
    return true;
  };

  // A pointer-up outside the stage still ends the stroke; without this a drag
  // released over the timeline left the brush "down" forever.
  useEffect(() => {
    if (!active) return;
    const onUp = (): void => finishStroke();
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [active, finishStroke]);

  if (!active) return null;

  const strokePath = (s: RotoStroke): string => {
    if (!mapping) return '';
    return s.points
      .map((p, i) => {
        const sp = mapping.localToScreen(p.x, p.y);
        return `${i === 0 ? 'M' : 'L'} ${sp.x.toFixed(1)} ${sp.y.toFixed(1)}`;
      })
      .join(' ');
  };

  const all = live ? [...strokes, live] : strokes;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-roto-overlay=""
      onPointerDown={(e) => {
        if (e.button !== 0 || !nodeId || busy) return;
        if (takeDoubleClick(e)) {
          e.preventDefault();
          return;
        }
        // A flushed click is segmenting now; this press waits, as any does.
        if (useRotoBrushStore.getState().busy) return;
        const p = toLocal(e.clientX, e.clientY);
        if (!p) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        paintingRef.current = true;
        // Alt flips the meaning of THIS stroke without changing the tool's
        // default — the same "temporary opposite" Alt has everywhere else.
        useRotoBrushStore.getState().begin(e.altKey ? 'bg' : 'fg', p);
      }}
      onPointerMove={(e) => {
        if (!paintingRef.current) return;
        const p = toLocal(e.clientX, e.clientY);
        if (p) useRotoBrushStore.getState().extend(p);
      }}
      onPointerUp={(e) => finishStroke(e)}
    >
      <svg className={styles.svg} aria-hidden="true">
        {all.map((s) => {
          const d = strokePath(s);
          if (!d) return null;
          return (
            <g key={s.id}>
              <path className={styles.halo} d={d} strokeWidth={size + 2} />
              <path className={s.kind === 'fg' ? styles.fg : styles.bg} d={d} strokeWidth={size} />
            </g>
          );
        })}
      </svg>
      {(status || !nodeId) && (
        <div className={styles.status} role="status">
          {nodeId ? status : 'Select one footage layer to roto.'}
        </div>
      )}
    </div>
  );
}
