/**
 * Right-click menu for a PROPERTY ROW — the inspector's transform rows and the
 * effect stack's parameter rows. One builder so "Easy Ease" cannot mean one
 * thing in one panel and something else in another.
 *
 * Deliberately NOT a keyframe menu. The timeline's keyframe diamonds already
 * have one (`handleKeyframeContextMenu` in App.tsx) and it is more complete
 * than this would be — it carries hold and roving toggles and expands the
 * merged Position pseudo-property into its real x/y/z tracks. A second
 * implementation would drift from it immediately.
 *
 * Returns plain `ContextMenuItem[]`; the caller passes them to
 * `openContextMenu`. Nothing here touches React.
 */

import type { ContextMenuItem } from '@stores/contextMenuStore';
import { documentMirror } from '@stores/documentMirror';
import { mirrorCompositionRootOf, mirrorIsEssentialProp } from '@core/mirror/compOverrides';
import { isOverridableProp } from '@core/scene/compInstanceOverrides';
import { edit } from '@core/engine/uiEdits';

export interface PropertyMenuContext {
  nodeId: string;
  /** Animation prop path (`x`, `effect.fx_1.radius`, …). */
  prop: string;
  /** The property's own time axis at the playhead (NOT raw comp time). */
  layerT: number;
  /** Current displayed value — what an added keyframe should hold. */
  value: number;
  /** Write a plain (un-keyframed) value. Omitted → no reset entry. */
  setValue?: (v: number) => void;
  /**
   * Every layer the row edits (a multi-selection), primary first. Only the
   * expression entries read it — Add / Remove act on the whole selection like
   * the row's own `=` toggle does. Omitted → just `nodeId`.
   */
  nodeIds?: ReadonlyArray<string>;
}

/**
 * The "Add to / Remove from Essential Properties" entry for one property.
 *
 * Extracted so the COLOUR and TEXT rows can offer promotion too. Those rows do
 * not go through `buildPropertyMenu`: it is shaped for a numeric, keyframeable
 * property (`value: number`, `setValue`), and a colour is neither — it is
 * stored as a string and keyframed as three channels. Rebuilding this entry at
 * each of those call sites is how the label and the storage key drift apart,
 * so there is one implementation and both surfaces call it.
 *
 * Empty when the property is not overridable, or the layer is not inside a real
 * composition root — property-menu unit tests use a bare id with no graph node,
 * so they stay free of this entry.
 */
export function essentialPropMenuItems(nodeId: string, prop: string): ContextMenuItem[] {
  if (!isOverridableProp(prop)) return [];
  // B4: the composition and what it publishes from the document mirror (`CompSettings.essentialProps`).
  const m = documentMirror();
  const root = mirrorCompositionRootOf(m, nodeId);
  if (!root || root === nodeId) return [];
  const promoted = mirrorIsEssentialProp(m, root, nodeId, prop);
  return [
    { id: 'sep-essential', separator: true },
    {
      id: 'essential-toggle',
      label: promoted ? 'Remove from Essential Properties' : 'Add to Essential Properties',
      // The engine's command (one entry) — the scene-graph write reached the page's replica only.
      onSelect: () => {
        void edit(promoted ? 'Remove from Essential Properties' : 'Add to Essential Properties', [
          { type: 'setEssentialProp', comp: root, layer: nodeId, prop, promoted: !promoted },
        ]);
      },
    },
  ];
}
