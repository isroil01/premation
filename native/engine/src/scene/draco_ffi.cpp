// KHR_draco_mesh_compression through the vcpkg Draco decoder (model_convert.hpp,
// AE parity 4.7). Built only when CMake finds Draco (PREMATION_HAVE_DRACO).
#include "model_convert.hpp"

#include <draco/compression/decode.h>
#include <draco/mesh/mesh.h>

namespace premation::scene::modelio {

bool draco_available() noexcept { return true; }

bool decode_draco(std::span<const std::uint8_t> bytes, DracoMesh& out, std::string& error) {
  draco::DecoderBuffer buffer;
  buffer.Init(reinterpret_cast<const char*>(bytes.data()), bytes.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  draco::Decoder decoder;
  auto status = decoder.DecodeMeshFromBuffer(&buffer);
  if (!status.ok()) {
    error = status.status().error_msg_string();
    return false;
  }
  const std::unique_ptr<draco::Mesh> mesh = std::move(status).value();
  out.vertexCount = mesh->num_points();
  out.indices.reserve(static_cast<std::size_t>(mesh->num_faces()) * 3);
  for (draco::FaceIndex f(0); f < mesh->num_faces(); ++f) {
    const auto& face = mesh->face(f);
    for (int k = 0; k < 3; ++k) out.indices.push_back(face[k].value());
  }
  for (int a = 0; a < mesh->num_attributes(); ++a) {
    const draco::PointAttribute* att = mesh->attribute(a);
    if (att == nullptr) continue;
    DracoMesh::Attribute o;
    o.uniqueId = att->unique_id();
    o.components = att->num_components();
    o.values.resize(static_cast<std::size_t>(out.vertexCount) * static_cast<std::size_t>(o.components));
    std::vector<float> tmp(static_cast<std::size_t>(o.components));
    for (draco::PointIndex p(0); p < mesh->num_points(); ++p) {
      if (!att->ConvertValue<float>(att->mapped_index(p), static_cast<std::int8_t>(o.components), tmp.data())) {
        error = "an attribute does not convert to float";
        return false;
      }
      std::copy(tmp.begin(), tmp.end(), o.values.begin() + static_cast<std::ptrdiff_t>(p.value() * static_cast<std::uint32_t>(o.components)));
    }
    out.attributes.push_back(std::move(o));
  }
  return true;
}

}  // namespace premation::scene::modelio
