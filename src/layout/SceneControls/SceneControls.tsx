// src/layout/SceneControls/SceneControls.tsx
/**
 * SceneControls — the 3D VIEWPORT NAVIGATION cluster in the toolbar (AE's
 * camera-tool + gizmo-mode group). Nothing else: this bar navigates and
 * manipulates, it does not create.
 *
 * Deliberately NOT here (each had exactly one other, better home):
 *  - Free/Fixed workspace lock → ViewportTools, in the timeline's tool row.
 *  - Insert camera / light / cube / sphere / cylinder / 3D text → the TopNav
 *    "New layer" dropdown, the single home for creating layers.
 *  - "CPU fallback" badge → ViewportTools, in the timeline's tool row.
 *
 * Icon note: orbit/pan/dolly and the ground plane use dedicated glyphs
 * (`orbit`, `hand-grab`, `perspective`, `ground-grid`) instead of borrowing
 * `refresh`/`hand`/`zoom-in`/`grid`, which are the Hand tool, the Zoom tool and
 * the 2D grid overlay elsewhere in this same toolbar.
 */
import { useGuidesStore, type CameraTool, type Gizmo3dState, type Gizmo3dAxisMode } from '@stores/guidesStore';
import { Icon, type IconName } from '@components/Icon';
import styles from './SceneControls.module.css';
import { usePreferenceStore } from '@stores/preferenceStore';

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

/**
 * Which axes the gizmo aligns to.
 *
 * `useGizmo3d` has read `gizmo3dAxisMode` all along (it feeds
 * `Gizmo3D.getGizmoBasis`), but `setGizmo3dAxisMode` had NO caller — so the
 * gizmo was permanently stuck in 'local' and world/view space were unreachable.
 * The engine half was finished; only the switch was missing.
 */
const AXIS_MODES: ReadonlyArray<{ id: Gizmo3dAxisMode; label: string; short: string }> = [
  { id: 'local', label: 'Local axes — aligned to the layer', short: 'L' },
  { id: 'world', label: 'World axes — aligned to the composition', short: 'W' },
  { id: 'view', label: 'View axes — aligned to the camera', short: 'V' },
];

export function SceneControls(): JSX.Element {
  const cameraTool = useGuidesStore((s) => s.cameraTool);
  const setCameraTool = useGuidesStore((s) => s.setCameraTool);
  const gizmo3dState = useGuidesStore((s) => s.gizmo3dState);
  const setGizmo3dState = useGuidesStore((s) => s.setGizmo3dState);
  const gizmo3dAxisMode = useGuidesStore((s) => s.gizmo3dAxisMode);
  const setGizmo3dAxisMode = useGuidesStore((s) => s.setGizmo3dAxisMode);
  const draft3d = useGuidesStore((s) => s.draft3d);
  const toggleDraft3d = useGuidesStore((s) => s.toggleDraft3d);
  const groundGridVisible = useGuidesStore((s) => s.groundGridVisible);
  const toggleGroundGridVisible = useGuidesStore((s) => s.toggleGroundGridVisible);
  // A preference, not view state — see `Preferences.showLayerBounds`.
  const layerBoxesVisible = usePreferenceStore((s) => s.showLayerBounds);
  const setPreference = usePreferenceStore((s) => s.set);
  const toggleLayerBoxesVisible = (): void => setPreference('showLayerBounds', !layerBoxesVisible);

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
          title={`${label}${cameraTool === id ? ' (active)' : ''} — hold Alt to use temporarily, C to cycle`}
        >
          <Icon name={icon} size="md" />
        </button>
      ))}
      {cameraTool !== 'none' ? (
        <span className={styles.cameraToolLabel} aria-live="polite">
          {CAMERA_TOOLS.find((t) => t.id === cameraTool)?.label}
        </span>
      ) : null}

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
          <Icon name={icon} size="md" />
        </button>
      ))}

      <div className={styles.divider} />

      {/* Axis space for the gizmo above — AE's Local/World/View. */}
      {AXIS_MODES.map(({ id, label, short }) => (
        <button
          key={id}
          type="button"
          className={`${styles.button} ${gizmo3dAxisMode === id ? styles.buttonActive : ''}`}
          onClick={() => setGizmo3dAxisMode(id)}
          aria-pressed={gizmo3dAxisMode === id}
          title={label}
        >
          <span className={styles.axisGlyph}>{short}</span>
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
            ? 'Draft 3D ON — Fast viewport preview (skips heavy lights & shadows)'
            : 'Draft 3D OFF — Full 3D shading. Click to enable fast preview.'
        }
      >
        <Icon name="draft-3d" size="md" />
      </button>

      <button
        type="button"
        className={`${styles.button} ${groundGridVisible ? styles.buttonActive : ''}`}
        onClick={toggleGroundGridVisible}
        aria-pressed={groundGridVisible}
        title={groundGridVisible ? 'Hide 3D ground plane' : 'Show 3D ground plane'}
      >
        <Icon name="ground-grid" size="md" />
      </button>

      {/*
        Layer bounding boxes. Next to the ground plane because they are the same
        kind of thing — reference geometry that never renders — but a separate
        control because wanting to know which way is up is not the same as
        wanting an outline around every layer.
      */}
      <button
        type="button"
        className={`${styles.button} ${layerBoxesVisible ? styles.buttonActive : ''}`}
        onClick={toggleLayerBoxesVisible}
        aria-pressed={layerBoxesVisible}
        title={layerBoxesVisible ? 'Hide layer bounding boxes' : 'Show layer bounding boxes'}
      >
        <Icon name="frame" size="md" />
      </button>
    </div>
  );
}
