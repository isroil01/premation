// The render graph's GPU-free half (D2): pass ordering, cycles, orphaned
// targets, and the keyed resource pools' lifetime + accounting rules — the
// behaviours packages/renderer pins in renderGraph.test.ts and
// resourceManager.test.ts / gpuMemory.test.ts.
#include <catch2/catch_test_macros.hpp>

#include <memory>
#include <string>
#include <vector>

#include "graph.hpp"
#include "resource_pool.hpp"

using namespace premation::rg;

namespace {

class P final : public RenderPass {
 public:
  P(std::string n, std::vector<std::string> r, std::vector<std::string> w, std::vector<std::string> a)
      : n_(std::move(n)), r_(std::move(r)), w_(std::move(w)), a_(std::move(a)) {}
  [[nodiscard]] std::string_view name() const override { return n_; }
  [[nodiscard]] std::vector<std::string> reads() const override { return r_; }
  [[nodiscard]] std::vector<std::string> writes() const override { return w_; }
  [[nodiscard]] std::vector<std::string> after() const override { return a_; }
  bool execute(PassContext& /*ctx*/, std::string& /*error*/) override { return true; }

 private:
  std::string n_;
  std::vector<std::string> r_, w_, a_;
};

std::vector<std::string> names(const std::vector<RenderPass*>& order) {
  std::vector<std::string> out;
  for (auto* p : order) out.emplace_back(p->name());
  return out;
}

}  // namespace

TEST_CASE("render graph orders passes like the TS graph (reads, after, insertion ties)") {
  RenderGraph g;
  // Inserted out of order on purpose; the edges decide.
  REQUIRE(g.add_pass(std::make_unique<P>("effect", std::vector<std::string>{"scene-color"}, std::vector<std::string>{"surface"},
                                         std::vector<std::string>{"composition"})));
  REQUIRE(g.add_pass(std::make_unique<P>("clear", std::vector<std::string>{}, std::vector<std::string>{"scene-color"},
                                         std::vector<std::string>{})));
  REQUIRE(g.add_pass(std::make_unique<P>("composition", std::vector<std::string>{}, std::vector<std::string>{"scene-color"},
                                         std::vector<std::string>{"background"})));
  REQUIRE(g.add_pass(std::make_unique<P>("background", std::vector<std::string>{}, std::vector<std::string>{"scene-color"},
                                         std::vector<std::string>{"clear"})));
  std::vector<RenderPass*> order;
  std::string err;
  REQUIRE(g.compile(order, err));
  CHECK(names(order) == std::vector<std::string>{"clear", "background", "composition", "effect"});
  // Duplicate names are refused.
  CHECK_FALSE(g.add_pass(std::make_unique<P>("clear", std::vector<std::string>{}, std::vector<std::string>{},
                                             std::vector<std::string>{})));
}

TEST_CASE("render graph reports a cycle with the stuck passes") {
  RenderGraph g;
  g.add_pass(std::make_unique<P>("a", std::vector<std::string>{"y"}, std::vector<std::string>{"x"}, std::vector<std::string>{}));
  g.add_pass(std::make_unique<P>("b", std::vector<std::string>{"x"}, std::vector<std::string>{"y"}, std::vector<std::string>{}));
  g.add_pass(std::make_unique<P>("c", std::vector<std::string>{}, std::vector<std::string>{"z"}, std::vector<std::string>{}));
  std::vector<RenderPass*> order;
  std::string err;
  CHECK_FALSE(g.compile(order, err));
  CHECK(err.find(" a") != std::string::npos);
  CHECK(err.find(" b") != std::string::npos);
  CHECK(err.find(" c") == std::string::npos);
}

TEST_CASE("targets whose only writers are disabled are not allocated; scratch pools are") {
  RenderGraph g;
  g.add_pass(std::make_unique<P>("mask", std::vector<std::string>{}, std::vector<std::string>{"mask"}, std::vector<std::string>{}));
  g.add_pass(std::make_unique<P>("comp", std::vector<std::string>{}, std::vector<std::string>{"scene"}, std::vector<std::string>{}));
  g.pass("mask")->enabled = false;
  g.invalidate();
  const auto decl = [](std::uint32_t w, std::uint32_t h) { return TargetDesc{w, h, "rgba16float", false, 1}; };
  g.declare_target("mask", decl);
  g.declare_target("scene", decl);
  g.declare_target("blur-target1", decl);  // nobody claims to write it: scratch, kept
  const auto active = g.active_targets(640, 360);
  std::vector<std::string> n;
  for (const auto& [name, d] : active) {
    n.push_back(name);
    CHECK(d.width == 640);
    CHECK(d.height == 360);
  }
  CHECK(n == std::vector<std::string>{"scene", "blur-target1"});
}

TEST_CASE("pool: a key hit reuses, bytes are charged once, GC honours idle frames and pins") {
  MemoryMeter meter;
  Pool<int> pool(&meter);
  int created = 0;
  const auto make = [&] { return ++created; };
  CHECK(pool.acquire("a", 1, make, 100) == 1);
  CHECK(pool.acquire("a", 2, make, 100) == 1);  // hit: same resource, not re-charged
  CHECK(created == 1);
  CHECK(meter.bytes == 100);
  pool.acquire("b", 2, make, 50);
  pool.acquire("pinned", 2, make, 10, /*pinned=*/true);
  CHECK(meter.bytes == 160);
  CHECK(meter.peak == 160);
  CHECK(pool.stats().hits == 1);
  CHECK(pool.stats().misses == 3);

  // Untouched for exactly maxIdle frames: kept (TS: frame - lastFrame > maxIdle).
  CHECK(pool.collect(122, 120) == 0);
  // One frame later both unpinned entries go; the pinned one stays.
  CHECK(pool.collect(123, 120) == 2);
  CHECK(pool.size() == 1);
  CHECK(meter.bytes == 10);
  CHECK(meter.peak == 160);  // high-water mark survives
  pool.clear();
  CHECK(meter.bytes == 0);
}

TEST_CASE("render-target byte estimate matches gpuMemory.ts") {
  // 1920×1080 rgba16float, 4× MSAA with depth: colour + MSAA colour + MSAA depth.
  const std::uint64_t px = 1920ULL * 1080ULL;
  CHECK(render_target_bytes(1920, 1080, 8, 4, true) == px * 8 + px * 8 * 4 + px * 4 * 4);
  CHECK(render_target_bytes(256, 1, 8, 1, false) == 256ULL * 8);
  CHECK(bytes_per_pixel("rgba8unorm") == 4);
  CHECK(bytes_per_pixel("rgba32float") == 16);
}
