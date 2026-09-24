// Port of src/core/effects/aeRoundSix.ts — Unmult, CC Composite (the layer
// over itself, as applyCcComposite calls it), CC Scatterize, Radial Fast Blur,
// Cross Blur, Scale Wipe, Plastic. (CC RepeTile expands then crops back
// through a canvas drawImage: it stays with the canvas-drawn effects.)
#include <algorithm>
#include <array>
#include <optional>
#include <vector>

#include "color_space.hpp"
#include "kernels.hpp"
#include "noise_hash.hpp"
#include "remap.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;
constexpr double kDeg = kPi / 180;

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return js::hypot(v);
}
double hypot3(double a, double b, double c) {
  const std::array<double, 3> v{a, b, c};
  return js::hypot(v);
}
double or_one(double v) { return (v == 0 || std::isnan(v)) ? 1 : v; }

}  // namespace

void unmult(RgbaView img, double threshold, double boost, ThreadPool* pool) {
  const double thresh = std::max(0.0, std::min(0.99, threshold / 100));
  const double boost_gain = std::max(0.1, boost / 100);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    const double a = px[3];
    if (a == 0) {  // the TS output buffer starts transparent black
      px[0] = px[1] = px[2] = 0;
      return;
    }
    const double max_chan = std::max(r, std::max(g, b)) / 255;
    if (max_chan <= thresh) {
      px[0] = px[1] = px[2] = px[3] = 0;
      return;
    }
    const double norm_l = (max_chan - thresh) / (1 - thresh);
    const double na = std::min(1.0, norm_l * boost_gain * (a / 255));
    const double new_alpha = js::round(na * 255);
    if (new_alpha <= 0) {
      px[0] = px[1] = px[2] = px[3] = 0;
      return;
    }
    px[0] = u8c(clamp255(r / na));
    px[1] = u8c(clamp255(g / na));
    px[2] = u8c(clamp255(b / na));
    px[3] = u8c(new_alpha);
  });
}

void cc_composite(RgbaView img, double opacity, double blend_mode, bool rgb_only, ThreadPool* pool) {
  // compositeBlendMode: in-front, behind, add, multiply, screen, overlay,
  // hard-light, soft-light, difference, stencil-alpha, silhouette-alpha.
  const int mode = static_cast<int>(std::max(0.0, std::min(10.0, js::round(blend_mode))));
  const double mix = clamp01(opacity / 100);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    // applyCcComposite passes the same buffer as current and original.
    const double cr = px[0];
    const double cg = px[1];
    const double cb = px[2];
    const double ca = px[3];
    const double orr = cr;
    const double og = cg;
    const double ob = cb;
    const double oa = ca;
    double br = cr;
    double bg = cg;
    double bb = cb;
    double ba = ca;
    const double top_a = oa / 255;
    const double bot_a = ca / 255;
    const auto ovl = [](double c, double o) {
      return c < 128 ? (2 * c * o) / 255 : 255 - (2 * (255 - c) * (255 - o)) / 255;
    };
    switch (mode) {
      case 0:
        br = orr * top_a + cr * (1 - top_a);
        bg = og * top_a + cg * (1 - top_a);
        bb = ob * top_a + cb * (1 - top_a);
        ba = std::max(oa, ca);
        break;
      case 1:
        br = cr * bot_a + orr * (1 - bot_a);
        bg = cg * bot_a + og * (1 - bot_a);
        bb = cb * bot_a + ob * (1 - bot_a);
        ba = std::max(oa, ca);
        break;
      case 2:
        br = std::min(255.0, cr + orr);
        bg = std::min(255.0, cg + og);
        bb = std::min(255.0, cb + ob);
        ba = std::max(ca, oa);
        break;
      case 3:
        br = (cr * orr) / 255;
        bg = (cg * og) / 255;
        bb = (cb * ob) / 255;
        ba = std::max(ca, oa);
        break;
      case 4:
        br = 255 - ((255 - cr) * (255 - orr)) / 255;
        bg = 255 - ((255 - cg) * (255 - og)) / 255;
        bb = 255 - ((255 - cb) * (255 - ob)) / 255;
        ba = std::max(ca, oa);
        break;
      case 5:
        br = ovl(cr, orr);
        bg = ovl(cg, og);
        bb = ovl(cb, ob);
        ba = std::max(ca, oa);
        break;
      case 8:
        br = std::fabs(cr - orr);
        bg = std::fabs(cg - og);
        bb = std::fabs(cb - ob);
        ba = std::max(ca, oa);
        break;
      case 9:
        ba = (ca * oa) / 255;
        break;
      case 10:
        ba = (ca * (255 - oa)) / 255;
        break;
      default:  // hard-light, soft-light: the TS's default branch
        br = orr;
        bg = og;
        bb = ob;
        ba = oa;
        break;
    }
    px[0] = u8c(clamp255(cr + (br - cr) * mix));
    px[1] = u8c(clamp255(cg + (bg - cg) * mix));
    px[2] = u8c(clamp255(cb + (bb - cb) * mix));
    px[3] = rgb_only ? px[3] : u8c(clamp255(ca + (ba - ca) * mix));
  });
}

void cc_scatterize(RgbaView img, double amount, double wind_x, double wind_y, double twist, double seed,
                   ThreadPool* /*pool*/) {
  // A FORWARD scatter: pixels later in scan order overwrite earlier ones that
  // land on the same destination, so the scan stays serial to keep the TS's
  // winner (rows cannot be split without changing which write lands last).
  if (amount <= 0.001) return;
  const int w = img.w;
  const int h = img.h;
  const double amt = amount * 0.5;
  const double twist_rad = twist * kDeg;
  const double cx = w / 2.0;
  const double cy = h / 2.0;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  std::fill(img.data.begin(), img.data.end(), std::uint8_t{0});
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const std::uint8_t* s = src.data() + idx4(x, y, w);
      if (s[3] == 0) continue;
      const double h1 = hash2(x + seed * 997, y + seed * 997);
      const double h2 = hash2(y + seed * 613, x + seed * 613);
      const double dist = h1 * amt;
      const double ang = h2 * kPi * 2 + twist_rad * (hypot2(x - cx, y - cy) / std::max(1.0, cx));
      const double dx = js::cos(ang) * dist + (wind_x * amt) / 100;
      const double dy = js::sin(ang) * dist + (wind_y * amt) / 100;
      const double dest_x = round_index(x + dx);
      const double dest_y = round_index(y + dy);
      if (dest_x >= 0 && dest_x < w && dest_y >= 0 && dest_y < h) {
        std::uint8_t* d = out + idx4(static_cast<int>(dest_x), static_cast<int>(dest_y), w);
        d[0] = s[0];
        d[1] = s[1];
        d[2] = s[2];
        d[3] = s[3];
      }
    }
  }
}

void radial_fast_blur(RgbaView img, double amount, double center_x, double center_y, double mode, ThreadPool* pool) {
  if (amount <= 0.01) return;
  const int m = static_cast<int>(std::max(0.0, std::min(2.0, js::round(mode))));  // standard, bright, dark
  const int w = img.w;
  const int h = img.h;
  const double cx = w / 2.0 + center_x;
  const double cy = h / 2.0 + center_y;
  const double amt = (amount / 100) * 0.8;
  constexpr int kSteps = 16;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double vx = cx - x;
        const double vy = cy - y;
        double r_acc = 0;
        double g_acc = 0;
        double b_acc = 0;
        double a_acc = 0;
        double total = 0;
        for (int s = 0; s < kSteps; ++s) {
          const double frac = (static_cast<double>(s) / kSteps) * amt;
          const double sx = std::min(static_cast<double>(w - 1), std::max(0.0, round_index(x + vx * frac)));
          const double sy = std::min(static_cast<double>(h - 1), std::max(0.0, round_index(y + vy * frac)));
          const std::uint8_t* p = src.data() + idx4(static_cast<int>(sx), static_cast<int>(sy), w);
          double weight = 1 - (static_cast<double>(s) / kSteps) * 0.5;
          if (m == 1) {
            const double lum = (p[0] + p[1] + p[2]) / (255.0 * 3);
            weight *= 1 + lum * 2;
          } else if (m == 2) {
            const double lum = (p[0] + p[1] + p[2]) / (255.0 * 3);
            weight *= 1 + (1 - lum) * 2;
          }
          r_acc += p[0] * weight;
          g_acc += p[1] * weight;
          b_acc += p[2] * weight;
          a_acc += p[3] * weight;
          total += weight;
        }
        std::uint8_t* o = out + idx4(x, y, w);
        if (total > 0) {
          o[0] = u8c(clamp255(r_acc / total));
          o[1] = u8c(clamp255(g_acc / total));
          o[2] = u8c(clamp255(b_acc / total));
          o[3] = u8c(clamp255(a_acc / total));
        } else {
          o[0] = o[1] = o[2] = o[3] = 0;
        }
      }
    }
  });
}

void cross_blur(RgbaView img, double radius_x, double radius_y, bool repeat_edges, ThreadPool* pool) {
  const int rx = static_cast<int>(std::max(0.0, js::round(radius_x)));
  const int ry = static_cast<int>(std::max(0.0, js::round(radius_y)));
  if (rx == 0 && ry == 0) return;
  const int w = img.w;
  const int h = img.h;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::vector<std::uint8_t> temp(src.size());
  // Integer sums (exact in the TS's doubles), so the windows slide.
  const auto pass = [&](const std::vector<std::uint8_t>& from, std::uint8_t* to, bool horiz) {
    const int r = horiz ? rx : ry;
    for_rows(pool, h, [&](int y0, int y1) {
      for (int y = y0; y < y1; ++y) {
        for (int x = 0; x < w; ++x) {
          std::array<double, 4> acc{};
          double cnt = 0;
          for (int k = -r; k <= r; ++k) {
            int sx = horiz ? x + k : x;
            int sy = horiz ? y : y + k;
            if (sx < 0 || sx >= w || sy < 0 || sy >= h) {
              if (!repeat_edges) continue;
              sx = clampi(sx, 0, w - 1);
              sy = clampi(sy, 0, h - 1);
            }
            const std::uint8_t* p = from.data() + idx4(sx, sy, w);
            for (std::size_t c = 0; c < 4; ++c) acc[c] += p[c];
            cnt += 1;
          }
          std::uint8_t* o = to + idx4(x, y, w);
          for (std::size_t c = 0; c < 4; ++c) o[c] = cnt > 0 ? u8c(acc[c] / cnt) : 0;
        }
      }
    });
  };
  pass(src, temp.data(), true);
  pass(temp, img.data.data(), false);
}

void scale_wipe(RgbaView img, double completion, double stretch, double direction, double center_x, double center_y,
                ThreadPool* pool) {
  const double comp = clamp01(completion / 100);
  if (comp <= 0.001) return;
  const double cx = img.w / 2.0 + center_x;
  const double cy = img.h / 2.0 + center_y;
  const double dir_rad = direction * kDeg;
  const double ux = js::cos(dir_rad);
  const double uy = js::sin(dir_rad);
  const double max_dist = hypot2(img.w, img.h);
  const double wipe_edge = comp * max_dist;
  remap_rgba(img, pool, [&](double x, double y) -> std::optional<RemapPt> {
    const double dx = x - cx;
    const double dy = y - cy;
    const double proj = dx * ux + dy * uy;
    if (proj <= wipe_edge) {
      const double scale = 1 + (stretch * (wipe_edge - proj)) / max_dist;
      return RemapPt{cx + (dx - ux * proj) + ux * (proj / scale), cy + (dy - uy * proj) + uy * (proj / scale)};
    }
    return RemapPt{x, y};
  });
}

void plastic(RgbaView img, double surface_bump, double softness, double light_angle, double light_intensity,
             double specular, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const auto uw = static_cast<std::size_t>(w);
  // lumaField: Float32 luma·alpha, then a clamped-count box (skip, not clamp,
  // out-of-range taps) horizontally then vertically; float sums in tap order.
  std::vector<float> field(img.pixels());
  const std::uint8_t* s = img.data.data();
  for (std::size_t i = 0; i < field.size(); ++i) {
    field[i] = static_cast<float>(luma709(s[i * 4], s[i * 4 + 1], s[i * 4 + 2]) * (s[i * 4 + 3] / 255.0));
  }
  const int r = static_cast<int>(std::max(0.0, js::round(softness)));
  if (r > 0) {
    for (int pass = 0; pass < 2; ++pass) {
      std::vector<float> g(field.size());
      for_rows(pool, h, [&](int y0, int y1) {
        for (int y = y0; y < y1; ++y) {
          for (int x = 0; x < w; ++x) {
            double sum = 0;
            double cnt = 0;
            for (int k = -r; k <= r; ++k) {
              const int xx = pass == 0 ? x + k : x;
              const int yy = pass == 0 ? y : y + k;
              if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
              sum += static_cast<double>(field[static_cast<std::size_t>(yy) * uw + static_cast<std::size_t>(xx)]);
              cnt += 1;
            }
            g[static_cast<std::size_t>(y) * uw + static_cast<std::size_t>(x)] =
                cnt > 0 ? static_cast<float>(sum / cnt) : 0.0F;
          }
        }
      });
      field.swap(g);
    }
  }
  const double bump = (surface_bump / 100) * 8;
  const double la = light_angle * kDeg;
  const double lx = js::cos(la);
  const double ly = -js::sin(la);
  const double lz = 0.8;
  const double l_len = or_one(hypot3(lx, ly, lz));
  const double nlx = lx / l_len;
  const double nly = ly / l_len;
  const double nlz = lz / l_len;
  const double gain = light_intensity / 100;
  const double spec_gain = (specular / 100) * 1.5;
  const double hz = nlz + 1.0;
  const double h_len = or_one(hypot3(nlx, nly, hz));
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::size_t idx = idx4(x, y, w);
        const std::uint8_t a = src[idx + 3];
        if (a == 0) {
          out[idx] = out[idx + 1] = out[idx + 2] = out[idx + 3] = 0;
          continue;
        }
        const auto at = [&](int xx, int yy) {
          return static_cast<double>(field[static_cast<std::size_t>(yy) * uw + static_cast<std::size_t>(xx)]);
        };
        const double gx = (at(std::min(w - 1, x + 1), y) - at(std::max(0, x - 1), y)) * bump;
        const double gy = (at(x, std::min(h - 1, y + 1)) - at(x, std::max(0, y - 1))) * bump;
        const double gz = 1.0;
        const double n_len = or_one(hypot3(gx, gy, gz));
        const double nx = -gx / n_len;
        const double ny = -gy / n_len;
        const double nz = gz / n_len;
        const double diff = std::max(0.0, nx * nlx + ny * nly + nz * nlz);
        const double ndoth = std::max(0.0, (nx * nlx + ny * nly + nz * hz) / h_len);
        const double spec = js::pow(ndoth, 16) * spec_gain;
        const double lighting = diff * gain + 0.3;
        for (std::size_t c = 0; c < 3; ++c) out[idx + c] = u8c(clamp255(src[idx + c] * lighting + spec * 255));
        out[idx + 3] = a;
      }
    }
  });
}

}  // namespace premation::effects
