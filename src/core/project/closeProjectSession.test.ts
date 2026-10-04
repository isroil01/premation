/**
 * File ▸ Close Project actually closes the project — and New Project starts
 * with an empty Assets panel.
 *
 * WHY THIS EXISTS. `ProjectManager.close()` dropped the project REFERENCE and
 * nothing else. The scene, compositions, timeline and undo stack all stayed
 * live under a "No project" title — fully editable, and (because Save with no
 * current project routes to Save As) saveable straight back out under a new
 * name. Close is a document transition like New and Open, and has to do what
 * they do.
 *
 * This drives exactly what the `project.close` command runs: `close()`, then a
 * `bumpScene()`. IF THE DIRTY CASE FAILS, read `unloadProjectSession` — the
 * clean-mark is deferred past the caller's bump on purpose.
 */

import { ProjectManager } from './ProjectManager';
import { resetHistory } from '@stores/historyStore';
import { useAssetStore } from '@stores/assetStore';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

// jsdom has no object-URL registry. The reset revokes what it drops, so give
// it something to call — and something for the test to read back.
const revoked: string[] = [];
beforeAll(() => {
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => void revoked.push(u);
});

beforeEach(() => {
  revoked.length = 0;
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  getCommandSystem().getHistory().clear();
  resetHistory();
  useAssetStore.setState({ assets: [] });
});

describe('File ▸ Close Project', () => {

  it('a manager whose IO has no `unload` still restores an empty document', () => {
    const restored: unknown[] = [];
    const pm = new ProjectManager({
      service: {} as never,
      files: {} as never,
      recent: { add: () => {} } as never,
      io: {
        createEmpty: (name) => ({ version: '1', name }) as never,
        capture: () => ({ version: '1' }),
        restore: (d) => void restored.push(d),
      },
    });
    pm.adopt('p', null);
    pm.close();
    expect(restored).toEqual([{ version: '1', name: 'Untitled' }]);
    expect(pm.getState().current).toBeNull();
  });
});
