/**
 * VersionStore — local version history inside a `.motion` bundle.
 *
 * Instead of reverse JSON patches (a diff/patch engine to get right), versions
 * use the content-addressing the bundle already has: each version records the
 * chunk HASHES that were live at that moment, and the chunk contents live once
 * in `versions/objects/<hash>`. Identical chunks are shared across versions
 * (structural sharing, like a git tree), so an autosave that only touched
 * animation costs one new object. Restore = read the version's chunk objects and
 * decode. Pruning deletes only the objects a removed version alone referenced.
 *
 * Pure orchestration over `BundleFs` — fully unit-testable with MemoryBundleFs.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import { encodeBundle, decodeBundle } from './bundleCodec';
import { hashString, type HashFn } from './hash';
import { CONTENT_CHUNKS, type ChunkName } from './types';
import type { BundleFs } from './BundleFs';

export type VersionKind = 'autosave' | 'manual' | 'recovery';

export interface VersionEntry {
  rev: number;
  kind: VersionKind;
  label?: string;
  /** Playhead time when snapshotted (optional). */
  time?: number;
  /** epoch ms — supplied by the caller (keeps this module deterministic). */
  createdAt: number;
  /** Logical chunk name → content hash for this version. */
  chunks: Partial<Record<ChunkName, string>>;
}

export interface VersionMeta {
  kind: VersionKind;
  label?: string;
  time?: number;
  createdAt: number;
}

interface VersionIndexFile {
  version: string;
  entries: VersionEntry[];
}

const INDEX_PATH = 'versions/index.json';
const INDEX_VERSION = '1.0.0';
const objectPath = (hash: string): string => `versions/objects/${hash.slice(0, 2)}/${hash}`;

export class VersionStore {
  constructor(
    private readonly fs: BundleFs,
    private readonly root: string,
    private readonly hash: HashFn = hashString,
  ) {}

  /** Snapshot the document as a new version; returns the created entry. */
  async snapshot(doc: EditorDocument, meta: VersionMeta): Promise<VersionEntry> {
    const bundle = encodeBundle(doc, this.hash);

    // Store each chunk's content once, addressed by hash.
    for (const name of CONTENT_CHUNKS) {
      const h = bundle.manifest.chunks[name];
      if (!h) continue;
      if ((await this.fs.read(this.root, objectPath(h))) == null) {
        await this.fs.writeAtomic(this.root, objectPath(h), bundle.files[name]!);
      }
    }

    const index = await this.readIndex();
    const rev = (index.entries.at(-1)?.rev ?? 0) + 1;
    const entry: VersionEntry = {
      rev,
      kind: meta.kind,
      ...(meta.label != null ? { label: meta.label } : {}),
      ...(meta.time != null ? { time: meta.time } : {}),
      createdAt: meta.createdAt,
      chunks: bundle.manifest.chunks,
    };
    index.entries.push(entry);
    await this.fs.writeAtomic(this.root, INDEX_PATH, JSON.stringify(index));
    return entry;
  }

  /** Versions, newest first. */
  async list(): Promise<VersionEntry[]> {
    return [...(await this.readIndex()).entries].reverse();
  }

  /** Reconstruct the document stored at revision `rev`, or null if unknown. */
  async restore(rev: number): Promise<EditorDocument | null> {
    const entry = (await this.readIndex()).entries.find((e) => e.rev === rev);
    if (!entry) return null;

    const files: Record<string, string> = {};
    for (const [name, h] of Object.entries(entry.chunks)) {
      if (!h) continue;
      const text = await this.fs.read(this.root, objectPath(h));
      if (text != null) files[name] = text;
    }
    return decodeBundle(files);
  }

  /**
   * Keep at most `keep` of the given `kind` (newest), dropping older ones, then
   * delete any object no surviving version references. Returns removed hashes.
   * (Autosave history is capped this way; manual/recovery kinds are left alone
   * unless named.)
   */
  async prune(kind: VersionKind, keep: number): Promise<string[]> {
    const index = await this.readIndex();
    const before = this.liveHashes(index.entries);

    const ofKind = index.entries.filter((e) => e.kind === kind);
    const drop = new Set(ofKind.slice(0, Math.max(0, ofKind.length - keep)).map((e) => e.rev));
    index.entries = index.entries.filter((e) => !drop.has(e.rev));

    const after = this.liveHashes(index.entries);
    const orphans = [...before].filter((h) => !after.has(h));
    for (const h of orphans) await this.fs.remove(this.root, objectPath(h));

    await this.fs.writeAtomic(this.root, INDEX_PATH, JSON.stringify(index));
    return orphans;
  }

  private liveHashes(entries: VersionEntry[]): Set<string> {
    const set = new Set<string>();
    for (const e of entries) for (const h of Object.values(e.chunks)) if (h) set.add(h);
    return set;
  }

  private async readIndex(): Promise<VersionIndexFile> {
    const text = await this.fs.read(this.root, INDEX_PATH);
    if (text == null) return { version: INDEX_VERSION, entries: [] };
    try {
      const parsed = JSON.parse(text) as VersionIndexFile;
      return parsed?.entries ? parsed : { version: INDEX_VERSION, entries: [] };
    } catch {
      return { version: INDEX_VERSION, entries: [] };
    }
  }
}
