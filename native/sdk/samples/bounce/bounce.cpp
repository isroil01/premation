// Sample (SDK 1.4, T): Bounce — a SIMULATION (PR_OUT_FLAG_STATEFUL). A ball falls under Gravity and
// bounces off the layer's edges, losing energy at each hit (Bounciness). Frame N depends on frame
// N-1, so the plugin keeps no cache of its own: the host calls PR_CMD_SIM_STEP once per layer frame
// from frame 0, keeps the states, and hands each frame's state to SMART_RENDER (get_sim_state).
// Scrubbing back costs no steps; keyframing Gravity at frame k re-steps from k only.
//
// The state is plain bytes (State below), in layer px. `seed` (per instance) picks the launch
// direction, so two bounces on two layers differ and both render the same everywhere.
//
// C2: when a Controller (the `channels` sample) publishes "pulse" in the comp, its strength pushes
// the ball sideways (kWindPerPulse px/s² at full strength), read at each step's own time.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <cmath>
#include <cstring>

#include "sample_util.hpp"

namespace {

enum : uint32_t { kGravity = 1, kBounciness = 2, kRadius = 3, kSpeed = 4, kColor = 5 };

struct State {
  double x, y, vx, vy;  // layer px, layer px per second
};

constexpr double kWindPerPulse = 1000;

/// The "pulse" channel's strength at this step, 0 without a controller (or an older host).
double pulse_of(const PrInData* in) {
  if (in->host->struct_size < offsetof(PrHostSuite, read_channel) + sizeof(void*)) return 0;
  double v[3] = {0, 0, 0};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
  uint32_t count = 0;
  if (in->host->read_channel(in->host_ref, "pulse", v, 3, &count) != PR_ERR_NONE || count == 0) return 0;
  return std::isfinite(v[0]) ? v[0] : 0;
}

PrErr params_setup(const PrInData* in) {
  if (PrErr e = prs::add_float(in, kGravity, "Gravity", 900, -10000, 10000, 0, 3000, 0); e != PR_ERR_NONE) return e;
  if (PrErr e = prs::add_float(in, kBounciness, "Bounciness", 80, 0, 100, 0, 100, 0); e != PR_ERR_NONE) return e;
  if (PrErr e = prs::add_float(in, kRadius, "Radius", 24, 1, 2000, 2, 200, 0); e != PR_ERR_NONE) return e;
  if (PrErr e = prs::add_float(in, kSpeed, "Launch Speed", 420, 0, 10000, 0, 2000, 0); e != PR_ERR_NONE) return e;
  return prs::add_simple(in, PR_PARAM_COLOR, kColor, "Color", {0.95, 0.35, 0.25, 1.0});
}

PrErr sim_step(const PrInData* in, PrParamDef* const* params, PrSimStepExtra* x) {
  if (x == nullptr || x->struct_size < sizeof(PrSimStepExtra)) return PR_ERR_BAD_VERSION;
  const double w = std::max(1, in->width);
  const double h = std::max(1, in->height);
  const double r = std::clamp(prs::num(params, in, kRadius), 1.0, std::min(w, h) / 2);
  State s{};
  if (x->state_in == nullptr || x->state_in_size < sizeof(State)) {
    // Frame 0: from the top centre, launched at an angle picked by the instance's seed.
    const double a = 0.25 + 0.5 * static_cast<double>(x->seed % 1000U) / 1000.0;  // 0.25..0.75 of a half turn
    const double speed = prs::num(params, in, kSpeed);
    s = {w / 2, r, speed * std::cos(a * 3.141592653589793), 0.0};
  } else {
    std::memcpy(&s, x->state_in, sizeof(State));
    const double g = prs::num(params, in, kGravity);
    const double keep = std::clamp(prs::num(params, in, kBounciness) / 100, 0.0, 1.0);
    s.vy += g * x->dt;
    s.vx += kWindPerPulse * pulse_of(in) * x->dt;
    s.x += s.vx * x->dt;
    s.y += s.vy * x->dt;
    if (s.x < r) { s.x = r; s.vx = std::abs(s.vx) * keep; }
    if (s.x > w - r) { s.x = w - r; s.vx = -std::abs(s.vx) * keep; }
    if (s.y < r) { s.y = r; s.vy = std::abs(s.vy) * keep; }
    if (s.y > h - r) { s.y = h - r; s.vy = -std::abs(s.vy) * keep; }
  }
  const PrHandle out = in->host->handle_new(in->host_ref, sizeof(State));
  if (out == 0) return PR_ERR_OUT_OF_MEMORY;
  std::memcpy(in->host->handle_lock(in->host_ref, out), &s, sizeof(State));
  x->state_out = out;
  return PR_ERR_NONE;
}

PrErr smart_render(const PrInData* in, PrParamDef* const* params) {
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const void* data = nullptr;
  uint32_t size = 0;
  State s{};
  const bool have = in->host->struct_size >= offsetof(PrHostSuite, get_sim_state) + sizeof(void*) &&
                    in->host->get_sim_state(in->host_ref, &data, &size) == PR_ERR_NONE && size >= sizeof(State);
  if (have) std::memcpy(&s, data, sizeof(State));
  const double r = std::max(1.0, prs::num(params, in, kRadius));
  const auto a = static_cast<float>(prs::num(params, in, kColor, 3));
  const prs::Px ball{static_cast<float>(prs::num(params, in, kColor, 0)) * a, static_cast<float>(prs::num(params, in, kColor, 1)) * a,
                     static_cast<float>(prs::num(params, in, kColor, 2)) * a, a};
  const double* m = in->layer_to_world;
  const double det = m[0] * m[4] - m[1] * m[3];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      prs::Px p{};
      if (have && det != 0) {
        const double wx = x + dst->origin_x + 0.5 - m[2];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        const double wy = y + dst->origin_y + 0.5 - m[5];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        const double lx = (m[4] * wx - m[1] * wy) / det;   // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        const double ly = (-m[3] * wx + m[0] * wy) / det;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        const double d = std::hypot(lx - s.x, ly - s.y) - r;
        p = ball * static_cast<float>(std::clamp(0.5 - d, 0.0, 1.0));
      }
      prs::write(*dst, x, y, p);
    }
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL bounce_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/, void* extra) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Bounce 1.0 — Premation SDK sample of a simulation (SDK 1.4, PR_OUT_FLAG_STATEFUL)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_GENERATOR |
                       PR_OUT_FLAG_THREADED_RENDER | PR_OUT_FLAG_STATEFUL;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in);
    case PR_CMD_SIM_STEP: return sim_step(in, params, static_cast<PrSimStepExtra*>(extra));
    case PR_CMD_SMART_PRE_RENDER: return PR_ERR_NONE;
    case PR_CMD_SMART_RENDER: return smart_render(in, params);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.bounce", &bounce_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.bounce", 1, kEffects, 0, nullptr, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
