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
  readonly kind: 'browser' | 'electron' | 'api';
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
  private handles = new Map<string, any>();

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
        this.handles.set(file.name, handle);
        return { path: file.name, name: file.name, contents };
      } catch {
        return null; // user cancelled / unsupported
      }
    }
    return null;
  }

  async read(path: string): Promise<string | null> {
    const handle = this.handles.get(path);
    if (handle && typeof handle.getFile === 'function') {
      try {
        const file = await handle.getFile();
        return await file.text();
      } catch (err) {
        console.error('Failed to read from file handle:', err);
      }
    }
    try {
      return localStorage.getItem(FS_PREFIX + path);
    } catch {
      return null;
    }
  }

  async write(path: string, contents: string): Promise<void> {
    const handle = this.handles.get(path);
    if (handle && typeof handle.createWritable === 'function') {
      try {
        const writable = await handle.createWritable();
        await writable.write(contents);
        await writable.close();
        return;
      } catch (err) {
        console.error('Failed to write to file handle:', err);
      }
    }
    try {
      localStorage.setItem(FS_PREFIX + path, contents);
      if (typeof document !== 'undefined') {
        const blob = new Blob([contents], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = path;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      /* ignore quota */
    }
  }

  async chooseSavePath(defaultName: string): Promise<string | null> {
    const picker = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    if (typeof picker === 'function') {
      try {
        const handle = await (picker as (o?: unknown) => Promise<any>)({
          suggestedName: defaultName,
          types: [{ description: 'Project', accept: { 'application/json': ['.motion', '.json'] } }],
        });
        if (!handle) return null;
        this.handles.set(handle.name, handle);
        return handle.name;
      } catch {
        return null; // user cancelled / unsupported
      }
    }
    /**
     * No picker (Firefox, Safari, any non-secure context) — say so.
     *
     * This used to return `defaultName`, i.e. a destination the user never
     * chose. `Save As` then reported success for a write into the localStorage
     * virtual FS, with no dialog of any kind: the reported symptom was "File ▸
     * Save As does nothing". Refusing here makes the caller fall back to
     * `Save to Computer`, which always has a real destination (picker, Electron
     * dialog, or download).
     */
    return null;
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
