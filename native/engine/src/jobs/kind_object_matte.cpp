// Job kind `objectMatte` — one click (or a drawn box) on footage becomes a
// mask path: src/core/tracking/objectMask.ts `segmentObjectMask` with the
// neural path of samSegment.ts / samPipeline.ts (SlimSAM through ONNX
// Runtime).
//
//   prepare (core)   the layer's file, the source time under range.start, the
//                    prompts, the model files (the spec's, else
//                    $PREMATION_SAM_DIR/{vision_encoder,prompt_encoder_mask_decoder}_quantized.onnx).
//   work (worker)    run_child("objectMatte", …): the model runs in a child
//                    engine process, so a runtime crash fails the job only.
//   child            decode the frame, preprocess, encode, decode the prompts,
//                    upsample + threshold the best mask, box-constrain it,
//                    trace its outline (trace_bitmap.hpp) → the contour JSON.
//   apply (core)     addMask (mode none, "Object mask") + its feather 2 — the
//                    path objectMask.ts writes: geometry for Track mask and
//                    the path effects, not a cut.
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <system_error>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

#include "child_job.hpp"
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
  ObjectMatteResult(std::string layer, api::BezierPath path, double iou)
      : layer_(std::move(layer)), path_(std::move(path)), iou_(iou) {}

  [[nodiscard]] std::string summary_json() const override {
    return "{\"contourPoints\":" + std::to_string(path_.vertices.size() / 2) + ",\"engine\":\"onnx\",\"iou\":" +
           json_number(iou_) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Object Mask"; }
  [[nodiscard]] bool has_edits() const override { return path_.vertices.size() >= 6; }

  void apply(JobApply& a) const override {
    api::AddMask m;
    m.layer = layer_;
    m.path = path_;
    m.mode = api::MaskMode::none;
    m.name = "Object mask";
    const std::string group = mask_group_of(a.run(command(std::move(m))));
    api::SetProperty feather;
    feather.prop = api::PropRef{layer_, group + "/feather"};
    feather.value = doc::v_scalar(2);
    (void)a.run(command(std::move(feather)));
  }

 private:
  std::string layer_;
  api::BezierPath path_;
  double iou_;
};

/// The model file: the spec's, else `$PREMATION_SAM_DIR/<file>`; '' when neither.
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

}  // namespace

void register_object_matte_child() { register_child_work("objectMatte", object_matte_child); }

PreparedJob prepare_object_matte(const api::ObjectMatteJob& spec, const JobDocContext& ctx) {
  const FootageLayer fl = footage_layer(ctx, spec.layer, Need::picture);

  const std::optional<std::string> dir =
      spec.encoder_model.empty() || spec.decoder_model.empty() ? os::env_var("PREMATION_SAM_DIR") : std::nullopt;
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

  PreparedJob job;
  job.kind = "objectMatte";
  job.work = [layer = fl.layer, inputJson = js::stringify(input)](JobControl& control) -> std::unique_ptr<JobResult> {
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
    return std::make_unique<ObjectMatteResult>(layer, std::move(path), num_or(*r, "iou", 0));
  };
  return job;
}

}  // namespace premation::jobs
