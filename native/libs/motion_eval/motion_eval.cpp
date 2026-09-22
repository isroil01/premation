// motion_eval — the C ABI wrappers (include/motion/motion_eval.h).
//
// The only job of this file is the boundary discipline from
// docs/NATIVE_CORE_PLAN.md §2: validate plain data, call the pure C++ sampler,
// and turn anything unexpected into a status + message instead of letting an
// exception or an invariant failure cross into the caller.

#include "motion/motion_eval.h"

#include <cmath>
#include <cstddef>
#include <span>
#include <string_view>

#include "eval.hpp"

namespace {

using motion::eval::PackedSource;
using motion::eval::StructSource;

/// Copy `msg` into the caller's buffer, truncated and always NUL-terminated.
/// `err` may be NULL. Never allocates.
void set_error(motion_error* err, std::string_view msg) noexcept {
  if (err == nullptr) return;
  const std::span<char> buf(err->message);
  const std::size_t n = msg.size() < buf.size() - 1 ? msg.size() : buf.size() - 1;
  for (std::size_t i = 0; i < n; ++i) buf[i] = msg[i];
  buf[n] = '\0';
}

/// One sample over any validated source; `times`/`out` are the batch spans.
/// A single-sample call is a batch of one.
template <motion::eval::KeyframeSource S>
motion_status sample_batch(const S& src, std::span<const double> times, std::span<double> out,
                           motion_error* err) noexcept {
  try {
    const std::string_view why = motion::eval::validate_track(src);
    if (!why.empty()) {
      set_error(err, why);
      return MOTION_INVALID_ARG;
    }
    for (const double t : times) {
      if (std::isnan(t)) {
        set_error(err, "sample time is NaN");
        return MOTION_INVALID_ARG;
      }
    }
    for (std::size_t i = 0; i < times.size(); ++i) {
      out[i] = motion::eval::sample(src, times[i]);
    }
    return MOTION_OK;
  } catch (...) {
    set_error(err, "internal: unexpected exception in motion_eval");
    return MOTION_INTERNAL;
  }
}

/// The argument checks every entry point shares. Returns MOTION_OK when the
/// pointers/counts are usable; otherwise the status to return.
motion_status check_args(const void* kfs, std::size_t count, const double* times, std::size_t n,
                         const double* out, motion_error* err) noexcept {
  if (count == 0) {
    set_error(err, "count is 0: a track needs at least one keyframe");
    return MOTION_INVALID_ARG;
  }
  if (kfs == nullptr) {
    set_error(err, "kfs is NULL");
    return MOTION_INVALID_ARG;
  }
  if (n > 0 && (times == nullptr || out == nullptr)) {
    set_error(err, "times/out is NULL with n > 0");
    return MOTION_INVALID_ARG;
  }
  return MOTION_OK;
}

}  // namespace

extern "C" {

motion_status motion_eval_sample_scalar(const motion_keyframe* kfs, std::size_t count, double t,
                                        double* out, motion_error* err) {
  if (out == nullptr) {
    set_error(err, "out is NULL");
    return MOTION_INVALID_ARG;
  }
  const motion_status pre = check_args(kfs, count, &t, 1, out, err);
  if (pre != MOTION_OK) return pre;
  const StructSource src{.kfs = std::span<const motion_keyframe>(kfs, count)};
  return sample_batch(src, std::span<const double>(&t, 1), std::span<double>(out, 1), err);
}

motion_status motion_eval_sample_scalar_batch(const motion_keyframe* kfs, std::size_t count,
                                              const double* times, std::size_t n, double* out,
                                              motion_error* err) {
  const motion_status pre = check_args(kfs, count, times, n, out, err);
  if (pre != MOTION_OK) return pre;
  const StructSource src{.kfs = std::span<const motion_keyframe>(kfs, count)};
  if (n == 0) {
    // Still validate the track: a bad track is a bad track even with no samples.
    return sample_batch(src, std::span<const double>{}, std::span<double>{}, err);
  }
  return sample_batch(src, std::span<const double>(times, n), std::span<double>(out, n), err);
}

motion_status motion_eval_sample_scalar_packed(const double* packed, std::size_t count, double t,
                                               double* out, motion_error* err) {
  if (out == nullptr) {
    set_error(err, "out is NULL");
    return MOTION_INVALID_ARG;
  }
  const motion_status pre = check_args(packed, count, &t, 1, out, err);
  if (pre != MOTION_OK) return pre;
  const std::span<const double> data(packed, count * motion::eval::kPackedDoubles);
  for (std::size_t i = 0; i < count; ++i) {
    const std::string_view why = motion::eval::validate_packed_keyframe(
        data.subspan(i * motion::eval::kPackedDoubles, motion::eval::kPackedDoubles));
    if (!why.empty()) {
      set_error(err, why);
      return MOTION_INVALID_ARG;
    }
  }
  const PackedSource src{.data = data, .count = count};
  return sample_batch(src, std::span<const double>(&t, 1), std::span<double>(out, 1), err);
}

motion_status motion_eval_sample_scalar_packed_batch(const double* packed, std::size_t count,
                                                     const double* times, std::size_t n,
                                                     double* out, motion_error* err) {
  const motion_status pre = check_args(packed, count, times, n, out, err);
  if (pre != MOTION_OK) return pre;
  const std::span<const double> data(packed, count * motion::eval::kPackedDoubles);
  for (std::size_t i = 0; i < count; ++i) {
    const std::string_view why = motion::eval::validate_packed_keyframe(
        data.subspan(i * motion::eval::kPackedDoubles, motion::eval::kPackedDoubles));
    if (!why.empty()) {
      set_error(err, why);
      return MOTION_INVALID_ARG;
    }
  }
  const PackedSource src{.data = data, .count = count};
  if (n == 0) return sample_batch(src, std::span<const double>{}, std::span<double>{}, err);
  return sample_batch(src, std::span<const double>(times, n), std::span<double>(out, n), err);
}

}  // extern "C"
