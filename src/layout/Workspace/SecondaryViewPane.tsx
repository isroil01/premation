/**
 * SecondaryViewPane — a VIEW-ONLY inspection pane, reused by both the "2 Views"
 * layout (the right half) and each of the three non-interactive cells of the
 * "4 Views" (2×2) layout.
 *
 * A view-only render of the same composition through a different view
 * (Active Camera / any ortho view / any custom view): its own canvas + its own
 * render backend via {@link useViewportRenderer} (one snapshot per pane per
 * frame — the camera is baked into the snapshot at build time, so a second
 * view requires a second buildSnapshot+renderFrame; see the 2-up notes in
 * ViewControls). No selection, no gizmos, no camera nav: pointer events are
 * disabled over the canvas — the only interactive chrome is the small view
 * selector in its top-right corner.
 *
 * By default it binds to the store's `secondaryViewMode` (2-up back-compat).
 * The 4-up caller passes an explicit `mode` + `onModeChange` (bound to one
 * `quadViewModes` cell) and a `style` positioning it into its grid quadrant.
 */

import { useRef, type CSSProperties } from 'react';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useGuidesStore, CAMERA_ORTHO_VIEWS, type Camera3dMode } from '@stores/guidesStore';
import { CUSTOM_VIEW_IDS, CUSTOM_VIEW_LABEL } from '@core/workspace/customViews';
import { useViewportRenderer } from './useViewportRenderer';

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

  useViewportRenderer(canvasRef, containerRef, sceneRev, time, undefined, undefined, mode);

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
        ...style,
      }}
    >
      {/* View-only: the pane never takes canvas interaction. */}
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
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as Camera3dMode)}
        title="Secondary pane view"
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
    </div>
  );
}
