/**
 * The Liquify brush (AE parity 5.5): which Liquify effect the canvas brush
 * paints into, and the brush itself (tool, size, pressure). Editor state — the
 * painted field is the document's (the effect's `field` param); the brush
 * settings never enter it.
 */

import { create } from 'zustand';
import type { LiquifyTool } from '@core/effects/liquifyField';

interface LiquifyBrushStore {
  /** The layer and the Liquify effect the brush paints into; null = the brush is off. */
  nodeId: string | null;
  effectId: string | null;
  tool: LiquifyTool;
  /** Brush size (diameter), layer px. */
  size: number;
  /** 1…100 %. */
  pressure: number;
  start: (nodeId: string, effectId: string) => void;
  stop: () => void;
  setTool: (tool: LiquifyTool) => void;
  setSize: (size: number) => void;
  setPressure: (pressure: number) => void;
}

export const useLiquifyBrushStore = create<LiquifyBrushStore>((set) => ({
  nodeId: null,
  effectId: null,
  tool: 'warp',
  size: 120,
  pressure: 50,
  start: (nodeId, effectId) => set({ nodeId, effectId }),
  stop: () => set({ nodeId: null, effectId: null }),
  setTool: (tool) => set({ tool }),
  setSize: (size) => set({ size: Math.max(2, Math.min(2000, size)) }),
  setPressure: (pressure) => set({ pressure: Math.max(1, Math.min(100, pressure)) }),
}));
