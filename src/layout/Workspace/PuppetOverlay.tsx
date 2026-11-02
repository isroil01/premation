import React, { useCallback, useEffect, useState, useRef } from 'react';
import { secondsToFlicks, type OverlayKind } from '@motion/engine-api';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useActiveCompSize } from '@hooks/useMirrorFrame';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { layerScreenMapping } from './layerScreen';
import { useDisplayedCamera2D } from './useOverlayView';
import type { TrackPointHost } from './TrackPointOverlay';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { pinColor, pinHasTransformGizmo, type PinKind, type PuppetRig } from '@core/rig/puppet';
import { SketchRecorder, DEFAULT_SKETCH_TOLERANCE } from '@core/rig/puppetSketch';
import { edit } from '@core/engine/uiEdits';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { rigPaths, rigMatch, rigValues, rigRemove } from '@core/engine/rigPaths';
import { useGesture } from '@hooks/useGesture';
import {
  MAIN_VIEWPORT, overlayLayer, requestOverlayLayers, setOverlayRigFocus, subscribeOverlayGeometry,
} from '@stores/overlayGeometry';
import { applyRigDragBasis, rigRestPoints, rigDragBasis, RigPointerQueue, type RigDragBasis } from './rigPointer';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import { pinPositionCommands, pinPropCommands, rigAutoKey } from '@layout/Inspector/rigEdits';
import type { Command } from '@motion/engine-api';
import { t } from '@core/i18n';

/** Radius (screen px) of the advanced-pin gizmo ring. */
const GIZMO_R = 26;

const NO_PINS: readonly string[] = [];

/**
 * One pin drag (C2). The pointer is mapped into the pin (rest) space through
 * `basis` — an affine fit of the rig pose around the grab point, queried ONCE
 * at pointer-down (`rigDragBasis`) — so every move is local arithmetic and
 * the engine sees one write per animation frame, not a getRigPose round trip
 * per pointer event. `starts` holds every selected pin's live position /
 * rotation at pointer-down: a move or rotate applies the same delta to all of
 * them (group move), AE's multi-pin drag.
 */
interface PinDrag {
  pinId: string;
  startScreen: { x: number; y: number };
  /** Alt-drag rotates; the gizmo's square handle scales; Ctrl records. */
  mode: 'move' | 'rotate' | 'scale' | 'sketch';
  /** The rotate / scale pivot (the pin before the skeleton) at pointer-down. */
  center: { x: number; y: number };
  startAngleDeg: number;
  startRotationDeg: number;
  startDist?: number;
  startScale?: number;
  /** Decided once at pointer-down (rigEdits `rigAutoKey(true)`), never mid-gesture. */
  autoKey: boolean;
  /** The pins the drag moves / rotates together, with their live values at pointer-down. */
  starts: Map<string, { x: number; y: number; rotation: number; bend: boolean }>;
  basis: RigDragBasis | null;
  /** Resolves once `basis` is set (the first getRigPose answered). */
  ready: Promise<void>;
  /** The latest pointer position (layer space) not yet written. */
  pendingLocal: { x: number; y: number } | null;
  raf: number | null;
}

/** The overlay geometry the pins draw from: the rig (pins, lattice, focus path) and the layer's box. */
const PUPPET_KINDS: ReadonlyArray<OverlayKind> = ['rig', 'bounds', 'transform'];

/**
 * Pointer capture is a nicety, not a precondition: it keeps a drag alive when
 * the pointer leaves the SVG. `setPointerCapture` throws NotFoundError if the
 * id is not an active pointer, and an uncaught throw here aborts the rest of
 * the pointerdown handler — losing the selection and the drag it was setting
 * up. The release path was already guarded; this is the missing other half.
 */
function capturePointer(svg: SVGSVGElement, pointerId: number): void {
  try {
    svg.setPointerCapture(pointerId);
  } catch {
    /* capture unavailable — the drag still works, it just won't track outside */
  }
}

/**
 * The puppet lattice as one SVG path, from the engine's edge list.
 *
 * After Effects' Puppet overlay is a regular lattice, not a filled
 * triangulation: the engine sends the mesh's unique edges (a grid mesh keeps
 * only its rest-axis edges — boxes; an outline mesh every edge), drawn here at
 * the deformed positions (OverlayRig.vertices / edges).
 */
function puppetLatticePath(
  posed: readonly number[],
  edges: readonly number[],
  toScreen: (x: number, y: number) => { x: number; y: number },
): string {
  let d = '';
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const a = edges[i]!;
    const b = edges[i + 1]!;
    const p = toScreen(posed[a * 2]!, posed[a * 2 + 1]!);
    const q = toScreen(posed[b * 2]!, posed[b * 2 + 1]!);
    d += `M${p.x.toFixed(2)} ${p.y.toFixed(2)}L${q.x.toFixed(2)} ${q.y.toFixed(2)}`;
  }
  return d;
}

/**
 * `host`: another viewer drawing the pins under its own camera — the Layer
 * viewer, where After Effects also lets you place puppet pins. The rig still
 * comes from the engine's frame; only the projection is the host's.
 */
export function PuppetOverlay({ host }: { host?: TrackPointHost } = {}): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const puppetPinKind = useUIStore((s) => s.puppetPinKind);
  const selectedNodeId = useSelectionStore((s) => s.ids[0]);
  const activeWorkspace = useActiveWorkspace();
  const time = activeWorkspace?.time ?? 0;
  const comp = useActiveCompSize();
  const active = activeTool === 'puppet-pin' && !!selectedNodeId;
  // B4: the stored rig from the mirror (mesh expansion); everything posed comes with the frame.
  const puppetRig = useMirrorJson<PuppetRig>(active ? selectedNodeId : null, 'layer/puppet');

  // C2: the pin selection lives in the rig selection store (the Rig panel's
  // cards and "Key selected" share it). Several pins may be selected
  // (Shift-click, marquee); the LAST is the primary — the gizmo and motion path.
  const pinIds = useRigSelectionStore((s) => (s.nodeId === selectedNodeId ? s.pinIds : NO_PINS));
  const selectedPinId = pinIds[pinIds.length - 1] ?? null;
  const setSelectedPinId = useCallback((pinId: string | null): void => {
    if (!selectedNodeId) return;
    useRigSelectionStore.getState().selectPins(selectedNodeId, pinId ? [pinId] : []);
  }, [selectedNodeId]);
  const [hoveredPinId, setHoveredPinId] = useState<string | null>(null);
  /** Shift-drag on empty canvas: the selection rectangle, screen px. */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number; additive: boolean } | null>(null);
  const dragInfoRef = useRef<PinDrag | null>(null);
  /** Live Puppet Sketch recorder (3A) — accumulates while Ctrl-dragging. */
  const sketchRef = useRef<SketchRecorder | null>(null);
  const [sketchTolerance, setSketchTolerance] = useState(DEFAULT_SKETCH_TOLERANCE);
  const [isRecording, setIsRecording] = useState(false);
  /** Spatial tangent handle being dragged (the pin motion path). */
  const tangentDragRef = useRef<{
    pinId: string;
    /** Index of the key in the pin's position track (the handles' order). */
    index: number;
    which: 'in' | 'out';
    /** The key's stored (rest-space) point, read off the frame at pointer-down. */
    point: { x: number; y: number };
    /** The key's engine id, once the getKeyframes query answered. */
    keyId: string | null;
  } | null>(null);
  /** One pin drag / gizmo drag / tangent drag = one engine gesture = one undo entry. */
  const gesture = useGesture();
  /** A drag's pointer points go back through the rig pose asynchronously: its writes run in order. */
  const queueRef = useRef(new RigPointerQueue());
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Drag/element-origin guard: pointerup synthesizes a click even after a drag
  // (stopPropagation on pointerdown does NOT stop it), so every pin drag-release
  // used to also spawn a stray pin. Any pointerdown on an existing pin, any
  // completed drag, or travel past the slop suppresses the click-add.
  const suppressClickAddRef = useRef(false);

  const deletePin = useCallback((nodeId: string, pinId: string) => {
    // One undo entry: removePropertyGroups takes the pin AND its keyframes
    // (position/rotation/scale/stiffness/overlap); undo restores both.
    void edit('Delete Puppet Pin', rigRemove(nodeId, [rigPaths.pin(pinId)]));
    if (selectedPinId === pinId) setSelectedPinId(null);
  }, [selectedPinId, setSelectedPinId]);

  // Force re-render on render ticks / camera movements. `onRender` returns a
  // disposer now (it used to be a single-slot setter, so this subscription was
  // being clobbered by the viewport's and the handles froze during a pan).
  const [, setTick] = useState(0);
  useEffect(() => {
    const controller = getWorkspaceController();
    const offRender = controller.onRender(() => {
      setTick((t) => t + 1);
    });
    // B4: and when a frame's geometry lands (the C++ engine draws the viewport).
    const offGeometry = subscribeOverlayGeometry(MAIN_VIEWPORT, () => setTick((t) => t + 1));
    return () => {
      offRender();
      offGeometry();
    };
  }, []);

  // B4 round 5: the rig comes with the frame (the overlay geometry push): this
  // layer's rig and box, the selected pin's motion path, the Puppet tool's
  // authoring mesh (a pinless layer shows the mesh its first pin lands on).
  // The layer subscription and the rig focus are sent separately and cleared only on unmount:
  // clearing them between two sends let a frame land without this layer's geometry, which
  // dropped the overlay for that frame on every pin selection.
  useEffect(() => {
    void requestOverlayLayers(MAIN_VIEWPORT, 'puppetPins', active ? [selectedNodeId!] : [], PUPPET_KINDS).then(() => setTick((t) => t + 1));
  }, [active, selectedNodeId]);
  useEffect(() => {
    void setOverlayRigFocus(MAIN_VIEWPORT, active ? { pin: selectedPinId ?? '', bone: '', authoring: true } : undefined);
  }, [active, selectedNodeId, selectedPinId]);
  useEffect(() => () => {
    void requestOverlayLayers(MAIN_VIEWPORT, 'puppetPins', [], PUPPET_KINDS);
    void setOverlayRigFocus(MAIN_VIEWPORT, undefined);
  }, []);

  // The comp ↔ stage mapping of the frame on screen (the pins move with the
  // picture, not ahead of it). A hook: read before the early return below.
  const camera = useDisplayedCamera2D();

  // Keyboard listener to delete selected pin
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTool !== 'puppet-pin' || !selectedNodeId || pinIds.length === 0) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        // Every selected pin, with its keyframes, as ONE undo entry.
        void edit(pinIds.length > 1 ? 'Delete Puppet Pins' : 'Delete Puppet Pin', rigRemove(selectedNodeId, pinIds.map((id) => rigPaths.pin(id))));
        useRigSelectionStore.getState().selectPins(selectedNodeId, []);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool, selectedNodeId, pinIds]);

  if (!active) return null;
  const nodeId = selectedNodeId!;

  const geometry = overlayLayer(MAIN_VIEWPORT, nodeId, secondsToFlicks(time));
  // The layer's drawn box at the frame (x, y, w, h, layer space).
  const box = geometry?.box;
  if (!box || box.length < 4) return null;
  const rig = geometry?.rig;
  const pins = rig?.pins ?? [];

  const controller = getWorkspaceController();

  // ONE projection, shared with BoneOverlay and the effect-handle overlay.
  //
  // This was a local pair built on `worldMatrix(geom)`, byte-identical to
  // BoneOverlay's, and it composed only THIS node's transform — so on a
  // parented layer the pins drew at the unparented position while the artwork
  // rendered at the parented one (F23). `layerScreenMapping` goes through
  // `layerSpaceAt`, which walks the chain and handles 3D.
  const mapping = host ? host.mapping : layerScreenMapping(nodeId, time, comp, camera);
  const localToScreen = (lx: number, ly: number) =>
    mapping ? mapping.localToScreen(lx, ly) : { x: lx, y: ly };
  const screenToLocal = (sx: number, sy: number) =>
    mapping ? mapping.screenToLocal(sx, sy) : { x: sx, y: sy };

  const pad = puppetRig?.meshExpansion ?? 0;

  // ── Pin motion path (spatial tangents) ──────────────────────────────
  // The trajectory the SELECTED pin travels, sampled by the engine from the
  // same data track the renderer samples and posed like the pin dots
  // (OverlayRig.pinPath / pinKeys). Straight lines read as robotic; the
  // tangent handles are how you arc a limb. Only the selected pin's path is
  // drawn — every pin at once is unreadable on a dense rig.
  const pinPath = selectedPinId ? rig?.pinPath ?? [] : [];
  const pinKeys = selectedPinId ? rig?.pinKeys ?? [] : [];
  const motionPathD = (() => {
    if (pinPath.length < 4) return '';
    const pts: string[] = [];
    for (let i = 0; i + 1 < pinPath.length; i += 2) {
      const s = localToScreen(pinPath[i]!, pinPath[i + 1]!);
      pts.push(`${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)},${s.y.toFixed(1)}`);
    }
    return pts.join(' ');
  })();
  /** Per key: t, the stored (rest) point, and the posed point / handles (NaN = none). */
  const pathHandles = Array.from({ length: Math.floor(pinKeys.length / 9) }, (_, k) => {
    const r = pinKeys.slice(k * 9, k * 9 + 9);
    return {
      t: r[0]!,
      rest: { x: r[1]!, y: r[2]! },
      at: { x: r[3]!, y: r[4]! },
      in: Number.isNaN(r[5]!) ? null : { x: r[5]!, y: r[6]! },
      out: Number.isNaN(r[7]!) ? null : { x: r[7]!, y: r[8]! },
    };
  });

  // After Effects draws a gold lattice, not filled triangles (the engine's edge list).
  const meshPath = rig ? puppetLatticePath(rig.vertices, rig.edges, localToScreen) : '';

  /**
   * The point a pin's rotation gesture turns about, in the pin (rest) space the
   * pointer is mapped into: its own live position — for a bend pin the solved
   * mesh vertex it is bound to, where it visibly is (OverlayRig cx / cy).
   */
  const pinRotationCenter = (pinId: string): { x: number; y: number } => {
    const p = pins.find((q) => q.id === pinId);
    return { x: p?.cx ?? 0, y: p?.cy ?? 0 };
  };

  /** The pointer's screen position → the pin space, then `fn` (a drag's writes stay in order). */
  const withRestPoint = (sx: number, sy: number, fn: (p: { x: number; y: number }) => void): void => {
    queueRef.current.push(nodeId, time, screenToLocal(sx, sy), fn);
  };

  // Pointer drag operations

  /** The selected pins' live values at pointer-down (the drag's group); the grabbed pin is always in. */
  const dragStarts = (pinId: string): PinDrag['starts'] => {
    const ids = pinIds.includes(pinId) ? pinIds : [pinId];
    const starts: PinDrag['starts'] = new Map();
    for (const id of ids) {
      const p = pins.find((q) => q.id === id);
      if (p) starts.set(id, { x: p.cx, y: p.cy, rotation: p.rotation ?? 0, bend: p.kind === 'bend' });
    }
    return starts;
  };

  /** Start a drag: ONE getRigPose for the basis; the writes begin once it answers. */
  const beginDrag = (drag: Omit<PinDrag, 'basis' | 'ready' | 'pendingLocal' | 'raf'>, local: { x: number; y: number }): PinDrag => {
    const d: PinDrag = { ...drag, basis: null, ready: Promise.resolve(), pendingLocal: null, raf: null };
    d.ready = rigDragBasis(nodeId, time, local).then((basis) => {
      // Set even after pointer-up: the release waits on `ready` and flushes the last position.
      d.basis = basis;
      if (d.mode === 'rotate') {
        const r = basis.rest0;
        d.startAngleDeg = (Math.atan2(r.y - d.center.y, r.x - d.center.x) * 180) / Math.PI;
      } else if (d.mode === 'scale') {
        const r = basis.rest0;
        d.startDist = Math.max(1e-3, Math.hypot(r.x - d.center.x, r.y - d.center.y));
      }
      // Still dragging: write what the pointer did meanwhile (the release flushes itself).
      if (dragInfoRef.current === d) flushDrag(d, false);
    });
    dragInfoRef.current = d;
    return d;
  };

  /**
   * Write the pending pointer position: the whole selection's new pose as ONE
   * gesture message. Throttled to the animation frame (a pointer can report at
   * 1 kHz; the engine builds one frame per write it receives).
   */
  const flushDrag = (d: PinDrag, shift: boolean): void => {
    if (d.raf !== null) {
      cancelAnimationFrame(d.raf);
      d.raf = null;
    }
    const local = d.pendingLocal;
    const basis = d.basis;
    if (!local || !basis) return;
    d.pendingLocal = null;
    const rest = applyRigDragBasis(basis, local);
    const cmds: Command[] = [];
    if (d.mode === 'rotate') {
      const { x: cx, y: cy } = d.center;
      const angleDeg = (Math.atan2(rest.y - cy, rest.x - cx) * 180) / Math.PI;
      let delta = angleDeg - d.startAngleDeg;
      // Shift constrains rotation to 15° increments, matching AE's gizmo.
      if (shift) delta = Math.round((d.startRotationDeg + delta) / 15) * 15 - d.startRotationDeg;
      for (const [id, s] of d.starts) cmds.push(...pinPropCommands(nodeId, id, 'rotation', s.rotation + delta, time, d.autoKey));
    } else if (d.mode === 'scale') {
      const c = d.center;
      const dist = Math.hypot(rest.x - c.x, rest.y - c.y);
      let scale = (d.startScale ?? 1) * (dist / (d.startDist ?? 1));
      // Shift constrains scale to 5% steps, matching AE's gizmo.
      if (shift) scale = Math.round(scale * 20) / 20;
      cmds.push(...pinPropCommands(nodeId, d.pinId, 'scale', Math.max(0.01, scale), time, d.autoKey));
    } else if (d.mode === 'sketch') {
      // Record against the LIVE playhead (composition seconds — the axis the
      // keys are sent on) so the captured path is spread across real time
      // rather than collapsing onto one frame.
      sketchRef.current?.add(rest.x, rest.y, time);
    } else {
      // The grabbed pin follows the pointer; the rest of the selection moves by the same delta (rest space).
      const dx = rest.x - basis.rest0.x;
      const dy = rest.y - basis.rest0.y;
      for (const [id, s] of d.starts) {
        if (s.bend) continue;
        cmds.push(...pinPositionCommands(nodeId, id, { x: s.x + dx, y: s.y + dy }, time, d.autoKey));
      }
    }
    if (cmds.length > 0) gesture.send(cmds);
    controller.requestRender();
  };

  const queueDragMove = (d: PinDrag, local: { x: number; y: number }, shift: boolean): void => {
    d.pendingLocal = local;
    if (!d.basis || d.raf !== null) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = null;
      flushDrag(d, shift);
    });
  };

  const onPointerDownPin = (e: React.PointerEvent, pinId: string) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Shift-click extends the selection (AE); no drag starts from it.
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      useRigSelectionStore.getState().togglePin(nodeId, pinId);
      return;
    }
    // A pin already in a multi-selection keeps it (the drag moves them all); any other click selects it alone.
    if (!pinIds.includes(pinId)) setSelectedPinId(pinId);

    // Ctrl/Cmd = Puppet Sketch (record in real time during playback).
    // Alt = rotate the deformation around the pin. Plain drag = move.
    let mode: 'move' | 'rotate' | 'sketch' =
      e.ctrlKey || e.metaKey ? 'sketch' : e.altKey ? 'rotate' : 'move';
    // A bend pin has no position of its own to move or record — the solve
    // derives one from the pins around it. Dragging it rotates instead, which
    // is the one spatial thing it does own, rather than doing nothing at all.
    const pin = pins.find((p) => p.id === pinId);
    if (pin?.kind === 'bend' && mode !== 'rotate') mode = 'rotate';
    const center = pinRotationCenter(pinId);
    if (mode === 'sketch') {
      sketchRef.current = new SketchRecorder();
      setIsRecording(true);
    }

    // One gesture = one undo entry; every move sends the absolute value.
    gesture.begin(
      mode === 'sketch' ? `Sketch Puppet Pin ${pinId}` : mode === 'rotate' ? `Rotate Puppet Pin ${pinId}` : `Move Puppet Pin ${pinId}`,
    );
    beginDrag(
      { pinId, startScreen, mode, center, startAngleDeg: 0, startRotationDeg: pin?.rotation ?? 0, autoKey: rigAutoKey(true), starts: dragStarts(pinId) },
      screenToLocal(startScreen.x, startScreen.y),
    );
    capturePointer(svg, e.pointerId);
  };

  /** Grab the gizmo's square handle — uniform scale around the pin (3B). */
  const onPointerDownScale = (e: React.PointerEvent, pinId: string) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    if (!pinIds.includes(pinId)) setSelectedPinId(pinId);
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const startScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const center = pinRotationCenter(pinId);
    gesture.begin(`Scale Puppet Pin ${pinId}`);
    beginDrag(
      {
        pinId, startScreen, mode: 'scale', center, startAngleDeg: 0, startRotationDeg: 0, startDist: 1,
        startScale: pins.find((p) => p.id === pinId)?.scale ?? 1, autoKey: rigAutoKey(true), starts: dragStarts(pinId),
      },
      screenToLocal(startScreen.x, startScreen.y),
    );
    capturePointer(svg, e.pointerId);
  };

  /** Grab a spatial tangent handle on the selected pin's motion path. */
  const onPointerDownTangent = (
    e: React.PointerEvent,
    pinId: string,
    index: number,
    which: 'in' | 'out',
  ) => {
    e.stopPropagation();
    suppressClickAddRef.current = true;
    const svg = svgRef.current;
    const point = pathHandles[index]?.rest;
    if (!svg || !point) return;
    const drag = { pinId, index, which, point, keyId: null as string | null };
    tangentDragRef.current = drag;
    gesture.begin(`Curve Puppet Pin Path ${pinId}`);
    // The key's engine id (keys are addressed by id, never by time).
    void engine().query({ type: 'getKeyframes', props: [{ layer: nodeId, path: rigPaths.pinProp(pinId, 'position') }] }).then((res) => {
      if (res.ok) drag.keyId = res.value.sets[0]?.keyframes[index]?.id ?? null;
    });
    capturePointer(svg, e.pointerId);
  };

  /** Shift-drag on empty canvas: a marquee over the pins (adds to the selection). */
  const onPointerDownOverlay = (e: React.PointerEvent) => {
    if (!e.shiftKey || e.target !== svgRef.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    marqueeRef.current = { x0, y0, additive: true };
    setMarquee({ x0, y0, x1: x0, y1: y0 });
    suppressClickAddRef.current = true;
    capturePointer(svg, e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const mq = marqueeRef.current;
    if (mq) {
      setMarquee({ x0: mq.x0, y0: mq.y0, x1: sx, y1: sy });
      return;
    }

    // Tangent handles take precedence — they sit on top of the mesh.
    const tan = tangentDragRef.current;
    if (tan) {
      const alt = e.altKey;
      withRestPoint(sx, sy, (handle) => {
        if (!tan.keyId) return;
        // Plain drag mirrors the opposite handle (a smooth point, the AE default);
        // Alt breaks the point so the two sides move independently. Absolute
        // offsets from the key, per move.
        const d = [handle.x - tan.point.x, handle.y - tan.point.y];
        const other = alt ? null : [-d[0]!, -d[1]!];
        const patch = tan.which === 'out'
          ? { spatialOut: d, spatialIn: other ?? [] }
          : { spatialIn: d, spatialOut: other ?? [] };
        gesture.send({ type: 'updateKeyframes', patches: [{ id: tan.keyId, ...patch }] });
        controller.requestRender();
      });
      return;
    }

    const drag = dragInfoRef.current;
    if (!drag) return;
    // Rest space: pin POSITION tracks are stored in rest space (the puppet
    // solve runs in rest space before the skeleton skins on top), so the
    // pointer goes back through the pose — the drag's basis, fitted at pointer-down.
    queueDragMove(drag, screenToLocal(sx, sy), e.shiftKey);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    const release = (): void => {
      if (svg) {
        try { svg.releasePointerCapture(e.pointerId); } catch {}
      }
    };

    const mq = marqueeRef.current;
    if (mq) {
      marqueeRef.current = null;
      release();
      const rect = svg?.getBoundingClientRect();
      const x1 = rect ? e.clientX - rect.left : mq.x0;
      const y1 = rect ? e.clientY - rect.top : mq.y0;
      const [lx, hx] = [Math.min(mq.x0, x1), Math.max(mq.x0, x1)];
      const [ly, hy] = [Math.min(mq.y0, y1), Math.max(mq.y0, y1)];
      const inside = pins.filter((p) => {
        const s = localToScreen(p.x, p.y);
        return s.x >= lx && s.x <= hx && s.y >= ly && s.y <= hy;
      }).map((p) => p.id);
      const next = mq.additive ? [...pinIds.filter((id) => !inside.includes(id)), ...inside] : inside;
      useRigSelectionStore.getState().selectPins(nodeId, next);
      setMarquee(null);
      return;
    }

    const tan = tangentDragRef.current;
    if (tan) {
      tangentDragRef.current = null;
      release();
      void queueRef.current.then(() => gesture.end());
      return;
    }

    const drag = dragInfoRef.current;
    if (!drag) return;
    dragInfoRef.current = null;
    release();
    const shift = e.shiftKey;

    // The last pointer position lands before the gesture closes: wait for the
    // basis (the first answer) if it is still in flight, then flush.
    void drag.ready.then(async () => {
      flushDrag(drag, shift);
      // Puppet Sketch: reduce the raw stream to a few eased keyframes and write
      // them as the pin's position track. One recording = one undo step.
      if (drag.mode === 'sketch') {
        const kfs = sketchRef.current?.finish({ tolerance: sketchTolerance }) ?? [];
        sketchRef.current = null;
        setIsRecording(false);
        if (kfs.length > 0) await sendSketch(drag.pinId, kfs);
        else await gesture.end();
        return;
      }
      await gesture.end();
    });
  };

  /**
   * Puppet Sketch: the reduced keys as ONE batch inside the sketch's gesture —
   * the keys already inside the recorded span go (After Effects' Motion Sketch
   * replaces the keys of the interval it recorded), then the new ones land with
   * their easing.
   */
  const sendSketch = async (pinId: string, kfs: ReadonlyArray<{ t: number; value: Array<{ x: number; y: number }>; easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' }>) => {
    const path = rigPaths.pinProp(pinId, 'position');
    const lo = compTime(kfs[0]!.t);
    const hi = compTime(kfs[kfs.length - 1]!.t);
    const res = await engine().query({ type: 'getKeyframes', props: [{ layer: nodeId, path }], range: { start: lo, duration: hi - lo } });
    const inSpan = res.ok ? (res.value.sets[0]?.keyframes ?? []).filter((k) => k.time >= lo && k.time <= hi).map((k) => k.id) : [];
    gesture.send([
      ...(inSpan.length > 0 ? [{ type: 'deleteKeyframes' as const, ids: inSpan }] : []),
      {
        type: 'addKeyframes',
        keys: kfs.map((k) => ({
          prop: { layer: nodeId, path }, time: compTime(k.t), value: rigValues.vec2(k.value[0]!.x, k.value[0]!.y),
          spatialIn: [], spatialOut: [], ...(k.easing ? { easing: k.easing } : {}),
        })),
      },
    ]);
    await gesture.end();
  };

  const onDoubleClickPin = (e: React.MouseEvent, pinId: string) => {
    e.stopPropagation();
    deletePin(nodeId, pinId);
  };

  const onClickOverlay = (e: React.MouseEvent) => {
    // A pointerdown on an existing pin (or a completed drag) sets this guard so
    // the synthetic click that follows pointerup does NOT spawn a stray pin.
    if (suppressClickAddRef.current) {
      suppressClickAddRef.current = false;
      return;
    }
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const drawn = screenToLocal(e.clientX - rect.left, e.clientY - rect.top);
    const kind = puppetPinKind;
    const [bx, by, bw, bh] = box;

    // Pin positions are stored in REST space (the puppet solve runs in rest
    // space before the skeleton skins on top) — exactly like the drag path in
    // onPointerMove: the click goes back through the pose (getRigPose `rest`;
    // identity without a skeleton). A pin's anchor is then the REST point under
    // the deformed mesh (`anchors`): the clicked point itself becomes the pin's
    // live position (a keyframe at the current time) so the picture does not
    // move when the pin lands. Identity while no pin has moved: the inverse is
    // the click and no keyframe is written.
    void rigRestPoints(nodeId, time, [drawn]).then(({ rest, anchors }) => {
      const localCoords = rest[0] ?? drawn;
      // Click outside the layer's box should not add pins.
      if (
        localCoords.x < bx! - pad ||
        localCoords.x > bx! + bw! + pad ||
        localCoords.y < by! - pad ||
        localCoords.y > by! + bh! + pad
      ) {
        // Clears selection
        setSelectedPinId(null);
        return;
      }
      // Add a new pin — ONE undo entry. The engine mints the id (the lowest free
      // `pin_<n>`, never reused within the document).
      const restPoint = anchors[0] ?? localCoords;
      const displaced = Math.hypot(restPoint.x - localCoords.x, restPoint.y - localCoords.y) > 1e-3;
      void addPin(restPoint, displaced && kind !== 'bend' ? localCoords : null, kind);
    });
  };

  /**
   * addPropertyGroup (the rig is created with the first pin), then — when the
   * mesh is displaced under the click — the pin's Position key at the playhead,
   * so the picture does not move when the pin lands. One gesture = one entry.
   */
  const addPin = async (rest: { x: number; y: number }, live: { x: number; y: number } | null, kind: PinKind) => {
    const client = engine();
    const label = 'Add Puppet Pin';
    const open = await client.beginGesture(label);
    if (!open.ok) return;
    const res = await client.execute({
      type: 'addPropertyGroup', layer: nodeId, parent: rigPaths.pins, matchName: rigMatch.pin,
      init: [
        { path: 'kind', value: rigValues.choice(kind) },
        { path: 'restPosition', value: rigValues.vec2(rest.x, rest.y) },
      ],
    });
    const path = res.ok ? (res.value as { groups: string[] }).groups[0] : undefined;
    if (path && live) {
      await client.execute({
        type: 'addKeyframes',
        keys: [{ prop: { layer: nodeId, path: `${path}/position` }, time: compTime(time), value: rigValues.vec2(live.x, live.y), spatialIn: [], spatialOut: [] }],
      });
    }
    await client.endGesture(open.value.gesture, true);
    if (path) setSelectedPinId(path.split('/')[2]!);
  };

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'auto',
        zIndex: 10,
        cursor: 'crosshair',
      }}
      onPointerDown={onPointerDownOverlay}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClickOverlay}
    >
      {/* Shift-drag marquee: the pins inside join the selection on release. */}
      {marquee && (
        <rect
          x={Math.min(marquee.x0, marquee.x1)}
          y={Math.min(marquee.y0, marquee.y1)}
          width={Math.abs(marquee.x1 - marquee.x0)}
          height={Math.abs(marquee.y1 - marquee.y0)}
          fill="rgba(41, 136, 255, 0.12)"
          stroke="rgba(41, 136, 255, 0.9)"
          strokeWidth={1}
          pointerEvents="none"
        />
      )}
      {meshPath && (
        <path
          d={meshPath}
          data-puppet-mesh="true"
          fill="none"
          stroke="rgba(232, 196, 96, 0.55)"
          strokeWidth={1}
          strokeLinecap="butt"
          strokeLinejoin="miter"
          shapeRendering="geometricPrecision"
          pointerEvents="none"
        />
      )}

      {/* ── Selected pin's motion path + spatial tangent handles ──────────
          Drag a handle to arc the pin's trajectory; Alt-drag breaks the point
          so the two sides move independently. */}
      {motionPathD && (
        <path
          d={motionPathD}
          fill="none"
          stroke="#ffc107"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          pointerEvents="none"
          opacity={0.9}
        />
      )}
      {pathHandles.map((h, index) => {
        const anchor = localToScreen(h.at.x, h.at.y);
        return (
          <g key={`tan-${selectedPinId}-${h.t}`}>
            {/* Keyframe marker on the path */}
            <rect
              x={anchor.x - 3}
              y={anchor.y - 3}
              width={6}
              height={6}
              transform={`rotate(45 ${anchor.x} ${anchor.y})`}
              fill="#ffc107"
              stroke="#ffffff"
              strokeWidth={1}
              pointerEvents="none"
            />
            {(['out', 'in'] as const).map((which) => {
              const hp = which === 'out' ? h.out : h.in;
              if (!hp) return null;
              const s = localToScreen(hp.x, hp.y);
              return (
                <g
                  key={which}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => onPointerDownTangent(e, selectedPinId!, index, which)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <line
                    x1={anchor.x}
                    y1={anchor.y}
                    x2={s.x}
                    y2={s.y}
                    stroke="#ffc107"
                    strokeWidth={1}
                    opacity={0.7}
                    pointerEvents="none"
                  />
                  {/* Fat invisible hit area so the small dot is grabbable */}
                  <circle cx={s.x} cy={s.y} r={10} fill="transparent" />
                  <circle cx={s.x} cy={s.y} r={3.5} fill="#ffffff" stroke="#ffc107" strokeWidth={1.5} />
                </g>
              );
            })}
          </g>
        );
      })}

      {/* Render pin dots */}
      {pins.map((pin) => {
        // The engine's pose: a pin is drawn where the mesh actually IS — its live
        // position (a bend pin: the solved mesh vertex it is bound to) carried
        // through the skeleton pose (OverlayRig.pins x / y).
        const animPin = pin;
        const kind = pin.kind as PinKind;
        const color = pinColor(kind);
        const isBendPin = kind === 'bend';
        const screen = localToScreen(pin.x, pin.y);
        const isSelected = pinIds.includes(pin.id);
        const isPrimary = selectedPinId === pin.id;
        const isHovered = hoveredPinId === pin.id;

        return (
          <g
            key={`pin-g-${pin.id}`}
            style={{ cursor: 'pointer' }}
            onPointerDown={(e) => onPointerDownPin(e, pin.id)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => onDoubleClickPin(e, pin.id)}
            onMouseEnter={() => setHoveredPinId(pin.id)}
            onMouseLeave={() => setHoveredPinId(null)}
          >
            {/* Outer ring for highlight */}
            {(isSelected || isHovered) && (
              <circle
                cx={screen.x}
                cy={screen.y}
                r={10}
                fill="none"
                stroke={isSelected ? color : `${color}80`}
                strokeWidth={2}
              />
            )}
            {/* Rotation indicator (Alt-drag a pin to rotate its influence) */}
            {(animPin.rotation ?? 0) !== 0 && (
              <line
                x1={screen.x}
                y1={screen.y}
                x2={screen.x + 14 * Math.cos(((animPin.rotation ?? 0) * Math.PI) / 180)}
                y2={screen.y + 14 * Math.sin(((animPin.rotation ?? 0) * Math.PI) / 180)}
                stroke={isSelected ? color : color}
                strokeWidth={2}
              />
            )}
            {/* Core dot. Bend pins are hollow; the other four tools are solid
                circles in AE's colours so they are readable at a glance. */}
            <circle
              cx={screen.x}
              cy={screen.y}
              r={5}
              fill={isBendPin ? 'none' : color}
              stroke={isBendPin ? color : '#ffffff'}
              strokeWidth={isBendPin ? 2.5 : 1.5}
            />

            {/* Advanced / Bend gizmo — AE's rotate ring + scale square. Position,
                Starch and Overlap pins only move. */}
            {isPrimary && pinHasTransformGizmo(kind) && (
              <g>
                <circle
                  cx={screen.x} cy={screen.y} r={GIZMO_R}
                  fill="none" stroke={color} strokeWidth={1} opacity={0.55}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => {
                    // Dragging the ring rotates — reuse the rotate sub-mode.
                    const synthetic = { ...e, altKey: true } as React.PointerEvent;
                    onPointerDownPin(synthetic, pin.id);
                  }}
                />
                <rect
                  x={screen.x + GIZMO_R - 4} y={screen.y - 4} width={8} height={8}
                  fill="#ffffff" stroke={color} strokeWidth={1.5}
                  style={{ cursor: 'nwse-resize' }}
                  onPointerDown={(e) => onPointerDownScale(e, pin.id)}
                />
                {(animPin.scale ?? 1) !== 1 && (
                  <text
                    x={screen.x + GIZMO_R + 8} y={screen.y + 4}
                    fontSize={10} fill={color} style={{ userSelect: 'none' }}
                    pointerEvents="none"
                  >
                    {(animPin.scale ?? 1).toFixed(2)}x
                  </text>
                )}
              </g>
            )}
          </g>
        );
      })}

      {/* ── Puppet Sketch (3A) ───────────────────────────────────────────
          Ctrl/Cmd-drag a pin to record its motion live; on release the stream
          is reduced to a few eased keyframes. Tolerance controls how hard that
          reduction bites — the difference between usable and a keyframe swamp. */}
      {isRecording ? (
        <g pointerEvents="none">
          <circle cx={20} cy={20} r={6} fill="#ff3b30" />
          <text x={34} y={24} fontSize={12} fill="#ff3b30" style={{ userSelect: 'none' }}>
            {t('workspace.puppet.recording', 'Recording — release to reduce to keyframes')}
          </text>
        </g>
      ) : (
        pins.length > 0 && (
          <g transform="translate(12, 12)" onPointerDown={(e) => e.stopPropagation()}>
            <text x={0} y={12} fontSize={10} fill="rgba(255,255,255,0.7)" style={{ userSelect: 'none' }}>
              {t('workspace.puppet.sketchHint', 'Ctrl-drag a pin to sketch · tolerance {tolerance}px', { tolerance: sketchTolerance })}
            </text>
            {([-1, 1] as const).map((dir, i) => (
              <g
                key={dir}
                style={{ cursor: 'pointer' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSketchTolerance((t) => Math.max(0.5, Math.min(40, +(t + dir * 0.5).toFixed(1))));
                }}
              >
                <rect x={i * 24} y={20} width={20} height={18} rx={4} fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.25)" />
                <text x={i * 24 + 10} y={33} textAnchor="middle" fontSize={12} fill="#fff" style={{ userSelect: 'none' }}>
                  {dir < 0 ? '−' : '+'}
                </text>
              </g>
            ))}
          </g>
        )
      )}
    </svg>
  );
}
