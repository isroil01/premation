// The D2w scene builder and the E2 audio engine wired into the engine process:
//
//   EngineFrameBuilder   Session's FrameBuilder (core thread): document +
//                        comp + time → BuiltFrame (snapshot_build + frame_build,
//                        the viewport's contain-fit camera), per-layer errors
//                        and features outside the port → layerErrors
//   make_drawer_factory  the render thread's BuiltFrameDrawer: SceneRenderer on
//                        the render thread's own device (create_on), the texture
//                        feed (E3 rasters, E1 footage frames) → the slot texture
//   EngineAudio          Session's MediaClock: AudioSystem + AudioTransportClock
//                        (audio/transport_clock.hpp), the audio program built
//                        from the document's audio / video / nested-comp layers
//
// engine_process.cpp installs all three when the engine is built with them
// (PREMATION_HAVE_SCENE); PREMATION_ENGINE_SCENE=0 keeps C2's quad scene.
#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "gpu.hpp"
#include "render_thread.hpp"
#include "session_hooks.hpp"

namespace premation::scene {

struct EngineFramesOptions {
  /// A fonts.json manifest (E3 FontSet::load_manifest); empty = system fonts only.
  std::string fontsManifest;
  /// Canvas metric profile: Chromium on Windows (what the editor's page draws with).
  bool chromiumProfile = true;
};

/// FrameBuilder over snapshot_build + frame_build.
[[nodiscard]] std::unique_ptr<FrameBuilder> make_frame_builder(const EngineFramesOptions& options);

/// The render thread's drawer factory (RenderOptions::makeDrawer).
[[nodiscard]] std::function<std::unique_ptr<render::BuiltFrameDrawer>(const Gpu&, std::string&)> make_drawer_factory(
    const EngineFramesOptions& options);

/// MediaClock over the E2 AudioSystem. `useDevice` false = the steady-clock
/// NullDevice (tests, headless). Null when the engine was built without audio.
[[nodiscard]] std::unique_ptr<MediaClock> make_media_clock(bool useDevice, std::string& error);

/// Every font family the document's text names (component props + rich-text
/// runs), sorted and unique — registered on a FontSet before measuring.
[[nodiscard]] std::vector<std::string> document_font_families(const doc::Document& d);

/// F1 export: a composition's audio mixed offline (the same voices the
/// viewport's MediaClock plays, the E2 mixer's sample-exact render).
struct CompAudioMix {
  int sampleRate = 48000;
  /// Some unmuted voice reaches the range; false = a silent export (no audio track).
  bool audible = false;
  /// Planar float channels, ceil((end − start) × rate) frames each; empty when !audible.
  std::vector<std::vector<float>> channels;
  /// What the voice builder reports as outside the port (audio_unported).
  std::vector<std::string> notes;
};
/// False (with `error`) when a source never finished decoding or there is no audio engine.
bool mix_comp_audio(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr, doc::ExprCache& cache,
                    std::string_view comp, double startSec, double endSec, CompAudioMix& out, std::string& error);

}  // namespace premation::scene
