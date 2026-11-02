import { formatLabel, getAssetVisualInfo, FOLDER_COLOR } from './assetVisuals';

describe('assetVisuals', () => {
  it('identifies folder color correctly', () => {
    expect(FOLDER_COLOR).toBe('var(--color-amber-500)');
  });

  it('identifies SVG vector images', () => {
    const info = getAssetVisualInfo({ name: 'logo.svg', type: 'image' });
    expect(info.icon).toBe('shape');
    expect(info.label).toBe('SVG Vector');
    expect(info.className).toBe('assetGlyphSvg');
    expect(info.color).toBe('var(--color-filetype-image)');
  });

  it('identifies standard raster images', () => {
    const png = getAssetVisualInfo({ name: 'photo.png', type: 'image' });
    expect(png.icon).toBe('image');
    expect(png.label).toBe('PNG Image');
    expect(png.className).toBe('assetGlyphImage');
    expect(png.color).toBe('var(--color-filetype-image)');

    const jpg = getAssetVisualInfo({ name: 'banner.jpg', type: 'image' });
    expect(jpg.label).toBe('JPEG Image');
    expect(jpg.className).toBe('assetGlyphImage');

    const webp = getAssetVisualInfo({ name: 'texture.webp', type: 'image' });
    expect(webp.label).toBe('WebP Image');
  });

  it('identifies GIF animated files', () => {
    const gif = getAssetVisualInfo({ name: 'reaction.gif', type: 'image' });
    expect(gif.icon).toBe('image');
    expect(gif.label).toBe('GIF Animation');
    expect(gif.className).toBe('assetGlyphGif');
    expect(gif.color).toBe('var(--color-filetype-image)');
  });

  it('identifies design files (PSD, AI)', () => {
    const psd = getAssetVisualInfo({ name: 'layer_comp.psd' });
    expect(psd.icon).toBe('layers');
    expect(psd.label).toBe('Photoshop');
    expect(psd.className).toBe('assetGlyphPsd');
    expect(psd.color).toBe('var(--color-filetype-image)');

    const ai = getAssetVisualInfo({ name: 'brand.ai' });
    expect(ai.icon).toBe('shape');
    expect(ai.label).toBe('Illustrator');
    expect(ai.className).toBe('assetGlyphPsd');
  });

  it('identifies RAW & HDR formats', () => {
    const raw = getAssetVisualInfo({ name: 'shot.exr' });
    expect(raw.icon).toBe('camera');
    expect(raw.label).toBe('RAW / HDR');
    expect(raw.className).toBe('assetGlyphRaw');
    expect(raw.color).toBe('var(--color-filetype-image)');

    const dng = getAssetVisualInfo({ name: 'capture.dng' });
    expect(dng.icon).toBe('camera');
  });

  it('identifies standard and pro video files', () => {
    const mp4 = getAssetVisualInfo({ name: 'clip.mp4', type: 'video' });
    expect(mp4.icon).toBe('video');
    expect(mp4.label).toBe('MP4 Video');
    expect(mp4.className).toBe('assetGlyphVideo');
    expect(mp4.color).toBe('var(--color-filetype-video)');

    const mov = getAssetVisualInfo({ name: 'render.mov', type: 'video' });
    expect(mov.label).toBe('QuickTime');

    const mxf = getAssetVisualInfo({ name: 'camera.mxf', type: 'video' });
    expect(mxf.icon).toBe('video');
    expect(mxf.label).toBe('Pro Video');
    expect(mxf.className).toBe('assetGlyphVideoPro');
    expect(mxf.color).toBe('var(--color-filetype-video)');
  });

  it('identifies audio files', () => {
    const mp3 = getAssetVisualInfo({ name: 'track.mp3', type: 'audio' });
    expect(mp3.icon).toBe('audio');
    expect(mp3.label).toBe('MP3 Audio');
    expect(mp3.className).toBe('assetGlyphAudio');
    expect(mp3.color).toBe('var(--color-filetype-audio)');

    const wav = getAssetVisualInfo({ name: 'soundfx.wav', type: 'audio' });
    expect(wav.label).toBe('WAV Audio');
  });

  it('identifies Lottie & JSON animation files', () => {
    const lottie = getAssetVisualInfo({ name: 'anim.json' });
    expect(lottie.icon).toBe('code');
    expect(lottie.label).toBe('Lottie / JSON');
    expect(lottie.className).toBe('assetGlyphCode');
    expect(lottie.color).toBe('var(--color-filetype-data)');
  });

  it('identifies Fonts', () => {
    const font = getAssetVisualInfo({ name: 'Inter-Bold.ttf' });
    expect(font.icon).toBe('type');
    expect(font.label).toBe('Font');
    expect(font.className).toBe('assetGlyphFont');
    expect(font.color).toBe('var(--color-filetype-font)');
  });

  it('identifies 3D models', () => {
    const model = getAssetVisualInfo({ name: 'character.glb' });
    expect(model.icon).toBe('3d');
    expect(model.label).toBe('3D Model');
    expect(model.className).toBe('assetGlyph3D');
    expect(model.color).toBe('var(--color-filetype-other)');
  });

  it('identifies Compositions', () => {
    const comp = getAssetVisualInfo({ name: 'Scene 1', type: 'comp' });
    expect(comp.icon).toBe('component');
    expect(comp.label).toBe('Composition');
    expect(comp.className).toBe('assetGlyphComp');
    expect(comp.color).toBe('var(--color-filetype-comp)');
  });

  it('falls back gracefully on unknown files', () => {
    const unknown = getAssetVisualInfo({ name: 'document.pdf' });
    expect(unknown.icon).toBe('file');
    expect(unknown.label).toBe('PDF File');
    expect(unknown.className).toBe('assetGlyphFile');
    expect(unknown.color).toBe('var(--color-filetype-other)');
  });
});

describe('formatLabel', () => {
  it('names the format alone, the way the Type column shows it', () => {
    expect(formatLabel({ name: 'giraffe.jpg' })).toBe('JPEG');
    expect(formatLabel({ name: 'Logo.PNG' })).toBe('PNG');
    expect(formatLabel({ name: 'shot.tif' })).toBe('TIFF');
    expect(formatLabel({ name: 'take.mov' })).toBe('MOV');
    expect(formatLabel({ name: 'music.m4a' })).toBe('AAC');
  });

  it('falls back to the descriptive label without a usable extension', () => {
    expect(formatLabel({ name: 'untitled', type: 'image' })).toBe('Image');
  });
});
