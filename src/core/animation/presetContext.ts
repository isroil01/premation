/**
 * Resolving a {@link PresetContext} from the live project.
 *
 * Split from presetUnits.ts on purpose: the unit maths is pure and testable
 * with a literal context, and only this file knows about the store and the
 * scene graph. Preset application depends on the maths, not on the app.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useProjectStore } from '@stores/projectStore';
import { DEFAULT_PRESET_CONTEXT, type PresetContext } from './presetUnits';

/** The active composition's settings, or undefined outside a project (tests). */
function activeComp(): { width: number; height: number; durationSeconds: number } | undefined {
  try {
    const s = useProjectStore.getState();
    const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
    const comp = tab ? s.comps[tab.compositionId] : undefined;
    return comp ? { width: comp.width, height: comp.height, durationSeconds: comp.durationSeconds } : undefined;
  } catch {
    return undefined;
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Read the first numeric `key` across a node's components. */
function nodeNumber(nodeId: string, key: string): number | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return undefined;
  for (const c of node.components) {
    const v = num((c.props as Record<string, unknown>)[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Build the context a preset resolves its relative values against.
 *
 * Falls back field-by-field rather than all-or-nothing: a layer with no
 * explicit width still gets the real comp size, so a slide-in lands correctly
 * even when the layer's own box is unknown.
 */
export function presetContextFor(nodeId: string): PresetContext {
  const comp = activeComp();
  const compWidth = comp?.width ?? DEFAULT_PRESET_CONTEXT.compWidth;
  const compHeight = comp?.height ?? DEFAULT_PRESET_CONTEXT.compHeight;
  return {
    compWidth,
    compHeight,
    layerWidth: nodeNumber(nodeId, 'width') ?? DEFAULT_PRESET_CONTEXT.layerWidth,
    layerHeight: nodeNumber(nodeId, 'height') ?? DEFAULT_PRESET_CONTEXT.layerHeight,
    fontSize: nodeNumber(nodeId, 'fontSize') ?? DEFAULT_PRESET_CONTEXT.fontSize,
    // A layer's own out-point would be better; the comp duration is the honest
    // fallback and matches what an author sees on the timeline.
    layerDuration:
      nodeNumber(nodeId, 'durationSeconds') ??
      comp?.durationSeconds ??
      DEFAULT_PRESET_CONTEXT.layerDuration,
  };
}
