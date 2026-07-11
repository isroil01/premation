/**
 * useCommand — execute a command by id when `trigger` becomes true.
 * Also exposes a `run` function for direct invocation.
 */

import { useCallback, useEffect } from 'react';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { CommandId } from '@app-types/common';

export function useCommand(id: CommandId): {
  run: () => Promise<void>;
  canExecute: () => boolean;
} {
  const run = useCallback(async () => {
    await getCommandSystem().execute(id);
  }, [id]);

  const canExecute = useCallback(() => {
    const cmd = getCommandSystem();
    void cmd;
    return true;
  }, []);

  return { run, canExecute };
}

/** Run a command on mount (once). */
export function useRunCommand(id: CommandId): void {
  useEffect(() => {
    void getCommandSystem().execute(id);
  }, [id]);
}
