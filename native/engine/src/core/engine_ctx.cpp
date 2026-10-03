#include "engine_ctx.hpp"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>

#include "bundle_io.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "scene.hpp"
#include "strutil.hpp"

namespace premation::doc {

// ── ids ──────────────────────────────────────────────────────────────────

namespace {
std::string num_str(double n) { return js::number_to_string(n); }
}  // namespace

std::string IdAllocator::next(std::string_view prefix, const std::function<bool(const std::string&)>& taken) {
  const auto it = counters_.find(prefix);
  double n = it != counters_.end() ? it->second : 0;
  std::string id;
  do {
    n += 1;
    id = std::string(prefix) + num_str(n);
  } while (taken(id));
  counters_.insert_or_assign(std::string(prefix), n);
  return id;
}

std::string IdAllocator::next_keyframe(const std::function<bool(const std::string&)>& taken) {
  const auto it = counters_.find("k");
  double n = it != counters_.end() ? it->second : 0;
  std::string id;
  do {
    n += 1;
    id = "k" + num_str(n);
  } while (taken(id));
  counters_.insert_or_assign("k", n);
  return id;
}

std::uint32_t IdAllocator::next_gesture() {
  const auto it = counters_.find("gesture");
  const double n = (it != counters_.end() ? it->second : 0) + 1;
  counters_.insert_or_assign("gesture", n);
  return static_cast<std::uint32_t>(n);
}

void IdAllocator::reset() {
  const auto it = counters_.find("gesture");
  if (it == counters_.end()) {
    counters_.clear();
    return;
  }
  const double g = it->second;
  counters_.clear();
  counters_.insert_or_assign("gesture", g);
}

void IdAllocator::seed_keyframes(const std::vector<std::string>& ids) {
  const auto it = counters_.find("k");
  double max = it != counters_.end() ? it->second : 0;
  for (const auto& id : ids) max = std::max(max, stable_keyframe_id_seq(id));
  counters_.insert_or_assign("k", max);
}

double stable_keyframe_id_seq(std::string_view id) {
  if (id.size() < 2 || id[0] != 'k') return 0;
  double v = 0;
  for (std::size_t i = 1; i < id.size(); ++i) {
    if (!is_ascii_digit(id[i])) return 0;
    v = v * 10 + (id[i] - '0');
  }
  return v;
}

std::vector<std::string> all_keyframe_ids(const Document& d) {
  std::vector<std::string> out;
  for (const auto& [node, a] : d.anims()) {
    for (const auto& [prop, keys] : a->tracks) {
      for (const Key& k : keys) {
        if (k.id) out.push_back(*k.id);
      }
    }
    for (const auto& [prop, t] : a->data) {
      for (const DataKey& k : t.keys) {
        if (k.id) out.push_back(*k.id);
      }
    }
  }
  return out;
}

// ── key index ────────────────────────────────────────────────────────────

void KeyIndex::build(const Document& d) {
  auto map = std::make_unique<std::unordered_map<std::string, KeyLoc>>();
  for (const auto& [layer, a] : d.anims()) {
    for (const auto& [member, keys] : a->tracks) {
      for (const Key& k : keys) {
        if (k.id && !k.id->empty()) map->try_emplace(*k.id, KeyLoc{layer, member, k.t, KeyLoc::Kind::scalar, std::nullopt});
      }
    }
  }
  for (const auto& [layer, a] : d.anims()) {
    for (const auto& [member, t] : a->data) {
      for (const DataKey& k : t.keys) {
        if (k.id && !k.id->empty()) map->try_emplace(*k.id, KeyLoc{layer, member, k.t, KeyLoc::Kind::data, std::nullopt});
      }
    }
  }
  // Mask shape keys: `<entry>@<maskId>` per path, and the bare entry id.
  for (const auto& [id, np] : d.nodes()) {
    for (const Json& k : read_node_mask_anim(*np)) {
      const Json& kid = k.at("id");
      if (!kid.is_string() || kid.str().empty()) continue;
      const double t = k.at("t").num();
      const Json& paths = k.at("mask").at("paths");
      if (paths.is_array()) {
        for (const Json& p : paths.arr()) {
          const std::string pid = p.at("id").is_string() ? p.at("id").str() : "undefined";
          (*map)[kid.str() + "@" + pid] = KeyLoc{id, "mask:" + pid, t, KeyLoc::Kind::mask, pid};
        }
      }
      map->try_emplace(kid.str(), KeyLoc{id, "mask:", t, KeyLoc::Kind::mask, std::nullopt});
    }
  }
  map_ = std::move(map);
}

bool KeyIndex::has(const Document& d, const std::string& id) {
  if (!map_) build(d);
  return map_->contains(id);
}

std::optional<KeyLoc> KeyIndex::resolve(const Document& d, const std::string& id) {
  if (!map_) build(d);
  if (const auto it = map_->find(id); it != map_->end()) return it->second;
  const auto fb = parse_fallback_key_id(id);
  if (!fb) return std::nullopt;
  if (fb->member.starts_with("mask:")) {
    const std::string maskId = fb->member.substr(5);
    const Node* n = d.node(fb->layer);
    if (n == nullptr) return std::nullopt;
    bool hit = false;
    for (const Json& k : read_node_mask_anim(*n)) {
      if (k.at("t").num() == fb->t) hit = true;
    }
    if (!hit) return std::nullopt;
    return KeyLoc{fb->layer, fb->member, fb->t, KeyLoc::Kind::mask, maskId};
  }
  if (const auto* keys = anim_track(d, fb->layer, fb->member)) {
    for (const Key& k : *keys) {
      if (k.t == fb->t) return KeyLoc{fb->layer, fb->member, fb->t, KeyLoc::Kind::scalar, std::nullopt};
    }
  }
  if (const DataTrack* t = anim_data_track(d, fb->layer, fb->member)) {
    for (const DataKey& k : t->keys) {
      if (k.t == fb->t) return KeyLoc{fb->layer, fb->member, fb->t, KeyLoc::Kind::data, std::nullopt};
    }
  }
  return std::nullopt;
}

bool KeyIndex::marker_taken(const Document& d, const std::string& id) {
  if (!markers_) {
    auto set = std::make_unique<std::set<std::string, std::less<>>>();
    for (const auto& [comp, tl] : d.timelines()) {
      for (const TMarker& m : tl->markers) set->insert(m.id);
      for (const Bar& b : tl->bars) {
        for (const TMarker& m : b.markers) set->insert(m.id);
      }
    }
    markers_ = std::move(set);
  }
  if (markers_->contains(id)) return true;
  markers_->insert(id);
  return false;
}

// ── ports ────────────────────────────────────────────────────────────────

Json Ports::import_file(const api::ImportFile& /*file*/, const std::string& /*id*/) {
  fail(api::ErrorCode::unsupported, "no media import port is attached to this engine");
}
Json Ports::import_bytes(const api::ImportBytesFile& /*file*/, const std::string& /*id*/) {
  fail(api::ErrorCode::unsupported, "no media import port is attached to this engine");
}
Json Ports::probe_file(const std::string& /*path*/) { return Json::object(); }
Json Ports::read_project(const std::string& /*path*/) {
  fail(api::ErrorCode::unsupported, "no project file port is attached to this engine");
}
std::uint64_t Ports::write_project(const std::string& /*path*/, const Json& /*doc*/) {
  fail(api::ErrorCode::unsupported, "no project file port is attached to this engine");
}
std::uint64_t Ports::write_project_as(const std::string& path, const Json& doc, api::ProjectFormat /*format*/,
                                      const std::string& /*sourceBundle*/) {
  return write_project(path, doc);
}
bool Ports::is_bundle(const std::string& /*path*/) const { return false; }
Ports::Opened Ports::open_project(const std::string& path) {
  Opened o;
  o.doc = read_project(path);
  if (is_bundle(path)) o.footageRoot = path;
  return o;
}

namespace {
std::string base_name(std::string_view path) {
  const std::size_t slash = path.find_last_of("/\\");
  return std::string(slash == std::string_view::npos ? path : path.substr(slash + 1));
}
bool ends_with_ci(std::string_view s, std::string_view suffix) {
  if (s.size() < suffix.size()) return false;
  for (std::size_t i = 0; i < suffix.size(); ++i) {
    char a = s[s.size() - suffix.size() + i];
    if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
    if (a != suffix[i]) return false;
  }
  return true;
}
}  // namespace

Json FakePorts::import_file(const api::ImportFile& file, const std::string& id) {
  const std::string name = base_name(file.path);
  // A file named `undecodable…`: the decode failure the import tests need.
  if (name.find("undecodable") != std::string::npos) fail(api::ErrorCode::io, "cannot decode '" + name + "'");
  const bool audio = ends_with_ci(name, ".wav") || ends_with_ci(name, ".mp3") || ends_with_ci(name, ".aac");
  const bool image = ends_with_ci(name, ".png") || ends_with_ci(name, ".jpg") || ends_with_ci(name, ".jpeg");
  Json a = Json::object();
  a.set("id", Json::string(id));
  a.set("name", Json::string(name));
  a.set("type", Json::string(audio ? "audio" : image ? "image" : "video"));
  a.set("src", Json::string("blob:fake/" + id));
  a.set("size", Json::number(1000));
  Json md = Json::object();
  md.set("width", Json::number(640));
  md.set("height", Json::number(360));
  md.set("duration", Json::number(image ? 0 : 4));
  md.set("fps", Json::number(30));
  md.set("hasAudioTrack", Json::boolean(!image));
  a.set("metadata", std::move(md));
  a.set("path", Json::string(file.path));
  // What the fake collector reads for this file (collect_files).
  fakeFiles_.insert_or_assign(file.path, "fake:" + file.path);
  return a;
}

Json FakePorts::import_bytes(const api::ImportBytesFile& file, const std::string& id) {
  // harness.ts fakePorts.importBytes, field for field.
  if (file.name.find("undecodable") != std::string::npos) fail(api::ErrorCode::io, "cannot decode '" + file.name + "'");
  const bool audio = ends_with_ci(file.name, ".wav") || ends_with_ci(file.name, ".mp3") || ends_with_ci(file.name, ".aac") ||
                     file.mime_type.starts_with("audio/");
  const bool image = ends_with_ci(file.name, ".png") || ends_with_ci(file.name, ".jpg") || ends_with_ci(file.name, ".jpeg") ||
                     file.mime_type.starts_with("image/");
  Json a = Json::object();
  a.set("id", Json::string(id));
  a.set("name", Json::string(file.name));
  a.set("type", Json::string(audio ? "audio" : image ? "image" : "video"));
  a.set("src", Json::string("blob:fake/" + id));
  a.set("size", Json::number(static_cast<double>(file.data.size())));
  Json md = Json::object();
  md.set("width", Json::number(640));
  md.set("height", Json::number(360));
  md.set("duration", Json::number(image ? 0 : 4));
  md.set("fps", Json::number(30));
  md.set("hasAudioTrack", Json::boolean(!image));
  a.set("metadata", std::move(md));
  if (file.origin_path) a.set("path", Json::string(*file.origin_path));
  // What the fake collector reads for this item (collect_files): its bytes, under its src and origin path.
  std::string bytes(file.data.begin(), file.data.end());
  if (file.origin_path) fakeFiles_.insert_or_assign(*file.origin_path, bytes);
  fakeFiles_.insert_or_assign("blob:fake/" + id, std::move(bytes));
  return a;
}

Json FakePorts::probe_file(const std::string& path) {
  Json out = Json::object();
  out.set("name", Json::string(base_name(path)));
  return out;
}

namespace {
/// `<dir>/<hex of the path's bytes>.json` (FakePorts' mirror directory).
std::filesystem::path mirror_file(const std::string& dir, const std::string& path) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string name;
  for (const char c : path) {
    const auto b = static_cast<unsigned char>(c);
    name.push_back(kHex[b >> 4U]);
    name.push_back(kHex[b & 15U]);
  }
  return std::filesystem::path(std::u8string(dir.begin(), dir.end())) / (name + ".json");
}
}  // namespace

Json FakePorts::read_project(const std::string& path) {
  const auto it = files_.find(path);
  if (it != files_.end()) return it->second;
  if (!dir_.empty()) {
    std::ifstream in(mirror_file(dir_, path), std::ios::binary);
    if (in) {
      std::ostringstream ss;
      ss << in.rdbuf();
      if (auto parsed = js::parse(ss.str())) return std::move(*parsed);
    }
  }
  fail(api::ErrorCode::io, "could not read '" + path + "': ENOENT");
}

std::uint64_t FakePorts::write_project(const std::string& path, const Json& doc) {
  files_.insert_or_assign(path, doc);
  const std::string text = js::stringify(doc);
  if (!dir_.empty()) {
    std::ofstream out(mirror_file(dir_, path), std::ios::binary | std::ios::trunc);
    out << text;
  }
  return text.size();
}

// ── collectFiles (collect_files.hpp) ──────────────────────────────────────

CollectOutcome Ports::collect_files(CollectRequest /*req*/) {
  fail(api::ErrorCode::unsupported, "no collect-files port is attached to this engine");
}

/// FakePorts' collector: reads what the fake imported (or add_file), writes into its maps.
class FakeCollectIo final : public CollectIo {
 public:
  explicit FakeCollectIo(FakePorts& p) : p_(p) {}
  bool read(std::string_view ref, const std::string& sourceBundle, std::string& bytes, std::string& why) override {
    std::string key(ref);
    if (ref.starts_with("motion-blob:")) key = sourceBundle + "/blobs/" + std::string(ref.substr(12));
    if (const auto it = p_.fakeFiles_.find(key); it != p_.fakeFiles_.end()) {
      bytes = it->second;
      return true;
    }
    if (const auto it = p_.blobs_.find(key); it != p_.blobs_.end()) {  // an earlier collect's bundle as the source
      bytes = it->second;
      return true;
    }
    why = "no file at '" + std::string(ref) + "'";
    return false;
  }
  std::string normal(const std::string& path) override {
    std::string s;
    const std::u8string u = std::filesystem::path(std::u8string(path.begin(), path.end())).lexically_normal().generic_u8string();
    s.assign(u.begin(), u.end());
    while (s.size() > 1 && s.back() == '/') s.pop_back();
    return s;
  }
  Target target(const std::string& path) override {
    if (p_.registries_.contains(path)) return Target::bundle;
    return p_.files_.contains(path) ? Target::other : Target::absent;
  }
  std::uint64_t put_blob(const std::string& bundle, const std::string& hash, std::string_view bytes) override {
    const auto [it, added] = p_.blobs_.try_emplace(bundle + "/blobs/" + hash, bytes);
    return added ? bytes.size() : 0;
  }
  std::uint64_t write_bundle(const std::string& bundle, const Json& doc, const Json& registry) override {
    p_.registries_.insert_or_assign(bundle, registry);
    return p_.write_project(bundle, doc) + js::stringify(registry).size();
  }

 private:
  FakePorts& p_;
};

CollectOutcome FakePorts::collect_files(CollectRequest req) {
  FakeCollectIo io(*this);
  return doc::collect_files(std::move(req), io);
}

const std::string* FakePorts::blob(const std::string& bundle, const std::string& hash) const {
  const auto it = blobs_.find(bundle + "/blobs/" + hash);
  return it != blobs_.end() ? &it->second : nullptr;
}

Json FakePorts::registry(const std::string& bundle) const {
  const auto it = registries_.find(bundle);
  return it != registries_.end() ? it->second : Json();
}

CollectOutcome FilePorts::collect_files(CollectRequest req) {
  const std::unique_ptr<CollectIo> io = make_disk_collect_io();
  return doc::collect_files(std::move(req), *io);
}

// ── raw file bytes (importProject .aep / .aepx) ──────────────────────────

std::vector<std::uint8_t> Ports::read_file_bytes(const std::string& /*path*/) {
  fail(api::ErrorCode::unsupported, "no file port is attached to this engine");
}

std::vector<std::uint8_t> FakePorts::read_file_bytes(const std::string& path) {
  if (const auto it = fileBytes_.find(path); it != fileBytes_.end()) return it->second;
  if (!dir_.empty()) {
    std::filesystem::path p = mirror_file(dir_, path);
    p.replace_extension(".bin");
    std::ifstream in(p, std::ios::binary);
    if (in) return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
  }
  fail(api::ErrorCode::unsupported, "importing '" + path + "' needs file bytes the test ports do not have");
}

std::vector<std::uint8_t> FilePorts::read_file_bytes(const std::string& path) {
  constexpr std::uintmax_t kMaxBytes = std::uintmax_t{1} << 30U;
  const std::filesystem::path p(std::u8string(path.begin(), path.end()));
  std::error_code ec;
  if (std::filesystem::is_directory(p, ec)) fail(api::ErrorCode::io, "could not read '" + path + "': it is a folder");
  const std::uintmax_t size = std::filesystem::file_size(p, ec);
  if (ec) fail(api::ErrorCode::io, "could not read '" + path + "'");
  if (size > kMaxBytes) fail(api::ErrorCode::io, "could not read '" + path + "': the file is larger than 1 GB");
  std::ifstream in(p, std::ios::binary);
  if (!in) fail(api::ErrorCode::io, "could not read '" + path + "'");
  std::vector<std::uint8_t> out(static_cast<std::size_t>(size));
  in.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(out.size()));
  if (static_cast<std::uintmax_t>(in.gcount()) != size) fail(api::ErrorCode::io, "could not read '" + path + "': short read");
  return out;
}

std::string local_file_url(std::string_view path) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  std::string out = "local-file://";
  if (path.empty() || (path.front() != '/' && path.front() != '\\')) out += '/';
  for (const char ch : path) {
    const auto c = static_cast<unsigned char>(ch == '\\' ? '/' : ch);
    const bool plain = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
                       c == '.' || c == '~' || c == '/' || c == ':';
    if (plain) {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back('%');
      out.push_back(kHex[c >> 4U]);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
      out.push_back(kHex[c & 15U]);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    }
  }
  return out;
}

// ── FilePorts: footage import (session footage never stays a blob:) ────────

namespace {

bool any_suffix(std::string_view name, std::initializer_list<std::string_view> suffixes) {
  return std::any_of(suffixes.begin(), suffixes.end(), [name](std::string_view s) { return ends_with_ci(name, s); });
}

/// assetStore's `type` from a file name (and a MIME type when there is one),
/// for when the probe named none.
std::string footage_type(std::string_view name, std::string_view mime) {
  if (mime.starts_with("audio/")) return "audio";
  if (mime.starts_with("image/")) return "image";
  if (mime.starts_with("video/")) return "video";
  if (any_suffix(name, {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".exr", ".svg", ".avif", ".heic"})) {
    return "image";
  }
  if (any_suffix(name, {".wav", ".mp3", ".aac", ".m4a", ".flac", ".ogg", ".opus", ".aif", ".aiff"})) return "audio";
  return "video";
}

/// The extension to cache bytes under (".bin" when the name has none a decoder could use).
std::string cache_extension(std::string_view name) {
  const std::size_t dot = name.find_last_of('.');
  if (dot == std::string_view::npos || name.size() - dot > 9 || name.find_first_of("/\\", dot) != std::string_view::npos) {
    return ".bin";
  }
  std::string ext(name.substr(dot));
  for (char& c : ext) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.')) return ".bin";
  }
  return ext;
}

std::string utf8_of(const std::filesystem::path& p) {
  const std::u8string s = p.generic_u8string();
  return {s.begin(), s.end()};
}

}  // namespace

Json FilePorts::record_for(const std::string& path, const std::string& name, const std::string& id, std::string_view mime) {
  Json facts = Json::object();
  std::string error;
  if (!probe_ || !probe_(path, facts, error)) fail(api::ErrorCode::io, error.empty() ? "the file could not be read" : error);
  std::error_code ec;
  const auto size = std::filesystem::file_size(std::filesystem::path(std::u8string(path.begin(), path.end())), ec);
  Json a = Json::object();
  a.set("id", Json::string(id));
  a.set("name", Json::string(name));
  a.set("type", facts.at("type").is_string() ? facts.at("type") : Json::string(footage_type(name, mime)));
  a.set("src", Json::string(local_file_url(path)));
  a.set("size", Json::number(ec ? 0.0 : static_cast<double>(size)));
  if (facts.at("metadata").is_object()) a.set("metadata", facts.at("metadata"));
  a.set("path", Json::string(path));
  return a;
}

Json FilePorts::import_file(const api::ImportFile& file, const std::string& id) {
  if (file.path.empty() || is_session_url(file.path) || file.path.starts_with("data:")) {
    fail(api::ErrorCode::invalid_argument, "importFiles takes a file path, not '" + file.path.substr(0, 16) + "…'");
  }
  return record_for(file.path, base_name(file.path), id);
}

Json FilePorts::import_bytes(const api::ImportBytesFile& file, const std::string& id) {
  // Content-addressed: the same bytes imported twice are one cache file.
  const std::string_view bytes(reinterpret_cast<const char*>(file.data.data()), file.data.size());
  std::error_code ec;
  const std::filesystem::path dir = footageDir_.empty()
                                        ? std::filesystem::temp_directory_path(ec) / "premation-session-footage"
                                        : std::filesystem::path(std::u8string(footageDir_.begin(), footageDir_.end()));
  const std::filesystem::path target = dir / (sha256_hex(bytes) + cache_extension(file.name));
  if (!std::filesystem::is_regular_file(target, ec) || std::filesystem::file_size(target, ec) != file.data.size()) {
    write_file_atomic(target, bytes);
  }
  // The probe's type wins; the caller's MIME type only where the probe named none.
  Json a = record_for(utf8_of(target), file.name, id, file.mime_type);
  // The original on disk, when the picker knew it (relink / collect read it); the cache file otherwise.
  if (file.origin_path && !file.origin_path->empty()) a.set("path", Json::string(*file.origin_path));
  return a;
}

Json FilePorts::probe_file(const std::string& path) {
  Json out = Json::object();
  out.set("name", Json::string(base_name(path)));
  std::error_code ec;
  const auto size = std::filesystem::file_size(std::filesystem::path(std::u8string(path.begin(), path.end())), ec);
  if (!ec) out.set("size", Json::number(static_cast<double>(size)));
  Json facts = Json::object();
  std::string error;
  // Relinking to an unreadable file keeps the old facts (the TS port's probe tier `none`).
  if (probe_ && probe_(path, facts, error)) {
    if (facts.at("type").is_string()) out.set("type", facts.at("type"));
    if (facts.at("metadata").is_object()) out.set("metadata", facts.at("metadata"));
  }
  return out;
}

Json FilePorts::read_project(const std::string& path) {
  const std::filesystem::path p(std::u8string(path.begin(), path.end()));
  // A template package carries its document inside a zip (exportMogrt.ts).
  if (is_mogrt_path(path)) return read_mogrt(p);
  std::error_code dirEc;
  // F2: a `.motion` bundle is a directory (bundleCodec.ts `decodeBundle`).
  if (std::filesystem::is_directory(p, dirEc)) return read_bundle(p);
  std::ifstream in(p, std::ios::binary);
  if (!in) fail(api::ErrorCode::io, "could not read '" + path + "'");
  std::ostringstream ss;
  ss << in.rdbuf();
  auto parsed = js::parse(ss.str());
  if (!parsed) fail(api::ErrorCode::io, "could not read '" + path + "': not a project document");
  return std::move(*parsed);
}

std::uint64_t FilePorts::write_project(const std::string& path, const Json& doc) {
  // Temp file + rename: the user's file is never written over (CLAUDE.md).
  const std::string text = js::stringify(doc);
  const std::filesystem::path target(std::u8string(path.begin(), path.end()));
  std::filesystem::path tmp = target;
  tmp += ".premation-tmp";
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    if (!out) fail(api::ErrorCode::io, "could not write '" + path + "'");
    out.write(text.data(), static_cast<std::streamsize>(text.size()));
    if (!out) fail(api::ErrorCode::io, "could not write '" + path + "'");
  }
  std::error_code ec;
  std::filesystem::rename(tmp, target, ec);
  if (ec) {
    std::filesystem::remove(tmp, ec);
    fail(api::ErrorCode::io, "could not write '" + path + "'");
  }
  return text.size();
}

bool FilePorts::is_bundle(const std::string& path) const {
  return is_bundle_dir(std::filesystem::path(std::u8string(path.begin(), path.end())));
}

Ports::Opened FilePorts::open_project(const std::string& path) {
  const std::filesystem::path p(std::u8string(path.begin(), path.end()));
  if (!is_portable_file(p)) return Ports::open_project(path);
  std::error_code ec;
  std::filesystem::path root = staging_.empty() ? std::filesystem::temp_directory_path(ec) / "premation-portable"
                                                : std::filesystem::path(std::u8string(staging_.begin(), staging_.end()));
  // One staging bundle per portable file: blobs are content-addressed, so
  // reopening the same file reuses (and never corrupts) what is there.
  root /= bundle_hash(path);
  PortableOpen r = read_portable(p, root);
  Opened o;
  o.doc = std::move(r.doc);
  const std::u8string u = r.footageRoot.u8string();
  o.footageRoot.assign(u.begin(), u.end());
  o.portable = true;
  o.embedded = r.embedded;
  return o;
}

std::uint64_t FilePorts::write_project_as(const std::string& path, const Json& doc, api::ProjectFormat format,
                                          const std::string& sourceBundle) {
  const std::filesystem::path target(std::u8string(path.begin(), path.end()));
  const std::filesystem::path source(std::u8string(sourceBundle.begin(), sourceBundle.end()));
  std::error_code ec;
  const bool isDir = std::filesystem::is_directory(target, ec);
  switch (format) {
    case api::ProjectFormat::auto_:
      // Keep the target's form: a bundle stays a bundle; everything else is one JSON file.
      return isDir ? write_bundle(target, doc, source) : write_project(path, doc);
    case api::ProjectFormat::json:
      if (isDir) fail(api::ErrorCode::io, "could not write '" + path + "': a folder is there, not a project file");
      return write_project(path, doc);
    case api::ProjectFormat::bundle:
      return write_bundle(target, doc, source);
    case api::ProjectFormat::portable:
      return write_portable(target, doc, source);
  }
  return write_project(path, doc);
}

// ── handler context ──────────────────────────────────────────────────────

std::string HCtx::mint_id(std::string_view prefix) {
  return ids.next(prefix, [this](const std::string& id) { return id_taken(d, id); });
}

std::string HCtx::mint_group_id(std::string_view prefix, const std::function<bool(const std::string&)>& taken) {
  return ids.next(prefix, taken);
}

std::string HCtx::mint_key_id() {
  return ids.next_keyframe([this](const std::string& id) { return keys.has(d, id); });
}

std::string HCtx::mint_marker_id() {
  return ids.next("mk", [this](const std::string& id) { return keys.marker_taken(d, id); });
}

std::string plural(std::size_t n, std::string_view noun) {
  return n == 1 ? std::string(noun) : std::to_string(n) + " " + std::string(noun) + "s";
}

}  // namespace premation::doc
