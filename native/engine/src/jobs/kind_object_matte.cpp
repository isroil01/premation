// Job kind `objectMatte` — one click (or a drawn box) on footage becomes a
// mask path: src/core/tracking/objectMask.ts `segmentObjectMask` with the
// neural path of samSegment.ts / samPipeline.ts (SlimSAM through ONNX
// Runtime).
//
//   prepare (core)   the layer's file, the source time under range.start, the
//                    prompts, the model files (the spec's, else
//                    $PREMATION_SAM_USER_DIR/… when the user installed a model there,
//                    else $PREMATION_SAM_DIR/{vision_encoder,prompt_encoder_mask_decoder}_quantized.onnx).
//   work (worker)    run_child("objectMatte", …): the model runs in a child
//                    engine process, so a runtime crash fails the job only.
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
//   apply (core)     addMask (mode none, "Object mask") + its feather 2 — the
//                    path objectMask.ts writes: geometry for Track mask and
//                    the path effects, not a cut. The Roto Brush tool asks for
//                    its own name / mode / feather and names the masks the new
//                    one replaces (removed in the same entry); the summary's
//                    "mask" is the new mask's id.
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <system_error>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

#include "child_job.hpp"
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
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
using js::Json;

namespace {

/// samBundled.ts: the bundled pair's file names.
constexpr const char* kEncoderFile = "vision_encoder_quantized.onnx";
constexpr const char* kDecoderFile = "prompt_encoder_mask_decoder_quantized.onnx";
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

  ObjectMatteResult(std::string layer, api::BezierPath path, double iou, MaskOut out)
      : layer_(std::move(layer)), path_(std::move(path)), iou_(iou), out_(std::move(out)) {}

  [[nodiscard]] std::string summary_json() const override {
    Json s = Json::object();
    s.set("contourPoints", Json::number(static_cast<double>(path_.vertices.size() / 2)));
    s.set("engine", Json::string("onnx"));
    s.set("iou", Json::number(iou_));
    if (!mask_.empty()) s.set("mask", Json::string(mask_));
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
  // Set by apply (the summary is read after it): the new mask's id.
  mutable std::string mask_;
};

/// The model file: the spec's, else `<dir>/<file>` (the user's or the bundled folder); '' when neither.
std::string model_path(const std::string& given, const std::optional<std::string>& dir, const char* file) {
  if (!given.empty()) return given;
  if (!dir || dir->empty()) return {};
  return (std::filesystem::path(*dir) / file).string();
}

/// The child: frame → SAM → contour JSON.
std::string object_matte_child(const std::string& inputJson, JobControl& control) {
  const std::optional<Json> in = js::parse(inputJson);
  if (!in || !in->is_object() || !in->at("file").is_string()) fail(ErrorCode::invalid_argument, "objectMatte: bad input");
  const std::string file = in->at("file").str();

  std::string error;
  control.progress(0.02, "Reading the frame");
  std::unique_ptr<FrameSource> src = open_frames(file, 0, error);
  if (!src) fail(ErrorCode::decode, "cannot read '" + file + "': " + error);
  // The frame containing the source time (+1 µs, objectMask.ts frameIndexAt), clamped into the stream.
  const double srcSec = num_or(*in, "sourceSeconds", 0);
  const double fps = src->fps() > 0 ? src->fps() : 30.0;
  const std::int64_t count = std::max<std::int64_t>(1, src->frame_count());
  const double fi = std::floor((std::max(0.0, srcSec) + 1e-6) * fps);
  const std::int64_t frame = std::clamp<std::int64_t>(static_cast<std::int64_t>(std::min(fi, 9.0e15)), 0, count - 1);
  RgbaImage img;
  if (!src->read(frame, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(frame) + ": " + error);
  if (img.empty()) fail(ErrorCode::decode, "frame " + std::to_string(frame) + " is empty");

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
  const sam::Letterbox lb = sam::letterbox(img.width, img.height);
  const std::optional<sam::Prompts> prompts = sam::prompts_for(points, box, lb.scale);
  if (!prompts) fail(ErrorCode::invalid_argument, "Nothing to segment — click the object or drag a box around it.");

  if (control.cancelled()) return "{}";
  control.progress(0.08, "Loading the Object Matte model");
  const std::string enc = in->at("encoder").is_string() ? in->at("encoder").str() : std::string();
  const std::string dec = in->at("decoder").is_string() ? in->at("decoder").str() : std::string();
  std::unique_ptr<sam::Models> models = sam::load(enc, dec, error);
  if (!models) {
    fail(sam::runtime_available() ? ErrorCode::io : ErrorCode::unsupported, "Object Matte model: " + error);
  }

  if (control.cancelled()) return "{}";
  control.progress(0.2, "Encoding the frame");
  const std::vector<float> pixels = sam::preprocess(img.rgba, img.width, img.height);
  sam::Embeddings emb;
  if (!models->encode(pixels, emb, error)) fail(ErrorCode::internal, "SAM encoder: " + error);

  if (control.cancelled()) return "{}";
  control.progress(0.8, "Segmenting");
  sam::Decoded out;
  if (!models->decode(emb, *prompts, out, error)) fail(ErrorCode::internal, "SAM decoder: " + error);
  const std::vector<std::uint8_t> mask =
      sam::mask_from_decoder(out.iouScores.data, out.predMasks.data, img.width, img.height, box);
  if (mask.empty()) fail(ErrorCode::internal, "SAM decoder: unexpected output shapes");

  control.progress(0.95, "Tracing the matte");
  const std::vector<trace::TracePoint> contour = sam::matte_contour(mask, img.width, img.height);
  if (contour.size() < 3) fail(ErrorCode::not_found, kNothingFound);

  Json o = Json::object();
  o.set("width", Json::number(img.width));
  o.set("height", Json::number(img.height));
  o.set("layerWidth", Json::number(layerW));
  o.set("layerHeight", Json::number(layerH));
  o.set("iou", Json::number(out.iouScores.data.empty()
                                ? 0.0
                                : static_cast<double>(out.iouScores.data[sam::best_mask(out.iouScores.data)])));
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

/// Input: {file, encoder, decoder, layerWidth, layerHeight, points, box?, strokes:[{t, points}], walks, fps, refine, folder}.
std::string object_matte_video_child(const std::string& inputJson, JobControl& control) {
  const std::optional<Json> in = js::parse(inputJson);
  if (!in || !in->is_object() || !in->at("file").is_string()) fail(ErrorCode::invalid_argument, "objectMatte video: bad input");
  std::string error;
  std::unique_ptr<FrameSource> src = open_frames(in->at("file").str(), 0, error);
  if (!src) fail(ErrorCode::decode, "cannot read '" + in->at("file").str() + "': " + error);
  control.progress(0.01, "Loading the Object Matte model");
  std::unique_ptr<sam::Models> models = sam::load(in->at("encoder").str(), in->at("decoder").str(), error);
  if (!models) fail(sam::runtime_available() ? ErrorCode::io : ErrorCode::unsupported, "Object Matte model: " + error);
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
      RgbaImage img;
      if (!src->read(frame, img, error)) fail(ErrorCode::decode, "frame " + std::to_string(frame) + ": " + error);
      const int w = static_cast<int>(img.width);
      const int h = static_cast<int>(img.height);
      const double kx = w / layerW;
      const double ky = h / layerH;
      const stabilize::FloatLuma lum = stabilize::luma_255_of(img.rgba, w, h);
      std::optional<scene::pixmo::FlowField> flow;
      if (!prevAlpha.empty()) {
        scene::pixmo::FlowOptions fo;
        fo.step = 8;
        flow = stabilize::compute_flow_f32(prevLuma, lum, fo);
      }
      // Prompts: the user's on the first frame, else carried by the previous matte; strokes on this frame always.
      std::vector<sam::Point> pts;
      std::optional<sam::Box> box;
      std::vector<float> warped;
      if (first) {
        pts = points_of(in->at("points"), kx, ky);
        if (in->at("box").is_array() && in->at("box").arr().size() == 4) {
          const Json::Array& b = in->at("box").arr();
          box = sam::Box{b[0].num() * kx, b[1].num() * ky, b[2].num() * kx, b[3].num() * ky};
        }
      } else {
        warped = matte::warp_by_flow(prevAlpha, *flow, w, h);
        const matte::Seeds seeds = matte::seeds_from_matte(warped, w, h);
        if (seeds.empty) {
          status = "lost";
          break;
        }
        pts = seeds.points;
        box = seeds.box;
      }
      for (const Json& st : in->at("strokes").arr()) {
        if (std::abs(num_or(st, "t", -1e9) - compTime) > 0.5 / std::max(1.0, compFps)) continue;
        for (const sam::Point& p : points_of(st.at("points"), kx, ky)) pts.push_back(p);
      }
      const sam::Letterbox lb = sam::letterbox(img.width, img.height);
      // A box with points: the points prompt, the box constrains (the decoder export takes points only).
      const std::optional<sam::Prompts> prompts = sam::prompts_for(pts, pts.empty() ? box : std::nullopt, lb.scale);
      if (!prompts) fail(ErrorCode::invalid_argument, "Nothing to segment — click the object or drag a box around it.");
      sam::Embeddings emb;
      if (!models->encode(sam::preprocess(img.rgba, img.width, img.height), emb, error)) fail(ErrorCode::internal, "SAM encoder: " + error);
      sam::Decoded dec;
      if (!models->decode(emb, *prompts, dec, error)) fail(ErrorCode::internal, "SAM decoder: " + error);
      const std::size_t plane = static_cast<std::size_t>(sam::kMaskSize) * sam::kMaskSize;
      const std::size_t best = sam::best_mask(dec.iouScores.data);
      std::vector<float> alpha = matte::soft_mask(dec.predMasks.data, best * plane, img.width, img.height, lb.scale);
      if (box) {
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
      // Refine for the stored frame.
      std::vector<float> refined = alpha;
      if (rf.edgeRadius > 0) refined = matte::guided_filter(refined, matte::luma(img.rgba, w, h), w, h, static_cast<int>(std::lround(rf.edgeRadius)), 1e-3);
      if (rf.motionBlur && flow) refined = matte::motion_blur(refined, *flow, w, h, rf.shutterAngle);
      matte::choke_feather(refined, w, h, rf.choke, rf.feather);
      std::vector<std::uint8_t> colours = img.rgba;
      if (rf.decontaminate > 0) matte::decontaminate(colours, refined, w, h, rf.decontaminate);
      const std::vector<std::uint8_t> cut = matte::cutout(colours, refined, w, h);
      std::vector<std::uint8_t> png;
      if (!exporter::encode_png_rgba8(cut, img.width, img.height, png)) fail(ErrorCode::io, "could not encode a matte frame");
      std::string name = std::to_string(static_cast<long long>(std::llround(compTime * compFps)));
      if (name.size() < 6) name.insert(0, 6 - name.size(), '0');
      const std::filesystem::path path = std::filesystem::path(folder) / ("matte_" + name + ".png");
      {
        std::filesystem::path tmp = path;
        tmp += ".tmp";
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        f.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
        if (!f) fail(ErrorCode::io, "cannot write '" + tmp.string() + "'");
        f.close();
        std::filesystem::rename(tmp, path, ec);
        if (ec) fail(ErrorCode::io, "cannot write '" + path.string() + "': " + ec.message());
      }
      std::vector<std::uint8_t> bin(refined.size());
      for (std::size_t i = 0; i < refined.size(); ++i) bin[i] = refined[i] >= 0.5f ? 255 : 0;
      const std::vector<trace::TracePoint> contour = sam::matte_contour(bin, img.width, img.height, 128);
      Json fr = Json::object();
      fr.set("t", Json::number(compTime));
      fr.set("file", Json::string(path.string()));
      Json c = Json::array();
      for (const trace::TracePoint& p : contour) {
        c.arr_mut().push_back(Json::number(p.x / kx));
        c.arr_mut().push_back(Json::number(p.y / ky));
      }
      fr.set("contour", std::move(c));
      frames.arr_mut().push_back(std::move(fr));
      ++done;
      control.progress(0.03 + 0.95 * static_cast<double>(done) / static_cast<double>(std::max<std::size_t>(1, total)),
                       "Object Matte, frame " + std::to_string(done) + " of " + std::to_string(total));
    }
  }
  Json o = Json::object();
  o.set("frames", std::move(frames));
  o.set("status", Json::string(status));
  o.set("layerWidth", Json::number(layerW));
  o.set("layerHeight", Json::number(layerH));
  return js::stringify(o);
}

struct MatteFrame {
  double t = 0;
  std::string file;
  api::BezierPath path;
};

class ObjectMatteVideoResult final : public JobResult {
 public:
  ObjectMatteVideoResult(std::string layer, std::vector<MatteFrame> frames, std::string status, bool storeMatte,
                         std::vector<std::string> replace)
      : layer_(std::move(layer)), frames_(std::move(frames)), status_(std::move(status)), storeMatte_(storeMatte), replace_(std::move(replace)) {}

  [[nodiscard]] std::string summary_json() const override {
    Json s = Json::object();
    s.set("frames", Json::number(static_cast<double>(frames_.size())));
    s.set("status", Json::string(status_));
    if (!mask_.empty()) s.set("mask", Json::string(mask_));
    return js::stringify(s);
  }
  [[nodiscard]] std::string label() const override { return "Object Matte"; }
  [[nodiscard]] bool has_edits() const override { return !frames_.empty(); }

  void apply(JobApply& a) const override {
    if (frames_.empty()) return;
    if (!replace_.empty()) {
      api::RemovePropertyGroups drop;
      for (const std::string& id : replace_) drop.groups.push_back(api::PropRef{layer_, "masks/" + id});
      (void)a.run(command(std::move(drop)));
    }
    if (storeMatte_) {
      api::SetLayerMatte m;
      m.layer = layer_;
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
    m.name = "Object Matte";
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
  std::vector<std::string> replace_;
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
  const std::string encoder = model_path(spec.encoder_model, dir, kEncoderFile);
  const std::string decoder = model_path(spec.decoder_model, dir, kDecoderFile);
  if (encoder.empty() || decoder.empty()) {
    fail(ErrorCode::unsupported,
         "no Object Matte model: pass encoderModel / decoderModel, or set PREMATION_SAM_DIR to the folder holding " +
             std::string(kEncoderFile) + " and " + kDecoderFile);
  }
  for (const std::string* p : {&encoder, &decoder}) {
    std::error_code ec;
    if (!std::filesystem::is_regular_file(std::filesystem::path(*p), ec)) {
      fail(ErrorCode::not_found, "Object Matte model '" + *p + "' does not exist");
    }
  }

  // objectMask.ts: a box wins over clicks.
  Json points = Json::array();
  Json input = Json::object();
  if (spec.box) {
    const api::Rect& r = *spec.box;
    if (!std::isfinite(r.x) || !std::isfinite(r.y) || !std::isfinite(r.width) || !std::isfinite(r.height)) {
      fail(ErrorCode::invalid_argument, "box must be finite", {.layer = spec.layer});
    }
    Json b = Json::array();
    b.arr_mut() = {Json::number(r.x), Json::number(r.y), Json::number(r.x + r.width), Json::number(r.y + r.height)};
    input.set("box", std::move(b));
  } else {
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
    if (points.arr().empty()) {
      fail(ErrorCode::invalid_argument, "Nothing to segment — click the object or drag a box around it.",
           {.layer = spec.layer});
    }
  }
  input.set("file", Json::string(fl.file));
  input.set("sourceSeconds", Json::number(fl.source_seconds(seconds_of(spec.range.start))));
  input.set("layerWidth", Json::number(fl.width));
  input.set("layerHeight", Json::number(fl.height));
  input.set("points", std::move(points));
  input.set("encoder", Json::string(encoder));
  input.set("decoder", Json::string(decoder));

  if (spec.direction) {
    // AE parity 3.1 / 3.2: follow the subject through the range.
    const double fps = fl.compFps > 0 ? fl.compFps : 30;
    const auto first = static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start) * fps));
    const auto last = std::max(first, static_cast<std::int64_t>(std::llround(seconds_of(spec.range.start + spec.range.duration) * fps)) - 1);
    const std::int64_t origin = spec.origin ? std::clamp(static_cast<std::int64_t>(std::llround(seconds_of(*spec.origin) * fps)), first, last) : first;
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
    input.set("folder", Json::string(folder.string()));
    PreparedJob job;
    job.kind = "objectMatte";
    job.work = [layer = fl.layer, inputJson = js::stringify(input), store = spec.matte.value_or(true),
                replace = spec.replace_masks](JobControl& control) -> std::unique_ptr<JobResult> {
      const std::optional<std::string> out = run_child("objectMatteVideo", inputJson, control);
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
      return std::make_unique<ObjectMatteVideoResult>(layer, std::move(frames), status, store, replace);
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
  job.work = [layer = fl.layer, inputJson = js::stringify(input), maskOut = std::move(maskOut)](JobControl& control) -> std::unique_ptr<JobResult> {
    const std::optional<std::string> out = run_child("objectMatte", inputJson, control);
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
    return std::make_unique<ObjectMatteResult>(layer, std::move(path), num_or(*r, "iou", 0), maskOut);
  };
  return job;
}

}  // namespace premation::jobs
