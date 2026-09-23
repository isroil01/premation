// Audio test fixtures encoded in-process with libavcodec's own encoders (no
// checked-in media, no external ffmpeg): WAV (PCM16 / float), FLAC, AAC in MP4.
#pragma once

#include <string>
#include <vector>

namespace premation::audio::fixture {

enum class Codec { wavPcm16, wavFloat, flac, aacMp4 };

/// Encode planar `planes` (channels × frames, −1…1) at `sampleRate` to `path`.
bool write(const std::string& path, Codec codec, const std::vector<std::vector<float>>& planes, int sampleRate,
           std::string& error);

}  // namespace premation::audio::fixture
