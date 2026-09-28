import { handleEngineUnavailable, type EngineUnavailableDeps } from './engineUnavailable';

function deps(responses: number[], over: Partial<EngineUnavailableDeps> = {}) {
  const calls: string[] = [];
  const d: EngineUnavailableDeps = {
    showErrorBox: (title) => { calls.push(`error:${title}`); },
    showMessageBox: async () => ({ response: responses.shift() ?? 2 }),
    showSaveDialog: async () => ({ canceled: false, filePath: '/docs/Recovered.motion' }),
    recoveryPath: '/u/recovery/engine-recovery.json',
    exists: () => true,
    copyFile: async (from, to) => { calls.push(`copy:${from}->${to}`); },
    retry: async () => { calls.push('retry'); },
    quit: () => { calls.push('quit'); },
    defaultDir: '/docs',
    joinPath: (...p) => p.join('/'),
    ...over,
  };
  return { d, calls };
}

describe('handleEngineUnavailable', () => {
  it('a fatal reason is a startup dialog, then quit', async () => {
    const { d, calls } = deps([]);
    expect(await handleEngineUnavailable({ reason: 'premation-engine executable not found', fatal: true, logTail: [] }, d)).toBe('quit');
    expect(calls).toEqual(['error:Premation cannot start', 'quit']);
  });

  it('a crash loop offers a recovery save, then Try Again', async () => {
    const { d, calls } = deps([0, 1]);
    expect(await handleEngineUnavailable({ reason: 'crashed 3 times', fatal: false, logTail: [] }, d)).toBe('retry');
    expect(calls).toEqual(['copy:/u/recovery/engine-recovery.json->/docs/Recovered.motion', 'retry']);
  });

  it('no autosave yet: nothing to copy; Quit quits', async () => {
    const { d, calls } = deps([0, 2], { exists: () => false });
    expect(await handleEngineUnavailable({ reason: 'crashed 3 times', fatal: false, logTail: [] }, d)).toBe('quit');
    expect(calls).toEqual(['quit']);
  });
});
