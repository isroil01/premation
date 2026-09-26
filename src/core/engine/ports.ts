/**
 * The local engine's view of the outside world: files on disk and media
 * decoding. Injected, so the engine runs headless (tests, CLI, replay) and the
 * app wires the real Electron-backed implementations in B3. A command that
 * needs a port that is not attached answers `unsupported`, never guesses.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { ImportedAsset } from '@stores/assetStore';
import type { ImportBytesFile, ImportFile, ProjectFormat } from '@motion/engine-api';

export interface EnginePorts {
  /** Read a project document from disk (.motion). */
  readProject?(path: string): Promise<EditorDocument>;
  /**
   * F2: open `path` as a portable `.motion` zip (Save Portable Copy's form).
   * Null when the file is not one — openProject then reads it with
   * `readProject`. A portable copy opens UNTITLED (the session is not bound to
   * the zip); `embedded` counts the footage files the port made reachable.
   */
  readPortable?(path: string): Promise<{ document: EditorDocument; embedded: number } | null>;
  /**
   * Write a project document (temp file + rename is the port's contract).
   * `format` is saveProject's (F2): absent / `auto` = the port's routing as
   * before; `json`, `bundle` and `portable` ask for that form.
   */
  writeProject?(path: string, doc: EditorDocument, format?: ProjectFormat): Promise<{ bytes: number }>;
  /** Import one file as a footage record with the given id (bytes stay wherever the port keeps them). */
  importFile?(file: ImportFile, id: string): Promise<ImportedAsset>;
  /** Import one file from BYTES (a browser File, a bundled sound, a generated image) as a footage record with the given id. */
  importBytes?(file: ImportBytesFile, id: string): Promise<ImportedAsset>;
  /** Re-probe a relinked file; returns the record's new metadata. */
  probeFile?(path: string): Promise<Partial<ImportedAsset>>;
  /** Collect files: copy the project + used media into `folder`. */
  collectFiles?(folder: string, doc: EditorDocument, onlyUsed: boolean): Promise<{ path: string; bytes: number }>;
}
