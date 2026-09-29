// Job kind `rigLogo` — Rig Logo for Animation (src/core/scene/rigLogo.ts).
//
// Puppet pins warp a single layer's mesh, built from its bitmap alpha or its
// path silhouette; a group, a precomp, text or several layers have neither.
// So, as rigLogo.ts decided:
//   self       ONE image or shape layer holding nothing: rigged in place.
//   rasterize  anything else: the selection drawn alone (together, in stack
//              order) on a transparent comp by a child engine at `time`,
//              cropped to its pixels + 4 px, imported as a PNG (importBytes,
//              `derived`: kept off the Assets shelf) and placed as an image
//              layer where it drew, above the topmost selected layer.
// The rig is rigLogo.ts starterPuppetPins: "Anchor" at the bottom centre and
// "Wave" at the top centre, layer space (centre origin). Everything the apply
// writes — the import, the layer, the pins — is one history entry.
//
// Differences from the page: the picture is rendered at composition
// resolution (the page rendered at the display's pixel ratio, capped at
// 2048 px), and cropped to what actually drew rather than to the layers'
// Transform boxes.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "child_export.hpp"
#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "png_write.hpp"
#include "scene.hpp"
#include "values.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;

namespace {

constexpr int kPad = 4;  // rigLogo.ts: a tiny margin so strokes / AA are not clipped

struct Pin {
  std::string name;
  double x = 0;
  double y = 0;
};

/// rigLogo.ts starterPuppetPins: the anchor at the bottom centre, the mover at the top.
std::vector<Pin> starter_pins(double height) {
  const double half = std::max(1.0, height / 2);
  return {{"Anchor", 0, half}, {"Wave", 0, -half}};
}

void add_pins(JobApply& a, const std::string& layer, const std::vector<Pin>& pins) {
  for (const Pin& p : pins) {
    api::AddPropertyGroup g;
    g.layer = layer;
    g.parent = "puppet/pins";  // the rig is made with its first pin
    g.match_name = "ADBE FreePin3 PosPin Atom";
    g.name = p.name;
    g.init.push_back(api::PropertyInit{"restPosition", doc::v_vec2(p.x, p.y)});
    (void)a.run(command(std::move(g)));
  }
}

class RigSelfResult final : public JobResult {
 public:
  RigSelfResult(std::string layer, double height) : layer_(std::move(layer)), height_(height) {}
  [[nodiscard]] std::string summary_json() const override {
    return "{\"mode\":\"self\",\"layer\":" + json_string(layer_) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Rig Logo for Animation"; }
  void apply(JobApply& a) const override { add_pins(a, layer_, starter_pins(height_)); }

 private:
  std::string layer_;
  double height_;
};

struct Raster {
  std::vector<std::uint8_t> png;
  double width = 0, height = 0;    // comp px
  double centerX = 0, centerY = 0;  // comp px
};

class RigRasterResult final : public JobResult {
 public:
  RigRasterResult(std::string comp, std::string name, std::optional<std::uint32_t> index, Raster r)
      : comp_(std::move(comp)), name_(std::move(name)), index_(index), raster_(std::move(r)) {}
  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"mode\":\"rasterize\",\"width\":" + std::to_string(static_cast<long long>(raster_.width)) +
                    ",\"height\":" + std::to_string(static_cast<long long>(raster_.height));
    if (!layer_.empty()) s += ",\"layer\":" + json_string(layer_) + ",\"item\":" + json_string(item_);
    return s + "}";
  }
  [[nodiscard]] std::string label() const override { return "Rig Logo for Animation"; }
  void apply(JobApply& a) const override {
    api::ImportBytes imp;
    api::ImportBytesFile f;
    f.name = name_ + ".png";
    f.data = raster_.png;
    f.mime_type = "image/png";
    f.source = "derived";  // a copy of what is in the scene, not media the user brought in
    imp.files.push_back(std::move(f));
    const std::optional<api::ItemList> items = result_payload<api::ItemList>(a.run(command(std::move(imp))));
    if (!items || items->items.empty()) fail(ErrorCode::internal, "the rasterized logo was not imported");
    item_ = items->items.front();
    api::CreateLayer cl;
    cl.comp = comp_;
    cl.kind = api::LayerKind::image;
    cl.name = name_;
    cl.source = item_;
    cl.index = index_;
    cl.init.push_back(api::PropertyInit{"transform/position", doc::v_vec2(raster_.centerX, raster_.centerY)});
    const std::optional<api::LayerRef> made = result_payload<api::LayerRef>(a.run(command(std::move(cl))));
    if (!made) fail(ErrorCode::internal, "the rigged logo layer was not created");
    layer_ = made->layer;
    add_pins(a, layer_, starter_pins(raster_.height));
  }

 private:
  std::string comp_;
  std::string name_;
  std::optional<std::uint32_t> index_;
  Raster raster_;
  mutable std::string item_;
  mutable std::string layer_;
};

/// The selected ids whose ancestors are not selected (rigLogo.ts topLevelSelected), in input order.
std::vector<std::string> top_level(const doc::Document& d, const std::vector<std::string>& ids) {
  const std::set<std::string, std::less<>> set(ids.begin(), ids.end());
  std::vector<std::string> out;
  std::set<std::string, std::less<>> seen;
  for (const std::string& id : ids) {
    const doc::Node* n = d.node(id);
    bool nested = false;
    for (std::optional<std::string> p = n != nullptr ? n->parent : std::nullopt; p && !nested;) {
      nested = set.contains(*p);
      const doc::Node* up = d.node(*p);
      p = up != nullptr ? up->parent : std::nullopt;
    }
    if (!nested && seen.insert(id).second) out.push_back(id);
  }
  return out;
}

/// The alpha bounding box (+ pad, clipped to the frame) of a straight RGBA frame; nullopt when nothing drew.
std::optional<std::array<std::uint32_t, 4>> alpha_box(const RgbaImage& img) {
  std::uint32_t x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
  bool any = false;
  for (std::uint32_t y = 0; y < img.height; ++y) {
    for (std::uint32_t x = 0; x < img.width; ++x) {
      if (img.rgba[img.index(x, y) + 3] == 0) continue;
      any = true;
      x0 = std::min(x0, x);
      y0 = std::min(y0, y);
      x1 = std::max(x1, x);
      y1 = std::max(y1, y);
    }
  }
  if (!any) return std::nullopt;
  const auto lo = [](std::uint32_t v) { return v > static_cast<std::uint32_t>(kPad) ? v - kPad : 0U; };
  return std::array<std::uint32_t, 4>{lo(x0), lo(y0), std::min(img.width - 1, x1 + kPad), std::min(img.height - 1, y1 + kPad)};
}

}  // namespace

PreparedJob prepare_rig_logo(const api::RigLogoJob& spec, const JobDocContext& ctx) {
  const doc::Document& d = ctx.doc;
  if (spec.layers.empty()) fail(ErrorCode::invalid_argument, "Select a layer, group, or logo to rig first.");
  for (const std::string& id : spec.layers) {
    if (d.node(id) == nullptr || !doc::comp_of_layer(d, id)) fail(ErrorCode::not_found, "no layer '" + id + "'", {.layer = id});
  }
  const std::vector<std::string> roots = top_level(d, spec.layers);
  const std::string comp = *doc::comp_of_layer(d, roots.front());
  for (const std::string& id : roots) {
    if (doc::comp_of_layer(d, id) != comp) fail(ErrorCode::invalid_argument, "the layers to rig are in different compositions", {.layer = id});
  }
  const doc::Json* rec = d.comp(comp);
  if (rec == nullptr) fail(ErrorCode::invalid_argument, "the layers are not in a composition");
  const double seconds = seconds_of(spec.time.value_or(ctx.time));

  // One image / shape leaf: rigged in place, no rasterize.
  if (roots.size() == 1) {
    const doc::Node& n = *d.node(roots.front());
    const std::string kind = n.kind();
    if ((kind == "image" || kind == "shape") && n.children.empty()) {
      if (!ctx.layerSize) fail(ErrorCode::unsupported, "this engine cannot measure layers for a rig", {.layer = n.id});
      const std::optional<std::array<double, 2>> size = ctx.layerSize(n.id, seconds);
      const double h = size ? (*size)[1] : 100;
      PreparedJob job;
      job.kind = "rigLogo";
      job.work = [layer = n.id, h](JobControl& control) -> std::unique_ptr<JobResult> {
        control.progress(1, "Rigging");
        return std::make_unique<RigSelfResult>(layer, h);
      };
      return job;
    }
  }

  // Rasterize: rendered alone, cropped, imported, rigged.
  const double fps = rec->at("fps").is_number() && rec->at("fps").num() > 0 ? rec->at("fps").num() : 30.0;
  const std::int64_t frame = std::max<std::int64_t>(0, static_cast<std::int64_t>(std::floor(seconds * fps + 1e-6)));
  // Above the topmost selected layer (a top-level one: index 0 = the top of the stack).
  std::optional<std::uint32_t> index;
  if (const auto root = doc::enclosing_comp_root_of(d, roots.front()); root) {
    if (const doc::Node* r = d.node(*root); r != nullptr) {
      std::size_t best = r->children.size();
      for (const std::string& id : roots) {
        const auto it = std::find(r->children.begin(), r->children.end(), id);
        if (it == r->children.end()) continue;
        const std::size_t fromTop = r->children.size() - 1 - static_cast<std::size_t>(it - r->children.begin());
        best = std::min(best, fromTop);
      }
      if (best < r->children.size()) index = static_cast<std::uint32_t>(best);
    }
  }
  std::string name = d.node(roots.front())->name.empty() ? std::string("Logo") : d.node(roots.front())->name;
  constexpr std::string_view kSuffix = " (Rigged)";
  if (name.ends_with(kSuffix)) name.erase(name.size() - kSuffix.size());
  name += kSuffix;

  PreparedJob job;
  job.kind = "rigLogo";
  job.work = [projectJson = snapshot_project_json(d, ctx.bundleRoot), comp, roots, frame, index,
              name](JobControl& control) -> std::unique_ptr<JobResult> {
    const std::optional<std::vector<RgbaImage>> frames = render_layers_alone(projectJson, comp, roots, frame, frame, control, "Rendering the logo", 0, 0.8);
    if (!frames) return nullptr;
    if (frames->empty() || frames->front().empty()) fail(ErrorCode::internal, "the logo render wrote no picture");
    const RgbaImage& img = frames->front();
    const std::optional<std::array<std::uint32_t, 4>> box = alpha_box(img);
    if (!box) fail(ErrorCode::invalid_argument, "The selection draws nothing at this time — move the playhead to where the logo is visible.");
    const auto [x0, y0, x1, y1] = *box;
    const std::uint32_t w = x1 - x0 + 1;
    const std::uint32_t h = y1 - y0 + 1;
    std::vector<std::uint8_t> crop(std::size_t{w} * h * 4);
    for (std::uint32_t y = 0; y < h; ++y) {
      const auto* src = img.rgba.data() + img.index(x0, y0 + y);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      std::copy_n(src, std::size_t{w} * 4, crop.begin() + static_cast<std::ptrdiff_t>(std::size_t{y} * w * 4));
    }
    Raster r;
    if (!exporter::encode_png_rgba8(crop, w, h, r.png)) fail(ErrorCode::internal, "the logo could not be encoded as PNG");
    r.width = w;
    r.height = h;
    r.centerX = static_cast<double>(x0) + static_cast<double>(w) / 2;
    r.centerY = static_cast<double>(y0) + static_cast<double>(h) / 2;
    control.progress(1, "Rigging");
    return std::make_unique<RigRasterResult>(comp, name, index, std::move(r));
  };
  return job;
}

}  // namespace premation::jobs
