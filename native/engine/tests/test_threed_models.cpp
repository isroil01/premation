// D2w 3D leftovers, end to end through the scene builder: an imported glTF
// model and a height-displaced primitive built from the C++ DOCUMENT.
//
//   * the model's file comes from the document (the imported root's Model
//     component carries `glbData`), the leaf becomes the mesh carrier with the
//     editor's key, its PBR map keys, and texture requests fed from the model's
//     own images (`gltf:<modelKey>#<image>`), which decode;
//   * a primitive whose Material Options name a height map (a data: image)
//     draws the displaced mesh, byte-identical to displace_mesh over the field
//     the builder decoded (luma of the image; the field decode is Chromium's
//     drawImage + getImageData, exact for an opaque image at ≤ 256 px).
//
// The model is the render-tests model-maps golden's GLB (gltf_model_parity.json).
// With that file in its document, the golden frame itself was checked through
// premation-scene: structurally equal to the TS FrameScene and pixel-equal to
// the webgpu frame (NATIVE_CORE_PLAN.md, "D2w 3D leftovers").
#include <catch2/catch_test_macros.hpp>

#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "docexpr.hpp"
#include "docio.hpp"
#include "env_asset.hpp"
#include "env_light.hpp"
#include "gltf_model.hpp"
#include "height_displacement.hpp"
#include "image_decode.hpp"
#include "json.hpp"
#include "mesh_displacement.hpp"
#include "model_carrier.hpp"
#include "native_effects.hpp"
#include "native_scene.hpp"
#include "primitive_mesh.hpp"

namespace sc = premation::scene;
namespace doc = premation::doc;
namespace js = premation::js;
namespace api = premation::api;
using js::Json;

namespace {

std::string base64(const std::vector<std::uint8_t>& b) {
  static constexpr std::string_view k = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string o;
  std::size_t i = 0;
  for (; i + 2 < b.size(); i += 3) {
    const std::uint32_t v = (std::uint32_t{b[i]} << 16U) | (std::uint32_t{b[i + 1]} << 8U) | b[i + 2];
    for (int s = 18; s >= 0; s -= 6) o += k[(v >> static_cast<unsigned>(s)) & 63U];
  }
  if (i < b.size()) {
    const std::uint32_t v = (std::uint32_t{b[i]} << 16U) | (i + 1 < b.size() ? std::uint32_t{b[i + 1]} << 8U : 0U);
    o += k[(v >> 18U) & 63U];
    o += k[(v >> 12U) & 63U];
    o += i + 1 < b.size() ? k[(v >> 6U) & 63U] : '=';
    o += '=';
  }
  return o;
}

/// A 24-bit bottom-up BMP of a w×h opaque RGB image.
std::vector<std::uint8_t> bmp(std::uint32_t w, std::uint32_t h, const std::vector<std::uint8_t>& rgb) {
  const std::uint32_t row = (w * 3 + 3) / 4 * 4;
  const std::uint32_t size = 54 + row * h;
  std::vector<std::uint8_t> b(size, 0);
  const auto put32 = [&b](std::size_t o, std::uint32_t v) { std::memcpy(b.data() + o, &v, 4); };
  const auto put16 = [&b](std::size_t o, std::uint16_t v) { std::memcpy(b.data() + o, &v, 2); };
  b[0] = 'B';
  b[1] = 'M';
  put32(2, size);
  put32(10, 54);
  put32(14, 40);
  put32(18, w);
  put32(22, h);
  put16(26, 1);
  put16(28, 24);
  put32(34, row * h);
  for (std::uint32_t y = 0; y < h; ++y) {
    const std::size_t dst = 54 + std::size_t{h - 1 - y} * row;
    for (std::uint32_t x = 0; x < w; ++x) {
      const std::size_t s = (std::size_t{y} * w + x) * 3;
      b[dst + x * 3] = rgb[s + 2];
      b[dst + x * 3 + 1] = rgb[s + 1];
      b[dst + x * 3 + 2] = rgb[s];
    }
  }
  return b;
}

std::string model_maps_glb_b64(std::string& key) {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/gltf_model_parity.json", std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fx = js::parse(ss.str());
  REQUIRE(fx.has_value());
  for (const Json& m : fx->at("models").arr()) {
    if (m.at("name").str() == "model-maps") {
      key = m.at("modelKey").str();
      return m.at("bytes").str();
    }
  }
  FAIL("model-maps missing from the fixture");
  return {};
}

}  // namespace

TEST_CASE("3D leftovers: a glTF model and a displaced primitive build from the C++ document", "[scene][gltf][displacement]") {
  sc::gltf::clear_models();
  sc::clear_height_fields();
  std::string modelKey;
  const std::string glb = model_maps_glb_b64(modelKey);

  // A 16×16 height map: bumps in the red/green/blue channels, opaque.
  constexpr std::uint32_t kF = 16;
  std::vector<std::uint8_t> rgb(std::size_t{kF} * kF * 3);
  for (std::uint32_t y = 0; y < kF; ++y) {
    for (std::uint32_t x = 0; x < kF; ++x) {
      const std::size_t i = (std::size_t{y} * kF + x) * 3;
      rgb[i] = static_cast<std::uint8_t>((x * 16 + y * 5) & 255U);
      rgb[i + 1] = static_cast<std::uint8_t>(((x ^ y) * 17) & 255U);
      rgb[i + 2] = static_cast<std::uint8_t>((y * 16) & 255U);
    }
  }
  const std::string heightSrc = "data:image/bmp;base64," + base64(bmp(kF, kF, rgb));
  {
    sc::DecodedImage probe;
    std::string err;
    if (!sc::decode_image_bytes(premation::doc::native_unbase64(base64(bmp(kF, kF, rgb))).value(), probe, err)) {
      WARN("no still-image codec on this platform (" << err << "): skipped");
      return;
    }
  }

  const std::string project = R"({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"Composition 1","parent":null,"children":["panel","bumpy","key","cam"],"transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,"components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"panel","name":"panel","children":[],"parent":"comp_root","transform":{"position":{"x":160,"y":180},"rotation":0,"scale":{"x":1,"y":1}},"components":[
      {"id":"panel_t","type":"Transform","props":{"__kind":"image","x":160,"y":180,"rotation":0,"width":260,"height":260,"z":0,"rotationY":-22,"rotationX":14,"scaleX":100,"scaleY":100,"scaleZ":100,"acceptsLights":true,"shadingModel":"pbr","metal":100,"roughness":100,"specular":40,"src":"blob:file:///dead-session-url"}},
      {"id":"panel_s","type":"Style","props":{"opacity":100}},
      {"id":"panel_model","type":"Model","props":{"modelKey":"MODELKEY","mesh":0,"prim":0,"glbData":"data:model/gltf-binary;base64,GLB"}}],"visible":true,"locked":false},
    {"id":"bumpy","name":"bumpy","children":[],"parent":"comp_root","transform":{"position":{"x":340,"y":180},"rotation":0,"scale":{"x":1,"y":1}},"components":[
      {"id":"bumpy_t","type":"Transform","props":{"__kind":"shape","x":340,"y":180,"rotation":0,"width":160,"height":160,"acceptsLights":true,"z":0,"rotationX":10,"rotationY":20,"heightMapSrc":"HEIGHT","displacement":22,"displacementSubdiv":1}},
      {"id":"bumpy_s","type":"Style","props":{"opacity":100,"fill":"#c9a05a"}},
      {"id":"bumpy_prim","type":"Primitive","props":{"type":"sphere","radius":96,"radialSegments":36,"heightSegments":18}}],"visible":true,"locked":false},
    {"id":"key","name":"key","children":[],"parent":"comp_root","transform":{"position":{"x":120,"y":70},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"key_t","type":"Transform","props":{"__kind":"light","x":120,"y":70,"rotation":0,"lightGlow":true,"z":-150,"intensity":110,"radius":460,"lightType":"point"}},{"id":"key_s","type":"Style","props":{"opacity":100,"fill":"#fff2d8"}}],"visible":true,"locked":false},
    {"id":"cam","name":"cam","children":[],"parent":"comp_root","transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"cam_t","type":"Transform","props":{"__kind":"camera","x":240,"y":180,"rotation":0,"z":-1000,"focalLength":1000}}],"visible":true,"locked":false}]},
    "animation":{"tracks":{},"expressions":{}},"comps":{"comp_root":{"id":"comp_root","name":"comp_root","width":480,"height":360,"fps":30,"durationSeconds":10,"background":"#0c0c12"}},
    "motionBlur":{"enabled":false,"shutterAngle":180,"shutterPhase":-90,"samples":8,"adaptiveSampleLimit":128},
    "colorManagement":{"workingSpace":"srgb-linear","displayTransform":"srgb","bitDepth":16},"projectItems":{"folders":[],"footage":{}},
    "openTabs":{"tabOrder":["tab1"],"activeTabId":"tab1","tabs":{"tab1":{"id":"tab1","compositionId":"comp_root","breadcrumbPath":["comp_root"],"title":"comp_root","time":0,"frame":0}}}})";
  std::string text = project;
  const auto sub = [&text](std::string_view from, const std::string& to) {
    const auto at = text.find(from);
    REQUIRE(at != std::string::npos);
    text.replace(at, from.size(), to);
  };
  sub("MODELKEY", modelKey);
  sub("base64,GLB", "base64," + glb);
  sub("HEIGHT", heightSrc);
  const auto json = js::parse(text);
  REQUIRE(json.has_value());

  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  (void)doc::restore_document(d, view, *json, {});
  doc::DocExprEnv env(d, view, cache);
  const sc::BuildContext ctx{d, view, env, cache, nullptr};
  const sc::NativeFrame f = sc::build_native_frame(ctx, "comp_root", 0, sc::export_view(480, 360, 480, 360), false);
  for (const auto& e : f.errors) {
    INFO(e.layerId << ": " << e.message);
    CHECK((e.layerId != "panel" && e.layerId != "bumpy"));
  }

  const api::Renderable* panel = nullptr;
  const api::Renderable* bumpy = nullptr;
  for (const api::Renderable& r : f.file.scene.renderables) {
    if (r.id == "panel") panel = &r;
    if (r.id == "bumpy") bumpy = &r;
  }

  // ── the model ──
  REQUIRE(panel != nullptr);
  REQUIRE(panel->extruded_mesh.has_value());
  CHECK(panel->extruded_mesh->key == modelKey + ":m0p0");
  CHECK(panel->extruded_mesh->index_format == api::RenderIndexFormat::uint16);
  REQUIRE(panel->extruded_mesh->pbr.has_value());
  CHECK(panel->extruded_mesh->pbr->normal_key == std::optional<std::string>("pbrmap:panel:n"));
  CHECK(panel->extruded_mesh->pbr->metallic_roughness_key == std::optional<std::string>("pbrmap:panel:m"));
  CHECK(panel->extruded_mesh->pbr->occlusion_key == std::optional<std::string>("pbrmap:panel:o"));
  CHECK(panel->extruded_mesh->pbr->emissive_key == std::optional<std::string>("pbrmap:panel:e"));
  REQUIRE(panel->extruded_mesh->ranges.size() == 1);
  CHECK(panel->extruded_mesh->ranges[0].textured);
  CHECK(panel->texture_key == std::optional<std::string>("asset:panel"));
  REQUIRE(panel->three_d.has_value());
  CHECK(panel->three_d->shade.has_value());  // lit per fragment
  std::size_t fed = 0;
  for (const sc::TextureRequest& t : f.textures) {
    if (t.layerId != "panel") continue;
    INFO(t.key << " ← " << t.src);
    CHECK(t.src.starts_with("gltf:" + modelKey + "#"));
    sc::DecodedImage img;
    std::string why;
    CHECK(sc::model_image_pixels(t.src, img, why));
    CHECK(img.width == 8);
    ++fed;
  }
  CHECK(fed == 5);  // the base colour + four maps

  // ── the displaced primitive ──
  REQUIRE(bumpy != nullptr);
  REQUIRE(bumpy->extruded_mesh.has_value());
  const auto pm = sc::primitive_mesh_for_key("prim:sphere:96:36:18");
  REQUIRE(pm.has_value());
  CHECK(bumpy->extruded_mesh->key == sc::displaced_mesh_key(pm->key, heightSrc, 22, 1));
  CHECK(bumpy->extruded_mesh->index_format == api::RenderIndexFormat::uint32);
  sc::HeightField field;
  field.width = kF;
  field.height = kF;
  for (std::size_t i = 0; i < std::size_t{kF} * kF; ++i) {
    field.data.push_back(static_cast<float>(((0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]) / 255) * 1 + 0.5 * (1 - 1.0)));
  }
  const sc::DisplacedMesh want = sc::displace_mesh(pm->vertices, pm->indices, field, 22, 1);
  std::vector<std::uint8_t> wantBytes(want.vertices.size() * sizeof(float));
  std::memcpy(wantBytes.data(), want.vertices.data(), wantBytes.size());
  CHECK(bumpy->extruded_mesh->vertices == wantBytes);
  REQUIRE(bumpy->extruded_mesh->ranges.size() == 1);
  CHECK(bumpy->extruded_mesh->ranges[0].count == want.indices.size());
}

TEST_CASE("3D leftovers: an image (asset:) environment sky lights and reflects from the document", "[scene][env]") {
  sc::clear_environment_assets();
  // A 64×32 equirect (bright top, warm band, dark ground), opaque.
  constexpr std::uint32_t kW = 64;
  constexpr std::uint32_t kH = 32;
  std::vector<std::uint8_t> rgb(std::size_t{kW} * kH * 3);
  for (std::uint32_t y = 0; y < kH; ++y) {
    for (std::uint32_t x = 0; x < kW; ++x) {
      const std::size_t i = (std::size_t{y} * kW + x) * 3;
      rgb[i] = static_cast<std::uint8_t>(y < 12 ? 230 : y < 18 ? 250 : 40 + x);
      rgb[i + 1] = static_cast<std::uint8_t>(y < 12 ? 235 : y < 18 ? 150 : 30);
      rgb[i + 2] = static_cast<std::uint8_t>(y < 12 ? 255 : y < 18 ? 60 : 20 + (x & 15U));
    }
  }
  const std::string src = "data:image/bmp;base64," + base64(bmp(kW, kH, rgb));
  {
    sc::DecodedImage probe;
    std::string err;
    if (!sc::decode_image_bytes(premation::doc::native_unbase64(src.substr(src.find(',') + 1)).value(), probe, err)) {
      WARN("no still-image codec on this platform (" << err << "): skipped");
      return;
    }
  }
  const std::string project = R"({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"Composition 1","parent":null,"children":["ball","env","cam"],"transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,"components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"ball","name":"ball","children":[],"parent":"comp_root","transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},"components":[
      {"id":"ball_t","type":"Transform","props":{"__kind":"shape","x":240,"y":180,"rotation":0,"width":160,"height":160,"acceptsLights":true,"z":0,"shadingModel":"pbr","metal":100,"roughness":20}},
      {"id":"ball_s","type":"Style","props":{"opacity":100,"fill":"#c0c0c0"}},
      {"id":"ball_prim","type":"Primitive","props":{"type":"sphere","radius":96,"radialSegments":24,"heightSegments":12}}],"visible":true,"locked":false},
    {"id":"env","name":"env","children":[],"parent":"comp_root","transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"env_t","type":"Transform","props":{"__kind":"light","x":240,"y":180,"rotation":0,"intensity":90,"lightType":"environment","envPreset":"asset:sky1","envRotation":30,"envReflections":100}},{"id":"env_s","type":"Style","props":{"opacity":100}}],"visible":true,"locked":false},
    {"id":"cam","name":"cam","children":[],"parent":"comp_root","transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"cam_t","type":"Transform","props":{"__kind":"camera","x":240,"y":180,"rotation":0,"z":-1000,"focalLength":1000}}],"visible":true,"locked":false}]},
    "animation":{"tracks":{},"expressions":{}},"comps":{"comp_root":{"id":"comp_root","name":"comp_root","width":480,"height":360,"fps":30,"durationSeconds":10,"background":"#0c0c12"}},
    "motionBlur":{"enabled":false,"shutterAngle":180,"shutterPhase":-90,"samples":8,"adaptiveSampleLimit":128},
    "colorManagement":{"workingSpace":"srgb-linear","displayTransform":"srgb","bitDepth":16},"projectItems":{"folders":[],"footage":{"sky1":{}}},
    "openTabs":{"tabOrder":["tab1"],"activeTabId":"tab1","tabs":{"tab1":{"id":"tab1","compositionId":"comp_root","breadcrumbPath":["comp_root"],"title":"comp_root","time":0,"frame":0}}}})";
  const auto json = js::parse(project);
  REQUIRE(json.has_value());
  Json asset = Json::object();
  asset.set("id", Json::string("sky1"));
  asset.set("name", Json::string("sky.bmp"));
  asset.set("type", Json::string("image"));
  asset.set("src", Json::string(src));
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  (void)doc::restore_document(d, view, *json, {asset});
  doc::DocExprEnv env(d, view, cache);
  const sc::BuildContext ctx{d, view, env, cache, nullptr};
  const sc::NativeFrame f = sc::build_native_frame(ctx, "comp_root", 0, sc::export_view(480, 360, 480, 360), false);
  for (const auto& e : f.errors) {
    INFO(e.layerId << ": " << e.message);
    CHECK(e.message.find("asset:") == std::string::npos);
  }
  // What the builder must have derived: the same pixels through the ported pipeline.
  std::vector<std::uint8_t> rgba;
  for (std::size_t i = 0; i < std::size_t{kW} * kH; ++i) rgba.insert(rgba.end(), {rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255});
  const sc::EnvPixels base = sc::resample_equirect(rgba, kW, kH, sc::kEnvSpecWidth, sc::kEnvSpecHeight, false);
  const std::string id = sc::env_atlas_key("asset:sky1#" + sc::hash_env_pixels(base));
  REQUIRE(f.file.scene.env_map.has_value());
  CHECK(f.file.scene.env_map->id == id);
  CHECK(f.file.scene.env_map->data == sc::build_env_specular_atlas(base, id).data);
  CHECK(f.file.scene.env_map->rotation_deg == 30);
  // The irradiance rig rides the light array: as many lights as environment_rig derives.
  const auto rig = sc::environment_rig(sc::sh_project(base), 90, 30);
  CHECK(f.file.scene.lights3d.size() == rig.size());
}

TEST_CASE("3D leftovers: what the document cannot supply is reported, never guessed", "[scene][gltf][displacement]") {
  std::string why;
  CHECK(sc::height_field_for("prime:bumps", "prime:bumps", why) == nullptr);
  CHECK(why.find("prime:") != std::string::npos);
  CHECK(sc::height_field_for("rel", "maps/bumps.png", why) == nullptr);
  CHECK(why.find("relative") != std::string::npos);
  doc::Document d;
  sc::gltf::clear_models();
  CHECK(sc::gltf::model_for(d, "gltf-00000000-1", why) == nullptr);
  CHECK(why.find("not in the document") != std::string::npos);
}
