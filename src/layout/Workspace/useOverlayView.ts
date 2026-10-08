/**
 * The comp → canvas transform (RenderView: canvasPx = compPx·scale + offset)
 * a viewport's SVG overlays are drawn with — the 3D gizmo, the scene's layer
 * boxes and camera / light wireframes (useGizmo3d → Gizmo3dOverlay), the focus
 * plane — in React state for the drawing, and readable at call time for their
 * pointer handlers (`read`), so a hit test measures against what is drawn.
 *
 * ## The main viewport (no `getView`)
 *
 * The view of the frame ON SCREEN (core/workspace/displayedView.ts): the
 * overlays move with the picture, not ahead of it. Re-read when a frame lands
 * (it may have been drawn with a new view) and on the workspace's render tick
 * (every pan, zoom, fit, framing restore and resize requests one — without an
 * engine frame the live camera IS the displayed view).
 *
 * It used to re-read ONLY on window wheel / pointermove / pointerup. Every
 * framing change no pointer event announces — the `1` / `2` view-switch keys
 * restoring that view's pan and zoom, the eased Alt+wheel dolly still gliding
 * ~20 frames after the last wheel tick, the auto-fit after a panel resize — left
 * the gizmo, the layer boxes and the light lines at the OLD framing over a
 * picture drawn at the new one, until the mouse happened to move.
 *
 * ## A pane (`getView`)
 *
 * Its own live camera, re-read on pointer / wheel input (rAF-coalesced) and
 * whenever the pane bumps `viewRev` — a re-frame no pointer event announces
 * (auto-fit on resize).
 *
 * No React render per frame: every trigger compares the three numbers and sets
 * state only when they changed. On the main viewport's per-frame triggers the
 * read is the frame's own RenderView object (nothing allocated); only without
 * an engine frame does it build the controller's live view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAIN_VIEWPORT, subscribeOverlayGeometry } from '@stores/overlayGeometry';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { displayedRenderView } from '@core/workspace/displayedView';
import type { RenderView } from '@core/workspace/renderView';
import type { Camera2DLike } from './cameraTypes';

/** Identity view — the fallback while a pane's camera does not exist yet. */
export const IDENTITY_VIEW: RenderView = { scale: 1, offsetX: 0, offsetY: 0 };

export interface OverlayView {
  /** The transform to draw with (state: a change re-renders the overlay). */
  view: RenderView;
  /** The same transform at call time, for pointer handlers (stable identity). */
  read: () => RenderView;
}

export function useOverlayView(getView?: () => RenderView | undefined, viewRev = 0): OverlayView {
  const main = getView === undefined;
  // Behind a ref so a host re-rendering with a fresh closure neither re-attaches
  // the listeners nor hands its pointer handlers a stale reader.
  const readRef = useRef<() => RenderView>(displayedRenderView);
  readRef.current = getView ? (): RenderView => getView() ?? IDENTITY_VIEW : displayedRenderView;
  const [view, setView] = useState<RenderView>(() => readRef.current());
  /** What `view` holds — compared against without a state updater closure per trigger. */
  const shownRef = useRef(view);

  useEffect(() => {
    const sync = (): void => {
      const v = readRef.current();
      const shown = shownRef.current;
      if (shown.scale === v.scale && shown.offsetX === v.offsetX && shown.offsetY === v.offsetY) return;
      shownRef.current = v;
      setView(v);
    };
    sync();
    if (main) {
      // A drawn frame landed: the picture may now be of another view.
      const offFrame = subscribeOverlayGeometry(MAIN_VIEWPORT, sync);
      // The workspace camera moved (its changes all request a render tick).
      const offRender = getWorkspaceController().onRender(sync);
      return () => {
        offFrame();
        offRender();
      };
    }
    // A pane: its camera follows the pointer (wheel zoom, middle-drag pan).
    // Coalesced to one read per animation frame — wheel and pointermove fire
    // well above frame rate.
    let rafId: number | null = null;
    const queueSync = (): void => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        sync();
      });
    };
    window.addEventListener('wheel', queueSync, { passive: true, capture: true });
    window.addEventListener('pointermove', queueSync, { capture: true });
    window.addEventListener('pointerup', queueSync, { capture: true });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('wheel', queueSync, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointermove', queueSync, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointerup', queueSync, { capture: true } as EventListenerOptions);
    };
    // `viewRev` re-syncs a pane for framing changes no pointer event announces;
    // the reader itself lives in a ref.
  }, [main, viewRev]);

  const read = useCallback((): RenderView => readRef.current(), []);
  return { view, read };
}

/** A comp ↔ screen mapping a layer overlay maps through, with its zoom (screen px per comp px). */
export interface DisplayedCamera2D extends Camera2DLike {
  zoom: number;
}

/** A comp → stage RenderView as the comp ↔ screen mapping a layer overlay maps through. */
export function camera2DOf(v: RenderView): DisplayedCamera2D {
  const s = v.scale || 1;
  return {
    zoom: v.scale,
    worldToScreen: (p) => ({ x: p.x * v.scale + v.offsetX, y: p.y * v.scale + v.offsetY }),
    screenToWorld: (p) => ({ x: (p.x - v.offsetX) / s, y: (p.y - v.offsetY) / s }),
  };
}

/**
 * The MAIN viewport's comp ↔ stage mapping as the frame on screen is drawn —
 * what the layer-attached overlays (effect and gradient handles, track points,
 * roto strokes, the liquify brush, puppet pins, bones) map through —
 * re-rendering the caller when it changes; a new object only then, so it is a
 * memo dependency.
 *
 * Those overlays used to read the workspace camera live but re-render on no
 * camera change at all: after a pan, a zoom or a framing restore their handles
 * stayed where the old view had put them until something unrelated re-rendered.
 */
export function useDisplayedCamera2D(): DisplayedCamera2D {
  const { view } = useOverlayView();
  return useMemo(() => camera2DOf(view), [view]);
}
