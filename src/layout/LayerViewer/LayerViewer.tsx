/**
 * LayerViewer — After Effects' Layer panel.
 *
 * One layer alone: before its transform (no position, rotation, scale or
 * opacity from the comp), at its own size, on a transparency grid. Its own
 * time ruler runs in LAYER time — the whole source, with the layer's In and
 * Out marked — and dragging those brackets trims the layer's bar in the
 * timeline (undoable, like any trim). The View menu toggles AE's "Render"
 * (masks + effects), mask outlines and the anchor point.
 *
 * The work AE does here, this does here: masks are drawn and reshaped
 * (`LayerMaskEditor` — Select, Rectangle, Ellipse and Pen, and the picked
 * mask's mode, Invert and Delete), and the layer is painted and roto'd
 * (`LayerPaintSurface` — the app's Paint, Eraser and Roto tools, which the
 * header can switch to).
 *
 * Time stays in step with the composition, as AE's "Synchronize Time Of All
 * Related Items" does: the panel shows the layer at the comp playhead, and
 * scrubbing its ruler moves the comp playhead. Scrubbing to a part of the
 * source the comp does not reach (before the layer starts, past the comp's
 * end) shows that frame here without moving the comp.
 *
 * The composition viewer stays mounted underneath (EditorTabs hides it), so
 * returning to it costs nothing.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Segmented } from '@components/Segmented';
import { cn } from '@utils/cn';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readCompRef } from '@core/scene/compInstance';
import { readNodeMask, readNodeMaskAt, type MaskMode } from '@core/effects/mask';
import { compSizeOf } from '@core/composition/compSizes';
import { getTimelineController } from '@core/timeline/TimelineController';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { defaultAnimation } from '@motion/animation';
import { trimBar } from '@layout/Timeline/timelineEdits';
import { deleteMaskEdit, setMaskFlagsEdit } from '@layout/Workspace/viewportEdits';
import { useLayerViewerStore, type LayerMaskTool } from '@stores/layerViewerStore';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useCurrentTime, setTime } from '@stores/playbackClockStore';
import { useUIStore, type Tool } from '@stores/uiStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { paneViewTransform } from '@layout/Workspace/useSceneRefGeometry';
import { useLayerViewerRenderer } from './useLayerViewerRenderer';
import { LayerMaskEditor } from './LayerMaskEditor';
import { LayerPaintSurface } from './LayerPaintSurface';
import styles from './LayerViewer.module.css';
import type { SceneNode } from '@core/types';

/** HH:MM:SS:FF for a time in seconds. */
function timecode(seconds: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const total = Math.max(0, Math.round(seconds * f));
  const ff = total % f;
  const s = Math.floor(total / f);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(ff)}`;
}

/** The layer's own frame — a placed comp's size, else its Transform size. */
function layerFrame(node: SceneNode): { width: number; height: number } {
  const ref = readCompRef(node);
  const size = ref ? compSizeOf(ref) : undefined;
  if (size) return size;
  const t = node.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown> | undefined;
  return { width: Math.max(1, Number(t?.width) || 1), height: Math.max(1, Number(t?.height) || 1) };
}

const MASK_TOOLS: ReadonlyArray<{ id: LayerMaskTool; label: string; title: string }> = [
  { id: 'select', label: 'Select', title: 'Select — drag mask points, handles (Alt breaks them) or outlines' },
  { id: 'rect', label: 'Rectangle', title: 'Rectangle Mask — drag to draw' },
  { id: 'ellipse', label: 'Ellipse', title: 'Ellipse Mask — drag to draw' },
  { id: 'pen', label: 'Pen', title: 'Pen — click for corners, drag for curves; click the first point or press Enter to close' },
];

/** The app tools that work IN the Layer panel (AE paints and rotos there). */
const PAINT_TOOLS: ReadonlyArray<{ id: Tool; label: string; title: string }> = [
  { id: 'paint', label: 'Paint', title: 'Brush — paint on the layer (Alt-click sets the Clone source in Clone mode)' },
  { id: 'eraser', label: 'Erase', title: 'Eraser — erase the layer’s paint' },
  { id: 'roto', label: 'Roto', title: 'Roto Brush — paint over the subject (Alt: background) to cut a matte' },
];

const MASK_MODES: ReadonlyArray<{ id: MaskMode; label: string }> = [
  { id: 'add', label: 'Add' },
  { id: 'subtract', label: 'Subtract' },
  { id: 'intersect', label: 'Intersect' },
  { id: 'lighten', label: 'Lighten' },
  { id: 'darken', label: 'Darken' },
  { id: 'difference', label: 'Difference' },
  { id: 'none', label: 'None' },
];

type Drag = 'in' | 'out' | 'scrub';

export function LayerViewer(): JSX.Element | null {
  const nodeId = useLayerViewerStore((s) => s.nodeId);
  const renderOn = useLayerViewerStore((s) => s.render);
  const showMasks = useLayerViewerStore((s) => s.showMasks);
  const showAnchor = useLayerViewerStore((s) => s.showAnchor);
  const maskTool = useLayerViewerStore((s) => s.maskTool);
  const maskSelection = useLayerViewerStore((s) => s.maskSelection);
  const setView = useLayerViewerStore((s) => s.setView);
  const setMaskTool = useLayerViewerStore((s) => s.setMaskTool);
  const selectMask = useLayerViewerStore((s) => s.selectMask);
  const close = useLayerViewerStore((s) => s.close);
  const activeTool = useUIStore((s) => s.activeTool) as string;
  const paintToolOn = activeTool === 'paint' || activeTool === 'eraser' || activeTool === 'roto';
  useSceneRevision((s) => s.rev);
  const node = nodeId ? defaultSceneGraph.getNode(nodeId) : undefined;

  // The panel names a layer of the comp in view: leaving the comp, or the
  // layer going away (deleted, undone), closes it.
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const openedIn = useRef(activeTabId);
  useEffect(() => {
    if (!nodeId) return;
    if (!node || activeTabId !== openedIn.current) close();
  }, [nodeId, node, activeTabId, close]);
  useEffect(() => {
    // Re-anchor to the comp a newly opened layer belongs to.
    openedIn.current = activeTabId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // Trims arrive as timeline events, not scene changes.
  const [clipRev, setClipRev] = useState(0);
  useEffect(() => {
    const events = getTimelineController().timeline.events;
    const bump = (): void => setClipRev((v) => v + 1);
    const subs = [
      events.on('LayerTrimmed', bump),
      events.on('LayerUpdated', bump),
      events.on('LayerSplit', bump),
    ];
    return () => { for (const s of subs) s.dispose(); };
  }, [activeTabId]);

  const compTime = useCurrentTime();
  const compDuration = useCompositionStore((s) => s.durationSeconds);
  const compFps = useCompositionStore((s) => s.fps);

  const clip = useMemo(() => {
    void clipRev;
    if (!nodeId || !node) return null;
    const controller = getTimelineController();
    const bar = controller.getLayersForNode(nodeId)[0];
    if (!bar) return null;
    const fps = controller.fpsForNode(nodeId) || compFps || 30;
    return {
      id: bar.id,
      fps,
      start: bar.clip.start / fps,
      inT: bar.clip.sourceIn / fps,
      dur: bar.clip.duration / fps,
      sourceDur: typeof bar.clip.sourceDuration === 'number' ? bar.clip.sourceDuration / fps : null,
    };
  }, [nodeId, node, clipRev, compFps]);

  const fps = clip?.fps ?? compFps ?? 30;
  const outT = clip ? clip.inT + clip.dur : 0;
  /** Layer time ↔ comp time through the bar (linear past its ends). */
  const layerTimeAt = (ct: number): number => (clip ? clip.inT + (ct - clip.start) : ct);
  const compTimeAt = (lt: number): number => (clip ? clip.start + (lt - clip.inT) : lt);
  /** The ruler's extent in layer time: the whole source when it has a length. */
  const span = Math.max(
    1 / fps,
    clip?.sourceDur ?? Math.max(outT, compDuration + (clip ? clip.inT - clip.start : 0)),
  );

  // A scrub to layer time the comp cannot show is held here, off the comp clock.
  const [heldLayerTime, setHeldLayerTime] = useState<number | null>(null);
  useEffect(() => { setHeldLayerTime(null); }, [nodeId]);
  const layerT = heldLayerTime ?? layerTimeAt(compTime);
  /** Where the renderer reads the layer's mask (its keyframe axis) — drawing only. */
  // Display only: the keyframe-axis time the mask is SAMPLED at (B4's mirror
  // replaces it); mask writes go through the engine in comp time (`maskCompTime`).
  const maskTime = heldLayerTime ?? (nodeId && node ? keyAxisTimeForDisplay(nodeId, compTime) : 0);
  /** The same moment in comp seconds — where mask edits land (the engine maps it to the key axis). */
  const maskCompTime = heldLayerTime !== null ? compTimeAt(heldLayerTime) : compTime;

  const frame = node ? layerFrame(node) : { width: 1, height: 1 };
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setStage({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [nodeId]);

  const renderCompTime = heldLayerTime !== null
    ? Math.min(Math.max(0, compTimeAt(heldLayerTime)), compDuration)
    : compTime;
  const { initError } = useLayerViewerRenderer(canvasRef, stageRef, {
    nodeId: node ? nodeId : null,
    render: renderOn,
    frameWidth: frame.width,
    frameHeight: frame.height,
    compTime: renderCompTime,
    ...(heldLayerTime !== null ? { sourceTime: heldLayerTime } : {}),
  });

  // ── Ruler: scrub + In/Out brackets ─────────────────────────────────
  const rulerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ kind: Drag; value: number } | null>(null);
  const timeAtPointer = (clientX: number): number => {
    const r = rulerRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    const u = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(u * span * fps) / fps;
  };
  const scrubTo = (lt: number): void => {
    const ct = compTimeAt(lt);
    const tabId = useProjectStore.getState().activeTabId;
    if (ct >= 0 && ct <= compDuration && tabId) {
      setHeldLayerTime(null);
      try { getTimelineController().seekSeconds(ct); } catch { /* headless */ }
      setTime(tabId, ct);
    } else {
      setHeldLayerTime(lt);
    }
  };
  const minLen = 1 / fps;
  const clampIn = (v: number): number => Math.min(Math.max(0, v), outT - minLen);
  const clampOut = (v: number): number => Math.max(Math.min(clip?.sourceDur ?? Infinity, v), (clip?.inT ?? 0) + minLen);
  const commitTrim = (edge: 'start' | 'end', lt: number): void => {
    if (!clip) return;
    // The timeline's own trim (engine API, one "Trim Layer" entry; its legacy
    // fallback for a bar the API cannot express lives there).
    void trimBar(clip.id, edge, compTimeAt(lt));
  };

  const onRulerDown = (e: ReactPointerEvent<HTMLDivElement>, kind: Drag): void => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const v = timeAtPointer(e.clientX);
    if (kind === 'scrub') scrubTo(v);
    setDrag({ kind, value: kind === 'in' ? clampIn(v) : kind === 'out' ? clampOut(v) : v });
  };
  const onRulerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag) return;
    const v = timeAtPointer(e.clientX);
    if (drag.kind === 'scrub') { scrubTo(v); setDrag({ kind: 'scrub', value: v }); return; }
    setDrag({ kind: drag.kind, value: drag.kind === 'in' ? clampIn(v) : clampOut(v) });
  };
  const onRulerUp = (): void => {
    if (!drag) return;
    if (drag.kind === 'in') commitTrim('start', drag.value);
    if (drag.kind === 'out') commitTrim('end', drag.value);
    setDrag(null);
  };

  if (!nodeId || !node) return null;

  const kind = readCompRef(node) ? 'composition' : readNodeKind(node);
  const shownIn = drag?.kind === 'in' ? drag.value : clip?.inT ?? 0;
  const shownOut = drag?.kind === 'out' ? drag.value : outT;
  const pct = (v: number): string => `${(Math.min(Math.max(v / span, 0), 1) * 100).toFixed(3)}%`;

  // ── Overlay (frame, anchor) in the renderer's own fit ─────────────
  const view = stage.width > 0 ? paneViewTransform(stage.width, stage.height, frame.width, frame.height) : null;
  const map = (x: number, y: number): [number, number] => (view
    ? [view.offsetX + view.scale * (x + frame.width / 2), view.offsetY + view.scale * (y + frame.height / 2)]
    : [0, 0]);
  const t = node.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown> | undefined;
  const anchorX = defaultAnimation.sample(nodeId, 'anchorX', layerT) ?? (Number(t?.anchorX) || 0);
  const anchorY = defaultAnimation.sample(nodeId, 'anchorY', layerT) ?? (Number(t?.anchorY) || 0);
  const [ax, ay] = map(Number(anchorX) || 0, Number(anchorY) || 0);

  // The picked mask, as the renderer reads it now.
  const masks = (readNodeMaskAt(node, maskTime) ?? readNodeMask(node))?.paths ?? [];
  const pickedMask = maskSelection ? masks.find((p) => p.id === maskSelection.pathId) : undefined;
  // Mode / Invert hold across every shape keyframe (the engine writes them on
  // the static mask and each key), as AE's mask switches do.
  const editMask = (label: string, patch: { mode?: MaskMode; inverted?: boolean }): void => {
    if (!pickedMask) return;
    void setMaskFlagsEdit(nodeId, pickedMask.id, label, patch);
  };
  const deleteMask = (): void => {
    if (!pickedMask) return;
    const pathId = pickedMask.id;
    selectMask(null);
    void deleteMaskEdit(nodeId, pathId);
  };

  const openViewMenu = (e: React.MouseEvent): void => {
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu(r.left, r.bottom + 4, [
      { id: 'render', label: 'Render (masks and effects)', icon: renderOn ? 'check' : undefined, onSelect: () => setView({ render: !renderOn }) },
      { id: 'sep', separator: true },
      { id: 'masks', label: 'Masks', icon: showMasks ? 'check' : undefined, onSelect: () => setView({ showMasks: !showMasks }) },
      { id: 'anchor', label: 'Anchor Point', icon: showAnchor ? 'check' : undefined, onSelect: () => setView({ showAnchor: !showAnchor }) },
    ]);
  };

  const hint = activeTool === 'roto'
    ? 'Paint over the subject · Alt paints background'
    : activeTool === 'paint'
      ? 'Drag to paint · size and colour from Tool Options'
      : activeTool === 'eraser'
        ? 'Drag to erase paint'
        : maskTool === 'pen'
          ? 'Click for corners, drag for curves · click the first point or Enter to close'
          : null;

  return (
    <div className={styles.root} data-testid="layer-viewer">
      <div className={styles.header}>
        <Icon name="layers" size="sm" />
        <span className={styles.title}>Layer: {node.name}</span>
        <span className={styles.meta}>{kind} · {Math.round(frame.width)}×{Math.round(frame.height)}</span>

        {/* Two groups, one tool: a paint tool on means no mask tool is. */}
        <Segmented<string>
          size="sm"
          aria-label="Mask tools"
          value={paintToolOn ? '' : maskTool}
          onChange={(id) => {
            setMaskTool(id as LayerMaskTool);
            // Leaving a paint tool hands the pointer back to the masks.
            if (paintToolOn) useUIStore.getState().setActiveTool('select');
            // A mask tool with masks hidden would draw into nothing visible.
            if (!showMasks) setView({ showMasks: true });
          }}
          options={MASK_TOOLS.map((t) => ({ value: t.id, label: <span title={t.title}>{t.label}</span> }))}
        />
        <Segmented<string>
          size="sm"
          aria-label="Paint tools"
          value={paintToolOn ? activeTool : ''}
          onChange={(id) => useUIStore.getState().setActiveTool(id as Tool)}
          options={PAINT_TOOLS.map((t) => ({ value: t.id, label: <span title={t.title}>{t.label}</span> }))}
        />

        {pickedMask && !paintToolOn ? (
          <div className={styles.maskControls} aria-label="Picked mask">
            <select
              className={styles.modeSelect}
              aria-label="Mask mode"
              value={pickedMask.mode}
              disabled={node.locked === true}
              onChange={(e) => editMask('Mask Mode', { mode: e.target.value as MaskMode })}
            >
              {MASK_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <label className={styles.renderToggle}>
              <input
                type="checkbox"
                checked={pickedMask.inverted}
                disabled={node.locked === true}
                onChange={(e) => editMask('Invert Mask', { inverted: e.target.checked })}
              />
              Inverted
            </label>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="trash" size="sm" />}
              onClick={deleteMask}
              disabled={node.locked === true}
              title="Delete this mask (Delete)"
            >
              Delete mask
            </Button>
          </div>
        ) : hint ? (
          <span className={styles.hintText}>{hint}</span>
        ) : null}

        <span className={styles.spacer} />
        <label className={styles.renderToggle} title="Show the layer with its masks and effects (AE's Render checkbox)">
          <input type="checkbox" checked={renderOn} onChange={(e) => setView({ render: e.target.checked })} />
          Render
        </label>
        <Button variant="ghost" size="sm" onClick={openViewMenu} aria-haspopup="menu" rightIcon={<Icon name="chevron-down" size="sm" />}>
          View
        </Button>
        <Button variant="ghost" size="sm" iconOnly icon={<Icon name="close" size="sm" />} onClick={close} title="Back to the composition">
          Close Layer panel
        </Button>
      </div>

      <div ref={stageRef} className={styles.stage}>
        <canvas ref={canvasRef} className={styles.canvas} />
        {view ? (
          <svg className={styles.overlay} width={stage.width} height={stage.height} aria-hidden>
            <rect
              className={styles.frame}
              x={view.offsetX}
              y={view.offsetY}
              width={frame.width * view.scale}
              height={frame.height * view.scale}
            />
            {showAnchor ? (
              <g className={styles.anchor}>
                <circle cx={ax} cy={ay} r={5} />
                <line x1={ax - 9} y1={ay} x2={ax + 9} y2={ay} />
                <line x1={ax} y1={ay - 9} x2={ax} y2={ay + 9} />
              </g>
            ) : null}
          </svg>
        ) : null}
        {view && showMasks ? (
          <LayerMaskEditor
            nodeId={nodeId}
            frameWidth={frame.width}
            frameHeight={frame.height}
            view={view}
            stageWidth={stage.width}
            stageHeight={stage.height}
            maskTime={maskTime}
            maskCompTime={maskCompTime}
          />
        ) : null}
        {view ? (
          <LayerPaintSurface
            nodeId={nodeId}
            frameWidth={frame.width}
            frameHeight={frame.height}
            view={view}
            stageWidth={stage.width}
            stageHeight={stage.height}
            compTime={renderCompTime}
          />
        ) : null}
        {initError ? <div className={styles.error}>{initError}</div> : null}
      </div>

      <div className={styles.footer}>
        <span className={styles.timecode} title="Current time, in layer time">{timecode(layerT, fps)}</span>
        {clip ? (
          <>
            <Button variant="ghost" size="xs" title="Set In point to the current time" onClick={() => commitTrim('start', clampIn(layerT))}>
              {'{'}
            </Button>
            <div
              ref={rulerRef}
              className={styles.ruler}
              role="slider"
              aria-label="Layer time"
              aria-valuemin={0}
              aria-valuemax={Number(span.toFixed(3))}
              aria-valuenow={Number(layerT.toFixed(3))}
              onPointerDown={(e) => onRulerDown(e, 'scrub')}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
              onPointerCancel={onRulerUp}
            >
              <div className={styles.range} style={{ left: pct(shownIn), width: `calc(${pct(shownOut)} - ${pct(shownIn)})` }} />
              <div
                className={cn(styles.bracket, styles.bracketIn)}
                style={{ left: pct(shownIn) }}
                title="Drag to trim the In point"
                onPointerDown={(e) => onRulerDown(e, 'in')}
              />
              <div
                className={cn(styles.bracket, styles.bracketOut)}
                style={{ left: pct(shownOut) }}
                title="Drag to trim the Out point"
                onPointerDown={(e) => onRulerDown(e, 'out')}
              />
              <div className={styles.playhead} style={{ left: pct(layerT) }} />
            </div>
            <Button variant="ghost" size="xs" title="Set Out point to the current time" onClick={() => commitTrim('end', clampOut(layerT))}>
              {'}'}
            </Button>
            <span className={styles.readout}>In {timecode(shownIn, fps)}</span>
            <span className={styles.readout}>Out {timecode(shownOut, fps)}</span>
            <span className={styles.readout}>Δ {timecode(shownOut - shownIn, fps)}</span>
          </>
        ) : (
          <span className={styles.readout}>This layer has no bar of its own in the timeline (it is inside a group).</span>
        )}
      </div>
    </div>
  );
}

export default LayerViewer;
