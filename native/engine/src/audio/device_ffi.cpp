// miniaudio — the only file that includes it (CLAUDE.md: FFI in *_ffi.cpp).
// Built only when the vcpkg `engine` feature provides miniaudio.h.

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <utility>

#include "device.hpp"

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#endif

#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MINIAUDIO_IMPLEMENTATION
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#endif
#include <miniaudio.h>  // NOLINT: third-party single-file library
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

namespace premation::audio {

namespace {

class MiniaudioDevice final : public AudioDevice {
 public:
  MiniaudioDevice(const DeviceOptions& opt, DeviceCallback cb) : opt_(opt), cb_(std::move(cb)) {}
  ~MiniaudioDevice() override {
    if (inited_) ma_device_uninit(dev_.get());
  }
  MiniaudioDevice(const MiniaudioDevice&) = delete;
  MiniaudioDevice& operator=(const MiniaudioDevice&) = delete;
  MiniaudioDevice(MiniaudioDevice&&) = delete;
  MiniaudioDevice& operator=(MiniaudioDevice&&) = delete;

  bool init(std::string& error) {
    dev_ = std::make_unique<ma_device>();
    ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
    cfg.playback.format = ma_format_f32;
    cfg.playback.channels = static_cast<ma_uint32>(opt_.channels);
    cfg.sampleRate = static_cast<ma_uint32>(opt_.sampleRate);
    cfg.dataCallback = &MiniaudioDevice::on_data;
    cfg.pUserData = this;
    cfg.performanceProfile = ma_performance_profile_low_latency;
    if (opt_.periodMs > 0) cfg.periodSizeInMilliseconds = static_cast<ma_uint32>(opt_.periodMs);
    // The engine renders straight into the backend's buffer: no intermediary
    // fixed-size buffer (it would add a period of latency the clock would
    // then have to guess at).
    cfg.noFixedSizedCallback = MA_TRUE;
    cfg.noClip = MA_TRUE;  // the master limiter owns the ceiling
    const ma_result r = ma_device_init(nullptr, &cfg, dev_.get());
    if (r != MA_SUCCESS) {
      error = std::string("ma_device_init: ") + ma_result_description(r);
      return false;
    }
    inited_ = true;
    ma_device* d = dev_.get();
    info_.backend = ma_get_backend_name(d->pContext->backend);
    info_.name = d->playback.name;
    info_.sampleRate = static_cast<int>(d->sampleRate);
    info_.deviceRate = static_cast<int>(d->playback.internalSampleRate);
    info_.channels = static_cast<int>(d->playback.channels);
    info_.periodFrames = static_cast<int>(d->playback.internalPeriodSizeInFrames);
    info_.periods = static_cast<int>(d->playback.internalPeriods);
    rateRatio_ = info_.deviceRate > 0 ? static_cast<double>(info_.sampleRate) / info_.deviceRate : 1.0;
    // Static depth estimate (used where the backend cannot report padding).
    info_.latencyFrames = static_cast<double>(info_.periodFrames) * info_.periods * rateRatio_;
    return true;
  }

  bool start(std::string& error) override {
    written_ = 0;
    const ma_result r = ma_device_start(dev_.get());
    if (r != MA_SUCCESS) {
      error = std::string("ma_device_start: ") + ma_result_description(r);
      return false;
    }
    return true;
  }
  void stop() override {
    if (inited_) ma_device_stop(dev_.get());
  }
  [[nodiscard]] const DeviceInfo& info() const noexcept override { return info_; }

 private:
  static void on_data(ma_device* d, void* out, const void* /*in*/, ma_uint32 frames) {
    auto* self = static_cast<MiniaudioDevice*>(d->pUserData);
    self->render(static_cast<float*>(out), frames);
  }

  /// Frames queued in the backend buffer (not yet consumed by the device),
  /// in mix-rate frames; negative when the backend cannot say.
  double queued() noexcept {
#if defined(MA_HAS_WASAPI)
    ma_device* d = dev_.get();
    if (d->pContext->backend == ma_backend_wasapi && d->wasapi.pAudioClientPlayback != nullptr) {
      ma_uint32 padding = 0;
      auto* client = static_cast<ma_IAudioClient*>(d->wasapi.pAudioClientPlayback);
      if (SUCCEEDED(ma_IAudioClient_GetCurrentPadding(client, &padding))) {
        return static_cast<double>(padding) * rateRatio_;
      }
    }
#endif
    return -1;
  }

  void render(float* out, ma_uint32 frames) noexcept {
    const double t = steady_seconds(SteadyClock::now());
    const double q = queued();
    const double depth = q >= 0 ? q : info_.latencyFrames;
    const auto played = static_cast<std::int64_t>(std::llround(static_cast<double>(written_) - depth));
    cb_(out, frames, written_, t, played);
    written_ += frames;
  }

  DeviceOptions opt_;
  DeviceCallback cb_;
  std::unique_ptr<ma_device> dev_;
  bool inited_ = false;
  DeviceInfo info_;
  double rateRatio_ = 1;
  std::int64_t written_ = 0;
};

}  // namespace

std::unique_ptr<AudioDevice> open_default_device(const DeviceOptions& options, DeviceCallback cb,
                                                 std::string& error) {
  auto d = std::make_unique<MiniaudioDevice>(options, std::move(cb));
  if (!d->init(error)) return nullptr;
  return d;
}

}  // namespace premation::audio
