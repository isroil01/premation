// Shared between the raster module's FFI translation units ONLY (fonts_ffi.cpp,
// canvas_ffi.cpp): the Skia side of a FontSet. Never include this from a non-FFI
// file — the native rule keeps Skia / HarfBuzz / FreeType behind *_ffi.cpp.
#pragma once

#include <span>

#include "fonts.hpp"

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#endif
#include "include/core/SkFont.h"
#include "include/core/SkFontMetrics.h"
#include "include/core/SkRefCnt.h"
#include "include/core/SkTypeface.h"
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

namespace premation::raster::ffi {

/// The typeface for a registered face with variation axes applied (cached).
[[nodiscard]] sk_sp<SkTypeface> typeface_for(const FontSet& fonts, int face, std::span<const AxisValue> axes);

/// The SkFont Blink would build for a face at a size (hinting, edging, subpixel).
[[nodiscard]] SkFont sk_font_for(const FontSet& fonts, int face, std::span<const AxisValue> axes, double sizePx,
                                 bool fakeBold, bool fakeItalic);

}  // namespace premation::raster::ffi
