// Stream B2: the stored subject matte files a project keeps on disk (the
// "Object Matte" folder next to the project file: `matte_<frame>_<runId>.png`
// from a walk, `subject_<frame>_<stamp>.png` from an edit) and the collection
// of the ones nothing names any more. A walk writes new files every run, so
// an undone document state keeps the pixels it points to; the files pile up
// until a save, when `gc_object_matte_files` deletes the ones no document
// state of the session references — not the document, not any undo / redo
// entry, not the gesture in flight.
#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

#include "history.hpp"
#include "model.hpp"

namespace premation::doc {

/// A stored matte `src` (a path, a `file://` or `local-file://` URL) as the key the GC compares:
/// decoded, lexically normal, one separator — and case-folded on Windows.
[[nodiscard]] std::string matte_file_key(std::string_view src);
/// The same for a path on disk.
[[nodiscard]] std::string matte_file_key(const std::filesystem::path& p);

/// `<project folder>/Object Matte` — where walks and edits store their frames (kind_object_matte.cpp).
[[nodiscard]] std::filesystem::path object_matte_folder(const std::filesystem::path& projectPath);

/// Every stored matte file the document's layers name (fx.alphaMatte.frames[].src), as keys.
void collect_matte_files(const Document& d, std::unordered_set<std::string>& out);
/// The same for a change set's parts (before and after): what an undo or redo would bring back.
void collect_matte_files(const ChangeSet& changes, std::unordered_set<std::string>& out);

/// Whether a file name is one a walk or an edit writes (and so one the GC may take).
[[nodiscard]] bool is_stored_matte_name(std::string_view fileName);

/// The pure rule: of the files on disk, those the GC deletes — stored-matte names only, and none
/// whose key is in `referenced`.
[[nodiscard]] std::vector<std::filesystem::path> matte_files_to_delete(std::span<const std::filesystem::path> onDisk,
                                                                        const std::unordered_set<std::string>& referenced);

struct MatteGcResult {
  std::size_t deleted = 0;
  std::uint64_t bytes = 0;
  std::size_t kept = 0;  ///< stored-matte files left (referenced, or not deletable)
};

/// Delete the stored matte files under the project's Object Matte folder that no state of the
/// session references: the document, every history entry (undo and redo), the open gesture.
/// Run on save. A file that cannot be deleted is left (counted as kept). No folder: nothing.
MatteGcResult gc_object_matte_files(const std::filesystem::path& projectPath, const Document& d, const History& history,
                                    const ChangeSet* gesture);

}  // namespace premation::doc
