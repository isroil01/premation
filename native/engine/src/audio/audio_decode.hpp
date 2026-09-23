// Audio decode (ffmpeg behind this interface; libav* only in
// audio_decode_ffi.cpp): the first audio stream of any container ffmpeg reads
// — WAV, AIFF, FLAC, MP3, AAC/ALAC in MP4/MOV, Opus/Vorbis in WebM/Ogg, and
// the audio track of video files.
//
// Channels follow decodeAudioData + the Web Audio destination: a mono source
// stays mono (the mixer up-mixes it L = R, or pans it with the mono law), 2 is
// stereo, and more are down-mixed with the spec's speaker rules (quad:
// ½(L+SL), ½(R+SR); 5.1: L + √½(C+SL), R + √½(C+SR), LFE dropped; others:
// the first two channels).
#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include "source_store.hpp"

namespace premation::audio {

struct AudioStreamInfo {
  bool hasAudio = false;
  int channels = 0;        // the file's
  int sampleRate = 0;      // the file's
  double durationSec = 0;  // container estimate
  std::string codec;
};

[[nodiscard]] bool probe_audio(const std::string& path, AudioStreamInfo& out, std::string& error);

/// The channel count a source with `sourceChannels` conforms to (1 or 2).
[[nodiscard]] int conformed_channels(int sourceChannels) noexcept;

/// Decode the whole stream IN ORDER, resampled to `targetRate`
/// (libswresample, one continuous pass — deterministic, and the output frame
/// n is at source time n/targetRate exactly: the resampler's filter delay is
/// compensated), appending to `sink`. `cancel` is polled between packets.
[[nodiscard]] bool conform_audio(const std::string& path, int targetRate, SourceData& sink,
                                 const std::atomic<bool>* cancel, std::string& error);

/// Decode source-rate frames [from, from + n) by SEEKING (not a linear decode):
/// seek before `from` minus a pre-roll, decode, place every frame by its
/// timestamp, keep exactly the requested frames. Sample-exact wherever the
/// container stamps in samples (WAV, FLAC, MP4/MOV, MP3 with its gapless
/// header); planar, conformed channels.
[[nodiscard]] bool decode_range(const std::string& path, std::int64_t from, std::int64_t n,
                                std::vector<std::vector<float>>& out, std::string& error);

/// Linear decode of the whole stream at the SOURCE rate (the seek reference).
[[nodiscard]] bool decode_all_native(const std::string& path, std::vector<std::vector<float>>& out,
                                     std::string& error);

}  // namespace premation::audio
