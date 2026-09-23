#include "media_fixture_ffi.hpp"

#include <algorithm>
#include <memory>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
}

namespace premation::media::fixture {

int fixture_code(int i, int band) noexcept { return ((i >> band) & 1) != 0 ? kBitOn : kBitOff; }
int fixture_alpha(int i) noexcept { return 40 + (i * 5) % 200; }

namespace {

struct CodecFreer {
  void operator()(AVCodecContext* c) const { avcodec_free_context(&c); }
};
struct FrameFreer {
  void operator()(AVFrame* f) const { av_frame_free(&f); }
};
struct PacketFreer {
  void operator()(AVPacket* p) const { av_packet_free(&p); }
};
struct OutputCloser {
  void operator()(AVFormatContext* f) const {
    if (f == nullptr) return;
    if (f->pb != nullptr) avio_closep(&f->pb);
    avformat_free_context(f);
  }
};

struct Setup {
  const char* encoder;
  AVPixelFormat pix;
  const char* ext;
};

Setup setup_of(Kind k) {
  switch (k) {
    case Kind::prores422: return {"prores_ks", AV_PIX_FMT_YUV422P10LE, "mov"};
    case Kind::prores4444: return {"prores_ks", AV_PIX_FMT_YUVA444P10LE, "mov"};
    case Kind::dnxhr: return {"dnxhd", AV_PIX_FMT_YUV422P, "mov"};
    case Kind::mpeg4: return {"mpeg4", AV_PIX_FMT_YUV420P, "mp4"};
    case Kind::vp9alpha: return {"libvpx-vp9", AV_PIX_FMT_YUVA420P, "webm"};
    case Kind::ffv1rgb: return {"ffv1", AV_PIX_FMT_GBRP10LE, "matroska"};
  }
  return {"", AV_PIX_FMT_NONE, ""};
}

void fill(AVFrame* f, const Spec& s, int i) {
  const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(static_cast<AVPixelFormat>(f->format));
  const int depth = d->comp[0].depth;
  const int scale = 1 << (depth - 8);
  const bool rgb = (d->flags & AV_PIX_FMT_FLAG_RGB) != 0;
  for (int c = 0; c < d->nb_components; ++c) {
    const int plane = d->comp[c].plane;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    const bool chroma = !rgb && (c == 1 || c == 2);
    const bool alpha = c == 3;
    const int w = chroma ? AV_CEIL_RSHIFT(s.width, d->log2_chroma_w) : s.width;
    const int h = chroma ? AV_CEIL_RSHIFT(s.height, d->log2_chroma_h) : s.height;
    for (int y = 0; y < h; ++y) {
      for (int x = 0; x < w; ++x) {
        int v = 0;
        if (alpha) {
          v = fixture_alpha(i);
        } else if (chroma) {
          v = 128;
        } else {
          // Left half: the frame index in 8 bands (in this plane's own columns); right half: a ramp.
          const int half = std::max(1, w / 2);
          v = x < half ? fixture_code(i, std::min(kBands - 1, x * kBands / half)) : 16 + (x * 200) / std::max(1, w);
        }
        v *= scale;
        std::uint8_t* row = f->data[plane] + static_cast<std::ptrdiff_t>(y) * f->linesize[plane];  // NOLINT
        if (depth > 8) {
          row[2 * x] = static_cast<std::uint8_t>(v & 0xFF);                  // NOLINT
          row[2 * x + 1] = static_cast<std::uint8_t>((v >> 8) & 0xFF);       // NOLINT
        } else {
          row[x] = static_cast<std::uint8_t>(v);  // NOLINT
        }
      }
    }
  }
}

}  // namespace

bool write(const Spec& spec, const std::string& path, std::string& error) {
  const Setup su = setup_of(spec.kind);
  const AVCodec* codec = avcodec_find_encoder_by_name(su.encoder);
  if (codec == nullptr) {
    error = std::string("encoder not built: ") + su.encoder;
    return false;
  }
  AVFormatContext* rawOut = nullptr;
  if (avformat_alloc_output_context2(&rawOut, nullptr, su.ext, path.c_str()) < 0) {
    error = "output context";
    return false;
  }
  std::unique_ptr<AVFormatContext, OutputCloser> out(rawOut);
  std::unique_ptr<AVCodecContext, CodecFreer> enc(avcodec_alloc_context3(codec));
  enc->width = spec.width;
  enc->height = spec.height;
  enc->pix_fmt = su.pix;
  enc->time_base = AVRational{spec.fpsDen, spec.fpsNum};
  enc->framerate = AVRational{spec.fpsNum, spec.fpsDen};
  enc->color_range = spec.kind == Kind::ffv1rgb ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;
  enc->colorspace = spec.kind == Kind::ffv1rgb ? AVCOL_SPC_RGB : AVCOL_SPC_BT709;
  enc->color_primaries = AVCOL_PRI_BT709;
  enc->color_trc = AVCOL_TRC_BT709;
  if ((out->oformat->flags & AVFMT_GLOBALHEADER) != 0) enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  switch (spec.kind) {
    case Kind::prores422: av_opt_set(enc->priv_data, "profile", "hq", 0); break;
    case Kind::prores4444:
      av_opt_set(enc->priv_data, "profile", "4444", 0);
      av_opt_set_int(enc->priv_data, "alpha_bits", 16, 0);
      break;
    case Kind::dnxhr: av_opt_set(enc->priv_data, "profile", "dnxhr_hq", 0); break;
    case Kind::mpeg4:
      enc->gop_size = 12;
      enc->max_b_frames = 2;
      enc->flags |= AV_CODEC_FLAG_QSCALE;
      enc->global_quality = FF_QP2LAMBDA * 2;
      break;
    case Kind::vp9alpha:
      enc->bit_rate = 4'000'000;
      enc->gop_size = 10;
      av_opt_set_int(enc->priv_data, "auto-alt-ref", 0, 0);
      av_opt_set_int(enc->priv_data, "lossless", 1, 0);
      break;
    case Kind::ffv1rgb: break;
  }
  if (const int rc = avcodec_open2(enc.get(), codec, nullptr); rc < 0) {
    error = std::string("open encoder ") + su.encoder;
    return false;
  }
  AVStream* st = avformat_new_stream(out.get(), nullptr);
  st->time_base = enc->time_base;
  avcodec_parameters_from_context(st->codecpar, enc.get());
  if (spec.kind == Kind::vp9alpha) av_dict_set(&st->metadata, "alpha_mode", "1", 0);
  if (avio_open(&out->pb, path.c_str(), AVIO_FLAG_WRITE) < 0) {
    error = "open " + path;
    return false;
  }
  if (avformat_write_header(out.get(), nullptr) < 0) {
    error = "write header";
    return false;
  }
  std::unique_ptr<AVPacket, PacketFreer> pkt(av_packet_alloc());
  auto drain = [&]() -> bool {
    for (;;) {
      const int rc = avcodec_receive_packet(enc.get(), pkt.get());
      if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return true;
      if (rc < 0) return false;
      av_packet_rescale_ts(pkt.get(), enc->time_base, st->time_base);
      pkt->stream_index = st->index;
      if (av_interleaved_write_frame(out.get(), pkt.get()) < 0) return false;
    }
  };
  for (int i = 0; i < spec.frames; ++i) {
    std::unique_ptr<AVFrame, FrameFreer> f(av_frame_alloc());
    f->format = su.pix;
    f->width = spec.width;
    f->height = spec.height;
    if (av_frame_get_buffer(f.get(), 0) < 0) {
      error = "frame buffer";
      return false;
    }
    fill(f.get(), spec, i);
    f->pts = i;
    if (avcodec_send_frame(enc.get(), f.get()) < 0 || !drain()) {
      error = "encode";
      return false;
    }
  }
  avcodec_send_frame(enc.get(), nullptr);
  if (!drain()) {
    error = "flush";
    return false;
  }
  av_write_trailer(out.get());
  return true;
}

}  // namespace premation::media::fixture
