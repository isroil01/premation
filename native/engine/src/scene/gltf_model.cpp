#include "gltf_model.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cctype>
#include <cmath>
#include <cstring>
#include <limits>
#include <mutex>
#include <stdexcept>

#include "jsmath.hpp"
#include "json.hpp"
#include "native_effects.hpp"
#include "numconv.hpp"

namespace premation::scene::gltf {
namespace {

using js::Json;

constexpr std::uint32_t kGlbMagic = 0x46546c67;  // 'glTF'
constexpr std::uint32_t kChunkJson = 0x4e4f534a;
constexpr std::uint32_t kChunkBin = 0x004e4942;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

/// A parse failure carrying the TypeScript's message (thrown inside parse only).
struct ParseError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::uint32_t u32le(std::span<const std::uint8_t> b, std::size_t o) {
  if (o + 4 > b.size()) throw ParseError("Offset is outside the bounds of the DataView");
  std::uint32_t v = 0;
  std::memcpy(&v, b.data() + o, 4);
  return v;
}

/// A buffer: bytes inside some storage (a GLB's BIN chunk is a view into the file).
/// Reads address the WHOLE storage, as the TS DataView over `bytes.buffer` does.
struct Buffer {
  std::shared_ptr<const std::vector<std::uint8_t>> storage;
  std::size_t offset = 0;
  std::size_t length = 0;
};

double num_or(const Json& j, double def) { return j.is_number() ? j.num() : def; }
bool present(const Json& j) { return !j.is_undefined() && !j.is_null(); }  // `x ?? d` keeps x

/// JS ToUint32 / ToUint16 of a double.
std::uint32_t to_uint32(double v) {
  if (!std::isfinite(v)) return 0;
  const double t = std::trunc(v);
  const double m = std::fmod(t, 4294967296.0);
  return static_cast<std::uint32_t>(static_cast<std::int64_t>(m < 0 ? m + 4294967296.0 : m));
}

std::vector<std::uint8_t> decode_data_uri(std::string_view uri) {
  const auto comma = uri.find(',');
  if (comma == std::string_view::npos) throw ParseError("malformed data: URI");
  const std::string_view meta = uri.substr(0, comma);
  const std::string_view body = uri.substr(comma + 1);
  std::string lowerMeta(meta);
  std::ranges::transform(lowerMeta, lowerMeta.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (lowerMeta.ends_with(";base64")) {
    std::string clean;
    clean.reserve(body.size());
    for (const char c : body) {
      if (c != ' ' && c != '\t' && c != '\n' && c != '\f' && c != '\r') clean.push_back(c);
    }
    auto bytes = doc::native_unbase64(clean);
    if (!bytes) throw ParseError("The string to be decoded is not correctly encoded.");
    return std::move(*bytes);
  }
  // decodeURIComponent(body) → UTF-8 bytes.
  std::vector<std::uint8_t> out;
  for (std::size_t i = 0; i < body.size(); ++i) {
    if (body[i] == '%') {
      if (i + 2 >= body.size()) throw ParseError("URI malformed");
      const auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      const int h = hex(body[i + 1]);
      const int l = hex(body[i + 2]);
      if (h < 0 || l < 0) throw ParseError("URI malformed");
      out.push_back(static_cast<std::uint8_t>(h * 16 + l));
      i += 2;
    } else {
      out.push_back(static_cast<std::uint8_t>(body[i]));
    }
  }
  return out;
}

std::string sidecar_error(std::string_view uri, std::string_view where) {
  return "This .gltf keeps its data in separate files (“" + std::string(uri) + "”) — " + std::string(where) +
         ". Select the .gltf together with its .bin and texture files (File ▸ Import 3D Model…), "
         "or re-export the model as a single .glb.";
}

std::size_t component_bytes(double t) {
  if (t == 5120 || t == 5121) return 1;
  if (t == 5122 || t == 5123) return 2;
  if (t == 5125 || t == 5126) return 4;
  return 0;
}

std::size_t type_components(const Json& t) {
  if (!t.is_string()) return 0;
  const std::string& s = t.str();
  if (s == "SCALAR") return 1;
  if (s == "VEC2") return 2;
  if (s == "VEC3") return 3;
  if (s == "VEC4") return 4;
  if (s == "MAT4") return 16;
  return 0;
}

std::string idx_str(double v) { return motion::js::number_to_string(v); }

class Reader {
 public:
  Reader(const Json& g, std::vector<Buffer> buffers) : g_(g), buffers_(std::move(buffers)) {}

  /// viewBytes(viewIndex): the view as (storage, absolute offset, length).
  Buffer view(double viewIndex) const {
    const Json& v = g_.at("bufferViews").arr().size() > 0 && viewIndex >= 0 && viewIndex == std::floor(viewIndex) &&
                            static_cast<std::size_t>(viewIndex) < g_.at("bufferViews").arr().size()
                        ? g_.at("bufferViews").arr()[static_cast<std::size_t>(viewIndex)]
                        : undefined_;
    if (!v.is_object()) throw ParseError("missing bufferView " + idx_str(viewIndex));
    const double bi = num_or(v.at("buffer"), kNaN);
    if (!(bi >= 0 && bi == std::floor(bi) && static_cast<std::size_t>(bi) < buffers_.size())) {
      throw ParseError("bufferView " + idx_str(viewIndex) + " references missing buffer " + idx_str(bi));
    }
    const Buffer& b = buffers_[static_cast<std::size_t>(bi)];
    // buf.subarray(off, off + len): clamped to the buffer.
    const double off = present(v.at("byteOffset")) ? num_or(v.at("byteOffset"), 0) : 0;
    const double len = num_or(v.at("byteLength"), 0);
    const auto clampIdx = [&](double x) {
      if (!(x > 0)) return std::size_t{0};
      return std::min(b.length, static_cast<std::size_t>(x));
    };
    const std::size_t s = clampIdx(off);
    const std::size_t e = std::max(s, clampIdx(off + len));
    return Buffer{b.storage, b.offset + s, e - s};
  }

  [[nodiscard]] std::optional<double> stride(double viewIndex) const {
    const auto& views = g_.at("bufferViews").arr();
    const auto i = static_cast<std::size_t>(viewIndex);
    const Json& s = views[i].at("byteStride");
    return s.is_number() ? std::optional<double>(s.num()) : std::nullopt;
  }

  static double component(const Buffer& b, std::size_t at, double type, bool normalized, double accessor) {
    const std::vector<std::uint8_t>& s = *b.storage;
    const std::size_t n = component_bytes(type);
    if (n == 0) throw ParseError("accessor " + idx_str(accessor) + ": componentType " + idx_str(type));
    if (at + n > s.size()) throw ParseError("Offset is outside the bounds of the DataView");
    const std::uint8_t* p = s.data() + at;
    if (type == 5126) {
      float f = 0;
      std::memcpy(&f, p, 4);
      return static_cast<double>(f);
    }
    if (type == 5125) {
      std::uint32_t v = 0;
      std::memcpy(&v, p, 4);
      return static_cast<double>(v);
    }
    if (type == 5123) {
      std::uint16_t v = 0;
      std::memcpy(&v, p, 2);
      return normalized ? v / 65535.0 : static_cast<double>(v);
    }
    if (type == 5122) {
      std::int16_t v = 0;
      std::memcpy(&v, p, 2);
      return normalized ? std::max(v / 32767.0, -1.0) : static_cast<double>(v);
    }
    if (type == 5121) return normalized ? p[0] / 255.0 : static_cast<double>(p[0]);
    const auto v = static_cast<std::int8_t>(p[0]);
    return normalized ? std::max(v / 127.0, -1.0) : static_cast<double>(v);
  }

  /// readAccessorF32.
  std::vector<float> accessor(const Json& indexJ) const {
    const double index = num_or(indexJ, kNaN);
    const auto& accs = g_.at("accessors").arr();
    const bool ok = index >= 0 && index == std::floor(index) && static_cast<std::size_t>(index) < accs.size();
    const Json& a = ok ? accs[static_cast<std::size_t>(index)] : undefined_;
    if (!a.is_object()) throw ParseError("missing accessor " + idx_str(index));
    const std::size_t comps = type_components(a.at("type"));
    const double ct = num_or(a.at("componentType"), kNaN);
    const std::size_t compBytes = component_bytes(ct);
    if (comps == 0 || compBytes == 0) {
      throw ParseError("accessor " + idx_str(index) + ": unsupported type " + (a.at("type").is_string() ? a.at("type").str() : "undefined") +
                       "/" + idx_str(ct));
    }
    const double count = num_or(a.at("count"), 0);
    const auto n = static_cast<std::size_t>(std::max(0.0, count));
    std::vector<float> out(n * comps, 0.0F);
    const bool normalized = a.at("normalized").b();
    if (!a.at("bufferView").is_undefined()) {
      const double vi = num_or(a.at("bufferView"), kNaN);
      const Buffer v = view(vi);
      const double elemBytes = static_cast<double>(comps * compBytes);
      const std::optional<double> st = stride(vi);
      const double step = st && *st > 0 ? *st : elemBytes;
      const double base = static_cast<double>(v.offset) + (present(a.at("byteOffset")) ? num_or(a.at("byteOffset"), 0) : 0);
      for (std::size_t e = 0; e < n; ++e) {
        const double at = base + static_cast<double>(e) * step;
        for (std::size_t c = 0; c < comps; ++c) {
          out[e * comps + c] = static_cast<float>(component(v, static_cast<std::size_t>(at) + c * compBytes, ct, normalized, index));
        }
      }
    }
    const Json& sp = a.at("sparse");
    if (sp.is_object() && num_or(sp.at("count"), 0) > 0) {
      const double ict = num_or(sp.at("indices").at("componentType"), kNaN);
      const std::size_t idxBytes = component_bytes(ict);
      if (idxBytes == 0) throw ParseError("accessor " + idx_str(index) + ": sparse index type " + idx_str(ict));
      const Buffer iv = view(num_or(sp.at("indices").at("bufferView"), kNaN));
      const Buffer vv = view(num_or(sp.at("values").at("bufferView"), kNaN));
      const std::size_t iBase = iv.offset + static_cast<std::size_t>(num_or(sp.at("indices").at("byteOffset"), 0));
      const std::size_t vBase = vv.offset + static_cast<std::size_t>(num_or(sp.at("values").at("byteOffset"), 0));
      const double spCount = num_or(sp.at("count"), 0);
      for (std::size_t s = 0; static_cast<double>(s) < spCount; ++s) {
        const double target = component(iv, iBase + s * idxBytes, ict, false, index);
        if (target < 0 || target >= count) continue;
        const auto t = static_cast<std::size_t>(target);
        for (std::size_t c = 0; c < comps; ++c) {
          out[t * comps + c] = static_cast<float>(component(vv, vBase + (s * comps + c) * compBytes, ct, normalized, index));
        }
      }
    }
    return out;
  }

  std::vector<std::uint32_t> indices(const Json& index) const {
    const std::vector<float> raw = accessor(index);
    std::vector<std::uint32_t> out(raw.size());
    for (std::size_t i = 0; i < raw.size(); ++i) out[i] = to_uint32(static_cast<double>(raw[i]));
    return out;
  }

 private:
  const Json& g_;
  std::vector<Buffer> buffers_;
  Json undefined_;
};

std::string join(const std::vector<std::string>& v, std::string_view sep) {
  std::string o;
  for (std::size_t i = 0; i < v.size(); ++i) {
    if (i != 0) o += sep;
    o += v[i];
  }
  return o;
}

std::string hint_for(const std::string& ext) {
  if (ext == "KHR_draco_mesh_compression") return "Draco-compressed";
  if (ext == "EXT_meshopt_compression" || ext == "KHR_meshopt_compression") return "meshopt-compressed";
  if (ext == "KHR_mesh_quantization") return "quantized";
  if (ext == "KHR_texture_basisu") return "KTX2/Basis-texture";
  return ext;
}

/// generateNormals: area-weighted, a Float32Array accumulator.
std::vector<float> generate_normals(const std::vector<float>& positions, const std::vector<std::uint32_t>& indices) {
  std::vector<float> out(positions.size(), 0.0F);
  const auto p = [&](std::size_t i) { return i < positions.size() ? static_cast<double>(positions[i]) : kNaN; };
  const auto add = [&](std::size_t j, double v) {
    if (j < out.size()) out[j] = static_cast<float>(static_cast<double>(out[j]) + v);
  };
  for (std::size_t i = 0; i + 2 < indices.size(); i += 3) {
    const std::size_t a = std::size_t{indices[i]} * 3;
    const std::size_t b = std::size_t{indices[i + 1]} * 3;
    const std::size_t c = std::size_t{indices[i + 2]} * 3;
    const double ux = p(b) - p(a);
    const double uy = p(b + 1) - p(a + 1);
    const double uz = p(b + 2) - p(a + 2);
    const double vx = p(c) - p(a);
    const double vy = p(c + 1) - p(a + 1);
    const double vz = p(c + 2) - p(a + 2);
    const double nx = uy * vz - uz * vy;
    const double ny = uz * vx - ux * vz;
    const double nz = ux * vy - uy * vx;
    for (const std::size_t j : {a, b, c}) {
      add(j, nx);
      add(j + 1, ny);
      add(j + 2, nz);
    }
  }
  for (std::size_t i = 0; i < out.size(); i += 3) {
    const std::array<double, 3> v{out[i], i + 1 < out.size() ? out[i + 1] : kNaN, i + 2 < out.size() ? out[i + 2] : kNaN};
    double len = motion::js::hypot(v);
    if (len == 0 || std::isnan(len)) len = 1;  // `|| 1`
    out[i] = static_cast<float>(v[0] / len);
    if (i + 1 < out.size()) out[i + 1] = static_cast<float>(v[1] / len);
    if (i + 2 < out.size()) out[i + 2] = static_cast<float>(v[2] / len);
  }
  return out;
}

std::optional<TextureRef> texture_ref(const Json& g, const Json& t, const std::vector<Image>& images) {
  if (!t.is_object() || !t.at("index").is_number()) return std::nullopt;
  const double ti = t.at("index").num();
  const auto& texs = g.at("textures").arr();
  if (!(ti >= 0 && ti == std::floor(ti) && static_cast<std::size_t>(ti) < texs.size())) return std::nullopt;
  const Json& src = texs[static_cast<std::size_t>(ti)].at("source");
  if (!src.is_number()) return std::nullopt;  // undefined / null (a non-number never indexes an image)
  const double im = src.num();
  if (!(im >= 0 && im == std::floor(im) && static_cast<std::size_t>(im) < images.size())) return std::nullopt;
  TextureRef r;
  r.image = static_cast<std::size_t>(im);
  const Json& kt = t.at("extensions").at("KHR_texture_transform");
  if (present(kt)) {
    TextureTransform x;
    const auto el = [](const Json& arr, std::size_t i, double def) {
      if (!arr.is_array() || i >= arr.arr().size()) return def;
      const Json& v = arr.arr()[i];
      return present(v) ? num_or(v, def) : def;
    };
    x.offset = {el(kt.at("offset"), 0, 0), el(kt.at("offset"), 1, 0)};
    x.rotation = kt.at("rotation").is_number() ? kt.at("rotation").num() : 0;
    x.scale = {el(kt.at("scale"), 0, 1), el(kt.at("scale"), 1, 1)};
    if (kt.at("texCoord").is_number()) x.texCoord = kt.at("texCoord").num();
    r.transform = x;
  }
  r.texCoord = r.transform && r.transform->texCoord ? *r.transform->texCoord : (present(t.at("texCoord")) ? num_or(t.at("texCoord"), 0) : 0);
  return r;
}

Parsed parse_json(const Json& g, const Buffer* glbBin) {
  // Required extensions this reader decodes.
  std::vector<std::string> unsupported;
  for (const Json& e : g.at("extensionsRequired").arr()) {
    const std::string s = e.is_string() ? e.str() : std::string();
    if (s != "KHR_texture_transform" && s != "KHR_materials_emissive_strength") unsupported.push_back(s);
  }
  if (!unsupported.empty()) {
    std::vector<std::string> kinds;
    for (const auto& u : unsupported) kinds.push_back(hint_for(u));
    throw ParseError("This model needs " + join(unsupported, ", ") + " (" + join(kinds, ", ") + "), which is not supported yet. " +
                     "Re-export it without compression (e.g. Blender ▸ glTF ▸ uncheck Compression).");
  }
  std::vector<Buffer> buffers;
  const auto& bufs = g.at("buffers").arr();
  for (std::size_t i = 0; i < bufs.size(); ++i) {
    const Json& uri = bufs[i].at("uri");
    if (uri.is_undefined()) {
      if (glbBin == nullptr) throw ParseError("buffer " + std::to_string(i) + " has no URI and there is no GLB BIN chunk");
      buffers.push_back(*glbBin);
      continue;
    }
    const std::string u = uri.is_string() ? uri.str() : std::string();
    if (u.starts_with("data:")) {
      auto bytes = std::make_shared<std::vector<std::uint8_t>>(decode_data_uri(u));
      const std::size_t n = bytes->size();
      buffers.push_back(Buffer{std::move(bytes), 0, n});
      continue;
    }
    throw ParseError(sidecar_error(u, "buffer " + std::to_string(i)));
  }
  const Reader rd(g, std::move(buffers));
  Parsed out;

  const auto& imgs = g.at("images").arr();
  for (std::size_t i = 0; i < imgs.size(); ++i) {
    const Json& im = imgs[i];
    Image img;
    if (!im.at("bufferView").is_undefined()) {
      const Buffer v = rd.view(num_or(im.at("bufferView"), kNaN));
      img.bytes.assign(v.storage->begin() + static_cast<std::ptrdiff_t>(v.offset),
                       v.storage->begin() + static_cast<std::ptrdiff_t>(v.offset + v.length));
      img.mimeType = im.at("mimeType").is_string() ? im.at("mimeType").str() : "image/png";
    } else if (im.at("uri").is_string() && im.at("uri").str().starts_with("data:")) {
      const std::string& uri = im.at("uri").str();
      std::string mime = "image/png";
      const std::size_t end = uri.find_first_of(";,", 5);
      if (end != std::string::npos && end > 5) mime = uri.substr(5, end - 5);
      img.bytes = decode_data_uri(uri);
      img.mimeType = mime;
    } else {
      throw ParseError(sidecar_error(im.at("uri").is_string() ? im.at("uri").str() : "image " + std::to_string(i), "image " + std::to_string(i)));
    }
    out.images.push_back(std::move(img));
  }

  const auto& mats = g.at("materials").arr();
  for (std::size_t i = 0; i < mats.size(); ++i) {
    const Json& m = mats[i];
    const Json& pbr = m.at("pbrMetallicRoughness");
    Material mt;
    mt.name = m.at("name").is_string() ? m.at("name").str() : "material " + std::to_string(i);
    const Json& f = pbr.at("baseColorFactor");
    const auto fe = [](const Json& arr, std::size_t k, double def) {
      if (!arr.is_array() || k >= arr.arr().size()) return def;
      return present(arr.arr()[k]) ? num_or(arr.arr()[k], def) : def;
    };
    if (present(f)) mt.baseColorFactor = {fe(f, 0, 1), fe(f, 1, 1), fe(f, 2, 1), fe(f, 3, 1)};
    mt.baseColorTexture = texture_ref(g, pbr.at("baseColorTexture"), out.images);
    mt.doubleSided = m.at("doubleSided").is_bool() && m.at("doubleSided").b();
    mt.metallicFactor = pbr.at("metallicFactor").is_number() ? pbr.at("metallicFactor").num() : 1;
    mt.roughnessFactor = pbr.at("roughnessFactor").is_number() ? pbr.at("roughnessFactor").num() : 1;
    mt.normalTexture = texture_ref(g, m.at("normalTexture"), out.images);
    mt.normalScale = m.at("normalTexture").at("scale").is_number() ? m.at("normalTexture").at("scale").num() : 1;
    mt.metallicRoughnessTexture = texture_ref(g, pbr.at("metallicRoughnessTexture"), out.images);
    mt.occlusionTexture = texture_ref(g, m.at("occlusionTexture"), out.images);
    mt.occlusionStrength = m.at("occlusionTexture").at("strength").is_number() ? m.at("occlusionTexture").at("strength").num() : 1;
    mt.emissiveTexture = texture_ref(g, m.at("emissiveTexture"), out.images);
    const Json& ef = m.at("emissiveFactor");
    if (present(ef)) mt.emissiveFactor = {fe(ef, 0, 0), fe(ef, 1, 0), fe(ef, 2, 0)};
    const Json& es = m.at("extensions").at("KHR_materials_emissive_strength").at("emissiveStrength");
    mt.emissiveStrength = es.is_number() ? es.num() : 1;
    out.materials.push_back(std::move(mt));
  }

  const auto& meshes = g.at("meshes").arr();
  for (std::size_t mi = 0; mi < meshes.size(); ++mi) {
    const Json& mesh = meshes[mi];
    Mesh me;
    me.name = mesh.at("name").is_string() ? mesh.at("name").str() : "mesh " + std::to_string(mi);
    for (const Json& p : mesh.at("primitives").arr()) {
      const double mode = present(p.at("mode")) ? num_or(p.at("mode"), kNaN) : 4;
      const Json& attrs = p.at("attributes");
      if (mode != 4 || attrs.at("POSITION").is_undefined()) continue;
      Primitive pr;
      pr.positions = rd.accessor(attrs.at("POSITION"));
      if (!attrs.at("TEXCOORD_0").is_undefined()) pr.uvs = rd.accessor(attrs.at("TEXCOORD_0"));
      if (!p.at("indices").is_undefined()) {
        pr.indices = rd.indices(p.at("indices"));
      } else {
        pr.indices.resize(pr.positions.size() / 3);
        for (std::size_t i = 0; i < pr.indices.size(); ++i) pr.indices[i] = static_cast<std::uint32_t>(i);
      }
      pr.normals = !attrs.at("NORMAL").is_undefined() ? rd.accessor(attrs.at("NORMAL")) : generate_normals(pr.positions, pr.indices);
      if (present(p.at("material"))) pr.material = num_or(p.at("material"), kNaN);
      if (!attrs.at("JOINTS_0").is_undefined() && !attrs.at("WEIGHTS_0").is_undefined()) {
        pr.joints = rd.accessor(attrs.at("JOINTS_0"));
        pr.weights = rd.accessor(attrs.at("WEIGHTS_0"));
      }
      for (const Json& t : p.at("targets").arr()) {
        Primitive::Target tg;
        if (!t.at("POSITION").is_undefined()) tg.positions = rd.accessor(t.at("POSITION"));
        if (!t.at("NORMAL").is_undefined()) tg.normals = rd.accessor(t.at("NORMAL"));
        pr.targets.push_back(std::move(tg));
      }
      me.primitives.push_back(std::move(pr));
    }
    for (const Json& w : mesh.at("weights").arr()) me.weights.push_back(num_or(w, kNaN));
    out.meshes.push_back(std::move(me));
  }

  // Skins' inverse binds and animation streams are read for the same failures
  // the TS parse would raise (a bad accessor refuses the whole file).
  for (const Json& sk : g.at("skins").arr()) {
    if (!sk.at("inverseBindMatrices").is_undefined()) (void)rd.accessor(sk.at("inverseBindMatrices"));
    ++out.skins;
  }
  for (const Json& an : g.at("animations").arr()) {
    for (const Json& ch : an.at("channels").arr()) {
      const double si = num_or(ch.at("sampler"), kNaN);
      const auto& samplers = an.at("samplers").arr();
      if (!(si >= 0 && si == std::floor(si) && static_cast<std::size_t>(si) < samplers.size())) continue;
      if (ch.at("target").at("node").is_undefined()) continue;
      const std::string path = ch.at("target").at("path").is_string() ? ch.at("target").at("path").str() : "";
      if (path != "translation" && path != "rotation" && path != "scale" && path != "weights") continue;
      const Json& s = samplers[static_cast<std::size_t>(si)];
      (void)rd.accessor(s.at("input"));
      (void)rd.accessor(s.at("output"));
    }
  }
  return out;
}

std::string hex2(double v) {
  const double r = motion::js::round(std::max(0.0, std::min(1.0, v)) * 255);
  if (std::isnan(r)) return "NaN";
  const auto n = static_cast<unsigned>(r);
  constexpr std::string_view kHex = "0123456789abcdef";
  std::string s;
  s += kHex[(n >> 4U) & 0xFU];
  s += kHex[n & 0xFU];
  return s;
}

struct Registry {
  std::mutex mu;
  std::map<std::string, std::shared_ptr<const Model>, std::less<>> models;
};

Registry& registry() {
  static Registry r;  // process-wide, like modelMesh.ts's session registry
  return r;
}

std::shared_ptr<const Model> build_model(std::string_view modelKey, std::span<const std::uint8_t> bytes) {
  auto m = std::make_shared<Model>();
  m->key = std::string(modelKey);
  std::string err;
  m->parsed = parse(bytes, err);
  if (!m->parsed) {
    m->error = err;
    return m;
  }
  for (std::size_t mi = 0; mi < m->parsed->meshes.size(); ++mi) {
    for (std::size_t pi = 0; pi < m->parsed->meshes[mi].primitives.size(); ++pi) {
      if (auto e = primitive_to_entry(*m->parsed, modelKey, mi, pi)) m->entries.emplace(std::make_pair(mi, pi), std::move(*e));
    }
  }
  return m;
}

}  // namespace

std::optional<Parsed> parse(std::span<const std::uint8_t> data, std::string& error) {
  try {
    if (data.size() >= 12 && u32le(data, 0) == kGlbMagic) {
      const std::uint32_t version = u32le(data, 4);
      if (version != 2) throw ParseError("GLB version " + std::to_string(version) + " — only glTF 2.0 is supported");
      auto storage = std::make_shared<std::vector<std::uint8_t>>(data.begin(), data.end());
      std::optional<Json> json;
      std::optional<Buffer> bin;
      std::size_t off = 12;
      while (off + 8 <= data.size()) {
        const std::uint32_t len = u32le(data, off);
        const std::uint32_t type = u32le(data, off + 4);
        if (off + 8 + len > data.size()) throw ParseError("Invalid typed array length: " + std::to_string(len));
        if (type == kChunkJson) {
          const std::string_view text(reinterpret_cast<const char*>(data.data() + off + 8), len);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
          json = js::parse(text);
          if (!json) throw ParseError("GLB JSON chunk does not parse");
        } else if (type == kChunkBin) {
          bin = Buffer{storage, off + 8, len};
        }
        off += 8 + std::size_t{len};
      }
      if (!json || json->is_null() || json->is_undefined()) throw ParseError("GLB has no JSON chunk");
      return parse_json(*json, bin ? &*bin : nullptr);
    }
    const std::string_view text(reinterpret_cast<const char*>(data.data()), data.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    const std::optional<Json> json = js::parse(text);
    if (!json) throw ParseError("glTF JSON does not parse");
    return parse_json(*json, nullptr);
  } catch (const ParseError& e) {
    error = e.what();
    return std::nullopt;
  }
}

std::string model_key_for_bytes(std::span<const std::uint8_t> bytes) {
  std::uint32_t h = 0x811c9dc5U;
  for (const std::uint8_t b : bytes) h = (h ^ b) * 0x01000193U;  // Math.imul: mod 2^32
  constexpr std::string_view kHex = "0123456789abcdef";
  std::string s = "gltf-";
  for (int i = 7; i >= 0; --i) s += kHex[(h >> (static_cast<unsigned>(i) * 4U)) & 0xFU];
  s += '-';
  s += std::to_string(bytes.size());
  return s;
}

std::optional<Entry> primitive_to_entry(const Parsed& parsed, std::string_view modelKey, std::size_t meshIndex, std::size_t primIndex) {
  if (meshIndex >= parsed.meshes.size() || primIndex >= parsed.meshes[meshIndex].primitives.size()) return std::nullopt;
  const Primitive& prim = parsed.meshes[meshIndex].primitives[primIndex];
  const Material* material = nullptr;
  if (prim.material) {
    const double mi = *prim.material;
    if (mi >= 0 && mi == std::floor(mi) && static_cast<std::size_t>(mi) < parsed.materials.size()) material = &parsed.materials[static_cast<std::size_t>(mi)];
  }
  const std::optional<TextureTransform> kt =
      material != nullptr && material->baseColorTexture ? material->baseColorTexture->transform : std::nullopt;
  const bool ktActive = kt && (kt->offset[0] != 0 || kt->offset[1] != 0 || kt->rotation != 0 || kt->scale[0] != 1 || kt->scale[1] != 1);
  const double ktCos = kt ? motion::js::cos(kt->rotation) : 1;
  const double ktSin = kt ? motion::js::sin(kt->rotation) : 0;
  const std::size_t vcount = prim.positions.size() / 3;
  const auto at = [](const std::vector<float>& v, std::size_t i) { return i < v.size() ? static_cast<double>(v[i]) : kNaN; };
  Entry e;
  e.vertices.resize(vcount * 8);
  constexpr double kInf = std::numeric_limits<double>::infinity();
  double minX = kInf, minY = kInf, minZ = kInf, maxX = -kInf, maxY = -kInf, maxZ = -kInf;
  for (std::size_t i = 0; i < vcount; ++i) {
    const double px = at(prim.positions, i * 3);
    const double py = 0 - at(prim.positions, i * 3 + 1);
    const double pz = 0 - at(prim.positions, i * 3 + 2);
    const std::size_t o = i * 8;
    e.vertices[o] = static_cast<float>(px);
    e.vertices[o + 1] = static_cast<float>(py);
    e.vertices[o + 2] = static_cast<float>(pz);
    e.vertices[o + 3] = static_cast<float>(at(prim.normals, i * 3));
    e.vertices[o + 4] = static_cast<float>(0 - at(prim.normals, i * 3 + 1));
    e.vertices[o + 5] = static_cast<float>(0 - at(prim.normals, i * 3 + 2));
    const double u0 = prim.uvs ? at(*prim.uvs, i * 2) : 0;
    const double v0 = prim.uvs ? at(*prim.uvs, i * 2 + 1) : 0;
    const double su = u0 * (kt ? kt->scale[0] : 1);
    const double sv = v0 * (kt ? kt->scale[1] : 1);
    e.vertices[o + 6] = static_cast<float>(ktActive ? kt->offset[0] + ktCos * su + ktSin * sv : u0);
    e.vertices[o + 7] = static_cast<float>(ktActive ? kt->offset[1] - ktSin * su + ktCos * sv : v0);
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }
  e.skinned = prim.joints && prim.weights && prim.joints->size() == vcount * 4 && prim.weights->size() == vcount * 4;
  const std::array<double, 4> f = material != nullptr ? material->baseColorFactor : std::array<double, 4>{1, 1, 1, 1};
  e.fill = "#" + hex2(f[0]) + hex2(f[1]) + hex2(f[2]) + hex2(f[3]);
  if (material != nullptr && material->baseColorTexture) e.textureImage = material->baseColorTexture->image;
  e.doubleSided = material != nullptr && material->doubleSided;
  e.metallic = material != nullptr ? material->metallicFactor : 0;
  e.roughness = material != nullptr ? material->roughnessFactor : 0.5;
  if (material != nullptr) {
    const auto slot = [](const std::optional<TextureRef>& t) { return t ? std::optional<std::size_t>(t->image) : std::nullopt; };
    e.maps.normal = slot(material->normalTexture);
    e.maps.metallicRoughness = slot(material->metallicRoughnessTexture);
    e.maps.occlusion = slot(material->occlusionTexture);
    e.maps.emissive = slot(material->emissiveTexture);
    e.normalScale = material->normalScale;
    e.occlusionStrength = material->occlusionStrength;
    const double s = material->emissiveStrength;
    e.emissive = {material->emissiveFactor[0] * s, material->emissiveFactor[1] * s, material->emissiveFactor[2] * s};
  }
  e.index16 = vcount <= 0xffff;
  e.indices = prim.indices;
  if (e.index16) {
    for (std::uint32_t& i : e.indices) i &= 0xFFFFU;  // Uint16Array.from: ToUint16
  }
  e.key = std::string(modelKey) + ":m" + std::to_string(meshIndex) + "p" + std::to_string(primIndex);
  if (vcount > 0) {
    e.bbox = {minX, minY, minZ, maxX, maxY, maxZ};
  } else {
    e.bbox = {0, 0, 0, 0, 0, 0};
  }
  if (ktActive) e.uvTransform = std::array<double, 5>{kt->offset[0], kt->offset[1], kt->scale[0], kt->scale[1], kt->rotation};
  e.morphTargets = prim.targets.size();
  const std::vector<double>& mw = parsed.meshes[meshIndex].weights;
  for (std::size_t i = 0; i < prim.targets.size(); ++i) e.morphDefaults.push_back(i < mw.size() ? mw[i] : 0);
  return e;
}

std::shared_ptr<const Model> register_model(std::string_view modelKey, std::span<const std::uint8_t> bytes) {
  Registry& r = registry();
  {
    const std::scoped_lock lock(r.mu);
    if (const auto it = r.models.find(modelKey); it != r.models.end()) return it->second;
  }
  std::shared_ptr<const Model> m = build_model(modelKey, bytes);
  const std::scoped_lock lock(r.mu);
  return r.models.emplace(std::string(modelKey), std::move(m)).first->second;
}

std::shared_ptr<const Model> registered_model(std::string_view modelKey) {
  Registry& r = registry();
  const std::scoped_lock lock(r.mu);
  const auto it = r.models.find(modelKey);
  return it == r.models.end() ? nullptr : it->second;
}

std::shared_ptr<const Model> model_for(const doc::Document& d, std::string_view modelKey, std::string& why) {
  if (auto m = registered_model(modelKey)) return m;
  // readNodeModelSource over the graph: the imported root carries the file.
  for (const auto& entry : d.nodes()) {
    const auto& node = entry.second;
    if (!node) continue;
    for (const doc::Component& c : node->components) {
      if (c.type != "Model") continue;
      const Json& p = c.props;
      if (!p.at("modelKey").is_string() || p.at("modelKey").str() != modelKey) continue;
      if (!p.at("glbData").is_string() || !p.at("glbData").str().starts_with("data:")) continue;
      const std::string& url = p.at("glbData").str();
      const auto comma = url.find(',');
      std::string clean;
      for (const char ch : std::string_view(url).substr(comma == std::string::npos ? url.size() : comma + 1)) {
        if (ch != ' ' && ch != '\t' && ch != '\n' && ch != '\f' && ch != '\r') clean.push_back(ch);
      }
      const auto bytes = doc::native_unbase64(clean);
      if (!bytes) {
        why = "the model's stored file does not decode";
        return nullptr;
      }
      return register_model(modelKey, *bytes);
    }
  }
  why = "the model's file is not in the document (no Model component carries its glbData)";
  return nullptr;
}

void clear_models() {
  Registry& r = registry();
  const std::scoped_lock lock(r.mu);
  r.models.clear();
}

std::string image_src(std::string_view modelKey, std::size_t image) {
  return "gltf:" + std::string(modelKey) + "#" + std::to_string(image);
}

std::optional<std::pair<std::string, std::size_t>> parse_image_src(std::string_view src) {
  if (!src.starts_with("gltf:")) return std::nullopt;
  const auto hash = src.rfind('#');
  if (hash == std::string_view::npos || hash < 5) return std::nullopt;
  std::size_t idx = 0;
  for (const char c : src.substr(hash + 1)) {
    if (c < '0' || c > '9') return std::nullopt;
    idx = idx * 10 + static_cast<std::size_t>(c - '0');
  }
  return std::make_pair(std::string(src.substr(5, hash - 5)), idx);
}

}  // namespace premation::scene::gltf
