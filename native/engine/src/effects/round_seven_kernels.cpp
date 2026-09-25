// Ports of src/core/effects/aeRoundSevenColor.ts (Color Difference Key, Wire
// Removal, Broadcast Colors, Noise HLS) and aeRoundSevenStylize.ts (Block
// Load, Kernel, 3D Glasses, Fractal).
#include <algorithm>
#include <array>
#include <vector>

#include "color_space.hpp"
#include "kernels.hpp"
#include "noise_hash.hpp"

namespace premation::effects {

namespace {

double hypot3(double a, double b, double c) {
  const std::array<double, 3> v{a, b, c};
  return js::hypot(v);
}
double hypot2(double a, double b) { return jhypot2(a, b); }

}  // namespace

void color_difference_key(RgbaView img, const Rgb& key, double matte_in_black, double matte_in_white,
                          double matte_gamma, double view_mode, ThreadPool* pool) {
  const double kr = key.r / 255;
  const double kg = key.g / 255;
  const double kb = key.b / 255;
  double key_len = hypot3(kr, kg, kb);
  if (key_len == 0 || std::isnan(key_len)) key_len = 1;
  const double ur = kr / key_len;
  const double ug = kg / key_len;
  const double ub = kb / key_len;
  const double black = clamp01(matte_in_black / 255);
  const double white = clamp01(matte_in_white / 255);
  const double span = std::max(0.0001, white - black);
  const double gamma = std::max(0.01, matte_gamma);
  const int key_ch = kr >= kg && kr >= kb ? 0 : kg >= kb ? 1 : 2;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double r = px[0] / 255.0;
    const double g = px[1] / 255.0;
    const double b = px[2] / 255.0;
    const double a = px[3];
    const double along = r * ur + g * ug + b * ub;
    const double mag = hypot3(r, g, b);
    const double partial_a = mag < 0.0001 ? 0 : clamp01(along / mag);
    const double key_chan = key_ch == 0 ? r : key_ch == 1 ? g : b;
    const double other_max = key_ch == 0 ? std::max(g, b) : key_ch == 1 ? std::max(r, b) : std::max(r, g);
    const double partial_b = clamp01(key_chan - other_max);
    const double backness = clamp01(partial_a * partial_a * (partial_b * 2));
    double matte = 1 - backness;
    matte = clamp01((matte - black) / span);
    matte = js::pow(matte, 1 / gamma);
    if (view_mode == 1) {
      const std::uint8_t v = u8c(clamp255(matte * 255));
      px[0] = px[1] = px[2] = v;
      px[3] = 255;
      return;
    }
    px[3] = u8c(clamp255(a * matte));
  });
}

void wire_removal(RgbaView img, double point_ax, double point_ay, double point_bx, double point_by, double thickness,
                  double slope, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double ax = w / 2.0 + point_ax;
  const double ay = h / 2.0 + point_ay;
  const double bx = w / 2.0 + point_bx;
  const double by = h / 2.0 + point_by;
  const double dx = bx - ax;
  const double dy = by - ay;
  const double len = hypot2(dx, dy);
  if (len < 0.0001 || thickness <= 0) return;
  const double tx = dx / len;
  const double ty = dy / len;
  const double nx = -ty;
  const double ny = tx;
  const double half = thickness / 2;
  const double reach = half + (clamp01(slope / 100) * thickness) + 1;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  const auto at = [&](double x, double y) {
    const double xi = std::max(0.0, std::min(static_cast<double>(w - 1), round_index(x)));
    const double yi = std::max(0.0, std::min(static_cast<double>(h - 1), round_index(y)));
    return src.data() + idx4(static_cast<int>(xi), static_cast<int>(yi), w);
  };
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double px = x + 0.5 - ax;
        const double py = y + 0.5 - ay;
        const double along = px * tx + py * ty;
        if (along < 0 || along > len) continue;
        const double across = px * nx + py * ny;
        if (std::fabs(across) > half) continue;
        const double base_x = ax + tx * along;
        const double base_y = ay + ty * along;
        const std::uint8_t* s1 = at(base_x + nx * reach, base_y + ny * reach);
        const std::uint8_t* s2 = at(base_x - nx * reach, base_y - ny * reach);
        const double t = clamp01((across + half) / std::max(0.0001, thickness));
        std::uint8_t* o = out + idx4(x, y, w);
        for (std::size_t c = 0; c < 4; ++c) o[c] = u8c(clamp255(s2[c] * (1 - t) + s1[c] * t));
      }
    }
  });
}

void broadcast_colors(RgbaView img, double standard, double how, double max_signal_amplitude, ThreadPool* pool) {
  const double pedestal = standard == 0 ? 7.5 : 0;
  const double gain = 100 - pedestal;
  const double limit = std::max(90.0, std::min(120.0, max_signal_amplitude));
  each_pixel(img, pool, [&](std::uint8_t* px) {
    double r = px[0] / 255.0;
    double g = px[1] / 255.0;
    double b = px[2] / 255.0;
    const double y_lin = 0.299 * r + 0.587 * g + 0.114 * b;
    const double u = 0.492 * (b - y_lin);
    const double v = 0.877 * (r - y_lin);
    const double chroma = hypot2(u, v);
    const double ire = pedestal + y_lin * gain + chroma * gain;
    if (ire <= limit) {
      if (how == 3) px[3] = 0;  // Key Out Safe (the TS's second pass, same pixel test)
      return;
    }
    if (how == 2) {
      px[3] = 0;
      return;
    }
    if (how == 3) return;
    const double excess = ire - limit;
    if (how == 0) {
      const double k = clamp01(1 - excess / std::max(0.0001, y_lin * gain + chroma * gain));
      r *= k;
      g *= k;
      b *= k;
    } else {
      const double k = clamp01(1 - excess / std::max(0.0001, chroma * gain));
      r = y_lin + (r - y_lin) * k;
      g = y_lin + (g - y_lin) * k;
      b = y_lin + (b - y_lin) * k;
    }
    px[0] = u8c(clamp255(r * 255));
    px[1] = u8c(clamp255(g * 255));
    px[2] = u8c(clamp255(b * 255));
  });
}

void noise_hls(RgbaView img, double noise_type, double hue, double lightness, double saturation, double grain_size,
               double noise_phase, ThreadPool* pool) {
  const double h_amt = clamp01(hue / 100);
  const double l_amt = clamp01(lightness / 100);
  const double s_amt = clamp01(saturation / 100);
  if (h_amt == 0 && l_amt == 0 && s_amt == 0) return;
  const double cell = std::max(0.5, grain_size);
  const double phase = std::floor(noise_phase);
  const auto shape = [&](double n) {
    const double centred = n * 2 - 1;
    return noise_type == 1 ? centred * std::fabs(centred) : centred;
  };
  const int w = img.w;
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        if (p[3] == 0) continue;
        const double cx = std::floor(x / cell);
        const double cy = std::floor(y / cell);
        const double nh = shape(hash2(cx + phase * 131, cy + phase * 17));
        const double nl = shape(hash2(cy + phase * 71, cx + phase * 251));
        const double ns = shape(hash2(cx * 7 + phase, cy * 13 + phase));
        const Hsl c = rgb_to_hsl(p[0], p[1], p[2]);
        const double h2 = std::fmod(std::fmod(c.h + nh * h_amt, 1.0) + 1, 1.0);
        const double s2 = clamp01(c.s + ns * s_amt);
        const double l2 = clamp01(c.l + nl * l_amt);
        const auto rgb = hsl_to_rgb(h2, s2, l2);
        p[0] = u8c(clamp255(rgb[0]));
        p[1] = u8c(clamp255(rgb[1]));
        p[2] = u8c(clamp255(rgb[2]));
      }
    }
  });
}

void block_load(RgbaView img, double completion, double scans, double block_size, ThreadPool* pool) {
  const double t = clamp01(completion / 100);
  if (t >= 1) return;
  const int w = img.w;
  const int h = img.h;
  const int n_scans = static_cast<int>(std::max(1.0, std::min(8.0, js::round(scans))));
  const double base = std::max(1.0, js::round(block_size));
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      const double row_frac = h <= 1 ? 0 : static_cast<double>(y) / h;
      const double progress = t * (n_scans + 1) - row_frac;
      const double scan = std::floor(progress);
      if (scan >= n_scans) continue;
      const double size = scan < 0 ? base : std::max(1.0, js::round(base / js::pow(2, scan)));
      const double by = std::min(static_cast<double>(h - 1), std::floor(y / size) * size + std::floor(size / 2));
      for (int x = 0; x < w; ++x) {
        const double bx = std::min(static_cast<double>(w - 1), std::floor(x / size) * size + std::floor(size / 2));
        const std::uint8_t* s = src.data() + idx4(static_cast<int>(bx), static_cast<int>(by), w);
        std::uint8_t* d = out + idx4(x, y, w);
        d[0] = s[0];
        d[1] = s[1];
        d[2] = s[2];
        d[3] = s[3];
      }
    }
  });
}

void kernel_convolve(RgbaView img, const std::array<double, 9>& k, double divisor, double offset, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double div = std::fabs(divisor) < 0.0001 ? 1 : divisor;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* o = out + idx4(x, y, w);
        for (std::size_t c = 0; c < 3; ++c) {
          double acc = 0;
          for (int j = -1; j <= 1; ++j) {
            for (int i = -1; i <= 1; ++i) {
              const int xx = clampi(x + i, 0, w - 1);
              const int yy = clampi(y + j, 0, h - 1);
              acc += src[idx4(xx, yy, w) + c] * k[static_cast<std::size_t>((j + 1) * 3 + (i + 1))];
            }
          }
          o[c] = u8c(clamp255(acc / div + offset));
        }
      }
    }
  });
}

void glasses_3d(RgbaView img, double convergence_offset, double view, double balance, bool swap_left_right,
                ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double shift = swap_left_right ? -convergence_offset : convergence_offset;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  const auto at = [&](double x, int y) {
    const double xi = std::max(0.0, std::min(static_cast<double>(w - 1), round_index(x)));
    return src.data() + idx4(static_cast<int>(xi), clampi(y, 0, h - 1), w);
  };
  const double bal = clamp01(balance / 100);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* o = out + idx4(x, y, w);
        const std::uint8_t* l = at(x - shift / 2, y);
        const std::uint8_t* r = at(x + shift / 2, y);
        if (view == 1) {
          o[0] = l[0];
          o[1] = r[1];
          o[2] = 0;
        } else if (view == 2) {
          o[0] = l[0];
          o[1] = 0;
          o[2] = r[2];
        } else if (view == 3) {
          const double l_lum = luma709(l[0], l[1], l[2]);
          o[0] = u8c(clamp255(l[0] * (1 - bal) + l_lum * bal));
          o[1] = u8c(clamp255(r[1] * bal));
          o[2] = r[2];
        } else if (view == 4) {
          const double half = w / 2.0;
          const double src_x = x < half ? (x / half) * w : ((x - half) / half) * w;
          const double eye_shift = x < half ? -shift / 2 : shift / 2;
          const std::uint8_t* s = at(src_x + eye_shift, y);
          o[0] = s[0];
          o[1] = s[1];
          o[2] = s[2];
          o[3] = s[3];
          continue;
        } else if (view == 5) {
          const std::uint8_t* s = y % 2 == 0 ? l : r;
          o[0] = s[0];
          o[1] = s[1];
          o[2] = s[2];
          o[3] = s[3];
          continue;
        } else {
          o[0] = l[0];
          o[1] = r[1];
          o[2] = r[2];
        }
        o[3] = std::max(l[3], r[3]);
      }
    }
  });
}

void fractal(RgbaView img, double set_type, double center_x, double center_y, double magnification, double iterations,
             double julia_x, double julia_y, double color_phase, double color_cycles, const Rgb& inside,
             ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const int max_iter = static_cast<int>(std::max(1.0, std::min(256.0, js::round(iterations))));
  const double mag = std::max(0.1, magnification);
  const double scale = 4 / (std::min(w, h) * mag);
  const double phase = color_phase / 360;
  const double cycles = std::max(0.1, color_cycles);
  const auto f32 = [](double v) { return static_cast<double>(static_cast<float>(v)); };
  const double ln2 = js::log(2);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* o = out + idx4(x, y, w);
        const double px = (x + 0.5 - w / 2.0) * scale + center_x;
        const double py = (y + 0.5 - h / 2.0) * scale + center_y;
        double zr = 0;
        double zi = 0;
        double cr = px;
        double ci = py;
        if (set_type == 1) {
          zr = px;
          zi = py;
          cr = julia_x;
          ci = julia_y;
        }
        int n = 0;
        double zr2 = f32(zr * zr);
        double zi2 = f32(zi * zi);
        while (n < max_iter && zr2 + zi2 <= 256) {
          zi = f32(2 * zr * zi + ci);
          zr = f32(zr2 - zi2 + cr);
          zr2 = f32(zr * zr);
          zi2 = f32(zi * zi);
          ++n;
        }
        if (n >= max_iter) {
          o[0] = u8c(clamp255(inside.r));
          o[1] = u8c(clamp255(inside.g));
          o[2] = u8c(clamp255(inside.b));
          o[3] = 255;
          continue;
        }
        const double modulus = std::sqrt(zr2 + zi2);
        const double smooth = n + 1 - js::log(js::log(modulus) / ln2) / ln2;
        const double hue = std::fmod(std::fmod(phase + (smooth / max_iter) * cycles, 1.0) + 1, 1.0);
        // hueToRgb
        const double h6 = hue * 6;
        const double fl = std::floor(h6);
        const double i = std::fmod(fl, 6.0);
        const double f = h6 - fl;
        const double q = 1 - f;
        std::array<double, 3> c{};
        if (i == 0) {
          c = {255, f * 255, 0};
        } else if (i == 1) {
          c = {q * 255, 255, 0};
        } else if (i == 2) {
          c = {0, 255, f * 255};
        } else if (i == 3) {
          c = {0, q * 255, 255};
        } else if (i == 4) {
          c = {f * 255, 0, 255};
        } else {
          c = {255, 0, q * 255};
        }
        o[0] = u8c(clamp255(c[0]));
        o[1] = u8c(clamp255(c[1]));
        o[2] = u8c(clamp255(c[2]));
        o[3] = 255;
      }
    }
  });
}

}  // namespace premation::effects
