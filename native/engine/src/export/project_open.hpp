// F1: a project on disk as the export job opens it — without the editor.
//
//   a `.motion` bundle (a directory: manifest.json + scene/animation/timeline/
//   meta/project chunks, bundleCodec.ts `decodeBundle`), its footage library
//   from assets/registry.json (bundleAssetSync.ts `assetsFromRecords`) and its
//   content-addressed bytes at blobs/<hash[0:2]>/<hash>;
//   or a single JSON document (a legacy `.motion`, or a render-tests scene
//   `project.json`, whose `harness.assets` are its session footage).
//
// Every `motion-blob:<hash>` string in the document or the footage records is
// rewritten to the blob's file path, which the engine's decoders open directly.
#pragma once

#include <filesystem>
#include <string>
#include <vector>

#include "json.hpp"

namespace premation::exporter {

struct OpenedProject {
  js::Json document;                  // an EditorDocument, ready for doc::restore_document
  std::vector<js::Json> sessionAssets;  // the footage records the editor would hold for it
  std::filesystem::path mediaBase;    // relative media paths resolve here
};

/// False with `error` when the path is neither a bundle nor a parsable JSON document.
bool open_project(const std::filesystem::path& path, OpenedProject& out, std::string& error);

/// Replace `motion-blob:<hash>` strings (anywhere in `v`) with `<bundle>/blobs/<hh>/<hash>`. Pure; tested.
void rewrite_blob_refs(js::Json& v, const std::filesystem::path& bundle);

}  // namespace premation::exporter
