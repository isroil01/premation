// Sample generator: Rings — concentric rings over the layer's rectangle,
// coloured from a per-instance PALETTE kept in SEQUENCE DATA. The palette is
// made at SEQUENCE_SETUP, flattened into the project (it is plain bytes, so
// FLATTEN hands the same handle back), rebuilt at RESETUP, and re-rolled by
// the "Shuffle Palette" button (USER_CHANGED_PARAM) — one undoable edit, saved
// with the project, identical in preview and export.
//
// SDK 1.1 viewer overlay (PR_OUT_FLAG_CUSTOM_OVERLAY): DRAW_OVERLAY draws the
// first three rings' outlines and a crosshair handle at Center; dragging it
// (OVERLAY_DRAG) writes Center — the whole drag is one undo step.
//
// SDK 1.1 panel (ui/index.html): the panel reads the palette from the sequence
// data (getEffectUi's `data`) and sends the edited one to the hidden "Set
// Palette" button as its payload — `#rrggbb` colours separated by spaces, 1 to
// 8 of them. Like Shuffle, one undoable edit.
//
//   Center (point) · Spacing · Rotation (angle) · Palette Mix · Color A · Color B
//   Opacity · Shuffle Palette (button) · Set Palette (hidden button) ▸ Debug: Fault
#include <premation_sdk/premation_sdk.h>

#include <array>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <numbers>

#include "sample_util.hpp"

namespace {

enum : uint32_t { kCenter = 1, kSpacing = 2, kRotation = 3, kMix = 4, kColorA = 5, kColorB = 6, kOpacity = 7, kShuffle = 8, kSetPalette = 9 };

constexpr uint32_t kMagic = 0x52494E47;  // 'RING'
constexpr uint32_t kFormat = 1;

/// The flat sequence data: no pointers, fixed layout, versioned.
struct Palette {
  uint32_t magic = kMagic;
  uint32_t format = kFormat;
  uint32_t seed = 1;
  uint32_t count = 6;
  std::array<std::array<float, 3>, 8> colors{};
};

uint32_t xorshift(uint32_t x) {
  x ^= x << 13U;
  x ^= x >> 17U;
  x ^= x << 5U;
  return x == 0 ? 0x9E3779B9U : x;
}

void roll(Palette& p) {
  uint32_t s = p.seed;
  for (auto& c : p.colors) {
    for (float& v : c) {
      s = xorshift(s);
      v = static_cast<float>(s % 1000U) / 999.0F;
    }
  }
}

PrErr new_sequence(const PrInData* in, PrOutData* out, const Palette& p) {
  const PrHandle h = in->host->handle_new(in->host_ref, sizeof(Palette));
  if (h == 0) return PR_ERR_OUT_OF_MEMORY;
  std::memcpy(in->host->handle_lock(in->host_ref, h), &p, sizeof(p));
  out->sequence_data = h;
  return PR_ERR_NONE;
}

bool read_palette(const PrInData* in, PrHandle h, Palette& p) {
  const void* src = in->host->handle_lock(in->host_ref, h);
  if (src == nullptr || in->host->handle_size(in->host_ref, h) < sizeof(Palette)) return false;
  std::memcpy(&p, src, sizeof(p));
  return p.magic == kMagic && p.format == kFormat && p.count <= p.colors.size();
}

int hex_digit(uint8_t c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/// The panel's payload: `#rrggbb` colours separated by spaces (1..8). False for anything else.
bool parse_palette(const uint8_t* s, uint32_t n, Palette& p) {
  uint32_t count = 0;
  uint32_t i = 0;
  while (i < n) {
    if (s[i] == ' ') {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      ++i;
      continue;
    }
    if (count == p.colors.size() || n - i < 7 || s[i] != '#') return false;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    for (uint32_t ch = 0; ch < 3; ++ch) {
      const int hi = hex_digit(s[i + 1 + 2 * ch]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const int lo = hex_digit(s[i + 2 + 2 * ch]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      if (hi < 0 || lo < 0) return false;
      p.colors.at(count).at(ch) = static_cast<float>(hi * 16 + lo) / 255.0F;
    }
    ++count;
    i += 7;
  }
  if (count == 0) return false;
  p.count = count;
  return true;
}

PrErr params_setup(const PrInData* in) {
  PrErr e = prs::add_simple(in, PR_PARAM_POINT, kCenter, "Center", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSpacing, "Spacing", 24, 1, 2000, 2, 200, 1);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_ANGLE, kRotation, "Rotation", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kMix, "Palette Mix", 100, 0, 100, 0, 100, 1);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_COLOR, kColorA, "Color A", {1, 1, 1, 1});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_COLOR, kColorB, "Color B", {0, 0, 0, 1});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kOpacity, "Opacity", 100, 0, 100, 0, 100, 1);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_BUTTON, kShuffle, "Shuffle Palette", {}, PR_PARAM_FLAG_SUPERVISE);
  if (e == PR_ERR_NONE) {
    e = prs::add_simple(in, PR_PARAM_BUTTON, kSetPalette, "Set Palette", {}, PR_PARAM_FLAG_SUPERVISE | PR_PARAM_FLAG_HIDDEN);
  }
  if (e == PR_ERR_NONE) e = prs::add_fault_params(in);
  return e;
}

PrErr smart_render(const PrInData* in, PrOutData* out, PrParamDef* const* params) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  Palette pal;
  if (!read_palette(in, in->sequence_data, pal)) roll(pal);  // no/invalid sequence data: the default palette

  const auto c = prs::to_world(in, prs::num(params, in, kCenter, 0), prs::num(params, in, kCenter, 1));
  const double scale = std::max(1e-6, 0.5 * (in->pixel_scale_x + in->pixel_scale_y));
  const double spacing = std::max(0.5, prs::num(params, in, kSpacing) * scale);
  const double rot = prs::num(params, in, kRotation) / 360;
  const auto mix = static_cast<float>(prs::num(params, in, kMix) / 100);
  const auto opacity = static_cast<float>(prs::num(params, in, kOpacity) / 100);
  const std::array<float, 3> a{static_cast<float>(prs::num(params, in, kColorA, 0)), static_cast<float>(prs::num(params, in, kColorA, 1)),
                               static_cast<float>(prs::num(params, in, kColorA, 2))};
  const std::array<float, 3> b{static_cast<float>(prs::num(params, in, kColorB, 0)), static_cast<float>(prs::num(params, in, kColorB, 1)),
                               static_cast<float>(prs::num(params, in, kColorB, 2))};
  // The layer's rectangle in world pixels (inverse of layer_to_world at each pixel).
  const double* m = in->layer_to_world;
  const double det = m[0] * m[4] - m[1] * m[3];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      const double wx = x + 0.5 - m[2];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const double wy = y + 0.5 - m[5];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const double lx = det != 0 ? (m[4] * wx - m[1] * wy) / det : -1;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const double ly = det != 0 ? (-m[3] * wx + m[0] * wy) / det : -1;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      if (lx < 0 || ly < 0 || lx >= in->width || ly >= in->height) {
        prs::write(*dst, x, y, {});
        continue;
      }
      const double d = std::hypot(x + 0.5 - c[0], y + 0.5 - c[1]) / spacing + rot;
      const double f = d - std::floor(d);
      const auto ring = static_cast<uint32_t>(std::max(0.0, std::floor(d)));
      const bool even = ring % 2U == 0;
      const auto& pc = pal.colors.at(ring % std::max(1U, pal.count));
      const std::array<float, 3>& base = even ? a : b;
      // Soft ring edges (a quarter-period smoothstep), straight colour, then premultiplied by opacity.
      const auto edge = static_cast<float>(std::min(f, 1 - f) * 4);
      const float cov = opacity * std::min(1.0F, edge * static_cast<float>(spacing) / 4 + 0.5F);
      prs::Px p;
      p.r = (base[0] * (1 - mix) + pc[0] * mix) * cov;
      p.g = (base[1] * (1 - mix) + pc[1] * mix) * cov;
      p.b = (base[2] * (1 - mix) + pc[2] * mix) * cov;
      p.a = cov;
      prs::write(*dst, x, y, p);
    }
  };
  return prs::for_rows(in, dst->height, row);
}

constexpr uint32_t kCenterHandle = 1;

/// DRAW_OVERLAY: the centre handle and the first rings, in layer px.
PrErr draw_overlay(const PrInData* in, PrParamDef* const* params) {
  if (in->host->struct_size < offsetof(PrHostSuite, overlay_handle) + sizeof(void*)) return PR_ERR_UNSUPPORTED;
  const double cx = prs::num(params, in, kCenter, 0);
  const double cy = prs::num(params, in, kCenter, 1);
  const double spacing = std::max(1.0, prs::num(params, in, kSpacing));
  const float ring[4] = {1, 1, 1, 0.6F};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): the SDK's rgba
  for (int r = 1; r <= 3; ++r) {
    std::array<double, 2 * 48> xy{};
    for (std::size_t i = 0; i < 48; ++i) {
      const double a = static_cast<double>(i) * 2 * std::numbers::pi / 48;
      xy.at(2 * i) = cx + std::cos(a) * spacing * r;
      xy.at(2 * i + 1) = cy + std::sin(a) * spacing * r;
    }
    if (PrErr e = in->host->overlay_path(in->host_ref, xy.data(), 48, 1, ring); e != PR_ERR_NONE) return e;
  }
  return in->host->overlay_handle(in->host_ref, kCenterHandle, cx, cy, PR_OVERLAY_HANDLE_CROSSHAIR);
}

/// OVERLAY_DRAG: the centre follows the pointer.
PrErr overlay_drag(const PrInData* in, PrParamDef* const* params, const PrOverlayDragExtra* drag) {
  if (drag == nullptr || drag->handle_id != kCenterHandle) return PR_ERR_NONE;
  for (uint32_t i = 1; i < in->num_params; ++i) {
    if (params[i] != nullptr && params[i]->id == kCenter) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const double v[2] = {drag->x, drag->y};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): the SDK's value array
      return in->host->set_param_value(in->host_ref, i, v, 2);
    }
  }
  return PR_ERR_NONE;
}

PrErr PR_CALL rings_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                         void* extra) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Rings 1.1 — Premation SDK sample (generator with sequence data, a viewer overlay and a panel)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                       PR_OUT_FLAG_GENERATOR | PR_OUT_FLAG_SEQUENCE_DATA | PR_OUT_FLAG_THREADED_RENDER | PR_OUT_FLAG_CUSTOM_OVERLAY;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in);
    case PR_CMD_SEQUENCE_SETUP: {
      Palette p;
      roll(p);
      return new_sequence(in, out, p);
    }
    case PR_CMD_SEQUENCE_RESETUP: {
      Palette p;
      if (!read_palette(in, in->sequence_data, p)) roll(p);  // unreadable (older / damaged): start fresh
      if (in->sequence_data != 0) in->host->handle_dispose(in->host_ref, in->sequence_data);
      return new_sequence(in, out, p);
    }
    case PR_CMD_SEQUENCE_FLATTEN: out->sequence_data = in->sequence_data; return PR_ERR_NONE;  // already flat
    case PR_CMD_SEQUENCE_SETDOWN:
      if (in->sequence_data != 0) in->host->handle_dispose(in->host_ref, in->sequence_data);
      out->sequence_data = 0;
      return PR_ERR_NONE;
    case PR_CMD_USER_CHANGED_PARAM: {
      const auto* x = static_cast<const PrUserChangedParamExtra*>(extra);
      if (x == nullptr || params == nullptr || params[x->param_index] == nullptr) return PR_ERR_NONE;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const uint32_t id = params[x->param_index]->id;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      if (id != kShuffle && id != kSetPalette) return PR_ERR_NONE;
      Palette p;
      if (!read_palette(in, in->sequence_data, p)) roll(p);
      if (id == kSetPalette) {
        // SDK 1.1 payload: only a 1.1 host's struct has it.
        const bool has = x->struct_size >= offsetof(PrUserChangedParamExtra, payload_size) + sizeof(uint32_t);
        if (!has || x->payload == nullptr || !parse_palette(x->payload, x->payload_size, p)) {
          prs::message(out, "Set Palette takes 1 to 8 #rrggbb colours.");
          return PR_ERR_INVALID_PARAM;
        }
      } else {
        p.seed = xorshift(p.seed + 0x6D2B79F5U);
        p.count = 6;
        roll(p);
      }
      std::memcpy(in->host->handle_lock(in->host_ref, in->sequence_data), &p, sizeof(p));
      out->sequence_data = in->sequence_data;
      return PR_ERR_NONE;
    }
    case PR_CMD_SMART_PRE_RENDER: return PR_ERR_NONE;  // a generator checks nothing out
    case PR_CMD_SMART_RENDER: return smart_render(in, out, params);
    case PR_CMD_DRAW_OVERLAY: return draw_overlay(in, params);
    case PR_CMD_OVERLAY_DRAG: return overlay_drag(in, params, static_cast<const PrOverlayDragExtra*>(extra));
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.rings", &rings_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.rings", 1, kEffects};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
