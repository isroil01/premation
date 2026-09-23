#include "realtime.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <thread>

namespace premation::audio {

namespace {

constexpr double kPi = std::numbers::pi;
constexpr double kGrainSec = 0.06;  // one scrub grain

/// Raised-cosine fade-in weight at step `i` of `n` (0 → 1).
float fade_in(std::size_t i, std::size_t n) noexcept {
  if (n == 0) return 1;
  return static_cast<float>(0.5 - 0.5 * std::cos(kPi * static_cast<double>(i) / static_cast<double>(n)));
}

}  // namespace

// ── Reader ──────────────────────────────────────────────────────────────────

RealtimeEngine::Reader::Reader(int channels) : channels_(channels) {}

void RealtimeEngine::Reader::set_plan(RenderPlan* p) noexcept {
  plan_ = p;
  q_ = INT64_MIN;
  prevQ_ = INT64_MIN;
}

void RealtimeEngine::Reader::load(std::int64_t q) noexcept {
  if (q_ != INT64_MIN && q == q_ + kQuantum) {
    prev_ = cur_;
    prevQ_ = q_;
  } else {
    prevQ_ = INT64_MIN;
  }
  q_ = q;
  std::array<float*, 2> out{cur_[0].data(), cur_[1].data()};
  if (plan_ != nullptr) {
    plan_->render(q, out.data());
    if (channels_ == 1) cur_[1] = cur_[0];
  } else {
    for (auto& c : cur_) c.fill(0);
  }
}

float RealtimeEngine::Reader::get(int ch, std::int64_t frame) noexcept {
  const std::int64_t q = (frame >= 0 ? frame / kQuantum : -((-frame + kQuantum - 1) / kQuantum)) * kQuantum;
  const auto c = static_cast<std::size_t>(ch);
  if (q == q_) return cur_[c][static_cast<std::size_t>(frame - q)];
  if (q == prevQ_) return prev_[c][static_cast<std::size_t>(frame - q)];
  load(q);
  return cur_[c][static_cast<std::size_t>(frame - q)];
}

float RealtimeEngine::Reader::sample(int ch, double pos) noexcept {
  const double fl = std::floor(pos);
  const auto i = static_cast<std::int64_t>(fl);
  const double f = pos - fl;
  const float a = get(ch, i);
  if (f == 0) return a;
  const float b = get(ch, i + 1);
  return static_cast<float>((1 - f) * static_cast<double>(a) + f * static_cast<double>(b));
}

// ── RealtimeEngine ──────────────────────────────────────────────────────────

RealtimeEngine::RealtimeEngine(MixFormat format)
    : fmt_(format),
      fade_(static_cast<std::size_t>(std::lround(0.005 * format.sampleRate))),
      clock_(format.sampleRate),
      reader_(format.channels) {
  tail_.assign(fade_ * static_cast<std::size_t>(fmt_.channels), 0.0F);
  for (auto& m : meter_) m.store(0, std::memory_order_relaxed);
  clock_.push(PlaySegment{});
}

RealtimeEngine::~RealtimeEngine() {
  const std::unique_ptr<RenderPlan> own(plan_);
  while (auto c = cmds_.pop()) {
    const std::unique_ptr<RenderPlan> pending(c->plan);
  }
  collect_garbage();
  for (std::size_t i = 0; i < overflowN_; ++i) {
    const std::unique_ptr<RenderPlan> r(retireOverflow_[i]);
  }
}

void RealtimeEngine::install(std::unique_ptr<RenderPlan> plan) {
  Cmd c;
  c.type = CmdType::install;
  c.plan = plan.release();
  while (!cmds_.push(c)) {
    collect_garbage();
    std::this_thread::yield();
  }
}

void RealtimeEngine::play(std::int64_t from, double rate, LoopMode mode, std::int64_t rangeStart,
                          std::int64_t rangeEnd) {
  Cmd c;
  c.type = CmdType::play;
  c.frame = from;
  c.rate = rate;
  c.mode = mode;
  c.a = rangeStart;
  c.b = rangeEnd;
  while (!cmds_.push(c)) std::this_thread::yield();
}

void RealtimeEngine::pause() {
  Cmd c;
  c.type = CmdType::pause;
  while (!cmds_.push(c)) std::this_thread::yield();
}

void RealtimeEngine::seek(std::int64_t frame, bool scrub) {
  Cmd c;
  c.type = CmdType::seek;
  c.frame = frame;
  c.scrub = scrub;
  while (!cmds_.push(c)) std::this_thread::yield();
}

void RealtimeEngine::set_output(bool muted, double volume, bool scrubAudio) {
  Cmd c;
  c.type = CmdType::output;
  c.muted = muted;
  c.volume = volume;
  c.scrubAudio = scrubAudio;
  while (!cmds_.push(c)) std::this_thread::yield();
}

void RealtimeEngine::set_device_latency(double frames) { deviceLatencyIn_.store(frames, std::memory_order_relaxed); }

void RealtimeEngine::collect_garbage() {
  while (auto p = retired_.pop()) {
    const std::unique_ptr<RenderPlan> r(*p);
  }
}

void RealtimeEngine::retire(RenderPlan* p) noexcept {
  if (p == nullptr) return;
  if (!retired_.push(p)) {
    if (overflowN_ < retireOverflow_.size()) {
      retireOverflow_[overflowN_++] = p;
    }
    // else: leaked rather than freed on the audio thread (cannot happen with a
    // control thread that collects; 80 plans outstanding).
  }
}

void RealtimeEngine::segment(std::int64_t deviceFrame) noexcept {
  PlaySegment s;
  s.deviceFrame = deviceFrame;
  s.mediaFrame = pos_;
  s.playing = mode_ == Mode::playing;
  s.rate = s.playing ? rate_ : 0;
  s.unfolded = unfolded_;
  s.epoch = epoch_;
  clock_.push(s);
}

void RealtimeEngine::capture_tail() noexcept {
  // Whatever is still fading out of an earlier tail joins the new one.
  const auto ch = static_cast<std::size_t>(fmt_.channels);
  std::array<float, 2> rem{};
  std::vector<float>& t = tail_;
  // Bake the old tail's remaining samples with their fade-out weights.
  const std::size_t oldLeft = tailPos_ < tailLen_ ? tailLen_ - tailPos_ : 0;
  for (std::size_t i = 0; i < fade_; ++i) {
    for (std::size_t c = 0; c < ch; ++c) rem[c] = 0;
    if (i < oldLeft) {
      const std::size_t k = tailPos_ + i;
      const float w = 1 - fade_in(k, tailLen_);
      for (std::size_t c = 0; c < ch; ++c) rem[c] = t[k * ch + c] * w;
    }
    // Staged in place: index i ≤ k, so reading k before writing i is safe.
    for (std::size_t c = 0; c < ch; ++c) t[i * ch + c] = rem[c];
  }
  if (mode_ != Mode::stopped && plan_ != nullptr && rate_ > 0) {
    double p = pos_;
    for (std::size_t i = 0; i < fade_; ++i) {
      const float w = fadeIn_ > i ? fade_in(fade_ - fadeIn_ + i, fade_) : 1.0F;
      for (std::size_t c = 0; c < ch; ++c) {
        t[i * ch + c] += reader_.sample(static_cast<int>(c), p) * w;
      }
      p += rate_;
    }
  }
  tailLen_ = fade_;
  tailPos_ = 0;
}

void RealtimeEngine::apply(const Cmd& c, std::int64_t deviceFrame) noexcept {
  switch (c.type) {
    case CmdType::install: {
      if (mode_ != Mode::stopped) capture_tail();
      retire(plan_);
      plan_ = c.plan;
      reader_.set_plan(plan_);
      if (mode_ != Mode::stopped) fadeIn_ = fade_;
      break;
    }
    case CmdType::play: {
      capture_tail();
      pos_ = static_cast<double>(c.frame);
      rate_ = c.rate;
      loop_ = c.mode;
      rangeA_ = c.a;
      rangeB_ = c.b > c.a ? c.b : INT64_MAX;
      mode_ = Mode::playing;
      fadeIn_ = fade_;
      unfolded_ = 0;
      ++epoch_;
      segment(deviceFrame);
      break;
    }
    case CmdType::pause: {
      if (mode_ != Mode::stopped) capture_tail();
      mode_ = Mode::stopped;
      ++epoch_;
      segment(deviceFrame);
      break;
    }
    case CmdType::seek: {
      if (mode_ == Mode::playing) {
        capture_tail();
        pos_ = static_cast<double>(c.frame);
        fadeIn_ = fade_;
      } else {
        pos_ = static_cast<double>(c.frame);
        if (c.scrub && scrubAudio_ && !muted_) {
          capture_tail();
          mode_ = Mode::grain;
          rate_ = 1;
          grainLeft_ = std::llround(kGrainSec * fmt_.sampleRate);
          fadeIn_ = fade_;
        } else if (mode_ == Mode::grain) {
          capture_tail();
          mode_ = Mode::stopped;
        }
      }
      ++epoch_;
      segment(deviceFrame);
      break;
    }
    case CmdType::output:
      muted_ = c.muted;
      volume_ = static_cast<float>(std::max(0.0, c.volume));
      scrubAudio_ = c.scrubAudio;
      break;
  }
}

void RealtimeEngine::process(float* interleaved, std::uint32_t frames, std::int64_t deviceFrame, double t,
                             std::int64_t playedFrame) noexcept {
  clock_.on_callback(playedFrame, t);
  while (auto c = cmds_.pop()) apply(*c, deviceFrame);
  // Retry retirements that found the queue full.
  while (overflowN_ > 0 && retired_.push(retireOverflow_[overflowN_ - 1])) --overflowN_;
  const double lat = deviceLatencyIn_.load(std::memory_order_relaxed) +
                     (plan_ != nullptr ? static_cast<double>(plan_->latency()) : 0.0);
  clock_.set_latency_frames(lat);

  const auto ch = static_cast<std::size_t>(fmt_.channels);
  const float target = muted_ ? 0.0F : volume_;
  std::array<float, 2> peak{};
  std::array<double, 2> ss{};
  for (std::uint32_t j = 0; j < frames; ++j) {
    const std::int64_t dframe = deviceFrame + static_cast<std::int64_t>(j);
    if (mode_ == Mode::playing && rate_ > 0 && pos_ >= static_cast<double>(rangeB_)) {
      capture_tail();
      if (loop_ == LoopMode::once) {
        pos_ = static_cast<double>(rangeB_);
        mode_ = Mode::stopped;
      } else {
        // Ping-pong's backward half plays silent (reverse audio preview is
        // not offered); the clock still loops like `loop`.
        pos_ = static_cast<double>(rangeA_) + (pos_ - static_cast<double>(rangeB_));
        if (pos_ >= static_cast<double>(rangeB_)) pos_ = static_cast<double>(rangeA_);
        fadeIn_ = fade_;
      }
      ++epoch_;
      segment(dframe);
    }
    std::array<float, 2> s{};
    if (mode_ != Mode::stopped && plan_ != nullptr && rate_ > 0) {
      const float w = fadeIn_ > 0 ? fade_in(fade_ - fadeIn_, fade_) : 1.0F;
      for (std::size_t c = 0; c < ch; ++c) s[c] = reader_.sample(static_cast<int>(c), pos_) * w;
      if (fadeIn_ > 0) --fadeIn_;
    }
    if (mode_ == Mode::playing) {
      pos_ += rate_;
      unfolded_ += std::fabs(rate_);
    } else if (mode_ == Mode::grain) {
      pos_ += 1;
      if (--grainLeft_ <= 0) {
        capture_tail();
        mode_ = Mode::stopped;
      }
    }
    if (tailPos_ < tailLen_) {
      const float w = 1 - fade_in(tailPos_, tailLen_);
      for (std::size_t c = 0; c < ch; ++c) s[c] += tail_[tailPos_ * ch + c] * w;
      ++tailPos_;
    }
    gain_ += (target - gain_) * 0.002F;
    if (std::fabs(target - gain_) < 1e-6F) gain_ = target;
    for (std::size_t c = 0; c < ch; ++c) {
      const float v = s[c] * gain_;
      interleaved[static_cast<std::size_t>(j) * ch + c] = v;
      peak[c] = std::max(peak[c], std::fabs(v));
      ss[c] += static_cast<double>(v) * static_cast<double>(v);
    }
  }
  for (std::size_t c = 0; c < 2; ++c) {
    const std::size_t k = std::min(c, ch - 1);
    meter_[c].store(peak[k], std::memory_order_relaxed);
    meter_[2 + c].store(frames > 0 ? static_cast<float>(std::sqrt(ss[k] / frames)) : 0.0F, std::memory_order_relaxed);
  }
  meter_[4].store(plan_ != nullptr ? plan_->meter().limiterReductionDb : 0.0F, std::memory_order_relaxed);
}

MeterLevels RealtimeEngine::meter() const noexcept {
  MeterLevels m;
  m.peak[0] = meter_[0].load(std::memory_order_relaxed);
  m.peak[1] = meter_[1].load(std::memory_order_relaxed);
  m.rms[0] = meter_[2].load(std::memory_order_relaxed);
  m.rms[1] = meter_[3].load(std::memory_order_relaxed);
  m.limiterReductionDb = meter_[4].load(std::memory_order_relaxed);
  return m;
}

}  // namespace premation::audio
