// `prepare` helpers (core thread): what a job reads from the document about a
// footage layer — the file it plays, its timing, its composition — copied out
// so the work never touches the document.
#pragma once

#include <cstdint>
#include <optional>
#include <vector>
#include <string>
#include <string_view>

#include "engine_api.hpp"
#include "job_api.hpp"
#include "model.hpp"

namespace premation::jobs {

/// A footage layer as a job sees it.
struct FootageLayer {
  std::string layer;
  std::string comp;
  std::string item;    ///< the footage item (asset id)
  std::string file;    ///< a readable path
  api::LayerKind kind = api::LayerKind::video;
  api::LayerTiming timing;
  double compFps = 30;
  std::uint32_t compWidth = 1920;
  std::uint32_t compHeight = 1080;
  /// The layer's stored picture size (0 for sound-only).
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  /// The layer has a timeline bar (mirror/audio.ts hasOwnBar); without one its
  /// source plays from composition 0 (audioClipTimings → []).
  bool hasBar = true;

  /// How `source_seconds` maps composition time. `none` is stretch
  /// (`start + source * stretch`). `frames` is Time Remap / precomp time.
  /// `speed` is the Speed % integral.
  enum class RetimeKind : std::uint8_t { none, frames, speed };
  RetimeKind retimeKind = RetimeKind::none;
  /// Keys of `timeRemap`, `precompTime`, or `timeSpeed`, copied at prepare.
  std::vector<doc::Key> retimeKeys;
  /// One timeline bar's clip map (retime.ts `retimeClipOf`).
  struct RetimeClipMap {
    double startFrame = 0;
    double endFrame = 0;
    double offsetSec = 0;
    double inSec = 0;
  };
  std::vector<RetimeClipMap> retimeClips;
  /// Set when the retime property has an enabled expression: source seconds
  /// at each composition frame from `retimeSampleFirst`, so the worker never
  /// evaluates the expression. Empty means the key curve above.
  std::int64_t retimeSampleFirst = 0;
  std::vector<double> retimeSamples;

  /// Composition seconds at which SOURCE second `s` plays (stretch, or the
  /// inverse of a retimed `source_seconds`).
  [[nodiscard]] double comp_seconds(double sourceSec) const;
  /// The source second that plays at composition second `c`.
  [[nodiscard]] double source_seconds(double compSec) const;
  [[nodiscard]] double in_seconds() const noexcept;
  [[nodiscard]] double out_seconds() const noexcept;

  /// mirror/audio.ts audioClipTimings: the bar as (comp start, source in, source out) seconds.
  struct ClipTiming {
    double startSec = 0;
    double inSec = 0;
    double outSec = 0;
  };
  [[nodiscard]] std::vector<ClipTiming> clip_timings() const;
  /// audioEdits.ts sourceFrameToCompTime: where a SOURCE second plays in the
  /// composition through the bar; nullopt where the bar trims it away.
  [[nodiscard]] std::optional<double> comp_seconds_through_bar(double sourceSec) const;
};

enum class Need : std::uint8_t { picture, sound };

/// The footage layer `id`: its file resolved (resolve_footage_path). Throws
/// EngineFail — notFound (no such layer), invalidArgument (not footage, no
/// picture / no sound for `need`), unsupported (a
/// session-only `blob:` source the engine cannot read).
[[nodiscard]] FootageLayer footage_layer(const JobDocContext& ctx, std::string_view id, Need need);

/// A document media `src` as a file: `file://` / `local-file://` URLs decoded,
/// `motion-blob:<sha256>` inside the bundle (`<bundle>/blobs/<hh>/<sha256>`),
/// a plain path as is. Empty for what no file backs (`blob:`, `data:`, http).
[[nodiscard]] std::string resolve_footage_path(std::string_view src, std::string_view bundleRoot);

/// Flicks (API time) ↔ seconds.
inline constexpr double kFlicksPerSecond = 705'600'000.0;
[[nodiscard]] inline double seconds_of(api::Time t) noexcept { return static_cast<double>(t) / kFlicksPerSecond; }
[[nodiscard]] api::Time flicks_of(double seconds) noexcept;

/// A number formatted for a JSON summary (finite; integers without a fraction).
[[nodiscard]] std::string json_number(double v);
/// A JSON string literal.
[[nodiscard]] std::string json_string(std::string_view s);

}  // namespace premation::jobs
