// GPU side: the compositor draws what the FrameScene says, and the render
// thread delivers frames through the slot ring. Skips when no adapter exists.
//
// Also the headless throughput measurement quoted in the C2 report:
//   engine_gpu_tests "[bench]" --success   (prints fps for 1080p through slots)

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

#include "compositor.hpp"
#include "gpu.hpp"
#include "render_thread.hpp"

using namespace premation;

namespace {

std::optional<Gpu>& shared_gpu() {
  static std::optional<Gpu> gpu = create_gpu(false, true, 0);
  return gpu;
}

std::vector<std::uint8_t> readback(const Gpu& gpu, const wgpu::Texture& tex, std::uint32_t w, std::uint32_t h) {
  const std::uint32_t row = (w * 4 + 255U) & ~255U;
  wgpu::BufferDescriptor bd{};
  bd.size = static_cast<std::uint64_t>(row) * h;
  bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
  const wgpu::Buffer buf = gpu.device.CreateBuffer(&bd);
  wgpu::CommandEncoder enc = gpu.device.CreateCommandEncoder();
  wgpu::TexelCopyTextureInfo src{};
  src.texture = tex;
  wgpu::TexelCopyBufferInfo dst{};
  dst.buffer = buf;
  dst.layout.bytesPerRow = row;
  dst.layout.rowsPerImage = h;
  const wgpu::Extent3D size{w, h, 1};
  enc.CopyTextureToBuffer(&src, &dst, &size);
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu.queue.Submit(1, &cb);
  gpu.instance.WaitAny(buf.MapAsync(wgpu::MapMode::Read, 0, bd.size, wgpu::CallbackMode::WaitAnyOnly,
                                    [](wgpu::MapAsyncStatus, wgpu::StringView) {}),
                       UINT64_MAX);
  const auto* p = static_cast<const std::uint8_t*>(buf.GetConstMappedRange());
  std::vector<std::uint8_t> out(static_cast<std::size_t>(w) * h * 4);
  for (std::uint32_t y = 0; y < h; ++y) {
    std::copy_n(p + static_cast<std::size_t>(y) * row, w * 4, out.data() + static_cast<std::size_t>(y) * w * 4);
  }
  buf.Unmap();
  return out;
}

}  // namespace

TEST_CASE("compositor: a solid lands where the scene puts it, in its colour", "[gpu]") {
  auto& gpu = shared_gpu();
  if (!gpu) SKIP("no GPU adapter");
  render::Compositor comp;
  REQUIRE(comp.init(*gpu));
  constexpr std::uint32_t W = 320;
  constexpr std::uint32_t H = 180;
  wgpu::TextureDescriptor td{};
  td.size = {W, H, 1};
  td.format = wgpu::TextureFormat::RGBA8Unorm;
  td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc;
  const wgpu::Texture target = gpu->device.CreateTexture(&td);

  FrameScene scene;
  scene.compWidth = 1920;
  scene.compHeight = 1080;
  scene.background = {0.0F, 0.0F, 1.0F, 1.0F};  // blue
  DrawQuad q;
  q.affine = {960.0F, 0.0F, 0.0F, 540.0F, 0.0F, 0.0F};  // top-left quarter of the comp
  q.color = {1.0F, 0.0F, 0.0F, 1.0F};                  // opaque red
  scene.quads.push_back(q);
  wgpu::CommandEncoder enc = gpu->device.CreateCommandEncoder();
  comp.encode(enc, scene, target.CreateView(), W, H, 1.0);
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu->queue.Submit(1, &cb);
  const auto px = readback(*gpu, target, W, H);
  const auto at = [&](std::uint32_t x, std::uint32_t y) {
    const std::size_t i = (static_cast<std::size_t>(y) * W + x) * 4;
    return std::array<int, 4>{px[i], px[i + 1], px[i + 2], px[i + 3]};
  };
  REQUIRE(at(40, 20) == std::array<int, 4>{255, 0, 0, 255});   // inside the quad
  REQUIRE(at(280, 160) == std::array<int, 4>{0, 0, 255, 255});  // background
}

TEST_CASE("render thread: 1080p frames through the slot ring (headless throughput)", "[gpu][bench]") {
  std::mutex m;
  std::vector<frames::Message> sent;
  render::RenderThread* self = nullptr;
  std::atomic<int> delivered{0};
  render::RenderOptions opts;
  opts.highPerformance = true;
  render::RenderThread rt(
      opts,
      [&](const frames::Message& msg) {
        // The host: release every slot as soon as it is announced (Chromium
        // sampling instantly), so the engine is the bottleneck.
        if (const auto* f = std::get_if<frames::FrameReady>(&msg)) {
          ++delivered;
          self->release(f->generation, f->slot);
        }
        const std::lock_guard<std::mutex> lock(m);
        sent.push_back(msg);
      },
      nullptr);
  self = &rt;
  std::string error;
  if (!rt.start(error)) SKIP("no GPU: " + error);
  ViewportConfig v;
  v.viewport = 1;
  v.width = 1920;
  v.height = 1080;
  v.open = true;
  rt.configure(v);

  FrameScene scene;
  scene.compWidth = 1920;
  scene.compHeight = 1080;
  for (int i = 0; i < 20; ++i) {
    DrawQuad q;
    q.affine = {400.0F, 0.0F, 0.0F, 300.0F, static_cast<float>(i * 70), static_cast<float>(i * 30)};
    q.color = {0.2F, 0.5F, 0.9F, 0.5F};
    scene.quads.push_back(q);
  }
  // Warm up, then submit as fast as frames come back for 3 s.
  const auto t0 = std::chrono::steady_clock::now();
  std::int64_t frame = 0;
  int startDelivered = 0;
  auto measureStart = t0;
  while (std::chrono::steady_clock::now() - t0 < std::chrono::seconds(4)) {
    RenderJob job;
    job.scene = scene;
    job.frame = frame++;
    job.viewport = 1;
    rt.submit(std::move(job));
    std::this_thread::yield();  // keep a job always pending: measure the engine, not this loop
    if (startDelivered == 0 && std::chrono::steady_clock::now() - t0 > std::chrono::seconds(1)) {
      startDelivered = delivered.load();
      measureStart = std::chrono::steady_clock::now();
    }
  }
  const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - measureStart).count();
  const double fps = static_cast<double>(delivered.load() - startDelivered) / secs;
  const auto c = rt.counters();
  rt.stop();
  std::printf("[bench] 1080p through slots: %.1f fps delivered, gpu+wait %.2f ms/frame, adapter %s\n", fps,
              c.gpuFrameMs, rt.adapter().c_str());
  REQUIRE(fps > 30.0);
  const std::lock_guard<std::mutex> lock(m);
  REQUIRE(std::holds_alternative<frames::Slots>(sent.front()));
}
