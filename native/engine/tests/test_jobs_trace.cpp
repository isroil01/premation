// Engine jobs `autoTrace` / `objectMatte`: the pure halves on synthetic
// input — the bitmap tracer (jobs/trace_bitmap.hpp, traceBitmap.ts +
// autoTrace.ts ring layout) and SAM's pre/post-processing
// (jobs/sam_pipeline.hpp, samPipeline.ts). The model itself is not run here.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <vector>

#include "jobs/sam_pipeline.hpp"
#include "jobs/trace_bitmap.hpp"

using namespace premation::jobs;
using Catch::Approx;
using trace::TracePoint;

namespace {

struct Plane {
  std::uint32_t w = 0;
  std::uint32_t h = 0;
  std::vector<std::uint8_t> px;
  Plane(std::uint32_t width, std::uint32_t height) : w(width), h(height), px(std::size_t{width} * height, 0) {}
  void fill(std::uint32_t x0, std::uint32_t y0, std::uint32_t x1, std::uint32_t y1, std::uint8_t v) {
    for (std::uint32_t y = y0; y <= y1; ++y) {
      for (std::uint32_t x = x0; x <= x1; ++x) px[std::size_t{y} * w + x] = v;
    }
  }
};

std::vector<TracePoint> pts(std::initializer_list<TracePoint> l) { return l; }

Plane donut_and_square() {
  // Donut: pixels 1…8 with a 2×2 hole at 4…5; a square found AFTER the hole's row.
  Plane p(20, 12);
  p.fill(1, 1, 8, 8, 255);
  p.fill(4, 4, 5, 5, 0);
  p.fill(12, 6, 15, 9, 255);
  return p;
}

}  // namespace

TEST_CASE("trace: two squares trace to their pixel-edge rectangles, in raster order", "[jobs][trace]") {
  Plane p(20, 10);
  p.fill(2, 2, 5, 5, 255);
  p.fill(10, 3, 15, 6, 255);
  const auto c = trace::trace_bitmap(p.px, p.w, p.h, 1, {});
  REQUIRE(c.size() == 2);
  CHECK_FALSE(c[0].hole);
  CHECK_FALSE(c[1].hole);
  CHECK(c[0].points == pts({{2, 2}, {6, 2}, {6, 6}, {2, 6}}));
  CHECK(c[1].points == pts({{10, 3}, {16, 3}, {16, 7}, {10, 7}}));
  CHECK(trace::signed_area(c[0].points) == 16);  // clockwise in y-down space
}

TEST_CASE("trace: a hole is its own counter-clockwise contour", "[jobs][trace]") {
  Plane p(10, 10);
  p.fill(1, 1, 8, 8, 255);
  p.fill(4, 4, 5, 5, 0);
  const auto c = trace::trace_bitmap(p.px, p.w, p.h, 1, {});
  REQUIRE(c.size() == 2);
  CHECK_FALSE(c[0].hole);
  CHECK(c[0].points == pts({{1, 1}, {9, 1}, {9, 9}, {1, 9}}));
  CHECK(c[1].hole);
  CHECK(c[1].points == pts({{4, 4}, {4, 6}, {6, 6}, {6, 4}}));
  CHECK(trace::signed_area(c[1].points) == -4);

  // minArea drops the 4 px² hole; the threshold is ≥, read from the last byte of a stride.
  trace::TraceOptions big;
  big.minArea = 5;
  CHECK(trace::trace_bitmap(p.px, p.w, p.h, 1, big).size() == 1);
  trace::TraceOptions high;
  high.threshold = 256;
  CHECK(trace::trace_bitmap(p.px, p.w, p.h, 1, high).empty());
}

TEST_CASE("trace: a filled circle is one simplified ring on the circle", "[jobs][trace]") {
  Plane p(64, 64);
  for (std::uint32_t y = 0; y < 64; ++y) {
    for (std::uint32_t x = 0; x < 64; ++x) {
      const double dx = x + 0.5 - 32;
      const double dy = y + 0.5 - 32;
      if (dx * dx + dy * dy <= 400) p.px[std::size_t{y} * 64 + x] = 255;
    }
  }
  const auto c = trace::trace_bitmap(p.px, p.w, p.h, 1, {});
  REQUIRE(c.size() == 1);
  CHECK_FALSE(c[0].hole);
  CHECK(std::abs(trace::signed_area(c[0].points)) == Approx(3.14159265 * 400).epsilon(0.08));
  CHECK(c[0].points.size() >= 8);
  CHECK(c[0].points.size() < 80);  // far fewer than the staircase's corners
  for (const TracePoint& q : c[0].points) CHECK(std::abs(std::hypot(q.x - 32, q.y - 32) - 20) <= 1.5);
  // tolerance 0 keeps every corner of the staircase.
  trace::TraceOptions exact;
  exact.tolerance = 0;
  CHECK(trace::trace_bitmap(p.px, p.w, p.h, 1, exact)[0].points.size() > c[0].points.size());
}

TEST_CASE("trace: simplify_ring drops collinear vertices, keeps corners", "[jobs][trace]") {
  const auto ring = pts({{0, 0}, {5, 0}, {10, 0}, {10, 10}, {0, 10}});
  CHECK(trace::simplify_ring(ring, 1) == pts({{0, 0}, {10, 0}, {10, 10}, {0, 10}}));
  CHECK(trace::simplify_ring(ring, 0) == ring);  // eps 0: as is
}

TEST_CASE("auto-trace: rings in layer-centred space, outer rings before holes", "[jobs][trace]") {
  const Plane p = donut_and_square();
  trace::AutoTraceParams params;
  params.minArea = 4;
  const auto rings = trace::auto_trace_rings(p.px, p.w, p.h, 20, 12, params);
  REQUIRE(rings.size() == 3);
  CHECK_FALSE(rings[0].hole);
  CHECK_FALSE(rings[1].hole);
  CHECK(rings[2].hole);
  CHECK(rings[0].points == pts({{-9, -5}, {-1, -5}, {-1, 3}, {-9, 3}}));
  CHECK(rings[1].points == pts({{2, 0}, {6, 0}, {6, 4}, {2, 4}}));
  CHECK(rings[2].points == pts({{-6, -2}, {-6, 0}, {-4, 0}, {-4, -2}}));

  // A half-size plane maps back to layer pixels; minArea is in layer px² (16 = the 2×2 px square at 2×).
  Plane half(20, 10);
  half.fill(2, 2, 5, 5, 255);
  const auto scaled = trace::auto_trace_rings(half.px, half.w, half.h, 40, 20, {});
  REQUIRE(scaled.size() == 1);
  CHECK(scaled[0].points == pts({{-16, -6}, {-8, -6}, {-8, 2}, {-16, 2}}));

  // The default minArea (16) drops the 4 px² hole.
  CHECK(trace::auto_trace_rings(p.px, p.w, p.h, 20, 12, {}).size() == 2);
}

TEST_CASE("auto-trace: channel planes, invert and blur", "[jobs][trace]") {
  RgbaImage img;
  img.width = 1;
  img.height = 1;
  img.rgba = {255, 0, 0, 128};
  CHECK(trace::channel_plane(img, trace::Channel::alpha, false)[0] == 128);
  CHECK(trace::channel_plane(img, trace::Channel::alpha, true)[0] == 127);
  CHECK(trace::channel_plane(img, trace::Channel::red, false)[0] == 128);
  CHECK(trace::channel_plane(img, trace::Channel::green, false)[0] == 0);
  CHECK(trace::channel_plane(img, trace::Channel::luminance, false)[0] == 27);

  trace::Channel ch = trace::Channel::red;
  CHECK(trace::parse_channel("", ch));
  CHECK(ch == trace::Channel::alpha);
  CHECK(trace::parse_channel("luminance", ch));
  CHECK(ch == trace::Channel::luminance);
  CHECK_FALSE(trace::parse_channel("hue", ch));

  const std::vector<std::uint8_t> line{0, 0, 255, 0, 0};
  CHECK(trace::box_blur(line, 5, 1, 1) == std::vector<std::uint8_t>{0, 85, 85, 85, 0});
  CHECK(trace::box_blur(line, 5, 1, 0) == line);
}

TEST_CASE("sam: letterbox and preprocessing match samPipeline.ts", "[jobs][sam]") {
  const sam::Letterbox l = sam::letterbox(1920, 1080);
  CHECK(l.scale == Approx(1024.0 / 1920.0));
  CHECK(l.resizedW == 1024);
  CHECK(l.resizedH == 576);

  // 2×1: white, black. scale 512 → resized 1024×512; x ≥ 256 rounds to source x 1.
  const std::vector<std::uint8_t> rgba{255, 255, 255, 255, 0, 0, 0, 255};
  const std::vector<float> t = sam::preprocess(rgba, 2, 1);
  constexpr std::size_t plane = 1024 * 1024;
  REQUIRE(t.size() == 3 * plane);
  CHECK(t[0] == static_cast<float>((1.0 - 0.485) / 0.229));
  CHECK(t[255] == static_cast<float>((1.0 - 0.485) / 0.229));
  CHECK(t[256] == static_cast<float>((0.0 - 0.485) / 0.229));
  CHECK(t[plane + 0] == static_cast<float>((1.0 - 0.456) / 0.224));
  CHECK(t[2 * plane + 300] == static_cast<float>((0.0 - 0.406) / 0.225));
  CHECK(t[511 * 1024] == static_cast<float>((1.0 - 0.485) / 0.229));
  CHECK(t[512 * 1024] == 0.0F);  // padding is 0 after normalization
}

TEST_CASE("sam: prompts in resized-image space; a box only without points", "[jobs][sam]") {
  const std::vector<sam::Point> points{{100, 50, 1}, {10, 20, 0}};
  const auto p = sam::prompts_for(points, sam::Box{0, 0, 100, 200}, 0.5);
  REQUIRE(p);
  CHECK(p->coords == std::vector<float>{50, 25, 5, 10});
  CHECK(p->labels == std::vector<std::int64_t>{1, 0});
  const auto b = sam::prompts_for({}, sam::Box{0, 0, 100, 200}, 2);
  REQUIRE(b);
  CHECK(b->coords == std::vector<float>{100, 200});
  CHECK(b->labels == std::vector<std::int64_t>{1});
  CHECK_FALSE(sam::prompts_for({}, std::nullopt, 1));
}

TEST_CASE("sam: mask upsample is bilinear in logit space, thresholded at > 0", "[jobs][sam]") {
  // Rows < 128 are +1, the rest −1: at step 0.25 (a 1024 px frame) the crossing
  // sits half-way between rows 127 and 128 — frame rows 0…509 in, 510… out.
  std::vector<float> logits(256 * 256);
  for (std::size_t r = 0; r < 256; ++r) {
    for (std::size_t c = 0; c < 256; ++c) logits[r * 256 + c] = r < 128 ? 1.0F : -1.0F;
  }
  const auto m = sam::upsample_mask(logits, 0, 4, 1024, 1.0);
  REQUIRE(m.size() == 4 * 1024);
  CHECK(m[0] == 255);
  CHECK(m[509 * 4] == 255);
  CHECK(m[510 * 4] == 0);
  CHECK(m[1023 * 4 + 3] == 0);

  CHECK(sam::best_mask(std::vector<float>{0.2F, 0.9F, 0.9F}) == 1);

  std::vector<std::uint8_t> full(100 * 100, 255);
  sam::constrain_to_box(full, 100, 100, sam::Box{40, 40, 60, 60});  // margin 20·0.08 + 4 = 5.6
  CHECK(full[50 * 100 + 34] == 0);
  CHECK(full[50 * 100 + 35] == 255);
  CHECK(full[50 * 100 + 65] == 255);
  CHECK(full[50 * 100 + 66] == 0);
  CHECK(full[34 * 100 + 50] == 0);
}

TEST_CASE("sam: decoder outputs → best candidate → frame mask", "[jobs][sam]") {
  constexpr std::size_t plane = 256 * 256;
  std::vector<float> masks(3 * plane, -5.0F);
  for (std::size_t i = plane; i < 2 * plane; ++i) masks[i] = 5.0F;
  const std::vector<float> iou{0.1F, 0.8F, 0.3F};
  const auto m = sam::mask_from_decoder(iou, masks, 8, 8, std::nullopt);
  REQUIRE(m.size() == 64);
  for (const std::uint8_t v : m) CHECK(v == 255);
  // A box (0,0)-(1,1) keeps x, y ≤ 1 + 4.08.
  const auto boxed = sam::mask_from_decoder(iou, masks, 8, 8, sam::Box{0, 0, 1, 1});
  CHECK(boxed[5 * 8 + 5] == 255);
  CHECK(boxed[5 * 8 + 6] == 0);
  CHECK(boxed[6 * 8 + 0] == 0);
  // Wrong shapes answer nothing.
  CHECK(sam::mask_from_decoder(iou, std::vector<float>(plane), 8, 8, std::nullopt).empty());
}

TEST_CASE("sam: the matte's outline is its largest outer contour, at most 48 points", "[jobs][sam]") {
  Plane p(40, 20);
  p.fill(1, 1, 4, 4, 255);
  p.fill(20, 2, 29, 11, 255);
  CHECK(sam::matte_contour(p.px, p.w, p.h) == pts({{20, 2}, {30, 2}, {30, 12}, {20, 12}}));

  Plane disc(200, 200);
  for (std::uint32_t y = 0; y < 200; ++y) {
    for (std::uint32_t x = 0; x < 200; ++x) {
      const double dx = x + 0.5 - 100;
      const double dy = y + 0.5 - 100;
      if (dx * dx + dy * dy <= 80 * 80) disc.px[std::size_t{y} * 200 + x] = 255;
    }
  }
  const auto c = sam::matte_contour(disc.px, disc.w, disc.h);
  CHECK(c.size() >= 3);
  CHECK(c.size() <= sam::kMaxContourPoints);
  CHECK(sam::matte_contour(std::vector<std::uint8_t>(64, 0), 8, 8).empty());
}
