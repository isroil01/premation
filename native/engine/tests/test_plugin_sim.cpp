// SDK 1.4 (T): simulations (PR_OUT_FLAG_STATEFUL) and the host's kept states, on the `bounce`
// sample. `inputsAt` stands in for the document (scene_finish.cpp evaluates the params there).
//
//   * a frame's state is the same whether reached cold or step by step, and is deterministic
//     across hosts (the seed is the instance's, never a clock);
//   * scrubbing back steps nothing; playing on steps once per frame;
//   * an input change at frame k keeps every state before k and re-steps from k;
//   * the RAM budget evicts kept states without changing any answer;
//   * SMART_RENDER draws from the state get_sim_state hands it.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#include "cpu_render.hpp"
#include "host.hpp"

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kBounce = "com.premation.samples.bounce";
constexpr std::int64_t kStep = PR_TIME_SCALE / 30;

struct State {
  double x, y, vx, vy;
};

pl::HostOptions options() {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES) / "bounce"};
  o.threads = 2;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

/// Gravity `g` until frame `changeAt`, then `g2`.
pl::SimRequest request(const pl::EffectSpec& spec, std::int64_t frame, double g = 900, std::int64_t changeAt = -1, double g2 = 0,
                       std::uint64_t key = 1) {
  pl::SimRequest q;
  q.base = pl::default_inputs(spec, "L/fx", 320, 240, 32);
  q.frame = frame;
  q.step = kStep;
  q.inputsKey = key;
  q.inputsAt = [&spec, g, changeAt, g2](std::int64_t k) {
    pl::RenderInputs in = pl::default_inputs(spec, "L/fx", 320, 240, 32);
    in.values.at(static_cast<std::size_t>(pl::param_slot(spec, 1))).v[0] = changeAt >= 0 && k >= changeAt ? g2 : g;
    return in;
  };
  return q;
}

State state_of(const std::vector<std::uint8_t>& bytes) {
  REQUIRE(bytes.size() >= sizeof(State));
  State s{};
  std::memcpy(&s, bytes.data(), sizeof(State));
  return s;
}

std::vector<std::uint8_t> sim(pl::PluginHost& h, const pl::SimRequest& q) {
  std::string why;
  auto st = h.sim_state(q, why);
  INFO(why);
  REQUIRE(st.has_value());
  return *st;
}

}  // namespace

TEST_CASE("simulation: cold or step by step, the same state; scrubbing back steps nothing", "[plugins][sim]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kBounce);
  REQUIRE(spec != nullptr);
  REQUIRE(spec->has(PR_OUT_FLAG_STATEFUL));

  // Cold: frames 0..60 stepped once each.
  const std::vector<std::uint8_t> cold = sim(host, request(*spec, 60));
  CHECK(host.sim_stats().steps == 61);
  const State s60 = state_of(cold);
  CHECK(s60.y > 24);  // fell from the top

  // A second host walking frame by frame lands on the same bytes.
  pl::PluginHost other(options());
  other.scan();
  std::vector<std::uint8_t> walked;
  for (std::int64_t k = 0; k <= 60; ++k) walked = sim(other, request(*other.effect(kBounce), k));
  CHECK(walked == cold);
  CHECK(other.sim_stats().steps == 61);

  // Back to frame 30 and to 60 again: kept, no step.
  const auto before = host.sim_stats();
  (void)sim(host, request(*spec, 30));
  CHECK(sim(host, request(*spec, 60)) == cold);
  CHECK(host.sim_stats().steps == before.steps);
  CHECK(host.sim_stats().cacheHits == before.cacheHits + 2);
  // Playing on: one step.
  (void)sim(host, request(*spec, 61));
  CHECK(host.sim_stats().steps == before.steps + 1);
}

TEST_CASE("simulation: an input change at frame k keeps the states before k and re-steps from k", "[plugins][sim]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kBounce);
  REQUIRE(spec != nullptr);
  const std::vector<std::uint8_t> s20 = sim(host, request(*spec, 20));
  const std::vector<std::uint8_t> s60 = sim(host, request(*spec, 60));
  const std::uint64_t steps = host.sim_stats().steps;

  // Gravity flips at frame 30 (a keyframe edit: the inputs key changes).
  const std::vector<std::uint8_t> edited = sim(host, request(*spec, 60, 900, 30, -900, 2));
  CHECK(edited != s60);
  CHECK(host.sim_stats().steps == steps + 31);  // frames 30..60 only
  CHECK(sim(host, request(*spec, 20, 900, 30, -900, 2)) == s20);
  CHECK(host.sim_stats().steps == steps + 31);

  // inputsKey 0 (an expression): still correct, still kept by its inputs.
  CHECK(sim(host, request(*spec, 60, 900, 30, -900, 0)) == edited);
  CHECK(host.sim_stats().steps == steps + 31);
}

TEST_CASE("simulation: the RAM budget evicts kept states, never changes an answer", "[plugins][sim]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kBounce);
  REQUIRE(spec != nullptr);
  const std::vector<std::uint8_t> s90 = sim(host, request(*spec, 90));
  host.set_sim_budget(10 * sizeof(State));
  CHECK(host.sim_stats().bytes <= 10 * sizeof(State));
  CHECK(sim(host, request(*spec, 90)) == s90);       // the newest states are the ones kept
  const std::vector<std::uint8_t> s5 = sim(host, request(*spec, 5));  // evicted: stepped again from 0
  pl::PluginHost fresh(options());
  fresh.scan();
  CHECK(sim(fresh, request(*fresh.effect(kBounce), 5)) == s5);
}

TEST_CASE("simulation: SMART_RENDER draws the frame's state (get_sim_state)", "[plugins][sim]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kBounce);
  REQUIRE(spec != nullptr);
  const std::vector<std::uint8_t> st = sim(host, request(*spec, 45));
  const State s = state_of(st);

  pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", 320, 240, 32);
  in.simState = st;
  pl::TexelImage input;
  input.format = pl::TexelFormat::rgba32f;
  input.width = 320;
  input.height = 240;
  input.bytes.assign(std::size_t{320} * 240 * 16, 0);
  pl::TexelImage out;
  REQUIRE(pl::run_native_cpu(host, in, input, {}, out).ok);
  const auto alpha_at = [&](double x, double y) {
    float a = 0;
    const std::size_t i = (static_cast<std::size_t>(y) * 320 + static_cast<std::size_t>(x)) * 16 + 12;
    std::memcpy(&a, out.bytes.data() + i, sizeof a);
    return a;
  };
  CHECK(alpha_at(s.x, s.y) > 0.99F);                                  // the ball's centre
  CHECK(alpha_at(std::fmod(s.x + 160, 320), std::fmod(s.y + 120, 240)) == 0.0F);  // far from it

  // No state (a step failed): the frame renders empty, not stale.
  in.simState.reset();
  REQUIRE(pl::run_native_cpu(host, in, input, {}, out).ok);
  CHECK(alpha_at(s.x, s.y) == 0.0F);
}
