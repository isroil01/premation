# Character rig — Tier 1

**Written:** 2026-11-03. **Scope:** a character made of separate layers that follow bones. This is
the Tier 1 core loop of the rigging research (artifact "Premation Character Rig"). The single-layer
mesh rig (Bone and Puppet tools, one image deformed by its own skeleton) is
`docs/BONE_AND_PUPPET_RIGGING.md`; this file covers what was added on top of it.

## Model

| | |
|---|---|
| Character | a **group layer** whose `fx.skeleton` has ≥ 1 bone (`LayerInfo.character`). Same JSON as a single-layer skeleton: bones, bindPose, ikTargets, controllers. |
| Part | a child of that group with fx `parentBone: "<boneId>"` (`LayerInfo.parentBone`). |
| Bone space | the group's **child space**: the space its children's `x`/`y` are in. Not the group's box, which is the union of its children and moves with them. |
| Link | `pose · S(stretch, 1) · bind⁻¹`, inserted between the group and the part in every parent-chain walk. At the bind pose it is the identity, so binding never moves a part. |

A binding that points at a bone the character no longer has is ignored: the part follows the group
alone, and `LayerInfo.parentBone` is absent.

## Engine

```
core/skeleton_pose.{hpp,cpp}   bones, FK (compute_world), IK (two-bone + stretch/softness, FABRIK),
                               read_skeleton, live bone / goal sampling — moved out of rig_mesh.cpp
                               so engine_core can pose a skeleton without a mesh
core/bone_link.{hpp,cpp}       character_skeleton, bound_bone, character_pose, bone_link(_at/_static)
core/handlers_character.cpp    bindToBone, createCharacter
```

The link is composed in every parent-chain walker:

- `worldxf.cpp` `world_matrix_of` / `world_2d_animated` (expressions, 3D parents) and `world_2d_at`
  (queries, overlays, hit tests, keep-world)
- `scene.cpp` `world_matrix_static` (static reparent compensation)
- `snapshot_build.cpp` `Walk::world_matrix` and `Walk::world_at` (the frame and its motion-blur
  samples). Each character is solved once per frame (`charPose_`).
- `raw_world.cpp` `RawWorld::world_matrix` (points-follow-nulls, cloner drivers)

The bones are sampled at the **group's** keyframe-axis time.

**Ending a binding** keeps the part's world transform:

- `bindToBone` without a bone (Detach) compensates at the active tab's playhead, as `setParent
  keepWorldTransform` does.
- `setParent` / `ungroupLayer` out of the character: `sg_set_parent` drops `parentBone` after reading
  the world through the link.
- Deleting the bone, or the whole skeleton (`removePropertyGroups`): every part on that bone or a bone
  under it is first detached at the playhead (`release_bone_parts`), its keyframes re-based as Detach
  does. `remove_rig_group` keeps a static fallback (the stored transform takes the static link) for
  any path that reaches it without a handler context.

**3D parts:** a 3D layer under a character composes the link too:

- core `parent_world_matrix_at`: the node's own link last, and a 3D ancestor's link between it and its
  parent.
- `Scene3D::parent_world_3d` / `parent_world_matrix` through `Scene3DHost::link3d`, which Walk answers
  from `link_of`.
- A 3D part under a 2D character was already right in the frame (it places through the 2D walk).

**Overlay:** `rig_overlay.cpp` builds a pose-only `RigModel` (`RigInputs::poseOnly`, empty rest
mesh) for a character. BoneOverlay maps it through the group's world matrix, which is its child
space.

## Commands

- `bindToBone {layers, character, bone?}` (218): makes the layers parts that follow `bone`; absent
  `bone` = Detach. Layers not in the character move into it. Keeps world.
- `createCharacter {layers, name} → LayerRef` (219), Rig Character:
  - groups the layers (`groupLayers`) and gives each one a bone.
  - A bone runs from the part's anchor (when it was moved off the centre) or from the end of its
    long side nearest its parent, to the far end.
  - Its parent comes from anatomy tags in the layer name (head, neck, torso/body/chest/hip,
    upper arm / forearm / arm, hand, thigh / shin / leg, foot, tail; `L`/`R`, left/right). Without a
    tag, the largest part whose box holds the joint is the parent.
  - The root is a tagged torso, else the largest part.
  - A shin under a thigh (or two `leg` parts) gets an IK goal. Hands, feet, the head and the root
    get controllers, sided for Mirror Pose.
  - The bind pose = the bones as built.
  - One undo entry.

**IK limb settings** (`ikTargets[]`, catalog `ik/stretch`, `ik/softness`, static):

- `stretch` = max length ratio (≤ 1 off). The chain bones lengthen and their children's offsets
  scale with them.
- `softness` = px of soft-IK ease before full reach.
- Both apply to two-bone chains.

## UI

- Timeline row:
  - a character shows a `Rig` tag; a part shows `↳ <bone>`.
  - The Parent dropdown of a part lists the character's bones (indented by depth) and
    "No Bone".
- Layer ▸ Rig Character and the layer context menu (Rig Character, Detach from Bone) do the
  following:
  - gather the selection as Group Selection does
  - select the character
  - arm the Bone tool in Pose mode
- `useRigTarget`: picking a part makes the Bone tool and the Rigging panel edit its character, with
  the part's bone selected.
- Inspector ▸ Bone: Stretch and Softness under Chain Length (two-bone chains).

## AI / MCP

`rig_character` with `layerIds` (and an optional `name`) runs `createCharacter` on those layers. It
first gathers them under the first one's parent, keeping their world pose. It returns the
part → bone map, the IK goals and the rest rotations to animate on the character layer.
`layerId` keeps the single-layer mesh skeleton.

## Tests

- `native/engine/tests/test_bone_link.cpp` (`[character]`):
  - bind without moving
  - a 90° bone turn
  - Detach / undo
  - refusals
  - bone delete
  - setParent out
  - createCharacter on named parts
  - stretch / softness numbers
- `src/core/mirror/character.test.ts`
- `src/layout/Inspector/characterEdits.native.test.ts`: Rig Character on the real engine, Detach.

## Not yet

- Tier 2:
  - splitting a flat image into parts (SAM 2 + joints + inpaint)
  - PSD/AI name-tag import
  - soft (mesh) parts on a character
  - swap sets
  - pose library
- Tier 3: joysticks, drivers, springs, constraints, walk cycle.
- Replacing the whole skeleton JSON (`setProperty layer/skeleton`) is not a removal: a part whose bone
  disappears that way follows the group alone, unbound, where the group puts it.
