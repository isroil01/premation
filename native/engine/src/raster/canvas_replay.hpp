// Replays a recorded Canvas2D call log (RenderRasterSource.opsJson, written by
// packages/render-tests/harness/rasterRecorder.ts) on the C++ Canvas2D — the
// half of the E3 parity harness that measures RASTERISATION alone: same calls,
// Skia here vs Chromium's Skia there.
//
// Grammar (JSON array of arrays; c = canvas id, 0 = the raster itself):
//   [c, "canvas", w, h]                         a canvas seen / resized
//   [c, "call", name, ...args]                  a method call
//   [c, "set", name, value]                     a property write
//   [c, "grad", g, "linear"|"radial"|"conic", ...args]
//   [-1, "stop", g, offset, color]
//   [c, "pattern", p, {"$c": src}, repetition]  (snapshots src at this point)
//   [-1, "patxf", p, a, b, c, d, e, f]
//   [c, "measure", text, font, letterSpacing, width, abLeft, abRight, abAscent, abDescent]
// Values: {"$g": id} gradient, {"$p": id} pattern, {"$c": id} canvas, {"$m": [a..f]} matrix.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "canvas.hpp"

namespace premation::raster {

/// One measureText the TS recorded, against what the C++ measured.
struct MeasureDiff {
  std::string text;
  std::string font;
  double tsWidth = 0.0;
  double cxxWidth = 0.0;
  /// Largest |TS − C++| over width and the four actualBoundingBox values.
  double maxDelta = 0.0;
};

struct ReplayResult {
  bool ok = false;
  std::string error;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  /// Canvas 0's premultiplied RGBA8.
  std::vector<std::uint8_t> rgba;
  /// Calls / properties the replayer does not implement (each name once).
  std::vector<std::string> unsupported;
  std::vector<MeasureDiff> measures;
  std::size_t ops = 0;
};

/// Replay `opsJson` with `opts` (fonts) and return canvas 0's pixels.
[[nodiscard]] ReplayResult replay_canvas_ops(std::string_view opsJson, const CanvasOptions& opts);

}  // namespace premation::raster
