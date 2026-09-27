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
 *   linux   no shared route (dmabuf needs GBM allocation in the engine and fd
 *           passing into main, neither of which exists yet): null, and the
 *           engine is asked for the route-A frame copy instead.
 */

import type { SlotsMessage } from './engineFraming';
import type { IoSurfaceBridge, IoSurfaceRef } from './ioSurfaceBridge';

/** The `handle` member of Electron's SharedTextureImportTextureInfo that main fills. */
export interface SlotTextureHandle {
  ntHandle?: Buffer;
  ioSurface?: Buffer;
}

export interface SlotHandleSource {
  /** A shared ring was announced (resolve what needs resolving now). */
  open(ring: SlotsMessage): void;
  /** The handle for one slot of an open ring, or null (unknown ring/slot, lookup failed). */
  handle(generation: number, slot: number): SlotTextureHandle | null;
  /** Drop every ring but `keep` (no transfer from them is in flight any more). */
  retire(keep: number): void;
  /** Drop every ring (engine restart / shutdown). */
  closeAll(): void;
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
      for (const g of [...rings.keys()]) if (g !== keep) rings.delete(g);
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
      for (const g of [...rings.keys()]) if (g !== keep) drop(g);
    },
    closeAll: () => {
      for (const g of [...rings.keys()]) drop(g);
    },
  };
}

/**
 * The source for this platform, or null when frames cannot be shared here
 * (Linux; macOS without the host bridge) — the caller then asks the engine for
 * the route-A copy.
 */
export function slotHandleSourceFor(
  platform: NodeJS.Platform,
  loadBridge: () => IoSurfaceBridge | null,
  onError?: (message: string) => void,
): SlotHandleSource | null {
  if (platform === 'win32') return ntHandleSource();
  if (platform === 'darwin') {
    const bridge = loadBridge();
    return bridge ? ioSurfaceSource(bridge, onError) : null;
  }
  return null;
}
