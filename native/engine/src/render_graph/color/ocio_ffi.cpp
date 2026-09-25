// OpenColorIO FFI (see ocio_ffi.hpp). Every OCIO call is inside a try: OCIO
// reports failure by throwing OCIO::Exception, and nothing may escape here.
#include "ocio_ffi.hpp"

#include <OpenColorIO/OpenColorIO.h>

#include <array>
#include <cmath>
#include <exception>
#include <limits>
#include <vector>

namespace OCIO = OCIO_NAMESPACE;

namespace premation::rg::color {

struct Ocio::Impl {
  OCIO::ConstConfigRcPtr config;
};

namespace {

enum class Encoding : std::uint8_t { linear, srgb_curve, gamma24 };

struct Resolved {
  const char* linear;
  Encoding encoding;
  /// The config's display for a view on this space (nullptr = none).
  const char* display;
};

Resolved resolve(Space s) noexcept {
  switch (s) {
    case Space::srgb: return {"Linear Rec.709 (sRGB)", Encoding::srgb_curve, "sRGB - Display"};
    case Space::rec709: return {"Linear Rec.709 (sRGB)", Encoding::gamma24, "Rec.1886 Rec.709 - Display"};
    case Space::linear_srgb: return {"Linear Rec.709 (sRGB)", Encoding::linear, nullptr};
    case Space::aces_cg: return {"ACEScg", Encoding::linear, nullptr};
    case Space::rec2020: return {"Linear Rec.2020", Encoding::gamma24, nullptr};
    case Space::linear_rec2020: return {"Linear Rec.2020", Encoding::linear, nullptr};
    case Space::aces2065: return {"ACES2065-1", Encoding::linear, nullptr};
  }
  return {"Linear Rec.709 (sRGB)", Encoding::linear, nullptr};
}

bool scene_linear(Space s) noexcept { return resolve(s).encoding == Encoding::linear; }

/// The config's own curves: sRGB = ExponentWithLinear(2.4, 0.055), Rec.1886 = Exponent(2.4, pass-thru).
/// FORWARD decodes (encoded → linear), INVERSE encodes — the direction the CG config writes them in.
OCIO::TransformRcPtr curve(Encoding e, OCIO::TransformDirection dir) {
  if (e == Encoding::srgb_curve) {
    auto t = OCIO::ExponentWithLinearTransform::Create();
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): OCIO's API takes double(&)[4]
    const double gamma[4] = {2.4, 2.4, 2.4, 1.0};
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): OCIO's API takes double(&)[4]
    const double offset[4] = {0.055, 0.055, 0.055, 0.0};
    t->setGamma(gamma);
    t->setOffset(offset);
    t->setDirection(dir);
    return t;
  }
  auto t = OCIO::ExponentTransform::Create();
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): OCIO's API takes double(&)[4]
  const double v[4] = {2.4, 2.4, 2.4, 1.0};
  t->setValue(v);
  t->setNegativeStyle(OCIO::NEGATIVE_PASS_THRU);
  t->setDirection(dir);
  return t;
}

OCIO::ConstProcessorRcPtr processor(const OCIO::ConstConfigRcPtr& cfg, const Request& req) {
  auto group = OCIO::GroupTransform::Create();
  const Resolved src = resolve(req.src);
  const Resolved dst = resolve(req.dst);
  if (src.encoding != Encoding::linear) group->appendTransform(curve(src.encoding, OCIO::TRANSFORM_DIR_FORWARD));
  if (!req.view.empty()) {
    if (dst.display == nullptr) throw OCIO::Exception("that space has no OCIO display to apply a view on");
    auto dv = OCIO::DisplayViewTransform::Create();
    dv->setSrc(src.linear);
    dv->setDisplay(dst.display);
    dv->setView(req.view.c_str());
    group->appendTransform(dv);
  } else {
    auto cs = OCIO::ColorSpaceTransform::Create();
    cs->setSrc(src.linear);
    cs->setDst(dst.linear);
    group->appendTransform(cs);
    if (dst.encoding != Encoding::linear) group->appendTransform(curve(dst.encoding, OCIO::TRANSFORM_DIR_INVERSE));
  }
  // LOSSLESS: identities and pairs fold, matrices compose; no LUT, no fast pow.
  return cfg->getProcessor(group)->getOptimizedProcessor(OCIO::OPTIMIZATION_LOSSLESS);
}

Negative negative_of(OCIO::NegativeStyle s) noexcept {
  switch (s) {
    case OCIO::NEGATIVE_MIRROR: return Negative::mirror;
    case OCIO::NEGATIVE_PASS_THRU: return Negative::pass_thru;
    case OCIO::NEGATIVE_LINEAR: return Negative::linear;
    default: return Negative::clamp;
  }
}

std::array<double, 9> invert3(const std::array<double, 9>& m, bool& ok) noexcept {
  const double a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], g = m[5], h = m[6], i = m[7], k = m[8];
  const double det = a * (e * k - g * i) - b * (d * k - g * h) + c * (d * i - e * h);
  ok = std::abs(det) > 1e-12;
  if (!ok) return {};
  const double id = 1.0 / det;
  return {(e * k - g * i) * id, (c * i - b * k) * id, (b * g - c * e) * id,
          (g * h - d * k) * id, (a * k - c * h) * id, (c * d - a * g) * id,
          (d * i - e * h) * id, (b * h - a * i) * id, (a * e - b * d) * id};
}

/// One GradingBSplineCurve → CurvePoints.
CurvePoints curve_points(const OCIO::ConstGradingBSplineCurveRcPtr& c) {
  CurvePoints p;
  const std::size_t n = c->getNumControlPoints();
  for (std::size_t i = 0; i < n; ++i) {
    const OCIO::GradingControlPoint& cp = c->getControlPoint(i);
    p.x.push_back(cp.m_x);
    p.y.push_back(cp.m_y);
    p.slopes.push_back(c->getSlope(i));
  }
  return p;
}

/// One transform of the optimized processor → an op (curve data appended to
/// `curves`). False = not expressible (bake instead).
bool to_op(const OCIO::ConstTransformRcPtr& t, Op& op, std::vector<float>& curves) {
  const bool inverse = t->getDirection() == OCIO::TRANSFORM_DIR_INVERSE;
  // D3: the ACES 1.x output transforms' kernels (aces_ops.cpp).
  if (auto ff = OCIO::DynamicPtrCast<const OCIO::FixedFunctionTransform>(t)) {
    switch (ff->getStyle()) {
      case OCIO::FIXED_FUNCTION_ACES_RED_MOD_03:
        if (inverse) return false;
        op = fixed_function_op(FixedFn::red_mod_03);
        return true;
      case OCIO::FIXED_FUNCTION_ACES_RED_MOD_10:
        if (inverse) return false;
        op = fixed_function_op(FixedFn::red_mod_10);
        return true;
      case OCIO::FIXED_FUNCTION_ACES_GLOW_03:
        if (inverse) return false;
        op = fixed_function_op(FixedFn::glow, 0.075F, 0.1F);
        return true;
      case OCIO::FIXED_FUNCTION_ACES_GLOW_10:
        if (inverse) return false;
        op = fixed_function_op(FixedFn::glow, 0.05F, 0.08F);
        return true;
      case OCIO::FIXED_FUNCTION_ACES_DARK_TO_DIM_10:
        // Renderer_ACES_DarkToDim10_Fwd with 0.9811 / 1.0192640913260627; it stores gamma − 1.
        op = fixed_function_op(FixedFn::dark_to_dim, (inverse ? 1.0192640913260627F : 0.9811F) - 1.F);
        return true;
      default: return false;
    }
  }
  if (auto lg = OCIO::DynamicPtrCast<const OCIO::LogTransform>(t)) {
    // LogOpCPU: base 2 → scale 1; base 10 → LOG10_2 / LOG2_10. Other bases use the
    // lin-to-log renderer, which this op does not model.
    constexpr float kLog10of2 = 0.301029995663981198F;
    constexpr float kLog2of10 = 3.321928094887362348F;
    const double base = lg->getBase();
    if (base == 2.0) {
      op = inverse ? antilog_op(1.F) : log_op(1.F);
      return true;
    }
    if (base == 10.0) {
      op = inverse ? antilog_op(kLog2of10) : log_op(kLog10of2);
      return true;
    }
    return false;
  }
  if (auto gc = OCIO::DynamicPtrCast<const OCIO::GradingRGBCurveTransform>(t)) {
    // Forward curves in log / video style (no internal lin↔log wrap); the linear
    // style's SSE lin-log shapers and the inverse's evalCurveRev are not modelled.
    if (inverse) return false;
    if (gc->getStyle() == OCIO::GRADING_LIN && !gc->getBypassLinToLog()) return false;
    const OCIO::ConstGradingRGBCurveRcPtr v = gc->getValue();
    const std::array<OCIO::RGBCurveType, 4> kinds = {OCIO::RGB_RED, OCIO::RGB_GREEN, OCIO::RGB_BLUE, OCIO::RGB_MASTER};
    std::array<float, 4> offsets{};
    for (std::size_t i = 0; i < kinds.size(); ++i) {
      const OCIO::ConstGradingBSplineCurveRcPtr c = v->getCurve(kinds.at(i));
      if (c->getSplineType() != OCIO::B_SPLINE && c->getSplineType() != OCIO::DIAGONAL_B_SPLINE) return false;
      offsets.at(i) = append_curve(curve_points(c), curves);
    }
    op = curve_op(offsets);
    return true;
  }
  if (auto m = OCIO::DynamicPtrCast<const OCIO::MatrixTransform>(t)) {
    std::array<double, 16> m44{};
    std::array<double, 4> off{};
    m->getMatrix(m44.data());
    m->getOffset(off.data());
    // RGB must not read alpha, alpha must pass through.
    if (m44[3] != 0 || m44[7] != 0 || m44[11] != 0) return false;
    std::array<double, 9> m3 = {m44[0], m44[1], m44[2], m44[4], m44[5], m44[6], m44[8], m44[9], m44[10]};
    std::array<double, 3> o = {off[0], off[1], off[2]};
    if (inverse) {
      bool ok = false;
      m3 = invert3(m3, ok);
      if (!ok) return false;
      // x = M⁻¹ (y − o)
      o = {-(m3[0] * o[0] + m3[1] * o[1] + m3[2] * o[2]), -(m3[3] * o[0] + m3[4] * o[1] + m3[5] * o[2]),
           -(m3[6] * o[0] + m3[7] * o[1] + m3[8] * o[2])};
    }
    op = matrix_op(m3, o);
    return true;
  }
  if (auto e = OCIO::DynamicPtrCast<const OCIO::ExponentTransform>(t)) {
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): OCIO's API takes double(&)[4]
    double v[4] = {1, 1, 1, 1};
    e->getValue(v);
    std::array<double, 3> g = {v[0], v[1], v[2]};
    if (inverse) g = {1.0 / g[0], 1.0 / g[1], 1.0 / g[2]};
    const Negative neg = negative_of(e->getNegativeStyle());
    if (neg == Negative::linear) return false;
    op = exponent_op(g, neg);
    return true;
  }
  if (auto x = OCIO::DynamicPtrCast<const OCIO::ExponentWithLinearTransform>(t)) {
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): OCIO's API takes double(&)[4]
    double g[4] = {1, 1, 1, 1};
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): OCIO's API takes double(&)[4]
    double o[4] = {0, 0, 0, 0};
    x->getGamma(g);
    x->getOffset(o);
    op = moncurve_op({g[0], g[1], g[2]}, {o[0], o[1], o[2]}, !inverse, negative_of(x->getNegativeStyle()));
    return true;
  }
  if (auto r = OCIO::DynamicPtrCast<const OCIO::RangeTransform>(t)) {
    double minIn = r->getMinInValue(), maxIn = r->getMaxInValue(), minOut = r->getMinOutValue(), maxOut = r->getMaxOutValue();
    bool hasMinIn = r->hasMinInValue(), hasMaxIn = r->hasMaxInValue(), hasMinOut = r->hasMinOutValue(), hasMaxOut = r->hasMaxOutValue();
    if (inverse) {
      std::swap(minIn, minOut);
      std::swap(maxIn, maxOut);
      std::swap(hasMinIn, hasMinOut);
      std::swap(hasMaxIn, hasMaxOut);
    }
    double scale = 1;
    double offset = 0;
    if (hasMinIn && hasMaxIn && hasMinOut && hasMaxOut && maxIn != minIn) {
      scale = (maxOut - minOut) / (maxIn - minIn);
      offset = minOut - scale * minIn;
    } else if (hasMinIn && hasMinOut) {
      offset = minOut - minIn;
    } else if (hasMaxIn && hasMaxOut) {
      offset = maxOut - maxIn;
    }
    const bool clamp = r->getStyle() == OCIO::RANGE_CLAMP;
    constexpr double kInf = std::numeric_limits<double>::infinity();
    op = range_op(scale, offset, clamp && hasMinOut ? minOut : -kInf, clamp && hasMaxOut ? maxOut : kInf);
    return true;
  }
  return false;
}

}  // namespace

std::unique_ptr<Ocio> Ocio::open(std::string_view config, std::string& error) {
  try {
    std::unique_ptr<Ocio> o(new Ocio());  // NOLINT(cppcoreguidelines-owning-memory): private ctor
    o->impl_ = std::make_unique<Impl>();
    o->name_ = config.empty() ? std::string(kBuiltinConfig) : std::string(config);
    o->impl_->config = OCIO::Config::CreateFromFile(o->name_.c_str());
    return o;
  } catch (const std::exception& e) {
    error = std::string("OCIO config: ") + e.what();
    return nullptr;
  }
}

Ocio::~Ocio() = default;

bool Ocio::program(const Request& req, Program& out, std::string& error) const {
  try {
    const OCIO::ConstProcessorRcPtr proc = processor(impl_->config, req);
    out = Program{};
    out.key = req.key();
    bool expressible = !req.forceLut;
    if (expressible) {
      const OCIO::ConstGroupTransformRcPtr g = proc->createGroupTransform();
      for (int i = 0; i < g->getNumTransforms() && expressible; ++i) {
        Op op;
        expressible = to_op(g->getTransform(i), op, out.curves);
        if (expressible) out.ops.push_back(op);
      }
      expressible = expressible && out.ops.size() <= kMaxOps;
    }
    if (expressible) return true;
    // Bake: OCIO's CPU processor over the lattice; a log2 shaper for scene-linear
    // input (2^-12 … 2^6: below reads black, above saturates every SDR output
    // transform), identity on [0, 1] for encoded input.
    const Shaper shaper = scene_linear(req.src) ? Shaper{true, -12.0, 6.0} : Shaper{false, 0.0, 1.0};
    const OCIO::ConstCPUProcessorRcPtr cpu = proc->getOptimizedCPUProcessor(OCIO::OPTIMIZATION_LOSSLESS);
    Program baked = bake_lut(shaper, std::max<std::uint32_t>(2, req.lutSize), [&](std::span<float> rgb) {
      OCIO::PackedImageDesc img(rgb.data(), static_cast<long>(rgb.size() / 3), 1, 3);
      cpu->apply(img);
    });
    baked.key = out.key;
    out = std::move(baked);
    return true;
  } catch (const std::exception& e) {
    error = std::string("OCIO: ") + e.what();
    return false;
  }
}

bool Ocio::apply_cpu(const Request& req, std::span<float> rgb, std::string& error) const {
  try {
    const OCIO::ConstCPUProcessorRcPtr cpu = processor(impl_->config, req)->getOptimizedCPUProcessor(OCIO::OPTIMIZATION_LOSSLESS);
    OCIO::PackedImageDesc img(rgb.data(), static_cast<long>(rgb.size() / 3), 1, 3);
    cpu->apply(img);
    return true;
  } catch (const std::exception& e) {
    error = std::string("OCIO: ") + e.what();
    return false;
  }
}

bool Ocio::describe(const Request& req, std::string& out, std::string& error) const {
  try {
    const OCIO::ConstGroupTransformRcPtr g = processor(impl_->config, req)->createGroupTransform();
    out.clear();
    for (int i = 0; i < g->getNumTransforms(); ++i) {
      const OCIO::ConstTransformRcPtr t = g->getTransform(i);
      std::string n = "?";
      if (OCIO::DynamicPtrCast<const OCIO::MatrixTransform>(t)) n = "matrix";
      else if (OCIO::DynamicPtrCast<const OCIO::ExponentTransform>(t)) n = "exponent";
      else if (OCIO::DynamicPtrCast<const OCIO::ExponentWithLinearTransform>(t)) n = "exponent-with-linear";
      else if (OCIO::DynamicPtrCast<const OCIO::RangeTransform>(t)) n = "range";
      else if (OCIO::DynamicPtrCast<const OCIO::FixedFunctionTransform>(t)) n = "fixed-function";
      else if (OCIO::DynamicPtrCast<const OCIO::LogCameraTransform>(t)) n = "log-camera";
      else if (OCIO::DynamicPtrCast<const OCIO::LogAffineTransform>(t)) n = "log-affine";
      else if (OCIO::DynamicPtrCast<const OCIO::Lut1DTransform>(t)) n = "lut1d";
      else if (OCIO::DynamicPtrCast<const OCIO::Lut3DTransform>(t)) n = "lut3d";
      else if (OCIO::DynamicPtrCast<const OCIO::LogTransform>(t)) n = "log";
      else if (OCIO::DynamicPtrCast<const OCIO::CDLTransform>(t)) n = "cdl";
      else if (OCIO::DynamicPtrCast<const OCIO::ExposureContrastTransform>(t)) n = "exposure-contrast";
      else if (OCIO::DynamicPtrCast<const OCIO::GradingPrimaryTransform>(t)) n = "grading-primary";
      else if (OCIO::DynamicPtrCast<const OCIO::GradingToneTransform>(t)) n = "grading-tone";
      else if (OCIO::DynamicPtrCast<const OCIO::GradingRGBCurveTransform>(t)) n = "grading-rgb-curve";
      if (t->getDirection() == OCIO::TRANSFORM_DIR_INVERSE) n += "⁻¹";
      out += (out.empty() ? "" : " → ") + n;
    }
    return true;
  } catch (const std::exception& e) {
    error = std::string("OCIO: ") + e.what();
    return false;
  }
}

}  // namespace premation::rg::color
