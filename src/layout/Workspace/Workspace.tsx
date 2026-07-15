/**
 * Workspace / WorkspaceViewport — the central editor viewport.
 *
 * Structure (AE-style):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ ViewportHeader  (comp name · W×H · FPS · BG · zoom)     │ ← 28px
 *   ├──────────────────────────────────────────────────────────┤
 *   │                                                          │
 *   │   Stage (dot-grid / checkerboard void)                   │
 *   │     ┌──────────────────────────┐                        │
 *   │     │  Composition canvas      │  ← framed with shadow  │
 *   │     │  (canvas + overlay)      │                        │
 *   │     └──────────────────────────┘                        │
 *   │                                                          │
 *   │  [TL overlay]              [TR overlay]                  │
 *   │  [BL: info bar]            [BR: zoom controls]          │
 *   │          [BC: AI prompt]                                 │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Interaction and rendering are handled by the framework-independent
 * `@motion/workspace` engine via {@link useWorkspace}.
 */

import { useCallback, useRef, type ReactNode, type KeyboardEvent } from 'react';
import { cn } from '@utils/cn';
import { keyFrom } from '@motion/workspace';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { AiPromptBar } from './AiPromptBar';
import { ViewportHeader } from './ViewportHeader';
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

/** Keys the viewport handles directly. */
const VIEWPORT_KEYS = new Set([
  'Space', 'Delete', 'Backspace', 'Escape',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
]);

export function WorkspaceViewport({
  topLeft,
  topRight,
  bottomLeft,
  bottomRight,
  className,
}: WorkspaceViewportProps): JSX.Element {
  const time     = useActiveWorkspace()?.time ?? 0;
  const sceneRev = useSceneRevision((s) => s.rev);
  const transparent = useCompositionStore((s) => s.transparent);
  const compW    = useCompositionStore((s) => s.width);
  const compH    = useCompositionStore((s) => s.height);
  const compFps  = useCompositionStore((s) => s.fps);

  const stageRef   = useRef<HTMLDivElement | null>(null);
  const canvasRef  = useRef<HTMLCanvasElement | null>(null);
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
    const target = e.target as HTMLElement | null;
    if (
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable
    ) {
      return;
    }
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
        const dy = e.code === 'ArrowUp'   ? -step : e.code === 'ArrowDown'  ? step : 0;
        controller.nudgeSelection(dx, dy);
        break;
      }
    }
  }, []);

  const onKeyUp = useCallback((e: KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement | null;
    if (
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable
    ) {
      return;
    }
    if (e.code === 'Space') getWorkspaceController().ws.feedKeyUp(keyFrom(e, performance.now()));
  }, []);

  return (
    <div className={cn(styles.wrapper, className)}>
      {/* AE-style composition panel header */}
      <ViewportHeader />

      {/* Canvas viewport */}
      <div
        className={styles.root}
        data-workspace-viewport=""
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        <div
          className={transparent ? styles.stageTransparent : styles.stage}
          ref={stageRef}
        >
          <canvas ref={canvasRef}  className={styles.canvas}  />
          <canvas ref={overlayRef} className={styles.overlay} data-workspace-overlay="" />
        </div>

        {/* Corner overlays */}
        <div className={styles.overlayTL}>{topLeft}</div>
        <div className={styles.overlayTR}>{topRight}</div>
        <div className={styles.overlayBL}>
          {bottomLeft ?? <ViewportInfoBar compW={compW} compH={compH} fps={compFps} transparent={transparent} />}
        </div>
        <div className={styles.overlayBR}>{bottomRight}</div>
        <div className={styles.overlayBC}><AiPromptBar /></div>

        <FocusBreadcrumb />
      </div>
    </div>
  );
}

// ── Viewport info bar (bottom-left) ──────────────────────────────────
function ViewportInfoBar({
  compW,
  compH,
  fps,
  transparent,
}: {
  compW: number;
  compH: number;
  fps: number;
  transparent: boolean;
}): JSX.Element {
  return (
    <div className={styles.infoBar}>
      <span className={styles.infoHighlight}>{compW}<span style={{ color: '#444' }}>×</span>{compH}</span>
      <span>{fps} fps</span>
      {transparent && <span style={{ color: '#4cdf8e' }}>α</span>}
    </div>
  );
}

// ViewportZoomControls was removed — zoom lives in the ViewportHeader bar.
