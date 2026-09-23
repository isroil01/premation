#include "frame_convert.hpp"

#include <array>
#include <chrono>
#include <cstring>

#include "yuv.hpp"

#if defined(_WIN32)
#include "d3d11_ffi.hpp"
#endif

namespace premation::media {
namespace {

// The conversion pass. `TEX` / `LOAD` are substituted per variant: UINT planes
// (CPU upload, value >> storage shift) or FLOAT planes (a hardware surface's
// unorm plane views, value × sampleScale → code).
constexpr std::string_view kConvertWgsl = R"(
struct P {
  m0: vec4f, m1: vec4f, m2: vec4f,
  // alphaScale, premultiply (0/1), sampleScale (float planes), hasAlpha (0/1)
  a: vec4f,
  // kind (0 planar yuv, 1 semi-planar, 2 planar rgb, 3 packed rgba), chroma shift x, chroma shift y, storage shift
  l: vec4f,
};
@group(0) @binding(0) var<uniform> u: P;
@group(0) @binding(1) var t0: TEX;
@group(0) @binding(2) var t1: TEX;
@group(0) @binding(3) var t2: TEX;
@group(0) @binding(4) var t3: TEX;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn ld(t: TEX, c: vec2i) -> vec4f {
  let d = vec2i(textureDimensions(t));
  let q = clamp(c, vec2i(0), d - vec2i(1));
  LOAD
}

fn chroma(t: TEX, p: vec2i) -> vec4f {
  let sx = u32(u.l.y);
  let sy = u32(u.l.z);
  // Co-sited horizontally: chroma texel j sits on luma column j << sx.
  let fx = f32(p.x) / f32(1u << sx);
  // Centred vertically between the luma rows it covers.
  var fy = f32(p.y);
  if (sy > 0u) { fy = (f32(p.y) + 0.5) / f32(1u << sy) - 0.5; }
  let x0 = floor(fx);
  let y0 = floor(fy);
  let w = vec2f(fx - x0, fy - y0);
  let c = vec2i(i32(x0), i32(y0));
  let a = ld(t, c);
  let b = ld(t, c + vec2i(1, 0));
  let e = ld(t, c + vec2i(0, 1));
  let f = ld(t, c + vec2i(1, 1));
  return mix(mix(a, b, w.x), mix(e, f, w.x), w.y);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  let kind = u32(u.l.x);
  var c = vec4f(0.0);
  if (kind == 0u) {
    c = vec4f(ld(t0, p).x, chroma(t1, p).x, chroma(t2, p).x, ld(t3, p).x);
  } else if (kind == 1u) {
    let uv = chroma(t1, p);
    c = vec4f(ld(t0, p).x, uv.x, uv.y, 0.0);
  } else if (kind == 2u) {
    c = vec4f(ld(t0, p).x, ld(t1, p).x, ld(t2, p).x, ld(t3, p).x);
  } else {
    c = ld(t0, p);
  }
  let v = vec4f(c.xyz, 1.0);
  var rgb = clamp(vec3f(dot(u.m0, v), dot(u.m1, v), dot(u.m2, v)), vec3f(0.0), vec3f(1.0));
  var alpha = 1.0;
  if (u.a.w != 0.0) { alpha = clamp(c.w * u.a.x, 0.0, 1.0); }
  if (u.a.y != 0.0) { rgb = rgb * alpha; }
  return vec4f(rgb, alpha);
}
)";

constexpr std::string_view kWeaveWgsl = R"(
@group(0) @binding(0) var top: texture_2d<f32>;
@group(0) @binding(1) var bottom: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  if ((p.y & 1) == 0) { return textureLoad(top, p, 0); }
  return textureLoad(bottom, p, 0);
}
)";

std::string variant(bool floatPlanes) {
  std::string s(kConvertWgsl);
  auto replace_all = [&s](std::string_view from, std::string_view to) {
    for (std::size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) s.replace(at, from.size(), to);
  };
  replace_all("TEX", floatPlanes ? "texture_2d<f32>" : "texture_2d<u32>");
  replace_all("LOAD", floatPlanes ? "return textureLoad(t, q, 0) * u.a.z;"
                                  : "return vec4f(textureLoad(t, q, 0) >> vec4u(u32(u.l.w)));");
  return s;
}

wgpu::ShaderModule module(const wgpu::Device& d, std::string_view code) {
  wgpu::ShaderSourceWGSL src{};
  src.code = wgpu::StringView(code.data(), code.size());
  wgpu::ShaderModuleDescriptor md{};
  md.nextInChain = &src;
  return d.CreateShaderModule(&md);
}

wgpu::RenderPipeline pipeline(const wgpu::Device& d, const wgpu::ShaderModule& m, const wgpu::BindGroupLayout& bgl,
                              wgpu::TextureFormat out) {
  wgpu::PipelineLayoutDescriptor pl{};
  pl.bindGroupLayoutCount = 1;
  pl.bindGroupLayouts = &bgl;
  wgpu::ColorTargetState ct{};
  ct.format = out;
  wgpu::FragmentState fs{};
  fs.module = m;
  fs.entryPoint = "fs";
  fs.targetCount = 1;
  fs.targets = &ct;
  wgpu::RenderPipelineDescriptor rp{};
  rp.layout = d.CreatePipelineLayout(&pl);
  rp.vertex.module = m;
  rp.vertex.entryPoint = "vs";
  rp.fragment = &fs;
  rp.primitive.topology = wgpu::PrimitiveTopology::TriangleList;
  return d.CreateRenderPipeline(&rp);
}

wgpu::BindGroupLayout convert_layout(const wgpu::Device& d, wgpu::TextureSampleType type) {
  std::array<wgpu::BindGroupLayoutEntry, 5> e{};
  e[0].binding = 0;
  e[0].visibility = wgpu::ShaderStage::Fragment;
  e[0].buffer.type = wgpu::BufferBindingType::Uniform;
  for (std::uint32_t i = 1; i < 5; ++i) {
    e.at(i).binding = i;
    e.at(i).visibility = wgpu::ShaderStage::Fragment;
    e.at(i).texture.sampleType = type;
    e.at(i).texture.viewDimension = wgpu::TextureViewDimension::e2D;
  }
  wgpu::BindGroupLayoutDescriptor bd{};
  bd.entryCount = e.size();
  bd.entries = e.data();
  return d.CreateBindGroupLayout(&bd);
}

wgpu::TextureFormat plane_format(std::uint8_t bytes, std::uint8_t comps) {
  if (bytes == 1) {
    if (comps == 1) return wgpu::TextureFormat::R8Uint;
    if (comps == 2) return wgpu::TextureFormat::RG8Uint;
    return wgpu::TextureFormat::RGBA8Uint;
  }
  if (comps == 1) return wgpu::TextureFormat::R16Uint;
  if (comps == 2) return wgpu::TextureFormat::RG16Uint;
  return wgpu::TextureFormat::RGBA16Uint;
}

wgpu::TextureView one_by_one(const wgpu::Device& d, wgpu::TextureFormat f) {
  wgpu::TextureDescriptor td{};
  td.size = {1, 1, 1};
  td.format = f;
  td.usage = wgpu::TextureUsage::TextureBinding;
  return d.CreateTexture(&td).CreateView();
}

std::vector<float> pack_uniforms(const FrameFormat& ff, bool premultiply, float sampleScale) {
  const YuvToRgb c = yuv_to_rgb(ff);
  std::vector<float> u(20, 0.0F);
  std::memcpy(u.data(), c.m.data(), sizeof(float) * 12);
  u[12] = c.alphaScale;
  u[13] = premultiply ? 1.0F : 0.0F;
  u[14] = sampleScale;
  u[15] = ff.hasAlpha ? 1.0F : 0.0F;
  u[16] = static_cast<float>(ff.layout == Layout::planarYuv ? 0 : ff.layout == Layout::semiPlanarYuv ? 1 : ff.layout == Layout::planarRgb ? 2 : 3);
  u[17] = static_cast<float>(ff.chromaShiftX);
  u[18] = static_cast<float>(ff.chromaShiftY);
  u[19] = static_cast<float>(ff.storageShift);
  return u;
}

}  // namespace

std::vector<wgpu::FeatureName> candidate_device_features() {
  return {wgpu::FeatureName::SharedTextureMemoryDXGISharedHandle, wgpu::FeatureName::DawnMultiPlanarFormats,
          wgpu::FeatureName::MultiPlanarFormatP010, wgpu::FeatureName::Unorm16TextureFormats};
}

std::vector<wgpu::FeatureName> wanted_device_features(const wgpu::Adapter& adapter) {
  std::vector<wgpu::FeatureName> out;
  for (const auto f : candidate_device_features()) {
    if (adapter.HasFeature(f)) out.push_back(f);
  }
  return out;
}

/// A hardware surface imported into Dawn, cached per pool slot.
struct FrameConverter::Imported {
  wgpu::SharedTextureMemory memory;
  wgpu::Texture texture;
  wgpu::TextureView y;
  wgpu::TextureView uv;
};

FrameConverter::FrameConverter(wgpu::Device device, wgpu::TextureFormat output)
    : device_(std::move(device)), queue_(device_.GetQueue()), output_(output) {
#if defined(_WIN32)
  zeroCopyNv12_ = device_.HasFeature(wgpu::FeatureName::SharedTextureMemoryDXGISharedHandle) &&
                  device_.HasFeature(wgpu::FeatureName::DawnMultiPlanarFormats);
  zeroCopyP010_ = zeroCopyNv12_ && device_.HasFeature(wgpu::FeatureName::MultiPlanarFormatP010) &&
                  device_.HasFeature(wgpu::FeatureName::Unorm16TextureFormats);
#endif
  const std::string u = variant(false);
  const std::string f = variant(true);
  uintPipeline_ = pipeline(device_, module(device_, u), convert_layout(device_, wgpu::TextureSampleType::Uint), output_);
  floatPipeline_ = pipeline(device_, module(device_, f), convert_layout(device_, wgpu::TextureSampleType::UnfilterableFloat), output_);
  {
    std::array<wgpu::BindGroupLayoutEntry, 2> e{};
    for (std::uint32_t i = 0; i < 2; ++i) {
      e.at(i).binding = i;
      e.at(i).visibility = wgpu::ShaderStage::Fragment;
      e.at(i).texture.sampleType = wgpu::TextureSampleType::UnfilterableFloat;
    }
    wgpu::BindGroupLayoutDescriptor bd{};
    bd.entryCount = e.size();
    bd.entries = e.data();
    weavePipeline_ = pipeline(device_, module(device_, kWeaveWgsl), device_.CreateBindGroupLayout(&bd), output_);
  }
  wgpu::BufferDescriptor bd{};
  bd.size = 80;
  bd.usage = wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst;
  uniforms_ = device_.CreateBuffer(&bd);
  dummyUint_ = one_by_one(device_, wgpu::TextureFormat::R8Uint);
  dummyFloat_ = one_by_one(device_, wgpu::TextureFormat::R8Unorm);
}

FrameConverter::~FrameConverter() = default;

bool FrameConverter::ensure_plane(PlaneTex& p, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat fmt) {
  if (p.texture != nullptr && p.width == w && p.height == h && p.format == fmt) return true;
  wgpu::TextureDescriptor td{};
  td.size = {std::max(1U, w), std::max(1U, h), 1};
  td.format = fmt;
  td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst;
  p.texture = device_.CreateTexture(&td);
  p.view = p.texture.CreateView();
  p.width = w;
  p.height = h;
  p.format = fmt;
  return p.texture != nullptr;
}

ConvertedFrame FrameConverter::target(std::uint32_t w, std::uint32_t h) {
  for (auto it = free_.begin(); it != free_.end(); ++it) {
    if (it->width == w && it->height == h) {
      ConvertedFrame f = std::move(*it);
      free_.erase(it);
      f.zeroCopy = false;
      return f;
    }
  }
  ConvertedFrame f;
  wgpu::TextureDescriptor td{};
  td.size = {w, h, 1};
  td.format = output_;
  td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc;
  td.label = "media-frame";
  f.texture = device_.CreateTexture(&td);
  f.view = f.texture.CreateView();
  f.width = w;
  f.height = h;
  return f;
}

void FrameConverter::recycle(ConvertedFrame&& f) {
  if (f.texture == nullptr) return;
  if (free_.size() >= 8) free_.erase(free_.begin());
  free_.push_back(std::move(f));
}

void FrameConverter::run_pass(bool floatPlanes, const std::array<wgpu::TextureView, 4>& planes,
                              const std::vector<float>& uniforms, const ConvertedFrame& out) {
  queue_.WriteBuffer(uniforms_, 0, uniforms.data(), uniforms.size() * sizeof(float));
  const wgpu::RenderPipeline& pipe = floatPipeline_ == nullptr || !floatPlanes ? uintPipeline_ : floatPipeline_;
  std::array<wgpu::BindGroupEntry, 5> e{};
  e[0].binding = 0;
  e[0].buffer = uniforms_;
  e[0].size = 80;
  for (std::uint32_t i = 0; i < 4; ++i) {
    e.at(i + 1).binding = i + 1;
    e.at(i + 1).textureView = planes.at(i) != nullptr ? planes.at(i) : (floatPlanes ? dummyFloat_ : dummyUint_);
  }
  wgpu::BindGroupDescriptor bgd{};
  bgd.layout = pipe.GetBindGroupLayout(0);
  bgd.entryCount = e.size();
  bgd.entries = e.data();
  const wgpu::BindGroup bg = device_.CreateBindGroup(&bgd);
  wgpu::CommandEncoder enc = device_.CreateCommandEncoder();
  wgpu::RenderPassColorAttachment ca{};
  ca.view = out.view;
  ca.loadOp = wgpu::LoadOp::Clear;
  ca.storeOp = wgpu::StoreOp::Store;
  wgpu::RenderPassDescriptor rpd{};
  rpd.colorAttachmentCount = 1;
  rpd.colorAttachments = &ca;
  wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rpd);
  pass.SetPipeline(pipe);
  pass.SetBindGroup(0, bg);
  pass.Draw(3);
  pass.End();
  const wgpu::CommandBuffer cb = enc.Finish();
  queue_.Submit(1, &cb);
}

bool FrameConverter::convert(const DecodedFrame& f, AlphaMode alpha, ConvertedFrame& out, std::string& error) {
  if (f.width == 0 || f.height == 0) {
    error = "empty frame";
    return false;
  }
  const bool premultiply = f.format.hasAlpha && alpha != AlphaMode::premultiplied;
  if (f.gpu != nullptr) {
#if defined(_WIN32)
    const d3d11::SurfaceInfo* si = d3d11::surface_info(f.gpu);
    if (si == nullptr) {
      error = "unknown GPU surface";
      return false;
    }
    const bool p010 = si->format != d3d11::SurfaceFormat::nv12;
    if (!(p010 ? zeroCopyP010_ : zeroCopyNv12_)) {
      error = "device cannot import this hardware surface (missing Dawn multi-planar features)";
      return false;
    }
    auto& slot = imported_[si->id];
    if (!slot) {
      const auto t0 = std::chrono::steady_clock::now();  // measurement only
      slot = std::make_unique<Imported>();
      wgpu::SharedTextureMemoryDXGISharedHandleDescriptor dx{};
      dx.handle = si->sharedHandle;
      dx.useKeyedMutex = true;
      wgpu::SharedTextureMemoryDescriptor md{};
      md.nextInChain = &dx;
      slot->memory = device_.ImportSharedTextureMemory(&md);
      if (slot->memory == nullptr) {
        imported_.erase(si->id);
        error = "ImportSharedTextureMemory failed";
        return false;
      }
      wgpu::TextureDescriptor td{};
      td.size = {si->width, si->height, 1};
      td.format = p010 ? wgpu::TextureFormat::R10X6BG10X6Biplanar420Unorm : wgpu::TextureFormat::R8BG8Biplanar420Unorm;
      td.usage = wgpu::TextureUsage::TextureBinding;
      slot->texture = slot->memory.CreateTexture(&td);
      wgpu::TextureViewDescriptor vd{};
      vd.aspect = wgpu::TextureAspect::Plane0Only;
      vd.format = p010 ? wgpu::TextureFormat::R16Unorm : wgpu::TextureFormat::R8Unorm;
      slot->y = slot->texture.CreateView(&vd);
      vd.aspect = wgpu::TextureAspect::Plane1Only;
      vd.format = p010 ? wgpu::TextureFormat::RG16Unorm : wgpu::TextureFormat::RG8Unorm;
      slot->uv = slot->texture.CreateView(&vd);
      ++stats_.imports;
      stats_.importMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    }
    wgpu::SharedTextureMemoryBeginAccessDescriptor begin{};
    begin.initialized = true;
    begin.concurrentRead = false;
    if (slot->memory.BeginAccess(slot->texture, &begin) != wgpu::Status::Success) {
      error = "SharedTextureMemory BeginAccess failed";
      return false;
    }
    out = target(f.width, f.height);
    // unorm → code: P010 stores code << 6 in 16 bits.
    const float scale = p010 ? 65535.0F / 64.0F : 255.0F;
    FrameFormat ff = f.format;
    ff.layout = Layout::semiPlanarYuv;
    ff.bitDepth = p010 ? 10 : 8;
    ff.chromaShiftX = 1;
    ff.chromaShiftY = 1;
    ff.hasAlpha = false;
    run_pass(true, {slot->y, slot->uv, nullptr, nullptr}, pack_uniforms(ff, false, scale), out);
    wgpu::SharedTextureMemoryEndAccessState state{};
    (void)slot->memory.EndAccess(slot->texture, &state);
    out.zeroCopy = true;
    ++stats_.conversions;
    ++stats_.zeroCopy;
    return true;
#else
    error = "GPU surfaces are not supported on this platform yet";
    return false;
#endif
  }

  if (f.planeCount == 0) {
    error = "frame has no planes";
    return false;
  }
  std::array<wgpu::TextureView, 4> views{};
  for (std::size_t i = 0; i < f.planeCount && i < 4; ++i) {
    const Plane& src = f.planes.at(i);
    PlaneTex& p = planes_.at(i);
    const wgpu::TextureFormat fmt = plane_format(f.format.bytesPerSample, src.components);
    if (!ensure_plane(p, src.width, src.height, fmt)) {
      error = "plane texture";
      return false;
    }
    const std::size_t rowBytes = std::size_t{src.width} * src.components * f.format.bytesPerSample;
    const std::size_t size = src.stride * (src.height - 1) + rowBytes;
    wgpu::TexelCopyTextureInfo dst{};
    dst.texture = p.texture;
    wgpu::TexelCopyBufferLayout layout{};
    layout.bytesPerRow = static_cast<std::uint32_t>(src.stride);
    layout.rowsPerImage = src.height;
    const wgpu::Extent3D ext{src.width, src.height, 1};
    queue_.WriteTexture(&dst, src.data, size, &layout, &ext);
    stats_.uploadedBytes += size;
    views.at(i) = p.view;
  }
  out = target(f.width, f.height);
  run_pass(false, views, pack_uniforms(f.format, premultiply, 1.0F), out);
  ++stats_.conversions;
  return true;
}

bool FrameConverter::weave(const ConvertedFrame& top, const ConvertedFrame& bottom, ConvertedFrame& out,
                           std::string& error) {
  if (top.width != bottom.width || top.height != bottom.height) {
    error = "weave: field frames differ in size";
    return false;
  }
  out = target(top.width, top.height);
  std::array<wgpu::BindGroupEntry, 2> e{};
  e[0].binding = 0;
  e[0].textureView = top.view;
  e[1].binding = 1;
  e[1].textureView = bottom.view;
  wgpu::BindGroupDescriptor bgd{};
  bgd.layout = weavePipeline_.GetBindGroupLayout(0);
  bgd.entryCount = e.size();
  bgd.entries = e.data();
  const wgpu::BindGroup bg = device_.CreateBindGroup(&bgd);
  wgpu::CommandEncoder enc = device_.CreateCommandEncoder();
  wgpu::RenderPassColorAttachment ca{};
  ca.view = out.view;
  ca.loadOp = wgpu::LoadOp::Clear;
  ca.storeOp = wgpu::StoreOp::Store;
  wgpu::RenderPassDescriptor rpd{};
  rpd.colorAttachmentCount = 1;
  rpd.colorAttachments = &ca;
  wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rpd);
  pass.SetPipeline(weavePipeline_);
  pass.SetBindGroup(0, bg);
  pass.Draw(3);
  pass.End();
  const wgpu::CommandBuffer cb = enc.Finish();
  queue_.Submit(1, &cb);
  return true;
}

}  // namespace premation::media
