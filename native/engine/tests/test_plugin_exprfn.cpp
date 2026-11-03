// SDK 1.4 (E1/E2): a plugin's expression functions, on the `mathfns` sample.
//
//   * the host calls them crash-guarded; numbers in, a number or an array out;
//   * published, expressions reach them as plugin["<id>"].<name>(…), arrays flattened;
//   * a function that faults is disabled for the session, the engine carries on, and the
//     expression reports an error instead of a value;
//   * unpublished (the host gone), `plugin` is an empty object again.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "anim.hpp"
#include "anim_json.hpp"
#include "expr.hpp"
#include "host.hpp"

namespace pl = premation::plugins;
namespace fs = std::filesystem;
namespace ex = motion::expr;

namespace {

constexpr const char* kMath = "com.premation.samples.mathfns";

pl::HostOptions options() {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES) / "mathfns"};
  o.threads = 1;
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

ex::Result run(std::u16string_view src) { return ex::Expression::compile(src).run(ex::Context{}); }

}  // namespace

TEST_CASE("expression functions: the host calls them; a fault is contained", "[plugins][exprfn]") {
  pl::PluginHost host(options());
  host.scan();
  std::vector<double> out;
  std::string error;
  REQUIRE(host.call_expression(kMath, "smoothstep", std::vector<double>{0, 1, 0.5}, out, error));
  CHECK(out == std::vector<double>{0.5});
  REQUIRE(host.call_expression(kMath, "remap", std::vector<double>{5, 0, 10, 0, 0, 100, 200}, out, error));
  CHECK(out == std::vector<double>{50, 100});
  CHECK_FALSE(host.call_expression(kMath, "nothing", std::vector<double>{}, out, error));

  CHECK_FALSE(host.call_expression(kMath, "crash", std::vector<double>{}, out, error));
  CHECK(error.find("crash") != std::string::npos);
  // Disabled for the session; the others still work.
  CHECK_FALSE(host.call_expression(kMath, "crash", std::vector<double>{}, out, error));
  CHECK(host.call_expression(kMath, "smoothstep", std::vector<double>{0, 1, 1}, out, error));
}

TEST_CASE("expression functions: plugin[\"<id>\"].<name>() in an expression", "[plugins][exprfn]") {
  {
    pl::PluginHost host(options());
    host.scan();
    host.publish_expression_functions();
    const ex::Result r = run(u"plugin[\"com.premation.samples.mathfns\"].smoothstep(0, 100, 25)");
    const std::string why = r.error ? ex::utf16_to_utf8(*r.error) : std::string();
    INFO(why);
    REQUIRE(r.kind == ex::Result::Kind::kNumber);
    CHECK(r.number == 0.15625);
    // Arrays flatten; more than one result is an array.
    const ex::Result v = run(u"plugin[\"com.premation.samples.mathfns\"].remap(0.5, 0, 1, [0, 10], [100, 30])");
    REQUIRE(v.kind == ex::Result::Kind::kVector);
    CHECK(v.size == 2);
    CHECK(v.vec[0] == 50);
    CHECK(v.vec[1] == 20);
    // An interpolator is an expression function too: (t, v0, v1), settling on v1 at t = 1.
    CHECK(run(u"plugin[\"com.premation.samples.mathfns\"].springy(1, 10, 20)").number == 20);
    // A faulting function is an expression error, not a crash.
    const ex::Result bad = run(u"plugin[\"com.premation.samples.mathfns\"].crash()");
    CHECK(bad.error.has_value());
  }
  // The host is gone: its functions are no longer offered, and nothing calls into it.
  CHECK(ex::plugin_functions().empty());
  const ex::Result gone = run(u"plugin[\"com.premation.samples.mathfns\"].smoothstep(0, 1, 0.5)");
  CHECK(gone.error.has_value());
}

TEST_CASE("interpolators: a keyframe segment eased by a plugin function (E2)", "[plugins][exprfn]") {
  namespace doc = premation::doc;
  pl::PluginHost host(options());
  host.scan();
  host.publish_expression_functions();
  doc::Key a;
  a.t = 0;
  a.value = 10;
  a.interp = std::string(kMath) + ":springy";
  doc::Key b;
  b.t = 1;
  b.value = 20;
  const std::vector<doc::Key> keys{a, b};
  // springy: 1 - e^(-6t) cos(12t) — past the target early on, settled at the end.
  double peak = 0;
  for (int i = 1; i < 100; ++i) peak = std::max(peak, *doc::anim_sample_keys(keys, i / 100.0));
  CHECK(peak > 20);
  CHECK(*doc::anim_sample_keys(keys, 1.0) == 20);
  const double mid = *doc::anim_sample_keys(keys, 0.5);
  CHECK(std::abs(mid - (10 + 10 * (1 - std::exp(-3.0) * std::cos(6.0)))) < 1e-12);

  // An interpolator that is not there (plugin gone, typo): the segment eases as usual (linear here).
  std::vector<doc::Key> other = keys;
  other[0].interp = "com.nobody:springy";
  CHECK(*doc::anim_sample_keys(other, 0.5) == 15);

  // Saved and read back with the key.
  const std::optional<doc::Key> back = doc::key_from_json(doc::key_to_json(a));
  REQUIRE(back.has_value());
  CHECK(back->interp == a.interp);
}
