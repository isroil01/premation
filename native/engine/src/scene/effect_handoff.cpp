#include "effect_handoff.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <string_view>

#include "effects_port.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "scene_math.hpp"

namespace premation::scene {
namespace {

namespace mjs = motion::js;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

std::string type_of(const Json& e) { return e.at("type").is_string() ? e.at("type").str() : std::string(); }

struct MPt {
  double x, y, inX, inY, outX, outY;
};

/// A point field read as JavaScript reads it (`undefined` arithmetic is NaN).
double field(const Json& p, std::string_view k) {
  const Json& v = p.at(k);
  return v.is_number() ? v.num() : kNaN;
}

/// mask.ts expandMaskPoints.
std::vector<MPt> expand_mask_points(const std::vector<MPt>& points, double expansion) {
  if (!(expansion != 0) || std::abs(expansion) < 1e-4 || points.size() < 2) return points;
  const std::size_t n = points.size();
  std::vector<MPt> out;
  out.reserve(n);
  const auto len_or_1 = [](double l) { return l == 0 || std::isnan(l) ? 1.0 : l; };
  for (std::size_t i = 0; i < n; ++i) {
    const MPt& curr = points[i];
    const MPt& prev = points[(i + n - 1) % n];
    const MPt& next = points[(i + 1) % n];
    double vx1 = curr.x - curr.inX;
    double vy1 = curr.y - curr.inY;
    if (hypot2(vx1, vy1) < 1e-4) {
      vx1 = curr.x - prev.x;
      vy1 = curr.y - prev.y;
    }
    const double l1 = len_or_1(hypot2(vx1, vy1));
    const double nx1 = vy1 / l1;
    const double ny1 = -vx1 / l1;
    double vx2 = curr.outX - curr.x;
    double vy2 = curr.outY - curr.y;
    if (hypot2(vx2, vy2) < 1e-4) {
      vx2 = next.x - curr.x;
      vy2 = next.y - curr.y;
    }
    const double l2 = len_or_1(hypot2(vx2, vy2));
    const double nx2 = vy2 / l2;
    const double ny2 = -vx2 / l2;
    const double nx = (nx1 + nx2) / 2;
    const double ny = (ny1 + ny2) / 2;
    const double nLen = len_or_1(hypot2(nx, ny));
    const double factor = expansion / std::max(0.2, nLen);
    const double dx = nx * factor;
    const double dy = ny * factor;
    out.push_back({curr.x + dx, curr.y + dy, curr.inX + dx, curr.inY + dy, curr.outX + dx, curr.outY + dy});
  }
  return out;
}

/// mask.ts maskPathPolyline(path, 16), flat [x0, y0, x1, y1, …].
std::vector<double> mask_path_polyline(const Json& path) {
  std::vector<MPt> pts;
  if (path.at("points").is_array()) {
    for (const Json& p : path.at("points").arr()) {
      pts.push_back({field(p, "x"), field(p, "y"), field(p, "inX"), field(p, "inY"), field(p, "outX"), field(p, "outY")});
    }
  }
  const Json& ex = path.at("expansion");
  pts = expand_mask_points(pts, ex.is_number() ? ex.num() : 0);
  const std::size_t n = pts.size();
  std::vector<double> out;
  if (n < 2) return out;
  const bool closed = path.at("closed").is_bool() && path.at("closed").b();
  const std::size_t last = closed ? n : n - 1;
  constexpr int kSamples = 16;
  out.reserve(2 + last * kSamples * 2);
  out.push_back(pts[0].x);
  out.push_back(pts[0].y);
  for (std::size_t i = 0; i < last; ++i) {
    const MPt& a = pts[i];
    const MPt& b = pts[(i + 1) % n];
    for (int s = 1; s <= kSamples; ++s) {
      const double t = static_cast<double>(s) / kSamples;
      const double u = 1 - t;
      out.push_back(u * u * u * a.x + 3 * u * u * t * a.outX + 3 * u * t * t * b.inX + t * t * t * b.x);
      out.push_back(u * u * u * a.y + 3 * u * u * t * a.outY + 3 * u * t * t * b.inY + t * t * t * b.y);
    }
  }
  return out;
}

Json numbers(const std::vector<double>& v) {
  Json a = Json::array();
  a.arr_mut().reserve(v.size());
  for (const double x : v) a.arr_mut().push_back(Json::number(x));
  return a;
}

/// JavaScript truthiness of a stored flag.
bool truthy(const Json& v) {
  if (v.is_bool()) return v.b();
  if (v.is_number()) return v.num() != 0 && !std::isnan(v.num());
  if (v.is_string()) return !v.str().empty();
  return v.is_object() || v.is_array();
}

/// strokePaint.ts MASK_MODE_CODES.indexOf(mode), clamped to 0.
double mode_code(const Json& mode) {
  static constexpr std::array<std::string_view, 7> k = {"none", "add", "subtract", "intersect", "lighten", "darken", "difference"};
  if (!mode.is_string()) return 0;
  const auto it = std::ranges::find(k, mode.str());
  return it == k.end() ? 0 : static_cast<double>(it - k.begin());
}

/// The mask the layer is read at this frame (readNodeMaskAt ?? readNodeMask).
Json mask_now(const doc::Node& n, std::optional<double> t) {
  const Json m = t ? read_node_mask_at(n, *t) : Json{};
  return m.is_undefined() ? doc::read_node_mask(n).value_or(Json{}) : m;
}

}  // namespace

void resolve_effect_handoffs(std::vector<Json>& effects, const doc::Node& n, const Values& a, std::optional<double> layerTimeSec,
                             std::vector<std::string>& unported) {
  std::optional<Json> tracked;  // effectMaskNow, resolved once
  for (Json& e : effects) {
    const std::string t = type_of(e);
    if (t == "beam-path") continue;  // snapshot_build.cpp's own block
    Json p = doc::params_of(e);
    bool extra = false;
    const bool allMasks = t == "path-stroke" || t == "scribble" || (t == "vegas" && p.at("allMasks").is_bool() && p.at("allMasks").b());
    if (allMasks) {
      if (!tracked) tracked = apply_mask_property_tracks(mask_now(n, layerTimeSec), a);
      std::vector<double> meta;
      std::vector<double> xy;
      const Json& paths = tracked->at("paths");
      double pick = -1;
      const std::string pickId = p.at("pathMaskId").is_string() ? p.at("pathMaskId").str() : "";
      if (paths.is_array()) {
        std::size_t i = 0;
        for (const Json& mp : paths.arr()) {
          const std::vector<double> flat = mask_path_polyline(mp);
          meta.push_back(static_cast<double>(flat.size() >> 1U));
          meta.push_back(truthy(mp.at("closed")) ? 1 : 0);
          meta.push_back(mode_code(mp.at("mode")));
          meta.push_back(truthy(mp.at("inverted")) ? 1 : 0);
          xy.insert(xy.end(), flat.begin(), flat.end());
          if (pick < 0 && !pickId.empty() && mp.at("id").is_string() && mp.at("id").str() == pickId) pick = static_cast<double>(i);
          ++i;
        }
      }
      p.set("maskPathsMeta", numbers(meta));
      p.set("maskPathsXY", numbers(xy));
      p.set("pathMaskIndex", Json::number(pickId.empty() ? -1 : pick));
      extra = true;
    }
    if (t == "scribble") {
      // scribbleWiggleState(p, layerTimeSec).
      const Json& wt = p.at("wiggleType");
      const double type = wt.is_number() ? mjs::round(wt.num()) : 2;
      const double wps = p.at("wigglesPerSecond").is_number() ? p.at("wigglesPerSecond").num() : 0;
      double state = 0;
      if (layerTimeSec && wps > 0 && type != 0) {
        state = *layerTimeSec * wps;
        if (type == 1) state = std::floor(state + 1e-9);
      }
      p.set("wiggleState", Json::number(state));
      extra = true;
    }
    if (t == "write-on" && effect_enabled(e)) {
      const Json& mode = p.at("writeOnMode");
      if (mode.is_number() && mjs::round(mode.num()) == 0) unported.emplace_back("Write-on brush form (dab history)");
    }
    const Json& pm = p.at("pathMaskId");
    if (!pm.is_string() || pm.str().empty()) {
      if (extra) e.set("params", std::move(p));
      continue;
    }
    const Json m = mask_now(n, layerTimeSec);
    const Json* path = nullptr;
    if (m.at("paths").is_array()) {
      for (const Json& mp : m.at("paths").arr()) {
        if (mp.at("id").is_string() && mp.at("id").str() == pm.str()) {
          path = &mp;
          break;
        }
      }
    }
    p.set("pathPoints", numbers(path != nullptr ? mask_path_polyline(*path) : std::vector<double>{}));
    p.set("pathClosed", Json::boolean(path != nullptr && path->at("closed").is_bool() && path->at("closed").b()));
    e.set("params", std::move(p));
  }
}

}  // namespace premation::scene
