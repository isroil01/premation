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
#include "collect_files.hpp"
#include "convert_geometry.hpp"
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
  /// The next gesture id (ids.ts `nextGesture`): counted under `gesture`, so the
  /// id state carries it and a replay names the same gestures.
  std::uint32_t next_gesture();
  /// A new document's counters; the gesture counter is a session counter and survives.
  void reset();
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
  /// importBytes: one footage record from bytes; throws EngineFail(io). Present with has_import().
  [[nodiscard]] virtual Json import_bytes(const api::ImportBytesFile& file, const std::string& id);
  [[nodiscard]] virtual bool has_probe() const { return false; }
  [[nodiscard]] virtual Json probe_file(const std::string& path);
  [[nodiscard]] virtual bool has_projects() const { return false; }
  /// A project document (EditorDocument JSON); throws EngineFail(io).
  [[nodiscard]] virtual Json read_project(const std::string& path);
  /// Returns the byte count written; throws EngineFail(io).
  virtual std::uint64_t write_project(const std::string& path, const Json& doc);
  /// F2: saveProject with its `format` and the bundle the document's
  /// `motion-blob:` footage lives in (empty = none). The default ignores both
  /// (`write_project`); FilePorts writes the form asked for (bundle_io.hpp).
  virtual std::uint64_t write_project_as(const std::string& path, const Json& doc, api::ProjectFormat format,
                                         const std::string& sourceBundle);
  /// F2: does `path` name a `.motion` bundle (so the document's footage lives there)?
  [[nodiscard]] virtual bool is_bundle(const std::string& path) const;
  /// F2: what openProject loads. `portable` = a portable `.motion` zip: the
  /// document is a COPY (the session stays untitled, as the page's
  /// `adopt(name, null)`), its footage unpacked into `footageRoot`.
  struct Opened {
    Json doc;
    std::string footageRoot;  ///< the bundle its `motion-blob:` footage lives in ('' = none)
    bool portable = false;
    std::size_t embedded = 0;
  };
  /// The default: `read_project`, with `path` as the footage root when it is a bundle.
  [[nodiscard]] virtual Opened open_project(const std::string& path);
  [[nodiscard]] virtual bool has_collect() const { return false; }
  /// collectFiles (collect_files.hpp): a copy of the project and its files in
  /// `req.folder`. The default: `unsupported`. Throws EngineFail.
  [[nodiscard]] virtual CollectOutcome collect_files(CollectRequest req);
  /// A file's raw bytes (importProject of `.aep` / `.aepx`). The default has none.
  [[nodiscard]] virtual bool has_file_bytes() const { return false; }
  /// Throws EngineFail (FilePorts: `io`).
  [[nodiscard]] virtual std::vector<std::uint8_t> read_file_bytes(const std::string& path);
};

/// The harness's fake ports (__testHelpers__/harness.ts `fakePorts`):
/// deterministic footage records, projects kept in memory.
class FakePorts final : public Ports {
 public:
  FakePorts() = default;
  /// `dir` non-empty: every written project is also written to `dir` (one file
  /// per path, hex-named), and a path not in memory is read from there: the
  /// cross-engine replay's fixtures and its saved-document comparison.
  explicit FakePorts(std::string dir) : dir_(std::move(dir)) {}
  [[nodiscard]] bool has_import() const override { return true; }
  [[nodiscard]] Json import_file(const api::ImportFile& file, const std::string& id) override;
  [[nodiscard]] Json import_bytes(const api::ImportBytesFile& file, const std::string& id) override;
  [[nodiscard]] bool has_probe() const override { return true; }
  [[nodiscard]] Json probe_file(const std::string& path) override;
  [[nodiscard]] bool has_projects() const override { return true; }
  [[nodiscard]] Json read_project(const std::string& path) override;
  std::uint64_t write_project(const std::string& path, const Json& doc) override;
  /// collectFiles in memory: the files it can read are the bytes it imported
  /// (import_bytes: the data under its `blob:fake/<id>` src and origin path;
  /// import_file: `fake:<path>` under the path) plus add_file(); the collected
  /// document is kept like a written project (read_project / openProject
  /// read it back), its blobs in memory (blob()).
  [[nodiscard]] bool has_collect() const override { return true; }
  [[nodiscard]] CollectOutcome collect_files(CollectRequest req) override;
  /// A file the fake collector can read.
  void add_file(std::string ref, std::string bytes) { fakeFiles_.insert_or_assign(std::move(ref), std::move(bytes)); }
  /// A collected file of `bundle` (nullptr when absent).
  [[nodiscard]] const std::string* blob(const std::string& bundle, const std::string& hash) const;
  /// The registry a collect wrote into `bundle` (undefined when none).
  [[nodiscard]] Json registry(const std::string& bundle) const;
  /// Raw file bytes: seeded ones, else `<dir>/<hex of the path>.bin` in the mirror
  /// directory. Neither: `unsupported` — the TypeScript twin (harness fakePorts)
  /// has no bytes port and refuses an `.aep` import the same way, so the
  /// cross-engine replay answers alike.
  [[nodiscard]] bool has_file_bytes() const override { return true; }
  [[nodiscard]] std::vector<std::uint8_t> read_file_bytes(const std::string& path) override;
  void seed_file_bytes(std::string path, std::vector<std::uint8_t> bytes) {
    fileBytes_.insert_or_assign(std::move(path), std::move(bytes));
  }

 private:
  std::map<std::string, std::vector<std::uint8_t>, std::less<>> fileBytes_;
  friend class FakeCollectIo;
  std::map<std::string, Json, std::less<>> files_;
  std::string dir_;
  std::map<std::string, std::string, std::less<>> fakeFiles_;
  std::map<std::string, std::string, std::less<>> blobs_;  ///< "<bundle>/blobs/<hash>" → bytes
  std::map<std::string, Json, std::less<>> registries_;
};

/// Project files on disk, written temp-file + rename: JSON EditorDocuments,
/// `.motion` directory bundles and portable zips (bundle_io.hpp). A directory
/// is read as a bundle.
class FilePorts final : public Ports {
 public:
  /// A file's media facts from the engine's decoders — `type` (video / audio /
  /// image), `metadata` {width, height, duration, fps, hasAudioTrack} — or
  /// false + `error` when nothing can read it. The engine process passes
  /// jobs::probe_media; without one, importFiles answers `unsupported`.
  using MediaProbe = std::function<bool(const std::string& path, Json& facts, std::string& error)>;
  FilePorts() = default;
  explicit FilePorts(MediaProbe probe) : probe_(std::move(probe)) {}
  /// importFiles by path: the file stays where it is; the record's `src` is
  /// its `local-file://` URL (what the page's own importer gives a file on
  /// disk), `path` the path.
  [[nodiscard]] bool has_import() const override { return static_cast<bool>(probe_); }
  [[nodiscard]] Json import_file(const api::ImportFile& file, const std::string& id) override;
  [[nodiscard]] bool has_probe() const override { return static_cast<bool>(probe_); }
  [[nodiscard]] Json probe_file(const std::string& path) override;
  [[nodiscard]] bool has_projects() const override { return true; }
  [[nodiscard]] Json read_project(const std::string& path) override;
  std::uint64_t write_project(const std::string& path, const Json& doc) override;
  std::uint64_t write_project_as(const std::string& path, const Json& doc, api::ProjectFormat format,
                                 const std::string& sourceBundle) override;
  [[nodiscard]] bool is_bundle(const std::string& path) const override;
  /// A portable zip is unpacked into `<staging>/<hash of its path>` (bundle_io.hpp `read_portable`).
  [[nodiscard]] Opened open_project(const std::string& path) override;
  /// collectFiles on disk (collect_files.hpp `make_disk_collect_io`).
  [[nodiscard]] bool has_collect() const override { return true; }
  [[nodiscard]] CollectOutcome collect_files(CollectRequest req) override;
  /// A file read whole (at most 1 GiB); `io` when it cannot be.
  [[nodiscard]] bool has_file_bytes() const override { return true; }
  [[nodiscard]] std::vector<std::uint8_t> read_file_bytes(const std::string& path) override;
  /// Where portable footage is unpacked: `<temp>/premation-portable` unless set.
  void set_staging_root(std::string dir) { staging_ = std::move(dir); }

 private:
  std::string staging_;
  MediaProbe probe_;
};

/// `local-file:///C:/a%20b.mp4` for a path on disk (electron/localFileUrl.ts
/// reads it back; jobs' resolve_footage_path too).
[[nodiscard]] std::string local_file_url(std::string_view path);

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
  /// Fonts / text layout / SVG for the layer conversions (convert_geometry.hpp);
  /// null = none attached (the conversions answer `unsupported`).
  ConvertGeometry* geometry = nullptr;

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
