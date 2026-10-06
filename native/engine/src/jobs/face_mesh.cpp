#include "face_mesh.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace premation::jobs::face {

namespace {

constexpr double kPi = 3.14159265358979323846;

double alpha(double cutoff, double dt) {
  const double tau = 1 / (2 * kPi * cutoff);
  return 1 / (1 + tau / dt);
}

}  // namespace

std::vector<float> crop(std::span<const std::uint8_t> rgba, int width, int height, const Roi& roi, bool planar) {
  const auto n = static_cast<std::size_t>(kInput) * static_cast<std::size_t>(kInput);
  std::vector<float> out(n * 3, 0.0f);
  if (width <= 0 || height <= 0 || rgba.size() < static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4) return out;
  const double c = std::cos(roi.angle);
  const double s = std::sin(roi.angle);
  const double k = roi.side / kInput;
  for (int y = 0; y < kInput; ++y) {
    for (int x = 0; x < kInput; ++x) {
      // Crop pixel centre → frame.
      const double u = (x + 0.5 - kInput / 2.0) * k;
      const double v = (y + 0.5 - kInput / 2.0) * k;
      const double fx = roi.centre.x + c * u - s * v - 0.5;
      const double fy = roi.centre.y + s * u + c * v - 0.5;
      const int x0 = static_cast<int>(std::floor(fx));
      const int y0 = static_cast<int>(std::floor(fy));
      const double ax = fx - x0;
      const double ay = fy - y0;
      std::array<double, 3> acc{0, 0, 0};
      for (int dy = 0; dy < 2; ++dy) {
        for (int dx = 0; dx < 2; ++dx) {
          const int px = x0 + dx;
          const int py = y0 + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const double w = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay);
          const std::size_t i = (static_cast<std::size_t>(py) * static_cast<std::size_t>(width) + static_cast<std::size_t>(px)) * 4;
          for (std::size_t ch = 0; ch < 3; ++ch) acc[ch] += w * rgba[i + ch];
        }
      }
      const std::size_t o = static_cast<std::size_t>(y) * static_cast<std::size_t>(kInput) + static_cast<std::size_t>(x);
      for (std::size_t ch = 0; ch < 3; ++ch) {
        const auto v01 = static_cast<float>(acc[ch] / 255.0);
        if (planar) out[ch * n + o] = v01;
        else out[o * 3 + ch] = v01;
      }
    }
  }
  return out;
}

P2 crop_to_frame(const Roi& roi, P2 p) noexcept {
  const double k = roi.side / kInput;
  const double u = (p.x - kInput / 2.0) * k;
  const double v = (p.y - kInput / 2.0) * k;
  const double c = std::cos(roi.angle);
  const double s = std::sin(roi.angle);
  return P2{roi.centre.x + c * u - s * v, roi.centre.y + s * u + c * v};
}

Roi roi_from_outline(std::span<const P2> outline) {
  if (outline.empty()) return Roi{};
  double x0 = outline[0].x;
  double y0 = outline[0].y;
  double x1 = x0;
  double y1 = y0;
  for (const P2& p : outline) {
    x0 = std::min(x0, p.x);
    y0 = std::min(y0, p.y);
    x1 = std::max(x1, p.x);
    y1 = std::max(y1, p.y);
  }
  return Roi{P2{(x0 + x1) / 2, (y0 + y1) / 2}, std::max(x1 - x0, y1 - y0) * 1.25, 0};
}

P2 centre_of(std::span<const P2> lm, std::span<const int> loop) {
  P2 c;
  int n = 0;
  for (const int i : loop) {
    if (i < 0 || static_cast<std::size_t>(i) >= lm.size()) continue;
    c.x += lm[static_cast<std::size_t>(i)].x;
    c.y += lm[static_cast<std::size_t>(i)].y;
    ++n;
  }
  if (n > 0) {
    c.x /= n;
    c.y /= n;
  }
  return c;
}

Roi roi_from_landmarks(std::span<const P2> lm) {
  if (lm.size() < kLandmarks) return Roi{};
  const P2 r = centre_of(lm, kRightEye);
  const P2 l = centre_of(lm, kLeftEye);
  const double angle = std::atan2(l.y - r.y, l.x - r.x);
  // Bounds in the face's own (eye-level) frame, then back.
  const double c = std::cos(-angle);
  const double s = std::sin(-angle);
  double x0 = 1e300;
  double y0 = 1e300;
  double x1 = -1e300;
  double y1 = -1e300;
  for (std::size_t i = 0; i < kLandmarks; ++i) {
    const double u = c * lm[i].x - s * lm[i].y;
    const double v = s * lm[i].x + c * lm[i].y;
    x0 = std::min(x0, u);
    y0 = std::min(y0, v);
    x1 = std::max(x1, u);
    y1 = std::max(y1, v);
  }
  const double cu = (x0 + x1) / 2;
  const double cv = (y0 + y1) / 2;
  const double ci = std::cos(angle);
  const double si = std::sin(angle);
  return Roi{P2{ci * cu - si * cv, si * cu + ci * cv}, std::max(x1 - x0, y1 - y0) * 1.6, angle};
}

std::vector<P2> OneEuro::filter(std::span<const P2> x, double dt) {
  std::vector<P2> out(x.begin(), x.end());
  if (dt <= 0 || prev_.size() != x.size()) {
    prev_ = out;
    dPrev_.assign(x.size(), P2{});
    return out;
  }
  const double ad = alpha(dCutoff_, dt);
  for (std::size_t i = 0; i < x.size(); ++i) {
    const P2 d{(x[i].x - prev_[i].x) / dt, (x[i].y - prev_[i].y) / dt};
    const P2 dh{dPrev_[i].x + ad * (d.x - dPrev_[i].x), dPrev_[i].y + ad * (d.y - dPrev_[i].y)};
    const double speed = std::hypot(dh.x, dh.y);
    const double a = alpha(minCutoff_ + beta_ * speed, dt);
    out[i] = P2{prev_[i].x + a * (x[i].x - prev_[i].x), prev_[i].y + a * (x[i].y - prev_[i].y)};
    dPrev_[i] = dh;
  }
  prev_ = out;
  return out;
}

}  // namespace premation::jobs::face
