// The point tracker's walk over a footage layer (trackVideoLayer.ts
// trackVideoLayerPoints + autoTrack.ts runAutoTrack's both-ways walk), shared
// by the trackMotion kinds (position … corner, mask, planar): the range's
// DISTINCT source frames decoded as luma (the decoder's Y bytes when it has
// them, lumaExtract.ts 'raw8'; else lumaFromRGBA), the points walked through
// tracking.hpp, and the samples read out per composition frame
// (`readOutCompSamples`: a comp frame whose source frame was never reached is
// dropped). Points, window sizes and samples are layer (source display)
// pixels; windows convert to decoded pixels by the geometric mean and are then
// ROUNDED to whole pixels (the TS relies on them being whole).
//
// Pure over a FrameSource (media_input.hpp): no ffmpeg, no document.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "job_api.hpp"
#include "planar_track.hpp"
#include "job_inputs.hpp"
#include "media_input.hpp"
#include "track_frames.hpp"
#include "track_plans.hpp"

namespace premation::jobs::trackwalk {

/// One point: its centre and window half-sizes, source display px.
struct WalkPoint {
  double x = 0;
  double y = 0;
  double featureHalf = 10;
  double searchHalf = 24;
};

struct WalkSpec {
  FootageLayer fl;
  trackframes::CompFrames frames;
  /// The comp frame the points' positions are given at.
  std::int64_t origin = 0;
  api::TrackDirection direction = api::TrackDirection::forward;
  double fps = 30;
  std::vector<WalkPoint> points;
  double minConfidence = 0.55;
  int maxCoast = 8;
};

struct WalkResult {
  /// One comp-frame sample list per point, ascending time.
  std::vector<trackapply::Track> tracks;
  /// `completed`, `lost` (a one-way walk lost a point), `partial` (a both-ways walk did).
  std::string status = "completed";
  /// The source display grid (the decoder's stored picture size).
  double sourceWidth = 0;
  double sourceHeight = 0;
};

/// The planar tracker's walk (AE parity 3.4): `region` and `surface` are
/// quads in source display px at the origin; `excludeAt` the exclusion
/// polygons at a comp frame, source display px.
struct PlanarWalk {
  std::array<tracking::Pt, 4> region{};
  std::array<tracking::Pt, 4> surface{};
  std::function<planar::Polys(std::int64_t compFrame)> excludeAt;
  double featureHalf = 7;
  double searchHalf = 20;
};

/// The surface's four corners, one track each (TL, TR, BR, BL), ridden by the
/// region's homography; `status` lost / partial when the plane was lost.
[[nodiscard]] std::optional<WalkResult> walk_planar(FrameSource& src, const WalkSpec& spec, const PlanarWalk& planar,
                                                    JobControl& control);

/// Walk `spec` over `src` (opened at the analysis size). nullopt when cancelled.
/// Throws EngineFail (a decode error, a range the clip does not advance over).
[[nodiscard]] std::optional<WalkResult> walk(FrameSource& src, const WalkSpec& spec, JobControl& control);

}  // namespace premation::jobs::trackwalk
