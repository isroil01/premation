// Test plugin for reloadPlugin (W2, tests/test_plugin_reload.cpp). Built twice, as
// reload_probe_v1 and reload_probe_v2 (RELOAD_PROBE_VERSION 1 / 2), under ONE plugin id, so the
// test can "rebuild" a bundle by overwriting its binary with the other build.
//
// It fills its output with red = version / 4, green = 1 and alpha = 1. Each instance keeps the
// version that set it up in its sequence data; a render handed another build's sequence data
// fails, so a reload that kept an old instance under the new code is caught.
#include <premation_sdk/premation_sdk.h>

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

#ifndef RELOAD_PROBE_VERSION
#error "build with RELOAD_PROBE_VERSION=1 or 2"
#endif

namespace {

constexpr std::int32_t kVersion = RELOAD_PROBE_VERSION;

std::int32_t sequence_version(const PrInData* in) {
  if (in->sequence_data == 0 || in->host->handle_size(in->host_ref, in->sequence_data) < sizeof(std::int32_t)) return 0;
  std::int32_t v = 0;
  std::memcpy(&v, in->host->handle_lock(in->host_ref, in->sequence_data), sizeof(v));
  return v;
}

PrErr new_sequence(const PrInData* in, PrOutData* out) {
  const PrHandle h = in->host->handle_new(in->host_ref, sizeof(std::int32_t));
  if (h == 0) return PR_ERR_OUT_OF_MEMORY;
  std::memcpy(in->host->handle_lock(in->host_ref, h), &kVersion, sizeof(kVersion));
  out->sequence_data = h;
  return PR_ERR_NONE;
}

PrErr render(const PrInData* in, PrOutData* out) {
  if (sequence_version(in) != kVersion) {
    std::snprintf(out->return_msg, sizeof(out->return_msg), "%s", "reload_probe: an instance set up by another build");
    return PR_ERR_INTERNAL;
  }
  PrWorld* dst = nullptr;
  if (const PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  for (std::int32_t y = 0; y < dst->height; ++y) {
    auto* row = static_cast<std::uint8_t*>(dst->data) + static_cast<std::ptrdiff_t>(y) * dst->row_bytes;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    for (std::int32_t x = 0; x < dst->width; ++x) {
      const float px[4] = {static_cast<float>(kVersion) / 4.0F, 1.0F, 0.0F, 1.0F};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
      if (dst->format == PR_PIXEL_FORMAT_RGBA32F) {
        std::memcpy(row + static_cast<std::ptrdiff_t>(x) * 16, px, sizeof(px));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      } else if (dst->format == PR_PIXEL_FORMAT_RGBA16) {
        auto* p = reinterpret_cast<std::uint16_t*>(row) + static_cast<std::ptrdiff_t>(x) * 4;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast, cppcoreguidelines-pro-bounds-pointer-arithmetic)
        for (int k = 0; k < 4; ++k) p[k] = static_cast<std::uint16_t>(px[k] * 65535.0F + 0.5F);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic, cppcoreguidelines-pro-bounds-constant-array-index)
      } else {
        std::uint8_t* p = row + static_cast<std::ptrdiff_t>(x) * 4;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        for (int k = 0; k < 4; ++k) p[k] = static_cast<std::uint8_t>(px[k] * 255.0F + 0.5F);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic, cppcoreguidelines-pro-bounds-constant-array-index)
      }
    }
  }
  return PR_ERR_NONE;
}

PrErr PR_CALL probe_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* /*params*/, PrWorld* /*output*/,
                         void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(static_cast<std::uint32_t>(kVersion), 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                       PR_OUT_FLAG_GENERATOR | PR_OUT_FLAG_SEQUENCE_DATA;
      return PR_ERR_NONE;
    case PR_CMD_SEQUENCE_SETUP: return new_sequence(in, out);
    case PR_CMD_SEQUENCE_RESETUP:
      // The document's flat bytes may come from either build: this build sets up its own.
      if (in->sequence_data != 0) in->host->handle_dispose(in->host_ref, in->sequence_data);
      return new_sequence(in, out);
    case PR_CMD_SEQUENCE_FLATTEN: out->sequence_data = in->sequence_data; return PR_ERR_NONE;
    case PR_CMD_SEQUENCE_SETDOWN:
      if (in->sequence_data != 0) in->host->handle_dispose(in->host_ref, in->sequence_data);
      out->sequence_data = 0;
      return PR_ERR_NONE;
    case PR_CMD_SMART_PRE_RENDER: return PR_ERR_NONE;
    case PR_CMD_SMART_RENDER: return render(in, out);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.test.reload.probe", &probe_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.test.reload", 1, kEffects, 0, nullptr, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
