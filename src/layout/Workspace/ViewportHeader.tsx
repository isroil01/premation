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

export function ViewportHeader(): JSX.Element {
  const name = useCompositionStore((s) => s.name);
  const focusPath = useFocusStore((s) => s.path);
  const jumpTo = useFocusStore((s) => s.jumpTo);
  const motionPathVisible = useGuidesStore((s) => s.motionPathVisible);
  const toggleMotionPath = useGuidesStore((s) => s.toggleMotionPath);
  const workspaceMode = useWorkspaceViewStore((s) => s.mode);
  const toggleWorkspaceMode = useWorkspaceViewStore((s) => s.toggleMode);
  const isSoftware = useRenderBackendStore((s) => s.isSoftwareFallback);

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
        {/* Free (pan/zoom everywhere) vs Fixed (comp locked & centred) — icon only */}
        <button
          className={`${styles.headerBtn} ${workspaceMode === 'fixed' ? styles.headerBtnActive : ''}`}
          onClick={toggleWorkspaceMode}
          aria-pressed={workspaceMode === 'fixed'}
          title={
            workspaceMode === 'fixed'
              ? 'Workspace: Fixed — composition is locked & centred. Click for a free, pannable canvas.'
              : 'Workspace: Free — pan and zoom anywhere. Click to lock the composition in view.'
          }
        >
          <Icon name={workspaceMode === 'fixed' ? 'lock' : 'hand'} size={12} />
        </button>

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

      {/* Zoom, fit and the view-options menu (grid/rulers/safe/channel/
          resolution) — the viewport controls, in the viewport's own bar. They
          used to sit up in the global TopNav, away from the canvas they act on. */}
      <div className={styles.group}>
        <span className={styles.sep} />
        <ViewControls />
      </div>
    </div>
  );
}
