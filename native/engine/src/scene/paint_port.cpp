// Paint strokes in the scene builder (D2w) — see paint_port.hpp.

#include "paint_port.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <map>

#include "anim.hpp"
#include "fxstate.hpp"
#include "paint_raster.hpp"

namespace premation::scene {
namespace {

constexpr double kEps = 1e-6;

bool is_percent_key(std::string_view k) {
  // paintProps.ts PAINT_PERCENT_KEYS.
  return k == "start" || k == "end" || k == "hardness" || k == "roundness" || k == "spacing" || k == "opacity" || k == "flow";
}

/// strokeLiveAt.
bool stroke_live_at(const Json& s, double t) {
  if (s.at("visible").is_bool() && !s.at("visible").b()) return false;
  if (s.at("inPoint").is_number() && t < s.at("inPoint").num() - kEps) return false;
  if (s.at("outPoint").is_number() && t >= s.at("outPoint").num() - kEps) return false;
  return true;
}

double clamp01(double v) { return std::max(0.0, std::min(1.0, v)); }

std::string hex2(double v) {
  static constexpr std::string_view kHex = "0123456789abcdef";
  const auto b = static_cast<int>(std::floor(clamp01(v) * 255 + 0.5));  // Math.round
  std::string s;
  s.push_back(kHex[static_cast<std::size_t>(b >> 4)]);
  s.push_back(kHex[static_cast<std::size_t>(b & 15)]);
  return s;
}

std::array<double, 3> parse_hex(const std::string& c) {
  std::string_view v = c;
  if (v.starts_with('#')) v.remove_prefix(1);
  if (v.size() < 6) return {1, 1, 1};
  int n = 0;
  for (std::size_t i = 0; i < 6; ++i) {
    const char ch = v[i];
    const int d = ch >= '0' && ch <= '9' ? ch - '0' : ch >= 'a' && ch <= 'f' ? ch - 'a' + 10 : ch >= 'A' && ch <= 'F' ? ch - 'A' + 10 : -1;
    if (d < 0) return {1, 1, 1};
    n = n * 16 + d;
  }
  return {((n >> 16) & 255) / 255.0, ((n >> 8) & 255) / 255.0, (n & 255) / 255.0};
}

bool is_points(const Json& v) {
  return v.is_array() && !v.arr().empty() && v.arr()[0].is_object() && v.arr()[0].has("x");
}

}  // namespace

double paint_pad(const Json& paint) {
  if (!paint.is_object()) return 0;
  raster::json::Value v;
  std::string error;
  if (!raster::json::parse(js::stringify(paint), v, error)) return 0;
  return raster::paint_reach(v);
}

LayerPaint resolve_layer_paint(const doc::Document& d, const doc::Node& n, double layerT, const Values& a) {
  LayerPaint out;
  const auto stored = doc::read_node_paint(n);
  if (!stored || stored->empty()) return out;
  // bucketPaintValues: the frame's paint.<id>.* values by stroke.
  std::map<std::string, std::map<std::string, double, std::less<>>, std::less<>> buckets;
  for (const auto& [prop, v] : a.items()) {
    if (!prop.starts_with("paint.")) continue;
    if (const auto num = doc::parse_paint_prop_path(prop)) {
      buckets[num->strokeId][num->key] = v;
    } else if (const auto col = doc::parse_paint_color_path(prop)) {
      buckets[col->strokeId][std::string("color_") + col->channel] = v;
    }
  }
  Json strokes = Json::array();
  for (const Json& s : *stored) {
    if (!stroke_live_at(s, layerT)) continue;
    const std::string id = s.at("id").is_string() ? s.at("id").str() : "";
    const auto bt = buckets.find(id);
    const std::map<std::string, double, std::less<>>* tracks = bt == buckets.end() ? nullptr : &bt->second;
    // resolveStrokeAt.
    Json livePath;
    if (const doc::DataTrack* dt = doc::anim_data_track(d, n.id, "paint." + id + ".path")) {
      if (auto v = doc::sample_data_track(*dt, layerT)) livePath = std::move(*v);
    }
    const bool clone = s.at("mode").is_string() && s.at("mode").str() == "clone";
    const std::string src = s.at("cloneSourceId").is_string() ? s.at("cloneSourceId").str() : "";
    const bool sourceOther = clone && !src.empty() && src != n.id;
    const bool timeWarp = clone && ((s.at("cloneLockTime").is_bool() && s.at("cloneLockTime").b()) ||
                                    (s.at("cloneTimeShift").is_number() && s.at("cloneTimeShift").num() != 0) || sourceOther ||
                                    (tracks != nullptr && (tracks->contains("cloneTimeShift") || tracks->contains("cloneTime"))));
    if (timeWarp) {
      out.unported.emplace_back("paint clone source time / another layer as the clone source");
      continue;
    }
    const bool selfNamed = clone && !src.empty() && src == n.id;
    Json r = s;
    if (selfNamed) r.erase("cloneSourceId");
    if (is_points(livePath)) {
      r.set("points", livePath);
      r.erase("pressure");
      r.erase("tiltX");
      r.erase("tiltY");
    }
    if (tracks != nullptr) {
      const auto get = [&](const char* k) -> std::optional<double> {
        const auto it = tracks->find(k);
        if (it == tracks->end() || !std::isfinite(it->second)) return std::nullopt;
        return is_percent_key(k) ? it->second / 100 : it->second;
      };
      if (auto v = get("start")) r.set("start", Json::number(clamp01(*v)));
      if (auto v = get("end")) r.set("end", Json::number(clamp01(*v)));
      if (auto v = get("diameter")) r.set("size", Json::number(std::max(0.0, *v)));
      if (auto v = get("angle")) r.set("angle", Json::number(*v));
      if (auto v = get("hardness")) r.set("hardness", Json::number(clamp01(*v)));
      if (auto v = get("roundness")) r.set("roundness", Json::number(std::max(0.01, clamp01(*v))));
      if (auto v = get("spacing")) r.set("spacing", Json::number(std::max(0.01, *v)));
      if (auto v = get("opacity")) r.set("opacity", Json::number(clamp01(*v)));
      if (auto v = get("flow")) r.set("flow", Json::number(clamp01(*v)));
      if (tracks->contains("color_r") || tracks->contains("color_g") || tracks->contains("color_b")) {
        const auto base = parse_hex(s.at("color").is_string() ? s.at("color").str() : "");
        const auto ch = [&](const char* k, double fb) {
          const auto it = tracks->find(k);
          return it == tracks->end() ? fb : it->second;
        };
        r.set("color", Json::string("#" + hex2(ch("color_r", base[0])) + hex2(ch("color_g", base[1])) + hex2(ch("color_b", base[2]))));
      }
      bool anyTransform = false;
      for (const char* k : {"anchorX", "anchorY", "positionX", "positionY", "scale", "rotation"}) anyTransform = anyTransform || tracks->contains(k);
      const Json& pts = r.at("points");
      const double fx = is_points(pts) ? pts.arr()[0].at("x").num() : 0;
      const double fy = is_points(pts) ? pts.arr()[0].at("y").num() : 0;
      if (anyTransform) {
        const Json& st = s.at("transform");
        const auto b = [&](const char* k, double fb) { return st.is_object() && st.at(k).is_number() ? st.at(k).num() : fb; };
        Json tr = Json::object();
        tr.set("anchorX", Json::number(get("anchorX").value_or(b("anchorX", fx))));
        tr.set("anchorY", Json::number(get("anchorY").value_or(b("anchorY", fy))));
        tr.set("x", Json::number(get("positionX").value_or(b("x", fx))));
        tr.set("y", Json::number(get("positionY").value_or(b("y", fy))));
        tr.set("scale", Json::number(get("scale").value_or(b("scale", 100))));
        tr.set("rotation", Json::number(get("rotation").value_or(b("rotation", 0))));
        r.set("transform", std::move(tr));
      }
      if (clone && (tracks->contains("clonePositionX") || tracks->contains("clonePositionY"))) {
        const double sx = get("clonePositionX").value_or(fx + (s.at("cloneOffsetX").is_number() ? s.at("cloneOffsetX").num() : 0));
        const double sy = get("clonePositionY").value_or(fy + (s.at("cloneOffsetY").is_number() ? s.at("cloneOffsetY").num() : 0));
        r.set("cloneOffsetX", Json::number(sx - fx));
        r.set("cloneOffsetY", Json::number(sy - fy));
      }
    }
    strokes.arr_mut().push_back(std::move(r));
  }
  const bool onTransparent = doc::paint_on_transparent(n);
  if (strokes.arr().empty()) {
    if (onTransparent) {
      out.paint = Json::object();
      out.paint.set("strokes", Json::array());
      out.paint.set("onTransparent", Json::boolean(true));
    }
    return out;
  }
  out.paint = Json::object();
  out.paint.set("strokes", std::move(strokes));
  if (onTransparent) out.paint.set("onTransparent", Json::boolean(true));
  return out;
}

}  // namespace premation::scene
