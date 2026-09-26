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

  /// Composition seconds at which SOURCE second `s` plays (normal speed, the
  /// layer's stretch; time remap is refused by `footage_layer`).
  [[nodiscard]] double comp_seconds(double sourceSec) const noexcept;
  /// The source second that plays at composition second `c`.
  [[nodiscard]] double source_seconds(double compSec) const noexcept;
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
/// picture / no sound for `need`, a time-remapped layer), unsupported (a
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
