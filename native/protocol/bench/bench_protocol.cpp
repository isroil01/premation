// Codec benchmark, C++ side (docs/ENGINE_API.md §9.3). Builds exactly the
// payloads of packages/engine-api/bench/benchDocument.ts; the encoded sizes
// printed here must equal the TypeScript ones (a cross-language check).
//
// Timing uses steady_clock — this is a benchmark binary, not render code.

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "engine_api.hpp"

namespace {

using namespace premation;
using namespace premation::api;

constexpr std::int64_t kF = 705'600'000;
constexpr std::int64_t kFpf = 23'520'000;  // 30 fps

std::string layer_id(std::uint32_t i) {
  char hex[32];
  std::snprintf(hex, sizeof hex, "%x", i);
  std::string h(hex);
  return "layer-" + std::string(30 - h.size(), '0') + h;
}

Value vec3(double x, double y, double z) {
  Value v;
  v.v.emplace<5>(Vec3{x, y, z});
  return v;
}

LayerInfo make_layer(std::uint32_t i) {
  static constexpr LayerKind kKinds[3] = {LayerKind::text, LayerKind::shape, LayerKind::image};
  LayerInfo l;
  l.id = layer_id(i);
  l.comp = "comp-main";
  l.kind = kKinds[i % 3];
  l.name = "Layer " + std::to_string(i + 1);
  if (i % 4 == 3) l.parent = layer_id(i - 1);
  if (l.kind == LayerKind::image) l.source = "item-image";
  l.switches.visible = true;
  l.switches.quality = LayerQuality::best;
  l.switches.effects_enabled = true;
  l.switches.motion_blur = i % 5 == 0;
  l.switches.three_d = i % 7 == 0;
  l.switches.label = i % 16;
  const std::int64_t in = static_cast<std::int64_t>(i) * kFpf;
  l.timing = LayerTiming{in, in + 10 * kF, in, 1.0, false, RetimeMode::normal};
  l.blend_mode = BlendMode::normal;
  l.matte.mode = MatteMode::none;
  l.has_video = true;
  return l;
}

struct PropSpec {
  const char* path;
  const char* name;
  const char* match;
  ValueType type;
  std::uint32_t dims;
};

constexpr PropSpec kProps[12] = {
    {"transform/anchorPoint", "Anchor Point", "ADBE Anchor Point", ValueType::vec3, 3},
    {"transform/position", "Position", "ADBE Position", ValueType::vec3, 3},
    {"transform/scale", "Scale", "ADBE Scale", ValueType::vec3, 3},
    {"transform/orientation", "Orientation", "ADBE Orientation", ValueType::vec3, 3},
    {"transform/xRotation", "X Rotation", "ADBE Rotate X", ValueType::scalar, 1},
    {"transform/yRotation", "Y Rotation", "ADBE Rotate Y", ValueType::scalar, 1},
    {"transform/rotation", "Z Rotation", "ADBE Rotate Z", ValueType::scalar, 1},
    {"transform/opacity", "Opacity", "ADBE Opacity", ValueType::scalar, 1},
    {"material/castsShadows", "Casts Shadows", "ADBE Casts Shadows", ValueType::choice, 1},
    {"material/acceptsLights", "Accepts Lights", "ADBE Accept Lights", ValueType::bool_, 1},
    {"audio/levels", "Audio Levels", "ADBE Audio Levels", ValueType::vec2, 2},
    {"timeRemap", "Time Remap", "ADBE Time Remapping", ValueType::scalar, 1},
};

PropertyTree make_tree(std::uint32_t i) {
  PropertyTree t;
  t.layer = layer_id(i);
  for (const auto& p : kProps) {
    PropertyInfo n;
    n.path = p.path;
    n.name = p.name;
    n.match_name = p.match;
    n.kind = PropertyKind::property;
    n.value_type = p.type;
    n.animatable = true;
    const bool pos = std::string(p.path) == "transform/position";
    n.animated = pos;
    n.dimensions = p.dims;
    n.enabled = true;
    Value v;
    switch (p.type) {
      case ValueType::vec3: v = vec3(i, i * 2.0, 0); break;
      case ValueType::vec2: v.v.emplace<4>(Vec2{0, 0}); break;
      case ValueType::scalar: v.v.emplace<3>(100.0); break;
      case ValueType::choice: v.v.emplace<9>("off"); break;
      case ValueType::bool_: v.v.emplace<1>(true); break;
      default: break;
    }
    n.value = v;
    if (p.type == ValueType::choice) n.choices = {"off", "on", "only"};
    n.keyframe_count = pos ? 2U : 0U;
    t.nodes.push_back(std::move(n));
  }
  return t;
}

KeyframeSet make_keyframes(std::uint32_t i) {
  KeyframeSet s;
  const std::string id = layer_id(i);
  s.prop = PropRef{id, "transform/position"};
  for (int j = 0; j < 2; ++j) {
    Keyframe k;
    k.id = id + "/k" + std::to_string(j);
    k.time = j * kF;
    k.value = vec3(i + j * 100.0, i, 0);
    k.easing = Easing::bezier;
    k.bezier = CubicBezier{0.33, 0, 0.67, 1};
    k.spatial_interp = SpatialInterp::legacy;
    s.keyframes.push_back(std::move(k));
  }
  return s;
}

DocumentSnapshot make_document(std::uint32_t n, bool full) {
  DocumentSnapshot d;
  d.revision = 1;
  d.project_path = "C:/projects/bench.motion";
  d.settings.bit_depth = BitDepth::u8;
  d.settings.working_space = ColorWorkingSpace::srgb;
  d.settings.time_display = TimeDisplay::timecode;
  d.settings.expression_engine = ExpressionEngine::premation;
  d.settings.audio_sample_rate = 48000;
  CompInfo c;
  c.id = "comp-main";
  auto& cs = c.settings;
  cs.name = "Main";
  cs.width = 1920;
  cs.height = 1080;
  cs.pixel_aspect = 1;
  cs.frame_rate = Rational{30, 1};
  cs.duration = 60 * kF;
  cs.background = Color{0, 0, 0, 1};
  cs.work_area = TimeRange{0, 60 * kF};
  cs.motion_blur = MotionBlurSettings{180, -90, 16, 128, std::nullopt};
  cs.renderer3d = Renderer3d::classic;
  cs.global_light_angle = 120;
  cs.global_light_altitude = 45;
  for (std::uint32_t i = 0; i < n; ++i) {
    d.layers.push_back(make_layer(i));
    c.layers.push_back(layer_id(i));
    if (full) {
      d.property_trees.push_back(make_tree(i));
      d.keyframes.push_back(make_keyframes(i));
    }
  }
  d.comps.push_back(std::move(c));
  return d;
}

Command make_set_property() {
  SetProperty sp;
  sp.prop = PropRef{layer_id(42), "transform/position"};
  sp.value = vec3(960.5, 540.25, 0);
  sp.time = 2 * kF;
  Command c;
  c.v = sp;
  return c;
}

EventBatch make_drag_events() {
  KeyframeSet set = make_keyframes(42);
  set.keyframes[1].value = vec3(960.5, 540.25, 0);
  KeyframesChangedEvent e;
  e.sets.push_back(std::move(set));
  Event ev;
  ev.v = e;
  EventBatch b;
  b.from_revision = 100;
  b.to_revision = 101;
  b.events.push_back(std::move(ev));
  b.caused_by = 7;
  b.origin = Origin::ui;
  return b;
}

template <class F>
double median_us(F&& fn, int iterations) {
  for (int i = 0; i < std::max(3, iterations / 10); ++i) fn();
  std::vector<double> batches;
  for (int b = 0; b < 7; ++b) {
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < iterations; ++i) fn();
    const auto t1 = std::chrono::steady_clock::now();
    batches.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count() / iterations);
  }
  std::sort(batches.begin(), batches.end());
  return batches[3];
}

template <class M>
void run(const char* name, const M& msg, int iterations) {
  wire::Writer w;
  encode(w, msg);
  const std::vector<std::uint8_t> bytes(w.bytes().begin(), w.bytes().end());
  const double enc = median_us([&] {
    wire::Writer ww;
    encode(ww, msg);
    return ww.bytes().size();
  }, iterations);
  const double dec = median_us([&] {
    M out{};
    wire::Reader r(bytes);
    return decode(r, out);
  }, iterations);
  std::printf("  %-36s %10zu B   encode %10.2f us   decode %10.2f us\n", name, bytes.size(), enc, dec);
}

}  // namespace

int main() {
  std::printf("premation_protocol codec (C++)\n");
  run("setProperty (one drag write)", make_set_property(), 200000);
  run("drag event batch", make_drag_events(), 100000);
  run("getDocument 2000 layers, headers", make_document(2000, false), 50);
  run("getDocument 2000 layers, full", make_document(2000, true), 10);
  return 0;
}
