/**
 * One structural edit, one undo entry.
 *
 * `runAnimEdit` captures the animation engine only, which is enough for a
 * keyframe change and nowhere near enough for an operation that replaces one
 * layer with a subtree (converting an SVG to shapes, and reverting it). Those
 * touch the scene graph AND the animation engine, and to the user they are one
 * act — so undo has to put all of it back in one press.
 *
 * The mechanism is the coarse one `beginAiTransaction` already uses for the
 * same reason: snapshot the document before and after, push a single
 * `StoreSnapshotCommand`. Fine-grained diffing across a structural rewrite
 * would buy nothing anyone wants.
 */

import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import { StoreSnapshotCommand } from '@stores/historyStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { bumpScene } from '@stores/sceneStore';
import type { ProjectFile } from '@core/types';

interface DocState {
  scene: ProjectFile;
  anim: AnimSnapshot;
}

const capture = (): DocState => ({
  scene: structuredClone(sceneProjectIO.capture()),
  anim: defaultAnimation.snapshot(),
});

/**
 * Run `mutate` and record it as one undoable entry labelled `label`.
 *
 * Nested pushes from subsystems the mutation happens to wake up (a comp's
 * timeline lazily booting emits "Add Track", for instance) are suspended for
 * the duration: the before/after snapshot already covers them, so letting them
 * through would leave a stray second entry that half-undoes the operation.
 *
 * Returns whatever `mutate` returns, so a call site can keep the id of the
 * thing it created.
 */
export function runDocumentEdit<T>(label: string, mutate: () => T): T {
  const before = capture();
  const history = getCommandSystem().getHistory();
  history.suspend();
  let result: T;
  try {
    result = mutate();
  } finally {
    history.resume();
  }
  const after = capture();
  // A no-op must not litter the undo stack.
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    history.push(new StoreSnapshotCommand(label, before, after));
  }
  bumpScene();
  return result;
}
