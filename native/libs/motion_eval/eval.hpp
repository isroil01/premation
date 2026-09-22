// motion_eval — internal C++ API. Not part of the ABI; include/motion is.
//
// A line-by-line port of packages/animation/src/interpolate.ts
// (cubicBezierEase, ease, cubicValueAt, autoSpatialTangents,
// effectiveSpatialTangents, sampleTrack). Each function names the TypeScript
// function it mirrors and keeps its arithmetic ORDER, because the contract is
// bit-identity with a JavaScript engine's IEEE-754 doubles: same operations,
// same associativity, no fused multiply-add (the library is compiled with
// -ffp-contract=off, see cmake/warnings.cmake).
//
// Everything here is noexcept, allocation-free and pure: the sampler reads
// keyframes through a `KeyframeSource` (a struct array or the packed
// Float64Array layout) and never copies the track.

#ifndef MOTION_EVAL_INTERNAL_EVAL_HPP
#define MOTION_EVAL_INTERNAL_EVAL_HPP

#include <concepts>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>

#include "motion/motion_eval.h"

namespace motion::eval {

using Keyframe = motion_keyframe;

/// MOTION_KEYFRAME_PACKED_DOUBLES as a size_t, so index arithmetic stays unsigned.
inline constexpr std::size_t kPackedDoubles = MOTION_KEYFRAME_PACKED_DOUBLES;

/// motion_easing values as the int32_t `Keyframe::easing` is compared with.
/// (An unscoped C enum with no negative enumerators may be unsigned underneath;
/// comparing it with an int32_t directly is a -Wsign-compare question that
/// should not exist.)
inline constexpr std::int32_t kEasingHold = MOTION_EASING_HOLD;
inline constexpr std::int32_t kEasingBezier = MOTION_EASING_BEZIER;
inline constexpr std::int32_t kEasingAutoBezier = MOTION_EASING_AUTO_BEZIER;
inline constexpr std::int32_t kEasingContinuousBezier = MOTION_EASING_CONTINUOUS_BEZIER;
inline constexpr std::int32_t kEasingStep = MOTION_EASING_STEP;
inline constexpr std::int32_t kEasingCount = MOTION_EASING_COUNT_;

/// Anything the sampler can read keyframes from. `get(i)` may return by value
/// (the packed layout decodes on the fly) or by const reference.
template <class S>
concept KeyframeSource = requires(const S& s, std::size_t i) {
  { s.size() } -> std::convertible_to<std::size_t>;
  { s.get(i) } -> std::convertible_to<Keyframe>;
};

/// A contiguous `motion_keyframe[]`.
struct StructSource {
  std::span<const Keyframe> kfs;

  [[nodiscard]] std::size_t size() const noexcept { return kfs.size(); }
  [[nodiscard]] const Keyframe& get(std::size_t i) const noexcept { return kfs[i]; }
};

/// The MOTION_KEYFRAME_PACKED_DOUBLES-per-keyframe Float64Array layout.
/// Precondition for `get`: `validate_packed` returned OK (the integer fields
/// are exact small integers, so the casts are lossless).
struct PackedSource {
  std::span<const double> data;
  std::size_t count = 0;

  [[nodiscard]] std::size_t size() const noexcept { return count; }
  [[nodiscard]] Keyframe get(std::size_t i) const noexcept;
};

// ── Easing curves (interpolate.ts lines 13–29, 32–52, 59–63) ───────────────

/// `cubicBezierEase([x1, y1, x2, y2], x)`: CSS cubic-bezier y for x, Newton on
/// x(s) = x for at most 8 steps, |dx| < 1e-5 or |x'(s)| < 1e-6 stops early.
/// The TypeScript has no bisection fallback, so neither does this.
[[nodiscard]] double cubic_bezier_ease(double x1, double y1, double x2, double y2,
                                       double x) noexcept;

/// `ease(kind, x)` — the named presets. `kind` must be a valid motion_easing.
[[nodiscard]] double ease(std::int32_t kind, double x) noexcept;

/// `cubicValueAt(v0, v1, v2, v3, u)` — 1D cubic bezier through value handles.
[[nodiscard]] double cubic_value_at(double v0, double v1, double v2, double v3,
                                    double u) noexcept;

// ── Validation ──────────────────────────────────────────────────────────────

/// Empty when the keyframe is well-formed, otherwise the reason (static text).
[[nodiscard]] std::string_view validate_keyframe(const Keyframe& k) noexcept;

/// Empty when the ten packed doubles decode to a well-formed keyframe.
[[nodiscard]] std::string_view validate_packed_keyframe(std::span<const double> ten) noexcept;

/// Whole-track check: count >= 1, every keyframe valid, times non-decreasing.
template <KeyframeSource S>
[[nodiscard]] std::string_view validate_track(const S& src) noexcept {
  const std::size_t n = src.size();
  if (n == 0) return "track has no keyframes";
  double prev_t = 0.0;
  for (std::size_t i = 0; i < n; ++i) {
    const Keyframe& k = src.get(i);
    const std::string_view why = validate_keyframe(k);
    if (!why.empty()) return why;
    if (i > 0 && k.t < prev_t) return "keyframes are not sorted by time";
    prev_t = k.t;
  }
  return {};
}

// ── Spatial tangents (interpolate.ts lines 159–189) ────────────────────────

struct Tangents {
  bool has_si = false;
  bool has_so = false;
  double si = 0.0;
  double so = 0.0;
};

[[nodiscard]] constexpr std::uint32_t spatial_mode(const Keyframe& k) noexcept {
  return (k.flags & MOTION_KF_SPATIAL_MASK) >> MOTION_KF_SPATIAL_SHIFT;
}

/// `autoSpatialTangents(kfs, i)`: Catmull-Rom chord through the neighbours,
/// each side scaled by its segment duration ÷ 3; ends get no open-side tangent.
template <KeyframeSource S>
[[nodiscard]] Tangents auto_spatial_tangents(const S& src, std::size_t i) noexcept {
  Tangents out;
  const std::size_t n = src.size();
  if (i >= n || n < 2) return out;
  const Keyframe& k = src.get(i);
  const Keyframe& prev = src.get(i > 0 ? i - 1 : 0);
  const Keyframe& next = src.get(i + 1 < n ? i + 1 : n - 1);
  const double dt = next.t - prev.t;
  const double m = dt > 0 ? (next.value - prev.value) / dt : 0.0;
  if (i < n - 1) {
    out.has_so = true;
    out.so = (m * (src.get(i + 1).t - k.t)) / 3.0;
  }
  if (i > 0) {
    out.has_si = true;
    out.si = (-m * (k.t - src.get(i - 1).t)) / 3.0;
  }
  return out;
}

/// `effectiveSpatialTangents(kfs, i)`: honours the per-keyframe spatial mode.
template <KeyframeSource S>
[[nodiscard]] Tangents effective_spatial_tangents(const S& src, std::size_t i) noexcept {
  Tangents out;
  if (i >= src.size()) return out;
  const Keyframe& k = src.get(i);
  const std::uint32_t mode = spatial_mode(k);
  if (mode == MOTION_SPATIAL_LINEAR) return out;
  if (mode == MOTION_SPATIAL_AUTO) return auto_spatial_tangents(src, i);
  if ((k.flags & MOTION_KF_HAS_SI) != 0u) {
    out.has_si = true;
    out.si = k.si;
  }
  if ((k.flags & MOTION_KF_HAS_SO) != 0u) {
    out.has_so = true;
    out.so = k.so;
  }
  return out;
}

// ── The sampler (interpolate.ts lines 80–151) ───────────────────────────────

/// `segmentIndexFor`: smallest i in [0, n-2] with t <= kfs[i+1].t. The
/// TypeScript's cursor cache is an accelerator that returns the same index
/// (see its comment), so only the binary search is ported. Precondition:
/// first.t < t < last.t.
template <KeyframeSource S>
[[nodiscard]] std::size_t segment_index_for(const S& src, double t) noexcept {
  std::size_t lo = 0;
  std::size_t hi = src.size() - 2;
  while (lo < hi) {
    const std::size_t mid = lo + (hi - lo) / 2;  // == (lo + hi) >> 1, overflow-free
    if (src.get(mid + 1).t >= t) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/// `sampleTrack(track, t)`. Preconditions: `validate_track` passed and `t` is
/// not NaN (the C wrappers check both; this never fails).
template <KeyframeSource S>
[[nodiscard]] double sample(const S& src, double t) noexcept {
  const std::size_t n = src.size();
  const Keyframe& first = src.get(0);
  const Keyframe& last = src.get(n - 1);
  if (t <= first.t) return first.value;
  if (t >= last.t) return last.value;

  const std::size_t i = segment_index_for(src, t);
  const Keyframe& a = src.get(i);
  const Keyframe& b = src.get(i + 1);
  const std::int32_t kind = a.easing;

  // Hold/step hold the start value UP TO — but not AT — the next keyframe.
  if (kind == kEasingHold || kind == kEasingStep) {
    return t < b.t ? a.value : b.value;
  }
  const double seg_span = b.t - a.t;
  const double local = seg_span <= 0 ? 0.0 : (t - a.t) / seg_span;
  const bool bezier_kind =
      kind == kEasingBezier || kind == kEasingAutoBezier || kind == kEasingContinuousBezier;
  const bool has_handles = (a.flags & MOTION_KF_HAS_BEZIER) != 0u;
  const double eased = (bezier_kind && has_handles) ? cubic_bezier_ease(a.c0, a.c1, a.c2, a.c3, local)
                                                    : ease(kind, local);

  // Spatial mode absent = the stored tangents as-is; otherwise resolve the mode.
  Tangents out_side;
  if (spatial_mode(a) == MOTION_SPATIAL_UNSET) {
    out_side.has_so = (a.flags & MOTION_KF_HAS_SO) != 0u;
    out_side.so = a.so;
  } else {
    out_side = effective_spatial_tangents(src, i);
  }
  Tangents in_side;
  if (spatial_mode(b) == MOTION_SPATIAL_UNSET) {
    in_side.has_si = (b.flags & MOTION_KF_HAS_SI) != 0u;
    in_side.si = b.si;
  } else {
    in_side = effective_spatial_tangents(src, i + 1);
  }
  if (out_side.has_so || in_side.has_si) {
    const double third = (b.value - a.value) / 3.0;  // linear default for the missing side
    const double c1 = a.value + (out_side.has_so ? out_side.so : third);
    const double c2 = b.value + (in_side.has_si ? in_side.si : -third);
    return cubic_value_at(a.value, c1, c2, b.value, eased);
  }
  return a.value + (b.value - a.value) * eased;
}

}  // namespace motion::eval

#endif  // MOTION_EVAL_INTERNAL_EVAL_HPP
