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

/** Add a pin to the layer's rig (creating the rig if absent). One undo step. */
export function addPuppetPin(nodeId: ID, pin: PuppetPin): void {
  const rig = currentRig(nodeId);
  const after: PuppetRig = { ...(rig ?? {}), pins: [...(rig?.pins ?? []), pin] };
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
