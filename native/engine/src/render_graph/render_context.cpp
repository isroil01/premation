#include "render_context.hpp"

#include <cmath>

#include "color/color_system.hpp"

namespace premation::rg {

bool decode_frame_file(std::span<const std::uint8_t> bytes, api::RenderFrameFile& out, std::string& error) {
  wire::Reader r(bytes);
  const wire::Status s = api::decode(r, out);
  if (s != wire::Status::ok) {
    error = std::string("RenderFrameFile: ") + std::string(wire::to_string(s));
    return false;
  }
  return true;
}

void TextureTable::build(const api::RenderFrameFile& file) {
  byKey_.clear();
  std::unordered_map<std::string_view, const api::RenderBlob*> byHash;
  for (const auto& b : file.blobs) byHash.emplace(b.hash, &b);
  for (const auto& t : file.textures) {
    ResolvedBlob rb;
    const auto it = byHash.find(t.hash);
    if (!t.hash.empty() && it != byHash.end()) rb.blob = it->second;
    rb.sampleLinear = t.sample_linear;
    rb.ready = t.ready;
    rb.inputSpace = t.input_space;
    byKey_.emplace(t.key, rb);
  }
}

ResolvedBlob TextureTable::resolve(std::string_view key) const {
  const auto it = byKey_.find(key);
  return it == byKey_.end() ? ResolvedBlob{} : it->second;
}

ViewportState ViewportState::from(const api::RenderView& v) noexcept {
  ViewportState s;
  s.cssWidth = std::max(1.0, v.css_width);
  s.cssHeight = std::max(1.0, v.css_height);
  s.dpr = v.device_pixel_ratio;
  s.centerX = v.camera_center_x;
  s.centerY = v.camera_center_y;
  s.zoom = v.camera_zoom;
  // Viewport.pixelSize: Math.round(css × dpr).
  s.pixelWidth = static_cast<std::uint32_t>(std::max(1.0, std::floor(s.cssWidth * s.dpr + 0.5)));
  s.pixelHeight = static_cast<std::uint32_t>(std::max(1.0, std::floor(s.cssHeight * s.dpr + 0.5)));
  // Camera2D.viewProjectionMatrix: ortho(-w/2, w/2, h/2, -h/2) · scale(zoom) · translate(-center).
  const Mat3 proj = ortho(-s.cssWidth / 2, s.cssWidth / 2, s.cssHeight / 2, -s.cssHeight / 2);
  const Mat3 view = mul(scaling(s.zoom, s.zoom), translation(-s.centerX, -s.centerY));
  s.viewProjection = mul(proj, view);
  // visibleWorldRect via screenToWorld of the two corners.
  const double tlx = s.centerX + (0 - s.cssWidth / 2) / s.zoom;
  const double tly = s.centerY + (0 - s.cssHeight / 2) / s.zoom;
  const double brx = s.centerX + (s.cssWidth - s.cssWidth / 2) / s.zoom;
  const double bry = s.centerY + (s.cssHeight - s.cssHeight / 2) / s.zoom;
  s.visibleWorldRect = {tlx, tly, brx - tlx, bry - tly};
  return s;
}

namespace {
wgpu::TextureFormat blob_format(api::RenderTextureFormat f) {
  switch (f) {
    case api::RenderTextureFormat::rgba16float: return wgpu::TextureFormat::RGBA16Float;
    case api::RenderTextureFormat::rgba32float: return wgpu::TextureFormat::RGBA32Float;
    case api::RenderTextureFormat::bgra8unorm: return wgpu::TextureFormat::BGRA8Unorm;
    case api::RenderTextureFormat::rgba8unorm_srgb: return wgpu::TextureFormat::RGBA8UnormSrgb;
    case api::RenderTextureFormat::r8unorm: return wgpu::TextureFormat::R8Unorm;
    default: return wgpu::TextureFormat::RGBA8Unorm;
  }
}
}  // namespace

TexRef PassContext::texture(std::string_view key) {
  const ResolvedBlob rb = textures.resolve(key);
  if (rb.blob == nullptr) return {};
  const api::RenderBlob& b = *rb.blob;
  TexRef t = dev.texture(b.hash, b.width, b.height, blob_format(b.format), b.pixels, b.mipmapped);
  t.sampleLinear = rb.sampleLinear;
  // D3: a colour texture under colour management is sampled as its working-
  // space conversion (made once per content + interpretation), already linear.
  if (colorSystem != nullptr && colorSystem->active() && rb.inputSpace) return colorSystem->input(t, b.hash, *rb.inputSpace);
  return t;
}

void PassContext::draw_into(std::string_view name, const Commands& cmds, bool clear, const Color& clearColor) {
  draw_into_sized(name, cmds, clear, viewport.pixelWidth, viewport.pixelHeight);
  (void)clearColor;
}

void PassContext::draw_into_sized(std::string_view name, const Commands& cmds, bool clear, std::uint32_t w,
                                  std::uint32_t h) {
  RenderTarget* t = target(name);
  Attachment att;
  att.target = t;
  att.clear = clear;
  const bool toSurface = t == nullptr;
  wgpu::RenderPassEncoder pass =
      dev.begin_pass(att, w, h, surfaceView, surfaceFormat, toSurface && surfaceScissor ? &*surfaceScissor : nullptr, false);
  if (!cmds.empty()) dev.execute(pass, cmds, toSurface ? surfaceFormat : t->format, toSurface ? 1 : t->samples);
  pass.End();
}

}  // namespace premation::rg
