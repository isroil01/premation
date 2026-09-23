/**
 * propertyRowMenu — the right-click menu of a numeric inspector row
 * (`useMultiPropertyField`) on the engine API (B3z). The same entries, in the
 * same order, as `buildPropertyMenu` (core/inspector/propertyMenu.ts), but
 * every document write is an engine command addressed in COMPOSITION time —
 * no keyframe-axis times leave the UI:
 *
 *   Add / Remove Keyframe     keyToggleCommands (getKeyframes ids)
 *   Keyframe Interpolation    easeKeysAtCommands → updateKeyframes
 *   Copy / Paste Keyframes    the keyframe clipboard (a read) / pasteKeyframes
 *   Remove / Enable Animation setAnimated
 *   Convert Expression to Keyframes   convertExpressionToKeyframes
 *   Reset <prop>              the row's own write (a key at the playhead when animated)
 *
 * The expression, Essential Properties and Pin entries are the shared builders.
 */

import type { ContextMenuItem } from '@stores/contextMenuStore';
import type { EasingPreset } from '@core/animation/keyframeAssistants';
import { copyKeyframeAt, hasClipboard } from '@core/animation/keyframeClipboard';
import { formatChord } from '@core/commands/formatChord';
import type { KeyChord } from '@app-types/common';
import { documentMirror } from '@stores/documentMirror';
import { isTrackAnimated, navigatorFor, trackExpression } from '@core/mirror/selection';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { edit } from '@core/engine/uiEdits';
import { essentialPropMenuItems, expressionPropMenuItems, pinPropMenuItems } from '@core/inspector/propertyMenu';
import { easeKeysAtCommands, keyToggleCommands, stopwatchCommands, trackRef } from './inspectorEdits';
import { pasteKeyframesAt } from '@layout/Timeline/keyframeEdits';

const EASING_PRESETS: ReadonlyArray<{ id: EasingPreset; label: string; chord?: KeyChord }> = [
  { id: 'Linear', label: 'Linear' },
  { id: 'Ease', label: 'Easy Ease', chord: { key: 'F9' } },
  { id: 'EaseIn', label: 'Easy Ease In', chord: { key: 'F9', shift: true } },
  { id: 'EaseOut', label: 'Easy Ease Out', chord: { key: 'F9', ctrl: true, shift: true } },
  { id: 'Hold', label: 'Toggle Hold' },
];

export interface RowMenuContext {
  nodeId: string;
  /** Track name (`x`, `effect.fx_1.radius`, …). */
  prop: string;
  /** Every layer the row edits, primary first. */
  nodeIds: ReadonlyArray<string>;
  /** The playhead, COMPOSITION seconds. */
  time: number;
  /** The property's display label. */
  label: string;
  /** Registry default (stored units) when the property may be reset. */
  resetValue: number | undefined;
  /** The row's own value write (stored units) — reset goes through it (one entry, keyed when animated). */
  setValue: (v: number) => void;
}

export function engineRowMenuItems(ctx: RowMenuContext): ContextMenuItem[] {
  const { nodeId, prop, time, label } = ctx;
  const mirror = documentMirror();
  const animated = isTrackAnimated(mirror, nodeId, prop);
  const at = animated && navigatorFor(mirror, [nodeId], prop, time).atKeyframe;
  const items: ContextMenuItem[] = [];

  if (animated) {
    items.push({
      id: 'kf-toggle',
      label: at ? 'Remove Keyframe' : 'Add Keyframe',
      icon: 'keyframe',
      onSelect: () => {
        void keyToggleCommands([nodeId], [prop], time).then((cmds) => edit(at ? `Remove ${label} keyframe` : `Add ${label} keyframe`, cmds));
      },
    });
    if (at) {
      items.push({
        id: 'kf-easing',
        label: 'Keyframe Interpolation',
        children: EASING_PRESETS.map((p) => ({
          id: `ease-${p.id}`,
          label: p.label,
          ...(p.chord ? { shortcut: formatChord(p.chord) } : {}),
          onSelect: () => { void easeKeysAtCommands(nodeId, [prop], time, p.id).then((cmds) => edit(`Set keyframe easing: ${p.id}`, cmds)); },
        })),
      });
      items.push({
        id: 'kf-copy',
        label: 'Copy Keyframe',
        // A clipboard READ: the key under the playhead on this track's own axis.
        onSelect: () => copyKeyframeAt(nodeId, prop, keyAxisTimeForDisplay(nodeId, time, prop)),
      });
    }
    if (hasClipboard()) {
      items.push({ id: 'kf-paste', label: 'Paste Keyframes', onSelect: () => { void pasteKeyframesAt([nodeId], time); } });
    }
    items.push({ id: 'sep-anim', separator: true });
    items.push({
      id: 'remove-anim',
      label: 'Remove Animation',
      danger: true,
      onSelect: () => { void edit(`Remove ${label} animation`, stopwatchCommands([nodeId], [prop], time)); },
    });
  } else {
    items.push({
      id: 'animate',
      label: 'Enable Animation',
      icon: 'stopwatch',
      onSelect: () => { void edit(`Animate ${label}`, stopwatchCommands([nodeId], [prop], time)); },
    });
  }

  const exprItems = expressionPropMenuItems(nodeId, prop, ctx.nodeIds);
  const expr = trackExpression(mirror, nodeId, prop);
  if (exprItems.length > 0 || expr?.enabled) {
    items.push({ id: 'sep-expr', separator: true });
    items.push(...exprItems);
  }
  const r = trackRef(nodeId, prop);
  if (expr?.enabled && r) {
    items.push({
      id: 'expr-bake',
      label: 'Convert Expression to Keyframes',
      icon: 'keyframe',
      onSelect: () => { void edit('Convert Expression to Keyframes', { type: 'convertExpressionToKeyframes', prop: r.ref, step: 0 }); },
    });
  }

  if (ctx.resetValue !== undefined) {
    const def = ctx.resetValue;
    items.push({ id: 'sep-reset', separator: true });
    items.push({ id: 'reset', label: `Reset ${label}`, icon: 'rotate', onSelect: () => ctx.setValue(def) });
  }

  items.push(...essentialPropMenuItems(nodeId, prop));
  items.push(...pinPropMenuItems(nodeId, prop));
  return items;
}
