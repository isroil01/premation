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
//   premation-plugins [options] test <cases.json> [--bless]
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
// test renders each case of a plugin project's cases file on the CPU path and compares it with
// its golden (<cases dir>/golden/<name>.pgold, float RGBA). --bless writes the goldens instead.
// The cases file:
//   { "cases": [ { "name": "default", "effect": "<matchName>",
//                  "bits": 32, "size": [64, 48], "time": 0.5,            (defaults: 32, 64x48, 0 s)
//                  "params": { "3": 12, "5": [1, 0.5, 0, 1] },           (by SDK param id: v[0] or v[0..3])
//                  "tolerance": 1e-4 } ] }                              (default by bits: 1/255, 1e-3, 1e-4)
// A simulation (PR_OUT_FLAG_STATEFUL) steps from frame 0 to `time` × 30 before it renders.
// Prints `pass|fail|blessed <name> ...` per case; a fail also writes <name>.actual.pgold beside the golden.
//
// Exit codes: 0 ok · 1 the check failed · 2 usage · 86 hang (the host's default).
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "cpu_render.hpp"
#include "host.hpp"
#include "json.hpp"

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
  bool bless = false;
  std::vector<std::string> args;
};

int usage() {
  std::fputs("usage: premation-plugins [--plugins dir] [--journal file] [--watchdog ms] [--bits 8|16|32] [--size WxH]\n"
             "                         [--fault n] [--enable pluginId] list | render <matchName> | crash-check <matchName> <fault>\n"
             "                         | test <cases.json> [--bless]\n",
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

// ── test: a plugin project's golden renders ─────────────────────────────

struct Golden {
  std::uint32_t w = 0, h = 0;
  std::vector<float> rgba;
};

std::optional<Golden> read_golden(const fs::path& file) {
  std::ifstream f(file, std::ios::binary);
  if (!f) return std::nullopt;
  std::string magic;
  Golden g;
  f >> magic >> g.w >> g.h;
  if (magic != "PGOLD1" || g.w == 0 || g.h == 0 || f.get() != '\n') return std::nullopt;
  g.rgba.resize(std::size_t{g.w} * g.h * 4);
  f.read(reinterpret_cast<char*>(g.rgba.data()), static_cast<std::streamsize>(g.rgba.size() * sizeof(float)));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): raw float file
  if (!f) return std::nullopt;
  return g;
}

bool write_golden(const fs::path& file, const Golden& g) {
  std::error_code ec;
  fs::create_directories(file.parent_path(), ec);
  const fs::path tmp = fs::path(file).concat(".tmp");
  {
    std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f << "PGOLD1 " << g.w << ' ' << g.h << '\n';
    f.write(reinterpret_cast<const char*>(g.rgba.data()), static_cast<std::streamsize>(g.rgba.size() * sizeof(float)));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): raw float file
    if (!f) return false;
  }
  fs::rename(tmp, file, ec);  // temp + rename: a failed write never leaves half a golden
  return !ec;
}

int test(pl::PluginHost& host, const Options& o, const fs::path& casesFile) {
  std::ifstream in(casesFile, std::ios::binary);
  if (!in) {
    std::printf("fail cannot read %s\n", casesFile.string().c_str());
    return 1;
  }
  std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (text.starts_with("\xEF\xBB\xBF")) text.erase(0, 3);  // Windows editors (and PowerShell 5) write a UTF-8 BOM
  const auto doc = premation::js::parse(text);
  if (!doc || !doc->at("cases").is_array()) {
    std::printf("fail %s: expected { \"cases\": [ ... ] }\n", casesFile.string().c_str());
    return 1;
  }
  const fs::path goldenDir = casesFile.parent_path() / "golden";
  int failed = 0;
  int count = 0;
  for (const premation::js::Json& c : doc->at("cases").arr()) {
    ++count;
    const std::string name = c.string_at("name").value_or("case" + std::to_string(count));
    const auto fail = [&](const std::string& why) {
      std::printf("fail %s %s\n", name.c_str(), why.c_str());
      ++failed;
    };
    const std::string effect = c.string_at("effect").value_or("");
    const pl::EffectSpec* spec = host.effect(effect);
    if (spec == nullptr) {
      fail("no effect '" + effect + "' (is its bundle under --plugins, and loaded?)");
      continue;
    }
    const auto bits = static_cast<std::uint32_t>(c.number_at("bits").value_or(32));
    if (bits != 8 && bits != 16 && bits != 32) {
      fail("bits must be 8, 16 or 32");
      continue;
    }
    std::uint32_t w = 64;
    std::uint32_t h = 48;
    if (const premation::js::Json& sz = c.at("size"); sz.is_array() && sz.arr().size() == 2) {
      w = static_cast<std::uint32_t>(std::clamp(sz.arr()[0].num(), 1.0, 8192.0));
      h = static_cast<std::uint32_t>(std::clamp(sz.arr()[1].num(), 1.0, 8192.0));
    }
    pl::RenderInputs ri = pl::default_inputs(*spec, "T/" + name, w, h, bits);
    ri.layerTime = ri.compTime = static_cast<std::int64_t>(std::llround(c.number_at("time").value_or(0.0) * PR_TIME_SCALE));
    bool badParam = false;
    if (const premation::js::Json& ps = c.at("params"); ps.is_object()) {
      for (const premation::js::Json::Member& m : ps.obj()) {
        const int slot = pl::param_slot(*spec, static_cast<std::uint32_t>(std::strtoul(m.key.c_str(), nullptr, 10)));
        if (slot < 0) {
          fail("no param with id " + m.key);
          badParam = true;
          break;
        }
        auto& v = ri.values.at(static_cast<std::size_t>(slot)).v;
        if (m.value.is_number()) {
          v[0] = m.value.num();
        } else if (m.value.is_bool()) {
          v[0] = m.value.b() ? 1.0 : 0.0;
        } else if (m.value.is_array()) {
          for (std::size_t k = 0; k < std::min<std::size_t>(4, m.value.arr().size()); ++k) v.at(k) = m.value.arr()[k].num();
        }
      }
    }
    if (badParam) continue;

    // SDK 1.4: a simulation steps from its frame 0 to the case's frame (time at 30 fps), its params
    // held at the case's values, and renders with that state.
    if (spec->has(PR_OUT_FLAG_STATEFUL)) {
      pl::SimRequest q;
      q.base = ri;
      q.step = PR_TIME_SCALE / 30;
      q.frame = (ri.layerTime + q.step / 2) / q.step;
      q.inputsKey = 1;
      q.inputsAt = [&ri, &q](std::int64_t k) {
        pl::RenderInputs at = ri;
        at.layerTime = k * q.step;
        return at;
      };
      std::string why;
      ri.simState = host.sim_state(q, why);
      if (!ri.simState) {
        fail("simulation: " + why);
        continue;
      }
    }
    const pl::TexelImage input = pattern(format_for(bits), w, h);
    pl::TexelImage out;
    const pl::CallResult r = pl::run_native_cpu(host, ri, input, {}, out);
    if (!r.ok) {
      fail((r.fault ? std::string(pl::to_string(r.fault.kind)) + ": " : std::string()) + r.message);
      continue;
    }
    Golden actual;
    actual.w = out.width;
    actual.h = out.height;
    std::vector<std::uint8_t> floats;
    pl::texels_to_world(out.bytes, out.format, out.width, out.height, std::size_t{out.width} * pl::texel_bytes(out.format),
                        PR_PIXEL_FORMAT_RGBA32F, floats);
    actual.rgba.resize(floats.size() / sizeof(float));
    std::memcpy(actual.rgba.data(), floats.data(), actual.rgba.size() * sizeof(float));

    const fs::path file = goldenDir / (name + ".pgold");
    if (o.bless) {
      if (write_golden(file, actual)) std::printf("blessed %s %ux%u\n", name.c_str(), actual.w, actual.h);
      else fail("cannot write " + file.string());
      continue;
    }
    const std::optional<Golden> want = read_golden(file);
    if (!want) {
      fail("no golden at " + file.string() + " (run with --bless to create it)");
      continue;
    }
    if (want->w != actual.w || want->h != actual.h) {
      fail("size " + std::to_string(actual.w) + "x" + std::to_string(actual.h) + " but the golden is " + std::to_string(want->w) +
           "x" + std::to_string(want->h));
      (void)write_golden(goldenDir / (name + ".actual.pgold"), actual);
      continue;
    }
    const double tol = c.number_at("tolerance").value_or(bits == 8 ? 1.01 / 255.0 : bits == 16 ? 1e-3 : 1e-4);
    double maxDiff = 0;
    bool nonFinite = false;
    for (std::size_t i = 0; i < actual.rgba.size(); ++i) {
      if (!std::isfinite(actual.rgba[i])) nonFinite = true;
      maxDiff = std::max(maxDiff, static_cast<double>(std::abs(actual.rgba[i] - want->rgba[i])));
    }
    if (!nonFinite && maxDiff <= tol) {
      std::printf("pass %s max|diff| %.3g\n", name.c_str(), maxDiff);
      continue;
    }
    std::ostringstream why;
    if (nonFinite) why << "the output has NaN or infinity";
    else why << "max |diff| " << maxDiff << " > tolerance " << tol;
    fail(why.str());
    (void)write_golden(goldenDir / (name + ".actual.pgold"), actual);
  }
  if (count == 0) {
    std::printf("fail %s has no cases\n", casesFile.string().c_str());
    return 1;
  }
  std::printf("%d of %d case(s) %s\n", count - failed, count, o.bless ? "blessed" : "passed");
  return failed == 0 ? 0 : 1;
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
    } else if (k == "--bless") {
      o.bless = true;
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
  if (cmd == "test" && o.args.size() == 2) return test(host, o, fs::path(o.args[1]));
  return usage();
}
