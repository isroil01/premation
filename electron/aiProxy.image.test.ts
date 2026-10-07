/**
 * Image-proxy helpers: size mapping and response parsing.
 *
 * The HTTPS call itself is not unit-tested here (would need a live key or a
 * heavy fetch mock). What IS load-bearing and easy to get wrong is the
 * allowlisted size vocabulary and the JSON shapes providers return — if either
 * drifts, `generate_image` reports success-shaped failures or burns a paid call
 * on a size the API rejects.
 */

import {
  IMAGE_MODEL_LADDER,
  openaiImageSize,
  geminiAspectRatio,
  gptImageSize,
  openaiImageBody,
  parseOpenAiImageBody,
  parseGeminiImageBody,
  stepDownImageModel,
} from './aiImageHelpers';

describe('openaiImageSize', () => {
  it('picks the three DALL·E 3 sizes from aspect', () => {
    expect(openaiImageSize(1024, 1024)).toBe('1024x1024');
    expect(openaiImageSize(1536, 1024)).toBe('1792x1024');
    expect(openaiImageSize(1024, 1536)).toBe('1024x1792');
  });

  it('treats near-square comps as square rather than stretching', () => {
    expect(openaiImageSize(1080, 1080)).toBe('1024x1024');
    expect(openaiImageSize(1920, 1080)).toBe('1792x1024');
    expect(openaiImageSize(1080, 1920)).toBe('1024x1792');
  });
});

describe('geminiAspectRatio', () => {
  it('maps common frames onto Imagen ratios', () => {
    expect(geminiAspectRatio(1024, 1024)).toBe('1:1');
    expect(geminiAspectRatio(1920, 1080)).toBe('16:9');
    expect(geminiAspectRatio(1080, 1920)).toBe('9:16');
    expect(geminiAspectRatio(1200, 900)).toBe('4:3');
    expect(geminiAspectRatio(900, 1200)).toBe('3:4');
  });
});

describe('parseOpenAiImageBody', () => {
  it('reads b64_json from the images response', () => {
    expect(parseOpenAiImageBody({ data: [{ b64_json: 'abc123' }] })).toEqual({
      base64: 'abc123',
      mime: 'image/png',
    });
  });

  it('returns null when the payload has no bytes', () => {
    expect(parseOpenAiImageBody({ data: [] })).toBeNull();
    expect(parseOpenAiImageBody({})).toBeNull();
    expect(parseOpenAiImageBody(null)).toBeNull();
  });
});

describe('parseGeminiImageBody', () => {
  it('reads bytesBase64Encoded from an Imagen predict response', () => {
    expect(
      parseGeminiImageBody({
        predictions: [{ bytesBase64Encoded: 'xyz', mimeType: 'image/jpeg' }],
      }),
    ).toEqual({ base64: 'xyz', mime: 'image/jpeg' });
  });

  it('defaults mime to png when the provider omits it', () => {
    expect(parseGeminiImageBody({ predictions: [{ bytesBase64Encoded: 'xyz' }] })).toEqual({
      base64: 'xyz',
      mime: 'image/png',
    });
  });

  it('returns null when predictions are empty', () => {
    expect(parseGeminiImageBody({ predictions: [] })).toBeNull();
  });
});

describe('the image-model ladder', () => {
  it('tries the newest model first and keeps the old one as the floor', () => {
    expect(IMAGE_MODEL_LADDER.openai).toEqual(['gpt-image-1', 'dall-e-3']);
    expect(IMAGE_MODEL_LADDER.gemini[0]).toMatch(/^imagen-4\.0/);
    expect(IMAGE_MODEL_LADDER.gemini.at(-1)).toMatch(/^imagen-3\.0/);
  });

  it('builds each OpenAI model the body it accepts', () => {
    // gpt-image-1 rejects response_format and has its own size set.
    expect(openaiImageBody('gpt-image-1', 'a red fox in snow', 1920, 1080)).toEqual({ model: 'gpt-image-1', prompt: 'a red fox in snow', n: 1, size: '1536x1024' });
    expect(openaiImageBody('dall-e-3', 'a red fox in snow', 1920, 1080)).toEqual({ model: 'dall-e-3', prompt: 'a red fox in snow', n: 1, size: '1792x1024', response_format: 'b64_json' });
    expect(gptImageSize(1080, 1920)).toBe('1024x1536');
    expect(gptImageSize(1080, 1080)).toBe('1024x1024');
  });

  it('steps down only when the model is unavailable to the key', () => {
    expect(stepDownImageModel(404, '')).toBe(true);
    expect(stepDownImageModel(403, 'Your organization must be verified to use the model gpt-image-1')).toBe(true);
    expect(stepDownImageModel(400, 'The model imagen-4.0-generate-001 does not exist')).toBe(true);
    expect(stepDownImageModel(400, 'prompt rejected by safety system')).toBe(false);
    expect(stepDownImageModel(401, '')).toBe(false);
    expect(stepDownImageModel(429, '')).toBe(false);
    expect(stepDownImageModel(500, '')).toBe(false);
  });
});
