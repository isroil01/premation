/**
 * BundleFs — the tiny filesystem port a `.motion` directory bundle needs.
 *
 * A bundle is a directory of chunk files (`scene.json`, `animation.json`, …, and
 * `manifest.json`). `BundleRepository` orchestrates incremental saves over this
 * port; the port itself is deliberately minimal so every environment can supply
 * one:
 *   - Electron  → real fs via main-process IPC (atomic temp+rename, path-contained)
 *   - Browser   → the localStorage virtual filesystem (same store the file adapter uses)
 *   - Tests     → the in-memory implementation below
 *
 * `writeAtomic` must not leave a partially-written file visible: real
 * implementations write to a temp name and rename. `root` is the bundle
 * directory; `name` is a chunk file name relative to it (e.g. 'scene.json').
 */

export interface BundleFs {
  /** Read a chunk's contents, or null if it does not exist. */
  read(root: string, name: string): Promise<string | null>;
  /** Write a chunk atomically (temp + rename in real filesystems). */
  writeAtomic(root: string, name: string, contents: string): Promise<void>;
  /** Delete a chunk. A no-op if it is already absent. */
  remove(root: string, name: string): Promise<void>;
  /** List the chunk file names present under `root`. */
  list(root: string): Promise<string[]>;
  /** True when the bundle directory exists and holds at least one file. */
  exists(root: string): Promise<boolean>;
}

/**
 * In-memory `BundleFs` for tests. Models each bundle as a name→contents map and
 * records the order of mutating operations in `log`, so tests can assert that
 * the manifest is written last and that only changed chunks are touched.
 */
export class MemoryBundleFs implements BundleFs {
  private readonly roots = new Map<string, Map<string, string>>();
  /** Ordered write/remove trace, e.g. 'write:scene.json', 'remove:timeline.json'. */
  readonly log: string[] = [];

  private dir(root: string): Map<string, string> {
    let d = this.roots.get(root);
    if (!d) {
      d = new Map();
      this.roots.set(root, d);
    }
    return d;
  }

  async read(root: string, name: string): Promise<string | null> {
    return this.roots.get(root)?.get(name) ?? null;
  }

  async writeAtomic(root: string, name: string, contents: string): Promise<void> {
    this.dir(root).set(name, contents);
    this.log.push(`write:${name}`);
  }

  async remove(root: string, name: string): Promise<void> {
    this.roots.get(root)?.delete(name);
    this.log.push(`remove:${name}`);
  }

  async list(root: string): Promise<string[]> {
    return [...(this.roots.get(root)?.keys() ?? [])];
  }

  async exists(root: string): Promise<boolean> {
    return (this.roots.get(root)?.size ?? 0) > 0;
  }
}
