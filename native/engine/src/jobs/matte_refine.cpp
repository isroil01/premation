#include "matte_refine.hpp"

#include <algorithm>
#include <array>
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

/// A plane averaged down by an integer factor `f` (each low cell = the mean of its f×f block, the
/// edge blocks of what is there): `dw` × `dh` = ceil(w / f) × ceil(h / f).
template <typename T>
std::vector<T> downsample(const std::vector<T>& v, int w, int h, int f, int& dw, int& dh) {
  dw = (w + f - 1) / f;
  dh = (h + f - 1) / f;
  std::vector<double> sum(px(dw, dh), 0.0);
  std::vector<int> cnt(px(dw, dh), 0);
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      const std::size_t j = at((y / f) * dw + x / f);
      sum[j] += static_cast<double>(v[at(y * w + x)]);
      ++cnt[j];
    }
  std::vector<T> out(sum.size());
  for (std::size_t j = 0; j < out.size(); ++j) out[j] = static_cast<T>(sum[j] / std::max(1, cnt[j]));
  return out;
}

/// A `dw` × `dh` plane (from downsample by `f`) back to w × h, bilinear between block centres.
template <typename T>
std::vector<T> upsample(const std::vector<T>& v, int dw, int dh, int w, int h, int f) {
  std::vector<T> out(px(w, h));
  // Per column: the two low cells and the weight (block centres at (i + 0.5)·f − 0.5).
  std::vector<int> x0s(at(w));
  std::vector<double> txs(at(w));
  for (int x = 0; x < w; ++x) {
    const double fx = std::clamp((x + 0.5) / f - 0.5, 0.0, static_cast<double>(dw - 1));
    x0s[at(x)] = std::min(static_cast<int>(fx), std::max(0, dw - 2));
    txs[at(x)] = dw > 1 ? fx - x0s[at(x)] : 0.0;
  }
  for (int y = 0; y < h; ++y) {
    const double fy = std::clamp((y + 0.5) / f - 0.5, 0.0, static_cast<double>(dh - 1));
    const int y0 = std::min(static_cast<int>(fy), std::max(0, dh - 2));
    const int y1 = std::min(y0 + 1, dh - 1);
    const double ty = dh > 1 ? fy - y0 : 0.0;
    for (int x = 0; x < w; ++x) {
      const int x0 = x0s[at(x)];
      const int x1 = std::min(x0 + 1, dw - 1);
      const double tx = txs[at(x)];
      const double top = static_cast<double>(v[at(y0 * dw + x0)]) * (1 - tx) + static_cast<double>(v[at(y0 * dw + x1)]) * tx;
      const double bot = static_cast<double>(v[at(y1 * dw + x0)]) * (1 - tx) + static_cast<double>(v[at(y1 * dw + x1)]) * tx;
      out[at(y * w + x)] = static_cast<T>(top * (1 - ty) + bot * ty);
    }
  }
  return out;
}

/// Catmull-Rom weights for the fraction t of the way from tap 1 to tap 2.
std::array<double, 4> cubic_weights(double t) {
  const double t2 = t * t;
  const double t3 = t2 * t;
  return {-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2};
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
  // Bicubic (Catmull-Rom) in logit space, pixel centres on cell centres. One logit cell covers
  // 1 / step frame px (10 px of a 2560-wide frame): bilinear made the 0.5 edge a polyline with a
  // corner per cell — the stair-steps along a long edge — and was half a pixel off.
  const double step = scale / (static_cast<double>(sam::kInputSize) / M);
  const auto last = static_cast<std::ptrdiff_t>(M) - 1;
  struct Taps {
    std::array<std::size_t, 4> i{};
    std::array<double, 4> w{};
  };
  auto taps = [&](std::size_t p) {
    const double f = std::clamp((static_cast<double>(p) + 0.5) * step - 0.5, 0.0, static_cast<double>(last));
    const auto i1 = static_cast<std::ptrdiff_t>(std::floor(f));
    Taps t;
    t.w = cubic_weights(f - static_cast<double>(i1));
    for (std::ptrdiff_t k = 0; k < 4; ++k) t.i[static_cast<std::size_t>(k)] = static_cast<std::size_t>(std::clamp<std::ptrdiff_t>(i1 - 1 + k, 0, last));
    return t;
  };
  std::vector<Taps> xs(width);
  for (std::size_t x = 0; x < width; ++x) xs[x] = taps(x);
  std::vector<double> row(M);
  for (std::size_t y = 0; y < height; ++y) {
    const Taps ty = taps(y);
    // The four logit rows blended vertically once per frame row, then each pixel blends four columns.
    for (std::size_t c = 0; c < M; ++c) {
      double v = 0;
      for (std::size_t k = 0; k < 4; ++k) v += ty.w[k] * logits[offset + ty.i[k] * M + c];
      row[c] = v;
    }
    for (std::size_t x = 0; x < width; ++x) {
      const Taps& tx = xs[x];
      const double v = tx.w[0] * row[tx.i[0]] + tx.w[1] * row[tx.i[1]] + tx.w[2] * row[tx.i[2]] + tx.w[3] * row[tx.i[3]];
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
  for (std::size_t i = 0; i < n; ++i) {
    Id[i] = I[i];
    pd[i] = p[i];
  }
  // He & Sun's fast guided filter: the linear coefficients are smooth, so they are solved on
  // a copy subsampled to at most kGuidedEdge px on the long side and upsampled; only the final
  // q = a·I + b runs at full resolution (the edge still follows the full-resolution picture).
  constexpr int kGuidedEdge = 1280;
  const int s = std::max(1, (std::max(width, height) + kGuidedEdge - 1) / kGuidedEdge);
  int lw = width;
  int lh = height;
  const std::vector<double> Il = s > 1 ? downsample(Id, width, height, s, lw, lh) : Id;
  const std::vector<double> pl = s > 1 ? downsample(pd, width, height, s, lw, lh) : pd;
  const int r = std::max(1, static_cast<int>(std::lround(static_cast<double>(radius) / s)));
  const std::size_t ln = px(lw, lh);
  std::vector<double> II(ln);
  std::vector<double> Ip(ln);
  for (std::size_t i = 0; i < ln; ++i) {
    II[i] = Il[i] * Il[i];
    Ip[i] = Il[i] * pl[i];
  }
  const std::vector<double> mI = box_mean(Il, lw, lh, r);
  const std::vector<double> mp = box_mean(pl, lw, lh, r);
  const std::vector<double> mII = box_mean(II, lw, lh, r);
  const std::vector<double> mIp = box_mean(Ip, lw, lh, r);
  std::vector<double> a(ln);
  std::vector<double> b(ln);
  for (std::size_t i = 0; i < ln; ++i) {
    const double varI = mII[i] - mI[i] * mI[i];
    const double cov = mIp[i] - mI[i] * mp[i];
    a[i] = cov / (varI + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  std::vector<double> ma = box_mean(a, lw, lh, r);
  std::vector<double> mb = box_mean(b, lw, lh, r);
  if (s > 1) {
    ma = upsample(ma, lw, lh, width, height, s);
    mb = upsample(mb, lw, lh, width, height, s);
  }
  std::vector<float> out(n);
  for (std::size_t i = 0; i < n; ++i) out[i] = static_cast<float>(std::clamp(ma[i] * Id[i] + mb[i], 0.0, 1.0));
  return out;
}

std::vector<float> guided_filter_rgb(std::span<const float> p, std::span<const std::uint8_t> rgba, int width, int height, int radius, double eps) {
  const std::size_t n = px(width, height);
  if (p.size() < n || rgba.size() < n * 4 || radius <= 0) return std::vector<float>(p.begin(), p.end());
  // He, Sun & Tang's colour guide: q = aᵀ·I + b with a = (Σ + εU)⁻¹ cov(I, p) per window — an
  // edge between two colours of the same brightness (a red shirt on green) is found too. The
  // coefficients are solved on a copy subsampled as guided_filter's are.
  std::array<std::vector<double>, 3> Ic;
  for (auto& c : Ic) c.resize(n);
  std::vector<double> pd(n);
  for (std::size_t i = 0; i < n; ++i) {
    for (std::size_t c = 0; c < 3; ++c) Ic[c][i] = rgba[i * 4 + c] / 255.0;
    pd[i] = p[i];
  }
  constexpr int kGuidedEdge = 1280;
  const int s = std::max(1, (std::max(width, height) + kGuidedEdge - 1) / kGuidedEdge);
  int lw = width;
  int lh = height;
  std::array<std::vector<double>, 3> Il;
  for (std::size_t c = 0; c < 3; ++c) Il[c] = s > 1 ? downsample(Ic[c], width, height, s, lw, lh) : Ic[c];
  const std::vector<double> pl = s > 1 ? downsample(pd, width, height, s, lw, lh) : pd;
  const int r = std::max(1, static_cast<int>(std::lround(static_cast<double>(radius) / s)));
  const std::size_t ln = px(lw, lh);
  std::array<std::vector<double>, 3> mI;
  std::array<std::vector<double>, 3> mIp;
  const std::vector<double> mp = box_mean(pl, lw, lh, r);
  for (std::size_t c = 0; c < 3; ++c) {
    mI[c] = box_mean(Il[c], lw, lh, r);
    std::vector<double> prod(ln);
    for (std::size_t i = 0; i < ln; ++i) prod[i] = Il[c][i] * pl[i];
    mIp[c] = box_mean(prod, lw, lh, r);
  }
  // The six distinct entries of the colour covariance: rr rg rb gg gb bb.
  constexpr std::array<std::pair<std::size_t, std::size_t>, 6> kPairs{{{0, 0}, {0, 1}, {0, 2}, {1, 1}, {1, 2}, {2, 2}}};
  std::array<std::vector<double>, 6> mII;
  for (std::size_t k = 0; k < kPairs.size(); ++k) {
    std::vector<double> prod(ln);
    for (std::size_t i = 0; i < ln; ++i) prod[i] = Il[kPairs[k].first][i] * Il[kPairs[k].second][i];
    mII[k] = box_mean(prod, lw, lh, r);
  }
  std::array<std::vector<double>, 3> a;
  for (auto& c : a) c.resize(ln);
  std::vector<double> b(ln);
  for (std::size_t i = 0; i < ln; ++i) {
    const double rr = mII[0][i] - mI[0][i] * mI[0][i] + eps;
    const double rg = mII[1][i] - mI[0][i] * mI[1][i];
    const double rb = mII[2][i] - mI[0][i] * mI[2][i];
    const double gg = mII[3][i] - mI[1][i] * mI[1][i] + eps;
    const double gb = mII[4][i] - mI[1][i] * mI[2][i];
    const double bb = mII[5][i] - mI[2][i] * mI[2][i] + eps;
    const std::array<double, 3> cov{mIp[0][i] - mI[0][i] * mp[i], mIp[1][i] - mI[1][i] * mp[i], mIp[2][i] - mI[2][i] * mp[i]};
    // The symmetric 3×3 inverse by cofactors (eps keeps it well conditioned).
    const double c00 = gg * bb - gb * gb;
    const double c01 = rb * gb - rg * bb;
    const double c02 = rg * gb - rb * gg;
    const double c11 = rr * bb - rb * rb;
    const double c12 = rb * rg - rr * gb;
    const double c22 = rr * gg - rg * rg;
    const double det = rr * c00 + rg * c01 + rb * c02;
    if (!(std::abs(det) > 1e-18)) {
      a[0][i] = a[1][i] = a[2][i] = 0;
      b[i] = mp[i];
      continue;
    }
    a[0][i] = (c00 * cov[0] + c01 * cov[1] + c02 * cov[2]) / det;
    a[1][i] = (c01 * cov[0] + c11 * cov[1] + c12 * cov[2]) / det;
    a[2][i] = (c02 * cov[0] + c12 * cov[1] + c22 * cov[2]) / det;
    b[i] = mp[i] - a[0][i] * mI[0][i] - a[1][i] * mI[1][i] - a[2][i] * mI[2][i];
  }
  std::array<std::vector<double>, 3> ma;
  for (std::size_t c = 0; c < 3; ++c) {
    ma[c] = box_mean(a[c], lw, lh, r);
    if (s > 1) ma[c] = upsample(ma[c], lw, lh, width, height, s);
  }
  std::vector<double> mb = box_mean(b, lw, lh, r);
  if (s > 1) mb = upsample(mb, lw, lh, width, height, s);
  std::vector<float> out(n);
  for (std::size_t i = 0; i < n; ++i)
    out[i] = static_cast<float>(std::clamp(ma[0][i] * Ic[0][i] + ma[1][i] * Ic[1][i] + ma[2][i] * Ic[2][i] + mb[i], 0.0, 1.0));
  return out;
}

std::vector<float> snap_edge(std::span<const float> alpha, std::span<const std::uint8_t> rgba, int width, int height, int radius) {
  const std::size_t n = px(width, height);
  std::vector<float> out(alpha.begin(), alpha.end());
  if (alpha.size() < n || rgba.size() < n * 4 || radius <= 0 || width < 2 || height < 2) return out;
  // The band: every pixel within `radius` of a 0.5 crossing (a separable max of the crossing marks).
  std::vector<std::uint8_t> mark(n, 0);
  int x0 = width;
  int y0 = height;
  int x1 = -1;
  int y1 = -1;
  for (int y = 0; y < height; ++y)
    for (int x = 0; x < width; ++x) {
      const bool in = alpha[at(y * width + x)] >= 0.5f;
      const bool edge = (x + 1 < width && (alpha[at(y * width + x + 1)] >= 0.5f) != in) || (y + 1 < height && (alpha[at((y + 1) * width + x)] >= 0.5f) != in);
      if (!edge) continue;
      mark[at(y * width + x)] = 1;
      x0 = std::min(x0, x);
      y0 = std::min(y0, y);
      x1 = std::max(x1, x);
      y1 = std::max(y1, y);
    }
  if (x1 < 0) return out;
  // Only the edge's box (and the filter's reach around it) is filtered: a small subject costs little.
  const int pad = 3 * radius + 2;
  const int bx0 = std::max(0, x0 - pad);
  const int by0 = std::max(0, y0 - pad);
  const int bw = std::min(width - 1, x1 + pad) - bx0 + 1;
  const int bh = std::min(height - 1, y1 + pad) - by0 + 1;
  std::vector<float> pc(px(bw, bh));
  std::vector<std::uint8_t> ic(px(bw, bh) * 4);
  std::vector<std::uint8_t> band(px(bw, bh), 0);
  for (int y = 0; y < bh; ++y)
    for (int x = 0; x < bw; ++x) {
      const std::size_t g = at((by0 + y) * width + bx0 + x);
      const std::size_t l = at(y * bw + x);
      pc[l] = alpha[g];
      for (std::size_t c = 0; c < 4; ++c) ic[l * 4 + c] = rgba[g * 4 + c];
      band[l] = mark[g];
    }
  std::vector<std::uint8_t> tmp(band.size(), 0);
  for (int y = 0; y < bh; ++y)  // horizontal max
    for (int x = 0, last = -radius - 1; x < bw; ++x) {
      if (band[at(y * bw + x)] != 0) last = x;
      tmp[at(y * bw + x)] = x - last <= radius ? 1 : 0;
    }
  for (int y = 0; y < bh; ++y)
    for (int x = bw - 1, last = bw + radius + 1; x >= 0; --x) {
      if (band[at(y * bw + x)] != 0) last = x;
      if (last - x <= radius) tmp[at(y * bw + x)] = 1;
    }
  std::fill(band.begin(), band.end(), 0);
  for (int x = 0; x < bw; ++x) {  // vertical max
    for (int y = 0, last = -radius - 1; y < bh; ++y) {
      if (tmp[at(y * bw + x)] != 0) last = y;
      if (y - last <= radius) band[at(y * bw + x)] = 1;
    }
    for (int y = bh - 1, last = bh + radius + 1; y >= 0; --y) {
      if (tmp[at(y * bw + x)] != 0) last = y;
      if (last - y <= radius) band[at(y * bw + x)] = 1;
    }
  }
  // Sample-based matting (Gastal & Oliveira's Shared Matting): from each band pixel, rays in 8
  // directions run out of the band to the first SURE pixel (inside the band the coarse matte is
  // unsure, so a pixel it calls subject may be background); each ray's end is a subject or a
  // background colour sample. The pair (F, B) that best explains the pixel's colour as a mix
  // αF + (1 − α)B gives its alpha — a stripe of the shirt is matched with its own colour, not an
  // average of the stripes. No sample of either side in reach, two sides too alike to tell apart,
  // or no pair that explains the colour: the coarse matte stays.
  constexpr std::array<std::pair<int, int>, 8> kDirs{{{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {1, 1}, {-1, -1}, {1, -1}, {-1, 1}}};
  const int maxSteps = 3 * radius + 2;
  constexpr double kMinContrast = (8.0 / 255) * (8.0 / 255) * 3;
  constexpr double kMaxResidual = (24.0 / 255) * (24.0 / 255) * 3;
  const auto colour = [&](std::size_t l) {
    return std::array<double, 3>{ic[l * 4] / 255.0, ic[l * 4 + 1] / 255.0, ic[l * 4 + 2] / 255.0};
  };
  // Where the colours decide nothing (no sure subject or ground in reach: a head, an ear, a leg
  // thinner than the band), the model's soft value is its CONFIDENCE, not coverage: kept as
  // alpha it showed the subject half see-through. Hardened, as solidify_interior does inside.
  std::vector<float> est = pc;
  for (std::size_t l = 0; l < est.size(); ++l) {
    if (band[l] == 0) continue;
    const float t = std::clamp((pc[l] - 0.2f) / 0.6f, 0.0f, 1.0f);
    est[l] = t * t * (3.0f - 2.0f * t);
  }
  std::vector<std::array<double, 3>> fs;
  std::vector<std::array<double, 3>> bs;
  fs.reserve(kDirs.size() * 2);
  bs.reserve(kDirs.size() * 2);
  for (int y = 0; y < bh; ++y)
    for (int x = 0; x < bw; ++x) {
      const std::size_t l = at(y * bw + x);
      if (band[l] == 0) continue;
      fs.clear();
      bs.clear();
      for (const auto& [dx, dy] : kDirs) {
        for (int s = 1; s <= maxSteps; ++s) {
          const int sx = x + dx * s;
          const int sy = y + dy * s;
          if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) break;
          const std::size_t sl = at(sy * bw + sx);
          if (band[sl] != 0) continue;
          const bool fg = pc[sl] >= 0.5f;
          (fg ? fs : bs).push_back(colour(sl));
          // A second sample half a band further on the same side: a patterned coat (patches,
          // stripes) offers both of its colours, so a light patch is matched with a light one
          // instead of read as a dark patch mixed with the sky.
          const int sx2 = sx + dx * std::max(1, radius / 2);
          const int sy2 = sy + dy * std::max(1, radius / 2);
          if (sx2 >= 0 && sy2 >= 0 && sx2 < bw && sy2 < bh) {
            const std::size_t s2 = at(sy2 * bw + sx2);
            if (band[s2] == 0 && (pc[s2] >= 0.5f) == fg) (fg ? fs : bs).push_back(colour(s2));
          }
          break;
        }
      }
      if (fs.empty() || bs.empty()) continue;
      const std::array<double, 3> I = colour(l);
      double best = std::numeric_limits<double>::infinity();
      double bestAlpha = est[l];
      double bestContrast = 0;
      for (const auto& F : fs)
        for (const auto& B : bs) {
          double dd = 0;
          double dv = 0;
          for (std::size_t c = 0; c < 3; ++c) {
            dd += (F[c] - B[c]) * (F[c] - B[c]);
            dv += (F[c] - B[c]) * (I[c] - B[c]);
          }
          if (dd < kMinContrast) continue;
          const double a = std::clamp(dv / dd, 0.0, 1.0);
          double err = 0;
          for (std::size_t c = 0; c < 3; ++c) {
            const double r = I[c] - (a * F[c] + (1 - a) * B[c]);
            err += r * r;
          }
          if (err < best) {
            best = err;
            bestAlpha = a;
            bestContrast = std::sqrt(dd / 3);
          }
        }
      if (best > kMaxResidual) continue;
      // How far the colours can be trusted over the model: two sides ~20 levels apart (dark jeans
      // on a wall in shadow) are noise-level — the model's edge stays; ~60 levels apart and more,
      // the picture's own edge wins. Between, a blend: no holes where the colours say little.
      const double trust = std::clamp((bestContrast * 255 - 20) / 40, 0.0, 1.0);
      const double tw = trust * trust * (3 - 2 * trust);
      est[l] = static_cast<float>(est[l] + tw * (bestAlpha - est[l]));
    }
  // Texture noise in the estimate smoothed, the picture's edge kept: a small joint-bilateral filter
  // (weights from distance and colour likeness) over the BAND pixels only. A colour guided filter
  // over the subject's whole box did the same at 172 ms a 1080p frame; this is a few ms.
  const int k = std::max(1, radius / 3);
  const double sigmaS2 = 2.0 * std::max(0.5, k / 2.0) * std::max(0.5, k / 2.0);
  constexpr double kSigmaC2 = 2.0 * 0.08 * 0.08;
  for (int y = 0; y < bh; ++y)
    for (int x = 0; x < bw; ++x) {
      const std::size_t l = at(y * bw + x);
      if (band[l] == 0) continue;
      const std::array<double, 3> I = colour(l);
      double sum = 0;
      double wsum = 0;
      for (int dy = -k; dy <= k; ++dy) {
        const int yy = y + dy;
        if (yy < 0 || yy >= bh) continue;
        for (int dx = -k; dx <= k; ++dx) {
          const int xx = x + dx;
          if (xx < 0 || xx >= bw) continue;
          const std::size_t nb = at(yy * bw + xx);
          const std::array<double, 3> J = colour(nb);
          const double dc = (I[0] - J[0]) * (I[0] - J[0]) + (I[1] - J[1]) * (I[1] - J[1]) + (I[2] - J[2]) * (I[2] - J[2]);
          const double w = std::exp(-(dx * dx + dy * dy) / sigmaS2 - dc / kSigmaC2);
          sum += w * est[nb];
          wsum += w;
        }
      }
      out[at((by0 + y) * width + bx0 + x)] = static_cast<float>(std::clamp(sum / std::max(1e-12, wsum), 0.0, 1.0));
    }
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
  // The background estimate is a wide blur (σ 18 px at 1440 rows: 109 taps a pass at full size,
  // seconds a frame). Blurred at 1/f size with σ/f ≥ 3 and upsampled it is the same smooth
  // field for a fraction of the work.
  const int f = std::max(1, static_cast<int>(std::floor(sigma / 3.0)));
  auto blur = [&](std::vector<float>& plane) {
    if (f == 1) {
      gaussian(plane, width, height, sigma);
      return;
    }
    int dw = 0;
    int dh = 0;
    std::vector<float> low = downsample(plane, width, height, f, dw, dh);
    gaussian(low, dw, dh, sigma / f);
    plane = upsample(low, dw, dh, width, height, f);
  };
  blur(wgt);
  for (std::size_t c = 0; c < 3; ++c) {
    std::vector<float> ch(n);
    for (std::size_t i = 0; i < n; ++i) ch[i] = bg[i * 3 + c];
    blur(ch);
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
  // Background: just outside, around the subject (a ring at ~6–10 % of its size). The march
  // starts from the DEEPEST interior point, not the box's centre: a C-shaped subject's box
  // centre lies in its mouth, and a march from there met "outside" at once — a negative point
  // in the subject's own concavity, a hand's width from its edge.
  std::vector<std::uint8_t> out(n);
  for (std::size_t i = 0; i < n; ++i) out[i] = in[i] ? 0 : 1;
  const std::vector<float> dout = distance_inside(out, width, height);
  const double ring = std::max(6.0, std::max(x1 - x0, y1 - y0) * 0.08);
  double cx = (x0 + x1) / 2;
  double cy = (y0 + y1) / 2;
  if (!cand.empty()) {
    cx = cand.front().second % width + 0.5;
    cy = cand.front().second / width + 0.5;
  }
  int added = 0;
  for (int k = 0; k < 16 && added < maxBg; ++k) {
    const double ang = (k * 4 % 16) * 3.14159265358979323846 / 8;  // spread the first picks around
    // March outward from the deep point along the angle to the first pixel `ring` px outside.
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

Seeds seeds_from_matte_fast(std::span<const float> alpha, int width, int height, int maxEdge, int maxFg, int maxBg) {
  const int edge = std::max(width, height);
  if (edge <= maxEdge || maxEdge <= 0 || width <= 0 || height <= 0) return seeds_from_matte(alpha, width, height, maxFg, maxBg);
  // Box-filter the matte down (2×2, 3×3, … cells averaged: a pixel's share of the subject), seed
  // there, and scale the points and the box back up. A seed is a prompt the model reads on its
  // own 64² grid: a quarter-pixel of placement is nothing to it.
  const int k = (edge + maxEdge - 1) / maxEdge;
  const int sw = std::max(1, (width + k - 1) / k);
  const int sh = std::max(1, (height + k - 1) / k);
  std::vector<float> small(px(sw, sh), 0.0f);
  for (int sy = 0; sy < sh; ++sy)
    for (int sx = 0; sx < sw; ++sx) {
      double sum = 0;
      int cnt = 0;
      for (int y = sy * k; y < std::min(height, (sy + 1) * k); ++y)
        for (int x = sx * k; x < std::min(width, (sx + 1) * k); ++x) {
          sum += alpha[at(y * width + x)];
          ++cnt;
        }
      small[at(sy * sw + sx)] = cnt > 0 ? static_cast<float>(sum / cnt) : 0.0f;
    }
  Seeds s = seeds_from_matte(small, sw, sh, maxFg, maxBg);
  if (s.empty) return s;
  const double f = k;
  for (sam::Point& p : s.points) {
    p.x = std::clamp(p.x * f, 0.0, width - 0.5);
    p.y = std::clamp(p.y * f, 0.0, height - 0.5);
  }
  s.box = sam::Box{s.box.x0 * f, s.box.y0 * f, std::min(static_cast<double>(width), s.box.x1 * f), std::min(static_cast<double>(height), s.box.y1 * f)};
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
