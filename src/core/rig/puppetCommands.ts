/**
 * Undoable puppet-rig structural edits (pin add / delete / rig settings).
 *
 * Follows the AnimEditCommand convention (animationCommands.ts): a command
 * captures before/after state and swaps between them; it is pushed onto the
 * CommandSystem history ALREADY APPLIED (push does not re-execute). One command
 * per user gesture = one undo step.
 *
 * A pin delete also removes the pin's animation tracks — its `position` data
 * track plus every scalar in PIN_SCALAR_TRACKS — captured as a nested
 * AnimEditCommand so undo restores the keyframes too.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { defaultAnimation } from '@motion/animation';
import { captureAnimEdit, type AnimEditCommand } from '@core/animation/animationCommands';
import { bumpScene } from '@stores/sceneStore';
import type { ID } from '@core/types';
import type { PuppetPin, PuppetRig } from './puppet';
import { PIN_SCALAR_TRACKS, pinPropPath } from './livePins';

export const PUPPET_EDIT_COMMAND = asCommandId('puppet.edit');

/** Deep-ish clone of a rig (plain JSON data by contract). */
function cloneRig(rig: PuppetRig | undefined): PuppetRig | undefined {
  return rig ? (JSON.parse(JSON.stringify(rig)) as PuppetRig) : undefined;
}

export class PuppetEditCommand implements Command {
  readonly id = PUPPET_EDIT_COMMAND;
  readonly label: string;

  private readonly nodeId: ID;
  private readonly before: PuppetRig | undefined;
  private readonly after: PuppetRig | undefined;
  private readonly trackEdit: AnimEditCommand | null;

  constructor(
    nodeId: ID,
    before: PuppetRig | undefined,
    after: PuppetRig | undefined,
    label: string,
    trackEdit: AnimEditCommand | null = null,
  ) {
    this.nodeId = nodeId;
    this.before = cloneRig(before);
    this.after = cloneRig(after);
    this.label = label;
    this.trackEdit = trackEdit;
  }

  execute(): void {
    defaultSceneGraph.setPuppet(this.nodeId, cloneRig(this.after));
    this.trackEdit?.execute();
    bumpScene();
  }

  undo(): void {
    defaultSceneGraph.setPuppet(this.nodeId, cloneRig(this.before));
    this.trackEdit?.undo();
    bumpScene();
  }
}

/** Read the node's current rig (undefined when the layer has no puppet block). */
function currentRig(nodeId: ID): PuppetRig | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  const fx = node?.components.find((c) => c.type === 'fx');
  return fx?.props.puppet as PuppetRig | undefined;
}

/** Apply `after` to the node and record ONE undo step. */
function applyAndRecord(
  nodeId: ID,
  after: PuppetRig | undefined,
  label: string,
  trackEdit: AnimEditCommand | null = null,
): void {
  const before = currentRig(nodeId);
  defaultSceneGraph.setPuppet(nodeId, cloneRig(after));
  bumpScene();
  getCommandSystem()
    .getHistory()
    .push(new PuppetEditCommand(nodeId, before, after, label, trackEdit));
}

/**
 * The mesh mode a BRAND-NEW rig on this layer should start in.
 *
 * An image layer gets `'silhouette'`, which for an image means the alpha
 * OUTLINE mesh (`alphaMesh.ts`): traced, simplified, expanded, Delaunay-filled.
 * That is AE's Puppet mesh, and it is what makes dragging a hand pin bend the
 * arm — a limb is its own strip of triangles, so the harmonic weights fall off
 * along the limb instead of across the empty rectangle between limb and torso.
 * On the coverage-culled grid the same drag moved the torso 4.1px per 40px of
 * hand travel; on the outline mesh, 1.4px.
 *
 * Everything else keeps the grid. A vector layer's `'silhouette'` route is the
 * ear-clipped path outline, which is a different (older) code path, and text /
 * video / open strokes have no outline at all and would fall back to the grid
 * anyway — so naming grid here says what actually happens.
 *
 * Either way `buildRestMesh` falls back to the grid whenever the outline is
 * unusable (no decoded bitmap yet, degenerate trace), so this choice can only
 * improve the mesh, never break the layer.
 */
function defaultMeshMode(nodeId: ID): PuppetRig['meshMode'] {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return 'grid';
  const kind = readNodeKind(node);
  return kind === 'image' || kind === 'svg' ? 'silhouette' : 'grid';
}

/** Add a pin to the layer's rig (creating the rig if absent). One undo step. */
export function addPuppetPin(nodeId: ID, pin: PuppetPin): void {
  const rig = currentRig(nodeId);
  // A pinless rig that never chose a mesh mode gets the same default on the
  // first pin. Existing rigs with pins keep whatever meshMode they already have
  // — a stored document must open with the mesh it was authored against.
  let after: PuppetRig;
  if (!rig) {
    after = { pins: [pin], meshMode: defaultMeshMode(nodeId), meshExpansion: 0, meshDensity: 22 };
  } else {
    after = { ...rig, pins: [...(rig.pins ?? []), pin] };
    if ((rig.pins?.length ?? 0) === 0) {
      if (after.meshMode === undefined) after.meshMode = defaultMeshMode(nodeId);
      if (after.meshExpansion === undefined) after.meshExpansion = 0;
      if (after.meshDensity === undefined) after.meshDensity = 22;
    }
  }
  applyAndRecord(nodeId, after, `Add Puppet Pin ${pin.name}`);
}

/**
 * Delete a pin and its animation tracks. One undo step restores both the rig
 * and every removed keyframe.
 */
export function deletePuppetPin(nodeId: ID, pinId: string): void {
  const rig = currentRig(nodeId);
  if (!rig) return;
  const after: PuppetRig = { ...rig, pins: (rig.pins ?? []).filter((p) => p.id !== pinId) };
  // Capture the track removals as a nested (already-applied) anim edit.
  //
  // The scalar list comes from PIN_SCALAR_TRACKS — the same constant
  // `resolveLivePins` reads to decide what to SAMPLE — rather than being spelled
  // out again here. It was spelled out here, and it had gone stale: `rotation`
  // and `stiffness` were removed but `scale` and `overlap` were not, so both
  // survived their own pin. A later pin at the same index then inherited a dead
  // pin's animation. Anything added to the sampled set is now deleted with the
  // pin automatically, which is the only version of this that stays correct.
  const trackEdit = captureAnimEdit(`Delete Puppet Pin ${pinId} tracks`, () => {
    defaultAnimation.setDataTrack(nodeId, pinPropPath(pinId, 'position'), null);
    for (const prop of PIN_SCALAR_TRACKS) {
      defaultAnimation.removeTrack(nodeId, pinPropPath(pinId, prop));
    }
  });
  applyAndRecord(nodeId, after, `Delete Puppet Pin ${pinId}`, trackEdit);
}

/** Update rig-level mesh settings (density / expansion / solver). One undo step. */
export function updatePuppetSettings(
  nodeId: ID,
  patch: Partial<
    Pick<PuppetRig, 'meshDensity' | 'meshExpansion' | 'solver' | 'maxRotationDeg' | 'meshMode'>
  >,
): void {
  const rig = currentRig(nodeId);
  const after: PuppetRig = { pins: [], ...(rig ?? {}), ...patch };
  applyAndRecord(nodeId, after, 'Edit Puppet Mesh');
}

/**
 * Update one pin's static properties (rotation / stiffness / kind). One undo step.
 *
 * Switching a pin to `bend` leaves any position track it already has in place
 * rather than deleting it: the solve ignores the track while the pin is a bend
 * pin, and switching back restores the animation intact. Deleting it here would
 * make a two-click round trip destroy work, which is a worse trade than a track
 * that lies dormant.
 */
export function updatePuppetPin(
  nodeId: ID,
  pinId: string,
  patch: Partial<
    Pick<PuppetPin, 'rotation' | 'stiffness' | 'name' | 'scale' | 'overlap' | 'overlapExtent' | 'kind'>
  >,
): void {
  const rig = currentRig(nodeId);
  if (!rig) return;
  const after: PuppetRig = {
    ...rig,
    pins: (rig.pins ?? []).map((p) => (p.id === pinId ? { ...p, ...patch } : p)),
  };
  applyAndRecord(nodeId, after, 'Edit Puppet Pin');
}
