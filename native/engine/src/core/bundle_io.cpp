#include "bundle_io.hpp"

#include <algorithm>
#include <array>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <system_error>
#include <vector>

#include "fail.hpp"

namespace premation::doc {
namespace fs = std::filesystem;
using js::Json;
using api::ErrorCode;

namespace {

constexpr std::string_view kBlobScheme = "motion-blob:";
constexpr const char* kManifest = "manifest.json";
constexpr const char* kRegistry = "assets/registry.json";
/// types.ts CONTENT_CHUNKS, in manifest order.
constexpr std::array<const char*, 5> kChunks = {"scene.json", "animation.json", "timeline.json", "meta.json", "project.json"};

std::string utf8(const fs::path& p) {
  const std::u8string s = p.u8string();
  return {s.begin(), s.end()};
}

bool read_file(const fs::path& p, std::string& out) {
  std::ifstream in(p, std::ios::binary);
  if (!in) return false;
  std::ostringstream ss;
  ss << in.rdbuf();
  out = ss.str();
  return true;
}

/// A chunk's JSON, or undefined when absent or unparsable (bundleCodec `parseChunk`).
Json read_chunk(const fs::path& dir, const char* name) {
  std::string text;
  if (!read_file(dir / name, text)) return {};
  auto parsed = js::parse(text);
  return parsed ? std::move(*parsed) : Json();
}

bool is_hex_hash(std::string_view h) {
  if (h.size() < 8 || h.size() > 128) return false;
  for (const char c : h) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

/// BlobStore.ts `blobPathFor`.
fs::path blob_path(const fs::path& root, std::string_view hash) {
  return root / "blobs" / std::string(hash.substr(0, 2)) / std::string(hash);
}

/// The hash a `motion-blob:<hash>` string names, or empty.
std::string_view blob_hash(const Json& v) {
  if (!v.is_string()) return {};
  const std::string& s = v.str();
  if (!s.starts_with(kBlobScheme)) return {};
  const std::string_view h = std::string_view(s).substr(kBlobScheme.size());
  return is_hex_hash(h) ? h : std::string_view{};
}

void collect_blob_hashes(const Json& v, std::set<std::string, std::less<>>& out) {
  if (v.is_string()) {
    if (const std::string_view h = blob_hash(v); !h.empty()) out.emplace(h);
    return;
  }
  if (v.is_array()) {
    for (const Json& e : v.arr()) collect_blob_hashes(e, out);
  } else if (v.is_object()) {
    for (const auto& m : v.obj()) collect_blob_hashes(m.value, out);
  }
}

/// The member when present and not undefined (a JS `doc.k !== undefined`).
const Json* defined(const Json& o, std::string_view key) {
  const Json* v = o.find(key);
  return v != nullptr && !v->is_undefined() ? v : nullptr;
}

/// One chunk object with `keys` copied in order, or undefined when none is defined (`isEmptyChunk`).
Json pick(const Json& doc, std::initializer_list<const char*> keys) {
  Json out = Json::object();
  bool any = false;
  for (const char* k : keys) {
    if (const Json* v = defined(doc, k)) {
      out.set(k, *v);
      any = true;
    }
  }
  return any ? out : Json();
}

/// bundleCodec.ts `encodeBundle`: chunk name → text, in CONTENT_CHUNKS order, plus the manifest.
struct Encoded {
  std::vector<std::pair<std::string, std::string>> chunks;  // present content chunks
  Json manifest;
};

Encoded encode(const Json& doc) {
  Encoded e;
  Json scene;
  if (const Json* s = defined(doc, "scene"); s != nullptr && !s->is_null()) {
    scene = *s;
  } else {
    scene = Json::object();
    scene.set("version", Json::string("1.0.0"));
    scene.set("nodes", Json::array());
  }
  Json anim;
  if (const Json* a = defined(doc, "animation"); a != nullptr && !a->is_null()) {
    anim = *a;
  } else {
    anim = Json::object();
    anim.set("tracks", Json::object());
    anim.set("expressions", Json::object());
  }
  e.chunks.emplace_back("scene.json", js::stringify(scene));
  e.chunks.emplace_back("animation.json", js::stringify(anim));
  const Json timeline = pick(doc, {"timelines", "motionBlur", "guides", "colorManagement"});
  if (!timeline.is_undefined()) e.chunks.emplace_back("timeline.json", js::stringify(timeline));
  const Json meta = pick(doc, {"comps", "comp", "swatches", "materials", "transitions"});
  if (!meta.is_undefined()) e.chunks.emplace_back("meta.json", js::stringify(meta));
  const Json project = pick(doc, {"projectItems", "projectSettings", "renderQueue", "plugins", "pluginStorage"});
  if (!project.is_undefined()) e.chunks.emplace_back("project.json", js::stringify(project));

  Json hashes = Json::object();
  for (const auto& [name, text] : e.chunks) hashes.set(name, Json::string(bundle_hash(text)));
  e.manifest = Json::object();
  e.manifest.set("bundleFormat", Json::string("2.0.0"));
  const Json* version = defined(doc, "version");
  e.manifest.set("documentVersion", version != nullptr && !version->is_null() ? *version : Json::string("1.1.0"));
  e.manifest.set("chunks", std::move(hashes));
  return e;
}

/// The registry file, or `{version, assets: []}`.
Json read_registry(const fs::path& root) {
  Json r = read_chunk(root, kRegistry);
  if (!r.is_object() || !r.at("assets").is_array()) {
    r = Json::object();
    r.set("version", Json::string("1.0.0"));
    r.set("assets", Json::array());
  }
  return r;
}

bool same_dir(const fs::path& a, const fs::path& b) {
  if (a.empty() || b.empty()) return false;
  std::error_code ec;
  const bool eq = fs::equivalent(a, b, ec);
  return !ec && eq;
}

/// portableMotion.ts `extForMime`.
std::string ext_for_mime(std::string_view mime) {
  auto has = [mime](std::string_view s) { return mime.find(s) != std::string_view::npos; };
  if (has("png")) return "png";
  if (has("jpeg") || has("jpg")) return "jpg";
  if (has("webp")) return "webp";
  if (has("gif")) return "gif";
  if (has("svg")) return "svg";
  if (has("mp4")) return "mp4";
  if (has("webm")) return "webm";
  if (has("quicktime") || has("mov")) return "mov";
  if (has("mpeg") || has("mp3")) return "mp3";
  if (has("wav")) return "wav";
  return "bin";
}

// ── STORE zip (zip.ts `zipBytes`, byte for byte) ────────────────────────────

void put16(std::string& b, std::uint32_t v) {
  b.push_back(static_cast<char>(v & 0xFFU));
  b.push_back(static_cast<char>((v >> 8U) & 0xFFU));
}
void put32(std::string& b, std::uint32_t v) {
  put16(b, v & 0xFFFFU);
  put16(b, v >> 16U);
}

std::string zip_store(const std::vector<std::pair<std::string, std::string>>& entries) {
  std::string out;
  std::string central;
  for (const auto& [name, data] : entries) {
    if (data.size() >= 0xFFFFFFFFULL || name.size() > 0xFFFFU) fail(ErrorCode::io, "a portable .motion entry is too large for a zip");
    const std::uint32_t crc = zip_crc32(data);
    const auto size = static_cast<std::uint32_t>(data.size());
    const auto offset = static_cast<std::uint32_t>(out.size());
    const auto nameLen = static_cast<std::uint32_t>(name.size());
    put32(out, 0x04034b50U);
    put16(out, 20);
    put16(out, 0);
    put16(out, 0);
    put16(out, 0);
    put16(out, 0);
    put32(out, crc);
    put32(out, size);
    put32(out, size);
    put16(out, nameLen);
    put16(out, 0);
    out += name;
    out += data;

    put32(central, 0x02014b50U);
    put16(central, 20);
    put16(central, 20);
    put16(central, 0);
    put16(central, 0);
    put16(central, 0);
    put16(central, 0);
    put32(central, crc);
    put32(central, size);
    put32(central, size);
    put16(central, nameLen);
    put16(central, 0);
    put16(central, 0);
    put16(central, 0);
    put16(central, 0);
    put32(central, 0);
    put32(central, offset);
    central += name;
  }
  if (out.size() + central.size() >= 0xFFFFFFFFULL || entries.size() > 0xFFFFU) {
    fail(ErrorCode::io, "a portable .motion is too large for a zip");
  }
  const auto centralOffset = static_cast<std::uint32_t>(out.size());
  const auto centralSize = static_cast<std::uint32_t>(central.size());
  out += central;
  put32(out, 0x06054b50U);
  put16(out, 0);
  put16(out, 0);
  put16(out, static_cast<std::uint32_t>(entries.size()));
  put16(out, static_cast<std::uint32_t>(entries.size()));
  put32(out, centralSize);
  put32(out, centralOffset);
  put16(out, 0);
  return out;
}

}  // namespace

std::string bundle_hash(std::string_view s) {
  std::uint64_t h = 0xcbf29ce484222325ULL;
  constexpr std::uint64_t kPrime = 0x100000001b3ULL;
  auto unit = [&h](std::uint32_t u) {
    h = (h ^ (u & 0xFFU)) * kPrime;
    h = (h ^ ((u >> 8U) & 0xFFU)) * kPrime;
  };
  std::size_t i = 0;
  while (i < s.size()) {
    const auto b0 = static_cast<unsigned char>(s[i]);
    std::uint32_t cp = 0xFFFD;
    std::size_t n = 1;
    if (b0 < 0x80U) {
      cp = b0;
    } else if ((b0 >> 5U) == 0x6U && i + 1 < s.size()) {
      cp = ((b0 & 0x1FU) << 6U) | (static_cast<unsigned char>(s[i + 1]) & 0x3FU);
      n = 2;
    } else if ((b0 >> 4U) == 0xEU && i + 2 < s.size()) {
      cp = ((b0 & 0x0FU) << 12U) | ((static_cast<unsigned char>(s[i + 1]) & 0x3FU) << 6U) |
           (static_cast<unsigned char>(s[i + 2]) & 0x3FU);
      n = 3;
    } else if ((b0 >> 3U) == 0x1EU && i + 3 < s.size()) {
      cp = ((b0 & 0x07U) << 18U) | ((static_cast<unsigned char>(s[i + 1]) & 0x3FU) << 12U) |
           ((static_cast<unsigned char>(s[i + 2]) & 0x3FU) << 6U) | (static_cast<unsigned char>(s[i + 3]) & 0x3FU);
      n = 4;
    }
    i += n;
    if (cp >= 0x10000U) {
      const std::uint32_t v = cp - 0x10000U;
      unit(0xD800U + (v >> 10U));
      unit(0xDC00U + (v & 0x3FFU));
    } else {
      unit(cp);
    }
  }
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out(16, '0');
  for (int k = 15; k >= 0; --k) {
    out[static_cast<std::size_t>(k)] = kHex[h & 0xFU];
    h >>= 4U;
  }
  return out;
}

std::uint32_t zip_crc32(std::string_view bytes) {
  static const std::array<std::uint32_t, 256> table = [] {
    std::array<std::uint32_t, 256> t{};
    for (std::uint32_t n = 0; n < 256; ++n) {
      std::uint32_t c = n;
      for (int k = 0; k < 8; ++k) c = (c & 1U) != 0 ? 0xEDB88320U ^ (c >> 1U) : c >> 1U;
      t[n] = c;
    }
    return t;
  }();
  std::uint32_t c = 0xFFFFFFFFU;
  for (const char ch : bytes) c = table[(c ^ static_cast<unsigned char>(ch)) & 0xFFU] ^ (c >> 8U);
  return c ^ 0xFFFFFFFFU;
}

bool is_bundle_dir(const fs::path& dir) {
  std::error_code ec;
  return fs::is_directory(dir, ec) && fs::is_regular_file(dir / kManifest, ec);
}

void write_file_atomic(const fs::path& target, std::string_view bytes) {
  std::error_code ec;
  if (target.has_parent_path()) fs::create_directories(target.parent_path(), ec);
  fs::path tmp = target;
  tmp += ".premation-tmp";
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    if (!out) fail(ErrorCode::io, "could not write '" + utf8(target) + "'");
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    out.flush();
    if (!out) {
      out.close();
      fs::remove(tmp, ec);
      fail(ErrorCode::io, "could not write '" + utf8(target) + "'");
    }
  }
  fs::rename(tmp, target, ec);
  if (ec) {
    fs::remove(tmp, ec);
    fail(ErrorCode::io, "could not write '" + utf8(target) + "'");
  }
}

Json read_bundle(const fs::path& dir) {
  const Json manifest = read_chunk(dir, kManifest);
  if (!manifest.is_object()) fail(ErrorCode::io, "could not read '" + utf8(dir) + "': not a .motion bundle (no manifest.json)");
  Json doc = Json::object();
  doc.set("version", manifest.at("documentVersion").is_undefined() || manifest.at("documentVersion").is_null()
                         ? Json::string("1.1.0")
                         : manifest.at("documentVersion"));
  Json scene = read_chunk(dir, "scene.json");
  if (scene.is_undefined() || scene.is_null()) {
    scene = Json::object();
    scene.set("version", Json::string("1.0.0"));
    scene.set("nodes", Json::array());
  }
  doc.set("scene", std::move(scene));
  Json anim = read_chunk(dir, "animation.json");
  if (anim.is_undefined() || anim.is_null()) {
    anim = Json::object();
    anim.set("tracks", Json::object());
    anim.set("expressions", Json::object());
  }
  doc.set("animation", std::move(anim));
  // decodeBundle copies a field only when it is truthy: an object or array is.
  auto lift = [&doc](const Json& chunk, std::initializer_list<const char*> keys) {
    if (!chunk.is_object()) return;
    for (const char* k : keys) {
      const Json& v = chunk.at(k);
      const bool truthy = v.is_object() || v.is_array() || (v.is_string() && !v.str().empty()) ||
                          (v.is_number() && v.num() != 0 && v.num() == v.num()) || v.b();
      if (truthy) {
        doc.set(k, v);
      }
    }
  };
  lift(read_chunk(dir, "timeline.json"), {"timelines", "motionBlur", "guides", "colorManagement"});
  lift(read_chunk(dir, "meta.json"), {"comps", "comp", "swatches", "materials", "transitions"});
  lift(read_chunk(dir, "project.json"), {"projectItems", "projectSettings", "renderQueue", "plugins", "pluginStorage"});
  return doc;
}

std::uint64_t write_bundle(const fs::path& dir, const Json& doc, const fs::path& source) {
  std::error_code ec;
  if (fs::exists(dir, ec) && !fs::is_directory(dir, ec)) {
    fail(ErrorCode::io, "could not write '" + utf8(dir) + "': a file is there, not a .motion bundle");
  }
  fs::create_directories(dir, ec);
  if (!fs::is_directory(dir, ec)) fail(ErrorCode::io, "could not write '" + utf8(dir) + "'");
  std::uint64_t written = 0;

  // ── collect: footage first, so the chunks never name bytes the bundle lacks ──
  std::set<std::string, std::less<>> hashes;
  collect_blob_hashes(doc, hashes);
  if (!hashes.empty() && !source.empty() && !same_dir(source, dir)) {
    std::vector<std::string> copied;
    for (const std::string& h : hashes) {
      const fs::path to = blob_path(dir, h);
      if (fs::exists(to, ec)) continue;
      const fs::path from = blob_path(source, h);
      std::string bytes;
      if (!read_file(from, bytes)) continue;  // not in the source either: the ref stays, as the page leaves a dead one
      write_file_atomic(to, bytes);
      written += bytes.size();
      copied.push_back(h);
    }
    if (!copied.empty()) {
      // The rows the page's Assets panel is rebuilt from (restoreBundleAssets).
      Json target = read_registry(dir);
      const Json from = read_registry(source);
      std::set<std::string, std::less<>> ids;
      for (const Json& r : target.at("assets").arr()) {
        if (r.at("id").is_string()) ids.insert(r.at("id").str());
      }
      bool changed = false;
      for (const Json& r : from.at("assets").arr()) {
        if (!r.at("hash").is_string() || !r.at("id").is_string()) continue;
        if (std::find(copied.begin(), copied.end(), r.at("hash").str()) == copied.end()) continue;
        if (!ids.insert(r.at("id").str()).second) continue;
        target.find_mut("assets")->arr_mut().push_back(r);
        changed = true;
      }
      if (changed) {
        const std::string text = js::stringify(target);
        write_file_atomic(dir / kRegistry, text);
        written += text.size();
      }
    }
  }

  // ── chunks: only the changed ones, then the manifest last ──
  const Encoded e = encode(doc);
  const Json prev = read_chunk(dir, kManifest);
  const Json& prevChunks = prev.is_object() ? prev.at("chunks") : Json();
  for (const auto& [name, text] : e.chunks) {
    const Json& old = prevChunks.at(name);
    if (old.is_string() && old.str() == e.manifest.at("chunks").at(name).str() && fs::is_regular_file(dir / name, ec)) continue;
    write_file_atomic(dir / name, text);
    written += text.size();
  }
  for (const char* name : kChunks) {
    const bool now = e.manifest.at("chunks").has(name);
    if (!now && prevChunks.is_object() && prevChunks.has(name)) fs::remove(dir / name, ec);
  }
  const std::string manifest = js::stringify(e.manifest);
  write_file_atomic(dir / kManifest, manifest);
  written += manifest.size();
  return written;
}

std::uint64_t write_portable(const fs::path& file, const Json& doc, const fs::path& source) {
  std::error_code ec;
  if (fs::is_directory(file, ec)) fail(ErrorCode::io, "could not write '" + utf8(file) + "': a folder is there");
  Json packed = doc;
  const Json registry = source.empty() ? Json() : read_registry(source);
  auto mime_of = [&registry](std::string_view hash) -> std::string {
    if (!registry.is_object()) return "application/octet-stream";
    for (const Json& r : registry.at("assets").arr()) {
      if (r.at("hash").is_string() && r.at("hash").str() == hash && r.at("mime").is_string()) return r.at("mime").str();
    }
    return "application/octet-stream";
  };

  struct Asset {
    std::string fileName;
    std::string mime;
    std::string bytes;
    Json nodeIds = Json::array();
  };
  std::vector<Asset> assets;
  std::map<std::string, std::size_t, std::less<>> byHash;
  std::set<std::string, std::less<>> usedNames;
  Json* nodes = packed.find_mut("scene") != nullptr ? packed.find_mut("scene")->find_mut("nodes") : nullptr;
  if (nodes != nullptr && nodes->is_array() && !source.empty()) {
    for (Json& node : nodes->arr_mut()) {
      const std::string id = node.at("id").is_string() ? node.at("id").str() : std::string("asset");
      Json* comps = node.find_mut("components");
      if (comps == nullptr || !comps->is_array()) continue;
      for (Json& c : comps->arr_mut()) {
        Json* props = c.find_mut("props");
        if (props == nullptr || !props->is_object()) continue;
        Json* src = props->find_mut("src");
        if (src == nullptr) continue;
        const std::string hash(blob_hash(*src));
        if (hash.empty()) continue;
        auto it = byHash.find(hash);
        if (it == byHash.end()) {
          std::string bytes;
          if (!read_file(blob_path(source, hash), bytes)) continue;  // unreachable: left for relink
          Asset a;
          a.mime = mime_of(hash);
          const std::string ext = ext_for_mime(a.mime);
          a.fileName = id + "." + ext;
          for (int n = 2; usedNames.contains(a.fileName); ++n) a.fileName = id + "-" + std::to_string(n) + "." + ext;
          usedNames.insert(a.fileName);
          a.bytes = std::move(bytes);
          assets.push_back(std::move(a));
          it = byHash.emplace(hash, assets.size() - 1).first;
        }
        Asset& a = assets[it->second];
        bool listed = false;
        for (const Json& n : a.nodeIds.arr()) listed = listed || (n.is_string() && n.str() == id);
        if (!listed) a.nodeIds.arr_mut().push_back(Json::string(id));
        *src = Json::string("assets/" + a.fileName);
      }
    }
  }

  const Encoded e = encode(packed);
  std::vector<std::pair<std::string, std::string>> entries = e.chunks;
  entries.emplace_back(kManifest, js::stringify(e.manifest));
  for (const Asset& a : assets) entries.emplace_back("assets/" + a.fileName, a.bytes);
  if (!assets.empty()) {
    Json rows = Json::array();
    for (const Asset& a : assets) {
      Json r = Json::object();
      r.set("fileName", Json::string(a.fileName));
      r.set("mime", Json::string(a.mime));
      r.set("size", Json::number(static_cast<double>(a.bytes.size())));
      r.set("nodeIds", a.nodeIds);
      rows.arr_mut().push_back(std::move(r));
    }
    Json reg = Json::object();
    reg.set("version", Json::string("1.0.0"));
    reg.set("assets", std::move(rows));
    entries.emplace_back(kRegistry, js::stringify(reg));
  }
  const std::string zip = zip_store(entries);
  write_file_atomic(file, zip);
  return zip.size();
}

}  // namespace premation::doc
