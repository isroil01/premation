#include "anim_json.hpp"

namespace premation::doc {

std::optional<api::Easing> easing_from_string(std::string_view s) {
  if (s == "linear") return api::Easing::linear;
  if (s == "hold") return api::Easing::hold;
  if (s == "bezier") return api::Easing::bezier;
  if (s == "ease") return api::Easing::ease;
  if (s == "easeIn") return api::Easing::ease_in;
  if (s == "easeOut") return api::Easing::ease_out;
  if (s == "easeInOut") return api::Easing::ease_in_out;
  if (s == "step") return api::Easing::step;
  if (s == "autoBezier") return api::Easing::auto_bezier;
  if (s == "continuousBezier") return api::Easing::continuous_bezier;
  return std::nullopt;
}

std::string_view easing_to_string(api::Easing e) {
  switch (e) {
    case api::Easing::linear: return "linear";
    case api::Easing::hold: return "hold";
    case api::Easing::bezier: return "bezier";
    case api::Easing::ease: return "ease";
    case api::Easing::ease_in: return "easeIn";
    case api::Easing::ease_out: return "easeOut";
    case api::Easing::ease_in_out: return "easeInOut";
    case api::Easing::step: return "step";
    case api::Easing::auto_bezier: return "autoBezier";
    case api::Easing::continuous_bezier: return "continuousBezier";
  }
  return "linear";
}

std::optional<api::SpatialInterp> spatial_from_string(std::string_view s) {
  if (s == "linear") return api::SpatialInterp::linear;
  if (s == "bezier") return api::SpatialInterp::bezier;
  if (s == "continuous") return api::SpatialInterp::continuous;
  if (s == "auto") return api::SpatialInterp::auto_;
  return std::nullopt;
}

std::string_view spatial_to_string(api::SpatialInterp s) {
  switch (s) {
    case api::SpatialInterp::legacy: return "legacy";
    case api::SpatialInterp::linear: return "linear";
    case api::SpatialInterp::bezier: return "bezier";
    case api::SpatialInterp::continuous: return "continuous";
    case api::SpatialInterp::auto_: return "auto";
  }
  return "legacy";
}

namespace {

Json bezier_json(const std::array<double, 4>& b) {
  Json a = Json::array();
  for (const double v : b) a.arr_mut().push_back(Json::number(v));
  return a;
}

std::optional<std::array<double, 4>> bezier_of(const Json& j) {
  if (!j.is_array() || j.arr().size() < 4) return std::nullopt;
  return std::array<double, 4>{j.arr()[0].num(), j.arr()[1].num(), j.arr()[2].num(), j.arr()[3].num()};
}

}  // namespace

Json key_to_json(const Key& k) {
  Json o = Json::object();
  o.set("t", Json::number(k.t));
  o.set("value", Json::number(k.value));
  if (k.id) o.set("id", Json::string(*k.id));
  if (k.easing) o.set("easing", Json::string(std::string(easing_to_string(*k.easing))));
  if (k.bezier) o.set("bezier", bezier_json(*k.bezier));
  if (k.continuous) o.set("continuous", Json::boolean(*k.continuous));
  if (k.roving) o.set("roving", Json::boolean(*k.roving));
  if (k.spatial) o.set("spatialInterp", Json::string(std::string(spatial_to_string(*k.spatial))));
  if (k.si) o.set("si", Json::number(*k.si));
  if (k.so) o.set("so", Json::number(*k.so));
  if (k.label) o.set("label", Json::number(*k.label));
  return o;
}

std::optional<Key> key_from_json(const Json& j) {
  if (!j.is_object() || !j.at("t").is_number() || !j.at("value").is_number()) return std::nullopt;
  Key k;
  k.t = j.at("t").num();
  k.value = j.at("value").num();
  if (j.at("id").is_string()) k.id = j.at("id").str();
  if (j.at("easing").is_string()) k.easing = easing_from_string(j.at("easing").str());
  k.bezier = bezier_of(j.at("bezier"));
  if (j.at("continuous").is_bool()) k.continuous = j.at("continuous").b();
  if (j.at("roving").is_bool()) k.roving = j.at("roving").b();
  if (j.at("spatialInterp").is_string()) k.spatial = spatial_from_string(j.at("spatialInterp").str());
  if (j.at("si").is_number()) k.si = j.at("si").num();
  if (j.at("so").is_number()) k.so = j.at("so").num();
  if (j.at("label").is_number()) k.label = j.at("label").num();
  return k;
}

Json data_key_to_json(const DataKey& k) {
  Json o = Json::object();
  o.set("t", Json::number(k.t));
  o.set("value", k.value);
  if (k.easing) o.set("easing", Json::string(std::string(easing_to_string(*k.easing))));
  if (k.bezier) o.set("bezier", bezier_json(*k.bezier));
  if (k.id) o.set("id", Json::string(*k.id));
  if (k.label) o.set("label", Json::number(*k.label));
  if (k.so) o.set("so", *k.so);
  if (k.si) o.set("si", *k.si);
  return o;
}

std::optional<DataKey> data_key_from_json(const Json& j) {
  if (!j.is_object() || !j.at("t").is_number()) return std::nullopt;
  DataKey k;
  k.t = j.at("t").num();
  k.value = j.at("value");
  if (j.at("easing").is_string()) k.easing = easing_from_string(j.at("easing").str());
  k.bezier = bezier_of(j.at("bezier"));
  if (j.at("id").is_string()) k.id = j.at("id").str();
  if (j.at("label").is_number()) k.label = j.at("label").num();
  if (!j.at("so").is_undefined()) k.so = j.at("so");
  if (!j.at("si").is_undefined()) k.si = j.at("si");
  return k;
}

Json anim_to_json(const NodeAnim& a, std::string_view nodeId) {
  Json tracks = Json::object();
  for (const auto& [prop, keys] : a.tracks) {
    Json list = Json::array();
    for (const Key& k : keys) list.arr_mut().push_back(key_to_json(k));
    tracks.set(prop, std::move(list));
  }
  Json exprs = Json::object();
  for (const auto& [prop, e] : a.exprs) {
    Json o = Json::object();
    o.set("src", Json::string(e.src));
    o.set("enabled", Json::boolean(e.enabled));
    exprs.set(prop, std::move(o));
  }
  Json data = Json::object();
  for (const auto& [prop, t] : a.data) {
    Json o = Json::object();
    o.set("nodeId", Json::string(std::string(nodeId)));
    o.set("prop", Json::string(prop));
    o.set("kind", Json::string(t.kind));
    Json list = Json::array();
    for (const DataKey& k : t.keys) list.arr_mut().push_back(data_key_to_json(k));
    o.set("keyframes", std::move(list));
    data.set(prop, std::move(o));
  }
  Json out = Json::object();
  out.set("tracks", std::move(tracks));
  out.set("expressions", std::move(exprs));
  out.set("data", std::move(data));
  return out;
}

NodeAnim anim_from_json(const Json& snap) {
  NodeAnim a;
  if (snap.at("tracks").is_object()) {
    for (const auto& m : snap.at("tracks").obj()) {
      // A track is either a Keyframe[] (snapshotNode) or {keyframes: Keyframe[]} (snapshot()).
      const Json& list = m.value.is_array() ? m.value : m.value.at("keyframes");
      if (!list.is_array()) continue;
      std::vector<Key> keys;
      for (const Json& k : list.arr()) {
        if (auto key = key_from_json(k)) keys.push_back(std::move(*key));
      }
      if (!keys.empty()) a.tracks.set(m.key, std::move(keys));
    }
  }
  if (snap.at("expressions").is_object()) {
    for (const auto& m : snap.at("expressions").obj()) {
      if (!m.value.is_object() || !m.value.at("src").is_string()) continue;
      ExprState e;
      e.src = m.value.at("src").str();
      e.enabled = !(m.value.at("enabled").is_bool() && !m.value.at("enabled").b());
      a.exprs.set(m.key, std::move(e));
    }
  }
  if (snap.at("data").is_object()) {
    for (const auto& m : snap.at("data").obj()) {
      if (!m.value.is_object()) continue;
      DataTrack t;
      t.kind = m.value.at("kind").is_string() ? m.value.at("kind").str() : "number";
      if (m.value.at("keyframes").is_array()) {
        for (const Json& k : m.value.at("keyframes").arr()) {
          if (auto key = data_key_from_json(k)) t.keys.push_back(std::move(*key));
        }
      }
      if (!t.keys.empty()) a.data.set(m.key, std::move(t));
    }
  }
  return a;
}

}  // namespace premation::doc
