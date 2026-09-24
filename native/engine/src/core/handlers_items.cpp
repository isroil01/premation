#include "handlers_items.hpp"

#include <algorithm>
#include <set>

#include "fxstate.hpp"
#include "parenting.hpp"
#include "readmodel.hpp"
#include "values.hpp"

namespace premation::doc {

using api::ErrorCode;

std::string js_trim(std::string_view s) {
  // ASCII whitespace plus NBSP (C2 A0), BOM (EF BB BF) and the U+2000 block
  // spaces in their UTF-8 forms — the characters names realistically carry.
  const auto lead = [](std::string_view v) -> std::size_t {
    const unsigned char c = static_cast<unsigned char>(v[0]);
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') return 1;
    if (v.size() >= 2 && c == 0xC2 && static_cast<unsigned char>(v[1]) == 0xA0) return 2;
    if (v.size() >= 3 && c == 0xEF && static_cast<unsigned char>(v[1]) == 0xBB && static_cast<unsigned char>(v[2]) == 0xBF) return 3;
    if (v.size() >= 3 && c == 0xE2 && static_cast<unsigned char>(v[1]) == 0x80) {
      const unsigned char d = static_cast<unsigned char>(v[2]);
      if (d <= 0x8A || d == 0xA8 || d == 0xA9 || d == 0xAF) return 3;
    }
    if (v.size() >= 3 && c == 0xE3 && static_cast<unsigned char>(v[1]) == 0x80 && static_cast<unsigned char>(v[2]) == 0x80) return 3;
    return 0;
  };
  const auto trail = [](std::string_view v) -> std::size_t {
    const std::size_t n = v.size();
    const unsigned char c = static_cast<unsigned char>(v[n - 1]);
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') return 1;
    if (n >= 2 && static_cast<unsigned char>(v[n - 2]) == 0xC2 && c == 0xA0) return 2;
    if (n >= 3) {
      const auto a = static_cast<unsigned char>(v[n - 3]);
      const auto b = static_cast<unsigned char>(v[n - 2]);
      if (a == 0xEF && b == 0xBB && c == 0xBF) return 3;
      if (a == 0xE2 && b == 0x80 && (c <= 0x8A || c == 0xA8 || c == 0xA9 || c == 0xAF)) return 3;
      if (a == 0xE3 && b == 0x80 && c == 0x80) return 3;
    }
    return 0;
  };
  while (!s.empty()) {
    const std::size_t k = lead(s);
    if (k == 0) break;
    s.remove_prefix(k);
  }
  while (!s.empty()) {
    const std::size_t k = trail(s);
    if (k == 0) break;
    s.remove_suffix(k);
  }
  return std::string(s);
}

namespace {

/// `interpretationPatch(p)`: the validated patch and the keys it clears.
struct InterpPatch {
  Json patch = Json::object();
  std::vector<std::string> clear;
};

InterpPatch interpretation_patch(const api::InterpretationPatch& p) {
  InterpPatch out;
  if (p.alpha) {
    if (*p.alpha == api::AlphaMode::ignore) fail(ErrorCode::unsupported, "Interpret ▸ Ignore alpha is not implemented by the TypeScript renderer");
    if (*p.alpha == api::AlphaMode::auto_) out.clear.emplace_back("alpha");
    else out.patch.set("alpha", Json::string(std::string(api::to_string(*p.alpha))));
  }
  if (p.conform_frame_rate) {
    const api::Rational& r = *p.conform_frame_rate;
    if (!(r.num > 0) || !(r.den > 0)) fail(ErrorCode::invalid_argument, "frame rate must be positive");
    out.patch.set("conformFps", Json::number(static_cast<double>(r.num) / static_cast<double>(r.den)));
  }
  if (p.clear_conform && *p.clear_conform) out.clear.emplace_back("conformFps");
  if (p.pixel_aspect) {
    if (!(*p.pixel_aspect > 0)) fail(ErrorCode::out_of_range, "pixel aspect must be positive");
    out.patch.set("par", Json::number(*p.pixel_aspect));
  }
  if (p.field_order) {
    if (*p.field_order == api::FieldOrder::progressive) out.clear.emplace_back("fields");
    else out.patch.set("fields", Json::string(*p.field_order == api::FieldOrder::upper_first ? "upper" : "lower"));
  }
  if (p.loops) out.patch.set("loopCount", Json::number(*p.loops));
  // B3z: Remove Pulldown (sourceInfo.ts pulldownPhase, 0..4).
  if (p.remove_pulldown) {
    if (p.clear_remove_pulldown && *p.clear_remove_pulldown) {
      fail(ErrorCode::invalid_argument, "send removePulldown or clearRemovePulldown, not both");
    }
    if (*p.remove_pulldown > 4) fail(ErrorCode::out_of_range, "the pulldown phase is 0..4");
    out.patch.set("pulldownPhase", Json::number(*p.remove_pulldown));
  }
  if (p.clear_remove_pulldown && *p.clear_remove_pulldown) out.clear.emplace_back("pulldownPhase");
  if (p.invert_alpha && *p.invert_alpha) fail(ErrorCode::unsupported, "Invert Alpha is not implemented by the TypeScript renderer");
  if (p.premultiplied_matte || p.start_timecode || (p.color_profile && *p.color_profile != "auto")) {
    fail(ErrorCode::unsupported,
         "premultiplied matte colour, start timecode and colour profiles are not stored by the TypeScript engine");
  }
  return out;
}

/// `{...(a.interpret ?? {}), ...patch}` minus the cleared keys, onto `a`.
Json with_interpretation(const Json& a, const InterpPatch& ip) {
  const Json& cur = a.at("interpret");
  Json interp = spread(cur.is_object() ? cur : Json::object(), ip.patch);
  for (const auto& k : ip.clear) interp.erase(k);
  Json next = a;
  next.set("interpret", std::move(interp));
  return next;
}

bool is_id(const Json& a, std::string_view id) { return a.at("id").is_string() && a.at("id").str() == id; }

/// `patchAsset(id, fn)`.
template <class F>
void patch_asset(Document& d, std::string_view id, F&& fn) {
  Items& items = d.items_mut();
  for (Json& a : items.assets) {
    if (is_id(a, id)) a = fn(static_cast<const Json&>(a));
  }
}

/// `patchComp(id, fields)`: spread, then undefined fields deleted.
void patch_comp(Document& d, std::string_view id, const Json& fields) {
  Json next = spread(*d.comp(id), fields);
  for (const auto& m : fields.obj()) {
    if (m.value.is_undefined()) next.erase(m.key);
  }
  d.comp_mut(id) = std::move(next);
}

bool has_folder(const Document& d, std::string_view id) { return find_folder(d, id) != nullptr; }

api::RenderSettings default_render() {
  api::RenderSettings s;
  s.format = "mp4-h264";
  s.output_path = "";
  s.range = api::TimeRange{0, 0};
  s.bit_depth = api::BitDepth::u8;
  s.include_audio = true;
  s.include_alpha = false;
  s.quality = 80;
  s.output_color_space = "";
  s.motion_blur = true;
  s.frame_blending = true;
  return s;
}

api::RenderSettings apply_render_patch(api::RenderSettings s, const api::RenderSettingsPatch& p) {
  if (p.format) s.format = *p.format;
  if (p.output_path) s.output_path = *p.output_path;
  if (p.range) s.range = *p.range;
  if (p.width) s.width = p.width;
  if (p.height) s.height = p.height;
  if (p.frame_rate) s.frame_rate = p.frame_rate;
  if (p.bit_depth) s.bit_depth = *p.bit_depth;
  if (p.include_audio) s.include_audio = *p.include_audio;
  if (p.include_alpha) s.include_alpha = *p.include_alpha;
  if (p.quality) s.quality = *p.quality;
  if (p.output_color_space) s.output_color_space = *p.output_color_space;
  if (p.motion_blur) s.motion_blur = *p.motion_blur;
  if (p.frame_blending) s.frame_blending = *p.frame_blending;
  if (p.encoder_options) s.encoder_options = p.encoder_options;
  return s;
}

bool in_queue(const RenderQueue& q, const std::string& id) {
  return std::any_of(q.begin(), q.end(), [&id](const api::RenderItemInfo& r) { return r.id == id; });
}

}  // namespace

ResultOf<api::ImportFiles> handle(const api::ImportFiles& c, HCtx& x) {
  Document& d = x.d;
  if (c.files.empty()) fail(ErrorCode::invalid_argument, "no files given");
  if (!x.ports.has_import()) fail(ErrorCode::unsupported, "no media import port is attached to this engine");
  for (const api::ImportFile& f : c.files) {
    if (f.folder && !f.folder->empty() && !has_folder(d, *f.folder)) {
      fail(ErrorCode::not_found, "no folder '" + *f.folder + "'", {.item = *f.folder});
    }
    if (f.create_composition) {
      fail(ErrorCode::unsupported, "import then createComposition{fromItems} (one batch) — the TS engine does not fold the two");
    }
    if (f.interpretation) (void)interpretation_patch(*f.interpretation);
  }
  std::vector<std::string> ids;
  for (std::size_t i = 0; i < c.files.size(); ++i) ids.push_back(x.mint_id("item_"));
  x.label = "Import " + plural(c.files.size(), "File");
  std::vector<Json> records;
  for (std::size_t i = 0; i < c.files.size(); ++i) {
    // Re-thrown outside the handler (a throw inside a catch crashes clang-cl ASan).
    std::optional<std::string> failed;
    try {
      records.push_back(x.ports.import_file(c.files[i], ids[i]));
    } catch (const EngineFail& e) {
      failed = e.error.message;
    }
    if (failed) fail(ErrorCode::io, "could not import '" + c.files[i].path + "': " + *failed);
  }
  std::vector<Json> added;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const api::ImportFile& f = c.files[i];
    const Json& r = records[i];
    Json a = r;
    a.set("id", Json::string(ids[i]));
    if (f.folder && !f.folder->empty()) a.set("folderId", Json::string(*f.folder));
    a.set("path", nn(r.at("path"), Json::string(f.path)));
    if (f.interpretation) a = with_interpretation(a, interpretation_patch(*f.interpretation));
    added.push_back(std::move(a));
  }
  Items& items = d.items_mut();
  for (auto& a : added) items.assets.push_back(std::move(a));
  return api::ItemList{ids};
}

ResultOf<api::ImportBytes> handle(const api::ImportBytes& c, HCtx& x) {
  Document& d = x.d;
  if (c.files.empty()) fail(ErrorCode::invalid_argument, "no files given");
  if (!x.ports.has_import()) fail(ErrorCode::unsupported, "no media import port is attached to this engine");
  for (const api::ImportBytesFile& f : c.files) {
    if (f.data.empty()) fail(ErrorCode::invalid_argument, "'" + f.name + "' has no bytes");
    if (js_trim(f.name).empty()) fail(ErrorCode::invalid_argument, "a file name is required");
    if (f.folder && !f.folder->empty() && !has_folder(d, *f.folder)) {
      fail(ErrorCode::not_found, "no folder '" + *f.folder + "'", {.item = *f.folder});
    }
    if (f.interpretation) (void)interpretation_patch(*f.interpretation);
  }
  std::vector<std::string> ids;
  for (std::size_t i = 0; i < c.files.size(); ++i) ids.push_back(x.mint_id("item_"));
  x.label = "Import " + plural(c.files.size(), "File");
  std::vector<Json> records;
  for (std::size_t i = 0; i < c.files.size(); ++i) {
    std::optional<std::string> failed;
    try {
      records.push_back(x.ports.import_bytes(c.files[i], ids[i]));
    } catch (const EngineFail& e) {
      failed = e.error.message;
    }
    if (failed) fail(ErrorCode::io, "could not import '" + c.files[i].name + "': " + *failed);
  }
  Items& items = d.items_mut();
  for (std::size_t i = 0; i < records.size(); ++i) {
    const api::ImportBytesFile& f = c.files[i];
    Json a = records[i];
    a.set("id", Json::string(ids[i]));
    if (f.folder && !f.folder->empty()) a.set("folderId", Json::string(*f.folder));
    if (f.interpretation) a = with_interpretation(a, interpretation_patch(*f.interpretation));
    items.assets.push_back(std::move(a));
  }
  return api::ItemList{ids};
}

ResultOf<api::RelinkItem> handle(const api::RelinkItem& c, HCtx& x) {
  Document& d = x.d;
  const ItemRef ref = require_item(d, c.item);
  if (ref.kind != ItemRefKind::footage) fail(ErrorCode::invalid_argument, "only footage can be relinked", {.item = c.item});
  if (js_trim(c.path).empty()) fail(ErrorCode::invalid_argument, "path is empty");
  x.label = "Relink Footage";
  const Json probed = x.ports.has_probe() ? x.ports.probe_file(c.path) : Json::object();
  patch_asset(d, c.item, [&](const Json& a) {
    Json next = spread(a, probed.is_object() ? probed : Json::object());
    next.set("id", a.at("id"));
    next.set("path", Json::string(c.path));
    if (!c.keep_interpretation) next.erase("interpret");
    return next;
  });
  return {};
}

ResultOf<api::RemoveItems> handle(const api::RemoveItems& c, HCtx& x) {
  Document& d = x.d;
  if (c.items.empty()) fail(ErrorCode::invalid_argument, "no items given");
  std::vector<ItemRef> refs;
  for (const auto& id : c.items) refs.push_back(require_item(d, id));
  std::vector<std::string> layers;
  for (const ItemRef& r : refs) {
    if (r.kind == ItemRefKind::folder) continue;
    const auto using_ = layers_using_item(d, r.id);
    if (!using_.empty() && !c.remove_using_layers) {
      fail(ErrorCode::locked, "item '" + r.id + "' is used by " + plural(using_.size(), "layer"), {.item = r.id});
    }
    layers.insert(layers.end(), using_.begin(), using_.end());
  }
  x.label = "Remove " + plural(refs.size(), "Item");
  for (const auto& l : layers) {
    if (d.node(l) != nullptr) (void)delete_layer_node(d, l);
  }
  {
    const Items snap = d.items();
    std::set<std::string, std::less<>> doomedFolders;
    for (const ItemRef& r : refs) {
      if (r.kind == ItemRefKind::folder) doomedFolders.insert(r.id);
    }
    bool grew = true;
    while (grew) {
      grew = false;
      for (const Folder& f : snap.folders) {
        if (f.parentId && !f.parentId->empty() && doomedFolders.contains(*f.parentId) && !doomedFolders.contains(f.id)) {
          doomedFolders.insert(f.id);
          grew = true;
        }
      }
    }
    std::set<std::string, std::less<>> doomedAssets;
    for (const ItemRef& r : refs) {
      if (r.kind == ItemRefKind::footage) doomedAssets.insert(r.id);
    }
    for (const Json& a : snap.assets) {
      const Json& fid = a.at("folderId");
      if (fid.is_string() && !fid.str().empty() && doomedFolders.contains(fid.str())) doomedAssets.insert(a.at("id").str());
    }
    Items& items = d.items_mut();
    std::erase_if(items.assets, [&](const Json& a) { return a.at("id").is_string() && doomedAssets.contains(a.at("id").str()); });
    std::erase_if(items.folders, [&](const Folder& f) { return doomedFolders.contains(f.id); });
  }
  for (const ItemRef& r : refs) {
    if (r.kind != ItemRefKind::composition) continue;
    for (const auto& id : layer_ids_of_comp(d, r.id)) d.set_anim(id, std::nullopt);
    sg_remove_node(d, r.id);
    d.remove_comp(r.id);
    d.remove_timeline(r.id);
  }
  return {};
}

ResultOf<api::RenameItem> handle(const api::RenameItem& c, HCtx& x) {
  Document& d = x.d;
  const ItemRef ref = require_item(d, c.item);
  if (js_trim(c.name).empty()) fail(ErrorCode::invalid_argument, "a name cannot be empty");
  x.label = "Rename Item";
  if (ref.kind == ItemRefKind::composition) {
    Json f = Json::object();
    f.set("name", Json::string(c.name));
    patch_comp(d, ref.id, f);
    d.node_mut(ref.id).name = c.name;
  } else if (ref.kind == ItemRefKind::footage) {
    patch_asset(d, ref.id, [&](const Json& a) {
      Json n = a;
      n.set("name", Json::string(c.name));
      return n;
    });
  } else {
    Items& items = d.items_mut();
    for (Folder& f : items.folders) {
      if (f.id == ref.id) f.name = c.name;
    }
  }
  return {};
}

ResultOf<api::CreateFolder> handle(const api::CreateFolder& c, HCtx& x) {
  Document& d = x.d;
  if (c.parent && !c.parent->empty() && !has_folder(d, *c.parent)) {
    fail(ErrorCode::not_found, "no folder '" + *c.parent + "'", {.item = *c.parent});
  }
  const std::string id = x.mint_id("folder_");
  x.label = "New Folder";
  const std::string name = js_trim(c.name);
  Folder f;
  f.id = id;
  f.name = name.empty() ? "Untitled Folder" : name;
  f.parentId = c.parent;
  d.items_mut().folders.push_back(std::move(f));
  return api::ItemRef{id};
}

ResultOf<api::MoveItems> handle(const api::MoveItems& c, HCtx& x) {
  Document& d = x.d;
  std::vector<ItemRef> refs;
  for (const auto& id : c.items) refs.push_back(require_item(d, id));
  const std::vector<Folder> folders = d.items().folders;
  if (c.folder && !has_folder(d, *c.folder)) fail(ErrorCode::not_found, "no folder '" + *c.folder + "'", {.item = *c.folder});
  for (const ItemRef& r : refs) {
    if (r.kind != ItemRefKind::folder || !c.folder || c.folder->empty()) continue;
    std::optional<std::string> cur = *c.folder;
    while (cur && !cur->empty()) {
      if (*cur == r.id) fail(ErrorCode::cycle, "folder '" + r.id + "' cannot move into itself", {.item = r.id});
      const auto it = std::find_if(folders.begin(), folders.end(), [&cur](const Folder& f) { return f.id == *cur; });
      cur = it != folders.end() ? it->parentId : std::nullopt;
    }
  }
  x.label = "Move Items";
  std::set<std::string, std::less<>> ids;
  for (const ItemRef& r : refs) ids.insert(r.id);
  {
    Items& items = d.items_mut();
    for (Json& a : items.assets) {
      if (a.at("id").is_string() && ids.contains(a.at("id").str())) {
        a.set("folderId", c.folder ? Json::string(*c.folder) : Json::null());
      }
    }
    for (Folder& f : items.folders) {
      if (ids.contains(f.id)) f.parentId = c.folder;
    }
  }
  for (const ItemRef& r : refs) {
    if (r.kind != ItemRefKind::composition) continue;
    Json f = Json::object();
    f.set("folderId", c.folder ? Json::string(*c.folder) : Json());
    patch_comp(d, r.id, f);
  }
  return {};
}

ResultOf<api::SetInterpretation> handle(const api::SetInterpretation& c, HCtx& x) {
  Document& d = x.d;
  std::vector<ItemRef> refs;
  for (const auto& id : c.items) refs.push_back(require_item(d, id));
  for (const ItemRef& r : refs) {
    if (r.kind != ItemRefKind::footage) fail(ErrorCode::invalid_argument, "only footage has an interpretation", {.item = r.id});
  }
  const InterpPatch ip = interpretation_patch(c.patch);
  x.label = "Interpret Footage";
  const std::set<std::string, std::less<>> ids(c.items.begin(), c.items.end());
  Items& items = d.items_mut();
  for (Json& a : items.assets) {
    if (a.at("id").is_string() && ids.contains(a.at("id").str())) a = with_interpretation(a, ip);
  }
  return {};
}

ResultOf<api::SetItemLabel> handle(const api::SetItemLabel& c, HCtx& x) {
  Document& d = x.d;
  std::vector<ItemRef> refs;
  for (const auto& id : c.items) refs.push_back(require_item(d, id));
  for (const ItemRef& r : refs) {
    if (r.kind == ItemRefKind::folder) fail(ErrorCode::unsupported, "folders carry no label in this engine", {.item = r.id});
  }
  if (c.label > 0 && !label_color_of(c.label)) fail(ErrorCode::out_of_range, "label " + std::to_string(c.label) + " does not exist");
  x.label = "Item Label";
  for (const ItemRef& r : refs) {
    if (r.kind == ItemRefKind::composition) {
      Json f = Json::object();
      f.set("label", c.label != 0 ? Json::number(c.label) : Json());
      patch_comp(d, r.id, f);
    } else {
      patch_asset(d, r.id, [&](const Json& a) {
        Json next = a;
        // B3z: the palette id — the Project panel's (and the bundle's) form.
        if (const auto col = label_id_of(c.label)) next.set("label", Json::string(*col));
        else next.erase("label");
        return next;
      });
    }
  }
  return {};
}

ResultOf<api::RemoveUnusedItems> handle(const api::RemoveUnusedItems& /*c*/, HCtx& x) {
  Document& d = x.d;
  std::vector<std::string> unused;
  for (const Json& a : d.items().assets) {
    const std::string id = a.at("id").is_string() ? a.at("id").str() : "";
    if (layers_using_item(d, id).empty()) unused.push_back(id);
  }
  x.label = "Remove Unused Footage";
  const std::set<std::string, std::less<>> doomed(unused.begin(), unused.end());
  Items& items = d.items_mut();
  std::erase_if(items.assets, [&](const Json& a) { return doomed.contains(a.at("id").is_string() ? a.at("id").str() : ""); });
  return api::ItemList{unused};
}

ResultOf<api::SetProxy> handle(const api::SetProxy& c, HCtx& x) {
  Document& d = x.d;
  const ItemRef ref = require_item(d, c.item);
  if (ref.kind != ItemRefKind::footage) {
    fail(ErrorCode::unsupported, "composition proxies are not implemented by the TypeScript engine", {.item = c.item});
  }
  x.label = "Set Proxy";
  patch_asset(d, c.item, [&](const Json& a) {
    Json next = a;
    if ((!c.path || c.path->empty()) && !c.enabled) {
      next.erase("proxy");
    } else {
      const Json& cur = a.at("proxy");
      Json src = c.path ? Json::string(*c.path) : cur.at("src");
      const bool srcTruthy = src.is_string() ? !src.str().empty() : !(src.is_undefined() || src.is_null());
      Json proxy = cur.is_object() ? cur : Json::object();
      proxy.set("status", Json::string(c.enabled && srcTruthy ? "ready" : "none"));
      if (srcTruthy) proxy.set("src", src);
      proxy.set("userSupplied", Json::boolean(true));
      next.set("proxy", std::move(proxy));
    }
    return next;
  });
  return {};
}

ResultOf<api::SetItemComment> handle(const api::SetItemComment& c, HCtx& x) {
  Document& d = x.d;
  const ItemRef ref = require_item(d, c.item);
  if (ref.kind == ItemRefKind::folder) fail(ErrorCode::unsupported, "folders carry no comment in this engine", {.item = c.item});
  x.label = "Item Comment";
  if (ref.kind == ItemRefKind::composition) {
    Json f = Json::object();
    f.set("comment", c.comment.empty() ? Json() : Json::string(c.comment));
    patch_comp(d, ref.id, f);
  } else {
    patch_asset(d, ref.id, [&](const Json& a) {
      Json next = a;
      if (!c.comment.empty()) next.set("comment", Json::string(c.comment));
      else next.erase("comment");
      return next;
    });
  }
  return {};
}

ResultOf<api::SetItemTags> handle(const api::SetItemTags& c, HCtx& x) {
  Document& d = x.d;
  const ItemRef ref = require_item(d, c.item);
  if (ref.kind != ItemRefKind::footage) fail(ErrorCode::unsupported, "only footage carries tags in this engine", {.item = c.item});
  x.label = "Item Tags";
  patch_asset(d, c.item, [&](const Json& a) {
    Json next = a;
    if (!c.tags.empty()) {
      Json t = Json::array();
      for (const auto& s : c.tags) t.arr_mut().push_back(Json::string(s));
      next.set("tags", std::move(t));
    } else {
      next.erase("tags");
    }
    return next;
  });
  return {};
}

// ── Render queue ─────────────────────────────────────────────────────────

ResultOf<api::AddRenderItems> handle(const api::AddRenderItems& c, HCtx& x) {
  Document& d = x.d;
  if (c.comps.empty()) fail(ErrorCode::invalid_argument, "no compositions given");
  for (const auto& comp : c.comps) {
    if (!is_comp_item(d, comp)) fail(ErrorCode::not_found, "no composition '" + comp + "'", {.item = comp});
  }
  std::vector<std::string> ids;
  for (std::size_t i = 0; i < c.comps.size(); ++i) ids.push_back(x.mint_id("render_"));
  x.label = "Add to Render Queue";
  std::vector<api::RenderItemInfo> added;
  for (std::size_t i = 0; i < c.comps.size(); ++i) {
    const api::CompSettings cs = comp_settings(d, c.comps[i]);
    api::RenderSettings base = default_render();
    base.range = api::TimeRange{0, cs.duration};
    api::RenderItemInfo r;
    r.id = ids[i];
    r.comp = c.comps[i];
    r.settings = apply_render_patch(base, c.settings);
    r.status = api::RenderStatus::queued;
    r.queued = true;
    r.progress = 0;
    r.error = "";
    added.push_back(std::move(r));
  }
  RenderQueue& q = d.render_queue_mut();
  for (auto& r : added) q.push_back(std::move(r));
  return api::RenderItemList{ids};
}

ResultOf<api::SetRenderItem> handle(const api::SetRenderItem& c, HCtx& x) {
  Document& d = x.d;
  if (!in_queue(d.render_queue(), c.item)) fail(ErrorCode::not_found, "no render item '" + c.item + "'");
  x.label = "Render Settings";
  for (api::RenderItemInfo& r : d.render_queue_mut()) {
    if (r.id != c.item) continue;
    r.settings = apply_render_patch(r.settings, c.patch);
    if (c.queued) {
      r.queued = *c.queued;
      r.status = *c.queued ? api::RenderStatus::queued : api::RenderStatus::unqueued;
    }
  }
  return {};
}

ResultOf<api::RemoveRenderItems> handle(const api::RemoveRenderItems& c, HCtx& x) {
  Document& d = x.d;
  for (const auto& id : c.items) {
    if (!in_queue(d.render_queue(), id)) fail(ErrorCode::not_found, "no render item '" + id + "'");
  }
  x.label = "Remove from Render Queue";
  const std::set<std::string, std::less<>> doomed(c.items.begin(), c.items.end());
  std::erase_if(d.render_queue_mut(), [&](const api::RenderItemInfo& r) { return doomed.contains(r.id); });
  return {};
}

ResultOf<api::ReorderRenderItems> handle(const api::ReorderRenderItems& c, HCtx& x) {
  Document& d = x.d;
  const RenderQueue q = d.render_queue();
  for (const auto& id : c.items) {
    if (!in_queue(q, id)) fail(ErrorCode::not_found, "no render item '" + id + "'");
  }
  if (c.to_index > q.size()) fail(ErrorCode::out_of_range, "toIndex past the end");
  x.label = "Reorder Render Queue";
  const std::set<std::string, std::less<>> moving(c.items.begin(), c.items.end());
  RenderQueue movers;
  RenderQueue rest;
  for (const auto& r : q) (moving.contains(r.id) ? movers : rest).push_back(r);
  std::size_t before = 0;
  for (std::size_t i = 0; i < c.to_index && i < q.size(); ++i) {
    if (!moving.contains(q[i].id)) ++before;
  }
  const std::size_t at = std::min(rest.size(), before);
  RenderQueue next(rest.begin(), rest.begin() + static_cast<std::ptrdiff_t>(at));
  next.insert(next.end(), movers.begin(), movers.end());
  next.insert(next.end(), rest.begin() + static_cast<std::ptrdiff_t>(at), rest.end());
  d.render_queue_mut() = std::move(next);
  return {};
}

}  // namespace premation::doc
