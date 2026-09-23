#include "handlers_markers.hpp"

#include <algorithm>

#include "readmodel.hpp"
#include "time_conv.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

struct Owner {
  std::string comp;
  std::optional<std::string> bar;  ///< the layer's first bar id (layer markers)
};

/// markers.ts `owner(o)`.
Owner owner_of(Document& d, const api::MarkerOwner& o) {
  require_comp(d, o.comp);
  ensure_timeline(d, o.comp);
  if (!o.layer || o.layer->empty()) return {o.comp, std::nullopt};
  (void)require_layer(d, *o.layer);
  const auto c = comp_of_layer(d, *o.layer);
  if (!c || *c != o.comp) fail(ErrorCode::invalid_argument, "the layer is not in that composition", {.layer = *o.layer});
  const auto bars = bars_of(d, *o.layer, o.comp);
  if (bars.empty()) fail(ErrorCode::invalid_argument, "layer '" + *o.layer + "' has no bar to hold markers", {.layer = *o.layer});
  return {o.comp, bars[0]->id};
}

struct Found {
  std::string comp;
  std::optional<std::string> bar;
};

/// markers.ts `findMarker(id)`.
Found find_marker(const Document& d, const std::string& id) {
  for (const auto& comp : comp_item_ids(d)) {
    const Timeline* t = d.timeline(comp);
    if (t == nullptr) continue;
    for (const TMarker& m : t->markers) {
      if (m.id == id) return {comp, std::nullopt};
    }
    for (const Bar& b : t->bars) {
      for (const TMarker& m : b.markers) {
        if (m.id == id) return {comp, b.id};
      }
    }
  }
  fail(ErrorCode::not_found, "no marker '" + id + "'");
}

/// The marker list a Found names, writable.
std::vector<TMarker>& list_mut(Document& d, const Found& f) {
  Timeline& t = d.timeline_mut(f.comp);
  if (!f.bar) return t.markers;
  for (Bar& b : t.bars) {
    if (b.id == *f.bar) return b.markers;
  }
  return t.markers;  // unreachable: the bar was found above
}

TMarker* marker_in(std::vector<TMarker>& list, const std::string& id) {
  for (TMarker& m : list) {
    if (m.id == id) return &m;
  }
  return nullptr;
}

void check_label(std::uint32_t label) {
  if (label > 0 && !label_color_of(label)) fail(ErrorCode::out_of_range, "label " + std::to_string(label) + " does not exist");
}

}  // namespace

ResultOf<api::AddMarkers> handle(const api::AddMarkers& c, HCtx& x) {
  Document& d = x.d;
  if (c.markers.empty()) fail(ErrorCode::invalid_argument, "no markers given");
  struct Plan {
    const api::MarkerInsert* m;
    Owner o;
    std::string id;
  };
  std::vector<Plan> plans;
  for (const api::MarkerInsert& m : c.markers) {
    if (m.duration < 0) fail(ErrorCode::out_of_range, "a marker duration cannot be negative");
    check_label(m.label);
    Owner o = owner_of(d, m.owner);
    plans.push_back(Plan{&m, std::move(o), x.mint_marker_id()});
  }
  x.label = "Add " + plural(plans.size(), "Marker");
  api::MarkerIds out;
  for (const Plan& p : plans) {
    const double fps = comp_fps(d, p.o.comp);
    TMarker mk;
    mk.id = p.id;
    mk.frame = flicks_to_frames(p.m->time, fps);
    mk.duration = std::max(0.0, flicks_to_frames(p.m->duration, fps));
    mk.name = p.m->name;
    mk.comment = p.m->comment;
    mk.color = label_color_of(p.m->label);
    mk.scope = p.o.bar ? "layer" : "timeline";
    mk.ownerId = p.o.bar;
    markers_insert(list_mut(d, Found{p.o.comp, p.o.bar}), std::move(mk));
    out.ids.push_back(p.id);
  }
  return out;
}

ResultOf<api::UpdateMarkers> handle(const api::UpdateMarkers& c, HCtx& x) {
  Document& d = x.d;
  if (c.patches.empty()) fail(ErrorCode::invalid_argument, "no patches given");
  std::vector<Found> found;
  for (const api::MarkerPatch& p : c.patches) {
    found.push_back(find_marker(d, p.id));
    if (p.duration && *p.duration < 0) fail(ErrorCode::out_of_range, "a marker duration cannot be negative");
    if (p.label) check_label(*p.label);
  }
  x.label = "Edit Marker";
  for (std::size_t i = 0; i < c.patches.size(); ++i) {
    const api::MarkerPatch& p = c.patches[i];
    const Found& f = found[i];
    const double fps = comp_fps(d, f.comp);
    std::vector<TMarker>& list = list_mut(d, f);
    TMarker* m = marker_in(list, p.id);
    if (m == nullptr) continue;
    if (p.time) m->frame = flicks_to_frames(*p.time, fps);
    if (p.duration) m->duration = flicks_to_frames(*p.duration, fps);
    if (p.name) m->name = *p.name;
    if (p.comment) m->comment = *p.comment;
    if (p.label) m->color = label_color_of(*p.label);
    if (p.chapter) m->chapter = *p.chapter;
    if (p.url) m->url = *p.url;
    if (p.cue_point) m->cuePoint = *p.cue_point;
    if (p.protected_region) m->protectedRegion = *p.protected_region;
    markers_reindex(list);
  }
  return {};
}

ResultOf<api::DeleteMarkers> handle(const api::DeleteMarkers& c, HCtx& x) {
  Document& d = x.d;
  if (c.ids.empty()) fail(ErrorCode::invalid_argument, "no markers given");
  std::vector<Found> found;
  for (const auto& id : c.ids) found.push_back(find_marker(d, id));
  x.label = "Delete " + plural(found.size(), "Marker");
  for (std::size_t i = 0; i < c.ids.size(); ++i) {
    std::vector<TMarker>& list = list_mut(d, found[i]);
    const auto it = std::find_if(list.begin(), list.end(), [&](const TMarker& m) { return m.id == c.ids[i]; });
    if (it != list.end()) list.erase(it);
  }
  return {};
}

ResultOf<api::MoveMarkers> handle(const api::MoveMarkers& c, HCtx& x) {
  Document& d = x.d;
  std::vector<Found> found;
  for (const auto& id : c.ids) found.push_back(find_marker(d, id));
  x.label = "Move " + plural(found.size(), "Marker");
  for (std::size_t i = 0; i < c.ids.size(); ++i) {
    const double delta = flicks_to_frames(c.delta, comp_fps(d, found[i].comp));
    std::vector<TMarker>& list = list_mut(d, found[i]);
    if (TMarker* m = marker_in(list, c.ids[i])) m->frame = m->frame + delta;
    markers_reindex(list);
  }
  return {};
}

}  // namespace premation::doc
