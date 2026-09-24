// The native plugin host against the SDK's sample plugins (G1 exit criteria,
// docs/NATIVE_CORE_PLAN.md §5): the samples load, register with the document,
// render at 8/16/32 bpc, animate their params, keep per-instance state in the
// document, check out other layers / times, and survive their own crashes.
//
// Crash scenarios run the premation-plugins tool as a CHILD PROCESS: Catch2
// installs its own fatal-signal handlers (a vectored exception handler on
// Windows) around every test case, which would see an injected fault before
// the host's guard does. Running the host in its own process is also exactly
// the engine's situation.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#if !defined(_WIN32)
#include <sys/wait.h>
#endif

#include "cpu_render.hpp"
#include "host.hpp"
#include "journal.hpp"
#include "json.hpp"
#include "native_effects.hpp"

namespace pl = premation::plugins;
namespace doc = premation::doc;
namespace fs = std::filesystem;

namespace {

constexpr const char* kRipple = "com.premation.samples.ripple";
constexpr const char* kRings = "com.premation.samples.rings";
constexpr const char* kDisplace = "com.premation.samples.checkout.displace";
constexpr const char* kEcho = "com.premation.samples.checkout.echo";

fs::path bundles() { return fs::path(PREMATION_PLUGIN_BUNDLES); }

fs::path temp_file(const std::string& name) {
  const fs::path p = fs::temp_directory_path() / ("premation-plugin-test-" + name);
  std::error_code ec;
  fs::remove(p, ec);
  return p;
}

pl::HostOptions options(bool attach = false, fs::path journal = {}) {
  pl::HostOptions o;
  o.searchPaths = {bundles()};
  o.journal = std::move(journal);
  o.threads = 2;
  o.attachToDocument = attach;
  o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
  return o;
}

std::vector<float> to_float(const pl::TexelImage& img) {
  PrWorld w{};
  std::vector<std::uint8_t> bytes;
  pl::texels_to_world(img.bytes, img.format, img.width, img.height, std::size_t{img.width} * pl::texel_bytes(img.format),
                      PR_PIXEL_FORMAT_RGBA32F, bytes);
  std::vector<float> out(bytes.size() / 4);
  std::memcpy(out.data(), bytes.data(), bytes.size());
  (void)w;
  return out;
}

pl::TexelImage pattern(pl::TexelFormat f, std::uint32_t w, std::uint32_t h, float shift = 0) {
  std::vector<float> px(std::size_t{w} * h * 4);
  for (std::uint32_t y = 0; y < h; ++y) {
    for (std::uint32_t x = 0; x < w; ++x) {
      const bool inside = x >= 4 && y >= 4 && x + 4 < w && y + 4 < h;
      const float a = inside ? 1.0F : 0.0F;
      float* p = &px[(std::size_t{y} * w + x) * 4];
      p[0] = a * std::fmod(static_cast<float>(x) / static_cast<float>(w) + shift, 1.0F);
      p[1] = a * static_cast<float>(y) / static_cast<float>(h);
      p[2] = a * static_cast<float>((x ^ y) & 7U) / 7.0F;
      p[3] = a;
    }
  }
  PrWorld world{};
  world.struct_size = sizeof(PrWorld);
  world.width = static_cast<std::int32_t>(w);
  world.height = static_cast<std::int32_t>(h);
  world.row_bytes = static_cast<std::int32_t>(w * 16);
  world.format = PR_PIXEL_FORMAT_RGBA32F;
  world.data = px.data();
  pl::TexelImage img;
  img.format = f;
  img.width = w;
  img.height = h;
  pl::world_to_texels(world, f, img.bytes);
  return img;
}

float max_diff(const std::vector<float>& a, const std::vector<float>& b) {
  REQUIRE(a.size() == b.size());
  float m = 0;
  for (std::size_t i = 0; i < a.size(); ++i) m = std::max(m, std::abs(a[i] - b[i]));
  return m;
}

pl::TexelFormat format_for(std::uint32_t bits) {
  return bits == 32 ? pl::TexelFormat::rgba32f : bits == 16 ? pl::TexelFormat::rgba16f : pl::TexelFormat::rgba8;
}

void set_param(pl::RenderInputs& in, const pl::EffectSpec& spec, std::uint32_t id, double v, std::size_t member = 0) {
  const int slot = pl::param_slot(spec, id);
  REQUIRE(slot >= 0);
  in.values.at(static_cast<std::size_t>(slot)).v.at(member) = v;
}

/// Run premation-plugins; its exit code.
int run_tool(const std::string& args) {
  std::string cmd = "\"" + std::string(PREMATION_PLUGINS_TOOL) + "\" --plugins \"" + bundles().string() + "\" " + args;
#if defined(_WIN32)
  cmd = "\"" + cmd + " >NUL 2>NUL\"";  // cmd.exe strips the outer quotes
  return std::system(cmd.c_str());     // NOLINT(concurrency-mt-unsafe, cert-env33-c): a test driving the tool
#else
  cmd += " >/dev/null 2>&1";
  const int status = std::system(cmd.c_str());  // NOLINT(concurrency-mt-unsafe, cert-env33-c): a test driving the tool
  if (status == -1) return -1;
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return WEXITSTATUS(status);
#endif
}

}  // namespace

TEST_CASE("plugin host: the sample bundles load and register with the document", "[plugins]") {
  pl::PluginHost host(options(true));
  const std::vector<pl::PluginRecord> recs = host.scan();
  REQUIRE(recs.size() >= 3);
  for (const char* id : {"com.premation.samples.ripple", "com.premation.samples.rings", "com.premation.samples.checkout"}) {
    const auto it = std::ranges::find_if(recs, [&](const pl::PluginRecord& r) { return r.id == id; });
    REQUIRE(it != recs.end());
    CHECK(it->status == pl::PluginStatus::loaded);
    CHECK(it->error.empty());
  }
  // Each effect is an ordinary document effect type now (addEffect / listEffects resolve it).
  for (const char* m : {kRipple, kRings, kDisplace, kEcho}) {
    const doc::NativeEffect* ne = doc::NativeEffects::find(m);
    REQUIRE(ne != nullptr);
    CHECK(doc::NativeEffects::available(m));
    CHECK(ne->category == "Premation Samples");
  }
  // Params in declaration order, keyed p<id>; groups carry their names.
  const pl::EffectSpec* ripple = host.effect(kRipple);
  REQUIRE(ripple != nullptr);
  CHECK(ripple->params.front().key == "p1");
  CHECK(ripple->params.front().name == "Center");
  const int tint = pl::param_slot(*ripple, 8);
  REQUIRE(tint >= 0);
  CHECK(ripple->params.at(static_cast<std::size_t>(tint)).group == "Tint");
  // Rings' button is exposed as an action on the document side.
  const doc::NativeEffect* rings = doc::NativeEffects::find(kRings);
  REQUIRE(rings != nullptr);
  CHECK(std::ranges::any_of(rings->actions, [](const auto& a) { return a.first == "p8"; }));
}

TEST_CASE("plugin host: a disabled plugin leaves new instances, keeps documents resolving", "[plugins]") {
  pl::PluginHost host(options(true));
  host.scan();
  REQUIRE(host.set_enabled("com.premation.samples.ripple", false));
  CHECK_FALSE(doc::NativeEffects::available(kRipple));
  CHECK(doc::NativeEffects::find(kRipple) != nullptr);  // an existing document still names the type
  const pl::EffectSpec* spec = host.effect(kRipple);
  REQUIRE(spec != nullptr);
  pl::TexelImage out;
  const pl::CallResult r = pl::run_native_cpu(host, pl::default_inputs(*spec, "L/fx", 16, 16, 8), pattern(pl::TexelFormat::rgba8, 16, 16), {}, out);
  CHECK_FALSE(r.ok);
  CHECK(r.skipped);
  REQUIRE(host.set_enabled("com.premation.samples.ripple", true));
  CHECK(doc::NativeEffects::available(kRipple));
  CHECK_FALSE(host.set_enabled("com.example.nope", true));
}

TEST_CASE("plugin host: ripple renders at 8, 16 and 32 bpc — deterministic, the same picture", "[plugins]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kRipple);
  REQUIRE(spec != nullptr);
  std::vector<std::vector<float>> results;
  for (const std::uint32_t bits : {8U, 16U, 32U}) {
    const pl::TexelImage input = pattern(format_for(bits), 48, 40);
    pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", 48, 40, bits);
    set_param(in, *spec, 1, 24);  // Center X (layer px)
    set_param(in, *spec, 1, 20, 1);
    pl::TexelImage a;
    pl::TexelImage b;
    REQUIRE(pl::run_native_cpu(host, in, input, {}, a).ok);
    REQUIRE(pl::run_native_cpu(host, in, input, {}, b).ok);
    CHECK(a.bytes == b.bytes);  // determinism: same inputs, same bytes
    CHECK(a.format == input.format);
    CHECK(a.bytes != input.bytes);  // the ripple moved pixels
    results.push_back(to_float(a));
  }
  // The depths agree to within their quantisation (8-bit: one step plus the bilinear taps).
  CHECK(max_diff(results[0], results[2]) <= 3.0F / 255.0F);
  CHECK(max_diff(results[1], results[2]) <= 2e-3F);
}

TEST_CASE("plugin host: parameters drive the render (the engine animates them per frame)", "[plugins]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::EffectSpec* spec = host.effect(kRipple);
  REQUIRE(spec != nullptr);
  const pl::TexelImage input = pattern(pl::TexelFormat::rgba32f, 32, 32);
  pl::RenderInputs in = pl::default_inputs(*spec, "L/fx", 32, 32, 32);
  set_param(in, *spec, 2, 0);  // Amplitude 0, tint off: identity
  pl::TexelImage still;
  REQUIRE(pl::run_native_cpu(host, in, input, {}, still).ok);
  CHECK(max_diff(to_float(still), to_float(input)) <= 1e-6F);
  // Two frames of an animated Phase → two different pictures.
  set_param(in, *spec, 2, 6);
  pl::TexelImage f0;
  pl::TexelImage f1;
  set_param(in, *spec, 4, 0);
  REQUIRE(pl::run_native_cpu(host, in, input, {}, f0).ok);
  set_param(in, *spec, 4, 90);
  REQUIRE(pl::run_native_cpu(host, in, input, {}, f1).ok);
  CHECK(f0.bytes != f1.bytes);
  // Tint on: the checkbox and colour reach the plugin.
  set_param(in, *spec, 7, 1);
  pl::TexelImage tinted;
  REQUIRE(pl::run_native_cpu(host, in, input, {}, tinted).ok);
  CHECK(tinted.bytes != f1.bytes);
}

TEST_CASE("plugin host: rings keeps its palette in the document's sequence data", "[plugins]") {
  pl::PluginHost host(options(true));
  host.scan();
  const pl::EffectSpec* spec = host.effect(kRings);
  REQUIRE(spec != nullptr);
  // addEffect: the instance's initial FLAT sequence data.
  const std::optional<std::vector<std::uint8_t>> seq = host.initial_sequence(kRings);
  REQUIRE(seq.has_value());
  REQUIRE_FALSE(seq->empty());
  CHECK(doc::NativeEffects::created(kRings) == seq);  // the document's hook reaches the host

  const pl::TexelImage input = pattern(pl::TexelFormat::rgba8, 40, 40);
  pl::RenderInputs in = pl::default_inputs(*spec, "L/rings", 40, 40, 8);
  in.sequence = *seq;
  pl::TexelImage before;
  REQUIRE(pl::run_native_cpu(host, in, input, {}, before).ok);

  // The Shuffle Palette button: USER_CHANGED_PARAM → new sequence data, one document edit.
  doc::NativeActionRequest req;
  req.layer = "L";
  req.effectId = "rings";
  req.type = kRings;
  req.action = "p8";
  req.params = premation::js::Json::object();
  req.sequence = *seq;
  const auto res = doc::NativeEffects::action(req);
  REQUIRE(std::holds_alternative<doc::NativeEdit>(res));
  const doc::NativeEdit& edit = std::get<doc::NativeEdit>(res);
  REQUIRE(edit.sequence.has_value());
  CHECK(*edit.sequence != *seq);

  // The frame is a function of the document: the new bytes render the new palette,
  // the old bytes still render the old one (undo).
  in.sequence = *edit.sequence;
  pl::TexelImage after;
  REQUIRE(pl::run_native_cpu(host, in, input, {}, after).ok);
  CHECK(after.bytes != before.bytes);
  in.sequence = *seq;
  pl::TexelImage undone;
  REQUIRE(pl::run_native_cpu(host, in, input, {}, undone).ok);
  CHECK(undone.bytes == before.bytes);
}

TEST_CASE("plugin host: checkouts — another layer, and the effect's own layer at other times", "[plugins]") {
  pl::PluginHost host(options());
  host.scan();
  const pl::TexelImage input = pattern(pl::TexelFormat::rgba32f, 32, 24);

  SECTION("Layer Displace checks out its Map Layer at the frame's time") {
    const pl::EffectSpec* spec = host.effect(kDisplace);
    REQUIRE(spec != nullptr);
    pl::RenderInputs in = pl::default_inputs(*spec, "L/d", 32, 24, 32);
    in.values.at(static_cast<std::size_t>(pl::param_slot(*spec, 1))).layer = "MAP";
    std::vector<pl::CheckoutRequest> reqs;
    REQUIRE(host.pre_render(in, reqs).ok);
    REQUIRE(reqs.size() == 2);
    CHECK(reqs[1].paramIndex == static_cast<std::uint32_t>(pl::param_slot(*spec, 1) + 1));
    CHECK(reqs[1].time == in.layerTime);

    pl::TexelImage without;
    REQUIRE(pl::run_native_cpu(host, in, input, {}, without).ok);
    CHECK(max_diff(to_float(without), to_float(input)) <= 1e-6F);  // no map: no displacement
    const pl::TexelImage map = pattern(pl::TexelFormat::rgba32f, 32, 24, 0.37F);
    pl::TexelImage with;
    REQUIRE(pl::run_native_cpu(host, in, input, [&](const pl::CheckoutRequest& c) { return c.paramIndex != 0 ? &map : nullptr; }, with).ok);
    CHECK(with.bytes != without.bytes);
  }

  SECTION("Time Echo checks out its own layer at earlier times") {
    const pl::EffectSpec* spec = host.effect(kEcho);
    REQUIRE(spec != nullptr);
    pl::RenderInputs in = pl::default_inputs(*spec, "L/e", 32, 24, 32);
    in.layerTime = PR_TIME_SCALE;  // 1 s
    std::vector<pl::CheckoutRequest> reqs;
    REQUIRE(host.pre_render(in, reqs).ok);
    REQUIRE(reqs.size() == 4);  // now + 3 echoes (the default)
    for (std::size_t k = 1; k < reqs.size(); ++k) {
      CHECK(reqs[k].paramIndex == 0);
      CHECK(reqs[k].time == in.layerTime - static_cast<std::int64_t>(k) * PR_TIME_SCALE / 10);
    }
  }
}

TEST_CASE("plugin host: the crash journal quarantines a plugin that died mid-call", "[plugins]") {
  const fs::path journal = temp_file("journal.bin");
  {
    // What an engine that died inside a selector leaves behind: a slot still set.
    std::string err;
    std::unique_ptr<pl::CrashJournal> j = pl::CrashJournal::open(journal, err);
    REQUIRE(j != nullptr);
    CHECK(j->enter("com.premation.samples.ripple", PR_CMD_SMART_RENDER) >= 0);
  }
  pl::PluginHost host(options(true, journal));
  const std::vector<pl::PluginRecord> recs = host.scan();
  const auto it = std::ranges::find_if(recs, [](const pl::PluginRecord& r) { return r.id == "com.premation.samples.ripple"; });
  REQUIRE(it != recs.end());
  CHECK(it->status == pl::PluginStatus::quarantined);
  CHECK_FALSE(doc::NativeEffects::available(kRipple));
  // The others are untouched; re-enabling the quarantined one loads it.
  CHECK(std::ranges::all_of(recs, [](const pl::PluginRecord& r) {
    return r.id == "com.premation.samples.ripple" || r.status == pl::PluginStatus::loaded;
  }));
  REQUIRE(host.set_enabled("com.premation.samples.ripple", true));
  const std::vector<pl::PluginRecord> now = host.plugins();
  const auto again = std::ranges::find_if(now, [](const pl::PluginRecord& r) { return r.id == "com.premation.samples.ripple"; });
  REQUIRE(again != now.end());
  CHECK(again->status == pl::PluginStatus::loaded);
}

TEST_CASE("plugin host: a plugin's own crash is contained (child process)", "[plugins]") {
  // sample_util.hpp Fault: 2 access violation · 3 divide by zero · 4 stack overflow · 5 C++ exception · 7 error return
  for (const int fault : {2, 3, 4, 5, 7}) {
    INFO("fault " << fault);
    CHECK(run_tool("crash-check com.premation.samples.ripple " + std::to_string(fault)) == 0);
  }
  CHECK(run_tool("crash-check com.premation.samples.checkout.displace 2") == 0);
  CHECK(run_tool("--bits 32 crash-check com.premation.samples.rings 5") == 0);
}

TEST_CASE("plugin host: a hang or an abort ends the process and quarantines the plugin", "[plugins]") {
  SECTION("hang: the watchdog ends the engine") {
    const fs::path journal = temp_file("hang.bin");
    const std::string j = "--journal \"" + journal.string() + "\" ";
    CHECK(run_tool(j + "--watchdog 300 crash-check com.premation.samples.ripple 6") == 86);
    CHECK(run_tool(j + "render com.premation.samples.ripple") == 1);                      // quarantined: not rendered
    CHECK(run_tool(j + "render com.premation.samples.rings") == 0);                       // the others still run
    CHECK(run_tool(j + "--enable com.premation.samples.ripple render com.premation.samples.ripple") == 0);  // re-enabled by the user
  }
#if !defined(_WIN32)
  SECTION("abort(): nothing in-process survives it; the next start quarantines") {
    const fs::path journal = temp_file("abort.bin");
    const std::string j = "--journal \"" + journal.string() + "\" ";
    CHECK(run_tool(j + "crash-check com.premation.samples.rings 8") != 0);
    CHECK(run_tool(j + "render com.premation.samples.rings") == 1);
  }
#endif
}
