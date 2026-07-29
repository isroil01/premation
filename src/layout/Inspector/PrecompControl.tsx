import { compToKeyframeTime } from '@core/timeline/TimelineController';
/**
 * PrecompControl — the "Precompose" switch + Time Remap, shown for
 * group layers. Precompose: the group's subtree renders to a texture and
 * composites as one unit (group opacity / blend / effects apply to the nested
 * animation). Time Remap: keyframe the nested content's internal time (hold,
 * reverse, speed-ramp) independently of the comp time.
 */

import { Switch } from '@components/Switch';

import { ValueField } from '@components/ValueField';

import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { readNodeKind } from '@core/scene/sceneDerive';
import { isPrecomp, setPrecomp, setCompCollapse } from '@core/scene/precomp';
import { readCompCollapse } from '@core/scene/compInstance';
import styles from './ParentControl.module.css';
import ta from './TextAnimatorControls.module.css';
import { Checkbox } from '@components/Checkbox';

const REMAP = 'timeRemap';
const LEGACY_REMAP = 'precompTime';

export function TimeRemapRow({ nodeId }: { nodeId: string }): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const animated = defaultAnimation.isAnimated(nodeId, REMAP) || defaultAnimation.isAnimated(nodeId, LEGACY_REMAP);
  // The remap track's own axis: the renderer samples `timeRemap` at the
  // precomp-CHAIN time (never through this group's clip/stretch), so pass the
  // prop to land reads and writes exactly where buildSnapshot looks.
  const remapT = compToKeyframeTime(nodeId, time, REMAP);
  const display = animated
    ? (defaultAnimation.sample(nodeId, REMAP, remapT) ?? defaultAnimation.sample(nodeId, LEGACY_REMAP, remapT) ?? time)
    : time;

  const onChange = (v: number): void => {
    runAnimEdit('Set time remap', () => defaultAnimation.setKeyframe(nodeId, REMAP, remapT, v), `timeRemap:${nodeId}:${remapT}`);
  };
  const toggle = (): void => {
    if (animated) {
      runAnimEdit('Remove time remap', () => {
        defaultAnimation.removeTrack(nodeId, REMAP);
        defaultAnimation.removeTrack(nodeId, LEGACY_REMAP);
      });
    } else {
      runAnimEdit('Enable time remap', () => defaultAnimation.setKeyframe(nodeId, REMAP, remapT, time));
    }
  };

  return (
    <div className={ta.paramRow}>
      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Checkbox 
            checked={animated} 
            onChange={toggle} 
            title="Toggle Animation"
            style={{ width: 14, height: 14 }}
          />
        </div>
      <span className={ta.paramLabel}>Time Remap</span>
      <ValueField value={display} onChange={onChange} unit="s" precision={2} min={0} disabled={!animated} aria-label="Time remap" />
    </div>
  );
}

export function PrecompControl({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;
  const kind = readNodeKind(node);

  // A placed COMPOSITION (kind 'comp') has no Precompose switch — it is already
  // a composition — but it owns the one switch that decides whether it is a flat
  // card or part of the host's 3D scene. It used to show neither, nor Time
  // Remap, because this component returned null for every kind but 'group'.
  if (kind === 'comp') {
    const collapsed = readCompCollapse(node);
    return (
      <>
        <div className={styles.row}>
          <span className={styles.label}>Collapse Transformations</span>
          <Switch
            checked={collapsed}
            onChange={(e) => setCompCollapse(nodeId, e.currentTarget.checked)}
            aria-label="Collapse Transformations (join the host composition's 3D space)"
          />
        </div>
        <p style={{ margin: '2px 0 6px', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {collapsed
            ? 'This composition’s layers render in the host: they meet its camera, depth sort and lights, and are not cropped to their own frame.'
            : 'This composition renders to its own frame first, then composites as one flat layer — so its 3D layers cannot meet the host’s camera.'}
        </p>
        <TimeRemapRow nodeId={nodeId} />
      </>
    );
  }

  if (kind !== 'group') return null;

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
