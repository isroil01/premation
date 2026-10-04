#include "jpeg_write.hpp"

#include <algorithm>

#ifdef _WIN32
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#else
#include <array>
#include <cmath>
#include <cstddef>
#include <numbers>
#endif

namespace premation::exporter {
namespace {

#ifndef _WIN32

// Baseline JPEG (ITU T.81), 4:4:4, the Annex K tables scaled with the IJG
// quality formula — macOS and Linux have no system codec the engine links, and
// a hand-rolled encoder is deterministic: the same frame gives the same bytes on
// every machine. Indexing goes through std::span (the tables are fixed size).

constexpr std::array<std::uint8_t, 64> kZigzag = {
    0,  1,  8,  16, 9,  2,  3,  10, 17, 24, 32, 25, 18, 11, 4,  5,  12, 19, 26, 33, 40, 48,
    41, 34, 27, 20, 13, 6,  7,  14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23,
    30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63};

constexpr std::array<std::uint8_t, 64> kLumaQuant = {
    16, 11, 10, 16, 24,  40,  51,  61,  12, 12, 14, 19, 26,  58,  60,  55,  14, 13, 16, 24,  40,  57,
    69, 56, 14, 17, 22,  29,  51,  87,  80, 62, 18, 22, 37,  56,  68,  109, 103, 77, 24, 35, 55,  64,
    81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99};

constexpr std::array<std::uint8_t, 64> kChromaQuant = {
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99,
    99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99};

constexpr std::array<std::uint8_t, 16> kDcLumaBits = {0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0};
constexpr std::array<std::uint8_t, 16> kDcChromaBits = {0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0};
constexpr std::array<std::uint8_t, 12> kDcVals = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};

constexpr std::array<std::uint8_t, 16> kAcLumaBits = {0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d};
constexpr std::array<std::uint8_t, 162> kAcLumaVals = {
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
    0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
    0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
    0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
    0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
    0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
    0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
    0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa};

constexpr std::array<std::uint8_t, 16> kAcChromaBits = {0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77};
constexpr std::array<std::uint8_t, 162> kAcChromaVals = {
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
    0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16,
    0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
    0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86,
    0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
    0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
    0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa};

/// A Huffman table as code + length per symbol (canonical codes, T.81 Annex C).
struct Huffman {
  std::array<std::uint16_t, 256> code{};
  std::array<std::uint8_t, 256> size{};
};

Huffman build_huffman(std::span<const std::uint8_t> bits, std::span<const std::uint8_t> vals) {
  Huffman h;
  const std::span<std::uint16_t> code(h.code);
  const std::span<std::uint8_t> size(h.size);
  std::uint32_t next = 0;
  std::size_t k = 0;
  for (std::size_t len = 1; len <= 16; ++len) {
    for (std::uint8_t n = 0; n < bits[len - 1]; ++n, ++k) {
      code[vals[k]] = static_cast<std::uint16_t>(next++);
      size[vals[k]] = static_cast<std::uint8_t>(len);
    }
    next <<= 1U;
  }
  return h;
}

/// IJG quality scaling of a base table, written out in zigzag order.
std::array<std::uint8_t, 64> scaled_quant(std::span<const std::uint8_t> base, int quality) {
  const int scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  std::array<std::uint8_t, 64> out{};
  const std::span<std::uint8_t> o(out);
  const std::span<const std::uint8_t> zz(kZigzag);
  for (std::size_t i = 0; i < 64; ++i) {
    o[i] = static_cast<std::uint8_t>(std::clamp((base[zz[i]] * scale + 50) / 100, 1, 255));
  }
  return out;
}

/// Entropy-coded bits, with the 0xFF → 0xFF 0x00 stuffing T.81 requires.
class BitWriter {
 public:
  explicit BitWriter(std::vector<std::uint8_t>& out) : out_(&out) {}
  void put(std::uint32_t bits, std::uint32_t count) {
    acc_ = (acc_ << count) | (bits & ((1U << count) - 1U));
    used_ += count;
    while (used_ >= 8) {
      used_ -= 8;
      const auto byte = static_cast<std::uint8_t>(acc_ >> used_);
      out_->push_back(byte);
      if (byte == 0xFF) out_->push_back(0);
    }
    acc_ &= (1U << used_) - 1U;
  }
  void flush() {
    if (used_ > 0) put(0x7F, 8 - used_);  // pad with ones
  }

 private:
  std::vector<std::uint8_t>* out_;
  std::uint32_t acc_ = 0;
  std::uint32_t used_ = 0;
};

/// Bits needed for |v| (the JPEG "category"), and the value's code bits.
std::uint32_t category(int v) {
  auto m = static_cast<std::uint32_t>(v < 0 ? -v : v);
  std::uint32_t n = 0;
  while (m != 0) {
    ++n;
    m >>= 1U;
  }
  return n;
}
std::uint32_t value_bits(int v, std::uint32_t cat) {
  return static_cast<std::uint32_t>(v < 0 ? v + static_cast<int>((1U << cat) - 1U) : v);
}

/// cos((2x+1)uπ/16) · C(u)/2, so a separable pass is two 8×8 matrix products.
std::array<double, 64> dct_basis() {
  std::array<double, 64> m{};
  const std::span<double> s(m);
  for (std::size_t u = 0; u < 8; ++u) {
    const double cu = u == 0 ? 1.0 / std::numbers::sqrt2 : 1.0;
    for (std::size_t x = 0; x < 8; ++x) {
      s[u * 8 + x] = 0.5 * cu * std::cos(static_cast<double>(2 * x + 1) * static_cast<double>(u) * std::numbers::pi / 16.0);
    }
  }
  return m;
}

struct Component {
  std::span<const std::uint8_t> quant;  // zigzag order
  const Huffman* dc;
  const Huffman* ac;
  int pred = 0;
};

void encode_block(BitWriter& bw, std::span<const double> block, std::span<const double> basis, Component& c) {
  std::array<double, 64> tmp{};
  std::array<double, 64> coef{};
  const std::span<double> t(tmp);
  const std::span<double> f(coef);
  for (std::size_t y = 0; y < 8; ++y) {
    for (std::size_t u = 0; u < 8; ++u) {
      double s = 0;
      for (std::size_t x = 0; x < 8; ++x) s += basis[u * 8 + x] * block[y * 8 + x];
      t[y * 8 + u] = s;
    }
  }
  for (std::size_t v = 0; v < 8; ++v) {
    for (std::size_t u = 0; u < 8; ++u) {
      double s = 0;
      for (std::size_t y = 0; y < 8; ++y) s += basis[v * 8 + y] * t[y * 8 + u];
      f[v * 8 + u] = s;
    }
  }
  std::array<int, 64> q{};
  const std::span<int> qs(q);
  const std::span<const std::uint8_t> zz(kZigzag);
  for (std::size_t i = 0; i < 64; ++i) {
    qs[i] = static_cast<int>(std::lround(f[zz[i]] / static_cast<double>(c.quant[i])));
  }
  const int diff = qs[0] - c.pred;
  c.pred = qs[0];
  const std::uint32_t dcat = category(diff);
  const std::span<const std::uint16_t> dcode(c.dc->code);
  const std::span<const std::uint8_t> dsize(c.dc->size);
  bw.put(dcode[dcat], dsize[dcat]);
  if (dcat > 0) bw.put(value_bits(diff, dcat), dcat);
  const std::span<const std::uint16_t> acode(c.ac->code);
  const std::span<const std::uint8_t> asize(c.ac->size);
  std::uint32_t run = 0;
  for (std::size_t i = 1; i < 64; ++i) {
    if (qs[i] == 0) {
      ++run;
      continue;
    }
    while (run >= 16) {
      bw.put(acode[0xF0], asize[0xF0]);  // ZRL
      run -= 16;
    }
    const std::uint32_t cat = category(qs[i]);
    const std::size_t sym = (run << 4U) | cat;
    bw.put(acode[sym], asize[sym]);
    bw.put(value_bits(qs[i], cat), cat);
    run = 0;
  }
  if (run > 0) bw.put(acode[0], asize[0]);  // EOB
}

void put_u16(std::vector<std::uint8_t>& out, std::uint32_t v) {
  out.push_back(static_cast<std::uint8_t>(v >> 8U));
  out.push_back(static_cast<std::uint8_t>(v));
}

void put_dht(std::vector<std::uint8_t>& out, std::uint8_t cls_id, std::span<const std::uint8_t> bits,
             std::span<const std::uint8_t> vals) {
  out.insert(out.end(), {0xFF, 0xC4});
  put_u16(out, static_cast<std::uint32_t>(2 + 1 + 16 + vals.size()));
  out.push_back(cls_id);
  out.insert(out.end(), bits.begin(), bits.end());
  out.insert(out.end(), vals.begin(), vals.end());
}

bool encode_baseline(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height, float quality,
                     std::vector<std::uint8_t>& out) {
  if (width > 0xFFFF || height > 0xFFFF) return false;
  const int q = std::clamp(static_cast<int>(std::lround(quality * 100.F)), 1, 100);
  const std::array<std::uint8_t, 64> lq = scaled_quant(kLumaQuant, q);
  const std::array<std::uint8_t, 64> cq = scaled_quant(kChromaQuant, q);
  const Huffman dcl = build_huffman(kDcLumaBits, kDcVals);
  const Huffman dcc = build_huffman(kDcChromaBits, kDcVals);
  const Huffman acl = build_huffman(kAcLumaBits, kAcLumaVals);
  const Huffman acc = build_huffman(kAcChromaBits, kAcChromaVals);

  out.insert(out.end(), {0xFF, 0xD8});                                   // SOI
  out.insert(out.end(), {0xFF, 0xE0, 0, 16, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0});  // APP0 JFIF 1.1
  for (std::uint8_t id = 0; id < 2; ++id) {                              // DQT
    out.insert(out.end(), {0xFF, 0xDB, 0, 67, id});
    const auto& t = id == 0 ? lq : cq;
    out.insert(out.end(), t.begin(), t.end());
  }
  out.insert(out.end(), {0xFF, 0xC0, 0, 17, 8});                          // SOF0
  put_u16(out, height);
  put_u16(out, width);
  out.insert(out.end(), {3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1});
  put_dht(out, 0x00, kDcLumaBits, kDcVals);
  put_dht(out, 0x10, kAcLumaBits, kAcLumaVals);
  put_dht(out, 0x01, kDcChromaBits, kDcVals);
  put_dht(out, 0x11, kAcChromaBits, kAcChromaVals);
  out.insert(out.end(), {0xFF, 0xDA, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0});  // SOS

  const std::array<double, 64> basis = dct_basis();
  std::array<Component, 3> comps = {Component{lq, &dcl, &acl}, Component{cq, &dcc, &acc}, Component{cq, &dcc, &acc}};
  std::array<double, std::size_t{64} * 3> blocks{};
  const std::span<double> b(blocks);
  BitWriter bw(out);
  for (std::uint32_t by = 0; by < height; by += 8) {
    for (std::uint32_t bx = 0; bx < width; bx += 8) {
      for (std::uint32_t y = 0; y < 8; ++y) {
        const std::size_t sy = std::min(by + y, height - 1);  // edge blocks repeat the last row / column
        for (std::uint32_t x = 0; x < 8; ++x) {
          const std::size_t sx = std::min(bx + x, width - 1);
          const std::span<const std::uint8_t> px = rgba.subspan((sy * width + sx) * 4, 3);
          const double r = px[0];
          const double g = px[1];
          const double bl = px[2];
          const std::size_t i = std::size_t{y} * 8 + x;
          b[i] = 0.299 * r + 0.587 * g + 0.114 * bl - 128.0;
          b[64 + i] = -0.168736 * r - 0.331264 * g + 0.5 * bl;
          b[128 + i] = 0.5 * r - 0.418688 * g - 0.081312 * bl;
        }
      }
      for (std::size_t c = 0; c < 3; ++c) encode_block(bw, b.subspan(c * 64, 64), basis, comps.at(c));
    }
  }
  bw.flush();
  out.insert(out.end(), {0xFF, 0xD9});  // EOI
  return true;
}

#endif

#ifdef _WIN32

using Microsoft::WRL::ComPtr;

class ComScope {
 public:
  ComScope() : hr_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComScope() {
    if (SUCCEEDED(hr_)) CoUninitialize();
  }
  ComScope(const ComScope&) = delete;
  ComScope& operator=(const ComScope&) = delete;
  [[nodiscard]] bool usable() const noexcept { return SUCCEEDED(hr_) || hr_ == RPC_E_CHANGED_MODE; }

 private:
  HRESULT hr_;
};

#endif

}  // namespace

bool encode_jpeg_rgba8(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height, float quality,
                       std::vector<std::uint8_t>& out) {
  out.clear();
  if (width == 0 || height == 0 || rgba.size() < std::size_t{width} * height * 4) return false;
#ifdef _WIN32
  const ComScope com;
  if (!com.usable()) return false;
  ComPtr<IWICImagingFactory> factory;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_IWICImagingFactory,
                              reinterpret_cast<void**>(factory.GetAddressOf())))) {  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): COM out-param
    return false;
  }
  ComPtr<IStream> stream;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, stream.GetAddressOf()))) return false;
  ComPtr<IWICBitmapEncoder> encoder;
  if (FAILED(factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, encoder.GetAddressOf()))) return false;
  if (FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache))) return false;
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> bag;
  if (FAILED(encoder->CreateNewFrame(frame.GetAddressOf(), bag.GetAddressOf()))) return false;
  PROPBAG2 name{};
  name.pstrName = const_cast<LPOLESTR>(L"ImageQuality");  // NOLINT(cppcoreguidelines-pro-type-const-cast): PROPBAG2 is not const
  VARIANT q;
  VariantInit(&q);
  q.vt = VT_R4;
  q.fltVal = std::clamp(quality, 0.F, 1.F);
  if (bag) bag->Write(1, &name, &q);
  VariantClear(&q);
  if (FAILED(frame->Initialize(bag.Get()))) return false;
  if (FAILED(frame->SetSize(width, height))) return false;
  WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR;
  if (FAILED(frame->SetPixelFormat(&fmt))) return false;
  if (fmt != GUID_WICPixelFormat24bppBGR) return false;
  const std::uint32_t stride = width * 3;
  std::vector<std::uint8_t> bgr(std::size_t{stride} * height);
  for (std::uint32_t y = 0; y < height; ++y) {
    const std::uint8_t* src = rgba.data() + std::size_t{y} * width * 4;
    std::uint8_t* dst = bgr.data() + std::size_t{y} * stride;
    for (std::uint32_t x = 0; x < width; ++x) {
      dst[0] = src[2];
      dst[1] = src[1];
      dst[2] = src[0];
      src += 4;
      dst += 3;
    }
  }
  if (FAILED(frame->WritePixels(height, stride, static_cast<UINT>(bgr.size()), bgr.data()))) return false;
  if (FAILED(frame->Commit()) || FAILED(encoder->Commit())) return false;
  STATSTG stat{};
  if (FAILED(stream->Stat(&stat, STATFLAG_NONAME)) || stat.cbSize.HighPart != 0) return false;
  LARGE_INTEGER zero{};
  if (FAILED(stream->Seek(zero, STREAM_SEEK_SET, nullptr))) return false;
  out.resize(stat.cbSize.LowPart);
  ULONG got = 0;
  if (FAILED(stream->Read(out.data(), stat.cbSize.LowPart, &got)) || got != stat.cbSize.LowPart) {
    out.clear();
    return false;
  }
  return out.size() >= 2 && out[0] == 0xFF && out[1] == 0xD8;
#else
  return encode_baseline(rgba, width, height, quality, out);
#endif
}

}  // namespace premation::exporter
