/**
 * PROBE: a TEXT layer scaled up — does it keep producing a usable texture?
 *
 * Reported: "add text with the text tool, scale it, it disappears somewhere
 * past ~2x". Measures the whole provider path (setText → tierFor →
 * drawScaleFor → rasterizer) and records the dimensions of every texture the
 * renderer is asked to allocate, so an over-cap request is visible.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider } from './AppTextureProvider';

class SizeRecordingBackend extends NullBackend {
  readonly created: Array<{ label?: string; width: number; height: number }> = [];
  override createTexture(desc: Parameters<NullBackend['createTexture']>[0]): ReturnType<NullBackend['createTexture']> {
    this.created.push({
      label: (desc as { label?: string }).label,
      width: desc.width,
      height: desc.height,
    });
    return super.createTexture(desc);
  }
}

describe('PROBE: text layer scaled up', () => {
  const run = (maxTex: number, boxW: number, boxH: number, fontSize: number): void => {
    const backend = new SizeRecordingBackend();
    const resources = new ResourceManager(backend);
    resources.beginFrame(1);
    const provider = new AppTextureProvider(resources, {});
    provider.setMaxRasterDimension(maxTex);

    console.log(`\n[probe] cap=${maxTex} box=${boxW}x${boxH} font=${fontSize}`);
    for (const scale of [1, 1.5, 2, 2.5, 3, 4, 6, 8, 12, 16, 24, 32]) {
      const before = backend.created.length;
      provider.setText('text:probe', {
        text: 'Hello',
        fontSize,
        color: '#fff',
        width: boxW,
        height: boxH,
        scaleX: scale,
        scaleY: scale,
      } as unknown as Parameters<AppTextureProvider['setText']>[1]);
      const made = backend.created.slice(before).filter((c) => c.label?.startsWith('raster:'));
      const biggest = made.reduce(
        (a, c) => (Math.max(c.width, c.height) > Math.max(a.width, a.height) ? c : a),
        { width: 0, height: 0 } as { width: number; height: number },
      );
      const over = biggest.width > maxTex || biggest.height > maxTex;
      console.log(
        `[probe] scale=${scale} -> ${biggest.width}x${biggest.height}`
          + `${over ? '   <<< OVER DEVICE CAP (upload fails → layer vanishes)' : ''}`
          + `${made.length === 0 ? '   (cache hit, no new texture)' : ''}`,
      );
    }
  };

  it('typical text layer on a 16384-cap GPU', () => { run(16384, 400, 100, 72); });
  it('typical text layer on a 8192-cap GPU', () => { run(8192, 400, 100, 72); });
  it('wide title box on a 8192-cap GPU', () => { run(8192, 1600, 200, 120); });
  it('wide title box on a 4096-cap GPU', () => { run(4096, 1600, 200, 120); });
});
