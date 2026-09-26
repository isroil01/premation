// sceneDetect: Scene Edit Detection over a video layer's visible span
// (sceneEditDetectLayer.ts), applied as the page applied it — composition
// markers "Cut N" / "Dissolve N", or the layer split at every cut.
#include <algorithm>
#include <cmath>
#include <set>
#include <string>
#include <vector>

#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "jsmath.hpp"
#include "media_input.hpp"
#include "readmodel.hpp"
#include "scene_detect.hpp"
#include "time_conv.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;

namespace {

class SceneResult final : public JobResult {
 public:
  std::string layer;
  std::string comp;
  double compFps = 30;
  bool markers = true;
  std::vector<double> cutsCompSec;
  std::vector<double> dissolvesCompSec;

  [[nodiscard]] std::string summary_json() const override {
    std::string cuts = "[";
    for (std::size_t i = 0; i < cutsCompSec.size(); ++i) cuts += (i > 0 ? "," : "") + json_number(cutsCompSec[i]);
    std::string fades = "[";
    for (std::size_t i = 0; i < dissolvesCompSec.size(); ++i) fades += (i > 0 ? "," : "") + json_number(dissolvesCompSec[i]);
    return "{\"cutsCompSec\":" + cuts + "],\"dissolvesCompSec\":" + fades + "],\"mode\":\"" + (markers ? "markers" : "split") + "\"}";
  }
  [[nodiscard]] std::string label() const override { return markers ? "Scene Edit Markers" : "Scene Edit Split"; }
  [[nodiscard]] bool has_edits() const override { return !cutsCompSec.empty(); }

  void apply(JobApply& a) const override {
    if (markers) {
      // applySceneEditsAsMarkers.
      api::AddMarkers m;
      const std::set<double> soft(dissolvesCompSec.begin(), dissolvesCompSec.end());
      int cuts = 0;
      int fadesN = 0;
      for (const double sec : cutsCompSec) {
        const bool fade = soft.contains(sec);
        api::MarkerInsert ins;
        ins.owner.comp = comp;
        ins.time = doc::frames_to_flicks(motion::js::round(sec * compFps), compFps);
        ins.name = fade ? "Dissolve " + std::to_string(++fadesN) : "Cut " + std::to_string(++cuts);
        ins.color = fade ? "#c89b3c" : "#e27d69";
        m.markers.push_back(std::move(ins));
      }
      (void)a.run(command(std::move(m)));
      return;
    }
    // applySceneEditsAsSplits: ascending, on whichever piece covers the cut now.
    std::vector<std::string> pieces{layer};
    std::vector<double> sorted = cutsCompSec;
    std::sort(sorted.begin(), sorted.end());
    for (const double sec : sorted) {
      const double frame = motion::js::round(sec * compFps);
      std::string host;
      for (const std::string& id : pieces) {
        if (a.document().node(id) == nullptr) continue;
        const api::LayerTiming t = doc::layer_timing(a.document(), id);
        const double start = motion::js::round(seconds_of(t.in_point) * compFps);
        const double end = motion::js::round(seconds_of(t.out_point) * compFps);
        if (frame > start && frame < end) {
          host = id;
          break;
        }
      }
      if (host.empty()) continue;
      api::SplitLayers s;
      s.layers = {host};
      s.time = flicks_of(sec);
      const api::CommandResult r = a.run(command(std::move(s)));
      if (const auto list = result_payload<api::LayerList>(r)) pieces.insert(pieces.end(), list->layers.begin(), list->layers.end());
    }
  }
};

}  // namespace

PreparedJob prepare_scene_detect(const api::SceneDetectJob& spec, const JobDocContext& ctx) {
  const FootageLayer f = footage_layer(ctx, spec.layer, Need::picture);
  if (f.kind != api::LayerKind::video) fail(ErrorCode::invalid_argument, "Layer has no video source.", {.layer = f.layer});
  const double startFrame = motion::js::round(f.in_seconds() * f.compFps);
  const double endFrame = motion::js::round(f.out_seconds() * f.compFps) - 1;
  if (endFrame <= startFrame) fail(ErrorCode::invalid_argument, "The clip is too short to contain a cut.", {.layer = f.layer});
  scene_detect::Options o;
  if (spec.threshold) o.floor = *spec.threshold;
  if (spec.sensitivity) o.sensitivity = *spec.sensitivity;
  if (spec.dissolves) o.dissolves = *spec.dissolves;
  const bool markers = spec.create_markers || !spec.split_layers;
  const std::optional<double> minShotSec = spec.min_shot_seconds;
  return PreparedJob{"sceneDetect", [f, o, markers, minShotSec, startFrame, endFrame](JobControl& control) -> std::unique_ptr<JobResult> {
    std::string error;
    // The ORIGINAL file at full size (a proxy's re-encode can smear a hard cut).
    std::unique_ptr<FrameSource> src = open_frames(f.file, 0, error);
    if (!src) fail(ErrorCode::io, error);
    const double fps = src->fps();
    // Comp frame → source presentation index (+1 µs, the boundary rule of exactVideoFrames).
    const auto srcIndexAt = [&](double compFrame) {
      const double mediaSec = f.source_seconds(compFrame / f.compFps);
      return static_cast<std::int64_t>(std::floor(std::max(0.0, mediaSec + 1e-6) * fps));
    };
    const std::int64_t from = std::max<std::int64_t>(0, srcIndexAt(startFrame));
    const std::int64_t to = std::min(src->frame_count() - 1, srcIndexAt(endFrame));
    if (to <= from) fail(ErrorCode::invalid_argument, "The clip does not advance over its span — nothing to detect.");
    scene_detect::Options opts = o;
    if (minShotSec) opts.minShotFrames = std::max(1, static_cast<int>(motion::js::round(*minShotSec * fps)));
    std::string readError;
    const scene_detect::WalkResult w = scene_detect::walk(
        from, to, opts,
        [&](std::int64_t i, LumaImage& out) { return !control.cancelled() && src->read_luma(i, out, readError); },
        [&](double fraction) {
          control.progress(fraction, "Scene Edit Detection: reading frames");
          return !control.cancelled();
        });
    if (control.cancelled()) return nullptr;
    if (!readError.empty()) fail(ErrorCode::io, readError);
    auto out = std::make_unique<SceneResult>();
    out->layer = f.layer;
    out->comp = f.comp;
    out->compFps = f.compFps;
    out->markers = markers;
    for (const std::int64_t c : w.cuts) out->cutsCompSec.push_back(f.comp_seconds(static_cast<double>(c) / fps));
    for (const std::int64_t c : w.dissolveCuts) out->dissolvesCompSec.push_back(f.comp_seconds(static_cast<double>(c) / fps));
    return out;
  }};
}

}  // namespace premation::jobs
