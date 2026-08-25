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
 * By default it binds to the store's `secondaryViewMode` (2-up back-compat).
 * The 4-up caller passes an explicit `mode` + `onModeChange` (bound to one
 * `quadViewModes` cell) and a `style` positioning it into its grid quadrant.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Gizmo3D } from '@motion/workspace';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore, CAMERA_ORTHO_VIEWS, type Camera3dMode } from '@stores/guidesStore';
import { CUSTOM_VIEW_IDS, CUSTOM_VIEW_LABEL } from '@core/workspace/customViews';
import { useViewportRenderer } from './useViewportRenderer';
import { usePaneWorkspace } from './usePaneWorkspace';
import { paneViewTransform, useSceneRefGeometry } from './useSceneRefGeometry';
import { SceneGeometryOverlaySvg } from './SceneGeometryOverlay';

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
  const sceneRev = useSceneRevision((s) => s.rev);
  const storeMode = useGuidesStore((s) => s.secondaryViewMode);
  const storeSetMode = useGuidesStore((s) => s.setSecondaryViewMode);
  // Explicit props win (4-up cells bound to a quadViewModes slot); otherwise
  // fall back to the shared secondaryViewMode (2-up).
  const mode = modeProp ?? storeMode;
  const setMode = onModeChange ?? storeSetMode;

  // Reference geometry for THIS pane's view. Same resolver the interactive
  // viewport uses, so a camera's frustum lands in the same place in both.
  const ref = useSceneRefGeometry(mode);
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
  const viewTransform = paneViewTransform(paneBox.width, paneBox.height, ref.compWidth, ref.compHeight);

  // Interaction: this pane's own engine, hit-testing through THIS pane's view.
  const setActive = useGuidesStore((s) => s.setActiveViewPane);
  const activePane = useGuidesStore((s) => s.activeViewPane);
  const onActivate = useCallback(() => setActive(mode), [setActive, mode]);
  const { handlers, scene: paneScene, getRenderView, framingRev } = usePaneWorkspace({
    mode,
    width: paneBox.width,
    height: paneBox.height,
    compWidth: ref.compWidth,
    compHeight: ref.compHeight,
    onActivate,
  });
  // Chrome positions against the pane's LIVE camera, falling back to the contain
  // fit before the engine exists. Deriving it separately is what let the 0.92
  // contain factor drift the two apart once already.
  const liveView = getRenderView();
  const chromeTransform = liveView
    ? { scale: liveView.scale, offsetX: liveView.offsetX, offsetY: liveView.offsetY }
    : viewTransform;

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
      {/* Scene reference geometry. Without it a Top/Front/Right pane shows bare
          layers — and a flat 3D layer seen edge-on draws no pixels at all, so
          the pane can look empty when the scene is not. */}
      {ref.scene3d && paneBox.width > 0 && (
        <SceneGeometryOverlaySvg
          camera={ref.camera}
          orthoView={ref.orthoView}
          compWidth={ref.compWidth}
          compHeight={ref.compHeight}
          viewTransform={chromeTransform}
          groundGridVisible={ref.groundGridVisible}
          sceneGizmos={ref.sceneGizmos}
        />
      )}
      {/* Interaction surface. Above the reference geometry so it always receives
          the pointer, and it draws the selection outline for this view. */}
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
          zIndex: 2,
          fontSize: 11,
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
          zIndex: 2,
          fontSize: 10,
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
