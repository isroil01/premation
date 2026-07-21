/**
 * The agent's eyes.
 *
 * The loop authors motion blind — it never sees what it made, so it can't tell
 * whether the result looks any good. This renders the current scene to a few
 * still frames and hands them back to the model as images, so it can review its
 * own work like a designer looking at the screen, and fix what's off before it
 * answers.
 *
 * It reuses the exact deterministic offline path that "Save Frame As" and video
 * export use (`renderStillFrame`), so the frames the model sees match what the
 * user will see. Everything here is best-effort: a render failure (headless, a
 * hidden tab, a backend hiccup) must never break the run — it just means no
 * visual feedback this pass.
 */

import type { AiImage } from '@motion/ai-tools';
import { useCompositionStore } from '@stores/compositionStore';
import { renderStillFrame } from '@core/export/offlineRenderer';
import { processImageFile } from './imageAttachment';

/** A frame render can hang in a backgrounded tab — never let it stall the run. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * Representative comp-times to review: after the entrances have landed, the
 * middle, and the final held frame. One frame back from the end so we sample a
 * settled pose, not a transition mid-flight.
 */
export function critiqueTimes(durationSec: number, fps: number): number[] {
  if (!(durationSec > 0)) return [0];
  const last = Math.max(0, durationSec - 1 / Math.max(1, fps));
  return [durationSec * 0.35, durationSec * 0.7, last];
}

/**
 * Render the current scene at the given comp-times to model-ready images.
 * Never throws; returns as many frames as rendered successfully (possibly none).
 */
export async function renderSceneFrames(timesSec: number[]): Promise<AiImage[]> {
  const out: AiImage[] = [];
  try {
    const c = useCompositionStore.getState().comp();
    const params = {
      width: c.width,
      height: c.height,
      fps: c.fps,
      durationSec: c.durationSeconds,
      comp: { ...c, rootId: c.id },
    };
    const lastFrame = Math.max(0, Math.round(c.durationSeconds * c.fps) - 1);
    for (const t of timesSec) {
      const frame = Math.max(0, Math.min(Math.round(t * c.fps), lastFrame));
      const blob = await withTimeout(renderStillFrame(params, frame, 'image/jpeg', 0.85), 8000);
      if (!blob) continue;
      // processImageFile downscales to 1280px JPEG — the same treatment user
      // reference images get, so the frame is well within provider limits.
      const img = await processImageFile(blob);
      if (img) out.push({ mediaType: img.mediaType, dataBase64: img.dataBase64 });
    }
  } catch {
    return out;
  }
  return out;
}
