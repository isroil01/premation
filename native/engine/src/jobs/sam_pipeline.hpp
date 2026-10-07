// SAM (SlimSAM, the transformers.js export layout) pre- and post-processing —
// the port of src/core/tracking/samPipeline.ts, the neural half of
// samSegment.ts `segmentSam` (the box constraint) and the matte → contour
// step of objectMask.ts. Pure: no ONNX Runtime (sam_ort.hpp runs the models),
// no ffmpeg, no document — tests/test_jobs_trace.cpp checks it on synthetic
// tensors.
//
//   vision_encoder:  pixel_values [1,3,1024,1024] f32 → image_embeddings,
//                    image_positional_embeddings (both [1,256,64,64])
//   decoder:         input_points [1,1,N,2] f32 (RESIZED-image coords),
//                    input_labels [1,1,N] i64 (1 fg, 0 bg), the two embeddings
//                    → iou_scores [1,1,3], pred_masks [1,1,3,256,256] (logits)
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

#include "trace_bitmap.hpp"

namespace premation::jobs::sam {

/// SAM's fixed encoder input edge.
inline constexpr std::uint32_t kInputSize = 1024;
/// The decoder's fixed low-res mask edge (kInputSize / 4).
inline constexpr std::uint32_t kMaskSize = 256;
inline constexpr std::array<double, 3> kMean{0.485, 0.456, 0.406};
inline constexpr std::array<double, 3> kStd{0.229, 0.224, 0.225};

/// How a w×h frame lands inside the 1024² encoder input (samPipeline.ts `samLetterbox`).
struct Letterbox {
  double scale = 1;
  std::uint32_t resizedW = 0;
  std::uint32_t resizedH = 0;
};
[[nodiscard]] Letterbox letterbox(std::uint32_t width, std::uint32_t height) noexcept;

/// Straight RGBA8 → normalized NCHW planes in the zero-padded 1024² square
/// (samPipeline.ts `preprocessForSam`: nearest-neighbour, ImageNet mean/std,
/// padding 0 AFTER normalization). 3·1024·1024 floats.
[[nodiscard]] std::vector<float> preprocess(std::span<const std::uint8_t> rgba, std::uint32_t width,
                                            std::uint32_t height);

struct Point {
  double x = 0;
  double y = 0;
  /// 1 = foreground, 0 = background.
  int label = 1;
};
struct Box {
  double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
};

struct Prompts {
  std::vector<float> coords;  ///< x0, y0, x1, y1 … in resized-image pixels
  std::vector<std::int64_t> labels;
  [[nodiscard]] std::size_t count() const noexcept { return labels.size(); }
};

/// samPipeline.ts `promptsForSam`: points × scale (label 1 stays 1, anything
/// else 0); a box only when there are no points, as its centre, label 1.
/// Nullopt when there is nothing to prompt with.
[[nodiscard]] std::optional<Prompts> prompts_for(std::span<const Point> points, const std::optional<Box>& box,
                                                 double scale);

/// The candidate the model scores highest (first on a tie).
[[nodiscard]] std::size_t best_mask(std::span<const float> iouScores) noexcept;

/// samPipeline.ts `upsampleSamMask`: one 256² logit plane (at `offset` in
/// `logits`) → a w×h 0/255 mask, bilinear in logit space, threshold > 0.
[[nodiscard]] std::vector<std::uint8_t> upsample_mask(std::span<const float> logits, std::size_t offset,
                                                      std::uint32_t width, std::uint32_t height, double scale);

/// samSegment.ts: a box prompt's constraint half — zero everything outside the
/// box grown by 8% of its size + 4 px.
void constrain_to_box(std::vector<std::uint8_t>& mask, std::uint32_t width, std::uint32_t height, const Box& box);

/// The decoder's outputs → the frame mask: best candidate, upsampled,
/// box-constrained. Empty when the outputs are not the shapes SAM answers.
[[nodiscard]] std::vector<std::uint8_t> mask_from_decoder(std::span<const float> iouScores,
                                                          std::span<const float> predMasks, std::uint32_t width,
                                                          std::uint32_t height, const std::optional<Box>& box);

/// objectMask.ts's cap on the written path's vertices (Track mask tracks at most 64).
inline constexpr std::size_t kMaxContourPoints = 48;

/// The matte as ONE outline in frame pixels: the traced outer contour with
/// the largest area (trace_bitmap.hpp, threshold 128, tolerance 1, min area 4),
/// decimated by stride to at most `maxPoints` (objectMask.ts: kMaxContourPoints).
/// The points walk the contour in order, so the path never zigzags. Empty when
/// the matte holds nothing.
[[nodiscard]] std::vector<trace::TracePoint> matte_contour(std::span<const std::uint8_t> mask, std::uint32_t width,
                                                           std::uint32_t height,
                                                           std::size_t maxPoints = kMaxContourPoints);

}  // namespace premation::jobs::sam
