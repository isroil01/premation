/**
 * Loading a whole document into the live stores — shared by the engine's
 * document-replacing controls (open / revert / New Project, which clear
 * history) and the undoable `restoreDocument` edit (B3z: a saved / cloud
 * version restored as ONE entry). Native docio.cpp `restore_document` is the
 * C++ twin of `restoreDocument` + `reconcileDocumentItems`.
 */

import { restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { useAssetStore, replaceProjectItems, getDocumentItems } from '@stores/assetStore';

/**
 * The project's items are the ones its document lists. Footage the session
 * holds that the document does not list leaves the project; listed footage
 * the session does not hold is reported missing (AE's missing footage).
 * Returns the missing ids.
 */
export function reconcileDocumentItems(): string[] {
  // What `restoreDocument` APPLIED, not the file's key: a document written
  // before items existed carries none, and reading its absent key as "the
  // project lists nothing" emptied the item list and the folders on every
  // open of an older file (and of every bundle, which dropped the key).
  const stated = getDocumentItems() ?? { folders: [], footage: {} };
  const listed = stated.footage;
  const store = useAssetStore.getState();
  const keep = store.assets.filter((a) => a.id in listed);
  const missing = Object.keys(listed).filter((id) => !keep.some((a) => a.id === id));
  // Missing footage stays an ITEM (AE): a placeholder record with no bytes
  // (`src` empty → ItemInfo.missing), so the project still lists it and a
  // later relink or library hydration fills it in.
  const placeholders = missing.map((id) => {
    const r = listed[id]!;
    return {
      id, name: r.name ?? id, type: r.type ?? 'video', src: '', size: 0,
      ...(r.path ? { path: r.path } : {}), ...(r.folderId ? { folderId: r.folderId } : {}),
      ...(r.interpret ? { interpret: { ...r.interpret } } : {}), ...(r.label ? { label: r.label } : {}),
      ...(r.tags ? { tags: [...r.tags] } : {}), ...(r.comment ? { comment: r.comment } : {}),
    };
  });
  if (placeholders.length > 0 || keep.length !== store.assets.length) {
    replaceProjectItems({ assets: [...keep, ...placeholders], folders: stated.folders });
  }
  return missing;
}

/** `restoreDocument` of a private copy, then the item reconciliation. Returns the missing item ids. */
export function loadDocumentIntoStores(doc: EditorDocument): string[] {
  restoreDocument(structuredClone(doc));
  return reconcileDocumentItems();
}
