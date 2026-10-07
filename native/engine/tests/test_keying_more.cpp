// AE parity 5.2: Keylight 1.2's view modes, screen pre-blur, clip rollback and
// inside / outside masks; Advanced Spill Suppressor; Key Cleaner; Remove Grain.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "effects/kernels.hpp"

using namespace premation::effects;

namespace {

struct Img {
  int w, h;
  std::vector<std::uint8_t> px;
  Img(int w_, int h_) : w(w_), h(h_), px(static_cast<std::size_t>(w_ * h_ * 4), 255) {}
  void set(int x, int y, std::array<std::uint8_t, 4> c) {
    for (std::size_t k = 0; k < 4; ++k) px[(static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)) * 4 + k] = c[k];
  }
  [[nodiscard]] std::array<int, 4> at(int x, int y) const {
    const std::size_t i = (static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)) * 4;
    return {px[i], px[i + 1], px[i + 2], px[i + 3]};
  }
  RgbaView view() { return {std::span<std::uint8_t>(px), w, h}; }
};

/// Green screen on the left half, a red subject on the right half.
Img green_and_red(int w = 16, int h = 8) {
  Img img(w, h);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) img.set(x, y, x < w / 2 ? std::array<std::uint8_t, 4>{5, 250, 5, 255} : std::array<std::uint8_t, 4>{200, 40, 40, 255});
  }
  return img;
}

const KeylightParams kKey{{0, 255, 0}, 0.5, 1, 0.08, 0.65, 1, 0, 0};

}  // namespace

TEST_CASE("Keylight 1.2: neutral extras are the core key, byte for byte", "[effects][keying]") {
  Img a = green_and_red();
  Img b = green_and_red();
  keylight(a.view(), kKey, nullptr);
  keylight_full(b.view(), kKey, KeylightExtras{}, nullptr);
  CHECK(a.px == b.px);
  CHECK(a.at(1, 1)[3] == 0);
  CHECK(a.at(12, 1)[3] == 255);
}

TEST_CASE("Keylight 1.2: view modes", "[effects][keying]") {
  {
    Img img = green_and_red();
    const std::vector<std::uint8_t> before = img.px;
    KeylightExtras x;
    x.view = 1;  // Source
    keylight_full(img.view(), kKey, x, nullptr);
    CHECK(img.px == before);
  }
  {
    Img img = green_and_red();
    KeylightExtras x;
    x.view = 2;  // Screen Matte
    keylight_full(img.view(), kKey, x, nullptr);
    CHECK(img.at(1, 1) == std::array<int, 4>{0, 0, 0, 255});
    CHECK(img.at(12, 1) == std::array<int, 4>{255, 255, 255, 255});
  }
  {
    Img img(4, 1);
    img.set(0, 0, {5, 250, 5, 255});
    img.set(1, 0, {200, 40, 40, 255});
    img.set(2, 0, {60, 225, 60, 255});  // a part-screen pixel: partial matte
    img.set(3, 0, {0, 0, 0, 0});
    KeylightExtras x;
    x.view = 3;  // Status: black / white / grey
    keylight_full(img.view(), kKey, x, nullptr);
    CHECK(img.at(0, 0)[0] == 0);
    CHECK(img.at(1, 0)[0] == 255);
    CHECK(img.at(2, 0)[0] == 128);
  }
}

TEST_CASE("Keylight 1.2: inside / outside masks and screen pre-blur", "[effects][keying]") {
  // Inside Mask over the left half's centre holds the green there.
  {
    Img img = green_and_red();
    KeylightExtras x;
    const std::vector<double> square{2, 2, 6, 2, 6, 6, 2, 6};
    x.inside = polygon_coverage(square, 0, 4, img.w, img.h);
    keylight_full(img.view(), kKey, x, nullptr);
    CHECK(img.at(4, 4)[3] == 255);
    CHECK(img.at(0, 0)[3] == 0);
  }
  // Outside (coverage 1 outside the keep area): the red subject's far edge goes.
  {
    Img img = green_and_red();
    KeylightExtras x;
    x.outside.assign(static_cast<std::size_t>(img.w * img.h), 0.0F);
    for (int y = 0; y < img.h; ++y) x.outside[static_cast<std::size_t>(y * img.w + img.w - 1)] = 1;
    keylight_full(img.view(), kKey, x, nullptr);
    CHECK(img.at(img.w - 1, 3)[3] == 0);
    CHECK(img.at(img.w - 3, 3)[3] == 255);
  }
  // Pre-blur softens the matte only at the screen / subject boundary.
  {
    Img img = green_and_red();
    KeylightExtras x;
    x.preBlur = 2;
    keylight_full(img.view(), kKey, x, nullptr);
    CHECK(img.at(0, 3)[3] == 0);
    CHECK(img.at(15, 3)[3] == 255);
    const int edge = img.at(8, 3)[3];
    CHECK(edge > 0);
    CHECK(edge <= 255);
  }
}

TEST_CASE("polygon coverage is exact on whole pixels and partial on edges", "[effects][keying]") {
  const std::vector<double> sq{1, 1, 3, 1, 3, 3, 1, 3};
  const auto cov = polygon_coverage(sq, 0, 4, 4, 4);
  CHECK(cov[5] == 1.0F);
  CHECK(cov[0] == 0.0F);
  const std::vector<double> half{0.5, 0, 4, 0, 4, 4, 0.5, 4};
  const auto c2 = polygon_coverage(half, 0, 4, 4, 4);
  CHECK(std::abs(c2[0] - 0.5F) < 1e-6F);
}

TEST_CASE("Advanced Spill Suppressor: Standard finds the screen, Ultra uses the key", "[effects][keying]") {
  Img img(4, 4);
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) img.set(x, y, {120, 170, 120, 255});  // grey with green spill
  }
  SpillParams sp;
  advanced_spill_suppressor(img.view(), sp, nullptr);
  const auto c = img.at(0, 0);
  CHECK(c[1] <= 125);
  CHECK(c[0] == 120);
  // Ultra with a blue key leaves green spill alone.
  Img img2(2, 2);
  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 2; ++x) img2.set(x, y, {120, 170, 120, 255});
  }
  SpillParams blue;
  blue.method = 1;
  blue.key = {0, 0, 255};
  advanced_spill_suppressor(img2.view(), blue, nullptr);
  CHECK(img2.at(0, 0)[1] == 170);
  // Luma correction gives back the brightness the spill took.
  Img img3(2, 2);
  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 2; ++x) img3.set(x, y, {120, 170, 120, 255});
  }
  SpillParams luma;
  luma.lumaCorrection = 1;
  advanced_spill_suppressor(img3.view(), luma, nullptr);
  const auto l = img3.at(0, 0);
  CHECK(std::abs((0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]) - (0.2126 * 120 + 0.7152 * 170 + 0.0722 * 120)) < 2.5);
}

TEST_CASE("Key Cleaner softens a hard matte edge only near the edge", "[effects][keying]") {
  Img img(20, 4);
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 20; ++x) img.set(x, y, {200, 200, 200, static_cast<std::uint8_t>(x < 10 ? 0 : 255)});
  }
  key_cleaner(img.view(), 3, false, 1, 1, nullptr);
  CHECK(img.at(0, 1)[3] == 0);
  CHECK(img.at(19, 1)[3] == 255);
  const int a9 = img.at(9, 1)[3];
  const int a10 = img.at(10, 1)[3];
  CHECK(a9 > 0);
  CHECK(a10 < 255);
}

TEST_CASE("Remove Grain flattens grain and keeps an edge", "[effects][keying]") {
  Img img(24, 8);
  for (int y = 0; y < 8; ++y) {
    for (int x = 0; x < 24; ++x) {
      const int grain = ((x * 37 + y * 91) % 17) - 8;  // deterministic ±8 grain
      const int base = x < 12 ? 60 : 200;
      const auto v = static_cast<std::uint8_t>(base + grain);
      img.set(x, y, {v, v, v, 255});
    }
  }
  remove_grain(img.view(), 0.8, 3, 2, 0.2, 0.6, false, nullptr);
  double var = 0;
  for (int x = 2; x < 9; ++x) var += std::abs(img.at(x, 4)[0] - 60);
  CHECK(var / 7 < 3.5);
  CHECK(img.at(4, 4)[0] < 80);
  CHECK(img.at(20, 4)[0] > 180);
  // Noise Samples: a flat field has no grain to show.
  Img flat(6, 6);
  for (int y = 0; y < 6; ++y) {
    for (int x = 0; x < 6; ++x) flat.set(x, y, {90, 90, 90, 255});
  }
  remove_grain(flat.view(), 0.8, 2, 1, 0.5, 0.5, true, nullptr);
  CHECK(std::abs(flat.at(3, 3)[0] - 128) <= 1);
}
