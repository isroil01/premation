#include "color_program.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace premation::rg::color {
namespace {

using Row = std::array<float, 4>;

constexpr float kHuge = std::numeric_limits<float>::max();

float f(double v) noexcept { return static_cast<float>(v); }

// ── the kernels: WGSL `applyOp` (shaders/color_wgsl.hpp), op for op ─────────

float exponent(float x, float g, Negative neg) noexcept {
  switch (neg) {
    case Negative::mirror: return std::copysign(std::pow(std::abs(x), g), x);
    case Negative::pass_thru: return x > 0.0F ? std::pow(x, g) : x;
    default: return std::pow(std::max(x, 0.0F), g);
  }
}

float moncurve_fwd(float x, float scale, float offset, float g, float brk, float slope, Negative neg) noexcept {
  const float a = neg == Negative::mirror ? std::abs(x) : x;
  const float v = a <= brk ? a * slope : std::pow(a * scale + offset, g);
  return neg == Negative::mirror ? std::copysign(v, x) : v;
}

float moncurve_rev(float x, float g, float scale, float offset, float brk, float slope, Negative neg) noexcept {
  const float a = neg == Negative::mirror ? std::abs(x) : x;
  const float v = a > brk ? std::pow(a, g) * scale - offset : a * slope;
  return neg == Negative::mirror ? std::copysign(v, x) : v;
}

std::size_t lattice_index(std::uint32_t n, std::uint32_t r, std::uint32_t g, std::uint32_t b) noexcept {
  return ((std::size_t{b} * n + g) * n + r) * 4;
}

void lut3d(const Program& prog, const Op& op, std::array<float, 3>& c) noexcept {
  const std::uint32_t n = prog.lutSize;
  if (n < 2 || prog.lut.size() < std::size_t{n} * n * n * 4) return;
  const Shaper s{op.p[0][0] > 0.5F, op.p[0][1], op.p[0][2]};
  const auto nm1 = static_cast<float>(n - 1);
  std::array<std::uint32_t, 3> i0{};
  std::array<std::uint32_t, 3> i1{};
  std::array<float, 3> fr{};
  for (std::size_t k = 0; k < 3; ++k) {
    const float t = std::clamp(shape(s, c.at(k)), 0.0F, 1.0F) * nm1;
    const float fl = std::floor(t);
    i0.at(k) = static_cast<std::uint32_t>(fl);
    i1.at(k) = std::min(i0.at(k) + 1, n - 1);
    fr.at(k) = t - fl;
  }
  std::array<float, 3> out{};
  for (std::size_t ch = 0; ch < 3; ++ch) {
    const auto at = [&](std::uint32_t r, std::uint32_t g, std::uint32_t b) { return prog.lut[lattice_index(n, r, g, b) + ch]; };
    // Along r, then g, then b — the WGSL order (mix(a, b, t) = a + (b − a)·t).
    const auto mix = [](float a, float b, float t) { return a + (b - a) * t; };
    const float c00 = mix(at(i0[0], i0[1], i0[2]), at(i1[0], i0[1], i0[2]), fr[0]);
    const float c10 = mix(at(i0[0], i1[1], i0[2]), at(i1[0], i1[1], i0[2]), fr[0]);
    const float c01 = mix(at(i0[0], i0[1], i1[2]), at(i1[0], i0[1], i1[2]), fr[0]);
    const float c11 = mix(at(i0[0], i1[1], i1[2]), at(i1[0], i1[1], i1[2]), fr[0]);
    out.at(ch) = mix(mix(c00, c10, fr[1]), mix(c01, c11, fr[1]), fr[2]);
  }
  c = out;
}

void apply(const Program& prog, const Op& op, std::array<float, 3>& c) noexcept {
  switch (op.type) {
    case OpType::matrix: {
      std::array<float, 3> o{};
      for (std::size_t r = 0; r < 3; ++r) {
        const Row& m = op.p.at(r);
        // dot(m.xyz, c) + m.w — the WGSL expression, evaluated left to right.
        o.at(r) = m[0] * c[0] + m[1] * c[1] + m[2] * c[2] + m[3];
      }
      c = o;
      break;
    }
    case OpType::exponent:
      for (std::size_t k = 0; k < 3; ++k) c.at(k) = exponent(c.at(k), op.p[0].at(k), op.negative);
      break;
    case OpType::moncurve_fwd:
      for (std::size_t k = 0; k < 3; ++k) {
        c.at(k) = moncurve_fwd(c.at(k), op.p[0].at(k), op.p[1].at(k), op.p[2].at(k), op.p[3].at(k), op.p[4].at(k), op.negative);
      }
      break;
    case OpType::moncurve_rev:
      for (std::size_t k = 0; k < 3; ++k) {
        c.at(k) = moncurve_rev(c.at(k), op.p[0].at(k), op.p[1].at(k), op.p[2].at(k), op.p[3].at(k), op.p[4].at(k), op.negative);
      }
      break;
    case OpType::range:
      for (std::size_t k = 0; k < 3; ++k) c.at(k) = std::clamp(c.at(k) * op.p[0].at(k) + op.p[1].at(k), op.p[2].at(k), op.p[3].at(k));
      break;
    case OpType::lut3d: lut3d(prog, op, c); break;
    case OpType::none: break;
  }
}

std::array<double, 9> mul3(const std::array<double, 9>& a, const std::array<double, 9>& b) noexcept {
  std::array<double, 9> o{};
  for (std::size_t r = 0; r < 3; ++r) {
    for (std::size_t col = 0; col < 3; ++col) {
      o.at(r * 3 + col) = a.at(r * 3) * b.at(col) + a.at(r * 3 + 1) * b.at(3 + col) + a.at(r * 3 + 2) * b.at(6 + col);
    }
  }
  return o;
}

std::array<double, 9> inverse3(const std::array<double, 9>& m) noexcept {
  const double a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], g = m[5], h = m[6], i = m[7], k = m[8];
  const double det = a * (e * k - g * i) - b * (d * k - g * h) + c * (d * i - e * h);
  const double id = 1.0 / det;
  return {(e * k - g * i) * id, (c * i - b * k) * id, (b * g - c * e) * id,
          (g * h - d * k) * id, (a * k - c * h) * id, (c * d - a * g) * id,
          (d * i - e * h) * id, (b * h - a * i) * id, (a * e - b * d) * id};
}

// OCIO CG config (cg-config-v2.2.0_aces-v1.3_ocio-v2.4): AP0 (ACES2065-1) → each space's linear primaries.
constexpr std::array<double, 9> kAp0ToRec709 = {2.52168618674388,   -1.13413098823972, -0.387555198504164,
                                                -0.276479914229922, 1.37271908766826,  -0.096239173438334,
                                                -0.0153780649660342, -0.152975335867399, 1.16835340083343};
constexpr std::array<double, 9> kAp0ToAp1 = {1.45143931614567,   -0.23651074689374, -0.214928569251925,
                                             -0.0765537733960206, 1.17622969983357, -0.0996759264375522,
                                             0.00831614842569772, -0.00603244979102102, 0.997716301365323};
constexpr std::array<double, 9> kAp0ToRec2020 = {1.49040952054172,   -0.26617091926613, -0.224238601275593,
                                                 -0.0801674998722558, 1.18216712109757, -0.10199962122531,
                                                 0.00322763119162216, -0.0347764757450576, 1.03154884455344};

}  // namespace

float shape(const Shaper& s, float x) noexcept {
  const float lo = f(s.lo);
  const float span = f(s.hi - s.lo);
  if (!s.log2) return (x - lo) / span;
  // max(x, 2^lo) keeps log2 finite; everything at or below the floor reads the first sample.
  return (std::log2(std::max(x, std::exp2(lo))) - lo) / span;
}

double unshape(const Shaper& s, double t) noexcept {
  const double v = s.lo + t * (s.hi - s.lo);
  return s.log2 ? std::exp2(v) : v;
}

void evaluate(const Program& program, std::span<float> rgb) noexcept {
  for (std::size_t i = 0; i + 2 < rgb.size(); i += 3) {
    std::array<float, 3> c{rgb[i], rgb[i + 1], rgb[i + 2]};
    for (const Op& op : program.ops) apply(program, op, c);
    rgb[i] = c[0];
    rgb[i + 1] = c[1];
    rgb[i + 2] = c[2];
  }
}

void pack(const Program& program, std::vector<float>& out) {
  for (std::size_t i = 0; i < kMaxOps; ++i) {
    if (i >= program.ops.size()) {
      out.insert(out.end(), kOpFloats, 0.0F);
      continue;
    }
    const Op& op = program.ops[i];
    out.push_back(static_cast<float>(op.type));
    out.push_back(static_cast<float>(op.negative));
    out.push_back(op.type == OpType::lut3d ? static_cast<float>(program.lutSize) : 0.0F);
    out.push_back(0.0F);
    for (const Row& r : op.p) out.insert(out.end(), r.begin(), r.end());
  }
}

Op matrix_op(const std::array<double, 9>& m, const std::array<double, 3>& offset) noexcept {
  Op op;
  op.type = OpType::matrix;
  for (std::size_t r = 0; r < 3; ++r) {
    op.p.at(r) = {f(m.at(r * 3)), f(m.at(r * 3 + 1)), f(m.at(r * 3 + 2)), f(offset.at(r))};
  }
  return op;
}

Op moncurve_op(const std::array<double, 3>& gamma, const std::array<double, 3>& offset, bool forward, Negative negative) noexcept {
  // GammaOpUtils.cpp: the break point and slope are implied by gamma and offset
  // (the linear toe meets the power curve with matching value and slope), and
  // the same EPS fudges keep gamma = 1 / offset = 0 finite.
  constexpr double kEps = 1e-6;
  Op op;
  op.type = forward ? OpType::moncurve_fwd : OpType::moncurve_rev;
  op.negative = negative == Negative::mirror ? Negative::mirror : Negative::linear;
  for (std::size_t k = 0; k < 3; ++k) {
    const double g = std::max(gamma.at(k), 1.0 + kEps);
    const double o = std::max(offset.at(k), kEps);
    if (forward) {
      op.p[0].at(k) = f(1.0 / (1.0 + o));                                        // scale
      op.p[1].at(k) = f(o / (1.0 + o));                                          // offset
      op.p[2].at(k) = f(g);                                                      // gamma
      op.p[3].at(k) = f(o / (g - 1.0));                                          // break
      op.p[4].at(k) = f((g - 1.0) / o * std::pow(o * g / ((g - 1.0) * (1.0 + o)), g));  // slope
    } else {
      op.p[0].at(k) = f(1.0 / g);                                                // gamma
      op.p[1].at(k) = f(1.0 + o);                                                // scale
      op.p[2].at(k) = f(o);                                                      // offset
      op.p[3].at(k) = f(std::pow(o * g / ((g - 1.0) * (1.0 + o)), g));           // break
      op.p[4].at(k) = f(std::pow((g - 1.0) / o, g - 1.0) * std::pow((1.0 + o) / g, g));  // slope
    }
  }
  return op;
}

Op exponent_op(const std::array<double, 3>& gamma, Negative negative) noexcept {
  Op op;
  op.type = OpType::exponent;
  op.negative = negative;
  for (std::size_t k = 0; k < 3; ++k) op.p[0].at(k) = f(gamma.at(k));
  return op;
}

Op range_op(double scale, double offset, double lo, double hi) noexcept {
  Op op;
  op.type = OpType::range;
  const float l = std::isfinite(lo) ? f(lo) : -kHuge;
  const float h = std::isfinite(hi) ? f(hi) : kHuge;
  for (std::size_t k = 0; k < 3; ++k) {
    op.p[0].at(k) = f(scale);
    op.p[1].at(k) = f(offset);
    op.p[2].at(k) = l;
    op.p[3].at(k) = h;
  }
  return op;
}

Program bake_lut(const Shaper& shaper, std::uint32_t n, const std::function<void(std::span<float>)>& reference) {
  Program p;
  p.lutSize = n;
  const std::size_t count = std::size_t{n} * n * n;
  std::vector<float> rgb(count * 3);
  const double step = 1.0 / static_cast<double>(n - 1);
  for (std::uint32_t b = 0; b < n; ++b) {
    for (std::uint32_t g = 0; g < n; ++g) {
      for (std::uint32_t r = 0; r < n; ++r) {
        const std::size_t i = lattice_index(n, r, g, b) / 4 * 3;
        rgb[i] = f(unshape(shaper, r * step));
        rgb[i + 1] = f(unshape(shaper, g * step));
        rgb[i + 2] = f(unshape(shaper, b * step));
      }
    }
  }
  reference(rgb);
  p.lut.assign(count * 4, 1.0F);
  for (std::size_t i = 0; i < count; ++i) {
    p.lut[i * 4] = rgb[i * 3];
    p.lut[i * 4 + 1] = rgb[i * 3 + 1];
    p.lut[i * 4 + 2] = rgb[i * 3 + 2];
  }
  Op op;
  op.type = OpType::lut3d;
  op.p[0] = {shaper.log2 ? 1.0F : 0.0F, f(shaper.lo), f(shaper.hi), static_cast<float>(n)};
  p.ops.push_back(op);
  return p;
}

std::array<double, 9> from_linear_rec709(Space working) noexcept {
  const std::array<double, 9> toAp0 = inverse3(kAp0ToRec709);
  switch (working) {
    case Space::aces_cg: return mul3(kAp0ToAp1, toAp0);
    case Space::rec2020:
    case Space::linear_rec2020: return mul3(kAp0ToRec2020, toAp0);
    case Space::aces2065: return toAp0;
    default: return {1, 0, 0, 0, 1, 0, 0, 0, 1};
  }
}

}  // namespace premation::rg::color
