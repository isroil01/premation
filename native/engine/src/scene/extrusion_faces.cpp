#include "extrusion_faces.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>

#include "jsmath.hpp"

namespace premation::scene::extrude {

namespace {

namespace mjs = motion::js;
namespace xf = motion::xf;

constexpr double kDeg = std::numbers::pi / 180;  // Math.PI / 180

double hypot2(double a, double b) {
  const std::array<double, 2> v = {a, b};
  return mjs::hypot(v);
}

Face face(double px, double py, double pz, double rxDeg, double ryDeg, double rzDeg, double w, double h, bool back,
          std::string suffix) {
  Face f;
  f.m = xf::compose(xf::Parts3D{.position = {px, py, pz},
                                .rotation = {rxDeg * kDeg, ryDeg * kDeg, rzDeg * kDeg},
                                .scale = {1, 1, 1},
                                .anchor = {0, 0, 0}});
  f.w = w;
  f.h = h;
  f.back = back;
  f.suffix = std::move(suffix);
  return f;
}

struct P2 {
  double x = 0, y = 0;
};

/// roundedRectOutline(w, h, r, arcSegments), with a radius per corner
/// (TL, TR, BR, BL — extrude_mesh.hpp `rect_outline`'s order). Equal radii
/// trace exactly the uniform outline.
std::vector<P2> rounded_rect_outline(double w, double h, const std::array<double, 4>& r, double arcSegments) {
  const double a = w / 2;
  const double b = h / 2;
  std::vector<P2> pts;
  const int n = static_cast<int>(std::max(1.0, std::floor(arcSegments)));
  struct Corner {
    double sx, sy, from, r;
  };
  auto clampR = [&](double v) { return std::max(0.0, std::min({v, a, b})); };
  // Walked from +x+y (BR) the way the uniform outline is.
  const std::array<Corner, 4> corners = {Corner{1, 1, 0, clampR(r[2])}, Corner{-1, 1, 90, clampR(r[3])},
                                         Corner{-1, -1, 180, clampR(r[0])}, Corner{1, -1, 270, clampR(r[1])}};
  for (const Corner& c : corners) {
    const double cx = c.sx * (a - c.r);
    const double cy = c.sy * (b - c.r);
    if (c.r <= 0) {
      pts.push_back({cx, cy});
      continue;
    }
    for (int i = 0; i <= n; ++i) {
      const double ang = (c.from + ((90.0 * i) / n)) * kDeg;
      pts.push_back({cx + (c.r * mjs::cos(ang)), cy + (c.r * mjs::sin(ang))});
    }
  }
  return pts;
}

}  // namespace

double clamp_bevel(double w, double h, double d, double bevel) {
  if (!(bevel > 0) || !(w > 0) || !(h > 0) || !(d > 0)) return 0;
  return std::min({bevel, w / 2, h / 2, d / 2});
}

std::string_view face_kind_of(const Face& f) {
  if (f.back) return "back";
  return f.suffix.starts_with('c') ? "bevel" : "side";
}

Geometry extrusion_geometry(double w, double h, double d, bool ellipse, double segments, const Options& opts) {
  Geometry g;
  if (!(d > 0) || !(w > 0) || !(h > 0)) return g;
  if (ellipse) {
    g.faces.push_back(face(0, 0, d, 0, 0, 0, w, h, true, "back"));
    const double a = w / 2;
    const double b = h / 2;
    const int n = static_cast<int>(std::max(3.0, std::floor(segments)));
    for (int i = 0; i < n; ++i) {
      const double t0 = (static_cast<double>(i) / n) * std::numbers::pi * 2;
      const double t1 = (static_cast<double>(i + 1) / n) * std::numbers::pi * 2;
      const double x0 = a * mjs::cos(t0);
      const double y0 = b * mjs::sin(t0);
      const double x1 = a * mjs::cos(t1);
      const double y1 = b * mjs::sin(t1);
      const double dx = x1 - x0;
      const double dy = y1 - y0;
      const double len = hypot2(dx, dy);
      if (len < 1e-6) continue;
      const double phi = mjs::atan2(dy, dx) / kDeg;
      g.faces.push_back(face((x0 + x1) / 2, (y0 + y1) / 2, d / 2, 90, 0, phi, len, d, false, "w" + std::to_string(i)));
    }
    return g;  // ellipse bevel is deferred: no chamfer, none reported
  }

  // Rounded rect: extrude the OUTLINE (no bevel — a torus section is not a flat quad).
  std::array<double, 4> radii = opts.cornerRadii.value_or(
      std::array<double, 4>{opts.cornerRadius, opts.cornerRadius, opts.cornerRadius, opts.cornerRadius});
  double cr = 0;
  for (double& v : radii) {
    v = std::max(0.0, std::min(v, std::min(w, h) / 2));
    cr = std::max(cr, v);
  }
  if (cr > 0) {
    g.faces.push_back(face(0, 0, d, 0, 0, 0, w, h, true, "back"));
    const std::vector<P2> outline = rounded_rect_outline(w, h, radii, kRoundedCornerSegments);
    for (std::size_t i = 0; i < outline.size(); ++i) {
      const P2 p0 = outline[i];
      const P2 p1 = outline[(i + 1) % outline.size()];
      const double dx = p1.x - p0.x;
      const double dy = p1.y - p0.y;
      const double len = hypot2(dx, dy);
      if (len < 1e-6) continue;
      const double phi = mjs::atan2(dy, dx) / kDeg;
      g.faces.push_back(face((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, d / 2, 90, 0, phi, len, d, false, "w" + std::to_string(i)));
    }
    return g;
  }

  const int segs = static_cast<int>(std::max(1.0, std::floor(opts.wallSegments)));
  const auto walls = [&](double wd, std::vector<Face>& out) {
    if (segs <= 1) {
      out.push_back(face(+w / 2, 0, d / 2, 0, 90, 0, wd, h, false, "r"));
      out.push_back(face(-w / 2, 0, d / 2, 0, 270, 0, wd, h, false, "l"));
      out.push_back(face(0, -h / 2, d / 2, 90, 0, 0, w, wd, false, "t"));
      out.push_back(face(0, +h / 2, d / 2, 270, 0, 0, w, wd, false, "b"));
      return;
    }
    // Strip i of segs across `total`, [centre, size]; all but the last run long into the next.
    const auto strip = [&](double total, int i) {
      const double s = total / segs;
      const double lo = (-total / 2) + (i * s);
      const double hi = lo + s + (i == segs - 1 ? 0 : s * kSeamOverlap);
      return std::array<double, 2>{(lo + hi) / 2, hi - lo};
    };
    for (int i = 0; i < segs; ++i) {
      const auto [cy, sh] = strip(h, i);
      out.push_back(face(+w / 2, cy, d / 2, 0, 90, 0, wd, sh, false, "r" + std::to_string(i)));
      out.push_back(face(-w / 2, cy, d / 2, 0, 270, 0, wd, sh, false, "l" + std::to_string(i)));
    }
    for (int i = 0; i < segs; ++i) {
      const auto [cx, sw] = strip(w, i);
      out.push_back(face(cx, -h / 2, d / 2, 90, 0, 0, sw, wd, false, "t" + std::to_string(i)));
      out.push_back(face(cx, +h / 2, d / 2, 270, 0, 0, sw, wd, false, "b" + std::to_string(i)));
    }
  };

  const double b = clamp_bevel(w, h, d, opts.bevel);
  if (b <= 0) {
    g.faces.push_back(face(0, 0, d, 0, 0, 0, w, h, true, "back"));
    walls(d, g.faces);
    return g;
  }
  // Bevelled rect: inset caps, walls over z ∈ [b, d−b], two 45° chamfer rings.
  const double iw = w - (2 * b);
  const double ih = h - (2 * b);
  const double wd = d - (2 * b);
  const double L = b * std::numbers::sqrt2;  // Math.SQRT2
  if (iw > 0 && ih > 0) g.faces.push_back(face(0, 0, d, 0, 0, 0, iw, ih, true, "back"));
  if (wd > 0) walls(wd, g.faces);
  g.faces.push_back(face((+w / 2) - (b / 2), 0, b / 2, 0, 135, 0, L, h, false, "cfr"));
  g.faces.push_back(face((-w / 2) + (b / 2), 0, b / 2, 0, 225, 0, L, h, false, "cfl"));
  g.faces.push_back(face(0, (-h / 2) + (b / 2), b / 2, 135, 0, 0, w, L, false, "cft"));
  g.faces.push_back(face(0, (+h / 2) - (b / 2), b / 2, 225, 0, 0, w, L, false, "cfb"));
  g.faces.push_back(face((+w / 2) - (b / 2), 0, d - (b / 2), 0, 45, 0, L, h, false, "cbr"));
  g.faces.push_back(face((-w / 2) + (b / 2), 0, d - (b / 2), 0, 315, 0, L, h, false, "cbl"));
  g.faces.push_back(face(0, (-h / 2) + (b / 2), d - (b / 2), 45, 0, 0, w, L, false, "cbt"));
  g.faces.push_back(face(0, (+h / 2) - (b / 2), d - (b / 2), 315, 0, 0, w, L, false, "cbb"));
  g.bevel = b;
  return g;
}

}  // namespace premation::scene::extrude
