/**
 * MultiPropertyPairRow — two or three numeric properties of the SELECTION on
 * ONE row: `Position [X 960] [Y 540]`.
 *
 * Why it exists: the inspector drew X and Y as two full rows each with its own
 * stopwatch, navigator and reset, under an uppercase subhead with a THIRD
 * stopwatch for the group. At the default 280px panel the "X" / "Y" names were
 * truncated and Position, Scale and Size already scrolled. A pair row reads
 * like the design tools people know (Figma, Framer) and keeps every AE power:
 *
 *   • each field is a full multi-selection field (`useMultiPropertyField`) —
 *     `—` when mixed, relative drag, `+10` per layer, one undo per gesture,
 *     its own display unit (px / %) through `displayContext`;
 *   • right-click on a field opens THAT property's menu (keyframes, easing,
 *     expressions, reset, pin); right-click on the label lists every member;
 *   • one group stopwatch and one merged navigator for the row;
 *   • a field's expression editor opens under the row, via the same request
 *     plumbing the single row answers, so "Edit Expression" works on either.
 *
 * Hooks: the field hook is called exactly THREE times whatever `props` holds.
 * Position gains its Z field when a layer turns 3D; a hook per prop would
 * change the hook count between renders and crash the panel. Unused slots are
 * inert (`enabled: false`).
 */

import { Fragment, memo, type ReactNode } from 'react';
import { ValueField } from '@components/ValueField';
import { ValueFieldDisplayContext, type ValueFieldDisplay } from '@components/ValueField/ValueField';
import { PropertyRow, KeyframeLane } from '@components/PropertyRow';
import { PickWhip } from '@components/PickWhip';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { whipExpression } from '@core/whip/whipTarget';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { openContextMenu } from '@stores/contextMenuStore';
import { useCompositionStore } from '@stores/compositionStore';
import { ExpressionEditor } from '@layout/Motion/ExpressionEditor';
import { ModifierChips } from './ModifierChips';
import { edit } from '@core/engine/uiEdits';
import { expressionCommands, moveKeysCommands } from './inspectorEdits';
import {
  groupNavigatorState,
  legacyExpressions,
  toggleAnimationGroupEach,
  toggleKeyframeGroup,
  useMultiPropertyField,
  type MultiPropertyField,
} from './useMultiPropertyField';
import rowStyles from './MultiPropertyRow.module.css';
import styles from './MultiPropertyPairRow.module.css';

export interface PairFieldSpec {
  /** Animation prop path. */
  prop: string;
  /** The axis tag drawn inside the field ("X", "W"). */
  prefix: string;
  /** Per-prop read / static write (Transform's `accessFor`). */
  access?: PropertyAccess;
  /** Show THIS field in another unit (Position as % of the comp). */
  displayContext?: ValueFieldDisplay | null;
}

export interface MultiPropertyPairRowProps {
  /** The PRIMARY layer; the selection comes from context. */
  nodeId: string;
  /** What the row shows ("Position"). */
  label: string;
  /** The group's full name for AT and history ("Anchor Point"). Defaults to `label`. */
  srLabel?: string;
  /** Two or three fields, in order. */
  props: ReadonlyArray<PairFieldSpec>;
  /**
   * A link toggle drawn between the first two fields — Linked Scale. While on
   * (and the row has exactly two fields) a write to either field writes both.
   */
  linked?: { value: boolean; onToggle: () => void; label: string };
  /** Controls after the fields, inside the value cell (the anchor preset button). */
  after?: ReactNode;
  /** Extra hover controls in the label cell (the px / % switch). */
  trailing?: ReactNode;
  className?: string;
}

interface Slot {
  spec: PairFieldSpec;
  field: MultiPropertyField;
}

const NO_PROPS: ReadonlyArray<PairFieldSpec> = [];
const SAME_TIME = 1e-6;

/** Wrap one field in its own display unit — or leave it as-is. */
function withDisplay(display: ValueFieldDisplay | null | undefined, el: JSX.Element): JSX.Element {
  return display ? <ValueFieldDisplayContext.Provider value={display}>{el}</ValueFieldDisplayContext.Provider> : el;
}

function MultiPropertyPairRowInner({
  nodeId,
  label,
  srLabel,
  props = NO_PROPS,
  linked,
  after,
  trailing,
  className,
}: MultiPropertyPairRowProps): JSX.Element | null {
  const s0 = props[0];
  const s1 = props[1];
  const s2 = props[2];
  const linkOn = linked?.value === true && s0 !== undefined && s1 !== undefined && s2 === undefined;
  const fallbackProp = s0?.prop ?? '';
  const f0 = useMultiPropertyField(nodeId, fallbackProp, {
    access: s0?.access,
    linkedProp: linkOn ? s1?.prop : undefined,
    enabled: s0 !== undefined,
  });
  const f1 = useMultiPropertyField(nodeId, s1?.prop ?? fallbackProp, {
    access: s1?.access,
    linkedProp: linkOn ? s0?.prop : undefined,
    enabled: s1 !== undefined,
  });
  const f2 = useMultiPropertyField(nodeId, s2?.prop ?? fallbackProp, {
    access: s2?.access,
    enabled: s2 !== undefined,
  });
  const fps = useCompositionStore((c) => c.fps) || 30;
  const duration = useCompositionStore((c) => c.durationSeconds) || 0;

  const slots: Slot[] = [];
  if (s0) slots.push({ spec: s0, field: f0 });
  if (s1) slots.push({ spec: s1, field: f1 });
  if (s2) slots.push({ spec: s2, field: f2 });

  // Single render guard, AFTER every hook.
  const primary = slots[0];
  if (!primary || !primary.field.exists) return null;

  const group = srLabel ?? label;
  const { nodeIds, time, seek } = primary.field;
  const memberProps = slots.map((s) => s.spec.prop);
  const members = slots.map((s) => ({ prop: s.spec.prop, access: s.spec.access }));
  const animated = slots.some((s) => s.field.agg.animated);
  const nav = groupNavigatorState(nodeIds, memberProps, time);
  const withExpr = slots.filter((s) => s.field.hasExpr);
  const anyOpen = slots.some((s) => s.field.exprOpen);
  const error = slots.map((s) => s.field.exprError).find((e) => e) ?? null;

  const onWhip = (target: { nodeId: string; prop?: string }): void => {
    const name = defaultSceneGraph.getNode(target.nodeId)?.name;
    if (!name) return;
    // ONE undo step for the whole row. A drop on a layer links each member to
    // the same-named property there; a drop on a property links every member
    // to that one property.
    const list = memberProps.flatMap((p) => nodeIds.map((id) => ({ nodeId: id, prop: p, src: whipExpression(name, target.prop ?? p) })));
    const cmds = expressionCommands(list.map((x) => ({ nodeId: x.nodeId, track: x.prop, source: x.src })));
    if (cmds) void edit(`Link ${group}`, cmds);
    else legacyExpressions(`Link ${group}`, list);
    for (const s of slots) s.field.setExprOpen(true);
  };

  const trayControls = (
    <>
      {/* The expression MARK: only when a member has one — adding goes through a
          field's right-click, which knows WHICH member is meant. */}
      {withExpr.length > 0 && (
        <button
          type="button"
          className={cn(rowStyles.exprToggle, rowStyles.exprOn, error && rowStyles.exprErr)}
          data-persist
          aria-pressed={anyOpen}
          aria-label={`${anyOpen ? 'Hide' : 'Show'} ${group} expressions`}
          title={error ?? `${withExpr.map((s) => s.field.label).join(', ')} — click to ${anyOpen ? 'hide' : 'edit'}`}
          onClick={(e) => {
            e.stopPropagation();
            for (const s of withExpr) s.field.setExprOpen(!anyOpen);
          }}
        >
          =
        </button>
      )}
      <PickWhip
        label={`${group} pick-whip — drag onto a layer or property to link`}
        className={rowStyles.whip}
        accept={(t) => !(t.nodeId === nodeId && (t.prop === undefined || memberProps.includes(t.prop)))}
        onPick={onWhip}
      />
      {trailing}
    </>
  );

  // The lane shows the UNION of the members' keyframe times on the comp axis.
  const laneOwners = slots.filter((s) => s.field.laneTimes !== null);
  const laneTimes = laneOwners.length > 0
    ? laneOwners
      .flatMap((s) => s.field.laneTimes ?? [])
      .sort((a, b) => a - b)
      .filter((t, i, all) => i === 0 || Math.abs(t - (all[i - 1] ?? t)) > SAME_TIME)
    : null;
  const ownsTime = (s: Slot, compT: number): boolean =>
    (s.field.laneTimes ?? []).some((t) => Math.abs(t - compT) <= SAME_TIME);

  const onLaneRetime = (fromC: number, toC: number): void => {
    const owners = laneOwners.filter((s) => ownsTime(s, fromC)).map((s) => s.spec.prop);
    void moveKeysCommands(nodeId, owners, fromC, toC).then((cmds) => edit(`Move ${group} keyframe`, cmds));
  };

  const stacks = slots.filter((s) => s.field.hasStack);
  const editors = slots.filter((s) => s.field.exprOpen);
  const below = (editors.length > 0 || stacks.length > 0 || laneTimes) ? (
    <div className={rowStyles.below}>
      {stacks.map((s) => <ModifierChips key={`chips-${s.spec.prop}`} nodeId={nodeId} prop={s.spec.prop} />)}
      {editors.map((s) => (
        <div key={`expr-${s.spec.prop}`} className={rowStyles.expr}>
          {editors.length > 1 && <span className={styles.exprCaption}>{s.field.label}</span>}
          <ExpressionEditor nodeId={nodeId} prop={s.spec.prop} />
        </div>
      ))}
      {laneTimes && (
        <KeyframeLane
          times={laneTimes}
          duration={duration}
          fps={fps}
          label={group}
          onSeek={seek}
          onRetime={onLaneRetime}
          onKeyframeContextMenu={(e, compT) => (slots.find((s) => ownsTime(s, compT)) ?? primary).field.onLaneContext(e, compT)}
        />
      )}
    </div>
  ) : undefined;

  return (
    <PropertyRow
      label={label}
      srLabel={group}
      layout="inspector"
      animated={animated}
      mixed={slots.some((s) => s.field.agg.mixed)}
      hint={primary.field.hint}
      pinned={slots.some((s) => s.field.pinned)}
      error={error}
      compact
      className={cn(rowStyles.row, anyOpen && rowStyles.rowExprOpen, styles.pairRow, className)}
      onStopwatch={() => toggleAnimationGroupEach(nodeIds, members, time, group)}
      navigator={{
        hasPrev: nav.hasPrev,
        hasNext: nav.hasNext,
        atKeyframe: nav.atKeyframe,
        onPrev: () => { if (nav.prevT !== null) seek(nav.prevT); },
        onNext: () => { if (nav.nextT !== null) seek(nav.nextT); },
        onToggleKeyframe: () => toggleKeyframeGroup(nodeIds, members, time, group),
      }}
      // The label (anywhere outside a field): every member's menu, by name.
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(
          e.clientX,
          e.clientY,
          slots.map((s) => ({ id: `member-${s.spec.prop}`, label: s.field.label, children: s.field.menuItems() })),
        );
      }}
      trailing={trayControls}
      below={below}
    >
      {slots.map((s, i) => (
        <Fragment key={s.spec.prop}>
          {i === 1 && linked && (
            <button
              type="button"
              className={styles.link}
              data-on={linked.value || undefined}
              aria-pressed={linked.value}
              aria-label={`${linked.value ? 'Unlink' : 'Link'} ${linked.label}`}
              title={`${linked.value ? 'Unlink' : 'Link'} ${linked.label}`}
              onClick={(e) => {
                e.stopPropagation();
                linked.onToggle();
              }}
            >
              <Icon name="link" size="sm" />
            </button>
          )}
          {/* `data-numeric` marks the slot as the row's field cell, so the
              shared values grid sizes it like any field. */}
          <div
            className={styles.slot}
            data-numeric
            // A field's SHARE follows its number. Equal thirds gave "960" as
            // much room as "-2179.1", so a camera's Z read "-217" while X and Y
            // sat half empty beside it. Digits are tabular, so length is width.
            style={slots.length > 2 ? { flexGrow: fieldWeight(s.field.fieldProps.value) } : undefined}
            onContextMenu={(e) => {
              e.stopPropagation();
              s.field.openMenu(e);
            }}
            onFocusCapture={s.field.onFocusCapture}
            onBlurCapture={s.field.onBlurCapture}
          >
            {/* No per-field unit: two "px" suffixes cost a pair ~24px of a cell
                that has none to spare. A field shown in another unit still
                says so — the display context supplies its own `%`. */}
            {withDisplay(s.spec.displayContext, <ValueField {...s.field.fieldProps} unit={undefined} prefix={s.spec.prefix} />)}
          </div>
        </Fragment>
      ))}
      {after}
    </PropertyRow>
  );
}

/** Flex weight for a triple's field: its character count, within sane bounds. */
export function fieldWeight(value: unknown): number {
  const n = typeof value === 'number' ? String(Math.round(value * 10) / 10).length : String(value ?? '').length;
  return Math.min(9, Math.max(4, n + 1)); // +1 for the axis prefix
}

export const MultiPropertyPairRow = memo(MultiPropertyPairRowInner);
export default MultiPropertyPairRow;
