#include "job_kinds.hpp"

#include <mutex>
#include <utility>
#include <variant>

#include "child_job.hpp"
#include "fail.hpp"

namespace premation::jobs {

namespace {

class EngineJobKinds final : public JobKinds {
 public:
  [[nodiscard]] PreparedJob prepare(const api::JobSpec& spec, const JobDocContext& ctx) override {
    return std::visit(
        [&ctx](const auto& s) -> PreparedJob {
          using T = std::decay_t<decltype(s)>;
          if constexpr (std::is_same_v<T, api::TrackMotionJob>) return prepare_track_motion(s, ctx);
          else if constexpr (std::is_same_v<T, api::StabilizeJob>) return prepare_stabilize(s, ctx);
          else if constexpr (std::is_same_v<T, api::AutoTraceJob>) return prepare_auto_trace(s, ctx);
          else if constexpr (std::is_same_v<T, api::SceneDetectJob>) return prepare_scene_detect(s, ctx);
          else if constexpr (std::is_same_v<T, api::ObjectMatteJob>) return prepare_object_matte(s, ctx);
          else if constexpr (std::is_same_v<T, api::AudioAnalysisJob>) return prepare_audio_analysis(s, ctx);
          else if constexpr (std::is_same_v<T, api::AudioDuckJob>) return prepare_audio_duck(s, ctx);
          else if constexpr (std::is_same_v<T, api::AudioGateJob>) return prepare_audio_gate(s, ctx);
          else if constexpr (std::is_same_v<T, api::ProxyJob>) return prepare_proxy(s, ctx);
          else if constexpr (std::is_same_v<T, api::RenderJob>) return prepare_render(s, ctx);
          else if constexpr (std::is_same_v<T, api::PrerenderJob>) return prepare_prerender(s, ctx);
          else if constexpr (std::is_same_v<T, api::TrackApplyJob>) return prepare_track_apply(s, ctx);
          else if constexpr (std::is_same_v<T, api::RotoBrushJob>) return prepare_roto_brush(s, ctx);
          else if constexpr (std::is_same_v<T, api::ContentAwareFillJob>) return prepare_content_aware_fill(s, ctx);
          else if constexpr (std::is_same_v<T, api::AutoReframeJob>) return prepare_auto_reframe(s, ctx);
          else if constexpr (std::is_same_v<T, api::PhysicsBakeJob>) return prepare_physics_bake(s, ctx);
          else if constexpr (std::is_same_v<T, api::ParticleBakeJob>) return prepare_particle_bake(s, ctx);
          else if constexpr (std::is_same_v<T, api::RigLogoJob>) return prepare_rig_logo(s, ctx);
          else if constexpr (std::is_same_v<T, api::TranscribeJob>) return prepare_transcribe(s, ctx);
          else if constexpr (std::is_same_v<T, api::CameraTrackJob>) return prepare_camera_track(s, ctx);
          else if constexpr (std::is_same_v<T, api::FaceTrackJob>) return prepare_face_track(s, ctx);
          else if constexpr (std::is_same_v<T, api::ModelImportJob>) return prepare_model_import(s, ctx);
          else doc::fail(api::ErrorCode::unsupported, "this engine does not run that job kind");
        },
        spec.v);
  }
};

}  // namespace

std::unique_ptr<JobKinds> make_job_kinds() { return std::make_unique<EngineJobKinds>(); }

namespace {
std::mutex& ffmpeg_mutex() {
  static std::mutex m;
  return m;
}
std::string& ffmpeg_path() {
  static std::string p;
  return p;
}
}  // namespace

void set_ffmpeg_executable(std::string path) {
  const std::lock_guard<std::mutex> lock(ffmpeg_mutex());
  ffmpeg_path() = std::move(path);
}

std::string ffmpeg_executable() {
  const std::lock_guard<std::mutex> lock(ffmpeg_mutex());
  return ffmpeg_path().empty() ? std::string("ffmpeg") : ffmpeg_path();
}

void register_child_works() {
  static const bool once = [] {
    register_object_matte_child();
    register_face_track_child();
    return true;
  }();
  (void)once;
}

}  // namespace premation::jobs
