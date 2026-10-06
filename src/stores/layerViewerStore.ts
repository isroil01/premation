/**
 * layerViewerStore — AE's Layer panel: which layer it is showing, its View
 * menu, and its mask tools.
 *
 * Session state only, never persisted. A Layer panel names ONE layer of the
 * open document; workspace persistence (where the editor tabs live) outlives
 * documents, and would carry a dangling layer id into the next project.
 */

import { create } from 'zustand';

/** The Layer panel's mask tools — AE draws and reshapes masks there. */
export type LayerMaskTool = 'select' | 'rect' | 'ellipse' | 'pen';

/** A mask path, and optionally one vertex of it, picked in the Layer panel. */
export interface LayerMaskSelection {
  pathId: string;
  point: number | null;
}

export type LayerAlphaView = 'off' | 'alpha' | 'boundary' | 'overlay';

export interface LayerViewerState {
  /** The layer on show, or null when the Layer panel is closed. */
  nodeId: string | null;
  /**
   * AE's "Render" checkbox: draw the layer with its masks and effects. Off
   * shows the untouched source — what the layer starts from.
   */
  render: boolean;
  /** View ▸ Masks: outline the layer's mask paths (and edit them). */
  showMasks: boolean;
  /** View ▸ Anchor Point: mark the layer's anchor. */
  showAnchor: boolean;
  /** View ▸ Motion Tracker Points: the Tracker's points, placed on the layer itself. */
  showTracker: boolean;
  /** View ▸ Effect Controls: an effect's point controls, dragged on the layer. */
  showEffectPoints: boolean;
  /**
   * How the layer's alpha is shown — After Effects' Alpha, Alpha Boundary and
   * Alpha Overlay views, for judging a Roto Brush matte or a mask. 'off' = the
   * layer as it is. The engine draws them (setViewport `layerAlphaView`).
   */
  alphaView: LayerAlphaView;
  /**
   * Exposure, in stops: how the VIEWER shows the picture (to look into
   * shadows or highlights). Never part of the render.
   */
  exposure: number;
  /** View ▸ Rulers: rulers in the layer's pixels, and guides dragged out of them. */
  showRulers: boolean;
  /** Guides, in the layer's pixels from its top-left. A viewing aid of this session. */
  guides: { x: readonly number[]; y: readonly number[] };
  /** The active mask tool. */
  maskTool: LayerMaskTool;
  /** The mask (vertex) picked for editing, or null. */
  maskSelection: LayerMaskSelection | null;
  open: (nodeId: string) => void;
  close: () => void;
  setView: (patch: Partial<Pick<LayerViewerState, 'render' | 'showMasks' | 'showAnchor' | 'showTracker' | 'showEffectPoints' | 'alphaView'>>) => void;
  setExposure: (stops: number) => void;
  setRulers: (on: boolean) => void;
  setGuides: (guides: { x: readonly number[]; y: readonly number[] }) => void;
  setMaskTool: (tool: LayerMaskTool) => void;
  selectMask: (sel: LayerMaskSelection | null) => void;
}

export const useLayerViewerStore = create<LayerViewerState>((set) => ({
  nodeId: null,
  render: true,
  showMasks: true,
  showAnchor: true,
  showTracker: true,
  showEffectPoints: true,
  alphaView: 'off',
  exposure: 0,
  showRulers: false,
  guides: { x: [], y: [] },
  maskTool: 'select',
  maskSelection: null,
  // A different layer starts with nothing picked; the tool is kept, as AE does.
  open: (nodeId) => set((s) => (s.nodeId === nodeId ? s : { nodeId, maskSelection: null, guides: { x: [], y: [] } })),
  close: () => set({ nodeId: null, maskSelection: null }),
  setView: (patch) => set(patch),
  setExposure: (stops) => set({ exposure: Math.max(-8, Math.min(8, Number.isFinite(stops) ? stops : 0)) }),
  setRulers: (showRulers) => set({ showRulers }),
  setGuides: (guides) => set({ guides }),
  setMaskTool: (maskTool) => set({ maskTool }),
  selectMask: (maskSelection) => set({ maskSelection }),
}));
