/**
 * "Render on server" — hand the current composition to motion-back and let the
 * render worker produce the file, with this editor only watching.
 *
 * The other two export actions rasterize HERE: the immediate export and the
 * Render Queue both run the offline renderer in this process and, on the
 * desktop, encode with the bundled ffmpeg. That is right for most work and
 * useless for two cases — a long 4K master that would pin a laptop for an
 * hour, and a machine that must be closed before the render is done. A
 * server render is queued from the project the cloud already holds
 * (`source: 'document'`), so nothing is uploaded, and it keeps going after
 * this window is gone.
 *
 * Availability is a deployment fact, not an edition fact: the server says
 * whether it has a render worker (`GET /render/capabilities`), and the button
 * exists only when it does and the project lives in the cloud.
 */

import { catalogEffect } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { pluginsUsedByDocument } from '@core/project/missingPluginContent';
import { api, isAuthenticated, type RenderCapabilities, type RenderCodec, type RenderContainer, type RenderJobDto, type RenderQuality } from '@core/api/client';
import { cloudProjectsEnabled } from '@core/config/edition';
import { getCloudProjectId } from '@stores/cloudProjectStore';
import { useUIStore } from '@stores/uiStore';
import type { ExportFormat } from '@core/export/exportManager';
import type { ExportQuality, ProresProfile } from '@core/export/renderSpec';

export interface ServerEncode {
  format: RenderContainer;
  codec: RenderCodec;
  quality: RenderQuality;
}

/**
 * The server's name for what the form chose, or null when the server has no
 * equivalent (HDR, image sequences, a ProRes profile other than 4444).
 */
export function serverEncodeFor(
  format: ExportFormat,
  quality: ExportQuality,
  proresProfile: ProresProfile,
  caps: RenderCapabilities | null,
): ServerEncode | null {
  const q: RenderQuality = quality === 'high' ? 'high' : quality === 'draft' ? 'draft' : 'standard';
  let pick: { format: RenderContainer; codec: RenderCodec } | null = null;
  switch (format) {
    case 'mp4': pick = { format: 'mp4', codec: 'h264' }; break;
    case 'webm': pick = { format: 'webm', codec: 'vp9' }; break;
    case 'gif': pick = { format: 'gif', codec: 'gif' }; break;
    case 'mov':
      // The server matrix carries one ProRes flavour — the mezzanine.
      pick = proresProfile === '4444' ? { format: 'mov', codec: 'prores4444' } : { format: 'mov', codec: 'h264' };
      break;
    default: return null;
  }
  if (caps && !caps.containers[pick.format]?.includes(pick.codec)) return null;
  return { ...pick, quality: q };
}

let capsPromise: Promise<RenderCapabilities | null> | null = null;

/** The deployment's render capabilities, fetched once per session; null when unreachable or signed out. */
export function loadRenderCapabilities(): Promise<RenderCapabilities | null> {
  if (!cloudProjectsEnabled() || !isAuthenticated()) return Promise.resolve(null);
  if (!capsPromise) {
    capsPromise = api.getRenderCapabilities().catch(() => {
      capsPromise = null;
      return null;
    });
  }
  return capsPromise;
}

/** Whether "Render on server" can be offered at all right now. */
export function serverRenderAvailable(caps: RenderCapabilities | null): boolean {
  return Boolean(caps?.sources.document) && !!getCloudProjectId();
}

const POLL_MS = 3000;
const TERMINAL = new Set<RenderJobDto['status']>(['completed', 'failed', 'canceled']);

export interface ServerRenderRequest {
  encode: ServerEncode;
  width: number;
  height: number;
  fps: number;
  duration: number;
  transparent: boolean;
  outputName: string;
}

/**
 * Queue the render and follow it in the job tray until it finishes.
 *
 * Progress comes from polling the job — the server has no push channel and
 * needs none for a render that takes minutes. The finished file is offered as
 * a "Download" action on the completion toast; the Dashboard's Renders list
 * has it too, for as long as the account keeps it.
 */
export async function renderOnServer(req: ServerRenderRequest): Promise<void> {
  const projectId = getCloudProjectId();
  if (!projectId) {
    useUIStore.getState().notify({ level: 'warning', message: 'Open a cloud project to render on the server.', durationMs: 4000 });
    return;
  }
  // The server's render worker runs no plugins (they run on this computer
  // only). Refuse a project that uses plugin effects, naming them, rather than
  // render it with the effects missing.
  const usedPlugins = await pluginsUsedByDocument(engine(), (t) => catalogEffect(t) !== undefined);
  if (usedPlugins && usedPlugins.length > 0) {
    useUIStore.getState().notify({
      level: 'warning',
      message: `This project uses plugin effects (${usedPlugins.join(', ')}), which only render on this computer. Export it here instead of on the server.`,
      durationMs: 8000,
    });
    return;
  }
  const ui = useUIStore.getState();
  const jobId = `server-render-${Date.now()}`;
  ui.startJob({ id: jobId, label: `Rendering ${req.outputName} on the server`, progress: 0 });
  try {
    const job = await api.createRender({
      format: req.encode.format,
      codec: req.encode.codec,
      quality: req.encode.quality,
      source: 'document',
      projectId,
      width: req.width,
      height: req.height,
      fps: req.fps,
      duration: req.duration,
      transparent: req.transparent,
    });
    const final = await followJob(job.id, (p) => useUIStore.getState().updateJob(jobId, { progress: p }));
    if (final.status === 'completed' && final.resultUrl) {
      const url = final.resultUrl;
      useUIStore.getState().finishJob(jobId, {
        status: 'done',
        message: `Server render complete — ${req.outputName}`,
        action: { label: 'Download', onSelect: () => { window.open(url, '_blank', 'noopener'); } },
      });
    } else if (final.status === 'canceled') {
      useUIStore.getState().finishJob(jobId, { status: 'cancelled', message: 'Server render cancelled' });
    } else {
      useUIStore.getState().finishJob(jobId, { status: 'failed', message: final.error || 'Server render failed' });
    }
  } catch (err) {
    useUIStore.getState().finishJob(jobId, {
      status: 'failed',
      message: err instanceof Error ? err.message : 'Could not queue the server render',
    });
  }
}

async function followJob(id: string, onProgress: (p: number) => void): Promise<RenderJobDto> {
  for (;;) {
    const job = await api.getRender(id);
    onProgress(Math.max(0, Math.min(1, job.progress ?? 0)));
    if (TERMINAL.has(job.status)) return job;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
