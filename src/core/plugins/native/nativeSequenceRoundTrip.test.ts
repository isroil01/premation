/**
 * Sequence data through the REAL call path.
 *
 * `nativeSequenceData.test.ts` pins the store; this pins that the store is
 * actually wired into `runNativeEffect` — that an addon's `state` comes back
 * on the next frame, that omitting it keeps what the host holds, that `null`
 * clears it, and that unloading the plugin forgets it.
 *
 * The seam under test is the whole client: the trust gate, the scheduler and
 * the lanes are all real, and only the preload bridge is faked.
 */

import {
  FAKE_NATIVE_ID,
  FAKE_NATIVE_LOAD_INPUT,
  allowFakeNative,
  installFakeNativeBridge,
  removeFakeNativeBridge,
  type FakeNativeBridge,
} from './nativeBridge.testkit';
import {
  loadNativePlugin,
  resetNativeClientForTests,
  runNativeEffect,
  unloadNativePlugin,
} from './nativeClient';
import { resetNativeConsentForTests } from './nativeTrust';
import { resetNativeSchedulerForTests, takeNativeErrors } from './nativeScheduler';
import { clearSequenceData, MAX_SEQUENCE_BYTES } from './nativeSequenceData';
import type { NativeCallOutcome, NativeEffectRequest, NativeFrameInfo } from './nativeAbi';

const HOST: NativeFrameInfo = {
  compWidth: 8, compHeight: 8, layerWidth: 2, layerHeight: 1,
  time: 0, compTime: 0, frame: 0, fps: 24, pixelScale: 1, downsample: 1, seed: 0.5,
};

let bridge: FakeNativeBridge;
/** Every `state` the fake addon was HANDED, in call order. */
let seen: unknown[];

beforeEach(async () => {
  resetNativeConsentForTests();
  resetNativeSchedulerForTests(null);
  resetNativeClientForTests();
  clearSequenceData();
  takeNativeErrors();
  seen = [];
  bridge = installFakeNativeBridge();
  allowFakeNative();
  await loadNativePlugin(FAKE_NATIVE_LOAD_INPUT);
});

afterEach(() => {
  removeFakeNativeBridge();
  resetNativeSchedulerForTests(null);
  resetNativeClientForTests();
  clearSequenceData();
});

/** Make the fake addon record the state it was given and answer with `reply`. */
function answering(reply: (n: number) => Partial<{ state: unknown; identity: boolean }>): void {
  let n = 0;
  bridge.render = (request): NativeCallOutcome => {
    const r = request as NativeEffectRequest;
    seen.push(r.state);
    return { ok: true, result: { call: 'effect', identity: true, ...reply(n++) }, elapsedMs: 1 };
  };
}

const frame = (params: Record<string, unknown> = {}, invalidateOn?: string[]) =>
  runNativeEffect({
    pluginId: FAKE_NATIVE_ID,
    effectId: 'exposure',
    instanceId: 'layer-1',
    pixels: new Uint8ClampedArray(8),
    width: 2,
    height: 1,
    params,
    host: HOST,
    ...(invalidateOn ? { invalidateOn } : {}),
  });

describe('the round trip', () => {
  it('hands nothing on the first frame and the addon\'s own value after', async () => {
    answering(() => ({ state: { flow: 'field' } }));
    await frame();
    await frame();
    await frame();
    // Frame one has nothing to remember; two and three get what one built.
    expect(seen).toEqual([undefined, { flow: 'field' }, { flow: 'field' }]);
  });

  it('keeps what the host holds when the addon says nothing', async () => {
    // The case that has to be free: build once on frame one, stay silent after.
    answering((n) => (n === 0 ? { state: { built: true } } : {}));
    await frame();
    await frame();
    await frame();
    expect(seen).toEqual([undefined, { built: true }, { built: true }]);
  });

  it('clears on an explicit null', async () => {
    answering((n) => (n === 0 ? { state: 'cached' } : n === 1 ? { state: null } : {}));
    await frame();
    await frame();
    await frame();
    expect(seen).toEqual([undefined, 'cached', undefined]);
  });

  it('keeps two instances of one effect apart', async () => {
    bridge.render = (request): NativeCallOutcome => {
      const r = request as NativeEffectRequest;
      seen.push([r.instanceId, r.state]);
      return { ok: true, result: { call: 'effect', identity: true, state: `for-${r.instanceId}` }, elapsedMs: 1 };
    };
    const run = (instanceId: string) => runNativeEffect({
      pluginId: FAKE_NATIVE_ID, effectId: 'exposure', instanceId,
      pixels: new Uint8ClampedArray(8), width: 2, height: 1, params: {}, host: HOST,
    });
    await run('a');
    await run('b');
    await run('a');
    expect(seen).toEqual([['a', undefined], ['b', undefined], ['a', 'for-a']]);
  });
});

describe('invalidation through the call', () => {
  it('drops the cache when a declared param moves', async () => {
    answering(() => ({ state: 'derived' }));
    await frame({ radius: 4 }, ['radius']);
    await frame({ radius: 4 }, ['radius']);
    await frame({ radius: 9 }, ['radius']);
    expect(seen).toEqual([undefined, 'derived', undefined]);
  });

  it('keeps it when an undeclared param moves', async () => {
    answering(() => ({ state: 'derived' }));
    await frame({ radius: 4, tint: 'red' }, ['radius']);
    await frame({ radius: 4, tint: 'blue' }, ['radius']);
    expect(seen).toEqual([undefined, 'derived']);
  });

  it('survives every param moving when the effect declares none', async () => {
    // The default. A cache over the SOURCE must not be thrown away because a
    // slider moved — that is the cost the whole feature removes.
    answering(() => ({ state: 'derived' }));
    await frame({ a: 1 });
    await frame({ a: 2 });
    expect(seen).toEqual([undefined, 'derived']);
  });
});

describe('lifecycle and limits', () => {
  it('forgets everything when the plugin unloads', async () => {
    answering(() => ({ state: 'derived' }));
    await frame();
    await unloadNativePlugin(FAKE_NATIVE_ID);

    resetNativeSchedulerForTests(null);
    allowFakeNative();
    await loadNativePlugin(FAKE_NATIVE_LOAD_INPUT);
    answering(() => ({ state: 'derived' }));
    await frame();
    // A reload is a new process that never saw the old state.
    expect(seen[seen.length - 1]).toBeUndefined();
  });

  it('refuses an oversized cache and tells the author, once', async () => {
    answering(() => ({ state: { buf: new Uint8Array(MAX_SEQUENCE_BYTES + 1) } }));
    await frame();
    await frame();
    const errors = takeNativeErrors();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.pluginId).toBe(FAKE_NATIVE_ID);
    // Named against the plugin, so a publisher can find out without a profiler.
    expect(errors[0]!.message).toContain('rebuilt every frame');
    // And the frame still rendered — a refused cache is slow, never broken.
    expect(seen).toEqual([undefined, undefined]);
  });

  it('does not cache anything when the addon refuses the frame', async () => {
    bridge.render = (): NativeCallOutcome => ({ ok: false, code: 'failed', error: 'nope' });
    await frame();
    bridge.render = (request): NativeCallOutcome => {
      seen.push((request as NativeEffectRequest).state);
      return { ok: true, result: { call: 'effect', identity: true }, elapsedMs: 1 };
    };
    await frame();
    expect(seen).toEqual([undefined]);
  });
});
