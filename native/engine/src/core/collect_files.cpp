#include "collect_files.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>
#include <system_error>
#include <utility>

#include "bundle_io.hpp"
#include "fail.hpp"
#include "jobs/job_inputs.hpp"

namespace premation::doc {

namespace fs = std::filesystem;
using api::ErrorCode;
using js::Json;

namespace {

constexpr std::string_view kBlobScheme = "motion-blob:";

bool truthy_string(const Json& v) { return v.is_string() && !v.str().empty(); }

bool is_blank(std::string_view s) {
  return std::all_of(s.begin(), s.end(), [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; });
}

/// A src that travels inside the document or belongs to a server: never copied
/// (bundleAssetSync.ts `needsCollecting`: a durable remote src is a reference, not ours to copy).
bool travels_as_is(std::string_view s) {
  return s.starts_with("data:") || s.starts_with("http:") || s.starts_with("https:") || s.starts_with("/files/");
}

std::string base_name(std::string_view ref) {
  std::string_view s = ref;
  if (s.starts_with(kBlobScheme)) return std::string(s.substr(kBlobScheme.size(), 12));
  const std::size_t q = s.find_first_of("?#");
  if (q != std::string_view::npos && (s.starts_with("file:") || s.starts_with("local-file:"))) s = s.substr(0, q);
  const std::size_t slash = s.find_last_of("/\\");
  return std::string(slash == std::string_view::npos ? s : s.substr(slash + 1));
}

std::string lower_ext(std::string_view name) {
  const std::size_t dot = name.find_last_of('.');
  if (dot == std::string_view::npos) return {};
  std::string e(name.substr(dot + 1));
  for (char& c : e) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return e;
}

/// importFromDisk.ts `mimeForPath`'s common cases; the rest is octet-stream.
std::string mime_for(std::string_view name) {
  static const std::map<std::string, const char*, std::less<>> kMime = {
      {"png", "image/png"},   {"jpg", "image/jpeg"},       {"jpeg", "image/jpeg"},   {"webp", "image/webp"},
      {"gif", "image/gif"},   {"svg", "image/svg+xml"},    {"exr", "image/x-exr"},   {"hdr", "image/vnd.radiance"},
      {"tif", "image/tiff"},  {"tiff", "image/tiff"},      {"psd", "image/vnd.adobe.photoshop"},
      {"mp4", "video/mp4"},   {"m4v", "video/mp4"},        {"mov", "video/quicktime"}, {"webm", "video/webm"},
      {"mkv", "video/x-matroska"}, {"avi", "video/x-msvideo"}, {"mp3", "audio/mpeg"}, {"wav", "audio/wav"},
      {"aac", "audio/aac"},   {"m4a", "audio/mp4"},        {"ogg", "audio/ogg"},     {"flac", "audio/flac"},
      {"json", "application/json"}, {"glb", "model/gltf-binary"}, {"gltf", "model/gltf+json"},
      {"ttf", "font/ttf"},    {"otf", "font/otf"},         {"woff", "font/woff"},    {"woff2", "font/woff2"},
  };
  const auto it = kMime.find(lower_ext(name));
  return it != kMime.end() ? it->second : "application/octet-stream";
}

/// The registry row's `type` (portableMotion.ts / the asset store's kinds).
std::string type_for(const std::string& mime) {
  if (mime.starts_with("image/")) return "image";
  if (mime.starts_with("video/")) return "video";
  if (mime.starts_with("audio/")) return "audio";
  if (mime == "application/json") return "json";
  if (mime.find("font") != std::string::npos) return "font";
  return "other";
}

/// `a` is `b` or lies inside it (both normal, '/'-separated).
bool within(const std::string& a, const std::string& b) {
  if (a.empty() || b.empty()) return false;
  if (a == b) return true;
  return a.size() > b.size() && a.starts_with(b) && (b.back() == '/' || a[b.size()] == '/');
}

/// One collect's state: every file read once, one registry row per content hash.
class Collector {
 public:
  Collector(CollectIo& io, std::string target, std::string sourceBundle)
      : io_(io), target_(std::move(target)), source_(std::move(sourceBundle)) {}

  struct Read {
    bool ok = false;
    std::string hash;
    std::string why;
  };

  /// Collect the file `ref` names (cached per ref). `id` / `name`: the registry row's, when it is new.
  Read collect(const std::string& ref, const std::string& id, const std::string& name) {
    auto it = reads_.find(ref);
    if (it == reads_.end()) {
      Read r;
      std::string bytes;
      if (io_.read(ref, source_, bytes, r.why)) {
        r.ok = true;
        r.hash = sha256_hex(bytes);
        const std::uint64_t wrote = io_.put_blob(target_, r.hash, bytes);
        bytes_ += wrote;
        if (!rowOf_.contains(r.hash)) {
          const std::string display = name.empty() ? base_name(ref) : name;
          const std::string mime = mime_for(lower_ext(display).empty() ? base_name(ref) : display);
          Json row = Json::object();
          row.set("id", Json::string(id.empty() ? "asset_" + r.hash.substr(0, 12) : id));
          row.set("hash", Json::string(r.hash));
          row.set("name", Json::string(display));
          row.set("type", Json::string(type_for(mime)));
          row.set("mime", Json::string(mime));
          row.set("size", Json::number(static_cast<double>(bytes.size())));
          rowOf_.emplace(r.hash, rows_.size());
          rows_.push_back(std::move(row));
        }
      }
      it = reads_.emplace(ref, std::move(r)).first;
    }
    return it->second;
  }

  void report(const std::string& key, const std::string& line) {
    if (reported_.insert(key).second) missing_.push_back(line);
  }

  [[nodiscard]] Json registry() const {
    Json r = Json::object();
    r.set("version", Json::string("1.0.0"));
    r.set("assets", Json::array(rows_));
    return r;
  }
  [[nodiscard]] std::uint64_t bytes() const noexcept { return bytes_; }
  [[nodiscard]] std::size_t files() const noexcept { return rows_.size(); }
  std::vector<std::string> take_missing() { return std::move(missing_); }

 private:
  CollectIo& io_;
  std::string target_;
  std::string source_;
  std::map<std::string, Read, std::less<>> reads_;
  std::vector<Json> rows_;
  std::map<std::string, std::size_t, std::less<>> rowOf_;
  std::set<std::string, std::less<>> reported_;
  std::vector<std::string> missing_;
  std::uint64_t bytes_ = 0;
};

}  // namespace

std::string collect_target(std::string_view folder) {
  const char sep = folder.find('\\') != std::string_view::npos && folder.find('/') == std::string_view::npos ? '\\' : '/';
  std::string base(folder);
  while (!base.empty() && (base.back() == '/' || base.back() == '\\')) base.pop_back();
  const std::size_t slash = base.find_last_of("/\\");
  std::string leaf = slash == std::string::npos ? base : base.substr(slash + 1);
  if (leaf.empty() || leaf.back() == ':') leaf = "Project";
  return (base.empty() ? std::string(1, sep) : base + sep) + leaf + ".motion";
}

CollectOutcome collect_files(CollectRequest req, CollectIo& io) {
  if (is_blank(req.folder)) fail(ErrorCode::invalid_argument, "collectFiles needs a folder");
  CollectOutcome out;
  out.path = collect_target(req.folder);

  // ── refusals: the source project is never written ──
  const std::string target = io.normal(out.path);
  const std::string folder = io.normal(req.folder);
  const std::string project = req.projectPath.empty() ? std::string() : io.normal(req.projectPath);
  const std::string source = req.sourceBundle.empty() ? std::string() : io.normal(req.sourceBundle);
  if ((!project.empty() && target == project) || (!source.empty() && target == source)) {
    fail(ErrorCode::invalid_argument, "'" + out.path + "' is the open project; collect into another folder");
  }
  if (within(folder, source) || within(target, source) || (!project.empty() && within(folder, project))) {
    fail(ErrorCode::invalid_argument, "'" + req.folder + "' is inside the open project; collect into a folder outside it");
  }
  if (io.target(out.path) == CollectIo::Target::other) {
    fail(ErrorCode::io, "could not write '" + out.path + "': something that is not a .motion bundle is there");
  }

  Json& doc = req.doc;
  Json* footage = nullptr;
  if (Json* pi = doc.find_mut("projectItems"); pi != nullptr && pi->is_object()) {
    footage = pi->find_mut("footage");
    if (footage != nullptr && !footage->is_object()) footage = nullptr;
  }
  // removeUnusedItems' rule, on the copy only.
  if (req.onlyUsed && footage != nullptr) {
    for (const std::string& id : req.unusedItems) footage->erase(id);
  }
  auto record_of = [&footage](const std::string& id) -> Json* {
    if (footage == nullptr || id.empty()) return nullptr;
    Json* r = footage->find_mut(id);
    return r != nullptr && r->is_object() ? r : nullptr;
  };
  auto name_of = [](const Json* rec, const std::string& ref) {
    if (rec != nullptr && truthy_string(rec->at("name"))) return rec->at("name").str();
    return base_name(ref);
  };

  Collector c(io, out.path, req.sourceBundle);
  std::map<std::string, std::string, std::less<>> itemHash;  // item id → the collected file's hash

  // ── the layers' footage: every src / __src ──
  if (Json* scene = doc.find_mut("scene"); scene != nullptr) {
    if (Json* nodes = scene->find_mut("nodes"); nodes != nullptr && nodes->is_array()) {
      for (Json& node : nodes->arr_mut()) {
        Json* comps = node.find_mut("components");
        if (comps == nullptr || !comps->is_array()) continue;
        for (Json& comp : comps->arr_mut()) {
          Json* props = comp.find_mut("props");
          if (props == nullptr || !props->is_object()) continue;
          for (const auto& [idKey, srcKey] : {std::pair<const char*, const char*>{"assetId", "src"}, {"__assetId", "__src"}}) {
            const Json& idv = props->at(idKey);
            const std::string id = truthy_string(idv) ? idv.str() : std::string();
            const Json& srcv = props->at(srcKey);
            const std::string src = srcv.is_string() ? srcv.str() : std::string();
            const Json* rec = record_of(id);
            std::vector<std::string> candidates;
            // The item's file wins (a relinked item plays from it; a session blob: src is unreadable here).
            if (rec != nullptr && truthy_string(rec->at("path")) && !travels_as_is(rec->at("path").str())) {
              candidates.push_back(rec->at("path").str());
            }
            if (!src.empty() && !travels_as_is(src)) candidates.push_back(src);
            if (candidates.empty()) continue;
            std::string why;
            bool done = false;
            for (const std::string& ref : candidates) {
              const Collector::Read r = c.collect(ref, id, name_of(rec, ref));
              if (!r.ok) {
                if (why.empty()) why = r.why;
                continue;
              }
              props->set(srcKey, Json::string(std::string(kBlobScheme) + r.hash));
              if (!id.empty()) itemHash.emplace(id, r.hash);
              done = true;
              break;
            }
            if (!done) {
              const std::string& first = candidates.front();
              c.report(id.empty() ? first : id, name_of(rec, first) + ": " + why);
            }
          }
        }
      }
    }
  }

  // ── the footage items: collected ones lose their outside path; unused
  //    items' files (without onlyUsed) and proxies are collected too ──
  if (footage != nullptr) {
    for (auto& m : footage->obj_mut()) {
      Json& rec = m.value;
      if (!rec.is_object()) continue;
      const std::string& id = m.key;
      const std::string name = name_of(&rec, truthy_string(rec.at("path")) ? rec.at("path").str() : id);
      if (itemHash.contains(id)) {
        rec.erase("path");
      } else if (!req.onlyUsed && req.unusedItems.contains(id) && truthy_string(rec.at("path")) &&
                 !travels_as_is(rec.at("path").str())) {
        const Collector::Read r = c.collect(rec.at("path").str(), id, name);
        if (r.ok) {
          rec.erase("path");
        } else {
          c.report(id, name + ": " + r.why);
        }
      }
      if (Json* proxy = rec.find_mut("proxy"); proxy != nullptr && proxy->is_object() && truthy_string(proxy->at("src")) &&
                                               !travels_as_is(proxy->at("src").str())) {
        const std::string ref = proxy->at("src").str();
        const Collector::Read r = c.collect(ref, std::string(), base_name(ref));
        if (r.ok) {
          proxy->set("src", Json::string(std::string(kBlobScheme) + r.hash));
        } else {
          c.report(id + "/proxy", name + " (proxy): " + r.why);
        }
      }
    }
  }

  out.bytes = c.bytes() + io.write_bundle(out.path, doc, c.registry());
  out.collected = c.files();
  out.missing = c.take_missing();
  return out;
}

// ── on disk ──────────────────────────────────────────────────────────────

namespace {

fs::path path_of(std::string_view s) { return fs::path(std::u8string(s.begin(), s.end())); }

std::string utf8(const fs::path& p) {
  const std::u8string s = p.generic_u8string();
  return {s.begin(), s.end()};
}

class DiskCollectIo final : public CollectIo {
 public:
  bool read(std::string_view ref, const std::string& sourceBundle, std::string& bytes, std::string& why) override {
    const std::string file = jobs::resolve_footage_path(ref, sourceBundle);
    if (file.empty()) {
      why = ref.starts_with("blob:") ? "session footage the engine cannot read (blob:); re-import or relink the file"
            : ref.starts_with(kBlobScheme) ? "bundle footage without a bundle to read it from"
                                           : "not a file reference";
      return false;
    }
    const fs::path p = path_of(file);
    std::error_code ec;
    if (fs::is_directory(p, ec)) {
      why = "'" + file + "' is a folder";
      return false;
    }
    if (!fs::is_regular_file(p, ec)) {
      why = "no file at '" + file + "'";
      return false;
    }
    std::ifstream in(p, std::ios::binary);
    if (!in) {
      why = "could not read '" + file + "'";
      return false;
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    if (in.bad()) {
      why = "could not read '" + file + "'";
      return false;
    }
    bytes = std::move(ss).str();
    return true;
  }

  std::string normal(const std::string& path) override {
    std::error_code ec;
    fs::path p = fs::weakly_canonical(path_of(path), ec);
    if (ec) p = fs::absolute(path_of(path), ec).lexically_normal();
    std::string s = utf8(p);
    while (s.size() > 1 && s.back() == '/') s.pop_back();
    return s;
  }

  Target target(const std::string& path) override {
    const fs::path p = path_of(path);
    std::error_code ec;
    if (is_bundle_dir(p)) return Target::bundle;
    if (!fs::exists(p, ec)) return Target::absent;
    // An empty folder is as good as none (a collect that failed before its first write).
    if (fs::is_directory(p, ec) && fs::is_empty(p, ec)) return Target::absent;
    return Target::other;
  }

  std::uint64_t put_blob(const std::string& bundle, const std::string& hash, std::string_view bytes) override {
    const fs::path to = path_of(bundle) / "blobs" / hash.substr(0, 2) / hash;
    std::error_code ec;
    if (fs::is_regular_file(to, ec) && fs::file_size(to, ec) == bytes.size()) return 0;  // content-addressed: already there
    write_file_atomic(to, bytes);
    return bytes.size();
  }

  std::uint64_t write_bundle(const std::string& bundle, const Json& doc, const Json& registry) override {
    const fs::path dir = path_of(bundle);
    const std::string reg = js::stringify(registry);
    write_file_atomic(dir / "assets" / "registry.json", reg);
    // No source: every file the copy names is in `dir` already (put_blob).
    return reg.size() + ::premation::doc::write_bundle(dir, doc, fs::path());
  }
};

}  // namespace

std::unique_ptr<CollectIo> make_disk_collect_io() { return std::make_unique<DiskCollectIo>(); }

}  // namespace premation::doc
