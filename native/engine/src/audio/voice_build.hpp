// Building the voice list — the pure halves of src/core/audio/audioScene.ts
// and audioRetimeSegments.ts, ported so the document side (D1b) produces the
// SAME voices the TypeScript does. The document supplies what only it knows
// (clip bars, the layer's source-time curve, a precomp instance's inner-time
// curve) as values and callbacks; everything here is arithmetic.
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "audio_types.hpp"

namespace premation::audio {

/// audioScene.ts `AudioClipTiming` + the clip id and its enabled switch.
struct ClipTiming {
  std::string id;
  bool enabled = true;
  double startSec = 0;
  double inSec = 0;
  double outSec = 0;
};

/// audioRetimeSegments.ts `AudioRateSegment`.
struct RateSegment {
  double startSec = 0;
  double durationSec = 0;
  double inSec = 0;
  double rate = 1;
  bool reverse = false;
};

/// `buildAudioRetimeSegments` for a time-remapped footage bar: `sourceAt(t)`
/// is the source time the picture shows at comp time t (videoSourceTimeAt
/// with the bar's clip map). Empty = silence (freeze / zero-length bar).
[[nodiscard]] std::vector<RateSegment> retime_segments(const std::function<double(double)>& sourceAt,
                                                       const ClipTiming& bar, double fps);

/// readVideoAudioVoices: one voice per segment (`<clip>::r<i>`), each a
/// constant-rate varispeed window.
[[nodiscard]] std::vector<Voice> expand_segments(const Voice& base, const ClipTiming& bar,
                                                 const std::vector<RateSegment>& segs);

/// `placeNestedVoices`: a placed composition's voices moved onto the host's
/// clock through the instance's bars. `innerAt(host)` is the inner-comp time
/// the instance shows (used only when `retimed`: time remap / stretch / Speed).
[[nodiscard]] std::vector<Voice> place_nested(const std::string& instanceId, const std::vector<Voice>& inner,
                                              const std::vector<ClipTiming>& spans, bool retimed,
                                              const std::function<double(double)>& innerAt, double fps,
                                              bool instanceMuted);

/// Solo across one composition's voices (audioScene.ts `voicesOf`): when any
/// layer is soloed, every voice of a non-soloed layer is muted (kept in the
/// list — the waveform and the decode cache still see it).
void apply_solo(std::vector<Voice>& voices, const std::vector<std::string>& soloedNodeIds);

}  // namespace premation::audio
