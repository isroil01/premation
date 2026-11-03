// fxkit plugin runtime (docs/PLUGIN_SDK.md "Writing effects in WGSL: fxkit"). One module, every
// effect in the project's fx/*.fx. Compiled into each fxkit plugin by premation_add_fx_plugin().
//
// Each effect is a generated struct (<project>/gen/fx_gen.hpp, from fxkit.mjs): its params, its
// WGSL, and the same kernel transpiled to C++. This file is the one runtime they all share:
//
//   GLOBAL_SETUP / PARAMS_SETUP / UPDATE_PARAMS_UI   from the generated tables
//   SMART_PRE_RENDER                                 checkout input (+ aux layer), grow the buffer
//   SMART_RENDER                                     the CPU twin: pyramid → passes → final, rows in parallel
//   GPU_DEVICE_SETUP / SMART_RENDER_GPU              the same passes on the engine's Dawn device,
//                                                    pipelines built lazily on first use
//
// A kernel never sees the layer's bit depth: both paths work in float, premultiplied linear.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <vector>

#include "gen/fx_gen.hpp"

#ifdef FXKIT_GPU
#include <dawn/dawn_proc_table.h>
#include <webgpu/webgpu.h>
#endif

namespace fxk::kit {
namespace {

constexpr std::uint32_t kAuxCheckout = 1;
constexpr std::uint32_t kDebugId = 999;

void message(PrOutData* out, const char* text) {
  if (out != nullptr) std::snprintf(out->return_msg, sizeof(out->return_msg), "%s", text);
}

std::uint32_t index_of(const PrInData* in, PrParamDef* const* params, std::uint32_t id) {
  if (params == nullptr || id == 0) return 0;
  for (std::uint32_t i = 1; i < in->num_params; ++i) {
    if (params[i] != nullptr && params[i]->id == id) return i;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return 0;
}

bool layer_set(const PrInData* in, PrParamDef* const* params, std::uint32_t id) {
  const std::uint32_t i = index_of(in, params, id);
  return i != 0 && params[i]->layer_id != nullptr && params[i]->layer_id[0] != '\0';  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
}

PrErr params_setup(const PrInData* in, const EffectDesc& d) {
  for (std::uint32_t i = 0; i < d.param_count; ++i) {
    const ParamDesc& s = d.params[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    PrParamDef p{};
    p.struct_size = sizeof(PrParamDef);
    p.type = s.type;
    p.id = s.id;
    p.flags = s.flags;
    p.name = s.name;
    for (std::size_t k = 0; k < 4; ++k) p.value[k] = s.def[k];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    p.valid_min = s.lo;
    p.valid_max = s.hi;
    p.slider_min = s.slo;
    p.slider_max = s.shi;
    p.precision = s.precision;
    p.popup_choices = s.choices;
    p.description = s.desc;
    if (const PrErr e = in->host->add_param(in->host_ref, &p); e != PR_ERR_NONE) return e;
  }
  return PR_ERR_NONE;
}

/// The frame block both paths hand their kernels.
Frame frame_of(const PrInData* in, float worldW, float worldH, bool aux, int levels, bool debug) {
  Frame f{};
  f.size = vec2f(worldW, worldH);
  f.layer = vec2f(static_cast<float>(std::max(1, in->width)), static_cast<float>(std::max(1, in->height)));
  const double* m = in->layer_to_world;
  // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  f.l2w_a = vec4f(static_cast<float>(m[0]), static_cast<float>(m[1]), static_cast<float>(m[2]), 0.0F);
  f.l2w_b = vec4f(static_cast<float>(m[3]), static_cast<float>(m[4]), static_cast<float>(m[5]), 0.0F);
  const double det = m[0] * m[4] - m[1] * m[3];
  if (std::fabs(det) > 1e-12) {
    const double a = m[4] / det;
    const double b = -m[1] / det;
    const double c = -m[3] / det;
    const double dd = m[0] / det;
    f.w2l_a = vec4f(static_cast<float>(a), static_cast<float>(b), static_cast<float>(-(a * m[2] + b * m[5])), 0.0F);
    f.w2l_b = vec4f(static_cast<float>(c), static_cast<float>(dd), static_cast<float>(-(c * m[2] + dd * m[5])), 0.0F);
  } else {
    f.w2l_a = vec4f(1.0F, 0.0F, 0.0F, 0.0F);
    f.w2l_b = vec4f(0.0F, 1.0F, 0.0F, 0.0F);
  }
  // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double ts = in->time_scale != 0 ? static_cast<double>(in->time_scale) : static_cast<double>(PR_TIME_SCALE);
  f.time = static_cast<float>(static_cast<double>(in->current_time) / ts);
  f.comp_time = static_cast<float>(static_cast<double>(in->comp_time) / ts);
  ParamReader r{in, nullptr};
  f.scale = r.scale();
  f.quality = in->quality == PR_QUALITY_DRAFT ? 0.0F : 1.0F;
  f.debug = debug ? 1.0F : 0.0F;
  const bool has12 = in->struct_size >= offsetof(PrInData, comp_to_world) + sizeof(in->comp_to_world);
  f.comp = has12 ? vec2f(static_cast<float>(in->comp_width), static_cast<float>(in->comp_height)) : f.size;
  f.fps = in->frame_rate > 0 ? static_cast<float>(in->frame_rate) : 30.0F;
  f.has_aux = aux ? 1.0F : 0.0F;
  f.levels = static_cast<float>(levels);
  return f;
}

/// Pyramid level sizes: each level is half the previous (rounded up), as on the GPU.
std::array<std::array<int, 2>, 7> level_dims(int w, int h, int n) {
  std::array<std::array<int, 2>, 7> d{};
  d[0] = {w, h};
  for (int k = 1; k <= n && k < 7; ++k) {
    d.at(static_cast<std::size_t>(k)) = {std::max(1, (d.at(static_cast<std::size_t>(k - 1))[0] + 1) / 2),
                                         std::max(1, (d.at(static_cast<std::size_t>(k - 1))[1] + 1) / 2)};
  }
  return d;
}

// ── CPU ───────────────────────────────────────────────────────────────────

vec4f read_px(const PrWorld& w, int x, int y) {
  if (x < 0 || y < 0 || x >= w.width || y >= w.height || w.data == nullptr) return vec4f(0.0F);
  const auto* row = static_cast<const std::uint8_t*>(pr_world_row(&w, y));
  if (w.format == PR_PIXEL_FORMAT_RGBA32F) {
    vec4f p;
    std::memcpy(&p, row + static_cast<std::size_t>(x) * 16, 16);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return p;
  }
  if (w.format == PR_PIXEL_FORMAT_RGBA16) {
    std::array<std::uint16_t, 4> v{};
    std::memcpy(v.data(), row + static_cast<std::size_t>(x) * 8, 8);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    constexpr float k = 1.0F / PR_MAX_CHANNEL16;
    return {static_cast<float>(v[0]) * k, static_cast<float>(v[1]) * k, static_cast<float>(v[2]) * k, static_cast<float>(v[3]) * k};
  }
  const std::uint8_t* p = row + static_cast<std::size_t>(x) * 4;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  constexpr float k = 1.0F / PR_MAX_CHANNEL8;
  // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return {static_cast<float>(p[0]) * k, static_cast<float>(p[1]) * k, static_cast<float>(p[2]) * k, static_cast<float>(p[3]) * k};
}

void write_px(PrWorld& w, int x, int y, vec4f c) {
  // A kernel that produced a NaN / inf never poisons the frame.
  const auto ok = [](float v) { return std::isfinite(v) ? v : 0.0F; };
  c = vec4f(ok(c.x), ok(c.y), ok(c.z), ok(c.w));
  auto* row = static_cast<std::uint8_t*>(pr_world_row(&w, y));
  if (w.format == PR_PIXEL_FORMAT_RGBA32F) {
    std::memcpy(row + static_cast<std::size_t>(x) * 16, &c, 16);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return;
  }
  const auto q = [](float v, float m) { return static_cast<long>(std::lround(std::clamp(v, 0.0F, 1.0F) * m)); };
  if (w.format == PR_PIXEL_FORMAT_RGBA16) {
    const std::array<std::uint16_t, 4> v{static_cast<std::uint16_t>(q(c.x, PR_MAX_CHANNEL16)), static_cast<std::uint16_t>(q(c.y, PR_MAX_CHANNEL16)),
                                         static_cast<std::uint16_t>(q(c.z, PR_MAX_CHANNEL16)), static_cast<std::uint16_t>(q(c.w, PR_MAX_CHANNEL16))};
    std::memcpy(row + static_cast<std::size_t>(x) * 8, v.data(), 8);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return;
  }
  std::uint8_t* o = row + static_cast<std::size_t>(x) * 4;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  o[0] = static_cast<std::uint8_t>(q(c.x, PR_MAX_CHANNEL8));
  o[1] = static_cast<std::uint8_t>(q(c.y, PR_MAX_CHANNEL8));
  o[2] = static_cast<std::uint8_t>(q(c.z, PR_MAX_CHANNEL8));
  o[3] = static_cast<std::uint8_t>(q(c.w, PR_MAX_CHANNEL8));
  // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
}

/// The WGSL fxk_clean: NaN / inf never leave a pass.
vec4f clean(vec4f c) {
  const auto ok = [](float v) { return std::fabs(v) < 3.0e38F ? v : 0.0F; };
  return {ok(c.x), ok(c.y), ok(c.z), ok(c.w)};
}

/// The CPU twin's time budget per frame. The engine's watchdog ends the whole engine after 10 s in a
/// render selector; a fallback render that has not finished by this point (a 4K frame of a heavy
/// effect on a slow machine) stops and reports why instead — the layer renders without the effect
/// and the engine lives. This is the one wall-clock read in the plugin, and it only ever turns a
/// would-be hang into an error; it never changes a pixel of a frame that finishes.
constexpr auto kCpuBudget = std::chrono::milliseconds(7000);
constexpr PrErr kOverBudget = 100;  // internal marker, reported as PR_ERR_INTERNAL with a message

/// Rows in parallel through the host (each job crash-guarded).
template <class Fn>
PrErr rows(const PrInData* in, int count, std::chrono::steady_clock::time_point deadline, Fn&& fn) {
  struct Job {
    Fn* fn;
    const PrInData* in;
    std::chrono::steady_clock::time_point deadline;
  } job{&fn, in, deadline};
  return in->host->iterate(in->host_ref, count, &job, [](void* refcon, int32_t /*thread*/, int32_t i, int32_t /*n*/) -> PrErr {
    auto* j = static_cast<Job*>(refcon);
    if (j->in->host->abort_requested(j->in->host_ref) != 0) return PR_ERR_INTERRUPTED;
    if (std::chrono::steady_clock::now() > j->deadline) return kOverBudget;
    (*j->fn)(i);
    return PR_ERR_NONE;
  });
}

/// A world copied into a canvas-sized float image (world px coordinates, transparent outside).
void to_img(const PrWorld* w, int W, int H, Img& out) {
  out.resize(W, H);
  if (w == nullptr) return;
  for (int y = 0; y < out.h; ++y) {
    for (int x = 0; x < out.w; ++x) out.ref(x, y) = read_px(*w, x - w->origin_x, y - w->origin_y);
  }
}

template <class Fx>
PrErr cpu_render(const PrInData* in, PrParamDef* const* params) {
  const EffectDesc& d = Fx::desc;
  PrWorld* srcW = nullptr;
  PrWorld* dst = nullptr;
  PrWorld* auxW = nullptr;
  if (const PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &srcW); e != PR_ERR_NONE) return e;
  if (const PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const bool aux = d.layer_param != 0 && layer_set(in, params, d.layer_param) &&
                   in->host->checkout_layer_pixels(in->host_ref, kAuxCheckout, &auxW) == PR_ERR_NONE && auxW != nullptr;

  // The canvas is the world (what the GPU's textures are): [0, W) × [0, H) world px.
  int W = in->world_width > 0 ? in->world_width : dst->width + dst->origin_x;
  int H = in->world_height > 0 ? in->world_height : dst->height + dst->origin_y;
  W = std::max({W, 1, dst->width + dst->origin_x});
  H = std::max({H, 1, dst->height + dst->origin_y});

  const auto deadline = std::chrono::steady_clock::now() + kCpuBudget;
  auto fx = std::make_unique<Fx>();
  ParamReader reader{in, params};
  Fx::fill(fx->prm, reader);
  const bool debug = reader.number(kDebugId) > 0.5F;
  fx->fr = frame_of(in, static_cast<float>(W), static_cast<float>(H), aux, d.pyramid, debug);

  Img srcImg;
  to_img(srcW, W, H, srcImg);
  fx->t_src = &srcImg;
  Img auxImg;
  if (aux) {
    to_img(auxW, W, H, auxImg);
    fx->t_aux = &auxImg;
  }
  std::array<Img, 6> lv;
  const auto dims = level_dims(W, H, d.pyramid);
  for (int k = 1; k <= d.pyramid; ++k) {
    const Img& prev = k == 1 ? srcImg : lv.at(static_cast<std::size_t>(k - 2));
    Img& cur = lv.at(static_cast<std::size_t>(k - 1));
    cur.resize(dims.at(static_cast<std::size_t>(k))[0], dims.at(static_cast<std::size_t>(k))[1]);
    if (const PrErr e = rows(in, cur.h, deadline, [&](int y) {
          for (int x = 0; x < cur.w; ++x) cur.ref(x, y) = Ctx::fxk_down(prev, vec2i(x, y));
        });
        e != PR_ERR_NONE) {
      return e;
    }
    fx->t_l.at(static_cast<std::size_t>(k - 1)) = &cur;
  }
  std::array<Img, 2> pass;
  for (int i = 0; i < d.passes; ++i) {
    Img& out = pass.at(static_cast<std::size_t>(i));
    out.resize(W, H);
    const Fx& f = *fx;
    if (const PrErr e = rows(in, H, deadline, [&](int y) {
          for (int x = 0; x < W; ++x) out.ref(x, y) = clean(f.run_pass(i, vec2f(static_cast<float>(x) + 0.5F, static_cast<float>(y) + 0.5F)));
        });
        e != PR_ERR_NONE) {
      return e;
    }
    if (i == 0) fx->t_pa = &out;
    else fx->t_pb = &out;
  }
  const Fx& f = *fx;
  return rows(in, dst->height, deadline, [&](int y) {
    for (int x = 0; x < dst->width; ++x) {
      const vec2f p(static_cast<float>(x + dst->origin_x) + 0.5F, static_cast<float>(y + dst->origin_y) + 0.5F);
      const vec4f c = debug ? vec4f(1.0F, 0.0F, 1.0F, 1.0F) : f.run_pass(d.passes, p);
      write_px(*dst, x, y, c);
    }
  });
}

// ── the Studio's Set Values button ────────────────────────────────────────
// A panel's setParam carries numbers, booleans and colours only, and the engine refuses a number for
// a popup (it takes a choice). So the Studio sends popup edits, presets, resets and Surprise to the
// hidden "Set Values" button as a flat JSON object — {"p3": 2, "p7": [r, g, b, a], "p1X": 40} in the
// document's own encoding (colours sRGB 0..1, points as offsets from the layer centre) — and the
// plugin writes each through set_param_value, which converts popups to their choice and lands
// everything in ONE undo step.
constexpr std::uint32_t kSetValuesId = 998;

struct PayloadValue {
  std::string key;
  std::vector<double> nums;
};

/// The flat {"key": number | bool | [numbers]} subset the Studio sends. Anything else is skipped.
std::vector<PayloadValue> parse_payload(const std::uint8_t* data, std::uint32_t size) {
  std::vector<PayloadValue> out;
  const std::string s(reinterpret_cast<const char*>(data), size);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  std::size_t i = 0;
  const auto ws = [&] {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) ++i;
  };
  const auto number = [&](double& v) {
    ws();
    if (s.compare(i, 4, "true") == 0) { v = 1; i += 4; return true; }
    if (s.compare(i, 5, "false") == 0) { v = 0; i += 5; return true; }
    const char* begin = s.c_str() + i;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    char* end = nullptr;
    v = std::strtod(begin, &end);
    if (end == begin || !std::isfinite(v)) return false;
    i += static_cast<std::size_t>(end - begin);
    return true;
  };
  ws();
  if (i >= s.size() || s[i] != '{') return out;
  ++i;
  while (out.size() < 256) {
    ws();
    if (i >= s.size() || s[i] == '}') break;
    if (s[i] == ',') { ++i; continue; }
    if (s[i] != '"') break;
    const std::size_t q = s.find('"', i + 1);
    if (q == std::string::npos || q - i > 16) break;
    PayloadValue pv{s.substr(i + 1, q - i - 1), {}};
    i = q + 1;
    ws();
    if (i >= s.size() || s[i] != ':') break;
    ++i;
    ws();
    if (i < s.size() && s[i] == '[') {
      ++i;
      for (int n = 0; n < 4; ++n) {
        double v = 0;
        if (!number(v)) break;
        pv.nums.push_back(v);
        ws();
        if (i < s.size() && s[i] == ',') ++i;
      }
      ws();
      if (i >= s.size() || s[i] != ']') break;
      ++i;
    } else {
      double v = 0;
      if (!number(v)) break;
      pv.nums.push_back(v);
    }
    out.push_back(std::move(pv));
  }
  return out;
}

double srgb_to_linear(double v) { return v <= 0.04045 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4); }

PrErr set_values(const PrInData* in, PrParamDef* const* params, const PrUserChangedParamExtra* x) {
  if (x->struct_size < offsetof(PrUserChangedParamExtra, payload_size) + sizeof(x->payload_size)) return PR_ERR_NONE;
  if (x->payload == nullptr || x->payload_size == 0) return PR_ERR_NONE;
  const std::vector<PayloadValue> values = parse_payload(x->payload, x->payload_size);
  // Points arrive per axis; collect both before writing (a missing axis keeps its current value).
  std::map<std::uint32_t, std::array<double, 2>> points;
  for (const PayloadValue& v : values) {
    if (v.key.size() < 2 || v.key[0] != 'p' || v.nums.empty()) continue;
    char axis = v.key.back();
    const bool pointAxis = axis == 'X' || axis == 'Y';
    const std::string digits = v.key.substr(1, v.key.size() - (pointAxis ? 2 : 1));
    if (digits.empty() || digits.find_first_not_of("0123456789") != std::string::npos) continue;
    const auto id = static_cast<std::uint32_t>(std::stoul(digits));
    if (id == kSetValuesId) continue;
    const std::uint32_t idx = index_of(in, params, id);
    if (idx == 0) continue;
    const PrParamDef* p = params[idx];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (pointAxis) {
      if (p->type != PR_PARAM_POINT) continue;
      auto [it, fresh] = points.try_emplace(idx, std::array<double, 2>{p->value[0], p->value[1]});
      // Offsets from the layer centre (the document's encoding) → layer px from the top-left.
      if (axis == 'X') it->second[0] = v.nums[0] + in->width / 2.0;
      else it->second[1] = v.nums[0] + in->height / 2.0;
      continue;
    }
    if (p->type == PR_PARAM_COLOR) {
      const std::array<double, 4> c{srgb_to_linear(v.nums[0]), srgb_to_linear(v.nums.size() > 1 ? v.nums[1] : 0),
                                    srgb_to_linear(v.nums.size() > 2 ? v.nums[2] : 0), v.nums.size() > 3 ? v.nums[3] : 1.0};
      in->host->set_param_value(in->host_ref, idx, c.data(), 4);
    } else if (p->type == PR_PARAM_FLOAT_SLIDER || p->type == PR_PARAM_SLIDER || p->type == PR_PARAM_ANGLE ||
               p->type == PR_PARAM_POPUP || p->type == PR_PARAM_CHECKBOX) {
      double n = v.nums[0];
      if (p->type != PR_PARAM_ANGLE && p->valid_max > p->valid_min) n = std::clamp(n, p->valid_min, p->valid_max);
      in->host->set_param_value(in->host_ref, idx, &n, 1);
    }
  }
  for (const auto& [idx, xy] : points) in->host->set_param_value(in->host_ref, idx, xy.data(), 2);
  return PR_ERR_NONE;
}

PrErr user_changed(const PrInData* in, PrParamDef* const* params, const PrUserChangedParamExtra* x) {
  if (x == nullptr || x->param_index == 0 || x->param_index >= in->num_params) return PR_ERR_NONE;
  const PrParamDef* p = params[x->param_index];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  if (p != nullptr && p->id == kSetValuesId) return set_values(in, params, x);
  return PR_ERR_NONE;
}
template <class Fx>
PrErr pre_render(const PrInData* in, PrParamDef* const* params, PrPreRenderExtra* x) {
  const EffectDesc& d = Fx::desc;
  PrErr e = in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
  if (e == PR_ERR_NONE && d.layer_param != 0 && layer_set(in, params, d.layer_param)) {
    e = in->host->checkout_layer(in->host_ref, index_of(in, params, d.layer_param), kAuxCheckout, in->current_time, nullptr);
  }
  if (e != PR_ERR_NONE || x == nullptr) return e;
  if (d.expand != nullptr) {
    auto p = std::make_unique<decltype(Fx::prm)>();
    Fx::fill(*p, ParamReader{in, params});
    const float g = Fx::expand_px(*p);
    const auto grow = static_cast<int32_t>(std::ceil(std::clamp(std::isfinite(g) ? g : 0.0F, 0.0F, 4096.0F)));
    x->result_rect = {x->request_rect.left - grow, x->request_rect.top - grow, x->request_rect.right + grow, x->request_rect.bottom + grow};
  }
  return PR_ERR_NONE;
}

// ── GPU ───────────────────────────────────────────────────────────────────
#ifdef FXKIT_GPU

WGPUStringView sv(const char* s) { return WGPUStringView{s, WGPU_STRLEN}; }

WGPUTextureFormat wgpu_format(PrGpuFormat f) {
  return f == PR_GPU_FORMAT_RGBA32_FLOAT   ? WGPUTextureFormat_RGBA32Float
         : f == PR_GPU_FORMAT_RGBA16_FLOAT ? WGPUTextureFormat_RGBA16Float
                                           : WGPUTextureFormat_RGBA8Unorm;
}

constexpr std::uint32_t kBindings = 12;
constexpr std::uint64_t kFrameBytes = 256;
constexpr std::uint64_t kSlotBytes = 1024;  // frame (256) + params (≤ 768), one slot per pass

struct PoolTex {
  WGPUTexture tex = nullptr;
  WGPUTextureView view = nullptr;
  std::uint64_t lastUse = 0;
};

/// Per effect and device. Pipelines are built on the first render that needs them: 51 effects ×
/// a shader compile each at device setup would stall the editor's first frame.
struct Gpu {
  const DawnProcTable* p = nullptr;
  WGPUDevice device = nullptr;
  std::mutex mutex;
  bool built = false;
  bool broken = false;
  WGPUShaderModule module = nullptr;
  WGPUBindGroupLayout bgl = nullptr;
  WGPUPipelineLayout layout = nullptr;
  WGPURenderPipeline down = nullptr;
  std::array<WGPURenderPipeline, 2> passes{};
  std::array<WGPURenderPipeline, 3> finals{};  // by PrGpuFormat
  PoolTex dummy;
  std::map<std::array<int, 3>, PoolTex> pool;  // (w, h, slot) → scratch texture
  std::uint64_t calls = 0;

  Gpu() = default;
  Gpu(const Gpu&) = delete;
  Gpu& operator=(const Gpu&) = delete;
  Gpu(Gpu&&) = delete;
  Gpu& operator=(Gpu&&) = delete;
  void release(PoolTex& t) const {
    if (t.view != nullptr) p->textureViewRelease(t.view);
    if (t.tex != nullptr) p->textureRelease(t.tex);
    t = {};
  }
  ~Gpu() {
    for (auto& [k, t] : pool) release(t);
    release(dummy);
    if (down != nullptr) p->renderPipelineRelease(down);
    for (WGPURenderPipeline rp : passes) {
      if (rp != nullptr) p->renderPipelineRelease(rp);
    }
    for (WGPURenderPipeline rp : finals) {
      if (rp != nullptr) p->renderPipelineRelease(rp);
    }
    if (layout != nullptr) p->pipelineLayoutRelease(layout);
    if (bgl != nullptr) p->bindGroupLayoutRelease(bgl);
    if (module != nullptr) p->shaderModuleRelease(module);
    if (device != nullptr) p->deviceRelease(device);
  }

  [[nodiscard]] PoolTex make(int w, int h) const {
    WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
    td.label = sv("fxkit-scratch");
    td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_RenderAttachment;
    td.dimension = WGPUTextureDimension_2D;
    td.size = {static_cast<uint32_t>(std::max(1, w)), static_cast<uint32_t>(std::max(1, h)), 1};
    td.format = WGPUTextureFormat_RGBA32Float;
    td.mipLevelCount = 1;
    td.sampleCount = 1;
    PoolTex t;
    t.tex = p->deviceCreateTexture(device, &td);
    t.view = t.tex != nullptr ? p->textureCreateView(t.tex, nullptr) : nullptr;
    return t;
  }

  [[nodiscard]] WGPURenderPipeline pipeline(const char* entry, WGPUTextureFormat format) const {
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = format;
    WGPUFragmentState frag = WGPU_FRAGMENT_STATE_INIT;
    frag.module = module;
    frag.entryPoint = sv(entry);
    frag.targetCount = 1;
    frag.targets = &target;
    WGPURenderPipelineDescriptor pd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    pd.label = sv(entry);
    pd.layout = layout;
    pd.vertex.module = module;
    pd.vertex.entryPoint = sv("vs");
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.fragment = &frag;
    return p->deviceCreateRenderPipeline(device, &pd);
  }

  /// Compile the effect's module and its pipelines (under the mutex, once).
  void build(const EffectDesc& d) {
    built = true;
    const std::string code = std::string(d.wgsl);
    WGPUShaderSourceWGSL source = WGPU_SHADER_SOURCE_WGSL_INIT;
    source.code = sv(code.c_str());
    WGPUShaderModuleDescriptor md = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    md.nextInChain = &source.chain;
    md.label = sv(d.match_name);
    module = p->deviceCreateShaderModule(device, &md);

    std::array<WGPUBindGroupLayoutEntry, kBindings> e{};
    for (uint32_t i = 0; i < kBindings; ++i) {
      e.at(i) = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
      e.at(i).binding = i;
      e.at(i).visibility = WGPUShaderStage_Fragment;
      if (i < 2) {
        e.at(i).buffer.type = WGPUBufferBindingType_Uniform;
        e.at(i).buffer.minBindingSize = i == 0 ? sizeof(Frame) : d.param_bytes;
      } else {
        e.at(i).texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
        e.at(i).texture.viewDimension = WGPUTextureViewDimension_2D;
      }
    }
    WGPUBindGroupLayoutDescriptor bd = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    bd.entryCount = e.size();
    bd.entries = e.data();
    bgl = p->deviceCreateBindGroupLayout(device, &bd);
    WGPUPipelineLayoutDescriptor pl = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pl.bindGroupLayoutCount = 1;
    pl.bindGroupLayouts = &bgl;
    layout = p->deviceCreatePipelineLayout(device, &pl);
    if (module == nullptr || bgl == nullptr || layout == nullptr) {
      broken = true;
      return;
    }
    if (d.pyramid > 0) down = pipeline("fs_down", WGPUTextureFormat_RGBA32Float);
    static constexpr std::array<const char*, 2> kPassEntries{"fs_p0", "fs_p1"};
    for (int i = 0; i < d.passes; ++i) passes.at(static_cast<std::size_t>(i)) = pipeline(kPassEntries.at(static_cast<std::size_t>(i)), WGPUTextureFormat_RGBA32Float);
    // The final pass's pipeline is built per output format on first use (final_for): the frame's
    // format is one of three, and each pipeline is a full compile of the effect's fragment shader.
    dummy = make(1, 1);
  }

  WGPURenderPipeline final_for(PrGpuFormat f) {
    const auto i = static_cast<std::size_t>(std::clamp(f, PR_GPU_FORMAT_RGBA8_UNORM, PR_GPU_FORMAT_RGBA32_FLOAT));
    if (finals.at(i) == nullptr) finals.at(i) = pipeline("fs_main", wgpu_format(static_cast<PrGpuFormat>(i)));
    return finals.at(i);
  }

  PoolTex& scratch(int w, int h, int slot) {
    const std::array<int, 3> key{w, h, slot};
    PoolTex& t = pool[key];
    if (t.tex == nullptr) t = make(w, h);
    t.lastUse = calls;
    return t;
  }
  void trim() {
    for (auto it = pool.begin(); it != pool.end();) {
      if (calls - it->second.lastUse > 48) {
        release(it->second);
        it = pool.erase(it);
      } else {
        ++it;
      }
    }
  }
};

Gpu* gpu_of(const PrInData* in, PrHandle h) {
  void* ptr = in->host->handle_lock(in->host_ref, h);
  if (ptr == nullptr) return nullptr;
  Gpu* g = nullptr;
  std::memcpy(&g, ptr, sizeof(g));
  return g;
}

PrErr gpu_setup(const PrInData* in, PrGpuDeviceSetupExtra* x) {
  const auto* procs = static_cast<const DawnProcTable*>(x->device->procs);
  if (procs == nullptr || x->device->framework != PR_GPU_FRAMEWORK_WEBGPU_DAWN) return PR_ERR_UNSUPPORTED;
  const PrHandle h = in->host->handle_new(in->host_ref, sizeof(Gpu*));
  if (h == 0) return PR_ERR_OUT_OF_MEMORY;
  auto g = std::make_unique<Gpu>();
  g->p = procs;
  g->device = static_cast<WGPUDevice>(x->device->wgpu_device);
  procs->deviceAddRef(g->device);
  Gpu* raw = g.release();
  std::memcpy(in->host->handle_lock(in->host_ref, h), &raw, sizeof(raw));
  x->gpu_data = h;
  return PR_ERR_NONE;
}

PrErr gpu_setdown(const PrInData* in, PrGpuDeviceSetupExtra* x) {
  const std::unique_ptr<Gpu> g(gpu_of(in, x->gpu_data));  // the device may be lost — releasing is still valid
  in->host->handle_dispose(in->host_ref, x->gpu_data);
  x->gpu_data = 0;
  return PR_ERR_NONE;
}

template <class Fx>
PrErr gpu_render(const PrInData* in, PrParamDef* const* params, PrSmartRenderGpuExtra* x) {
  const EffectDesc& d = Fx::desc;
  Gpu* g = gpu_of(in, x->gpu_data);
  if (g == nullptr || x->input == nullptr || x->output == nullptr) return PR_ERR_INVALID_PARAM;
  const DawnProcTable* p = g->p;
  const int W = x->output->width;
  const int H = x->output->height;

  const PrGpuWorld* auxW = nullptr;
  const bool aux = d.layer_param != 0 && layer_set(in, params, d.layer_param) &&
                   in->host->checkout_layer_gpu(in->host_ref, kAuxCheckout, &auxW) == PR_ERR_NONE && auxW != nullptr;

  auto prm = std::make_unique<decltype(Fx::prm)>();
  ParamReader reader{in, params};
  Fx::fill(*prm, reader);
  const bool debug = reader.number(kDebugId) > 0.5F;
  const Frame frame = frame_of(in, static_cast<float>(W), static_cast<float>(H), aux, d.pyramid, debug);

  // Passes: pyramid downs, the intermediate passes, the final.
  struct Pass {
    WGPURenderPipeline pipe;
    WGPUTextureView target;
    WGPUTextureView input;  // what binding 2 holds (src, or the previous level for a down pass)
    int w, h;
  };
  std::vector<Pass> plan;
  std::array<WGPUTextureView, 6> levelViews{};
  std::array<WGPUTextureView, 2> passViews{};
  const auto srcView = static_cast<WGPUTextureView>(x->input->wgpu_texture_view);
  {
    const std::scoped_lock lock(g->mutex);
    if (!g->built) g->build(d);
    if (g->broken) return PR_ERR_UNSUPPORTED;
    ++g->calls;
    const auto dims = level_dims(W, H, d.pyramid);
    for (int k = 1; k <= d.pyramid; ++k) {
      const auto& dk = dims.at(static_cast<std::size_t>(k));
      levelViews.at(static_cast<std::size_t>(k - 1)) = g->scratch(dk[0], dk[1], k).view;
      plan.push_back({g->down, levelViews.at(static_cast<std::size_t>(k - 1)), k == 1 ? srcView : levelViews.at(static_cast<std::size_t>(k - 2)), dk[0], dk[1]});
    }
    for (int i = 0; i < d.passes; ++i) {
      passViews.at(static_cast<std::size_t>(i)) = g->scratch(W, H, 10 + i).view;
      plan.push_back({g->passes.at(static_cast<std::size_t>(i)), passViews.at(static_cast<std::size_t>(i)), srcView, W, H});
    }
    plan.push_back({g->final_for(x->output->format), static_cast<WGPUTextureView>(x->output->wgpu_texture_view),
                    srcView, W, H});
    g->trim();
  }
  for (const Pass& ps : plan) {
    if (ps.pipe == nullptr || ps.target == nullptr) return PR_ERR_OUT_OF_MEMORY;
  }

  // One uniform buffer for the call: a slot per pass (the frame block, then the params block).
  const std::uint64_t bytes = kSlotBytes * plan.size();
  WGPUBufferDescriptor bdesc = WGPU_BUFFER_DESCRIPTOR_INIT;
  bdesc.label = sv("fxkit-uniforms");
  bdesc.size = bytes;
  bdesc.usage = WGPUBufferUsage_Uniform;
  bdesc.mappedAtCreation = 1;
  const WGPUBuffer ubuf = p->deviceCreateBuffer(g->device, &bdesc);
  if (ubuf == nullptr) return PR_ERR_OUT_OF_MEMORY;
  void* mapped = p->bufferGetMappedRange(ubuf, 0, bytes);
  if (mapped == nullptr) {
    p->bufferRelease(ubuf);
    return PR_ERR_OUT_OF_MEMORY;
  }
  std::array<std::uint8_t, kSlotBytes - kFrameBytes> packed{};
  Fx::pack(*prm, packed.data());
  for (std::size_t i = 0; i < plan.size(); ++i) {
    auto* slot = static_cast<std::uint8_t*>(mapped) + i * kSlotBytes;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::memcpy(slot, &frame, sizeof(Frame));
    std::memcpy(slot + kFrameBytes, packed.data(), packed.size());  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  p->bufferUnmap(ubuf);

  const auto enc = static_cast<WGPUCommandEncoder>(x->wgpu_command_encoder);
  const WGPUTextureView dummy = g->dummy.view;
  const auto or_dummy = [&](WGPUTextureView v) { return v != nullptr ? v : dummy; };
  for (std::size_t i = 0; i < plan.size(); ++i) {
    const Pass& ps = plan[i];
    std::array<WGPUBindGroupEntry, kBindings> be{};
    for (uint32_t k = 0; k < kBindings; ++k) {
      be.at(k) = WGPU_BIND_GROUP_ENTRY_INIT;
      be.at(k).binding = k;
    }
    be[0].buffer = ubuf;
    be[0].offset = kSlotBytes * i;
    be[0].size = sizeof(Frame);
    be[1].buffer = ubuf;
    be[1].offset = kSlotBytes * i + kFrameBytes;
    be[1].size = d.param_bytes;
    be[2].textureView = ps.input;
    for (std::size_t k = 0; k < 6; ++k) {
      // A level is never bound while it is the target (a down pass only reads the level below).
      be.at(3 + k).textureView = levelViews.at(k) == ps.target ? dummy : or_dummy(levelViews.at(k));
    }
    be[9].textureView = passViews[0] == ps.target ? dummy : or_dummy(passViews[0]);
    be[10].textureView = passViews[1] == ps.target ? dummy : or_dummy(passViews[1]);
    be[11].textureView = aux ? static_cast<WGPUTextureView>(auxW->wgpu_texture_view) : dummy;
    WGPUBindGroupDescriptor bgd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bgd.layout = g->bgl;
    bgd.entryCount = be.size();
    bgd.entries = be.data();
    const WGPUBindGroup bg = p->deviceCreateBindGroup(g->device, &bgd);

    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    ca.view = ps.target;
    ca.loadOp = WGPULoadOp_Clear;
    ca.storeOp = WGPUStoreOp_Store;
    ca.clearValue = {0, 0, 0, 0};
    WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &ca;
    const WGPURenderPassEncoder pass = p->commandEncoderBeginRenderPass(enc, &rp);
    p->renderPassEncoderSetPipeline(pass, ps.pipe);
    p->renderPassEncoderSetBindGroup(pass, 0, bg, 0, nullptr);
    p->renderPassEncoderDraw(pass, 3, 1, 0, 0);
    p->renderPassEncoderEnd(pass);
    p->renderPassEncoderRelease(pass);
    p->bindGroupRelease(bg);
  }
  p->bufferRelease(ubuf);  // the command buffer keeps it alive until it has run
  return PR_ERR_NONE;
}
#endif

constexpr std::uint32_t kBaseFlags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                                     PR_OUT_FLAG_SEND_UPDATE_PARAMS_UI
#ifdef FXKIT_GPU
                                     | PR_OUT_FLAG_GPU_RENDER
#endif
    ;

template <class Fx>
PrErr dispatch(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, [[maybe_unused]] void* extra) {
  const EffectDesc& d = Fx::desc;
  switch (cmd) {
    case PR_CMD_ABOUT: message(out, d.about); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(FXK_VERSION_MAJOR, FXK_VERSION_MINOR, FXK_VERSION_PATCH);
      out->out_flags = kBaseFlags | d.out_flags;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in, d);
    case PR_CMD_UPDATE_PARAMS_UI: Fx::ui(UiCtx{in, params}); return PR_ERR_NONE;
    case PR_CMD_USER_CHANGED_PARAM: return user_changed(in, params, static_cast<const PrUserChangedParamExtra*>(extra));
    case PR_CMD_SMART_PRE_RENDER: return pre_render<Fx>(in, params, static_cast<PrPreRenderExtra*>(extra));
    case PR_CMD_SMART_RENDER: {
      const PrErr e = cpu_render<Fx>(in, params);
      if (e != kOverBudget) return e;
      message(out, FXK_PLUGIN_NAME ": the CPU fallback could not finish this frame in time at this size (no GPU path was available). "
                   "Lower the preview resolution or the effect's quality, or render on a machine with a GPU.");
      return PR_ERR_INTERNAL;
    }
#ifdef FXKIT_GPU
    case PR_CMD_GPU_DEVICE_SETUP: return gpu_setup(in, static_cast<PrGpuDeviceSetupExtra*>(extra));
    case PR_CMD_GPU_DEVICE_SETDOWN: return gpu_setdown(in, static_cast<PrGpuDeviceSetupExtra*>(extra));
    case PR_CMD_SMART_RENDER_GPU: return gpu_render<Fx>(in, params, static_cast<PrSmartRenderGpuExtra*>(extra));
#endif
    default: return PR_ERR_NONE;
  }
}

// One C entry point per effect, all through dispatch<>; every C++ exception stays inside.
#define FXK_MAIN(slug)                                                                                                       \
  PrErr PR_CALL main_##slug(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*w*/,       \
                            void* extra) {                                                                                   \
    try {                                                                                                                    \
      return dispatch<Fx_##slug>(cmd, in, out, params, extra);                                                               \
    } catch (const std::bad_alloc&) {                                                                                        \
      message(out, FXK_PLUGIN_NAME ": out of memory");                                                                        \
      return PR_ERR_OUT_OF_MEMORY;                                                                                           \
    } catch (...) {                                                                                                          \
      message(out, FXK_PLUGIN_NAME ": internal error");                                                                       \
      return PR_ERR_INTERNAL;                                                                                                \
    }                                                                                                                        \
  }
FXK_EFFECTS(FXK_MAIN)
#undef FXK_MAIN

#define FXK_ENTRY(slug) PrEffectEntry{Fx_##slug::desc.match_name, &main_##slug},
const PrEffectEntry kEffects[] = {FXK_EFFECTS(FXK_ENTRY)};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
#undef FXK_ENTRY

const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, FXK_PLUGIN_ID,
                            static_cast<uint32_t>(std::size(kEffects)), kEffects, 0, nullptr, 0, nullptr, 0, nullptr};

}  // namespace
}  // namespace fxk::kit

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &fxk::kit::kInfo; }
