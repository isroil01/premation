// FFI: font files (woff2), HarfBuzz shaping, SheenBidi bidi runs, Skia typefaces.
// The ONLY file that includes HarfBuzz, woff2 and SheenBidi (plus skia_ffi.hpp,
// shared with canvas_ffi.cpp).
//
// Shaping mirrors Blink's canvas text path (third_party/blink/renderer/platform/
// fonts/shaping): an hb_font per face at scale = size in 16.16 (truncated, as
// SkiaScalarToHarfBuzzPosition does), horizontal advances taken from Skia
// (SkFont::getWidths) rather than HarfBuzz's own tables, rounded to whole px when
// subpixel positioning is off; GPOS/kern and GSUB from HarfBuzz's OpenType
// shaper; letter spacing added once per cluster; bidi runs in visual order.

#include "fonts.hpp"
#include "skia_ffi.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <fstream>
#include <limits>
#include <map>
#include <mutex>
#include <ranges>
#include <string>
#include <unordered_map>
#include <utility>

#include "json.hpp"

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#endif
#include <hb-ot.h>
#include <hb.h>
#include <SheenBidi/SheenBidi.h>
#include <woff2/decode.h>
#include <woff2/output.h>
#include "include/core/SkData.h"
#include "include/core/SkFontArguments.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkFontStyle.h"
#include "include/core/SkPath.h"
#include "include/core/SkRect.h"
#include "include/core/SkStream.h"
#include "include/ports/SkFontMgr_empty.h"
#if defined(_WIN32)
#include "include/ports/SkTypeface_win.h"
#endif
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

namespace premation::raster {

// ── UTF-8 ────────────────────────────────────────────────────────────────────

std::vector<CodePoint> decode_utf8(std::string_view s) {
  std::vector<CodePoint> out;
  out.reserve(s.size());
  std::size_t i = 0;
  while (i < s.size()) {
    const auto b0 = static_cast<unsigned char>(s[i]);
    char32_t cp = 0xFFFD;
    std::size_t n = 1;
    if (b0 < 0x80) {
      cp = b0;
    } else if ((b0 >> 5U) == 0x6 && i + 1 < s.size()) {
      cp = ((b0 & 0x1FU) << 6U) | (static_cast<unsigned char>(s[i + 1]) & 0x3FU);
      n = 2;
    } else if ((b0 >> 4U) == 0xE && i + 2 < s.size()) {
      cp = ((b0 & 0x0FU) << 12U) | ((static_cast<unsigned char>(s[i + 1]) & 0x3FU) << 6U) |
           (static_cast<unsigned char>(s[i + 2]) & 0x3FU);
      n = 3;
    } else if ((b0 >> 3U) == 0x1E && i + 3 < s.size()) {
      cp = ((b0 & 0x07U) << 18U) | ((static_cast<unsigned char>(s[i + 1]) & 0x3FU) << 12U) |
           ((static_cast<unsigned char>(s[i + 2]) & 0x3FU) << 6U) | (static_cast<unsigned char>(s[i + 3]) & 0x3FU);
      n = 4;
    }
    out.push_back({cp, static_cast<std::uint32_t>(i)});
    i += n;
  }
  return out;
}

namespace {

struct HbBlobDel { void operator()(hb_blob_t* p) const noexcept { hb_blob_destroy(p); } };
struct HbFaceDel { void operator()(hb_face_t* p) const noexcept { hb_face_destroy(p); } };
struct HbFontDel { void operator()(hb_font_t* p) const noexcept { hb_font_destroy(p); } };
struct HbBufDel { void operator()(hb_buffer_t* p) const noexcept { hb_buffer_destroy(p); } };
struct HbFuncsDel { void operator()(hb_font_funcs_t* p) const noexcept { hb_font_funcs_destroy(p); } };
using HbBlob = std::unique_ptr<hb_blob_t, HbBlobDel>;
using HbFace = std::unique_ptr<hb_face_t, HbFaceDel>;
using HbFont = std::unique_ptr<hb_font_t, HbFontDel>;
using HbBuf = std::unique_ptr<hb_buffer_t, HbBufDel>;
using HbFuncs = std::unique_ptr<hb_font_funcs_t, HbFuncsDel>;

std::string lower(std::string_view s) {
  std::string o(s);
  for (char& c : o) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return o;
}

std::uint32_t tag_of(std::string_view t) {
  std::uint32_t v = 0;
  for (std::size_t i = 0; i < 4; ++i) v = (v << 8U) | static_cast<unsigned char>(i < t.size() ? t[i] : ' ');
  return v;
}

/// "'wght' 700, 'wdth' 80" → axis values.
std::vector<AxisValue> parse_variations(std::string_view s) {
  std::vector<AxisValue> out;
  std::size_t i = 0;
  while (i < s.size()) {
    const auto q = s.find_first_of("'\"", i);
    if (q == std::string_view::npos) break;
    const auto q2 = s.find(s[q], q + 1);
    if (q2 == std::string_view::npos) break;
    const std::string_view tag = s.substr(q + 1, q2 - q - 1);
    std::size_t j = q2 + 1;
    while (j < s.size() && s[j] == ' ') ++j;
    std::size_t k = j;
    while (k < s.size() && s[k] != ',') ++k;
    const std::string num(s.substr(j, k - j));
    char* end = nullptr;
    const double v = std::strtod(num.c_str(), &end);
    if (tag.size() == 4 && end != num.c_str()) out.push_back({tag_of(tag), static_cast<float>(v)});
    i = k + 1;
  }
  return out;
}

/// "'liga' 0, 'ss01'" / "\"liga\" off" → HarfBuzz features.
std::vector<hb_feature_t> parse_features(std::string_view s) {
  std::vector<hb_feature_t> out;
  std::size_t i = 0;
  while (i < s.size()) {
    const auto q = s.find_first_of("'\"", i);
    if (q == std::string_view::npos) break;
    const auto q2 = s.find(s[q], q + 1);
    if (q2 == std::string_view::npos) break;
    const std::string_view tag = s.substr(q + 1, q2 - q - 1);
    std::size_t k = q2 + 1;
    while (k < s.size() && s[k] != ',') ++k;
    std::string rest(s.substr(q2 + 1, k - q2 - 1));
    std::erase(rest, ' ');
    std::uint32_t value = 1;
    if (rest == "off" || rest == "0") value = 0;
    else if (!rest.empty() && rest != "on") value = static_cast<std::uint32_t>(std::strtoul(rest.c_str(), nullptr, 10));
    if (tag.size() == 4) {
      hb_feature_t f{};
      f.tag = tag_of(tag);
      f.value = value;
      f.start = HB_FEATURE_GLOBAL_START;
      f.end = HB_FEATURE_GLOBAL_END;
      out.push_back(f);
    }
    i = k + 1;
  }
  return out;
}

bool is_mark_like(char32_t cp) {
  // Combining marks, variation selectors, ZWJ/ZWNJ: they belong to the font of
  // the character they attach to (Blink's font fallback works per grapheme).
  return (cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x0483 && cp <= 0x0489) || (cp >= 0x0591 && cp <= 0x05BD) ||
         cp == 0x05BF || cp == 0x05C1 || cp == 0x05C2 || cp == 0x05C4 || cp == 0x05C5 || cp == 0x05C7 ||
         (cp >= 0x0610 && cp <= 0x061A) || (cp >= 0x064B && cp <= 0x065F) || cp == 0x0670 ||
         (cp >= 0x06D6 && cp <= 0x06DC) || (cp >= 0x06DF && cp <= 0x06E4) || cp == 0x06E7 || cp == 0x06E8 ||
         (cp >= 0x06EA && cp <= 0x06ED) || (cp >= 0x1AB0 && cp <= 0x1AFF) || (cp >= 0x1DC0 && cp <= 0x1DFF) ||
         (cp >= 0x20D0 && cp <= 0x20FF) || (cp >= 0x3099 && cp <= 0x309A) || (cp >= 0xFE00 && cp <= 0xFE0F) ||
         (cp >= 0xFE20 && cp <= 0xFE2F) || cp == 0x200C || cp == 0x200D || (cp >= 0xE0100 && cp <= 0xE01EF);
}

}  // namespace

// ── FontSet::Impl ───────────────────────────────────────────────────────────

struct FontSet::Impl {
  struct Face {
    FaceInfo info;
    std::string familyLower;
    std::vector<std::uint8_t> sfnt;
    HbBlob blob;
    HbFace face;
    sk_sp<SkTypeface> typeface;
    unsigned upem = 1000;
  };
  std::vector<std::unique_ptr<Face>> faces;
  std::vector<std::pair<std::string, std::string>> aliases;
  sk_sp<SkFontMgr> mgr;
  HbFuncs funcs;

  mutable std::mutex mu;  // guards the clone cache (shape/draw may run on several threads)
  mutable std::map<std::pair<int, std::string>, sk_sp<SkTypeface>> clones;

  [[nodiscard]] std::string resolve_family(std::string_view fam) const {
    std::string l = lower(fam);
    for (const auto& [from, to] : aliases) {
      if (lower(from) == l) return lower(to);
    }
    return l;
  }

  /// CSS Fonts 4 §5.2 weight + style matching over one family's faces: the set of
  /// face indices sharing the best (italic, weight) — several when unicode-range
  /// splits one logical face across files.
  [[nodiscard]] std::vector<int> match_family(const std::string& famLower, int weight, bool italic) const {
    std::vector<int> fam;
    for (std::size_t i = 0; i < faces.size(); ++i) {
      if (faces[i]->familyLower == famLower) fam.push_back(static_cast<int>(i));
    }
    if (fam.empty()) return fam;
    // Style first: the requested style if any face has it, else the other.
    bool haveStyle = false;
    for (const int i : fam) haveStyle = haveStyle || faces[static_cast<std::size_t>(i)]->info.italic == italic;
    const bool style = haveStyle ? italic : !italic;
    std::vector<int> weights;
    for (const int i : fam) {
      const auto& f = *faces[static_cast<std::size_t>(i)];
      if (f.info.italic == style) weights.push_back(f.info.weight);
    }
    std::ranges::sort(weights);
    const auto dup = std::ranges::unique(weights);
    weights.erase(dup.begin(), dup.end());
    // The nearest weight above (ascending) / below (descending) that passes `ok`, or -1.
    const auto above = [&weights](auto ok) {
      const auto it = std::ranges::find_if(weights, ok);
      return it == weights.end() ? -1 : *it;
    };
    const auto below = [&weights](auto ok) {
      const auto rev = std::views::reverse(weights);
      const auto it = std::ranges::find_if(rev, ok);
      return it == rev.end() ? -1 : *it;
    };
    int pick = 0;
    if (std::ranges::find(weights, weight) != weights.end()) {
      pick = weight;
    } else if (weight >= 400 && weight <= 500) {
      // Up to 500 ascending, then below descending, then above 500 ascending.
      int best = above([weight](int w) { return w > weight && w <= 500; });
      if (best < 0) best = below([weight](int w) { return w < weight; });
      if (best < 0) best = above([](int w) { return w > 500; });
      pick = best < 0 ? weights.front() : best;
    } else if (weight < 400) {
      int best = below([weight](int w) { return w < weight; });
      if (best < 0) best = above([weight](int w) { return w > weight; });
      pick = best < 0 ? weights.front() : best;
    } else {
      int best = above([weight](int w) { return w > weight; });
      if (best < 0) best = below([weight](int w) { return w < weight; });
      pick = best < 0 ? weights.back() : best;
    }
    std::vector<int> out;
    for (const int i : fam) {
      const auto& f = *faces[static_cast<std::size_t>(i)];
      if (f.info.italic == style && f.info.weight == pick) out.push_back(i);
    }
    return out;
  }

  [[nodiscard]] bool covers(int face, char32_t cp) const {
    const auto& f = *faces[static_cast<std::size_t>(face)];
    if (!f.info.unicodeRange.empty()) {
      bool in = false;
      for (const auto& r : f.info.unicodeRange) in = in || (cp >= r.lo && cp <= r.hi);
      if (!in) return false;
    }
    hb_font_t* font = hb_font_create(f.face.get());
    hb_codepoint_t g = 0;
    const bool has = hb_font_get_nominal_glyph(font, cp, &g) != 0;
    hb_font_destroy(font);
    return has;
  }
};

// Blink's HarfBuzz font funcs: advances from Skia.
namespace {

struct HbFontData {
  SkFont font;
  bool subpixel = true;
};

hb_position_t sk_to_hb(SkScalar v) {
  const double scaled = static_cast<double>(v) * 65536.0;
  if (!(scaled > static_cast<double>(std::numeric_limits<int>::min()))) return std::numeric_limits<int>::min();
  if (!(scaled < static_cast<double>(std::numeric_limits<int>::max()))) return std::numeric_limits<int>::max();
  return static_cast<hb_position_t>(scaled);  // truncation, as ClampTo<int>(float) does
}

/// Glyph-info caches, per thread. Every SkFont::getWidths / getBounds /
/// getMetrics call looks its strike up under Skia's process-wide strike-cache
/// mutex (and a miss generates the glyph under the scaler's global lock), and
/// animated text shapes and measures glyph by glyph — with several raster
/// workers those locks became the whole cost (16 threads ran 4x SLOWER than
/// one). thread_local maps need no lock and return the very values Skia
/// returned, so parity is untouched.
struct GlyphKey {
  std::uint32_t typeface = 0;
  std::uint32_t sizeBits = 0;
  std::uint32_t skewBits = 0;
  std::uint32_t glyph = 0;  // 0x10000 = the font's metrics, not a glyph
  bool embolden = false;
  std::uint8_t mode = 0;  // hinting | edging | subpixel: two FontSets may share a system typeface
  bool operator==(const GlyphKey&) const = default;
};
struct GlyphKeyHash {
  std::size_t operator()(const GlyphKey& k) const noexcept {
    std::uint64_t h = (static_cast<std::uint64_t>(k.typeface) << 32U) ^ k.sizeBits;
    h ^= (static_cast<std::uint64_t>(k.glyph) << 13U) ^ (static_cast<std::uint64_t>(k.embolden) << 47U) ^
         (static_cast<std::uint64_t>(k.mode) << 50U) ^ (static_cast<std::uint64_t>(k.skewBits) * 0x9E3779B97F4A7C15ULL);
    return std::hash<std::uint64_t>{}(h);
  }
};
constexpr std::size_t kGlyphCacheMax = std::size_t{1} << 16U;
constexpr std::uint32_t kMetricsGlyph = 0x10000;

GlyphKey key_of(const SkFont& font, std::uint32_t glyph) {
  return {font.getTypeface() != nullptr ? font.getTypeface()->uniqueID() : 0U,
          std::bit_cast<std::uint32_t>(font.getSize()),
          std::bit_cast<std::uint32_t>(font.getSkewX()),
          glyph,
          font.isEmbolden(),
          static_cast<std::uint8_t>(static_cast<unsigned>(font.getHinting()) | (static_cast<unsigned>(font.getEdging()) << 2U) |
                                    (font.isSubpixel() ? 16U : 0U))};
}

template <typename V, typename F>
V cached(std::unordered_map<GlyphKey, V, GlyphKeyHash>& cache, const GlyphKey& key, const F& compute) {
  if (const auto it = cache.find(key); it != cache.end()) return it->second;
  if (cache.size() >= kGlyphCacheMax) cache.clear();
  V v = compute();
  cache.emplace(key, v);
  return v;
}

SkScalar cached_width(const SkFont& font, SkGlyphID id) {
  thread_local std::unordered_map<GlyphKey, SkScalar, GlyphKeyHash> cache;
  return cached(cache, key_of(font, id), [&] {
    SkScalar w = 0;
    font.getWidths({&id, 1}, {&w, 1});
    return w;
  });
}

SkRect cached_bounds(const SkFont& font, SkGlyphID id) {
  thread_local std::unordered_map<GlyphKey, SkRect, GlyphKeyHash> cache;
  return cached(cache, key_of(font, id), [&] {
    SkRect r = SkRect::MakeEmpty();
    font.getBounds({&id, 1}, {&r, 1}, nullptr);
    return r;
  });
}

SkFontMetrics cached_metrics(const SkFont& font) {
  thread_local std::unordered_map<GlyphKey, SkFontMetrics, GlyphKeyHash> cache;
  return cached(cache, key_of(font, kMetricsGlyph), [&] {
    SkFontMetrics m{};
    font.getMetrics(&m);
    return m;
  });
}

hb_position_t h_advance(hb_font_t* /*font*/, void* data, hb_codepoint_t glyph, void* /*user*/) {
  const auto* d = static_cast<const HbFontData*>(data);
  const auto id = static_cast<SkGlyphID>(glyph);
  SkScalar w = cached_width(d->font, id);
  if (!d->subpixel) w = static_cast<SkScalar>(std::lround(w));
  return sk_to_hb(w);
}

}  // namespace

FontSet::FontSet(FontOptions opts) : opts_(opts), impl_(std::make_unique<Impl>()) {
#if defined(_WIN32)
  if (opts_.backend == GlyphBackend::platform) impl_->mgr = SkFontMgr_New_DirectWrite();
#endif
  if (!impl_->mgr) impl_->mgr = SkFontMgr_New_Custom_Empty();
  impl_->funcs.reset(hb_font_funcs_create());
  hb_font_funcs_set_glyph_h_advance_func(impl_->funcs.get(), h_advance, nullptr, nullptr);
  hb_font_funcs_make_immutable(impl_->funcs.get());
}

FontSet::~FontSet() = default;

std::size_t FontSet::face_count() const noexcept { return impl_->faces.size(); }

void FontSet::alias(std::string from, std::string to) { impl_->aliases.emplace_back(std::move(from), std::move(to)); }

bool FontSet::add_face(const FaceInfo& info, std::span<const std::uint8_t> bytes, std::string& error) {
  auto face = std::make_unique<Impl::Face>();
  face->info = info;
  face->familyLower = lower(info.family);
  if (bytes.size() >= 4 && std::memcmp(bytes.data(), "wOF2", 4) == 0) {
    std::string out;
    out.resize(woff2::ComputeWOFF2FinalSize(bytes.data(), bytes.size()));
    woff2::WOFF2StringOut sink(&out);
    if (!woff2::ConvertWOFF2ToTTF(bytes.data(), bytes.size(), &sink)) {
      error = "woff2 decode failed: " + info.file;
      return false;
    }
    out.resize(sink.Size());
    face->sfnt.assign(out.begin(), out.end());
  } else if (bytes.size() >= 4 && std::memcmp(bytes.data(), "wOFF", 4) == 0) {
    error = "WOFF (1.0) is not supported yet: " + info.file;
    return false;
  } else {
    face->sfnt.assign(bytes.begin(), bytes.end());
  }
  face->blob.reset(hb_blob_create(reinterpret_cast<const char*>(face->sfnt.data()),  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
                                  static_cast<unsigned>(face->sfnt.size()), HB_MEMORY_MODE_READONLY, nullptr, nullptr));
  face->face.reset(hb_face_create(face->blob.get(), static_cast<unsigned>(info.ttcIndex)));
  face->upem = hb_face_get_upem(face->face.get());
  face->typeface = impl_->mgr->makeFromData(SkData::MakeWithCopy(face->sfnt.data(), face->sfnt.size()), info.ttcIndex);
  if (!face->typeface) {
    error = "Skia could not load the face: " + info.file;
    return false;
  }
  impl_->faces.push_back(std::move(face));
  return true;
}

std::size_t FontSet::add_system_family(const std::string& family) {
#if defined(_WIN32)
  // Blink's default generic families on Windows (renderer preferences).
  std::string real = family;
  const std::string l = lower(family);
  if (l == "system-ui" || l == "-apple-system") real = "Segoe UI";
  else if (l == "sans-serif") real = "Arial";
  else if (l == "serif") real = "Times New Roman";
  else if (l == "monospace") real = "Consolas";
  else if (l == "cursive") real = "Comic Sans MS";
  else if (l == "fantasy") real = "Impact";
  for (const auto& f : impl_->faces) {
    if (f->familyLower == l) return 0;  // registered already (a manifest face wins)
  }
  const sk_sp<SkFontMgr> sys = SkFontMgr_New_DirectWrite();
  if (!sys) return 0;
  const sk_sp<SkFontStyleSet> set = sys->matchFamily(real.c_str());
  if (!set) return 0;
  std::size_t added = 0;
  for (int i = 0; i < set->count(); ++i) {
    const sk_sp<SkTypeface> tf = set->createTypeface(i);
    if (!tf) continue;
    int ttc = 0;
    const std::unique_ptr<SkStreamAsset> stream = tf->openStream(&ttc);
    if (!stream || !stream->hasLength()) continue;
    std::vector<std::uint8_t> bytes(stream->getLength());
    if (stream->read(bytes.data(), bytes.size()) != bytes.size()) continue;
    FaceInfo info;
    info.family = family;
    info.weight = tf->fontStyle().weight();
    info.italic = tf->fontStyle().slant() != SkFontStyle::kUpright_Slant;
    info.file = "system:" + real;
    info.ttcIndex = ttc;
    std::string err;
    if (add_face(info, bytes, err)) ++added;
  }
  return added;
#else
  (void)family;
  return 0;  // fontconfig / CoreText lookup: not ported yet
#endif
}

bool FontSet::load_manifest(const std::filesystem::path& manifest, std::string& error) {
  std::ifstream in(manifest, std::ios::binary);
  if (!in) {
    error = "cannot open " + manifest.string();
    return false;
  }
  const std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  json::Value doc;
  if (!json::parse(text, doc, error)) return false;
  const auto dir = manifest.parent_path();
  for (const auto& f : doc["faces"].items()) {
    FaceInfo info;
    info.family = f["family"].str();
    info.weight = static_cast<int>(f["weight"].num(400));
    info.italic = f["style"].str_or("normal") == "italic";
    info.file = f["file"].str();
    if (f.has("unicodeRange")) info.unicodeRange = css::parse_unicode_range(f["unicodeRange"].str());
    std::ifstream ff(dir / info.file, std::ios::binary);
    if (!ff) {
      error = "cannot open font " + (dir / info.file).string();
      return false;
    }
    const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(ff)), std::istreambuf_iterator<char>());
    if (!add_face(info, bytes, error)) return false;
  }
  for (const auto& a : doc["aliases"].keys()) alias(a, doc["aliases"][a].str());
  return true;
}

namespace ffi {

sk_sp<SkTypeface> typeface_for(const FontSet& fonts, int face, std::span<const AxisValue> axes) {
  const auto& impl = fonts.impl();
  const auto& f = *impl.faces.at(static_cast<std::size_t>(face));
  if (axes.empty()) return f.typeface;
  std::string key;
  for (const auto& a : axes) key += std::to_string(a.tag) + ":" + std::to_string(a.value) + ";";
  const std::scoped_lock lock(impl.mu);
  const auto it = impl.clones.find({face, key});
  if (it != impl.clones.end()) return it->second;
  std::vector<SkFontArguments::VariationPosition::Coordinate> coords;
  coords.reserve(axes.size());
  for (const auto& a : axes) coords.push_back({a.tag, a.value});
  SkFontArguments args;
  args.setVariationDesignPosition({coords.data(), static_cast<int>(coords.size())});
  sk_sp<SkTypeface> tf = f.typeface->makeClone(args);
  if (!tf) tf = f.typeface;
  impl.clones.emplace(std::make_pair(face, key), tf);
  return tf;
}

SkFont sk_font_for(const FontSet& fonts, int face, std::span<const AxisValue> axes, double sizePx, bool fakeBold,
                   bool fakeItalic) {
  SkFont font(typeface_for(fonts, face, axes), static_cast<SkScalar>(sizePx));
  const auto& o = fonts.options();
  font.setSubpixel(o.subpixelPositioning);
  font.setEdging(o.lcdEdging ? SkFont::Edging::kSubpixelAntiAlias : SkFont::Edging::kAntiAlias);
  font.setHinting(static_cast<SkFontHinting>(std::clamp(o.hinting, 0, 3)));
  font.setEmbolden(fakeBold);
  font.setSkewX(fakeItalic ? -SK_Scalar1 / 4 : 0);
  return font;
}

}  // namespace ffi

// ── shaping ─────────────────────────────────────────────────────────────────

ShapedText FontSet::shape(std::string_view text, const ShapeRequest& req) const {
  ShapedText out;
  out.sizePx = req.font.sizePx;
  out.axes = parse_variations(req.variations);
  const auto& impl = *impl_;
  std::vector<CodePoint> cps = decode_utf8(text);
  for (auto& c : cps) {
    if (c.cp == '\t' || c.cp == '\n' || c.cp == '\r' || c.cp == 0x0C) c.cp = ' ';  // TextRun::SetNormalizeSpace
  }

  // Families → the face set CSS matching selects in each.
  std::vector<std::vector<int>> famFaces;
  for (const auto& fam : req.font.families) {
    auto set = impl.match_family(impl.resolve_family(fam), req.font.weight, req.font.italic);
    if (!set.empty()) famFaces.push_back(std::move(set));
  }
  int primary = famFaces.empty() ? (impl.faces.empty() ? -1 : 0) : famFaces.front().back();
  if (primary < 0) return out;
  // Primary font: the first face of the first family that covers U+0020 (Blink's
  // primary font is the first available font of the list).
  if (!famFaces.empty()) {
    for (const int face : std::views::reverse(famFaces.front())) {
      if (impl.covers(face, U' ')) {
        primary = face;
        break;
      }
    }
  }

  // Per code point face.
  std::vector<int> faceOf(cps.size(), primary);
  for (std::size_t i = 0; i < cps.size(); ++i) {
    const char32_t cp = cps[i].cp;
    if (i > 0 && is_mark_like(cp)) { faceOf[i] = faceOf[i - 1]; continue; }
    int found = -1;
    for (const auto& set : famFaces) {
      // Later-registered faces of a segmented family win (Blink CSSSegmentedFontFace).
      for (auto it = set.rbegin(); it != set.rend() && found < 0; ++it) {
        if (impl.covers(*it, cp)) found = *it;
      }
      if (found >= 0) break;
    }
    faceOf[i] = found >= 0 ? found : primary;
  }

  const auto faceSynth = [&](int face) {
    const auto& fi = impl.faces[static_cast<std::size_t>(face)]->info;
    return std::make_pair(req.font.weight >= 600 && fi.weight <= 500, req.font.italic && !fi.italic);
  };

  // Font metrics of the primary face (Blink rounds ascent / descent).
  {
    const auto [fb, fi] = faceSynth(primary);
    const SkFont font = ffi::sk_font_for(*this, primary, out.axes, req.font.sizePx, fb, fi);
    const SkFontMetrics m = cached_metrics(font);
    out.ascent = std::round(-static_cast<double>(m.fAscent));
    out.descent = std::round(static_cast<double>(m.fDescent));
    // SimpleFontData::ComputeNormalizedTypoAscentAndDescent: the OS/2 typo
    // ascender : descender scaled to the font size (LayoutUnit-rounded), else
    // the rounded font ascent : descent. Measured: Segoe UI typo 1491/-431 at
    // 64 px → em ascent 49.640625, as Chromium's canvas `middle` baseline shows.
    const auto lu = [](float v) { return std::round(static_cast<double>(v) * 64.0) / 64.0; };  // LayoutUnit::FromFloatRound
    const auto size = static_cast<float>(req.font.sizePx);
    const auto trySet = [&](float a, float d) {
      if (a == 0 && d == 0) return false;
      const float h = a + d;
      if (!(h > 0)) return false;
      out.emAscent = lu(a * size / h);
      out.emDescent = lu(size) - out.emAscent;
      return true;
    };
    float typoA = 0;
    float typoD = 0;
    {
      hb_blob_t* os2 = hb_face_reference_table(impl.faces[static_cast<std::size_t>(primary)]->face.get(), HB_TAG('O', 'S', '/', '2'));
      unsigned len = 0;
      const auto* d = reinterpret_cast<const unsigned char*>(hb_blob_get_data(os2, &len));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
      if (d != nullptr && len >= 72) {
        const auto s16 = [d](unsigned o) {
          return static_cast<std::int16_t>((static_cast<unsigned>(d[o]) << 8U) | static_cast<unsigned>(d[o + 1]));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        };
        typoA = static_cast<float>(s16(68));
        typoD = -static_cast<float>(s16(70));
      }
      hb_blob_destroy(os2);
    }
    if (!trySet(typoA, typoD) && !trySet(static_cast<float>(out.ascent), static_cast<float>(out.descent))) {
      out.emAscent = lu(size);
      out.emDescent = 0;
    }
  }
  if (cps.empty()) return out;

  // Bidi runs in visual order.
  struct Run {
    std::size_t start = 0;
    std::size_t end = 0;
    bool rtl = false;
  };
  std::vector<Run> runs;
  {
    std::vector<std::uint32_t> u32(cps.size());
    for (std::size_t i = 0; i < cps.size(); ++i) u32[i] = cps[i].cp;
    SBCodepointSequence seq{SBStringEncodingUTF32, u32.data(), u32.size()};
    SBAlgorithmRef alg = SBAlgorithmCreate(&seq);
    SBParagraphRef para = SBAlgorithmCreateParagraph(alg, 0, u32.size(), req.rtl ? 1 : 0);
    SBLineRef line = SBParagraphCreateLine(para, 0, SBParagraphGetLength(para));
    const SBUInteger n = SBLineGetRunCount(line);
    const SBRun* r = SBLineGetRunsPtr(line);
    for (SBUInteger k = 0; k < n; ++k) {
      const SBRun& run = r[k];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      runs.push_back({run.offset, run.offset + run.length, (run.level & 1U) != 0});
    }
    SBLineRelease(line);
    SBParagraphRelease(para);
    SBAlgorithmRelease(alg);
  }

  std::vector<hb_feature_t> features = parse_features(req.features);
  if (!req.kerning) {
    hb_feature_t f{};
    f.tag = HB_TAG('k', 'e', 'r', 'n');
    f.value = 0;
    f.start = HB_FEATURE_GLOBAL_START;
    f.end = HB_FEATURE_GLOBAL_END;
    features.push_back(f);
  }
  if (req.letterSpacing != 0.0) {
    // Blink: non-zero letter-spacing disables the optional ligatures.
    for (const std::uint32_t t : {HB_TAG('l', 'i', 'g', 'a'), HB_TAG('c', 'l', 'i', 'g'), HB_TAG('d', 'l', 'i', 'g'),
                                  HB_TAG('h', 'l', 'i', 'g'), HB_TAG('c', 'a', 'l', 't')}) {
      hb_feature_t f{};
      f.tag = t;
      f.value = 0;
      f.start = HB_FEATURE_GLOBAL_START;
      f.end = HB_FEATURE_GLOBAL_END;
      features.push_back(f);
    }
  }
  std::vector<hb_variation_t> vars;
  vars.reserve(out.axes.size());
  for (const auto& a : out.axes) vars.push_back({a.tag, a.value});

  float pen = 0.0F;  // Blink accumulates in float
  const HbBuf buf(hb_buffer_create());
  for (const Run& run : runs) {
    // Font segments of this run, in logical order; visual order reverses for RTL.
    std::vector<std::pair<std::size_t, std::size_t>> segs;
    std::size_t s0 = run.start;
    for (std::size_t i = run.start + 1; i <= run.end; ++i) {
      if (i == run.end || faceOf[i] != faceOf[s0]) {
        segs.emplace_back(s0, i);
        s0 = i;
      }
    }
    if (run.rtl) std::ranges::reverse(segs);
    for (const auto& [a, b] : segs) {
      const int face = faceOf[a];
      const auto& fdata = *impl.faces[static_cast<std::size_t>(face)];
      const auto [fakeBold, fakeItalic] = faceSynth(face);
      HbFontData data{ffi::sk_font_for(*this, face, out.axes, req.font.sizePx, fakeBold, fakeItalic),
                      opts_.subpixelPositioning};
      const HbFont parent(hb_font_create(fdata.face.get()));
      const int scale = sk_to_hb(static_cast<SkScalar>(req.font.sizePx));
      hb_font_set_scale(parent.get(), scale, scale);
      if (!vars.empty()) hb_font_set_variations(parent.get(), vars.data(), static_cast<unsigned>(vars.size()));
      const HbFont font(hb_font_create_sub_font(parent.get()));
      hb_font_set_funcs(font.get(), impl.funcs.get(), &data, nullptr);

      hb_buffer_clear_contents(buf.get());
      for (std::size_t i = a; i < b; ++i) hb_buffer_add(buf.get(), cps[i].cp, cps[i].byte);
      hb_buffer_set_content_type(buf.get(), HB_BUFFER_CONTENT_TYPE_UNICODE);
      hb_buffer_set_direction(buf.get(), run.rtl ? HB_DIRECTION_RTL : HB_DIRECTION_LTR);
      hb_buffer_set_language(buf.get(), hb_language_from_string("en", -1));
      hb_buffer_guess_segment_properties(buf.get());
      hb_buffer_set_direction(buf.get(), run.rtl ? HB_DIRECTION_RTL : HB_DIRECTION_LTR);
      hb_shape(font.get(), buf.get(), features.empty() ? nullptr : features.data(), static_cast<unsigned>(features.size()));
      unsigned count = 0;
      const hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf.get(), &count);
      const hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf.get(), &count);
      for (unsigned g = 0; g < count; ++g) {
        const auto& gi = info[g];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        const auto& gp = pos[g];   // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        Glyph gl;
        gl.id = static_cast<std::uint16_t>(gi.codepoint);
        gl.face = face;
        gl.cluster = gi.cluster;
        gl.fakeBold = fakeBold;
        gl.fakeItalic = fakeItalic;
        float adv = static_cast<float>(gp.x_advance) / 65536.0F;
        // Letter spacing: once per cluster, on its last glyph in visual order.
        const bool lastOfCluster = g + 1 == count || info[g + 1].cluster != gi.cluster;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        if (lastOfCluster && req.letterSpacing != 0.0) adv += static_cast<float>(req.letterSpacing);
        if (lastOfCluster && req.wordSpacing != 0.0) {
          // Word spacing on U+0020 clusters.
          for (std::size_t i = a; i < b; ++i) {
            if (cps[i].byte == gi.cluster && cps[i].cp == ' ') adv += static_cast<float>(req.wordSpacing);
          }
        }
        gl.x = static_cast<double>(pen + static_cast<float>(gp.x_offset) / 65536.0F);
        gl.y = -static_cast<double>(static_cast<float>(gp.y_offset) / 65536.0F);
        gl.advance = static_cast<double>(adv);
        pen += adv;
        out.glyphs.push_back(gl);
      }
    }
  }
  out.width = static_cast<double>(pen);

  // Ink bounds (TextMetrics.actualBoundingBox*): the union of glyph bounds.
  for (const auto& g : out.glyphs) {
    const SkFont font = ffi::sk_font_for(*this, g.face, out.axes, req.font.sizePx, g.fakeBold, g.fakeItalic);
    const SkGlyphID id = g.id;
    const SkRect r = cached_bounds(font, id);
    if (r.isEmpty()) continue;
    const double l = g.x + r.fLeft;
    const double t = g.y + r.fTop;
    const double rr = g.x + r.fRight;
    const double bb = g.y + r.fBottom;
    if (!out.hasInk) {
      out.inkLeft = l; out.inkTop = t; out.inkRight = rr; out.inkBottom = bb;
      out.hasInk = true;
    } else {
      out.inkLeft = std::min(out.inkLeft, l);
      out.inkTop = std::min(out.inkTop, t);
      out.inkRight = std::max(out.inkRight, rr);
      out.inkBottom = std::max(out.inkBottom, bb);
    }
  }
  return out;
}

std::optional<GlyphOutlineUnits> FontSet::glyph_outline(std::string_view cluster, const css::Font& font) const {
  const std::vector<CodePoint> cps = decode_utf8(cluster);
  if (cps.size() != 1) return std::nullopt;
  ShapeRequest req;
  req.font = font;
  req.kerning = false;
  const ShapedText shaped = shape(cluster, req);
  if (shaped.glyphs.empty()) return std::nullopt;
  const int face = shaped.glyphs.front().face;
  if (face < 0) return std::nullopt;
  const auto& f = *impl_->faces.at(static_cast<std::size_t>(face));
  // openType.ts glyphFor: the cmap glyph.
  hb_codepoint_t gid = 0;
  {
    const HbFont hb(hb_font_create(f.face.get()));
    if (hb_font_get_nominal_glyph(hb.get(), cps.front().cp, &gid) == 0) return std::nullopt;
  }
  GlyphOutlineUnits out;
  out.unitsPerEm = f.upem;
  {
    const HbFont hb(hb_font_create(f.face.get()));  // default scale = upem: advances in font units
    out.advance = static_cast<double>(hb_font_get_glyph_h_advance(hb.get(), gid));
  }
  // The outline at size = upem (so 1 px = 1 font unit), unhinted.
  SkFont sk = ffi::sk_font_for(*this, face, shaped.axes, static_cast<double>(f.upem), false, false);
  sk.setHinting(static_cast<SkFontHinting>(0));  // kNone
  sk.setSubpixel(true);
  const std::optional<SkPath> path = sk.getPath(static_cast<SkGlyphID>(gid));
  if (!path) return std::nullopt;
  const auto P = [](SkPoint p) { return std::make_pair(static_cast<double>(p.fX), -static_cast<double>(p.fY)); };
  std::vector<OutlineCubic>* cur = nullptr;
  SkPath::Iter it(*path, true);
  while (const auto rec = it.next()) {
    const auto& pts = rec->fPoints;
    switch (rec->fVerb) {
      case SkPathVerb::kMove:
        out.contours.emplace_back();
        cur = &out.contours.back();
        break;
      case SkPathVerb::kLine: {
        if (cur == nullptr) break;
        const auto [x0, y0] = P(pts[0]);
        const auto [x1, y1] = P(pts[1]);
        cur->push_back({x0, y0, x0, y0, x1, y1, x1, y1});
        break;
      }
      case SkPathVerb::kQuad:
      case SkPathVerb::kConic: {  // a conic here is a quadratic; its weight is ignored
        if (cur == nullptr) break;
        const auto [x0, y0] = P(pts[0]);
        const auto [qx, qy] = P(pts[1]);
        const auto [x1, y1] = P(pts[2]);
        cur->push_back({x0, y0, x0 + (2.0 / 3.0) * (qx - x0), y0 + (2.0 / 3.0) * (qy - y0), x1 + (2.0 / 3.0) * (qx - x1),
                        y1 + (2.0 / 3.0) * (qy - y1), x1, y1});
        break;
      }
      case SkPathVerb::kCubic: {
        if (cur == nullptr) break;
        const auto [x0, y0] = P(pts[0]);
        const auto [ax, ay] = P(pts[1]);
        const auto [bx, by] = P(pts[2]);
        const auto [x1, y1] = P(pts[3]);
        cur->push_back({x0, y0, ax, ay, bx, by, x1, y1});
        break;
      }
      case SkPathVerb::kClose: break;
    }
  }
  std::erase_if(out.contours, [](const auto& c) { return c.empty(); });
  if (out.contours.empty()) return std::nullopt;
  return out;
}

}  // namespace premation::raster
