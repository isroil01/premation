/**
 * The proxy generation lifecycle, and specifically its failure paths.
 *
 * Every one of these must end with the asset renderable at FULL resolution.
 * A proxy that fails to generate is a missed optimisation; a proxy that leaves
 * an asset in a broken state is a lost shot.
 */

import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { startProxy, cancelProxy, attachProxy, detachProxy, proxyRefusal, canGenerateProxy } from './proxyManager';
import { resolveMediaSrc } from './proxy';

const ORIGINAL = 'blob:original';

const asset = (over: Partial<ImportedAsset> = {}): ImportedAsset => ({
  id: 'a1',
  name: 'shot.mov',
  type: 'video',
  src: ORIGINAL,
  size: 1,
  metadata: { width: 3840, height: 2160, duration: 10 },
  ...over,
});

const seed = (a: ImportedAsset = asset()): void => {
  useAssetStore.setState({ assets: [a] } as never);
};
const proxyOf = (id = 'a1') => useAssetStore.getState().assets.find((x) => x.id === id)?.proxy;

let generate: jest.Mock;
let cancel: jest.Mock;

beforeEach(() => {
  generate = jest.fn();
  cancel = jest.fn().mockResolvedValue(true);
  (window as unknown as { motionEditor?: unknown }).motionEditor = {
    media: { generateProxy: generate, cancelProxy: cancel },
  };
  global.fetch = jest.fn().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(64) }) as never;
  global.URL.createObjectURL = jest.fn(() => 'blob:proxy') as never;
  global.URL.revokeObjectURL = jest.fn() as never;
  seed();
});

describe('refusals are explained rather than attempted', () => {
  it('declines footage already cheap to seek', () => {
    seed(asset({ metadata: { width: 1280, height: 720 } }));
    expect(proxyRefusal(useAssetStore.getState().assets[0])).toBe('too-small');
  });

  it('declines when the size is unknown, rather than guessing one', () => {
    seed(asset({ metadata: {} }));
    expect(proxyRefusal(useAssetStore.getState().assets[0])).toBe('unknown-size');
  });

  it('declines stills and audio', () => {
    seed(asset({ type: 'image' }));
    expect(proxyRefusal(useAssetStore.getState().assets[0])).toBe('not-video');
  });

  it('declines a second job for the same asset', () => {
    seed(asset({ proxy: { status: 'generating' } }));
    expect(proxyRefusal(useAssetStore.getState().assets[0])).toBe('already-running');
  });

  it('reports no-ffmpeg in a build without the bridge — the browser fallback', () => {
    (window as unknown as { motionEditor?: unknown }).motionEditor = {};
    expect(canGenerateProxy()).toBe(false);
    expect(proxyRefusal(useAssetStore.getState().assets[0])).toBe('no-ffmpeg');
  });

  it('a refused start writes NO record, so the asset is untouched', async () => {
    seed(asset({ metadata: { width: 640, height: 360 } }));
    expect(await startProxy('a1')).toBe('too-small');
    expect(proxyOf()).toBeUndefined();
  });
});

describe('a successful generation', () => {
  it('marks generating, then ready — and full-res renders throughout', async () => {
    let midFlight: string | undefined;
    generate.mockImplementation(async () => {
      // While the encode runs the asset must still resolve to the original.
      const a = useAssetStore.getState().assets[0]!;
      midFlight = resolveMediaSrc(a, true);
      return new Uint8Array([1, 2, 3]);
    });

    await startProxy('a1');

    expect(midFlight).toBe(ORIGINAL);
    expect(proxyOf()).toMatchObject({ status: 'ready', src: 'blob:proxy', width: 1920, height: 1080 });
  });

  it('passes the encode args with placeholders, not real paths', async () => {
    generate.mockResolvedValue(new Uint8Array([1]));
    await startProxy('a1');
    const args = generate.mock.calls[0]![3] as string[];
    expect(args).toContain('__IN__');
    expect(args).toContain('__OUT__');
    expect(args).toContain('scale=1920:1080');
  });

  it('routes alpha footage to WebM', async () => {
    seed(asset({ metadata: { width: 3840, height: 2160, hasAlpha: true } }));
    generate.mockResolvedValue(new Uint8Array([1]));
    await startProxy('a1');
    expect(generate.mock.calls[0]![4]).toBe('webm');
  });
});

describe('failure paths all land at full resolution', () => {
  it('a null result (no ffmpeg, or a failed encode) marks failed and keeps the original', async () => {
    generate.mockResolvedValue(null);
    await startProxy('a1');
    expect(proxyOf()?.status).toBe('failed');
    expect(resolveMediaSrc(useAssetStore.getState().assets[0]!, true)).toBe(ORIGINAL);
  });

  it('an empty result is treated as failure, not as a valid zero-byte proxy', async () => {
    generate.mockResolvedValue(new Uint8Array(0));
    await startProxy('a1');
    expect(proxyOf()?.status).toBe('failed');
  });

  it('a throwing bridge is a failure, not an unhandled rejection', async () => {
    generate.mockRejectedValue(new Error('ipc died'));
    await expect(startProxy('a1')).resolves.toBeNull();
    expect(proxyOf()?.status).toBe('failed');
  });

  it('an unreadable original fails without calling ffmpeg at all', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('gone')) as never;
    await startProxy('a1');
    expect(generate).not.toHaveBeenCalled();
    expect(proxyOf()?.status).toBe('failed');
  });

  it('an asset deleted mid-encode leaves nothing behind', async () => {
    generate.mockImplementation(async () => {
      useAssetStore.setState({ assets: [] } as never);
      return new Uint8Array([1]);
    });
    await startProxy('a1');
    expect(useAssetStore.getState().assets).toHaveLength(0);
  });

  it('a re-import mid-encode does not have the stale job overwrite it', async () => {
    generate.mockImplementation(async () => {
      // The asset was re-imported: fresh record, no proxy.
      useAssetStore.setState({ assets: [asset()] } as never);
      return new Uint8Array([1]);
    });
    await startProxy('a1');
    // The finished job saw the record was no longer 'generating' and stood down.
    expect(proxyOf()).toBeUndefined();
  });
});

describe('cancellation', () => {
  it('kills the child and CLEARS the record, so Create Proxy is offered again', async () => {
    seed(asset({ proxy: { status: 'generating' } }));
    await cancelProxy('a1');
    expect(cancel).toHaveBeenCalledWith('a1');
    expect(proxyOf()).toBeUndefined();
  });

  it('a cancelled job does not later mark itself failed', async () => {
    generate.mockImplementation(async () => {
      await cancelProxy('a1'); // user cancels mid-encode
      return null; // killed child exits non-zero
    });
    await startProxy('a1');
    expect(proxyOf()).toBeUndefined();
  });

  it('survives a bridge that throws on cancel', async () => {
    cancel.mockRejectedValue(new Error('no such job'));
    seed(asset({ proxy: { status: 'generating' } }));
    await expect(cancelProxy('a1')).resolves.toBeUndefined();
    expect(proxyOf()).toBeUndefined();
  });
});

describe('attach and detach a user-supplied proxy', () => {
  const file = (): File => new File([new Uint8Array([1, 2])], 'small.mp4', { type: 'video/mp4' });

  it('attaching needs no ffmpeg — the browser build’s whole proxy story', () => {
    (window as unknown as { motionEditor?: unknown }).motionEditor = {};
    attachProxy('a1', file());
    expect(proxyOf()).toMatchObject({ status: 'ready', userSupplied: true });
  });

  it('detaching returns the asset to full resolution', () => {
    attachProxy('a1', file());
    detachProxy('a1');
    expect(proxyOf()).toBeUndefined();
    expect(resolveMediaSrc(useAssetStore.getState().assets[0]!, true)).toBe(ORIGINAL);
  });

  it('detaching a GENERATED proxy revokes the URL we created', async () => {
    generate.mockResolvedValue(new Uint8Array([1]));
    await startProxy('a1');
    detachProxy('a1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:proxy');
  });

  it('detaching a USER-SUPPLIED proxy does not revoke their file', () => {
    attachProxy('a1', file());
    detachProxy('a1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});
