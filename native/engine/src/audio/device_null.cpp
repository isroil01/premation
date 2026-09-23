#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "device.hpp"

namespace premation::audio {

NullDevice::NullDevice(const DeviceOptions& options, DeviceCallback cb, int periodFrames) : cb_(std::move(cb)) {
  info_.backend = "null";
  info_.name = "steady-clock";
  info_.sampleRate = options.sampleRate;
  info_.deviceRate = options.sampleRate;
  info_.channels = options.channels;
  info_.periodFrames = periodFrames;
  info_.periods = 2;
  info_.latencyFrames = static_cast<double>(periodFrames) * 2;
}

NullDevice::~NullDevice() { stop(); }

bool NullDevice::start(std::string& /*error*/) {
  if (run_.exchange(true)) return true;
  thread_ = std::thread([this] {
    const DeviceInfo info = info_;
    std::vector<float> buf(static_cast<std::size_t>(info.periodFrames) * static_cast<std::size_t>(info.channels));
    const auto t0 = SteadyClock::now();
    std::int64_t written = 0;
    const auto period = static_cast<std::int64_t>(info.periodFrames);
    while (run_.load(std::memory_order_relaxed)) {
      // Keep two periods queued ahead of a "consumption" paced by the steady
      // clock — a device whose crystal is the CPU's.
      const double elapsed = std::chrono::duration<double>(SteadyClock::now() - t0).count();
      const auto consumed = static_cast<std::int64_t>(elapsed * info.sampleRate);
      if (written - consumed < 2 * period) {
        cb_(buf.data(), static_cast<std::uint32_t>(period), written, steady_seconds(SteadyClock::now()),
            std::min(written, consumed));
        written += period;
        continue;
      }
      std::this_thread::sleep_for(std::chrono::microseconds(500));
    }
  });
  return true;
}

void NullDevice::stop() {
  if (!run_.exchange(false)) return;
  if (thread_.joinable()) thread_.join();
}

}  // namespace premation::audio
