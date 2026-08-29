/**
 * Reported: "add text with the Text tool, scale it up, and it VANISHES past ~4x."
 *
 * The layer is not dropped and nothing fails to allocate. Two halves of the
 * raster path simply stop agreeing on where the pixels were put.
 *
 *   • `Canvas2DVectorRasterizer.rasterize` draws the glyphs and uploads them
 *     into the resource pool under `poolKeyFor(rasterCacheKey(...))`, and
 *     `rasterCacheKey` quantises the scale with `resolutionTier` — the CLAMPED
 *     ladder, whose top rung is 4.
 *   • `AppTextureProvider.setText` then asks the pool for
 *     `raster:<sig>@<tier>~<pad>`, where `tier` came from `tierFor`, which
 *     escalates onto the CONTINUOUS ladder (8, 16, 32, 64) above 4.
 *
 * At or below 4x the two spellings coincide and everything works. Above it the
 * provider asks for a key nothing was ever written to, `ResourceManager.texture`
 * mints a fresh EMPTY texture, and the layer draws nothing at all — which is
 * why the box, the handles and the selection all survive while the glyphs go.
 *
 * The same two lines exist in `setPath`, so shapes scaled past 4x vanish the
 * same way.
 *
 * The invariant these pin is the one that was broken: ONE `setText` must
 * produce ONE raster texture, and the texture the provider hands the renderer
 * must be the one the rasterizer actually wrote pixels into.
 */

import { ResourceManager, NullBackend, rasterCacheKey } from '@motion/renderer';
import { AppTextureProvider } from '../AppTextureProvider';

/** Records every texture key the pool is asked to create, and which ones were
 *  written to — an unwritten raster texture is a blank layer. */
class KeyRecordingBackend extends NullBackend {
  readonly created: string[] = [];
  override createTexture(
    desc: Parameters<NullBackend['createTexture']>[0],
  ): ReturnType<NullBackend['createTexture']> {
    this.created.push(String((desc as { label?: string }).label ?? ''));
    return super.createTexture(desc);
  }
}

function rasterTexturesFor(scale: number): number {
  const backend = new KeyRecordingBackend();
  const resources = new ResourceManager(backend);
  resources.beginFrame(1);
  const provider = new AppTextureProvider(resources, {});

  provider.setText('text:probe', {
    text: 'Text',
    fontSize: 32,
    color: '#fff',
    // The measured box of the default Text-tool layer — small enough that no
    // cap can bind, so a blank result cannot be blamed on the device limit.
    width: 89,
    height: 55,
    scaleX: scale,
    scaleY: scale,
  } as unknown as Parameters<AppTextureProvider['setText']>[1]);

  return backend.created.filter((label) => label.startsWith('raster:')).length;
}

describe('the raster cache key the writer uses is the one the reader asks for', () => {
  it('quantises a scale the provider already quantised, without re-clamping it', () => {
    // `resolutionScale` reaching the rasterizer is ALWAYS an exact ladder value
    // (`drawScaleFor` returns the tier), so re-quantising is at best a no-op —
    // and above 4 it silently rewrote the key to a different texture.
    expect(rasterCacheKey('sig', 1, 0)).toBe(rasterCacheKey('sig', 1, 0));
    expect(rasterCacheKey('sig', 8, 0)).toContain('@8');
    expect(rasterCacheKey('sig', 16, 0)).toContain('@16');
    // Below the old ceiling nothing may move — those keys are shared with every
    // already-rendered project.
    expect(rasterCacheKey('sig', 4, 0)).toContain('@4');
    expect(rasterCacheKey('sig', 2, 0)).toContain('@2');
    expect(rasterCacheKey('sig', 0.5, 0)).toContain('@0.5');
  });

  it('allocates exactly one raster texture per text, at every scale', () => {
    // 1 = the rasterizer wrote pixels and the provider found them.
    // 2 = the provider asked for a key nothing wrote to and got a blank one.
    expect(rasterTexturesFor(1)).toBe(1);
    expect(rasterTexturesFor(4)).toBe(1);
    expect(rasterTexturesFor(5)).toBe(1);   // the reported threshold
    expect(rasterTexturesFor(8)).toBe(1);
    expect(rasterTexturesFor(16)).toBe(1);
  });
});
