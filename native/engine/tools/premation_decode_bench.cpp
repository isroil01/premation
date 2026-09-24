// premation-decode-bench — E1's measurement tool (docs/NATIVE_CORE_PLAN.md §5,
// exit: "4K ProRes scrub ≤ 50 ms; 6 × 1080p layers at full rate").
//
//   premation-decode-bench probe <file>…
//   premation-decode-bench scrub <file> [--n 60] [--seed 1]
//       random-access seeks through MediaSystem's latest lane (cold: every
//       target is a cache miss), each measured to "decoded" and to "texture
//       ready on the GPU" (conversion submitted + GPU idle); p50/p95/max.
//   premation-decode-bench play <file>… [--streams K] [--seconds S] [--paced]
//       K streams (files cycled) played from frame 0 with readahead; every
//       frame of every stream decoded AND converted to a texture. Unpaced:
//       sustained fps per stream (throughput). --paced: presented at the
//       file's rate, counting late frames (a frame not decoded by its deadline).
//
// Options: --vendor 0x10de|0x1002|0x8086 (render/decode adapter; default:
// high-performance), --hw auto|sw|hw, --path auto|d3d11va|d3d12va|dxva2|nvdec
// (the hardware device; default d3d11va; auto = the engine's media_config_for
// policy — nvdec is CUDA on the render
// adapter, frames downloaded and uploaded), --download (hardware frames to
// system memory instead of the zero-copy surface), --threads N.
// `tools/run_decode_bench.mjs` runs the E1 matrix over gen_media_clips.mjs's clips.
// Reports CPU % (all cores = 100 × cores), working set peak, cache stats and
// the decode path. GPU decode-engine utilisation is sampled outside the
// process (nvidia-smi / Windows "GPU Engine" counters) — see native/README.md.
#include <webgpu/webgpu_cpp.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "decoder.hpp"
#include "frame_convert.hpp"
#include "media_config.hpp"
#include "media_system.hpp"
#include "platform_ffi.hpp"

using namespace premation::media;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

namespace {

struct Args {
  std::string mode;
  std::vector<std::string> files;
  int n = 60;
  unsigned seed = 1;
  int streams = 1;
  double seconds = 10;
  bool paced = false;
  std::uint32_t vendor = 0;
  HwPolicy hw = HwPolicy::automatic;
  DecodePath path = DecodePath::d3d11va;
  bool autoPath = false;
  bool download = false;
  int threads = 0;
};

double ms_since(Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); }

double pct(std::vector<double> v, double p) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  const auto i = static_cast<std::size_t>(std::min<double>(static_cast<double>(v.size() - 1), std::floor(p * static_cast<double>(v.size() - 1) + 0.5)));
  return v[i];
}

struct Gpu {
  wgpu::Instance instance;
  wgpu::Adapter adapter;
  wgpu::Device device;
  std::string name;
};

wgpu::Adapter request(const wgpu::Instance& inst, wgpu::PowerPreference pref) {
  wgpu::Adapter found;
  wgpu::RequestAdapterOptions o{};
#if defined(_WIN32)
  o.backendType = wgpu::BackendType::D3D12;
#endif
  o.powerPreference = pref;
  inst.WaitAny(inst.RequestAdapter(&o, wgpu::CallbackMode::WaitAnyOnly,
                                   [&found](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView) {
                                     if (s == wgpu::RequestAdapterStatus::Success) found = std::move(a);
                                   }),
               UINT64_MAX);
  return found;
}

bool make_gpu(std::uint32_t vendor, Gpu& g) {
  static constexpr auto kTimedWaitAny = wgpu::InstanceFeatureName::TimedWaitAny;
  wgpu::InstanceDescriptor id{};
  id.requiredFeatureCount = 1;
  id.requiredFeatures = &kTimedWaitAny;
  g.instance = wgpu::CreateInstance(&id);
  for (const auto pref : {wgpu::PowerPreference::HighPerformance, wgpu::PowerPreference::LowPower}) {
    wgpu::Adapter a = request(g.instance, pref);
    wgpu::AdapterInfo info{};
    if (a != nullptr) a.GetInfo(&info);
    if (a != nullptr && (vendor == 0 || info.vendorID == vendor)) {
      g.adapter = std::move(a);
      g.name = std::string(info.device.data, info.device.length == wgpu::kStrlen ? std::strlen(info.device.data) : info.device.length);
      break;
    }
  }
  if (g.adapter == nullptr) return false;
  const auto features = wanted_device_features(g.adapter);
  wgpu::DeviceDescriptor dd{};
  dd.requiredFeatureCount = features.size();
  dd.requiredFeatures = features.data();
  dd.SetUncapturedErrorCallback([](const wgpu::Device&, wgpu::ErrorType, wgpu::StringView msg) {
    std::fprintf(stderr, "Dawn: %.*s\n", static_cast<int>(msg.length == wgpu::kStrlen ? std::strlen(msg.data) : msg.length), msg.data);
  });
  g.instance.WaitAny(g.adapter.RequestDevice(&dd, wgpu::CallbackMode::WaitAnyOnly,
                                             [&g](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView) {
                                               if (s == wgpu::RequestDeviceStatus::Success) g.device = std::move(d);
                                             }),
                     UINT64_MAX);
  if (g.device == nullptr) return false;
  std::printf("adapter %s: shared-handle %d, multi-planar %d, P010 %d, unorm16 %d\n", g.name.c_str(),
              g.device.HasFeature(wgpu::FeatureName::SharedTextureMemoryDXGISharedHandle) ? 1 : 0,
              g.device.HasFeature(wgpu::FeatureName::DawnMultiPlanarFormats) ? 1 : 0,
              g.device.HasFeature(wgpu::FeatureName::MultiPlanarFormatP010) ? 1 : 0,
              g.device.HasFeature(wgpu::FeatureName::Unorm16TextureFormats) ? 1 : 0);
  return true;
}

void gpu_idle(const Gpu& g) {
  g.instance.WaitAny(g.device.GetQueue().OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly,
                                                             [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {}),
                     UINT64_MAX);
}

void print_info(const MediaInfo& mi) {
  if (!mi.video) {
    std::printf("  no video\n");
    return;
  }
  const VideoInfo& v = *mi.video;
  std::printf("  %s %s %s %ux%u %lld/%lld fps, %lld frames (%s index), %u-bit, chroma %d/%d, alpha %d, intra %d\n", v.codec.c_str(),
              v.profile.c_str(), v.pixelFormat.c_str(), v.width, v.height, static_cast<long long>(v.fps.num),
              static_cast<long long>(v.fps.den), static_cast<long long>(v.frameCount), v.exactIndex ? "exact" : "cfr", v.bitDepth,
              v.chromaShiftX, v.chromaShiftY, v.hasAlpha ? 1 : 0, v.intraOnly ? 1 : 0);
  std::printf("  colour: primaries %d transfer %d matrix %d range %d → matrix %d range %d%s%s\n", static_cast<int>(v.color.primaries),
              static_cast<int>(v.color.transfer), static_cast<int>(v.color.matrix), static_cast<int>(v.color.range),
              static_cast<int>(v.color.resolvedMatrix), static_cast<int>(v.color.resolvedRange), v.color.mastering ? ", mastering display" : "",
              v.color.contentLight ? ", MaxCLL/FALL" : "");
}

MediaConfig config_of(const Args& a, const Gpu& g, std::string& hwNote) {
  if (a.autoPath && a.hw != HwPolicy::softwareOnly) {
    // The engine's own policy (media_config_for).
    MediaConfig c = media_config_for(g.device, hwNote);
    c.hw = a.hw;
    c.decodeThreads = a.threads;
    if (a.download) c.keepOnGpu = false;
    return c;
  }
  MediaConfig c;
  c.hw = a.hw;
  c.keepOnGpu = !a.download;
  c.keepHighBitOnGpu = FrameConverter(g.device).zero_copy_p010();
  c.decodeThreads = a.threads;
  if (a.hw != HwPolicy::softwareOnly) {
    HwContextOptions ho;
    ho.adapterLuid = platform::adapter_luid(g.device);
    ho.preferred = a.path;
    std::string error;
    c.hwContext = create_hw_context(ho, error);
    hwNote = c.hwContext ? to_string(hw_path(*c.hwContext)) + std::string(" on ") + hw_adapter(*c.hwContext) : "none (" + error + ")";
  } else {
    hwNote = "off";
  }
  return c;
}

int scrub(const Args& a, const Gpu& g) {
  std::string hwNote;
  MediaConfig cfg = config_of(a, g, hwNote);
  cfg.cpuCacheBytes = std::size_t{512} << 20U;
  MediaSystem ms(cfg);
  std::string error;
  const auto t0 = Clock::now();
  const auto id = ms.open(a.files.at(0), error);
  if (!id || !ms.wait_ready(*id, 60s)) {
    std::fprintf(stderr, "open: %s %s\n", error.c_str(), id ? ms.stats(*id).error.c_str() : "");
    return 1;
  }
  const double openMs = ms_since(t0);
  MediaInfo mi;
  (void)ms.info(*id, mi);
  std::printf("%s\n", a.files[0].c_str());
  print_info(mi);
  const auto frames = ms.index(*id)->size();
  FrameConverter conv(g.device);
  std::mt19937 rng(a.seed);
  std::vector<std::int64_t> targets;
  std::vector<bool> used(static_cast<std::size_t>(frames), false);
  while (static_cast<int>(targets.size()) < std::min<std::int64_t>(a.n, frames)) {
    const auto f = static_cast<std::int64_t>(rng() % static_cast<unsigned>(frames));
    if (used[static_cast<std::size_t>(f)]) continue;
    used[static_cast<std::size_t>(f)] = true;
    targets.push_back(f);
  }
  std::vector<double> dec;
  std::vector<double> tex;
  const auto u0 = platform::process_usage();
  const auto w0 = Clock::now();
  for (const std::int64_t f : targets) {
    const auto s = Clock::now();
    const FramePtr fr = ms.wait(*id, f, Lane::latest, 30s);
    if (!fr) {
      std::fprintf(stderr, "frame %lld: not delivered (%s)\n", static_cast<long long>(f), ms.stats(*id).error.c_str());
      return 1;
    }
    dec.push_back(ms_since(s));
    ConvertedFrame out;
    if (!conv.convert(*fr, AlphaMode::straight, out, error)) {
      std::fprintf(stderr, "convert: %s\n", error.c_str());
      return 1;
    }
    gpu_idle(g);
    tex.push_back(ms_since(s));
    conv.recycle(std::move(out));
  }
  const double wall = ms_since(w0);
  const auto u1 = platform::process_usage();
  const auto st = ms.stats(*id);
  if (ms.info(*id, mi) && mi.video && (mi.video->color.mastering || mi.video->color.contentLight)) {
    const ColorInfo& c = *&mi.video->color;
    std::printf("  HDR: mastering %s (max %.0f / min %.4f cd/m2), MaxCLL %u MaxFALL %u (from the stream's SEI)\n",
                c.mastering ? "yes" : "no", c.mastering ? c.mastering->maxLuminance : 0.0,
                c.mastering ? c.mastering->minLuminance : 0.0, c.contentLight ? c.contentLight->maxCLL : 0U,
                c.contentLight ? c.contentLight->maxFALL : 0U);
  }
  std::printf("  decode path: %s (hw device: %s), open %.1f ms, adapter %s\n", to_string(st.path), hwNote.c_str(), openMs, g.name.c_str());
  std::printf("  scrub %zu random seeks: decoded p50 %.1f p95 %.1f max %.1f ms | texture p50 %.1f p95 %.1f max %.1f ms\n",
              targets.size(), pct(dec, 0.5), pct(dec, 0.95), pct(dec, 1), pct(tex, 0.5), pct(tex, 0.95), pct(tex, 1));
  std::printf("  imports %llu (%.1f ms total)\n", static_cast<unsigned long long>(conv.stats().imports), conv.stats().importMs);
  std::printf("  frames decoded %llu for %zu targets (seeks %llu), zero-copy %llu/%llu, CPU %.0f%% of one core, peak WS %.0f MB\n",
              static_cast<unsigned long long>(st.framesDecoded), targets.size(), static_cast<unsigned long long>(st.seeks),
              static_cast<unsigned long long>(conv.stats().zeroCopy), static_cast<unsigned long long>(conv.stats().conversions),
              100.0 * (u1.cpuMs - u0.cpuMs) / wall, static_cast<double>(u1.peakWorkingSet) / 1048576.0);
  return 0;
}

int play(const Args& a, const Gpu& g) {
  std::string hwNote;
  MediaConfig cfg = config_of(a, g, hwNote);
  cfg.readahead = 16;
  MediaSystem ms(cfg);
  std::string error;
  std::vector<SourceId> ids;
  for (int k = 0; k < a.streams; ++k) {
    const auto id = ms.open(a.files.at(static_cast<std::size_t>(k) % a.files.size()), error);
    if (!id) {
      std::fprintf(stderr, "open: %s\n", error.c_str());
      return 1;
    }
    ids.push_back(*id);
  }
  for (const SourceId id : ids) {
    if (!ms.wait_ready(id, 60s)) {
      std::fprintf(stderr, "open failed: %s\n", ms.stats(id).error.c_str());
      return 1;
    }
  }
  MediaInfo mi;
  (void)ms.info(ids[0], mi);
  std::printf("%s ×%d%s\n", a.files[0].c_str(), a.streams, a.paced ? " (paced)" : "");
  print_info(mi);
  const double fps = mi.video->fps.value();
  std::int64_t frames = ms.index(ids[0])->size();
  for (const SourceId id : ids) frames = std::min(frames, ms.index(id)->size());
  FrameConverter conv(g.device);
  for (const SourceId id : ids) ms.playhead(id, 0, +1);
  const auto u0 = platform::process_usage();
  const auto start = Clock::now();
  std::int64_t shown = 0;
  std::int64_t late = 0;
  std::vector<double> frameMs;
  for (std::int64_t f = 0; f < frames && ms_since(start) < a.seconds * 1000; ++f) {
    const auto fs = Clock::now();
    if (a.paced) {
      const auto deadline = start + std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(static_cast<double>(f) / fps));
      std::this_thread::sleep_until(deadline);
    }
    for (const SourceId id : ids) {
      FramePtr fr = a.paced ? ms.cached(id, f) : nullptr;
      if (!fr) {
        if (a.paced) ++late;
        fr = ms.wait(id, f, Lane::exact, 30s);
      }
      if (!fr) {
        std::fprintf(stderr, "stream %u frame %lld not delivered: %s\n", id, static_cast<long long>(f), ms.stats(id).error.c_str());
        return 1;
      }
      ms.playhead(id, f, +1);
      ConvertedFrame out;
      if (!conv.convert(*fr, AlphaMode::straight, out, error)) {
        std::fprintf(stderr, "convert: %s\n", error.c_str());
        return 1;
      }
      conv.recycle(std::move(out));
    }
    gpu_idle(g);
    frameMs.push_back(ms_since(fs));
    ++shown;
  }
  const double wall = ms_since(start);
  const auto u1 = platform::process_usage();
  const auto cs = ms.cache_stats();
  const auto st = ms.stats(ids[0]);
  const unsigned cores = std::max(1U, std::thread::hardware_concurrency());
  std::printf("  decode path: %s (hw device: %s), adapter %s\n", to_string(st.path), hwNote.c_str(), g.name.c_str());
  std::printf("  %lld frames × %d streams in %.2f s: %.1f fps per stream (file rate %.3f) — %s\n", static_cast<long long>(shown), a.streams,
              wall / 1000, static_cast<double>(shown) * 1000 / wall, fps,
              static_cast<double>(shown) * 1000 / wall >= fps * 0.995 ? "FULL RATE" : "below rate");
  if (a.paced) std::printf("  late frames: %lld of %lld\n", static_cast<long long>(late), static_cast<long long>(shown * a.streams));
  std::printf("  surface imports into Dawn: %llu (%.1f ms total)\n", static_cast<unsigned long long>(conv.stats().imports), conv.stats().importMs);
  std::printf("  frame time p50 %.1f p95 %.1f ms; CPU %.0f%% of one core (%.0f%% of %u); peak WS %.0f MB; cache %zu frames %.0f MB CPU %.0f MB GPU; zero-copy %llu/%llu\n",
              pct(frameMs, 0.5), pct(frameMs, 0.95), 100.0 * (u1.cpuMs - u0.cpuMs) / wall, 100.0 * (u1.cpuMs - u0.cpuMs) / wall / cores, cores,
              static_cast<double>(u1.peakWorkingSet) / 1048576.0, cs.frames, static_cast<double>(cs.cpuBytes) / 1048576.0,
              static_cast<double>(cs.gpuBytes) / 1048576.0, static_cast<unsigned long long>(conv.stats().zeroCopy),
              static_cast<unsigned long long>(conv.stats().conversions));
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  const std::vector<std::string> av(argv + 1, argv + argc);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  Args a;
  for (std::size_t i = 0; i < av.size(); ++i) {
    const std::string& s = av[i];
    auto next = [&]() -> std::string { return i + 1 < av.size() ? av[++i] : std::string(); };
    if (s == "--n") a.n = std::atoi(next().c_str());
    else if (s == "--seed") a.seed = static_cast<unsigned>(std::atoi(next().c_str()));
    else if (s == "--streams") a.streams = std::max(1, std::atoi(next().c_str()));
    else if (s == "--seconds") a.seconds = std::atof(next().c_str());
    else if (s == "--paced") a.paced = true;
    else if (s == "--vendor") a.vendor = static_cast<std::uint32_t>(std::strtoul(next().c_str(), nullptr, 0));
    else if (s == "--download") a.download = true;
    else if (s == "--threads") a.threads = std::atoi(next().c_str());
    else if (s == "--path") {
      const std::string v = next();
      a.autoPath = v == "auto";
      a.path = v == "nvdec" ? DecodePath::nvdec : v == "d3d12va" ? DecodePath::d3d12va : v == "dxva2" ? DecodePath::dxva2 : DecodePath::d3d11va;
    }
    else if (s == "--hw") {
      const std::string v = next();
      a.hw = v == "sw" ? HwPolicy::softwareOnly : v == "hw" ? HwPolicy::hardwareOnly : HwPolicy::automatic;
    } else if (a.mode.empty()) a.mode = s;
    else a.files.push_back(s);
  }
  if (a.mode.empty() || a.files.empty()) {
    std::fprintf(stderr, "usage: premation-decode-bench probe|scrub|play <file>… [options] (see the header of premation_decode_bench.cpp)\n");
    return 2;
  }
  if (a.mode == "probe") {
    for (const auto& f : a.files) {
      MediaInfo mi;
      FrameIndex idx;
      std::string error;
      std::printf("%s\n", f.c_str());
      if (!VideoDecoder::probe(f, mi, idx, error)) std::printf("  error: %s\n", error.c_str());
      else print_info(mi);
    }
    return 0;
  }
  Gpu g;
  if (!make_gpu(a.vendor, g)) {
    std::fprintf(stderr, "no GPU\n");
    return 1;
  }
  if (a.mode == "scrub") return scrub(a, g);
  if (a.mode == "play") return play(a, g);
  std::fprintf(stderr, "unknown mode %s\n", a.mode.c_str());
  return 2;
}
