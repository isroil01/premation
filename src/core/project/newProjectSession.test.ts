/**
 * File ▸ New Project is a document transition, and has to do everything the
 * other document transitions do.
 *
 * WHY THIS EXISTS. `openProjectPath` re-baselines undo, with a comment
 * explaining that history is a flat stack carrying no project identity, so a
 * transition that leaves it intact lets one Ctrl+Z step back into the PREVIOUS
 * document. The New Project command did none of that: it called `newProject()`,
 * bumped the scene, and stopped. So the first undo after starting a new project
 * pulled the old project's layers into it — and, because `bumpScene` emits
 * SceneGraphChanged which the boot wiring turns into markDirty(true), the blank
 * project arrived already flagged as having unsaved changes, which made the very
 * next New/Open prompt to discard edits that did not exist.
 *
 * This drives the same sequence the command runs. IF THIS FAILS, check that the
 * command still calls all four steps in this order — the ordering is load
 * bearing twice over: the baseline must precede the bump (nothing may record
 * against the old stack) and the clean-marking must follow it (the bump dirties
 * the tab).
 */

import { ProjectManager } from './ProjectManager';
import { projectDocumentIO } from './projectDocumentIO';
import { baselineProjectHistory, afterProjectLoaded, resetProjectWorkspace } from './projectSession';
import { useHistoryStore, performUndo } from '@stores/historyStore';
import { useProjectStore } from '@stores/projectStore';
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

/** Exactly what the `project.new` command does, in its order. */
function runNewProjectCommand(pm: ProjectManager): void {
  pm.newProject('Untitled');
  resetProjectWorkspace();
  baselineProjectHistory('New Project');
  bumpScene();
  afterProjectLoaded();
}

function activeTabDirty(): boolean {
  const s = useProjectStore.getState();
  return s.activeTabId ? s.tabs[s.activeTabId]?.dirty === true : false;
}

describe('File ▸ New Project', () => {
  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    resetScene();
    getCommandSystem().getHistory().clear();
    useHistoryStore.getState().reset();
  });

  it('undo cannot pull the PREVIOUS project back into the new one', () => {
    // A project with real work in it, baselined as the open document.
    addNode('comp_root', null);
    addNode('old_layer', 'comp_root');
    baselineProjectHistory('Open');
    expect(nodeIds()).toContain('old_layer');

    runNewProjectCommand(makeManager());
    expect(nodeIds()).not.toContain('old_layer');

    // The whole point: whatever undo does here, it must not resurrect the
    // previous document.
    performUndo();
    expect(nodeIds()).not.toContain('old_layer');
  });

  it('leaves the blank project marked as SAVED, not dirty', () => {
    // Stand up the ONE piece of boot wiring this depends on. Without it the
    // assertion passes whether or not the command marks the tab clean, because
    // nothing in a jest run makes the tab dirty in the first place — and a test
    // that cannot fail is not a guard. This is the subscription Providers makes
    // at boot; it is exactly why the clean-marking has to come after the bump.
    const sub = getEventBus().on('SceneGraphChanged', () => {
      const s = useProjectStore.getState();
      if (s.activeTabId) s.actions.markDirty(s.activeTabId, true);
    });
    try {
      const ws = useProjectStore.getState();
      if (ws.activeTabId) ws.actions.markDirty(ws.activeTabId, true);
      expect(activeTabDirty()).toBe(true);

      runNewProjectCommand(makeManager());

      expect(activeTabDirty()).toBe(false);
    } finally {
      sub.dispose();
    }
  });

  it('becomes the current project, with no path yet', () => {
    const pm = makeManager();
    runNewProjectCommand(pm);
    expect(pm.getState().current).toMatchObject({ name: 'Untitled', path: null });
  });
});
