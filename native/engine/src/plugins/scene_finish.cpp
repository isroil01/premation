#include "scene_finish.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <span>
#include <variant>

#include "asset_image.hpp"
#include "effects_port.hpp"
#include "exr_read.hpp"
#include "fx_wire.hpp"
#include "fxstate.hpp"
#include "handlers_native.hpp"
#include "host.hpp"
#include "image_decode.hpp"
#include "jsmath.hpp"
#include "lights3d.hpp"
#include "native_effects.hpp"
#include "readers.hpp"
#include "scene.hpp"
#include "scene_eval.hpp"
#include "scene_native_fx.hpp"
#include "snapshot_build.hpp"
#include "../render_graph/threed.hpp"  // depth_eligible_3d: what the scene depth draws
#include "timeline.hpp"
#include "worldxf.hpp"

namespace premation::plugins {
namespace {

/// SDK 1.4 (T): what makes a simulation's per-frame inputs what they are — the effect's record
/// (static params), every keyframe and data track of its params and the sequence data. 0 when one
/// of its params has an expression: that may read anything, so every frame is re-evaluated.
std::uint64_t sim_inputs_key(const doc::Document& d, const doc::Node& node, std::string_view effectId, std::string_view sequence) {
  std::uint64_t h = 14695981039346656037ULL;
  const auto mix = [&h](std::string_view s) {
    for (const char c : s) h = (h ^ static_cast<unsigned char>(c)) * 1099511628211ULL;
    h = (h ^ 0xffU) * 1099511628211ULL;
  };
  const auto mixd = [&mix](double v) { mix(std::string_view(reinterpret_cast<const char*>(&v), sizeof v)); };  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): hashing the bits
  for (const js::Json& e : doc::read_node_effects(node)) {
    if (e.at("id").is_string() && e.at("id").str() == effectId) mix(js::stringify(e));
  }
  mix(sequence);
  const std::string prefix = "effect." + std::string(effectId) + ".";
  if (const doc::NodeAnim* a = d.anim(node.id)) {
    for (const auto& [prop, ex] : a->exprs) {
      if (prop.starts_with(prefix) && ex.enabled && !ex.src.empty()) return 0;
    }
    for (const auto& [prop, keys] : a->tracks) {
      if (!prop.starts_with(prefix)) continue;
      mix(prop);
      for (const doc::Key& k : keys) {
        mixd(k.t);
        mixd(k.value);
        mixd(k.easing ? static_cast<double>(*k.easing) : -1);
        if (k.bezier) for (const double b : *k.bezier) mixd(b);
        mixd(k.continuous.value_or(false) ? 1 : 0);
      }
    }
    for (const auto& [prop, track] : a->data) {
      if (!prop.starts_with(prefix)) continue;
      mix(prop);
      for (const doc::DataKey& k : track.keys) {
        mixd(k.t);
        mix(js::stringify(k.value));
        mixd(k.easing ? static_cast<double>(*k.easing) : -1);
      }
    }
  }
  return h == 0 ? 1 : h;
}

constexpr double kFlicks = PR_TIME_SCALE;
/// The largest reach a plugin's result_rect may add to its layer (the engine's texture limit).
constexpr double kMaxReachPx = 16384;

api::RenderEffectParam& param(api::RenderEffect& e, std::string_view name, api::RenderParamKind kind) {
  for (auto& p : e.params) {
    if (p.name == name) {
      p.kind = kind;
      return p;
    }
  }
  api::RenderEffectParam p;
  p.name = std::string(name);
  p.kind = kind;
  e.params.push_back(std::move(p));
  return e.params.back();
}

void set_num(api::RenderEffect& e, std::string_view name, double v) { param(e, name, api::RenderParamKind::number).number = v; }
void set_flag(api::RenderEffect& e, std::string_view name, bool v) { param(e, name, api::RenderParamKind::flag).number = v ? 1 : 0; }
void set_text(api::RenderEffect& e, std::string_view name, std::string v) {
  param(e, name, api::RenderParamKind::text).text = std::move(v);
}

std::string text_of(const api::RenderEffect& e, std::string_view name) {
  for (const auto& p : e.params) {
    if (p.name == name) return p.text;
  }
  return {};
}

double num_of(const api::RenderEffect& e, std::string_view name, double def) {
  for (const auto& p : e.params) {
    if (p.name == name) return p.number;
  }
  return def;
}

std::int64_t flicks(double seconds) { return static_cast<std::int64_t>(std::llround(seconds * kFlicks)); }

using List = std::vector<api::Renderable>;

void visit(List& list, const std::function<void(api::Renderable&, List&)>& fn) {
  for (std::size_t i = 0; i < list.size(); ++i) {
    fn(list[i], list);
    visit(list[i].precomp_children, fn);
  }
}

void rename_keys(api::Renderable& r, const std::string& suffix, std::map<std::string, std::string>& renamed) {
  const auto rename = [&](std::optional<std::string>& k) {
    if (!k || k->empty()) return;
    const std::string next = *k + suffix;
    renamed.emplace(*k, next);
    k = next;
  };
  rename(r.texture_key);
  rename(r.mask_texture_key);
  rename(r.lut_texture_key);
  if (r.adjustment) rename(r.adjustment->lut_texture_key);
  if (r.generator) rename(r.generator->texture_key);
  for (auto& c : r.precomp_children) rename_keys(c, suffix, renamed);
}

struct Want {
  std::string layer;
  std::int64_t time = 0;      ///< the checkout's layer time (the renderable's id)
  std::int64_t compTime = 0;  ///< where the composition is built for it
  const List* list = nullptr;
};

/// Post-order: a nested list gets its additions before its parent list can reallocate.
void apply_additions(List& list, std::map<const List*, List>& additions) {
  for (auto& r : list) apply_additions(r.precomp_children, additions);
  const auto it = additions.find(&list);
  if (it == additions.end()) return;
  for (auto& r : it->second) list.push_back(std::move(r));
  additions.erase(it);
}

// ── SDK 1.2 assets: the engine's own decoders behind get_asset_image ─────────

bool engine_decode(const std::filesystem::path& file, DecodedAsset& out, std::string& why) {
  std::string ext = file.extension().string();
  std::ranges::transform(ext, ext.begin(), [](char c) { return static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c); });
  if (ext == ".exr") {
    std::ifstream f(file, std::ios::binary);
    const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (bytes.empty()) {
      why = "cannot read the file";
      return false;
    }
    std::string err;
    const std::optional<scene::exr::Image> img = scene::exr::decode(bytes, scene::exr::zlib_inflate(), err);
    if (!img) {
      why = "EXR: " + err;
      return false;
    }
    std::optional<scene::exr::FloatRgba> rgba = scene::exr::to_float_rgba(*img);
    if (!rgba) {
      why = "EXR: no colour channels";
      return false;
    }
    out.image.width = rgba->width;
    out.image.height = rgba->height;
    out.image.rgba = std::move(rgba->rgba);
    out.linear = true;
    out.premultiplied = true;  // OpenEXR's convention
    return true;
  }
  if (!scene::is_still_image_path(file)) {
    out.unsupported = true;
    why = "not an image the engine reads";
    return false;
  }
  scene::DecodedImage img;
  if (!scene::decode_image_file(file, img, why)) return false;
  out.image.width = static_cast<std::int32_t>(img.width);
  out.image.height = static_cast<std::int32_t>(img.height);
  out.image.rgba.resize(img.rgba.size());
  for (std::size_t i = 0; i < img.rgba.size(); ++i) out.image.rgba[i] = static_cast<float>(img.rgba[i]) / 255.0F;
  out.linear = false;         // 8-bit footage is sRGB-encoded
  out.premultiplied = false;  // straight alpha
  return true;
}

// ── SDK 1.2 (S3): an effect's clock ─────────────────────────────────────────
//
// A layer's time is read in ITS comp: for a layer inside sealed nested comps the
// frame's top-comp time maps through each comp instance (the source time the
// snapshot built that instance at, stamped on the entry as ownCompSeconds), and
// layer_start is relative to that comp. What the host evaluates off the document
// at other times (the camera, the lights, a checkout's frame) is in the TOP comp:
// own-comp times map back through each instance's layer clock (offset, stretch,
// reverse), anchored so the frame's own time maps back to the frame exactly.
struct EffectClock {
  doc::NativeLayerClock layer;                ///< the layer in its own comp
  std::vector<doc::NativeLayerClock> outer;   ///< the comp instances, top first
  double ownNow = 0;                          ///< the own comp's time at this frame
  double shift = 0;                           ///< top-comp anchor (time remap, frame rounding)

  /// Own-comp seconds → top-comp seconds.
  [[nodiscard]] double to_top(double own) const {
    for (auto it = outer.rbegin(); it != outer.rend(); ++it) own = it->comp_time(own);
    return own + shift;
  }
  /// Layer seconds → top-comp seconds.
  [[nodiscard]] double top_time(double layerSeconds) const { return to_top(layer.comp_time(layerSeconds)); }
};

/// The sealed comp instances a renderable id names, top first ("<instance>::…::<layer>").
std::vector<std::string> instance_chain(const doc::Document& d, std::string_view renderableId) {
  std::vector<std::string> out;
  std::size_t pos = 0;
  for (std::size_t next = renderableId.find("::", pos); next != std::string_view::npos; next = renderableId.find("::", pos)) {
    const std::string seg(renderableId.substr(pos, next - pos));
    pos = next + 2;
    const doc::Node* n = d.node(seg);
    if (n != nullptr && doc::read_comp_ref(*n) && !doc::read_comp_collapse(*n)) out.push_back(seg);
  }
  return out;
}

/// The document node a (possibly prefixed) layer id names: itself, else the part after the last "::".
std::string doc_layer_of(const doc::Document& d, const std::string& id) {
  if (d.node(id) != nullptr) return id;
  const std::size_t i = id.rfind("::");
  return i == std::string::npos ? id : id.substr(i + 2);
}

EffectClock effect_clock(const scene::BuildContext& c, const api::Renderable& r, const api::RenderEffect& e,
                         const std::string& layerId, double t) {
  EffectClock k;
  const double stamped = num_of(e, "ownCompSeconds", NAN);
  double x = t;
  for (const std::string& inst : instance_chain(c.d, r.id)) {
    k.outer.push_back(doc::native_layer_clock(c.d, c.view, inst, x));
    x = k.outer.back().layer_time(x);
  }
  k.ownNow = std::isfinite(stamped) ? stamped : x;
  k.layer = doc::native_layer_clock(c.d, c.view, layerId, k.ownNow);
  k.shift = t - k.to_top(k.ownNow);
  return k;
}

// ── SDK 1.2: what an effect checked out at other times (checkout_time) ──────
//
// A light evaluator: the effect's params, the comp camera, the comp lights and
// the LAYER params' world matrices at a time — read straight off the document
// (keyframes, expressions, parenting) the way the frame's own 3D setup reads
// them (threed_port.cpp Scene3D), never a whole frame per time. Within one
// frame every evaluation is kept, so a hundred effects asking for the same
// shutter samples pay once. Comp times between frames map to source times
// between frames (TlSubFrameScope), as the snapshot's motion-blur samples do.
//
// The frame's own time stays the frame's: when the frame shows the comp
// through another camera than its scene camera (a viewer's custom or axis
// view, which never moves) the samples keep the frame's camera too, and when
// the frame's lights are not the scene's (Draft 3D, the form rig) the samples
// keep the frame's lights — so a sample at the frame time equals the frame.
class Sampler {
 public:
  Sampler(const scene::BuildContext& c, std::string_view comp, double t, const scene::ViewSpec& view,
          const api::RenderFrameScene& scene)
      : c_(c), comp_(comp), view_(view), t_(t), scene_(scene), sc_{c.d, c.view, c.expr, c.cache},
        eval_(sc_, std::string(comp), scene.width > 0 ? scene.width : 1920, scene.height > 0 ? scene.height : 1080) {}

  SampleWire sample(const EffectSpec& spec, const api::RenderEffect& e, const std::string& layerId, const std::string& effectId,
                    const EffectClock& clock, const TimeRequest& q) {
    const doc::TlSubFrameScope subFrame;
    SampleWire w;
    w.time = q.time;
    w.what = q.what;
    const double layerSeconds = static_cast<double>(q.time) / kFlicks;
    const double compSeconds = clock.top_time(layerSeconds);  // the top comp's, where the host evaluates
    if ((q.what & PR_SAMPLE_PARAMS) != 0) w.params = params_at(layerId, effectId, layerSeconds, e);
    if ((q.what & PR_SAMPLE_CAMERA) != 0 && spec.has(PR_OUT_FLAG_USES_CAMERA)) w.camera = camera_at(compSeconds);
    if ((q.what & PR_SAMPLE_LIGHTS) != 0 && spec.has(PR_OUT_FLAG_USES_LIGHTS)) w.lights = lights_at(compSeconds);
    if ((q.what & PR_SAMPLE_LAYER_TRANSFORMS) != 0 && spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS)) {
      for (const ParamSpec& s : spec.params) {
        if (s.type != PR_PARAM_LAYER) continue;
        const std::string id = text_of(e, "p." + s.key);
        if (id.empty()) continue;
        if (auto m = layer_matrix_at(id, compSeconds)) w.matrices.emplace_back(s.key, std::move(*m));
      }
    }
    if ((q.what & PR_SAMPLE_SCENE_DEPTH) != 0 && spec.has(PR_OUT_FLAG_USES_SCENE_DEPTH)) w.depth = depth_at(compSeconds);
    return w;
  }

  /// SDK 1.1 values a frame with no 3D layer does not carry (it has no camera3d / lights3d):
  /// the scene's own at the frame time. nullopt when the frame carries its own.
  std::optional<std::optional<api::RenderCamera3D>> frame_camera_if_missing() {
    if (frame3d()) return std::nullopt;
    const doc::TlSubFrameScope subFrame;
    return camera_at(t_);
  }
  std::optional<std::vector<api::RenderLight3D>> frame_lights_if_missing() {
    if (frame3d()) return std::nullopt;
    const doc::TlSubFrameScope subFrame;
    return lights_at(t_);
  }

  /// The frame's LAYER-param matrices in the SDK's contract (layer px → world): what
  /// encode_native_scene wrote from the renderables (their unit quads) is replaced where the
  /// document places the layer.
  /// SDK 1.4 (T): the effect's inputs at layer time `layerFlicks` — the frame's entry with its
  /// animatable params evaluated at that time (what a SIM_STEP of that frame reads).
  RenderInputs inputs_at(const EffectSpec& spec, const api::RenderEffect& frameEntry, const std::string& docLayer,
                         const std::string& effectId, std::int64_t layerFlicks) {
    api::RenderEffect copy = frameEntry;
    for (api::RenderEffectParam& v : params_at(docLayer, effectId, static_cast<double>(layerFlicks) / kFlicks, frameEntry)) {
      const auto it = std::ranges::find_if(copy.params, [&](const api::RenderEffectParam& q) { return q.name == v.name; });
      if (it != copy.params.end()) *it = std::move(v);
      else copy.params.push_back(std::move(v));
    }
    RenderInputs in;
    decode_native_fx(copy, spec, in);
    in.layerTime = layerFlicks;
    return in;
  }

  /// SDK 1.4 (D): layer px → comp world px (column-major) at the frame's time.
  std::optional<motion::xf::Mat4> layer_world(const std::string& layerId) { return eval_.layer_world(layerId, t_); }

  void layer_matrices(api::RenderEffect& e, const EffectSpec& spec) {
    for (const ParamSpec& s : spec.params) {
      if (s.type != PR_PARAM_LAYER) continue;
      const std::string id = text_of(e, "p." + s.key);
      if (id.empty()) continue;
      if (auto m = eval_.layer_world(id, t_)) param(e, "p." + s.key + ".m", api::RenderParamKind::numbers).numbers.assign(m->begin(), m->end());
    }
  }

 private:
  [[nodiscard]] bool frame3d() const { return scene_.camera3d && scene_.camera3d->view.size() == 16; }
  /// The effect's `p.<key>` chain entries at layer time `layerSeconds` (animatable kinds only).
  std::vector<api::RenderEffectParam> params_at(const std::string& layerId, const std::string& effectId, double layerSeconds,
                                                const api::RenderEffect& frameEntry) {
    std::vector<api::RenderEffectParam> out;
    const doc::Node* n = c_.d.node(layerId);
    if (n == nullptr) return out;
    const js::Json* effect = nullptr;
    const std::vector<js::Json> effects = doc::read_node_effects(*n);
    for (const js::Json& e : effects) {
      if (e.at("id").is_string() && e.at("id").str() == effectId) effect = &e;
    }
    if (effect == nullptr) return out;
    const auto key = std::make_pair(layerId, flicks(layerSeconds));
    auto it = values_.find(key);
    if (it == values_.end()) {
      it = values_.emplace(key, scene::Values(doc::anim_evaluate_node(c_.d, c_.expr, c_.cache, layerId, layerSeconds))).first;
    }
    const std::vector<js::Json> resolved = scene::resolve_effect_params({*effect}, it->second, layerSeconds);
    if (resolved.empty()) return out;
    scene::RLayer l;
    l.id = layerId;
    l.width = num_of(frameEntry, "layerW", 0);
    l.height = num_of(frameEntry, "layerH", 0);
    std::optional<api::RenderEffect> entry = scene::native_effect_entry(resolved[0], doc::params_of(resolved[0]), l);
    if (!entry) return out;
    for (api::RenderEffectParam& p : entry->params) {
      const bool animatable = p.kind == api::RenderParamKind::number || p.kind == api::RenderParamKind::flag ||
                              p.kind == api::RenderParamKind::color;
      if (p.name.starts_with("p.") && animatable && !p.name.ends_with(".closed")) out.push_back(std::move(p));
    }
    return out;
  }

  std::optional<api::RenderCamera3D> eval_camera(double seconds) {
    std::optional<api::RenderCamera3D> out = eval_.camera(seconds);
    if (out && scene_.camera3d && scene_.camera3d->dof) out->dof = scene_.camera3d->dof;  // the lens settings of the frame
    return out;
  }

  static bool same_matrix(const std::vector<double>& a, const std::vector<double>& b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i) {
      if (std::abs(a[i] - b[i]) > 1e-6 * std::max(1.0, std::abs(a[i]))) return false;
    }
    return true;
  }

  std::optional<api::RenderCamera3D> camera_at(double seconds) {
    if (cameraFollowsFrame_ < 0) {
      // A frame with no 3D layer carries no camera: the scene's own is evaluated (AE gives a
      // plugin on a 2D solid the comp camera). One that shows another view keeps it.
      const bool frameHas = frame3d();
      const auto atFrame = frameHas ? eval_camera(t_) : std::nullopt;
      cameraFollowsFrame_ = frameHas && (!atFrame || !(same_matrix(scene_.camera3d->view, atFrame->view) &&
                                                       same_matrix(scene_.camera3d->projection, atFrame->projection)))
                                ? 1
                                : 0;
    }
    if (cameraFollowsFrame_ == 1) return scene_.camera3d;
    const std::int64_t k = flicks(seconds);
    auto it = cameras_.find(k);
    if (it == cameras_.end()) it = cameras_.emplace(k, eval_camera(seconds)).first;
    return it->second;
  }

  std::vector<api::RenderLight3D> eval_lights(double seconds) { return eval_.lights(seconds); }

  std::vector<api::RenderLight3D> lights_at(double seconds) {
    if (lightsFollowFrame_ < 0) lightsFollowFrame_ = frame3d() && eval_lights(t_).size() != scene_.lights3d.size() ? 1 : 0;
    if (lightsFollowFrame_ == 1) return scene_.lights3d;
    const std::int64_t k = flicks(seconds);
    auto it = lights_.find(k);
    if (it == lights_.end()) it = lights_.emplace(k, eval_lights(seconds)).first;
    return it->second;
  }

  /// A layer's own layer → world 4×4 off the document (2D: its affine at z = 0).
  std::optional<motion::xf::Mat4> world_of(const std::string& id, double seconds) { return eval_.world(id, seconds); }

  /// A LAYER param's matrix at comp `seconds`, in the frame's convention: the frame's renderable
  /// matrix moved by how the layer moved since the frame (W(t) · W(frame)⁻¹ · R(frame)).
  /// A LAYER param's matrix at comp `seconds` — the SDK's contract (pr_host.h): layer px → comp
  /// world px, off the document (SceneEval::layer_world); a layer the document cannot place (a
  /// precomp instance's copy, a text layer here) falls back to the frame's renderable, moved.
  std::optional<std::vector<double>> layer_matrix_at(const std::string& id, double seconds) {
    if (auto m = eval_.layer_world(id, seconds)) return std::vector<double>(m->begin(), m->end());
    return matrix_at(id, seconds);
  }

  /// A renderable's drawn model (renderable_world_matrix: the unit quad's) at comp `seconds`, moved by
  /// how the layer moved since the frame — the depth pass draws these.
  std::optional<std::vector<double>> matrix_at(const std::string& id, double seconds) {
    const api::Renderable* r = find_renderable_in(scene_.renderables, id);
    if (r == nullptr) return std::nullopt;
    const std::optional<std::vector<double>> frameM = renderable_world_matrix(*r);
    const std::optional<motion::xf::Mat4> wf = world_of(id, t_);
    const std::optional<motion::xf::Mat4> wt = world_of(id, seconds);
    if (!frameM || !wf || !wt) return std::nullopt;
    const std::optional<motion::xf::Mat4> inv = motion::xf::invert(*wf);
    if (!inv) return std::nullopt;
    motion::xf::Mat4 rf{};
    std::copy_n(frameM->begin(), 16, rf.begin());
    const motion::xf::Mat4 out = motion::xf::multiply(*wt, motion::xf::multiply(*inv, rf));
    return std::vector<double>(out.begin(), out.end());
  }

  /// SDK 1.2 (PR_SAMPLE_SCENE_DEPTH): the comp camera and every 3D layer the scene depth draws
  /// (render_graph/scene_depth.cpp collect_drawn: the depth-eligible 3D renderables and the 3D
  /// layers of collapsed 3D precomps) posed at comp `seconds`. A collapsed precomp's layers (copies
  /// the document cannot place) are posed by a frame built at that time (built_model_at): their
  /// instance moves them as well as their own tracks.
  DepthPose depth_at(double seconds) {
    const std::int64_t k = flicks(seconds);
    if (const auto it = depths_.find(k); it != depths_.end()) return it->second;
    DepthPose d;
    d.camera = camera_at(seconds);
    std::vector<const api::Renderable*> drawn;
    const std::function<void(const std::vector<api::Renderable>&, int)> collect = [&](const std::vector<api::Renderable>& list, int depth) {
      for (const api::Renderable& r : list) {
        if (r.matte_source || r.light_wash || !(r.opacity > 0)) continue;
        if (r.precomp) {
          if (!r.precomp->camera3d && !r.precomp->flat_width && depth < 16) collect(r.precomp_children, depth + 1);
          continue;
        }
        if (rg::depth_eligible_3d(r) && r.three_d->model.size() == 16) drawn.push_back(&r);
      }
    };
    collect(scene_.renderables, 0);
    for (const api::Renderable* r : drawn) {
      // A layer the document places is moved by its own tracks; one it cannot (a collapsed
      // precomp's copy, "<instance>::<id>") is read from the frame built at that time.
      std::optional<std::vector<double>> m = matrix_at(r->id, seconds);
      if (!m) m = built_model_at(r->id, seconds);
      if (m) d.models.emplace_back(r->id, std::move(*m));
    }
    return depths_.emplace(k, std::move(d)).first->second;
  }

  /// A renderable's 3D model in the frame built at comp `seconds` (no motion blur, no plugins run):
  /// for the layers of a collapsed precomp, posed by their instance's motion and their own. One
  /// build per time, kept for this frame — only when such a layer's depth is asked for at a sub-time.
  std::optional<std::vector<double>> built_model_at(const std::string& id, double seconds) {
    const std::int64_t k = flicks(seconds);
    auto it = built_.find(k);
    if (it == built_.end()) it = built_.emplace(k, scene::build_native_frame(c_, comp_, seconds, view_, false)).first;
    const api::Renderable* r = find_renderable_in(it->second.file.scene.renderables, id);
    if (r == nullptr || !r->three_d || r->three_d->model.size() != 16) return std::nullopt;  // not drawn then: its frame pose
    return r->three_d->model;
  }

  const scene::BuildContext& c_;
  std::string comp_;
  scene::ViewSpec view_;
  double t_;
  const api::RenderFrameScene& scene_;
  doc::SpaceCtx sc_;
  SceneEval eval_;  // the camera, lights and world matrices off the document, kept per time
  int cameraFollowsFrame_ = -1;
  int lightsFollowFrame_ = -1;
  std::map<std::int64_t, std::optional<api::RenderCamera3D>> cameras_;
  std::map<std::int64_t, std::vector<api::RenderLight3D>> lights_;
  std::map<std::pair<std::string, std::int64_t>, scene::Values> values_;
  std::map<std::int64_t, DepthPose> depths_;
  std::map<std::int64_t, scene::NativeFrame> built_;
};

}  // namespace

namespace {

/// SDK 1.4 (D): a plugin's mesh as a 3D renderable of the comp (the extruded-mesh path: 8 floats
/// per vertex, u32 indices), placed by its layer's world matrix.
api::Renderable contributed_mesh(const api::Renderable& owner, const ContribMesh& m, const motion::xf::Mat4& world, std::size_t i) {
  api::Renderable r;
  const std::size_t n = m.positions.size() / 3;
  api::RenderExtrudedMesh em;
  em.vertices.reserve(n * 8 * 4);
  std::uint64_t h = 1469598103934665603ULL;
  const auto put = [&](float f) {
    std::uint32_t bits = 0;
    std::memcpy(&bits, &f, sizeof bits);
    for (std::uint32_t k = 0; k < 4; ++k) {
      const auto b = static_cast<std::uint8_t>((bits >> (8U * k)) & 0xFFU);
      em.vertices.push_back(b);
      h = (h ^ b) * 1099511628211ULL;
    }
  };
  for (std::size_t v = 0; v < n; ++v) {
    for (std::size_t k = 0; k < 3; ++k) put(m.positions[(3 * v) + k]);
    const float nx = m.normals[3 * v], ny = m.normals[(3 * v) + 1], nz = m.normals[(3 * v) + 2];
    const float len = std::sqrt((nx * nx) + (ny * ny) + (nz * nz));
    put(len > 0 ? nx / len : 0.0F);
    put(len > 0 ? ny / len : 0.0F);
    put(len > 0 ? nz / len : 1.0F);
    put(m.uvs[2 * v]);
    put(m.uvs[(2 * v) + 1]);
  }
  em.indices.reserve(m.indices.size() * 4);
  for (const std::uint32_t ix : m.indices) {
    for (std::uint32_t k = 0; k < 4; ++k) {
      const auto b = static_cast<std::uint8_t>((ix >> (8U * k)) & 0xFFU);
      em.indices.push_back(b);
      h = (h ^ b) * 1099511628211ULL;
    }
  }
  em.index_format = api::RenderIndexFormat::uint32;
  r.id = owner.id + "::plugin-mesh-" + std::to_string(i);
  char key[17];
  std::snprintf(key, sizeof key, "%016llx", static_cast<unsigned long long>(h));
  em.key = r.id + "#" + key;  // the GPU buffers are kept by key: new geometry, new key
  api::RenderMeshRange range;
  range.role = api::RenderMeshRole::front;
  range.first = 0;
  range.count = static_cast<std::uint32_t>(m.indices.size());
  range.color.r = m.color[0];
  range.color.g = m.color[1];
  range.color.b = m.color[2];
  range.color.a = m.color[3];
  range.gain = 1;
  em.ranges.push_back(range);
  em.surface = api::RenderMeshSurface::uv;
  em.surface_width = 1;
  em.surface_height = 1;
  r.extruded_mesh = std::move(em);
  r.kind = api::RenderableKind::rect;
  r.model_matrix = owner.model_matrix;
  r.bounds = owner.bounds;
  r.opacity = owner.opacity;
  r.blend = api::RenderBlendMode::normal;
  r.sampling = owner.sampling;
  r.color = api::Color{1, 1, 1, 1};
  api::RenderThreeD t;
  const motion::xf::Mat4 local = [&] {
    motion::xf::Mat4 x{};
    std::ranges::copy(m.transform, x.begin());
    return x;
  }();
  const motion::xf::Mat4 model = motion::xf::multiply(world, local);
  t.model.assign(model.begin(), model.end());
  t.casts_shadow = m.castsShadows;
  t.accepts_shadows = m.acceptsShadows;
  api::RenderShade3D shade;
  shade.specular = 0.5;
  shade.shininess = 5 + ((1 - m.roughness) * 95);
  shade.metal = m.metallic;
  shade.roughness = m.roughness;
  shade.accepts_shadows = m.acceptsShadows;
  t.shade = shade;
  // D2: comp motion blur. The mesh rides its layer rigidly, so at each shutter sample its model is
  // the layer's sample pose relative to its frame pose (S · F⁻¹), applied to the mesh's frame model.
  if (owner.three_d && owner.three_d->model.size() == 16 && !owner.motion_samples.empty()) {
    motion::xf::Mat4 frame{};
    std::ranges::copy(owner.three_d->model, frame.begin());
    if (const std::optional<motion::xf::Mat4> inv = motion::xf::invert(frame)) {
      for (const api::RenderMotionSample& s : owner.motion_samples) {
        api::RenderMotionSample ms = s;
        if (s.model3d.size() == 16) {
          motion::xf::Mat4 sm{};
          std::ranges::copy(s.model3d, sm.begin());
          const motion::xf::Mat4 at = motion::xf::multiply(motion::xf::multiply(sm, *inv), model);
          ms.model3d.assign(at.begin(), at.end());
        } else {
          ms.model3d = t.model;  // a 2D sample of the owner: the mesh holds its frame pose
        }
        r.motion_samples.push_back(std::move(ms));
      }
    }
  }
  r.three_d = std::move(t);
  return r;
}

/// SDK 1.4 (D): a plugin's light (layer px) as a comp light.
api::RenderLight3D contributed_light(const ContribLight& l, const motion::xf::Mat4& world) {
  const auto apply = [&](const std::array<double, 3>& p) {
    return std::array<double, 3>{(world[0] * p[0]) + (world[4] * p[1]) + (world[8] * p[2]) + world[12],
                                 (world[1] * p[0]) + (world[5] * p[1]) + (world[9] * p[2]) + world[13],
                                 (world[2] * p[0]) + (world[6] * p[1]) + (world[10] * p[2]) + world[14]};
  };
  api::RenderLight3D o;
  o.type = l.type == PR_LIGHT_PARALLEL ? api::RenderLightType::parallel
           : l.type == PR_LIGHT_SPOT   ? api::RenderLightType::spot
           : l.type == PR_LIGHT_POINT  ? api::RenderLightType::point
                                       : api::RenderLightType::ambient;
  o.color = {l.color[0], l.color[1], l.color[2]};
  o.gain = l.intensity;
  const std::array<double, 3> p = apply(l.position);
  const std::array<double, 3> aim = apply({l.position[0] + l.direction[0], l.position[1] + l.direction[1], l.position[2] + l.direction[2]});
  o.x = p[0];
  o.y = p[1];
  o.z = p[2];
  o.aim_x = aim[0];
  o.aim_y = aim[1];
  o.aim_z = aim[2];
  o.half_cone_rad = l.coneAngle / 2;
  o.cone_feather_rad = l.coneFeather;
  o.falloff_mode = l.falloff;
  o.falloff_distance = l.falloffDistance;
  if (l.castsShadows) {
    o.shadow_map = true;
    o.shadow_darkness = l.shadowDarkness;
    o.shadow_diffusion = l.shadowDiffusion;
  }
  return o;
}

}  // namespace

void finish_native_frame(const scene::BuildContext& c, std::string_view comp, double t, const scene::ViewSpec& view,
                         bool motionBlur, scene::NativeFrame& frame, PluginHost* host, double simBudgetMs) {
  // Frames are built on several threads (the session's prefetch workers); a
  // plugin's instances are not required to be re-entrant: one frame's plugin
  // work at a time.
  static std::mutex oneAtATime;
  const std::scoped_lock pluginLock(oneAtATime);
  static std::once_flag decoders;
  std::call_once(decoders, [] { set_asset_image_decoder(&engine_decode); });
  const std::int64_t tf = flicks(t);
  const scene::MotionBlurCfg mb = scene::motion_blur_of(c.d, comp);
  double fps = mb.fps;
  if (!(fps > 0)) fps = 30;
  const auto step = static_cast<std::int64_t>(std::llround(kFlicks / fps));
  const double compW = frame.file.scene.width;
  const double compH = frame.file.scene.height;
  std::vector<Want> wants;
  // SDK 1.4 (D): instances that add meshes / lights to the comp's 3D scene (after the loop).
  struct Contribution {
    api::RenderEffect entry;
    const EffectSpec* spec;
    std::string ownerId, layerId, docLayer, effectId, instance;
    std::int64_t lt;
  };
  std::vector<Contribution> contributions;
  std::set<std::string> reported;
  Sampler sampler(c, comp, t, view, frame.file.scene);

  // SDK 1.4 (C): the frame's published channels, before any instance renders. Publishers run in
  // the order their manifests' "reads" / "publishes" give; a cycle is refused (layerErrors).
  // C2: the same pass runs again at a simulation step's time (`shift` flicks from the frame), so a
  // SIM_STEP reads the channels as they were at that step, not at the frame being drawn.
  struct Pub {
    api::RenderEffect e;  // a copy: the frame's entries change as instances render below
    const EffectSpec* spec;
    std::string layerId, instance, docLayer, effectId;
    std::int64_t lt;
  };
  std::vector<Pub> pubs;
  const auto publish_all = [&](std::int64_t shift, bool report) {
    ChannelValues channels;
    // Kahn's order: P before Q when Q reads a channel P publishes.
    const auto feeds = [](const Pub& p, const Pub& q) {
      return &p != &q && std::ranges::any_of(q.spec->reads, [&](const std::string& n) { return std::ranges::find(p.spec->publishes, n) != p.spec->publishes.end(); });
    };
    std::vector<bool> done(pubs.size(), false);
    std::map<std::string, std::string> publishedBy;
    for (std::size_t round = 0; round < pubs.size(); ++round) {
      bool progressed = false;
      for (std::size_t i = 0; i < pubs.size(); ++i) {
        if (done[i]) continue;
        bool ready = true;
        for (std::size_t j = 0; j < pubs.size() && ready; ++j) ready = done[j] || !feeds(pubs[j], pubs[i]);
        if (!ready) continue;
        done[i] = true;
        progressed = true;
        const Pub& p = pubs[i];
        RenderInputs in = sampler.inputs_at(*p.spec, p.e, p.docLayer, p.effectId, p.lt + shift);
        in.compTime = tf + shift;
        for (const std::string& n : p.spec->reads) {
          if (const auto it = channels.find(n); it != channels.end()) in.channels[n] = it->second;
        }
        ChannelValues out;
        const CallResult cr = host->publish_channels(in, out);
        if (!cr.ok) {
          if (report && !cr.skipped && reported.insert(p.instance + "#publish").second) {
            frame.errors.push_back(scene::LayerError{p.layerId, "", "plugin", "channels: " + cr.message});
          }
          continue;
        }
        for (auto& [name, values] : out) {
          if (const auto it = publishedBy.find(name); it != publishedBy.end()) {
            if (report && reported.insert(p.instance + "#dup#" + name).second) {
              frame.errors.push_back(scene::LayerError{p.layerId, "", "plugin",
                                                       "channels: '" + name + "' is already published this frame (layer " + it->second + ")"});
            }
            continue;
          }
          publishedBy[name] = p.layerId;
          channels[name] = std::move(values);
        }
      }
      if (!progressed) break;
    }
    for (std::size_t i = 0; i < pubs.size() && report; ++i) {
      if (!done[i] && reported.insert(pubs[i].instance + "#cycle").second) {
        frame.errors.push_back(scene::LayerError{pubs[i].layerId, "", "plugin",
                                                 "channels: " + pubs[i].spec->matchName + " is in a cycle of channels; it publishes nothing"});
      }
    }
    return channels;
  };
  ChannelValues channels;
  std::map<std::int64_t, ChannelValues> channelsAtShift;  // C2: per simulation step, this frame build
  if (host != nullptr) {
    visit(frame.file.scene.renderables, [&](api::Renderable& r, List& /*list*/) {
      for (api::RenderEffect& e : r.effects) {
        if (e.type != kNativeFxType) continue;
        const EffectSpec* spec = host->effect(text_of(e, "matchName"));
        if (spec == nullptr || !spec->has(PR_OUT_FLAG_PUBLISHES) || spec->publishes.empty()) continue;
        Pub p{e, spec, text_of(e, "layerId"), text_of(e, "instance"), "", "", tf};
        if (host->instance_disabled(p.instance, nullptr)) continue;
        const std::size_t slash = p.instance.rfind('/');
        p.effectId = slash == std::string::npos ? std::string() : p.instance.substr(slash + 1);
        p.docLayer = doc_layer_of(c.d, p.layerId);
        if (c.d.node(p.docLayer) != nullptr) {
          const EffectClock clock = effect_clock(c, r, e, p.docLayer, t);
          p.lt = flicks(clock.layer.layer_time(clock.ownNow));
        }
        pubs.push_back(std::move(p));
      }
    });
    channels = publish_all(0, true);
  }

  visit(frame.file.scene.renderables, [&](api::Renderable& r, List& list) {
    bool blursItself = false;
    for (api::RenderEffect& e : r.effects) {
      if (e.type != kNativeFxType) continue;
      const std::string layerId = text_of(e, "layerId");
      const std::string instance = text_of(e, "instance");
      const std::string matchName = text_of(e, "matchName");
      const std::size_t slash = instance.rfind('/');
      const std::string effectId = slash == std::string::npos ? std::string() : instance.substr(slash + 1);
      // A layer drawn inside a precomp carries its instance's prefix ("<instance>::<id>", a
      // collapsed or cloned copy too); its document node — params, state, files — is <id>.
      const std::string docLayer = doc_layer_of(c.d, layerId);
      const std::string prefix = layerId.substr(0, layerId.size() - docLayer.size());
      const doc::Node* node = c.d.node(docLayer);
      // SDK 1.2 (S3): the layer's own time — start offset, Time Stretch, reverse, freeze — the
      // mapping its keyframes use; checkouts at other times are layer times too.
      // In a nested comp, comp_time and layer_start are that comp's (effect_clock).
      const EffectClock clock = effect_clock(c, r, e, docLayer, t);
      const std::int64_t lt = node != nullptr ? flicks(clock.layer.layer_time(clock.ownNow)) : tf;
      set_num(e, "compTime", static_cast<double>(node != nullptr ? flicks(clock.ownNow) : tf));
      set_num(e, "layerTime", static_cast<double>(lt));
      set_num(e, "layerStart", static_cast<double>(node != nullptr ? flicks(clock.layer.comp_time(0)) : 0));
      set_num(e, "timeStep", static_cast<double>(step));
      set_num(e, "fps", fps);
      set_num(e, "compW", compW);
      set_num(e, "compH", compH);
      set_flag(e, "layer3d", r.three_d.has_value());
      // SDK 1.2 (S2): the comp's shutter; on when the render, the comp and the layer all blur.
      const bool blurOn = motionBlur && mb.enabled && node != nullptr && scene::read_node_motion_blur(*node);
      set_flag(e, "mb", blurOn);
      set_num(e, "shutterAngle", mb.shutterAngle);
      set_num(e, "shutterPhase", mb.shutterPhase);
      set_num(e, "mbSamples", mb.samples);
      // The instance's state, from the document (fx.pluginData, base64 as stored).
      if (node != nullptr) {
        const js::Json& group = node->fx().at("pluginData").at(doc::native_data_group(effectId));
        const js::Json& seq = group.at(doc::kNativeSequenceKey);
        if (seq.is_string()) set_text(e, "sequence", seq.str());
        if (const doc::NativeEffect* ne = doc::NativeEffects::find(matchName)) {
          for (const std::string& key : ne->arbitrary) {
            const js::Json& a = group.at(doc::native_arb_key(key));
            if (a.is_string()) set_text(e, "a." + key, a.str());
          }
          // SDK 1.1 FILE params: the project item as a file; a missing one is the layer's error, not a crash.
          for (const auto& [key, types] : ne->files) {
            const doc::NativeActionRequest::File f = doc::native_file_of(c.d, key, text_of(e, "p." + key));
            encode_native_file(e, f);
            if (f.missing && reported.insert(instance + "#" + key).second) {
              frame.errors.push_back(scene::LayerError{layerId, "", "plugin",
                                                       "file '" + (f.name.empty() ? f.item : f.name) + "' is missing (" + matchName + ")"});
            }
          }
        }
      }
      // A COLOR param the document stores as something other than a colour renders its
      // default (scene_native_fx.cpp marks it `invalid.<key>`): said once per instance and param.
      for (const api::RenderEffectParam& p : e.params) {
        if (!p.name.starts_with("invalid.") || !reported.insert(instance + "#" + p.name).second) continue;
        frame.errors.push_back(scene::LayerError{layerId, "", "plugin",
                                                 "parameter '" + p.text + "' is not a colour (#rrggbb); its default is used (" +
                                                     matchName + ")"});
      }
      if (host == nullptr) continue;
      if (std::string why; host->instance_disabled(instance, &why)) {
        if (reported.insert(instance).second) frame.errors.push_back(scene::LayerError{layerId, "", "plugin", why});
        continue;
      }
      const EffectSpec* spec = host->effect(matchName);
      if (spec == nullptr) {
        if (reported.insert(instance).second) {
          frame.errors.push_back(scene::LayerError{layerId, "", "plugin", "no loaded plugin provides '" + matchName + "'"});
        }
        continue;
      }
      // SDK 1.1: the camera / lights / layer matrices the effect declared it reads, at this frame
      // (SDK 1.2: a frame with no 3D layer still gives the comp's camera and lights).
      {
        std::optional<std::optional<api::RenderCamera3D>> cam;
        std::optional<std::vector<api::RenderLight3D>> lights;
        if (spec->has(PR_OUT_FLAG_USES_CAMERA)) cam = sampler.frame_camera_if_missing();
        if (spec->has(PR_OUT_FLAG_USES_LIGHTS)) lights = sampler.frame_lights_if_missing();
        encode_native_scene(e, *spec, frame.file.scene, cam && *cam ? &**cam : nullptr, lights ? &*lights : nullptr);
        if (spec->has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS)) sampler.layer_matrices(e, *spec);
      }
      // SDK 1.4 (T): a simulation's state after this layer frame's step (the host keeps the states,
      // so playing on or scrubbing back steps little or not at all); it travels with the frame.
      if (spec->has(PR_OUT_FLAG_STATEFUL) && node != nullptr) {
        SimRequest q;
        decode_native_fx(e, *spec, q.base);
        q.step = step;
        q.frame = step > 0 ? std::max<std::int64_t>(0, (lt + step / 2) / step) : 0;
        q.inputsKey = sim_inputs_key(c.d, *node, effectId, text_of(e, "sequence"));
        // C2: a simulation that reads channels steps on what its publishers give at each step's time;
        // their own keys join the simulation's (a publisher's edit re-steps; an expression: always).
        const bool readsChannels = !spec->reads.empty() && !pubs.empty();
        if (readsChannels && q.inputsKey != 0) {
          for (const Pub& p : pubs) {
            const doc::Node* pn = c.d.node(p.docLayer);
            const std::uint64_t pk = pn != nullptr ? sim_inputs_key(c.d, *pn, p.effectId, text_of(p.e, "sequence")) : 0;
            if (pk == 0) {
              q.inputsKey = 0;
              break;
            }
            q.inputsKey = (q.inputsKey ^ pk) * 1099511628211ULL;
          }
        }
        q.inputsAt = [&](std::int64_t k) {
          RenderInputs in = sampler.inputs_at(*spec, e, docLayer, effectId, k * step);
          if (readsChannels) {
            const std::int64_t shift = (k * step) - lt;
            auto at = channelsAtShift.find(shift);
            if (at == channelsAtShift.end()) at = channelsAtShift.emplace(shift, shift == 0 ? channels : publish_all(shift, false)).first;
            for (const std::string& n : spec->reads) {
              if (const auto ch = at->second.find(n); ch != at->second.end()) in.channels[n] = ch->second;
            }
          }
          return in;
        };
        bool partial = false;
        q.budgetMs = simBudgetMs;
        q.partial = &partial;
        std::string why;
        if (std::optional<std::vector<std::uint8_t>> st = host->sim_state(q, why)) {
          set_text(e, "simState", doc::native_base64(*st));
        } else if (partial) {
          frame.simPending = true;  // still catching up: not final, drawn again (engine_frames.cpp)
        } else if (reported.insert(instance + "#sim").second) {
          frame.errors.push_back(scene::LayerError{layerId, "", "plugin", "simulation: " + why});
        }
      }
      // SDK 1.4 (C): the channels it reads, as published this frame; they travel with the entry.
      for (const std::string& n : spec->reads) {
        if (const auto it = channels.find(n); it != channels.end()) {
          param(e, "ch." + n, api::RenderParamKind::numbers).numbers = it->second;
        }
      }
      if (spec->has(PR_OUT_FLAG_SCENE_CONTRIBUTE)) {
        if (r.three_d && &list == &frame.file.scene.renderables) {
          contributions.push_back({e, spec, r.id, layerId, docLayer, effectId, instance, lt});
        } else if (reported.insert(instance + "#scene").second) {
          frame.errors.push_back(scene::LayerError{layerId, "", "plugin",
                                                   matchName + " adds 3D geometry only on a 3D layer of the composition itself"});
        }
      }
      if (blurOn && spec->has(PR_OUT_FLAG_USES_SHUTTER)) blursItself = true;
      if (!spec->has(PR_OUT_FLAG_SMART_RENDER)) continue;
      // SMART_PRE_RENDER in the layer's own pixels: the checkouts at other times (WIDE_TIME_INPUT),
      // the times it samples (SDK 1.2 SAMPLES_TIME) and how far its result reaches past the layer.
      RenderInputs in;
      decode_native_fx(e, *spec, in);
      in.worldW = std::max(1, in.layerW);
      in.worldH = std::max(1, in.layerH);
      std::vector<CheckoutRequest> reqs;
      PreRenderInfo info;
      const CallResult pr = host->pre_render(in, reqs, &info);
      if (!pr.ok) {
        if (!pr.skipped && reported.insert(instance).second) frame.errors.push_back(scene::LayerError{layerId, "", "plugin", pr.message});
        continue;
      }
      // SDK 1.2 (S4): a result past the layer grows its effect buffer (fx_wire.hpp reachPx).
      double reach = spec->has(PR_OUT_FLAG_COMP_SPACE) ? std::hypot(compW, compH) : 0;
      reach = std::max({reach, static_cast<double>(-info.result.left), static_cast<double>(-info.result.top),
                        static_cast<double>(info.result.right - in.worldW), static_cast<double>(info.result.bottom - in.worldH)});
      if (reach > 0) set_num(e, "reachPx", std::min(reach, kMaxReachPx));
      // SDK 1.2 (S1): evaluate what it asked for at other times; the values travel with the frame.
      if (spec->has(PR_OUT_FLAG_SAMPLES_TIME) && !info.times.empty()) {
        std::vector<SampleWire> wires;
        wires.reserve(info.times.size());
        for (const TimeRequest& q : info.times) {
          if (q.time == lt) continue;  // the frame's own time: the entry already is that
          wires.push_back(sampler.sample(*spec, e, docLayer, effectId, clock, q));
        }
        if (!wires.empty()) encode_native_samples(e, *spec, std::move(wires));
      }
      if (!spec->has(PR_OUT_FLAG_WIDE_TIME_INPUT)) continue;
      for (const CheckoutRequest& q : reqs) {
        if (q.time == lt) continue;  // "now" is the chain's own input / a live layer
        std::string layer = q.paramIndex == 0 ? docLayer : q.paramIndex - 1 < in.values.size() ? in.values[q.paramIndex - 1].layer : "";
        if (layer.empty()) continue;
        layer = prefix + layer;  // the layers of the effect's own comp, drawn under its prefix
        // A checkout's time is the effect layer's time: the TOP composition is built at the matching time.
        const std::int64_t at = node != nullptr ? flicks(clock.top_time(static_cast<double>(q.time) / kFlicks)) : q.time;
        wants.push_back({std::move(layer), q.time, at, &list});
      }
    }
    // SDK 1.2 (S2): an effect that renders its own motion blur — the layer is not supersampled through it.
    if (blursItself) r.motion_samples.clear();
  });

  // SDK 1.4 (D): what the instances add to the 3D scene, drawn right after their layer.
  for (const Contribution& q : contributions) {
    std::vector<ContribMesh> meshes;
    std::vector<ContribLight> lights;
    const RenderInputs in = sampler.inputs_at(*q.spec, q.entry, q.docLayer, q.effectId, q.lt);
    const CallResult cr = host->scene_contribute(in, meshes, lights);
    if (!cr.ok) {
      if (!cr.skipped && reported.insert(q.instance + "#scene").second) {
        frame.errors.push_back(scene::LayerError{q.layerId, "", "plugin", "3D scene: " + cr.message});
      }
      continue;
    }
    const std::optional<motion::xf::Mat4> world = sampler.layer_world(q.docLayer);
    List& top = frame.file.scene.renderables;
    const auto owner = std::ranges::find_if(top, [&](const api::Renderable& x) { return x.id == q.ownerId; });
    if (!world || owner == top.end()) continue;
    std::vector<api::Renderable> added;
    for (std::size_t i = 0; i < meshes.size(); ++i) added.push_back(contributed_mesh(*owner, meshes[i], *world, i));
    top.insert(owner + 1, std::make_move_iterator(added.begin()), std::make_move_iterator(added.end()));
    for (const ContribLight& l : lights) frame.file.scene.lights3d.push_back(contributed_light(l, *world));
  }

  if (wants.empty()) return;
  std::map<std::int64_t, scene::NativeFrame> atTime;
  std::map<const List*, List> additions;
  std::set<std::pair<const List*, std::string>> added;
  for (const Want& w : wants) {
    const std::string id = checkout_renderable_id(w.layer, w.time);
    if (!added.insert({w.list, id}).second || find_renderable_in(*w.list, id) != nullptr) continue;
    auto it = atTime.find(w.compTime);
    if (it == atTime.end()) {
      scene::NativeFrame other = scene::build_native_frame(c, comp, static_cast<double>(w.compTime) / kFlicks, view, motionBlur);
      it = atTime.emplace(w.compTime, std::move(other)).first;
    }
    const scene::NativeFrame& other = it->second;
    const api::Renderable* src = find_renderable_in(other.file.scene.renderables, w.layer);
    if (src == nullptr) continue;  // the layer does not exist / is not drawn at that time: an empty checkout
    api::Renderable copy = *src;
    copy.id = id;
    copy.matte_source = true;  // never drawn by the composition; checked out by id
    copy.effects.clear();      // a checkout is the layer's source pixels (see PLUGIN_SDK.md)
    copy.matte.reset();
    copy.adjustment.reset();
    std::map<std::string, std::string> renamed;
    rename_keys(copy, "@" + std::to_string(w.time), renamed);
    for (const scene::TextureRequest& req : other.textures) {
      const auto k = renamed.find(req.key);
      if (k == renamed.end()) continue;
      scene::TextureRequest moved = req;
      moved.key = k->second;
      frame.textures.push_back(std::move(moved));
    }
    additions[w.list].push_back(std::move(copy));
  }
  apply_additions(frame.file.scene.renderables, additions);
}

}  // namespace premation::plugins
