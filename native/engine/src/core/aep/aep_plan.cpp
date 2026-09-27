#include "core/aep/aep_plan.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>

#include "core/aep/aep_ease.hpp"
#include "core/aep/aep_effects.hpp"
#include "jsmath.hpp"

namespace premation::doc::aep {

namespace {

double clamp255(double v) { return std::max(0.0, std::min(255.0, motion::js::round(v))); }

/// An AE colour ([r, g, b, a] in 0–1) as `#rrggbb`.
std::string color_hex(const std::vector<double>& rgba) {
  if (rgba.size() < 3) return "#000000";
  return hex_color(rgba[0] * 255, rgba[1] * 255, rgba[2] * 255);
}

/// A layer's source: a piece of footage or a composition.
struct Source {
  const AepFootage* footage = nullptr;
  const AepComp* comp = nullptr;
  [[nodiscard]] double width() const { return footage != nullptr ? footage->width : comp->width; }
  [[nodiscard]] double height() const { return footage != nullptr ? footage->height : comp->height; }
  [[nodiscard]] const std::string& name() const { return footage != nullptr ? footage->name : comp->name; }
  [[nodiscard]] std::uint32_t id() const { return footage != nullptr ? footage->id : comp->id; }
};

std::string layer_kind(const AepLayer& layer, const Source* source) {
  if (layer.kind == LayerKind::camera) return "camera";
  if (layer.kind == LayerKind::light) return "light";
  if (layer.kind == LayerKind::text) return "text";
  // A shape layer's vector contents are not walked yet: a group keeps its transform, effects, children.
  if (layer.kind == LayerKind::shape) return "group";
  if (layer.adjustment) return "adjustment";
  if (layer.nullLayer) return "null";
  if (source == nullptr) return "null";
  if (source->comp != nullptr) return "comp";
  const AepFootage& f = *source->footage;
  if (f.footageKind == "solid") return "solid";
  if (f.width == 0 && f.height == 0 && f.hasAudio) return "audio";
  return f.isStill ? "image" : "video";
}

/// AE's blending-mode label → this editor's mode id ("Soft Light" → "soft-light").
std::string blend_mode_id(const std::string& label) {
  std::string lower;
  for (const char c0 : label) {
    const char c = c0 >= 'A' && c0 <= 'Z' ? static_cast<char>(c0 - 'A' + 'a') : c0;
    if (c == '&') lower += "and";
    else lower.push_back(c);
  }
  std::string out;
  bool dash = false;
  for (const char c : lower) {
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      if (dash && !out.empty()) out.push_back('-');
      dash = false;
      out.push_back(c);
    } else {
      dash = true;
    }
  }
  return out;
}

/// A scale-and-shift `v ↦ v·a + b` (every transform the planner uses is one).
struct Affine {
  double a = 1;
  double b = 0;
  /// `v / 100` is not `v * 0.01` in floating point: the TS divides, so this does too.
  double divisor = 1;
  [[nodiscard]] double operator()(double v) const { return (divisor != 1 ? v / divisor : v) * a + b; }
};

struct PlanContext {
  const AepComp& comp;
  const AepLayer& layer;
  double width;
  double height;
  std::vector<std::string>& warnings;
  PlanSummary& summary;
};

void set_prop(std::vector<std::pair<std::string, double>>& props, const std::string& key, double v) {
  for (auto& [k, val] : props) {
    if (k == key) {
      val = v;
      return;
    }
  }
  props.emplace_back(key, v);
}

void plan_transform(const PlanContext& ctx, PlannedLayer& out) {
  const AepProp* group = find_group(&ctx.layer.properties, "ADBE Transform Group");
  // `fallback` is in THIS editor's units: what the property is when the file does not mention it.
  auto take = [&](std::string_view matchName, std::size_t dim, const std::string& prop, double fallback, Affine tf = {}) {
    const AepProp* source = find_leaf(group, matchName);
    if (source == nullptr) {
      set_prop(out.staticProps, prop, fallback);
      return;
    }
    const std::optional<double> raw = dim < source->value.size() ? std::optional<double>(source->value[dim]) : std::nullopt;
    double value = raw ? tf(*raw) : fallback;
    if (!source->keyframes.empty()) {
      const double zero = tf(0);
      const double one = tf(1);
      ConvertOptions opts;
      opts.scale = one - zero;
      opts.offset = zero;
      out.tracks.push_back({prop, to_keyframe_track(source->keyframes, dim, opts)});
      const std::vector<double>& first = source->keyframes[0].value;
      value = tf(dim < first.size() ? first[dim] : raw.value_or(fallback));
    }
    set_prop(out.staticProps, prop, value);
  };

  const AepProp* separated = find_leaf(group, "ADBE Position_0");
  const bool useSeparated = separated != nullptr && !separated->keyframes.empty();
  if (useSeparated) {
    take("ADBE Position_0", 0, "x", ctx.comp.width / 2);
    take("ADBE Position_1", 0, "y", ctx.comp.height / 2);
    take("ADBE Position_2", 0, "z", 0);
  } else {
    take("ADBE Position", 0, "x", ctx.comp.width / 2);
    take("ADBE Position", 1, "y", ctx.comp.height / 2);
    take("ADBE Position", 2, "z", 0);
  }
  // Anchor: AE's top-left origin → this editor's centre origin.
  take("ADBE Anchor Point", 0, "anchorX", 0, Affine{1, -ctx.width / 2, 1});
  take("ADBE Anchor Point", 1, "anchorY", 0, Affine{1, -ctx.height / 2, 1});
  take("ADBE Scale", 0, "scaleX", 1, Affine{1, 0, 100});
  take("ADBE Scale", 1, "scaleY", 1, Affine{1, 0, 100});
  take("ADBE Rotate Z", 0, "rotation", 0);
  take("ADBE Rotate X", 0, "rotationX", 0);
  take("ADBE Rotate Y", 0, "rotationY", 0);
  take("ADBE Opacity", 0, "opacity", 100);

  // Orientation carries over as the resting facing it means here too.
  if (const AepProp* orientation = find_leaf(group, "ADBE Orientation")) {
    if (std::any_of(orientation->value.begin(), orientation->value.end(), [](double v) { return v != 0; })) {
      auto at = [&](std::size_t i) { return i < orientation->value.size() ? orientation->value[i] : 0.0; };
      set_prop(out.staticProps, "orientationX", at(0));
      set_prop(out.staticProps, "orientationY", at(1));
      set_prop(out.staticProps, "orientationZ", at(2));
    }
  }
  if (!ctx.layer.threeD) {
    // A 2-D AE layer has no depth: a z or x-rotation would quietly promote it to 3-D here.
    const auto depth = [](const std::string& k) { return k == "z" || k == "rotationX" || k == "rotationY"; };
    std::erase_if(out.staticProps, [&](const auto& p) { return depth(p.first); });
    std::erase_if(out.tracks, [&](const PlannedTrack& t) { return depth(t.prop); });
  }
}

void plan_masks(const PlanContext& ctx, PlannedLayer& out) {
  for (const AepMask& mask : ctx.layer.masks) {
    if (!mask.shape || mask.shape->vertices.empty()) continue;
    const AepProp* feather = find_leaf(&mask.properties, "ADBE Mask Feather");
    const AepProp* opacity = find_leaf(&mask.properties, "ADBE Mask Opacity");
    const AepProp* expansion = find_leaf(&mask.properties, "ADBE Mask Offset");
    PlannedMask m;
    m.name = mask.name;
    m.mode = mask.mode;
    m.inverted = mask.inverted;
    m.closed = mask.shape->closed;
    for (const AepShapeVertex& v : mask.shape->vertices) {
      const double x = v.x - ctx.width / 2;
      const double y = v.y - ctx.height / 2;
      // AE stores tangents as offsets; this editor stores the handle positions.
      m.points.push_back({x, y, x + v.inX, y + v.inY, x + v.outX, y + v.outY});
    }
    // AE's feather is 2-D; this editor's is one diameter (the horizontal stands for both).
    m.feather = scalar_of(feather, 0);
    m.opacity = (opacity != nullptr ? scalar_of(opacity, 100) : 100) / 100;
    m.expansion = scalar_of(expansion, 0);
    out.masks.push_back(std::move(m));
    ctx.summary.masks += 1;
  }
}

void plan_effects(const PlanContext& ctx, PlannedLayer& out) {
  const AepProp* parade = find_group(&ctx.layer.properties, "ADBE Effect Parade");
  if (parade == nullptr) return;
  for (const AepProp& entry : parade->children) {
    if (!entry.isGroup) continue;
    std::vector<AeParam> declared;
    for (const AepProp& c : entry.children) {
      if (!c.isGroup) declared.push_back(AeParam{c.matchName, c.name, c.controlType});
    }
    const std::vector<MappedEffect> mapped = map_effect(entry.matchName, declared);
    if (mapped.empty()) {
      const std::string label = entry.name && !entry.name->empty() ? *entry.name : entry.matchName;
      auto& um = ctx.summary.unmappedEffects;
      if (std::find(um.begin(), um.end(), label) == um.end()) um.push_back(label);
      continue;
    }
    for (const MappedEffect& target : mapped) {
      PlannedEffect e;
      e.type = target.type;
      auto setParam = [&](const std::string& key, js::Json v) {
        for (auto& [k, val] : e.params) {
          if (k == key) {
            val = std::move(v);
            return;
          }
        }
        e.params.emplace_back(key, std::move(v));
      };
      for (const auto& [key, aeName] : target.params) {
        const AepProp* prop = find_leaf(&entry, aeName);
        if (prop == nullptr) continue;
        if (prop->isColor) {
          setParam(key, js::Json::string(color_hex(prop->value)));
          continue;
        }
        setParam(key, js::Json::number(prop->value.empty() ? 0 : prop->value[0]));
        if (!prop->keyframes.empty()) e.tracks.push_back({key, to_keyframe_track(prop->keyframes, 0)});
      }
      // A point is one AE parameter and two of ours (the reader already made it pixels).
      for (const auto& [base, pt] : target.points) {
        const AepProp* prop = find_leaf(&entry, pt.from);
        if (prop == nullptr) continue;
        setParam(pt.keyX, js::Json::number(!prop->value.empty() ? prop->value[0] : 0));
        setParam(pt.keyY, js::Json::number(prop->value.size() > 1 ? prop->value[1] : 0));
        if (!prop->keyframes.empty()) {
          e.tracks.push_back({pt.keyX, to_keyframe_track(prop->keyframes, 0)});
          e.tracks.push_back({pt.keyY, to_keyframe_track(prop->keyframes, 1)});
        }
      }
      e.defaultsOnly = target.defaultsOnly;
      out.effects.push_back(std::move(e));
      ctx.summary.effects += 1;
    }
  }
}

void collect_expressions(const AepProp& group, const std::string& path, std::vector<PlannedLayer::Expression>& out) {
  for (const AepProp& child : group.children) {
    const std::string& label = child.name ? *child.name : child.matchName;
    const std::string here = path.empty() ? label : path + " \xE2\x96\xB8 " + label;
    if (child.isGroup) collect_expressions(child, here, out);
    else if (child.expression) out.push_back({here, *child.expression});
  }
}

PlannedLayer plan_layer(const AepLayer& layer, const AepComp& comp, const std::map<std::uint32_t, Source>& sources,
                        std::vector<std::string>& warnings, PlanSummary& summary) {
  const auto it = sources.find(layer.sourceId);
  const Source* source = it != sources.end() ? &it->second : nullptr;
  const double w = source != nullptr && source->width() != 0 ? source->width() : comp.width;
  const double h = source != nullptr && source->height() != 0 ? source->height() : comp.height;
  const PlanContext ctx{comp, layer, w, h, warnings, summary};

  PlannedLayer out;
  out.uid = std::to_string(comp.id) + ":" + std::to_string(layer.id);
  // A layer AE never renamed shows its source's name.
  out.name = !layer.name.empty() ? layer.name
             : source != nullptr && !source->name().empty() ? source->name()
                                                             : "Layer " + std::to_string(layer.index);
  out.kind = layer_kind(layer, source);
  if (layer.parentId != 0) out.parentUid = std::to_string(comp.id) + ":" + std::to_string(layer.parentId);
  if (source != nullptr) out.source = PlannedLayer::Source{source->comp != nullptr, source->id()};
  plan_transform(ctx, out);
  collect_expressions(layer.properties, "", out.expressions);
  summary.expressions += static_cast<std::uint32_t>(out.expressions.size());

  const AepProp* textProp = find_leaf(find_group(&layer.properties, "ADBE Text Properties"), "ADBE Text Document");
  if (textProp != nullptr && textProp->text) {
    out.text = textProp->text;
    if (textProp->text->styleRuns > 1) {
      warnings.push_back("\"" + layer.name + "\" mixes character styles; the first one was applied to the whole layer");
    }
  }
  out.timing = {layer.inPoint, layer.outPoint, layer.startTime, layer.stretch};
  out.flags = {layer.enabled, layer.solo,  layer.shy,        layer.locked,          layer.threeD,
               layer.adjustment, layer.guide, layer.motionBlur, layer.collapseTransformation};
  out.blendMode = blend_mode_id(layer.blendingMode);
  out.label = layer.label;
  if (layer.trackMatte != "none") {
    PlannedLayer::Matte m;
    m.mode = layer.trackMatte.starts_with("luma") ? "luma" : "alpha";
    m.inverted = layer.trackMatte.ends_with("-inverted");
    // AE 23+ names the matte layer; before that it is "the layer directly above" (the applier resolves it).
    if (layer.matteLayerId != 0) m.sourceUid = std::to_string(comp.id) + ":" + std::to_string(layer.matteLayerId);
    out.matte = std::move(m);
  }
  plan_masks(ctx, out);
  plan_effects(ctx, out);
  if (source != nullptr && source->footage != nullptr && source->footage->solidColor) {
    const auto& c = *source->footage->solidColor;
    out.solidColor = hex_color(c.r * 255, c.g * 255, c.b * 255);
  }
  return out;
}

}  // namespace

std::string hex_color(double r, double g, double b) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out = "#";
  for (const double c : {r, g, b}) {
    const auto v = static_cast<unsigned>(clamp255(std::isfinite(c) ? c : 0));
    out.push_back(kHex[v >> 4U]);
    out.push_back(kHex[v & 15U]);
  }
  return out;
}

AepImportPlan plan_aep_import(const AepProject& project) {
  AepImportPlan plan;
  plan.warnings = project.warnings;
  plan.aeVersion = project.aeVersion;
  plan.summary.comps = static_cast<std::uint32_t>(project.comps.size());

  std::map<std::uint32_t, Source> sources;
  for (const AepItemRef& item : project.items) {
    if (item.kind == ItemKind::footage) sources.insert_or_assign(item.id, Source{&project.footage[item.index], nullptr});
    else if (item.kind == ItemKind::comp) sources.insert_or_assign(item.id, Source{nullptr, &project.comps[item.index]});
  }

  for (const AepComp& comp : project.comps) {
    PlannedComp pc;
    for (const AepLayer& layer : comp.layers) pc.layers.push_back(plan_layer(layer, comp, sources, plan.warnings, plan.summary));
    plan.summary.layers += static_cast<std::uint32_t>(pc.layers.size());
    // Counted from the tracks that survived (a 2-D layer's dropped z track is not a keyframe).
    for (const PlannedLayer& l : pc.layers) {
      for (const PlannedTrack& t : l.tracks) plan.summary.keyframes += static_cast<std::uint32_t>(t.keyframes.size());
      for (const PlannedEffect& e : l.effects) {
        for (const PlannedTrack& t : e.tracks) plan.summary.keyframes += static_cast<std::uint32_t>(t.keyframes.size());
      }
    }
    pc.aepId = comp.id;
    pc.name = !comp.name.empty() ? comp.name : "Composition";
    pc.width = comp.width;
    pc.height = comp.height;
    pc.fps = comp.fps;
    pc.durationSeconds = comp.durationSeconds;
    pc.background = hex_color(comp.background.r, comp.background.g, comp.background.b);
    pc.folder = comp.folder;
    pc.motionBlur = comp.motionBlur;
    pc.shutterAngle = comp.shutterAngle;
    pc.shutterPhase = comp.shutterPhase;
    pc.samplesPerFrame = comp.motionBlurSamplesPerFrame;
    pc.workAreaStart = comp.workAreaStart;
    // AE's open-ended work area means "to the end of the comp".
    pc.workAreaEnd = std::isfinite(comp.workAreaEnd) ? comp.workAreaEnd : comp.durationSeconds;
    plan.comps.push_back(std::move(pc));
  }

  for (const AepFootage& item : project.footage) {
    PlannedFootage f;
    f.aepId = item.id;
    f.name = !item.name.empty() ? item.name : "Footage";
    f.kind = item.footageKind;
    f.path = item.path;
    f.width = item.width;
    f.height = item.height;
    f.durationSeconds = item.durationSeconds;
    f.frameRate = item.frameRate;
    f.isStill = item.isStill;
    f.hasAudio = item.hasAudio;
    f.missingAtSave = item.missingAtSave;
    if (item.solidColor) f.solidColor = hex_color(item.solidColor->r * 255, item.solidColor->g * 255, item.solidColor->b * 255);
    f.folder = item.folder;
    plan.footage.push_back(std::move(f));
  }

  const std::size_t n = plan.summary.unmappedEffects.size();
  if (n > 0) {
    std::string names;
    for (std::size_t i = 0; i < n; ++i) names += (i > 0 ? ", " : "") + plan.summary.unmappedEffects[i];
    plan.warnings.push_back(std::to_string(n) + (n == 1 ? " effect had no equivalent here and was skipped: "
                                                        : " effects had no equivalent here and were skipped: ") +
                            names);
  }
  return plan;
}

std::optional<std::size_t> main_comp(const AepImportPlan& plan) {
  std::set<std::uint32_t> used;
  for (const PlannedComp& c : plan.comps) {
    for (const PlannedLayer& l : c.layers) {
      if (l.source && l.source->comp) used.insert(l.source->aepId);
    }
  }
  std::vector<std::size_t> candidates;
  for (std::size_t i = 0; i < plan.comps.size(); ++i) {
    if (!used.contains(plan.comps[i].aepId)) candidates.push_back(i);
  }
  if (candidates.empty()) {
    for (std::size_t i = 0; i < plan.comps.size(); ++i) candidates.push_back(i);
  }
  if (candidates.empty()) return std::nullopt;
  std::stable_sort(candidates.begin(), candidates.end(), [&](std::size_t a, std::size_t b) {
    const PlannedComp& ca = plan.comps[a];
    const PlannedComp& cb = plan.comps[b];
    if (ca.durationSeconds != cb.durationSeconds) return ca.durationSeconds > cb.durationSeconds;
    return ca.width > cb.width;
  });
  return candidates[0];
}

}  // namespace premation::doc::aep
