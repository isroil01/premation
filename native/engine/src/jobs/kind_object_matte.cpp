// Job kind `objectMatte` — one click (or a drawn box) on footage becomes a
// mask path: src/core/tracking/objectMask.ts `segmentObjectMask` with the
// neural path of samSegment.ts / samPipeline.ts (SlimSAM through ONNX
// Runtime).
//
//   prepare (core)   the layer's file, the source time under range.start, the
//                    prompts, the model files (the spec's, else
//                    $PREMATION_SAM_USER_DIR/… when the user installed a model there,
//                    else $PREMATION_SAM_DIR/{vision_encoder,prompt_encoder_mask_decoder}_quantized.onnx).
//   work (worker)    run_in_worker("objectMatte", …): the model runs in the long-lived
//                    job worker process (job_worker.hpp) — single frames and walks share
//                    the loaded pair — so a runtime crash fails the job only.
//   child            decode the frame, preprocess, encode, decode the prompts,
//                    upsample + threshold the best mask, box-constrain it,
//                    trace its outline (trace_bitmap.hpp) → the contour JSON.
//   video (AE parity 3.1 / 3.2, `direction` set): the child walks the range
//                    from `origin` forward / backward / both ways; every frame is
//                    encoded and segmented from prompts carried by the previous
//                    frame's matte (warped by flow: its deepest interior points,
//                    a ring of background points, its box) plus the correction
//                    strokes on that frame. The matte is SOFT (the decoder's
//                    logits through the logistic), refined (guided filter to the
//                    picture's edges, motion blur along the flow, choke /
//                    feather, chatter reduction against the previous frame) and
//                    stored as the frame's cut-out PNG (colours decontaminated)
//                    — setLayerMatte, which the renderer shows in place of the
//                    footage — and its outline keyed on an "Object Matte" mask
//                    (mode none) for editing and Track mask. One entry.
//                    With SAM 2.1 installed ($PREMATION_SAM2_USER_DIR) the walk
//                    runs it instead (sam2_track.hpp): its memory bank carries
//                    the subject, no flow seeds, occlusion keeps the walk going,
//                    and a stroke's frame becomes a conditioning frame.
//                    The single-frame call caches the encoder's output per
//                    (file, mtime, frame, model) on disk (sam_embed_cache.hpp).
//   apply (core)     addMask (mode none, "Object mask") + its feather 2 — the
//                    path objectMask.ts writes: geometry for Track mask and
//                    the path effects, not a cut. The Roto Brush tool asks for
//                    its own name / mode / feather and names the masks the new
//                    one replaces (removed in the same entry); the summary's
//                    "mask" is the new mask's id.
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <future>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <thread>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

#include "child_job.hpp"
#include "job_worker.hpp"
#include "matte_refine.hpp"
#include "png_write.hpp"
#include "stabilize.hpp"
#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "json.hpp"
#include "media_input.hpp"
#include "os_ffi.hpp"
#include "sam_ort.hpp"
#include "sam_pipeline.hpp"
#include "sam2_track.hpp"
#include "sam_embed_cache.hpp"
#include "fxstate.hpp"
#include "subject_edit.hpp"
#include "subjects.hpp"
#include "vitmatte.hpp"
#include "timeline.hpp"
#include "values.hpp"
#if defined(PREMATION_JOBS_HAVE_SCENE)
#include "scene/image_decode.hpp"
#endif

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
using js::Json;

namespace {

/// samBundled.ts: the bundled pair's file names.
constexpr const char* kEncoderFile = "vision_encoder_quantized.onnx";
constexpr const char* kDecoderFile = "prompt_encoder_mask_decoder_quantized.onnx";
/// A float encoder for a GPU provider (PREMATION_SAM_GPU_DIR; none is shipped).
constexpr const char* kGpuEncoderFile = "vision_encoder.onnx";
constexpr const char* kNothingFound =
    "Could not find an object there — try a tighter box, or a click on the object itself.";

std::string mask_group_of(const api::CommandResult& r) {
  const std::optional<api::GroupList> g = result_payload<api::GroupList>(r);
  if (!g || g->groups.empty()) fail(ErrorCode::internal, "addMask returned no mask");
  return g->groups.front();
}

double num_or(const Json& o, std::string_view key, double fallback) {
  const Json& v = o.at(key);
  return v.is_number() && std::isfinite(v.num()) ? v.num() : fallback;
}

class ObjectMatteResult final : public JobResult {
 public:
  /// How the mask is written (the spec's maskName / maskMode / feather / replaceMasks).
  struct MaskOut {
    std::string name = "Object mask";
    api::MaskMode mode = api::MaskMode::none;
    double feather = 2;
    std::vector<std::string> replace;
  };

  ObjectMatteResult(std::string layer, api::BezierPath path, double iou, MaskOut out, std::string provider, bool cached,
                    std::optional<Json> timings)
      : layer_(std::move(layer)),
        path_(std::move(path)),
        iou_(iou),
        out_(std::move(out)),
        provider_(std::move(provider)),
        cached_(cached),
        timings_(std::move(timings)) {}

  [[nodiscard]] std::string summary_json() const override {
    Json s = Json::object();
    s.set("contourPoints", Json::number(static_cast<double>(path_.vertices.size() / 2)));
    s.set("engine", Json::string("onnx"));
    s.set("iou", Json::number(iou_));
    if (!provider_.empty()) s.set("provider", Json::string(provider_));
    s.set("embeddingCached", Json::boolean(cached_));
    // Per-stage ms in the model process (open, read, load, encode, decode, trace, total).
    if (timings_) s.set("timings", *timings_);
    if (!mask_.empty()) s.set("mask", Json::string(mask_));
    // The outline itself (layer-centred px, x y pairs): the Object Matte tool's
    // hover preview runs this job with apply: false and draws it, writing nothing.
    Json outline = Json::array();
    for (const double v : path_.vertices) outline.arr_mut().push_back(Json::number(v));
    s.set("outline", std::move(outline));
    return js::stringify(s);
  }
  [[nodiscard]] std::string label() const override { return "Object Mask"; }
  [[nodiscard]] bool has_edits() const override { return path_.vertices.size() >= 6; }

  void apply(JobApply& a) const override {
    if (!out_.replace.empty()) {
      api::RemovePropertyGroups drop;
      for (const std::string& id : out_.replace) drop.groups.push_back(api::PropRef{layer_, "masks/" + id});
      (void)a.run(command(std::move(drop)));
    }
    api::AddMask m;
    m.layer = layer_;
    m.path = path_;
    m.mode = out_.mode;
    m.name = out_.name;
    const std::string group = mask_group_of(a.run(command(std::move(m))));
    if (out_.feather != 0) {
      api::SetProperty feather;
      feather.prop = api::PropRef{layer_, group + "/feather"};
      feather.value = doc::v_scalar(out_.feather);
      (void)a.run(command(std::move(feather)));
    }
    // "masks/<id>" -> "<id>": what the summary names (the next re-segment's replaceMasks).
    const std::size_t slash = group.find('/');
    mask_ = slash == std::string::npos ? group : group.substr(slash + 1);
  }

 private:
  std::string layer_;
  api::BezierPath path_;
  double iou_;
  MaskOut out_;
  std::string provider_;
  bool cached_;
  std::optional<Json> timings_;
  // Set by apply (the summary is read after it): the new mask's id.
  mutable std::string mask_;
};

/// A subject edit (the spec's `edit`): the frame's matte stored and merged into the layer's
/// (setLayerMatte, merge), its outline kept as the "Object Matte" mask (mode none: the cut is
/// the matte's) — a key at the frame when that mask is animated, else its shape.
class SubjectEditResult final : public JobResult {
 public:
  SubjectEditResult(std::string layer, double compTime, std::string file, api::BezierPath outline, double coverage, bool cut,
                    std::vector<std::string> replace, std::string provider, std::optional<Json> timings, std::string subject)
      : layer_(std::move(layer)),
        compTime_(compTime),
        file_(std::move(file)),
        outline_(std::move(outline)),
        coverage_(coverage),
        cut_(cut),
        replace_(std::move(replace)),
        provider_(std::move(provider)),
        timings_(std::move(timings)),
        subject_(std::move(subject)) {}

  [[nodiscard]] std::string summary_json() const override {
    Json s = Json::object();
    s.set("file", Json::string(file_));
    s.set("coverage", Json::number(coverage_));
    if (!provider_.empty()) s.set("provider", Json::string(provider_));
    if (timings_) s.set("timings", *timings_);
    if (!mask_.empty()) s.set("mask", Json::string(mask_));
    Json outline = Json::array();
    for (const double v : outline_.vertices) outline.arr_mut().push_back(Json::number(v));
    s.set("outline", std::move(outline));
    return js::stringify(s);
  }
  [[nodiscard]] std::string label() const override { return "Subject"; }
  [[nodiscard]] bool has_edits() const override { return true; }

  void apply(JobApply& a) const override {
    if (!replace_.empty()) {
      api::RemovePropertyGroups drop;
      for (const std::string& id : replace_) drop.groups.push_back(api::PropRef{layer_, "masks/" + id});
      (void)a.run(command(std::move(drop)));
    }
    api::SetLayerMatte m;
    m.layer = layer_;
    m.merge = true;
    m.cut = cut_;
    m.subject = subject_;
    api::ContentAwareFillFrame fr;
    fr.time = flicks_of(compTime_);
    fr.src = file_;
    m.frames.push_back(std::move(fr));
    (void)a.run(command(std::move(m)));
    if (outline_.vertices.size() < 6) return;  // nothing selected now: the outline keeps its last shape
    const doc::Node* node = a.document().node(layer_);
    std::string group;
    if (node != nullptr) {
      const Json mask = doc::get_node_mask(*node);
      if (mask.at("paths").is_array())
        for (const Json& p : mask.at("paths").arr())
          if (p.at("id").is_string() && p.at("name").is_string() && p.at("name").str() == doc::subject_outline_name(subject_)) group = "masks/" + p.at("id").str();
    }
    if (group.empty()) {
      api::AddMask add;
      add.layer = layer_;
      add.path = outline_;
      add.mode = api::MaskMode::none;
      add.name = doc::subject_outline_name(subject_);
      group = mask_group_of(a.run(command(std::move(add))));
      // After Effects draws a selected subject's boundary in magenta.
      api::SetProperty colour;
      colour.prop = api::PropRef{layer_, group + "/color"};
      colour.value = doc::v_color(1.0, 0.25, 0.85, 1.0);
      (void)a.run(command(std::move(colour)));
    } else if (!doc::read_node_mask_anim(*node).empty()) {
      api::AddKeyframes keys;
      api::KeyframeInsert k;
      k.prop = api::PropRef{layer_, group + "/path"};
      k.time = flicks_of(compTime_);
      k.value = doc::v_path(outline_);
      keys.keys.push_back(std::move(k));
      (void)a.run(command(std::move(keys)));
    } else {
      api::SetProperty set;
      set.prop = api::PropRef{layer_, group + "/path"};
      set.value = doc::v_path(outline_);
      (void)a.run(command(std::move(set)));
    }
    const std::size_t slash = group.find('/');
    mask_ = slash == std::string::npos ? group : group.substr(slash + 1);
  }

 private:
  std::string layer_;
  double compTime_;
  std::string file_;
  api::BezierPath outline_;
  double coverage_;
  bool cut_;
  std::vector<std::string> replace_;
  std::string provider_;
  std::optional<Json> timings_;
  std::string subject_;
  mutable std::string mask_;
};

/// A result that only reports (Find Objects): nothing to apply.
class SummaryOnlyResult final : public JobResult {
 public:
  SummaryOnlyResult(std::string label, Json summary) : label_(std::move(label)), summary_(std::move(summary)) {}
  [[nodiscard]] std::string summary_json() const override { return js::stringify(summary_); }
  [[nodiscard]] std::string label() const override { return label_; }
  [[nodiscard]] bool has_edits() const override { return false; }
  void apply(JobApply& /*a*/) const override {}

 private:
  std::string label_;
  Json summary_;
};

/// The model file: the spec's, else `<dir>/<file>` (the user's or the bundled folder); '' when neither.
std::string model_path(const std::string& given, const std::optional<std::string>& dir, const char* file) {
  if (!given.empty()) return given;
  if (!dir || dir->empty()) return {};
  return (std::filesystem::path(*dir) / file).string();
}

using Clock = std::chrono::steady_clock;

double ms_since(Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); }

/// What the single-frame work keeps between calls in one process — the
/// long-lived worker (job_worker.hpp) answers every hover from here: the
/// models stay loaded, the last footage stays open, and the newest frames'
/// encoder outputs stay in memory (~8 MB each). A one-shot `--job` child
/// fills it once and exits.
struct Resident {
  static constexpr std::size_t kEmbeddings = 6;

  struct Emb {
    std::string key;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    sam::Embeddings emb;
  };
  std::mutex mu;  // the in-process fallback may run two at once; the worker runs one
  std::string modelKey;
  bool withEncoder = false;
  std::unique_ptr<sam::Models> models;
  std::list<Emb> embeddings;  // most recent first
  std::string sourceKey;
  std::unique_ptr<FrameSource> source;

  /// The entry for `key`, moved to the front; null when absent.
  const Emb* find(const std::string& key) {
    for (auto it = embeddings.begin(); it != embeddings.end(); ++it) {
      if (it->key != key) continue;
      embeddings.splice(embeddings.begin(), embeddings, it);
      return &embeddings.front();
    }
    return nullptr;
  }
  void put(Emb e) {
    embeddings.remove_if([&](const Emb& x) { return x.key == e.key; });
    embeddings.push_front(std::move(e));
    while (embeddings.size() > kEmbeddings) embeddings.pop_back();
  }
};

Resident& resident_state() {
  static Resident r;  // process-wide on purpose: the worker's warm state
  return r;
}

/// The file's identity for the open-source cache: its path, size and mtime ('' when it cannot be stat'ed).
std::string file_stamp(const std::string& file) {
  std::error_code ec;
  const std::filesystem::path p(std::u8string(file.begin(), file.end()));
  const auto t = std::filesystem::last_write_time(p, ec);
  if (ec) return {};
  const std::uintmax_t size = std::filesystem::file_size(p, ec);
  if (ec) return {};
  return file + "\n" + std::to_string(size) + "\n" + std::to_string(t.time_since_epoch().count());
}

/// The SlimSAM pair for these files, loaded once per process and reused while the files are
/// unchanged. A decoder-only load (a disk-cache hit in a fresh process) is replaced the first
/// time a frame needs encoding. `loadMs` gets the load's time (0 when reused).
sam::Models& resident_models(Resident& res, const std::string& enc, const std::string& encGpu, const std::string& dec, bool needEncoder,
                             JobControl& control, double& loadMs) {
  const std::string modelKey = enc + "\n" + encGpu + "\n" + dec + "\n" + file_stamp(enc) + "\n" + file_stamp(encGpu) + "\n" + file_stamp(dec);
  if (!res.models || res.modelKey != modelKey || (needEncoder && !res.withEncoder)) {
    control.progress(0.08, "Loading the Object Matte model");
    const auto tLoad = Clock::now();
    res.models.reset();
    std::string error;
    res.models = sam::load(enc, dec, error, /*withEncoder=*/needEncoder, encGpu);
    if (!res.models) {
      res.modelKey.clear();
      fail(sam::runtime_available() ? ErrorCode::io : ErrorCode::unsupported, "Object Matte model: " + error);
    }
    res.modelKey = modelKey;
    res.withEncoder = needEncoder;
    loadMs = ms_since(tLoad);
  }
  return *res.models;
}

/// Per-stage milliseconds of one call (the summary's `timings`).
struct Timings {
  double open = 0;
  double read = 0;
  double load = 0;
  double encode = 0;
  double decode = 0;
  double trace = 0;
};

/// The frame's stored matte (the cut-out PNG's alpha) at w×h; empty when there is none or it cannot be read.
std::vector<float> stored_matte(const std::string& file, int w, int h) {
  if (file.empty()) return {};
#if defined(PREMATION_JOBS_HAVE_SCENE)
  scene::DecodedImage d;
  std::string error;
  if (!scene::decode_image_file(std::filesystem::path(std::u8string(file.begin(), file.end())), d, error) || d.width == 0 || d.height == 0) return {};
  std::vector<float> a(static_cast<std::size_t>(d.width) * d.height);
  for (std::size_t i = 0; i < a.size(); ++i) a[i] = d.rgba[i * 4 + 3] / 255.0f;
  if (static_cast<int>(d.width) == w && static_cast<int>(d.height) == h) return a;
  return subject::resample(a, static_cast<int>(d.width), static_cast<int>(d.height), w, h);
#else
  (void)w;
  (void)h;
  return {};
#endif
}

/// ViTMatte, loaded once per process and kept while the file is the same (the worker answers every stroke).
vitmatte::Model* resident_vitmatte(const std::string& path, std::string& error) {
  static std::unique_ptr<vitmatte::Model> model;  // process-wide on purpose: the worker's warm state
  static std::string loaded;
  const std::string key = path + "\n" + file_stamp(path);
  if (!model || loaded != key) {
    model = vitmatte::load(path, error);
    loaded = model ? key : std::string();
  }
  return model.get();
}

/// Refine Edge with the learned matte: a trimap (sure subject = the matte, sure background =
/// outside it, unknown = the brush band) on the band's crop — at most 768 px on its long side —
/// through ViTMatte, blended into `base` by the band. Empty when the model failed (the
/// colour-based refine then runs).
std::vector<float> refine_band_learned(vitmatte::Model& model, const RgbaImage& img, std::span<const float> base, std::span<const float> band,
                                       std::string& error) {
  const int w = static_cast<int>(img.width);
  const int h = static_cast<int>(img.height);
  int bx0 = w;
  int by0 = h;
  int bx1 = -1;
  int by1 = -1;
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x)
      if (band[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)] > 0.0f) {
        bx0 = std::min(bx0, x);
        bx1 = std::max(bx1, x);
        by0 = std::min(by0, y);
        by1 = std::max(by1, y);
      }
  if (bx1 < 0) return {};
  // The band and a margin of sure pixels around it: the model reads the colours either side.
  const int margin = std::max(24, (bx1 - bx0 + by1 - by0) / 8);
  const int cx0 = std::max(0, bx0 - margin);
  const int cy0 = std::max(0, by0 - margin);
  const int cw = std::min(w - 1, bx1 + margin) - cx0 + 1;
  const int ch = std::min(h - 1, by1 + margin) - cy0 + 1;
  const double k = std::min(1.0, 768.0 / std::max(cw, ch));
  const int sw = std::max(1, static_cast<int>(std::lround(cw * k)));
  const int sh = std::max(1, static_cast<int>(std::lround(ch * k)));
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(sw) * static_cast<std::size_t>(sh) * 4);
  std::vector<float> tri(static_cast<std::size_t>(sw) * static_cast<std::size_t>(sh));
  for (int y = 0; y < sh; ++y)
    for (int x = 0; x < sw; ++x) {
      const int gx = std::min(w - 1, cx0 + static_cast<int>((x + 0.5) / k));
      const int gy = std::min(h - 1, cy0 + static_cast<int>((y + 0.5) / k));
      const std::size_t g = static_cast<std::size_t>(gy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(gx);
      const std::size_t l = static_cast<std::size_t>(y) * static_cast<std::size_t>(sw) + static_cast<std::size_t>(x);
      for (std::size_t c = 0; c < 4; ++c) rgba[l * 4 + c] = img.rgba[g * 4 + c];
      tri[l] = band[g] >= 0.5f ? 0.5f : base[g] >= 0.5f ? 1.0f : 0.0f;
    }
  int pw = 0;
  int ph = 0;
  const std::vector<float> input = vitmatte::prepare_input(rgba, tri, sw, sh, pw, ph);
  std::vector<float> alpha;
  if (!model.run(input, pw, ph, alpha, error)) return {};
  std::vector<float> out(base.begin(), base.end());
  const auto at = [&](int xx, int yy) {
    return static_cast<double>(alpha[static_cast<std::size_t>(yy) * static_cast<std::size_t>(pw) + static_cast<std::size_t>(xx)]);
  };
  for (int y = cy0; y < cy0 + ch; ++y)
    for (int x = cx0; x < cx0 + cw; ++x) {
      const std::size_t g = static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x);
      if (band[g] <= 0.0f) continue;
      // Bilinear from the scaled crop.
      const double sx = std::clamp((x - cx0 + 0.5) * k - 0.5, 0.0, static_cast<double>(sw - 1));
      const double sy = std::clamp((y - cy0 + 0.5) * k - 0.5, 0.0, static_cast<double>(sh - 1));
      const int x0 = static_cast<int>(sx);
      const int y0 = static_cast<int>(sy);
      const int x1 = std::min(sw - 1, x0 + 1);
      const int y1 = std::min(sh - 1, y0 + 1);
      const double fx = sx - x0;
      const double fy = sy - y0;
      const double a = (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
      out[g] = base[g] + (static_cast<float>(std::clamp(a, 0.0, 1.0)) - base[g]) * band[g];
    }
  return out;
}

/// A subject edit's tail: the frame's matte edited (segment / paint / refine × replace / add /
/// subtract), stored as the cut-out PNG (a new file each time: undo still names the old one),
/// and its outline. `delta` is the segmentation (the segment tool), else unused.
std::string subject_edit_finish(const Json& in, const Json& edit, const RgbaImage& img, const std::vector<std::vector<subject::Pt>>& strokes,
                                std::vector<float> delta, double kx, double ky, double layerW, double layerH, const std::string& provider,
                                const Timings& timings, Clock::time_point t0) {
  const auto tEdit = Clock::now();
  const int w = static_cast<int>(img.width);
  const int h = static_cast<int>(img.height);
  const std::size_t n = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  std::vector<float> base = stored_matte(edit.at("base").is_string() ? edit.at("base").str() : std::string(), w, h);
  if (base.size() != n) base.assign(n, 0.0f);
  const std::string tool = edit.at("tool").is_string() ? edit.at("tool").str() : "segment";
  const std::string opName = edit.at("op").is_string() ? edit.at("op").str() : "replace";
  const subject::Op op = opName == "add" ? subject::Op::add : opName == "subtract" ? subject::Op::subtract : subject::Op::replace;
  const double radius = std::max(0.5, num_or(edit, "radius", 10) * (kx + ky) / 2);
  std::vector<float> alpha;
  std::string matter;  // which refine ran (the summary says)
  if (tool == "refine") {
    if (strokes.empty()) fail(ErrorCode::invalid_argument, "Refine Edge: paint along the edge.");
    const std::vector<float> band = subject::paint(w, h, strokes, radius);
    // The learned matte when ViTMatte is installed; the colour-based refine otherwise (or when it fails).
    if (edit.at("vitmatte").is_string()) {
      std::string error;
      if (vitmatte::Model* m = resident_vitmatte(edit.at("vitmatte").str(), error); m != nullptr) {
        alpha = refine_band_learned(*m, img, base, band, error);
        if (!alpha.empty()) matter = "vitmatte";
      }
    }
    if (alpha.empty()) {
      alpha = subject::refine_band(img.rgba, w, h, base, band, radius);
      matter = "colour";
    }
  } else {
    if (tool == "paint") {
      if (strokes.empty()) fail(ErrorCode::invalid_argument, "Selection Brush: paint over the subject.");
      delta = subject::paint(w, h, strokes, radius);
    }
    if (delta.size() != n) fail(ErrorCode::internal, "subject edit: bad matte size");
    alpha = subject::combine(base, delta, op);
  }
  const double editMs = ms_since(tEdit);

  const std::string folder = edit.at("folder").is_string() ? edit.at("folder").str() : std::string();
  if (folder.empty()) fail(ErrorCode::invalid_argument, "subject edit: no folder");
  const std::filesystem::path dir(std::u8string(folder.begin(), folder.end()));
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  const auto tPng = Clock::now();
  std::vector<std::uint8_t> png;
  // Edge colours cleaned as a propagation cleans them (the Object Matte card's default 50 %): the
  // cut-out shown by Remove Background carries no wall colour in its soft edge.
  std::vector<std::uint8_t> colours = img.rgba;
  matte::decontaminate(colours, alpha, w, h, 0.5);
  if (!exporter::encode_png_rgba8(matte::cutout(colours, alpha, w, h), img.width, img.height, png, 1)) fail(ErrorCode::io, "could not encode the matte");
  std::string frameName = std::to_string(static_cast<long long>(std::llround(num_or(edit, "compTime", 0) * num_or(edit, "compFps", 30))));
  if (frameName.size() < 6) frameName.insert(0, 6 - frameName.size(), '0');
  const auto stamp = static_cast<unsigned long long>(std::chrono::system_clock::now().time_since_epoch().count());
  const std::filesystem::path path = dir / ("subject_" + frameName + "_" + std::to_string(stamp) + ".png");
  {
    std::filesystem::path tmp = path;
    tmp += ".tmp";
    {
      std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
      f.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
      if (!f) fail(ErrorCode::io, "cannot write the matte next to the project");
    }
    std::filesystem::rename(tmp, path, ec);
    if (ec) fail(ErrorCode::io, "cannot write the matte: " + ec.message());
  }
  const double pngMs = ms_since(tPng);

  std::vector<std::uint8_t> bin(n);
  std::size_t on = 0;
  for (std::size_t i = 0; i < n; ++i) {
    bin[i] = alpha[i] >= 0.5f ? 255 : 0;
    on += bin[i] != 0 ? 1 : 0;
  }
  const std::vector<trace::TracePoint> contour = on > 0 ? sam::matte_contour(bin, img.width, img.height, 128) : std::vector<trace::TracePoint>{};
  Json o = Json::object();
  o.set("width", Json::number(img.width));
  o.set("height", Json::number(img.height));
  o.set("layerWidth", Json::number(layerW));
  o.set("layerHeight", Json::number(layerH));
  if (!provider.empty()) o.set("provider", Json::string(provider));
  const std::u8string u = path.u8string();
  o.set("file", Json::string(std::string(u.begin(), u.end())));
  o.set("coverage", Json::number(static_cast<double>(on) / static_cast<double>(std::max<std::size_t>(1, n))));
  Json pts = Json::array();
  for (const trace::TracePoint& p : contour) {
    pts.arr_mut().push_back(Json::number(p.x));
    pts.arr_mut().push_back(Json::number(p.y));
  }
  o.set("contour", std::move(pts));
  Json tj = Json::object();
  tj.set("open", Json::number(timings.open));
  tj.set("read", Json::number(timings.read));
  tj.set("load", Json::number(timings.load));
  tj.set("encode", Json::number(timings.encode));
  tj.set("decode", Json::number(timings.decode));
  tj.set("edit", Json::number(editMs));
  if (!matter.empty()) tj.set("refine", Json::string(matter));
  tj.set("png", Json::number(pngMs));
  tj.set("total", Json::number(ms_since(t0)));
  o.set("timings", std::move(tj));
  (void)in;
  return js::stringify(o);
}

/// The child: frame → SAM → contour JSON.
std::string object_matte_child(const std::string& inputJson, JobControl& control) {
  const auto t0 = Clock::now();
  Timings timings;
  const std::optional<Json> in = js::parse(inputJson);
  if (!in || !in->is_object() || !in->at("file").is_string()) fail(ErrorCode::invalid_argument, "objectMatte: bad input");
  const std::string file = in->at("file").str();
  const std::lock_guard<std::mutex> residentLock(resident_state().mu);
  Resident* resident = &resident_state();

  std::string error;
  control.progress(0.02, "Reading the frame");
  // The footage stays open between calls while the file is unchanged (a seek, not an open, per hover).
  const std::string stamp = file_stamp(file);
  if (!resident->source || stamp.empty() || stamp != resident->sourceKey) {
    resident->source.reset();
    resident->source = open_frames(file, 0, error);
    resident->sourceKey = resident->source ? stamp : std::string();
  }
  FrameSource* src = resident->source.get();
  if (src == nullptr) fail(ErrorCode::decode, "cannot read '" + file + "': " + error);
  // The frame containing the source time (+1 µs, objectMask.ts frameIndexAt), clamped into the stream.
  const double srcSec = num_or(*in, "sourceSeconds", 0);
  const double fps = src->fps() > 0 ? src->fps() : 30.0;
  const std::int64_t count = std::max<std::int64_t>(1, src->frame_count());
  const double fi = std::floor((std::max(0.0, srcSec) + 1e-6) * fps);
  const std::int64_t frame = std::clamp<std::int64_t>(static_cast<std::int64_t>(std::min(fi, 9.0e15)), 0, count - 1);
  const std::string enc = in->at("encoder").is_string() ? in->at("encoder").str() : std::string();
  const std::string dec = in->at("decoder").is_string() ? in->at("decoder").str() : std::string();
  // The float encoder for a GPU provider ('' = none): used when a GPU opens it, else `enc` on the CPU.
  const std::string encGpu = in->at("encoderGpu").is_string() ? in->at("encoderGpu").str() : std::string();
  const std::string encKey = encGpu.empty() ? enc : encGpu;
  Resident& res = *resident;
  timings.open = ms_since(t0);

  // Hover-to-preview asks the same frame again: the encoder's output for
  // (file, mtime, frame, model) is kept in this process (the long-lived
  // worker, job_worker.hpp) and on disk (sam_embed_cache.hpp, for a fresh
  // process), so a second prompt skips the decode and the encoder both.
  const std::string cacheDir = in->at("embeddingCache").is_string() ? in->at("embeddingCache").str() : std::string();
  const std::string cacheKey = sam::embedding_key(file, frame, encKey);
  std::optional<sam::CachedEmbedding> cached;
  const Resident::Emb* hot = cacheKey.empty() ? nullptr : res.find(cacheKey);
  if (hot == nullptr && !cacheDir.empty() && !cacheKey.empty()) cached = sam::read_embedding(cacheDir, cacheKey);
  // A subject edit (the spec's `edit`) needs the picture itself: the edge snap, the band's colours, the stored cut-out.
  const Json& editIn = in->at("edit");
  const bool editing = editIn.is_object();
  RgbaImage img;
  const auto tRead = Clock::now();
  if (hot != nullptr && !editing) {
    img.width = hot->width;
    img.height = hot->height;
  } else if (cached && !editing) {
    img.width = cached->width;
    img.height = cached->height;
  } else {
    if (!src->read(frame, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(frame) + ": " + error);
    if (img.empty()) fail(ErrorCode::decode, "frame " + std::to_string(frame) + " is empty");
  }
  timings.read = ms_since(tRead);

  // Prompts arrive in LAYER px; the decoded plane is frame px.
  const double layerW = num_or(*in, "layerWidth", 0) > 0 ? num_or(*in, "layerWidth", 0) : src->source_width();
  const double layerH = num_or(*in, "layerHeight", 0) > 0 ? num_or(*in, "layerHeight", 0) : src->source_height();
  const double kx = img.width / layerW;
  const double ky = img.height / layerH;
  std::vector<sam::Point> points;
  if (in->at("points").is_array()) {
    for (const Json& p : in->at("points").arr()) {
      if (!p.is_array() || p.arr().size() < 3) continue;
      points.push_back({p.arr()[0].num() * kx, p.arr()[1].num() * ky, p.arr()[2].num() == 1 ? 1 : 0});
    }
  }
  std::optional<sam::Box> box;
  if (in->at("box").is_array() && in->at("box").arr().size() == 4) {
    const Json::Array& b = in->at("box").arr();
    box = sam::Box{b[0].num() * kx, b[1].num() * ky, b[2].num() * kx, b[3].num() * ky};
  }
  // The edit's brush strokes, in frame px.
  std::vector<std::vector<subject::Pt>> strokes;
  if (editing && editIn.at("strokes").is_array()) {
    for (const Json& st : editIn.at("strokes").arr()) {
      std::vector<subject::Pt> s;
      if (st.is_array())
        for (const Json& p : st.arr())
          if (p.is_array() && p.arr().size() >= 2) s.push_back({p.arr()[0].num() * kx, p.arr()[1].num() * ky});
      if (!s.empty()) strokes.push_back(std::move(s));
    }
  }
  const std::string tool = editing && editIn.at("tool").is_string() ? editIn.at("tool").str() : "segment";
  if (editing && tool != "segment") return subject_edit_finish(*in, editIn, img, strokes, {}, kx, ky, layerW, layerH, "", timings, t0);
  if (editing) {
    // Quick Selection: each stroke as the few prompts SAM was trained on (≤ 5 a stroke, 10 in all).
    std::size_t budget = 10;
    for (const std::vector<subject::Pt>& s : strokes) {
      for (const subject::Pt& p : subject::sample_stroke(s, std::min<std::size_t>(5, budget))) points.push_back({p.x, p.y, 1});
      budget = points.size() >= 10 ? 0 : 10 - points.size();
      if (budget == 0) break;
    }
  }
  const sam::Letterbox lb = sam::letterbox(img.width, img.height);
  // Every object of the frame (the tool's hover lights them all): grid clicks, no prompt of the user's.
  const bool proposing = in->at("proposals").is_bool() && in->at("proposals").b();
  const std::optional<sam::Prompts> prompts = sam::prompts_for(points, box, lb.scale);
  if (!prompts && !proposing) fail(ErrorCode::invalid_argument, "Nothing to segment — click the object or drag a box around it.");

  if (control.cancelled()) return "{}";
  // The models stay loaded while the files are the same; a decoder-only load
  // (a cache hit in a fresh process) is replaced the first time a frame needs encoding.
  const bool needEncoder = hot == nullptr && !cached;
  sam::Models& models = resident_models(res, enc, encGpu, dec, needEncoder, control, timings.load);

  if (control.cancelled()) return "{}";
  sam::Embeddings fresh;
  const sam::Embeddings* emb = nullptr;
  if (hot != nullptr) {
    emb = &hot->emb;
  } else if (cached) {
    fresh.image = sam::Tensor{std::move(cached->image.data), std::move(cached->image.shape)};
    fresh.positional = sam::Tensor{std::move(cached->positional.data), std::move(cached->positional.shape)};
    emb = &fresh;
  } else {
    control.progress(0.2, "Encoding the frame");
    const auto tEnc = Clock::now();
    const std::vector<float> pixels = sam::preprocess(img.rgba, img.width, img.height);
    if (!models.encode(pixels, fresh, error)) fail(ErrorCode::internal, "SAM encoder: " + error);
    timings.encode = ms_since(tEnc);
    if (!cacheKey.empty() && !cacheDir.empty()) {
      sam::CachedEmbedding e;
      e.width = img.width;
      e.height = img.height;
      e.image = sam::CachedTensor{fresh.image.data, fresh.image.shape};
      e.positional = sam::CachedTensor{fresh.positional.data, fresh.positional.shape};
      (void)sam::write_embedding(cacheDir, cacheKey, e);  // a cache that cannot be written only costs the next call time
    }
    emb = &fresh;
  }
  if (!cacheKey.empty() && hot == nullptr) {
    Resident::Emb e;
    e.key = cacheKey;
    e.width = img.width;
    e.height = img.height;
    e.emb = std::move(fresh);
    res.put(std::move(e));
    emb = &res.embeddings.front().emb;
  }

  if (control.cancelled()) return "{}";
  if (proposing) {
    control.progress(0.6, "Finding the objects");
    const auto tFind = Clock::now();
    const std::vector<subject::Pt> all = subject::proposal_grid(img.width, img.height, 14);
    // A click is asked only where nothing found so far already lies (the wall a click found covers
    // the next twenty grid points): most of the grid never reaches the decoder.
    constexpr std::size_t kPlaneF = static_cast<std::size_t>(sam::kMaskSize) * sam::kMaskSize;
    std::vector<std::uint8_t> covered(kPlaneF, 0);
    std::vector<subject::Pt> grid;
    sam::Decoded allOut;
    subject::Intent lone;
    lone.loneClick = true;
    const auto cell = [&](double v) { return static_cast<std::size_t>(std::clamp(std::lround(v * lb.scale / 4.0), 0L, static_cast<long>(sam::kMaskSize - 1))); };
    for (const subject::Pt& p : all) {
      if (control.cancelled()) return "{}";
      if (covered[cell(p.y) * sam::kMaskSize + cell(p.x)] != 0) continue;
      const std::array<sam::Point, 1> click{sam::Point{p.x, p.y, 1}};
      const std::optional<sam::Prompts> pr = sam::prompts_for(click, std::nullopt, lb.scale);
      sam::Decoded one;
      if (!pr || !models.decode(*emb, *pr, one, error)) fail(ErrorCode::internal, "SAM decoder: " + error);
      if (one.predMasks.data.size() < 3 * kPlaneF || one.iouScores.data.size() < 3) continue;
      const std::size_t k = subject::choose_candidate(one.iouScores.data, one.predMasks.data, click, lb.scale, lone, img.width, img.height);
      for (std::size_t i = 0; i < kPlaneF; ++i) covered[i] |= one.predMasks.data[k * kPlaneF + i] > 0.0f ? 1 : 0;
      grid.push_back(p);
      allOut.iouScores.data.insert(allOut.iouScores.data.end(), one.iouScores.data.begin(), one.iouScores.data.begin() + 3);
      allOut.predMasks.data.insert(allOut.predMasks.data.end(), one.predMasks.data.begin(), one.predMasks.data.begin() + 3 * kPlaneF);
    }
    const double findMs = ms_since(tFind);
    const std::vector<subject::Proposal> found =
        subject::select_proposals(allOut.iouScores.data, allOut.predMasks.data, grid, lb.scale, img.width, img.height, 24);
    // Each object's outline, traced at up to 512 px on the long side (a highlight, not a matte).
    const double fit = std::min(1.0, 512.0 / static_cast<double>(std::max(img.width, img.height)));
    const auto mw = std::max<std::uint32_t>(1, static_cast<std::uint32_t>(std::lround(img.width * fit)));
    const auto mh = std::max<std::uint32_t>(1, static_cast<std::uint32_t>(std::lround(img.height * fit)));
    constexpr std::size_t kPlaneP = static_cast<std::size_t>(sam::kMaskSize) * sam::kMaskSize;
    Json objects = Json::array();
    for (const subject::Proposal& p : found) {
      const std::vector<std::uint8_t> mask =
          sam::upsample_mask(allOut.predMasks.data, (p.point * 3 + p.candidate) * kPlaneP, mw, mh, sam::letterbox(mw, mh).scale);
      const std::vector<trace::TracePoint> contour = sam::matte_contour(mask, mw, mh, 96);
      if (contour.size() < 3) continue;
      Json o = Json::object();
      Json c = Json::array();
      for (const trace::TracePoint& tp : contour) {
        c.arr_mut().push_back(Json::number(tp.x * img.width / mw));
        c.arr_mut().push_back(Json::number(tp.y * img.height / mh));
      }
      o.set("contour", std::move(c));
      Json seed = Json::array();
      seed.arr_mut() = {Json::number(grid[p.point].x), Json::number(grid[p.point].y)};
      o.set("seed", std::move(seed));
      o.set("iou", Json::number(p.iou));
      o.set("area", Json::number(p.area));
      objects.arr_mut().push_back(std::move(o));
    }
    Json r = Json::object();
    r.set("width", Json::number(img.width));
    r.set("height", Json::number(img.height));
    r.set("layerWidth", Json::number(layerW));
    r.set("layerHeight", Json::number(layerH));
    r.set("provider", Json::string(models.provider()));
    r.set("objects", std::move(objects));
    Json tj = Json::object();
    tj.set("encode", Json::number(timings.encode));
    tj.set("decode", Json::number(findMs));
    tj.set("points", Json::number(static_cast<double>(grid.size())));
    tj.set("total", Json::number(ms_since(t0)));
    r.set("timings", std::move(tj));
    return js::stringify(r);
  }
  control.progress(0.8, "Segmenting");
  const auto tDec = Clock::now();
  sam::Decoded out;
  if (!models.decode(*emb, *prompts, out, error)) fail(ErrorCode::internal, "SAM decoder: " + error);
  timings.decode = ms_since(tDec);
  // Which of the three candidates the prompts mean (a lone click: the whole object under it).
  subject::Intent intent;
  intent.loneClick = !box && strokes.empty() && points.size() == 1;
  intent.subtract = editing && editIn.at("op").is_string() && editIn.at("op").str() == "subtract";
  const std::size_t pick = subject::choose_candidate(out.iouScores.data, out.predMasks.data, points, lb.scale, intent, img.width, img.height);
  // What the choice saw, reported with the timings (Object Matte's "why this one").
  Json cands = Json::array();
  for (const subject::CandidateScore& q : subject::score_candidates(out.iouScores.data, out.predMasks.data, points, lb.scale, img.width, img.height)) {
    Json cj = Json::object();
    cj.set("iou", Json::number(q.iou));
    cj.set("cover", Json::number(q.fgCover));
    cj.set("area", Json::number(q.area));
    cj.set("border", Json::number(q.border));
    cands.arr_mut().push_back(std::move(cj));
  }
  if (editing) {
    const std::size_t plane = static_cast<std::size_t>(sam::kMaskSize) * sam::kMaskSize;
    if (out.predMasks.data.size() < (pick + 1) * plane) fail(ErrorCode::internal, "SAM decoder: unexpected output shapes");
    std::vector<float> soft = matte::soft_mask(out.predMasks.data, pick * plane, img.width, img.height, lb.scale);
    const int w = static_cast<int>(img.width);
    const int h = static_cast<int>(img.height);
    if (box) {
      std::vector<std::uint8_t> keepBox(soft.size(), 255);
      sam::constrain_to_box(keepBox, img.width, img.height, *box);
      for (std::size_t i = 0; i < soft.size(); ++i) soft[i] *= keepBox[i] / 255.0f;
    }
    // The low-res edge snapped onto the picture's own edges (a cell of the 256² logits is ~4 px of a 1080p frame).
    const int snap = std::clamp(static_cast<int>(std::lround(std::max(w, h) / 320.0)), 2, 12);
    soft = matte::guided_filter(soft, matte::luma(img.rgba, w, h), w, h, snap, 2e-3);
    subject::solidify(soft);
    std::vector<subject::Pt> seeds;
    for (const sam::Point& p : points)
      if (p.label == 1) seeds.push_back({p.x, p.y});
    if (box) seeds.push_back({(box->x0 + box->x1) / 2, (box->y0 + box->y1) / 2});
    subject::keep_touching(soft, w, h, seeds, box);
    if (intent.subtract) subject::harden_for_subtract(soft, w, h, std::max(2, snap / 2));
    return subject_edit_finish(*in, editIn, img, strokes, std::move(soft), kx, ky, layerW, layerH, models.provider(), timings, t0);
  }
  const auto tTrace = Clock::now();
  // The outline (48 points at most) needs no more than 1024 px on the long side: the mask is
  // upsampled and traced at that size and the points scaled back (3.5x fewer pixels at 1080p,
  // half the warm hover's time went here).
  const double fit = std::min(1.0, 1024.0 / static_cast<double>(std::max(img.width, img.height)));
  const auto mw = std::max<std::uint32_t>(1, static_cast<std::uint32_t>(std::lround(img.width * fit)));
  const auto mh = std::max<std::uint32_t>(1, static_cast<std::uint32_t>(std::lround(img.height * fit)));
  const double sx = static_cast<double>(img.width) / mw;
  const double sy = static_cast<double>(img.height) / mh;
  std::optional<sam::Box> maskBox;
  if (box) maskBox = sam::Box{box->x0 / sx, box->y0 / sy, box->x1 / sx, box->y1 / sy};
  constexpr std::size_t kPlane = static_cast<std::size_t>(sam::kMaskSize) * sam::kMaskSize;
  if (out.predMasks.data.size() < (pick + 1) * kPlane) fail(ErrorCode::internal, "SAM decoder: unexpected output shapes");
  std::vector<std::uint8_t> mask = sam::upsample_mask(out.predMasks.data, pick * kPlane, mw, mh, sam::letterbox(mw, mh).scale);
  if (maskBox) sam::constrain_to_box(mask, mw, mh, *maskBox);

  control.progress(0.95, "Tracing the matte");
  // The hover's outline: the same candidate the click keeps, drawn with up to 128 points.
  std::vector<trace::TracePoint> contour = sam::matte_contour(mask, mw, mh, 128);
  for (trace::TracePoint& p : contour) {
    p.x *= sx;
    p.y *= sy;
  }
  if (contour.size() < 3) fail(ErrorCode::not_found, kNothingFound);
  timings.trace = ms_since(tTrace);

  Json o = Json::object();
  o.set("width", Json::number(img.width));
  o.set("height", Json::number(img.height));
  o.set("layerWidth", Json::number(layerW));
  o.set("layerHeight", Json::number(layerH));
  o.set("provider", Json::string(models.provider()));
  o.set("embeddingCached", Json::boolean(hot != nullptr || cached.has_value()));
  Json tj = Json::object();
  tj.set("open", Json::number(timings.open));
  tj.set("read", Json::number(timings.read));
  tj.set("load", Json::number(timings.load));
  tj.set("encode", Json::number(timings.encode));
  tj.set("decode", Json::number(timings.decode));
  tj.set("trace", Json::number(timings.trace));
  tj.set("total", Json::number(ms_since(t0)));
  tj.set("candidates", std::move(cands));
  tj.set("pick", Json::number(static_cast<double>(pick)));
  o.set("timings", std::move(tj));
  o.set("iou", Json::number(out.iouScores.data.size() > pick ? static_cast<double>(out.iouScores.data[pick]) : 0.0));
  Json pts = Json::array();
  for (const trace::TracePoint& p : contour) {
    pts.arr_mut().push_back(Json::number(p.x));
    pts.arr_mut().push_back(Json::number(p.y));
  }
  o.set("contour", std::move(pts));
  return js::stringify(o);
}

// ── video (AE parity 3.1 / 3.2) ─────────────────────────────────────────

struct VideoRefine {
  double edgeRadius = 0;
  double decontaminate = 0;
  bool motionBlur = false;
  double shutterAngle = 180;
  double feather = 0;
  double choke = 0;
  double reduceChatter = 0;
};

VideoRefine refine_of(const Json& j) {
  VideoRefine r;
  if (!j.is_object()) return r;
  r.edgeRadius = num_or(j, "edgeRadius", 0);
  r.decontaminate = num_or(j, "decontaminate", 0);
  r.motionBlur = j.at("motionBlur").is_bool() && j.at("motionBlur").b();
  r.shutterAngle = num_or(j, "shutterAngle", 180);
  r.feather = num_or(j, "feather", 0);
  r.choke = num_or(j, "choke", 0);
  r.reduceChatter = num_or(j, "reduceChatter", 0);
  return r;
}

std::vector<sam::Point> points_of(const Json& a, double kx, double ky) {
  std::vector<sam::Point> out;
  if (!a.is_array()) return out;
  for (const Json& p : a.arr()) {
    if (!p.is_array() || p.arr().size() < 3) continue;
    out.push_back({p.arr()[0].num() * kx, p.arr()[1].num() * ky, p.arr()[2].num() == 1 ? 1 : 0});
  }
  return out;
}

/// Where a walk's time goes, summed over its frames (the result's `stageMs`, per frame).
struct WalkStages {
  double read = 0;     // decode the footage frame
  double flow = 0;     // optical flow + carried prompts
  double encode = 0;   // the SAM image encoder (preprocess included)
  double decode = 0;   // the SAM prompt decoder
  double mask = 0;     // logits → soft matte, box constraint, chatter
  double refine = 0;   // guided filter, motion blur, choke / feather
  double cut = 0;      // decontaminate + cut-out
  double contour = 0;  // the outline
  double png = 0;      // PNG encode (on the writer thread)
  double write = 0;    // file write (on the writer thread)
  double wait = 0;     // the walk waiting for the writer (back-pressure, and the final flush)

  [[nodiscard]] Json per_frame(std::size_t frames) const {
    const double n = static_cast<double>(std::max<std::size_t>(1, frames));
    Json o = Json::object();
    o.set("read", Json::number(read / n));
    o.set("flow", Json::number(flow / n));
    o.set("encode", Json::number(encode / n));
    o.set("decode", Json::number(decode / n));
    o.set("mask", Json::number(mask / n));
    o.set("refine", Json::number(refine / n));
    o.set("cut", Json::number(cut / n));
    o.set("contour", Json::number(contour / n));
    o.set("png", Json::number(png / n));
    o.set("write", Json::number(write / n));
    o.set("wait", Json::number(wait / n));
    return o;
  }
};

/// The tail of every walked frame — refine, cut-out, outline, PNG encode and
/// write — runs on a thread of its own, so the next frame's model runs
/// meanwhile (at 2560×1440 that tail is ~0.6 s). The next frame needs only the
/// raw matte, never the refined one. At most two frames wait; finish() drains,
/// reports the first failure and hands back the frames' entries in order.
class FrameFinisher {
 public:
  explicit FrameFinisher(WalkStages& stages) : stages_(stages), thread_([this] { loop(); }) {}
  ~FrameFinisher() {
    {
      const std::lock_guard<std::mutex> lock(mu_);
      stop_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
  }
  FrameFinisher(const FrameFinisher&) = delete;
  FrameFinisher& operator=(const FrameFinisher&) = delete;
  FrameFinisher(FrameFinisher&&) = delete;
  FrameFinisher& operator=(FrameFinisher&&) = delete;

  /// Queue one frame's tail; it answers that frame's {t, file, contour}. Throws the first failure so far.
  void put(std::function<Json()> work) {
    const auto t0 = Clock::now();
    std::unique_lock<std::mutex> lk(mu_);
    cv_.wait(lk, [&] { return pending_.size() < 2 || !error_.empty(); });
    stages_.wait += ms_since(t0);
    if (!error_.empty()) fail(ErrorCode::io, error_);
    pending_.push_back(std::move(work));
    cv_.notify_all();
  }

  /// Every queued frame done: their entries in queue order.
  [[nodiscard]] Json finish() {
    const auto t0 = Clock::now();
    std::unique_lock<std::mutex> lk(mu_);
    cv_.wait(lk, [&] { return (pending_.empty() && !busy_) || !error_.empty(); });
    stages_.wait += ms_since(t0);
    if (!error_.empty()) fail(ErrorCode::io, error_);
    Json out = Json::array();
    for (Json& j : done_) out.arr_mut().push_back(std::move(j));
    done_.clear();
    return out;
  }

 private:
  void loop() {
    std::unique_lock<std::mutex> lk(mu_);
    for (;;) {
      cv_.wait(lk, [&] { return stop_ || !pending_.empty(); });
      if (pending_.empty()) return;  // stopping with nothing left
      std::function<Json()> work = std::move(pending_.front());
      pending_.pop_front();
      busy_ = true;
      lk.unlock();
      std::optional<Json> entry;
      std::string err;
      try {
        entry = work();
      } catch (const doc::EngineFail& f) {
        err = f.error.message;
      } catch (const std::exception& e) {
        err = e.what();
      }
      lk.lock();
      if (entry) done_.push_back(std::move(*entry));
      if (!err.empty() && error_.empty()) error_ = std::move(err);
      busy_ = false;
      cv_.notify_all();
    }
  }

  WalkStages& stages_;
  std::mutex mu_;
  std::condition_variable cv_;
  std::deque<std::function<Json()>> pending_;
  std::vector<Json> done_;
  bool busy_ = false;
  bool stop_ = false;
  std::string error_;
  std::thread thread_;  // last: it starts once everything above exists
};

/// The walk's flow runs on luma at half size (2×2 box): a quarter of the block search, and the
/// field (16 px cells in the frame) is only used to carry the matte and its prompts forward.
stabilize::FloatLuma walk_luma(const RgbaImage& img) {
  const int w = static_cast<int>(img.width);
  const int h = static_cast<int>(img.height);
  stabilize::FloatLuma out;
  out.w = std::max(1, w / 2);
  out.h = std::max(1, h / 2);
  out.data.assign(static_cast<std::size_t>(out.w) * static_cast<std::size_t>(out.h), 0.0f);
  for (int y = 0; y < out.h; ++y)
    for (int x = 0; x < out.w; ++x) {
      double s = 0;
      int n = 0;
      for (int dy = 0; dy < 2; ++dy)
        for (int dx = 0; dx < 2; ++dx) {
          const int sx = std::min(w - 1, x * 2 + dx);
          const int sy = std::min(h - 1, y * 2 + dy);
          const std::size_t i = (static_cast<std::size_t>(sy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(sx)) * 4;
          s += 0.299 * img.rgba[i] + 0.587 * img.rgba[i + 1] + 0.114 * img.rgba[i + 2];
          ++n;
        }
      out.data[static_cast<std::size_t>(y) * static_cast<std::size_t>(out.w) + static_cast<std::size_t>(x)] = static_cast<float>(s / n);
    }
  return out;
}

/// The flow between two walk_luma planes, in FRAME px (cells and vectors scaled back up by 2).
scene::pixmo::FlowField walk_flow(const stabilize::FloatLuma& prev, const stabilize::FloatLuma& cur) {
  scene::pixmo::FlowOptions fo;
  fo.step = 8;
  scene::pixmo::FlowField f = stabilize::compute_flow_f32(prev, cur, fo);
  f.step *= 2;
  for (float& v : f.dx) v *= 2.0f;
  for (float& v : f.dy) v *= 2.0f;
  return f;
}

/// One walked frame's matte: refined (edges, motion blur, choke / feather,
/// decontaminated colours), written as the cut-out PNG (zlib level 1, temp +
/// rename), and its outline in layer px — the child's {t, file, contour}
/// entry. Runs on the FrameFinisher's thread; it touches only the tail's
/// stages (refine, cut, contour, png, write).
Json store_matte_frame(const RgbaImage& img, const std::vector<float>& alpha, const scene::pixmo::FlowField* flow, const VideoRefine& rf,
                       const std::string& folder, double compTime, double compFps, double kx, double ky, WalkStages& stages) {
  const int w = static_cast<int>(img.width);
  const int h = static_cast<int>(img.height);
  auto t = Clock::now();
  std::vector<float> refined = alpha;
  subject::solidify(refined);  // no text behind a followed subject ghosts through it either
  if (rf.edgeRadius > 0) refined = matte::guided_filter(refined, matte::luma(img.rgba, w, h), w, h, static_cast<int>(std::lround(rf.edgeRadius)), 1e-3);
  if (rf.motionBlur && flow != nullptr) refined = matte::motion_blur(refined, *flow, w, h, rf.shutterAngle);
  matte::choke_feather(refined, w, h, rf.choke, rf.feather);
  stages.refine += ms_since(t);
  t = Clock::now();
  std::vector<std::uint8_t> colours = img.rgba;
  if (rf.decontaminate > 0) matte::decontaminate(colours, refined, w, h, rf.decontaminate);
  const std::vector<std::uint8_t> cut = matte::cutout(colours, refined, w, h);
  stages.cut += ms_since(t);
  t = Clock::now();
  std::vector<std::uint8_t> png;
  // zlib level 1: the frames are a cache the renderer reads back, not a deliverable (several times faster than 6).
  if (!exporter::encode_png_rgba8(cut, img.width, img.height, png, 1)) fail(ErrorCode::io, "could not encode a matte frame");
  stages.png += ms_since(t);
  t = Clock::now();
  std::string name = std::to_string(static_cast<long long>(std::llround(compTime * compFps)));
  if (name.size() < 6) name.insert(0, 6 - name.size(), '0');
  const std::filesystem::path path = std::filesystem::path(folder) / ("matte_" + name + ".png");
  {
    std::error_code ec;
    std::filesystem::path tmp = path;
    tmp += ".tmp";
    {
      std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
      f.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
      if (!f) fail(ErrorCode::io, "cannot write '" + tmp.string() + "'");
    }
    std::filesystem::rename(tmp, path, ec);
    if (ec) fail(ErrorCode::io, "cannot write '" + path.string() + "': " + ec.message());
  }
  stages.write += ms_since(t);
  t = Clock::now();
  std::vector<std::uint8_t> bin(refined.size());
  for (std::size_t i = 0; i < refined.size(); ++i) bin[i] = refined[i] >= 0.5f ? 255 : 0;
  const std::vector<trace::TracePoint> contour = sam::matte_contour(bin, img.width, img.height, 128);
  stages.contour += ms_since(t);
  Json fr = Json::object();
  fr.set("t", Json::number(compTime));
  fr.set("file", Json::string(path.string()));
  Json c = Json::array();
  for (const trace::TracePoint& p : contour) {
    c.arr_mut().push_back(Json::number(p.x / kx));
    c.arr_mut().push_back(Json::number(p.y / ky));
  }
  fr.set("contour", std::move(c));
  return fr;
}

/// The strokes whose time is this frame (half a comp frame either side).
template <typename Fn>
void strokes_at(const Json& strokes, double compTime, double compFps, Fn&& each) {
  if (!strokes.is_array()) return;
  for (const Json& st : strokes.arr()) {
    if (std::abs(num_or(st, "t", -1e9) - compTime) > 0.5 / std::max(1.0, compFps)) continue;
    each(st.at("points"));
  }
}

/// AE parity Step 3.1: the SAM 2.1 walk. The model carries the subject in its
/// memory bank (sam2_track.hpp) — no flow seeds, so it survives occlusion: a
/// frame where the model says the object is gone stores an empty matte and the
/// walk goes on. The user's click / box seeds the first frame of each walk, and
/// a correction stroke makes its frame a new conditioning frame.
std::string object_matte_video_sam2(const Json& in, JobControl& control) {
  std::string error;
  std::unique_ptr<FrameSource> src = open_frames(in.at("file").str(), 0, error);
  if (!src) fail(ErrorCode::decode, "cannot read '" + in.at("file").str() + "': " + error);
  control.progress(0.01, "Loading the SAM 2 model");
  const std::string dir = in.at("sam2").str();
  const std::optional<sam2::Constants> constants = sam2::load_constants(dir, error);
  if (!constants) fail(ErrorCode::io, "SAM 2 model: " + error);
  std::unique_ptr<sam2::Models> models = sam2::load(dir, error);
  WalkStages stages;
  FrameFinisher finisher(stages);
  if (!models) fail(sam::runtime_available() ? ErrorCode::io : ErrorCode::unsupported, "SAM 2 model: " + error);
  const double layerW = num_or(in, "layerWidth", 0) > 0 ? num_or(in, "layerWidth", 0) : src->source_width();
  const double layerH = num_or(in, "layerHeight", 0) > 0 ? num_or(in, "layerHeight", 0) : src->source_height();
  const double compFps = num_or(in, "fps", 30);
  const double srcFps = src->fps() > 0 ? src->fps() : 30.0;
  const std::int64_t count = std::max<std::int64_t>(1, src->frame_count());
  const VideoRefine rf = refine_of(in.at("refine"));
  const std::string folder = in.at("folder").str();
  std::error_code ec;
  std::filesystem::create_directories(folder, ec);
  if (ec) fail(ErrorCode::io, "cannot create '" + folder + "': " + ec.message());

  std::size_t total = 0;
  for (const Json& w : in.at("walks").arr()) total += w.arr().size();
  std::size_t done = 0;
  double modelMs = 0;
  Json frames = Json::array();
  std::string status = "completed";
  const bool needFlow = rf.motionBlur || rf.reduceChatter > 0;
  for (const Json& walk : in.at("walks").arr()) {
    sam2::Tracker tracker(*models, *constants, walk.arr().size());
    stabilize::FloatLuma prevLuma;
    std::vector<float> prevAlpha;
    for (const Json& step : walk.arr()) {
      if (control.cancelled()) return "{}";
      const double compTime = step.arr()[0].num();
      const double srcSec = step.arr()[1].num();
      const std::int64_t frame = std::clamp<std::int64_t>(static_cast<std::int64_t>(std::floor((std::max(0.0, srcSec) + 1e-6) * srcFps)), 0, count - 1);
      RgbaImage img;
      if (!src->read(frame, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(frame) + ": " + error);
      const int w = static_cast<int>(img.width);
      const int h = static_cast<int>(img.height);
      const double kx = w / layerW;
      const double ky = h / layerH;
      std::vector<sam2::Prompt> prompts;
      const auto addPoints = [&](const Json& a) {
        for (const sam::Point& p : points_of(a, kx, ky)) prompts.push_back({p.x, p.y, p.label});
      };
      // The user's own matte on the origin frame (a subject they selected and refined) starts the walk as it is.
      std::vector<float> given;
      if (tracker.steps() == 0 && in.at("originMatte").is_string()) {
        given = stored_matte(in.at("originMatte").str(), w, h);
        if (!given.empty()) {
          const matte::Seeds seeds = matte::seeds_from_matte(given, w, h);
          for (const sam::Point& p : seeds.points) prompts.push_back({p.x, p.y, p.label});
        }
      }
      if (tracker.steps() == 0 && given.empty()) {
        addPoints(in.at("points"));
        if (in.at("box").is_array() && in.at("box").arr().size() == 4) {
          // SAM 2's prompt encoder takes a box as its two corners, labels 2 and 3.
          const Json::Array& b = in.at("box").arr();
          prompts.push_back({std::min(b[0].num(), b[2].num()) * kx, std::min(b[1].num(), b[3].num()) * ky, 2});
          prompts.push_back({std::max(b[0].num(), b[2].num()) * kx, std::max(b[1].num(), b[3].num()) * ky, 3});
        }
        if (prompts.empty()) fail(ErrorCode::invalid_argument, "Nothing to segment — click the object or drag a box around it.");
      }
      if (given.empty()) strokes_at(in.at("strokes"), compTime, compFps, addPoints);
      sam2::FrameResult res;
      if (!tracker.step(img.rgba, img.width, img.height, prompts, res, error, given)) fail(ErrorCode::internal, "SAM 2: " + error);
      modelMs += res.encodeMs + res.attendMs + res.decodeMs + res.memoryMs;
      std::vector<float>& alpha = res.alpha;
      std::size_t area = 0;
      for (const float a : alpha) area += a >= 0.5f ? 1 : 0;
      if (area < 16 && tracker.steps() == 1) {
        status = "empty";
        break;
      }
      std::optional<scene::pixmo::FlowField> flow;
      stabilize::FloatLuma lum;
      if (needFlow) {
        lum = walk_luma(img);
        if (!prevAlpha.empty()) flow = walk_flow(prevLuma, lum);
      }
      if (flow && rf.reduceChatter > 0 && !res.conditioning) {
        // Chatter: where this frame and the carried matte nearly agree, settle between them.
        const std::vector<float> warped = matte::warp_by_flow(prevAlpha, *flow, w, h);
        const auto k = static_cast<float>(std::clamp(rf.reduceChatter, 0.0, 100.0) / 200.0);
        for (std::size_t i = 0; i < alpha.size(); ++i)
          if (std::abs(alpha[i] - warped[i]) < 0.5f) alpha[i] += k * (warped[i] - alpha[i]);
      }
      if (needFlow) {
        prevAlpha = alpha;
        prevLuma = std::move(lum);
      }
      // The tail (refine, cut-out, PNG, outline) runs on the finisher's thread while the next frame's model runs.
      finisher.put([&rf, &folder, &stages, img = std::move(img), alpha = std::move(alpha), flow = std::move(flow), compTime, compFps, kx, ky] {
        return store_matte_frame(img, alpha, flow ? &*flow : nullptr, rf, folder, compTime, compFps, kx, ky, stages);
      });
      ++done;
      control.progress(0.03 + 0.95 * static_cast<double>(done) / static_cast<double>(std::max<std::size_t>(1, total)),
                       "Object Matte (SAM 2), frame " + std::to_string(done) + " of " + std::to_string(total));
    }
    if (status != "completed") break;
  }
  frames = finisher.finish();  // every PNG on disk before the result names it
  Json o = Json::object();
  o.set("frames", std::move(frames));
  o.set("status", Json::string(status));
  o.set("layerWidth", Json::number(layerW));
  o.set("layerHeight", Json::number(layerH));
  o.set("model", Json::string("sam2.1-tiny"));
  o.set("provider", Json::string(models->provider()));
  o.set("msPerFrame", Json::number(done > 0 ? modelMs / static_cast<double>(done) : 0));
  o.set("stageMs", stages.per_frame(done));
  return js::stringify(o);
}

/// Input: {file, encoder, decoder, layerWidth, layerHeight, points, box?, strokes:[{t, points}], walks, fps, refine, folder}.
std::string object_matte_video_child(const std::string& inputJson, JobControl& control) {
  const std::optional<Json> in = js::parse(inputJson);
  if (!in || !in->is_object() || !in->at("file").is_string()) fail(ErrorCode::invalid_argument, "objectMatte video: bad input");
  if (in->at("sam2").is_string() && !in->at("sam2").str().empty()) return object_matte_video_sam2(*in, control);
  std::string error;
  std::unique_ptr<FrameSource> src = open_frames(in->at("file").str(), 0, error);
  if (!src) fail(ErrorCode::decode, "cannot read '" + in->at("file").str() + "': " + error);
  // The same resident pair the hover uses (the worker keeps it loaded between jobs), with the
  // float encoder on a GPU provider when there is one.
  const std::lock_guard<std::mutex> residentLock(resident_state().mu);
  double loadMs = 0;
  sam::Models& model = resident_models(resident_state(), in->at("encoder").str(),
                                       in->at("encoderGpu").is_string() ? in->at("encoderGpu").str() : std::string(),
                                       in->at("decoder").str(), /*needEncoder=*/true, control, loadMs);
  sam::Models* models = &model;
  WalkStages stages;
  FrameFinisher finisher(stages);
  const auto tWalk = Clock::now();
  const double layerW = num_or(*in, "layerWidth", 0) > 0 ? num_or(*in, "layerWidth", 0) : src->source_width();
  const double layerH = num_or(*in, "layerHeight", 0) > 0 ? num_or(*in, "layerHeight", 0) : src->source_height();
  const double compFps = num_or(*in, "fps", 30);
  const double srcFps = src->fps() > 0 ? src->fps() : 30.0;
  const std::int64_t count = std::max<std::int64_t>(1, src->frame_count());
  const VideoRefine rf = refine_of(in->at("refine"));
  const std::string folder = in->at("folder").str();
  std::error_code ec;
  std::filesystem::create_directories(folder, ec);
  if (ec) fail(ErrorCode::io, "cannot create '" + folder + "': " + ec.message());

  std::size_t total = 0;
  for (const Json& w : in->at("walks").arr()) total += w.arr().size();
  std::size_t done = 0;
  Json frames = Json::array();
  std::string status = "completed";
  for (const Json& walk : in->at("walks").arr()) {
    std::vector<float> prevAlpha;
    stabilize::FloatLuma prevLuma;
    bool first = true;
    for (const Json& step : walk.arr()) {
      if (control.cancelled()) return "{}";
      const double compTime = step.arr()[0].num();
      const double srcSec = step.arr()[1].num();
      const std::int64_t frame = std::clamp<std::int64_t>(static_cast<std::int64_t>(std::floor((std::max(0.0, srcSec) + 1e-6) * srcFps)), 0, count - 1);
      auto ts = Clock::now();
      RgbaImage img;
      if (!src->read(frame, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(frame) + ": " + error);
      stages.read += ms_since(ts);
      ts = Clock::now();
      const int w = static_cast<int>(img.width);
      const int h = static_cast<int>(img.height);
      const double kx = w / layerW;
      const double ky = h / layerH;
      const stabilize::FloatLuma lum = walk_luma(img);
      // The flow and the carried matte (the prompts) do not need the encoder's output: they
      // run on a thread of their own while the encoder runs, joined before the decoder.
      struct Carried {
        std::optional<scene::pixmo::FlowField> flow;
        std::vector<float> warped;
        matte::Seeds seeds;
      };
      std::future<Carried> carry;
      if (!first) {
        carry = std::async(std::launch::async, [&prevAlpha, &prevLuma, &lum, w, h] {
          Carried c;
          c.flow = walk_flow(prevLuma, lum);
          c.warped = matte::warp_by_flow(prevAlpha, *c.flow, w, h);
          c.seeds = matte::seeds_from_matte(c.warped, w, h);
          return c;
        });
      }
      const sam::Letterbox lb = sam::letterbox(img.width, img.height);
      stages.flow += ms_since(ts);
      ts = Clock::now();
      sam::Embeddings emb;
      const bool encoded = models->encode(sam::preprocess(img.rgba, img.width, img.height), emb, error);
      stages.encode += ms_since(ts);
      ts = Clock::now();
      Carried carried = carry.valid() ? carry.get() : Carried{};  // joined before anything can throw
      stages.flow += ms_since(ts);
      if (!encoded) fail(ErrorCode::internal, "SAM encoder: " + error);
      ts = Clock::now();
      std::optional<scene::pixmo::FlowField> flow = std::move(carried.flow);
      // Prompts: the user's on the first frame, else carried by the previous matte; strokes on this frame always.
      std::vector<sam::Point> pts;
      std::optional<sam::Box> box;
      std::vector<float> warped = std::move(carried.warped);
      std::vector<float> given;
      if (first && in->at("originMatte").is_string()) given = stored_matte(in->at("originMatte").str(), w, h);
      if (first && !given.empty()) {
        const matte::Seeds seeds = matte::seeds_from_matte(given, w, h);
        pts = seeds.points;
        box = seeds.box;
      } else if (first) {
        pts = points_of(in->at("points"), kx, ky);
        if (in->at("box").is_array() && in->at("box").arr().size() == 4) {
          const Json::Array& b = in->at("box").arr();
          box = sam::Box{b[0].num() * kx, b[1].num() * ky, b[2].num() * kx, b[3].num() * ky};
        }
      } else {
        if (carried.seeds.empty) {
          status = "lost";
          break;
        }
        pts = carried.seeds.points;
        box = carried.seeds.box;
      }
      strokes_at(in->at("strokes"), compTime, compFps, [&](const Json& a) {
        for (const sam::Point& p : points_of(a, kx, ky)) pts.push_back(p);
      });
      // A box with points: the points prompt, the box constrains (the decoder export takes points only).
      const std::optional<sam::Prompts> prompts = sam::prompts_for(pts, pts.empty() ? box : std::nullopt, lb.scale);
      if (!prompts) fail(ErrorCode::invalid_argument, "Nothing to segment — click the object or drag a box around it.");
      stages.flow += ms_since(ts);
      ts = Clock::now();
      sam::Decoded dec;
      if (!models->decode(emb, *prompts, dec, error)) fail(ErrorCode::internal, "SAM decoder: " + error);
      stages.decode += ms_since(ts);
      ts = Clock::now();
      const std::size_t plane = static_cast<std::size_t>(sam::kMaskSize) * sam::kMaskSize;
      const std::size_t best = sam::best_mask(dec.iouScores.data);
      std::vector<float> alpha = matte::soft_mask(dec.predMasks.data, best * plane, img.width, img.height, lb.scale);
      if (!given.empty()) {
        alpha = std::move(given);  // the origin frame is the user's matte
      } else if (box) {
        const double mx = std::abs(box->x1 - box->x0) * (first ? 0.08 : 0.15) + 4;
        const double my = std::abs(box->y1 - box->y0) * (first ? 0.08 : 0.15) + 4;
        for (int y = 0; y < h; ++y)
          for (int x = 0; x < w; ++x)
            if (x < std::min(box->x0, box->x1) - mx || x > std::max(box->x0, box->x1) + mx || y < std::min(box->y0, box->y1) - my ||
                y > std::max(box->y0, box->y1) + my) {
              alpha[static_cast<std::size_t>(y * w + x)] = 0;
            }
      }
      std::size_t area = 0;
      for (const float a : alpha) area += a >= 0.5f ? 1 : 0;
      if (area < 16) {
        status = first ? "empty" : "lost";
        break;
      }
      // Chatter: where this frame and the carried matte nearly agree, settle between them.
      if (!warped.empty() && rf.reduceChatter > 0) {
        const auto k = static_cast<float>(std::clamp(rf.reduceChatter, 0.0, 100.0) / 200.0);
        for (std::size_t i = 0; i < alpha.size(); ++i)
          if (std::abs(alpha[i] - warped[i]) < 0.5f) alpha[i] += k * (warped[i] - alpha[i]);
      }
      prevAlpha = alpha;
      prevLuma = lum;
      first = false;
      stages.mask += ms_since(ts);
      // The tail (refine, cut-out, PNG, outline) runs on the finisher's thread while the next frame's model runs.
      finisher.put([&rf, &folder, &stages, img = std::move(img), alpha = std::move(alpha), flow = std::move(flow), compTime, compFps, kx, ky] {
        return store_matte_frame(img, alpha, flow ? &*flow : nullptr, rf, folder, compTime, compFps, kx, ky, stages);
      });
      ++done;
      control.progress(0.03 + 0.95 * static_cast<double>(done) / static_cast<double>(std::max<std::size_t>(1, total)),
                       "Object Matte, frame " + std::to_string(done) + " of " + std::to_string(total));
    }
  }
  frames = finisher.finish();  // every PNG on disk before the result names it
  const double walkMs = ms_since(tWalk);
  Json o = Json::object();
  o.set("frames", std::move(frames));
  o.set("status", Json::string(status));
  o.set("layerWidth", Json::number(layerW));
  o.set("layerHeight", Json::number(layerH));
  o.set("model", Json::string("slimsam"));
  o.set("provider", Json::string(models->provider()));
  o.set("msPerFrame", Json::number(done > 0 ? walkMs / static_cast<double>(done) : 0));
  o.set("loadMs", Json::number(loadMs));
  o.set("stageMs", stages.per_frame(done));
  return js::stringify(o);
}

struct MatteFrame {
  double t = 0;
  std::string file;
  api::BezierPath path;
};

class ObjectMatteVideoResult final : public JobResult {
 public:
  /// Which model walked the range, on which execution provider, how fast.
  struct Run {
    std::string model;
    std::string provider;
    double msPerFrame = 0;
    std::optional<Json> stageMs;  // where a frame's time went (the model process's stageMs)
  };

  ObjectMatteVideoResult(std::string layer, std::vector<MatteFrame> frames, std::string status, bool storeMatte,
                         std::vector<std::string> replace, Run run, std::string subject)
      : layer_(std::move(layer)), frames_(std::move(frames)), status_(std::move(status)), storeMatte_(storeMatte), subject_(std::move(subject)),
        replace_(std::move(replace)), run_(std::move(run)) {}

  [[nodiscard]] std::string summary_json() const override {
    Json s = Json::object();
    s.set("frames", Json::number(static_cast<double>(frames_.size())));
    s.set("status", Json::string(status_));
    s.set("model", Json::string(run_.model));
    if (!run_.provider.empty()) s.set("provider", Json::string(run_.provider));
    if (run_.msPerFrame > 0) s.set("msPerFrame", Json::number(std::round(run_.msPerFrame)));
    if (run_.stageMs) s.set("stageMs", *run_.stageMs);
    if (!mask_.empty()) s.set("mask", Json::string(mask_));
    return js::stringify(s);
  }
  [[nodiscard]] std::string label() const override { return "Object Matte"; }
  [[nodiscard]] bool has_edits() const override { return !frames_.empty(); }

  void apply(JobApply& a) const override {
    if (frames_.empty()) return;
    // The new outline replaces the subject's old one (the one-frame edit's "Object Matte" mask) too.
    std::vector<std::string> drop = replace_;
    if (const doc::Node* node = a.document().node(layer_); node != nullptr) {
      const Json mask = doc::get_node_mask(*node);
      if (mask.at("paths").is_array())
        for (const Json& p : mask.at("paths").arr())
          if (p.at("id").is_string() && p.at("name").is_string() && p.at("name").str() == doc::subject_outline_name(subject_) &&
              std::ranges::find(drop, p.at("id").str()) == drop.end()) {
            drop.push_back(p.at("id").str());
          }
    }
    if (!drop.empty()) {
      api::RemovePropertyGroups rm;
      for (const std::string& id : drop) rm.groups.push_back(api::PropRef{layer_, "masks/" + id});
      (void)a.run(command(std::move(rm)));
    }
    if (storeMatte_) {
      api::SetLayerMatte m;
      m.layer = layer_;
      m.cut = false;  // the subject is a selection: a new Object Matte card starts off (Remove Background turns it on)
      m.subject = subject_;
      for (const MatteFrame& f : frames_) {
        api::ContentAwareFillFrame fr;
        fr.time = flicks_of(f.t);
        fr.src = f.file;
        m.frames.push_back(std::move(fr));
      }
      (void)a.run(command(std::move(m)));
    }
    const MatteFrame* firstWithPath = nullptr;
    for (const MatteFrame& f : frames_)
      if (f.path.vertices.size() >= 6) {
        firstWithPath = &f;
        break;
      }
    if (firstWithPath == nullptr) return;
    api::AddMask m;
    m.layer = layer_;
    m.path = firstWithPath->path;
    // The cut is the matte; the outline is for editing and Track mask (an Add mask would cut twice).
    m.mode = storeMatte_ ? api::MaskMode::none : api::MaskMode::add;
    m.name = doc::subject_outline_name(subject_);
    const std::string group = mask_group_of(a.run(command(std::move(m))));
    api::AddKeyframes keys;
    for (const MatteFrame& f : frames_) {
      if (f.path.vertices.size() < 6) continue;
      api::KeyframeInsert k;
      k.prop = api::PropRef{layer_, group + "/path"};
      k.time = flicks_of(f.t);
      k.value = doc::v_path(f.path);
      keys.keys.push_back(std::move(k));
    }
    (void)a.run(command(std::move(keys)));
    const std::size_t slash = group.find('/');
    mask_ = slash == std::string::npos ? group : group.substr(slash + 1);
  }

 private:
  std::string layer_;
  std::vector<MatteFrame> frames_;
  std::string status_;
  bool storeMatte_;
  std::string subject_;
  std::vector<std::string> replace_;
  Run run_;
  mutable std::string mask_;
};

}  // namespace

void register_object_matte_child() {
  register_child_work("objectMatte", object_matte_child);
  register_child_work("objectMatteVideo", object_matte_video_child);
}

PreparedJob prepare_object_matte(const api::ObjectMatteJob& spec, const JobDocContext& ctx) {
  const FootageLayer fl = footage_layer(ctx, spec.layer, Need::picture);

  // The model the user installed (Settings ▸ Object Matte, written by Electron
  // main into $PREMATION_SAM_USER_DIR) wins over the bundled pair
  // ($PREMATION_SAM_DIR) — read per job, so an install applies at once.
  std::optional<std::string> dir;
  if (spec.encoder_model.empty() || spec.decoder_model.empty()) {
    if (const std::optional<std::string> user = os::env_var("PREMATION_SAM_USER_DIR"); user && !user->empty()) {
      std::error_code ec;
      const std::filesystem::path u(*user);
      if (std::filesystem::is_regular_file(u / kEncoderFile, ec) && std::filesystem::is_regular_file(u / kDecoderFile, ec)) dir = user;
    }
    if (!dir) dir = os::env_var("PREMATION_SAM_DIR");
  }
  // AE parity 3.1: a walk (direction set) runs SAM 2.1 with its memory bank
  // when the user installed it ($PREMATION_SAM2_USER_DIR, Electron's
  // sam2Model.ts) — unless the spec names SlimSAM files, or
  // PREMATION_OBJECT_MATTE_MODEL=slimsam asks for the per-frame model.
  std::string sam2Dir;
  if (spec.direction && spec.encoder_model.empty() && spec.decoder_model.empty()) {
    const std::optional<std::string> pick = os::env_var("PREMATION_OBJECT_MATTE_MODEL");
    if (!pick || *pick != "slimsam") {
      if (const std::optional<std::string> s2 = os::env_var("PREMATION_SAM2_USER_DIR"); s2 && sam2::installed(*s2)) sam2Dir = *s2;
    }
  }
  const std::string encoder = model_path(spec.encoder_model, dir, kEncoderFile);
  const std::string decoder = model_path(spec.decoder_model, dir, kDecoderFile);
  if (sam2Dir.empty() && (encoder.empty() || decoder.empty())) {
    fail(ErrorCode::unsupported,
         "no Object Matte model: pass encoderModel / decoderModel, or set PREMATION_SAM_DIR to the folder holding " +
             std::string(kEncoderFile) + " and " + kDecoderFile);
  }
  for (const std::string* p : {&encoder, &decoder}) {
    if (!sam2Dir.empty()) break;  // the walk does not read the SlimSAM pair
    std::error_code ec;
    if (!std::filesystem::is_regular_file(std::filesystem::path(*p), ec)) {
      fail(ErrorCode::not_found, "Object Matte model '" + *p + "' does not exist");
    }
  }

  // Which of the layer's subjects this edit or walk reads and writes (core/subjects.hpp).
  const std::string subject = spec.subject.value_or(std::string(doc::kFirstSubject));
  if (subject.empty() || subject.size() > 32 ||
      !std::ranges::all_of(subject, [](char ch) { return std::isalnum(static_cast<unsigned char>(ch)) != 0 || ch == '-' || ch == '_'; })) {
    fail(ErrorCode::invalid_argument, "subject id takes 1–32 letters, digits, '-' or '_'", {.layer = spec.layer});
  }
  // A walk starts from the subject's stored matte on its origin frame when there is one (the
  // selection the user made and refined), not from the prompts again.
  // With no prompts at all the walk starts from the stored frame nearest the origin, and that frame becomes the origin
  // (the subject was selected on another frame than the playhead's: AE's base frame).
  std::string originMatte;
  std::optional<double> originSec;
  if (spec.direction) {
    if (const doc::Node* node = ctx.doc.node(fl.layer); node != nullptr) {
      const Json& am = node->fx().at("alphaMatte");
      if (am.is_object() && am.at("frames").is_array()) {
        const double fps = fl.compFps > 0 ? fl.compFps : 30;
        const doc::EditorView view{fl.comp, 0};
        const double ot = seconds_of(spec.origin.value_or(spec.range.start));
        const double kt = doc::comp_to_keyframe_time(ctx.doc, view, fl.layer, ot);
        const Json* nearest = nullptr;
        for (const Json& f : am.at("frames").arr()) {
          if (!f.at("t").is_number() || !f.at("src").is_string() || doc::frame_subject(f) != subject) continue;
          if (std::abs(f.at("t").num() - kt) < 0.5 / fps) originMatte = f.at("src").str();
          if (nearest == nullptr || std::abs(f.at("t").num() - kt) < std::abs(nearest->at("t").num() - kt)) nearest = &f;
        }
        if (originMatte.empty() && nearest != nullptr && spec.prompts.empty() && !spec.box) {
          originMatte = nearest->at("src").str();
          originSec = doc::keyframe_to_comp_time(ctx.doc, view, fl.layer, nearest->at("t").num());
        }
      }
    }
  }
  // objectMask.ts: a box wins over clicks.
  Json points = Json::array();
  Json input = Json::object();
  if (!originMatte.empty()) input.set("originMatte", Json::string(originMatte));
  if (spec.box) {
    const api::Rect& r = *spec.box;
    if (!std::isfinite(r.x) || !std::isfinite(r.y) || !std::isfinite(r.width) || !std::isfinite(r.height)) {
      fail(ErrorCode::invalid_argument, "box must be finite", {.layer = spec.layer});
    }
    Json b = Json::array();
    b.arr_mut() = {Json::number(r.x), Json::number(r.y), Json::number(r.x + r.width), Json::number(r.y + r.height)};
    input.set("box", std::move(b));
  }
  if (spec.edit && !spec.direction) {
    // A subject edit prompts from its strokes too (or paints / refines with them, no model at all).
    for (const std::vector<api::Vec2>* list : {&spec.prompts, &spec.background_prompts})
      for (const api::Vec2& p : *list) {
        if (!std::isfinite(p.x) || !std::isfinite(p.y)) fail(ErrorCode::invalid_argument, "prompt must be finite", {.layer = spec.layer});
        Json q = Json::array();
        q.arr_mut() = {Json::number(p.x), Json::number(p.y), Json::number(list == &spec.prompts ? 1 : 0)};
        points.arr_mut().push_back(std::move(q));
      }
    if (points.arr().empty() && spec.strokes.empty() && !spec.box) {
      fail(ErrorCode::invalid_argument, "Nothing to select — click the subject or paint over it.", {.layer = spec.layer});
    }
  } else if (!spec.box) {
    auto add = [&](const std::vector<api::Vec2>& list, int label) {
      for (const api::Vec2& p : list) {
        if (!std::isfinite(p.x) || !std::isfinite(p.y)) fail(ErrorCode::invalid_argument, "prompt must be finite", {.layer = spec.layer});
        Json q = Json::array();
        q.arr_mut() = {Json::number(p.x), Json::number(p.y), Json::number(label)};
        points.arr_mut().push_back(std::move(q));
      }
    };
    add(spec.prompts, 1);
    add(spec.background_prompts, 0);
    if (points.arr().empty() && originMatte.empty() && !spec.proposals.value_or(false)) {
      fail(ErrorCode::invalid_argument, "Nothing to segment — click the object or drag a box around it.",
           {.layer = spec.layer});
    }
  }
  input.set("file", Json::string(fl.file));
  input.set("sourceSeconds", Json::number(fl.source_seconds(seconds_of(spec.range.start))));
  // Prompts, outlines and masks live in the LAYER's box (layer/width × layer/height — what the
  // viewer's overlays and the mask paths use), which a resized footage layer no longer shares
  // with its picture (2160×3840 footage in a 607×1080 box); the picture is mapped onto it.
  {
    double boxW = fl.width;
    double boxH = fl.height;
    if (ctx.layerSize) {
      if (const std::optional<std::array<double, 2>> b = ctx.layerSize(fl.layer, seconds_of(spec.range.start)); b && (*b)[0] > 0 && (*b)[1] > 0) {
        boxW = (*b)[0];
        boxH = (*b)[1];
      }
    }
    input.set("layerWidth", Json::number(boxW));
    input.set("layerHeight", Json::number(boxH));
  }
  input.set("points", std::move(points));
  input.set("encoder", Json::string(encoder));
  input.set("decoder", Json::string(decoder));
  if (!spec.direction) {
    // The single-frame call's encoder cache (sam_embed_cache.hpp): the OS temp folder unless the host names one.
    std::string cache = os::env_var("PREMATION_SAM_CACHE_DIR").value_or("");
    if (cache.empty()) {
      std::error_code ec;
      const std::filesystem::path tmp = std::filesystem::temp_directory_path(ec);
      if (!ec) cache = (tmp / "premation-sam-embeddings").string();
    }
    if (!cache.empty()) input.set("embeddingCache", Json::string(cache));
  }
  {
    // A float SlimSAM encoder for a GPU provider, when PREMATION_SAM_GPU_DIR holds one: the
    // model process runs it when a GPU provider opens it, else the quantized one on the CPU.
    // Not shipped: on DirectML (RTX 4060 laptop, ORT 1.23) the float export ran 2.0 s and the
    // fp16 one 1.2-1.4 s a 1280x720 frame against 1.3-1.5 s for the quantized on the CPU
    // (tests/test_sam_gpu_encoder.cpp). Only with the bundled pair: a user's own SAM has its own encoder.
    const bool bundledPair = spec.encoder_model.empty() && spec.decoder_model.empty() && dir && dir == os::env_var("PREMATION_SAM_DIR");
    if (const std::optional<std::string> gpuDir = os::env_var("PREMATION_SAM_GPU_DIR"); bundledPair && gpuDir && !gpuDir->empty()) {
      std::error_code ec;
      const std::filesystem::path g = std::filesystem::path(std::u8string(gpuDir->begin(), gpuDir->end())) / kGpuEncoderFile;
      if (std::filesystem::is_regular_file(g, ec)) {
        const std::u8string u = g.u8string();
        input.set("encoderGpu", Json::string(std::string(u.begin(), u.end())));
      }
    }
  }

  if (spec.direction) {
    // AE parity 3.1 / 3.2: follow the subject through the range.
    const double fps = fl.compFps > 0 ? fl.compFps : 30;
    const auto first = static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start) * fps));
    const auto last = std::max(first, static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start + spec.range.duration) * fps)) - 1);
    const std::int64_t origin = originSec   ? std::clamp(static_cast<std::int64_t>(std::llround(*originSec * fps)), first, last)
                                : spec.origin ? std::clamp(static_cast<std::int64_t>(std::llround(seconds_of(*spec.origin) * fps)), first, last)
                                              : first;
    auto walk = [&](std::int64_t from, std::int64_t to) {
      Json steps = Json::array();
      const std::int64_t step = to >= from ? 1 : -1;
      for (std::int64_t f = from; step > 0 ? f <= to : f >= to; f += step) {
        const double t = static_cast<double>(f) / fps;
        if (t < fl.in_seconds() || t >= fl.out_seconds()) continue;
        Json s = Json::array();
        s.arr_mut() = {Json::number(t), Json::number(fl.source_seconds(t))};
        steps.arr_mut().push_back(std::move(s));
      }
      return steps;
    };
    Json walks = Json::array();
    if (*spec.direction != api::TrackDirection::backward) walks.arr_mut().push_back(walk(origin, last));
    if (*spec.direction != api::TrackDirection::forward && origin > first) walks.arr_mut().push_back(walk(origin, first));
    input.set("walks", std::move(walks));
    if (!sam2Dir.empty()) input.set("sam2", Json::string(sam2Dir));
    input.set("fps", Json::number(fps));
    Json strokes = Json::array();
    for (const api::ObjectMatteStroke& st : spec.strokes) {
      Json sj = Json::object();
      sj.set("t", Json::number(seconds_of(st.time)));
      Json pts = Json::array();
      for (const api::Vec2& p : st.points) {
        if (!std::isfinite(p.x) || !std::isfinite(p.y)) fail(ErrorCode::invalid_argument, "stroke points must be finite", {.layer = spec.layer});
        Json q = Json::array();
        q.arr_mut() = {Json::number(p.x), Json::number(p.y), Json::number(st.background ? 0 : 1)};
        pts.arr_mut().push_back(std::move(q));
      }
      sj.set("points", std::move(pts));
      strokes.arr_mut().push_back(std::move(sj));
    }
    input.set("strokes", std::move(strokes));
    Json refine = Json::object();
    if (spec.refine) {
      const api::MatteRefine& r = *spec.refine;
      refine.set("edgeRadius", Json::number(std::clamp(r.edge_radius, 0.0, 64.0)));
      refine.set("decontaminate", Json::number(std::clamp(r.decontaminate, 0.0, 1.0)));
      refine.set("motionBlur", Json::boolean(r.motion_blur));
      refine.set("shutterAngle", Json::number(r.shutter_angle > 0 ? r.shutter_angle : 180));
      refine.set("feather", Json::number(std::clamp(r.feather, 0.0, 100.0)));
      refine.set("choke", Json::number(std::clamp(r.choke, -100.0, 100.0)));
      refine.set("reduceChatter", Json::number(std::clamp(r.reduce_chatter, 0.0, 100.0)));
    }
    input.set("refine", std::move(refine));
    std::filesystem::path folder(spec.output_folder.value_or(""));
    if (folder.empty()) {
      const std::filesystem::path project(ctx.projectPath);
      folder = project.empty() ? std::filesystem::temp_directory_path() / "premation-object-matte" / spec.layer
                               : project.parent_path() / "Object Matte" / spec.layer;
    }
    if (subject != doc::kFirstSubject) folder /= subject;  // each subject's frames of its own (matte_<frame>.png)
    input.set("folder", Json::string(folder.string()));
    PreparedJob job;
    job.kind = "objectMatte";
    job.work = [layer = fl.layer, inputJson = js::stringify(input), store = spec.matte.value_or(true),
                replace = spec.replace_masks, subject](JobControl& control) -> std::unique_ptr<JobResult> {
      // The walk runs in the same model process as the hover (the pair stays loaded); a cancel kills it at once.
      WorkerCall walkCall;
      walkCall.killOnCancel = true;
      walkCall.timeout = std::chrono::minutes(3);  // a silence: every frame reports progress
      const std::optional<std::string> out = run_in_worker("objectMatteVideo", inputJson, control, walkCall);
      if (!out) return nullptr;
      const std::optional<Json> r = js::parse(*out);
      if (!r || !r->at("frames").is_array()) fail(ErrorCode::internal, "objectMatte: bad child result");
      const double lw = num_or(*r, "layerWidth", 0);
      const double lh = num_or(*r, "layerHeight", 0);
      std::map<double, MatteFrame> byTime;
      for (const Json& fr : r->at("frames").arr()) {
        MatteFrame f;
        f.t = fr.at("t").num();
        f.file = fr.at("file").str();
        f.path.closed = true;
        const Json::Array& c = fr.at("contour").arr();
        for (std::size_t i = 0; i + 1 < c.size(); i += 2) {
          f.path.vertices.push_back(c[i].num() - lw / 2);
          f.path.vertices.push_back(c[i + 1].num() - lh / 2);
        }
        f.path.in_tangents.assign(f.path.vertices.size(), 0.0);
        f.path.out_tangents.assign(f.path.vertices.size(), 0.0);
        byTime.insert_or_assign(f.t, std::move(f));
      }
      const std::string status = r->at("status").is_string() ? r->at("status").str() : "completed";
      if (byTime.empty()) fail(ErrorCode::not_found, kNothingFound, {.layer = layer});
      std::vector<MatteFrame> frames;
      for (auto& [t, f] : byTime) frames.push_back(std::move(f));
      ObjectMatteVideoResult::Run run;
      run.model = r->at("model").is_string() ? r->at("model").str() : "slimsam";
      run.provider = r->at("provider").is_string() ? r->at("provider").str() : "";
      run.msPerFrame = num_or(*r, "msPerFrame", 0);
      if (r->at("stageMs").is_object()) run.stageMs = r->at("stageMs");
      return std::make_unique<ObjectMatteVideoResult>(layer, std::move(frames), status, store, replace, std::move(run), subject);
    };
    return job;
  }

  if (spec.proposals.value_or(false) && !spec.direction) {
    input.set("proposals", Json::boolean(true));
    PreparedJob job;
    job.kind = "objectMatte";
    WorkerCall call;
    if (ctx.preview) {
      call.supersedeKey = "objectMatteProposals:" + fl.layer;
      call.generation = claim_generation(call.supersedeKey);  // a newer frame's search drops a queued older one
    }
    job.work = [layer = fl.layer, inputJson = js::stringify(input), call](JobControl& control) -> std::unique_ptr<JobResult> {
      const std::optional<std::string> out = run_in_worker("objectMatte", inputJson, control, call);
      if (!out) return nullptr;
      const std::optional<Json> r = js::parse(*out);
      if (!r || !r->is_object() || !r->at("objects").is_array()) fail(ErrorCode::internal, "objectMatte: bad child result");
      const double w = num_or(*r, "width", 0);
      const double h = num_or(*r, "height", 0);
      const double lw = num_or(*r, "layerWidth", 0);
      const double lh = num_or(*r, "layerHeight", 0);
      if (!(w > 0) || !(h > 0)) fail(ErrorCode::internal, "objectMatte: bad child result");
      // Frame px → layer-centred px, as the outline of a selection is.
      const auto lx = [&](double x) { return (x / w - 0.5) * lw; };
      const auto ly = [&](double y) { return (y / h - 0.5) * lh; };
      Json objects = Json::array();
      for (const Json& o : r->at("objects").arr()) {
        Json outline = Json::array();
        const Json::Array& c = o.at("contour").arr();
        for (std::size_t i = 0; i + 1 < c.size(); i += 2) {
          outline.arr_mut().push_back(Json::number(lx(c[i].num())));
          outline.arr_mut().push_back(Json::number(ly(c[i + 1].num())));
        }
        Json seed = Json::array();
        seed.arr_mut() = {Json::number(lx(o.at("seed").arr()[0].num())), Json::number(ly(o.at("seed").arr()[1].num()))};
        Json e = Json::object();
        e.set("outline", std::move(outline));
        e.set("seed", std::move(seed));
        e.set("iou", o.at("iou"));
        e.set("area", o.at("area"));
        objects.arr_mut().push_back(std::move(e));
      }
      Json summary = Json::object();
      summary.set("objects", std::move(objects));
      if (r->at("timings").is_object()) summary.set("timings", r->at("timings"));
      return std::make_unique<SummaryOnlyResult>("Find Objects", std::move(summary));
    };
    return job;
  }

  if (spec.edit) {
    const api::SubjectEdit& e = *spec.edit;
    const double t = seconds_of(spec.range.start);
    Json ej = Json::object();
    ej.set("tool", Json::string(e.tool == api::SubjectTool::paint ? "paint" : e.tool == api::SubjectTool::refine ? "refine" : "segment"));
    ej.set("op", Json::string(e.op == api::SubjectOp::add ? "add" : e.op == api::SubjectOp::subtract ? "subtract" : "replace"));
    if (!std::isfinite(e.radius) || e.radius < 0) fail(ErrorCode::invalid_argument, "radius must be >= 0", {.layer = spec.layer});
    ej.set("radius", Json::number(e.radius > 0 ? e.radius : 10));
    Json strokes = Json::array();
    for (const api::ObjectMatteStroke& st : spec.strokes) {
      Json pts = Json::array();
      for (const api::Vec2& p : st.points) {
        if (!std::isfinite(p.x) || !std::isfinite(p.y)) fail(ErrorCode::invalid_argument, "stroke points must be finite", {.layer = spec.layer});
        Json q = Json::array();
        q.arr_mut() = {Json::number(p.x), Json::number(p.y)};
        pts.arr_mut().push_back(std::move(q));
      }
      strokes.arr_mut().push_back(std::move(pts));
    }
    ej.set("strokes", std::move(strokes));
    // The frame's matte now — the stored frame the renderer shows at this time (the nearest one).
    if (const doc::Node* node = ctx.doc.node(fl.layer); node != nullptr) {
      const double kt = doc::comp_to_keyframe_time(ctx.doc, doc::EditorView{fl.comp, 0}, fl.layer, t);
      if (const Json* best = doc::nearest_subject_frame(node->fx().at("alphaMatte"), subject, kt); best != nullptr) ej.set("base", best->at("src"));
    }
    std::filesystem::path folder(spec.output_folder.value_or(""));
    if (folder.empty()) {
      const std::filesystem::path project(ctx.projectPath);
      folder = project.empty() ? std::filesystem::temp_directory_path() / "premation-object-matte" / spec.layer
                               : project.parent_path() / "Object Matte" / spec.layer;
    }
    const std::u8string fu = folder.u8string();
    ej.set("folder", Json::string(std::string(fu.begin(), fu.end())));
    ej.set("compTime", Json::number(t));
    // Refine Edge's learned matte (models.json `vitmatte`), when the user installed it.
    if (e.tool == api::SubjectTool::refine) {
      if (const std::optional<std::string> vd = os::env_var("PREMATION_VITMATTE_USER_DIR"); vd && !vd->empty()) {
        std::error_code vec;
        const std::filesystem::path vp = std::filesystem::path(std::u8string(vd->begin(), vd->end())) / vitmatte::kModelFile;
        if (std::filesystem::is_regular_file(vp, vec)) {
          const std::u8string u = vp.u8string();
          ej.set("vitmatte", Json::string(std::string(u.begin(), u.end())));
        }
      }
    }
    ej.set("compFps", Json::number(fl.compFps > 0 ? fl.compFps : 30));
    input.set("edit", std::move(ej));
    PreparedJob job;
    job.kind = "objectMatte";
    job.work = [layer = fl.layer, inputJson = js::stringify(input), t, cut = e.cut, replace = spec.replace_masks, subject](JobControl& control) -> std::unique_ptr<JobResult> {
      const std::optional<std::string> out = run_in_worker("objectMatte", inputJson, control, WorkerCall{});
      if (!out) return nullptr;
      const std::optional<Json> r = js::parse(*out);
      if (!r || !r->is_object() || !r->at("file").is_string() || !r->at("contour").is_array()) fail(ErrorCode::internal, "objectMatte: bad child result");
      const double w = num_or(*r, "width", 0);
      const double h = num_or(*r, "height", 0);
      const double lw = num_or(*r, "layerWidth", 0);
      const double lh = num_or(*r, "layerHeight", 0);
      if (!(w > 0) || !(h > 0)) fail(ErrorCode::internal, "objectMatte: bad child result");
      api::BezierPath path;
      path.closed = true;
      const Json::Array& c = r->at("contour").arr();
      for (std::size_t i = 0; i + 1 < c.size(); i += 2) {
        path.vertices.push_back((c[i].num() / w - 0.5) * lw);
        path.vertices.push_back((c[i + 1].num() / h - 0.5) * lh);
      }
      path.in_tangents.assign(path.vertices.size(), 0.0);
      path.out_tangents.assign(path.vertices.size(), 0.0);
      return std::make_unique<SubjectEditResult>(layer, t, r->at("file").str(), std::move(path), num_or(*r, "coverage", 0), cut, replace,
                                                 r->at("provider").is_string() ? r->at("provider").str() : std::string(),
                                                 r->at("timings").is_object() ? std::optional<Json>(r->at("timings")) : std::nullopt, subject);
    };
    return job;
  }

  ObjectMatteResult::MaskOut maskOut;
  if (spec.mask_name && !spec.mask_name->empty()) maskOut.name = *spec.mask_name;
  if (spec.mask_mode) maskOut.mode = *spec.mask_mode;
  if (spec.feather) {
    if (!std::isfinite(*spec.feather) || *spec.feather < 0) fail(ErrorCode::invalid_argument, "feather must be >= 0", {.layer = spec.layer});
    maskOut.feather = *spec.feather;
  }
  maskOut.replace = spec.replace_masks;

  PreparedJob job;
  job.kind = "objectMatte";
  // The long-lived model process answers single frames (job_worker.hpp): the model stays loaded and
  // the frame's encoder output stays in memory. Previews (apply: false — the tool's hover) of one
  // layer are latest-wins: a newer one drops an older one that has not been sent yet.
  WorkerCall call;
  if (ctx.preview) {
    call.supersedeKey = "objectMattePreview:" + fl.layer;
    call.generation = claim_generation(call.supersedeKey);  // at submission: a queued older preview is dropped too
  }
  job.work = [layer = fl.layer, inputJson = js::stringify(input), maskOut = std::move(maskOut), call](JobControl& control) -> std::unique_ptr<JobResult> {
    const std::optional<std::string> out = run_in_worker("objectMatte", inputJson, control, call);
    if (!out) return nullptr;
    const std::optional<Json> r = js::parse(*out);
    if (!r || !r->is_object() || !r->at("contour").is_array()) fail(ErrorCode::internal, "objectMatte: bad child result");
    const double w = num_or(*r, "width", 0);
    const double h = num_or(*r, "height", 0);
    const double lw = num_or(*r, "layerWidth", 0);
    const double lh = num_or(*r, "layerHeight", 0);
    if (!(w > 0) || !(h > 0)) fail(ErrorCode::internal, "objectMatte: bad child result");
    // objectMask.ts: frame px → layer-centred space, lx = (x / width − 0.5) · layer width.
    api::BezierPath path;
    path.closed = true;
    const Json::Array& c = r->at("contour").arr();
    for (std::size_t i = 0; i + 1 < c.size(); i += 2) {
      path.vertices.push_back((c[i].num() / w - 0.5) * lw);
      path.vertices.push_back((c[i + 1].num() / h - 0.5) * lh);
    }
    if (path.vertices.size() < 6) fail(ErrorCode::not_found, kNothingFound, {.layer = layer});
    path.in_tangents.assign(path.vertices.size(), 0.0);
    path.out_tangents.assign(path.vertices.size(), 0.0);
    return std::make_unique<ObjectMatteResult>(layer, std::move(path), num_or(*r, "iou", 0), maskOut,
                                               r->at("provider").is_string() ? r->at("provider").str() : std::string(),
                                               r->at("embeddingCached").is_bool() && r->at("embeddingCached").b(),
                                               r->at("timings").is_object() ? std::optional<Json>(r->at("timings")) : std::nullopt);
  };
  return job;
}

}  // namespace premation::jobs
