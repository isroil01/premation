// The font catalogue on Windows: DirectWrite (font_catalog.hpp). The only file
// that talks to DirectWrite for listing (rendering registers faces through
// Skia's DirectWrite font manager in fonts_ffi.cpp).
//
// Every non-simulated font of the system collection: the family name (en-us,
// else the first), the face name, the PostScript name (informational string),
// the file path + collection index through the local font file loader, the
// DWRITE weight / stretch / style (already CSS values), variation axes
// (IDWriteFontFace5 → IDWriteFontResource, Windows 10 1809+; absent before),
// and script coverage by one sample code point each (HasCharacter).
#include "font_catalog.hpp"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <dwrite_3.h>
#include <windows.h>
#include <wrl/client.h>

#include <array>
#include <string>
#include <utility>
#include <vector>

// COM's IID_PPV_ARGS / __uuidof is a Microsoft extension. Confined to this FFI file.
#if defined(__clang__)
#pragma clang diagnostic ignored "-Wlanguage-extension-token"
#endif

namespace premation::raster::detail {
namespace {

using Microsoft::WRL::ComPtr;

std::string narrow(const wchar_t* w, int len = -1) {
  if (w == nullptr) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, len, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string out(static_cast<std::size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, len, out.data(), n, nullptr, nullptr);
  if (len == -1 && !out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

/// en-us if present, else the first locale's string.
std::string pick(IDWriteLocalizedStrings* strings) {
  if (strings == nullptr || strings->GetCount() == 0) return {};
  UINT32 index = 0;
  BOOL exists = FALSE;
  if (FAILED(strings->FindLocaleName(L"en-us", &index, &exists)) || exists == FALSE) index = 0;
  UINT32 length = 0;
  if (FAILED(strings->GetStringLength(index, &length))) return {};
  std::wstring w(static_cast<std::size_t>(length) + 1, L'\0');
  if (FAILED(strings->GetString(index, w.data(), length + 1))) return {};
  return narrow(w.c_str());
}

double css_stretch(DWRITE_FONT_STRETCH s) {
  static constexpr std::array<double, 10> kPercent{100, 50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200};
  const auto i = static_cast<std::size_t>(s);
  return i < kPercent.size() ? kPercent[i] : 100.0;
}

/// The font's file and collection index (local files only).
void file_of(IDWriteFontFace* face, CatalogFace& out) {
  UINT32 count = 0;
  if (FAILED(face->GetFiles(&count, nullptr)) || count == 0) return;
  std::vector<ComPtr<IDWriteFontFile>> files(count);
  std::vector<IDWriteFontFile*> raw(count, nullptr);
  if (FAILED(face->GetFiles(&count, raw.data()))) return;
  for (UINT32 i = 0; i < count; ++i) files[i].Attach(raw[i]);  // take the references GetFiles added
  out.ttcIndex = static_cast<int>(face->GetIndex());
  ComPtr<IDWriteFontFileLoader> loader;
  if (FAILED(files[0]->GetLoader(&loader))) return;
  ComPtr<IDWriteLocalFontFileLoader> local;
  if (FAILED(loader.As(&local))) return;  // a memory / remote font: no path
  const void* key = nullptr;
  UINT32 keySize = 0;
  if (FAILED(files[0]->GetReferenceKey(&key, &keySize))) return;
  UINT32 pathLength = 0;
  if (FAILED(local->GetFilePathLengthFromKey(key, keySize, &pathLength))) return;
  std::wstring path(static_cast<std::size_t>(pathLength) + 1, L'\0');
  if (FAILED(local->GetFilePathFromKey(key, keySize, path.data(), pathLength + 1))) return;
  out.path = narrow(path.c_str());
}

void axes_of(IDWriteFontFace* face, CatalogFace& out) {
  ComPtr<IDWriteFontFace5> face5;
  if (FAILED(face->QueryInterface(IID_PPV_ARGS(&face5))) || face5->HasVariations() == FALSE) return;
  ComPtr<IDWriteFontResource> resource;
  if (FAILED(face5->GetFontResource(&resource))) return;
  const UINT32 n = resource->GetFontAxisCount();
  if (n == 0) return;
  std::vector<DWRITE_FONT_AXIS_VALUE> defaults(n);
  std::vector<DWRITE_FONT_AXIS_RANGE> ranges(n);
  if (FAILED(resource->GetDefaultFontAxisValues(defaults.data(), n)) ||
      FAILED(resource->GetFontAxisRanges(ranges.data(), n))) {
    return;
  }
  for (UINT32 i = 0; i < n; ++i) {
    CatalogAxis axis;
    // DWRITE_MAKE_FONT_AXIS_TAG packs the first letter in the LOW byte.
    const auto t = static_cast<std::uint32_t>(ranges[i].axisTag);
    axis.tag = tag_string(((t & 0xFFU) << 24U) | ((t & 0xFF00U) << 8U) | ((t >> 8U) & 0xFF00U) | (t >> 24U));
    axis.min = ranges[i].minValue;
    axis.max = ranges[i].maxValue;
    axis.defaultValue = defaults[i].value;
    ComPtr<IDWriteLocalizedStrings> names;
    if (SUCCEEDED(resource->GetAxisNames(i, &names))) axis.name = pick(names.Get());
    out.axes.push_back(std::move(axis));
  }
}

}  // namespace

std::vector<CatalogFace> enumerate_system_fonts() {
  std::vector<CatalogFace> out;
  ComPtr<IDWriteFactory> factory;
  if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                                 reinterpret_cast<IUnknown**>(factory.GetAddressOf())))) {
    return out;
  }
  ComPtr<IDWriteFontCollection> collection;
  if (FAILED(factory->GetSystemFontCollection(&collection, FALSE))) return out;
  const UINT32 families = collection->GetFontFamilyCount();
  for (UINT32 fi = 0; fi < families; ++fi) {
    ComPtr<IDWriteFontFamily> family;
    if (FAILED(collection->GetFontFamily(fi, &family))) continue;
    ComPtr<IDWriteLocalizedStrings> familyNames;
    if (FAILED(family->GetFamilyNames(&familyNames))) continue;
    const std::string familyName = pick(familyNames.Get());
    if (familyName.empty()) continue;
    const UINT32 fonts = family->GetFontCount();
    for (UINT32 i = 0; i < fonts; ++i) {
      ComPtr<IDWriteFont> font;
      if (FAILED(family->GetFont(i, &font))) continue;
      if (font->GetSimulations() != DWRITE_FONT_SIMULATIONS_NONE) continue;  // synthesized bold / oblique
      CatalogFace face;
      face.family = familyName;
      face.weight = static_cast<double>(font->GetWeight());
      face.stretch = css_stretch(font->GetStretch());
      face.italic = font->GetStyle() != DWRITE_FONT_STYLE_NORMAL;
      ComPtr<IDWriteLocalizedStrings> faceNames;
      if (SUCCEEDED(font->GetFaceNames(&faceNames))) face.style = pick(faceNames.Get());
      ComPtr<IDWriteLocalizedStrings> ps;
      BOOL hasPs = FALSE;
      if (SUCCEEDED(font->GetInformationalStrings(DWRITE_INFORMATIONAL_STRING_POSTSCRIPT_NAME, &ps, &hasPs)) &&
          hasPs != FALSE) {
        face.postScriptName = pick(ps.Get());
      }
      for (const ScriptSample& s : kScriptSamples) {
        BOOL has = FALSE;
        if (SUCCEEDED(font->HasCharacter(static_cast<UINT32>(s.codePoint), &has)) && has != FALSE) {
          face.scripts.emplace_back(s.script);
        }
      }
      ComPtr<IDWriteFontFace> fontFace;
      if (SUCCEEDED(font->CreateFontFace(&fontFace))) {
        file_of(fontFace.Get(), face);
        axes_of(fontFace.Get(), face);
      }
      out.push_back(std::move(face));
    }
  }
  return out;
}

std::vector<CatalogFace> unlisted_family_faces(std::string_view /*family*/) {
  return {};  // the system collection lists every installed family
}

}  // namespace premation::raster::detail
