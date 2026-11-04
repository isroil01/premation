// Sample (SDK 1.4, U): Scatter Brush — a VIEWER TOOL. The manifest's `tools` entry puts it on the
// toolbar; while it is active the viewer hands every drag to its command as one stroke in comp
// pixels, and the command stamps an ellipse layer every `spacing` px along it — ONE undo entry for
// the whole drag ("Scatter Brush").
//
//   args (from the tool):  { "tool": "scatter", "stroke": [[x, y], …], "shift": bool, "alt": bool,
//                            "ctrl": bool }
//   args (by hand):        { "spacing": 48 } as well; Shift halves the spacing, Alt doubles the size.
//
// Sizes vary along the stroke from a hash of the stamp's index, never a clock or an unseeded RNG,
// so replaying the same stroke gives the same layers.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <cstddef>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "sample_json.hpp"

namespace {

namespace json = prs::json;

constexpr std::size_t kMaxStamps = 200;

/// The brush spacing the tool's wheel / [ ] set (module state: an event never edits the document).
double gSpacing = 48;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

void say(PrCommandOut* out, const std::string& msg) { std::snprintf(out->return_msg, sizeof(out->return_msg), "%s", msg.c_str()); }

bool command(const PrCommandContext* ctx, const std::string& request, PrCommandOut* out) {
  const char* reply = nullptr;
  uint32_t len = 0;
  if (ctx->engine->engine_command(ctx->host_ref, request.c_str(), &reply, &len) == PR_ERR_NONE) return true;
  json::Value v;
  say(out, reply != nullptr && json::parse(std::string_view(reply, len), v) ? v["message"].str() : std::string("the engine refused the edit"));
  return false;
}

struct Pt {
  double x, y;
};

/// Points every `spacing` px along the polyline (the first point included).
std::vector<Pt> resample(const std::vector<Pt>& line, double spacing) {
  std::vector<Pt> out;
  if (line.empty()) return out;
  out.push_back(line.front());
  double carried = 0;
  for (std::size_t i = 1; i < line.size() && out.size() < kMaxStamps; ++i) {
    const Pt a = line[i - 1];
    const Pt b = line[i];
    const double seg = std::hypot(b.x - a.x, b.y - a.y);
    double at = spacing - carried;
    while (at <= seg && out.size() < kMaxStamps) {
      const double u = at / seg;
      out.push_back({a.x + ((b.x - a.x) * u), a.y + ((b.y - a.y) * u)});
      at += spacing;
    }
    carried = seg - (at - spacing);
  }
  return out;
}

/// 0..1 from the stamp's index (a fixed integer hash).
double jitter(std::uint32_t i) {
  i ^= i >> 16U;
  i *= 0x7feb352dU;
  i ^= i >> 15U;
  i *= 0x846ca68bU;
  i ^= i >> 16U;
  return static_cast<double>(i % 1000U) / 999.0;
}

PrErr run(const PrCommandContext* ctx, PrCommandOut* out) {
  json::Value args;
  (void)json::parse(ctx->args_json != nullptr ? ctx->args_json : "{}", args);
  if (ctx->comp_id == nullptr || ctx->comp_id[0] == '\0') {
    say(out, "open a composition to scatter into");
    return PR_ERR_INVALID_PARAM;
  }
  std::vector<Pt> line;
  for (const json::Value& p : args["stroke"].a) {
    if (p.a.size() >= 2 && std::isfinite(p.a[0].num()) && std::isfinite(p.a[1].num())) line.push_back({p.a[0].num(), p.a[1].num()});
  }
  if (line.empty()) {
    say(out, "drag in the viewer to scatter");
    return PR_ERR_INVALID_PARAM;
  }
  double spacing = args["spacing"].num() > 0 ? args["spacing"].num() : gSpacing;
  if (args["shift"].b) spacing /= 2;
  const double sizeK = args["alt"].b ? 2.0 : 1.0;
  const std::vector<Pt> stamps = resample(line, std::max(spacing, 2.0));
  for (std::size_t i = 0; i < stamps.size(); ++i) {
    const double scale = sizeK * (40 + (80 * jitter(static_cast<std::uint32_t>(i))));
    const std::string req = "{\"type\":\"createLayer\",\"comp\":" + json::quote(ctx->comp_id) + ",\"kind\":\"ellipse\",\"name\":" +
                            json::quote("Scatter " + std::to_string(i + 1)) +
                            ",\"init\":[{\"path\":\"transform/position\",\"value\":{\"kind\":\"vec2\",\"value\":{\"x\":" + json::number(stamps[i].x) +
                            ",\"y\":" + json::number(stamps[i].y) + "}}},{\"path\":\"transform/scale\",\"value\":{\"kind\":\"vec2\",\"value\":{\"x\":" +
                            json::number(scale) + ",\"y\":" + json::number(scale) + "}}}]}";
    if (!command(ctx, req, out)) return PR_ERR_INVALID_PARAM;
  }
  say(out, "scattered " + std::to_string(stamps.size()) + (stamps.size() == 1 ? " layer" : " layers"));
  return PR_ERR_NONE;
}

/// SDK 1.4 (U1): the brush while the tool is active — its ring at the pointer, the stamps a drag would
/// make, and the wheel / [ ] changing the spacing the next drags use.
PrErr tool_event(const PrCommandContext* ctx, PrCommandOut* out) {
  json::Value args;
  (void)json::parse(ctx->args_json != nullptr ? ctx->args_json : "{}", args);
  const std::string event = args["event"].str();
  if (event == "wheel") gSpacing *= args["deltaY"].num() < 0 ? 1.1 : 1 / 1.1;
  if (event == "key" && args["key"].str() == "[") gSpacing /= 1.2;
  if (event == "key" && args["key"].str() == "]") gSpacing *= 1.2;
  gSpacing = std::clamp(gSpacing, 8.0, 400.0);
  const double spacing = args["shift"].b ? gSpacing / 2 : gSpacing;
  const bool canDraw = ctx->engine->struct_size >= offsetof(PrCommandSuite, tool_draw) + sizeof(void*);
  if (canDraw) {
    const json::Value& pt = args["pointer"];
    if (pt.a.size() >= 2) {
      const double ring[3] = {pt.a[0].num(), pt.a[1].num(), spacing / 2};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
      (void)ctx->engine->tool_draw(ctx->host_ref, PR_TOOL_DRAW_CIRCLE, ring, 3, nullptr, 1.5);
    }
    std::vector<Pt> line;
    for (const json::Value& p : args["stroke"].a) {
      if (p.a.size() >= 2) line.push_back({p.a[0].num(), p.a[1].num()});
    }
    const float dot[4] = {1.0F, 0.75F, 0.2F, 1.0F};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
    for (const Pt& st : resample(line, spacing)) {
      const double xy[2] = {st.x, st.y};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
      (void)ctx->engine->tool_draw(ctx->host_ref, PR_TOOL_DRAW_DOT, xy, 2, dot, 6);
    }
  }
  say(out, "Spacing " + std::to_string(static_cast<int>(std::lround(spacing))) + " px - wheel or [ ] to change");
  return PR_ERR_NONE;
}

PrErr PR_CALL scatter_main(PrCommandCmd cmd, const PrCommandContext* ctx, PrCommandOut* out) {
  if (ctx == nullptr || out == nullptr) return PR_ERR_UNSUPPORTED;
  if (ctx->struct_size < sizeof(PrCommandContext) || ctx->engine == nullptr) return PR_ERR_BAD_VERSION;
  if (cmd == PR_COMMAND_TOOL_EVENT) return tool_event(ctx, out);
  if (cmd != PR_COMMAND_RUN) return PR_ERR_UNSUPPORTED;
  return run(ctx, out);
}

const PrCommandEntry kCommands[] = {{"scatter", &scatter_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.scatter", 0, nullptr, 1, kCommands, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
