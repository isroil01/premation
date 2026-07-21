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

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode, type KeyboardEvent } from 'react';
import { cn } from '@utils/cn';
import { useActiveWorkspace, useWorkspaceStore } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceViewStore } from '@stores/workspaceViewStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { hasCanvasDrag, readCanvasDrag } from '@core/dnd/canvasDrag';
import {
  insertShape,
  insertText,
  insertMedia,
  setNodeWorldPosition,
  insertCursorLibraryItem,
  insertMotionGraphicLibraryItem,
  insertTransitionLibraryItem,
  insertSoundFxLibraryItem,
  insertLottieLibraryItem
} from '@core/scene/sceneInsert';
import { useAssetStore } from '@stores/assetStore';
import { useComponentStore } from '@stores/componentStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { addEffect } from '@core/effects/effects';
import { applyPresetByName } from '@core/animation/animationPresets';
import { insertAnimPreset } from '@core/template/animPresets';

import { ViewportHeader } from './ViewportHeader';
import { FocusBreadcrumb } from '@layout/focus/FocusBreadcrumb';
import { TextEditOverlay } from './TextEditOverlay';
import { PuppetOverlay } from './PuppetOverlay';
import { BoneOverlay } from './BoneOverlay';
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
  const workspaceMode = useWorkspaceViewStore((s) => s.mode);

  // Keep the engine camera's lock in sync with the persisted workspace mode.
  // The composition framing itself rides on the engine's normal first-fit, so
  // this only has to (re)apply the lock — including after a reload in 'fixed'.
  useEffect(() => {
    getWorkspaceController().ws.camera.setLocked(workspaceMode === 'fixed');
    getWorkspaceController().requestRender();
  }, [workspaceMode]);

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
        // Handled globally (tap = play, hold + drag = pan) — see useSpaceTransport.
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

  const onKeyUp = useCallback((_e: KeyboardEvent<HTMLDivElement>): void => {
    // Space is handled globally; nothing else needs key-up here.
  }, []);

  // ── Drag-and-drop from the library panels onto the canvas (AE-style) ──
  const [dragOver, setDragOver] = useState(false);

  const onDragOverCanvas = useCallback((e: DragEvent<HTMLDivElement>): void => {
    if (!hasCanvasDrag(e)) return; // let unrelated drags (tab reorder, files) pass
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, []);

  const onDragLeaveCanvas = useCallback((e: DragEvent<HTMLDivElement>): void => {
    // Only clear when the pointer actually leaves the viewport, not when it
    // crosses between child elements (which also fire dragleave).
    if (e.currentTarget === e.target) setDragOver(false);
  }, []);

  const onDropCanvas = useCallback(async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    const payload = readCanvasDrag(e);
    setDragOver(false);
    if (!payload) return; // not one of ours
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const controller = getWorkspaceController();
    const world = controller.ws.screenToWorld(local);

    // The insert helpers select the new node; land it under the cursor.
    const placeSelection = (): void => {
      const id = useSelectionStore.getState().ids[0];
      if (id) setNodeWorldPosition(id, world.x, world.y);
    };

    switch (payload.kind) {
      case 'shape':
        insertShape(payload.primitive, payload.label);
        placeSelection();
        break;
      case 'text':
        insertText(payload.label, payload.fontSize, payload.weight, payload.extra ?? {});
        placeSelection();
        break;
      case 'asset': {
        const asset = useAssetStore.getState().assets.find((a) => a.id === payload.assetId);
        if (asset) {
          await insertMedia(asset);
          placeSelection();
        }
        break;
      }
      case 'component': {
        const gid = useComponentStore.getState().insert(payload.componentId);
        if (gid) setNodeWorldPosition(gid, world.x, world.y);
        break;
      }
      case 'effect': {
        // Effects apply to a layer — target the one under the cursor (AE-style).
        const node = controller.ws.hitTestScreen(local);
        if (node) addEffect(node.id, payload.effectType);
        else useUIStore.getState().notify({ level: 'warning', message: 'Drop an effect onto a layer.', durationMs: 2400 });
        break;
      }
      case 'motionPreset': {
        const node = controller.ws.hitTestScreen(local);
        if (node) {
          const ws = useWorkspaceStore.getState();
          const playhead = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
          applyPresetByName(node.id, payload.name, playhead);
        } else {
          useUIStore.getState().notify({ level: 'warning', message: 'Drop a motion preset onto a layer.', durationMs: 2400 });
        }
        break;
      }
      case 'animPreset':
        // A self-contained animated element — insert at the drop point.
        insertAnimPreset(payload.presetId, world.x, world.y);
        break;
      case 'cursor':
        insertCursorLibraryItem(payload.cursorId, payload.name, world.x, world.y);
        break;
      case 'mograph':
        insertMotionGraphicLibraryItem(payload.mographId, payload.name, world.x, world.y);
        break;
      case 'transition':
        insertTransitionLibraryItem(payload.transId, payload.name);
        break;
      case 'sfx':
        insertSoundFxLibraryItem(payload.sfxId, payload.name);
        break;
      case 'lottie':
        insertLottieLibraryItem(payload.lottieId, payload.name, world.x, world.y);
        break;
    }
  }, []);


  return (
    <div className={cn(styles.wrapper, className)}>
      {/* AE-style composition panel header */}
      <ViewportHeader />

      {/* Canvas viewport */}
      <div
        className={styles.root}
        data-workspace-viewport=""
        data-drag-over={dragOver || undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onDragOver={onDragOverCanvas}
        onDragLeave={onDragLeaveCanvas}
        onDrop={onDropCanvas}
        style={dragOver ? { outline: '2px solid var(--color-primary)', outlineOffset: '-2px' } : undefined}
      >
        <div
          className={transparent ? styles.stageTransparent : styles.stage}
          ref={stageRef}
        >
          <canvas ref={canvasRef} className={styles.canvas} />
          <canvas ref={overlayRef} className={styles.overlay} data-workspace-overlay="" />
          {/* On-canvas text editor — screen coords match the canvas' own space. */}
          <TextEditOverlay />
          <PuppetOverlay />
          <BoneOverlay />
        </div>

        {/* Corner overlays */}
        <div className={styles.overlayTL}>{topLeft}</div>
        <div className={styles.overlayTR}>{topRight}</div>
        <div className={styles.overlayBL}>
          {bottomLeft}
        </div>
        <div className={styles.overlayBR}>{bottomRight}</div>

        <FocusBreadcrumb />
      </div>
    </div>
  );
}

// ViewportZoomControls was removed — zoom lives in the ViewportHeader bar.
