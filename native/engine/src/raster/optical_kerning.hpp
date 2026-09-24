// Optical kerning (E3): src/core/text/opticalKerning.ts ported — pair
// adjustments from the glyphs' ink profiles, which the TS measures by drawing
// each glyph into a 512×256 canvas at 128 px and scanning its alpha. Here the
// glyphs are drawn with the C++ Canvas2D, so with the Chromium glyph profile the
// profiles (and so the pair kerns) come out as the TS's. The pure math (and
// the vertical pair cache) is optical_math.cpp.
//
// Horizontal pairs, and the vertical variant for upright CJK pairs in a column
// (opticalKernVerticalPx: a 256×256 canvas, the glyph centred on a 'middle'
// baseline, profiled top to bottom).
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "canvas.hpp"
#include "optical_math.hpp"

namespace premation::raster {

class OpticalKerner {
 public:
  /// Where glyph ink profiles come from (opticalKerning.ts "Where profiles come
  /// from"): the glyph drawn at REF_EM_PX and read from alpha (raster), or the
  /// face's parsed outline (outline) — which the TS uses for a face whose bytes
  /// were parsed (registerOpticalOutlineFace), falling back to raster.
  enum class Source : std::uint8_t { raster, outline };
  explicit OpticalKerner(const CanvasOptions& opts, Source source = Source::raster);
  ~OpticalKerner();
  OpticalKerner(const OpticalKerner&) = delete;
  OpticalKerner& operator=(const OpticalKerner&) = delete;
  OpticalKerner(OpticalKerner&&) = delete;
  OpticalKerner& operator=(OpticalKerner&&) = delete;

  /// opticalKernPx: px added to the LEFT glyph's advance. `cssA` / `cssB` are the
  /// faces' font strings at the reference size (REF_EM_PX = 128).
  double kern_px(const std::string& cssA, const std::string& a, double sizeA, const std::string& cssB, const std::string& b,
                 double sizeB);
  /// opticalKernVerticalPx: px added to the UPPER upright glyph's advance (≤ 0).
  double kern_vertical_px(const std::string& cssA, const std::string& a, double sizeA, const std::string& cssB,
                          const std::string& b, double sizeB);

  static constexpr double kRefEmPx = optical::kRefEmPx;

  using InkProfile = optical::InkProfile;

 private:
  struct Metrics {
    double xHeight, lower, upper;
  };
  const InkProfile* profile(const std::string& css, const std::string& cluster);
  const Metrics& metrics(const std::string& css);
  std::optional<InkProfile> vertical_raster(const std::string& css, const std::string& cluster);

  CanvasOptions opts_;
  std::unique_ptr<Canvas2D> canvas_;
  std::unique_ptr<Canvas2D> verticalCanvas_;  // made on the first vertical pair
  Source source_ = Source::raster;
  std::map<std::string, std::optional<InkProfile>> profiles_;
  std::map<std::string, double> pairs_;
  std::map<std::string, Metrics> metrics_;
  optical::VerticalKerner vertical_;
};

}  // namespace premation::raster
