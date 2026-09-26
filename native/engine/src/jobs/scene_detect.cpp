#include "scene_detect.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>

#include "jsmath.hpp"

namespace premation::jobs::scene_detect {

Histogram luma_histogram(const LumaImage& plane) {
  Histogram h{};
  const std::size_t n = plane.data.size();
  if (n == 0) return h;
  // Byte planes are 0..255; float planes from the canvas reader are 0..1 (sniffed, as the TS does).
  double scale = 1;
  if (!plane.bytes) {
    double max = 0;
    for (std::size_t i = 0; i < n; i += 97) max = std::max(max, static_cast<double>(plane.data[i]));
    scale = max <= 1.0001 ? 255 : 1;
  }
  for (std::size_t i = 0; i < n; ++i) {
    double v = static_cast<double>(plane.data[i]) * scale;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    const auto bin = std::min<std::size_t>(static_cast<std::size_t>(v * (kBins / 256.0)), kBins - 1);  // `| 0`, v ≥ 0
    h[bin] = static_cast<float>(static_cast<double>(h[bin]) + 1);
  }
  const double inv = 1.0 / static_cast<double>(n);
  for (float& b : h) b = static_cast<float>(static_cast<double>(b) * inv);
  return h;
}

double histogram_distance(const Histogram& a, const Histogram& b) {
  double s = 0;
  for (int i = 0; i < kBins; ++i) s += std::abs(static_cast<double>(a[static_cast<std::size_t>(i)]) - static_cast<double>(b[static_cast<std::size_t>(i)]));
  return s;
}

namespace {

double median(std::vector<double> values) {
  if (values.empty()) return 0;
  std::sort(values.begin(), values.end());
  const std::size_t mid = values.size() >> 1U;
  return (values.size() % 2) != 0 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

}  // namespace

std::vector<std::int64_t> cuts_from_distances(const std::vector<double>& distances, const Options& o) {
  std::vector<std::int64_t> cuts;
  double lastCut = -std::numeric_limits<double>::infinity();
  const auto n = static_cast<std::int64_t>(distances.size());
  for (std::int64_t i = 0; i < n; ++i) {
    const double d = distances[static_cast<std::size_t>(i)];
    if (d < o.floor) continue;
    const std::int64_t lo = std::max<std::int64_t>(0, i - o.window);
    const std::int64_t hi = std::min<std::int64_t>(n - 1, i + o.window);
    std::vector<double> neighbours;
    for (std::int64_t j = lo; j <= hi; ++j) {
      if (j != i) neighbours.push_back(distances[static_cast<std::size_t>(j)]);
    }
    const double base = median(std::move(neighbours));
    if (d < o.sensitivity * std::max(base, 0.01)) continue;
    const std::int64_t frame = i + 1;
    if (static_cast<double>(frame) - lastCut < o.minShotFrames) {
      if (!cuts.empty() && d > distances[static_cast<std::size_t>(cuts.back() - 1)]) cuts.back() = frame;
      lastCut = static_cast<double>(cuts.empty() ? frame : cuts.back());
      continue;
    }
    cuts.push_back(frame);
    lastCut = static_cast<double>(frame);
  }
  return cuts;
}

std::vector<std::int64_t> dissolves_from_distances(const std::vector<double>& distances,
                                                   const std::function<double(std::int64_t, std::int64_t)>& direct,
                                                   const Options& o, const std::vector<std::int64_t>& knownCuts) {
  const double floor = o.floor;
  const auto maxLen = static_cast<std::int64_t>(o.maxDissolveFrames);
  const double stepCap = floor * 0.8;
  const std::set<std::int64_t> cutSet(knownCuts.begin(), knownCuts.end());
  std::vector<std::int64_t> out;
  const auto n = static_cast<std::int64_t>(distances.size());
  std::int64_t i = 0;
  while (i < n) {
    double sum = 0;
    bool found = false;
    for (std::int64_t j = i; j < n && j - i < maxLen; ++j) {
      const double d = distances[static_cast<std::size_t>(j)];
      if (d >= stepCap || cutSet.contains(j + 1)) break;
      sum += d;
      if (sum >= floor) {
        const double dd = direct(i, j + 1);
        if (dd >= floor * 0.85 && dd >= sum * 0.7) {
          const double still = floor / static_cast<double>(maxLen);
          std::int64_t end = j + 1;
          double total = sum;
          while (end < n && end - i < maxLen) {
            const double step = distances[static_cast<std::size_t>(end)];
            if (step >= stepCap || step < still || cutSet.contains(end + 1)) break;
            const double tryTotal = total + step;
            if (direct(i, end + 1) < tryTotal * 0.7) break;
            total = tryTotal;
            ++end;
          }
          const std::int64_t mid = i + static_cast<std::int64_t>(motion::js::round(static_cast<double>(end - i) / 2));
          if (out.empty() || mid - out.back() >= o.minShotFrames) out.push_back(mid);
          i = end;
          found = true;
        }
        break;
      }
    }
    if (!found) ++i;
  }
  return out;
}

WalkResult walk(std::int64_t from, std::int64_t to, const Options& o, const std::function<bool(std::int64_t, LumaImage&)>& frameAt,
                const std::function<bool(double)>& progress) {
  WalkResult r;
  const std::int64_t total = to - from;
  if (total < 1) return r;
  std::vector<Histogram> hists;
  LumaImage plane;
  if (!frameAt(from, plane)) {
    r.cancelled = true;
    return r;
  }
  hists.push_back(luma_histogram(plane));
  for (std::int64_t f = from + 1; f <= to; ++f) {
    if (!frameAt(f, plane)) {
      r.cancelled = true;
      break;
    }
    const Histogram cur = luma_histogram(plane);
    r.distances.push_back(histogram_distance(hists.back(), cur));
    hists.push_back(cur);
    if (!progress(static_cast<double>(f - from) / static_cast<double>(total))) {
      r.cancelled = true;
      break;
    }
  }
  const std::vector<std::int64_t> hard = cuts_from_distances(r.distances, o);
  std::vector<std::int64_t> soft;
  if (o.dissolves) {
    soft = dissolves_from_distances(
        r.distances,
        [&hists](std::int64_t a, std::int64_t b) {
          return histogram_distance(hists[static_cast<std::size_t>(a)], hists[static_cast<std::size_t>(b)]);
        },
        o, hard);
  }
  std::set<std::int64_t> all(hard.begin(), hard.end());
  all.insert(soft.begin(), soft.end());
  for (const std::int64_t c : all) r.cuts.push_back(c + from);
  for (const std::int64_t c : soft) r.dissolveCuts.push_back(c + from);
  return r;
}

}  // namespace premation::jobs::scene_detect
