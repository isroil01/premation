// E1 media: the plain data the media system hands everyone else. No ffmpeg,
// no OS and no GPU types here — those stay in the *_ffi.cpp files (CLAUDE.md).
//
// Colour code points are ITU-T H.273 (the numbers ffmpeg's AVCOL_* use and
// that containers carry), so a value read from a file needs no mapping table
// to be stored, compared or logged.
#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace premation::media {

/// An exact rational (a frame rate, a time base). `den` > 0 when valid.
struct Rational {
  std::int64_t num = 0;
  std::int64_t den = 1;
  [[nodiscard]] double value() const noexcept { return den != 0 ? static_cast<double>(num) / static_cast<double>(den) : 0.0; }
  [[nodiscard]] bool valid() const noexcept { return num > 0 && den > 0; }
  friend bool operator==(const Rational&, const Rational&) = default;
};

/// H.273 colour primaries (AVColorPrimaries).
enum class Primaries : std::uint8_t {
  bt709 = 1, unspecified = 2, bt470m = 4, bt470bg = 5, smpte170m = 6, smpte240m = 7, film = 8,
  bt2020 = 9, smpte428 = 10, smpte431 = 11, smpte432 = 12, ebu3213 = 22,
};
/// H.273 transfer characteristics (AVColorTransferCharacteristic).
enum class Transfer : std::uint8_t {
  bt709 = 1, unspecified = 2, gamma22 = 4, gamma28 = 5, smpte170m = 6, smpte240m = 7, linear = 8,
  log100 = 9, log316 = 10, iec61966_2_4 = 11, bt1361 = 12, srgb = 13, bt2020_10 = 14, bt2020_12 = 15,
  pq = 16, smpte428 = 17, hlg = 18,
};
/// H.273 matrix coefficients (AVColorSpace). `rgb` = GBR planes, no matrix.
enum class Matrix : std::uint8_t {
  rgb = 0, bt709 = 1, unspecified = 2, fcc = 4, bt470bg = 5, smpte170m = 6, smpte240m = 7, ycgco = 8,
  bt2020nc = 9, bt2020c = 10, smpte2085 = 11, chroma_derived_nc = 12, chroma_derived_c = 13, ictcp = 14,
};
/// Quantisation range: limited ("TV", 16–235 at 8 bits) or full ("PC", 0–255).
enum class Range : std::uint8_t { unspecified = 0, limited = 1, full = 2 };

/// SMPTE ST 2086 mastering display (chromaticities as CIE xy, luminance in cd/m²).
struct MasteringDisplay {
  double primaries[3][2] = {};  // NOLINT(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): plain POD mirror of the SEI
  double whitePoint[2] = {};    // NOLINT(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
  double minLuminance = 0;
  double maxLuminance = 0;
};
/// CTA-861.3 content light level.
struct ContentLight {
  std::uint32_t maxCLL = 0;
  std::uint32_t maxFALL = 0;
};

/// The colour description of a stream, as the file states it (`*_unspecified`
/// when silent) plus what the engine resolved it to (`resolved*`: the H.273 /
/// ffmpeg defaults — BT.601 for SD, BT.709 for HD, BT.2020 when primaries say so).
struct ColorInfo {
  Primaries primaries = Primaries::unspecified;
  Transfer transfer = Transfer::unspecified;
  Matrix matrix = Matrix::unspecified;
  Range range = Range::unspecified;
  Matrix resolvedMatrix = Matrix::bt709;
  Range resolvedRange = Range::limited;
  std::optional<MasteringDisplay> mastering;
  std::optional<ContentLight> contentLight;
  [[nodiscard]] bool hdr() const noexcept { return transfer == Transfer::pq || transfer == Transfer::hlg; }
};

/// How the decoded texels are laid out, independent of ffmpeg's pix_fmt names.
enum class Layout : std::uint8_t {
  planarYuv,     // Y, U, V (+ A) planes — yuv4xxp*, yuva4xxp*
  semiPlanarYuv, // Y + interleaved UV — nv12, p010, p016, p210, p410, nv16, nv24
  planarRgb,     // G, B, R (+ A) planes — gbrp*, gbrap*
  packedRgba,    // one RGBA plane (after a swscale conversion)
};

/// Alpha interpretation (Interpret Footage ▸ Alpha, sourceInfo.ts). Textures
/// are always premultiplied; a straight file is multiplied once at conversion.
enum class AlphaMode : std::uint8_t { none, straight, premultiplied };

/// One video stream as probed.
struct VideoInfo {
  int streamIndex = -1;
  std::string codec;        // "prores", "h264", "hevc", "dnxhd", "vp9", "av1", …
  std::string profile;      // "HQ", "4444", "Main 10", "DNXHR HQ", …
  std::string pixelFormat;  // ffmpeg's name, for logs
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  Rational sampleAspect{1, 1};
  /// The stream's nominal rate (r_frame_rate / avg), exact — 24000/1001 stays that.
  Rational fps;
  Rational timeBase;
  /// Presentation timestamp of the first displayed frame (time-base units).
  std::int64_t startPts = 0;
  double durationSec = 0;
  /// Frames in presentation order (exact when the container indexes every
  /// sample — MOV/MP4 — else duration × fps).
  std::int64_t frameCount = 0;
  bool exactIndex = false;
  std::uint8_t bitDepth = 8;
  std::uint8_t chromaShiftX = 1;  // log2 horizontal subsampling (4:2:0 / 4:2:2 → 1, 4:4:4 → 0)
  std::uint8_t chromaShiftY = 1;  // log2 vertical subsampling (4:2:0 → 1)
  bool hasAlpha = false;
  bool intraOnly = false;  // every frame a keyframe (ProRes, DNx, MJPEG, …): a seek decodes one frame
  int rotation = 0;        // display matrix, degrees clockwise
  ColorInfo color;
};

struct MediaInfo {
  std::string path;
  std::string container;  // "mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", …
  double durationSec = 0;
  std::optional<VideoInfo> video;
  bool hasAudio = false;
};

/// Which decoder is producing a stream's frames.
enum class DecodePath : std::uint8_t {
  software,  // libavcodec on the CPU (frame/slice threads)
  d3d11va,   // Windows: D3D11 video decode (NVDEC / AMD VCN / Intel QSV silicon behind it)
  d3d12va,
  dxva2,
  nvdec,     // CUDA (Linux, or Windows when D3D11VA is refused)
  videotoolbox,
  vaapi,
  vulkan,
};
[[nodiscard]] const char* to_string(DecodePath p) noexcept;

/// What the caller wants from hardware decode.
enum class HwPolicy : std::uint8_t {
  automatic,  // the platform's hardware decoder when the codec/profile/size is supported, else software
  softwareOnly,
  hardwareOnly,  // fail the open instead of falling back (tests, benches)
};

}  // namespace premation::media
