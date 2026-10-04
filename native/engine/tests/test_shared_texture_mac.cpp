// Route C on macOS (shared_texture_ffi_mac.cpp): IOSurface slots imported into
// Dawn, written through BeginAccess/EndAccess with the MTLSharedEvent fences
// carried between accesses, and readable by id from "another process" — the
// IOSurfaceLookup that premation-host-bridge.node does in Electron main.
#include <catch2/catch_test_macros.hpp>

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurfaceRef.h>
#include <unistd.h>

#include <chrono>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <variant>
#include <vector>

#include "gpu.hpp"
#include "render_thread.hpp"
#include "shared_texture_ffi.hpp"

using namespace premation;

namespace {

void clear_slot(const Gpu& gpu, const shared::Slot& slot, double r, double g, double b) {
  wgpu::CommandEncoder enc = gpu.device.CreateCommandEncoder();
  wgpu::RenderPassColorAttachment color{};
  color.view = slot.view;
  color.loadOp = wgpu::LoadOp::Clear;
  color.storeOp = wgpu::StoreOp::Store;
  color.clearValue = {r, g, b, 1.0};
  wgpu::RenderPassDescriptor pass{};
  pass.colorAttachmentCount = 1;
  pass.colorAttachments = &color;
  wgpu::RenderPassEncoder p = enc.BeginRenderPass(&pass);
  p.End();
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu.queue.Submit(1, &cb);
}

/// The first pixel of the surface named `id`, as another process would see it.
std::uint32_t first_pixel(std::uint64_t id) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  IOSurfaceRef s = IOSurfaceLookup(static_cast<IOSurfaceID>(id));
#pragma clang diagnostic pop
  REQUIRE(s != nullptr);
  REQUIRE(IOSurfaceLock(s, kIOSurfaceLockReadOnly, nullptr) == 0);
  std::uint32_t px = 0;
  std::memcpy(&px, IOSurfaceGetBaseAddress(s), sizeof(px));
  (void)IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, nullptr);
  CFRelease(s);
  return px;
}

}  // namespace

TEST_CASE("macOS shared textures: IOSurface slots written by Dawn, read by id", "[gpu][shared]") {
  std::optional<Gpu> gpu = create_gpu(true, true, 0);
  if (!gpu) SKIP("no GPU");
  if (!gpu->sharedTextureCapable) SKIP("adapter lacks SharedTextureMemoryIOSurface / SharedFenceMTLSharedEvent");
  // A virtualised Metal device (the GitHub macOS runner) advertises the
  // features but refuses BeginAccess; route C is verified on real Macs
  // (docs/VERIFY_ON_TEST_MACHINE.md, p0-platform).
  if (gpu->adapterName.find("Paravirtual") != std::string::npos) SKIP("virtualised Metal device: " + gpu->adapterName);

  shared::SharedTexturePool pool;
  std::string error;
  REQUIRE(pool.init(*gpu, 64, 32, 2, static_cast<std::uint32_t>(getpid()), error));
  REQUIRE(pool.slots().size() == 2);
  REQUIRE(pool.slots()[0].remoteHandle != 0);
  REQUIRE(pool.slots()[0].remoteHandle != pool.slots()[1].remoteHandle);

  shared::Slot& slot = pool.slots()[0];
  // Two accesses in a row: the second BeginAccess waits on the fences the
  // first EndAccess exported.
  REQUIRE(pool.begin_access(slot));
  clear_slot(*gpu, slot, 1.0, 0.0, 0.0);
  REQUIRE(pool.end_access(slot));
  REQUIRE(pool.begin_access(slot));
  clear_slot(*gpu, slot, 0.0, 1.0, 0.0);
  REQUIRE(pool.end_access(slot));
  wait_idle(*gpu);

  // 'RGBA' in memory order: R, G, B, A bytes → little-endian 0xAABBGGRR.
  CHECK(first_pixel(slot.remoteHandle) == 0xFF00FF00U);

  pool.close_remote_handles();
  CHECK(pool.slots()[0].remoteHandle == 0);
}

TEST_CASE("macOS shared textures: the render thread announces a shared ring to a host", "[gpu][shared]") {
  std::mutex m;
  std::vector<api::FrameSlots> rings;
  render::RenderOptions opts;
  opts.hostPid = static_cast<std::uint32_t>(getpid());
  render::RenderThread rt(
      opts,
      [&](const frames::Message& msg) {
        if (const auto* s = std::get_if<api::FrameSlots>(&msg.v)) {
          const std::lock_guard<std::mutex> lock(m);
          rings.push_back(*s);
        }
      },
      nullptr);
  std::string error;
  if (!rt.start(error)) SKIP("no GPU: " + error);
  if (!rt.shared_supported()) SKIP("no shared-texture features on this adapter");
  rt.set_shared(true);
  ViewportConfig v;
  v.viewport = 1;
  v.width = 128;
  v.height = 72;
  v.open = true;
  rt.configure(v);
  for (int i = 0; i < 200; ++i) {
    {
      const std::lock_guard<std::mutex> lock(m);
      if (!rings.empty()) break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  rt.stop();
  const std::lock_guard<std::mutex> lock(m);
  REQUIRE_FALSE(rings.empty());
  CHECK(rings.back().shared);
  REQUIRE(rings.back().handles.size() == 3);
  for (const std::uint64_t h : rings.back().handles) CHECK(h != 0);
}
