#include "kernel_dispatch.hpp"

#include <array>

namespace premation::effects {

namespace {

constexpr std::array<std::string_view, 19> kPorted{
    "gaussian-blur", "fast-box-blur", "radial-blur",    "channel-blur", "unsharp-mask",   "sharpen",   "noise",
    "add-grain",     "turbulent-noise", "median",       "minimax",      "simple-choker",  "mosaic",    "find-edges",
    "emboss",        "vibrance",      "bilateral-blur", "smart-blur",   "camera-lens-blur",
};

}  // namespace

std::span<const std::string_view> ported_kernels() noexcept { return kPorted; }

bool run_kernel(std::string_view type, const KernelArgs& a, RgbaView img, ThreadPool* pool) {
  const auto b = [&](std::string_view k, bool def) { return a(k, def ? 1 : 0) != 0; };
  if (type == "gaussian-blur" || type == "fast-box-blur") {
    // applyGaussianBlur fixes iterations at 3; Fast Box Blur exposes it.
    blur_rgba(img, a("radius", 0), blur_dims(a("dimensions", 0)),
              type == "gaussian-blur" ? 3 : a("iterations", 1), b("repeatEdge", true), pool);
  } else if (type == "radial-blur") {
    radial_blur(img, a("amount", 0), a("centerX", img.w / 2.0), a("centerY", img.h / 2.0), a("zoom", 0) != 0,
                a("quality", 8), pool);
  } else if (type == "channel-blur") {
    channel_blur(img, a("red", 0), a("green", 0), a("blue", 0), a("alpha", 0), blur_dims(a("dimensions", 0)),
                 b("repeatEdge", true), pool);
  } else if (type == "unsharp-mask") {
    unsharp_mask(img, a("amount", 0), a("radius", 0), a("threshold", 0), pool);
  } else if (type == "sharpen") {
    sharpen(img, a("amount", 0), pool);
  } else if (type == "noise") {
    add_noise(img, a("amount", 0), a("evolution", 0), b("mono", true), pool);
  } else if (type == "add-grain") {
    add_grain(img, a("intensity", 0), a("size", 1), a("saturation", 0), a("seed", 0), pool);
  } else if (type == "turbulent-noise") {
    turbulent_noise(img, a("scale", 100), a("complexity", 4), a("evolution", 0), a("contrast", 100),
                    a("brightness", 0), b("invert", false), pool);
  } else if (type == "median") {
    median(img, a("radius", 0), pool);
  } else if (type == "minimax") {
    minimax(img, minimax_op(a("op", 0)), a("radius", 0), minimax_channel(a("channel", 0)),
            blur_dims(a("direction", 0)), pool);
  } else if (type == "simple-choker") {
    simple_choker(img, a("chokePx", 0), pool);
  } else if (type == "mosaic") {
    mosaic(img, a("hBlocks", 10), a("vBlocks", 10), b("sharpColors", false), pool);
  } else if (type == "find-edges") {
    find_edges(img, b("invert", true), pool);
  } else if (type == "emboss") {
    emboss(img, a("angleDeg", 45), a("relief", 1), a("contrast", 100), a("blend", 0), pool);
  } else if (type == "vibrance") {
    vibrance(img, a("vibrance", 0), a("saturation", 0), pool);
  } else if (type == "bilateral-blur") {
    bilateral_blur(img, a("radius", 0), a("colorSigma", 30), b("preserveAlpha", false), pool);
  } else if (type == "smart-blur") {
    smart_blur(img, a("radius", 0), a("threshold", 0), a("mode", 0), pool);
  } else if (type == "camera-lens-blur") {
    camera_lens_blur(img, a("radius", 0), a("blades", 0), a("rotation", 0), a("gain", 1), a("threshold", 100), pool);
  } else {
    return false;
  }
  return true;
}

}  // namespace premation::effects
