/**
 * Canvas guides (spec §Canvas — "Guides, rulers, smart snapping, Safe areas").
 * Toggle rulers, a grid, and broadcast/action safe-area overlays. The renderer
 * reads these and draws them over the composition.
 */

import { create } from 'zustand';
import {
  defaultCustomViews,
  isCustomViewId,
  type CustomViewId,
  type CustomViewParams,
} from '@core/workspace/customViews';

/** Which channel the viewport shows. Non-'rgb' values isolate that channel as
 *  greyscale (alpha = matte/coverage; red/green/blue = that colour component). */
export type ViewChannel = 'rgb' | 'alpha' | 'red' | 'green' | 'blue';

/**
 * Which camera the viewport renders through.
 *   'active'                          — the scene's Camera layer (perspective).
 *   front/back/left/right/top/bottom  — orthographic axis views (no perspective).
 *   custom1/custom2/custom3           — navigable perspective views built from
 *                                       STORED params (see `customViews`); the
 *                                       scene's Camera layer is ignored, so you
 *                                       inspect the scene from anywhere without
 *                                       moving the shot camera (AE parity).
 * Front is the ordinary straight-on view; the side/top views show true depth.
 */
export type Camera3dMode =
  | 'active'
  | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'
  | CustomViewId;

/** How many viewport panes the workspace shows (AE's 1 View / 2 Views / 4 Views). */
export type ViewLayout = '1' | '2' | '4';

/**
 * The four view modes of the 2×2 "4 Views" layout, in cell order:
 *   [0] top-left     — the interactive stage (AE's active viewport)
 *   [1] top-right    — view-only inspection pane
 *   [2] bottom-left  — view-only inspection pane
 *   [3] bottom-right — view-only inspection pane
 * Index 0 is what the interactive stage renders through; only cells 1–3 are
 * driven by SecondaryViewPanes. Session view state (not project data), matching
 * `camera3dMode` / `secondaryViewMode`.
 */
export type QuadViewModes = [Camera3dMode, Camera3dMode, Camera3dMode, Camera3dMode];

/** The orthographic views, in AE's menu order — for building the picker. */
export const CAMERA_ORTHO_VIEWS = ['front', 'left', 'top', 'back', 'right', 'bottom'] as const;

/**
 * Region of Interest: a comp-space rectangle the preview restricts itself to.
 * The renderer clips content to it (so effects outside cost nothing) and dims
 * the surround, exactly like AE's ROI — a speed lever for heavy comps.
 */
export interface RegionOfInterest {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The persisted half. Channel and 3D view mode are deliberately excluded —
 * like After Effects, those are session view state, not project data.
 */
export interface GuidesSettings {
  rulers: boolean;
  grid: boolean;
  /** Grid cells per axis (2..64). 3 = classic rule-of-thirds. */
  gridDivisions: number;
  /** Grid line colour — 8-digit hex (#rrggbbaa) so the alpha controls how
   *  faint the lines are. Default: white at ~8%. */
  gridColor: string;
  safeArea: boolean;
  /** Whether the motion path overlay is drawn on the canvas (AE toggle). */
  motionPathVisible: boolean;
  /** Motion-path frame-dot size: subtle / normal / bold ('off' hides dots but
   *  keeps the curve). Pro users tune this to taste. */
  motionPathDots: 'off' | 'small' | 'medium' | 'large';
}

export type Gizmo3dState = 'universal' | 'position' | 'scale' | 'rotation';
export type Gizmo3dAxisMode = 'local' | 'world' | 'view';

/**
 * The active left-drag camera tool (C key cycles orbit → pan → dolly; Esc or
 * any tool pick returns to 'none' = normal selection). Session view state.
 */
export type CameraTool = 'none' | 'orbit' | 'pan' | 'dolly';

interface GuidesStore extends GuidesSettings {
  camera3dMode: Camera3dMode;
  /**
   * Stored per-view orbit params for the three custom views. Session view
   * state (like `camera3dMode` itself) — deliberately NOT in GuidesSettings,
   * matching AE where viewer navigation isn't project data.
   */
  customViews: Record<CustomViewId, CustomViewParams>;
  /** The custom view most recently activated — the `2` shortcut's target. */
  lastCustomView: CustomViewId;
  /** 1 View (default), 2 Views (right pane), or 4 Views (2×2 grid). */
  viewLayout: ViewLayout;
  /** Which view the secondary (right) pane renders when viewLayout === '2'. */
  secondaryViewMode: Camera3dMode;
  /**
   * Per-cell view modes for the 4-up (2×2) layout. Index 0 is the interactive
   * top-left cell; 1–3 are the view-only panes. Session view state.
   */
  quadViewModes: QuadViewModes;
  channel: ViewChannel;
  /** Active Region of Interest, or null when the whole comp renders. */
  roi: RegionOfInterest | null;
  /** 3D Design Space Gizmo Mode (Universal, Position, Scale, Rotation). */
  gizmo3dState: Gizmo3dState;
  /** 3D Design Space Axis Mode (Local, World, View). */
  gizmo3dAxisMode: Gizmo3dAxisMode;
  /** 3D Snapping toggle. */
  gizmo3dSnapping: boolean;
  /** Ground Grid (3D Floor) toggle. */
  groundGridVisible: boolean;
  /**
   * Draft 3D (AE's lightning bolt): fast preview that skips depth-of-field
   * blur and all lighting (shading, light washes, cast shadows). View state —
   * final renders/export never see it.
   */
  draft3d: boolean;
  /** Active left-drag camera tool (C-key cycling), 'none' = selection. */
  cameraTool: CameraTool;

  settings: () => GuidesSettings;
  restore: (s: Partial<GuidesSettings>) => void;
  toggleRulers: () => void;
  toggleGrid: () => void;
  setGridDivisions: (n: number) => void;
  setGridColor: (hex: string) => void;
  toggleSafeArea: () => void;
  /** Legacy binary toggle: active ↔ front. Prefer `setCamera3dMode`. */
  toggleCamera3dMode: () => void;
  setCamera3dMode: (mode: Camera3dMode) => void;
  /** Merge a partial patch into one custom view's stored params. */
  updateCustomView: (id: CustomViewId, patch: Partial<CustomViewParams>) => void;
  setViewLayout: (layout: ViewLayout) => void;
  setSecondaryViewMode: (mode: Camera3dMode) => void;
  /** Set one cell's view mode in the 4-up layout (index 0–3). */
  setQuadViewMode: (index: number, mode: Camera3dMode) => void;
  setGizmo3dState: (state: Gizmo3dState) => void;
  setGizmo3dAxisMode: (mode: Gizmo3dAxisMode) => void;
  toggleGizmo3dSnapping: () => void;
  toggleGroundGridVisible: () => void;
  toggleDraft3d: () => void;
  setCameraTool: (tool: CameraTool) => void;
  /** C key: none → orbit → pan → dolly → orbit … */
  cycleCameraTool: () => void;
  /** Set (or clear, with null) the region of interest, in comp px. */
  setRoi: (roi: RegionOfInterest | null) => void;
  toggleChannel: () => void;
  /** Set the isolated channel directly (rgb/alpha/red/green/blue). */
  setChannel: (channel: ViewChannel) => void;
  toggleMotionPath: () => void;
  setMotionPathDots: (size: GuidesSettings['motionPathDots']) => void;
  /** Stable string that changes whenever any guide toggles (render key). */
  key: () => string;
}

export const useGuidesStore = create<GuidesStore>((set, get) => ({
  rulers: false,
  grid: false,
  gridDivisions: 3,
  gridColor: '#ffffff14',
  safeArea: false,
  camera3dMode: 'active',
  customViews: defaultCustomViews(),
  lastCustomView: 'custom1',
  viewLayout: '1',
  secondaryViewMode: 'top',
  // AE-like 4-up defaults: top-left = interactive Active Camera; the other
  // three inspect the scene from Front / Top / a three-quarter custom view.
  quadViewModes: ['active', 'front', 'top', 'custom1'],
  channel: 'rgb',
  roi: null,
  motionPathVisible: true,
  motionPathDots: 'small',
  gizmo3dState: 'universal',
  gizmo3dAxisMode: 'local',
  gizmo3dSnapping: false,
  groundGridVisible: true,
  draft3d: false,
  cameraTool: 'none',

  toggleRulers: () => set((s) => ({ rulers: !s.rulers })),
  toggleGrid: () => set((s) => ({ grid: !s.grid })),
  setGridDivisions: (n) => set({ gridDivisions: Math.max(2, Math.min(64, Math.round(n))) }),
  setGridColor: (hex) => set({ gridColor: hex }),
  toggleSafeArea: () => set((s) => ({ safeArea: !s.safeArea })),
  toggleCamera3dMode: () => set((s) => ({ camera3dMode: s.camera3dMode === 'active' ? 'front' : 'active' })),
  setCamera3dMode: (mode) =>
    set(isCustomViewId(mode) ? { camera3dMode: mode, lastCustomView: mode } : { camera3dMode: mode }),
  updateCustomView: (id, patch) =>
    set((s) => ({ customViews: { ...s.customViews, [id]: { ...s.customViews[id], ...patch } } })),
  setViewLayout: (layout) => set({ viewLayout: layout }),
  setSecondaryViewMode: (mode) => set({ secondaryViewMode: mode }),
  setQuadViewMode: (index, mode) =>
    set((s) => {
      if (index < 0 || index > 3) return s;
      const next = [...s.quadViewModes] as QuadViewModes;
      next[index] = mode;
      return { quadViewModes: next };
    }),
  setGizmo3dState: (state) => set({ gizmo3dState: state }),
  setGizmo3dAxisMode: (mode) => set({ gizmo3dAxisMode: mode }),
  toggleGizmo3dSnapping: () => set((s) => ({ gizmo3dSnapping: !s.gizmo3dSnapping })),
  toggleGroundGridVisible: () => set((s) => ({ groundGridVisible: !s.groundGridVisible })),
  toggleDraft3d: () => set((s) => ({ draft3d: !s.draft3d })),
  setCameraTool: (tool) => set({ cameraTool: tool }),
  cycleCameraTool: () =>
    set((s) => ({
      cameraTool:
        s.cameraTool === 'none' ? 'orbit'
        : s.cameraTool === 'orbit' ? 'pan'
        : s.cameraTool === 'pan' ? 'dolly'
        : 'orbit',
    })),
  setRoi: (roi) => set({ roi }),
  toggleChannel: () => set((s) => ({ channel: s.channel === 'rgb' ? 'alpha' : 'rgb' })),
  setChannel: (channel) => set({ channel }),
  toggleMotionPath: () => set((s) => ({ motionPathVisible: !s.motionPathVisible })),
  setMotionPathDots: (size) => set({ motionPathDots: size }),
  settings: () => {
    const { rulers, grid, gridDivisions, gridColor, safeArea, motionPathVisible, motionPathDots } = get();
    return { rulers, grid, gridDivisions, gridColor, safeArea, motionPathVisible, motionPathDots };
  },
  restore: (s) => {
    set({
      ...(typeof s.rulers === 'boolean' ? { rulers: s.rulers } : {}),
      ...(typeof s.grid === 'boolean' ? { grid: s.grid } : {}),
      ...(typeof s.safeArea === 'boolean' ? { safeArea: s.safeArea } : {}),
      ...(typeof s.motionPathVisible === 'boolean' ? { motionPathVisible: s.motionPathVisible } : {}),
      ...(s.motionPathDots === 'off' || s.motionPathDots === 'small' || s.motionPathDots === 'medium' || s.motionPathDots === 'large'
        ? { motionPathDots: s.motionPathDots }
        : {}),
    });
    if (typeof s.gridDivisions === 'number') get().setGridDivisions(s.gridDivisions);
    if (typeof s.gridColor === 'string') get().setGridColor(s.gridColor);
  },
  key: () => {
    const s = get();
    const roi = s.roi ? `${s.roi.x},${s.roi.y},${s.roi.width},${s.roi.height}` : '-';
    // The ACTIVE custom view's params join the key so orbiting a custom view
    // invalidates cached frames like any other view change would.
    const cv = isCustomViewId(s.camera3dMode)
      ? (() => {
          const v = s.customViews[s.camera3dMode];
          return `${v.yaw},${v.pitch},${v.distance ?? '-'},${v.poi ? `${v.poi.x},${v.poi.y},${v.poi.z}` : '-'}`;
        })()
      : '-';
    return `${s.rulers ? 1 : 0}${s.grid ? 1 : 0}:${s.gridDivisions}:${s.gridColor}:${s.safeArea ? 1 : 0}:${s.camera3dMode}:${cv}:${s.viewLayout}:${s.secondaryViewMode}:${s.quadViewModes.join(',')}:${s.channel}:${s.motionPathVisible ? 1 : 0}:${s.motionPathDots}:${s.gizmo3dState}:${s.gizmo3dAxisMode}:${s.gizmo3dSnapping ? 1 : 0}:${s.groundGridVisible ? 1 : 0}:${s.draft3d ? 1 : 0}:${roi}`;
  },
}));

