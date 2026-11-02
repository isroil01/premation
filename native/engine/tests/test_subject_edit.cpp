// The subject's soft matte, edited a frame at a time (jobs/subject_edit.hpp).

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <utility>
#include <vector>

#include "export/png_write.hpp"
#include "jobs/matte_refine.hpp"
#include "jobs/sam_pipeline.hpp"
#include "jobs/subject_edit.hpp"
#include "jobs/vitmatte.hpp"

namespace se = premation::jobs::subject;
namespace sam = premation::jobs::sam;
namespace mt = premation::jobs::matte;

namespace {
constexpr std::size_t kPlane = static_cast<std::size_t>(sam::kMaskSize) * sam::kMaskSize;

/// A logit plane: +8 inside the rectangle [x0, x1) × [y0, y1) of the 256² grid, −8 outside.
void rect(std::vector<float>& logits, std::size_t k, int x0, int y0, int x1, int y1) {
  for (int y = 0; y < 256; ++y)
    for (int x = 0; x < 256; ++x)
      logits[k * kPlane + static_cast<std::size_t>(y) * 256 + static_cast<std::size_t>(x)] = x >= x0 && x < x1 && y >= y0 && y < y1 ? 8.0f : -8.0f;
}
}  // namespace

TEST_CASE("ViTMatte's input: normalised RGB, the trimap as is, zero-padded to 32", "[jobs][subject]") {
  const std::vector<std::uint8_t> rgba{255, 0, 128, 255, 0, 255, 0, 255};  // 2×1
  const std::vector<float> tri{1.0f, 0.5f};
  int pw = 0;
  int ph = 0;
  const std::vector<float> in = premation::jobs::vitmatte::prepare_input(rgba, tri, 2, 1, pw, ph);
  REQUIRE(pw == 32);
  REQUIRE(ph == 32);
  const std::size_t plane = 32 * 32;
  REQUIRE(in.size() == plane * 4);
  CHECK(in[0] == 1.0f);              // the first pixel's R, (1 − 0.5) / 0.5
  CHECK(in[plane] == -1.0f);         // its G
  CHECK(in[plane * 3] == 1.0f);      // its trimap
  CHECK(in[plane * 3 + 1] == 0.5f);  // the second pixel's trimap
  CHECK(in[plane * 3 + 2] == 0.0f);  // padding
}

TEST_CASE("a stroke becomes a few prompts spread along it, ends included", "[jobs][subject]") {
  std::vector<se::Pt> s;
  for (int i = 0; i <= 200; ++i) s.push_back({static_cast<double>(i), 10.0});
  const std::vector<se::Pt> p = se::sample_stroke(s, 5);
  REQUIRE(p.size() == 5);
  CHECK(p.front().x == 0.0);
  CHECK(std::abs(p.back().x - 200.0) < 1e-9);
  CHECK(std::abs(p[2].x - 100.0) < 1e-9);
  // A click (no length) is one prompt.
  CHECK(se::sample_stroke(std::vector<se::Pt>{{5, 5}, {5.5, 5}}, 5).size() == 1);
}

TEST_CASE("a stroke is sampled about one prompt per brush diameter, capped", "[jobs][subject]") {
  std::vector<se::Pt> s;
  for (int i = 0; i <= 200; ++i) s.push_back({static_cast<double>(i), 10.0});
  // 200 px long, radius 10 → a prompt every 20 px: 11 points, ends included.
  const std::vector<se::Pt> p = se::sample_stroke_by_radius(s, 10);
  REQUIRE(p.size() == 11);
  CHECK(p.front().x == 0.0);
  CHECK(std::abs(p.back().x - 200.0) < 1e-9);
  // A fine brush on a long stroke stays within the cap.
  CHECK(se::sample_stroke_by_radius(s, 1).size() == se::kMaxStrokePrompts);
  CHECK(se::sample_stroke_by_radius(s, 1, 6).size() == 6);
  // A dab is one click.
  CHECK(se::sample_stroke_by_radius(std::vector<se::Pt>{{5, 5}, {6, 5}}, 10).size() == 1);
  // Several strokes share one budget, in order.
  const std::vector<std::vector<se::Pt>> many{s, s, s};
  const std::vector<se::Pt> all = se::sample_strokes(many, 10);
  CHECK(all.size() == se::kMaxStrokePrompts);
  CHECK(all[11].x == 0.0);  // the second stroke starts where the first's 11 ended
}

TEST_CASE("a lone click picks the whole object, a subtract the smallest thing under it", "[jobs][subject]") {
  // Frame 1024² (scale 1): logit cell = 4 px. Candidates: a shirt, the person, most of the frame.
  std::vector<float> logits(3 * kPlane);
  rect(logits, 0, 100, 100, 140, 140);  // shirt
  rect(logits, 1, 90, 40, 160, 250);   // person
  rect(logits, 2, 0, 0, 256, 220);     // most of the frame
  const std::vector<float> iou{0.93f, 0.90f, 0.70f};
  const std::vector<sam::Point> click{{480, 480, 1}};  // cell (120, 120): inside all three
  se::Intent lone;
  lone.loneClick = true;
  CHECK(se::choose_candidate(iou, logits, click, 1.0, lone, 1024, 1024) == 1);
  se::Intent sub;
  sub.subtract = true;
  CHECK(se::choose_candidate(iou, logits, click, 1.0, sub, 1024, 1024) == 0);
  // A stroke running from the shirt down the legs: the person covers it, the shirt does not.
  const std::vector<sam::Point> stroke{{480, 480, 1}, {480, 700, 1}, {480, 900, 1}};
  CHECK(se::choose_candidate(iou, logits, stroke, 1.0, se::Intent{}, 1024, 1024) == 1);
}

TEST_CASE("a click picks the whole person over the shirt SAM rates higher", "[jobs][subject]") {
  // A skater (measured): the shirt 0.97, the person 0.84, the person with the wall behind 0.84.
  std::vector<float> logits(3 * kPlane);
  rect(logits, 0, 0, 0, 256, 160);     // the wall and the person (top, left and right edges)
  rect(logits, 1, 100, 60, 150, 240);  // the person
  rect(logits, 2, 110, 100, 140, 140); // the shirt
  const std::vector<float> iou{0.84f, 0.843f, 0.974f};
  const std::vector<sam::Point> click{{500, 480, 1}};
  se::Intent lone;
  lone.loneClick = true;
  CHECK(se::choose_candidate(iou, logits, click, 1.0, lone, 1024, 1024) == 1);
}

TEST_CASE("an object in a corner of the frame is still an object", "[jobs][subject]") {
  // A bench the frame cuts at its bottom and right: one plank, the bench, the bench + floor.
  std::vector<float> logits(3 * kPlane);
  rect(logits, 0, 200, 200, 220, 256);  // a plank
  rect(logits, 1, 160, 180, 256, 256);  // the bench: bottom and right edges
  rect(logits, 2, 0, 150, 256, 256);    // the floor too: bottom, left, right
  const std::vector<float> iou{0.95f, 0.85f, 0.88f};
  const std::vector<sam::Point> click{{840, 900, 1}};
  se::Intent lone;
  lone.loneClick = true;
  CHECK(se::choose_candidate(iou, logits, click, 1.0, lone, 1024, 1024) == 1);
}

TEST_CASE("a click never picks the wall behind the person", "[jobs][subject]") {
  // The person, and the person + the wall behind them: the wall runs along three edges of the frame.
  std::vector<float> logits(3 * kPlane);
  rect(logits, 0, 100, 100, 140, 140);  // shirt
  rect(logits, 1, 0, 0, 256, 200);      // the wall with the person in it (top, left, right edges)
  rect(logits, 2, 90, 40, 160, 250);    // the person
  const std::vector<float> iou{0.80f, 0.92f, 0.88f};
  const std::vector<sam::Point> click{{480, 480, 1}};
  se::Intent lone;
  lone.loneClick = true;
  CHECK(se::choose_candidate(iou, logits, click, 1.0, lone, 1024, 1024) == 2);
  CHECK(se::choose_candidate(iou, logits, click, 1.0, se::Intent{}, 1024, 1024) == 2);
}

TEST_CASE("only the regions the prompts touch are kept", "[jobs][subject]") {
  constexpr int W = 60;
  constexpr int H = 30;
  std::vector<float> a(W * H, 0.0f);
  for (int y = 5; y < 25; ++y)
    for (int x = 0; x < W; ++x)
      if ((x >= 5 && x < 20) || (x >= 40 && x < 55)) a[static_cast<std::size_t>(y * W + x)] = 1.0f;
  se::keep_touching(a, W, H, std::vector<se::Pt>{{10, 15}}, std::nullopt);
  CHECK(a[15 * W + 10] == 1.0f);
  CHECK(a[15 * W + 45] == 0.0f);  // the other island is not this subject
}

TEST_CASE("keep_touching keeps the soft fringe of a kept region, never a neighbour's solid pixels", "[jobs][subject]") {
  constexpr int W = 40;
  constexpr int H = 10;
  std::vector<float> a(W * H, 0.0f);
  for (int y = 0; y < H; ++y) {
    for (int x = 2; x < 18; ++x) a[static_cast<std::size_t>(y * W + x)] = 1.0f;  // the subject
    a[static_cast<std::size_t>(y * W + 18)] = 0.3f;                                // its soft edge
    for (int x = 20; x < 36; ++x) a[static_cast<std::size_t>(y * W + x)] = 1.0f;  // a region 2 px away, not touched
  }
  se::keep_touching(a, W, H, std::vector<se::Pt>{{8, 5}}, std::nullopt);
  CHECK(a[5 * W + 10] == 1.0f);
  CHECK(a[5 * W + 18] == 0.3f);  // the fringe survives
  CHECK(a[5 * W + 20] == 0.0f);  // the neighbour's own solid pixel within 3 px does not
  CHECK(a[5 * W + 21] == 0.0f);
}

TEST_CASE("solidify_interior makes the inside solid and leaves the edge band soft", "[jobs][subject]") {
  constexpr int W = 40;
  constexpr int H = 5;
  std::vector<float> a(W * H, 0.0f);
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) {
      // A ramp from 0 at x = 10 to 0.9 at x = 19, then 0.9 inside (a dark shirt's logistic).
      const double t = std::clamp((x - 10) / 9.0, 0.0, 1.0);
      a[static_cast<std::size_t>(y * W + x)] = x < 10 ? 0.0f : static_cast<float>(0.9 * t);
    }
  std::vector<float> interior = a;
  se::solidify_interior(interior, W, H, 4);
  CHECK(interior[2 * W + 30] == 1.0f);          // far inside: solid (0.9 → 1)
  CHECK(interior[2 * W + 15] == a[2 * W + 15]);  // within 4 px of the 0.5 crossing (x ≈ 15): untouched
  CHECK(interior[2 * W + 17] == a[2 * W + 17]);
  CHECK(interior[2 * W + 5] == 0.0f);
  // Band 0 is plain solidify.
  std::vector<float> all = a;
  se::solidify_interior(all, W, H, 0);
  std::vector<float> plain = a;
  se::solidify(plain);
  CHECK(all == plain);
}

TEST_CASE("solidify_interior: a doubtful inside is solid, a patch-sized dip is filled, a real hole stays", "[jobs][subject]") {
  // A 60×60 subject the model is only 60 % sure of (a giraffe's head), with a 4×4 dip to 0.3 (a
  // dark patch line) and a 30×30 true hole (the gap between two legs), band 3.
  constexpr int W = 100;
  constexpr int H = 100;
  std::vector<float> a(W * H, 0.0f);
  for (int y = 10; y < 90; ++y)
    for (int x = 10; x < 90; ++x) a[static_cast<std::size_t>(y * W + x)] = 0.6f;
  for (int y = 20; y < 24; ++y)
    for (int x = 20; x < 24; ++x) a[static_cast<std::size_t>(y * W + x)] = 0.3f;
  for (int y = 50; y < 80; ++y)
    for (int x = 50; x < 80; ++x) a[static_cast<std::size_t>(y * W + x)] = 0.0f;
  se::solidify_interior(a, W, H, 3);
  CHECK(a[static_cast<std::size_t>(35 * W + 35)] == 1.0f);  // the doubtful inside: solid
  CHECK(a[static_cast<std::size_t>(21 * W + 21)] == 1.0f);  // the dip: filled
  CHECK(a[static_cast<std::size_t>(22 * W + 26)] == 1.0f);  // and no band opened around it
  CHECK(a[static_cast<std::size_t>(65 * W + 65)] == 0.0f);  // the real hole: kept
  CHECK(a[static_cast<std::size_t>(5 * W + 5)] == 0.0f);
}

TEST_CASE("matte_iou_logits agrees with the full-resolution IoU on the model's grid", "[jobs][subject]") {
  // Frame 1024² (scale 1, a cell = 4 px): a candidate's rectangle vs a matte covering half of it.
  std::vector<float> logits(kPlane);
  rect(logits, 0, 100, 100, 160, 160);  // cells → frame px 400..640
  std::vector<float> alpha(1024 * 1024, 0.0f);
  for (int y = 400; y < 640; ++y)
    for (int x = 400; x < 520; ++x) alpha[static_cast<std::size_t>(y) * 1024 + static_cast<std::size_t>(x)] = 1.0f;  // the left half
  CHECK(std::abs(se::matte_iou_logits(alpha, 1024, 1024, logits, 0, 1.0) - 0.5) < 0.02);
  // The same plane against itself: 1; an empty matte against it: 0.
  const std::vector<std::uint8_t> up = sam::upsample_mask(logits, 0, 1024, 1024, 1.0);
  std::vector<float> same(up.size());
  for (std::size_t i = 0; i < up.size(); ++i) same[i] = up[i] != 0 ? 1.0f : 0.0f;
  CHECK(se::matte_iou_logits(same, 1024, 1024, logits, 0, 1.0) > 0.98);
  CHECK(se::matte_iou_logits(std::vector<float>(1024 * 1024, 0.0f), 1024, 1024, logits, 0, 1.0) == 0.0);
}

TEST_CASE("the subject region fills specks, keeps a large hole open", "[jobs][sam]") {
  constexpr std::uint32_t W = 60;
  constexpr std::uint32_t H = 60;
  std::vector<std::uint8_t> m(W * H, 0);
  for (std::uint32_t y = 5; y < 55; ++y)
    for (std::uint32_t x = 5; x < 55; ++x) m[y * W + x] = 255;  // 2500 px square
  m[20 * W + 20] = 0;                                          // a speck (1 px, 0.04 %)
  for (std::uint32_t y = 30; y < 45; ++y)
    for (std::uint32_t x = 30; x < 45; ++x) m[y * W + x] = 0;  // a 225 px hole: 9 %, part of the shape
  const std::vector<std::uint8_t> r = sam::subject_region(m, W, H);
  REQUIRE(r.size() == m.size());
  CHECK(r[20 * W + 20] == 255);  // the speck is filled
  CHECK(r[37 * W + 37] == 0);    // the hole stays
  CHECK(r[10 * W + 10] == 255);
  CHECK(r[1 * W + 1] == 0);
  // The classic behaviour on request: every hole filled.
  CHECK(sam::subject_region(m, W, H, 1.0)[37 * W + 37] == 255);
}

TEST_CASE("the encoder input area-filters a frame larger than 1024", "[jobs][sam]") {
  // 2048×1024 → 1024×512: each input pixel covers 2×2 source pixels. A checkerboard of 0 / 255 averages to 127.5.
  constexpr std::uint32_t W = 2048;
  constexpr std::uint32_t H = 1024;
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(W) * H * 4, 255);
  for (std::uint32_t y = 0; y < H; ++y)
    for (std::uint32_t x = 0; x < W; ++x) {
      const std::uint8_t v = ((x + y) & 1U) != 0 ? 255 : 0;
      const std::size_t i = (static_cast<std::size_t>(y) * W + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
    }
  const std::vector<float> t = sam::preprocess(rgba, W, H);
  const auto expect = static_cast<float>((127.5 / 255.0 - sam::kMean[0]) / sam::kStd[0]);
  CHECK(std::abs(t[0] - expect) < 1e-4f);
  CHECK(std::abs(t[300 * 1024 + 700] - expect) < 1e-4f);
  CHECK(t[512 * 1024] == 0.0f);  // padding
}

TEST_CASE("seeds march from the subject's deepest point: a C's negatives spread around it", "[jobs][matte]") {
  // A C open to the right: the box centre (60, 60) lies in the mouth, already `ring` px from the
  // subject — a march from there met "outside" at step 0 on every angle, and all four negatives
  // sat on that one point in the concavity. From the deepest point (in the spine) each angle
  // walks out through the subject to the real outside on its own side.
  constexpr int W = 120;
  constexpr int H = 120;
  std::vector<float> a(W * H, 0.0f);
  const auto on = [&](int x, int y) { a[static_cast<std::size_t>(y * W + x)] = 1.0f; };
  for (int y = 10; y < 110; ++y)
    for (int x = 10; x < 110; ++x) {
      const bool spine = x < 40;
      const bool arm = y < 30 || y >= 90;
      if (spine || arm) on(x, y);
    }
  const mt::Seeds s = mt::seeds_from_matte(a, W, H);
  REQUIRE_FALSE(s.empty);
  std::vector<std::pair<int, int>> negatives;
  for (const auto& p : s.points) {
    if (p.label != 0) continue;
    CHECK(a[static_cast<std::size_t>(static_cast<int>(p.y) * W + static_cast<int>(p.x))] == 0.0f);
    negatives.emplace_back(static_cast<int>(p.x), static_cast<int>(p.y));
  }
  REQUIRE(negatives.size() >= 3);
  std::ranges::sort(negatives);
  negatives.erase(std::unique(negatives.begin(), negatives.end()), negatives.end());
  CHECK(negatives.size() >= 3);  // distinct points, not one spot
  // Not every negative in the mouth: at least one lies left of or above / below the C.
  CHECK(std::ranges::any_of(negatives, [](const auto& q) { return q.first < 10 || q.second < 10 || q.second >= 110; }));
}

TEST_CASE("seeds_from_matte_fast seeds the downsampled matte and scales back", "[jobs][matte]") {
  constexpr int W = 1600;
  constexpr int H = 900;
  std::vector<float> a(static_cast<std::size_t>(W) * H, 0.0f);
  for (int y = 300; y < 600; ++y)
    for (int x = 500; x < 900; ++x) a[static_cast<std::size_t>(y) * W + static_cast<std::size_t>(x)] = 1.0f;
  const mt::Seeds s = mt::seeds_from_matte_fast(a, W, H, 512);
  REQUIRE_FALSE(s.empty);
  CHECK(std::abs(s.box.x0 - 500) <= 4);
  CHECK(std::abs(s.box.x1 - 900) <= 4);
  CHECK(std::abs(s.box.y0 - 300) <= 4);
  CHECK(std::abs(s.box.y1 - 600) <= 4);
  for (const auto& p : s.points) {
    const float v = a[static_cast<std::size_t>(static_cast<int>(p.y)) * W + static_cast<std::size_t>(static_cast<int>(p.x))];
    if (p.label == 1) CHECK(v == 1.0f);
    else CHECK(v == 0.0f);
  }
  // A small matte goes through seeds_from_matte unchanged.
  std::vector<float> b(100 * 100, 0.0f);
  for (int y = 20; y < 60; ++y)
    for (int x = 30; x < 70; ++x) b[static_cast<std::size_t>(y * 100 + x)] = 1.0f;
  CHECK(mt::seeds_from_matte_fast(b, 100, 100).box.x0 == mt::seeds_from_matte(b, 100, 100).box.x0);
}

TEST_CASE("the brush footprint is the stroke at its radius, anti-aliased", "[jobs][subject]") {
  const std::vector<std::vector<se::Pt>> strokes{{{10, 20}, {50, 20}}};
  const std::vector<float> m = se::paint(64, 40, strokes, 5);
  CHECK(m[20 * 64 + 30] == 1.0f);
  CHECK(m[20 * 64 + 8] == 1.0f);   // inside the round cap
  CHECK(m[32 * 64 + 30] == 0.0f);  // 12 px off the stroke
  bool soft = false;
  for (const float v : m) soft = soft || (v > 0.0f && v < 1.0f);
  CHECK(soft);
}

TEST_CASE("the brush's hardness softens its edge over the outer part of the radius", "[jobs][subject]") {
  const std::vector<std::vector<se::Pt>> strokes{{{32, 20}}};  // a dab, radius 10
  const std::vector<float> hard = se::paint(64, 40, strokes, 10, 100);
  const std::vector<float> half = se::paint(64, 40, strokes, 10, 50);
  const std::vector<float> zero = se::paint(64, 40, strokes, 10, 0);
  const auto at = [](const std::vector<float>& m, int x) { return m[static_cast<std::size_t>(20 * 64 + x)]; };
  CHECK(at(hard, 39) == 1.0f);  // 7.5 px out: solid on a hard brush
  CHECK(at(half, 34) == 1.0f);  // 2.5 px out: inside the 50 % solid core
  CHECK(at(half, 39) > 0.0f);
  CHECK(at(half, 39) < 1.0f);   // 7.5 px out: in the falloff
  CHECK(at(half, 39) < at(half, 36));
  CHECK(at(zero, 33) < 1.0f);   // soft from the centre
  CHECK(at(zero, 32) == 1.0f);
  CHECK(at(half, 44) == 0.0f);  // beyond the radius on every brush
  CHECK(hard == se::paint(64, 40, strokes, 10));  // the default is hard
}

TEST_CASE("a subtract takes the soft fringe too, so no outline is left behind", "[jobs][subject]") {
  constexpr int W = 30;
  std::vector<float> base(W, 1.0f);
  std::vector<float> delta(W, 0.0f);
  for (int x = 10; x < 20; ++x) delta[static_cast<std::size_t>(x)] = 1.0f;
  delta[9] = 0.3f;  // the segmentation's soft edge
  delta[20] = 0.3f;
  se::harden_for_subtract(delta, W, 1, 1);
  const std::vector<float> out = se::combine(base, delta, se::Op::subtract);
  for (int x = 8; x <= 21; ++x) CHECK(out[static_cast<std::size_t>(x)] == 0.0f);
  CHECK(out[2] == 1.0f);
  CHECK(out[27] == 1.0f);
}

TEST_CASE("a model matte is made solid inside, its edge ramp kept", "[jobs][subject]") {
  std::vector<float> a{0.02f, 0.08f, 0.5f, 0.88f, 0.93f};
  se::solidify(a);
  CHECK(a[0] == 0.0f);
  CHECK(a[1] == 0.0f);
  CHECK(std::abs(a[2] - 0.5f) < 1e-6f);
  CHECK(a[3] > 0.99f);  // a dark shirt's 0.88 is the subject, not 12 % see-through
  CHECK(a[4] == 1.0f);
}

TEST_CASE("add, subtract and replace edit the frame's matte", "[jobs][subject]") {
  const std::vector<float> base{1, 1, 0, 0};
  const std::vector<float> delta{0, 1, 1, 0};
  CHECK(se::combine(base, delta, se::Op::add) == std::vector<float>{1, 1, 1, 0});
  CHECK(se::combine(base, delta, se::Op::subtract) == std::vector<float>{1, 0, 0, 0});
  CHECK(se::combine(base, delta, se::Op::replace) == delta);
}

TEST_CASE("Refine Edge finds fractional alpha in the band from the colours either side", "[jobs][subject]") {
  // Dark subject on the left, bright background on the right, a 10 px blend between them (hair).
  constexpr int W = 80;
  constexpr int H = 20;
  std::vector<std::uint8_t> rgba(W * H * 4, 255);
  std::vector<float> base(W * H);
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) {
      const double t = std::clamp((x - 35) / 10.0, 0.0, 1.0);  // 0 subject … 1 background
      const auto v = static_cast<std::uint8_t>(std::lround(20 + t * 215));
      const std::size_t i = static_cast<std::size_t>(y * W + x);
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      base[i] = x < 40 ? 1.0f : 0.0f;  // the hard segmentation
    }
  std::vector<std::vector<se::Pt>> stroke{{{40, 0}, {40, 19}}};
  const std::vector<float> band = se::paint(W, H, stroke, 8);
  const std::vector<float> a = se::refine_band(rgba, W, H, base, band, 8);
  const float mid = a[10 * W + 40];
  CHECK(mid > 0.3f);
  CHECK(mid < 0.7f);
  CHECK(a[10 * W + 37] > a[10 * W + 43]);
  CHECK(a[10 * W + 5] == 1.0f);   // outside the band: untouched
  CHECK(a[10 * W + 75] == 0.0f);
}

TEST_CASE("Refine Edge judges an edge by the colours next to it, not the subject's average", "[jobs][subject]") {
  // A blond head (bright) above a dark shirt, against a mid-grey wall: the band runs down the head's edge.
  constexpr int W = 80;
  constexpr int H = 40;
  std::vector<std::uint8_t> rgba(W * H * 4, 255);
  std::vector<float> base(W * H);
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) {
      const std::size_t i = static_cast<std::size_t>(y * W + x);
      std::uint8_t v = 90;                       // the wall
      if (x < 40) v = y < 20 ? 230 : 25;         // head above, shirt below
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      base[i] = x < 40 ? 1.0f : 0.0f;
    }
  std::vector<std::vector<se::Pt>> stroke{{{40, 0}, {40, 18}}};
  const std::vector<float> band = se::paint(W, H, stroke, 6);
  const std::vector<float> a = se::refine_band(rgba, W, H, base, band, 6);
  CHECK(a[10 * W + 36] > 0.9f);  // the head stays
  CHECK(a[10 * W + 44] < 0.1f);  // the wall stays out
}

TEST_CASE("Find Objects keeps each whole object once and never the background", "[jobs][subject]") {
  // A 1024² frame (scale 1, a logit cell = 4 px): a person, a ball, and a wall around them.
  const std::vector<se::Pt> grid = se::proposal_grid(1024, 1024, 8);
  REQUIRE(grid.size() == 64);
  const auto inRect = [](const se::Pt& p, int x0, int y0, int x1, int y1) { return p.x / 4 >= x0 && p.x / 4 < x1 && p.y / 4 >= y0 && p.y / 4 < y1; };
  std::vector<float> iou(grid.size() * 3);
  std::vector<float> logits(grid.size() * 3 * kPlane);
  for (std::size_t b = 0; b < grid.size(); ++b) {
    std::vector<float> one(3 * kPlane);
    if (inRect(grid[b], 40, 40, 120, 240)) {          // the person: shirt, person, person + wall
      rect(one, 0, 60, 60, 100, 120);
      rect(one, 1, 40, 40, 120, 240);
      rect(one, 2, 0, 0, 256, 240);
      iou[b * 3] = 0.95f; iou[b * 3 + 1] = 0.86f; iou[b * 3 + 2] = 0.84f;
    } else if (inRect(grid[b], 160, 160, 220, 220)) {  // the ball
      rect(one, 0, 160, 160, 220, 220);
      rect(one, 1, 160, 160, 220, 220);
      rect(one, 2, 0, 140, 256, 256);
      iou[b * 3] = 0.97f; iou[b * 3 + 1] = 0.96f; iou[b * 3 + 2] = 0.8f;
    } else {                                           // the wall / floor: along the frame's edges
      rect(one, 0, 0, 0, 256, 140);
      rect(one, 1, 0, 140, 256, 256);
      rect(one, 2, 0, 0, 256, 256);
      iou[b * 3] = 0.9f; iou[b * 3 + 1] = 0.9f; iou[b * 3 + 2] = 0.9f;
    }
    std::copy(one.begin(), one.end(), logits.begin() + static_cast<std::ptrdiff_t>(b * 3 * kPlane));
  }
  const std::vector<se::Proposal> found = se::select_proposals(iou, logits, grid, 1.0, 1024, 1024, 24);
  REQUIRE(found.size() == 2);
  std::vector<double> areas{found[0].area, found[1].area};
  std::ranges::sort(areas);
  CHECK(std::abs(areas[0] - 60.0 * 60.0 / 65536.0) < 1e-6);   // the ball
  CHECK(std::abs(areas[1] - 80.0 * 200.0 / 65536.0) < 1e-6);  // the whole person, not the shirt
}

TEST_CASE("matte_iou reads both mattes at one half", "[subject][track]") {
  std::vector<float> a(100, 0.0f);
  std::vector<float> b(100, 0.0f);
  CHECK(se::matte_iou(a, b) == 1.0);  // both empty: they agree
  for (std::size_t i = 0; i < 40; ++i) a[i] = 0.9f;
  for (std::size_t i = 20; i < 60; ++i) b[i] = 0.7f;
  CHECK(std::abs(se::matte_iou(a, b) - 20.0 / 60.0) < 1e-9);
  b.assign(100, 0.4f);  // under one half: nothing
  CHECK(se::matte_iou(a, b) == 0.0);
}

TEST_CASE("track_confidence is the weakest of the model, presence and agreement", "[subject][track]") {
  CHECK(se::track_confidence(0.95, 1.0, 0.9) == 1.0);           // a held subject
  CHECK(se::track_confidence(0.95, 1.0, std::nullopt) == 1.0);  // a walk's first frame
  CHECK(se::track_confidence(0.95, 0.05, 0.9) == 0.0);          // the model says it is gone
  CHECK(se::track_confidence(0.95, 1.0, 0.3) == 0.0);           // jumped onto something else
  const double shaky = se::track_confidence(0.6, 1.0, 0.9);
  CHECK(shaky > 0.0);
  CHECK(shaky < 0.5);  // flagged for review
  CHECK(se::track_confidence(0.9, 1.0, 0.6) < se::track_confidence(0.9, 1.0, 0.7));
}
TEST_CASE("a walk keeps the whole subject, not the part the decoder rates highest", "[subject][track]") {
  // The decoder rates the torso 0.97 and the whole person 0.88; last frame was the whole person.
  const std::vector<float> scores{0.97f, 0.88f, 0.80f};
  const std::vector<double> overlap{0.45, 0.91, 0.60};
  CHECK(se::choose_continuous(scores, overlap) == 1);
  // Two candidates that match the last frame alike: the decoder's score decides.
  CHECK(se::choose_continuous(std::vector<float>{0.7f, 0.95f}, std::vector<double>{0.9, 0.9}) == 1);
  CHECK(se::choose_continuous(std::vector<float>{}, std::vector<double>{}) == 0);
}

TEST_CASE("a stored matte is written as an 8-bit greyscale PNG, a quarter of the cut-out", "[subject][b1]") {
  // Stream B1 (kind_object_matte.cpp store_matte_frame / subject_edit_finish): the alpha plane
  // alone goes to disk — colour type 0, bit depth 8 — and the renderer reads a grey file's value
  // as the matte (a legacy colour PNG's alpha otherwise).
  constexpr std::uint32_t w = 64;
  constexpr std::uint32_t h = 32;
  std::vector<std::uint8_t> plane(static_cast<std::size_t>(w) * h, 0);
  for (std::uint32_t y = 8; y < 24; ++y)
    for (std::uint32_t x = 16; x < 48; ++x) plane[static_cast<std::size_t>(y) * w + x] = 255;
  std::vector<std::uint8_t> grey;
  REQUIRE(premation::exporter::encode_png_gray8(plane, w, h, grey, 1));
  REQUIRE(grey.size() > 33);
  CHECK(grey[12] == 'I');
  CHECK(grey[13] == 'H');
  CHECK(grey[24] == 8);  // bit depth
  CHECK(grey[25] == 0);  // colour type: greyscale
  std::vector<std::uint8_t> rgba(plane.size() * 4, 0);
  for (std::size_t i = 0; i < plane.size(); ++i)
    for (std::size_t c = 0; c < 4; ++c) rgba[i * 4 + c] = plane[i];
  std::vector<std::uint8_t> cut;
  REQUIRE(premation::exporter::encode_png_rgba8(rgba, w, h, cut, 1));
  CHECK(cut[25] == 6);  // the legacy cut-out's colour type
  CHECK(grey.size() < cut.size());
  // A plane too short for its size is refused, never written half.
  std::vector<std::uint8_t> out;
  CHECK_FALSE(premation::exporter::encode_png_gray8(std::vector<std::uint8_t>(10, 0), w, h, out, 1));
}
