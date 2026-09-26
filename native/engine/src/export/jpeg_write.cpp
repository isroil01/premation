#include "jpeg_write.hpp"

#include <algorithm>

#ifdef _WIN32
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#endif

namespace premation::exporter {
namespace {

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
  (void)quality;
  return false;
#endif
}

}  // namespace premation::exporter
