#include "encode_args.hpp"

#include <algorithm>
#include <cmath>
#include <map>

#include "jsmath.hpp"
#include "numconv.hpp"

namespace premation::jobs::encode {

namespace {

const char* kSrgbFrameParams = "setparams=color_primaries=bt709:color_trc=iec61966-2-1";

void append(std::vector<std::string>& to, std::initializer_list<std::string> xs) { to.insert(to.end(), xs.begin(), xs.end()); }
void append(std::vector<std::string>& to, const std::vector<std::string>& xs) { to.insert(to.end(), xs.begin(), xs.end()); }

/// String(n) for a JavaScript number.
std::string js_string(double n) { return motion::js::number_to_string(n); }

}  // namespace

std::string ffmpeg_rate(double fps) {
  if (std::abs(fps - 23.976) < 0.001) return "24000/1001";
  if (std::abs(fps - 29.97) < 0.001) return "30000/1001";
  if (std::abs(fps - 59.94) < 0.001) return "60000/1001";
  return js_string(fps);
}

std::vector<std::string> raw_video_input(double width, double height, double fps, bool rgba64) {
  return {"-f", "rawvideo", "-pix_fmt", rgba64 ? "rgba64le" : "rgba", "-video_size", js_string(width) + "x" + js_string(height),
          "-framerate", ffmpeg_rate(fps), "-i", "pipe:0"};
}

std::vector<std::string> video_encoder_args(const std::string& encoder, const std::string& quality) {
  const std::string crf = quality == "draft" ? "28" : quality == "medium" ? "23" : "18";
  if (encoder == "h264_nvenc" || encoder == "hevc_nvenc") {
    std::vector<std::string> a{"-c:v", encoder, "-preset", quality == "draft" ? "p3" : quality == "medium" ? "p5" : "p6"};
    if (quality != "draft") append(a, {"-tune", "hq"});
    append(a, {"-rc", "vbr", "-cq", crf, "-b:v", "0"});
    return a;
  }
  if (encoder == "h264_qsv") return {"-c:v", "h264_qsv", "-preset", quality == "draft" ? "veryfast" : "medium", "-global_quality", crf};
  if (encoder == "h264_videotoolbox") {
    return {"-c:v", "h264_videotoolbox", "-q:v", quality == "draft" ? "45" : quality == "medium" ? "55" : "65"};
  }
  return {"-c:v", "libx264", "-preset", quality == "draft" ? "veryfast" : "medium", "-crf", crf};
}

double h264_max_rate(double width, double height, double fps, const std::string& quality) {
  const double bpp = quality == "draft" ? 0.08 : quality == "medium" ? 0.16 : 0.32;
  return std::max(1'000'000.0, motion::js::round(width * height * fps * bpp));
}

std::vector<std::string> build_encode_args(const Options& o) {
  const std::string evenScale = std::string(o.tagSrgb ? std::string(kSrgbFrameParams) + "," : "") + "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const std::string crf = o.quality == "draft" ? "28" : o.quality == "medium" ? "23" : "18";
  const bool hasAudio = o.audio.has_value() && !o.audio->empty();
  const bool wantsChapters = (o.format == "mp4" || o.format == "mov") && o.chaptersFile && !o.chaptersFile->empty();
  std::vector<std::string> base{"-y"};
  append(base, o.videoInput);
  if (hasAudio) append(base, {"-i", *o.audio});
  if (wantsChapters) append(base, {"-i", *o.chaptersFile});
  std::vector<std::string> chapterMap;
  if (wantsChapters) chapterMap = {"-map_chapters", hasAudio ? "2" : "1"};

  if (o.format == "webm") {
    std::vector<std::string> a = base;
    append(a, {"-c:v", "libvpx-vp9", "-crf", crf, "-b:v", "0", "-row-mt", "1", "-threads", "0"});
    if (o.alpha) append(a, {"-pix_fmt", "yuva420p", "-auto-alt-ref", "0"});
    else append(a, {"-pix_fmt", "yuv420p"});
    append(a, {"-vf", evenScale});
    if (hasAudio) append(a, {"-c:a", "libopus", "-b:a", "160k", "-shortest"});
    a.push_back(o.out);
    return a;
  }
  if (o.format == "gif") {
    std::vector<std::string> a{"-y"};
    append(a, o.videoInput);
    append(a, {"-filter_complex",
               "[0:v] " + evenScale +
                   ",split [a][b];[a] palettegen=stats_mode=diff [p];[b][p] paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
               "-loop", "0", o.out});
    return a;
  }
  if (o.format == "mov") {
    static const std::map<std::string, std::pair<std::string, std::string>> kProres{
        {"proxy", {"0", "yuv422p10le"}}, {"lt", {"1", "yuv422p10le"}},  {"422", {"2", "yuv422p10le"}},
        {"hq", {"3", "yuv422p10le"}},    {"4444", {"4", "yuva444p10le"}}};
    const auto it = kProres.find(o.proresProfile);
    const auto& [flag, pix] = it != kProres.end() ? it->second : kProres.at("4444");
    std::vector<std::string> a = base;
    append(a, {"-c:v", "prores_ks", "-profile:v", flag, "-pix_fmt", pix, "-vf", evenScale});
    if (hasAudio) append(a, {"-c:a", "pcm_s16le", "-shortest"});
    append(a, chapterMap);
    a.push_back(o.out);
    return a;
  }
  // mp4 (and the default)
  std::vector<std::string> a = base;
  append(a, video_encoder_args(o.videoEncoder, o.quality));
  if (o.videoEncoder == "hevc_nvenc") append(a, {"-tag:v", "hvc1"});
  if (o.frame) {
    const double rate = h264_max_rate(o.frame->width, o.frame->height, o.frame->fps, o.quality);
    append(a, {"-maxrate", js_string(rate), "-bufsize", js_string(rate * 2)});
  }
  append(a, {"-pix_fmt", "yuv420p", "-movflags", "+faststart", "-vf", evenScale});
  if (hasAudio) append(a, {"-c:a", "aac", "-b:a", "192k", "-shortest"});
  append(a, chapterMap);
  a.push_back(o.out);
  return a;
}

}  // namespace premation::jobs::encode
