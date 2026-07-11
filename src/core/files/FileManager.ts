/**
 * FileManager — filesystem access behind a swappable adapter.
 *
 * The desktop build will inject an Electron adapter (main-process IPC + native
 * dialogs); the browser build uses the File System Access API when available
 * and always has a localStorage-backed virtual filesystem as a fallback so the
 * app is fully functional in either environment. Callers depend only on the
 * `FileManager` surface, never on the environment.
 */

import type { MotionEditorApi } from '@app-types/motionEditor';

export interface StoredFile {
  /** Opaque path/handle identifier. */
  path: string;
  name: string;
  contents: string;
}

export interface OpenOptions {
  /** Allowed extensions without the dot, e.g. ['motion', 'json']. */
  extensions?: string[];
}

export interface FileAdapter {
  readonly kind: 'browser' | 'electron';
  open(opts?: OpenOptions): Promise<StoredFile | null>;
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
  chooseSavePath(defaultName: string): Promise<string | null>;
  list(): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

const FS_PREFIX = 'motion-editor.fs:';

/** localStorage-backed virtual filesystem + File System Access API when present. */
export class BrowserFileAdapter implements FileAdapter {
  readonly kind = 'browser' as const;

  async open(opts?: OpenOptions): Promise<StoredFile | null> {
    const picker = (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    if (typeof picker === 'function') {
      try {
        const [handle] = await (picker as (o?: unknown) => Promise<Array<{ getFile(): Promise<File> }>>)({
          types: opts?.extensions
            ? [{ description: 'Project', accept: { 'application/json': opts.extensions.map((e) => `.${e}`) } }]
            : undefined,
        });
        if (!handle) return null;
        const file = await handle.getFile();
        const contents = await file.text();
        return { path: file.name, name: file.name, contents };
      } catch {
        return null; // user cancelled / unsupported
      }
    }
    return null;
  }

  async read(path: string): Promise<string | null> {
    try {
      return localStorage.getItem(FS_PREFIX + path);
    } catch {
      return null;
    }
  }

  async write(path: string, contents: string): Promise<void> {
    try {
      localStorage.setItem(FS_PREFIX + path, contents);
    } catch {
      /* ignore quota */
    }
  }

  async chooseSavePath(defaultName: string): Promise<string | null> {
    // Virtual FS: the default name is the path. A future dialog can override.
    return defaultName;
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(FS_PREFIX)) out.push(key.slice(FS_PREFIX.length));
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.read(path)) !== null;
  }
}

/**
 * Electron adapter — bridges to `window.motionEditor` IPC. Falls back to the
 * browser adapter for any method the preload does not (yet) expose, so the app
 * degrades gracefully while the native side is built out.
 */
export class ElectronFileAdapter implements FileAdapter {
  readonly kind = 'electron' as const;
  private readonly fallback = new BrowserFileAdapter();
  constructor(private readonly bridge: MotionEditorApi) {}

  async open(opts?: OpenOptions): Promise<StoredFile | null> {
    if (this.bridge.project?.open) return this.bridge.project.open();
    return this.fallback.open(opts);
  }
  async read(path: string): Promise<string | null> {
    if (this.bridge.file?.read) return this.bridge.file.read(path);
    return this.fallback.read(path);
  }
  async write(path: string, contents: string): Promise<void> {
    if (this.bridge.file?.write) return this.bridge.file.write(path, contents);
    return this.fallback.write(path, contents);
  }
  async chooseSavePath(defaultName: string): Promise<string | null> {
    if (this.bridge.project?.chooseSavePath) return this.bridge.project.chooseSavePath(defaultName);
    return this.fallback.chooseSavePath(defaultName);
  }
  async list(): Promise<string[]> { return this.fallback.list(); }
  async exists(path: string): Promise<boolean> { return this.fallback.exists(path); }
}

/** Pick the best adapter for the current environment (Electron when present). */
export function detectFileAdapter(): FileAdapter {
  const bridge = typeof window !== 'undefined' ? window.motionEditor : undefined;
  if (bridge && (bridge.file || bridge.project)) return new ElectronFileAdapter(bridge);
  return new BrowserFileAdapter();
}

export class FileManager {
  constructor(private adapter: FileAdapter = detectFileAdapter()) {}

  get environment(): FileAdapter['kind'] { return this.adapter.kind; }
  setAdapter(adapter: FileAdapter): void { this.adapter = adapter; }

  open(opts?: OpenOptions): Promise<StoredFile | null> { return this.adapter.open(opts); }
  read(path: string): Promise<string | null> { return this.adapter.read(path); }
  write(path: string, contents: string): Promise<void> { return this.adapter.write(path, contents); }
  chooseSavePath(defaultName: string): Promise<string | null> { return this.adapter.chooseSavePath(defaultName); }
  list(): Promise<string[]> { return this.adapter.list(); }
  exists(path: string): Promise<boolean> { return this.adapter.exists(path); }
}
