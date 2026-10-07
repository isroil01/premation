/**
 * The fal.ai video models the desktop shell will call, as complete URLs.
 *
 * The renderer names a model by id; this table is the ONLY place an id
 * becomes a URL, and an id not in it is refused (same rule as the image and
 * chat allowlists). It mirrors `FAL_VIDEO_MODELS` in @motion/ai-tools — the
 * shell cannot import the package, so `falVideoModels.test.ts` holds the two
 * in step.
 *
 * Pure, so it is testable without Electron.
 */

export type FalAspect = 'landscape' | 'portrait' | 'square';

interface FalModelSpec {
  /** Queue submit URL. */
  submit: string;
  /** Lengths the model takes, seconds, and how it wants them spelled. */
  durations: readonly number[];
  durationField: (sec: number) => Record<string, unknown>;
  aspects: readonly FalAspect[];
}

const RATIO: Record<FalAspect, string> = { landscape: '16:9', portrait: '9:16', square: '1:1' };

export const FAL_VIDEO_ENDPOINTS: Readonly<Record<string, FalModelSpec>> = {
  'fal-ai/minimax/video-01-live': {
    submit: 'https://queue.fal.run/fal-ai/minimax/video-01-live',
    durations: [6],
    durationField: () => ({}),
    aspects: ['landscape'],
  },
  'fal-ai/kling-video/v2.1/master/text-to-video': {
    submit: 'https://queue.fal.run/fal-ai/kling-video/v2.1/master/text-to-video',
    durations: [5, 10],
    durationField: (s) => ({ duration: String(s) }),
    aspects: ['landscape', 'portrait', 'square'],
  },
  'fal-ai/luma-dream-machine/ray-2': {
    submit: 'https://queue.fal.run/fal-ai/luma-dream-machine/ray-2',
    durations: [5, 9],
    durationField: (s) => ({ duration: `${s}s` }),
    aspects: ['landscape', 'portrait', 'square'],
  },
  'fal-ai/veo3': {
    submit: 'https://queue.fal.run/fal-ai/veo3',
    durations: [8],
    durationField: (s) => ({ duration: `${s}s` }),
    aspects: ['landscape', 'portrait'],
  },
};

export const DEFAULT_FAL_VIDEO_MODEL = 'fal-ai/minimax/video-01-live';

/** The request a model is sent, or null for a model not on the allowlist. */
export function falVideoRequest(
  modelId: string | undefined,
  prompt: string,
  durationSec: number,
  aspect: FalAspect | undefined,
): { url: string; body: Record<string, unknown> } | null {
  const id = modelId ?? DEFAULT_FAL_VIDEO_MODEL;
  const spec = FAL_VIDEO_ENDPOINTS[id];
  if (!spec) return null;
  const dur = spec.durations.reduce((b, d) => (Math.abs(d - durationSec) < Math.abs(b - durationSec) ? d : b), spec.durations[0]!);
  const a = aspect && spec.aspects.includes(aspect) ? aspect : spec.aspects[0]!;
  return {
    url: spec.submit,
    body: {
      prompt,
      ...spec.durationField(dur),
      ...(spec.aspects.length > 1 ? { aspect_ratio: RATIO[a] } : {}),
    },
  };
}

/**
 * A status / result URL from a queue response, accepted only on fal's queue
 * host — the response is provider data, and a URL in it is not trusted to
 * point anywhere else.
 */
export function falQueueUrl(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('https://queue.fal.run/') ? v : null;
}
