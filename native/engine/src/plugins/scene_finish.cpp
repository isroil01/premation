#include "scene_finish.hpp"

#include <cmath>
#include <functional>
#include <map>
#include <set>

#include "fx_wire.hpp"
#include "host.hpp"
#include "native_effects.hpp"
#include "snapshot_build.hpp"

namespace premation::plugins {
namespace {

constexpr double kFlicks = PR_TIME_SCALE;

api::RenderEffectParam& param(api::RenderEffect& e, std::string_view name, api::RenderParamKind kind) {
  for (auto& p : e.params) {
    if (p.name == name) {
      p.kind = kind;
      return p;
    }
  }
  api::RenderEffectParam p;
  p.name = std::string(name);
  p.kind = kind;
  e.params.push_back(std::move(p));
  return e.params.back();
}

void set_num(api::RenderEffect& e, std::string_view name, double v) { param(e, name, api::RenderParamKind::number).number = v; }
void set_text(api::RenderEffect& e, std::string_view name, std::string v) {
  param(e, name, api::RenderParamKind::text).text = std::move(v);
}

std::string text_of(const api::RenderEffect& e, std::string_view name) {
  for (const auto& p : e.params) {
    if (p.name == name) return p.text;
  }
  return {};
}

using List = std::vector<api::Renderable>;

void visit(List& list, const std::function<void(api::Renderable&, List&)>& fn) {
  for (std::size_t i = 0; i < list.size(); ++i) {
    fn(list[i], list);
    visit(list[i].precomp_children, fn);
  }
}

const api::Renderable* find_renderable(const List& list, std::string_view id) {
  for (const auto& r : list) {
    if (r.id == id) return &r;
    if (const api::Renderable* c = find_renderable(r.precomp_children, id)) return c;
  }
  return nullptr;
}

void rename_keys(api::Renderable& r, const std::string& suffix, std::map<std::string, std::string>& renamed) {
  const auto rename = [&](std::optional<std::string>& k) {
    if (!k || k->empty()) return;
    const std::string next = *k + suffix;
    renamed.emplace(*k, next);
    k = next;
  };
  rename(r.texture_key);
  rename(r.mask_texture_key);
  rename(r.lut_texture_key);
  if (r.adjustment) rename(r.adjustment->lut_texture_key);
  if (r.generator) rename(r.generator->texture_key);
  for (auto& c : r.precomp_children) rename_keys(c, suffix, renamed);
}

struct Want {
  std::string layer;
  std::int64_t time = 0;
  const List* list = nullptr;
};

/// Post-order: a nested list gets its additions before its parent list can reallocate.
void apply_additions(List& list, std::map<const List*, List>& additions) {
  for (auto& r : list) apply_additions(r.precomp_children, additions);
  const auto it = additions.find(&list);
  if (it == additions.end()) return;
  for (auto& r : it->second) list.push_back(std::move(r));
  additions.erase(it);
}

}  // namespace

void finish_native_frame(const scene::BuildContext& c, std::string_view comp, double t, const scene::ViewSpec& view,
                         bool motionBlur, scene::NativeFrame& frame, PluginHost* host) {
  const auto tf = static_cast<std::int64_t>(std::llround(t * kFlicks));
  double fps = scene::motion_blur_of(c.d, comp).fps;
  if (!(fps > 0)) fps = 30;
  const auto step = static_cast<std::int64_t>(std::llround(kFlicks / fps));
  const auto worldW = static_cast<std::int32_t>(std::floor(view.cssWidth * view.dpr + 0.5));
  const auto worldH = static_cast<std::int32_t>(std::floor(view.cssHeight * view.dpr + 0.5));
  std::vector<Want> wants;
  std::set<std::string> reported;

  visit(frame.file.scene.renderables, [&](api::Renderable& r, List& list) {
    for (api::RenderEffect& e : r.effects) {
      if (e.type != kNativeFxType) continue;
      const std::string layerId = text_of(e, "layerId");
      const std::string instance = text_of(e, "instance");
      const std::string matchName = text_of(e, "matchName");
      const std::size_t slash = instance.rfind('/');
      const std::string effectId = slash == std::string::npos ? std::string() : instance.substr(slash + 1);
      set_num(e, "compTime", static_cast<double>(tf));
      set_num(e, "layerTime", static_cast<double>(tf));
      set_num(e, "timeStep", static_cast<double>(step));
      set_num(e, "fps", fps);
      // The instance's state, from the document (fx.pluginData, base64 as stored).
      if (const doc::Node* n = c.d.node(layerId)) {
        const js::Json& group = n->fx().at("pluginData").at(doc::native_data_group(effectId));
        const js::Json& seq = group.at(doc::kNativeSequenceKey);
        if (seq.is_string()) set_text(e, "sequence", seq.str());
        if (const doc::NativeEffect* ne = doc::NativeEffects::find(matchName)) {
          for (const std::string& key : ne->arbitrary) {
            const js::Json& a = group.at(doc::native_arb_key(key));
            if (a.is_string()) set_text(e, "a." + key, a.str());
          }
        }
      }
      if (host == nullptr) continue;
      if (std::string why; host->instance_disabled(instance, &why)) {
        if (reported.insert(instance).second) frame.errors.push_back(scene::LayerError{layerId, "", "plugin", why});
        continue;
      }
      const EffectSpec* spec = host->effect(matchName);
      if (spec == nullptr) {
        if (reported.insert(instance).second) {
          frame.errors.push_back(scene::LayerError{layerId, "", "plugin", "no loaded plugin provides '" + matchName + "'"});
        }
        continue;
      }
      if (!spec->has(PR_OUT_FLAG_WIDE_TIME_INPUT)) continue;
      RenderInputs in;
      decode_native_fx(e, *spec, in);
      in.worldW = worldW;
      in.worldH = worldH;
      std::vector<CheckoutRequest> reqs;
      const CallResult pr = host->pre_render(in, reqs);
      if (!pr.ok) {
        if (reported.insert(instance).second) frame.errors.push_back(scene::LayerError{layerId, "", "plugin", pr.message});
        continue;
      }
      for (const CheckoutRequest& q : reqs) {
        if (q.time == in.layerTime) continue;  // "now" is the chain's own input / a live layer
        std::string layer = q.paramIndex == 0 ? layerId : q.paramIndex - 1 < in.values.size() ? in.values[q.paramIndex - 1].layer : "";
        if (!layer.empty()) wants.push_back({std::move(layer), q.time, &list});
      }
    }
  });

  if (wants.empty()) return;
  std::map<std::int64_t, scene::NativeFrame> atTime;
  std::map<const List*, List> additions;
  std::set<std::pair<const List*, std::string>> added;
  for (const Want& w : wants) {
    const std::string id = checkout_renderable_id(w.layer, w.time);
    if (!added.insert({w.list, id}).second || find_renderable(*w.list, id) != nullptr) continue;
    auto it = atTime.find(w.time);
    if (it == atTime.end()) {
      scene::NativeFrame other = scene::build_native_frame(c, comp, static_cast<double>(w.time) / kFlicks, view, motionBlur);
      it = atTime.emplace(w.time, std::move(other)).first;
    }
    const scene::NativeFrame& other = it->second;
    const api::Renderable* src = find_renderable(other.file.scene.renderables, w.layer);
    if (src == nullptr) continue;  // the layer does not exist / is not drawn at that time: an empty checkout
    api::Renderable copy = *src;
    copy.id = id;
    copy.matte_source = true;  // never drawn by the composition; checked out by id
    copy.effects.clear();      // a checkout is the layer's source pixels (see PLUGIN_SDK.md)
    copy.matte.reset();
    copy.adjustment.reset();
    std::map<std::string, std::string> renamed;
    rename_keys(copy, "@" + std::to_string(w.time), renamed);
    for (const scene::TextureRequest& req : other.textures) {
      const auto k = renamed.find(req.key);
      if (k == renamed.end()) continue;
      scene::TextureRequest moved = req;
      moved.key = k->second;
      frame.textures.push_back(std::move(moved));
    }
    additions[w.list].push_back(std::move(copy));
  }
  apply_additions(frame.file.scene.renderables, additions);
}

}  // namespace premation::plugins
