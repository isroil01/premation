// glTF meshopt compression through the vendored meshoptimizer decoder
// (third_party/meshoptimizer; model_convert.hpp, AE parity 4.7).
#include "meshoptimizer.h"
#include "model_convert.hpp"

namespace premation::scene::modelio {

bool decode_meshopt(std::span<const std::uint8_t> src, std::size_t count, std::size_t stride, std::string_view mode,
                    std::string_view filter, std::vector<std::uint8_t>& out) {
  if (stride == 0) return false;
  out.assign(count * stride, 0);
  int rc = -1;
  if (mode == "ATTRIBUTES") {
    rc = meshopt_decodeVertexBuffer(out.data(), count, stride, src.data(), src.size());
    if (rc == 0) {
      if (filter == "OCTAHEDRAL") meshopt_decodeFilterOct(out.data(), count, stride);
      else if (filter == "QUATERNION") meshopt_decodeFilterQuat(out.data(), count, stride);
      else if (filter == "EXPONENTIAL") meshopt_decodeFilterExp(out.data(), count, stride);
      else if (filter == "COLOR") meshopt_decodeFilterColor(out.data(), count, stride);
    }
  } else if (mode == "TRIANGLES") {
    rc = meshopt_decodeIndexBuffer(out.data(), count, stride, src.data(), src.size());
  } else if (mode == "INDICES") {
    rc = meshopt_decodeIndexSequence(out.data(), count, stride, src.data(), src.size());
  }
  return rc == 0;
}

}  // namespace premation::scene::modelio
