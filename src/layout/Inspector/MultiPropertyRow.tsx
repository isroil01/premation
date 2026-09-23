/**
 * MultiPropertyRow — ONE animatable numeric property of the SELECTION.
 *
 * This is the row every inspector section reaches for once it has more than
 * a single layer to describe. It composes the pieces that used to be re-wired
 * at each call site — the stopwatch, the keyframe navigator, the reset, the
 * right-click menu — and adds the ones no call site had:
 *
 *   • mixed values across a multi-selection (`—`), with relative drag and
 *     per-layer `+10` / `*2`, every gesture one undo entry (`multiSelection`);
 *   • an `=` toggle that opens the inline expression editor, an error
 *     underline with the message on hover, and a pick-whip on the row;
 *   • the property's modifier chips, when it has a stack;
 *   • the mini keyframe lane, when the panel preference is on;
 *   • the pin mark, when the property is on the Pinned tab.
 *
 * Reads are per node revision (`useNodesRevision`) and the playhead is a
 * scalar subscription, so a scrub on another layer leaves this row alone.
 *
 * Values are shown in DISPLAY units (`meta.displayScale`, e.g. 0..1 stored as
 * 0..100 %) and written back in engine units; the conversion lives in
 * `useMultiPropertyField`, shared with the two/three-field
 * `MultiPropertyPairRow`, so the model beneath never learns about percent
 * signs and the two rows cannot disagree about what a drag means.
 *
 * Inside the Properties panel (`useInspectorHosted`) the row draws the compact
 * inspector layout — label, field, navigator; stopwatch / `=` / whip on hover;
 * reset in the menu. Anywhere else it keeps the default grid.
 */

import { memo, type ReactNode } from 'react';
import { ValueField } from '@components/ValueField';
import { PropertyRow, KeyframeLane, type PropertyRowLayout } from '@components/PropertyRow';
import { PickWhip } from '@components/PickWhip';
import { cn } from '@utils/cn';
import { useActiveCompFps } from '@hooks/useMirror';
import { ExpressionEditor } from '@layout/Motion/ExpressionEditor';
import { type PropertyAccess } from '@core/inspector/multiSelection';
import { useInspectorHosted } from './inspectorSelection';
import { ModifierChips } from './ModifierChips';
import { useMultiPropertyField } from './useMultiPropertyField';
import { useActiveCompDurationSeconds } from './inspectorMirror';
import styles from './MultiPropertyRow.module.css';

export interface MultiPropertyRowProps {
  /** The PRIMARY layer; the selection comes from context. */
  nodeId: string;
  /** Animation prop path (`x`, `strokeWidth`, `effect.fx_1.radius`, …). */
  prop: string;
  /** Display label override (the registry label otherwise). */
  label?: string;
  /** Custom read / static-write for values the property seam cannot see. */
  access?: PropertyAccess;
  /** Extra control inside the value cell, before the field (a rotation dial). */
  before?: ReactNode;
  /**
   * Like `before`, but handed the row's aggregated value and its writer, so a
   * dial can show the number and write through the same multi-selection path.
   */
  renderBefore?: (ctx: { value: number; mixed: boolean; setValue: (display: number) => void }) => ReactNode;
  /** Extra controls after the `=` and the whip — an Unpin button. */
  extraTrailing?: ReactNode;
  /** A second property written with the same value — Linked Scale. */
  linkedProp?: string;
  /** Hide the reset even when the registry allows one. */
  noReset?: boolean;
  /** Draws the row's short name; the full registry name still reaches AT. */
  shortLabel?: boolean;
  /** A hint the caller wants shown ("Essential"). */
  hint?: string;
  compact?: boolean;
  className?: string;
  /**
   * Force a row layout. Omitted → `'inspector'` inside the Properties panel,
   * else whatever `PropertyRowLayoutContext` says.
   */
  layout?: PropertyRowLayout;
}

function MultiPropertyRowInner({
  nodeId,
  prop,
  label: labelOverride,
  access,
  before,
  renderBefore,
  extraTrailing,
  linkedProp,
  noReset = false,
  shortLabel = false,
  hint: hintOverride,
  compact = true,
  className,
  layout: layoutProp,
}: MultiPropertyRowProps): JSX.Element | null {
  const f = useMultiPropertyField(nodeId, prop, { access, linkedProp, label: labelOverride });
  const hosted = useInspectorHosted();
  const fps = useActiveCompFps();
  const duration = useActiveCompDurationSeconds();

  // Single render guard, AFTER every hook.
  if (!f.exists) return null;

  const { label } = f;
  const layout = layoutProp ?? (hosted ? 'inspector' : undefined);
  const displayLabel = shortLabel ? (label.replace(/(Position|Scale|Rotation|Anchor Point)\s*/i, '') || label) : label;
  const hint = hintOverride ?? f.hint;
  const resetVal = noReset ? undefined : f.resetValue;

  const trailing = (
    <>
      <button
        type="button"
        className={cn(styles.exprToggle, f.hasExpr && styles.exprOn, f.exprError && styles.exprErr)}
        // An attached (or open) expression is the row's expression MARK at rest.
        data-persist={f.hasExpr || f.exprOpen || undefined}
        aria-pressed={f.exprOpen}
        aria-label={`${f.exprOpen ? 'Hide' : 'Show'} ${label} expression`}
        title={f.exprError ?? (f.hasExpr ? (f.exprEnabled ? 'Expression on — click to edit' : 'Expression off — click to edit') : 'Add an expression')}
        onClick={(e) => {
          e.stopPropagation();
          f.toggleExpression();
        }}
      >
        =
      </button>
      <PickWhip
        label={`${label} pick-whip — drag onto a layer or property to link`}
        className={styles.whip}
        accept={(target) => !(target.nodeId === nodeId && (target.prop ?? prop) === prop)}
        onPick={f.onWhip}
      />
      {extraTrailing}
    </>
  );

  const below = (f.exprOpen || f.hasStack || f.laneTimes) ? (
    <div className={styles.below}>
      {f.hasStack && <ModifierChips nodeId={nodeId} prop={prop} />}
      {f.exprOpen && (
        <div className={styles.expr}>
          <ExpressionEditor nodeId={nodeId} prop={prop} />
        </div>
      )}
      {f.laneTimes && (
        <KeyframeLane
          times={f.laneTimes}
          duration={duration}
          fps={fps}
          label={label}
          onSeek={f.seek}
          onRetime={f.onLaneRetime}
          onKeyframeContextMenu={f.onLaneContext}
        />
      )}
    </div>
  ) : undefined;

  return (
    <PropertyRow
      label={displayLabel}
      srLabel={label}
      layout={layout}
      animated={f.agg.animated}
      mixed={f.agg.mixed}
      hint={hint}
      pinned={f.pinned}
      error={f.exprError}
      compact={compact}
      className={cn(styles.row, f.exprOpen && styles.rowExprOpen, className)}
      onStopwatch={f.toggleAnimation}
      navigator={f.navigator}
      onReset={resetVal !== undefined ? () => f.writeAll(resetVal * f.scale) : undefined}
      onFocusCapture={f.onFocusCapture}
      onBlurCapture={f.onBlurCapture}
      onContextMenu={f.openMenu}
      trailing={trailing}
      below={below}
    >
      {before}
      {renderBefore?.({ value: f.fieldProps.value, mixed: f.agg.mixed, setValue: f.writeAll })}
      <ValueField {...f.fieldProps} />
    </PropertyRow>
  );
}

export const MultiPropertyRow = memo(MultiPropertyRowInner);
export default MultiPropertyRow;
