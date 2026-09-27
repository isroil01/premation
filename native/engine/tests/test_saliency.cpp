// Auto-reframe saliency (src/core/reframe/saliency.test.ts).

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "saliency.hpp"

using Catch::Approx;
namespace sal = premation::jobs::saliency;

namespace {

constexpr std::uint32_t kW = 32;
constexpr std::uint32_t kH = 32;

struct Rect {
  int x = 0;
  int y = 0;
  int w = 0;
  int h = 0;
  std::uint8_t value = 0;
};

std::vector<std::uint8_t> frame(std::uint8_t fill, const Rect* rect = nullptr) {
  std::vector<std::uint8_t> px(static_cast<std::size_t>(kW) * kH * 4, 0);
  for (std::size_t i = 0; i < static_cast<std::size_t>(kW) * kH; ++i) {
    px[i * 4] = fill;
    px[i * 4 + 1] = fill;
    px[i * 4 + 2] = fill;
    px[i * 4 + 3] = 255;
  }
  if (rect) {
    for (int y = rect->y; y < rect->y + rect->h; ++y) {
      for (int x = rect->x; x < rect->x + rect->w; ++x) {
        const std::size_t i = (static_cast<std::size_t>(y) * kW + static_cast<std::uint32_t>(x)) * 4;
        px[i] = rect->value;
        px[i + 1] = rect->value;
        px[i + 2] = rect->value;
      }
    }
  }
  return px;
}

}  // namespace

TEST_CASE("luma is Rec.601", "[saliency]") {
  const std::uint8_t px[4] = {255, 0, 0, 255};
  const std::vector<float> y = sal::luma_from_rgba(px, 1, 1);
  CHECK(y[0] == Approx(0.299 * 255).margin(1e-4));
}

TEST_CASE("attention centre finds a blob, an empty map, and a uniform map", "[saliency]") {
  std::vector<float> map(static_cast<std::size_t>(kW) * kH, 0.f);
  for (int y = 14; y < 18; ++y)
    for (int x = 22; x < 26; ++x) map[static_cast<std::size_t>(y) * kW + static_cast<std::uint32_t>(x)] = 1.f;
  const sal::AttentionPoint blob = sal::attention_centre(map, kW, kH);
  CHECK(blob.x == Approx(23.5 / 31).margin(1e-2));
  CHECK(blob.y == Approx(15.5 / 31).margin(1e-2));

  const sal::AttentionPoint empty = sal::attention_centre(std::vector<float>(static_cast<std::size_t>(kW) * kH), kW, kH);
  CHECK(empty.x == Approx(0.5));
  CHECK(empty.y == Approx(0.5));
  CHECK(empty.confidence == 0);

  const sal::AttentionPoint flat = sal::attention_centre(std::vector<float>(static_cast<std::size_t>(kW) * kH, 1.f), kW, kH);
  CHECK(flat.confidence < 0.05);

  std::vector<float> tight(static_cast<std::size_t>(kW) * kH, 0.f);
  for (int y = 14; y < 18; ++y)
    for (int x = 14; x < 18; ++x) tight[static_cast<std::size_t>(y) * kW + static_cast<std::uint32_t>(x)] = 1.f;
  CHECK(sal::attention_centre(tight, kW, kH).confidence > 0.9);
}

TEST_CASE("saliency follows motion, detail, and the centre prior", "[saliency]") {
  const Rect moved{22, 14, 6, 6, 220};
  const std::vector<float> previous = sal::luma_from_rgba(frame(60), kW, kH);
  const std::vector<float> current = sal::luma_from_rgba(frame(60, &moved), kW, kH);
  const sal::AttentionPoint motion = sal::attention_centre(sal::saliency_map(current, &previous, kW, kH), kW, kH);
  CHECK(motion.x > 0.6);

  const Rect stillRect{4, 14, 6, 6, 220};
  const std::vector<float> still = sal::luma_from_rgba(frame(60, &stillRect), kW, kH);
  const sal::AttentionPoint detail = sal::attention_centre(sal::saliency_map(still, &still, kW, kH), kW, kH);
  CHECK(detail.x < 0.45);

  const Rect corner{0, 0, 3, 3, 255};
  const std::vector<float> cornerLuma = sal::luma_from_rgba(frame(60, &corner), kW, kH);
  const sal::AttentionPoint held = sal::attention_centre(sal::saliency_map(cornerLuma, &previous, kW, kH), kW, kH);
  CHECK(held.x > 0.15);
  CHECK(held.y > 0.15);

  const std::vector<float> grey = sal::luma_from_rgba(frame(128), kW, kH);
  CHECK(sal::attention_centre(sal::saliency_map(grey, &grey, kW, kH), kW, kH).confidence < 0.2);

  const sal::AttentionPoint first = sal::attention_centre(sal::saliency_map(current, nullptr, kW, kH), kW, kH);
  CHECK(first.x > 0.55);
}

TEST_CASE("analyse_frame returns the point and the luma plane", "[saliency]") {
  const Rect subject{22, 14, 6, 6, 220};
  const sal::FrameAnalysis result = sal::analyse_frame(frame(60, &subject), nullptr, kW, kH);
  CHECK(result.luma.size() == static_cast<std::size_t>(kW) * kH);
  CHECK(result.point.x > 0.5);
}
