// The render graph's GPU services on Dawn — the C++ twin of the TS renderer's
// WebGPUBackend + ResourceManager + MaterialSystem + ShaderCache + QuadRenderer.
//
// Resources are pooled by key (resource_pool.hpp): render targets by
// name + size (the transient pool — a target lives across frames and is
// reallocated only on a resize), textures by content hash, pipelines by
// (material, blend, format, samples), bind groups by what they bind. Unlike the
// TS QuadRenderer, which writes every draw's uniforms into its own buffer and so
// can never reuse a bind group within a frame, uniforms live in one per-frame
// arena addressed by DYNAMIC OFFSET: a bind group depends only on its textures
// and sampler, and is a cache hit on every frame after the first. The WGSL is
// unchanged — dynamic offsets are a layout property, invisible to the shader.
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "materials.hpp"
#include "gpu_profiler.hpp"
#include "resource_pool.hpp"

namespace premation::rg {

/// packages/renderer BlendMode.
/// The first nine follow api::RenderBlendMode (blend_of casts). `lighter` and
/// `atop` are Canvas2D's premultiplied `lighter` (colour AND alpha added) and
/// `source-atop` (Co = Cs·Ab + Cb·(1 − As), Ao = Ab); `dstIn` is
/// `destination-in` (Co = Cb·As, Ao = Ab·As) — E4's drawn-effect overlays.
/// `depthOnly` writes no colour (Commands::prepass_depth's first pass).
enum class Blend : std::uint8_t { normal, multiply, screen, overlay, add, subtract, darken, lighten, none, lighter, atop, dstIn, depthOnly };

/// A sampled texture: view + a stable identity for bind-group keys.
struct TexRef {
  wgpu::TextureView view;
  std::uint64_t id = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  bool sampleLinear = false;
  /// Mip levels built and sampleable from level 0 (0 or 1: level 0 alone) —
  /// Device::mip_texture builds a chain lazily, so a sampler for it must clamp
  /// its LOD to `mipLevels - 1` (PassContext::linear_clamp_levels).
  std::uint32_t mipLevels = 0;
  /// Mip levels the texture was allocated with (0 or 1: no chain).
  std::uint32_t mipAlloc = 0;
  explicit operator bool() const noexcept { return view != nullptr; }
};

struct SamplerRef {
  wgpu::Sampler sampler;
  std::uint64_t id = 0;
};

/// The 3D depth buffer: reversed float depth (near plane 1, far plane 0,
/// cleared to 0, compared GreaterEqual — threed.cpp reversed_projection).
/// Float precision then follows the distance (~1e-7 of it at any depth);
/// the standard mapping with a 1 px near plane left 0.4 px of resolution at
/// 2 700 px and 6 px at 10 000 px, so close surfaces fought and blinked.
inline constexpr wgpu::TextureFormat kDepthFormat = wgpu::TextureFormat::Depth32Float;

/// A render target (RenderTargetHandle): colour, optional MSAA pair, optional depth.
struct RenderTarget {
  wgpu::Texture texture;
  wgpu::TextureView view;
  wgpu::Texture msaa;
  wgpu::TextureView msaaView;
  /// The depth buffer, made on the first pass that tests depth (Device::depth_view),
  /// not with the target: most targets declared with depth (the precomp slots,
  /// scene colour) only ever take 2D draws, and an MSAA depth buffer is ~30 %
  /// of such a target's VRAM. Mutable: made through the const target a pass reads.
  mutable wgpu::Texture depth;
  mutable wgpu::TextureView depthView;
  /// Declared with depth: depth_view may make the buffer.
  bool wantsDepth = false;
  wgpu::TextureFormat format = wgpu::TextureFormat::RGBA16Float;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t samples = 1;
  std::uint64_t id = 0;
  [[nodiscard]] TexRef tex() const { return {view, id, width, height, true, 0, 0}; }
};

/// Graph targets by name (a frame's resolved set; looked up by string_view, no allocation).
using TargetMap = std::unordered_map<std::string, RenderTarget*, KeyHash, std::equal_to<>>;

/// Where a render pass draws: a named target, or the surface.
struct Attachment {
  RenderTarget* target = nullptr;  // nullptr = surface
  bool clear = false;
  double clear_r = 0, clear_g = 0, clear_b = 0, clear_a = 0;
  /// AE parity 4.2: the depth buffer comes from this target (same size and
  /// sample count) instead of `target`'s own — a layer drawn offscreen still
  /// tests against its 3D run. nullptr = `target`'s.
  const RenderTarget* depthFrom = nullptr;
  /// Keep the depth buffer's contents (a 3D run continued after an offscreen
  /// step) instead of clearing it.
  bool loadDepth = false;
};

/// One draw (DrawItem). Uniforms are an index range into the command buffer's float store.
struct DrawItem {
  Mat material = Mat::SOLID_MATERIAL;
  Blend blend = Blend::normal;
  std::uint32_t uniformOffset = 0;  // floats
  std::uint32_t uniformCount = 0;   // floats
  TexRef texture;
  SamplerRef sampler;
  TexRef mask;     // binding 3
  TexRef origin;   // binding 4
  /// Further bindings (3D: PBR maps 3-6, env 7/8, shadow 9/10, AO 11/12,
  /// shadow2 13/14, LUT 15). A fixed array, not a vector: 3D draws are per
  /// frame and this keeps them allocation-free.
  struct Extra {
    std::uint32_t binding = 0;
    TexRef tex;
    SamplerRef smp;
  };
  std::array<Extra, 16> extra{};
  std::uint8_t extraCount = 0;
  /// Depth writes for this draw: kDepthWriteMaterial = the material's own
  /// state, 0 = test without writing (AE parity 4.2: motion-blur samples, sky,
  /// shadow catcher), 1 = write.
  static constexpr std::uint8_t kDepthWriteMaterial = 2;
  std::uint8_t depthWrite = kDepthWriteMaterial;
  void bind(std::uint32_t binding, const TexRef& t) { extra.at(extraCount++) = {binding, t, {}}; }
  void bind(std::uint32_t binding, const SamplerRef& s) { extra.at(extraCount++) = {binding, {}, s}; }
  // Custom geometry (deformed mesh): vertex + index buffers.
  wgpu::Buffer vertexBuffer;
  wgpu::Buffer indexBuffer;
  std::uint32_t indexCount = 0;
  std::uint32_t firstIndex = 0;
  wgpu::IndexFormat indexFormat = wgpu::IndexFormat::Uint16;
  /// Per-instance data at vertex slot 1 (generator fields); drawn instanceCount times.
  /// instanceCount > 0 with no buffer: drawn that many times all the same (E4).
  wgpu::Buffer instanceBuffer;
  std::uint32_t instanceCount = 0;
  /// This draw alone clipped to (x, y, w, h), inside the pass's own scissor —
  /// a layer's composite limited to its effect chain's reach (fx_bounds.hpp).
  std::optional<std::array<std::uint32_t, 4>> scissor;
};

/// CommandBuffer: draws in paint order + their packed uniforms. Reused across
/// passes and frames (`clear` keeps capacity) so the hot path does not allocate.
class Commands {
 public:
  void clear() noexcept {
    items_.clear();
    floats_.clear();
  }
  /// Append `uniforms` and return the item to fill in.
  DrawItem& add(Mat material, Blend blend, std::span<const float> uniforms) {
    DrawItem it;
    it.material = material;
    it.blend = blend;
    it.uniformOffset = static_cast<std::uint32_t>(floats_.size());
    it.uniformCount = static_cast<std::uint32_t>(uniforms.size());
    floats_.insert(floats_.end(), uniforms.begin(), uniforms.end());
    items_.push_back(std::move(it));
    return items_.back();
  }
  /// The last item added (to attach a texture after the fact).
  DrawItem& last() noexcept { return items_.back(); }
  /// Set the depth-write override of every item from `first` on.
  void set_depth_write(std::size_t first, std::uint8_t depthWrite) noexcept {
    for (std::size_t i = first; i < items_.size(); ++i) items_[i].depthWrite = depthWrite;
  }
  /// The items from `first` on, drawn twice: first depth only (no colour,
  /// depth written), then as they were, tested against that depth and not
  /// writing it — so each pixel takes only its nearest surface, once (a
  /// translucent mesh's layer Opacity, threed.cpp).
  void prepass_depth(std::size_t first) {
    if (first >= items_.size()) return;
    const auto at = items_.begin() + static_cast<std::ptrdiff_t>(first);
    std::vector<DrawItem> pre(at, items_.end());
    for (DrawItem& it : pre) {
      it.blend = Blend::depthOnly;
      it.depthWrite = 1;
    }
    for (std::size_t i = first; i < items_.size(); ++i) items_[i].depthWrite = 0;
    items_.insert(items_.begin() + static_cast<std::ptrdiff_t>(first), pre.begin(), pre.end());
  }
  [[nodiscard]] std::size_t size() const noexcept { return items_.size(); }
  [[nodiscard]] bool empty() const noexcept { return items_.empty(); }
  [[nodiscard]] const std::vector<DrawItem>& items() const noexcept { return items_; }
  [[nodiscard]] std::span<const float> floats(const DrawItem& it) const noexcept {
    return std::span(floats_).subspan(it.uniformOffset, it.uniformCount);
  }

 private:
  std::vector<DrawItem> items_;
  std::vector<float> floats_;
};

struct DeviceStats {
  std::uint64_t pipelinesCreated = 0;
  /// Gamma blending: shaders drawn into an encoded target without a gamma-out variant (linear output).
  std::uint64_t gammaOutFallbacks = 0;
  std::uint64_t bindGroupHits = 0;
  std::uint64_t bindGroupMisses = 0;
  std::uint64_t targetHits = 0;
  std::uint64_t targetMisses = 0;
  std::uint64_t draws = 0;
  std::uint64_t passes = 0;
  std::uint64_t gpuBytes = 0;
  std::uint64_t gpuBytesPeak = 0;
  /// Textures not made because they were over the device's 2D size limit.
  std::uint64_t texturesRefused = 0;
};

/// Dawn-side services for one device. Owned by the SceneRenderer; single-threaded (the render thread).
class Device {
 public:
  Device(wgpu::Instance instance, wgpu::Device device, wgpu::Queue queue);
  ~Device();
  Device(const Device&) = delete;
  Device& operator=(const Device&) = delete;
  Device(Device&&) = delete;
  Device& operator=(Device&&) = delete;

  [[nodiscard]] const wgpu::Device& device() const noexcept { return device_; }
  [[nodiscard]] const wgpu::Queue& queue() const noexcept { return queue_; }
  [[nodiscard]] const wgpu::Instance& instance() const noexcept { return instance_; }
  /// Per-layer GPU time, one sampled frame at a time (gpu_profiler.hpp).
  [[nodiscard]] GpuProfiler& profiler() noexcept { return profiler_; }
  /// The device's maxTextureDimension2D (device_limits.hpp asks for up to 16384).
  [[nodiscard]] std::uint32_t max_texture_dimension() const noexcept { return maxTexture2D_; }

  // ── frame lifecycle ──
  void begin_frame();
  [[nodiscard]] wgpu::CommandEncoder& encoder() noexcept { return encoder_; }
  /// Flush the uniform arena, submit, run GC. Returns resources collected.
  std::size_t end_frame();
  /// Video-memory pressure (the OS budget is short): give back at least
  /// `bytes` of targets and textures the last frame did not use, oldest first
  /// — targets before textures (a texture costs a re-upload, a target only a
  /// re-allocation). Between frames only. Returns the bytes freed.
  std::uint64_t trim(std::uint64_t bytes);
  /// G1: submit everything encoded so far (with the uniform arena it reads) and
  /// continue the frame in a fresh encoder — for work that must run on the
  /// queue after the frame so far and before the rest of it: a native plugin's
  /// own command buffer, a mid-frame readback. One submit; the arena keeps its
  /// offsets (end_frame re-uploads the same bytes, queue-ordered).
  void flush();

  // ── resources ──
  /// Transient target by name + size (graph targets), created on a miss.
  /// `created` (optional) reports a miss: the target is new and holds nothing yet.
  RenderTarget& target(std::string_view name, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                       std::uint32_t samples, bool depth, bool* created = nullptr);
  /// A texture holding `pixels` (rows top-down, tightly packed), keyed by content hash.
  TexRef texture(std::string_view hash, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                 std::span<const std::uint8_t> pixels, bool mipmapped);
  /// The texture `hash` with its mip chain built `levels` deep (clamped to the
  /// full chain): built lazily — level 0 at upload, deeper levels the first time
  /// a draw asks for them (mip_levels_needed), never rebuilt. One texture per
  /// picture: one first made single-level is made again, once, with room for
  /// the whole chain when a draw first needs one. TexRef::mipLevels = built.
  TexRef mip_texture(std::string_view hash, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                     std::span<const std::uint8_t> pixels, std::uint32_t levels);
  /// `lodMaxClamp`: the deepest level sampled (32 = all, WebGPU's default).
  SamplerRef sampler(std::string_view key, wgpu::FilterMode filter, wgpu::AddressMode address, std::uint16_t maxAnisotropy = 1,
                     float lodMaxClamp = 32.0F);
  /// The shared unit quad (Geometry.ts UNIT_QUAD).
  [[nodiscard]] const wgpu::Buffer& quad() const noexcept { return quad_; }
  /// A vertex/index buffer holding `bytes`, keyed. Uploaded on creation only,
  /// unless `always` (per-frame geometry: deformed meshes, generator instances);
  /// a key that names the content (an extrusion's geometry key) uploads once.
  wgpu::Buffer geometry(std::string_view key, std::span<const std::uint8_t> bytes, bool index, bool always = false);

  // ── passes ──
  /// Begin a render pass on `att` with the viewport set to w × h. `scissor`
  /// clips draws (the surface's frame clip; an effect chain's reach on a target).
  /// A clear still clears the whole attachment.
  /// `t`'s depth buffer, made on first use (RenderTarget::depth); null when `t`
  /// was declared without depth.
  const wgpu::TextureView& depth_view(const RenderTarget& t);
  wgpu::RenderPassEncoder begin_pass(const Attachment& att, std::uint32_t w, std::uint32_t h,
                                     const wgpu::TextureView& surfaceView, wgpu::TextureFormat surfaceFormat,
                                     const std::array<std::uint32_t, 4>* scissor, bool depth);
  /// QuadRenderer.execute: bind pipelines + groups and draw every item.
  /// `gammaOut`: the target holds sRGB-encoded colour (gamma blending), so every
  /// item draws through its shader's gamma_out_wgsl variant.
  void execute(wgpu::RenderPassEncoder& pass, const Commands& cmds, wgpu::TextureFormat format,
               std::uint32_t samples, bool gammaOut = false);

  /// Draw one quad into `target` OUTSIDE the frame's command encoder: its own
  /// command buffer, submitted now — so it runs before the frame's — with its
  /// own uniform buffer (the frame's arena is uploaded only at end_frame). For
  /// one-off texture preparation (a mip chain, a colour-managed footage
  /// conversion): once per content, never per frame, so the allocations here
  /// are off the hot path. Safe to call while a frame render pass is open.
  void side_draw(const wgpu::TextureView& target, wgpu::TextureFormat format, std::uint32_t w, std::uint32_t h,
                 const DrawItem& item, std::span<const float> uniforms);

  /// A material not in the builtin table — a plugin effect's host-supplied WGSL
  /// with the layout its manifest implies (CompositionPass pluginMaterial).
  /// Memoised by name + layout; the returned Mat is only valid on this device.
  Mat dynamic_material(std::string_view name, std::string_view wgsl, std::span<const LayoutEntry> layout);
  /// SDK 1.4 (D3): runtime WGSL with `like`'s bindings, vertex buffers and depth state (a plugin
  /// material linked into a built-in mesh shader). Keyed by `name`: the same name is the same material.
  Mat dynamic_material_like(std::string_view name, std::string_view wgsl, Mat like);
  [[nodiscard]] const MaterialDesc& material_of(Mat m) const;

  [[nodiscard]] DeviceStats stats() const;
  [[nodiscard]] const MemoryMeter& memory() const noexcept { return meter_; }
  [[nodiscard]] std::uint64_t frame() const noexcept { return frame_; }

  /// First WGSL compile / pipeline error seen (validation is asynchronous in
  /// WebGPU; Dawn reports it through the error scope this device pushes).
  [[nodiscard]] std::string take_error();

  /// P7: build the pipeline an effect-chain pass of `material` uses (normal
  /// blend into an rgba16float target, one sample) ahead of its first draw.
  /// P7: compile `material`'s pipeline for a chain pass (one sample, `format` targets) ahead of its first draw.
  void warm_pipeline(Mat material, Blend blend, wgpu::TextureFormat format) { (void)pipeline(material, blend, format, 1); }
  /// Program X: build `material`'s pipeline (one sample) inside its own
  /// validation error scope and wait for the verdict: "" = valid, else Dawn's
  /// message (a WGSL error, a layout mismatch). Kept per pipeline. A caller
  /// that draws only with valid pipelines cannot invalidate the frame's
  /// command buffer — a bad dynamic shader skips its own effect, never the frame.
  [[nodiscard]] const std::string& pipeline_error(Mat material, Blend blend, wgpu::TextureFormat format, bool gammaOut = false);
  /// Whether `material`'s shader has a gamma-out variant (gamma_out_wgsl). One
  /// without draws linear into an encoded target (DeviceStats::gammaOutFallbacks).
  [[nodiscard]] bool has_gamma_out(Mat material);

 private:
  struct Pipeline {
    wgpu::RenderPipeline pipeline;
    wgpu::BindGroupLayout layout;
    std::uint64_t id = 0;
  };
  const Pipeline& pipeline(Mat material, Blend blend, wgpu::TextureFormat format, std::uint32_t samples,
                           std::uint8_t depthWrite = DrawItem::kDepthWriteMaterial, bool gammaOut = false);
  wgpu::BindGroup make_bind_group(const Pipeline& p, const MaterialDesc& m, const DrawItem& it, const wgpu::Buffer& uniforms,
                                  std::uint64_t size);
  /// Fill levels [from, to) of `tex` (w × h at level 0), each from the one above (kMipWgsl).
  void generate_mips(const wgpu::Texture& tex, wgpu::TextureFormat format, std::uint32_t w, std::uint32_t h,
                     std::uint32_t from, std::uint32_t to);
  /// texture() with `levels` allocated; `build`: the chain filled now (else level 0 only).
  TexRef make_texture(std::string_view hash, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                      std::span<const std::uint8_t> pixels, std::uint32_t levels, bool build);
  /// `gammaOut`: the gamma_out_wgsl variant (the plain module when it has none).
  wgpu::ShaderModule& shader(std::string_view name, bool gammaOut = false);
  /// The WGSL of shader `name`: a dynamic material's, else the builtin table's.
  [[nodiscard]] std::string wgsl_of(std::string_view name) const;
  /// Reserve `bytes` of uniform space; returns (chunk, byte offset).
  std::pair<std::uint32_t, std::uint32_t> uniform_alloc(std::span<const float> data);

  wgpu::Instance instance_;
  wgpu::Device device_;
  wgpu::Queue queue_;
  wgpu::CommandEncoder encoder_;
  wgpu::Buffer quad_;
  std::uint64_t frame_ = 0;
  std::uint64_t nextId_ = 1;
  std::uint32_t maxTexture2D_ = 8192;  // the WebGPU default, until the device says
  std::uint64_t maxBufferSize_ = 268435456;  // the WebGPU default (256 MB), until the device says

  MemoryMeter meter_;
  Pool<RenderTarget> targets_{&meter_};
  Pool<TexRef> textures_{&meter_};
  Pool<wgpu::Texture> textureObjects_{nullptr};
  Pool<wgpu::Buffer> buffers_{&meter_};
  Pool<SamplerRef> samplers_{nullptr};
  Pool<Pipeline> pipelines_{nullptr};
  Pool<wgpu::BindGroup> bindGroups_{nullptr};
  std::unordered_map<std::string, wgpu::ShaderModule> shaders_;
  /// Per shader name: whether gamma_out_wgsl could wrap it (filled on first ask).
  std::unordered_map<std::string, bool> gammaOut_;
  /// has_gamma_out by material index (-1 = not asked yet): the per-draw lookup allocates nothing once warm.
  std::vector<std::int8_t> gammaOutByMat_;
  struct Dynamic {
    std::string key;
    std::string shader;
    std::vector<LayoutEntry> layout;
    MaterialDesc desc;
  };
  std::vector<std::unique_ptr<Dynamic>> dynamic_;
  std::unordered_map<std::string, std::string> dynamicWgsl_;
  std::unordered_map<std::string, std::string> pipelineErrors_;

  struct UniformChunk {
    wgpu::Buffer buffer;
    std::vector<std::uint8_t> cpu;
    std::uint32_t used = 0;
    std::uint64_t id = 0;
  };
  std::vector<UniformChunk> chunks_;
  std::uint32_t chunk_ = 0;

  std::string key_;  // scratch, reused for keys (no per-draw allocation once warm)
  /// The scissor of the pass begin_pass opened last (its whole attachment when it
  /// has none): a draw's own scissor is cut to it, and it is restored after.
  std::array<std::uint32_t, 4> passRect_{};
  DeviceStats stats_;
  GpuProfiler profiler_;
  std::string firstError_;
};

wgpu::TextureFormat texture_format(std::string_view tsName) noexcept;

/// A full mip chain's level count for w × h (WebGPUBackend `mipCount`).
std::uint32_t mip_levels(std::uint32_t w, std::uint32_t h) noexcept;
/// The quad a texture is drawn over, in device pixels (0 × 0: unknown).
struct MipFootprint {
  double width = 0, height = 0;
};
/// The mip levels a w × h texture drawn over `fp` samples with the 2D layers'
/// ½ gradient scale (composition_pass.cpp kLayerLodScale): 1 up to a 2:1
/// minification on both axes (most layers: rasters are supersampled 2×), else
/// the levels its LOD reaches plus one (trilinear's upper level, and room for
/// a GPU's LOD approximation); the whole chain for an unknown footprint (a 3D
/// quad, a projective draw).
std::uint32_t mip_levels_needed(std::uint32_t w, std::uint32_t h, const MipFootprint& fp) noexcept;

}  // namespace premation::rg
