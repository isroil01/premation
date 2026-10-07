/**
 * The video model list: one place every consumer reads, and the snapping
 * that keeps a request inside what a model can make.
 */

import { generateVideoDef } from './tools';
import { FAL_VIDEO_MODELS, PREVIEW_VIDEO_MODEL, VIDEO_MODELS, snapVideoDuration, videoModel } from './videoModels';

describe('video models', () => {
  it('the tool schema offers exactly the listed models, preview first', () => {
    const props = generateVideoDef.inputSchema.properties as Record<string, { enum?: readonly unknown[] }>;
    expect(props.model!.enum).toEqual(VIDEO_MODELS.map((m) => m.id));
    expect(VIDEO_MODELS[0]!.id).toBe(PREVIEW_VIDEO_MODEL);
    expect(VIDEO_MODELS.filter((m) => !m.paid).map((m) => m.id)).toEqual([PREVIEW_VIDEO_MODEL]);
    expect(FAL_VIDEO_MODELS.every((m) => m.id.startsWith('fal-ai/'))).toBe(true);
  });

  it('snaps a requested length to the nearest one the model makes', () => {
    const kling = videoModel('fal-ai/kling-video/v2.1/master/text-to-video')!;
    expect(snapVideoDuration(kling, 7)).toBe(5);
    expect(snapVideoDuration(kling, 8)).toBe(10);
    expect(snapVideoDuration(videoModel('fal-ai/veo3')!, 3)).toBe(8);
    expect(snapVideoDuration(videoModel(PREVIEW_VIDEO_MODEL)!, 4)).toBe(4);
    expect(videoModel('nope')).toBeUndefined();
  });
});
