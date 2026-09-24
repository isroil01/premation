/**
 * The composition's SCENE tools — motion path (+ auto-bezier / straighten when
 * a path is selected), the 3D switch, auto-keyframe — plus the two status
 * badges that say why the viewport may not be showing what you expect.
 *
 * **This renders in the transport bar, right of the play cluster.** What acts
 * on how the frame is SHOWN (layout, channel, resolution, preview, LUT,
 * overlays, snapshot compare, display mode, bookmarks, pop out) is
 * `ViewportDisplayControls`, the next cluster to the right in the same row. The View
 * Options menu that used to render from here is gone: its rows all have one
 * home each now, and the two it had that were duplicates of the buttons in
 * this very cluster (Motion Paths, Auto-Keyframe) ARE those buttons.
 *
 * The history, because the instinct is to move things back and forth:
 *
 *  • An earlier header bar held the composition's NAME plus these two badges,
 *    and was removed for it: 32px across the whole viewport for a name the
 *    Scene tab already shows and two badges that are usually both hidden.
 *  • These tools were once a pill floating over the bottom-left of the stage.
 *    A pill over the canvas covers the canvas, and covers a different part of
 *    it at every zoom level.
 *
 * The Free/Fixed camera lock is NOT here and never was in this file's lifetime
 * — it is `Tabs/EditorTabs.tsx`.
 *
 * The badges keep `--control-height-xs`, a step below the buttons around them:
 * that size difference is what says which things in the row you can click.
 */

import { useMemo } from 'react';
import { Icon } from '@components/Icon';
import { useGuidesStore } from '@stores/guidesStore';
import { useSelectionStore } from '@stores/selectionStore';
import { smoothMotionPath, straightenMotionPath } from '@core/motion/motionPath';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, useMirrorKeys } from '@hooks/useMirror';
import { canBe3DLayer } from '@core/mirror/layerKinds';
import { hasAnyKeys, hasPositionKeys, hasPositionTangents } from '@core/mirror/motionFacts';
import { compHasKind } from '@core/mirror/deviceNames';
import { editPositionKeys } from './viewportEdits';
import { set3DEdit } from './layerMenuEdits';
import { useRenderBackendStore } from '@stores/renderBackendStore';
import styles from './ViewportTools.module.css';

import { useUIStore } from '@stores/uiStore';
import { cameraViewLabel, effectiveViewMode } from '@layout/TopNav/ViewControls';

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
  const storeMode = useGuidesStore((s) => s.camera3dMode);
  const setCamera3dMode = useGuidesStore((s) => s.setCamera3dMode);
  // A camera view whose camera has gone renders as the Active Camera, so it
  // raises no badge — one naming a camera that is not on screen would lie.
  // The parent's scene subscription re-renders this when cameras change.
  const camera3dMode = effectiveViewMode(storeMode);

  if (camera3dMode === 'active' && !isSoftware) return null;

  return (
    <div className={styles.group}>
      {/* Active 3D view name (AE shows the view in the viewer bar). Click
          returns to Active Camera — shortcut `1`. */}
      {camera3dMode !== 'active' && (
        <button
          className={styles.headerBtn}
          onClick={() => setCamera3dMode('active')}
          aria-label={`Viewing through ${cameraViewLabel(camera3dMode)} — return to the Active Camera`}
          title="Viewing through a 3D view — click to return to Active Camera (1)"
        >
          <Icon name="camera" size="sm" />
          <span className={styles.viewName}>{cameraViewLabel(camera3dMode)}</span>
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
 * The composition's action controls, rendered in the transport bar.
 *
 * Transport, split/trim and zoom are deliberately NOT duplicated here — they
 * are in the same row already, either side. Two copies of the same control
 * drift apart and double the surface to keep in sync.
 */
export function ViewportTools(): JSX.Element | null {
  const motionPathVisible = useGuidesStore((s) => s.motionPathVisible);
  const toggleMotionPath = useGuidesStore((s) => s.toggleMotionPath);

  // Re-render when the selection, or a selected layer's header (3D switch)
  // or keyframes change, so the contextual buttons appear/disappear correctly;
  // 'layers' too — a camera added or removed changes the view badge.
  const selectedIds = useSelectionStore((s) => s.ids);
  const watchKeys = useMemo(
    () => ['layers', ...selectedIds.flatMap((id) => [`layer:${id}`, `keys:${id}`])],
    [selectedIds],
  );
  useMirrorKeys(watchKeys);
  const m = documentMirror();

  const singleId = selectedIds.length === 1 ? selectedIds[0] : null;
  const hasPositionAnim = singleId ? hasPositionKeys(m, singleId) : false;
  const hasTangents = singleId ? hasPositionTangents(m, singleId) : false;
  const hasAnyAnim = singleId ? hasAnyKeys(m, singleId) : false;

  // ── Selection 3D switch (AE cube, multi-select aware) ──────────────
  // Every selected layer the renderer can project in 3D (canBe3DLayer is the
  // mirror twin of the one shared predicate; groups/cameras/lights/solids etc.
  // never light this up).
  const eligible3D = selectedIds
    .map((id) => m.layer(id))
    .filter((l): l is NonNullable<typeof l> => !!l && canBe3DLayer(l));
  const all3DOn = eligible3D.length > 0 && eligible3D.every((l) => l.switches.threeD);
  const toggleSelection3D = (): void => {
    const on = !all3DOn;
    void set3DEdit(eligible3D.map((l) => l.id), on);
    // Without a camera, 3D depth doesn't move — surface the one-step fix.
    if (on && !compHasKind(documentMirror(), activeCompIdNow(), 'camera')) {
      useUIStore.getState().notify({ level: 'info', message: 'Tip: add a Camera (+ camera button in the viewport bar) to move in 3D', durationMs: 3200 });
    }
  };

  const isSoftware = useRenderBackendStore((s) => s.isSoftwareFallback);
  const storeMode = useGuidesStore((s) => s.camera3dMode);
  const camera3dMode = effectiveViewMode(storeMode);
  const hasStatus = camera3dMode !== 'active' || isSoftware;
  const hasTools = hasPositionAnim || (hasAnyAnim && !hasPositionAnim) || eligible3D.length > 0;
  if (!hasStatus && !hasTools) return null;

  return (
    <div className={styles.tools}>
      <ViewportStatus />

      {/* ── Contextual motion path controls — icon-only with rich tooltips ── */}
      {hasPositionAnim && (
        <div className={styles.group}>
          <button
            className={`${styles.headerBtn} ${motionPathVisible ? styles.headerBtnActive : ''}`}
            onClick={toggleMotionPath}
            aria-label="Show motion path"
            aria-pressed={motionPathVisible}
            title={motionPathVisible ? 'Hide Motion Path (Ctrl+Alt+M)' : 'Show Motion Path (Ctrl+Alt+M)'}
          >
            <Icon name="path" size="md" />
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => { if (singleId) void editPositionKeys(singleId, 'Smooth motion path', (scratch) => smoothMotionPath(singleId, scratch)); }}
            aria-label="Auto-Bezier — smooth the path through all keyframes"
            title="Auto-Bezier: smooth path through all keyframes (Ctrl+Alt+S)"
          >
            <Icon name="curvature" size="md" />
          </button>
          {hasTangents && (
            <button
              className={styles.headerBtn}
              onClick={() => { if (singleId) void editPositionKeys(singleId, 'Straighten motion path', (scratch) => straightenMotionPath(singleId, scratch)); }}
              aria-label="Straighten — remove the spatial tangents"
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
            aria-label={all3DOn ? 'Disable 3D on the selection' : 'Make the selection 3D'}
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
    </div>
  );
}
