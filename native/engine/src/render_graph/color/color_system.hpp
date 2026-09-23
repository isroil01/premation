// D3 colour management on the GPU: OCIO programs (ocio_ffi.hpp) applied as
// render-graph passes — docs/NATIVE_CORE_PLAN.md §5 D3.
//
// After Effects' model, stage by stage:
//
//   input       each colour texture tagged with an interpretation
//               (RenderTextureRef.inputSpace) is converted ONCE — per content
//               hash and interpretation — into a working-space linear float
//               texture (kColorInputWgsl, a side draw before the frame), and
//               every later sample of it is a plain linear read. Untagged
//               textures are data (masks, LUT strips, maps): never touched.
//   working     compositing is linear light in the working space's primaries;
//               authored colours reach it through ColorPipeline.fromLinear709.
//   display /   the final scene → surface blit runs the working → display (or,
//   output      on an export frame, → output) program, then the viewer LUT,
//               in place of scene-blit (kColorDisplayWgsl).
//
// A frame WITHOUT RenderView.colorManagement never reaches any of this: the
// builtin TS transfer functions run, byte for byte (the golden gate).
#pragma once

#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>

#include "bit_depth.hpp"
#include "color_program.hpp"
#include "device.hpp"
#include "engine_api.hpp"
#include "ocio_ffi.hpp"
#include "rg_math.hpp"

namespace premation::rg {

struct PassContext;

class ColorSystem {
 public:
  explicit ColorSystem(Device& dev);
  ~ColorSystem();
  ColorSystem(const ColorSystem&) = delete;
  ColorSystem& operator=(const ColorSystem&) = delete;
  ColorSystem(ColorSystem&&) = delete;
  ColorSystem& operator=(ColorSystem&&) = delete;

  /// This build links OpenColorIO (the engine feature). Without it a managed
  /// frame is reported not-ported instead of drawn wrong.
  static bool available() noexcept;

  /// Configure for one frame from its view; fills the frame's ColorPipeline.
  /// False (+ error) when the view asks for management this build cannot give.
  bool begin_frame(const api::RenderView& view, IntermediatePrecision precision, ColorPipeline& pipeline, std::string& error);
  [[nodiscard]] bool active() const noexcept { return active_; }

  /// `src` (blob `hash`, interpreted as `space`) as a working-space linear texture.
  TexRef input(const TexRef& src, std::string_view hash, api::RenderColorSpace space);

  /// The display/output blit of `scene` (+ the viewer LUT when `viewerMeta`).
  void emit_display(PassContext& ctx, Commands& cmds, const TexRef& scene, const TexRef& viewerTex,
                    const api::RenderViewerLut* viewerMeta);

  /// The program for `req` (cached). Tests and the bench read it; nullptr + error on failure.
  const color::Program* program(const color::Request& req, std::string& error);

  /// Measurement hook: bake every program to an N³ lattice even when the op
  /// list expresses it (0 = off, the default). Lets the bench time both routes.
  void force_lattice(std::uint32_t n) noexcept { forceLattice_ = n; }

 private:
  TexRef lut_texture(const color::Program& p);
  TexRef dummy_f32();
  TexRef dummy_rgba8();
  /// The colour shaders' Object block: full-screen mvp, uv, op count, viewer LUT, the ops.
  static void pack_object(std::vector<float>& out, const color::Program& p, const std::array<double, 4>& viewer);

  Device& dev_;
  bool active_ = false;
  color::Space working_ = color::Space::linear_srgb;
  wgpu::TextureFormat inputFormat_ = wgpu::TextureFormat::RGBA16Float;
  const color::Program* display_ = nullptr;
  std::string configName_;
  std::unique_ptr<color::Ocio> ocio_;
  std::unordered_map<std::string, color::Program> programs_;
  std::unordered_map<std::string, TexRef> luts_;
  Mat displayMat_{};
  Mat inputMat_{};
  bool materials_ = false;
  std::uint32_t forceLattice_ = 0;
  std::vector<float> scratch_;
};

}  // namespace premation::rg
