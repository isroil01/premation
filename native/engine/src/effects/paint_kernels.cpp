// Port of src/core/effects/strokePaint.ts (the brush dab, the paint buffer,
// Paint Style compositing, polyline walking, the packed mask hand-off) and
// the three effects built on it: pathStroke.ts (Generate ▸ Stroke),
// scribble.ts and writeOnBrush.ts (Write-on, brush form).
//
// The geometry (dab positions, scan-line strands, mask regions) is built on the
// calling thread in the TS's order. The painting splits OUTPUT rows: every
// chunk replays every dab / capsule in order, clipped to its rows, so each
// pixel sees the same paint() sequence as the TS and the Float32 buffer is
// identical on any thread count.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;
constexpr double kInf = std::numeric_limits<double>::infinity();

double hyp(double a, double b) {
  const std::array<double, 2> v{a, b};
  return js::hypot(v);
}

// ── strokePaint.ts ──────────────────────────────────────────────────────────

/// `dabCoverage(d, radius, hardness01)`.
double dab_coverage(double d, double radius, double hardness01) {
  const double r = std::max(0.0, radius);
  if (d >= r + 0.5) return 0;
  const double inner = clamp01(hardness01) * r;
  const double soft = r - inner;
  if (soft < 1) return clamp01(r + 0.5 - d);
  if (d <= inner) return 1;
  if (d >= r) return 0;
  const double t = (d - inner) / soft;
  return 1 - t * t * (3 - 2 * t);
}

/// `PaintBuffer`: Float32 planes, stores rounded to float as the TS's are.
struct PaintBuffer {
  int w;
  int h;
  std::vector<float> a, r, g, b;
  PaintBuffer(int w_, int h_)
      : w(w_), h(h_) {
    const std::size_t n = static_cast<std::size_t>(std::max(0, w_)) * static_cast<std::size_t>(std::max(0, h_));
    a.assign(n, 0.0F);
    r.assign(n, 0.0F);
    g.assign(n, 0.0F);
    b.assign(n, 0.0F);
  }
  void paint(std::size_t i, double coverage, double opacity01, const Rgb& rgb) {
    if (coverage <= 0) return;
    const double na = coverage * opacity01;
    const double oa = a[i];
    if (oa <= 0) {
      r[i] = static_cast<float>(rgb.r);
      g[i] = static_cast<float>(rgb.g);
      b[i] = static_cast<float>(rgb.b);
    } else {
      const double k = clamp01(coverage);
      r[i] = static_cast<float>(static_cast<double>(r[i]) + (rgb.r - static_cast<double>(r[i])) * k);
      g[i] = static_cast<float>(static_cast<double>(g[i]) + (rgb.g - static_cast<double>(g[i])) * k);
      b[i] = static_cast<float>(static_cast<double>(b[i]) + (rgb.b - static_cast<double>(b[i])) * k);
    }
    if (na > oa) a[i] = static_cast<float>(na);
  }
};

struct Dab {
  double x, y, diameter, hardness01, opacity01;
  Rgb rgb;
};

/// `PaintBuffer.stampDab`, only rows [ry0, ry1).
void stamp_dab_rows(PaintBuffer& buf, const Dab& d, int ry0, int ry1) {
  const double rad = std::max(0.25, d.diameter / 2);
  if (d.opacity01 <= 0) return;
  const double fx0 = std::max(0.0, std::floor(d.x - rad - 1));
  const double fx1 = std::min(static_cast<double>(buf.w - 1), std::ceil(d.x + rad + 1));
  const double fy0 = std::max(static_cast<double>(ry0), std::floor(d.y - rad - 1));
  const double fy1 = std::min(static_cast<double>(std::min(buf.h, ry1) - 1), std::ceil(d.y + rad + 1));
  if (!(fx0 <= fx1) || !(fy0 <= fy1)) return;
  const int x0 = static_cast<int>(fx0);
  const int x1 = static_cast<int>(fx1);
  const int y0 = static_cast<int>(fy0);
  const int y1 = static_cast<int>(fy1);
  for (int y = y0; y <= y1; ++y) {
    const double dy = y + 0.5 - d.y;
    for (int x = x0; x <= x1; ++x) {
      const double cov = dab_coverage(hyp(x + 0.5 - d.x, dy), rad, d.hardness01);
      if (cov > 0) {
        buf.paint(static_cast<std::size_t>(y) * static_cast<std::size_t>(buf.w) + static_cast<std::size_t>(x), cov,
                  d.opacity01, d.rgb);
      }
    }
  }
}

/// Every dab in order, rows split over the pool.
void stamp_dabs(PaintBuffer& buf, const std::vector<Dab>& dabs, ThreadPool* pool) {
  if (dabs.empty()) return;
  for_rows(pool, buf.h, [&](int y0, int y1) {
    for (const Dab& d : dabs) stamp_dab_rows(buf, d, y0, y1);
  });
}

/// `compositePaint(src, buf, style, opacity01)`, in place (each output pixel
/// reads only its own source pixel).
void composite_paint(RgbaView img, const PaintBuffer& buf, double style, double opacity01, ThreadPool* pool) {
  const double op = clamp01(opacity01);
  const double mode = js::round(style);
  std::uint8_t* d = img.data.data();
  const int w = img.w;
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::size_t i = static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x);
        std::uint8_t* o = d + i * 4;
        const double pa = static_cast<double>(buf.a[i]) * op;
        if (mode == 1) {
          o[0] = u8c(buf.r[i]);
          o[1] = u8c(buf.g[i]);
          o[2] = u8c(buf.b[i]);
          o[3] = u8c(pa * 255);
          continue;
        }
        if (mode == 2) {
          o[3] = u8c(o[3] * pa);
          continue;
        }
        const double da = o[3] / 255.0;
        if (pa <= 0) continue;
        const double oa = pa + da * (1 - pa);
        o[0] = u8c((buf.r[i] * pa + o[0] * da * (1 - pa)) / oa);
        o[1] = u8c((buf.g[i] * pa + o[1] * da * (1 - pa)) / oa);
        o[2] = u8c((buf.b[i] * pa + o[2] * da * (1 - pa)) / oa);
        o[3] = u8c(oa * 255);
      }
    }
  });
}

/// `polylineLength(pts, closed)`.
double polyline_length(const std::vector<Pt2>& pts, bool closed) {
  const std::size_t n = pts.size();
  if (n < 2) return 0;
  double acc = 0;
  for (std::size_t i = 1; i < n; ++i) acc += hyp(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (closed) acc += hyp(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y);
  return acc;
}

/// `walkPolyline(pts, closed, s0, s1, step, visit)`.
template <class Visit>
void walk_polyline(const std::vector<Pt2>& pts, bool closed, double s0, double s1, double step, Visit&& visit) {
  const std::size_t n = pts.size();
  if (n == 0 || s1 < s0) return;
  if (n == 1) {
    visit(pts[0].x, pts[0].y);
    return;
  }
  const double stride = std::max(1e-3, step);
  const std::size_t seg_count = closed ? n : n - 1;
  double acc = 0;
  double next = s0;
  double last = -kInf;
  double end_x = pts[0].x;
  double end_y = pts[0].y;
  for (std::size_t i = 0; i < seg_count; ++i) {
    const Pt2& a = pts[i];
    const Pt2& b = pts[(i + 1) % n];
    const double len = hyp(b.x - a.x, b.y - a.y);
    while (next <= acc + len && next <= s1) {
      const double f = len > 0 ? (next - acc) / len : 0;
      visit(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
      last = next;
      next += stride;
    }
    if (s1 <= acc + len) {
      const double f = len > 0 ? (s1 - acc) / len : 0;
      end_x = a.x + (b.x - a.x) * f;
      end_y = a.y + (b.y - a.y) * f;
      acc += len;
      break;
    }
    acc += len;
    end_x = b.x;
    end_y = b.y;
  }
  const double end = std::min(s1, acc);
  if (end >= s0 && end - last > stride * 0.25) visit(end_x, end_y);
}

// ── scribble.ts ─────────────────────────────────────────────────────────────

enum MaskMode : std::uint8_t { kNone = 0, kAdd, kSubtract, kIntersect, kLighten, kDarken, kDifference };

/// `hash3(a, b, c)`.
double hash3(double a, double b, double c) {
  const std::int64_t sum = static_cast<std::int64_t>(static_cast<std::int32_t>(static_cast<std::uint32_t>(ji32(a)) * 374761393U)) +
                           static_cast<std::int64_t>(static_cast<std::int32_t>(static_cast<std::uint32_t>(ji32(b)) * 668265263U)) +
                           static_cast<std::int64_t>(static_cast<std::int32_t>(static_cast<std::uint32_t>(ji32(c)) * 1274126177U));
  auto n = static_cast<std::uint32_t>(sum);
  n = (n ^ (n >> 13U)) * 1274126177U;
  n ^= n >> 16U;
  return static_cast<double>(n) / 4294967296.0;
}

/// `wiggleRandom(key, seed, state, smooth)`.
double wiggle_random(double key, double seed, double state, bool smooth) {
  const double s0 = std::floor(state);
  const double v0 = hash3(key, seed, s0) * 2 - 1;
  const double f = state - s0;
  if (!smooth || f <= 0) return v0;
  const double v1 = hash3(key, seed, s0 + 1) * 2 - 1;
  const double u = f * f * (3 - 2 * f);
  return v0 + (v1 - v0) * u;
}

using Mask = std::vector<std::uint8_t>;

/// `fillPolygon(mask, w, h, pts, value)`: nonzero winding at pixel centres.
void fill_polygon(Mask& mask, int w, int h, const std::vector<Pt2>& pts, std::uint8_t value = 1) {
  const std::size_t n = pts.size();
  if (n < 3) return;
  double min_y = kInf;
  double max_y = -kInf;
  for (const Pt2& p : pts) {
    if (p.y < min_y) min_y = p.y;
    if (p.y > max_y) max_y = p.y;
  }
  const double fy0 = std::max(0.0, std::ceil(min_y - 0.5));
  const double fy1 = std::min(static_cast<double>(h - 1), std::floor(max_y - 0.5));
  if (!(fy0 <= fy1)) return;
  std::vector<double> xs;
  std::vector<int> dirs;
  std::vector<std::size_t> order;
  for (int y = static_cast<int>(fy0); y <= static_cast<int>(fy1); ++y) {
    const double yc = y + 0.5;
    xs.clear();
    dirs.clear();
    for (std::size_t i = 0; i < n; ++i) {
      const Pt2& a = pts[i];
      const Pt2& b = pts[(i + 1) % n];
      if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
        xs.push_back(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
        dirs.push_back(b.y > a.y ? 1 : -1);
      }
    }
    if (xs.size() < 2) continue;
    order.resize(xs.size());
    for (std::size_t i = 0; i < xs.size(); ++i) order[i] = i;
    // Array.prototype.sort is stable (V8's TimSort).
    std::stable_sort(order.begin(), order.end(), [&](std::size_t p, std::size_t q) { return xs[p] - xs[q] < 0; });
    int winding = 0;
    double start = 0;
    for (const std::size_t k : order) {
      const int prev = winding;
      winding += dirs[k];
      if (prev == 0 && winding != 0) {
        start = xs[k];
      } else if (prev != 0 && winding == 0) {
        const double xa = std::max(0.0, std::ceil(start - 0.5));
        const double xb = std::min(static_cast<double>(w - 1), std::ceil(xs[k] - 0.5) - 1);
        if (!(xa <= xb)) continue;
        std::uint8_t* row = mask.data() + static_cast<std::size_t>(y) * static_cast<std::size_t>(w);
        for (int x = static_cast<int>(xa); x <= static_cast<int>(xb); ++x) row[x] = value;
      }
    }
  }
}

/// `fillDisc(mask, w, h, cx, cy, r)`.
void fill_disc(Mask& mask, int w, int h, double cx, double cy, double r) {
  if (r <= 0) return;
  const double fy0 = std::max(0.0, std::floor(cy - r));
  const double fy1 = std::min(static_cast<double>(h - 1), std::ceil(cy + r));
  if (!(fy0 <= fy1)) return;
  for (int y = static_cast<int>(fy0); y <= static_cast<int>(fy1); ++y) {
    const double dy = y + 0.5 - cy;
    const double span = r * r - dy * dy;
    if (span < 0) continue;
    const double half = std::sqrt(span);
    const double xa = std::max(0.0, std::ceil(cx - half - 0.5));
    const double xb = std::min(static_cast<double>(w - 1), std::floor(cx + half - 0.5));
    if (!(xa <= xb)) continue;
    for (int x = static_cast<int>(xa); x <= static_cast<int>(xb); ++x) {
      mask[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)] = 1;
    }
  }
}

/// `fan(c, r, a1, a2)`.
std::vector<Pt2> fan(Pt2 c, double r, double a1, double a2) {
  double delta = a2 - a1;
  while (delta > kPi) delta -= kPi * 2;
  while (delta <= -kPi) delta += kPi * 2;
  const double steps = std::max(2.0, std::min(48.0, std::ceil((std::fabs(delta) * r) / 2)));
  std::vector<Pt2> out{c};
  for (int k = 0; k <= static_cast<int>(steps); ++k) {
    const double a = a1 + (delta * k) / steps;
    out.push_back(Pt2{c.x + js::cos(a) * r, c.y + js::sin(a) * r});
  }
  return out;
}

/// `dedupe(pts, closed)`.
std::vector<Pt2> dedupe(const std::vector<Pt2>& pts, bool closed) {
  std::vector<Pt2> out;
  for (const Pt2& p : pts) {
    if (out.empty() || hyp(p.x - out.back().x, p.y - out.back().y) > 1e-6) out.push_back(p);
  }
  if (closed && out.size() > 1) {
    const Pt2& a = out.front();
    const Pt2& b = out.back();
    if (hyp(a.x - b.x, a.y - b.y) <= 1e-6) out.pop_back();
  }
  return out;
}

/// `strokeBand(mask, w, h, raw, closed, hl, hr, cap, join, miterLimit)`.
void stroke_band(Mask& mask, int w, int h, const std::vector<Pt2>& raw, bool closed, double hl, double hr, double cap,
                 double join, double miter_limit) {
  if (hl <= 0 && hr <= 0) return;
  const std::vector<Pt2> pts = dedupe(raw, closed);
  const std::size_t n = pts.size();
  if (n == 1) {
    if (cap == 1) fill_disc(mask, w, h, pts[0].x, pts[0].y, std::max(hl, hr));
    return;
  }
  if (n < 2) return;
  const std::size_t seg_count = closed ? n : n - 1;
  struct Seg {
    Pt2 a, b;
    double tx, ty, nx, ny;
  };
  std::vector<Seg> segs;
  segs.reserve(seg_count);
  for (std::size_t i = 0; i < seg_count; ++i) {
    const Pt2 a = pts[i];
    const Pt2 b = pts[(i + 1) % n];
    const double len = hyp(b.x - a.x, b.y - a.y);
    const double tx = (b.x - a.x) / len;
    const double ty = (b.y - a.y) / len;
    segs.push_back(Seg{a, b, tx, ty, ty, -tx});
  }
  for (const Seg& s : segs) {
    fill_polygon(mask, w, h,
                 {Pt2{s.a.x + s.nx * hl, s.a.y + s.ny * hl}, Pt2{s.b.x + s.nx * hl, s.b.y + s.ny * hl},
                  Pt2{s.b.x - s.nx * hr, s.b.y - s.ny * hr}, Pt2{s.a.x - s.nx * hr, s.a.y - s.ny * hr}});
  }
  const double limit = std::max(1.0, miter_limit);
  const std::size_t first = closed ? 0 : 1;
  const std::size_t last_vertex = closed ? n - 1 : n - 2;
  for (std::size_t i = first; i <= last_vertex; ++i) {
    const Seg& s1 = segs[(i - 1 + seg_count) % seg_count];
    const Seg& s2 = segs[i % seg_count];
    const Pt2 v = pts[i];
    const std::array<std::array<double, 2>, 2> sides{{{1, hl}, {-1, hr}}};
    for (const auto& [side, hw] : sides) {
      if (hw <= 0) continue;
      const double n1x = s1.nx * side;
      const double n1y = s1.ny * side;
      const double n2x = s2.nx * side;
      const double n2y = s2.ny * side;
      if (n1x * s2.tx + n1y * s2.ty >= -1e-9) continue;
      const Pt2 p1{v.x + n1x * hw, v.y + n1y * hw};
      const Pt2 p2{v.x + n2x * hw, v.y + n2y * hw};
      if (join == 1) {
        fill_polygon(mask, w, h, fan(v, hw, js::atan2(n1y, n1x), js::atan2(n2y, n2x)));
        continue;
      }
      if (join == 0) {
        const double mx = n1x + n2x;
        const double my = n1y + n2y;
        const double ml = hyp(mx, my);
        const double cos_half = ml > 1e-9 ? (mx / ml) * n1x + (my / ml) * n1y : 0;
        if (cos_half > 1e-6 && 1 / cos_half <= limit) {
          const double reach = hw / cos_half;
          fill_polygon(mask, w, h, {v, p1, Pt2{v.x + (mx / ml) * reach, v.y + (my / ml) * reach}, p2});
          continue;
        }
      }
      fill_polygon(mask, w, h, {v, p1, p2});
    }
  }
  if (closed || cap == 0) return;
  struct End {
    Pt2 p;
    const Seg* s;
    double ux, uy;
  };
  const std::array<End, 2> ends{End{pts[0], &segs[0], -segs[0].tx, -segs[0].ty},
                                End{pts[n - 1], &segs[seg_count - 1], segs[seg_count - 1].tx, segs[seg_count - 1].ty}};
  for (const End& e : ends) {
    const Pt2 p = e.p;
    const Seg& s = *e.s;
    if (cap == 2) {
      const double ext = (hl + hr) / 2;
      fill_polygon(mask, w, h,
                   {Pt2{p.x + s.nx * hl, p.y + s.ny * hl}, Pt2{p.x + s.nx * hl + e.ux * ext, p.y + s.ny * hl + e.uy * ext},
                    Pt2{p.x - s.nx * hr + e.ux * ext, p.y - s.ny * hr + e.uy * ext},
                    Pt2{p.x - s.nx * hr, p.y - s.ny * hr}});
    } else {
      const double ua = js::atan2(e.uy, e.ux);
      if (hl > 0) fill_polygon(mask, w, h, fan(p, hl, js::atan2(s.ny, s.nx), ua));
      if (hr > 0) fill_polygon(mask, w, h, fan(p, hr, js::atan2(-s.ny, -s.nx), ua));
    }
  }
}

/// `maskFill(m, w, h)`.
Mask mask_fill(const MaskPolyline& m, int w, int h) {
  Mask out(static_cast<std::size_t>(w) * static_cast<std::size_t>(h), 0);
  fill_polygon(out, w, h, m.points);
  if (m.inverted) {
    for (std::uint8_t& v : out) v = v != 0 ? 0 : 1;
  }
  return out;
}

/// `combineMasksByMode(masks, w, h)`.
Mask combine_masks_by_mode(const std::vector<const MaskPolyline*>& masks, int w, int h) {
  Mask acc(static_cast<std::size_t>(w) * static_cast<std::size_t>(h), 0);
  std::vector<const MaskPolyline*> active;
  for (const MaskPolyline* m : masks) {
    if (m->mode != kNone && m->points.size() >= 3) active.push_back(m);
  }
  if (!active.empty()) {
    const int first = active[0]->mode;
    if (first == kSubtract || first == kIntersect || first == kDarken) std::fill(acc.begin(), acc.end(), 1);
  }
  for (const MaskPolyline* m : active) {
    const Mask cov = mask_fill(*m, w, h);
    for (std::size_t i = 0; i < acc.size(); ++i) {
      const bool c = cov[i] != 0;
      switch (m->mode) {
        case kSubtract:
          if (c) acc[i] = 0;
          break;
        case kIntersect:
        case kDarken:
          if (!c) acc[i] = 0;
          break;
        case kDifference:
          if (c) acc[i] = acc[i] != 0 ? 0 : 1;
          break;
        default:
          if (c) acc[i] = 1;
      }
    }
  }
  return acc;
}

/// `scribbleRegion(outlines, inside, w, h, o)`.
Mask scribble_region(const std::vector<const MaskPolyline*>& outlines, Mask inside, int w, int h,
                     const ScribbleOptions& o) {
  const double ft = js::round(o.fill_type);
  if (ft == 0) return inside;
  const double ew = std::max(0.0, o.edge_width);
  Mask band(static_cast<std::size_t>(w) * static_cast<std::size_t>(h), 0);
  for (const MaskPolyline* m : outlines) {
    if (m->points.size() < 2) continue;
    double hl = ew;
    double hr = ew;
    if (ft == 4) {
      hr = 0;
    } else if (ft == 5) {
      hl = 0;
    } else if (ft == 1) {
      hl = ew / 2;
      hr = ew / 2;
    }
    stroke_band(band, w, h, m->points, m->closed, hl, hr, o.end_cap, o.join, o.miter_limit);
  }
  if (ft == 2 || ft == 3) {
    const std::uint8_t want = ft == 2 ? 1 : 0;
    for (std::size_t i = 0; i < band.size(); ++i) {
      if (band[i] != 0 && (inside[i] != 0 ? 1 : 0) != want) band[i] = 0;
    }
  }
  return band;
}

constexpr double kMaxScanLines = 8000;

/// `scribbleStrands(region, w, h, o)`.
std::vector<std::vector<Pt2>> scribble_strands(const Mask& region, int w, int h, const ScribbleOptions& o) {
  double min_x = kInf;
  double min_y = kInf;
  double max_x = -kInf;
  double max_y = -kInf;
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      if (region[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)] == 0) continue;
      if (x < min_x) min_x = x;
      if (x > max_x) max_x = x;
      if (y < min_y) min_y = y;
      if (y > max_y) max_y = y;
    }
  }
  if (min_x > max_x) return {};
  const double rad = (o.angle * kPi) / 180;
  const double dx = js::cos(rad);
  const double dy = 0 - js::sin(rad);
  const double px = 0 - dy;
  const double py = dx;
  const std::array<Pt2, 4> corners{Pt2{min_x, min_y}, Pt2{max_x + 1, min_y}, Pt2{min_x, max_y + 1},
                                   Pt2{max_x + 1, max_y + 1}};
  double cmin = kInf;
  double cmax = -kInf;
  double smin = kInf;
  double smax = -kInf;
  for (const Pt2& c : corners) {
    const double cp = c.x * px + c.y * py;
    const double sp = c.x * dx + c.y * dy;
    if (cp < cmin) cmin = cp;
    if (cp > cmax) cmax = cp;
    if (sp < smin) smin = sp;
    if (sp > smax) smax = sp;
  }
  const double spacing = std::max(std::max(0.5, o.spacing), (cmax - cmin) / kMaxScanLines);
  const double seed = std::floor(o.seed);
  const auto rnd = [&](double key) { return wiggle_random(key, seed, o.wiggle_state, o.smooth_wiggle); };
  const auto inside = [&](double x, double y) {
    const double ix = std::floor(x);
    const double iy = std::floor(y);
    return ix >= 0 && iy >= 0 && ix < w && iy < h &&
           region[static_cast<std::size_t>(iy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(ix)] == 1;
  };

  struct Pass {
    double c, sa, sb, key;
  };
  struct Active {
    std::size_t strand;
    double sa, sb;
  };
  std::vector<std::vector<Pass>> strands;
  std::vector<Active> active;
  const double lines = std::ceil((cmax - cmin) / spacing);
  const double jitter_cap = std::min(std::max(0.0, o.spacing_variation), spacing * 0.45);
  std::vector<std::array<double, 2>> spans;
  std::vector<Active> next;
  std::vector<std::uint8_t> used;
  for (int k = 0; k < lines; ++k) {
    const double c = cmin + spacing * (k + 0.5) + rnd(k * 7919.0 + 5) * jitter_cap;
    spans.clear();
    bool is_open = false;
    double open = 0;
    for (double s = smin; s <= smax + 1; s += 1) {
      const bool hit = inside(px * c + dx * s, py * c + dy * s);
      if (hit && !is_open) {
        open = s;
        is_open = true;
      } else if (!hit && is_open) {
        spans.push_back({open, s});
        is_open = false;
      }
    }
    if (is_open) spans.push_back({open, smax + 1});
    next.clear();
    used.assign(strands.size() + spans.size(), 0);
    for (std::size_t j = 0; j < spans.size(); ++j) {
      const double sa = spans[j][0];
      const double sb = spans[j][1];
      const double key = k * 7919.0 + static_cast<double>(j) * 31;
      const Active* link = nullptr;
      for (const Active& a : active) {
        if (used[a.strand] == 0 && sa < a.sb && sb > a.sa) {
          link = &a;
          break;
        }
      }
      if (link != nullptr) {
        used[link->strand] = 1;
        strands[link->strand].push_back(Pass{c, sa, sb, key});
        next.push_back(Active{link->strand, sa, sb});
      } else {
        strands.push_back({Pass{c, sa, sb, key}});
        next.push_back(Active{strands.size() - 1, sa, sb});
      }
    }
    active.swap(next);
  }

  const auto at = [&](double c, double s) { return Pt2{px * c + dx * s, py * c + dy * s}; };
  std::vector<std::vector<Pt2>> out;
  for (const std::vector<Pass>& passes : strands) {
    std::vector<Pt2> line;
    bool has_prev = false;
    Pt2 prev_p{};
    double prev_ux = 0;
    double prev_uy = 0;
    for (std::size_t j = 0; j < passes.size(); ++j) {
      const Pass& ps = passes[j];
      const bool forward = j % 2 == 0;
      const auto over = [&](double ch) {
        return ((o.path_overlap + rnd(ps.key + ch) * std::max(0.0, o.path_overlap_variation)) / 100) * spacing;
      };
      double s0 = forward ? ps.sa - over(2) : ps.sb + over(2);
      double s1 = forward ? ps.sb + over(3) : ps.sa - over(3);
      if (forward ? s1 < s0 : s1 > s0) {
        const double mid = (ps.sa + ps.sb) / 2;
        s0 = mid;
        s1 = mid;
      }
      const Pt2 start = at(ps.c, s0);
      const Pt2 end = at(ps.c, s1);
      if (has_prev) {
        const double curv =
            clamp01((o.curviness + rnd(ps.key + 1) * std::max(0.0, o.curviness_variation)) / 100);
        if (curv > 0) {
          const double reach = curv * std::max(spacing, hyp(start.x - prev_p.x, start.y - prev_p.y)) * 1.2;
          const Pt2 c1{prev_p.x + prev_ux * reach, prev_p.y + prev_uy * reach};
          const Pt2 c2{start.x + prev_ux * reach, start.y + prev_uy * reach};
          for (int q = 1; q < 8; ++q) {
            const double t = q / 8.0;
            const double u = 1 - t;
            line.push_back(Pt2{u * u * u * prev_p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * start.x,
                               u * u * u * prev_p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * start.y});
          }
        }
      }
      line.push_back(start);
      line.push_back(end);
      const double sign = forward ? 1 : -1;
      has_prev = true;
      prev_p = end;
      prev_ux = dx * sign;
      prev_uy = dy * sign;
    }
    if (line.size() >= 2) out.push_back(std::move(line));
  }
  return out;
}

/// `strokePolyline(buf, pts, width, rgb)`, only rows [ry0, ry1).
void stroke_polyline_rows(PaintBuffer& buf, const std::vector<Pt2>& pts, double width, const Rgb& rgb, int ry0,
                          int ry1) {
  const double half = std::max(0.05, width / 2);
  const double R = half + 0.5;
  const int w = buf.w;
  const int h = std::min(buf.h, ry1);
  for (std::size_t i = 0; i + 1 < pts.size(); ++i) {
    const double ax = pts[i].x;
    const double ay = pts[i].y;
    const double bx = pts[i + 1].x;
    const double by = pts[i + 1].y;
    const double sx = bx - ax;
    const double sy = by - ay;
    const double len2 = sx * sx + sy * sy;
    const double len = std::sqrt(len2);
    const double fy0 = std::max(static_cast<double>(ry0), std::floor(std::min(ay, by) - R));
    const double fy1 = std::min(static_cast<double>(h - 1), std::ceil(std::max(ay, by) + R));
    if (!(fy0 <= fy1)) continue;
    const double xlo = std::min(ax, bx) - R;
    const double xhi = std::max(ax, bx) + R;
    for (int y = static_cast<int>(fy0); y <= static_cast<int>(fy1); ++y) {
      const double yc = y + 0.5;
      double xa = xlo;
      double xb = xhi;
      if (std::fabs(sy) > 1e-6) {
        const double x_at = ax + ((yc - ay) * sx) / sy;
        const double reach = (R * len) / std::fabs(sy);
        xa = std::max(xa, x_at - reach);
        xb = std::min(xb, x_at + reach);
      }
      const double fxs = std::max(0.0, std::floor(xa));
      const double fxe = std::min(static_cast<double>(w - 1), std::ceil(xb));
      if (!(fxs <= fxe)) continue;
      for (int x = static_cast<int>(fxs); x <= static_cast<int>(fxe); ++x) {
        const double pxc = x + 0.5;
        const double t = len2 > 0 ? clamp01(((pxc - ax) * sx + (yc - ay) * sy) / len2) : 0;
        const double d = hyp(pxc - (ax + t * sx), yc - (ay + t * sy));
        const double cov = clamp01(half + 0.5 - d);
        if (cov > 0) {
          buf.paint(static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x), cov, 1,
                    rgb);
        }
      }
    }
  }
}

/// `trimPolyline(pts, s0, s1)`.
std::vector<Pt2> trim_polyline(const std::vector<Pt2>& pts, double s0, double s1) {
  std::vector<Pt2> out;
  if (pts.size() < 2 || s1 <= s0) return out;
  double acc = 0;
  for (std::size_t i = 0; i + 1 < pts.size(); ++i) {
    const Pt2& a = pts[i];
    const Pt2& b = pts[i + 1];
    const double len = hyp(b.x - a.x, b.y - a.y);
    const double lo = std::max(s0, acc);
    const double hi = std::min(s1, acc + len);
    if (hi >= lo && len > 0) {
      const Pt2 pa{a.x + ((b.x - a.x) * (lo - acc)) / len, a.y + ((b.y - a.y) * (lo - acc)) / len};
      const Pt2 pb{a.x + ((b.x - a.x) * (hi - acc)) / len, a.y + ((b.y - a.y) * (hi - acc)) / len};
      if (out.empty()) out.push_back(pa);
      out.push_back(pb);
    }
    acc += len;
    if (acc >= s1) break;
  }
  return out;
}

}  // namespace

std::vector<MaskPolyline> unpack_mask_paths(std::span<const double> meta, std::span<const double> xy, int w, int h) {
  std::vector<MaskPolyline> out;
  std::size_t o = 0;
  for (std::size_t i = 0; i + 4 <= meta.size(); i += 4) {
    const double cf = std::floor(std::isnan(meta[i]) ? 0 : meta[i]);
    const std::size_t count = cf > 0 ? static_cast<std::size_t>(cf) : 0;
    MaskPolyline m;
    for (std::size_t k = 0; k < count; ++k) {
      if (o + k * 2 + 1 < xy.size()) m.points.push_back(Pt2{w / 2.0 + xy[o + k * 2], h / 2.0 + xy[o + k * 2 + 1]});
    }
    o += count * 2;
    m.closed = meta[i + 1] == 1;
    const double mode = std::floor(std::isnan(meta[i + 2]) ? 0 : meta[i + 2]);
    m.mode = mode >= 0 && mode <= 6 ? static_cast<int>(mode) : static_cast<int>(kAdd);
    m.inverted = meta[i + 3] == 1;
    out.push_back(std::move(m));
  }
  return out;
}

std::vector<MaskPolyline> pick_mask_paths(const std::vector<MaskPolyline>& masks, bool all_masks, double pick_index) {
  std::vector<MaskPolyline> out;
  if (all_masks) {
    for (const MaskPolyline& m : masks) {
      if (m.points.size() >= 2) out.push_back(m);
    }
    return out;
  }
  if (pick_index >= 0 && pick_index == std::floor(pick_index) && pick_index < static_cast<double>(masks.size())) {
    const MaskPolyline& m = masks[static_cast<std::size_t>(pick_index)];
    if (m.points.size() >= 2) out.push_back(m);
  }
  return out;
}

void path_stroke(RgbaView img, const std::vector<MaskPolyline>& paths, const PathStrokeOptions& o, ThreadPool* pool) {
  constexpr double kMaxDabs = 200000;
  const double style = js::round(o.paint_style);
  const double opacity = clamp01(o.opacity / 100);
  const double size = std::max(0.0, o.brush_size);
  if (style == 0 && (opacity <= 0 || size <= 0 || paths.empty())) return;
  PaintBuffer buf(img.w, img.h);
  const double lo = clamp01(std::min(o.start, o.end) / 100);
  const double hi = clamp01(std::max(o.start, o.end) / 100);
  std::vector<double> lengths;
  double total = 0;
  for (const MaskPolyline& p : paths) {
    lengths.push_back(polyline_length(p.points, p.closed));
    total += lengths.back();
  }
  std::vector<std::array<double, 2>> ranges;
  double base = 0;
  for (std::size_t i = 0; i < paths.size(); ++i) {
    const double len = lengths[i];
    if (o.sequential) {
      ranges.push_back({std::max(0.0, lo * total - base), std::min(len, hi * total - base)});
    } else {
      ranges.push_back({lo * len, hi * len});
    }
    base += len;
  }
  double drawn = 0;
  for (const auto& [a, b] : ranges) {
    if (b >= a) drawn += b - a;
  }
  const double dab_step = std::max(0.5, (std::max(0.0, o.spacing) / 100) * std::max(0.0, size));
  const double step = std::max(dab_step, drawn / kMaxDabs);
  const double hardness = clamp01(o.hardness / 100);
  std::vector<Dab> dabs;
  if (size > 0) {
    for (std::size_t i = 0; i < paths.size(); ++i) {
      const auto [a, b] = ranges[i];
      if (b <= a || lengths[i] <= 0) continue;
      walk_polyline(paths[i].points, paths[i].closed, a, b, step,
                    [&](double x, double y) { dabs.push_back(Dab{x, y, size, hardness, 1, o.rgb}); });
    }
  }
  stamp_dabs(buf, dabs, pool);
  composite_paint(img, buf, style, opacity, pool);
}

void scribble(RgbaView img, const std::vector<MaskPolyline>& masks, const std::vector<MaskPolyline>& picked,
              const ScribbleOptions& o, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double style = js::round(o.composite);
  const double opacity = clamp01(o.opacity / 100);
  if (style == 0 && opacity <= 0) return;
  PaintBuffer buf(w, h);
  const double mode = js::round(o.mode);
  std::vector<const MaskPolyline*> usable;
  for (const MaskPolyline& m : masks) {
    if (m.points.size() >= 2) usable.push_back(&m);
  }
  std::vector<Mask> regions;
  if (mode == 2) {
    if (!usable.empty()) {
      std::vector<const MaskPolyline*> outlines;
      for (const MaskPolyline* m : usable) {
        if (m->mode != kNone) outlines.push_back(m);
      }
      regions.push_back(scribble_region(outlines, combine_masks_by_mode(usable, w, h), w, h, o));
    }
  } else {
    std::vector<const MaskPolyline*> group;
    if (mode == 1) {
      group = usable;
    } else {
      for (const MaskPolyline& m : picked) {
        if (m.points.size() >= 2) group.push_back(&m);
      }
    }
    for (const MaskPolyline* m : group) regions.push_back(scribble_region({m}, mask_fill(*m, w, h), w, h, o));
  }

  std::vector<std::vector<std::vector<Pt2>>> strands_per_region;
  std::vector<std::vector<double>> lens_per_region;
  std::vector<double> region_totals;
  double grand = 0;
  for (const Mask& r : regions) {
    strands_per_region.push_back(scribble_strands(r, w, h, o));
    std::vector<double> lens;
    double total = 0;
    for (const auto& s : strands_per_region.back()) {
      lens.push_back(polyline_length(s, false));
      total += lens.back();
    }
    lens_per_region.push_back(std::move(lens));
    region_totals.push_back(total);
  }
  for (const double t : region_totals) grand += t;
  const double lo = clamp01(std::min(o.start, o.end) / 100);
  const double hi = clamp01(std::max(o.start, o.end) / 100);

  std::vector<std::vector<Pt2>> strokes;
  double base = 0;
  for (std::size_t ri = 0; ri < strands_per_region.size(); ++ri) {
    const double total = region_totals[ri];
    const double from = o.sequential ? lo * grand - base : lo * total;
    const double to = o.sequential ? hi * grand - base : hi * total;
    double acc = 0;
    for (std::size_t si = 0; si < strands_per_region[ri].size(); ++si) {
      const double len = lens_per_region[ri][si];
      const double a = std::max(0.0, from - acc);
      const double b = std::min(len, to - acc);
      if (b > a) strokes.push_back(trim_polyline(strands_per_region[ri][si], a, b));
      acc += len;
    }
    base += total;
  }
  if (!strokes.empty()) {
    for_rows(pool, h, [&](int y0, int y1) {
      for (const auto& s : strokes) stroke_polyline_rows(buf, s, o.stroke_width, o.rgb, y0, y1);
    });
  }
  composite_paint(img, buf, style, opacity, pool);
}

void write_on_brush(RgbaView img, const WriteOnTrail& trail, const WriteOnBrushOptions& o, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  PaintBuffer buf(w, h);
  const double ptp = js::round(o.paint_time_props);
  const bool per_dab_opacity = ptp == 1;
  const bool per_dab_color = ptp == 2;
  const double bt = js::round(o.brush_time_props);
  const bool per_dab_size = bt == 1 || bt == 3;
  const bool per_dab_hard = bt == 2 || bt == 3;
  struct TrailDab {
    double x, y, size, hard, op, r, g, b;
  };
  const auto at = [](const std::vector<double>& v, std::size_t i, double fb) { return i < v.size() ? v[i] : fb; };
  std::vector<TrailDab> dabs;
  const std::size_t count = trail.xy.size() / 2;
  for (std::size_t i = 0; i < count; ++i) {
    const std::size_t a = i * 5;
    dabs.push_back(TrailDab{w / 2.0 + trail.xy[i * 2], h / 2.0 + trail.xy[i * 2 + 1],
                            per_dab_size ? at(trail.size, i, o.size) : o.size,
                            per_dab_hard ? at(trail.attr, a, o.hardness) : o.hardness,
                            per_dab_opacity ? at(trail.attr, a + 1, o.opacity) : 100,
                            per_dab_color ? at(trail.attr, a + 2, o.rgb.r) : o.rgb.r,
                            per_dab_color ? at(trail.attr, a + 3, o.rgb.g) : o.rgb.g,
                            per_dab_color ? at(trail.attr, a + 4, o.rgb.b) : o.rgb.b});
  }
  if (dabs.empty()) {
    dabs.push_back(TrailDab{w / 2.0 + o.brush_x, h / 2.0 + o.brush_y, o.size, o.hardness, 100, o.rgb.r, o.rgb.g,
                            o.rgb.b});
  }
  std::vector<Dab> stamps;
  const auto stamp = [&](const TrailDab& d) {
    if (d.size <= 0) return;
    stamps.push_back(Dab{d.x, d.y, d.size, clamp01(d.hard / 100), clamp01(d.op / 100), Rgb{d.r, d.g, d.b}});
  };
  for (std::size_t i = 0; i < dabs.size(); ++i) {
    const TrailDab& d = dabs[i];
    stamp(d);
    if (!trail.filled || i + 1 >= dabs.size()) continue;
    const TrailDab& nx = dabs[i + 1];
    const double gap = hyp(nx.x - d.x, nx.y - d.y);
    const double step = std::max(0.5, std::min(d.size, nx.size) * 0.25);
    const double n = std::min(4096.0, std::floor(gap / step));
    for (int k = 1; k < n; ++k) {
      const double f = k / n;
      const auto lerp = [f](double p, double q) { return p + (q - p) * f; };
      stamp(TrailDab{lerp(d.x, nx.x), lerp(d.y, nx.y), lerp(d.size, nx.size), lerp(d.hard, nx.hard),
                     lerp(d.op, nx.op), lerp(d.r, nx.r), lerp(d.g, nx.g), lerp(d.b, nx.b)});
    }
  }
  stamp_dabs(buf, stamps, pool);
  composite_paint(img, buf, o.paint_style, per_dab_opacity ? 1 : clamp01(o.opacity / 100), pool);
}

}  // namespace premation::effects
