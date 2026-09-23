#include "voice_build.hpp"

#include <algorithm>
#include <cmath>

namespace premation::audio {

namespace {

constexpr double kRateEps = 0.02;      // RATE_EPS / SEG_RATE_EPS
constexpr double kMinSeg = 1.0 / 120;  // MIN_SEG

/// The nested voice's level is sampled on a clock it is not heard on, so the
/// TS uses its static level (levelAnimated: false).
ParamCurve static_of(const ParamCurve& c) { return ParamCurve::constant(c.static_value()); }

}  // namespace

std::vector<RateSegment> retime_segments(const std::function<double(double)>& sourceAt, const ClipTiming& bar,
                                         double fps) {
  const double step = 1 / std::max(1.0, fps);
  const double barLen = std::max(0.0, bar.outSec - bar.inSec);
  if (barLen <= 0) return {};
  const double t0 = bar.startSec;
  const double tEnd = bar.startSec + barLen;
  struct S {
    double t, s;
  };
  std::vector<S> samples;
  for (double t = t0; t < tEnd - 1e-9; t += step) samples.push_back({t, sourceAt(t)});  // NOLINT(clang-analyzer-security.FloatLoopCounter,cert-flp30-c): the TS accumulates the same way
  samples.push_back({tEnd, sourceAt(tEnd)});

  std::vector<RateSegment> raw;
  for (std::size_t i = 0; i + 1 < samples.size(); ++i) {
    const S a = samples[i];
    const S b = samples[i + 1];
    const double dt = b.t - a.t;
    if (dt < 1e-9) continue;
    const double signedRate = (b.s - a.s) / dt;
    if (std::fabs(signedRate) < kRateEps) continue;  // hold → silence
    raw.push_back({a.t, dt, std::max(0.0, signedRate >= 0 ? a.s : b.s),
                   std::min(16.0, std::max(0.01, std::fabs(signedRate))), signedRate < 0});
  }
  std::vector<RateSegment> merged;
  for (const RateSegment& seg : raw) {
    if (!merged.empty()) {
      RateSegment& last = merged.back();
      if (last.reverse == seg.reverse && std::fabs(last.rate - seg.rate) < kRateEps &&
          std::fabs((last.startSec + last.durationSec) - seg.startSec) < 1e-6) {
        last.durationSec += seg.durationSec;
        continue;
      }
    }
    if (seg.durationSec >= kMinSeg) merged.push_back(seg);
  }
  return merged;
}

std::vector<Voice> expand_segments(const Voice& base, const ClipTiming& bar, const std::vector<RateSegment>& segs) {
  std::vector<Voice> out;
  out.reserve(segs.size());
  for (std::size_t i = 0; i < segs.size(); ++i) {
    const RateSegment& seg = segs[i];
    Voice v = base;
    v.id = bar.id + "::r" + std::to_string(i);
    v.startSec = seg.startSec;
    v.inSec = seg.inSec;
    v.outSec = seg.inSec + seg.durationSec;  // outSec − inSec is WALL duration
    v.playbackRate = seg.rate;
    v.reverse = seg.reverse;
    out.push_back(std::move(v));
  }
  return out;
}

std::vector<Voice> place_nested(const std::string& instanceId, const std::vector<Voice>& inner,
                                const std::vector<ClipTiming>& spans, bool retimed,
                                const std::function<double(double)>& innerAt, double fps, bool instanceMuted) {
  std::vector<Voice> out;
  if (inner.empty()) return out;
  for (const ClipTiming& span : spans) {
    const bool muted = !span.enabled || instanceMuted;
    if (!retimed) {
      const double winStart = span.startSec;
      const double winEnd = span.startSec + (span.outSec - span.inSec);
      for (const Voice& v : inner) {
        const double hostStart = span.startSec + (v.startSec - span.inSec);
        const double start = std::max(hostStart, winStart);
        const double end = std::min(hostStart + (v.outSec - v.inSec), winEnd);
        if (!(end > start)) continue;
        const double inSec = v.inSec + (start - hostStart) * v.playbackRate;
        Voice n = v;
        n.id = instanceId + "::" + span.id + "::" + (v.id.empty() ? v.nodeId : v.id);
        n.startSec = start;
        n.inSec = inSec;
        n.outSec = inSec + (end - start);
        n.levelDb = static_of(v.levelDb);
        n.muted = v.muted || muted;
        out.push_back(std::move(n));
      }
      continue;
    }
    // innerSegments: constant-rate stretches of the instance's inner time.
    struct Seg {
      double startSec, durationSec, innerStart, rate;
      bool reverse;
    };
    std::vector<Seg> segs;
    const double t0 = span.startSec;
    const double t1 = span.startSec + (span.outSec - span.inSec);
    if (t1 > t0 && std::isfinite(t1)) {
      const double step = 1 / std::max(1.0, fps);
      double at = t0;
      double as = innerAt(t0);
      for (double t = t0 + step; at < t1 - 1e-9; t += step) {  // NOLINT(clang-analyzer-security.FloatLoopCounter,cert-flp30-c): as the TS
        const double bt = std::min(t, t1);
        const double bs = innerAt(bt);
        const double dt = bt - at;
        const double signedRate = dt > 1e-9 ? (bs - as) / dt : 0;
        if (std::fabs(signedRate) >= kRateEps) {
          const bool reverse = signedRate < 0;
          const double rate = std::fabs(signedRate);
          if (!segs.empty() && segs.back().reverse == reverse && std::fabs(segs.back().rate - rate) < kRateEps &&
              std::fabs(segs.back().startSec + segs.back().durationSec - at) < 1e-6) {
            segs.back().durationSec += dt;
          } else {
            segs.push_back({at, dt, as, rate, reverse});
          }
        }
        at = bt;
        as = bs;
      }
    }
    for (std::size_t k = 0; k < segs.size(); ++k) {
      const Seg& seg = segs[k];
      const double lo = seg.reverse ? seg.innerStart - seg.durationSec * seg.rate : seg.innerStart;
      const double hi = lo + seg.durationSec * seg.rate;
      for (const Voice& v : inner) {
        const double p = v.playbackRate;
        const double vEnd = v.startSec + (v.outSec - v.inSec);
        const double a = std::max(lo, v.startSec);
        const double b = std::min(hi, vEnd);
        if (!(b > a)) continue;
        const double hostDur = (b - a) / seg.rate;
        const double hostStart = seg.startSec + (seg.reverse ? hi - b : a - lo) / seg.rate;
        const double inSec = v.inSec + (a - v.startSec) * p;
        Voice n = v;
        n.id = instanceId + "::" + span.id + "::s" + std::to_string(k) + "::" + (v.id.empty() ? v.nodeId : v.id);
        n.startSec = hostStart;
        n.inSec = inSec;
        n.outSec = inSec + hostDur;
        n.playbackRate = p * seg.rate;
        n.reverse = seg.reverse ? !v.reverse : v.reverse;
        n.levelDb = static_of(v.levelDb);
        n.muted = v.muted || muted;
        out.push_back(std::move(n));
      }
    }
  }
  return out;
}

void apply_solo(std::vector<Voice>& voices, const std::vector<std::string>& soloedNodeIds) {
  if (soloedNodeIds.empty()) return;
  for (Voice& v : voices) {
    if (std::ranges::find(soloedNodeIds, v.nodeId) == soloedNodeIds.end()) v.muted = true;
  }
}

}  // namespace premation::audio
