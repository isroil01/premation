// The native plugin host's render glue (G1): the render graph's
// NativeEffectHost. A `native-plugin` chain entry (fx_wire.hpp) arrives with
// the chain's current buffer; the glue runs the plugin and leaves its output
// in the chain's free target, or declines — the chain then continues from its
// input, and the reason is recorded (layerErrors), never a failed frame.
//
//   GPU effect (PR_OUT_FLAG_GPU_RENDER): SMART_RENDER_GPU on the engine's own
//   Dawn device — the chain buffer is the input texture as is, the output is a
//   texture the glue owns (the SDK's full usage set: render attachment,
//   storage, sampling, copy), recorded into a fresh command encoder inside a
//   validation + out-of-memory error scope; an error drops the command buffer
//   unsubmitted and the effect falls back to the CPU path.
//
//   CPU effect: the chain buffer and every checkout are read back into
//   TexelImages and handed to run_native_cpu (cpu_render.hpp — the same code
//   the host tests exercise); the output is uploaded and drawn into the target.
//
// Checkouts: the input at the frame's time is the chain buffer; a LAYER param
// or the effect's own layer at ANOTHER time resolves through the chain's
// MapLayerSource (displacement maps' path) — other times by the hidden
// `<layer>@<flicks>` renderables finish_native_frame added to the frame.
//
// Render thread only (the Device is single-threaded).
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <tuple>

#include "effect_chain.hpp"

namespace premation::plugins {

class PluginHost;

class RenderGlue final : public rg::NativeEffectHost {
 public:
  /// `host` nullptr = PluginHost::active() at each call (the engine's host).
  explicit RenderGlue(PluginHost* host = nullptr) : host_(host) {}
  bool apply(rg::PassContext& ctx, const Call& call) override;

 private:
  struct OwnTexture {
    wgpu::Texture texture;
    wgpu::TextureView view;
    std::uint64_t id = 0;
  };
  OwnTexture& own(rg::Device& dev, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format, std::uint32_t slot);
  PluginHost* host_;
  std::uint32_t deviceIndex_ = 0;
  std::uint64_t nextId_ = 0;
  std::map<std::tuple<std::uint32_t, std::uint32_t, std::uint32_t, std::uint32_t>, OwnTexture> textures_;
};

}  // namespace premation::plugins
