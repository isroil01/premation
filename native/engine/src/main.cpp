// premation-engine — C1 viewport prototype. See ../CMakeLists.txt and
// docs/VIEWPORT_ROUTE.md. Usage:
//
//   premation-engine --route bench|A|B|C [--width 1920] [--height 1080] [--scale 1]
//                    [--fps 60] [--frames 600]            (bench)
//                    [--parent HWND] [--rect x,y,w,h] [--input-transparent 1]   (B)
//                    [--host-pid PID] [--slots 3]          (C)
//                    [--power low|high]   adapter on hybrid laptops (default low)
//                    [--gpu-vendor N]     PCI vendor id of Chromium's GPU; overrides --power
//
// stdout: binary messages (wire.hpp). stdin: line commands. stderr: log.

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "gpu.hpp"
#include "os_ffi.hpp"
#include "scene.hpp"
#include "wire.hpp"

#ifdef _WIN32
#include "child_window_ffi.hpp"
#include "shared_texture_ffi.hpp"
#endif

namespace premation {
namespace {

using Clock = std::chrono::steady_clock;

struct Options {
  std::string route = "A";
  std::uint32_t width = 1920;
  std::uint32_t height = 1080;
  double scale = 1.0;
  double fps = 60.0;  // 0 = as fast as possible
  std::uint32_t frames = 600;
  std::uint64_t parent = 0;
  std::array<int, 4> rect = {0, 0, 640, 360};
  bool inputTransparent = true;
  std::uint32_t hostPid = 0;
  std::uint32_t slots = 3;
  bool highPerformance = false;  // --power high|low; default low = the iGPU that drives the panel
  std::uint32_t vendorId = 0;    // --gpu-vendor: Chromium's active adapter (PCI vendor id); wins over --power
};

Options parse(int argc, char** argv) {
  Options o;
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::string_view k = argv[i];
    const std::string v = argv[i + 1];
    if (k == "--route") o.route = v;
    else if (k == "--width") o.width = static_cast<std::uint32_t>(std::stoul(v));
    else if (k == "--height") o.height = static_cast<std::uint32_t>(std::stoul(v));
    else if (k == "--scale") o.scale = std::stod(v);
    else if (k == "--fps") o.fps = std::stod(v);
    else if (k == "--frames") o.frames = static_cast<std::uint32_t>(std::stoul(v));
    else if (k == "--parent") o.parent = std::stoull(v);
    else if (k == "--input-transparent") o.inputTransparent = v != "0";
    else if (k == "--host-pid") o.hostPid = static_cast<std::uint32_t>(std::stoul(v));
    else if (k == "--power") o.highPerformance = v == "high";
    else if (k == "--gpu-vendor") o.vendorId = static_cast<std::uint32_t>(std::stoul(v));
    else if (k == "--slots") o.slots = static_cast<std::uint32_t>(std::stoul(v));
    else if (k == "--rect") {
      std::istringstream in(v);
      char comma = 0;
      in >> o.rect[0] >> comma >> o.rect[1] >> comma >> o.rect[2] >> comma >> o.rect[3];
    }
  }
  return o;
}

// Readback rows must be 256-byte aligned; every size C1 uses already is, but
// keep the prototype honest for odd viewport sizes.
std::uint32_t aligned_row(std::uint32_t width) { return (width * 4 + 255U) & ~255U; }

// Per-second counters → one JSON stats line.
struct Stats {
  std::uint64_t rendered = 0;
  std::uint64_t sent = 0;
  std::uint64_t dropped = 0;
  double gpuMsSum = 0;
  std::uint64_t gpuSamples = 0;
  Clock::time_point since = Clock::now();
  double cpuMsAtStart = os::process_cpu_ms();

  void gpu_sample(double ms) {
    gpuMsSum += ms;
    ++gpuSamples;
  }

  void maybe_emit(Wire& wire, const char* route) {
    const auto now = Clock::now();
    const double secs = std::chrono::duration<double>(now - since).count();
    if (secs < 1.0) return;
    const double cpu = os::process_cpu_ms();
    std::array<char, 384> buf{};
    std::snprintf(buf.data(), buf.size(),
                  R"({"type":"stats","route":"%s","secs":%.3f,"renderedFps":%.2f,"sentFps":%.2f,"droppedFps":%.2f,)"
                  R"("cpuPct":%.2f,"gpuMsAvg":%.3f})",
                  route, secs, static_cast<double>(rendered) / secs, static_cast<double>(sent) / secs,
                  static_cast<double>(dropped) / secs, (cpu - cpuMsAtStart) / (secs * 10.0),
                  gpuSamples > 0 ? gpuMsSum / static_cast<double>(gpuSamples) : 0.0);
    wire.send_json(buf.data());
    *this = Stats{};
  }
};

// Fixed-rate pacing for playback-like routes (A, C). B is paced by vsync.
class Pacer {
 public:
  explicit Pacer(double fps) { set_fps(fps); }
  void set_fps(double fps) {
    period_ = fps > 0 ? std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(1.0 / fps))
                      : Clock::duration::zero();
    next_ = Clock::now();
  }
  // Advance to the next frame slot and return its start time.
  Clock::time_point advance() {
    if (period_ == Clock::duration::zero()) return Clock::now();
    next_ += period_;
    const auto now = Clock::now();
    if (next_ < now - period_) next_ = now;  // fell behind: don't burst to catch up
    return next_;
  }
  void wait() { std::this_thread::sleep_until(advance()); }

 private:
  Clock::duration period_{};
  Clock::time_point next_{};
};

double ms_between(double fromUs, double toUs) { return (toUs - fromUs) / 1000.0; }

void send_hello(Wire& wire, const Gpu& gpu, const Options& o, std::uint32_t w, std::uint32_t h,
                const std::string& extra = {}) {
  std::string json = R"({"type":"hello","route":")" + o.route + R"(","adapter":")" + gpu.adapterName +
                     R"(","backend":")" + gpu.backend + R"(","compWidth":)" + std::to_string(w) +
                     R"(,"compHeight":)" + std::to_string(h) + extra + "}";
  for (char& c : json) {
    if (c == '\\') c = '/';
  }
  wire.send_json(json);
}

// ── bench: render (and optionally read back) with no transport ─────────────
int run_bench(const Gpu& gpu, Scene& scene, const Options& o) {
  const std::uint32_t w = scene.comp_width();
  const std::uint32_t h = scene.comp_height();
  wgpu::TextureDescriptor td{};
  td.size = {w, h, 1};
  td.format = wgpu::TextureFormat::RGBA8Unorm;
  td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc;
  const wgpu::Texture target = gpu.device.CreateTexture(&td);
  const wgpu::TextureView view = target.CreateView();

  const auto measure = [&](bool readback) {
    const std::uint32_t row = aligned_row(w);
    std::array<wgpu::Buffer, 3> bufs;
    std::array<wgpu::Future, 3> futures{};
    std::array<bool, 3> pending{};
    std::vector<std::uint8_t> sink(static_cast<std::size_t>(row) * h);
    for (auto& b : bufs) {
      wgpu::BufferDescriptor bd{};
      bd.size = static_cast<std::uint64_t>(row) * h;
      bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
      b = gpu.device.CreateBuffer(&bd);
    }
    wait_idle(gpu);
    const double cpu0 = os::process_cpu_ms();
    const auto t0 = Clock::now();
    for (std::uint32_t f = 0; f < o.frames; ++f) {
      const std::size_t slot = f % 3;
      if (pending[slot]) {
        gpu.instance.WaitAny(futures[slot], UINT64_MAX);
        if (readback) {
          const auto* src = static_cast<const std::uint8_t*>(bufs[slot].GetConstMappedRange());
          std::copy(src, src + sink.size(), sink.begin());
          bufs[slot].Unmap();
        }
        pending[slot] = false;
      }
      wgpu::CommandEncoder enc = gpu.device.CreateCommandEncoder();
      scene.encode(enc, f, view, td.format, w, h);
      if (readback) {
        wgpu::TexelCopyTextureInfo src{};
        src.texture = target;
        wgpu::TexelCopyBufferInfo dst{};
        dst.buffer = bufs[slot];
        dst.layout.bytesPerRow = row;
        dst.layout.rowsPerImage = h;
        const wgpu::Extent3D size{w, h, 1};
        enc.CopyTextureToBuffer(&src, &dst, &size);
      }
      const wgpu::CommandBuffer cb = enc.Finish();
      gpu.queue.Submit(1, &cb);
      futures[slot] = readback ? bufs[slot].MapAsync(wgpu::MapMode::Read, 0, bufs[slot].GetSize(),
                                                     wgpu::CallbackMode::WaitAnyOnly,
                                                     [](wgpu::MapAsyncStatus, wgpu::StringView) {})
                               : gpu.queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly,
                                                               [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {});
      pending[slot] = true;
    }
    for (std::size_t s = 0; s < 3; ++s) {
      if (pending[s]) {
        gpu.instance.WaitAny(futures[s], UINT64_MAX);
        if (readback) bufs[s].Unmap();
      }
    }
    const double secs = std::chrono::duration<double>(Clock::now() - t0).count();
    const double cpu = os::process_cpu_ms() - cpu0;
    std::printf(R"({"mode":"%s","comp":[%u,%u],"frames":%u,"fps":%.1f,"msPerFrame":%.3f,"cpuPct":%.1f})"
                "\n",
                readback ? "render+readback" : "render", w, h, o.frames, o.frames / secs, secs * 1000.0 / o.frames,
                cpu / (secs * 10.0));
    std::fflush(stdout);
  };
  std::printf(R"({"adapter":"%s","backend":"%s"})"
              "\n",
              gpu.adapterName.c_str(), gpu.backend.c_str());
  measure(false);
  measure(true);
  return 0;
}

// ── A: offscreen render → readback → stdout ────────────────────────────────
int run_route_a(const Gpu& gpu, Scene& scene, const Options& o) {
  Wire wire;
  const std::uint32_t w = scene.comp_width();
  const std::uint32_t h = scene.comp_height();
  const std::uint32_t row = aligned_row(w);
  send_hello(wire, gpu, o, w, h);

  wgpu::TextureDescriptor td{};
  td.size = {w, h, 1};
  td.format = wgpu::TextureFormat::RGBA8Unorm;
  td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc;
  const wgpu::Texture target = gpu.device.CreateTexture(&td);
  const wgpu::TextureView view = target.CreateView();

  struct Readback {
    wgpu::Buffer buffer;
    wgpu::Future future{};
    bool pending = false;
    bool mapped = false;
    MessageHeader header{};
  };
  std::array<Readback, 3> ring;
  for (auto& rb : ring) {
    wgpu::BufferDescriptor bd{};
    bd.size = static_cast<std::uint64_t>(row) * h;
    bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
    rb.buffer = gpu.device.CreateBuffer(&bd);
  }
  // Tight RGBA rows for the wire (row == w*4 for every size C1 measures; the
  // de-stride copy only runs for odd widths).
  std::vector<std::uint8_t> tight(static_cast<std::size_t>(w) * h * 4);

  Stats stats;
  Pacer pacer(o.fps);
  double lastCmdUs = 0;
  bool quit = false;

  const auto finish = [&](Readback& rb) {
    rb.header.tRenderDoneUs = os::epoch_us();
    stats.gpu_sample(ms_between(rb.header.tRenderStartUs, rb.header.tRenderDoneUs));
    if (rb.mapped) {
      const auto* src = static_cast<const std::uint8_t*>(rb.buffer.GetConstMappedRange());
      std::span<const std::uint8_t> pixels(src, tight.size());
      if (row != w * 4) {
        for (std::uint32_t y = 0; y < h; ++y) {
          std::copy_n(src + static_cast<std::size_t>(y) * row, w * 4, tight.data() + static_cast<std::size_t>(y) * w * 4);
        }
        pixels = tight;
      }
      if (wire.offer_frame(rb.header, pixels)) ++stats.sent;
      else ++stats.dropped;
      rb.buffer.Unmap();
    }
    rb.pending = false;
    rb.mapped = false;
  };

  for (std::uint32_t frame = 0; !quit; ++frame) {
    for (const std::string& cmd : wire.take_commands()) {
      std::istringstream in(cmd);
      std::string op;
      in >> op;
      if (op == "quit") quit = true;
      else if (op == "ping") in >> lastCmdUs;
      else if (op == "fps") {
        double fps = 0;
        in >> fps;
        pacer.set_fps(fps);
      }
    }
    if (quit || wire.stdin_closed()) break;

    // Until the next frame is due, deliver readbacks the moment the GPU
    // finishes them (oldest first) instead of polling once per frame — the
    // difference is up to a whole frame of latency.
    const Clock::time_point deadline = pacer.advance();
    for (;;) {
      Readback* oldest = nullptr;
      for (auto& r : ring) {
        if (r.pending && (oldest == nullptr || r.header.frameIndex < oldest->header.frameIndex)) oldest = &r;
      }
      const auto now = Clock::now();
      if (now >= deadline) break;
      if (oldest == nullptr) {
        std::this_thread::sleep_until(deadline);
        break;
      }
      const auto left = std::chrono::duration_cast<std::chrono::nanoseconds>(deadline - now).count();
      if (gpu.instance.WaitAny(oldest->future, static_cast<std::uint64_t>(left)) != wgpu::WaitStatus::Success) break;
      finish(*oldest);
    }

    Readback& rb = ring[frame % ring.size()];
    if (rb.pending) {
      gpu.instance.WaitAny(rb.future, UINT64_MAX);
      finish(rb);
    }
    rb.header = MessageHeader{};
    rb.header.frameIndex = frame;
    rb.header.width = w;
    rb.header.height = h;
    rb.header.tCmdUs = lastCmdUs;
    rb.header.tRenderStartUs = os::epoch_us();

    wgpu::CommandEncoder enc = gpu.device.CreateCommandEncoder();
    scene.encode(enc, frame, view, td.format, w, h);
    wgpu::TexelCopyTextureInfo src{};
    src.texture = target;
    wgpu::TexelCopyBufferInfo dst{};
    dst.buffer = rb.buffer;
    dst.layout.bytesPerRow = row;
    dst.layout.rowsPerImage = h;
    const wgpu::Extent3D size{w, h, 1};
    enc.CopyTextureToBuffer(&src, &dst, &size);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu.queue.Submit(1, &cb);
    Readback* rbp = &rb;
    rb.future = rb.buffer.MapAsync(wgpu::MapMode::Read, 0, rb.buffer.GetSize(), wgpu::CallbackMode::WaitAnyOnly,
                                   [rbp](wgpu::MapAsyncStatus status, wgpu::StringView) {
                                     rbp->mapped = status == wgpu::MapAsyncStatus::Success;
                                   });
    rb.pending = true;
    ++stats.rendered;
    stats.maybe_emit(wire, "A");
  }
  for (auto& rb : ring) {
    if (rb.pending) {
      gpu.instance.WaitAny(rb.future, UINT64_MAX);
      if (rb.mapped) rb.buffer.Unmap();
    }
  }
  return 0;
}

#ifdef _WIN32
// ── B: child window + swapchain ─────────────────────────────────────────────
int run_route_b(const Gpu& gpu, Scene& scene, const Options& o) {
  Wire wire;
  send_hello(wire, gpu, o, scene.comp_width(), scene.comp_height());
  win::ChildWindow child;
  win::Rect rect{o.rect[0], o.rect[1], o.rect[2], o.rect[3]};
  if (!child.create(o.parent, rect, o.inputTransparent)) return 2;

  wgpu::SurfaceSourceWindowsHWND source{};
  source.hinstance = child.hinstance();
  source.hwnd = child.hwnd();
  wgpu::SurfaceDescriptor sd{};
  sd.nextInChain = &source;
  const wgpu::Surface surface = gpu.instance.CreateSurface(&sd);

  wgpu::SurfaceCapabilities caps{};
  surface.GetCapabilities(gpu.adapter, &caps);
  wgpu::TextureFormat format = wgpu::TextureFormat::BGRA8Unorm;
  bool haveBgra = false;
  for (std::size_t i = 0; i < caps.formatCount; ++i) haveBgra = haveBgra || caps.formats[i] == format;
  if (!haveBgra && caps.formatCount > 0) format = caps.formats[0];

  const auto configure = [&](const win::Rect& r) {
    if (r.w <= 0 || r.h <= 0) return;
    wgpu::SurfaceConfiguration cfg{};
    cfg.device = gpu.device;
    cfg.format = format;
    cfg.usage = wgpu::TextureUsage::RenderAttachment;
    cfg.width = static_cast<std::uint32_t>(r.w);
    cfg.height = static_cast<std::uint32_t>(r.h);
    cfg.alphaMode = wgpu::CompositeAlphaMode::Opaque;
    cfg.presentMode = wgpu::PresentMode::Fifo;
    surface.Configure(&cfg);
  };
  configure(rect);

  Stats stats;
  double lastCmdUs = 0;
  std::vector<win::Rect> holes;
  bool quit = false;
  for (std::uint32_t frame = 0; !quit; ++frame) {
    if (!child.pump()) break;
    for (const std::string& cmd : wire.take_commands()) {
      std::istringstream in(cmd);
      std::string op;
      in >> op;
      if (op == "quit") {
        quit = true;
      } else if (op == "ping") {
        in >> lastCmdUs;
      } else if (op == "rect") {
        win::Rect r;
        double tReq = 0;
        in >> r.x >> r.y >> r.w >> r.h >> tReq;
        child.set_rect(r);
        child.set_holes(holes);
        configure(r);
        std::array<char, 160> buf{};
        std::snprintf(buf.data(), buf.size(), R"({"type":"rectApplied","tReqUs":%.1f,"tAppliedUs":%.1f,"w":%d,"h":%d})",
                      tReq, os::epoch_us(), r.w, r.h);
        wire.send_json(buf.data());
      } else if (op == "hang") {
        // Test hook: stop pumping this thread's messages, as a stuck engine
        // would, to measure what that does to the Electron UI thread (their
        // input queues are attached by the cross-process parent/child link).
        int ms = 0;
        in >> ms;
        std::this_thread::sleep_for(std::chrono::milliseconds(ms));
      } else if (op == "holes") {
        std::size_t n = 0;
        in >> n;
        holes.assign(n, {});
        for (auto& hole : holes) in >> hole.x >> hole.y >> hole.w >> hole.h;
        child.set_holes(holes);
      }
    }
    if (quit || wire.stdin_closed()) break;
    const win::Rect r = child.rect();
    if (r.w <= 0 || r.h <= 0) {
      std::this_thread::sleep_for(std::chrono::milliseconds(16));
      continue;
    }
    wgpu::SurfaceTexture st{};
    surface.GetCurrentTexture(&st);
    if (st.status != wgpu::SurfaceGetCurrentTextureStatus::SuccessOptimal &&
        st.status != wgpu::SurfaceGetCurrentTextureStatus::SuccessSuboptimal) {
      configure(r);
      ++stats.dropped;
      continue;
    }
    MessageHeader hdr{};
    hdr.type = MessageType::Presented;
    hdr.frameIndex = frame;
    hdr.width = static_cast<std::uint32_t>(r.w);
    hdr.height = static_cast<std::uint32_t>(r.h);
    hdr.tCmdUs = lastCmdUs;
    hdr.tRenderStartUs = os::epoch_us();
    wgpu::CommandEncoder enc = gpu.device.CreateCommandEncoder();
    scene.encode(enc, frame, st.texture.CreateView(), format, hdr.width, hdr.height);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu.queue.Submit(1, &cb);
    surface.Present();
    hdr.tRenderDoneUs = os::epoch_us();
    stats.gpu_sample(ms_between(hdr.tRenderStartUs, hdr.tRenderDoneUs));
    ++stats.rendered;
    ++stats.sent;
    wire.send(hdr);
    stats.maybe_emit(wire, "B");
  }
  return 0;
}

// ── C: shared NT-handle textures → Electron sharedTexture ──────────────────
int run_route_c(const Gpu& gpu, Scene& scene, const Options& o) {
  Wire wire;
  const std::uint32_t w = scene.comp_width();
  const std::uint32_t h = scene.comp_height();
  shared::SharedTexturePool pool;
  std::string error;
  if (!pool.init(gpu, w, h, o.slots, o.hostPid, error)) {
    std::fprintf(stderr, "engine: route C unavailable: %s\n", error.c_str());
    wire.send_json(R"({"type":"error","message":"route C unavailable: )" + error + "\"}");
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    return 3;
  }
  std::string handles = R"(,"handles":[)";
  for (std::size_t i = 0; i < pool.slots().size(); ++i) {
    handles += (i > 0 ? ",\"" : "\"") + std::to_string(pool.slots()[i].remoteHandle) + "\"";
  }
  handles += "]";
  send_hello(wire, gpu, o, w, h, handles);

  Stats stats;
  Pacer pacer(o.fps);
  double lastCmdUs = 0;
  bool quit = false;
  std::size_t next = 0;
  for (std::uint32_t frame = 0; !quit; ++frame) {
    for (const std::string& cmd : wire.take_commands()) {
      std::istringstream in(cmd);
      std::string op;
      in >> op;
      if (op == "quit") quit = true;
      else if (op == "ping") in >> lastCmdUs;
      else if (op == "free") {
        std::size_t s = 0;
        in >> s;
        if (s < pool.slots().size()) pool.slots()[s].free = true;
      }
    }
    if (quit || wire.stdin_closed()) break;
    pacer.wait();

    shared::Slot* slot = nullptr;
    std::size_t slotIndex = 0;
    for (std::size_t k = 0; k < pool.slots().size(); ++k) {
      const std::size_t i = (next + k) % pool.slots().size();
      if (pool.slots()[i].free) {
        slot = &pool.slots()[i];
        slotIndex = i;
        break;
      }
    }
    if (slot == nullptr) {
      ++stats.dropped;  // every slot is still on screen / in flight in Chromium
      stats.maybe_emit(wire, "C");
      continue;
    }
    next = slotIndex + 1;
    MessageHeader hdr{};
    hdr.type = MessageType::SlotReady;
    hdr.frameIndex = frame;
    hdr.width = w;
    hdr.height = h;
    hdr.slot = static_cast<std::uint32_t>(slotIndex);
    hdr.tCmdUs = lastCmdUs;
    hdr.tRenderStartUs = os::epoch_us();
    if (!pool.begin_access(*slot)) {
      std::fprintf(stderr, "engine: BeginAccess failed\n");
      break;
    }
    wgpu::CommandEncoder enc = gpu.device.CreateCommandEncoder();
    scene.encode(enc, frame, slot->view, wgpu::TextureFormat::RGBA8Unorm, w, h);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu.queue.Submit(1, &cb);
    pool.end_access(*slot);
    // No fence reaches Chromium for an rgba import, so the frame is complete
    // on the GPU before its handle is announced.
    wait_idle(gpu);
    hdr.tRenderDoneUs = os::epoch_us();
    slot->free = false;
    stats.gpu_sample(ms_between(hdr.tRenderStartUs, hdr.tRenderDoneUs));
    ++stats.rendered;
    ++stats.sent;
    wire.send(hdr);
    stats.maybe_emit(wire, "C");
  }
  return 0;
}
#endif

int run(int argc, char** argv) {
  os::set_binary_stdio();
  os::set_dpi_aware();
  const Options o = parse(argc, argv);
  const auto gpu = create_gpu(o.route == "C", o.highPerformance, o.vendorId);
  if (!gpu) return 1;
  std::fprintf(stderr, "engine: %s on %s, route %s\n", gpu->backend.c_str(), gpu->adapterName.c_str(),
               o.route.c_str());

  const auto cw = static_cast<std::uint32_t>(static_cast<double>(o.width) * o.scale);
  const auto ch = static_cast<std::uint32_t>(static_cast<double>(o.height) * o.scale);
  Scene scene;
  if (!scene.init(*gpu, cw, ch)) return 1;

  if (o.route == "bench") return run_bench(*gpu, scene, o);
  if (o.route == "A") return run_route_a(*gpu, scene, o);
#ifdef _WIN32
  if (o.route == "B") return run_route_b(*gpu, scene, o);
  if (o.route == "C") return run_route_c(*gpu, scene, o);
#endif
  std::fprintf(stderr, "engine: unknown or unsupported route '%s'\n", o.route.c_str());
  return 64;
}

}  // namespace
}  // namespace premation

int main(int argc, char** argv) {
  try {
    return premation::run(argc, argv);
  } catch (const std::exception& e) {  // std::stoul on a bad flag, allocation failure
    std::fprintf(stderr, "engine: fatal: %s\n", e.what());
    return 70;
  }
}
