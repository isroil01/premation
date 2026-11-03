// fxkit runtime: the C++ twin of prelude.wgsl (kit::Ctx) and the tables the generated
// effects (<project>/gen/fx_gen.hpp) are described by. Every helper here mirrors its WGSL namesake.
#pragma once

#include <premation_sdk/premation_sdk.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <iterator>
#include <vector>

#include "fxmath.hpp"

namespace fxk::kit {

/// The frame uniform block (prelude.wgsl `Frame`), byte for byte.
struct Frame {
  vec2f size;
  vec2f layer;
  vec4f l2w_a, l2w_b, w2l_a, w2l_b;
  float time = 0, scale = 1, quality = 1, debug = 0;
  vec2f comp;
  float fps = 30, has_aux = 0, comp_time = 0, levels = 0, pad0 = 0, pad1 = 0;
};
static_assert(sizeof(Frame) == 128, "Frame must match the WGSL struct");

/// A float RGBA image (premultiplied, linear) — the CPU twin of a texture.
struct Img {
  int w = 0, h = 0;
  std::vector<vec4f> px;
  void resize(int width, int height) {
    w = width < 1 ? 1 : width;
    h = height < 1 ? 1 : height;
    px.assign(static_cast<std::size_t>(w) * static_cast<std::size_t>(h), vec4f(0.0F));
  }
  [[nodiscard]] vec4f at(int x, int y) const {
    if (x < 0 || y < 0 || x >= w || y >= h) return vec4f(0.0F);
    return px[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)];
  }
  vec4f& ref(int x, int y) { return px[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)]; }
};

struct ParamDesc {
  PrParamType type;
  std::uint32_t id;
  std::uint32_t flags;
  const char* name;
  std::array<double, 4> def;
  double lo, hi, slo, shi;
  int precision;
  const char* choices;
  const char* desc;
};

struct EffectDesc {
  const char* match_name;
  const char* name;
  const char* about;
  const ParamDesc* params;
  std::uint32_t param_count;
  int pyramid;         // pyramid levels the effect samples (0..6)
  int passes;          // intermediate passes before the final one (0..2)
  const char* expand;  // the buffer growth expression's text (documentation; expand_px computes it)
  std::uint32_t out_flags;
  const char* wgsl;
  std::uint32_t param_bytes;
  std::uint32_t layer_param;  // the aux LAYER param's id (0 = none)
};

/// Reads params[] for the generated fill(): points to world px, px lengths scaled, colours linear.
struct ParamReader {
  const PrInData* in = nullptr;
  PrParamDef* const* params = nullptr;
  [[nodiscard]] const PrParamDef* find(std::uint32_t id) const {
    if (params == nullptr || in == nullptr) return nullptr;
    for (std::uint32_t i = 1; i < in->num_params; ++i) {
      const PrParamDef* p = params[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      if (p != nullptr && p->id == id) return p;
    }
    return nullptr;
  }
  [[nodiscard]] double raw(std::uint32_t id, std::size_t i = 0) const {
    const PrParamDef* p = find(id);
    return p == nullptr ? 0.0 : p->value[i];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  }
  [[nodiscard]] float number(std::uint32_t id) const { return static_cast<float>(raw(id)); }
  [[nodiscard]] i32 integer(std::uint32_t id) const { return static_cast<i32>(raw(id) + (raw(id) < 0 ? -0.5 : 0.5)); }
  [[nodiscard]] float scale() const {
    if (in == nullptr) return 1.0F;
    const double s = std::sqrt(std::fabs(in->pixel_scale_x * in->pixel_scale_y));
    return s > 0 && std::isfinite(s) ? static_cast<float>(s) : 1.0F;
  }
  [[nodiscard]] float pixels(std::uint32_t id) const { return number(id) * scale(); }
  [[nodiscard]] vec4f color(std::uint32_t id) const {
    const PrParamDef* p = find(id);
    if (p == nullptr) return vec4f(1.0F);
    return {static_cast<float>(p->value[0]), static_cast<float>(p->value[1]), static_cast<float>(p->value[2]), static_cast<float>(p->value[3])};
  }
  [[nodiscard]] vec2f point(std::uint32_t id) const {
    const double x = raw(id, 0);
    const double y = raw(id, 1);
    const double* m = in->layer_to_world;
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return {static_cast<float>(m[0] * x + m[1] * y + m[2]), static_cast<float>(m[3] * x + m[4] * y + m[5])};
  }
};

/// UPDATE_PARAMS_UI for the generated ui(): values by id, show / hide rows.
struct UiCtx {
  const PrInData* in = nullptr;
  PrParamDef* const* params = nullptr;
  [[nodiscard]] std::uint32_t index(std::uint32_t id) const {
    for (std::uint32_t i = 1; i < in->num_params; ++i) {
      if (params[i] != nullptr && params[i]->id == id) return i;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
    return 0;
  }
  [[nodiscard]] double v(std::uint32_t id) const {
    const std::uint32_t i = index(id);
    return i == 0 ? 0.0 : params[i]->value[0];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  [[nodiscard]] bool has_layer(std::uint32_t id) const {
    const std::uint32_t i = index(id);
    return i != 0 && params[i]->layer_id != nullptr && params[i]->layer_id[0] != '\0';  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  void show(std::uint32_t id, bool visible) const {
    const std::uint32_t i = index(id);
    if (i != 0) in->host->set_param_ui(in->host_ref, i, visible ? 0U : PR_PARAM_UI_HIDDEN, nullptr);
  }
};

/// The CPU twin of prelude.wgsl. Generated effects derive from it; fx/_lib.fx lands here as members.
struct Ctx {
  Frame fr{};
  const Img* t_src = nullptr;
  std::array<const Img*, 6> t_l{};
  const Img* t_pa = nullptr;
  const Img* t_pb = nullptr;
  const Img* t_aux = nullptr;

  [[nodiscard]] vec2f world_size() const { return fr.size; }
  [[nodiscard]] vec2f layer_size() const { return fr.layer; }
  [[nodiscard]] vec2f comp_size() const { return fr.comp; }
  [[nodiscard]] f32 time_s() const { return fr.time; }
  [[nodiscard]] f32 comp_time_s() const { return fr.comp_time; }
  [[nodiscard]] f32 fps() const { return fr.fps; }
  [[nodiscard]] f32 px_scale() const { return fr.scale; }
  [[nodiscard]] f32 quality() const { return fr.quality; }
  [[nodiscard]] i32 levels() const { return to_i32(fr.levels); }
  [[nodiscard]] bool has_aux() const { return fr.has_aux > 0.5F; }
  [[nodiscard]] vec2f to_layer(vec2f p) const {
    return {fr.w2l_a.x * p.x + fr.w2l_a.y * p.y + fr.w2l_a.z, fr.w2l_b.x * p.x + fr.w2l_b.y * p.y + fr.w2l_b.z};
  }
  [[nodiscard]] vec2f to_world(vec2f q) const {
    return {fr.l2w_a.x * q.x + fr.l2w_a.y * q.y + fr.l2w_a.z, fr.l2w_b.x * q.x + fr.l2w_b.y * q.y + fr.l2w_b.z};
  }
  [[nodiscard]] vec2f layer_uv(vec2f p) const { return to_layer(p) / max(fr.layer, vec2f(1.0F)); }
  [[nodiscard]] vec2f uv_to_world(vec2f uv) const { return to_world(uv * fr.layer); }

  [[nodiscard]] const Img* fxk_img(i32 t) const {
    if (t == 0) return t_src;
    if (t >= 1 && t <= 6) return t_l[static_cast<std::size_t>(t - 1)];
    if (t == 7) return t_pa;
    if (t == 8) return t_pb;
    return t_aux;
  }
  [[nodiscard]] vec4f fxk_tex(i32 t, vec2i i) const {
    const Img* m = fxk_img(t);
    return m == nullptr ? vec4f(0.0F) : m->at(i.x, i.y);
  }
  [[nodiscard]] vec2f fxk_dims(i32 t) const {
    const Img* m = fxk_img(t);
    return m == nullptr ? vec2f(1.0F) : vec2f(static_cast<float>(m->w), static_cast<float>(m->h));
  }
  [[nodiscard]] vec4f fxk_bilinear(i32 t, vec2f q) const {
    const vec2f f0 = floor(q - vec2f(0.5F));
    const vec2f f = q - vec2f(0.5F) - f0;
    const vec2i i(f0);
    const vec4f a = fxk_tex(t, i);
    const vec4f b = fxk_tex(t, i + vec2i(1, 0));
    const vec4f c = fxk_tex(t, i + vec2i(0, 1));
    const vec4f d = fxk_tex(t, i + vec2i(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  [[nodiscard]] vec4f fxk_bilinear_clamp(i32 t, vec2f q) const {
    const vec2f d = fxk_dims(t);
    return fxk_bilinear(t, clamp(q, vec2f(0.5F), d - vec2f(0.5F)));
  }
  [[nodiscard]] static vec4f fxk_bweights(f32 t) {
    const f32 s = 1.0F - t;
    return vec4f(s * s * s, 4.0F - 6.0F * t * t + 3.0F * t * t * t, 1.0F + 3.0F * t + 3.0F * t * t - 3.0F * t * t * t, t * t * t) * (1.0F / 6.0F);
  }
  [[nodiscard]] static f32 fxk_w4(vec4f w, i32 i) {
    if (i == 0) return w.x;
    if (i == 1) return w.y;
    if (i == 2) return w.z;
    return w.w;
  }
  [[nodiscard]] vec4f fxk_bspline(i32 t, vec2f q) const {
    const vec2f g = q - vec2f(0.5F);
    const vec2f f0 = floor(g);
    const vec2f f = g - f0;
    const vec2i i(f0);
    const vec4f wx = fxk_bweights(f.x);
    const vec4f wy = fxk_bweights(f.y);
    vec4f acc(0.0F);
    for (i32 y = 0; y < 4; y++) {
      vec4f row(0.0F);
      for (i32 x = 0; x < 4; x++) row += fxk_tex(t, i + vec2i(x - 1, y - 1)) * fxk_w4(wx, x);
      acc += row * fxk_w4(wy, y);
    }
    return acc;
  }
  /// One pyramid step from `prev` (the C++ side passes the level explicitly; WGSL binds it as t_src).
  [[nodiscard]] static vec4f fxk_down(const Img& prev, vec2i j) {
    const vec4f w(0.125F, 0.375F, 0.375F, 0.125F);
    vec4f acc(0.0F);
    for (i32 y = 0; y < 4; y++) {
      vec4f row(0.0F);
      for (i32 x = 0; x < 4; x++) row += prev.at(2 * j.x + x - 1, 2 * j.y + y - 1) * fxk_w4(w, x);
      acc += row * fxk_w4(w, y);
    }
    return acc;
  }

  [[nodiscard]] vec4f texel(vec2i i) const { return fxk_tex(0, i); }
  [[nodiscard]] vec4f src(vec2f p) const { return fxk_bilinear(0, p); }
  [[nodiscard]] vec4f src_clamp(vec2f p) const { return fxk_bilinear_clamp(0, p); }
  [[nodiscard]] vec4f level(i32 k, vec2f p) const {
    const i32 kk = min(k, levels());
    if (kk <= 0) return src(p);
    return fxk_bspline(kk, p / exp2(to_f32(kk)));
  }
  [[nodiscard]] vec4f pass_a(vec2f p) const { return fxk_bilinear(7, p); }
  [[nodiscard]] vec4f pass_b(vec2f p) const { return fxk_bilinear(8, p); }
  [[nodiscard]] vec4f pass_a_texel(vec2i i) const { return fxk_tex(7, i); }
  [[nodiscard]] vec4f pass_b_texel(vec2i i) const { return fxk_tex(8, i); }
  [[nodiscard]] vec4f aux(vec2f p) const { return fxk_bilinear(9, p); }
  [[nodiscard]] vec4f aux_clamp(vec2f p) const { return fxk_bilinear_clamp(9, p); }

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wconversion"
#pragma clang diagnostic ignored "-Wimplicit-float-conversion"
#pragma clang diagnostic ignored "-Wimplicit-int-float-conversion"
#pragma clang diagnostic ignored "-Wfloat-conversion"
#pragma clang diagnostic ignored "-Wsign-conversion"
#pragma clang diagnostic ignored "-Wshadow"
#pragma clang diagnostic ignored "-Wunused-variable"
#pragma clang diagnostic ignored "-Wfloat-equal"
#endif
#include "gen/lib.inc"
#if defined(__clang__)
#pragma clang diagnostic pop
#endif
};

}  // namespace fxk::kit
