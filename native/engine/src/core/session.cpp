#include "session.hpp"

#include <algorithm>
#include <cmath>
#include <set>
#include <thread>
#include <type_traits>
#include <utility>
#include <variant>

#include "log.hpp"

namespace premation {
namespace {

using api::ErrorCode;
using Clock = Session::Clock;

// ── variant helpers ─────────────────────────────────────────────────────────

template <class T, class V>
struct IndexOf;
template <class T, class... Ts>
struct IndexOf<T, std::variant<Ts...>> {
  static constexpr std::size_t value = [] {
    constexpr bool same[] = {std::is_same_v<T, Ts>...};
    for (std::size_t i = 0; i < sizeof...(Ts); ++i) {
      if (same[i]) return i;
    }
    return sizeof...(Ts);
  }();
};

using CommandVariant = decltype(api::Command::v);
using QueryVariant = decltype(api::Query::v);

/// The CommandResult for command type `Cmd`. The generated CommandResult union
/// has one alternative per command, in the SAME order as Command's, with
/// repeated payload types (many are Empty) — so it can only be built by index.
template <class Cmd, class... Args>
api::CommandResult result_for(Args&&... args) {
  constexpr std::size_t i = IndexOf<Cmd, CommandVariant>::value;
  static_assert(i < std::variant_size_v<CommandVariant>);
  api::CommandResult r;
  r.v.template emplace<i>(std::forward<Args>(args)...);
  return r;
}

template <class Q, class... Args>
api::QueryResult query_result_for(Args&&... args) {
  constexpr std::size_t i = IndexOf<Q, QueryVariant>::value;
  static_assert(i < std::variant_size_v<QueryVariant>);
  api::QueryResult r;
  r.v.template emplace<i>(std::forward<Args>(args)...);
  return r;
}

template <class... Ts>
struct TypeList {};
template <class T, class L>
struct Contains;
template <class T, class... Ts>
struct Contains<T, TypeList<Ts...>> : std::bool_constant<(std::is_same_v<T, Ts> || ...)> {};

// ── The command set, classified ─────────────────────────────────────────────
//
// Every alternative of api::Command is handled by exactly one of:
//   • an explicit CommandVisitor overload (implemented in C2), or
//   • this list (answered with a typed `unsupported` "not implemented yet").
// std::visit refuses to compile if a command is in neither, so a command added
// to the schema breaks the engine build until someone decides what it does.
using NotYetCommands = TypeList<
    api::OpenProject, api::SaveProject, api::ImportProject, api::SetProjectSettings, api::RevertProject,
    api::CollectFiles, api::SetAutosave, api::ImportFiles, api::RelinkItem, api::ReloadItems, api::RemoveItems,
    api::RenameItem, api::CreateFolder, api::MoveItems, api::SetInterpretation, api::SetItemLabel,
    api::RemoveUnusedItems, api::SetProxy, api::SetItemComment, api::SetItemTags, api::DuplicateComposition,
    api::SetWorkArea, api::Precompose, api::TrimCompToWorkArea, api::CropComposition, api::AssembleComposition,
    api::AddRenderItems, api::SetRenderItem, api::RemoveRenderItems, api::ReorderRenderItems, api::DuplicateLayers,
    api::SetParent, api::SetLayerSwitches, api::SetBlendMode, api::SetTrackMatte, api::ReplaceLayerSource,
    api::GroupLayers, api::UngroupLayer, api::ConvertLayer, api::PasteLayers, api::SeparateLayer, api::AutoTrace,
    api::SetLayerComment, api::SetLayerTiming, api::MoveLayersInTime, api::TrimLayers, api::SlipLayers,
    api::SlideLayer, api::RollEdit, api::SplitLayers, api::RippleDeleteLayers, api::EditWorkArea, api::InsertGap,
    api::TimeReverseLayers, api::SetTimeRemap, api::FreezeFrame, api::SetRetime, api::SequenceLayers,
    api::ResetProperty, api::SetDimensionsSeparated, api::SetExpression, api::SetExpressionEnabled,
    api::ConvertExpressionToKeyframes, api::LinkProperty, api::MoveKeyframes, api::UpdateKeyframes,
    api::ScaleKeyframes, api::ReverseKeyframes, api::PasteKeyframes, api::AddEffect, api::AddMask,
    api::AddPropertyGroup, api::RemovePropertyGroups, api::MovePropertyGroup, api::DuplicatePropertyGroups,
    api::SetGroupEnabled, api::RenamePropertyGroup, api::CopyPropertyGroups, api::ApplyPreset,
    api::InvokeEffectAction, api::AddMarkers, api::UpdateMarkers, api::DeleteMarkers, api::MoveMarkers,
    api::SetAudioPreview, api::SetCacheBudget, api::PurgeCache, api::StartJob, api::CancelJob, api::ApplyJobResult,
    api::SetPluginEnabled, api::SetPluginData>;

/// Implemented commands that are edits (may appear in a batch, enter history).
using EditCommands = TypeList<api::CreateComposition, api::SetCompositionSettings, api::CreateLayer,
                              api::DeleteLayers, api::ReorderLayers, api::RenameLayer, api::SetProperty,
                              api::SetProperties, api::SetAnimated, api::AddKeyframes, api::DeleteKeyframes>;

using NotYetQueries = TypeList<api::SampleProperty, api::GetMotionPath, api::GetMarkers, api::CopyLayers,
                               api::GetWaveform, api::ListFonts, api::GetItems, api::GetThumbnail, api::ListEffects,
                               api::ListGroupTypes, api::ListPresets, api::HitTest, api::GetLayerBounds,
                               api::GetTextLayout, api::EvaluateExpression, api::ReadPixels, api::FindLayers,
                               api::GetDependencies, api::GetJobs, api::GetRenderQueue, api::GetCommandLog>;

template <class T>
concept NotYetCommand = Contains<T, NotYetCommands>::value;
template <class T>
concept NotYetQuery = Contains<T, NotYetQueries>::value;

bool is_edit(const api::Command& c) {
  return std::visit([](const auto& x) { return Contains<std::decay_t<decltype(x)>, EditCommands>::value; }, c.v);
}
bool is_not_yet(const api::Command& c) {
  return std::visit([](const auto& x) { return Contains<std::decay_t<decltype(x)>, NotYetCommands>::value; }, c.v);
}

// ── errors ──────────────────────────────────────────────────────────────────

api::EngineError err(ErrorCode code, std::string message) {
  api::EngineError e;
  e.code = code;
  e.message = std::move(message);
  return e;
}

api::EngineError layer_not_found(const api::LayerId& id) {
  api::EngineError e = err(ErrorCode::not_found, "no layer '" + id + "'");
  e.layer = id;
  return e;
}

api::EngineError comp_not_found(const api::ItemId& id) {
  api::EngineError e = err(ErrorCode::not_found, "no composition '" + id + "'");
  e.item = id;
  return e;
}

api::EngineError not_implemented(std::uint32_t id, std::string_view what) {
  api::EngineError e = err(ErrorCode::unsupported, std::string(what) + " " + std::to_string(id) +
                                                       " is not implemented yet in premation-engine");
  e.detail = "{\"notImplemented\":true,\"id\":" + std::to_string(id) + "}";
  return e;
}

api::EngineError decode_error(wire::Status s) {
  api::EngineError e = err(s == wire::Status::unknown_variant ? ErrorCode::unsupported : ErrorCode::decode,
                           "could not decode the message: " + std::string(wire::to_string(s)));
  e.detail = "{\"status\":\"" + std::string(wire::to_string(s)) + "\"}";
  return e;
}

// ── events ──────────────────────────────────────────────────────────────────

template <std::size_t I, class Payload>
api::Event event_of(Payload p) {
  api::Event e;
  e.v.template emplace<I>(std::move(p));
  return e;
}
template <class Payload>
api::Event make_event(Payload p) {
  return event_of<IndexOf<Payload, decltype(api::Event::v)>::value>(std::move(p));
}

double resolution_factor(api::PreviewResolution r) {
  switch (r) {
    case api::PreviewResolution::full: return 1.0;
    case api::PreviewResolution::half: return 0.5;
    case api::PreviewResolution::third: return 1.0 / 3.0;
    case api::PreviewResolution::quarter: return 0.25;
    case api::PreviewResolution::auto_: return 1.0;  // adaptive quality not implemented: full
  }
  return 1.0;
}

std::int64_t floor_div(std::int64_t a, std::int64_t b) {
  const std::int64_t q = a / b;
  return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q;
}
std::int64_t mod_pos(std::int64_t a, std::int64_t b) {
  const std::int64_t m = a % b;
  return m < 0 ? m + b : m;
}

std::string label_for_property(const doc::Layer& layer, std::string_view path) {
  if (const doc::PropertySpec* s = doc::find_spec(layer.kind, path)) return "Set " + std::string(s->name);
  return "Set Property";
}

std::string default_layer_name(api::LayerKind kind, const doc::Comp& comp) {
  std::string base;
  switch (kind) {
    case api::LayerKind::solid: base = "Solid"; break;
    case api::LayerKind::shape: base = "Shape Layer"; break;
    case api::LayerKind::rectangle: base = "Rectangle"; break;
    case api::LayerKind::null: base = "Null"; break;
    default: base = "Layer"; break;
  }
  return base + " " + std::to_string(comp.layers.size() + 1);
}

std::optional<api::EngineError> validate_comp_patch(const api::CompSettingsPatch& p) {
  if (p.width && (*p.width < 1 || *p.width > 30000)) return err(ErrorCode::out_of_range, "width must be 1..30000");
  if (p.height && (*p.height < 1 || *p.height > 30000)) {
    return err(ErrorCode::out_of_range, "height must be 1..30000");
  }
  if (p.frame_rate) {
    const double fps = doc::fps_of(*p.frame_rate);
    if (fps <= 0.0 || fps > 1000.0) return err(ErrorCode::out_of_range, "frame rate must be > 0 and <= 1000 fps");
  }
  if (p.duration && (*p.duration <= 0 || *p.duration > 1000LL * 3600LL * doc::kFlicksPerSecond)) {
    return err(ErrorCode::out_of_range, "duration must be > 0 and at most 1000 hours");
  }
  if (p.pixel_aspect && !(*p.pixel_aspect > 0.0 && std::isfinite(*p.pixel_aspect))) {
    return err(ErrorCode::out_of_range, "pixel aspect must be > 0");
  }
  if (p.background_gradient || p.clear_background_gradient || p.motion_blur || p.renderer3d ||
      p.global_light_angle || p.global_light_altitude || p.world || p.start_timecode || p.drop_frame ||
      p.preserve_frame_rate || p.preserve_resolution) {
    return err(ErrorCode::unsupported, "only name, size, pixel aspect, frame rate, duration, background, "
                                       "transparency and work area are implemented yet in premation-engine");
  }
  return std::nullopt;
}

void apply_comp_patch(api::CompSettings& s, const api::CompSettingsPatch& p) {
  if (p.name) s.name = *p.name;
  if (p.width) s.width = *p.width;
  if (p.height) s.height = *p.height;
  if (p.pixel_aspect) s.pixel_aspect = *p.pixel_aspect;
  if (p.frame_rate) s.frame_rate = *p.frame_rate;
  if (p.duration) {
    s.duration = *p.duration;
    if (!p.work_area) s.work_area = api::TimeRange{0, s.duration};
  }
  if (p.background) s.background = *p.background;
  if (p.transparent) s.transparent = *p.transparent;
  if (p.work_area) s.work_area = *p.work_area;
}

}  // namespace

// ── Command dispatch ────────────────────────────────────────────────────────

struct CommandVisitor {
  Session& s;
  api::Origin origin;
  Clock::time_point now;
  using Outcome = Session::Outcome;

  static Outcome fail(api::EngineError e) {
    Outcome o;
    o.error = std::move(e);
    return o;
  }
  template <class Cmd, class... Args>
  static Outcome ok(Session::OutcomeKind kind, std::string label, Args&&... args) {
    Outcome o;
    o.kind = kind;
    o.label = std::move(label);
    o.result = result_for<Cmd>(std::forward<Args>(args)...);
    return o;
  }
  template <class Cmd, class... Args>
  static Outcome control(Args&&... args) {
    return ok<Cmd>(Session::OutcomeKind::control, {}, std::forward<Args>(args)...);
  }
  template <class Cmd, class... Args>
  static Outcome edit(std::string label, Args&&... args) {
    return ok<Cmd>(Session::OutcomeKind::edit, std::move(label), std::forward<Args>(args)...);
  }

  template <NotYetCommand T>
  Outcome operator()(const T&) const {
    return fail(not_implemented(static_cast<std::uint32_t>(api::Command{CommandVariant{T{}}}.kind()), "command"));
  }

  // ── history ──
  Outcome operator()(const api::Undo&) const {
    if (s.history_.gesture_open()) return fail(err(ErrorCode::gesture_open, "undo while a gesture is open"));
    const doc::Entry* e = s.history_.step_back();
    if (e == nullptr) return fail(err(ErrorCode::nothing_to_undo, "nothing to undo"));
    e->changes.apply_before(s.doc_);
    Outcome o = ok<api::Undo>(Session::OutcomeKind::history_move, {},
                              api::HistoryStep{e->label, static_cast<std::uint32_t>(s.history_.position())});
    o.moved = e->changes.reversed();
    return o;
  }
  Outcome operator()(const api::Redo&) const {
    if (s.history_.gesture_open()) return fail(err(ErrorCode::gesture_open, "redo while a gesture is open"));
    const doc::Entry* e = s.history_.step_forward();
    if (e == nullptr) return fail(err(ErrorCode::nothing_to_redo, "nothing to redo"));
    e->changes.apply_after(s.doc_);
    Outcome o = ok<api::Redo>(Session::OutcomeKind::history_move, {},
                              api::HistoryStep{e->label, static_cast<std::uint32_t>(s.history_.position())});
    o.moved = e->changes;
    return o;
  }
  Outcome operator()(const api::JumpToHistory& c) const {
    if (s.history_.gesture_open()) return fail(err(ErrorCode::gesture_open, "history jump while a gesture is open"));
    if (c.position > s.history_.state().entries.size()) {
      return fail(err(ErrorCode::out_of_range, "history position past the last entry"));
    }
    doc::ChangeSet moved;
    std::string label;
    while (s.history_.position() > c.position) {
      const doc::Entry* e = s.history_.step_back();
      e->changes.apply_before(s.doc_);
      moved.merge(e->changes.reversed());
      label = e->label;
    }
    while (s.history_.position() < c.position) {
      const doc::Entry* e = s.history_.step_forward();
      e->changes.apply_after(s.doc_);
      moved.merge(e->changes);
      label = e->label;
    }
    Outcome o = ok<api::JumpToHistory>(Session::OutcomeKind::history_move, {},
                                       api::HistoryStep{label, static_cast<std::uint32_t>(s.history_.position())});
    o.moved = std::move(moved);
    return o;
  }
  Outcome operator()(const api::BeginGesture& c) const {
    if (s.history_.gesture_open()) return fail(err(ErrorCode::gesture_open, "a gesture is already open"));
    const std::uint32_t id = s.history_.begin_gesture(c.label.empty() ? "Edit" : c.label, origin);
    Outcome o = control<api::BeginGesture>(api::GestureRef{id});
    o.historyChanged = true;
    return o;
  }
  Outcome operator()(const api::EndGesture& c) const {
    if (!s.history_.gesture_open() || (c.gesture != 0 && c.gesture != s.history_.gesture_id())) {
      return fail(err(ErrorCode::no_gesture, "no open gesture with that id"));
    }
    doc::Entry entry = s.history_.end_gesture();
    entry.changes.prune();
    if (c.commit) {
      s.history_.record(entry.label, entry.origin, entry.changes);
      Outcome o = control<api::EndGesture>();
      o.historyChanged = true;
      return o;
    }
    // Cancel: put every touched entity back exactly as it was (Esc mid-drag).
    entry.changes.apply_before(s.doc_);
    Outcome o = ok<api::EndGesture>(Session::OutcomeKind::history_move, {});
    o.moved = entry.changes.reversed();
    return o;
  }
  Outcome operator()(const api::ClearHistory&) const {
    s.history_.clear();
    Outcome o = control<api::ClearHistory>();
    o.historyChanged = true;
    return o;
  }
  Outcome operator()(const api::SetHistoryLimit& c) const {
    s.history_.set_limit(c.entries);
    Outcome o = control<api::SetHistoryLimit>();
    o.historyChanged = true;
    return o;
  }

  // ── project ──
  Outcome operator()(const api::NewProject& c) const {
    if (c.template_) return fail(err(ErrorCode::unsupported, "project templates are not implemented yet"));
    s.stop_playback();
    s.doc_ = doc::Document{};
    s.history_.clear();
    if (s.history_.gesture_open()) (void)s.history_.end_gesture();
    s.activeComp_.reset();
    s.time_ = 0;
    s.frame_ = 0;
    return ok<api::NewProject>(Session::OutcomeKind::reset, {});
  }

  // ── compositions ──
  Outcome operator()(const api::CreateComposition& c) const {
    if (!c.from_items.empty()) return fail(err(ErrorCode::unsupported, "createComposition fromItems is not implemented yet"));
    if (c.folder) return fail(err(ErrorCode::unsupported, "folders are not implemented yet"));
    if (auto e = validate_comp_patch(c.settings)) return fail(std::move(*e));
    doc::Comp comp;
    comp.id = s.doc_.mint_comp_id();
    comp.settings = doc::default_comp_settings();
    comp.settings.name = "Comp " + std::to_string(s.doc_.comps.size() + 1);
    apply_comp_patch(comp.settings, c.settings);
    s.txn_.touch_comp(s.doc_, comp.id);
    const std::string id = comp.id;
    s.doc_.comps.emplace(id, std::move(comp));
    s.doc_.itemOrder.push_back(id);
    return edit<api::CreateComposition>("New Composition", api::ItemRef{id});
  }
  Outcome operator()(const api::SetCompositionSettings& c) const {
    doc::Comp* comp = s.doc_.comp(c.comp);
    if (comp == nullptr) return fail(comp_not_found(c.comp));
    if (auto e = validate_comp_patch(c.patch)) return fail(std::move(*e));
    s.txn_.touch_comp(s.doc_, c.comp);
    apply_comp_patch(comp->settings, c.patch);
    return edit<api::SetCompositionSettings>("Composition Settings");
  }

  // ── layers ──
  Outcome operator()(const api::CreateLayer& c) const {
    doc::Comp* comp = s.doc_.comp(c.comp);
    if (comp == nullptr) return fail(comp_not_found(c.comp));
    if (!doc::kind_supported(c.kind)) {
      return fail(err(ErrorCode::unsupported,
                      "layer kind '" + std::string(api::to_string(c.kind)) + "' is not implemented yet in premation-engine"));
    }
    if (c.parent) return fail(err(ErrorCode::unsupported, "parenting is not implemented yet in premation-engine"));
    if (c.source) return fail(err(ErrorCode::unsupported, "layer sources are not implemented yet in premation-engine"));
    if (c.generator) return fail(err(ErrorCode::unsupported, "generator layers are not implemented yet"));
    const std::size_t index = c.index.value_or(0);
    if (index > comp->layers.size()) return fail(err(ErrorCode::out_of_range, "stack index past the bottom"));

    const std::string id = s.doc_.mint_layer_id();
    doc::Layer layer = doc::make_layer(c.kind, *comp, id, c.name.value_or(default_layer_name(c.kind, *comp)));
    if (c.in_point) layer.timing.in_point = *c.in_point;
    if (c.out_point) layer.timing.out_point = *c.out_point;
    if (c.start_time) layer.timing.start_time = *c.start_time;
    if (layer.timing.out_point <= layer.timing.in_point) {
      return fail(err(ErrorCode::invalid_argument, "out point must be after in point"));
    }
    s.txn_.touch_comp(s.doc_, c.comp);
    s.txn_.touch_layer(s.doc_, id);
    comp->layers.insert(comp->layers.begin() + static_cast<std::ptrdiff_t>(index), id);
    s.doc_.layers.emplace(id, std::move(layer));
    bool sizeGiven = false;
    bool anchorGiven = false;
    for (std::size_t i = 0; i < c.init.size(); ++i) {
      std::optional<api::KeyframeId> key;
      if (auto e = s.write_property(api::PropRef{id, c.init[i].path}, c.init[i].value, std::nullopt, key)) {
        return fail(std::move(*e));
      }
      sizeGiven = sizeGiven || c.init[i].path == "layer/size";
      anchorGiven = anchorGiven || c.init[i].path == "transform/anchorPoint";
    }
    if (sizeGiven && !anchorGiven) {
      // A new solid's anchor is its centre (AE), for the size it was created with.
      doc::Layer& created = *s.doc_.layer(id);
      std::array<double, 4> size{};
      (void)doc::components(created.props.at("layer/size").value, size);
      created.props.at("transform/anchorPoint").value = doc::make_vec2(size[0] / 2.0, size[1] / 2.0);
    }
    return edit<api::CreateLayer>("New Layer", api::LayerRef{id});
  }
  Outcome operator()(const api::DeleteLayers& c) const {
    std::set<std::string, std::less<>> seen;
    for (const auto& id : c.layers) {
      if (!seen.insert(id).second) continue;
      doc::Layer* layer = s.doc_.layer(id);
      if (layer == nullptr) return fail(layer_not_found(id));
      s.txn_.touch_comp(s.doc_, layer->comp);
      s.txn_.touch_layer(s.doc_, id);
      if (doc::Comp* comp = s.doc_.comp(layer->comp)) std::erase(comp->layers, id);
      s.doc_.layers.erase(id);
    }
    return edit<api::DeleteLayers>(seen.size() == 1 ? "Delete Layer" : "Delete Layers");
  }
  Outcome operator()(const api::ReorderLayers& c) const {
    doc::Comp* comp = s.doc_.comp(c.comp);
    if (comp == nullptr) return fail(comp_not_found(c.comp));
    std::vector<api::LayerId> moving;
    for (const auto& id : comp->layers) {  // keep their relative (stack) order
      if (std::find(c.layers.begin(), c.layers.end(), id) != c.layers.end()) moving.push_back(id);
    }
    for (const auto& id : c.layers) {
      if (std::find(comp->layers.begin(), comp->layers.end(), id) == comp->layers.end()) return fail(layer_not_found(id));
    }
    std::vector<api::LayerId> rest;
    for (const auto& id : comp->layers) {
      if (std::find(moving.begin(), moving.end(), id) == moving.end()) rest.push_back(id);
    }
    if (c.to_index > rest.size()) return fail(err(ErrorCode::out_of_range, "toIndex past the bottom of the stack"));
    s.txn_.touch_comp(s.doc_, c.comp);
    rest.insert(rest.begin() + static_cast<std::ptrdiff_t>(c.to_index), moving.begin(), moving.end());
    comp->layers = std::move(rest);
    return edit<api::ReorderLayers>("Reorder Layers");
  }
  Outcome operator()(const api::RenameLayer& c) const {
    doc::Layer* layer = s.doc_.layer(c.layer);
    if (layer == nullptr) return fail(layer_not_found(c.layer));
    s.txn_.touch_layer(s.doc_, c.layer);
    layer->name = c.name;
    return edit<api::RenameLayer>("Rename Layer");
  }

  // ── properties and keyframes ──
  Outcome operator()(const api::SetProperty& c) const {
    std::optional<api::KeyframeId> key;
    if (auto e = s.write_property(c.prop, c.value, c.time, key)) return fail(std::move(*e));
    const doc::Layer* layer = s.doc_.layer(c.prop.layer);
    return edit<api::SetProperty>(label_for_property(*layer, c.prop.path), api::PropertyWriteResult{key});
  }
  Outcome operator()(const api::SetProperties& c) const {
    for (std::size_t i = 0; i < c.writes.size(); ++i) {
      std::optional<api::KeyframeId> key;
      if (auto e = s.write_property(c.writes[i].prop, c.writes[i].value, c.writes[i].time, key)) {
        e->detail = "{\"writeIndex\":" + std::to_string(i) + "}";
        return fail(std::move(*e));
      }
    }
    return edit<api::SetProperties>("Set Properties");
  }
  Outcome operator()(const api::SetAnimated& c) const {
    doc::Layer* layer = s.doc_.layer(c.prop.layer);
    if (layer == nullptr) return fail(layer_not_found(c.prop.layer));
    const doc::PropertySpec* spec = doc::find_spec(layer->kind, c.prop.path);
    const auto it = layer->props.find(c.prop.path);
    if (spec == nullptr || it == layer->props.end()) {
      api::EngineError e = err(ErrorCode::not_found, "no property '" + c.prop.path + "'");
      e.layer = c.prop.layer;
      e.path = c.prop.path;
      return fail(std::move(e));
    }
    if (!spec->animatable) {
      api::EngineError e = err(ErrorCode::not_animatable, "'" + c.prop.path + "' cannot be keyframed");
      e.path = c.prop.path;
      return fail(std::move(e));
    }
    s.txn_.touch_layer(s.doc_, c.prop.layer);
    doc::Property& prop = it->second;
    std::optional<api::KeyframeId> keyId;
    const api::Value current = eval::value_at(prop, c.time, s.scratch_);
    if (c.animated) {
      if (prop.keys.empty()) {
        api::Keyframe k;
        k.id = s.doc_.mint_key_id();
        k.time = c.time;
        k.value = current;
        keyId = k.id;
        prop.keys.push_back(std::move(k));
      }
    } else {
      prop.value = current;
      prop.keys.clear();
    }
    return edit<api::SetAnimated>(c.animated ? "Enable Keyframes" : "Disable Keyframes", api::PropertyWriteResult{keyId});
  }
  Outcome operator()(const api::AddKeyframes& c) const {
    api::KeyframeIds ids;
    for (const api::KeyframeInsert& ins : c.keys) {
      doc::Layer* layer = s.doc_.layer(ins.prop.layer);
      if (layer == nullptr) return fail(layer_not_found(ins.prop.layer));
      const doc::PropertySpec* spec = doc::find_spec(layer->kind, ins.prop.path);
      const auto it = layer->props.find(ins.prop.path);
      if (spec == nullptr || it == layer->props.end()) {
        api::EngineError e = err(ErrorCode::not_found, "no property '" + ins.prop.path + "'");
        e.layer = ins.prop.layer;
        e.path = ins.prop.path;
        return fail(std::move(e));
      }
      if (!spec->animatable) {
        api::EngineError e = err(ErrorCode::not_animatable, "'" + ins.prop.path + "' cannot be keyframed");
        e.layer = ins.prop.layer;
        e.path = ins.prop.path;
        return fail(std::move(e));
      }
      doc::Property& prop = it->second;
      api::Value value = ins.value ? *ins.value : eval::value_at(prop, ins.time, s.scratch_);
      if (doc::value_type_of(value) != prop.type) {
        api::EngineError e = err(ErrorCode::type_mismatch, "'" + ins.prop.path + "' takes a " +
                                                               std::string(api::to_string(prop.type)));
        e.path = ins.prop.path;
        e.detail = "{\"expected\":\"" + std::string(api::to_string(prop.type)) + "\"}";
        return fail(std::move(e));
      }
      if (!doc::all_finite(value)) return fail(err(ErrorCode::invalid_argument, "keyframe value is not finite"));
      if (ins.bezier && !(std::isfinite(ins.bezier->x1) && std::isfinite(ins.bezier->y1) &&
                          std::isfinite(ins.bezier->x2) && std::isfinite(ins.bezier->y2))) {
        return fail(err(ErrorCode::invalid_argument, "bezier handles are not finite"));
      }
      s.txn_.touch_layer(s.doc_, ins.prop.layer);
      auto pos = std::lower_bound(prop.keys.begin(), prop.keys.end(), ins.time,
                                  [](const api::Keyframe& k, api::Time t) { return k.time < t; });
      api::Keyframe* key = nullptr;
      if (pos != prop.keys.end() && pos->time == ins.time) {
        key = &*pos;  // replaced — keeps its id (§4.6)
      } else {
        api::Keyframe k;
        k.id = s.doc_.mint_key_id();
        k.time = ins.time;
        key = &*prop.keys.insert(pos, std::move(k));
      }
      key->value = std::move(value);
      if (ins.easing) key->easing = *ins.easing;
      if (ins.bezier) key->bezier = ins.bezier;
      if (ins.roving) key->roving = *ins.roving;
      if (ins.spatial_interp) key->spatial_interp = *ins.spatial_interp;
      if (!ins.spatial_in.empty()) key->spatial_in = ins.spatial_in;
      if (!ins.spatial_out.empty()) key->spatial_out = ins.spatial_out;
      ids.ids.push_back(key->id);
    }
    return edit<api::AddKeyframes>(c.keys.size() == 1 ? "Add Keyframe" : "Add Keyframes", std::move(ids));
  }
  Outcome operator()(const api::DeleteKeyframes& c) const {
    for (const auto& id : c.ids) {
      bool found = false;
      for (auto& [layerId, layer] : s.doc_.layers) {
        for (auto& [path, prop] : layer.props) {
          const auto k = std::find_if(prop.keys.begin(), prop.keys.end(),
                                      [&id](const api::Keyframe& key) { return key.id == id; });
          if (k == prop.keys.end()) continue;
          s.txn_.touch_layer(s.doc_, layerId);
          if (prop.keys.size() == 1) prop.value = k->value;  // last key: static at its value
          prop.keys.erase(k);
          found = true;
          break;
        }
        if (found) break;
      }
      if (!found) return fail(err(ErrorCode::not_found, "no keyframe '" + id + "'"));
    }
    return edit<api::DeleteKeyframes>(c.ids.size() == 1 ? "Delete Keyframe" : "Delete Keyframes");
  }

  // ── transport and viewport (controls) ──
  Outcome operator()(const api::Play& c) const {
    if (s.active_comp() == nullptr) return fail(err(ErrorCode::invalid_argument, "no active composition"));
    const double rate = c.rate == 0.0 ? 1.0 : c.rate;
    if (!std::isfinite(rate) || std::abs(rate) > 4.0) return fail(err(ErrorCode::out_of_range, "rate must be within ±4"));
    if (c.range == api::PlayRange::custom && (!c.custom || c.custom->duration <= 0)) {
      return fail(err(ErrorCode::invalid_argument, "a custom range needs a positive duration"));
    }
    s.rate_ = rate;
    s.rangeKind_ = c.range;
    if (c.custom) s.customRange_ = *c.custom;
    s.start_playback(now, c.from);
    return control<api::Play>();
  }
  Outcome operator()(const api::Pause& c) const {
    const bool was = s.playing_;
    s.stop_playback();
    if (c.return_to_start) s.set_time(s.playFrom_);
    if (was || c.return_to_start) {
      s.emit_transport();
      s.emit_playhead();
      s.request_render();
    }
    return control<api::Pause>();
  }
  Outcome operator()(const api::Seek& c) const {
    if (s.active_comp() == nullptr) return fail(err(ErrorCode::invalid_argument, "no active composition"));
    s.set_time(c.time);
    if (s.playing_) s.rebase_playback(now);
    s.emit_playhead();
    s.request_render();
    return control<api::Seek>();
  }
  Outcome operator()(const api::Step& c) const {
    if (s.active_comp() == nullptr) return fail(err(ErrorCode::invalid_argument, "no active composition"));
    if (s.playing_) {
      s.stop_playback();
      s.emit_transport();
    }
    s.set_time((s.frame_ + c.frames) * s.frame_dur());
    s.emit_playhead();
    s.request_render();
    return control<api::Step>();
  }
  Outcome operator()(const api::SetLoop& c) const {
    s.loop_ = c.mode;
    s.emit_transport();
    return control<api::SetLoop>();
  }
  Outcome operator()(const api::SetPreviewQuality& c) const {
    s.resolution_ = resolution_factor(c.resolution);
    if (s.viewport_.open) {
      s.viewport_.resolution = s.resolution_;
      s.sink_.configure(s.viewport_);
      s.request_render();
    }
    return control<api::SetPreviewQuality>();
  }
  Outcome operator()(const api::SetActiveComposition& c) const {
    if (s.doc_.comp(c.comp) == nullptr) return fail(comp_not_found(c.comp));
    if (s.activeComp_ && *s.activeComp_ == c.comp) return control<api::SetActiveComposition>();
    s.stop_playback();
    s.activeComp_ = c.comp;
    s.set_time(0);
    s.emit_transport();
    s.emit_playhead();
    s.request_render();
    return control<api::SetActiveComposition>();
  }
  Outcome operator()(const api::SetViewport& c) const {
    if (c.layer) return fail(err(ErrorCode::unsupported, "single-layer viewports are not implemented yet"));
    const double dpr = c.device_pixel_ratio > 0.0 && std::isfinite(c.device_pixel_ratio) ? c.device_pixel_ratio : 1.0;
    const double w = std::round(static_cast<double>(c.width) * dpr);
    const double h = std::round(static_cast<double>(c.height) * dpr);
    if (c.width == 0 || c.height == 0 || w > 16384.0 || h > 16384.0 || dpr > 8.0) {
      return fail(err(ErrorCode::out_of_range, "viewport must be 1..16384 physical pixels per side"));
    }
    ViewportConfig v;
    v.viewport = c.viewport;
    v.width = static_cast<std::uint32_t>(w);
    v.height = static_cast<std::uint32_t>(h);
    v.resolution = s.resolution_;
    v.open = true;
    if (!(v == s.viewport_)) {
      s.viewport_ = v;
      s.sink_.configure(v);
    }
    s.request_render();
    return control<api::SetViewport>();
  }
  Outcome operator()(const api::CloseViewport& c) const {
    if (s.viewport_.open && s.viewport_.viewport == c.viewport) {
      s.viewport_.open = false;
      s.sink_.configure(s.viewport_);
    }
    return control<api::CloseViewport>();
  }
  Outcome operator()(const api::SetInteracting&) const {
    // A hint (draft quality while dragging); C2 renders every frame at the
    // chosen preview resolution anyway.
    return control<api::SetInteracting>();
  }
};

// ── Query dispatch ──────────────────────────────────────────────────────────

struct QueryVisitor {
  Session& s;
  using Result = std::pair<std::optional<api::EngineError>, api::QueryResult>;

  static Result fail(api::EngineError e) { return {std::move(e), {}}; }

  template <NotYetQuery T>
  Result operator()(const T&) const {
    return fail(not_implemented(static_cast<std::uint32_t>(api::Query{QueryVariant{T{}}}.kind()), "query"));
  }

  Result operator()(const api::GetDocument& q) const { return {std::nullopt, s.query_document(q)}; }
  Result operator()(const api::GetComposition& q) const {
    const doc::Comp* comp = s.doc_.comp(q.comp);
    if (comp == nullptr) return fail(comp_not_found(q.comp));
    api::CompositionDetails d;
    d.comp = doc::comp_info(*comp);
    for (const auto& id : comp->layers) {
      if (const doc::Layer* l = s.doc_.layer(id)) d.layers.push_back(doc::layer_info(*l));
    }
    return {std::nullopt, query_result_for<api::GetComposition>(std::move(d))};
  }
  Result operator()(const api::GetLayers& q) const {
    api::LayerDetails d;
    for (const auto& id : q.layers) {
      const doc::Layer* l = s.doc_.layer(id);
      if (l == nullptr) return fail(layer_not_found(id));
      d.layers.push_back(doc::layer_info(*l));
    }
    return {std::nullopt, query_result_for<api::GetLayers>(std::move(d))};
  }
  Result operator()(const api::GetPropertyTree& q) const {
    const doc::Layer* l = s.doc_.layer(q.layer);
    if (l == nullptr) return fail(layer_not_found(q.layer));
    const api::Time t = q.time.value_or(s.time_);
    api::PropertyTree tree;
    tree.layer = l->id;
    for (const doc::PropertySpec& spec : doc::catalog_for(l->kind)) {
      const std::string path(spec.path);
      if (!q.path.empty() && !(path == q.path || (path.starts_with(q.path) && path[q.path.size()] == '/'))) continue;
      const doc::Property& prop = l->props.at(path);
      tree.nodes.push_back(doc::property_info(*l, path, prop, eval::value_at(prop, t, s.scratch_)));
    }
    return {std::nullopt, query_result_for<api::GetPropertyTree>(std::move(tree))};
  }
  Result operator()(const api::GetPropertyValues& q) const {
    api::PropertyValues values;
    for (const auto& ref : q.props) {
      const doc::Layer* l = s.doc_.layer(ref.layer);
      if (l == nullptr) return fail(layer_not_found(ref.layer));
      const auto it = l->props.find(ref.path);
      if (it == l->props.end()) {
        api::EngineError e = err(ErrorCode::not_found, "no property '" + ref.path + "'");
        e.layer = ref.layer;
        e.path = ref.path;
        return fail(std::move(e));
      }
      values.values.push_back(api::PropertyValue{ref, eval::value_at(it->second, q.time, s.scratch_)});
    }
    return {std::nullopt, query_result_for<api::GetPropertyValues>(std::move(values))};
  }
  Result operator()(const api::GetKeyframes& q) const {
    api::KeyframeSets sets;
    for (const auto& ref : q.props) {
      const doc::Layer* l = s.doc_.layer(ref.layer);
      if (l == nullptr) return fail(layer_not_found(ref.layer));
      const auto it = l->props.find(ref.path);
      if (it == l->props.end()) {
        api::EngineError e = err(ErrorCode::not_found, "no property '" + ref.path + "'");
        e.layer = ref.layer;
        e.path = ref.path;
        return fail(std::move(e));
      }
      api::KeyframeSet set = doc::keyframe_set(*l, ref.path, it->second);
      if (q.range) {
        const api::Time a = q.range->start;
        const api::Time b = q.range->start + q.range->duration;
        std::erase_if(set.keyframes, [a, b](const api::Keyframe& k) { return k.time < a || k.time >= b; });
      }
      sets.sets.push_back(std::move(set));
    }
    return {std::nullopt, query_result_for<api::GetKeyframes>(std::move(sets))};
  }
  Result operator()(const api::GetCapabilities&) const {
    api::Capabilities c;
    c.gpu_adapter = s.sink_.adapter();
    c.gpu_backend = s.sink_.backend();
    c.cpu_threads = std::thread::hardware_concurrency();
    c.expression_engines = {};
    return {std::nullopt, query_result_for<api::GetCapabilities>(std::move(c))};
  }
  Result operator()(const api::GetLayerTransforms& q) const {
    api::LayerTransformList list;
    for (const auto& id : q.layers) {
      const doc::Layer* l = s.doc_.layer(id);
      if (l == nullptr) return fail(layer_not_found(id));
      const auto m = eval::layer_matrix(*l, q.time, s.scratch_);
      api::LayerTransform t;
      t.layer = id;
      // 4×4, column-major, layer px → comp px (z untouched in 2D).
      t.matrix = {m[0], m[1], 0, 0, m[2], m[3], 0, 0, 0, 0, 1, 0, m[4], m[5], 0, 1};
      std::array<double, 4> anchor{};
      (void)eval::components_at(l->props.at("transform/anchorPoint"), q.time, s.scratch_, anchor);
      t.anchor = api::Vec3{anchor[0], anchor[1], 0.0};
      list.transforms.push_back(std::move(t));
    }
    return {std::nullopt, query_result_for<api::GetLayerTransforms>(std::move(list))};
  }
  Result operator()(const api::GetHistory&) const {
    return {std::nullopt, query_result_for<api::GetHistory>(s.history_.state())};
  }
  Result operator()(const api::GetRenderStats&) const {
    const RenderCounters c = s.sink_.counters();
    api::RenderStats st;
    st.gpu_frame_ms = c.gpuFrameMs;
    st.fps = c.fps;
    st.dropped_frames = c.dropped;
    return {std::nullopt, query_result_for<api::GetRenderStats>(st)};
  }
  Result operator()(const api::GetLayerErrors&) const {
    // No layer can fail to render in C2's catalog (solids and rectangles).
    return {std::nullopt, query_result_for<api::GetLayerErrors>(api::LayerErrorList{})};
  }
};

// ── Session ─────────────────────────────────────────────────────────────────

Session::Session(Outbox& out, FrameSink& sink, SessionOptions options)
    : out_(out), sink_(sink), options_(std::move(options)) {}

void Session::on_frame(std::span<const std::uint8_t> payload, Clock::time_point now) {
  if (phase_ == Phase::closed) return;
  api::EngineMessage message;
  wire::Reader reader(payload);
  const wire::Status st = api::decode(reader, message);
  if (st != wire::Status::ok) {
    PREMATION_LOG(warn, "decode_failed").kv("status", wire::to_string(st)).kv("bytes", payload.size());
    if (phase_ == Phase::awaiting_hello) {
      close(api::GoodbyeReason::protocol_error, "the first message must be a Hello");
      return;
    }
    if (const auto seq = peek_request_seq(payload)) {
      respond_error(*seq, decode_error(st));
    } else {
      send_engine_error(ErrorCode::decode, "undecodable message: " + std::string(wire::to_string(st)), false);
    }
    return;
  }
  on_message(std::move(message), now);
}

void Session::on_message(api::EngineMessage message, Clock::time_point now) {
  if (phase_ == Phase::closed) return;
  switch (message.kind()) {
    case api::EngineMessage::Kind::hello:
      if (phase_ == Phase::awaiting_hello) {
        handle_hello(std::get<api::Hello>(message.v));
      } else {
        send_engine_error(ErrorCode::invalid_argument, "Hello after the session opened; ignored", false);
      }
      return;
    case api::EngineMessage::Kind::goodbye:
      PREMATION_LOG(info, "goodbye_received").kv("message", std::get<api::Goodbye>(message.v).message);
      on_disconnect();
      phase_ = Phase::closed;
      return;
    case api::EngineMessage::Kind::request:
      if (phase_ != Phase::open) {
        close(api::GoodbyeReason::protocol_error, "the first message must be a Hello");
        return;
      }
      handle_request(std::move(std::get<api::Request>(message.v)), now);
      return;
    case api::EngineMessage::Kind::welcome:
    case api::EngineMessage::Kind::response:
    case api::EngineMessage::Kind::events:
      if (phase_ == Phase::awaiting_hello) {
        close(api::GoodbyeReason::protocol_error, "the first message must be a Hello");
        return;
      }
      send_engine_error(ErrorCode::invalid_argument, "engine-to-client message received from the client; ignored",
                        false);
      return;
  }
}

void Session::handle_hello(const api::Hello& hello) {
  if (hello.protocol_major != api::kProtocolMajor) {
    PREMATION_LOG(warn, "version_mismatch").kv("client", hello.protocol_major).kv("engine", api::kProtocolMajor);
    close(api::GoodbyeReason::version_mismatch,
          "protocol major " + std::to_string(hello.protocol_major) + " is not supported; this engine speaks " +
              std::to_string(api::kProtocolMajor) + "." + std::to_string(api::kProtocolMinor));
    return;
  }
  const bool wantShared = std::find(hello.capabilities.begin(), hello.capabilities.end(), "frames.sharedTexture") !=
                          hello.capabilities.end();
  const bool shared = wantShared && sink_.shared_supported();
  sink_.set_shared(shared);
  api::Welcome w;
  w.protocol_major = api::kProtocolMajor;
  w.protocol_minor = api::kProtocolMinor;
  w.engine = "premation-engine";
  w.engine_version = options_.engineVersion;
  w.revision = revision_;
  w.session_id = options_.sessionId;
  w.capabilities = {"frames.channel", "frames.offscreen", "heartbeat"};
  if (sink_.shared_supported()) w.capabilities.emplace_back("frames.sharedTexture");
  api::EngineMessage m;
  m.v = std::move(w);
  out_.send(m);
  phase_ = Phase::open;
  PREMATION_LOG(info, "welcome")
      .kv("client", hello.client)
      .kv("clientVersion", hello.client_version)
      .kv("minor", hello.protocol_minor)
      .kv("sharedFrames", shared);
}

void Session::close(api::GoodbyeReason reason, std::string message) {
  if (phase_ == Phase::closed) return;
  stop_playback();
  api::EngineMessage m;
  m.v = api::Goodbye{reason, std::move(message)};
  out_.send(m);
  phase_ = Phase::closed;
}

void Session::on_disconnect() {
  if (history_.gesture_open()) {
    doc::Entry e = history_.end_gesture();
    e.changes.prune();
    history_.record(e.label, e.origin, std::move(e.changes));
  }
  stop_playback();
}

void Session::on_ping(std::uint64_t nonce, std::uint32_t queued) {
  out_.send_frames(frames::Pong{nonce, revision_, playing_, queued});
}

void Session::respond(api::Seq seq, api::Outcome outcome) {
  api::EngineMessage m;
  m.v = api::Response{seq, revision_, std::move(outcome)};
  out_.send(m);
}

void Session::respond_error(api::Seq seq, api::EngineError error) {
  api::Outcome o;
  o.v = std::move(error);
  respond(seq, std::move(o));
}

void Session::send_events(api::Revision from, api::Revision to, std::vector<api::Event> events,
                          std::optional<api::Seq> seq, api::Origin origin) {
  if (events.empty()) return;
  api::EventBatch b;
  b.from_revision = from;
  b.to_revision = to;
  b.events = std::move(events);
  b.caused_by = seq;
  b.origin = origin;
  api::EngineMessage m;
  m.v = std::move(b);
  out_.send(m);
}

void Session::send_engine_error(ErrorCode code, std::string message, bool fatal) {
  std::vector<api::Event> ev;
  ev.push_back(make_event(api::EngineErrorEvent{err(code, std::move(message)), fatal}));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

api::Event Session::history_event() const {
  return make_event(api::HistoryChangedEvent{history_.state(), history_.undo_label(), history_.redo_label()});
}

Session::Outcome Session::run_command(const api::Command& cmd, api::Origin origin, Clock::time_point now) {
  return std::visit(CommandVisitor{*this, origin, now}, cmd.v);
}

void Session::handle_request(api::Request request, Clock::time_point now) {
  const api::Seq seq = request.seq;
  if (request.base_revision && *request.base_revision != revision_) {
    api::EngineError e = err(ErrorCode::conflict, "the document is at revision " + std::to_string(revision_));
    e.detail = "{\"revision\":" + std::to_string(revision_) + "}";
    respond_error(seq, std::move(e));
    return;
  }
  switch (request.body.kind()) {
    case api::RequestBody::Kind::query: {
      auto [error, result] = std::visit(QueryVisitor{*this}, std::get<api::Query>(request.body.v).v);
      api::Outcome o;
      if (error) {
        o.v = std::move(*error);
      } else {
        o.v = std::move(result);
      }
      respond(seq, std::move(o));
      return;
    }
    case api::RequestBody::Kind::command: {
      const api::Command& cmd = std::get<api::Command>(request.body.v);
      txn_ = doc::ChangeSet{};
      Outcome out = run_command(cmd, request.origin, now);
      if (out.error) {
        txn_.apply_before(doc_);  // a failed request changed NOTHING (§10)
        txn_ = doc::ChangeSet{};
        respond_error(seq, std::move(*out.error));
        break;
      }
      api::Outcome o;
      o.v = std::move(out.result);
      switch (out.kind) {
        case OutcomeKind::edit:
          finish_edit(seq, request.origin, out.label, std::move(o));
          break;
        case OutcomeKind::history_move:
          finish_history_move(seq, request.origin, out.moved, std::move(o));
          break;
        case OutcomeKind::reset: {
          const api::Revision from = revision_;
          ++revision_;
          std::vector<api::Event> ev;
          ev.push_back(make_event(api::DocumentResetEvent{revision_, api::ResetReason::created}));
          ev.push_back(history_event());
          send_events(from, revision_, std::move(ev), seq, request.origin);
          respond(seq, std::move(o));
          emit_transport();
          request_render();
          break;
        }
        case OutcomeKind::control:
          if (out.historyChanged) {
            std::vector<api::Event> ev;
            ev.push_back(history_event());
            send_events(revision_, revision_, std::move(ev), seq, request.origin);
          }
          respond(seq, std::move(o));
          break;
      }
      break;
    }
    case api::RequestBody::Kind::batch: {
      const api::CommandBatch& batch = std::get<api::CommandBatch>(request.body.v);
      txn_ = doc::ChangeSet{};
      api::BatchResult results;
      for (std::size_t i = 0; i < batch.commands.size(); ++i) {
        const api::Command& cmd = batch.commands[i];
        std::optional<api::EngineError> error;
        if (!is_edit(cmd) && !is_not_yet(cmd)) {
          error = err(ErrorCode::invalid_argument, "only edit commands can be batched (controls never enter history)");
        } else {
          Outcome out = run_command(cmd, request.origin, now);
          if (out.error) {
            error = std::move(out.error);
          } else {
            results.results.push_back(std::move(out.result));
          }
        }
        if (error) {
          txn_.apply_before(doc_);
          txn_ = doc::ChangeSet{};
          error->command_index = static_cast<std::uint32_t>(i);
          respond_error(seq, std::move(*error));
          flush_render();
          return;
        }
      }
      api::Outcome o;
      o.v = std::move(results);
      finish_edit(seq, request.origin, batch.label.empty() ? "Batch" : batch.label, std::move(o));
      break;
    }
  }
  flush_render();
}

void Session::finish_edit(api::Seq seq, api::Origin origin, const std::string& label, api::Outcome outcome) {
  txn_.seal(doc_);
  txn_.prune();
  if (txn_.empty()) {  // an edit that changed nothing: no revision, no entry, no events
    respond(seq, std::move(outcome));
    return;
  }
  const api::Revision from = revision_;
  ++revision_;
  std::vector<api::Event> ev;
  append_change_events(txn_, ev);
  history_.record(label, origin, std::move(txn_));
  txn_ = doc::ChangeSet{};
  ev.push_back(history_event());
  // Events before the response: when the client's await resumes, its mirror
  // already shows the change.
  send_events(from, revision_, std::move(ev), seq, origin);
  respond(seq, std::move(outcome));
  request_render();
}

void Session::finish_history_move(api::Seq seq, api::Origin origin, const doc::ChangeSet& applied,
                                  api::Outcome outcome) {
  std::vector<api::Event> ev;
  const api::Revision from = revision_;
  if (!applied.empty()) {
    ++revision_;
    append_change_events(applied, ev);
    request_render();
  }
  // The active comp may have been undone out of existence.
  if (activeComp_ && doc_.comp(*activeComp_) == nullptr) {
    stop_playback();
    activeComp_.reset();
  }
  ev.push_back(history_event());
  send_events(from, revision_, std::move(ev), seq, origin);
  respond(seq, std::move(outcome));
}

std::optional<api::EngineError> Session::write_property(const api::PropRef& ref, const api::Value& value,
                                                        std::optional<api::Time> time,
                                                        std::optional<api::KeyframeId>& key) {
  doc::Layer* layer = doc_.layer(ref.layer);
  if (layer == nullptr) return layer_not_found(ref.layer);
  const doc::PropertySpec* spec = doc::find_spec(layer->kind, ref.path);
  const auto it = layer->props.find(ref.path);
  if (spec == nullptr || it == layer->props.end()) {
    api::EngineError e = err(ErrorCode::not_found, "no property '" + ref.path + "' on a " +
                                                       std::string(api::to_string(layer->kind)) + " layer");
    e.layer = ref.layer;
    e.path = ref.path;
    return e;
  }
  doc::Property& prop = it->second;
  if (doc::value_type_of(value) != prop.type) {
    api::EngineError e =
        err(ErrorCode::type_mismatch, "'" + ref.path + "' takes a " + std::string(api::to_string(prop.type)));
    e.layer = ref.layer;
    e.path = ref.path;
    e.detail = "{\"expected\":\"" + std::string(api::to_string(prop.type)) + "\"}";
    return e;
  }
  if (!doc::all_finite(value)) {
    api::EngineError e = err(ErrorCode::invalid_argument, "value is not finite");
    e.path = ref.path;
    return e;
  }
  // Clamp to the property's range (AE clamps opacity 0..100 as you type).
  api::Value v = value;
  if (spec->min || spec->max) {
    std::array<double, 4> c{};
    const std::size_t n = doc::components(v, c);
    for (std::size_t i = 0; i < n; ++i) {
      if (spec->min) c[i] = std::max(c[i], *spec->min);
      if (spec->max) c[i] = std::min(c[i], *spec->max);
    }
    v = doc::from_components(prop.type, std::span<const double>(c.data(), n));
  }
  txn_.touch_layer(doc_, ref.layer);
  if (prop.keys.empty()) {
    prop.value = std::move(v);
    return std::nullopt;
  }
  if (!time) {
    api::EngineError e = err(ErrorCode::animated, "'" + ref.path + "' is animated: setProperty needs a time");
    e.layer = ref.layer;
    e.path = ref.path;
    return e;
  }
  auto pos = std::lower_bound(prop.keys.begin(), prop.keys.end(), *time,
                              [](const api::Keyframe& k, api::Time t) { return k.time < t; });
  if (pos != prop.keys.end() && pos->time == *time) {
    pos->value = std::move(v);
    key = pos->id;
  } else {
    api::Keyframe k;
    k.id = doc_.mint_key_id();
    k.time = *time;
    k.value = std::move(v);
    key = k.id;
    prop.keys.insert(pos, std::move(k));
  }
  return std::nullopt;
}

api::QueryResult Session::query_document(const api::GetDocument& q) {
  api::DocumentSnapshot d;
  d.revision = revision_;
  d.settings.bit_depth = api::BitDepth::u8;
  d.settings.working_space = api::ColorWorkingSpace::srgb;
  d.settings.audio_sample_rate = 48000;
  for (const auto& id : doc_.itemOrder) {
    const doc::Comp* comp = doc_.comp(id);
    if (comp == nullptr) continue;
    d.items.push_back(doc::comp_item_info(*comp));
    d.comps.push_back(doc::comp_info(*comp));
    for (const auto& lid : comp->layers) {
      const doc::Layer* l = doc_.layer(lid);
      if (l == nullptr) continue;
      d.layers.push_back(doc::layer_info(*l));
      if (q.include_properties) {
        api::PropertyTree tree;
        tree.layer = l->id;
        for (const doc::PropertySpec& spec : doc::catalog_for(l->kind)) {
          const std::string path(spec.path);
          const doc::Property& prop = l->props.at(path);
          tree.nodes.push_back(doc::property_info(*l, path, prop, eval::value_at(prop, time_, scratch_)));
        }
        d.property_trees.push_back(std::move(tree));
      }
      if (q.include_keyframes) {
        for (const auto& [path, prop] : l->props) {
          if (!prop.keys.empty()) d.keyframes.push_back(doc::keyframe_set(*l, path, prop));
        }
      }
    }
  }
  return query_result_for<api::GetDocument>(std::move(d));
}

void Session::append_change_events(const doc::ChangeSet& changes, std::vector<api::Event>& events) {
  api::ItemsChangedEvent items;
  std::vector<api::ItemId> itemsRemoved;
  std::vector<api::Event> compEvents;
  std::vector<api::Event> orderEvents;
  for (const auto& c : changes.comps) {
    if (!c.after) {
      if (c.before) itemsRemoved.push_back(c.id);
      continue;
    }
    const bool added = !c.before;
    if (added || c.before->settings.name != c.after->settings.name) items.items.push_back(doc::comp_item_info(*c.after));
    if (added || !(c.before->settings == c.after->settings)) {
      compEvents.push_back(make_event(api::CompositionChangedEvent{c.id, c.after->settings}));
    }
    if (added || c.before->layers != c.after->layers) {
      orderEvents.push_back(make_event(api::LayerOrderChangedEvent{c.id, c.after->layers}));
    }
  }
  api::LayersChangedEvent layersChanged;
  std::vector<api::Event> propEvents;
  api::KeyframesChangedEvent keys;
  std::vector<std::pair<api::ItemId, api::LayerId>> removed;
  for (const auto& c : changes.layers) {
    if (!c.after) {
      if (c.before) removed.emplace_back(c.before->comp, c.id);
      continue;
    }
    const doc::Layer& after = *c.after;
    const doc::Layer* before = c.before ? &*c.before : nullptr;
    const api::LayerInfo info = doc::layer_info(after);
    if (before == nullptr || !(doc::layer_info(*before) == info)) layersChanged.layers.push_back(info);
    api::PropertiesChangedEvent props;
    props.layer = after.id;
    for (const auto& [path, prop] : after.props) {
      const doc::Property* old = nullptr;
      if (before != nullptr) {
        const auto it = before->props.find(path);
        if (it != before->props.end()) old = &it->second;
      }
      if (old != nullptr && *old == prop) continue;
      props.properties.push_back(doc::property_info(after, path, prop, eval::value_at(prop, time_, scratch_)));
      if ((old == nullptr && !prop.keys.empty()) || (old != nullptr && old->keys != prop.keys)) {
        keys.sets.push_back(doc::keyframe_set(after, path, prop));
      }
    }
    if (!props.properties.empty()) propEvents.push_back(make_event(std::move(props)));
  }
  if (!items.items.empty()) events.push_back(make_event(std::move(items)));
  for (auto& e : compEvents) events.push_back(std::move(e));
  if (!layersChanged.layers.empty()) events.push_back(make_event(std::move(layersChanged)));
  for (auto& e : propEvents) events.push_back(std::move(e));
  if (!keys.sets.empty()) events.push_back(make_event(std::move(keys)));
  // One layersRemoved per composition.
  std::sort(removed.begin(), removed.end());
  for (std::size_t i = 0; i < removed.size();) {
    api::LayersRemovedEvent r;
    r.comp = removed[i].first;
    while (i < removed.size() && removed[i].first == r.comp) r.layers.push_back(removed[i++].second);
    events.push_back(make_event(std::move(r)));
  }
  for (auto& e : orderEvents) events.push_back(std::move(e));
  if (!itemsRemoved.empty()) events.push_back(make_event(api::ItemsRemovedEvent{std::move(itemsRemoved)}));
}

// ── transport ───────────────────────────────────────────────────────────────

const doc::Comp* Session::active_comp() const {
  if (!activeComp_) {
    // No explicit choice yet: the first composition (what AE opens).
    for (const auto& id : doc_.itemOrder) {
      if (const doc::Comp* c = doc_.comp(id)) return c;
    }
    return nullptr;
  }
  return doc_.comp(*activeComp_);
}

api::Time Session::frame_dur() const {
  const doc::Comp* c = active_comp();
  const api::Time d = c != nullptr ? doc::frame_duration(c->settings.frame_rate) : 0;
  return d > 0 ? d : doc::kFlicksPerSecond / 30;
}

Session::Range Session::play_range() const {
  const doc::Comp* c = active_comp();
  const api::Time fd = frame_dur();
  api::TimeRange r{0, c != nullptr ? c->settings.duration : fd};
  if (rangeKind_ == api::PlayRange::work_area && c != nullptr && c->settings.work_area.duration > 0) {
    r = c->settings.work_area;
  } else if (rangeKind_ == api::PlayRange::custom && customRange_.duration > 0) {
    r = customRange_;
  }
  Range out;
  out.first = std::max<std::int64_t>(0, floor_div(r.start + fd - 1, fd));
  out.last = std::max(out.first, floor_div(r.start + r.duration + fd - 1, fd) - 1);
  return out;
}

void Session::set_time(api::Time t) {
  const doc::Comp* c = active_comp();
  const api::Time fd = frame_dur();
  const api::Time maxT = c != nullptr ? std::max<api::Time>(0, c->settings.duration - fd) : 0;
  time_ = std::clamp<api::Time>(t, 0, maxT);
  frame_ = floor_div(time_, fd);
}

void Session::start_playback(Clock::time_point now, std::optional<api::Time> from) {
  const Range r = play_range();
  if (from) set_time(*from);
  std::int64_t f = frame_;
  // AE: play from the start when the playhead is outside the range or at its end.
  if (rate_ > 0 && (f < r.first || f >= r.last)) f = r.first;
  if (rate_ < 0 && (f > r.last || f <= r.first)) f = r.last;
  set_time(f * frame_dur());
  playFrom_ = time_;
  playing_ = true;
  playBase_ = now;
  playBaseU_ = frame_ - r.first;
  lastK_ = 0;
  lastU_ = playBaseU_;
  clockDropped_ = 0;
  lastStats_ = now;
  emit_transport();
  emit_playhead();
  submit_frame(0);
  renderDirty_ = false;
}

void Session::rebase_playback(Clock::time_point now) {
  const Range r = play_range();
  playBase_ = now;
  playBaseU_ = frame_ - r.first;
  lastK_ = 0;
  lastU_ = playBaseU_;
}

void Session::stop_playback() {
  if (!playing_) return;
  playing_ = false;
}

std::optional<Clock::time_point> Session::next_deadline() const {
  if (!playing_) return std::nullopt;
  const doc::Comp* c = active_comp();
  if (c == nullptr) return std::nullopt;
  const double fps = doc::fps_of(c->settings.frame_rate) * std::abs(rate_);
  if (fps <= 0) return std::nullopt;
  const auto step = std::chrono::duration<double>(static_cast<double>(lastK_ + 1) / fps);
  return playBase_ + std::chrono::duration_cast<Clock::duration>(step);
}

void Session::tick(Clock::time_point now) {
  if (!playing_ || phase_ != Phase::open) return;
  const doc::Comp* c = active_comp();
  if (c == nullptr) {
    stop_playback();
    emit_transport();
    return;
  }
  const double fps = doc::fps_of(c->settings.frame_rate) * std::abs(rate_);
  // Wall time only PACES the clock (which frame is due); what a frame shows is
  // a pure function of its frame index. Late → frames are skipped, never
  // stretched (AE: video drops frames rather than drifting).
  const double elapsed = std::chrono::duration<double>(now - playBase_).count();
  const auto k = static_cast<std::int64_t>(std::floor(elapsed * fps + 1e-9));
  if (k <= lastK_) {
    if (now - lastStats_ >= std::chrono::seconds(1)) emit_stats(now);
    return;
  }
  const Range r = play_range();
  const std::int64_t span = r.last - r.first + 1;
  const std::int64_t dir = rate_ < 0 ? -1 : 1;
  const std::int64_t u = playBaseU_ + dir * k;
  const std::int64_t jumped = std::abs(u - lastU_);
  std::uint32_t dropped = jumped > 1 ? static_cast<std::uint32_t>(std::min<std::int64_t>(jumped - 1, 1'000'000)) : 0;
  bool stop = false;
  std::int64_t pos = 0;
  switch (loop_) {
    case api::LoopMode::once:
      if (u >= span || u < 0) {
        pos = u >= span ? span - 1 : 0;
        stop = true;
      } else {
        pos = u;
      }
      break;
    case api::LoopMode::loop:
      pos = mod_pos(u, span);
      break;
    case api::LoopMode::ping_pong: {
      const std::int64_t period = span > 1 ? 2 * (span - 1) : 1;
      const std::int64_t m = mod_pos(u, period);
      pos = m < span ? m : period - m;
      break;
    }
  }
  lastK_ = k;
  lastU_ = u;
  clockDropped_ += dropped;
  set_time((r.first + pos) * frame_dur());
  emit_playhead();
  submit_frame(dropped);
  renderDirty_ = false;
  if (stop) {
    stop_playback();
    emit_transport();
  }
  if (now - lastStats_ >= std::chrono::seconds(1)) emit_stats(now);
}

void Session::emit_stats(Clock::time_point now) {
  lastStats_ = now;
  const RenderCounters c = sink_.counters();
  api::RenderStats st;
  st.gpu_frame_ms = c.gpuFrameMs;
  st.fps = c.fps;
  st.dropped_frames = c.dropped + clockDropped_;
  std::vector<api::Event> ev;
  ev.push_back(make_event(api::RenderStatsUpdatedEvent{st}));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

void Session::emit_transport() {
  if (phase_ != Phase::open) return;
  const doc::Comp* c = active_comp();
  api::TransportChangedEvent t;
  t.state = playing_ ? api::TransportState::playing : api::TransportState::stopped;
  t.comp = c != nullptr ? c->id : std::string();
  t.time = time_;
  t.rate = rate_;
  t.loop = loop_;
  const Range r = play_range();
  t.range = api::TimeRange{r.first * frame_dur(), (r.last - r.first + 1) * frame_dur()};
  std::vector<api::Event> ev;
  ev.push_back(make_event(std::move(t)));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

void Session::emit_playhead() {
  if (phase_ != Phase::open) return;
  // A UI that stopped reading must not grow our queue by 60 events a second;
  // the playhead is a status, the next one supersedes it.
  constexpr std::size_t kMaxBacklog = std::size_t{1} << 20U;
  if (out_.backlog_bytes() > kMaxBacklog) {
    ++playheadSkipped_;
    return;
  }
  const doc::Comp* c = active_comp();
  api::PlayheadEvent p;
  p.comp = c != nullptr ? c->id : std::string();
  p.time = time_;
  p.frame = frame_;
  p.dropped_frames = clockDropped_;
  std::vector<api::Event> ev;
  ev.push_back(make_event(std::move(p)));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

void Session::flush_render() {
  if (!renderDirty_ || playing_) return;  // while playing the next tick renders
  renderDirty_ = false;
  submit_frame(0);
}

void Session::submit_frame(std::uint32_t clockDropped) {
  if (!viewport_.open) return;
  const doc::Comp* c = active_comp();
  if (c == nullptr) return;
  RenderJob job;
  // The scene's quad vector changes hands (core → render thread) once per
  // frame: one small allocation per frame, deliberately, so the two threads
  // never share a buffer. Recycling it is a later optimisation if it ever
  // shows up in the frame profile.
  eval::build_scene(doc_, *c, time_, scratch_, job.scene);
  job.viewport = viewport_.viewport;
  job.frame = frame_;
  job.time = time_;
  job.revision = revision_;
  job.clockDropped = clockDropped;
  sink_.submit(std::move(job));
}

// ── seq peek for undecodable requests ──────────────────────────────────────

std::optional<api::Seq> peek_request_seq(std::span<const std::uint8_t> payload) noexcept {
  wire::Reader r(payload);
  while (!r.at_end()) {
    std::uint64_t key = 0;
    if (!r.varint(key)) return std::nullopt;
    if (key == ((3U << 3U) | wire::kWireLen)) {  // EngineMessage.request
      wire::Reader req;
      if (!r.ld(req)) return std::nullopt;
      while (!req.at_end()) {
        std::uint64_t k = 0;
        if (!req.varint(k)) return std::nullopt;
        if (k == ((1U << 3U) | wire::kWireVarint)) {  // Request.seq
          std::uint64_t seq = 0;
          if (!req.varint(seq)) return std::nullopt;
          return seq;
        }
        if (!req.skip(k)) return std::nullopt;
      }
      return std::nullopt;
    }
    if (!r.skip(key)) return std::nullopt;
  }
  return std::nullopt;
}

}  // namespace premation
