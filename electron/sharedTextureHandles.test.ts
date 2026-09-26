/**
 * sharedTextureHandles + ioSurfaceBridge: the per-OS slot handle main gives
 * sharedTexture.importSharedTexture — NT handle bytes on Windows, a looked-up
 * IOSurfaceRef on macOS (held per ring, dropped exactly once), nothing on Linux.
 */

import type { SlotsMessage } from './engineFraming';
import { hostBridgePath, loadIoSurfaceBridge, type IoSurfaceBridge, type IoSurfaceRef } from './ioSurfaceBridge';
import { ioSurfaceSource, ntHandleSource, slotHandleSourceFor } from './sharedTextureHandles';

const ring = (generation: number, handles: number[] = [0x10, 0x14, 0]): SlotsMessage => ({
  type: 'slots', generation, viewport: 1, width: 64, height: 32, format: 'rgba8unorm', shared: true, handles,
});

function fakeBridge() {
  const lookups: Array<[number, number, number]> = [];
  const released: number[] = [];
  const bridge: IoSurfaceBridge = {
    lookup: (id, w, h) => {
      lookups.push([id, w, h]);
      return id === 0x99 ? null : { id, handle: Buffer.from([id, 1, 2, 3, 4, 5, 6, 7]) };
    },
    release: (s: IoSurfaceRef) => { released.push(s.id); },
  };
  return { bridge, lookups, released };
}

describe('ntHandleSource', () => {
  it('writes the handle value little-endian and knows only open rings', () => {
    const src = ntHandleSource();
    src.open(ring(1));
    expect(src.handle(1, 1)!.ntHandle!.readBigUInt64LE(0)).toBe(0x14n);
    expect(src.handle(1, 2)).toBeNull();   // a 0 handle
    expect(src.handle(2, 0)).toBeNull();
    src.open(ring(2));
    src.retire(2);
    expect(src.handle(1, 0)).toBeNull();
    expect(src.handle(2, 0)).not.toBeNull();
  });
});

describe('ioSurfaceSource', () => {
  it('looks every slot up with the ring size when the ring is announced', () => {
    const { bridge, lookups } = fakeBridge();
    const src = ioSurfaceSource(bridge);
    src.open(ring(1));
    expect(lookups).toEqual([[0x10, 64, 32], [0x14, 64, 32]]);
    expect(src.handle(1, 0)!.ioSurface![0]).toBe(0x10);
    expect(src.handle(1, 0)!.ntHandle).toBeUndefined();
    expect(src.handle(1, 2)).toBeNull();
  });

  it('reports an id that does not resolve and serves null for it', () => {
    const { bridge } = fakeBridge();
    const errors: string[] = [];
    const src = ioSurfaceSource(bridge, (m) => errors.push(m));
    src.open(ring(1, [0x99]));
    expect(src.handle(1, 0)).toBeNull();
    expect(errors[0]).toMatch(/did not resolve/);
  });

  it('releases a retired ring once, and everything on closeAll', () => {
    const { bridge, released } = fakeBridge();
    const src = ioSurfaceSource(bridge);
    src.open(ring(1));
    src.open(ring(2, [0x20]));
    src.retire(2);
    expect(released).toEqual([0x10, 0x14]);
    src.retire(2);
    expect(released).toEqual([0x10, 0x14]);
    src.closeAll();
    expect(released).toEqual([0x10, 0x14, 0x20]);
    expect(src.handle(2, 0)).toBeNull();
  });

  it('a generation announced twice drops the first lookups', () => {
    const { bridge, released } = fakeBridge();
    const src = ioSurfaceSource(bridge);
    src.open(ring(1));
    src.open(ring(1, [0x30]));
    expect(released).toEqual([0x10, 0x14]);
    expect(src.handle(1, 0)!.ioSurface![0]).toBe(0x30);
  });
});

describe('slotHandleSourceFor', () => {
  it('Windows always, macOS only with the bridge, Linux never', () => {
    const { bridge } = fakeBridge();
    expect(slotHandleSourceFor('win32', () => null)).not.toBeNull();
    expect(slotHandleSourceFor('darwin', () => bridge)).not.toBeNull();
    expect(slotHandleSourceFor('darwin', () => null)).toBeNull();
    expect(slotHandleSourceFor('linux', () => bridge)).toBeNull();
  });
});

describe('loadIoSurfaceBridge', () => {
  it('finds the module beside the engine, or at PREMATION_HOST_BRIDGE_PATH', () => {
    expect(hostBridgePath('/a/engine/premation-engine', {})).toMatch(/[\\/]a[\\/]engine[\\/]premation-host-bridge\.node$/);
    expect(hostBridgePath('/a/engine/premation-engine', { PREMATION_HOST_BRIDGE_PATH: '/x.node' })).toBe('/x.node');
    expect(hostBridgePath(null, {})).toBeNull();
  });

  it('loads only on macOS, only an existing file, only something bridge-shaped', () => {
    const { bridge } = fakeBridge();
    const logs: string[] = [];
    const base = { file: '/e/premation-host-bridge.node', exists: () => true, log: (m: string) => logs.push(m) };
    expect(loadIoSurfaceBridge({ ...base, platform: 'darwin', load: () => bridge })).toBe(bridge);
    expect(loadIoSurfaceBridge({ ...base, platform: 'linux', load: () => bridge })).toBeNull();
    expect(loadIoSurfaceBridge({ ...base, platform: 'darwin', exists: () => false, load: () => bridge })).toBeNull();
    expect(loadIoSurfaceBridge({ ...base, platform: 'darwin', load: () => ({}) })).toBeNull();
    expect(loadIoSurfaceBridge({ ...base, platform: 'darwin', load: () => { throw new Error('bad arch'); } })).toBeNull();
    expect(logs.join('\n')).toMatch(/not found[\s\S]*not premation-host-bridge[\s\S]*bad arch/);
  });
});
