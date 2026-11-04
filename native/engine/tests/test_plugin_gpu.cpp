// G1 on a real GPU (docs/NATIVE_CORE_PLAN.md G1): the native plugin host's
// render glue (render_glue.cpp) inside the render graph, on this machine's
// adapter. Skipped when there is none.
//
//   * the grade sample's SMART_RENDER_GPU (WGSL on the engine's Dawn device)
//     equals its CPU twin (SMART_RENDER, read back → CPU → upload) within the
//     chain buffer's precision at 8, 16 and 32 bpc;
//   * a GPU fault is contained: invalid commands are caught by the glue's
//     error scope, the command buffer is dropped, the CPU path renders the
//     same picture and the frame reports it — never a blank frame, never an
//     uncaptured device error;
//   * a new device under the same host sets the plugin's GPU data down and
//     builds it again (no recording into a device the frame never submits);
//   * a native-plugin FrameScene renders through `premation-render --plugins`,
//     and a crash inside SMART_RENDER_GPU (child process: Catch2's own fatal
//     handlers would see the fault first) leaves the layer as its input.
//
// The [measure] case prints GPU vs CPU cost at 1080p.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include "engine_api.hpp"
#include "host.hpp"
#include "premation/protocol/wire.hpp"
#include "render_glue.hpp"
#include "scene_renderer.hpp"
#include "threed.hpp"
#include "transform.hpp"

namespace pl = premation::plugins;
namespace rg = premation::rg;
namespace api = premation::rg::api;
namespace fs = std::filesystem;

namespace {

constexpr const char* kGrade = "com.premation.samples.grade";
constexpr std::uint32_t kW = 64;
constexpr std::uint32_t kH = 48;

fs::path bundles() { return fs::path(PREMATION_PLUGIN_BUNDLES); }

pl::HostOptions options() {
  pl::HostOptions o;
  o.searchPaths = {bundles()};
  o.threads = 2;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

api::RenderEffectParam num(const char* name, double v) { return {name, api::RenderParamKind::number, v, {}, "", {}}; }
api::RenderEffectParam text(const char* name, const char* s) { return {name, api::RenderParamKind::text, 0, {}, s, {}}; }
api::RenderEffectParam color(const char* name, double r, double g, double b, double a) {
  return {name, api::RenderParamKind::color, 0, {r, g, b, a}, "", {}};
}

struct GradeParams {
  int fault = 1;     // Debug ▸ Fault (1 = None)
  int gpuFault = 1;  // Debug ▸ GPU Fault (1 = None, 2 = Invalid commands)
};

api::RenderEffect grade_effect(std::uint32_t layerW, std::uint32_t layerH, GradeParams gp = {}) {
  api::RenderEffect e;
  e.type = "native-plugin";
  e.params = {text("matchName", kGrade),
              text("instance", "img/fx1"),
              text("layerId", "img"),
              num("compTime", 0),
              num("layerTime", 0),
              num("fps", 30),
              num("layerW", layerW),
              num("layerH", layerH),
              // Mild enough that no channel leaves 0..1: the 16-bit CPU world is
              // integer 0..32768 (AE's 16 bpc) and clips, where the GPU path's
              // rgba16float buffer keeps over-range values (sat 120 % + hue 30°
              // pushed channels out of range: a 0.0055 difference at 16 bpc only).
              // A colour param is the document's sRGB-encoded 0..1 and reaches the plugin linear
              // (SDK 1.2): 1.1 would be 1.23 in linear light — out of range again.
              color("p.p1", 1.0, 0.95, 0.85, 1),
              num("p.p2", 2),
              num("p.p3", 110),
              num("p.p4", 10),
              num("p.p901", gp.fault),
              num("p.p5", gp.gpuFault)};
  return e;
}

/// A frame of `w`×`h` with one image layer (an rgba32float pattern, opaque
/// inside a transparent 4-px margin) at (x, y), carrying `effect` if given.
api::RenderFrameFile frame(std::uint32_t bits, const api::RenderEffect* effect, std::uint32_t w = kW, std::uint32_t h = kH,
                           std::uint32_t iw = 32, std::uint32_t ih = 32, double x = 16, double y = 8) {
  api::RenderFrameFile f;
  f.format_version = 1;
  f.scene_id = "plugin-gpu";
  f.view.css_width = w;
  f.view.css_height = h;
  f.view.device_pixel_ratio = 1;
  f.view.camera_center_x = w / 2.0;
  f.view.camera_center_y = h / 2.0;
  f.view.camera_zoom = 1;
  f.view.bit_depth = bits;
  f.view.float16_textures = true;
  f.view.float32_textures = true;
  f.view.surface_format = api::RenderTextureFormat::bgra8unorm;
  f.scene.width = w;
  f.scene.height = h;
  f.scene.background = api::Color{0, 0, 0, 1};
  f.scene.has_effects = true;

  std::vector<float> px(std::size_t{iw} * ih * 4);
  for (std::uint32_t yy = 0; yy < ih; ++yy) {
    for (std::uint32_t xx = 0; xx < iw; ++xx) {
      const bool inside = xx >= 4 && yy >= 4 && xx + 4 < iw && yy + 4 < ih;
      const float a = inside ? 1.0F : 0.0F;
      float* p = &px[(std::size_t{yy} * iw + xx) * 4];
      p[0] = a * (0.15F + 0.6F * static_cast<float>(xx) / static_cast<float>(iw));
      p[1] = a * (0.15F + 0.6F * static_cast<float>(yy) / static_cast<float>(ih));
      p[2] = a * (0.2F + 0.5F * static_cast<float>((xx ^ yy) & 7U) / 7.0F);
      p[3] = a;
    }
  }
  std::vector<std::uint8_t> bytes(px.size() * sizeof(float));
  std::memcpy(bytes.data(), px.data(), bytes.size());
  f.blobs.push_back({"hash:img", iw, ih, api::RenderTextureFormat::rgba32float, std::move(bytes), false});
  api::RenderTextureRef ref;
  ref.key = "img";
  ref.hash = "hash:img";
  ref.sample_linear = false;
  ref.ready = true;
  f.textures.push_back(ref);
  api::Renderable r;
  r.id = "img";
  r.kind = api::RenderableKind::image;
  r.model_matrix = {static_cast<double>(iw), 0, 0, 0, static_cast<double>(ih), 0, x, y, 1};
  r.bounds = {x, y, static_cast<double>(iw), static_cast<double>(ih)};
  r.opacity = 1;
  r.texture_key = "img";
  if (effect != nullptr) r.effects.push_back(*effect);
  f.scene.renderables.push_back(r);
  return f;
}

struct Rendered {
  std::vector<float> scene;  // scene-color, float RGBA, premultiplied
  rg::FrameStats stats;
};

Rendered render(rg::SceneRenderer& r, const api::RenderFrameFile& f) {
  Rendered out;
  std::string err;
  rg::Frame fr;
  REQUIRE(r.render(f, &fr, out.stats, err));
  CHECK(out.stats.gpuError.empty());  // nothing escaped an error scope
  rg::TargetPixels t;
  REQUIRE(r.read_target("scene-color", t, err));
  out.scene = std::move(t.rgba);
  return out;
}

float max_diff(const std::vector<float>& a, const std::vector<float>& b) {
  REQUIRE(a.size() == b.size());
  float m = 0;
  for (std::size_t i = 0; i < a.size(); ++i) m = std::max(m, std::abs(a[i] - b[i]));
  return m;
}

bool has_diag(const rg::FrameStats& s, std::string_view code) {
  return std::ranges::any_of(s.diagnostics, [&](const rg::GraphDiagnostic& d) { return d.code == code; });
}

/// `img` displaced by a second layer `map` (a horizontal red ramp).
api::RenderFrameFile displace_frame(std::uint32_t bits, bool effect) {
  api::RenderEffect fx;
  fx.type = "native-plugin";
  fx.params = {text("matchName", "com.premation.samples.checkout.displace"),
               text("instance", "img/fx1"),
               text("layerId", "img"),
               text("p.p1", "map"),
               num("p.p2", 1),
               num("p.p3", 12),
               num("p.p4", 8),
               num("layerW", 32),
               num("layerH", 32)};
  api::RenderFrameFile f = frame(bits, effect ? &fx : nullptr, kW, kH, 32, 32, 16, 8);
  constexpr std::uint32_t mw = 32;
  constexpr std::uint32_t mh = 32;
  std::vector<float> px(std::size_t{mw} * mh * 4, 0);
  for (std::uint32_t y = 0; y < mh; ++y) {
    for (std::uint32_t x = 0; x < mw; ++x) {
      float* p = &px[(std::size_t{y} * mw + x) * 4];
      p[0] = static_cast<float>(x) / static_cast<float>(mw - 1);
      p[3] = 1;
    }
  }
  std::vector<std::uint8_t> bytes(px.size() * sizeof(float));
  std::memcpy(bytes.data(), px.data(), bytes.size());
  f.blobs.push_back({"hash:map", mw, mh, api::RenderTextureFormat::rgba32float, std::move(bytes), false});
  api::RenderTextureRef ref;
  ref.key = "map";
  ref.hash = "hash:map";
  ref.ready = true;
  f.textures.push_back(ref);
  api::Renderable map;
  map.id = "map";
  map.kind = api::RenderableKind::image;
  map.model_matrix = {static_cast<double>(mw), 0, 0, 0, static_cast<double>(mh), 0, 16, 8, 1};
  map.bounds = {16, 8, static_cast<double>(mw), static_cast<double>(mh)};
  map.opacity = 1;
  map.texture_key = "map";
  api::Renderable img = std::move(f.scene.renderables.back());
  f.scene.renderables.pop_back();
  f.scene.renderables.push_back(std::move(map));
  f.scene.renderables.push_back(std::move(img));
  return f;
}

std::unique_ptr<rg::SceneRenderer> renderer_or_skip() {
  std::string err;
  auto r = rg::SceneRenderer::create({}, err);
  if (!r) WARN("no GPU adapter: " << err);
  return r;
}

}  // namespace

TEST_CASE("plugin GPU: grade's SMART_RENDER_GPU equals its CPU twin at 8, 16 and 32 bpc", "[plugins][gpu]") {
  auto r = renderer_or_skip();
  if (!r) return;
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kGrade);
  REQUIRE(spec != nullptr);
  REQUIRE(spec->has(PR_OUT_FLAG_GPU_RENDER));
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  INFO("adapter " << r->adapter() << " (" << r->backend() << ")");

  const api::RenderEffect fx = grade_effect(32, 32);
  for (const std::uint32_t bits : {8U, 16U, 32U}) {
    if (bits == 32 && !r->supports_float32()) {
      WARN("device has no float32-filterable + float32-blendable: 32 bpc skipped");
      continue;
    }
    INFO("bits " << bits);
    const Rendered plain = render(*r, frame(bits, nullptr));

    glue.set_gpu_enabled(true);
    const auto before = glue.stats();
    const Rendered gpu = render(*r, frame(bits, &fx));
    CHECK(glue.stats().gpu == before.gpu + 1);
    CHECK(glue.stats().cpu == before.cpu);
    CHECK(gpu.stats.diagnostics.empty());

    glue.set_gpu_enabled(false);
    const Rendered cpu = render(*r, frame(bits, &fx));
    CHECK(glue.stats().cpu == before.cpu + 1);
    CHECK(cpu.stats.diagnostics.empty());
    glue.set_gpu_enabled(true);

    // The grade did something (not an identity pass).
    CHECK(max_diff(gpu.scene, plain.scene) > 0.02F);
    // GPU vs CPU: the same maths; they differ only by the chain buffer's
    // rounding (8: one unorm step; 16: the CPU world is 16-bit integer 0..1 and
    // the buffer half float; 32: float evaluation order).
    const float d = max_diff(gpu.scene, cpu.scene);
    const float tol = bits == 8 ? 1.01F / 255.0F : bits == 16 ? 2e-3F : 2e-5F;
    std::printf("[measure] grade GPU vs CPU twin at %u bpc: max |diff| %.3g (tolerance %.3g)\n", bits, static_cast<double>(d),
                static_cast<double>(tol));
    CHECK(d <= tol);
  }
}

// fxkit (native/sdk/fxkit): an effect written once in WGSL. The GPU path runs that WGSL, the
// CPU path the C++ the generator transpiled from it; both must draw the same picture.
TEST_CASE("plugin GPU: fxkit effects — the WGSL and its generated C++ twin agree at 8, 16 and 32 bpc", "[plugins][gpu][fxkit]") {
  auto r = renderer_or_skip();
  if (!r) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);

  const auto fxkit_effect = [](const char* slug, std::vector<api::RenderEffectParam> params) {
    api::RenderEffect e;
    e.type = "native-plugin";
    e.params = {text("matchName", (std::string("com.premation.sample.fxkit.") + slug).c_str()),
                text("instance", "img/fx1"),
                text("layerId", "img"),
                num("compTime", 0.5),
                num("layerTime", 0.5),
                num("fps", 30),
                num("layerW", 32),
                num("layerH", 32)};
    e.params.insert(e.params.end(), params.begin(), params.end());
    return e;
  };
  const api::RenderEffect split = fxkit_effect("chroma_split", {num("p.p1", 3.5), num("p.p2", 30), num("p.p3", 0)});
  const api::RenderEffect radial = fxkit_effect("chroma_split", {num("p.p1", 5), num("p.p3", 1)});
  const api::RenderEffect dots =
      fxkit_effect("dot_grid", {num("p.p1", 7), num("p.p2", 70), num("p.p3", 60), num("p.p4", 1.5), color("p.p5", 0.9, 0.6, 0.3, 1)});

  for (const auto* fx : {&split, &radial, &dots}) {
    REQUIRE(host.effect(fx->params[0].text) != nullptr);
    REQUIRE(host.effect(fx->params[0].text)->has(PR_OUT_FLAG_GPU_RENDER));
    for (const std::uint32_t bits : {8U, 16U, 32U}) {
      if (bits == 32 && !r->supports_float32()) continue;
      INFO(fx->params[0].text << " at " << bits << " bpc");
      const Rendered plain = render(*r, frame(bits, nullptr));
      glue.set_gpu_enabled(true);
      const auto before = glue.stats();
      const Rendered gpu = render(*r, frame(bits, fx));
      CHECK(glue.stats().gpu == before.gpu + 1);
      CHECK(gpu.stats.diagnostics.empty());
      glue.set_gpu_enabled(false);
      const Rendered cpu = render(*r, frame(bits, fx));
      CHECK(glue.stats().cpu == before.cpu + 1);
      CHECK(cpu.stats.diagnostics.empty());
      glue.set_gpu_enabled(true);

      CHECK(max_diff(gpu.scene, plain.scene) > 0.02F);  // the effect did something
      const float d = max_diff(gpu.scene, cpu.scene);
      const float tol = bits == 8 ? 1.01F / 255.0F : bits == 16 ? 2e-3F : 1e-4F;
      std::printf("[measure] fxkit %s GPU vs CPU twin at %u bpc: max |diff| %.3g (tolerance %.3g)\n",
                  fx->params[0].text.c_str(), bits, static_cast<double>(d), static_cast<double>(tol));
      CHECK(d <= tol);
    }
  }
}

TEST_CASE("plugin GPU: a layer checkout displaces on the GPU the same as the CPU twin", "[plugins][gpu]") {
  auto r = renderer_or_skip();
  if (!r) return;
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect("com.premation.samples.checkout.displace");
  REQUIRE(spec != nullptr);
  REQUIRE(spec->has(PR_OUT_FLAG_GPU_RENDER));
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);

  const Rendered plain = render(*r, displace_frame(8, false));
  glue.set_gpu_enabled(true);
  const auto before = glue.stats();
  const Rendered gpu = render(*r, displace_frame(8, true));
  CHECK(glue.stats().gpu == before.gpu + 1);
  CHECK(gpu.stats.diagnostics.empty());
  glue.set_gpu_enabled(false);
  const Rendered cpu = render(*r, displace_frame(8, true));
  CHECK(glue.stats().cpu == before.cpu + 1);
  CHECK(cpu.stats.diagnostics.empty());
  CHECK(max_diff(gpu.scene, plain.scene) > 0.01F);
  const float d = max_diff(gpu.scene, cpu.scene);
  std::printf("[measure] displace GPU vs CPU twin at 8 bpc: max |diff| %.3g\n", static_cast<double>(d));
  CHECK(d <= 1.01F / 255.0F);
}

TEST_CASE("plugin GPU: invalid GPU commands are caught by the error scope; the CPU path renders the frame", "[plugins][gpu]") {
  auto r = renderer_or_skip();
  if (!r) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);

  const api::RenderEffect good = grade_effect(32, 32);
  GradeParams gp;
  gp.gpuFault = 2;  // Invalid commands
  const api::RenderEffect bad = grade_effect(32, 32, gp);

  glue.set_gpu_enabled(false);
  const Rendered twin = render(*r, frame(16, &good));
  glue.set_gpu_enabled(true);

  for (int i = 0; i < 2; ++i) {  // twice: a caught error does not poison the device or the next frame
    const auto before = glue.stats();
    const Rendered faulty = render(*r, frame(16, &bad));
    CHECK(glue.stats().gpuErrors == before.gpuErrors + 1);
    CHECK(glue.stats().cpu == before.cpu + 1);  // the fallback rendered it
    CHECK(glue.stats().gpu == before.gpu);
    CHECK(has_diag(faulty.stats, "native-plugin-gpu-error"));
    CHECK(max_diff(faulty.scene, twin.scene) <= 1e-6F);  // the CPU twin's exact picture, not a blank one
  }
  // The device still works: a good GPU render right after.
  const auto before = glue.stats();
  const Rendered after = render(*r, frame(16, &good));
  CHECK(glue.stats().gpu == before.gpu + 1);
  CHECK(after.stats.diagnostics.empty());
  CHECK(max_diff(after.scene, twin.scene) <= 2e-3F);
}

TEST_CASE("plugin GPU: a new device under the same host rebuilds the plugin's GPU data", "[plugins][gpu]") {
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  const api::RenderEffect fx = grade_effect(32, 32);
  std::vector<float> first;
  for (int round = 0; round < 2; ++round) {
    auto r = renderer_or_skip();
    if (!r) return;
    r->set_native_effects(&glue);
    const auto before = glue.stats();
    const Rendered out = render(*r, frame(16, &fx));
    CHECK(glue.stats().gpu == before.gpu + 1);
    CHECK(out.stats.diagnostics.empty());
    if (round == 0) {
      first = out.scene;
    } else {
      CHECK(glue.stats().deviceResets == 1);
      CHECK(max_diff(out.scene, first) == 0.0F);  // same device class, same shader: the same bytes
    }
  }
}

namespace {

fs::path temp_path(const std::string& name) {
  const fs::path p = fs::temp_directory_path() / ("premation-plugin-gpu-" + name);
  std::error_code ec;
  fs::remove(p, ec);
  return p;
}

void write_pfs(const fs::path& p, const api::RenderFrameFile& f) {
  premation::wire::Writer w;
  api::encode(w, f);
  const auto bytes = w.bytes();
  std::ofstream out(p, std::ios::binary);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  REQUIRE(static_cast<bool>(out));
}

std::string slurp(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

/// premation-render --scene <pfs> --out <png> --raw 1 [--plugins bundles] [extra]; its stdout line.
std::string run_render(const fs::path& pfs, const fs::path& png, bool withPlugins, const std::string& extra = {}) {
  const fs::path log = temp_path(png.stem().string() + ".txt");
  std::string cmd = "\"" + std::string(PREMATION_RENDER_TOOL) + "\" --scene \"" + pfs.string() + "\" --out \"" + png.string() +
                    "\" --raw 1";
  if (withPlugins) cmd += " --plugins \"" + bundles().string() + "\"";
  cmd += extra + " >\"" + log.string() + "\"";
#if defined(_WIN32)
  cmd = "\"" + cmd + " 2>NUL\"";  // cmd.exe strips the outer quotes
#else
  cmd += " 2>/dev/null";
#endif
  const int code = std::system(cmd.c_str());  // NOLINT(concurrency-mt-unsafe, cert-env33-c): a test driving the tool
  INFO("exit " << code);
  return slurp(log);
}

}  // namespace

TEST_CASE("plugin GPU: a native-plugin FrameScene renders through premation-render; a GPU-selector crash is contained",
          "[plugins][gpu]") {
  if (!renderer_or_skip()) return;
  const api::RenderEffect fx = grade_effect(32, 32);
  GradeParams crash;
  crash.fault = 2;  // Access violation — inside SMART_RENDER_GPU (grade's GPU selector injects first)
  const api::RenderEffect fxCrash = grade_effect(32, 32, crash);

  const fs::path plainPfs = temp_path("plain.pfs");
  const fs::path gradePfs = temp_path("grade.pfs");
  const fs::path crashPfs = temp_path("crash.pfs");
  write_pfs(plainPfs, frame(16, nullptr));
  write_pfs(gradePfs, frame(16, &fx));
  write_pfs(crashPfs, frame(16, &fxCrash));
  const fs::path plainPng = temp_path("plain.png");
  const fs::path gradePng = temp_path("grade.png");
  const fs::path cpuPng = temp_path("grade-cpu.png");
  const fs::path crashPng = temp_path("crash.png");
  const fs::path noHostPng = temp_path("nohost.png");

  const std::string plain = run_render(plainPfs, plainPng, false);
  INFO(plain);
  REQUIRE(plain.rfind("rendered", 0) == 0);

  const std::string graded = run_render(gradePfs, gradePng, true);
  INFO(graded);
  CHECK(graded.rfind("rendered", 0) == 0);
  CHECK(graded.find('{') == std::string::npos);  // no diagnostics: the plugin ran
  CHECK(slurp(gradePng) != slurp(plainPng));

  const std::string cpu = run_render(gradePfs, cpuPng, true, " --plugin-gpu 0");
  INFO(cpu);
  CHECK(cpu.rfind("rendered", 0) == 0);
  CHECK(slurp(cpuPng) != slurp(plainPng));

  // Without a host the entry passes through (reported), the layer as its input.
  const std::string noHost = run_render(gradePfs, noHostPng, false);
  INFO(noHost);
  CHECK(noHost.find("{native-plugin-unavailable") != std::string::npos);
  CHECK(slurp(noHostPng) == slurp(plainPng));

  // The crash: guarded, the instance disabled, the frame rendered with the layer as its input.
  const std::string crashed = run_render(crashPfs, crashPng, true);
  INFO(crashed);
  CHECK(crashed.rfind("rendered", 0) == 0);
  CHECK(crashed.find("{native-plugin-crash") != std::string::npos);
  CHECK(slurp(crashPng) == slurp(plainPng));
}

TEST_CASE("plugin GPU: 1080p cost, GPU path vs CPU path", "[plugins][gpu][measure]") {
  auto r = renderer_or_skip();
  if (!r) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  const api::RenderEffect fx = grade_effect(1920, 1080);
  for (const std::uint32_t bits : {8U, 16U, 32U}) {
    if (bits == 32 && !r->supports_float32()) continue;
    const auto time = [&](const api::RenderEffect* e, bool gpu) {
      glue.set_gpu_enabled(gpu);
      const api::RenderFrameFile f = frame(bits, e, 1920, 1080, 1920, 1080, 0, 0);
      std::string err;
      rg::FrameStats s;
      for (int i = 0; i < 6; ++i) REQUIRE(r->render(f, nullptr, s, err));  // warm: pipelines, uploads, GPU setup
      std::vector<double> ms;
      for (int i = 0; i < 15; ++i) {
        rg::FrameStats t;
        REQUIRE(r->render(f, nullptr, t, err));
        ms.push_back(t.encodeMs + t.gpuMs);
      }
      std::sort(ms.begin(), ms.end());
      return ms[ms.size() / 2];
    };
    const double none = time(nullptr, true);
    const double gpu = time(&fx, true);
    const double cpu = time(&fx, false);
    std::printf("[measure] 1080p %u bpc on %s, median ms (render + submit + GPU idle): no effect %.3f, grade GPU %.3f (+%.3f), "
                "grade CPU path %.3f (+%.3f)\n",
                bits, r->adapter().c_str(), none, gpu, gpu - none, cpu, cpu - none);
    CHECK(gpu < cpu);
  }
  glue.set_gpu_enabled(true);
}

TEST_CASE("plugin GPU (SDK 1.2): an asset image is uploaded once per file and kept with the device", "[plugins][gpu][sdk12]") {
  auto r = renderer_or_skip();
  if (!r) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  pl::AssetImage img;
  img.width = 3;
  img.height = 2;
  img.rgba.assign(3 * 2 * 4, 0.25F);
  const PrGpuWorld* a = glue.asset_texture(r->device(), "a.exr|1|2", img);
  REQUIRE(a != nullptr);
  CHECK(a->width == 3);
  CHECK(a->height == 2);
  CHECK(a->format == PR_GPU_FORMAT_RGBA32_FLOAT);
  CHECK(a->wgpu_texture != nullptr);
  CHECK(a->wgpu_texture_view != nullptr);
  // The same file and modification time: the same texture, not a second upload.
  CHECK(glue.asset_texture(r->device(), "a.exr|1|2", img) == a);
  // A re-saved file (another key) is its own texture.
  CHECK(glue.asset_texture(r->device(), "a.exr|1|3", img) != a);
  // Past the device's limits: none (the plugin falls back), never an error texture.
  pl::AssetImage huge;
  huge.width = static_cast<std::int32_t>(r->device().max_texture_dimension()) + 1;
  huge.height = 1;
  CHECK(glue.asset_texture(r->device(), "huge", huge) == nullptr);
}

// ── SDK 1.2 (S6 scene depth, S8 the model3d sample) ─────────────────────────

namespace {

constexpr const char* kModel3d = "com.premation.samples.model3d";
constexpr std::uint32_t kDW = 96;
constexpr std::uint32_t kDH = 64;

/// The comp's default camera (After Effects' 50 mm, centred) — what the host gives a plugin on a
/// frame without a camera layer, and the frame's camera3d here, so both see the same view.
api::RenderCamera3D default_camera3d() {
  const motion::xf::Camera c = motion::xf::default_camera(kDW, kDH);
  const auto v = motion::xf::camera_view_matrix(c);
  const auto p = motion::xf::camera_projection_matrix(c);
  api::RenderCamera3D cam;
  cam.view.assign(v.begin(), v.end());
  cam.projection.assign(p.begin(), p.end());
  cam.eye = {c.position.x, c.position.y, c.position.z};
  return cam;
}
double default_zoom() { return motion::xf::default_camera(kDW, kDH).focal_length; }

/// A 3D solid: the unit quad onto (x, y, w, h) at depth z, colour `c`.
api::Renderable solid3d(const char* id, double x, double y, double w, double h, double z, api::Color c) {
  api::Renderable r;
  r.id = id;
  r.kind = api::RenderableKind::rect;
  r.model_matrix = {w, 0, 0, 0, h, 0, x, y, 1};
  r.bounds = {x, y, w, h};
  r.opacity = 1;
  r.color = c;
  api::RenderThreeD t;
  t.model = {w, 0, 0, 0, 0, h, 0, 0, 0, 0, 1, 0, x, y, z, 1};
  r.three_d = t;
  return r;
}

/// The model3d effect on layer `layer` (W × H): `mode` 1 shaded / 2 scene depth, `depth` the
/// "Composite with Scene Depth" checkbox.
api::RenderEffect model3d_effect(const std::string& layer, int mode, bool depth, double size = 40) {
  const std::string instance = layer + "/m3d";
  api::RenderEffect e;
  e.type = "native-plugin";
  e.params = {text("matchName", kModel3d), text("instance", instance.c_str()), text("layerId", layer.c_str()),
              num("layerW", kDW), num("layerH", kDH), num("compW", kDW), num("compH", kDH), num("fps", 30),
              num("p.p6", size), num("p.p13", depth ? 1 : 0), num("p.p15", mode)};
  return e;
}

/// A 32 bpc frame with the default camera, `solids` (3D) and, on top, comp-sized 2D layers
/// carrying `effects` (one layer each, named by the effect's layerId).
api::RenderFrameFile depth_frame(std::vector<api::Renderable> solids, const std::vector<api::RenderEffect>& effects) {
  api::RenderFrameFile f;
  f.format_version = 1;
  f.scene_id = "plugin-scene-depth";
  f.view.css_width = kDW;
  f.view.css_height = kDH;
  f.view.device_pixel_ratio = 1;
  f.view.camera_center_x = kDW / 2.0;
  f.view.camera_center_y = kDH / 2.0;
  f.view.camera_zoom = 1;
  f.view.bit_depth = 32;
  f.view.float16_textures = true;
  f.view.float32_textures = true;
  f.view.surface_format = api::RenderTextureFormat::bgra8unorm;
  f.scene.width = kDW;
  f.scene.height = kDH;
  f.scene.background = api::Color{0, 0, 0, 1};
  f.scene.has_effects = true;
  f.scene.camera3d = default_camera3d();
  for (auto& s : solids) f.scene.renderables.push_back(std::move(s));
  for (const api::RenderEffect& e : effects) {
    api::Renderable r;
    for (const auto& p : e.params) {
      if (p.name == "layerId") r.id = p.text;
    }
    r.kind = api::RenderableKind::rect;
    r.model_matrix = {static_cast<double>(kDW), 0, 0, 0, static_cast<double>(kDH), 0, 0, 0, 1};
    r.bounds = {0, 0, static_cast<double>(kDW), static_cast<double>(kDH)};
    r.opacity = 1;
    r.color = api::Color{0, 0, 0, 1};
    r.effects.push_back(e);
    f.scene.renderables.push_back(std::move(r));
  }
  return f;
}

const float* px_at(const Rendered& r, std::uint32_t x, std::uint32_t y) { return &r.scene[(std::size_t{y} * kDW + x) * 4]; }

/// SDK 1.4 (D3): a comp-sized 3D mesh quad (an extruded mesh, unlit) in `c`, with a plugin material.
api::Renderable mesh_quad(const char* id, const std::string& wgsl, std::vector<double> params, api::Color c = {0.8, 0.2, 0.2, 1}) {
  api::Renderable r;
  r.id = id;
  r.kind = api::RenderableKind::rect;
  r.model_matrix = {static_cast<double>(kDW), 0, 0, 0, static_cast<double>(kDH), 0, 0, 0, 1};
  r.bounds = {0, 0, static_cast<double>(kDW), static_cast<double>(kDH)};
  r.opacity = 1;
  r.color = api::Color{1, 1, 1, 1};
  const std::array<std::array<float, 8>, 4> v{{{0, 0, 0, 0, 0, -1, 0, 0},
                                               {static_cast<float>(kDW), 0, 0, 0, 0, -1, 1, 0},
                                               {static_cast<float>(kDW), static_cast<float>(kDH), 0, 0, 0, -1, 1, 1},
                                               {0, static_cast<float>(kDH), 0, 0, 0, -1, 0, 1}}};
  const std::array<std::uint32_t, 6> idx{0, 1, 2, 0, 2, 3};
  api::RenderExtrudedMesh m;
  m.key = std::string(id) + "#quad";
  m.vertices.resize(sizeof v);
  std::memcpy(m.vertices.data(), v.data(), sizeof v);
  m.indices.resize(sizeof idx);
  std::memcpy(m.indices.data(), idx.data(), sizeof idx);
  m.index_format = api::RenderIndexFormat::uint32;
  api::RenderMeshRange range;
  range.role = api::RenderMeshRole::front;
  range.first = 0;
  range.count = 6;
  range.color = c;
  range.gain = 1;
  m.ranges.push_back(range);
  m.surface = api::RenderMeshSurface::uv;
  m.surface_width = 1;
  m.surface_height = 1;
  if (!wgsl.empty()) {
    api::RenderMeshMaterial mat;
    mat.wgsl = wgsl;
    mat.params = std::move(params);
    m.material = std::move(mat);
  }
  r.extruded_mesh = std::move(m);
  api::RenderThreeD t;
  t.model = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  r.three_d = t;
  return r;
}

}  // namespace

TEST_CASE("plugin GPU (SDK 1.2 S6): the scene depth holds each 3D layer's camera-space z, +inf where empty", "[plugins][gpu][sdk12]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) {
    WARN("no float32 targets: skipped");
    return;
  }
  pl::PluginHost host(options());
  host.scan();
  REQUIRE(host.effect(kModel3d) != nullptr);
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  const double zoom = default_zoom();
  // A wall 100 px behind the comp's plane over the middle; a nearer card (z = -60) over its upper left (the default camera of a 96 px comp is only ~133 px away).
  const auto wall = solid3d("wall", 20, 16, 56, 32, 100, {0, 1, 0, 1});
  const auto card = solid3d("card", 10, 10, 30, 20, -60, {1, 1, 1, 1});
  const auto before = glue.stats();
  const Rendered out = render(*r, depth_frame({wall, card}, {model3d_effect("fx", 2, false)}));
  for (const auto& dg : out.stats.diagnostics) std::printf("[diag] %s: %s\n", dg.code.c_str(), dg.detail.c_str());
  CHECK(glue.stats().gpu == before.gpu + 1);
  CHECK(glue.scene_depth().passes() == 1);
  // Right of centre the wall is seen: z = 100 + zoom (red = z / 1000).
  const float* c = px_at(out, kDW / 2 + 8, kDH / 2);
  INFO("zoom " << zoom << " centre " << c[0] << "," << c[1] << "," << c[2]);
  CHECK(std::abs(c[0] * 1000.0 - (100 + zoom)) < 0.5);
  CHECK(c[2] == 0.0F);
  // Where the card covers the wall, the nearer one wins: -60 + zoom. The card's centre (25, 20)
  // at z = -60 is magnified about the view's centre by zoom / (zoom - 60).
  const double cardZ = -60 + zoom;
  const double k = zoom / cardZ;
  const auto sx = static_cast<std::uint32_t>(kDW / 2.0 + (25 - kDW / 2.0) * k);
  const auto sy = static_cast<std::uint32_t>(kDH / 2.0 + (20 - kDH / 2.0) * k);
  const float* d = px_at(out, sx, sy);
  INFO("card at " << sx << "," << sy << ": " << d[0] << "," << d[2]);
  CHECK(std::abs(d[0] * 1000.0 - cardZ) < 0.5);
  // Nothing drawn in the corner: +inf (blue).
  const float* e = px_at(out, kDW - 2, kDH - 2);
  CHECK(e[0] == 0.0F);
  CHECK(e[2] == 1.0F);
}

TEST_CASE("plugin GPU (SDK 1.2 S6): the effect's own 3D layer is not in its scene depth", "[plugins][gpu][sdk12]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  // The effect sits on the only 3D layer: its depth sees nothing — blue on the layer, not red.
  auto wall = solid3d("wall", 0, 0, kDW, kDH, 0, {0, 1, 0, 1});
  wall.effects.push_back(model3d_effect("wall", 2, false));
  const Rendered out = render(*r, depth_frame({wall}, {}));
  const float* c = px_at(out, kDW / 2, kDH / 2);
  INFO("centre " << c[0] << "," << c[1] << "," << c[2]);
  CHECK(c[2] > 0.9F);
  CHECK(c[0] < 0.01F);
  CHECK(c[1] < 0.01F);  // the layer's own green is replaced by the generator's output
}

TEST_CASE("plugin GPU (SDK 1.2 S6): effects of one frame share one depth pass; only those that ask pay", "[plugins][gpu][sdk12]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  const auto wall = solid3d("wall", 20, 16, 56, 32, 100, {0, 1, 0, 1});
  // Shaded without the checkbox: the depth is never made.
  (void)render(*r, depth_frame({wall}, {model3d_effect("a", 1, false)}));
  CHECK(glue.scene_depth().passes() == 0);
  // Two 2D layers that read it in one frame: one pass (neither excludes a drawn layer).
  (void)render(*r, depth_frame({wall}, {model3d_effect("a", 2, false), model3d_effect("b", 1, true)}));
  CHECK(glue.scene_depth().passes() == 1);
  // The next frame makes its own.
  (void)render(*r, depth_frame({wall}, {model3d_effect("a", 2, false)}));
  CHECK(glue.scene_depth().passes() == 2);
}

TEST_CASE("plugin GPU (SDK 1.2 S8): model3d on the GPU matches its CPU path; scene depth occludes it", "[plugins][gpu][sdk12]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  const auto lit = [](const Rendered& o) {
    std::size_t n = 0;
    for (std::size_t i = 0; i < o.scene.size(); i += 4) n += o.scene[i] + o.scene[i + 1] + o.scene[i + 2] > 0.05F ? 1 : 0;
    return n;
  };

  glue.set_gpu_enabled(true);
  auto before = glue.stats();
  const Rendered gpu = render(*r, depth_frame({}, {model3d_effect("fx", 1, false)}));
  for (const auto& dg : gpu.stats.diagnostics) std::printf("[diag] %s: %s\n", dg.code.c_str(), dg.detail.c_str());
  CHECK(glue.stats().gpu == before.gpu + 1);
  CHECK(glue.stats().gpuErrors == before.gpuErrors);
  CHECK(gpu.stats.diagnostics.empty());
  glue.set_gpu_enabled(false);
  before = glue.stats();
  const Rendered cpu = render(*r, depth_frame({}, {model3d_effect("fx", 1, false)}));
  CHECK(glue.stats().cpu == before.cpu + 1);
  glue.set_gpu_enabled(true);
  const std::size_t g = lit(gpu);
  const std::size_t c = lit(cpu);
  std::printf("[measure] model3d coverage GPU %zu px, CPU %zu px\n", g, c);
  CHECK(g > 1000);
  CHECK(std::abs(static_cast<double>(g) - static_cast<double>(c)) < 0.04 * static_cast<double>(c));
  // Shading: the same maths — the centre pixel within a few percent.
  const float* gc = px_at(gpu, kDW / 2, kDH / 2);
  const float* cc = px_at(cpu, kDW / 2, kDH / 2);
  INFO("centre GPU " << gc[0] << "," << gc[1] << "," << gc[2] << " CPU " << cc[0] << "," << cc[1] << "," << cc[2]);
  CHECK(std::abs(gc[0] - cc[0]) < 0.03F);
  CHECK(std::abs(gc[1] - cc[1]) < 0.03F);

  // A green 3D wall in front of the model's left half (z = -60) and the checkbox on: the wall
  // shows through where it is nearer; without the checkbox the model (a 2D layer on top) covers it.
  const auto wall = solid3d("wall", -2000, -2000, 2000 + kDW / 2.0, 4000, -60, {0, 1, 0, 1});
  const Rendered over = render(*r, depth_frame({wall}, {model3d_effect("fx", 1, false)}));
  const Rendered occluded = render(*r, depth_frame({wall}, {model3d_effect("fx", 1, true)}));
  const float* a = px_at(over, kDW / 2 - 6, kDH / 2);
  const float* b = px_at(occluded, kDW / 2 - 6, kDH / 2);
  INFO("over " << a[0] << "," << a[1] << "," << a[2] << " occluded " << b[0] << "," << b[1] << "," << b[2]);
  CHECK_FALSE((a[0] < 0.02F && a[1] > 0.9F));  // the model
  CHECK(b[0] < 0.02F);                          // the wall
  CHECK(b[1] > 0.9F);
  // The right half is behind nothing: the model either way.
  const float* ra = px_at(over, kDW / 2 + 6, kDH / 2);
  const float* rb = px_at(occluded, kDW / 2 + 6, kDH / 2);
  CHECK(std::abs(ra[0] - rb[0]) < 1e-4F);
  // The CPU path occludes the same way (the depth read back).
  glue.set_gpu_enabled(false);
  const Rendered cpuOccluded = render(*r, depth_frame({wall}, {model3d_effect("fx", 1, true)}));
  glue.set_gpu_enabled(true);
  const float* cb = px_at(cpuOccluded, kDW / 2 - 6, kDH / 2);
  CHECK(cb[1] > 0.9F);
  CHECK(cb[0] < 0.02F);
}

// 2026-10-13 QA: Roughness and Specular made no visible difference in a comp without lights (the
// headlight path had no specular term). Both paths now light it with the material's Blinn-Phong.
TEST_CASE("plugin GPU (SDK 1.2 S8): model3d's Roughness and Specular change the picture without comp lights; GPU = CPU",
          "[plugins][gpu][sdk12]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  const auto shaded = [&](double roughness, double specular, bool gpu) {
    api::RenderEffect e = model3d_effect("fx", 1, false);
    e.params.push_back(num("p.p9", roughness));
    e.params.push_back(num("p.p10", specular));
    glue.set_gpu_enabled(gpu);
    const Rendered out = render(*r, depth_frame({}, {e}));
    glue.set_gpu_enabled(true);
    const float* c = px_at(out, kDW / 2, kDH / 2);
    return std::array<float, 3>{c[0], c[1], c[2]};
  };
  const auto luma = [](const std::array<float, 3>& c) { return (c[0] + c[1] + c[2]) / 3; };
  for (const bool gpu : {true, false}) {
    INFO("gpu " << gpu);
    const auto matte = shaded(90, 0, gpu);
    const auto rough = shaded(90, 100, gpu);  // broad highlight: the whole face brightens
    const auto gloss = shaded(8, 100, gpu);   // tight highlight: off the face's normal, nothing
    INFO("matte " << luma(matte) << " rough " << luma(rough) << " gloss " << luma(gloss));
    CHECK(luma(rough) - luma(matte) > 0.2F);   // Specular is visible
    CHECK(luma(rough) - luma(gloss) > 0.2F);   // and Roughness is
    CHECK(std::abs(luma(gloss) - luma(matte)) < 0.05F);
  }
  // The GPU's shade() is the CPU's line for line.
  for (const auto& [ro, sp] : {std::pair{90.0, 100.0}, std::pair{40.0, 50.0}, std::pair{8.0, 100.0}}) {
    const auto g = shaded(ro, sp, true);
    const auto c = shaded(ro, sp, false);
    INFO("roughness " << ro << " specular " << sp);
    for (std::size_t k = 0; k < 3; ++k) CHECK(std::abs(g.at(k) - c.at(k)) < 0.03F);
  }
}

TEST_CASE("plugin GPU (SDK 1.2 S6): a collapsed 3D precomp's 3D layers are in the scene depth; a sealed one's and a card's are not",
          "[plugins][gpu][sdk12]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  const double zoom = default_zoom();
  // A precomp layer whose only content is a 3D wall 100 px behind the comp's plane.
  const auto precomp = [](bool card, bool sealed) {
    api::Renderable pc;
    pc.id = "pc";
    pc.kind = api::RenderableKind::image;
    pc.model_matrix = {static_cast<double>(kDW), 0, 0, 0, static_cast<double>(kDH), 0, 0, 0, 1};
    pc.bounds = {0, 0, static_cast<double>(kDW), static_cast<double>(kDH)};
    pc.opacity = 1;
    pc.texture_key = "precomp:pc";
    api::RenderPrecompFrame frame;
    if (card) {
      frame.flat_width = kDW;
      frame.flat_height = kDH;
    }
    if (sealed) frame.camera3d = default_camera3d();
    pc.precomp = frame;
    pc.precomp_children.push_back(solid3d("inner", 20, 16, 56, 32, 100, {0, 1, 0, 1}));
    return pc;
  };
  const auto centre_z = [&](const Rendered& out) {
    const float* c = px_at(out, kDW / 2 + 8, kDH / 2);
    return c[2] == 0.0F ? static_cast<double>(c[0]) * 1000.0 : std::numeric_limits<double>::infinity();
  };
  // Collapsed (no camera of its own, not a card): the 3D renderer draws the wall under the comp's
  // camera with its own model, so the depth has it: z = 100 + zoom.
  const Rendered collapsed = render(*r, depth_frame({precomp(false, false)}, {model3d_effect("fx", 2, false)}));
  INFO("collapsed centre z " << centre_z(collapsed));
  CHECK(std::abs(centre_z(collapsed) - (100 + zoom)) < 0.5);
  // A card (flatWidth) and a sealed precomp (its own camera) are flat pictures in the comp: no depth.
  const Rendered asCard = render(*r, depth_frame({precomp(true, false)}, {model3d_effect("fx", 2, false)}));
  CHECK(std::isinf(centre_z(asCard)));
  const Rendered sealed = render(*r, depth_frame({precomp(false, true)}, {model3d_effect("fx", 2, false)}));
  CHECK(std::isinf(centre_z(sealed)));
  // A precomp at 0 opacity draws nothing: nothing in the depth either.
  auto hidden = precomp(false, false);
  hidden.opacity = 0;
  const Rendered none = render(*r, depth_frame({hidden}, {model3d_effect("fx", 2, false)}));
  CHECK(std::isinf(centre_z(none)));
}

TEST_CASE("plugin GPU (SDK 1.2 S6): checkout_scene_depth_gpu_at — model3d's own motion blur occludes each sub-frame at its time",
          "[plugins][gpu][sdk12]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  // At the frame's time a green wall covers the whole view in front of the model (z = -60). At the
  // shutter's two sub-times (what finish_native_frame evaluates off the document) the wall has moved
  // far behind the model (z = +2000): every sub-frame sees the model.
  const auto wall = solid3d("wall", -2000, -2000, 4000 + kDW, 4000 + kDH, -60, {0, 1, 0, 1});
  const auto behind = solid3d("wall", -2000, -2000, 4000 + kDW, 4000 + kDH, 2000, {0, 1, 0, 1});
  // The sample times model3d asks for: 2 samples over a 180° shutter at phase 0, 30 fps.
  const std::int64_t step = std::llround(static_cast<double>(PR_TIME_SCALE) / 30);
  const std::array<std::int64_t, 2> times{std::llround(45.0 / 360 * static_cast<double>(step)), std::llround(135.0 / 360 * static_cast<double>(step))};
  const auto blurred = [&](bool depthAt) {
    api::RenderEffect e = model3d_effect("fx", 1, true);
    for (auto p : {num("mb", 1), num("shutterAngle", 180), num("shutterPhase", 0), num("mbSamples", 2), num("timeStep", static_cast<double>(step)),
                   num("layerTime", 0), num("compTime", 0), num("p.p14", 1)}) {
      e.params.push_back(p);
    }
    const std::uint32_t what = PR_SAMPLE_PARAMS | PR_SAMPLE_CAMERA | PR_SAMPLE_LAYER_TRANSFORMS | (depthAt ? PR_SAMPLE_SCENE_DEPTH : 0U);
    std::vector<double> index;
    for (std::size_t i = 0; i < times.size(); ++i) {
      index.push_back(static_cast<double>(times.at(i)));
      index.push_back(static_cast<double>(what));
      const std::string pre = "s" + std::to_string(i) + ".dp.";
      e.params.push_back({pre + "ids", api::RenderParamKind::text, 0, {}, "wall", {}});
      e.params.push_back({pre + "m", api::RenderParamKind::numbers, 0, behind.three_d->model, "", {}});
    }
    e.params.push_back({"samples", api::RenderParamKind::numbers, 0, index, "", {}});
    return e;
  };
  const auto lit = [](const Rendered& o) {  // pixels that are not the green wall
    std::size_t n = 0;
    for (std::size_t i = 0; i < o.scene.size(); i += 4) n += o.scene[i] > 0.05F ? 1 : 0;
    return n;
  };
  for (const bool gpu : {true, false}) {
    INFO((gpu ? "GPU" : "CPU") << " path");
    glue.set_gpu_enabled(gpu);
    // Without PR_SAMPLE_SCENE_DEPTH the sub-frames fall back to the frame's depth: the wall hides it all.
    const Rendered frameDepth = render(*r, depth_frame({wall}, {blurred(false)}));
    const auto passes = glue.scene_depth().passes();
    const Rendered atDepth = render(*r, depth_frame({wall}, {blurred(true)}));
    std::printf("[measure] model3d blurred, %s: lit with the frame's depth %zu px, with the sub-times' %zu px\n", gpu ? "GPU" : "CPU",
                lit(frameDepth), lit(atDepth));
    CHECK(lit(frameDepth) == 0);
    CHECK(lit(atDepth) > 1000);
    CHECK(glue.scene_depth().passes() >= passes + 2);  // one pass per posed sub-time
    const float* c = px_at(atDepth, kDW / 2, kDH / 2);
    CHECK(c[0] > 0.05F);  // the model, not the wall's green
  }
  glue.set_gpu_enabled(true);
}

TEST_CASE("plugin GPU: a plugin's output is linear — an identity grade leaves the frame as it was", "[plugins][gpu]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  api::RenderEffect identity = grade_effect(32, 32);
  for (auto& p : identity.params) {
    if (p.name == "p.p1") p.numbers = {1, 1, 1, 1};
    if (p.name == "p.p2" || p.name == "p.p4") p.number = 0;
    if (p.name == "p.p3") p.number = 100;
  }
  const Rendered plain = render(*r, frame(32, nullptr));
  for (const bool gpu : {true, false}) {
    glue.set_gpu_enabled(gpu);
    const Rendered graded = render(*r, frame(32, &identity));
    INFO("gpu " << gpu);
    CHECK(max_diff(graded.scene, plain.scene) < 1e-4F);  // was: the output sRGB-decoded on the way back (darker)
  }
  glue.set_gpu_enabled(true);
}

TEST_CASE("plugin GPU (SDK 1.2 S6): a collapsed precomp's 3D layer occludes each sub-frame where its instance put it",
          "[plugins][gpu][sdk12]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  pl::PluginHost host(options());
  host.scan();
  pl::RenderGlue glue(&host);
  r->set_native_effects(&glue);
  // The wall sits inside a COLLAPSED precomp "pc" (no camera of its own, not a card): at the frame's
  // time it covers the view in front of the model. Its instance carries it far behind the model at
  // the shutter's two sub-times — the poses finish_native_frame now gives "pc::wall" (a frame built
  // at each sub-time; before, a collapsed copy kept its frame pose and hid every sub-frame).
  auto wall = solid3d("pc::wall", -2000, -2000, 4000 + kDW, 4000 + kDH, -60, {0, 1, 0, 1});
  const auto behind = solid3d("pc::wall", -2000, -2000, 4000 + kDW, 4000 + kDH, 2000, {0, 1, 0, 1});
  api::Renderable pc;
  pc.id = "pc";
  pc.kind = api::RenderableKind::image;
  pc.model_matrix = {static_cast<double>(kDW), 0, 0, 0, static_cast<double>(kDH), 0, 0, 0, 1};
  pc.bounds = {0, 0, static_cast<double>(kDW), static_cast<double>(kDH)};
  pc.opacity = 1;
  pc.texture_key = "precomp:pc";
  pc.precomp = api::RenderPrecompFrame{};
  pc.precomp_children.push_back(std::move(wall));
  const std::int64_t step = std::llround(static_cast<double>(PR_TIME_SCALE) / 30);
  const std::array<std::int64_t, 2> times{std::llround(45.0 / 360 * static_cast<double>(step)), std::llround(135.0 / 360 * static_cast<double>(step))};
  const auto blurred = [&](bool posed) {
    api::RenderEffect e = model3d_effect("fx", 1, true);
    for (auto p : {num("mb", 1), num("shutterAngle", 180), num("shutterPhase", 0), num("mbSamples", 2), num("timeStep", static_cast<double>(step)),
                   num("layerTime", 0), num("compTime", 0), num("p.p14", 1)}) {
      e.params.push_back(p);
    }
    const std::uint32_t what = PR_SAMPLE_PARAMS | PR_SAMPLE_CAMERA | PR_SAMPLE_LAYER_TRANSFORMS | PR_SAMPLE_SCENE_DEPTH;
    std::vector<double> index;
    for (std::size_t i = 0; i < times.size(); ++i) {
      index.push_back(static_cast<double>(times.at(i)));
      index.push_back(static_cast<double>(what));
      if (!posed) continue;  // what the hook sent for a collapsed copy before: no pose
      const std::string pre = "s" + std::to_string(i) + ".dp.";
      e.params.push_back({pre + "ids", api::RenderParamKind::text, 0, {}, "pc::wall", {}});
      e.params.push_back({pre + "m", api::RenderParamKind::numbers, 0, behind.three_d->model, "", {}});
    }
    e.params.push_back({"samples", api::RenderParamKind::numbers, 0, index, "", {}});
    return e;
  };
  const auto lit = [](const Rendered& o) {
    std::size_t n = 0;
    for (std::size_t i = 0; i < o.scene.size(); i += 4) n += o.scene[i] > 0.05F ? 1 : 0;
    return n;
  };
  for (const bool gpu : {true, false}) {
    INFO((gpu ? "GPU" : "CPU") << " path");
    glue.set_gpu_enabled(gpu);
    const Rendered framePose = render(*r, depth_frame({pc}, {blurred(false)}));
    const Rendered subPose = render(*r, depth_frame({pc}, {blurred(true)}));
    std::printf("[measure] model3d blurred behind a collapsed precomp's wall, %s: lit %zu px unposed, %zu px posed\n",
                gpu ? "GPU" : "CPU", lit(framePose), lit(subPose));
    CHECK(lit(framePose) == 0);
    CHECK(lit(subPose) > 1000);
    const float* c = px_at(subPose, kDW / 2, kDH / 2);
    CHECK(c[0] > 0.05F);
  }
  glue.set_gpu_enabled(true);
}

TEST_CASE("plugin GPU (SDK 1.4 D3): a plugin material is linked into the 3D shader; one that fails draws standard", "[plugins][gpu][scene3d]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  // Bands of the inverted colour, params[0].x across the diagonal.
  const std::string stripes = R"(
fn premation_material(m : PremationMaterialIn) -> PremationMaterialOut {
  var o : PremationMaterialOut;
  let band = step(0.5, fract((m.uv.x + m.uv.y) * m.params[0].x * 0.5));
  o.base = mix(m.color.rgb, vec3<f32>(1.0) - m.color.rgb, band);
  o.alpha = m.color.a;
  o.normal = m.normal;
  o.emissive = vec3<f32>(0.0);
  return o;
}
)";
  const auto inverted = [](const Rendered& o) {
    std::size_t n = 0;
    for (std::size_t i = 0; i < o.scene.size(); i += 4) n += o.scene[i + 1] > o.scene[i] + 0.2F ? 1 : 0;
    return n;
  };
  const Rendered standard = render(*r, depth_frame({mesh_quad("q", "", {})}, {}));
  CHECK(inverted(standard) == 0);
  const Rendered striped = render(*r, depth_frame({mesh_quad("q", stripes, {4, 0})}, {}));
  for (const auto& dg : striped.stats.diagnostics) std::printf("[diag] %s: %s\n", dg.code.c_str(), dg.detail.c_str());
  CHECK_FALSE(has_diag(striped.stats, "plugin-material"));
  const std::size_t bands = inverted(striped);
  INFO("inverted px " << bands << " of " << kDW * kDH);
  CHECK(bands > (kDW * kDH) / 4);
  CHECK(bands < (kDW * kDH) * 3 / 4);
  // The params reach the function: more stripes, another picture.
  const Rendered denser = render(*r, depth_frame({mesh_quad("q", stripes, {12, 0})}, {}));
  CHECK(max_diff(denser.scene, striped.scene) > 0.3F);

  // A source that does not compile: the standard material, a diagnostic once, remembered by hash.
  const std::string broken = "fn premation_material(m : PremationMaterialIn) -> PremationMaterialOut { return nope(m); }";
  const Rendered bad = render(*r, depth_frame({mesh_quad("q", broken, {})}, {}));
  CHECK(has_diag(bad.stats, "plugin-material"));
  CHECK(max_diff(bad.scene, standard.scene) < 1e-4F);
  CHECK(rg::plugin_material_error(rg::plugin_material_hash(broken)).has_value());
  const Rendered again = render(*r, depth_frame({mesh_quad("q", broken, {})}, {}));
  CHECK_FALSE(has_diag(again.stats, "plugin-material"));
  CHECK(max_diff(again.scene, standard.scene) < 1e-4F);
  // One that reaches for a binding is refused before linking.
  const std::string grabby = "@group(0) @binding(30) var<uniform> x : vec4<f32>;\n" + stripes;
  CHECK_FALSE(rg::plugin_material_refusal(grabby).empty());
  const Rendered refused = render(*r, depth_frame({mesh_quad("q", grabby, {4, 0})}, {}));
  CHECK(has_diag(refused.stats, "plugin-material"));
  CHECK(max_diff(refused.scene, standard.scene) < 1e-4F);
}
