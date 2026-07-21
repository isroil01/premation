/**
 * Canvas guides (spec §Canvas — "Guides, rulers, smart snapping, Safe areas").
 * Toggle rulers, a grid, and broadcast/action safe-area overlays. The renderer
 * reads these and draws them over the composition.
 */

import { create } from 'zustand';

/** Which channel the viewport shows. Non-'rgb' values isolate that channel as
 *  greyscale (alpha = matte/coverage; red/green/blue = that colour component). */
export type ViewChannel = 'rgb' | 'alpha' | 'red' | 'green' | 'blue';

/**
 * Which camera the viewport renders through.
 *   'active'                          — the scene's Camera layer (perspective).
 *   front/back/left/right/top/bottom  — orthographic axis views (no perspective).
 * Front is the ordinary straight-on view; the side/top views show true depth.
 */
export type Camera3dMode = 'active' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

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

interface GuidesStore extends GuidesSettings {
  camera3dMode: Camera3dMode;
  channel: ViewChannel;
  /** Active Region of Interest, or null when the whole comp renders. */
  roi: RegionOfInterest | null;
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
  channel: 'rgb',
  roi: null,
  motionPathVisible: true,
  motionPathDots: 'small',
  toggleRulers: () => set((s) => ({ rulers: !s.rulers })),
  toggleGrid: () => set((s) => ({ grid: !s.grid })),
  setGridDivisions: (n) => set({ gridDivisions: Math.max(2, Math.min(64, Math.round(n))) }),
  setGridColor: (hex) => set({ gridColor: hex }),
  toggleSafeArea: () => set((s) => ({ safeArea: !s.safeArea })),
  toggleCamera3dMode: () => set((s) => ({ camera3dMode: s.camera3dMode === 'active' ? 'front' : 'active' })),
  setCamera3dMode: (mode) => set({ camera3dMode: mode }),
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
    return `${s.rulers ? 1 : 0}${s.grid ? 1 : 0}:${s.gridDivisions}:${s.gridColor}:${s.safeArea ? 1 : 0}:${s.camera3dMode}:${s.channel}:${s.motionPathVisible ? 1 : 0}:${s.motionPathDots}:${roi}`;
  },
}));
