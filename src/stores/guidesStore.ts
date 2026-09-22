/**
 * Canvas guides.
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
import { isCameraViewMode, type CameraViewMode } from '@core/scene/cameraViewMode';
import { sanitizeStoredGuides, type StoredGuide } from '@core/workspace/guideGeometry';

/** Which channel the viewport shows. Non-'rgb' values isolate that channel as
 *  greyscale (alpha = matte/coverage; red/green/blue = that colour component). */
export type ViewChannel = 'rgb' | 'alpha' | 'red' | 'green' | 'blue';

/**
 * Which camera the viewport renders through.
 *   'active' — the scene's Camera layer (perspective).
 *   front/back/left/right/top/bottom — orthographic axis views (no perspective).
 *   custom1/custom2/custom3 — navigable perspective views built from
 *                                       STORED params (see `customViews`); the
 *                                       scene's Camera layer is ignored, so you
 *                                       inspect the scene from anywhere without
 *                                       moving the shot camera (AE parity).
 *   camera:<nodeId> — perspective through ONE named Camera layer instead of
 *                     the topmost (AE lists every camera by name under Active
 *                     Camera). Renders like 'active' in every other respect,
 *                     and falls back to 'active' when that camera is gone,
 *                     disabled or in another comp — see `viewCameraNode`.
 * Front is the ordinary straight-on view; the side/top views show true depth.
 */
export type Camera3dMode =
  | 'active'
  | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'
  | CustomViewId
  | CameraViewMode;

/** How many viewport panes the workspace shows (AE's 1 View / 2 Views / 4 Views). */
export type ViewLayout = '1' | '2' | '4';

/**
 * The four view modes of the 2×2 "4 Views" layout, in cell order:
 *   [0] top-left — the interactive stage (AE's active viewport)
 *   [1] top-right — view-only inspection pane
 *   [2] bottom-left — view-only inspection pane
 *   [3] bottom-right — view-only inspection pane
 * Index 0 is what the interactive stage renders through; only cells 1–3 are
 * driven by SecondaryViewPanes. Session view state (not project data), matching
 * `camera3dMode` / `secondaryViewMode`.
 */
export type QuadViewModes = [Camera3dMode, Camera3dMode, Camera3dMode, Camera3dMode];

/** The orthographic views, in AE's menu order — for building the picker. */
export const CAMERA_ORTHO_VIEWS = ['front', 'left', 'top', 'back', 'right', 'bottom'] as const;

/**
 * Whether an untrusted value is a view mode this build understands.
 *
 * Bookmarks are read back out of documents, and their mode used to be cast
 * straight into the union — a mode from a newer or hand-edited file then
 * reached every consumer that assumed "not active, not custom ⇒ an axis view".
 * A `camera:<id>` mode is accepted whatever the id: whether that camera still
 * exists is a question for render time, where it falls back to 'active'.
 */
export function isCamera3dMode(v: unknown): v is Camera3dMode {
  return typeof v === 'string' && (
    v === 'active'
    || (CAMERA_ORTHO_VIEWS as readonly string[]).includes(v)
    || isCustomViewId(v)
    || isCameraViewMode(v)
  );
}

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

/**
 * A named viewpoint — the camera the viewport looks through plus the pan/zoom
 * it is framed at, and for a custom view its stored orbit. Saved per
 * COMPOSITION (keyed by comp id) and persisted in the document beside the
 * rest of the guides settings, so a project reopens with its bookmarks.
 */
export interface CameraBookmark {
  /** 1–9: the `Ctrl+Alt+<slot>` key that recalls it. */
  slot: number;
  name: string;
  mode: Camera3dMode;
  framing: { center: { x: number; y: number }; zoom: number };
  /** Present when `mode` is a custom view — its orbit at the time of saving. */
  customView?: CustomViewParams;
}

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
  /**
   * How much of the motion path is drawn (AE Preferences ▸ Display ▸ Motion
   * Path): every keyframe, none, or `motionPathWindowSeconds` of path centred
   * on the playhead. Absent on older documents = 'all'.
   */
  motionPathShow?: 'all' | 'none' | 'window';
  /** Span, in seconds, drawn when `motionPathShow === 'window'`. */
  motionPathWindowSeconds?: number;
  /**
   * User ruler guides (AE 26.5: value + unit + pin edge + colour). The engine
   * holds the live guides; this is the document copy `useGuideSync` keeps in
   * step. Absent on older documents = none.
   */
  userGuides?: StoredGuide[];
  /** Camera bookmarks, comp id → slots. Absent on older documents. */
  cameraBookmarks?: Record<string, CameraBookmark[]>;
  /**
   * Opacity applied to the viewport's reference chrome — guides, grid, the
   * 3D gizmo and smart guides — 0.2…1. Persisted with the guides because it is
   * a property of how THIS document's overlays read, not of the machine.
   */
  overlayOpacity?: number;
}

export type Gizmo3dState = 'universal' | 'position' | 'scale' | 'rotation';
export type Gizmo3dAxisMode = 'local' | 'world' | 'view';

/**
 * The active drag camera tool (C key cycles unified → orbit → pan → dolly;
 * Esc or any tool pick returns to 'none' = normal selection). Session view
 * state. 'unified' is AE's Unified Camera: the mouse BUTTON picks the gesture
 * (left = orbit, middle = track XY, right = track Z / dolly).
 */
export type CameraTool = 'none' | 'unified' | 'orbit' | 'pan' | 'dolly';

/**
 * What the orbit gesture pivots on (AE's Orbit Around Cursor / Scene / Camera
 * POI). Applies to the orbit tool AND the unified tool's left-drag; ortho and
 * custom views keep their own promote-to-custom-view behaviour regardless.
 * Session view state, like the camera tool itself.
 */
export type CameraOrbitPivot = 'cursor' | 'scene' | 'poi';

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
  /** Ground Grid (3D Floor) toggle. */
  groundGridVisible: boolean;
  /**
   * Draft 3D (AE's lightning bolt): fast preview that skips depth-of-field
   * blur and all lighting (shading, light washes, cast shadows). View state —
   * final renders/export never see it.
   */
  draft3d: boolean;
  /**
   * Figma-style smart guides: distance badges to the nearest neighbours,
   * pink hatch bars over equal-spacing runs, and equal-size highlights, drawn
   * only while a gesture is in flight (or an Alt-hover is measuring).
   *
   * On by default — it is the measuring half of snapping and costs nothing when
   * nothing is being dragged. Session state, deliberately NOT part of
   * `GuidesSettings`: it is a preference about the CHROME, not project data, so
   * opening someone else's document must not silently turn a user's guides off.
   */
  smartGuides: boolean;
  /** Active left-drag camera tool (C-key cycling), 'none' = selection. */
  cameraTool: CameraTool;
  /** What the orbit gesture pivots on — see {@link CameraOrbitPivot}. */
  cameraOrbitPivot: CameraOrbitPivot;
  /**
   * Whether user guides are DRAWN (and grabbable). Locking is per guide in the
   * engine (`Guides.setLocked`); this is the View ▸ Show Guides switch, which
   * AE keeps separate from lock. Session state.
   */
  guidesVisible: boolean;
  /** See `GuidesSettings.cameraBookmarks`. */
  cameraBookmarks: Record<string, CameraBookmark[]>;
  /** See `GuidesSettings.overlayOpacity`. */
  overlayOpacity: number;

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
  toggleGroundGridVisible: () => void;
  toggleDraft3d: () => void;
  /** View ▸ Options ▸ Smart Guides. */
  toggleSmartGuides: () => void;
  setSmartGuides: (on: boolean) => void;
  setCameraTool: (tool: CameraTool) => void;
  /** C key: none → unified → orbit → pan → dolly → unified … */
  cycleCameraTool: () => void;
  setCameraOrbitPivot: (pivot: CameraOrbitPivot) => void;
  /** Set (or clear, with null) the region of interest, in comp px. */
  setRoi: (roi: RegionOfInterest | null) => void;
  toggleChannel: () => void;
  /** Set the isolated channel directly (rgb/alpha/red/green/blue). */
  setChannel: (channel: ViewChannel) => void;
  toggleMotionPath: () => void;
  setMotionPathDots: (size: GuidesSettings['motionPathDots']) => void;
  motionPathShow: 'all' | 'none' | 'window';
  motionPathWindowSeconds: number;
  setMotionPathShow: (show: 'all' | 'none' | 'window') => void;
  setMotionPathWindowSeconds: (seconds: number) => void;
  userGuides: StoredGuide[];
  /** Replace the document's user guides (the engine sync calls this). */
  setUserGuides: (guides: StoredGuide[]) => void;
  toggleGuidesVisible: () => void;
  setGuidesVisible: (on: boolean) => void;
  setOverlayOpacity: (opacity: number) => void;
  /** Save (replace) a bookmark slot for a comp. */
  saveCameraBookmark: (compId: string, bookmark: CameraBookmark) => void;
  removeCameraBookmark: (compId: string, slot: number) => void;
  renameCameraBookmark: (compId: string, slot: number, name: string) => void;
  /** Stable string that changes whenever any guide toggles (render key). */
  key: () => string;
}

/** Clamp an overlay opacity into the range the painters honour. */
export function clampOverlayOpacity(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(0.2, Math.min(1, v));
}

/**
 * The persisted half of this store, at its defaults.
 *
 * Named because a NEW project has to be able to get back to it: `restore` only
 * applies the keys a document carries, so a blank document left the previous
 * project's guides in place. The store seeds itself from the same constant, so
 * "default" cannot drift between boot and File ▸ New Project.
 */
export const DEFAULT_GUIDES_SETTINGS: GuidesSettings = {
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
  motionPathVisible: true,
  motionPathDots: 'small',
};

/** Keep only well-formed bookmarks — a document is untrusted input. */
function sanitizeBookmarks(raw: unknown): Record<string, CameraBookmark[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, CameraBookmark[]> = {};
  for (const [compId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const ok: CameraBookmark[] = [];
    for (const b of list as unknown[]) {
      if (!b || typeof b !== 'object') continue;
      const bm = b as Partial<CameraBookmark>;
      if (typeof bm.slot !== 'number' || bm.slot < 1 || bm.slot > 9) continue;
      if (typeof bm.mode !== 'string') continue;
      const f = bm.framing;
      if (!f || typeof f.zoom !== 'number' || !f.center || typeof f.center.x !== 'number' || typeof f.center.y !== 'number') continue;
      ok.push({
        slot: Math.round(bm.slot),
        name: typeof bm.name === 'string' ? bm.name : `Bookmark ${bm.slot}`,
        // An unknown mode keeps its framing and name and opens as Active
        // Camera, rather than dropping a bookmark someone saved.
        mode: isCamera3dMode(bm.mode) ? bm.mode : 'active',
        framing: { center: { x: f.center.x, y: f.center.y }, zoom: f.zoom },
        ...(bm.customView ? { customView: bm.customView } : {}),
      });
    }
    if (ok.length) out[compId] = ok.sort((a, c) => a.slot - c.slot);
  }
  return out;
}

export const useGuidesStore = create<GuidesStore>((set, get) => ({
  ...DEFAULT_GUIDES_SETTINGS,
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
  gizmo3dState: 'universal',
  gizmo3dAxisMode: 'local',
  groundGridVisible: true,
  draft3d: false,
  smartGuides: true,
  cameraTool: 'none',
  // 'scene', not 'poi': a one-node camera's POI is wherever it happens to be
  // looking, so after any pan the first orbit swung the artwork out of frame.
  // Pivoting on the content keeps it framed by construction; Cursor and Camera
  // POI are one click away in the tool's options.
  cameraOrbitPivot: 'scene',
  guidesVisible: true,
  cameraBookmarks: {},
  overlayOpacity: 1,
  motionPathShow: 'all',
  motionPathWindowSeconds: 2,
  userGuides: [],

  setMotionPathShow: (show) => set({ motionPathShow: show }),
  setMotionPathWindowSeconds: (seconds) =>
    set({ motionPathWindowSeconds: Number.isFinite(seconds) ? Math.max(0.1, Math.min(600, seconds)) : 2 }),
  setUserGuides: (guides) => set({ userGuides: guides }),
  toggleGuidesVisible: () => set((s) => ({ guidesVisible: !s.guidesVisible })),
  setGuidesVisible: (on) => set({ guidesVisible: on }),
  setOverlayOpacity: (opacity) => set({ overlayOpacity: clampOverlayOpacity(opacity) }),
  saveCameraBookmark: (compId, bookmark) =>
    set((s) => {
      const slot = Math.max(1, Math.min(9, Math.round(bookmark.slot)));
      const list = (s.cameraBookmarks[compId] ?? []).filter((b) => b.slot !== slot);
      list.push({ ...bookmark, slot });
      list.sort((a, b) => a.slot - b.slot);
      return { cameraBookmarks: { ...s.cameraBookmarks, [compId]: list } };
    }),
  removeCameraBookmark: (compId, slot) =>
    set((s) => {
      const list = (s.cameraBookmarks[compId] ?? []).filter((b) => b.slot !== slot);
      const next = { ...s.cameraBookmarks };
      if (list.length) next[compId] = list;
      else delete next[compId];
      return { cameraBookmarks: next };
    }),
  renameCameraBookmark: (compId, slot, name) =>
    set((s) => ({
      cameraBookmarks: {
        ...s.cameraBookmarks,
        [compId]: (s.cameraBookmarks[compId] ?? []).map((b) => (b.slot === slot ? { ...b, name } : b)),
      },
    })),

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
  toggleGroundGridVisible: () => set((s) => ({ groundGridVisible: !s.groundGridVisible })),
  toggleDraft3d: () => set((s) => ({ draft3d: !s.draft3d })),
  toggleSmartGuides: () => set((s) => ({ smartGuides: !s.smartGuides })),
  setSmartGuides: (on) => set({ smartGuides: on }),
  setCameraTool: (tool) => set({ cameraTool: tool }),
  // AE's C-key order: Unified first, then the three single-gesture tools.
  cycleCameraTool: () =>
    set((s) => ({
      cameraTool:
        s.cameraTool === 'none' ? 'unified'
        : s.cameraTool === 'unified' ? 'orbit'
        : s.cameraTool === 'orbit' ? 'pan'
        : s.cameraTool === 'pan' ? 'dolly'
        : 'unified',
    })),
  setCameraOrbitPivot: (pivot) => set({ cameraOrbitPivot: pivot }),
  setRoi: (roi) => set({ roi }),
  toggleChannel: () => set((s) => ({ channel: s.channel === 'rgb' ? 'alpha' : 'rgb' })),
  setChannel: (channel) => set({ channel }),
  toggleMotionPath: () => set((s) => ({ motionPathVisible: !s.motionPathVisible })),
  setMotionPathDots: (size) => set({ motionPathDots: size }),
  settings: () => {
    const {
      rulers, grid, gridSpacing, gridSubdivisions, snapToGrid, gridColor, gridStyle,
      proportionalGrid, proportionalColumns, proportionalRows, safeArea, motionPathVisible, motionPathDots,
      cameraBookmarks, overlayOpacity, motionPathShow, motionPathWindowSeconds, userGuides,
    } = get();
    return {
      rulers, grid, gridSpacing, gridSubdivisions, snapToGrid, gridColor, gridStyle,
      proportionalGrid, proportionalColumns, proportionalRows, safeArea, motionPathVisible, motionPathDots,
      // Absent when empty / default, so a document that never used them reads
      // back byte-identical to one written before they existed.
      ...(Object.keys(cameraBookmarks).length ? { cameraBookmarks } : {}),
      ...(overlayOpacity !== 1 ? { overlayOpacity } : {}),
      ...(motionPathShow !== 'all' ? { motionPathShow, motionPathWindowSeconds } : {}),
      ...(userGuides.length ? { userGuides: userGuides.map((g) => ({ ...g })) } : {}),
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
    if (typeof s.overlayOpacity === 'number') get().setOverlayOpacity(s.overlayOpacity);
    else set({ overlayOpacity: 1 });
    // Bookmarks are replaced wholesale: a document carries its own set, and a
    // blank document carries none.
    set({ cameraBookmarks: sanitizeBookmarks(s.cameraBookmarks) });
    // User guides likewise: a document's guides, or none.
    set({ userGuides: sanitizeStoredGuides(s.userGuides) });
    set({
      motionPathShow: s.motionPathShow === 'none' || s.motionPathShow === 'window' ? s.motionPathShow : 'all',
    });
    if (typeof s.motionPathWindowSeconds === 'number') get().setMotionPathWindowSeconds(s.motionPathWindowSeconds);
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
    return `${s.rulers ? 1 : 0}${s.grid ? 1 : 0}:${s.gridSpacing}/${s.gridSubdivisions}/${s.gridStyle}:${s.proportionalGrid ? 1 : 0}${s.proportionalColumns}x${s.proportionalRows}:${s.gridColor}:${s.safeArea ? 1 : 0}:${s.camera3dMode}:${cv}:${s.viewLayout}:${s.secondaryViewMode}:${s.quadViewModes.join(',')}:${s.channel}:${s.motionPathVisible ? 1 : 0}:${s.motionPathDots}:${s.motionPathShow}/${s.motionPathWindowSeconds}:${s.gizmo3dState}:${s.gizmo3dAxisMode}:${s.groundGridVisible ? 1 : 0}:${s.draft3d ? 1 : 0}:${roi}`;
  },
}));

