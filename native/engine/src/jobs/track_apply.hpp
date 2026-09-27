// The tracker results' document side (core thread, inside JobResult::apply):
// what src/core/tracking/applyTrack.ts reads to turn samples into a PLAN, and
// what src/layout/Inspector/trackMotion/trackApplyEdits.ts +
// keySpliceEdits.ts send for a plan.
//
//   Reads   applyTrack.ts `trackSampleToComp` (source px → the video layer's
//           centred local box → comp, through layerSpaceAt), parent spaces,
//           `readGeometry`, `defaultAnimation.sample` on the keyframe axis,
//           mirror/tracking.ts `memberStoredAt`, `firstEffectOfType`.
//   Writes  ONE journal (the job's history entry) of ordinary commands, the
//           ones the UI's Apply sends:
//             addEffect        when an effect plan's target has none of that type;
//             addKeyframes     every planned key, comp-time flicks, linear, in AE
//                              units (x/y/rotation as stored, scale ×100);
//                              members a plan does not key keep their stored
//                              value at that time;
//             deleteKeyframes  the keys that were inside each property's new
//                              first…last span (Motion Sketch's splice), minus
//                              the ids addKeyframes re-used.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "anim.hpp"
#include "docexpr.hpp"
#include "job_api.hpp"
#include "model.hpp"
#include "timeline.hpp"
#include "worldxf.hpp"

namespace premation::jobs::trackapply {

/// applyTrack.ts TrackWrite: one legacy track's keys at composition seconds, stored units.
struct Write {
  std::string track;
  std::vector<std::pair<double, double>> keys;
};

/// applyTrack.ts TrackPlan.
struct Plan {
  std::string label;
  std::string layer;
  std::vector<Write> writes;
  /// Non-empty: the writes are params of the layer's first effect of this type (added when it has none) —
  /// or of `effectId` when the caller named one.
  std::string effectType;
  std::string effectId;
  std::size_t count = 0;
};

/// `trackBuckets`: one key list per track name, insertion order; empty lists dropped.
class Buckets {
 public:
  explicit Buckets(const std::vector<std::string>& names);
  void add(std::string_view track, double compTime, double value);
  [[nodiscard]] std::vector<Write> writes() const;

 private:
  std::vector<Write> w_;
};

struct Geometry {
  motion::xf::Local2D local;
  std::optional<double> width;
  std::optional<double> height;
};

struct P2 {
  double x = 0;
  double y = 0;
};

/// The document as the plans read it: a const document, an editor view on the
/// layer's composition, the document expression host.
class DocView {
 public:
  DocView(const doc::Document& d, std::string_view comp);
  DocView(const DocView&) = delete;
  DocView& operator=(const DocView&) = delete;
  DocView(DocView&&) = delete;
  DocView& operator=(DocView&&) = delete;
  ~DocView() = default;

  [[nodiscard]] const doc::Document& doc() const noexcept { return d_; }
  [[nodiscard]] double comp_width() const noexcept { return compW_; }
  [[nodiscard]] double comp_height() const noexcept { return compH_; }
  [[nodiscard]] const doc::Node* node(std::string_view id) const { return d_.node(id); }
  /// `node.parent ?? null` (a top-level layer's parent is its composition node).
  [[nodiscard]] std::optional<std::string> parent_of(std::string_view id) const;
  [[nodiscard]] bool is_camera(std::string_view id) const;
  /// `readGeometry(node)`'s transform + box, nullopt for a kind with no geometry.
  [[nodiscard]] std::optional<Geometry> geometry(std::string_view id) const;
  /// `layerSpaceAt(node, compTime, comp)`.
  [[nodiscard]] std::optional<doc::LayerSpace> space(std::string_view id, double compTime) const;
  [[nodiscard]] static P2 to_comp(const doc::LayerSpace& s, P2 p);
  [[nodiscard]] static P2 from_comp(const doc::LayerSpace& s, P2 p);
  /// `compToKeyframeTime(node, compTime)`.
  [[nodiscard]] double key_time(std::string_view id, double compTime) const;
  /// `defaultAnimation.sample(node, track, keyTime)` (nullopt when not animated).
  [[nodiscard]] std::optional<double> sample(std::string_view id, std::string_view track, double keyTime) const;
  /// `trackSampleToComp`: source px at one comp time → comp px through the video layer's live transform.
  /// `boxFallback` stands in for a box `readGeometry` does not report (the footage's stored size).
  [[nodiscard]] std::optional<P2> sample_to_comp(std::string_view video, double x, double y, double compTime,
                                                 double sourceWidth, double sourceHeight, P2 boxFallback) const;
  /// `memberStoredAt`: a member's stored value at comp time (keyed when animated, else static, else 0).
  [[nodiscard]] double member_stored_at(std::string_view layer, std::string_view member, double compTime) const;
  /// `firstEffectOfType`: the id of the layer's first effect of `type`, or ''.
  [[nodiscard]] std::string first_effect_of_type(std::string_view layer, std::string_view type) const;
  /// The effect `id`'s type on `layer`, or '' when it has no such effect.
  [[nodiscard]] std::string effect_type(std::string_view layer, std::string_view id) const;

 private:
  const doc::Document& d_;
  doc::EditorView view_;
  mutable doc::ExprCache cache_;
  doc::DocExprEnv env_;
  double compW_ = 1920;
  double compH_ = 1080;
};

/// Send `plan` through `a` (one journal: the job's entry). Throws EngineFail
/// when a planned track is not addressable on the layer (the whole result rolls back).
void send_plan(JobApply& a, const Plan& plan);

/// One key of a mask's path: composition seconds, the whole path.
struct PathKey {
  double compTime = 0;
  api::BezierPath path;
};
/// A mask's keys (`group` = "masks/<id>").
struct PathKeys {
  std::string group;
  std::vector<PathKey> keys;
};

/// Mask path keys spliced over their span (maskTrack.ts / rotoBrush.ts: the
/// keys inside each mask's new first…last span replaced, the rest kept), as
/// one addKeyframes (linear) + one deleteKeyframes. Throws EngineFail when a
/// mask is gone (the whole result rolls back).
void send_path_splice(JobApply& a, const std::string& layer, const std::vector<PathKeys>& masks);

/// Unwrap `delta` to within half a turn of `prev` (degrees), as the plans do.
[[nodiscard]] double unwrap_deg(double delta, double prev) noexcept;

}  // namespace premation::jobs::trackapply
