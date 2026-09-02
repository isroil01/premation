/**
 * bundleCodec — turn a live `EditorDocument` into a chunked `.motion` bundle and
 * back, with per-chunk content hashes and legacy-format detection.
 *
 * This is pure and synchronous: no filesystem, no engines, no network. The file
 * adapter is responsible for writing/reading the actual directory; this module
 * only decides WHAT the files are and hashes them.
 *
 * ── Chunk partition (strict, no overlap — so decode is unambiguous) ──────────
 *   scene.json      ← doc.scene            (the scene graph)
 *   animation.json  ← doc.animation        (keyframe tracks + expressions)
 *   timeline.json   ← { timelines, motionBlur, guides }   (time domain + render-affecting)
 *   meta.json       ← { comps, comp, swatches }  (composition settings registry — comp = legacy single — and the project palette)
 *   manifest.json   ← BundleManifest       (version + chunk hashes; the index)
 *
 * Every `EditorDocument` field lands in exactly one chunk. `version` is lifted
 * to `manifest.documentVersion`. Optional chunks are omitted when they carry no
 * content, and decode tolerates their absence.
 *
 * Adding authored state later (e.g. an `ai/` chunk) means: add a chunk name in
 * `types.ts`, write it in `encodeBundle`, read it in `decodeBundle`, and extend
 * the round-trip test — mirroring the discipline in `cloudDocument.ts`.
 */

import type { ProjectFile } from '@core/types';
import type { EditorDocument } from '@core/api/cloudDocument';
import { hashString, type HashFn } from './hash';
import {
  BUNDLE_FORMAT_VERSION,
  CHUNK,
  CONTENT_CHUNKS,
  type BundleManifest,
  type ChunkName,
  type MotionBundle,
} from './types';

/** Contents of `timeline.json`. */
interface TimelineChunk {
  timelines?: EditorDocument['timelines'];
  motionBlur?: EditorDocument['motionBlur'];
  guides?: EditorDocument['guides'];
  colorManagement?: EditorDocument['colorManagement'];
}

/** Contents of `meta.json`. */
interface MetaChunk {
  comps?: EditorDocument['comps'];
  comp?: EditorDocument['comp'];
  /** The project palette. Document metadata, not time domain — so `meta`, not
   *  `timeline`: nothing about a swatch changes when the playhead moves, and
   *  parking it in `timeline` would rewrite that chunk on every rename. */
  swatches?: EditorDocument['swatches'];
}

/** Stable JSON serialization used for every chunk (and thus for its hash). */
function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/** True when nothing in the object is defined — the chunk should be omitted. */
function isEmptyChunk(obj: object): boolean {
  return Object.values(obj).every((v) => v === undefined);
}

/**
 * Encode a full document into an in-memory bundle: one serialized file per
 * non-empty chunk, plus a manifest hashing each. `hash` is injectable so a
 * caller can swap in a stronger algorithm; it defaults to the bundle's
 * synchronous FNV-1a fingerprint.
 */
export function encodeBundle(doc: EditorDocument, hash: HashFn = hashString): MotionBundle {
  const chunkText: Partial<Record<ChunkName, string>> = {};

  // scene + animation are always written (a document always has both, even if
  // animation is empty) so a reader never has to guess their absence.
  chunkText[CHUNK.scene] = serialize(doc.scene ?? { version: '1.0.0', nodes: [] });
  chunkText[CHUNK.animation] = serialize(doc.animation ?? { tracks: {}, expressions: {} });

  const timeline: TimelineChunk = {
    timelines: doc.timelines,
    motionBlur: doc.motionBlur,
    guides: doc.guides,
    colorManagement: doc.colorManagement,
  };
  if (!isEmptyChunk(timeline)) chunkText[CHUNK.timeline] = serialize(timeline);

  const meta: MetaChunk = { comps: doc.comps, comp: doc.comp, swatches: doc.swatches };
  if (!isEmptyChunk(meta)) chunkText[CHUNK.meta] = serialize(meta);

  const chunks: Partial<Record<ChunkName, string>> = {};
  const files: Record<string, string> = {};
  for (const name of CONTENT_CHUNKS) {
    const text = chunkText[name];
    if (text === undefined) continue;
    chunks[name] = hash(text);
    files[name] = text;
  }

  const manifest: BundleManifest = {
    bundleFormat: BUNDLE_FORMAT_VERSION,
    documentVersion: doc.version ?? '1.1.0',
    chunks,
  };
  files[CHUNK.manifest] = serialize(manifest);

  return { manifest, files };
}

/**
 * Reassemble an `EditorDocument` from a bundle's files. Tolerant of missing
 * optional chunks and of a bundle written by a newer build that added chunks we
 * don't read yet (they're ignored, not lost — they remain on disk).
 */
export function decodeBundle(files: Record<string, string>): EditorDocument {
  const manifest = readManifest(files);

  const scene = parseChunk<ProjectFile>(files[CHUNK.scene]) ?? { version: '1.0.0', nodes: [] };
  const animation =
    parseChunk<EditorDocument['animation']>(files[CHUNK.animation]) ?? { tracks: {}, expressions: {} };
  const timeline = parseChunk<TimelineChunk>(files[CHUNK.timeline]) ?? {};
  const meta = parseChunk<MetaChunk>(files[CHUNK.meta]) ?? {};

  const doc: EditorDocument = {
    version: manifest?.documentVersion ?? '1.1.0',
    scene,
    animation,
  };
  if (timeline.timelines) doc.timelines = timeline.timelines;
  if (timeline.motionBlur) doc.motionBlur = timeline.motionBlur;
  if (timeline.guides) doc.guides = timeline.guides;
  if (timeline.colorManagement) doc.colorManagement = timeline.colorManagement;
  if (meta.comps) doc.comps = meta.comps;
  if (meta.comp) doc.comp = meta.comp;
  // Present-but-empty is meaningful here ("this project has no swatches"), so
  // the test is on the key rather than on truthiness — `[]` must survive the
  // round trip or opening a bundle would restore the previous palette.
  if (meta.swatches) doc.swatches = meta.swatches;
  return doc;
}

/** Parse `manifest.json` from a bundle's files, or null if absent/invalid. */
export function readManifest(files: Record<string, string>): BundleManifest | null {
  return parseChunk<BundleManifest>(files[CHUNK.manifest]);
}

/**
 * Which chunks a save must rewrite (`changed`) and which to delete (`removed`),
 * given the previously-written manifest. A first save (`prev == null`) writes
 * every present chunk. This is the incremental-save / incremental-sync core.
 */
export function diffChunks(
  prev: BundleManifest | null,
  next: BundleManifest,
): { changed: ChunkName[]; removed: ChunkName[] } {
  const changed: ChunkName[] = [];
  const removed: ChunkName[] = [];
  for (const name of CONTENT_CHUNKS) {
    const nextHash = next.chunks[name];
    const prevHash = prev?.chunks[name];
    if (nextHash !== undefined && nextHash !== prevHash) changed.push(name);
    if (nextHash === undefined && prevHash !== undefined) removed.push(name);
  }
  return { changed, removed };
}

/** True when a parsed payload is a legacy scene-only `ProjectFile`. */
export function isLegacySceneFile(parsed: unknown): parsed is ProjectFile {
  return !!parsed && Array.isArray((parsed as ProjectFile).nodes);
}

/**
 * Coerce a legacy single-file `.motion` (a monolithic `EditorDocument` JSON, or
 * an even older scene-only `ProjectFile`) into an `EditorDocument`, so the next
 * save can explode it into a chunked bundle via `encodeBundle`. Returns null if
 * the text is not a recognizable project.
 */
export function parseLegacyDocument(contents: string): EditorDocument | null {
  const parsed = safeParse<unknown>(contents);
  if (!parsed || typeof parsed !== 'object') return null;

  if (isLegacySceneFile(parsed)) {
    return { version: '1.1.0', scene: parsed, animation: { tracks: {}, expressions: {} } };
  }
  // A monolithic EditorDocument has a `scene` object with a `nodes` array.
  const doc = parsed as EditorDocument;
  if (doc.scene && Array.isArray((doc.scene as ProjectFile).nodes)) return doc;
  return null;
}

function parseChunk<T>(text: string | undefined): T | null {
  if (text === undefined) return null;
  return safeParse<T>(text);
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
