import { getTimelineController } from '@core/timeline/TimelineController';
/**
 * PrecompControl (Prompt 10) — the "Precompose" switch + Time Remap, shown for
 * group layers. Precompose: the group's subtree renders to a texture and
 * composites as one unit (group opacity / blend / effects apply to the nested
 * animation). Time Remap: keyframe the nested content's internal time (hold,
 * reverse, speed-ramp) independently of the comp time.
 */

import { Switch } from '@components/Switch';
import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { cn } from '@utils/cn';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { readNodeKind } from '@core/scene/sceneDerive';
import { isPrecomp, setPrecomp } from '@core/scene/precomp';
import styles from './ParentControl.module.css';
import ta from './TextAnimatorControls.module.css';

const REMAP = 'timeRemap';
const LEGACY_REMAP = 'precompTime';

export function TimeRemapRow({ nodeId }: { nodeId: string }): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const animated = defaultAnimation.isAnimated(nodeId, REMAP) || defaultAnimation.isAnimated(nodeId, LEGACY_REMAP);
  const display = animated
    ? (defaultAnimation.sample(nodeId, REMAP, time) ?? defaultAnimation.sample(nodeId, LEGACY_REMAP, time) ?? time)
    : time;

  const onChange = (v: number): void => {
    runAnimEdit('Set time remap', () => defaultAnimation.setKeyframe(nodeId, REMAP, getTimelineController().toLayerTime(nodeId, time), v), `timeRemap:${nodeId}:${time}`);
  };
  const toggle = (): void => {
    if (animated) {
      runAnimEdit('Remove time remap', () => {
        defaultAnimation.removeTrack(nodeId, REMAP);
        defaultAnimation.removeTrack(nodeId, LEGACY_REMAP);
      });
    } else {
      runAnimEdit('Enable time remap', () => defaultAnimation.setKeyframe(nodeId, REMAP, getTimelineController().toLayerTime(nodeId, time), time));
    }
  };

  return (
    <div className={ta.paramRow}>
      <button
        type="button"
        className={cn(ta.stopwatch, animated && ta.stopwatchOn)}
        onClick={toggle}
        aria-pressed={animated}
        aria-label={animated ? 'Remove time remap' : 'Enable time remap'}
        title={animated ? 'Remove time remap' : 'Enable time remap (keyframe the inner time)'}
      >
        <Icon name="keyframe" size={11} />
      </button>
      <span className={ta.paramLabel}>Time Remap</span>
      <ValueField value={display} onChange={onChange} unit="s" precision={2} min={0} disabled={!animated} aria-label="Time remap" />
    </div>
  );
}

export function PrecompControl({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;
  if (readNodeKind(node) !== 'group') return null;

  const on = isPrecomp(node);

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>Precompose</span>
        <Switch
          checked={on}
          onChange={(e) => setPrecomp(nodeId, e.currentTarget.checked)}
          aria-label="Precompose (composite group as one unit)"
        />
      </div>
      {on && <TimeRemapRow nodeId={nodeId} />}
    </>
  );
}

export default PrecompControl;
