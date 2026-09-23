// The mask painter: src/core/effects/mask.ts paintMaskMatte + maskPathToPath2D
// (+ expandMaskPoints), ported onto the C++ Canvas2D. Variable (per-vertex)
// feather — maskFeather.ts — is not ported yet and is reported.

#include "mask_paint.hpp"

#include <algorithm>
#include <cmath>

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

std::optional<Path2D> mask_path_to_path2d(const Value& path, double w, double h) {
  std::vector<MPt> pts;
  for (const auto& p : path["points"].items()) {
    pts.push_back({p["x"].num(0), p["y"].num(0), p["inX"].num(0), p["inY"].num(0), p["outX"].num(0), p["outY"].num(0)});
  }
  pts = expand_mask_points(pts, path["expansion"].num(0));
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
    if (variable) unsupported.emplace_back("variable (per-vertex) mask feather (maskFeather.ts)");
    const double feather = (*path)["feather"].num(0);
    if (feather > 0) g.setFilter({feather / 2});
    g.setFillStyle(white);
    g.fill(*p, FillRule::evenodd);
    g.restore();
  }
}

}  // namespace premation::raster
