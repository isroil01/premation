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
  readPathOpConfig,
  setPathOp,
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
  param,
  label,
  value,
  min,
}: {
  nodeId: string;
  param: PathOpParam;
  label: string;
  value: number;
  min?: number;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const path = pathOpPropPath(param);
  const animated = defaultAnimation.isAnimated(nodeId, path);
  // ONE axis for reads and writes: the canonical keyframe time.
  const layerT = compToKeyframeTime(nodeId, time);
  const display = animated ? defaultAnimation.sample(nodeId, path, layerT) ?? value : value;

  const onChange = (v: number): void => {
    if (animated) {
      runAnimEdit(`Set ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, layerT, v), `pathop:${nodeId}:${path}:${layerT}`);
    } else {
      updatePathOp(nodeId, { [param]: v } as Partial<PathOp>);
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

export function PathOpControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'shape') return null;

  const op = readPathOpConfig(node);
  if (!op) return null; // added via the Shape-Effects menu

  const typeLabel = TYPES.find((t) => t.id === op.type)?.label ?? 'Zig-Zag';
  const items: DropdownItem[] = TYPES.map((t) => ({
    type: 'item',
    id: t.id,
    label: t.label,
    icon: t.id === op.type ? 'check' : undefined,
    onSelect: () => updatePathOp(nodeId, { type: t.id }),
  }));

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.title}>Path Operator</span>
        <button type="button" className={styles.remove} onClick={() => setPathOp(nodeId, null)} aria-label="Remove path operator" title="Remove path operator">
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
        param="amount"
        label={paramLabels(op.type).amount}
        value={op.amount}
        min={paramMin(op.type, 'amount')}
      />
      {paramLabels(op.type).detail && (
        <ParamRow
          nodeId={nodeId}
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
              onChange={(v) => updatePathOp(nodeId, { seed: Math.round(v) })}
              min={0}
              aria-label="Random Seed"
            />
          </div>
        </>
      )}
    </div>
  );
}

export default PathOpControls;
