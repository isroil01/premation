/**
 * muxMp4Local — offline mp4 export (RFC §12 / principle 7).
 *
 * The renderer already produces deterministic frames (offlineRenderer). This
 * streams them to the Electron main process, which muxes with a bundled ffmpeg
 * and returns the output path — no network, replacing the server frame-upload
 * render for the offline-critical path. Returns null when not on desktop (the
 * browser build keeps client-side webm/gif/png).
 */

export interface Mp4Frames {
  /** PNG-encoded frames, in order. */
  frames: Uint8Array[];
  fps: number;
  /** Optional WAV audio track. */
  audio?: Uint8Array;
}

/** True when the desktop shell can mux mp4 locally. */
export function canMuxMp4Local(): boolean {
  const r = typeof window !== 'undefined' ? window.motionEditor?.render : undefined;
  return !!(r?.beginJob && r.stageFrame && r.muxMp4);
}

export interface MuxResult {
  path: string;
  jobId: string;
}

/**
 * Stage frames + optional audio and mux to mp4 on disk. Returns the output file
 * path and jobId, or null if local muxing is unavailable (non-desktop).
 */
export async function muxMp4Local({ frames, fps, audio }: Mp4Frames): Promise<MuxResult | null> {
  const r = typeof window !== 'undefined' ? window.motionEditor?.render : undefined;
  if (!r?.beginJob || !r.stageFrame || !r.muxMp4) return null;

  const jobId = await r.beginJob();
  for (let i = 0; i < frames.length; i++) {
    await r.stageFrame(jobId, i, frames[i]!);
  }
  if (audio && r.stageAudio) await r.stageAudio(jobId, audio);

  const { path } = await r.muxMp4(jobId, { fps, hasAudio: !!audio });
  return { path, jobId };
}
