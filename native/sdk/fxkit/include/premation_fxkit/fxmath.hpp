// fxmath — the WGSL builtins in C++, so a kernel written once in fx/*.fx runs on the CPU with
// the same maths it runs with on the GPU (fxkit.mjs transpiles the kernels against this).
//
// Semantics follow the WGSL spec where it matters for parity: fract = x - floor(x), round is
// half-to-even, mix = a·(1 − t) + b·t, clamp = min(max(x, lo), hi), f32 → i32 truncates and
// clamps. Built with -ffp-contract=off so nothing is fused behind our back.
#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <limits>

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wconversion"
#pragma clang diagnostic ignored "-Wimplicit-float-conversion"
#pragma clang diagnostic ignored "-Wimplicit-int-float-conversion"
#pragma clang diagnostic ignored "-Wshorten-64-to-32"
#pragma clang diagnostic ignored "-Wfloat-conversion"
#pragma clang diagnostic ignored "-Wsign-conversion"
#endif

namespace fxk {

using f32 = float;
using i32 = std::int32_t;
using u32 = std::uint32_t;

struct vec2f;
struct vec3f;
struct vec4f;
struct vec2i;

struct vec2f {
  float x = 0, y = 0;
  constexpr vec2f() = default;
  constexpr explicit vec2f(float s) : x(s), y(s) {}
  constexpr vec2f(float a, float b) : x(a), y(b) {}
  constexpr explicit vec2f(const vec2i& v);
#include "swz_vec2.inc"
};

struct vec3f {
  float x = 0, y = 0, z = 0;
  constexpr vec3f() = default;
  constexpr explicit vec3f(float s) : x(s), y(s), z(s) {}
  constexpr vec3f(float a, float b, float c) : x(a), y(b), z(c) {}
  constexpr vec3f(vec2f v, float c) : x(v.x), y(v.y), z(c) {}
  constexpr vec3f(float a, vec2f v) : x(a), y(v.x), z(v.y) {}
#include "swz_vec3.inc"
};

struct vec4f {
  float x = 0, y = 0, z = 0, w = 0;
  constexpr vec4f() = default;
  constexpr explicit vec4f(float s) : x(s), y(s), z(s), w(s) {}
  constexpr vec4f(float a, float b, float c, float d) : x(a), y(b), z(c), w(d) {}
  constexpr vec4f(vec3f v, float d) : x(v.x), y(v.y), z(v.z), w(d) {}
  constexpr vec4f(float a, vec3f v) : x(a), y(v.x), z(v.y), w(v.z) {}
  constexpr vec4f(vec2f v, float c, float d) : x(v.x), y(v.y), z(c), w(d) {}
  constexpr vec4f(vec2f a, vec2f b) : x(a.x), y(a.y), z(b.x), w(b.y) {}
  constexpr vec4f(float a, float b, vec2f v) : x(a), y(b), z(v.x), w(v.y) {}
  constexpr vec4f(float a, vec2f v, float d) : x(a), y(v.x), z(v.y), w(d) {}
#include "swz_vec4.inc"
};

/// WGSL f32 → i32: truncate toward zero, clamp to the representable range (NaN → 0).
constexpr i32 to_i32(float v) {
  if (!(v == v)) return 0;
  if (v >= 2147483520.0F) return 2147483520;
  if (v <= -2147483648.0F) return std::numeric_limits<i32>::min();
  return static_cast<i32>(v);
}
constexpr i32 to_i32(i32 v) { return v; }
constexpr i32 to_i32(u32 v) { return static_cast<i32>(v); }
constexpr i32 to_i32(bool v) { return v ? 1 : 0; }
constexpr u32 to_u32(float v) {
  if (!(v == v) || v <= 0.0F) return 0;
  if (v >= 4294967040.0F) return 4294967040U;
  return static_cast<u32>(v);
}
constexpr u32 to_u32(i32 v) { return static_cast<u32>(v); }
constexpr u32 to_u32(u32 v) { return v; }
constexpr u32 to_u32(bool v) { return v ? 1U : 0U; }
constexpr float to_f32(float v) { return v; }
constexpr float to_f32(double v) { return static_cast<float>(v); }
constexpr float to_f32(i32 v) { return static_cast<float>(v); }
constexpr float to_f32(u32 v) { return static_cast<float>(v); }
constexpr float to_f32(bool v) { return v ? 1.0F : 0.0F; }

struct vec2i {
  i32 x = 0, y = 0;
  constexpr vec2i() = default;
  constexpr explicit vec2i(i32 s) : x(s), y(s) {}
  constexpr vec2i(i32 a, i32 b) : x(a), y(b) {}
  constexpr explicit vec2i(vec2f v) : x(to_i32(v.x)), y(to_i32(v.y)) {}
};
constexpr vec2f::vec2f(const vec2i& v) : x(static_cast<float>(v.x)), y(static_cast<float>(v.y)) {}

#include "swz_defs.inc"

// ── operators (component-wise, scalar broadcast both ways) ──────────────────
#define FXK_OPS(V, N)                                                                    \
  constexpr V operator+(V a, V b) { return N(+); }                                       \
  constexpr V operator-(V a, V b) { return N(-); }                                       \
  constexpr V operator*(V a, V b) { return N(*); }                                       \
  constexpr V operator/(V a, V b) { return N(/); }                                       \
  constexpr V operator+(V a, float s) { return a + V(s); }                               \
  constexpr V operator-(V a, float s) { return a - V(s); }                               \
  constexpr V operator*(V a, float s) { return a * V(s); }                               \
  constexpr V operator/(V a, float s) { return a / V(s); }                               \
  constexpr V operator+(float s, V a) { return V(s) + a; }                               \
  constexpr V operator-(float s, V a) { return V(s) - a; }                               \
  constexpr V operator*(float s, V a) { return V(s) * a; }                               \
  constexpr V operator/(float s, V a) { return V(s) / a; }                               \
  constexpr V operator-(V a) { return V(0.0F) - a; }                                     \
  constexpr V& operator+=(V& a, V b) { return a = a + b; }                               \
  constexpr V& operator-=(V& a, V b) { return a = a - b; }                               \
  constexpr V& operator*=(V& a, V b) { return a = a * b; }                               \
  constexpr V& operator/=(V& a, V b) { return a = a / b; }                               \
  constexpr V& operator+=(V& a, float s) { return a = a + s; }                           \
  constexpr V& operator-=(V& a, float s) { return a = a - s; }                           \
  constexpr V& operator*=(V& a, float s) { return a = a * s; }                           \
  constexpr V& operator/=(V& a, float s) { return a = a / s; }

#define FXK_N2(op) vec2f(a.x op b.x, a.y op b.y)
#define FXK_N3(op) vec3f(a.x op b.x, a.y op b.y, a.z op b.z)
#define FXK_N4(op) vec4f(a.x op b.x, a.y op b.y, a.z op b.z, a.w op b.w)
FXK_OPS(vec2f, FXK_N2)
FXK_OPS(vec3f, FXK_N3)
FXK_OPS(vec4f, FXK_N4)
#undef FXK_OPS
#undef FXK_N2
#undef FXK_N3
#undef FXK_N4

constexpr vec2i operator+(vec2i a, vec2i b) { return {a.x + b.x, a.y + b.y}; }
constexpr vec2i operator-(vec2i a, vec2i b) { return {a.x - b.x, a.y - b.y}; }
constexpr vec2i operator*(vec2i a, i32 s) { return {a.x * s, a.y * s}; }
constexpr vec2i min(vec2i a, vec2i b) { return {b.x < a.x ? b.x : a.x, b.y < a.y ? b.y : a.y}; }
constexpr vec2i max(vec2i a, vec2i b) { return {a.x < b.x ? b.x : a.x, a.y < b.y ? b.y : a.y}; }
constexpr vec2i clamp(vec2i v, vec2i lo, vec2i hi) { return min(max(v, lo), hi); }
constexpr vec2i abs(vec2i v) { return {v.x < 0 ? -v.x : v.x, v.y < 0 ? -v.y : v.y}; }

// ── component-wise application ──────────────────────────────────────────────
template <class F> constexpr vec2f map(vec2f a, F f) { return {f(a.x), f(a.y)}; }
template <class F> constexpr vec3f map(vec3f a, F f) { return {f(a.x), f(a.y), f(a.z)}; }
template <class F> constexpr vec4f map(vec4f a, F f) { return {f(a.x), f(a.y), f(a.z), f(a.w)}; }
template <class F> constexpr vec2f map2(vec2f a, vec2f b, F f) { return {f(a.x, b.x), f(a.y, b.y)}; }
template <class F> constexpr vec3f map2(vec3f a, vec3f b, F f) { return {f(a.x, b.x), f(a.y, b.y), f(a.z, b.z)}; }
template <class F> constexpr vec4f map2(vec4f a, vec4f b, F f) { return {f(a.x, b.x), f(a.y, b.y), f(a.z, b.z), f(a.w, b.w)}; }
template <class F> constexpr vec2f map3(vec2f a, vec2f b, vec2f c, F f) { return {f(a.x, b.x, c.x), f(a.y, b.y, c.y)}; }
template <class F> constexpr vec3f map3(vec3f a, vec3f b, vec3f c, F f) { return {f(a.x, b.x, c.x), f(a.y, b.y, c.y), f(a.z, b.z, c.z)}; }
template <class F> constexpr vec4f map3(vec4f a, vec4f b, vec4f c, F f) {
  return {f(a.x, b.x, c.x), f(a.y, b.y, c.y), f(a.z, b.z, c.z), f(a.w, b.w, c.w)};
}

// scalar builtins
inline float abs(float v) { return std::fabs(v); }
constexpr i32 abs(i32 v) { return v < 0 ? -v : v; }
inline float sign(float v) { return v > 0 ? 1.0F : v < 0 ? -1.0F : 0.0F; }
inline float floor(float v) { return std::floor(v); }
inline float ceil(float v) { return std::ceil(v); }
inline float round(float v) { return std::nearbyint(v); }  // half to even (default rounding mode)
inline float trunc(float v) { return std::trunc(v); }
inline float fract(float v) { return v - std::floor(v); }
inline float sqrt(float v) { return std::sqrt(v); }
inline float inverseSqrt(float v) { return 1.0F / std::sqrt(v); }
inline float exp(float v) { return std::exp(v); }
inline float exp2(float v) { return std::exp2(v); }
inline float log(float v) { return std::log(v); }
inline float log2(float v) { return std::log2(v); }
inline float pow(float a, float b) { return std::pow(a, b); }
inline float sin(float v) { return std::sin(v); }
inline float cos(float v) { return std::cos(v); }
inline float tan(float v) { return std::tan(v); }
inline float asin(float v) { return std::asin(v); }
inline float acos(float v) { return std::acos(v); }
inline float atan(float v) { return std::atan(v); }
inline float atan2(float y, float x) { return std::atan2(y, x); }
inline float sinh(float v) { return std::sinh(v); }
inline float cosh(float v) { return std::cosh(v); }
inline float tanh(float v) { return std::tanh(v); }
constexpr float min(float a, float b) { return b < a ? b : a; }
constexpr float max(float a, float b) { return a < b ? b : a; }
constexpr i32 min(i32 a, i32 b) { return b < a ? b : a; }
constexpr i32 max(i32 a, i32 b) { return a < b ? b : a; }
constexpr u32 min(u32 a, u32 b) { return b < a ? b : a; }
constexpr u32 max(u32 a, u32 b) { return a < b ? b : a; }
constexpr float clamp(float v, float lo, float hi) { return min(max(v, lo), hi); }
constexpr i32 clamp(i32 v, i32 lo, i32 hi) { return min(max(v, lo), hi); }
constexpr float mix(float a, float b, float t) { return a * (1.0F - t) + b * t; }
constexpr float step(float edge, float v) { return v < edge ? 0.0F : 1.0F; }
constexpr float saturate(float v) { return clamp(v, 0.0F, 1.0F); }
constexpr float smoothstep(float lo, float hi, float v) {
  const float t = clamp((v - lo) / (hi - lo), 0.0F, 1.0F);
  return t * t * (3.0F - 2.0F * t);
}
constexpr float degrees(float r) { return r * 57.295779513082322865F; }
constexpr float radians(float d) { return d * 0.017453292519943295F; }
template <class T> constexpr T select(T f, T t, bool c) { return c ? t : f; }

// vector builtins
#define FXK_V1(fn)                                                           \
  inline vec2f fn(vec2f a) { return map(a, [](float v) { return fn(v); }); } \
  inline vec3f fn(vec3f a) { return map(a, [](float v) { return fn(v); }); } \
  inline vec4f fn(vec4f a) { return map(a, [](float v) { return fn(v); }); }
FXK_V1(abs)
FXK_V1(sign)
FXK_V1(floor)
FXK_V1(ceil)
FXK_V1(round)
FXK_V1(trunc)
FXK_V1(fract)
FXK_V1(sqrt)
FXK_V1(inverseSqrt)
FXK_V1(exp)
FXK_V1(exp2)
FXK_V1(log)
FXK_V1(log2)
FXK_V1(sin)
FXK_V1(cos)
FXK_V1(tan)
FXK_V1(asin)
FXK_V1(acos)
FXK_V1(atan)
FXK_V1(tanh)
FXK_V1(saturate)
#undef FXK_V1
#define FXK_V2(fn)                                                                               \
  inline vec2f fn(vec2f a, vec2f b) { return map2(a, b, [](float x, float y) { return fn(x, y); }); } \
  inline vec3f fn(vec3f a, vec3f b) { return map2(a, b, [](float x, float y) { return fn(x, y); }); } \
  inline vec4f fn(vec4f a, vec4f b) { return map2(a, b, [](float x, float y) { return fn(x, y); }); }
FXK_V2(pow)
FXK_V2(min)
FXK_V2(max)
FXK_V2(atan2)
FXK_V2(step)
#undef FXK_V2
#define FXK_V3(fn)                                                                                                            \
  inline vec2f fn(vec2f a, vec2f b, vec2f c) { return map3(a, b, c, [](float x, float y, float z) { return fn(x, y, z); }); } \
  inline vec3f fn(vec3f a, vec3f b, vec3f c) { return map3(a, b, c, [](float x, float y, float z) { return fn(x, y, z); }); } \
  inline vec4f fn(vec4f a, vec4f b, vec4f c) { return map3(a, b, c, [](float x, float y, float z) { return fn(x, y, z); }); }
FXK_V3(clamp)
FXK_V3(mix)
FXK_V3(smoothstep)
#undef FXK_V3
// WGSL overloads with a scalar for the last argument (mix's t) or the bounds (clamp, smoothstep).
inline vec2f mix(vec2f a, vec2f b, float t) { return mix(a, b, vec2f(t)); }
inline vec3f mix(vec3f a, vec3f b, float t) { return mix(a, b, vec3f(t)); }
inline vec4f mix(vec4f a, vec4f b, float t) { return mix(a, b, vec4f(t)); }

constexpr float dot(vec2f a, vec2f b) { return a.x * b.x + a.y * b.y; }
constexpr float dot(vec3f a, vec3f b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
constexpr float dot(vec4f a, vec4f b) { return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w; }
inline float length(vec2f a) { return std::sqrt(dot(a, a)); }
inline float length(vec3f a) { return std::sqrt(dot(a, a)); }
inline float length(vec4f a) { return std::sqrt(dot(a, a)); }
inline float length(float a) { return std::fabs(a); }
inline float distance(vec2f a, vec2f b) { return length(a - b); }
inline float distance(vec3f a, vec3f b) { return length(a - b); }
inline vec2f normalize(vec2f a) { return a / length(a); }
inline vec3f normalize(vec3f a) { return a / length(a); }
inline vec4f normalize(vec4f a) { return a / length(a); }
constexpr vec3f cross(vec3f a, vec3f b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
constexpr vec2f reflect(vec2f i, vec2f n) { return i - 2.0F * dot(n, i) * n; }
constexpr vec3f reflect(vec3f i, vec3f n) { return i - 2.0F * dot(n, i) * n; }

}  // namespace fxk

#if defined(__clang__)
#pragma clang diagnostic pop
#endif
