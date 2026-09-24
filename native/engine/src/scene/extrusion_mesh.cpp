// src/core/scene/extrusionMesh.ts (+ shapesFromText.ts traceTextSpec /
// contoursToRuns), call for call. See extrusion_mesh.hpp.
#include "extrusion_mesh.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <list>
#include <mutex>
#include <string_view>
#include <unordered_map>
#include <utility>

#include "canvas.hpp"
#include "jsmath.hpp"
#include "json.hpp"
#include "numconv.hpp"
#include "text_paint.hpp"

namespace premation::scene {
namespace {

namespace jm = motion::js;
namespace rs = premation::raster;

std::string num(double v) { return js::number_to_string(v); }

double jmax(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return jm::max_of(std::span<const double>(v));
}
double jmin(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return jm::min_of(std::span<const double>(v));
}

/// A small LRU (extrusionMesh.ts `Lru`), mutex-guarded: the snapshot builder may
/// run on the engine's frame thread while a parity tool builds on another.
template <typename V>
class Lru {
 public:
  explicit Lru(std::size_t max) : max_(max) {}
  std::optional<V> get(const std::string& key) {
    const std::scoped_lock lk(m_);
    const auto it = map_.find(key);
    if (it == map_.end()) return std::nullopt;
    order_.splice(order_.end(), order_, it->second.second);
    return it->second.first;
  }
  void set(const std::string& key, V v) {
    const std::scoped_lock lk(m_);
    const auto it = map_.find(key);
    if (it != map_.end()) {
      order_.erase(it->second.second);
      map_.erase(it);
    }
    order_.push_back(key);
    map_.emplace(key, std::make_pair(std::move(v), std::prev(order_.end())));
    while (map_.size() > max_) {
      map_.erase(order_.front());
      order_.pop_front();
    }
  }
  void clear() {
    const std::scoped_lock lk(m_);
    map_.clear();
    order_.clear();
  }

 private:
  std::size_t max_;
  std::mutex m_;
  std::list<std::string> order_;
  std::unordered_map<std::string, std::pair<V, std::list<std::string>::iterator>> map_;
};

using RingsPtr = std::shared_ptr<const std::vector<mesh::Ring>>;
using MeshPtr = std::shared_ptr<const mesh::ExtrudedMesh>;

Lru<RingsPtr>& outlines() {
  static Lru<RingsPtr> c(256);
  return c;
}
Lru<MeshPtr>& meshes() {
  static Lru<MeshPtr> c(512);
  return c;
}

/// FNV mixer of hashPoints / hashGlyphs: `Math.round(v * q)` folded 16 bits at a time.
class Fnv {
 public:
  explicit Fnv(double q) : q_(q) {}
  void mix(double v) {
    const std::uint32_t r = jm::to_uint32(jm::round(v * q_));
    h_ ^= r & 0xffffU;
    h_ *= 16777619U;
    h_ ^= (r >> 16U) & 0xffffU;
    h_ *= 16777619U;
  }
  [[nodiscard]] std::string str() const { return jm::number_to_radix(static_cast<double>(h_), 36); }

 private:
  double q_;
  std::uint32_t h_ = 2166136261U;
};

double jnum(const Json& o, std::string_view k) {
  const Json& v = o.at(k);
  return v.is_number() ? v.num() : jm::kNaN;
}

std::string hash_points(const Json::Array& pts, bool asCorners) {
  Fnv h(16);
  for (const Json& p : pts) {
    const double x = jnum(p, "x");
    const double y = jnum(p, "y");
    h.mix(x);
    h.mix(y);
    h.mix(asCorners ? x : jnum(p, "inX"));
    h.mix(asCorners ? y : jnum(p, "inY"));
    h.mix(asCorners ? x : jnum(p, "outX"));
    h.mix(asCorners ? y : jnum(p, "outY"));
  }
  return std::to_string(pts.size()) + ":" + h.str();
}

std::string hash_glyphs(const Json::Array& glyphs) {
  Fnv h(4);
  for (const Json& g : glyphs) {
    h.mix(jnum(g, "dx"));
    h.mix(jnum(g, "dy"));
    h.mix(jnum(g, "scale") * 100);
    h.mix(jnum(g, "scaleY") * 100);
    h.mix(jnum(g, "rotation"));
    h.mix(jnum(g, "opacity") * 100);
    h.mix(jnum(g, "fillOpacity") * 100);
    h.mix(jnum(g, "tracking"));
    h.mix(jnum(g, "lineSpacing"));
    h.mix(jnum(g, "blur"));
    h.mix(jnum(g, "skew"));
    h.mix(g.at("strokeWidth").is_number() ? g.at("strokeWidth").num() : 0);
    if (!g.at("blurY").is_undefined()) h.mix(jnum(g, "blurY"));
    if (g.at("displayChar").is_string()) {
      // charCodeAt: UTF-16 code units.
      const std::string& s = g.at("displayChar").str();
      for (std::size_t i = 0; i < s.size();) {
        auto c = static_cast<unsigned char>(s[i]);
        std::uint32_t cp = c;
        std::size_t len = 1;
        if (c >= 0xF0U) { cp = c & 0x07U; len = 4; }
        else if (c >= 0xE0U) { cp = c & 0x0FU; len = 3; }
        else if (c >= 0xC0U) { cp = c & 0x1FU; len = 2; }
        for (std::size_t k = 1; k < len && i + k < s.size(); ++k) cp = (cp << 6U) | (static_cast<unsigned char>(s[i + k]) & 0x3FU);
        i += len;
        if (cp >= 0x10000U) {
          cp -= 0x10000U;
          h.mix(static_cast<double>(0xD800U + (cp >> 10U)));
          h.mix(static_cast<double>(0xDC00U + (cp & 0x3FFU)));
        } else {
          h.mix(static_cast<double>(cp));
        }
      }
    }
  }
  return std::to_string(glyphs.size()) + ":" + h.str();
}

bool blank(std::string_view s) {
  return std::ranges::all_of(s, [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; });
}

Json opt_s(const std::optional<std::string>& v) { return v ? Json::string(*v) : Json(); }
Json opt_n(const std::optional<double>& v) { return v ? Json::number(*v) : Json(); }

/// textPaintSpecFromLayer — the TextPaintSpec for the trace (undefined members omitted).
std::optional<Json> text_paint_spec(const RLayer& l, double width, double height) {
  const std::string text = l.text.value_or("Text");
  if (blank(text)) return std::nullopt;
  Json o = Json::object();
  o.set("text", Json::string(text));
  o.set("fontSize", Json::number(l.fontSize));
  o.set("color", Json::string("#ffffff"));
  o.set("width", Json::number(width));
  o.set("height", Json::number(height));
  const auto put = [&o](std::string_view k, Json v) {
    if (!v.is_undefined()) o.set(k, std::move(v));
  };
  put("fontFamily", opt_s(l.fontFamily));
  put("fontWeight", opt_s(l.fontWeight));
  put("fontWidth", opt_n(l.fontWidth));
  put("fontSlant", opt_n(l.fontSlant));
  put("fontStyle", opt_s(l.fontStyle));
  put("align", opt_s(l.align));
  put("letterSpacing", opt_n(l.letterSpacing));
  put("lineHeight", opt_n(l.lineHeight));
  put("paragraphSpacing", opt_n(l.paragraphSpacing));
  if (l.strokeOverFill) o.set("strokeOverFill", Json::boolean(*l.strokeOverFill));
  put("textTransform", opt_s(l.textTransform));
  put("fontVariant", opt_s(l.fontVariant));
  put("verticalAlign", opt_s(l.verticalAlign));
  put("verticalScale", opt_n(l.verticalScale));
  put("horizontalScale", opt_n(l.horizontalScale));
  put("baselineShift", opt_n(l.baselineShift));
  put("textStroke", opt_s(l.textStroke));
  put("textStrokeWidth", opt_n(l.textStrokeWidth));
  put("textExtras", l.textExtras);
  put("runs", l.runs);
  put("glyphs", l.glyphs);
  put("textPath", l.textPath);
  put("fontAxes", l.fontAxes);
  return o;
}

/// textSpecKey(spec).
std::string text_spec_key(const Json& s) {
  const auto a = [&s](std::string_view k) {
    const Json& v = s.at(k);
    return v.is_undefined() ? Json::null() : v;
  };
  const Json& runs = s.at("runs");
  const std::string runsKey = runs.is_array() && !runs.arr().empty() ? js::stringify(runs) : "";
  std::string pathKey;
  if (const Json& tp = s.at("textPath"); tp.is_object()) {
    const Json& pts = tp.at("points");
    const auto flag = [&tp](std::string_view k) { return tp.at(k).is_bool() && tp.at(k).b() ? "1" : "0"; };
    const Json& fm = tp.at("firstMargin");
    pathKey = hash_points(pts.is_array() ? pts.arr() : Json::Array{}, true) + "|" + flag("closed") + "|" +
              (fm.is_number() ? num(fm.num()) : std::string("undefined")) + "|" + flag("reversed") + "|" + flag("perpendicular");
  }
  Json arr = Json::array();
  auto& v = arr.arr_mut();
  v.push_back(a("text"));
  v.push_back(a("fontSize"));
  v.push_back(a("width"));
  v.push_back(a("height"));
  for (const char* k : {"fontFamily", "fontWeight", "fontWidth", "fontSlant", "fontStyle", "align", "letterSpacing", "lineHeight",
                        "paragraphSpacing", "textTransform", "fontVariant", "verticalAlign", "verticalScale", "horizontalScale",
                        "baselineShift"}) {
    v.push_back(a(k));
  }
  v.push_back(s.at("textStrokeWidth").is_number() ? s.at("textStrokeWidth") : Json::number(0));
  v.push_back(Json::string(s.at("textExtras").is_undefined() ? std::string() : js::stringify(s.at("textExtras"))));
  v.push_back(Json::string(runsKey));
  v.push_back(Json::string(pathKey));
  if (!s.at("fontAxes").is_undefined()) v.push_back(Json::string(js::stringify(s.at("fontAxes"))));
  return js::stringify(arr);
}

std::vector<mesh::BezRun> json_runs(const Json::Array& subs) {
  std::vector<mesh::BezRun> runs;
  for (const Json& s : subs) {
    mesh::BezRun r;
    r.open = false;
    for (const Json& p : s.at("points").arr()) {
      r.points.push_back({jnum(p, "x"), jnum(p, "y"), jnum(p, "inX"), jnum(p, "inY"), jnum(p, "outX"), jnum(p, "outY")});
    }
    runs.push_back(std::move(r));
  }
  return runs;
}

}  // namespace

const char* bevel_profile_name(mesh::BevelProfile p) noexcept {
  switch (p) {
    case mesh::BevelProfile::concave: return "concave";
    case mesh::BevelProfile::convex: return "convex";
    case mesh::BevelProfile::angular: break;
  }
  return "angular";
}

mesh::BevelProfile bevel_profile_of(std::string_view s) noexcept {
  if (s == "concave") return mesh::BevelProfile::concave;
  if (s == "convex") return mesh::BevelProfile::convex;
  return mesh::BevelProfile::angular;
}

api::RenderMeshRole api_role(mesh::MeshRole r) noexcept {
  switch (r) {
    case mesh::MeshRole::back: return api::RenderMeshRole::back;
    case mesh::MeshRole::side: return api::RenderMeshRole::side;
    case mesh::MeshRole::bevel: return api::RenderMeshRole::bevel;
    case mesh::MeshRole::front: break;
  }
  return api::RenderMeshRole::front;
}

void mesh_to_api(const std::string& key, const mesh::ExtrudedMesh& m, api::RenderExtrudedMesh& out) {
  static_assert(std::endian::native == std::endian::little, "FrameScene mesh bytes are little-endian");
  out.key = key;
  out.vertices.resize(m.vertices.size() * sizeof(float));
  std::memcpy(out.vertices.data(), m.vertices.data(), out.vertices.size());
  if (m.index32) {
    out.index_format = api::RenderIndexFormat::uint32;
    out.indices.resize(m.indices.size() * sizeof(std::uint32_t));
    std::memcpy(out.indices.data(), m.indices.data(), out.indices.size());
  } else {
    out.index_format = api::RenderIndexFormat::uint16;
    out.indices.resize(m.indices.size() * sizeof(std::uint16_t));
    for (std::size_t i = 0; i < m.indices.size(); ++i) {
      const auto v = static_cast<std::uint16_t>(m.indices[i]);
      std::memcpy(out.indices.data() + (i * 2), &v, 2);
    }
  }
  out.ranges.clear();
  for (const mesh::MeshRange& r : m.ranges) {
    api::RenderMeshRange ar;
    ar.role = api_role(r.role);
    ar.first = r.first;
    ar.count = r.count;
    out.ranges.push_back(std::move(ar));
  }
}

void clear_extrusion_mesh_caches() {
  outlines().clear();
  meshes().clear();
}

std::vector<mesh::Ring> trace_text_rings(const Json& spec, double width, double height, int oversample,
                                         const rs::CanvasOptions& canvas) {
  // rasterizeTextSpec.
  if (!spec.at("text").is_string() || blank(spec.at("text").str())) return {};
  const double os = oversample;
  const double wd = std::ceil(width * os);
  const double hd = std::ceil(height * os);
  if (!(wd >= 2) || !(hd >= 2)) return {};
  const auto w = static_cast<std::uint32_t>(wd);
  const auto h = static_cast<std::uint32_t>(hd);
  Json painted = spec;
  painted.set("color", Json::string("#ffffff"));
  painted.set("textStroke", Json::string("#ffffff"));
  rs::json::Value rspec;
  std::string err;
  if (!rs::json::parse(js::stringify(painted), rspec, err)) return {};
  const auto ctx = rs::Canvas2D::make(w, h, canvas);
  ctx->scale(os, os);
  std::vector<std::string> unsupported;
  rs::paint_text_in_box(*ctx, rspec, unsupported);
  const std::vector<std::uint8_t> px = ctx->pixels();
  // traceTextSpec.
  mesh::TraceOptions to;
  to.threshold = 128;
  to.tolerance = 0.375 * os;
  to.minArea = 6 * os;
  const auto contours = mesh::trace_bitmap(px, static_cast<int>(w), static_cast<int>(h), 4, to);
  // contoursToRuns(contours, w / 2, h / 2, scale).
  const double cx = wd / 2;
  const double cy = hd / 2;
  std::vector<mesh::BezRun> runs;
  for (const auto& c : contours) {
    if (c.points.size() < 3) continue;
    std::vector<mesh::Pt2> pts;
    pts.reserve(c.points.size());
    for (const auto& p : c.points) pts.push_back({(p.x - cx) / os, (p.y - cy) / os});
    runs.push_back({mesh::smooth_contour(pts, 0.55, 38.0), false});
  }
  if (runs.empty()) return {};
  return mesh::bezier_runs_to_rings(runs, 0.5);
}

std::optional<ExtrusionOutline> extrusion_outline_for(const RLayer& layer, double width, double height,
                                                      const rs::CanvasOptions* canvas) {
  const double W = jmax(1, jm::round(width * 100) / 100);
  const double H = jmax(1, jm::round(height * 100) / 100);
  const auto cached = [](const std::string& key, auto make) -> std::optional<ExtrusionOutline> {
    std::optional<RingsPtr> hit = outlines().get(key);
    if (!hit) {
      hit = make();
      outlines().set(key, *hit);
    }
    if (!*hit) return std::nullopt;
    return ExtrusionOutline{key, *hit};
  };

  if (layer.kind == LayerKind::shape && layer.primitive == "ellipse") {
    return cached("ellipse:" + num(W) + "x" + num(H),
                  [&] { return std::make_shared<const std::vector<mesh::Ring>>(mesh::ellipse_outline(W, H)); });
  }

  if (layer.kind == LayerKind::shape && layer.primitive == "path") {
    // layerSubpaths(layer).filter(closed, >= 3 points).
    Json::Array subs;
    if (layer.subpaths.is_array() && !layer.subpaths.arr().empty()) {
      subs = layer.subpaths.arr();
    } else if (layer.pathPoints.is_array() && !layer.pathPoints.arr().empty()) {
      Json s = Json::object();
      s.set("points", layer.pathPoints);
      s.set("open", Json::boolean(layer.pathOpen));
      subs.push_back(std::move(s));
    }
    std::erase_if(subs, [](const Json& s) {
      return (s.at("open").is_bool() && s.at("open").b()) || !s.at("points").is_array() || s.at("points").arr().size() < 3;
    });
    if (subs.empty()) return std::nullopt;
    std::string key = "path:";
    for (std::size_t i = 0; i < subs.size(); ++i) key += (i != 0 ? "/" : "") + hash_points(subs[i].at("points").arr(), false);
    key += ":" + num(W) + "x" + num(H);
    return cached(key, [&]() -> RingsPtr {
      auto rings = mesh::bezier_runs_to_rings(json_runs(subs), 0.6);
      if (rings.empty()) return nullptr;
      return std::make_shared<const std::vector<mesh::Ring>>(std::move(rings));
    });
  }

  if (layer.kind == LayerKind::text) {
    const std::optional<Json> spec = text_paint_spec(layer, W, H);
    if (!spec) return std::nullopt;
    const bool animated = layer.glyphs.is_array() && !layer.glyphs.arr().empty();
    const std::string key = "text:" + text_spec_key(*spec) + (animated ? "|g" + hash_glyphs(layer.glyphs.arr()) : "");
    if (canvas == nullptr) {
      // No fonts to trace with: only a cached outline can serve.
      std::optional<RingsPtr> hit = outlines().get(key);
      if (!hit || !*hit) return std::nullopt;
      return ExtrusionOutline{key, *hit};
    }
    return cached(key, [&]() -> RingsPtr {
      auto rings = trace_text_rings(*spec, W, H, animated ? 2 : 4, *canvas);
      if (rings.empty()) return nullptr;
      return std::make_shared<const std::vector<mesh::Ring>>(std::move(rings));
    });
  }

  // Rect-shaped content.
  std::array<double, 4> r{layer.cornerRadius, layer.cornerRadius, layer.cornerRadius, layer.cornerRadius};
  std::string rk;
  if (layer.cornerRadii) {
    r = *layer.cornerRadii;
    for (std::size_t i = 0; i < 4; ++i) rk += (i != 0 ? "," : "") + num(jm::round(r[i] * 10) / 10);
  } else {
    rk = num(jm::round(layer.cornerRadius * 10) / 10);
  }
  return cached("rect:" + num(W) + "x" + num(H) + ":" + rk,
                [&] { return std::make_shared<const std::vector<mesh::Ring>>(mesh::rect_outline(W, H, r)); });
}

std::optional<KeyedMesh> extrusion_mesh_for(const ExtrusionOutline& outline, double width, double height,
                                            const ExtrusionMeshRequest& req) {
  const double depth = jm::round(req.depth * 100) / 100;
  const double bevel = jm::round(req.bevel * 100) / 100;
  if (depth <= 0) return std::nullopt;
  const double holeScale = jm::round(jmax(0, jmin(1, req.holeBevelScale)) * 1000) / 1000;
  const std::string key = outline.key + "|d" + num(depth) + "|b" + num(bevel) + "|" + bevel_profile_name(req.bevelStyle) +
                          (req.frontCap ? "|f" : "") + (!req.frontBevel ? "|nfb" : "") + (holeScale != 1 ? "|h" + num(holeScale) : "");
  std::optional<MeshPtr> m = meshes().get(key);
  if (!m) {
    mesh::ExtrudeOptions o;
    o.depth = depth;
    o.bevel = bevel;
    o.bevelStyle = req.bevelStyle;
    o.frontCap = req.frontCap;
    o.frontBevel = req.frontBevel;
    o.holeBevelScale = holeScale;
    o.bevelSegments = req.bevelStyle == mesh::BevelProfile::angular ? 1 : 5;
    o.uvBox = mesh::Box{-width / 2, -height / 2, width, height};
    auto built = mesh::extrude_outline(*outline.rings, o);
    m = built ? std::make_shared<const mesh::ExtrudedMesh>(std::move(*built)) : nullptr;
    meshes().set(key, *m);
  }
  if (!*m) return std::nullopt;
  return KeyedMesh{key, *m};
}

}  // namespace premation::scene
