// opticalKerning.ts's pure half (E3): ink profiles from alpha rasters, the
// pair math shared by horizontal and vertical pairs, and the vertical (upright
// CJK column) kerning with its caches — fed by any glyph rasterizer. Skia-free
// (engine_raster_core); optical_kerning.cpp supplies the Canvas2D rasterizers.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace premation::raster::optical {

inline constexpr double kRefEmPx = 128;  // REF_EM_PX
inline constexpr int kBandCount = 30;
inline constexpr double kBandBottomEm = -0.25;
inline constexpr double kBandTopEm = 0.95;
inline constexpr double kVerticalBandSpanEm = kBandTopEm;  // VERTICAL_BAND_SPAN_EM
inline constexpr double kDefaultXHeightEm = 0.52;
inline constexpr double kDefaultTargetEm = 0.1;

/// InkProfile: per band, the leftmost / rightmost ink (em; NaN = empty band).
struct InkProfile {
  double advance = 0;
  std::vector<double> left, right;
  double top = 0;
};

struct PairGap {
  double area = 0, dmin = 0;
};

[[nodiscard]] InkProfile empty_profile(double advance);
void widen(InkProfile& p, int band, double x);
[[nodiscard]] int band_of(double yEm);

/// profileFromAlpha: one glyph drawn with its pen at (penX, baselineY).
[[nodiscard]] InkProfile profile_from_alpha(const std::vector<std::uint8_t>& rgba, std::uint32_t width, std::uint32_t height,
                                            double penX, double baselineY, double emPx, double advancePx);
/// verticalProfileFromAlpha: one upright glyph whose em box's top-left is (emLeft, emTop).
[[nodiscard]] InkProfile vertical_profile_from_alpha(const std::vector<std::uint8_t>& rgba, std::uint32_t width,
                                                     std::uint32_t height, double emLeft, double emTop, double emPx);
/// measurePairGap / pairAdjustment.
[[nodiscard]] std::optional<PairGap> measure_pair_gap(const InkProfile& a, double sizeA, const InkProfile& b, double sizeB,
                                                      double xHeightEm = kDefaultXHeightEm);
[[nodiscard]] double pair_adjustment(const PairGap& gap, double targetPx, double sizePx);
/// isProportionalCjk: kana, CJK / fullwidth punctuation and their vertical forms.
[[nodiscard]] bool is_proportional_cjk(const std::string& cluster);

/// opticalKernVerticalPx with its caches (profiles, pairs, per-face targets),
/// over a rasterizer that draws one upright cluster in a face (css at REF_EM_PX)
/// and returns its vertical profile, or nullopt.
class VerticalKerner {
 public:
  using Rasterizer = std::function<std::optional<InkProfile>(const std::string& css, const std::string& cluster)>;
  explicit VerticalKerner(Rasterizer raster) : raster_(std::move(raster)) {}

  /// px to add to the UPPER glyph's advance (≤ 0).
  double kern_px(const std::string& cssA, const std::string& a, double sizeA, const std::string& cssB, const std::string& b,
                 double sizeB);
  /// glyphVerticalInkProfile (cached).
  const InkProfile* profile(const std::string& css, const std::string& cluster);

 private:
  double target(const std::string& css);
  Rasterizer raster_;
  std::map<std::string, std::optional<InkProfile>> profiles_;
  std::map<std::string, double> pairs_;
  std::map<std::string, double> targets_;
};

}  // namespace premation::raster::optical
