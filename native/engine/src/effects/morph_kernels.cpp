// Ports of src/core/effects/keyingEffects.ts `minimaxData` and
// `simpleChokerData`.
//
// Both are separable min / max filters over a square window. The TS scans the
// whole window per pixel (O(r)); a min or max is exact whatever the order, so
// the van Herk / Gil-Werman scheme (block prefix + suffix extrema, O(1) per
// pixel) gives the same bytes. The one thing that must match is what lies
// beyond the edge: Minimax clamps to the edge pixel, Simple Choker treats the
// outside as transparent (0) — for erode that pulls the border in, for dilate a
// 0 never wins a max, which is the TS's "skip" exactly.
#include <algorithm>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

MinimaxOp minimax_op(double v) noexcept {
  const double r = js::round(v);
  if (r == 1) return MinimaxOp::minimum;
  if (r == 2) return MinimaxOp::max_then_min;
  if (r == 3) return MinimaxOp::min_then_max;
  return MinimaxOp::maximum;
}

MinimaxChannel minimax_channel(double v) noexcept {
  const double r = js::round(v);
  if (r == 1) return MinimaxChannel::color;
  if (r == 2) return MinimaxChannel::red;
  if (r == 3) return MinimaxChannel::green;
  if (r == 4) return MinimaxChannel::blue;
  return MinimaxChannel::alpha;
}

namespace {

enum class Pad : std::uint8_t { clamp, zero };

template <bool kMax, class T>
inline T pick(T a, T b) noexcept {
  if constexpr (kMax) {
    return a > b ? a : b;
  } else {
    return a < b ? a : b;
  }
}

/// One horizontal pass over every row of a w×h byte plane, in → out.
template <bool kMax, class T>
void pass_h(const T* in, T* out, int w, int h, int r, Pad pad, ThreadPool* pool) {
  const int k = 2 * r + 1;
  const int plen = w + 2 * r;
  for_rows(pool, h, [&](int y0, int y1) {
    std::vector<T> line(static_cast<std::size_t>(plen));
    std::vector<T> g(static_cast<std::size_t>(plen));
    std::vector<T> s(static_cast<std::size_t>(plen));
    for (int y = y0; y < y1; ++y) {
      const T* row = in + static_cast<std::size_t>(y) * static_cast<std::size_t>(w);
      for (int i = 0; i < plen; ++i) {
        const int x = i - r;
        line[static_cast<std::size_t>(i)] =
            (x >= 0 && x < w) ? row[x] : pad == Pad::zero ? T{0} : row[clampi(x, 0, w - 1)];
      }
      for (int i = 0; i < plen; ++i) {
        const auto u = static_cast<std::size_t>(i);
        g[u] = (i % k == 0) ? line[u] : pick<kMax, T>(g[u - 1], line[u]);
      }
      for (int i = plen - 1; i >= 0; --i) {
        const auto u = static_cast<std::size_t>(i);
        s[u] = (i % k == k - 1 || i == plen - 1) ? line[u] : pick<kMax, T>(s[u + 1], line[u]);
      }
      T* orow = out + static_cast<std::size_t>(y) * static_cast<std::size_t>(w);
      for (int x = 0; x < w; ++x) {
        orow[x] = pick<kMax, T>(s[static_cast<std::size_t>(x)], g[static_cast<std::size_t>(x + k - 1)]);
      }
    }
  });
}

/// One vertical pass: the same scheme with whole row segments as the elements,
/// so the inner loops run along contiguous memory. Threads split column strips.
template <bool kMax, class T>
void pass_v(const T* in, T* out, int w, int h, int r, Pad pad, ThreadPool* pool) {
  const int k = 2 * r + 1;
  const int plen = h + 2 * r;
  constexpr int kStrip = 256;
  const int strips = (w + kStrip - 1) / kStrip;
  const std::vector<T> zeros(static_cast<std::size_t>(kStrip), 0);
  for_rows(
      pool, strips,
      [&](int s0, int s1) {
        std::vector<T> g(static_cast<std::size_t>(plen) * kStrip);
        std::vector<T> s(static_cast<std::size_t>(plen) * kStrip);
        for (int strip = s0; strip < s1; ++strip) {
          const int x0 = strip * kStrip;
          const int cw = std::min(kStrip, w - x0);
          const auto src_row = [&](int i) -> const T* {
            const int y = i - r;
            if (y < 0 || y >= h) {
              if (pad == Pad::zero) return zeros.data();
              return in + static_cast<std::size_t>(clampi(y, 0, h - 1)) * static_cast<std::size_t>(w) +
                     static_cast<std::size_t>(x0);
            }
            return in + static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x0);
          };
          for (int i = 0; i < plen; ++i) {
            const T* sr = src_row(i);
            T* gr = g.data() + static_cast<std::size_t>(i) * kStrip;
            if (i % k == 0) {
              std::copy(sr, sr + cw, gr);
            } else {
              const T* gp = gr - kStrip;
              for (int x = 0; x < cw; ++x) gr[x] = pick<kMax, T>(gp[x], sr[x]);
            }
          }
          for (int i = plen - 1; i >= 0; --i) {
            const T* sr = src_row(i);
            T* sw = s.data() + static_cast<std::size_t>(i) * kStrip;
            if (i % k == k - 1 || i == plen - 1) {
              std::copy(sr, sr + cw, sw);
            } else {
              const T* sn = sw + kStrip;
              for (int x = 0; x < cw; ++x) sw[x] = pick<kMax, T>(sn[x], sr[x]);
            }
          }
          for (int y = 0; y < h; ++y) {
            const T* sa = s.data() + static_cast<std::size_t>(y) * kStrip;
            const T* gb = g.data() + static_cast<std::size_t>(y + k - 1) * kStrip;
            T* orow = out + static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x0);
            for (int x = 0; x < cw; ++x) orow[x] = pick<kMax, T>(sa[x], gb[x]);
          }
        }
      },
      1);
}

void pass(bool take_max, bool horizontal, std::vector<std::uint8_t>& cur, std::vector<std::uint8_t>& tmp, int w, int h,
          int r, Pad pad, ThreadPool* pool) {
  if (horizontal) {
    if (take_max) {
      pass_h<true, std::uint8_t>(cur.data(), tmp.data(), w, h, r, pad, pool);
    } else {
      pass_h<false, std::uint8_t>(cur.data(), tmp.data(), w, h, r, pad, pool);
    }
  } else if (take_max) {
    pass_v<true, std::uint8_t>(cur.data(), tmp.data(), w, h, r, pad, pool);
  } else {
    pass_v<false, std::uint8_t>(cur.data(), tmp.data(), w, h, r, pad, pool);
  }
  cur.swap(tmp);
}

void extract(const RgbaView& img, std::size_t c, std::vector<std::uint8_t>& plane) {
  const std::size_t n = img.pixels();
  plane.resize(n);
  for (std::size_t i = 0; i < n; ++i) plane[i] = img.data[i * 4 + c];
}

void insert(RgbaView& img, std::size_t c, const std::vector<std::uint8_t>& plane) {
  const std::size_t n = img.pixels();
  for (std::size_t i = 0; i < n; ++i) img.data[i * 4 + c] = plane[i];
}

}  // namespace

void minimax(RgbaView img, MinimaxOp op, double radius, MinimaxChannel channel, BlurDims direction, ThreadPool* pool) {
  const int r = static_cast<int>(std::max(0.0, js::round(radius)));
  if (r == 0 || img.w <= 0 || img.h <= 0) return;
  std::vector<std::size_t> offsets;
  switch (channel) {
    case MinimaxChannel::alpha: offsets = {3}; break;
    case MinimaxChannel::color: offsets = {0, 1, 2}; break;
    case MinimaxChannel::red: offsets = {0}; break;
    case MinimaxChannel::green: offsets = {1}; break;
    case MinimaxChannel::blue: offsets = {2}; break;
  }
  std::vector<std::uint8_t> cur;
  std::vector<std::uint8_t> tmp(img.pixels());
  for (const std::size_t c : offsets) {
    extract(img, c, cur);
    const auto separable = [&](bool take_max) {
      if (direction != BlurDims::vertical) pass(take_max, true, cur, tmp, img.w, img.h, r, Pad::clamp, pool);
      if (direction != BlurDims::horizontal) pass(take_max, false, cur, tmp, img.w, img.h, r, Pad::clamp, pool);
    };
    switch (op) {
      case MinimaxOp::maximum: separable(true); break;
      case MinimaxOp::minimum: separable(false); break;
      case MinimaxOp::max_then_min: separable(true); separable(false); break;
      case MinimaxOp::min_then_max: separable(false); separable(true); break;
    }
    insert(img, c, cur);
  }
}

void simple_choker(RgbaView img, double choke_px, ThreadPool* pool) {
  const int r = static_cast<int>(js::round(std::fabs(choke_px)));
  if (r == 0 || img.w <= 0 || img.h <= 0) return;
  const bool erode = choke_px > 0;
  std::vector<std::uint8_t> cur;
  std::vector<std::uint8_t> tmp(img.pixels());
  extract(img, 3, cur);
  pass(!erode, true, cur, tmp, img.w, img.h, r, Pad::zero, pool);
  pass(!erode, false, cur, tmp, img.w, img.h, r, Pad::zero, pool);
  insert(img, 3, cur);
}

void alpha_min_max(RgbaView img, int r, bool take_max, ThreadPool* pool) {
  if (r <= 0 || img.w <= 0 || img.h <= 0) return;
  std::vector<std::uint8_t> cur;
  std::vector<std::uint8_t> tmp(img.pixels());
  extract(img, 3, cur);
  pass(take_max, true, cur, tmp, img.w, img.h, r, Pad::clamp, pool);
  pass(take_max, false, cur, tmp, img.w, img.h, r, Pad::clamp, pool);
  insert(img, 3, cur);
}

void plane_min_max(std::vector<float>& plane, int w, int h, int r, bool take_max, ThreadPool* pool) {
  if (r <= 0 || w <= 0 || h <= 0) return;
  std::vector<float> tmp(plane.size());
  if (take_max) {
    pass_h<true, float>(plane.data(), tmp.data(), w, h, r, Pad::clamp, pool);
    pass_v<true, float>(tmp.data(), plane.data(), w, h, r, Pad::clamp, pool);
  } else {
    pass_h<false, float>(plane.data(), tmp.data(), w, h, r, Pad::clamp, pool);
    pass_v<false, float>(tmp.data(), plane.data(), w, h, r, Pad::clamp, pool);
  }
}

}  // namespace premation::effects
