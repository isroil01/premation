/**
 * The asset API is the first place a plugin can make the host allocate.
 *
 * Every other method in the API returns something bounded — a layer name, a
 * keyframe list, a number. `assets.getImage` on an 8000×8000 image is 256 MB of
 * RGBA in one call, and without ceilings that call ends the app. Worse, it ends
 * it in a way that reads as "the editor crashed" rather than "a plugin asked for
 * something unreasonable", so the user blames us and uninstalls nothing.
 *
 * So the limits are the subject here, and every one of them is asserted BY NAME.
 * The error text crosses the worker boundary as a plain string and will be
 * reworded; the code inside it is the part a plugin — or a test — can branch on,
 * and a limit that refuses with the wrong code is a limit a plugin author cannot
 * handle correctly.
 */

import {
  ASSET_LIMITS,
  AssetLimitError,
  RAW_MIME,
  assertDecodable,
  assetBudget,
  createImageAsset,
  releaseAssetBudget,
  requireAsset,
  reserve,
} from './assets';
import { collectTransferables } from './protocol';
import { useAssetStore } from '@stores/assetStore';
import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useSelectionStore } from '@stores/selectionStore';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { useFakeWorkers, testPackage, bootPlugin } from './fakeWorker.testkit';

/** The code out of a refusal, or the failure itself if it was not one. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof AssetLimitError) return err.code;
    return `threw ${String(err)}`;
  }
  return 'did not refuse';
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AssetLimitError) return err.code;
    return `threw ${String(err)}`;
  }
  return 'did not refuse';
}

const PLUGIN = 'com.test.assets';

afterEach(() => { releaseAssetBudget(PLUGIN); });

describe('size ceilings', () => {
  it('accepts an ordinary image', () => {
    expect(assertDecodable(1920, 1080)).toBe(1920 * 1080 * 4);
  });

  it('refuses a side longer than the limit, by name', () => {
    // Not the binding constraint — it is here to refuse absurd aspect ratios
    // that satisfy a pixel budget but break every downstream assumption.
    expect(codeOf(() => assertDecodable(ASSET_LIMITS.MAX_DIMENSION + 1, 1)))
      .toBe('asset-too-large-dimension');
  });

  it('refuses too many pixels, by name', () => {
    expect(codeOf(() => assertDecodable(8192, 8192))).toBe('asset-too-many-pixels');
  });

  it('refuses a non-integer or zero size rather than allocating for it', () => {
    expect(codeOf(() => assertDecodable(0, 100))).toBe('asset-bad-size');
    expect(codeOf(() => assertDecodable(1.5, 100))).toBe('asset-bad-size');
    expect(codeOf(() => assertDecodable(-4, 100))).toBe('asset-bad-size');
  });

  it('states the pixel and byte ceilings as one rule in two units', () => {
    // If these drift apart, one of the two checks becomes unreachable and the
    // other starts refusing things the constants say are allowed.
    expect(ASSET_LIMITS.MAX_PIXELS * 4).toBe(ASSET_LIMITS.MAX_DECODED_BYTES);
  });
});

describe('per-plugin budget', () => {
  it('refuses more in flight than the limit, by name', () => {
    const release = reserve(PLUGIN, ASSET_LIMITS.MAX_IN_FLIGHT_BYTES);
    // Refused, never queued: a queue turns "you asked for too much" into "the
    // plugin has hung", and the user cannot tell those apart.
    expect(codeOf(() => reserve(PLUGIN, 1))).toBe('asset-busy');
    release();
    // …and the same call succeeds once the first one is done.
    expect(codeOf(() => reserve(PLUGIN, 1))).toBe('did not refuse');
  });

  it('refuses once the session budget is spent, by name', () => {
    const chunk = ASSET_LIMITS.MAX_IN_FLIGHT_BYTES;
    let spent = 0;
    while (spent + chunk <= ASSET_LIMITS.MAX_PLUGIN_BUDGET_BYTES) {
      reserve(PLUGIN, chunk)();       // released each time: in-flight is not the cap here
      spent += chunk;
    }
    expect(codeOf(() => reserve(PLUGIN, chunk))).toBe('asset-budget-exhausted');
  });

  it('releasing twice does not credit the plugin twice', () => {
    const release = reserve(PLUGIN, 1000);
    release();
    release();
    expect(assetBudget(PLUGIN).inFlight).toBe(0);
  });

  it('gives the budget back when the plugin stops', () => {
    reserve(PLUGIN, 1000);
    expect(assetBudget(PLUGIN).total).toBe(1000);
    releaseAssetBudget(PLUGIN);
    expect(assetBudget(PLUGIN).total).toBe(0);
  });
});

describe('createImage argument validation', () => {
  it('refuses an unknown mime, by name', async () => {
    expect(await asyncCodeOf(() => createImageAsset(PLUGIN, {
      width: 1, height: 1, bytes: new Uint8Array(4), mime: 'image/gif', name: 'x',
    }))).toBe('asset-bad-mime');
  });

  it('refuses bytes that are not bytes, by name', async () => {
    expect(await asyncCodeOf(() => createImageAsset(PLUGIN, {
      width: 1, height: 1, bytes: 'not bytes', mime: RAW_MIME, name: 'x',
    }))).toBe('asset-bad-bytes');
  });

  it('refuses raw bytes that do not match the declared size, by name', async () => {
    // The check that stops a plugin describing a 4×4 image and handing over one
    // pixel — which would read out of bounds in every consumer downstream.
    expect(await asyncCodeOf(() => createImageAsset(PLUGIN, {
      width: 4, height: 4, bytes: new Uint8Array(4), mime: RAW_MIME, name: 'x',
    }))).toBe('asset-bytes-mismatch');
  });

  it('refuses an oversized declared size before touching the bytes', async () => {
    expect(await asyncCodeOf(() => createImageAsset(PLUGIN, {
      width: 8192, height: 8192, bytes: new Uint8Array(8), mime: RAW_MIME, name: 'x',
    }))).toBe('asset-too-many-pixels');
  });

  it('releases the reservation when a call is refused', async () => {
    await asyncCodeOf(() => createImageAsset(PLUGIN, {
      width: 4, height: 4, bytes: new Uint8Array(4), mime: RAW_MIME, name: 'x',
    }));
    // A refused call that kept its reservation would make the SECOND mistake
    // permanent: the plugin never recovers its budget and every later call
    // fails for a reason that has nothing to do with it.
    expect(assetBudget(PLUGIN).inFlight).toBe(0);
  });
});

describe('asset lookup', () => {
  it('refuses an unknown asset id, by name', () => {
    expect(codeOf(() => requireAsset('no-such-asset'))).toBe('asset-not-found');
  });

  it('refuses an asset that is not an image, by name', () => {
    useAssetStore.setState({
      assets: [{ id: 'a1', name: 'clip.mp4', type: 'video', src: 'blob:x', size: 10 }],
      folders: [],
    });
    // A video is a real asset and a real id — refusing it as "not found" would
    // send the author looking for a typo that is not there.
    expect(codeOf(() => requireAsset('a1'))).toBe('asset-not-an-image');
    useAssetStore.setState({ assets: [], folders: [] });
  });
});

describe('binary transport', () => {
  it('puts a call argument buffer in the transfer list', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const transfer = collectTransferables({
      k: 'call', id: 1, method: 'assets.createImage', args: [{ bytes, width: 1, height: 1 }],
    });
    expect(transfer).toEqual([bytes.buffer]);
  });

  it('puts a result buffer in the transfer list', () => {
    const bytes = new Uint8Array(16);
    const transfer = collectTransferables({
      k: 'result', id: 1, ok: true, value: { assetId: 'a', width: 2, height: 2, bytes },
    });
    expect(transfer).toEqual([bytes.buffer]);
  });

  it('lists one buffer once, however many views point at it', () => {
    // Transferring the same buffer twice in one postMessage throws.
    const buf = new ArrayBuffer(32);
    const transfer = collectTransferables({
      k: 'call', id: 1, method: 'x', args: [{ a: new Uint8Array(buf), b: new Uint8Array(buf) }],
    });
    expect(transfer).toHaveLength(1);
  });

  it('finds nothing to transfer in an ordinary JSON call', () => {
    expect(collectTransferables({
      k: 'call', id: 1, method: 'scene.getLayers', args: [],
    })).toEqual([]);
  });
});

describe('the permission gate', () => {
  beforeAll(async () => {
    seedDefaultScene();
    // A real CommandSystem, because every mutating plugin call goes through
    // `runDocumentEdit`, which needs one. Worth noting: until this suite,
    // nothing exercised a SUCCESSFUL plugin write at all — the host suite only
    // ever checked the refusal paths, and those return before the edit runs.
    setCommandSystem(new CommandSystem({ getState: () => ({}), services: {} as never }));
    useFakeWorkers();
    // Payloads live in IndexedDB, so the store must be hydrated before the
    // host will start anything — `configure()` throws otherwise.
    await usePluginStore.getState().hydrate();
    pluginHost.configure({ getSelection: () => useSelectionStore.getState().ids });
  });
  afterAll(() => { pluginHost.setWorkerFactory(null); });

  it('refuses getImage without assets:read', () => {
    const w = bootPlugin(testPackage([], 'com.gate.read'));
    const r = w.callAndWait('assets.getImage', { assetId: 'whatever' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('assets:read');
    pluginHost.uninstall('com.gate.read');
  });

  it('refuses createImage without assets:write', () => {
    const w = bootPlugin(testPackage(['assets:read'], 'com.gate.write'));
    const r = w.callAndWait('assets.createImage', { width: 1, height: 1, bytes: new Uint8Array(4) });
    expect(r.ok).toBe(false);
    // Named specifically: `assets:read` was granted, and a plugin that got a
    // bare "permission denied" here would have no idea which one was missing.
    expect(r.ok === false && r.error).toContain('assets:write');
    pluginHost.uninstall('com.gate.write');
  });

  it('lets a granted plugin past the gate and into the method', async () => {
    const w = bootPlugin(testPackage(['assets:read'], 'com.gate.ok'));
    const r = await w.callAsync('assets.getImage', { assetId: 'no-such-asset' });
    // Still refused — but by the METHOD, for a real reason, not by the gate.
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('asset-not-found');
    pluginHost.uninstall('com.gate.ok');
  });

  it('links a created image layer back to its asset', async () => {
    // This guards a bug that was silent in exactly the worst way: the write
    // was `t.props.assetId = …` on a node already IN the graph, so it went to
    // a copy and was discarded. The layer rendered the right picture and simply
    // was not the asset — reinterpretation and proxying would skip it forever,
    // and nothing anywhere would say why.
    useAssetStore.setState({
      assets: [{
        id: 'img-1', name: 'photo.png', type: 'image', src: 'blob:photo', size: 100,
        metadata: { width: 64, height: 48 },
      }],
      folders: [],
    });
    const w = bootPlugin(testPackage(['scene:write'], 'com.gate.layer'));
    const r = w.callAndWait('scene.createLayer', { kind: 'image', assetId: 'img-1' });
    expect({ ok: r.ok, error: r.ok === false ? r.error : '' }).toEqual({ ok: true, error: '' });

    const node = defaultSceneGraph.getNode(String(r.ok === true ? r.value : ''));
    const transform = node?.components.find((c) => c.type === 'Transform');
    expect(transform?.props.assetId).toBe('img-1');

    pluginHost.uninstall('com.gate.layer');
    useAssetStore.setState({ assets: [], folders: [] });
  });

  it('refuses creating an image layer for an asset that does not exist', () => {
    const w = bootPlugin(testPackage(['scene:write'], 'com.gate.noasset'));
    const r = w.callAndWait('scene.createLayer', { kind: 'image', assetId: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('asset-not-found');
    pluginHost.uninstall('com.gate.noasset');
  });

  it('releases a plugin s asset budget when the HOST stops it', () => {
    // The budget test earlier calls `releaseAssetBudget` directly, which proves
    // the function works and nothing at all about whether anything calls it.
    // This is the wiring: a plugin that spent its allowance and was then stopped
    // has to get it back, or Restart — the documented fix for a wedged plugin —
    // leaves it permanently unable to touch an image, for a reason that has
    // nothing to do with the image.
    const w = bootPlugin(testPackage(['assets:read'], 'com.gate.budget'));
    reserve('com.gate.budget', 1_000_000)();
    expect(assetBudget('com.gate.budget').total).toBe(1_000_000);

    pluginHost.stop('com.gate.budget');
    expect(assetBudget('com.gate.budget').total).toBe(0);
    expect(w.terminated).toBe(true);

    pluginHost.uninstall('com.gate.budget');
  });

  it('refuses a getImage ref that names neither a layer nor an asset', async () => {
    const w = bootPlugin(testPackage(['assets:read'], 'com.gate.ref'));
    const r = await w.callAsync('assets.getImage', {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('layerId');
    pluginHost.uninstall('com.gate.ref');
  });
});
