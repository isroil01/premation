/**
 * The window's engine frames, routed by viewport (docs/VIEWPORT_ROUTE.md).
 *
 * The preload keeps ONE frame consumer per window (`bridge.onFrame`), and a
 * window can show several engine viewports at once — the main viewport and
 * the 2-up / 4-up panes, each on its own engine viewport id. This hub is that
 * one consumer: a surface subscribes under its viewport id and gets only its
 * frames; a frame nobody subscribed goes straight back to the engine. The
 * bridge consumer is installed with the first subscriber and removed with the
 * last (the preload tells main the receiver is ready / gone with it).
 *
 * Viewport ids: main hands each window a base (`viewportBase`, 0 for the
 * editor window); the main viewport is base + 1 (EngineSurface's
 * ENGINE_SURFACE_VIEWPORT) and the panes take base + 2 … from here.
 */

import type { EngineFrameConsumer } from '@motion/engine-api';
import { processEngineBridge } from '@core/engine/process/processEngine';

/** The main viewport's index within a window (EngineSurface ENGINE_SURFACE_VIEWPORT; not imported — EngineSurface imports this hub). */
const MAIN_VIEWPORT_INDEX = 1;

const handlers = new Map<number, EngineFrameConsumer>();
let installed = false;

const dispatch: EngineFrameConsumer = (frame, meta, release) => {
  const h = handlers.get(meta.viewport);
  if (h) h(frame, meta, release);
  else release();
};

/** Receive the frames of `viewport` (one handler per viewport; a later subscriber replaces an earlier one). */
export function subscribeEngineFrames(viewport: number, handler: EngineFrameConsumer): () => void {
  handlers.set(viewport, handler);
  const bridge = processEngineBridge();
  if (!installed && bridge?.onFrame) {
    installed = true;
    bridge.onFrame(dispatch);
  }
  return () => {
    if (handlers.get(viewport) === handler) handlers.delete(viewport);
    if (handlers.size === 0 && installed) {
      installed = false;
      processEngineBridge()?.onFrame?.(null);
    }
  };
}

const paneIds = new Set<number>();

/** A free engine viewport id for a pane of this window (base + 2 …); release it with `releasePaneViewport`. */
export async function allocatePaneViewport(): Promise<number> {
  let base = 0;
  try {
    base = (await processEngineBridge()?.viewportBase?.()) ?? 0;
  } catch {
    base = 0;
  }
  for (let i = MAIN_VIEWPORT_INDEX + 1; i < 256; i += 1) {
    const id = base + i;
    if (!paneIds.has(id)) {
      paneIds.add(id);
      return id;
    }
  }
  throw new Error('no free engine viewport in this window');
}

export function releasePaneViewport(viewport: number): void {
  paneIds.delete(viewport);
}
