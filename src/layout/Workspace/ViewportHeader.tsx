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
import { getEventBus } from '@core/events/EventBus';
import { hasPositionAnimation, smoothMotionPath, straightenMotionPath, hasPathTangents } from '@core/motion/motionPath';
import { runAnimEdit } from '@core/animation/animationCommands';
import { defaultAnimation } from '@motion/animation';
import { usePreferenceStore } from '@stores/preferenceStore';
import { ViewControls } from '@layout/TopNav/ViewControls';
import { useRenderBackendStore } from '@stores/renderBackendStore';
import styles from './ViewportHeader.module.css';

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled, canBe3D } from '@core/scene/threeD';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { CAMERA_VIEW_LABEL } from '@layout/TopNav/ViewControls';



export function ViewportHeader(): JSX.Element {
  const name = useCompositionStore((s) => s.name);
  const focusPath = useFocusStore((s) => s.path);
  const jumpTo = useFocusStore((s) => s.jumpTo);
  const motionPathVisible = useGuidesStore((s) => s.motionPathVisible);
  const toggleMotionPath = useGuidesStore((s) => s.toggleMotionPath);
  const isSoftware = useRenderBackendStore((s) => s.isSoftwareFallback);
  const engineTier = useRenderBackendStore((s) => s.activeTier);

  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const toggleAutoKeyframe = (): void => {
    usePreferenceStore.getState().set('timelineAutoKeyframe', !autoKeyframe);
  };

  // Scene mutations (3D switches, camera/light inserts) must refresh the
  // header's availability checks below.
  useSceneRevision((s) => s.rev);
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
            <Icon name="arrow-left" size={14} />
          </button>
        )}
        <button className={styles.compName} onClick={() => openCompositionSettings()} title="Composition Settings">
          <Icon name="layers" size={14} className={styles.compIcon} />
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
              <Icon name="camera" size={13} />
              <span style={{ marginLeft: 4 }}>{CAMERA_VIEW_LABEL[camera3dMode]}</span>
            </button>
          </>
        )}

        {/* Which engine is actually rendering. WebGPU is the primary tier and
            WebGL2 the fallback, but until now nothing surfaced which one won —
            so "are we on WebGPU?" was unanswerable without a debugger. Hidden
            while pending and on the happy path is a quiet neutral chip; the
            fallback rung reads as a warning because it IS a degraded state. */}
        {engineTier !== 'pending' && engineTier !== 'software' && (
          <>
            <span className={styles.sep} />
            <span
              className={engineTier === 'webgpu' ? styles.engineBadge : styles.engineBadgeFallback}
              title={
                engineTier === 'webgpu'
                  ? 'Rendering on WebGPU — the primary engine.'
                  : 'WebGPU was unavailable on this machine, so the preview fell back to WebGL2. Rendering is correct but slower.'
              }
            >
              {engineTier === 'webgpu' ? 'WebGPU' : 'WebGL2'}
            </span>
          </>
        )}

        {isSoftware && (
          <>
            <span className={styles.sep} />
            <span className={styles.softwareBadge} title="Both WebGPU and WebGL2 failed to initialize, so the preview cannot render. Close other GPU-heavy windows and reopen the project.">
              <Icon name="warning" size={13} />
              GPU unavailable
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
            <Icon name="path" size={14} />
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => singleId && runAnimEdit('Smooth motion path', () => smoothMotionPath(singleId!))}
            title="Auto-Bezier: smooth path through all keyframes (Ctrl+Alt+S)"
          >
            <Icon name="curvature" size={14} />
          </button>
          {hasTangents && (
            <button
              className={styles.headerBtn}
              onClick={() => singleId && runAnimEdit('Straighten motion path', () => straightenMotionPath(singleId!))}
              title="Straighten: remove spatial tangents"
            >
              <Icon name="line" size={14} />
            </button>
          )}
        </div>
      )}

      {hasAnyAnim && !hasPositionAnim && (
        <div className={styles.group}>
          <span className={styles.sep} />
          <span className={styles.animatedChip} title="This layer has keyframes (twirl it open in the timeline)">
            <Icon name="stopwatch" size={13} />
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
            <Icon name="3d" size={14} />
          </button>
        </div>
      )}

      {/* Zoom, fit, and view controls (grid/rulers/safe/channel/resolution) */}
      <div className={styles.group}>
        <span className={styles.sep} />
        <button
          className={`${styles.headerBtn} ${autoKeyframe ? styles.headerBtnActive : ''}`}
          onClick={toggleAutoKeyframe}
          aria-pressed={autoKeyframe}
          title={autoKeyframe ? 'Auto-Keyframe Mode is ON (Click to turn OFF)' : 'Auto-Keyframe Mode is OFF (Click to turn ON)'}
        >
          <Icon name="stopwatch" size={14} />
          {autoKeyframe && <span style={{ fontSize: 10, fontWeight: 700, marginLeft: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>REC</span>}
        </button>
        <ViewControls />
        <button
          className={styles.headerBtn}
          onClick={() => {
            const url = `${window.location.origin}${window.location.pathname}#/popout/viewport`;
            window.open(url, 'popout-viewport', 'width=1280,height=720,resizable=yes');
          }}
          title="Pop Out Viewport Preview into Window"
          style={{ marginLeft: 4 }}
        >
          <Icon name="pop-out" size={14} />
        </button>
      </div>
    </div>
  );
}
