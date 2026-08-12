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
import { readContinuousRaster, setContinuousRaster, supportsContinuousRaster } from '@core/scene/continuousRaster';
import { readCompCollapse } from '@core/scene/compInstance';
import { CompOverridesSection } from './CompOverridesSection';
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
        <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {collapsed
            ? 'This composition’s layers render in the host: they meet its camera, depth sort and lights, and are not cropped to their own frame.'
            : 'This composition renders to its own frame first, then composites as one flat layer — so its 3D layers cannot meet the host’s camera.'}
        </p>
        <TimeRemapRow nodeId={nodeId} />
        <CompOverridesSection nodeId={nodeId} />
      </>
    );
  }

  /*
    Continuous Rasterization shares AE's sunburst column with Collapse
    Transformations: on a placed composition that switch means Collapse (above),
    on a vector layer it means CR. Same control position, one meaning per layer
    type — so this sits in the same component rather than a separate panel, and
    the two cases cannot both appear for one layer.

    Offered only where it can do something: text, SVG and shapes with real
    geometry. A bitmap cannot be re-rasterized sharper than it was shot, and a
    flat solid has no edge to sharpen, so a switch there would cost memory and
    change nothing.
  */
  if (supportsContinuousRaster(node)) {
    const cr = readContinuousRaster(node);
    return (
      <>
        <div className={styles.row}>
          <span className={styles.label}>Continuous Rasterization</span>
          <Switch
            checked={cr}
            onChange={(e) => setContinuousRaster(nodeId, e.currentTarget.checked)}
            aria-label="Continuous Rasterization (re-render vector content at the scale it is drawn)"
          />
        </div>
        <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {cr
            ? 'Re-rendered at the size it is actually drawn, so it stays sharp past 400% and as a 3D camera moves in. Costs memory in proportion to scale²; Draft and reduced preview resolution cap it.'
            : 'Rasterized once and scaled like an image, so it softens past 400%. Turn on for a logo or title that a camera pushes into.'}
        </p>
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
