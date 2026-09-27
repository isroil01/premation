#include "core/aep/aep_apply.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <string_view>

#include "core/aep/aepx.hpp"
#include "catalog_data.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "handlers_comps.hpp"
#include "handlers_layers.hpp"
#include "jsmath.hpp"
#include "scene.hpp"
#include "time_conv.hpp"
#include "timeline.hpp"

namespace premation::doc::aep {

namespace {

using api::ErrorCode;

/// AE's label-colour indices, in AE's own palette order (aepApply.ts LABEL_COLORS).
constexpr std::string_view kLabelColors[] = {
    "",        "#b4655a", "#e0e04a", "#6ad4d4", "#e09fd4", "#b4a0e0", "#e0b48c", "#7fd4b4", "#5a8cd4",
    "#5ab45a", "#8c5ad4", "#e08c3c", "#8c6a4a", "#d45ab4", "#4ad4e0", "#d4c8a0", "#3c7a3c",
};

std::string base_name(std::string_view path) {
  const std::size_t slash = path.find_last_of("/\\");
  return std::string(slash == std::string_view::npos ? path : path.substr(slash + 1));
}

bool finite_positive(double v) { return std::isfinite(v) && v > 0; }

/// Components by type on a node literal that is not in the graph yet.
Component* comp_of(Node& n, std::string_view type) { return n.comp_mut(type); }

std::optional<api::LayerKind> factory_kind(const std::string& kind) {
  if (kind == "solid") return api::LayerKind::solid;
  if (kind == "comp") return api::LayerKind::precomp;
  if (kind == "text") return api::LayerKind::text;
  if (kind == "image") return api::LayerKind::image;
  if (kind == "video") return api::LayerKind::video;
  if (kind == "audio") return api::LayerKind::audio;
  if (kind == "null") return api::LayerKind::null;
  if (kind == "camera") return api::LayerKind::camera;
  if (kind == "light") return api::LayerKind::light;
  if (kind == "adjustment") return api::LayerKind::adjustment;
  if (kind == "group") return api::LayerKind::group;
  if (kind == "shape") return api::LayerKind::shape;
  return std::nullopt;
}

struct Ctx {
  HCtx& x;
  const AepImportPlan& plan;
  AepApplyResult& result;
  std::string rootFolder;
  std::map<std::string, std::string> folderByPath;  ///< "a\x1fb" → folder id
  std::map<std::uint32_t, std::string> compIds;     ///< AE comp id → comp id
  std::map<std::uint32_t, std::string> assetIds;    ///< AE footage id → asset id (real or missing placeholder)
  std::set<std::uint32_t> missingAssets;            ///< AE footage ids whose asset is a placeholder
  std::map<std::uint32_t, const PlannedFootage*> footageById;
  std::map<std::string, std::string> nodeByUid;
};

/// The folder for an AE folder path under the import folder, created on first use.
std::string folder_for(Ctx& c, const std::vector<std::string>& path) {
  std::string parent = c.rootFolder;
  std::string key;
  for (const std::string& name : path) {
    key += name;
    key.push_back('\x1f');
    const auto it = c.folderByPath.find(key);
    if (it != c.folderByPath.end()) {
      parent = it->second;
      continue;
    }
    Folder f;
    f.id = c.x.mint_id("folder_");
    f.name = name.empty() ? "Folder" : name;
    f.parentId = parent;
    const std::string id = f.id;
    c.x.d.items_mut().folders.push_back(std::move(f));
    c.result.items.push_back(id);
    c.folderByPath.emplace(key, id);
    parent = id;
  }
  return parent;
}

// ── 1. compositions ──────────────────────────────────────────────────────

void create_comps(Ctx& c) {
  Document& d = c.x.d;
  for (const PlannedComp& comp : c.plan.comps) {
    // A damaged cdta must not make a comp the timeline cannot divide by.
    const double width = finite_positive(comp.width) ? comp.width : 1920;
    const double height = finite_positive(comp.height) ? comp.height : 1080;
    const double fps = finite_positive(comp.fps) ? comp.fps : 30;
    const double duration = finite_positive(comp.durationSeconds) ? comp.durationSeconds : 10;
    if (width != comp.width || height != comp.height || fps != comp.fps || duration != comp.durationSeconds) {
      c.result.warnings.push_back("\"" + comp.name + "\" had unreadable composition settings; defaults were used for them");
    }
    const std::string id = c.x.mint_id("comp_");
    Json fields = Json::object();
    fields.set("name", Json::string(comp.name));
    fields.set("width", Json::number(width));
    fields.set("height", Json::number(height));
    fields.set("fps", Json::number(fps));
    fields.set("durationSeconds", Json::number(duration));
    fields.set("background", Json::string(comp.background));
    fields.set("folderId", Json::string(folder_for(c, comp.folder)));
    create_comp_record(d, id, fields);
    c.compIds.insert_or_assign(comp.aepId, id);
    c.result.items.push_back(id);
    // The work area, when AE's is narrower than the comp (set_work_area refuses an empty one).
    const Timeline* tl = d.timeline(id);
    if (tl != nullptr && std::isfinite(comp.workAreaStart) && std::isfinite(comp.workAreaEnd)) {
      const api::Time start = seconds_to_flicks(std::max(0.0, comp.workAreaStart));
      const api::Time end = seconds_to_flicks(std::min(duration, comp.workAreaEnd));
      const double f0 = std::max(0.0, flicks_to_frames(start, fps));
      const double f1 = std::min(tl->duration, flicks_to_frames(end, fps));
      if (f1 > f0 && (f0 > 0 || f1 < tl->duration)) set_work_area(d, id, start, end - start);
    }
  }
}

// ── 2. footage ───────────────────────────────────────────────────────────

std::string footage_type(const PlannedFootage& f) {
  if (f.width == 0 && f.height == 0 && f.hasAudio) return "audio";
  return f.isStill ? "image" : "video";
}

/// The item a missing file becomes: docio.cpp's missing-footage placeholder, plus the size AE recorded.
Json missing_placeholder(const std::string& id, const PlannedFootage& f, const std::string& folderId) {
  Json p = Json::object();
  p.set("id", Json::string(id));
  p.set("name", Json::string(f.path ? base_name(*f.path) : f.name));
  p.set("type", Json::string(footage_type(f)));
  p.set("src", Json::string(""));
  p.set("size", Json::number(0));
  if (f.path) p.set("path", Json::string(*f.path));
  p.set("folderId", Json::string(folderId));
  Json md = Json::object();
  md.set("width", Json::number(f.width));
  md.set("height", Json::number(f.height));
  md.set("duration", Json::number(f.isStill ? 0 : f.durationSeconds));
  if (f.frameRate > 0) md.set("fps", Json::number(f.frameRate));
  md.set("hasAudioTrack", Json::boolean(f.hasAudio));
  p.set("metadata", std::move(md));
  return p;
}

void import_footage(Ctx& c) {
  Document& d = c.x.d;
  // One asset per PATH: a project that imported one plate twice has two items and one file.
  std::map<std::string, std::string> byPath;
  std::map<std::string, bool> pathMissing;
  for (const PlannedFootage& f : c.plan.footage) {
    c.footageById.insert_or_assign(f.aepId, &f);
    if (f.kind == "solid") continue;
    if (f.path) {
      if (const auto it = byPath.find(*f.path); it != byPath.end()) {
        c.assetIds.insert_or_assign(f.aepId, it->second);
        if (pathMissing[*f.path]) c.missingAssets.insert(f.aepId);
        continue;
      }
    }
    const std::string folderId = folder_for(c, f.folder);
    const std::string id = c.x.mint_id("item_");
    std::optional<Json> record;
    std::optional<std::string> why;
    if (f.kind == "file" && f.path && c.x.ports.has_import()) {
      api::ImportFile req;
      req.path = *f.path;
      // Never rethrown from inside the catch (a throw inside a catch crashes clang-cl ASan).
      try {
        record = c.x.ports.import_file(req, id);
      } catch (const EngineFail& e) {
        why = e.error.message;
      }
    }
    Json asset;
    if (record && record->is_object()) {
      asset = *record;
      asset.set("id", Json::string(id));
      asset.set("folderId", Json::string(folderId));
      asset.set("path", nn(record->at("path"), Json::string(*f.path)));
    } else {
      asset = missing_placeholder(id, f, folderId);
      c.missingAssets.insert(f.aepId);
      if (f.path && std::find(c.result.missingFootage.begin(), c.result.missingFootage.end(), *f.path) == c.result.missingFootage.end()) {
        c.result.missingFootage.push_back(*f.path);
      }
      if (f.kind == "placeholder") {
        c.result.warnings.push_back("\"" + f.name + "\" is an After Effects placeholder; it came across as a missing item to relink");
      }
    }
    d.items_mut().assets.push_back(std::move(asset));
    c.assetIds.insert_or_assign(f.aepId, id);
    c.result.items.push_back(id);
    if (f.path) {
      byPath.emplace(*f.path, id);
      pathMissing[*f.path] = c.missingAssets.contains(f.aepId);
    }
  }
}

// ── 3. layers ────────────────────────────────────────────────────────────

std::string hex_of01(const AepTextDocument::Rgb& fill) {
  return hex_color(fill.r * 255, fill.g * 255, fill.b * 255);
}

/// One layer's node, unparented, static props written (aepApply.ts createNode).
std::optional<Node> create_node(Ctx& c, const PlannedLayer& layer, const PlannedComp& comp, const std::string& compId) {
  Document& d = c.x.d;
  const Json compRec = *d.comp(compId);
  std::optional<api::LayerKind> kind = factory_kind(layer.kind);
  if (!kind) {
    c.result.warnings.push_back("\"" + layer.name + "\" is a kind of layer this editor has no equivalent for; it came across as a null");
    kind = api::LayerKind::null;
  }
  const PlannedFootage* footage = nullptr;
  std::optional<std::string> assetId;
  if (layer.source && !layer.source->comp) {
    if (const auto it = c.footageById.find(layer.source->aepId); it != c.footageById.end()) footage = it->second;
    if (const auto it = c.assetIds.find(layer.source->aepId); it != c.assetIds.end()) assetId = it->second;
  }
  const bool footageKind = *kind == api::LayerKind::image || *kind == api::LayerKind::video || *kind == api::LayerKind::audio;
  const Json* asset = assetId ? find_asset(d, *assetId) : nullptr;
  if (footageKind && asset == nullptr) {
    c.result.warnings.push_back("\"" + layer.name + "\" lost its footage source; it came across as a null");
    kind = api::LayerKind::null;
  }
  std::optional<std::string> refCompId;
  std::optional<Json> refComp;
  if (*kind == api::LayerKind::precomp) {
    if (const auto it = c.compIds.find(layer.source->aepId); it != c.compIds.end()) {
      refCompId = it->second;
      refComp = *d.comp(it->second);
    }
    if (!refCompId) {
      c.result.warnings.push_back("\"" + layer.name + "\" points at a composition that is not in the file; it came across as a null");
      kind = api::LayerKind::null;
    } else if (*refCompId == compId || would_create_comp_cycle(d, compId, *refCompId)) {
      c.result.warnings.push_back("\"" + layer.name + "\" would nest a composition inside itself; it came across as a null");
      kind = api::LayerKind::null;
      refCompId.reset();
    }
  }

  FactoryInput fi;
  fi.kind = *kind;
  fi.id = c.x.mint_id("layer_");
  fi.name = layer.name;
  fi.comp = &compRec;
  fi.asset = footageKind && asset != nullptr ? asset : nullptr;
  fi.refCompId = refCompId;
  fi.refComp = refComp ? &*refComp : nullptr;
  Node node = make_layer_node(fi);
  node.name = layer.name;

  Component* t = comp_of(node, "Transform");
  if (t == nullptr) return node;
  for (const auto& [key, value] : layer.staticProps) t->props.set(key, Json::number(value));

  // Text belongs to the Text component, not the transform.
  if (layer.text) {
    if (Component* text = comp_of(node, "Text")) {
      const AepTextDocument& doc = *layer.text;
      text->props.set("content", Json::string(doc.text));
      if (doc.fontSize) text->props.set("fontSize", Json::number(*doc.fontSize));
      if (doc.font) text->props.set("fontFamily", Json::string(*doc.font));
      if (doc.fauxBold) text->props.set("fontWeight", Json::number(700));
      if (doc.fauxItalic) text->props.set("fontStyle", Json::string("italic"));
      if (doc.justification) text->props.set("align", Json::string(*doc.justification));
      // AE tracking is thousandths of an em; letter spacing here is pixels.
      if (doc.tracking) text->props.set("letterSpacing", Json::number((*doc.tracking / 1000) * doc.fontSize.value_or(32)));
      if (doc.fillColor) text->props.set("fill", Json::string(hex_of01(*doc.fillColor)));
    }
  }

  // The layer's box is the SOURCE's size (AE scales footage with the transform).
  const bool compSource = layer.source && layer.source->comp;
  if (!compSource) {
    const double w = footage != nullptr && footage->width != 0 ? footage->width : comp.width;
    const double h = footage != nullptr && footage->height != 0 ? footage->height : comp.height;
    if (w != 0) t->props.set("width", Json::number(w));
    if (h != 0) t->props.set("height", Json::number(h));
  }
  if (footageKind && asset != nullptr) {
    const bool missing = c.missingAssets.contains(layer.source->aepId);
    const Json& md = asset->at("metadata");
    if (missing && footage != nullptr && footage->path) {
      // Keep the path, exactly as the TypeScript importer does, beside the placeholder item a relink replaces.
      t->props.set("src", Json::string(*footage->path));
      t->props.set("missingSrc", Json::string(*footage->path));
    } else if (*kind != api::LayerKind::audio) {
      t->props.set("src", asset->at("src"));
    }
    if (*kind != api::LayerKind::audio) t->props.set("assetId", asset->at("id"));
    if (!missing) {
      if (md.at("width").is_number()) t->props.set("width", md.at("width"));
      if (md.at("height").is_number()) t->props.set("height", md.at("height"));
    }
  }
  if (layer.solidColor) {
    if (Component* style = comp_of(node, "Style")) style->props.set("fill", Json::string(*layer.solidColor));
    if (Component* fx = comp_of(node, "fx")) {
      Json fill = Json::object();
      fill.set("type", Json::string("solid"));
      fill.set("color", Json::string(*layer.solidColor));
      fx->props.set("solid", Json::boolean(true));
      fx->props.set("fill", std::move(fill));
    }
  }
  if (refCompId && layer.flags.collapse) {
    if (Component* fx = comp_of(node, "fx")) fx->props.set("collapseTransforms", Json::boolean(true));
  }
  node.visible = layer.flags.enabled;
  node.locked = layer.flags.locked;
  node.solo = layer.flags.solo;
  node.shy = layer.flags.shy;
  if (layer.label > 0 && layer.label < std::size(kLabelColors)) node.color = std::string(kLabelColors[layer.label]);
  return node;
}

/// Masks, effects, blend, switches — everything that is not a prop on the node literal.
void decorate(Ctx& c, const std::string& nodeId, const PlannedLayer& layer) {
  Document& d = c.x.d;
  for (const PlannedMask& mask : layer.masks) {
    const std::string maskId = c.x.mint_group_id("mask_", [&](const std::string& v) {
      const auto m = read_node_mask(*d.node(nodeId));
      return m && mask_path_by_id(*m, v) != nullptr;
    });
    Json path = Json::object();
    path.set("id", Json::string(maskId));
    path.set("name", Json::string(mask.name));
    path.set("mode", Json::string(mask.mode));
    path.set("closed", Json::boolean(mask.closed));
    Json points = Json::array();
    for (const PlannedMaskPoint& p : mask.points) {
      Json pt = Json::object();
      pt.set("x", Json::number(p.x));
      pt.set("y", Json::number(p.y));
      pt.set("inX", Json::number(p.inX));
      pt.set("inY", Json::number(p.inY));
      pt.set("outX", Json::number(p.outX));
      pt.set("outY", Json::number(p.outY));
      points.arr_mut().push_back(std::move(pt));
    }
    path.set("points", std::move(points));
    path.set("feather", Json::number(mask.feather));
    path.set("opacity", Json::number(mask.opacity));
    path.set("expansion", Json::number(mask.expansion));
    path.set("inverted", Json::boolean(mask.inverted));
    edit_every_mask_state(d, nodeId, [&](const Json& m) {
      Json next = m;
      Json paths = m.at("paths").is_array() ? m.at("paths") : Json::array();
      paths.arr_mut().push_back(path);
      next.set("paths", std::move(paths));
      return next;
    });
  }

  for (const PlannedEffect& effect : layer.effects) {
    const EffectDef* def = registry().effect(effect.type);
    if (def == nullptr) {
      c.result.warnings.push_back("\"" + layer.name + "\": the " + effect.type + " effect could not be added");
      continue;
    }
    const std::string effectId =
        c.x.mint_group_id("fx_", [&](const std::string& id) { return find_by_id(get_node_effects(d, nodeId), id) != nullptr; });
    std::vector<Json> effects = get_node_effects(d, nodeId);
    Json e = Json::object();
    e.set("id", Json::string(effectId));
    e.set("type", Json::string(effect.type));
    e.set("params", new_instance_params_of(*def));
    effects.push_back(std::move(e));
    write_node_effects(d, nodeId, std::move(effects));
    for (const auto& [key, value] : effect.params) update_effect_param(d, nodeId, effectId, key, value);
    for (const PlannedTrack& track : effect.tracks) {
      if (!track.keyframes.empty()) d.anim_mut(nodeId).tracks.set("effect." + effectId + "." + track.prop, track.keyframes);
    }
  }

  const auto& modes = registry().blendModes;
  if (std::find(modes.begin(), modes.end(), layer.blendMode) != modes.end()) sg_set_fx(d, nodeId, "blendMode", Json::string(layer.blendMode));
  else if (!layer.blendMode.empty()) c.result.warnings.push_back("\"" + layer.name + "\" uses the " + layer.blendMode + " blending mode, which this editor does not have; it is Normal here");
  if (layer.flags.guide) sg_set_fx(d, nodeId, "guide", Json::boolean(true));
  if (layer.flags.motionBlur) sg_set_fx(d, nodeId, "motionBlur", Json::boolean(true));
}

// ── 7. timeline bars ─────────────────────────────────────────────────────

/// Clip.trimEnd / trimStart (packages/timeline Clip.ts), minDuration 1.
void trim_end(Geo& g, double newEnd) {
  double end = std::max(newEnd, g.start + 1);
  if (g.sourceDuration) end = std::min(end, g.start + (*g.sourceDuration - g.sourceIn));
  g.duration = end - g.start;
}
void trim_start(Geo& g, double newStart) {
  const double tail = g.end();
  double start = std::min(newStart, tail - 1);
  if (g.sourceDuration) start = std::max(start, g.start - g.sourceIn);
  const double delta = start - g.start;
  g.start = start;
  g.duration = tail - start;
  g.sourceIn += delta;
}

}  // namespace

bool is_aep_path(std::string_view path) {
  auto ends = [&](std::string_view ext) {
    if (path.size() < ext.size()) return false;
    for (std::size_t i = 0; i < ext.size(); ++i) {
      char ch = path[path.size() - ext.size() + i];
      if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
      if (ch != ext[i]) return false;
    }
    return true;
  };
  return ends(".aep") || ends(".aepx");
}

ChunkTree parse_aep_bytes(Bytes bytes) {
  // Skip a UTF-8 BOM and leading whitespace, then `<` means XML — whatever the name says.
  std::size_t i = bytes.size() >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf ? 3 : 0;
  while (i < bytes.size() && (bytes[i] == 0x20 || bytes[i] == 0x09 || bytes[i] == 0x0a || bytes[i] == 0x0d)) ++i;
  if (i < bytes.size() && bytes[i] == 0x3c) {
    const Bytes text = bytes.subspan(i);
    return parse_aepx(std::string_view(reinterpret_cast<const char*>(text.data()), text.size()));
  }
  return parse_rifx(bytes);
}

AepApplyResult apply_aep_plan(HCtx& x, const AepImportPlan& plan, const std::string& folderName,
                              const std::optional<std::string>& parentFolder) {
  AepApplyResult result;
  result.warnings = plan.warnings;
  Ctx c{x, plan, result, {}, {}, {}, {}, {}, {}, {}};
  Document& d = x.d;
  {
    Folder f;
    f.id = x.mint_id("folder_");
    f.name = folderName;
    f.parentId = parentFolder;
    c.rootFolder = f.id;
    d.items_mut().folders.push_back(std::move(f));
    result.items.push_back(c.rootFolder);
  }

  // 1 — every comp, empty, so anything can reference anything.
  create_comps(c);
  // 2 — footage, relinked once per path.
  import_footage(c);

  // 3 — layers, bottom of the stack first; 4 — their keyframes.
  for (const PlannedComp& comp : plan.comps) {
    const auto rootIt = c.compIds.find(comp.aepId);
    if (rootIt == c.compIds.end()) continue;
    const std::string rootId = rootIt->second;
    for (auto it = comp.layers.rbegin(); it != comp.layers.rend(); ++it) {
      const PlannedLayer& layer = *it;
      std::optional<Node> node = create_node(c, layer, comp, rootId);
      if (!node) continue;
      const std::string id = node->id;
      node->parent = rootId;
      sg_add_child(d, rootId, std::move(*node));
      c.nodeByUid.insert_or_assign(layer.uid, id);
      decorate(c, id, layer);
      for (const PlannedTrack& track : layer.tracks) {
        if (!track.keyframes.empty()) d.anim_mut(id).tracks.set(track.prop, track.keyframes);
      }
    }
  }

  // 5 — parenting, WITHOUT world compensation: AE stores the child relative to its parent already.
  for (const PlannedComp& comp : plan.comps) {
    for (const PlannedLayer& layer : comp.layers) {
      if (!layer.parentUid) continue;
      const auto child = c.nodeByUid.find(layer.uid);
      const auto parent = c.nodeByUid.find(*layer.parentUid);
      if (child == c.nodeByUid.end() || parent == c.nodeByUid.end()) continue;
      if (child->second == parent->second || is_descendant(d, child->second, parent->second)) {
        result.warnings.push_back("\"" + layer.name + "\" is parented in a loop; it was left unparented");
        continue;
      }
      sg_set_parent(d, child->second, parent->second, false);
    }
  }

  // 6 — track mattes; pre-AE-23 the matte is "the layer directly above".
  for (const PlannedComp& comp : plan.comps) {
    for (std::size_t i = 0; i < comp.layers.size(); ++i) {
      const PlannedLayer& layer = comp.layers[i];
      if (!layer.matte) continue;
      const auto node = c.nodeByUid.find(layer.uid);
      if (node == c.nodeByUid.end()) continue;
      std::optional<std::string> aboveUid = layer.matte->sourceUid;
      if (!aboveUid && i > 0) aboveUid = comp.layers[i - 1].uid;
      Json m = Json::object();
      m.set("mode", Json::string(layer.matte->mode));
      m.set("inverted", Json::boolean(layer.matte->inverted));
      if (aboveUid) {
        const auto src = c.nodeByUid.find(*aboveUid);
        if (src != c.nodeByUid.end() && src->second != node->second) m.set("sourceId", Json::string(src->second));
      }
      sg_set_fx(d, node->second, "matte", std::move(m));
    }
  }

  // 7 — each layer's bar trimmed to the window AE gave it.
  for (const PlannedComp& comp : plan.comps) {
    const auto compIt = c.compIds.find(comp.aepId);
    if (compIt == c.compIds.end()) continue;
    const std::string& compId = compIt->second;
    tl_sync_from_scene(d, compId);
    const double fps = d.comp(compId)->at("fps").num();
    for (const PlannedLayer& layer : comp.layers) {
      const auto node = c.nodeByUid.find(layer.uid);
      if (node == c.nodeByUid.end()) continue;
      std::vector<Geo> geoms = geoms_of(d, node->second, compId);
      if (geoms.empty()) continue;
      const double inSec = layer.timing.inSec;
      const double outSec = layer.timing.outSec;
      if (!(outSec > inSec) || !std::isfinite(inSec) || !std::isfinite(outSec)) continue;  // never visible: leave the bar whole
      trim_end(geoms[0], motion::js::round(outSec * fps));
      trim_start(geoms[0], motion::js::round(inSec * fps));
      write_geoms(d, compId, node->second, geoms);
    }
  }

  // 8 — the comp a person would open.
  if (const auto main = main_comp(plan)) {
    const auto it = c.compIds.find(plan.comps[*main].aepId);
    if (it != c.compIds.end()) result.openComp = it->second;
  }

  const std::size_t missing = result.missingFootage.size();
  if (missing > 0) {
    std::string names;
    for (std::size_t i = 0; i < std::min<std::size_t>(missing, 5); ++i) names += (i > 0 ? ", " : "") + base_name(result.missingFootage[i]);
    result.warnings.push_back(std::to_string(missing) + (missing == 1 ? " footage file" : " footage files") +
                              " could not be found: " + names + (missing > 5 ? "…" : "") +
                              ". Those layers were kept and can be relinked.");
  }
  return result;
}

}  // namespace premation::doc::aep
