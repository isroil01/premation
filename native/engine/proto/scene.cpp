#include "scene.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <vector>

#include "engine_wgsl.hpp"
#include "renderer_wgsl.hpp"

namespace premation {
namespace {

constexpr std::uint32_t kSourceSize = 512;
constexpr std::uint32_t kCounterBits = 20;
constexpr wgpu::TextureFormat kRtFormat = wgpu::TextureFormat::RGBA16Float;

// WGSL mat3x3<f32> in a uniform buffer: three columns, each padded to vec4.
using Mat3 = std::array<float, 12>;

Mat3 affine(float a, float b, float c, float d, float e, float f) {
  // x' = a*x + c*y + e ; y' = b*x + d*y + f
  return {a, b, 0.0F, 0.0F, c, d, 0.0F, 0.0F, e, f, 1.0F, 0.0F};
}

// Unit quad [0,1]² → full clip space, v down.
Mat3 fullscreen() { return affine(2.0F, 0.0F, 0.0F, -2.0F, -1.0F, 1.0F); }

struct TexturedU {
  Mat3 mvp;
  std::array<float, 4> uvRect, tint, cr0, cr1, cr2, srcSpace;
};
struct BlurU {
  Mat3 mvp;
  std::array<float, 4> uvRect, blurParams;
};
struct VignetteU {
  Mat3 mvp;
  std::array<float, 4> uvRect, p0, p1, fxBox;
};
struct PresentU {
  std::array<float, 4> dst, color;
  std::array<std::uint32_t, 4> info;
};
static_assert(sizeof(TexturedU) == 144 && sizeof(BlurU) == 80 && sizeof(VignetteU) == 112 && sizeof(PresentU) == 48);

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

wgpu::Texture texture2d(const wgpu::Device& device, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format,
                        wgpu::TextureUsage usage) {
  wgpu::TextureDescriptor desc{};
  desc.size = {w, h, 1};
  desc.format = format;
  desc.usage = usage;
  return device.CreateTexture(&desc);
}

// Deterministic sRGB source image: hue-swept checkerboard with a ring.
std::vector<std::uint8_t> make_source_pixels() {
  std::vector<std::uint8_t> px(static_cast<std::size_t>(kSourceSize) * kSourceSize * 4);
  for (std::uint32_t y = 0; y < kSourceSize; ++y) {
    for (std::uint32_t x = 0; x < kSourceSize; ++x) {
      const bool check = (((x / 32U) + (y / 32U)) & 1U) != 0;
      const float u = static_cast<float>(x) / static_cast<float>(kSourceSize);
      const float v = static_cast<float>(y) / static_cast<float>(kSourceSize);
      const float dx = u - 0.5F;
      const float dy = v - 0.5F;
      const float r = std::sqrt(dx * dx + dy * dy);
      const bool ring = r > 0.30F && r < 0.36F;
      const float base = check ? 1.0F : 0.55F;
      float cr = base * (0.5F + 0.5F * u);
      float cg = base * (0.35F + 0.5F * v);
      float cb = base * (0.9F - 0.5F * u);
      if (ring) {
        cr = 1.0F;
        cg = 0.85F;
        cb = 0.2F;
      }
      const std::size_t i = (static_cast<std::size_t>(y) * kSourceSize + x) * 4;
      px[i + 0] = static_cast<std::uint8_t>(std::clamp(cr, 0.0F, 1.0F) * 255.0F);
      px[i + 1] = static_cast<std::uint8_t>(std::clamp(cg, 0.0F, 1.0F) * 255.0F);
      px[i + 2] = static_cast<std::uint8_t>(std::clamp(cb, 0.0F, 1.0F) * 255.0F);
      px[i + 3] = 255;
    }
  }
  return px;
}

void upload(const wgpu::Queue& queue, const wgpu::Texture& texture, const std::vector<std::uint8_t>& px,
            std::uint32_t w, std::uint32_t h) {
  wgpu::TexelCopyTextureInfo dst{};
  dst.texture = texture;
  wgpu::TexelCopyBufferLayout layout{};
  layout.bytesPerRow = w * 4;
  layout.rowsPerImage = h;
  const wgpu::Extent3D size{w, h, 1};
  queue.WriteTexture(&dst, px.data(), px.size(), &layout, &size);
}

template <typename T>
void write(const wgpu::Queue& queue, const wgpu::Buffer& buffer, const T& value) {
  queue.WriteBuffer(buffer, 0, &value, sizeof(T));
}

}  // namespace

bool Scene::init(const Gpu& gpu, std::uint32_t compWidth, std::uint32_t compHeight) {
  gpu_ = &gpu;
  compW_ = compWidth;
  compH_ = compHeight;
  const wgpu::Device& dev = gpu.device;

  constexpr std::array<float, 12> kQuad = {0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1};
  wgpu::BufferDescriptor qd{};
  qd.size = sizeof(kQuad);
  qd.usage = wgpu::BufferUsage::Vertex | wgpu::BufferUsage::CopyDst;
  quad_ = dev.CreateBuffer(&qd);
  gpu.queue.WriteBuffer(quad_, 0, kQuad.data(), sizeof(kQuad));

  const auto sampled = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst;
  source_ = texture2d(dev, kSourceSize, kSourceSize, wgpu::TextureFormat::RGBA8Unorm, sampled);
  upload(gpu.queue, source_, make_source_pixels(), kSourceSize, kSourceSize);
  white_ = texture2d(dev, 1, 1, wgpu::TextureFormat::RGBA8Unorm, sampled);
  upload(gpu.queue, white_, std::vector<std::uint8_t>{255, 255, 255, 255}, 1, 1);

  const auto rtUsage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
  rtA_ = texture2d(dev, compW_, compH_, kRtFormat, rtUsage);
  rtB_ = texture2d(dev, compW_, compH_, kRtFormat, rtUsage);
  rtAView_ = rtA_.CreateView();
  rtBView_ = rtB_.CreateView();

  wgpu::SamplerDescriptor sd{};
  sd.magFilter = wgpu::FilterMode::Linear;
  sd.minFilter = wgpu::FilterMode::Linear;
  sd.addressModeU = wgpu::AddressMode::Repeat;
  sd.addressModeV = wgpu::AddressMode::Repeat;
  repeat_ = dev.CreateSampler(&sd);
  sd.addressModeU = wgpu::AddressMode::ClampToEdge;
  sd.addressModeV = wgpu::AddressMode::ClampToEdge;
  clamp_ = dev.CreateSampler(&sd);

  texturedModule_ = compile(dev, shaders::kTexturedWgsl, "renderer:textured");
  blurModule_ = compile(dev, shaders::kBlurWgsl, "renderer:blur");
  vignetteModule_ = compile(dev, shaders::kVignetteWgsl, "renderer:vignette");
  presentModule_ = compile(dev, shaders::kPresentWgsl, "engine:present");

  textured_ = make_pipeline(texturedModule_, "vs", "fs", kRtFormat, true);
  blur_ = make_pipeline(blurModule_, "vs", "fs", kRtFormat, true);
  vignette_ = make_pipeline(vignetteModule_, "vs", "fs", kRtFormat, true);

  bgU_ = uniform_buffer(dev, sizeof(TexturedU));
  cardU_ = uniform_buffer(dev, sizeof(TexturedU));
  blurHU_ = uniform_buffer(dev, sizeof(BlurU));
  blurVU_ = uniform_buffer(dev, sizeof(BlurU));
  vignetteU_ = uniform_buffer(dev, sizeof(VignetteU));
  blitU_ = uniform_buffer(dev, sizeof(PresentU));
  bitsU_ = uniform_buffer(dev, sizeof(PresentU));

  const wgpu::TextureView sourceView = source_.CreateView();
  bgGroup_ = make_group(textured_, bgU_, sourceView, repeat_);
  cardGroup_ = make_group(textured_, cardU_, sourceView, repeat_);
  blurHGroup_ = make_group(blur_, blurHU_, rtAView_, clamp_);
  blurVGroup_ = make_group(blur_, blurVU_, rtBView_, clamp_);
  vignetteGroup_ = make_group(vignette_, vignetteU_, rtAView_, clamp_);
  return textured_ != nullptr && blur_ != nullptr && vignette_ != nullptr;
}

wgpu::RenderPipeline Scene::make_pipeline(const wgpu::ShaderModule& module, const char* vs, const char* fs,
                                          wgpu::TextureFormat format, bool vertexBuffer) {
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
  wgpu::BlendState blend{};
  blend.color = {wgpu::BlendOperation::Add, wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha};
  blend.alpha = {wgpu::BlendOperation::Add, wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha};
  wgpu::ColorTargetState target{};
  target.format = format;
  target.blend = &blend;

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

wgpu::BindGroup Scene::make_group(const wgpu::RenderPipeline& pipeline, const wgpu::Buffer& uniforms,
                                  const wgpu::TextureView& texture, const wgpu::Sampler& sampler) {
  std::array<wgpu::BindGroupEntry, 3> entries{};
  entries[0].binding = 0;
  entries[0].buffer = uniforms;
  entries[1].binding = 1;
  entries[1].textureView = texture;
  entries[2].binding = 2;
  entries[2].sampler = sampler;
  wgpu::BindGroupDescriptor desc{};
  desc.layout = pipeline.GetBindGroupLayout(0);
  desc.entryCount = texture != nullptr ? entries.size() : 1;
  desc.entries = entries.data();
  return gpu_->device.CreateBindGroup(&desc);
}

const Scene::PresentPipelines& Scene::present_for(wgpu::TextureFormat format) {
  auto it = present_.find(format);
  if (it != present_.end()) return it->second;
  PresentPipelines p;
  p.blit = make_pipeline(presentModule_, "vs_blit", "fs_blit", format, false);
  p.bits = make_pipeline(presentModule_, "vs_bits", "fs_bits", format, false);
  p.blitGroup = make_group(p.blit, blitU_, rtBView_, clamp_);
  p.bitsGroup = make_group(p.bits, bitsU_, nullptr, nullptr);
  return present_.emplace(format, std::move(p)).first->second;
}

void Scene::encode(wgpu::CommandEncoder& encoder, std::uint32_t frame, const wgpu::TextureView& target,
                   wgpu::TextureFormat targetFormat, std::uint32_t targetWidth, std::uint32_t targetHeight) {
  const wgpu::Queue& q = gpu_->queue;
  const float W = static_cast<float>(compW_);
  const float H = static_cast<float>(compH_);
  const float f = static_cast<float>(frame);
  constexpr std::array<float, 4> kIdentityUv = {0.0F, 0.0F, 1.0F, 1.0F};

  // ── uniforms ──────────────────────────────────────────────────────────────
  TexturedU bg{};
  bg.mvp = fullscreen();
  bg.uvRect = {f * 0.0015F, f * 0.0007F, W / 512.0F, H / 512.0F};
  bg.tint = {0.35F, 0.35F, 0.42F, 1.0F};
  bg.cr0 = {1, 0, 0, 0};
  bg.cr1 = {0, 1, 0, 0};
  bg.cr2 = {0, 0, 1, 0};
  bg.srcSpace = {0, 0, 0, 0};
  write(q, bgU_, bg);

  TexturedU card = bg;
  {
    const float theta = f * 0.02F;
    const float s = 0.45F * H;
    const float cx = W * (0.5F + 0.25F * std::sin(f * 0.013F));
    const float cy = H * (0.5F + 0.2F * std::sin(f * 0.017F));
    const float a = std::cos(theta) * s;
    const float b = std::sin(theta) * s;
    const float c = -b;
    const float d = a;
    const float e = cx - 0.5F * (a + c);
    const float g = cy - 0.5F * (b + d);
    card.mvp = affine(2.0F * a / W, -2.0F * b / H, 2.0F * c / W, -2.0F * d / H, 2.0F * e / W - 1.0F,
                      1.0F - 2.0F * g / H);
  }
  card.uvRect = kIdentityUv;
  card.tint = {1, 1, 1, 1};
  write(q, cardU_, card);

  const float sigma = (2.0F + 1.5F * std::sin(f * 0.05F)) * (H / 1080.0F);
  BlurU blurH{fullscreen(), kIdentityUv, {1.0F / W, 0.0F, sigma, 0.0F}};
  BlurU blurV{fullscreen(), kIdentityUv, {0.0F, 1.0F / H, sigma, 0.0F}};
  write(q, blurHU_, blurH);
  write(q, blurVU_, blurV);

  VignetteU vig{fullscreen(), kIdentityUv, {0.6F, 0.35F, 0.8F, 1.0F}, {0.5F, 0.5F, W / H, 0.0F}, kIdentityUv};
  write(q, vignetteU_, vig);

  // Letterbox the comp into the target.
  const float tw = static_cast<float>(targetWidth);
  const float th = static_cast<float>(targetHeight);
  const float scale = std::min(tw / W, th / H);
  const float pw = W * scale;
  const float ph = H * scale;
  const float x0 = (tw - pw) * 0.5F;
  const float y0 = (th - ph) * 0.5F;
  const auto cx = [tw](float x) { return 2.0F * x / tw - 1.0F; };
  const auto cy = [th](float y) { return 1.0F - 2.0F * y / th; };
  PresentU blit{{cx(x0), cy(y0), cx(x0 + pw), cy(y0 + ph)}, {0, 0, 0, 0}, {0, 0, 0, 0}};
  write(q, blitU_, blit);
  const float cellH = std::max(6.0F, 0.035F * ph);
  const float bx = x0 + 0.02F * ph;
  const float by = y0 + ph - 0.02F * ph - cellH;
  PresentU bits{{cx(bx), cy(by), cx(bx + cellH * 1.2F * kCounterBits), cy(by + cellH)},
                {0.1F, 0.95F, 0.45F, 1.0F},
                {frame, kCounterBits, 0, 0}};
  write(q, bitsU_, bits);

  // ── passes ────────────────────────────────────────────────────────────────
  const auto pass = [&encoder](const wgpu::TextureView& view, const wgpu::RenderPipeline& pipeline,
                               const wgpu::BindGroup& group, const wgpu::Buffer& vb) {
    wgpu::RenderPassColorAttachment att{};
    att.view = view;
    att.loadOp = wgpu::LoadOp::Clear;
    att.storeOp = wgpu::StoreOp::Store;
    att.clearValue = {0, 0, 0, 0};
    wgpu::RenderPassDescriptor rp{};
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &att;
    wgpu::RenderPassEncoder p = encoder.BeginRenderPass(&rp);
    p.SetPipeline(pipeline);
    p.SetVertexBuffer(0, vb);
    p.SetBindGroup(0, group);
    p.Draw(6);
    return p;
  };

  {
    wgpu::RenderPassEncoder p = pass(rtAView_, textured_, bgGroup_, quad_);
    p.SetBindGroup(0, cardGroup_);
    p.Draw(6);
    p.End();
  }
  pass(rtBView_, blur_, blurHGroup_, quad_).End();
  pass(rtAView_, blur_, blurVGroup_, quad_).End();
  pass(rtBView_, vignette_, vignetteGroup_, quad_).End();

  const PresentPipelines& pp = present_for(targetFormat);
  wgpu::RenderPassColorAttachment att{};
  att.view = target;
  att.loadOp = wgpu::LoadOp::Clear;
  att.storeOp = wgpu::StoreOp::Store;
  att.clearValue = {0, 0, 0, 1};
  wgpu::RenderPassDescriptor rp{};
  rp.colorAttachmentCount = 1;
  rp.colorAttachments = &att;
  wgpu::RenderPassEncoder p = encoder.BeginRenderPass(&rp);
  p.SetPipeline(pp.blit);
  p.SetBindGroup(0, pp.blitGroup);
  p.Draw(6);
  p.SetPipeline(pp.bits);
  p.SetBindGroup(0, pp.bitsGroup);
  p.Draw(6, kCounterBits);
  p.End();
}

}  // namespace premation
