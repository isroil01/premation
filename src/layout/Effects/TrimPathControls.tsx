import { ValueField } from '@components/ValueField';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import {
  readTrimConfig,
  setTrim,
  updateTrim,
  defaultTrim,
  trimPropPath,
  type TrimParam,
} from '@core/scene/trimPath';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import styles from './EffectsPanel.module.css';

export function TrimPathControls({ nodeId }: { nodeId: string }): JSX.Element {
  const node = defaultSceneGraph.getNode(nodeId);
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);

  if (!node) return <></>;

  const trim = readTrimConfig(node);

  const renderRow = (paramName: TrimParam, label: string, min: number, max: number, unit: string) => {
    const propName = trimPropPath(paramName);
    const baseVal = trim ? trim[paramName] : (paramName === 'end' ? 100 : 0);
    const animated = defaultAnimation.isAnimated(nodeId, propName);
    const displayVal = animated ? defaultAnimation.sample(nodeId, propName, time) ?? baseVal : baseVal;

    const onChange = (v: number): void => {
      if (animated) {
        runAnimEdit(
          `Set ${label}`,
          () => defaultAnimation.setKeyframe(nodeId, propName, time, v),
          `set:${nodeId}:${propName}:${time}`,
        );
      } else {
        updateTrim(nodeId, { [paramName]: v });
      }
    };

    const toggleAnim = (): void => {
      if (animated) {
        runAnimEdit(`Remove ${label} animation`, () =>
          defaultAnimation.removeTrack(nodeId, propName),
        );
      } else {
        runAnimEdit(`Animate ${label}`, () =>
          defaultAnimation.setKeyframe(nodeId, propName, time, baseVal),
        );
      }
    };

    return (
      <div className={styles.blendRow} key={paramName}>
        <button
          type="button"
          className={cn(styles.stopwatch, animated && styles.stopwatchOn)}
          onClick={toggleAnim}
          title={animated ? 'Remove animation' : 'Animate'}
          aria-label={animated ? `Remove ${label} animation` : `Animate ${label}`}
          aria-pressed={animated}
        >
          <Icon name="keyframe" size={11} />
        </button>
        <span className={styles.blendLabel}>{label}</span>
        <ValueField
          value={displayVal}
          min={min}
          max={max}
          precision={0}
          unit={unit}
          onChange={onChange}
          aria-label={label}
        />
      </div>
    );
  };

  return (
    <>
      <div className={styles.sectionTitle} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Trim paths</span>
        {trim && (
          <button
            type="button"
            className={styles.remove}
            onClick={() => setTrim(nodeId, null)}
            title="Remove Trim Paths"
            style={{ margin: 0, padding: 4 }}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      {!trim ? (
        <div className={styles.addRow} style={{ padding: '4px 0' }}>
          <button
            type="button"
            className={styles.addChip}
            onClick={() => setTrim(nodeId, defaultTrim())}
          >
            <Icon name="plus" size={11} /> Add Trim Paths
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {renderRow('start', 'Start', 0, 100, '%')}
          {renderRow('end', 'End', 0, 100, '%')}
          {renderRow('offset', 'Offset', -360, 360, '%')}
        </div>
      )}
    </>
  );
}

export default TrimPathControls;
