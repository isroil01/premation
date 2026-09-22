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
import { defaultAnimation } from '@motion/animation';
import { makeKeyframeId } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { applyEasingToKeyframes, type EasingPreset } from '@core/animation/keyframeAssistants';
import { copyKeyframes, pasteKeyframes, hasClipboard } from '@core/animation/keyframeClipboard';
import { convertExpressionToKeyframes } from '@core/animation/convertExpressionToKeyframes';
import {
  addExpression,
  removeExpression,
  requestExpressionEditor,
} from '@core/animation/expressionCommands';
import { keyframeToCompTime } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { formatChord } from '@layout/Menu/formatChord';
import type { KeyChord } from '@app-types/common';
import { resolvePropertyMeta } from './propertyMeta';
import { isPinnedProp, setPinnedProp } from './pinnedProps';
import {
  compositionRootOf,
  isEssentialProp,
  isOverridableProp,
  setEssentialProp,
} from '@core/scene/compInstanceOverrides';

/** How close (seconds) the playhead must be to count as "on" a keyframe. */
const EPS = 1e-4;

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
 * The easing presets offered on a keyframe, in the order AE lists them.
 * `Hold` is last because it is categorically different — it stops interpolation
 * rather than shaping it.
 */
const EASING_PRESETS: ReadonlyArray<{ id: EasingPreset; label: string; chord?: KeyChord }> = [
  { id: 'Linear', label: 'Linear' },
  { id: 'Ease', label: 'Easy Ease', chord: { key: 'F9' } },
  { id: 'EaseIn', label: 'Easy Ease In', chord: { key: 'F9', shift: true } },
  { id: 'EaseOut', label: 'Easy Ease Out', chord: { key: 'F9', ctrl: true, shift: true } },
  { id: 'Hold', label: 'Toggle Hold' },
];

/**
 * Menu for one property row.
 *
 * The entries change with state on purpose: there is no "Remove keyframe" on a
 * property with none, and no easing submenu unless the playhead is actually on
 * a keyframe — a menu full of no-ops teaches people not to open it.
 */
export function buildPropertyMenu(ctx: PropertyMenuContext): ContextMenuItem[] {
  const { nodeId, prop, layerT, value, setValue } = ctx;
  const meta = resolvePropertyMeta(prop, nodeId);
  const animated = defaultAnimation.isAnimated(nodeId, prop);
  const kfs = animated ? defaultAnimation.getTrackKeyframes(nodeId, prop) ?? [] : [];
  const at = kfs.find((k) => Math.abs(k.t - layerT) < EPS);
  const items: ContextMenuItem[] = [];

  if (animated) {
    items.push({
      id: 'kf-toggle',
      label: at ? 'Remove Keyframe' : 'Add Keyframe',
      icon: 'keyframe',
      onSelect: () => {
        if (at) {
          runAnimEdit(`Remove ${meta.label} keyframe`, () =>
            defaultAnimation.removeKeyframe(nodeId, prop, at.t),
          );
        } else {
          runAnimEdit(`Add ${meta.label} keyframe`, () =>
            defaultAnimation.setKeyframe(nodeId, prop, layerT, value),
          );
        }
      },
    });

    if (at) {
      items.push({
        id: 'kf-easing',
        label: 'Keyframe Interpolation',
        children: EASING_PRESETS.map((p) => ({
          id: `ease-${p.id}`,
          label: p.label,
          // Formatted per call: the label follows the keyboard (⇧F9 vs Shift+F9).
          ...(p.chord ? { shortcut: formatChord(p.chord) } : {}),
          onSelect: () => applyEasingToKeyframes([makeKeyframeId(nodeId, prop, at.t)], p.id),
        })),
      });
      items.push({
        id: 'kf-copy',
        label: 'Copy Keyframe',
        onSelect: () => copyKeyframes(new Set([makeKeyframeId(nodeId, prop, at.t)])),
      });
    }

    if (hasClipboard()) {
      items.push({
        id: 'kf-paste',
        label: 'Paste Keyframes',
        // Paste lands at the playhead, so it needs COMP time — the clipboard
        // re-derives each target's own axis from it.
        onSelect: () => pasteKeyframes([nodeId], keyframeToCompTime(nodeId, layerT, prop)),
      });
    }

    items.push({ id: 'sep-anim', separator: true });
    items.push({
      id: 'remove-anim',
      label: 'Remove Animation',
      danger: true,
      onSelect: () =>
        runAnimEdit(`Remove ${meta.label} animation`, () => defaultAnimation.removeTrack(nodeId, prop)),
    });
  } else {
    items.push({
      id: 'animate',
      label: 'Enable Animation',
      icon: 'stopwatch',
      onSelect: () =>
        runAnimEdit(`Animate ${meta.label}`, () =>
          defaultAnimation.setKeyframe(nodeId, prop, layerT, value),
        ),
    });
  }

  /**
   * Convert Expression to Keyframes — PER PROPERTY here, unlike the command,
   * which bakes every eligible property on the layer.
   *
   * That difference is why this entry exists rather than delegating to the
   * command. A right-click lands on ONE row and means that row; baking a
   * layer's rotation because the user asked about its x is the kind of
   * over-reach that teaches people not to use a menu. The command bakes the
   * whole layer because it is invoked with a layer selected and has nothing
   * narrower to go on.
   *
   * Shown only when there IS an enabled expression, for the same reason nothing
   * else here is unconditional: a menu full of no-ops teaches people not to
   * open it.
   */
  const exprItems = expressionPropMenuItems(nodeId, prop, ctx.nodeIds);
  if (exprItems.length > 0 || defaultAnimation.isExpressionEnabled(nodeId, prop)) {
    items.push({ id: 'sep-expr', separator: true });
    items.push(...exprItems);
  }
  if (defaultAnimation.isExpressionEnabled(nodeId, prop)) {
    items.push({
      id: 'expr-bake',
      label: 'Convert Expression to Keyframes',
      icon: 'keyframe',
      onSelect: () => { convertExpressionToKeyframes(nodeId, [prop]); },
    });
  }

  if (setValue && meta.resettable && typeof meta.defaultValue === 'number') {
    const def = meta.defaultValue;
    items.push({ id: 'sep-reset', separator: true });
    items.push({
      id: 'reset',
      label: `Reset ${meta.label}`,
      icon: 'rotate',
      // Resetting an ANIMATED property writes a keyframe rather than a static
      // value — otherwise the write is invisible, overwritten by the track on
      // the very next frame.
      onSelect: () => {
        if (animated) {
          runAnimEdit(`Reset ${meta.label}`, () =>
            defaultAnimation.setKeyframe(nodeId, prop, layerT, def),
          );
        } else {
          setValue(def);
        }
      },
    });
  }

  items.push(...essentialPropMenuItems(nodeId, prop));
  items.push(...pinPropMenuItems(nodeId, prop));

  return items;
}

/**
 * "Add Expression", or "Edit Expression" + "Remove Expression", for one row.
 *
 * Why these live in the ROW menu now: the inspector's compact rows show the
 * `=` toggle only on hover, and a two-field row (Position X/Y) has no per-field
 * `=` at all. The menu is the one place every field can always reach.
 *
 * Add is the shared `addExpression` (AE's default `value`, one undo step, then
 * the editor-open request); Edit is only that request, which the mounted row
 * answers by opening its inline editor — the same plumbing Alt+Shift+= uses,
 * so there is no second way to open an editor to keep in step.
 *
 * Empty when the id names no node, like the pin entries, so the bare-id unit
 * tests of this builder stay free of it.
 */
export function expressionPropMenuItems(
  nodeId: string,
  prop: string,
  nodeIds: ReadonlyArray<string> = [nodeId],
): ContextMenuItem[] {
  if (!defaultSceneGraph.getNode(nodeId)) return [];
  const refs = (nodeIds.length > 0 ? nodeIds : [nodeId]).map((id) => ({ nodeId: id, prop }));
  if (!defaultAnimation.hasExpression(nodeId, prop)) {
    return [{
      id: 'expr-add',
      label: 'Add Expression',
      onSelect: () => { addExpression(refs); },
    }];
  }
  return [
    {
      id: 'expr-edit',
      label: 'Edit Expression',
      onSelect: () => { requestExpressionEditor({ nodeId, prop }); },
    },
    {
      id: 'expr-remove',
      label: 'Remove Expression',
      danger: true,
      onSelect: () => { removeExpression(refs); },
    },
  ];
}

/**
 * "Pin / Unpin" for one property — the entry that feeds the Pinned sub-tab.
 *
 * Offered on every row that has a node, numeric or not, because pinning is
 * about WHERE a property is listed, not about what kind of value it holds.
 * Empty when the id names no node (the property-menu unit tests use a bare
 * id), so those suites stay free of it.
 */
export function pinPropMenuItems(nodeId: string, prop: string): ContextMenuItem[] {
  if (!defaultSceneGraph.getNode(nodeId)) return [];
  const pinned = isPinnedProp(nodeId, prop);
  return [
    { id: 'sep-pin', separator: true },
    {
      id: 'pin-toggle',
      label: pinned ? 'Unpin from Pinned' : 'Pin to Pinned tab',
      icon: 'push-pin',
      onSelect: () => { setPinnedProp(nodeId, prop, !pinned); },
    },
  ];
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
  const root = compositionRootOf(nodeId);
  if (!root || root === nodeId) return [];
  const promoted = isEssentialProp(root, nodeId, prop);
  return [
    { id: 'sep-essential', separator: true },
    {
      id: 'essential-toggle',
      label: promoted ? 'Remove from Essential Properties' : 'Add to Essential Properties',
      onSelect: () => {
        setEssentialProp(root, nodeId, prop, !promoted);
      },
    },
  ];
}
