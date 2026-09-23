#include "compositor.hpp"

#include <algorithm>
#include <array>
#include <cmath>

#include "engine_wgsl.hpp"
#include "renderer_wgsl.hpp"

namespace premation::render {
namespace {

constexpr wgpu::TextureFormat kRtFormat = wgpu::TextureFormat::RGBA16Float;
constexpr wgpu::TextureFormat kSlotFormat = wgpu::TextureFormat::RGBA8Unorm;

// WGSL mat3x3<f32> in a uniform buffer: three columns, each padded to vec4.
using Mat3 = std::array<float, 12>;

Mat3 affine(float a, float b, float c, float d, float e, float f) {
  // x' = a*x + c*y + e ; y' = b*x + d*y + f
  return {a, b, 0.0F, 0.0F, c, d, 0.0F, 0.0F, e, f, 1.0F, 0.0F};
}

// Uniform layouts of the two shaders (see scene.cpp in proto/ for the same pins).
struct TexturedU {
  Mat3 mvp;
  std::array<float, 4> uvRect, tint, cr0, cr1, cr2, srcSpace;
};
struct PresentU {
  std::array<float, 4> dst, color;
  std::array<std::uint32_t, 4> info;
};
static_assert(sizeof(TexturedU) == 144 && sizeof(PresentU) == 48);

double srgb_to_linear(double c) {
  if (c <= 0.04045) return c / 12.92;
  return std::pow((c + 0.055) / 1.055, 2.4);
}

wgpu::ShaderModule compile(const wgpu::Device& device, const char* code, const char* label) {
  wgpu::ShaderSourceWGSL wgsl{};
  wgsl.code = code;
  wgpu::ShaderModuleDescriptor desc{};
  desc.nextInChain = &wgsl;
  desc.label = label;
  return device.CreateShaderModule(&desc);
}

wgpu::Buffer uniform_buffer(const wgpu::Device& device, std::uint64_t size) {
  wgpu::BufferDescriptor desc{};
  desc.size = size;
  desc.usage = wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst;
  return device.CreateBuffer(&desc);
}

wgpu::BindGroup make_group(const wgpu::Device& device, const wgpu::RenderPipeline& pipeline,
                           const wgpu::Buffer& uniforms, const wgpu::TextureView& texture,
                           const wgpu::Sampler& sampler) {
  std::array<wgpu::BindGroupEntry, 3> entries{};
  entries[0].binding = 0;
  entries[0].buffer = uniforms;
  entries[1].binding = 1;
  entries[1].textureView = texture;
  entries[2].binding = 2;
  entries[2].sampler = sampler;
  wgpu::BindGroupDescriptor desc{};
  desc.layout = pipeline.GetBindGroupLayout(0);
  desc.entryCount = entries.size();
  desc.entries = entries.data();
  return device.CreateBindGroup(&desc);
}

}  // namespace

bool Compositor::init(const Gpu& gpu) {
  gpu_ = &gpu;
  const wgpu::Device& dev = gpu.device;

  constexpr std::array<float, 12> kQuad = {0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1};
  wgpu::BufferDescriptor qd{};
  qd.size = sizeof(kQuad);
  qd.usage = wgpu::BufferUsage::Vertex | wgpu::BufferUsage::CopyDst;
  quad_ = dev.CreateBuffer(&qd);
  gpu.queue.WriteBuffer(quad_, 0, kQuad.data(), sizeof(kQuad));

  wgpu::TextureDescriptor td{};
  td.size = {1, 1, 1};
  td.format = wgpu::TextureFormat::RGBA8Unorm;
  td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst;
  white_ = dev.CreateTexture(&td);
  whiteView_ = white_.CreateView();
  const std::array<std::uint8_t, 4> px = {255, 255, 255, 255};
  wgpu::TexelCopyTextureInfo dst{};
  dst.texture = white_;
  wgpu::TexelCopyBufferLayout layout{};
  layout.bytesPerRow = 4;
  layout.rowsPerImage = 1;
  const wgpu::Extent3D one{1, 1, 1};
  gpu.queue.WriteTexture(&dst, px.data(), px.size(), &layout, &one);

  wgpu::SamplerDescriptor sd{};
  sd.magFilter = wgpu::FilterMode::Linear;
  sd.minFilter = wgpu::FilterMode::Linear;
  sd.addressModeU = wgpu::AddressMode::ClampToEdge;
  sd.addressModeV = wgpu::AddressMode::ClampToEdge;
  clamp_ = dev.CreateSampler(&sd);

  texturedModule_ = compile(dev, shaders::kTexturedWgsl, "renderer:textured");
  presentModule_ = compile(dev, shaders::kPresentWgsl, "engine:present");
  textured_ = make_pipeline(texturedModule_, "vs", "fs", kRtFormat, true, true);
  blit_ = make_pipeline(presentModule_, "vs_blit", "fs_blit", kSlotFormat, false, false);
  blitU_ = uniform_buffer(dev, sizeof(PresentU));
  return textured_ != nullptr && blit_ != nullptr;
}

wgpu::RenderPipeline Compositor::make_pipeline(const wgpu::ShaderModule& module, const char* vs, const char* fs,
                                               wgpu::TextureFormat format, bool vertexBuffer, bool blend) {
  wgpu::VertexAttribute attr{};
  attr.format = wgpu::VertexFormat::Float32x2;
  attr.offset = 0;
  attr.shaderLocation = 0;
  wgpu::VertexBufferLayout vbl{};
  vbl.stepMode = wgpu::VertexStepMode::Vertex;
  vbl.arrayStride = 2 * sizeof(float);
  vbl.attributeCount = 1;
  vbl.attributes = &attr;

  // Premultiplied source-over, as the TS compositor draws layers.
  wgpu::BlendState blendState{};
  blendState.color = {wgpu::BlendOperation::Add, wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha};
  blendState.alpha = {wgpu::BlendOperation::Add, wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha};
  wgpu::ColorTargetState target{};
  target.format = format;
  target.blend = blend ? &blendState : nullptr;

  wgpu::FragmentState fragment{};
  fragment.module = module;
  fragment.entryPoint = fs;
  fragment.targetCount = 1;
  fragment.targets = &target;

  wgpu::RenderPipelineDescriptor desc{};
  desc.vertex.module = module;
  desc.vertex.entryPoint = vs;
  if (vertexBuffer) {
    desc.vertex.bufferCount = 1;
    desc.vertex.buffers = &vbl;
  }
  desc.primitive.topology = wgpu::PrimitiveTopology::TriangleList;
  desc.fragment = &fragment;
  return gpu_->device.CreateRenderPipeline(&desc);
}

void Compositor::ensure_rt(std::uint32_t w, std::uint32_t h) {
  if (rt_ != nullptr && w == rtW_ && h == rtH_) return;
  wgpu::TextureDescriptor td{};
  td.size = {w, h, 1};
  td.format = kRtFormat;
  td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
  rt_ = gpu_->device.CreateTexture(&td);
  rtView_ = rt_.CreateView();
  rtW_ = w;
  rtH_ = h;
  blitGroup_ = make_group(gpu_->device, blit_, blitU_, rtView_, clamp_);
}

Compositor::QuadSlot& Compositor::quad_slot(std::size_t i) {
  while (quads_.size() <= i) {
    QuadSlot q;
    q.uniforms = uniform_buffer(gpu_->device, sizeof(TexturedU));
    q.group = make_group(gpu_->device, textured_, q.uniforms, whiteView_, clamp_);
    quads_.push_back(std::move(q));
  }
  return quads_[i];
}

void Compositor::encode(wgpu::CommandEncoder& encoder, const FrameScene& scene, const wgpu::TextureView& target,
                        std::uint32_t targetWidth, std::uint32_t targetHeight, double resolution) {
  const double W = std::max<double>(1.0, scene.compWidth);
  const double H = std::max<double>(1.0, scene.compHeight);
  const double tw = static_cast<double>(targetWidth);
  const double th = static_cast<double>(targetHeight);
  const double fit = std::min(tw / W, th / H);
  const double pw = W * fit;
  const double ph = H * fit;
  const double res = std::clamp(resolution, 0.05, 1.0);
  ensure_rt(static_cast<std::uint32_t>(std::clamp(std::ceil(pw * res), 1.0, 16384.0)),
            static_cast<std::uint32_t>(std::clamp(std::ceil(ph * res), 1.0, 16384.0)));

  const wgpu::Queue& q = gpu_->queue;
  // ── layer pass: comp pixels → RT clip space ──
  for (std::size_t i = 0; i < scene.quads.size(); ++i) {
    const DrawQuad& d = scene.quads[i];
    const auto [a, b, c, dd, e, f] = d.affine;
    const auto w = static_cast<float>(W);
    const auto h = static_cast<float>(H);
    TexturedU u{};
    u.mvp = affine(2.0F * a / w, -2.0F * b / h, 2.0F * c / w, -2.0F * dd / h, 2.0F * e / w - 1.0F,
                   1.0F - 2.0F * f / h);
    u.uvRect = {0.0F, 0.0F, 1.0F, 1.0F};
    u.tint = d.color;
    u.cr0 = {1, 0, 0, 0};
    u.cr1 = {0, 1, 0, 0};
    u.cr2 = {0, 0, 1, 0};
    u.srcSpace = {0, 0, 0, 0};
    q.WriteBuffer(quad_slot(i).uniforms, 0, &u, sizeof(u));
  }
  {
    const double alpha = scene.background[3];
    wgpu::RenderPassColorAttachment att{};
    att.view = rtView_;
    att.loadOp = wgpu::LoadOp::Clear;
    att.storeOp = wgpu::StoreOp::Store;
    att.clearValue = {srgb_to_linear(scene.background[0]) * alpha, srgb_to_linear(scene.background[1]) * alpha,
                      srgb_to_linear(scene.background[2]) * alpha, alpha};
    wgpu::RenderPassDescriptor rp{};
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &att;
    wgpu::RenderPassEncoder p = encoder.BeginRenderPass(&rp);
    if (!scene.quads.empty()) {
      p.SetPipeline(textured_);
      p.SetVertexBuffer(0, quad_);
      for (std::size_t i = 0; i < scene.quads.size(); ++i) {
        p.SetBindGroup(0, quads_[i].group);
        p.Draw(6);
      }
    }
    p.End();
  }

  // ── display pass: RT → slot, letterboxed ──
  const double x0 = (tw - pw) * 0.5;
  const double y0 = (th - ph) * 0.5;
  const auto cx = [tw](double x) { return static_cast<float>(2.0 * x / tw - 1.0); };
  const auto cy = [th](double y) { return static_cast<float>(1.0 - 2.0 * y / th); };
  const PresentU blit{{cx(x0), cy(y0), cx(x0 + pw), cy(y0 + ph)}, {0, 0, 0, 0}, {0, 0, 0, 0}};
  q.WriteBuffer(blitU_, 0, &blit, sizeof(blit));
  wgpu::RenderPassColorAttachment att{};
  att.view = target;
  att.loadOp = wgpu::LoadOp::Clear;
  att.storeOp = wgpu::StoreOp::Store;
  att.clearValue = {0, 0, 0, 1};
  wgpu::RenderPassDescriptor rp{};
  rp.colorAttachmentCount = 1;
  rp.colorAttachments = &att;
  wgpu::RenderPassEncoder p = encoder.BeginRenderPass(&rp);
  p.SetPipeline(blit_);
  p.SetBindGroup(0, blitGroup_);
  p.Draw(6);
  p.End();
}

}  // namespace premation::render
