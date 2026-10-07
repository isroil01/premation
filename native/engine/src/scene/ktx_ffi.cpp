// KHR_texture_basisu (KTX2 / Basis Universal) through the vcpkg libktx
// (model_convert.hpp, AE parity 4.7). Built only when CMake finds libktx
// (PREMATION_HAVE_KTX). Supercompressed Basis images transcode to RGBA32;
// uncompressed RGBA8 KTX2 images are read as they are.
#include "model_convert.hpp"

#include <ktx.h>

namespace premation::scene::modelio {

bool ktx_available() noexcept { return true; }

bool decode_ktx2(std::span<const std::uint8_t> bytes, std::vector<std::uint8_t>& rgba, std::uint32_t& width, std::uint32_t& height,
                 std::string& error) {
  ktxTexture2* tex = nullptr;
  KTX_error_code rc = ktxTexture2_CreateFromMemory(bytes.data(), bytes.size(), KTX_TEXTURE_CREATE_LOAD_IMAGE_DATA_BIT, &tex);
  if (rc != KTX_SUCCESS || tex == nullptr) {
    error = ktxErrorString(rc);
    return false;
  }
  struct Guard {
    ktxTexture2* t;
    ~Guard() { ktxTexture_Destroy(ktxTexture(t)); }
  } guard{tex};
  if (ktxTexture2_NeedsTranscoding(tex)) {
    rc = ktxTexture2_TranscodeBasis(tex, KTX_TTF_RGBA32, 0);
    if (rc != KTX_SUCCESS) {
      error = ktxErrorString(rc);
      return false;
    }
  } else if (tex->vkFormat != 37 /* VK_FORMAT_R8G8B8A8_UNORM */ && tex->vkFormat != 43 /* VK_FORMAT_R8G8B8A8_SRGB */) {
    error = "only Basis-compressed or RGBA8 KTX2 images are supported";
    return false;
  }
  ktx_size_t offset = 0;
  rc = ktxTexture_GetImageOffset(ktxTexture(tex), 0, 0, 0, &offset);
  if (rc != KTX_SUCCESS) {
    error = ktxErrorString(rc);
    return false;
  }
  width = tex->baseWidth;
  height = tex->baseHeight;
  const std::size_t n = static_cast<std::size_t>(width) * height * 4;
  const ktx_uint8_t* data = ktxTexture_GetData(ktxTexture(tex)) + offset;
  rgba.assign(data, data + n);
  return true;
}

}  // namespace premation::scene::modelio
