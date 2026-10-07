/**
 * The shell's fal allowlist against the package's model list, and the
 * request each model is sent.
 */

import { FAL_VIDEO_MODELS } from '@motion/ai-tools';
import { FAL_VIDEO_ENDPOINTS, falQueueUrl, falVideoRequest } from './falVideoModels';

describe('fal video allowlist', () => {
  it('lists exactly the models the tool offers, with the same lengths and aspects', () => {
    expect(Object.keys(FAL_VIDEO_ENDPOINTS).sort()).toEqual(FAL_VIDEO_MODELS.map((m) => m.id).sort());
    for (const m of FAL_VIDEO_MODELS) {
      expect(FAL_VIDEO_ENDPOINTS[m.id]!.durations).toEqual(m.durations);
      expect(FAL_VIDEO_ENDPOINTS[m.id]!.aspects).toEqual(m.aspects);
      expect(FAL_VIDEO_ENDPOINTS[m.id]!.submit).toBe(`https://queue.fal.run/${m.id}`);
    }
  });

  it('refuses a model that is not on the list, and snaps length and aspect to what a model takes', () => {
    expect(falVideoRequest('https://evil.example/x', 'a calm sea at dusk', 5, undefined)).toBeNull();
    expect(falVideoRequest('fal-ai/kling-video/v2.1/master/text-to-video', 'a calm sea at dusk', 7, 'portrait')).toEqual({
      url: 'https://queue.fal.run/fal-ai/kling-video/v2.1/master/text-to-video',
      body: { prompt: 'a calm sea at dusk', duration: '5', aspect_ratio: '9:16' },
    });
    expect(falVideoRequest('fal-ai/veo3', 'a calm sea at dusk', 3, 'square')!.body).toEqual({ prompt: 'a calm sea at dusk', duration: '8s', aspect_ratio: '16:9' });
    expect(falVideoRequest(undefined, 'a calm sea at dusk', 5, 'portrait')!.body).toEqual({ prompt: 'a calm sea at dusk' });
  });

  it('trusts queue URLs only on fal\'s queue host', () => {
    expect(falQueueUrl('https://queue.fal.run/fal-ai/veo3/requests/1/status')).toBe('https://queue.fal.run/fal-ai/veo3/requests/1/status');
    expect(falQueueUrl('https://elsewhere.example/requests/1')).toBeNull();
    expect(falQueueUrl(42)).toBeNull();
  });
});
