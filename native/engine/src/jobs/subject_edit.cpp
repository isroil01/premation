#include "subject_edit.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <limits>
#include <vector>

#include "matte_refine.hpp"

namespace premation::jobs::subject {

namespace {

std::size_t at(int i) noexcept { return static_cast<std::size_t>(i); }
std::size_t idx(int x, int y, int w) noexcept { return static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x); }

/// Max filter of a 0/1 plane over a (2r+1)² square, separable.
std::vector<float> dilate(const std::vector<float>& m, int w, int h, int r) {
  std::vector<float> tmp(m.size(), 0.0f);
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      float v = 0;
      for (int i = std::max(0, x - r); i <= std::min(w - 1, x + r) && v < 1; ++i) v = std::max(v, m[idx(i, y, w)]);
      tmp[idx(x, y, w)] = v;
    }
  std::vector<float> out(m.size(), 0.0f);
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      float v = 0;
      for (int i = std::max(0, y - r); i <= std::min(h - 1, y + r) && v < 1; ++i) v = std::max(v, tmp[idx(x, i, w)]);
      out[idx(x, y, w)] = v;
    }
  return out;
}

/// Distance from p to the segment ab.
double seg_dist(Pt p, Pt a, Pt b) noexcept {
  const double dx = b.x - a.x;
  const double dy = b.y - a.y;
  const double len2 = dx * dx + dy * dy;
  double t = len2 > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0.0;
  t = std::clamp(t, 0.0, 1.0);
  return std::hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

}  // namespace

std::vector<Pt> sample_stroke(std::span<const Pt> stroke, std::size_t maxPoints) {
  if (stroke.empty() || maxPoints == 0) return {};
  std::vector<double> cum(stroke.size(), 0.0);
  for (std::size_t i = 1; i < stroke.size(); ++i) cum[i] = cum[i - 1] + std::hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y);
  const double total = cum.back();
  if (total < 2.0 || maxPoints == 1) return {stroke.front()};
  const std::size_t n = std::min(maxPoints, std::max<std::size_t>(2, static_cast<std::size_t>(total / 12.0) + 1));
  std::vector<Pt> out;
  out.reserve(n);
  std::size_t seg = 1;
  for (std::size_t k = 0; k < n; ++k) {
    const double target = total * static_cast<double>(k) / static_cast<double>(n - 1);
    while (seg + 1 < stroke.size() && cum[seg] < target) ++seg;
    const double span = cum[seg] - cum[seg - 1];
    const double t = span > 1e-12 ? std::clamp((target - cum[seg - 1]) / span, 0.0, 1.0) : 0.0;
    out.push_back({stroke[seg - 1].x + t * (stroke[seg].x - stroke[seg - 1].x), stroke[seg - 1].y + t * (stroke[seg].y - stroke[seg - 1].y)});
  }
  return out;
}

std::vector<CandidateScore> score_candidates(std::span<const float> iouScores, std::span<const float> logits, std::span<const sam::Point> prompts,
                                             double scale, std::uint32_t width, std::uint32_t height) {
  const std::size_t plane = static_cast<std::size_t>(sam::kMaskSize) * sam::kMaskSize;
  const std::size_t n = std::min(iouScores.size(), logits.size() / plane);
  std::vector<CandidateScore> c(n);
  const auto at_cell = [&](double v) {
    return static_cast<std::size_t>(std::clamp(std::lround(v * scale / 4.0), 0L, static_cast<long>(sam::kMaskSize - 1)));
  };
  // The frame's own cells in the letterboxed 256² grid (the rest is padding).
  const auto cells = [&](std::uint32_t px) {
    return std::clamp<std::size_t>(static_cast<std::size_t>(std::lround(px * scale / 4.0)), 1, sam::kMaskSize);
  };
  const std::size_t fw = cells(width);
  const std::size_t fh = cells(height);
  for (std::size_t k = 0; k < n; ++k) {
    CandidateScore& q = c[k];
    const float* p0 = logits.data() + k * plane;
    q.iou = static_cast<double>(iouScores[k]);
    std::size_t fg = 0;
    std::size_t fgIn = 0;
    std::size_t bg = 0;
    std::size_t bgIn = 0;
    for (const sam::Point& p : prompts) {
      const bool in = p0[at_cell(p.y) * sam::kMaskSize + at_cell(p.x)] > 0.0f;
      if (p.label == 1) {
        ++fg;
        fgIn += in ? 1 : 0;
      } else {
        ++bg;
        bgIn += in ? 1 : 0;
      }
    }
    q.fgCover = fg > 0 ? static_cast<double>(fgIn) / static_cast<double>(fg) : 1.0;
    q.bgHit = bg > 0 ? static_cast<double>(bgIn) / static_cast<double>(bg) : 0.0;
    std::size_t on = 0;
    for (std::size_t y = 0; y < fh; ++y)
      for (std::size_t x = 0; x < fw; ++x) on += p0[y * sam::kMaskSize + x] > 0.0f ? 1 : 0;
    q.area = static_cast<double>(on) / static_cast<double>(fw * fh);
    std::array<std::size_t, 4> side{};  // top, bottom, left, right
    for (std::size_t x = 0; x < fw; ++x) {
      side[0] += p0[x] > 0.0f ? 1 : 0;
      side[1] += p0[(fh - 1) * sam::kMaskSize + x] > 0.0f ? 1 : 0;
    }
    for (std::size_t y = 0; y < fh; ++y) {
      side[2] += p0[y * sam::kMaskSize] > 0.0f ? 1 : 0;
      side[3] += p0[y * sam::kMaskSize + fw - 1] > 0.0f ? 1 : 0;
    }
    q.border = static_cast<double>(side[0] + side[1] + side[2] + side[3]) / static_cast<double>(2 * (fw + fh));
    for (std::size_t e = 0; e < 4; ++e) q.edges += static_cast<double>(side[e]) > 0.1 * static_cast<double>(e < 2 ? fw : fh) ? 1 : 0;
  }
  return c;
}

std::size_t choose_candidate(std::span<const float> iouScores, std::span<const float> logits, std::span<const sam::Point> prompts, double scale,
                             Intent intent, std::uint32_t width, std::uint32_t height) {
  const std::vector<CandidateScore> c = score_candidates(iouScores, logits, prompts, scale, width, height);
  const std::size_t n = c.size();
  if (n <= 1) return 0;
  double bestIou = -std::numeric_limits<double>::infinity();
  for (const CandidateScore& q : c) bestIou = std::max(bestIou, q.iou);
  std::size_t best = 0;
  double bestScore = -std::numeric_limits<double>::infinity();
  for (std::size_t k = 0; k < n; ++k) {
    // A region along two or more of the frame's edges is the background (a wall, the floor, the sky).
    const double s = c[k].iou + c[k].fgCover - c[k].bgHit - c[k].border - 0.3 * std::max(0, c[k].edges - 1);
    if (s > bestScore) {
      bestScore = s;
      best = k;
    }
  }
  if (intent.loneClick || intent.subtract) {
    // Among the candidates that hold every prompt and that SAM itself rates
    // near its best: a click means the whole object (the largest that is not
    // the background behind it — along three or more of the frame's edges, or
    // over 30 % of it: a wall, the floor; an object the frame cuts on two
    // sides, a bench in a corner, is still an object), a subtract the smallest
    // thing under it. SAM rates a
    // shirt above the person wearing it (0.97 vs 0.84 on a skater), so the
    // margin is wide.
    std::optional<std::size_t> pick;
    for (std::size_t k = 0; k < n; ++k) {
      if (c[k].fgCover < c[best].fgCover - 1e-9 || c[k].bgHit > c[best].bgHit + 1e-9) continue;
      if (c[k].iou < bestIou - (intent.subtract ? 0.15 : 0.25)) continue;
      if (intent.loneClick && (c[k].area > 0.3 || c[k].edges > 2)) continue;
      if (!pick || (intent.subtract ? c[k].area < c[*pick].area : c[k].area > c[*pick].area)) pick = k;
    }
    if (pick) best = *pick;
  }
  return best;
}

std::vector<Pt> proposal_grid(std::uint32_t width, std::uint32_t height, int alongLong) {
  std::vector<Pt> out;
  if (width == 0 || height == 0 || alongLong < 1) return out;
  const double step = static_cast<double>(std::max(width, height)) / alongLong;
  const auto nx = std::max(1, static_cast<int>(std::lround(width / step)));
  const auto ny = std::max(1, static_cast<int>(std::lround(height / step)));
  for (int y = 0; y < ny; ++y)
    for (int x = 0; x < nx; ++x) out.push_back({(x + 0.5) * width / nx, (y + 0.5) * height / ny});
  return out;
}

std::vector<Proposal> select_proposals(std::span<const float> iouScores, std::span<const float> logits, std::span<const Pt> points, double scale,
                                       std::uint32_t width, std::uint32_t height, std::size_t maxObjects) {
  constexpr std::size_t kCands = 3;
  const std::size_t plane = static_cast<std::size_t>(sam::kMaskSize) * sam::kMaskSize;
  const std::size_t n = std::min({points.size(), iouScores.size() / kCands, logits.size() / (kCands * plane)});
  const auto cells = [&](std::uint32_t px) {
    return std::clamp<std::size_t>(static_cast<std::size_t>(std::lround(px * scale / 4.0)), 1, sam::kMaskSize);
  };
  const std::size_t fw = cells(width);
  const std::size_t fh = cells(height);
  struct Found {
    Proposal p;
    std::vector<std::uint8_t> on;  // the frame's cells
    std::size_t count = 0;
  };
  std::vector<Found> found;
  Intent lone;
  lone.loneClick = true;
  for (std::size_t b = 0; b < n; ++b) {
    const std::span<const float> iou = iouScores.subspan(b * kCands, kCands);
    const std::span<const float> lg = logits.subspan(b * kCands * plane, kCands * plane);
    const std::array<sam::Point, 1> click{sam::Point{points[b].x, points[b].y, 1}};
    const std::size_t k = choose_candidate(iou, lg, click, scale, lone, width, height);
    const CandidateScore q = score_candidates(iou, lg, click, scale, width, height)[k];
    if (q.fgCover < 1 || q.iou < 0.7 || q.area < 0.002 || q.area > 0.3 || q.edges > 2) continue;
    Found f;
    f.p = {b, k, q.iou, q.area};
    f.on.assign(fw * fh, 0);
    for (std::size_t y = 0; y < fh; ++y)
      for (std::size_t x = 0; x < fw; ++x)
        if (lg[k * plane + y * sam::kMaskSize + x] > 0.0f) {
          f.on[y * fw + x] = 1;
          ++f.count;
        }
    if (f.count > 0) found.push_back(std::move(f));
  }
  // The surest first; among equals the larger.
  std::ranges::stable_sort(found, [](const Found& a, const Found& b) { return a.p.iou != b.p.iou ? a.p.iou > b.p.iou : a.count > b.count; });
  std::vector<Found> kept;
  for (Found& f : found) {
    bool drop = false;
    for (Found& k : kept) {
      std::size_t inter = 0;
      for (std::size_t i = 0; i < f.on.size(); ++i) inter += f.on[i] & k.on[i];
      const double uni = static_cast<double>(f.count + k.count - inter);
      const double small = static_cast<double>(std::min(f.count, k.count));
      if (uni > 0 && static_cast<double>(inter) / uni >= 0.6) {
        drop = true;
      } else if (small > 0 && static_cast<double>(inter) / small >= 0.85) {
        // One holds the other: the whole object stays, its part goes.
        if (f.count > k.count) k = std::move(f);
        drop = true;
      }
      if (drop) break;
    }
    if (!drop) kept.push_back(std::move(f));
  }
  std::vector<Proposal> out;
  for (const Found& k : kept) {
    if (out.size() >= maxObjects) break;
    out.push_back(k.p);
  }
  return out;
}

void keep_touching(std::vector<float>& alpha, int width, int height, std::span<const Pt> seeds, const std::optional<sam::Box>& box) {
  const std::size_t n = alpha.size();
  if (width <= 0 || height <= 0 || n != static_cast<std::size_t>(width) * static_cast<std::size_t>(height)) return;
  std::vector<int> label(n, -1);
  std::vector<std::size_t> count;
  std::vector<std::size_t> inBox;
  std::vector<std::size_t> stack;
  for (std::size_t s = 0; s < n; ++s) {
    if (label[s] >= 0 || alpha[s] < 0.5f) continue;
    const int id = static_cast<int>(count.size());
    count.push_back(0);
    inBox.push_back(0);
    label[s] = id;
    stack.push_back(s);
    while (!stack.empty()) {
      const std::size_t p = stack.back();
      stack.pop_back();
      ++count[at(id)];
      const int x = static_cast<int>(p % static_cast<std::size_t>(width));
      const int y = static_cast<int>(p / static_cast<std::size_t>(width));
      if (box && x >= box->x0 && x <= box->x1 && y >= box->y0 && y <= box->y1) ++inBox[at(id)];
      const std::array<std::array<int, 2>, 4> nb{{{x - 1, y}, {x + 1, y}, {x, y - 1}, {x, y + 1}}};
      for (const auto& q : nb) {
        if (q[0] < 0 || q[1] < 0 || q[0] >= width || q[1] >= height) continue;
        const std::size_t qi = idx(q[0], q[1], width);
        if (label[qi] >= 0 || alpha[qi] < 0.5f) continue;
        label[qi] = id;
        stack.push_back(qi);
      }
    }
  }
  if (count.empty()) return;
  std::vector<bool> keep(count.size(), false);
  bool any = false;
  for (const Pt& s : seeds) {
    // A seed a few px off the region (a click on the edge) still names it.
    const int cx = static_cast<int>(std::lround(s.x));
    const int cy = static_cast<int>(std::lround(s.y));
    for (int dy = -3; dy <= 3; ++dy)
      for (int dx = -3; dx <= 3; ++dx) {
        const int x = cx + dx;
        const int y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const int l = label[idx(x, y, width)];
        if (l >= 0 && !keep[at(l)]) {
          keep[at(l)] = true;
          any = true;
        }
      }
  }
  if (box)
    for (std::size_t i = 0; i < count.size(); ++i)
      if (inBox[i] * 2 >= count[i]) {
        keep[i] = true;
        any = true;
      }
  if (!any) {
    // Nothing named: the largest region is the one meant.
    keep[static_cast<std::size_t>(std::distance(count.begin(), std::ranges::max_element(count)))] = true;
  }
  std::vector<float> kept(n, 0.0f);
  for (std::size_t i = 0; i < n; ++i) kept[i] = label[i] >= 0 && keep[at(label[i])] ? 1.0f : 0.0f;
  const std::vector<float> near = dilate(kept, width, height, 3);
  for (std::size_t i = 0; i < n; ++i) alpha[i] *= near[i];
}

std::vector<float> paint(int width, int height, std::span<const std::vector<Pt>> strokes, double radius) {
  std::vector<float> out(static_cast<std::size_t>(std::max(0, width)) * static_cast<std::size_t>(std::max(0, height)), 0.0f);
  if (out.empty() || !(radius > 0)) return out;
  for (const std::vector<Pt>& raw : strokes) {
    if (raw.empty()) continue;
    // Points closer than a quarter radius add nothing to the footprint.
    std::vector<Pt> s{raw.front()};
    for (const Pt& p : raw)
      if (std::hypot(p.x - s.back().x, p.y - s.back().y) >= radius * 0.25) s.push_back(p);
    if (s.size() == 1 && raw.size() > 1) s.push_back(raw.back());
    double x0 = s.front().x;
    double x1 = x0;
    double y0 = s.front().y;
    double y1 = y0;
    for (const Pt& p : s) {
      x0 = std::min(x0, p.x);
      x1 = std::max(x1, p.x);
      y0 = std::min(y0, p.y);
      y1 = std::max(y1, p.y);
    }
    const int bx0 = std::max(0, static_cast<int>(std::floor(x0 - radius - 1)));
    const int bx1 = std::min(width - 1, static_cast<int>(std::ceil(x1 + radius + 1)));
    const int by0 = std::max(0, static_cast<int>(std::floor(y0 - radius - 1)));
    const int by1 = std::min(height - 1, static_cast<int>(std::ceil(y1 + radius + 1)));
    for (int y = by0; y <= by1; ++y)
      for (int x = bx0; x <= bx1; ++x) {
        const Pt p{x + 0.5, y + 0.5};
        double d = std::hypot(p.x - s.front().x, p.y - s.front().y);
        for (std::size_t i = 1; i < s.size() && d > radius - 0.5; ++i) d = std::min(d, seg_dist(p, s[i - 1], s[i]));
        const auto cover = static_cast<float>(std::clamp(radius + 0.5 - d, 0.0, 1.0));
        float& o = out[idx(x, y, width)];
        o = std::max(o, cover);
      }
  }
  return out;
}

std::vector<float> refine_band(std::span<const std::uint8_t> rgba, int width, int height, std::span<const float> base, std::span<const float> band,
                               double radius) {
  std::vector<float> out(base.begin(), base.end());
  const std::size_t n = static_cast<std::size_t>(width) * static_cast<std::size_t>(height);
  if (width <= 0 || height <= 0 || base.size() != n || band.size() != n || rgba.size() < n * 4) return out;
  // The band's bounds, grown by the sampling window: the work stays local.
  int bx0 = width;
  int by0 = height;
  int bx1 = -1;
  int by1 = -1;
  for (int y = 0; y < height; ++y)
    for (int x = 0; x < width; ++x)
      if (band[idx(x, y, width)] > 0.0f) {
        bx0 = std::min(bx0, x);
        bx1 = std::max(bx1, x);
        by0 = std::min(by0, y);
        by1 = std::max(by1, y);
      }
  if (bx1 < 0) return out;
  const int win = std::max(8, static_cast<int>(std::lround(radius * 2 + 4)));
  const int cx0 = std::max(0, bx0 - win * 4);
  const int cy0 = std::max(0, by0 - win * 4);
  const int cw = std::min(width - 1, bx1 + win * 4) - cx0 + 1;
  const int ch = std::min(height - 1, by1 + win * 4) - cy0 + 1;
  const std::size_t cn = static_cast<std::size_t>(cw) * static_cast<std::size_t>(ch);
  // Sure foreground / background (outside the band): each band pixel takes the colour of the
  // NEAREST sure pixel of each side (a multi-source flood), not a window's mean — a subject is
  // seldom one colour (a dark shirt under a blond head), and the mean of both says neither.
  std::vector<int> nearF(cn, -1);
  std::vector<int> nearB(cn, -1);
  std::vector<std::size_t> qf;
  std::vector<std::size_t> qb;
  for (int y = 0; y < ch; ++y)
    for (int x = 0; x < cw; ++x) {
      const std::size_t g = idx(x + cx0, y + cy0, width);
      const std::size_t l = idx(x, y, cw);
      if (band[g] >= 0.5f) continue;
      if (base[g] > 0.95f) {
        nearF[l] = static_cast<int>(g);
        qf.push_back(l);
      } else if (base[g] < 0.05f) {
        nearB[l] = static_cast<int>(g);
        qb.push_back(l);
      }
    }
  const auto flood = [&](std::vector<int>& near, std::vector<std::size_t> frontier) {
    std::vector<std::size_t> next;
    while (!frontier.empty()) {
      next.clear();
      for (const std::size_t l : frontier) {
        const int x = static_cast<int>(l % static_cast<std::size_t>(cw));
        const int y = static_cast<int>(l / static_cast<std::size_t>(cw));
        for (int dy = -1; dy <= 1; ++dy)
          for (int dx = -1; dx <= 1; ++dx) {
            const int nx = x + dx;
            const int ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
            const std::size_t nl = idx(nx, ny, cw);
            if (near[nl] >= 0) continue;
            near[nl] = near[l];
            next.push_back(nl);
          }
      }
      frontier.swap(next);
    }
  };
  flood(nearF, qf);
  flood(nearB, qb);
  // The unknown region is the band near the selection's current edge: hair and fur reach a
  // few px past it, a wall half a brush away is not hair.
  const int reach = std::max(3, static_cast<int>(std::lround(radius * 0.5)));
  std::vector<int> edgeDist(cn, -1);
  {
    std::vector<std::size_t> frontier;
    for (int y = 0; y < ch; ++y)
      for (int x = 0; x < cw; ++x) {
        const bool in = base[idx(x + cx0, y + cy0, width)] >= 0.5f;
        bool edge = false;
        for (int d = 0; d < 4 && !edge; ++d) {
          const int nx = x + (d == 0 ? 1 : d == 1 ? -1 : 0);
          const int ny = y + (d == 2 ? 1 : d == 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          edge = (base[idx(nx + cx0, ny + cy0, width)] >= 0.5f) != in;
        }
        if (!edge) continue;
        edgeDist[idx(x, y, cw)] = 0;
        frontier.push_back(idx(x, y, cw));
      }
    std::vector<std::size_t> next;
    for (int step = 1; step <= reach && !frontier.empty(); ++step) {
      next.clear();
      for (const std::size_t l : frontier) {
        const int x = static_cast<int>(l % static_cast<std::size_t>(cw));
        const int y = static_cast<int>(l / static_cast<std::size_t>(cw));
        for (int dy = -1; dy <= 1; ++dy)
          for (int dx = -1; dx <= 1; ++dx) {
            const int nx = x + dx;
            const int ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
            const std::size_t nl = idx(nx, ny, cw);
            if (edgeDist[nl] >= 0) continue;
            edgeDist[nl] = step;
            next.push_back(nl);
          }
      }
      frontier.swap(next);
    }
  }
  // α = the pixel projected onto the line from its background colour to its foreground colour.
  std::vector<float> est(cn, 0.0f);
  std::vector<float> lum(cn, 0.0f);
  std::vector<bool> valid(cn, false);
  for (int y = 0; y < ch; ++y)
    for (int x = 0; x < cw; ++x) {
      const std::size_t l = idx(x, y, cw);
      const std::size_t g = idx(x + cx0, y + cy0, width);
      std::array<double, 3> I{rgba[g * 4] / 255.0, rgba[g * 4 + 1] / 255.0, rgba[g * 4 + 2] / 255.0};
      lum[l] = static_cast<float>(0.299 * I[0] + 0.587 * I[1] + 0.114 * I[2]);
      est[l] = base[g];
      if (nearF[l] < 0 || nearB[l] < 0 || edgeDist[l] < 0) continue;
      const auto fi = static_cast<std::size_t>(nearF[l]);
      const auto bi = static_cast<std::size_t>(nearB[l]);
      std::array<double, 3> F{};
      std::array<double, 3> B{};
      double num = 0;
      double den = 0;
      for (std::size_t k = 0; k < 3; ++k) {
        F[k] = rgba[fi * 4 + k] / 255.0;
        B[k] = rgba[bi * 4 + k] / 255.0;
        num += (I[k] - B[k]) * (F[k] - B[k]);
        den += (F[k] - B[k]) * (F[k] - B[k]);
      }
      if (den < 0.01) continue;  // the two sides look alike: the colour says nothing
      const double a = std::clamp(num / den, 0.0, 1.0);
      // Only a pixel that IS a mix of the two colours is judged by them: a colour off that
      // line (a face whose nearest sure foreground is the cap) keeps what it had.
      double err = 0;
      for (std::size_t k = 0; k < 3; ++k) err += (I[k] - (a * F[k] + (1 - a) * B[k])) * (I[k] - (a * F[k] + (1 - a) * B[k]));
      if (err > 0.1 * 0.1 * 3) continue;
      est[l] = static_cast<float>(a);
      valid[l] = true;
    }
  // The estimate is per pixel; the guided filter takes the speckle out along the picture's edges.
  const std::vector<float> smooth = matte::guided_filter(est, lum, cw, ch, 2, 1e-3);
  for (int y = 0; y < ch; ++y)
    for (int x = 0; x < cw; ++x) {
      const std::size_t l = idx(x, y, cw);
      const std::size_t g = idx(x + cx0, y + cy0, width);
      if (band[g] <= 0.0f || !valid[l]) continue;
      const float a = std::clamp(smooth[l], 0.0f, 1.0f);
      out[g] = base[g] + (a - base[g]) * band[g];
    }
  return out;
}

void solidify(std::vector<float>& alpha) {
  for (float& v : alpha) {
    const float x = std::clamp((v - 0.1f) / 0.8f, 0.0f, 1.0f);
    v = x * x * (3.0f - 2.0f * x);
  }
}

void harden_for_subtract(std::vector<float>& delta, int width, int height, int growPx) {
  if (width <= 0 || height <= 0 || delta.size() != static_cast<std::size_t>(width) * static_cast<std::size_t>(height)) return;
  for (float& v : delta) v = std::clamp((v - 0.05f) / 0.25f, 0.0f, 1.0f);
  if (growPx > 0) delta = dilate(delta, width, height, growPx);
}

std::vector<float> combine(std::span<const float> base, std::span<const float> delta, Op op) {
  std::vector<float> out(delta.begin(), delta.end());
  if (op == Op::replace || base.size() != delta.size()) return out;
  for (std::size_t i = 0; i < out.size(); ++i) out[i] = op == Op::add ? std::max(base[i], delta[i]) : base[i] * (1.0f - delta[i]);
  return out;
}

std::vector<float> resample(std::span<const float> plane, int fromW, int fromH, int toW, int toH) {
  std::vector<float> out(static_cast<std::size_t>(std::max(0, toW)) * static_cast<std::size_t>(std::max(0, toH)), 0.0f);
  if (fromW <= 0 || fromH <= 0 || plane.size() < static_cast<std::size_t>(fromW) * static_cast<std::size_t>(fromH)) return out;
  for (int y = 0; y < toH; ++y) {
    const double sy = std::clamp((y + 0.5) * fromH / toH - 0.5, 0.0, static_cast<double>(fromH - 1));
    const int y0 = static_cast<int>(sy);
    const int y1 = std::min(fromH - 1, y0 + 1);
    const double fy = sy - y0;
    for (int x = 0; x < toW; ++x) {
      const double sx = std::clamp((x + 0.5) * fromW / toW - 0.5, 0.0, static_cast<double>(fromW - 1));
      const int x0 = static_cast<int>(sx);
      const int x1 = std::min(fromW - 1, x0 + 1);
      const double fx = sx - x0;
      const double top = plane[idx(x0, y0, fromW)] * (1 - fx) + plane[idx(x1, y0, fromW)] * fx;
      const double bot = plane[idx(x0, y1, fromW)] * (1 - fx) + plane[idx(x1, y1, fromW)] * fx;
      out[idx(x, y, toW)] = static_cast<float>(top * (1 - fy) + bot * fy);
    }
  }
  return out;
}

double matte_iou(std::span<const float> a, std::span<const float> b) {
  std::size_t both = 0;
  std::size_t either = 0;
  const std::size_t n = std::min(a.size(), b.size());
  for (std::size_t i = 0; i < n; ++i) {
    const bool x = a[i] >= 0.5f;
    const bool y = b[i] >= 0.5f;
    both += x && y ? 1 : 0;
    either += x || y ? 1 : 0;
  }
  return either == 0 ? 1.0 : static_cast<double>(both) / static_cast<double>(either);
}

std::size_t choose_continuous(std::span<const float> scores, std::span<const double> overlap) {
  std::size_t best = 0;
  double bestScore = -1;
  for (std::size_t i = 0; i < overlap.size(); ++i) {
    const double s = overlap[i] + 0.1 * (i < scores.size() ? static_cast<double>(scores[i]) : 0.0);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

double track_confidence(double iou, double presence, std::optional<double> agreement) {
  // A held subject's SAM masks predict IoU well above 0.8 and move little against the flow-carried
  // previous frame; a jump onto the background or a lost limb drops one of them, so each ramps to 0 well before 0.4.
  const auto ramp = [](double v, double lo, double hi) { return std::clamp((v - lo) / (hi - lo), 0.0, 1.0); };
  double c = std::min(ramp(iou, 0.45, 0.8), ramp(presence, 0.2, 0.7));
  if (agreement) c = std::min(c, ramp(*agreement, 0.4, 0.75));
  return c;
}
}  // namespace premation::jobs::subject
