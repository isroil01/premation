/**
 * F2 — the live document, read from and handed to its OWNER
 * (docs/NATIVE_CORE_PLAN.md §5 Phase F2, inventory rows "CloudAutosave,
 * ApiFileAdapter.createProject, VersionHistoryPanel, publishTemplate,
 * exportMogrt, exportManager" and "compositeEdit, documentSwap, headlessRender").
 *
 * Those callers used to `captureDocument()` the TypeScript stores in the page.
 * With the engine as owner (`engineOwnsDocumentNow()`, the F2 flag) the page
 * holds only a replica, so the document comes from the engine instead:
 *
 *   liveDocument()             the `exportDocument` query — the bytes the engine
 *                              would save, parsed once here
 *   replaceLiveDocument(d, l)  `restoreDocument{document, label}` — ONE undoable
 *                              entry in the engine's history
 *   saveLiveDocument(p, opts)  `saveProject{path, copy, format}` — the engine
 *                              writes (temp + rename)
 *
 * Flag off (the TypeScript engine owns the document — this release's default)
 * every function is exactly the old page path: `captureDocument()` /
 * `restoreDocument()` synchronously underneath, no engine round trip.
 *
 * No React (src/core).
 */

import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import type { EngineClient, ProjectFormat, SaveProjectResult } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { engineOwnsDocumentNow } from '@core/engine/engineOwnership';

/** An engine request for the document was refused (the message is the engine's). */
export class LiveDocumentError extends Error {
  constructor(readonly op: string, readonly code: string, message: string) {
    super(`${op}: ${message}`);
    this.name = 'LiveDocumentError';
  }
}

/** Where the requests go (a test seam; the app's session engine by default). */
let client: () => EngineClient = () => engine();
let owned: () => boolean = () => engineOwnsDocumentNow();

/** Tests: route to a given engine and owner flag (null restores the app's). */
export function setLiveDocumentSource(source: { engine: () => EngineClient; owned: () => boolean } | null): void {
  client = source?.engine ?? (() => engine());
  owned = source?.owned ?? (() => engineOwnsDocumentNow());
}

/** Is the engine the owner (so the page must not capture or restore itself)? */
export function liveDocumentFromEngine(): boolean {
  return owned();
}

/** The document as the owner holds it — what a save would write. */
export async function liveDocument(): Promise<EditorDocument> {
  if (!owned()) return captureDocument();
  const r = await client().query({ type: 'exportDocument' });
  if (!r.ok) throw new LiveDocumentError('exportDocument', r.error.code, r.error.message);
  return JSON.parse(new TextDecoder().decode(r.value.document)) as EditorDocument;
}

/**
 * Replace the live document. With the engine as owner this is ONE undoable
 * entry labelled `label` (the History panel shows it; Undo brings back the
 * previous document). Flag off: the page's `restoreDocument`, as before — the
 * caller keeps whatever history handling it already had.
 */
export async function replaceLiveDocument(doc: EditorDocument, label: string): Promise<void> {
  if (!owned()) {
    restoreDocument(doc);
    return;
  }
  const r = await client().execute({ type: 'restoreDocument', document: new TextEncoder().encode(JSON.stringify(doc)), label });
  if (!r.ok) throw new LiveDocumentError('restoreDocument', r.error.code, r.error.message);
}

/**
 * The engine writes the document to `path` (temp file + rename). Only with the
 * engine as owner — the page path has its own writers — so this throws when
 * the page owns the document.
 */
export async function saveLiveDocument(
  path: string,
  opts: { copy: boolean; format?: ProjectFormat },
): Promise<SaveProjectResult> {
  if (!owned()) throw new LiveDocumentError('saveProject', 'unsupported', 'the page owns the document; save through ProjectManager');
  const r = await client().execute({ type: 'saveProject', path, copy: opts.copy, ...(opts.format ? { format: opts.format } : {}) });
  if (!r.ok) throw new LiveDocumentError('saveProject', r.error.code, r.error.message);
  return r.value;
}
