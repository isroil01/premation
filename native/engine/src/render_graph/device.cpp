#include "device.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <utility>

#include "color_wgsl.hpp"

namespace premation::rg {
namespace {

/// Uniform arena chunk; dynamic offsets are 256-byte aligned (minUniformBufferOffsetAlignment).
constexpr std::uint32_t kChunkBytes = 4U << 20U;
constexpr std::uint32_t kUniformAlign = 256;

/// WebGPUBackend.ts `blendState` — premultiplied source-over by default.
bool blend_state(Blend mode, wgpu::BlendState& out) {
  const wgpu::BlendComponent over{wgpu::BlendOperation::Add, wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha};
  out.alpha = over;
  switch (mode) {
    case Blend::none: return false;
    case Blend::add: out.color = {wgpu::BlendOperation::Add, wgpu::BlendFactor::One, wgpu::BlendFactor::One}; return true;
    case Blend::multiply: out.color = {wgpu::BlendOperation::Add, wgpu::BlendFactor::Dst, wgpu::BlendFactor::Zero}; return true;
    case Blend::screen: out.color = {wgpu::BlendOperation::Add, wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrc}; return true;
    case Blend::subtract:
      out.color = {wgpu::BlendOperation::ReverseSubtract, wgpu::BlendFactor::One, wgpu::BlendFactor::One};
      return true;
    case Blend::darken: out.color = {wgpu::BlendOperation::Min, wgpu::BlendFactor::One, wgpu::BlendFactor::One}; return true;
    case Blend::lighten: out.color = {wgpu::BlendOperation::Max, wgpu::BlendFactor::One, wgpu::BlendFactor::One}; return true;
    case Blend::lighter:
      out.color = {wgpu::BlendOperation::Add, wgpu::BlendFactor::One, wgpu::BlendFactor::One};
      out.alpha = out.color;
      return true;
    case Blend::atop:
      out.color = {wgpu::BlendOperation::Add, wgpu::BlendFactor::DstAlpha, wgpu::BlendFactor::OneMinusSrcAlpha};
      out.alpha = {wgpu::BlendOperation::Add, wgpu::BlendFactor::Zero, wgpu::BlendFactor::One};
      return true;
    case Blend::dstIn:
      out.color = {wgpu::BlendOperation::Add, wgpu::BlendFactor::Zero, wgpu::BlendFactor::SrcAlpha};
      out.alpha = out.color;
      return true;
    default: out.color = over; return true;
  }
}

wgpu::VertexFormat vertex_format(VertexFormat f) {
  switch (f) {
    case VertexFormat::Float32: return wgpu::VertexFormat::Float32;
    case VertexFormat::Float32x2: return wgpu::VertexFormat::Float32x2;
    case VertexFormat::Float32x3: return wgpu::VertexFormat::Float32x3;
    case VertexFormat::Float32x4: return wgpu::VertexFormat::Float32x4;
  }
  return wgpu::VertexFormat::Float32x2;
}

std::uint32_t bytes_per_texel(wgpu::TextureFormat f) {
  switch (f) {
    case wgpu::TextureFormat::R8Unorm: return 1;
    case wgpu::TextureFormat::RGBA16Float: return 8;
    case wgpu::TextureFormat::RGBA32Float: return 16;
    default: return 4;
  }
}

/// Scissor `a` cut to `b` (x, y, w, h); an empty result keeps its corner inside `b`.
std::array<std::uint32_t, 4> clip_rect(const std::array<std::uint32_t, 4>& a, const std::array<std::uint32_t, 4>& b) {
  const std::uint64_t bx1 = std::uint64_t{b[0]} + b[2];
  const std::uint64_t by1 = std::uint64_t{b[1]} + b[3];
  const std::uint64_t x0 = std::min<std::uint64_t>(std::max(a[0], b[0]), bx1);
  const std::uint64_t y0 = std::min<std::uint64_t>(std::max(a[1], b[1]), by1);
  const std::uint64_t x1 = std::max(x0, std::min(std::uint64_t{a[0]} + a[2], bx1));
  const std::uint64_t y1 = std::max(y0, std::min(std::uint64_t{a[1]} + a[3], by1));
  return {static_cast<std::uint32_t>(x0), static_cast<std::uint32_t>(y0), static_cast<std::uint32_t>(x1 - x0),
          static_cast<std::uint32_t>(y1 - y0)};
}

void append_u64(std::string& s, std::uint64_t v) {
  std::array<char, 24> buf{};
  std::size_t n = 0;
  for (bool first = true; (first || v != 0) && n < buf.size(); first = false) {
    buf.at(n++) = static_cast<char>('0' + v % 10);
    v /= 10;
  }
  while (n > 0) s.push_back(buf.at(--n));
}

}  // namespace

wgpu::TextureFormat texture_format(std::string_view n) noexcept {
  if (n == "rgba16float") return wgpu::TextureFormat::RGBA16Float;
  if (n == "rgba32float") return wgpu::TextureFormat::RGBA32Float;
  if (n == "bgra8unorm") return wgpu::TextureFormat::BGRA8Unorm;
  if (n == "rgba8unorm-srgb") return wgpu::TextureFormat::RGBA8UnormSrgb;
  if (n == "r8unorm") return wgpu::TextureFormat::R8Unorm;
  return wgpu::TextureFormat::RGBA8Unorm;
}

Device::Device(wgpu::Instance instance, wgpu::Device device, wgpu::Queue queue)
    : instance_(std::move(instance)), device_(std::move(device)), queue_(std::move(queue)) {
  constexpr std::array<float, 12> kQuad = {0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1};
  wgpu::BufferDescriptor qd{};
  qd.size = sizeof(kQuad);
  qd.usage = wgpu::BufferUsage::Vertex | wgpu::BufferUsage::CopyDst;
  qd.label = "unit-quad";
  quad_ = device_.CreateBuffer(&qd);
  queue_.WriteBuffer(quad_, 0, kQuad.data(), sizeof(kQuad));
  profiler_.init(device_, instance_);
  wgpu::Limits limits{};
  if (device_.GetLimits(&limits) == wgpu::Status::Success && limits.maxTextureDimension2D != wgpu::kLimitU32Undefined) {
    maxTexture2D_ = limits.maxTextureDimension2D;
  }
  if (device_.GetLimits(&limits) == wgpu::Status::Success && limits.maxBufferSize != wgpu::kLimitU64Undefined) {
    maxBufferSize_ = limits.maxBufferSize;
  }
}

Device::~Device() = default;

void Device::begin_frame() {
  ++frame_;
  chunk_ = 0;
  for (auto& c : chunks_) c.used = 0;
  encoder_ = device_.CreateCommandEncoder();
  profiler_.begin_frame(frame_);
}

std::size_t Device::end_frame() {
  for (std::uint32_t i = 0; i < chunks_.size() && i <= chunk_; ++i) {
    UniformChunk& c = chunks_[i];
    if (c.used > 0) queue_.WriteBuffer(c.buffer, 0, c.cpu.data(), c.used);
  }
  if (encoder_ != nullptr) {
    profiler_.end_frame(encoder_);
    wgpu::CommandBuffer cb = encoder_.Finish();
    queue_.Submit(1, &cb);
    encoder_ = nullptr;
    profiler_.after_submit();
  }
  constexpr std::uint64_t kMaxIdle = 120;  // ResourceManager default maxIdleFrames
  // Content textures (rasters, footage frames) outlive a playback loop while
  // they fit the budget (P10): a 30 s loop no longer re-uploads every raster
  // each time round. Anything idle for two minutes (at 30 fps) still goes.
  constexpr std::uint64_t kLoopIdle = 3600;
  constexpr std::uint64_t kTextureBudget = std::uint64_t{512} << 20U;
  const std::size_t textures = textures_.collect_budgeted(frame_, kMaxIdle, kLoopIdle, kTextureBudget);
  // E3: graph targets of a slot size the viewport left (Full ↔ Half, a pane
  // resize) stay warm for a minute while they fit the budget, so switching back
  // is a pool hit instead of a reallocation of every target (a 0.1–1.7 s stall
  // on a 3D comp). Anything idle a minute still goes, whatever the budget.
  // Over the budget, an idle MULTISAMPLED target goes after a few frames rather
  // than kMaxIdle: those are the viewport slots (scene colour, one precomp slot
  // per nesting level, ~83 MB each at 1080p), and a Full → Half switch kept the
  // whole Full set resident beside the Half one for four seconds — on a GPU
  // other apps already fill, the driver paged and Half drew at 21 ms instead of
  // 5 (deepPrecomp bench, 2026-10-28). Kept results (P8 chains, the precomp
  // cache) are single-sample and keep their grace; a slot drawn every frame is
  // never idle, so nothing churns.
  constexpr std::uint64_t kTargetWarmIdle = 1800;
  constexpr std::uint64_t kTargetBudget = std::uint64_t{768} << 20U;
  constexpr std::uint64_t kSlotOverBudgetIdle = 8;
  // Device::target's key: "…:<samples>" or "…:<samples>:d".
  const auto multisampled = [](std::string_view key) { return key.ends_with(":4") || key.ends_with(":4:d"); };
  const std::size_t targets =
      targets_.collect_budgeted(frame_, kMaxIdle, kTargetWarmIdle, kTargetBudget, kSlotOverBudgetIdle, multisampled);
  return targets + textures + textureObjects_.collect_absent_from(textures_) + buffers_.collect(frame_, kMaxIdle) +
         bindGroups_.collect(frame_, kMaxIdle);
}

std::uint64_t Device::trim(std::uint64_t bytes) {
  // frame_ is the frame that just ended (begin_frame advances it): what it drew stays.
  std::uint64_t freed = targets_.trim(frame_, bytes);
  if (freed < bytes) freed += textures_.trim(frame_, bytes - freed);
  (void)textureObjects_.collect_absent_from(textures_);
  return freed;
}

void Device::flush() {
  for (std::uint32_t i = 0; i < chunks_.size() && i <= chunk_; ++i) {
    UniformChunk& c = chunks_[i];
    if (c.used > 0) queue_.WriteBuffer(c.buffer, 0, c.cpu.data(), c.used);
  }
  if (encoder_ != nullptr) {
    wgpu::CommandBuffer cb = encoder_.Finish();
    queue_.Submit(1, &cb);
  }
  encoder_ = device_.CreateCommandEncoder();
}

RenderTarget& Device::target(std::string_view name, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                             std::uint32_t samples, bool depth, bool* created) {
  const std::uint32_t sampleCount = samples >= 4 ? 4 : 1;
  // Name + size, as the TS key — plus format and samples, because the project
  // bit depth (16 ↔ 32 float, 32 = no MSAA) can change between two frames of
  // the same size and a pooled target must never be reused in the wrong format.
  key_.assign("graph-target:");
  key_ += name;
  key_ += ':';
  append_u64(key_, w);
  key_ += 'x';
  append_u64(key_, h);
  key_ += ':';
  append_u64(key_, static_cast<std::uint64_t>(format));
  key_ += ':';
  append_u64(key_, sampleCount);
  if (depth) key_ += ":d";
  const bool hit = targets_.has(key_);
  if (hit) ++stats_.targetHits;
  else ++stats_.targetMisses;
  if (created != nullptr) *created = !hit;
  return targets_.acquire(
      key_, frame_,
      [&] {
        RenderTarget t;
        t.width = w;
        t.height = h;
        t.format = format;
        t.samples = sampleCount;
        t.id = nextId_++;
        wgpu::TextureDescriptor td{};
        td.size = {w, h, 1};
        td.format = format;
        // CopyDst: P8 keeps a chain result by an exact texture copy (composition_pass.cpp).
        td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding |
                   wgpu::TextureUsage::CopySrc | wgpu::TextureUsage::CopyDst;
        t.texture = device_.CreateTexture(&td);
        t.view = t.texture.CreateView();
        if (sampleCount > 1) {
          wgpu::TextureDescriptor md = td;
          md.sampleCount = sampleCount;
          md.usage = wgpu::TextureUsage::RenderAttachment;
          t.msaa = device_.CreateTexture(&md);
          t.msaaView = t.msaa.CreateView();
        }
        t.wantsDepth = depth;  // the buffer itself on first use (depth_view)
        return t;
      },
      // Charged with its depth buffer whether or not one is made yet: the
      // pool's budgets see the target's worst case, as before depth was lazy.
      render_target_bytes(w, h, bytes_per_texel(format), sampleCount, depth));
}

const wgpu::TextureView& Device::depth_view(const RenderTarget& t) {
  if (t.depthView == nullptr && t.wantsDepth) {
    wgpu::TextureDescriptor dd{};
    dd.size = {t.width, t.height, 1};
    dd.format = kDepthFormat;
    dd.sampleCount = t.samples;
    // Bindable at any sample count: the DOF gather reads the run's depth, and
    // its target is multisampled like the scene's (threed.cpp).
    dd.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
    t.depth = device_.CreateTexture(&dd);
    t.depthView = t.depth.CreateView();
  }
  return t.depthView;
}

TexRef Device::texture(std::string_view hash, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                       std::span<const std::uint8_t> pixels, bool mipmapped) {
  // A mipmapped blob carries level 0 only (the TS texture's chain is never
  // uploaded — WebGPUBackend allocates levels and nothing fills them); the chain
  // is regenerated here, level by level, as exact 2×2 box averages of the
  // premultiplied texels (kMipWgsl), and linear samplers filter between levels.
  return make_texture(hash, w, h, format, pixels, mipmapped ? mip_levels(w, h) : 1, true);
}

TexRef Device::make_texture(std::string_view hash, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                            std::span<const std::uint8_t> pixels, std::uint32_t levels, bool build) {
  // Over the device's 2D limit Dawn makes an error texture, and drawing it
  // fails validation for the frame's whole command buffer — every layer, not
  // just this one. No texture instead: the draw that wanted it is skipped
  // (a layer with no texture draws nothing) and the frame goes on.
  const std::uint32_t bpp = bytes_per_texel(format);
  const std::uint64_t bytes = std::uint64_t{w} * h * bpp;
  // Likewise past the device's buffer limit: WriteTexture stages the pixels in
  // one buffer, and a larger one is a validation error with the same reach.
  if (w > maxTexture2D_ || h > maxTexture2D_ || (!pixels.empty() && bytes > maxBufferSize_)) {
    ++stats_.texturesRefused;
    return {};
  }
  const std::uint64_t charged = levels > 1 ? bytes + bytes / 3 : bytes;  // gpuMemory.ts mipChainBytes ≈ 4/3
  return textures_.acquire(
      hash, frame_,
      [&] {
        wgpu::TextureDescriptor td{};
        td.size = {std::max(1U, w), std::max(1U, h), 1};
        td.format = format;
        td.mipLevelCount = levels;
        // CopySrc: mip_texture copies a single-level texture's pixels into its
        // mipmapped replacement on the GPU.
        td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst | wgpu::TextureUsage::CopySrc |
                   (levels > 1 ? wgpu::TextureUsage::RenderAttachment : wgpu::TextureUsage::None);
        wgpu::Texture tex = device_.CreateTexture(&td);
        std::uint32_t built = 1;
        if (pixels.size() >= bytes && bytes > 0) {
          wgpu::TexelCopyTextureInfo dst{};
          dst.texture = tex;
          wgpu::TexelCopyBufferLayout layout{};
          layout.bytesPerRow = w * bpp;
          layout.rowsPerImage = h;
          const wgpu::Extent3D size{w, h, 1};
          queue_.WriteTexture(&dst, pixels.data(), bytes, &layout, &size);
          if (levels > 1 && build) {
            generate_mips(tex, format, w, h, 1, levels);
            built = levels;
          }
        }
        TexRef ref{tex.CreateView(), nextId_++, w, h, false, built, levels};
        textureObjects_.acquire(hash, frame_, [&] { return tex; });
        return ref;
      },
      charged);
}

TexRef Device::mip_texture(std::string_view hash, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                           std::span<const std::uint8_t> pixels, std::uint32_t levels) {
  const std::uint32_t full = mip_levels(w, h);
  const std::uint32_t want = std::clamp(levels, 1U, full);
  // Made single-level (drawn at full size so far), now drawn small: made again,
  // once, with the whole chain allocated — never a texture per depth (a chain
  // cut to each frame's needs made a new one whenever an animated scale crossed
  // an octave, and churned the cache: +40–75 % frame time with 60 such layers).
  // Its level 0 is copied across on the GPU, not uploaded again: a 4K SVG raster
  // re-sent from the CPU stalled the first frame it was drawn small (~25 ms).
  wgpu::Texture previous;
  if (const TexRef* have = textures_.find(hash); have != nullptr && want > std::max(1U, have->mipAlloc)) {
    if (const wgpu::Texture* obj = textureObjects_.find(hash); obj != nullptr) previous = *obj;
    textures_.free(hash);
    textureObjects_.free(hash);
  }
  TexRef made =
      make_texture(hash, w, h, format, previous != nullptr ? std::span<const std::uint8_t>{} : pixels, want > 1 ? full : 1, false);
  if (!made) return {};
  if (previous != nullptr) {
    if (const wgpu::Texture* obj = textureObjects_.find(hash); obj != nullptr) {
      wgpu::TexelCopyTextureInfo src{};
      src.texture = std::move(previous);
      wgpu::TexelCopyTextureInfo dst{};
      dst.texture = *obj;
      const wgpu::Extent3D size{std::max(1U, w), std::max(1U, h), 1};
      wgpu::CommandEncoder enc = device_.CreateCommandEncoder();
      enc.CopyTextureToTexture(&src, &dst, &size);
      const wgpu::CommandBuffer cb = enc.Finish();
      queue_.Submit(1, &cb);
    }
  }
  TexRef* pooled = textures_.find(hash);
  if (pooled == nullptr) return made;
  const std::uint32_t built = std::max(1U, pooled->mipLevels);
  if (built < want) {
    // Deeper levels the first time a draw reaches them, each from the one above.
    const wgpu::Texture* obj = textureObjects_.find(hash);
    if (obj == nullptr) return {};
    generate_mips(*obj, format, w, h, built, want);
    pooled->mipLevels = want;
  }
  // This draw samples `want` levels whatever was built before (deeper levels
  // from an earlier, smaller draw): the frame depends on the frame alone.
  TexRef out = *pooled;
  out.mipLevels = want;
  return out;
}

std::uint32_t mip_levels(std::uint32_t w, std::uint32_t h) noexcept {
  std::uint32_t n = 1;
  for (std::uint32_t s = std::max(w, h); s > 1; s >>= 1U) ++n;
  return n;
}

std::uint32_t mip_levels_needed(std::uint32_t w, std::uint32_t h, const MipFootprint& fp) noexcept {
  const std::uint32_t full = mip_levels(w, h);
  if (!(fp.width > 0) || !(fp.height > 0) || !std::isfinite(fp.width) || !std::isfinite(fp.height)) return full;
  // Texels per device pixel along the more minified axis, and the LOD the
  // ½-scaled gradients reach: log2(ratio) − 1. Level 0 alone up to 2:1.
  const double ratio = std::max(static_cast<double>(w) / fp.width, static_cast<double>(h) / fp.height);
  const double lod = std::log2(std::max(1.0, ratio)) - 1;
  if (!(lod > 0)) return 1;
  return std::min(full, static_cast<std::uint32_t>(std::ceil(lod)) + 2);
}

void Device::generate_mips(const wgpu::Texture& tex, wgpu::TextureFormat format, std::uint32_t w, std::uint32_t h,
                           std::uint32_t from, std::uint32_t to) {
  if (from < 1 || to <= from) return;
  static constexpr std::array<LayoutEntry, 2> kLayout{{{0, BindingType::uniform, kStageVertex | kStageFragment},
                                                       {1, BindingType::unfilterable, kStageFragment}}};
  const Mat mat = dynamic_material("rg-mip", shaders::kMipWgsl, kLayout);
  const Pipeline& p = pipeline(mat, Blend::none, format, 1);
  const MaterialDesc& m = material_of(mat);
  // The levels in one command buffer and one uniform buffer (a 256-byte slot
  // per level, the dynamic-offset alignment): 2D layers mipmap their rasters
  // when drawn small, and a side draw per level — a buffer, an encoder and a
  // submit each — cost a dozen submits per texture, many a frame while text or
  // shapes animate. Level k is max(1, w >> k) × max(1, h >> k).
  const auto dim = [](std::uint32_t s, std::uint32_t level) { return std::max(1U, std::max(1U, s) >> level); };
  const std::uint32_t steps = to - from;
  std::vector<float> u(std::size_t{steps} * (kUniformAlign / sizeof(float)), 0.0F);
  for (std::uint32_t i = 0; i < steps; ++i) {
    const std::size_t at = std::size_t{i} * (kUniformAlign / sizeof(float));
    u[at] = static_cast<float>(dim(w, from + i - 1));
    u[at + 1] = static_cast<float>(dim(h, from + i - 1));
  }
  wgpu::BufferDescriptor bd{};
  bd.size = u.size() * sizeof(float);
  bd.usage = wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst;
  bd.label = "mip-uniforms";
  const wgpu::Buffer ubuf = device_.CreateBuffer(&bd);
  queue_.WriteBuffer(ubuf, 0, u.data(), bd.size);
  wgpu::CommandEncoder enc = device_.CreateCommandEncoder();
  for (std::uint32_t level = from; level < to; ++level) {
    wgpu::TextureViewDescriptor src{};
    src.baseMipLevel = level - 1;
    src.mipLevelCount = 1;
    wgpu::TextureViewDescriptor dst{};
    dst.baseMipLevel = level;
    dst.mipLevelCount = 1;
    DrawItem it;
    it.material = mat;
    it.texture = {tex.CreateView(&src), 0, dim(w, level - 1), dim(h, level - 1), false, 0, 0};
    const wgpu::BindGroup bg = make_bind_group(p, m, it, ubuf, 16);
    wgpu::RenderPassColorAttachment ca{};
    ca.view = tex.CreateView(&dst);
    ca.loadOp = wgpu::LoadOp::Clear;
    ca.storeOp = wgpu::StoreOp::Store;
    ca.clearValue = {0, 0, 0, 0};
    wgpu::RenderPassDescriptor rp{};
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &ca;
    wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rp);
    pass.SetViewport(0, 0, static_cast<float>(dim(w, level)), static_cast<float>(dim(h, level)), 0, 1);
    pass.SetPipeline(p.pipeline);
    const std::uint32_t offset = (level - from) * kUniformAlign;
    pass.SetBindGroup(0, bg, 1, &offset);
    pass.SetVertexBuffer(0, quad_);
    pass.Draw(6, 1);
    pass.End();
    ++stats_.passes;
    ++stats_.draws;
  }
  const wgpu::CommandBuffer cb = enc.Finish();
  queue_.Submit(1, &cb);
}

SamplerRef Device::sampler(std::string_view key, wgpu::FilterMode filter, wgpu::AddressMode address, std::uint16_t maxAnisotropy,
                           float lodMaxClamp) {
  return samplers_.acquire(
      key, frame_,
      [&] {
        wgpu::SamplerDescriptor sd{};
        sd.magFilter = filter;
        sd.minFilter = filter;
        // Trilinear on a mipmapped texture; on a single-level texture (every
        // texture the TS renderer samples) the LOD clamps to 0 and this is inert.
        sd.mipmapFilter = filter == wgpu::FilterMode::Linear ? wgpu::MipmapFilterMode::Linear : wgpu::MipmapFilterMode::Nearest;
        sd.addressModeU = address;
        sd.addressModeV = address;
        sd.lodMaxClamp = lodMaxClamp;
        // Anisotropy needs every filter linear (WebGPU); 1 = off.
        if (filter == wgpu::FilterMode::Linear) sd.maxAnisotropy = std::max<std::uint16_t>(1, maxAnisotropy);
        return SamplerRef{device_.CreateSampler(&sd), nextId_++};
      },
      0, true);
}

wgpu::Buffer Device::geometry(std::string_view key, std::span<const std::uint8_t> bytes, bool index, bool always) {
  const std::uint64_t size = (bytes.size() + 3) & ~std::uint64_t{3};
  const bool fresh = !buffers_.has(key);
  wgpu::Buffer& b = buffers_.acquire(
      key, frame_,
      [&] {
        wgpu::BufferDescriptor bd{};
        bd.size = std::max<std::uint64_t>(4, size);
        bd.usage = (index ? wgpu::BufferUsage::Index : wgpu::BufferUsage::Vertex) | wgpu::BufferUsage::CopyDst;
        return device_.CreateBuffer(&bd);
      },
      size);
  if (!bytes.empty() && (fresh || always)) {
    if (bytes.size() % 4 == 0) {
      queue_.WriteBuffer(b, 0, bytes.data(), bytes.size());
    } else {
      std::vector<std::uint8_t> padded(size, 0);
      std::memcpy(padded.data(), bytes.data(), bytes.size());
      queue_.WriteBuffer(b, 0, padded.data(), padded.size());
    }
  }
  return b;
}

wgpu::ShaderModule& Device::shader(std::string_view name) {
  auto it = shaders_.find(std::string(name));
  if (it != shaders_.end()) return it->second;
  const auto dyn = dynamicWgsl_.find(std::string(name));
  const std::string code = dyn != dynamicWgsl_.end() ? dyn->second : builtin_wgsl(name);
  wgpu::ShaderSourceWGSL wgsl{};
  wgsl.code = code.c_str();
  wgpu::ShaderModuleDescriptor desc{};
  desc.nextInChain = &wgsl;
  const std::string label(name);
  desc.label = label.c_str();
  return shaders_.emplace(label, device_.CreateShaderModule(&desc)).first->second;
}

const Device::Pipeline& Device::pipeline(Mat material, Blend blend, wgpu::TextureFormat format, std::uint32_t samples,
                                         std::uint8_t depthWrite) {
  key_.assign("pipeline:");
  append_u64(key_, static_cast<std::uint64_t>(material));
  key_ += ':';
  append_u64(key_, static_cast<std::uint64_t>(blend));
  key_ += ':';
  append_u64(key_, static_cast<std::uint64_t>(format));
  key_ += ':';
  append_u64(key_, samples);
  if (depthWrite != DrawItem::kDepthWriteMaterial) {
    key_ += ":dw";
    append_u64(key_, depthWrite);
  }
  return pipelines_.acquire(
      key_, frame_,
      [&] {
        ++stats_.pipelinesCreated;
        const MaterialDesc& m = material_of(material);
        // Explicit bind-group layout from the material (WebGPUBackend.createPipeline),
        // with binding 0 addressed by dynamic offset into the uniform arena.
        std::vector<wgpu::BindGroupLayoutEntry> entries;
        for (const LayoutEntry& e : m.layout) {
          wgpu::BindGroupLayoutEntry le{};
          le.binding = e.binding;
          wgpu::ShaderStage vis = wgpu::ShaderStage::None;
          if ((e.stages & kStageVertex) != 0) vis |= wgpu::ShaderStage::Vertex;
          if ((e.stages & kStageFragment) != 0) vis |= wgpu::ShaderStage::Fragment;
          if ((e.stages & kStageCompute) != 0) vis |= wgpu::ShaderStage::Compute;
          le.visibility = vis;
          switch (e.type) {
            case BindingType::uniform:
              le.buffer.type = wgpu::BufferBindingType::Uniform;
              le.buffer.hasDynamicOffset = e.binding == 0;
              break;
            case BindingType::storage: le.buffer.type = wgpu::BufferBindingType::ReadOnlyStorage; break;
            case BindingType::texture:
              le.texture.sampleType = wgpu::TextureSampleType::Float;
              le.texture.viewDimension = wgpu::TextureViewDimension::e2D;
              break;
            case BindingType::depth:
            case BindingType::unfilterable:
              le.texture.sampleType = wgpu::TextureSampleType::UnfilterableFloat;
              le.texture.viewDimension = wgpu::TextureViewDimension::e2D;
              break;
            case BindingType::depth_multisampled:
              le.texture.sampleType = wgpu::TextureSampleType::Depth;
              le.texture.viewDimension = wgpu::TextureViewDimension::e2D;
              le.texture.multisampled = true;
              break;
            case BindingType::sampler: le.sampler.type = wgpu::SamplerBindingType::Filtering; break;
          }
          entries.push_back(le);
        }
        wgpu::BindGroupLayoutDescriptor bgld{};
        bgld.entryCount = entries.size();
        bgld.entries = entries.data();
        Pipeline p;
        p.layout = device_.CreateBindGroupLayout(&bgld);
        p.id = nextId_++;
        wgpu::PipelineLayoutDescriptor pld{};
        pld.bindGroupLayoutCount = 1;
        pld.bindGroupLayouts = &p.layout;
        const wgpu::PipelineLayout layout = device_.CreatePipelineLayout(&pld);

        // Vertex buffers: the material's own, or QUAD_LAYOUT.
        static constexpr std::array<VertexAttr, 1> kQuadAttr{{{0, 0, VertexFormat::Float32x2}}};
        static constexpr std::array<VertexLayout, 1> kQuadLayout{{{8, false, kQuadAttr}}};
        const std::span<const VertexLayout> bufs = m.buffers.empty() ? std::span<const VertexLayout>(kQuadLayout) : m.buffers;
        std::vector<std::vector<wgpu::VertexAttribute>> attrs(bufs.size());
        std::vector<wgpu::VertexBufferLayout> vbl(bufs.size());
        for (std::size_t i = 0; i < bufs.size(); ++i) {
          for (const VertexAttr& a : bufs[i].attributes) {
            wgpu::VertexAttribute va{};
            va.format = vertex_format(a.format);
            va.offset = a.offset;
            va.shaderLocation = a.location;
            attrs[i].push_back(va);
          }
          vbl[i].arrayStride = bufs[i].stride;
          vbl[i].stepMode = bufs[i].instance ? wgpu::VertexStepMode::Instance : wgpu::VertexStepMode::Vertex;
          vbl[i].attributeCount = attrs[i].size();
          vbl[i].attributes = attrs[i].data();
        }

        wgpu::ShaderModule& module = shader(m.shader);
        wgpu::BlendState bs{};
        const bool blended = blend_state(blend, bs);
        wgpu::ColorTargetState target{};
        target.format = format;
        target.blend = blended ? &bs : nullptr;
        if (blend == Blend::depthOnly) target.writeMask = wgpu::ColorWriteMask::None;
        wgpu::FragmentState fragment{};
        fragment.module = module;
        fragment.entryPoint = "fs";
        fragment.targetCount = 1;
        fragment.targets = &target;

        wgpu::RenderPipelineDescriptor desc{};
        const std::string label = std::string(m.shader);
        desc.label = label.c_str();
        desc.layout = layout;
        desc.vertex.module = module;
        desc.vertex.entryPoint = "vs";
        desc.vertex.bufferCount = vbl.size();
        desc.vertex.buffers = vbl.data();
        desc.primitive.topology = wgpu::PrimitiveTopology::TriangleList;
        desc.fragment = &fragment;
        desc.multisample.count = samples > 1 ? samples : 1;
        wgpu::DepthStencilState ds{};
        if (m.hasDepth && m.depthTest) {
          ds.format = kDepthFormat;
          const bool write = depthWrite == DrawItem::kDepthWriteMaterial ? m.depthWrite : depthWrite != 0;
          ds.depthWriteEnabled = write ? wgpu::OptionalBool::True : wgpu::OptionalBool::False;
          ds.depthCompare = wgpu::CompareFunction::GreaterEqual;  // reversed depth: near = 1
          desc.depthStencil = &ds;
        }
        p.pipeline = device_.CreateRenderPipeline(&desc);
        return p;
      });
}

std::pair<std::uint32_t, std::uint32_t> Device::uniform_alloc(std::span<const float> data) {
  const auto bytes = static_cast<std::uint32_t>(data.size_bytes());
  const std::uint32_t span = (bytes + kUniformAlign - 1) / kUniformAlign * kUniformAlign;
  for (;;) {
    if (chunk_ >= chunks_.size()) {
      UniformChunk c;
      wgpu::BufferDescriptor bd{};
      bd.size = kChunkBytes;
      bd.usage = wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst;
      bd.label = "uniform-arena";
      c.buffer = device_.CreateBuffer(&bd);
      c.cpu.resize(kChunkBytes);
      c.id = nextId_++;
      meter_.add(kChunkBytes);
      chunks_.push_back(std::move(c));
    }
    UniformChunk& c = chunks_[chunk_];
    if (c.used + span <= kChunkBytes) {
      const std::uint32_t off = c.used;
      std::memcpy(std::span(c.cpu).subspan(off, bytes).data(), data.data(), bytes);
      c.used += span;
      return {chunk_, off};
    }
    ++chunk_;
  }
}

wgpu::RenderPassEncoder Device::begin_pass(const Attachment& att, std::uint32_t w, std::uint32_t h,
                                           const wgpu::TextureView& surfaceView, wgpu::TextureFormat surfaceFormat,
                                           const std::array<std::uint32_t, 4>* scissor, bool depth) {
  (void)surfaceFormat;
  ++stats_.passes;
  wgpu::RenderPassColorAttachment ca{};
  const RenderTarget* t = att.target;
  if (t == nullptr) {
    ca.view = surfaceView;
  } else if (t->msaaView != nullptr) {
    ca.view = t->msaaView;
    ca.resolveTarget = t->view;
  } else {
    ca.view = t->view;
  }
  ca.loadOp = att.clear ? wgpu::LoadOp::Clear : wgpu::LoadOp::Load;
  ca.storeOp = wgpu::StoreOp::Store;  // ALWAYS store — the composition re-opens targets with load
  ca.clearValue = {att.clear_r, att.clear_g, att.clear_b, att.clear_a};
  wgpu::RenderPassDescriptor rp{};
  rp.colorAttachmentCount = 1;
  rp.colorAttachments = &ca;
  wgpu::RenderPassDepthStencilAttachment da{};
  const RenderTarget* dt = att.depthFrom != nullptr ? att.depthFrom : t;
  if (depth && t != nullptr && depth_view(*dt) != nullptr) {
    da.view = dt->depthView;
    da.depthClearValue = 0.0F;  // reversed depth: the far plane
    da.depthLoadOp = att.loadDepth ? wgpu::LoadOp::Load : wgpu::LoadOp::Clear;
    da.depthStoreOp = wgpu::StoreOp::Store;
    rp.depthStencilAttachment = &da;
  }
  rp.timestampWrites = profiler_.pass_writes();
  wgpu::RenderPassEncoder pass = encoder_.BeginRenderPass(&rp);
  // A target may be larger than the viewport drawn into it; a scissor never leaves either.
  passRect_ = {0, 0, t != nullptr ? std::min(std::max(1U, w), t->width) : std::max(1U, w),
               t != nullptr ? std::min(std::max(1U, h), t->height) : std::max(1U, h)};
  if (scissor != nullptr) {
    pass.SetScissorRect((*scissor)[0], (*scissor)[1], (*scissor)[2], (*scissor)[3]);
    passRect_ = *scissor;
  }
  pass.SetViewport(0, 0, static_cast<float>(std::max(1U, w)), static_cast<float>(std::max(1U, h)), 0, 1);
  return pass;
}

void Device::execute(wgpu::RenderPassEncoder& pass, const Commands& cmds, wgpu::TextureFormat format,
                     std::uint32_t samples) {
  std::uint64_t boundPipeline = 0;
  std::array<std::uint32_t, 4> scissor = passRect_;
  for (const DrawItem& it : cmds.items()) {
    const std::array<std::uint32_t, 4> want = it.scissor ? clip_rect(*it.scissor, passRect_) : passRect_;
    if (want != scissor) {
      pass.SetScissorRect(want[0], want[1], want[2], want[3]);
      scissor = want;
    }
    const Pipeline& p = pipeline(it.material, it.blend, format, samples, it.depthWrite);
    if (p.id != boundPipeline) {
      pass.SetPipeline(p.pipeline);
      boundPipeline = p.id;
    }
    const std::span<const float> u = cmds.floats(it);
    const auto [chunk, offset] = uniform_alloc(u);
    const std::uint64_t size = u.size_bytes();

    const MaterialDesc& m = material_of(it.material);
    key_.assign("bg:");
    append_u64(key_, p.id);
    key_ += ':';
    append_u64(key_, chunks_[chunk].id);
    key_ += ':';
    append_u64(key_, size);
    for (const TexRef* t : {&it.texture, &it.mask, &it.origin}) {
      key_ += ':';
      append_u64(key_, t->id);
    }
    key_ += ':';
    append_u64(key_, it.sampler.id);
    for (std::uint8_t k = 0; k < it.extraCount; ++k) {
      key_ += '|';
      append_u64(key_, it.extra.at(k).binding);
      key_ += '=';
      append_u64(key_, it.extra.at(k).tex.id + (it.extra.at(k).smp.id << 32U));
    }
    const bool hit = bindGroups_.has(key_);
    if (hit) ++stats_.bindGroupHits;
    else ++stats_.bindGroupMisses;
    const wgpu::BindGroup& bg =
        bindGroups_.acquire(key_, frame_, [&] { return make_bind_group(p, m, it, chunks_[chunk].buffer, size); });
    pass.SetBindGroup(0, bg, 1, &offset);
    const bool instanced = it.instanceBuffer != nullptr;
    // E4: instances with no per-instance buffer (the shader reads its data by
    // instance_index — the GPU Vegas' contour texture).
    const std::uint32_t instances = instanced || it.instanceCount > 0 ? it.instanceCount : 1;
    if (it.vertexBuffer != nullptr && it.indexBuffer != nullptr) {
      pass.SetVertexBuffer(0, it.vertexBuffer);
      if (instanced) pass.SetVertexBuffer(1, it.instanceBuffer);
      pass.SetIndexBuffer(it.indexBuffer, it.indexFormat);
      pass.DrawIndexed(it.indexCount, instances, it.firstIndex);
    } else {
      pass.SetVertexBuffer(0, quad_);
      if (instanced) pass.SetVertexBuffer(1, it.instanceBuffer);
      pass.Draw(6, instances);
    }
    ++stats_.draws;
  }
  if (scissor != passRect_) pass.SetScissorRect(passRect_[0], passRect_[1], passRect_[2], passRect_[3]);
}

wgpu::BindGroup Device::make_bind_group(const Pipeline& p, const MaterialDesc& m, const DrawItem& it,
                                        const wgpu::Buffer& uniforms, std::uint64_t size) {
  std::vector<wgpu::BindGroupEntry> entries;
  for (const LayoutEntry& e : m.layout) {
    wgpu::BindGroupEntry be{};
    be.binding = e.binding;
    const DrawItem::Extra* ex = nullptr;
    for (std::uint8_t k = 0; k < it.extraCount; ++k) {
      if (it.extra.at(k).binding == e.binding) ex = &it.extra.at(k);
    }
    if (ex != nullptr) {
      if (e.type == BindingType::sampler) be.sampler = ex->smp.sampler;
      else be.textureView = ex->tex.view;
    } else if (e.type == BindingType::uniform) {
      be.buffer = uniforms;
      be.offset = 0;
      be.size = size;
    } else if (e.type == BindingType::sampler) {
      be.sampler = it.sampler.sampler;
    } else {
      const TexRef& t = e.binding == 1 ? it.texture : e.binding == 3 ? it.mask : it.origin;
      be.textureView = t.view;
    }
    entries.push_back(be);
  }
  wgpu::BindGroupDescriptor bgd{};
  bgd.layout = p.layout;
  bgd.entryCount = entries.size();
  bgd.entries = entries.data();
  return device_.CreateBindGroup(&bgd);
}

void Device::side_draw(const wgpu::TextureView& target, wgpu::TextureFormat format, std::uint32_t w, std::uint32_t h,
                       const DrawItem& item, std::span<const float> uniforms) {
  const Pipeline& p = pipeline(item.material, Blend::none, format, 1);
  const MaterialDesc& m = material_of(item.material);
  // Its own uniform buffer: the frame arena is uploaded only at end_frame,
  // after this command buffer has already been submitted.
  const std::uint64_t size = std::max<std::uint64_t>(16, (uniforms.size_bytes() + 15) & ~std::uint64_t{15});
  wgpu::BufferDescriptor bd{};
  bd.size = size;
  bd.usage = wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst;
  bd.label = "side-draw-uniforms";
  const wgpu::Buffer ubuf = device_.CreateBuffer(&bd);
  std::vector<float> padded(size / sizeof(float), 0.0F);
  std::ranges::copy(uniforms, padded.begin());
  queue_.WriteBuffer(ubuf, 0, padded.data(), size);
  const wgpu::BindGroup bg = make_bind_group(p, m, item, ubuf, size);

  wgpu::CommandEncoder enc = device_.CreateCommandEncoder();
  wgpu::RenderPassColorAttachment ca{};
  ca.view = target;
  ca.loadOp = wgpu::LoadOp::Clear;
  ca.storeOp = wgpu::StoreOp::Store;
  ca.clearValue = {0, 0, 0, 0};
  wgpu::RenderPassDescriptor rp{};
  rp.colorAttachmentCount = 1;
  rp.colorAttachments = &ca;
  wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rp);
  pass.SetViewport(0, 0, static_cast<float>(std::max(1U, w)), static_cast<float>(std::max(1U, h)), 0, 1);
  pass.SetPipeline(p.pipeline);
  const std::uint32_t zero = 0;
  pass.SetBindGroup(0, bg, 1, &zero);
  pass.SetVertexBuffer(0, quad_);
  pass.Draw(6, 1);
  pass.End();
  const wgpu::CommandBuffer cb = enc.Finish();
  queue_.Submit(1, &cb);
  ++stats_.passes;
  ++stats_.draws;
}

const std::string& Device::pipeline_error(Mat material, Blend blend, wgpu::TextureFormat format) {
  std::string key;
  append_u64(key, static_cast<std::uint64_t>(material));
  key += ':';
  append_u64(key, static_cast<std::uint64_t>(blend));
  key += ':';
  append_u64(key, static_cast<std::uint64_t>(format));
  if (const auto it = pipelineErrors_.find(key); it != pipelineErrors_.end()) return it->second;
  device_.PushErrorScope(wgpu::ErrorFilter::Validation);
  (void)pipeline(material, blend, format, 1);
  std::string message;
  instance_.WaitAny(device_.PopErrorScope(wgpu::CallbackMode::WaitAnyOnly,
                                          [&message](wgpu::PopErrorScopeStatus status, wgpu::ErrorType type, wgpu::StringView msg) {
                                            if (status != wgpu::PopErrorScopeStatus::Success) {
                                              message = "error scope lost";
                                            } else if (type != wgpu::ErrorType::NoError) {
                                              message = msg.data == nullptr ? std::string("GPU error")
                                                        : msg.length == wgpu::kStrlen ? std::string(msg.data)
                                                                                      : std::string(msg.data, msg.length);
                                              if (message.empty()) message = "GPU error";
                                            }
                                          }),
                    UINT64_MAX);
  return pipelineErrors_.emplace(std::move(key), std::move(message)).first->second;
}

Mat Device::dynamic_material(std::string_view name, std::string_view wgsl, std::span<const LayoutEntry> layout) {
  std::string key(name);
  for (const LayoutEntry& e : layout) {
    key += ':';
    append_u64(key, e.binding);
  }
  for (std::size_t i = 0; i < dynamic_.size(); ++i) {
    if (dynamic_[i]->key == key) return static_cast<Mat>(static_cast<std::size_t>(Mat::Count_) + i);
  }
  auto d = std::make_unique<Dynamic>();
  d->key = key;
  d->shader = std::string(name);
  d->layout.assign(layout.begin(), layout.end());
  d->desc = MaterialDesc{d->key, d->shader, d->layout, {}, false, false, false};
  dynamicWgsl_[d->shader] = std::string(wgsl);
  dynamic_.push_back(std::move(d));
  return static_cast<Mat>(static_cast<std::size_t>(Mat::Count_) + dynamic_.size() - 1);
}

const MaterialDesc& Device::material_of(Mat m) const {
  const auto i = static_cast<std::size_t>(m);
  if (i < static_cast<std::size_t>(Mat::Count_)) return rg::material(m);
  return dynamic_.at(i - static_cast<std::size_t>(Mat::Count_))->desc;
}

DeviceStats Device::stats() const {
  DeviceStats s = stats_;
  s.gpuBytes = meter_.bytes;
  s.gpuBytesPeak = meter_.peak;
  return s;
}

std::string Device::take_error() {
  std::string e = std::move(firstError_);
  firstError_.clear();
  return e;
}

}  // namespace premation::rg
