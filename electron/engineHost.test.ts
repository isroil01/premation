/**
 * engineHost: the flag (default OFF), and shared-texture frame forwarding —
 * one transfer in flight, drop-not-block, release on allReferencesReleased,
 * nothing before the page's receiver is installed, and no release ever sent
 * to a successor engine for a slot of the one that died.
 */

jest.mock('electron', () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { FrameForwarder, engineBackendEnabled, engineOwnsDocument, nativePluginArgs, type ForwardedFrameMeta, type SharedTextureApi } from './engineHost';
import type { PixelFrame } from './pixelChannel';
import type { IoSurfaceBridge } from './ioSurfaceBridge';
import { ioSurfaceSource, type SlotTextureHandle as SharedTextureImportHandle } from './sharedTextureHandles';
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
        const rec = { handle: o.textureInfo.handle.ntHandle!.readBigUInt64LE(0), allReleased: o.allReferencesReleased, released: false };
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

  it('macOS: imports the IOSurfaceRef looked up for the slot, and drops a replaced ring once its transfer ends', async () => {
    const released: Array<[number, number]> = [];
    const sends: Array<{ resolve: () => void }> = [];
    const handles: Array<SharedTextureImportHandle> = [];
    const bridgeReleased: number[] = [];
    const bridge: IoSurfaceBridge = {
      lookup: (id) => ({ id, handle: Buffer.from([id & 0xff, 0, 0, 0, 0, 0, 0, 0]) }),
      release: (s) => { bridgeReleased.push(s.id); },
    };
    const st: SharedTextureApi = {
      importSharedTexture: (o) => {
        handles.push(o.textureInfo.handle);
        return { release: () => {} };
      },
      sendSharedTexture: () => new Promise<void>((resolve) => sends.push({ resolve })),
    };
    const fw = new FrameForwarder({ sharedTexture: st, target: () => ({}), release: (g, s) => released.push([g, s]), handles: ioSurfaceSource(bridge) });
    fw.engineStarted();
    fw.setReceiverReady(true);
    fw.onFrame(slots(1));
    fw.onFrame(ready(1, 2));
    expect(handles[0]!.ntHandle).toBeUndefined();
    expect(handles[0]!.ioSurface![0]).toBe(0x08);
    fw.onFrame(slots(2));                        // resize while slot 2 of ring 1 is in flight
    expect(bridgeReleased).toEqual([]);
    sends[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(bridgeReleased).toEqual([0x100, 0x104, 0x108]);
    fw.engineStarted();
    expect(bridgeReleased).toHaveLength(6);      // ring 2 goes with the engine
  });

  describe('route A (pixel copies)', () => {
    const pixels = (generation: number, slot: number, width = 64, height = 32): PixelFrame => ({
      generation, slot, width, height, bytesPerRow: width * 4, format: 0, data: new Uint8Array(width * height * 4),
    });
    function copySetup() {
      const released: Array<[number, number]> = [];
      const sent: Array<{ meta: ForwardedFrameMeta; bytes: number }> = [];
      let accept = true;
      const fw = new FrameForwarder({
        sharedTexture: null,
        target: () => ({}),
        release: (g, s) => released.push([g, s]),
        sendPixels: (meta, px) => {
          if (!accept) return false;
          sent.push({ meta, bytes: px.length });
          return true;
        },
      });
      fw.engineStarted();
      fw.setReceiverReady(false, true);
      fw.onFrame(slots(1, false));
      return { fw, released, sent, refuse: () => { accept = false; } };
    }

    it('pairs FrameReady and pixels in either order, and frees the slot when the page releases it', () => {
      const { fw, released, sent } = copySetup();
      fw.onFrame(ready(1, 0));
      expect(sent).toHaveLength(0);
      fw.onPixels(pixels(1, 0));                 // pixels after the FrameReady
      fw.onPixels(pixels(1, 1));                 // pixels before the FrameReady
      fw.onFrame(ready(1, 1));
      expect(sent.map((s) => [s.meta.slot, s.meta.route, s.bytes])).toEqual([[0, 'copy', 64 * 32 * 4], [1, 'copy', 64 * 32 * 4]]);
      expect(released).toEqual([]);
      fw.pixelsReleased(1, 1);
      fw.pixelsReleased(1, 1);                   // once only
      expect(released).toEqual([[1, 1]]);
      expect(fw.stats.copied).toBe(2);
    });

    it('holds at most two copies in the page; the rest go straight back', () => {
      const { fw, released, sent } = copySetup();
      for (const slot of [0, 1, 2]) {
        fw.onPixels(pixels(1, slot));
        fw.onFrame(ready(1, slot));
      }
      expect(sent).toHaveLength(2);
      expect(released).toEqual([[1, 2]]);
    });

    it('drops when the page has no pixel receiver, a size disagrees, or the send fails', () => {
      const { fw, released, sent, refuse } = copySetup();
      fw.setReceiverReady(false, false);
      fw.onPixels(pixels(1, 0));
      fw.onFrame(ready(1, 0));
      fw.setReceiverReady(false, true);
      fw.onPixels(pixels(1, 1, 32, 32));
      fw.onFrame(ready(1, 1));
      refuse();
      fw.onPixels(pixels(1, 2));
      fw.onFrame(ready(1, 2));
      expect(sent).toHaveLength(0);
      expect(released).toEqual([[1, 0], [1, 1], [1, 2]]);
    });

    it('a page reset frees what the page held; a new engine frees nothing of the old one', () => {
      const { fw, released } = copySetup();
      fw.onPixels(pixels(1, 0));
      fw.onFrame(ready(1, 0));
      fw.setReceiverReady(false, false);         // page reloaded
      expect(released).toEqual([[1, 0]]);
      fw.setReceiverReady(false, true);
      fw.onPixels(pixels(1, 1));
      fw.onFrame(ready(1, 1));
      fw.engineStarted();
      fw.pixelsReleased(1, 1);
      expect(released).toEqual([[1, 0]]);
      fw.onPixels(pixels(1, 0));                 // no ring yet in the new engine: ignored
      expect(released).toEqual([[1, 0]]);
    });
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
