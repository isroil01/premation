#include "job_inputs.hpp"

#include <cmath>
#include <cstdio>

#include "fail.hpp"
#include "json.hpp"
#include "model.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "time_conv.hpp"
#include "timeline.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;

namespace {

int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

std::string percent_decoded(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size()) {
      const int hi = hex_digit(s[i + 1]);
      const int lo = hex_digit(s[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>(hi * 16 + lo));
        i += 2;
        continue;
      }
    }
    out.push_back(s[i]);
  }
  return out;
}

bool is_alpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

std::string str_prop(const doc::Node& n, std::string_view key) {
  for (const doc::Component& c : n.components) {
    const doc::Json& v = c.props.at(key);
    if (v.is_string() && !v.str().empty()) return v.str();
  }
  return {};
}

double num_prop(const doc::Json& o, std::string_view key, double fallback) {
  const doc::Json& v = o.at(key);
  return v.is_number() && std::isfinite(v.num()) ? v.num() : fallback;
}

}  // namespace

api::Time flicks_of(double seconds) noexcept { return doc::seconds_to_flicks(seconds); }

std::string resolve_footage_path(std::string_view src, std::string_view bundleRoot) {
  if (src.empty() || src.starts_with("blob:") || src.starts_with("data:") || src.starts_with("http:") ||
      src.starts_with("https:")) {
    return {};
  }
  if (src.starts_with("motion-blob:")) {
    const std::string_view hash = src.substr(12);
    if (bundleRoot.empty() || hash.size() < 3) return {};
    std::string p(bundleRoot);
    p += "/blobs/";
    p += hash.substr(0, 2);
    p += '/';
    p += hash;
    return p;
  }
  std::string_view rest;
  if (src.starts_with("file://")) {
    rest = src.substr(7);
  } else if (src.starts_with("local-file://")) {
    rest = src.substr(13);
    // local-file://C/Users/… — Chromium parsed the drive's colon as an empty port.
    if (rest.size() >= 2 && is_alpha(rest[0]) && rest[1] == '/') {
      std::string fixed;
      fixed.push_back(rest[0]);
      fixed.push_back(':');
      fixed.append(rest.substr(1));
      return percent_decoded(fixed);
    }
  } else {
    return std::string(src);
  }
  const std::size_t q = rest.find_first_of("?#");
  if (q != std::string_view::npos) rest = rest.substr(0, q);
  if (rest.starts_with('/') && rest.size() > 2 && rest[2] == ':') rest.remove_prefix(1);  // /C:/…
  return percent_decoded(rest);
}

FootageLayer footage_layer(const JobDocContext& ctx, std::string_view id, Need need) {
  const doc::Document& d = ctx.doc;
  const doc::Node* n = d.node(id);
  const std::optional<std::string> comp = n != nullptr ? doc::comp_of_layer(d, id) : std::nullopt;
  if (n == nullptr || !comp || n->id == *comp) fail(ErrorCode::not_found, "no layer '" + std::string(id) + "'", {.layer = std::string(id)});
  FootageLayer f;
  f.layer = std::string(id);
  f.comp = *comp;
  f.kind = doc::layer_kind_of(*n);
  const bool picture = f.kind == api::LayerKind::video || f.kind == api::LayerKind::image;
  const bool sound = f.kind == api::LayerKind::audio || f.kind == api::LayerKind::video;
  if (need == Need::picture && !picture) {
    fail(ErrorCode::invalid_argument, "layer '" + f.layer + "' is not footage with a picture (video or image)", {.layer = f.layer});
  }
  if (need == Need::sound && !sound) {
    fail(ErrorCode::invalid_argument, "layer '" + f.layer + "' has no sound (an audio or video layer)", {.layer = f.layer});
  }
  const std::optional<std::string> asset = doc::layer_source_of(*n);
  f.item = asset.value_or("");
  // The library record's file wins (a relinked / re-imported item plays from
  // it — audioScene.ts readAudioSource), then the layer's own src.
  std::string file;
  if (const doc::Json* rec = asset ? doc::find_asset(d, *asset) : nullptr; rec != nullptr) {
    if (rec->at("path").is_string()) file = resolve_footage_path(rec->at("path").str(), ctx.bundleRoot);
    if (file.empty() && rec->at("src").is_string()) file = resolve_footage_path(rec->at("src").str(), ctx.bundleRoot);
    const doc::Json& md = rec->at("metadata");
    if (md.is_object()) {
      f.width = static_cast<std::uint32_t>(std::max(0.0, num_prop(md, "width", 0)));
      f.height = static_cast<std::uint32_t>(std::max(0.0, num_prop(md, "height", 0)));
    }
  }
  if (file.empty()) {
    std::string raw = str_prop(*n, "src");
    if (raw.empty()) raw = str_prop(*n, "__src");
    file = resolve_footage_path(raw, ctx.bundleRoot);
    if (file.empty() && !raw.empty()) {
      fail(ErrorCode::unsupported,
           "layer '" + f.layer + "' plays session footage the engine cannot read (" + raw.substr(0, raw.find(':') + 1) +
               "); save the project as a bundle or re-import the file",
           {.layer = f.layer});
    }
  }
  if (file.empty()) fail(ErrorCode::invalid_argument, "layer '" + f.layer + "' has no footage file", {.layer = f.layer});
  f.file = std::move(file);
  f.timing = doc::layer_timing(d, id);
  if (f.timing.time_remap_enabled || f.timing.retime != api::RetimeMode::normal) {
    fail(ErrorCode::invalid_argument, "layer '" + f.layer + "' is retimed; analyse its footage on an un-retimed layer", {.layer = f.layer});
  }
  // mirror/audio.ts hasOwnBar: a layer inside a plain group is timed by the group, not a bar of its own.
  {
    const doc::Node* parent = n->parent ? d.node(*n->parent) : nullptr;
    f.hasBar = parent == nullptr || parent->id == f.comp || doc::layer_kind_of(*parent) != api::LayerKind::group;
  }
  f.compFps = doc::comp_fps(d, f.comp);
  if (const doc::Json* c = d.comp(f.comp); c != nullptr) {
    f.compWidth = static_cast<std::uint32_t>(std::max(1.0, num_prop(*c, "width", 1920)));
    f.compHeight = static_cast<std::uint32_t>(std::max(1.0, num_prop(*c, "height", 1080)));
  }
  return f;
}

double FootageLayer::comp_seconds(double sourceSec) const noexcept {
  const double stretch = timing.stretch != 0 ? timing.stretch : 1.0;
  return seconds_of(timing.start_time) + sourceSec * stretch;
}

double FootageLayer::source_seconds(double compSec) const noexcept {
  const double stretch = timing.stretch != 0 ? timing.stretch : 1.0;
  return (compSec - seconds_of(timing.start_time)) / stretch;
}

std::vector<FootageLayer::ClipTiming> FootageLayer::clip_timings() const {
  if (!hasBar) return {};
  const double inSec = seconds_of(timing.in_point - timing.start_time);
  return {ClipTiming{seconds_of(timing.in_point), inSec, inSec + seconds_of(timing.out_point - timing.in_point)}};
}

std::optional<double> FootageLayer::comp_seconds_through_bar(double sourceSec) const {
  const std::vector<ClipTiming> bars = clip_timings();
  if (bars.empty()) return sourceSec;
  for (const ClipTiming& t : bars) {
    if (sourceSec >= t.inSec && sourceSec < t.outSec) return t.startSec + (sourceSec - t.inSec);
  }
  return std::nullopt;
}

double FootageLayer::in_seconds() const noexcept { return seconds_of(timing.in_point); }
double FootageLayer::out_seconds() const noexcept { return seconds_of(timing.out_point); }

std::string json_number(double v) {
  if (!std::isfinite(v)) return "0";
  if (v == std::floor(v) && std::abs(v) < 1e15) return std::to_string(static_cast<long long>(v));
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.6g", v);
  return buf;
}

std::string json_string(std::string_view s) { return js::stringify(js::Json::string(std::string(s))); }

}  // namespace premation::jobs
