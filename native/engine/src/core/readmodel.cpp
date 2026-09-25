#include "readmodel.hpp"

#include <algorithm>
#include <cmath>
#include <functional>

#include "catalog_data.hpp"
#include "docio.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "scene.hpp"
#include "time_conv.hpp"

namespace premation::doc {
namespace {

using js::stringify;

std::string lower(std::string s) {
  for (char& c : s) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

std::uint32_t u32_of(double v) {
  if (!(v > 0)) return 0;
  if (v >= 4294967295.0) return 0xFFFFFFFFU;
  return static_cast<std::uint32_t>(v);
}

std::uint64_t u64_of(double v) {
  if (!(v > 0)) return 0;
  if (v >= 1.8e19) return ~std::uint64_t{0};
  return static_cast<std::uint64_t>(v);
}

const Json& fx_at(const Node& n, std::string_view key) { return n.fx().at(key); }

bool truthy(const Json& v) {
  if (v.is_undefined() || v.is_null()) return false;
  if (v.is_bool()) return v.b();
  if (v.is_number()) return v.num() != 0 && !std::isnan(v.num());
  if (v.is_string()) return !v.str().empty();
  return true;
}

}  // namespace

api::Color hex_to_color(const Json& hex, api::Color fallback) {
  if (!hex.is_string() || !is_hex_color(hex.str())) return fallback;
  const auto c = parse_color_channels(hex.str());
  return {c[0], c[1], c[2], c[3]};
}

std::uint32_t label_index_of(const Json& color) {
  if (!truthy(color) || !color.is_string()) return 0;
  const std::string want = lower(color.str());
  const auto& colors = registry().labelColors;
  const auto& ids = registry().labelIds;
  for (std::size_t i = 0; i < colors.size(); ++i) {
    // model.ts labelIndexOf (B3z): a palette colour, or a palette id.
    if (lower(colors[i]) == want || (i < ids.size() && ids[i] == color.str())) return static_cast<std::uint32_t>(i + 1);
  }
  return 0;
}

std::optional<std::string> label_color_of(std::uint32_t index) {
  const auto& colors = registry().labelColors;
  if (index == 0 || index > colors.size()) return std::nullopt;
  return colors[index - 1];
}

std::optional<std::string> label_id_of(std::uint32_t index) {
  const auto& ids = registry().labelIds;
  if (index == 0 || index > ids.size()) return std::nullopt;
  return ids[index - 1];
}

bool is_label_color(std::string_view s) {
  // model.ts LABEL_COLOR_RE: #rgb, #rrggbb or #rrggbbaa.
  if (s.empty() || s[0] != '#') return false;
  const std::size_t n = s.size() - 1;
  if (n != 3 && n != 6 && n != 8) return false;
  for (std::size_t i = 1; i < s.size(); ++i) {
    const char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
  }
  return true;
}

double comp_fps(const Document& d, std::string_view comp) {
  const Json* c = d.comp(comp);
  const Json& fps = c != nullptr ? c->at("fps") : Json::null();
  return fps.is_number() && fps.num() > 0 ? fps.num() : 30.0;
}

double comp_duration_frames(const Document& d, std::string_view comp) {
  if (const Timeline* t = d.timeline(comp)) return t->duration;
  const Json* c = d.comp(comp);
  const Json& ds = c != nullptr ? c->at("durationSeconds") : Json::null();
  const Json& fps = c != nullptr ? c->at("fps") : Json::null();
  const double sec = ds.is_undefined() || ds.is_null() ? 10.0 : ds.num();
  const double f = fps.is_undefined() || fps.is_null() ? 30.0 : fps.num();
  return std::max(1.0, motion::js::round(sec * f));
}

api::RetimeMode read_retime_mode(const Document& d, std::string_view layer) {
  if (anim_is_animated(d, layer, "timeSpeed")) return api::RetimeMode::speed;
  if (anim_is_animated(d, layer, "timeRemap") || anim_is_animated(d, layer, "precompTime")) return api::RetimeMode::frames;
  return api::RetimeMode::normal;
}

api::LayerTiming layer_timing(const Document& d, std::string_view layer) {
  const std::string comp = comp_of_layer(d, layer).value_or("");
  const double fps = comp_fps(d, comp);
  const auto bars = bars_of(d, layer, comp);
  const Node* n = d.node(layer);
  const LayerTime cfg = n != nullptr ? get_node_layer_time(*n) : LayerTime{};
  api::LayerTiming t;
  t.stretch = (cfg.stretch / 100) * (cfg.reverse ? -1 : 1);
  t.retime = read_retime_mode(d, layer);
  t.time_remap_enabled = anim_is_animated(d, layer, "timeRemap");
  if (bars.empty()) {
    t.in_point = 0;
    t.out_point = frames_to_flicks(comp_duration_frames(d, comp), fps);
    t.start_time = 0;
    return t;
  }
  const Bar& first = *bars.front();
  const Bar& last = *bars.back();
  t.in_point = frames_to_flicks(first.clip.start, fps);
  t.out_point = frames_to_flicks(last.clip.start + last.clip.duration, fps);
  t.start_time = frames_to_flicks(first.clip.start - first.clip.sourceIn, fps);
  // B4: the bar's source bound (Clip.sourceDuration, comp frames) - absent = unbounded (model.ts layerTiming).
  if (first.clip.sourceDuration && std::isfinite(*first.clip.sourceDuration)) {
    t.source_duration = frames_to_flicks(*first.clip.sourceDuration, fps);
  }
  return t;
}

std::string read_node_quality(const Node& n) {
  const Json& q = fx_at(n, "quality");
  return q.is_string() && (q.str() == "draft" || q.str() == "wireframe") ? q.str() : "best";
}

std::string read_auto_orient_mode(const Node& n) {
  const Json& v = fx_at(n, "autoOrient");
  if (v.is_string() && v.str() == "camera") return "camera";
  if ((v.is_string() && v.str() == "path") || (v.is_bool() && v.b())) return "path";
  return "off";
}

bool is_layer_audio_muted(const Node& n) {
  const std::string kind = n.kind();
  if (kind != "audio" && kind != "video") return false;
  const Component* c = n.comp(kind == "audio" ? "Audio" : "Transform");
  if (c == nullptr) return false;
  const Json& v = c->props.at(kind == "audio" ? "__muted" : "audioMuted");
  return v.is_bool() && v.b();
}

std::string collapse_switch_kind(const Node& n) {
  const std::string kind = n.kind();
  if (kind == "comp") return "collapse";
  bool raster = false;
  if (kind == "text" || kind == "svg") {
    raster = true;
  } else if (kind == "shape") {
    bool flat = true;
    for (const Component& c : n.components) {
      const Json& p = c.props;
      if (p.at("pathPoints").is_array() && !p.at("pathPoints").arr().empty()) flat = false;
      if (truthy(p.at("stroke")) || truthy(p.at("strokeWidth"))) flat = false;
      if (p.at("cornerRadius").is_number() && p.at("cornerRadius").num() > 0) flat = false;
      if (truthy(p.at("shapeType")) && !(p.at("shapeType").is_string() && p.at("shapeType").str() == "rect")) flat = false;
    }
    raster = !flat;
  }
  return raster ? "raster" : "";
}

bool read_layer_flag(const Document& d, const Node& n, std::string_view flag) {
  if (flag == "threeD") return is_3d_enabled(n);
  if (flag == "guide") return fx_at(n, "guide").is_bool() && fx_at(n, "guide").b();
  if (flag == "motionBlur") return fx_at(n, "motionBlur").is_bool() && fx_at(n, "motionBlur").b();
  if (flag == "adjustment") return fx_at(n, "isAdjustment").is_bool() && fx_at(n, "isAdjustment").b();
  if (flag == "preserveTransparency") {
    return fx_at(n, "preserveTransparency").is_bool() && fx_at(n, "preserveTransparency").b();
  }
  if (flag == "fxEnabled") return !(fx_at(n, "fxEnabled").is_bool() && !fx_at(n, "fxEnabled").b());
  if (flag == "shy") return n.shy;
  if (flag == "collapse") {
    const std::string k = collapse_switch_kind(n);
    if (k == "collapse") return read_comp_collapse(n);
    if (k == "raster") {
      for (const Component& c : n.components) {
        const Json& v = c.props.at("continuousRasterize");
        if (v.is_bool() && v.b()) return true;
      }
    }
    return false;
  }
  if (flag == "frameBlend") return get_node_layer_time(n).frameBlend != "none";
  if (flag == "quality") return read_node_quality(n) != "best";
  (void)d;
  return false;
}

api::LayerSwitches layer_switches(const Document& d, const Node& n) {
  api::LayerSwitches s;
  s.visible = n.visible;
  s.audio_enabled = !is_layer_audio_muted(n);
  s.solo = n.solo;
  s.locked = n.locked;
  s.shy = n.shy;
  s.collapse = read_layer_flag(d, n, "collapse");
  const std::string q = read_node_quality(n);
  s.quality = q == "draft" ? api::LayerQuality::draft : q == "wireframe" ? api::LayerQuality::wireframe : api::LayerQuality::best;
  s.effects_enabled = read_layer_flag(d, n, "fxEnabled");
  s.motion_blur = read_layer_flag(d, n, "motionBlur");
  s.adjustment = read_layer_flag(d, n, "adjustment");
  s.three_d = read_layer_flag(d, n, "threeD");
  s.guide = read_layer_flag(d, n, "guide");
  const std::string fb = get_node_layer_time(n).frameBlend;
  s.frame_blend = fb == "mix" ? api::FrameBlend::frame_mix : fb == "pixelMotion" ? api::FrameBlend::pixel_motion : api::FrameBlend::off;
  const std::string ao = read_auto_orient_mode(n);
  s.auto_orient = ao == "path" ? api::AutoOrient::along_path : ao == "camera" ? api::AutoOrient::towards_camera : api::AutoOrient::off;
  s.preserve_transparency = read_layer_flag(d, n, "preserveTransparency");
  s.label = n.color ? label_index_of(Json::string(*n.color)) : 0;
  // B3z: a colour outside the palette is reported as itself.
  if (n.color && !n.color->empty() && s.label == 0) s.label_color = *n.color;
  return s;
}

std::optional<MatteState> read_node_matte(const Node& n) {
  const Json& v = fx_at(n, "matte");
  auto legacy = [](std::string_view s) -> std::optional<MatteState> {
    if (s == "alpha") return MatteState{"alpha", false, std::nullopt};
    if (s == "luma") return MatteState{"luma", false, std::nullopt};
    if (s == "alpha-inv") return MatteState{"alpha", true, std::nullopt};
    if (s == "luma-inv") return MatteState{"luma", true, std::nullopt};
    return std::nullopt;
  };
  if (!truthy(v) || (v.is_string() && v.str() == "none")) return std::nullopt;
  if (v.is_string()) return legacy(v.str());
  if (v.is_object()) {
    const Json& src = v.at("sourceId");
    const std::optional<std::string> sourceId = src.is_string() && !src.str().empty() ? std::optional<std::string>(src.str()) : std::nullopt;
    const Json& mode = v.at("mode");
    if (mode.is_string() && (mode.str() == "alpha" || mode.str() == "luma")) {
      return MatteState{mode.str(), v.at("inverted").is_bool() && v.at("inverted").b(), sourceId};
    }
    if (mode.is_string()) {
      if (auto l = legacy(mode.str())) {
        l->sourceId = sourceId;
        return l;
      }
    }
  }
  return std::nullopt;
}

api::TrackMatte layer_matte(const Node& n) {
  api::TrackMatte t;
  const auto m = read_node_matte(n);
  if (!m) {
    t.mode = api::MatteMode::none;
    return t;
  }
  t.mode = m->mode == "luma" ? (m->inverted ? api::MatteMode::luma_inverted : api::MatteMode::luma)
                             : (m->inverted ? api::MatteMode::alpha_inverted : api::MatteMode::alpha);
  t.layer = m->sourceId;
  return t;
}

api::BlendMode layer_blend(const Node& n) {
  const Json& b = fx_at(n, "blendMode");
  if (!b.is_string()) return api::BlendMode::normal;
  return enum_from_string<api::BlendMode>(b.str()).value_or(api::BlendMode::normal);
}

api::Marker marker_from_data(const TMarker& m, api::MarkerOwner owner, double fps) {
  api::Marker out;
  out.id = m.id;
  out.owner = std::move(owner);
  out.time = frames_to_flicks(m.frame, fps);
  out.duration = frames_to_flicks(m.duration, fps);
  out.name = m.name;
  out.comment = m.comment;
  out.label = m.color ? label_index_of(Json::string(*m.color)) : 0;
  out.chapter = m.chapter;
  out.url = m.url;
  out.cue_point = m.cuePoint;
  out.protected_region = m.protectedRegion;
  out.color = m.color.value_or("");
  return out;
}

std::vector<api::Marker> layer_markers(const Document& d, std::string_view layer) {
  std::vector<api::Marker> out;
  const auto comp = comp_of_layer(d, layer);
  if (!comp) return out;
  const double fps = comp_fps(d, *comp);
  for (const Bar* bar : bars_of(d, layer, *comp)) {
    for (const TMarker& m : bar->markers) out.push_back(marker_from_data(m, api::MarkerOwner{*comp, std::string(layer)}, fps));
  }
  return out;
}

std::vector<api::Marker> comp_markers(const Document& d, std::string_view comp) {
  std::vector<api::Marker> out;
  const Timeline* t = d.timeline(comp);
  if (t == nullptr) return out;
  const double fps = comp_fps(d, comp);
  for (const TMarker& m : t->markers) out.push_back(marker_from_data(m, api::MarkerOwner{std::string(comp), std::nullopt}, fps));
  return out;
}

namespace {

/// B4 — a plugin layer kind's id (`<pluginId>.<kindId>`, layerKindSchema.ts `splitKind`: the kind id after the
/// last '.' matches /^[a-z][a-zA-Z0-9]{0,31}$/), '' for any other stored kind.
std::string plugin_kind_of(const Node& n) {
  std::string k = n.kind();
  const std::size_t at = k.rfind('.');
  if (at == std::string::npos || at == 0 || at + 1 >= k.size()) return {};
  const std::string_view id = std::string_view(k).substr(at + 1);
  if (id.size() > 32 || id[0] < 'a' || id[0] > 'z') return {};
  for (const char c : id) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    if (!ok) return {};
  }
  return k;
}

}  // namespace

api::LayerInfo layer_info(const Document& d, std::string_view layer) {
  const Node& n = *d.node(layer);
  api::LayerInfo info;
  info.id = std::string(layer);
  info.comp = comp_of_layer(d, layer).value_or("");
  info.kind = layer_kind_of(n);
  info.name = n.name;
  info.parent = api_parent_of(d, layer);
  info.source = layer_source_of(n);
  info.switches = layer_switches(d, n);
  info.timing = layer_timing(d, layer);
  info.blend_mode = layer_blend(n);
  info.matte = layer_matte(n);
  if (info.kind == api::LayerKind::group) {
    info.children.assign(n.children.rbegin(), n.children.rend());
  }
  const api::LayerKind k = info.kind;
  info.has_video = k != api::LayerKind::audio && k != api::LayerKind::null && k != api::LayerKind::camera &&
                   k != api::LayerKind::light;
  bool videoAudio = false;
  if (k == api::LayerKind::video) {
    for (const Component& c : n.components) {
      const Json& h = c.props.at("hasAudioTrack");
      if (!(h.is_bool() && !h.b())) videoAudio = true;
    }
  }
  info.has_audio = k == api::LayerKind::audio || videoAudio;
  info.markers = layer_markers(d, layer);
  const Json& comment = fx_at(n, "comment");
  info.comment = comment.is_string() ? comment.str() : "";
  if (k == api::LayerKind::generator) info.generator = plugin_kind_of(n);
  // B4: pinned properties — `__pinnedProps` on the first component carrying the list (model.ts pinnedOf).
  for (const Component& c : n.components) {
    const Json& bag = c.props.at("__pinnedProps");
    if (!bag.is_array()) continue;
    for (const Json& p : bag.arr()) {
      if (p.is_string()) info.pinned.push_back(p.str());
    }
    break;
  }
  // B4: the effect stack's size (model.ts readNodeEffects(node).length).
  info.effect_count = static_cast<std::uint32_t>(read_node_effects(n).size());
  return info;
}

api::CompSettings comp_settings(const Document& d, std::string_view comp) {
  static const Json kEmpty = Json::object();
  const Json* rec = d.comp(comp);
  const Json& c = rec != nullptr ? *rec : kEmpty;
  auto num = [&](std::string_view k, double fb) {
    const Json& v = c.at(k);
    return v.is_undefined() || v.is_null() ? fb : v.num();
  };
  const double fps = num("fps", 30);
  const Timeline* tl = d.timeline(comp);
  const double durFrames = comp_duration_frames(d, comp);
  const MotionBlur& mb = d.motion_blur();
  api::CompSettings s;
  const Json& name = c.at("name");
  s.name = name.is_undefined() || name.is_null() ? std::string(comp) : (name.is_string() ? name.str() : stringify(name));
  s.width = u32_of(num("width", 1920));
  s.height = u32_of(num("height", 1080));
  s.pixel_aspect = num("pixelAspect", 1);
  s.frame_rate = fps_to_rational(fps);
  s.duration = frames_to_flicks(durFrames, fps);
  s.start_timecode = frames_to_flicks(num("startFrame", 0), fps);
  s.background = hex_to_color(c.at("background"), {0, 0, 0, 1});
  s.transparent = c.at("transparent").is_bool() && c.at("transparent").b();
  if (tl != nullptr && tl->workArea) {
    s.work_area = api::TimeRange{frames_to_flicks(tl->workArea->start, fps), frames_to_flicks(tl->workArea->duration, fps)};
  } else {
    s.work_area = api::TimeRange{0, frames_to_flicks(durFrames, fps)};
  }
  s.motion_blur.shutter_angle = mb.shutterAngle;
  s.motion_blur.shutter_phase = mb.shutterPhase;
  s.motion_blur.samples_per_frame = u32_of(mb.samples);
  s.motion_blur.adaptive_sample_limit = u32_of(mb.adaptiveSampleLimit);
  s.motion_blur.enabled = mb.enabled;
  const Json& r3 = c.at("renderer3d");
  s.renderer3d = r3.is_string() ? enum_from_string<api::Renderer3d>(r3.str()).value_or(api::Renderer3d::classic)
                                : api::Renderer3d::classic;
  s.global_light_angle = num("globalLightAngle", 90);
  s.global_light_altitude = num("globalLightAltitude", 45);
  s.drop_frame = c.at("dropFrame").is_bool() && c.at("dropFrame").b();
  s.preserve_frame_rate = c.at("preserveFrameRate").is_bool() && c.at("preserveFrameRate").b();
  s.preserve_resolution = c.at("preserveResolution").is_bool() && c.at("preserveResolution").b();
  Json world = Json::object();
  for (const char* k : {"defaultEnvPreset", "groundLevel", "showSkyBackdrop", "ssao"}) {
    if (!c.at(k).is_undefined()) world.set(k, c.at(k));
  }
  if (!world.obj().empty()) s.world = stringify(world);
  // model.ts: Responsive Time / template fields from the root's props, the background paint from the record.
  if (const Node* root = d.node(comp)) {
    for (const auto& [prop, field] : {std::pair{"__responsiveTime", &s.responsive_time}, std::pair{"__templateFields", &s.template_fields}}) {
      for (const Component& cc : root->components) {
        const Json& v = cc.props.at(prop);
        if (!v.is_undefined() && !v.is_null()) {
          *field = stringify(v);
          break;
        }
      }
    }
  }
  if (c.at("backgroundPaint").is_object()) s.background_paint = stringify(c.at("backgroundPaint"));
  // The empty project's placeholder mark; absent when unset (the TS engine's compSettings).
  if (c.at("pristine").is_bool() && c.at("pristine").b()) s.pristine = true;
  return s;
}

api::Transition transition_info(const Document& d, std::string_view comp, const Json& rec) {
  api::Transition t;
  const auto str = [&](std::string_view k) { return rec.at(k).is_string() ? rec.at(k).str() : std::string(); };
  t.id = str("id");
  t.comp = std::string(comp);
  t.left = str("leftNodeId");
  t.right = str("rightNodeId");
  const std::string kind = str("kind");
  t.kind = kind == "dipToBlack" ? api::TransitionKind::dip_to_black
           : kind == "dipToWhite" ? api::TransitionKind::dip_to_white
           : kind == "wipe"       ? api::TransitionKind::wipe
                                  : api::TransitionKind::cross_dissolve;
  const std::string al = str("alignment");
  t.alignment = al == "startAtCut" ? api::TransitionAlignment::start_at_cut
                : al == "endAtCut" ? api::TransitionAlignment::end_at_cut
                                   : api::TransitionAlignment::centred;
  const Json& df = rec.at("durationFrames");
  const double frames = df.is_number() && std::isfinite(df.num()) ? motion::js::round(df.num()) : 0;
  t.duration = frames_to_flicks(frames, comp_fps(d, comp));
  return t;
}

std::vector<api::Transition> transitions_of(const Document& d, std::string_view comp) {
  std::vector<api::Transition> out;
  const Json& list = d.transitions().at(comp);
  if (!list.is_array()) return out;
  for (const Json& rec : list.arr()) out.push_back(transition_info(d, comp, rec));
  return out;
}

std::string guides_info(const Document& d) { return stringify(guides_settings(d.guides())); }

std::vector<api::Swatch> swatch_infos(const Document& d) {
  std::vector<api::Swatch> out;
  for (const Json& s : d.swatches().arr()) out.push_back(api::Swatch{s.at("id").str(), s.at("name").str(), s.at("hex").str()});
  return out;
}

std::vector<api::LibraryMaterial> material_infos(const Document& d) {
  std::vector<api::LibraryMaterial> out;
  for (const Json& m : d.materials().arr()) {
    const Json& sw = m.at("swatch");
    out.push_back(api::LibraryMaterial{m.at("id").str(), m.at("name").str(), stringify(m.at("params")), sw.is_string() ? sw.str() : std::string()});
  }
  return out;
}

api::CompInfo comp_info(const Document& d, std::string_view comp) {
  api::CompInfo info;
  info.id = std::string(comp);
  info.settings = comp_settings(d, comp);
  info.layers = layer_ids_of_comp(d, comp);
  info.markers = comp_markers(d, comp);
  info.transitions = transitions_of(d, comp);
  return info;
}

namespace {

api::Interpretation interpretation_of(const Json& a) {
  const Json& i = a.at("interpret").is_object() ? a.at("interpret") : Json::object();
  api::Interpretation out;
  const Json& alpha = i.at("alpha");
  out.alpha = alpha.is_string() && alpha.str() == "premultiplied" ? api::AlphaMode::premultiplied
              : alpha.is_string() && alpha.str() == "straight"    ? api::AlphaMode::straight
                                                                   : api::AlphaMode::auto_;
  if (truthy(i.at("conformFps"))) out.conform_frame_rate = fps_to_rational(i.at("conformFps").num());
  out.pixel_aspect = i.at("par").is_undefined() || i.at("par").is_null() ? 1.0 : i.at("par").num();
  const Json& f = i.at("fields");
  out.field_order = f.is_string() && f.str() == "upper"   ? api::FieldOrder::upper_first
                    : f.is_string() && f.str() == "lower" ? api::FieldOrder::lower_first
                                                          : api::FieldOrder::progressive;
  out.loops = u32_of(i.at("loopCount").is_undefined() || i.at("loopCount").is_null() ? 1.0 : i.at("loopCount").num());
  out.color_profile = "auto";
  out.invert_alpha = false;
  // B3z: Remove Pulldown — an integer phase 0..4 (sourceInfo.ts interpretationOf).
  const Json& pd = i.at("pulldownPhase");
  if (pd.is_number() && std::isfinite(pd.num()) && pd.num() == std::floor(pd.num()) && pd.num() >= 0 && pd.num() <= 4) {
    out.remove_pulldown = static_cast<std::uint32_t>(pd.num());
  }
  return out;
}

std::string str_of(const Json& v) { return v.is_string() ? v.str() : (v.is_undefined() || v.is_null() ? "" : stringify(v)); }

}  // namespace

api::ItemInfo footage_info(const Json& a) {
  const Json& md = a.at("metadata").is_object() ? a.at("metadata") : Json::object();
  api::ItemInfo info;
  info.id = str_of(a.at("id"));
  info.kind = api::ItemKind::footage;
  info.name = str_of(a.at("name"));
  if (truthy(a.at("folderId"))) info.parent = str_of(a.at("folderId"));
  info.label = label_index_of(a.at("label"));
  info.comment = str_of(a.at("comment"));
  info.path = str_of(a.at("path"));
  info.missing = a.at("src").is_string() && a.at("src").str().empty();
  auto mdn = [&](std::string_view k) { return md.at(k).is_undefined() || md.at(k).is_null() ? 0.0 : md.at(k).num(); };
  info.width = u32_of(std::max(0.0, motion::js::round(mdn("width"))));
  info.height = u32_of(std::max(0.0, motion::js::round(mdn("height"))));
  info.duration = seconds_to_flicks(mdn("duration"));
  if (truthy(md.at("fps"))) info.frame_rate = fps_to_rational(md.at("fps").num());
  const std::string type = str_of(a.at("type"));
  info.has_video = type != "audio";
  info.has_audio = type == "audio" || (md.at("hasAudioTrack").is_bool() && md.at("hasAudioTrack").b());
  info.has_alpha = md.at("hasAlpha").is_bool() && md.at("hasAlpha").b();
  info.interpretation = interpretation_of(a);
  const Json& proxy = a.at("proxy");
  info.proxy_path = str_of(proxy.at("src"));
  info.proxy_enabled = proxy.at("status").is_string() && proxy.at("status").str() == "ready";
  if (a.at("tags").is_array()) {
    for (const Json& t : a.at("tags").arr()) info.tags.push_back(str_of(t));
  }
  info.codec = str_of(md.at("codec"));
  info.audio_channels = u32_of(std::max(0.0, motion::js::round(mdn("audioChannels"))));
  info.audio_sample_rate = 0;
  info.file_bytes = u64_of(std::max(0.0, motion::js::round(a.at("size").is_number() ? a.at("size").num() : 0.0)));
  return info;
}

api::ItemInfo folder_info(const Folder& f) {
  api::ItemInfo info;
  info.id = f.id;
  info.kind = api::ItemKind::folder;
  info.name = f.name;
  if (f.parentId && !f.parentId->empty()) info.parent = f.parentId;
  return info;
}

api::ItemInfo comp_item_info(const Document& d, std::string_view comp) {
  static const Json kEmpty = Json::object();
  const Json* rec = d.comp(comp);
  const Json& c = rec != nullptr ? *rec : kEmpty;
  const api::CompSettings s = comp_settings(d, comp);
  api::ItemInfo info;
  info.id = std::string(comp);
  info.kind = api::ItemKind::composition;
  info.name = s.name;
  if (truthy(c.at("folderId"))) info.parent = str_of(c.at("folderId"));
  const Json& label = c.at("label");
  info.label = label.is_undefined() || label.is_null() ? 0 : u32_of(label.num());
  info.comment = str_of(c.at("comment"));
  info.width = s.width;
  info.height = s.height;
  info.duration = s.duration;
  info.frame_rate = s.frame_rate;
  info.has_video = true;
  info.has_alpha = s.transparent;
  return info;
}

std::optional<api::ItemInfo> item_info(const Document& d, std::string_view id) {
  if (is_comp_item(d, id)) return comp_item_info(d, id);
  if (const Json* a = find_asset(d, id)) return footage_info(*a);
  if (const Folder* f = find_folder(d, id)) return folder_info(*f);
  return std::nullopt;
}

std::vector<api::ItemInfo> all_item_infos(const Document& d) {
  std::vector<api::ItemInfo> out;
  for (const Folder& f : d.items().folders) out.push_back(folder_info(f));
  for (const auto& c : comp_item_ids(d)) out.push_back(comp_item_info(d, c));
  for (const Json& a : d.items().assets) out.push_back(footage_info(a));
  return out;
}

api::PropertyInfo property_info(const PCtx& c, std::string_view layer, const Catalog& cat, const PropBinding& b) {
  const Document& d = c.d;
  const bool animated = is_animated(d, layer, b);
  const std::string lead = b.lead();
  api::PropertyInfo info;
  info.path = b.path;
  info.name = b.name;
  info.match_name = b.matchName;
  info.kind = api::PropertyKind::property;
  info.value_type = b.valueType;
  info.animatable = b.animatable;
  info.animated = animated;
  info.dimensions = static_cast<std::uint32_t>(std::max<std::size_t>(1, b.members.size()));
  info.separated = b.separated;
  info.enabled = true;
  info.value = read_static(d, layer, b);
  info.default_value = b.defaultValue;
  info.min_ = b.min;
  info.max_ = b.max;
  if (b.choices) info.choices = *b.choices;
  info.unit = b.unit;
  if (!lead.empty()) {
    if (const ExprState* e = anim_expr(d, layer, lead)) info.expression = e->src;
    info.expression_enabled = anim_expr_enabled(d, layer, lead);
    info.expression_error = anim_expr_error(d, c.cache, layer, lead).value_or("");
  }
  // B4: per-dimension expressions of an unseparated multi-member property (model.ts memberExpressionsOf).
  if (!b.separated && b.members.size() >= 2) {
    struct Per {
      std::string src;
      bool enabled = false;
    };
    std::vector<Per> per;
    per.reserve(b.members.size());
    for (const auto& m : b.members) {
      const ExprState* e = anim_expr(d, layer, m);
      per.push_back(Per{e != nullptr ? e->src : std::string(), anim_expr_enabled(d, layer, m)});
    }
    const Per& first = per.front();
    const bool shared = std::all_of(per.begin(), per.end(), [&](const Per& p) {
      return p.src == first.src && (p.src.empty() || p.enabled == first.enabled);
    });
    if (!shared) {
      for (std::size_t i = 0; i < per.size(); ++i) {
        if (per[i].src.empty()) continue;
        info.member_expressions.push_back(api::MemberExpression{static_cast<std::uint32_t>(i), per[i].src, per[i].enabled,
                                                                anim_expr_error(d, c.cache, layer, b.members[i]).value_or("")});
      }
    }
  }
  info.keyframe_count = animated ? static_cast<std::uint32_t>(read_keys(d, layer, b).size()) : 0U;
  if (b.separated) {
    const std::string prefix = b.path + "/";
    for (const PropBinding& p : cat.props) {
      if (p.path.starts_with(prefix)) info.children.push_back(p.path);
    }
  }
  info.hidden = b.hidden;
  return info;
}

api::PropertyInfo group_info(const Catalog& cat, std::string_view path) {
  const GroupBinding& g = *cat.groups.find(path);
  api::PropertyInfo info;
  info.path = std::string(path);
  info.name = g.name;
  info.match_name = g.matchName;
  info.kind = g.kind;
  info.value_type = api::ValueType::none;
  info.enabled = g.enabled;
  info.children = g.children;
  return info;
}

std::vector<api::PropertyInfo> property_tree(const PCtx& c, std::string_view layer, const Catalog& cat,
                                             std::string_view root, std::uint32_t depth) {
  std::vector<api::PropertyInfo> out;
  std::function<void(const std::string&, std::uint32_t)> visit = [&](const std::string& path, std::uint32_t level) {
    if (depth > 0 && level > depth) return;
    if (const GroupBinding* g = cat.groups.find(path)) {
      out.push_back(group_info(cat, path));
      for (const auto& ch : g->children) visit(ch, level + 1);
      return;
    }
    const PropBinding* b = cat.find(path);
    if (b == nullptr) return;
    out.push_back(property_info(c, layer, cat, *b));
    if (b->separated) {
      const std::string prefix = path + "/";
      for (const PropBinding& p : cat.props) {
        if (p.path.starts_with(prefix)) visit(p.path, level + 1);
      }
    }
  };
  if (root.empty()) {
    for (const auto& r : cat.roots) visit(r, 1);
  } else {
    visit(std::string(root), 1);
  }
  return out;
}

std::vector<api::KeyframeSet> keyframe_sets(const PCtx& c, std::string_view layer, const Catalog& cat) {
  std::vector<api::KeyframeSet> out;
  for (const PropBinding& b : cat.props) {
    if (!is_animated(c.d, layer, b)) continue;
    api::KeyframeSet s;
    s.prop = api::PropRef{std::string(layer), b.path};
    for (const KeyAt& k : read_keys(c.d, layer, b)) s.keyframes.push_back(key_at_to_api(c, layer, b, k));
    out.push_back(std::move(s));
  }
  return out;
}

api::DocumentSnapshot document_snapshot(const PCtx& c, api::Revision revision, const std::string& projectPath, bool dirty,
                                        bool includeProperties, bool includeKeyframes) {
  const Document& d = c.d;
  api::DocumentSnapshot s;
  s.revision = revision;
  s.project_path = projectPath;
  s.dirty = dirty;
  s.settings = d.project();
  s.items = all_item_infos(d);
  const std::vector<std::string> comps = comp_item_ids(d);
  for (const auto& comp : comps) s.comps.push_back(comp_info(d, comp));
  for (const auto& comp : comps) {
    for (const auto& id : layer_ids_of_comp(d, comp)) s.layers.push_back(layer_info(d, id));
  }
  if (includeProperties) {
    for (const auto& l : s.layers) {
      const Catalog cat = catalog_for(d, l.id);
      s.property_trees.push_back(api::PropertyTree{l.id, property_tree(c, l.id, cat)});
    }
  }
  if (includeKeyframes) {
    for (const auto& l : s.layers) {
      const Catalog cat = catalog_for(d, l.id);
      for (auto& k : keyframe_sets(c, l.id, cat)) s.keyframes.push_back(std::move(k));
    }
  }
  s.render_queue = d.render_queue();
  s.guides = guides_info(d);
  s.swatches = swatch_infos(d);
  s.materials = material_infos(d);
  return s;
}

}  // namespace premation::doc
