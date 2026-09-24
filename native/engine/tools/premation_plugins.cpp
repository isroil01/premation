// premation-plugins — the native plugin host on its own (G1): list what a
// plugin folder loads to, render an effect on a test pattern, and prove crash
// isolation from the outside. The engine runs the same host in-process; this
// tool exists so plugin authors (and the host tests, which run it as a child
// process — a test framework's own fault handlers would otherwise see the
// injected faults first) can drive it without an editor.
//
//   premation-plugins [options] list
//   premation-plugins [options] render <matchName>
//   premation-plugins [options] crash-check <matchName> <fault>
//
// Options
//   --plugins <dir>      a bundle folder or a folder of bundles (repeatable;
//                        default: PREMATION_PLUGIN_PATH, ';'-separated)
//   --journal <file>     the crash journal (plugins that died last time are quarantined)
//   --watchdog <ms>      a call longer than this is a hang (default 10000)
//   --bits 8|16|32       the project's bit depth (default 8)
//   --size WxH           the test pattern's size (default 64x48)
//   --fault <n>          the samples' Debug ▸ Fault popup (1 = none … see sample_util.hpp)
//   --enable <pluginId>  setPluginEnabled(true) before the command (clears a quarantine)
//
// render prints `ok <fnv1a of the output texels>` or `fail <message>`.
// crash-check renders instance A with the fault and expects it CONTAINED (a
// fault is reported, A is disabled, the process lives), then renders instance
// B without it and expects pixels; prints `contained <kind>` and exits 0.
// A fault the guard cannot contain (abort, a hang) ends the process — which is
// the point: the journal then quarantines the plugin for the next run.
//
// Exit codes: 0 ok · 1 the check failed · 2 usage · 86 hang (the host's default).
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include "cpu_render.hpp"
#include "host.hpp"

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr std::uint32_t kFaultParamId = 901;  // sample_util.hpp kFaultParamId

struct Options {
  std::vector<fs::path> plugins;
  fs::path journal;
  int watchdogMs = 10000;
  std::uint32_t bits = 8;
  std::uint32_t w = 64;
  std::uint32_t h = 48;
  int fault = 1;
  std::vector<std::string> enable;
  std::vector<std::string> args;
};

int usage() {
  std::fputs("usage: premation-plugins [--plugins dir] [--journal file] [--watchdog ms] [--bits 8|16|32] [--size WxH]\n"
             "                         [--fault n] [--enable pluginId] list | render <matchName> | crash-check <matchName> <fault>\n",
             stderr);
  return 2;
}

pl::TexelFormat format_for(std::uint32_t bits) {
  return bits == 32 ? pl::TexelFormat::rgba32f : bits == 16 ? pl::TexelFormat::rgba16f : pl::TexelFormat::rgba8;
}

/// A premultiplied gradient with a transparent border — the host tests' pattern.
pl::TexelImage pattern(pl::TexelFormat f, std::uint32_t w, std::uint32_t h) {
  std::vector<float> px(std::size_t{w} * h * 4);
  for (std::uint32_t y = 0; y < h; ++y) {
    for (std::uint32_t x = 0; x < w; ++x) {
      const bool inside = x >= 4 && y >= 4 && x + 4 < w && y + 4 < h;
      const float a = inside ? 1.0F : 0.0F;
      float* p = &px[(std::size_t{y} * w + x) * 4];
      p[0] = a * static_cast<float>(x) / static_cast<float>(w);        // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      p[1] = a * static_cast<float>(y) / static_cast<float>(h);        // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      p[2] = a * static_cast<float>((x ^ y) & 7U) / 7.0F;              // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      p[3] = a;                                                        // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
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

std::uint64_t fnv1a(const std::vector<std::uint8_t>& bytes) {
  std::uint64_t x = 14695981039346656037ULL;
  for (const std::uint8_t b : bytes) {
    x ^= b;
    x *= 1099511628211ULL;
  }
  return x;
}

pl::RenderInputs inputs(const pl::EffectSpec& spec, const Options& o, const std::string& instance, int fault) {
  pl::RenderInputs in = pl::default_inputs(spec, instance, o.w, o.h, o.bits);
  if (const int slot = pl::param_slot(spec, kFaultParamId); slot >= 0) in.values.at(static_cast<std::size_t>(slot)).v[0] = fault;
  return in;
}

int list(pl::PluginHost& host) {
  for (const pl::PluginRecord& r : host.plugins()) {
    std::printf("%s\t%s\t%s", r.id.c_str(), std::string(pl::to_string(r.status)).c_str(), r.version.c_str());
    for (const std::string& e : r.effects) std::printf("\t%s", e.c_str());
    if (!r.error.empty()) std::printf("\t# %s", r.error.c_str());
    std::printf("\n");
  }
  return 0;
}

int render(pl::PluginHost& host, const Options& o, const std::string& matchName) {
  const pl::EffectSpec* spec = host.effect(matchName);
  if (spec == nullptr) {
    std::printf("fail no effect '%s'\n", matchName.c_str());
    return 1;
  }
  const pl::TexelImage input = pattern(format_for(o.bits), o.w, o.h);
  pl::TexelImage out;
  const pl::CallResult r = pl::run_native_cpu(host, inputs(*spec, o, "L/fx", o.fault), input, {}, out);
  if (!r.ok) {
    std::printf("fail %s%s\n", r.fault ? (std::string(pl::to_string(r.fault.kind)) + ": ").c_str() : "", r.message.c_str());
    return 1;
  }
  std::printf("ok %016llx\n", static_cast<unsigned long long>(fnv1a(out.bytes)));
  return 0;
}

int crash_check(pl::PluginHost& host, const Options& o, const std::string& matchName, int fault) {
  const pl::EffectSpec* spec = host.effect(matchName);
  if (spec == nullptr) {
    std::printf("fail no effect '%s'\n", matchName.c_str());
    return 1;
  }
  const pl::TexelImage input = pattern(format_for(o.bits), o.w, o.h);
  pl::TexelImage out;
  const pl::CallResult bad = pl::run_native_cpu(host, inputs(*spec, o, "A/fx", fault), input, {}, out);
  if (bad.ok) {
    std::printf("fail the faulting render succeeded\n");
    return 1;
  }
  std::string why;
  const bool disabled = host.instance_disabled("A/fx", &why);
  // A plugin's own error return is a failed call, not a crash: the instance stays enabled.
  const bool crashed = static_cast<bool>(bad.fault);
  if (crashed != disabled) {
    std::printf("fail fault=%d but instance disabled=%d (%s)\n", crashed ? 1 : 0, disabled ? 1 : 0, bad.message.c_str());
    return 1;
  }
  // The same instance is skipped from now on, without calling the plugin.
  if (crashed) {
    const pl::CallResult again = pl::run_native_cpu(host, inputs(*spec, o, "A/fx", 1), input, {}, out);
    if (again.ok || !again.skipped) {
      std::printf("fail a disabled instance rendered again\n");
      return 1;
    }
  }
  const pl::CallResult good = pl::run_native_cpu(host, inputs(*spec, o, "B/fx", 1), input, {}, out);
  if (!good.ok || out.bytes.empty()) {
    std::printf("fail another instance did not render after the fault: %s\n", good.message.c_str());
    return 1;
  }
  std::printf("contained %s\n", crashed ? std::string(pl::to_string(bad.fault.kind)).c_str() : "error-return");
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  Options o;
  const std::vector<std::string> a(argv + 1, argv + argc);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (std::size_t i = 0; i < a.size(); ++i) {
    const std::string& k = a[i];
    const auto next = [&]() -> const std::string* { return i + 1 < a.size() ? &a[++i] : nullptr; };
    if (k == "--plugins" || k == "--journal" || k == "--watchdog" || k == "--bits" || k == "--size" || k == "--fault" ||
        k == "--enable") {
      const std::string* v = next();
      if (v == nullptr) return usage();
      if (k == "--plugins") o.plugins.emplace_back(*v);
      else if (k == "--journal") o.journal = *v;
      else if (k == "--watchdog") o.watchdogMs = std::atoi(v->c_str());
      else if (k == "--bits") o.bits = static_cast<std::uint32_t>(std::atoi(v->c_str()));
      else if (k == "--fault") o.fault = std::atoi(v->c_str());
      else if (k == "--enable") o.enable.push_back(*v);
      else if (std::sscanf(v->c_str(), "%ux%u", &o.w, &o.h) != 2 || o.w == 0 || o.h == 0) return usage();
    } else {
      o.args.push_back(k);
    }
  }
  if (o.plugins.empty()) {
    if (const char* env = std::getenv("PREMATION_PLUGIN_PATH"); env != nullptr) {  // NOLINT(concurrency-mt-unsafe): before any thread
      std::string_view s(env);
      while (!s.empty()) {
        const std::size_t cut = s.find(';');
        if (cut != 0) o.plugins.emplace_back(std::string(s.substr(0, cut)));
        if (cut == std::string_view::npos) break;
        s.remove_prefix(cut + 1);
      }
    }
  }
  if (o.args.empty() || (o.bits != 8 && o.bits != 16 && o.bits != 32)) return usage();

  pl::HostOptions ho;
  ho.searchPaths = o.plugins;
  ho.journal = o.journal;
  ho.watchdog = std::chrono::milliseconds(o.watchdogMs);
  ho.threads = 2;
  ho.attachToDocument = false;
  pl::PluginHost host(std::move(ho));
  host.scan();
  for (const std::string& id : o.enable) (void)host.set_enabled(id, true);

  const std::string& cmd = o.args[0];
  if (cmd == "list" && o.args.size() == 1) return list(host);
  if (cmd == "render" && o.args.size() == 2) return render(host, o, o.args[1]);
  if (cmd == "crash-check" && o.args.size() == 3) return crash_check(host, o, o.args[1], std::atoi(o.args[2].c_str()));
  return usage();
}
