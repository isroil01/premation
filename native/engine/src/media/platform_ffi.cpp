#include "platform_ffi.hpp"

#if defined(_WIN32)
#include <d3d12.h>
#include <windows.h>
#include <psapi.h>
#include <wrl/client.h>

#include <dawn/native/D3D12Backend.h>
#else
#include <sys/resource.h>
#endif

namespace premation::media::platform {

std::uint64_t adapter_luid(const wgpu::Device& device) {
#if defined(_WIN32)
  if (device == nullptr) return 0;
  const Microsoft::WRL::ComPtr<ID3D12Device> d3d12 = dawn::native::d3d12::GetD3D12Device(device.Get());
  if (!d3d12) return 0;
  const LUID l = d3d12->GetAdapterLuid();
  return (static_cast<std::uint64_t>(static_cast<std::uint32_t>(l.HighPart)) << 32U) | l.LowPart;
#else
  (void)device;
  return 0;
#endif
}

ProcessUsage process_usage() {
  ProcessUsage u;
#if defined(_WIN32)
  FILETIME created{};
  FILETIME exited{};
  FILETIME kernel{};
  FILETIME user{};
  if (GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) != 0) {
    const auto ticks = [](const FILETIME& f) {
      return (static_cast<std::uint64_t>(f.dwHighDateTime) << 32U) | f.dwLowDateTime;
    };
    u.cpuMs = static_cast<double>(ticks(kernel) + ticks(user)) / 10'000.0;
  }
  PROCESS_MEMORY_COUNTERS_EX pmc{};
  pmc.cb = sizeof(pmc);
  if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc)) != 0) {  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): the documented EX-struct idiom
    u.workingSet = pmc.WorkingSetSize;
    u.peakWorkingSet = pmc.PeakWorkingSetSize;
    u.privateBytes = pmc.PrivateUsage;
  }
#else
  rusage r{};
  if (getrusage(RUSAGE_SELF, &r) == 0) {
    u.cpuMs = static_cast<double>(r.ru_utime.tv_sec + r.ru_stime.tv_sec) * 1000.0 +
              static_cast<double>(r.ru_utime.tv_usec + r.ru_stime.tv_usec) / 1000.0;
    u.peakWorkingSet = static_cast<std::uint64_t>(r.ru_maxrss) * 1024U;
  }
#endif
  return u;
}

}  // namespace premation::media::platform
