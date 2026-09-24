// Shared helpers for the SDK samples (not part of the SDK itself): typed pixel
// access over the three world depths, bilinear sampling, parameter building,
// and the samples' fault injection (Debug ▸ Fault — how the engine's
// per-plugin crash isolation is proven; see docs/PLUGIN_SDK.md "Crash isolation").
//
// C++20, header-only, no exceptions escape (the SDK boundary is C).
#pragma once

#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

namespace prs {

/// An RGBA pixel in float, premultiplied (what every depth converts through).
struct Px {
  float r = 0, g = 0, b = 0, a = 0;
};

inline Px operator+(Px x, Px y) { return {x.r + y.r, x.g + y.g, x.b + y.b, x.a + y.a}; }
inline Px operator*(Px x, float k) { return {x.r * k, x.g * k, x.b * k, x.a * k}; }

inline float clamp01(float v) { return v < 0 ? 0.0F : v > 1 ? 1.0F : v; }

/// Read pixel (x, y) of a world as float 0..1 (32-bit: as stored). Out of bounds = transparent.
inline Px read(const PrWorld& w, int32_t x, int32_t y) {
  if (x < 0 || y < 0 || x >= w.width || y >= w.height || w.data == nullptr) return {};
  const auto* row = static_cast<const std::uint8_t*>(pr_world_row(&w, y));
  switch (w.format) {
    case PR_PIXEL_FORMAT_RGBA32F: {
      Px p;
      std::memcpy(&p, row + static_cast<std::size_t>(x) * 16, 16);
      return p;
    }
    case PR_PIXEL_FORMAT_RGBA16: {
      std::array<std::uint16_t, 4> v{};
      std::memcpy(v.data(), row + static_cast<std::size_t>(x) * 8, 8);
      constexpr float k = 1.0F / PR_MAX_CHANNEL16;
      return {static_cast<float>(v[0]) * k, static_cast<float>(v[1]) * k, static_cast<float>(v[2]) * k,
              static_cast<float>(v[3]) * k};
    }
    default: {
      const std::uint8_t* p = row + static_cast<std::size_t>(x) * 4;
      constexpr float k = 1.0F / PR_MAX_CHANNEL8;
      return {static_cast<float>(p[0]) * k, static_cast<float>(p[1]) * k, static_cast<float>(p[2]) * k,
              static_cast<float>(p[3]) * k};
    }
  }
}

/// Write pixel (x, y) (8/16-bit: clamped + rounded; 32-bit: as is).
inline void write(PrWorld& w, int32_t x, int32_t y, Px p) {
  if (x < 0 || y < 0 || x >= w.width || y >= w.height || w.data == nullptr) return;
  auto* row = static_cast<std::uint8_t*>(pr_world_row(&w, y));
  switch (w.format) {
    case PR_PIXEL_FORMAT_RGBA32F: std::memcpy(row + static_cast<std::size_t>(x) * 16, &p, 16); return;
    case PR_PIXEL_FORMAT_RGBA16: {
      const auto q = [](float v) { return static_cast<std::uint16_t>(std::lround(clamp01(v) * PR_MAX_CHANNEL16)); };
      const std::array<std::uint16_t, 4> v{q(p.r), q(p.g), q(p.b), q(p.a)};
      std::memcpy(row + static_cast<std::size_t>(x) * 8, v.data(), 8);
      return;
    }
    default: {
      std::uint8_t* o = row + static_cast<std::size_t>(x) * 4;
      const auto q = [](float v) { return static_cast<std::uint8_t>(std::lround(clamp01(v) * PR_MAX_CHANNEL8)); };
      o[0] = q(p.r);
      o[1] = q(p.g);
      o[2] = q(p.b);
      o[3] = q(p.a);
      return;
    }
  }
}

/// Bilinear sample at a continuous pixel position (pixel centres at +0.5), transparent outside.
inline Px sample(const PrWorld& w, double fx, double fy) {
  const double x = fx - 0.5;
  const double y = fy - 0.5;
  const double x0 = std::floor(x);
  const double y0 = std::floor(y);
  const auto tx = static_cast<float>(x - x0);
  const auto ty = static_cast<float>(y - y0);
  const auto ix = static_cast<int32_t>(x0);
  const auto iy = static_cast<int32_t>(y0);
  const Px a = read(w, ix, iy);
  const Px b = read(w, ix + 1, iy);
  const Px c = read(w, ix, iy + 1);
  const Px d = read(w, ix + 1, iy + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/// A parameter definition with the common fields filled.
inline PrParamDef param(PrParamType type, uint32_t id, const char* name) {
  PrParamDef d{};
  d.struct_size = sizeof(PrParamDef);
  d.type = type;
  d.id = id;
  d.name = name;
  return d;
}

inline PrErr add_float(const PrInData* in, uint32_t id, const char* name, double def, double lo, double hi, double sliderLo,
                       double sliderHi, int32_t precision, uint32_t flags = 0) {
  PrParamDef d = param(PR_PARAM_FLOAT_SLIDER, id, name);
  d.value[0] = def;
  d.valid_min = lo;
  d.valid_max = hi;
  d.slider_min = sliderLo;
  d.slider_max = sliderHi;
  d.precision = precision;
  d.flags = flags;
  return in->host->add_param(in->host_ref, &d);
}

inline PrErr add_simple(const PrInData* in, PrParamType type, uint32_t id, const char* name, std::array<double, 4> def,
                        uint32_t flags = 0, const char* choices = nullptr) {
  PrParamDef d = param(type, id, name);
  for (std::size_t i = 0; i < 4; ++i) d.value[i] = def[i];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  d.flags = flags;
  d.popup_choices = choices;
  return in->host->add_param(in->host_ref, &d);
}

/// Copy a message into PrOutData.return_msg.
inline void message(PrOutData* out, const char* text) {
  if (out == nullptr) return;
  std::snprintf(out->return_msg, sizeof(out->return_msg), "%s", text);
}

// ── fault injection (Debug ▸ Fault) ──────────────────────────────────────

inline constexpr uint32_t kFaultGroupId = 900;
inline constexpr uint32_t kFaultParamId = 901;
inline constexpr uint32_t kFaultGroupEndId = 902;
inline constexpr const char* kFaultChoices =
    "None|Access violation|Divide by zero|Stack overflow|C++ exception|Hang (1.5 s)|Error return|abort()";

enum class Fault : int { none = 1, access_violation, divide_by_zero, stack_overflow, cpp_exception, hang, error_return, abort_process };

/// Declare the Debug group (last in every sample's params).
inline PrErr add_fault_params(const PrInData* in) {
  PrErr e = add_simple(in, PR_PARAM_GROUP_START, kFaultGroupId, "Debug", {}, PR_PARAM_FLAG_START_COLLAPSED);
  if (e == PR_ERR_NONE) e = add_simple(in, PR_PARAM_POPUP, kFaultParamId, "Fault", {1, 0, 0, 0}, 0, kFaultChoices);
  if (e == PR_ERR_NONE) e = add_simple(in, PR_PARAM_GROUP_END, kFaultGroupEndId, "", {});
  return e;
}

/// Recursion the optimiser cannot turn into a loop (stack overflow fault).
inline int deep(int n) {  // NOLINT(misc-no-recursion): the point of it
  volatile char pad[4096];  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): a stack frame, on purpose
  pad[static_cast<std::size_t>(n) % sizeof(pad)] = static_cast<char>(n);
  return n <= 0 ? pad[0] : deep(n + 1) + pad[1];
}

[[noreturn]] inline void throw_cpp() { throw std::runtime_error("sample fault: C++ exception out of a render selector"); }

/// Commit the selected fault. Returns a PrErr for `error_return`; otherwise does not return normally
/// (except `hang`, which spins 1.5 s of wall time and then continues).
inline PrErr inject(const PrParamDef* p, PrOutData* out) {
  if (p == nullptr) return PR_ERR_NONE;
  switch (static_cast<Fault>(static_cast<int>(p->value[0]))) {
    case Fault::access_violation: {
      volatile int* bad = nullptr;
      *bad = 42;  // NOLINT(clang-analyzer-core.NullDereference): the fault being injected
      return PR_ERR_NONE;
    }
    case Fault::divide_by_zero: {
      volatile int zero = 0;
      volatile int x = 7 / zero;  // NOLINT(clang-analyzer-core.DivideZero): integer divide fault
      return x == 0 ? PR_ERR_INTERNAL : PR_ERR_NONE;
    }
    case Fault::stack_overflow: return deep(1) == 0 ? PR_ERR_NONE : PR_ERR_INTERNAL;
    case Fault::cpp_exception: throw_cpp();
    case Fault::hang: {
      // Wall time on purpose: the engine's watchdog is what this exercises.
      const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
      while (std::chrono::steady_clock::now() < until) {
      }
      return PR_ERR_NONE;
    }
    case Fault::error_return:
      message(out, "sample fault: the plugin reported an error");
      return PR_ERR_INTERNAL;
    case Fault::abort_process: std::abort();
    default: return PR_ERR_NONE;
  }
}

/// The params[] entry with disk id `id` (params[1..]), or nullptr.
inline const PrParamDef* by_id(PrParamDef* const* params, const PrInData* in, uint32_t id) {
  if (params == nullptr || in == nullptr) return nullptr;
  for (uint32_t i = 1; i < in->num_params; ++i) {
    if (params[i] != nullptr && params[i]->id == id) return params[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return nullptr;
}

inline double num(PrParamDef* const* params, const PrInData* in, uint32_t id, std::size_t i = 0, double def = 0) {
  const PrParamDef* p = by_id(params, in, id);
  return p == nullptr ? def : p->value[i];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
}

/// layer pixel → world pixel (PrInData.layer_to_world).
inline std::array<double, 2> to_world(const PrInData* in, double x, double y) {
  const double* m = in->layer_to_world;
  return {m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]};  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
}

/// Rows of the output, in parallel through the host (each row job is crash-guarded by the host).
template <class Fn>
PrErr for_rows(const PrInData* in, int32_t rows, Fn& fn) {
  struct Ctx {
    Fn* fn;
  } ctx{&fn};
  return in->host->iterate(in->host_ref, rows, &ctx, [](void* refcon, int32_t /*thread*/, int32_t i, int32_t /*count*/) -> PrErr {
    (*static_cast<Ctx*>(refcon)->fn)(i);
    return PR_ERR_NONE;
  });
}

}  // namespace prs
