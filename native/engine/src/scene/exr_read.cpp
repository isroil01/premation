#include "exr_read.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <utility>

namespace premation::scene::exr {
namespace {

constexpr std::int32_t kMagic = 20000630;
constexpr std::array<int, 3> kPixelBytes{4, 2, 4};  // UINT, HALF, FLOAT

class Reader {
 public:
  explicit Reader(std::span<const std::uint8_t> b) : b_(b) {}
  [[nodiscard]] bool ok() const noexcept { return ok_; }
  [[nodiscard]] std::size_t pos() const noexcept { return pos_; }
  void seek(std::size_t p) noexcept {
    if (p > b_.size()) ok_ = false;
    pos_ = std::min(p, b_.size());
  }
  std::uint8_t u8() noexcept {
    if (pos_ + 1 > b_.size()) return fail<std::uint8_t>();
    return b_[pos_++];
  }
  std::int32_t i32() noexcept {
    if (pos_ + 4 > b_.size()) return fail<std::int32_t>();
    std::uint32_t v = 0;
    for (std::size_t k = 0; k < 4; ++k) v |= static_cast<std::uint32_t>(b_[pos_ + k]) << (8U * k);
    pos_ += 4;
    return static_cast<std::int32_t>(v);
  }
  std::string str() {
    std::size_t end = pos_;
    while (end < b_.size() && b_[end] != 0) ++end;
    if (end >= b_.size()) {
      ok_ = false;
      pos_ = b_.size();
      return {};
    }
    std::string s(reinterpret_cast<const char*>(b_.data() + pos_), end - pos_);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast,cppcoreguidelines-pro-bounds-pointer-arithmetic)
    pos_ = end + 1;
    return s;
  }
  std::span<const std::uint8_t> raw(std::size_t n) noexcept {
    if (pos_ + n > b_.size()) {
      ok_ = false;
      n = b_.size() - pos_;
    }
    const auto v = b_.subspan(pos_, n);
    pos_ += n;
    return v;
  }

 private:
  template <class T>
  T fail() noexcept {
    ok_ = false;
    pos_ = b_.size();
    return T{};
  }
  std::span<const std::uint8_t> b_;
  std::size_t pos_ = 0;
  bool ok_ = true;
};

/// exr.ts rleDecode (signed run counts).
std::vector<std::uint8_t> rle_decode(std::span<const std::uint8_t> data, std::size_t expected) {
  std::vector<std::uint8_t> out(expected, 0);
  std::size_t i = 0;
  std::size_t o = 0;
  while (i < data.size() && o < expected) {
    int n = data[i++];
    if (n > 127) n -= 256;
    if (n < 0) {
      const auto count = static_cast<std::size_t>(-n);
      const std::size_t take = std::min({count, data.size() - i, expected - o});
      std::copy_n(data.begin() + static_cast<std::ptrdiff_t>(i), take, out.begin() + static_cast<std::ptrdiff_t>(o));
      i += count;
      o += count;
    } else {
      const auto count = static_cast<std::size_t>(n) + 1;
      const std::uint8_t v = i < data.size() ? data[i] : 0;
      ++i;
      const std::size_t fill = std::min(count, expected - o);
      std::fill_n(out.begin() + static_cast<std::ptrdiff_t>(o), fill, v);
      o += count;
    }
  }
  return out;
}

struct ChannelSpec {
  std::string name;
  int pixelType = 0;  // 0 UINT, 1 HALF, 2 FLOAT
};

float read_f32(std::span<const std::uint8_t> b, std::size_t off) noexcept {
  float v = 0;
  std::memcpy(&v, b.data() + off, 4);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): off + 4 <= size checked by the caller
  return v;
}

}  // namespace

float half_to_float(std::uint16_t h) noexcept {
  // exr.ts halfToFloat, in float64 then stored (a Float32Array element).
  const double sign = (h & 0x8000U) != 0 ? -1.0 : 1.0;
  const auto exp = static_cast<int>((unsigned{h} >> 10U) & 0x1FU);
  const auto frac = static_cast<int>(unsigned{h} & 0x3FFU);
  if (exp == 0) return static_cast<float>(sign * frac * std::ldexp(1.0, -24));
  if (exp == 31) return frac != 0 ? std::numeric_limits<float>::quiet_NaN() : static_cast<float>(sign * std::numeric_limits<double>::infinity());
  return static_cast<float>(sign * (1 + frac / 1024.0) * std::ldexp(1.0, exp - 15));
}

std::vector<std::uint8_t> predictor_decode(std::span<const std::uint8_t> data) {
  const std::size_t n = data.size();
  std::vector<std::uint8_t> tmp(data.begin(), data.end());
  for (std::size_t i = 1; i < n; ++i) tmp[i] = static_cast<std::uint8_t>(static_cast<unsigned>(tmp[i - 1] + tmp[i] - 128 + 256) & 0xFFU);
  std::vector<std::uint8_t> out(n, 0);
  const std::size_t half = (n + 1) / 2;
  for (std::size_t i = 0, j = 0; i < half && j < n; ++i, j += 2) out[j] = tmp[i];
  for (std::size_t i = half, j = 1; i < n && j < n; ++i, j += 2) out[j] = tmp[i];
  return out;
}

std::optional<Image> decode(std::span<const std::uint8_t> file, const Inflate& inflate, std::string& error) {
  Reader r(file);
  if (r.i32() != kMagic) {
    error = "Not an OpenEXR file.";
    return std::nullopt;
  }
  const auto version = static_cast<std::uint32_t>(r.i32());  // a flags word
  if ((version & 0x200U) != 0) {
    error = "Tiled EXR is not supported — re-export as scanline.";
    return std::nullopt;
  }
  if ((version & 0x800U) != 0) {
    error = "Deep EXR is not supported.";
    return std::nullopt;
  }
  if ((version & 0x1000U) != 0) {
    error = "Multi-part EXR is not supported — export a single part.";
    return std::nullopt;
  }

  Image img;
  std::vector<ChannelSpec> channels;
  int compression = -1;
  std::optional<std::array<std::int32_t, 4>> dataWindow;  // xMin yMin xMax yMax
  int lineOrder = 0;
  for (;;) {
    const std::string name = r.str();
    if (!r.ok()) {
      error = "EXR header is truncated.";
      return std::nullopt;
    }
    if (name.empty()) break;
    const std::string type = r.str();
    const std::int32_t size = r.i32();
    if (!r.ok() || size < 0) {
      error = "EXR header is truncated.";
      return std::nullopt;
    }
    const std::size_t attrEnd = r.pos() + static_cast<std::size_t>(size);
    if (type == "string") {
      const auto v = r.raw(static_cast<std::size_t>(size));
      img.attributes[name] = std::string(reinterpret_cast<const char*>(v.data()), v.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    } else if (name == "channels" && type == "chlist") {
      for (;;) {
        const std::string ch = r.str();
        if (!r.ok() || ch.empty()) break;
        const std::int32_t pixelType = r.i32();
        (void)r.i32();  // pLinear + reserved
        const std::int32_t xs = r.i32();
        const std::int32_t ys = r.i32();
        if (xs != 1 || ys != 1) {
          error = "Subsampled channel \"" + ch + "\" is not supported.";
          return std::nullopt;
        }
        if (pixelType < 0 || pixelType > 2) {
          error = "Unknown pixel type in channel \"" + ch + "\".";
          return std::nullopt;
        }
        channels.push_back({ch, pixelType});
      }
    } else if (name == "compression" && type == "compression") {
      compression = r.u8();
    } else if (name == "dataWindow" && type == "box2i") {
      dataWindow = std::array<std::int32_t, 4>{r.i32(), r.i32(), r.i32(), r.i32()};
    } else if (name == "lineOrder" && type == "lineOrder") {
      lineOrder = r.u8();
    }
    r.seek(attrEnd);
  }
  if (!dataWindow) {
    error = "EXR header has no dataWindow.";
    return std::nullopt;
  }
  if (channels.empty()) {
    error = "EXR header has no channels.";
    return std::nullopt;
  }
  if (compression < 0 || compression > 3) {
    static const std::map<int, std::string> kNames{{4, "PIZ"}, {5, "PXR24"}, {6, "B44"}, {7, "B44A"}, {8, "DWAA"}, {9, "DWAB"}};
    const auto it = kNames.find(compression);
    error = "EXR compression " + (it != kNames.end() ? it->second : std::to_string(compression)) +
            " is not supported — re-export as ZIP or uncompressed.";
    return std::nullopt;
  }
  if (lineOrder > 1) {
    error = "Random-Y line order is not supported.";
    return std::nullopt;
  }
  const int linesPerBlock = compression == 3 ? 16 : 1;
  const std::int64_t width = std::int64_t{(*dataWindow)[2]} - (*dataWindow)[0] + 1;
  const std::int64_t height = std::int64_t{(*dataWindow)[3]} - (*dataWindow)[1] + 1;
  if (width <= 0 || height <= 0 || width * height > 268'435'456) {
    error = "EXR data window is empty or unreasonably large.";
    return std::nullopt;
  }
  img.width = static_cast<int>(width);
  img.height = static_cast<int>(height);
  std::size_t bytesPerPixel = 0;
  for (const ChannelSpec& c : channels) bytesPerPixel += static_cast<std::size_t>(kPixelBytes.at(static_cast<std::size_t>(c.pixelType)));
  const std::int64_t blocks = (height + linesPerBlock - 1) / linesPerBlock;
  r.seek(r.pos() + static_cast<std::size_t>(blocks) * 8);  // offset table: chunks follow sequentially anyway

  const auto w = static_cast<std::size_t>(width);
  const auto h = static_cast<std::size_t>(height);
  img.channels.reserve(channels.size());
  for (const ChannelSpec& c : channels) img.channels.push_back({c.name, std::vector<float>(w * h, 0.0F)});

  std::vector<std::uint8_t> unpacked;
  for (std::int64_t b = 0; b < blocks; ++b) {
    // Each chunk names its own first scanline: DECREASING_Y only reorders chunks.
    const std::int64_t yStart = std::int64_t{r.i32()} - (*dataWindow)[1];
    const std::int32_t packedSize = r.i32();
    if (!r.ok() || packedSize < 0 || yStart < 0 || yStart >= height) {
      error = "EXR chunk table is corrupt.";
      return std::nullopt;
    }
    const auto nLines = static_cast<std::size_t>(std::max<std::int64_t>(1, std::min<std::int64_t>(linesPerBlock, height - yStart)));
    const std::size_t expected = nLines * w * bytesPerPixel;
    const std::span<const std::uint8_t> packed = r.raw(static_cast<std::size_t>(packedSize));
    if (!r.ok()) {
      error = "EXR chunk is truncated.";
      return std::nullopt;
    }
    std::span<const std::uint8_t> raw;
    if (compression == 0 || std::cmp_equal(packedSize, expected)) {
      // NONE, or a block the writer stored raw because compression did not help.
      if (packed.size() < expected) {
        error = "EXR chunk is truncated.";
        return std::nullopt;
      }
      raw = packed.subspan(0, expected);
    } else if (compression == 1) {
      unpacked = predictor_decode(rle_decode(packed, expected));
      raw = unpacked;
    } else {
      std::vector<std::uint8_t> inflated;
      if (!inflate || !inflate(packed, expected, inflated) || inflated.size() < expected) {
        error = "EXR ZIP block did not inflate.";
        return std::nullopt;
      }
      inflated.resize(expected);
      unpacked = predictor_decode(inflated);
      raw = unpacked;
    }
    std::size_t off = 0;
    for (std::size_t line = 0; line < nLines; ++line) {
      const std::size_t base = (static_cast<std::size_t>(yStart) + line) * w;
      for (std::size_t ci = 0; ci < channels.size(); ++ci) {
        std::vector<float>& plane = img.channels[ci].data;
        const int pt = channels[ci].pixelType;
        for (std::size_t x = 0; x < w; ++x) {
          if (pt == 1) {
            const auto hv = static_cast<std::uint16_t>(unsigned{raw[off]} | (unsigned{raw[off + 1]} << 8U));
            plane[base + x] = half_to_float(hv);
            off += 2;
          } else if (pt == 2) {
            plane[base + x] = read_f32(raw, off);
            off += 4;
          } else {
            const std::uint32_t u = static_cast<std::uint32_t>(raw[off]) | (static_cast<std::uint32_t>(raw[off + 1]) << 8U) |
                                    (static_cast<std::uint32_t>(raw[off + 2]) << 16U) |
                                    (static_cast<std::uint32_t>(raw[off + 3]) << 24U);
            plane[base + x] = static_cast<float>(u);
            off += 4;
          }
        }
      }
    }
  }
  return img;
}

std::optional<FloatRgba> to_float_rgba(const Image& img, double exposure) {
  const auto lower = [](std::string s) {
    for (char& c : s) {
      if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return s;
  };
  const auto find = [&](const std::string& name) -> const std::vector<float>* {
    for (const Channel& c : img.channels) {
      if (lower(c.name) == name) return &c.data;
    }
    const std::string suffix = "." + name;
    for (const Channel& c : img.channels) {
      const std::string l = lower(c.name);
      if (l.ends_with(suffix)) return &c.data;
    }
    return nullptr;
  };
  const std::vector<float>* y = find("y");
  const std::vector<float>* r = find("r");
  const std::vector<float>* g = find("g");
  const std::vector<float>* b = find("b");
  const std::vector<float>* a = find("a");
  if (r == nullptr) r = y;
  if (g == nullptr) g = y;
  if (b == nullptr) b = y;
  if (r == nullptr || g == nullptr || b == nullptr) return std::nullopt;
  const double gain = std::pow(2.0, exposure);
  const std::size_t n = static_cast<std::size_t>(img.width) * static_cast<std::size_t>(img.height);
  FloatRgba out;
  out.width = img.width;
  out.height = img.height;
  out.rgba.resize(n * 4);
  // `(r[i] || 0) * gain`: NaN and 0 read as 0; alpha max(0, a) (NaN → NaN as Math.max does).
  const auto or0 = [](float v) { return std::isnan(v) ? 0.0 : static_cast<double>(v); };
  for (std::size_t i = 0; i < n; ++i) {
    out.rgba[i * 4] = static_cast<float>(or0((*r)[i]) * gain);
    out.rgba[i * 4 + 1] = static_cast<float>(or0((*g)[i]) * gain);
    out.rgba[i * 4 + 2] = static_cast<float>(or0((*b)[i]) * gain);
    if (a == nullptr) {
      out.rgba[i * 4 + 3] = 1.0F;
    } else {
      const float av = (*a)[i];
      out.rgba[i * 4 + 3] = std::isnan(av) ? av : std::max(0.0F, av);
    }
  }
  return out;
}

}  // namespace premation::scene::exr
