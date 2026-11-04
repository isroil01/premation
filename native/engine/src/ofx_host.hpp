// SDK 1.4 (O): an OpenFX 1.4 host — premation-plugin-host's mode for a `.ofx.bundle`. OFX plugins
// run out of process only (row O2): the engine sees their effects through the same describe /
// render messages as a native out-of-process plugin (plugins/oop_wire.hpp).
//
// What is hosted: the Image Effect API's Filter, General (one Source clip) and Generator contexts,
// CPU rendering of RGBA float images (Premation converts its 8 / 16 / 32-bit worlds), the property,
// image effect, parameter, memory, multi-thread and message suites. Not hosted (yet): OpenGL / CUDA
// / Metal / OpenCL render suites, overlays (interacts), custom and parametric params, more than one
// input clip, temporal clip access (other frames), tiles and render scales other than 1.
//
// Params map onto Premation params: Double → slider (angle when declared one), Integer → integer
// slider, Boolean → checkbox, Choice → popup, RGB / RGBA → colour, Double2D → point; groups become
// Effect Controls groups. Others are defined for the plugin but not shown.
#pragma once

#include <filesystem>
#include <memory>
#include <string>

#include "oop_wire.hpp"

namespace premation::plugins::ofx {

class Host {
 public:
  Host();
  ~Host();
  Host(const Host&) = delete;
  Host& operator=(const Host&) = delete;
  Host(Host&&) = delete;
  Host& operator=(Host&&) = delete;

  /// Load every image effect in `bundle` (<name>.ofx.bundle/Contents/<arch>/<name>.ofx), run
  /// load + describe + describe-in-context. False + `error` when the bundle has none it can host.
  bool load(const std::filesystem::path& bundle, std::string& error);
  /// The effects as describe JSON (match names `ofx:<identifier>`), or {"error": "…"}.
  [[nodiscard]] std::string describe_json() const;
  /// One frame of one instance (instances are kept by RenderInputs::instance).
  oop::RenderReply render(const oop::RenderRequest& req);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

/// `ofx:<identifier>` for an OFX plugin identifier.
[[nodiscard]] std::string match_name(std::string_view identifier);

}  // namespace premation::plugins::ofx
