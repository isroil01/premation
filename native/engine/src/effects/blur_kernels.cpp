// Ports of src/core/effects/blurs.ts (blurRgba, radialBlurData, channelBlurData,
// unsharpMaskData) and canvas2dEffects.ts `sharpenData`.
#include <algorithm>
#include <cstring>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

BlurDims blur_dims(double v) noexcept {
  return v == 1 ? BlurDims::horizontal : v == 2 ? BlurDims::vertical : BlurDims::both;
}

namespace {

// ── blurRgba ────────────────────────────────────────────────────────────────
//
// The TS keeps four premultiplied 16-bit planes and slides a box window over
// them. Horizontal sums are JS doubles holding integers (exact, so any order
// gives the same value); vertical sums live in a Float32Array, which is exact
// only below 2^24 — past a radius of ~128 the float rounding is part of the
// result, so the vertical pass keeps float sums updated in the TS's order,
// column by column (threads split COLUMNS there, never the row sequence).

void box_pass_h(const std::uint16_t* src, std::uint16_t* dst, int w, int h, int r, bool repeat_edge,
                ThreadPool* pool) {
  const double inv = 1.0 / (r * 2 + 1);
  const std::size_t n = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  for_rows(pool, h, [&](int y0, int y1) {
    for (int plane = 0; plane < 4; ++plane) {
      const std::size_t base = n * static_cast<std::size_t>(plane);
      for (int y = y0; y < y1; ++y) {
        const std::uint16_t* s = src + base + static_cast<std::size_t>(y) * static_cast<std::size_t>(w);
        std::uint16_t* d = dst + base + static_cast<std::size_t>(y) * static_cast<std::size_t>(w);
        // Integer sums: the TS doubles hold these exactly (≤ 65025 · (2r+1)).
        std::int64_t sum = 0;
        for (int k = -r; k <= r; ++k) {
          int i = k;
          if (i < 0) {
            if (!repeat_edge) continue;
            i = 0;
          } else if (i >= w) {
            if (!repeat_edge) continue;
            i = w - 1;
          }
          sum += s[i];
        }
        for (int x = 0; x < w; ++x) {
          d[x] = u16t(static_cast<double>(sum) * inv + 0.5);
          int i_out = x - r;
          int i_in = x + r + 1;
          if (i_out < 0) {
            if (repeat_edge) sum -= s[0];
          } else {
            sum -= s[i_out];
          }
          if (i_in >= w) {
            if (repeat_edge) sum += s[w - 1];
          } else {
            sum += s[i_in];
          }
        }
      }
    }
  });
}

void box_pass_v(const std::uint16_t* src, std::uint16_t* dst, int w, int h, int r, bool repeat_edge,
                ThreadPool* pool) {
  const double inv = 1.0 / (r * 2 + 1);
  const std::size_t n = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  const auto row_at = [&](int y) -> int {
    if (y < 0) return repeat_edge ? 0 : -1;
    if (y >= h) return repeat_edge ? h - 1 : -1;
    return y;
  };
  // Column strips of 64 keep a strip's float sums in L1 and its row reads
  // contiguous; each column sees exactly the TS's sequence of adds.
  constexpr int kStrip = 64;
  const int strips = (w + kStrip - 1) / kStrip;
  for_rows(
      pool, strips,
      [&](int s0, int s1) {
        std::vector<float> sums(static_cast<std::size_t>(kStrip));
        for (int strip = s0; strip < s1; ++strip) {
          const int x0 = strip * kStrip;
          const int cw = std::min(kStrip, w - x0);
          for (int plane = 0; plane < 4; ++plane) {
            const std::uint16_t* s = src + n * static_cast<std::size_t>(plane) + static_cast<std::size_t>(x0);
            std::uint16_t* d = dst + n * static_cast<std::size_t>(plane) + static_cast<std::size_t>(x0);
            float* sm = sums.data();
            std::fill(sm, sm + cw, 0.0F);
            const auto add_row = [&](int yy) {
              const std::uint16_t* sr = s + static_cast<std::size_t>(yy) * static_cast<std::size_t>(w);
              for (int x = 0; x < cw; ++x) sm[x] = sm[x] + static_cast<float>(sr[x]);
            };
            const auto sub_row = [&](int yy) {
              const std::uint16_t* sr = s + static_cast<std::size_t>(yy) * static_cast<std::size_t>(w);
              for (int x = 0; x < cw; ++x) sm[x] = sm[x] - static_cast<float>(sr[x]);
            };
            for (int k = -r; k <= r; ++k) {
              const int yy = row_at(k);
              if (yy >= 0) add_row(yy);
            }
            for (int y = 0; y < h; ++y) {
              std::uint16_t* dr = d + static_cast<std::size_t>(y) * static_cast<std::size_t>(w);
              for (int x = 0; x < cw; ++x) dr[x] = u16t(static_cast<double>(sm[x]) * inv + 0.5);
              const int y_out = row_at(y - r);
              const int y_in = row_at(y + r + 1);
              if (y_out >= 0) sub_row(y_out);
              if (y_in >= 0) add_row(y_in);
            }
          }
        }
      },
      1);
}

}  // namespace

void blur_rgba(RgbaView img, double radius, BlurDims dims, double iterations_in, bool repeat_edge, ThreadPool* pool) {
  const int iterations = static_cast<int>(std::max(1.0, std::min(10.0, js::round(iterations_in))));
  const int w = img.w;
  const int h = img.h;
  if (radius <= 0 || w <= 0 || h <= 0) return;
  const double per_pass = radius / std::sqrt(static_cast<double>(iterations));
  const int r = static_cast<int>(std::max(0.0, std::floor(per_pass)));

  const std::size_t n = img.pixels();
  std::vector<std::uint16_t> planes0(n * 4);
  std::vector<std::uint16_t> planes1(n * 4);
  std::uint8_t* data = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w);
         i < static_cast<std::size_t>(y1) * static_cast<std::size_t>(w); ++i) {
      const std::uint16_t a = data[i * 4 + 3];
      planes0[i] = static_cast<std::uint16_t>(data[i * 4] * a);
      planes0[n + i] = static_cast<std::uint16_t>(data[i * 4 + 1] * a);
      planes0[2 * n + i] = static_cast<std::uint16_t>(data[i * 4 + 2] * a);
      planes0[3 * n + i] = a;
    }
  });

  std::uint16_t* cur = planes0.data();
  std::uint16_t* oth = planes1.data();
  const auto pass = [&](bool horizontal) {
    if (r == 0) {
      std::memcpy(oth, cur, n * 4 * sizeof(std::uint16_t));
    } else if (horizontal) {
      box_pass_h(cur, oth, w, h, r, repeat_edge, pool);
    } else {
      box_pass_v(cur, oth, w, h, r, repeat_edge, pool);
    }
    std::swap(cur, oth);
  };
  for (int i = 0; i < iterations; ++i) {
    if (dims != BlurDims::vertical) pass(true);
    if (dims != BlurDims::horizontal) pass(false);
  }

  const std::uint16_t* out = cur;
  for_rows(pool, h, [&](int y0, int y1) {
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w);
         i < static_cast<std::size_t>(y1) * static_cast<std::size_t>(w); ++i) {
      const std::uint16_t a = out[3 * n + i];
      std::uint8_t* px = data + i * 4;
      if (a > 0) {
        const double ia = 1.0 / a;
        px[0] = u8c(out[i] * ia);
        px[1] = u8c(out[n + i] * ia);
        px[2] = u8c(out[2 * n + i] * ia);
      } else {
        px[0] = 0;
        px[1] = 0;
        px[2] = 0;
      }
      px[3] = u8c(a);
    }
  });
}

// ── radialBlurData ──────────────────────────────────────────────────────────

void radial_blur(RgbaView img, double amount, double cx, double cy, bool zoom, double quality, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  if (amount == 0 || w <= 0 || h <= 0) return;
  const int steps = static_cast<int>(std::max(2.0, std::min(64.0, js::round(quality))));
  // The per-step rotation / scale depends only on the step, so it is computed
  // once (the same values the TS recomputes per pixel).
  std::vector<double> cs(static_cast<std::size_t>(steps));
  std::vector<double> sn(static_cast<std::size_t>(steps));
  std::vector<double> sc(static_cast<std::size_t>(steps));
  for (int s = 0; s < steps; ++s) {
    const double t = static_cast<double>(s) / (steps - 1);
    if (zoom) {
      sc[static_cast<std::size_t>(s)] = 1 + (amount / 100) * t;
    } else {
      const double ang = (amount * 3.141592653589793) / 180 * t;
      cs[static_cast<std::size_t>(s)] = js::cos(ang);
      sn[static_cast<std::size_t>(s)] = js::sin(ang);
    }
  }
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double dx = x - cx;
        const double dy = y - cy;
        double r = 0;
        double g = 0;
        double b = 0;
        double a = 0;
        int n = 0;
        for (int s = 0; s < steps; ++s) {
          double sx = 0;
          double sy = 0;
          const auto su = static_cast<std::size_t>(s);
          if (!zoom) {
            sx = cx + dx * cs[su] - dy * sn[su];
            sy = cy + dx * sn[su] + dy * cs[su];
          } else {
            sx = cx + dx / sc[su];
            sy = cy + dy / sc[su];
          }
          const double xi = js::round(sx);
          const double yi = js::round(sy);
          if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
          const std::size_t o = idx4(static_cast<int>(xi), static_cast<int>(yi), w);
          const double sa = src[o + 3];
          r += src[o] * sa;
          g += src[o + 1] * sa;
          b += src[o + 2] * sa;
          a += sa;
          ++n;
        }
        const std::size_t d = idx4(x, y, w);
        if (n == 0 || a == 0) {
          out[d] = 0;
          out[d + 1] = 0;
          out[d + 2] = 0;
          out[d + 3] = 0;
        } else {
          out[d] = u8c(r / a);
          out[d + 1] = u8c(g / a);
          out[d + 2] = u8c(b / a);
          out[d + 3] = u8c(a / n);
        }
      }
    }
  });
}

// ── channelBlurData ─────────────────────────────────────────────────────────
//
// The TS sums every window sample afresh; the sums are small integers, exact
// in a double, so a sliding window gives the same sum (and the same byte) in
// O(1) per pixel instead of O(r).

namespace {

void blur_one_channel(RgbaView img, int channel, double radius, BlurDims dims, bool repeat_edge, ThreadPool* pool,
                      std::vector<std::uint8_t>& scratch) {
  const int r = static_cast<int>(js::round(radius));
  if (r <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const double count = 2.0 * r + 1.0;  // every window slot counts, in range or not
  std::uint8_t* data = img.data.data();
  const auto ch = static_cast<std::size_t>(channel);
  scratch.assign(img.pixels(), 0);

  const auto pass = [&](bool horizontal) {
    const int len = horizontal ? w : h;
    const int lines = horizontal ? h : w;
    const auto read = [&](int line, int j) -> int {
      const std::size_t idx = horizontal ? static_cast<std::size_t>(line) * static_cast<std::size_t>(w) + static_cast<std::size_t>(j)
                                         : static_cast<std::size_t>(j) * static_cast<std::size_t>(w) + static_cast<std::size_t>(line);
      return data[idx * 4 + ch];
    };
    const auto sample = [&](int line, int j) -> int {
      if (j < 0 || j >= len) {
        if (!repeat_edge) return 0;
        j = j < 0 ? 0 : len - 1;
      }
      return read(line, j);
    };
    for_rows(pool, lines, [&](int l0, int l1) {
      for (int line = l0; line < l1; ++line) {
        std::int64_t sum = 0;
        for (int k = -r; k <= r; ++k) sum += sample(line, k);
        for (int i = 0; i < len; ++i) {
          const std::size_t idx = horizontal ? static_cast<std::size_t>(line) * static_cast<std::size_t>(w) + static_cast<std::size_t>(i)
                                             : static_cast<std::size_t>(i) * static_cast<std::size_t>(w) + static_cast<std::size_t>(line);
          scratch[idx] = u8c(static_cast<double>(sum) / count);
          sum += sample(line, i + r + 1) - sample(line, i - r);
        }
      }
    });
    const std::size_t n = img.pixels();
    for (std::size_t i = 0; i < n; ++i) data[i * 4 + ch] = scratch[i];
  };
  if (dims != BlurDims::vertical) pass(true);
  if (dims != BlurDims::horizontal) pass(false);
}

}  // namespace

void channel_blur(RgbaView img, double red, double green, double blue, double alpha, BlurDims dims, bool repeat_edge,
                  ThreadPool* pool) {
  std::vector<std::uint8_t> scratch;
  blur_one_channel(img, 0, red, dims, repeat_edge, pool, scratch);
  blur_one_channel(img, 1, green, dims, repeat_edge, pool, scratch);
  blur_one_channel(img, 2, blue, dims, repeat_edge, pool, scratch);
  blur_one_channel(img, 3, alpha, dims, repeat_edge, pool, scratch);
}

// ── unsharpMaskData ─────────────────────────────────────────────────────────

void unsharp_mask(RgbaView img, double amount, double radius, double threshold, ThreadPool* pool) {
  const double k = amount / 100;
  if (k == 0 || radius <= 0) return;
  std::vector<std::uint8_t> blurred(img.data.begin(), img.data.end());
  blur_rgba(RgbaView{blurred, img.w, img.h}, radius, BlurDims::both, 3, true, pool);
  std::uint8_t* data = img.data.data();
  const int w = img.w;
  for_rows(pool, img.h, [&](int y0, int y1) {
    const std::size_t e = static_cast<std::size_t>(y1) * static_cast<std::size_t>(w) * 4;
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w) * 4; i < e; i += 4) {
      for (std::size_t c = 0; c < 3; ++c) {
        const double v = data[i + c];
        const double d = v - blurred[i + c];
        if (std::fabs(d) <= threshold) continue;
        data[i + c] = u8c(v + d * k);
      }
    }
  });
}

// ── sharpenData ─────────────────────────────────────────────────────────────

void sharpen(RgbaView img, double amount, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double k = amount;
  const double centre = 1 + 4 * k;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  const std::size_t stride = static_cast<std::size_t>(w) * 4;
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      const std::size_t up = static_cast<std::size_t>(y > 0 ? y - 1 : 0) * stride;
      const std::size_t down = static_cast<std::size_t>(y < h - 1 ? y + 1 : y) * stride;
      const std::size_t row = static_cast<std::size_t>(y) * stride;
      for (int x = 0; x < w; ++x) {
        const std::size_t col = static_cast<std::size_t>(x) * 4;
        const std::size_t i = row + col;
        if (src[i + 3] == 0) continue;
        const std::size_t left = row + static_cast<std::size_t>(x > 0 ? x - 1 : 0) * 4;
        const std::size_t right = row + static_cast<std::size_t>(x < w - 1 ? x + 1 : x) * 4;
        for (std::size_t c = 0; c < 3; ++c) {
          const double nsum = src[left + c] + src[right + c] + src[up + col + c] + src[down + col + c];
          const double v = centre * src[i + c] - k * nsum;
          out[i + c] = u8c(v < 0 ? 0 : v > 255 ? 255 : v);
        }
      }
    }
  });
}

}  // namespace premation::effects
