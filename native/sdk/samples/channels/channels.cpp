// Sample (SDK 1.4, C): PUBLISHED CHANNELS — plugin instances talking to each other.
//
//   Controller  publishes "pulse" each frame: [Strength × (0.5 + 0.5 sin 2π · Rate · layer time),
//               Strength, layer time] (PR_OUT_FLAG_PUBLISHES, PR_CMD_PUBLISH_CHANNELS).
//   Follower    reads "pulse" (read_channel) and fills the layer with its Color at that strength.
//               With no controller in the comp it draws nothing.
//   Ping / Pong publish "ping" / "pong" and each reads the other's: a cycle, which the host
//               refuses (both report on layerErrors and see no channel), never a hang.
//
// The manifest declares what each effect publishes and reads; the host runs the publishers of a
// frame in that order, on the document side, so a frame stays a function of the document.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <array>
#include <cmath>

#include "sample_util.hpp"

namespace {

enum : uint32_t { kStrength = 1, kRate = 2 };
enum : uint32_t { kColor = 1 };

bool has_channels(const PrInData* in) {
  return in->host->struct_size >= offsetof(PrHostSuite, read_channel) + sizeof(void*);
}

/// SMART_RENDER of an effect that draws nothing itself: its layer, unchanged.
PrErr pass_through(const PrInData* in) {
  PrWorld* src = nullptr;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &src); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (src == nullptr || dst == nullptr) return PR_ERR_NONE;
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      const int32_t sx = x + dst->origin_x - src->origin_x;
      const int32_t sy = y + dst->origin_y - src->origin_y;
      const bool in_src = sx >= 0 && sy >= 0 && sx < src->width && sy < src->height;
      prs::write(*dst, x, y, in_src ? prs::read(*src, sx, sy) : prs::Px{});
    }
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr pre_render_input(const PrInData* in) { return in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr); }

double seconds(const PrInData* in) {
  return static_cast<double>(in->current_time) / static_cast<double>(PR_TIME_SCALE);
}

// ── Controller ──────────────────────────────────────────────────────────

PrErr controller_publish(const PrInData* in, PrParamDef* const* params) {
  if (!has_channels(in)) return PR_ERR_BAD_VERSION;
  const double strength = prs::num(params, in, kStrength) / 100;
  const double rate = prs::num(params, in, kRate);
  const double t = seconds(in);
  const std::array<double, 3> pulse{strength * (0.5 + 0.5 * std::sin(2 * 3.141592653589793 * rate * t)), strength, t};
  return in->host->publish_channel(in->host_ref, "pulse", pulse.data(), static_cast<uint32_t>(pulse.size()));
}

PrErr PR_CALL controller_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/, void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Controller 1.0 — publishes the \"pulse\" channel (SDK 1.4 sample)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      // It draws nothing itself: it passes its layer through.
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                       PR_OUT_FLAG_THREADED_RENDER | PR_OUT_FLAG_NON_PARAM_VARY | PR_OUT_FLAG_PUBLISHES;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP:
      if (PrErr e = prs::add_float(in, kStrength, "Strength", 100, 0, 100, 0, 100, 0); e != PR_ERR_NONE) return e;
      return prs::add_float(in, kRate, "Rate (Hz)", 1, 0, 60, 0, 10, 2);
    case PR_CMD_PUBLISH_CHANNELS: return controller_publish(in, params);
    case PR_CMD_SMART_PRE_RENDER: return pre_render_input(in);
    case PR_CMD_SMART_RENDER: return pass_through(in);
    default: return PR_ERR_NONE;
  }
}

// ── Follower ────────────────────────────────────────────────────────────

PrErr follower_render(const PrInData* in, PrParamDef* const* params) {
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  std::array<double, 3> pulse{};
  uint32_t count = 0;
  const bool have = has_channels(in) &&
                    in->host->read_channel(in->host_ref, "pulse", pulse.data(), static_cast<uint32_t>(pulse.size()), &count) == PR_ERR_NONE &&
                    count >= 1;
  const float k = have ? static_cast<float>(std::clamp(pulse[0], 0.0, 1.0)) : 0.0F;
  const auto a = static_cast<float>(prs::num(params, in, kColor, 3)) * k;
  const prs::Px fill{static_cast<float>(prs::num(params, in, kColor, 0)) * a, static_cast<float>(prs::num(params, in, kColor, 1)) * a,
                     static_cast<float>(prs::num(params, in, kColor, 2)) * a, a};
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) prs::write(*dst, x, y, fill);
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL follower_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/, void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Follower 1.0 — fills its layer at the \"pulse\" channel's strength (SDK 1.4 sample)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_GENERATOR |
                       PR_OUT_FLAG_THREADED_RENDER;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return prs::add_simple(in, PR_PARAM_COLOR, kColor, "Color", {0.2, 0.7, 1.0, 1.0});
    case PR_CMD_SMART_PRE_RENDER: return PR_ERR_NONE;
    case PR_CMD_SMART_RENDER: return follower_render(in, params);
    default: return PR_ERR_NONE;
  }
}

// ── Ping / Pong (a cycle) ───────────────────────────────────────────────

PrErr echo(const PrInData* in, const char* reads, const char* publishes) {
  if (!has_channels(in)) return PR_ERR_BAD_VERSION;
  double v = 0;
  uint32_t count = 0;
  if (in->host->read_channel(in->host_ref, reads, &v, 1, &count) != PR_ERR_NONE) v = 0;
  const double next = v + 1;
  return in->host->publish_channel(in->host_ref, publishes, &next, 1);
}

PrErr PR_CALL ping_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* /*params*/, PrWorld* /*output*/, void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_PUBLISHES;
      return PR_ERR_NONE;
    case PR_CMD_PUBLISH_CHANNELS: return echo(in, "pong", "ping");
    case PR_CMD_SMART_PRE_RENDER: return pre_render_input(in);
    case PR_CMD_SMART_RENDER: return pass_through(in);
    default: return PR_ERR_NONE;
  }
}

PrErr PR_CALL pong_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* /*params*/, PrWorld* /*output*/, void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_PUBLISHES;
      return PR_ERR_NONE;
    case PR_CMD_PUBLISH_CHANNELS: return echo(in, "ping", "pong");
    case PR_CMD_SMART_PRE_RENDER: return pre_render_input(in);
    case PR_CMD_SMART_RENDER: return pass_through(in);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
    {"com.premation.samples.channels.controller", &controller_main},
    {"com.premation.samples.channels.follower", &follower_main},
    {"com.premation.samples.channels.ping", &ping_main},
    {"com.premation.samples.channels.pong", &pong_main}};
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.channels", 4, kEffects, 0, nullptr, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
