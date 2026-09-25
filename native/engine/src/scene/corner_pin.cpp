#include "corner_pin.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace premation::scene {
namespace {

constexpr CornerPin kIdentity = {0, 0, 1, 0, 1, 1, 0, 1};

double sign(double v) { return v > 0 ? 1.0 : v < 0 ? -1.0 : v; }  // Math.sign (±0 kept, NaN → NaN)

}  // namespace

bool is_convex_quad(const CornerPin& q) {
  // signedArea (shoelace).
  double s = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    const std::size_t j = (i + 1) % 4;
    s += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1];
  }
  const double area = std::abs(s / 2);
  if (area < 1e-9) return false;
  double sg = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    const std::size_t a = i;
    const std::size_t b = (i + 1) % 4;
    const std::size_t c = (i + 2) % 4;
    const double cross = (q[b * 2] - q[a * 2]) * (q[c * 2 + 1] - q[b * 2 + 1]) - (q[b * 2 + 1] - q[a * 2 + 1]) * (q[c * 2] - q[b * 2]);
    if (std::abs(cross) < 1e-9) return false;
    const double si = sign(cross);
    if (sg == 0) {
      sg = si;
    } else if (si != sg) {
      return false;
    }
  }
  return true;
}

bool is_identity_quad(const CornerPin& q, double eps) {
  for (std::size_t i = 0; i < 8; ++i) {
    if (std::abs(q[i] - kIdentity[i]) > eps) return false;
  }
  return true;
}

std::optional<Mat3> square_to_quad(const CornerPin& q) {
  const double p0x = q[0], p0y = q[1], p1x = q[2], p1y = q[3], p2x = q[4], p2y = q[5], p3x = q[6], p3y = q[7];
  const double dx1 = p1x - p2x;
  const double dx2 = p3x - p2x;
  const double dx3 = p0x - p1x + p2x - p3x;
  const double dy1 = p1y - p2y;
  const double dy2 = p3y - p2y;
  const double dy3 = p0y - p1y + p2y - p3y;
  double a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0;
  if (std::abs(dx3) < 1e-12 && std::abs(dy3) < 1e-12) {
    a = p1x - p0x;
    b = p2x - p1x;
    c = p0x;
    d = p1y - p0y;
    e = p2y - p1y;
    f = p0y;
  } else {
    const double den = dx1 * dy2 - dx2 * dy1;
    if (std::abs(den) < 1e-12) return std::nullopt;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
    a = p1x - p0x + g * p1x;
    b = p3x - p0x + h * p3x;
    c = p0x;
    d = p1y - p0y + g * p1y;
    e = p3y - p0y + h * p3y;
    f = p0y;
  }
  Mat3 m;
  m.m = {static_cast<float>(a), static_cast<float>(d), static_cast<float>(g), static_cast<float>(b), static_cast<float>(e),
         static_cast<float>(h), static_cast<float>(c), static_cast<float>(f), 1.0F};
  return m;
}

std::optional<CornerPin> read_node_corner_pin(const doc::Node& n) {
  const doc::Component* fx = n.comp("fx");
  if (fx == nullptr) return std::nullopt;
  const js::Json& v = fx->props.at("cornerPin");
  if (!v.is_array() || v.arr().size() != 8) return std::nullopt;
  CornerPin pin{};
  for (std::size_t i = 0; i < 8; ++i) {
    const js::Json& e = v.arr()[i];
    if (!e.is_number() || !std::isfinite(e.num())) return std::nullopt;
    pin.at(i) = e.num();
  }
  if (is_identity_quad(pin) || !is_convex_quad(pin)) return std::nullopt;
  return pin;
}

std::optional<ResolvedPin> resolve_corner_pin(const std::optional<CornerPin>& pin, const Mat3& model) {
  if (!pin) return std::nullopt;
  if (is_identity_quad(*pin) || !is_convex_quad(*pin)) return std::nullopt;
  const std::optional<Mat3> h = square_to_quad(*pin);
  if (!h) return std::nullopt;
  ResolvedPin r;
  r.pin = *h;
  r.renderModel = mat3_mul(model, *h);
  constexpr double kInf = std::numeric_limits<double>::infinity();
  double minX = kInf, minY = kInf, maxX = -kInf, maxY = -kInf;
  const auto& m = model.m;
  for (std::size_t i = 0; i < 4; ++i) {
    const double x = (*pin)[i * 2];
    const double y = (*pin)[i * 2 + 1];
    // Mat3.transformPoint: the affine model at the corner (exact pinned world corner).
    const double wx = static_cast<double>(m[0]) * x + static_cast<double>(m[3]) * y + static_cast<double>(m[6]);
    const double wy = static_cast<double>(m[1]) * x + static_cast<double>(m[4]) * y + static_cast<double>(m[7]);
    minX = std::min(minX, wx);
    minY = std::min(minY, wy);
    maxX = std::max(maxX, wx);
    maxY = std::max(maxY, wy);
  }
  r.bounds.x = minX;
  r.bounds.y = minY;
  r.bounds.width = maxX - minX;
  r.bounds.height = maxY - minY;
  return r;
}

void apply_corner_pin(const std::optional<CornerPin>& pin, const Mat3& model, api::Renderable& r) {
  const std::optional<ResolvedPin> p = resolve_corner_pin(pin, model);
  if (!p) return;
  r.model_matrix.assign(p->renderModel.m.begin(), p->renderModel.m.end());
  r.bounds = p->bounds;
  for (api::RenderMotionSample& s : r.motion_samples) {
    Mat3 sm;
    for (std::size_t i = 0; i < 9 && i < s.model_matrix.size(); ++i) sm.m.at(i) = static_cast<float>(s.model_matrix[i]);
    const Mat3 pinned = mat3_mul(sm, p->pin);
    s.model_matrix.assign(pinned.m.begin(), pinned.m.end());
  }
  r.corner_pin.assign(pin->begin(), pin->end());
}

}  // namespace premation::scene
