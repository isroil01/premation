#include "audio_system.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

namespace premation::audio {

AudioSystem::AudioSystem(AudioSystemOptions options) : opt_(options), engine_(options.format) {
  const int n = std::max(1, opt_.conformThreads);
  for (int i = 0; i < n; ++i) workers_.emplace_back([this] { worker(); });
}

AudioSystem::~AudioSystem() {
  stop_device();
  {
    const std::scoped_lock lock(mu_);
    stopping_.store(true);
  }
  jobCv_.notify_all();
  for (auto& t : workers_) t.join();
  engine_.collect_garbage();
}

std::uint64_t AudioSystem::open_source(const std::string& path, std::string& error) {
  {
    const std::scoped_lock lock(mu_);
    auto it = byPath_.find(path);
    if (it != byPath_.end()) return it->second;
  }
  AudioStreamInfo info;
  if (!probe_audio(path, info, error)) return 0;
  Entry e;
  e.path = path;
  e.info = info;
  if (!info.hasAudio) {
    e.state = SourceState::silent;
  } else {
    const int ch = conformed_channels(info.channels);
    // The table is sized from the container's estimate with generous slack
    // (estimates are often short); no estimate → room for 12 hours.
    const double est = info.durationSec > 0 ? info.durationSec * 1.5 + 60 : 12 * 3600;
    const auto maxFrames = static_cast<std::int64_t>(std::ceil(est * opt_.format.sampleRate));
    e.data = std::make_shared<SourceData>(ch, opt_.format.sampleRate, maxFrames);
    e.state = SourceState::conforming;
  }
  std::uint64_t id = 0;
  {
    const std::scoped_lock lock(mu_);
    id = nextId_++;
    const bool queue = e.state == SourceState::conforming;
    sources_.emplace(id, std::move(e));
    byPath_.emplace(path, id);
    if (queue) jobs_.push_back(id);
  }
  jobCv_.notify_one();
  return id;
}

std::uint64_t AudioSystem::add_source(std::shared_ptr<SourceData> data) {
  const std::scoped_lock lock(mu_);
  const std::uint64_t id = nextId_++;
  Entry e;
  e.data = std::move(data);
  e.state = SourceState::ready;
  e.info.hasAudio = true;
  e.info.channels = e.data->channels();
  e.info.sampleRate = static_cast<int>(e.data->sample_rate());
  sources_.emplace(id, std::move(e));
  return id;
}

void AudioSystem::worker() {
  while (true) {
    std::uint64_t id = 0;
    std::string path;
    std::shared_ptr<SourceData> data;
    {
      std::unique_lock<std::mutex> lock(mu_);
      jobCv_.wait(lock, [this] { return stopping_.load() || !jobs_.empty(); });
      if (stopping_.load()) return;
      id = jobs_.front();
      jobs_.pop_front();
      const Entry& e = sources_.at(id);
      path = e.path;
      data = e.data;
    }
    std::string error;
    const bool ok = conform_audio(path, opt_.format.sampleRate, *data, &stopping_, error);
    const std::scoped_lock lock(mu_);
    sources_.at(id).state = ok ? SourceState::ready : SourceState::failed;
  }
}

SourcePtr AudioSystem::source(std::uint64_t id) const {
  const std::scoped_lock lock(mu_);
  auto it = sources_.find(id);
  return it == sources_.end() ? nullptr : it->second.data;
}

SourceState AudioSystem::state(std::uint64_t id) const {
  const std::scoped_lock lock(mu_);
  auto it = sources_.find(id);
  return it == sources_.end() ? SourceState::unknown : it->second.state;
}

AudioStreamInfo AudioSystem::info(std::uint64_t id) const {
  const std::scoped_lock lock(mu_);
  auto it = sources_.find(id);
  return it == sources_.end() ? AudioStreamInfo{} : it->second.info;
}

Program AudioSystem::resolve(Program p) const {
  p.format = opt_.format;
  const std::scoped_lock lock(mu_);
  for (Voice& v : p.voices) {
    if (v.data) continue;
    auto it = sources_.find(v.source);
    if (it != sources_.end()) v.data = it->second.data;
  }
  return p;
}

void AudioSystem::set_program(Program program) {
  auto p = std::make_shared<const Program>(resolve(std::move(program)));
  {
    const std::scoped_lock lock(mu_);
    program_ = p;
  }
  engine_.install(std::make_unique<RenderPlan>(p));
  engine_.collect_garbage();
}

ProgramPtr AudioSystem::program() const {
  const std::scoped_lock lock(mu_);
  return program_;
}

void AudioSystem::play(double fromSec, double rate, LoopMode loop, double rangeStartSec, double rangeEndSec) {
  const double sr = opt_.format.sampleRate;
  engine_.play(std::llround(fromSec * sr), rate, loop, std::llround(rangeStartSec * sr),
               rangeEndSec > rangeStartSec ? std::llround(rangeEndSec * sr) : INT64_MAX);
}

void AudioSystem::pause() { engine_.pause(); }

void AudioSystem::seek(double sec, bool scrub) { engine_.seek(std::llround(sec * opt_.format.sampleRate), scrub); }

void AudioSystem::set_preview(bool muted, double volume, bool scrubAudio) {
  engine_.set_output(muted, volume, scrubAudio);
}

ClockReading AudioSystem::playhead(SteadyClock::time_point now) const noexcept {
  return engine_.playhead(steady_seconds(now));
}

bool AudioSystem::start_device(std::string& error) {
  if (device_) return true;
  const DeviceOptions o{opt_.format.sampleRate, opt_.format.channels, opt_.periodMs};
  DeviceCallback cb = [this](float* out, std::uint32_t frames, std::int64_t written, double t, std::int64_t played) {
    engine_.process(out, frames, written, t, played);
  };
#if PREMATION_HAVE_MINIAUDIO
  if (opt_.useDevice) {
    std::string why;
    device_ = open_default_device(o, cb, why);
    if (device_ && !device_->start(why)) device_.reset();
    if (device_) return true;
    error = why;  // fall through to the null device, but say why
  }
#endif
  device_ = std::make_unique<NullDevice>(o, cb);
  std::string why;
  if (!device_->start(why)) {
    error = why;
    device_.reset();
    return false;
  }
  return true;
}

void AudioSystem::stop_device() {
  if (!device_) return;
  device_->stop();
  device_.reset();
}

DeviceInfo AudioSystem::device_info() const { return device_ ? device_->info() : DeviceInfo{}; }

std::vector<std::vector<float>> AudioSystem::render(const Program& program, double startSec,
                                                    std::int64_t frames) const {
  auto p = std::make_shared<const Program>(resolve(program));
  return render_offline(p, std::llround(startSec * opt_.format.sampleRate), frames);
}

WaveformPeaksResult AudioSystem::peaks(std::uint64_t id, double fromSec, double durationSec, std::uint32_t buckets,
                                       bool monoMix) const {
  const SourcePtr s = source(id);
  if (!s) return {};
  return query_peaks(*s, fromSec, durationSec, buckets, monoMix);
}

}  // namespace premation::audio
