// Plugin SDK 1.2 on the CPU host (no GPU, no document): the version gate,
// checkout_time from SMART_PRE_RENDER, checkout_param / the scene callbacks at
// sampled times, the samples' wire form, the asset image decoders and the
// sibling-file rules, presets.
//
// The `particles` sample is the probe: its Trail Length checks out the past
// frames and draws each particle again where the camera, the emitter and the
// params put it THEN; with the comp's motion blur on it renders its own blur
// over the shutter.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstddef>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "asset_image.hpp"
#include "cpu_render.hpp"
#include "fx_wire.hpp"
#include "host.hpp"
#include "manifest.hpp"
#include "presets.hpp"
#include "transform.hpp"
#include "values.hpp"

namespace pl = premation::plugins;
namespace api = premation::api;
namespace doc = premation::doc;
namespace fs = std::filesystem;
using premation::js::Json;

namespace {

constexpr const char* kParticles = "com.premation.samples.particles";
constexpr std::uint32_t kW = 96, kH = 64;
enum : std::uint32_t { kCount = 2, kSpeed = 3, kTrail = 10, kBlur = 11 };

pl::HostOptions opts() {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES)};
  o.threads = 2;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

pl::TexelImage blank() {
  pl::TexelImage img;
  img.format = pl::TexelFormat::rgba8;
  img.width = kW;
  img.height = kH;
  img.bytes.assign(std::size_t{kW} * kH * 4, 0);
  return img;
}

double mass(const pl::TexelImage& img) {
  double m = 0;
  for (std::size_t i = 3; i < img.bytes.size(); i += 4) m += img.bytes[i] / 255.0;
  return m;
}

std::size_t slot(const pl::EffectSpec& spec, std::uint32_t id) {
  const int i = pl::param_slot(spec, id);
  REQUIRE(i >= 0);
  return static_cast<std::size_t>(i);
}

pl::RenderInputs inputs(const pl::EffectSpec& spec) {
  pl::RenderInputs in = pl::default_inputs(spec, "L/fx", kW, kH, 8);
  in.compW = kW;
  in.compH = kH;
  in.layerTime = PR_TIME_SCALE;  // 1 s: the stream is running
  in.compTime = in.layerTime;
  in.camera = pl::SceneCamera{};
  in.lights = std::vector<pl::SceneLight>{};
  in.layerMatrices.assign(spec.params.size(), std::nullopt);
  return in;
}

/// A sample at `time` with the frame's values, the default view dollied `dx` px.
pl::TimeSample sample_at(const pl::RenderInputs& in, std::int64_t time, double dx) {
  namespace xf = motion::xf;
  pl::TimeSample s;
  s.time = time;
  s.what = PR_SAMPLE_ALL;
  s.values = in.values;
  xf::Camera cam = xf::default_camera(kW, kH);
  cam.position.x += dx;
  pl::SceneCamera sc;
  sc.hasCamera = true;
  sc.view = xf::camera_view_matrix(cam);
  sc.projection = xf::camera_projection_matrix(cam);
  sc.eye = {cam.position.x, cam.position.y, cam.position.z};
  sc.zoom = cam.focal_length;
  s.camera = sc;
  s.lights = std::vector<pl::SceneLight>{};
  s.layerMatrices = in.layerMatrices;
  return s;
}

void write_bytes(const fs::path& p, const std::string& bytes) {
  std::ofstream f(p, std::ios::binary);
  f.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

}  // namespace

TEST_CASE("SDK 1.2: the version, appended and gated", "[plugins][sdk12]") {
  CHECK(PR_SDK_VERSION_MINOR == 4);  // SDK 1.4: layer types (test_plugin_finish.cpp [layertype], pluginLayerTypes.native.test.ts)
  std::string why;
  CHECK(pl::sdk_compatible(1, 0, why));
  CHECK(pl::sdk_compatible(1, 1, why));
  CHECK(pl::sdk_compatible(1, 2, why));
  CHECK(pl::sdk_compatible(1, 3, why));
  CHECK(pl::sdk_compatible(1, 4, why));
  CHECK_FALSE(pl::sdk_compatible(1, 5, why));
  CHECK(why.find("needs SDK 1.5") != std::string::npos);
  // SDK 1.3 appends its box callbacks after every 1.2 one.
  CHECK(offsetof(PrHostSuite, checkout_scene_depth_at) < offsetof(PrHostSuite, ui_fill));
  CHECK(offsetof(PrHostSuite, ui_fill) < offsetof(PrHostSuite, ui_text));
  // Appended, never reordered: the 1.1 callbacks keep their place in front of the 1.2 ones.
  CHECK(offsetof(PrHostSuite, get_asset_bytes) < offsetof(PrHostSuite, checkout_time));
  CHECK(offsetof(PrHostSuite, checkout_time) < offsetof(PrHostSuite, get_asset_sibling_bytes));
  CHECK(offsetof(PrInData, instance_key) < offsetof(PrInData, layer_start));
  CHECK(offsetof(PrInData, layer_start) < offsetof(PrInData, comp_to_world));

  // 1.0 (ripple), 1.1 (rings, grademap) and 1.2 (particles) samples load side by side.
  pl::PluginHost host(opts());
  for (const pl::PluginRecord& r : host.scan()) {
    if (r.id == "com.premation.samples.ripple" || r.id == "com.premation.samples.rings" || r.id == kParticles) {
      INFO(r.id << ": " << r.error);
      CHECK(r.status == pl::PluginStatus::loaded);
    }
    if (r.id == kParticles) CHECK(r.sdk == "1.2");
  }
}

TEST_CASE("SDK 1.2: checkout_time in SMART_PRE_RENDER", "[plugins][sdk12]") {
  pl::PluginHost host(opts());
  (void)host.scan();
  const pl::EffectSpec* spec = host.effect(kParticles);
  REQUIRE(spec != nullptr);
  CHECK(spec->has(PR_OUT_FLAG_SAMPLES_TIME));
  CHECK(spec->has(PR_OUT_FLAG_USES_SHUTTER));
  CHECK(spec->has(PR_OUT_FLAG_COMP_SPACE));
  pl::RenderInputs in = inputs(*spec);
  std::vector<pl::CheckoutRequest> reqs;
  pl::PreRenderInfo info;

  // No trail, no blur: nothing asked for; result_rect as the host preset it.
  REQUIRE(host.pre_render(in, reqs, &info).ok);
  CHECK(info.times.empty());
  CHECK(info.result.right == static_cast<std::int32_t>(kW));
  CHECK(info.result.bottom == static_cast<std::int32_t>(kH));

  // Trail Length 3: the three frames before this one, everything about them.
  in.values[slot(*spec, kTrail)].v[0] = 3;
  REQUIRE(host.pre_render(in, reqs, &info).ok);
  REQUIRE(info.times.size() == 3);
  for (std::size_t k = 0; k < 3; ++k) {
    CHECK(info.times[k].time == in.layerTime - static_cast<std::int64_t>(k + 1) * in.timeStep);
    CHECK(info.times[k].what == PR_SAMPLE_ALL);
  }

  // The comp's motion blur (180°, −90°, 8 samples): the shutter's times, around the frame.
  in.values[slot(*spec, kTrail)].v[0] = 0;
  in.motionBlur = true;
  in.shutterAngle = 180;
  in.shutterPhase = -90;
  in.motionBlurSamples = 8;
  REQUIRE(host.pre_render(in, reqs, &info).ok);
  REQUIRE(info.times.size() == 8);
  CHECK(info.times.front().time == in.layerTime - in.timeStep / 4);
  CHECK(info.times.back().time == in.layerTime + in.timeStep / 4);
  // The effect's own switch turns it off.
  in.values[slot(*spec, kBlur)].v[0] = 0;
  REQUIRE(host.pre_render(in, reqs, &info).ok);
  CHECK(info.times.empty());
}

TEST_CASE("SDK 1.2: a render reads the sampled times", "[plugins][sdk12]") {
  pl::PluginHost host(opts());
  (void)host.scan();
  const pl::EffectSpec* spec = host.effect(kParticles);
  REQUIRE(spec != nullptr);
  pl::RenderInputs in = inputs(*spec);
  pl::TexelImage frame;
  REQUIRE(pl::run_native_cpu(host, in, blank(), {}, frame).ok);
  REQUIRE(mass(frame) > 1);

  // A trail asked for but never evaluated (no frame hook ran): those passes are skipped —
  // checkout_param / get_comp_camera answer PR_ERR_NOT_FOUND — and the frame still renders.
  in.values[slot(*spec, kTrail)].v[0] = 2;
  pl::TexelImage unsampled;
  REQUIRE(pl::run_native_cpu(host, in, blank(), {}, unsampled).ok);
  CHECK(unsampled.bytes == frame.bytes);

  // Evaluated: the trail draws at the camera of its own time (dollied left: the scene slides right).
  in.samples = {sample_at(in, in.layerTime - 2 * in.timeStep, -30), sample_at(in, in.layerTime - in.timeStep, -30)};
  pl::TexelImage trail;
  REQUIRE(pl::run_native_cpu(host, in, blank(), {}, trail).ok);
  CHECK(mass(trail) > mass(frame) * 1.2);
  CHECK(trail.bytes != frame.bytes);

  // checkout_param: the sampled VALUES are what the trail draws with — no particles then, no trail.
  for (pl::TimeSample& s : in.samples) s.values[slot(*spec, kCount)].v[0] = 0;
  pl::TexelImage empty;
  REQUIRE(pl::run_native_cpu(host, in, blank(), {}, empty).ok);
  CHECK(empty.bytes == frame.bytes);

  // Shutter blur: spreads the same particles over the shutter (and is deterministic).
  in.values[slot(*spec, kTrail)].v[0] = 0;
  in.motionBlur = true;
  in.shutterAngle = 360;
  in.shutterPhase = -180;
  in.motionBlurSamples = 4;
  in.samples.clear();
  for (int i = 0; i < 4; ++i) {
    const std::int64_t t = in.layerTime + static_cast<std::int64_t>(std::llround((-180.0 + 360.0 * i / 3) / 360.0 * static_cast<double>(in.timeStep)));
    in.samples.push_back(sample_at(in, t, 0));
  }
  pl::TexelImage blurred;
  REQUIRE(pl::run_native_cpu(host, in, blank(), {}, blurred).ok);
  CHECK(blurred.bytes != frame.bytes);
  pl::TexelImage again;
  REQUIRE(pl::run_native_cpu(host, in, blank(), {}, again).ok);
  CHECK(again.bytes == blurred.bytes);
}

TEST_CASE("SDK 1.2: samples travel in the chain entry", "[plugins][sdk12]") {
  pl::EffectSpec spec;
  spec.matchName = "x.fx";
  spec.outFlags = PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_SAMPLES_TIME | PR_OUT_FLAG_USES_CAMERA | PR_OUT_FLAG_USES_LIGHTS |
                  PR_OUT_FLAG_USES_LAYER_TRANSFORMS;
  pl::ParamSpec speed;
  speed.type = PR_PARAM_FLOAT_SLIDER;
  speed.key = "p1";
  speed.def = {7, 0, 0, 0};
  pl::ParamSpec emitter;
  emitter.type = PR_PARAM_LAYER;
  emitter.key = "p2";
  pl::ParamSpec tint;
  tint.type = PR_PARAM_COLOR;
  tint.key = "p3";
  tint.def = {1, 1, 1, 1};
  spec.params = {speed, emitter, tint};

  api::RenderEffect e;
  const auto text = [&](std::string name, std::string v) {
    api::RenderEffectParam p;
    p.name = std::move(name);
    p.kind = api::RenderParamKind::text;
    p.text = std::move(v);
    e.params.push_back(std::move(p));
  };
  const auto number = [](std::string name, double v) {
    api::RenderEffectParam p;
    p.name = std::move(name);
    p.kind = api::RenderParamKind::number;
    p.number = v;
    return p;
  };
  text("p.p2", "E");
  e.params.push_back(number("p.p1", 10));
  e.params.push_back(number("layerTime", 1000));

  std::vector<pl::SampleWire> wires(2);
  wires[0].time = 900;  // given out of order: stored sorted
  wires[0].what = PR_SAMPLE_PARAMS | PR_SAMPLE_LAYER_TRANSFORMS;
  wires[0].params = {number("p.p1", 30)};
  wires[0].matrices = {{"p2", std::vector<double>{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1}}};
  wires[1].time = 800;
  wires[1].what = PR_SAMPLE_CAMERA | PR_SAMPLE_LIGHTS;
  api::RenderCamera3D cam;
  cam.view.assign(16, 0);
  cam.view[0] = cam.view[5] = cam.view[10] = cam.view[15] = 1;
  cam.projection.assign(16, 0);
  cam.projection[5] = 1234;
  cam.eye = {1, 2, 3};
  wires[1].camera = cam;
  api::RenderLight3D amb;
  amb.type = api::RenderLightType::ambient;
  amb.color = {0.5, 0.25, 1};
  amb.gain = 0.5;
  wires[1].lights = {amb};
  pl::encode_native_samples(e, spec, wires);

  pl::RenderInputs in;
  pl::decode_native_fx(e, spec, in);
  CHECK(in.values[0].v[0] == 10);
  REQUIRE(in.samples.size() == 2);
  CHECK(in.samples[0].time == 800);
  CHECK(in.samples[1].time == 900);
  // 800: camera + lights, no params.
  REQUIRE(in.samples[0].camera.has_value());
  CHECK(in.samples[0].camera->hasCamera);
  CHECK(in.samples[0].camera->zoom == 1234);
  CHECK(in.samples[0].camera->eye[2] == 3);
  REQUIRE(in.samples[0].lights.has_value());
  REQUIRE(in.samples[0].lights->size() == 1);
  CHECK(in.samples[0].lights->front().type == PR_LIGHT_AMBIENT);
  CHECK(in.samples[0].lights->front().intensity == 0.5);
  CHECK(in.samples[0].values.empty());
  // 900: the animatable value at that time, the static ones the frame's; the emitter's matrix.
  REQUIRE(in.samples[1].values.size() == 3);
  CHECK(in.samples[1].values[0].v[0] == 30);
  CHECK(in.samples[1].values[1].layer == "E");
  CHECK(in.samples[1].values[2].v == in.values[2].v);
  REQUIRE(in.samples[1].layerMatrices.size() == 3);
  REQUIRE(in.samples[1].layerMatrices[1].has_value());
  CHECK((*in.samples[1].layerMatrices[1])[12] == 5);
  CHECK((*in.samples[1].layerMatrices[1])[14] == 7);
}

TEST_CASE("SDK 1.2: asset images and sibling files", "[plugins][sdk12][assets]") {
  const fs::path dir = fs::temp_directory_path() / "premation-sdk12-assets";
  fs::remove_all(dir);
  fs::create_directories(dir / "textures");
  pl::clear_asset_images();

  SECTION("a binary PPM: sRGB → linear, opaque") {
    std::string ppm = "P6\n2 1\n255\n";
    ppm += std::string{'\xff', '\x00', '\x00', '\xbc', '\xbc', '\xbc'};  // red, sRGB 188 grey
    write_bytes(dir / "two.ppm", ppm);
    std::string key, why;
    bool unsupported = false;
    const auto img = pl::load_asset_image(dir / "two.ppm", key, why, unsupported);
    REQUIRE(img != nullptr);
    CHECK(img->width == 2);
    CHECK(img->height == 1);
    CHECK(img->rgba[0] == 1.0F);
    CHECK(img->rgba[1] == 0.0F);
    CHECK(img->rgba[3] == 1.0F);
    CHECK(std::abs(img->rgba[4] - 0.5F) < 0.01F);  // sRGB 188 ≈ linear 0.5
    // Kept per file and modification time: the same image object comes back.
    std::string key2;
    CHECK(pl::load_asset_image(dir / "two.ppm", key2, why, unsupported) == img);
    CHECK(key2 == key);
  }
  SECTION("a Radiance .hdr (flat and run-length scanlines): linear floats over 1") {
    std::string hdr = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n";
    hdr += std::string{'\x80', '\x40', '\x00', '\x82', '\x80', '\x80', '\x80', '\x80'};  // (2, 1, 0) and (0.5, 0.5, 0.5)
    write_bytes(dir / "sky.hdr", hdr);
    std::string key, why;
    bool unsupported = false;
    const auto img = pl::load_asset_image(dir / "sky.hdr", key, why, unsupported);
    REQUIRE(img != nullptr);
    CHECK(img->rgba[0] == 2.0F);
    CHECK(img->rgba[1] == 1.0F);
    CHECK(img->rgba[4] == 0.5F);
    CHECK(img->rgba[7] == 1.0F);
  }
  SECTION("no decoder: unsupported, never a crash") {
    write_bytes(dir / "model.glb", "glTF");
    std::string key, why;
    bool unsupported = false;
    pl::set_asset_image_decoder({});
    CHECK(pl::load_asset_image(dir / "model.glb", key, why, unsupported) == nullptr);
    CHECK(unsupported);
    // An installed decoder's straight sRGB pixels come out linear premultiplied.
    pl::set_asset_image_decoder([](const fs::path&, pl::DecodedAsset& out, std::string&) {
      out.image.width = 1;
      out.image.height = 1;
      out.image.rgba = {1, 1, 1, 0.5F};
      return true;
    });
    const auto img = pl::load_asset_image(dir / "model.glb", key, why, unsupported);
    REQUIRE(img != nullptr);
    CHECK(img->rgba[0] == 0.5F);
    CHECK(img->rgba[3] == 0.5F);
    pl::set_asset_image_decoder({});
  }
  SECTION("siblings: inside the asset's folder only") {
    write_bytes(dir / "scene.gltf", "{}");
    write_bytes(dir / "scene.bin", "BIN");
    write_bytes(dir / "textures" / "albedo.png", "PNG");
    write_bytes(dir.parent_path() / "premation-sdk12-outside.bin", "NO");
    fs::path out;
    std::string why;
    CHECK(pl::resolve_sibling(dir / "scene.gltf", "scene.bin", out, why));
    CHECK(pl::resolve_sibling(dir / "scene.gltf", "textures/albedo.png", out, why));
    CHECK(pl::resolve_sibling(dir / "scene.gltf", "textures\\albedo.png", out, why));
    CHECK(out.filename() == "albedo.png");
    CHECK_FALSE(pl::resolve_sibling(dir / "scene.gltf", "../premation-sdk12-outside.bin", out, why));
    CHECK_FALSE(pl::resolve_sibling(dir / "scene.gltf", "textures/../../premation-sdk12-outside.bin", out, why));
    CHECK_FALSE(pl::resolve_sibling(dir / "scene.gltf", (dir / "scene.bin").string(), out, why));
    CHECK_FALSE(pl::resolve_sibling(dir / "scene.gltf", "/etc/passwd", out, why));
    CHECK_FALSE(pl::resolve_sibling(dir / "scene.gltf", "C:/Windows/win.ini", out, why));
    CHECK_FALSE(pl::resolve_sibling(dir / "scene.gltf", "missing.bin", out, why));
    CHECK_FALSE(pl::resolve_sibling(dir / "scene.gltf", "textures", out, why));  // a folder is not a file
    std::error_code ec;
    fs::create_directory_symlink(dir.parent_path(), dir / "up", ec);
    if (!ec) CHECK_FALSE(pl::resolve_sibling(dir / "scene.gltf", "up/premation-sdk12-outside.bin", out, why));  // a symlink out
    fs::remove(dir.parent_path() / "premation-sdk12-outside.bin", ec);
  }
  fs::remove_all(dir);
}

TEST_CASE("SDK 1.2: presets", "[plugins][sdk12][presets]") {
  pl::PluginHost host(opts());
  (void)host.scan();
  const pl::EffectSpec* spec = host.effect(kParticles);
  REQUIRE(spec != nullptr);

  // The particles bundle: two in the manifest, one in presets/.
  const std::vector<api::PluginInfo> infos = host.plugin_infos();
  const api::PluginInfo* particles = nullptr;
  for (const api::PluginInfo& i : infos) {
    if (i.id == kParticles) particles = &i;
  }
  REQUIRE(particles != nullptr);
  REQUIRE(particles->presets.size() == 3);
  CHECK(particles->presets[0].name == "Warm Fountain");
  CHECK(particles->presets[0].effect == kParticles);
  CHECK(particles->presets[0].category == "Fountains");
  CHECK(particles->presets[2].name == "Comet Trails");
  const auto value_of = [](const api::PluginPresetInfo& p, std::string_view path) -> const api::Value* {
    for (const api::PropertyInit& v : p.values) {
      if (v.path == path) return &v.value;
    }
    return nullptr;
  };
  const api::Value* count = value_of(particles->presets[0], "p2");
  REQUIRE(count != nullptr);
  CHECK(doc::get<doc::VK::scalar>(*count) == 600);
  const api::Value* color = value_of(particles->presets[0], "p8");
  REQUIRE(color != nullptr);
  CHECK(std::abs(doc::get<doc::VK::color>(*color).g - 0xb3 / 255.0) < 1e-9);
  const api::Value* blur = value_of(particles->presets[2], "p11");
  REQUIRE(blur != nullptr);
  CHECK(doc::get<doc::VK::bool_>(*blur));

  SECTION("values are checked against the effect's params") {
    pl::PresetSpec p;
    p.name = "x";
    p.effect = kParticles;
    auto parsed = premation::js::parse(R"({"p2": 99999, "p1": "layer_1", "p8": [0.1, 0.2, 0.3], "p99": 1, "p3": "fast"})");
    REQUIRE(parsed.has_value());
    p.values = *parsed;
    const std::vector<api::PropertyInit> v = pl::preset_values(p, *spec);
    // p2 clamped to its valid range; p1 (a LAYER), p99 (none) and a string for a number dropped.
    REQUIRE(v.size() == 2);
    CHECK(v[0].path == "p2");
    CHECK(doc::get<doc::VK::scalar>(v[0].value) == 5000);
    CHECK(v[1].path == "p8");
    CHECK(doc::get<doc::VK::color>(v[1].value).a == 1);
  }
  SECTION("a bad preset is skipped and named, never fatal") {
    std::vector<std::string> problems;
    const auto list = pl::read_presets(fs::path(PREMATION_PLUGIN_BUNDLES) / "particles",
                                       R"({"presets": [{"values": {}}, {"name": "Other", "effect": "com.nobody.fx"}, {"name": "Ok"}]})",
                                       {kParticles}, problems);
    CHECK(problems.size() == 2);
    REQUIRE(list.size() == 2);  // "Ok" (the plugin's first effect) and presets/comet-trails.json
    CHECK(list[0].name == "Ok");
    CHECK(list[0].effect == kParticles);
  }
}
