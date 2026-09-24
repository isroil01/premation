#include "media_config.hpp"

#include "frame_convert.hpp"
#include "platform_ffi.hpp"

namespace premation::media {

MediaConfig media_config_for(const wgpu::Device& device, std::string& note) {
  MediaConfig c;
  if (device == nullptr) {
    note = "software: no render device";
    return c;
  }
  HwContextOptions ho;
  ho.adapterLuid = platform::adapter_luid(device);
  // Zero-copy only when the device can import what the decoder hands over.
  const bool nv12 = device.HasFeature(wgpu::FeatureName::SharedTextureMemoryDXGISharedHandle) &&
                    device.HasFeature(wgpu::FeatureName::DawnMultiPlanarFormats);
  const bool p010 = nv12 && device.HasFeature(wgpu::FeatureName::MultiPlanarFormatP010) &&
                    device.HasFeature(wgpu::FeatureName::Unorm16TextureFormats);
  std::string why;
  for (const DecodePath p : {DecodePath::d3d11va, DecodePath::nvdec}) {
    ho.preferred = p;
    std::string error;
    auto hw = create_hw_context(ho, error);
    if (hw && hw_path(*hw) == p) {
      c.hwContext = std::move(hw);
      c.keepOnGpu = p == DecodePath::d3d11va && nv12;
      c.keepHighBitOnGpu = c.keepOnGpu && p010;
      note = std::string(to_string(p)) + " on " + hw_adapter(*c.hwContext) + (c.keepOnGpu ? " (zero-copy)" : " (download + upload)");
      return c;
    }
    if (hw) {
      // The platform mapped the request to its own device (videotoolbox, vaapi): take it.
      c.hwContext = std::move(hw);
      c.keepOnGpu = false;
      note = std::string(to_string(hw_path(*c.hwContext))) + " on " + hw_adapter(*c.hwContext);
      return c;
    }
    why += std::string(why.empty() ? "" : "; ") + to_string(p) + ": " + error;
  }
  note = "software: " + why;
  return c;
}

}  // namespace premation::media
