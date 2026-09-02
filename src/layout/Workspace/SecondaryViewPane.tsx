/**
 * SecondaryViewPane — an INTERACTIVE pane showing the composition through a
 * different view. Reused by both the "2 Views" layout (the right half) and each
 * of the three non-main cells of the "4 Views" (2×2) layout.
 *
 * Its own canvas + its own render backend via {@link useViewportRenderer} (one
 * snapshot per pane per frame — the camera is baked into the snapshot at build
 * time, so a second view requires a second buildSnapshot+renderFrame; see the
 * 2-up notes in ViewControls), plus its own `Workspace` via
 * {@link usePaneWorkspace} for selection and direct manipulation.
 *
 * It was view-only for a long time (`pointerEvents: 'none'` over the canvas),
 * which meant a 2-up layout gave you a second picture and nothing else — you
 * could see a layer in the Top pane but had to go back to the main viewport to
 * touch it. After Effects makes every viewport live, so this one is too:
 * selection is shared, edits are the same undoable commands, and clicking a pane
 * marks it the active viewer.
 *
 * Each pane keeps its own framing — wheel zooms about the cursor, middle-drag
 * pans — without disturbing the main viewport or its sibling panes.
 *
 * It carries the full 3D viewport chrome, not just the wireframes: the
 * transform gizmo ({@link Gizmo3dOverlay}) and the camera focus plane
 * ({@link FocusPlaneOverlay}) are mounted here against THIS pane's view. That
 * is the point of an orthographic pane — a Top view is where you push a layer
 * along X/Z without the depth guesswork the Active Camera makes you do, and
 * where you pull focus by dragging the plane along the camera's axis. Both were
 * main-viewport-only until their view became a parameter rather than a global;
 * see the header of `useGizmo3d`.
 *
 * By default it binds to the store's `secondaryViewMode` (2-up back-compat).
 * The 4-up caller passes an explicit `mode` + `onModeChange` (bound to one
 * `quadViewModes` cell) and a `style` positioning it into its grid quadrant.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Gizmo3D } from '@motion/workspace';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevisionFrame } from '@hooks/useSceneRevisionFrame';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useGuidesStore, CAMERA_ORTHO_VIEWS, type Camera3dMode } from '@stores/guidesStore';
import { CUSTOM_VIEW_IDS, CUSTOM_VIEW_LABEL } from '@core/workspace/customViews';
import type { RenderView } from '@core/rendering/RenderBackend';
import { useViewportRenderer } from './useViewportRenderer';
import { usePaneWorkspace } from './usePaneWorkspace';
import { paneViewTransform } from './useSceneRefGeometry';
import { useGizmo3d } from './useGizmo3d';
import { Gizmo3dOverlay } from './Gizmo3dOverlay';
import { FocusPlaneOverlay } from './FocusPlaneOverlay';

export interface SecondaryViewPaneProps {
  /** View mode to render. Omit to bind to the store's `secondaryViewMode`. */
  mode?: Camera3dMode;
  /** Change handler for the pane's selector. Omit to write `secondaryViewMode`. */
  onModeChange?: (mode: Camera3dMode) => void;
  /**
   * Position/box overrides merged over the default right-half (2-up) rect —
   * the 4-up caller passes each pane its grid quadrant.
   */
  style?: CSSProperties;
}

/** Labels for the pane's compact view selector. */
const VIEW_OPTIONS: ReadonlyArray<{ id: Camera3dMode; label: string }> = [
  { id: 'active', label: 'Active Camera' },
  ...CAMERA_ORTHO_VIEWS.map((v) => ({ id: v as Camera3dMode, label: v[0]!.toUpperCase() + v.slice(1) })),
  ...CUSTOM_VIEW_IDS.map((v) => ({ id: v as Camera3dMode, label: CUSTOM_VIEW_LABEL[v] })),
];

export function SecondaryViewPane({ mode: modeProp, onModeChange, style }: SecondaryViewPaneProps = {}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const time = useActiveWorkspace()?.time ?? 0;
  const sceneRev = useSceneRevisionFrame();
  const storeMode = useGuidesStore((s) => s.secondaryViewMode);
  const storeSetMode = useGuidesStore((s) => s.setSecondaryViewMode);
  // Explicit props win (4-up cells bound to a quadViewModes slot); otherwise
  // fall back to the shared secondaryViewMode (2-up).
  const mode = modeProp ?? storeMode;
  const setMode = onModeChange ?? storeSetMode;

  // The comp box. Read straight from the store rather than through the
  // reference-geometry resolver, because the pane's engine needs it BEFORE the
  // gizmo hook (which is what resolves this pane's geometry now) can run.
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  // Measured box, which sizes the pane's camera and positions its SVG chrome.
  const [paneBox, setPaneBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = (): void => {
      const r = el.getBoundingClientRect();
      setPaneBox((prev) => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const viewTransform = paneViewTransform(paneBox.width, paneBox.height, compWidth, compHeight);

  // Interaction: this pane's own engine, hit-testing through THIS pane's view.
  const setActive = useGuidesStore((s) => s.setActiveViewPane);
  const activePane = useGuidesStore((s) => s.activeViewPane);
  const onActivate = useCallback(() => setActive(mode), [setActive, mode]);
  const { handlers, scene: paneScene, getRenderView, framingRev } = usePaneWorkspace({
    mode,
    width: paneBox.width,
    height: paneBox.height,
    compWidth,
    compHeight,
    onActivate,
  });
  /**
   * ONE view for every piece of this pane's chrome.
   *
   * The pane's LIVE camera, falling back to the contain fit before the engine
   * exists — deriving it separately is what let the 0.92 contain factor drift
   * the transform and the pixels apart once already. It is a stable callback
   * because the gizmo and focus-plane overlays hold it across renders and read
   * it from pointer handlers; the fallback rides in on a ref so the identity
   * does not change when the pane is resized.
   */
  const fallbackViewRef = useRef(viewTransform);
  fallbackViewRef.current = viewTransform;
  const getPaneView = useCallback(
    (): RenderView => getRenderView() ?? fallbackViewRef.current,
    [getRenderView],
  );
  const chromeTransform = getPaneView();

  /**
   * This pane's 3D chrome, resolved through ITS mode and ITS transform.
   *
   * The hook also resolves the pane's reference geometry (camera, ortho axis,
   * ground plane, scene wireframes) — the same `useSceneRefGeometry` the pane
   * used to call for itself, so this is one resolution per pane, not two.
   * Selection, the axis mode and the write path stay global: dragging a handle
   * here is the same undoable command it is in the main viewport.
   */
  const gizmo3d = useGizmo3d(containerRef, { mode, getView: getPaneView, viewRev: framingRev });

  // Render LAST, so it sees this pass's framing. `framingRev` rides in on the
  // revision because panning is not a scene change and nothing else would
  // repaint the canvas.
  useViewportRenderer(canvasRef, containerRef, sceneRev + framingRev, time, undefined, undefined, mode, getRenderView);
  const selectedIds = useSelectionStore((s) => s.ids);
  // Selection outline from the PANE's own projection — the main viewport's
  // corners describe a different view and would draw the box in the wrong place.
  const selectionOutlines = useMemo(() => {
    if (paneBox.width <= 0 || selectedIds.length === 0) return [];
    const out: string[] = [];
    for (const id of selectedIds) {
      const n = paneScene.getNode(id as never);
      const corners = n?.worldCorners;
      if (!corners) continue;
      out.push(
        corners
          .map((p) => {
            const s = Gizmo3D.compToViewport({ x: p.x, y: p.y }, chromeTransform);
            return `${s.x},${s.y}`;
          })
          .join(' '),
      );
    }
    return out;
    // sceneRev/time keep this in step with edits made anywhere.
  }, [paneScene, selectedIds, chromeTransform, paneBox.width, sceneRev, time, mode]);

  return (
    <div
      ref={containerRef}
      data-secondary-view-pane=""
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: '50%',
        right: 0,
        overflow: 'hidden',
        borderLeft: '1px solid var(--color-border, rgba(255,255,255,0.12))',
        background: 'var(--color-pasteboard, var(--color-workspace, #1e1e1e))',
        // The active viewer is called out, as in AE — without it there is no way
        // to tell which pane a keyboard action will land in.
        outline: activePane === mode ? '1px solid var(--color-accent, #4c8dff)' : 'none',
        outlineOffset: -1,
        ...style,
      }}
    >
      {/* The canvas is pure output; interaction rides on the overlay above it,
          which spans the same box and carries the pane's pointer handlers. */}
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />
      {/* Interaction surface: it draws this view's selection outline and carries
          the pane's pointer handlers. The 3D chrome that follows paints above it
          but is pointer-transparent, so it never steals a press. */}
      <svg
        data-pane-interaction=""
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, zIndex: 1, cursor: 'default', touchAction: 'none' }}
        {...handlers}
      >
        {selectionOutlines.map((pts, i) => (
          <polygon
            key={i}
            points={pts}
            fill="none"
            stroke="var(--color-accent, #4c8dff)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {/* Scene reference geometry AND the transform gizmo, in one overlay (the
          gizmo component draws the wireframes beneath its handles). Without the
          wireframes a Top/Front/Right pane shows bare layers — a flat 3D layer
          seen edge-on draws no pixels at all, so the pane can look empty when
          the scene is not. Pointer-transparent: the press is claimed by the
          gizmo hook's capture-phase listener on this container, not by the SVG. */}
      {(gizmo3d.scene3d || (gizmo3d.is3D && gizmo3d.singleId)) && paneBox.width > 0 && (
        <Gizmo3dOverlay
          {...gizmo3d}
          nodeId={gizmo3d.singleId ?? null}
          showGizmo={gizmo3d.is3D && !!gizmo3d.singleId}
          // The LIVE pane transform, so the handles, the wireframes and the
          // selection outline above are all positioned from the same numbers in
          // the same render. (The hook's own copy is a rAF-coalesced mirror.)
          viewTransform={chromeTransform}
        />
      )}
      {/* The camera focus plane, bound to this pane's view. In a 4-up it draws
          in the ortho panes and suppresses itself in the Active Camera one —
          exactly where pulling focus by hand does and does not make sense. */}
      {paneBox.width > 0 && (
        <FocusPlaneOverlay mode={mode} getView={getPaneView} viewRev={framingRev} />
      )}
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as Camera3dMode)}
        title="Secondary pane view"
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={`${VIEW_OPTIONS.find((o) => o.id === mode)?.label ?? mode} view`}
        style={{
          position: 'absolute',
          top: 6,
          right: 8,
          // Above the 3D chrome (gizmo z 20, focus plane z 21) — the wireframes
          // reach the pane corners and would otherwise be drawn across it.
          zIndex: 30,
          fontSize: 'var(--font-size-xs)',
          padding: '2px 4px',
          background: 'var(--color-panel, rgba(20,22,28,0.85))',
          color: 'var(--color-text, #ddd)',
          border: '1px solid var(--color-border, rgba(255,255,255,0.15))',
          borderRadius: 4,
        }}
      >
        {VIEW_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {/* Always-visible quadrant label so 4-up reads without opening the select. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 6,
          left: 8,
          zIndex: 30,
          fontSize: 'var(--font-size-micro)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--color-text-muted, rgba(255,255,255,0.55))',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {VIEW_OPTIONS.find((o) => o.id === mode)?.label ?? mode}
      </div>
    </div>
  );
}
