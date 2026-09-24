#include "handlers_strokes.hpp"

#include <algorithm>
#include <cmath>
#include <set>

#include "anim.hpp"
#include "fxstate.hpp"
#include "strokes.hpp"
#include "fields.hpp"
#include "time_conv.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

// ── paint strokes — src/core/engine/paintStrokes.ts ─────────────────────

/// `parsePaintObject`: `text` as a JSON object, else invalidArgument.
Json parse_paint_object(const std::string& text, const std::string& what, const std::string& layer) {
  auto v = js::parse(text);
  if (!v) fail(ErrorCode::invalid_argument, "'" + what + "' is not valid json", {.layer = layer});
  if (!v->is_object()) fail(ErrorCode::invalid_argument, "'" + what + "' must be a json object", {.layer = layer});
  return std::move(*v);
}

/// `checkPaintPoints`: a non-empty array of objects with finite x / y.
void check_paint_points(const Json& v, const std::string& what, const std::string& layer) {
  bool ok = v.is_array() && !v.arr().empty();
  if (ok) {
    for (const Json& p : v.arr()) ok = ok && p.is_object() && p.at("x").is_finite_number() && p.at("y").is_finite_number();
  }
  if (!ok) fail(ErrorCode::invalid_argument, "'" + what + "' must be a non-empty array of finite {x, y}", {.layer = layer});
}

/// `{x, y}` copies of each point (`points.map((p) => ({x: p.x, y: p.y}))`).
Json xy_points(const Json& pts) {
  Json out = Json::array();
  for (const Json& p : pts.arr()) {
    Json q = Json::object();
    q.set("x", p.at("x"));
    q.set("y", p.at("y"));
    out.arr_mut().push_back(std::move(q));
  }
  return out;
}

struct PaintHit {
  std::vector<Json> strokes;
  bool onTransparent = false;
  std::size_t index = 0;
};

/// `paintStrokeOrFail`.
PaintHit paint_stroke_or_fail(const Node& n, const std::string& layer, const std::string& id) {
  auto strokes = read_node_paint(n);
  if (strokes) {
    for (std::size_t i = 0; i < strokes->size(); ++i) {
      if ((*strokes)[i].at("id").is_string() && (*strokes)[i].at("id").str() == id) {
        return PaintHit{std::move(*strokes), paint_on_transparent(n), i};
      }
    }
  }
  fail(ErrorCode::not_found, "layer '" + layer + "' has no paint stroke '" + id + "'", {.layer = layer, .path = "paint/" + id});
}

/// `storePaint` (paintStrokes.ts `writePaint` without the notifications).
void store_paint(Document& d, const std::string& layer, std::vector<Json> strokes, bool onTransparent) {
  Json cfg = Json::object();
  const bool keep = !strokes.empty() || onTransparent;
  cfg.set("strokes", Json::array(std::move(strokes)));
  if (keep && onTransparent) cfg.set("onTransparent", Json::boolean(true));
  sg_set_fx(d, layer, "paint", std::move(cfg));
}

std::string paint_path_track(const std::string& id) { return "paint." + id + ".path"; }

/// `patchStroke`: merge (a null clears the key), renormalise.
void patch_stroke(Document& d, const std::string& layer, PaintHit hit, const Json& patch) {
  const Json& s = hit.strokes[hit.index];
  Json merged = spread(s, patch);
  for (const auto& m : patch.obj()) {
    if (m.value.is_null()) merged.erase(m.key);
  }
  const std::string id = s.at("id").str();
  hit.strokes[hit.index] = normalize_paint_stroke(merged, id);
  store_paint(d, layer, std::move(hit.strokes), hit.onTransparent);
}

/// `keyPaintPath` — AnimationEngine.setDataKeyframe(layer, prop, 'points', t, points) with
/// upsertDataKeyframe's merge: a key already at `t` keeps its other fields.
void key_paint_path(HCtx& x, const std::string& layer, const std::string& id, api::Time flicks, const Json& points) {
  const std::string prop = paint_path_track(id);
  const double t = comp_to_keyframe_time(x.d, x.view, layer, flicks_to_seconds(flicks), prop);
  const DataTrack* cur = anim_data_track(x.d, layer, prop);
  DataTrack next = cur != nullptr ? *cur : DataTrack{"points", {}};
  DataKey k;
  k.t = t;
  k.value = xy_points(points);
  const auto it = std::find_if(next.keys.begin(), next.keys.end(), [t](const DataKey& e) { return e.t == t; });
  if (it != next.keys.end()) {
    DataKey m = *it;
    m.value = std::move(k.value);
    k = std::move(m);
  }
  std::erase_if(next.keys, [t](const DataKey& e) { return e.t == t; });
  next.keys.push_back(std::move(k));
  std::stable_sort(next.keys.begin(), next.keys.end(), [](const DataKey& a, const DataKey& b) { return a.t < b.t; });
  anim_set_data_track(x.d, layer, prop, std::move(next));
}

/// `paintStrokeProps`: every track / expression / data track under `paint.<id>.` for the ids.
std::set<std::string> paint_stroke_props(const Document& d, const std::string& layer, const std::set<std::string>& ids) {
  std::set<std::string> out;
  const NodeAnim* a = d.anim(layer);
  if (a == nullptr) return out;
  auto scan = [&](const std::string& p) {
    if (!p.starts_with("paint.")) return;
    const std::size_t dot = p.find('.', 6);
    if (dot == std::string::npos || dot == 6) return;
    if (ids.contains(p.substr(6, dot - 6))) out.insert(p);
  };
  for (const auto& [p, v] : a->tracks) scan(p);
  for (const auto& [p, v] : a->exprs) scan(p);
  for (const auto& [p, v] : a->data) scan(p);
  return out;
}

}  // namespace

ResultOf<api::RemoveStroke> handle(const api::RemoveStroke& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  const auto apply = plan_remove_stroke(x.d, c.layer, static_cast<double>(c.index));
  x.label = "Remove Stroke " + std::to_string(static_cast<std::uint64_t>(c.index) + 1);
  apply();
  return {};
}

ResultOf<api::AddPaintStroke> handle(const api::AddPaintStroke& c, HCtx& x) {
  const std::string& layer = c.layer;
  const Node& n = require_layer(x.d, layer);
  const Json raw = parse_paint_object(c.stroke, "stroke", layer);
  if (raw.has("id")) fail(ErrorCode::invalid_argument, "a new paint stroke takes no id (the engine mints it)", {.layer = layer});
  check_paint_points(raw.at("points"), "stroke.points", layer);
  for (const api::PaintKeyInit& k : c.keys) {
    if (!parse_paint_prop_path("paint.x." + k.param)) {
      fail(ErrorCode::invalid_argument, "'" + k.param + "' is not a paint stroke param", {.layer = layer});
    }
    if (!std::isfinite(k.time) || !std::isfinite(k.value)) {
      fail(ErrorCode::invalid_argument, "the '" + k.param + "' key must be finite", {.layer = layer});
    }
  }
  std::vector<Json> strokes = read_node_paint(n).value_or(std::vector<Json>{});
  const bool onTransparent = paint_on_transparent(n);
  const std::string id = x.mint_group_id("pstroke_", [&](const std::string& v) {
    return std::any_of(strokes.begin(), strokes.end(), [&](const Json& s) { return s.at("id").is_string() && s.at("id").str() == v; });
  });
  x.label = "Paint Stroke";
  strokes.push_back(normalize_paint_stroke(raw, id));
  store_paint(x.d, layer, std::move(strokes), onTransparent);
  for (const api::PaintKeyInit& k : c.keys) anim_set_keyframe(x.d, layer, "paint." + id + "." + k.param, k.time, k.value);
  api::PaintStrokeId out;
  out.stroke = id;
  return out;
}

ResultOf<api::UpdatePaintStroke> handle(const api::UpdatePaintStroke& c, HCtx& x) {
  const std::string& layer = c.layer;
  PaintHit hit = paint_stroke_or_fail(require_layer(x.d, layer), layer, c.stroke);
  const Json patch = parse_paint_object(c.patch, "patch", layer);
  if (patch.has("id")) fail(ErrorCode::invalid_argument, "a paint stroke's id cannot be patched", {.layer = layer, .path = "paint/" + c.stroke});
  if (patch.has("points")) check_paint_points(patch.at("points"), "patch.points", layer);
  x.label = "Edit Paint Stroke";
  patch_stroke(x.d, layer, std::move(hit), patch);
  return {};
}

ResultOf<api::RemovePaintStrokes> handle(const api::RemovePaintStrokes& c, HCtx& x) {
  const std::string& layer = c.layer;
  const Node& n = require_layer(x.d, layer);
  if (c.strokes.empty()) fail(ErrorCode::invalid_argument, "no paint strokes given", {.layer = layer});
  std::optional<PaintHit> hit;
  for (const std::string& id : c.strokes) {
    PaintHit h = paint_stroke_or_fail(n, layer, id);
    if (!hit) hit = std::move(h);
  }
  const std::set<std::string> ids(c.strokes.begin(), c.strokes.end());
  x.label = ids.size() == 1 ? std::string("Delete Paint Stroke") : "Delete " + std::to_string(ids.size()) + " Paint Strokes";
  drop_track_props(x.d, layer, paint_stroke_props(x.d, layer, ids));
  std::vector<Json> kept;
  for (Json& s : hit->strokes) {
    if (!ids.contains(s.at("id").str())) kept.push_back(std::move(s));
  }
  store_paint(x.d, layer, std::move(kept), hit->onTransparent);
  return {};
}

ResultOf<api::SetPaintOnTransparent> handle(const api::SetPaintOnTransparent& c, HCtx& x) {
  struct Plan {
    std::string layer;
    std::vector<Json> strokes;
  };
  std::vector<Plan> plans;
  for (const std::string& layer : c.layers) {
    auto strokes = read_node_paint(require_layer(x.d, layer));
    if (!strokes) fail(ErrorCode::not_found, "layer '" + layer + "' has no paint strokes", {.layer = layer, .path = "paint"});
    plans.push_back(Plan{layer, std::move(*strokes)});
  }
  x.label = "Paint on Transparent";
  for (Plan& p : plans) store_paint(x.d, p.layer, std::move(p.strokes), c.on);
  return {};
}

ResultOf<api::SetPaintStrokePath> handle(const api::SetPaintStrokePath& c, HCtx& x) {
  const std::string& layer = c.layer;
  PaintHit hit = paint_stroke_or_fail(require_layer(x.d, layer), layer, c.stroke);
  auto pts = js::parse(c.points);
  if (!pts) fail(ErrorCode::invalid_argument, "'points' is not valid json", {.layer = layer});
  check_paint_points(*pts, "points", layer);
  check_time(c.time);
  x.label = "Replace Paint Path";
  if (anim_is_data_animated(x.d, layer, paint_path_track(c.stroke))) {
    key_paint_path(x, layer, c.stroke, c.time, *pts);
    return {};
  }
  // A new static path invalidates the per-point input recorded for the old one.
  Json patch = Json::object();
  patch.set("points", xy_points(*pts));
  patch.set("pressure", Json::null());
  patch.set("tiltX", Json::null());
  patch.set("tiltY", Json::null());
  patch_stroke(x.d, layer, std::move(hit), patch);
  return {};
}

ResultOf<api::SetPaintPathAnimated> handle(const api::SetPaintPathAnimated& c, HCtx& x) {
  const std::string& layer = c.layer;
  const PaintHit hit = paint_stroke_or_fail(require_layer(x.d, layer), layer, c.stroke);
  check_time(c.time);
  const std::string prop = paint_path_track(c.stroke);
  x.label = c.animated ? "Enable Path Animation" : "Disable Path Animation";
  const bool keyed = anim_is_data_animated(x.d, layer, prop);
  if (c.animated && !keyed) key_paint_path(x, layer, c.stroke, c.time, hit.strokes[hit.index].at("points"));
  else if (!c.animated) anim_set_data_track(x.d, layer, prop, std::nullopt);
  return {};
}

}  // namespace premation::doc
