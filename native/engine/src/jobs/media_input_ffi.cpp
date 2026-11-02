// media_input.hpp over ffmpeg: libavformat/libavcodec decode, libswscale to
// straight RGBA8 at the job's analysis size. Software decode on purpose: a job
// reads every frame once, on a worker thread, and the analysis wants CPU
// pixels — a hardware surface would only be downloaded again. The sound goes
// through the engine's audio decoder (audio/audio_decode.hpp), so a job hears
// exactly what the mixer plays.
#include "media_input.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <memory>
#include <utility>
#include <vector>

#include "audio_decode.hpp"
#include "scene/image_decode.hpp"
#include "scene/pdf_render.hpp"
#include "scene/svg_layer.hpp"

namespace premation::jobs {
namespace {

std::filesystem::path fs_path(const std::string& s) { return std::filesystem::path(std::u8string(s.begin(), s.end())); }

std::string av_error(int code) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(code, buf, sizeof buf);
  return buf;
}

struct FormatDeleter {
  void operator()(AVFormatContext* f) const noexcept { avformat_close_input(&f); }
};
struct CodecDeleter {
  void operator()(AVCodecContext* c) const noexcept { avcodec_free_context(&c); }
};
struct FrameDeleter {
  void operator()(AVFrame* f) const noexcept { av_frame_free(&f); }
};
struct PacketDeleter {
  void operator()(AVPacket* p) const noexcept { av_packet_free(&p); }
};
struct SwsDeleter {
  void operator()(SwsContext* s) const noexcept { sws_freeContext(s); }
};

class FfmpegFrames final : public FrameSource {
 public:
  bool open(const std::string& path, std::uint32_t maxEdge, std::string& error) {
    AVFormatContext* raw = nullptr;
    int r = avformat_open_input(&raw, path.c_str(), nullptr, nullptr);
    if (r < 0) {
      error = "cannot open '" + path + "': " + av_error(r);
      return false;
    }
    fmt_.reset(raw);
    r = avformat_find_stream_info(fmt_.get(), nullptr);
    if (r < 0) {
      error = "cannot read '" + path + "': " + av_error(r);
      return false;
    }
    stream_ = av_find_best_stream(fmt_.get(), AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (stream_ < 0) {
      error = "'" + path + "' has no picture";
      return false;
    }
    const AVStream* st = fmt_->streams[stream_];
    const AVCodec* codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (codec == nullptr) {
      error = "no decoder for '" + path + "'";
      return false;
    }
    dec_.reset(avcodec_alloc_context3(codec));
    if (!dec_ || avcodec_parameters_to_context(dec_.get(), st->codecpar) < 0) {
      error = "cannot set up the decoder for '" + path + "'";
      return false;
    }
    dec_->thread_count = 0;
    r = avcodec_open2(dec_.get(), codec, nullptr);
    if (r < 0) {
      error = "cannot open the decoder for '" + path + "': " + av_error(r);
      return false;
    }
    srcW_ = static_cast<std::uint32_t>(std::max(1, st->codecpar->width));
    srcH_ = static_cast<std::uint32_t>(std::max(1, st->codecpar->height));
    const std::uint32_t edge = std::max(srcW_, srcH_);
    if (maxEdge > 0 && edge > maxEdge) {
      const double k = static_cast<double>(maxEdge) / edge;
      outW_ = std::max(1U, static_cast<std::uint32_t>(std::lround(srcW_ * k)));
      outH_ = std::max(1U, static_cast<std::uint32_t>(std::lround(srcH_ * k)));
    } else {
      outW_ = srcW_;
      outH_ = srcH_;
    }
    const AVRational rate = st->avg_frame_rate.num > 0 ? st->avg_frame_rate : st->r_frame_rate;
    fps_ = rate.num > 0 && rate.den > 0 ? av_q2d(rate) : 0;
    timeBase_ = av_q2d(st->time_base);
    startSec_ = st->start_time != AV_NOPTS_VALUE ? static_cast<double>(st->start_time) * timeBase_ : 0.0;
    if (st->nb_frames > 0) {
      frames_ = st->nb_frames;
    } else if (fmt_->duration > 0 && fps_ > 0) {
      frames_ = static_cast<std::int64_t>(std::llround(static_cast<double>(fmt_->duration) / AV_TIME_BASE * fps_));
    } else {
      frames_ = 1;  // a still image
    }
    if (fps_ <= 0) fps_ = 30;
    frame_.reset(av_frame_alloc());
    pkt_.reset(av_packet_alloc());
    if (!frame_ || !pkt_) {
      error = "out of memory";
      return false;
    }
    return true;
  }

  [[nodiscard]] std::uint32_t width() const noexcept override { return outW_; }
  [[nodiscard]] std::uint32_t height() const noexcept override { return outH_; }
  [[nodiscard]] std::uint32_t source_width() const noexcept override { return srcW_; }
  [[nodiscard]] std::uint32_t source_height() const noexcept override { return srcH_; }
  [[nodiscard]] double fps() const noexcept override { return fps_; }
  [[nodiscard]] std::int64_t frame_count() const noexcept override { return frames_; }

  bool read(std::int64_t frame, RgbaImage& out, std::string& error) override {
    if (!position(frame, error)) return false;
    return convert(out, error);
  }

  bool read_luma(std::int64_t frame, LumaImage& out, std::string& error) override {
    if (!position(frame, error)) return false;
    const auto fmt = static_cast<AVPixelFormat>(cur_->format);
    const bool planarY = fmt == AV_PIX_FMT_YUV420P || fmt == AV_PIX_FMT_YUVJ420P || fmt == AV_PIX_FMT_NV12 ||
                         fmt == AV_PIX_FMT_YUV422P || fmt == AV_PIX_FMT_YUVJ422P || fmt == AV_PIX_FMT_YUV444P ||
                         fmt == AV_PIX_FMT_YUVJ444P || fmt == AV_PIX_FMT_YUVA420P;
    if (planarY && static_cast<std::uint32_t>(cur_->width) == outW_ && static_cast<std::uint32_t>(cur_->height) == outH_) {
      // lumaExtract.ts 'raw8': the Y bytes themselves.
      out.width = outW_;
      out.height = outH_;
      out.bytes = true;
      out.data.resize(static_cast<std::size_t>(outW_) * outH_);
      for (std::uint32_t y = 0; y < outH_; ++y) {
        const std::uint8_t* row = cur_->data[0] + static_cast<std::ptrdiff_t>(y) * cur_->linesize[0];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        for (std::uint32_t x = 0; x < outW_; ++x) out.data[static_cast<std::size_t>(y) * outW_ + x] = row[x];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
      return true;
    }
    // Any other YUV picture (scaled to the analysis size, 10-bit, 4:2:2...):
    // the luma plane alone, area-filtered straight to 8-bit grey — the same
    // 'raw8' luma as above. Converting the whole picture to RGBA (bicubic,
    // chroma upsampled) to throw the colour away again was most of the
    // tracker's time on 1440p / 4K footage (docs/PROGRAM_PERFORMANCE.md V6).
    const AVPixFmtDescriptor* desc = av_pix_fmt_desc_get(fmt);
    const bool yuv = desc != nullptr && desc->nb_components >= 3 && (desc->flags & (AV_PIX_FMT_FLAG_RGB | AV_PIX_FMT_FLAG_PAL | AV_PIX_FMT_FLAG_HWACCEL)) == 0;
    if (yuv && luma_scaled(out)) return true;
    RgbaImage rgba;
    if (!convert(rgba, error)) return false;
    out = luma_from_rgba(rgba);
    return true;
  }

 private:
  /// A decoded picture kept for a backward walk (position()'s ring).
  struct Kept {
    std::int64_t index = 0;
    std::unique_ptr<AVFrame, FrameDeleter> frame;
  };

  /// How many pictures the backward ring may hold for this stream: about 384 MB of raw frames,
  /// never fewer than 4 nor more than 96 (a GOP is 12–250 frames; a longer one is decoded in parts).
  [[nodiscard]] std::size_t ring_capacity() const noexcept {
    const auto fmt = static_cast<AVPixelFormat>(frame_->format);
    const int bytes = av_image_get_buffer_size(fmt, frame_->width, frame_->height, 1);
    const std::size_t per = bytes > 0 ? static_cast<std::size_t>(bytes) : static_cast<std::size_t>(frame_->width) * static_cast<std::size_t>(frame_->height) * 3 / 2;
    constexpr std::size_t kBudget = std::size_t{384} << 20;
    return std::clamp<std::size_t>(kBudget / std::max<std::size_t>(1, per), 4, 96);
  }

  /// Position on `frame` (cur_ holds its picture after). Forward and near: keep decoding.
  /// Far: seek to the keyframe before it. BACKWARD, one or two frames at a time (a walk the other
  /// way from the origin): seeking to the keyframe and decoding the GOP up to the frame again for
  /// every step cost a whole GOP decode per frame; instead the GOP is decoded forward ONCE into a
  /// ring of ref-counted pictures ending at the frame, and the following backward steps are handed
  /// out of the ring in reverse. The ring refills from the keyframe before it when it runs dry.
  bool position(std::int64_t frame, std::string& error) {
    frame = std::clamp<std::int64_t>(frame, 0, std::max<std::int64_t>(0, frames_ - 1));
    if (haveServed_ && frame == servedIndex_ && cur_ != nullptr) return true;
    // In the ring (a backward step): the picture is there; everything after it is no longer needed.
    for (auto it = ring_.rbegin(); it != ring_.rend(); ++it) {
      if (it->index != frame) continue;
      cur_ = it->frame.get();
      ring_.erase(it.base(), ring_.end());  // the pictures after `frame`
      serve(frame);
      return true;
    }
    const bool backward = haveServed_ && frame < servedIndex_ && servedIndex_ - frame <= 2;
    if (backward && frames_ > 1) return fill_ring_to(frame, error);
    ring_.clear();
    if (haveDec_ && frame == decIndex_) {
      cur_ = frame_.get();
      serve(frame);
      return true;
    }
    if (!haveDec_ || frame < decIndex_ || frame > decIndex_ + 48) {
      if (!seek(frame, error)) return false;
    }
    for (;;) {
      const int got = next_frame(error);
      if (got < 0) return false;
      if (got == 0) {
        // End of stream before `frame`: hand back the last picture (a short final GOP).
        if (haveDec_) {
          cur_ = frame_.get();
          serve(decIndex_);
          return true;
        }
        error = "no frame " + std::to_string(frame);
        return false;
      }
      if (decIndex_ >= frame) {
        cur_ = frame_.get();
        serve(decIndex_);
        return true;
      }
    }
  }

  void serve(std::int64_t index) noexcept {
    servedIndex_ = index;
    haveServed_ = true;
  }

  /// Decode from the keyframe before `frame` up to it, keeping the last `ring_capacity()` pictures
  /// (ending at `frame`) in the ring; serve `frame` from it.
  bool fill_ring_to(std::int64_t frame, std::string& error) {
    ring_.clear();
    if (!seek(frame, error)) return false;
    std::size_t cap = 0;
    for (;;) {
      const int got = next_frame(error);
      if (got < 0) return false;
      if (got == 0) break;
      if (cap == 0) cap = ring_capacity();  // from the first decoded picture's size and format
      if (decIndex_ > frame) break;  // overshot (a stream whose index does not round exactly): the last kept is the nearest
      Kept k;
      k.index = decIndex_;
      k.frame.reset(av_frame_clone(frame_.get()));  // a reference to the decoder's buffer, not a copy
      if (!k.frame) {
        error = "out of memory";
        return false;
      }
      ring_.push_back(std::move(k));
      while (ring_.size() > cap) ring_.erase(ring_.begin());
      if (decIndex_ >= frame) break;
    }
    if (ring_.empty()) {
      if (!haveDec_) {
        error = "no frame " + std::to_string(frame);
        return false;
      }
      cur_ = frame_.get();
      serve(decIndex_);
      return true;
    }
    cur_ = ring_.back().frame.get();
    serve(ring_.back().index);
    return true;
  }

  bool seek(std::int64_t frame, std::string& error) {
    const double sec = startSec_ + static_cast<double>(frame) / fps_;
    const auto ts = static_cast<std::int64_t>(std::floor(sec / timeBase_));
    const int r = av_seek_frame(fmt_.get(), stream_, ts, AVSEEK_FLAG_BACKWARD);
    if (r < 0 && frame > 0) {
      error = "seek failed: " + av_error(r);
      return false;
    }
    avcodec_flush_buffers(dec_.get());
    eof_ = false;
    haveDec_ = false;
    return true;
  }

  /// 1 = a frame decoded (lastIndex_ set), 0 = end of stream, −1 = error.
  int next_frame(std::string& error) {
    for (;;) {
      int r = avcodec_receive_frame(dec_.get(), frame_.get());
      if (r == 0) {
        const std::int64_t pts = frame_->best_effort_timestamp != AV_NOPTS_VALUE ? frame_->best_effort_timestamp : frame_->pts;
        if (pts != AV_NOPTS_VALUE) {
          const double sec = static_cast<double>(pts) * timeBase_ - startSec_;
          decIndex_ = static_cast<std::int64_t>(std::llround(sec * fps_));
        } else {
          decIndex_ = haveDec_ ? decIndex_ + 1 : 0;
        }
        haveDec_ = true;
        return 1;
      }
      if (r == AVERROR_EOF) return 0;
      if (r != AVERROR(EAGAIN)) {
        error = "decode failed: " + av_error(r);
        return -1;
      }
      if (eof_) return 0;
      r = av_read_frame(fmt_.get(), pkt_.get());
      if (r == AVERROR_EOF) {
        eof_ = true;
        (void)avcodec_send_packet(dec_.get(), nullptr);  // drain
        continue;
      }
      if (r < 0) {
        error = "read failed: " + av_error(r);
        return -1;
      }
      if (pkt_->stream_index == stream_) {
        r = avcodec_send_packet(dec_.get(), pkt_.get());
        if (r < 0 && r != AVERROR(EAGAIN)) {
          av_packet_unref(pkt_.get());
          error = "decode failed: " + av_error(r);
          return -1;
        }
      }
      av_packet_unref(pkt_.get());
    }
  }

  /// The served picture's luma at the analysis size, 8-bit (`bytes`); false when swscale cannot.
  bool luma_scaled(LumaImage& out) {
    const auto fmtIn = static_cast<AVPixelFormat>(cur_->format);
    swsLuma_.reset(sws_getCachedContext(swsLuma_.release(), cur_->width, cur_->height, fmtIn, static_cast<int>(outW_),
                                        static_cast<int>(outH_), AV_PIX_FMT_GRAY8, SWS_AREA, nullptr, nullptr, nullptr));
    if (!swsLuma_) return false;
    grey_.resize(static_cast<std::size_t>(outW_) * outH_);
    std::uint8_t* dst[4] = {grey_.data(), nullptr, nullptr, nullptr};
    const int dstStride[4] = {static_cast<int>(outW_), 0, 0, 0};
    if (sws_scale(swsLuma_.get(), cur_->data, cur_->linesize, 0, cur_->height, dst, dstStride) <= 0) return false;
    out.width = outW_;
    out.height = outH_;
    out.bytes = true;
    out.data.assign(grey_.begin(), grey_.end());
    return true;
  }

  bool convert(RgbaImage& out, std::string& error) {
    if (cur_ == nullptr) {
      error = "no picture";
      return false;
    }
    const auto fmtIn = static_cast<AVPixelFormat>(cur_->format);
    sws_.reset(sws_getCachedContext(sws_.release(), cur_->width, cur_->height, fmtIn, static_cast<int>(outW_),
                                    static_cast<int>(outH_), AV_PIX_FMT_RGBA, SWS_BICUBIC, nullptr, nullptr, nullptr));
    if (!sws_) {
      error = "cannot convert the picture";
      return false;
    }
    out.width = outW_;
    out.height = outH_;
    out.rgba.assign(static_cast<std::size_t>(outW_) * outH_ * 4U, 0);
    std::uint8_t* dst[4] = {out.rgba.data(), nullptr, nullptr, nullptr};
    const int dstStride[4] = {static_cast<int>(outW_ * 4U), 0, 0, 0};
    const int h = sws_scale(sws_.get(), cur_->data, cur_->linesize, 0, cur_->height, dst, dstStride);
    if (h <= 0) {
      error = "cannot convert the picture";
      return false;
    }
    // Formats without alpha come back with A = 255 from swscale; nothing to do.
    return true;
  }

  std::unique_ptr<AVFormatContext, FormatDeleter> fmt_;
  std::unique_ptr<AVCodecContext, CodecDeleter> dec_;
  std::unique_ptr<AVFrame, FrameDeleter> frame_;
  std::unique_ptr<AVPacket, PacketDeleter> pkt_;
  std::unique_ptr<SwsContext, SwsDeleter> sws_;
  std::unique_ptr<SwsContext, SwsDeleter> swsLuma_;
  std::vector<std::uint8_t> grey_;  // luma_scaled's scratch, kept across frames
  /// The backward ring: pictures in index order, the served one last (position()).
  std::vector<Kept> ring_;
  /// The picture read() converts: the decoder's `frame_`, or one of the ring's.
  const AVFrame* cur_ = nullptr;
  int stream_ = -1;
  std::uint32_t srcW_ = 0;
  std::uint32_t srcH_ = 0;
  std::uint32_t outW_ = 0;
  std::uint32_t outH_ = 0;
  double fps_ = 30;
  double timeBase_ = 1;
  double startSec_ = 0;
  std::int64_t frames_ = 1;
  /// The decoder's last picture (frame_) and the one served last (cur_).
  std::int64_t decIndex_ = -1;
  bool haveDec_ = false;
  std::int64_t servedIndex_ = -1;
  bool haveServed_ = false;
  bool eof_ = false;
};

/// A still image (PNG, JPEG, …): the engine's ffmpeg build carries no still
/// decoders, so it is read through the OS codec the renderer uses for image
/// layers (scene/image_decode.hpp: WIC on Windows) — one frame, box-filtered
/// down to the job's long edge.
class StillFrames final : public FrameSource {
 public:
  bool open(const std::string& path, std::uint32_t maxEdge, std::string& error) {
    scene::DecodedImage img;
    if (!scene::decode_image_file(fs_path(path), img, error)) return false;
    srcW_ = img.width;
    srcH_ = img.height;
    RgbaImage full;
    full.width = srcW_;
    full.height = srcH_;
    full.rgba = std::move(img.rgba);
    image_ = box_downscale(std::move(full), maxEdge);
    return true;
  }
  [[nodiscard]] std::uint32_t width() const noexcept override { return image_.width; }
  [[nodiscard]] std::uint32_t height() const noexcept override { return image_.height; }
  [[nodiscard]] std::uint32_t source_width() const noexcept override { return srcW_; }
  [[nodiscard]] std::uint32_t source_height() const noexcept override { return srcH_; }
  [[nodiscard]] double fps() const noexcept override { return 30; }
  [[nodiscard]] std::int64_t frame_count() const noexcept override { return 1; }
  bool read(std::int64_t /*frame*/, RgbaImage& out, std::string& /*error*/) override {
    out = image_;
    return true;
  }

 private:
  RgbaImage image_;
  std::uint32_t srcW_ = 0;
  std::uint32_t srcH_ = 0;
};

}  // namespace

std::unique_ptr<FrameSource> open_frames(const std::string& path, std::uint32_t maxEdge, std::string& error) {
  // P7b: footage a native plugin imports never reaches the decoders.
  if (auto plugin = open_plugin_frames(path, maxEdge, error); plugin || !error.empty()) return plugin;
  if (scene::is_still_image_path(fs_path(path))) {
    auto still = std::make_unique<StillFrames>();
    std::string stillError;
    if (still->open(path, maxEdge, stillError)) return still;
    // Not decodable by the OS codec (or no codec on this OS): try ffmpeg.
    auto f = std::make_unique<FfmpegFrames>();
    if (f->open(path, maxEdge, error)) return f;
    error = stillError;
    return nullptr;
  }
  auto f = std::make_unique<FfmpegFrames>();
  if (!f->open(path, maxEdge, error)) return nullptr;
  return f;
}

namespace {

std::string lower_ext(const std::filesystem::path& p) {
  std::string ext = p.extension().string();
  for (char& c : ext) c = c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
  return ext;
}

/// An SVG is read by the engine's own SVG renderer (scene/svg_layer.hpp), not a
/// codec: its size from the document, an image like any still. An animated
/// one plays from its layer's own time (scene_textures svg_ref).
bool probe_svg(const std::string& path, js::Json& facts, std::string& error) {
  const raster::svg::SvgFacts f = scene::svg_file_facts(fs_path(path));
  if (!f.ok) {
    error = "'" + path + "' is not a readable SVG: " + f.error;
    return false;
  }
  facts = js::Json::object();
  facts.set("type", js::Json::string("image"));
  js::Json md = js::Json::object();
  md.set("width", js::Json::number(std::max(1.0, std::round(f.width))));
  md.set("height", js::Json::number(std::max(1.0, std::round(f.height))));
  md.set("duration", js::Json::number(0));
  facts.set("metadata", std::move(md));
  return true;
}

/// A PDF / Illustrator file: its first page, sized in points (AE: 1 pt = 1 px),
/// an image drawn at its display size by PDFium (scene/pdf_render.hpp).
bool probe_pdf(const std::string& path, js::Json& facts, std::string& error) {
  const scene::PdfFacts f = scene::pdf_file_facts(path);
  if (!f.ok) {
    error = "'" + path + "' could not be read: " + f.error;
    return false;
  }
  facts = js::Json::object();
  facts.set("type", js::Json::string("image"));
  js::Json md = js::Json::object();
  md.set("width", js::Json::number(std::max(1.0, std::round(f.width))));
  md.set("height", js::Json::number(std::max(1.0, std::round(f.height))));
  md.set("duration", js::Json::number(0));
  md.set("pages", js::Json::number(f.pages));
  facts.set("metadata", std::move(md));
  return true;
}

/// An animated GIF / WebP: the OS still codec reads only the first frame, so
/// ffmpeg is asked first; with more than one frame it is footage that moves.
bool probe_animated_still(const std::string& path, js::Json& facts) {
  FfmpegFrames anim;
  std::string ignored;
  if (!anim.open(path, 1, ignored) || anim.frame_count() <= 1) return false;
  facts = js::Json::object();
  facts.set("type", js::Json::string("video"));
  js::Json md = js::Json::object();
  md.set("width", js::Json::number(anim.source_width()));
  md.set("height", js::Json::number(anim.source_height()));
  md.set("fps", js::Json::number(anim.fps()));
  md.set("duration", js::Json::number(static_cast<double>(anim.frame_count()) / anim.fps()));
  md.set("hasAudioTrack", js::Json::boolean(false));
  facts.set("metadata", std::move(md));
  return true;
}

}  // namespace

bool probe_media(const std::string& path, js::Json& facts, std::string& error) {
  const std::string ext = lower_ext(fs_path(path));
  if (ext == ".svg") return probe_svg(path, facts, error);
  if (ext == ".pdf" || ext == ".ai") return probe_pdf(path, facts, error);
  if ((ext == ".gif" || ext == ".webp") && probe_animated_still(path, facts)) return true;
  audio::AudioStreamInfo sound;
  std::string soundError;
  const bool probedSound = audio::probe_audio(path, sound, soundError) && sound.hasAudio;
  std::string pictureError;
  const std::unique_ptr<FrameSource> picture = open_frames(path, 1, pictureError);
  facts = js::Json::object();
  js::Json md = js::Json::object();
  if (picture) {
    const bool still = scene::is_still_image_path(fs_path(path)) || picture->frame_count() <= 1;
    facts.set("type", js::Json::string(still && !probedSound ? "image" : "video"));
    md.set("width", js::Json::number(picture->source_width()));
    md.set("height", js::Json::number(picture->source_height()));
    if (still && !probedSound) {
      md.set("duration", js::Json::number(0));
    } else {
      const double fps = picture->fps();
      md.set("fps", js::Json::number(fps));
      const double frames = static_cast<double>(picture->frame_count());
      md.set("duration", js::Json::number(fps > 0 ? frames / fps : sound.durationSec));
      md.set("hasAudioTrack", js::Json::boolean(probedSound));
    }
  } else if (probedSound) {
    facts.set("type", js::Json::string("audio"));
    md.set("duration", js::Json::number(sound.durationSec));
    md.set("hasAudioTrack", js::Json::boolean(true));
  } else {
    error = !pictureError.empty() ? pictureError : soundError;
    return false;
  }
  facts.set("metadata", std::move(md));
  return true;
}

bool read_audio(const std::string& path, AudioPcm& out, std::string& error) {
  audio::AudioStreamInfo info;
  if (!audio::probe_audio(path, info, error)) return false;
  if (!info.hasAudio) {
    error = "'" + path + "' has no sound";
    return false;
  }
  out.sampleRate = info.sampleRate;
  out.channels.clear();
  return audio::decode_all_native(path, out.channels, error);
}

}  // namespace premation::jobs
