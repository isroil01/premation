/**
 * The proxy generation lifecycle, and specifically its failure paths.
 *
 * Every one of these must end with the asset renderable at FULL resolution.
 * A proxy that fails to generate is a missed optimisation; a proxy that leaves
 * an asset in a broken state is a lost shot. The viewport proxy is the
 * engine's `proxy` job (mocked here); the page transcode is gone.
 */

jest.mock('@core/engine/engineJobs', () => ({ startEngineJob: jest.fn() }));

import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { startEngineJob, type EngineJobOutcome } from '@core/engine/engineJobs';
import { startProxy, cancelProxy, attachProxy, detachProxy, proxyRefusal, canGenerateProxy, maybeAutoGenerateProxy } from './proxyManager';
import { resolveMediaSrc } from './proxy';

const startJob = startEngineJob as jest.MockedFunction<typeof startEngineJob>;

/** An engine job whose outcome the test decides (`finish`), with its cancel spy. */
function engineJob(): { finish(o: Partial<EngineJobOutcome<{ path: string }>>): void; cancel: jest.Mock } {
  let resolve!: (o: EngineJobOutcome<{ path: string }>) => void;
  const done = new Promise<EngineJobOutcome<{ path: string }>>((r) => { resolve = r; });
  const cancel = jest.fn(() => resolve({ status: 'cancelled', job: {} as never, result: null }));
  startJob.mockResolvedValueOnce({ id: 'job_1', cancel, done } as never);
  return { finish: (o) => resolve({ status: 'done', job: {} as never, result: null, ...o }), cancel };
}

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
  startJob.mockReset();
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
  it('marks generating, then ready with the engine file — and full-res renders throughout', async () => {
    const job = engineJob();
    const p = startProxy('a1');
    for (let i = 0; i < 10 && proxyOf()?.status !== 'generating'; i += 1) await Promise.resolve();
    expect(proxyOf()?.status).toBe('generating');
    expect(resolveMediaSrc(useAssetStore.getState().assets[0]!, 'viewport')).toBe(ORIGINAL);
    job.finish({ result: { path: 'C:/proj/proxies/shot.mp4' } });
    await p;
    expect(proxyOf()).toMatchObject({ status: 'ready', src: 'C:/proj/proxies/shot.mp4' });
    expect(startJob.mock.calls[0]![0]).toEqual({ kind: 'proxy', value: { item: 'a1', outputFolder: '' } });
  });
});

describe('failure paths all land at full resolution', () => {
  it('a failed job marks failed with the engine message and keeps the original', async () => {
    const job = engineJob();
    const p = startProxy('a1');
    await Promise.resolve();
    job.finish({ status: 'failed', error: { code: 'io', message: 'ffmpeg exited 1' } as never });
    await p;
    expect(proxyOf()).toMatchObject({ status: 'failed', error: 'ffmpeg exited 1' });
    expect(resolveMediaSrc(useAssetStore.getState().assets[0]!, 'viewport')).toBe(ORIGINAL);
  });

  it('a refused job is a failure, not an unhandled rejection', async () => {
    startJob.mockRejectedValueOnce(new Error('the item has no footage'));
    await expect(startProxy('a1')).resolves.toBeNull();
    expect(proxyOf()).toMatchObject({ status: 'failed', error: 'the item has no footage' });
  });

  it('an engine that does not run proxy jobs writes nothing and says so', async () => {
    startJob.mockResolvedValueOnce(null);
    expect(await startProxy('a1')).toBe('no-engine');
    expect(proxyOf()).toBeUndefined();
  });

  it('an asset deleted mid-encode leaves nothing behind', async () => {
    const job = engineJob();
    const p = startProxy('a1');
    await Promise.resolve();
    useAssetStore.setState({ assets: [] } as never);
    job.finish({ result: { path: 'x.mp4' } });
    await p;
    expect(useAssetStore.getState().assets).toHaveLength(0);
  });

  it('a re-import mid-encode does not have the stale job overwrite it', async () => {
    const job = engineJob();
    const p = startProxy('a1');
    await Promise.resolve();
    useAssetStore.setState({ assets: [asset()] } as never);
    job.finish({ result: { path: 'x.mp4' } });
    await p;
    expect(proxyOf()).toBeUndefined();
  });
});

describe('cancellation', () => {
  it('stops the engine job and CLEARS the record, so Create Proxy is offered again', async () => {
    const job = engineJob();
    const p = startProxy('a1');
    for (let i = 0; i < 10 && proxyOf()?.status !== 'generating'; i += 1) await Promise.resolve();
    await cancelProxy('a1');
    await p;
    expect(job.cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('a1');
    expect(proxyOf()).toBeUndefined();
  });

  it('survives a bridge that throws on cancel', async () => {
    cancel.mockRejectedValue(new Error('no such job'));
    seed(asset({ proxy: { status: 'generating' } }));
    await expect(cancelProxy('a1')).resolves.toBeUndefined();
    expect(proxyOf()).toBeUndefined();
  });
});

describe('auto-generate at import (gated on the Use Proxies preference)', () => {
  afterEach(() => usePreferenceStore.setState({ useProxies: false } as never));

  it('does nothing when Use Proxies is off — the default costs no CPU on import', async () => {
    usePreferenceStore.setState({ useProxies: false } as never);
    maybeAutoGenerateProxy('a1');
    await Promise.resolve();
    await Promise.resolve();
    expect(startJob).not.toHaveBeenCalled();
    expect(proxyOf()).toBeUndefined();
  });

  it('starts a job for worth-it footage when Use Proxies is on', async () => {
    usePreferenceStore.setState({ useProxies: true } as never);
    engineJob();
    maybeAutoGenerateProxy('a1');
    for (let i = 0; i < 20 && proxyOf()?.status !== 'generating'; i += 1) await Promise.resolve();
    expect(proxyOf()?.status).toBe('generating');
  });

  it('honours the SAME refusal gate as the manual button — never starts what it would refuse', async () => {
    usePreferenceStore.setState({ useProxies: true } as never);
    seed(asset({ metadata: { width: 640, height: 360 } })); // too-small
    maybeAutoGenerateProxy('a1');
    await Promise.resolve();
    expect(startJob).not.toHaveBeenCalled();
    expect(proxyOf()).toBeUndefined();
  });

  it('does not double-start when a job is already running', () => {
    usePreferenceStore.setState({ useProxies: true } as never);
    seed(asset({ proxy: { status: 'generating' } }));
    maybeAutoGenerateProxy('a1');
    expect(startJob).not.toHaveBeenCalled(); // already-running refusal
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
    expect(resolveMediaSrc(useAssetStore.getState().assets[0]!, 'viewport')).toBe(ORIGINAL);
  });

  it('detaching a GENERATED proxy releases what we made', () => {
    seed(asset({ proxy: { status: 'ready', src: 'blob:proxy' } }));
    detachProxy('a1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:proxy');
  });

  it('detaching a USER-SUPPLIED proxy does not revoke their file', () => {
    attachProxy('a1', file());
    detachProxy('a1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});
