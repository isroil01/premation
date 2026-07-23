// src/layout/SceneControls/SceneControls.tsx
import { useGuidesStore } from '@stores/guidesStore';
import { useRenderBackendStore } from '@stores/renderBackendStore';
import { useWorkspaceViewStore } from '@stores/workspaceViewStore';
import { Icon } from '@components/Icon';
import { insert3DPrimitive, insert3DText, insertLight, insertCamera } from '@core/scene/sceneInsert';
import styles from './SceneControls.module.css';

export function SceneControls(): JSX.Element {
  // Reuse existing stores and actions from ViewportHeader
  const cameraTool = useGuidesStore((s) => s.cameraTool);
  const setCameraTool = useGuidesStore((s) => s.setCameraTool);
  const gizmo3dState = useGuidesStore((s) => s.gizmo3dState);
  const setGizmo3dState = useGuidesStore((s) => s.setGizmo3dState);
  const draft3d = useGuidesStore((s) => s.draft3d);
  const toggleDraft3d = useGuidesStore((s) => s.toggleDraft3d);
  const groundGridVisible = useGuidesStore((s) => s.groundGridVisible);
  const toggleGroundGridVisible = useGuidesStore((s) => s.toggleGroundGridVisible);
  const workspaceMode = useWorkspaceViewStore((s) => s.mode);
  const toggleWorkspaceMode = useWorkspaceViewStore((s) => s.toggleMode);
  const isSoftware = useRenderBackendStore((s) => s.isSoftwareFallback);

  return (
    <div className={styles.sceneControls}>
      {/* Camera Tools */}
      {['orbit', 'pan', 'dolly'].map((mode) => (
        <button
          key={mode}
          className={`${styles.button} ${cameraTool === mode ? styles.buttonActive : ''}`}
          onClick={() => setCameraTool(cameraTool === mode ? 'none' : (mode as any))}
          aria-pressed={cameraTool === mode}
          title={`Camera ${mode.toUpperCase()} (C key)`}
        >
          <Icon name={mode === 'orbit' ? 'refresh' : mode === 'pan' ? 'hand' : 'zoom-in'} size={13} />
        </button>
      ))}

      <div className={styles.divider} />

      {/* 3D Gizmo Modes */}
      {['universal', 'position', 'scale', 'rotation'].map((g) => (
        <button
          key={g}
          className={`${styles.button} ${gizmo3dState === g ? styles.buttonActive : ''}`}
          onClick={() => setGizmo3dState(g as any)}
          aria-pressed={gizmo3dState === g}
          title={`3D Gizmo: ${g.charAt(0).toUpperCase() + g.slice(1)}`}
        >
          <Icon name={g === 'universal' ? 'cube' : g === 'position' ? 'move' : g === 'scale' ? 'scale' : 'rotate-cw'} size={13} />
        </button>
      ))}

      <div className={styles.divider} />

      {/* Viewport Toggles */}
      <button
        className={`${styles.button} ${draft3d ? styles.buttonActive : ''}`}
        onClick={toggleDraft3d}
        aria-pressed={draft3d}
        title={draft3d ? 'Draft 3D enabled' : 'Draft 3D disabled'}
      >
        <Icon name="zap" size={13} />
      </button>

      <button
        className={`${styles.button} ${groundGridVisible ? styles.buttonActive : ''}`}
        onClick={toggleGroundGridVisible}
        aria-pressed={groundGridVisible}
        title={groundGridVisible ? 'Hide Ground Grid' : 'Show Ground Grid'}
      >
        <Icon name="grid" size={13} />
      </button>

      <button
        className={styles.button}
        onClick={toggleWorkspaceMode}
        title={workspaceMode === 'fixed' ? 'Switch to Free Workspace' : 'Switch to Fixed Workspace'}
      >
        <Icon name={workspaceMode === 'fixed' ? 'lock' : 'hand'} size={13} />
      </button>

      <div className={styles.divider} />

      {/* 3D Primitive Shortcuts */}
      <button
        className={styles.button}
        onClick={() => insert3DText('3D TEXT')}
        title="Insert 3D Extruded Text"
      >
        <Icon name="type" size={13} />
      </button>
      <button
        className={styles.button}
        onClick={() => insert3DPrimitive('cube')}
        title="Insert 3D Cube"
      >
        <Icon name="cube" size={13} />
      </button>
      <button
        className={styles.button}
        onClick={() => insert3DPrimitive('sphere')}
        title="Insert 3D Sphere"
      >
        <Icon name="circle" size={13} />
      </button>
      <button
        className={styles.button}
        onClick={() => insert3DPrimitive('cylinder')}
        title="Insert 3D Cylinder"
      >
        <Icon name="shape" size={13} />
      </button>
      <button
        className={styles.button}
        onClick={() => insertLight()}
        title="Insert 3D Light"
      >
        <Icon name="light" size={13} />
      </button>
      <button
        className={styles.button}
        onClick={() => insertCamera()}
        title="Insert 3D Camera"
      >
        <Icon name="camera" size={13} />
      </button>

      {/* Software GPU Fallback Badge */}
      {isSoftware && (
        <span className={styles.softwareBadge} title="GPU hardware acceleration inactive. Running CPU renderer fallback.">
          <Icon name="warning" size={11} /> CPU Fallback
        </span>
      )}
    </div>
  );
}
