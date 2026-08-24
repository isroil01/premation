import { readAudioAssetId, resetAudioForCasterCache } from './audioForCaster';

describe('readAudioAssetId', () => {
  afterEach(() => resetAudioForCasterCache());

  it('reads the dedicated audio component field', () => {
    expect(
      readAudioAssetId({
        components: [{ props: { __assetId: 'a1', __src: 'blob:x' } }],
      }),
    ).toBe('a1');
  });

  it('does not treat a blob URL as an asset id', () => {
    expect(
      readAudioAssetId({
        components: [{ props: { src: 'blob:http://localhost/abc' } }],
      }),
    ).toBeUndefined();
  });
});
