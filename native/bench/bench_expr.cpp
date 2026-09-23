// motion_expr + motion_transform benchmarks, paired with the TypeScript timings
// that `node native/tests/bench_ts.ts` measures for the SAME work (same
// expressions, same contexts, same 2000-layer scene recipe), so the two
// numbers can be quoted side by side (native/README.md).
//
//   BM_Expr/<name>        one run() of a compiled expression (the per-property,
//                         per-frame cost), context prebuilt
//   BM_World2D_2000       world matrices of a 2000-layer 2D parent forest
//   BM_World2D_Chain2000  one 2000-deep chain (worst case for the recursion)
//   BM_Compose3D_2000     composeNodeWorld3d × 2000

#include <benchmark/benchmark.h>

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>

#include "eval.hpp"
#include "expr.hpp"
#include "transform.hpp"

namespace {

namespace ex = motion::expr;
namespace xf = motion::xf;

/// Linear 0 → 100 over t = 0..1 (the aeIdioms ramp) through motion_eval.
class RampHost final : public ex::Host {
 public:
  RampHost() {
    kfs_[0] = motion_keyframe{};
    kfs_[1] = motion_keyframe{};
    kfs_[1].t = 1;
    kfs_[1].value = 100;
  }
  [[nodiscard]] bool has_self_at() const override { return true; }
  double self_at(double t) override { return motion::eval::sample(motion::eval::StructSource{kfs_}, t); }

 private:
  std::array<motion_keyframe, 2> kfs_{};
};

void run_expr(benchmark::State& state, std::u16string_view src) {
  const ex::Expression e = ex::Expression::compile(src);
  RampHost host;
  const std::array<double, 2> keys{0, 1};
  ex::Context c;
  c.value = 50;
  c.prop_seed = 1234;
  c.self_span = ex::KeySpan{.start = 0, .end = 1};
  c.key_times = keys;
  c.host = &host;
  double t = 0;
  for (auto _ : state) {
    c.time = t;
    t += 1.0 / 60;
    if (t > 3) t = 0;
    benchmark::DoNotOptimize(e.run(c));
  }
}

// Keep in step with native/tests/bench_ts.ts EXPRESSIONS.
void BM_Expr_Arith(benchmark::State& s) { run_expr(s, u"value + Math.sin(time * 2) * 40"); }
void BM_Expr_Wiggle(benchmark::State& s) { run_expr(s, u"wiggle(3, 40)"); }
void BM_Expr_LoopOut(benchmark::State& s) { run_expr(s, u"loopOut('pingpong')"); }
void BM_Expr_Linear(benchmark::State& s) { run_expr(s, u"linear(time, 0, 1, 0, 100) + clamp(value, 0, 50)"); }
void BM_Expr_Bounce(benchmark::State& s) {
  run_expr(s,
           u"time <= key(numKeys).time ? value : value + velocityAtTime(key(numKeys).time - 0.001) * 0.05 * "
           u"Math.sin((time - key(numKeys).time) * 12) / Math.exp((time - key(numKeys).time) * 4)");
}
void BM_Expr_Vector(benchmark::State& s) { run_expr(s, u"add([value, time * 10], mul([1, 2], 3))"); }
BENCHMARK(BM_Expr_Arith);
BENCHMARK(BM_Expr_Wiggle);
BENCHMARK(BM_Expr_LoopOut);
BENCHMARK(BM_Expr_Linear);
BENCHMARK(BM_Expr_Bounce);
BENCHMARK(BM_Expr_Vector);

void BM_Expr_Compile(benchmark::State& state) {
  for (auto _ : state) benchmark::DoNotOptimize(ex::Expression::compile(u"wiggle(3, 40) + linear(time, 0, 1, 0, 100)"));
}
BENCHMARK(BM_Expr_Compile);

/// The bench_ts.ts scene recipe: parent(i) = (i % 50 == 0 || i - 1 - i % 3 < 0) ? -1 : i - 1 - i % 3;
/// locals from a fixed arithmetic sequence (no RNG in either language).
std::vector<xf::Node2D> scene_2d(std::size_t n, bool chain) {
  std::vector<xf::Node2D> nodes(n);
  for (std::size_t i = 0; i < n; ++i) {
    const auto d = static_cast<double>(i);
    nodes[i].local = xf::Local2D{.x = d * 1.5, .y = -d * 0.25, .rotation = d * 7.0, .scale_x = 1 + d * 0.001, .scale_y = 1};
    if (chain) {
      nodes[i].parent = static_cast<std::int32_t>(i) - 1;
    } else {
      const auto p = static_cast<std::int32_t>(i) - 1 - static_cast<std::int32_t>(i % 3);
      nodes[i].parent = (i % 50 == 0 || p < 0) ? -1 : p;
    }
  }
  return nodes;
}

void BM_World2D_2000(benchmark::State& state) {
  const std::vector<xf::Node2D> nodes = scene_2d(2000, false);
  std::vector<xf::Mat2D> out(nodes.size());
  for (auto _ : state) {
    benchmark::DoNotOptimize(xf::world_matrices_2d(nodes, out));
    benchmark::ClobberMemory();
  }
}
BENCHMARK(BM_World2D_2000);

void BM_World2D_Chain2000(benchmark::State& state) {
  const std::vector<xf::Node2D> nodes = scene_2d(2000, true);
  std::vector<xf::Mat2D> out(nodes.size());
  for (auto _ : state) {
    benchmark::DoNotOptimize(xf::world_matrices_2d(nodes, out));
    benchmark::ClobberMemory();
  }
}
BENCHMARK(BM_World2D_Chain2000);

void BM_Compose3D_2000(benchmark::State& state) {
  std::vector<xf::Node3DTransform> v(2000);
  for (std::size_t i = 0; i < v.size(); ++i) {
    const auto d = static_cast<double>(i);
    v[i] = {.x = d, .y = -d, .z = d * 2, .rotation_x = d * 3, .rotation_y = d * 5, .rotation_z = d * 7,
            .orientation_x = 0, .orientation_y = 90, .orientation_z = 0, .scale_x = 1, .scale_y = 2, .scale_z = 1,
            .anchor_x = 10, .anchor_y = 20, .anchor_z = 0};
  }
  for (auto _ : state) {
    for (const auto& t : v) benchmark::DoNotOptimize(xf::compose_node_3d(t));
  }
}
BENCHMARK(BM_Compose3D_2000);

}  // namespace
