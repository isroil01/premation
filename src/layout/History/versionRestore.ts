/**
 * Restore a saved version as ONE undoable edit.
 *
 * `versionHistoryStore.restore` goes through the server (the version becomes
 * the project's head, so autosave keeps writing to the right place) and hands
 * the version's document back; the engine's `restoreDocument` (B3z) lands it
 * as ONE history entry, "Restore version" — undo brings the pre-restore
 * document back exactly, and the edits before it keep their own entries.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import { edit } from '@core/engine/uiEdits';
import { useVersionHistoryStore } from '@stores/versionHistoryStore';

/** The engine command that lands `doc` as one undoable entry named `label`. */
export async function restoreDocumentEdit(doc: EditorDocument, label: string): Promise<boolean> {
  const document = new TextEncoder().encode(JSON.stringify(doc));
  const res = await edit(label, { type: 'restoreDocument', document, label });
  return res.ok;
}

export async function restoreVersionAsOneEdit(versionId: string): Promise<void> {
  await useVersionHistoryStore.getState().restore(versionId, (doc) => restoreDocumentEdit(doc, 'Restore version'));
}
