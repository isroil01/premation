/**
 * The editor's real implementations of `McpHostDeps`: the in-app assistant's
 * registry, transaction and tool context, and the engine's renderer for the
 * stills, filmstrips and previews Claude looks at.
 */

import { getAiRegistry } from '../AgentLoop';
import { beginAiTransaction } from '../aiTransaction';
import { createToolContext, sessionToolContext } from '../toolContext';
import { EngineTurnSession } from '../aiEngineSession';
import { renderFilmstripWindow, renderMotionSheet, renderRigView } from '../filmstrip';
import { cropStill, renderAssetSheet, renderSubjectView } from '../subjectView';
import { engine } from '@core/engine/engineInstance';
import { ENGINE_STILL_MAX, engineCompStill, engineDocumentStill, engineFootageStill } from '@core/engine/engineStill';
import { liveDocument } from '@core/project/liveDocument';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { useCompositionStore } from '@stores/compositionStore';
import { documentMirror } from '@stores/documentMirror';
import { claudeAccess } from './mcpAccess';
import type { McpHostDeps, StillOptions } from './mcpHost';

/** Base64 of a blob's bytes, without a `data:` prefix. */
async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) overflows the argument limit on a large PNG.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function asImage(blob: Blob | null): Promise<{ mimeType: string; data: string } | null> {
  if (!blob) return null;
  return { mimeType: blob.type || 'image/png', data: await blobBase64(blob) };
}

/** The crop `region` / `zoom` ask for, comp px, or null for the whole frame. */
export function cropRegion(comp: { width: number; height: number }, opts: Pick<StillOptions, 'region' | 'zoom'>): { x: number; y: number; w: number; h: number } | null {
  const base = opts.region ?? { x: 0, y: 0, w: comp.width, h: comp.height };
  if (!opts.zoom || opts.zoom <= 1) return opts.region ?? null;
  const w = base.w / opts.zoom, h = base.h / opts.zoom;
  return { x: base.x + (base.w - w) / 2, y: base.y + (base.h - h) / 2, w, h };
}

/**
 * render_frame's still: the active composition, another one, a solo of some
 * layers (a copy of the live document with those layers soloed, drawn by the
 * engine without opening it), or an asset's frame; then the crop.
 */
async function renderStillWith(seconds: number, maxSize: number, opts: StillOptions): Promise<{ mimeType: string; data: string } | { error: string } | null> {
  const m = documentMirror();
  if (opts.assetId) {
    const item = m.item(opts.assetId);
    if (!item) return { error: `No imported asset '${opts.assetId}' (list_assets).` };
    if (item.mediaType === 'audio') return { error: `'${opts.assetId}' is audio; there is no picture to render.` };
    const size = { width: item.width || 1920, height: item.height || 1080 };
    const crop = cropRegion(size, opts);
    const renderAt = crop ? Math.min(ENGINE_STILL_MAX, Math.round(maxSize * Math.max(size.width / crop.w, size.height / crop.h))) : maxSize;
    const blob = await engineFootageStill(opts.assetId, seconds, renderAt);
    return asImage(blob && crop ? await cropStill(blob, size.width, crop, maxSize) : blob);
  }
  const active = useCompositionStore.getState().comp();
  const compId = opts.compId ?? active.id;
  const settings = m.comp(compId)?.settings;
  if (opts.compId && !settings) return { error: `No composition '${opts.compId}' (list_compositions).` };
  const fps = settings ? settingsFps(settings) : active.fps || 30;
  const duration = settings ? settingsDurationSeconds(settings) : active.durationSeconds;
  const size = settings ? { width: settings.width, height: settings.height } : { width: active.width, height: active.height };
  const lastFrame = Math.max(0, Math.round(duration * fps) - 1);
  const t = Math.max(0, Math.min(Math.round(seconds * fps), lastFrame)) / fps;
  const crop = cropRegion(size, opts);
  const renderAt = crop ? Math.min(ENGINE_STILL_MAX, Math.round(maxSize * Math.max(size.width / crop.w, size.height / crop.h))) : maxSize;
  let blob: Blob | null;
  if (opts.layerIds) {
    const missing = opts.layerIds.filter((id) => !m.hasLayer(id));
    if (missing.length) return { error: `No layer ${missing.map((id) => `'${id}'`).join(', ')} (describe_scene).` };
    // Solo in a COPY of the document: the engine draws it without opening it (Versions ▸ Compare's route).
    const doc = await liveDocument();
    const solo = new Set(opts.layerIds);
    for (const n of doc.scene.nodes) n.solo = solo.has(n.id);
    blob = await engineDocumentStill(doc, t, renderAt, compId);
  } else {
    blob = await engineCompStill(compId, t, renderAt);
  }
  return asImage(blob && crop ? await cropStill(blob, size.width, crop, maxSize) : blob);
}

export function editorMcpDeps(): McpHostDeps {
  return {
    registry: () => getAiRegistry(),
    beginTransaction: (label) => beginAiTransaction(label),
    context: (session, signal, aliases) => sessionToolContext(session ?? new EngineTurnSession(engine(), 'ai'), signal, aliases),
    freshRun: (signal) => { createToolContext(signal); },
    renderStill: async (seconds, maxSize, opts) => {
      if (opts && Object.keys(opts).length > 0) {
        try {
          return await renderStillWith(seconds, maxSize, opts);
        } catch (err) {
          return { error: `Could not render: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      const c = useCompositionStore.getState().comp();
      const lastFrame = Math.max(0, Math.round(c.durationSeconds * c.fps) - 1);
      const frame = Math.max(0, Math.min(Math.round(seconds * c.fps), lastFrame));
      return asImage(await engineCompStill(c.id, frame / (c.fps || 30), maxSize));
    },
    renderStrip: async (start, end, cells) => {
      const img = await renderFilmstripWindow(start, end, cells);
      return img ? { mimeType: img.mediaType, data: img.dataBase64 } : null;
    },
    renderMotionSheet: async (input) => (await renderMotionSheet(input)).map((img) => ({ mimeType: img.mediaType, data: img.dataBase64 })),
    renderRigView: async (view) => {
      const img = await renderRigView(view);
      return img ? { mimeType: img.mediaType, data: img.dataBase64 } : null;
    },
    renderSubjectView: async (view) => {
      const img = await renderSubjectView(view);
      return img ? { mimeType: img.mediaType, data: img.dataBase64 } : null;
    },
    renderAssetSheet: async (itemId, durationSec, cells) => {
      const img = await renderAssetSheet(itemId, durationSec, cells);
      return img ? { mimeType: img.mediaType, data: img.dataBase64 } : null;
    },
    access: () => claudeAccess(),
  };
}
