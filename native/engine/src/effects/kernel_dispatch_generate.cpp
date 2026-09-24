// E4 second batch: effect type + the TS kernel's argument names → kernel, for
// the path / paint effects, the generators and the round-seven kernels. Array
// arguments (packed mask paths, brush trails, LUT tables) come through
// `lists`; see kernel_dispatch.hpp. The TS twin of this table is
// src/core/effects/__testHelpers__/nativeKernels.ts.
#include <array>
#include <string>
#include <vector>

#include "kernel_dispatch.hpp"

namespace premation::effects {

namespace {

constexpr std::array<std::string_view, 3> kGenerate{
    "path-stroke", "scribble", "write-on",
};

}  // namespace

std::span<const std::string_view> generate_kernels() noexcept { return kGenerate; }

bool run_generate_kernel(std::string_view type, const KernelArgs& a, const KernelLists& lists, RgbaView img,
                         ThreadPool* pool) {
  const auto b = [&](std::string_view k, bool def) { return a(k, def ? 1 : 0) != 0; };
  const auto rgb = [&](std::string_view name, Rgb def) {
    std::string k(name);
    const std::size_t n = k.size();
    k += 'R';
    const double r = a(k, def.r);
    k[n] = 'G';
    const double g = a(k, def.g);
    k[n] = 'B';
    return Rgb{r, g, a(k, def.b)};
  };
  const auto masks = [&] {
    const std::vector<double> meta = lists("maskPathsMeta");
    const std::vector<double> xy = lists("maskPathsXY");
    return unpack_mask_paths(meta, xy, img.w, img.h);
  };
  if (type == "path-stroke") {
    const PathStrokeOptions o{rgb("color", {255, 255, 255}), a("brushSize", 10), a("hardness", 75),
                              a("opacity", 100),              a("start", 0),       a("end", 100),
                              a("spacing", 15),               a("paintStyle", 0),  b("sequential", false)};
    path_stroke(img, pick_mask_paths(masks(), b("allMasks", false), a("pathMaskIndex", 0)), o, pool);
  } else if (type == "scribble") {
    ScribbleOptions o;
    o.mode = a("mode", 0);
    o.fill_type = a("fillType", 0);
    o.edge_width = a("edgeWidth", 10);
    o.end_cap = a("endCap", 1);
    o.join = a("join", 1);
    o.miter_limit = a("miterLimit", 4);
    o.rgb = rgb("color", {255, 255, 255});
    o.opacity = a("opacity", 100);
    o.angle = a("angle", 45);
    o.stroke_width = a("strokeWidth", 2);
    o.curviness = a("curviness", 50);
    o.curviness_variation = a("curvinessVariation", 0);
    o.spacing = a("spacing", 5);
    o.spacing_variation = a("spacingVariation", 0);
    o.path_overlap = a("pathOverlap", 0);
    o.path_overlap_variation = a("pathOverlapVariation", 0);
    o.start = a("start", 0);
    o.end = a("end", 100);
    o.sequential = b("sequential", true);
    o.seed = a("seed", 0);
    o.wiggle_state = a("wiggleState", 0);
    o.smooth_wiggle = b("smoothWiggle", false);
    o.composite = a("composite", 0);
    const std::vector<MaskPolyline> all = masks();
    scribble(img, all, pick_mask_paths(all, false, a("pathMaskIndex", 0)), o, pool);
  } else if (type == "write-on") {
    WriteOnTrail trail{lists("brushTrailXY"), lists("brushTrailSize"), lists("brushTrailAttr"), b("filled", false)};
    WriteOnBrushOptions o;
    o.brush_x = a("brushX", 0);
    o.brush_y = a("brushY", 0);
    o.rgb = rgb("color", {255, 255, 255});
    o.size = a("size", 8);
    o.hardness = a("hardness", 75);
    o.opacity = a("opacity", 100);
    o.paint_time_props = a("paintTimeProps", 0);
    o.brush_time_props = a("brushTimeProps", 0);
    o.paint_style = a("paintStyle", 0);
    write_on_brush(img, trail, o, pool);
  } else {
    return false;
  }
  return true;
}

}  // namespace premation::effects
