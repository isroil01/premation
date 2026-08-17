/**
 * Portable `.motion` package — a zip of the canonical bundle plus embedded
 * assets.
 *
 * The local-first edition already writes a `.motion` DIRECTORY bundle. This
 * module is the FILE form of the same document: `manifest.json` + chunks +
 * `assets/`, so "Save to Computer" works in a browser (download) and on
 * machines that cannot pick a folder. Absolute desktop paths are rewritten to
 * in-package `assets/…` names; anything we cannot embed is reported so Open
 * can offer a relink instead of a silent blank layer.
 */

import { unzipSync, strFromU8, strToU8 } from 'fflate';
import type { EditorDocument } from '@core/api/cloudDocument';
import { encodeBundle, decodeBundle, parseLegacyDocument, isLegacySceneFile } from './bundle/bundleCodec';
import { zipBytes, type ZipEntry } from '@core/export/zip';
import { migrateDocument, DocumentVersionError } from './migrations';
import { findMissingAssets, type MissingAssetRef } from './missingAssets';

const PK = [0x50, 0x4b]; // ZIP magic

export interface PortableAsset {
  fileName: string;
  mime: string;
  bytes: Uint8Array;
  /** Node ids whose `src` was rewritten to `assets/<fileName>`. */
  nodeIds: string[];
}

export interface PackResult {
  bytes: Uint8Array;
  embedded: number;
  skipped: MissingAssetRef[];
}

export interface UnpackResult {
  document: EditorDocument;
  assets: PortableAsset[];
  missing: MissingAssetRef[];
}

export class PortableMotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortableMotionError';
  }
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === PK[0] && bytes[1] === PK[1];
}

function extForMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('svg')) return 'svg';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime') || mime.includes('mov')) return 'mov';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'bin';
}

function rewriteSrc(doc: EditorDocument, nodeId: string, src: string): void {
  const node = doc.scene?.nodes?.find((n) => n.id === nodeId);
  if (!node) return;
  for (const c of node.components) {
    if ('src' in (c.props as Record<string, unknown>)) {
      (c.props as Record<string, unknown>).src = src;
    }
  }
}

function nodesWithSrc(doc: EditorDocument): Array<{ id: string; src: string }> {
  const out: Array<{ id: string; src: string }> = [];
  for (const node of doc.scene?.nodes ?? []) {
    for (const c of node.components) {
      const src = (c.props as Record<string, unknown>).src;
      if (typeof src === 'string' && src) out.push({ id: node.id, src });
    }
  }
  return out;
}

/**
 * Fetch a blob: URL's bytes. Returns null when the blob is already dead
 * (the usual case for a document reopened in a new tab).
 */
async function readBlob(src: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    return { bytes: buf, mime };
  } catch {
    return null;
  }
}

/**
 * Embed live `blob:` sources into `assets/` and rewrite those `src`s. HTTP
 * URLs stay as URLs. Local paths that cannot be read are left for relink.
 */
export async function embedLiveAssets(doc: EditorDocument): Promise<{
  document: EditorDocument;
  assets: PortableAsset[];
  skipped: MissingAssetRef[];
}> {
  const next = structuredClone(doc);
  const assets: PortableAsset[] = [];
  const skipped: MissingAssetRef[] = [];
  const usedNames = new Set<string>();

  for (const { id, src } of nodesWithSrc(next)) {
    if (!src.startsWith('blob:')) continue;
    const got = await readBlob(src);
    if (!got) {
      skipped.push({ nodeId: id, nodeName: id, src, reason: 'blob' });
      continue;
    }
    let fileName = `${id}.${extForMime(got.mime)}`;
    let n = 2;
    while (usedNames.has(fileName)) {
      fileName = `${id}-${n}.${extForMime(got.mime)}`;
      n += 1;
    }
    usedNames.add(fileName);
    assets.push({ fileName, mime: got.mime, bytes: got.bytes, nodeIds: [id] });
    rewriteSrc(next, id, `assets/${fileName}`);
  }

  skipped.push(...findMissingAssets(next).filter((m) => m.reason === 'local-path'));
  return { document: next, assets, skipped };
}

/** Pack a document (and optional embedded assets) into a `.motion` zip. */
export function packPortableMotion(doc: EditorDocument, assets: readonly PortableAsset[] = []): Uint8Array {
  const bundle = encodeBundle(doc);
  // Annotated as ZipEntry[] rather than inferred: inference from `strToU8`
  // alone narrows `data` to an ArrayBuffer-backed Uint8Array, which then
  // rejects the asset bytes pushed below — the array element type has to be
  // the one `zipBytes` actually consumes.
  const entries: ZipEntry[] = Object.entries(bundle.files).map(([name, text]) => ({
    name,
    data: strToU8(text),
  }));
  for (const a of assets) {
    entries.push({ name: `assets/${a.fileName}`, data: a.bytes });
  }
  if (assets.length) {
    entries.push({
      name: 'assets/registry.json',
      data: strToU8(
        JSON.stringify({
          version: '1.0.0',
          assets: assets.map((a) => ({
            fileName: a.fileName,
            mime: a.mime,
            size: a.bytes.length,
            nodeIds: a.nodeIds,
          })),
        }),
      ),
    });
  }
  return zipBytes(entries);
}

function filesFromZip(bytes: Uint8Array): Record<string, Uint8Array> {
  const unzipped = unzipSync(bytes);
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(unzipped)) {
    const trimmed = name.replace(/^(\.\/)+/, '').replace(/\\/g, '/');
    // Zip-slip: drop anything that would escape the package root.
    if (!trimmed || trimmed.startsWith('/') || trimmed.includes('..')) continue;
    out[trimmed] = data;
  }
  return out;
}

function textFiles(bin: Record<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(bin)) {
    if (name.startsWith('assets/') && name !== 'assets/registry.json') continue;
    out[name] = strFromU8(data);
  }
  return out;
}

function assetsFromZip(bin: Record<string, Uint8Array>): PortableAsset[] {
  const out: PortableAsset[] = [];
  for (const [name, data] of Object.entries(bin)) {
    if (!name.startsWith('assets/') || name === 'assets/registry.json') continue;
    const fileName = name.slice('assets/'.length);
    if (!fileName || fileName.includes('/')) continue;
    out.push({ fileName, mime: 'application/octet-stream', bytes: data, nodeIds: [] });
  }
  return out;
}

/**
 * Open a portable `.motion` (zip), a legacy JSON document, or a scene-only
 * file. Migrates when possible. Throws PortableMotionError / DocumentVersionError
 * when the bytes are not a project this build can honour.
 */
export function unpackPortableMotion(bytes: Uint8Array): UnpackResult {
  if (isZip(bytes)) {
    const bin = filesFromZip(bytes);
    const files = textFiles(bin);
    if (!files['manifest.json'] && !files['scene.json']) {
      // Maybe a wrapping folder: project.motion/manifest.json
      const prefix = Object.keys(files).find((k) => k.endsWith('manifest.json'));
      if (prefix) {
        const root = prefix.slice(0, prefix.length - 'manifest.json'.length);
        const shifted: Record<string, string> = {};
        for (const [k, v] of Object.entries(files)) {
          if (k.startsWith(root)) shifted[k.slice(root.length)] = v;
        }
        return finishUnpack(shifted, assetsFromZip(bin));
      }
      throw new PortableMotionError('That file is a zip, but not a Premation project.');
    }
    return finishUnpack(files, assetsFromZip(bin));
  }

  const text = strFromU8(bytes);
  const legacy = parseLegacyDocument(text);
  if (!legacy) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isLegacySceneFile(parsed)) {
        return finishUnpackDoc({
          version: '1.0.0',
          scene: parsed,
          animation: { tracks: {}, expressions: {} },
        });
      }
    } catch {
      /* fall through */
    }
    throw new PortableMotionError('Not a Premation .motion project.');
  }
  return finishUnpackDoc(legacy);
}

function finishUnpack(files: Record<string, string>, assets: PortableAsset[]): UnpackResult {
  const doc = decodeBundle(files);
  return finishUnpackDoc(doc, assets);
}

function finishUnpackDoc(doc: EditorDocument, assets: PortableAsset[] = []): UnpackResult {
  let migrated: EditorDocument;
  try {
    migrated = migrateDocument(doc);
  } catch (err) {
    if (err instanceof DocumentVersionError) throw err;
    throw new PortableMotionError(
      err instanceof Error ? err.message : 'Could not migrate that project.',
    );
  }
  return {
    document: migrated,
    assets,
    missing: findMissingAssets(migrated),
  };
}
