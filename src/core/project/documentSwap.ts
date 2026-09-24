/**
 * Render ANOTHER document with the live engines: swap it in, run `fn`, swap
 * the live document back — invisible to undo, restored in `finally` so a
 * failure cannot leave the editor showing the other document. Not an edit
 * (Versions ▸ Compare renders a saved version at the playhead). Goes when the
 * engine renders a document other than the open one (ENGINE_API.md §13); until
 * then the engine sees each swap as an external change and resyncs.
 */

import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { useHistoryStore } from '@stores/historyStore';
import { bumpScene } from '@stores/sceneStore';

export async function withDocumentSwapped<T>(doc: EditorDocument, fn: () => Promise<T>): Promise<T> {
  const h = useHistoryStore.getState();
  h.flush();
  const live = captureDocument();
  h.runRestoring(() => {
    restoreDocument(structuredClone(doc));
    bumpScene();
  });
  try {
    return await fn();
  } finally {
    useHistoryStore.getState().runRestoring(() => {
      restoreDocument(live);
      bumpScene();
    });
  }
}
