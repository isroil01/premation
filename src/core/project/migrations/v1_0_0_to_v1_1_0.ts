/**
 * 1.0.0 → 1.1.0 — hoist the single active comp into the `comps` registry.
 *
 * v1.0.0 documents carried ONE composition's settings as `doc.comp`; v1.1.0
 * carries every composition keyed by id as `doc.comps`. Until now this was
 * handled implicitly by `restoreDocument`'s tolerance (`if comps … else if
 * comp`), which worked but meant the schema change existed only as a branch in
 * restore code — invisible to anything reasoning about document versions, and
 * impossible to test independently of the store.
 *
 * Making it an explicit migration is what lets the walker refuse an unknown gap
 * (see index.ts): with an empty registry, "older than us" and "unbridgeable"
 * are indistinguishable, so either every old document throws or none do.
 *
 * `comp` is deliberately PRESERVED, not deleted. It costs one small key and it
 * keeps a migrated document readable by a build from before this change —
 * the same accept-both-shapes discipline the matte migration (M3) will need for
 * its rollback story. A migration that destroys the old field cannot be undone
 * by reverting the app.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { DocumentMigration } from './index';

export const v1_0_0_to_v1_1_0: DocumentMigration = {
  from: '1.0.0',
  to: '1.1.0',
  description: 'Hoist the single active `comp` into the `comps` registry.',
  migrate(doc: EditorDocument): EditorDocument {
    // Already has the registry (a hand-edited or partially-upgraded file):
    // leave it alone rather than letting the legacy single comp overwrite it.
    if (doc.comps && Object.keys(doc.comps).length > 0) return doc;
    if (!doc.comp) return doc;

    return {
      ...doc,
      comps: { [doc.comp.id]: doc.comp },
    };
  },
};
