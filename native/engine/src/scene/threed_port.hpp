// The snapshot's 3D block (D2w 3D, docs/NATIVE_CORE_PLAN.md): buildSnapshot.ts's
// camera, 3D layer placement, depth of field, Material Options, lights,
// projected shadows, the depth sort and the frame's camera3d / lights3d — ported
// branch by branch, float64 like the TypeScript.
//
// snapshot_build.cpp's walk owns the document reads (values, time remap, the 2D
// world chain); it hands them over through `Scene3DHost` and calls this at the
// same points the TypeScript's walk runs the corresponding code. Keeping the 3D
// block here keeps the walk's own diff to hook calls.
#pragma once

#include <array>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "camera3d_port.hpp"
#include "lights3d.hpp"
#include "readers.hpp"
#include "scene_types.hpp"
#include "snapshot_build.hpp"
#include "transform.hpp"

namespace premation::scene {

/// What the 3D block reads from the snapshot walk (buildSnapshot's closures).
class Scene3DHost {
 public:
  Scene3DHost() = default;
  Scene3DHost(const Scene3DHost&) = default;
  Scene3DHost(Scene3DHost&&) = default;
  Scene3DHost& operator=(const Scene3DHost&) = default;
  Scene3DHost& operator=(Scene3DHost&&) = default;
  virtual ~Scene3DHost() = default;
  /// `nodeById.get(id)` (the composition's flattened nodes).
  [[nodiscard]] virtual const doc::Node* node3d(std::string_view id) const = 0;
  /// `valuesOf(id)`: the node's animated values at its remapped frame time.
  virtual const Values& values3d(const std::string& id) = 0;
  /// `remapOf(id)(t)`.
  virtual double remap3d(const std::string& id, double t) = 0;
  /// `subRemapOf(id)(t)`.
  virtual double sub_remap3d(const std::string& id, double t) = 0;
  /// `worldTransformOf(id, localOf, parentOf, worldCache)`.
  virtual motion::xf::Local2D world2d(const std::string& id) = 0;
  /// `parentOf(id)`.
  [[nodiscard]] virtual std::optional<std::string> parent3d_of(const std::string& id) const = 0;
  /// `isLiveAt(id)`.
  virtual bool live3d(const std::string& id) = 0;
  /// `srcId(id)`: the node whose animation a walked id samples (a comp-instance
  /// clone samples its source node's tracks).
  [[nodiscard]] virtual std::string anim_id3d(const std::string& id) const { return id; }
};

/// One 3D layer's resolved state (the `is3D` locals of the layer walk).
struct Layer3D {
  bool is3d = false;
  double z3 = 0, rotX = 0, rotY = 0, oriX = 0, oriY = 0, oriZ = 0, anchorZ = 0, extrusionDepth = 0, scaleZ = 1;
  std::optional<motion::xf::Mat4> parent3d;
  double ownX = 0, ownY = 0, ownRot = 0, ownScaleX = 1, ownScaleY = 1;
  double faceRotX = 0, faceRotY = 0;
  /// World x/y the TypeScript keeps using after the projection (`world.x/y`).
  double worldX = 0, worldY = 0;
  std::optional<motion::xf::Mat4> world3d;
  double depth = 0;
  Material mat;
};

class Scene3D {
 public:
  Scene3D(Scene3DHost& host, const BuildContext& c, const SnapshotComp& comp, double t,
          const std::optional<MotionBlurCfg>& motionBlur);

  /// The camera / DOF / light resolution buildSnapshot runs before the layer walk.
  void setup(const std::vector<const doc::Node*>& nodes);

  /// The 3D placement (`affineAt` + the near-plane drop): fills `l`'s matrix /
  /// world3d / x / y / scale / rotation / depth. False = the layer is behind the
  /// camera and is not emitted (the TypeScript's `if (O.clipped) return`).
  /// `px/py/sx/sy/rot` are the walk's placement locals, overwritten with the projection.
  bool place(const doc::Node& n, const Values& a, double baseX, double baseY, double baseRot, double baseScaleX,
             double baseScaleY, const motion::xf::Local2D& world, Layer3D& s, double& px, double& py, double& sx,
             double& sy, double& rot, RLayer& l);

  /// `materialOf(node, a)` — read for every layer (2D ones too: the `Only`
  /// shadow modes and the 2D cast shadow).
  [[nodiscard]] Material material_of(const doc::Node& n, const Values& a) const;

  /// The 3D features of this layer the port does not produce yet (mesh bodies).
  [[nodiscard]] std::vector<std::string> unported_features(const doc::Node& n, const Values& a) const;

  /// Material-driven fields set after the layer literal: per-quad lighting and
  /// shade3d (Accepts Lights).
  void shade(const Layer3D& s, RLayer& l);

  /// The 3D layer's motion-blur matrix at (layer time ti, comp time tc), or null
  /// for a 2D layer. Also answers the camera half of the motion gate.
  [[nodiscard]] std::function<std::array<double, 6>(double, double)> matrix_at(const doc::Node& n, const Values& a,
                                                                               double baseX, double baseY,
                                                                               double baseRot, const Layer3D& s);
  [[nodiscard]] bool camera_animated() const noexcept { return cameraAnimated_; }

  /// The GPU-effect block after the content hash: DOF blur, cast-shadow
  /// bookkeeping, receivers, the shadow switches and `Only` modes.
  void effects(const Layer3D& s, bool isSolid, double px, double py, RLayer& l);

  /// buildSnapshot's final emit branch for a flat 3D quad under DOF: the planar
  /// CoC corners replace the uniform `dof` blur when the quad spans depth.
  void before_emit(const Layer3D& s, RLayer& l);

  /// The end of the layer walk for one node: the extrusion mesh carrier, the
  /// primitive mesh carrier, then the front quad (inset by the bevel, drawn by
  /// the mesh, replaced by the primitive, or under the planar DOF) — buildSnapshot's
  /// order. `emit` routes a layer (precomp routing); `report` records an unported feature.
  void finish_layer(const doc::Node& n, const Values& a, Layer3D& s, RLayer layer,
                    const std::function<void(RLayer)>& emit, const std::function<void(std::string)>& report);

  /// A light layer (buildSnapshot `kind === 'light'`): the wash layer, or none.
  [[nodiscard]] std::optional<RLayer> light_layer(const doc::Node& n);

  /// A 3D comp LAYER's card (buildPrecompContainer, threed_card.cpp): the
  /// referenced comp drawn flat onto its projected corners around the anchor.
  struct Card {
    std::array<double, 8> quad{};
    std::array<double, 6> matrix{};
    double x = 0, y = 0, depth = 0;
  };
  struct CardPlan {
    std::optional<Card> still;  ///< null = behind the camera (not drawn)
    /// The card at (layer time ti, comp time tc) — one perspective quad per shutter sample.
    std::function<std::optional<Card>(double, double)> at;
    std::optional<std::array<double, 3>> lighting;  ///< Accepts Lights gain
  };
  /// `sample(prop, t)` is the walk's instance-aware sampler; `gWorld` the 2D world pose.
  [[nodiscard]] CardPlan comp_card(const doc::Node& group, const Values& gv, const motion::xf::Local2D& gWorld,
                                   double baseX, double baseY, double baseRot, double baseScaleX, double baseScaleY,
                                   double refW, double refH, double anchorX, double anchorY,
                                   const std::function<std::optional<double>(std::string_view, double)>& sample);

  /// After the walk: landed beams, projected shadows, the depth sort.
  void finish(std::vector<RLayer>& layers);

  /// The snapshot's camera3d / lights3d / envMap / ssao (after `finish`).
  void emit(Snapshot& s, const std::vector<RLayer>& layers) const;

  [[nodiscard]] bool has_camera() const noexcept { return camera_.has_value(); }
  [[nodiscard]] const std::optional<motion::xf::Camera>& camera() const noexcept { return camera_; }
  /// Anything the port does not produce for this frame (reported on the snapshot).
  [[nodiscard]] const std::vector<std::pair<std::string, std::string>>& unported() const noexcept { return unported_; }

 private:
  [[nodiscard]] motion::xf::Projected project(motion::xf::Vec3 p) const;
  std::optional<motion::xf::Mat4> parent_world_3d(const std::string& id);
  std::optional<motion::xf::Mat4> parent_world_matrix(const std::string& id);
  motion::xf::Vec3 to_world_point(const std::string& id, motion::xf::Vec3 p);
  motion::xf::Vec3 node_world_position(const doc::Node& n);
  std::optional<motion::xf::Node3DTransform> local3d(const std::string& id);
  const doc::Node* view_camera_node(const std::vector<const doc::Node*>& nodes);
  motion::xf::Camera camera_from_node(const doc::Node& n, const std::function<std::optional<double>(std::string_view)>& sample);
  double node_light_aim_deg(const doc::Node& n, const LightProps& lt);

  struct Affine {
    std::array<double, 6> matrix{};
    motion::xf::Projected O;
    motion::xf::Mat4 world{};
  };
  Affine affine_at(const Layer3D& s, double wx, double wy, double wz, double rX, double rY, double rZ, double sX, double sY,
                   double sZ, const std::function<motion::xf::Projected(motion::xf::Vec3)>* proj = nullptr) const;

  Scene3DHost& h_;
  const BuildContext& c_;
  const SnapshotComp& comp_;
  double t_;
  const std::optional<MotionBlurCfg>& mb_;

  std::optional<motion::xf::OrthoView> ortho_;
  std::optional<motion::xf::Camera> camera_;
  const doc::Node* viewCam_ = nullptr;
  std::optional<DofConfig> dof_;
  bool cameraAnimated_ = false;
  std::unordered_map<double, motion::xf::Camera> subFrameCameras_;

  std::unordered_map<std::string, std::optional<motion::xf::Mat4>> parent3dCache_;

  // Lights.
  std::vector<SceneLight> sceneLights_;
  std::unordered_map<std::string, std::size_t> sceneLightById_;
  std::vector<SceneLight> formRig_;
  bool formRigUsed_ = false;
  struct ShadowLight {
    double x = 0, y = 0, z = 0, intensity = 0, darkness = 0, diffusion = 0;
  };
  std::vector<ShadowLight> shadowLights_;
  bool hasShadowMapLight_ = false;
  struct EnvReflect {
    Json sky;
    double intensity = 0;
    double rotationDeg = 0;
    std::string nodeId;
  };
  std::optional<EnvReflect> envReflect_;

  // Walk bookkeeping (by layer id: the TypeScript holds object references; the
  // C++ walk moves layers, so the post-walk passes find them by id).
  struct Receiver {
    double z = 0, depth = 0;
    std::string layerId;
  };
  std::vector<Receiver> shadowReceivers_;
  std::vector<Receiver> lightReceivers_;
  struct Caster {
    std::string layerId;
    double z = 0, transmission = 0;
    motion::xf::Mat4 world3d{};
    /// The caster's state once its GPU-effect block ran (what the shadow copies).
    /// shared_ptr: the walk's per-layer copy is shared by one shadow per light.
    std::shared_ptr<const RLayer> layer;
  };
  std::vector<Caster> shadowCasters_;
  /// Layers emitted as a copy (the planar-DOF branch): the TypeScript's shadow
  /// splice cannot find the object any more and appends.
  std::vector<std::string> copiedOnEmit_;
  struct Wash {
    std::string nodeId;
    double reach = 0;
  };
  std::vector<Wash> washLights_;

  std::vector<std::pair<std::string, std::string>> unported_;
};

}  // namespace premation::scene
