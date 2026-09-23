#include "mixer.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

#include "dsp_filters.hpp"
#include "jsmath.hpp"

namespace premation::audio {

namespace {

constexpr std::size_t kN = kQuantum;
constexpr double kFrameEps = 1e-6;  // a start time within this of a frame IS that frame

std::int64_t ceil_frame(double sec, double sr) noexcept {
  return static_cast<std::int64_t>(std::ceil(sec * sr - kFrameEps));
}

double pan_to_norm(double pan) noexcept {
  if (!std::isfinite(pan)) return 0;
  return std::max(-1.0, std::min(1.0, pan / 100));
}

}  // namespace

double level_db_to_gain(double db) noexcept {
  if (!std::isfinite(db) || db <= -60) return 0;
  return motion::js::pow(10, db / 20);
}

struct RenderPlan::VoiceDsp {
  const Voice* v = nullptr;
  SourcePtr src;
  double sr = 48000;
  double rate = 1;
  std::int64_t startFrame = 0;
  EffectChain chain;
  Bound level;
  Bound pan;
  Block blk;
  std::array<float, kN> gv{};
  std::array<float, kN> pv{};
  bool running = false;
  bool reverse = false;

  /// The bar's end frame (the source length may only now be known).
  [[nodiscard]] std::int64_t end_frame() const noexcept {
    double barLen = 0;
    if (v->outSec > 0) {
      barLen = v->outSec - v->inSec;
    } else {
      const std::int64_t total = src ? src->total_frames() : 0;
      if (total < 0) return std::numeric_limits<std::int64_t>::max();  // still conforming: open-ended
      barLen = static_cast<double>(total) / sr - v->inSec;
    }
    if (!(barLen > 0)) return startFrame;
    return ceil_frame(v->startSec + barLen, sr);
  }
  [[nodiscard]] double bar_len_sec(std::int64_t endFrame) const noexcept {
    if (v->outSec > 0) return v->outSec - v->inSec;
    return static_cast<double>(endFrame - startFrame) / sr;
  }
};

RenderPlan::RenderPlan(ProgramPtr program) : program_(std::move(program)) {
  const double sr = program_->format.sampleRate;
  for (const Voice& v : program_->voices) {
    if (v.muted) continue;  // a muted layer contributes nothing (mixdownBuffer filters it)
    auto d = std::make_unique<VoiceDsp>();
    d->v = &v;
    d->src = v.data;
    d->sr = sr;
    d->rate = std::max(0.01, v.playbackRate);
    d->startFrame = ceil_frame(v.startSec, sr);
    // Layer-time reverse OR the Backwards effect: one buffer flip (startVoice).
    d->reverse = v.reverse || has_backwards(v.effects);
    d->chain = EffectChain(v.effects, sr);
    d->level = Bound(&v.levelDb, [](double db) { return level_db_to_gain(db); });
    d->pan = Bound(&v.pan, [](double p) { return pan_to_norm(p); });
    voices_.push_back(std::move(d));
  }
  const MasterSettings& m = program_->master;
  masterGain_ = Bound(m.muted ? 0.0F : static_cast<float>(motion::js::pow(10, m.gainDb / 20)));
  limiterOn_ = m.limiter;
  if (limiterOn_) {
    const auto look = static_cast<std::size_t>(std::lround(sr * 0.0015));  // 1.5 ms look-ahead
    limiter_ = dsp::Limiter(sr, static_cast<std::size_t>(program_->format.channels), m.limiterCeilingDb,
                            m.limiterReleaseMs, look);
  }
}

RenderPlan::~RenderPlan() = default;

std::size_t RenderPlan::latency() const noexcept { return limiterOn_ ? limiter_.latency() : 0; }

void RenderPlan::reset(std::int64_t frame0) noexcept {
  for (auto& v : voices_) v->running = false;
  if (limiterOn_) limiter_.reset();
  next_ = frame0;
}

void RenderPlan::render_voice(VoiceDsp& d, std::int64_t frame0) noexcept {
  const Voice& v = *d.v;
  const std::int64_t endFrame = d.end_frame();
  const std::int64_t qEnd = frame0 + static_cast<std::int64_t>(kN);
  if (qEnd <= d.startFrame || frame0 >= endFrame || !d.src) {
    d.running = false;
    return;
  }
  const double sr = d.sr;
  if (!d.running) {
    d.chain.reset(Anchor{frame0, sr, d.startFrame, endFrame});
    d.running = true;
  }
  const SourceData& s = *d.src;
  const int nch = s.channels();
  Block& b = d.blk;
  b.zero(nch);
  const double rate = d.rate;
  const double startPos = v.startSec * sr;
  const std::int64_t total = s.total_frames();
  if (!d.reverse) {

    // AudioBufferSourceNode: read position inSec·sr + (n − start)·rate,
    // linear interpolation, the last sample held for the interpolation
    // partner at the buffer's end.
    const double base = v.inSec * sr;
    for (std::size_t i = 0; i < kN; ++i) {
      const std::int64_t n = frame0 + static_cast<std::int64_t>(i);
      if (n < d.startFrame || n >= endFrame) continue;
      double p = base + (static_cast<double>(n) - startPos) * rate;
      if (v.loop && total > 0) {
        const auto tt = static_cast<double>(total);
        p -= std::floor(p / tt) * tt;
      }
      const double fl = std::floor(p);
      const auto i1 = static_cast<std::int64_t>(fl);
      const double f = p - fl;
      for (int c = 0; c < nch; ++c) {
        const float s1 = s.at(c, i1);
        std::int64_t i2 = i1 + 1;
        if (total > 0 && i2 >= total) i2 = v.loop ? 0 : i1;
        const float s2 = s.at(c, i2);
        b.c(c)[i] = static_cast<float>((1.0 - f) * static_cast<double>(s1) + f * static_cast<double>(s2));
      }
    }
  } else if (total > 0) {
    // The TS plays a REVERSED copy of the buffer from backwardsOffset: read
    // it in reversed coordinates, rev[j] = src[N-1-j].
    const auto nTotal = static_cast<double>(total);
    const double barLen = d.bar_len_sec(endFrame);
    const double q0 = nTotal - (v.inSec + barLen * rate) * sr;
    for (std::size_t i = 0; i < kN; ++i) {
      const std::int64_t n = frame0 + static_cast<std::int64_t>(i);
      if (n < d.startFrame || n >= endFrame) continue;
      double q = q0 + (static_cast<double>(n) - startPos) * rate;
      if (v.loop) q -= std::floor(q / nTotal) * nTotal;
      const double fl = std::floor(q);
      const auto j1 = static_cast<std::int64_t>(fl);
      const double f = q - fl;
      std::int64_t j2 = j1 + 1;
      if (j2 >= total) j2 = v.loop ? 0 : j1;
      for (int c = 0; c < nch; ++c) {
        const float s1 = (j1 >= 0 && j1 < total) ? s.at(c, total - 1 - j1) : 0.0F;
        const float s2 = (j2 >= 0 && j2 < total) ? s.at(c, total - 1 - j2) : 0.0F;
        b.c(c)[i] = static_cast<float>((1.0 - f) * static_cast<double>(s1) + f * static_cast<double>(s2));
      }
    }
  }

  const QuantumClock q{sr, frame0, program_->controlPeriod};
  d.chain.process(b, q);

  // The voice is heard only inside its bar (AE: a layer's audio ends at its
  // out point; the TS preview stops the voice there too).
  const auto lo = static_cast<std::size_t>(std::max<std::int64_t>(0, d.startFrame - frame0));
  const auto hi = static_cast<std::size_t>(std::clamp<std::int64_t>(endFrame - frame0, 0, static_cast<std::int64_t>(kN)));
  for (int c = 0; c < b.channels; ++c) {
    float* x = b.c(c);
    for (std::size_t i = 0; i < lo; ++i) x[i] = 0;
    for (std::size_t i = hi; i < kN; ++i) x[i] = 0;
  }

  // Level (after the effects: the level has the last word on loudness).
  const bool gConst = d.level.fill(q, d.gv.data(), kN);
  for (int c = 0; c < b.channels; ++c) {
    float* x = b.c(c);
    for (std::size_t i = 0; i < kN; ++i) x[i] *= gConst ? d.gv[0] : d.gv[i];
  }

  const int outCh = program_->format.channels;
  float* busL = bus_[0].data();
  float* busR = bus_[1].data();
  if (v.panner) {
    const bool pConst = d.pan.fill(q, d.pv.data(), kN);
    for (std::size_t i = 0; i < kN; ++i) {
      float l = 0;
      float r = 0;
      const double p = pConst ? d.pv[0] : d.pv[i];
      if (b.channels == 1) {
        dsp::pan_mono(b.c(0)[i], p, l, r);
      } else {
        dsp::pan_stereo(b.c(0)[i], b.c(1)[i], p, l, r);
      }
      if (outCh == 1) {
        busL[i] += 0.5F * (l + r);
      } else {
        busL[i] += l;
        busR[i] += r;
      }
    }
    return;
  }
  if (outCh == 1) {
    for (std::size_t i = 0; i < kN; ++i) busL[i] += b.channels == 1 ? b.c(0)[i] : 0.5F * (b.c(0)[i] + b.c(1)[i]);
    return;
  }
  const float* l = b.c(0);
  const float* r = b.channels == 1 ? b.c(0) : b.c(1);
  for (std::size_t i = 0; i < kN; ++i) {
    busL[i] += l[i];
    busR[i] += r[i];
  }
}

void RenderPlan::render(std::int64_t frame0, float* const* out) noexcept {
  if (frame0 != next_) reset(frame0);
  next_ = frame0 + static_cast<std::int64_t>(kN);
  for (auto& a : bus_) a.fill(0);
  for (auto& v : voices_) render_voice(*v, frame0);

  const auto outCh = static_cast<std::size_t>(program_->format.channels);
  const QuantumClock q{static_cast<double>(program_->format.sampleRate), frame0, program_->controlPeriod};
  std::array<float, kN> g{};
  const bool gConst = masterGain_.fill(q, g.data(), kN);
  const bool unity = gConst && g[0] == 1.0F;
  for (std::size_t c = 0; c < outCh; ++c) {
    float* o = out[c];
    const float* x = bus_[c].data();
    if (unity) {
      std::copy(x, x + kN, o);
    } else {
      for (std::size_t i = 0; i < kN; ++i) o[i] = x[i] * (gConst ? g[0] : g[i]);
    }
  }
  if (limiterOn_) limiter_.process(out, kN);

  for (std::size_t c = 0; c < 2; ++c) {
    const std::size_t src = std::min(c, outCh - 1);
    float pk = 0;
    double ss = 0;
    for (std::size_t i = 0; i < kN; ++i) {
      const float s = out[src][i];
      pk = std::max(pk, std::fabs(s));
      ss += static_cast<double>(s) * static_cast<double>(s);
    }
    meter_.peak[c] = pk;
    meter_.rms[c] = static_cast<float>(std::sqrt(ss / static_cast<double>(kN)));
  }
  meter_.limiterReductionDb = limiterOn_ ? limiter_.gain_reduction_db() : 0;
}

std::vector<std::vector<float>> render_offline(const ProgramPtr& program, std::int64_t startFrame,
                                               std::int64_t frames) {
  const auto nch = static_cast<std::size_t>(program->format.channels);
  std::vector<std::vector<float>> out(nch, std::vector<float>(static_cast<std::size_t>(std::max<std::int64_t>(frames, 0))));
  if (frames <= 0) return out;
  // Export waits for every source to finish conforming.
  for (const Voice& v : program->voices) {
    if (v.data) v.data->wait_for(std::numeric_limits<std::int64_t>::max());
  }
  RenderPlan plan(program);
  const auto q = static_cast<std::int64_t>(kN);
  const std::int64_t aligned = (startFrame >= 0 ? startFrame / q : -((-startFrame + q - 1) / q)) * q;
  const auto lat = static_cast<std::int64_t>(plan.latency());
  const std::int64_t skip = startFrame - aligned + lat;  // output frames before the first one we keep
  std::array<std::array<float, kN>, 2> buf{};
  std::array<float*, 2> ptrs{buf[0].data(), buf[1].data()};
  std::int64_t written = 0;
  for (std::int64_t f = aligned; written < frames; f += q) {
    plan.render(f, ptrs.data());
    const std::int64_t outStart = f - aligned;  // index of buf[0] in the rendered stream
    for (std::size_t i = 0; i < kN; ++i) {
      const std::int64_t k = outStart + static_cast<std::int64_t>(i) - skip;
      if (k < 0 || k >= frames) continue;
      for (std::size_t c = 0; c < nch; ++c) out[c][static_cast<std::size_t>(k)] = buf[c][i];
      written = std::max(written, k + 1);
    }
  }
  return out;
}

}  // namespace premation::audio
