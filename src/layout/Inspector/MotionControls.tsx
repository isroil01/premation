/**
 * MotionControls (Prompt E4) — the layer's motion-path options in the inspector.
 *
 * Auto-orient rotates the layer to face its direction of travel along the
 * animated position path (buildSnapshot overrides rotation with the velocity
 * heading). Only meaningful once the layer has a position animation, but the
 * toggle is always available on transformable layers so it can be armed first.
 */

import { useEffect, useReducer } from 'react';
import { Switch } from '@components/Switch';
import { getEventBus } from '@core/events/EventBus';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isAutoOriented, setAutoOriented } from '@core/scene/autoOrient';
import {
  hasPositionAnimation,
  hasPathTangents,
  smoothMotionPath,
  straightenMotionPath,
} from '@core/motion/motionPath';
import { runAnimEdit } from '@core/animation/animationCommands';
import styles from './ParentControl.module.css';

export function MotionControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  // Keyframe edits (smooth/straighten, tangent drags, capture) change what the
  // path buttons can do — re-render on animation changes too.
  const [, bumpAnim] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = getEventBus().on('AnimationChanged', () => bumpAnim());
    return () => sub.dispose();
  }, []);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;
  if (!node.components.some((c) => c.type === 'Transform')) return null;

  const on = isAutoOriented(node);
  const animated = hasPositionAnimation(nodeId);
  const transformComp = node.components.find((c) => c.type === 'Transform');
  const separated = transformComp?.props.separateDimensions === true;

  return (
    <>
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
      <div className={styles.row}>
        <span className={styles.label}>
          Motion Path
          {!animated && <span style={{ opacity: 0.5, fontWeight: 400 }}> · needs position keys</span>}
        </span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button
            type="button"
            className={styles.trigger}
            disabled={!animated}
            onClick={() => runAnimEdit('Smooth motion path', () => smoothMotionPath(nodeId))}
            title="Auto-bezier: curve the path smoothly through every keyframe (drag the square handles on the canvas to shape it)"
          >
            Smooth
          </button>
          <button
            type="button"
            className={styles.trigger}
            disabled={!animated || !hasPathTangents(nodeId)}
            onClick={() => runAnimEdit('Straighten motion path', () => straightenMotionPath(nodeId))}
            title="Remove spatial tangents — straight lines between keyframes"
          >
            Straighten
          </button>
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Separate Dimensions</span>
        <Switch
          checked={separated}
          onChange={(e) => {
            const val = e.currentTarget.checked;
            defaultSceneGraph.setSeparateDimensions(nodeId, val);
            bumpScene();
          }}
          aria-label="Separate position into X and Y tracks"
        />
      </div>
    </>
  );
}

export default MotionControls;
