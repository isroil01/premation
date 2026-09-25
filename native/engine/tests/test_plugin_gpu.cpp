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
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include "engine_api.hpp"
#include "host.hpp"
#include "premation/protocol/wire.hpp"
#include "render_glue.hpp"
#include "scene_renderer.hpp"

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
              color("p.p1", 1.1, 0.9, 0.8, 1),
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
