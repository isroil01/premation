#include "device.hpp"

#include <algorithm>
#include <array>
#include <cstring>

namespace premation::rg {
namespace {

/// Uniform arena chunk; dynamic offsets are 256-byte aligned (minUniformBufferOffsetAlignment).
constexpr std::uint32_t kChunkBytes = 4U << 20;
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

void append_u64(std::string& s, std::uint64_t v) {
  std::array<char, 24> buf{};
  std::size_t n = 0;
  do {
    buf.at(n++) = static_cast<char>('0' + v % 10);
    v /= 10;
  } while (v != 0 && n < buf.size());
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
}

Device::~Device() = default;

void Device::begin_frame() {
  ++frame_;
  chunk_ = 0;
  for (auto& c : chunks_) c.used = 0;
  encoder_ = device_.CreateCommandEncoder();
}

std::size_t Device::end_frame() {
  for (std::uint32_t i = 0; i < chunks_.size() && i <= chunk_; ++i) {
    UniformChunk& c = chunks_[i];
    if (c.used > 0) queue_.WriteBuffer(c.buffer, 0, c.cpu.data(), c.used);
  }
  if (encoder_ != nullptr) {
    wgpu::CommandBuffer cb = encoder_.Finish();
    queue_.Submit(1, &cb);
    encoder_ = nullptr;
  }
  constexpr std::uint64_t kMaxIdle = 120;  // ResourceManager default maxIdleFrames
  return targets_.collect(frame_, kMaxIdle) + textures_.collect(frame_, kMaxIdle) +
         textureObjects_.collect(frame_, kMaxIdle) + buffers_.collect(frame_, kMaxIdle) +
         bindGroups_.collect(frame_, kMaxIdle);
}

RenderTarget& Device::target(std::string_view name, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                             std::uint32_t samples, bool depth) {
  key_.assign("graph-target:");
  key_ += name;
  key_ += ':';
  append_u64(key_, w);
  key_ += 'x';
  append_u64(key_, h);
  const std::uint32_t sampleCount = samples >= 4 ? 4 : 1;
  const bool hit = targets_.has(key_);
  if (hit) ++stats_.targetHits;
  else ++stats_.targetMisses;
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
        td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding |
                   wgpu::TextureUsage::CopySrc;
        t.texture = device_.CreateTexture(&td);
        t.view = t.texture.CreateView();
        if (sampleCount > 1) {
          wgpu::TextureDescriptor md = td;
          md.sampleCount = sampleCount;
          md.usage = wgpu::TextureUsage::RenderAttachment;
          t.msaa = device_.CreateTexture(&md);
          t.msaaView = t.msaa.CreateView();
        }
        if (depth) {
          wgpu::TextureDescriptor dd{};
          dd.size = {w, h, 1};
          dd.format = wgpu::TextureFormat::Depth24Plus;
          dd.sampleCount = sampleCount;
          dd.usage = sampleCount > 1 ? wgpu::TextureUsage::RenderAttachment
                                     : wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
          t.depth = device_.CreateTexture(&dd);
          t.depthView = t.depth.CreateView();
        }
        return t;
      },
      render_target_bytes(w, h, bytes_per_texel(format), sampleCount, depth));
}

TexRef Device::texture(std::string_view hash, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                       std::span<const std::uint8_t> pixels, bool mipmapped) {
  (void)mipmapped;  // level 0 only: the exporter reports mipmapped blobs and support.cpp refuses them
  const std::uint32_t bpp = bytes_per_texel(format);
  const std::uint64_t bytes = std::uint64_t{w} * h * bpp;
  return textures_.acquire(
      hash, frame_,
      [&] {
        wgpu::TextureDescriptor td{};
        td.size = {std::max(1U, w), std::max(1U, h), 1};
        td.format = format;
        td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst;
        wgpu::Texture tex = device_.CreateTexture(&td);
        if (pixels.size() >= bytes && bytes > 0) {
          wgpu::TexelCopyTextureInfo dst{};
          dst.texture = tex;
          wgpu::TexelCopyBufferLayout layout{};
          layout.bytesPerRow = w * bpp;
          layout.rowsPerImage = h;
          const wgpu::Extent3D size{w, h, 1};
          queue_.WriteTexture(&dst, pixels.data(), bytes, &layout, &size);
        }
        TexRef ref{tex.CreateView(), nextId_++, w, h, false};
        textureObjects_.acquire(hash, frame_, [&] { return tex; });
        return ref;
      },
      bytes);
}

SamplerRef Device::sampler(std::string_view key, wgpu::FilterMode filter, wgpu::AddressMode address) {
  return samplers_.acquire(
      key, frame_,
      [&] {
        wgpu::SamplerDescriptor sd{};
        sd.magFilter = filter;
        sd.minFilter = filter;
        sd.addressModeU = address;
        sd.addressModeV = address;
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

const Device::Pipeline& Device::pipeline(Mat material, Blend blend, wgpu::TextureFormat format, std::uint32_t samples) {
  key_.assign("pipeline:");
  append_u64(key_, static_cast<std::uint64_t>(material));
  key_ += ':';
  append_u64(key_, static_cast<std::uint64_t>(blend));
  key_ += ':';
  append_u64(key_, static_cast<std::uint64_t>(format));
  key_ += ':';
  append_u64(key_, samples);
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
              le.texture.sampleType = wgpu::TextureSampleType::UnfilterableFloat;
              le.texture.viewDimension = wgpu::TextureViewDimension::e2D;
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
          ds.format = wgpu::TextureFormat::Depth24Plus;
          ds.depthWriteEnabled = m.depthWrite ? wgpu::OptionalBool::True : wgpu::OptionalBool::False;
          ds.depthCompare = wgpu::CompareFunction::LessEqual;
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
      std::memcpy(c.cpu.data() + off, data.data(), bytes);
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
  if (depth && t != nullptr && t->depthView != nullptr) {
    da.view = t->depthView;
    da.depthClearValue = 1.0F;
    da.depthLoadOp = wgpu::LoadOp::Clear;
    da.depthStoreOp = wgpu::StoreOp::Store;
    rp.depthStencilAttachment = &da;
  }
  wgpu::RenderPassEncoder pass = encoder_.BeginRenderPass(&rp);
  if (scissor != nullptr && t == nullptr) pass.SetScissorRect((*scissor)[0], (*scissor)[1], (*scissor)[2], (*scissor)[3]);
  pass.SetViewport(0, 0, static_cast<float>(std::max(1U, w)), static_cast<float>(std::max(1U, h)), 0, 1);
  return pass;
}

void Device::execute(wgpu::RenderPassEncoder& pass, const Commands& cmds, wgpu::TextureFormat format,
                     std::uint32_t samples) {
  std::uint64_t boundPipeline = 0;
  for (const DrawItem& it : cmds.items()) {
    const Pipeline& p = pipeline(it.material, it.blend, format, samples);
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
    const wgpu::BindGroup& bg = bindGroups_.acquire(key_, frame_, [&] {
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
          be.buffer = chunks_[chunk].buffer;
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
    });
    pass.SetBindGroup(0, bg, 1, &offset);
    const bool instanced = it.instanceBuffer != nullptr;
    const std::uint32_t instances = instanced ? it.instanceCount : 1;
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
