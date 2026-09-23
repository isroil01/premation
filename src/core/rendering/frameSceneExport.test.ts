/**
 * The FrameScene → RenderFrameFile exporter (D2): what the C++ render graph
 * reads must be the FrameScene the TS renderer drew, losslessly.
 */
import { codecs } from '@motion/engine-api';
import { Mat3 } from '@motion/renderer';
import type { FrameScene, Renderable } from '@motion/renderer';
import { contentHash, effectToWire, exportFrameFile, frameSceneToWire, type FrameCapture } from './frameSceneExport';

function rect(id: string, over: Partial<Renderable> = {}): Renderable {
  return {
    id,
    kind: 'rect',
    modelMatrix: Mat3.compose(10, 20, 0.5, 30, 40),
    bounds: { x: 0, y: 0, width: 30, height: 40 },
    opacity: 0.75,
    blend: 'screen',
    color: { r: 1, g: 0.5, b: 0.25, a: 1 },
    ...over,
  };
}

function capture(scene: FrameScene): FrameCapture {
  return {
    scene,
    view: {
      cssWidth: 320, cssHeight: 240, devicePixelRatio: 1, center: { x: 160, y: 120 }, zoom: 1,
      clearColor: { r: 0, g: 0, b: 0, a: 0 }, frameClip: { x: 0, y: 0, width: 320, height: 240 }, overlaysActive: false,
    },
    colorPipeline: { workingSpace: 'srgb-linear', displayTransform: 'srgb', bitDepth: 16 },
    viewerLutActive: false,
    capabilities: { float16Textures: true, float32Textures: false },
    surfaceFormat: 'bgra8unorm',
    adapterVendor: 'amd',
  };
}

describe('frameSceneExport', () => {
  it('flattens every effect field by name — numbers, flags, colours, rows, nested objects', () => {
    const e = effectToWire({
      type: 'glow', radiusPx: 12, color: { r: 1, g: 0, b: 0, a: 0.5 }, dither: true,
      p: [[1, 2, 3, 4], [5, 6, 7, 8]], hostInputs: { fps: 30, seed: 7 }, extraLayerIds: ['a', ''],
      params: new Float32Array([0.5, 1.5]), onDraw: { begin() {}, end() {} },
    });
    const byName = new Map(e.params.map((p) => [p.name, p]));
    expect(e.type).toBe('glow');
    expect(byName.get('radiusPx')).toMatchObject({ kind: 'number', number: 12 });
    expect(byName.get('color')).toMatchObject({ kind: 'color', numbers: [1, 0, 0, 0.5] });
    expect(byName.get('dither')).toMatchObject({ kind: 'flag', number: 1 });
    expect(byName.get('p')!.numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(byName.get('hostInputs.fps')).toMatchObject({ number: 30 });
    expect(byName.get('extraLayerIds')).toMatchObject({ kind: 'texts', texts: ['a', ''] });
    expect(byName.get('params')!.numbers).toEqual([0.5, 1.5]);
    // Functions (the device-loss marker) are not data and do not travel.
    expect(byName.has('onDraw.begin')).toBe(false);
  });

  it('collects every texture key the scene samples, recursively through precomps', () => {
    const scene: FrameScene = {
      composition: { id: 'c', size: { width: 320, height: 240 } },
      renderables: [
        rect('a', { kind: 'image', textureKey: 'asset:1', maskTextureKey: 'mask:a', lutTextureKey: 'lut:a' }),
        rect('p', {
          kind: 'image', textureKey: 'precomp:p',
          precomp: { renderables: [rect('child', { kind: 'text', textureKey: 'text:child' })] },
          effects: [{ type: 'apply-color-lut', lutTextureKey: 'cube:1', size: 33, is1d: false, intensity: 1, domainMin: 0, domainMax: 1 }],
        }),
      ],
    };
    const { keys, file } = frameSceneToWire(capture(scene), 's', 0);
    expect(keys).toEqual(['asset:1', 'cube:1', 'lut:a', 'mask:a', 'precomp:p', 'text:child', 'texture:white']);
    expect(file.scene.renderables[1]!.precompChildren[0]!.id).toBe('child');
  });

  it('round-trips through the engine-api codec with matrices bit-exact and blobs deduped by content', async () => {
    const scene: FrameScene = {
      composition: { id: 'c', size: { width: 320, height: 240 }, background: { r: 0, g: 0, b: 0, a: 1 } },
      renderables: [rect('a'), rect('b', { kind: 'image', textureKey: 'k1' }), rect('c', { kind: 'image', textureKey: 'k2' })],
      hasEffects: true,
    };
    const px = new Uint8Array([255, 0, 0, 255]);
    const bytes = await exportFrameFile(capture(scene), 'scene-x', 3, (key) => (key === 'missing' ? null : {
      sampleLinear: false,
      ready: true,
      read: async () => ({ width: 1, height: 1, format: 'rgba8unorm', data: px, mipmapped: false }),
    }));
    const file = codecs.RenderFrameFile.decode(bytes);
    expect(file.sceneId).toBe('scene-x');
    expect(file.frame).toBe(3);
    expect(file.view.adapterVendor).toBe('amd');
    // Mat3 is float32: every value survives the f64 wire exactly.
    expect(file.scene.renderables[0]!.modelMatrix).toEqual(Array.from(scene.renderables[0]!.modelMatrix));
    expect(file.scene.renderables[0]!.blend).toBe('screen');
    // k1, k2 and texture:white share one content hash → one blob.
    expect(file.textures.map((t) => t.key)).toEqual(['k1', 'k2', 'texture:white']);
    expect(new Set(file.textures.map((t) => t.hash)).size).toBe(1);
    expect(file.blobs).toHaveLength(1);
    expect(file.blobs[0]!.hash).toBe(contentHash(1, 1, 'rgba8unorm', px));
  });
});
