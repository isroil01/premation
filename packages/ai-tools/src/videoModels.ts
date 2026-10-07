/**
 * The text-to-video models `generate_video` can name, and the free preview.
 *
 * One list, read by three places that must agree: the tool schema's `model`
 * enum (craft.ts), the Settings default-model menu, and the desktop shell's
 * endpoint allowlist (electron/falVideoModels.ts, held in step by its test).
 * A model id is never turned into a URL anywhere it was not allowlisted.
 *
 * Durations and aspects are what each model accepts on fal.ai as of
 * 2026-10; a request outside them is snapped to the nearest one the model
 * takes, and the tool's reply says so.
 */

export type VideoAspect = 'landscape' | 'portrait' | 'square';

export interface VideoModel {
  id: string;
  label: string;
  /** Clip lengths the model accepts, seconds. */
  durations: readonly number[];
  aspects: readonly VideoAspect[];
  /** One line for a menu. */
  note: string;
  /** Costs money per clip. The preview is the only one that does not. */
  paid: boolean;
}

/**
 * The free stand-in: a short neutral clip generated locally, no key, no
 * network. What runs until a fal.ai key is connected, and what tests and the
 * eval harness use — so a piece built around a clip can be laid out, timed and
 * reviewed before anyone pays for the footage.
 */
export const PREVIEW_VIDEO_MODEL = 'preview/placeholder';

export const FAL_VIDEO_MODELS: readonly VideoModel[] = [
  { id: 'fal-ai/minimax/video-01-live', label: 'MiniMax Video-01 Live', durations: [6], aspects: ['landscape'], note: 'Fast and lively; 6 s, 16:9.', paid: true },
  { id: 'fal-ai/kling-video/v2.1/master/text-to-video', label: 'Kling 2.1 Master', durations: [5, 10], aspects: ['landscape', 'portrait', 'square'], note: 'Cinematic motion; 5 or 10 s.', paid: true },
  { id: 'fal-ai/luma-dream-machine/ray-2', label: 'Luma Ray 2', durations: [5, 9], aspects: ['landscape', 'portrait', 'square'], note: 'Natural camera moves; 5 or 9 s.', paid: true },
  { id: 'fal-ai/veo3', label: 'Veo 3', durations: [8], aspects: ['landscape', 'portrait'], note: 'Highest fidelity; 8 s.', paid: true },
];

export const VIDEO_MODELS: readonly VideoModel[] = [
  { id: PREVIEW_VIDEO_MODEL, label: 'Preview (free placeholder)', durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], aspects: ['landscape', 'portrait', 'square'], note: 'A neutral stand-in clip; no key, no cost.', paid: false },
  ...FAL_VIDEO_MODELS,
];

export function videoModel(id: string | undefined): VideoModel | undefined {
  return id ? VIDEO_MODELS.find((m) => m.id === id) : undefined;
}

/** The length the model will actually make for a requested one. */
export function snapVideoDuration(model: VideoModel, requested: number | undefined): number {
  const want = requested ?? model.durations[Math.floor((model.durations.length - 1) / 2)]!;
  return model.durations.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best), model.durations[0]!);
}
