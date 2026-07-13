/**
 * MotionControls (Prompt E4) — the layer's motion-path options in the inspector.
 *
 * Auto-orient rotates the layer to face its direction of travel along the
 * animated position path (buildSnapshot overrides rotation with the velocity
 * heading). Only meaningful once the layer has a position animation, but the
 * toggle is always available on transformable layers so it can be armed first.
 */

import { Switch } from '@components/Switch';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isAutoOriented, setAutoOriented } from '@core/scene/autoOrient';
import { hasPositionAnimation } from '@core/motion/motionPath';
import styles from './ParentControl.module.css';

export function MotionControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;
  if (!node.components.some((c) => c.type === 'Transform')) return null;

  const on = isAutoOriented(node);
  const animated = hasPositionAnimation(nodeId);

  return (
    <div className={styles.row}>
      <span className={styles.label}>
        Auto-Orient
        {!animated && <span style={{ opacity: 0.5, fontWeight: 400 }}> · needs position keys</span>}
      </span>
      <Switch
        checked={on}
        onChange={(e) => setAutoOriented(nodeId, e.currentTarget.checked)}
        aria-label="Auto-orient along motion path"
      />
    </div>
  );
}

export default MotionControls;
