// The model importer's optional codecs when the build has neither Draco nor
// libktx (model_convert.hpp): each answers "not available" and the importer
// refuses such files with a message naming the fix.
#include "model_convert.hpp"

namespace premation::scene::modelio {

#ifndef PREMATION_HAVE_DRACO
bool draco_available() noexcept { return false; }
bool decode_draco(std::span<const std::uint8_t> /*bytes*/, DracoMesh& /*out*/, std::string& error) {
  error = "this build has no Draco decoder";
  return false;
}
#endif

#ifndef PREMATION_HAVE_KTX
bool ktx_available() noexcept { return false; }
bool decode_ktx2(std::span<const std::uint8_t> /*bytes*/, std::vector<std::uint8_t>& /*rgba*/, std::uint32_t& /*width*/,
                 std::uint32_t& /*height*/, std::string& error) {
  error = "this build has no KTX2 transcoder";
  return false;
}
#endif

}  // namespace premation::scene::modelio
