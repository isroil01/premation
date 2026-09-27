#include "bundle_io.hpp"

#include <algorithm>
#include <array>
#include <fstream>
#include <map>
#include <optional>
#include <span>
#include <set>
#include <sstream>
#include <system_error>
#include <vector>

#include "deflate.hpp"
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

namespace {

/// bundleCodec.ts `decodeBundle` over any chunk source (a directory, a zip's entries).
template <class ChunkFn>
Json decode_chunks(const Json& manifest, ChunkFn&& chunk) {
  Json doc = Json::object();
  doc.set("version", manifest.at("documentVersion").is_undefined() || manifest.at("documentVersion").is_null()
                         ? Json::string("1.1.0")
                         : manifest.at("documentVersion"));
  Json scene = chunk("scene.json");
  if (scene.is_undefined() || scene.is_null()) {
    scene = Json::object();
    scene.set("version", Json::string("1.0.0"));
    scene.set("nodes", Json::array());
  }
  doc.set("scene", std::move(scene));
  Json anim = chunk("animation.json");
  if (anim.is_undefined() || anim.is_null()) {
    anim = Json::object();
    anim.set("tracks", Json::object());
    anim.set("expressions", Json::object());
  }
  doc.set("animation", std::move(anim));
  // decodeBundle copies a field only when it is truthy: an object or array is.
  auto lift = [&doc](const Json& c, std::initializer_list<const char*> keys) {
    if (!c.is_object()) return;
    for (const char* k : keys) {
      const Json& v = c.at(k);
      const bool truthy = v.is_object() || v.is_array() || (v.is_string() && !v.str().empty()) ||
                          (v.is_number() && v.num() != 0 && v.num() == v.num()) || v.b();
      if (truthy) {
        doc.set(k, v);
      }
    }
  };
  lift(chunk("timeline.json"), {"timelines", "motionBlur", "guides", "colorManagement"});
  lift(chunk("meta.json"), {"comps", "comp", "swatches", "materials", "transitions"});
  lift(chunk("project.json"), {"projectItems", "projectSettings", "renderQueue", "plugins", "pluginStorage"});
  return doc;
}

}  // namespace

Json read_bundle(const fs::path& dir) {
  const Json manifest = read_chunk(dir, kManifest);
  if (!manifest.is_object()) fail(ErrorCode::io, "could not read '" + utf8(dir) + "': not a .motion bundle (no manifest.json)");
  return decode_chunks(manifest, [&dir](const char* name) { return read_chunk(dir, name); });
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

// ── opening a portable `.motion` (portableMotion.ts `unpackPortableMotion`) ──

namespace {

std::uint32_t rd16(std::string_view z, std::size_t o) {
  return static_cast<std::uint32_t>(static_cast<unsigned char>(z[o])) |
         (static_cast<std::uint32_t>(static_cast<unsigned char>(z[o + 1])) << 8U);
}
std::uint32_t rd32(std::string_view z, std::size_t o) { return rd16(z, o) | (rd16(z, o + 2) << 16U); }

/// Every file entry of a zip (name → bytes) through its central directory.
/// Premation writes STORE (zip.ts `zipBytes`); a DEFLATE entry (method 8 — the
/// zip was repacked by another tool, as fflate's `unzipSync` reads it in the
/// page) is inflated to exactly its declared size. Any other method is refused.
std::map<std::string, std::string, std::less<>> unzip_entries(std::string_view z, const std::string& what) {
  auto bad = [&what](const std::string& why) { fail(ErrorCode::io, "could not read '" + what + "': " + why); };
  if (z.size() < 22) bad("not a zip");
  // End of central directory: the last signature within the 64 KiB comment window.
  std::size_t eocd = std::string_view::npos;
  const std::size_t floor = z.size() > 22 + 0xFFFFU ? z.size() - 22 - 0xFFFFU : 0;
  for (std::size_t o = z.size() - 22;; --o) {
    if (rd32(z, o) == 0x06054b50U) {
      eocd = o;
      break;
    }
    if (o == floor) break;
  }
  if (eocd == std::string_view::npos) bad("the zip has no central directory");
  const std::uint32_t count = rd16(z, eocd + 10);
  std::size_t c = rd32(z, eocd + 16);
  std::map<std::string, std::string, std::less<>> out;
  for (std::uint32_t i = 0; i < count; ++i) {
    if (c + 46 > z.size() || rd32(z, c) != 0x02014b50U) bad("the zip's central directory is damaged");
    const std::uint32_t method = rd16(z, c + 10);
    const std::uint32_t crc = rd32(z, c + 16);
    const std::uint32_t csize = rd32(z, c + 20);
    const std::uint32_t usize = rd32(z, c + 24);
    const std::uint32_t nameLen = rd16(z, c + 28);
    const std::uint32_t extraLen = rd16(z, c + 30);
    const std::uint32_t commentLen = rd16(z, c + 32);
    const std::size_t local = rd32(z, c + 42);
    if (c + 46 + nameLen > z.size()) bad("the zip's central directory is damaged");
    std::string name(z.substr(c + 46, nameLen));
    c += 46 + nameLen + extraLen + commentLen;
    if (name.empty() || name.back() == '/') continue;  // a folder entry
    if (local + 30 > z.size() || rd32(z, local) != 0x04034b50U) bad("the zip entry '" + name + "' is damaged");
    const std::size_t data = local + 30 + rd16(z, local + 26) + rd16(z, local + 28);
    if (data + csize > z.size()) bad("the zip entry '" + name + "' is truncated");
    if (method != 0 && method != 8) bad("'" + name + "' uses an unsupported compression method");
    std::string bytes;
    if (method == 8) {
      std::vector<std::uint8_t> raw;
      const auto* p = reinterpret_cast<const std::uint8_t*>(z.data() + data);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes as bytes
      if (!zlib::inflate_raw(std::span<const std::uint8_t>(p, csize), usize, raw)) {
        bad("the zip entry '" + name + "' is corrupt (it does not inflate to its size)");
      }
      bytes.assign(raw.begin(), raw.end());
    } else {
      bytes.assign(z.substr(data, csize));
    }
    if (zip_crc32(bytes) != crc) bad("the zip entry '" + name + "' is corrupt (CRC mismatch)");
    out.insert_or_assign(std::move(name), std::move(bytes));
  }
  return out;
}

// SHA-256 (FIPS 180-4) — BlobStore's content address (contentHash.ts `sha256Hex`).
struct Sha256 {
  std::array<std::uint32_t, 8> h{0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
                                 0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U};
  static std::uint32_t rotr(std::uint32_t x, unsigned n) { return (x >> n) | (x << (32U - n)); }
  void block(const unsigned char* p) {
    static constexpr std::array<std::uint32_t, 64> k = {
        0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
        0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
        0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
        0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
        0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
        0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
        0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
        0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};
    std::array<std::uint32_t, 64> w{};
    for (std::size_t i = 0; i < 16; ++i) {
      w[i] = (static_cast<std::uint32_t>(p[i * 4]) << 24U) | (static_cast<std::uint32_t>(p[i * 4 + 1]) << 16U) |
             (static_cast<std::uint32_t>(p[i * 4 + 2]) << 8U) | static_cast<std::uint32_t>(p[i * 4 + 3]);
    }
    for (std::size_t i = 16; i < 64; ++i) {
      const std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3U);
      const std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10U);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    std::array<std::uint32_t, 8> v = h;
    for (std::size_t i = 0; i < 64; ++i) {
      const std::uint32_t s1 = rotr(v[4], 6) ^ rotr(v[4], 11) ^ rotr(v[4], 25);
      const std::uint32_t ch = (v[4] & v[5]) ^ (~v[4] & v[6]);
      const std::uint32_t t1 = v[7] + s1 + ch + k[i] + w[i];
      const std::uint32_t s0 = rotr(v[0], 2) ^ rotr(v[0], 13) ^ rotr(v[0], 22);
      const std::uint32_t maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
      const std::uint32_t t2 = s0 + maj;
      v[7] = v[6];
      v[6] = v[5];
      v[5] = v[4];
      v[4] = v[3] + t1;
      v[3] = v[2];
      v[2] = v[1];
      v[1] = v[0];
      v[0] = t1 + t2;
    }
    for (std::size_t i = 0; i < 8; ++i) h[i] += v[i];
  }
};

}  // namespace

std::string sha256_hex(std::string_view bytes) {
  Sha256 s;
  const auto* p = reinterpret_cast<const unsigned char*>(bytes.data());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): byte view
  std::size_t n = bytes.size();
  std::size_t off = 0;
  for (; n - off >= 64; off += 64) s.block(p + off);
  std::array<unsigned char, 128> tail{};
  const std::size_t rest = n - off;
  std::copy_n(p + off, rest, tail.begin());
  tail[rest] = 0x80U;
  const std::size_t total = rest + 9 <= 64 ? 64 : 128;
  const std::uint64_t bits = static_cast<std::uint64_t>(n) * 8U;
  for (std::size_t i = 0; i < 8; ++i) tail[total - 1 - i] = static_cast<unsigned char>((bits >> (8U * i)) & 0xFFU);
  s.block(tail.data());
  if (total == 128) s.block(tail.data() + 64);
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (const std::uint32_t word : s.h) {
    for (int sh = 28; sh >= 0; sh -= 4) out.push_back(kHex[(word >> static_cast<unsigned>(sh)) & 0xFU]);
  }
  return out;
}

bool is_mogrt_path(std::string_view path) {
  std::string lower(path);
  for (char& ch : lower) {
    if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
  }
  return lower.ends_with(".mogrt") || lower.ends_with(".mogrt.zip");
}

Json read_mogrt(const fs::path& file) {
  const std::string what = utf8(file);
  std::string zip;
  if (!read_file(file, zip)) fail(ErrorCode::io, "could not read '" + what + "'");
  const auto entries = unzip_entries(zip, what);
  const auto it = entries.find("package.json");
  if (it == entries.end()) fail(ErrorCode::io, "could not read '" + what + "': it is not a Premation template package");
  const std::optional<Json> pkg = js::parse(it->second);
  if (!pkg || !pkg->is_object() || !pkg->at("format").is_string() || pkg->at("format").str() != "premation-mogrt-v1") {
    fail(ErrorCode::io, "could not read '" + what + "': it is not a premation-mogrt-v1 package");
  }
  if (!pkg->at("document").is_object()) fail(ErrorCode::io, "could not read '" + what + "': the package carries no document");
  return pkg->at("document");
}

bool is_portable_file(const fs::path& file) {
  std::error_code ec;
  if (!fs::is_regular_file(file, ec)) return false;
  std::ifstream in(file, std::ios::binary);
  std::array<char, 2> magic{};
  in.read(magic.data(), 2);
  return in.gcount() == 2 && magic[0] == 'P' && magic[1] == 'K';
}

PortableOpen read_portable(const fs::path& file, const fs::path& staging) {
  const std::string what = utf8(file);
  std::string zip;
  if (!read_file(file, zip)) fail(ErrorCode::io, "could not read '" + what + "'");
  auto entries = unzip_entries(zip, what);
  zip.clear();
  zip.shrink_to_fit();

  // A wrapping folder (`project.motion/manifest.json`) is unwrapped, as the page does.
  std::string root;
  if (!entries.contains(kManifest) && !entries.contains("scene.json")) {
    const auto it = std::find_if(entries.begin(), entries.end(), [](const auto& e) {
      return e.first.size() > 13 && e.first.ends_with(std::string("/") + kManifest);
    });
    if (it == entries.end()) fail(ErrorCode::io, "could not read '" + what + "': the zip is not a Premation project");
    root = it->first.substr(0, it->first.size() - std::string_view(kManifest).size());
  }
  auto entry = [&entries, &root](std::string_view name) -> const std::string* {
    const auto it = entries.find(root + std::string(name));
    return it == entries.end() ? nullptr : &it->second;
  };
  auto chunk = [&entry](const char* name) -> Json {
    const std::string* text = entry(name);
    if (text == nullptr) return {};
    auto parsed = js::parse(*text);
    return parsed ? std::move(*parsed) : Json();
  };
  Json manifest = chunk(kManifest);
  if (!manifest.is_object()) manifest = Json::object();  // scene.json alone: decodeBundle's defaults
  PortableOpen out;
  out.doc = decode_chunks(manifest, chunk);

  // The packed registry names each file's MIME (the page's unpack drops it; the engine keeps it).
  std::map<std::string, std::string, std::less<>> mimeOf;
  if (const Json reg = chunk(kRegistry); reg.is_object()) {
    for (const Json& r : reg.at("assets").arr()) {
      if (r.at("fileName").is_string() && r.at("mime").is_string()) mimeOf.emplace(r.at("fileName").str(), r.at("mime").str());
    }
  }

  // Footage: `assets/<file>` → blobs/<hh>/<sha256> in the staging bundle, and
  // every component `src` naming it → `motion-blob:<sha256>` (what a bundle
  // holds, so a later Save As bundle collects it like any bundle footage).
  struct Staged {
    std::string hash;
    std::string mime;
    std::size_t size = 0;
    std::string id;
  };
  std::map<std::string, Staged, std::less<>> staged;  // "assets/<file>" → blob
  const std::string assetsPrefix = root + "assets/";
  for (auto& [name, bytes] : entries) {
    if (!name.starts_with(assetsPrefix) || name == root + kRegistry) continue;
    const std::string fileName = name.substr(assetsPrefix.size());
    if (fileName.empty() || fileName.find('/') != std::string::npos) continue;
    Staged s;
    s.hash = sha256_hex(bytes);
    s.size = bytes.size();
    const auto m = mimeOf.find(fileName);
    s.mime = m != mimeOf.end() ? m->second : "application/octet-stream";
    const fs::path to = blob_path(staging, s.hash);
    std::error_code ec;
    if (!fs::is_regular_file(to, ec) || fs::file_size(to, ec) != bytes.size()) write_file_atomic(to, bytes);
    bytes.clear();
    bytes.shrink_to_fit();
    staged.emplace("assets/" + fileName, std::move(s));
  }

  std::map<std::string, std::string, std::less<>> names;  // hash → a display name
  Json* nodes = out.doc.find_mut("scene") != nullptr ? out.doc.find_mut("scene")->find_mut("nodes") : nullptr;
  if (nodes != nullptr && nodes->is_array()) {
    for (Json& node : nodes->arr_mut()) {
      Json* comps = node.find_mut("components");
      if (comps == nullptr || !comps->is_array()) continue;
      for (Json& c : comps->arr_mut()) {
        Json* props = c.find_mut("props");
        if (props == nullptr || !props->is_object()) continue;
        Json* src = props->find_mut("src");
        if (src == nullptr || !src->is_string()) continue;
        const auto it = staged.find(src->str());
        if (it == staged.end()) continue;
        names.try_emplace(it->second.hash, src->str().substr(7));
        if (it->second.id.empty()) {
          if (const Json& aid = props->at("assetId"); aid.is_string() && !aid.str().empty()) it->second.id = aid.str();
        }
        *src = Json::string(std::string(kBlobScheme) + it->second.hash);
      }
    }
  }

  // The staging bundle's registry: one row per referenced blob (restoreBundleAssets' rows).
  Json registry = Json::object();
  registry.set("version", Json::string("1.0.0"));
  Json rows = Json::array();
  std::set<std::string, std::less<>> seen;
  for (const auto& [packed, s] : staged) {
    if (!names.contains(s.hash)) continue;  // nothing points at it: a leftover, as the page drops it
    const std::string id = s.id.empty() ? "asset_" + s.hash.substr(0, 12) : s.id;
    if (!seen.insert(id).second) continue;
    const std::string& mime = s.mime;
    const char* type = mime.starts_with("image/")   ? "image"
                       : mime.starts_with("video/") ? "video"
                       : mime.starts_with("audio/") ? "audio"
                       : mime == "application/json" ? "json"
                       : mime.find("font") != std::string::npos ? "font"
                                                                : "other";
    Json r = Json::object();
    r.set("id", Json::string(id));
    r.set("hash", Json::string(s.hash));
    r.set("name", Json::string(names.at(s.hash)));
    r.set("type", Json::string(type));
    r.set("mime", Json::string(mime));
    r.set("size", Json::number(static_cast<double>(s.size)));
    rows.arr_mut().push_back(std::move(r));
    ++out.embedded;
  }
  registry.set("assets", std::move(rows));
  write_file_atomic(staging / kRegistry, js::stringify(registry));
  out.footageRoot = staging;
  return out;
}

}  // namespace premation::doc
