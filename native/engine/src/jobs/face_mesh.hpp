// Face tracking's arithmetic (AE parity 3.3) — no model, no ffmpeg.
//
// The landmark model is MediaPipe Face Mesh class (468 points; 478 with the
// irises): a square, upright crop of the face in, landmarks in crop pixels
// out. Tracking feeds each frame the crop the previous frame's landmarks
// define (the face box grown 1.6×, turned so the eyes are level), the first
// frame the crop of the user's mask around the face — AE's workflow: draw a
// mask around the face, then Face Tracking.
//
// The index sets are MediaPipe's FACEMESH_* connections walked as loops.
// Landmarks are smoothed with a One Euro filter so a still face does not
// jitter and a moving one does not lag. Pure.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace premation::jobs::face {

struct P2 {
  double x = 0;
  double y = 0;
};

inline constexpr int kInput = 192;
inline constexpr std::size_t kLandmarks = 468;

/// The face outline, a closed loop.
inline constexpr std::array<int, 36> kFaceOval{10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
                                               152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109};
/// The subject's left eye (image right) and right eye (image left), closed loops.
inline constexpr std::array<int, 16> kLeftEye{263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466};
inline constexpr std::array<int, 16> kRightEye{33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246};
inline constexpr std::array<int, 10> kLeftBrow{300, 293, 334, 296, 336, 285, 295, 282, 283, 276};
inline constexpr std::array<int, 10> kRightBrow{70, 63, 105, 66, 107, 55, 65, 52, 53, 46};
inline constexpr std::array<int, 20> kLipsOuter{61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185};
inline constexpr int kNoseTip = 1;
inline constexpr int kChin = 152;
inline constexpr int kMouthRight = 61;   ///< the subject's right corner
inline constexpr int kMouthLeft = 291;
inline constexpr int kRightIris = 468;   ///< only with the 478-point model
inline constexpr int kLeftIris = 473;

/// A rotated square in frame pixels: centre, side, angle (radians, y down).
struct Roi {
  P2 centre;
  double side = 0;
  double angle = 0;
};

/// The crop of a frame for `roi`, RGBA8 → kInput² RGB floats in [0, 1]
/// (NHWC, or NCHW when `planar`). Outside the frame is black.
[[nodiscard]] std::vector<float> crop(std::span<const std::uint8_t> rgba, int width, int height, const Roi& roi, bool planar);

/// Crop px (0…kInput) → frame px.
[[nodiscard]] P2 crop_to_frame(const Roi& roi, P2 c) noexcept;

/// The upright face box from a mask outline (frame px): its bounds grown 1.25×, no rotation.
[[nodiscard]] Roi roi_from_outline(std::span<const P2> outline);

/// The next frame's crop from this frame's landmarks: their bounds grown 1.6×, turned so the eyes are level.
[[nodiscard]] Roi roi_from_landmarks(std::span<const P2> lm);

/// The centre of a loop of landmarks.
[[nodiscard]] P2 centre_of(std::span<const P2> lm, std::span<const int> loop);

/// One Euro filter over 2D points (Casiez et al.): `minCutoff` Hz, `beta` speed coefficient.
class OneEuro {
 public:
  OneEuro(double minCutoff = 1.0, double beta = 0.05, double dCutoff = 1.0) : minCutoff_(minCutoff), beta_(beta), dCutoff_(dCutoff) {}
  /// Filter `x` sampled `dt` seconds after the previous sample (resets on dt ≤ 0).
  [[nodiscard]] std::vector<P2> filter(std::span<const P2> x, double dt);
  void reset() { prev_.clear(); }

 private:
  double minCutoff_;
  double beta_;
  double dCutoff_;
  std::vector<P2> prev_;
  std::vector<P2> dPrev_;
};

}  // namespace premation::jobs::face
