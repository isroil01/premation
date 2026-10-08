/**
 * usePaneWorkspace — makes a secondary view pane INTERACTIVE.
 *
 * The panes used to be strictly view-only (`pointerEvents: 'none'`), so a 2-up
 * or 4-up layout gave you extra pictures of the scene and nothing else: you
 * could see a layer in the Top pane but not click it, and every edit had to be
 * made in the main viewport. After Effects does not work that way — every
 * viewport in a multi-view layout is live, and the one you last clicked becomes
 * the active viewer.
 *
 * Each pane therefore owns its own `Workspace`: its own camera (framed to the
 * pane box) and its own hit-tester, over a scene port bound to the view THAT
 * PANE shows. Binding the port is the load-bearing part — every node's
 * `worldMatrix` / `worldBounds` / `worldCorners` is projected through a view, so
 * a pane sharing the main viewport's port would hit-test a Top pane's pixels
 * against the Active Camera's projection and select whatever happened to sit
 * under that point in a completely different view.
 *
 * Selection and commands stay GLOBAL (the same ports the main viewport uses), so
 * selecting in a pane selects everywhere, and an edit made in a pane is the same
 * undoable command it would be anywhere else.
 *
 * Each pane also keeps its OWN framing: wheel zooms about the cursor,
 * middle-drag pans, and neither disturbs the main viewport or any sibling pane.
 * The camera is the single source for both the rendered pixels (via
 * `getRenderView`, handed to the renderer as the frame's `view`) and the SVG
 * chrome, so gizmos cannot drift off the layers when the framing changes. A pane
 * auto-frames the comp until the user frames it themselves, after which resizes
 * leave their framing alone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Workspace, modifiersFrom, type PointerInput, type SceneGraphPort } from '@motion/workspace';
import type { Camera3dMode } from '@stores/guidesStore';
import type { RenderView } from '@core/workspace/renderView';
import type { CustomViewParams } from '@core/workspace/customViews';
import { createSceneGraphPort, createSelectionPort, createCommandPort } from '@core/workspace/ports';
import { beginViewportGesture, endViewportGesture } from '@core/workspace/viewportGesture';
import { paneViewTransform } from './useSceneRefGeometry';
import { useUIStore } from '@stores/uiStore';

/** Engine tool ids the panes support. Creation/drawing tools stay in the main
 *  viewport, where the full gesture stack (guides, ROI, motion paths) lives.
 *
 *  This gates the ENGINE's tool only. The 3D chrome a pane also carries — the
 *  transform gizmo and the camera focus plane (see SecondaryViewPane) — is not
 *  a tool and is deliberately not listed here: in the main viewport those
 *  handles are live under every tool, and they claim a press ahead of the
 *  engine with their own capture-phase listener on the pane's box. Adding them
 *  to this set would only have switched the pane's engine to a tool that does
 *  not exist. */
const PANE_TOOLS = new Set(['select', 'move', 'rotate', 'pan-behind', 'direct-select']);

function buttonName(button: number): PointerInput['button'] {
  return button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
}

export interface PaneWorkspaceOptions {
  /** The view this pane shows. Read through a ref so switching the pane's view
   *  does not tear down its Workspace. */
  mode: Camera3dMode;
  /** Pane box in CSS pixels. */
  width: number;
  height: number;
  compWidth: number;
  compHeight: number;
  /** Called when the user interacts, so the host can mark this pane active. */
  onActivate?: () => void;
  /**
   * The custom orbit this pane's frame on screen was drawn with
   * (EnginePaneSurface `PaneDrawnView`); null/absent = the stored one. The
   * port's nodes — the pane's selection outline and hit-testing — project
   * through it, as the pane's picture does.
   */
  drawnCustomView?: CustomViewParams | null;
}

export interface PaneWorkspaceApi {
  /** Attach to the pane's interaction surface. */
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onWheel: (e: React.WheelEvent) => void;
  };
  /**
   * This pane's comp → canvas transform, read live from its camera.
   *
   * ONE source for the pixels and the chrome: the renderer takes it as the
   * frame's `view`, and the SVG overlays position against the same numbers. When
   * they were derived separately the gizmos drifted off the layers as soon as
   * the framing changed.
   */
  getRenderView: () => RenderView | undefined;
  /** Bumps whenever this pane's camera moves, to drive a repaint. */
  framingRev: number;
  /** The pane's engine, for chrome that needs to read its camera/hit state. */
  workspace: Workspace | null;
  /**
   * The pane's own scene port. Chrome drawn over the pane must read node
   * geometry from HERE, not from the main viewport's port — the two project
   * through different views, so a selection outline taken from the main port
   * would be drawn at the layer's position in a completely different view.
   */
  scene: SceneGraphPort;
}

export function usePaneWorkspace({
  mode,
  width,
  height,
  compWidth,
  compHeight,
  onActivate,
  drawnCustomView,
}: PaneWorkspaceOptions): PaneWorkspaceApi {
  // The port reads the mode through a ref, so changing the pane's view from its
  // selector re-projects on the next query instead of rebuilding the engine.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const drawnRef = useRef(drawnCustomView ?? null);
  drawnRef.current = drawnCustomView ?? null;

  // The port is stateless and disposable-free, so it can be memoised.
  const scene = useMemo(() => createSceneGraphPort(() => modeRef.current, () => drawnRef.current), []);

  /**
   * The engine is created INSIDE an effect, not in a `useMemo`.
   *
   * React 18 StrictMode runs mount → cleanup → mount in development. A
   * `useMemo`-created Workspace paired with a disposing cleanup is destroyed by
   * that first cleanup and then reused dead on the remount: its subscriptions
   * are gone, so its hit-test index never invalidates again and the pane silently
   * stops responding to scene changes. Creating and disposing in the SAME effect
   * makes the pair symmetric — the remount builds a fresh one.
   */
  const wsRef = useRef<Workspace | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  /** True once the user pans or zooms this pane — suppresses the auto-fit. */
  const userFramedRef = useRef(false);
  /** True once the camera has been framed (fitted, or by the user): until then it is not the pane's view. */
  const framedRef = useRef(false);
  /** In-flight middle-button pan. */
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  /**
   * The press this pane holds the viewport gesture for, and the pane's box at that press
   * (read once: the pane does not move under a drag, and reading layout on every move
   * forced a synchronous layout per pointer event while the pane re-rendered).
   */
  const pressRef = useRef<{ pointerId: number; rect: DOMRect } | null>(null);
  useEffect(() => () => {
    // Unmounting mid-drag (a layout switch) must not leak an open gesture transaction.
    if (pressRef.current) {
      pressRef.current = null;
      endViewportGesture();
    }
  }, []);
  useEffect(() => {
    const w = new Workspace({
      scene,
      selection: createSelectionPort(),
      commands: createCommandPort(() => modeRef.current),
      viewport: { width: 1, height: 1, dpr: 1 },
      camera: { minZoom: 0.01, maxZoom: 64 },
      // A pane draws no grid of its own, and the engine's Grid defaults to
      // VISIBLE — which is what gates grid snapping. Left at the default, every
      // pane snapped to a grid that was never on screen: dragging straight down
      // in a Top pane also jumped the layer 40px sideways, because the 6px snap
      // threshold is ~64 world units at a quarter-pane's zoom.
      grid: { visible: false },
    });
    w.initialize();
    wsRef.current = w;
    framedRef.current = false;  // a new engine's camera is unframed until the fit effect runs
    setWs(w);
    return () => {
      w.dispose();
      if (wsRef.current === w) wsRef.current = null;
    };
  }, [scene]);

  // Repaint when this pane's camera moves. The renderer redraws on scene/time
  // changes; panning is neither, so without this the pane would keep showing the
  // previous framing until something else happened to touch the scene.
  //
  // Subscribed BEFORE the fit below (effects run in order): the fit's own camera
  // change used to land before anyone listened, so the engine kept the pane's
  // first, unfitted camera (zoom 1 about the pane's centre) — a 2- / 4-up opened
  // on a giant crop of the comp, and every frame after it, drags included, was
  // drawn through that camera while the overlays used the fitted one.
  const [framingRev, setFramingRev] = useState(0);
  useEffect(() => {
    if (!ws) return;
    const sub = ws.events.on('CameraChanged', () => setFramingRev((n) => n + 1));
    return () => sub.dispose();
  }, [ws]);

  // Mirror the renderer's centred "contain" fit EXACTLY, by reusing the very
  // function that positions the pane's SVG chrome.
  //
  // Deriving the scale independently is the trap here: that fit carries a 0.92
  // `PANE_CONTAIN_FACTOR`, and a camera built from a plain `min(w/cw, h/ch)` is
  // 8% off. The error is zero at the pane's centre and grows outward, so it
  // reads as "clicking works in the middle of the pane and drifts at the edges"
  // — verified, and the reason this comment exists. `paneViewTransform` is
  // offset/scale; a Camera is centre/zoom; they describe the same relation
  // (screen = (world − compCentre)·scale + paneCentre) so only the scale needs
  // taking from it.
  useEffect(() => {
    if (!ws || width <= 0 || height <= 0) return;
    ws.resize(width, height, 1);
    // Only auto-frame while the user has not framed this pane themselves —
    // otherwise every panel drag or window resize would throw away their
    // framing, which is exactly what having per-pane framing is meant to avoid.
    if (userFramedRef.current) return;
    ws.camera.zoomTo(paneViewTransform(width, height, compWidth, compHeight).scale);
    ws.camera.centerOn({ x: compWidth / 2, y: compHeight / 2 });
    framedRef.current = true;
    // A fit that left the camera where it was emits no change; the engine still needs this framing.
    setFramingRev((n) => n + 1);
  }, [ws, width, height, compWidth, compHeight]);

  // Follow the app's tool selection, but only for tools a pane handles.
  const activeTool = useUIStore((s) => s.activeTool);
  useEffect(() => {
    ws?.setTool(PANE_TOOLS.has(activeTool) ? activeTool : 'select');
  }, [ws, activeTool]);

  // Same bridge the main viewport has: the TopNav magnet button writes
  // uiStore.snap, and without this a pane ignored it and snapped regardless.
  const snapEnabled = useUIStore((s) => s.snap);
  useEffect(() => {
    ws?.setSnap({ enabled: snapEnabled });
  }, [ws, snapEnabled]);

  const getRenderView = useCallback((): RenderView | undefined => {
    const w = wsRef.current;
    // Unframed, the camera is not this pane's view yet: the caller's contain fit is (and equals the fit to come).
    if (!w || (!framedRef.current && !userFramedRef.current)) return undefined;
    const origin = w.camera.worldToScreen({ x: 0, y: 0 });
    return { scale: w.camera.zoom, offsetX: origin.x, offsetY: origin.y };
  }, []);

  const handlers = useMemo(() => {
    const toPointer = (e: React.PointerEvent): PointerInput => {
      const press = pressRef.current;
      const r = press && press.pointerId === e.pointerId ? press.rect : (e.currentTarget as HTMLElement).getBoundingClientRect();
      return {
        position: { x: e.clientX - r.left, y: e.clientY - r.top },
        pointerType: e.pointerType === 'pen' || e.pointerType === 'touch' ? e.pointerType : 'mouse',
        button: buttonName(e.button),
        buttons: { left: (e.buttons & 1) !== 0, right: (e.buttons & 2) !== 0, middle: (e.buttons & 4) !== 0 },
        // Shared helper: it also derives the platform-normalized `mod` flag,
        // which is what marquee-add and click-toggle read.
        modifiers: modifiersFrom(e.nativeEvent),
        pressure: e.pressure || 0.5,
        time: performance.now(),
        pointerId: e.pointerId,
      };
    };
    // Read the engine from the ref, so a handler bound before the creating
    // effect ran still reaches the live instance rather than a captured null.
    return {
      onPointerDown: (e: React.PointerEvent): void => {
        const w = wsRef.current;
        if (!w) return;
        onActivate?.();
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* synthetic or already-released pointer — capture is best-effort */
        }
        // Middle-drag pans, as in the main viewport. Claimed before the engine
        // sees it so it can never start a marquee at the same time.
        if (e.button === 1) {
          panRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
          userFramedRef.current = true;
          return;
        }
        // ONE viewport gesture per drag, opened as the main viewport opens it. The move
        // tool's writes are absolute (drag start + running total) and the running total
        // lives on the gesture's transaction: without one, every move was a one-shot edit
        // from the layer's last MIRRORED position, so each move the engine had not echoed
        // yet was lost — the layer fell behind the pointer — and each was its own undo step.
        // The gesture also raises the drag flag, so no cached frame is shown mid-drag.
        endViewportGesture();
        beginViewportGesture();
        pressRef.current = { pointerId: e.pointerId, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() };
        w.setFocused(true);
        w.feedPointerDown(toPointer(e));
      },
      onPointerMove: (e: React.PointerEvent): void => {
        const pan = panRef.current;
        if (pan && pan.pointerId === e.pointerId) {
          wsRef.current?.pan(pan.x - e.clientX, pan.y - e.clientY);
          pan.x = e.clientX;
          pan.y = e.clientY;
          return;
        }
        wsRef.current?.feedPointerMove(toPointer(e));
      },
      onPointerUp: (e: React.PointerEvent): void => {
        const w = wsRef.current;
        if (!w) return;
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          /* best-effort */
        }
        if (panRef.current?.pointerId === e.pointerId) {
          panRef.current = null;
          return;
        }
        const pointer = toPointer(e);
        // Close the gesture first, as the main viewport does: the drag's writes all
        // happened on the moves; this records them as one undo entry.
        if (pressRef.current) {
          pressRef.current = null;
          endViewportGesture();
        }
        w.feedPointerUp(pointer);
      },
      onPointerCancel: (e: React.PointerEvent): void => {
        panRef.current = null;
        const pointer = toPointer(e);
        if (pressRef.current) {
          pressRef.current = null;
          endViewportGesture();
        }
        wsRef.current?.feedPointerCancel(pointer);
      },
      onWheel: (e: React.WheelEvent): void => {
        const w = wsRef.current;
        if (!w) return;
        onActivate?.();
        userFramedRef.current = true;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        // Zoom about the cursor, so the point under the pointer stays put.
        w.zoom(Math.pow(0.999, e.deltaY), { x: e.clientX - r.left, y: e.clientY - r.top });
      },
    };
  }, [onActivate]);

  return { handlers, workspace: ws, scene, getRenderView, framingRev };
}
