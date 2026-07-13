/**
 * ThreeDControl — the layer's "3D Layer" switch in the inspector.
 *
 * Turning it on adds depth props (Z, X-rotation, Y-rotation) to the layer, so
 * the NodeInspector below renders keyframeable rows for them and the renderer
 * projects the layer through the composition camera (perspective scale +
 * parallax + tilt). Turning it off removes them and the layer is flat 2D again.
 */

import { Switch } from '@components/Switch';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled } from '@core/scene/threeD';
import styles from './ParentControl.module.css';

export function ThreeDControl({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;
  // Groups / nulls / cameras don't take a 3D plane of their own here.
  if (!node.components.some((c) => c.type === 'Transform')) return null;

  const on = is3DEnabled(node);

  return (
    <div className={styles.row}>
      <span className={styles.label}>3D Layer</span>
      <Switch
        checked={on}
        onChange={(e) => set3DEnabled(nodeId, e.currentTarget.checked)}
        aria-label="3D layer"
      />
    </div>
  );
}

export default ThreeDControl;
