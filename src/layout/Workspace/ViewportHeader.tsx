/**
 * ViewportHeader — the AE-style composition panel header bar, and the single
 * owner of the viewport's controls.
 *
 * Sits directly above the canvas:
 *   ← [Comp name] · [Size] · [Free/Fixed] … [motion path] … [Zoom · Fit · View options] →
 *
 * "Size" is the shared, grouped preset catalog (`presets.ts`) — not a local
 * copy — and "View options" hosts grid / rulers / safe areas / channel /
 * resolution. Zoom, fit and those options previously lived in the global
 * TopNav, away from the canvas; they belong here. Composition Settings still
 * owns exact px / fps / duration entry (reached via "Custom size…").
 */

import { useEffect, useReducer } from 'react';
import { useCompositionStore } from '@stores/compositionStore';
import { Icon } from '@components/Icon';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { useFocusStore } from '@stores/focusStore';
import { useGuidesStore } from '@stores/guidesStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useWorkspaceViewStore } from '@stores/workspaceViewStore';
import { getEventBus } from '@core/events/EventBus';
import { hasPositionAnimation, smoothMotionPath, straightenMotionPath, hasPathTangents } from '@core/motion/motionPath';
import { runAnimEdit } from '@core/animation/animationCommands';
import { defaultAnimation } from '@motion/animation';
import { ViewControls } from '@layout/TopNav/ViewControls';
import { useRenderBackendStore } from '@stores/renderBackendStore';
import styles from './ViewportHeader.module.css';

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled, canBe3D } from '@core/scene/threeD';
import { insert3DPrimitive, insert3DText } from '@core/scene/sceneInsert';
import { openCameraDialog, openLightDialog } from './SceneInsertDialogs';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import { findNavTarget, notifyCameraTipIfMissing, CAMERA_TOOL_CYCLE, type CameraNavMode } from '@core/workspace/cameraNav';
import { CAMERA_VIEW_LABEL } from '@layout/TopNav/ViewControls';

/** Icon + tooltip per camera tool mode (C key cycles through these). */
const CAMERA_TOOL_META: Record<CameraNavMode, { icon: import('@components/Icon').IconName; label: string }> = {
  orbit: { icon: 'rotate-cw', label: 'Orbit Camera — left-drag swings around the point of interest' },
  pan: { icon: 'move', label: 'Pan (Track XY) Camera — left-drag tracks the framing' },
  dolly: { icon: 'zoom-in', label: 'Dolly Camera — drag up/down (or wheel) to move along the view axis' },
};

export function ViewportHeader(): JSX.Element {
  const name = useCompositionStore((s) => s.name);
  const focusPath = useFocusStore((s) => s.path);
  const jumpTo = useFocusStore((s) => s.jumpTo);
  const motionPathVisible = useGuidesStore((s) => s.motionPathVisible);
  const toggleMotionPath = useGuidesStore((s) => s.toggleMotionPath);
  const workspaceMode = useWorkspaceViewStore((s) => s.mode);
  const toggleWorkspaceMode = useWorkspaceViewStore((s) => s.toggleMode);
  const isSoftware = useRenderBackendStore((s) => s.isSoftwareFallback);

  // Scene mutations (3D switches, camera/light inserts) must refresh the
  // header's availability checks below.
  useSceneRevision((s) => s.rev);
  const draft3d = useGuidesStore((s) => s.draft3d);
  const toggleDraft3d = useGuidesStore((s) => s.toggleDraft3d);
  const cameraTool = useGuidesStore((s) => s.cameraTool);
  const setCameraTool = useGuidesStore((s) => s.setCameraTool);
  const gizmo3dState = useGuidesStore((s) => s.gizmo3dState);
  const setGizmo3dState = useGuidesStore((s) => s.setGizmo3dState);
  const gizmo3dAxisMode = useGuidesStore((s) => s.gizmo3dAxisMode);
  const setGizmo3dAxisMode = useGuidesStore((s) => s.setGizmo3dAxisMode);
  const groundGridVisible = useGuidesStore((s) => s.groundGridVisible);
  const toggleGroundGridVisible = useGuidesStore((s) => s.toggleGroundGridVisible);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);

  // Re-render when selection or animation changes so the contextual motion
  // buttons appear/disappear correctly.
  const selectedIds = useSelectionStore((s) => s.ids);
  const [, bumpAnim] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = getEventBus().on('AnimationChanged', () => bumpAnim());
    return () => sub.dispose();
  }, []);

  const singleId = selectedIds.length === 1 ? selectedIds[0] : null;
  const singleNode = singleId ? defaultSceneGraph.getNode(singleId as any) : null;
  const is3DActive = (singleNode ? is3DEnabled(singleNode) : false) || camera3dMode !== 'active';
  const hasPositionAnim = singleId ? hasPositionAnimation(singleId) : false;
  const hasTangents = singleId ? hasPathTangents(singleId) : false;
  const hasAnyAnim = singleId ? (defaultAnimation.animatedProps(singleId).length > 0) : false;

  // ── Selection 3D switch (AE cube, multi-select aware) ──────────────
  // Every selected node the renderer can project in 3D (canBe3D is the one
  // shared predicate; groups/cameras/lights/solids etc. never light this up).
  const eligible3D = selectedIds
    .map((id) => defaultSceneGraph.getNode(id as any))
    .filter((n): n is NonNullable<typeof n> => !!n && canBe3D(n));
  const all3DOn = eligible3D.length > 0 && eligible3D.every((n) => is3DEnabled(n));
  const toggleSelection3D = (): void => {
    const on = !all3DOn;
    for (const n of eligible3D) set3DEnabled(n.id, on);
    bumpScene();
    if (on) {
      notifyCameraTipIfMissing((message, level) =>
        useUIStore.getState().notify({ level, message, durationMs: 3200 }),
      );
    }
  };

  // Camera tool indicator: shown whenever camera navigation is possible —
  // the same gate the C key uses (camera+3D in Active; any 3D in a custom
  // view, where nav re-frames the stored view instead of a camera node).
  const camNavAvailable = findNavTarget() !== null;
  const setCamera3dMode = useGuidesStore((s) => s.setCamera3dMode);

  return (
    <div className={styles.root}>
      {/* ── Tabs ──────────────────── */}
      <div className={styles.group}>
        {focusPath.length > 0 && (
          <button
            className={styles.headerBtn}
            onClick={() => jumpTo(-1)}
            title="Go Back"
            style={{ marginRight: 4 }}
          >
            <Icon name="arrow-left" size={12} />
          </button>
        )}
        <button className={styles.compName} onClick={() => openCompositionSettings()} title="Composition Settings">
          <Icon name="layers" size={12} className={styles.compIcon} />
          <span className={styles.compLabel}>{name}</span>
        </button>

        {/* Active 3D view name (AE shows the view in the viewer bar). Click
            returns to Active Camera — shortcut `1`. */}
        {camera3dMode !== 'active' && (
          <>
            <span className={styles.sep} />
            <button
              className={styles.headerBtn}
              onClick={() => setCamera3dMode('active')}
              title="Viewing through a 3D view — click to return to Active Camera (1)"
            >
              <Icon name="camera" size={11} />
              <span style={{ marginLeft: 4 }}>{CAMERA_VIEW_LABEL[camera3dMode]}</span>
            </button>
          </>
        )}

        {isSoftware && (
          <>
            <span className={styles.sep} />
            <span className={styles.softwareBadge} title="GPU context creation failed. Renders via rasterizer CPU fallback.">
              <Icon name="warning" size={11} />
              Software rendering
            </span>
          </>
        )}
      </div>

      <div className={styles.spacer} />

      {/* ── Contextual motion path controls — icon-only with rich tooltips ── */}
      {hasPositionAnim && (
        <div className={styles.group}>
          <span className={styles.sep} />
          <button
            className={`${styles.headerBtn} ${motionPathVisible ? styles.headerBtnActive : ''}`}
            onClick={toggleMotionPath}
            aria-pressed={motionPathVisible}
            title={motionPathVisible ? 'Hide Motion Path (Ctrl+Alt+M)' : 'Show Motion Path (Ctrl+Alt+M)'}
          >
            <Icon name="path" size={12} />
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => singleId && runAnimEdit('Smooth motion path', () => smoothMotionPath(singleId!))}
            title="Auto-Bezier: smooth path through all keyframes (Ctrl+Alt+S)"
          >
            <Icon name="curvature" size={12} />
          </button>
          {hasTangents && (
            <button
              className={styles.headerBtn}
              onClick={() => singleId && runAnimEdit('Straighten motion path', () => straightenMotionPath(singleId!))}
              title="Straighten: remove spatial tangents"
            >
              <Icon name="line" size={12} />
            </button>
          )}
        </div>
      )}

      {hasAnyAnim && !hasPositionAnim && (
        <div className={styles.group}>
          <span className={styles.sep} />
          <span className={styles.animatedChip} title="This layer has keyframes (twirl it open in the timeline)">
            <Icon name="stopwatch" size={11} />
            Animated
          </span>
        </div>
      )}

      {/* ── Selection "3D Layer" switch — AE's cube, one obvious button ── */}
      {eligible3D.length > 0 && (
        <div className={styles.group}>
          <span className={styles.sep} />
          <button
            className={`${styles.headerBtn} ${all3DOn ? styles.headerBtnActive : ''}`}
            onClick={toggleSelection3D}
            aria-pressed={all3DOn}
            title={
              all3DOn
                ? `Disable 3D on ${eligible3D.length > 1 ? `${eligible3D.length} selected layers` : 'the selected layer'}`
                : `Make ${eligible3D.length > 1 ? `${eligible3D.length} selected layers` : 'the selected layer'} 3D (adds Z position + X/Y rotation)`
            }
          >
            <Icon name="3d" size={12} />
          </button>
        </div>
      )}

      {/* ── Camera tool (C key cycles Orbit → Pan → Dolly; Esc/V exits) ── */}
      {camNavAvailable && (
        <div className={styles.group}>
          <span className={styles.sep} />
          {CAMERA_TOOL_CYCLE.map((mode) => (
            <button
              key={mode}
              className={`${styles.headerBtn} ${cameraTool === mode ? styles.headerBtnActive : ''}`}
              onClick={() => setCameraTool(cameraTool === mode ? 'none' : mode)}
              aria-pressed={cameraTool === mode}
              title={`${CAMERA_TOOL_META[mode].label} (C cycles, Esc exits)`}
            >
              <Icon name={CAMERA_TOOL_META[mode].icon} size={12} />
            </button>
          ))}
        </div>
      )}

      {/* ── 3D Design Space Gizmo Controls ── */}
      {is3DActive && (
        <div className={styles.group}>
          <span className={styles.sep} />
          {/* Universal Gizmo */}
          <button
            className={`${styles.headerBtn} ${gizmo3dState === 'universal' ? styles.headerBtnActive : ''}`}
            onClick={() => setGizmo3dState('universal')}
            title="Universal 3D Gizmo (Translate, Scale & Rotate) [U]"
          >
            <Icon name="cube" size={12} />
          </button>
          {/* Position Gizmo */}
          <button
            className={`${styles.headerBtn} ${gizmo3dState === 'position' ? styles.headerBtnActive : ''}`}
            onClick={() => setGizmo3dState('position')}
            title="Position 3D Gizmo (Translate) [W]"
          >
            <Icon name="move" size={12} />
          </button>
          {/* Scale Gizmo */}
          <button
            className={`${styles.headerBtn} ${gizmo3dState === 'scale' ? styles.headerBtnActive : ''}`}
            onClick={() => setGizmo3dState('scale')}
            title="Scale 3D Gizmo [R]"
          >
            <Icon name="scale" size={12} />
          </button>
          {/* Rotation Gizmo */}
          <button
            className={`${styles.headerBtn} ${gizmo3dState === 'rotation' ? styles.headerBtnActive : ''}`}
            onClick={() => setGizmo3dState('rotation')}
            title="Rotation 3D Gizmo [E]"
          >
            <Icon name="rotate-cw" size={12} />
          </button>

          <span className={styles.sep} />

          {/* Axis Mode Switcher */}
          <select
            className={styles.headerSelect}
            value={gizmo3dAxisMode}
            onChange={(e) => setGizmo3dAxisMode(e.target.value as any)}
            title="3D Axis Mode (Local / World / View space)"
          >
            <option value="local">Local Axis</option>
            <option value="world">World Axis</option>
            <option value="view">View Axis</option>
          </select>

          {/* Ground Grid toggle */}
          <button
            className={`${styles.headerBtn} ${groundGridVisible ? styles.headerBtnActive : ''}`}
            onClick={toggleGroundGridVisible}
            title={groundGridVisible ? 'Hide 3D Ground Floor Grid' : 'Show 3D Ground Floor Grid'}
            style={{ marginLeft: 4 }}
          >
            <Icon name="grid" size={12} />
          </button>

          {/* Draft 3D — AE's lightning bolt: fast preview without DOF/lights */}
          <button
            className={`${styles.headerBtn} ${draft3d ? styles.headerBtnActive : ''}`}
            onClick={toggleDraft3d}
            aria-pressed={draft3d}
            title={
              draft3d
                ? 'Draft 3D is ON — depth-of-field and lighting are skipped for speed. Click for full quality.'
                : 'Draft 3D: fast preview that skips depth-of-field blur and lighting (exports are unaffected)'
            }
          >
            <Icon name="zap" size={12} />
          </button>

          <span className={styles.sep} />

          {/* Quick Insert 3D Mesh / Text / Light / Camera toolbar */}
          <button
            className={styles.headerBtn}
            onClick={() => insert3DText('3D TEXT')}
            title="Add 3D Extruded Text to Scene"
          >
            <span>+</span>
            <Icon name="type" size={12} />
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => insert3DPrimitive('cube')}
            title="Add 3D Cube Mesh to Scene"
          >
            <span>+</span>
            <Icon name="cube" size={12} />
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => insert3DPrimitive('sphere')}
            title="Add 3D Sphere Mesh to Scene"
          >
            <span>+</span>
            <Icon name="circle" size={12} />
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => insert3DPrimitive('cylinder')}
            title="Add 3D Cylinder Mesh to Scene"
          >
            <span>+</span>
            <Icon name="shape" size={12} />
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => openLightDialog()}
            title="New 3D Light… (Point, Spot, Sun, Ambient)"
          >
            <span>+</span>
            <Icon name="light" size={12} />
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => openCameraDialog()}
            title="New 3D Camera… (1-Node / 2-Node Target Camera)"
          >
            <span>+</span>
            <Icon name="camera" size={12} />
          </button>
        </div>
      )}

      {/* Zoom, fit, lock, and view controls (grid/rulers/safe/channel/resolution) */}
      <div className={styles.group}>
        <span className={styles.sep} />
        {/* Free (pan/zoom everywhere) vs Fixed (comp locked & centred) */}
        <button
          className={`${styles.headerBtn} ${workspaceMode === 'fixed' ? styles.headerBtnActive : ''}`}
          onClick={toggleWorkspaceMode}
          aria-pressed={workspaceMode === 'fixed'}
          title={
            workspaceMode === 'fixed'
              ? 'Workspace: Fixed — composition is locked & centred. Click for a free, pannable canvas.'
              : 'Workspace: Free — pan and zoom anywhere. Click to lock the composition in view.'
          }
          style={{ marginRight: 4 }}
        >
          <Icon name={workspaceMode === 'fixed' ? 'lock' : 'hand'} size={12} />
        </button>
        <ViewControls />
      </div>
    </div>
  );
}
