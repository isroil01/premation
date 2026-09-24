/*
 * Premation native plugin SDK — pixel worlds (CPU images).
 *
 * A world is a rectangle of RGBA pixels the host owns. Pixels are
 * PREMULTIPLIED, in the project's LINEAR working space (the engine composites
 * in linear light, After Effects' "linearize working space" always on), rows
 * top-down, `row_bytes` apart (≥ width × bytes-per-pixel; may be padded).
 *
 * The depth follows the project's bit depth (Project Settings ▸ Color ▸ Depth)
 * and what the effect declared it can process:
 *
 *   PR_PIXEL_FORMAT_RGBA8     4 × uint8   0..255
 *   PR_PIXEL_FORMAT_RGBA16    4 × uint16  0..65535 (full range; values clamp to 0..1)
 *   PR_PIXEL_FORMAT_RGBA32F   4 × float   unclamped scene-linear (over-range kept)
 *
 * A 32-bit project hands an effect that is not PR_OUT_FLAG_FLOAT_COLOR_AWARE a
 * 16-bit world (or 8-bit if it is not PR_OUT_FLAG_DEEP_COLOR_AWARE either),
 * converting both ways, as After Effects does.
 *
 * Channel order is R, G, B, A (NOT After Effects' A, R, G, B).
 */
#ifndef PREMATION_SDK_PR_WORLD_H
#define PREMATION_SDK_PR_WORLD_H

#include "pr_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef int32_t PrPixelFormat;
#define PR_PIXEL_FORMAT_RGBA8 0
#define PR_PIXEL_FORMAT_RGBA16 1
#define PR_PIXEL_FORMAT_RGBA32F 2

#define PR_MAX_CHANNEL8 255
#define PR_MAX_CHANNEL16 65535

typedef struct PrPixel8 {
  uint8_t r, g, b, a;
} PrPixel8;
typedef struct PrPixel16 {
  uint16_t r, g, b, a;
} PrPixel16;
typedef struct PrPixel32 {
  float r, g, b, a;
} PrPixel32;

typedef struct PrWorld {
  uint32_t struct_size;
  int32_t width;
  int32_t height;
  int32_t row_bytes;
  PrPixelFormat format;
  uint32_t flags; /* reserved, 0 */
  void* data;     /* first byte of the top row */
  /** Where this world sits in the effect's coordinate space (world pixels): its
   *  (0,0) pixel is at (origin_x, origin_y). 0,0 for full-frame worlds. */
  int32_t origin_x;
  int32_t origin_y;
} PrWorld;

/** Bytes per pixel of a format (4, 8 or 16). */
static inline int32_t pr_bytes_per_pixel(PrPixelFormat f) {
  return f == PR_PIXEL_FORMAT_RGBA32F ? 16 : f == PR_PIXEL_FORMAT_RGBA16 ? 8 : 4;
}

/** Row `y` of a world (no bounds check). */
static inline void* pr_world_row(const PrWorld* w, int32_t y) {
  return (void*)((uint8_t*)w->data + (ptrdiff_t)y * w->row_bytes);
}

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_WORLD_H */
