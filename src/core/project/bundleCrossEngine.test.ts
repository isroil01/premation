/**
 * F2 bundles — `.motion` saves and opens written by the ENGINE, in the page's
 * format (docs/NATIVE_CORE_PLAN.md §5 Phase F2, inventory row "ProjectManager +
 * projectDocumentIO + bundleProjectIO / localProjectIO").
 *
 * The "old path" is the page's own code, unchanged: `BundleRepository` over a
 * real-disk `BundleFs` (what Electron main's `bundle:*` IPC does), the codec's
 * hash, and portableMotion.ts's `unpackPortableMotion`. The "new path" is
 * `saveProject{format}` / `openProject` answered by an engine:
 *   - the TypeScript engine (its app ports: RoutedProjectStorage →
 *     BundleProjectStorage / FileProjectStorage, portable → packPortableMotion), and
 *   - the C++ engine process through `ProcessEngineClient` + the real
 *     `premation-engine[-headless]` (core/bundle_io.cpp; skipped, saying so,
 *     when it is not built — PREMATION_ENGINE_PATH picks the headless build).
 *
 * Both directions on both engines: a bundle the old path wrote opens in the
 * engine; what the engine writes opens through the old path (same document,
 * manifest hashes valid for the chunk text on disk, nothing half-written).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, unwrap, type EngineClient } from '@motion/engine-api';
import { setupEngine, type Harness } from '@core/engine/__testHelpers__/harness';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { createAppEnginePorts } from '@core/engine/appPorts';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { FileManager } from '@core/files/FileManager';
import { ProjectService } from '@core/persistence/ProjectService';
import { BundleProjectStorage, FileProjectStorage, RoutedProjectStorage } from '@core/persistence/ProjectStorage';
import type { RecentProjects } from '@core/project/RecentProjects';
import { ProjectManager } from './ProjectManager';
import { BundleRepository } from './bundle/BundleRepository';
import type { BundleFs } from './bundle/BundleFs';
import { decodeBundle, encodeBundle } from './bundle/bundleCodec';
import { hashString } from './bundle/hash';
import { CHUNK, CONTENT_CHUNKS, type BundleManifest } from './bundle/types';
import { packPortableMotion, unpackPortableMotion } from './portableMotion';
import preItemsBundle from './__fixtures__/pre-items-bundle-1.8.0.json';

jest.setTimeout(60_000);

/** Temp + rename, like electron/atomicWrite.ts. */
function writeAtomic(target: string, contents: string | Uint8Array): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-test`;
  writeFileSync(tmp, contents);
  renameSync(tmp, target);
}

/** The page's BundleFs over the real disk — what main's `bundle:*` handlers do. */
const diskBundleFs: BundleFs = {
  read: async (root, name) => {
    try {
      return readFileSync(path.join(root, name), 'utf8');
    } catch {
      return null;
    }
  },
  writeAtomic: async (root, name, contents) => writeAtomic(path.join(root, name), contents),
  remove: async (root, name) => {
    if (existsSync(path.join(root, name))) unlinkSync(path.join(root, name));
  },
  list: async (root) => {
    try {
      return readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  },
  exists: async (root) => existsSync(root) && readdirSync(root).length > 0,
};

const repo = new BundleRepository(diskBundleFs);

const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const BLOB = 'VIDEO-BYTES';

/** The old path's bundle: a 1.8.0 project whose video layer names its footage by hash, with the blob and registry row. */
async function writeOldBundle(root: string): Promise<EditorDocument> {
  const files = preItemsBundle as Record<string, string>;
  const doc = decodeBundle({ ...files, 'scene.json': files['scene.json']!.replace('blob:http://localhost/dead', `motion-blob:${HASH}`) });
  await repo.save(root, doc);
  writeAtomic(path.join(root, 'blobs', HASH.slice(0, 2), HASH), BLOB);
  writeAtomic(
    path.join(root, 'assets', 'registry.json'),
    JSON.stringify({ version: '1.0.0', assets: [{ id: 'asset_plate', hash: HASH, name: 'plate.mp4', type: 'video', mime: 'video/mp4', size: BLOB.length }] }),
  );
  return doc;
}

function allFiles(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

interface Backend {
  client: EngineClient;
  /** Does this engine copy footage into a new bundle on Save As? (the C++ one does; the page's storage never did) */
  collectsFromSource: boolean;
  /** Does Save Portable Copy embed `motion-blob:` footage? (the C++ one does; the page's embeds only `blob:` URLs) */
  embedsBundleFootage: boolean;
  stop(): Promise<void>;
}

async function tsBackend(): Promise<Backend> {
  const service = new ProjectService();
  const files = {
    read: async (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    write: async (p: string, contents: string) => writeAtomic(p, contents),
  } as unknown as FileManager;
  const storage = new RoutedProjectStorage(new FileProjectStorage(service, files), new BundleProjectStorage(repo), () => true);
  const pm = new ProjectManager({ service, files, recent: { add: () => {} } as unknown as RecentProjects, storage });
  const h: Harness = await setupEngine({ ports: createAppEnginePorts(
      pm,
      async (p, bytes) => writeAtomic(p, bytes),
      async (p) => (existsSync(p) && statSync(p).isFile() ? new Uint8Array(readFileSync(p)) : null),
    ) });
  return { client: h.engine, collectsFromSource: false, embedsBundleFootage: false, stop: () => h.dispose() };
}

async function processBackend(): Promise<Backend> {
  const native: NativeEngine = await startNativeEngine();
  const client = new ProcessEngineClient(native.bridge);
  await client.whenReady();
  return {
    client,
    collectsFromSource: true,
    embedsBundleFootage: true,
    stop: async () => {
      await client.close();
      await native.stop();
    },
  };
}

async function exported(c: EngineClient): Promise<EditorDocument> {
  const r = unwrap(await c.query({ type: 'exportDocument' }));
  return JSON.parse(new TextDecoder().decode(r.document)) as EditorDocument;
}

/** What the old path makes of a document: its own encode → decode. */
const viaCodec = (d: EditorDocument): EditorDocument => decodeBundle(encodeBundle(d).files);

function videoProps(d: EditorDocument): Record<string, unknown> | undefined {
  const node = d.scene.nodes.find((n) => n.id === 'n1');
  return node?.components.find((c) => c.type === 'video')?.props as Record<string, unknown> | undefined;
}

const backends: Array<[string, () => Promise<Backend>]> = [['TypeScript engine', tsBackend]];
if (nativeEngineExe()) backends.push(['C++ engine process', processBackend]);
else console.log('[F2 bundles] premation-engine is not built — the C++ engine process backend is skipped (PREMATION_ENGINE_PATH=<premation-engine-headless>)');

describe.each(backends)('F2 bundles: .motion written and read by the engine, in the page format — %s', (_name, make) => {
  let dir: string;
  let b: Backend;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'premation-f2-bundles-'));
    b = await make();
  });
  afterEach(async () => {
    await b.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('old bundle → engine open → engine Save As bundle → old path reads the same document; Save rewrites only what changed', async () => {
    const oldRoot = path.join(dir, 'Old.motion');
    await writeOldBundle(oldRoot);

    unwrap(await b.client.execute({ type: 'openProject', path: oldRoot }));
    const opened = await exported(b.client);
    // The engine kept the footage reference and the migrated document.
    expect(videoProps(opened)?.src).toBe(`motion-blob:${HASH}`);
    expect(videoProps(opened)?.assetId).toBe('asset_plate');
    expect(opened.comps?.comp_root?.name).toBe('Old Comp');

    const newRoot = path.join(dir, 'New.motion');
    const saved = unwrap(await b.client.execute({ type: 'saveProject', path: newRoot, copy: false, format: 'bundle' }));
    expect(saved.path).toBe(newRoot);
    expect(statSync(newRoot).isDirectory()).toBe(true);

    // The old path opens it: the same document the engine holds.
    const back = await repo.load(newRoot);
    expect(back).not.toBeNull();
    expect(back).toEqual(viaCodec(await exported(b.client)));
    // The manifest indexes exactly the chunks on disk, by the codec's hash.
    const manifest = JSON.parse(readFileSync(path.join(newRoot, CHUNK.manifest), 'utf8')) as BundleManifest;
    expect(manifest.bundleFormat).toBe('2.0.0');
    for (const name of CONTENT_CHUNKS) {
      const onDisk = existsSync(path.join(newRoot, name));
      expect([name, onDisk]).toEqual([name, manifest.chunks[name] !== undefined]);
      if (onDisk) expect(manifest.chunks[name]).toBe(hashString(readFileSync(path.join(newRoot, name), 'utf8')));
    }
    // Nothing half-written is left behind.
    expect(allFiles(newRoot).filter((f) => /tmp/.test(path.basename(f)))).toEqual([]);

    if (b.collectsFromSource) {
      // Save As carried the footage and its registry row into the new bundle.
      expect(readFileSync(path.join(newRoot, 'blobs', HASH.slice(0, 2), HASH), 'utf8')).toBe(BLOB);
      const reg = JSON.parse(readFileSync(path.join(newRoot, 'assets', 'registry.json'), 'utf8')) as { assets: Array<{ id: string; hash: string }> };
      expect(reg.assets.map((a) => [a.id, a.hash])).toEqual([['asset_plate', HASH]]);
    }

    // An edit, then Save (bound to the new bundle): the renamed layer's chunks are
    // rewritten (the TypeScript timeline names its bars after layers, so
    // timeline.json may move too); animation and composition chunks are not.
    const before = { ...manifest.chunks };
    unwrap(await b.client.execute({ type: 'renameLayer', layer: 'n1', name: 'Plate' }));
    unwrap(await b.client.execute({ type: 'saveProject', copy: false, format: 'bundle' }));
    const after = (JSON.parse(readFileSync(path.join(newRoot, CHUNK.manifest), 'utf8')) as BundleManifest).chunks;
    expect(after[CHUNK.scene]).not.toBe(before[CHUNK.scene]);
    expect([after[CHUNK.animation], after[CHUNK.meta]]).toEqual([before[CHUNK.animation], before[CHUNK.meta]]);
    expect((await repo.load(newRoot))).toEqual(viaCodec(await exported(b.client)));

    // And the engine reopens what it wrote.
    unwrap(await b.client.execute({ type: 'newProject' }));
    unwrap(await b.client.execute({ type: 'openProject', path: newRoot }));
    expect(videoProps(await exported(b.client))?.src).toBe(`motion-blob:${HASH}`);
    expect((await exported(b.client)).scene.nodes.find((n) => n.id === 'n1')?.name).toBe('Plate');
  });

  it('Save Portable Copy → the old path unpacks the zip; the project keeps its own file', async () => {
    const oldRoot = path.join(dir, 'Old.motion');
    await writeOldBundle(oldRoot);
    unwrap(await b.client.execute({ type: 'openProject', path: oldRoot }));
    const zip = path.join(dir, 'Copy.motion');
    const r = unwrap(await b.client.execute({ type: 'saveProject', path: zip, copy: true, format: 'portable' }));
    expect(r.bytes).toBe(statSync(zip).size);

    const unpacked = unpackPortableMotion(new Uint8Array(readFileSync(zip)));
    expect(unpacked.document.comps?.comp_root?.name).toBe('Old Comp');
    expect(Object.keys(unpacked.document.animation.tracks)).toEqual(Object.keys((await exported(b.client)).animation.tracks));
    if (b.embedsBundleFootage) {
      expect(videoProps(unpacked.document)?.src).toBe('assets/n1.mp4');
      expect(unpacked.assets.map((a) => [a.fileName, new TextDecoder().decode(a.bytes)])).toEqual([['n1.mp4', BLOB]]);
    }
    // A copy: the engine's document is still bound to the bundle it opened.
    const snap = unwrap(await b.client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
    expect(snap.projectPath).toBe(oldRoot);
  });

  it('Open portable copy: the engine opens the zip itself — an untitled copy, footage reachable, Save As bundle carries it', async () => {
    // The old path's zip: packPortableMotion with the plate embedded under assets/.
    const oldRoot = path.join(dir, 'Old.motion');
    const doc = await writeOldBundle(oldRoot);
    const packedDoc = structuredClone(doc);
    const plate = packedDoc.scene.nodes.find((n) => n.id === 'n1')!.components.find((c) => c.type === 'video')!;
    (plate.props as Record<string, unknown>).src = 'assets/n1.mp4';
    const zip = path.join(dir, 'Portable.motion');
    writeAtomic(zip, packPortableMotion(packedDoc, [{ fileName: 'n1.mp4', mime: 'video/mp4', bytes: new TextEncoder().encode(BLOB), nodeIds: ['n1'] }]));
    // jsdom has no object URLs; the TypeScript engine's port mints one per packaged file.
    const g = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
    const restore = { create: g.createObjectURL, revoke: g.revokeObjectURL };
    g.createObjectURL = () => 'blob:test/plate';
    g.revokeObjectURL = () => {};
    try {
      const r = unwrap(await b.client.execute({ type: 'openProject', path: zip }));
      expect(r.warnings.some((w) => w.startsWith('portable:'))).toBe(true);
    } finally {
      g.createObjectURL = restore.create;
      g.revokeObjectURL = restore.revoke;
    }
    const opened = await exported(b.client);
    expect(opened.comps?.comp_root?.name).toBe('Old Comp');
    expect(videoProps(opened)?.assetId).toBe('asset_plate');
    const src = String(videoProps(opened)?.src);
    // C++: unpacked onto disk as bundle footage; TypeScript: a session object URL.
    expect(src).toMatch(b.collectsFromSource ? /^motion-blob:[0-9a-f]{64}$/ : /^blob:/);
    // A copy: untitled, not dirty; the zip is untouched.
    const snap = unwrap(await b.client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
    expect(snap.projectPath).toBe('');
    expect(snap.dirty).toBe(false);
    const zipBytes = readFileSync(zip);

    const saved = path.join(dir, 'Saved.motion');
    unwrap(await b.client.execute({ type: 'saveProject', path: saved, copy: false, format: 'bundle' }));
    expect(readFileSync(zip).equals(zipBytes)).toBe(true);
    if (b.collectsFromSource) {
      const hash = src.slice('motion-blob:'.length);
      expect(readFileSync(path.join(saved, 'blobs', hash.slice(0, 2), hash), 'utf8')).toBe(BLOB);
      const reg = JSON.parse(readFileSync(path.join(saved, 'assets', 'registry.json'), 'utf8')) as { assets: Array<{ id: string; hash: string; mime: string }> };
      expect(reg.assets.map((a) => [a.id, a.hash, a.mime])).toEqual([['asset_plate', hash, 'video/mp4']]);
    }
    expect(await repo.load(saved)).toEqual(viaCodec(await exported(b.client)));
  });

  it('refuses what would lose the user file: portable without copy, a bundle over a file, a JSON file over a bundle', async () => {
    const portable = await b.client.execute({ type: 'saveProject', path: path.join(dir, 'P.motion'), copy: false, format: 'portable' });
    expect(portable.ok ? 'ok' : portable.error.code).toBe('invalidArgument');
    expect(existsSync(path.join(dir, 'P.motion'))).toBe(false);

    const file = path.join(dir, 'File.motion');
    writeFileSync(file, '{"version":"1.1.0"}');
    const overFile = await b.client.execute({ type: 'saveProject', path: file, copy: true, format: 'bundle' });
    expect(overFile.ok ? 'ok' : overFile.error.code).toBe('io');
    expect(readFileSync(file, 'utf8')).toBe('{"version":"1.1.0"}');

    const bundle = path.join(dir, 'Bundle.motion');
    await writeOldBundle(bundle);
    const listing = allFiles(bundle).sort();
    const overDir = await b.client.execute({ type: 'saveProject', path: bundle, copy: true, format: 'json' });
    expect(overDir.ok ? 'ok' : overDir.error.code).toBe('io');
    expect(allFiles(bundle).sort()).toEqual(listing);
  });
});
