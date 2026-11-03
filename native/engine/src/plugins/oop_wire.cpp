// SDK 1.4 (X): the out-of-process messages (oop_wire.hpp). Pure: no OS calls.
#include "oop_wire.hpp"

#include <algorithm>
#include <array>
#include <cstring>

#include "json.hpp"

namespace premation::plugins::oop {

namespace js = premation::js;

namespace {

void put_u32(std::vector<std::uint8_t>& out, std::uint32_t v) {
  for (std::uint32_t i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>((v >> (8U * i)) & 0xFFU));
}

void put_i64(std::vector<std::uint8_t>& out, std::int64_t v) {
  const auto u = static_cast<std::uint64_t>(v);
  put_u32(out, static_cast<std::uint32_t>(u & 0xFFFFFFFFU));
  put_u32(out, static_cast<std::uint32_t>(u >> 32U));
}

void put_f64(std::vector<std::uint8_t>& out, double v) {
  std::uint64_t bits = 0;
  std::memcpy(&bits, &v, sizeof bits);
  put_u32(out, static_cast<std::uint32_t>(bits & 0xFFFFFFFFU));
  put_u32(out, static_cast<std::uint32_t>(bits >> 32U));
}

void put_bytes(std::vector<std::uint8_t>& out, std::span<const std::uint8_t> b) {
  put_u32(out, static_cast<std::uint32_t>(b.size()));
  out.insert(out.end(), b.begin(), b.end());
}

void put_str(std::vector<std::uint8_t>& out, std::string_view s) {
  put_bytes(out, std::span(reinterpret_cast<const std::uint8_t*>(s.data()), s.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

void put_f64s(std::vector<std::uint8_t>& out, std::span<const double> v) {
  put_u32(out, static_cast<std::uint32_t>(v.size()));
  for (const double d : v) put_f64(out, d);
}

void put_image(std::vector<std::uint8_t>& out, const TexelImage& img) {
  put_u32(out, static_cast<std::uint32_t>(img.format));
  put_u32(out, img.width);
  put_u32(out, img.height);
  put_bytes(out, img.bytes);
}

class In {
 public:
  explicit In(std::span<const std::uint8_t> b) : b_(b) {}
  bool u32(std::uint32_t& v) {
    if (b_.size() - at_ < 4) return false;
    v = 0;
    for (std::uint32_t i = 0; i < 4; ++i) v |= std::uint32_t{b_[at_ + i]} << (8U * i);
    at_ += 4;
    return true;
  }
  bool i64(std::int64_t& v) {
    std::uint32_t lo = 0;
    std::uint32_t hi = 0;
    if (!u32(lo) || !u32(hi)) return false;
    v = static_cast<std::int64_t>((std::uint64_t{hi} << 32U) | lo);
    return true;
  }
  bool f64(double& v) {
    std::uint32_t lo = 0;
    std::uint32_t hi = 0;
    if (!u32(lo) || !u32(hi)) return false;
    const std::uint64_t bits = (std::uint64_t{hi} << 32U) | lo;
    std::memcpy(&v, &bits, sizeof v);
    return true;
  }
  bool flag(bool& b) {
    std::uint32_t v = 0;
    if (!u32(v)) return false;
    b = v != 0;
    return true;
  }
  bool bytes(std::vector<std::uint8_t>& v) {
    std::uint32_t n = 0;
    if (!u32(n) || b_.size() - at_ < n) return false;
    v.assign(b_.begin() + static_cast<std::ptrdiff_t>(at_), b_.begin() + static_cast<std::ptrdiff_t>(at_ + n));
    at_ += n;
    return true;
  }
  bool str(std::string& v) {
    std::vector<std::uint8_t> b;
    if (!bytes(b)) return false;
    v.assign(b.begin(), b.end());
    return true;
  }
  bool f64s(std::vector<double>& v) {
    std::uint32_t n = 0;
    if (!u32(n) || n > (b_.size() - at_) / 8) return false;
    v.resize(n);
    return std::ranges::all_of(v, [this](double& d) { return f64(d); });
  }
  template <std::size_t N>
  bool fixed(std::array<double, N>& a) {
    std::vector<double> v;
    if (!f64s(v) || v.size() != N) return false;
    std::ranges::copy(v, a.begin());
    return true;
  }
  bool image(TexelImage& img) {
    std::uint32_t f = 0;
    if (!u32(f) || f > static_cast<std::uint32_t>(TexelFormat::rgba32f) || !u32(img.width) || !u32(img.height) || !bytes(img.bytes)) return false;
    img.format = static_cast<TexelFormat>(f);
    return img.bytes.size() == std::size_t{img.width} * img.height * texel_bytes(img.format);
  }
  [[nodiscard]] bool done() const { return at_ == b_.size(); }

 private:
  std::span<const std::uint8_t> b_;
  std::size_t at_ = 0;
};

void put_value(std::vector<std::uint8_t>& out, const ParamValue& v) {
  put_f64s(out, v.v);
  put_str(out, v.layer);
  put_f64s(out, v.path);
  put_u32(out, v.pathClosed ? 1U : 0U);
  put_bytes(out, v.arb);
  put_str(out, v.text);
  put_f64s(out, v.curve);
  put_f64s(out, v.gradient);
  put_str(out, v.fileItem);
  put_str(out, v.filePath);
  put_str(out, v.fileName);
  put_u32(out, v.fileMissing ? 1U : 0U);
}

bool get_value(In& x, ParamValue& v) {
  return x.fixed(v.v) && x.str(v.layer) && x.f64s(v.path) && x.flag(v.pathClosed) && x.bytes(v.arb) && x.str(v.text) && x.f64s(v.curve) &&
         x.f64s(v.gradient) && x.str(v.fileItem) && x.str(v.filePath) && x.str(v.fileName) && x.flag(v.fileMissing);
}

void put_camera(std::vector<std::uint8_t>& out, const SceneCamera& c) {
  put_u32(out, (c.hasCamera ? 1U : 0U) | (c.orthographic ? 2U : 0U) | (c.dofEnabled ? 4U : 0U));
  put_f64s(out, c.view);
  put_f64s(out, c.projection);
  put_f64s(out, c.eye);
  put_f64s(out, std::array<double, 3>{c.zoom, c.focusDistance, c.aperture});
}

bool get_camera(In& x, SceneCamera& c) {
  std::uint32_t f = 0;
  std::array<double, 3> z{};
  if (!x.u32(f) || !x.fixed(c.view) || !x.fixed(c.projection) || !x.fixed(c.eye) || !x.fixed(z)) return false;
  c.hasCamera = (f & 1U) != 0;
  c.orthographic = (f & 2U) != 0;
  c.dofEnabled = (f & 4U) != 0;
  c.zoom = z[0];
  c.focusDistance = z[1];
  c.aperture = z[2];
  return true;
}

void put_light(std::vector<std::uint8_t>& out, const SceneLight& l) {
  put_u32(out, static_cast<std::uint32_t>(l.type));
  put_u32(out, static_cast<std::uint32_t>(l.falloff));
  put_u32(out, l.castsShadows ? 1U : 0U);
  put_f64s(out, l.color);
  put_f64s(out, l.position);
  put_f64s(out, l.direction);
  put_f64s(out, std::array<double, 6>{l.intensity, l.coneAngle, l.coneFeather, l.falloffDistance, l.shadowDarkness, l.shadowDiffusion});
}

bool get_light(In& x, SceneLight& l) {
  std::uint32_t type = 0;
  std::uint32_t falloff = 0;
  std::array<double, 6> k{};
  if (!x.u32(type) || !x.u32(falloff) || !x.flag(l.castsShadows) || !x.fixed(l.color) || !x.fixed(l.position) || !x.fixed(l.direction) ||
      !x.fixed(k)) {
    return false;
  }
  l.type = static_cast<std::int32_t>(type);
  l.falloff = static_cast<std::int32_t>(falloff);
  l.intensity = k[0];
  l.coneAngle = k[1];
  l.coneFeather = k[2];
  l.falloffDistance = k[3];
  l.shadowDarkness = k[4];
  l.shadowDiffusion = k[5];
  return true;
}

js::Json numbers(std::span<const double> v) {
  js::Json::Array a;
  for (const double d : v) a.push_back(js::Json::number(d));
  return js::Json::array(std::move(a));
}

std::vector<double> numbers_of(const js::Json& j) {
  std::vector<double> out;
  if (!j.is_array()) return out;
  for (const js::Json& e : j.arr()) out.push_back(e.is_number() ? e.num() : 0.0);
  return out;
}

std::string str_of(const js::Json& j) { return j.is_string() ? j.str() : std::string(); }
double num_of(const js::Json& j) { return j.is_number() ? j.num() : 0.0; }

}  // namespace

void put_frame(std::vector<std::uint8_t>& out, Kind kind, std::span<const std::uint8_t> payload) {
  put_u32(out, static_cast<std::uint32_t>(kind));
  put_u32(out, static_cast<std::uint32_t>(payload.size()));
  out.insert(out.end(), payload.begin(), payload.end());
}

bool read_header(std::span<const std::uint8_t> header, Kind& kind, std::uint32_t& length) {
  In r(header);
  std::uint32_t k = 0;
  if (!r.u32(k) || !r.u32(length) || length > kMaxFrame) return false;
  kind = static_cast<Kind>(k);
  return true;
}

std::vector<std::uint8_t> encode(const RenderRequest& r) {
  const RenderInputs& in = r.in;
  std::vector<std::uint8_t> out;
  put_str(out, in.matchName);
  put_str(out, in.instance);
  put_str(out, in.layerId);
  put_bytes(out, in.sequence);
  put_u32(out, static_cast<std::uint32_t>(in.values.size()));
  for (const ParamValue& v : in.values) put_value(out, v);
  put_i64(out, in.layerTime);
  put_i64(out, in.compTime);
  put_i64(out, in.timeStep);
  put_i64(out, in.layerStart);
  put_f64s(out, std::array<double, 7>{in.fps, in.compW, in.compH, in.shutterAngle, in.shutterPhase, static_cast<double>(in.motionBlurSamples),
                                      static_cast<double>(in.projectBits)});
  put_u32(out, static_cast<std::uint32_t>(in.layerW));
  put_u32(out, static_cast<std::uint32_t>(in.layerH));
  put_u32(out, static_cast<std::uint32_t>(in.worldW));
  put_u32(out, static_cast<std::uint32_t>(in.worldH));
  put_u32(out, (in.draft ? 1U : 0U) | (in.layer3d ? 2U : 0U) | (in.motionBlur ? 4U : 0U));
  put_f64s(out, in.layerToWorld);
  put_f64s(out, in.compToWorld);
  put_u32(out, in.camera ? 1U : 0U);
  if (in.camera) put_camera(out, *in.camera);
  put_u32(out, in.lights ? static_cast<std::uint32_t>(in.lights->size()) + 1U : 0U);
  if (in.lights) {
    for (const SceneLight& l : *in.lights) put_light(out, l);
  }
  put_u32(out, static_cast<std::uint32_t>(in.layerMatrices.size()));
  for (const auto& m : in.layerMatrices) {
    put_u32(out, m ? 1U : 0U);
    if (m) put_f64s(out, *m);
  }
  put_u32(out, static_cast<std::uint32_t>(in.channels.size()));
  for (const auto& [name, values] : in.channels) {
    put_str(out, name);
    put_f64s(out, values);
  }
  put_image(out, r.input);
  return out;
}

bool decode(std::span<const std::uint8_t> bytes, RenderRequest& r) {
  RenderInputs& in = r.in;
  In x(bytes);
  std::uint32_t n = 0;
  if (!x.str(in.matchName) || !x.str(in.instance) || !x.str(in.layerId) || !x.bytes(in.sequence) || !x.u32(n) || n > 4096) return false;
  in.values.resize(n);
  for (ParamValue& v : in.values) {
    if (!get_value(x, v)) return false;
  }
  std::array<double, 7> k{};
  std::uint32_t lw = 0;
  std::uint32_t lh = 0;
  std::uint32_t ww = 0;
  std::uint32_t wh = 0;
  std::uint32_t flags = 0;
  if (!x.i64(in.layerTime) || !x.i64(in.compTime) || !x.i64(in.timeStep) || !x.i64(in.layerStart) || !x.fixed(k) || !x.u32(lw) || !x.u32(lh) ||
      !x.u32(ww) || !x.u32(wh) || !x.u32(flags) || !x.fixed(in.layerToWorld) || !x.fixed(in.compToWorld)) {
    return false;
  }
  in.fps = k[0];
  in.compW = k[1];
  in.compH = k[2];
  in.shutterAngle = k[3];
  in.shutterPhase = k[4];
  in.motionBlurSamples = static_cast<std::uint32_t>(k[5]);
  in.projectBits = static_cast<std::uint32_t>(k[6]);
  in.layerW = static_cast<std::int32_t>(lw);
  in.layerH = static_cast<std::int32_t>(lh);
  in.worldW = static_cast<std::int32_t>(ww);
  in.worldH = static_cast<std::int32_t>(wh);
  in.draft = (flags & 1U) != 0;
  in.layer3d = (flags & 2U) != 0;
  in.motionBlur = (flags & 4U) != 0;
  std::uint32_t has = 0;
  if (!x.u32(has)) return false;
  if (has != 0) {
    in.camera.emplace();
    if (!get_camera(x, *in.camera)) return false;
  }
  if (!x.u32(has) || has > 1025) return false;
  if (has != 0) {
    in.lights.emplace(has - 1);
    for (SceneLight& l : *in.lights) {
      if (!get_light(x, l)) return false;
    }
  }
  if (!x.u32(n) || n > 4096) return false;
  in.layerMatrices.resize(n);
  for (auto& m : in.layerMatrices) {
    if (!x.u32(has)) return false;
    if (has != 0) {
      m.emplace();
      if (!x.fixed(*m)) return false;
    }
  }
  if (!x.u32(n) || n > 4096) return false;
  for (std::uint32_t i = 0; i < n; ++i) {
    std::string name;
    std::vector<double> values;
    if (!x.str(name) || !x.f64s(values)) return false;
    in.channels[name] = std::move(values);
  }
  return x.image(r.input) && x.done();
}

std::vector<std::uint8_t> encode(const RenderReply& r) {
  std::vector<std::uint8_t> out;
  put_u32(out, (r.ok ? 1U : 0U) | (r.fault ? 2U : 0U));
  put_str(out, r.message);
  put_image(out, r.output);
  return out;
}

bool decode(std::span<const std::uint8_t> in, RenderReply& r) {
  In x(in);
  std::uint32_t flags = 0;
  if (!x.u32(flags) || !x.str(r.message) || !x.image(r.output) || !x.done()) return false;
  r.ok = (flags & 1U) != 0;
  r.fault = (flags & 2U) != 0;
  return true;
}

std::string specs_to_json(const std::vector<const EffectSpec*>& specs) {
  js::Json::Array list;
  for (const EffectSpec* e : specs) {
    js::Json o = js::Json::object();
    o.set("matchName", js::Json::string(e->matchName));
    o.set("outFlags", js::Json::number(e->outFlags));
    o.set("version", js::Json::number(e->version));
    o.set("about", js::Json::string(e->about));
    js::Json::Array params;
    for (const ParamSpec& s : e->params) {
      js::Json p = js::Json::object();
      p.set("type", js::Json::number(s.type));
      p.set("id", js::Json::number(s.id));
      p.set("flags", js::Json::number(s.flags));
      p.set("name", js::Json::string(s.name));
      p.set("def", numbers(s.def));
      p.set("range", numbers(std::array<double, 4>{s.validMin, s.validMax, s.sliderMin, s.sliderMax}));
      p.set("precision", js::Json::number(s.precision));
      js::Json::Array choices;
      for (const std::string& c : s.choices) choices.push_back(js::Json::string(c));
      p.set("choices", js::Json::array(std::move(choices)));
      p.set("key", js::Json::string(s.key));
      p.set("group", js::Json::string(s.group));
      p.set("text", js::Json::string(s.text));
      p.set("curve", numbers(s.curve));
      p.set("gradient", numbers(s.gradient));
      p.set("fileTypes", js::Json::string(s.fileTypes));
      p.set("description", js::Json::string(s.description));
      params.push_back(std::move(p));
    }
    o.set("params", js::Json::array(std::move(params)));
    list.push_back(std::move(o));
  }
  return js::stringify(js::Json::array(std::move(list)));
}

bool specs_from_json(std::string_view json, std::vector<EffectSpec>& out, std::string& error) {
  const std::optional<js::Json> j = js::parse(json);
  if (j && j->is_object() && j->at("error").is_string()) {
    error = j->at("error").str();
    return false;
  }
  if (!j || !j->is_array()) {
    error = "the plugin host's description is not a JSON list";
    return false;
  }
  out.clear();
  for (const js::Json& o : j->arr()) {
    EffectSpec e;
    e.matchName = str_of(o.at("matchName"));
    e.outFlags = static_cast<std::uint32_t>(num_of(o.at("outFlags")));
    e.version = static_cast<std::uint32_t>(num_of(o.at("version")));
    e.about = str_of(o.at("about"));
    if (o.at("params").is_array()) {
      for (const js::Json& p : o.at("params").arr()) {
        ParamSpec s;
        s.type = static_cast<PrParamType>(num_of(p.at("type")));
        s.id = static_cast<std::uint32_t>(num_of(p.at("id")));
        s.flags = static_cast<std::uint32_t>(num_of(p.at("flags")));
        s.name = str_of(p.at("name"));
        const std::vector<double> def = numbers_of(p.at("def"));
        for (std::size_t i = 0; i < 4 && i < def.size(); ++i) s.def.at(i) = def[i];
        const std::vector<double> range = numbers_of(p.at("range"));
        if (range.size() == 4) {
          s.validMin = range[0];
          s.validMax = range[1];
          s.sliderMin = range[2];
          s.sliderMax = range[3];
        }
        s.precision = static_cast<std::int32_t>(num_of(p.at("precision")));
        if (p.at("choices").is_array()) {
          for (const js::Json& c : p.at("choices").arr()) s.choices.push_back(str_of(c));
        }
        s.key = str_of(p.at("key"));
        s.group = str_of(p.at("group"));
        s.text = str_of(p.at("text"));
        s.curve = numbers_of(p.at("curve"));
        s.gradient = numbers_of(p.at("gradient"));
        s.fileTypes = str_of(p.at("fileTypes"));
        s.description = str_of(p.at("description"));
        e.params.push_back(std::move(s));
      }
    }
    if (e.matchName.empty()) {
      error = "the plugin host described an effect with no match name";
      return false;
    }
    out.push_back(std::move(e));
  }
  return true;
}

}  // namespace premation::plugins::oop
