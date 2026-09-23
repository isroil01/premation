#include "ptree.hpp"

#include <set>

#include "anim.hpp"
#include "catalog_data.hpp"
#include "fxstate.hpp"
#include "meta.hpp"
#include "scene.hpp"
#include "strutil.hpp"

namespace premation::doc {
namespace {

bool is_material_prop(std::string_view p) {
  static constexpr std::string_view k[] = {"ambient", "diffuse", "specular", "shininess", "metal",
                                           "lightTransmission", "roughness", "acceptsLights", "castsShadows",
                                           "acceptsShadows", "reflectionIntensity", "reflectionSharpness",
                                           "reflectionRolloff", "transparency", "transparencyRolloff", "ior"};
  for (auto x : k) {
    if (x == p) return true;
  }
  return false;
}

bool is_geometry_prop(std::string_view p) {
  return p == "extrusionDepth" || p == "bevelDepth" || p == "holeBevelDepth";
}

StaticPropertyRow row(const Node* n, std::string prop, std::string group, std::vector<std::string> members,
                      std::optional<std::string> label = std::nullopt, std::optional<std::string> merged = std::nullopt) {
  const PropertyMeta meta = resolve_property_meta(prop, n);
  StaticPropertyRow r;
  r.label = label ? *label : meta.label;
  r.prop = std::move(prop);
  r.group = std::move(group);
  r.members = std::move(members);
  if (!meta.unit.empty()) r.valueUnit = meta.unit;
  r.merged = std::move(merged);
  return r;
}

StaticPropertyRow color_row(const Node* n, const std::string& base, std::string group,
                            std::optional<std::string> label = std::nullopt) {
  StaticPropertyRow r;
  r.prop = base;
  r.label = label ? *label : resolve_property_meta(base, n).label;
  r.group = std::move(group);
  r.members = {base + "_r", base + "_g", base + "_b", base + "_a"};
  return r;
}

std::vector<StaticPropertyRow> transform_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  const std::string kind = n.kind();
  const Component* transform = n.comp("Transform");
  if (transform == nullptr || kind == "audio") return out;
  const bool is3D = is_3d_enabled(n);
  const bool isCamera = kind == "camera";
  const Json& sep = transform->props.at("separateDimensions");
  const bool separated = sep.is_bool() && sep.b();
  bool hasStyle = false;
  for (const Component& c : n.components) {
    if (c.type == "Style" || c.type == "Text") hasStyle = true;
  }
  auto placeholder = [&](std::string_view key, std::vector<std::string> members) {
    out.push_back(row(&n, std::string(kGroupPlaceholderPrefix) + std::string(key), "transform", std::move(members)));
  };
  if (!isCamera) {
    placeholder("anchor", is3D ? std::vector<std::string>{"anchorX", "anchorY", "anchorZ"}
                               : std::vector<std::string>{"anchorX", "anchorY"});
  }
  const std::vector<std::string> pos = is3D || isCamera ? std::vector<std::string>{"x", "y", "z"}
                                                        : std::vector<std::string>{"x", "y"};
  if (separated) {
    for (const auto& p : pos) out.push_back(row(&n, p, "transform", {p}));
  } else {
    out.push_back(row(nullptr, std::string(kGroupPlaceholderPrefix) + "position", "transform", pos, std::nullopt,
                      std::string(kPositionPseudoProp)));
  }
  if (!isCamera) {
    placeholder("scale", is3D ? std::vector<std::string>{"scaleX", "scaleY", "scaleZ"}
                              : std::vector<std::string>{"scaleX", "scaleY"});
    placeholder("rotation", is3D ? std::vector<std::string>{"rotation", "rotationX", "rotationY"}
                                 : std::vector<std::string>{"rotation"});
  }
  if (is3D || isCamera) placeholder("orientation", {"orientationX", "orientationY", "orientationZ"});
  if (hasStyle && !isCamera) placeholder("opacity", {"opacity"});
  return out;
}

std::vector<StaticPropertyRow> effect_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  for (const Json& effect : read_node_effects(n)) {
    const EffectDef* def = registry().effect(effect.at("type").str());
    if (def == nullptr) continue;
    const std::string id = effect.at("id").is_string() ? effect.at("id").str() : "undefined";
    for (const auto& p : def->params) {
      const std::string path = "effect." + id + "." + p.key;
      if (p.type == "number") out.push_back(row(&n, path, "effects", {path}));
      else if (p.type == "color") out.push_back(color_row(&n, path, "effects"));
    }
    if (effect_has_opacity(effect)) {
      const std::string path = "effect." + id + "." + std::string(kEffectOpacityKey);
      out.push_back(row(&n, path, "effects", {path}));
    }
  }
  return out;
}

std::vector<StaticPropertyRow> layer_style_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  const Json styles = get_node_layer_styles(n);
  if (!styles.is_object()) return out;
  for (const auto& m : styles.obj()) {
    const Json& style = m.value;
    if (style.is_undefined() || style.is_null() || style.is_bool() || style.is_number() ||
        (style.is_string() && style.str().empty())) {
      continue;  // !style
    }
    if (style.at("enabled").is_bool() && !style.at("enabled").b()) continue;
    const std::string effectId = layer_style_effect_id(m.key);
    const Json& lab = registry().layerStyles.at("label").at(m.key);
    const std::string label = lab.is_string() ? lab.str() : m.key;
    const Json& nums = registry().layerStyles.at("numberParams").at(m.key);
    if (nums.is_object()) {
      for (const auto& b : nums.obj()) {
        const std::string path = "effect." + effectId + "." + b.value.at("param").str();
        out.push_back(row(&n, path, "styles", {path}));
      }
    }
    const Json& cols = registry().layerStyles.at("colorParams").at(m.key);
    if (cols.is_object()) {
      for (const auto& c : cols.obj()) {
        const std::string path = "effect." + effectId + "." + c.value.str();
        std::string plabel = resolve_property_meta(path, &n).label;
        const std::string prefix = label + " ";
        if (const auto pos = plabel.find(prefix); pos != std::string::npos) plabel.erase(pos, prefix.size());
        out.push_back(color_row(&n, path, "styles", label + " " + plabel));
      }
    }
  }
  return out;
}

std::vector<StaticPropertyRow> paint_rows(const Document& d, const Node& n) {
  std::vector<StaticPropertyRow> out;
  const auto strokes = read_node_paint(n);
  if (!strokes) return out;
  const auto names = stroke_display_names(*strokes);
  const Json& paint = registry().paint;
  for (const Json& s : *strokes) {
    const std::string id = s.at("id").str();
    const std::string pathProp = "paint." + id + ".path";
    const bool keyed = anim_is_data_animated(d, n.id, pathProp);
    out.push_back(row(&n, pathProp, "effects", keyed ? std::vector<std::string>{pathProp} : std::vector<std::string>{}));
    auto num = [&](std::string_view key) {
      const std::string p = "paint." + id + "." + std::string(key);
      out.push_back(row(&n, p, "effects", {p}));
    };
    num("start");
    num("end");
    const std::string mode = s.at("mode").is_string() ? s.at("mode").str() : "paint";
    if (mode == "paint") {
      const auto it = names.find(id);
      out.push_back(color_row(&n, "paint." + id + ".color", "effects", (it != names.end() ? it->second : std::string()) + " Color"));
    }
    for (const char* k : {"diameter", "angle", "hardness", "roundness", "spacing", "opacity", "flow"}) num(k);
    if (mode == "clone") {
      for (const Json& k : paint.at("cloneKeys").arr()) num(k.str());
    }
    for (const Json& k : paint.at("transformKeys").arr()) num(k.str());
  }
  return out;
}

std::vector<StaticPropertyRow> mask_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  const auto mask = read_node_mask(n);
  const bool animated = !read_node_mask_anim(n).empty();
  if (!mask && !animated) return out;
  const std::size_t count = mask ? mask->at("paths").arr().size() : 0;
  StaticPropertyRow shape;
  shape.prop = std::string(kMaskAnimProp);
  shape.label = count > 1 ? "Mask Shape (" + std::to_string(count) + " paths)" : "Mask Shape";
  shape.group = "masks";
  shape.maskTrack = true;
  out.push_back(std::move(shape));
  if (mask) {
    for (const Json& p : mask->at("paths").arr()) {
      const std::string id = p.at("id").is_string() ? p.at("id").str() : "undefined";
      for (const std::string& key : registry().maskKeys) {
        const std::string path = "mask." + id + "." + key;
        out.push_back(row(&n, path, "masks", {path}));
      }
    }
  }
  return out;
}

std::vector<StaticPropertyRow> component_prop_rows(const Document& d, const Node& n, const std::set<std::string>& taken) {
  std::vector<StaticPropertyRow> out;
  std::set<std::string> seen;
  for (const Component& c : n.components) {
    if (!c.props.is_object()) continue;
    for (const auto& m : c.props.obj()) {
      if (!m.value.is_number()) continue;
      const std::string& key = m.key;
      if (key.starts_with("_") || seen.contains(key) || taken.contains(key)) continue;
      if (!has_property_meta(key, &n)) continue;
      seen.insert(key);
      const std::string group = group_for_prop(d, key, &n);
      const bool keyable = resolve_property_meta(key, &n).keyframeable;
      out.push_back(row(&n, key, group, keyable ? std::vector<std::string>{key} : std::vector<std::string>{}));
    }
  }
  return out;
}

std::vector<StaticPropertyRow> polystar_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  const auto ps = read_node_polystar(n);
  if (!ps) return out;
  for (const std::string& p : polystar_params(ps->at("starType").str())) {
    const std::string path = "polystar." + p;
    out.push_back(row(&n, path, "contents", {path}));
  }
  return out;
}

std::vector<StaticPropertyRow> stroke_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  if (n.kind() != "shape") return out;
  // readNodeStrokes: the fx.strokes stack (valid entries), else [fx.stroke].
  std::vector<const Json*> stack;
  auto is_stroke = [](const Json& v) { return v.is_object() && v.at("width").is_number(); };
  const Json& arr = n.fx().at("strokes");
  if (arr.is_array()) {
    for (const Json& s : arr.arr()) {
      if (is_stroke(s)) stack.push_back(&s);
    }
  }
  if (stack.empty() && is_stroke(n.fx().at("stroke"))) stack.push_back(&n.fx().at("stroke"));
  const Json& dashParams = registry().strokeTracks.at("dash");
  for (std::size_t i = 0; i < stack.size(); ++i) {
    const Json& s = *stack[i];
    if (s.at("enabled").is_bool() && !s.at("enabled").b()) continue;
    auto one = [&](std::string_view param) {
      const std::string path = stroke_track_path(i, param);
      out.push_back(row(&n, path, "contents", {path}));
    };
    out.push_back(color_row(&n, stroke_track_path(i, "color"), "contents",
                            i == 0 ? std::string("Stroke Color") : "Stroke " + std::to_string(i + 1) + " Color"));
    one("opacity");
    one("width");
    const Json& join = s.at("join");
    if (!(join.is_string() && (join.str() == "round" || join.str() == "bevel"))) one("miterLimit");
    std::size_t dashCount = 0;
    if (s.at("dash").is_array()) {
      for (const Json& x : s.at("dash").arr()) {
        if (x.is_finite_number() && x.num() >= 0) ++dashCount;
      }
    }
    for (std::size_t k = 0; k < dashCount; ++k) {
      if (k < dashParams.arr().size()) one(dashParams.arr()[k].str());
    }
    if (dashCount > 0) one("dashOffset");
    const Json& taper = s.at("taper");
    if (taper.is_object()) {
      const double sl = num_or(taper.at("startLength"), 0);
      const double el = num_or(taper.at("endLength"), 0);
      const bool full = num_or(taper.at("startWidth"), 1) == 1 && num_or(taper.at("endWidth"), 1) == 1;
      if (!((sl <= 0 && el <= 0) || full)) {
        for (const char* p : {"taperStartLength", "taperEndLength", "taperStartWidth", "taperEndWidth",
                              "taperStartEase", "taperEndEase"}) {
          one(p);
        }
      }
    }
    const Json& wave = s.at("wave");
    if (wave.is_object() && !(num_or(wave.at("amount"), 0) == 0 || num_or(wave.at("wavelength"), 0) <= 0)) {
      for (const char* p : {"waveAmount", "waveWavelength", "wavePhase"}) one(p);
    }
    const Json& paint = s.at("paint");
    if (paint.is_object() && paint.at("type").is_string()) {
      const std::string t = paint.at("type").str();
      if (t == "linear" || t == "radial") {
        for (const char* p : {"gradientStartX", "gradientStartY", "gradientEndX", "gradientEndY"}) one(p);
        if (t == "radial") {
          one("highlightLength");
          one("highlightAngle");
        }
      }
    }
  }
  return out;
}

std::vector<StaticPropertyRow> shape_path_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  if (n.kind() != "shape") return out;
  const Component* g = n.comp("Geometry");
  if (g == nullptr) return out;
  const Json& points = g->props.at("points");
  if (!points.is_array() || points.arr().size() < 2) return out;
  StaticPropertyRow r;
  r.prop = "path.points";
  r.label = "Path";
  r.group = "contents";
  r.members = {"path.points"};
  out.push_back(std::move(r));
  return out;
}

std::vector<StaticPropertyRow> path_op_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  for (const Json& op : read_path_ops(n)) {
    for (const std::string& p : path_op_params(op.at("type").str())) {
      const std::string path = "pathop." + op.at("id").str() + "." + p;
      out.push_back(row(&n, path, "contents", {path}));
    }
  }
  return out;
}

std::vector<StaticPropertyRow> text_animator_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  const std::vector<Json> animators = read_animator_data(n);
  if (animators.empty()) return out;
  const bool is3D = is_3d_enabled(n);
  static const std::vector<std::string> kRows = {"x",        "y",           "scale",          "scaleY",
                                                 "skew",     "rotation",    "opacity",        "fillOpacity",
                                                 "strokeWidth", "tracking", "lineSpacing",    "characterOffset",
                                                 "blur"};
  static const std::vector<std::string> kRange = {"start", "end", "offset", "amount", "smoothness", "easeHigh", "easeLow"};
  static const std::vector<std::string> kWiggly = {"maxAmount",  "minAmount",     "wigglesPerSecond",
                                                   "correlation", "temporalPhase", "spatialPhase"};
  for (std::size_t index = 0; index < animators.size(); ++index) {
    const Json& a = animators[index];
    std::vector<std::string> params = kRows;
    if (is3D) {
      params.emplace_back("z");
      params.emplace_back("rotationX");
      params.emplace_back("rotationY");
    }
    if (!a.at("blurY").is_undefined()) {
      const auto it = std::find(params.begin(), params.end(), "blur");
      params.insert(it + 1, "blurY");
    }
    for (const auto& p : params) {
      const std::string path = animator_prop_path(index, p);
      out.push_back(row(&n, path, "text", {path}));
    }
    for (const Json& o : registry().animators.at("optional").arr()) {
      const std::string param = o.at("param").str();
      if (a.at(param).is_undefined() || (param == "anchorZ" && !is3D)) continue;
      const std::string path = animator_prop_path(index, param);
      out.push_back(row(&n, path, "text", {path}));
    }
    if (a.at("axes").is_object()) {
      for (const auto& ax : a.at("axes").obj()) {
        const std::string path = animator_axis_prop_path(index, ax.key);
        out.push_back(row(&n, path, "text", {path}));
      }
    }
    const Json& sels = a.at("selectors");
    if (sels.is_array()) {
      for (std::size_t si = 0; si < sels.arr().size(); ++si) {
        const std::string kind = sels.arr()[si].at("kind").is_string() ? sels.arr()[si].at("kind").str() : "";
        const std::vector<std::string>* rows = kind == "wiggly" ? &kWiggly : kind == "range" ? &kRange : nullptr;
        if (rows == nullptr) continue;
        for (const auto& p : *rows) {
          const std::string path = selector_prop_path(index, si, p);
          out.push_back(row(&n, path, "text", {path}));
        }
      }
    }
  }
  return out;
}

std::vector<StaticPropertyRow> text_option_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  if (text_component(n) == nullptr) return out;
  const Json axes = read_font_axes_prop(n);
  for (const auto& m : axes.obj()) {
    const std::string path = axis_prop_path(m.key);
    out.push_back(row(&n, path, "text", {path}));
  }
  if (read_text_path_config(n)) {
    for (const std::string& p : registry().textPathParams) {
      const std::string path = "textPath." + p;
      out.push_back(row(&n, path, "text", {path}));
    }
  }
  if (!read_animator_data(n).empty()) {
    out.push_back(row(&n, "groupingAlignX", "text", {"groupingAlignX"}));
    out.push_back(row(&n, "groupingAlignY", "text", {"groupingAlignY"}));
  }
  return out;
}

std::vector<StaticPropertyRow> geometry_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  if (!is_3d_enabled(n)) return out;
  const std::string kind = n.kind();
  if (kind == "camera" || kind == "light" || kind == "null" || kind == "group" || kind == "audio") return out;
  const Component* t = n.comp("Transform");
  const Json& st = t != nullptr ? t->props.at("shapeType") : Json::null();
  const bool holes = kind == "text" || (kind == "shape" && st.is_string() && st.str() != "rect" && st.str() != "ellipse");
  const std::vector<std::string> props = holes ? std::vector<std::string>{"bevelDepth", "holeBevelDepth", "extrusionDepth"}
                                               : std::vector<std::string>{"bevelDepth", "extrusionDepth"};
  for (const auto& p : props) out.push_back(row(&n, p, "geometry", {p}));
  return out;
}

std::vector<StaticPropertyRow> material_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  if (!is_3d_enabled(n)) return out;
  for (const char* p : {"acceptsLights", "ambient", "diffuse", "specular", "shininess", "metal", "castsShadows",
                        "acceptsShadows", "lightTransmission", "roughness", "displacement", "reflectionIntensity",
                        "reflectionSharpness", "reflectionRolloff", "transparency", "transparencyRolloff", "ior"}) {
    out.push_back(row(&n, p, "material", {p}));
  }
  return out;
}

std::vector<StaticPropertyRow> audio_rows(const Node& n) {
  std::vector<StaticPropertyRow> out;
  const std::string kind = n.kind();
  if (kind != "audio" && kind != "video") return out;
  out.push_back(row(&n, std::string(kAudioLevelDbProp), "audio", {std::string(kAudioLevelDbProp)}));
  out.push_back(row(&n, std::string(kAudioPanProp), "audio", {std::string(kAudioPanProp)}));
  out.push_back(row(&n, "__audioWaveform", "audio", {}, std::string("Waveform")));
  return out;
}

void append_group(std::vector<StaticPropertyRow>& out, const std::vector<StaticPropertyRow>& rows, std::string_view group) {
  for (const auto& r : rows) {
    if (r.group == group) out.push_back(r);
  }
}

}  // namespace

std::string group_for_prop(const Document& d, std::string_view prop, const Node* node) {
  (void)d;
  if (prop == kMaskAnimProp || prop.starts_with("mask.")) return "masks";
  if (prop.starts_with("paint.")) return "effects";
  if (prop.starts_with(kGroupPlaceholderPrefix) || prop == kPositionPseudoProp) return "transform";
  if (is_material_prop(prop)) return "material";
  if (is_geometry_prop(prop)) return "geometry";
  if (prop == kAudioLevelDbProp || prop == kAudioPanProp || prop == "audioLevel") return "audio";
  if (prop.starts_with("effect.")) {
    const std::string_view rest = prop.substr(7);
    const std::string id(rest.substr(0, rest.find('.')));
    return style_key_from_effect_id(id) ? "styles" : "effects";
  }
  if (prop.starts_with("pathop.")) return "contents";
  if (prop.starts_with("ta.")) return "text";
  const std::string g = resolve_property_meta(prop, node).group;
  if (g == "transform") return "transform";
  if (g == "text") return "text";
  if (g == "time") return "time";
  if (g == "effects" || g == "controls") return "effects";
  if (g == "material") return "material";
  if (g == "audio") return "audio";
  if (g == "camera") return "camera";
  if (g == "light") return "light";
  return "contents";
}

std::vector<StaticPropertyRow> build_static_property_tree(const Document& d, std::string_view nodeId) {
  const Node* np = d.node(nodeId);
  if (np == nullptr) return {};
  const Node& n = *np;
  const std::vector<StaticPropertyRow> transform = transform_rows(n);
  std::set<std::string> taken;
  for (const auto& r : transform) {
    taken.insert(r.prop);
    for (const auto& m : r.members) taken.insert(m);
  }
  std::vector<StaticPropertyRow> text = text_option_rows(n);
  for (auto& r : text_animator_rows(n)) text.push_back(std::move(r));
  std::vector<StaticPropertyRow> contents = shape_path_rows(n);
  for (auto& r : polystar_rows(n)) contents.push_back(std::move(r));
  for (auto& r : stroke_rows(n)) contents.push_back(std::move(r));
  for (auto& r : path_op_rows(n)) contents.push_back(std::move(r));
  // A text layer's gradient geometry — fill, then stroke (gradientGeometryPropsFor).
  for (const auto& p : gradient_geometry_props_for(n)) contents.push_back(row(&n, p, "contents", {p}));
  std::vector<StaticPropertyRow> scanned;
  for (auto& r : component_prop_rows(d, n, taken)) {
    if (!transform.empty() || r.group != "transform") scanned.push_back(std::move(r));
  }
  const std::string kind = n.kind();
  const bool hasContents = kind != "camera" && kind != "light";

  std::vector<StaticPropertyRow> rows;
  append_group(rows, scanned, "text");
  rows.insert(rows.end(), text.begin(), text.end());
  if (hasContents) {
    append_group(rows, scanned, "contents");
    rows.insert(rows.end(), contents.begin(), contents.end());
  }
  for (auto& r : mask_rows(n)) rows.push_back(std::move(r));
  for (auto& r : effect_rows(n)) rows.push_back(std::move(r));
  for (auto& r : paint_rows(d, n)) rows.push_back(std::move(r));
  append_group(rows, scanned, "effects");
  rows.insert(rows.end(), transform.begin(), transform.end());
  append_group(rows, scanned, "transform");
  append_group(rows, scanned, "camera");
  append_group(rows, scanned, "light");
  for (auto& r : layer_style_rows(n)) rows.push_back(std::move(r));
  for (auto& r : geometry_rows(n)) rows.push_back(std::move(r));
  append_group(rows, scanned, "geometry");
  for (auto& r : material_rows(n)) rows.push_back(std::move(r));
  append_group(rows, scanned, "material");
  for (auto& r : audio_rows(n)) rows.push_back(std::move(r));
  append_group(rows, scanned, "time");

  std::set<std::string> byProp;
  std::vector<StaticPropertyRow> out;
  out.reserve(rows.size());
  for (auto& r : rows) {
    if (byProp.insert(r.prop).second) out.push_back(std::move(r));
  }
  return out;
}

}  // namespace premation::doc
