/**
 * Composition Settings ▸ World must round-trip, and must be INVISIBLE until set.
 *
 * The three World fields (default sky, ground level, sky backdrop) are authored
 * state living on the composition record, so they ride the `comps` chunk that
 * already exists rather than a new top-level key. That is the cheap way to do
 * it and also the risky one: a field that rides an existing chunk gets no
 * round-trip test of its own by default, and "it's in the same object as width"
 * is exactly the reasoning that lost the timeline (see cloudDocument.test.ts).
 *
 * The second half is the one that matters more. All three are optional, and a
 * document written before they existed must come back with them ABSENT — not
 * defaulted-and-written, which would rewrite every comp record on disk and
 * change the behaviour of every scene that never opted in.
 */

import { captureDocument, restoreDocument, type EditorDocument } from './cloudDocument';
import { encodeBundle, decodeBundle } from '@core/project/bundle/bundleCodec';
import { useProjectStore } from '@stores/projectStore';
import { sanitize, DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { insertLight } from '@core/scene/sceneInsert';
import { readNodeLight } from '@core/scene/light';
import { DEFAULT_ENVIRONMENT_PRESET } from '@core/scene/environmentLight';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const COMP = 'comp_root';

function rootNode(): SceneNode {
  return {
    id: COMP,
    name: COMP,
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${COMP}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
}

function seedScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultSceneGraph.addNode(rootNode());
}

function setWorld(patch: Record<string, unknown>): void {
  useProjectStore.getState().actions.updateComp(COMP, patch as never);
}

function comp(): Record<string, unknown> {
  return useProjectStore.getState().comps[COMP] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  seedScene();
  // A comp record with none of the World fields — the state every project that
  // predates this tab is in.
  useProjectStore.getState().actions.replaceComps({
    [COMP]: { ...DEFAULT_COMPOSITION, id: COMP, name: 'Composition 1' },
  });
});

describe('World settings round-trip through the document', () => {
  it('survives captureDocument → restoreDocument', () => {
    setWorld({ defaultEnvPreset: 'sunset', groundLevel: 250, showSkyBackdrop: true });
    const doc = captureDocument();

    // Wipe them the way opening another project would, then restore.
    setWorld({ defaultEnvPreset: undefined, groundLevel: undefined, showSkyBackdrop: undefined });
    expect(comp().groundLevel).toBeUndefined();

    restoreDocument(doc);
    expect(comp().defaultEnvPreset).toBe('sunset');
    expect(comp().groundLevel).toBe(250);
    expect(comp().showSkyBackdrop).toBe(true);
  });

  it('survives the .motion bundle codec', () => {
    setWorld({ defaultEnvPreset: 'sky', groundLevel: -80, showSkyBackdrop: true });
    const doc = captureDocument();
    const restored = decodeBundle(encodeBundle(doc).files) as EditorDocument;
    const c = restored.comps?.[COMP] as unknown as Record<string, unknown>;
    expect(c.defaultEnvPreset).toBe('sky');
    expect(c.groundLevel).toBe(-80);
    expect(c.showSkyBackdrop).toBe(true);
  });

  /**
   * The compatibility half. A comp that never set them must capture WITHOUT the
   * keys — not with defaults written in — or every project on disk gets three
   * new fields the first time it is saved.
   */
  it('an untouched composition writes none of the three keys', () => {
    const captured = captureDocument().comps?.[COMP] as unknown as Record<string, unknown>;
    expect(Object.keys(captured)).not.toContain('defaultEnvPreset');
    expect(Object.keys(captured)).not.toContain('groundLevel');
    expect(Object.keys(captured)).not.toContain('showSkyBackdrop');
  });

  it('a document written before World existed restores unchanged', () => {
    const doc = captureDocument();
    restoreDocument(doc);
    expect(comp().defaultEnvPreset).toBeUndefined();
    // Absent ground level is the legacy plane — the reader supplies 0, the
    // record stays silent.
    expect(comp().groundLevel).toBeUndefined();
  });
});

describe('the World sanitizer', () => {
  it('rejects a sky id no probe understands', () => {
    expect(sanitize({ defaultEnvPreset: 'nebula' as never }).defaultEnvPreset)
      .toBe(DEFAULT_ENVIRONMENT_PRESET);
    // A real one passes through untouched.
    expect(sanitize({ defaultEnvPreset: 'sunset' }).defaultEnvPreset).toBe('sunset');
  });

  it('keeps the ground level finite but otherwise unbounded', () => {
    expect(sanitize({ groundLevel: NaN }).groundLevel).toBe(0);
    expect(sanitize({ groundLevel: -1234.5 }).groundLevel).toBe(-1234.5);
    expect(sanitize({ groundLevel: 99999 }).groundLevel).toBe(99999);
  });

  it('leaves an untouched patch alone — the fields are opt-in', () => {
    expect(sanitize({ width: 100 })).toEqual({ width: 100 });
  });
});

describe('a new environment light starts on the composition default', () => {
  function newestLight(): ReturnType<typeof readNodeLight> {
    const lights: SceneNode[] = [];
    defaultSceneGraph.traverse((n) => {
      if (n.components.some((c) => (c.props as Record<string, unknown>).lightType === 'environment')) {
        lights.push(n as SceneNode);
      }
    });
    const last = lights[lights.length - 1];
    if (!last) throw new Error('no environment light was inserted');
    return readNodeLight(last);
  }

  it('reads World ▸ default sky', () => {
    setWorld({ defaultEnvPreset: 'sunset' });
    insertLight({ type: 'environment' });
    expect(newestLight().envPreset).toBe('sunset');
  });

  it('falls back to studio when the comp says nothing — the old literal', () => {
    insertLight({ type: 'environment' });
    expect(newestLight().envPreset).toBe(DEFAULT_ENVIRONMENT_PRESET);
  });

  it('an explicit seed still wins over the composition default', () => {
    setWorld({ defaultEnvPreset: 'sunset' });
    insertLight({ type: 'environment', envPreset: 'sky' });
    expect(newestLight().envPreset).toBe('sky');
  });
});
