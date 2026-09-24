/**
 * MotionControls (Prompt E4) — the layer's motion-path options in the inspector.
 *
 * Auto-orient rotates the layer to face its direction of travel along the
 * animated position path (buildSnapshot overrides rotation with the velocity
 * heading). Only meaningful once the layer has a position animation, but the
 * toggle is always available on transformable layers so it can be armed first.
 */

import { Switch } from '@components/Switch';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorLayerKeyframes, useMirrorTree } from '@hooks/useMirror';
import type { AutoOrientMode } from '@core/scene/autoOrient';
import { mirrorAutoOrientMode, mirrorCanAutoOrient, mirrorCanBe3D, mirrorHasPathTangents, mirrorHasTransform } from '@core/mirror/layerFacts';
import { hasPositionKeys } from '@core/mirror/motionFacts';
import { edit } from '@core/engine/uiEdits';
import { motionPathCommands, setLayersSwitch } from './inspectorEdits';

/** The engine's auto-orient switch value for the stored mode. */
const API_AUTO_ORIENT: Record<AutoOrientMode, 'off' | 'alongPath' | 'towardsCamera'> = { off: 'off', path: 'alongPath', camera: 'towardsCamera' };

function reshapePath(nodeId: string, mode: 'smooth' | 'straighten'): void {
  void motionPathCommands(nodeId, mode).then((cmds) => edit(mode === 'smooth' ? 'Smooth motion path' : 'Straighten motion path', cmds));
}
import styles from './ParentControl.module.css';

export function MotionControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  const layer = useMirrorLayer(nodeId);
  const tree = useMirrorTree(nodeId);
  // Keyframe edits (smooth/straighten, tangent drags, capture) change what the
  // path buttons can do — re-render on the layer's keyframes too.
  useMirrorLayerKeyframes(nodeId);
  if (!layer || nodeId === 'comp_root') return null;
  if (!mirrorHasTransform(tree)) return null;

  const m = documentMirror();
  const is3D = layer.switches.threeD;
  const autoOrient = mirrorAutoOrientMode(layer);
  const animated = hasPositionKeys(m, nodeId);
  // "Towards Camera" only means anything for a layer that lives in 3D space.
  const canFaceCamera = mirrorCanBe3D(layer, tree) && is3D;
  // Along Path is applied only for 2D layers today (buildSnapshot gates on
  // !is3D). Offering it on 3D looked live and changed nothing — same class of
  // bug as cameras/nulls. Keep the option visible if already set so the user
  // can switch Off / Towards Camera.
  const showAlongPath = !is3D || autoOrient === 'path';
  // ...and Auto-Orient as a whole only means anything for a kind the drawn-layer
  // loop actually reaches. On a camera, light, null, group or audio layer both
  // readers are skipped before they run, so the dropdown wrote a value nothing
  // consumed. Motion Path below is NOT gated on this: smoothing a camera's
  // position keys is real, it is only the derived ROTATION that is dead.
  const showAutoOrient = mirrorCanAutoOrient(layer, tree);
  const separated = tree?.nodes.get('transform/position')?.separated === true;

  return (
    <>
      {showAutoOrient && (
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
            onChange={(e) => { void setLayersSwitch([nodeId], { autoOrient: API_AUTO_ORIENT[e.currentTarget.value as AutoOrientMode] }, 'Auto-Orient'); }}
            aria-label="Auto-orient"
          >
            <option value="off">Off</option>
            {showAlongPath && (
              <option value="path" title={is3D ? 'Along Path currently affects 2D layers only' : undefined}>
                Along Path{is3D ? ' (2D only)' : ''}
              </option>
            )}
            {/* AE's per-layer, opt-in billboard. Hidden for 2D layers because
                facing a camera is meaningless outside 3D space. */}
            {canFaceCamera && <option value="camera">Towards Camera</option>}
          </select>
        </div>
      )}
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
            onClick={() => reshapePath(nodeId, 'smooth')}
            title="Auto-bezier: curve the path smoothly through every keyframe (drag the square handles on the canvas to shape it)"
          >
            Smooth
          </button>
          <button
            type="button"
            className={styles.trigger}
            disabled={!animated || !mirrorHasPathTangents(m, nodeId)}
            onClick={() => reshapePath(nodeId, 'straighten')}
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
            void edit('Separate Dimensions', { type: 'setDimensionsSeparated', layer: nodeId, path: 'transform/position', separated: e.currentTarget.checked });
          }}
          aria-label="Separate position into X and Y tracks"
        />
      </div>
    </>
  );
}

export default MotionControls;
