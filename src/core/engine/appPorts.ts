/**
 * The app's EnginePorts — the local engine's file, media and collect-files
 * access, wired to the same code paths the editor already uses (ENGINE_API.md
 * §15.3 "Attach real EnginePorts"):
 *
 *   readProject / writeProject → ProjectManager's storage (bundle or single
 *       file; the storage owns temp-file + rename and footage collection)
 *   importFile                 → the desktop preload bridge (`file.readBytes`)
 *       + the asset store's importer (`importMediaFile` → `addAsset`), so a
 *       file imported through the API is ingested, content-addressed and
 *       thumbnailed exactly like a drag-and-drop import
 *   probeFile                  → the preload bridge + `probeMedia` (ffprobe)
 *   collectFiles               → a `.motion` bundle written into the folder
 *       (bundle saves collect every used footage file into the bundle)
 *
 * No port throws for "not available here" silently: in a browser build the
 * desktop bridge is absent and the port throws, which the engine turns into a
 * typed `io` error on the command.
 */

import type { EnginePorts } from './ports';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { ProjectFile, VersionedDocument } from '@core/types';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { canImportFromDisk, fileNameOf, importMediaFile, mimeForPath } from '@core/assets/local/importFromDisk';
import { probeMedia } from '@core/assets/mediaProbe';

/** The slice of ProjectManager the file ports need (a fake in tests). */
export interface ProjectFileAccess {
  readDocument(path: string): Promise<VersionedDocument | null>;
  writeDocument(path: string, doc: VersionedDocument): Promise<void>;
}

/** A pre-1.1 `.motion` is a bare scene file; lift it into an EditorDocument. */
function asEditorDocument(doc: VersionedDocument): EditorDocument {
  if (Array.isArray((doc as unknown as ProjectFile).nodes)) {
    return {
      version: '1.1.0',
      scene: doc as unknown as ProjectFile,
      animation: { tracks: {}, expressions: {} },
    } as EditorDocument;
  }
  return doc as EditorDocument;
}

async function readBytes(path: string): Promise<Uint8Array> {
  const read = typeof window !== 'undefined' ? window.motionEditor?.file?.readBytes : undefined;
  if (!read) throw new Error('reading files by path needs the desktop app');
  const bytes = await read(path);
  if (!bytes || bytes.byteLength === 0) throw new Error('file is missing or empty');
  return bytes;
}

/**
 * Remove an asset record from the SESSION list without releasing its bytes.
 *
 * `importMediaFile` both stores the bytes (bundle / IndexedDB / object URL) and
 * appends the record to the session list. The engine's `importFiles` handler
 * adds the record itself, inside its captured scope — that is what makes the
 * import undoable — so the port hands the record back and takes it out of the
 * list again. The bytes stay where the importer put them (an undone import
 * leaves them in the device library, which is what New Project does too).
 */
function detachFromSession(id: string): void {
  useAssetStore.setState((s) => ({ assets: s.assets.filter((a) => a.id !== id) }));
}

export function createAppEnginePorts(project: ProjectFileAccess): EnginePorts {
  return {
    readProject: async (path) => {
      const doc = await project.readDocument(path);
      if (!doc) throw new Error('no project at that path');
      return asEditorDocument(doc);
    },

    writeProject: async (path, doc) => {
      await project.writeDocument(path, doc);
      // The storage does not report a size; the serialised document is the
      // honest lower bound (a bundle's footage is collected beside it).
      return { bytes: JSON.stringify(doc).length };
    },

    importFile: async (file, id): Promise<ImportedAsset> => {
      if (!canImportFromDisk()) throw new Error('importing files by path needs the desktop app');
      const asset = await importMediaFile(file.path, { id });
      if (!asset) throw new Error('the file could not be read or decoded');
      detachFromSession(asset.id);
      return { ...asset, id, path: file.path };
    },

    importBytes: async (file, id): Promise<ImportedAsset> => {
      // The same importer as a picked file (ingest, content addressing,
      // thumbnails, auto-proxy); the engine adds the record itself.
      // No copy: in-process the bytes are the caller's own read of the File
      // (a video can be gigabytes); a detached/shared buffer would be copied.
      const bytes = file.data.buffer instanceof ArrayBuffer ? file.data as Uint8Array<ArrayBuffer> : file.data.slice();
      const blob = new File([bytes], file.name, file.mimeType ? { type: file.mimeType } : undefined);
      const asset = await useAssetStore.getState().addAsset(blob, null, {
        id,
        ...(file.originPath ? { path: file.originPath } : {}),
      });
      if (!asset) throw new Error('the file could not be read or decoded');
      detachFromSession(asset.id);
      return { ...asset, id };
    },

    probeFile: async (path) => {
      const bytes = await readBytes(path);
      const name = fileNameOf(path);
      const facts = await probeMedia(new File([bytes.slice()], name, { type: mimeForPath(path) }));
      const out: Partial<ImportedAsset> = { name, size: bytes.byteLength };
      if (facts.tier !== 'probed') return out;
      out.metadata = {
        ...(facts.width ? { width: facts.width } : {}),
        ...(facts.height ? { height: facts.height } : {}),
        ...(facts.durationSec ? { duration: facts.durationSec } : {}),
        ...(facts.fps ? { fps: facts.fps } : {}),
        ...(facts.audio !== undefined ? { hasAudioTrack: facts.audio !== null } : {}),
        ...(facts.hasAlpha ? { hasAlpha: true } : {}),
      };
      return out;
    },

    collectFiles: async (folder, doc) => {
      const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
      const base = folder.replace(/[\\/]+$/, '');
      const leaf = fileNameOf(base) || 'Project';
      const path = `${base}${sep}${leaf}.motion`;
      await project.writeDocument(path, doc);
      return { path, bytes: JSON.stringify(doc).length };
    },
  };
}
