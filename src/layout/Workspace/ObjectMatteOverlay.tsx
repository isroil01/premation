/**
 * Object Matte tool — the on-canvas half (AE 26.2's Object Matte tool).
 *
 *   hover        rest the pointer on a subject and its matte is previewed
 *                (outline + tint), nothing written yet
 *   click        select that subject: the held preview is applied, or the
 *                frame is segmented from the click
 *   Shift-click  add to the selection (a foreground point)
 *   Alt-click    subtract from it (a background point)
 *   drag         a box around the subject, or a lasso (AE's Rectangle /
 *                Lasso marquee, picked on the options bar)
 *
 * The prompts are the Roto Brush's (`rotoBrushStore`: a click is a one-point
 * stroke, the box rides beside them), so the tool options' Propagate, Refine
 * and Freeze carry the selection through the shot exactly as they do a
 * painted one. Segmenting is `core/workspace/rotoBrushTool.ts`; this file is
 * pointer plumbing and SVG.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { useCurrentTime } from '@stores/playbackClockStore';
import { lassoPrompts, useRotoBrushStore } from '@stores/rotoBrushStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import {
  boxAt,
  findObjects,
  foundObjectsCached,
  objectAt,
  previewObjectMatte,
  runSubjectEdit,
  type FoundObject,
  type ObjectMattePreview,
  type SubjectEditRequest,
} from '@core/workspace/rotoBrushTool';
import { explainObjectMatteError } from '@core/tracking/samModelInstall';
import { settingsFps } from '@core/mirror/compFacts';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { useLayerScreenMapping } from './useLayerScreenMapping';
import type { LayerScreenMapping } from './layerScreen';
import { useDisplayedCamera2D } from './useOverlayView';
import { autoInstallObjectMatte, offerSam2Tracking } from '@layout/Settings/objectMatteJob';
import { subjectBoundaryPath } from './subjectBoundary';
import styles from './ObjectMatteOverlay.module.css';
import { t } from '@core/i18n';

/** How long the pointer rests before a hover preview starts. */
const HOVER_MS = 300;
/** How long the playhead rests on a frame before its objects are searched (scrubbing searches nothing). */
const WARM_MS = 250;
/** The frame last searched, shared: the Composition viewer and the Layer panel search it once between them. */
let warmedFrame: string | null = null;
/** A press that moves further than this is a box, not a click. */
const DRAG_PX = 4;
/** A click this close (layer px) to the previewed point applies the held preview. */
const SAME_SPOT_PX = 6;

type Pt = { x: number; y: number };

interface Hover {
  at: Pt;
  time: number;
  preview: ObjectMattePreview;
}

/** A failed segment: a missing model starts its download (no dialog); anything else is said. */
function reportFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : t('workspace.objectMatte.failed', 'Object Matte failed.');
  const store = useRotoBrushStore.getState();
  if (autoInstallObjectMatte(message)) {
    store.setStatus(t('workspace.objectMatte.downloading', 'Getting the Object Matte model (one time, about 14 MB)… try again when it finishes.'));
    return;
  }
  store.setStatus(explainObjectMatteError(message));
}

/**
 * The gate: only the tool's own flag is subscribed here, so with another tool
 * up a drag or a played frame re-renders nothing of this overlay (the inner
 * part reads the time and the document revision).
 */
/**
 * Where the overlay is hosted when it is not the Composition viewer's: the
 * Layer panel passes its own camera (layer-local px ↔ its stage), the layer
 * it shows and the composition time of the frame on screen. AE's Object Matte
 * works in the Layer panel; here it works in both.
 */
export interface ObjectMatteHost {
  mapping: LayerScreenMapping;
  nodeId: string;
  time: number;
}

export function ObjectMatteOverlay({ host }: { host?: ObjectMatteHost } = {}): JSX.Element | null {
  const on = useUIStore((s) => s.activeTool === 'object-matte');
  return on ? <ObjectMatteOverlayActive host={host} /> : null;
}

function ObjectMatteOverlayActive({ host }: { host?: ObjectMatteHost }): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const ids = useSelectionStore((s) => s.ids);
  const playhead = useCurrentTime();
  const time = host ? host.time : playhead;
  const comp = useActiveCompSize();
  const sceneTick = useMirrorRevisionFrame();
  const busy = useRotoBrushStore((s) => s.busy);
  const status = useRotoBrushStore((s) => s.status);
  const box = useRotoBrushStore((s) => s.box);

  const active = activeTool === 'object-matte';
  const nodeId = host ? host.nodeId : ids.length === 1 ? ids[0]! : null;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [looking, setLooking] = useState(false);
  // Find Objects: every object of this frame (lit faintly), and the one under the pointer (lit strongly).
  const [objects, setObjects] = useState<FoundObject[] | null>(null);
  const [hot, setHot] = useState<FoundObject | null>(null);
  const [finding, setFinding] = useState(false);
  const [drag, setDrag] = useState<{ from: Pt; to: Pt; path: Pt[] } | null>(null);
  const marquee = useRotoBrushStore((s) => s.marquee);
  const pressRef = useRef<{ from: Pt; client: Pt; shift: boolean; alt: boolean } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  // Bumped by every move: a preview that comes back for an older pointer position is stale.
  const hoverSeq = useRef(0);
  const hoverRef = useRef<Hover | null>(null);
  hoverRef.current = hover;

  useEffect(() => {
    if (active) useRotoBrushStore.getState().setNode(nodeId);
  }, [active, nodeId]);
  useEffect(() => {
    if (active) offerSam2Tracking();
  }, [active]);

  const camera = useDisplayedCamera2D();
  // Hosted: the host's camera. The comp viewer's projection is still asked for
  // (hooks run unconditionally) but for no layer, so it subscribes to nothing.
  const compMapping = useLayerScreenMapping(host ? null : nodeId, time, comp, camera, sceneTick);
  const mapping = host ? host.mapping : compMapping;

  const toLocal = useCallback(
    (clientX: number, clientY: number): Pt | null => {
      const el = rootRef.current;
      if (!el || !mapping) return null;
      const r = el.getBoundingClientRect();
      return mapping.screenToLocal(clientX - r.left, clientY - r.top);
    },
    [mapping],
  );

  const clearHover = useCallback((): void => {
    hoverSeq.current++;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hoverRef.current?.preview.discard();
    hoverRef.current = null;
    setHover(null);
    setLooking(false);
  }, []);

  // A new frame, layer or tool invalidates the preview: it is of one frame of one layer.
  useEffect(() => clearHover, [active, nodeId, time, sceneTick, clearHover]);

  // Find the frame's objects once the playhead rests on it (Premiere's Object
  // Mask lights every selectable object on hover): one search per frame, kept,
  // so moving the pointer is a lookup. It also warms the frame's encoding, so a
  // click — or the per-point hover where no object was found — is decoder-only.
  useEffect(() => {
    setHot(null);
    if (!active || !nodeId) {
      setObjects(null);
      return;
    }
    // The last search shows at once; the search runs again unless it was for the layer's box now
    // (findObjects answers from its cache then), so a resized layer is searched afresh.
    setObjects(foundObjectsCached(nodeId, time) ?? null);
    let live = true;
    const key = `${nodeId}@${time}`;
    const timer = window.setTimeout(() => {
      if (useRotoBrushStore.getState().busy) return;
      warmedFrame = key;
      setFinding(true);
      void findObjects(nodeId, time)
        .then((found) => { if (live) setObjects(found ?? []); })
        .catch((err: unknown) => { if (live) reportFailure(err); })
        .finally(() => { if (live) setFinding(false); });
    }, warmedFrame === key ? 0 : WARM_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      setFinding(false);
    };
  }, [active, nodeId, time, sceneTick]);

  const fps = (): number => settingsFps(activeCompSettingsNow());

  const scheduleHover = (p: Pt): void => {
    if (!nodeId) return;
    const seq = ++hoverSeq.current;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      if (useRotoBrushStore.getState().busy) return;
      setLooking(true);
      const probe = [{ id: 'hover', kind: 'fg' as const, points: [p], time }];
      void previewObjectMatte(nodeId, probe, time, {
        featherPx: useRotoBrushStore.getState().featherPx,
        isStale: () => seq !== hoverSeq.current,
      })
        .then((preview) => {
          if (seq !== hoverSeq.current) {
            preview?.discard();
            return;
          }
          setLooking(false);
          hoverRef.current?.preview.discard();
          setHover(preview ? { at: p, time, preview } : null);
        })
        .catch((err: unknown) => {
          if (seq !== hoverSeq.current) return;
          setLooking(false);
          reportFailure(err);
        });
    }, HOVER_MS);
  };

  /**
   * Select on this frame: the subject's matte is segmented from the click /
   * box / lasso and replaces (plain), adds to (Shift) or is cut from (Alt)
   * what is selected — the soft matte at full size, its edge snapped to the
   * picture, only the region the prompt touched kept.
   */
  const select = (req: SubjectEditRequest): void => {
    if (!nodeId) return;
    const store = useRotoBrushStore.getState();
    store.setBusy(true);
    store.setStatus(t('workspace.objectMatte.selecting', 'Selecting…'));
    void runSubjectEdit(nodeId, time, req)
      .then((r) => {
        const s = useRotoBrushStore.getState();
        s.setStatus(r && r.coverage > 0 ? null : t('workspace.objectMatte.nothing', 'Nothing found there — click the subject itself, or drag a box around it.'));
        getWorkspaceController().requestRender();
      })
      .catch((err: unknown) => {
        reportFailure(err);
      })
      .finally(() => useRotoBrushStore.getState().setBusy(false));
  };
  const opOf = (shift: boolean, alt: boolean): SubjectEditRequest['op'] => (alt ? 'subtract' : shift ? 'add' : 'replace');

  const click = (p: Pt, shift: boolean, alt: boolean): void => {
    if (!nodeId) return;
    const held = hoverRef.current;
    hoverRef.current = null;
    setHover(null);
    hoverSeq.current++;
    // The hover only showed the outline; the click makes the matte itself (the frame's encoding is warm).
    held?.preview.discard();
    // On a found object: its own seed, so the selection is the object that was lit.
    const found = objects ? objectAt(objects, p) : null;
    select({ tool: 'segment', op: opOf(shift, alt), clicks: [found ? found.seed : p] });
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearHover();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, clearHover]);

  if (!active) return null;

  const toScreen = (x: number, y: number): Pt => (mapping ? mapping.localToScreen(x, y) : { x: 0, y: 0 });
  const outlinePath = (flat: readonly number[]): string => {
    if (!mapping || flat.length < 6) return '';
    let d = '';
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const s = toScreen(flat[i]!, flat[i + 1]!);
      d += `${i === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)} `;
    }
    return `${d}Z`;
  };
  const rectPath = (a: Pt, b: Pt): string => {
    const c = [toScreen(a.x, a.y), toScreen(b.x, a.y), toScreen(b.x, b.y), toScreen(a.x, b.y)];
    return `M ${c.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' L ')} Z`;
  };
  const lassoPath = (pts: readonly Pt[]): string =>
    pts.length < 2 ? '' : `${pts.map((q, i) => { const s = toScreen(q.x, q.y); return `${i === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)}`; }).join(' ')} Z`;
  const shownBox = drag ?? (boxAt(box, time, fps()) ? { from: { x: box!.x0, y: box!.y0 }, to: { x: box!.x1, y: box!.y1 } } : null);

  const message = !nodeId
    ? t('workspace.objectMatte.selectLayer', 'Select one footage layer, then hover the subject.')
    : status ?? (looking
      ? t('workspace.objectMatte.looking', 'Looking…')
      : finding && !objects
        ? t('workspace.objectMatte.finding', 'Finding objects…')
      : hover || hot
        ? (marquee === 'lasso'
          ? t('workspace.objectMatte.clickToSelectLasso', 'Click to select · Shift-click adds · Alt-click subtracts · drag a lasso')
          : t('workspace.objectMatte.clickToSelect', 'Click to select · Shift-click adds · Alt-click subtracts · drag for a box'))
        : null);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-object-matte-overlay=""
      onPointerDown={(e) => {
        if (e.button !== 0 || !nodeId || busy) return;
        const p = toLocal(e.clientX, e.clientY);
        if (!p) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        pressRef.current = { from: p, client: { x: e.clientX, y: e.clientY }, shift: e.shiftKey, alt: e.altKey };
      }}
      onPointerMove={(e) => {
        const press = pressRef.current;
        const p = toLocal(e.clientX, e.clientY);
        if (!p) return;
        if (press) {
          if (drag || Math.hypot(e.clientX - press.client.x, e.clientY - press.client.y) > DRAG_PX) {
            if (!drag) clearHover();
            setDrag((d) => ({ from: press.from, to: p, path: d ? (Math.hypot(p.x - d.path[d.path.length - 1]!.x, p.y - d.path[d.path.length - 1]!.y) > 1 ? [...d.path, p] : d.path) : [press.from, p] }));
          }
          return;
        }
        if (busy) return;
        // Over a found object: lit at once, no model call.
        const found = objects ? objectAt(objects, p) : null;
        if (found) {
          if (found !== hot) setHot(found);
          if (hoverRef.current || hoverTimer.current !== null) clearHover();
          return;
        }
        if (hot) setHot(null);
        const h = hoverRef.current;
        // Still on the previewed spot: keep it rather than re-asking the model.
        if (h && Math.hypot(h.at.x - p.x, h.at.y - p.y) <= SAME_SPOT_PX) return;
        scheduleHover(p);
      }}
      onPointerUp={(e) => {
        const press = pressRef.current;
        pressRef.current = null;
        if (!press || !nodeId) return;
        if (drag) {
          const d = drag;
          setDrag(null);
          if (marquee === 'lasso') {
            const prompts = lassoPrompts(d.path);
            if (!prompts) {
              useRotoBrushStore.getState().setStatus(t('workspace.objectMatte.lassoEmpty', 'Draw the lasso around the subject (a closed loop).'));
              return;
            }
            // The object inside the loop: its bounds as the box, the inside point nearest its middle as the click.
            const xs = d.path.map((q) => q.x);
            const ys = d.path.map((q) => q.y);
            const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
            const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
            const middle = prompts.inside.reduce((a, b) => (Math.hypot(b.x - cx, b.y - cy) < Math.hypot(a.x - cx, a.y - cy) ? b : a));
            select({ tool: 'segment', op: opOf(press.shift, press.alt), clicks: [middle],
              box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), time } });
            return;
          }
          if (Math.abs(d.to.x - d.from.x) < 2 || Math.abs(d.to.y - d.from.y) < 2) return;
          const b = { x0: d.from.x, y0: d.from.y, x1: d.to.x, y1: d.to.y, time };
          useRotoBrushStore.getState().setBox(b);
          select({ tool: 'segment', op: opOf(press.shift, press.alt), box: b });
          return;
        }
        const p = toLocal(e.clientX, e.clientY) ?? press.from;
        click(p, press.shift, press.alt);
      }}
      onPointerLeave={() => {
        if (!pressRef.current) {
          clearHover();
          setHot(null);
        }
      }}
    >
      <svg className={styles.svg} aria-hidden="true">
        {nodeId && mapping && <path className={styles.boundary} d={subjectBoundaryPath(nodeId, time, toScreen)} />}
        {objects?.map((o, i) => (o === hot ? null : <path key={i} className={styles.object} d={outlinePath(o.outline)} />))}
        {hot && <path className={styles.preview} d={outlinePath(hot.outline)} />}
        {!hot && hover && (
          <path className={styles.preview} d={outlinePath(hover.preview.outline)} />
        )}
        {drag && marquee === 'lasso' ? (
          <path className={styles.box} d={lassoPath(drag.path)} />
        ) : shownBox && (
          <path className={styles.box} d={rectPath(shownBox.from, shownBox.to)} />
        )}
      </svg>
      {message && (
        <div className={styles.status} role="status">
          {busy && <span className={styles.spinner} aria-hidden="true" />}
          {message}
        </div>
      )}
    </div>
  );
}
