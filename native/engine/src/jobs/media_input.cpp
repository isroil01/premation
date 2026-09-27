#include "media_input.hpp"

namespace premation::jobs {

LumaImage luma_from_rgba(const RgbaImage& img) {
  LumaImage out;
  out.width = img.width;
  out.height = img.height;
  const std::size_t n = static_cast<std::size_t>(img.width) * img.height;
  out.data.resize(n);
  for (std::size_t i = 0, p = 0; i < n; ++i, p += 4) {
    const double y = (0.299 * img.rgba[p] + 0.587 * img.rgba[p + 1] + 0.114 * img.rgba[p + 2]) / 255;
    out.data[i] = static_cast<float>(y);
  }
  return out;
}

std::vector<float> mono_of(const AudioPcm& pcm) {
  // audioDriver.ts mixToMono: sum in float32 storage, divide in double, stored as float32.
  const std::size_t n = pcm.frames();
  std::vector<float> mono(n, 0.0F);
  if (pcm.channels.empty()) return mono;
  for (const auto& ch : pcm.channels) {
    for (std::size_t i = 0; i < n && i < ch.size(); ++i) {
      mono[i] = static_cast<float>(static_cast<double>(mono[i]) + static_cast<double>(ch[i]));
    }
  }
  if (pcm.channels.size() > 1) {
    const auto k = static_cast<double>(pcm.channels.size());
    for (float& v : mono) v = static_cast<float>(static_cast<double>(v) / k);
  }
  return mono;
}

}  // namespace premation::jobs
