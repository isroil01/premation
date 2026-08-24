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
  openaiImageSize,
  geminiAspectRatio,
  parseOpenAiImageBody,
  parseGeminiImageBody,
} from './aiProxy';

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
