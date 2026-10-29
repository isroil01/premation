#include "psd_read.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string_view>

#include "deflate.hpp"

namespace premation::doc::psd {

namespace {

/// A read past the end, or a structure that cannot be: the file is refused with `what`.
struct Malformed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

class Reader {
 public:
  explicit Reader(std::span<const std::uint8_t> b) : b_(b) {}
  [[nodiscard]] std::size_t pos() const noexcept { return p_; }
  [[nodiscard]] std::size_t size() const noexcept { return b_.size(); }
  void seek(std::size_t p) {
    if (p > b_.size()) throw Malformed("the file ends early");
    p_ = p;
  }
  void skip(std::uint64_t n) {
    if (n > b_.size() - p_) throw Malformed("the file ends early");
    p_ += static_cast<std::size_t>(n);
  }
  std::span<const std::uint8_t> bytes(std::uint64_t n) {
    if (n > b_.size() - p_) throw Malformed("the file ends early");
    const auto s = b_.subspan(p_, static_cast<std::size_t>(n));
    p_ += static_cast<std::size_t>(n);
    return s;
  }
  std::uint8_t u8() { return bytes(1)[0]; }
  std::uint16_t u16() {
    const auto s = bytes(2);
    return static_cast<std::uint16_t>((s[0] << 8) | s[1]);
  }
  std::int16_t i16() { return static_cast<std::int16_t>(u16()); }
  std::uint32_t u32() {
    const auto s = bytes(4);
    return (std::uint32_t{s[0]} << 24) | (std::uint32_t{s[1]} << 16) | (std::uint32_t{s[2]} << 8) | s[3];
  }
  std::int32_t i32() { return static_cast<std::int32_t>(u32()); }
  std::uint64_t u64() {
    const std::uint64_t hi = u32();
    return (hi << 32) | u32();
  }
  std::string key() {
    const auto s = bytes(4);
    return {reinterpret_cast<const char*>(s.data()), 4};
  }

 private:
  std::span<const std::uint8_t> b_;
  std::size_t p_ = 0;
};

struct ChannelInfo {
  int id = 0;
  std::uint64_t length = 0;
};

struct Record {
  Layer layer;
  int bottom = 0;
  int right = 0;
  std::vector<ChannelInfo> channels;
  // User mask.
  int maskTop = 0, maskLeft = 0, maskBottom = 0, maskRight = 0;
  int maskDefault = 255;
  bool maskDisabled = true;
  /// lsct: 0 a layer, 1 / 2 an open / closed group, 3 the group's closing divider.
  int section = 0;
  bool adjustment = false;
};

/// The keys whose length is 8 bytes in a PSB.
bool long_key(std::string_view k) {
  for (const char* x : {"LMsk", "Lr16", "Lr32", "Layr", "Mt16", "Mt32", "Mtrn", "Alph", "FMsk", "lnk2", "FEid", "FXid", "PxSD"}) {
    if (k == x) return true;
  }
  return false;
}

/// Keys a layer carries when it is an adjustment or fill layer (no raster of its own).
bool adjustment_key(std::string_view k) {
  for (const char* x : {"levl", "curv", "brit", "blnc", "hue2", "hue ", "selc", "mixr", "grdm", "phfl", "expA", "vibA", "post", "thrs",
                        "nvrt", "blwh", "clrL", "SoCo", "GdFl", "PtFl"}) {
    if (k == x) return true;
  }
  return false;
}

std::string utf8_of_utf16be(std::span<const std::uint8_t> s, std::size_t count) {
  std::string out;
  for (std::size_t i = 0; i + 1 < s.size() && i / 2 < count; i += 2) {
    std::uint32_t c = (std::uint32_t{s[i]} << 8) | s[i + 1];
    if (c >= 0xD800 && c <= 0xDBFF && i + 3 < s.size()) {
      const std::uint32_t lo = (std::uint32_t{s[i + 2]} << 8) | s[i + 3];
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
        i += 2;
      }
    }
    if (c == 0) break;
    if (c < 0x80) {
      out.push_back(static_cast<char>(c));
    } else if (c < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (c >> 6)));
      out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    } else if (c < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (c >> 12)));
      out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (c >> 18)));
      out.push_back(static_cast<char>(0x80 | ((c >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    }
  }
  return out;
}

/// Photoshop's Pascal names are in the system code page; ASCII is kept, the rest dropped (a `luni` name replaces it when present).
std::string ascii_of(std::span<const std::uint8_t> s) {
  std::string out;
  for (const auto c : s) {
    if (c >= 0x20 && c < 0x7F) out.push_back(static_cast<char>(c));
  }
  return out;
}

/// PackBits rows into exactly `expected` bytes (short input leaves zeros, extra is ignored).
void unpack_bits(std::span<const std::uint8_t> src, std::uint8_t* out, std::size_t expected) {
  std::size_t si = 0;
  std::size_t di = 0;
  while (si < src.size() && di < expected) {
    const auto n = static_cast<std::int8_t>(src[si++]);
    if (n >= 0) {
      const std::size_t count = std::min<std::size_t>(static_cast<std::size_t>(n) + 1, std::min(expected - di, src.size() - si));
      std::memcpy(out + di, src.data() + si, count);
      si += static_cast<std::size_t>(n) + 1;
      di += count;
    } else if (n != -128) {
      const std::size_t count = std::min<std::size_t>(static_cast<std::size_t>(1 - n), expected - di);
      if (si >= src.size()) break;
      std::memset(out + di, src[si++], count);
      di += count;
    }
  }
}

/// One channel's samples (big-endian, `bps` bytes each) from its compressed bytes.
std::vector<std::uint8_t> decode_channel(std::span<const std::uint8_t> data, int compression, int w, int h, int bps, bool psb) {
  const std::size_t rowBytes = static_cast<std::size_t>(w) * static_cast<std::size_t>(bps);
  const std::size_t total = rowBytes * static_cast<std::size_t>(h);
  std::vector<std::uint8_t> out(total, 0);
  if (total == 0) return out;
  if (compression == 0) {
    std::memcpy(out.data(), data.data(), std::min(total, data.size()));
  } else if (compression == 1) {
    Reader r(data);
    std::vector<std::uint64_t> counts(static_cast<std::size_t>(h));
    for (auto& c : counts) c = psb ? r.u32() : r.u16();
    for (int y = 0; y < h; ++y) {
      const auto row = r.bytes(counts[static_cast<std::size_t>(y)]);
      unpack_bits(row, out.data() + static_cast<std::size_t>(y) * rowBytes, rowBytes);
    }
  } else if (compression == 2 || compression == 3) {
    if (data.size() < 2) throw Malformed("a ZIP channel is empty");
    // A zlib stream: its 2-byte header, then raw DEFLATE.
    if (!zlib::inflate_raw(data.subspan(2), total, out)) throw Malformed("a ZIP channel does not inflate");
    out.resize(total, 0);
    if (compression == 3) {
      for (int y = 0; y < h; ++y) {
        std::uint8_t* row = out.data() + static_cast<std::size_t>(y) * rowBytes;
        if (bps == 1) {
          for (int x = 1; x < w; ++x) row[x] = static_cast<std::uint8_t>(row[x] + row[x - 1]);
        } else if (bps == 2) {
          for (int x = 1; x < w; ++x) {
            const auto prev = static_cast<std::uint16_t>((row[(x - 1) * 2] << 8) | row[(x - 1) * 2 + 1]);
            const auto cur = static_cast<std::uint16_t>((row[x * 2] << 8) | row[x * 2 + 1]);
            const auto v = static_cast<std::uint16_t>(prev + cur);
            row[x * 2] = static_cast<std::uint8_t>(v >> 8);
            row[x * 2 + 1] = static_cast<std::uint8_t>(v & 0xFF);
          }
        } else {
          // 32-bit: the row is byte-delta coded, then split into four byte planes.
          for (std::size_t i = 1; i < rowBytes; ++i) row[i] = static_cast<std::uint8_t>(row[i] + row[i - 1]);
          std::vector<std::uint8_t> planes(row, row + rowBytes);
          for (int x = 0; x < w; ++x) {
            for (int k = 0; k < 4; ++k) row[x * 4 + k] = planes[static_cast<std::size_t>(k * w + x)];
          }
        }
      }
    }
  } else {
    throw Malformed("channel compression " + std::to_string(compression) + " is not one Photoshop writes");
  }
  return out;
}

double srgb_encode(double v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * std::pow(v, 1.0 / 2.4) - 0.055;
}

/// Sample `i` of a channel as 0–255. 32-bit samples are linear light: colour is sRGB-encoded, alpha is not.
std::uint8_t sample8(const std::vector<std::uint8_t>& ch, std::size_t i, int bps, bool colour) {
  if (bps == 1) return ch[i];
  if (bps == 2) {
    const std::uint32_t v = (std::uint32_t{ch[i * 2]} << 8) | ch[i * 2 + 1];
    return static_cast<std::uint8_t>((v * 255 + 32767) / 65535);
  }
  const std::uint32_t bits = (std::uint32_t{ch[i * 4]} << 24) | (std::uint32_t{ch[i * 4 + 1]} << 16) | (std::uint32_t{ch[i * 4 + 2]} << 8) | ch[i * 4 + 3];
  double v = std::bit_cast<float>(bits);
  if (!std::isfinite(v)) v = 0;
  v = colour ? srgb_encode(v) : std::clamp(v, 0.0, 1.0);
  return static_cast<std::uint8_t>(std::lround(v * 255));
}

/// Straight RGBA8 from colour channels (by Photoshop id) for one rectangle.
void compose_rgba(int colorMode, int bps, int w, int h, const std::vector<const std::vector<std::uint8_t>*>& colour,
                  const std::vector<std::uint8_t>* alpha, std::vector<std::uint8_t>& out) {
  const std::size_t n = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  out.assign(n * 4, 255);
  for (std::size_t i = 0; i < n; ++i) {
    std::uint8_t r = 0, g = 0, b = 0;
    if (colorMode == 1) {
      r = g = b = colour[0] != nullptr ? sample8(*colour[0], i, bps, true) : 0;
    } else if (colorMode == 4) {
      // CMYK: Photoshop stores 255 − ink. A plain (unmanaged) conversion.
      const auto ink = [&](int k) { return colour[static_cast<std::size_t>(k)] != nullptr ? sample8(*colour[static_cast<std::size_t>(k)], i, bps, false) : 255; };
      const int k = ink(3);
      r = static_cast<std::uint8_t>(ink(0) * k / 255);
      g = static_cast<std::uint8_t>(ink(1) * k / 255);
      b = static_cast<std::uint8_t>(ink(2) * k / 255);
    } else {
      r = colour[0] != nullptr ? sample8(*colour[0], i, bps, true) : 0;
      g = colour[1] != nullptr ? sample8(*colour[1], i, bps, true) : 0;
      b = colour[2] != nullptr ? sample8(*colour[2], i, bps, true) : 0;
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = alpha != nullptr ? sample8(*alpha, i, bps, false) : 255;
  }
}

int colour_channels(int colorMode) { return colorMode == 1 ? 1 : colorMode == 4 ? 4 : 3; }

/// Layer records, then their channel data, from `r` (positioned after the layer-info length).
void read_layer_info(Reader& r, std::size_t end, const Document& doc, bool psb, std::vector<Record>& records) {
  if (r.pos() >= end) return;
  const int count = std::abs(static_cast<int>(r.i16()));
  records.reserve(static_cast<std::size_t>(count));
  for (int li = 0; li < count; ++li) {
    Record rec;
    const int top = r.i32();
    const int left = r.i32();
    rec.bottom = r.i32();
    rec.right = r.i32();
    rec.layer.top = top;
    rec.layer.left = left;
    rec.layer.width = std::max(0, rec.right - left);
    rec.layer.height = std::max(0, rec.bottom - top);
    const int nch = r.u16();
    if (nch > 56) throw Malformed("a layer has " + std::to_string(nch) + " channels");
    for (int c = 0; c < nch; ++c) {
      ChannelInfo ci;
      ci.id = r.i16();
      ci.length = psb ? r.u64() : r.u32();
      rec.channels.push_back(ci);
    }
    const std::string sig = r.key();
    if (sig != "8BIM" && sig != "8B64") throw Malformed("a layer record has no blend signature");
    rec.layer.blend = r.key();
    int opacity = r.u8();
    rec.layer.clipped = r.u8() == 1;
    const int flags = r.u8();
    rec.layer.visible = (flags & 0x02) == 0;
    (void)r.u8();
    const std::uint32_t extraLen = r.u32();
    const std::size_t extraEnd = r.pos() + extraLen;
    if (extraEnd > end) throw Malformed("a layer record runs past its section");
    // Mask data.
    const std::uint32_t maskLen = r.u32();
    const std::size_t maskEnd = r.pos() + maskLen;
    if (maskLen >= 18) {
      rec.maskTop = r.i32();
      rec.maskLeft = r.i32();
      rec.maskBottom = r.i32();
      rec.maskRight = r.i32();
      rec.maskDefault = r.u8();
      const int mflags = r.u8();
      rec.maskDisabled = (mflags & 0x02) != 0;
    }
    r.seek(maskEnd);
    // Blending ranges.
    r.skip(r.u32());
    // Pascal name, padded to a multiple of 4.
    const int nameLen = r.u8();
    rec.layer.name = ascii_of(r.bytes(static_cast<std::uint64_t>(nameLen)));
    const int padded = ((nameLen + 1 + 3) / 4) * 4;
    r.skip(static_cast<std::uint64_t>(padded - nameLen - 1));
    int fill = 255;
    // Additional layer information.
    while (r.pos() + 12 <= extraEnd) {
      const std::string s = r.key();
      if (s != "8BIM" && s != "8B64") break;
      const std::string k = r.key();
      const std::uint64_t len = psb && long_key(k) ? r.u64() : r.u32();
      const std::size_t blockEnd = r.pos() + static_cast<std::size_t>(std::min<std::uint64_t>(len, extraEnd - r.pos()));
      if (k == "luni" && len >= 4) {
        const std::uint32_t chars = r.u32();
        rec.layer.name = utf8_of_utf16be(r.bytes(blockEnd - r.pos()), chars);
      } else if ((k == "lsct" || k == "lsdk") && len >= 4) {
        rec.section = static_cast<int>(r.u32());
        if (len >= 12) {
          (void)r.key();
          rec.layer.blend = r.key();
        }
      } else if (k == "iOpa" && len >= 1) {
        fill = r.u8();
      } else if (adjustment_key(k)) {
        rec.adjustment = true;
      }
      r.seek(blockEnd);
    }
    r.seek(extraEnd);
    rec.layer.opacity = (opacity * fill + 127) / 255;
    records.push_back(std::move(rec));
  }
  // Channel image data, in record order.
  const int bps = doc.depth / 8;
  const int ncol = colour_channels(doc.colorMode);
  for (Record& rec : records) {
    std::vector<std::vector<std::uint8_t>> planes(rec.channels.size());
    for (std::size_t c = 0; c < rec.channels.size(); ++c) {
      const ChannelInfo& ci = rec.channels[c];
      if (ci.length < 2) {
        r.skip(ci.length);
        continue;
      }
      const std::size_t start = r.pos();
      const int compression = r.u16();
      const bool isMask = ci.id == -2 || ci.id == -3;
      const int w = isMask ? std::max(0, rec.maskRight - rec.maskLeft) : rec.layer.width;
      const int h = isMask ? std::max(0, rec.maskBottom - rec.maskTop) : rec.layer.height;
      const auto data = r.bytes(ci.length - 2);
      if (ci.id != -3) planes[c] = decode_channel(data, compression, w, h, bps, psb);
      r.seek(start + static_cast<std::size_t>(ci.length));
    }
    if (rec.section != 0 || rec.layer.width == 0 || rec.layer.height == 0) continue;
    std::vector<const std::vector<std::uint8_t>*> colour(static_cast<std::size_t>(ncol), nullptr);
    const std::vector<std::uint8_t>* alpha = nullptr;
    const std::vector<std::uint8_t>* mask = nullptr;
    bool anyColour = false;
    for (std::size_t c = 0; c < rec.channels.size(); ++c) {
      const int id = rec.channels[c].id;
      if (planes[c].empty()) continue;
      if (id >= 0 && id < ncol) {
        colour[static_cast<std::size_t>(id)] = &planes[c];
        anyColour = true;
      } else if (id == -1) {
        alpha = &planes[c];
      } else if (id == -2) {
        mask = &planes[c];
      }
    }
    if (!anyColour) continue;
    compose_rgba(doc.colorMode, bps, rec.layer.width, rec.layer.height, colour, alpha, rec.layer.rgba);
    // The user mask multiplies the alpha (outside its rectangle: its default colour).
    if (mask != nullptr && !rec.maskDisabled) {
      const int mw = rec.maskRight - rec.maskLeft;
      for (int y = 0; y < rec.layer.height; ++y) {
        for (int x = 0; x < rec.layer.width; ++x) {
          const int dx = rec.layer.left + x - rec.maskLeft;
          const int dy = rec.layer.top + y - rec.maskTop;
          int m = rec.maskDefault;
          if (dx >= 0 && dy >= 0 && dx < mw && dy < rec.maskBottom - rec.maskTop) {
            m = sample8(*mask, static_cast<std::size_t>(dy) * static_cast<std::size_t>(mw) + static_cast<std::size_t>(dx), bps, false);
          }
          std::uint8_t& a = rec.layer.rgba[(static_cast<std::size_t>(y) * static_cast<std::size_t>(rec.layer.width) + static_cast<std::size_t>(x)) * 4 + 3];
          a = static_cast<std::uint8_t>((a * m + 127) / 255);
        }
      }
    }
  }
}

/// Records (bottom to top) → the layer tree; groups open at their closing divider (type 3) and close at their folder record.
void build_tree(std::vector<Record>& records, Document& doc) {
  std::vector<Layer> stack;
  std::vector<Layer> root;
  const auto top = [&]() -> std::vector<Layer>& { return stack.empty() ? root : stack.back().children; };
  for (Record& rec : records) {
    if (rec.section == 3) {
      Layer g;
      g.isGroup = true;
      stack.push_back(std::move(g));
    } else if (rec.section == 1 || rec.section == 2) {
      if (stack.empty()) continue;  // a folder without its divider: nothing to close
      Layer g = std::move(stack.back());
      stack.pop_back();
      g.name = rec.layer.name;
      g.opacity = rec.layer.opacity;
      g.blend = rec.layer.blend;
      g.visible = rec.layer.visible;
      g.clipped = rec.layer.clipped;
      top().push_back(std::move(g));
    } else if (rec.layer.rgba.empty()) {
      ++doc.skipped;
    } else {
      top().push_back(std::move(rec.layer));
    }
  }
  // Unclosed groups: their layers join the level above.
  while (!stack.empty()) {
    Layer g = std::move(stack.back());
    stack.pop_back();
    for (auto& c : g.children) top().push_back(std::move(c));
  }
  doc.layers = std::move(root);
}

}  // namespace

std::optional<Document> read(std::span<const std::uint8_t> file, bool withLayers, std::string& error) {
  try {
    Reader r(file);
    if (r.key() != "8BPS") throw Malformed("this is not a Photoshop file");
    const int version = r.u16();
    if (version != 1 && version != 2) throw Malformed("Photoshop file version " + std::to_string(version) + " is not PSD or PSB");
    const bool psb = version == 2;
    r.skip(6);
    Document doc;
    const int docChannels = r.u16();
    doc.height = static_cast<int>(r.u32());
    doc.width = static_cast<int>(r.u32());
    doc.depth = r.u16();
    doc.colorMode = r.u16();
    if (doc.width <= 0 || doc.height <= 0 || doc.width > 300000 || doc.height > 300000) throw Malformed("the canvas size is not valid");
    if (doc.depth != 8 && doc.depth != 16 && doc.depth != 32) {
      throw Malformed(std::to_string(doc.depth) + "-bit documents are not read (8, 16 and 32 bits are)");
    }
    if (doc.colorMode != 1 && doc.colorMode != 3 && doc.colorMode != 4) {
      static const char* const kModes[] = {"Bitmap", "Grayscale", "Indexed", "RGB", "CMYK", "?", "?", "Multichannel", "Duotone", "Lab"};
      const char* m = doc.colorMode >= 0 && doc.colorMode < 10 ? kModes[doc.colorMode] : "this";
      throw Malformed(std::string(m) + " colour mode is not read — convert the document to RGB in Photoshop");
    }
    r.skip(r.u32());  // colour mode data
    r.skip(r.u32());  // image resources
    const std::uint64_t lmLen = psb ? r.u64() : r.u32();
    const std::size_t lmStart = r.pos();
    const std::size_t lmEnd = lmStart + static_cast<std::size_t>(std::min<std::uint64_t>(lmLen, r.size() - lmStart));
    if (withLayers && lmLen > 0) {
      std::vector<Record> records;
      const std::uint64_t liLen = psb ? r.u64() : r.u32();
      const std::size_t liEnd = r.pos() + static_cast<std::size_t>(std::min<std::uint64_t>(liLen, lmEnd - r.pos()));
      if (liLen > 0) read_layer_info(r, liEnd, doc, psb, records);
      r.seek(liEnd);
      // Global mask info, then additional blocks: 16 / 32-bit documents keep their layers in Lr16 / Lr32.
      if (r.pos() + 4 <= lmEnd) r.skip(std::min<std::uint64_t>(r.u32(), lmEnd - r.pos()));
      while (records.empty() && r.pos() + 12 <= lmEnd) {
        const std::string s = r.key();
        if (s != "8BIM" && s != "8B64") break;
        const std::string k = r.key();
        const std::uint64_t len = psb && long_key(k) ? r.u64() : r.u32();
        const std::size_t blockEnd = r.pos() + static_cast<std::size_t>(std::min<std::uint64_t>(len, lmEnd - r.pos()));
        if (k == "Lr16" || k == "Lr32" || k == "Layr") read_layer_info(r, blockEnd, doc, psb, records);
        r.seek(blockEnd);
        // Blocks here are padded to 4 bytes.
        while (r.pos() % 4 != 0 && r.pos() < lmEnd) r.skip(1);
      }
      build_tree(records, doc);
    }
    r.seek(lmEnd);
    // The merged image.
    if (r.pos() + 2 <= r.size()) {
      const int compression = r.u16();
      const int bps = doc.depth / 8;
      const int ncol = colour_channels(doc.colorMode);
      const int planesWanted = std::min(docChannels, ncol + 1);
      std::vector<std::vector<std::uint8_t>> planes(static_cast<std::size_t>(planesWanted));
      const std::size_t rowBytes = static_cast<std::size_t>(doc.width) * static_cast<std::size_t>(bps);
      bool ok = true;
      if (compression == 0) {
        for (auto& p : planes) {
          const auto s = r.bytes(rowBytes * static_cast<std::size_t>(doc.height));
          p.assign(s.begin(), s.end());
        }
      } else if (compression == 1) {
        const std::size_t rows = static_cast<std::size_t>(doc.height) * static_cast<std::size_t>(docChannels);
        std::vector<std::uint64_t> counts(rows);
        for (auto& c : counts) c = psb ? r.u32() : r.u16();
        for (int c = 0; c < planesWanted; ++c) {
          auto& p = planes[static_cast<std::size_t>(c)];
          p.assign(rowBytes * static_cast<std::size_t>(doc.height), 0);
          for (int y = 0; y < doc.height; ++y) {
            const auto row = r.bytes(counts[static_cast<std::size_t>(c) * static_cast<std::size_t>(doc.height) + static_cast<std::size_t>(y)]);
            unpack_bits(row, p.data() + static_cast<std::size_t>(y) * rowBytes, rowBytes);
          }
        }
      } else {
        ok = false;  // ZIP merged data is not written by Photoshop; the layers still import
      }
      if (ok) {
        std::vector<const std::vector<std::uint8_t>*> colour(static_cast<std::size_t>(ncol), nullptr);
        for (int c = 0; c < std::min(ncol, planesWanted); ++c) colour[static_cast<std::size_t>(c)] = &planes[static_cast<std::size_t>(c)];
        const std::vector<std::uint8_t>* alpha = planesWanted > ncol ? &planes[static_cast<std::size_t>(ncol)] : nullptr;
        compose_rgba(doc.colorMode, bps, doc.width, doc.height, colour, alpha, doc.composite);
      }
    }
    return doc;
  } catch (const Malformed& e) {
    error = e.what();
    return std::nullopt;
  }
}

std::string blend_mode_of(std::string_view key) {
  struct Pair {
    const char* key;
    const char* mode;
  };
  static constexpr Pair kModes[] = {
      {"pass", "normal"},       {"norm", "normal"},          {"diss", "dissolve"},      {"dark", "darken"},       {"mul ", "multiply"},
      {"idiv", "color-burn"},   {"lbrn", "linear-burn"},     {"dkCl", "darker-color"},  {"lite", "lighten"},      {"scrn", "screen"},
      {"div ", "color-dodge"},  {"lddg", "linear-dodge"},    {"lgCl", "lighter-color"}, {"over", "overlay"},      {"sLit", "soft-light"},
      {"hLit", "hard-light"},   {"vLit", "vivid-light"},     {"lLit", "linear-light"},  {"pLit", "pin-light"},    {"hMix", "hard-mix"},
      {"diff", "difference"},   {"smud", "exclusion"},       {"fsub", "subtract"},      {"fdiv", "divide"},       {"hue ", "hue"},
      {"sat ", "saturation"},   {"colr", "color"},           {"lum ", "luminosity"},
  };
  for (const auto& p : kModes) {
    if (key == p.key) return p.mode;
  }
  return "normal";
}

bool encode_png(std::span<const std::uint8_t> rgba, int width, int height, std::vector<std::uint8_t>& out) {
  if (width <= 0 || height <= 0 || rgba.size() < static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4) return false;
  const std::size_t row = static_cast<std::size_t>(width) * 4;
  // Filter Sub on every row: cheap, and flat graphics compress far better than unfiltered.
  std::vector<std::uint8_t> filtered((row + 1) * static_cast<std::size_t>(height));
  for (int y = 0; y < height; ++y) {
    const std::uint8_t* src = rgba.data() + static_cast<std::size_t>(y) * row;
    std::uint8_t* dst = filtered.data() + static_cast<std::size_t>(y) * (row + 1);
    dst[0] = 1;
    for (std::size_t i = 0; i < row; ++i) dst[i + 1] = static_cast<std::uint8_t>(src[i] - (i >= 4 ? src[i - 4] : 0));
  }
  std::vector<std::uint8_t> idat;
  if (!zlib::zlib_compress(filtered, 6, idat)) return false;
  out.clear();
  const std::uint8_t sig[] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
  out.insert(out.end(), std::begin(sig), std::end(sig));
  const auto chunk = [&](const char* type, std::span<const std::uint8_t> data) {
    const auto n = static_cast<std::uint32_t>(data.size());
    for (int s = 24; s >= 0; s -= 8) out.push_back(static_cast<std::uint8_t>((n >> s) & 0xFF));
    const std::size_t typeAt = out.size();
    out.insert(out.end(), type, type + 4);
    out.insert(out.end(), data.begin(), data.end());
    const std::uint32_t crc = zlib::crc32(std::span<const std::uint8_t>(out.data() + typeAt, 4 + data.size()));
    for (int s = 24; s >= 0; s -= 8) out.push_back(static_cast<std::uint8_t>((crc >> s) & 0xFF));
  };
  std::vector<std::uint8_t> ihdr(13, 0);
  for (int s = 0; s < 4; ++s) {
    ihdr[static_cast<std::size_t>(s)] = static_cast<std::uint8_t>((static_cast<std::uint32_t>(width) >> (24 - 8 * s)) & 0xFF);
    ihdr[static_cast<std::size_t>(4 + s)] = static_cast<std::uint8_t>((static_cast<std::uint32_t>(height) >> (24 - 8 * s)) & 0xFF);
  }
  ihdr[8] = 8;
  ihdr[9] = 6;
  chunk("IHDR", ihdr);
  const std::uint8_t srgb[] = {0};
  chunk("sRGB", srgb);
  chunk("IDAT", idat);
  chunk("IEND", {});
  return true;
}

}  // namespace premation::doc::psd
