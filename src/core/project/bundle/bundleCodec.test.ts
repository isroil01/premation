/**
 * The `.motion` bundle codec round-trip.
 *
 * Pure test — no engines, no filesystem. It locks down the chunk partition
 * (every authored field survives, in exactly one chunk), incremental-save diffs
 * (unchanged chunks are not rewritten), hash determinism, and legacy single-file
 * detection so the directory-bundle migration can never silently drop authored
 * state — the same failure class `projectDocumentIO.test.ts` guards for the
 * monolithic format.
 */

import {
  encodeBundle,
  decodeBundle,
  diffChunks,
  readManifest,
  isLegacySceneFile,
  parseLegacyDocument,
} from './bundleCodec';
import { hashString } from './hash';
import { CHUNK, BUNDLE_FORMAT_VERSION } from './types';
import type { EditorDocument } from '@core/api/cloudDocument';

function fullDoc(): EditorDocument {
  return {
    version: '1.1.0',
    scene: { version: '1.0.0', nodes: [{ id: 'box' }] } as unknown as EditorDocument['scene'],
    animation: { tracks: { 'box:x': [{ t: 0, value: 10 }] }, expressions: {} } as never,
    comps: {
      main: {
        id: 'main', name: 'Main', width: 1280, height: 720, fps: 48,
        durationSeconds: 7, background: '#123456', transparent: false, startFrame: 0,
      },
    } as never,
    timelines: { main: { version: 1, duration: 336 } } as never,
    motionBlur: { enabled: true } as never,
    guides: { horizontal: [10], vertical: [] } as never,
  };
}

describe('encode → decode round-trip', () => {
  it('preserves every authored field', () => {
    const doc = fullDoc();
    const restored = decodeBundle(encodeBundle(doc).files);
    expect(restored).toEqual(doc);
  });

  it('splits content into one chunk each, plus a manifest', () => {
    const { files } = encodeBundle(fullDoc());
    expect(Object.keys(files).sort()).toEqual(
      [CHUNK.manifest, CHUNK.scene, CHUNK.animation, CHUNK.timeline, CHUNK.meta].sort(),
    );
  });

  it('records the format version and a hash for every content chunk', () => {
    const { files } = encodeBundle(fullDoc());
    const manifest = readManifest(files)!;
    expect(manifest.bundleFormat).toBe(BUNDLE_FORMAT_VERSION);
    expect(manifest.documentVersion).toBe('1.1.0');
    expect(manifest.chunks[CHUNK.scene]).toBe(hashString(files[CHUNK.scene]!));
    expect(manifest.chunks[CHUNK.animation]).toBe(hashString(files[CHUNK.animation]!));
  });
});

describe('optional chunk omission', () => {
  it('omits timeline.json and meta.json when there is nothing to store', () => {
    const bare: EditorDocument = {
      version: '1.1.0',
      scene: { version: '1.0.0', nodes: [] } as never,
      animation: { tracks: {}, expressions: {} } as never,
    };
    const { files, manifest } = encodeBundle(bare);
    expect(files[CHUNK.timeline]).toBeUndefined();
    expect(files[CHUNK.meta]).toBeUndefined();
    expect(manifest.chunks[CHUNK.timeline]).toBeUndefined();
    // scene + animation are always written.
    expect(files[CHUNK.scene]).toBeDefined();
    expect(files[CHUNK.animation]).toBeDefined();
  });

  it('still decodes a bundle that only has scene + animation', () => {
    const bare: EditorDocument = {
      version: '1.1.0',
      scene: { version: '1.0.0', nodes: [] } as never,
      animation: { tracks: {}, expressions: {} } as never,
    };
    const restored = decodeBundle(encodeBundle(bare).files);
    expect(restored.timelines).toBeUndefined();
    expect(restored.comps).toBeUndefined();
    expect(restored.scene).toBeDefined();
  });
});

describe('incremental save (diffChunks)', () => {
  it('a first save writes every present chunk', () => {
    const next = encodeBundle(fullDoc()).manifest;
    const { changed, removed } = diffChunks(null, next);
    expect(changed.sort()).toEqual([CHUNK.scene, CHUNK.animation, CHUNK.timeline, CHUNK.meta].sort());
    expect(removed).toEqual([]);
  });

  it('rewrites only the chunk that changed', () => {
    const prev = encodeBundle(fullDoc()).manifest;
    const edited = fullDoc();
    (edited.animation as never as { tracks: Record<string, unknown> }).tracks = {
      'box:x': [{ t: 0, value: 10 }, { t: 2, value: 500 }],
    };
    const next = encodeBundle(edited).manifest;
    const { changed, removed } = diffChunks(prev, next);
    expect(changed).toEqual([CHUNK.animation]);
    expect(removed).toEqual([]);
  });

  it('reports a chunk as removed when its content goes away', () => {
    const prev = encodeBundle(fullDoc()).manifest;
    const stripped = fullDoc();
    delete stripped.timelines;
    delete stripped.motionBlur;
    delete stripped.guides;
    const next = encodeBundle(stripped).manifest;
    const { changed, removed } = diffChunks(prev, next);
    expect(removed).toEqual([CHUNK.timeline]);
    expect(changed).toEqual([]);
  });
});

describe('hash determinism', () => {
  it('encodes byte-identically for identical input', () => {
    expect(encodeBundle(fullDoc()).files).toEqual(encodeBundle(fullDoc()).files);
  });

  it('hashString is stable and differs on change', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('forward compatibility', () => {
  it('ignores unknown chunks a newer build added, without losing known ones', () => {
    const { files } = encodeBundle(fullDoc());
    files['ai/memory.json'] = JSON.stringify({ brand: 'future' });
    const restored = decodeBundle(files);
    expect(restored.scene).toBeDefined();
    expect(restored.comps).toBeDefined();
  });
});

describe('legacy single-file detection', () => {
  it('recognizes a scene-only ProjectFile', () => {
    expect(isLegacySceneFile({ version: '1.0.0', nodes: [] })).toBe(true);
    expect(isLegacySceneFile({ version: '1.1.0', scene: {}, animation: {} })).toBe(false);
  });

  it('coerces a scene-only file into a full document', () => {
    const doc = parseLegacyDocument(JSON.stringify({ version: '1.0.0', nodes: [{ id: 'a' }] }));
    expect(doc?.scene).toBeDefined();
    expect(doc?.animation).toEqual({ tracks: {}, expressions: {} });
  });

  it('passes a monolithic EditorDocument through', () => {
    const mono = JSON.stringify(fullDoc());
    const doc = parseLegacyDocument(mono);
    expect(doc?.comps).toBeDefined();
    expect(doc?.animation).toBeDefined();
  });

  it('rejects text that is not a project', () => {
    expect(parseLegacyDocument('not json')).toBeNull();
    expect(parseLegacyDocument(JSON.stringify({ foo: 1 }))).toBeNull();
  });
});
