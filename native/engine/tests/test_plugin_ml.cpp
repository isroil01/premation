// SDK 1.4 (M): the ML suite, on the `mlstyle` sample (models/style.onnx, a 1x1 conv grade).
//
//   * ml_load takes only models/<name>.onnx in the bundle; the same file is the same id;
//   * the model's result matches the sample's CPU path (the same matrix) within 8-bit rounding,
//     on whatever provider the runtime picked (DirectML / Core ML / CPU);
//   * without a runtime the effect falls back to its CPU path and still renders.
#include <catch2/catch_test_macros.hpp>

#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

#include "cpu_render.hpp"
#include "host.hpp"
#include "ml.hpp"

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kMl = "com.premation.samples.mlstyle";
constexpr std::uint32_t kW = 16, kH = 8;

pl::HostOptions opts() {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES) / "mlstyle"};
  o.threads = 2;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

/// A gradient image: every pixel a different colour, opaque.
pl::TexelImage ramp() {
  pl::TexelImage img;
  img.format = pl::TexelFormat::rgba8;
  img.width = kW;
  img.height = kH;
  img.bytes.resize(std::size_t{kW} * kH * 4);
  for (std::uint32_t y = 0; y < kH; ++y) {
    for (std::uint32_t x = 0; x < kW; ++x) {
      std::uint8_t* p = &img.bytes[(std::size_t{y} * kW + x) * 4];
      p[0] = static_cast<std::uint8_t>(x * 16);
      p[1] = static_cast<std::uint8_t>(y * 32);
      p[2] = static_cast<std::uint8_t>(255 - x * 8);
      p[3] = 255;
    }
  }
  return img;
}

}  // namespace

TEST_CASE("ML suite: ml_load takes only a model the bundle ships", "[plugins][ml]") {
  pl::PluginHost host(opts());
  host.scan();
  REQUIRE(host.effect(kMl) != nullptr);
  std::uint32_t id = 0;
  std::string why;
  CHECK(host.ml_load(kMl, "../mathfns/x.onnx", id, why) == PR_ERR_INVALID_PARAM);
  CHECK(host.ml_load(kMl, "C:/models/x.onnx", id, why) == PR_ERR_INVALID_PARAM);
  CHECK(host.ml_load(kMl, "style.onnx", id, why) == PR_ERR_INVALID_PARAM);
  if (!pl::ml::runtime_available()) {
    CHECK(host.ml_load(kMl, "models/style.onnx", id, why) == PR_ERR_UNSUPPORTED);
    return;
  }
  CHECK(host.ml_load(kMl, "models/none.onnx", id, why) == PR_ERR_NOT_FOUND);
  REQUIRE(host.ml_load(kMl, "models/style.onnx", id, why) == PR_ERR_NONE);
  CHECK(id == 1);
  std::uint32_t again = 0;
  REQUIRE(host.ml_load(kMl, "models/style.onnx", again, why) == PR_ERR_NONE);
  CHECK(again == id);
  const std::string provider = host.ml_provider(kMl, id);
  INFO("provider: " << provider);
  CHECK((provider == "dml" || provider == "cpu" || provider == "coreml" || provider == "cuda"));
  CHECK(host.ml_provider(kMl, 99).empty());
}

TEST_CASE("ML suite: the model's grade matches the CPU path", "[plugins][ml]") {
  pl::PluginHost host(opts());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kMl);
  REQUIRE(spec != nullptr);
  pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", kW, kH, 8);
  pl::TexelImage viaModel;
  pl::TexelImage viaCpu;
  REQUIRE(pl::run_native_cpu(host, in, ramp(), {}, viaModel).ok);
  in.values[static_cast<std::size_t>(pl::param_slot(*spec, 2))].v[0] = 1;  // CPU Only
  REQUIRE(pl::run_native_cpu(host, in, ramp(), {}, viaCpu).ok);
  REQUIRE(viaModel.bytes.size() == viaCpu.bytes.size());
  int worst = 0;
  bool changed = false;
  const pl::TexelImage src = ramp();
  for (std::size_t i = 0; i < viaCpu.bytes.size(); ++i) {
    worst = std::max(worst, std::abs(int{viaModel.bytes[i]} - int{viaCpu.bytes[i]}));
    changed = changed || viaCpu.bytes[i] != src.bytes[i];
  }
  CHECK(changed);     // the grade did something
  CHECK(worst <= 1);  // and the model agrees with the matrix
  if (pl::ml::runtime_available()) CHECK(pl::ml::stats().runs >= 1);
}

TEST_CASE("ML suite (M2): idle models are closed under memory pressure and load again on their next run", "[plugins][ml]") {
  if (!pl::ml::runtime_available()) return;
  pl::PluginHost host(opts());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kMl);
  REQUIRE(spec != nullptr);
  pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", kW, kH, 8);
  pl::TexelImage first;
  REQUIRE(pl::run_native_cpu(host, in, ramp(), {}, first).ok);
  REQUIRE(pl::ml::stats().models >= 1);
  CHECK(pl::ml::stats().bytes > 0);
  // Used a moment ago: a 60 s idle trim keeps it.
  CHECK(pl::ml::trim_idle(60) == 0);
  CHECK(pl::ml::stats().models >= 1);
  // Pressure: every model no run holds is closed.
  CHECK(pl::ml::trim_idle(0) > 0);
  CHECK(pl::ml::stats().models == 0);
  CHECK(pl::ml::stats().bytes == 0);
  // The next render loads it again, with the same pixels.
  pl::TexelImage again;
  REQUIRE(pl::run_native_cpu(host, in, ramp(), {}, again).ok);
  CHECK(pl::ml::stats().models >= 1);
  CHECK(again.bytes == first.bytes);
}
