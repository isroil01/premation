#include "item_facts.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
#include <utility>

#include "anim.hpp"
#include "docio.hpp"
#include "handlers_common.hpp"
#include "handlers_items.hpp"
#include "jsmath.hpp"
#include "ptree.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "time_conv.hpp"
#include "timeline.hpp"

namespace premation::doc {

// ── getDocumentColors (src/core/paint/documentColors.ts) ────────────────

// `canonical_hex` (documentColors.ts canonicalHex) is docio.cpp's: the swatch restore's form.

namespace {

/// fill.ts `isFillPaint`.
bool is_fill_paint(const Json& v) {
  if (!v.is_object()) return false;
  const Json& t = v.at("type");
  return t.is_string() && (t.str() == "solid" || t.str() == "linear" || t.str() == "radial");
}

/// stroke.ts `isStroke`.
bool is_stroke(const Json& v) { return v.is_object() && v.at("width").is_number(); }

struct ColorWalk {
  std::vector<std::string> out;
  std::set<std::string> seen;
  std::size_t limit = std::numeric_limits<std::size_t>::max();

  [[nodiscard]] bool full() const noexcept { return out.size() >= limit; }

  void color(const Json& raw) {
    if (full()) return;
    auto hex = canonical_hex(raw);
    if (!hex || seen.contains(*hex)) return;
    seen.insert(*hex);
    out.push_back(std::move(*hex));
  }
  /// A solid's colour, or every gradient stop's (a gradient with no stop list paints nothing).
  void paint(const Json& p) {
    if (!is_fill_paint(p)) return;
    if (p.at("type").str() == "solid") {
      color(p.at("color"));
      return;
    }
    const Json& stops = p.at("stops");
    if (!stops.is_array()) return;
    for (const Json& s : stops.arr()) color(s.at("color"));
  }
  /// fill.ts `readNodeFills` + stroke.ts `readNodeStrokes` (normalizeStroke's colour default, its valid paint).
  void node(const Node& n) {
    const Json& fx = n.fx();
    bool stack = false;
    if (const Json& fills = fx.at("fills"); fills.is_array()) {
      for (const Json& f : fills.arr()) {
        if (!is_fill_paint(f)) continue;
        stack = true;
        paint(f);
      }
    }
    if (!stack) {
      if (is_fill_paint(fx.at("fill"))) {
        paint(fx.at("fill"));
      } else {
        // Legacy: a plain colour string on any component (a light's colour).
        for (const Component& c : n.components) {
          const Json& f = c.props.at("fill");
          if (f.is_string()) {
            color(f);
            break;
          }
        }
      }
    }
    const auto stroke = [this](const Json& s) {
      color(s.at("color").is_string() ? s.at("color") : Json::string("#ffffff"));
      paint(s.at("paint"));
    };
    bool strokes = false;
    if (const Json& list = fx.at("strokes"); list.is_array()) {
      for (const Json& s : list.arr()) {
        if (!is_stroke(s)) continue;
        strokes = true;
        stroke(s);
      }
    }
    if (!strokes && is_stroke(fx.at("stroke"))) stroke(fx.at("stroke"));
  }
};

double comp_rec_number(const Json* rec, std::string_view key) {
  if (rec == nullptr) return 0;
  const Json& v = rec->at(key);
  return v.is_number() ? v.num() : 0;
}

/// buildSnapshot.ts SIZE (the four kinds it lists), keyed by `readNodeKind`.
std::optional<std::pair<double, double>> kind_default_size(const std::string& kind) {
  if (kind == "shape") return std::pair{220.0, 220.0};
  if (kind == "text") return std::pair{320.0, 80.0};
  if (kind == "image") return std::pair{280.0, 180.0};
  if (kind == "video") return std::pair{480.0, 270.0};
  return std::nullopt;
}

/// sourceInfo.ts `sourceOf(node, compSourceOf)`'s size: a composition's frame, footage's PAR-stretched size.
std::optional<std::pair<double, double>> source_size_of(const Document& d, const Node& n) {
  const std::string kind = n.kind();
  if (kind == "comp") {
    const auto ref = read_comp_ref(n);
    if (!ref) return std::nullopt;
    const Json* c = d.comp(*ref);
    if (c == nullptr) return std::nullopt;
    return std::pair{comp_rec_number(c, "width"), comp_rec_number(c, "height")};
  }
  if (kind != "video" && kind != "image" && kind != "svg") return std::nullopt;
  std::optional<std::string> assetId;
  for (const Component& c : n.components) {
    const Json& a = c.props.at("assetId");
    if (a.is_string() && !a.str().empty()) assetId = a.str();
    const Json& b = c.props.at("__assetId");
    if (b.is_string() && !b.str().empty()) assetId = b.str();
  }
  if (!assetId) return std::nullopt;
  const Json* asset = find_asset(d, *assetId);
  if (asset == nullptr) return std::nullopt;
  const Json& md = asset->at("metadata");
  const double w = md.at("width").is_number() ? md.at("width").num() : 0;
  const double h = md.at("height").is_number() ? md.at("height").num() : 0;
  const Json& par = asset->at("interpret").at("par");
  const double p = par.is_undefined() || par.is_null() ? 1.0 : par.num();
  return std::pair{motion::js::round(w * p), h};
}

}  // namespace

std::vector<std::string> document_colors(const Document& d, std::uint32_t limit) {
  ColorWalk walk;
  if (limit > 0) walk.limit = limit;
  for (const std::string& comp : comp_item_ids(d)) {
    for (const std::string& id : layer_ids_of_comp(d, comp)) {
      if (walk.full()) return std::move(walk.out);
      if (const Node* n = d.node(id)) walk.node(*n);
    }
  }
  return std::move(walk.out);
}

// ── getCaptionCues ───────────────────────────────────────────────────────

std::vector<api::CaptionCue> caption_cues(const Document& d, const std::string& comp) {
  require_comp(d, comp);
  const Node* root = d.node(comp);
  std::vector<api::CaptionCue> cues;
  if (root == nullptr) return cues;
  const double fps = comp_fps(d, comp);
  for (const std::string& id : root->children) {
    const Node* n = d.node(id);
    if (n == nullptr) continue;
    const bool caption = std::any_of(n->components.begin(), n->components.end(), [](const Component& c) {
      const Json& v = c.props.at("__caption");
      return v.is_bool() && v.b();
    });
    if (!caption) continue;
    const auto bars = bars_of(d, id, comp);
    if (bars.empty()) continue;
    std::string text;
    for (const Component& c : n->components) {
      const Json& content = c.props.at("content");
      if (content.is_string()) {
        text = content.str();
        break;
      }
    }
    text = js_trim(text);
    if (text.empty()) continue;
    const Bar& bar = *bars.front();
    cues.push_back(api::CaptionCue{id, frames_to_flicks(bar.clip.start, fps), frames_to_flicks(bar.clip.start + bar.clip.duration, fps),
                                   std::move(text)});
  }
  std::stable_sort(cues.begin(), cues.end(), [](const api::CaptionCue& a, const api::CaptionCue& b) { return a.start < b.start; });
  return cues;
}

// ── mapLayerTime ─────────────────────────────────────────────────────────

std::optional<api::Time> map_layer_time(const PCtx& pc, const std::string& layer, api::Time time, bool outward) {
  const Document& d = pc.d;
  const Node& n = require_layer(d, layer);
  const double t = flicks_to_seconds(time);
  if (!read_comp_ref(n)) return seconds_to_flicks(t);
  double r = 0;
  if (outward) {
    // A keyframed time remap can show one inner frame at many times, or at none.
    if (anim_is_animated(d, layer, "timeRemap") || anim_is_animated(d, layer, "precompTime")) return std::nullopt;
    r = keyframe_to_comp_time(d, pc.view, layer, t);
  } else {
    auto remapped = anim_sample(d, pc.expr, pc.cache, layer, "timeRemap", t);
    if (!remapped) remapped = anim_sample(d, pc.expr, pc.cache, layer, "precompTime", t);
    r = comp_to_keyframe_time(d, pc.view, layer, remapped.value_or(t));
  }
  if (!std::isfinite(r)) return std::nullopt;
  return seconds_to_flicks(r);
}

// ── getSourceSize ────────────────────────────────────────────────────────

std::vector<api::LayerSourceSize> source_sizes(const Document& d, const std::vector<std::string>& layers) {
  std::vector<api::LayerSourceSize> out;
  for (const std::string& id : layers) {
    if (!comp_of_layer(d, id)) continue;
    const Node* n = d.node(id);
    if (n == nullptr) continue;
    std::optional<std::pair<double, double>> size = source_size_of(d, *n);
    if (!size || !(size->first > 0 && size->second > 0)) size = kind_default_size(n->kind());
    if (size) out.push_back(api::LayerSourceSize{id, size->first, size->second});
  }
  return out;
}

std::vector<api::TimelineRowSet> timeline_rows(const Document& d, const std::vector<std::string>& layers) {
  std::vector<api::TimelineRowSet> out;
  for (const std::string& id : layers) {
    if (!comp_of_layer(d, id) || d.node(id) == nullptr) continue;
    api::TimelineRowSet set;
    set.layer = id;
    for (const StaticPropertyRow& r : build_static_property_tree(d, id)) {
      api::TimelineRow row;
      row.prop = r.prop;
      row.label = r.label;
      row.group = r.group;
      row.members = r.members;
      row.merged = r.merged;
      row.value_props = r.valueProps ? *r.valueProps : r.members;
      row.value_unit = r.valueUnit;
      row.mask_track = r.maskTrack;
      set.rows.push_back(std::move(row));
    }
    out.push_back(std::move(set));
  }
  return out;
}

}  // namespace premation::doc
