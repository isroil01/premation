/**
 * Environment bindings for `BlobStore` (binary asset bytes), bound to a bundle
 * root at construction (the port itself is rootless).
 *
 *   - `ElectronBlobStore` → real disk via the binary `blob:*` IPC.
 *   - `VirtualBlobStore`  → localStorage (base64) for the browser build.
 *
 * `createBlobStore(root)` picks the right one, mirroring `detectBundleFs`.
 */

import type { MotionEditorApi } from '@app-types/motionEditor';
import type { BlobStore } from './BlobStore';

const PREFIX = 'motion-editor.blobs:';
const keyFor = (root: string, hash: string): string => `${PREFIX}${root}/${hash}`;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** localStorage-backed binary store (base64). */
export class VirtualBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async has(hash: string): Promise<boolean> {
    try {
      return localStorage.getItem(keyFor(this.root, hash)) != null;
    } catch {
      return false;
    }
  }
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    try {
      localStorage.setItem(keyFor(this.root, hash), bytesToBase64(bytes));
    } catch {
      /* quota */
    }
  }
  async read(hash: string): Promise<Uint8Array | null> {
    try {
      const b64 = localStorage.getItem(keyFor(this.root, hash));
      return b64 == null ? null : base64ToBytes(b64);
    } catch {
      return null;
    }
  }
  async delete(hash: string): Promise<void> {
    try {
      localStorage.removeItem(keyFor(this.root, hash));
    } catch {
      /* ignore */
    }
  }
  async list(): Promise<string[]> {
    const prefix = `${PREFIX}${this.root}/`;
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
}

/** Disk-backed blob store via the `blob:*` IPC; falls back to virtual. */
export class ElectronBlobStore implements BlobStore {
  private readonly fallback: VirtualBlobStore;
  constructor(private readonly root: string, private readonly bridge: MotionEditorApi) {
    this.fallback = new VirtualBlobStore(root);
  }
  async has(hash: string): Promise<boolean> {
    return this.bridge.blob?.has ? this.bridge.blob.has(this.root, hash) : this.fallback.has(hash);
  }
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    return this.bridge.blob?.write ? this.bridge.blob.write(this.root, hash, bytes) : this.fallback.put(hash, bytes);
  }
  async read(hash: string): Promise<Uint8Array | null> {
    return this.bridge.blob?.read ? this.bridge.blob.read(this.root, hash) : this.fallback.read(hash);
  }
  async delete(hash: string): Promise<void> {
    return this.bridge.blob?.remove ? this.bridge.blob.remove(this.root, hash) : this.fallback.delete(hash);
  }
  async list(): Promise<string[]> {
    return this.bridge.blob?.list ? this.bridge.blob.list(this.root) : this.fallback.list();
  }
}

/** Pick the blob store for the current environment, bound to `root`. */
export function createBlobStore(root: string): BlobStore {
  const bridge = typeof window !== 'undefined' ? window.motionEditor : undefined;
  if (bridge?.blob) return new ElectronBlobStore(root, bridge);
  return new VirtualBlobStore(root);
}
