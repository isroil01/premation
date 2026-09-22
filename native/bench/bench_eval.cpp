// motion_eval benchmarks: 10 000 samples over a 100-keyframe track.
//
// Three shapes of the same work, so a regression can be attributed:
//   per-sample C ABI calls (validation each call)      — how the bridge would
//                                                        call it naively
//   one batch call (validation once)                   — the intended path
//   the packed layout, batched                         — what N-API/WASM see
//
// The track alternates bezier and linear easing and spans 0..100 s; sample
// times sweep the range monotonically (playback order), the common case.
// Nothing here is timed against a wall clock inside the library.

#include <benchmark/benchmark.h>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "motion/motion_eval.h"

namespace {

constexpr std::size_t kKeyframes = 100;
constexpr std::size_t kSamples = 10000;

std::vector<motion_keyframe> make_track() {
  std::vector<motion_keyframe> kfs;
  kfs.reserve(kKeyframes);
  for (std::size_t i = 0; i < kKeyframes; ++i) {
    motion_keyframe k{};
    k.t = static_cast<double>(i);
    k.value = (i % 2 == 0) ? 0.0 : 100.0 + static_cast<double>(i);
    if (i % 2 == 0) {
      k.easing = MOTION_EASING_BEZIER;
      k.flags = MOTION_KF_HAS_BEZIER;
      k.c0 = 0.42;
      k.c1 = 0.0;
      k.c2 = 0.58;
      k.c3 = 1.0;
    } else {
      k.easing = MOTION_EASING_LINEAR;
    }
    kfs.push_back(k);
  }
  return kfs;
}

std::vector<double> make_times() {
  std::vector<double> times;
  times.reserve(kSamples);
  const double step = static_cast<double>(kKeyframes - 1) / static_cast<double>(kSamples);
  for (std::size_t i = 0; i < kSamples; ++i) times.push_back(static_cast<double>(i) * step);
  return times;
}

std::vector<double> pack(const std::vector<motion_keyframe>& kfs) {
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

void BM_SampleScalar_PerCall(benchmark::State& state) {
  const std::vector<motion_keyframe> kfs = make_track();
  const std::vector<double> times = make_times();
  for (auto _ : state) {
    double acc = 0.0;
    for (const double t : times) {
      double out = 0.0;
      motion_status st = motion_eval_sample_scalar(kfs.data(), kfs.size(), t, &out, nullptr);
      benchmark::DoNotOptimize(st);
      acc += out;
    }
    benchmark::DoNotOptimize(acc);
  }
  state.SetItemsProcessed(state.iterations() * static_cast<std::int64_t>(kSamples));
}
BENCHMARK(BM_SampleScalar_PerCall);

void BM_SampleScalar_Batch(benchmark::State& state) {
  const std::vector<motion_keyframe> kfs = make_track();
  const std::vector<double> times = make_times();
  std::vector<double> out(times.size(), 0.0);
  for (auto _ : state) {
    motion_status st = motion_eval_sample_scalar_batch(kfs.data(), kfs.size(), times.data(),
                                                             times.size(), out.data(), nullptr);
    benchmark::DoNotOptimize(st);
    benchmark::DoNotOptimize(out.data());
    benchmark::ClobberMemory();
  }
  state.SetItemsProcessed(state.iterations() * static_cast<std::int64_t>(kSamples));
}
BENCHMARK(BM_SampleScalar_Batch);

void BM_SampleScalar_PackedBatch(benchmark::State& state) {
  const std::vector<motion_keyframe> kfs = make_track();
  const std::vector<double> packed = pack(kfs);
  const std::vector<double> times = make_times();
  std::vector<double> out(times.size(), 0.0);
  for (auto _ : state) {
    motion_status st = motion_eval_sample_scalar_packed_batch(
        packed.data(), kfs.size(), times.data(), times.size(), out.data(), nullptr);
    benchmark::DoNotOptimize(st);
    benchmark::DoNotOptimize(out.data());
    benchmark::ClobberMemory();
  }
  state.SetItemsProcessed(state.iterations() * static_cast<std::int64_t>(kSamples));
}
BENCHMARK(BM_SampleScalar_PackedBatch);

}  // namespace
