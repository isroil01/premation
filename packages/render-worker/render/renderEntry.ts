/**
 * Render entry — runs INSIDE the offscreen Electron renderer, where document,
 * canvas and WebGL2 are all real.
 *
 * It restores an EditorDocument into the live engines and drives the SAME
 * `renderOffline` loop a desktop export uses, so an automation render and a
 * hand-made export are the same pixels by construction rather than by
 * agreement. Frames are streamed to the main process one at a time; nothing is
 * accumulated in renderer memory, because a 30s 1080p render is ~900 frames and
 * holding them would be gigabytes.
 *
 * The window is DESTROYED after each job (see electron/main.cjs). That is not
 * tidiness: `restoreDocument` is a MERGE — it applies only the keys a document
 * carries — so a second job in the same JS context would silently inherit the
 * previous document's timelines, comps and motion-blur settings. A fresh
 * context is the only way "render exactly this document" is true.
 */

import { restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { renderOffline } from '@core/export/offlineRenderer';
import { useProjectStore } from '@stores/projectStore';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import type { CompositionSettings } from '@stores/projectStore';

export interface RenderJobSpec {
  document: EditorDocument;
  output: { width?: number; height?: number; fps?: number };
  /** Authoritative when present — the template's duration, sent by motion-back. */
  durationSeconds?: number;
}

interface RenderBridge {
  job: () => Promise<RenderJobSpec>;
  /** Streams one encoded frame to main. Resolves once written to disk. */
  frame: (index: number, base64: string, ext: 'jpg' | 'png') => Promise<void>;
  progress: (done: number, total: number) => void;
  done: (result: { frames: number; ext: 'jpg' | 'png'; fps: number } | null, error?: string) => Promise<void>;
}

declare global {
  interface Window {
    renderBridge: RenderBridge;
  }
}

/**
 * The composition this document renders.
 *
 * A document carries a MAP of comps, not one — and in a headless context there
 * is no active workspace tab to ask, so `useCompositionStore` would answer with
 * its defaults and quietly render a 1920×1080 10s black frame for a 1080×1920
 * 6s template. Prefer the tab if the document restored one, then the single
 * comp when there is exactly one, then the first. Only a document with no comps
 * at all falls back to defaults.
 */
function activeComp(): CompositionSettings {
  const state = useProjectStore.getState();
  const fromTab = state.activeTabId ? state.comps[state.tabs[state.activeTabId]?.compositionId ?? ''] : undefined;
  if (fromTab) return fromTab;
  const all = Object.values(state.comps ?? {});
  return all[0] ?? DEFAULT_COMPOSITION;
}

/**
 * The comp as mp4 can actually deliver it: opaque.
 *
 * mp4 has no alpha channel, so a transparent comp must be flattened somewhere.
 * Doing it HERE — by letting the renderer paint the comp's own background —
 * rather than in an ffmpeg filter means the flatten uses the colour the author
 * chose and sees in the editor. Discarding alpha at the encoder instead keeps
 * semi-transparent pixels at full strength over black, which is not a
 * composite and does not match the preview.
 */
function deliverableComp(comp: CompositionSettings): CompositionSettings {
  return comp.transparent ? { ...comp, transparent: false } : comp;
}

function encodeFrame(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL('image/jpeg', 0.94);
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('canvas.toDataURL produced no payload');
  return url.slice(comma + 1);
}

async function main(): Promise<void> {
  try {
    const spec = await window.renderBridge.job();
    if (!spec?.document) throw new Error('No document was supplied to the renderer.');

    // Throws DocumentVersionError for a document newer than this worker's
    // schema. Deliberately not swallowed: rendering a partially-understood
    // document produces a plausible video that is silently wrong, which is the
    // one outcome worse than a failed job.
    restoreDocument(spec.document);

    const comp = activeComp();
    const width = spec.output?.width ?? comp.width;
    const height = spec.output?.height ?? comp.height;
    const fps = spec.output?.fps ?? comp.fps;
    const durationSec = spec.durationSeconds ?? comp.durationSeconds;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error(`Refusing to render a ${durationSec}s composition.`);
    }

    let staged = 0;
    const frames = await renderOffline(
      { width, height, fps, durationSec, comp: deliverableComp(comp) },
      async (canvas, frame, total) => {
        await window.renderBridge.frame(frame, encodeFrame(canvas), 'jpg');
        staged += 1;
        window.renderBridge.progress(staged, total);
      },
    );

    // `renderOffline` throws on a diagnostic rather than delivering a frame it
    // knows is wrong, so reaching here with a short count means a sink dropped
    // one — which would splice the video silently shorter at the mux step.
    if (staged !== frames) {
      throw new Error(`Staged ${staged} of ${frames} frames.`);
    }
    await window.renderBridge.done({ frames, ext: 'jpg', fps });
  } catch (err) {
    await window.renderBridge.done(null, (err as Error)?.stack ?? String(err));
  }
}

void main();
