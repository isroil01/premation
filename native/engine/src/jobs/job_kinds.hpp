// The engine's job kinds (engine_jobs): one prepare function per JobSpec
// variant, each in its own kind_*.cpp; make_job_kinds() dispatches to them.
#pragma once

#include <memory>
#include <string>

#include "job_api.hpp"

namespace premation::jobs {

[[nodiscard]] std::unique_ptr<JobKinds> make_job_kinds();

/// The ffmpeg the proxy job transcodes with — Electron main hands the export's
/// binary over as PREMATION_FFMPEG (ffmpegBinary.ts); '' = `ffmpeg` on PATH. Set at startup.
void set_ffmpeg_executable(std::string path);
[[nodiscard]] std::string ffmpeg_executable();

// ── per kind (kind_<name>.cpp) ──
[[nodiscard]] PreparedJob prepare_track_motion(const api::TrackMotionJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_stabilize(const api::StabilizeJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_auto_trace(const api::AutoTraceJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_roto_brush(const api::RotoBrushJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_content_aware_fill(const api::ContentAwareFillJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_auto_reframe(const api::AutoReframeJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_scene_detect(const api::SceneDetectJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_object_matte(const api::ObjectMatteJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_audio_analysis(const api::AudioAnalysisJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_audio_duck(const api::AudioDuckJob& spec, const JobDocContext& ctx);
/// The audio driver's envelope (kind_audio.cpp): a layer's sound or the comp's mix, analysis only.
[[nodiscard]] PreparedJob prepare_audio_envelope(const api::AudioEnvelopeJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_audio_gate(const api::AudioGateJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_proxy(const api::ProxyJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_render(const api::RenderJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_prerender(const api::PrerenderJob& spec, const JobDocContext& ctx);
/// Bake Physics to Keyframes / Bake Particles to Layers (kind_dynamics_bake.cpp).
[[nodiscard]] PreparedJob prepare_physics_bake(const api::PhysicsBakeJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_particle_bake(const api::ParticleBakeJob& spec, const JobDocContext& ctx);
[[nodiscard]] PreparedJob prepare_track_apply(const api::TrackApplyJob& spec, const JobDocContext& ctx);
/// Transcription through the user's speech provider (kind_transcribe.cpp); the key arrives in the spec from Electron main.
[[nodiscard]] PreparedJob prepare_transcribe(const api::TranscribeJob& spec, const JobDocContext& ctx);

/// The child-process work of the kinds that load a model (child_job.hpp).
void register_object_matte_child();

}  // namespace premation::jobs
