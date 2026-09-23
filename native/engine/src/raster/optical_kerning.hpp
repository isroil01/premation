// Optical kerning (E3): src/core/text/opticalKerning.ts ported — pair
// adjustments from the glyphs' ink profiles, which the TS measures by drawing
// each glyph into a 512×256 canvas at 128 px and scanning its alpha. Here the
// glyphs are drawn with the C++ Canvas2D, so with the Chromium glyph profile the
// profiles (and so the pair kerns) come out as the TS's.
//
// Horizontal pairs only; the vertical (CJK column) variant is not ported yet.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "canvas.hpp"

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

  static constexpr double kRefEmPx = 128;

  struct InkProfile {
    double advance = 0;
    std::vector<double> left, right;
    double top = 0;
  };

 private:
  struct Metrics {
    double xHeight, lower, upper;
  };
  const InkProfile* profile(const std::string& css, const std::string& cluster);
  const Metrics& metrics(const std::string& css);

  std::unique_ptr<Canvas2D> canvas_;
  Source source_ = Source::raster;
  std::map<std::string, std::optional<InkProfile>> profiles_;
  std::map<std::string, double> pairs_;
  std::map<std::string, Metrics> metrics_;
};

}  // namespace premation::raster
