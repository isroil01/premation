#include "cpu_render.hpp"

#include <utility>

namespace premation::plugins {

TexelCheckouts::TexelCheckouts(PrPixelFormat format, std::uint32_t width, std::uint32_t height)
    : format_(format), width_(width), height_(height) {
  outBytes_.assign(std::size_t{width} * height * static_cast<std::size_t>(pr_bytes_per_pixel(format)), 0);
  output_ = make_world(outBytes_);
}

PrWorld TexelCheckouts::make_world(std::vector<std::uint8_t>& bytes) const {
  PrWorld w{};
  w.struct_size = sizeof(PrWorld);
  w.width = static_cast<std::int32_t>(width_);
  w.height = static_cast<std::int32_t>(height_);
  w.row_bytes = static_cast<std::int32_t>(width_) * pr_bytes_per_pixel(format_);
  w.format = format_;
  w.data = bytes.data();
  return w;
}

void TexelCheckouts::set(std::uint32_t checkoutId, const TexelImage& image) {
  Slot& s = slots_[checkoutId];
  if (image.width != width_ || image.height != height_) {
    // A checkout of another size is placed at the world's origin, clipped /
    // padded transparent: every world of one render shares the output's size.
    const std::size_t tb = texel_bytes(image.format);
    std::vector<std::uint8_t> fitted(std::size_t{width_} * height_ * tb, 0);
    const std::uint32_t cw = std::min(width_, image.width);
    const std::uint32_t ch = std::min(height_, image.height);
    for (std::uint32_t y = 0; y < ch; ++y) {
      std::copy_n(image.bytes.begin() + static_cast<std::ptrdiff_t>(std::size_t{y} * image.width * tb), std::size_t{cw} * tb,
                  fitted.begin() + static_cast<std::ptrdiff_t>(std::size_t{y} * width_ * tb));
    }
    texels_to_world(fitted, image.format, width_, height_, std::size_t{width_} * tb, format_, s.bytes);
  } else {
    texels_to_world(image.bytes, image.format, width_, height_, std::size_t{width_} * texel_bytes(image.format), format_, s.bytes);
  }
  s.world = make_world(s.bytes);
}

PrWorld* TexelCheckouts::cpu_checkout(std::uint32_t checkoutId) {
  const auto it = slots_.find(checkoutId);
  return it == slots_.end() ? nullptr : &it->second.world;
}

PrWorld* TexelCheckouts::cpu_output() { return &output_; }

RenderInputs default_inputs(const EffectSpec& spec, std::string instance, std::uint32_t w, std::uint32_t h,
                            std::uint32_t projectBits) {
  RenderInputs in;
  in.matchName = spec.matchName;
  in.layerId = instance.substr(0, instance.find('/'));
  in.instance = std::move(instance);
  in.values.resize(spec.params.size());
  for (std::size_t i = 0; i < spec.params.size(); ++i) in.values[i].v = spec.params[i].def;
  in.fps = 30;
  in.timeStep = PR_TIME_SCALE / 30;
  in.layerW = static_cast<std::int32_t>(w);
  in.layerH = static_cast<std::int32_t>(h);
  in.worldW = static_cast<std::int32_t>(w);
  in.worldH = static_cast<std::int32_t>(h);
  in.projectBits = projectBits;
  return in;
}

int param_slot(const EffectSpec& spec, std::uint32_t id) noexcept {
  for (std::size_t i = 0; i < spec.params.size(); ++i) {
    if (spec.params[i].id == id) return static_cast<int>(i);
  }
  return -1;
}

CallResult run_native_cpu(PluginHost& host, const RenderInputs& in, const TexelImage& input, const CheckoutImageFn& checkout,
                          TexelImage& out) {
  CallResult r;
  const EffectSpec* spec = host.effect(in.matchName);
  if (spec == nullptr) {
    r.skipped = true;
    r.message = "no loaded plugin provides '" + in.matchName + "'";
    return r;
  }
  std::vector<CheckoutRequest> reqs;
  r = host.pre_render(in, reqs);
  if (!r.ok) return r;
  const PrPixelFormat wf = PluginHost::world_format(*spec, in.projectBits);
  TexelCheckouts io(wf, input.width, input.height);
  for (const CheckoutRequest& c : reqs) {
    // The input at the frame's own time needs no round trip through the caller.
    if (c.paramIndex == 0 && c.time == in.layerTime) {
      io.set(c.id, input);
      continue;
    }
    if (const TexelImage* img = checkout ? checkout(c) : nullptr) io.set(c.id, *img);
  }
  r = host.render_cpu(in, io, wf);
  if (!r.ok) return r;
  out.format = input.format;
  out.width = input.width;
  out.height = input.height;
  world_to_texels(io.output(), input.format, out.bytes);
  return r;
}

}  // namespace premation::plugins
