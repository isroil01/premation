// ffmpeg behind audio_decode.hpp — the only audio file that includes libav*.
#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "audio_decode.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}

namespace premation::audio {

namespace {

struct FormatCloser {
  void operator()(AVFormatContext* c) const { avformat_close_input(&c); }
};
struct CodecFreer {
  void operator()(AVCodecContext* c) const { avcodec_free_context(&c); }
};
struct FrameFreer {
  void operator()(AVFrame* f) const { av_frame_free(&f); }
};
struct PacketFreer {
  void operator()(AVPacket* p) const { av_packet_free(&p); }
};
struct SwrFreer {
  void operator()(SwrContext* s) const { swr_free(&s); }
};
using FormatPtr = std::unique_ptr<AVFormatContext, FormatCloser>;
using CodecPtr = std::unique_ptr<AVCodecContext, CodecFreer>;
using AvFramePtr = std::unique_ptr<AVFrame, FrameFreer>;
using PacketPtr = std::unique_ptr<AVPacket, PacketFreer>;
using SwrPtr = std::unique_ptr<SwrContext, SwrFreer>;

std::string av_error(int code) {
  std::array<char, AV_ERROR_MAX_STRING_SIZE> buf{};
  av_strerror(code, buf.data(), buf.size());
  return {buf.data()};
}

/// One opened audio stream + its decoder.
struct Stream {
  FormatPtr fmt;
  CodecPtr dec;
  int index = -1;
  AVRational tb{1, 1};
  int sampleRate = 0;
  int channels = 0;

  bool open(const std::string& path, std::string& error) {
    AVFormatContext* raw = nullptr;
    int rc = avformat_open_input(&raw, path.c_str(), nullptr, nullptr);
    if (rc < 0) {
      error = "open " + path + ": " + av_error(rc);
      return false;
    }
    fmt.reset(raw);
    rc = avformat_find_stream_info(fmt.get(), nullptr);
    if (rc < 0) {
      error = "stream info: " + av_error(rc);
      return false;
    }
    const AVCodec* codec = nullptr;
    index = av_find_best_stream(fmt.get(), AVMEDIA_TYPE_AUDIO, -1, -1, &codec, 0);
    if (index < 0 || codec == nullptr) {
      error = "no audio stream";
      return false;
    }
    AVStream* st = fmt->streams[index];
    tb = st->time_base;
    dec.reset(avcodec_alloc_context3(codec));
    if (!dec) {
      error = "avcodec_alloc_context3";
      return false;
    }
    rc = avcodec_parameters_to_context(dec.get(), st->codecpar);
    if (rc < 0) {
      error = "codec parameters: " + av_error(rc);
      return false;
    }
    dec->pkt_timebase = st->time_base;  // lets libavcodec move pts past trimmed priming samples
    rc = avcodec_open2(dec.get(), codec, nullptr);
    if (rc < 0) {
      error = "avcodec_open2: " + av_error(rc);
      return false;
    }
    sampleRate = dec->sample_rate;
    channels = dec->ch_layout.nb_channels;
    if (sampleRate <= 0 || channels <= 0) {
      error = "audio stream has no rate / channels";
      return false;
    }
    return true;
  }
};

/// The Web Audio speaker down-mix as a swresample matrix (out × in, stride in).
std::vector<double> downmix_matrix(int in, int out) {
  std::vector<double> m(static_cast<std::size_t>(in) * static_cast<std::size_t>(out), 0.0);
  auto at = [&](int o, int i) -> double& { return m[static_cast<std::size_t>(o) * static_cast<std::size_t>(in) + static_cast<std::size_t>(i)]; };
  if (out == 1) {
    at(0, 0) = 1;  // mono stays mono
    return m;
  }
  const double s = std::sqrt(0.5);
  if (in == 1) {
    at(0, 0) = 1;
    at(1, 0) = 1;
  } else if (in == 4) {
    at(0, 0) = 0.5;
    at(0, 2) = 0.5;
    at(1, 1) = 0.5;
    at(1, 3) = 0.5;
  } else if (in == 6) {
    at(0, 0) = 1;
    at(0, 2) = s;
    at(0, 4) = s;
    at(1, 1) = 1;
    at(1, 2) = s;
    at(1, 5) = s;
  } else {
    at(0, 0) = 1;
    at(1, 1) = 1;  // discrete: the first two channels
  }
  return m;
}

/// Converts decoded frames to planar float, conformed channels, `outRate`.
class Converter {
 public:
  Converter(int outChannels, int outRate) : outCh_(outChannels), outRate_(outRate) {}

  bool setup(const AVFrame* f, std::string& error) {
    const int in = f->ch_layout.nb_channels;
    if (swr_ && in == inCh_ && f->format == inFmt_ && f->sample_rate == inRate_) return true;
    inCh_ = in;
    inFmt_ = f->format;
    inRate_ = f->sample_rate;
    AVChannelLayout inLayout{};
    av_channel_layout_default(&inLayout, in);
    AVChannelLayout outLayout{};
    av_channel_layout_default(&outLayout, outCh_);
    SwrContext* raw = nullptr;
    int rc = swr_alloc_set_opts2(&raw, &outLayout, AV_SAMPLE_FMT_FLTP, outRate_, &inLayout,
                                 static_cast<AVSampleFormat>(inFmt_), inRate_, 0, nullptr);
    av_channel_layout_uninit(&inLayout);
    av_channel_layout_uninit(&outLayout);
    if (rc < 0 || raw == nullptr) {
      error = "swr_alloc_set_opts2: " + av_error(rc);
      return false;
    }
    swr_.reset(raw);
    const std::vector<double> m = downmix_matrix(in, outCh_);
    rc = swr_set_matrix(swr_.get(), m.data(), in);
    if (rc < 0) {
      error = "swr_set_matrix: " + av_error(rc);
      return false;
    }
    rc = swr_init(swr_.get());
    if (rc < 0) {
      error = "swr_init: " + av_error(rc);
      return false;
    }
    return true;
  }

  /// Convert `f` (or flush with nullptr), appending to `out` planes.
  bool run(const AVFrame* f, std::vector<std::vector<float>>& out, std::string& error) {
    if (!swr_) return true;
    const int inSamples = f != nullptr ? f->nb_samples : 0;
    const int cap = swr_get_out_samples(swr_.get(), inSamples) + 32;
    if (cap <= 0) return true;
    scratch_.resize(static_cast<std::size_t>(outCh_));
    std::array<std::uint8_t*, 2> ptrs{};
    for (int c = 0; c < outCh_; ++c) {
      scratch_[static_cast<std::size_t>(c)].resize(static_cast<std::size_t>(cap));
      ptrs[static_cast<std::size_t>(c)] = reinterpret_cast<std::uint8_t*>(scratch_[static_cast<std::size_t>(c)].data());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): libswresample's byte-plane API
    }
    const int n = swr_convert(swr_.get(), ptrs.data(), cap,
                              f != nullptr ? const_cast<const std::uint8_t**>(f->extended_data) : nullptr,  // NOLINT(cppcoreguidelines-pro-type-const-cast)
                              inSamples);
    if (n < 0) {
      error = "swr_convert: " + av_error(n);
      return false;
    }
    for (int c = 0; c < outCh_; ++c) {
      auto& src = scratch_[static_cast<std::size_t>(c)];
      auto& dst = out[static_cast<std::size_t>(c)];
      dst.insert(dst.end(), src.begin(), src.begin() + n);
    }
    return true;
  }

  [[nodiscard]] bool ready() const noexcept { return static_cast<bool>(swr_); }
  /// Output frames of filter delay (the resampler's look-back).
  [[nodiscard]] std::int64_t delay_out() const noexcept {
    return swr_ ? swr_get_delay(swr_.get(), outRate_) : 0;
  }

 private:
  int outCh_;
  int outRate_;
  int inCh_ = 0, inFmt_ = -1, inRate_ = 0;
  SwrPtr swr_;
  std::vector<std::vector<float>> scratch_;
};

/// Decode loop: calls `onFrame(frame)` for every decoded frame; `onFrame`
/// returns false to stop early.
template <class F>
bool decode_loop(Stream& s, const std::atomic<bool>* cancel, std::string& error, const F& onFrame) {
  const PacketPtr pkt(av_packet_alloc());
  const AvFramePtr frame(av_frame_alloc());
  if (!pkt || !frame) {
    error = "out of memory";
    return false;
  }
  bool eof = false;
  while (true) {
    if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
      error = "cancelled";
      return false;
    }
    if (!eof) {
      const int rc = av_read_frame(s.fmt.get(), pkt.get());
      if (rc < 0) {
        eof = true;
        avcodec_send_packet(s.dec.get(), nullptr);
      } else {
        if (pkt->stream_index == s.index) {
          const int sr = avcodec_send_packet(s.dec.get(), pkt.get());
          if (sr < 0 && sr != AVERROR(EAGAIN) && sr != AVERROR_INVALIDDATA) {
            av_packet_unref(pkt.get());
            error = "send_packet: " + av_error(sr);
            return false;
          }
        }
        av_packet_unref(pkt.get());
      }
    }
    while (true) {
      const int rc = avcodec_receive_frame(s.dec.get(), frame.get());
      if (rc == AVERROR(EAGAIN)) break;
      if (rc == AVERROR_EOF) return true;
      if (rc < 0) {
        error = "receive_frame: " + av_error(rc);
        return false;
      }
      const bool more = onFrame(frame.get());
      av_frame_unref(frame.get());
      if (!more) return true;
    }
    if (eof) {
      // Drained on AVERROR_EOF above; a decoder that never reports it ends here.
      const int rc = avcodec_receive_frame(s.dec.get(), frame.get());
      if (rc == AVERROR_EOF || rc == AVERROR(EAGAIN)) return true;
    }
  }
}

}  // namespace

int conformed_channels(int sourceChannels) noexcept { return sourceChannels <= 1 ? 1 : 2; }

bool probe_audio(const std::string& path, AudioStreamInfo& out, std::string& error) {
  Stream s;
  out = AudioStreamInfo{};
  if (!s.open(path, error)) {
    if (error == "no audio stream") {
      error.clear();
      return true;  // a video with no sound: hasAudio = false
    }
    return false;
  }
  out.hasAudio = true;
  out.channels = s.channels;
  out.sampleRate = s.sampleRate;
  out.codec = avcodec_get_name(s.dec->codec_id);
  const AVStream* st = s.fmt->streams[s.index];
  if (st->duration > 0) {
    out.durationSec = static_cast<double>(st->duration) * av_q2d(st->time_base);
  } else if (s.fmt->duration > 0) {
    out.durationSec = static_cast<double>(s.fmt->duration) / AV_TIME_BASE;
  }
  return true;
}

bool conform_audio(const std::string& path, int targetRate, SourceData& sink, const std::atomic<bool>* cancel,
                   std::string& error) {
  Stream s;
  if (!s.open(path, error)) return false;
  const int outCh = sink.channels();
  Converter conv(outCh, targetRate);
  std::vector<std::vector<float>> buf(static_cast<std::size_t>(outCh));
  std::int64_t inTotal = 0;
  std::int64_t appended = 0;
  // Hold back the newest frames until the end, so the total can be trimmed to
  // exactly inTotal·targetRate/sourceRate once the flush is in.
  constexpr std::size_t kHold = 4096;
  auto push_ready = [&](bool final, std::int64_t limit) {
    const std::size_t have = buf[0].size();
    std::size_t take = final ? have : (have > kHold ? have - kHold : 0);
    if (limit >= 0) take = static_cast<std::size_t>(std::min<std::int64_t>(static_cast<std::int64_t>(take), std::max<std::int64_t>(0, limit - appended)));
    if (take == 0) return;
    std::array<const float*, 2> p{};
    for (int c = 0; c < outCh; ++c) p[static_cast<std::size_t>(c)] = buf[static_cast<std::size_t>(c)].data();
    sink.append(p.data(), take);
    appended += static_cast<std::int64_t>(take);
    for (auto& b : buf) b.erase(b.begin(), b.begin() + static_cast<std::ptrdiff_t>(take));
  };
  int inRate = s.sampleRate;
  const bool ok = decode_loop(s, cancel, error, [&](AVFrame* f) {
    if (!conv.setup(f, error)) return false;
    inRate = f->sample_rate;
    inTotal += f->nb_samples;
    if (!conv.run(f, buf, error)) return false;
    push_ready(false, -1);
    return true;
  });
  if (!ok) {
    sink.fail(error);
    return false;
  }
  if (conv.ready() && !conv.run(nullptr, buf, error)) {
    sink.fail(error);
    return false;
  }
  const auto expected = static_cast<std::int64_t>(
      std::llround(static_cast<double>(inTotal) * static_cast<double>(targetRate) / static_cast<double>(std::max(1, inRate))));
  push_ready(true, expected);
  // Short of the expected length (a truncated flush): pad with silence.
  if (appended < expected) {
    const auto pad = static_cast<std::size_t>(expected - appended);
    std::vector<float> zeros(pad, 0.0F);
    std::array<const float*, 2> p{zeros.data(), zeros.data()};
    sink.append(p.data(), pad);
  }
  sink.finish();
  return true;
}

bool decode_all_native(const std::string& path, std::vector<std::vector<float>>& out, std::string& error) {
  Stream s;
  if (!s.open(path, error)) return false;
  const int outCh = conformed_channels(s.channels);
  Converter conv(outCh, s.sampleRate);
  out.assign(static_cast<std::size_t>(outCh), {});
  const bool ok = decode_loop(s, nullptr, error, [&](AVFrame* f) {
    if (!conv.setup(f, error)) return false;
    return conv.run(f, out, error);
  });
  if (!ok) return false;
  return conv.run(nullptr, out, error);
}

bool decode_range(const std::string& path, std::int64_t from, std::int64_t n, std::vector<std::vector<float>>& out,
                  std::string& error) {
  Stream s;
  if (!s.open(path, error)) return false;
  const int outCh = conformed_channels(s.channels);
  const AVRational sampleTb{1, s.sampleRate};
  // Sample 0 of the linear decode = the timestamp of the first frame a fresh
  // decoder produces (after the codec's priming samples are trimmed).
  std::int64_t origin = 0;
  {
    bool got = false;
    const bool ok = decode_loop(s, nullptr, error, [&](AVFrame* f) {
      const std::int64_t ts = f->best_effort_timestamp != AV_NOPTS_VALUE ? f->best_effort_timestamp : f->pts;
      origin = ts != AV_NOPTS_VALUE ? av_rescale_q(ts, s.tb, sampleTb) : 0;
      got = true;
      return false;
    });
    if (!ok || !got) {
      if (error.empty()) error = "no decodable audio";
      return false;
    }
  }
  // Seek a pre-roll before the target: codecs with overlapped transforms (AAC,
  // Opus, Vorbis) need the previous frames to reconstruct the first one.
  const std::int64_t preroll = s.sampleRate;  // 1 s
  if (from - preroll <= 0) {
    // Within the pre-roll of the start: decode from the very first packet —
    // a seek to "0" would land on the first packet AFTER the codec's priming
    // packet (MP4 AAC's edit list), and that one frame would decode wrong.
    s = Stream{};
    if (!s.open(path, error)) return false;
  } else {
    const std::int64_t seekTs = av_rescale_q(from - preroll + origin, sampleTb, s.tb);
    const int rc = av_seek_frame(s.fmt.get(), s.index, seekTs, AVSEEK_FLAG_BACKWARD);
    if (rc < 0) {
      error = "seek: " + av_error(rc);
      return false;
    }
    avcodec_flush_buffers(s.dec.get());
  }
  Converter conv(outCh, s.sampleRate);
  out.assign(static_cast<std::size_t>(outCh), std::vector<float>(static_cast<std::size_t>(std::max<std::int64_t>(0, n)), 0.0F));
  std::vector<std::vector<float>> tmp(static_cast<std::size_t>(outCh));
  std::int64_t filledTo = from;
  const bool ok = decode_loop(s, nullptr, error, [&](AVFrame* f) {
    if (!conv.setup(f, error)) return false;
    const std::int64_t ts = f->best_effort_timestamp != AV_NOPTS_VALUE ? f->best_effort_timestamp : f->pts;
    for (auto& t : tmp) t.clear();
    if (!conv.run(f, tmp, error)) return false;
    const std::int64_t start = ts != AV_NOPTS_VALUE ? av_rescale_q(ts, s.tb, sampleTb) - origin : filledTo;
    const auto len = static_cast<std::int64_t>(tmp[0].size());
    for (std::int64_t i = 0; i < len; ++i) {
      const std::int64_t k = start + i - from;
      if (k < 0 || k >= n) continue;
      for (int c = 0; c < outCh; ++c) {
        out[static_cast<std::size_t>(c)][static_cast<std::size_t>(k)] = tmp[static_cast<std::size_t>(c)][static_cast<std::size_t>(i)];
      }
    }
    filledTo = start + len;
    return filledTo < from + n;
  });
  return ok;
}

}  // namespace premation::audio
