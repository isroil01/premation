// src/layout/SceneControls/SceneControls.tsx
/**
 * SceneControls — the 3D VIEWPORT NAVIGATION cluster in the toolbar (AE's
 * camera-tool + gizmo-mode group). Nothing else: this bar navigates and
 * manipulates, it does not create.
 *
 * Deliberately NOT here (each had exactly one other, better home):
 *  - Free/Fixed workspace lock → ViewportHeader, next to the canvas it locks.
 *  - Insert camera / light / cube / sphere / cylinder / 3D text → the TopNav
 *    "New layer" dropdown, the single home for creating layers.
 *  - "CPU fallback" badge → ViewportHeader, beside the comp it describes.
 *
 * Icon note: orbit/pan/dolly and the ground plane use dedicated glyphs
 * (`orbit`, `hand-grab`, `perspective`, `ground-grid`) instead of borrowing
 * `refresh`/`hand`/`zoom-in`/`grid`, which are the Hand tool, the Zoom tool and
 * the 2D grid overlay elsewhere in this same toolbar.
 */
import { useGuidesStore, type CameraTool, type Gizmo3dState } from '@stores/guidesStore';
import { Icon, type IconName } from '@components/Icon';
import styles from './SceneControls.module.css';

const CAMERA_TOOLS: ReadonlyArray<{ id: CameraTool; icon: IconName; label: string }> = [
  { id: 'orbit', icon: 'orbit', label: 'Orbit Around Cursor' },
  { id: 'pan', icon: 'pan-camera', label: 'Pan Camera' },
  { id: 'dolly', icon: 'perspective', label: 'Dolly Camera (towards/away)' },
];

const GIZMO_MODES: ReadonlyArray<{ id: Gizmo3dState; icon: IconName; label: string }> = [
  { id: 'universal', icon: 'axis-3d', label: 'Universal Gizmo (move · rotate · scale)' },
  { id: 'position', icon: 'move', label: 'Position Gizmo' },
  { id: 'scale', icon: 'scale', label: 'Scale Gizmo' },
  { id: 'rotation', icon: 'rotate-cw', label: 'Rotation Gizmo' },
];

export function SceneControls(): JSX.Element {
  const cameraTool = useGuidesStore((s) => s.cameraTool);
  const setCameraTool = useGuidesStore((s) => s.setCameraTool);
  const gizmo3dState = useGuidesStore((s) => s.gizmo3dState);
  const setGizmo3dState = useGuidesStore((s) => s.setGizmo3dState);
  const draft3d = useGuidesStore((s) => s.draft3d);
  const toggleDraft3d = useGuidesStore((s) => s.toggleDraft3d);
  const groundGridVisible = useGuidesStore((s) => s.groundGridVisible);
  const toggleGroundGridVisible = useGuidesStore((s) => s.toggleGroundGridVisible);

  return (
    <div className={styles.sceneControls}>
      {/* Camera navigation — click to arm, click again to disarm (C cycles). */}
      {CAMERA_TOOLS.map(({ id, icon, label }) => (
        <button
          key={id}
          type="button"
          className={`${styles.button} ${cameraTool === id ? styles.buttonActive : ''}`}
          onClick={() => setCameraTool(cameraTool === id ? 'none' : id)}
          aria-pressed={cameraTool === id}
          title={`${label} — hold Alt to use temporarily, C to cycle`}
        >
          <Icon name={icon} size={16} />
        </button>
      ))}

      <div className={styles.divider} />

      {/* 3D gizmo mode for the selection. */}
      {GIZMO_MODES.map(({ id, icon, label }) => (
        <button
          key={id}
          type="button"
          className={`${styles.button} ${gizmo3dState === id ? styles.buttonActive : ''}`}
          onClick={() => setGizmo3dState(id)}
          aria-pressed={gizmo3dState === id}
          title={label}
        >
          <Icon name={icon} size={16} />
        </button>
      ))}

      <div className={styles.divider} />

      <button
        type="button"
        className={`${styles.button} ${draft3d ? styles.buttonActive : ''}`}
        onClick={toggleDraft3d}
        aria-pressed={draft3d}
        title={
          draft3d
            ? 'Draft 3D ON — lights, shadows and depth-of-field skipped for speed'
            : 'Draft 3D OFF — full 3D shading. Click to preview faster.'
        }
      >
        <Icon name="zap" size={16} />
      </button>

      <button
        type="button"
        className={`${styles.button} ${groundGridVisible ? styles.buttonActive : ''}`}
        onClick={toggleGroundGridVisible}
        aria-pressed={groundGridVisible}
        title={groundGridVisible ? 'Hide 3D ground plane' : 'Show 3D ground plane'}
      >
        <Icon name="ground-grid" size={16} />
      </button>
    </div>
  );
}
