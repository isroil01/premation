/**
 * Route C spike — the renderer half (see routeCSpike.ts). Loaded as a SECOND,
 * session-registered preload only when the dev-only spike flag is set; the
 * app's own preload.ts is unchanged and never sees `sharedTexture`.
 *
 * Runs sandboxed and context-isolated like the app preload: `sharedTexture` is
 * one of the modules a sandboxed preload is given (Electron ≥ 40), and a
 * `VideoFrame` is one of the types contextBridge can carry into the page.
 *
 * Ownership: every received texture is released exactly once. With no page
 * consumer it is released at once; with one, the page gets the frame plus a
 * `release()` it must call after drawing (the engine's ring slot is only freed
 * when every process — the GPU work included — has let go).
 */

import { contextBridge, sharedTexture } from 'electron';

type Meta = { frameIndex: number; width: number; height: number; tRenderStartUs: number; tRenderDoneUs: number };
type Consumer = (frame: VideoFrame, meta: Meta, release: () => void) => void;

let consumer: Consumer | null = null;
let received = 0;

sharedTexture.setSharedTextureReceiver(async (data, meta: Meta) => {
  received++;
  const imported = data.importedSharedTexture;
  if (!consumer) {
    imported.release();
    return;
  }
  const frame = imported.getVideoFrame();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    frame.close();
    imported.release();
  };
  try {
    consumer(frame, meta, release);
  } catch {
    release();
  }
});

contextBridge.exposeInMainWorld('premationRouteCSpike', {
  /** Receive engine frames; pass null to stop. */
  onFrame: (cb: Consumer | null) => {
    consumer = cb;
  },
  received: () => received,
});
