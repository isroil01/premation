// src/core/api/cloudDocument.ts captureDocument / restoreDocument over the D1b
// document model, plus the pieces they call: sceneProjectIO, the animation
// snapshot, TimelineController.capture/restore (packages/timeline's
// Serializer), assetStore captureProjectItems/applyProjectItems,
// documentExtras, the workspace tabs, the document migrations and
// LocalEngine.reconcileItems. Each block cites what it ports.
#include "docio.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <set>

#include "anim_json.hpp"
#include "catalog_data.hpp"
#include "engine_ctx.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "values.hpp"

namespace premation::doc {
namespace {

constexpr std::string_view kCurrentVersion = "1.9.0";

// ── small JSON helpers ───────────────────────────────────────────────────

Json str_list(const std::vector<std::string>& v) {
  Json a = Json::array();
  for (const auto& s : v) a.arr_mut().push_back(Json::string(s));
  return a;
}

bool nullish(const Json& v) { return v.is_undefined() || v.is_null(); }

bool truthy(const Json& v) {
  switch (v.kind()) {
    case Json::Kind::undefined:
    case Json::Kind::null: return false;
    case Json::Kind::boolean: return v.b();
    case Json::Kind::number: return v.num() != 0 && !std::isnan(v.num());
    case Json::Kind::string: return !v.str().empty();
    default: return true;
  }
}

double jnum(const Json& v, double fb) { return v.is_number() ? v.num() : fb; }

std::uint32_t u32_of(double v) {
  if (!(v > 0) || !std::isfinite(v)) return 0;
  if (v > 4294967295.0) return 0xFFFFFFFFU;
  return static_cast<std::uint32_t>(v);
}

template <class E>
void read_enum(const Json& v, E& out) {
  if (!v.is_string()) return;
  if (const auto e = enum_from_string<E>(v.str())) out = *e;
}

// ── scene (sceneProjectIO) ───────────────────────────────────────────────

Json node_json(const Node& n) {
  Json o = Json::object();
  o.set("id", Json::string(n.id));
  o.set("name", Json::string(n.name));
  o.set("children", str_list(n.children));
  o.set("parent", n.parent ? Json::string(*n.parent) : Json::null());
  // The AppNodeView `transform` getter: x/y/rotation of the last component
  // carrying each as a number; scale is always 1 (the getter's contract).
  double x = 0;
  double y = 0;
  double rotation = 0;
  for (const Component& c : n.components) {
    if (c.props.at("x").is_number()) x = c.props.at("x").num();
    if (c.props.at("y").is_number()) y = c.props.at("y").num();
    if (c.props.at("rotation").is_number()) rotation = c.props.at("rotation").num();
  }
  Json tf = Json::object();
  Json pos = Json::object();
  pos.set("x", Json::number(x));
  pos.set("y", Json::number(y));
  tf.set("position", std::move(pos));
  tf.set("rotation", Json::number(rotation));
  Json sc = Json::object();
  sc.set("x", Json::number(1));
  sc.set("y", Json::number(1));
  tf.set("scale", std::move(sc));
  o.set("transform", std::move(tf));
  Json comps = Json::array();
  for (const Component& c : n.components) {
    Json cj = Json::object();
    cj.set("id", Json::string(c.id));
    cj.set("type", Json::string(c.type));
    cj.set("props", c.props);
    comps.arr_mut().push_back(std::move(cj));
  }
  o.set("components", std::move(comps));
  o.set("visible", Json::boolean(n.visible));
  o.set("locked", Json::boolean(n.locked));
  o.set("solo", Json::boolean(n.solo));
  if (n.shy) o.set("shy", Json::boolean(true));
  if (n.color) o.set("color", Json::string(*n.color));
  return o;
}

// ── animation (AnimationEngine.snapshot / restore) ───────────────────────

Json animation_json(const Document& d) {
  Json tracks = Json::object();
  Json exprs = Json::object();
  Json data = Json::object();
  bool hasData = false;
  for (const auto& [id, a] : d.anims()) {
    const Json node = anim_to_json(*a, id);
    if (!a->tracks.empty()) {
      Json props = Json::object();
      for (const auto& m : node.at("tracks").obj()) {
        Json t = Json::object();
        t.set("nodeId", Json::string(id));
        t.set("prop", Json::string(m.key));
        t.set("keyframes", m.value);
        props.set(m.key, std::move(t));
      }
      tracks.set(id, std::move(props));
    }
    if (!a->exprs.empty()) exprs.set(id, node.at("expressions"));
    if (!a->data.empty()) {
      data.set(id, node.at("data"));
      hasData = true;
    }
  }
  Json out = Json::object();
  out.set("tracks", std::move(tracks));
  out.set("expressions", std::move(exprs));
  if (hasData) out.set("data", std::move(data));
  return out;
}

void restore_animation(Document& d, const Json& anim) {
  // Nodes in first-seen order over data, tracks, expressions (restore()'s order).
  std::vector<std::string> order;
  std::set<std::string, std::less<>> seen;
  for (const char* section : {"data", "tracks", "expressions"}) {
    if (!anim.at(section).is_object()) continue;
    for (const auto& m : anim.at(section).obj()) {
      if (seen.insert(m.key).second) order.push_back(m.key);
    }
  }
  for (const auto& id : order) {
    Json snap = Json::object();
    snap.set("tracks", anim.at("tracks").at(id).is_object() ? anim.at("tracks").at(id) : Json::object());
    snap.set("expressions", anim.at("expressions").at(id).is_object() ? anim.at("expressions").at(id) : Json::object());
    snap.set("data", anim.at("data").at(id).is_object() ? anim.at("data").at(id) : Json::object());
    NodeAnim a = anim_from_json(snap);
    NodeAnim clean;
    clean.tracks = a.tracks;
    clean.data = a.data;
    for (const auto& [prop, e] : a.exprs) {
      if (!e.src.empty()) clean.exprs.set(prop, e);  // `if (state?.src)`
    }
    if (!clean.empty()) d.set_anim(id, std::move(clean));
  }
}

// ── timelines (packages/timeline Serializer) ─────────────────────────────

Json range_json(const std::optional<FrameRange>& r) {
  if (!r) return Json::null();
  Json o = Json::object();
  o.set("start", Json::number(r->start));
  o.set("duration", Json::number(r->duration));
  return o;
}

std::optional<FrameRange> range_of(const Json& j) {
  if (!j.is_object()) return std::nullopt;
  return FrameRange{jnum(j.at("start"), 0), jnum(j.at("duration"), 0)};
}

Json marker_json(const TMarker& m) {
  Json o = Json::object();
  o.set("id", Json::string(m.id));
  o.set("frame", Json::number(m.frame));
  o.set("duration", Json::number(m.duration));
  o.set("name", Json::string(m.name));
  o.set("color", m.color ? Json::string(*m.color) : Json::null());
  o.set("comment", Json::string(m.comment));
  o.set("scope", Json::string(m.scope));
  o.set("ownerId", m.ownerId ? Json::string(*m.ownerId) : Json::null());
  if (!m.chapter.empty()) o.set("chapter", Json::string(m.chapter));
  if (!m.url.empty()) o.set("url", Json::string(m.url));
  if (!m.cuePoint.empty()) o.set("cuePoint", Json::string(m.cuePoint));
  if (m.protectedRegion) o.set("protectedRegion", Json::boolean(true));
  return o;
}

/// `new Marker(data)`.
TMarker marker_of(const Json& j) {
  TMarker m;
  m.id = j.at("id").is_string() ? j.at("id").str() : "";
  m.frame = jnum(j.at("frame"), 0);
  m.duration = std::max(0.0, jnum(j.at("duration"), 0));
  m.name = j.at("name").is_string() ? j.at("name").str() : "";
  if (j.at("color").is_string()) m.color = j.at("color").str();
  m.comment = j.at("comment").is_string() ? j.at("comment").str() : "";
  m.scope = j.at("scope").is_string() ? j.at("scope").str() : "timeline";
  if (j.at("ownerId").is_string()) m.ownerId = j.at("ownerId").str();
  m.chapter = j.at("chapter").is_string() ? j.at("chapter").str() : "";
  m.url = j.at("url").is_string() ? j.at("url").str() : "";
  m.cuePoint = j.at("cuePoint").is_string() ? j.at("cuePoint").str() : "";
  m.protectedRegion = j.at("protectedRegion").is_bool() && j.at("protectedRegion").b();
  return m;
}

Json markers_json(const std::vector<TMarker>& ms) {
  Json a = Json::array();
  for (const TMarker& m : ms) a.arr_mut().push_back(marker_json(m));
  return a;
}

std::vector<TMarker> markers_of(const Json& j) {
  std::vector<TMarker> out;
  if (!j.is_array()) return out;
  for (const Json& m : j.arr()) {
    if (m.is_object()) markers_insert(out, marker_of(m));
  }
  return out;
}

Json timeline_json(const std::string& comp, const Timeline& t) {
  const std::string trackId = "track_" + comp;
  Json layers = Json::array();
  for (const Bar& b : t.bars) {
    Json l = Json::object();
    l.set("id", Json::string(b.id));
    l.set("name", Json::string(b.name));
    l.set("trackId", Json::string(trackId));
    Json clip = Json::object();
    clip.set("start", Json::number(b.clip.start));
    clip.set("duration", Json::number(b.clip.duration));
    clip.set("sourceIn", Json::number(b.clip.sourceIn));
    clip.set("sourceDuration", b.clip.sourceDuration ? Json::number(*b.clip.sourceDuration) : Json::null());
    l.set("clip", std::move(clip));
    l.set("enabled", Json::boolean(b.enabled));
    l.set("locked", Json::boolean(b.locked));
    l.set("sourceId", b.sourceId ? Json::string(*b.sourceId) : Json::null());
    l.set("markers", markers_json(b.markers));
    l.set("metadata", Json::object());
    layers.arr_mut().push_back(std::move(l));
  }
  Json track = Json::object();
  track.set("id", Json::string(trackId));
  track.set("name", Json::string("Composition"));
  track.set("kind", Json::string("group"));
  track.set("layers", std::move(layers));
  Json flags = Json::object();
  for (const char* f : {"locked", "hidden", "muted", "solo"}) flags.set(f, Json::boolean(false));
  track.set("flags", std::move(flags));
  track.set("height", Json::number(28));
  track.set("groupId", Json::null());
  track.set("markers", Json::array());
  track.set("metadata", Json::object());
  Json o = Json::object();
  o.set("version", Json::number(1));
  o.set("id", Json::string("timeline_" + comp));
  o.set("name", Json::string("Composition"));
  Json fr = Json::object();
  fr.set("fps", Json::number(t.fps));
  fr.set("nominal", Json::number(motion::js::round(t.fps)));
  fr.set("dropFrame", Json::boolean(false));
  o.set("frameRate", std::move(fr));
  o.set("duration", Json::number(t.duration));
  Json tracks = Json::array();
  tracks.arr_mut().push_back(std::move(track));
  o.set("tracks", std::move(tracks));
  o.set("groups", Json::array());
  o.set("markers", markers_json(t.markers));
  Json ranges = Json::object();
  ranges.set("loop", range_json(t.loop));
  ranges.set("preview", Json::null());
  ranges.set("workArea", range_json(t.workArea));
  o.set("ranges", std::move(ranges));
  // No `view` / `currentFrame` and no `openTabs` below: editor state never
  // enters the project document (B4, src/core/project/editorView.ts); a file
  // that still carries them is read (view_of_tabs) and saved without them.
  return o;
}

/// TimelineController.restore for one composition: initTimeline, then
/// applySerializedTimeline (only the composition track is modelled).
Timeline timeline_of(const Document& d, const std::string& comp, const Json& j) {
  Timeline t;
  const Json* rec = d.comp(comp);
  const double recFps = rec != nullptr ? jnum(rec->at("fps"), 30) : 30;
  const double recDur = rec != nullptr ? jnum(rec->at("durationSeconds"), 10) : 10;
  t.fps = recFps;
  t.duration = std::max(1.0, motion::js::round(recDur * recFps));
  if (j.at("frameRate").is_object() && j.at("frameRate").at("fps").is_number()) t.fps = j.at("frameRate").at("fps").num();
  if (j.at("duration").is_number()) t.duration = std::max(0.0, motion::js::round(j.at("duration").num()));
  const Json& ranges = j.at("ranges");
  t.loop = range_of(ranges.at("loop"));
  t.workArea = range_of(ranges.at("workArea"));
  t.markers = markers_of(j.at("markers"));
  const Json& tracks = j.at("tracks");
  if (tracks.is_array() && !tracks.arr().empty()) {
    const Json* compTrack = &tracks.arr()[0];
    for (const Json& tr : tracks.arr()) {
      if (tr.at("name").is_string() && tr.at("name").str() == "Composition") {
        compTrack = &tr;
        break;
      }
    }
    if (compTrack->at("layers").is_array()) {
      for (const Json& l : compTrack->at("layers").arr()) {
        Bar b;
        b.id = l.at("id").is_string() ? l.at("id").str() : "";
        b.name = l.at("name").is_string() ? l.at("name").str() : "Layer";
        const Json& c = l.at("clip");
        b.clip.start = jnum(c.at("start"), 0);
        b.clip.duration = std::max(0.0, jnum(c.at("duration"), 0));
        b.clip.sourceIn = jnum(c.at("sourceIn"), 0);
        if (c.at("sourceDuration").is_number()) b.clip.sourceDuration = c.at("sourceDuration").num();
        b.enabled = !(l.at("enabled").is_bool() && !l.at("enabled").b());
        b.locked = l.at("locked").is_bool() && l.at("locked").b();
        if (l.at("sourceId").is_string()) b.sourceId = l.at("sourceId").str();
        b.markers = markers_of(l.at("markers"));
        t.bars.push_back(std::move(b));
      }
    }
  }
  return t;
}

// ── project items (assetStore) ───────────────────────────────────────────

Json folder_json(const Folder& f) {
  Json o = Json::object();
  o.set("id", Json::string(f.id));
  o.set("name", Json::string(f.name));
  o.set("parentId", f.parentId ? Json::string(*f.parentId) : Json::null());
  return o;
}

Folder folder_of(const Json& j) {
  Folder f;
  f.id = j.at("id").is_string() ? j.at("id").str() : "";
  f.name = j.at("name").is_string() ? j.at("name").str() : "";
  if (j.at("parentId").is_string()) f.parentId = j.at("parentId").str();
  return f;
}

/// `docRecordOf(a)`.
Json doc_record_of(const Json& a) {
  Json r = Json::object();
  r.set("name", a.at("name"));
  r.set("type", a.at("type"));
  if (truthy(a.at("path"))) r.set("path", a.at("path"));
  const Json& proxy = a.at("proxy");
  if (truthy(proxy.at("userSupplied")) && truthy(proxy.at("src"))) {
    Json p = Json::object();
    p.set("src", proxy.at("src"));
    p.set("enabled", Json::boolean(proxy.at("status").is_string() && proxy.at("status").str() == "ready"));
    r.set("proxy", std::move(p));
  }
  if (truthy(a.at("folderId"))) r.set("folderId", a.at("folderId"));
  if (a.at("interpret").is_object() && !a.at("interpret").obj().empty()) r.set("interpret", a.at("interpret"));
  if (truthy(a.at("label"))) r.set("label", a.at("label"));
  if (a.at("tags").is_array() && !a.at("tags").arr().empty()) r.set("tags", a.at("tags"));
  if (truthy(a.at("comment"))) r.set("comment", a.at("comment"));
  return r;
}

/// `withDocRecord(a, r)`.
Json with_doc_record(const Json& a, const Json& r) {
  if (!r.is_object()) return a;
  Json next = a;
  // Name and path describe the file: overlays (a partial record keeps them).
  for (const char* k : {"name", "path"}) {
    if (!r.at(k).is_undefined()) next.set(k, r.at(k));
  }
  // The ORGANISATION is stated whole by the record (assetStore.withDocRecord,
  // 674bf37d): absent means none, never what the item carried before.
  next.set("folderId", nullish(r.at("folderId")) ? Json::null() : r.at("folderId"));
  for (const char* k : {"interpret", "label", "tags", "comment"}) {
    if (!r.at(k).is_undefined()) next.set(k, r.at(k));
    else next.erase(k);
  }
  if (!r.at("proxy").is_undefined()) {
    const Json& rp = r.at("proxy");
    Json p = a.at("proxy").is_object() ? a.at("proxy") : Json::object();
    p.set("status", Json::string(truthy(rp.at("enabled")) ? "ready" : "none"));
    p.set("src", rp.at("src"));
    p.set("userSupplied", Json::boolean(true));
    next.set("proxy", std::move(p));
  }
  return next;
}

// ── documentExtras ───────────────────────────────────────────────────────

Json project_settings_json(const api::ProjectSettings& s) {
  Json o = Json::object();
  o.set("bitDepth", Json::string(std::string(api::to_string(s.bit_depth))));
  o.set("workingSpace", Json::string(std::string(api::to_string(s.working_space))));
  o.set("linearBlending", Json::boolean(s.linear_blending));
  o.set("ocioConfig", Json::string(s.ocio_config));
  o.set("timeDisplay", Json::string(std::string(api::to_string(s.time_display))));
  o.set("expressionEngine", Json::string(std::string(api::to_string(s.expression_engine))));
  o.set("framesStartAt", Json::number(s.frames_start_at));
  o.set("audioSampleRate", Json::number(s.audio_sample_rate));
  return o;
}

api::ProjectSettings project_settings_of(const Json& j) {
  api::ProjectSettings s = default_project_settings();
  if (!j.is_object()) return s;
  read_enum(j.at("bitDepth"), s.bit_depth);
  read_enum(j.at("workingSpace"), s.working_space);
  if (j.at("linearBlending").is_bool()) s.linear_blending = j.at("linearBlending").b();
  if (j.at("ocioConfig").is_string()) s.ocio_config = j.at("ocioConfig").str();
  read_enum(j.at("timeDisplay"), s.time_display);
  read_enum(j.at("expressionEngine"), s.expression_engine);
  if (j.at("framesStartAt").is_number()) s.frames_start_at = u32_of(j.at("framesStartAt").num());
  if (j.at("audioSampleRate").is_number()) s.audio_sample_rate = u32_of(j.at("audioSampleRate").num());
  return s;
}

Json time_range_json(const api::TimeRange& r) {
  Json o = Json::object();
  o.set("start", Json::number(static_cast<double>(r.start)));
  o.set("duration", Json::number(static_cast<double>(r.duration)));
  return o;
}

Json render_item_json(const api::RenderItemInfo& r) {
  const api::RenderSettings& s = r.settings;
  Json st = Json::object();
  st.set("format", Json::string(s.format));
  st.set("outputPath", Json::string(s.output_path));
  st.set("range", time_range_json(s.range));
  st.set("bitDepth", Json::string(std::string(api::to_string(s.bit_depth))));
  st.set("includeAudio", Json::boolean(s.include_audio));
  st.set("includeAlpha", Json::boolean(s.include_alpha));
  st.set("quality", Json::number(s.quality));
  st.set("outputColorSpace", Json::string(s.output_color_space));
  st.set("motionBlur", Json::boolean(s.motion_blur));
  st.set("frameBlending", Json::boolean(s.frame_blending));
  if (s.width) st.set("width", Json::number(*s.width));
  if (s.height) st.set("height", Json::number(*s.height));
  if (s.frame_rate) {
    Json fr = Json::object();
    fr.set("num", Json::number(s.frame_rate->num));
    fr.set("den", Json::number(s.frame_rate->den));
    st.set("frameRate", std::move(fr));
  }
  if (s.encoder_options) st.set("encoderOptions", Json::string(*s.encoder_options));
  Json o = Json::object();
  o.set("id", Json::string(r.id));
  o.set("comp", Json::string(r.comp));
  o.set("settings", std::move(st));
  o.set("status", Json::string(std::string(api::to_string(r.status))));
  o.set("queued", Json::boolean(r.queued));
  o.set("progress", Json::number(r.progress));
  o.set("error", Json::string(r.error));
  return o;
}

api::Time time_of(const Json& v) {
  if (!v.is_number() || !std::isfinite(v.num())) return 0;
  return static_cast<api::Time>(v.num());
}

api::RenderItemInfo render_item_of(const Json& j) {
  api::RenderItemInfo r;
  r.id = j.at("id").is_string() ? j.at("id").str() : "";
  r.comp = j.at("comp").is_string() ? j.at("comp").str() : "";
  const Json& s = j.at("settings");
  r.settings.format = s.at("format").is_string() ? s.at("format").str() : "";
  r.settings.output_path = s.at("outputPath").is_string() ? s.at("outputPath").str() : "";
  r.settings.range = api::TimeRange{time_of(s.at("range").at("start")), time_of(s.at("range").at("duration"))};
  if (s.at("width").is_number()) r.settings.width = u32_of(s.at("width").num());
  if (s.at("height").is_number()) r.settings.height = u32_of(s.at("height").num());
  if (s.at("frameRate").is_object()) {
    r.settings.frame_rate = api::Rational{u32_of(jnum(s.at("frameRate").at("num"), 0)), u32_of(jnum(s.at("frameRate").at("den"), 0))};
  }
  read_enum(s.at("bitDepth"), r.settings.bit_depth);
  r.settings.include_audio = s.at("includeAudio").b();
  r.settings.include_alpha = s.at("includeAlpha").b();
  r.settings.quality = jnum(s.at("quality"), 0);
  r.settings.output_color_space = s.at("outputColorSpace").is_string() ? s.at("outputColorSpace").str() : "";
  r.settings.motion_blur = s.at("motionBlur").b();
  r.settings.frame_blending = s.at("frameBlending").b();
  if (s.at("encoderOptions").is_string()) r.settings.encoder_options = s.at("encoderOptions").str();
  read_enum(j.at("status"), r.status);
  r.queued = j.at("queued").b();
  r.progress = jnum(j.at("progress"), 0);
  r.error = j.at("error").is_string() ? j.at("error").str() : "";
  return r;
}

// ── migrations (src/core/project/migrations) ────────────────────────────

int compare_versions(std::string_view a, std::string_view b) {
  auto parts = [](std::string_view s) {
    std::vector<double> out;
    std::size_t i = 0;
    while (true) {
      const std::size_t dot = s.find('.', i);
      const std::string_view seg = s.substr(i, dot == std::string_view::npos ? std::string_view::npos : dot - i);
      double v = 0;  // parseInt: leading digits, else 0
      for (const char ch : seg) {
        if (ch < '0' || ch > '9') break;
        v = v * 10 + (ch - '0');
      }
      out.push_back(v);
      if (dot == std::string_view::npos) break;
      i = dot + 1;
    }
    return out;
  };
  const auto pa = parts(a);
  const auto pb = parts(b);
  for (std::size_t i = 0; i < std::max(pa.size(), pb.size()); ++i) {
    const double x = i < pa.size() ? pa[i] : 0;
    const double y = i < pb.size() ? pb[i] : 0;
    if (x != y) return x < y ? -1 : 1;
  }
  return 0;
}

template <class F>
void each_fx(Json& doc, F&& fn) {
  Json* nodes = doc.find_mut("scene") != nullptr ? doc.find_mut("scene")->find_mut("nodes") : nullptr;
  if (nodes == nullptr || !nodes->is_array()) return;
  for (Json& n : nodes->arr_mut()) {
    Json* comps = n.find_mut("components");
    if (comps == nullptr || !comps->is_array()) continue;
    for (Json& c : comps->arr_mut()) fn(n, c);
  }
}

/// `readMatte(v)`.
std::optional<Json> read_matte(const Json& v) {
  auto legacy = [](const Json& s) -> std::optional<std::pair<std::string, bool>> {
    if (!s.is_string()) return std::nullopt;
    const std::string& k = s.str();
    if (k == "alpha") return std::pair<std::string, bool>{"alpha", false};
    if (k == "alpha-inv") return std::pair<std::string, bool>{"alpha", true};
    if (k == "luma") return std::pair<std::string, bool>{"luma", false};
    if (k == "luma-inv") return std::pair<std::string, bool>{"luma", true};
    return std::nullopt;
  };
  auto make = [](const std::string& mode, bool inv, const Json& sourceId) {
    Json o = Json::object();
    o.set("mode", Json::string(mode));
    o.set("inverted", Json::boolean(inv));
    if (sourceId.is_string() && !sourceId.str().empty()) o.set("sourceId", sourceId);
    return o;
  };
  if (!truthy(v) || (v.is_string() && v.str() == "none")) return std::nullopt;
  if (const auto l = legacy(v)) return make(l->first, l->second, Json());
  if (v.is_object()) {
    const Json& mode = v.at("mode");
    if (mode.is_string() && (mode.str() == "alpha" || mode.str() == "luma")) {
      return make(mode.str(), v.at("inverted").is_bool() && v.at("inverted").b(), v.at("sourceId"));
    }
    if (const auto l = legacy(mode)) return make(l->first, l->second, v.at("sourceId"));
  }
  return std::nullopt;
}

void rename_tracks(Json& doc, const std::string& nodeId, const std::vector<std::pair<std::string, std::string>>& renames) {
  Json* anim = doc.find_mut("animation");
  Json* tracks = anim != nullptr ? anim->find_mut("tracks") : nullptr;
  Json* nt = tracks != nullptr ? tracks->find_mut(nodeId) : nullptr;
  if (nt == nullptr || !nt->is_object()) return;
  for (const auto& [from, to] : renames) {
    const Json* t = nt->find(from);
    if (t == nullptr || t->is_undefined()) continue;
    Json moved = *t;
    nt->set(to, std::move(moved));
    nt->erase(from);
  }
}

std::string node_id_of(const Json& n) { return n.at("id").is_string() ? n.at("id").str() : ""; }

void m_1_0(Json& doc) {
  if (doc.at("comps").is_object() && !doc.at("comps").obj().empty()) return;
  if (!doc.at("comp").is_object()) return;
  Json comps = Json::object();
  comps.set(doc.at("comp").at("id").is_string() ? doc.at("comp").at("id").str() : "undefined", doc.at("comp"));
  doc.set("comps", std::move(comps));
}

void m_1_1(Json& doc) {
  each_fx(doc, [](Json& /*n*/, Json& c) {
    if (!(c.at("type").is_string() && c.at("type").str() == "fx")) return;
    Json* props = c.find_mut("props");
    if (props == nullptr || !props->is_object()) return;
    const Json raw = props->at("matte");
    if (nullish(raw)) return;
    const auto norm = read_matte(raw);
    if (!norm) {
      props->erase("matte");
      return;
    }
    const bool current = raw.is_object() && raw.at("mode").is_string() &&
                         (raw.at("mode").str() == "alpha" || raw.at("mode").str() == "luma") && raw.at("inverted").is_bool();
    if (!current) props->set("matte", *norm);
  });
}

void m_1_2(Json& doc) {
  std::vector<std::string> renamed;
  each_fx(doc, [&renamed](Json& n, Json& c) {
    if (!(c.at("type").is_string() && c.at("type").str() == "fx")) return;
    Json* props = c.find_mut("props");
    if (props == nullptr || !props->is_object()) return;
    const Json legacy = props->at("pathOp");
    if (props->at("pathOps").is_array()) {
      if (!legacy.is_undefined()) props->erase("pathOp");
      return;
    }
    if (!truthy(legacy) || !legacy.is_object()) return;
    const std::string nodeId = node_id_of(n);
    Json op = legacy;
    op.set("id", Json::string("op_" + nodeId));
    Json ops = Json::array();
    ops.arr_mut().push_back(std::move(op));
    props->set("pathOps", std::move(ops));
    props->erase("pathOp");
    if (!nodeId.empty()) renamed.push_back(nodeId);
  });
  for (const auto& nodeId : renamed) {
    Json* anim = doc.find_mut("animation");
    Json* tracks = anim != nullptr ? anim->find_mut("tracks") : nullptr;
    Json* nt = tracks != nullptr ? tracks->find_mut(nodeId) : nullptr;
    if (nt == nullptr || !nt->is_object()) continue;
    std::vector<std::pair<std::string, std::string>> r;
    for (const auto& m : nt->obj()) {
      if (!m.key.starts_with("pathop.")) continue;
      const std::string param = m.key.substr(7);
      if (param.find('.') != std::string::npos) continue;
      r.emplace_back(m.key, "pathop.op_" + nodeId + "." + param);
    }
    rename_tracks(doc, nodeId, r);
  }
}

/// 1.3 (trim) and 1.4 (repeater): a legacy fx stage appended to fx.pathOps.
void m_fold(Json& doc, const char* key, const std::string& prefix, const std::vector<std::string>& params,
            const std::function<Json(const Json&, const std::string&)>& make) {
  std::vector<std::string> renamed;
  each_fx(doc, [&](Json& n, Json& c) {
    if (!(c.at("type").is_string() && c.at("type").str() == "fx")) return;
    Json* props = c.find_mut("props");
    if (props == nullptr || !props->is_object()) return;
    const Json legacy = props->at(key);
    if (!truthy(legacy) || !legacy.is_object()) return;
    const std::string nodeId = node_id_of(n);
    Json ops = props->at("pathOps").is_array() ? props->at("pathOps") : Json::array();
    ops.arr_mut().push_back(make(legacy, prefix + nodeId));
    props->set("pathOps", std::move(ops));
    props->erase(key);
    if (!nodeId.empty()) renamed.push_back(nodeId);
  });
  for (const auto& nodeId : renamed) {
    std::vector<std::pair<std::string, std::string>> r;
    for (const auto& p : params) r.emplace_back(std::string(key == std::string_view("trim") ? "trim." : "rep.") + p, "pathop." + prefix + nodeId + "." + p);
    rename_tracks(doc, nodeId, r);
  }
}

void m_1_5(Json& doc) {
  Json* anim = doc.find_mut("animation");
  Json* exprs = anim != nullptr ? anim->find_mut("expressions") : nullptr;
  if (exprs == nullptr || !exprs->is_object()) return;
  for (auto& m : exprs->obj_mut()) {
    if (!m.value.is_object()) continue;
    std::vector<std::string> drop;
    for (auto& e : m.value.obj_mut()) {
      if (!e.value.is_string()) continue;
      bool blank = true;
      for (const char ch : e.value.str()) blank = blank && (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\f' || ch == '\v');
      if (blank) {
        drop.push_back(e.key);
      } else {
        Json st = Json::object();
        st.set("src", e.value);
        st.set("enabled", Json::boolean(true));
        e.value = std::move(st);
      }
    }
    for (const auto& k : drop) m.value.erase(k);
  }
}

void m_1_6(Json& doc) {
  each_fx(doc, [](Json& /*n*/, Json& c) {
    if (!(c.at("type").is_string() && c.at("type").str() == "fx")) return;
    Json* props = c.find_mut("props");
    Json* ops = props != nullptr ? props->find_mut("pathOps") : nullptr;
    if (ops == nullptr || !ops->is_array()) return;
    for (Json& op : ops->arr_mut()) {
      if (!op.is_object() || !op.has("trimMultiple")) continue;
      if (op.at("type").is_string() && op.at("type").str() == "trim") {
        const Json& legacy = op.at("trimMultiple");
        op.set("trimMultipleShapes",
               Json::string(legacy.is_string() && legacy.str() == "simultaneously" ? "individually" : "simultaneously"));
      }
      op.erase("trimMultiple");
    }
  });
}

void m_1_7(Json& doc) {
  Json* nodes = doc.find_mut("scene") != nullptr ? doc.find_mut("scene")->find_mut("nodes") : nullptr;
  if (nodes == nullptr || !nodes->is_array()) return;
  for (Json& n : nodes->arr_mut()) {
    Json* comps = n.find_mut("components");
    if (comps == nullptr || !comps->is_array()) continue;
    for (Json& c : comps->arr_mut()) {
      if (!(c.at("type").is_string() && c.at("type").str() == "Transform")) continue;
      Json* p = c.find_mut("props");
      if (p == nullptr || !p->is_object()) continue;
      const bool light = (p->at("__kind").is_string() && p->at("__kind").str() == "light") || p->at("lightType").is_string();
      if (!light) continue;
      if (p->at("falloff").is_undefined()) p->set("falloff", Json::string("legacy"));
      break;  // lightTransform: the first matching component
    }
  }
}

void m_1_8(Json& doc) {
  std::vector<Json*> keys;
  Json* anim = doc.find_mut("animation");
  for (const char* section : {"tracks", "data"}) {
    Json* s = anim != nullptr ? anim->find_mut(section) : nullptr;
    if (s == nullptr || !s->is_object()) continue;
    for (auto& node : s->obj_mut()) {
      if (!node.value.is_object()) continue;
      for (auto& prop : node.value.obj_mut()) {
        Json* kfs = prop.value.find_mut("keyframes");
        if (kfs == nullptr || !kfs->is_array()) continue;
        for (Json& k : kfs->arr_mut()) {
          if (k.is_object()) keys.push_back(&k);
        }
      }
    }
  }
  Json* nodes = doc.find_mut("scene") != nullptr ? doc.find_mut("scene")->find_mut("nodes") : nullptr;
  if (nodes != nullptr && nodes->is_array()) {
    for (Json& n : nodes->arr_mut()) {
      Json* comps = n.find_mut("components");
      if (comps == nullptr || !comps->is_array()) continue;
      for (Json& c : comps->arr_mut()) {
        if (!(c.at("type").is_string() && c.at("type").str() == "fx")) continue;
        Json* props = c.find_mut("props");
        Json* ma = props != nullptr ? props->find_mut("maskAnim") : nullptr;
        if (ma == nullptr || !ma->is_array()) continue;
        for (Json& k : ma->arr_mut()) {
          if (k.is_object()) keys.push_back(&k);
        }
      }
    }
  }
  double max = 0;
  bool missing = false;
  for (const Json* k : keys) {
    const Json& id = k->at("id");
    if (!id.is_string() || id.str().empty()) missing = true;
    else max = std::max(max, stable_keyframe_id_seq(id.str()));
  }
  if (!missing) return;
  for (Json* k : keys) {
    const Json& id = k->at("id");
    if (!id.is_string() || id.str().empty()) {
      max += 1;
      k->set("id", Json::string("k" + js::number_to_string(max)));
    }
  }
}

// ── workspace tabs ───────────────────────────────────────────────────────

/// `hydrateWorkspaceTabs(snap)` → the active tab's composition and time.
EditorView view_of_tabs(const Json& snap) {
  EditorView v;
  if (!snap.at("tabOrder").is_array() || !snap.at("tabs").is_object()) return v;
  std::vector<std::string> order;
  for (const Json& id : snap.at("tabOrder").arr()) {
    if (id.is_string() && snap.at("tabs").at(id.str()).is_object()) order.push_back(id.str());
  }
  if (order.empty()) return v;
  const Json& act = snap.at("activeTabId");
  const std::string active = act.is_string() && snap.at("tabs").at(act.str()).is_object() ? act.str() : order[0];
  const Json& t = snap.at("tabs").at(active);
  if (t.at("compositionId").is_string()) v.tabComp = t.at("compositionId").str();
  v.tabTime = jnum(t.at("time"), 0);
  return v;
}

}  // namespace

Node node_from_json(const Json& o) {
  Node n;
  n.id = o.at("id").is_string() ? o.at("id").str() : "";
  n.name = o.at("name").is_string() ? o.at("name").str() : "";
  if (o.at("children").is_array()) {
    for (const Json& c : o.at("children").arr()) {
      if (c.is_string()) n.children.push_back(c.str());
    }
  }
  if (o.at("parent").is_string()) n.parent = o.at("parent").str();
  if (o.at("components").is_array()) {
    for (const Json& c : o.at("components").arr()) {
      const std::string type = c.at("type").is_string() ? c.at("type").str() : "";
      Component comp{c.at("id").is_string() ? c.at("id").str() : "", type,
                     c.at("props").is_object() ? c.at("props") : Json::object()};
      // addComponent replaces a component of the same type.
      std::erase_if(n.components, [&type](const Component& x) { return x.type == type; });
      n.components.push_back(std::move(comp));
    }
  }
  n.visible = !(o.at("visible").is_bool() && !o.at("visible").b());
  n.locked = truthy(o.at("locked"));
  n.solo = truthy(o.at("solo"));
  n.shy = truthy(o.at("shy"));
  if (o.at("color").is_string()) n.color = o.at("color").str();
  return n;
}

Json migrate_document(Json doc) {
  const std::string from = doc.at("version").is_string() ? doc.at("version").str() : "1.0.0";
  const int delta = compare_versions(from, kCurrentVersion);
  if (delta > 0) {
    fail(api::ErrorCode::io, "This project was saved by a newer version of Premation (document " + from +
                                 "; this build understands " + std::string(kCurrentVersion) + "). Update the app to open it.");
  }
  if (delta == 0) return doc;
  const auto trim = [](const Json& t, const std::string& id) {
    Json o = Json::object();
    o.set("id", Json::string(id));
    o.set("type", Json::string("trim"));
    o.set("amount", Json::number(0));
    o.set("detail", Json::number(0));
    o.set("start", Json::number(jnum(t.at("start"), 0)));
    o.set("end", Json::number(jnum(t.at("end"), 100)));
    o.set("offset", Json::number(jnum(t.at("offset"), 0)));
    return o;
  };
  const auto repeater = [](const Json& r, const std::string& id) {
    Json o = Json::object();
    o.set("id", Json::string(id));
    o.set("type", Json::string("repeater"));
    o.set("amount", Json::number(0));
    o.set("detail", Json::number(0));
    o.set("copies", Json::number(jnum(r.at("copies"), 6)));
    o.set("offsetX", Json::number(jnum(r.at("offsetX"), 80)));
    o.set("offsetY", Json::number(jnum(r.at("offsetY"), 0)));
    o.set("offsetRotation", Json::number(jnum(r.at("offsetRotation"), 0)));
    o.set("offsetScale", Json::number(jnum(r.at("offsetScale"), 1)));
    o.set("offsetOpacity", Json::number(jnum(r.at("offsetOpacity"), 1)));
    o.set("offset", Json::number(jnum(r.at("offset"), 0)));
    o.set("anchorX", Json::number(jnum(r.at("anchorX"), 0)));
    o.set("anchorY", Json::number(jnum(r.at("anchorY"), 0)));
    o.set("composite", Json::string(r.at("composite").is_string() && r.at("composite").str() == "below" ? "below" : "above"));
    return o;
  };
  struct Step {
    const char* from;
    std::function<void(Json&)> run;
  };
  const std::vector<Step> steps = {
      {"1.0.0", m_1_0},
      {"1.1.0", m_1_1},
      {"1.2.0", m_1_2},
      {"1.3.0", [&](Json& j) { m_fold(j, "trim", "trimop_", {"start", "end", "offset"}, trim); }},
      {"1.4.0", [&](Json& j) {
         m_fold(j, "repeater", "repop_",
                {"copies", "offsetX", "offsetY", "offsetRotation", "offsetScale", "offsetOpacity", "offset", "anchorX", "anchorY"},
                repeater);
       }},
      {"1.5.0", m_1_5},
      {"1.6.0", m_1_6},
      {"1.7.0", m_1_7},
      {"1.8.0", m_1_8},
  };
  std::string current = from;
  for (std::size_t guard = 0; guard <= steps.size(); ++guard) {
    if (compare_versions(current, kCurrentVersion) == 0) {
      doc.set("version", Json::string(std::string(kCurrentVersion)));
      return doc;
    }
    const auto it = std::find_if(steps.begin(), steps.end(), [&](const Step& s) { return compare_versions(s.from, current) == 0; });
    if (it == steps.end()) {
      fail(api::ErrorCode::io, "No migration path from document version " + current + " to " + std::string(kCurrentVersion) + ".");
    }
    it->run(doc);
    const std::size_t idx = static_cast<std::size_t>(it - steps.begin());
    current = idx + 1 < steps.size() ? steps[idx + 1].from : std::string(kCurrentVersion);
  }
  fail(api::ErrorCode::io, "Migration chain from " + from + " did not terminate.");
}

// ── Document extras: guides, swatches, materials, transitions, plugin storage ──
// The stores' document halves (guidesStore settings()/restore, swatchStore
// normalizeSwatches, materialStore normalizeMaterials, transitionStore,
// pluginStorage restoreProjectStorage/captureProjectStorage). Guides, swatches
// and materials are journaled parts (setGuides / setSwatches / setMaterials);
// plugin storage rides through open → save unchanged.
namespace {

double clamp_round(double v, double lo, double hi) { return std::max(lo, std::min(hi, motion::js::round(v))); }

bool is_camera_3d_mode(const Json& v) {
  if (!v.is_string()) return false;
  const std::string& s = v.str();
  static const std::set<std::string, std::less<>> fixed = {"active", "front", "left", "top", "back", "right", "bottom",
                                                            "custom1", "custom2", "custom3"};
  return fixed.contains(s) || (s.size() > 7 && s.starts_with("camera:"));
}

bool is_hex_color(const Json& v) {  // /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
  if (!v.is_string()) return false;
  const std::string& s = v.str();
  if (s.empty() || s[0] != '#') return false;
  const std::size_t n = s.size() - 1;
  if (n != 3 && n != 4 && n != 6 && n != 8) return false;
  return std::all_of(s.begin() + 1, s.end(), [](char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; });
}

/// guidesStore sanitizeBookmarks.
Json sanitize_bookmarks(const Json& raw) {
  Json out = Json::object();
  if (!raw.is_object()) return out;
  for (const auto& m : raw.obj()) {
    if (!m.value.is_array()) continue;
    std::vector<std::pair<double, Json>> ok;
    for (const Json& b : m.value.arr()) {
      if (!b.is_object()) continue;
      const Json& slot = b.at("slot");
      if (!slot.is_number() || slot.num() < 1 || slot.num() > 9) continue;
      if (!b.at("mode").is_string()) continue;
      const Json& f = b.at("framing");
      if (!f.is_object() || !f.at("zoom").is_number() || !f.at("center").is_object() || !f.at("center").at("x").is_number() ||
          !f.at("center").at("y").is_number()) {
        continue;
      }
      Json bm = Json::object();
      const double s = motion::js::round(slot.num());
      bm.set("slot", Json::number(s));
      bm.set("name", b.at("name").is_string() ? b.at("name") : Json::string("Bookmark " + js::number_to_string(slot.num())));
      bm.set("mode", is_camera_3d_mode(b.at("mode")) ? b.at("mode") : Json::string("active"));
      Json center = Json::object();
      center.set("x", f.at("center").at("x"));
      center.set("y", f.at("center").at("y"));
      Json framing = Json::object();
      framing.set("center", std::move(center));
      framing.set("zoom", f.at("zoom"));
      bm.set("framing", std::move(framing));
      if (truthy(b.at("customView"))) bm.set("customView", b.at("customView"));
      ok.emplace_back(s, std::move(bm));
    }
    if (ok.empty()) continue;
    std::stable_sort(ok.begin(), ok.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    Json list = Json::array();
    for (auto& [s, bm] : ok) list.arr_mut().push_back(std::move(bm));
    out.set(m.key, std::move(list));
  }
  return out;
}

/// guideGeometry sanitizeStoredGuides.
Json sanitize_stored_guides(const Json& raw) {
  Json out = Json::array();
  if (!raw.is_array()) return out;
  for (const Json& g : raw.arr()) {
    if (!g.is_object()) continue;
    const Json& axis = g.at("axis");
    if (!axis.is_string() || (axis.str() != "x" && axis.str() != "y")) continue;
    const double value = g.at("value").is_number()      ? g.at("value").num()
                         : g.at("position").is_number() ? g.at("position").num()
                                                        : std::nan("");
    if (!std::isfinite(value)) continue;
    Json o = Json::object();
    o.set("axis", axis);
    o.set("value", Json::number(value));
    o.set("unit", Json::string(g.at("unit").is_string() && g.at("unit").str() == "%" ? "%" : "px"));
    o.set("edge", Json::string(g.at("edge").is_string() && g.at("edge").str() == "end" ? "end" : "start"));
    if (is_hex_color(g.at("color"))) o.set("color", g.at("color"));
    if (g.at("locked").is_bool() && g.at("locked").b()) o.set("locked", Json::boolean(true));
    out.arr_mut().push_back(std::move(o));
  }
  return out;
}

}  // namespace

Json restore_guides(Json g, const Json& s) {
  for (const char* k : {"rulers", "grid", "snapToGrid", "proportionalGrid", "safeArea", "motionPathVisible"}) {
    if (s.at(k).is_bool()) g.set(k, s.at(k));
  }
  const Json& style = s.at("gridStyle");
  if (style.is_string() && (style.str() == "lines" || style.str() == "dashed" || style.str() == "dots")) g.set("gridStyle", style);
  const Json& dots = s.at("motionPathDots");
  if (dots.is_string() && (dots.str() == "off" || dots.str() == "small" || dots.str() == "medium" || dots.str() == "large")) {
    g.set("motionPathDots", dots);
  }
  if (s.at("gridSpacing").is_number()) g.set("gridSpacing", Json::number(clamp_round(s.at("gridSpacing").num(), 1, 10000)));
  if (s.at("gridSubdivisions").is_number()) g.set("gridSubdivisions", Json::number(clamp_round(s.at("gridSubdivisions").num(), 1, 64)));
  if (s.at("proportionalColumns").is_number()) g.set("proportionalColumns", Json::number(clamp_round(s.at("proportionalColumns").num(), 1, 64)));
  if (s.at("proportionalRows").is_number()) g.set("proportionalRows", Json::number(clamp_round(s.at("proportionalRows").num(), 1, 64)));
  if (s.at("gridColor").is_string()) g.set("gridColor", s.at("gridColor"));
  const Json& oo = s.at("overlayOpacity");
  g.set("overlayOpacity", Json::number(oo.is_number() ? (std::isfinite(oo.num()) ? std::max(0.2, std::min(1.0, oo.num())) : 1.0) : 1.0));
  g.set("cameraBookmarks", sanitize_bookmarks(s.at("cameraBookmarks")));
  g.set("userGuides", sanitize_stored_guides(s.at("userGuides")));
  const Json& show = s.at("motionPathShow");
  g.set("motionPathShow", Json::string(show.is_string() && (show.str() == "none" || show.str() == "window") ? show.str() : "all"));
  if (s.at("motionPathWindowSeconds").is_number()) {
    const double w = s.at("motionPathWindowSeconds").num();
    g.set("motionPathWindowSeconds", Json::number(std::isfinite(w) ? std::max(0.1, std::min(600.0, w)) : 2.0));
  }
  // Legacy `gridDivisions` restores onto the proportional grid.
  if (s.at("gridDivisions").is_number() && !s.at("proportionalColumns").is_number()) {
    const double n = clamp_round(s.at("gridDivisions").num(), 1, 64);
    g.set("proportionalColumns", Json::number(n));
    g.set("proportionalRows", Json::number(n));
  }
  return g;
}

Json guides_settings(const Json& g) {
  Json out = Json::object();
  for (const char* k : {"rulers", "grid", "gridSpacing", "gridSubdivisions", "snapToGrid", "gridColor", "gridStyle", "proportionalGrid",
                        "proportionalColumns", "proportionalRows", "safeArea", "motionPathVisible", "motionPathDots"}) {
    out.set(k, g.at(k));
  }
  if (g.at("cameraBookmarks").is_object() && !g.at("cameraBookmarks").obj().empty()) out.set("cameraBookmarks", g.at("cameraBookmarks"));
  if (g.at("overlayOpacity").num() != 1) out.set("overlayOpacity", g.at("overlayOpacity"));
  if (g.at("motionPathShow").str() != "all") {
    out.set("motionPathShow", g.at("motionPathShow"));
    out.set("motionPathWindowSeconds", g.at("motionPathWindowSeconds"));
  }
  if (g.at("userGuides").is_array() && !g.at("userGuides").arr().empty()) out.set("userGuides", g.at("userGuides"));
  return out;
}

std::optional<std::string> canonical_hex(const Json& raw) {
  if (!raw.is_string()) return std::nullopt;
  std::string_view t = raw.str();
  const auto ws = [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; };
  while (!t.empty() && ws(t.front())) t.remove_prefix(1);
  while (!t.empty() && ws(t.back())) t.remove_suffix(1);
  if (t.starts_with('#')) t.remove_prefix(1);
  std::string body;
  for (char c : t) {
    if (std::isxdigit(static_cast<unsigned char>(c)) == 0) return std::nullopt;
    body.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
  }
  if (body.empty()) return std::nullopt;
  std::string full;
  if (body.size() == 3 || body.size() == 4) {
    for (char c : body) full.append(2, c);
  } else if (body.size() == 6 || body.size() == 8) {
    full = body;
  } else {
    return std::nullopt;
  }
  if (full.size() == 8 && full.ends_with("ff")) full.resize(6);
  return "#" + full;
}

namespace {

std::string upper(std::string s) {
  for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  return s;
}

bool blank(const std::string& s) {
  return std::all_of(s.begin(), s.end(), [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; });
}

}  // namespace

Json normalize_swatches(const Json& raw) {
  Json out = Json::array();
  if (!raw.is_array()) return out;
  std::set<std::string, std::less<>> used;
  std::size_t minted = 0;
  for (const Json& e : raw.arr()) {
    if (!e.is_object()) continue;
    const auto hex = canonical_hex(e.at("hex"));
    if (!hex) continue;
    const Json& rid = e.at("id");
    std::string id = rid.is_string() && !rid.str().empty() && !used.contains(rid.str()) ? rid.str() : std::string();
    while (id.empty() || used.contains(id)) id = "sw_doc_" + std::to_string(++minted);
    used.insert(id);
    Json s = Json::object();
    s.set("id", Json::string(id));
    s.set("name", e.at("name").is_string() && !blank(e.at("name").str()) ? e.at("name") : Json::string(upper(*hex)));
    s.set("hex", Json::string(*hex));
    out.arr_mut().push_back(std::move(s));
  }
  return out;
}

namespace {

/// material.ts normalizeMaterialParams.
Json normalize_material_params(const Json& raw) {
  const Json p = raw.is_object() ? raw : Json::object();
  const auto num = [&p](const char* k, double fallback, double lo, double hi) {
    const Json& v = p.at(k);
    return v.is_number() && std::isfinite(v.num()) ? std::max(lo, std::min(hi, v.num())) : fallback;
  };
  const auto shadow = [](const Json& v) -> const char* {
    if ((v.is_string() && v.str() == "only") || (v.is_number() && v.num() == 2)) return "only";
    if ((v.is_bool() && !v.b()) || (v.is_string() && v.str() == "off") || (v.is_number() && v.num() == 0)) return "off";
    if (v.is_number()) return v.num() >= 1.5 ? "only" : v.num() >= 0.5 ? "on" : "off";
    return "on";
  };
  const Json& al = p.at("acceptsLights");
  const bool acceptsLights = al.is_number() ? al.num() > 0.5 : (al.is_bool() && al.b());
  const Json& sh = p.at("shading");
  const char* shading = sh.is_string() && sh.str() == "pbr" ? "pbr" : sh.is_string() && sh.str() == "toon" ? "toon" : "phong";
  Json o = Json::object();
  o.set("castsShadows", Json::string(shadow(p.at("castsShadows"))));
  o.set("acceptsShadows", Json::string(shadow(p.at("acceptsShadows"))));
  o.set("acceptsLights", Json::boolean(acceptsLights));
  o.set("lightTransmission", Json::number(num("lightTransmission", 0, 0, 100)));
  o.set("ambient", Json::number(num("ambient", 100, 0, 100)));
  o.set("diffuse", Json::number(num("diffuse", 50, 0, 100)));
  o.set("metal", Json::number(num("metal", 0, 0, 100)));
  o.set("specular", Json::number(num("specular", 0, 0, 100)));
  o.set("shininess", Json::number(num("shininess", 32, 1, 512)));
  o.set("shading", Json::string(shading));
  o.set("roughness", Json::number(num("roughness", 50, 0, 100)));
  o.set("toonBands", Json::number(motion::js::round(num("toonBands", 3, 2, 8))));
  o.set("reflectionIntensity", Json::number(num("reflectionIntensity", 100, 0, 100)));
  o.set("reflectionSharpness", Json::number(num("reflectionSharpness", 0, 0, 100)));
  o.set("reflectionRolloff", Json::number(num("reflectionRolloff", 0, 0, 100)));
  o.set("transparency", Json::number(num("transparency", 0, 0, 100)));
  o.set("transparencyRolloff", Json::number(num("transparencyRolloff", 0, 0, 100)));
  o.set("ior", Json::number(num("ior", 1.52, 1, 4)));
  return o;
}

std::string trim_ws(const std::string& s) {
  std::string_view t = s;
  const auto ws = [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; };
  while (!t.empty() && ws(t.front())) t.remove_prefix(1);
  while (!t.empty() && ws(t.back())) t.remove_suffix(1);
  return std::string(t);
}

}  // namespace

Json normalize_materials(const Json& raw) {
  Json out = Json::array();
  if (!raw.is_array()) return out;
  std::set<std::string, std::less<>> used;
  std::size_t minted = 0;
  for (const Json& e : raw.arr()) {
    if (!e.is_object()) continue;
    const Json& rid = e.at("id");
    const bool keep = rid.is_string() && !rid.str().empty() && !used.contains(rid.str()) && !rid.str().starts_with("builtin:");
    std::string id = keep ? rid.str() : std::string();
    while (id.empty() || used.contains(id)) id = "mat_doc_" + std::to_string(++minted);
    used.insert(id);
    const Json& rn = e.at("name");
    const std::string name = rn.is_string() && !blank(rn.str()) ? trim_ws(rn.str()) : "Material";
    Json m = Json::object();
    m.set("id", Json::string(id));
    m.set("name", Json::string(name));
    m.set("params", normalize_material_params(e.at("params")));
    const Json& sw = e.at("swatch");
    if (sw.is_string() && sw.str().size() == 7 && is_hex_color(sw)) {
      std::string lower = sw.str();
      for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      m.set("swatch", Json::string(lower));
    }
    out.arr_mut().push_back(std::move(m));
  }
  return out;
}

namespace {

/// pluginStorage isScopeStore: plugin id → { key → string }.
bool is_scope_store(const Json& v) {
  if (!v.is_object()) return false;
  for (const auto& m : v.obj()) {
    if (!m.value.is_object()) return false;
    for (const auto& kv : m.value.obj()) {
      if (!kv.value.is_string()) return false;
    }
  }
  return true;
}

/// captureProjectStorage: the non-empty bags, or undefined when none.
Json capture_project_storage(const Json& store) {
  Json out = Json::object();
  if (!store.is_object()) return out;
  for (const auto& m : store.obj()) {
    if (m.value.is_object() && !m.value.obj().empty()) out.set(m.key, m.value);
  }
  return out;
}

}  // namespace

Json default_guides() {
  Json g = Json::object();
  g.set("rulers", Json::boolean(false));
  g.set("grid", Json::boolean(false));
  g.set("gridSpacing", Json::number(100));
  g.set("gridSubdivisions", Json::number(4));
  g.set("snapToGrid", Json::boolean(false));
  g.set("gridColor", Json::string("#ffffff14"));
  g.set("gridStyle", Json::string("lines"));
  g.set("proportionalGrid", Json::boolean(false));
  g.set("proportionalColumns", Json::number(8));
  g.set("proportionalRows", Json::number(6));
  g.set("safeArea", Json::boolean(false));
  g.set("motionPathVisible", Json::boolean(true));
  g.set("motionPathDots", Json::string("small"));
  g.set("cameraBookmarks", Json::object());
  g.set("overlayOpacity", Json::number(1));
  g.set("motionPathShow", Json::string("all"));
  g.set("motionPathWindowSeconds", Json::number(2));
  g.set("userGuides", Json::array());
  return g;
}

Json capture_document(const Document& d) {
  Json doc = Json::object();
  doc.set("version", Json::string("1.1.0"));
  Json nodes = Json::array();
  for (const auto& [id, n] : d.nodes()) nodes.arr_mut().push_back(node_json(*n));
  Json scene = Json::object();
  scene.set("version", Json::string("1.0.0"));
  scene.set("nodes", std::move(nodes));
  doc.set("scene", std::move(scene));
  doc.set("animation", animation_json(d));
  Json comps = Json::object();
  for (const auto& [id, c] : d.comps()) comps.set(id, *c);
  doc.set("comps", std::move(comps));
  Json timelines = Json::object();
  for (const auto& [id, t] : d.timelines()) timelines.set(id, timeline_json(id, *t));
  doc.set("timelines", std::move(timelines));
  const MotionBlur& mb = d.motion_blur();
  Json mbj = Json::object();
  mbj.set("enabled", Json::boolean(mb.enabled));
  mbj.set("shutterAngle", Json::number(mb.shutterAngle));
  mbj.set("shutterPhase", Json::number(mb.shutterPhase));
  mbj.set("samples", Json::number(mb.samples));
  mbj.set("adaptiveSampleLimit", Json::number(mb.adaptiveSampleLimit));
  doc.set("motionBlur", std::move(mbj));
  doc.set("guides", guides_settings(d.guides()));
  const ColorMgmt& cm = d.color();
  Json cmj = Json::object();
  cmj.set("workingSpace", Json::string(cm.workingSpace));
  cmj.set("displayTransform", Json::string(cm.displayTransform));
  cmj.set("bitDepth", Json::number(cm.bitDepth));
  doc.set("colorManagement", std::move(cmj));
  doc.set("swatches", d.swatches());
  doc.set("materials", d.materials());
  doc.set("transitions", d.transitions());
  // Absent when empty (captureProjectStorage), so such a document reads back byte-identical.
  if (Json ps = capture_project_storage(d.extras().pluginStorage); !ps.obj().empty()) doc.set("pluginStorage", std::move(ps));
  // captureProjectItems: ALWAYS written, even empty — the key's presence marks a
  // document written by this build; its absence, an older file.
  const Items& items = d.items();
  Json footage = Json::object();
  for (const Json& a : items.assets) {
    const Json r = doc_record_of(a);
    if (!r.obj().empty()) footage.set(a.at("id").is_string() ? a.at("id").str() : "undefined", r);
  }
  {
    Json pi = Json::object();
    Json folders = Json::array();
    for (const Folder& f : items.folders) folders.arr_mut().push_back(folder_json(f));
    pi.set("folders", std::move(folders));
    pi.set("footage", std::move(footage));
    doc.set("projectItems", std::move(pi));
  }
  // captureDocumentExtras: only what differs from a fresh project.
  if (!(d.project() == default_project_settings())) doc.set("projectSettings", project_settings_json(d.project()));
  if (!d.render_queue().empty()) {
    Json rq = Json::array();
    for (const auto& r : d.render_queue()) rq.arr_mut().push_back(render_item_json(r));
    doc.set("renderQueue", std::move(rq));
  }
  return doc;
}

RestoreResult restore_document(Document& d, EditorView& v, const Json& input, const std::vector<Json>& sessionAssets) {
  // Migrate first: a document this build cannot read fails whole, before
  // anything is replaced.
  const Json doc = migrate_document(input);
  const MotionBlur prevMb = d.motion_blur();
  const ColorMgmt prevCm = d.color();
  std::vector<std::pair<std::string, Json>> prevComps;
  for (const auto& [id, c] : d.comps()) prevComps.emplace_back(id, *c);

  Document nd;
  nd.items_mut().assets = sessionAssets;
  // Scene.
  if (doc.at("scene").at("nodes").is_array()) {
    for (const Json& n : doc.at("scene").at("nodes").arr()) sg_add_node(nd, node_from_json(n));
  }
  if (doc.at("animation").is_object()) restore_animation(nd, doc.at("animation"));
  // Composition records: stated whole, else the legacy single comp upserted
  // over what the store held.
  if (doc.at("comps").is_object()) {
    for (const auto& m : doc.at("comps").obj()) nd.comp_mut(m.key) = m.value;
  } else {
    for (const auto& [id, c] : prevComps) nd.comp_mut(id) = c;
    if (doc.at("comp").is_object() && doc.at("comp").at("id").is_string()) {
      const std::string id = doc.at("comp").at("id").str();
      const Json* cur = nd.comp(id);
      nd.comp_mut(id) = cur != nullptr ? spread(*cur, doc.at("comp")) : doc.at("comp");
    }
  }
  // Timelines (the controller was reset; each listed one is rebuilt, then synced).
  if (doc.at("timelines").is_object()) {
    for (const auto& m : doc.at("timelines").obj()) {
      if (!m.value.is_object()) continue;
      nd.timeline_mut(m.key) = timeline_of(nd, m.key, m.value);
      tl_sync_from_scene(nd, m.key);
    }
  }
  v = doc.at("openTabs").is_object() ? view_of_tabs(doc.at("openTabs")) : EditorView{};
  {
    MotionBlur& mb = nd.motion_blur_mut();
    mb = prevMb;
    const Json& s = doc.at("motionBlur");
    if (s.is_object()) {
      if (s.at("enabled").is_bool()) mb.enabled = s.at("enabled").b();
      if (s.at("shutterAngle").is_number()) mb.shutterAngle = std::max(0.0, std::min(360.0, s.at("shutterAngle").num()));
      if (s.at("shutterPhase").is_number()) mb.shutterPhase = std::max(-360.0, std::min(360.0, s.at("shutterPhase").num()));
      if (s.at("samples").is_number()) mb.samples = std::max(2.0, std::min(32.0, motion::js::round(s.at("samples").num())));
      if (s.at("adaptiveSampleLimit").is_number()) {
        mb.adaptiveSampleLimit = std::max(2.0, std::min(128.0, motion::js::round(s.at("adaptiveSampleLimit").num())));
      }
    }
  }
  {
    ColorMgmt& cm = nd.color_mut();
    cm = prevCm;
    const Json& s = doc.at("colorManagement");
    if (s.is_object()) {
      const Json& ws = s.at("workingSpace");
      if (ws.is_string() && (ws.str() == "srgb-linear" || ws.str() == "aces-cg")) cm.workingSpace = ws.str();
      const Json& dt = s.at("displayTransform");
      if (dt.is_string() && (dt.str() == "srgb" || dt.str() == "aces" || dt.str() == "pq" || dt.str() == "hlg")) cm.displayTransform = dt.str();
      const Json& bd = s.at("bitDepth");
      if (bd.is_number() && (bd.num() == 16 || bd.num() == 32)) cm.bitDepth = bd.num() == 32 ? 32 : 16;
    }
  }
  // rebindAssetSrcs: dead media srcs repointed at the session's live assets.
  if (!sessionAssets.empty()) {
    std::vector<std::pair<std::string, Json>> srcById;
    for (const Json& a : sessionAssets) {
      if (a.at("id").is_string()) srcById.emplace_back(a.at("id").str(), a.at("src"));
    }
    const auto lookup = [&srcById](const std::string& id) -> const Json* {
      const Json* out = nullptr;
      for (const auto& [k, s] : srcById) {
        if (k == id) out = &s;  // Map: the last one wins
      }
      return out;
    };
    const auto dead = [](const Json& s) {
      if (!s.is_string()) return false;
      std::string_view t = s.str();
      while (!t.empty() && (t.front() == ' ' || t.front() == '\t' || t.front() == '\n' || t.front() == '\r')) t.remove_prefix(1);
      while (!t.empty() && (t.back() == ' ' || t.back() == '\t' || t.back() == '\n' || t.back() == '\r')) t.remove_suffix(1);
      return t.empty() || t.starts_with("blob:");
    };
    for (const auto& id : nd.nodes().keys()) {
      const Node* n = nd.node(id);
      for (std::size_t ci = 0; ci < n->components.size(); ++ci) {
        for (const auto& [idKey, srcKey] : {std::pair<const char*, const char*>{"assetId", "src"}, {"__assetId", "__src"}}) {
          const Json& props = nd.node(id)->components[ci].props;
          const Json& aid = props.at(idKey);
          if (!aid.is_string() || aid.str().empty()) continue;
          const Json* live = lookup(aid.str());
          if (live == nullptr || !truthy(*live) || props.at(srcKey) == *live) continue;
          if (!dead(props.at(srcKey))) continue;
          Json copy = *live;
          nd.node_mut(id).components[ci].props.set(srcKey, std::move(copy));
        }
      }
    }
  }
  // applyProjectItems. A document with no `projectItems` predates them: the
  // editor migrates its organisation from the pre-document cache (UI side,
  // legacyProjectItems); the engine keeps the session's items and folders as
  // they are — an absent key never empties them.
  const Json& pi = doc.at("projectItems");
  if (!pi.is_object()) nd.items_mut().folders = d.items().folders;
  if (pi.is_object()) {
    Items& items = nd.items_mut();
    items.folders.clear();
    if (pi.at("folders").is_array()) {
      for (const Json& f : pi.at("folders").arr()) items.folders.push_back(folder_of(f));
    }
    for (Json& a : items.assets) {
      if (a.at("id").is_string()) a = with_doc_record(a, pi.at("footage").at(a.at("id").str()));
    }
  }
  // restoreDocumentExtras.
  nd.project_mut() = project_settings_of(doc.at("projectSettings"));
  {
    RenderQueue& rq = nd.render_queue_mut();
    rq.clear();
    if (doc.at("renderQueue").is_array()) {
      for (const Json& r : doc.at("renderQueue").arr()) rq.push_back(render_item_of(r));
    }
  }
  // LocalEngine.reconcileItems — against what was applied: nothing to
  // reconcile when the document states no items.
  RestoreResult result;
  if (pi.is_object()) {
    const Json listed = pi.is_object() && pi.at("footage").is_object() ? pi.at("footage") : Json::object();
    const std::vector<Json> store = nd.items().assets;
    std::vector<Json> keep;
    for (const Json& a : store) {
      if (a.at("id").is_string() && listed.has(a.at("id").str())) keep.push_back(a);
    }
    std::vector<Json> placeholders;
    for (const auto& m : listed.obj()) {
      const bool kept = std::any_of(keep.begin(), keep.end(), [&m](const Json& a) { return a.at("id").str() == m.key; });
      if (kept) continue;
      result.missing.push_back(m.key);
      const Json& r = m.value;
      Json p = Json::object();
      p.set("id", Json::string(m.key));
      p.set("name", nullish(r.at("name")) ? Json::string(m.key) : r.at("name"));
      p.set("type", nullish(r.at("type")) ? Json::string("video") : r.at("type"));
      p.set("src", Json::string(""));
      p.set("size", Json::number(0));
      if (truthy(r.at("path"))) p.set("path", r.at("path"));
      if (truthy(r.at("folderId"))) p.set("folderId", r.at("folderId"));
      if (truthy(r.at("interpret"))) p.set("interpret", spread(Json::object(), r.at("interpret")));
      if (truthy(r.at("label"))) p.set("label", r.at("label"));
      if (truthy(r.at("tags"))) p.set("tags", r.at("tags"));
      if (truthy(r.at("comment"))) p.set("comment", r.at("comment"));
      placeholders.push_back(std::move(p));
    }
    if (!placeholders.empty() || keep.size() != store.size()) {
      Items& items = nd.items_mut();
      items.assets = std::move(keep);
      for (auto& p : placeholders) items.assets.push_back(std::move(p));
      items.folders.clear();
      if (pi.at("folders").is_array()) {
        for (const Json& f : pi.at("folders").arr()) items.folders.push_back(folder_of(f));
      }
    }
  }
  // Present keys replace (swatches, materials) or merge (guides) over what the
  // session held; plugin storage is assigned unconditionally.
  nd.extras_mut().pluginStorage = is_scope_store(doc.at("pluginStorage")) ? doc.at("pluginStorage") : Json::object();
  nd.guides_mut() = truthy(doc.at("guides")) ? restore_guides(d.guides(), doc.at("guides")) : d.guides();
  nd.swatches_mut() = truthy(doc.at("swatches")) ? normalize_swatches(doc.at("swatches")) : d.swatches();
  nd.materials_mut() = truthy(doc.at("materials")) ? normalize_materials(doc.at("materials")) : d.materials();
  // transitionStore.restore: a present map replaces, an absent one keeps what the session held.
  nd.transitions_mut() = truthy(doc.at("transitions")) ? doc.at("transitions") : d.transitions();
  d = std::move(nd);
  return result;
}

}  // namespace premation::doc
