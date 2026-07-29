/**
 * BundleRepository — save/load a `.motion` directory bundle over a `BundleFs`.
 *
 * This is the incremental-save core: on save it encodes the document, diffs the
 * new manifest against the one already on disk, writes only the chunks that
 * changed, deletes the ones that went away, and writes `manifest.json` LAST.
 *
 * Manifest-last is the crash-safety guarantee: the manifest is the index, so it
 * must never reference a chunk that wasn't written. If the process dies after a
 * content chunk is written but before the manifest, the on-disk manifest still
 * points only at fully-written chunks — the worst case is a redundant rewrite on
 * the next save, never a corrupt or dangling reference.
 *
 * Pure orchestration: no engines, no globals. The environment supplies the
 * `BundleFs` (Electron real-fs, browser virtual-fs, or the in-memory test one).
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import { encodeBundle, decodeBundle, diffChunks, readManifest } from './bundleCodec';
import { hashString, type HashFn } from './hash';
import { CHUNK, CONTENT_CHUNKS, type BundleManifest } from './types';
import type { BundleFs } from './BundleFs';

export class BundleRepository {
  constructor(
    private readonly fs: BundleFs,
    private readonly hash: HashFn = hashString,
  ) {}

  /**
   * Persist `doc` to the bundle at `root`, rewriting only changed chunks.
   * Returns the manifest that is now on disk.
   */
  async save(root: string, doc: EditorDocument): Promise<BundleManifest> {
    const bundle = encodeBundle(doc, this.hash);
    const prev = await this.readManifest(root);
    const { changed, removed } = diffChunks(prev, bundle.manifest);

    // Content chunks first...
    for (const name of changed) {
      await this.fs.writeAtomic(root, name, bundle.files[name]!);
    }
    for (const name of removed) {
      await this.fs.remove(root, name);
    }
    //...manifest last (see file header — this is the crash-safety invariant).
    await this.fs.writeAtomic(root, CHUNK.manifest, bundle.files[CHUNK.manifest]!);

    return bundle.manifest;
  }

  /**
   * Read the bundle at `root` back into an `EditorDocument`, or null if there is
   * no bundle there (no manifest). Reads only the chunks the manifest lists;
   * decode tolerates any that are optional/absent.
   */
  async load(root: string): Promise<EditorDocument | null> {
    const manifestText = await this.fs.read(root, CHUNK.manifest);
    if (manifestText == null) return null;

    const files: Record<string, string> = { [CHUNK.manifest]: manifestText };
    const manifest = readManifest(files);
    for (const name of CONTENT_CHUNKS) {
      if (!manifest?.chunks[name]) continue;
      const text = await this.fs.read(root, name);
      if (text != null) files[name] = text;
    }
    return decodeBundle(files);
  }

  /** True when a bundle (a manifest) already exists at `root`. */
  async has(root: string): Promise<boolean> {
    return (await this.fs.read(root, CHUNK.manifest)) != null;
  }

  private async readManifest(root: string): Promise<BundleManifest | null> {
    const text = await this.fs.read(root, CHUNK.manifest);
    return text == null ? null : readManifest({ [CHUNK.manifest]: text });
  }
}
