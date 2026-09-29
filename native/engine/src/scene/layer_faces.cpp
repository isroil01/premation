#include "layer_faces.hpp"

#include <algorithm>
#include <array>
#include <string>

#include "extrusion_faces.hpp"
#include "extrusion_mesh.hpp"
#include "transform.hpp"

namespace premation::scene {

namespace {

namespace xf = motion::xf;

api::Vec3 to_api(const xf::Vec3& p) { return api::Vec3{p.x, p.y, p.z}; }

const char* role_name(mesh::MeshRole r) {
  switch (r) {
    case mesh::MeshRole::front: return "front";
    case mesh::MeshRole::back: return "back";
    case mesh::MeshRole::side: return "side";
    case mesh::MeshRole::bevel: return "bevel";
  }
  return "side";
}

/// A centred w×h plane through `m`: its four corners (TL, TR, BR, BL).
std::vector<api::Vec3> plane(const xf::Mat4& m, double w, double h) {
  const double hw = w / 2;
  const double hh = h / 2;
  return {to_api(xf::transform_point(m, {-hw, -hh, 0})), to_api(xf::transform_point(m, {hw, -hh, 0})),
          to_api(xf::transform_point(m, {hw, hh, 0})), to_api(xf::transform_point(m, {-hw, hh, 0}))};
}

double num(const Json& v, double fb) { return v.is_number() ? v.num() : fb; }

}  // namespace

api::LayerFaces layer_faces_of(const Snapshot& snap, const doc::Node& node, std::string_view layer,
                               const raster::CanvasOptions* canvas) {
  api::LayerFaces out;
  const auto it = std::ranges::find_if(snap.layers, [&](const RLayer& l) { return l.id == layer; });
  if (it == snap.layers.end() || !it->world3d) return out;
  const RLayer& rl = *it;
  // readNode3D: the Transform's STATIC extrusion (facePicking reads the node, not its tracks).
  const doc::Component* tc = node.comp("Transform");
  const Json tp = tc != nullptr ? tc->props : Json();
  const double depth = std::max(0.0, num(tp.at("extrusionDepth"), 0));
  const double bevel = std::max(0.0, num(tp.at("bevelDepth"), 0));
  const std::string style = tp.at("bevelStyle").is_string() ? tp.at("bevelStyle").str() : "angular";
  const double w = rl.width;
  const double h = rl.height;
  if (!(depth > 0) || !(w > 0) || !(h > 0)) return out;
  xf::Mat4 world{};
  std::copy(rl.world3d->begin(), rl.world3d->end(), world.begin());
  const bool ellipse = rl.kind == LayerKind::shape && rl.primitive == "ellipse";

  // The renderer's mesh (same outline, depth and bevel as the drawn one; the front cap always).
  if (const auto outline = extrusion_outline_for(rl, w, h, canvas)) {
    ExtrusionMeshRequest req;
    req.depth = depth;
    req.bevel = bevel;
    req.bevelStyle = bevel_profile_of(style);
    req.frontCap = true;
    if (const auto built = extrusion_mesh_for(*outline, w, h, req)) {
      const mesh::ExtrudedMesh& m = *built->mesh;
      std::vector<api::Vec3> verts;
      verts.reserve(m.vertexCount);
      for (std::uint32_t i = 0; i < m.vertexCount; ++i) {
        const std::size_t o = i * mesh::kMeshVertexFloats;
        verts.push_back(to_api(xf::transform_point(world, {m.vertices[o], m.vertices[o + 1], m.vertices[o + 2]})));
      }
      for (const mesh::MeshRange& r : m.ranges) {
        const char* role = role_name(r.role);
        for (std::uint32_t i = r.first; i + 3 <= r.first + r.count && i + 2 < m.indices.size(); i += 3) {
          api::LayerFace f;
          f.kind = role;
          f.suffix = role;
          f.verts = {m.indices[i], m.indices[i + 1], m.indices[i + 2]};
          for (const std::uint32_t v : f.verts) f.points.push_back(verts[v]);
          out.faces.push_back(std::move(f));
        }
      }
      if (!out.faces.empty()) return out;
    }
  }

  // The flat quads of extrusion.ts — the renderer's fallback — and the inset front cap.
  extrude::Options eo;
  eo.bevel = bevel;
  const extrude::Geometry geom = extrude::extrusion_geometry(w, h, depth, ellipse, extrude::kEllipseWallSegments, eo);
  for (const extrude::Face& f : geom.faces) {
    api::LayerFace lf;
    lf.kind = std::string(extrude::face_kind_of(f));
    lf.suffix = f.suffix;
    lf.points = plane(xf::multiply(world, f.m), f.w, f.h);
    out.faces.push_back(std::move(lf));
  }
  const double inset = ellipse ? 0 : extrude::clamp_bevel(w, h, depth, bevel);
  api::LayerFace front;
  front.kind = "front";
  front.suffix = "front";
  front.points = plane(world, w - 2 * inset, h - 2 * inset);
  out.faces.push_back(std::move(front));
  return out;
}

}  // namespace premation::scene
