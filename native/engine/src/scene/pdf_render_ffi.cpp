// PDFium FFI (CLAUDE.md: FFI only in *_ffi.cpp). See pdf_render.hpp.
//
// PDFium is not thread-safe: every call runs under one process-wide mutex
// (the SVG worker and the import probe may ask at once). Files are read here
// and handed over as memory — PDFium opens paths with the narrow C runtime,
// which on Windows is the ANSI code page and fails on a Japanese folder name.
#include "pdf_render.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <vector>

#if defined(PREMATION_HAVE_PDFIUM)
#include <fpdfview.h>
#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
#endif

namespace premation::scene {

namespace {

std::string lower(std::string_view s) {
  std::string out(s);
  for (char& c : out) c = c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
  return out;
}

}  // namespace

bool is_pdf_path(std::string_view src) {
  if (src.starts_with("data:")) return false;
  const std::size_t q = src.find_first_of("?#");
  const std::string p = lower(q == std::string_view::npos ? src : src.substr(0, q));
  return p.ends_with(".pdf") || p.ends_with(".ai");
}

#if defined(PREMATION_HAVE_PDFIUM)

namespace {

std::mutex& pdfium_mutex() {
  static std::mutex m;
  return m;
}

/// FPDF_InitLibrary once; called with the mutex held. False when PDFium is not
/// beside the engine (Windows delay-loads it: calling in without the DLL would
/// end the process, so the load is tried first).
bool ensure_library(std::string& error) {
  static bool initialized = false;
  if (initialized) return true;
#if defined(_WIN32)
  if (LoadLibraryExW(L"pdfium.dll", nullptr, LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) == nullptr) {
    error = "pdfium.dll is missing beside the engine — reinstall Premation";
    return false;
  }
#endif
  FPDF_LIBRARY_CONFIG config{};
  config.version = 2;
  FPDF_InitLibraryWithConfig(&config);
  initialized = true;
  return true;
}

std::string last_error_text() {
  switch (FPDF_GetLastError()) {
    case FPDF_ERR_FILE: return "the file could not be read";
    case FPDF_ERR_FORMAT: return "the file is not a PDF (an Illustrator file saved without PDF compatibility cannot be read)";
    case FPDF_ERR_PASSWORD: return "the document is password-protected";
    case FPDF_ERR_SECURITY: return "the document's security handler is not supported";
    case FPDF_ERR_PAGE: return "the page could not be read";
    default: return "the document could not be opened";
  }
}

/// The document open over its bytes (which must outlive it), closed on scope exit.
struct Doc {
  std::vector<std::uint8_t> bytes;
  FPDF_DOCUMENT doc = nullptr;
  Doc() = default;
  Doc(const Doc&) = delete;
  Doc& operator=(const Doc&) = delete;
  Doc(Doc&&) = delete;
  Doc& operator=(Doc&&) = delete;
  ~Doc() {
    if (doc != nullptr) FPDF_CloseDocument(doc);
  }
  bool open(const std::string& path, std::string& error) {
    std::ifstream in(std::filesystem::path(std::u8string(path.begin(), path.end())), std::ios::binary);
    if (!in) {
      error = "the file did not open: " + path;
      return false;
    }
    bytes.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    doc = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
    if (doc == nullptr) {
      error = last_error_text();
      return false;
    }
    return true;
  }
};

struct Page {
  FPDF_PAGE page = nullptr;
  explicit Page(FPDF_DOCUMENT d) : page(FPDF_LoadPage(d, 0)) {}
  Page(const Page&) = delete;
  Page& operator=(const Page&) = delete;
  Page(Page&&) = delete;
  Page& operator=(Page&&) = delete;
  ~Page() {
    if (page != nullptr) FPDF_ClosePage(page);
  }
};

}  // namespace

PdfFacts pdf_file_facts(const std::string& path) {
  PdfFacts f;
  const std::scoped_lock lock(pdfium_mutex());
  if (!ensure_library(f.error)) return f;
  Doc d;
  if (!d.open(path, f.error)) return f;
  f.pages = FPDF_GetPageCount(d.doc);
  if (f.pages <= 0) {
    f.error = "the document has no pages";
    return f;
  }
  const Page p(d.doc);
  if (p.page == nullptr) {
    f.error = last_error_text();
    return f;
  }
  f.width = FPDF_GetPageWidthF(p.page);
  f.height = FPDF_GetPageHeightF(p.page);
  f.ok = f.width > 0 && f.height > 0;
  if (!f.ok) f.error = "the first page has no size";
  return f;
}

raster::RasterOutput rasterize_pdf_file(const std::string& path, double targetLongEdge) {
  raster::RasterOutput out;
  const std::scoped_lock lock(pdfium_mutex());
  if (!ensure_library(out.error)) return out;
  Doc d;
  if (!d.open(path, out.error)) return out;
  const Page p(d.doc);
  if (p.page == nullptr) {
    out.error = last_error_text();
    return out;
  }
  const double pw = FPDF_GetPageWidthF(p.page);
  const double ph = FPDF_GetPageHeightF(p.page);
  if (pw <= 0 || ph <= 0) {
    out.error = "the first page has no size";
    return out;
  }
  // Points are pixels (AE); a display step scales the long side to it. 16384 is the texture ceiling.
  const double scale = targetLongEdge > 0 ? targetLongEdge / (std::max)(pw, ph) : 1.0;  // (max): fpdfview.h brings windows.h
  const int w = std::clamp(static_cast<int>(std::lround(pw * scale)), 1, 16384);
  const int h = std::clamp(static_cast<int>(std::lround(ph * scale)), 1, 16384);
  FPDF_BITMAP bmp = FPDFBitmap_Create(w, h, 1);
  if (bmp == nullptr) {
    out.error = "out of memory drawing the page";
    return out;
  }
  FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0x00000000);  // transparent: AE keeps a PDF's unpainted area clear
  FPDF_RenderPageBitmap(bmp, p.page, 0, 0, w, h, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
  const auto* src = static_cast<const std::uint8_t*>(FPDFBitmap_GetBuffer(bmp));
  const int stride = FPDFBitmap_GetStride(bmp);
  out.width = static_cast<std::uint32_t>(w);
  out.height = static_cast<std::uint32_t>(h);
  out.rgba.resize(static_cast<std::size_t>(w) * static_cast<std::size_t>(h) * 4);
  for (int y = 0; y < h; ++y) {
    const std::uint8_t* row = src + static_cast<std::ptrdiff_t>(y) * stride;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::uint8_t* dst = out.rgba.data() + static_cast<std::size_t>(y) * static_cast<std::size_t>(w) * 4;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    for (int x = 0; x < w; ++x) {
      // PDFium's ARGB bitmap is straight alpha (RGBA order with REVERSE_BYTE_ORDER); the raster cache holds premultiplied.
      const std::uint32_t a = row[x * 4 + 3];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      for (int c = 0; c < 3; ++c) dst[x * 4 + c] = static_cast<std::uint8_t>((row[x * 4 + c] * a + 127) / 255);  // NOLINT
      dst[x * 4 + 3] = static_cast<std::uint8_t>(a);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
  }
  FPDFBitmap_Destroy(bmp);
  out.ok = true;
  return out;
}

#else

PdfFacts pdf_file_facts(const std::string& /*path*/) {
  PdfFacts f;
  f.error = "PDF footage needs PDFium, which this build does not include";
  return f;
}

raster::RasterOutput rasterize_pdf_file(const std::string& /*path*/, double /*targetLongEdge*/) {
  raster::RasterOutput out;
  out.error = "PDF footage needs PDFium, which this build does not include";
  return out;
}

#endif

}  // namespace premation::scene
