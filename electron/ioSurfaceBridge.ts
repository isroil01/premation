/**
 * ioSurfaceBridge — loads premation-host-bridge.node (macOS only;
 * native/engine/host_bridge/iosurface_bridge_ffi.cpp), which turns the global
 * IOSurfaceIDs the engine announces into IOSurfaceRefs local to Electron main:
 * `sharedTexture.importSharedTexture({ handle: { ioSurface } })` needs a
 * reference valid in the calling process.
 *
 * The module lives beside premation-engine (native/build/<preset>/engine in
 * development, <resources>/engine when packaged — electron-builder ships both),
 * or at PREMATION_HOST_BRIDGE_PATH. It is an OS-handle shim, not engine code.
 * Missing or unloadable → null, and the host asks the engine for the route-A
 * frame copy instead of shared textures.
 */

import path from 'node:path';

/** A retained IOSurfaceRef in this process. */
export interface IoSurfaceRef {
  /** The IOSurfaceRef pointer (native byte order), what Electron's `ioSurface` takes. */
  readonly handle: Buffer;
  readonly id: number;
}

export interface IoSurfaceBridge {
  /** Retain the surface named `id`; null when it does not resolve or its size is not width × height. */
  lookup(id: number, width: number, height: number): IoSurfaceRef | null;
  /** Drop the reference (idempotent). */
  release(surface: IoSurfaceRef): void;
}

export const HOST_BRIDGE_FILE = 'premation-host-bridge.node';

/** Where the bridge is expected, given the engine executable's path. */
export function hostBridgePath(engineExe: string | null, vars: Record<string, string | undefined>): string | null {
  const override = vars.PREMATION_HOST_BRIDGE_PATH;
  if (override) return override;
  return engineExe ? path.join(path.dirname(engineExe), HOST_BRIDGE_FILE) : null;
}

function isBridge(m: unknown): m is IoSurfaceBridge {
  const b = m as Partial<IoSurfaceBridge> | null;
  return !!b && typeof b.lookup === 'function' && typeof b.release === 'function';
}

/** Load the bridge; null (with the reason logged) when it is absent or not a bridge. */
export function loadIoSurfaceBridge(opts: {
  platform: NodeJS.Platform;
  file: string | null;
  exists(p: string): boolean;
  /** `require` of an absolute .node path (injectable for tests). */
  load?(p: string): unknown;
  log?(message: string): void;
}): IoSurfaceBridge | null {
  if (opts.platform !== 'darwin' || !opts.file) return null;
  if (!opts.exists(opts.file)) {
    opts.log?.(`host bridge not found at ${opts.file}`);
    return null;
  }
  try {
    const m = (opts.load ?? ((p: string) => require(p) as unknown))(opts.file);
    if (isBridge(m)) return m;
    opts.log?.(`${opts.file} is not premation-host-bridge`);
  } catch (e) {
    opts.log?.(`host bridge failed to load: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}
