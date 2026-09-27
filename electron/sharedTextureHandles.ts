/**
 * sharedTextureHandles — what Electron main hands `sharedTexture.importSharedTexture`
 * for a slot of the engine's shared-texture ring, per OS (docs/VIEWPORT_ROUTE.md
 * route C; the engine half is native/engine/src/shared_texture_ffi*.cpp).
 *
 *   win32   FrameSlots.handles are NT handles the engine duplicated into THIS
 *           process → `{ ntHandle: <8-byte LE Buffer> }`. The engine owns them
 *           (it closes them when a ring is retired); main never closes one.
 *   darwin  FrameSlots.handles are global IOSurfaceIDs → each is looked up once
 *           per ring through premation-host-bridge.node (ioSurfaceBridge.ts)
 *           into a process-local IOSurfaceRef → `{ ioSurface: <pointer Buffer> }`.
 *           Main holds those references and drops them when the ring is
 *           replaced or the engine goes away. The lookup happens as soon as the
 *           ring is announced: the engine frees a retired ring's surfaces after
 *           a 2 s grace, and an id can be recycled after that.
 *   linux   (UNVERIFIED — no Linux GPU box has run it) FrameSlots.handles are
 *           the dmabuf fd numbers IN THE ENGINE (shared_texture_ffi_linux.cpp,
 *           built where GBM exists) with each plane's stride / offset / size
 *           and the modifier → each is duplicated into main once per ring with
 *           pidfd_getfd (premation-host-bridge.node, dmabufSource) →
 *           `{ nativePixmap: { planes: [{ fd, stride, offset, size }], modifier } }`.
 *           Main closes its duplicates when the ring is retired. Without the
 *           bridge (or GBM in the engine) null, and the engine is asked for the
 *           route-A frame copy instead.
 */

import type { SlotsMessage } from './engineFraming';
import type { DmabufBridge, IoSurfaceBridge, IoSurfaceRef } from './ioSurfaceBridge';

/** Electron's NativePixmap (Linux), one plane. */
export interface SlotNativePixmap {
  planes: Array<{ stride: number; offset: number; size: number; fd: number }>;
  modifier: string;
  supportsZeroCopyWebGpuImport: boolean;
}

/** The `handle` member of Electron's SharedTextureImportTextureInfo that main fills. */
export interface SlotTextureHandle {
  ntHandle?: Buffer;
  ioSurface?: Buffer;
  nativePixmap?: SlotNativePixmap;
}

export interface SlotHandleSource {
  /** A shared ring was announced (resolve what needs resolving now). */
  open(ring: SlotsMessage): void;
  /** The handle for one slot of an open ring, or null (unknown ring/slot, lookup failed). */
  handle(generation: number, slot: number): SlotTextureHandle | null;
  /** Drop every ring but `keep` — one generation, or the set every viewport still shows (no transfer from the others is in flight any more). */
  retire(keep: number | ReadonlySet<number>): void;
  /** Drop every ring (engine restart / shutdown). */
  closeAll(): void;
}

function keeps(keep: number | ReadonlySet<number>, generation: number): boolean {
  return typeof keep === 'number' ? keep === generation : keep.has(generation);
}

/** Windows: the NT handle value itself, little-endian, as Electron reads it. */
export function ntHandleSource(): SlotHandleSource {
  const rings = new Map<number, SlotsMessage>();
  return {
    open: (ring) => {
      rings.set(ring.generation, ring);
    },
    handle: (generation, slot) => {
      const h = rings.get(generation)?.handles[slot];
      if (!h) return null;
      const nt = Buffer.alloc(8);
      nt.writeBigUInt64LE(BigInt(h));
      return { ntHandle: nt };
    },
    retire: (keep) => {
      for (const g of [...rings.keys()]) if (!keeps(keep, g)) rings.delete(g);
    },
    closeAll: () => rings.clear(),
  };
}

/** macOS: IOSurfaceID → a process-local IOSurfaceRef, held while the ring is current. */
export function ioSurfaceSource(bridge: IoSurfaceBridge, onError?: (message: string) => void): SlotHandleSource {
  const rings = new Map<number, Array<IoSurfaceRef | null>>();
  const drop = (generation: number): void => {
    for (const s of rings.get(generation) ?? []) {
      if (!s) continue;
      try {
        bridge.release(s);
      } catch (e) {
        onError?.(e instanceof Error ? e.message : String(e));
      }
    }
    rings.delete(generation);
  };
  return {
    open: (ring) => {
      drop(ring.generation);
      rings.set(
        ring.generation,
        ring.handles.map((id) => {
          if (!id) return null;
          try {
            const s = bridge.lookup(id, ring.width, ring.height);
            if (!s) onError?.(`IOSurface ${id} (${ring.width}×${ring.height}) did not resolve`);
            return s;
          } catch (e) {
            onError?.(e instanceof Error ? e.message : String(e));
            return null;
          }
        }),
      );
    },
    handle: (generation, slot) => {
      const s = rings.get(generation)?.[slot];
      return s ? { ioSurface: s.handle } : null;
    },
    retire: (keep) => {
      for (const g of [...rings.keys()]) if (!keeps(keep, g)) drop(g);
    },
    closeAll: () => {
      for (const g of [...rings.keys()]) drop(g);
    },
  };
}

/**
 * Linux: the engine's dmabuf fds → duplicates in main (pidfd_getfd), held while
 * the ring is current. A ring without plane layouts (an engine without GBM
 * announced `shared` anyway, or a malformed message) resolves to nothing, and
 * its frames are dropped like any unresolved slot.
 */
export function dmabufSource(bridge: DmabufBridge, enginePid: () => number | undefined, onError?: (message: string) => void): SlotHandleSource {
  const rings = new Map<number, { fds: Array<number | null>; ring: SlotsMessage }>();
  const drop = (generation: number): void => {
    for (const fd of rings.get(generation)?.fds ?? []) {
      if (fd === null) continue;
      try {
        bridge.closeFd(fd);
      } catch (e) {
        onError?.(e instanceof Error ? e.message : String(e));
      }
    }
    rings.delete(generation);
  };
  return {
    open: (ring) => {
      drop(ring.generation);
      const pid = enginePid();
      const laidOut = ring.strides.length === ring.handles.length && ring.sizes.length === ring.handles.length;
      if (!laidOut) onError?.(`dmabuf ring ${ring.generation} has no plane layout`);
      rings.set(ring.generation, {
        ring,
        fds: ring.handles.map((remote) => {
          if (!pid || !laidOut || remote < 0) return null;
          try {
            const fd = bridge.dupFd(pid, Number(remote));
            if (fd === null) onError?.(`pidfd_getfd(${pid}, ${remote}) failed`);
            return fd;
          } catch (e) {
            onError?.(e instanceof Error ? e.message : String(e));
            return null;
          }
        }),
      });
    },
    handle: (generation, slot) => {
      const r = rings.get(generation);
      const fd = r?.fds[slot];
      if (!r || fd === null || fd === undefined) return null;
      return {
        nativePixmap: {
          planes: [{ fd, stride: r.ring.strides[slot] ?? 0, offset: r.ring.offsets[slot] ?? 0, size: Number(r.ring.sizes[slot] ?? 0) }],
          modifier: String(r.ring.modifier),
          supportsZeroCopyWebGpuImport: false,
        },
      };
    },
    retire: (keep) => {
      for (const g of [...rings.keys()]) if (!keeps(keep, g)) drop(g);
    },
    closeAll: () => {
      for (const g of [...rings.keys()]) drop(g);
    },
  };
}

/**
 * The source for this platform, or null when frames cannot be shared here
 * (macOS without the host bridge; Linux without it or without `linux`) — the
 * caller then asks the engine for the route-A copy.
 */
export function slotHandleSourceFor(
  platform: NodeJS.Platform,
  loadBridge: () => IoSurfaceBridge | null,
  onError?: (message: string) => void,
  linux?: { loadDmabuf: () => DmabufBridge | null; enginePid: () => number | undefined },
): SlotHandleSource | null {
  if (platform === 'win32') return ntHandleSource();
  if (platform === 'darwin') {
    const bridge = loadBridge();
    return bridge ? ioSurfaceSource(bridge, onError) : null;
  }
  if (platform === 'linux' && linux) {
    const bridge = linux.loadDmabuf();
    return bridge ? dmabufSource(bridge, linux.enginePid, onError) : null;
  }
  return null;
}
