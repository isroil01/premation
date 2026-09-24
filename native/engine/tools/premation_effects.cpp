// premation-effects — the E4 CPU effect benches.
//
//   premation-effects --bench <effect_kernel_bench.json> [--iterations N] [--threads N] [--only <effect>]
//   premation-effects --chain <effect_chain_bench.json> [--iterations N] [--threads N] [--only <case>]
//
// --bench: every kernel case, ms per 1920×1080 frame on one thread and on the
// pool (--threads, default all cores). The TS side of the same cases is
// native/engine/tests/bench_effects_ts.mjs.
// --chain: the whole bake CHAIN (effect_chain.cpp run_bake_job) for each baked
// layer of the bench comp — every effect alone at its defaults and at an active
// setting, and multi-effect stacks — including the chain's ImageData transfers,
// composites and the seed / read-back, against the 41.7 ms (24 fps) frame. The
// canvas under it is the recording canvas's pixel model with logging off (the
// CPU cost of the chain; Skia's draws of canvas-drawn effects and CSS filters
// are not in it).
// Parity is not checked here — that is engine_effects_tests against
// tests/data/effect_kernel_parity.json and effect_chain_parity.json.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "effects/effect_chain.hpp"
#include "effects/kernel_dispatch.hpp"
#include "raster/json.hpp"
#include "recording_canvas.hpp"

namespace fx = premation::effects;
namespace json = premation::raster::json;

namespace {

/// nativeKernelCrossEngine.test.ts `makeImage`, so both benches blur the same picture.
std::vector<std::uint8_t> make_image(int w, int h, std::uint32_t salt) {
  std::vector<std::uint8_t> d(static_cast<std::size_t>(w) * static_cast<std::size_t>(h) * 4);
  std::uint32_t s = 0x9e3779b9U ^ salt;
  const auto rnd = [&]() -> int {
    s ^= s << 13U;
    s ^= s >> 17U;
    s ^= s << 5U;
    return static_cast<int>(s & 0xFFU);
  };
  const double cx = w * 0.4;
  const double cy = h * 0.55;
  const double rad = std::min(w, h) * 0.3;
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const bool in_disc = (x - cx) * (x - cx) + (y - cy) * (y - cy) < rad * rad;
      const int speck = rnd();
      int r = (x * 255) / std::max(1, w - 1);
      int g = (y * 255) / std::max(1, h - 1);
      int b = (x * 7 + y * 13 + static_cast<int>(salt)) & 0xFF;
      if (in_disc) {
        r = 250;
        g = 40 + (speck & 31);
        b = 20;
      }
      if ((speck & 15) == 0) {
        r = speck;
        g = 255 - speck;
        b = speck ^ 0x5a;
      }
      int a = 255;
      if (y < h * 0.15) {
        a = 0;
      } else if (x > w * 0.8) {
        a = static_cast<int>(std::floor(((w - 1 - x) * 255) / std::max(1.0, w * 0.2)));
      } else if ((speck & 63) == 1) {
        a = speck;
      }
      std::uint8_t* p = d.data() + (static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)) * 4;
      p[0] = static_cast<std::uint8_t>(r);
      p[1] = static_cast<std::uint8_t>(g);
      p[2] = static_cast<std::uint8_t>(b);
      p[3] = static_cast<std::uint8_t>(a);
    }
  }
  return d;
}

double time_ms(const std::string& effect, const fx::KernelArgs& args, const fx::KernelLists& lists,
               const std::vector<std::uint8_t>& input, int w, int h, fx::ThreadPool* pool, int iterations) {
  std::vector<std::uint8_t> buf;
  double best = 1e300;
  for (int i = 0; i < iterations + 1; ++i) {  // first run warms caches and is dropped
    buf = input;
    const auto t0 = std::chrono::steady_clock::now();
    fx::run_kernel(effect, args, lists, fx::RgbaView{buf, w, h}, pool);
    const auto t1 = std::chrono::steady_clock::now();
    const double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
    if (i > 0) best = std::min(best, ms);
  }
  return best;
}

/// Best-of-N ms of one baked layer through the chain (seed, chain, read-back).
double time_chain(const json::Value& c, const std::vector<std::uint8_t>& input, int w, int h, fx::ThreadPool* pool, int iterations,
                  std::size_t& unported) {
  double best = 1e300;
  const json::Value* mask = c.has("mask") ? &c["mask"] : nullptr;
  for (int i = 0; i < iterations + 1; ++i) {
    auto rec = std::make_shared<premation::raster::test::Recording>();
    rec->log = false;
    premation::raster::test::RecordingCanvas oc(rec, static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h));
    fx::ChainReport report;
    const auto t0 = std::chrono::steady_clock::now();
    const std::vector<std::uint8_t> out = fx::run_bake_job(oc, input, c["effects"], c["fillOpacity"].num(1), mask, pool, report);
    const auto t1 = std::chrono::steady_clock::now();
    unported = report.unported.size();
    if (i > 0) best = std::min(best, std::chrono::duration<double, std::milli>(t1 - t0).count());
  }
  return best;
}

int run_chain(const json::Value& cfg, const std::string& only, int iterations, unsigned threads) {
  const int w = static_cast<int>(cfg["width"].num(1920));
  const int h = static_cast<int>(cfg["height"].num(1080));
  const std::vector<std::uint8_t> input = make_image(w, h, 1);
  fx::ThreadPool pool(threads);
  constexpr double kBudget = 1000.0 / 24;
  std::printf("bake chain, %dx%d baked layer, best of %d, %u threads; budget %.1f ms (24 fps)\n", w, h, iterations, pool.size(),  // NOLINT(cppcoreguidelines-pro-type-vararg)
              kBudget);
  std::printf("%-32s %10s %10s %8s\n", "layer", "1 thr ms", "N thr ms", "scale");  // NOLINT(cppcoreguidelines-pro-type-vararg)
  int n = 0;
  int under1 = 0;
  int under_n = 0;
  std::vector<double> many_all;
  for (const json::Value& c : cfg["cases"].items()) {
    const std::string name = c["name"].str();
    if (!only.empty() && name.find(only) == std::string::npos) continue;
    std::size_t unported = 0;
    const double one = time_chain(c, input, w, h, nullptr, iterations, unported);
    const double many = time_chain(c, input, w, h, &pool, iterations, unported);
    ++n;
    under1 += one <= kBudget ? 1 : 0;
    under_n += many <= kBudget ? 1 : 0;
    many_all.push_back(many);
    std::printf("%-32s %10.2f %10.2f %7.1fx%s%s\n", name.c_str(), one, many, one / std::max(1e-9, many),  // NOLINT(cppcoreguidelines-pro-type-vararg)
                many > kBudget ? "  > 24 fps budget" : "", unported > 0 ? "  (unported effect)" : "");
  }
  std::ranges::sort(many_all);
  std::printf("%d layers: %d within %.1f ms on 1 thread, %d on %u threads; median %.2f ms on %u threads\n", n, under1, kBudget,  // NOLINT(cppcoreguidelines-pro-type-vararg)
              under_n, pool.size(), many_all.empty() ? 0.0 : many_all[many_all.size() / 2], pool.size());
  return 0;
}

int usage() {
  std::fputs("usage: premation-effects --bench <effect_kernel_bench.json> [--iterations N] [--threads N] [--only <effect>]\n"
             "       premation-effects --chain <effect_chain_bench.json> [--iterations N] [--threads N] [--only <case>]\n",
             stderr);
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string> a(argv + 1, argv + argc);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  std::string bench;
  bool chain = false;
  std::string only;
  int iterations = 5;
  unsigned threads = 0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    if ((a[i] == "--bench" || a[i] == "--chain") && i + 1 < a.size()) {
      chain = a[i] == "--chain";
      bench = a[++i];
    } else if (a[i] == "--iterations" && i + 1 < a.size()) {
      iterations = std::max(1, std::atoi(a[++i].c_str()));  // NOLINT(cert-err34-c)
    } else if (a[i] == "--threads" && i + 1 < a.size()) {
      threads = static_cast<unsigned>(std::max(0, std::atoi(a[++i].c_str())));  // NOLINT(cert-err34-c)
    } else if (a[i] == "--only" && i + 1 < a.size()) {
      only = a[++i];
    } else {
      return usage();
    }
  }
  if (bench.empty()) return usage();
  std::ifstream f(bench, std::ios::binary);
  if (!f) {
    std::fprintf(stderr, "cannot read %s\n", bench.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 1;
  }
  std::stringstream ss;
  ss << f.rdbuf();
  json::Value cfg;
  std::string err;
  if (!json::parse(ss.str(), cfg, err)) {
    std::fprintf(stderr, "%s: %s\n", bench.c_str(), err.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 1;
  }
  if (chain) return run_chain(cfg, only, iterations, threads);
  const int w = static_cast<int>(cfg["width"].num(1920));
  const int h = static_cast<int>(cfg["height"].num(1080));
  const std::vector<std::uint8_t> input = make_image(w, h, 1);
  fx::ThreadPool pool(threads);
  std::printf("%dx%d, best of %d, %u threads\n", w, h, iterations, pool.size());  // NOLINT(cppcoreguidelines-pro-type-vararg)
  std::printf("%-18s %10s %10s %8s\n", "effect", "1 thr ms", "N thr ms", "scale");  // NOLINT(cppcoreguidelines-pro-type-vararg)
  for (const json::Value& c : cfg["cases"].items()) {
    const std::string effect = c["effect"].str();
    if (!only.empty() && effect != only) continue;
    const json::Value& args = c["args"];
    const fx::KernelArgs ka = [&](std::string_view k, double def) { return args.has(k) ? args[k].num(def) : def; };
    const fx::KernelLists kl = [&](std::string_view k) {
      std::vector<double> v;
      if (args.has(k) && args[k].is_array()) {
        for (const json::Value& x : args[k].items()) v.push_back(x.num());
      }
      return v;
    };
    const double one = time_ms(effect, ka, kl, input, w, h, nullptr, iterations);
    const double many = time_ms(effect, ka, kl, input, w, h, &pool, iterations);
    std::printf("%-18s %10.2f %10.2f %7.1fx\n", effect.c_str(), one, many, one / many);  // NOLINT(cppcoreguidelines-pro-type-vararg)
  }
  return 0;
}
