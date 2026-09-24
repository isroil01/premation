// default_frame_cache_budget — the OS half of the frame cache's sizing
// (frame_cache.hpp): how much local video memory the render adapter offers.
#include "frame_cache.hpp"

#include <algorithm>
#include <cstdint>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <dxgi1_4.h>
#include <windows.h>
#include <wrl/client.h>
#endif

namespace premation::render {
namespace {

constexpr std::size_t kGiB = std::size_t{1} << 30U;
constexpr std::size_t kFallback = kGiB;
constexpr std::size_t kCap = 4 * kGiB;
constexpr std::size_t kFloor = 256 * (std::size_t{1} << 20U);

std::size_t from_local_budget(std::uint64_t budget) {
  if (budget == 0) return kFallback;
  // A quarter: the render graph's own pools, footage textures, plugins and
  // Chromium's compositor share the same memory.
  return std::clamp(static_cast<std::size_t>(budget / 4), kFloor, kCap);
}

}  // namespace

#if defined(_WIN32)

// COM's IID_PPV_ARGS is __uuidof, which -Wpedantic calls a language extension.
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wlanguage-extension-token"
#endif
std::size_t default_frame_cache_budget(std::uint32_t vendorId, std::uint32_t deviceId) {
  using Microsoft::WRL::ComPtr;
  ComPtr<IDXGIFactory4> factory;
  if (FAILED(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)))) return kFallback;
  ComPtr<IDXGIAdapter1> adapter;
  for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
    DXGI_ADAPTER_DESC1 desc{};
    if (FAILED(adapter->GetDesc1(&desc))) continue;
    if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0U) continue;
    const bool match = vendorId == 0 || (desc.VendorId == vendorId && (deviceId == 0 || desc.DeviceId == deviceId));
    if (!match) continue;
    ComPtr<IDXGIAdapter3> a3;
    if (FAILED(adapter.As(&a3))) return from_local_budget(desc.DedicatedVideoMemory);
    DXGI_QUERY_VIDEO_MEMORY_INFO info{};
    if (FAILED(a3->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &info))) {
      return from_local_budget(desc.DedicatedVideoMemory);
    }
    // An integrated GPU reports a small local segment; its frames live in
    // shared system memory, which is where its budget really is.
    std::uint64_t budget = info.Budget;
    if (desc.DedicatedVideoMemory < (std::uint64_t{512} << 20U)) {
      DXGI_QUERY_VIDEO_MEMORY_INFO shared{};
      if (SUCCEEDED(a3->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_NON_LOCAL, &shared))) {
        budget = std::max(budget, shared.Budget);
      }
    }
    return from_local_budget(budget);
  }
  return kFallback;
}
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

#else

std::size_t default_frame_cache_budget(std::uint32_t /*vendorId*/, std::uint32_t /*deviceId*/) {
  return kFallback;  // Metal / Vulkan budgets: not queried yet
}

#endif

}  // namespace premation::render
