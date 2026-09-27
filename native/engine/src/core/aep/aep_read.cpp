#include "core/aep/aep_read.hpp"

#include <map>
#include <optional>

#include "core/aep/aep_properties.hpp"
#include "json.hpp"

namespace premation::doc::aep {

namespace {

std::optional<ItemKind> item_kind(std::uint32_t raw) {
  if (raw == 1) return ItemKind::folder;
  if (raw == 4) return ItemKind::comp;
  if (raw == 7) return ItemKind::footage;
  return std::nullopt;
}

LayerKind layer_kind(std::uint32_t raw) {
  switch (raw) {
    case 1: return LayerKind::light;
    case 2: return LayerKind::camera;
    case 3: return LayerKind::text;
    case 4: return LayerKind::shape;
    case 5: return LayerKind::model;
    case 7: return LayerKind::mesh;
    default: return LayerKind::av;
  }
}

std::string track_matte(std::uint32_t raw) {
  static constexpr const char* kMattes[] = {"none", "alpha", "alpha-inverted", "luma", "luma-inverted"};
  return raw < 5 ? kMattes[raw] : "none";
}

std::string mask_mode(std::uint32_t raw) {
  static constexpr const char* kModes[] = {"none", "add", "subtract", "intersect", "lighten", "darken", "difference"};
  return raw < 7 ? kModes[raw] : "add";
}

/// Transfer-mode index → AE's blending-mode name: neither contiguous nor in menu order (there is no 1).
std::string blending_mode(std::uint32_t raw) {
  static const std::map<std::uint32_t, const char*> kModes = {
      {0, "Normal"},           {2, "Normal"},           {3, "Dissolve"},           {4, "Add"},
      {5, "Multiply"},         {6, "Screen"},           {7, "Overlay"},            {8, "Soft Light"},
      {9, "Hard Light"},       {10, "Darken"},          {11, "Lighten"},           {12, "Classic Difference"},
      {13, "Hue"},             {14, "Saturation"},      {15, "Color"},             {16, "Luminosity"},
      {17, "Stencil Alpha"},   {18, "Stencil Luma"},    {19, "Silhouette Alpha"},  {20, "Silhouette Luma"},
      {21, "Luminescent Premul"}, {22, "Alpha Add"},    {23, "Classic Color Dodge"}, {24, "Classic Color Burn"},
      {25, "Exclusion"},       {26, "Difference"},      {27, "Color Dodge"},       {28, "Color Burn"},
      {29, "Linear Dodge"},    {30, "Linear Burn"},     {31, "Linear Light"},      {32, "Vivid Light"},
      {33, "Pin Light"},       {34, "Hard Mix"},        {35, "Lighter Color"},     {36, "Darker Color"},
      {37, "Subtract"},        {38, "Divide"},
  };
  const auto it = kModes.find(raw);
  return it != kModes.end() ? it->second : "Normal";
}

/// AE's "the work area runs to the end of the comp" sentinel.
constexpr std::uint32_t kWorkAreaOpenEnd = 0xffffffffU;

/// `cdta` — 204 bytes of composition settings (the frame rate is an integer + a 16-bit fraction).
AepComp read_comp_settings(const Chunk* cdta) {
  const Reader r = reader_for(cdta);
  AepComp c;
  const std::uint32_t workAreaEndDividend = r.u32(28);
  c.width = r.u16(140);
  c.height = r.u16(142);
  c.fps = r.u16(156) + r.u16(158) / 65536.0;
  c.durationSeconds = ratio(r.u32(44), r.u32(48));
  const double par = ratio(r.u32(144), r.u32(148));
  c.pixelAspect = par != 0 ? par : 1;
  c.background = AepRgb8{r.u8(52), r.u8(53), r.u8(54)};
  c.displayStartTime = ratio(r.i32(164), r.u32(168));
  c.workAreaStart = ratio(r.u32(20), r.u32(24));
  c.workAreaEnd = workAreaEndDividend == kWorkAreaOpenEnd ? std::numeric_limits<double>::infinity()
                                                          : ratio(workAreaEndDividend, r.u32(32));
  c.motionBlur = r.bit(139, 3);
  c.shutterAngle = r.u16(174);
  c.shutterPhase = r.i32(180);
  c.motionBlurSamplesPerFrame = r.i32(200);
  c.motionBlurAdaptiveSampleLimit = r.i32(196);
  c.frameBlending = r.bit(139, 4);
  c.hideShyLayers = r.bit(139, 0);
  c.draft3d = r.bit(138, 7);
  c.internalTimebase = r.u32(8);
  return c;
}

/// The three flag bytes at `ldta` 37–39 (auto-orient is a combination, not a field).
void read_layer_flags(const Reader& r, AepLayer& l) {
  const bool threeD = r.bit(38, 2);
  const bool alongPath = r.bit(38, 0);
  const bool towardPoint = l.kind == LayerKind::camera || l.kind == LayerKind::light ? r.bit(38, 6) : r.bit(38, 5);
  const bool charsTowardCamera = r.bit(37, 4) && r.bit(37, 3);
  l.autoOrient = alongPath ? 1 : (towardPoint && threeD) ? 2 : charsTowardCamera ? 3 : 0;
  l.guide = r.bit(37, 1);
  l.environmentLayer = r.bit(37, 5);
  l.nullLayer = r.bit(38, 7);
  l.solo = r.bit(38, 3);
  l.threeD = threeD;
  l.adjustment = r.bit(38, 1);
  l.collapseTransformation = r.bit(39, 7);
  l.shy = r.bit(39, 6);
  l.locked = r.bit(39, 5);
  l.frameBlending = r.bit(39, 4);
  l.motionBlur = r.bit(39, 3);
  l.effectsActive = r.bit(39, 2);
  l.audioEnabled = r.bit(39, 1);
  l.enabled = r.bit(39, 0);
}

/// Masks, from `ADBE Mask Parade`: each atom's `mkif` sits BETWEEN its name and its group.
std::vector<AepMask> read_masks(const Chunk* parade, const PropertyContext& ctx) {
  std::vector<AepMask> out;
  if (parade == nullptr) return out;
  for (const GroupMember& member : group_members(*parade)) {
    if (member.value->listType != "tdgp") continue;
    const Chunk* mkif = nullptr;
    for (const Chunk* c : member.between) {
      if (c->id == "mkif") {
        mkif = c;
        break;
      }
    }
    const Reader info = reader_for(mkif);
    AepMask m;
    m.properties = read_group(*member.value, ctx, member.matchName);
    for (const AepProp& c : m.properties.children) {
      if (!c.isGroup && c.shape) {
        m.shape = c.shape;
        break;
      }
    }
    m.name = m.properties.name ? *m.properties.name : "Mask " + std::to_string(out.size() + 1);
    m.mode = mask_mode(info.u16(6));
    m.inverted = info.u8(0) != 0;
    m.locked = info.u8(1) != 0;
    m.color[0] = info.u8(45);
    m.color[1] = info.u8(46);
    m.color[2] = info.u8(47);
    out.push_back(std::move(m));
  }
  return out;
}

struct Size {
  double width = 0;
  double height = 0;
};

struct ReadContext {
  std::vector<std::string> warnings;
  std::map<std::uint32_t, Size> sizes;
};

AepLayer read_layer(const Chunk& layr, std::size_t index, const AepComp& comp, ReadContext& read) {
  const Reader r = reader_for(find_chunk(&layr, "ldta"));
  AepLayer l;
  l.kind = layer_kind(r.u8(131));
  read_layer_flags(r, l);
  const std::string utf8Name = chunk_text(find_chunk(&layr, "Utf8"));
  l.sourceId = r.u32(40);
  const auto src = read.sizes.find(l.sourceId);
  PropertyContext ctx;
  ctx.timebase = comp.internalTimebase;
  ctx.layerWidth = src != read.sizes.end() && src->second.width != 0 ? src->second.width : comp.width;
  ctx.layerHeight = src != read.sizes.end() && src->second.height != 0 ? src->second.height : comp.height;
  ctx.hasSource = src != read.sizes.end();
  ctx.warnings = &read.warnings;

  const Chunk* tdgp = find_list(&layr, "tdgp");
  if (tdgp != nullptr) {
    l.properties = read_group(*tdgp, ctx, "ADBE Layer");
  } else {
    l.properties.isGroup = true;
    l.properties.matchName = "ADBE Layer";
  }
  const Chunk* parade = nullptr;
  if (tdgp != nullptr) {
    for (std::size_t i = 1; i < tdgp->children.size(); ++i) {
      if (tdgp->children[i].listType == "tdgp" && chunk_text(&tdgp->children[i - 1]) == "ADBE Mask Parade") {
        parade = &tdgp->children[i];
        break;
      }
    }
  }
  const std::int32_t stretchDividend = r.i32(8);
  const std::uint32_t stretchDivisor = r.u32(108);
  l.id = r.u32(0);
  l.name = !utf8Name.empty() ? utf8Name : r.str(64, 32);
  l.index = index;
  l.parentId = r.u32(132);
  // Start time, in point, out point: three adjacent, identically shaped rationals.
  l.startTime = ratio(r.i32(12), r.u32(16));
  l.inPoint = ratio(r.i32(20), r.u32(24));
  l.outPoint = ratio(r.i32(28), r.u32(32));
  l.stretch = stretchDivisor == 0 ? 100 : (static_cast<double>(stretchDividend) * 100) / stretchDivisor;
  l.blendingMode = blending_mode(r.u8(99));
  l.trackMatte = track_matte(r.u8(107));
  // AE 23 added an explicit matte-layer id; older files mean "the layer above".
  l.matteLayerId = r.length() >= 164 ? r.u32(160) : 0;
  l.label = r.u8(61);
  if (l.kind == LayerKind::light) l.lightType = r.u8(139);
  l.masks = read_masks(parade, ctx);
  return l;
}

/// `alas` is JSON; `fullpath` is the absolute path AE last resolved.
std::optional<std::string> read_alias_path(const Chunk* pin) {
  const std::string text = chunk_text(find_chunk(find_list(pin, "Als2"), "alas"));
  if (text.empty()) return std::nullopt;
  const std::optional<js::Json> parsed = js::parse(text);
  if (!parsed || !parsed->is_object()) return std::nullopt;
  const js::Json& fp = parsed->at("fullpath");
  if (!fp.is_string() || fp.str().empty()) return std::nullopt;
  return fp.str();
}

std::string trim_nuls(std::string s) {
  while (!s.empty() && s.back() == '\0') s.pop_back();
  return s;
}

void read_footage_into(const Chunk& item, AepFootage& f) {
  const Chunk* pin = find_list(&item, "Pin ");
  // `sspc` — the source's dimensions, timing and audio.
  const Reader s = reader_for(find_chunk(pin, "sspc"));
  f.width = s.u16(32);
  f.height = s.u16(36);
  f.durationSeconds = ratio(s.u32(38), s.u32(42));
  f.frameRate = s.u32(56) + s.u16(60) / 65536.0;
  const double par = ratio(s.u32(136), s.u32(140));
  f.pixelAspect = par != 0 ? par : 1;
  f.missingAtSave = s.u8(115) != 0;
  f.sourceFormat = trim_nuls(s.fourcc(22));
  f.hasAudio = s.f64(160) > 0;
  // `opti` — what KIND of footage (`Soli` a solid; no code + a 2 = a placeholder).
  const Reader o = reader_for(find_chunk(pin, "opti"));
  std::string solidName;
  if (o.length() >= 6) {
    const std::string code = trim_nuls(o.fourcc(0));
    if (code == "Soli") {
      f.footageKind = "solid";
      f.solidColor = AepFootage::Rgb{o.f32(14), o.f32(18), o.f32(22)};
      solidName = o.str(26, 256);
    } else if (code.empty() && o.u16(4) == 2) {
      f.footageKind = "placeholder";
    }
  }
  f.path = read_alias_path(pin);
  // A solid keeps its name in the `opti` rather than in the item's `Utf8`.
  if (f.name.empty()) f.name = solidName;
  // A still has a nominal duration in AE; treating it as real ends a logo partway through.
  f.isStill = f.frameRate == 0 || f.durationSeconds == 0;
}

struct ItemHeader {
  const Chunk* chunk = nullptr;
  ItemKind kind = ItemKind::folder;
  std::uint32_t id = 0;
  std::string name;
  std::uint32_t label = 0;
  std::vector<std::string> folder;
};

void collect_items(const Chunk* list, const std::vector<std::string>& folder, std::vector<ItemHeader>& out) {
  if (list == nullptr) return;
  for (const Chunk& item : list->children) {
    if (item.listType != "Item") continue;
    const Reader idta = reader_for(find_chunk(&item, "idta"));
    const auto kind = item_kind(idta.u16(0));
    if (!kind) continue;
    ItemHeader h;
    h.chunk = &item;
    h.kind = *kind;
    h.id = idta.u32(16);
    h.name = chunk_text(find_chunk(&item, "Utf8"));
    h.label = idta.u8(58);
    h.folder = folder;
    out.push_back(h);
    if (*kind == ItemKind::folder) {
      std::vector<std::string> sub = folder;
      sub.push_back(h.name);
      collect_items(find_list(&item, "Sfdr"), sub, out);
    }
  }
}

/// The AE version from the packed word in `head` (reporting only).
std::optional<std::string> read_ae_version(const Chunk& root) {
  const Chunk* head = find_chunk(&root, "head");
  if (head == nullptr) return std::nullopt;
  const std::uint32_t word = reader_for(head).u32(4);
  const std::uint32_t major = ((word >> 26U) & 0x1fU) * 8U + ((word >> 19U) & 0x07U);
  const std::uint32_t minor = (word >> 15U) & 0x0fU;
  if (major == 0) return std::nullopt;
  return std::to_string(major) + "." + std::to_string(minor);
}

}  // namespace

AepProject read_aep_project(const Chunk& root) {
  AepProject project;
  const Chunk* fold = find_list(&root, "Fold");
  if (fold == nullptr) {
    project.warnings.emplace_back("the project has no item folder — nothing to import");
    return project;
  }
  std::vector<ItemHeader> headers;
  collect_items(fold, {}, headers);
  ReadContext ctx;

  // Pass 1 — footage and composition settings (both can be a layer's source).
  std::map<std::uint32_t, std::size_t> footageIndex;
  std::vector<std::optional<AepComp>> settings(headers.size());
  for (std::size_t i = 0; i < headers.size(); ++i) {
    const ItemHeader& h = headers[i];
    if (h.kind == ItemKind::footage) {
      AepFootage f;
      f.id = h.id;
      f.name = h.name;
      f.label = h.label;
      f.folder = h.folder;
      read_footage_into(*h.chunk, f);
      ctx.sizes.insert_or_assign(h.id, Size{f.width, f.height});
      footageIndex.insert_or_assign(h.id, project.footage.size());
      project.footage.push_back(std::move(f));
    } else if (h.kind == ItemKind::comp) {
      AepComp c = read_comp_settings(find_chunk(h.chunk, "cdta"));
      ctx.sizes.insert_or_assign(h.id, Size{c.width, c.height});
      settings[i] = std::move(c);
    }
  }

  // Pass 2 — layers, now that every source size is known. `Layr` only.
  std::map<std::uint32_t, std::size_t> compIndex;
  for (std::size_t i = 0; i < headers.size(); ++i) {
    const ItemHeader& h = headers[i];
    if (h.kind != ItemKind::comp) continue;
    AepComp c = std::move(*settings[i]);
    c.id = h.id;
    c.name = h.name;
    c.label = h.label;
    c.folder = h.folder;
    const std::vector<const Chunk*> layrs = find_lists(h.chunk, "Layr");
    for (std::size_t k = 0; k < layrs.size(); ++k) c.layers.push_back(read_layer(*layrs[k], k + 1, c, ctx));
    compIndex.insert_or_assign(h.id, project.comps.size());
    project.comps.push_back(std::move(c));
  }

  for (const ItemHeader& h : headers) {
    AepItemRef ref;
    ref.kind = h.kind;
    ref.id = h.id;
    ref.name = h.name;
    ref.folder = h.folder;
    if (h.kind == ItemKind::comp) ref.index = compIndex.at(h.id);
    if (h.kind == ItemKind::footage) ref.index = footageIndex.at(h.id);
    project.items.push_back(std::move(ref));
  }
  project.aeVersion = read_ae_version(root);
  project.warnings = std::move(ctx.warnings);
  return project;
}

}  // namespace premation::doc::aep
