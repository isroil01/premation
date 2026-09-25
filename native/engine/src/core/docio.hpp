// The project document ⇄ the engine document — src/core/api/cloudDocument.ts
// `captureDocument` / `restoreDocument` over the D1b model: the EditorDocument
// JSON the editor saves (.motion), so a project written by either engine opens
// in the other.
#pragma once

#include <string>
#include <vector>

#include "model.hpp"
#include "timeline.hpp"

namespace premation::doc {

/// `captureDocument()`: the whole document as an EditorDocument.
[[nodiscard]] Json capture_document(const Document& d);

struct RestoreResult {
  /// Footage the document lists that the session does not hold (kept as placeholders).
  std::vector<std::string> missing;
};

/// `loadDocument(doc, {resetWorkspace: true})`: replace `d` with the document.
/// `sessionAssets` are the footage records the session already holds
/// (LocalEngine.reconcileItems keeps the ones the document lists).
RestoreResult restore_document(Document& d, EditorView& v, const Json& doc, const std::vector<Json>& sessionAssets);

/// `migrateDocument(doc)` (src/core/project/migrations): the document at the
/// current version (1.9.0). Throws EngineFail(io) for a newer document.
[[nodiscard]] Json migrate_document(Json doc);

/// A saved scene node (`ProjectFile.nodes[i]`) as a Node (SceneGraph.wrap's reading).
[[nodiscard]] Node node_from_json(const Json& o);

}  // namespace premation::doc
