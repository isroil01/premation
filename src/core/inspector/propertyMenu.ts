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
import { keyframeToCompTime } from '@core/timeline/TimelineController';
import { resolvePropertyMeta } from './propertyMeta';
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
}

/**
 * The easing presets offered on a keyframe, in the order AE lists them.
 * `Hold` is last because it is categorically different — it stops interpolation
 * rather than shaping it.
 */
const EASING_PRESETS: ReadonlyArray<{ id: EasingPreset; label: string; shortcut?: string }> = [
  { id: 'Linear', label: 'Linear' },
  { id: 'Ease', label: 'Easy Ease', shortcut: 'F9' },
  { id: 'EaseIn', label: 'Easy Ease In', shortcut: '⇧F9' },
  { id: 'EaseOut', label: 'Easy Ease Out', shortcut: '⌃⇧F9' },
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
          ...(p.shortcut ? { shortcut: p.shortcut } : {}),
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
  if (defaultAnimation.isExpressionEnabled(nodeId, prop)) {
    items.push({ id: 'sep-expr', separator: true });
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

  // Essential Properties promotion — AE's source-side half. Only for the
  // numeric overridable set, and only when this layer sits inside a real
  // composition root (property-menu unit tests use a bare id with no graph
  // node, so they stay free of this entry).
  if (isOverridableProp(prop)) {
    const root = compositionRootOf(nodeId);
    if (root && root !== nodeId) {
      const promoted = isEssentialProp(root, nodeId, prop);
      items.push({ id: 'sep-essential', separator: true });
      items.push({
        id: 'essential-toggle',
        label: promoted ? 'Remove from Essential Properties' : 'Add to Essential Properties',
        onSelect: () => {
          setEssentialProp(root, nodeId, prop, !promoted);
        },
      });
    }
  }

  return items;
}
