// AE's Import As: Composition – Retain Layer Sizes, for Photoshop files.
//
// A .psd / .psb imported with `createComposition` becomes:
//   • a folder "<file> Layers" with one footage item per raster layer (the
//     layer's own pixels, mask baked in, at its own size — not the canvas);
//   • a composition the size of the canvas, named after the file, with one
//     layer per Photoshop layer, bottom to top as in Photoshop: positioned
//     where it sat, its opacity (× fill), blend mode and visibility kept;
//   • a nested composition per layer group (opacity, blend and visibility on
//     the group's layer; a pass-through group composites as Normal, as AE's
//     import does) and per clipping group (the base layer with the clipped
//     layers above it, Preserve Underlying Transparency on each — which is
//     exactly a clipping mask inside its own composition).
// One undo entry. The file is read through the ports (read_file_bytes).

#include <string>
#include <vector>

#include "handlers_comps.hpp"
#include "handlers_items.hpp"
#include "handlers_layers.hpp"
#include "psd_read.hpp"
#include "values.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

std::string stem_of(const std::string& path) {
  const std::size_t slash = path.find_last_of("/\\");
  std::string name = slash == std::string::npos ? path : path.substr(slash + 1);
  const std::size_t dot = name.find_last_of('.');
  return dot == std::string::npos || dot == 0 ? name : name.substr(0, dot);
}

std::string file_name_of(const std::string& path) {
  const std::size_t slash = path.find_last_of("/\\");
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

api::BlendMode blend_enum(const std::string& name) {
  for (std::uint32_t i = 0; i <= 37; ++i) {
    const auto m = static_cast<api::BlendMode>(i);
    if (api::to_string(m) == name) return m;
  }
  return api::BlendMode::normal;
}

struct Builder {
  HCtx& x;
  std::string fileName;
  std::string folder;
  int width = 0;
  int height = 0;
  int itemCount = 0;

  /// One footage item from a layer's pixels.
  std::string import_layer(const psd::Layer& l) {
    api::ImportBytesFile f;
    f.name = (l.name.empty() ? std::string("Layer") : l.name) + "/" + fileName + ".png";
    if (!psd::encode_png(l.rgba, l.width, l.height, f.data)) fail(ErrorCode::io, "a layer of '" + fileName + "' could not be encoded");
    f.mime_type = "image/png";
    f.folder = folder;
    const auto r = handle(api::ImportBytes{{std::move(f)}}, x);
    ++itemCount;
    return r.items.at(0);
  }

  std::string new_comp(const std::string& name) {
    api::CreateComposition c;
    c.settings.name = name;
    c.settings.width = static_cast<std::uint32_t>(width);
    c.settings.height = static_cast<std::uint32_t>(height);
    c.folder = folder;
    return handle(c, x).item;
  }

  /// Put `layers` (bottom to top) into `comp`, each new layer on top.
  void fill(const std::string& comp, const std::vector<psd::Layer>& layers) {
    for (std::size_t i = 0; i < layers.size(); ++i) {
      const psd::Layer& l = layers[i];
      // A clipping group: this base and the clipped layers right above it.
      std::size_t end = i + 1;
      while (end < layers.size() && layers[end].clipped && !layers[end].isGroup) ++end;
      if (end > i + 1 && !l.isGroup) {
        const std::string nested = new_comp(l.name + " (clipping)");
        std::vector<psd::Layer> group(layers.begin() + static_cast<std::ptrdiff_t>(i), layers.begin() + static_cast<std::ptrdiff_t>(end));
        // Photoshop composites a clipping group with the BASE's opacity and blend
        // mode: those go on the container; inside, the base is plain.
        fill_clipping(nested, group);
        add_precomp(comp, nested, l.name, l.opacity, l.blend, l.visible);
        i = end - 1;
        continue;
      }
      if (l.isGroup) {
        const std::string nested = new_comp(l.name.empty() ? std::string("Group") : l.name);
        fill(nested, l.children);
        add_precomp(comp, nested, l.name, l.opacity, l.blend, l.visible);
        continue;
      }
      add_footage(comp, l, false);
    }
  }

  void fill_clipping(const std::string& comp, std::vector<psd::Layer> group) {
    group[0].opacity = 255;
    group[0].blend = "norm";
    group[0].visible = true;
    for (std::size_t k = 0; k < group.size(); ++k) add_footage(comp, group[k], k > 0);
  }

  void add_footage(const std::string& comp, const psd::Layer& l, bool preserveTransparency) {
    const std::string item = import_layer(l);
    api::CreateLayer c;
    c.comp = comp;
    c.kind = api::LayerKind::image;
    c.name = l.name;
    c.source = item;
    c.index = 0;
    c.init.push_back(api::PropertyInit{"transform/position", v_vec2(l.left + l.width / 2.0, l.top + l.height / 2.0)});
    if (l.opacity < 255) c.init.push_back(api::PropertyInit{"transform/opacity", v_scalar(l.opacity * 100.0 / 255.0)});
    const std::string layer = handle(c, x).layer;
    finish(layer, l.blend, l.visible, preserveTransparency);
  }

  void add_precomp(const std::string& comp, const std::string& nested, const std::string& name, int opacity, const std::string& blend,
                   bool visible) {
    api::CreateLayer c;
    c.comp = comp;
    c.kind = api::LayerKind::precomp;
    c.name = name.empty() ? std::string("Group") : name;
    c.source = nested;
    c.index = 0;
    c.init.push_back(api::PropertyInit{"transform/position", v_vec2(width / 2.0, height / 2.0)});
    if (opacity < 255) c.init.push_back(api::PropertyInit{"transform/opacity", v_scalar(opacity * 100.0 / 255.0)});
    const std::string layer = handle(c, x).layer;
    finish(layer, blend, visible, false);
  }

  void finish(const std::string& layer, const std::string& blend, bool visible, bool preserveTransparency) {
    const api::BlendMode mode = blend_enum(psd::blend_mode_of(blend));
    if (mode != api::BlendMode::normal) (void)handle(api::SetBlendMode{{layer}, mode}, x);
    if (!visible || preserveTransparency) {
      api::SetLayerSwitches s;
      s.layers = {layer};
      if (!visible) s.patch.visible = false;
      if (preserveTransparency) s.patch.preserve_transparency = true;
      (void)handle(s, x);
    }
  }
};

}  // namespace

/// `importFiles` with createComposition for a Photoshop file: [composition, folder, layer items…].
std::vector<std::string> import_psd_composition(const api::ImportFile& f, HCtx& x) {
  if (!x.ports.has_file_bytes()) fail(ErrorCode::unsupported, "this engine cannot read files");
  const std::vector<std::uint8_t> bytes = x.ports.read_file_bytes(f.path);
  std::string error;
  const auto doc = psd::read(bytes, true, error);
  if (!doc) fail(ErrorCode::io, "could not import '" + f.path + "': " + error);
  if (doc->layers.empty()) fail(ErrorCode::invalid_argument, "'" + file_name_of(f.path) + "' has no layers to import — import it as footage");
  Builder b{x, file_name_of(f.path), {}};
  b.width = doc->width;
  b.height = doc->height;
  api::CreateFolder folder;
  folder.name = stem_of(f.path) + " Layers";
  if (f.folder && !f.folder->empty()) folder.parent = f.folder;
  b.folder = handle(folder, x).item;
  api::CreateComposition c;
  c.settings.name = stem_of(f.path);
  c.settings.width = static_cast<std::uint32_t>(doc->width);
  c.settings.height = static_cast<std::uint32_t>(doc->height);
  if (f.folder && !f.folder->empty()) c.folder = f.folder;
  const std::string comp = handle(c, x).item;
  b.fill(comp, doc->layers);
  return {comp, b.folder};
}

}  // namespace premation::doc
