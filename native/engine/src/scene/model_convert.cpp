// The model normalizer's dispatch, the GLB writer the non-glTF loaders feed,
// and the glTF repacker (model_convert.hpp).
#include "model_convert.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <set>

#include "json.hpp"
#include "native_effects.hpp"
#include "png_write.hpp"

namespace premation::scene::modelio {
namespace {

using js::Json;

constexpr std::uint32_t kGlbMagic = 0x46546c67;  // 'glTF'
constexpr std::uint32_t kChunkJson = 0x4e4f534a;
constexpr std::uint32_t kChunkBin = 0x004e4942;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

std::string lower(std::string_view s) {
  std::string o(s);
  std::ranges::transform(o, o.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return o;
}

std::string norm_slashes(std::string_view p) {
  std::string o(p);
  std::ranges::replace(o, '\\', '/');
  return o;
}

/// Collapse `a/./b`, `a/b/../c` and leading `./` (the editor's normalizeRelPath).
std::string normalize_rel(std::string_view p) {
  std::vector<std::string> out;
  std::string seg;
  const std::string s = norm_slashes(p) + "/";
  for (const char c : s) {
    if (c != '/') {
      seg.push_back(c);
      continue;
    }
    if (seg.empty() || seg == ".") {
      // skip
    } else if (seg == "..") {
      if (!out.empty()) out.pop_back();
    } else {
      out.push_back(seg);
    }
    seg.clear();
  }
  std::string j;
  for (std::size_t i = 0; i < out.size(); ++i) j += (i != 0 ? "/" : "") + out[i];
  return lower(j);
}

std::string dir_of(std::string_view p) {
  const std::string s = norm_slashes(p);
  const auto at = s.rfind('/');
  return at == std::string::npos ? std::string() : s.substr(0, at);
}

std::string base_of(std::string_view p) {
  const std::string s = norm_slashes(p);
  const auto at = s.rfind('/');
  return at == std::string::npos ? s : s.substr(at + 1);
}

std::string url_decode(std::string_view s) {
  std::string o;
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1])) != 0 &&
        std::isxdigit(static_cast<unsigned char>(s[i + 2])) != 0) {
      o.push_back(static_cast<char>(std::stoi(std::string(s.substr(i + 1, 2)), nullptr, 16)));
      i += 2;
    } else {
      o.push_back(s[i]);
    }
  }
  return o;
}

std::string ext_of(std::string_view p) {
  const std::string b = base_of(p);
  const auto at = b.rfind('.');
  return at == std::string::npos ? std::string() : lower(b.substr(at));
}

std::uint32_t u32le(std::span<const std::uint8_t> b, std::size_t o) {
  if (o + 4 > b.size()) throw ConvertError("the model file is truncated");
  std::uint32_t v = 0;
  std::memcpy(&v, b.subspan(o, 4).data(), 4);
  return v;
}

void put_u32(std::vector<std::uint8_t>& out, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>((v >> (8U * static_cast<unsigned>(i))) & 0xFFU));
}

/// A GLB container from a JSON document and its binary chunk.
std::vector<std::uint8_t> pack_glb(const Json& doc, std::vector<std::uint8_t> bin) {
  std::string json = js::stringify(doc);
  while (json.size() % 4 != 0) json.push_back(' ');
  while (bin.size() % 4 != 0) bin.push_back(0);
  std::vector<std::uint8_t> out;
  const std::size_t total = 12 + 8 + json.size() + (bin.empty() ? 0 : 8 + bin.size());
  if (total > 0xFFFFFFFFULL) throw ConvertError("the model is larger than a GLB can hold (4 GB)");
  out.reserve(total);
  put_u32(out, kGlbMagic);
  put_u32(out, 2);
  put_u32(out, static_cast<std::uint32_t>(total));
  put_u32(out, static_cast<std::uint32_t>(json.size()));
  put_u32(out, kChunkJson);
  out.insert(out.end(), json.begin(), json.end());
  if (!bin.empty()) {
    put_u32(out, static_cast<std::uint32_t>(bin.size()));
    put_u32(out, kChunkBin);
    out.insert(out.end(), bin.begin(), bin.end());
  }
  return out;
}

Json num(double v) { return Json::number(v); }

Json num_array(std::span<const double> v) {
  Json a = Json::array();
  for (const double x : v) a.arr_mut().push_back(num(x));
  return a;
}

/// The binary chunk being built: views appended 4-byte aligned.
struct BinBuilder {
  std::vector<std::uint8_t> bin;
  Json views = Json::array();
  /// Append `bytes` as a buffer view; returns its index.
  std::size_t view(std::span<const std::uint8_t> bytes, std::optional<double> target = std::nullopt) {
    while (bin.size() % 4 != 0) bin.push_back(0);
    Json v = Json::object();
    v.set("buffer", num(0));
    v.set("byteOffset", num(static_cast<double>(bin.size())));
    v.set("byteLength", num(static_cast<double>(bytes.size())));
    if (target) v.set("target", num(*target));
    bin.insert(bin.end(), bytes.begin(), bytes.end());
    views.arr_mut().push_back(std::move(v));
    return views.arr().size() - 1;
  }
};

template <class T>
std::span<const std::uint8_t> as_bytes_of(const std::vector<T>& v) {
  return {reinterpret_cast<const std::uint8_t*>(v.data()), v.size() * sizeof(T)};  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

/// A float accessor over `values` (`comps` per element), with min/max when asked.
Json float_accessor(BinBuilder& b, const std::vector<float>& values, std::size_t comps, std::string_view type, bool minmax,
                    std::optional<double> target = 34962) {
  Json a = Json::object();
  a.set("bufferView", num(static_cast<double>(b.view(as_bytes_of(values), target))));
  a.set("componentType", num(5126));
  a.set("count", num(static_cast<double>(comps == 0 ? 0 : values.size() / comps)));
  a.set("type", Json::string(std::string(type)));
  if (minmax && comps > 0 && values.size() >= comps) {
    std::vector<double> mn(comps, std::numeric_limits<double>::infinity());
    std::vector<double> mx(comps, -std::numeric_limits<double>::infinity());
    for (std::size_t i = 0; i < values.size(); ++i) {
      mn[i % comps] = std::min(mn[i % comps], static_cast<double>(values[i]));
      mx[i % comps] = std::max(mx[i % comps], static_cast<double>(values[i]));
    }
    a.set("min", num_array(mn));
    a.set("max", num_array(mx));
  }
  return a;
}

Json index_accessor(BinBuilder& b, const std::vector<std::uint32_t>& indices) {
  Json a = Json::object();
  a.set("bufferView", num(static_cast<double>(b.view(as_bytes_of(indices), 34963))));
  a.set("componentType", num(5125));
  a.set("count", num(static_cast<double>(indices.size())));
  a.set("type", Json::string("SCALAR"));
  return a;
}

std::size_t comps_of(const std::string& type) {
  if (type == "SCALAR") return 1;
  if (type == "VEC2") return 2;
  if (type == "VEC3") return 3;
  if (type == "VEC4") return 4;
  if (type == "MAT2") return 4;
  if (type == "MAT3") return 9;
  if (type == "MAT4") return 16;
  return 0;
}

std::size_t comp_bytes(double t) {
  if (t == 5120 || t == 5121) return 1;
  if (t == 5122 || t == 5123) return 2;
  if (t == 5125 || t == 5126) return 4;
  return 0;
}

/// A glTF component as a double (normalized integers mapped as the spec says).
double read_component(std::span<const std::uint8_t> s, std::size_t at, double type, bool normalized) {
  const std::size_t n = comp_bytes(type);
  if (n == 0 || at + n > s.size()) return 0;
  const std::span<const std::uint8_t> p = s.subspan(at, n);
  if (type == 5126) {
    float f = 0;
    std::memcpy(&f, p.data(), 4);
    return static_cast<double>(f);
  }
  if (type == 5125) {
    std::uint32_t v = 0;
    std::memcpy(&v, p.data(), 4);
    return static_cast<double>(v);
  }
  if (type == 5123) {
    std::uint16_t v = 0;
    std::memcpy(&v, p.data(), 2);
    return normalized ? v / 65535.0 : static_cast<double>(v);
  }
  if (type == 5122) {
    std::int16_t v = 0;
    std::memcpy(&v, p.data(), 2);
    return normalized ? std::max(v / 32767.0, -1.0) : static_cast<double>(v);
  }
  if (type == 5121) return normalized ? p[0] / 255.0 : static_cast<double>(p[0]);
  const auto v = static_cast<std::int8_t>(p[0]);
  return normalized ? std::max(v / 127.0, -1.0) : static_cast<double>(v);
}

// ── the glTF repacker ───────────────────────────────────────────────────────

class Repacker {
 public:
  Repacker(const FileSet& files, std::vector<std::string>& warnings) : files_(files), warnings_(warnings) {}

  std::vector<std::uint8_t> run() {
    load_document();
    load_buffers();
    decode_meshopt_views();
    decode_draco_primitives();
    rewrite_accessors();
    rewrite_images();
    strip_extensions();
    Json buffers = Json::array();
    Json buf = Json::object();
    buf.set("byteLength", num(static_cast<double>(out_.bin.size())));
    buffers.arr_mut().push_back(std::move(buf));
    g_.set("buffers", std::move(buffers));
    g_.set("bufferViews", std::move(out_.views));
    return pack_glb(g_, std::move(out_.bin));
  }

 private:
  void load_document() {
    const SourceFile& m = files_.model();
    const std::span<const std::uint8_t> data(m.bytes);
    if (data.size() >= 12 && u32le(data, 0) == kGlbMagic) {
      if (u32le(data, 4) != 2) throw ConvertError("GLB version " + std::to_string(u32le(data, 4)) + " — only glTF 2.0 is supported");
      std::size_t off = 12;
      while (off + 8 <= data.size()) {
        const std::uint32_t len = u32le(data, off);
        const std::uint32_t type = u32le(data, off + 4);
        if (off + 8 + std::size_t{len} > data.size()) throw ConvertError("the GLB is truncated");
        if (type == kChunkJson) {
          const std::string_view text(reinterpret_cast<const char*>(data.subspan(off + 8, len).data()), len);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
          auto j = js::parse(text);
          if (!j) throw ConvertError("the GLB's JSON chunk does not parse");
          g_ = std::move(*j);
        } else if (type == kChunkBin) {
          glbBin_.assign(data.begin() + static_cast<std::ptrdiff_t>(off + 8),
                         data.begin() + static_cast<std::ptrdiff_t>(off + 8 + len));
          hasGlbBin_ = true;
        }
        off += 8 + std::size_t{len};
      }
      if (!g_.is_object()) throw ConvertError("the GLB has no JSON chunk");
    } else {
      const std::string_view text(reinterpret_cast<const char*>(data.data()), data.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
      auto j = js::parse(text);
      if (!j || !j->is_object()) throw ConvertError("the .gltf is not glTF JSON");
      g_ = std::move(*j);
    }
    const Json& asset = g_.at("asset");
    const std::string version = asset.at("version").is_string() ? asset.at("version").str() : "";
    if (!version.starts_with("2")) throw ConvertError("glTF " + (version.empty() ? std::string("1.x") : version) + " — only glTF 2.0 is supported");
    // Required extensions this normalizer does not decode.
    static const std::set<std::string, std::less<>> kKnown = {
        "KHR_texture_transform", "KHR_materials_emissive_strength", "KHR_mesh_quantization", "EXT_meshopt_compression",
        "KHR_meshopt_compression", "KHR_draco_mesh_compression", "KHR_texture_basisu", "KHR_materials_unlit",
        "KHR_materials_transmission", "KHR_materials_ior", "KHR_materials_specular", "KHR_materials_clearcoat",
        "KHR_materials_volume", "KHR_materials_sheen", "KHR_texture_webp", "EXT_texture_webp"};
    std::vector<std::string> unknown;
    for (const Json& e : g_.at("extensionsRequired").arr()) {
      if (e.is_string() && !kKnown.contains(e.str())) unknown.push_back(e.str());
    }
    if (!unknown.empty()) {
      std::string l;
      for (std::size_t i = 0; i < unknown.size(); ++i) l += (i != 0 ? ", " : "") + unknown[i];
      throw ConvertError("This model needs " + l + ", which the importer does not read.");
    }
  }

  std::vector<std::uint8_t> bytes_of_uri(const std::string& uri, const std::string& what) {
    if (uri.starts_with("data:")) {
      const auto comma = uri.find(',');
      if (comma == std::string::npos) throw ConvertError(what + ": malformed data: URI");
      if (uri.substr(0, comma).find(";base64") != std::string::npos) {
        std::string clean;
        for (const char c : std::string_view(uri).substr(comma + 1)) {
          if (std::isspace(static_cast<unsigned char>(c)) == 0) clean.push_back(c);
        }
        auto b = doc::native_unbase64(clean);
        if (!b) throw ConvertError(what + ": the data: URI does not decode");
        return std::move(*b);
      }
      const std::string body = url_decode(std::string_view(uri).substr(comma + 1));
      return {body.begin(), body.end()};
    }
    if (const SourceFile* f = files_.find(uri)) return f->bytes;
    throw ConvertError("This .gltf keeps " + what + " in “" + uri +
                       "”, which was not in the selection. Select the .gltf together with its .bin and texture files, "
                       "or import a single .glb.");
  }

  void load_buffers() {
    const auto& bufs = g_.at("buffers").arr();
    for (std::size_t i = 0; i < bufs.size(); ++i) {
      const Json& b = bufs[i];
      const Json& uri = b.at("uri");
      // A meshopt fallback buffer may carry no data at all: its views are all compressed.
      const bool fallbackOnly = b.at("extensions").at("EXT_meshopt_compression").at("fallback").is_bool() ||
                                b.at("extensions").at("KHR_meshopt_compression").at("fallback").is_bool();
      if (!uri.is_string()) {
        if (hasGlbBin_ && i == 0) {
          buffers_.push_back(glbBin_);
        } else if (fallbackOnly) {
          buffers_.emplace_back();
        } else {
          throw ConvertError("buffer " + std::to_string(i) + " has no data (no URI and no GLB binary chunk)");
        }
        continue;
      }
      if (fallbackOnly && !uri.str().starts_with("data:") && files_.find(uri.str()) == nullptr) {
        buffers_.emplace_back();
        continue;
      }
      buffers_.push_back(bytes_of_uri(uri.str(), "buffer " + std::to_string(i)));
    }
  }

  /// The bytes of buffer view `vi` (decoded when it was compressed).
  [[nodiscard]] std::span<const std::uint8_t> view_bytes(std::size_t vi) const {
    if (const auto it = decodedViews_.find(vi); it != decodedViews_.end()) return it->second;
    const auto& views = g_.at("bufferViews").arr();
    if (vi >= views.size()) throw ConvertError("missing bufferView " + std::to_string(vi));
    const Json& v = views[vi];
    const double bi = v.at("buffer").is_number() ? v.at("buffer").num() : -1;
    if (!(bi >= 0 && static_cast<std::size_t>(bi) < buffers_.size())) throw ConvertError("bufferView " + std::to_string(vi) + " names a missing buffer");
    const std::vector<std::uint8_t>& b = buffers_[static_cast<std::size_t>(bi)];
    const auto off = static_cast<std::size_t>(v.at("byteOffset").is_number() ? v.at("byteOffset").num() : 0);
    const auto len = static_cast<std::size_t>(v.at("byteLength").is_number() ? v.at("byteLength").num() : 0);
    if (off + len > b.size()) throw ConvertError("bufferView " + std::to_string(vi) + " reaches past its buffer");
    return std::span(b).subspan(off, len);
  }

  void decode_meshopt_views() {
    const auto& views = g_.at("bufferViews").arr();
    for (std::size_t vi = 0; vi < views.size(); ++vi) {
      const Json& v = views[vi];
      const Json* ext = v.at("extensions").find("EXT_meshopt_compression");
      if (ext == nullptr) ext = v.at("extensions").find("KHR_meshopt_compression");
      if (ext == nullptr || !ext->is_object()) continue;
      const Json& e = *ext;
      const double bi = e.at("buffer").num();
      if (!(bi >= 0 && static_cast<std::size_t>(bi) < buffers_.size())) throw ConvertError("a meshopt view names a missing buffer");
      const std::vector<std::uint8_t>& b = buffers_[static_cast<std::size_t>(bi)];
      const auto off = static_cast<std::size_t>(e.at("byteOffset").is_number() ? e.at("byteOffset").num() : 0);
      const auto len = static_cast<std::size_t>(e.at("byteLength").num());
      const auto stride = static_cast<std::size_t>(e.at("byteStride").num());
      const auto count = static_cast<std::size_t>(e.at("count").num());
      if (off + len > b.size() || stride == 0) throw ConvertError("a meshopt view reaches past its buffer");
      const std::string mode = e.at("mode").is_string() ? e.at("mode").str() : "ATTRIBUTES";
      const std::string filter = e.at("filter").is_string() ? e.at("filter").str() : "NONE";
      std::vector<std::uint8_t> out;
      if (!decode_meshopt(std::span(b).subspan(off, len), count, stride, mode, filter, out)) {
        throw ConvertError("a meshopt-compressed buffer view does not decode (mode " + mode + ")");
      }
      decodedViews_.emplace(vi, std::move(out));
    }
  }

  void decode_draco_primitives() {
    auto& meshes = g_.find_mut("meshes") != nullptr ? g_.find_mut("meshes")->arr_mut() : emptyArr_;
    for (Json& mesh : meshes) {
      Json* prims = mesh.find_mut("primitives");
      if (prims == nullptr) continue;
      for (Json& p : prims->arr_mut()) {
        const Json* ext = p.at("extensions").find("KHR_draco_mesh_compression");
        if (ext == nullptr || !ext->is_object()) continue;
        if (!draco_available()) {
          throw ConvertError("This model's geometry is Draco-compressed and this build has no Draco decoder. "
                             "Re-export it without compression, or use a build with the Draco codec.");
        }
        const auto vi = static_cast<std::size_t>(ext->at("bufferView").num());
        DracoMesh dm;
        std::string err;
        if (!decode_draco(view_bytes(vi), dm, err)) throw ConvertError("Draco geometry does not decode: " + err);
        const Json& attrMap = ext->at("attributes");
        for (const Json::Member& m : p.at("attributes").obj()) {
          const Json& id = attrMap.at(m.key);
          if (!id.is_number() || !m.value.is_number()) continue;
          const auto uid = static_cast<std::uint32_t>(id.num());
          const auto it = std::ranges::find_if(dm.attributes, [uid](const DracoMesh::Attribute& a) { return a.uniqueId == uid; });
          if (it == dm.attributes.end()) throw ConvertError("Draco geometry lacks attribute " + m.key);
          accessorOverride_[static_cast<std::size_t>(m.value.num())] = Override{it->values, static_cast<std::size_t>(it->components), false};
        }
        if (p.at("indices").is_number()) {
          std::vector<float> idx(dm.indices.begin(), dm.indices.end());
          // Indices up to 2^24 are exact in a float; the rewrite converts back to uint32.
          accessorOverride_[static_cast<std::size_t>(p.at("indices").num())] = Override{std::move(idx), 1, true};
        }
        p.find_mut("extensions")->erase("KHR_draco_mesh_compression");
      }
    }
  }

  struct Override {
    std::vector<float> values;
    std::size_t comps = 0;
    bool indices = false;
  };

  /// Read accessor `ai` to doubles (sparse applied, normalized mapped).
  [[nodiscard]] std::vector<double> read_accessor(std::size_t ai, std::size_t& comps) const {
    const auto& accs = g_.at("accessors").arr();
    const Json& a = accs[ai];
    const std::string type = a.at("type").is_string() ? a.at("type").str() : "";
    comps = comps_of(type);
    const double ct = a.at("componentType").is_number() ? a.at("componentType").num() : kNaN;
    const std::size_t cb = comp_bytes(ct);
    if (comps == 0 || cb == 0) throw ConvertError("accessor " + std::to_string(ai) + " has an unsupported type");
    const auto count = static_cast<std::size_t>(std::max(0.0, a.at("count").is_number() ? a.at("count").num() : 0));
    const bool normalized = a.at("normalized").is_bool() && a.at("normalized").b();
    std::vector<double> out(count * comps, 0);
    if (a.at("bufferView").is_number()) {
      const auto vi = static_cast<std::size_t>(a.at("bufferView").num());
      const std::span<const std::uint8_t> bytes = view_bytes(vi);
      const Json& v = g_.at("bufferViews").arr()[vi];
      const std::size_t elem = comps * cb;
      // Matrices of 1- / 2-byte components pad each column to 4 bytes (the spec's alignment rule).
      const double stride = v.at("byteStride").is_number() && v.at("byteStride").num() > 0 ? v.at("byteStride").num() : static_cast<double>(elem);
      const auto base = static_cast<std::size_t>(a.at("byteOffset").is_number() ? a.at("byteOffset").num() : 0);
      for (std::size_t e = 0; e < count; ++e) {
        const std::size_t at = base + e * static_cast<std::size_t>(stride);
        for (std::size_t c = 0; c < comps; ++c) out[e * comps + c] = read_component(bytes, at + c * cb, ct, normalized);
      }
    }
    const Json& sp = a.at("sparse");
    if (sp.is_object() && sp.at("count").is_number() && sp.at("count").num() > 0) {
      const double ict = sp.at("indices").at("componentType").num();
      const auto ib = view_bytes(static_cast<std::size_t>(sp.at("indices").at("bufferView").num()));
      const auto vb = view_bytes(static_cast<std::size_t>(sp.at("values").at("bufferView").num()));
      const auto io = static_cast<std::size_t>(sp.at("indices").at("byteOffset").is_number() ? sp.at("indices").at("byteOffset").num() : 0);
      const auto vo = static_cast<std::size_t>(sp.at("values").at("byteOffset").is_number() ? sp.at("values").at("byteOffset").num() : 0);
      const auto n = static_cast<std::size_t>(sp.at("count").num());
      for (std::size_t s = 0; s < n; ++s) {
        const auto t = static_cast<std::size_t>(read_component(ib, io + s * comp_bytes(ict), ict, false));
        if (t >= count) continue;
        for (std::size_t c = 0; c < comps; ++c) out[t * comps + c] = read_component(vb, vo + (s * comps + c) * cb, ct, normalized);
      }
    }
    return out;
  }

  /// Which accessors are indices, joints (kept as u16) — the rest become floats.
  void classify(std::set<std::size_t>& indices, std::set<std::size_t>& joints) const {
    for (const Json& mesh : g_.at("meshes").arr()) {
      for (const Json& p : mesh.at("primitives").arr()) {
        if (p.at("indices").is_number()) indices.insert(static_cast<std::size_t>(p.at("indices").num()));
        for (const Json::Member& m : p.at("attributes").obj()) {
          if (m.key.starts_with("JOINTS_") && m.value.is_number()) joints.insert(static_cast<std::size_t>(m.value.num()));
        }
      }
    }
  }

  void rewrite_accessors() {
    Json* accsP = g_.find_mut("accessors");
    if (accsP == nullptr) return;
    std::set<std::size_t> indexAccs;
    std::set<std::size_t> jointAccs;
    classify(indexAccs, jointAccs);
    // POSITION accessors need min / max (the glTF rule the editor's fit reads).
    std::set<std::size_t> positions;
    for (const Json& mesh : g_.at("meshes").arr()) {
      for (const Json& p : mesh.at("primitives").arr()) {
        if (p.at("attributes").at("POSITION").is_number()) positions.insert(static_cast<std::size_t>(p.at("attributes").at("POSITION").num()));
        for (const Json& t : p.at("targets").arr()) {
          if (t.at("POSITION").is_number()) positions.insert(static_cast<std::size_t>(t.at("POSITION").num()));
        }
      }
    }
    Json::Array& accs = accsP->arr_mut();
    for (std::size_t ai = 0; ai < accs.size(); ++ai) {
      Json& a = accs[ai];
      std::size_t comps = 0;
      std::vector<double> values;
      if (const auto it = accessorOverride_.find(ai); it != accessorOverride_.end()) {
        comps = it->second.comps;
        values.assign(it->second.values.begin(), it->second.values.end());
      } else {
        values = read_accessor(ai, comps);
      }
      const std::string type = a.at("type").is_string() ? a.at("type").str() : "SCALAR";
      Json na = Json::object();
      if (a.at("name").is_string()) na.set("name", a.at("name"));
      if (indexAccs.contains(ai)) {
        std::vector<std::uint32_t> idx(values.size());
        for (std::size_t i = 0; i < values.size(); ++i) idx[i] = static_cast<std::uint32_t>(std::max(0.0, values[i]));
        na.set("bufferView", num(static_cast<double>(out_.view(as_bytes_of(idx), 34963))));
        na.set("componentType", num(5125));
      } else if (jointAccs.contains(ai)) {
        std::vector<std::uint16_t> j(values.size());
        for (std::size_t i = 0; i < values.size(); ++i) j[i] = static_cast<std::uint16_t>(std::max(0.0, std::min(65535.0, values[i])));
        // u16 VEC4 elements are 8 bytes: already 4-aligned.
        na.set("bufferView", num(static_cast<double>(out_.view(as_bytes_of(j), 34962))));
        na.set("componentType", num(5123));
      } else {
        std::vector<float> f(values.size());
        for (std::size_t i = 0; i < values.size(); ++i) f[i] = static_cast<float>(values[i]);
        na.set("bufferView", num(static_cast<double>(out_.view(as_bytes_of(f)))));
        na.set("componentType", num(5126));
      }
      const std::size_t count = comps == 0 ? 0 : values.size() / comps;
      na.set("count", num(static_cast<double>(count)));
      na.set("type", Json::string(type));
      if (positions.contains(ai) && comps == 3 && count > 0) {
        std::array<double, 3> mn{1e300, 1e300, 1e300};
        std::array<double, 3> mx{-1e300, -1e300, -1e300};
        for (std::size_t i = 0; i < count * 3; ++i) {
          mn.at(i % 3) = std::min(mn.at(i % 3), static_cast<double>(static_cast<float>(values[i])));
          mx.at(i % 3) = std::max(mx.at(i % 3), static_cast<double>(static_cast<float>(values[i])));
        }
        na.set("min", num_array(mn));
        na.set("max", num_array(mx));
      } else if (a.at("min").is_array() && a.at("max").is_array() && !(a.at("normalized").is_bool() && a.at("normalized").b()) &&
                 a.at("componentType").is_number() && a.at("componentType").num() == 5126) {
        na.set("min", a.at("min"));
        na.set("max", a.at("max"));
      }
      a = std::move(na);
    }
  }

  void rewrite_images() {
    Json* imgsP = g_.find_mut("images");
    // KTX2 / Basis textures: each texture's basisu source, transcoded, becomes its plain source.
    Json* texsP = g_.find_mut("textures");
    std::map<std::size_t, std::vector<std::uint8_t>> pngOf;  // image index → transcoded PNG
    if (texsP != nullptr) {
      for (Json& t : texsP->arr_mut()) {
        for (const char* key : {"KHR_texture_basisu", "EXT_texture_webp", "KHR_texture_webp"}) {
          const Json* ext = t.at("extensions").find(key);
          if (ext == nullptr || !ext->at("source").is_number()) continue;
          const auto src = static_cast<std::size_t>(ext->at("source").num());
          if (std::string_view(key) == "KHR_texture_basisu") {
            if (!pngOf.contains(src)) {
              if (!ktx_available()) {
                if (t.at("source").is_number()) {  // a plain fallback image exists: use it
                  warnings_.emplace_back("KTX2 textures were replaced by their PNG / JPEG fallbacks (no KTX2 transcoder in this build).");
                  break;
                }
                throw ConvertError("This model's textures are KTX2 / Basis and this build has no KTX2 transcoder. "
                                   "Re-export with PNG or JPEG textures, or use a build with libktx.");
              }
              std::vector<std::uint8_t> rgba;
              std::uint32_t w = 0;
              std::uint32_t h = 0;
              std::string err;
              if (!decode_ktx2(image_bytes(src), rgba, w, h, err)) throw ConvertError("a KTX2 texture does not transcode: " + err);
              std::vector<std::uint8_t> png;
              if (!exporter::encode_png_rgba8(rgba, w, h, png)) throw ConvertError("a transcoded KTX2 texture could not be re-encoded");
              pngOf.emplace(src, std::move(png));
            }
            t.set("source", num(static_cast<double>(src)));
          } else if (!t.at("source").is_number()) {
            t.set("source", num(static_cast<double>(src)));  // a WebP-only texture: the renderer's decoder reads WebP
          }
          if (Json* e = t.find_mut("extensions")) e->erase(key);
        }
      }
    }
    if (imgsP == nullptr) return;
    Json::Array& imgs = imgsP->arr_mut();
    for (std::size_t i = 0; i < imgs.size(); ++i) {
      Json& im = imgs[i];
      std::vector<std::uint8_t> bytes;
      std::string mime = im.at("mimeType").is_string() ? im.at("mimeType").str() : "";
      if (const auto it = pngOf.find(i); it != pngOf.end()) {
        bytes = it->second;
        mime = "image/png";
      } else {
        bytes = image_bytes(i);
        if (mime.empty()) mime = sniff_mime(bytes, im.at("uri").is_string() ? im.at("uri").str() : "");
      }
      Json ni = Json::object();
      if (im.at("name").is_string()) ni.set("name", im.at("name"));
      ni.set("bufferView", num(static_cast<double>(out_.view(bytes))));
      ni.set("mimeType", Json::string(mime));
      im = std::move(ni);
    }
  }

  [[nodiscard]] std::vector<std::uint8_t> image_bytes(std::size_t i) {
    const auto& imgs = g_.at("images").arr();
    if (i >= imgs.size()) throw ConvertError("missing image " + std::to_string(i));
    const Json& im = imgs[i];
    if (im.at("bufferView").is_number()) {
      const auto b = view_bytes(static_cast<std::size_t>(im.at("bufferView").num()));
      return {b.begin(), b.end()};
    }
    if (im.at("uri").is_string()) return bytes_of_uri(im.at("uri").str(), "image " + std::to_string(i));
    throw ConvertError("image " + std::to_string(i) + " has no data");
  }

  static std::string sniff_mime(std::span<const std::uint8_t> b, const std::string& uri) {
    if (b.size() >= 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
    if (b.size() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
    if (b.size() >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E') return "image/webp";
    const std::string e = ext_of(uri);
    if (e == ".jpg" || e == ".jpeg") return "image/jpeg";
    if (e == ".webp") return "image/webp";
    return "image/png";
  }

  void strip_extensions() {
    static const std::set<std::string, std::less<>> kDecoded = {"KHR_mesh_quantization", "EXT_meshopt_compression", "KHR_meshopt_compression",
                                                                "KHR_draco_mesh_compression", "KHR_texture_basisu", "EXT_texture_webp",
                                                                "KHR_texture_webp"};
    for (const char* list : {"extensionsUsed", "extensionsRequired"}) {
      Json* l = g_.find_mut(list);
      if (l == nullptr) continue;
      Json next = Json::array();
      for (const Json& e : l->arr()) {
        if (e.is_string() && !kDecoded.contains(e.str())) next.arr_mut().push_back(e);
      }
      if (next.arr().empty()) g_.erase(list);
      else *l = std::move(next);
    }
    if (Json* views = g_.find_mut("bufferViews")) (void)views;  // replaced wholesale by the caller
  }

  const FileSet& files_;
  std::vector<std::string>& warnings_;
  Json g_;
  std::vector<std::uint8_t> glbBin_;
  bool hasGlbBin_ = false;
  std::vector<std::vector<std::uint8_t>> buffers_;
  std::map<std::size_t, std::vector<std::uint8_t>> decodedViews_;
  std::map<std::size_t, Override> accessorOverride_;
  BinBuilder out_;
  Json::Array emptyArr_;
};

}  // namespace

// ── FileSet ─────────────────────────────────────────────────────────────────

const SourceFile& FileSet::model() const {
  if (files_.empty()) throw ConvertError("no model file given");
  return files_.front();
}

const SourceFile* FileSet::find(std::string_view uriIn) const {
  const std::string uri = url_decode(uriIn);
  if (uri.empty()) return nullptr;
  const std::string dir = dir_of(model().path);
  const std::string want = normalize_rel(dir.empty() ? uri : dir + "/" + uri);
  for (const SourceFile& f : files_) {
    if (normalize_rel(f.path) == want) return &f;
  }
  // Then by the path relative to nothing (a flat selection keeps sub-folder names in the URI).
  const std::string rel = normalize_rel(uri);
  for (const SourceFile& f : files_) {
    const std::string p = normalize_rel(f.path);
    if (p == rel || p.ends_with("/" + rel)) return &f;
  }
  // Last: by bare name, first writer wins.
  const std::string name = lower(base_of(uri));
  for (const SourceFile& f : files_) {
    if (lower(base_of(f.path)) == name) return &f;
  }
  return nullptr;
}

// ── the GLB writer ──────────────────────────────────────────────────────────

std::vector<std::uint8_t> write_glb(const SceneModel& scene) {
  BinBuilder b;
  Json doc = Json::object();
  Json asset = Json::object();
  asset.set("version", Json::string("2.0"));
  asset.set("generator", Json::string("Premation model importer"));
  doc.set("asset", std::move(asset));
  std::set<std::string> used;

  Json images = Json::array();
  Json textures = Json::array();
  for (const TextureDef& t : scene.textures) {
    Json im = Json::object();
    im.set("bufferView", num(static_cast<double>(b.view(t.bytes))));
    im.set("mimeType", Json::string(t.mimeType));
    images.arr_mut().push_back(std::move(im));
    Json tx = Json::object();
    tx.set("source", num(static_cast<double>(images.arr().size() - 1)));
    tx.set("sampler", num(0));
    textures.arr_mut().push_back(std::move(tx));
  }
  const auto texRef = [](int index) {
    Json r = Json::object();
    r.set("index", num(index));
    return r;
  };
  Json materials = Json::array();
  for (const MaterialDef& m : scene.materials) {
    Json mj = Json::object();
    mj.set("name", Json::string(m.name));
    Json pbr = Json::object();
    pbr.set("baseColorFactor", num_array(m.baseColor));
    if (m.baseColorTexture >= 0) pbr.set("baseColorTexture", texRef(m.baseColorTexture));
    pbr.set("metallicFactor", num(std::max(0.0, std::min(1.0, m.metallic))));
    pbr.set("roughnessFactor", num(std::max(0.0, std::min(1.0, m.roughness))));
    mj.set("pbrMetallicRoughness", std::move(pbr));
    if (m.emissive[0] > 0 || m.emissive[1] > 0 || m.emissive[2] > 0 || m.emissiveTexture >= 0) {
      const double peak = std::max({m.emissive[0], m.emissive[1], m.emissive[2], 1.0});
      const std::array<double, 3> e = {m.emissive[0] / peak, m.emissive[1] / peak, m.emissive[2] / peak};
      mj.set("emissiveFactor", num_array(m.emissiveTexture >= 0 && peak <= 1 && e[0] + e[1] + e[2] == 0 ? std::array<double, 3>{1, 1, 1} : e));
      if (m.emissiveTexture >= 0) mj.set("emissiveTexture", texRef(m.emissiveTexture));
      if (peak > 1) {
        Json ext = mj.at("extensions").is_object() ? mj.at("extensions") : Json::object();
        Json es = Json::object();
        es.set("emissiveStrength", num(peak));
        ext.set("KHR_materials_emissive_strength", std::move(es));
        mj.set("extensions", std::move(ext));
        used.insert("KHR_materials_emissive_strength");
      }
    }
    if (m.normalTexture >= 0) mj.set("normalTexture", texRef(m.normalTexture));
    if (m.doubleSided) mj.set("doubleSided", Json::boolean(true));
    if (m.alphaMode != "OPAQUE") {
      mj.set("alphaMode", Json::string(m.alphaMode));
      if (m.alphaMode == "MASK") mj.set("alphaCutoff", num(m.alphaCutoff));
    }
    const auto addExt = [&](const char* name, Json v) {
      Json ext = mj.at("extensions").is_object() ? mj.at("extensions") : Json::object();
      ext.set(name, std::move(v));
      mj.set("extensions", std::move(ext));
      used.insert(name);
    };
    if (m.transmission > 0) {
      Json t = Json::object();
      t.set("transmissionFactor", num(std::min(1.0, m.transmission)));
      addExt("KHR_materials_transmission", std::move(t));
    }
    if (std::abs(m.ior - 1.5) > 1e-6) {
      Json t = Json::object();
      t.set("ior", num(m.ior));
      addExt("KHR_materials_ior", std::move(t));
    }
    if (m.unlit) addExt("KHR_materials_unlit", Json::object());
    materials.arr_mut().push_back(std::move(mj));
  }

  Json meshes = Json::array();
  Json accessors = Json::array();
  for (const MeshDef& m : scene.meshes) {
    Json mj = Json::object();
    mj.set("name", Json::string(m.name));
    Json prims = Json::array();
    for (const PrimitiveDef& p : m.primitives) {
      if (p.positions.size() < 9 || p.indices.empty()) continue;
      Json attrs = Json::object();
      const auto push = [&](Json a) {
        accessors.arr_mut().push_back(std::move(a));
        return num(static_cast<double>(accessors.arr().size() - 1));
      };
      attrs.set("POSITION", push(float_accessor(b, p.positions, 3, "VEC3", true)));
      if (p.normals.size() == p.positions.size()) attrs.set("NORMAL", push(float_accessor(b, p.normals, 3, "VEC3", false)));
      if (p.uvs.size() / 2 == p.positions.size() / 3) attrs.set("TEXCOORD_0", push(float_accessor(b, p.uvs, 2, "VEC2", false)));
      if (p.colors.size() / 4 == p.positions.size() / 3) attrs.set("COLOR_0", push(float_accessor(b, p.colors, 4, "VEC4", false)));
      Json pj = Json::object();
      pj.set("attributes", std::move(attrs));
      pj.set("indices", push(index_accessor(b, p.indices)));
      if (p.material >= 0) pj.set("material", num(p.material));
      pj.set("mode", num(4));
      prims.arr_mut().push_back(std::move(pj));
    }
    mj.set("primitives", std::move(prims));
    meshes.arr_mut().push_back(std::move(mj));
  }

  Json nodes = Json::array();
  for (const NodeDef& n : scene.nodes) {
    Json nj = Json::object();
    if (!n.name.empty()) nj.set("name", Json::string(n.name));
    if (n.translation != std::array<double, 3>{0, 0, 0}) nj.set("translation", num_array(n.translation));
    if (n.rotation != std::array<double, 4>{0, 0, 0, 1}) nj.set("rotation", num_array(n.rotation));
    if (n.scale != std::array<double, 3>{1, 1, 1}) nj.set("scale", num_array(n.scale));
    if (n.mesh >= 0) nj.set("mesh", num(n.mesh));
    if (!n.children.empty()) {
      Json c = Json::array();
      for (const int ch : n.children) c.arr_mut().push_back(num(ch));
      nj.set("children", std::move(c));
    }
    nodes.arr_mut().push_back(std::move(nj));
  }
  Json sceneJ = Json::object();
  Json roots = Json::array();
  for (const int r : scene.roots) roots.arr_mut().push_back(num(r));
  sceneJ.set("nodes", std::move(roots));
  Json scenes = Json::array();
  scenes.arr_mut().push_back(std::move(sceneJ));

  if (!used.empty()) {
    Json u = Json::array();
    for (const std::string& e : used) u.arr_mut().push_back(Json::string(e));
    doc.set("extensionsUsed", std::move(u));
  }
  doc.set("scene", num(0));
  doc.set("scenes", std::move(scenes));
  doc.set("nodes", std::move(nodes));
  doc.set("meshes", std::move(meshes));
  if (!materials.arr().empty()) doc.set("materials", std::move(materials));
  if (!textures.arr().empty()) {
    Json samplers = Json::array();
    Json s = Json::object();
    s.set("magFilter", num(9729));
    s.set("minFilter", num(9987));
    samplers.arr_mut().push_back(std::move(s));
    doc.set("samplers", std::move(samplers));
    doc.set("images", std::move(images));
    doc.set("textures", std::move(textures));
  }
  doc.set("accessors", std::move(accessors));
  Json buffers = Json::array();
  Json buf = Json::object();
  buf.set("byteLength", num(static_cast<double>(b.bin.size())));
  buffers.arr_mut().push_back(std::move(buf));
  doc.set("buffers", std::move(buffers));
  doc.set("bufferViews", std::move(b.views));
  return pack_glb(doc, std::move(b.bin));
}

ConvertResult repack_gltf(const FileSet& files) {
  ConvertResult r;
  Repacker rp(files, r.warnings);
  r.glb = rp.run();
  return r;
}

bool is_model_extension(std::string_view e) {
  static constexpr std::array<std::string_view, 7> k = {".glb", ".gltf", ".obj", ".fbx", ".usda", ".usdz", ".usd"};
  return std::ranges::find(k, lower(e)) != k.end();
}

ConvertResult convert_model(std::span<const SourceFile> files) {
  const FileSet set(files);
  const std::string ext = ext_of(set.model().path);
  if (ext == ".glb" || ext == ".gltf") return repack_gltf(set);
  SceneModel scene;
  if (ext == ".obj") {
    scene = load_obj(set);
  } else if (ext == ".fbx") {
    scene = load_fbx(set);
  } else if (ext == ".usdz") {
    scene = load_usdz(set);
  } else if (ext == ".usda" || ext == ".usd") {
    const std::vector<std::uint8_t>& b = set.model().bytes;
    if (b.size() >= 8 && std::memcmp(b.data(), "PXR-USDC", 8) == 0) {
      throw ConvertError("This .usd is a binary crate (USDC). Export it as .usda (ASCII) or .usdz with an ASCII layer, "
                         "or as .glb / .fbx.");
    }
    scene = load_usda(std::string_view(reinterpret_cast<const char*>(b.data()), b.size()), set, dir_of(set.model().path));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  } else {
    throw ConvertError("“" + base_of(set.model().path) + "” is not a 3D model the importer reads (.glb, .gltf, .obj, .fbx, .usda, .usdz).");
  }
  if (scene.meshes.empty() || std::ranges::all_of(scene.meshes, [](const MeshDef& m) { return m.primitives.empty(); })) {
    throw ConvertError("“" + base_of(set.model().path) + "” holds no triangle geometry.");
  }
  ConvertResult r;
  r.glb = write_glb(scene);
  r.warnings = std::move(scene.warnings);
  return r;
}

}  // namespace premation::scene::modelio
