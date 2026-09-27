// The font catalogue on macOS: CoreText (font_catalog.hpp). The only file that
// talks to CoreText for listing (rendering registers faces through Skia's
// CoreText font manager in fonts_ffi.cpp). Plain C++ over the CoreText /
// CoreFoundation C APIs.
//
// Every face of CTFontCollectionCreateFromAvailableFonts: family, style and
// PostScript names, the file URL, the weight trait (CoreText's −1…1 scale,
// mapped to CSS weights at AppKit's NSFontWeight anchors, as Blink does), the
// italic symbolic trait, variation axes, and script coverage by one sample
// code point each (the character-set attribute). Faces whose family starts
// with '.' are the system UI fonts: resolvable (system-ui), never listed.
#include "font_catalog.hpp"

#include <CoreFoundation/CoreFoundation.h>
#include <CoreText/CoreText.h>

#include <array>
#include <cmath>
#include <memory>
#include <type_traits>
#include <utility>

namespace premation::raster::detail {
namespace {

struct CfReleaser {
  void operator()(CFTypeRef ref) const noexcept {
    if (ref != nullptr) CFRelease(ref);
  }
};
template <class T>
using Cf = std::unique_ptr<std::remove_pointer_t<T>, CfReleaser>;

std::string utf8(CFStringRef s) {
  if (s == nullptr) return {};
  if (const char* fast = CFStringGetCStringPtr(s, kCFStringEncodingUTF8)) return fast;
  const CFIndex len = CFStringGetLength(s);
  const CFIndex max = CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1;
  std::string out(static_cast<std::size_t>(max), '\0');
  if (!CFStringGetCString(s, out.data(), max, kCFStringEncodingUTF8)) return {};
  out.resize(std::char_traits<char>::length(out.c_str()));
  return out;
}

/// A descriptor attribute of type T (CFGetTypeID-checked), owned; null when absent.
template <class T>
Cf<T> attr(CTFontDescriptorRef d, CFStringRef key, CFTypeID type) {
  CFTypeRef v = CTFontDescriptorCopyAttribute(d, key);
  if (v == nullptr) return nullptr;
  if (CFGetTypeID(v) != type) {
    CFRelease(v);
    return nullptr;
  }
  return Cf<T>(static_cast<T>(v));
}

double number(CFDictionaryRef dict, CFStringRef key, double fallback) {
  const void* v = CFDictionaryGetValue(dict, key);
  if (v == nullptr || CFGetTypeID(v) != CFNumberGetTypeID()) return fallback;
  double out = fallback;
  if (!CFNumberGetValue(static_cast<CFNumberRef>(v), kCFNumberDoubleType, &out)) return fallback;
  return out;
}

/// CoreText weight trait (−1…1) → CSS weight, piecewise linear through the
/// NSFontWeight constants (ultraLight −0.8 = 100 … black 0.62 = 900).
double css_weight(double ct) {
  static constexpr std::array<std::pair<double, double>, 9> kAnchors{{
      {-0.80, 100}, {-0.60, 200}, {-0.40, 300}, {0.00, 400}, {0.23, 500},
      {0.30, 600}, {0.40, 700}, {0.56, 800}, {0.62, 900},
  }};
  if (ct <= kAnchors.front().first) return kAnchors.front().second;
  if (ct >= kAnchors.back().first) return kAnchors.back().second;
  for (std::size_t i = 1; i < kAnchors.size(); ++i) {
    const auto [x1, y1] = kAnchors[i];
    const auto [x0, y0] = kAnchors[i - 1];
    if (ct <= x1) return std::round(y0 + (ct - x0) / (x1 - x0) * (y1 - y0));
  }
  return 400.0;
}

std::vector<CatalogAxis> axes_of(CTFontDescriptorRef d) {
  std::vector<CatalogAxis> out;
  // The descriptor attribute exists from macOS 13; before that a CTFont would
  // have to be instantiated per face, which listing thousands cannot afford.
  if (__builtin_available(macOS 13.0, *)) {
    const Cf<CFArrayRef> axes = attr<CFArrayRef>(d, kCTFontVariationAxesAttribute, CFArrayGetTypeID());
    if (!axes) return out;
    const CFIndex n = CFArrayGetCount(axes.get());
    for (CFIndex i = 0; i < n; ++i) {
      const void* a = CFArrayGetValueAtIndex(axes.get(), i);
      if (a == nullptr || CFGetTypeID(a) != CFDictionaryGetTypeID()) continue;
      const auto* dict = static_cast<CFDictionaryRef>(a);
      CatalogAxis axis;
      axis.tag = tag_string(static_cast<std::uint32_t>(number(dict, kCTFontVariationAxisIdentifierKey, 0)));
      axis.min = number(dict, kCTFontVariationAxisMinimumValueKey, 0);
      axis.max = number(dict, kCTFontVariationAxisMaximumValueKey, 0);
      axis.defaultValue = number(dict, kCTFontVariationAxisDefaultValueKey, 0);
      const void* name = CFDictionaryGetValue(dict, kCTFontVariationAxisNameKey);
      if (name != nullptr && CFGetTypeID(name) == CFStringGetTypeID()) axis.name = utf8(static_cast<CFStringRef>(name));
      out.push_back(std::move(axis));
    }
  }
  return out;
}

std::vector<std::string> scripts_of(CTFontDescriptorRef d) {
  std::vector<std::string> out;
  const Cf<CFCharacterSetRef> set = attr<CFCharacterSetRef>(d, kCTFontCharacterSetAttribute, CFCharacterSetGetTypeID());
  if (!set) return out;
  for (const ScriptSample& s : kScriptSamples) {
    if (CFCharacterSetIsLongCharacterMember(set.get(), static_cast<UTF32Char>(s.codePoint))) out.emplace_back(s.script);
  }
  return out;
}

std::string file_path(CTFontDescriptorRef d) {
  const Cf<CFURLRef> url = attr<CFURLRef>(d, kCTFontURLAttribute, CFURLGetTypeID());
  if (!url) return {};
  std::array<char, 4096> buf{};
  if (!CFURLGetFileSystemRepresentation(url.get(), true, reinterpret_cast<UInt8*>(buf.data()),
                                        static_cast<CFIndex>(buf.size()))) {
    return {};
  }
  return std::string(buf.data());
}

CatalogFace face_of(CTFontDescriptorRef d) {
  CatalogFace face;
  if (const Cf<CFStringRef> v = attr<CFStringRef>(d, kCTFontFamilyNameAttribute, CFStringGetTypeID())) {
    face.family = utf8(v.get());
  }
  if (face.family.empty()) return face;
  face.hidden = face.family.front() == '.';
  if (const Cf<CFStringRef> v = attr<CFStringRef>(d, kCTFontStyleNameAttribute, CFStringGetTypeID())) {
    face.style = utf8(v.get());
  }
  if (const Cf<CFStringRef> v = attr<CFStringRef>(d, kCTFontNameAttribute, CFStringGetTypeID())) {
    face.postScriptName = utf8(v.get());
  }
  if (const Cf<CFDictionaryRef> traits = attr<CFDictionaryRef>(d, kCTFontTraitsAttribute, CFDictionaryGetTypeID())) {
    face.weight = css_weight(number(traits.get(), kCTFontWeightTrait, 0.0));
    const auto symbolic = static_cast<std::uint32_t>(number(traits.get(), kCTFontSymbolicTrait, 0.0));
    face.italic = (symbolic & kCTFontTraitItalic) != 0U;
    // Width trait −1…1 (0 normal) → CSS percent: 50 % at −1, 200 % at +1.
    const double w = number(traits.get(), kCTFontWidthTrait, 0.0);
    face.stretch = w < 0 ? 100.0 + w * 50.0 : 100.0 + w * 100.0;
  }
  face.path = file_path(d);
  face.axes = axes_of(d);
  face.scripts = scripts_of(d);
  return face;
}

}  // namespace

std::vector<CatalogFace> enumerate_system_fonts() {
  std::vector<CatalogFace> out;
  const Cf<CTFontCollectionRef> collection(CTFontCollectionCreateFromAvailableFonts(nullptr));
  if (!collection) return out;
  const Cf<CFArrayRef> descriptors(CTFontCollectionCreateMatchingFontDescriptors(collection.get()));
  if (!descriptors) return out;
  const CFIndex n = CFArrayGetCount(descriptors.get());
  out.reserve(static_cast<std::size_t>(n));
  for (CFIndex i = 0; i < n; ++i) {
    const auto* d = static_cast<CTFontDescriptorRef>(CFArrayGetValueAtIndex(descriptors.get(), i));
    if (d == nullptr) continue;
    CatalogFace face = face_of(d);
    if (face.family.empty()) continue;
    out.push_back(std::move(face));
  }
  return out;
}

}  // namespace premation::raster::detail

namespace premation::raster::detail {

std::vector<CatalogFace> unlisted_family_faces(std::string_view family) {
  std::vector<CatalogFace> out;
  const Cf<CFStringRef> name(CFStringCreateWithBytes(kCFAllocatorDefault, reinterpret_cast<const UInt8*>(family.data()),
                                                     static_cast<CFIndex>(family.size()), kCFStringEncodingUTF8, false));
  if (!name) return out;
  const void* keys[] = {kCTFontFamilyNameAttribute};
  const void* values[] = {name.get()};
  const Cf<CFDictionaryRef> attrs(CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                                                     &kCFTypeDictionaryValueCallBacks));
  if (!attrs) return out;
  const Cf<CTFontDescriptorRef> query(CTFontDescriptorCreateWithAttributes(attrs.get()));
  if (!query) return out;
  // The family name is mandatory: without it CoreText answers with its fallback.
  const Cf<CFSetRef> mandatory(CFSetCreate(kCFAllocatorDefault, keys, 1, &kCFTypeSetCallBacks));
  const Cf<CFArrayRef> matches(CTFontDescriptorCreateMatchingFontDescriptors(query.get(), mandatory.get()));
  if (!matches) return out;
  const CFIndex n = CFArrayGetCount(matches.get());
  for (CFIndex i = 0; i < n; ++i) {
    const auto* d = static_cast<CTFontDescriptorRef>(CFArrayGetValueAtIndex(matches.get(), i));
    if (d == nullptr) continue;
    CatalogFace face = face_of(d);
    if (face.family.empty()) continue;
    face.hidden = true;
    out.push_back(std::move(face));
  }
  return out;
}

}  // namespace premation::raster::detail
