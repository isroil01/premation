// premation-render — render serialized FrameScenes (RenderFrameFile, engine-api
// 96_render.eapi) headless with the C++ render graph. docs/NATIVE_CORE_PLAN.md D2.
//
//   premation-render --scene <file.pfs> --out <file.png>        one frame
//   premation-render --batch <dir> --out <dir> --report <json>  every <dir>/<scene>/<frame>.pfs
//                    [--only a,b]                               (the render-tests `native` backend)
//   premation-render --bench <file.pfs> [--frames N]            frame time of one scene
//   common: [--gpu-vendor N] (default: the adapter the TS frame was rendered on)
//
// A frame using a feature the graph has not ported is reported `not-ported`
// with the reasons and is not rendered. Exit: 0 ran (even with not-ported
// frames), 1 renderer/IO error, 64 usage.
#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <fstream>
#include <map>
#include <numeric>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "png_write.hpp"
#include "scene_renderer.hpp"
#include "support.hpp"

namespace fs = std::filesystem;
using premation::rg::api::RenderFrameFile;

namespace {

bool read_file(const fs::path& p, std::vector<std::uint8_t>& out) {
  std::ifstream in(p, std::ios::binary);
  if (!in) return false;
  in.seekg(0, std::ios::end);
  const auto n = static_cast<std::size_t>(in.tellg());
  in.seekg(0);
  out.resize(n);
  in.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(n));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return static_cast<bool>(in);
}

bool write_file(const fs::path& p, std::span<const std::uint8_t> bytes) {
  std::error_code ec;
  fs::create_directories(p.parent_path(), ec);
  std::ofstream out(p, std::ios::binary);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return static_cast<bool>(out);
}

std::string json_escape(std::string_view s) {
  std::string o;
  for (const char c : s) {
    if (c == '"' || c == '\\') {
      o += '\\';
      o += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      o += ' ';
    } else {
      o += c;
    }
  }
  return o;
}

std::uint32_t vendor_id(std::string_view v) {
  if (v.find("amd") != std::string_view::npos || v.find("ati") != std::string_view::npos) return 0x1002;
  if (v.find("nvidia") != std::string_view::npos) return 0x10de;
  if (v.find("intel") != std::string_view::npos) return 0x8086;
  if (v.find("apple") != std::string_view::npos) return 0x106b;
  return 0;
}

/// The harness's WebGPU readback: drawImage → getImageData (straight, rounded)
/// → re-premultiply with Math.round. Applied so a native PNG and a webgpu PNG
/// of the same surface bytes are the same bytes.
void harness_readback(std::vector<std::uint8_t>& rgba) {
  for (std::size_t i = 0; i + 3 < rgba.size(); i += 4) {
    const unsigned a = rgba[i + 3];
    if (a == 255) continue;
    for (std::size_t c = 0; c < 3; ++c) {
      if (a == 0) {
        rgba[i + c] = 0;
        continue;
      }
      const unsigned p = rgba[i + c];
      const unsigned s = std::min(255U, (p * 255U + a / 2U) / a);
      rgba[i + c] = static_cast<std::uint8_t>((s * a + 127U) / 255U);
    }
  }
}

struct FrameReport {
  std::string scene;
  std::int64_t frame = 0;
  std::string status;  // rendered | not-ported | error
  std::vector<std::string> reasons;
  std::string error;
  double encodeMs = 0;
  double gpuMs = 0;
  std::vector<std::string> diagnostics;
};

bool decode(const fs::path& p, RenderFrameFile& f, std::string& err) {
  std::vector<std::uint8_t> bytes;
  if (!read_file(p, bytes)) {
    err = "cannot read " + p.string();
    return false;
  }
  return premation::rg::decode_frame_file(bytes, f, err);
}

std::unique_ptr<premation::rg::SceneRenderer> make_renderer(std::uint32_t vendor, std::string& err) {
  premation::rg::RendererOptions o;
  o.vendorId = vendor;
  o.highPerformance = true;
  return premation::rg::SceneRenderer::create(o, err);
}

FrameReport render_one(premation::rg::SceneRenderer& r, const RenderFrameFile& f, const fs::path& png) {
  FrameReport rep;
  rep.scene = f.scene_id;
  rep.frame = f.frame;
  rep.reasons = premation::rg::unported_features(f);
  if (!rep.reasons.empty()) {
    rep.status = "not-ported";
    return rep;
  }
  premation::rg::Frame out;
  premation::rg::FrameStats stats;
  std::string err;
  if (!r.render(f, &out, stats, err)) {
    rep.status = "error";
    rep.error = err;
    return rep;
  }
  for (const auto& d : stats.diagnostics) rep.diagnostics.push_back(d.code + ": " + d.detail);
  if (!stats.gpuError.empty()) {
    rep.status = "error";
    rep.error = "GPU validation: " + stats.gpuError;
    return rep;
  }
  harness_readback(out.rgba);
  if (!write_file(png, premation::tools::encode_png(out.width, out.height, out.rgba))) {
    rep.status = "error";
    rep.error = "cannot write " + png.string();
    return rep;
  }
  rep.status = "rendered";
  rep.encodeMs = stats.encodeMs;
  rep.gpuMs = stats.gpuMs;
  return rep;
}

int run(int argc, char** argv) {
  std::map<std::string, std::string, std::less<>> opt;
  for (int i = 1; i < argc; ++i) {
    const std::string_view k = argv[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (k.size() > 2 && k.substr(0, 2) == "--") {
      const std::string v = i + 1 < argc ? std::string(argv[i + 1]) : std::string();  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      opt[std::string(k.substr(2))] = v;
      ++i;
    } else {
      std::fprintf(stderr, "premation-render: unexpected argument %.*s\n", static_cast<int>(k.size()), k.data());
      return 64;
    }
  }
  std::uint32_t vendor = 0;
  if (const auto it = opt.find("gpu-vendor"); it != opt.end()) {
    const std::string& s = it->second;
    const bool hex = s.rfind("0x", 0) == 0;
    std::from_chars(s.data() + (hex ? 2 : 0), s.data() + s.size(), vendor, hex ? 16 : 10);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }

  if (const auto it = opt.find("scene"); it != opt.end()) {
    RenderFrameFile f;
    std::string err;
    if (!decode(it->second, f, err)) {
      std::fprintf(stderr, "premation-render: %s\n", err.c_str());
      return 1;
    }
    auto r = make_renderer(vendor != 0 ? vendor : vendor_id(f.view.adapter_vendor.value_or("")), err);
    if (!r) {
      std::fprintf(stderr, "premation-render: %s\n", err.c_str());
      return 1;
    }
    const FrameReport rep = render_one(*r, f, opt.count("out") != 0 ? fs::path(opt["out"]) : fs::path("out.png"));
    std::printf("%s %s", rep.status.c_str(), rep.error.c_str());
    for (const auto& reason : rep.reasons) std::printf(" [%s]", reason.c_str());
    std::printf("\n");
    return rep.status == "error" ? 1 : 0;
  }

  if (const auto it = opt.find("bench"); it != opt.end()) {
    RenderFrameFile f;
    std::string err;
    if (!decode(it->second, f, err)) {
      std::fprintf(stderr, "premation-render: %s\n", err.c_str());
      return 1;
    }
    const auto reasons = premation::rg::unported_features(f);
    if (!reasons.empty()) {
      std::fprintf(stderr, "premation-render: scene not ported (%s)\n", reasons.front().c_str());
      return 1;
    }
    auto r = make_renderer(vendor != 0 ? vendor : vendor_id(f.view.adapter_vendor.value_or("")), err);
    if (!r) {
      std::fprintf(stderr, "premation-render: %s\n", err.c_str());
      return 1;
    }
    int frames = 200;
    if (opt.count("frames") != 0) std::from_chars(opt["frames"].data(), opt["frames"].data() + opt["frames"].size(), frames);
    std::vector<double> total;
    std::vector<double> gpu;
    std::vector<double> encode;
    for (int i = 0; i < frames + 10; ++i) {
      premation::rg::FrameStats s;
      if (!r->render(f, nullptr, s, err)) return 1;
      if (i >= 10) {  // warm-up: pipelines, uploads
        total.push_back(s.encodeMs + s.gpuMs);
        gpu.push_back(s.gpuMs);
        encode.push_back(s.encodeMs);
      }
    }
    std::sort(total.begin(), total.end());
    const double mean = std::accumulate(total.begin(), total.end(), 0.0) / static_cast<double>(total.size());
    const double meanEncode = std::accumulate(encode.begin(), encode.end(), 0.0) / static_cast<double>(encode.size());
    const auto st = r->device().stats();
    std::printf(
        "{\"scene\":\"%s\",\"adapter\":\"%s\",\"frames\":%d,\"meanMs\":%.4f,\"meanEncodeMs\":%.4f,\"p50Ms\":%.4f,\"p95Ms\":%.4f,"
        "\"bindGroupHits\":%llu,\"bindGroupMisses\":%llu,\"pipelines\":%llu,\"targetHits\":%llu,\"targetMisses\":%llu,"
        "\"gpuBytes\":%llu}\n",
        json_escape(f.scene_id).c_str(), json_escape(r->adapter()).c_str(), frames, mean, meanEncode, total[total.size() / 2],
        total[total.size() * 95 / 100], static_cast<unsigned long long>(st.bindGroupHits),
        static_cast<unsigned long long>(st.bindGroupMisses), static_cast<unsigned long long>(st.pipelinesCreated),
        static_cast<unsigned long long>(st.targetHits), static_cast<unsigned long long>(st.targetMisses),
        static_cast<unsigned long long>(st.gpuBytes));
    return 0;
  }

  if (const auto it = opt.find("batch"); it != opt.end()) {
    const fs::path dir = it->second;
    const fs::path outDir = opt.count("out") != 0 ? fs::path(opt["out"]) : fs::path("native-out");
    const fs::path reportPath = opt.count("report") != 0 ? fs::path(opt["report"]) : outDir / "report.json";
    std::vector<std::string> only;
    if (opt.count("only") != 0) {
      std::stringstream ss(opt["only"]);
      std::string s;
      while (std::getline(ss, s, ',')) if (!s.empty()) only.push_back(s);
    }
    std::vector<fs::path> files;
    std::error_code ec;
    for (const auto& e : fs::recursive_directory_iterator(dir, ec)) {
      if (e.is_regular_file() && e.path().extension() == ".pfs") {
        const std::string scene = e.path().parent_path().filename().string();
        if (only.empty() || std::find(only.begin(), only.end(), scene) != only.end()) files.push_back(e.path());
      }
    }
    std::sort(files.begin(), files.end());
    std::unique_ptr<premation::rg::SceneRenderer> r;
    std::vector<FrameReport> reports;
    std::string adapter;
    std::string backend;
    std::uint32_t chosenVendor = vendor;
    for (const auto& p : files) {
      RenderFrameFile f;
      std::string err;
      if (!decode(p, f, err)) {
        FrameReport rep;
        rep.scene = p.parent_path().filename().string();
        rep.status = "error";
        rep.error = err;
        reports.push_back(rep);
        continue;
      }
      if (!r) {
        if (chosenVendor == 0) chosenVendor = vendor_id(f.view.adapter_vendor.value_or(""));
        r = make_renderer(chosenVendor, err);
        if (!r) {
          std::fprintf(stderr, "premation-render: %s\n", err.c_str());
          return 1;
        }
        adapter = r->adapter();
        backend = r->backend();
      }
      const fs::path png = outDir / f.scene_id / (std::to_string(f.frame) + ".png");
      // Per-frame isolation: one frame that throws is an error row, not a lost batch.
      try {
        reports.push_back(render_one(*r, f, png));
      } catch (const std::exception& ex) {
        FrameReport rep;
        rep.scene = f.scene_id;
        rep.frame = f.frame;
        rep.status = "error";
        rep.error = std::string("exception: ") + ex.what();
        reports.push_back(rep);
      }
    }
    std::ostringstream js;
    double sumGpu = 0;
    std::size_t rendered = 0;
    js << "{\"adapter\":\"" << json_escape(adapter) << "\",\"backend\":\"" << backend << "\",\"frames\":[";
    for (std::size_t i = 0; i < reports.size(); ++i) {
      const auto& rp = reports[i];
      if (i != 0) js << ',';
      js << "{\"scene\":\"" << json_escape(rp.scene) << "\",\"frame\":" << rp.frame << ",\"status\":\"" << rp.status << "\"";
      if (!rp.error.empty()) js << ",\"error\":\"" << json_escape(rp.error) << "\"";
      js << ",\"reasons\":[";
      for (std::size_t k = 0; k < rp.reasons.size(); ++k) js << (k != 0 ? "," : "") << '"' << json_escape(rp.reasons[k]) << '"';
      js << "],\"diagnostics\":[";
      for (std::size_t k = 0; k < rp.diagnostics.size(); ++k) js << (k != 0 ? "," : "") << '"' << json_escape(rp.diagnostics[k]) << '"';
      js << "],\"encodeMs\":" << rp.encodeMs << ",\"gpuMs\":" << rp.gpuMs << '}';
      if (rp.status == "rendered") {
        sumGpu += rp.gpuMs + rp.encodeMs;
        ++rendered;
      }
    }
    js << "],\"timing\":{\"frames\":" << rendered << ",\"meanGpuMs\":" << (rendered != 0 ? sumGpu / static_cast<double>(rendered) : 0)
       << "}}\n";
    const std::string s = js.str();
    write_file(reportPath, std::span(reinterpret_cast<const std::uint8_t*>(s.data()), s.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    std::size_t notPorted = 0;
    std::size_t errors = 0;
    for (const auto& rp : reports) {
      if (rp.status == "not-ported") ++notPorted;
      if (rp.status == "error") ++errors;
    }
    std::printf("premation-render: %zu frame(s): %zu rendered, %zu not ported, %zu error(s) on %s (%s)\n", reports.size(), rendered,
                notPorted, errors, adapter.c_str(), backend.c_str());
    return 0;
  }

  std::fprintf(stderr, "usage: premation-render --scene F --out P | --batch DIR --out DIR --report JSON | --bench F\n");
  return 64;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    return run(argc, argv);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "premation-render: exception: %s\n", e.what());
    return 70;
  }
}
