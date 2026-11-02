#include "subject_matte.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <fstream>

namespace premation::scene::subject_matte {

namespace {

/// Running min or max over a window of 2r+1 along one line (van Herk / Gil–Werman: O(n) whatever r),
/// the line's ends extended by their own values (a subject touching the frame's edge keeps it).
void minmax_line(std::span<float> line, std::size_t r, bool takeMin, std::vector<float>& pad, std::vector<float>& g, std::vector<float>& h) {
  const std::size_t n = line.size();
  if (n == 0 || r == 0) return;
  const std::size_t k = 2 * r + 1;
  const std::size_t len = (n + 2 * r + k - 1) / k * k;
  pad.resize(len);
  g.resize(len);
  h.resize(len);
  for (std::size_t i = 0; i < len; ++i) pad[i] = line[std::min(n - 1, i >= r ? i - r : 0)];
  const auto op = [takeMin](float a, float b) { return takeMin ? std::min(a, b) : std::max(a, b); };
  for (std::size_t b = 0; b < len; b += k) {
    g[b] = pad[b];
    for (std::size_t i = 1; i < k; ++i) g[b + i] = op(g[b + i - 1], pad[b + i]);
    h[b + k - 1] = pad[b + k - 1];
    for (std::size_t i = k - 1; i-- > 0;) h[b + i] = op(h[b + i + 1], pad[b + i]);
  }
  for (std::size_t j = 0; j < n; ++j) line[j] = op(h[j], g[j + k - 1]);
}

/// A Gaussian of `sigma` along one line, the ends extended — the kernel subject-edge.wgsl
/// evaluates (weights exp(−k² / 2σ²) over ±ceil(3σ), normalised).
void gauss_line(std::span<float> line, double sigma, std::vector<float>& tmp, std::vector<float>& weights) {
  const std::size_t n = line.size();
  if (n == 0 || sigma < kMinGaussSigma) return;
  const auto r = static_cast<std::size_t>(std::ceil(3 * sigma));
  weights.resize(r + 1);
  double wsum = 0;
  for (std::size_t k = 0; k <= r; ++k) {
    weights[k] = static_cast<float>(std::exp(-static_cast<double>(k * k) / (2 * sigma * sigma)));
    wsum += k == 0 ? weights[k] : 2.0 * weights[k];
  }
  const auto inv = static_cast<float>(1.0 / wsum);
  tmp.assign(line.begin(), line.end());
  const auto at = [&](std::ptrdiff_t i) { return tmp[static_cast<std::size_t>(std::clamp<std::ptrdiff_t>(i, 0, static_cast<std::ptrdiff_t>(n) - 1))]; };
  const auto ri = static_cast<std::ptrdiff_t>(r);
  for (std::size_t x = 0; x < n; ++x) {
    const auto xi = static_cast<std::ptrdiff_t>(x);
    float acc = weights[0] * at(xi);
    for (std::ptrdiff_t k = 1; k <= ri; ++k) acc += weights[static_cast<std::size_t>(k)] * (at(xi - k) + at(xi + k));
    line[x] = acc * inv;
  }
}

/// Runs `fn` on every row, then on every column (copied out and back).
template <class Fn>
void separable(std::vector<float>& a, std::uint32_t w, std::uint32_t h, Fn&& fn) {
  for (std::uint32_t y = 0; y < h; ++y) fn(std::span<float>(a.data() + static_cast<std::size_t>(y) * w, w));
  std::vector<float> col(h);
  for (std::uint32_t x = 0; x < w; ++x) {
    for (std::uint32_t y = 0; y < h; ++y) col[y] = a[static_cast<std::size_t>(y) * w + x];
    fn(std::span<float>(col));
    for (std::uint32_t y = 0; y < h; ++y) a[static_cast<std::size_t>(y) * w + x] = col[y];
  }
}

/// The picture's alpha at (x, y) of its own grid, 0–255.
std::uint8_t alpha_px(const Picture& p, std::size_t x, std::size_t y) noexcept {
  const std::size_t i = y * p.width + x;
  if (!p.alpha.empty()) return i < p.alpha.size() ? p.alpha[i] : 0;
  return i * 4 + 3 < p.rgba.size() ? p.rgba[i * 4 + 3] : 0;
}

/// The picture's alpha (0–1) at w × h (nearest sample when its own size differs).
void alpha_of(const Picture& p, std::uint32_t w, std::uint32_t h, std::vector<float>& out) {
  out.assign(static_cast<std::size_t>(w) * h, 0.0f);
  if (p.empty()) return;
  for (std::uint32_t y = 0; y < h; ++y) {
    const std::uint32_t sy = p.height == h ? y : std::min(p.height - 1, static_cast<std::uint32_t>((y + 0.5) * p.height / h));
    for (std::uint32_t x = 0; x < w; ++x) {
      const std::uint32_t sx = p.width == w ? x : std::min(p.width - 1, static_cast<std::uint32_t>((x + 0.5) * p.width / w));
      out[static_cast<std::size_t>(y) * w + x] = static_cast<float>(alpha_px(p, sx, sy)) / 255.0f;
    }
  }
}

}  // namespace

std::vector<EdgePass> edge_plan(double feather, double choke) {
  std::vector<EdgePass> out;
  if (!std::isfinite(feather)) feather = 0;
  if (!std::isfinite(choke)) choke = 0;
  // The choke: whole texels, in windows of at most kMaxMorphRadius (a dilation by r1 then r2 is one by r1 + r2).
  if (auto r = static_cast<long>(std::lround(std::abs(choke))); r > 0) {
    const EdgePass::Kind kind = choke > 0 ? EdgePass::Kind::erode : EdgePass::Kind::dilate;
    const auto step = static_cast<long>(kMaxMorphRadius);
    while (r > 0) {
      const long now = std::min(r, step);
      out.push_back({kind, static_cast<double>(now)});
      r -= now;
    }
  }
  // The feather: sigma = feather / 2, as n equal Gaussians whose variances add up to it.
  if (const double sigma = feather / 2; sigma >= kMinGaussSigma) {
    const auto n = static_cast<std::size_t>(std::max(1.0, std::ceil(sigma * sigma / (kMaxGaussSigma * kMaxGaussSigma))));
    const double each = sigma / std::sqrt(static_cast<double>(n));
    for (std::size_t i = 0; i < n; ++i) out.push_back({EdgePass::Kind::gauss, each});
  }
  return out;
}

void run_pass(std::vector<float>& a, std::uint32_t w, std::uint32_t h, const EdgePass& pass) {
  if (a.size() < static_cast<std::size_t>(w) * h || w == 0 || h == 0) return;
  std::vector<float> pad;
  std::vector<float> g;
  std::vector<float> hh;
  if (pass.kind == EdgePass::Kind::gauss) {
    separable(a, w, h, [&](std::span<float> line) { gauss_line(line, pass.amount, pad, g); });
    return;
  }
  const auto r = static_cast<std::size_t>(std::lround(std::max(0.0, pass.amount)));
  if (r == 0) return;
  const bool shrink = pass.kind == EdgePass::Kind::erode;
  separable(a, w, h, [&](std::span<float> line) { minmax_line(line, r, shrink, pad, g, hh); });
}

float finish_alpha(float v, double contrast, bool invert) noexcept {
  const double k = 1.0 / std::max(0.05, 1.0 - std::clamp(contrast, 0.0, 1.0));
  double x = std::clamp((static_cast<double>(v) - 0.5) * k + 0.5, 0.0, 1.0);
  if (invert) x = 1 - x;
  return static_cast<float>(x);
}

void refine_alpha(std::vector<float>& a, std::uint32_t w, std::uint32_t h, double feather, double choke, double contrast, bool invert) {
  if (a.size() < static_cast<std::size_t>(w) * h || w == 0 || h == 0) return;
  for (const EdgePass& pass : edge_plan(feather, choke)) run_pass(a, w, h, pass);
  const double k = 1.0 / std::max(0.05, 1.0 - std::clamp(contrast, 0.0, 1.0));
  if (k != 1.0 || invert)
    for (float& v : a) v = finish_alpha(v, contrast, invert);
}

std::vector<std::uint8_t> combine(std::span<const Part> parts, std::uint32_t& width, std::uint32_t& height) {
  width = 0;
  height = 0;
  // The first shown part's size; every part hidden, the first one's (a transparent picture of it).
  for (const bool shownOnly : {true, false}) {
    for (const Part& p : parts)
      if ((!shownOnly || !p.hidden) && !p.frame.empty()) {
        width = p.frame.width;
        height = p.frame.height;
        break;
      }
    if (width != 0) break;
  }
  if (width == 0 || height == 0) return {};
  const std::size_t n = static_cast<std::size_t>(width) * height;
  std::vector<float> outA(n, 0.0f);
  std::vector<float> a;
  std::vector<float> nb;
  for (const Part& p : parts) {
    if (p.hidden || p.frame.empty()) continue;
    alpha_of(p.frame, width, height, a);
    if (!p.blend.empty()) {
      // Temporal Smooth: the frame keeps 1 − Σweights, each neighbour its weight.
      const std::vector<float> own = a;
      for (const auto& [pic, wgt] : p.blend) {
        if (!(wgt > 0) || pic.empty()) continue;
        alpha_of(pic, width, height, nb);
        for (std::size_t i = 0; i < n; ++i) a[i] += static_cast<float>(wgt) * (nb[i] - own[i]);
      }
    }
    refine_alpha(a, width, height, p.feather, p.choke, p.contrast, p.invert);
    for (std::size_t i = 0; i < n; ++i) outA[i] = std::max(outA[i], a[i]);
  }
  std::vector<std::uint8_t> out(n * 4, 0);
  for (std::size_t i = 0; i < n; ++i) {  // coverage in every channel: premultiplied white, as the GPU's finishing pass writes
    const auto av = static_cast<std::uint8_t>(std::lround(std::clamp(outA[i], 0.0f, 1.0f) * 255.0f));
    out[i * 4] = av;
    out[i * 4 + 1] = av;
    out[i * 4 + 2] = av;
    out[i * 4 + 3] = av;
  }
  return out;
}

std::vector<std::uint8_t> alpha_plane(std::span<const std::uint8_t> rgba, std::uint32_t w, std::uint32_t h, bool gray) {
  const std::size_t n = static_cast<std::size_t>(w) * h;
  std::vector<std::uint8_t> out(n, 0);
  if (rgba.size() < n * 4) return out;
  const std::size_t channel = gray ? 0 : 3;
  for (std::size_t i = 0; i < n; ++i) out[i] = rgba[i * 4 + channel];
  return out;
}

bool png_bytes_gray(std::span<const std::uint8_t> bytes) noexcept {
  // Signature (8), IHDR length + type (8), width + height (8), bit depth (1), colour type (1).
  if (bytes.size() < 26) return false;
  constexpr std::array<std::uint8_t, 8> kSignature = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
  if (!std::equal(kSignature.begin(), kSignature.end(), bytes.begin())) return false;
  if (bytes[12] != 'I' || bytes[13] != 'H' || bytes[14] != 'D' || bytes[15] != 'R') return false;
  const std::uint8_t colourType = bytes[25];
  return colourType == 0 || colourType == 4;
}

bool png_is_gray(const std::filesystem::path& p) {
  std::array<std::uint8_t, 26> head{};
  std::ifstream f(p, std::ios::binary);
  if (!f.read(reinterpret_cast<char*>(head.data()), static_cast<std::streamsize>(head.size()))) return false;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return png_bytes_gray(head);
}

}  // namespace premation::scene::subject_matte
