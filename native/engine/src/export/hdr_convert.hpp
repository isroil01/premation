// HDR10 / HLG delivery: a read-back half-float surface → the rgba64le frames
// an HDR encode takes (PQ or HLG signal, BT.2020 primaries), and the light
// levels the HDR10 metadata reports.
//
// What the surface holds: the export draws the frame with the sRGB display
// transform (an HDR job overrides the project's viewer transform — a PQ / HLG
// PREVIEW on an SDR canvas, or the ACES SDR tone map, would otherwise be
// encoded twice or clipped at white), into a half-float surface. The sRGB
// encode in the shaders is unclamped, so a highlight above working-space 1.0
// arrives here as a value above 1.0 — the headroom HDR exists for.
//
// Per pixel: (premultiplied = flattened over black) → sRGB decode (extended: the curve continues above
// 1) → BT.709 to BT.2020 primaries (ITU-R BT.2087) → absolute light, with
// working-space 1.0 = reference white (`whiteNits`, 203 by ITU-R BT.2408) →
// clipped to the mastering display's peak (`peakNits`) → the transfer:
//   PQ   ST.2084 inverse EOTF of nits / 10000.
//   HLG  ARIB STD-B67 OETF of scene light scaled so reference white sits at
//        75 % signal (BT.2408), clipped at 1.
// Alpha is 1: an HDR delivery is opaque.
//
// Light levels (CTA-861.3): a pixel's level is max(R, G, B) in nits of the
// PQ signal's light; MaxCLL is the brightest pixel of the range, MaxFALL the
// brightest frame average. Measured on what is delivered (after the clip).
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <span>
#include <vector>

#include "frame_convert.hpp"

namespace premation::exporter {

enum class HdrTransfer : std::uint8_t { pq, hlg };

struct HdrEncode {
  HdrTransfer transfer = HdrTransfer::pq;
  /// Mastering display peak, nits: the light is clipped here (and it is the SEI's L max).
  double peakNits = 1000;
  /// Working-space 1.0 (SDR reference white), nits.
  double whiteNits = 203;
};

/// Running CTA-861.3 light levels over the frames converted so far.
struct HdrLightLevels {
  double maxCll = 0;
  double maxFall = 0;
  std::uint64_t frames = 0;
  void add_frame(double frameMax, double frameAverage) noexcept {
    maxCll = std::max(maxCll, frameMax);
    maxFall = std::max(maxFall, frameAverage);
    ++frames;
  }
};

/// ST.2084 inverse EOTF: absolute light (0 … 10000 nits, as a fraction of 10000) → signal 0 … 1.
[[nodiscard]] inline double pq_inverse_eotf(double y) noexcept {
  constexpr double m1 = 2610.0 / 16384.0;
  constexpr double m2 = 2523.0 / 4096.0 * 128.0;
  constexpr double c1 = 3424.0 / 4096.0;
  constexpr double c2 = 2413.0 / 4096.0 * 32.0;
  constexpr double c3 = 2392.0 / 4096.0 * 32.0;
  const double ym = std::pow(std::clamp(y, 0.0, 1.0), m1);
  return std::pow((c1 + c2 * ym) / (1.0 + c3 * ym), m2);
}

inline constexpr double kHlgA = 0.17883277;
inline constexpr double kHlgB = 0.28466892;
inline constexpr double kHlgC = 0.55991073;

/// ARIB STD-B67 OETF: scene light 0 … 1 → signal 0 … 1.
[[nodiscard]] inline double hlg_oetf(double e) noexcept {
  e = std::clamp(e, 0.0, 1.0);
  return e <= 1.0 / 12.0 ? std::sqrt(3.0 * e) : kHlgA * std::log(12.0 * e - kHlgB) + kHlgC;
}

/// The scene light whose HLG signal is 75 % (BT.2408 reference white): ≈ 0.2647.
[[nodiscard]] inline double hlg_reference_white() noexcept {
  return (std::exp((0.75 - kHlgC) / kHlgA) + kHlgB) / 12.0;
}

/// The sRGB curve, decoded, continued above 1 (and odd below 0).
[[nodiscard]] inline double srgb_decode_extended(double v) noexcept {
  const double a = std::fabs(v);
  const double l = a <= 0.04045 ? a / 12.92 : std::pow((a + 0.055) / 1.055, 2.4);
  return v < 0 ? -l : l;
}

/// BT.709 → BT.2020 primaries, linear light (ITU-R BT.2087 table 2).
inline constexpr std::array<double, 9> kRec709To2020{
    0.6274040, 0.3292820, 0.0433136,  //
    0.0690970, 0.9195400, 0.0113612,  //
    0.0163916, 0.0880132, 0.8955950,
};

/// One display-encoded (sRGB) pixel → the delivered code values 0 … 1 and its
/// light level in nits (max of R, G, B). The reference: exact curves in double
/// (the tests' model; HdrEncoder is the fast path, table-driven).
inline void hdr_encode_px(const std::array<double, 3>& srgb, const HdrEncode& e, std::array<double, 3>& code,
                          double& levelNits) noexcept {
  std::array<double, 3> lin{};
  for (std::size_t c = 0; c < 3; ++c) lin[c] = srgb_decode_extended(srgb[c]);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  const auto& m = kRec709To2020;
  const std::array<double, 3> bt2020{
      m[0] * lin[0] + m[1] * lin[1] + m[2] * lin[2],
      m[3] * lin[0] + m[4] * lin[1] + m[5] * lin[2],
      m[6] * lin[0] + m[7] * lin[1] + m[8] * lin[2],
  };
  levelNits = 0;
  const double hlgWhite = hlg_reference_white();
  for (std::size_t c = 0; c < 3; ++c) {
    const double nits = std::clamp(bt2020[c] * e.whiteNits, 0.0, e.peakNits);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    levelNits = std::max(levelNits, nits);
    code[c] = e.transfer == HdrTransfer::pq ? pq_inverse_eotf(nits / 10000.0)  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
                                            : hlg_oetf(nits / e.whiteNits * hlgWhite);
  }
}

/// The per-frame converter: `hdr_encode_px` through two tables, built once per
/// job (a pow per channel per pixel is seconds a 4K frame).
///  - decode: every binary16 bit pattern → linear light (the sRGB curve, extended).
///  - curve:  light as a fraction of the peak, 0 … 1, indexed by its float bits —
///            48 octaves below 1 × 128 steps each, linearly interpolated inside a
///            step (a 1/128 relative step: well under a 16-bit code value on
///            either curve). Both curves rise steeply from black (PQ as light^0.16,
///            HLG as its square root), so the table reaches down to 2^-48 of the
///            peak, where both are within a code value of their black.
class HdrEncoder {
 public:
  explicit HdrEncoder(const HdrEncode& e) : e_(e), decode_(65536), curve_(kOctaves * kSteps + 1) {
    for (std::size_t h = 0; h < decode_.size(); ++h) {
      const float v = half_to_float(static_cast<std::uint16_t>(h));
      decode_[h] = v != v ? 0.0F : static_cast<float>(srgb_decode_extended(v));  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    }
    const double hlgWhite = hlg_reference_white();
    for (std::size_t i = 0; i < curve_.size(); ++i) {
      const std::size_t oct = i / kSteps;
      const double y = std::ldexp(1.0 + static_cast<double>(i % kSteps) / kSteps, static_cast<int>(oct) - kOctaves);
      const double nits = std::min(1.0, y) * e_.peakNits;
      curve_[i] = static_cast<float>(e_.transfer == HdrTransfer::pq ? pq_inverse_eotf(nits / 10000.0)  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
                                                                    : hlg_oetf(nits / e_.whiteNits * hlgWhite));
    }
    zero_ = static_cast<float>(e_.transfer == HdrTransfer::pq ? pq_inverse_eotf(0) : 0.0);
  }

  /// Code value for light `y` (fraction of the peak).
  [[nodiscard]] float code(float y) const noexcept {
    if (!(y > kMin)) return zero_;
    if (y >= 1.0F) return curve_.back();
    std::uint32_t bits = 0;
    std::memcpy(&bits, &y, sizeof bits);
    const auto exp = static_cast<std::int32_t>(bits >> 23U) - (127 - kOctaves);
    const std::uint32_t mant = (bits >> (23U - kMantBits)) & (kSteps - 1U);
    const auto i = static_cast<std::size_t>(exp) * kSteps + mant;
    const float frac = static_cast<float>(bits & ((1U << (23U - kMantBits)) - 1U)) * (1.0F / static_cast<float>(1U << (23U - kMantBits)));
    return curve_[i] + (curve_[i + 1] - curve_[i]) * frac;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  }

  /// One surface → rgba64le; the frame's light levels into `levels`.
  void convert(std::span<const std::uint8_t> src, std::uint32_t width, std::uint32_t height, std::uint32_t stride,
               std::span<std::uint8_t> dst, HdrLightLevels& levels) const noexcept {
    const auto u16 = [](float v) { return static_cast<std::uint16_t>(std::clamp(v, 0.0F, 1.0F) * 65535.0F + 0.5F); };
    const auto& m = kRec709To2020;
    const auto white = static_cast<float>(e_.whiteNits / e_.peakNits);  // working 1.0 as a fraction of the peak
    const auto peak = static_cast<float>(e_.peakNits);
    double frameMax = 0;
    double frameSum = 0;
    for (std::uint32_t y = 0; y < height; ++y) {
      const std::uint8_t* s = src.data() + std::size_t{y} * stride;            // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      std::uint8_t* d = dst.data() + std::size_t{y} * std::size_t{width} * 8;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      float rowMax = 0;
      double rowSum = 0;
      for (std::uint32_t x = 0; x < width; ++x) {
        std::array<std::uint16_t, 4> h{};
        std::memcpy(h.data(), s + std::size_t{x} * 8, 8);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        // Premultiplied = flattened over black (an HDR job renders the comp opaque).
        const float r = decode_[h[0]];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
        const float g = decode_[h[1]];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
        const float b = decode_[h[2]];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
        const std::array<float, 3> light{
            std::clamp(static_cast<float>(m[0] * r + m[1] * g + m[2] * b) * white, 0.0F, 1.0F),
            std::clamp(static_cast<float>(m[3] * r + m[4] * g + m[5] * b) * white, 0.0F, 1.0F),
            std::clamp(static_cast<float>(m[6] * r + m[7] * g + m[8] * b) * white, 0.0F, 1.0F),
        };
        const float level = std::max({light[0], light[1], light[2]});
        rowMax = std::max(rowMax, level);
        rowSum += level;
        const std::array<std::uint16_t, 4> o{u16(code(light[0])), u16(code(light[1])), u16(code(light[2])), 65535};
        std::memcpy(d + std::size_t{x} * 8, o.data(), 8);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): little-endian hosts only (x86-64, arm64)
      }
      frameMax = std::max(frameMax, static_cast<double>(rowMax));
      frameSum += rowSum;
    }
    const double n = std::max(1.0, static_cast<double>(width) * static_cast<double>(height));
    levels.add_frame(frameMax * peak, frameSum / n * peak);
  }

 private:
  static constexpr int kOctaves = 48;
  static constexpr std::uint32_t kMantBits = 7;
  static constexpr std::uint32_t kSteps = 1U << kMantBits;
  static constexpr float kMin = 0x1p-48F;
  HdrEncode e_;
  std::vector<float> decode_;
  std::vector<float> curve_;
  float zero_ = 0;
};

}  // namespace premation::exporter
