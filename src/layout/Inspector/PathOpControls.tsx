import { compToKeyframeTime } from '@core/timeline/TimelineController';
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
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { readNodeKind } from '@core/scene/sceneDerive';
import {
  readPathOps,
  removePathOp,
  reorderPathOp,
  updatePathOp,
  pathOpPropPath,
  type PathOp,
  type PathOpType,
  type PathOpParam,
} from '@core/scene/pathOps';
import styles from './TextAnimatorControls.module.css';
import { Checkbox } from '@components/Checkbox';

const TYPES: { id: PathOpType; label: string }[] = [
  { id: 'zigzag', label: 'Zig-Zag' },
  { id: 'roundCorners', label: 'Round Corners' },
  { id: 'pucker', label: 'Pucker & Bloat' },
  { id: 'twist', label: 'Twist' },
  { id: 'offset', label: 'Offset Paths' },
  // AE's name for this operator. The stored id stays `roughen` so existing
  // projects keep loading — the label is what was wrong, not the data.
  { id: 'roughen', label: 'Wiggle Paths' },
];

/** Per-operator labels for the two numeric params (detail is unused by some). */
function paramLabels(type: PathOpType): { amount: string; detail: string | null } {
  switch (type) {
    case 'roundCorners':
      return { amount: 'Radius', detail: 'Steps' };
    case 'pucker':
      return { amount: 'Amount', detail: null };
    case 'twist':
      return { amount: 'Angle', detail: null };
    case 'offset':
      return { amount: 'Offset', detail: null };
    case 'roughen':
      return { amount: 'Size', detail: 'Detail' };
    default:
      return { amount: 'Amount', detail: 'Ridges' };
  }
}

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
}: {
  nodeId: string;
  /** Which operator in the chain this row edits. Keyframes are id-scoped. */
  opId: string;
  param: PathOpParam;
  label: string;
  value: number;
  min?: number;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const path = pathOpPropPath(opId, param);
  const animated = defaultAnimation.isAnimated(nodeId, path);
  // ONE axis for reads and writes: the canonical keyframe time.
  const layerT = compToKeyframeTime(nodeId, time);
  const display = animated ? defaultAnimation.sample(nodeId, path, layerT) ?? value : value;

  const onChange = (v: number): void => {
    if (animated) {
      runAnimEdit(`Set ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, layerT, v), `pathop:${nodeId}:${path}:${layerT}`);
    } else {
      updatePathOp(nodeId, opId, { [param]: v } as Partial<PathOp>);
    }
  };
  const toggle = (): void => {
    if (animated) runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, path));
    else runAnimEdit(`Animate ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, layerT, value));
  };

  return (
    <div className={styles.paramRow}>
      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Checkbox 
            checked={animated} 
            onChange={toggle} 
            title="Toggle Animation"
            style={{ width: 14, height: 14 }}
          />
        </div>
      <span className={styles.paramLabel}>{label}</span>
      <ValueField value={display} onChange={onChange} min={min} aria-label={label} />
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
  const typeLabel = TYPES.find((t) => t.id === op.type)?.label ?? 'Zig-Zag';
  const items: DropdownItem[] = TYPES.map((t) => ({
    type: 'item',
    id: t.id,
    label: t.label,
    icon: t.id === op.type ? 'check' : undefined,
    onSelect: () => updatePathOp(nodeId, op.id, { type: t.id }),
  }));

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.title}>
          {count > 1 ? `${index + 1}. ${typeLabel}` : 'Path Operator'}
        </span>
        {index > 0 && (
          <button
            type="button"
            className={styles.remove}
            onClick={() => reorderPathOp(nodeId, op.id, index - 1)}
            aria-label={`Move ${typeLabel} up`}
            title="Move up — operators apply top to bottom"
          >
            <Icon name="chevron-up" size={12} />
          </button>
        )}
        {index < count - 1 && (
          <button
            type="button"
            className={styles.remove}
            onClick={() => reorderPathOp(nodeId, op.id, index + 1)}
            aria-label={`Move ${typeLabel} down`}
            title="Move down — operators apply top to bottom"
          >
            <Icon name="chevron-down" size={12} />
          </button>
        )}
        <button
          type="button"
          className={styles.remove}
          onClick={() => removePathOp(nodeId, op.id)}
          aria-label={`Remove ${typeLabel}`}
          title="Remove path operator"
        >
          <Icon name="minus" size={12} />
        </button>
      </div>
      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>Type</span>
        <Dropdown
          placement="left-start"
          trigger={
            <button type="button" className={styles.pick}>
              <span>{typeLabel}</span>
              <Icon name="chevron-down" size={11} />
            </button>
          }
          items={items}
        />
      </div>
      <ParamRow
        nodeId={nodeId}
        opId={op.id}
        param="amount"
        label={paramLabels(op.type).amount}
        value={op.amount}
        min={paramMin(op.type, 'amount')}
      />
      {paramLabels(op.type).detail && (
        <ParamRow
          nodeId={nodeId}
          opId={op.id}
          param="detail"
          label={paramLabels(op.type).detail!}
          value={op.detail}
          min={paramMin(op.type, 'detail')}
        />
      )}
      {/* Roughen is the only temporal operator: the others are a pure function
          of the outline, so a wiggle rate would be a dead control on them. */}
      {op.type === 'roughen' && (
        <>
          <ParamRow
            nodeId={nodeId}
            opId={op.id}
            param="wigglesPerSecond"
            label="Wiggles/Second"
            value={op.wigglesPerSecond ?? 0}
            min={0}
          />
          <div className={styles.paramRow}>
            <div />
            <span className={styles.paramLabel}>Random Seed</span>
            <ValueField
              value={op.seed ?? 0}
              onChange={(v) => updatePathOp(nodeId, op.id, { seed: Math.round(v) })}
              min={0}
              aria-label="Random Seed"
            />
          </div>
        </>
      )}
    </div>
  );
}

export function PathOpControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'shape') return null;

  const ops = readPathOps(node);
  if (ops.length === 0) return null; // added via the Shape-Effects menu

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
