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
/** AE's Grid Style options (Preferences → Grids & Guides). */
export type GridStyle = 'lines' | 'dashed' | 'dots';

export interface GuidesSettings {
  rulers: boolean;
  /**
   * Show Grid (AE: `Ctrl/Cmd + '`) — the ABSOLUTE grid.
   *
   * After Effects has two grids and they behave differently. This is the
   * standard one: its cells are a fixed number of pixels, so they do NOT change
   * size when the composition does, and it is the only one anything snaps to.
   */
  grid: boolean;
  /** AE "Gridline every": cell size in composition pixels. */
  gridSpacing: number;
  /** AE "Subdivisions": minor lines drawn between each pair of gridlines. */
  gridSubdivisions: number;
  /**
   * Snap to Grid (AE: `Ctrl/Cmd + Shift + '`).
   *
   * DELIBERATELY independent of `grid`. After Effects snaps to the grid whether
   * or not it is being drawn — hiding the grid does not stop snapping, which is
   * a long-standing complaint but is the behaviour being matched here. An
   * earlier revision of this store gated snapping on visibility; that was the
   * feature AE users keep asking Adobe for, not what AE does.
   */
  snapToGrid: boolean;
  /** Grid line colour — 8-digit hex (#rrggbbaa) so the alpha controls how
   *  faint the lines are. Default: white at ~8%. */
  gridColor: string;
  /** AE "Grid Style": solid lines, dashed lines, or dots at the intersections. */
  gridStyle: GridStyle;
  /**
   * Show Proportional Grid (AE: `Alt/Opt + '`) — the OTHER grid.
   *
   * Divides the composition into a fixed number of cells, so it rescales with
   * the comp. Purely a compositional reference: in AE nothing snaps to it, and
   * nothing snaps to it here either.
   */
  proportionalGrid: boolean;
  /** Proportional cells across / down. AE ships 8 × 6 for widescreen; 3 × 3 is
   *  the rule-of-thirds setup designers usually switch to. */
  proportionalColumns: number;
  proportionalRows: number;
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
   * Per-cell view modes for the 4-up (2×2) layout. Index 0 is the main viewport;
   * 1–3 are secondary panes. All four are interactive. Session view state.
   */
  quadViewModes: QuadViewModes;
  /**
   * Which viewport the user last clicked into — AE's "active viewer".
   *
   * `null` means the main viewport. Secondary panes store their own view id.
   * Purely a UI affordance today (it draws the focus ring); it exists as state
   * rather than local to a pane because only one viewport can be active at a
   * time and the main viewport has to be able to take it back.
   */
  activeViewPane: Camera3dMode | null;
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
  setGridSpacing: (px: number) => void;
  setGridSubdivisions: (n: number) => void;
  toggleSnapToGrid: () => void;
  setGridColor: (hex: string) => void;
  setGridStyle: (style: GridStyle) => void;
  toggleProportionalGrid: () => void;
  setProportionalColumns: (n: number) => void;
  setProportionalRows: (n: number) => void;
  toggleSafeArea: () => void;
  /** Legacy binary toggle: active ↔ front. Prefer `setCamera3dMode`. */
  toggleCamera3dMode: () => void;
  setCamera3dMode: (mode: Camera3dMode) => void;
  /** Merge a partial patch into one custom view's stored params. */
  updateCustomView: (id: CustomViewId, patch: Partial<CustomViewParams>) => void;
  /**
   * Per-view viewport pan/zoom. Every 3D view keeps its OWN framing, the way
   * After Effects does — they used to share one viewport transform, so panning
   * in Top view also panned Active Camera view and you could not frame a side
   * view without disturbing the shot. Session state, not persisted.
   */
  viewFraming: Partial<Record<Camera3dMode, { center: { x: number; y: number }; zoom: number }>>;
  saveViewFraming: (mode: Camera3dMode, framing: { center: { x: number; y: number }; zoom: number }) => void;
  setViewLayout: (layout: ViewLayout) => void;
  setSecondaryViewMode: (mode: Camera3dMode) => void;
  /** Set one cell's view mode in the 4-up layout (index 0–3). */
  setQuadViewMode: (index: number, mode: Camera3dMode) => void;
  /** Mark the viewport the user just clicked into. `null` = the main viewport. */
  setActiveViewPane: (pane: Camera3dMode | null) => void;
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
  // 100px cells with quarter subdivisions. 100 is what the renderer has always
  // drawn, so turning the grid on looks the same as before this became
  // configurable; the subdivisions are new and default to AE's 4.
  gridSpacing: 100,
  gridSubdivisions: 4,
  // Off by default. It is independent of `grid`, so leaving it on would snap
  // silently for anyone who never opens the grid settings.
  snapToGrid: false,
  gridColor: '#ffffff14',
  gridStyle: 'lines',
  proportionalGrid: false,
  proportionalColumns: 8,
  proportionalRows: 6,
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
  setGridSpacing: (px) => set({ gridSpacing: Math.max(1, Math.min(10000, Math.round(px))) }),
  setGridSubdivisions: (n) => set({ gridSubdivisions: Math.max(1, Math.min(64, Math.round(n))) }),
  toggleSnapToGrid: () => set((s) => ({ snapToGrid: !s.snapToGrid })),
  setGridColor: (hex) => set({ gridColor: hex }),
  setGridStyle: (style) => set({ gridStyle: style }),
  toggleProportionalGrid: () => set((s) => ({ proportionalGrid: !s.proportionalGrid })),
  setProportionalColumns: (n) => set({ proportionalColumns: Math.max(1, Math.min(64, Math.round(n))) }),
  setProportionalRows: (n) => set({ proportionalRows: Math.max(1, Math.min(64, Math.round(n))) }),
  toggleSafeArea: () => set((s) => ({ safeArea: !s.safeArea })),
  toggleCamera3dMode: () => set((s) => ({ camera3dMode: s.camera3dMode === 'active' ? 'front' : 'active' })),
  setCamera3dMode: (mode) =>
    set(isCustomViewId(mode) ? { camera3dMode: mode, lastCustomView: mode } : { camera3dMode: mode }),
  viewFraming: {},
  saveViewFraming: (mode, framing) =>
    set((s) => ({ viewFraming: { ...s.viewFraming, [mode]: framing } })),
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
  activeViewPane: null,
  setActiveViewPane: (pane) => set({ activeViewPane: pane }),
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
    const {
      rulers, grid, gridSpacing, gridSubdivisions, snapToGrid, gridColor, gridStyle,
      proportionalGrid, proportionalColumns, proportionalRows, safeArea, motionPathVisible, motionPathDots,
    } = get();
    return {
      rulers, grid, gridSpacing, gridSubdivisions, snapToGrid, gridColor, gridStyle,
      proportionalGrid, proportionalColumns, proportionalRows, safeArea, motionPathVisible, motionPathDots,
    };
  },
  restore: (s) => {
    set({
      ...(typeof s.rulers === 'boolean' ? { rulers: s.rulers } : {}),
      ...(typeof s.grid === 'boolean' ? { grid: s.grid } : {}),
      ...(typeof s.snapToGrid === 'boolean' ? { snapToGrid: s.snapToGrid } : {}),
      ...(typeof s.proportionalGrid === 'boolean' ? { proportionalGrid: s.proportionalGrid } : {}),
      ...(s.gridStyle === 'lines' || s.gridStyle === 'dashed' || s.gridStyle === 'dots' ? { gridStyle: s.gridStyle } : {}),
      ...(typeof s.safeArea === 'boolean' ? { safeArea: s.safeArea } : {}),
      ...(typeof s.motionPathVisible === 'boolean' ? { motionPathVisible: s.motionPathVisible } : {}),
      ...(s.motionPathDots === 'off' || s.motionPathDots === 'small' || s.motionPathDots === 'medium' || s.motionPathDots === 'large'
        ? { motionPathDots: s.motionPathDots }
        : {}),
    });
    if (typeof s.gridSpacing === 'number') get().setGridSpacing(s.gridSpacing);
    if (typeof s.gridSubdivisions === 'number') get().setGridSubdivisions(s.gridSubdivisions);
    if (typeof s.proportionalColumns === 'number') get().setProportionalColumns(s.proportionalColumns);
    if (typeof s.proportionalRows === 'number') get().setProportionalRows(s.proportionalRows);
    if (typeof s.gridColor === 'string') get().setGridColor(s.gridColor);
    // Legacy projects stored one `gridDivisions` (cells per axis) with no
    // absolute/proportional split. That value only ever described a
    // comp-relative division, so it restores onto the PROPORTIONAL grid — the
    // absolute grid it never described keeps its default spacing.
    const legacy = (s as { gridDivisions?: unknown }).gridDivisions;
    if (typeof legacy === 'number' && typeof s.proportionalColumns !== 'number') {
      get().setProportionalColumns(legacy);
      get().setProportionalRows(legacy);
    }
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
    return `${s.rulers ? 1 : 0}${s.grid ? 1 : 0}:${s.gridSpacing}/${s.gridSubdivisions}/${s.gridStyle}:${s.proportionalGrid ? 1 : 0}${s.proportionalColumns}x${s.proportionalRows}:${s.gridColor}:${s.safeArea ? 1 : 0}:${s.camera3dMode}:${cv}:${s.viewLayout}:${s.secondaryViewMode}:${s.quadViewModes.join(',')}:${s.channel}:${s.motionPathVisible ? 1 : 0}:${s.motionPathDots}:${s.gizmo3dState}:${s.gizmo3dAxisMode}:${s.gizmo3dSnapping ? 1 : 0}:${s.groundGridVisible ? 1 : 0}:${s.draft3d ? 1 : 0}:${roi}`;
  },
}));

