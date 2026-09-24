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
 * The expression and Pin entries read the document MIRROR (B4): whether this
 * member carries an expression (`memberExpressionOf`), whether the property is
 * pinned (`LayerInfo.pinned`); Add / Remove Expression are `setExpression`
 * commands like the row's own `=` toggle. The Essential Properties entry is
 * the shared builder (B4-gap below).
 */

import type { ContextMenuItem } from '@stores/contextMenuStore';
import { copyKeyframeAt, hasClipboard } from '@core/animation/keyframeClipboard';
import { formatChord } from '@core/commands/formatChord';
import type { KeyChord } from '@app-types/common';
import { documentMirror } from '@stores/documentMirror';
import { isTrackAnimated, navigatorFor, trackRef as mirrorTrackRef, type MirrorRead } from '@core/mirror/selection';
import { memberExpressionOf } from '@core/mirror/memberExpressions';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { edit } from '@core/engine/uiEdits';
import { essentialPropMenuItems } from '@core/inspector/propertyMenu';
import { setPinnedProp } from '@core/inspector/pinnedProps';
import { DEFAULT_EXPRESSION, requestExpressionEditor } from '@core/animation/expressionCommands';
import { easeKeysAtCommands, expressionCommands, keyToggleCommands, stopwatchCommands, trackRef, type EasePreset } from './inspectorEdits';
import { pasteKeyframesAt } from '@layout/Timeline/keyframeEdits';

const EASING_PRESETS: ReadonlyArray<{ id: EasePreset; label: string; chord?: KeyChord }> = [
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

/** The expression THIS member track carries (one dimension of an unseparated vector has its own), from the mirror. */
function memberExpression(m: MirrorRead, nodeId: string, prop: string): { source: string; enabled: boolean } | null {
  const r = mirrorTrackRef(m, nodeId, prop);
  return r ? memberExpressionOf(r.info, r.member) : null;
}

/**
 * Add Expression (AE's default `value`, one undo step, then the editor opens) /
 * Edit / Remove Expression — the engine-API form of `expressionPropMenuItems`.
 */
function expressionItems(m: MirrorRead, nodeId: string, prop: string, nodeIds: ReadonlyArray<string>): ContextMenuItem[] {
  if (!m.layer(nodeId)) return [];
  const ids = nodeIds.length > 0 ? nodeIds : [nodeId];
  if (!memberExpression(m, nodeId, prop)) {
    return [{
      id: 'expr-add',
      label: 'Add Expression',
      onSelect: () => {
        const cmds = expressionCommands(ids.filter((id) => !memberExpression(documentMirror(), id, prop)).map((id) => ({ nodeId: id, track: prop, source: DEFAULT_EXPRESSION })));
        if (!cmds || cmds.length === 0) return;
        void edit(cmds.length === 1 ? 'Add Expression' : 'Add Expressions', cmds).then((r) => {
          if (r.ok) requestExpressionEditor({ nodeId, prop });
        });
      },
    }];
  }
  return [
    { id: 'expr-edit', label: 'Edit Expression', onSelect: () => { requestExpressionEditor({ nodeId, prop }); } },
    {
      id: 'expr-remove',
      label: 'Remove Expression',
      danger: true,
      onSelect: () => {
        const had = ids.filter((id) => memberExpression(documentMirror(), id, prop) !== null);
        const cmds = expressionCommands(had.map((id) => ({ nodeId: id, track: prop, source: '' })));
        if (cmds && cmds.length > 0) void edit(cmds.length === 1 ? 'Remove Expression' : 'Remove Expressions', cmds);
      },
    },
  ];
}

/** "Pin / Unpin" — pinned from the mirror's `LayerInfo.pinned`. */
function pinItems(m: MirrorRead, nodeId: string, prop: string): ContextMenuItem[] {
  const layer = m.layer(nodeId);
  if (!layer) return [];
  const pinned = layer.pinned.includes(prop);
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
        // B4-gap: the keyframe clipboard captures the TS keyframe records (stored-axis time, si/so, roving) — the copy has no mirror twin yet (shared with the timeline's Ctrl+C).
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

  const exprItems = expressionItems(mirror, nodeId, prop, ctx.nodeIds);
  const expr = memberExpression(mirror, nodeId, prop);
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

  // B4-gap: a composition's Essential Properties list (`__essentialProps` on the comp root) — no API datum (CompInfo has none).
  items.push(...essentialPropMenuItems(nodeId, prop));
  items.push(...pinItems(mirror, nodeId, prop));
  return items;
}
