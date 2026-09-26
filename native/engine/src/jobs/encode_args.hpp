// The ffmpeg command line of a render — port of electron/ffmpegEncodeArgs.ts
// (buildEncodeArgs, rawVideoInput, videoEncoderArgs, ffmpegRate, h264MaxRate),
// the reference, so an engine render job encodes exactly as the export
// supervisor's engine path does (electron/engineExport.ts engineEncodeArgs).
#pragma once

#include <optional>
#include <string>
#include <vector>

namespace premation::jobs::encode {

struct Options {
  std::string format;         ///< mp4 | webm | gif | mov
  std::vector<std::string> videoInput;
  std::string quality = "high";  ///< high | medium | draft
  std::string proresProfile = "4444";
  std::optional<std::string> audio;
  std::optional<std::string> chaptersFile;
  bool alpha = false;
  struct Frame {
    double width = 0;
    double height = 0;
    double fps = 0;
  };
  std::optional<Frame> frame;
  std::string videoEncoder = "libx264";
  bool tagSrgb = false;
  std::string out;
};

[[nodiscard]] std::string ffmpeg_rate(double fps);
[[nodiscard]] std::vector<std::string> raw_video_input(double width, double height, double fps, bool rgba64);
[[nodiscard]] std::vector<std::string> video_encoder_args(const std::string& encoder, const std::string& quality);
[[nodiscard]] double h264_max_rate(double width, double height, double fps, const std::string& quality);
[[nodiscard]] std::vector<std::string> build_encode_args(const Options& o);

}  // namespace premation::jobs::encode
