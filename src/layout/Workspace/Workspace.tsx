/**
 * Workspace / WorkspaceViewport — the central editor viewport.
 *
 * React owns only the DOM (a content canvas, an interaction overlay canvas, and
 * the stage). All interaction — camera pan/zoom, tool behavior, selection,
 * hit-testing, snapping — is handled by the framework-independent
 * `@motion/workspace` engine, driven through {@link useWorkspace}. This file is
 * pure wiring: mount the canvases, forward viewport-scoped keys, and expose the
 * zoom controls bound to the engine camera.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { cn } from '@utils/cn';
import { IconButton } from '@components/IconButton';
import { Icon } from '@components/Icon';
import { keyFrom } from '@motion/workspace';
import { useActiveWorkspace } from '@stores/workspaceStore';
import { useSceneRevision } from '@stores/sceneStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { AiPromptBar } from './AiPromptBar';
import { AiSuggestionCard } from './AiSuggestionCard';
import { FocusBreadcrumb } from '@layout/focus/FocusBreadcrumb';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { useWorkspace } from './useWorkspace';
import styles from './Workspace.module.css';

export interface WorkspaceViewportProps {
  topLeft?: ReactNode;
  topRight?: ReactNode;
  bottomLeft?: ReactNode;
  bottomRight?: ReactNode;
  className?: string;
}

/** Keys the viewport handles directly (pan/nudge/delete); everything else
 *  falls through to global shortcuts and the tool bar. */
const VIEWPORT_KEYS = new Set([
  'Space',
  'Delete',
  'Backspace',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

export function WorkspaceViewport({
  topLeft,
  topRight,
  bottomLeft,
  bottomRight,
  className,
}: WorkspaceViewportProps): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  const sceneRev = useSceneRevision((s) => s.rev);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const { focus, focusKey } = useFocusContext();

  useWorkspace({
    contentCanvasRef: canvasRef,
    overlayCanvasRef: overlayRef,
    stageRef,
    sceneRev,
    time,
    focus,
    focusKey,
  });

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>): void => {
    if (!VIEWPORT_KEYS.has(e.code)) return;
    const controller = getWorkspaceController();
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        controller.ws.feedKeyDown(keyFrom(e, performance.now()));
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        controller.deleteSelection();
        break;
      case 'Escape':
        controller.ws.clearSelection();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0;
        const dy = e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0;
        controller.nudgeSelection(dx, dy);
        break;
      }
    }
  }, []);

  const onKeyUp = useCallback((e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.code === 'Space') getWorkspaceController().ws.feedKeyUp(keyFrom(e, performance.now()));
  }, []);

  return (
    <div
      className={cn(styles.root, className)}
      data-workspace-viewport=""
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <div className={styles.stage} ref={stageRef}>
        <canvas ref={canvasRef} className={styles.canvas} />
        <canvas ref={overlayRef} className={styles.overlay} data-workspace-overlay="" />
      </div>

      <div className={styles.overlayTL}>{topLeft}</div>
      <div className={styles.overlayTR}>{topRight}</div>
      <div className={styles.overlayBL}>{bottomLeft}</div>
      <div className={styles.overlayBR}>{bottomRight ?? <ViewportZoomControls />}</div>
      <div className={styles.overlayBC}><AiPromptBar /></div>

      <AiSuggestionCard />
      <FocusBreadcrumb />
    </div>
  );
}

/** Zoom controls bound to the engine camera (live %, in/out, fit). */
export function ViewportZoomControls(): JSX.Element {
  const [percent, setPercent] = useState(() => getWorkspaceController().zoomPercent());

  useEffect(() => {
    const ws = getWorkspaceController().ws;
    const sync = (): void => setPercent(getWorkspaceController().zoomPercent());
    const subZoom = ws.events.on('ZoomChanged', sync);
    const subView = ws.events.on('ViewportChanged', sync);
    sync();
    return () => {
      subZoom.dispose();
      subView.dispose();
    };
  }, []);

  return (
    <div className={styles.zoomBar}>
      <IconButton aria-label="Zoom out" size="sm" onClick={() => getWorkspaceController().zoomOut()}>
        <Icon name="zoom-out" size={14} />
      </IconButton>
      <button
        type="button"
        className={styles.zoomLabel}
        title="Reset to 100%"
        onClick={() => getWorkspaceController().setZoomPercent(100)}
      >
        {percent}%
      </button>
      <IconButton aria-label="Zoom in" size="sm" onClick={() => getWorkspaceController().zoomIn()}>
        <Icon name="zoom-in" size={14} />
      </IconButton>
      <IconButton aria-label="Fit composition" size="sm" onClick={() => getWorkspaceController().fitComposition()}>
        <Icon name="fit" size={14} />
      </IconButton>
    </div>
  );
}
