// The mask painter: src/core/effects/mask.ts paintMaskMatte + maskPathToPath2D
// (+ expandMaskPoints), ported onto the C++ Canvas2D, with maskFeather.ts's
// variable (per-vertex) feather: hard coverage → signed distance → the ramp
// width of the nearest outline sample.

#include "mask_paint.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>

#include "paint_common.hpp"

namespace premation::raster {
namespace {

using json::Value;

struct MPt {
  double x = 0, y = 0, inX = 0, inY = 0, outX = 0, outY = 0;
};

std::vector<MPt> expand_mask_points(const std::vector<MPt>& points, double expansion) {
  if (expansion == 0 || std::isnan(expansion) || std::fabs(expansion) < 1e-4 || points.size() < 2) return points;
  const std::size_t n = points.size();
  std::vector<MPt> out;
  out.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    const MPt& curr = points[i];
    const MPt& prev = points[(i + n - 1) % n];
    const MPt& next = points[(i + 1) % n];
    double vx1 = curr.x - curr.inX;
    double vy1 = curr.y - curr.inY;
    if (js_hypot(vx1, vy1) < 1e-4) {
      vx1 = curr.x - prev.x;
      vy1 = curr.y - prev.y;
    }
    double l1 = js_hypot(vx1, vy1);
    if (l1 == 0 || std::isnan(l1)) l1 = 1;
    const double nx1 = vy1 / l1;
    const double ny1 = -vx1 / l1;
    double vx2 = curr.outX - curr.x;
    double vy2 = curr.outY - curr.y;
    if (js_hypot(vx2, vy2) < 1e-4) {
      vx2 = next.x - curr.x;
      vy2 = next.y - curr.y;
    }
    double l2 = js_hypot(vx2, vy2);
    if (l2 == 0 || std::isnan(l2)) l2 = 1;
    const double nx2 = vy2 / l2;
    const double ny2 = -vx2 / l2;
    const double nx = (nx1 + nx2) / 2;
    const double ny = (ny1 + ny2) / 2;
    double nLen = js_hypot(nx, ny);
    if (nLen == 0 || std::isnan(nLen)) nLen = 1;
    const double factor = expansion / std::max(0.2, nLen);
    const double dx = nx * factor;
    const double dy = ny * factor;
    out.push_back({curr.x + dx, curr.y + dy, curr.inX + dx, curr.inY + dy, curr.outX + dx, curr.outY + dy});
  }
  return out;
}

std::vector<MPt> mask_points(const Value& path) {
  std::vector<MPt> pts;
  for (const auto& p : path["points"].items()) {
    pts.push_back({p["x"].num(0), p["y"].num(0), p["inX"].num(0), p["inY"].num(0), p["outX"].num(0), p["outY"].num(0)});
  }
  return expand_mask_points(pts, path["expansion"].num(0));
}

std::optional<Path2D> mask_path_to_path2d(const Value& path, double w, double h) {
  const std::vector<MPt> pts = mask_points(path);
  const std::size_t n = pts.size();
  if (n < 2) return std::nullopt;
  const bool closed = path["closed"].truthy();
  const std::size_t last = closed ? n : n - 1;
  Path2D p;
  if (path["inverted"].truthy()) p.rect(-w / 2, -h / 2, w, h);
  p.moveTo(pts[0].x, pts[0].y);
  for (std::size_t i = 0; i < last; ++i) {
    const MPt& a = pts[i];
    const MPt& b = pts[(i + 1) % n];
    p.bezierCurveTo(a.outX, a.outY, b.inX, b.inY, b.x, b.y);
  }
  p.closePath();
  return p;
}

/// maskFeather.ts `featherSamples`: the painted outline (expansion included)
/// flattened to samples carrying the vertex feather lerped along each segment,
/// mapped through `m` (the matte canvas's transform) into device pixels.
std::vector<FeatherSample> feather_samples(const Value& path, const Mat2D& m, double& maxFeather) {
  const std::vector<MPt> pts = mask_points(path);
  std::vector<FeatherSample> out;
  const std::size_t n = pts.size();
  if (n < 2) return out;
  const double base = std::max(0.0, path["feather"].num(0));
  std::vector<double> vf;
  vf.reserve(n);
  for (const auto& p : path["points"].items()) {
    const double v = p["feather"].is_number() ? p["feather"].num() : -1;
    vf.push_back(v >= 0 ? v : base);
  }
  vf.resize(n, base);
  // A feather is a length: it scales with the transform (its mean axis scale).
  const double k = std::sqrt(std::fabs(m.a * m.d - m.b * m.c));
  const std::size_t segs = path["closed"].truthy() ? n : n - 1;
  constexpr int kSteps = 12;
  maxFeather = base * k;
  for (std::size_t i = 0; i < segs; ++i) {
    const MPt& a = pts[i];
    const MPt& b = pts[(i + 1) % n];
    const double f0 = vf[i] * k;
    const double f1 = vf[(i + 1) % n] * k;
    maxFeather = std::max({maxFeather, f0, f1});
    for (int s = 0; s < kSteps; ++s) {
      const double t = static_cast<double>(s) / kSteps;
      const double mt = 1 - t;
      const double x = mt * mt * mt * a.x + 3 * mt * mt * t * a.outX + 3 * mt * t * t * b.inX + t * t * t * b.x;
      const double y = mt * mt * mt * a.y + 3 * mt * mt * t * a.outY + 3 * mt * t * t * b.inY + t * t * t * b.y;
      out.push_back({m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f, f0 + (f1 - f0) * t});
    }
  }
  return out;
}

/// maskFeather.ts `paintVariableFeatherPath`: hard coverage on a scratch
/// canvas with the matte's transform, the ramp, drawn back in device pixels
/// under the path's composite and opacity (already set on `g`). False when no
/// scratch canvas exists; the caller falls back to the uniform blur.
bool paint_variable_feather(Canvas2D& g, const Value& path, const Path2D& p2d) {
  const std::uint32_t W = g.width();
  const std::uint32_t H = g.height();
  if (W == 0 || H == 0) return false;
  std::unique_ptr<Canvas2D> scratch = g.create_canvas(W, H);
  if (!scratch) return false;
  scratch->set_will_read_frequently(true);
  const Mat2D m = g.getTransform();
  scratch->setTransform(m);
  Style white;
  white.color = css::Color{255, 255, 255, 1};
  scratch->setFillStyle(white);
  scratch->fill(p2d, FillRule::evenodd);
  std::vector<std::uint8_t> image = scratch->getImageData(0, 0, W, H);
  const std::size_t count = static_cast<std::size_t>(W) * H;
  if (image.size() < count * 4) return false;
  std::vector<std::uint8_t> coverage(count);
  for (std::size_t i = 0; i < count; ++i) coverage[i] = image[i * 4 + 3];
  double maxFeather = 0;
  const std::vector<FeatherSample> samples = feather_samples(path, m, maxFeather);
  const std::vector<std::uint8_t> alpha =
      variable_feather_alpha(coverage, static_cast<int>(W), static_cast<int>(H), samples, maxFeather);
  for (std::size_t i = 0; i < count; ++i) {
    image[i * 4] = image[i * 4 + 1] = image[i * 4 + 2] = 255;
    image[i * 4 + 3] = alpha[i];
  }
  scratch->setTransform(Mat2D{});
  scratch->clearRect(0, 0, W, H);
  scratch->putImageData(image, W, H, 0, 0);
  g.save();
  g.setTransform(Mat2D{});
  g.drawImage(*scratch, 0, 0, W, H, 0, 0, W, H);
  g.restore();
  return true;
}

std::string_view composite_of(std::string_view mode) {
  if (mode == "subtract") return "destination-out";
  if (mode == "intersect") return "destination-in";
  if (mode == "lighten") return "lighten";
  if (mode == "darken") return "darken";
  if (mode == "difference") return "difference";
  return "source-over";
}

}  // namespace

void paint_mask_matte(Canvas2D& g, const Value& mask, double w, double h, std::vector<std::string>& unsupported) {
  std::vector<const Value*> paths;
  for (const auto& p : mask["paths"].items()) {
    if (p["mode"].str_or("") != "none") paths.push_back(&p);
  }
  Style white;
  white.color = css::Color{255, 255, 255, 1};
  if (paths.empty()) {
    g.setFillStyle(white);
    g.fillRect(-w / 2, -h / 2, w, h);
    return;
  }
  const std::string_view first = (*paths[0])["mode"].str_or("");
  if (first != "add" && first != "lighten" && first != "none") {
    g.setFillStyle(white);
    g.fillRect(-w / 2, -h / 2, w, h);
  }
  for (const Value* path : paths) {
    const auto p = mask_path_to_path2d(*path, w, h);
    if (!p) continue;
    g.save();
    (void)g.setGlobalCompositeOperation(composite_of((*path)["mode"].str_or("")));
    const double op = (*path)["opacity"].is_number() ? (*path)["opacity"].num() : 1;
    g.setGlobalAlpha(op < 0 ? 0 : op > 1 ? 1 : op);
    bool variable = false;
    for (const auto& pt : (*path)["points"].items()) variable = variable || pt["feather"].is_number();
    if (variable) {
      if (paint_variable_feather(g, *path, *p)) {
        g.restore();
        continue;
      }
      // No scratch canvas: the uniform blur stands in, and the frame says so.
      unsupported.emplace_back("variable (per-vertex) mask feather on this canvas (drawn with the uniform feather)");
    }
    const double feather = (*path)["feather"].num(0);
    if (feather > 0) g.setFilter(css::Filter{feather / 2});
    g.setFillStyle(white);
    g.fill(*p, FillRule::evenodd);
    g.restore();
  }
}

std::vector<std::uint8_t> variable_feather_alpha(std::span<const std::uint8_t> coverage, int w, int h,
                                                 std::span<const FeatherSample> samples, double maxFeather) {
  std::vector<std::uint8_t> out(coverage.begin(), coverage.end());
  if (w < 1 || h < 1 || samples.empty() || maxFeather <= 0) return out;
  const auto W = static_cast<std::size_t>(w);
  const std::size_t n = W * static_cast<std::size_t>(h);
  if (coverage.size() < n) return out;

  // ── Signed distance, 3-4 chamfer (units of 1/3 px) over the boundary ──
  constexpr std::int32_t kInf = 0x3fffffff;
  std::vector<std::int32_t> dist(n, kInf);
  auto inside = [&](std::size_t i) { return coverage[i] >= 128; };
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const std::size_t i = static_cast<std::size_t>(y) * W + static_cast<std::size_t>(x);
      const bool c = inside(i);
      if ((x > 0 && inside(i - 1) != c) || (x < w - 1 && inside(i + 1) != c) || (y > 0 && inside(i - W) != c) ||
          (y < h - 1 && inside(i + W) != c)) {
        dist[i] = 0;
      }
    }
  }
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const std::size_t i = static_cast<std::size_t>(y) * W + static_cast<std::size_t>(x);
      std::int32_t d = dist[i];
      if (x > 0) d = std::min(d, dist[i - 1] + 3);
      if (y > 0) {
        d = std::min(d, dist[i - W] + 3);
        if (x > 0) d = std::min(d, dist[i - W - 1] + 4);
        if (x < w - 1) d = std::min(d, dist[i - W + 1] + 4);
      }
      dist[i] = d;
    }
  }
  for (int y = h - 1; y >= 0; --y) {
    for (int x = w - 1; x >= 0; --x) {
      const std::size_t i = static_cast<std::size_t>(y) * W + static_cast<std::size_t>(x);
      std::int32_t d = dist[i];
      if (x < w - 1) d = std::min(d, dist[i + 1] + 3);
      if (y < h - 1) {
        d = std::min(d, dist[i + W] + 3);
        if (x < w - 1) d = std::min(d, dist[i + W + 1] + 4);
        if (x > 0) d = std::min(d, dist[i + W - 1] + 4);
      }
      dist[i] = d;
    }
  }

  // ── Nearest-sample feather width, grid-bucketed ──
  const int cell = std::max(8, static_cast<int>(std::ceil(maxFeather / 2)));
  const int gw = std::max(1, (w + cell - 1) / cell);
  const int gh = std::max(1, (h + cell - 1) / cell);
  std::vector<std::vector<std::size_t>> buckets(static_cast<std::size_t>(gw) * static_cast<std::size_t>(gh));
  auto bucket_of = [&](double v, int g) { return std::min(g - 1, std::max(0, static_cast<int>(std::floor(v / cell)))); };
  for (std::size_t si = 0; si < samples.size(); ++si) {
    const int bx = bucket_of(samples[si].x, gw);
    const int by = bucket_of(samples[si].y, gh);
    buckets[static_cast<std::size_t>(by) * static_cast<std::size_t>(gw) + static_cast<std::size_t>(bx)].push_back(si);
  }
  auto nearest_feather = [&](double x, double y) {
    const int bx = bucket_of(x, gw);
    const int by = bucket_of(y, gh);
    // A nearer sample can hide one ring past the first hit (Chebyshev rings),
    // so scan exactly one ring beyond it.
    double bestD = std::numeric_limits<double>::infinity();
    double best = 0;
    int firstHit = -1;
    const int maxRing = std::max(gw, gh);
    for (int ring = 0; ring < maxRing; ++ring) {
      if (firstHit >= 0 && ring > firstHit + 1) break;
      for (int oy = -ring; oy <= ring; ++oy) {
        for (int ox = -ring; ox <= ring; ++ox) {
          if (std::max(std::abs(ox), std::abs(oy)) != ring) continue;
          const int cx = bx + ox;
          const int cy = by + oy;
          if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) continue;
          for (const std::size_t si : buckets[static_cast<std::size_t>(cy) * static_cast<std::size_t>(gw) + static_cast<std::size_t>(cx)]) {
            if (firstHit < 0) firstHit = ring;
            const double dx = samples[si].x - x;
            const double dy = samples[si].y - y;
            const double d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              best = samples[si].f;
            }
          }
        }
      }
    }
    return best;
  };

  // ── The ramp ──
  const double band = maxFeather / 2 + 1.5;
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const std::size_t i = static_cast<std::size_t>(y) * W + static_cast<std::size_t>(x);
      const double d = static_cast<double>(dist[i]) / 3;
      if (d > band) continue;  // far from the edge: hard coverage stands
      // Pixel centres: the samples are in canvas px where pixel i spans [x, x+1).
      const double wf = nearest_feather(x + 0.5, y + 0.5);
      if (wf < 0.5) continue;  // locally hard: keep the rasterized AA edge
      const double signedD = inside(i) ? d : -d;
      const double u = std::max(0.0, std::min(1.0, signedD / wf + 0.5));
      out[i] = static_cast<std::uint8_t>(std::lround(u * u * (3 - 2 * u) * 255));
    }
  }
  return out;
}

}  // namespace premation::raster
