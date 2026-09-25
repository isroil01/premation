// F1 — export from the engine (docs/NATIVE_CORE_PLAN.md Phase F).
//
//   premation-engine --export JOB.json
//
// One process per job, started by the export supervisor (electron/
// engineExport.ts) instead of a hidden Chromium window. The job opens the
// project on disk (a .motion bundle or a JSON document, project_open.hpp),
// renders the composition's frame range offline — no viewport — and writes raw
// frames to ffmpeg exactly as the TypeScript raw pipe does (straight-alpha
// RGBA8, top-down, `-f rawvideo -pix_fmt rgba … -i pipe:0`), with the
// command line built by the SUPERVISOR from the same `buildEncodeArgs` the
// Chromium path uses, so the two cannot drift.
//
// ── Control protocol (JSON lines) ──────────────────────────────────────────
//
//   stdout (engine → supervisor)
//     {"ev":"preflight","ok":true,"frames":N,"width":W,"height":H,"fps":F,
//      "comp":ID,"compName":S,"alpha":B,"audio":PATH|null,"warnings":[…],"ms":T}
//     {"ev":"preflight","ok":false,"reason":S,"unported":[{"frame":i,"reason":S}…]}
//     {"ev":"progress","frame":k,"total":N}              (k frames are in the encoder)
//     {"ev":"done","frames":N,"stats":{…}}
//     {"ev":"error","fallback":B,"message":S}
//   stdin (supervisor → engine), after a successful preflight
//     {"encode":{"bin":PATH,"args":[…]}}                 start rendering into this encoder
//     {"cancel":true}                                    stop; nothing is delivered
//   stdin end-of-file before "done" is a cancel (the supervisor is gone).
//
// ── Exit codes ─────────────────────────────────────────────────────────────
//   0 done · 1 failed (the export itself failed: the encoder, the disk) ·
//   3 fall back (a frame uses a feature the scene builder has not ported, the
//   GPU could not start, a pass could not be honoured — the supervisor renders
//   the job on the Chromium path instead) · 4 cancelled · 64 bad job.
//
// ── Threads ────────────────────────────────────────────────────────────────
//   build workers (N)  each owns a copy of the document, its expression cache,
//                      fonts and text measurer; frames are claimed in order
//                      within a bounded window and built in parallel
//   render (1)         texture feed (E3 rasters, E1 footage) + render graph
//                      submission; up to `inFlight` frames on the GPU at once,
//                      each read back when the ring is full (render_submit /
//                      take_readback), converted to straight RGBA
//   writer (1)         frames to the encoder's stdin, strictly in order
// Output order is the frame order whatever the thread timing: the render
// thread consumes built frames by index and the writer by submission order.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "json.hpp"

namespace premation::exporter {

inline constexpr int kExitOk = 0;
inline constexpr int kExitFailed = 1;
inline constexpr int kExitFallback = 3;
inline constexpr int kExitCancelled = 4;
inline constexpr int kExitUsage = 64;

struct JobSpec {
  std::string projectPath;
  /// Composition id or name (headlessRender.ts `resolveComposition`); empty = the first real comp.
  std::string comp;
  /// Where audio.wav (and the encoder's log) go. Required.
  std::string workDir;
  std::optional<std::int64_t> startFrame;
  std::optional<std::int64_t> endFrame;
  std::optional<double> fps;
  std::optional<double> width;
  std::optional<double> height;
  std::optional<bool> transparent;
  /// E3 fonts manifest (PREMATION_FONTS_MANIFEST when empty).
  std::string fontsManifest;
  /// Canvas metric profile (Chromium's, as the editor draws). The render-tests harness uses it too.
  bool chromiumProfile = true;
  /// Build workers; 0 = decided from the machine.
  unsigned buildThreads = 0;
  /// Frames on the GPU at once (submitted, not yet read back).
  unsigned inFlight = 3;
  /// Mix the comp's audio (off: a video-only job, as a GIF).
  bool audio = true;
  /// The encoder, when known up front (tools / benches); otherwise it arrives on stdin.
  std::optional<std::string> encodeBin;
  std::vector<std::string> encodeArgs;
  /// Tools: stop after the preflight report.
  bool preflightOnly = false;
};

/// Parse a job file's JSON. False with `error` on a missing / mistyped field.
bool parse_job(const js::Json& j, JobSpec& out, std::string& error);

/// `premation-engine --export JOB.json`: the whole job. Returns the exit code.
int run_export(const std::string& jobPath);

}  // namespace premation::exporter
