/**
 * Render ANOTHER document with the live engines: swap it in, run `fn`, swap
 * the live document back — invisible to undo, restored in `finally` so a
 * failure cannot leave the editor showing the other document. Not an edit
 * (Versions ▸ Compare renders a saved version at the playhead). Goes when the
 * engine renders a document other than the open one (ENGINE_API.md §13); until
 * then the engine sees each swap as an external change and resyncs.
 *
 * F2: with the ENGINE as owner the page's stores are only its replica, and
 * the swap stays in the page (the offline still renderer draws the page's
 * stores; the owner never sees it). What comes BACK is the owner's document
 * (`exportDocument`), not a page capture: the replica is re-synced to the
 * truth rather than to whatever it held before.
 */

import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { liveDocument, liveDocumentFromEngine } from './liveDocument';
import { bumpScene } from '@stores/sceneStore';

export async function withDocumentSwapped<T>(doc: EditorDocument, fn: () => Promise<T>): Promise<T> {
  const live = liveDocumentFromEngine() ? await liveDocument() : captureDocument();
  restoreDocument(structuredClone(doc));
  bumpScene();
  try {
    return await fn();
  } finally {
    restoreDocument(live);
    bumpScene();
  }
}
