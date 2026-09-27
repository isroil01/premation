/**
 * useLayerViewerRenderer — the Layer panel's own renderer.
 *
 * One AUXILIARY backend on the panel's canvas, kept alive for as long as the
 * canvas is — never rebuilt per layer. A page gets ~16 live GPU contexts and
 * the browser evicts the OLDEST first, which is the main viewport's; creating
 * one per opened layer would eventually cost the user their composition view.
 *
 * Each frame is an ordinary `buildSnapshot` scoped to the layer (`rootId`)
 * with `layerView` set, so the renderer itself draws the layer alone and
 * untransformed at its own size — see `SnapshotComp.layerView`.
 *
 * The backend is 'auxiliary', so it has a private exact-decode cache that
 * raises no repaint events: a video frame that is still decoding would leave a
 * stale picture. `lastFrameMediaExact()` tells us, and we try again shortly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRenderBackend } from '@core/rendering/createRenderBackend';
import type { RenderBackend } from '@core/rendering/RenderBackend';
import { onPageFrameChanged, pageFrameSnapshot } from '@core/rendering/pageFrame';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { activeCompIdNow } from '@hooks/useMirror';
import { compRecordFromSettings } from '@core/mirror/compFacts';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useProjectStore } from '@stores/projectStore';

export interface LayerViewerRenderParams {
  nodeId: string | null;
  /** AE's "Render" checkbox — masks and effects on. */
  render: boolean;
  /** The layer's own frame (its size). */
  frameWidth: number;
  frameHeight: number;
  /** Comp time to sample the layer's animation at. */
  compTime: number;
  /** Pin the media frame, in layer time (a scrub past the comp's range). */
  sourceTime?: number;
}

/** Retries for a media frame still decoding (60ms apart ≈ 2s). */
const MEDIA_RETRIES = 30;

export function useLayerViewerRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  params: LayerViewerRenderParams,
): { initError: string | null } {
  const backendRef = useRef<RenderBackend | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const rafIdRef = useRef<number | null>(null);
  const retryRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; left: number }>({ timer: null, left: 0 });

  const playing = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.playing ?? false : false));
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const useProxies = usePreferenceStore((s) => s.useProxies);
  const useProxiesRef = useRef(useProxies);
  useProxiesRef.current = useProxies;

  const renderImmediate = useCallback((): void => {
    const b = backendRef.current;
    const p = paramsRef.current;
    try {
      // B4: the layer's existence and the active composition's record from the
      // mirror; the frame from the TypeScript engine's seam (core/rendering/pageFrame).
      if (!b || !p.nodeId || !documentMirror().layer(p.nodeId)) return;
      const s = activeCompSettingsNow();
      const id = activeCompIdNow();
      const comp = s && id ? compRecordFromSettings(id, s) : DEFAULT_COMPOSITION;
      b.setPlaybackMode?.(playingRef.current);
      b.renderFrame(pageFrameSnapshot({
        time: p.compTime,
        comp: { ...comp, width: Math.max(1, p.frameWidth), height: Math.max(1, p.frameHeight) },
        rootId: p.nodeId,
        // The Layer panel shows the layer, not the comp: no background plate,
        // and no scene camera or custom view reaches it.
        viewMode: 'active',
        alpha: true,
        useProxies: useProxiesRef.current,
        extra: {
          customViewCamera: undefined,
          layerView: {
            id: p.nodeId,
            render: p.render,
            ...(p.sourceTime !== undefined ? { sourceTime: p.sourceTime } : {}),
          },
        },
      }));
      // A frame drawn before its video decoded is stale; nothing will tell
      // this backend when the decode lands, so look again shortly.
      const retry = retryRef.current;
      if (b.lastFrameMediaExact?.() === false && retry.left > 0 && retry.timer === null) {
        retry.left -= 1;
        retry.timer = setTimeout(() => {
          retry.timer = null;
          render();
        }, 60);
      }
    } catch (err) {
      console.error('[LayerViewer] render failed:', err);
    } finally {
      rafIdRef.current = null;
    }
    // `render` is declared below and stable; referenced lazily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const render = useCallback((): void => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => renderImmediate());
  }, [renderImmediate]);

  // Attach once per canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const backend = createRenderBackend('auto', 'auxiliary');
    backend.attach(canvas);
    backendRef.current = backend;

    const doResize = (): void => {
      const r = container.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      backend.resize(r.width, r.height, Math.min(window.devicePixelRatio || 1, 2));
      render();
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(container);
    doResize();

    let cancelled = false;
    const retry = retryRef.current;
    backend.readyPromise?.then(() => {
      if (cancelled) return;
      if (backend.initFailed) {
        setInitError(
          backend.initErrorMessage
            ?? 'The Layer panel could not get a GPU context. Closing other previews or GPU-heavy tabs usually frees one.',
        );
        return;
      }
      setInitError(null);
      doResize();
    });

    // Repaint when the engine's frame may have changed, and on any document batch.
    const subs = [
      onPageFrameChanged(() => render()),
      documentMirror().subscribe(['doc'], () => render()),
    ];
    return () => {
      cancelled = true;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      if (retry.timer !== null) clearTimeout(retry.timer);
      retry.timer = null;
      ro.disconnect();
      for (const off of subs) off();
      backend.dispose();
      backendRef.current = null;
    };
  }, [canvasRef, containerRef, render]);

  // Repaint whenever what is on show changes — and give a fresh frame its own
  // budget of decode retries.
  useEffect(() => {
    retryRef.current.left = MEDIA_RETRIES;
    render();
  }, [params.nodeId, params.render, params.frameWidth, params.frameHeight, params.compTime, params.sourceTime, render]);

  return { initError };
}
