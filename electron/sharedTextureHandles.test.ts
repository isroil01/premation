/**
 * sharedTextureHandles + ioSurfaceBridge: the per-OS slot handle main gives
 * sharedTexture.importSharedTexture — NT handle bytes on Windows, a looked-up
 * IOSurfaceRef on macOS (held per ring, dropped exactly once), nothing on Linux.
 */

import type { SlotsMessage } from './engineFraming';
import { hostBridgePath, loadDmabufBridge, loadIoSurfaceBridge, type DmabufBridge, type IoSurfaceBridge, type IoSurfaceRef } from './ioSurfaceBridge';
import { dmabufSource, ioSurfaceSource, ntHandleSource, slotHandleSourceFor } from './sharedTextureHandles';

const ring = (generation: number, handles: number[] = [0x10, 0x14, 0]): SlotsMessage => ({
  type: 'slots', generation, viewport: 1, width: 64, height: 32, format: 'rgba8unorm', shared: true, handles,
  strides: [], offsets: [], sizes: [], modifier: 0,
});

/** A Linux dmabuf ring: fd numbers in the engine + one plane layout per slot. */
const dmaRing = (generation: number, fds: number[] = [21, 22]): SlotsMessage => ({
  ...ring(generation, fds), strides: fds.map(() => 256), offsets: fds.map(() => 0), sizes: fds.map(() => 256 * 32),
});

function fakeDmabuf() {
  const dups: Array<[number, number]> = [];
  const closed: number[] = [];
  const bridge: DmabufBridge = {
    dupFd: (pid, fd) => { dups.push([pid, fd]); return fd === 99 ? null : fd + 100; },
    closeFd: (fd) => { closed.push(fd); },
  };
  return { bridge, dups, closed };
}

describe('dmabufSource (Linux)', () => {
  it('duplicates each slot fd out of the engine once per ring and imports it as a native pixmap', () => {
    const { bridge, dups } = fakeDmabuf();
    const src = dmabufSource(bridge, () => 4242);
    src.open(dmaRing(1));
    expect(dups).toEqual([[4242, 21], [4242, 22]]);
    expect(src.handle(1, 1)).toEqual({
      nativePixmap: { planes: [{ fd: 122, stride: 256, offset: 0, size: 8192 }], modifier: '0', supportsZeroCopyWebGpuImport: false },
    });
    expect(src.handle(2, 0)).toBeNull();
  });

  it('closes its duplicates when the ring is retired or the engine goes, and resolves nothing without a layout or a pid', () => {
    const { bridge, closed } = fakeDmabuf();
    let pid: number | undefined = 7;
    const errors: string[] = [];
    const src = dmabufSource(bridge, () => pid, (m) => errors.push(m));
    src.open(dmaRing(1));
    src.open(dmaRing(2, [23, 99]));
    expect(src.handle(2, 1)).toBeNull();  // dupFd refused
    src.retire(2);
    expect(closed).toEqual([121, 122]);
    src.closeAll();
    expect(closed).toEqual([121, 122, 123]);
    src.open(ring(3, [30]));  // shared but no plane layout
    expect(src.handle(3, 0)).toBeNull();
    pid = undefined;
    src.open(dmaRing(4));
    expect(src.handle(4, 0)).toBeNull();
    expect(errors.some((e) => /no plane layout/.test(e))).toBe(true);
  });
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

  it('Linux with the dmabuf bridge only', () => {
    const { bridge } = fakeDmabuf();
    expect(slotHandleSourceFor('linux', () => null, undefined, { loadDmabuf: () => bridge, enginePid: () => 1 })).not.toBeNull();
    expect(slotHandleSourceFor('linux', () => null, undefined, { loadDmabuf: () => null, enginePid: () => 1 })).toBeNull();
  });
});

describe('loadDmabufBridge', () => {
  it('loads only on Linux, only a module with dupFd / closeFd', () => {
    const { bridge } = fakeDmabuf();
    const base = { file: '/x/premation-host-bridge.node', exists: () => true };
    expect(loadDmabufBridge({ ...base, platform: 'linux', load: () => bridge })).toBe(bridge);
    expect(loadDmabufBridge({ ...base, platform: 'darwin', load: () => bridge })).toBeNull();
    expect(loadDmabufBridge({ ...base, platform: 'linux', load: () => ({ lookup() {}, release() {} }) })).toBeNull();
    expect(loadDmabufBridge({ ...base, platform: 'linux', exists: () => false, load: () => bridge })).toBeNull();
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
