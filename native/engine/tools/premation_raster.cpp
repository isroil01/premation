// premation-raster — the E3 text / vector raster parity harness
// (docs/NATIVE_CORE_PLAN.md E3, native/engine/src/raster).
//
// Reads the RenderFrameFiles the render-tests webgpu pass exports; for every
// text / vector raster the harness recorded (RenderFrameFile.rasters) it draws
// the raster in C++ and compares it with the TS texels of the same texture:
//
//   replay   the recorded Canvas2D call log on the C++ Canvas2D (rasterisation parity)
//   native   the C++ painters from the raster's source spec (layout + rasterisation)
//
//   premation-raster --batch <scenes> --fonts <fonts.json> [--mode replay|native]
//                    [--report r.json] [--only a,b] [--diff <dir>] [--emit <dir>]
//                    [--glyphs freetype|platform]
//   premation-raster --bench <scenes> --fonts <fonts.json> [--iterations N] [--threads N]
//
// --emit writes every frame file again with the C++ rasters substituted for the
// TS texels, so `premation-render` can gate whole frames drawn with C++ rasters.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "engine_api.hpp"
#include "png_write.hpp"
#include "premation/protocol/wire.hpp"
#include "raster/canvas_replay.hpp"
#include "raster/fonts.hpp"
#include "raster/raster_source.hpp"

namespace fs = std::filesystem;
using premation::api::RenderFrameFile;
namespace rs = premation::raster;

namespace {

bool read_file(const fs::path& p, std::vector<std::uint8_t>& out) {
  std::ifstream in(p, std::ios::binary);
  if (!in) return false;
  out.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  return true;
}

bool decode(const fs::path& p, RenderFrameFile& f, std::string& err) {
  std::vector<std::uint8_t> bytes;
  if (!read_file(p, bytes)) {
    err = "cannot read " + p.string();
    return false;
  }
  premation::wire::Reader r(bytes);
  const auto s = premation::api::decode(r, f);
  if (s != premation::wire::Status::ok) {
    err = std::string("RenderFrameFile: ") + std::string(premation::wire::to_string(s));
    return false;
  }
  return true;
}

std::string json_escape(std::string_view s) {
  std::string o;
  for (const char c : s) {
    if (c == '"' || c == '\\') { o.push_back('\\'); o.push_back(c); }
    else if (static_cast<unsigned char>(c) < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }  // NOLINT
    else o.push_back(c);
  }
  return o;
}

/// Pixel agreement of two premultiplied RGBA8 images of the same size.
struct Compare {
  bool sameSize = false;
  int maxDelta = 0;
  /// Pixels with any channel differing by more than 1/255 (the gate's "ink"
  /// threshold is looser; this is the byte-level view).
  std::size_t over1 = 0;
  /// Pixels with any channel differing by more than 16/255 — a visible difference.
  std::size_t over16 = 0;
  std::size_t pixels = 0;
  std::size_t inked = 0;
  double meanAbs = 0.0;
};

Compare compare(const std::vector<std::uint8_t>& a, const std::vector<std::uint8_t>& b) {
  Compare c;
  if (a.size() != b.size()) return c;
  c.sameSize = true;
  c.pixels = a.size() / 4;
  double sum = 0;
  for (std::size_t i = 0; i < a.size(); i += 4) {
    int m = 0;
    for (std::size_t k = 0; k < 4; ++k) {
      const int d = std::abs(static_cast<int>(a[i + k]) - static_cast<int>(b[i + k]));
      m = std::max(m, d);
      sum += d;
    }
    if (a[i + 3] != 0 || b[i + 3] != 0) ++c.inked;
    c.maxDelta = std::max(c.maxDelta, m);
    if (m > 1) ++c.over1;
    if (m > 16) ++c.over16;
  }
  c.meanAbs = sum / static_cast<double>(std::max<std::size_t>(1, a.size()));
  return c;
}

std::string family_of(std::string_view scene) {
  static const std::pair<std::string_view, std::string_view> kFam[] = {  // NOLINT(cppcoreguidelines-avoid-c-arrays)
      {"text-", "text"}, {"hires-", "text"}, {"shape-", "shapes"}, {"stroke-", "strokes"}, {"paint-", "paint"},
      {"svg-", "svg"}, {"blend-", "blend (shape layers)"}, {"effect-", "effects (shape layers)"},
      {"mask-", "masks"}, {"matte-", "masks"}, {"alpha-", "alpha"}, {"three-d-", "3D"}, {"ext-", "3D"},
  };
  for (const auto& [p, f] : kFam) {
    if (scene.substr(0, p.size()) == p) return std::string(f);
  }
  return "other";
}

/// Every font family a raster source names: the painters' font strings are
/// `…px "<family>", Inter, system-ui, sans-serif`, so the generics are always in.
std::set<std::string> families_in(std::string_view specJson, std::string_view opsJson) {
  std::set<std::string> out{"Inter", "system-ui", "sans-serif"};
  const auto scan = [&out](std::string_view s, std::string_view key) {
    std::size_t at = 0;
    while ((at = s.find(key, at)) != std::string_view::npos) {
      at += key.size();
      const auto end = s.find('"', at);
      if (end == std::string_view::npos) break;
      out.insert(std::string(s.substr(at, end - at)));
      at = end;
    }
  };
  scan(specJson, "\"fontFamily\":\"");
  scan(opsJson, "px \\\"");  // "set","font","600 56px \"Arial\", …"
  return out;
}

struct Options {
  fs::path batch;
  fs::path fonts;
  fs::path report;
  fs::path diffDir;
  fs::path emitDir;
  std::set<std::string> only;
  std::string mode = "replay";
  rs::GlyphBackend glyphs = rs::GlyphBackend::freetype;
  bool bench = false;
  int iterations = 5;
  int threads = 0;  // --bench worker count (0 = hardware threads)
  int hinting = -1;  // -1 = FontOptions default
  bool lcd = false;
  /// "chromium" (FontOptions::chromium_windows + LCD surface geometry) or
  /// "portable" (FreeType, the knobs below).
  std::string profile = "portable";
};

void write_png(const fs::path& p, std::uint32_t w, std::uint32_t h, const std::vector<std::uint8_t>& rgba) {
  fs::create_directories(p.parent_path());
  const auto bytes = premation::tools::encode_png(w, h, rgba);
  std::ofstream out(p, std::ios::binary);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

/// FNV-1a over the bytes — frameSceneExport.ts contentHash, so an emitted blob hashes like a TS one.
std::string content_hash(std::uint32_t w, std::uint32_t h, std::string_view format, const std::vector<std::uint8_t>& d) {
  std::uint32_t h1 = 0x811c9dc5U;
  std::uint32_t h2 = 0x01000193U ^ w ^ (h << 16U);
  for (std::size_t i = 0; i < d.size(); ++i) {
    h1 = (h1 ^ d[i]) * 0x01000193U;
    h2 = (h2 ^ d[i] ^ static_cast<std::uint32_t>(i & 0xFFU)) * 0x01000193U;
  }
  char buf[64];  // NOLINT(cppcoreguidelines-avoid-c-arrays)
  std::snprintf(buf, sizeof buf, "%08x%08x", h1, h2);  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return std::string(format) + ":" + std::to_string(w) + "x" + std::to_string(h) + ":" + buf + ":" + std::to_string(d.size());
}

int run(const Options& o) {
  rs::FontOptions fo;
  if (o.profile == "chromium") {
    fo = rs::FontOptions::chromium_windows();
  } else {
    fo.backend = o.glyphs;
    fo.lcdEdging = o.lcd;
  }
  if (o.hinting >= 0) fo.hinting = o.hinting;
  rs::FontSet fonts(fo);
  if (!o.fonts.empty()) {
    std::string err;
    if (!fonts.load_manifest(o.fonts, err)) {
      std::fprintf(stderr, "fonts: %s\n", err.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
      return 2;
    }
  }
  rs::CanvasOptions copts;
  copts.fonts = &fonts;
  copts.lcdGeometry = o.lcd || o.profile == "chromium";

  std::vector<fs::path> files;
  for (const auto& dir : fs::directory_iterator(o.batch)) {
    if (!dir.is_directory()) continue;
    const std::string scene = dir.path().filename().string();
    if (!o.only.empty() && o.only.count(scene) == 0) continue;
    for (const auto& f : fs::directory_iterator(dir.path())) {
      if (f.path().extension() == ".pfs") files.push_back(f.path());
    }
  }
  std::sort(files.begin(), files.end());

  std::ostringstream rep;
  rep << "{\"mode\":\"" << o.mode << "\",\"glyphs\":\"" << (o.glyphs == rs::GlyphBackend::platform ? "platform" : "freetype")
      << "\",\"rasters\":[";
  bool first = true;
  struct Fam {
    int rasters = 0;
    int identical = 0;
    int within1 = 0;
    int visible = 0;  // any pixel > 16/255 off
    int skipped = 0;
    double worstOver16 = 0;
  };
  std::map<std::string, Fam> fams;
  std::map<std::string, int> unsupported;
  double worstMeasure = 0;
  std::size_t measures = 0;
  std::size_t measuresExact = 0;
  double totalMs = 0;
  int total = 0;
  std::set<std::string> systemTried;

  for (const auto& path : files) {
    RenderFrameFile file;
    std::string err;
    if (!decode(path, file, err)) {
      std::fprintf(stderr, "%s: %s\n", path.string().c_str(), err.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
      continue;
    }
    const std::string scene = path.parent_path().filename().string();
    const std::string frame = path.stem().string();
    bool emitted = false;
    for (const auto& r : file.rasters) {
      const auto ref = std::find_if(file.textures.begin(), file.textures.end(), [&](const auto& t) { return t.key == r.key; });
      const premation::api::RenderBlob* blob = nullptr;
      if (ref != file.textures.end()) {
        for (const auto& b : file.blobs) {
          if (b.hash == ref->hash) blob = &b;
        }
      }
      Fam& fam = fams[family_of(scene)];
      ++fam.rasters;
      ++total;
      const std::string id = scene + "#" + frame + ":" + r.key;
      if (blob == nullptr || (blob->format != premation::api::RenderTextureFormat::rgba8unorm &&
                                 blob->format != premation::api::RenderTextureFormat::rgba8unorm_srgb)) {
        ++fam.skipped;
        continue;
      }
      // Families the raster names that no manifest face provides resolve
      // through the system fonts, as Chromium's font fallback did.
      for (const auto& family : families_in(r.spec_json, r.ops_json)) {
        if (systemTried.insert(family).second) (void)fonts.add_system_family(family);
      }
      const auto t0 = std::chrono::steady_clock::now();
      rs::RasterOutput out;
      if (o.mode == "native") {
        out = rs::draw_raster_source(r.kind == premation::api::RenderRasterKind::text ? rs::RasterKind::text
                                     : r.kind == premation::api::RenderRasterKind::mask ? rs::RasterKind::mask
                                                                                         : rs::RasterKind::path,
                                     r.spec_json, r.resolution_scale, r.padding, copts);
      } else {
        const rs::ReplayResult rr = rs::replay_canvas_ops(r.ops_json, copts);
        out.ok = rr.ok;
        out.error = rr.error;
        out.width = rr.width;
        out.height = rr.height;
        out.rgba = rr.rgba;
        out.unsupported = rr.unsupported;
        for (const auto& m : rr.measures) {
          ++measures;
          if (m.maxDelta == 0) ++measuresExact;
          worstMeasure = std::max(worstMeasure, m.maxDelta);
        }
      }
      const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
      totalMs += ms;
      for (const auto& u : out.unsupported) ++unsupported[u];
      Compare c;
      if (out.ok) c = compare(out.rgba, blob->pixels);
      // Not ported: a replay of a recording that read pixels back, or a native
      // draw that hit a feature the C++ painters do not implement (both counted,
      // never compared, and never substituted by --emit).
      const bool incomplete = (!r.incomplete.empty() && o.mode == "replay") || (o.mode == "native" && !out.unsupported.empty());
      if (!out.ok || incomplete) ++fam.skipped;
      else {
        if (c.sameSize && c.maxDelta == 0) ++fam.identical;
        if (c.sameSize && c.maxDelta <= 1) ++fam.within1;
        const double v = c.sameSize ? static_cast<double>(c.over16) / static_cast<double>(std::max<std::size_t>(1, c.inked)) : 1.0;
        if (!c.sameSize || c.over16 > 0) ++fam.visible;
        fam.worstOver16 = std::max(fam.worstOver16, v);
      }
      if (!o.diffDir.empty() && out.ok) {
        const fs::path base = o.diffDir / scene / (frame + "-" + r.key.substr(0, r.key.find(':')) + "-" + r.key.substr(r.key.find(':') + 1));
        write_png(base.string() + ".cxx.png", out.width, out.height, out.rgba);
        write_png(base.string() + ".ts.png", blob->width, blob->height, blob->pixels);
      }
      if (!o.emitDir.empty() && out.ok && !incomplete && out.width == blob->width && out.height == blob->height) {
        // Substitute: a new blob for this key (another key may share the TS one).
        premation::api::RenderBlob nb = *blob;
        nb.pixels = out.rgba;
        nb.hash = content_hash(nb.width, nb.height, "rgba8unorm", nb.pixels) + ":cxx";
        ref->hash = nb.hash;
        file.blobs.push_back(std::move(nb));
        emitted = true;
      }
      if (!first) rep << ",";
      first = false;
      rep << "{\"id\":\"" << json_escape(id) << "\",\"kind\":" << static_cast<int>(r.kind) << ",\"ok\":" << (out.ok ? "true" : "false")
          << ",\"error\":\"" << json_escape(out.error) << "\",\"incomplete\":\"" << json_escape(r.incomplete)
          << "\",\"size\":[" << blob->width << "," << blob->height << "],\"sameSize\":" << (c.sameSize ? "true" : "false")
          << ",\"maxDelta\":" << c.maxDelta << ",\"over1\":" << c.over1 << ",\"over16\":" << c.over16
          << ",\"inked\":" << c.inked << ",\"meanAbs\":" << c.meanAbs << ",\"ms\":" << ms << "}";
    }
    // Only frames that carry at least one C++ raster are written: the rest are
    // the native backend's frames unchanged.
    if (!o.emitDir.empty() && emitted) {
      premation::wire::Writer w;
      premation::api::encode(w, file);
      const fs::path outp = o.emitDir / scene / path.filename();
      fs::create_directories(outp.parent_path());
      std::ofstream of(outp, std::ios::binary);
      const auto bytes = w.bytes();
      of.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    }
  }
  rep << "],\"families\":{";
  bool ff = true;
  std::printf("premation-raster (%s, profile %s, glyphs %s): %d raster(s), %.1f ms total\n", o.mode.c_str(),  // NOLINT(cppcoreguidelines-pro-type-vararg)
              o.profile.c_str(), fo.backend == rs::GlyphBackend::platform ? "platform" : "freetype", total, totalMs);
  std::printf("  family                     rasters  identical  <=1/255  visible-diff  skipped  worst>16/255\n");  // NOLINT(cppcoreguidelines-pro-type-vararg)
  for (const auto& [name, f] : fams) {
    std::printf("  %-26s %7d  %9d  %7d  %12d  %7d  %10.4f%%\n", name.c_str(), f.rasters, f.identical, f.within1, f.visible,  // NOLINT(cppcoreguidelines-pro-type-vararg)
                f.skipped, f.worstOver16 * 100.0);
    if (!ff) rep << ",";
    ff = false;
    rep << "\"" << json_escape(name) << "\":{\"rasters\":" << f.rasters << ",\"identical\":" << f.identical
        << ",\"within1\":" << f.within1 << ",\"visible\":" << f.visible << ",\"skipped\":" << f.skipped
        << ",\"worstOver16\":" << f.worstOver16 << "}";
  }
  rep << "},\"measures\":{\"count\":" << measures << ",\"exact\":" << measuresExact << ",\"worst\":" << worstMeasure << "}}";
  if (measures > 0) {
    std::printf("  measureText: %zu call(s), %zu exact, worst |TS - C++| %.6f px\n", measures, measuresExact, worstMeasure);  // NOLINT(cppcoreguidelines-pro-type-vararg)
  }
  for (const auto& [u, nn] : unsupported) std::printf("  unsupported: %4d  %s\n", nn, u.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
  if (!o.report.empty()) {
    std::ofstream out(o.report, std::ios::binary);
    out << rep.str();
  }
  return 0;
}

}  // namespace

int measure_cmd(int argc, char** argv);

/// --bench: time the C++ painters (native mode, Chromium profile on Windows) on
/// every raster of every frame file under DIR/<scene>/, per scene, as ms per
/// frame — sequentially, then spread over `threads` workers (the engine can
/// rasterise layers in parallel; the TS Canvas2D path cannot).
int bench_cmd(const Options& o) {
  rs::FontOptions fo = o.profile == "portable" ? rs::FontOptions{} : rs::FontOptions::chromium_windows();
  rs::FontSet fonts(fo);
  std::string err;
  if (!fonts.load_manifest(o.fonts, err)) {
    std::fprintf(stderr, "fonts: %s\n", err.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 2;
  }
  for (const char* g : {"Inter", "system-ui", "sans-serif"}) (void)fonts.add_system_family(g);
  rs::CanvasOptions copts;
  copts.fonts = &fonts;
  copts.lcdGeometry = o.profile != "portable";
  std::printf("{\"scenes\":[");  // NOLINT(cppcoreguidelines-pro-type-vararg)
  bool firstScene = true;
  for (const auto& dir : fs::directory_iterator(o.batch)) {
    if (!dir.is_directory()) continue;
    struct Job {
      rs::RasterKind kind;
      std::string spec;
      double scale, pad;
    };
    std::vector<std::vector<Job>> frames;
    for (const auto& f : fs::directory_iterator(dir.path())) {
      if (f.path().extension() != ".pfs") continue;
      RenderFrameFile file;
      if (!decode(f.path(), file, err)) continue;
      std::vector<Job> jobs;
      for (const auto& r : file.rasters) {
        jobs.push_back({r.kind == premation::api::RenderRasterKind::text ? rs::RasterKind::text
                        : r.kind == premation::api::RenderRasterKind::mask ? rs::RasterKind::mask : rs::RasterKind::path,
                        r.spec_json, r.resolution_scale, r.padding});
      }
      frames.push_back(std::move(jobs));
    }
    if (frames.empty()) continue;
    const auto runOnce = [&](const std::vector<Job>& jobs, int threads) {
      std::atomic<std::size_t> next{0};
      const auto worker = [&] {
        for (std::size_t i = next++; i < jobs.size(); i = next++) {
          const auto out = rs::draw_raster_source(jobs[i].kind, jobs[i].spec, jobs[i].scale, jobs[i].pad, copts);
          (void)out;
        }
      };
      if (threads <= 1) {
        worker();
        return;
      }
      std::vector<std::thread> pool;
      for (int t = 0; t < threads; ++t) pool.emplace_back(worker);
      for (auto& t : pool) t.join();
    };
    // Warm-up (fonts, strike caches), then timed passes over every frame.
    for (const auto& jobs : frames) runOnce(jobs, 1);
    const auto timeIt = [&](int threads) {
      std::vector<double> perFrame;
      for (int it = 0; it < o.iterations; ++it) {
        for (const auto& jobs : frames) {
          const auto t0 = std::chrono::steady_clock::now();
          runOnce(jobs, threads);
          perFrame.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
        }
      }
      std::sort(perFrame.begin(), perFrame.end());
      double sum = 0;
      for (const double v : perFrame) sum += v;
      return std::make_pair(sum / static_cast<double>(perFrame.size()), perFrame[perFrame.size() / 2]);
    };
    const auto [seqMean, seqP50] = timeIt(1);
    const int hw = o.threads > 0 ? o.threads : static_cast<int>(std::max(1U, std::thread::hardware_concurrency()));
    const auto [parMean, parP50] = timeIt(hw);
    std::printf("%s{\"scene\":\"%s\",\"frames\":%zu,\"rastersPerFrame\":%zu,\"seqMeanMs\":%.4f,\"seqP50Ms\":%.4f,"  // NOLINT(cppcoreguidelines-pro-type-vararg)
                "\"threads\":%d,\"parMeanMs\":%.4f,\"parP50Ms\":%.4f}",
                firstScene ? "" : ",", dir.path().filename().string().c_str(), frames.size(), frames.front().size(), seqMean,
                seqP50, hw, parMean, parP50);
    firstScene = false;
  }
  std::printf("]}\n");  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return 0;
}

int main(int argc, char** argv) {
  if (argc >= 4 && (std::string_view(argv[1]) == "--measure" || std::string_view(argv[1]) == "--probe")) return measure_cmd(argc, argv);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  Options o;
  for (int i = 1; i < argc; ++i) {
    const std::string_view k = argv[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const std::string v = i + 1 < argc ? std::string(argv[i + 1]) : std::string();  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (k == "--batch") { o.batch = v; ++i; }
    else if (k == "--fonts") { o.fonts = v; ++i; }
    else if (k == "--report") { o.report = v; ++i; }
    else if (k == "--diff") { o.diffDir = v; ++i; }
    else if (k == "--emit") { o.emitDir = v; ++i; }
    else if (k == "--mode") { o.mode = v; ++i; }
    else if (k == "--hinting") { o.hinting = std::stoi(v); ++i; }
    else if (k == "--lcd") { o.lcd = v == "1"; ++i; }
    else if (k == "--profile") { o.profile = v; ++i; }
    else if (k == "--bench") { o.batch = v; o.bench = true; ++i; }
    else if (k == "--iterations") { o.iterations = std::stoi(v); ++i; }
    else if (k == "--threads") { o.threads = std::stoi(v); ++i; }
    else if (k == "--glyphs") { o.glyphs = v == "platform" ? rs::GlyphBackend::platform : rs::GlyphBackend::freetype; ++i; }
    else if (k == "--only") {
      std::stringstream ss(v);
      std::string item;
      while (std::getline(ss, item, ',')) o.only.insert(item);
      ++i;
    } else {
      std::fprintf(stderr, "usage: premation-raster --batch DIR --fonts fonts.json [--mode replay|native] [--report F] [--only a,b] [--diff DIR] [--emit DIR] [--glyphs freetype|platform]\n");  // NOLINT(cppcoreguidelines-pro-type-vararg)
      return 2;
    }
  }
  if (o.batch.empty()) {
    std::fprintf(stderr, "premation-raster: --batch is required\n");  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 2;
  }
  return o.bench ? bench_cmd(o) : run(o);
}

/// Debug: premation-raster --measure <fonts.json> <css font> <text>
///        premation-raster --probe <fonts.json> <ops.json> <row> <x0> <x1> [glyphs] [hinting]
///        (replays an op log and prints canvas 0's alpha along one row)
int measure_cmd(int argc, char** argv) {
  if (std::string_view(argv[1]) == "--probe" && argc >= 7) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    rs::FontOptions fo;
    if (argc > 7) fo.backend = std::string_view(argv[7]) == "platform" ? rs::GlyphBackend::platform : rs::GlyphBackend::freetype;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (argc > 8) fo.hinting = std::stoi(argv[8]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (argc > 9) fo.subpixelPositioning = std::string_view(argv[9]) == "1";  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (argc > 11) fo.lcdEdging = std::string_view(argv[11]) == "1";  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    rs::FontSet fonts(fo);
    std::string err;
    if (!fonts.load_manifest(argv[2], err)) return 2;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::ifstream in(argv[3], std::ios::binary);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const std::string ops((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    rs::CanvasOptions co;
    co.fonts = &fonts;
    co.lcdGeometry = argc > 10 && std::string_view(argv[10]) == "1";  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const auto r = rs::replay_canvas_ops(ops, co);
    const int row = std::stoi(argv[4]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    for (int x = std::stoi(argv[5]); x < std::stoi(argv[6]); ++x) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      std::printf("%d ", r.rgba[(static_cast<std::size_t>(row) * r.width + static_cast<std::size_t>(x)) * 4 + 3]);  // NOLINT(cppcoreguidelines-pro-type-vararg)
    }
    std::printf("\n");  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 0;
  }
  {
    rs::FontSet fonts{rs::FontOptions{}};
    std::string err;
    if (!fonts.load_manifest(argv[2], err)) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      std::fprintf(stderr, "%s\n", err.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
      return 2;
    }
    rs::ShapeRequest req;
    req.font = *premation::raster::css::parse_font(argv[3]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    for (const auto& fam : req.font.families) (void)fonts.add_system_family(fam);
    const rs::ShapedText s = fonts.shape(argc > 4 ? argv[4] : "", req);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::printf("width %.10g ascent %.10g descent %.10g ink [%.10g %.10g %.10g %.10g]\n", s.width, s.ascent, s.descent,  // NOLINT(cppcoreguidelines-pro-type-vararg)
                s.inkLeft, s.inkTop, s.inkRight, s.inkBottom);
    for (const auto& g : s.glyphs) std::printf("  glyph %u face %d x %.10g y %.10g adv %.10g\n", g.id, g.face, g.x, g.y, g.advance);  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 0;
  }
}
