/**
 * Environment bindings for `BundleFs`.
 *
 *   - `ElectronBundleFs` → the real disk, via new `bundle:*` preload IPC. This is
 *     the desktop path; the main process does the atomic temp+rename and path
 *     containment. Falls back to the virtual FS for any method the preload does
 *     not (yet) expose, mirroring `ElectronFileAdapter`.
 *   - `VirtualBundleFs` → the localStorage virtual filesystem the browser build
 *     already uses (`motion-editor.fs:` namespace), so a web build gets chunked
 *     bundles too. `setItem` is atomic, so `writeAtomic` needs no temp dance.
 *
 * `detectBundleFs()` picks the right one, exactly like `detectFileAdapter()`.
 */

import type { MotionEditorApi } from '@app-types/motionEditor';
import type { BundleFs } from './BundleFs';

const FS_PREFIX = 'motion-editor.fs:';
const keyFor = (root: string, name: string): string => `${FS_PREFIX}${root}/${name}`;

/** localStorage-backed bundle FS. Each chunk is one key under the bundle root. */
export class VirtualBundleFs implements BundleFs {
  async read(root: string, name: string): Promise<string | null> {
    try {
      return localStorage.getItem(keyFor(root, name));
    } catch {
      return null;
    }
  }

  async writeAtomic(root: string, name: string, contents: string): Promise<void> {
    try {
      localStorage.setItem(keyFor(root, name), contents);
    } catch {
      /* quota — best effort, same as BrowserFileAdapter */
    }
  }

  async remove(root: string, name: string): Promise<void> {
    try {
      localStorage.removeItem(keyFor(root, name));
    } catch {
      /* ignore */
    }
  }

  async list(root: string): Promise<string[]> {
    const prefix = `${FS_PREFIX}${root}/`;
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  async exists(root: string): Promise<boolean> {
    return (await this.list(root)).length > 0;
  }
}

/** Desktop bundle FS — forwards to `window.motionEditor.bundle`, else virtual. */
export class ElectronBundleFs implements BundleFs {
  private readonly fallback = new VirtualBundleFs();
  constructor(private readonly bridge: MotionEditorApi) {}

  async read(root: string, name: string): Promise<string | null> {
    return this.bridge.bundle?.read ? this.bridge.bundle.read(root, name) : this.fallback.read(root, name);
  }
  async writeAtomic(root: string, name: string, contents: string): Promise<void> {
    return this.bridge.bundle?.writeAtomic
      ? this.bridge.bundle.writeAtomic(root, name, contents)
      : this.fallback.writeAtomic(root, name, contents);
  }
  async remove(root: string, name: string): Promise<void> {
    return this.bridge.bundle?.remove ? this.bridge.bundle.remove(root, name) : this.fallback.remove(root, name);
  }
  async list(root: string): Promise<string[]> {
    return this.bridge.bundle?.list ? this.bridge.bundle.list(root) : this.fallback.list(root);
  }
  async exists(root: string): Promise<boolean> {
    return (await this.list(root)).length > 0;
  }
}

/** Pick the best bundle FS for the current environment (Electron when present). */
export function detectBundleFs(): BundleFs {
  const bridge = typeof window !== 'undefined' ? window.motionEditor : undefined;
  if (bridge?.bundle) return new ElectronBundleFs(bridge);
  return new VirtualBundleFs();
}
