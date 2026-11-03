#include "render_glue.hpp"

#include <dawn/native/DawnNative.h>

#include <atomic>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "cpu_render.hpp"
#include "fx_wire.hpp"
#include "host.hpp"
#include "render_context.hpp"
#include "uniforms.hpp"

namespace premation::plugins {
namespace {

/// The glue's own textures per size + format: the CPU path's upload, the GPU
/// path's output, then one per GPU checkout.
enum : std::uint32_t { kUploadSlot = 0, kGpuOutputSlot = 1, kFirstCheckoutSlot = 2 };

std::optional<TexelFormat> texel_format_of(wgpu::TextureFormat f) noexcept {
  switch (f) {
    case wgpu::TextureFormat::RGBA8Unorm: return TexelFormat::rgba8;
    case wgpu::TextureFormat::RGBA16Float: return TexelFormat::rgba16f;
    case wgpu::TextureFormat::RGBA32Float: return TexelFormat::rgba32f;
    default: return std::nullopt;
  }
}

std::uint32_t project_bits_of(TexelFormat f) noexcept {
  return f == TexelFormat::rgba32f ? 32U : f == TexelFormat::rgba16f ? 16U : 8U;
}

PrGpuFormat gpu_format_of(TexelFormat f) noexcept {
  return f == TexelFormat::rgba32f ? PR_GPU_FORMAT_RGBA32_FLOAT : f == TexelFormat::rgba16f ? PR_GPU_FORMAT_RGBA16_FLOAT : PR_GPU_FORMAT_RGBA8_UNORM;
}

PrGpuBackend backend_of(wgpu::BackendType b) noexcept {
  switch (b) {
    case wgpu::BackendType::D3D12: return PR_GPU_BACKEND_D3D12;
    case wgpu::BackendType::Metal: return PR_GPU_BACKEND_METAL;
    case wgpu::BackendType::Vulkan: return PR_GPU_BACKEND_VULKAN;
    default: return PR_GPU_BACKEND_UNKNOWN;
  }
}

/// Everything encoded so far is submitted first (Device::flush), so the copy
/// sees the chain's buffer as the frame left it. Off the hot path by nature: a
/// CPU plugin needs its pixels on the CPU.
bool read_back(rg::Device& dev, const wgpu::Texture& texture, std::uint32_t w, std::uint32_t h, TexelFormat f, TexelImage& out,
               std::string& error) {
  dev.flush();
  const std::uint32_t tb = texel_bytes(f);
  const std::uint32_t rowBytes = w * tb;
  const std::uint32_t bytesPerRow = (rowBytes + 255) / 256 * 256;
  wgpu::BufferDescriptor bd{};
  bd.size = std::uint64_t{bytesPerRow} * h;
  bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
  bd.label = "native-plugin-readback";
  const wgpu::Buffer staging = dev.device().CreateBuffer(&bd);
  wgpu::CommandEncoder enc = dev.device().CreateCommandEncoder();
  wgpu::TexelCopyTextureInfo src{};
  src.texture = texture;
  wgpu::TexelCopyBufferInfo dst{};
  dst.buffer = staging;
  dst.layout.bytesPerRow = bytesPerRow;
  dst.layout.rowsPerImage = h;
  const wgpu::Extent3D size{w, h, 1};
  enc.CopyTextureToBuffer(&src, &dst, &size);
  const wgpu::CommandBuffer cb = enc.Finish();
  dev.queue().Submit(1, &cb);
  bool mapped = false;
  dev.instance().WaitAny(staging.MapAsync(wgpu::MapMode::Read, 0, staging.GetSize(), wgpu::CallbackMode::WaitAnyOnly,
                                          [&mapped](wgpu::MapAsyncStatus s, wgpu::StringView) {
                                            mapped = s == wgpu::MapAsyncStatus::Success;
                                          }),
                         UINT64_MAX);
  if (!mapped) {
    error = "plugin input readback failed";
    return false;
  }
  const auto* bytes = static_cast<const std::uint8_t*>(staging.GetConstMappedRange(0, staging.GetSize()));
  const std::span<const std::uint8_t> all(bytes, staging.GetSize());
  out.format = f;
  out.width = w;
  out.height = h;
  out.bytes.resize(std::size_t{rowBytes} * h);
  for (std::uint32_t y = 0; y < h; ++y) {
    const auto row = all.subspan(std::size_t{y} * bytesPerRow, rowBytes);
    std::memcpy(out.bytes.data() + std::size_t{y} * rowBytes, row.data(), rowBytes);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  staging.Unmap();
  return true;
}

/// `tex` drawn over the whole of target `name` (texel for texel: same size, nearest), its texels
/// as they are when `tex.sampleLinear` (a chain buffer, a plugin's output: linear working space) —
/// never sRGB-decoded on the way, which darkened every plugin's output and checkout.
void draw_full(rg::PassContext& ctx, std::string_view name, const rg::TexRef& tex) {
  rg::Commands cmds;
  rg::emit_textured(ctx, cmds, rg::screen_mvp(), rg::Color::white(), 1, rg::Blend::none, tex, ctx.nearest_clamp(), rg::Rect{0, 0, 1, 1},
                    rg::kIdentityColor, tex.sampleLinear);
  ctx.draw_into(name, cmds, true);
}

/// The layer's placement in the chain buffer: layer pixel → buffer pixel (the
/// chain's fxBox — its layer-space box on the 3D route, else its bounds on screen).
std::array<double, 9> layer_to_world(const rg::PassContext& ctx, const rg::NativeEffectHost::Call& call, const RenderInputs& in,
                                     std::uint32_t w, std::uint32_t h) {
  rg::Rect box{0, 0, 1, 1};
  if (call.space != nullptr) {
    box = call.space->box;
  } else if (call.self != nullptr) {
    const rg::Rect v = ctx.viewport.visibleWorldRect;
    if (v.width > 0 && v.height > 0) {
      box = {(call.self->bounds.x - v.x) / v.width, (call.self->bounds.y - v.y) / v.height, call.self->bounds.width / v.width,
             call.self->bounds.height / v.height};
    }
  }
  const double sx = in.layerW > 0 ? box.width * w / in.layerW : 1;
  const double sy = in.layerH > 0 ? box.height * h / in.layerH : 1;
  return {sx, 0, box.x * w, 0, sy, box.y * h, 0, 0, 1};
}

/// SDK 1.2 comp_to_world: comp px → buffer px. A screen-space chain sees the viewport's
/// window onto the composition; a layer-space one (the 3D route) takes comp px as layer px.
std::array<double, 9> comp_to_world(const rg::PassContext& ctx, const rg::NativeEffectHost::Call& call, const RenderInputs& in,
                                    std::uint32_t w, std::uint32_t h) {
  if (call.space != nullptr) return in.layerToWorld;
  const rg::Rect v = ctx.viewport.visibleWorldRect;
  if (!(v.width > 0 && v.height > 0)) return in.layerToWorld;
  const double sx = w / v.width;
  const double sy = h / v.height;
  return {sx, 0, -v.x * sx, 0, sy, -v.y * sy, 0, 0, 1};
}

/// The GPU path's checkouts: checkout id → a texture of the chain buffer's size
/// and format. A missing id checks out empty (nullptr), as the SDK allows.
class GpuCheckouts final : public CheckoutSource {
 public:
  using AssetFn = std::function<const PrGpuWorld*(const std::string&, const AssetImage&)>;
  using DepthFn = std::function<const PrGpuWorld*()>;
  using DepthAtFn = std::function<const PrGpuWorld*(const TimeSample&)>;
  GpuCheckouts(AssetFn assets, DepthFn depth, DepthAtFn depthAt = {})
      : assets_(std::move(assets)), depth_(std::move(depth)), depthAt_(std::move(depthAt)) {}
  void set(std::uint32_t checkoutId, const PrGpuWorld& world) { worlds_[checkoutId] = world; }
  const PrGpuWorld* gpu_asset(const std::string& key, const AssetImage& image) override { return assets_(key, image); }
  const PrGpuWorld* gpu_scene_depth() override { return depth_ ? depth_() : nullptr; }
  const PrGpuWorld* gpu_scene_depth_at(const TimeSample& sample) override { return depthAt_ ? depthAt_(sample) : nullptr; }
  PrWorld* cpu_checkout(std::uint32_t /*checkoutId*/) override { return nullptr; }
  PrWorld* cpu_output() override { return nullptr; }
  const PrGpuWorld* gpu_checkout(std::uint32_t checkoutId) override {
    const auto it = worlds_.find(checkoutId);
    return it == worlds_.end() ? nullptr : &it->second;
  }

 private:
  std::map<std::uint32_t, PrGpuWorld> worlds_;
  AssetFn assets_;
  DepthFn depth_;
  DepthAtFn depthAt_;
};

/// A checkout other than the input at the frame's time, drawn as the chain
/// would see it: a LAYER param's layer, or the effect's own layer at another
/// time (the hidden `<layer>@<flicks>` renderables). Empty when unavailable.
rg::TexRef checkout_texture(rg::PassContext& ctx, const rg::NativeEffectHost::Call& call, const RenderInputs& in,
                            const CheckoutRequest& c) {
  if (call.poolHasMatte || call.maps == nullptr || call.byId == nullptr) return {};
  std::string layer = c.paramIndex == 0 ? in.layerId
                      : c.paramIndex - 1 < in.values.size() ? in.values[c.paramIndex - 1].layer
                                                             : std::string();
  if (layer.empty()) return {};
  if (c.time != in.layerTime) layer = checkout_renderable_id(layer, c.time);
  return call.maps->map_layer(ctx, *call.byId, layer, call.selfId);
}

/// Plugin-visible device indices are unique per process: each glue and each
/// device it meets gets its own, so SETUP / SETDOWN pairs never cross.
std::atomic<std::uint32_t> g_nextDeviceIndex{0};  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

/// Pop one error scope; its message, or "" when the scope saw no error.
std::string pop_scope(rg::Device& dev) {
  std::string message;
  dev.instance().WaitAny(dev.device().PopErrorScope(wgpu::CallbackMode::WaitAnyOnly,
                                                    [&message](wgpu::PopErrorScopeStatus status, wgpu::ErrorType type, wgpu::StringView msg) {
                                                      if (status != wgpu::PopErrorScopeStatus::Success) {
                                                        message = "error scope lost";
                                                      } else if (type != wgpu::ErrorType::NoError) {
                                                        message = std::string(msg.data, msg.length);
                                                        if (message.empty()) message = "GPU error";
                                                      }
                                                    }),
                         UINT64_MAX);
  return message;
}

}  // namespace

RenderGlue::~RenderGlue() {
  PluginHost* host = host_ != nullptr ? host_ : PluginHost::active();
  if (device_ != nullptr && host != nullptr) host->gpu_device_gone(deviceIndex_);
}

const PrGpuWorld* RenderGlue::asset_texture(rg::Device& dev, const std::string& key, const AssetImage& image) {
  if (const auto it = assets_.find(key); it != assets_.end()) return &it->second.world;
  const std::uint32_t most = dev.max_texture_dimension();
  if (image.width <= 0 || image.height <= 0 || static_cast<std::uint32_t>(image.width) > most || static_cast<std::uint32_t>(image.height) > most) {
    return nullptr;
  }
  if (assets_.size() >= 64) assets_.clear();  // a plugin cycling through many files: start over
  const auto w = static_cast<std::uint32_t>(image.width);
  const auto h = static_cast<std::uint32_t>(image.height);
  wgpu::TextureDescriptor td{};
  td.size = {w, h, 1};
  td.format = wgpu::TextureFormat::RGBA32Float;
  td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst | wgpu::TextureUsage::CopySrc;
  td.label = "native-plugin-asset";
  AssetTexture t;
  t.texture = dev.device().CreateTexture(&td);
  t.view = t.texture.CreateView();
  wgpu::TexelCopyTextureInfo dst{};
  dst.texture = t.texture;
  wgpu::TexelCopyBufferLayout layout{};
  layout.bytesPerRow = w * 16;
  layout.rowsPerImage = h;
  const wgpu::Extent3D size{w, h, 1};
  dev.queue().WriteTexture(&dst, image.rgba.data(), image.rgba.size() * sizeof(float), &layout, &size);
  t.world = PrGpuWorld{sizeof(PrGpuWorld), image.width, image.height, PR_GPU_FORMAT_RGBA32_FLOAT, t.texture.Get(), t.view.Get(), nullptr};
  return &assets_.emplace(key, std::move(t)).first->second.world;
}

RenderGlue::OwnTexture& RenderGlue::own(rg::Device& dev, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat format, std::uint32_t slot) {
  const auto key = std::make_tuple(w, h, static_cast<std::uint32_t>(format), slot);
  OwnTexture& t = textures_[key];
  if (t.texture == nullptr) {
    wgpu::TextureDescriptor td{};
    td.size = {w, h, 1};
    td.format = format;
    td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst | wgpu::TextureUsage::CopySrc |
               wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::StorageBinding;
    td.label = "native-plugin-output";
    t.texture = dev.device().CreateTexture(&td);
    t.view = t.texture.CreateView();
    // ExternalTextureSource's rule: ids outside the Device's range (high bits).
    t.id = (std::uint64_t{3} << 62U) | nextId_++;
  }
  return t;
}

bool RenderGlue::apply(rg::PassContext& ctx, const Call& call) {
  PluginHost* host = host_ != nullptr ? host_ : PluginHost::active();
  const auto decline = [&](std::string code, std::string detail) {
    ctx.diagnostics.push_back({std::move(code), std::move(detail)});
    ++stats_.declined;
    return false;
  };
  std::string matchName;
  for (const auto& p : call.effect->params) {
    if (p.name == "matchName") matchName = p.text;
  }
  if (host == nullptr) return decline("native-plugin-unavailable", "no plugin host for \"" + matchName + "\"");
  const EffectSpec* spec = host->effect(matchName);
  if (spec == nullptr) return decline("native-plugin-missing", "no loaded plugin provides \"" + matchName + "\"");
  const rg::RenderTarget& src = *call.source;
  const std::optional<TexelFormat> tf = texel_format_of(src.format);
  if (!tf || src.samples != 1) return decline("native-plugin-format", "unsupported chain buffer for \"" + matchName + "\"");
  const std::uint32_t w = src.width;
  const std::uint32_t h = src.height;
  rg::RenderTarget* dest = ctx.target(call.dest);
  if (dest == nullptr || dest->width != w || dest->height != h || dest->format != src.format) {
    return decline("native-plugin-target", "no free chain target for \"" + matchName + "\"");
  }

  RenderInputs in;
  decode_native_fx(*call.effect, *spec, in);
  in.worldW = static_cast<std::int32_t>(w);
  in.worldH = static_cast<std::int32_t>(h);
  in.projectBits = project_bits_of(*tf);
  in.layerToWorld = layer_to_world(ctx, call, in, w, h);
  in.compToWorld = comp_to_world(ctx, call, in, w, h);

  // SDK 1.2 (S6): the comp's other 3D layers' depth in this world — made only when the effect asks.
  const bool usesDepth = spec->has(PR_OUT_FLAG_USES_SCENE_DEPTH);
  const rg::SceneDepth::Request depthReq{w, h, in.compToWorld, call.selfId};
  // SDK 1.2: the same depth with the 3D layers and camera posed at a checked-out sample.
  const auto depthReqAt = [&](const TimeSample& s) {
    rg::SceneDepth::Request q = depthReq;
    q.poseKey = s.time;
    q.camera = s.depth && s.depth->camera ? &*s.depth->camera : nullptr;
    q.models = s.depth ? &s.depth->models : nullptr;
    return q;
  };

  rg::Device& dev = ctx.dev;
  if (dev.device().Get() != device_.Get()) {
    // Another device: the plugins' per-device data (pipelines, buffers, a
    // reference on the old device) and the glue's own textures belong to the
    // old one. Set them down; GPU_DEVICE_SETUP runs again on first use.
    if (device_ != nullptr) {
      host->gpu_device_gone(deviceIndex_);
      ++stats_.deviceResets;
    }
    textures_.clear();
    assets_.clear();
    device_ = dev.device();
    deviceIndex_ = g_nextDeviceIndex.fetch_add(1, std::memory_order_relaxed);
  }

  // ── GPU: the effect records into the engine's own device ──
  if (gpuEnabled_ && spec->has(PR_OUT_FLAG_GPU_RENDER) && !host->out_of_process(matchName)) {  // X: the child has no GPU
    std::vector<CheckoutRequest> reqs;
    const CallResult pre = host->pre_render(in, reqs);
    if (pre.fault) return decline("native-plugin-crash", matchName + ": " + pre.message);
    if (!pre.ok && !pre.skipped) return decline("native-plugin-failed", matchName + ": " + pre.message);
    const OwnTexture& out = own(dev, w, h, src.format, kGpuOutputSlot);
    PrGpuDeviceInfo info{};
    info.struct_size = sizeof(PrGpuDeviceInfo);
    info.framework = PR_GPU_FRAMEWORK_WEBGPU_DAWN;
    info.device_index = deviceIndex_;
    info.procs = &dawn::native::GetProcs();
    info.wgpu_instance = dev.instance().Get();
    const wgpu::Adapter adapter = dev.device().GetAdapter();
    info.wgpu_adapter = adapter.Get();
    info.wgpu_device = dev.device().Get();
    info.wgpu_queue = dev.queue().Get();
    wgpu::AdapterInfo ai{};
    if (adapter != nullptr && adapter.GetInfo(&ai)) info.backend = backend_of(ai.backendType);
    info.float32_filterable = dev.device().HasFeature(wgpu::FeatureName::Float32Filterable) ? 1 : 0;
    const auto world = [&](const wgpu::Texture& t, const wgpu::TextureView& v) {
      return PrGpuWorld{sizeof(PrGpuWorld), static_cast<std::int32_t>(w), static_cast<std::int32_t>(h), gpu_format_of(*tf), t.Get(), v.Get(),
                        nullptr};
    };
    const PrGpuWorld inWorld = world(src.texture, src.view);
    const PrGpuWorld outWorld = world(out.texture, out.view);
    PrGpuWorld depthWorld{};
    std::map<std::int64_t, PrGpuWorld> depthAtWorlds;  // per sample time: stable while the effect renders
    const auto depthGpu = [](const rg::SceneDepth::Result& d) {
      return PrGpuWorld{sizeof(PrGpuWorld), static_cast<std::int32_t>(d.width), static_cast<std::int32_t>(d.height),
                        PR_GPU_FORMAT_R32_FLOAT, d.texture.Get(), d.view.Get(), nullptr};
    };
    GpuCheckouts io([this, &dev](const std::string& key, const AssetImage& image) { return asset_texture(dev, key, image); },
                    [&]() -> const PrGpuWorld* {
                      const rg::SceneDepth::Result* d = usesDepth ? sceneDepth_.render(ctx, depthReq) : nullptr;
                      if (d == nullptr) return nullptr;
                      depthWorld = depthGpu(*d);
                      return &depthWorld;
                    },
                    [&](const TimeSample& s) -> const PrGpuWorld* {
                      const rg::SceneDepth::Result* d = usesDepth ? sceneDepth_.render(ctx, depthReqAt(s)) : nullptr;
                      if (d == nullptr) return nullptr;
                      return &(depthAtWorlds[s.time] = depthGpu(*d));
                    });
    for (std::uint32_t i = 0; i < reqs.size(); ++i) {
      const CheckoutRequest& c = reqs[i];
      if (c.paramIndex == 0 && c.time == in.layerTime) {
        io.set(c.id, inWorld);
        continue;
      }
      const rg::TexRef tex = checkout_texture(ctx, call, in, c);
      if (!tex) continue;
      // Through the free target (the chain buffer's size and space), then into
      // a texture of the checkout's own: the next checkout reuses the target.
      draw_full(ctx, call.dest, tex);
      const OwnTexture& held = own(dev, w, h, src.format, kFirstCheckoutSlot + i);
      wgpu::TexelCopyTextureInfo from{};
      from.texture = dest->texture;
      wgpu::TexelCopyTextureInfo to{};
      to.texture = held.texture;
      const wgpu::Extent3D size{w, h, 1};
      dev.encoder().CopyTextureToTexture(&from, &to, &size);
      io.set(c.id, world(held.texture, held.view));
    }
    dev.flush();  // the chain so far (and the checkouts) run before the plugin's commands
    wgpu::CommandEncoder enc = dev.device().CreateCommandEncoder();
    dev.device().PushErrorScope(wgpu::ErrorFilter::OutOfMemory);
    dev.device().PushErrorScope(wgpu::ErrorFilter::Validation);
    const CallResult r = host->render_gpu(in, io, info, enc.Get(), inWorld, outWorld);
    wgpu::CommandBuffer cb;
    if (r.ok) cb = enc.Finish();
    const std::string validation = pop_scope(dev);
    const std::string oom = pop_scope(dev);
    if (r.ok && validation.empty() && oom.empty()) {
      dev.queue().Submit(1, &cb);
      draw_full(ctx, call.dest, rg::TexRef{out.view, out.id, w, h, true, 0, 0});
      ++stats_.gpu;
      return true;
    }
    if (r.fault) return decline("native-plugin-crash", matchName + ": " + r.message);
    if (!r.ok && !r.skipped) return decline("native-plugin-failed", matchName + ": " + r.message);
    if (!validation.empty() || !oom.empty()) {
      // Never submitted. The CPU path below still renders the frame.
      ctx.diagnostics.push_back({"native-plugin-gpu-error", matchName + ": " + (validation.empty() ? oom : validation)});
      ++stats_.gpuErrors;
    }
  }

  // ── CPU: read back, render, upload ──
  std::string error;
  TexelImage input;
  if (!read_back(dev, src.texture, w, h, *tf, input, error)) return decline("native-plugin-readback", error);
  std::deque<TexelImage> held;  // checkouts stay alive for the render (stable addresses)
  const CheckoutImageFn checkout = [&](const CheckoutRequest& c) -> const TexelImage* {
    const rg::TexRef tex = checkout_texture(ctx, call, in, c);
    if (!tex) return nullptr;
    // Through the free target, so its pixels land at the chain buffer's size and space.
    draw_full(ctx, call.dest, tex);
    TexelImage img;
    if (!read_back(dev, dest->texture, w, h, *tf, img, error)) return nullptr;
    held.push_back(std::move(img));
    return &held.back();
  };
  TexelImage out;
  const TexelCheckouts::DepthFn depth = [&]() { return usesDepth ? sceneDepth_.read_back(ctx, depthReq) : nullptr; };
  const TexelCheckouts::DepthAtFn depthAt = [&](const TimeSample& s) {
    return usesDepth ? sceneDepth_.read_back(ctx, depthReqAt(s)) : nullptr;
  };
  const CallResult r = run_native_cpu(*host, in, input, checkout, out, depth, depthAt);
  if (!r.ok) return decline(r.fault ? "native-plugin-crash" : "native-plugin-failed", matchName + ": " + r.message);
  const OwnTexture& up = own(dev, w, h, src.format, kUploadSlot);
  wgpu::TexelCopyTextureInfo dst{};
  dst.texture = up.texture;
  wgpu::TexelCopyBufferLayout layout{};
  layout.bytesPerRow = w * texel_bytes(*tf);
  layout.rowsPerImage = h;
  const wgpu::Extent3D size{w, h, 1};
  dev.queue().WriteTexture(&dst, out.bytes.data(), out.bytes.size(), &layout, &size);
  draw_full(ctx, call.dest, rg::TexRef{up.view, up.id, w, h, true, 0, 0});
  ++stats_.cpu;
  return true;
}

}  // namespace premation::plugins
