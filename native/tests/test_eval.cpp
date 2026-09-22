// motion_eval — the C ABI and the golden bit-identity contract.
//
// The golden table (golden_bezier.inc) is produced by RUNNING the TypeScript
// sampler (native/tests/gen_golden.ts). Two checks read it: an exact `==` on
// the doubles — the bit-identity the plan requires before a native path may
// become the default — and a 1e-9-relative tolerance check that says whether
// a mismatch is a last-bit drift (FMA, libm) or a real semantic bug.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <span>
#include <vector>

#include "eval.hpp"
#include "motion/motion_eval.h"

using Catch::Matchers::WithinAbs;
using Catch::Matchers::WithinRel;

namespace {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

motion_keyframe kf(double t, double value, motion_easing easing = MOTION_EASING_LINEAR) {
  motion_keyframe k{};
  k.t = t;
  k.value = value;
  k.easing = static_cast<std::int32_t>(easing);
  return k;
}

motion_keyframe bez(double t, double value, double x1, double y1, double x2, double y2) {
  motion_keyframe k = kf(t, value, MOTION_EASING_BEZIER);
  k.flags |= MOTION_KF_HAS_BEZIER;
  k.c0 = x1;
  k.c1 = y1;
  k.c2 = x2;
  k.c3 = y2;
  return k;
}

double sample_ok(std::span<const motion_keyframe> kfs, double t) {
  double out = kNaN;
  motion_error err{};
  const motion_status st = motion_eval_sample_scalar(kfs.data(), kfs.size(), t, &out, &err);
  INFO("status " << motion_status_name(st) << ": " << err.message);
  REQUIRE(st == MOTION_OK);
  return out;
}

motion_status sample_status(std::span<const motion_keyframe> kfs, double t, motion_error* err) {
  double out = kNaN;
  return motion_eval_sample_scalar(kfs.data(), kfs.size(), t, &out, err);
}

std::vector<double> pack(std::span<const motion_keyframe> kfs) {
  std::vector<double> packed;
  packed.reserve(kfs.size() * MOTION_KEYFRAME_PACKED_DOUBLES);
  for (const motion_keyframe& k : kfs) {
    packed.push_back(k.t);
    packed.push_back(k.value);
    packed.push_back(static_cast<double>(k.easing));
    packed.push_back(static_cast<double>(k.flags));
    packed.push_back(k.c0);
    packed.push_back(k.c1);
    packed.push_back(k.c2);
    packed.push_back(k.c3);
    packed.push_back(k.si);
    packed.push_back(k.so);
  }
  return packed;
}

// ── The golden track, straight from the X-macro table ──────────────────────

struct GoldenSample {
  double t;
  double expected;
};

const std::vector<motion_keyframe> kGoldenKfs = {
#define MOTION_GOLDEN_KF(t, v, e, f, c0, c1, c2, c3, si, so) \
  motion_keyframe{t, v, e, f, c0, c1, c2, c3, si, so},
#define MOTION_GOLDEN_SAMPLE(t, v)
#include "golden_bezier.inc"
#undef MOTION_GOLDEN_KF
#undef MOTION_GOLDEN_SAMPLE
};

const std::vector<GoldenSample> kGoldenSamples = {
#define MOTION_GOLDEN_KF(t, v, e, f, c0, c1, c2, c3, si, so)
#define MOTION_GOLDEN_SAMPLE(t, v) GoldenSample{t, v},
#include "golden_bezier.inc"
#undef MOTION_GOLDEN_KF
#undef MOTION_GOLDEN_SAMPLE
};

}  // namespace

// ── Easing primitives (internal API) ────────────────────────────────────────

TEST_CASE("cubic_bezier_ease passes through the endpoints", "[eval][easing]") {
  CHECK_THAT(motion::eval::cubic_bezier_ease(0.25, 0.1, 0.25, 1.0, 0.0), WithinAbs(0.0, 1e-12));
  CHECK_THAT(motion::eval::cubic_bezier_ease(0.25, 0.1, 0.25, 1.0, 1.0), WithinAbs(1.0, 1e-12));
  CHECK_THAT(motion::eval::cubic_bezier_ease(0.0, 0.0, 1.0, 1.0, 0.5), WithinAbs(0.5, 1e-5));
  CHECK(motion::eval::cubic_bezier_ease(0.0, 0.6, 0.4, 1.0, 0.5) > 0.5);
  // Out-of-range x clamps, like the TypeScript.
  CHECK(motion::eval::cubic_bezier_ease(0.25, 0.1, 0.25, 1.0, -3.0) == 0.0);
  CHECK(motion::eval::cubic_bezier_ease(0.25, 0.1, 0.25, 1.0, 7.0) == 1.0);
}

TEST_CASE("ease presets", "[eval][easing]") {
  CHECK(motion::eval::ease(MOTION_EASING_LINEAR, 0.3) == 0.3);
  CHECK(motion::eval::ease(MOTION_EASING_EASE_IN, 0.5) == 0.25);
  CHECK(motion::eval::ease(MOTION_EASING_EASE_OUT, 0.5) == 0.75);
  CHECK(motion::eval::ease(MOTION_EASING_EASE_IN_OUT, 0.25) == 0.125);
  CHECK(motion::eval::ease(MOTION_EASING_EASE_IN_OUT, 0.75) == 0.875);
  CHECK(motion::eval::ease(MOTION_EASING_STEP, 0.9) == 0.0);
  CHECK(motion::eval::ease(MOTION_EASING_BEZIER, 0.4) == 0.4);  // no handles → linear
  CHECK(motion::eval::ease(MOTION_EASING_LINEAR, 2.0) == 1.0);  // clamps
}

TEST_CASE("cubic_value_at with third-point handles is linear", "[eval][easing]") {
  const double third = (100.0 - 0.0) / 3.0;
  CHECK_THAT(motion::eval::cubic_value_at(0.0, third, 100.0 - third, 100.0, 0.5),
             WithinAbs(50.0, 1e-12));
  CHECK(motion::eval::cubic_value_at(0.0, 0.0, 100.0, 100.0, 0.0) == 0.0);
  CHECK(motion::eval::cubic_value_at(0.0, 0.0, 100.0, 100.0, 1.0) == 100.0);
}

// ── Sampling semantics through the C ABI ────────────────────────────────────

TEST_CASE("linear: clamps outside, exact midpoint inside", "[eval][abi]") {
  const std::array<motion_keyframe, 2> kfs{kf(0.0, 0.0), kf(2.0, 100.0)};
  CHECK(sample_ok(kfs, -1.0) == 0.0);
  CHECK(sample_ok(kfs, 0.0) == 0.0);
  CHECK(sample_ok(kfs, 1.0) == 50.0);
  CHECK(sample_ok(kfs, 0.5) == 25.0);
  CHECK(sample_ok(kfs, 2.0) == 100.0);
  CHECK(sample_ok(kfs, 3.0) == 100.0);
}

TEST_CASE("hold and step keep the start value up to, not at, the next keyframe", "[eval][abi]") {
  for (const motion_easing e : {MOTION_EASING_HOLD, MOTION_EASING_STEP}) {
    const std::array<motion_keyframe, 3> kfs{kf(0.0, 10.0, e), kf(2.0, 90.0, e), kf(4.0, 5.0)};
    CHECK(sample_ok(kfs, -1.0) == 10.0);
    CHECK(sample_ok(kfs, 0.1) == 10.0);
    CHECK(sample_ok(kfs, 1.99) == 10.0);
    CHECK(sample_ok(kfs, 2.0) == 90.0);  // interior keyframe: arriving value wins AT its time
    CHECK(sample_ok(kfs, 3.9) == 90.0);
    CHECK(sample_ok(kfs, 4.0) == 5.0);
    CHECK(sample_ok(kfs, 9.0) == 5.0);
  }
}

TEST_CASE("bezier: uses the keyframe's handles, degrades to linear without them",
          "[eval][abi]") {
  const std::array<motion_keyframe, 2> eased{bez(0.0, 0.0, 0.0, 0.8, 0.2, 1.0), kf(1.0, 100.0)};
  CHECK(sample_ok(eased, 0.5) > 50.0);
  CHECK(sample_ok(eased, 0.0) == 0.0);
  CHECK(sample_ok(eased, 1.0) == 100.0);
  CHECK(sample_ok(eased, 1.5) == 100.0);

  const std::array<motion_keyframe, 2> bare{kf(0.0, 0.0, MOTION_EASING_BEZIER), kf(1.0, 100.0)};
  CHECK(sample_ok(bare, 0.5) == 50.0);

  // autoBezier / continuousBezier without handles use the [0.333, 0, 0.667, 1] preset.
  const std::array<motion_keyframe, 2> autob{kf(0.0, 0.0, MOTION_EASING_AUTO_BEZIER),
                                             kf(1.0, 100.0)};
  const double preset = motion::eval::cubic_bezier_ease(0.333, 0.0, 0.667, 1.0, 0.25) * 100.0;
  CHECK(sample_ok(autob, 0.25) == preset);
}

TEST_CASE("single keyframe is a constant", "[eval][abi]") {
  const std::array<motion_keyframe, 1> kfs{kf(1.0, 42.0)};
  CHECK(sample_ok(kfs, -5.0) == 42.0);
  CHECK(sample_ok(kfs, 1.0) == 42.0);
  CHECK(sample_ok(kfs, 5.0) == 42.0);
}

TEST_CASE("duplicate-time keyframes resolve to the smallest segment", "[eval][abi]") {
  // Same as the TypeScript's linear scan: at t between kf1 and kf2 the segment is
  // 1 → 2; at exactly t = 1 the first clamp/segment rule applies.
  const std::array<motion_keyframe, 3> kfs{kf(0.0, 0.0), kf(1.0, 10.0), kf(1.0, 20.0)};
  CHECK(sample_ok(kfs, 0.5) == 5.0);
  CHECK(sample_ok(kfs, 1.0) == 20.0);  // t >= last.t → last value
  CHECK_THAT(sample_ok(kfs, 0.999), WithinAbs(9.99, 1e-12));
}

TEST_CASE("spatial tangents bend the value curve", "[eval][abi][spatial]") {
  // `so` on the start keyframe, missing `si` on the end → linear third on that side.
  std::array<motion_keyframe, 2> kfs{kf(0.0, 0.0), kf(1.0, 100.0)};
  kfs[0].flags |= MOTION_KF_HAS_SO;
  kfs[0].so = 100.0;  // strong overshoot handle
  const double third = (100.0 - 0.0) / 3.0;
  const double expected = motion::eval::cubic_value_at(0.0, 0.0 + 100.0, 100.0 - third, 100.0, 0.5);
  CHECK(sample_ok(kfs, 0.5) == expected);
  CHECK(sample_ok(kfs, 0.5) > 50.0);
}

TEST_CASE("spatial mode LINEAR ignores stored tangents, AUTO computes them", "[eval][abi][spatial]") {
  std::array<motion_keyframe, 3> linear_corner{kf(0.0, 0.0), kf(1.0, 10.0), kf(2.0, 0.0)};
  linear_corner[1].flags |= MOTION_KF_HAS_SO | MOTION_KF_HAS_SI;
  linear_corner[1].so = 30.0;
  linear_corner[1].si = -30.0;
  linear_corner[1].flags |= static_cast<std::uint32_t>(MOTION_SPATIAL_LINEAR) << MOTION_KF_SPATIAL_SHIFT;
  CHECK(sample_ok(linear_corner, 0.5) == 5.0);
  CHECK(sample_ok(linear_corner, 1.5) == 5.0);

  std::array<motion_keyframe, 3> auto_vertex{kf(0.0, 0.0), kf(1.0, 10.0), kf(2.0, 0.0)};
  auto_vertex[1].flags |= static_cast<std::uint32_t>(MOTION_SPATIAL_AUTO) << MOTION_KF_SPATIAL_SHIFT;
  // Catmull-Rom chord through (0,0)→(2,0) is flat: so = si = 0 at the apex.
  // Segment 1→2: c1 = 10 + 0, c2 = 0 + 10/3 (linear third, b has no tangent).
  // cubic(10, 10, 10/3, 0, 0.5) = 1.25 + 3.75 + 1.25 + 0 = 6.25.
  CHECK_THAT(sample_ok(auto_vertex, 1.5), WithinAbs(6.25, 1e-12));
  // Mirror image on 0→1: c1 = 0 + 10/3 (linear third), c2 = 10 + (-0) → the same 6.25.
  CHECK_THAT(sample_ok(auto_vertex, 0.5), WithinAbs(6.25, 1e-12));
}

// ── Argument validation ─────────────────────────────────────────────────────

TEST_CASE("empty input is INVALID_ARG and writes a message", "[eval][abi][errors]") {
  motion_error err{};
  err.message[0] = '\0';
  double out = 7.0;
  CHECK(motion_eval_sample_scalar(nullptr, 0, 0.0, &out, &err) == MOTION_INVALID_ARG);
  CHECK(err.message[0] != '\0');
  CHECK(out == 7.0);  // untouched on failure

  const std::array<motion_keyframe, 1> one{kf(0.0, 1.0)};
  CHECK(motion_eval_sample_scalar(one.data(), 0, 0.0, &out, nullptr) == MOTION_INVALID_ARG);
  CHECK(motion_eval_sample_scalar(nullptr, 1, 0.0, &out, nullptr) == MOTION_INVALID_ARG);
  CHECK(motion_eval_sample_scalar(one.data(), 1, 0.0, nullptr, nullptr) == MOTION_INVALID_ARG);
}

TEST_CASE("NaN anywhere is INVALID_ARG", "[eval][abi][errors]") {
  const std::array<motion_keyframe, 2> good{kf(0.0, 0.0), kf(1.0, 1.0)};
  CHECK(sample_status(good, kNaN, nullptr) == MOTION_INVALID_ARG);

  std::array<motion_keyframe, 2> bad_t = good;
  bad_t[1].t = kNaN;
  CHECK(sample_status(bad_t, 0.5, nullptr) == MOTION_INVALID_ARG);

  std::array<motion_keyframe, 2> bad_v = good;
  bad_v[0].value = kNaN;
  CHECK(sample_status(bad_v, 0.5, nullptr) == MOTION_INVALID_ARG);

  std::array<motion_keyframe, 2> bad_handle{bez(0.0, 0.0, kNaN, 0.0, 1.0, 1.0), kf(1.0, 1.0)};
  CHECK(sample_status(bad_handle, 0.5, nullptr) == MOTION_INVALID_ARG);

  // An unused handle may be anything: only flagged fields are read.
  std::array<motion_keyframe, 2> unused_nan = good;
  unused_nan[0].c0 = kNaN;
  unused_nan[0].si = kNaN;
  CHECK(sample_status(unused_nan, 0.5, nullptr) == MOTION_OK);
}

TEST_CASE("bad enums, unknown flags and unsorted times are INVALID_ARG", "[eval][abi][errors]") {
  std::array<motion_keyframe, 2> kfs{kf(0.0, 0.0), kf(1.0, 1.0)};
  kfs[0].easing = 99;
  CHECK(sample_status(kfs, 0.5, nullptr) == MOTION_INVALID_ARG);
  kfs[0].easing = -1;
  CHECK(sample_status(kfs, 0.5, nullptr) == MOTION_INVALID_ARG);
  kfs[0].easing = MOTION_EASING_LINEAR;

  kfs[0].flags = 0x8000u;
  CHECK(sample_status(kfs, 0.5, nullptr) == MOTION_INVALID_ARG);
  kfs[0].flags = 9u << MOTION_KF_SPATIAL_SHIFT;  // spatial mode 9 does not exist
  CHECK(sample_status(kfs, 0.5, nullptr) == MOTION_INVALID_ARG);
  kfs[0].flags = 0u;

  const std::array<motion_keyframe, 2> unsorted{kf(1.0, 0.0), kf(0.0, 1.0)};
  motion_error err{};
  CHECK(sample_status(unsorted, 0.5, &err) == MOTION_INVALID_ARG);
  CHECK(err.message[0] != '\0');
}

// ── Batch ───────────────────────────────────────────────────────────────────

TEST_CASE("batch equals per-sample", "[eval][abi][batch]") {
  std::vector<double> times;
  for (int i = -4; i <= 44; ++i) times.push_back(static_cast<double>(i) * 0.0625);
  std::vector<double> out(times.size(), kNaN);
  motion_error err{};
  const motion_status st = motion_eval_sample_scalar_batch(
      kGoldenKfs.data(), kGoldenKfs.size(), times.data(), times.size(), out.data(), &err);
  INFO(err.message);
  REQUIRE(st == MOTION_OK);
  for (std::size_t i = 0; i < times.size(); ++i) {
    CHECK(out[i] == sample_ok(kGoldenKfs, times[i]));
  }
}

TEST_CASE("batch: n == 0 is OK, NaN time fails before writing, null pointers fail",
          "[eval][abi][batch][errors]") {
  const std::array<motion_keyframe, 2> kfs{kf(0.0, 0.0), kf(1.0, 1.0)};
  CHECK(motion_eval_sample_scalar_batch(kfs.data(), kfs.size(), nullptr, 0, nullptr, nullptr) ==
        MOTION_OK);

  const std::array<double, 3> times{0.25, kNaN, 0.75};
  std::array<double, 3> out{7.0, 7.0, 7.0};
  CHECK(motion_eval_sample_scalar_batch(kfs.data(), kfs.size(), times.data(), times.size(),
                                        out.data(), nullptr) == MOTION_INVALID_ARG);
  CHECK(out[0] == 7.0);
  CHECK(out[2] == 7.0);

  CHECK(motion_eval_sample_scalar_batch(kfs.data(), kfs.size(), times.data(), times.size(),
                                        nullptr, nullptr) == MOTION_INVALID_ARG);
  CHECK(motion_eval_sample_scalar_batch(kfs.data(), kfs.size(), nullptr, 1, out.data(), nullptr) ==
        MOTION_INVALID_ARG);
}

// ── Packed layout (what the N-API and WASM bindings hand over) ──────────────

TEST_CASE("packed sampling equals struct sampling", "[eval][abi][packed]") {
  const std::vector<double> packed = pack(kGoldenKfs);
  REQUIRE(packed.size() == kGoldenKfs.size() * MOTION_KEYFRAME_PACKED_DOUBLES);
  for (const GoldenSample& g : kGoldenSamples) {
    double out = kNaN;
    motion_error err{};
    const motion_status st =
        motion_eval_sample_scalar_packed(packed.data(), kGoldenKfs.size(), g.t, &out, &err);
    INFO("t=" << g.t << " " << err.message);
    REQUIRE(st == MOTION_OK);
    CHECK(out == sample_ok(kGoldenKfs, g.t));
  }

  std::vector<double> times;
  for (const GoldenSample& g : kGoldenSamples) times.push_back(g.t);
  std::vector<double> out(times.size(), kNaN);
  REQUIRE(motion_eval_sample_scalar_packed_batch(packed.data(), kGoldenKfs.size(), times.data(),
                                                 times.size(), out.data(), nullptr) == MOTION_OK);
  for (std::size_t i = 0; i < times.size(); ++i) CHECK(out[i] == kGoldenSamples[i].expected);
}

TEST_CASE("packed: non-integral or out-of-range easing/flags are INVALID_ARG",
          "[eval][abi][packed][errors]") {
  std::vector<double> packed = pack(std::array<motion_keyframe, 2>{kf(0.0, 0.0), kf(1.0, 1.0)});
  double out = kNaN;
  packed[2] = 2.5;  // easing must be an integer
  CHECK(motion_eval_sample_scalar_packed(packed.data(), 2, 0.5, &out, nullptr) == MOTION_INVALID_ARG);
  packed[2] = 99.0;
  CHECK(motion_eval_sample_scalar_packed(packed.data(), 2, 0.5, &out, nullptr) == MOTION_INVALID_ARG);
  packed[2] = 0.0;
  packed[3] = -1.0;  // flags must be a non-negative integer
  CHECK(motion_eval_sample_scalar_packed(packed.data(), 2, 0.5, &out, nullptr) == MOTION_INVALID_ARG);
  packed[3] = 0.0;
  CHECK(motion_eval_sample_scalar_packed(packed.data(), 2, 0.5, &out, nullptr) == MOTION_OK);
  CHECK(out == 0.5);
  CHECK(motion_eval_sample_scalar_packed(nullptr, 2, 0.5, &out, nullptr) == MOTION_INVALID_ARG);
  CHECK(motion_eval_sample_scalar_packed(packed.data(), 0, 0.5, &out, nullptr) == MOTION_INVALID_ARG);
}

// ── The golden gate ─────────────────────────────────────────────────────────

TEST_CASE("golden: within 1e-9 relative of the TypeScript sampler", "[eval][golden]") {
  REQUIRE(kGoldenKfs.size() == 3);
  REQUIRE(kGoldenSamples.size() >= 20);
  for (const GoldenSample& g : kGoldenSamples) {
    const double actual = sample_ok(kGoldenKfs, g.t);
    INFO("t=" << g.t << " expected=" << g.expected << " actual=" << actual);
    CHECK_THAT(actual, WithinRel(g.expected, 1e-9) || WithinAbs(g.expected, 1e-12));
  }
}

TEST_CASE("golden: bit-identical to the TypeScript sampler", "[eval][golden][bits]") {
  // Same IEEE-754 operations in the same order, no contraction (-ffp-contract=off),
  // no libm beyond fabs/floor: the bytes must match. A failure here with the
  // tolerance test green means a platform is fusing or reordering — find it,
  // do not loosen this.
  for (const GoldenSample& g : kGoldenSamples) {
    const double actual = sample_ok(kGoldenKfs, g.t);
    INFO("t=" << g.t << " expected=" << g.expected << " actual=" << actual);
    CHECK(actual == g.expected);
  }
}
