// Character rig, Tier 1 (docs/CHARACTER_RIG.md): bindToBone and createCharacter.
//
// A character is a group layer with a skeleton (fx.skeleton); its parts are the
// group's children, each following one bone through fx.parentBone (bone_link.hpp).
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <limits>
#include <map>
#include <numbers>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "bone_link.hpp"
#include "fail.hpp"
#include "handlers_layers.hpp"
#include "layer_geometry.hpp"
#include "parenting.hpp"
#include "scene.hpp"
#include "timeline.hpp"
#include "worldxf.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

namespace xf = motion::xf;

// ── Anatomy tags from layer names ────────────────────────────────────────────

enum class Part { other, torso, neck, head, upperArm, forearm, arm, hand, thigh, shin, leg, foot, tail };
enum class Side { none, left, right };

/// "Left Upper-Arm", "armL", "arm_l", "L_hand" → lower-case words: left, upper, arm / arm, l / l, hand.
std::vector<std::string> words_of(const std::string& name) {
  std::vector<std::string> out;
  std::string cur;
  const auto flush = [&] {
    if (!cur.empty()) out.push_back(cur);
    cur.clear();
  };
  for (std::size_t i = 0; i < name.size(); ++i) {
    const auto c = static_cast<unsigned char>(name[i]);
    if (std::isalnum(c) == 0) {
      flush();
      continue;
    }
    // camelCase boundary: armL → arm | L, upperArm → upper | Arm
    if (std::isupper(c) != 0 && i > 0 && std::islower(static_cast<unsigned char>(name[i - 1])) != 0) flush();
    cur.push_back(static_cast<char>(std::tolower(c)));
  }
  flush();
  return out;
}

struct Tag {
  Part part = Part::other;
  Side side = Side::none;
};

Tag tag_of(const std::string& name) {
  const std::vector<std::string> w = words_of(name);
  const auto has = [&w](std::string_view s) { return std::ranges::find(w, s) != w.end(); };
  const auto any = [&has](std::initializer_list<std::string_view> l) { return std::ranges::any_of(l, has); };
  Tag t;
  if (any({"left", "l", "lft"})) t.side = Side::left;
  else if (any({"right", "r", "rgt", "rt"})) t.side = Side::right;
  const bool lower = any({"lower", "low", "fore"});
  const bool upper = any({"upper", "up", "top"});
  if (any({"hand", "hands", "fist", "palm", "glove"})) t.part = Part::hand;
  else if (any({"forearm", "lowerarm"}) || (lower && has("arm"))) t.part = Part::forearm;
  else if (any({"upperarm", "bicep", "biceps"}) || (upper && has("arm"))) t.part = Part::upperArm;
  else if (any({"arm", "arms", "sleeve"})) t.part = Part::arm;
  else if (any({"foot", "feet", "shoe", "boot", "toe", "toes"})) t.part = Part::foot;
  else if (any({"shin", "calf", "lowerleg"}) || (lower && has("leg"))) t.part = Part::shin;
  else if (any({"thigh", "upperleg"}) || (upper && has("leg"))) t.part = Part::thigh;
  else if (any({"leg", "legs", "pant", "pants"})) t.part = Part::leg;
  else if (any({"head", "face", "skull"})) t.part = Part::head;
  else if (has("neck")) t.part = Part::neck;
  else if (any({"torso", "body", "chest", "hip", "hips", "pelvis", "belly", "spine", "trunk", "shirt"})) t.part = Part::torso;
  else if (has("tail")) t.part = Part::tail;
  return t;
}

// ── Parts as boxes in the character's space ──────────────────────────────────

struct V {
  double x = 0, y = 0;
};
V operator+(V a, V b) { return {a.x + b.x, a.y + b.y}; }
V operator-(V a, V b) { return {a.x - b.x, a.y - b.y}; }
V operator*(V a, double s) { return {a.x * s, a.y * s}; }
double len(V a) { return std::hypot(a.x, a.y); }
V apply(const xf::Mat2D& m, V p) { return {m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f}; }

struct PartBox {
  std::string id;
  std::string name;
  Tag tag;
  V pivot;   ///< the layer's origin (its rotation pivot) in the character's space
  V centre;  ///< the box centre
  V axis;    ///< unit vector along the longer side
  double half = 0;  ///< half the longer side
  double area = 0;
  std::array<V, 4> corners{};
  // the result
  std::optional<std::size_t> parent;
  V base, tip;
  std::string bone;
};

bool contains(const PartBox& p, V q) {
  // A convex quad: q is inside when it is on the same side of every edge.
  int sign = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    const V a = p.corners[i];
    const V b = p.corners[(i + 1) % 4];
    const double cr = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
    const int s = cr > 1e-9 ? 1 : cr < -1e-9 ? -1 : 0;
    if (s == 0) continue;
    if (sign == 0) sign = s;
    else if (s != sign) return false;
  }
  return true;
}

/// How far `q` is from the part's box (0 inside).
double distance_to(const PartBox& p, V q) {
  if (contains(p, q)) return 0;
  double best = std::numeric_limits<double>::infinity();
  for (std::size_t i = 0; i < 4; ++i) {
    const V a = p.corners[i];
    const V ab = p.corners[(i + 1) % 4] - a;
    const double l2 = ab.x * ab.x + ab.y * ab.y;
    const double s = l2 > 0 ? std::clamp(((q.x - a.x) * ab.x + (q.y - a.y) * ab.y) / l2, 0.0, 1.0) : 0;
    best = std::min(best, len(q - (a + ab * s)));
  }
  return best;
}

PartBox measure(const HCtx& x, const std::string& id) {
  PartBox p;
  const Node& n = *x.d.node(id);
  p.id = id;
  p.name = n.name;
  p.tag = tag_of(n.name);
  const double t = x.view.tabTime;
  const SpaceCtx sc{x.d, x.view, x.expr, x.cache};
  std::optional<LayerGeometry> g;
  try {
    g = layer_geometry_at(sc, nullptr, id, t);
  } catch (const EngineFail&) {
    g = std::nullopt;  // text: no measurer in a command — a 100 px box at the layer's origin
  }
  const double w = g ? g->width : 100;
  const double h = g ? g->height : 100;
  const double ox = g ? g->offsetX : 0;
  const double oy = g ? g->offsetY : 0;
  const xf::Local2D local = local_transform_at(x.pc(), id, t).value_or(base_local(n));
  const xf::Mat2D m = xf::local_matrix(local);
  p.pivot = apply(m, {0, 0});
  p.corners = {apply(m, {ox - w / 2, oy - h / 2}), apply(m, {ox + w / 2, oy - h / 2}), apply(m, {ox + w / 2, oy + h / 2}),
               apply(m, {ox - w / 2, oy + h / 2})};
  p.centre = (p.corners[0] + p.corners[2]) * 0.5;
  const V across = (p.corners[1] - p.corners[0]) * 0.5;
  const V down = (p.corners[3] - p.corners[0]) * 0.5;
  const bool wide = len(across) >= len(down);
  const V half = wide ? across : down;
  p.half = len(half);
  p.axis = p.half > 1e-9 ? half * (1 / p.half) : V{0, 1};
  p.area = 4 * len(across) * len(down);
  return p;
}

/// The tag parent of `p` among `parts` (same side preferred), or nullopt.
std::optional<std::size_t> tag_parent(const std::vector<PartBox>& parts, std::size_t self) {
  const Tag t = parts[self].tag;
  const auto find = [&](std::initializer_list<Part> want, bool sameSide) -> std::optional<std::size_t> {
    for (const Part w : want) {
      std::optional<std::size_t> best;
      for (std::size_t i = 0; i < parts.size(); ++i) {
        if (i == self || parts[i].tag.part != w) continue;
        if (sameSide && t.side != Side::none && parts[i].tag.side != Side::none && parts[i].tag.side != t.side) continue;
        if (!best || parts[i].area > parts[*best].area) best = i;
      }
      if (best) return best;
    }
    return std::nullopt;
  };
  switch (t.part) {
    case Part::head: return find({Part::neck, Part::torso}, false);
    case Part::neck:
    case Part::upperArm:
    case Part::arm:
    case Part::thigh:
    case Part::tail: return find({Part::torso}, false);
    case Part::leg: {
      // Two `leg` parts on one side: the lower hangs from the upper.
      for (std::size_t i = 0; i < parts.size(); ++i) {
        if (i != self && parts[i].tag.part == Part::leg && parts[i].tag.side == t.side && parts[i].centre.y < parts[self].centre.y &&
            std::abs(parts[i].centre.x - parts[self].centre.x) < parts[i].half + parts[self].half) {
          return i;
        }
      }
      return find({Part::torso}, false);
    }
    case Part::forearm: return find({Part::upperArm, Part::arm}, true);
    case Part::hand: return find({Part::forearm, Part::upperArm, Part::arm}, true);
    case Part::shin: return find({Part::thigh, Part::leg}, true);
    case Part::foot: return find({Part::shin, Part::leg, Part::thigh}, true);
    case Part::torso:
    case Part::other: break;
  }
  return std::nullopt;
}

/// A bone's world matrix from its base and tip (rotation only, unit scale).
xf::Mat2D bone_world(V base, V tip) {
  const double a = std::atan2(tip.y - base.y, tip.x - base.x);
  return {std::cos(a), std::sin(a), -std::sin(a), std::cos(a), base.x, base.y};
}

std::string side_word(Side s) { return s == Side::left ? "left" : s == Side::right ? "right" : "centre"; }

}  // namespace

void release_bone_parts(const PCtx& c, const std::string& group, const std::string& bone) {
  const Node* g = c.d.node(group);
  const js::Json* skel = g != nullptr ? character_skeleton(*g) : nullptr;
  if (skel == nullptr) return;
  // The bone and every bone under it (removing a bone removes its subtree).
  std::set<std::string> gone{bone};
  for (bool grew = true; grew;) {
    grew = false;
    for (const js::Json& b : skel->at("bones").arr()) {
      if (b.at("id").is_string() && b.at("parentId").is_string() && gone.contains(b.at("parentId").str()) &&
          gone.insert(b.at("id").str()).second) {
        grew = true;
      }
    }
  }
  for (const std::string& part : sg_child_order(c.d, group)) {
    const Node* p = c.d.node(part);
    const std::string* bound = p != nullptr ? bound_bone(c.d, *p) : nullptr;
    if (bound != nullptr && (bone.empty() || gone.contains(*bound))) bind_to_bone_preserving_world(c, part, group, std::nullopt);
  }
}

ResultOf<api::BindToBone> handle(const api::BindToBone& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  const Node& group = require_layer(d, c.character);
  if (comp_of_layer(d, c.character) != comp) {
    fail(ErrorCode::invalid_argument, "the character and its parts must be in the same composition", {.layer = c.character});
  }
  const js::Json* skel = character_skeleton(group);
  if (skel == nullptr) fail(ErrorCode::invalid_argument, "'" + c.character + "' is not a character (a group with bones)", {.layer = c.character});
  if (c.bone) {
    const bool known = std::ranges::any_of(skel->at("bones").arr(), [&c](const js::Json& b) {
      return b.at("id").is_string() && b.at("id").str() == *c.bone;
    });
    if (!known) fail(ErrorCode::not_found, "the character has no bone '" + *c.bone + "'", {.layer = c.character});
  }
  for (const auto& id : c.layers) {
    if (id == c.character || !can_reparent(d, id, c.character)) {
      fail(ErrorCode::cycle, "'" + id + "' cannot be a part of '" + c.character + "'", {.layer = id});
    }
  }
  x.label = c.bone ? "Bind to Bone" : "Detach from Bone";
  const PCtx pc = x.pc();
  const std::string groupId = c.character;
  for (const auto& id : c.layers) bind_to_bone_preserving_world(pc, id, groupId, c.bone);
  tl_sync_from_scene(d, comp);
  return {};
}

ResultOf<api::CreateCharacter> handle(const api::CreateCharacter& c, HCtx& x) {
  if (c.layers.empty()) fail(ErrorCode::invalid_argument, "Rig Character needs at least one layer");
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  for (const auto& id : c.layers) {
    if (d.node(id)->kind() == "camera" || d.node(id)->kind() == "light" || d.node(id)->kind() == "audio") {
      fail(ErrorCode::invalid_argument, "a camera, light or audio layer cannot be a part of a character", {.layer = id});
    }
  }
  api::GroupLayers g;
  g.layers = c.layers;
  g.name = c.name.empty() ? std::string("Character") : c.name;
  const std::string groupId = handle(g, x).layer;
  x.label = "Rig Character";

  // Measure every part in the character's space (the group's child space, where the bones live).
  std::vector<PartBox> parts;
  for (const auto& id : sg_child_order(d, groupId)) parts.push_back(measure(x, id));
  if (parts.empty()) return api::LayerRef{groupId};

  // The root: a tagged torso, else the largest part.
  std::size_t root = 0;
  for (std::size_t i = 0; i < parts.size(); ++i) {
    const bool torso = parts[i].tag.part == Part::torso;
    const bool rootTorso = parts[root].tag.part == Part::torso;
    if ((torso && !rootTorso) || (torso == rootTorso && parts[i].area > parts[root].area)) root = i;
  }
  // Parents: the anatomy first, then the largest part whose box holds the joint, else the root.
  for (std::size_t i = 0; i < parts.size(); ++i) {
    if (i == root) continue;
    std::optional<std::size_t> p = tag_parent(parts, i);
    if (p && *p != root && parts[*p].parent == i) p = std::nullopt;  // two parts naming each other
    if (!p) {
      const PartBox& me = parts[i];
      const bool pivoted = len(me.pivot - me.centre) > 0.15 * me.half;
      const std::array<V, 3> joints{me.pivot, me.centre - me.axis * me.half, me.centre + me.axis * me.half};
      for (std::size_t k = pivoted ? 0 : 1; k < joints.size() && !p; ++k) {
        for (std::size_t j = 0; j < parts.size(); ++j) {
          if (j == i || !contains(parts[j], joints[k])) continue;
          if (parts[j].area < me.area) continue;  // a joint hangs a smaller part from a bigger one
          if (!p || parts[j].area > parts[*p].area) p = j;
        }
      }
    }
    parts[i].parent = p.value_or(root);
  }
  // Break any cycle the geometry made: walk up from each part; a part that meets itself hangs from the root.
  for (std::size_t i = 0; i < parts.size(); ++i) {
    std::set<std::size_t> seen{i};
    for (std::optional<std::size_t> at = parts[i].parent; at && *at != root; at = parts[*at].parent) {
      if (!seen.insert(*at).second) {
        parts[i].parent = root;
        break;
      }
    }
  }

  // Bones: from the joint along the part's long side to its far end.
  for (std::size_t i = 0; i < parts.size(); ++i) {
    PartBox& me = parts[i];
    const V endA = me.centre - me.axis * me.half;
    const V endB = me.centre + me.axis * me.half;
    if (len(me.pivot - me.centre) > 0.15 * me.half) {
      me.base = me.pivot;  // a moved anchor IS the joint
      me.tip = me.centre + (me.centre - me.pivot);
    } else if (me.tag.part == Part::head || me.tag.part == Part::neck) {
      // A head / neck stands on its bottom edge whatever its proportions (a round head has no long side).
      const V down = (me.corners[3] - me.corners[0]) * 0.5;
      const bool flipped = down.y < 0;
      me.base = flipped ? me.centre - down : me.centre + down;
      me.tip = flipped ? me.centre + down : me.centre - down;
    } else if (i == root) {
      // The root grows up from its lower end (a torso from the hips).
      const bool aLower = endA.y >= endB.y;
      me.base = aLower ? endA : endB;
      me.tip = aLower ? endB : endA;
    } else {
      // Upright artwork: a limb hangs from its top end, a head / neck stands on its bottom one. Otherwise (a
      // T-pose arm, a foot, a tail, an untagged part) the joint is the end nearer the parent's box.
      const Part t = me.tag.part;
      const bool upright = std::abs(me.axis.y) > std::abs(me.axis.x);
      const bool hangs = t == Part::upperArm || t == Part::forearm || t == Part::arm || t == Part::hand || t == Part::thigh ||
                         t == Part::shin || t == Part::leg || t == Part::foot;
      bool aJoint = false;
      if (upright && hangs) {
        aJoint = endA.y <= endB.y;
      } else if (upright && (t == Part::head || t == Part::neck)) {
        aJoint = endA.y >= endB.y;
      } else {
        const PartBox& p = parts[*me.parent];
        const double da = distance_to(p, endA);
        const double db = distance_to(p, endB);
        aJoint = da != db ? da < db : len(endA - p.centre) <= len(endB - p.centre);
      }
      me.base = aJoint ? endA : endB;
      me.tip = aJoint ? endB : endA;
    }
    if (len(me.tip - me.base) < 1) me.tip = me.base + V{0, 1};
  }

  // Ids and names, unique within the skeleton.
  std::set<std::string> taken;
  for (PartBox& p : parts) {
    std::string base = "bone";
    for (const std::string& w : words_of(p.name)) base += "_" + w;
    std::string id = base;
    for (int k = 2; taken.contains(id); ++k) id = base + "_" + std::to_string(k);
    taken.insert(id);
    p.bone = id;
  }

  // Parent-relative bone transforms (the skeleton's x, y, rotation in radians).
  js::Json::Array bones;
  js::Json::Array bind;
  std::vector<std::size_t> order;  // parents first
  {
    std::set<std::size_t> placed;
    while (order.size() < parts.size()) {
      const std::size_t before = order.size();
      for (std::size_t i = 0; i < parts.size(); ++i) {
        if (placed.contains(i)) continue;
        if (i == root || placed.contains(*parts[i].parent)) {
          order.push_back(i);
          placed.insert(i);
        }
      }
      if (order.size() == before) {
        // Whatever still waits sits on a parent cycle the walk above missed: hang it from the root.
        for (std::size_t i = 0; i < parts.size(); ++i) {
          if (!placed.contains(i)) parts[i].parent = root;
        }
      }
    }
  }
  for (const std::size_t i : order) {
    const PartBox& p = parts[i];
    xf::Mat2D local = bone_world(p.base, p.tip);
    if (i != root) local = xf::multiply(xf::invert(bone_world(parts[*p.parent].base, parts[*p.parent].tip)), local);
    const double rotation = std::atan2(local.b, local.a);
    js::Json b = js::Json::object();
    b.set("id", js::Json::string(p.bone));
    b.set("name", js::Json::string(p.name));
    b.set("parentId", i == root ? js::Json::null() : js::Json::string(parts[*p.parent].bone));
    b.set("length", js::Json::number(len(p.tip - p.base)));
    b.set("x", js::Json::number(local.e));
    b.set("y", js::Json::number(local.f));
    b.set("rotation", js::Json::number(rotation));
    js::Json r = js::Json::object();
    r.set("id", js::Json::string(p.bone));
    r.set("x", js::Json::number(local.e));
    r.set("y", js::Json::number(local.f));
    r.set("rotation", js::Json::number(rotation));
    bones.push_back(std::move(b));
    bind.push_back(std::move(r));
  }

  // IK: a two-bone leg (a shin / lower leg under a thigh / upper leg) gets a goal at its tip. Controllers on every
  // limb end and the head, sided for Mirror Pose.
  js::Json::Array ik;
  js::Json::Array controllers;
  const auto isLegTop = [&parts](std::size_t i) { return parts[i].tag.part == Part::thigh || parts[i].tag.part == Part::leg; };
  const auto isLegBottom = [&](std::size_t i) {
    const Part t = parts[i].tag.part;
    return parts[i].parent && (t == Part::shin || t == Part::leg) && isLegTop(*parts[i].parent);
  };
  const auto addController = [&](const PartBox& p, std::string_view kind, std::string_view shape) {
    js::Json ctl = js::Json::object();
    ctl.set("id", js::Json::string("ctrl_" + (p.bone.size() > 5 ? p.bone.substr(5) : p.bone)));
    ctl.set("name", js::Json::string(p.name));
    ctl.set("shape", js::Json::string(std::string(shape)));
    ctl.set("side", js::Json::string(side_word(p.tag.side)));
    ctl.set("size", js::Json::number(16));
    js::Json link = js::Json::object();
    link.set("kind", js::Json::string(std::string(kind)));
    link.set("boneId", js::Json::string(p.bone));
    ctl.set("link", std::move(link));
    controllers.push_back(std::move(ctl));
  };
  for (std::size_t i = 0; i < parts.size(); ++i) {
    const PartBox& p = parts[i];
    if (isLegBottom(i)) {
      js::Json goal = js::Json::object();
      goal.set("boneId", js::Json::string(p.bone));
      goal.set("x", js::Json::number(p.tip.x));
      goal.set("y", js::Json::number(p.tip.y));
      goal.set("chainLength", js::Json::number(2));
      goal.set("enabled", js::Json::boolean(true));
      goal.set("ikMode", js::Json::string("ik"));
      ik.push_back(std::move(goal));
      addController(p, "ikTarget", "circle");
    } else if (p.tag.part == Part::hand || p.tag.part == Part::head || p.tag.part == Part::foot ||
               (p.tag.part == Part::forearm && std::ranges::none_of(parts, [&](const PartBox& q) {
                  return q.parent && *q.parent == i;
                }))) {
      addController(p, "bone", p.tag.part == Part::head ? "square" : "circle");
    }
  }
  if (!parts.empty()) addController(parts[root], "bone", "square");

  js::Json skeleton = js::Json::object();
  skeleton.set("bones", js::Json::array(std::move(bones)));
  skeleton.set("bindPose", js::Json::array(std::move(bind)));
  skeleton.set("ikTargets", js::Json::array(std::move(ik)));
  skeleton.set("controllers", js::Json::array(std::move(controllers)));
  sg_set_fx(d, groupId, "skeleton", std::move(skeleton));
  // At the bind pose every link is the identity: binding moves nothing.
  for (const PartBox& p : parts) sg_set_fx(d, p.id, "parentBone", js::Json::string(p.bone));
  tl_sync_from_scene(d, comp);
  return api::LayerRef{groupId};
}

}  // namespace premation::doc
