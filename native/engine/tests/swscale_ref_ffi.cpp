#include "swscale_ref_ffi.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <memory>

extern "C" {
#include <libavutil/frame.h>
#include <libavutil/pixfmt.h>
#include <libswscale/swscale.h>
}

namespace premation::media::swsref {
namespace {

struct SwsFreer {
  void operator()(SwsContext* s) const { sws_freeContext(s); }
};
struct FrameFreer {
  void operator()(AVFrame* f) const { av_frame_free(&f); }
};

AVPixelFormat format_of(std::uint8_t depth) {
  switch (depth) {
    case 8: return AV_PIX_FMT_YUV444P;
    case 10: return AV_PIX_FMT_YUV444P10LE;
    case 12: return AV_PIX_FMT_YUV444P12LE;
    case 16: return AV_PIX_FMT_YUV444P16LE;
    default: return AV_PIX_FMT_NONE;
  }
}

int cs_of(Matrix m) {
  switch (m) {
    case Matrix::bt709: return SWS_CS_ITU709;
    case Matrix::fcc: return SWS_CS_FCC;
    case Matrix::bt470bg:
    case Matrix::smpte170m: return SWS_CS_ITU601;
    case Matrix::smpte240m: return SWS_CS_SMPTE240M;
    case Matrix::bt2020nc:
    case Matrix::bt2020c: return SWS_CS_BT2020;
    default: return -1;
  }
}

}  // namespace

Yuv444 code_grid(std::uint8_t depth, Range r) {
  Yuv444 img;
  img.bitDepth = depth;
  const double s = std::exp2(depth - 8);
  const double maxCode = std::exp2(depth) - 1;
  const double yLo = r == Range::limited ? 16 * s : 0;
  const double yHi = r == Range::limited ? 235 * s : maxCode;
  const double cLo = r == Range::limited ? 16 * s : 0;
  const double cHi = r == Range::limited ? 240 * s : maxCode;
  constexpr int kSteps = 11;
  img.width = kSteps * kSteps;
  img.height = kSteps;
  auto code = [](double lo, double hi, int i) { return static_cast<std::uint16_t>(std::lround(lo + (hi - lo) * i / (kSteps - 1))); };
  for (int a = 0; a < kSteps; ++a) {
    for (int b = 0; b < kSteps; ++b) {
      for (int c = 0; c < kSteps; ++c) {
        img.y.push_back(code(yLo, yHi, a));
        img.cb.push_back(code(cLo, cHi, b));
        img.cr.push_back(code(cLo, cHi, c));
      }
    }
  }
  return img;
}

bool to_rgb(const Yuv444& in, Matrix m, Range r, std::vector<double>& rgb, std::string& error) {
  const AVPixelFormat src = format_of(in.bitDepth);
  const int cs = cs_of(m);
  if (src == AV_PIX_FMT_NONE || cs < 0) {
    error = "unsupported depth / matrix";
    return false;
  }
  const int w = static_cast<int>(in.width);
  const int h = static_cast<int>(in.height);
  // Point sampling, exact rounding, no chroma interpolation (4:4:4 in, 4:4:4 out).
  const std::unique_ptr<SwsContext, SwsFreer> ctx(sws_getContext(w, h, src, w, h, AV_PIX_FMT_GBRPF32LE,
                                                                 SWS_POINT | SWS_ACCURATE_RND | SWS_FULL_CHR_H_INT | SWS_FULL_CHR_H_INP,
                                                                 nullptr, nullptr, nullptr));
  if (!ctx) {
    error = "sws_getContext";
    return false;
  }
  const int* table = sws_getCoefficients(cs);
  if (sws_setColorspaceDetails(ctx.get(), table, r == Range::full ? 1 : 0, table, 1, 0, 1 << 16, 1 << 16) < 0) {
    error = "sws_setColorspaceDetails";
    return false;
  }
  const std::unique_ptr<AVFrame, FrameFreer> s(av_frame_alloc());
  const std::unique_ptr<AVFrame, FrameFreer> d(av_frame_alloc());
  s->format = src;
  s->width = w;
  s->height = h;
  d->format = AV_PIX_FMT_GBRPF32LE;
  d->width = w;
  d->height = h;
  if (av_frame_get_buffer(s.get(), 0) < 0 || av_frame_get_buffer(d.get(), 0) < 0) {
    error = "frame buffers";
    return false;
  }
  const std::array<const std::vector<std::uint16_t>*, 3> planes{&in.y, &in.cb, &in.cr};
  for (std::size_t p = 0; p < 3; ++p) {
    for (int yy = 0; yy < h; ++yy) {
      std::uint8_t* row = s->data[p] + static_cast<std::ptrdiff_t>(yy) * s->linesize[p];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index)
      for (int x = 0; x < w; ++x) {
        const std::uint16_t v = planes.at(p)->at(static_cast<std::size_t>(yy) * in.width + static_cast<std::size_t>(x));
        if (in.bitDepth == 8) {
          row[x] = static_cast<std::uint8_t>(v);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        } else {
          std::memcpy(row + 2 * static_cast<std::ptrdiff_t>(x), &v, 2);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): little-endian host
        }
      }
    }
  }
  if (sws_scale(ctx.get(), s->data, s->linesize, 0, h, d->data, d->linesize) != h) {
    error = "sws_scale";
    return false;
  }
  // GBRPF32: planes G, B, R.
  rgb.assign(static_cast<std::size_t>(w) * static_cast<std::size_t>(h) * 3, 0.0);
  constexpr std::array<int, 3> kPlaneOf{2, 0, 1};  // R ← plane 2, G ← plane 0, B ← plane 1
  for (int yy = 0; yy < h; ++yy) {
    for (std::size_t c = 0; c < 3; ++c) {
      const int pl = kPlaneOf.at(c);
      const std::uint8_t* row = d->data[pl] + static_cast<std::ptrdiff_t>(yy) * d->linesize[pl];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index)
      for (int x = 0; x < w; ++x) {
        float v = 0;
        std::memcpy(&v, row + 4 * static_cast<std::ptrdiff_t>(x), 4);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        rgb[(static_cast<std::size_t>(yy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)) * 3 + c] = std::clamp(static_cast<double>(v), 0.0, 1.0);
      }
    }
  }
  return true;
}

}  // namespace premation::media::swsref
