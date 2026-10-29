#include "subject_matte.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

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

/// A box of radius r along one line, the ends extended.
void box_line(std::span<float> line, std::size_t r, std::vector<float>& tmp) {
  const std::size_t n = line.size();
  if (n == 0 || r == 0) return;
  tmp.assign(line.begin(), line.end());
  const auto at = [&](std::ptrdiff_t i) { return tmp[static_cast<std::size_t>(std::clamp<std::ptrdiff_t>(i, 0, static_cast<std::ptrdiff_t>(n) - 1))]; };
  const auto ri = static_cast<std::ptrdiff_t>(r);
  double sum = 0;
  for (std::ptrdiff_t i = -ri; i <= ri; ++i) sum += at(i);
  const double inv = 1.0 / static_cast<double>(2 * r + 1);
  for (std::size_t x = 0; x < n; ++x) {
    line[x] = static_cast<float>(sum * inv);
    const auto xi = static_cast<std::ptrdiff_t>(x);
    sum += at(xi + ri + 1) - at(xi - ri);
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

/// The picture's alpha (0–1) at w × h (nearest sample when its own size differs).
void alpha_of(const Picture& p, std::uint32_t w, std::uint32_t h, std::vector<float>& out) {
  out.assign(static_cast<std::size_t>(w) * h, 0.0f);
  if (p.width == 0 || p.height == 0 || p.rgba.size() < static_cast<std::size_t>(p.width) * p.height * 4) return;
  for (std::uint32_t y = 0; y < h; ++y) {
    const std::uint32_t sy = p.height == h ? y : std::min(p.height - 1, static_cast<std::uint32_t>((y + 0.5) * p.height / h));
    for (std::uint32_t x = 0; x < w; ++x) {
      const std::uint32_t sx = p.width == w ? x : std::min(p.width - 1, static_cast<std::uint32_t>((x + 0.5) * p.width / w));
      out[static_cast<std::size_t>(y) * w + x] = p.rgba[(static_cast<std::size_t>(sy) * p.width + sx) * 4 + 3] / 255.0f;
    }
  }
}

}  // namespace

void refine_alpha(std::vector<float>& a, std::uint32_t w, std::uint32_t h, double feather, double choke, double contrast, bool invert) {
  if (a.size() < static_cast<std::size_t>(w) * h || w == 0 || h == 0) return;
  std::vector<float> pad;
  std::vector<float> g;
  std::vector<float> hh;
  if (const auto r = static_cast<std::size_t>(std::lround(std::abs(choke))); r > 0) {
    const bool shrink = choke > 0;
    separable(a, w, h, [&](std::span<float> line) { minmax_line(line, r, shrink, pad, g, hh); });
  }
  if (feather > 0) {
    // A Gaussian of sigma feather/2 as three boxes (each of variance ((2r+1)²−1)/12).
    const double sigma = feather / 2;
    const auto r = static_cast<std::size_t>(std::max(1L, std::lround((std::sqrt(4 * sigma * sigma + 1) - 1) / 2)));
    for (int pass = 0; pass < 3; ++pass) separable(a, w, h, [&](std::span<float> line) { box_line(line, r, pad); });
  }
  const double k = 1.0 / std::max(0.05, 1.0 - std::clamp(contrast, 0.0, 1.0));
  if (k != 1.0 || invert)
    for (float& v : a) {
      double x = std::clamp((v - 0.5) * k + 0.5, 0.0, 1.0);
      if (invert) x = 1 - x;
      v = static_cast<float>(x);
    }
}

std::vector<std::uint8_t> combine(std::span<const Part> parts, std::uint32_t& width, std::uint32_t& height) {
  width = 0;
  height = 0;
  // The first shown part's size; every part hidden, the first one's (a transparent picture of it).
  for (const bool shownOnly : {true, false}) {
    for (const Part& p : parts)
      if ((!shownOnly || !p.hidden) && p.frame.width > 0 && p.frame.height > 0) {
        width = p.frame.width;
        height = p.frame.height;
        break;
      }
    if (width != 0) break;
  }
  if (width == 0 || height == 0) return {};
  const std::size_t n = static_cast<std::size_t>(width) * height;
  std::vector<float> outA(n, 0.0f);
  std::vector<std::uint8_t> out(n * 4, 0);  // straight colour until the end
  std::vector<float> a;
  std::vector<float> nb;
  for (const Part& p : parts) {
    if (p.hidden || p.frame.width == 0) continue;
    alpha_of(p.frame, width, height, a);
    if (!p.blend.empty()) {
      // Temporal Smooth: the frame keeps 1 − Σweights, each neighbour its weight.
      const std::vector<float> own = a;
      for (const auto& [pic, wgt] : p.blend) {
        if (!(wgt > 0)) continue;
        alpha_of(pic, width, height, nb);
        for (std::size_t i = 0; i < n; ++i) a[i] += static_cast<float>(wgt) * (nb[i] - own[i]);
      }
    }
    refine_alpha(a, width, height, p.feather, p.choke, p.contrast, p.invert);
    const bool same = p.frame.width == width && p.frame.height == height;
    for (std::uint32_t y = 0; y < height; ++y)
      for (std::uint32_t x = 0; x < width; ++x) {
        const std::size_t i = static_cast<std::size_t>(y) * width + x;
        if (a[i] <= outA[i]) continue;
        outA[i] = a[i];
        // The subject's own straight colour (none where its stored frame was empty).
        const std::size_t s = same ? i
                                   : static_cast<std::size_t>(std::min(p.frame.height - 1, static_cast<std::uint32_t>((y + 0.5) * p.frame.height / height))) *
                                             p.frame.width +
                                         std::min(p.frame.width - 1, static_cast<std::uint32_t>((x + 0.5) * p.frame.width / width));
        const unsigned sa = p.frame.rgba[s * 4 + 3];
        for (std::size_t c = 0; c < 3; ++c)
          out[i * 4 + c] = sa == 0 ? 0 : static_cast<std::uint8_t>(std::min(255U, (p.frame.rgba[s * 4 + c] * 255U + sa / 2) / sa));
      }
  }
  for (std::size_t i = 0; i < n; ++i) {  // premultiplied, as decoded stills are (scene_textures.cpp image_ref)
    const auto av = static_cast<unsigned>(std::lround(std::clamp(outA[i], 0.0f, 1.0f) * 255.0f));
    out[i * 4 + 3] = static_cast<std::uint8_t>(av);
    for (std::size_t c = 0; c < 3; ++c) {
      const unsigned prod = (out[i * 4 + c] * av) + 128U;
      out[i * 4 + c] = static_cast<std::uint8_t>((prod + (prod >> 8U)) >> 8U);
    }
  }
  return out;
}

}  // namespace premation::scene::subject_matte
