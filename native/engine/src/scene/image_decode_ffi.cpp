// OS image codecs for still footage (image_decode.hpp). FFI lives here only.
#include "image_decode.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <limits>
#include <string_view>

#ifdef _WIN32
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#endif

namespace premation::scene {

bool is_still_image_path(const std::filesystem::path& p) {
  std::string ext = p.extension().string();
  std::ranges::transform(ext, ext.begin(), [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; });
  for (const std::string_view e : {".png", ".jpg", ".jpeg", ".jpe", ".webp", ".bmp", ".gif", ".tif", ".tiff"}) {
    if (ext == e) return true;
  }
  return false;
}

#ifdef _WIN32

FileStamp file_stamp(const std::filesystem::path& p) {
  WIN32_FILE_ATTRIBUTE_DATA a{};
  if (GetFileAttributesExW(p.wstring().c_str(), GetFileExInfoStandard, &a) == 0) return {};
  FileStamp s;
  s.size = (static_cast<std::uint64_t>(a.nFileSizeHigh) << 32U) | a.nFileSizeLow;
  s.modified = (static_cast<std::uint64_t>(a.ftLastWriteTime.dwHighDateTime) << 32U) | a.ftLastWriteTime.dwLowDateTime;
  return s;
}

namespace {

using Microsoft::WRL::ComPtr;

/// COM on this thread for the duration of a decode (balanced; a thread that
/// already chose the other apartment keeps it and is left alone).
class ComScope {
 public:
  ComScope() : hr_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComScope() {
    if (SUCCEEDED(hr_)) CoUninitialize();
  }
  ComScope(const ComScope&) = delete;
  ComScope& operator=(const ComScope&) = delete;
  ComScope(ComScope&&) = delete;
  ComScope& operator=(ComScope&&) = delete;
  [[nodiscard]] bool usable() const noexcept { return SUCCEEDED(hr_) || hr_ == RPC_E_CHANGED_MODE; }

 private:
  HRESULT hr_;
};

std::string hr_text(std::string_view what, HRESULT hr) {
  std::array<char, 16> buf{};
  std::snprintf(buf.data(), buf.size(), "%08lx", static_cast<unsigned long>(hr));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  std::string out(what);
  out += " failed (0x";
  out += buf.data();
  out += ')';
  return out;
}

}  // namespace

namespace {
bool decode_frame(IWICBitmapDecoder* decoder, DecodedImage& out, std::string& error);
}  // namespace

bool decode_image_file(const std::filesystem::path& p, DecodedImage& out, std::string& error) {
  const ComScope com;
  if (!com.usable()) {
    error = "COM unavailable";
    return false;
  }
  ComPtr<IWICImagingFactory> factory;
  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_IWICImagingFactory,
                                reinterpret_cast<void**>(factory.GetAddressOf()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): COM out-param
  if (FAILED(hr)) {
    error = hr_text("WIC factory", hr);
    return false;
  }
  ComPtr<IWICBitmapDecoder> decoder;
  hr = factory->CreateDecoderFromFilename(p.wstring().c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand,
                                          &decoder);
  if (FAILED(hr)) {
    error = hr_text("open " + p.string(), hr);
    return false;
  }
  return decode_frame(decoder.Get(), out, error);
}

bool decode_image_bytes(std::span<const std::uint8_t> bytes, DecodedImage& out, std::string& error) {
  const ComScope com;
  if (!com.usable()) {
    error = "COM unavailable";
    return false;
  }
  if (bytes.empty() || bytes.size() > (std::numeric_limits<DWORD>::max)()) {
    error = "image bytes unusable";
    return false;
  }
  ComPtr<IWICImagingFactory> factory;
  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_IWICImagingFactory,
                                reinterpret_cast<void**>(factory.GetAddressOf()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): COM out-param
  if (FAILED(hr)) {
    error = hr_text("WIC factory", hr);
    return false;
  }
  ComPtr<IWICStream> stream;
  hr = factory->CreateStream(&stream);
  if (SUCCEEDED(hr)) {
    // WIC reads the buffer in place (it never writes through this pointer).
    hr = stream->InitializeFromMemory(const_cast<BYTE*>(bytes.data()), static_cast<DWORD>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-const-cast)
  }
  if (FAILED(hr)) {
    error = hr_text("memory stream", hr);
    return false;
  }
  ComPtr<IWICBitmapDecoder> decoder;
  hr = factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder);
  if (FAILED(hr)) {
    error = hr_text("decode", hr);
    return false;
  }
  return decode_frame(decoder.Get(), out, error);
}

namespace {

bool decode_frame(IWICBitmapDecoder* decoder, DecodedImage& out, std::string& error) {
  ComPtr<IWICBitmapFrameDecode> frame;
  HRESULT hr = decoder->GetFrame(0, &frame);
  if (FAILED(hr)) {
    error = hr_text("first frame", hr);
    return false;
  }
  // Straight (non-premultiplied) RGBA8: the file's channels as stored.
  ComPtr<IWICBitmapSource> rgba;
  hr = WICConvertBitmapSource(GUID_WICPixelFormat32bppRGBA, frame.Get(), &rgba);
  if (FAILED(hr)) {
    error = hr_text("convert to RGBA", hr);
    return false;
  }
  UINT w = 0;
  UINT h = 0;
  hr = rgba->GetSize(&w, &h);
  constexpr UINT kMaxSide = 32768;
  if (FAILED(hr) || w == 0 || h == 0 || w > kMaxSide || h > kMaxSide) {
    error = "image size unusable";
    return false;
  }
  const std::size_t stride = static_cast<std::size_t>(w) * 4U;
  const std::size_t size = stride * h;
  if (size > (std::numeric_limits<UINT>::max)()) {  // parenthesised: windows.h's max macro
    error = "image too large";
    return false;
  }
  out.width = w;
  out.height = h;
  out.rgba.assign(size, 0);
  hr = rgba->CopyPixels(nullptr, static_cast<UINT>(stride), static_cast<UINT>(size), out.rgba.data());
  if (FAILED(hr)) {
    error = hr_text("decode pixels", hr);
    out.rgba.clear();
    return false;
  }
  return true;
}

}  // namespace

#else

FileStamp file_stamp(const std::filesystem::path& p) {
  (void)p;
  return {};
}

bool decode_image_file(const std::filesystem::path& p, DecodedImage& out, std::string& error) {
  (void)p;
  (void)out;
  error = "no still-image decoder on this platform yet";
  return false;
}

bool decode_image_bytes(std::span<const std::uint8_t> bytes, DecodedImage& out, std::string& error) {
  (void)bytes;
  (void)out;
  error = "no still-image decoder on this platform yet";
  return false;
}

#endif

}  // namespace premation::scene
