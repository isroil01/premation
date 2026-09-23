#include "engine_ctx.hpp"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>

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
Json Ports::probe_file(const std::string& /*path*/) { return Json::object(); }
Json Ports::read_project(const std::string& /*path*/) {
  fail(api::ErrorCode::unsupported, "no project file port is attached to this engine");
}
std::uint64_t Ports::write_project(const std::string& /*path*/, const Json& /*doc*/) {
  fail(api::ErrorCode::unsupported, "no project file port is attached to this engine");
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

Json FilePorts::read_project(const std::string& path) {
  std::ifstream in(std::filesystem::path(std::u8string(path.begin(), path.end())), std::ios::binary);
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
