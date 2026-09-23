#include "scene_renderer.hpp"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <mutex>

#include "passes.hpp"
#include "render_context.hpp"

namespace premation::rg {
namespace {

std::mutex g_errorMutex;
std::string g_firstError;  // guarded by g_errorMutex

std::string_view view_of(wgpu::StringView s) {
  if (s.data == nullptr) return {};
  return s.length == wgpu::kStrlen ? std::string_view(s.data) : std::string_view(s.data, s.length);
}

void record_error(std::string_view msg) {
  const std::lock_guard lock(g_errorMutex);
  if (g_firstError.empty()) g_firstError = std::string(msg);
}

std::string take_error() {
  const std::lock_guard lock(g_errorMutex);
  std::string e = std::move(g_firstError);
  g_firstError.clear();
  return e;
}

wgpu::BackendType native_backend() {
#if defined(_WIN32)
  return wgpu::BackendType::D3D12;
#elif defined(__APPLE__)
  return wgpu::BackendType::Metal;
#else
  return wgpu::BackendType::Vulkan;
#endif
}

wgpu::Adapter request_adapter(const wgpu::Instance& instance, wgpu::PowerPreference pref) {
  wgpu::Adapter found;
  wgpu::RequestAdapterOptions o{};
  o.backendType = native_backend();
  o.powerPreference = pref;
  instance.WaitAny(instance.RequestAdapter(&o, wgpu::CallbackMode::WaitAnyOnly,
                                           [&found](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView) {
                                             if (s == wgpu::RequestAdapterStatus::Success) found = std::move(a);
                                           }),
                   UINT64_MAX);
  return found;
}

void wait_idle(const wgpu::Instance& instance, const wgpu::Queue& queue) {
  instance.WaitAny(queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {}),
                   UINT64_MAX);
}

}  // namespace

std::unique_ptr<SceneRenderer> SceneRenderer::create(const RendererOptions& options, std::string& error) {
  static constexpr auto kTimedWaitAny = wgpu::InstanceFeatureName::TimedWaitAny;
  wgpu::InstanceDescriptor id{};
  id.requiredFeatureCount = 1;
  id.requiredFeatures = &kTimedWaitAny;
  wgpu::Instance instance = wgpu::CreateInstance(&id);
  if (instance == nullptr) {
    error = "wgpu::CreateInstance failed";
    return nullptr;
  }
  const auto hi = wgpu::PowerPreference::HighPerformance;
  const auto lo = wgpu::PowerPreference::LowPower;
  wgpu::Adapter adapter = request_adapter(instance, options.highPerformance ? hi : lo);
  if (adapter == nullptr) {
    error = "no GPU adapter";
    return nullptr;
  }
  wgpu::AdapterInfo info{};
  adapter.GetInfo(&info);
  if (options.vendorId != 0 && info.vendorID != options.vendorId) {
    wgpu::Adapter other = request_adapter(instance, options.highPerformance ? lo : hi);
    wgpu::AdapterInfo otherInfo{};
    if (other != nullptr) other.GetInfo(&otherInfo);
    if (other != nullptr && otherInfo.vendorID == options.vendorId) {
      adapter = std::move(other);
      info = std::move(otherInfo);
    }
  }
  std::vector<wgpu::FeatureName> features;
  // WebGPUBackend.initialize asks for float32-filterable when offered; so do we.
  if (adapter.HasFeature(wgpu::FeatureName::Float32Filterable)) features.push_back(wgpu::FeatureName::Float32Filterable);
  wgpu::DeviceDescriptor dd{};
  dd.requiredFeatureCount = features.size();
  dd.requiredFeatures = features.data();
  dd.SetUncapturedErrorCallback([](const wgpu::Device&, wgpu::ErrorType, wgpu::StringView msg) {
    record_error(view_of(msg));
  });
  dd.SetDeviceLostCallback(wgpu::CallbackMode::AllowSpontaneous,
                           [](const wgpu::Device&, wgpu::DeviceLostReason reason, wgpu::StringView msg) {
                             if (reason != wgpu::DeviceLostReason::Destroyed) record_error(view_of(msg));
                           });
  wgpu::Device device;
  instance.WaitAny(adapter.RequestDevice(&dd, wgpu::CallbackMode::WaitAnyOnly,
                                         [&device](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView) {
                                           if (s == wgpu::RequestDeviceStatus::Success) device = std::move(d);
                                         }),
                   UINT64_MAX);
  if (device == nullptr) {
    error = "RequestDevice failed";
    return nullptr;
  }
  std::unique_ptr<SceneRenderer> r(new SceneRenderer());  // NOLINT(cppcoreguidelines-owning-memory): private ctor
  wgpu::Queue queue = device.GetQueue();
  r->dev_ = std::make_unique<Device>(instance, device, queue);
  r->graph_ = build_default_graph();
  r->adapter_ = std::string(view_of(info.device));
  r->backend_ = info.backendType == wgpu::BackendType::D3D12 ? "D3D12"
                : info.backendType == wgpu::BackendType::Metal ? "Metal"
                : "Vulkan";
  return r;
}

SceneRenderer::~SceneRenderer() = default;

bool SceneRenderer::render(const api::RenderFrameFile& file, Frame* readback, FrameStats& stats, std::string& error) {
  using Clock = std::chrono::steady_clock;
  const auto t0 = Clock::now();
  const ViewportState vp = ViewportState::from(file.view);
  const wgpu::TextureFormat surfaceFormat =
      file.view.surface_format == api::RenderTextureFormat::rgba8unorm ? wgpu::TextureFormat::RGBA8Unorm
                                                                      : wgpu::TextureFormat::BGRA8Unorm;
  if (surface_ == nullptr || surfaceW_ != vp.pixelWidth || surfaceH_ != vp.pixelHeight ||
      surface_.GetFormat() != surfaceFormat) {
    wgpu::TextureDescriptor td{};
    td.size = {vp.pixelWidth, vp.pixelHeight, 1};
    td.format = surfaceFormat;
    td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc | wgpu::TextureUsage::TextureBinding;
    td.label = "surface";
    surface_ = dev_->device().CreateTexture(&td);
    surfaceView_ = surface_.CreateView();
    surfaceW_ = vp.pixelWidth;
    surfaceH_ = vp.pixelHeight;
  }

  TextureTable textures;
  textures.build(file);
  dev_->begin_frame();
  PassContext ctx{*dev_, file, textures, vp, {}, {}, surfaceView_, surfaceFormat, std::nullopt,
                  std::string(kSceneColor), stats.diagnostics, {}, Scope3D::of(file.scene)};
  ctx.color.working = file.view.working_space == api::RenderWorkingSpace::aces_cg ? WorkingSpace::aces_cg : WorkingSpace::srgb_linear;
  switch (file.view.display_transform) {
    case api::RenderDisplayTransform::aces: ctx.color.display = DisplayTransform::aces; break;
    case api::RenderDisplayTransform::pq: ctx.color.display = DisplayTransform::pq; break;
    case api::RenderDisplayTransform::hlg: ctx.color.display = DisplayTransform::hlg; break;
    default: ctx.color.display = DisplayTransform::srgb; break;
  }
  ctx.color.bitDepth = file.view.bit_depth;
  if (file.view.frame_clip) {
    // WebGPUBackend.beginRenderPass: round + clamp the clip to the surface.
    const auto& c = *file.view.frame_clip;
    const double W = vp.pixelWidth;
    const double H = vp.pixelHeight;
    const double x = std::max(0.0, std::min(W, std::floor(c.x + 0.5)));
    const double y = std::max(0.0, std::min(H, std::floor(c.y + 0.5)));
    const double w = std::max(0.0, std::min(W - x, std::floor(c.width + 0.5)));
    const double h = std::max(0.0, std::min(H - y, std::floor(c.height + 0.5)));
    ctx.surfaceScissor = std::array<std::uint32_t, 4>{static_cast<std::uint32_t>(x), static_cast<std::uint32_t>(y),
                                                      static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h)};
  }
  // The surface is a fresh swap-chain image every frame in the TS engine: cleared.
  {
    Attachment att;
    att.clear = true;
    wgpu::RenderPassEncoder p = dev_->begin_pass(att, vp.pixelWidth, vp.pixelHeight, surfaceView_, surfaceFormat, nullptr, false);
    p.End();
  }
  // resolveTargets: every active declared target, float where declared float.
  for (const auto& [name, desc] : graph_->active_targets(vp.pixelWidth, vp.pixelHeight)) {
    const wgpu::TextureFormat fmt = desc.format == "rgba16float" || desc.format == "rgba32float"
                                        ? wgpu::TextureFormat::RGBA16Float
                                        : wgpu::TextureFormat::RGBA8Unorm;
    RenderTarget& t = dev_->target(name, desc.width, desc.height, fmt, desc.samples, desc.depth);
    ctx.targets.emplace(name, &t);
  }
  graph_->execute(ctx, nullptr, stats.diagnostics);

  // Readback copy rides the frame's own command buffer.
  wgpu::Buffer staging;
  const std::uint32_t rowBytes = vp.pixelWidth * 4;
  const std::uint32_t bytesPerRow = (rowBytes + 255) / 256 * 256;
  if (readback != nullptr) {
    wgpu::BufferDescriptor bd{};
    bd.size = std::uint64_t{bytesPerRow} * vp.pixelHeight;
    bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
    staging = dev_->device().CreateBuffer(&bd);
    wgpu::TexelCopyTextureInfo src{};
    src.texture = surface_;
    wgpu::TexelCopyBufferInfo dst{};
    dst.buffer = staging;
    dst.layout.bytesPerRow = bytesPerRow;
    dst.layout.rowsPerImage = vp.pixelHeight;
    const wgpu::Extent3D size{vp.pixelWidth, vp.pixelHeight, 1};
    dev_->encoder().CopyTextureToBuffer(&src, &dst, &size);
  }
  const auto t1 = Clock::now();
  stats.collected = dev_->end_frame();
  wait_idle(dev_->instance(), dev_->queue());
  const auto t2 = Clock::now();
  stats.encodeMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
  stats.gpuMs = std::chrono::duration<double, std::milli>(t2 - t1).count();
  stats.gpuError = take_error();

  if (readback != nullptr) {
    bool mapped = false;
    dev_->instance().WaitAny(staging.MapAsync(wgpu::MapMode::Read, 0, staging.GetSize(), wgpu::CallbackMode::WaitAnyOnly,
                                              [&mapped](wgpu::MapAsyncStatus s, wgpu::StringView) {
                                                mapped = s == wgpu::MapAsyncStatus::Success;
                                              }),
                             UINT64_MAX);
    if (!mapped) {
      error = "surface readback failed";
      return false;
    }
    const auto* src = static_cast<const std::uint8_t*>(staging.GetConstMappedRange(0, staging.GetSize()));
    readback->width = vp.pixelWidth;
    readback->height = vp.pixelHeight;
    readback->rgba.resize(std::size_t{rowBytes} * vp.pixelHeight);
    const bool bgra = surfaceFormat == wgpu::TextureFormat::BGRA8Unorm;
    for (std::uint32_t y = 0; y < vp.pixelHeight; ++y) {
      const std::uint8_t* row = src + std::size_t{y} * bytesPerRow;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      std::uint8_t* out = readback->rgba.data() + std::size_t{y} * rowBytes;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      for (std::uint32_t x = 0; x < vp.pixelWidth; ++x) {
        const std::size_t i = std::size_t{x} * 4;
        out[i + 0] = row[i + (bgra ? 2 : 0)];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        out[i + 1] = row[i + 1];               // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        out[i + 2] = row[i + (bgra ? 0 : 2)];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        out[i + 3] = row[i + 3];               // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
    }
    staging.Unmap();
  }
  return true;
}

}  // namespace premation::rg
