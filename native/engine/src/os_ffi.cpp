#include "os_ffi.hpp"

#include <chrono>
#include <cstdio>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#include <timeapi.h>
#else
#include <sys/resource.h>
#include <unistd.h>
#endif

namespace premation::os {

void set_binary_stdio() {
#ifdef _WIN32
  (void)_setmode(_fileno(stdout), _O_BINARY);
  (void)_setmode(_fileno(stdin), _O_BINARY);
#endif
}

void set_dpi_aware() {
#ifdef _WIN32
  (void)SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
#endif
}

double process_cpu_ms() {
#ifdef _WIN32
  FILETIME created{};
  FILETIME exited{};
  FILETIME kernel{};
  FILETIME user{};
  if (GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) == 0) return 0.0;
  const auto ticks = [](const FILETIME& f) {
    return (static_cast<std::uint64_t>(f.dwHighDateTime) << 32U) | f.dwLowDateTime;
  };
  return static_cast<double>(ticks(kernel) + ticks(user)) / 10'000.0;  // 100 ns ticks
#else
  rusage u{};
  getrusage(RUSAGE_SELF, &u);
  const auto ms = [](const timeval& t) {
    return static_cast<double>(t.tv_sec) * 1000.0 + static_cast<double>(t.tv_usec) / 1000.0;
  };
  return ms(u.ru_utime) + ms(u.ru_stime);
#endif
}

void high_resolution_timer(bool on) {
#ifdef _WIN32
  static bool active = false;
  if (on == active) return;
  active = on;
  if (on) {
    (void)timeBeginPeriod(1);
  } else {
    (void)timeEndPeriod(1);
  }
#else
  (void)on;
#endif
}

double epoch_us() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<double>(std::chrono::duration_cast<std::chrono::nanoseconds>(now).count()) / 1000.0;
}

bool write_stdout(const void* data, std::size_t bytes) {
#ifdef _WIN32
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  const auto* p = static_cast<const std::uint8_t*>(data);
  while (bytes > 0) {
    // WriteFile takes a DWORD; chunk to stay well inside it.
    constexpr std::size_t kChunk = std::size_t{1} << 30U;
    const DWORD want = static_cast<DWORD>(bytes < kChunk ? bytes : kChunk);
    DWORD wrote = 0;
    if (WriteFile(out, p, want, &wrote, nullptr) == 0 || wrote == 0) return false;
    p += wrote;
    bytes -= wrote;
  }
  return true;
#else
  const auto* p = static_cast<const std::uint8_t*>(data);
  while (bytes > 0) {
    const ssize_t n = ::write(STDOUT_FILENO, p, bytes);
    if (n <= 0) return false;
    p += n;
    bytes -= static_cast<std::size_t>(n);
  }
  return true;
#endif
}

}  // namespace premation::os
