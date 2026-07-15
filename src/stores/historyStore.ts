/**
 * History store (spec §Trust Infrastructure — Photoshop-style visual history).
 *
 * Holds an ordered list of fully non-destructive snapshots of the editable
 * state (scene graph + animation). Jumping to an entry restores that state;
 * it never mutates source data. Entries can be renamed ("Client v1 look").
 *
 * Recording is driven from Providers: an initial "Open" entry, then a debounced
 * capture after edits. The `restoring` guard stops a jump from recording itself.
 */

import { create } from 'zustand';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import type { ProjectFile } from '@core/types';
import { bumpScene } from './sceneStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { IUndoableCommand, CommandContext } from '@core/commands/Command';

/** Deep-clone the current editable state into a snapshot. */
function captureState(): { scene: ProjectFile; anim: AnimSnapshot } {
  return {
    scene: structuredClone(sceneProjectIO.capture()),
    anim: defaultAnimation.snapshot(),
  };
}

export class StoreSnapshotCommand implements IUndoableCommand {
  readonly label: string;
  private readonly before: { scene: ProjectFile; anim: AnimSnapshot };
  private readonly after: { scene: ProjectFile; anim: AnimSnapshot };

  constructor(
    label: string,
    before: { scene: ProjectFile; anim: AnimSnapshot },
    after: { scene: ProjectFile; anim: AnimSnapshot }
  ) {
    this.label = label;
    this.before = before;
    this.after = after;
  }

  execute(_ctx: CommandContext): void {
    sceneProjectIO.restore(structuredClone(this.after.scene));
    defaultAnimation.restore(this.after.anim);
    bumpScene();
  }

  undo(_ctx: CommandContext): void {
    sceneProjectIO.restore(structuredClone(this.before.scene));
    defaultAnimation.restore(this.before.anim);
    bumpScene();
  }
}

function statesEqual(
  a: { scene: ProjectFile; anim: AnimSnapshot } | null,
  b: { scene: ProjectFile; anim: AnimSnapshot } | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

interface HistoryStore {
  restoring: boolean;
  record: (label?: string, named?: boolean) => void;
  reset: () => void;
}

let seq = 0;
let lastState: { scene: ProjectFile; anim: AnimSnapshot } | null = null;

export const useHistoryStore = create<HistoryStore>((_set, get) => ({
  restoring: false,

  record: (label, _named = false) => {
    if (get().restoring) return;
    const currentState = captureState();
    
    if (lastState) {
      if (statesEqual(lastState, currentState)) {
        return;
      }
      const command = new StoreSnapshotCommand(
        label ?? `Edit ${(seq += 1)}`,
        lastState,
        currentState
      );
      getCommandSystem().getHistory().push(command);
    }
    
    lastState = currentState;
  },

  reset: () => {
    lastState = null;
    getCommandSystem().getHistory().clear();
  },
}));

import { getEventBus } from '@core/events/EventBus';
getEventBus().on('UndoStackChanged', () => {
  // Whenever the global undo stack is manipulated (undo/redo), 
  // we must recapture the current state so the next StoreSnapshotCommand 
  // uses the accurate "before" state instead of a stale one.
  lastState = captureState();
});
