/**
 * engineHost: the flag (default OFF), and shared-texture frame forwarding —
 * one transfer in flight, drop-not-block, release on allReferencesReleased,
 * nothing before the page's receiver is installed, and no release ever sent
 * to a successor engine for a slot of the one that died.
 */

jest.mock('electron', () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { FrameForwarder, engineBackendEnabled, engineOwnsDocument, nativePluginArgs, type SharedTextureApi } from './engineHost';
import type { FrameReadyMessage, SlotsMessage } from './engineFraming';

describe('engineBackendEnabled', () => {
  const read = (text: string | null) => () => text;

  it('is off by default', () => {
    expect(engineBackendEnabled({}, null)).toBe(false);
    expect(engineBackendEnabled({}, 'engine.json', read(null))).toBe(false);
    expect(engineBackendEnabled({}, 'engine.json', read('not json'))).toBe(false);
  });

  it('turns on with PREMATION_ENGINE=process or the preference', () => {
    expect(engineBackendEnabled({ PREMATION_ENGINE: 'process' }, null)).toBe(true);
    expect(engineBackendEnabled({}, 'engine.json', read('{"backend":"process"}'))).toBe(true);
  });

  it('the environment can force it off over the preference', () => {
    expect(engineBackendEnabled({ PREMATION_ENGINE: 'ts' }, 'engine.json', read('{"backend":"process"}'))).toBe(false);
  });
});

describe('engineOwnsDocument (F2)', () => {
  const read = (text: string | null) => () => text;

  it('is off by default, and off without the process backend', () => {
    expect(engineOwnsDocument({}, null)).toBe(false);
    expect(engineOwnsDocument({ PREMATION_ENGINE: 'process' }, null)).toBe(false);
    expect(engineOwnsDocument({ PREMATION_ENGINE_OWNER: 'engine' }, null)).toBe(false);
    expect(engineOwnsDocument({}, 'engine.json', read('{"owner":"engine"}'))).toBe(false);
  });

  it('turns on with PREMATION_ENGINE_OWNER=engine or the preference, over the process backend', () => {
    expect(engineOwnsDocument({ PREMATION_ENGINE: 'process', PREMATION_ENGINE_OWNER: 'engine' }, null)).toBe(true);
    expect(engineOwnsDocument({}, 'engine.json', read('{"backend":"process","owner":"engine"}'))).toBe(true);
  });

  it('the environment can force it off over the preference', () => {
    expect(engineOwnsDocument({ PREMATION_ENGINE_OWNER: 'ui' }, 'engine.json', read('{"backend":"process","owner":"engine"}'))).toBe(false);
  });
});

describe('nativePluginArgs (G1)', () => {
  it('hands the engine the plugin folder and the crash journal', () => {
    expect(nativePluginArgs('/u/native-plugins', '/u/journal.bin')).toEqual(['--plugins', '/u/native-plugins', '--plugin-journal', '/u/journal.bin']);
  });
  it('omits what is not configured', () => {
    expect(nativePluginArgs(undefined, undefined)).toEqual([]);
    expect(nativePluginArgs('/u/p', undefined)).toEqual(['--plugins', '/u/p']);
  });
});

describe('FrameForwarder', () => {
  const slots = (generation: number, shared = true): SlotsMessage => ({
    type: 'slots', generation, viewport: 1, width: 64, height: 32, format: 'rgba8unorm', shared, handles: [0x100, 0x104, 0x108],
  });
  const ready = (generation: number, slot: number): FrameReadyMessage => ({
    type: 'frameReady', generation, slot, viewport: 1, dropped: 0, frame: 1, time: 0, revision: 3, renderStartUs: 0, renderDoneUs: 0, width: 64, height: 32,
  });

  function setup() {
    const released: Array<[number, number]> = [];
    const sends: Array<{ resolve: () => void; reject: (e: Error) => void; meta: unknown }> = [];
    const imports: Array<{ handle: bigint; allReleased?: () => void; released: boolean }> = [];
    const st: SharedTextureApi = {
      importSharedTexture: (o) => {
        const rec = { handle: o.textureInfo.handle.ntHandle.readBigUInt64LE(0), allReleased: o.allReferencesReleased, released: false };
        imports.push(rec);
        return { release: () => { rec.released = true; } };
      },
      sendSharedTexture: (_o, meta) => new Promise<void>((resolve, reject) => sends.push({ resolve, reject, meta })),
    };
    const fw = new FrameForwarder({ sharedTexture: st, target: () => ({ frame: 'main' }), release: (g, s) => released.push([g, s]) });
    fw.engineStarted();
    return { fw, released, sends, imports };
  }

  it('drops (releases at once) until the page receiver is ready', () => {
    const { fw, released, imports } = setup();
    fw.onFrame(slots(1));
    fw.onFrame(ready(1, 0));
    expect(imports).toHaveLength(0);
    expect(released).toEqual([[1, 0]]);
    expect(fw.stats.dropped).toBe(1);
  });

  it('forwards one at a time and frees the slot when every reference is released', async () => {
    const { fw, released, sends, imports } = setup();
    fw.setReceiverReady(true);
    fw.onFrame(slots(1));
    fw.onFrame(ready(1, 1));
    expect(imports).toHaveLength(1);
    expect(imports[0]!.handle).toBe(0x104n);
    // A second frame while the first is in flight goes straight back.
    fw.onFrame(ready(1, 2));
    expect(released).toEqual([[1, 2]]);
    sends[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(imports[0]!.released).toBe(true);   // main's reference, right after the send
    expect(released).toEqual([[1, 2]]);        // the page still holds slot 1
    imports[0]!.allReleased!();
    expect(released).toEqual([[1, 2], [1, 1]]);
    imports[0]!.allReleased!();                 // idempotent
    expect(released).toHaveLength(2);
    expect(fw.stats.forwarded).toBe(1);
    expect(sends[0]!.meta).toMatchObject({ viewport: 1, generation: 1, slot: 1, revision: 3, width: 64, height: 32 });
  });

  it('a failed send frees the slot', async () => {
    const { fw, released, sends, imports } = setup();
    fw.setReceiverReady(true);
    fw.onFrame(slots(1));
    fw.onFrame(ready(1, 0));
    sends[0]!.reject(new Error('timed out'));
    await new Promise((r) => setTimeout(r, 0));
    imports[0]!.allReleased!();
    expect(released).toEqual([[1, 0]]);
    expect(fw.stats.errors).toEqual(['timed out']);
  });

  it('offscreen (non-shared) rings and unknown generations are released unused', () => {
    const { fw, released, imports } = setup();
    fw.setReceiverReady(true);
    fw.onFrame(slots(1, false));
    fw.onFrame(ready(1, 0));
    fw.onFrame(ready(9, 0));
    expect(imports).toHaveLength(0);
    expect(released).toEqual([[1, 0], [9, 0]]);
  });

  it('never releases a dead engine’s slot to its successor', async () => {
    const { fw, released, sends, imports } = setup();
    fw.setReceiverReady(true);
    fw.onFrame(slots(1));
    fw.onFrame(ready(1, 0));
    fw.engineStarted();            // the engine restarted: generation 1 means something else now
    sends[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    imports[0]!.allReleased!();
    expect(released).toEqual([]);
    fw.onFrame(slots(1));
    fw.onFrame(ready(1, 0));
    expect(imports).toHaveLength(2);
  });
});
