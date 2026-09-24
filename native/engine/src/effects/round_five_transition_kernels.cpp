// Port of src/core/effects/aeTransitionsRoundFive.ts — Jaws, Pixel Polly,
// Twister, Card Dance. Pixel Polly and Card Dance paint pieces in cell order
// and a later piece overwrites an earlier one; threads split OUTPUT rows and
// every thread walks the pieces in that order, so the last writer matches.
#include <algorithm>
#include <array>
#include <vector>

#include "kernels.hpp"
#include "noise_hash.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;

double hypot2(double a, double b) { return jhypot2(a, b); }

void clear(RgbaView img) { std::fill(img.data.begin(), img.data.end(), std::uint8_t{0}); }

}  // namespace

void jaws(RgbaView img, double completion, double direction, double teeth_height, double teeth_width,
          ThreadPool* pool) {
  const double t = clamp01(completion / 100);
  if (t <= 0) return;
  if (t >= 1) {
    clear(img);
    return;
  }
  const int w = img.w;
  const int h = img.h;
  const double ang = (direction * kPi) / 180;
  const double ux = js::cos(ang);
  const double uy = js::sin(ang);
  const double nx = -uy;
  const double ny = ux;
  const double cx = w / 2.0;
  const double cy = h / 2.0;
  const double extent = std::fabs(nx * w) / 2 + std::fabs(ny * h) / 2;
  const double sep = t * (extent + teeth_height);
  const double tw = std::max(2.0, teeth_width);
  const double th = std::max(1.0, teeth_height);
  const auto tooth = [&](double u) {
    const double p = std::fmod(std::fmod(u / tw, 1.0) + 1, 1.0);
    return (p < 0.5 ? p * 2 : 2 - p * 2) * th - th / 2;
  };
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  clear(img);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double rx = x + 0.5 - cx;
        const double ry = y + 0.5 - cy;
        const double u = rx * ux + ry * uy;
        const double s_dist = rx * nx + ry * ny;
        const bool top = s_dist >= tooth(u);
        const double sxp = x + 0.5 - nx * (top ? sep : -sep);
        const double syp = y + 0.5 - ny * (top ? sep : -sep);
        const double sxi = round_index(sxp - 0.5);
        const double syi = round_index(syp - 0.5);
        if (sxi < 0 || sxi >= w || syi < 0 || syi >= h) continue;
        const double srx = sxp - cx;
        const double sry = syp - cy;
        const double s_u = srx * ux + sry * uy;
        const double s_s = srx * nx + sry * ny;
        if ((s_s >= tooth(s_u)) != top) continue;
        const std::uint8_t* s = src.data() + idx4(static_cast<int>(sxi), static_cast<int>(syi), w);
        std::uint8_t* o = out + idx4(x, y, w);
        o[0] = s[0];
        o[1] = s[1];
        o[2] = s[2];
        o[3] = s[3];
      }
    }
  });
}

void pixel_polly(RgbaView img, double completion, double cell_size, double gravity, double spin, double center_x,
                 double center_y, double seed, ThreadPool* pool) {
  const double t = clamp01(completion / 100);
  if (t <= 0) return;
  if (t >= 1) {
    clear(img);
    return;
  }
  const int w = img.w;
  const int h = img.h;
  const double cell = std::max(4.0, cell_size);
  const int cols = static_cast<int>(std::ceil(w / cell));
  const int rows = static_cast<int>(std::ceil(h / cell));
  const double s = std::floor(seed);
  const double fx = w / 2.0 + center_x;
  const double fy = h / 2.0 + center_y;
  const double max_fly = hypot2(w, h) * 0.7;
  const double fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
  struct Piece {
    double ccx, ccy, px, py, cos_r, sin_r;
    int x0, x1, y0, y1;
  };
  std::vector<Piece> pieces;
  pieces.reserve(static_cast<std::size_t>(cols) * static_cast<std::size_t>(rows));
  for (int cy = 0; cy < rows; ++cy) {
    for (int cx = 0; cx < cols; ++cx) {
      const double id = static_cast<double>(cy) * cols + cx;
      const double ccx = (cx + 0.5) * cell;
      const double ccy = (cy + 0.5) * cell;
      double dir_x = ccx - fx;
      double dir_y = ccy - fy;
      double dl = hypot2(dir_x, dir_y);
      if (dl == 0 || std::isnan(dl)) dl = 1;
      dir_x /= dl;
      dir_y /= dl;
      const double kick = 0.5 + hash2(id, s) * 0.8;
      const double jx = (hash2(id, s + 31) - 0.5) * 0.8;
      const double jy = (hash2(id, s + 47) - 0.5) * 0.8;
      const double px = ccx + (dir_x + jx) * t * t * max_fly * kick;
      const double py = ccy + (dir_y + jy) * t * t * max_fly * kick + (gravity / 100) * t * t * h * 0.8;
      const double rot = ((spin * kPi) / 180) * t * (hash2(id, s + 63) - 0.5) * 2;
      const double half = (cell / 2) * 1.4142135623730951;  // Math.SQRT2
      pieces.push_back(Piece{ccx, ccy, px, py, js::cos(rot), js::sin(rot),
                             static_cast<int>(std::max(0.0, std::floor(px - half))),
                             static_cast<int>(std::min(static_cast<double>(w - 1), std::ceil(px + half))),
                             static_cast<int>(std::max(0.0, std::floor(py - half))),
                             static_cast<int>(std::min(static_cast<double>(h - 1), std::ceil(py + half)))});
    }
  }
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  clear(img);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int ya, int yb) {
    for (const Piece& p : pieces) {
      const int y0 = std::max(p.y0, ya);
      const int y1 = std::min(p.y1, yb - 1);
      for (int y = y0; y <= y1; ++y) {
        for (int x = p.x0; x <= p.x1; ++x) {
          const double lx = x + 0.5 - p.px;
          const double ly = y + 0.5 - p.py;
          const double sxl = lx * p.cos_r + ly * p.sin_r;
          const double syl = -lx * p.sin_r + ly * p.cos_r;
          if (std::fabs(sxl) > cell / 2 || std::fabs(syl) > cell / 2) continue;
          const double sxi = round_index(p.ccx + sxl - 0.5);
          const double syi = round_index(p.ccy + syl - 0.5);
          if (sxi < 0 || sxi >= w || syi < 0 || syi >= h) continue;
          const std::uint8_t* sp = src.data() + idx4(static_cast<int>(sxi), static_cast<int>(syi), w);
          if (sp[3] == 0) continue;
          std::uint8_t* o = out + idx4(x, y, w);
          o[0] = sp[0];
          o[1] = sp[1];
          o[2] = sp[2];
          o[3] = u8c(clamp255(sp[3] * fade));
        }
      }
    }
  });
}

void twister(RgbaView img, double completion, double center_y, double twist, ThreadPool* pool) {
  const double t = clamp01(completion / 100);
  if (t <= 0) return;
  if (t >= 1) {
    clear(img);
    return;
  }
  const int w = img.w;
  const int h = img.h;
  const double axis_y = h / 2.0 + center_y;
  const double twist_rad = (twist * kPi) / 180;
  // Per column: the cosine of its tilt (0 = the column has vanished edge-on).
  std::vector<double> col_c(static_cast<std::size_t>(w));
  for (int x = 0; x < w; ++x) {
    const double phase = js::sin((x / std::max(1.0, w - 1.0)) * kPi * 2) * twist_rad * t * 0.5;
    const double ang = t * (kPi / 2) + phase * (1 - t);
    col_c[static_cast<std::size_t>(x)] = js::cos(std::min(kPi / 2, std::max(0.0, ang)));
  }
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  clear(img);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double c = col_c[static_cast<std::size_t>(x)];
        if (c <= 0.02) continue;
        const double v = (y + 0.5 - axis_y) / c;
        const double sy = round_index(axis_y + v - 0.5);
        if (sy < 0 || sy >= h) continue;
        const std::uint8_t* s = src.data() + idx4(x, static_cast<int>(sy), w);
        if (s[3] == 0) continue;
        const double shade = 0.6 + 0.4 * c;
        std::uint8_t* o = out + idx4(x, y, w);
        o[0] = u8c(clamp255(s[0] * shade));
        o[1] = u8c(clamp255(s[1] * shade));
        o[2] = u8c(clamp255(s[2] * shade));
        o[3] = s[3];
      }
    }
  });
}

void card_dance(RgbaView img, double rows, double columns, double amount, double card_rotation, double phase,
                ThreadPool* pool) {
  const double amt = clamp01(amount / 100);
  if (amt <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const int R = static_cast<int>(std::max(1.0, js::round(rows)));
  const int C = static_cast<int>(std::max(1.0, js::round(columns)));
  const double cell_w = static_cast<double>(w) / C;
  const double cell_h = static_cast<double>(h) / R;
  const double max_off = std::min(w, h) * 0.4;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  struct Card {
    double ccx, ccy, px, py, cos_r, sin_r;
    int x0, x1, y0, y1;
  };
  std::vector<Card> cards;
  cards.reserve(static_cast<std::size_t>(R) * static_cast<std::size_t>(C));
  const double half = hypot2(cell_w, cell_h) / 2;
  for (int cy = 0; cy < R; ++cy) {
    for (int cx = 0; cx < C; ++cx) {
      const double ccx = (cx + 0.5) * cell_w;
      const double ccy = (cy + 0.5) * cell_h;
      const double sxi = std::min(static_cast<double>(w - 1), std::max(0.0, round_index(ccx)));
      const double syi = std::min(static_cast<double>(h - 1), std::max(0.0, round_index(ccy)));
      const std::uint8_t* sp = src.data() + idx4(static_cast<int>(sxi), static_cast<int>(syi), w);
      const double lum = luma709(sp[0], sp[1], sp[2]) / 255;
      const double drive = (lum - 0.5) * 2;
      const double wave = js::sin((phase / 100) * kPi * 2 + cx * 0.7 + cy * 0.45);
      const double off_y = -(drive * max_off * amt) - wave * max_off * amt * 0.3;
      const double rot = ((card_rotation * kPi) / 180) * (drive + wave * 0.3) * amt;
      const double px = ccx;
      const double py = ccy + off_y;
      cards.push_back(Card{ccx, ccy, px, py, js::cos(rot), js::sin(rot),
                           static_cast<int>(std::max(0.0, std::floor(px - half))),
                           static_cast<int>(std::min(static_cast<double>(w - 1), std::ceil(px + half))),
                           static_cast<int>(std::max(0.0, std::floor(py - half))),
                           static_cast<int>(std::min(static_cast<double>(h - 1), std::ceil(py + half)))});
    }
  }
  clear(img);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int ya, int yb) {
    for (const Card& c : cards) {
      const int y0 = std::max(c.y0, ya);
      const int y1 = std::min(c.y1, yb - 1);
      for (int y = y0; y <= y1; ++y) {
        for (int x = c.x0; x <= c.x1; ++x) {
          const double lx = x + 0.5 - c.px;
          const double ly = y + 0.5 - c.py;
          const double sxl = lx * c.cos_r + ly * c.sin_r;
          const double syl = -lx * c.sin_r + ly * c.cos_r;
          if (std::fabs(sxl) > cell_w / 2 || std::fabs(syl) > cell_h / 2) continue;
          const double rsx = round_index(c.ccx + sxl - 0.5);
          const double rsy = round_index(c.ccy + syl - 0.5);
          if (rsx < 0 || rsx >= w || rsy < 0 || rsy >= h) continue;
          const std::uint8_t* sp = src.data() + idx4(static_cast<int>(rsx), static_cast<int>(rsy), w);
          if (sp[3] == 0) continue;
          std::uint8_t* o = out + idx4(x, y, w);
          o[0] = sp[0];
          o[1] = sp[1];
          o[2] = sp[2];
          o[3] = sp[3];
        }
      }
    }
  });
}

}  // namespace premation::effects
