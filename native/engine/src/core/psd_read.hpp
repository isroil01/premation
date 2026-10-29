// Photoshop documents (.psd, and .psb "large document format") read for AE's
// two PSD imports: Footage (the merged image) and Composition – Retain Layer
// Sizes (one layer per Photoshop layer, groups as nested compositions).
//
// What is read: RGB, Grayscale and CMYK at 8 / 16 / 32 bits per channel; raw,
// RLE (PackBits) and ZIP (with or without prediction) channel data; layer
// rectangles, names (Unicode when present), opacity × fill opacity, blend
// mode, visibility, clipping, user (pixel) masks — baked into the alpha, as a
// mask's pixels are — and the group structure. Layer effects, adjustment
// layers (no pixels), vector masks and text stay as Photoshop rendered them
// into the layer's pixels, or are left out and counted (`skipped`).
//
// Pure: bytes in, straight RGBA8 out. ZIP data inflates through core/deflate.
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace premation::doc::psd {

struct Layer {
  std::string name;
  /// Document-space rectangle (pixels may extend past the canvas).
  int left = 0;
  int top = 0;
  int width = 0;
  int height = 0;
  /// Layer opacity × fill opacity, 0–255.
  int opacity = 255;
  /// The four-character blend key (`norm`, `mul `, `pass` …).
  std::string blend = "norm";
  bool visible = true;
  /// Clipped to the layer below (a clipping mask).
  bool clipped = false;
  /// Straight RGBA8, width × height × 4, rows top-down (empty for a group).
  std::vector<std::uint8_t> rgba;
  /// A group: its children, bottom to top. `isGroup` with no children is an empty group.
  bool isGroup = false;
  std::vector<Layer> children;
};

struct Document {
  int width = 0;
  int height = 0;
  int depth = 8;
  /// 1 grayscale, 3 RGB, 4 CMYK.
  int colorMode = 3;
  /// The tree, bottom to top (Photoshop's file order).
  std::vector<Layer> layers;
  /// The merged image (straight RGBA8), when the file carries one.
  std::vector<std::uint8_t> composite;
  /// Layers that carry no pixels to import (adjustment / fill layers without a
  /// raster, empty layers).
  int skipped = 0;
};

/// Parse a PSD / PSB. `withLayers` false reads only the header and the merged image.
[[nodiscard]] std::optional<Document> read(std::span<const std::uint8_t> file, bool withLayers, std::string& error);

/// AE's blend mode name for a Photoshop blend key (`pass` → normal: a
/// pass-through group becomes a composition, which composites as Normal).
[[nodiscard]] std::string blend_mode_of(std::string_view key);

/// A straight-RGBA8 image as a PNG file (8-bit RGBA, zlib level 6).
[[nodiscard]] bool encode_png(std::span<const std::uint8_t> rgba, int width, int height, std::vector<std::uint8_t>& out);

}  // namespace premation::doc::psd
