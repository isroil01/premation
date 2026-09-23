#include "audio_fixture_ffi.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
}

namespace premation::audio::fixture {

namespace {

struct OutCloser {
  void operator()(AVFormatContext* c) const {
    if (c == nullptr) return;
    if (c->pb != nullptr) avio_closep(&c->pb);
    avformat_free_context(c);
  }
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

std::string err(int rc) {
  std::array<char, AV_ERROR_MAX_STRING_SIZE> b{};
  av_strerror(rc, b.data(), b.size());
  return {b.data()};
}

std::int16_t to16(float v) {
  const float c = std::max(-1.0F, std::min(1.0F, v));
  return static_cast<std::int16_t>(std::lrint(c * 32767.0F));
}

}  // namespace

bool write(const std::string& path, Codec codec, const std::vector<std::vector<float>>& planes, int sampleRate,
           std::string& error) {
  const char* muxer = "wav";
  const char* encName = "pcm_s16le";
  AVSampleFormat sf = AV_SAMPLE_FMT_S16;
  switch (codec) {
    case Codec::wavPcm16:
      break;
    case Codec::wavFloat:
      encName = "pcm_f32le";
      sf = AV_SAMPLE_FMT_FLT;
      break;
    case Codec::flac:
      muxer = "flac";
      encName = "flac";
      sf = AV_SAMPLE_FMT_S16;
      break;
    case Codec::aacMp4:
      muxer = "mp4";
      encName = "aac";
      sf = AV_SAMPLE_FMT_FLTP;
      break;
  }
  const int channels = static_cast<int>(planes.size());
  const auto frames = static_cast<std::int64_t>(planes.empty() ? 0 : planes[0].size());

  AVFormatContext* rawOc = nullptr;
  int rc = avformat_alloc_output_context2(&rawOc, nullptr, muxer, path.c_str());
  if (rc < 0 || rawOc == nullptr) {
    error = "alloc output: " + err(rc);
    return false;
  }
  const std::unique_ptr<AVFormatContext, OutCloser> oc(rawOc);
  const AVCodec* enc = avcodec_find_encoder_by_name(encName);
  if (enc == nullptr) {
    error = std::string("no encoder ") + encName;
    return false;
  }
  const std::unique_ptr<AVCodecContext, CodecFreer> ctx(avcodec_alloc_context3(enc));
  ctx->sample_rate = sampleRate;
  ctx->sample_fmt = sf;
  av_channel_layout_default(&ctx->ch_layout, channels);
  ctx->time_base = AVRational{1, sampleRate};
  if (codec == Codec::aacMp4) ctx->bit_rate = 256000;
  if ((oc->oformat->flags & AVFMT_GLOBALHEADER) != 0) ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  rc = avcodec_open2(ctx.get(), enc, nullptr);
  if (rc < 0) {
    error = "open encoder: " + err(rc);
    return false;
  }
  AVStream* st = avformat_new_stream(oc.get(), nullptr);
  avcodec_parameters_from_context(st->codecpar, ctx.get());
  st->time_base = ctx->time_base;
  rc = avio_open(&oc->pb, path.c_str(), AVIO_FLAG_WRITE);
  if (rc < 0) {
    error = "avio_open: " + err(rc);
    return false;
  }
  rc = avformat_write_header(oc.get(), nullptr);
  if (rc < 0) {
    error = "write header: " + err(rc);
    return false;
  }
  const std::unique_ptr<AVPacket, PacketFreer> pkt(av_packet_alloc());
  auto drain = [&]() -> bool {
    while (true) {
      const int r = avcodec_receive_packet(ctx.get(), pkt.get());
      if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return true;
      if (r < 0) {
        error = "receive packet: " + err(r);
        return false;
      }
      av_packet_rescale_ts(pkt.get(), ctx->time_base, st->time_base);
      pkt->stream_index = st->index;
      if (av_interleaved_write_frame(oc.get(), pkt.get()) < 0) {
        error = "write frame";
        return false;
      }
    }
  };
  const int chunk = ctx->frame_size > 0 ? ctx->frame_size : 1024;
  for (std::int64_t pos = 0; pos < frames; pos += chunk) {
    const int n = static_cast<int>(std::min<std::int64_t>(chunk, frames - pos));
    const std::unique_ptr<AVFrame, FrameFreer> f(av_frame_alloc());
    f->nb_samples = n;
    f->format = sf;
    f->sample_rate = sampleRate;
    av_channel_layout_copy(&f->ch_layout, &ctx->ch_layout);
    if (av_frame_get_buffer(f.get(), 0) < 0) {
      error = "frame buffer";
      return false;
    }
    for (int i = 0; i < n; ++i) {
      const auto k = static_cast<std::size_t>(pos + i);
      for (int c = 0; c < channels; ++c) {
        const float v = planes[static_cast<std::size_t>(c)][k];
        switch (sf) {
          case AV_SAMPLE_FMT_S16:
            reinterpret_cast<std::int16_t*>(f->data[0])[i * channels + c] = to16(v);  // NOLINT
            break;
          case AV_SAMPLE_FMT_FLT:
            reinterpret_cast<float*>(f->data[0])[i * channels + c] = v;  // NOLINT
            break;
          case AV_SAMPLE_FMT_FLTP:
            reinterpret_cast<float*>(f->extended_data[c])[i] = v;  // NOLINT
            break;
          default:
            break;
        }
      }
    }
    f->pts = pos;
    if (avcodec_send_frame(ctx.get(), f.get()) < 0) {
      error = "send frame";
      return false;
    }
    if (!drain()) return false;
  }
  avcodec_send_frame(ctx.get(), nullptr);
  if (!drain()) return false;
  av_write_trailer(oc.get());
  return true;
}

}  // namespace premation::audio::fixture
