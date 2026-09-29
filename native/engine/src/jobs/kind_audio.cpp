// Audio job kinds: audioAnalysis (beats, Convert Audio to Keyframes, silence
// detection and removal), audioDuck, audioGate. The analyses are ports of the
// page's (audio_analysis.hpp); what apply() writes is what the page's edits
// wrote through the engine API (src/layout/Inspector/audioEdits.ts,
// src/core/audio/beatCommands.ts) — the same commands, in one entry.
#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <cmath>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "audio_analysis.hpp"
#include "child_export.hpp"
#include "transcribe.hpp"
#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "jsmath.hpp"
#include "json.hpp"
#include "media_input.hpp"
#include "model.hpp"
#include "props.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "time_conv.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace aa = audio_analysis;

namespace {

constexpr std::size_t kMaxBeatMarkers = 512;  // beatCommands.ts MAX_MARKERS
constexpr const char* kLevelsPath = "audio/levels";

/// JavaScript Math.round (V8's, motion::js).
double motion_round(double v) { return motion::js::round(v); }
double round_to(double v, double k) { return motion_round(v * k) / k; }

std::vector<aa::ClipTiming> timings_of(const FootageLayer& f) {
  std::vector<aa::ClipTiming> out;
  for (const auto& t : f.clip_timings()) out.push_back(aa::ClipTiming{t.startSec, t.inSec, t.outSec});
  return out;
}

/// mirror/audio.ts audioClipTimings for a layer as the document stands NOW (apply reads between steps).
std::optional<aa::ClipTiming> timing_now(const doc::Document& d, const std::string& layer) {
  const doc::Node* n = d.node(layer);
  if (n == nullptr) return std::nullopt;
  const doc::Node* parent = n->parent ? d.node(*n->parent) : nullptr;
  const std::optional<std::string> comp = doc::comp_of_layer(d, layer);
  if (!comp) return std::nullopt;
  if (parent != nullptr && parent->id != *comp && doc::layer_kind_of(*parent) == api::LayerKind::group) return std::nullopt;
  const api::LayerTiming t = doc::layer_timing(d, layer);
  const double inSec = seconds_of(t.in_point - t.start_time);
  return aa::ClipTiming{seconds_of(t.in_point), inSec, inSec + seconds_of(t.out_point - t.in_point)};
}

double static_level_db(const doc::Document& d, const std::string& layer) {
  const doc::Catalog cat = doc::catalog_for(d, layer);
  const doc::PropBinding* b = cat.find(kLevelsPath);
  if (b == nullptr) return 0;
  const api::Value v = doc::read_static(d, layer, *b);
  if (const auto* x = std::get_if<double>(&v.v)) return *x;
  return 0;
}

/// mirror/audio.ts driverRangeOf: the comp's work area, else all of it.
struct Range {
  double start = 0;
  double end = 0;
  double fps = 30;
};
Range driver_range(const doc::Document& d, const std::string& comp) {
  const api::CompSettings s = doc::comp_settings(d, comp);
  Range r;
  r.fps = s.frame_rate.den > 0 && s.frame_rate.num > 0 ? static_cast<double>(s.frame_rate.num) / s.frame_rate.den : 30;
  if (s.work_area.duration > 0) {
    r.start = seconds_of(s.work_area.start);
    r.end = seconds_of(s.work_area.start + s.work_area.duration);
  } else {
    r.start = 0;
    r.end = std::max(1 / r.fps, seconds_of(s.duration));
  }
  return r;
}

api::Keyframe scalar_key(double seconds, double value) {
  api::Keyframe k;
  k.time = flicks_of(seconds);
  k.value = doc::v_scalar(value);
  k.easing = api::Easing::linear;
  return k;
}

/// Keys at composition seconds → distinct times (the first of a clash wins, as the page's `seen` sets).
std::vector<api::Keyframe> distinct_keys(const std::vector<std::pair<double, double>>& keys) {
  std::vector<api::Keyframe> out;
  std::set<api::Time> seen;
  for (const auto& [sec, v] : keys) {
    api::Keyframe k = scalar_key(sec, v);
    if (!seen.insert(k.time).second) continue;
    out.push_back(std::move(k));
  }
  std::sort(out.begin(), out.end(), [](const api::Keyframe& a, const api::Keyframe& b) { return a.time < b.time; });
  return out;
}

std::string keys_json(const std::vector<std::pair<double, double>>& keys) {
  std::string s = "[";
  for (std::size_t i = 0; i < keys.size(); ++i) {
    if (i > 0) s += ',';
    s += "[" + json_number(keys[i].first) + "," + json_number(keys[i].second) + "]";
  }
  return s + "]";
}

std::string numbers_json(const std::vector<double>& v) {
  std::string s = "[";
  for (std::size_t i = 0; i < v.size(); ++i) {
    if (i > 0) s += ',';
    s += json_number(v[i]);
  }
  return s + "]";
}

double param(const js::Json& o, std::string_view key, double fallback) {
  const js::Json& v = o.at(key);
  return v.is_number() && std::isfinite(v.num()) ? v.num() : fallback;
}

js::Json parse_params(const std::string& text) {
  if (text.empty()) return js::Json::object();
  const std::optional<js::Json> p = js::parse(text);
  if (!p || !p->is_object()) fail(ErrorCode::invalid_argument, "params must be a JSON object");
  return *p;
}

// ── audioAnalysis ──────────────────────────────────────────────────────────

/// What an audioAnalysis job was asked, copied out of the document by prepare.
struct AnalysisSpec {
  std::string layer;
  std::string comp;
  double compFps = 30;
  std::string amplitudePath;
  bool beats = false;
  bool beatMarkers = false;
  std::uint32_t beatEvery = 1;
  bool silence = false;
  bool removeSilence = false;
  std::vector<std::string> paired;
  /// Convert Audio to Keyframes' null: its name ("<layer> Amplitude"); empty = not asked.
  std::string nullName;
};

class AnalysisResult final : public JobResult {
 public:
  explicit AnalysisResult(const AnalysisSpec& s)
      : layer(s.layer), comp(s.comp), compFps(s.compFps), amplitudePath(s.amplitudePath), beats(s.beats),
        beatMarkers(s.beatMarkers), beatEvery(s.beatEvery), silence(s.silence), removeSilence(s.removeSilence),
        paired(s.paired), nullName(s.nullName) {}
  std::string layer;
  std::string comp;
  double compFps = 30;
  // amplitude
  std::string amplitudePath;
  std::vector<std::pair<double, double>> amplitudeKeys;
  // beats
  bool beats = false;
  bool beatMarkers = false;
  std::uint32_t beatEvery = 1;
  aa::BeatAnalysis beat;
  std::vector<double> beatsComp;
  std::vector<double> onsetsComp;
  // silence
  bool silence = false;
  bool removeSilence = false;
  std::vector<aa::SilenceRange> ranges;
  std::vector<std::string> paired;
  std::vector<aa::CompInterval> intervals;
  // the Amplitude null (Both Channels / Left / Right sliders)
  std::string nullName;
  std::array<std::vector<std::pair<double, double>>, 3> nullKeys;

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{";
    bool first = true;
    auto field = [&](const std::string& k, const std::string& v) {
      if (!first) s += ',';
      first = false;
      s += json_string(k) + ":" + v;
    };
    if (!nullName.empty()) {
      field("amplitudeNull", "{\"both\":" + std::to_string(nullKeys[0].size()) + ",\"left\":" + std::to_string(nullKeys[1].size()) +
                                   ",\"right\":" + std::to_string(nullKeys[2].size()) + "}");
    }
    if (!amplitudePath.empty()) field("amplitude", "{\"keyframes\":" + std::to_string(amplitudeKeys.size()) + ",\"keys\":" + keys_json(amplitudeKeys) + "}");
    if (beats) {
      field("beats", "{\"bpm\":" + json_number(beat.bpm) + ",\"tempoConfidence\":" + json_number(beat.tempoConfidence) +
                         ",\"beatsCompSec\":" + numbers_json(beatsComp) + ",\"onsetsCompSec\":" + numbers_json(onsetsComp) + "}");
    }
    if (silence) {
      std::string r = "[";
      double total = 0;
      for (std::size_t i = 0; i < ranges.size(); ++i) {
        if (i > 0) r += ',';
        r += "{\"startSec\":" + json_number(ranges[i].startSec) + ",\"endSec\":" + json_number(ranges[i].endSec) + "}";
        total += std::max(0.0, ranges[i].endSec - ranges[i].startSec);
      }
      r += "]";
      double removed = 0;
      for (const auto& iv : intervals) removed += iv.end - iv.start;
      std::string paired_json = "[";
      for (std::size_t i = 0; i < paired.size(); ++i) paired_json += (i > 0 ? "," : "") + json_string(paired[i]);
      paired_json += "]";
      field("silence", "{\"ranges\":" + r + ",\"totalSec\":" + json_number(total) + ",\"gaps\":" + std::to_string(intervals.size()) +
                           ",\"secondsRemoved\":" + json_number(removed) + ",\"layers\":" + paired_json + "}");
    }
    return s + "}";
  }

  [[nodiscard]] std::string label() const override {
    if (removeSilence && !intervals.empty()) return "Remove Silence";
    if (!amplitudePath.empty() && !amplitudeKeys.empty()) return "Convert audio to keyframes";
    if (has_null_keys()) return "Convert audio to keyframes";
    return "Markers on Beats";
  }

  [[nodiscard]] bool has_edits() const override {
    return (!amplitudePath.empty() && !amplitudeKeys.empty()) || has_null_keys() || (beats && beatMarkers && !beatsComp.empty()) ||
           (removeSilence && !intervals.empty());
  }

  [[nodiscard]] bool has_null_keys() const {
    return !nullName.empty() && std::any_of(nullKeys.begin(), nullKeys.end(), [](const auto& k) { return !k.empty(); });
  }

  /// audioKeyframes.ts applyAudioSliderNull: the null, its three sliders, their keys.
  void apply_null(JobApply& a) const {
    api::CreateLayer c;
    c.comp = comp;
    c.kind = api::LayerKind::null;
    c.name = nullName;
    const std::optional<api::LayerRef> made = result_payload<api::LayerRef>(a.run(command(std::move(c))));
    if (!made) fail(ErrorCode::internal, "the Amplitude null was not created");
    static constexpr std::array<const char*, 3> kLabels{"Both Channels", "Left", "Right"};
    for (std::size_t i = 0; i < kLabels.size(); ++i) {
      if (nullKeys[i].empty()) continue;
      api::AddPropertyGroup g;
      g.layer = made->layer;
      g.parent = "effects";
      g.match_name = "ADBE Slider Control";
      g.name = kLabels[i];
      const std::optional<api::GroupList> groups = result_payload<api::GroupList>(a.run(command(std::move(g))));
      if (!groups || groups->groups.empty()) fail(ErrorCode::internal, "the slider control was not added");
      api::SetKeyframes k;
      k.prop = api::PropRef{made->layer, groups->groups[0] + "/slider"};
      k.keys = distinct_keys(nullKeys[i]);
      (void)a.run(command(std::move(k)));
    }
  }

  void apply(JobApply& a) const override {
    if (has_null_keys()) apply_null(a);
    if (!amplitudePath.empty() && !amplitudeKeys.empty()) {
      api::SetKeyframes k;
      k.prop = api::PropRef{layer, amplitudePath};
      k.keys = distinct_keys(amplitudeKeys);
      (void)a.run(command(std::move(k)));
    }
    if (beats && beatMarkers && !beatsComp.empty()) {
      api::AddMarkers m;
      std::uint32_t n = 0;
      const std::uint32_t every = std::max(1U, beatEvery);
      for (std::size_t i = 0; i < beatsComp.size() && m.markers.size() < kMaxBeatMarkers; ++i) {
        if (i % every != 0) continue;
        api::MarkerInsert ins;
        ins.owner.comp = comp;
        ins.time = doc::frames_to_flicks(motion_round(beatsComp[i] * compFps), compFps);
        ins.name = "Beat " + std::to_string(++n);
        ins.color = "#7c8cff";
        m.markers.push_back(std::move(ins));
      }
      if (!m.markers.empty()) (void)a.run(command(std::move(m)));
    }
    if (removeSilence && !intervals.empty()) remove_silences(a);
  }

 private:
  /// audioEdits.ts removeSilencesEdit: last interval first; split every paired
  /// bar crossing an edge, delete the parts inside, close the gap on the paired
  /// bars only (never the comp-wide ripple).
  void remove_silences(JobApply& a) const {
    std::set<std::string> working(paired.begin(), paired.end());
    const double eps = 0.5 / std::max(1.0, compFps);
    struct Bar {
      std::string layer;
      double start;
      double end;
    };
    auto bars = [&]() {
      std::vector<Bar> out;
      for (const std::string& id : working) {
        if (const auto t = timing_now(a.document(), id)) out.push_back(Bar{id, t->startSec, t->startSec + (t->outSec - t->inSec)});
      }
      return out;
    };
    for (std::size_t k = intervals.size(); k-- > 0;) {
      const aa::CompInterval& iv = intervals[k];
      for (const double at : {iv.start, iv.end}) {
        const double frame = motion_round(at * compFps);
        std::vector<std::string> crossing;
        for (const Bar& b : bars()) {
          if (frame > motion_round(b.start * compFps) && frame < motion_round(b.end * compFps) &&
              std::find(crossing.begin(), crossing.end(), b.layer) == crossing.end()) {
            crossing.push_back(b.layer);
          }
        }
        if (crossing.empty()) continue;
        api::SplitLayers s;
        s.layers = crossing;
        s.time = flicks_of(at);
        const api::CommandResult r = a.run(command(std::move(s)));
        if (const auto list = result_payload<api::LayerList>(r)) {
          for (const auto& id : list->layers) working.insert(id);
        }
      }
      std::vector<std::string> inside;
      for (const Bar& b : bars()) {
        if (b.end > b.start && b.start >= iv.start - eps && b.end <= iv.end + eps &&
            std::find(inside.begin(), inside.end(), b.layer) == inside.end()) {
          inside.push_back(b.layer);
        }
      }
      for (const auto& id : inside) working.erase(id);
      if (!inside.empty()) {
        api::DeleteLayers del;
        del.layers = inside;
        (void)a.run(command(std::move(del)));
      }
      const double gap = iv.end - iv.start;
      std::vector<std::string> later;
      for (const Bar& b : bars()) {
        if (b.start >= iv.end - eps && std::find(later.begin(), later.end(), b.layer) == later.end()) later.push_back(b.layer);
      }
      if (!later.empty()) {
        api::MoveLayersInTime mv;
        mv.layers = later;
        mv.delta = -flicks_of(gap);
        mv.ripple = false;
        (void)a.run(command(std::move(mv)));
      }
    }
  }
};

// ── audioDuck / audioGate ─────────────────────────────────────────────────

/// A level track + the remembered record: ducking and the gate write the same shape (audioEdits.ts duckEdit / gateEdit).
class LevelResult final : public JobResult {
 public:
  std::string layer;
  std::string recordPath;  // audio/ducking | audio/gate
  std::string recordJson;
  std::string entryLabel;
  std::vector<std::pair<double, double>> keys;
  std::vector<float> envelope;  // the detector, per frame (the dialogs' preview strip)
  double peakDuckDb = 0;
  bool reportPeak = false;
  /// Gate: the fraction of frames the gate holds closed (GateDialog's readout: gain below −0.5 dB).
  std::optional<double> closedFraction;
  Range range;

  [[nodiscard]] std::string summary_json() const override {
    std::vector<double> env;
    env.reserve(envelope.size());
    for (const float v : envelope) env.push_back(round_to(v, 1000));
    std::string s = "{\"keyframes\":" + std::to_string(keys.size()) + ",\"keys\":" + keys_json(keys) +
                    ",\"start\":" + json_number(range.start) + ",\"end\":" + json_number(range.end) +
                    ",\"fps\":" + json_number(range.fps) + ",\"envelope\":" + numbers_json(env);
    if (reportPeak) s += ",\"peakDuckDb\":" + json_number(peakDuckDb);
    if (closedFraction) s += ",\"closedFraction\":" + json_number(*closedFraction);
    return s + "}";
  }
  [[nodiscard]] std::string label() const override { return entryLabel; }
  [[nodiscard]] bool has_edits() const override { return !keys.empty(); }
  void apply(JobApply& a) const override {
    api::SetProperty rec;
    rec.prop = api::PropRef{layer, recordPath};
    rec.value = doc::v_json(recordJson);
    (void)a.run(command(std::move(rec)));
    // An expression on the level would multiply against the baked track.
    api::SetExpression clear;
    clear.prop = api::PropRef{layer, kLevelsPath};
    clear.source = "";
    clear.enabled = true;
    (void)a.run(command(std::move(clear)));
    api::SetKeyframes k;
    k.prop = api::PropRef{layer, kLevelsPath};
    k.keys = distinct_keys(keys);
    (void)a.run(command(std::move(k)));
  }
};

std::vector<float> read_mono(const std::string& file, int& sampleRate) {
  AudioPcm pcm;
  std::string error;
  if (!read_audio(file, pcm, error)) fail(ErrorCode::io, error);
  sampleRate = pcm.sampleRate;
  return mono_of(pcm);
}

}  // namespace

PreparedJob prepare_audio_analysis(const api::AudioAnalysisJob& spec, const JobDocContext& ctx) {
  const bool wantNull = spec.amplitude_null.value_or(false);
  if (!spec.beats && !spec.amplitude_keyframes && !spec.silence && !spec.remove_silence && !wantNull) {
    fail(ErrorCode::invalid_argument, "nothing to analyse: ask for beats, amplitudeKeyframes or silence");
  }
  const FootageLayer f = footage_layer(ctx, spec.layer, Need::sound);
  AnalysisSpec cfg;
  AnalysisSpec* result = &cfg;
  result->layer = f.layer;
  result->comp = f.comp;
  result->compFps = f.compFps;
  result->beats = spec.beats;
  result->beatMarkers = spec.beat_markers;
  result->beatEvery = spec.beat_every.value_or(1);
  result->silence = spec.silence || spec.remove_silence;
  result->removeSilence = spec.remove_silence;
  if (wantNull) {
    const doc::Node* n = ctx.doc.node(f.layer);
    result->nullName = (n != nullptr && !n->name.empty() ? n->name : std::string("Audio")) + " Amplitude";
  }
  if (spec.amplitude_keyframes) {
    // Convert Audio to Keyframes' track: an audio layer's `audioAmplitude` (props.cpp).
    const doc::Catalog cat = doc::catalog_for(ctx.doc, f.layer);
    const doc::PropBinding* b = cat.by_member("audioAmplitude");
    if (b == nullptr) fail(ErrorCode::invalid_argument, "only an audio layer has an amplitude track", {.layer = f.layer});
    result->amplitudePath = b->path;
  }
  aa::Channel channel = aa::Channel::both;
  if (spec.amplitude_channel == std::optional<std::string>("left")) channel = aa::Channel::left;
  if (spec.amplitude_channel == std::optional<std::string>("right")) channel = aa::Channel::right;
  aa::KeyframeOptions kopts;
  kopts.frameStep = spec.amplitude_frame_step.value_or(1);
  kopts.minDelta = spec.amplitude_min_delta.value_or(2);
  kopts.smoothing = spec.amplitude_smoothing.value_or(1);
  kopts.gain = spec.amplitude_gain.value_or(1);
  aa::SilenceOptions sopts;
  if (spec.silence_threshold_db) sopts.thresholdDb = *spec.silence_threshold_db;
  if (spec.silence_min_ms) sopts.minSilenceMs = *spec.silence_min_ms;
  if (spec.silence_padding_ms) sopts.paddingMs = *spec.silence_padding_ms;
  // silenceRemoval.ts pairedAudioNodeIds: every layer of the composition playing the same file.
  std::vector<std::vector<aa::ClipTiming>> pairedTimings;
  if (result->silence) {
    for (const std::string& id : doc::layer_ids_of_comp(ctx.doc, f.comp)) {
      const doc::Node* n = ctx.doc.node(id);
      if (n == nullptr) continue;
      const api::LayerKind k = doc::layer_kind_of(*n);
      if (k != api::LayerKind::audio && k != api::LayerKind::video) continue;
      if (id != f.layer && (f.item.empty() || doc::layer_source_of(*n) != std::optional<std::string>(f.item))) continue;
      result->paired.push_back(id);
      if (const auto t = timing_now(ctx.doc, id)) pairedTimings.push_back({*t});
      else pairedTimings.emplace_back();
    }
    if (result->paired.empty()) result->paired.push_back(f.layer);
  }
  const std::vector<aa::ClipTiming> ownTimings = timings_of(f);
  return PreparedJob{"audioAnalysis", [cfg, f, channel, kopts, sopts, pairedTimings, ownTimings](JobControl& control) -> std::unique_ptr<JobResult> {
    control.progress(0.05, "Decoding audio");
    AudioPcm pcm;
    std::string error;
    if (!read_audio(f.file, pcm, error)) fail(ErrorCode::io, error);
    if (control.cancelled()) return nullptr;
    const auto sr = static_cast<double>(pcm.sampleRate);
    auto out = std::make_unique<AnalysisResult>(cfg);
    if (!out->amplitudePath.empty()) {
      control.progress(0.3, "Measuring loudness");
      const double fps = f.compFps;
      const std::vector<double> env = aa::amplitude_envelope(pcm.channels, sr, fps, channel);
      for (const aa::PlannedKey& k : aa::plan_audio_keyframes(env, kopts)) {
        const std::optional<double> compSec = f.comp_seconds_through_bar(static_cast<double>(k.frame) / fps);
        if (compSec) out->amplitudeKeys.emplace_back(*compSec, k.value);
      }
    }
    if (!out->nullName.empty()) {
      control.progress(0.4, "Measuring loudness per channel");
      const double fps = f.compFps;
      static constexpr std::array<aa::Channel, 3> kChannels{aa::Channel::both, aa::Channel::left, aa::Channel::right};
      for (std::size_t i = 0; i < kChannels.size(); ++i) {
        const std::vector<double> env = aa::amplitude_envelope(pcm.channels, sr, fps, kChannels[i]);
        for (const aa::PlannedKey& k : aa::plan_audio_keyframes(env, kopts)) {
          const std::optional<double> compSec = f.comp_seconds_through_bar(static_cast<double>(k.frame) / fps);
          if (compSec) out->nullKeys[i].emplace_back(*compSec, k.value);
        }
      }
    }
    if (control.cancelled()) return nullptr;
    if (out->beats) {
      control.progress(0.55, "Finding the beat");
      out->beat = aa::analyse_beats(pcm.channels, sr);
      // beatGrid.ts: media seconds → composition time through the layer, sorted.
      for (const double b : out->beat.beats) out->beatsComp.push_back(f.comp_seconds(b));
      for (const double o : out->beat.onsets) out->onsetsComp.push_back(f.comp_seconds(o));
      std::sort(out->beatsComp.begin(), out->beatsComp.end());
      std::sort(out->onsetsComp.begin(), out->onsetsComp.end());
    }
    if (control.cancelled()) return nullptr;
    if (out->silence) {
      control.progress(0.8, "Finding silences");
      const std::vector<float> mono = mono_of(pcm);
      out->ranges = aa::detect_silences(mono, sr, sopts);
      std::vector<aa::CompInterval> all;
      for (const auto& t : pairedTimings) {
        const std::vector<aa::ClipTiming>& use = t.empty() ? ownTimings : t;
        for (const auto& iv : aa::ranges_to_comp_intervals(use, out->ranges)) all.push_back(iv);
      }
      out->intervals = aa::merge_intervals(std::move(all));
    }
    control.progress(1, "Done");
    return out;
  }};
}

PreparedJob prepare_audio_duck(const api::AudioDuckJob& spec, const JobDocContext& ctx) {
  if (spec.voices.empty()) fail(ErrorCode::invalid_argument, "ducking needs a voice layer");
  if (spec.voices.front() == spec.music) fail(ErrorCode::invalid_argument, "A layer cannot duck under itself.");
  const FootageLayer music = footage_layer(ctx, spec.music, Need::sound);
  const FootageLayer voice = footage_layer(ctx, spec.voices.front(), Need::sound);
  const js::Json p = parse_params(spec.params);
  aa::DuckingParams params;
  params.duckDb = param(p, "duckDb", params.duckDb);
  params.thresholdDb = param(p, "thresholdDb", params.thresholdDb);
  params.attackMs = param(p, "attackMs", params.attackMs);
  params.releaseMs = param(p, "releaseMs", params.releaseMs);
  params.holdMs = param(p, "holdMs", params.holdMs);
  // ducking.ts DuckingRecord = { ...params, voiceNodeId }.
  js::Json record = js::Json::object();
  record.set("duckDb", js::Json::number(params.duckDb));
  record.set("thresholdDb", js::Json::number(params.thresholdDb));
  record.set("attackMs", js::Json::number(params.attackMs));
  record.set("releaseMs", js::Json::number(params.releaseMs));
  record.set("holdMs", js::Json::number(params.holdMs));
  record.set("voiceNodeId", js::Json::string(voice.layer));
  const std::string recordJson = js::stringify(record);
  const Range range = driver_range(ctx.doc, music.comp);
  const double base = static_level_db(ctx.doc, music.layer);
  const std::vector<aa::ClipTiming> voiceTimings = timings_of(voice);
  return PreparedJob{"audioDuck", [music, voice, params, recordJson, range, base, voiceTimings](JobControl& control) -> std::unique_ptr<JobResult> {
    control.progress(0.1, "Decoding the voice");
    int sr = 0;
    const std::vector<float> mono = read_mono(voice.file, sr);
    if (control.cancelled()) return nullptr;
    control.progress(0.5, "Following the voice");
    const std::vector<float> aligned = aa::align_samples_to_range(mono, sr, voiceTimings, range.start, range.end);
    const std::vector<float> sidechain = aa::raw_detector_envelope(aligned, sr, range.fps);
    if (sidechain.empty()) fail(ErrorCode::invalid_argument, "That layer’s audio has not decoded (or has no sound in this range).");
    const std::vector<float> gain = aa::duck_levels(sidechain, params, range.fps);
    std::vector<float> levels(gain.size());
    double peak = 0;
    for (std::size_t i = 0; i < gain.size(); ++i) {
      const double g = gain[i];
      if (g < peak) peak = g;
      levels[i] = static_cast<float>(std::max(aa::kMinLevelDb, base + g));
    }
    auto out = std::make_unique<LevelResult>();
    out->layer = music.layer;
    out->recordPath = "audio/ducking";
    out->recordJson = recordJson;
    out->entryLabel = "Duck Music";
    out->range = range;
    out->envelope = sidechain;
    out->reportPeak = true;
    out->peakDuckDb = round_to(peak, 10);
    for (const std::size_t fi : aa::thin_levels(levels)) {
      const double t = range.start + static_cast<double>(fi) / range.fps;
      if (t > range.end + 1e-9) break;
      out->keys.emplace_back(t, round_to(levels[fi], 100));
    }
    control.progress(1, "Done");
    return out;
  }};
}

PreparedJob prepare_audio_gate(const api::AudioGateJob& spec, const JobDocContext& ctx) {
  const FootageLayer f = footage_layer(ctx, spec.layer, Need::sound);
  const js::Json p = parse_params(spec.params);
  aa::GateParams params;
  params.thresholdDb = param(p, "thresholdDb", params.thresholdDb);
  params.attackMs = param(p, "attackMs", params.attackMs);
  params.holdMs = param(p, "holdMs", params.holdMs);
  params.releaseMs = param(p, "releaseMs", params.releaseMs);
  params.rangeDb = param(p, "rangeDb", params.rangeDb);
  js::Json record = js::Json::object();
  record.set("thresholdDb", js::Json::number(params.thresholdDb));
  record.set("attackMs", js::Json::number(params.attackMs));
  record.set("holdMs", js::Json::number(params.holdMs));
  record.set("releaseMs", js::Json::number(params.releaseMs));
  record.set("rangeDb", js::Json::number(params.rangeDb));
  const std::string recordJson = js::stringify(record);
  Range range = driver_range(ctx.doc, f.comp);
  // audioGate.ts computeGateEnvelope: clipped to the layer's own audible span.
  const std::vector<aa::ClipTiming> timings = timings_of(f);
  {
    double start = f.in_seconds();
    double end = f.out_seconds();
    if (!timings.empty()) {
      start = timings.front().startSec;
      end = timings.front().startSec + (timings.front().outSec - timings.front().inSec);
    }
    if (end > start) {
      range.start = std::max(range.start, start);
      range.end = std::min(range.end, end);
    }
    if (!(range.end > range.start)) fail(ErrorCode::invalid_argument, "Nothing to gate in this range.");
  }
  const double base = static_level_db(ctx.doc, f.layer);
  return PreparedJob{"audioGate", [f, params, recordJson, range, base, timings](JobControl& control) -> std::unique_ptr<JobResult> {
    control.progress(0.1, "Decoding audio");
    int sr = 0;
    const std::vector<float> mono = read_mono(f.file, sr);
    if (control.cancelled()) return nullptr;
    control.progress(0.5, "Following the level");
    const std::vector<float> aligned = aa::align_samples_to_range(mono, sr, timings, range.start, range.end);
    const std::vector<float> env = aa::raw_detector_envelope(aligned, sr, range.fps);
    if (env.empty()) fail(ErrorCode::invalid_argument, "That layer’s audio has not decoded (or has no sound in this range).");
    const std::vector<float> curve = aa::gate_levels(env, params, range.fps);
    std::vector<float> levels(curve.size());
    for (std::size_t i = 0; i < curve.size(); ++i) {
      levels[i] = static_cast<float>(std::max(aa::kMinLevelDb, base + static_cast<double>(curve[i])));
    }
    auto out = std::make_unique<LevelResult>();
    out->layer = f.layer;
    out->recordPath = "audio/gate";
    out->recordJson = recordJson;
    out->entryLabel = "Noise Gate";
    out->range = range;
    out->envelope = env;
    std::size_t closed = 0;
    for (const float v : curve) {
      if (v < -0.5F) ++closed;
    }
    out->closedFraction = curve.empty() ? 0.0 : static_cast<double>(closed) / static_cast<double>(curve.size());
    for (const std::size_t fi : aa::thin_levels(levels)) {
      out->keys.emplace_back(range.start + static_cast<double>(fi) / range.fps, round_to(levels[fi], 100));
    }
    control.progress(1, "Done");
    return out;
  }};
}

namespace {

class EnvelopeResult final : public JobResult {
 public:
  EnvelopeResult(std::vector<float> raw, double fps, double start, double end)
      : raw_(std::move(raw)), fps_(fps), start_(start), end_(end) {}
  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"raw\":[";
    for (std::size_t i = 0; i < raw_.size(); ++i) s += (i > 0 ? "," : "") + json_number(static_cast<double>(raw_[i]));
    return s + "],\"fps\":" + json_number(fps_) + ",\"start\":" + json_number(start_) + ",\"end\":" + json_number(end_) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Audio driver"; }
  [[nodiscard]] bool has_edits() const override { return false; }
  void apply(JobApply& /*a*/) const override {}

 private:
  std::vector<float> raw_;
  double fps_, start_, end_;
};

}  // namespace

PreparedJob prepare_audio_envelope(const api::AudioEnvelopeJob& spec, const JobDocContext& ctx) {
  if (ctx.doc.comp(spec.comp) == nullptr) fail(ErrorCode::not_found, "no composition '" + spec.comp + "'", {.item = spec.comp});
  Range range = driver_range(ctx.doc, spec.comp);
  range.start = seconds_of(spec.range.start);
  range.end = seconds_of(spec.range.start + spec.range.duration);
  if (!(range.end > range.start)) fail(ErrorCode::invalid_argument, "the range is empty");
  aa::DetectorOptions o;
  o.lo = spec.band_lo;
  o.hi = spec.band_hi;
  o.attackMs = spec.attack_ms.value_or(0);
  o.releaseMs = spec.release_ms.value_or(0);
  o.gate = spec.gate.value_or(0);
  o.normalize = spec.normalize.value_or(true);
  if (spec.source && !spec.source->empty()) {
    const FootageLayer f = footage_layer(ctx, *spec.source, Need::sound);
    const std::vector<aa::ClipTiming> timings = timings_of(f);
    return PreparedJob{"audioEnvelope", [f, timings, range, o](JobControl& control) -> std::unique_ptr<JobResult> {
      control.progress(0.1, "Decoding audio");
      int sr = 0;
      const std::vector<float> mono = read_mono(f.file, sr);
      if (control.cancelled()) return nullptr;
      control.progress(0.6, "Following the audio");
      const std::vector<float> aligned = aa::align_samples_to_range(mono, sr, timings, range.start, range.end);
      return std::make_unique<EnvelopeResult>(aa::detector_envelope(aligned, sr, range.fps, o), range.fps, range.start, range.end);
    }};
  }
  // The comp's mix: a child engine's audio-only export of the range (kind_transcribe.cpp's mixdown).
  std::string projectJson = snapshot_project_json(ctx.doc, ctx.bundleRoot);
  const std::string comp = spec.comp;
  return PreparedJob{"audioEnvelope", [projectJson = std::move(projectJson), comp, range, o](JobControl& control) -> std::unique_ptr<JobResult> {
    TempTree tree("premation-driver");
    const std::filesystem::path project = tree.path / "project.motion";
    {
      std::ofstream file(project, std::ios::binary | std::ios::trunc);
      file << projectJson;
      if (!file) fail(ErrorCode::io, "cannot write the mixdown snapshot");
    }
    const auto startFrame = static_cast<std::int64_t>(std::floor(range.start * range.fps + 1e-6));
    const auto endFrame = std::max(startFrame, static_cast<std::int64_t>(std::ceil(range.end * range.fps - 1e-6)) - 1);
    js::Json job = js::Json::object();
    job.set("projectPath", js::Json::string(project.string()));
    job.set("workDir", js::Json::string(tree.path.string()));
    job.set("comp", js::Json::string(comp));
    job.set("startFrame", js::Json::number(static_cast<double>(startFrame)));
    job.set("endFrame", js::Json::number(static_cast<double>(endFrame)));
    job.set("audioOnly", js::Json::boolean(true));
    job.set("buildThreads", js::Json::number(1));
    const std::optional<js::Json> pre = run_child_export(job, tree.path, control, "Mixing", 0.02, 0.6);
    if (!pre) return nullptr;
    const auto none = [&] { return std::make_unique<EnvelopeResult>(std::vector<float>{}, range.fps, range.start, range.end); };
    if (!pre->at("audio").is_string()) return none();
    std::vector<std::uint8_t> wav;
    {
      std::ifstream file(std::filesystem::path(pre->at("audio").str()), std::ios::binary);
      wav.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    }
    const std::optional<speech::Pcm> pcm = speech::read_wav16(wav);
    if (!pcm || pcm->channels.empty()) return none();
    const std::vector<float> mono = speech::to_mono(pcm->channels);
    control.progress(0.8, "Following the mix");
    return std::make_unique<EnvelopeResult>(aa::detector_envelope(mono, pcm->sampleRate, range.fps, o), range.fps, range.start, range.end);
  }};
}

}  // namespace premation::jobs
