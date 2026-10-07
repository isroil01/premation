/**
 * The preview video provider: a free, local stand-in for text-to-video.
 *
 * No fal.ai key exists for this build yet, and a paid clip is the last thing
 * to spend while the composition around it is still being designed. So the
 * preview model (`PREVIEW_VIDEO_MODEL`) answers every request with the same
 * small real clip (aiMediaMockClip.ts): it imports, decodes, trims, scales and
 * plays like footage, so layout, timing and the critique loop all work on a
 * piece built around generated video — and swapping in a real model later
 * changes the pixels, not the pipeline.
 *
 * Deterministic: the bytes do not depend on the prompt, so a replayed eval
 * run builds the same scene.
 */

import type { AiMediaResult } from '@app-types/motionEditor';
import { PREVIEW_CLIP_MP4_BASE64, PREVIEW_CLIP_SECONDS } from './aiMediaMockClip';

export interface PreviewVideoRequest {
  prompt: string;
  durationSec?: number;
}

/** The preview clip for a request. Shorter requests use the clip trimmed by the layer's bar. */
export function previewVideoBytes(req: PreviewVideoRequest): AiMediaResult {
  if (req.prompt.trim().length < 8) {
    return { ok: false, code: 'bad_request', message: 'Video prompts must be at least 8 characters.' };
  }
  return { ok: true, base64: PREVIEW_CLIP_MP4_BASE64, mime: 'video/mp4', extension: 'mp4' };
}

/** How long the preview clip is; a layer longer than this holds its last frame. */
export const PREVIEW_VIDEO_SECONDS = PREVIEW_CLIP_SECONDS;
