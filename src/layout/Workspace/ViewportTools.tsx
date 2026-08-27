/**
 * The composition's tools — motion path, the 3D switch, auto-keyframe, view
 * options, zoom, pop out — plus the two status badges that say why the viewport
 * may not be showing what you expect.
 *
 * **This renders in the TIMELINE's tool row, beside the trim buttons.** There is
 * no bar above the canvas and no floating pill over the stage any more. Both are
 * gone deliberately, and the reasoning belongs here because the instinct is to
 * put them back:
 *
 *  • The bar above the canvas (`ViewportHeader`) held the composition's name and
 *    these two badges. The name moved to the Scene tab — a row that already
 *    exists, and one that is now named after the thing it contains. What was
 *    left was 32px of chrome across the whole viewport holding two badges that
 *    are usually both hidden: a permanent cost for an occasional message.
 *  • The tools were a pill floating over the bottom-left of the stage. A pill
 *    over the canvas covers the canvas, and covers a different part of it at
 *    every zoom level. Every other control that acts on time and layers — play,
 *    split, trim — was already in one row at the top of the timeline, so these
 *    join it instead of being the one cluster that lives somewhere else.
 *
 * The badges keep `--control-height-xs`, a step below the buttons around them:
 * that size difference is what says which things in the row you can click.
 */

import { useEffect, useReducer } from 'react';
import { Icon } from '@components/Icon';
import { useGuidesStore } from '@stores/guidesStore';
import { useSelectionStore } from '@stores/selectionStore';
import { getEventBus } from '@core/events/EventBus';
import { hasPositionAnimation, smoothMotionPath, straightenMotionPath, hasPathTangents } from '@core/motion/motionPath';
import { runAnimEdit } from '@core/animation/animationCommands';
import { defaultAnimation } from '@motion/animation';
import { usePreferenceStore } from '@stores/preferenceStore';
import { ViewControls } from '@layout/TopNav/ViewControls';
import { useRenderBackendStore } from '@stores/renderBackendStore';
import styles from './ViewportTools.module.css';

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled, canBe3D } from '@core/scene/threeD';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { CAMERA_VIEW_LABEL } from '@layout/TopNav/ViewControls';

/**
 * The status badges that came off the deleted header bar.
 *
 * Both are conditional and both are usually hidden, which is exactly why a bar
 * of their own could not be justified — and also why they render FIRST in the
 * cluster rather than last: when one does appear it is because something is
 * wrong, and it should not arrive at the far end of a row of icons.
 *
 * The header's "Go Back" arrow is NOT here, and nothing was lost with it:
 * `FocusBreadcrumb` renders over the stage with clickable crumbs and its own
 * "Step up (Esc)" button, so the arrow was a second route to a place that
 * already had one.
 */
function ViewportStatus(): JSX.Element | null {
  const isSoftware = useRenderBackendStore((s) => s.isSoftwareFallback);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const setCamera3dMode = useGuidesStore((s) => s.setCamera3dMode);

  if (camera3dMode === 'active' && !isSoftware) return null;

  return (
    <div className={styles.group}>
      {/* Active 3D view name (AE shows the view in the viewer bar). Click
          returns to Active Camera — shortcut `1`. */}
      {camera3dMode !== 'active' && (
        <button
          className={styles.headerBtn}
          onClick={() => setCamera3dMode('active')}
          title="Viewing through a 3D view — click to return to Active Camera (1)"
        >
          <Icon name="camera" size="sm" />
          <span style={{ marginLeft: 4 }}>{CAMERA_VIEW_LABEL[camera3dMode]}</span>
        </button>
      )}

      {/*
        No WebGPU/WebGL2 badge.

        Which backend the preview happens to be on is not a fact a user acts on
        — it costs a permanent slot to tell them something true and useless. The
        `GPU unavailable` badge stays, because that one IS actionable: nothing
        is rendering and they need to know why.
      */}
      {isSoftware && (
        <span className={styles.softwareBadge} title="Both WebGPU and WebGL2 failed to initialize, so the preview cannot render. Close other GPU-heavy windows and reopen the project.">
          <Icon name="warning" size="sm" />
          GPU unavailable
        </span>
      )}
      <span className={styles.sep} />
    </div>
  );
}

/**
 * The composition's action controls, rendered in the timeline's tool row.
 *
 * Transport, split/trim and preview quality are deliberately NOT duplicated
 * here — they are in the same row already, immediately to the left. Two copies
 * of the same control drift apart and double the surface to keep in sync.
 */
export function ViewportTools(): JSX.Element {
  const motionPathVisible = useGuidesStore((s) => s.motionPathVisible);
  const toggleMotionPath = useGuidesStore((s) => s.toggleMotionPath);

  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const toggleAutoKeyframe = (): void => {
    usePreferenceStore.getState().set('timelineAutoKeyframe', !autoKeyframe);
  };

  // Scene mutations (3D switches, camera/light inserts) must refresh the
  // availability checks below.
  useSceneRevision((s) => s.rev);

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

  return (
    <div className={styles.tools}>
      <ViewportStatus />

      {/* ── Contextual motion path controls — icon-only with rich tooltips ── */}
      {hasPositionAnim && (
        <div className={styles.group}>
          <button
            className={`${styles.headerBtn} ${motionPathVisible ? styles.headerBtnActive : ''}`}
            onClick={toggleMotionPath}
            aria-pressed={motionPathVisible}
            title={motionPathVisible ? 'Hide Motion Path (Ctrl+Alt+M)' : 'Show Motion Path (Ctrl+Alt+M)'}
          >
            <Icon name="path" size="md" />
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => singleId && runAnimEdit('Smooth motion path', () => smoothMotionPath(singleId!))}
            title="Auto-Bezier: smooth path through all keyframes (Ctrl+Alt+S)"
          >
            <Icon name="curvature" size="md" />
          </button>
          {hasTangents && (
            <button
              className={styles.headerBtn}
              onClick={() => singleId && runAnimEdit('Straighten motion path', () => straightenMotionPath(singleId!))}
              title="Straighten: remove spatial tangents"
            >
              <Icon name="line" size="md" />
            </button>
          )}
          <span className={styles.sep} />
        </div>
      )}

      {hasAnyAnim && !hasPositionAnim && (
        <div className={styles.group}>
          <span className={styles.animatedChip} title="This layer has keyframes (twirl it open in the timeline)">
            {/* `keyframe`, not `stopwatch` — Auto-Keyframe beside this already
                owns the stopwatch glyph in the same tool row. */}
            <Icon name="keyframe" size="sm" />
            Animated
          </span>
          <span className={styles.sep} />
        </div>
      )}

      {/* ── Selection "3D Layer" switch — AE's cube, one obvious button ── */}
      {eligible3D.length > 0 && (
        <div className={styles.group}>
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
            <Icon name="3d" size="md" />
          </button>
          <span className={styles.sep} />
        </div>
      )}

      {/* Zoom, fit, and view controls (grid/rulers/safe/channel/resolution) */}
      <div className={styles.group}>
        <button
          className={`${styles.headerBtn} ${autoKeyframe ? styles.headerBtnActive : ''}`}
          onClick={toggleAutoKeyframe}
          aria-pressed={autoKeyframe}
          title={autoKeyframe ? 'Auto-Keyframe Mode is ON (Click to turn OFF)' : 'Auto-Keyframe Mode is OFF (Click to turn ON)'}
        >
          <Icon name="stopwatch" size="md" />
          {autoKeyframe && <span className={styles.recLabel}>REC</span>}
        </button>
        <ViewControls />
        <button
          className={`${styles.headerBtn} ${styles.popOut}`}
          onClick={() => {
            const url = `${window.location.origin}${window.location.pathname}#/popout/viewport`;
            window.open(url, 'popout-viewport', 'width=1280,height=720,resizable=yes');
          }}
          title="Pop Out Viewport Preview into Window"
          style={{ marginLeft: 4 }}
        >
          <Icon name="pop-out" size="md" />
        </button>
      </div>
    </div>
  );
}
