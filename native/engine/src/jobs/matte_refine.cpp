#include "matte_refine.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <utility>

#include "stabilize.hpp"

namespace premation::jobs::matte {

namespace {

std::size_t at(int i) noexcept { return static_cast<std::size_t>(i); }
std::size_t px(int w, int h) noexcept { return static_cast<std::size_t>(w) * static_cast<std::size_t>(h); }

/// Box mean of a plane with radius r (integral image), edges by the in-frame count.
std::vector<double> box_mean(const std::vector<double>& v, int w, int h, int r) {
  std::vector<double> integ(at((w + 1) * (h + 1)), 0.0);
  for (int y = 0; y < h; ++y) {
    double row = 0;
    for (int x = 0; x < w; ++x) {
      row += v[at(y * w + x)];
      integ[at((y + 1) * (w + 1) + x + 1)] = integ[at(y * (w + 1) + x + 1)] + row;
    }
  }
  std::vector<double> out(px(w, h));
  for (int y = 0; y < h; ++y) {
    const int y0 = std::max(0, y - r);
    const int y1 = std::min(h - 1, y + r);
    for (int x = 0; x < w; ++x) {
      const int x0 = std::max(0, x - r);
      const int x1 = std::min(w - 1, x + r);
      const double s = integ[at((y1 + 1) * (w + 1) + x1 + 1)] - integ[at(y0 * (w + 1) + x1 + 1)] - integ[at((y1 + 1) * (w + 1) + x0)] +
                       integ[at(y0 * (w + 1) + x0)];
      out[at(y * w + x)] = s / static_cast<double>((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

/// Separable Gaussian blur of a float plane.
void gaussian(std::vector<float>& a, int w, int h, double sigma) {
  if (!(sigma > 0.3)) return;
  const int r = static_cast<int>(std::ceil(3 * sigma));
  std::vector<double> k(at(2 * r + 1));
  double sum = 0;
  for (int i = -r; i <= r; ++i) {
    k[at(i + r)] = std::exp(-(i * i) / (2 * sigma * sigma));
    sum += k[at(i + r)];
  }
  for (double& v : k) v /= sum;
  std::vector<float> tmp(a.size());
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      double s = 0;
      for (int i = -r; i <= r; ++i) s += k[at(i + r)] * a[at(y * w + std::clamp(x + i, 0, w - 1))];
      tmp[at(y * w + x)] = static_cast<float>(s);
    }
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      double s = 0;
      for (int i = -r; i <= r; ++i) s += k[at(i + r)] * tmp[at(std::clamp(y + i, 0, h - 1) * w + x)];
      a[at(y * w + x)] = static_cast<float>(s);
    }
}

/// Chamfer (3-4) distance to the nearest pixel where `inside(i)` is false, in px.
std::vector<float> distance_inside(const std::vector<std::uint8_t>& in, int w, int h) {
  constexpr float kInf = 1e9f;
  std::vector<float> d(px(w, h));
  for (std::size_t i = 0; i < d.size(); ++i) d[i] = in[i] != 0 ? kInf : 0.0f;
  auto relax = [&](int x, int y, int dx, int dy, float cost) {
    const int nx = x + dx;
    const int ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
    float& v = d[at(y * w + x)];
    v = std::min(v, d[at(ny * w + nx)] + cost);
  };
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      if (d[at(y * w + x)] == 0) continue;
      relax(x, y, -1, 0, 1);
      relax(x, y, 0, -1, 1);
      relax(x, y, -1, -1, 1.4142f);
      relax(x, y, 1, -1, 1.4142f);
    }
  for (int y = h - 1; y >= 0; --y)
    for (int x = w - 1; x >= 0; --x) {
      if (d[at(y * w + x)] == 0) continue;
      relax(x, y, 1, 0, 1);
      relax(x, y, 0, 1, 1);
      relax(x, y, 1, 1, 1.4142f);
      relax(x, y, -1, 1, 1.4142f);
    }
  return d;
}

}  // namespace

std::vector<float> soft_mask(std::span<const float> logits, std::size_t offset, std::uint32_t width, std::uint32_t height, double scale) {
  constexpr std::size_t M = sam::kMaskSize;
  std::vector<float> out(static_cast<std::size_t>(width) * height, 0.0f);
  if (logits.size() < offset + M * M) return out;
  const double step = scale / (static_cast<double>(sam::kInputSize) / M);
  constexpr double kMaxF = static_cast<double>(M) - 1.001;
  for (std::size_t y = 0; y < height; ++y) {
    const double fy = std::min(kMaxF, static_cast<double>(y) * step);
    const auto y0 = static_cast<std::size_t>(std::floor(fy));
    const double ty = fy - static_cast<double>(y0);
    for (std::size_t x = 0; x < width; ++x) {
      const double fx = std::min(kMaxF, static_cast<double>(x) * step);
      const auto x0 = static_cast<std::size_t>(std::floor(fx));
      const double tx = fx - static_cast<double>(x0);
      const double v = logits[offset + y0 * M + x0] * (1 - tx) * (1 - ty) + logits[offset + y0 * M + x0 + 1] * tx * (1 - ty) +
                       logits[offset + (y0 + 1) * M + x0] * (1 - tx) * ty + logits[offset + (y0 + 1) * M + x0 + 1] * tx * ty;
      out[y * width + x] = static_cast<float>(1 / (1 + std::exp(-v)));
    }
  }
  return out;
}

std::vector<float> luma(std::span<const std::uint8_t> rgba, int width, int height) {
  std::vector<float> out(px(width, height), 0.0f);
  if (rgba.size() < out.size() * 4) return out;
  for (std::size_t i = 0; i < out.size(); ++i) {
    out[i] = static_cast<float>((0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255.0);
  }
  return out;
}

std::vector<float> guided_filter(std::span<const float> p, std::span<const float> I, int width, int height, int radius, double eps) {
  const std::size_t n = px(width, height);
  if (p.size() < n || I.size() < n || radius <= 0) return std::vector<float>(p.begin(), p.end());
  std::vector<double> Id(n);
  std::vector<double> pd(n);
  std::vector<double> II(n);
  std::vector<double> Ip(n);
  for (std::size_t i = 0; i < n; ++i) {
    Id[i] = I[i];
    pd[i] = p[i];
    II[i] = Id[i] * Id[i];
    Ip[i] = Id[i] * pd[i];
  }
  const std::vector<double> mI = box_mean(Id, width, height, radius);
  const std::vector<double> mp = box_mean(pd, width, height, radius);
  const std::vector<double> mII = box_mean(II, width, height, radius);
  const std::vector<double> mIp = box_mean(Ip, width, height, radius);
  std::vector<double> a(n);
  std::vector<double> b(n);
  for (std::size_t i = 0; i < n; ++i) {
    const double varI = mII[i] - mI[i] * mI[i];
    const double cov = mIp[i] - mI[i] * mp[i];
    a[i] = cov / (varI + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const std::vector<double> ma = box_mean(a, width, height, radius);
  const std::vector<double> mb = box_mean(b, width, height, radius);
  std::vector<float> out(n);
  for (std::size_t i = 0; i < n; ++i) out[i] = static_cast<float>(std::clamp(ma[i] * Id[i] + mb[i], 0.0, 1.0));
  return out;
}

void decontaminate(std::span<std::uint8_t> rgba, std::span<const float> alpha, int width, int height, double amount) {
  const std::size_t n = px(width, height);
  if (!(amount > 0) || rgba.size() < n * 4 || alpha.size() < n) return;
  // The background colour near each pixel: a normalised blur of the clearly-background pixels.
  std::vector<float> bg(n * 3, 0.0f);
  std::vector<float> wgt(n, 0.0f);
  for (std::size_t i = 0; i < n; ++i) {
    const float w = alpha[i] < 0.1f ? 1.0f : 0.0f;
    wgt[i] = w;
    for (std::size_t c = 0; c < 3; ++c) bg[i * 3 + c] = w * rgba[i * 4 + c];
  }
  const double sigma = std::max(4.0, std::min(width, height) / 80.0);
  gaussian(wgt, width, height, sigma);
  for (std::size_t c = 0; c < 3; ++c) {
    std::vector<float> ch(n);
    for (std::size_t i = 0; i < n; ++i) ch[i] = bg[i * 3 + c];
    gaussian(ch, width, height, sigma);
    for (std::size_t i = 0; i < n; ++i) bg[i * 3 + c] = ch[i];
  }
  const double k = std::min(1.0, amount);
  for (std::size_t i = 0; i < n; ++i) {
    const double a = alpha[i];
    if (a <= 0.02 || a >= 0.98 || wgt[i] < 1e-4f) continue;
    for (std::size_t c = 0; c < 3; ++c) {
      const double B = bg[i * 3 + c] / wgt[i];
      const double I = rgba[i * 4 + c];
      const double F = std::clamp((I - (1 - a) * B) / a, 0.0, 255.0);
      rgba[i * 4 + c] = static_cast<std::uint8_t>(std::lround(I + k * (F - I)));
    }
  }
}

std::vector<float> warp_by_flow(std::span<const float> prev, const scene::pixmo::FlowField& flow, int width, int height) {
  std::vector<float> out(px(width, height), 0.0f);
  if (prev.size() < out.size()) return out;
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const stabilize::XY d = stabilize::sample_flow(flow, x, y);
      const double sx = std::clamp(x - d.x, 0.0, width - 1.0);
      const double sy = std::clamp(y - d.y, 0.0, height - 1.0);
      const int x0 = static_cast<int>(sx);
      const int y0 = static_cast<int>(sy);
      const int x1 = std::min(width - 1, x0 + 1);
      const int y1 = std::min(height - 1, y0 + 1);
      const double fx = sx - x0;
      const double fy = sy - y0;
      out[at(y * width + x)] = static_cast<float>(prev[at(y0 * width + x0)] * (1 - fx) * (1 - fy) + prev[at(y0 * width + x1)] * fx * (1 - fy) +
                                                  prev[at(y1 * width + x0)] * (1 - fx) * fy + prev[at(y1 * width + x1)] * fx * fy);
    }
  }
  return out;
}

std::vector<float> motion_blur(std::span<const float> alpha, const scene::pixmo::FlowField& flow, int width, int height, double shutterAngle) {
  std::vector<float> out(alpha.begin(), alpha.end());
  const double shutter = std::clamp(shutterAngle, 0.0, 720.0) / 360.0;
  if (shutter <= 0 || alpha.size() < px(width, height)) return out;
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const stabilize::XY d = stabilize::sample_flow(flow, x, y);
      const double len = std::hypot(d.x, d.y) * shutter;
      if (len < 0.75) continue;
      const int taps = std::clamp(static_cast<int>(std::ceil(len)), 2, 24);
      double s = 0;
      for (int k = 0; k < taps; ++k) {
        // Centred on the frame time: half the shutter before, half after.
        const double t = (static_cast<double>(k) / (taps - 1) - 0.5) * shutter;
        const int sx = std::clamp(static_cast<int>(std::lround(x - d.x * t)), 0, width - 1);
        const int sy = std::clamp(static_cast<int>(std::lround(y - d.y * t)), 0, height - 1);
        s += alpha[at(sy * width + sx)];
      }
      out[at(y * width + x)] = static_cast<float>(s / taps);
    }
  }
  return out;
}

void choke_feather(std::vector<float>& alpha, int width, int height, double chokePercent, double featherPx) {
  if (alpha.size() < px(width, height)) return;
  if (chokePercent != 0) {
    // Choke moves the 50 % edge: a levels shift around the midpoint.
    const double c = std::clamp(chokePercent, -100.0, 100.0) / 100.0 * 0.45;
    for (float& a : alpha) a = static_cast<float>(std::clamp((a - 0.5 - c) / (1 - std::abs(c) * 2) + 0.5, 0.0, 1.0));
  }
  gaussian(alpha, width, height, featherPx / 2);
}

Seeds seeds_from_matte(std::span<const float> alpha, int width, int height, int maxFg, int maxBg) {
  Seeds s;
  const std::size_t n = px(width, height);
  if (alpha.size() < n) return s;
  std::vector<std::uint8_t> in(n);
  double x0 = 1e300;
  double y0 = 1e300;
  double x1 = -1e300;
  double y1 = -1e300;
  for (int y = 0; y < height; ++y)
    for (int x = 0; x < width; ++x) {
      const bool v = alpha[at(y * width + x)] >= 0.5f;
      in[at(y * width + x)] = v ? 1 : 0;
      if (!v) continue;
      x0 = std::min(x0, static_cast<double>(x));
      y0 = std::min(y0, static_cast<double>(y));
      x1 = std::max(x1, static_cast<double>(x));
      y1 = std::max(y1, static_cast<double>(y));
    }
  if (x1 < x0) return s;
  s.empty = false;
  s.box = sam::Box{x0, y0, x1 + 1, y1 + 1};
  // Foreground: the deepest interior points, kept apart from each other.
  const std::vector<float> din = distance_inside(in, width, height);
  std::vector<std::pair<float, int>> cand;
  for (std::size_t i = 0; i < n; ++i)
    if (din[i] >= 2) cand.emplace_back(din[i], static_cast<int>(i));
  std::sort(cand.begin(), cand.end(), [](const auto& a, const auto& b) { return a.first > b.first || (a.first == b.first && a.second < b.second); });
  const double spacing = std::max(8.0, std::max(x1 - x0, y1 - y0) / 4);
  for (const auto& [depth, i] : cand) {
    if (static_cast<int>(s.points.size()) >= maxFg) break;
    const double px0 = i % width;
    const double py0 = i / width;
    const bool near = std::any_of(s.points.begin(), s.points.end(), [&](const sam::Point& p) { return std::hypot(p.x - px0, p.y - py0) < spacing; });
    if (!near) s.points.push_back(sam::Point{px0 + 0.5, py0 + 0.5, 1});
  }
  // Background: just outside, around the box (a ring at ~6–10 % of its size).
  std::vector<std::uint8_t> out(n);
  for (std::size_t i = 0; i < n; ++i) out[i] = in[i] ? 0 : 1;
  const std::vector<float> dout = distance_inside(out, width, height);
  const double ring = std::max(6.0, std::max(x1 - x0, y1 - y0) * 0.08);
  const double cx = (x0 + x1) / 2;
  const double cy = (y0 + y1) / 2;
  int added = 0;
  for (int k = 0; k < 16 && added < maxBg; ++k) {
    const double ang = (k * 4 % 16) * 3.14159265358979323846 / 8;  // spread the first picks around
    // March outward from the centre along the angle to the first pixel `ring` px outside.
    for (double r = 0; r < std::hypot(width, height); r += 1) {
      const int x = static_cast<int>(std::lround(cx + r * std::cos(ang)));
      const int y = static_cast<int>(std::lround(cy + r * std::sin(ang)));
      if (x < 0 || y < 0 || x >= width || y >= height) break;
      if (dout[at(y * width + x)] >= ring) {
        s.points.push_back(sam::Point{x + 0.5, y + 0.5, 0});
        ++added;
        break;
      }
    }
  }
  return s;
}

std::vector<std::uint8_t> cutout(std::span<const std::uint8_t> rgba, std::span<const float> alpha, int width, int height) {
  const std::size_t n = px(width, height);
  std::vector<std::uint8_t> out(n * 4, 0);
  if (rgba.size() < n * 4 || alpha.size() < n) return out;
  for (std::size_t i = 0; i < n; ++i) {
    for (std::size_t c = 0; c < 3; ++c) out[i * 4 + c] = rgba[i * 4 + c];
    out[i * 4 + 3] = static_cast<std::uint8_t>(std::lround(std::clamp(alpha[i], 0.0f, 1.0f) * (rgba[i * 4 + 3] / 255.0f) * 255.0f));
  }
  return out;
}

}  // namespace premation::jobs::matte
