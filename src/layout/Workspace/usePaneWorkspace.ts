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
import type { RenderView } from '@core/rendering/RenderBackend';
import { createSceneGraphPort, createSelectionPort, createCommandPort } from '@core/workspace/ports';
import { paneViewTransform } from './useSceneRefGeometry';
import { useUIStore } from '@stores/uiStore';

/** Engine tool ids the panes support. Creation/drawing tools stay in the main
 *  viewport, where the full gesture stack (guides, ROI, motion paths) lives. */
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
}: PaneWorkspaceOptions): PaneWorkspaceApi {
  // The port reads the mode through a ref, so changing the pane's view from its
  // selector re-projects on the next query instead of rebuilding the engine.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // The port is stateless and disposable-free, so it can be memoised.
  const scene = useMemo(() => createSceneGraphPort(() => modeRef.current), []);

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
  /** In-flight middle-button pan. */
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
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
    setWs(w);
    return () => {
      w.dispose();
      if (wsRef.current === w) wsRef.current = null;
    };
  }, [scene]);

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

  // Repaint when this pane's camera moves. The renderer redraws on scene/time
  // changes; panning is neither, so without this the pane would keep showing the
  // previous framing until something else happened to touch the scene.
  const [framingRev, setFramingRev] = useState(0);
  useEffect(() => {
    if (!ws) return;
    const sub = ws.events.on('CameraChanged', () => setFramingRev((n) => n + 1));
    return () => sub.dispose();
  }, [ws]);

  const getRenderView = useCallback((): RenderView | undefined => {
    const w = wsRef.current;
    if (!w) return undefined;
    const origin = w.camera.worldToScreen({ x: 0, y: 0 });
    return { scale: w.camera.zoom, offsetX: origin.x, offsetY: origin.y };
  }, []);

  const handlers = useMemo(() => {
    const toPointer = (e: React.PointerEvent): PointerInput => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
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
        w.feedPointerUp(toPointer(e));
      },
      onPointerCancel: (e: React.PointerEvent): void => {
        panRef.current = null;
        wsRef.current?.feedPointerCancel(toPointer(e));
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
