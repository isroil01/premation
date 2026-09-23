// A colour transform as a small program the GPU runs — D3 of
// docs/NATIVE_CORE_PLAN.md.
//
// OpenColorIO builds every transform the engine applies (input interpretation,
// working space, display, output: ocio_ffi.cpp). Its OPTIMIZED processor is a
// short list of ops; the ones colour spaces are made of — 3×4 matrices, pure
// power curves, the sRGB/Rec.709-style "power with a linear toe" (OCIO's
// moncurve) and ranges — are carried into WGSL as this op list: a uniform
// block the one colour shader interprets (shaders/color_wgsl.hpp), so a new
// transform never compiles a new pipeline and every op runs in exact float
// maths. A processor holding anything else (an ACES output transform's fixed
// functions, a LUT file, a look) is BAKED instead: OCIO's CPU processor
// evaluated on a shaper × 3D grid, sampled with 8-tap float trilinear.
// Why the op list is the default and the LUT the fallback is measured, not
// assumed — see the numbers in test_render_graph_color.cpp and native/README.md.
//
// GPU-free and OCIO-free on purpose: `evaluate` is the float-for-float CPU twin
// of the WGSL, so the program is unit-tested (and fuzzed under ASan) without a
// device or the OCIO library.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <span>
#include <string>
#include <vector>

namespace premation::rg::color {

/// The colour spaces the engine names (engine-api RenderColorSpace, same order).
enum class Space : std::uint8_t { srgb, rec709, linear_srgb, aces_cg, rec2020, linear_rec2020, aces2065 };

enum class OpType : std::uint8_t {
  none = 0,
  matrix = 1,        // rgb' = M·rgb + offset
  exponent = 2,      // rgb' = rgb^g (per channel), negative style
  moncurve_fwd = 3,  // encoded → linear: x ≤ break ? x·slope : (x·scale + offset)^g
  moncurve_rev = 4,  // linear → encoded: x > break ? x^g·scale − offset : x·slope
  range = 5,         // rgb' = clamp(rgb·scale + offset, lo, hi)
  lut3d = 6,         // shaper → N³ lattice, float trilinear
};

/// OCIO NegativeStyle, as the kernels apply it.
enum class Negative : std::uint8_t { clamp = 0, mirror = 1, pass_thru = 2, linear = 3 };

/// One op: a header and five parameter rows (the uniform layout, 6 × vec4).
///   matrix        p[0..2] = rows (m0, m1, m2, offset)
///   exponent      p[0].rgb = gamma
///   moncurve_fwd  p[0] scale, p[1] offset, p[2] gamma, p[3] break, p[4] slope (rgb each)
///   moncurve_rev  p[0] gamma, p[1] scale, p[2] offset, p[3] break, p[4] slope
///   range         p[0] scale, p[1] offset, p[2] lo, p[3] hi
///   lut3d         p[0] = (shaper kind, lo, hi, N): kind 0 = identity on [lo, hi],
///                 1 = log2 on [lo, hi] (scene-linear input; values ≤ 2^lo read the first sample)
struct Op {
  OpType type = OpType::none;
  Negative negative = Negative::clamp;
  std::array<std::array<float, 4>, 5> p{};
};

inline constexpr std::size_t kMaxOps = 8;
/// Floats one op occupies in the uniform block (header + 5 rows).
inline constexpr std::size_t kOpFloats = 24;

struct Program {
  std::vector<Op> ops;
  /// The baked lattice when `ops` holds a lut3d: N³ RGBA texels, r fastest,
  /// then g, then b (atlas texel (r + b·N, g)).
  std::uint32_t lutSize = 0;
  std::vector<float> lut;
  /// Cache identity (the request that built it).
  std::string key;
  [[nodiscard]] bool identity() const noexcept { return ops.empty(); }
  [[nodiscard]] bool baked() const noexcept { return lutSize != 0; }
};

/// Apply the program to straight RGB triples in place — exactly what the WGSL
/// interpreter computes, in float.
void evaluate(const Program& program, std::span<float> rgb) noexcept;

/// The op list as the colour shader's uniform tail: `kMaxOps` ops of
/// `kOpFloats` floats (unused ops zero = type none). Appends to `out`.
void pack(const Program& program, std::vector<float>& out);

/// A 3×4 row-major matrix op (rows m[0..2], offsets o[0..2]).
Op matrix_op(const std::array<double, 9>& m, const std::array<double, 3>& offset = {0, 0, 0}) noexcept;
/// OCIO ExponentWithLinearTransform (gamma, offset per channel), in either direction.
Op moncurve_op(const std::array<double, 3>& gamma, const std::array<double, 3>& offset, bool forward, Negative negative) noexcept;
/// OCIO ExponentTransform with the power already direction-resolved.
Op exponent_op(const std::array<double, 3>& gamma, Negative negative) noexcept;
/// clamp(x·scale + offset, lo, hi); ±infinity for an open side.
Op range_op(double scale, double offset, double lo, double hi) noexcept;

/// Shaper for a baked lattice.
struct Shaper {
  bool log2 = false;
  double lo = 0;  // domain start (log2 units when log2)
  double hi = 1;  // domain end
};
/// The lattice coordinate (0..1) of an input value, the CPU twin of the WGSL shaper.
float shape(const Shaper& s, float x) noexcept;
/// The input value at lattice coordinate t (the inverse, for baking).
double unshape(const Shaper& s, double t) noexcept;
/// A program holding one lut3d op + its lattice. `reference` is the transform
/// being baked, called ONCE with all N³ lattice inputs (straight RGB triples,
/// transformed in place) so an OCIO CPU processor evaluates the lattice in one call.
Program bake_lut(const Shaper& shaper, std::uint32_t n, const std::function<void(std::span<float>)>& reference);

/// A space's primaries (Rec.709 / AP1 / Rec.2020 / AP0) as a matrix FROM linear
/// Rec.709 — the authored-colour path (Packer::color) under colour management.
/// Values from OCIO's CG config (its AP0-referred matrices, composed in double).
std::array<double, 9> from_linear_rec709(Space working) noexcept;

}  // namespace premation::rg::color
