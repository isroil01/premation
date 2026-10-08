// Sample generator (SDK 1.1): Particles — a 3D emitter rendered through the
// comp camera. The emitter sits at the Emitter layer's origin
// (get_layer_transform), or at the comp's centre when no layer is picked;
// every particle is projected with the comp camera (get_comp_camera), so
// orbiting the camera orbits the burst. Lit by the comp's lights when there
// are any (get_comp_lights): each particle is tinted by the sum of their
// colours × intensities, After Effects' "Light Reflection" in miniature.
//
// Deterministic: a particle's position is a pure function of its index, the
// seed and the layer time — no state carried from frame to frame, so any
// frame renders alone, in any order, identically in preview and export.
//
// Apply to a comp-sized layer at the comp's origin (the projected positions are
// comp pixels, drawn in the layer's own pixel space).
//
//   Emitter (layer) · Count · Speed · Spread · Lifetime · Size · Gravity · Color · Seed
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

#include "sample_util.hpp"

namespace {

enum : uint32_t { kEmitter = 1, kCount = 2, kSpeed = 3, kSpread = 4, kLife = 5, kSize = 6, kGravity = 7, kColor = 8, kSeed = 9 };

/// SDK 1.1 callbacks exist on this host (the suite is appended to, never reordered).
bool has_scene_suite(const PrInData* in) {
  return in->host->struct_size >= offsetof(PrHostSuite, get_layer_transform) + sizeof(void*);
}

uint32_t hash(uint32_t x) {
  x ^= x >> 16U;
  x *= 0x7FEB352DU;
  x ^= x >> 15U;
  x *= 0x846CA68BU;
  x ^= x >> 16U;
  return x;
}
double unit(uint32_t seed, uint32_t i, uint32_t k) { return static_cast<double>(hash(seed * 0x9E3779B9U + i * 0x85EBCA6BU + k)) / 4294967296.0; }

using V3 = std::array<double, 3>;
using M4 = std::array<double, 16>;

V3 mul_point(const double* m, const V3& p, double& w) {
  // Column-major 4×4 × (p, 1).
  const double x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];   // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];   // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];               // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return {x, y, z};
}

struct Dot {
  double x = 0, y = 0, radius = 0;
  float alpha = 0;
  double depth = 0;
};

PrErr params_setup(const PrInData* in) {
  PrErr e = prs::add_simple(in, PR_PARAM_LAYER, kEmitter, "Emitter", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kCount, "Particles", 200, 0, 5000, 0, 1000, 0);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSpeed, "Velocity", 180, 0, 5000, 0, 1000, 1);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSpread, "Spread", 60, 0, 180, 0, 180, 1);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kLife, "Life (sec)", 2, 0.05, 30, 0.1, 10, 2);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSize, "Size", 6, 0, 200, 0, 50, 1);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kGravity, "Gravity", 0, -2000, 2000, -500, 500, 1);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_COLOR, kColor, "Color", {1, 0.85, 0.4, 1});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSeed, "Random Seed", 1, 0, 100000, 0, 1000, 0);
  return e;
}

PrErr smart_render(const PrInData* in, PrParamDef* const* params) {
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  if (!has_scene_suite(in)) return PR_ERR_BAD_VERSION;  // needs a 1.1 host (the manifest says so too)

  PrCamera cam{};
  cam.struct_size = sizeof(cam);
  if (PrErr e = in->host->get_comp_camera(in->host_ref, in->current_time, &cam); e != PR_ERR_NONE) return e;

  std::array<PrLight, PR_MAX_LIGHTS> lights{};
  for (PrLight& l : lights) l.struct_size = sizeof(PrLight);
  uint32_t nLights = 0;
  if (PrErr e = in->host->get_comp_lights(in->host_ref, in->current_time, lights.data(), PR_MAX_LIGHTS, &nLights); e != PR_ERR_NONE) return e;
  std::array<double, 3> tint{1, 1, 1};
  if (nLights > 0) {
    tint = {0, 0, 0};
    for (uint32_t i = 0; i < std::min<uint32_t>(nLights, PR_MAX_LIGHTS); ++i) {
      for (std::size_t c = 0; c < 3; ++c) tint.at(c) += lights.at(i).color[c] * lights.at(i).intensity;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    }
  }

  // The emitter: the Emitter layer's origin in world space, else the comp's centre.
  V3 origin{cam.film_width / 2, cam.film_height / 2, 0};
  std::array<double, 16> lm{};
  const uint32_t emitterIndex = [&] {
    for (uint32_t i = 1; i < in->num_params; ++i) {
      if (params[i] != nullptr && params[i]->id == kEmitter) return i;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
    return 0U;
  }();
  if (emitterIndex != 0 && in->host->get_layer_transform(in->host_ref, emitterIndex, in->current_time, lm.data()) == PR_ERR_NONE) {
    origin = {lm[12], lm[13], lm[14]};
  }

  const auto count = static_cast<uint32_t>(std::clamp(prs::num(params, in, kCount), 0.0, 5000.0));
  const double speed = prs::num(params, in, kSpeed);
  const double spread = prs::num(params, in, kSpread) * 3.14159265358979323846 / 180;
  const double life = std::max(0.05, prs::num(params, in, kLife));
  const double size = prs::num(params, in, kSize);
  const double gravity = prs::num(params, in, kGravity);
  const auto seed = static_cast<uint32_t>(prs::num(params, in, kSeed));
  const double t = static_cast<double>(in->current_time) / PR_TIME_SCALE;
  const double scale = std::max(1e-6, 0.5 * (in->pixel_scale_x + in->pixel_scale_y));

  std::vector<Dot> dots;
  dots.reserve(count);
  for (uint32_t i = 0; i < count; ++i) {
    // Born uniformly over one lifetime and reborn every lifetime: a steady stream.
    const double age = std::fmod(t + unit(seed, i, 0) * life, life);
    const double a = unit(seed, i, 1) * 2 * 3.14159265358979323846;
    const double cone = std::acos(1 - unit(seed, i, 2) * (1 - std::cos(spread)));
    const double v = speed * (0.6 + 0.4 * unit(seed, i, 3));
    // Emitted along -y (up the screen) inside a cone of half-angle `spread`.
    const V3 dir{std::sin(cone) * std::cos(a), -std::cos(cone), std::sin(cone) * std::sin(a)};
    const V3 p{origin[0] + dir[0] * v * age, origin[1] + dir[1] * v * age + 0.5 * gravity * age * age, origin[2] + dir[2] * v * age};
    double w = 1;
    const V3 vc = mul_point(cam.view, p, w);
    if (vc[2] <= 1) continue;  // behind (or at) the eye
    double cw = 1;
    const V3 clip = mul_point(cam.projection, vc, cw);
    if (cw <= 0) continue;
    Dot d;
    d.x = clip[0] / cw;
    d.y = clip[1] / cw;
    d.depth = vc[2];
    d.radius = std::max(0.5, size * cam.zoom / vc[2] / 2) * scale;
    d.alpha = static_cast<float>(1 - age / life);
    dots.push_back(d);
  }
  // Far to near, so nearer particles cover farther ones.
  std::ranges::sort(dots, [](const Dot& x, const Dot& y) { return x.depth > y.depth; });

  const prs::Px color{static_cast<float>(prs::num(params, in, kColor, 0) * tint[0]), static_cast<float>(prs::num(params, in, kColor, 1) * tint[1]),
                      static_cast<float>(prs::num(params, in, kColor, 2) * tint[2]), 1};
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) prs::write(*dst, x, y, {});
    for (const Dot& d : dots) {
      const auto c = prs::to_world(in, d.x, d.y);
      if (y + 0.5 < c[1] - d.radius - 1 || y + 0.5 > c[1] + d.radius + 1) continue;
      const auto x0 = static_cast<int32_t>(std::max(0.0, std::floor(c[0] - d.radius - 1)));
      const auto x1 = static_cast<int32_t>(std::min(static_cast<double>(dst->width - 1), std::ceil(c[0] + d.radius + 1)));
      for (int32_t x = x0; x <= x1; ++x) {
        const double r = std::hypot(x + 0.5 - c[0], y + 0.5 - c[1]);
        const auto cov = static_cast<float>(std::clamp(d.radius + 0.5 - r, 0.0, 1.0)) * d.alpha;
        if (cov <= 0) continue;
        // Premultiplied "over".
        const prs::Px under = prs::read(*dst, x, y);
        prs::write(*dst, x, y, color * cov + under * (1 - cov));
      }
    }
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL particles_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                             void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Particles 1.0 — Premation SDK 1.1 sample (comp camera, lights, layer transforms)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_GENERATOR |
                       PR_OUT_FLAG_NON_PARAM_VARY | PR_OUT_FLAG_THREADED_RENDER | PR_OUT_FLAG_USES_CAMERA | PR_OUT_FLAG_USES_LIGHTS |
                       PR_OUT_FLAG_USES_LAYER_TRANSFORMS;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in);
    case PR_CMD_SMART_PRE_RENDER: return PR_ERR_NONE;  // a generator checks nothing out
    case PR_CMD_SMART_RENDER: return smart_render(in, params);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.particles", &particles_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.particles", 1, kEffects};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
