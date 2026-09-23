/**
 * PathOpControls (MG Phase C) — "Path Operator" inspector section for shape
 * layers. Deform the outline with Zig-Zag, Round Corners, Pucker & Bloat or
 * Twist; Amount/Detail are keyframeable (animate Zig-Zag amount for a wobbling
 * squiggle).
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { Dropdown, type DropdownItem } from '@components/Dropdown';

import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { edit } from '@core/engine/uiEdits';
import { paths, values } from '@core/engine/propRefs';
import type { Command } from '@motion/engine-api';
import {
  readPathOps,
  pathOpPropPath,
  pathOpParamSpecs,
  type PathOp,
  type PathOpType,
  type PathOpParam,
} from '@core/scene/pathOps';
import type { RepeaterComposite } from '@core/scene/repeater';
import type { OffsetLineJoin } from '@core/scene/pathOps';
import styles from './TextAnimatorControls.module.css';
import { AnimToggle } from './AnimToggle';
import { InspectorSection } from './InspectorSection';
import { useKeyedParam } from './useKeyedParam';
import { useEngineEdit } from './useEngineEdit';

/** Reorder / remove an operator: the API's property-group commands on `contents/<opId>`. */
function moveOp(nodeId: string, opId: string, toIndex: number): void {
  void edit('Move Path Operator', { type: 'movePropertyGroup', group: { layer: nodeId, path: paths.contents(opId) }, toIndex });
}
function removeOp(nodeId: string, opId: string): void {
  void edit('Remove Path Operator', { type: 'removePropertyGroups', groups: [{ layer: nodeId, path: paths.contents(opId) }] });
}

/**
 * An operator's discrete field — Type, Composite, Line Join, Trim Multiple
 * Shapes, Random Seed — as `setProperty` on `contents/<opId>/<key>` (static
 * fields, shapeFieldSpecs.ts).
 */
function opFieldCommand(nodeId: string, opId: string, key: string, value: string | number): Command {
  return {
    type: 'setProperty',
    prop: { layer: nodeId, path: paths.contents(opId, key) },
    value: typeof value === 'number' ? values.scalar(value) : values.choice(value),
  };
}
function setOpField(label: string, nodeId: string, opId: string, key: string, value: string): void {
  void edit(label, opFieldCommand(nodeId, opId, key, value));
}

const TYPES: { id: PathOpType; label: string }[] = [
  { id: 'zigzag', label: 'Zig-Zag' },
  { id: 'roundCorners', label: 'Round Corners' },
  { id: 'pucker', label: 'Pucker & Bloat' },
  { id: 'twist', label: 'Twist' },
  { id: 'offset', label: 'Offset Paths' },
  // AE's name for this operator. The stored id stays `roughen` so existing
  // projects keep loading — the label is what was wrong, not the data.
  { id: 'roughen', label: 'Wiggle Paths' },
  // Chain-level like Trim and the Repeater: one random affine transform per
  // RUN, so downstream of a Repeater every copy wanders independently. That
  // order sensitivity is the operator's whole point — see applyWiggleTransform.
  { id: 'wiggleTransform', label: 'Wiggle Transform' },
  // Trim is an operator like any other since document version 1.4.0. It had its
  // own inspector section and its own fixed slot after the chain, which made its
  // position unchangeable — and the position is exactly what matters: trimming
  // by arc length cuts a ruffled outline somewhere quite different from where it
  // cuts the smooth one it was built from.
  { id: 'trim', label: 'Trim Paths' },
  // Folded in for the same reason Trim was, and the reason is stronger here.
  // The Repeater applies a per-copy SCALE, and every operator in the chain
  // measures its effect in absolute px — zigzag's amplitude, Round Corners'
  // radius, Offset Path's distance. Scaling before an operator changes the
  // ratio between the two; scaling after it does not. So the position genuinely
  // changes the picture, which a fixed slot after the chain could not express.
  { id: 'repeater', label: 'Repeater' },
];

/** AE's stacking choice. `above` is this renderer's historical behaviour. */
const COMPOSITE: { id: RepeaterComposite; label: string }[] = [
  { id: 'above', label: 'Above' },
  { id: 'below', label: 'Below' },
];

/** Offset Paths' corner treatment — AE's Line Join. Discrete, like Composite:
 *  interpolating a join style has no meaning between the stops. */
const LINE_JOINS: { id: OffsetLineJoin; label: string }[] = [
  { id: 'miter', label: 'Miter' },
  { id: 'round', label: 'Round' },
  { id: 'bevel', label: 'Bevel' },
];

/** AE's "Trim Multiple Shapes". `simultaneously` (AE's default) trims every
 *  path by the same percentages at once; `individually` trims them one after
 *  another, which is what a staggered reveal of several outlines wants. */
const TRIM_MULTIPLE: { id: 'simultaneously' | 'individually'; label: string }[] = [
  { id: 'simultaneously', label: 'Simultaneously' },
  { id: 'individually', label: 'Individually' },
];

/**
 * The lower bound for an operator's parameter.
 *
 * Not every parameter is non-negative: Pucker & Bloat is puckered below zero
 * and bloated above it, and Twist takes signed angles — clamping both to 0 hid
 * half of each operator. Counts (ridges, steps) genuinely can't go negative.
 */
function paramMin(type: PathOpType, param: PathOpParam): number | undefined {
  if (param === 'detail') return 0;
  // Signed amounts: pucker (pucker/bloat), twist (either direction), offset
  // (contract/expand). Sizes and counts stay non-negative.
  return type === 'pucker' || type === 'twist' || type === 'offset' ? undefined : 0;
}

function ParamRow({
  nodeId,
  opId,
  param,
  label,
  value,
  min,
  max,
  step,
  unit,
}: {
  nodeId: string;
  /** Which operator in the chain this row edits. Keyframes are id-scoped. */
  opId: string;
  param: PathOpParam;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}): JSX.Element {
  useSceneRevision((s) => s.rev);
  const path = pathOpPropPath(opId, param);
  // B3: `contents/<opId>/<param>` through the engine API (key at the playhead
  // when animated, else the static value; a drag is one gesture).
  const { animated, display, onChange, toggle, scrub } = useKeyedParam(nodeId, path, label, value);

  return (
    <div className={styles.paramRow}>
      <span className={styles.rowToggle}>
        <AnimToggle nodeId={nodeId} tracks={[path]} label={label} animated={animated} onToggle={toggle} values={() => [display]} />
      </span>
      <span className={styles.paramLabel}>{label}</span>
      <ValueField value={display} onChange={onChange} {...scrub} min={min} max={max} step={step} unit={unit} aria-label={label} />
    </div>
  );
}

/**
 * One operator in the chain.
 *
 * The header carries its POSITION and the move controls, because the order is
 * not cosmetic: Round Corners then Zig-Zag gives soft ridges, the reverse gives
 * rounded spikes. A stack whose order could not be changed would be a list, not
 * a chain.
 */
function PathOpCard({
  nodeId,
  op,
  index,
  count,
}: {
  nodeId: string;
  op: PathOp;
  index: number;
  count: number;
}): JSX.Element {
  const eng = useEngineEdit();
  const typeLabel = TYPES.find((t) => t.id === op.type)?.label ?? 'Zig-Zag';
  // The picker lists the deformers only (Trim and the Repeater have no type
  // picker — see below); the engine's `contents/<opId>/type` takes the same set.
  const items: DropdownItem[] = TYPES.filter((t) => t.id !== 'trim' && t.id !== 'repeater').map((t) => ({
    type: 'item',
    id: t.id,
    label: t.label,
    icon: t.id === op.type ? 'check' : undefined,
    onSelect: () => setOpField('Set Path Operator Type', nodeId, op.id, 'type', t.id),
  }));

  return (
    <InspectorSection
      nested
      title={count > 1 ? `${index + 1}. ${typeLabel}` : typeLabel}
      // The move and remove controls go in the shared actions slot: the
      // inspector has one place a card's controls live, and it is the right end
      // of its title row — the same place the layer styles and shape effects
      // put theirs.
      actions={
        <>
          {index > 0 && (
            <button
              type="button"
              className={styles.remove}
              onClick={() => moveOp(nodeId, op.id, index - 1)}
              aria-label={`Move ${typeLabel} up`}
              title="Move up — operators apply top to bottom"
            >
              <Icon name="chevron-up" size="sm" />
            </button>
          )}
          {index < count - 1 && (
            <button
              type="button"
              className={styles.remove}
              onClick={() => moveOp(nodeId, op.id, index + 1)}
              aria-label={`Move ${typeLabel} down`}
              title="Move down — operators apply top to bottom"
            >
              <Icon name="chevron-down" size="sm" />
            </button>
          )}
          <button
            type="button"
            className={styles.remove}
            onClick={() => removeOp(nodeId, op.id)}
            aria-label={`Remove ${typeLabel}`}
            title="Remove path operator"
          >
            <Icon name="minus" size="sm" />
          </button>
        </>
      }
    >
      {/* No type picker on a Trim or Repeater card. Retyping either into a
          Zig-Zag would silently reinterpret its own parameters as
          amount/detail, and there is no sensible value to carry across — both
          are chosen when added, from the same Add menu as everything else. */}
      {op.type !== 'trim' && op.type !== 'repeater' && (
        <div className={styles.selectorRow}>
          <span className={styles.paramLabel}>Type</span>
          <Dropdown
            placement="left-start"
            trigger={
              <button type="button" className={styles.pick}>
                <span>{typeLabel}</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={items}
          />
        </div>
      )}
      {/* Composite is the Repeater's one DISCRETE parameter, so it is a picker
          rather than a numeric row and carries no stopwatch — interpolating it
          would mean a frame where the copies are halfway between in front of
          and behind the original. */}
      {op.type === 'repeater' && (
        <div className={styles.selectorRow}>
          <span className={styles.paramLabel}>Composite</span>
          <Dropdown
            placement="left-start"
            trigger={
              <button type="button" className={styles.pick}>
                <span>{op.composite === 'below' ? 'Below' : 'Above'}</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={COMPOSITE.map((c) => ({
              type: 'item' as const,
              id: c.id,
              label: c.label,
              icon: (op.composite ?? 'above') === c.id ? 'check' : undefined,
              onSelect: () => setOpField('Set Composite', nodeId, op.id, 'composite', c.id),
            }))}
          />
        </div>
      )}
      {/* Offset Paths' one discrete parameter — a picker without a stopwatch,
          exactly as Composite is for the Repeater. */}
      {op.type === 'offset' && (
        <div className={styles.selectorRow}>
          <span className={styles.paramLabel}>Line Join</span>
          <Dropdown
            placement="left-start"
            trigger={
              <button type="button" className={styles.pick}>
                <span>{LINE_JOINS.find((j) => j.id === (op.lineJoin ?? 'miter'))?.label ?? 'Miter'}</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={LINE_JOINS.map((j) => ({
              type: 'item' as const,
              id: j.id,
              label: j.label,
              icon: (op.lineJoin ?? 'miter') === j.id ? 'check' : undefined,
              onSelect: () => setOpField('Set Line Join', nodeId, op.id, 'lineJoin', j.id),
            }))}
          />
        </div>
      )}
      {op.type === 'trim' && (
        <div className={styles.selectorRow}>
          <span className={styles.paramLabel}>Multiple</span>
          <Dropdown
            placement="left-start"
            trigger={
              <button type="button" className={styles.pick}>
                <span>{op.trimMultipleShapes === 'individually' ? 'Individually' : 'Simultaneously'}</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={TRIM_MULTIPLE.map((c) => ({
              type: 'item' as const,
              id: c.id,
              label: c.label,
              // Same fallback as the label above and `readPathOps`: absent is
              // Simultaneously, so the checkmark and the trigger always agree.
              icon: (op.trimMultipleShapes ?? 'simultaneously') === c.id ? 'check' : undefined,
              onSelect: () => setOpField('Set Trim Multiple Shapes', nodeId, op.id, 'trimMultipleShapes', c.id),
            }))}
          />
        </div>
      )}
      {pathOpParamSpecs(op.type).map((row) => (
        <ParamRow
          key={row.param}
          nodeId={nodeId}
          opId={op.id}
          param={row.param}
          label={row.label}
          value={(op[row.param] ?? 0) as number}
          min={row.min ?? (row.signed ? undefined : row.unit === '%' ? -100 : paramMin(op.type, row.param))}
          max={row.max ?? (row.unit === '%' ? 200 : undefined)}
          step={row.step}
          unit={row.unit}
        />
      ))}
      {/* The two temporal operators share these rows: the others are a pure
          function of the outline, so a wiggle rate would be a dead control on
          them. Correlation answers the same question at different granularity —
          Roughen: how alike neighbouring POINTS move; Wiggle Transform: how
          alike the RUNS (repeater copies) move. */}
      {(op.type === 'roughen' || op.type === 'wiggleTransform') && (
        <>
          <ParamRow
            nodeId={nodeId}
            opId={op.id}
            param="wigglesPerSecond"
            label="Wiggles/Second"
            value={op.wigglesPerSecond ?? 0}
            min={0}
          />
          {/*
            Correlation is what makes this operator AE's Wiggle Paths rather
            than AE's Roughen: how alike NEIGHBOURING points move. 0 shreds the
            outline — and is the pre-existing behaviour, so stored projects are
            unchanged — while higher values make it undulate like something with
            stiffness. It was the one defining parameter the operator lacked
            while already carrying the name.
          */}
          <ParamRow
            nodeId={nodeId}
            opId={op.id}
            param="correlation"
            label="Correlation"
            value={op.correlation ?? 0}
            min={0}
            max={100}
            unit="%"
          />
          <div className={styles.paramRow}>
            {/* An empty gutter, not a missing one: the seed cannot be animated,
                but its label must still start on the same column as the two
                rows above it. */}
            <span className={styles.rowToggle} />
            <span className={styles.paramLabel}>Random Seed</span>
            <ValueField
              value={op.seed ?? 0}
              {...eng.scrub('Set Random Seed')}
              onChange={(v) => eng.send('Set Random Seed', opFieldCommand(nodeId, op.id, 'seed', Math.max(0, Math.round(v))))}
              min={0}
              aria-label="Random Seed"
            />
          </div>
        </>
      )}
    </InspectorSection>
  );
}

export function PathOpControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'shape') return null;

  const ops = readPathOps(node);
  if (ops.length === 0) return null; // added via Effects & Presets

  // Rendered top-to-bottom in APPLICATION order, so the panel reads the way the
  // geometry evaluates. Keyed by operator id rather than index, or React reuses
  // a card's state across a reorder and the wrong parameters animate.
  return (
    <>
      {ops.map((op, i) => (
        <PathOpCard key={op.id} nodeId={nodeId} op={op} index={i} count={ops.length} />
      ))}
    </>
  );
}

export default PathOpControls;
