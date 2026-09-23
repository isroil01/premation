// OpenColorIO, behind plain structs — the ONLY file that includes OCIO headers
// (ocio_ffi.cpp; CLAUDE.md: FFI lives in *_ffi.cpp). No OCIO type and no OCIO
// exception crosses this header: every call returns false + an error string.
//
// The config is OCIO's built-in CG config, pinned by version
// (cg-config-v2.2.0_aces-v1.3_ocio-v2.4) so a given document renders the same
// pixels on every machine; a project may name its own config file instead.
// Each engine Space resolves to a LINEAR colour space of the config plus an
// optional encoding curve, both expressed as OCIO transforms:
//
//   srgb            Linear Rec.709 (sRGB)  + sRGB curve (ExponentWithLinear 2.4 / 0.055)
//   rec709          Linear Rec.709 (sRGB)  + gamma 2.4 (Exponent, pass-thru negatives)
//   linear_srgb     Linear Rec.709 (sRGB)
//   aces_cg         ACEScg
//   rec2020         Linear Rec.2020        + gamma 2.4
//   linear_rec2020  Linear Rec.2020
//   aces2065        ACES2065-1
//
// A request `src → dst` becomes one OCIO processor: [decode src] → ColorSpace
// (or DisplayView, when a view is named) → [encode dst], optimized LOSSLESS.
#pragma once

#include <memory>
#include <span>
#include <string>
#include <string_view>

#include "color_program.hpp"

namespace premation::rg::color {

inline constexpr std::string_view kBuiltinConfig = "ocio://cg-config-v2.2.0_aces-v1.3_ocio-v2.4";

struct Request {
  Space src = Space::linear_srgb;
  Space dst = Space::srgb;
  /// An OCIO view on dst's display ("ACES 1.0 - SDR Video", …); empty = a plain colour-space conversion.
  std::string view;
  /// Bake to a lattice even when the op list could express the processor (measurement, tests).
  bool forceLut = false;
  std::uint32_t lutSize = 33;
  [[nodiscard]] std::string key() const {
    std::string k = std::to_string(static_cast<int>(src)) + ">" + std::to_string(static_cast<int>(dst));
    if (!view.empty()) k += "|" + view;
    if (forceLut) k += "|lut" + std::to_string(lutSize);
    return k;
  }
};

class Ocio {
 public:
  /// `config`: a file path or an ocio:// URI; empty = kBuiltinConfig.
  static std::unique_ptr<Ocio> open(std::string_view config, std::string& error);
  ~Ocio();
  Ocio(const Ocio&) = delete;
  Ocio& operator=(const Ocio&) = delete;
  Ocio(Ocio&&) = delete;
  Ocio& operator=(Ocio&&) = delete;

  /// The GPU program for `req`: the op list when every op of the optimized
  /// processor is one color_program expresses, else a baked lattice.
  bool program(const Request& req, Program& out, std::string& error) const;
  /// OCIO's own CPU processor (LOSSLESS: exact pow/log) on straight RGB
  /// triples, in place — the reference the tests and the lattice bake use.
  bool apply_cpu(const Request& req, std::span<float> rgb, std::string& error) const;
  /// Names of the optimized processor's ops (diagnostics, tests).
  bool describe(const Request& req, std::string& out, std::string& error) const;

  [[nodiscard]] const std::string& config_name() const noexcept { return name_; }

 private:
  Ocio() = default;
  struct Impl;
  std::unique_ptr<Impl> impl_;
  std::string name_;
};

}  // namespace premation::rg::color
