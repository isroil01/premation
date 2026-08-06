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
import { readAutoOrientMode, setAutoOrientMode, type AutoOrientMode } from '@core/scene/autoOrient';
import { canBe3D, is3DEnabled } from '@core/scene/threeD';
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

  const autoOrient = readAutoOrientMode(node);
  const animated = hasPositionAnimation(nodeId);
  // "Towards Camera" only means anything for a layer that lives in 3D space.
  const canFaceCamera = canBe3D(node) && is3DEnabled(node);
  const transformComp = node.components.find((c) => c.type === 'Transform');
  const separated = transformComp?.props.separateDimensions === true;

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>
          Auto-Orient
          {autoOrient === 'path' && !animated && (
            <span style={{ opacity: 0.5, fontWeight: 400 }}> · needs position keys</span>
          )}
        </span>
        <select
          className={styles.select}
          style={{ width: 128, fontSize: 'var(--font-size-xs)' }}
          value={autoOrient}
          onChange={(e) => setAutoOrientMode(nodeId, e.currentTarget.value as AutoOrientMode)}
          aria-label="Auto-orient"
        >
          <option value="off">Off</option>
          <option value="path">Along Path</option>
          {/* AE's per-layer, opt-in billboard. Hidden for 2D layers because
              facing a camera is meaningless outside 3D space. */}
          {canFaceCamera && <option value="camera">Towards Camera</option>}
        </select>
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
