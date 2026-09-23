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
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "materials.hpp"
#include "resource_pool.hpp"

namespace premation::rg {

/// packages/renderer BlendMode.
enum class Blend : std::uint8_t { normal, multiply, screen, overlay, add, subtract, darken, lighten, none };

/// A sampled texture: view + a stable identity for bind-group keys.
struct TexRef {
  wgpu::TextureView view;
  std::uint64_t id = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  bool sampleLinear = false;
  explicit operator bool() const noexcept { return view != nullptr; }
};

struct SamplerRef {
  wgpu::Sampler sampler;
  std::uint64_t id = 0;
};

/// A render target (RenderTargetHandle): colour, optional MSAA pair, optional depth.
struct RenderTarget {
  wgpu::Texture texture;
  wgpu::TextureView view;
  wgpu::Texture msaa;
  wgpu::TextureView msaaView;
  wgpu::Texture depth;
  wgpu::TextureView depthView;
  wgpu::TextureFormat format = wgpu::TextureFormat::RGBA16Float;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t samples = 1;
  std::uint64_t id = 0;
  [[nodiscard]] TexRef tex() const { return {view, id, width, height, true}; }
};

/// Where a render pass draws: a named target, or the surface.
struct Attachment {
  RenderTarget* target = nullptr;  // nullptr = surface
  bool clear = false;
  double clear_r = 0, clear_g = 0, clear_b = 0, clear_a = 0;
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
  void bind(std::uint32_t binding, const TexRef& t) { extra.at(extraCount++) = {binding, t, {}}; }
  void bind(std::uint32_t binding, const SamplerRef& s) { extra.at(extraCount++) = {binding, {}, s}; }
  // Custom geometry (deformed mesh): vertex + index buffers.
  wgpu::Buffer vertexBuffer;
  wgpu::Buffer indexBuffer;
  std::uint32_t indexCount = 0;
  std::uint32_t firstIndex = 0;
  wgpu::IndexFormat indexFormat = wgpu::IndexFormat::Uint16;
  /// Per-instance data at vertex slot 1 (generator fields); drawn instanceCount times.
  wgpu::Buffer instanceBuffer;
  std::uint32_t instanceCount = 0;
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
  std::uint64_t bindGroupHits = 0;
  std::uint64_t bindGroupMisses = 0;
  std::uint64_t targetHits = 0;
  std::uint64_t targetMisses = 0;
  std::uint64_t draws = 0;
  std::uint64_t passes = 0;
  std::uint64_t gpuBytes = 0;
  std::uint64_t gpuBytesPeak = 0;
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

  // ── frame lifecycle ──
  void begin_frame();
  [[nodiscard]] wgpu::CommandEncoder& encoder() noexcept { return encoder_; }
  /// Flush the uniform arena, submit, run GC. Returns resources collected.
  std::size_t end_frame();

  // ── resources ──
  /// Transient target by name + size (graph targets), created on a miss.
  RenderTarget& target(std::string_view name, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                       std::uint32_t samples, bool depth);
  /// A texture holding `pixels` (rows top-down, tightly packed), keyed by content hash.
  TexRef texture(std::string_view hash, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                 std::span<const std::uint8_t> pixels, bool mipmapped);
  SamplerRef sampler(std::string_view key, wgpu::FilterMode filter, wgpu::AddressMode address);
  /// The shared unit quad (Geometry.ts UNIT_QUAD).
  [[nodiscard]] const wgpu::Buffer& quad() const noexcept { return quad_; }
  /// A vertex/index buffer holding `bytes`, keyed. Uploaded on creation only,
  /// unless `always` (per-frame geometry: deformed meshes, generator instances);
  /// a key that names the content (an extrusion's geometry key) uploads once.
  wgpu::Buffer geometry(std::string_view key, std::span<const std::uint8_t> bytes, bool index, bool always = false);

  // ── passes ──
  /// Begin a render pass on `att` with the viewport set to w × h. `scissor`
  /// (surface passes only) clips draws.
  wgpu::RenderPassEncoder begin_pass(const Attachment& att, std::uint32_t w, std::uint32_t h,
                                     const wgpu::TextureView& surfaceView, wgpu::TextureFormat surfaceFormat,
                                     const std::array<std::uint32_t, 4>* scissor, bool depth);
  /// QuadRenderer.execute: bind pipelines + groups and draw every item.
  void execute(wgpu::RenderPassEncoder& pass, const Commands& cmds, wgpu::TextureFormat format,
               std::uint32_t samples);

  /// A material not in the builtin table — a plugin effect's host-supplied WGSL
  /// with the layout its manifest implies (CompositionPass pluginMaterial).
  /// Memoised by name + layout; the returned Mat is only valid on this device.
  Mat dynamic_material(std::string_view name, std::string_view wgsl, std::span<const LayoutEntry> layout);
  [[nodiscard]] const MaterialDesc& material_of(Mat m) const;

  [[nodiscard]] DeviceStats stats() const;
  [[nodiscard]] const MemoryMeter& memory() const noexcept { return meter_; }
  [[nodiscard]] std::uint64_t frame() const noexcept { return frame_; }

  /// First WGSL compile / pipeline error seen (validation is asynchronous in
  /// WebGPU; Dawn reports it through the error scope this device pushes).
  [[nodiscard]] std::string take_error();

 private:
  struct Pipeline {
    wgpu::RenderPipeline pipeline;
    wgpu::BindGroupLayout layout;
    std::uint64_t id = 0;
  };
  const Pipeline& pipeline(Mat material, Blend blend, wgpu::TextureFormat format, std::uint32_t samples);
  wgpu::ShaderModule& shader(std::string_view name);
  /// Reserve `bytes` of uniform space; returns (chunk, byte offset).
  std::pair<std::uint32_t, std::uint32_t> uniform_alloc(std::span<const float> data);

  wgpu::Instance instance_;
  wgpu::Device device_;
  wgpu::Queue queue_;
  wgpu::CommandEncoder encoder_;
  wgpu::Buffer quad_;
  std::uint64_t frame_ = 0;
  std::uint64_t nextId_ = 1;

  MemoryMeter meter_;
  Pool<RenderTarget> targets_{&meter_};
  Pool<TexRef> textures_{&meter_};
  Pool<wgpu::Texture> textureObjects_{nullptr};
  Pool<wgpu::Buffer> buffers_{&meter_};
  Pool<SamplerRef> samplers_{nullptr};
  Pool<Pipeline> pipelines_{nullptr};
  Pool<wgpu::BindGroup> bindGroups_{nullptr};
  std::unordered_map<std::string, wgpu::ShaderModule> shaders_;
  struct Dynamic {
    std::string key;
    std::string shader;
    std::vector<LayoutEntry> layout;
    MaterialDesc desc;
  };
  std::vector<std::unique_ptr<Dynamic>> dynamic_;
  std::unordered_map<std::string, std::string> dynamicWgsl_;

  struct UniformChunk {
    wgpu::Buffer buffer;
    std::vector<std::uint8_t> cpu;
    std::uint32_t used = 0;
    std::uint64_t id = 0;
  };
  std::vector<UniformChunk> chunks_;
  std::uint32_t chunk_ = 0;

  std::string key_;  // scratch, reused for keys (no per-draw allocation once warm)
  DeviceStats stats_;
  std::string firstError_;
};

wgpu::TextureFormat texture_format(std::string_view tsName) noexcept;

}  // namespace premation::rg
