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
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <cmath>

#include "audio_decode.hpp"

namespace premation::jobs {
namespace {

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
    const auto fmt = static_cast<AVPixelFormat>(frame_->format);
    const bool planarY = fmt == AV_PIX_FMT_YUV420P || fmt == AV_PIX_FMT_YUVJ420P || fmt == AV_PIX_FMT_NV12 ||
                         fmt == AV_PIX_FMT_YUV422P || fmt == AV_PIX_FMT_YUVJ422P || fmt == AV_PIX_FMT_YUV444P ||
                         fmt == AV_PIX_FMT_YUVJ444P || fmt == AV_PIX_FMT_YUVA420P;
    if (planarY && static_cast<std::uint32_t>(frame_->width) == outW_ && static_cast<std::uint32_t>(frame_->height) == outH_) {
      // lumaExtract.ts 'raw8': the Y bytes themselves.
      out.width = outW_;
      out.height = outH_;
      out.bytes = true;
      out.data.resize(static_cast<std::size_t>(outW_) * outH_);
      for (std::uint32_t y = 0; y < outH_; ++y) {
        const std::uint8_t* row = frame_->data[0] + static_cast<std::ptrdiff_t>(y) * frame_->linesize[0];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        for (std::uint32_t x = 0; x < outW_; ++x) out.data[static_cast<std::size_t>(y) * outW_ + x] = row[x];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
      return true;
    }
    RgbaImage rgba;
    if (!convert(rgba, error)) return false;
    out = luma_from_rgba(rgba);
    return true;
  }

 private:
  /// Decode up to `frame` (frame_ holds it after).
  bool position(std::int64_t frame, std::string& error) {
    frame = std::clamp<std::int64_t>(frame, 0, std::max<std::int64_t>(0, frames_ - 1));
    if (haveLast_ && frame == lastIndex_) return true;
    // Forward and near: keep decoding. Backward or far: seek to the keyframe before it.
    if (!haveLast_ || frame < lastIndex_ || frame > lastIndex_ + 48) {
      if (!seek(frame, error)) return false;
    }
    for (;;) {
      const int got = next_frame(error);
      if (got < 0) return false;
      if (got == 0) {
        // End of stream before `frame`: hand back the last picture (a short final GOP).
        if (haveLast_) return true;
        error = "no frame " + std::to_string(frame);
        return false;
      }
      if (lastIndex_ >= frame) return true;
    }
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
    haveLast_ = false;
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
          lastIndex_ = static_cast<std::int64_t>(std::llround(sec * fps_));
        } else {
          lastIndex_ = haveLast_ ? lastIndex_ + 1 : 0;
        }
        haveLast_ = true;
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

  bool convert(RgbaImage& out, std::string& error) {
    const auto fmtIn = static_cast<AVPixelFormat>(frame_->format);
    sws_.reset(sws_getCachedContext(sws_.release(), frame_->width, frame_->height, fmtIn, static_cast<int>(outW_),
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
    const int h = sws_scale(sws_.get(), frame_->data, frame_->linesize, 0, frame_->height, dst, dstStride);
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
  int stream_ = -1;
  std::uint32_t srcW_ = 0;
  std::uint32_t srcH_ = 0;
  std::uint32_t outW_ = 0;
  std::uint32_t outH_ = 0;
  double fps_ = 30;
  double timeBase_ = 1;
  double startSec_ = 0;
  std::int64_t frames_ = 1;
  std::int64_t lastIndex_ = -1;
  bool haveLast_ = false;
  bool eof_ = false;
};

}  // namespace

std::unique_ptr<FrameSource> open_frames(const std::string& path, std::uint32_t maxEdge, std::string& error) {
  auto f = std::make_unique<FfmpegFrames>();
  if (!f->open(path, maxEdge, error)) return nullptr;
  return f;
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
