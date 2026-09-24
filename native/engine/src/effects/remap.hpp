// distort.ts `remap` — the bilinear inverse-map resample shared by the
// distort and stylize kernels. For each destination pixel centre, `invert`
// names the source point (or nothing: transparent); straight-alpha bilinear,
// taps outside the layer contribute nothing (their weight is lost, as in the TS).
#pragma once

#include <array>
#include <optional>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

struct RemapPt {
  double x, y;
};

template <class Invert>
void remap_rgba(RgbaView img, ThreadPool* pool, Invert&& invert) {
  const int w = img.w;
  const int h = img.h;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int dy = y0; dy < y1; ++dy) {
      for (int dx = 0; dx < w; ++dx) {
        std::uint8_t* o = out + idx4(dx, dy, w);
        const std::optional<RemapPt> s = invert(dx + 0.5, dy + 0.5);
        if (!s) {
          o[0] = o[1] = o[2] = o[3] = 0;
          continue;
        }
        const double sx = s->x - 0.5;
        const double sy = s->y - 0.5;
        const double x0 = floor_fast(sx);
        const double yy0 = floor_fast(sy);
        const double fx = sx - x0;
        const double fy = sy - yy0;
        std::array<const std::uint8_t*, 4> tap{};
        std::array<double, 4> wt{};
        for (int j = 0; j <= 1; ++j) {
          for (int i = 0; i <= 1; ++i) {
            const double px = x0 + i;
            const double py = yy0 + j;
            const auto k = static_cast<std::size_t>(j * 2 + i);
            if (px < 0 || px >= w || py < 0 || py >= h) {
              tap[k] = nullptr;
              continue;
            }
            tap[k] = src.data() + idx4(static_cast<int>(px), static_cast<int>(py), w);
            wt[k] = (i != 0 ? fx : 1 - fx) * (j != 0 ? fy : 1 - fy);
          }
        }
        for (std::size_t c = 0; c < 4; ++c) {
          double acc = 0;
          for (std::size_t k = 0; k < 4; ++k) {
            if (tap[k] != nullptr) acc += tap[k][c] * wt[k];
          }
          o[c] = u8c(acc);
        }
      }
    }
  });
}

}  // namespace premation::effects
