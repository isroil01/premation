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
 *                Lasso marquee, picked on the options bar) — a lasso hands
 *                the model its polygon as prompts (points inside it are the
 *                subject, points just outside its edge are not), so the shape
 *                drawn is what is asked for
 *
 * The prompts are the Roto Brush's (`rotoBrushStore`: a click is a one-point
 * stroke, the box rides beside them), so the tool options' Propagate, Refine
 * and Freeze carry the selection through the shot exactly as they do a
 * painted one. Segmenting is `core/workspace/rotoBrushTool.ts`; this file is
 * pointer plumbing and SVG.
 *
 * ## Staying out of the frame loop
 *
 * The overlay reads the playhead through `useRestingTime`: paused it is
 * exact, playing it is frozen, so a played frame re-renders nothing here.
 * The pointer lives in a ref and reaches React at most once per animation
 * frame; the subjects' boundaries and the found objects' outline paths are
 * memoised per (layer, frame, document revision, projection) and computed
 * once per render. A background walk (`tracking`) blocks nothing; a short
 * job in flight (`busy`) queues the press made meanwhile instead of dropping
 * it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { useRestingTime } from '@hooks/useRestingTime';
import { lassoPrompts, useRotoBrushStore } from '@stores/rotoBrushStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import {
  boxAt,
  findObjects,
  foundObjectsCached,
  objectsAt,
  previewObjectMatte,
  runSubjectEdit,
  type FoundObject,
  type ObjectMattePreview,
  type SubjectEditRequest,
} from '@core/workspace/rotoBrushTool';
import { layerSubjects, newSubjectId, type Subject } from '@core/workspace/subjects';
import { useSubjectStore } from '@stores/subjectStore';
import type { CSSProperties } from 'react';
import { explainObjectMatteError } from '@core/tracking/samModelInstall';
import { settingsFps } from '@core/mirror/compFacts';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { useLayerScreenMapping } from './useLayerScreenMapping';
import type { LayerScreenMapping } from './layerScreen';
import { useDisplayedCamera2D } from './useOverlayView';
import { autoInstallObjectMatte, offerSam2Tracking } from '@layout/Settings/objectMatteJob';
import { insideOutline, subjectBoundaries, type SubjectBoundary } from './subjectBoundary';
import { usePublishSubjectNotice } from './SubjectToolHud';
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

/** The smallest shown subject whose outline holds layer-local `p` (a subject inside another is reachable). */
export function subjectAt(boundaries: readonly SubjectBoundary[], subjects: readonly Subject[], p: Pt): Subject | null {
  let best: { s: Subject; area: number } | null = null;
  for (const b of boundaries) {
    const s = subjects.find((x) => x.id === b.subject);
    if (!s || s.hidden || !insideOutline(b.local, p)) continue;
    const area = (b.box.x1 - b.box.x0) * (b.box.y1 - b.box.y0);
    if (!best || area < best.area) best = { s, area };
  }
  return best?.s ?? null;
}

/** A found object's outline (layer-local x y pairs) as screen path data. */
export function outlinePathOf(flat: readonly number[], toScreen: (x: number, y: number) => Pt): string {
  if (flat.length < 6) return '';
  let d = '';
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const s = toScreen(flat[i]!, flat[i + 1]!);
    d += `${i === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)} `;
  }
  return `${d}Z`;
}

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

/**
 * The gate: only the tool's own flag is subscribed here, so with another tool
 * up a drag or a played frame re-renders nothing of this overlay (the inner
 * part reads the resting time and the document revision).
 */
export function ObjectMatteOverlay({ host }: { host?: ObjectMatteHost } = {}): JSX.Element | null {
  const on = useUIStore((s) => s.activeTool === 'object-matte');
  return on ? <ObjectMatteOverlayActive host={host} /> : null;
}

function ObjectMatteOverlayActive({ host }: { host?: ObjectMatteHost }): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const ids = useSelectionStore((s) => s.ids);
  const { time: playhead, playing } = useRestingTime();
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
  // Find Objects: every object of this frame (lit faintly), and the ones under the pointer, the
  // whole first (a person, the jacket on them, its sleeve): `depth` picks which is lit strongly.
  const [objects, setObjects] = useState<FoundObject[] | null>(null);
  const [stack, setStack] = useState<FoundObject[]>([]);
  // The pointer, overlay px: written on every move, handed to React once per animation frame.
  const pointerRef = useRef<Pt | null>(null);
  const pointerRaf = useRef<number | null>(null);
  const [pointer, setPointer] = useState<Pt | null>(null);
  const depth = useSubjectStore((s) => s.depth);
  const hot = stack.length > 0 ? stack[Math.min(depth, stack.length - 1)]! : null;
  const stackRef = useRef<FoundObject[]>([]);
  stackRef.current = stack;
  // The layer's subjects (several per layer) and the one Shift / Alt edit.
  const storedActive = useSubjectStore((s) => (nodeId ? s.active[nodeId] : undefined));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneTick: the subjects are read from the document at this revision
  const subjects: Subject[] = useMemo(() => (nodeId ? layerSubjects(nodeId) : []), [nodeId, sceneTick]);
  const activeId = subjects.some((s) => s.id === storedActive) ? storedActive! : (subjects[subjects.length - 1]?.id ?? null);
  const activeSubject = subjects.find((s) => s.id === activeId) ?? null;
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
  useEffect(() => () => {
    if (pointerRaf.current !== null) cancelAnimationFrame(pointerRaf.current);
  }, []);

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

  /** The pointer to React, once per frame (the hover tag and the subject under it read it). */
  const publishPointer = useCallback((p: Pt | null): void => {
    pointerRef.current = p;
    if (pointerRaf.current !== null) return;
    pointerRaf.current = requestAnimationFrame(() => {
      pointerRaf.current = null;
      setPointer(pointerRef.current);
    });
  }, []);

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
  // Nothing is searched while the transport runs: the frame is already gone.
  useEffect(() => {
    setStack([]);
    if (!active || !nodeId || playing) {
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
  }, [active, nodeId, time, sceneTick, playing]);

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
   *
   * While a job is in flight the press waits for it (`queuePress`), so a
   * click made during the previous click's segmenting is not lost.
   */
  // A plain click or box makes a NEW subject; Shift adds to the active one, Alt cuts from it.
  const targetOf = (shift: boolean, alt: boolean): string | null =>
    !nodeId ? null : (shift || alt) && activeId ? activeId : newSubjectId(nodeId);
  const runSelect = (req: SubjectEditRequest, subject: string): void => {
    if (!nodeId) return;
    const store = useRotoBrushStore.getState();
    store.setBusy(true);
    store.setStatus(t('workspace.objectMatte.selecting', 'Selecting…'));
    void runSubjectEdit(nodeId, time, req, subject)
      .then((r) => {
        const s = useRotoBrushStore.getState();
        const found = !!r && r.coverage > 0;
        s.setStatus(found ? null : t('workspace.objectMatte.nothing', 'Nothing found there — click the subject itself, or drag a box around it.'));
        if (found) useSubjectStore.getState().setActive(nodeId, subject);
        getWorkspaceController().requestRender();
      })
      .catch((err: unknown) => {
        reportFailure(err);
      })
      .finally(() => useRotoBrushStore.getState().setBusy(false));
  };
  const select = (req: SubjectEditRequest, subject: string | null): void => {
    if (!nodeId || !subject) return;
    const store = useRotoBrushStore.getState();
    if (!store.queuePress(() => runSelect(req, subject))) {
      store.setStatus(t('workspace.objectMatte.queued', 'Queued — applies when the current selection finishes.'));
    }
  };
  const opOf = (shift: boolean, alt: boolean): SubjectEditRequest['op'] => (alt ? 'subtract' : shift ? 'add' : 'replace');

  const toScreen = useCallback((x: number, y: number): Pt => (mapping ? mapping.localToScreen(x, y) : { x: 0, y: 0 }), [mapping]);
  // The subjects' outlines, once per (layer, frame, document revision, projection): both the
  // drawing and the hit test read the same list.
  const boundaries = useMemo(
    () => (nodeId && mapping ? subjectBoundaries(nodeId, time, toScreen) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneTick: the document revision the outlines are read at
    [nodeId, mapping, time, toScreen, sceneTick],
  );
  // The found objects' outline paths, once per search result and projection (up to 24 of them).
  const objectPaths = useMemo(
    () => (objects && mapping ? objects.map((o) => outlinePathOf(o.outline, toScreen)) : []),
    [objects, mapping, toScreen],
  );
  const subjectUnder = (p: Pt): Subject | null => (nodeId ? subjectAt(boundaries, subjects, p) : null);

  const click = (p: Pt, shift: boolean, alt: boolean): void => {
    if (!nodeId) return;
    const held = hoverRef.current;
    hoverRef.current = null;
    setHover(null);
    hoverSeq.current++;
    // The hover only showed the outline; the click makes the matte itself (the frame's encoding is warm).
    held?.preview.discard();
    // A plain click on a subject already made makes it the active one (unless a part of it is picked: a new subject).
    const already = !shift && !alt && depth === 0 ? subjectUnder(p) : null;
    if (already) {
      useSubjectStore.getState().setActive(nodeId, already.id);
      useRotoBrushStore.getState().setStatus(t('workspace.subjects.activeNow', '{name} is the active subject — Shift-click adds to it, Alt-click cuts from it.', { name: already.name }));
      return;
    }
    // On a found object: its own seed, so the selection is the object that was lit.
    select({ tool: 'segment', op: opOf(shift, alt), clicks: [hot ? hot.seed : p] }, targetOf(shift, alt));
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearHover();
      // Tab / Shift-Tab: from the whole object under the pointer to its parts and back.
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && stackRef.current.length > 1) {
        e.preventDefault();
        const n = stackRef.current.length;
        const d = useSubjectStore.getState().depth;
        useSubjectStore.getState().setDepth(((Math.min(d, n - 1) + (e.shiftKey ? -1 : 1)) % n + n) % n);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, clearHover]);

  const message = !nodeId
    ? t('workspace.objectMatte.selectLayer', 'Select one footage layer, then hover the subject.')
    : playing
      ? t('workspace.objectMatte.playing', 'Stop playback to select a subject.')
    : status ?? (looking
      ? t('workspace.objectMatte.looking', 'Looking…')
      : finding && !objects
        ? t('workspace.objectMatte.finding', 'Finding objects…')
      : hover && !hot  // over a found object the tag by the pointer says it
        ? (marquee === 'lasso'
          ? t('workspace.objectMatte.clickToSelectLasso', 'Click to select · Shift-click adds · Alt-click subtracts · drag a lasso')
          : t('workspace.objectMatte.clickToSelect', 'Click to select · Shift-click adds · Alt-click subtracts · drag for a box'))
        : null);
  // Told in the status bar, not over the picture (SubjectToolHud.tsx).
  usePublishSubjectNotice(active ? message : null, busy);

  if (!active) return null;

  const rectPath = (a: Pt, b: Pt): string => {
    const c = [toScreen(a.x, a.y), toScreen(b.x, a.y), toScreen(b.x, b.y), toScreen(a.x, b.y)];
    return `M ${c.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' L ')} Z`;
  };
  const lassoPath = (pts: readonly Pt[]): string =>
    pts.length < 2 ? '' : `${pts.map((q, i) => { const s = toScreen(q.x, q.y); return `${i === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)}`; }).join(' ')} Z`;
  const shownBox = drag ?? (boxAt(box, time, fps()) ? { from: { x: box!.x0, y: box!.y0 }, to: { x: box!.x1, y: box!.y1 } } : null);
  // The pointer over a subject already made (the whole picked): a click makes it the active one.
  const hoverLocal = pointer && mapping ? mapping.screenToLocal(pointer.x, pointer.y) : null;
  const hoverUnder = hoverLocal && depth === 0 ? subjectUnder(hoverLocal) : null;
  const hotIndex = hot && objects ? objects.indexOf(hot) : -1;


  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-object-matte-overlay=""
      onPointerDown={(e) => {
        if (e.button !== 0 || !nodeId || playing) return;
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
        if (playing) return;
        const r = rootRef.current?.getBoundingClientRect();
        if (r) publishPointer({ x: e.clientX - r.left, y: e.clientY - r.top });
        // Over found objects: lit at once, no model call (a new whole under the pointer starts at the whole).
        const under = objects ? objectsAt(objects, p) : [];
        if (under.length > 0) {
          const prev = stackRef.current;
          if (prev.length !== under.length || prev.some((o, i) => o !== under[i])) {
            if (prev[0] !== under[0]) useSubjectStore.getState().setDepth(0);
            setStack(under);
          }
          if (hoverRef.current || hoverTimer.current !== null) clearHover();
          return;
        }
        if (stackRef.current.length > 0) setStack([]);
        // A job in flight: no model hover (it would queue behind it); the found objects still light.
        if (busy) return;
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
            // The polygon itself is the prompt: foreground points inside it, background points just outside its
            // edge, and its bounds as the box — so the loop drawn is what is selected, not the box around it.
            const xs = d.path.map((q) => q.x);
            const ys = d.path.map((q) => q.y);
            select({
              tool: 'segment',
              op: opOf(press.shift, press.alt),
              clicks: prompts.inside,
              negatives: prompts.outside,
              box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), time },
            }, targetOf(press.shift, press.alt));
            return;
          }
          if (Math.abs(d.to.x - d.from.x) < 2 || Math.abs(d.to.y - d.from.y) < 2) return;
          const b = { x0: d.from.x, y0: d.from.y, x1: d.to.x, y1: d.to.y, time };
          useRotoBrushStore.getState().setBox(b);
          select({ tool: 'segment', op: opOf(press.shift, press.alt), box: b }, targetOf(press.shift, press.alt));
          return;
        }
        const p = toLocal(e.clientX, e.clientY) ?? press.from;
        click(p, press.shift, press.alt);
      }}
      onPointerLeave={() => {
        if (!pressRef.current) {
          clearHover();
          setStack([]);
          publishPointer(null);
        }
      }}
    >
      <svg className={styles.svg} aria-hidden="true">
        {boundaries.map((b) => {
          const s = subjects.find((x) => x.id === b.subject);
          if (s?.hidden) return null;
          return (
            <path
              key={b.subject}
              className={b.subject === activeId ? styles.boundaryActive : styles.boundary}
              style={{ '--subject-color': s?.color ?? 'var(--color-overlay-subject-boundary)' } as CSSProperties}
              d={b.d}
            />
          );
        })}
        {objects?.map((o, i) => (o === hot ? null : <path key={i} className={styles.object} d={objectPaths[i] ?? ''} />))}
        {hot && <path className={styles.preview} d={hotIndex >= 0 ? objectPaths[hotIndex] : outlinePathOf(hot.outline, toScreen)} />}
        {!hot && hover && (
          <path className={styles.preview} d={outlinePathOf(hover.preview.outline, toScreen)} />
        )}
        {drag && marquee === 'lasso' ? (
          <path className={styles.box} d={lassoPath(drag.path)} />
        ) : shownBox && (
          <path className={styles.box} d={rectPath(shownBox.from, shownBox.to)} />
        )}
      </svg>
      {boundaries.map((b) => {
        const s = subjects.find((x) => x.id === b.subject);
        if (!s || s.hidden || !Number.isFinite(b.box.x0)) return null;
        return (
          <span
            key={`tag-${b.subject}`}
            className={b.subject === activeId ? styles.tagActive : styles.tag}
            // Above its corner; inside it, under the chip row, when the subject reaches the viewer's top.
            style={{ left: Math.max(0, b.box.x0), top: b.box.y0 - 20 >= 36 ? b.box.y0 - 20 : Math.max(36, b.box.y0 + 4), '--subject-color': s.color } as CSSProperties}
          >
            {s.name}
          </span>
        );
      })}
      {hot && pointer && !drag && (
        <div className={styles.hoverTag} style={{ left: pointer.x + 16, top: pointer.y + 16 }}>
          <span className={styles.hoverName}>
            {t('workspace.subjects.foundObject', 'Object {n} · {pct}% of frame', { n: hotIndex + 1, pct: Math.max(1, Math.round(hot.area * 100)) })}
          </span>
          {hoverUnder ? (
            <span>{t('workspace.subjects.hoverActivate', 'Click: make {name} active', { name: hoverUnder.name })}</span>
          ) : (
            <span>
              {activeSubject
                ? t('workspace.subjects.hoverNewOrAdd', 'Click: new subject · Shift: add to {name} · Alt: cut from it', { name: activeSubject.name })
                : t('workspace.subjects.hoverNew', 'Click: select as a subject')}
            </span>
          )}
          {stack.length > 1 && (
            <span className={styles.hoverPath}>
              {stack.map((_, i) => (
                <b key={i} className={i === Math.min(depth, stack.length - 1) ? styles.hoverStepOn : styles.hoverStep}>
                  {i === 0 ? t('workspace.subjects.whole', 'Whole') : t('workspace.subjects.part', 'Part {n}', { n: i })}
                </b>
              ))}
              <span className={styles.hoverKey}>{t('workspace.subjects.tabHint', 'Tab ⇄')}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
