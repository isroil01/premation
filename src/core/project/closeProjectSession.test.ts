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
import { projectDocumentIO } from './projectDocumentIO';
import { baselineProjectHistory, resetProjectWorkspace } from './projectSession';
import { useHistoryStore, performUndo } from '@stores/historyStore';
import { useProjectStore } from '@stores/projectStore';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

function addNode(id: string, parent: string | null): void {
  const node = {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: parent ? 'shape' : 'group' } }],
  } as unknown as SceneNode;
  if (parent) defaultSceneGraph.addChild(parent, node as never);
  else defaultSceneGraph.addNode(node);
}

function nodeIds(): string[] {
  const out: string[] = [];
  defaultSceneGraph.traverse((n) => out.push(n.id));
  return out;
}

function makeManager(): ProjectManager {
  return new ProjectManager({
    service: {} as never,
    files: {} as never,
    recent: { add: () => {} } as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    io: projectDocumentIO,
    storage: { save: async () => {}, load: async () => null },
  });
}

/** Exactly what the `project.close` command does after the prompt. */
function runCloseCommand(pm: ProjectManager): void {
  pm.close();
  bumpScene();
}

function activeTabDirty(): boolean {
  const s = useProjectStore.getState();
  return s.activeTabId ? s.tabs[s.activeTabId]?.dirty === true : false;
}

const asset = (id: string): ImportedAsset => ({ id, name: `${id}.png`, type: 'image', src: `blob:${id}`, size: 1 });

function openProjectWithWork(): ProjectManager {
  const pm = makeManager();
  pm.adopt('qa1', '/x/qa1.motion');
  addNode('comp_root', null);
  addNode('old_layer', 'comp_root');
  baselineProjectHistory('Open');
  return pm;
}

// jsdom has no object-URL registry. The reset revokes what it drops, so give
// it something to call — and something for the test to read back.
const revoked: string[] = [];
beforeAll(() => {
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => void revoked.push(u);
});

beforeEach(() => {
  revoked.length = 0;
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  resetScene();
  getCommandSystem().getHistory().clear();
  useHistoryStore.getState().reset();
  useAssetStore.setState({ assets: [] });
});

describe('File ▸ Close Project', () => {
  it('unloads the scene, not just the reference', () => {
    const pm = openProjectWithWork();
    expect(nodeIds()).toContain('old_layer');

    runCloseCommand(pm);

    expect(pm.getState().current).toBeNull();
    expect(nodeIds()).not.toContain('old_layer');
  });

  it('undo cannot pull the closed project back onto the canvas', () => {
    const pm = openProjectWithWork();
    runCloseCommand(pm);
    performUndo();
    expect(nodeIds()).not.toContain('old_layer');
  });

  it('empties the Assets panel', () => {
    const pm = openProjectWithWork();
    useAssetStore.setState({ assets: [asset('clip'), asset('image')] });
    runCloseCommand(pm);
    expect(useAssetStore.getState().assets).toEqual([]);
    // Released, not leaked: a dropped object URL pins its whole Blob otherwise.
    expect(revoked).toEqual(['blob:clip', 'blob:image']);
  });

  it('emits ProjectUnloaded AFTER the document is gone, so listeners re-read an empty scene', () => {
    const pm = openProjectWithWork();
    let seen: string[] | null = null;
    const sub = getEventBus().on('ProjectUnloaded', () => { seen = nodeIds(); });
    try {
      runCloseCommand(pm);
    } finally {
      sub.dispose();
    }
    expect(seen).not.toBeNull();
    expect(seen).not.toContain('old_layer');
  });

  it('leaves the empty editor CLEAN, even though the command bumps the scene after close()', async () => {
    // The one piece of boot wiring this depends on — see newProjectSession.test.
    const sub = getEventBus().on('SceneGraphChanged', () => {
      const s = useProjectStore.getState();
      if (s.activeTabId) s.actions.markDirty(s.activeTabId, true);
    });
    try {
      const pm = openProjectWithWork();
      runCloseCommand(pm);
      // The command's own bump has re-dirtied the tab by now; the clean-mark is
      // a microtask precisely so that it lands after this point.
      await Promise.resolve();
      expect(activeTabDirty()).toBe(false);
    } finally {
      sub.dispose();
    }
  });

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

describe('File ▸ New Project', () => {
  it('does not inherit the previous project’s assets', () => {
    const pm = openProjectWithWork();
    useAssetStore.setState({ assets: [asset('clip'), asset('image')] });
    // The command's first two steps; the rest is newProjectSession.test's.
    pm.newProject('Untitled');
    resetProjectWorkspace();
    expect(useAssetStore.getState().assets).toEqual([]);
  });
});
