// E1 media, GPU-free and ffmpeg-free: the frame index (TS frameIndex.ts rules),
// time mapping (loop / posterize / stretch / pulldown / frame blending), the
// decoded-frame cache, and the Y'CbCr matrices.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <vector>

#include "frame_cache.hpp"
#include "frame_index.hpp"
#include "time_map.hpp"
#include "yuv.hpp"

using namespace premation::media;
using Catch::Approx;

namespace {

// frameIndex.test.ts: timescale 15360, 512 units per frame (30 fps), libx264's
// per-GOP decode order presenting [0, 3, 1, 2, 6, 4, 5, 7], shifted by the 2-frame B delay.
std::vector<SampleEntry> bframe_table(int gops) {
  constexpr std::array<int, 8> kPresent{0, 3, 1, 2, 6, 4, 5, 7};
  std::vector<SampleEntry> out;
  for (int g = 0; g < gops; ++g) {
    for (int k = 0; k < 8; ++k) out.push_back({static_cast<std::int64_t>(g * 8 + kPresent.at(static_cast<std::size_t>(k)) + 2) * 512, k == 0});
  }
  return out;
}

}  // namespace

TEST_CASE("frame index: B-frame reorder, rebase, GOP keys", "[media][index]") {
  const auto samples = bframe_table(3);
  const FrameIndex fi = FrameIndex::from_samples(samples, {1, 15360});
  REQUIRE(fi.size() == 24);
  REQUIRE(fi.exact());
  // Rebased: the first displayed frame is at 0 µs; frame i at round(i·512/15360·1e6).
  CHECK(fi.time_us(0) == 0);
  CHECK(fi.time_us(1) == 33333);
  CHECK(fi.time_us(3) == 100000);
  // Presentation frame 3 of GOP 1 (index 11) starts its decode at GOP 1's keyframe (index 8).
  CHECK(fi.gop_of(11) == 8);
  CHECK(fi.key_pts(11) == fi.pts(8));
  CHECK(fi.gop_of(7) == 0);
  // pts → index round trip.
  for (std::int64_t i = 0; i < fi.size(); ++i) CHECK(fi.index_of_pts(fi.pts(i)) == i);
  CHECK(fi.index_of_pts(12345) == -1);
}

TEST_CASE("frame index: open-GOP leading B-frames start at the previous keyframe", "[media][index]") {
  // Decode order I0 P3 B1 B2 I6 B4 B5 P9 B7 B8 : B4/B5 are shown before I6 but follow it in decode order.
  const std::vector<SampleEntry> s{{0, true}, {3, false}, {1, false}, {2, false}, {6, true}, {4, false},
                                   {5, false}, {9, false}, {7, false}, {8, false}};
  const FrameIndex fi = FrameIndex::from_samples(s, {1, 10});
  CHECK(fi.gop_of(3) == 0);
  CHECK(fi.gop_of(4) == 0);  // leading frame of I6's GOP
  CHECK(fi.gop_of(5) == 0);
  CHECK(fi.gop_of(6) == 6);
  CHECK(fi.gop_of(8) == 6);
  CHECK(fi.key_pts(5) == 0);
}

TEST_CASE("frame index: floor over [start, next), clamps, +1 µs rule", "[media][index]") {
  const FrameIndex fi = FrameIndex::from_samples(bframe_table(1), {1, 15360});
  CHECK(fi.frame_at_us(-5) == 0);
  CHECK(fi.frame_at_us(0) == 0);
  CHECK(fi.frame_at_us(33332) == 0);
  CHECK(fi.frame_at_us(33333) == 1);
  CHECK(fi.frame_at_us(99999999) == 7);  // past the end holds the last frame
  // k/30 s lands ON frame k (not k−1) thanks to the +1 µs.
  for (int k = 0; k < 8; ++k) CHECK(fi.frame_at_seconds(k / 30.0) == k);
  CHECK(fi.frame_at_seconds(-1.0) == 0);
  CHECK(fi.frame_at_seconds(1e300) == 7);
}

TEST_CASE("frame index: constant rate at NTSC 24000/1001", "[media][index]") {
  const FrameIndex fi = FrameIndex::constant_rate(240, {24000, 1001}, {1, 24000}, 0);
  REQUIRE(fi.size() == 240);
  CHECK_FALSE(fi.exact());
  CHECK(fi.pts(1) == 1001);
  CHECK(fi.pts(239) == 239 * 1001);
  CHECK(fi.index_of_pts(1001 * 57) == 57);
  // Every frame boundary k·1001/24000 s resolves to k (NTSC rates are where the +1 µs matters).
  for (int k = 0; k < 240; ++k) CHECK(fi.frame_at_seconds(k * 1001.0 / 24000.0) == k);
  // Mid-frame times floor.
  CHECK(fi.frame_at_seconds((10.5 * 1001.0) / 24000.0) == 10);
  CHECK(fi.frame_at_seconds(1000.0) == 239);
}

TEST_CASE("time map: loop, posterize, stretch/reverse/freeze", "[media][time]") {
  CHECK(loop_source_seconds(2.5, 2.0, 1) == 2.5);           // once: runs out
  CHECK(loop_source_seconds(2.5, 2.0, 0) == Approx(0.5));   // forever
  CHECK(loop_source_seconds(4.5, 2.0, 3) == Approx(0.5));   // third pass
  CHECK(loop_source_seconds(6.5, 2.0, 3) == Approx(2.0 - 1e-6));  // exhausted: hold last frame
  CHECK(loop_source_seconds(1.0, 0.0, 0) == 1.0);           // unknown duration: untouched
  CHECK(posterize_seconds(0.99, 12) == Approx(11.0 / 12.0));
  CHECK(posterize_seconds(0.5, 0) == 0.5);
  LayerTimeConfig half;
  half.stretch = 200;
  CHECK(layer_time_seconds(3.0, half, 1.0, 5.0) == Approx(2.0));
  LayerTimeConfig rev;
  rev.reverse = true;
  CHECK(layer_time_seconds(1.5, rev, 1.0, 5.0) == Approx(4.5));
  LayerTimeConfig fr;
  fr.freeze = true;
  fr.freezeTime = 0.25;
  CHECK(layer_time_seconds(9.0, fr, 0, 1) == 0.25);
}

TEST_CASE("time map: pulldown picks (pulldownDetect.ts)", "[media][time]") {
  // phase 0: k = n mod 5 → 0 plain, 1 plain, 2 → n−1, 3 → weave(n, n−1), 4 plain.
  CHECK(pulldown_pick(0, 0) == FramePick{0, std::nullopt});
  CHECK(pulldown_pick(2, 0) == FramePick{1, std::nullopt});
  CHECK(pulldown_pick(3, 0) == FramePick{3, 2});
  CHECK(pulldown_pick(4, 0) == FramePick{4, std::nullopt});
  CHECK(pulldown_pick(7, 0) == FramePick{6, std::nullopt});
  // phase > n at the start: served as-is.
  CHECK(pulldown_pick(0, 3) == FramePick{0, std::nullopt});
  CHECK(pulldown_pick(1, 3) == FramePick{1, 0});  // k = 3: weave with frame 0
}

TEST_CASE("time map: frame blending brackets on conform > probe > comp", "[media][time]") {
  const FrameIndex fi = FrameIndex::constant_rate(100, {30, 1}, {1, 30}, 0);
  FootageInterpretation in;
  // Off: one frame.
  FramePlan p = plan_frames(fi, 0.5, in, FrameBlend::none, 30, 24);
  CHECK(p.a.index == 15);
  CHECK_FALSE(p.b);
  // Frame mix on the probe grid (30): t = 0.51 → 15.3 → frames 15, 16 at 0.3.
  p = plan_frames(fi, 0.51, in, FrameBlend::mix, 30, 24);
  REQUIRE(p.b);
  CHECK(p.a.index == 15);
  CHECK(p.b->index == 16);
  CHECK(p.weight == Approx(0.3));
  CHECK(p.mode == FrameBlend::mix);
  // Exactly on a frame: weight ≤ 1e-3 → no blend.
  p = plan_frames(fi, 0.5, in, FrameBlend::mix, 30, 24);
  CHECK_FALSE(p.b);
  // Conform wins: 24 fps grid, 0.51·24 = 12.24 → times 12/24 and 13/24 → source frames 15, 16 (30 fps).
  in.conformFps = 24.0;
  p = plan_frames(fi, 0.51, in, FrameBlend::pixelMotion, 30, 60);
  REQUIRE(p.b);
  CHECK(p.a.index == 15);
  CHECK(p.b->index == 16);
  CHECK(p.weight == Approx(0.24));
  // Past the end both clamp to the last frame (still a pair, as the TS draws it).
  in.conformFps.reset();
  p = plan_frames(fi, 50.01, in, FrameBlend::mix, 30, 24);
  REQUIRE(p.b);
  CHECK(p.a.index == 99);
  CHECK(p.b->index == 99);
}

namespace {
std::shared_ptr<DecodedFrame> fake_frame(std::size_t cpu, std::size_t gpu, std::int64_t idx) {
  auto f = std::make_shared<DecodedFrame>();
  f->cpuBytes = cpu;
  f->gpuBytes = gpu;
  f->index = idx;
  return f;
}
}  // namespace

TEST_CASE("frame cache: LRU by bytes, separate budgets, nearest", "[media][cache]") {
  FrameCache c(300, 100);
  c.put(1, 0, fake_frame(100, 0, 0));
  c.put(1, 1, fake_frame(100, 0, 1));
  c.put(1, 2, fake_frame(100, 0, 2));
  CHECK(c.stats().frames == 3);
  REQUIRE(c.get(1, 0));  // 0 becomes most recent
  c.put(1, 3, fake_frame(100, 0, 3));  // evicts 1 (least recent)
  CHECK(c.contains(1, 0));
  CHECK_FALSE(c.contains(1, 1));
  CHECK(c.stats().cpuBytes == 300);
  // GPU budget is its own.
  c.put(2, 0, fake_frame(0, 100, 0));
  c.put(2, 1, fake_frame(0, 100, 1));
  CHECK_FALSE(c.contains(2, 0));
  CHECK(c.contains(2, 1));
  CHECK(c.stats().gpuBytes == 100);
  // Nearest: ties → earlier.
  CHECK(c.nearest(1, 1)->index == 0);
  CHECK(c.nearest(1, 100)->index == 3);
  CHECK(c.nearest(9, 0) == nullptr);
  // A reader keeps an evicted frame alive.
  FramePtr held = c.get(1, 2);
  c.drop_source(1);
  CHECK(c.stats().frames == 1);
  CHECK(held->index == 2);
  // Oversized newest frame is kept alone.
  c.put(3, 0, fake_frame(10'000, 0, 0));
  CHECK(c.contains(3, 0));
}

TEST_CASE("Y'CbCr: BT.709 limited 8-bit reference points", "[media][yuv]") {
  FrameFormat f;
  f.matrix = Matrix::bt709;
  f.range = Range::limited;
  const YuvToRgb c = yuv_to_rgb(f);
  auto near = [](const std::array<double, 4>& v, double r, double g, double b) {
    CHECK(v[0] == Approx(r).margin(2e-3));
    CHECK(v[1] == Approx(g).margin(2e-3));
    CHECK(v[2] == Approx(b).margin(2e-3));
  };
  near(convert_codes(c, 16, 128, 128, 0, false), 0, 0, 0);
  near(convert_codes(c, 235, 128, 128, 0, false), 1, 1, 1);
  near(convert_codes(c, 126, 128, 128, 0, false), 110.0 / 219.0, 110.0 / 219.0, 110.0 / 219.0);
  // 100 % red in BT.709 limited: Y 63, Cb 102, Cr 240.
  // (the reference codes are rounded: ±4e-3)
  const auto red = convert_codes(c, 63, 102, 240, 0, false);
  CHECK(red[0] == Approx(1).margin(4e-3));
  CHECK(red[1] == Approx(0).margin(4e-3));
  CHECK(red[2] == Approx(0).margin(4e-3));
  CHECK(convert_codes(c, 16, 128, 128, 0, false)[3] == 1.0);
}

TEST_CASE("Y'CbCr: 10-bit, full range, BT.601, BT.2020, alpha", "[media][yuv]") {
  FrameFormat f;
  f.bitDepth = 10;
  f.bytesPerSample = 2;
  f.matrix = Matrix::bt2020nc;
  f.range = Range::limited;
  YuvToRgb c = yuv_to_rgb(f);
  CHECK(convert_codes(c, 940, 512, 512, 0, false)[0] == Approx(1.0).margin(1e-6));
  CHECK(convert_codes(c, 64, 512, 512, 0, false)[1] == Approx(0.0).margin(1e-6));
  // BT.2020 red: Y = 0.2627 → 64 + 876·0.2627; Cr = 0.5 → 512 + 448·1.
  CHECK(convert_codes(c, 64 + 876 * 0.2627, 512 + 448 * (-0.2627 / (2 * (1 - 0.0593))), 960, 0, false)[0] ==
        Approx(1.0).margin(1e-4));
  f.range = Range::full;
  f.bitDepth = 8;
  f.matrix = Matrix::smpte170m;
  c = yuv_to_rgb(f);
  CHECK(convert_codes(c, 255, 128, 128, 0, false)[2] == Approx(1.0).margin(1e-6));
  CHECK(convert_codes(c, 0, 128, 128, 0, false)[2] == Approx(0.0).margin(1e-6));
  // BT.601 full-range green channel for pure Cb: G = Y − 0.344136·Cb'.
  CHECK(convert_codes(c, 128, 255, 128, 0, false)[1] == Approx((128 - 0.344136 * 127) / 255.0).margin(2e-3));
  // Alpha: code / max.
  f.hasAlpha = true;
  f.bitDepth = 10;
  c = yuv_to_rgb(f);
  CHECK(convert_codes(c, 0, 512, 512, 1023, true)[3] == Approx(1.0));
  CHECK(convert_codes(c, 0, 512, 512, 512, true)[3] == Approx(512.0 / 1023.0));
}

TEST_CASE("Y'CbCr: matrix/range resolution and input space", "[media][yuv]") {
  CHECK(resolve_matrix(Matrix::unspecified, Primaries::unspecified, 480) == Matrix::smpte170m);
  CHECK(resolve_matrix(Matrix::unspecified, Primaries::unspecified, 1080) == Matrix::bt709);
  CHECK(resolve_matrix(Matrix::unspecified, Primaries::bt2020, 2160) == Matrix::bt2020nc);
  CHECK(resolve_matrix(Matrix::bt709, Primaries::bt2020, 480) == Matrix::bt709);
  CHECK(resolve_range(Range::unspecified) == Range::limited);
  ColorInfo ci;
  CHECK(input_space_of(ci).renderColorSpace == 1);
  ci.primaries = Primaries::bt2020;
  ci.transfer = Transfer::pq;
  CHECK(input_space_of(ci).renderColorSpace == 4);
  CHECK(input_space_of(ci).hdrUnmodelled);
  ci.transfer = Transfer::linear;
  CHECK(input_space_of(ci).renderColorSpace == 5);
  // Planar RGB full range: per-channel identity.
  FrameFormat f;
  f.layout = Layout::planarRgb;
  f.matrix = Matrix::rgb;
  f.range = Range::full;
  f.bitDepth = 10;
  const auto c = yuv_to_rgb(f);
  const auto v = convert_codes(c, 1023, 0, 511.5, 0, false);
  CHECK(v[0] == Approx(1.0));
  CHECK(v[1] == Approx(0.0));
  CHECK(v[2] == Approx(0.5));
}
