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
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { ValueField } from '@components/ValueField';
import { ViewerRulers } from '@components/ViewerRulers/ViewerRulers';
import { cn } from '@utils/cn';
import type { MaskMode } from '@core/effects/mask';
import { secondsToFlicks, type LayerInfo } from '@motion/engine-api';
import { seekPlayhead } from '@core/timeline/timelineView';
import { documentMirror, type DocumentMirror } from '@stores/documentMirror';
import { useRetainTree } from '@hooks/useMirror';
import { mirrorMasksAt } from '@core/mirror/masks';
import { mirrorHasBar } from '@core/mirror/clipBars';
import { timingBarFrames } from '@core/mirror/compFacts';
import { readTrack } from '@core/mirror/selection';
import { storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { trimBar } from '@layout/Timeline/timelineEdits';
import { deleteMaskEdit, setMaskFlagsEdit } from '@layout/Workspace/viewportEdits';
import { useLayerViewerStore, type LayerAlphaView, type LayerMaskTool } from '@stores/layerViewerStore';
import { useProjectStore } from '@stores/projectStore';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { useMirrorRevision } from '@hooks/useMirror';
import { useActiveTabCompSettings } from '@hooks/useMirrorFrame';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { useCurrentTime, setTime } from '@stores/playbackClockStore';
import { useUIStore } from '@stores/uiStore';
import { EnginePaneSurface } from '@components/EngineSurface/EnginePaneSurface';
import { LayerMaskEditor } from './LayerMaskEditor';
import { LayerPaintSurface } from './LayerPaintSurface';
import { LayerPaintSelect } from './LayerPaintSelect';
import { canOpenLayerComposition } from './openLayer';
import { openLayerComposition } from '@layout/Composition/compNavigationEdits';
import { TrackPointOverlay, type TrackPointHost } from '@layout/Workspace/TrackPointOverlay';
import { EffectHandleOverlay } from '@layout/Workspace/EffectHandleOverlay';
import { PuppetOverlay } from '@layout/Workspace/PuppetOverlay';
import { BoneOverlay } from '@layout/Workspace/BoneOverlay';
import { useTrackerStore } from '@stores/trackerStore';
import { useSelectionStore } from '@stores/selectionStore';
import { usePaintStore } from '@stores/paintStore';
import { useEffectHandleStore } from '@stores/effectHandleStore';
import styles from './LayerViewer.module.css';

/** HH:MM:SS:FF for a time in seconds. */
function timecode(seconds: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const total = Math.max(0, Math.round(seconds * f));
  const ff = total % f;
  const s = Math.floor(total / f);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(ff)}`;
}

/** The layer's own frame — a placed comp's size, else its stored layer size (B4: the mirror). */
function layerFrame(m: DocumentMirror, id: string, layer: LayerInfo): { width: number; height: number } {
  const comp = layer.kind === 'precomp' && layer.source ? m.comp(layer.source) : undefined;
  if (comp) return { width: comp.settings.width, height: comp.settings.height };
  const tree = m.tree(id);
  const stored = (track: string): number => {
    const r = trackRefIn(tree, track);
    return r ? Number(storedNumber(r, r.info.value)) || 0 : 0;
  };
  return { width: Math.max(1, stored('width') || 1), height: Math.max(1, stored('height') || 1) };
}

/**
 * The main tool bar's tool → the mask tool it is in the Layer viewer. AE has no
 * separate tools here: Selection reshapes masks, the shape tools and the Pen
 * draw them. A tool that is not listed leaves the mask tool as it was.
 */
const MASK_TOOL_OF: Readonly<Record<string, LayerMaskTool>> = {
  select: 'select',
  'direct-select': 'select',
  shape: 'rect',
  'mask-rect': 'rect',
  ellipse: 'ellipse',
  'mask-ellipse': 'ellipse',
  pen: 'pen',
  'mask-pen': 'pen',
};

/** The Paint panel's stroke durations, as the options line names them. */
const PAINT_DURATION_LABEL: Readonly<Record<string, string>> = {
  constant: 'Constant',
  writeOn: 'Write On',
  'write-on': 'Write On',
  single: 'Single Frame',
  singleFrame: 'Single Frame',
  'single-frame': 'Single Frame',
  custom: 'Custom',
};

/** The tools the bone overlay answers to (BoneOverlay's own `active` test decides the rest). */
const BONE_TOOLS: ReadonlySet<string> = new Set(['bone']);

/** Fit leaves this much of the stage around the layer. */
const FIT_MARGIN = 0.9;
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 64;
const ZOOM_STEPS: readonly number[] = [0.25, 0.5, 1, 2, 4];

/** After Effects' matte views of the Layer panel. */
const ALPHA_VIEWS: ReadonlyArray<{ id: Exclude<LayerAlphaView, 'off'>; label: string }> = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'boundary', label: 'Alpha Boundary' },
  { id: 'overlay', label: 'Alpha Overlay' },
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
  const showTracker = useLayerViewerStore((s) => s.showTracker);
  const alphaView = useLayerViewerStore((s) => s.alphaView);
  const exposure = useLayerViewerStore((s) => s.exposure);
  const setExposure = useLayerViewerStore((s) => s.setExposure);
  const showRulers = useLayerViewerStore((s) => s.showRulers);
  const setRulers = useLayerViewerStore((s) => s.setRulers);
  const guides = useLayerViewerStore((s) => s.guides);
  const setGuides = useLayerViewerStore((s) => s.setGuides);
  // The Paint tool's kind and the Clone Stamp's switches, for the options line.
  const paintMode = usePaintStore((s) => s.mode);
  const paintOpacity = usePaintStore((s) => s.opacity);
  const paintHardness = usePaintStore((s) => s.hardness);
  const paintDuration = usePaintStore((s) => s.duration);
  const cloneAligned = usePaintStore((s) => s.cloneAligned);
  const cloneLockTime = usePaintStore((s) => s.cloneLockTime);
  const cloneSourceSet = usePaintStore((s) => s.cloneSource !== null && s.cloneSource.nodeId === nodeId);
  const setPaint = usePaintStore((s) => s.set);
  const showEffectPoints = useLayerViewerStore((s) => s.showEffectPoints);
  // The Tracker's and Effect Controls' own targets: their points are drawn here only for THIS layer.
  const trackedHere = useTrackerStore((s) => s.armed && s.nodeId !== null && s.nodeId === nodeId);
  const effectHere = useEffectHandleStore((s) => s.nodeId !== null && s.nodeId === nodeId);
  // The rig overlays act on the SELECTED layer: only when that is the layer on show.
  const rigHere = useSelectionStore((s) => s.ids.length > 0 && s.ids[0] === nodeId);
  const maskTool = useLayerViewerStore((s) => s.maskTool);
  const maskSelection = useLayerViewerStore((s) => s.maskSelection);
  const setView = useLayerViewerStore((s) => s.setView);
  const setMaskTool = useLayerViewerStore((s) => s.setMaskTool);
  const selectMask = useLayerViewerStore((s) => s.selectMask);
  const close = useLayerViewerStore((s) => s.close);
  const activeTool = useUIStore((s) => s.activeTool) as string;
  // A rig tool picked while this layer is on show but not selected (the
  // selection was cleared, or sits on another layer): the tool is meant for
  // THIS layer, so it becomes the selection — otherwise the pins and bones
  // would silently not respond.
  // (The mask drawing tools too: Tool Options otherwise says they have no target.)
  const rigTool = activeTool === 'puppet-pin' || BONE_TOOLS.has(activeTool) || (MASK_TOOL_OF[activeTool] !== undefined && MASK_TOOL_OF[activeTool] !== 'select');
  useEffect(() => {
    if (rigTool && nodeId && !rigHere) useSelectionStore.getState().set([nodeId]);
  }, [rigTool, nodeId, rigHere]);
  const paintToolOn = activeTool === 'paint' || activeTool === 'eraser' || activeTool === 'roto';
  // Re-render on any document change: the layer, its bar, masks and anchor
  // below come from the document mirror (B4).
  useMirrorRevision();
  const m = documentMirror();
  const node = nodeId ? m.layer(nodeId) : undefined;
  useRetainTree(node ? nodeId : null);

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

  const compTime = useCurrentTime();
  const compSettings = useActiveTabCompSettings();
  const compDuration = settingsDurationSeconds(compSettings, DEFAULT_COMPOSITION.durationSeconds);
  const compFps = settingsFps(compSettings, DEFAULT_COMPOSITION.fps);

  // The layer's bar from its LayerTiming (a trim is a document change: the
  // mirror's revision re-renders this).
  const clip = useMemo(() => {
    if (!nodeId || !node || !mirrorHasBar(m, nodeId)) return null;
    const layerComp = m.comp(node.comp);
    const fps = settingsFps(layerComp?.settings, compFps || 30);
    const bar = timingBarFrames(node.timing, fps);
    return {
      id: `clip:${nodeId}`,
      fps,
      start: bar.start / fps,
      inT: bar.sourceIn / fps,
      dur: bar.duration / fps,
      sourceDur: bar.sourceDuration !== null ? bar.sourceDuration / fps : null,
    };
  }, [m, nodeId, node, compFps]);

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
  /** The moment in comp seconds — where masks are read (the mirror evaluates at comp time) and edits land. */
  const maskCompTime = heldLayerTime !== null ? compTimeAt(heldLayerTime) : compTime;

  const frame = node && nodeId ? layerFrame(m, nodeId, node) : { width: 1, height: 1 };
  const stageRef = useRef<HTMLDivElement>(null);
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
  // The pixels are the engine's: this layer alone, at its source size, on its
  // own engine viewport (setViewport `layer`), at the panel's held time when
  // the ruler is scrubbed, else at the comp playhead.
  const layerView = useMemo(
    () => (node && nodeId ? {
      id: nodeId,
      renderEffects: renderOn,
      ...(alphaView !== 'off' ? { alphaView } : {}),
      ...(heldLayerTime !== null ? { time: renderCompTime, sourceTime: heldLayerTime } : {}),
    } : undefined),
    [node, nodeId, renderOn, alphaView, heldLayerTime, renderCompTime],
  );

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
      try { seekPlayhead(ct); } catch { /* headless */ }
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

  // ── Framing: zoom, pan, Fit ────────────────────────────────────────
  // One camera, owned here: a zoom and the layer's centre on the stage. The
  // engine draws the layer centred in its COMPOSITION's frame (snapshot_build's
  // layer view: x = comp width / 2), whatever size it fits its viewport to — the
  // source file's pixels, or a placeholder's when the file is missing. Letting
  // each side "fit" its own idea of the frame put the picture and its outline
  // in different places; the engine is told where the comp's origin is, and the
  // overlays where the layer's own frame is, under the same zoom and centre.
  const layerComp = node ? m.comp(node.comp)?.settings : undefined;
  const compFrame = { width: layerComp?.width ?? frame.width, height: layerComp?.height ?? frame.height };
  /** null = Fit. */
  const [zoom, setZoom] = useState<number | null>(null);
  /** The layer's centre, in stage pixels from the stage's centre. */
  const [pan, setPan] = useState({ x: 0, y: 0 });
  useEffect(() => {
    setZoom(null);
    setPan({ x: 0, y: 0 });
  }, [nodeId]);
  const fitScale = stage.width > 0 && stage.height > 0
    ? Math.min(stage.width / frame.width, stage.height / frame.height) * FIT_MARGIN
    : 0;
  const scale = zoom ?? fitScale;
  const centreX = stage.width / 2 + (zoom === null ? 0 : pan.x);
  const centreY = stage.height / 2 + (zoom === null ? 0 : pan.y);
  // What the engine pane reads when asked (EnginePaneSurface `getView`), and the nudge that asks it.
  const engineViewRef = useRef({ scale: 0, offsetX: 0, offsetY: 0 });
  engineViewRef.current = {
    scale,
    offsetX: centreX - (scale * compFrame.width) / 2,
    offsetY: centreY - (scale * compFrame.height) / 2,
  };
  const getEngineView = useRef(() => engineViewRef.current).current;
  const [framingRev, setFramingRev] = useState(0);
  useEffect(() => {
    setFramingRev((n) => n + 1);
  }, [scale, centreX, centreY, compFrame.width, compFrame.height]);

  const zoomAt = (next: number, px: number, py: number): void => {
    if (scale <= 0) return;
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    // The point under the pointer stays under it.
    const cx = px - (px - centreX) * (z / scale);
    const cy = py - (py - centreY) * (z / scale);
    setZoom(z);
    setPan({ x: cx - stage.width / 2, y: cy - stage.height / 2 });
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    zoomAt(scale * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  // Panning: the Hand tool, or the middle button with any tool (as in the
  // Composition viewer). Taken in the capture phase so the mask and paint
  // layers over the picture never see the press.
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onStagePointerDownCapture = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 1 && !(e.button === 0 && activeTool === 'hand')) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    panDrag.current = { x: e.clientX, y: e.clientY, px: centreX - stage.width / 2, py: centreY - stage.height / 2 };
    if (zoom === null) setZoom(scale);
  };
  const onStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = panDrag.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  };
  const onStagePointerUp = (): void => {
    panDrag.current = null;
  };

  // The Tracker's points and an effect's point controls are drawn by their own
  // overlays (the Composition viewer's), hosted under this viewer's camera:
  // layer-local px (the layer's centre is the origin) ↔ this stage.
  const hostOffX = centreX;
  const hostOffY = centreY;
  const overlayHost = useMemo<TrackPointHost | null>(() => (scale > 0 ? {
    mapping: {
      localToScreen: (lx, ly) => ({ x: hostOffX + scale * lx, y: hostOffY + scale * ly }),
      screenToLocal: (sx, sy) => ({ x: (sx - hostOffX) / scale, y: (sy - hostOffY) / scale }),
    },
    frame: { width: frame.width, height: frame.height },
    zoom: scale,
  } : null), [scale, hostOffX, hostOffY, frame.width, frame.height]);

  // The main tool bar's tool drives the masks here, as in After Effects: the
  // Selection tool reshapes, the shape and pen tools draw. (Brush, Eraser and
  // Roto Brush are read by LayerPaintSurface from the same tool.)
  useEffect(() => {
    const next = MASK_TOOL_OF[activeTool];
    if (next && next !== maskTool) setMaskTool(next);
    // A drawing tool with masks hidden would draw into nothing visible.
    if (next && next !== 'select' && !showMasks) setView({ showMasks: true });
  }, [activeTool, maskTool, setMaskTool, showMasks, setView]);

  if (!nodeId || !node) return null;

  const shownIn = drag?.kind === 'in' ? drag.value : clip?.inT ?? 0;
  const shownOut = drag?.kind === 'out' ? drag.value : outT;
  const pct = (v: number): string => `${(Math.min(Math.max(v / span, 0), 1) * 100).toFixed(3)}%`;

  // ── Overlay (frame, anchor): the layer's own frame under the camera above ──
  const view = scale > 0 ? { scale, offsetX: centreX - (scale * frame.width) / 2, offsetY: centreY - (scale * frame.height) / 2 } : null;
  const map = (x: number, y: number): [number, number] => (view
    ? [view.offsetX + view.scale * (x + frame.width / 2), view.offsetY + view.scale * (y + frame.height / 2)]
    : [0, 0]);
  // The anchor and the masks at this moment, from the mirror (evaluated at comp time).
  const anchorX = readTrack(m, nodeId, 'anchorX', maskCompTime) ?? 0;
  const anchorY = readTrack(m, nodeId, 'anchorY', maskCompTime) ?? 0;
  const [ax, ay] = map(Number(anchorX) || 0, Number(anchorY) || 0);

  // The picked mask, as the renderer reads it now.
  const masks = mirrorMasksAt(m, nodeId, secondsToFlicks(maskCompTime));
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

  const shown = [showMasks && 'Masks', showAnchor && 'Anchor', showTracker && trackedHere && 'Tracker', showEffectPoints && effectHere && 'Effect'].filter(Boolean);
  const alphaLabel = ALPHA_VIEWS.find((a) => a.id === alphaView)?.label;
  const viewLabel = [...(alphaLabel ? [alphaLabel] : []), ...(shown.length === 0 && !alphaLabel ? ['None'] : shown)].join(', ');
  const viewItems: DropdownItem[] = [
    { type: 'checkbox', id: 'masks', label: 'Masks', checked: showMasks, onChange: (on) => setView({ showMasks: on }) },
    { type: 'checkbox', id: 'anchor', label: 'Anchor Point', checked: showAnchor, onChange: (on) => setView({ showAnchor: on }) },
    { type: 'checkbox', id: 'tracker', label: 'Motion Tracker Points', checked: showTracker, onChange: (on) => setView({ showTracker: on }) },
    { type: 'checkbox', id: 'effect', label: 'Effect Controls', checked: showEffectPoints, onChange: (on) => setView({ showEffectPoints: on }) },
    { type: 'separator' },
    // How the matte reads (Roto Brush, masks): one at a time; picking the
    // current one again goes back to the layer as it is.
    ...ALPHA_VIEWS.map((a): DropdownItem => ({
      type: 'checkbox',
      id: `alpha-${a.id}`,
      label: a.label,
      checked: alphaView === a.id,
      onChange: (on) => setView({ alphaView: on ? a.id : 'off' }),
    })),
    { type: 'separator' },
    { type: 'checkbox', id: 'rulers', label: 'Rulers and Guides', checked: showRulers, onChange: (on) => setRulers(on) },
    ...(guides.x.length + guides.y.length > 0
      ? [{ type: 'item', id: 'clear-guides', label: 'Clear Guides', onSelect: () => setGuides({ x: [], y: [] }) } as DropdownItem]
      : []),
    { type: 'separator' },
    { type: 'checkbox', id: 'render', label: 'Render (masks and effects)', checked: renderOn, onChange: (on) => setView({ render: on }) },
  ];
  const zoomItems: DropdownItem[] = [
    { type: 'checkbox', id: 'fit', label: 'Fit', checked: zoom === null, onChange: () => { setZoom(null); setPan({ x: 0, y: 0 }); } },
    { type: 'separator' },
    ...ZOOM_STEPS.map((z): DropdownItem => ({
      type: 'checkbox',
      id: `z${z}`,
      label: `${Math.round(z * 100)} %`,
      checked: zoom !== null && Math.abs(zoom - z) < 1e-6,
      onChange: () => zoomAt(z, stage.width / 2, stage.height / 2),
    })),
  ];

  const hint = activeTool === 'roto'
    ? 'Roto Brush: paint over the subject. Alt-drag marks the background.'
    : activeTool === 'paint'
      ? 'Brush: drag to paint on the layer. Size and colour are in the tool options.'
      : activeTool === 'eraser'
        ? 'Eraser: drag to erase the layer’s paint.'
        : activeTool === 'hand'
          ? 'Hand: drag to move the view. The wheel zooms.'
          : maskTool === 'pen'
            ? 'Pen: click for corners, drag for curves. Click the first point or press Enter to close the mask.'
            : maskTool === 'rect'
              ? 'Rectangle: drag to draw a mask.'
              : maskTool === 'ellipse'
                ? 'Ellipse: drag to draw a mask.'
                : null;
  const options = pickedMask && !paintToolOn;
  const paintOptions = activeTool === 'paint';

  // A composition layer is ONE picture here: its parts are layers of ITS
  // composition, and that is where they are selected (as in After Effects).
  const opensAsComposition = canOpenLayerComposition(nodeId);

  return (
    <div className={styles.root} data-testid="layer-viewer">
      {opensAsComposition ? (
        <div className={styles.notice} role="note">
          <span>This layer is a composition. Its parts cannot be selected here.</span>
          <Button variant="primary" size="sm" onClick={() => { openLayerComposition(nodeId); }} title="Open the composition this layer shows: each part is its own layer there">
            Open composition
          </Button>
        </div>
      ) : null}
      {/* The options line: the picked mask's switches, else what the active
          tool does here. No second title — the tab names the layer. */}
      {options || hint || paintOptions ? (
        <div className={styles.options}>
          {options && pickedMask ? (
            <div className={styles.maskControls} aria-label="Selected mask">
              <span className={styles.optLabel}>Mask</span>
              <select
                className={styles.modeSelect}
                aria-label="Mask mode"
                value={pickedMask.mode}
                disabled={node.switches.locked}
                onChange={(e) => editMask('Mask Mode', { mode: e.target.value as MaskMode })}
              >
                {MASK_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
              </select>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={pickedMask.inverted}
                  disabled={node.switches.locked}
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
                disabled={node.switches.locked}
                title="Delete this mask (Delete)"
              >
                Delete mask
              </Button>
            </div>
          ) : paintOptions ? (
            // The Paint tool: Brush or Clone Stamp, and what matters for each.
            // Size and colour stay in the tool bar's own options; the Paint and
            // Brushes panels hold the rest.
            <div className={styles.maskControls} aria-label="Paint options">
              <select
                className={styles.modeSelect}
                aria-label="Paint tool"
                value={paintMode === 'clone' ? 'clone' : 'paint'}
                onChange={(e) => setPaint({ mode: e.target.value as typeof paintMode })}
              >
                <option value="paint">Brush</option>
                <option value="clone">Clone Stamp</option>
              </select>
              <span className={styles.optLabel}>Opacity <b className={styles.optValue}>{Math.round(paintOpacity * 100)} %</b></span>
              <span className={styles.optLabel}>Hardness <b className={styles.optValue}>{Math.round(paintHardness * 100)} %</b></span>
              <span className={styles.optLabel}>Duration <b className={styles.optText}>{PAINT_DURATION_LABEL[paintDuration] ?? paintDuration}</b></span>
              {paintMode === 'clone' ? (
                <>
                  <label className={styles.check} title="Keep the source at the same offset from the brush between strokes">
                    <input type="checkbox" checked={cloneAligned} onChange={(e) => setPaint({ cloneAligned: e.target.checked })} />
                    Aligned
                  </label>
                  <label className={styles.check} title="Copy from one fixed frame of the source instead of the current time">
                    <input type="checkbox" checked={cloneLockTime} onChange={(e) => setPaint({ cloneLockTime: e.target.checked })} />
                    Lock source time
                  </label>
                  <span className={styles.hintText}>{cloneSourceSet ? 'Source set. Alt-click to move it.' : 'Alt-click the layer to set the source.'}</span>
                </>
              ) : (
                <span className={styles.hintText}>Drag to paint on the layer.</span>
              )}
            </div>
          ) : (
            <span className={styles.hintText}>{hint}</span>
          )}
        </div>
      ) : null}

      <div
        ref={stageRef}
        className={cn(styles.stage, activeTool === 'hand' && styles.stageHand)}
        onWheel={onWheel}
        onPointerDownCapture={onStagePointerDownCapture}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
      >
        {layerView ? (
          <EnginePaneSurface
            mode="active"
            framingRev={framingRev}
            getView={getEngineView}
            layer={layerView}
            className={styles.canvas}
            // Exposure is how the viewer SHOWS the picture, in stops (×2 per stop); the render is untouched.
            style={exposure !== 0 ? { filter: `brightness(${Math.pow(2, exposure).toFixed(4)})` } : undefined}
          />
        ) : null}
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
            maskCompTime={maskCompTime}
          />
        ) : null}
        {/* Paint strokes under the Selection tool: only the strokes take the
            pointer, so masks stay editable everywhere else. */}
        {view && renderOn ? (
          <LayerPaintSelect
            nodeId={nodeId}
            frameWidth={frame.width}
            frameHeight={frame.height}
            view={view}
            stageWidth={stage.width}
            stageHeight={stage.height}
            compTime={renderCompTime}
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
        {/* An effect's point controls (the effect picked in Effect Controls) and
            the Tracker's points, on the layer itself. Each draws nothing unless
            its own panel has this layer as its target. */}
        {overlayHost && showEffectPoints && effectHere ? (
          <div className={styles.hosted}><EffectHandleOverlay host={overlayHost} /></div>
        ) : null}
        {overlayHost && showTracker && trackedHere ? (
          <div className={styles.hosted}><TrackPointOverlay host={overlayHost} /></div>
        ) : null}
        {view && showRulers ? (
          <ViewerRulers
            width={stage.width}
            height={stage.height}
            scale={view.scale}
            originX={view.offsetX}
            originY={view.offsetY}
            guides={guides}
            onGuidesChange={setGuides}
          />
        ) : null}
        {/* Rigging on the layer itself: puppet pins (as in After Effects' Layer
            panel) and the bone tool. Each overlay draws only while its own tool
            is active and THIS layer is the selected one, and then takes the
            pointer over the mask and paint layers beneath it. */}
        {overlayHost && rigHere && activeTool === 'puppet-pin' ? (
          <div className={styles.hosted}><PuppetOverlay host={overlayHost} /></div>
        ) : null}
        {overlayHost && rigHere && BONE_TOOLS.has(activeTool) ? (
          <div className={styles.hosted}><BoneOverlay host={overlayHost} /></div>
        ) : null}
      </div>

      {/* The layer's own time: the whole source, the part the composition uses
          lit between { and }, and the composition's current time. */}
      {clip ? (
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
      ) : null}

      <div className={styles.footer}>
        <Dropdown
          placement="top-start"
          items={zoomItems}
          trigger={
            <button type="button" className={styles.select} title="Zoom — the wheel zooms, the middle button or the Hand tool moves the view">
              <span>{zoom === null ? 'Fit' : `${Math.round(scale * 100)} %`}</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          }
        />
        <span className={styles.sep} aria-hidden />
        <span className={styles.timecode} title="Current time, in layer time">{timecode(layerT, fps)}</span>
        {clip ? (
          <>
            <Button variant="ghost" size="xs" title="Set the In point to the current time" onClick={() => commitTrim('start', clampIn(layerT))}>
              {'{'}
            </Button>
            <span className={styles.readout} title="In point">{timecode(shownIn, fps)}</span>
            <Button variant="ghost" size="xs" title="Set the Out point to the current time" onClick={() => commitTrim('end', clampOut(layerT))}>
              {'}'}
            </Button>
            <span className={styles.readout} title="Out point">{timecode(shownOut, fps)}</span>
            <span className={styles.readout} title="Duration">Δ {timecode(shownOut - shownIn, fps)}</span>
          </>
        ) : (
          <span className={styles.readout}>This layer has no bar of its own in the timeline (it is inside a group).</span>
        )}
        <span className={styles.spacer} />
        <span className={styles.exposure} title="Exposure, in stops: how this viewer shows the picture. It does not change the render. Double-click to reset.">
          <span className={styles.optLabel}>Exposure</span>
          <span onDoubleClick={() => setExposure(0)}>
            <ValueField value={exposure} onChange={setExposure} min={-8} max={8} step={0.05} precision={1} aria-label="Exposure (stops)" />
          </span>
        </span>
        <span className={styles.readout} title="The layer’s own size">{Math.round(frame.width)} × {Math.round(frame.height)}</span>
        <Dropdown
          placement="top-end"
          items={viewItems}
          trigger={
            <button type="button" className={styles.select} title="What is drawn over the layer">
              <span>View: {viewLabel}</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          }
        />
        <label className={styles.check} title="Show the layer with its masks and effects. Off shows the untouched source.">
          <input type="checkbox" checked={renderOn} onChange={(e) => setView({ render: e.target.checked })} />
          Render
        </label>
      </div>
    </div>
  );
}

export default LayerViewer;
