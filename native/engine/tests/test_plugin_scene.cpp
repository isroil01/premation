// SDK 1.1 (pr_scene.h): the comp camera, lights and layer transforms reach a
// plugin through the host, only for an effect that declared it reads them,
// and the frame's scene travels in the chain entry (fx_wire encode/decode) so
// moving the camera changes the effect's inputs and nothing else's.
//
// The `particles` sample is the probe: a 3D emitter projected through the
// comp camera, tinted by the lights, placed at its Emitter layer.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstring>
#include <filesystem>
#include <vector>

#include "cpu_render.hpp"
#include "fx_wire.hpp"
#include "host.hpp"
#include "transform.hpp"

namespace pl = premation::plugins;
namespace api = premation::api;
namespace fs = std::filesystem;

namespace {

constexpr const char* kParticles = "com.premation.samples.particles";
constexpr std::uint32_t kW = 96, kH = 64;

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

/// Alpha-weighted centre of what was drawn, and the coverage sum.
struct Blob {
  double cx = 0, cy = 0, mass = 0;
  double r = 0, g = 0, b = 0;
};
Blob blob(const pl::TexelImage& img) {
  Blob o;
  for (std::uint32_t y = 0; y < img.height; ++y) {
    for (std::uint32_t x = 0; x < img.width; ++x) {
      const std::size_t i = (std::size_t{y} * img.width + x) * 4;
      const double a = img.bytes[i + 3] / 255.0;
      o.cx += a * (x + 0.5);
      o.cy += a * (y + 0.5);
      o.mass += a;
      o.r += img.bytes[i] / 255.0;
      o.g += img.bytes[i + 1] / 255.0;
      o.b += img.bytes[i + 2] / 255.0;
    }
  }
  if (o.mass > 0) {
    o.cx /= o.mass;
    o.cy /= o.mass;
  }
  return o;
}

pl::RenderInputs inputs(const pl::EffectSpec& spec) {
  pl::RenderInputs in = pl::default_inputs(spec, "L/fx", kW, kH, 8);
  in.compW = kW;
  in.compH = kH;
  in.layerTime = PR_TIME_SCALE;  // t = 1 s: the stream is running
  in.compTime = in.layerTime;
  in.camera = pl::SceneCamera{};  // declared, no camera layer: the comp's default view
  in.lights = std::vector<pl::SceneLight>{};
  in.layerMatrices.assign(spec.params.size(), std::nullopt);
  return in;
}

int param_index(const pl::EffectSpec& spec, std::uint32_t id) {
  for (std::size_t i = 0; i < spec.params.size(); ++i) {
    if (spec.params[i].id == id) return static_cast<int>(i);
  }
  return -1;
}

}  // namespace

TEST_CASE("SDK 1.1: particles render through the comp camera", "[plugins][scene]") {
  pl::PluginHost host(opts());
  (void)host.scan();
  const pl::EffectSpec* spec = host.effect(kParticles);
  REQUIRE(spec != nullptr);
  CHECK(spec->has(PR_OUT_FLAG_USES_CAMERA));
  CHECK(spec->has(PR_OUT_FLAG_USES_LIGHTS));
  CHECK(spec->has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS));

  // The default view: the burst rises from the comp's centre.
  pl::RenderInputs in = inputs(*spec);
  pl::TexelImage a;
  REQUIRE(pl::run_native_cpu(host, in, blank(), {}, a).ok);
  const Blob centre = blob(a);
  REQUIRE(centre.mass > 1);
  CHECK(std::abs(centre.cx - kW / 2.0) < 6);
  CHECK(centre.cy < kH / 2.0);  // emitted upward

  // Deterministic: the same frame twice is the same pixels.
  pl::TexelImage again;
  REQUIRE(pl::run_native_cpu(host, in, blank(), {}, again).ok);
  CHECK(again.bytes == a.bytes);

  SECTION("an orbited camera moves the burst (the camera is an input)") {
    namespace xf = motion::xf;
    xf::Camera cam = xf::default_camera(kW, kH);
    cam.position.x -= 40;  // dolly left: the scene slides right on screen
    pl::SceneCamera sc;
    sc.hasCamera = true;
    sc.view = xf::camera_view_matrix(cam);
    sc.projection = xf::camera_projection_matrix(cam);
    sc.eye = {cam.position.x, cam.position.y, cam.position.z};
    sc.zoom = cam.focal_length;
    in.camera = sc;
    pl::TexelImage moved;
    REQUIRE(pl::run_native_cpu(host, in, blank(), {}, moved).ok);
    CHECK(blob(moved).cx > centre.cx + 20);
  }

  SECTION("the emitter follows its layer's world matrix") {
    const int emitter = param_index(*spec, 1);
    REQUIRE(emitter >= 0);
    in.values[static_cast<std::size_t>(emitter)].layer = "E";
    std::array<double, 16> m{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, 48, 0, 1};  // translate to (20, 48)
    in.layerMatrices[static_cast<std::size_t>(emitter)] = m;
    pl::TexelImage left;
    REQUIRE(pl::run_native_cpu(host, in, blank(), {}, left).ok);
    CHECK(blob(left).cx < centre.cx - 15);
  }

  SECTION("lights tint it") {
    pl::SceneLight red;
    red.type = PR_LIGHT_AMBIENT;
    red.color = {1, 0, 0};
    in.lights = std::vector<pl::SceneLight>{red};
    pl::TexelImage lit;
    REQUIRE(pl::run_native_cpu(host, in, blank(), {}, lit).ok);
    const Blob b = blob(lit);
    CHECK(b.r > 1);
    CHECK(b.g < 0.01);
    CHECK(b.b < 0.01);
  }
}

TEST_CASE("SDK 1.1: the scene travels in the chain entry, only for effects that read it", "[plugins][scene]") {
  pl::EffectSpec spec;
  spec.matchName = "x.fx";
  pl::ParamSpec layer;
  layer.type = PR_PARAM_LAYER;
  layer.key = "p1";
  spec.params.push_back(layer);

  api::RenderFrameScene scene;
  scene.width = 1920;
  scene.height = 1080;
  api::RenderCamera3D cam;
  cam.view.assign(16, 0);
  cam.view[0] = cam.view[5] = cam.view[10] = cam.view[15] = 1;
  cam.view[14] = 2000;
  cam.projection.assign(16, 0);
  cam.projection[5] = 2666;
  cam.eye = {960, 540, -2000};
  scene.camera3d = cam;
  api::RenderLight3D spot;
  spot.type = api::RenderLightType::spot;
  spot.color = {1, 0.5, 0.25};
  spot.gain = 2;
  spot.x = 0;
  spot.y = 0;
  spot.z = -100;
  spot.aim_z = 100;
  spot.half_cone_rad = 0.5;
  scene.lights3d.push_back(spot);
  api::Renderable r;
  r.id = "E";
  r.model_matrix = {1, 0, 0, 0, 1, 0, 30, 40, 1};
  scene.renderables.push_back(r);

  api::RenderEffect e;
  api::RenderEffectParam p;
  p.name = "p.p1";
  p.kind = api::RenderParamKind::text;
  p.text = "E";
  e.params.push_back(p);

  // Not declared: nothing is written, nothing is read.
  api::RenderEffect plain = e;
  pl::encode_native_scene(plain, spec, scene);
  CHECK(plain.params.size() == 1);

  spec.outFlags = PR_OUT_FLAG_USES_CAMERA | PR_OUT_FLAG_USES_LIGHTS | PR_OUT_FLAG_USES_LAYER_TRANSFORMS;
  pl::encode_native_scene(e, spec, scene);
  pl::RenderInputs in;
  pl::decode_native_fx(e, spec, in);
  REQUIRE(in.camera.has_value());
  CHECK(in.camera->hasCamera);
  CHECK(in.camera->zoom == 2666);
  CHECK(in.camera->eye[2] == -2000);
  CHECK(in.compW == 1920);
  REQUIRE(in.lights.has_value());
  REQUIRE(in.lights->size() == 1);
  const pl::SceneLight& l = in.lights->front();
  CHECK(l.type == PR_LIGHT_SPOT);
  CHECK(l.intensity == 2);
  CHECK(l.direction[2] == 1);  // aimed down +z
  CHECK(l.coneAngle == 1.0);
  REQUIRE(in.layerMatrices.size() == 1);
  REQUIRE(in.layerMatrices[0].has_value());
  CHECK((*in.layerMatrices[0])[12] == 30);
  CHECK((*in.layerMatrices[0])[13] == 40);
}
