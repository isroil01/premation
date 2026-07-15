import { getTimelineController } from '@core/timeline/TimelineController';
/**
 * TrimPathControls (MG Phase C) — "Trim Paths" inspector section for shape
 * layers. Reveal a portion of the outline stroke; every param is keyframeable
 * (keyframe End 0→100 to write the stroke on; keyframe Offset for a chase).
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
  readTrimConfig,
  setTrim,
  updateTrim,
  trimPropPath,
  type TrimPath,
  type TrimParam,
} from '@core/scene/trimPath';
import styles from './TextAnimatorControls.module.css';

function ParamRow({
  nodeId,
  param,
  label,
  value,
}: {
  nodeId: string;
  param: TrimParam;
  label: string;
  value: number;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const path = trimPropPath(param);
  const animated = defaultAnimation.isAnimated(nodeId, path);
  const display = animated ? defaultAnimation.sample(nodeId, path, time) ?? value : value;

  const onChange = (v: number): void => {
    if (animated) {
      runAnimEdit(`Set ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, getTimelineController().toLayerTime(nodeId, time), v), `trim:${nodeId}:${path}:${time}`);
    } else {
      updateTrim(nodeId, { [param]: v } as Partial<TrimPath>);
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
      >
        <Icon name="keyframe" size={11} />
      </button>
      <span className={styles.paramLabel}>{label}</span>
      <ValueField value={display} onChange={onChange} unit="%" min={-100} max={200} aria-label={label} />
    </div>
  );
}

export function TrimPathControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'shape') return null;

  const trim = readTrimConfig(node);
  if (!trim) return null; // added via the Shape-Effects menu

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.title}>Trim Paths</span>
        <button type="button" className={styles.remove} onClick={() => setTrim(nodeId, null)} aria-label="Remove trim path" title="Remove trim path">
          <Icon name="minus" size={12} />
        </button>
      </div>
      <ParamRow nodeId={nodeId} param="start" label="Start" value={trim.start} />
      <ParamRow nodeId={nodeId} param="end" label="End" value={trim.end} />
      <ParamRow nodeId={nodeId} param="offset" label="Offset" value={trim.offset} />
    </div>
  );
}

export default TrimPathControls;
