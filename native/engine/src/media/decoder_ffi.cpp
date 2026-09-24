// ffmpeg behind VideoDecoder / HwContext — the only file that includes libav*.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <utility>

#include "decoder.hpp"
#include "yuv.hpp"

#if defined(_WIN32)
#include <d3d11.h>  // before libav's hwcontext_d3d11va.h, which must not pull it in under extern "C"

#include "cuda_ffi.hpp"
#include "d3d11_ffi.hpp"
#endif

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/display.h>
#include <libavutil/hwcontext.h>
#include <libavutil/mastering_display_metadata.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
#if defined(_WIN32)
#include <libavutil/hwcontext_d3d11va.h>
#endif
}

namespace premation::media {

const char* to_string(DecodePath p) noexcept {
  switch (p) {
    case DecodePath::software: return "software";
    case DecodePath::d3d11va: return "d3d11va";
    case DecodePath::d3d12va: return "d3d12va";
    case DecodePath::dxva2: return "dxva2";
    case DecodePath::nvdec: return "nvdec";
    case DecodePath::videotoolbox: return "videotoolbox";
    case DecodePath::vaapi: return "vaapi";
    case DecodePath::vulkan: return "vulkan";
  }
  return "?";
}

namespace {

// ── RAII over libav ─────────────────────────────────────────────────────────
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
struct BufferUnref {
  void operator()(AVBufferRef* b) const { av_buffer_unref(&b); }
};
struct SwsFreer {
  void operator()(SwsContext* s) const { sws_freeContext(s); }
};
using FormatPtr = std::unique_ptr<AVFormatContext, FormatCloser>;
using CodecPtr = std::unique_ptr<AVCodecContext, CodecFreer>;
using AvFramePtr = std::unique_ptr<AVFrame, FrameFreer>;
using PacketPtr = std::unique_ptr<AVPacket, PacketFreer>;
using BufferPtr = std::unique_ptr<AVBufferRef, BufferUnref>;
using SwsPtr = std::unique_ptr<SwsContext, SwsFreer>;

std::string av_error(int code) {
  std::array<char, AV_ERROR_MAX_STRING_SIZE> buf{};
  av_strerror(code, buf.data(), buf.size());
  return {buf.data()};
}

Rational rational_of(AVRational r) { return {r.num, r.den}; }

/// libav's flag words and flag macros are plain (signed) ints: test bits unsigned.
template <typename V, typename F>
constexpr bool has_flag(V value, F flag) noexcept {
  return (static_cast<std::uint64_t>(value) & static_cast<std::uint64_t>(flag)) != 0U;
}

bool open_format(const std::string& path, FormatPtr& out, std::string& error) {
  AVFormatContext* raw = nullptr;
  const int rc = avformat_open_input(&raw, path.c_str(), nullptr, nullptr);
  if (rc < 0) {
    error = "open " + path + ": " + av_error(rc);
    return false;
  }
  out.reset(raw);
  const int si = avformat_find_stream_info(raw, nullptr);
  if (si < 0) {
    error = "stream info: " + av_error(si);
    return false;
  }
  return true;
}

int best_video_stream(AVFormatContext* fmt) {
  for (unsigned i = 0; i < fmt->nb_streams; ++i) {
    const AVStream* st = fmt->streams[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): libav array
    if (st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && !has_flag(st->disposition, AV_DISPOSITION_ATTACHED_PIC)) {
      return av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    }
  }
  return -1;
}

bool vp9_alpha(const AVStream* st) {
  const AVDictionaryEntry* e = av_dict_get(st->metadata, "alpha_mode", nullptr, 0);
  return e != nullptr && std::strcmp(e->value, "1") == 0;
}

/// A pix_fmt's texel layout, when the GPU conversion can take its planes as they are.
bool frame_format_of(AVPixelFormat pf, FrameFormat& f) {
  const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(pf);
  if (d == nullptr) return false;
  const std::uint64_t fl = d->flags;
  for (const auto flag : {AV_PIX_FMT_FLAG_BE, AV_PIX_FMT_FLAG_PAL, AV_PIX_FMT_FLAG_BITSTREAM, AV_PIX_FMT_FLAG_HWACCEL,
                          AV_PIX_FMT_FLAG_FLOAT, AV_PIX_FMT_FLAG_BAYER}) {
    if (has_flag(fl, flag)) return false;
  }
  if (d->nb_components < 3) return false;  // gray: swscale to RGBA
  const int depth = d->comp[0].depth;
  const int shift = d->comp[0].shift;
  for (int c = 0; std::cmp_less(c, d->nb_components); ++c) {
    if (d->comp[c].depth != depth || d->comp[c].shift != shift) return false;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  }
  if (depth > 16) return false;
  const int bytes = depth > 8 ? 2 : 1;
  f.bitDepth = static_cast<std::uint8_t>(depth);
  f.bytesPerSample = static_cast<std::uint8_t>(bytes);
  f.storageShift = static_cast<std::uint8_t>(shift);
  f.chromaShiftX = d->log2_chroma_w;
  f.chromaShiftY = d->log2_chroma_h;
  f.hasAlpha = has_flag(fl, AV_PIX_FMT_FLAG_ALPHA);
  const bool planar = has_flag(fl, AV_PIX_FMT_FLAG_PLANAR);
  if (!planar) return false;  // packed YUV / RGB: swscale
  const bool rgb = has_flag(fl, AV_PIX_FMT_FLAG_RGB);
  const auto& c = d->comp;
  if (c[1].plane == c[2].plane) {
    // Semi-planar: UV interleaved, U first (NV21-style V-first goes through swscale).
    if (rgb || c[1].offset > c[2].offset || c[1].step != 2 * bytes || c[0].step != bytes) return false;
    f.layout = Layout::semiPlanarYuv;
    return !f.hasAlpha;
  }
  for (int i = 0; std::cmp_less(i, d->nb_components); ++i) {
    if (c[i].step != bytes || c[i].offset != 0) return false;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  }
  f.layout = rgb ? Layout::planarRgb : Layout::planarYuv;
  if (rgb) {
    f.matrix = Matrix::rgb;
    f.chromaShiftX = 0;
    f.chromaShiftY = 0;
  }
  return true;
}

Primaries prim_of(AVColorPrimaries p) { return static_cast<Primaries>(static_cast<std::uint8_t>(p)); }
Transfer trc_of(AVColorTransferCharacteristic t) { return static_cast<Transfer>(static_cast<std::uint8_t>(t)); }
Matrix mat_of(AVColorSpace s) { return static_cast<Matrix>(static_cast<std::uint8_t>(s)); }
Range range_of(AVColorRange r) {
  if (r == AVCOL_RANGE_JPEG) return Range::full;
  if (r == AVCOL_RANGE_MPEG) return Range::limited;
  return Range::unspecified;
}

double q2d(AVRational r) { return r.den != 0 ? static_cast<double>(r.num) / r.den : 0.0; }

void fill_mastering(const AVMasteringDisplayMetadata* m, ColorInfo& c) {
  if (m == nullptr || m->has_primaries == 0) return;
  MasteringDisplay md;
  for (std::size_t i = 0; i < 3; ++i) {
    md.primaries[i][0] = q2d(m->display_primaries[i][0]);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    md.primaries[i][1] = q2d(m->display_primaries[i][1]);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  }
  md.whitePoint[0] = q2d(m->white_point[0]);
  md.whitePoint[1] = q2d(m->white_point[1]);
  if (m->has_luminance != 0) {
    md.minLuminance = q2d(m->min_luminance);
    md.maxLuminance = q2d(m->max_luminance);
  }
  c.mastering = md;
}

void fill_light(const AVContentLightMetadata* l, ColorInfo& c) {
  if (l == nullptr) return;
  c.contentLight = ContentLight{l->MaxCLL, l->MaxFALL};
}

/// Container-level facts + colour for the chosen stream. `index` is left to the caller.
bool fill_info(AVFormatContext* fmt, int si, MediaInfo& info, std::string& error) {
  if (si < 0) {
    error = "no video stream";
    return false;
  }
  const AVStream* st = fmt->streams[si];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const AVCodecParameters* cp = st->codecpar;
  info.container = fmt->iformat != nullptr && fmt->iformat->name != nullptr ? fmt->iformat->name : "";
  info.durationSec = fmt->duration > 0 ? static_cast<double>(fmt->duration) / AV_TIME_BASE : 0;
  for (unsigned i = 0; i < fmt->nb_streams; ++i) {
    if (fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) info.hasAudio = true;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  VideoInfo v;
  v.streamIndex = si;
  v.codec = avcodec_get_name(cp->codec_id);
  if (const char* prof = avcodec_profile_name(cp->codec_id, cp->profile); prof != nullptr) v.profile = prof;
  const auto pf = static_cast<AVPixelFormat>(cp->format);
  if (const char* name = av_get_pix_fmt_name(pf); name != nullptr) v.pixelFormat = name;
  v.width = static_cast<std::uint32_t>(std::max(0, cp->width));
  v.height = static_cast<std::uint32_t>(std::max(0, cp->height));
  if (cp->sample_aspect_ratio.num > 0 && cp->sample_aspect_ratio.den > 0) v.sampleAspect = rational_of(cp->sample_aspect_ratio);
  v.fps = st->r_frame_rate.num > 0 && st->r_frame_rate.den > 0 ? rational_of(st->r_frame_rate) : rational_of(st->avg_frame_rate);
  v.timeBase = rational_of(st->time_base);
  v.startPts = st->start_time != AV_NOPTS_VALUE ? st->start_time : 0;
  v.durationSec = st->duration > 0 ? static_cast<double>(st->duration) * q2d(st->time_base) : info.durationSec;
  if (st->nb_frames > 0) {
    v.frameCount = st->nb_frames;
  } else if (v.fps.valid()) {
    v.frameCount = static_cast<std::int64_t>(std::floor(v.durationSec * v.fps.value() + 0.5));
  }
  if (const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(pf); d != nullptr) {
    v.bitDepth = static_cast<std::uint8_t>(d->comp[0].depth);
    v.chromaShiftX = d->log2_chroma_w;
    v.chromaShiftY = d->log2_chroma_h;
    v.hasAlpha = has_flag(d->flags, AV_PIX_FMT_FLAG_ALPHA);
  }
  if (cp->codec_id == AV_CODEC_ID_VP9 || cp->codec_id == AV_CODEC_ID_VP8) v.hasAlpha = v.hasAlpha || vp9_alpha(st);
  if (const AVCodecDescriptor* cd = avcodec_descriptor_get(cp->codec_id); cd != nullptr) {
    v.intraOnly = has_flag(cd->props, AV_CODEC_PROP_INTRA_ONLY);
  }
  if (const AVPacketSideData* sd = av_packet_side_data_get(cp->coded_side_data, cp->nb_coded_side_data, AV_PKT_DATA_DISPLAYMATRIX);
      sd != nullptr && sd->size >= 9 * sizeof(std::int32_t)) {
    const double ccw = av_display_rotation_get(reinterpret_cast<const std::int32_t*>(sd->data));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): libav side data
    if (std::isfinite(ccw)) v.rotation = ((static_cast<int>(-std::lround(ccw)) % 360) + 360) % 360;
  }
  ColorInfo& c = v.color;
  c.primaries = prim_of(cp->color_primaries);
  c.transfer = trc_of(cp->color_trc);
  c.matrix = mat_of(cp->color_space);
  c.range = range_of(cp->color_range);
  if (pf == AV_PIX_FMT_YUVJ420P || pf == AV_PIX_FMT_YUVJ422P || pf == AV_PIX_FMT_YUVJ444P) c.range = Range::full;
  if ((av_pix_fmt_desc_get(pf) != nullptr) && has_flag(av_pix_fmt_desc_get(pf)->flags, AV_PIX_FMT_FLAG_RGB)) c.matrix = Matrix::rgb;
  c.resolvedMatrix = resolve_matrix(c.matrix, c.primaries, v.height);
  c.resolvedRange = c.matrix == Matrix::rgb && c.range == Range::unspecified ? Range::full : resolve_range(c.range);
  if (const AVPacketSideData* sd = av_packet_side_data_get(cp->coded_side_data, cp->nb_coded_side_data, AV_PKT_DATA_MASTERING_DISPLAY_METADATA);
      sd != nullptr) {
    fill_mastering(reinterpret_cast<const AVMasteringDisplayMetadata*>(sd->data), c);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  }
  if (const AVPacketSideData* sd = av_packet_side_data_get(cp->coded_side_data, cp->nb_coded_side_data, AV_PKT_DATA_CONTENT_LIGHT_LEVEL);
      sd != nullptr) {
    fill_light(reinterpret_cast<const AVContentLightMetadata*>(sd->data), c);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  }
  info.video = v;
  return true;
}

/// The container's own index, when it gives presentation times for every
/// sample: an intra-only or non-reordering stream whose index lists every
/// sample (MOV/MP4 do; Matroska lists only cue points). pts = dts + (start − first dts).
bool index_from_container(const AVStream* st, const VideoInfo& v, FrameIndex& out) {
  const bool noReorder = v.intraOnly || st->codecpar->video_delay == 0;
  if (!noReorder) return false;
  const int n = avformat_index_get_entries_count(st);
  if (n <= 0) return false;
  std::vector<SampleEntry> samples;
  samples.reserve(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    const AVIndexEntry* e = avformat_index_get_entry(const_cast<AVStream*>(st), i);  // NOLINT(cppcoreguidelines-pro-type-const-cast): libav takes non-const
    if (e == nullptr || has_flag(e->flags, AVINDEX_DISCARD_FRAME)) continue;
    samples.push_back({e->timestamp, has_flag(e->flags, AVINDEX_KEYFRAME)});
  }
  if (samples.empty()) return false;
  // Every sample, not just the seek points.
  if (v.frameCount > 0 && std::cmp_less(samples.size(), v.frameCount)) return false;
  const std::int64_t offset = st->start_time != AV_NOPTS_VALUE ? st->start_time - samples.front().pts : 0;
  for (auto& s : samples) s.pts += offset;
  out = FrameIndex::from_samples(samples, v.timeBase);
  return true;
}

// ── hardware ────────────────────────────────────────────────────────────────
AVHWDeviceType device_type_of(DecodePath p) {
  switch (p) {
    case DecodePath::d3d11va: return AV_HWDEVICE_TYPE_D3D11VA;
    case DecodePath::d3d12va: return AV_HWDEVICE_TYPE_D3D12VA;
    case DecodePath::dxva2: return AV_HWDEVICE_TYPE_DXVA2;
    case DecodePath::nvdec: return AV_HWDEVICE_TYPE_CUDA;
    case DecodePath::videotoolbox: return AV_HWDEVICE_TYPE_VIDEOTOOLBOX;
    case DecodePath::vaapi: return AV_HWDEVICE_TYPE_VAAPI;
    case DecodePath::vulkan: return AV_HWDEVICE_TYPE_VULKAN;
    case DecodePath::software: break;
  }
  return AV_HWDEVICE_TYPE_NONE;
}

}  // namespace

class HwContext {
 public:
  DecodePath path = DecodePath::software;
  BufferPtr device;  // AVHWDeviceContext
  std::string adapter;
#if defined(_WIN32)
  std::unique_ptr<d3d11::Device> d3d11;  // set for d3d11va: our device, so surfaces can be shared
#endif
};

namespace {
#if defined(_WIN32)
void d3d11_lock(void* ctx) { static_cast<d3d11::Device*>(ctx)->lock(); }
void d3d11_unlock(void* ctx) { static_cast<d3d11::Device*>(ctx)->unlock(); }
#endif
}  // namespace

std::shared_ptr<HwContext> create_hw_context(const HwContextOptions& options, std::string& error) {
  auto hw = std::make_shared<HwContext>();
  DecodePath p = options.preferred;
#if defined(__APPLE__)
  p = DecodePath::videotoolbox;
#elif defined(__linux__)
  if (p != DecodePath::nvdec && p != DecodePath::vulkan) p = DecodePath::vaapi;
#endif
  const AVHWDeviceType type = device_type_of(p);
  if (type == AV_HWDEVICE_TYPE_NONE) {
    error = "no hardware device type for this path";
    return nullptr;
  }
  hw->path = p;
#if defined(_WIN32)
  if (p == DecodePath::d3d11va) {
    hw->d3d11 = d3d11::Device::create(options.adapterLuid, error);
    if (!hw->d3d11) return nullptr;
    BufferPtr ref(av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA));
    if (!ref) {
      error = "av_hwdevice_ctx_alloc(d3d11va) failed";
      return nullptr;
    }
    auto* dev = reinterpret_cast<AVHWDeviceContext*>(ref->data);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): libav opaque buffer
    auto* d3d = static_cast<AVD3D11VADeviceContext*>(dev->hwctx);
    d3d->device = static_cast<ID3D11Device*>(hw->d3d11->native_device());
    d3d->device->AddRef();  // ffmpeg releases its reference on uninit
    d3d->lock = d3d11_lock;
    d3d->unlock = d3d11_unlock;
    d3d->lock_ctx = hw->d3d11.get();
    const int rc = av_hwdevice_ctx_init(ref.get());
    if (rc < 0) {
      error = "av_hwdevice_ctx_init(d3d11va): " + av_error(rc);
      return nullptr;
    }
    hw->device = std::move(ref);
    hw->adapter = hw->d3d11->adapter_name();
    return hw;
  }
#endif
  AVBufferRef* raw = nullptr;
  std::string deviceName;
  std::string adapterName = to_string(p);
#if defined(_WIN32)
  if (p == DecodePath::nvdec) {
    // CUDA ordinals are not DXGI's order: decode on the CUDA device that IS the
    // render adapter, or not at all (a frame must never cross GPUs silently).
    const cuda::DeviceMatch m = cuda::device_for_luid(options.adapterLuid, error);
    if (m.ordinal < 0) return nullptr;
    deviceName = std::to_string(m.ordinal);
    adapterName = m.name + " (CUDA " + deviceName + ")";
  }
#endif
  const int rc = av_hwdevice_ctx_create(&raw, type, deviceName.empty() ? nullptr : deviceName.c_str(), nullptr, 0);
  if (rc < 0) {
    error = std::string("av_hwdevice_ctx_create(") + to_string(p) + "): " + av_error(rc);
    return nullptr;
  }
  hw->device.reset(raw);
  hw->adapter = adapterName;
  return hw;
}

DecodePath hw_path(const HwContext& hw) noexcept { return hw.path; }
std::string hw_adapter(const HwContext& hw) { return hw.adapter; }

namespace {

/// A decoded frame backed by an AVFrame (CPU planes) or a shared GPU surface.
class AvDecodedFrame final : public DecodedFrame {
 public:
  AvFramePtr frame;
  std::unique_ptr<GpuSurface> surface;
};

class FfmpegDecoder final : public VideoDecoder {
 public:
  [[nodiscard]] const MediaInfo& info() const noexcept override { return info_; }
  [[nodiscard]] const FrameIndex& index() const noexcept override { return index_; }
  [[nodiscard]] DecodePath path() const noexcept override { return path_; }
  [[nodiscard]] std::int64_t position() const noexcept override { return position_; }
  [[nodiscard]] std::int64_t seeked_gop() const noexcept override { return seekGop_; }
  [[nodiscard]] const std::string& hw_fallback() const noexcept override { return fallback_; }
  void set_index(FrameIndex index) override {
    index_ = std::move(index);
    video_->exactIndex = index_.exact();
    if (index_.size() > 0) video_->frameCount = index_.size();
    position_ = -1;  // force a seek: positions may have been counted with the old numbering
  }

  bool init(const std::string& path, const DecoderOptions& opt, std::string& error);
  bool seek(std::int64_t frame, std::string& error) override;
  DecodeStatus next(FramePtr& out, std::string& error, const std::atomic<std::uint64_t>* cancel,
                    std::uint64_t generation) override;

  static AVPixelFormat get_format(AVCodecContext* ctx, const AVPixelFormat* fmts);

 private:
  bool wrap(AvFramePtr f, FramePtr& out, std::string& error);
  bool open_codec(const AVCodec* dec, bool wantHw, std::string& error);
  /// Continue this clip in software after the hardware decoder refused or failed (`why`, logged via hw_fallback()).
  bool reopen_software(const std::string& why, std::string& error);
  bool to_cpu_planes(AvDecodedFrame& d, std::string& error);

  MediaInfo info_;
  VideoInfo* video_ = nullptr;  // &*info_.video once init() found a stream (always, for a live decoder)
  FrameIndex index_;
  DecoderOptions opt_;
  FormatPtr fmt_;
  CodecPtr codec_;
  PacketPtr pkt_;
  SwsPtr sws_;
  int stream_ = -1;
  AVPixelFormat hwFmt_ = AV_PIX_FMT_NONE;
  DecodePath path_ = DecodePath::software;
  bool draining_ = false;
  bool eof_ = false;
  std::int64_t position_ = -1;
  std::int64_t seekGop_ = -1;
  std::int64_t target_ = -1;
  bool retried_ = false;
  std::int64_t hwFrames_ = 0;  // frames delivered by the hardware decoder (fault injection counts these)
  std::string fallback_;       // why this clip left the hardware decoder ("" = it didn't)
};

AVPixelFormat FfmpegDecoder::get_format(AVCodecContext* ctx, const AVPixelFormat* fmts) {
  const auto* self = static_cast<const FfmpegDecoder*>(ctx->opaque);
  for (const AVPixelFormat* p = fmts; *p != AV_PIX_FMT_NONE; ++p) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): libav list
    if (*p == self->hwFmt_) return *p;
  }
  // The hardware decoder refused this stream (profile, size, chroma): software.
  for (const AVPixelFormat* p = fmts; *p != AV_PIX_FMT_NONE; ++p) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(*p);
    if (d != nullptr && !has_flag(d->flags, AV_PIX_FMT_FLAG_HWACCEL)) return *p;
  }
  return fmts[0];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): libav list
}

bool FfmpegDecoder::init(const std::string& path, const DecoderOptions& opt, std::string& error) {
  opt_ = opt;
  info_.path = path;
  if (!open_format(path, fmt_, error)) return false;
  stream_ = best_video_stream(fmt_.get());
  if (!fill_info(fmt_.get(), stream_, info_, error) || !info_.video) return false;
  video_ = &*info_.video;
  VideoInfo& v = *video_;
  AVStream* st = fmt_->streams[stream_];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (unsigned i = 0; i < fmt_->nb_streams; ++i) {
    if (std::cmp_not_equal(i, stream_)) fmt_->streams[i]->discard = AVDISCARD_ALL;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }

  // Index: the container's, else a demux-only scan, else constant-rate.
  if (!index_from_container(st, v, index_)) {
    std::string scanError;
    if (!(opt.scanIndex && scan_index(path, stream_, index_, scanError))) {
      index_ = FrameIndex::constant_rate(v.frameCount, v.fps, v.timeBase, v.startPts);
    }
  }
  v.exactIndex = index_.exact();
  if (index_.size() > 0) v.frameCount = index_.size();

  // Decoder: libvpx for alpha VP8/VP9 (the native decoders drop the alpha side channel).
  const AVCodec* dec = nullptr;
  if (v.hasAlpha && st->codecpar->codec_id == AV_CODEC_ID_VP9) dec = avcodec_find_decoder_by_name("libvpx-vp9");
  if (v.hasAlpha && st->codecpar->codec_id == AV_CODEC_ID_VP8) dec = avcodec_find_decoder_by_name("libvpx");
  if (dec == nullptr) dec = avcodec_find_decoder(st->codecpar->codec_id);
  if (dec == nullptr) {
    error = "no decoder for " + v.codec;
    return false;
  }
  codec_ = nullptr;
  const bool wantHw = opt.hw != HwPolicy::softwareOnly && opt.hwContext && opt.hwContext->device;
  if (!open_codec(dec, wantHw, error)) return false;
  if (path_ == DecodePath::software && opt.hw == HwPolicy::hardwareOnly) {
    error = "no hardware decoder for " + v.codec;
    return false;
  }
  pkt_.reset(av_packet_alloc());
  return true;
}

bool FfmpegDecoder::open_codec(const AVCodec* dec, bool wantHw, std::string& error) {
  const VideoInfo& v = *video_;
  const AVStream* st = fmt_->streams[stream_];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  codec_.reset(avcodec_alloc_context3(dec));
  if (!codec_ || avcodec_parameters_to_context(codec_.get(), st->codecpar) < 0) {
    error = "codec context";
    return false;
  }
  codec_->pkt_timebase = st->time_base;
  codec_->opaque = this;
  hwFmt_ = AV_PIX_FMT_NONE;
  bool hw = false;
  if (wantHw) {
    const AVHWDeviceType type = device_type_of(opt_.hwContext->path);
    for (int i = 0;; ++i) {
      const AVCodecHWConfig* cfg = avcodec_get_hw_config(dec, i);
      if (cfg == nullptr) break;
      if (has_flag(cfg->methods, AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX) && cfg->device_type == type) {
        hwFmt_ = cfg->pix_fmt;
        break;
      }
    }
    if (hwFmt_ != AV_PIX_FMT_NONE) {
      codec_->hw_device_ctx = av_buffer_ref(opt_.hwContext->device.get());
      codec_->get_format = &FfmpegDecoder::get_format;
      codec_->extra_hw_frames = 4;
      hw = true;
    }
  }
  if (hw) {
    codec_->thread_count = 1;  // hwaccel: the silicon does the work; frame threads only add latency
  } else {
    codec_->thread_count = opt_.threads > 0 ? opt_.threads : 0;  // 0 = libavcodec's auto (one per core, capped)
    // Intra-only codecs (ProRes, DNxHR): slice threads decode ONE frame on all
    // cores — the scrub case. Long-GOP: frame + slice threads (throughput).
    codec_->thread_type = v.intraOnly ? FF_THREAD_SLICE : (FF_THREAD_FRAME | FF_THREAD_SLICE);
  }
  const int rc = avcodec_open2(codec_.get(), dec, nullptr);
  if (rc < 0) {
    error = "avcodec_open2(" + std::string(dec->name) + "): " + av_error(rc);
    return false;
  }
  path_ = hw ? opt_.hwContext->path : DecodePath::software;
  return true;
}

bool FfmpegDecoder::reopen_software(const std::string& why, std::string& error) {
  // The hardware decoder refused this stream at its first frame (H.264 High 10,
  // 4:2:2, an unsupported size…: libavcodec then falls back to software inside
  // a context opened with ONE thread), or failed mid-stream (a device removed
  // or reset, a driver error, a surface that won't download). Either way this
  // clip continues in software, properly threaded, from the frame it was on:
  // one bad hardware decode never blanks a frame (CLAUDE.md reliability).
  if (opt_.hw == HwPolicy::hardwareOnly || path_ == DecodePath::software) {
    error = why;
    return false;
  }
  fallback_ = std::string(to_string(path_)) + ": " + why;
  const std::int64_t resume = position_ >= 0 ? position_ : (target_ >= 0 ? target_ : 0);
  const AVCodec* dec = codec_->codec;
  if (!open_codec(dec, false, error)) return false;
  return seek(resume, error);
}

bool FfmpegDecoder::seek(std::int64_t frame, std::string& error) {
  frame = index_.clamp(frame);
  const std::int64_t keyPts = index_.key_pts(frame);
  const int rc = av_seek_frame(fmt_.get(), stream_, keyPts, AVSEEK_FLAG_BACKWARD);
  if (rc < 0) {
    error = "seek: " + av_error(rc);
    return false;
  }
  avcodec_flush_buffers(codec_.get());
  draining_ = false;
  eof_ = false;
  position_ = -1;
  seekGop_ = index_.gop_of(frame);
  target_ = frame;
  retried_ = false;
  return true;
}

DecodeStatus FfmpegDecoder::next(FramePtr& out, std::string& error, const std::atomic<std::uint64_t>* cancel,
                                 std::uint64_t generation) {
  AvFramePtr f(av_frame_alloc());
  for (;;) {
    const int rc = avcodec_receive_frame(codec_.get(), f.get());
    if (rc == 0) {
      if (hwFmt_ != AV_PIX_FMT_NONE && f->format != hwFmt_) {
        av_frame_unref(f.get());
        if (!reopen_software(std::string("refused ") + codec_->codec->name + " " + video_->profile + " " + video_->pixelFormat, error)) {
          return DecodeStatus::error;
        }
        continue;
      }
      if (path_ != DecodePath::software && opt_.failHwAtFrame >= 0 && hwFrames_ >= opt_.failHwAtFrame) {
        av_frame_unref(f.get());  // fault injection (tests): the hardware decoder "fails" here
        if (!reopen_software("injected fault", error)) return DecodeStatus::error;
        continue;
      }
      const std::int64_t pts = f->best_effort_timestamp != AV_NOPTS_VALUE ? f->best_effort_timestamp : f->pts;
      std::int64_t idx = index_.index_of_pts(pts);
      if (idx < 0 && pts != AV_NOPTS_VALUE && video_->fps.valid()) {
        // Not in the index (an unindexed file, a rounding container): nearest slot by time.
        const double sec = static_cast<double>(pts - video_->startPts) * video_->timeBase.value();
        idx = index_.frame_at_seconds(sec);
      }
      // Open-GOP leading frames reference the previous GOP: not decodable from here.
      if (idx >= 0 && seekGop_ >= 0 && idx < seekGop_) {
        av_frame_unref(f.get());
        continue;
      }
      // A seek that landed past its target (a container index whose keyframe
      // flags are wrong, a keyframe whose dts ≤ target but pts > target): go
      // back one more GOP, once.
      if (idx > target_ && target_ > 0 && position_ < 0 && !retried_) {
        const std::int64_t keep = target_;
        const std::int64_t back = std::max<std::int64_t>(0, index_.gop_of(target_) - 1);
        if (!seek(back, error)) return DecodeStatus::error;
        target_ = keep;
        retried_ = true;
        av_frame_unref(f.get());
        continue;
      }
      position_ = idx + 1;
      // A hardware frame before the seek target is not worth keeping: copying
      // it off the decoder (surface copy or download) is most of its cost, and
      // a scrub only wants the target. Software frames are kept (a reference,
      // no copy) so scrubbing back inside the GOP is a cache hit.
      if (idx >= 0 && idx < target_ && f->format == hwFmt_ && hwFmt_ != AV_PIX_FMT_NONE) {
        av_frame_unref(f.get());
        continue;
      }
      f->pts = pts;
      const bool fromHw = path_ != DecodePath::software;
      AvFramePtr taken = std::move(f);
      f.reset(av_frame_alloc());  // for the next receive, should this frame fail over to software
      if (!wrap(std::move(taken), out, error)) {
        // A hardware surface that won't copy or download: this clip goes on in software.
        if (fromHw && reopen_software(std::string(error), error)) continue;
        return DecodeStatus::error;
      }
      if (fromHw) ++hwFrames_;
      auto* d = const_cast<DecodedFrame*>(out.get());  // NOLINT(cppcoreguidelines-pro-type-const-cast): just built, sole owner
      d->index = idx;
      return DecodeStatus::frame;
    }
    if (rc == AVERROR_EOF) {
      eof_ = true;
      return DecodeStatus::eof;
    }
    if (rc != AVERROR(EAGAIN)) {
      if (path_ != DecodePath::software && reopen_software("decode: " + av_error(rc), error)) continue;
      error = "decode: " + av_error(rc);
      return DecodeStatus::error;
    }
    if (draining_) {
      eof_ = true;
      return DecodeStatus::eof;
    }
    if (cancel != nullptr && cancel->load(std::memory_order_relaxed) != generation) return DecodeStatus::cancelled;
    const int rr = av_read_frame(fmt_.get(), pkt_.get());
    if (rr < 0) {
      // End of file (or a read error — treat as the end): drain what is buffered.
      avcodec_send_packet(codec_.get(), nullptr);
      draining_ = true;
      continue;
    }
    if (pkt_->stream_index == stream_) {
      const int sr = avcodec_send_packet(codec_.get(), pkt_.get());
      if (sr < 0 && sr != AVERROR(EAGAIN) && sr != AVERROR_INVALIDDATA) {
        av_packet_unref(pkt_.get());
        if (path_ != DecodePath::software && reopen_software("send packet: " + av_error(sr), error)) continue;
        error = "send packet: " + av_error(sr);
        return DecodeStatus::error;
      }
    }
    av_packet_unref(pkt_.get());
  }
}

bool FfmpegDecoder::wrap(AvFramePtr f, FramePtr& out, std::string& error) {
  auto d = std::make_shared<AvDecodedFrame>();
  d->width = static_cast<std::uint32_t>(f->width);
  d->height = static_cast<std::uint32_t>(f->height);
  d->pts = f->pts;
  const VideoInfo& v = *video_;
  // Colour: the frame's own tags when it has them (they can change mid-stream), else the stream's.
  const Matrix fm = mat_of(f->colorspace);
  const Primaries fp = prim_of(f->color_primaries);
  const Range fr = range_of(f->color_range);
  const Matrix m = fm != Matrix::unspecified ? resolve_matrix(fm, fp, d->height) : v.color.resolvedMatrix;
  const Range r = fr != Range::unspecified ? fr : v.color.resolvedRange;

  // HDR10 static metadata often rides in SEI, not the container: take it from
  // the first frame that carries it.
  if (!video_->color.mastering) {
    if (const AVFrameSideData* sd = av_frame_get_side_data(f.get(), AV_FRAME_DATA_MASTERING_DISPLAY_METADATA); sd != nullptr) {
      fill_mastering(reinterpret_cast<const AVMasteringDisplayMetadata*>(sd->data), video_->color);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    }
  }
  if (!video_->color.contentLight) {
    if (const AVFrameSideData* sd = av_frame_get_side_data(f.get(), AV_FRAME_DATA_CONTENT_LIGHT_LEVEL); sd != nullptr) {
      fill_light(reinterpret_cast<const AVContentLightMetadata*>(sd->data), video_->color);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    }
  }
  if (f->format == hwFmt_ && f->hw_frames_ctx != nullptr) {
    d->path = path_;
#if defined(_WIN32)
    const auto* hwfc = reinterpret_cast<const AVHWFramesContext*>(f->hw_frames_ctx->data);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    const bool highBit = hwfc->sw_format != AV_PIX_FMT_NV12;
    if (opt_.keepOnGpu && (!highBit || opt_.keepHighBitOnGpu) && hwFmt_ == AV_PIX_FMT_D3D11 && opt_.hwContext->d3d11) {
      auto* tex = reinterpret_cast<void*>(f->data[0]);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): ID3D11Texture2D*
      const auto slice = static_cast<unsigned>(reinterpret_cast<std::intptr_t>(f->data[1]));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): libav stores the slice index in data[1]
      std::string copyError;
      d->surface = opt_.hwContext->d3d11->copy_slice(tex, slice, d->width, d->height, copyError);
      if (d->surface) {
        const auto* fc = reinterpret_cast<const AVHWFramesContext*>(f->hw_frames_ctx->data);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
        FrameFormat ff;
        const bool known = frame_format_of(fc->sw_format, ff);
        ff.matrix = m;
        ff.range = r;
        if (!known) {
          ff.layout = Layout::semiPlanarYuv;
          ff.bitDepth = 8;
        }
        d->format = ff;
        d->gpu = d->surface.get();
        const auto* si = d3d11::surface_info(d->gpu);
        d->gpuBytes = si != nullptr ? opt_.hwContext->d3d11->surface_bytes(si->format, si->width, si->height) : 0;
        out = std::move(d);
        return true;  // the decoder's slice is released with `f` here
      }
      // Pool full / format not shareable: fall through to a CPU download.
    }
#endif
    AvFramePtr sw(av_frame_alloc());
    const int rc = av_hwframe_transfer_data(sw.get(), f.get(), 0);
    if (rc < 0) {
      error = "hwframe transfer: " + av_error(rc);
      return false;
    }
    av_frame_copy_props(sw.get(), f.get());
    f = std::move(sw);
  } else {
    d->path = DecodePath::software;
  }
  d->frame = std::move(f);
  if (!to_cpu_planes(*d, error)) return false;
  d->format.matrix = d->format.matrix == Matrix::rgb ? Matrix::rgb : m;
  if (d->format.layout == Layout::packedRgba) {
    d->format.matrix = Matrix::rgb;
    d->format.range = Range::full;
  } else {
    d->format.range = d->format.matrix == Matrix::rgb && fr == Range::unspecified ? Range::full : r;
  }
  out = std::move(d);
  return true;
}

bool FfmpegDecoder::to_cpu_planes(AvDecodedFrame& d, std::string& error) {
  AVFrame* f = d.frame.get();
  const auto pf = static_cast<AVPixelFormat>(f->format);
  FrameFormat ff;
  if (!frame_format_of(pf, ff)) {
    // Anything the shader does not read directly: swscale to RGBA (8-bit) / RGBA64 (deeper).
    const AVPixFmtDescriptor* desc = av_pix_fmt_desc_get(pf);
    const bool deep = desc != nullptr && desc->comp[0].depth > 8;
    const AVPixelFormat dst = deep ? AV_PIX_FMT_RGBA64LE : AV_PIX_FMT_RGBA;
    sws_.reset(sws_getCachedContext(sws_.release(), f->width, f->height, pf, f->width, f->height, dst, SWS_POINT,
                                    nullptr, nullptr, nullptr));
    if (!sws_) {
      error = std::string("no conversion from ") + (desc != nullptr ? desc->name : "?");
      return false;
    }
    AvFramePtr rgba(av_frame_alloc());
    rgba->format = dst;
    rgba->width = f->width;
    rgba->height = f->height;
    if (av_frame_get_buffer(rgba.get(), 0) < 0) {
      error = "frame buffer";
      return false;
    }
    sws_scale(sws_.get(), f->data, f->linesize, 0, f->height, rgba->data, rgba->linesize);
    av_frame_copy_props(rgba.get(), f);
    d.frame = std::move(rgba);
    f = d.frame.get();
    ff = FrameFormat{};
    ff.layout = Layout::packedRgba;
    ff.bitDepth = deep ? 16 : 8;
    ff.bytesPerSample = deep ? 2 : 1;
    ff.chromaShiftX = 0;
    ff.chromaShiftY = 0;
    ff.hasAlpha = desc != nullptr && has_flag(desc->flags, AV_PIX_FMT_FLAG_ALPHA);
  }
  d.format = ff;
  const AVPixFmtDescriptor* desc = av_pix_fmt_desc_get(static_cast<AVPixelFormat>(f->format));
  const std::uint32_t w = d.width;
  const std::uint32_t h = d.height;
  const std::uint32_t cw = (w + (1U << ff.chromaShiftX) - 1) >> ff.chromaShiftX;
  const std::uint32_t ch = (h + (1U << ff.chromaShiftY) - 1) >> ff.chromaShiftY;
  std::size_t bytes = 0;
  auto plane = [&](std::size_t slot, int avPlane, std::uint32_t pw, std::uint32_t ph, std::uint8_t comps) -> bool {
    const int ls = f->linesize[avPlane];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    if (ls <= 0 || f->data[avPlane] == nullptr) return false;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    d.planes.at(slot) = {f->data[avPlane], static_cast<std::size_t>(ls), pw, ph, comps};  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    bytes += static_cast<std::size_t>(ls) * ph;
    return true;
  };
  bool ok = true;
  switch (ff.layout) {
    case Layout::packedRgba:
      ok = plane(0, 0, w, h, 4);
      d.planeCount = 1;
      break;
    case Layout::semiPlanarYuv:
      ok = plane(0, 0, w, h, 1) && plane(1, 1, cw, ch, 2);
      d.planeCount = 2;
      break;
    case Layout::planarYuv:
    case Layout::planarRgb: {
      // Canonical order: component 0, 1, 2 (Y U V / R G B), then alpha.
      const int n = desc->nb_components;
      for (int c = 0; c < n && ok; ++c) {
        const bool chroma = ff.layout == Layout::planarYuv && (c == 1 || c == 2);
        ok = plane(static_cast<std::size_t>(c), desc->comp[c].plane, chroma ? cw : w, chroma ? ch : h, 1);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
      }
      d.planeCount = static_cast<std::uint8_t>(n);
      break;
    }
  }
  if (!ok) {
    error = "frame has an unreadable plane (negative stride?)";
    return false;
  }
  d.cpuBytes = bytes;
  return true;
}

}  // namespace

std::unique_ptr<VideoDecoder> VideoDecoder::open(const std::string& path, const DecoderOptions& options,
                                                 std::string& error) {
  auto dec = std::make_unique<FfmpegDecoder>();
  if (!dec->init(path, options, error)) return nullptr;
  return dec;
}

bool VideoDecoder::probe(const std::string& path, MediaInfo& out, FrameIndex& index, std::string& error) {
  FormatPtr fmt;
  if (!open_format(path, fmt, error)) return false;
  out = MediaInfo{};
  out.path = path;
  if (!fill_info(fmt.get(), best_video_stream(fmt.get()), out, error) || !out.video) return false;
  VideoInfo& v = *out.video;
  if (index_from_container(fmt->streams[v.streamIndex], v, index)) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    v.exactIndex = true;
    v.frameCount = index.size();
  } else {
    index = FrameIndex::constant_rate(v.frameCount, v.fps, v.timeBase, v.startPts);
  }
  return true;
}

bool scan_index(const std::string& path, int streamIndex, FrameIndex& out, std::string& error,
                const std::atomic<bool>* stop) {
  FormatPtr fmt;
  if (!open_format(path, fmt, error)) return false;
  if (streamIndex < 0 || std::cmp_greater_equal(streamIndex, fmt->nb_streams)) {
    error = "bad stream";
    return false;
  }
  for (unsigned i = 0; i < fmt->nb_streams; ++i) {
    if (std::cmp_not_equal(i, streamIndex)) fmt->streams[i]->discard = AVDISCARD_ALL;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  std::vector<SampleEntry> samples;
  PacketPtr pkt(av_packet_alloc());
  while (av_read_frame(fmt.get(), pkt.get()) >= 0) {
    if (stop != nullptr && stop->load(std::memory_order_relaxed)) {
      error = "stopped";
      return false;
    }
    if (pkt->stream_index == streamIndex) {
      const std::int64_t pts = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
      if (pts != AV_NOPTS_VALUE && !has_flag(pkt->flags, AV_PKT_FLAG_DISCARD)) {
        samples.push_back({pts, has_flag(pkt->flags, AV_PKT_FLAG_KEY)});
      }
    }
    av_packet_unref(pkt.get());
  }
  if (samples.empty()) {
    error = "no packets";
    return false;
  }
  out = FrameIndex::from_samples(samples, rational_of(fmt->streams[streamIndex]->time_base));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return true;
}

}  // namespace premation::media
