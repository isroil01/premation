/**
 * Facade implementing CommandServices.UndoService. Created by Application
 * and passed to commands so they can push themselves to the undo stack
 * without knowing about CommandSystem internals.
 */

import type { Command, UndoService } from './Command';

export function createUndoService(push: (cmd: Command) => void): UndoService {
  return {
    push,
    undo: () => { throw new Error('undo() must be invoked via CommandSystem.undo()'); },
    redo: () => { throw new Error('redo() must be invoked via CommandSystem.redo()'); },
    canUndo: () => false,
    canRedo: () => false,
  };
}
