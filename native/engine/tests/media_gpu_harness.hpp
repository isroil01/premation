// Shared by the media GPU tests: a Dawn device with the media features, and an
// RGBA16F texture read back to floats.
#pragma once

#include <catch2/catch_test_macros.hpp>

#include <webgpu/webgpu_cpp.h>

#include <cmath>
#include <cstring>
#include <optional>
#include <string_view>
#include <vector>

#include "frame_convert.hpp"

namespace premation::media::testing {

struct Gpu {
  wgpu::Instance instance;
  wgpu::Adapter adapter;
  wgpu::Device device;
};

inline std::optional<Gpu> make_gpu() {
  static constexpr auto kTimedWaitAny = wgpu::InstanceFeatureName::TimedWaitAny;
  wgpu::InstanceDescriptor id{};
  id.requiredFeatureCount = 1;
  id.requiredFeatures = &kTimedWaitAny;
  Gpu g;
  g.instance = wgpu::CreateInstance(&id);
  wgpu::RequestAdapterOptions o{};
#if defined(_WIN32)
  o.backendType = wgpu::BackendType::D3D12;
#endif
  o.powerPreference = wgpu::PowerPreference::HighPerformance;
  g.instance.WaitAny(g.instance.RequestAdapter(&o, wgpu::CallbackMode::WaitAnyOnly,
                                               [&g](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView) {
                                                 if (s == wgpu::RequestAdapterStatus::Success) g.adapter = std::move(a);
                                               }),
                     UINT64_MAX);
  if (g.adapter == nullptr) return std::nullopt;
  const auto features = wanted_device_features(g.adapter);
  wgpu::DeviceDescriptor dd{};
  dd.requiredFeatureCount = features.size();
  dd.requiredFeatures = features.data();
  dd.SetUncapturedErrorCallback([](const wgpu::Device&, wgpu::ErrorType, wgpu::StringView msg) {
    FAIL_CHECK("Dawn error: " << std::string_view(msg.data, msg.length == wgpu::kStrlen ? std::strlen(msg.data) : msg.length));
  });
  g.instance.WaitAny(g.adapter.RequestDevice(&dd, wgpu::CallbackMode::WaitAnyOnly,
                                             [&g](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView) {
                                               if (s == wgpu::RequestDeviceStatus::Success) g.device = std::move(d);
                                             }),
                     UINT64_MAX);
  if (g.device == nullptr) return std::nullopt;
  return g;
}

inline float half_to_float(std::uint16_t h) {
  const std::uint32_t s = (h >> 15U) & 1U;
  const std::uint32_t e = (h >> 10U) & 0x1FU;
  const std::uint32_t m = h & 0x3FFU;
  float v = 0;
  if (e == 0) {
    v = std::ldexp(static_cast<float>(m), -24);
  } else if (e == 31) {
    v = m == 0 ? INFINITY : NAN;
  } else {
    v = std::ldexp(static_cast<float>(m | 0x400U), static_cast<int>(e) - 25);
  }
  return s != 0 ? -v : v;
}

/// RGBA16F texture → float RGBA, top-down.
inline std::vector<float> read_back(const Gpu& g, const ConvertedFrame& t) {
  const std::uint32_t rowBytes = (t.width * 8 + 255) & ~255U;
  wgpu::BufferDescriptor bd{};
  bd.size = std::uint64_t{rowBytes} * t.height;
  bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
  const wgpu::Buffer buf = g.device.CreateBuffer(&bd);
  wgpu::CommandEncoder enc = g.device.CreateCommandEncoder();
  wgpu::TexelCopyTextureInfo src{};
  src.texture = t.texture;
  wgpu::TexelCopyBufferInfo dst{};
  dst.buffer = buf;
  dst.layout.bytesPerRow = rowBytes;
  dst.layout.rowsPerImage = t.height;
  const wgpu::Extent3D ext{t.width, t.height, 1};
  enc.CopyTextureToBuffer(&src, &dst, &ext);
  const wgpu::CommandBuffer cb = enc.Finish();
  g.device.GetQueue().Submit(1, &cb);
  bool done = false;
  g.instance.WaitAny(buf.MapAsync(wgpu::MapMode::Read, 0, bd.size, wgpu::CallbackMode::WaitAnyOnly,
                                  [&done](wgpu::MapAsyncStatus s, wgpu::StringView) { done = s == wgpu::MapAsyncStatus::Success; }),
                     UINT64_MAX);
  REQUIRE(done);
  const auto* bytes = static_cast<const std::uint8_t*>(buf.GetConstMappedRange(0, bd.size));
  std::vector<float> out(std::size_t{t.width} * t.height * 4);
  for (std::uint32_t y = 0; y < t.height; ++y) {
    for (std::uint32_t x = 0; x < t.width * 4; ++x) {
      std::uint16_t h = 0;
      std::memcpy(&h, bytes + std::size_t{y} * rowBytes + std::size_t{x} * 2, 2);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      out[std::size_t{y} * t.width * 4 + x] = half_to_float(h);
    }
  }
  buf.Unmap();
  return out;
}

}  // namespace premation::media::testing
