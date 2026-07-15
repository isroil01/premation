import { getTimelineController } from '@core/timeline/TimelineController';
/**
 * RepeaterControls (MG Phase C) — the "Repeater" inspector section for shape
 * layers. Add a repeater to fan a shape into N copies; every parameter is
 * keyframeable (stopwatch → keyframes under rep.<param>) so the whole pattern
 * can animate. buildSnapshot reads the resolved values and emits the copies.
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { cn } from '@utils/cn';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { readNodeKind } from '@core/scene/sceneDerive';
import {
  readRepeaterConfig,
  setRepeater,
  updateRepeater,
  repeaterPropPath,
  type Repeater,
  type RepeaterParam,
} from '@core/scene/repeater';
import styles from './TextAnimatorControls.module.css';

function ParamRow({
  nodeId,
  param,
  label,
  value,
  unit,
  min,
  max,
  step,
}: {
  nodeId: string;
  param: RepeaterParam;
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const path = repeaterPropPath(param);
  const animated = defaultAnimation.isAnimated(nodeId, path);
  const display = animated ? defaultAnimation.sample(nodeId, path, time) ?? value : value;

  const onChange = (v: number): void => {
    if (animated) {
      runAnimEdit(`Set ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, getTimelineController().toLayerTime(nodeId, time), v), `rep:${nodeId}:${path}:${time}`);
    } else {
      updateRepeater(nodeId, { [param]: v } as Partial<Repeater>);
    }
  };
  const toggle = (): void => {
    if (animated) runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, path));
    else runAnimEdit(`Animate ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, getTimelineController().toLayerTime(nodeId, time), value));
  };

  return (
    <div className={styles.paramRow}>
      <button
        type="button"
        className={cn(styles.stopwatch, animated && styles.stopwatchOn)}
        onClick={toggle}
        aria-pressed={animated}
        aria-label={animated ? `Remove ${label} animation` : `Animate ${label}`}
        title={animated ? 'Remove animation' : 'Animate (add keyframes)'}
      >
        <Icon name="keyframe" size={11} />
      </button>
      <span className={styles.paramLabel}>{label}</span>
      <ValueField value={display} onChange={onChange} unit={unit} min={min} max={max} step={step} aria-label={label} />
    </div>
  );
}

export function RepeaterControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  // Repeaters make sense for drawable layers (shapes/text/images), not structural ones.
  const kind = readNodeKind(node);
  if (kind === 'group' || kind === 'null' || kind === 'camera' || kind === 'light' || kind === 'audio') return null;

  const rep = readRepeaterConfig(node);
  // Adding is handled by the single Shape-Effects menu; this renders only when
  // the effect is present (no per-effect "Add" button → no duplication).
  if (!rep) return null;

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.title}>Repeater</span>
        <button type="button" className={styles.remove} onClick={() => setRepeater(nodeId, null)} aria-label="Remove repeater" title="Remove repeater">
          <Icon name="minus" size={12} />
        </button>
      </div>
      <ParamRow nodeId={nodeId} param="copies" label="Copies" value={rep.copies} min={1} max={200} step={1} />
      <ParamRow nodeId={nodeId} param="offsetX" label="Position X" value={rep.offsetX} unit="px" />
      <ParamRow nodeId={nodeId} param="offsetY" label="Position Y" value={rep.offsetY} unit="px" />
      <ParamRow nodeId={nodeId} param="offsetRotation" label="Rotation" value={rep.offsetRotation} unit="°" />
      <ParamRow nodeId={nodeId} param="offsetScale" label="Scale" value={rep.offsetScale} step={0.02} min={0} />
      <ParamRow nodeId={nodeId} param="offsetOpacity" label="Opacity" value={rep.offsetOpacity} step={0.02} min={0} max={1} />
    </div>
  );
}

export default RepeaterControls;
