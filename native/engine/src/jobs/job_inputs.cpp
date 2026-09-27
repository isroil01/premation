#include "job_inputs.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>

#include "anim.hpp"
#include "docexpr.hpp"
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

namespace {

struct ClipOff {
  double offset = 0;
  double inSec = 0;
};

ClipOff clip_at(const FootageLayer& f, double compSec) {
  const double fps = f.compFps > 0 ? f.compFps : 30;
  const double frame = compSec * fps;
  const FootageLayer::RetimeClipMap* best = nullptr;
  double bestDist = std::numeric_limits<double>::infinity();
  for (const FootageLayer::RetimeClipMap& c : f.retimeClips) {
    if (frame >= c.startFrame && frame < c.endFrame) return ClipOff{c.offsetSec, c.inSec};
    const double dist = frame < c.startFrame ? c.startFrame - frame : frame - (c.endFrame - 1);
    if (dist < bestDist) {
      bestDist = dist;
      best = &c;
    }
  }
  if (best != nullptr) return ClipOff{best->offsetSec, best->inSec};
  return {};
}

bool is_hold(const std::optional<api::Easing>& e) { return e && (*e == api::Easing::step || *e == api::Easing::hold); }

/// retime_port.cpp speed table, sampled with `anim_sample_keys` (no expression).
struct SpeedSeg {
  double t0 = 0, t1 = 0, v0 = 0, v1 = 0;
  enum class Kind : std::uint8_t { hold, linear, sampled } kind = Kind::linear;
  std::vector<double> cum;
  std::vector<double> vals;
};

struct SpeedTable {
  double firstT = 0, firstV = 1, lastT = 0, lastV = 1;
  std::vector<SpeedSeg> segments;
  std::vector<double> startCum;
};

constexpr int kEasedPanels = 64;

SpeedTable speed_table(const std::vector<doc::Key>& keys) {
  std::vector<doc::Key> sorted = keys;
  std::stable_sort(sorted.begin(), sorted.end(), [](const doc::Key& a, const doc::Key& b) { return a.t < b.t; });
  SpeedTable table;
  if (sorted.empty()) return table;
  double cum = 0;
  for (std::size_t i = 0; i + 1 < sorted.size(); ++i) {
    const doc::Key& a = sorted[i];
    const doc::Key& b = sorted[i + 1];
    const double len = b.t - a.t;
    if (!(len > 0)) continue;
    const double v0 = a.value / 100;
    const double v1 = b.value / 100;
    table.startCum.push_back(cum);
    SpeedSeg s;
    s.t0 = a.t;
    s.t1 = b.t;
    s.v0 = v0;
    s.v1 = v1;
    if (is_hold(a.easing)) {
      s.kind = SpeedSeg::Kind::hold;
      cum += v0 * len;
    } else if (a.easing && *a.easing == api::Easing::linear && !a.so && !b.si) {
      s.kind = SpeedSeg::Kind::linear;
      cum += ((v0 + v1) / 2) * len;
    } else {
      s.kind = SpeedSeg::Kind::sampled;
      constexpr auto kP = static_cast<std::size_t>(kEasedPanels);
      s.vals.assign(kP + 1, 0);
      s.cum.assign(kP + 1, 0);
      for (std::size_t j = 0; j <= kP; ++j) {
        const double t = a.t + (len * static_cast<double>(j)) / kEasedPanels;
        double v = a.value;
        if (j == kP) v = b.value;
        else if (j != 0) v = doc::anim_sample_keys(sorted, t).value_or(a.value);
        s.vals[j] = v / 100;
      }
      const double h = len / kEasedPanels;
      for (std::size_t j = 1; j <= kP; ++j) s.cum[j] = s.cum[j - 1] + ((s.vals[j - 1] + s.vals[j]) / 2) * h;
      cum += s.cum[kP];
    }
    table.segments.push_back(std::move(s));
  }
  table.firstT = sorted.front().t;
  table.firstV = sorted.front().value / 100;
  table.lastT = sorted.back().t;
  table.lastV = sorted.back().value / 100;
  return table;
}

double segment_integral(const SpeedSeg& s, double x) {
  const double d = x - s.t0;
  if (d <= 0) return 0;
  const double len = s.t1 - s.t0;
  if (s.kind == SpeedSeg::Kind::hold) return s.v0 * d;
  if (s.kind == SpeedSeg::Kind::linear) return s.v0 * d + ((s.v1 - s.v0) * d * d) / (2 * len);
  const double h = len / kEasedPanels;
  const double jj = std::min(static_cast<double>(kEasedPanels - 1), std::floor(d / h));
  const auto j = static_cast<std::size_t>(jj);
  const double into = d - jj * h;
  const double va = s.vals[j];
  const double vb = s.vals[j + 1];
  return s.cum[j] + va * into + ((vb - va) * into * into) / (2 * h);
}

double cumulative_at(const SpeedTable& t, double x) {
  if (x <= t.firstT) return (x - t.firstT) * t.firstV;
  const auto& segs = t.segments;
  if (segs.empty() || x >= t.lastT) {
    const double total = segs.empty() ? 0 : t.startCum[segs.size() - 1] + segment_integral(segs.back(), segs.back().t1);
    return total + (x - t.lastT) * t.lastV;
  }
  for (std::size_t i = 0; i < segs.size(); ++i) {
    const SpeedSeg& s = segs[i];
    if (x <= s.t1) return t.startCum[i] + segment_integral(s, std::max(s.t0, x));
  }
  return 0;
}

double speed_advance(const std::vector<doc::Key>& keys, double a, double b) {
  if (keys.empty()) return b - a;
  const SpeedTable table = speed_table(keys);
  return cumulative_at(table, b) - cumulative_at(table, a);
}

double keyed_source(const FootageLayer& f, double compSec) {
  const ClipOff clip = clip_at(f, compSec);
  if (f.retimeKind == FootageLayer::RetimeKind::speed) {
    const double uIn = clip.inSec + clip.offset;
    return uIn + speed_advance(f.retimeKeys, uIn, compSec + clip.offset);
  }
  const double chain = doc::anim_sample_keys(f.retimeKeys, compSec).value_or(compSec);
  return chain + clip.offset;
}

double sampled_source(const FootageLayer& f, double compSec) {
  const double fps = f.compFps > 0 ? f.compFps : 30;
  const double idx = compSec * fps - static_cast<double>(f.retimeSampleFirst);
  if (f.retimeSamples.size() == 1 || idx <= 0) return f.retimeSamples.front();
  const double last = static_cast<double>(f.retimeSamples.size() - 1);
  if (idx >= last) return f.retimeSamples.back();
  const auto i = static_cast<std::size_t>(idx);
  const double u = idx - static_cast<double>(i);
  return f.retimeSamples[i] * (1 - u) + f.retimeSamples[i + 1] * u;
}

void bake_expressed(const doc::Document& d, FootageLayer& f, const char* prop) {
  try {
    doc::EditorView view;
    view.tabComp = f.comp;
    doc::ExprCache cache;
    doc::DocExprEnv env(d, view, cache);
    const double fps = f.compFps > 0 ? f.compFps : 30;
    const double t0 = f.in_seconds();
    const double t1 = std::max(t0, f.out_seconds());
    const auto count = static_cast<std::int64_t>(std::floor((t1 - t0) * fps + 1e-9)) + 1;
    if (count <= 0 || count > 1'000'000) return;
    const auto first = static_cast<std::int64_t>(std::llround(t0 * fps));
    std::vector<double> samples(static_cast<std::size_t>(count));
    if (f.retimeKind == FootageLayer::RetimeKind::speed) {
      double prevX = 0;
      double acc = 0;
      bool started = false;
      double prevOff = 0;
      double prevIn = 0;
      for (std::int64_t i = 0; i < count; ++i) {
        const double compSec = static_cast<double>(first + i) / fps;
        const ClipOff clip = clip_at(f, compSec);
        if (!started || clip.offset != prevOff || clip.inSec != prevIn) {
          prevX = clip.inSec + clip.offset;
          acc = 0;
          prevOff = clip.offset;
          prevIn = clip.inSec;
          started = true;
        }
        const double x1 = compSec + clip.offset;
        const double dt = x1 - prevX;
        if (dt != 0) {
          const double r0 = doc::anim_sample(d, env, cache, f.layer, prop, prevX).value_or(100) / 100;
          const double r1 = doc::anim_sample(d, env, cache, f.layer, prop, x1).value_or(100) / 100;
          acc += ((r0 + r1) * 0.5) * dt;
          prevX = x1;
        }
        samples[static_cast<std::size_t>(i)] = clip.inSec + clip.offset + acc;
      }
    } else {
      for (std::int64_t i = 0; i < count; ++i) {
        const double compSec = static_cast<double>(first + i) / fps;
        const ClipOff clip = clip_at(f, compSec);
        const double chain = doc::anim_sample(d, env, cache, f.layer, prop, compSec).value_or(compSec);
        samples[static_cast<std::size_t>(i)] = chain + clip.offset;
      }
    }
    f.retimeSampleFirst = first;
    f.retimeSamples = std::move(samples);
  } catch (const std::exception&) {
    f.retimeSamples.clear();
  }
}

void read_retime(const doc::Document& d, FootageLayer& f) {
  const bool speed = f.timing.retime == api::RetimeMode::speed;
  const bool frames = f.timing.retime == api::RetimeMode::frames || f.timing.time_remap_enabled;
  if (!speed && !frames) return;
  f.retimeKind = speed ? FootageLayer::RetimeKind::speed : FootageLayer::RetimeKind::frames;
  const char* prop = "timeSpeed";
  if (!speed) prop = (doc::anim_is_animated(d, f.layer, "timeRemap") || f.timing.time_remap_enabled) ? "timeRemap" : "precompTime";
  if (const std::vector<doc::Key>* keys = doc::anim_track(d, f.layer, prop)) f.retimeKeys = *keys;
  const double fps = f.compFps > 0 ? f.compFps : 30;
  for (const doc::Bar* b : doc::bars_of(d, f.layer, f.comp)) {
    if (b == nullptr) continue;
    FootageLayer::RetimeClipMap m;
    m.startFrame = b->clip.start;
    m.endFrame = b->clip.end();
    m.offsetSec = (b->clip.sourceIn - b->clip.start) / fps;
    m.inSec = b->clip.start / fps;
    f.retimeClips.push_back(m);
  }
  if (const doc::ExprState* ex = doc::anim_expr(d, f.layer, prop); ex != nullptr && ex->enabled) bake_expressed(d, f, prop);
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
  read_retime(d, f);
  return f;
}

double FootageLayer::comp_seconds(double sourceSec) const {
  if (retimeKind == RetimeKind::none) {
    const double stretch = timing.stretch != 0 ? timing.stretch : 1.0;
    return seconds_of(timing.start_time) + sourceSec * stretch;
  }
  const double t0 = in_seconds();
  const double t1 = std::max(t0, out_seconds());
  const double s0 = source_seconds(t0);
  const double s1 = source_seconds(t1);
  if (!(t1 > t0) || s0 == s1) return t0;
  const bool inc = s1 >= s0;
  if ((inc && sourceSec <= s0) || (!inc && sourceSec >= s0)) return t0;
  if ((inc && sourceSec >= s1) || (!inc && sourceSec <= s1)) {
    const double dt = 1.0 / 240.0;
    const double edge = source_seconds(std::max(t0, t1 - dt));
    const double slope = (s1 - edge) / dt;
    if (std::abs(slope) < 1e-9) return t1;
    return t1 + (sourceSec - s1) / slope;
  }
  double lo = t0;
  double hi = t1;
  for (int i = 0; i < 48; ++i) {
    const double mid = (lo + hi) * 0.5;
    const double sm = source_seconds(mid);
    if ((inc && sm < sourceSec) || (!inc && sm > sourceSec)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

double FootageLayer::source_seconds(double compSec) const {
  if (!std::isfinite(compSec)) return 0;
  if (!retimeSamples.empty()) return sampled_source(*this, compSec);
  if (retimeKind != RetimeKind::none) return keyed_source(*this, compSec);
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
