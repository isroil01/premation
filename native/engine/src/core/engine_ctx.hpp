// What an edit handler works with — src/core/engine/handler.ts `HandlerCtx`,
// ids.ts, keyIndex.ts and ports.ts, over the C++ document.
//
// A handler VALIDATES (throwing EngineFail), then mutates the document through
// its journaled writers; the dispatcher (session.cpp) commits the journal as
// the request's inverse, or rolls it back on failure. A handler never pushes
// history, never emits events and never touches editor state other than the
// EditorView facts the TypeScript rules read.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "anim.hpp"
#include "model.hpp"
#include "props.hpp"
#include "timeline.hpp"

namespace premation::doc {

/// ids.ts: `<prefix><n>` with a counter per prefix, skipping ids in use.
class IdAllocator {
 public:
  std::string next(std::string_view prefix, const std::function<bool(const std::string&)>& taken);
  /// `k<n>` keyframe ids.
  std::string next_keyframe(const std::function<bool(const std::string&)>& taken);
  /// Seed the keyframe counter past every `k<n>` in `ids`.
  void seed_keyframes(const std::vector<std::string>& ids);
  void reset() { counters_.clear(); }
  [[nodiscard]] const std::map<std::string, double, std::less<>>& state() const noexcept { return counters_; }
  void restore(std::map<std::string, double, std::less<>> s) { counters_ = std::move(s); }

 private:
  std::map<std::string, double, std::less<>> counters_;
};

/// `stableKeyframeIdSeq(id)`: n for `k<n>`, else 0.
[[nodiscard]] double stable_keyframe_id_seq(std::string_view id);
/// Every keyframe id the document holds (scalar and data tracks).
[[nodiscard]] std::vector<std::string> all_keyframe_ids(const Document& d);

/// keyIndex.ts: keyframe id → where the key lives. Rebuilt lazily.
struct KeyLoc {
  std::string layer;
  std::string member;  ///< scalar track, data track, or `mask:<maskId>`
  double t = 0;        ///< stored (keyframe-axis) seconds
  enum class Kind : std::uint8_t { scalar, data, mask } kind = Kind::scalar;
  std::optional<std::string> maskId;
};

class KeyIndex {
 public:
  void invalidate() {
    map_.reset();
    markers_.reset();
  }
  [[nodiscard]] bool has(const Document& d, const std::string& id);
  [[nodiscard]] std::optional<KeyLoc> resolve(const Document& d, const std::string& id);
  /// Marker id in use; an id asked about and free is reserved (TS semantics).
  [[nodiscard]] bool marker_taken(const Document& d, const std::string& id);

 private:
  void build(const Document& d);
  std::unique_ptr<std::unordered_map<std::string, KeyLoc>> map_;
  std::unique_ptr<std::set<std::string, std::less<>>> markers_;
};

/// ports.ts — the engine's view of files and media. `nullopt`/false answers
/// mean "no such port attached" (the command answers `unsupported`).
class Ports {
 public:
  Ports() = default;
  Ports(const Ports&) = delete;
  Ports& operator=(const Ports&) = delete;
  Ports(Ports&&) = delete;
  Ports& operator=(Ports&&) = delete;
  virtual ~Ports() = default;

  [[nodiscard]] virtual bool has_import() const { return false; }
  /// Import one file as a footage record (JSON ImportedAsset) with `id`; throws EngineFail(io).
  [[nodiscard]] virtual Json import_file(const api::ImportFile& file, const std::string& id);
  [[nodiscard]] virtual bool has_probe() const { return false; }
  [[nodiscard]] virtual Json probe_file(const std::string& path);
  [[nodiscard]] virtual bool has_projects() const { return false; }
  /// A project document (EditorDocument JSON); throws EngineFail(io).
  [[nodiscard]] virtual Json read_project(const std::string& path);
  /// Returns the byte count written; throws EngineFail(io).
  virtual std::uint64_t write_project(const std::string& path, const Json& doc);
  [[nodiscard]] virtual bool has_collect() const { return false; }
};

/// The harness's fake ports (__testHelpers__/harness.ts `fakePorts`):
/// deterministic footage records, projects kept in memory.
class FakePorts final : public Ports {
 public:
  [[nodiscard]] bool has_import() const override { return true; }
  [[nodiscard]] Json import_file(const api::ImportFile& file, const std::string& id) override;
  [[nodiscard]] bool has_probe() const override { return true; }
  [[nodiscard]] Json probe_file(const std::string& path) override;
  [[nodiscard]] bool has_projects() const override { return true; }
  [[nodiscard]] Json read_project(const std::string& path) override;
  std::uint64_t write_project(const std::string& path, const Json& doc) override;

 private:
  std::map<std::string, Json, std::less<>> files_;
};

/// Project files on disk: JSON EditorDocuments, written temp-file + rename.
class FilePorts final : public Ports {
 public:
  [[nodiscard]] bool has_projects() const override { return true; }
  [[nodiscard]] Json read_project(const std::string& path) override;
  std::uint64_t write_project(const std::string& path, const Json& doc) override;
};

/// handler.ts `HandlerCtx`.
struct HCtx {
  Document& d;
  EditorView& view;
  IdAllocator& ids;
  KeyIndex& keys;
  const ExprEnv& expr;
  ExprCache& cache;
  Ports& ports;
  api::Origin origin = api::Origin::ui;
  /// The engine's playhead in flicks (transport time).
  api::Time time = 0;
  /// History label override (a handler sets it; else the humanized command name).
  std::optional<std::string> label;

  [[nodiscard]] PCtx pc() const { return PCtx{d, view, expr, cache}; }
  /// A layer/item id in the shared id space (`idTaken`).
  std::string mint_id(std::string_view prefix);
  /// A group id unique within a layer (`taken` says what the layer already has).
  std::string mint_group_id(std::string_view prefix, const std::function<bool(const std::string&)>& taken);
  std::string mint_key_id();
  std::string mint_marker_id();
};

/// common.ts `plural(n, noun)`.
[[nodiscard]] std::string plural(std::size_t n, std::string_view noun);

}  // namespace premation::doc
