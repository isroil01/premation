/**
 * deriveProjectFacts — the pure projector from a document to the scalar facts
 * the index mirrors (so a dashboard card renders without opening the bundle).
 *
 * This is the local counterpart of the backend's `projectFacts`: the same
 * summary — size, fps, duration, layer count — computed from the live
 * `EditorDocument` on every save. Deterministic and dependency-free.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { CompositionSettings } from '@stores/projectStore';

export interface ProjectFacts {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  layerCount: number;
}

const ZERO: ProjectFacts = { width: 0, height: 0, fps: 0, durationSeconds: 0, layerCount: 0 };

/**
 * Summarize a document. Size/fps/duration come from the primary composition
 * (the first comp, else the legacy single `comp`); layer count is the scene
 * node count. Absent data yields zeros rather than throwing — a bundle mid-write
 * or a legacy scene-only file still produces a valid (if sparse) card.
 */
export function deriveProjectFacts(doc: EditorDocument): ProjectFacts {
  if (!doc) return { ...ZERO };

  const comps: Record<string, CompositionSettings> =
    doc.comps ?? (doc.comp ? { [doc.comp.id]: doc.comp } : {});
  const primary = Object.values(comps)[0];

  const nodes = (doc.scene as { nodes?: unknown[] } | undefined)?.nodes;
  const layerCount = Array.isArray(nodes) ? nodes.length : 0;

  return {
    width: primary?.width ?? 0,
    height: primary?.height ?? 0,
    fps: primary?.fps ?? 0,
    durationSeconds: primary?.durationSeconds ?? 0,
    layerCount,
  };
}
